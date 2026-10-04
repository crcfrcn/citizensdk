//! SDK generic execution-history coordination state.
use citizen_sdk_contracts::{FinalizedBlockRef, TransactionExecutionId};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    task::{Context, Poll, Waker},
};

#[derive(Default, Debug)]
pub(crate) struct MonitorCancellation {
    cancelled: AtomicBool,
    waiters: Mutex<Vec<Waker>>,
}
impl MonitorCancellation {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut waiters) = self.waiters.lock() {
            for waiter in std::mem::take(&mut *waiters) {
                waiter.wake();
            }
        }
    }
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub(crate) fn poll_cancelled(&self, cx: &mut Context<'_>) -> Poll<()> {
        if self.is_cancelled() {
            return Poll::Ready(());
        }
        let Ok(mut waiters) = self.waiters.lock() else {
            return Poll::Ready(());
        };
        if !waiters.iter().any(|w| w.will_wake(cx.waker())) {
            waiters.push(cx.waker().clone());
        }
        if self.is_cancelled() {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}

#[derive(Default)]
pub(crate) struct ChainMonitorState {
    pub(crate) running: bool,
    pub(crate) polling: bool,
    pub(crate) revision: Option<u64>,
    // 只是通知代次，不是区块高度或第二份链状态；避免空闲钱包不断请求链。
    pub(crate) chain_revision: u64,
    pub(crate) synced_chain_revision: u64,
    pub(crate) needs_catchup: bool,
    /// Per-process generic recovery progress. Durable facts stay exclusively in the typed store.
    pub(crate) execution_positions: std::collections::BTreeMap<TransactionExecutionId, u64>,
    /// Exact signed bytes are resubmitted at most once per running monitor generation.
    pub(crate) rebroadcasted_executions: std::collections::BTreeSet<TransactionExecutionId>,
}

/// Core 与 SDK 调度器之间的更新，不是新的持久模型或宿主账户真源。
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ChainMonitorUpdate {
    pub(crate) finalized_block: Option<FinalizedBlockRef>,
    pub(crate) history_revision: u64,
    pub(crate) history_changed: bool,
    pub(crate) pending_count: usize,
}
impl ChainMonitorUpdate {
    pub const fn finalized_block(&self) -> Option<FinalizedBlockRef> {
        self.finalized_block
    }
    pub const fn history_revision(&self) -> u64 {
        self.history_revision
    }
    pub const fn history_changed(&self) -> bool {
        self.history_changed
    }
    pub const fn pending_count(&self) -> usize {
        self.pending_count
    }
}
