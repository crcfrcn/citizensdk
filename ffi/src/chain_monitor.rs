//! SDK 自有后台调度；只消费 provider 的现有 finalized 订阅并驱动 Engine 的有界批次。
use crate::{
    error::{FfiError, FfiResult},
    runtime::NativeRuntime,
};
use citizen_sdk_contracts::{FinalizedBlockRef, VerifiedChainClient};
use futures_util::{FutureExt, StreamExt};
use std::{
    sync::{Arc, Condvar, Mutex, Weak},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) struct ChainMonitor {
    stop: Arc<(Mutex<bool>, Condvar)>,
    join: JoinHandle<()>,
}

/// 调度规则不解析链数据；准确块、防回滚和 CAS 仍由 Engine 的导出合同负责。
pub(crate) struct DatabaseRefresh {
    next: Instant,
    saved: Option<FinalizedBlockRef>,
}

/// Deterministic adapter-only resubscription schedule. Networking and peer
/// reconnection remain entirely inside the existing smoldot provider.
pub(crate) struct FinalizedRetry {
    next: Instant,
    delay: Duration,
}
impl FinalizedRetry {
    const MAX_DELAY: Duration = Duration::from_secs(30);
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            next: now,
            delay: Duration::from_secs(1),
        }
    }
    pub(crate) fn due(&self, now: Instant) -> bool {
        now >= self.next
    }
    pub(crate) fn failed(&mut self, now: Instant) {
        self.next = now + self.delay;
        self.delay = (self.delay * 2).min(Self::MAX_DELAY);
    }
    pub(crate) fn succeeded(&mut self, now: Instant) {
        self.next = now;
        self.delay = Duration::from_secs(1);
    }
    #[cfg(test)]
    pub(crate) const fn delay(&self) -> Duration {
        self.delay
    }
}
impl DatabaseRefresh {
    const INTERVAL: Duration = Duration::from_secs(60);
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            next: now + Self::INTERVAL,
            saved: None,
        }
    }
    pub(crate) fn due(&self, now: Instant) -> bool {
        now >= self.next
    }
    pub(crate) fn attempted(&mut self, now: Instant) {
        self.next = now + Self::INTERVAL;
    }
    pub(crate) fn should_save(&self, number: u64, hash: [u8; 32]) -> bool {
        self.saved.is_none_or(|saved| {
            number > saved.number()
                || (number == saved.number() && hash != *saved.hash().as_bytes())
        })
    }
    pub(crate) fn saved(&mut self, block: FinalizedBlockRef) {
        self.saved = Some(block);
    }
}
impl ChainMonitor {
    pub(crate) fn start(runtime: Weak<NativeRuntime>, wallet: bool) -> FfiResult<Self> {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let signal = Arc::clone(&stop);
        let join = thread::Builder::new()
            .name("citizensdk-chain-monitor".into())
            .spawn(move || {
                let Some(owner) = runtime.upgrade() else {
                    return;
                };
                // 调度器仅属于实际启用的链模块；缺席时不创建替身或重试循环。
                let Ok(provider) = owner.provider().map(Arc::clone) else {
                    return;
                };
                drop(owner);
                let mut subscription = Some(provider.subscribe_finalized_heads());
                let mut retry = FinalizedRetry::new(Instant::now());
                let mut history_dirty = false;
                let mut finalized_dirty = None;
                let mut database = DatabaseRefresh::new(Instant::now());
                loop {
                    if *signal
                        .0
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                    {
                        break;
                    }
                    let Some(owner) = runtime.upgrade() else {
                        break;
                    };
                    // 只消费已就绪的通知，不创建网络轮询；有界周期同时负责钱包变更和失败后重试。
                    if subscription.is_none() && retry.due(Instant::now()) {
                        subscription = Some(provider.subscribe_finalized_heads());
                    }
                    if let Some(stream) = subscription.as_mut() {
                        match stream.next().now_or_never() {
                            Some(Some(Ok(finalized))) => {
                                retry.succeeded(Instant::now());
                                let _ = owner.engine().invalidate_chain_read_cache();
                                finalized_dirty = Some(finalized);
                            }
                            Some(Some(Err(_))) | Some(None) => {
                                // 错误项和资源结束都使本条 stream 失效；仅重订阅
                                // provider 已有 API，不复制 P2P 或网络重连器。
                                subscription = None;
                                retry.failed(Instant::now());
                            }
                            None => {}
                        }
                    }
                    if let Some(finalized) = finalized_dirty {
                        if owner.publish_finalized_block_changed(finalized).is_ok() {
                            finalized_dirty = None;
                        }
                    }
                    if wallet {
                        // C 调用者无需另外订阅能力通知才能使后台历史在同步就绪后启动。
                        let _ = owner.refresh_provider_capabilities();
                        // 不对整个 future 做 select/drop；尤其 host CAS 必须真正返回后才能 join。
                        if let Ok(Ok(update)) = provider.drive(owner.engine().poll_chain_monitor())
                        {
                            history_dirty |= update.history_changed();
                        }
                        // 队列满时保留脏位；安静链也会重试，最终通知不会永久丢失。
                        if history_dirty && owner.publish_history_changed().is_ok() {
                            history_dirty = false;
                        }
                    }
                    if owner.uses_host_services() && database.due(Instant::now()) {
                        database.attempted(Instant::now());
                        if let Ok(Ok(status)) = provider.drive(provider.status()) {
                            if status.is_usable
                                && database.should_save(
                                    status.verified_finalized_block_number,
                                    status.verified_finalized_block_hash,
                                )
                            {
                                // 最多两次稳定快照尝试；失败保留上次成功状态，下个周期重试。
                                // 不能对整个 future 施加可丢弃的 timeout，进入 host CAS 后必须排空。
                                for _ in 0..2 {
                                    if let Ok(Ok(exported)) =
                                        provider.drive(owner.engine().export_and_persist_state())
                                    {
                                        database.saved(exported.finalized());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    drop(owner);
                    let guard = signal
                        .0
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if *guard {
                        break;
                    }
                    let _ = signal.1.wait_timeout(guard, Duration::from_millis(500));
                }
                drop(subscription);
            })
            .map_err(|error| {
                FfiError::internal(format!("failed to start chain monitor: {error}"))
            })?;
        Ok(Self { stop, join })
    }
    pub(crate) fn stop(self) -> FfiResult<()> {
        *self
            .stop
            .0
            .lock()
            .map_err(|_| FfiError::internal("chain monitor stop lock poisoned"))? = true;
        self.stop.1.notify_all();
        self.join
            .join()
            .map_err(|_| FfiError::internal("chain monitor worker panicked"))
    }
}
