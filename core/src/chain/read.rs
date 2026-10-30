#![forbid(unsafe_code)]
use futures_channel::oneshot;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::future::Future;
use std::num::NonZero;
use std::sync::Arc;

use crate::types::validated_finalized_block_range_len;
use crate::types::AccountId32;
use crate::types::AccountNonce;
use crate::types::AccountNonceSource;
use crate::types::BlockFinality;
use crate::types::ChainIdentity;
use crate::types::ChainSyncStatus;
use crate::types::ContractError;
use crate::types::ContractErrorCode;
use crate::types::ContractFuture;
use crate::types::ContractResult;
use crate::types::ContractStream;
use crate::types::ExportedChainState;
use crate::types::ExtrinsicWatchEvent;
use crate::types::FinalizedBlockRef;
use crate::types::Hash32;
use crate::types::RuntimeContext;
use crate::types::RuntimeVersion;
use crate::types::SignedExtrinsic;
use crate::types::StateImportReceipt;
use crate::types::SubmittedExtrinsic;
use crate::types::VerifiedBlockHeader;
use crate::types::VerifiedBlockRef;
use crate::types::VerifiedChainClient;
use crate::types::MAX_FINALIZED_BLOCKS_PER_BATCH;
use crate::types::MAX_HEADER_DIGEST_BYTES;
use crate::types::MAX_RUNTIME_API_ARGUMENT_BYTES;
use crate::types::MAX_RUNTIME_API_METHOD_BYTES;
use crate::types::MAX_RUNTIME_API_OUTPUT_BYTES;
use crate::types::MAX_STORAGE_BATCH_KEYS;
use crate::types::MAX_STORAGE_BATCH_KEY_BYTES;
use crate::types::MAX_STORAGE_KEYS_PAGE_BYTES;
use crate::types::MAX_STORAGE_KEYS_PAGE_LIMIT;
use crate::types::MAX_STORAGE_KEY_BYTES;
use futures_channel::mpsc;
use futures_util::StreamExt;
use serde_json::json;
use serde_json::Value;
use smoldot_light::ChainAccountNonceError;
use smoldot_light::ChainAccountNonceSnapshot;
use smoldot_light::ChainFinalizedAncestryError;
use smoldot_light::ChainFinalizedBlocksSnapshot;
use smoldot_light::ChainRuntimeContextSnapshot;
use smoldot_light::ChainStorageValuesSnapshot;

use crate::chain::contract_error;
use crate::chain::provider_error;
use crate::chain::rpc::subscription_result;
use crate::chain::RunningProvider;
use crate::chain::SmoldotVerifiedChainClient;
use crate::chain::CHAIN_STATE_FORMAT_VERSION;
use crate::chain::MAX_CHAIN_DATABASE_BYTES;

const MAX_WATCH_EVENTS: usize = 32;

fn send_watch_event(
    sender: &mut mpsc::Sender<ContractResult<ExtrinsicWatchEvent>>,
    overflow: &mut Option<oneshot::Sender<ContractError>>,
    event: ContractResult<ExtrinsicWatchEvent>,
) -> bool {
    match sender.try_send(event) {
        Ok(()) => true,
        Err(error) => {
            if error.is_full() {
                if let Some(overflow) = overflow.take() {
                    let _ = overflow.send(contract_error(
                        ContractErrorCode::Network,
                        "交易观察事件队列溢出，不能保证状态连续性",
                    ));
                }
            }
            false
        }
    }
}

// 缓存只包含本运行实例通过smoldot证明验证的结果；不接收宿主持久记录。
// 条数、总字节、在途块和等待者均有界；不同块的网络读取互不串行化。
const MAX_RUNTIME_CONTEXTS: usize = 64;
const MAX_RUNTIME_CONTEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RUNTIME_WAITERS: usize = 256;
type RuntimeContextKey = ([u8; 32], u64);
type RuntimeContextResult = ContractResult<Arc<RuntimeContext>>;

#[derive(Default)]
pub(crate) struct RuntimeContexts {
    closed: bool,
    bytes: usize,
    ready: VecDeque<Arc<RuntimeContext>>,
    pending: BTreeMap<RuntimeContextKey, Vec<oneshot::Sender<RuntimeContextResult>>>,
}

enum RuntimeContextRead {
    Ready(Arc<RuntimeContext>),
    Wait(oneshot::Receiver<RuntimeContextResult>),
    Fetch,
}

fn runtime_context_key(block: VerifiedBlockRef) -> RuntimeContextKey {
    (block.hash().into_bytes(), block.number())
}

impl RuntimeContexts {
    fn begin(&mut self, block: VerifiedBlockRef) -> ContractResult<RuntimeContextRead> {
        if self.closed {
            return Err(contract_error(
                ContractErrorCode::NotReady,
                "Runtime实例已停止",
            ));
        }
        let key = runtime_context_key(block);
        if self.ready.iter().any(|value| {
            value.block().hash() == block.hash() && value.block().number() != block.number()
        }) {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                "同一块hash出现不同高度",
            ));
        }
        if let Some(value) = self
            .ready
            .iter()
            .find(|value| runtime_context_key(value.block()) == key)
        {
            return Ok(RuntimeContextRead::Ready(Arc::clone(value)));
        }
        if let Some(waiters) = self.pending.get_mut(&key) {
            waiters.retain(|sender| !sender.is_canceled());
            if waiters.len() >= MAX_RUNTIME_WAITERS {
                return Err(contract_error(
                    ContractErrorCode::Unavailable,
                    "Runtime等待数量已达上限",
                ));
            }
            let (tx, rx) = oneshot::channel();
            waiters.push(tx);
            return Ok(RuntimeContextRead::Wait(rx));
        }
        if self.pending.len() >= MAX_RUNTIME_CONTEXTS {
            return Err(contract_error(
                ContractErrorCode::Unavailable,
                "Runtime在途块数量已达上限",
            ));
        }
        self.pending.insert(key, Vec::new());
        Ok(RuntimeContextRead::Fetch)
    }

    fn complete(
        &mut self,
        key: RuntimeContextKey,
        result: RuntimeContextResult,
    ) -> RuntimeContextResult {
        let result = if self.closed {
            Err(contract_error(
                ContractErrorCode::NotReady,
                "Runtime实例已停止",
            ))
        } else {
            result
        };
        if let Ok(context) = &result {
            let size = context.metadata().len();
            // 超过缓存容量的合法结果仍可返回；不为缓存性能上限改变读取合同。
            if size <= MAX_RUNTIME_CONTEXT_BYTES {
                while self.ready.len() >= MAX_RUNTIME_CONTEXTS
                    || self.bytes + size > MAX_RUNTIME_CONTEXT_BYTES
                {
                    if let Some(old) = self.ready.pop_front() {
                        self.bytes -= old.metadata().len();
                    } else {
                        break;
                    }
                }
                self.bytes += size;
                self.ready.push_back(Arc::clone(context));
            }
        }
        for waiter in self.pending.remove(&key).unwrap_or_default() {
            let _ = waiter.send(result.clone());
        }
        result
    }

    pub(crate) fn close(&mut self) {
        self.closed = true;
        self.bytes = 0;
        self.ready.clear();
        for (_, waiters) in std::mem::take(&mut self.pending) {
            for waiter in waiters {
                let _ = waiter.send(Err(contract_error(
                    ContractErrorCode::NotReady,
                    "Runtime实例已停止",
                )));
            }
        }
    }
}

/// 首个请求拥有加载权；任何提前返回或取消都唤醒同块等待者，并移除失败占位。
struct PendingRuntimeContext<'a> {
    cache: &'a Mutex<RuntimeContexts>,
    key: RuntimeContextKey,
    finished: bool,
}
impl PendingRuntimeContext<'_> {
    fn finish(mut self, result: RuntimeContextResult) -> RuntimeContextResult {
        let result = self.cache.lock().complete(self.key, result);
        self.finished = true;
        result
    }
}
impl Drop for PendingRuntimeContext<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.cache.lock().complete(
                self.key,
                Err(contract_error(
                    ContractErrorCode::Unavailable,
                    "Runtime读取已取消",
                )),
            );
        }
    }
}

/// 同hash/高度只复用不可变Runtime内容；best/finalized标记由每位调用者独立验证。
async fn cached_runtime_context(
    cache: &Mutex<RuntimeContexts>,
    block: VerifiedBlockRef,
    load: impl Future<Output = ContractResult<RuntimeContext>>,
) -> ContractResult<RuntimeContext> {
    let read = cache.lock().begin(block)?;
    let context = match read {
        RuntimeContextRead::Ready(context) => {
            transaction_diagnostic("runtime_context_cache_hit", std::time::Duration::ZERO);
            context
        }
        RuntimeContextRead::Wait(receiver) => {
            transaction_diagnostic("runtime_context_join", std::time::Duration::ZERO);
            receiver.await.map_err(|_| {
                contract_error(ContractErrorCode::Unavailable, "Runtime读取结果丢失")
            })??
        }
        RuntimeContextRead::Fetch => {
            let pending = PendingRuntimeContext {
                cache,
                key: runtime_context_key(block),
                finished: false,
            };
            transaction_diagnostic("runtime_context_fetch", std::time::Duration::ZERO);
            let result = load.await.and_then(|context| {
                if runtime_context_key(context.block()) != runtime_context_key(block) {
                    return Err(contract_error(
                        ContractErrorCode::Integrity,
                        "Runtime加载结果区块不匹配",
                    ));
                }
                Ok(Arc::new(context))
            });
            pending.finish(result)?
        }
    };
    RuntimeContext::try_new(block, context.version(), context.metadata().to_vec())
}

fn runtime_context_from_snapshot(
    block: VerifiedBlockRef,
    snapshot: ChainRuntimeContextSnapshot,
) -> ContractResult<RuntimeContext> {
    if snapshot.block_hash != block.hash().into_bytes() || snapshot.block_number != block.number() {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "typed Runtime结果区块不匹配",
        ));
    }
    RuntimeContext::try_new(
        block,
        RuntimeVersion::new(snapshot.spec_version, snapshot.transaction_version),
        snapshot.metadata,
    )
}

impl VerifiedChainClient for SmoldotVerifiedChainClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        // Engine 必须在 provider.start 之前核对导入信封身份，因此 identity 是已验证配置的
        // 静态事实，不以网络运行状态为门禁。start 仍会从 smoldot 真实解析结果复核 genesis。
        Box::pin(async { Ok(ChainIdentity::citizenchain()) })
    }

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            best_head(&running).await
        })
    }

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            finalized_head(&running).await
        })
    }

    fn get_sync_status(&self) -> ContractFuture<'_, ChainSyncStatus> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            let snapshot = status_snapshot(&running).await?;
            ChainSyncStatus::try_new(
                snapshot.peer_count,
                snapshot.is_syncing,
                snapshot.is_usable,
                VerifiedBlockRef::best(
                    Hash32::from_bytes(snapshot.best_block_hash),
                    snapshot.best_block_number,
                ),
                FinalizedBlockRef::from_parts(
                    Hash32::from_bytes(snapshot.current_verified_finalized_block_hash),
                    snapshot.current_verified_finalized_block_number,
                ),
            )
        })
    }

    fn subscribe_finalized_heads(&self) -> ContractStream<'_, FinalizedBlockRef> {
        let (mut sender, receiver) = mpsc::channel(1);
        let preparation = self.running().and_then(|running| {
            let lease = running.rpc.reserve_finalized_worker()?;
            Ok((running, lease))
        });
        let (running, lease) = match preparation {
            Ok(value) => value,
            Err(error) => {
                let _ = sender.try_send(Err(error));
                return Box::pin(receiver);
            }
        };
        self.runtime_handle().spawn(async move {
            let (id, mut notifications) = match running.rpc.subscribe_finalized_heads().await {
                Ok(value) => value,
                Err(error) => { let _ = sender.try_send(Err(error)); return; }
            };
            let mut previous = None;
            let mut pending = None;
            while !sender.is_closed() && !lease.stopping() && !running.rpc.is_closed() {
                if let Some(value) = pending.take() {
                    if let Err(error) = sender.try_send(value) {
                        if error.is_disconnected() { break; }
                        pending = Some(error.into_inner());
                    }
                }
                // 只检查取消，不轮询区块；零 peers 或安静链不会结束订阅。
                let value = match tokio::time::timeout(std::time::Duration::from_millis(250), notifications.recv()).await {
                    Err(_) => continue,
                    Ok(Ok(value)) => value,
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                        // finalized 快照可以合并，重新读取 smoldot 验证后的准确头。
                        json!({"method":"chain_finalizedHead","params":{"subscription":id,"result":null}})
                    }
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                };
                if value.get("method").and_then(Value::as_str) != Some("chain_finalizedHead")
                    || subscription_result(&value, &id).is_none() { continue; }
                // RPC header 只是唤醒信号，证明来自已有 typed verified snapshot。
                match finalized_head(&running).await {
                    Ok(block) if previous.is_none() => {
                        previous = Some(block);
                        pending = Some(Ok(block));
                    }
                    Ok(block) if previous == Some(block) => {}
                    Ok(block) if previous.is_some_and(|value| block.number() > value.number()) => {
                        previous = Some(block);
                        pending = Some(Ok(block));
                    }
                    Ok(_) => {
                        pending = Some(Err(contract_error(
                            ContractErrorCode::Integrity,
                            "smoldot verified finalized head 倒退或同高度换 hash",
                        )));
                    }
                    Err(error) => { pending = Some(Err(error)); }
                }
            }
            if let Err(error) = running.rpc.unsubscribe_finalized_heads(&id).await { lease.fail(error); }
        });
        Box::pin(receiver)
    }

    fn get_storage_keys_paged(
        &self,
        block: FinalizedBlockRef,
        prefix: Vec<u8>,
        start_key: Option<Vec<u8>>,
        limit: u32,
    ) -> ContractFuture<'_, Vec<Vec<u8>>> {
        let running = self.running();
        Box::pin(async move {
            validate_storage_keys_page_request(&prefix, start_key.as_deref(), limit)?;
            let running = running?;
            let exact = finalized_block_at(&running, block.number()).await?;
            if exact != block {
                return Err(contract_error(
                    ContractErrorCode::Integrity,
                    "storage keys page 的 finalized block 已变化",
                ));
            }
            let value = running
                .rpc
                .request(
                    "state_getKeysPaged",
                    json!([
                        format!("0x{}", hex::encode(&prefix)),
                        limit,
                        start_key
                            .as_ref()
                            .map(|key| format!("0x{}", hex::encode(key))),
                        hash_hex(block.hash()),
                    ]),
                )
                .await?;
            parse_storage_keys_page(&value, &prefix, start_key.as_deref(), limit)
        })
    }

    fn call_runtime_api(
        &self,
        block: VerifiedBlockRef,
        method: String,
        arguments: Vec<u8>,
    ) -> ContractFuture<'_, Vec<u8>> {
        let running = self.running();
        Box::pin(async move {
            validate_runtime_api_request(&method, &arguments)?;
            let running = running?;
            let exact = match block.finality() {
                BlockFinality::Finalized => {
                    finalized_block_at(&running, block.number()).await?.into()
                }
                BlockFinality::Best => best_head(&running).await?,
            };
            if exact != block {
                return Err(contract_error(
                    ContractErrorCode::Integrity,
                    "Runtime API block 已变化或不属于当前 verified 链",
                ));
            }
            let value = running
                .rpc
                .request(
                    "state_call",
                    json!([
                        method,
                        format!("0x{}", hex::encode(arguments)),
                        hash_hex(block.hash()),
                    ]),
                )
                .await?;
            let output = parse_hex_value(&value, "Runtime API output")?;
            if output.len() > MAX_RUNTIME_API_OUTPUT_BYTES {
                return Err(contract_error(
                    ContractErrorCode::Decode,
                    "Runtime API output 超过 64 MiB",
                ));
            }
            Ok(output)
        })
    }

    fn get_finalized_block_at(&self, number: u64) -> ContractFuture<'_, FinalizedBlockRef> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            finalized_block_at(&running, number).await
        })
    }

    fn get_finalized_blocks_at(
        &self,
        start_number: u64,
        end_number: u64,
    ) -> ContractFuture<'_, Vec<FinalizedBlockRef>> {
        let range_validation =
            validated_finalized_block_range_len(start_number, end_number).map(|_| ());
        Box::pin(async move {
            range_validation?;
            let running = self.running()?;
            finalized_blocks_at(&running, start_number, end_number).await
        })
    }

    fn resolve_finalized_block(
        &self,
        hash: Hash32,
        number: u64,
    ) -> ContractFuture<'_, FinalizedBlockRef> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            let canonical = finalized_block_at(&running, number).await?;
            if canonical.hash() != hash {
                return Err(contract_error(
                    ContractErrorCode::Conflict,
                    "目标 hash 不是该高度的 finalized canonical hash",
                ));
            }
            Ok(canonical)
        })
    }

    fn get_storage_at(
        &self,
        block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            validate_exact_block(&running, block).await?;
            storage_at(&running, block, key).await
        })
    }

    fn get_storage_batch_at(
        &self,
        block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            validate_exact_block(&running, block).await?;
            validate_storage_keys(&keys)?;
            if keys.is_empty() {
                return Ok(Vec::new());
            }

            // 先按当前头规划快速路线；typed batch 返回它在异步操作内部实际选中的
            // block 身份。只有该身份与调用者请求的准确 block 完全一致才接受结果，
            // 否则按准确 hash 回退。不能用“调用前后头相同”替代这个证明，因为头可能
            // 在操作期间发生 A→B→A。
            let before = storage_batch_heads(&running).await?;
            let route = select_storage_batch_route(block, before);
            if route == StorageBatchRoute::ExactHash {
                return storage_batch_exact_at(&running, block, keys).await;
            }

            let expected_len = keys.len();
            let snapshot = current_storage_batch(&running, route, keys.clone()).await?;
            validate_storage_batch_len(expected_len, snapshot.values.len())?;
            if !storage_snapshot_matches_block(&snapshot, block) {
                return storage_batch_exact_at(&running, block, keys).await;
            }
            Ok(snapshot.values)
        })
    }

    fn get_runtime_context_at(
        &self,
        block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            validate_exact_block(&running, block).await?;
            let started = std::time::Instant::now();
            let context = cached_runtime_context(&running.runtime_contexts, block, async {
                let future = {
                    let client = running.client.lock();
                    client
                        .chain_runtime_context_at(
                            running.chain_id,
                            block.hash().into_bytes(),
                            block.number(),
                        )
                        .map_err(provider_error)?
                };
                // 有界等待会取消typed Future；其析构负责释放订阅引用。
                let snapshot = tokio::time::timeout(self.config.request_timeout, future)
                    .await
                    .map_err(|_| {
                        contract_error(ContractErrorCode::Timeout, "准确块Runtime读取超时")
                    })?
                    .map_err(provider_error)?;
                runtime_context_from_snapshot(block, snapshot)
            })
            .await?;
            // 命中也必须核对当前实例和准确块归属；缓存不能把旧分叉或停止实例变为可信。
            validate_exact_block(&running, block).await?;
            if !Arc::ptr_eq(&running, &self.running()?) {
                return Err(contract_error(
                    ContractErrorCode::Conflict,
                    "Runtime结果来自旧实例",
                ));
            }
            transaction_diagnostic("runtime_context_total", started.elapsed());
            Ok(context)
        })
    }

    fn get_block_header_at(
        &self,
        block: VerifiedBlockRef,
    ) -> ContractFuture<'_, VerifiedBlockHeader> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            validate_exact_block(&running, block).await?;
            verified_header_at(&running, block).await
        })
    }

    fn get_block_extrinsics_at(&self, block: VerifiedBlockRef) -> ContractFuture<'_, Vec<Vec<u8>>> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            validate_exact_block(&running, block).await?;
            let body_future = {
                let client = running.client.lock();
                client
                    .chain_block_extrinsics(running.chain_id, block.hash().into_bytes())
                    .map_err(provider_error)?
            };
            body_future.await.map_err(provider_error)
        })
    }

    fn submit_extrinsic(
        &self,
        extrinsic: SignedExtrinsic,
    ) -> ContractFuture<'_, SubmittedExtrinsic> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            let encoded = format!("0x{}", hex::encode(extrinsic.as_bytes()));
            let result = running
                .rpc
                .request("author_submitExtrinsic", json!([encoded]))
                .await?;
            let returned_hash = parse_hash_value(&result, "submitted extrinsic hash")?;
            verify_submitted_hash(extrinsic.as_bytes(), returned_hash)
        })
    }

    fn watch_extrinsic(
        &self,
        extrinsic: SignedExtrinsic,
    ) -> ContractStream<'_, ExtrinsicWatchEvent> {
        let (mut sender, receiver) = mpsc::channel(MAX_WATCH_EVENTS);
        let (overflow, failed) = oneshot::channel();
        let mut overflow = Some(overflow);
        // 先按序消费已接纳事件，再交付唯一溢出错误；队列关闭不能被误判为成功终态。
        let receiver = receiver.chain(
            futures_util::stream::once(async move { failed.await.ok().map(Err) })
                .filter_map(futures_util::future::ready),
        );
        let running = match self.running() {
            Ok(running) => running,
            Err(error) => {
                let _ = send_watch_event(&mut sender, &mut overflow, Err(error));
                return Box::pin(receiver);
            }
        };
        let lease = match running.rpc.reserve_finalized_worker() {
            Ok(lease) => lease,
            Err(error) => {
                let _ = send_watch_event(&mut sender, &mut overflow, Err(error));
                return Box::pin(receiver);
            }
        };
        let runtime = self.runtime_handle();
        runtime.spawn(async move {
            let encoded = format!("0x{}", hex::encode(extrinsic.as_bytes()));
            let subscription = running.rpc.subscribe_extrinsic(encoded).await;
            let (subscription, mut notifications) = match subscription {
                Ok(subscription) => subscription,
                Err(error) => {
                    let _ = send_watch_event(&mut sender, &mut overflow, Err(error));
                    return;
                }
            };
            // The new upstream API reports retraction as `block: null`; retain
            // only the previously verified inclusion block needed to project
            // the existing generic watch contract.
            let mut last_included = None;

            while !lease.stopping() && !sender.is_closed() {
                let notification = match tokio::time::timeout(
                    std::time::Duration::from_millis(250),
                    notifications.recv(),
                )
                .await
                {
                    Ok(notification) => notification,
                    Err(_) => {
                        if sender.is_closed() || running.rpc.is_closed() {
                            break;
                        }
                        continue;
                    }
                };
                let value = match notification {
                    Ok(value) => value,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = send_watch_event(
                            &mut sender,
                            &mut overflow,
                            Err(contract_error(
                                ContractErrorCode::Network,
                                "交易观察事件队列溢出，不能保证状态连续性",
                            )),
                        );
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let Some(status) = subscription_result(&value, &subscription) else {
                    continue;
                };
                match parse_watch_event(&running, status, &mut last_included).await {
                    Ok((event, terminal)) => {
                        if !send_watch_event(&mut sender, &mut overflow, Ok(event)) || terminal {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = send_watch_event(&mut sender, &mut overflow, Err(error));
                        break;
                    }
                }
            }
            drop(sender);
            drop(overflow);
            if let Err(error) = running.rpc.unwatch_extrinsic(&subscription).await {
                lease.fail(error);
            }
        });
        Box::pin(receiver)
    }

    fn export_state(&self) -> ContractFuture<'_, ExportedChainState> {
        let running = self.running();
        Box::pin(async move {
            let running = running?;
            let before = finalized_head(&running).await?;
            let result = running
                .rpc
                .request(
                    "chainHead_unstable_finalizedDatabase",
                    json!([MAX_CHAIN_DATABASE_BYTES]),
                )
                .await?;
            let database = result.as_str().ok_or_else(|| {
                contract_error(
                    ContractErrorCode::Decode,
                    "smoldot finalized database 响应不是字符串",
                )
            })?;
            if database.is_empty() || database.len() > MAX_CHAIN_DATABASE_BYTES {
                return Err(contract_error(
                    ContractErrorCode::Integrity,
                    "smoldot 导出的数据库为空或超过 256 KiB",
                ));
            }
            let parsed: Value = serde_json::from_str(database).map_err(|error| {
                contract_error(
                    ContractErrorCode::Decode,
                    format!("smoldot 导出的数据库不是有效 JSON: {error}"),
                )
            })?;
            if !parsed.is_object() {
                return Err(contract_error(
                    ContractErrorCode::Decode,
                    "smoldot 导出数据库根必须是 JSON object",
                ));
            }
            let after = finalized_head(&running).await?;
            if before != after {
                return Err(contract_error(
                    ContractErrorCode::Conflict,
                    "导出期间 verified finalized 已移动，丢弃本次数据库",
                ));
            }
            ExportedChainState::try_new(
                ChainIdentity::citizenchain(),
                CHAIN_STATE_FORMAT_VERSION,
                before,
                database.as_bytes().to_vec(),
            )
        })
    }

    fn import_state(&self, state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        Box::pin(async move {
            let finalized = self.import_before_start(state)?;
            Ok(StateImportReceipt::new(finalized))
        })
    }
}

// 同一smoldot快照入口；各调用者只投影所需事实，不另缓存或拼接链头。
async fn status_snapshot(
    running: &RunningProvider,
) -> ContractResult<smoldot_light::ChainStatusSnapshot> {
    let future = running
        .client
        .lock()
        .chain_status_snapshot(running.chain_id)
        .map_err(provider_error)?;
    future.await.map_err(provider_error)
}

async fn best_head(running: &RunningProvider) -> ContractResult<VerifiedBlockRef> {
    let snapshot = status_snapshot(running).await?;
    Ok(VerifiedBlockRef::best(
        Hash32::from_bytes(snapshot.best_block_hash),
        snapshot.best_block_number,
    ))
}

async fn finalized_head(running: &RunningProvider) -> ContractResult<FinalizedBlockRef> {
    let snapshot = status_snapshot(running).await?;
    Ok(FinalizedBlockRef::from_parts(
        Hash32::from_bytes(snapshot.current_verified_finalized_block_hash),
        snapshot.current_verified_finalized_block_number,
    ))
}

/// 单块入口复用 batch ancestry walk，避免产生第二种 finalized 证明语义。
async fn finalized_block_at(
    running: &RunningProvider,
    number: u64,
) -> ContractResult<FinalizedBlockRef> {
    let mut blocks = finalized_blocks_at(running, number, number).await?;
    match blocks.pop() {
        Some(block) if blocks.is_empty() && block.number() == number => Ok(block),
        _ => Err(contract_error(
            ContractErrorCode::Integrity,
            "smoldot finalized ancestry singleton 返回了非单块结果",
        )),
    }
}

/// 从 light-base 一次 proof-backed ancestry walk 投影准确、升序且完整的 finalized 闭区间。
async fn finalized_blocks_at(
    running: &RunningProvider,
    start_number: u64,
    end_number: u64,
) -> ContractResult<Vec<FinalizedBlockRef>> {
    let _expected_len = validated_finalized_block_range_len(start_number, end_number)?;
    let maximum_blocks = NonZero::<u64>::new(MAX_FINALIZED_BLOCKS_PER_BATCH).ok_or_else(|| {
        contract_error(
            ContractErrorCode::Internal,
            "contracts finalized batch 上限意外为零",
        )
    })?;
    let ancestry_future = {
        let client = running.client.lock();
        client
            .chain_finalized_blocks_at(running.chain_id, start_number, end_number, maximum_blocks)
            .map_err(finalized_ancestry_error)?
    };
    let snapshot = ancestry_future.await.map_err(finalized_ancestry_error)?;
    finalized_refs_from_snapshot(snapshot, start_number, end_number)
}

fn finalized_ancestry_error(error: ChainFinalizedAncestryError) -> ContractError {
    let code = match &error {
        ChainFinalizedAncestryError::InvalidArgument(_) => ContractErrorCode::InvalidArgument,
        ChainFinalizedAncestryError::AboveVerifiedUpper(_) => ContractErrorCode::NotFound,
        ChainFinalizedAncestryError::Integrity(_) => ContractErrorCode::Integrity,
        ChainFinalizedAncestryError::Unavailable(_) => ContractErrorCode::Network,
    };
    contract_error(code, error.to_string())
}

fn finalized_refs_from_snapshot(
    snapshot: ChainFinalizedBlocksSnapshot,
    start_number: u64,
    end_number: u64,
) -> ContractResult<Vec<FinalizedBlockRef>> {
    let expected_len = validated_finalized_block_range_len(start_number, end_number)?;
    if start_number > end_number || snapshot.upper_block_number < end_number {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "smoldot finalized ancestry 上界或请求范围无效",
        ));
    }
    if snapshot.blocks.len() != expected_len {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "smoldot finalized ancestry 返回了部分区间",
        ));
    }

    let mut refs = Vec::with_capacity(expected_len);
    for (index, block) in snapshot.blocks.into_iter().enumerate() {
        let block_offset = u64::try_from(index).map_err(|_| {
            contract_error(
                ContractErrorCode::Integrity,
                "finalized ancestry 索引超过 u64",
            )
        })?;
        let expected_number = start_number.checked_add(block_offset).ok_or_else(|| {
            contract_error(
                ContractErrorCode::Integrity,
                "finalized ancestry 高度顺序溢出",
            )
        })?;
        if block.block_number != expected_number {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                "smoldot finalized ancestry 不是准确升序连续区间",
            ));
        }
        refs.push(FinalizedBlockRef::from_parts(
            Hash32::from_bytes(block.block_hash),
            block.block_number,
        ));
    }
    Ok(refs)
}

async fn validate_exact_block(
    running: &RunningProvider,
    block: VerifiedBlockRef,
) -> ContractResult<()> {
    if block.finality() == BlockFinality::Finalized {
        // `finalized_block_at` 固定执行“verified 上界 → canonical 高度映射”的安全顺序。
        // finality 不回退，所以上界内已证明高度不会在随后的 await 期间被重组。
        let canonical = finalized_block_at(running, block.number()).await?;
        if canonical.hash() != block.hash() {
            return Err(contract_error(
                ContractErrorCode::Conflict,
                "目标 hash 不属于 verified finalized canonical 链",
            ));
        }
        return Ok(());
    }

    // smoldot 对非零高度的 chain_getBlockHash 固定返回 null；当前 best 必须用同一份
    // 已验证 typed 快照核对 hash 与高度。过时 best 只允许转入已证明的 finalized 祖先路径。
    let heads = storage_batch_heads(running).await?;
    if !best_block_needs_finalized_proof(block, heads)? {
        return Ok(());
    }
    let canonical = finalized_block_at(running, block.number()).await?;
    if canonical.hash() != block.hash() {
        return Err(contract_error(
            ContractErrorCode::Conflict,
            "原 best 块不属于 verified finalized canonical 链",
        ));
    }
    Ok(())
}

/// 仅当前 verified best 可直接使用；已落入 verified finalized 范围的旧 best 需再验祖先。
fn best_block_needs_finalized_proof(
    block: VerifiedBlockRef,
    heads: StorageBatchHeads,
) -> ContractResult<bool> {
    if block == heads.best {
        return Ok(false);
    }
    if block.number() <= heads.verified_finalized.number() {
        return Ok(true);
    }
    Err(contract_error(
        ContractErrorCode::Conflict,
        "原 best 块已过期且尚无 verified finalized 证明",
    ))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StorageBatchRoute {
    CurrentBest,
    CurrentVerifiedFinalized,
    ExactHash,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StorageBatchHeads {
    best: VerifiedBlockRef,
    surface_finalized: FinalizedBlockRef,
    verified_finalized: FinalizedBlockRef,
}

async fn storage_batch_heads(running: &RunningProvider) -> ContractResult<StorageBatchHeads> {
    let snapshot = status_snapshot(running).await?;
    Ok(StorageBatchHeads {
        best: VerifiedBlockRef::best(
            Hash32::from_bytes(snapshot.best_block_hash),
            snapshot.best_block_number,
        ),
        surface_finalized: FinalizedBlockRef::from_parts(
            Hash32::from_bytes(snapshot.finalized_block_hash),
            snapshot.finalized_block_number,
        ),
        verified_finalized: FinalizedBlockRef::from_parts(
            Hash32::from_bytes(snapshot.current_verified_finalized_block_hash),
            snapshot.current_verified_finalized_block_number,
        ),
    })
}

fn select_storage_batch_route(
    block: VerifiedBlockRef,
    heads: StorageBatchHeads,
) -> StorageBatchRoute {
    match block.finality() {
        BlockFinality::Best if block == heads.best => StorageBatchRoute::CurrentBest,
        // typed finalized API 读取同步服务的 surface finalized。只有它与 SDK 的
        // current verified finalized 是同一个准确块时才可使用，warp 目标不能混入。
        BlockFinality::Finalized
            if block == heads.verified_finalized.verified()
                && block == heads.surface_finalized.verified() =>
        {
            StorageBatchRoute::CurrentVerifiedFinalized
        }
        BlockFinality::Best | BlockFinality::Finalized => StorageBatchRoute::ExactHash,
    }
}

async fn current_storage_batch(
    running: &RunningProvider,
    route: StorageBatchRoute,
    keys: Vec<Vec<u8>>,
) -> ContractResult<ChainStorageValuesSnapshot> {
    let batch_future = {
        let client = running.client.lock();
        match route {
            StorageBatchRoute::CurrentBest => client
                .chain_storage_values_snapshot(running.chain_id, keys)
                .map_err(provider_error)?,
            StorageBatchRoute::CurrentVerifiedFinalized => client
                .chain_finalized_storage_values_snapshot(running.chain_id, keys)
                .map_err(provider_error)?,
            StorageBatchRoute::ExactHash => {
                return Err(contract_error(
                    ContractErrorCode::Internal,
                    "历史准确块不能进入 current typed batch",
                ));
            }
        }
    };
    batch_future.await.map_err(provider_error)
}

fn storage_snapshot_matches_block(
    snapshot: &ChainStorageValuesSnapshot,
    block: VerifiedBlockRef,
) -> bool {
    snapshot.block_number == block.number() && snapshot.block_hash == block.hash().into_bytes()
}

async fn storage_batch_exact_at(
    running: &RunningProvider,
    block: VerifiedBlockRef,
    keys: Vec<Vec<u8>>,
) -> ContractResult<Vec<Option<Vec<u8>>>> {
    // 设备内smoldot按准确块状态根验证多键证明；去重后发一次本地RPC，输出恢复原顺序。
    let unique: std::collections::BTreeSet<_> = keys.iter().cloned().collect();
    let encoded: Vec<_> = unique
        .iter()
        .map(|key| format!("0x{}", hex::encode(key)))
        .collect();
    let result = running
        .rpc
        .request(
            "state_queryStorageAt",
            json!([encoded, hash_hex(block.hash())]),
        )
        .await?;
    parse_storage_batch_at(&result, block, &keys)
}

fn parse_storage_batch_at(
    value: &Value,
    block: VerifiedBlockRef,
    keys: &[Vec<u8>],
) -> ContractResult<Vec<Option<Vec<u8>>>> {
    let invalid = || {
        contract_error(
            ContractErrorCode::Integrity,
            "smoldot准确块批读返回不完整或混入其他键/区块",
        )
    };
    let sets = value
        .as_array()
        .filter(|sets| sets.len() == 1)
        .ok_or_else(invalid)?;
    if sets[0]["block"].as_str() != Some(hash_hex(block.hash()).as_str()) {
        return Err(invalid());
    }
    let changes = sets[0]["changes"].as_array().ok_or_else(invalid)?;
    let expected: std::collections::BTreeSet<_> = keys.iter().collect();
    let mut rows = BTreeMap::new();
    for change in changes {
        let pair = change
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(invalid)?;
        let key = parse_hex_value(&pair[0], "storage batch key")?;
        if !expected.contains(&key) || rows.contains_key(&key) {
            return Err(invalid());
        }
        let data = if pair[1].is_null() {
            None
        } else {
            Some(parse_hex_value(&pair[1], "storage batch value")?)
        };
        rows.insert(key, data);
    }
    if rows.len() != expected.len() {
        return Err(invalid());
    }
    keys.iter()
        .map(|key| rows.get(key).cloned().ok_or_else(invalid))
        .collect()
}

fn validate_storage_keys(keys: &[Vec<u8>]) -> ContractResult<()> {
    if keys.len() > MAX_STORAGE_BATCH_KEYS {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage batch key 数量超过 1024",
        ));
    }
    let mut total = 0_usize;
    if let Some(index) = keys.iter().position(Vec::is_empty) {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            format!("storage key {index} 不能为空"),
        ));
    }
    for (index, key) in keys.iter().enumerate() {
        if key.len() > MAX_STORAGE_KEY_BYTES {
            return Err(contract_error(
                ContractErrorCode::InvalidArgument,
                format!("storage key {index} 超过 4 KiB"),
            ));
        }
        total = total.checked_add(key.len()).ok_or_else(|| {
            contract_error(
                ContractErrorCode::InvalidArgument,
                "storage batch key 总长度溢出",
            )
        })?;
    }
    if total > MAX_STORAGE_BATCH_KEY_BYTES {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage batch key 总长度超过 1 MiB",
        ));
    }
    Ok(())
}

fn validate_storage_keys_page_request(
    prefix: &[u8],
    start_key: Option<&[u8]>,
    limit: u32,
) -> ContractResult<()> {
    if prefix.is_empty() || prefix.len() > MAX_STORAGE_KEY_BYTES {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage keys page prefix 必须包含 1..4 KiB 字节",
        ));
    }
    if start_key.is_some_and(|key| key.is_empty() || key.len() > MAX_STORAGE_KEY_BYTES) {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage keys page start_key 必须为空或包含 1..4 KiB 字节",
        ));
    }
    if limit == 0 || limit > MAX_STORAGE_KEYS_PAGE_LIMIT {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage keys page limit 必须位于 1..1000",
        ));
    }
    Ok(())
}

fn parse_storage_keys_page(
    value: &Value,
    prefix: &[u8],
    start_key: Option<&[u8]>,
    limit: u32,
) -> ContractResult<Vec<Vec<u8>>> {
    let values = value.as_array().ok_or_else(|| {
        contract_error(ContractErrorCode::Decode, "state_getKeysPaged 结果不是数组")
    })?;
    if values.len() > limit as usize {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "state_getKeysPaged 返回数量超过请求 limit",
        ));
    }
    let mut total = 0_usize;
    let mut keys = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let key = parse_hex_value(value, "storage key")?;
        if key.is_empty()
            || key.len() > MAX_STORAGE_KEY_BYTES
            || !key.starts_with(prefix)
            || start_key.is_some_and(|start| key.as_slice() <= start)
        {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                format!("state_getKeysPaged 第 {index} 项不属于请求页面"),
            ));
        }
        if keys
            .last()
            .is_some_and(|previous: &Vec<u8>| previous >= &key)
        {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                "state_getKeysPaged 结果不是严格升序",
            ));
        }
        total = total.checked_add(key.len()).ok_or_else(|| {
            contract_error(ContractErrorCode::Integrity, "storage keys page 长度溢出")
        })?;
        if total > MAX_STORAGE_KEYS_PAGE_BYTES {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                "storage keys page 聚合字节超过 4 MiB",
            ));
        }
        keys.push(key);
    }
    Ok(keys)
}

fn validate_runtime_api_request(method: &str, arguments: &[u8]) -> ContractResult<()> {
    let bytes = method.as_bytes();
    let separator = bytes.iter().position(|byte| *byte == b'_');
    let valid_character = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'_';
    if bytes.is_empty()
        || bytes.len() > MAX_RUNTIME_API_METHOD_BYTES
        || !bytes[0].is_ascii_alphabetic()
        || !bytes.iter().all(valid_character)
        || separator.is_none_or(|index| index == 0 || index + 1 == bytes.len())
    {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "Runtime API method 必须是 1..128 ASCII 的 Trait_method",
        ));
    }
    if arguments.len() > MAX_RUNTIME_API_ARGUMENT_BYTES {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "Runtime API arguments 超过 1 MiB",
        ));
    }
    Ok(())
}

fn validate_storage_batch_len(expected: usize, actual: usize) -> ContractResult<()> {
    if actual != expected {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            format!("smoldot typed storage batch 返回长度错误：期望 {expected}，实际 {actual}"),
        ));
    }
    Ok(())
}

async fn storage_at(
    running: &RunningProvider,
    block: VerifiedBlockRef,
    key: Vec<u8>,
) -> ContractResult<Option<Vec<u8>>> {
    if key.is_empty() {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage key 不能为空",
        ));
    }
    if key.len() > MAX_STORAGE_KEY_BYTES {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "storage key 超过 4 KiB",
        ));
    }
    let result = running
        .rpc
        .request("state_getStorage", exact_storage_params(block, key))
        .await?;
    if result.is_null() {
        return Ok(None);
    }
    parse_hex_value(&result, "storage value").map(Some)
}

fn exact_storage_params(block: VerifiedBlockRef, key: Vec<u8>) -> Value {
    json!([format!("0x{}", hex::encode(key)), hash_hex(block.hash())])
}

async fn block_number_by_hash(running: &RunningProvider, hash: Hash32) -> ContractResult<u64> {
    let header = running
        .rpc
        .request("chain_getHeader", json!([hash_hex(hash)]))
        .await?;
    if header.is_null() {
        return Err(contract_error(
            ContractErrorCode::NotFound,
            "轻节点不知道目标 block hash",
        ));
    }
    parse_u64_value(
        header.get("number").ok_or_else(|| {
            contract_error(ContractErrorCode::Decode, "chain_getHeader 响应缺少 number")
        })?,
        "block number",
    )
}

async fn verified_header_at(
    running: &RunningProvider,
    block: VerifiedBlockRef,
) -> ContractResult<VerifiedBlockHeader> {
    let value = running
        .rpc
        .request("chain_getHeader", json!([hash_hex(block.hash())]))
        .await?;
    if value.is_null() {
        return Err(contract_error(
            ContractErrorCode::NotFound,
            "轻节点不知道目标 block header",
        ));
    }
    decode_verified_header(block, &value)
}

fn decode_verified_header(
    block: VerifiedBlockRef,
    value: &Value,
) -> ContractResult<VerifiedBlockHeader> {
    let number = parse_u64_value(
        value
            .get("number")
            .ok_or_else(|| contract_error(ContractErrorCode::Decode, "block header 缺少 number"))?,
        "block header number",
    )?;
    if number != block.number() {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "block header 高度与请求块不一致",
        ));
    }
    let parent_hash = parse_hash_value(
        value.get("parentHash").ok_or_else(|| {
            contract_error(ContractErrorCode::Decode, "block header 缺少 parentHash")
        })?,
        "block header parentHash",
    )?;
    let state_root = parse_hash_value(
        value.get("stateRoot").ok_or_else(|| {
            contract_error(ContractErrorCode::Decode, "block header 缺少 stateRoot")
        })?,
        "block header stateRoot",
    )?;
    let extrinsics_root = parse_hash_value(
        value.get("extrinsicsRoot").ok_or_else(|| {
            contract_error(
                ContractErrorCode::Decode,
                "block header 缺少 extrinsicsRoot",
            )
        })?,
        "block header extrinsicsRoot",
    )?;
    let logs = value
        .get("digest")
        .and_then(|digest| digest.get("logs"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            contract_error(
                ContractErrorCode::Decode,
                "block header digest.logs 不是数组",
            )
        })?;
    let log_count = u64::try_from(logs.len()).map_err(|_| {
        contract_error(
            ContractErrorCode::Decode,
            "block header digest log 数量超过 u64",
        )
    })?;
    let mut digest = scale_compact_u64(log_count);
    for (index, log) in logs.iter().enumerate() {
        let encoded = parse_hex_value(log, &format!("block header digest log {index}"))?;
        let new_len = digest.len().checked_add(encoded.len()).ok_or_else(|| {
            contract_error(ContractErrorCode::Integrity, "block header digest 长度溢出")
        })?;
        if new_len > MAX_HEADER_DIGEST_BYTES {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                "block header digest 超过 1 MiB",
            ));
        }
        digest.extend_from_slice(&encoded);
    }

    // Rebuild the canonical SCALE Header and independently bind every returned field to the
    // caller's exact hash. `validate_exact_block` proves canonicality/finality; this check proves
    // the JSON projection was neither mixed across blocks nor silently truncated.
    let mut encoded = Vec::with_capacity(128_usize.saturating_add(digest.len()));
    encoded.extend_from_slice(parent_hash.as_bytes());
    encoded.extend_from_slice(&scale_compact_u64(number));
    encoded.extend_from_slice(state_root.as_bytes());
    encoded.extend_from_slice(extrinsics_root.as_bytes());
    encoded.extend_from_slice(&digest);
    if substrate_blake2_256(&encoded) != block.hash() {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "block header 字段重建出的 Blake2-256 与请求 hash 不一致",
        ));
    }
    VerifiedBlockHeader::try_new(block, parent_hash, state_root, extrinsics_root, digest)
}

fn scale_compact_u64(value: u64) -> Vec<u8> {
    if value < 1 << 6 {
        return vec![(value as u8) << 2];
    }
    if value < 1 << 14 {
        return (((value as u16) << 2) | 1).to_le_bytes().to_vec();
    }
    if value < 1 << 30 {
        return (((value as u32) << 2) | 2).to_le_bytes().to_vec();
    }
    let bytes = value.to_le_bytes();
    let length = 8_usize
        .saturating_sub((value.leading_zeros() as usize) / 8)
        .max(4);
    let mut encoded = Vec::with_capacity(length + 1);
    encoded.push((((length - 4) as u8) << 2) | 3);
    encoded.extend_from_slice(&bytes[..length]);
    encoded
}

async fn block_ref_from_transaction_watch(
    running: &RunningProvider,
    value: &Value,
    finality: BlockFinality,
) -> ContractResult<VerifiedBlockRef> {
    let object = value.as_object().ok_or_else(|| {
        contract_error(
            ContractErrorCode::Decode,
            "transactionWatch_v1 block 不是 object",
        )
    })?;
    let hash = parse_hash_value(
        object.get("hash").ok_or_else(|| {
            contract_error(
                ContractErrorCode::Decode,
                "transactionWatch_v1 block 缺少 hash",
            )
        })?,
        "transactionWatch_v1 block hash",
    )?;
    let index = object.get("index").and_then(Value::as_u64).ok_or_else(|| {
        contract_error(
            ContractErrorCode::Decode,
            "transactionWatch_v1 block 缺少 index",
        )
    })?;
    u32::try_from(index).map_err(|_| {
        contract_error(
            ContractErrorCode::Decode,
            "transactionWatch_v1 block index 越界",
        )
    })?;
    let number = block_number_by_hash(running, hash).await?;
    let block = match finality {
        BlockFinality::Best => VerifiedBlockRef::best(hash, number),
        BlockFinality::Finalized => VerifiedBlockRef::finalized(hash, number),
    };
    validate_exact_block(running, block).await?;
    Ok(block)
}

async fn parse_watch_event(
    running: &RunningProvider,
    status: &Value,
    last_included: &mut Option<VerifiedBlockRef>,
) -> ContractResult<(ExtrinsicWatchEvent, bool)> {
    let map = status.as_object().ok_or_else(|| {
        contract_error(
            ContractErrorCode::Decode,
            "transactionWatch_v1 状态不是 object",
        )
    })?;
    let name = map.get("event").and_then(Value::as_str).ok_or_else(|| {
        contract_error(
            ContractErrorCode::Decode,
            "transactionWatch_v1 状态缺少 event",
        )
    })?;
    match name {
        "validated" => Ok((ExtrinsicWatchEvent::Ready, false)),
        "broadcasted" => {
            let peers = map.get("numPeers").and_then(Value::as_u64).ok_or_else(|| {
                contract_error(
                    ContractErrorCode::Decode,
                    "transactionWatch_v1 broadcasted 缺少 numPeers",
                )
            })?;
            let peer_count = u32::try_from(peers).map_err(|_| {
                contract_error(
                    ContractErrorCode::Decode,
                    "transactionWatch_v1 numPeers 越界",
                )
            })?;
            Ok((ExtrinsicWatchEvent::Broadcast { peer_count }, false))
        }
        "bestChainBlockIncluded" => match map.get("block") {
            Some(Value::Null) => Ok((
                last_included
                    .take()
                    .map(|block| ExtrinsicWatchEvent::Retracted { block })
                    .unwrap_or(ExtrinsicWatchEvent::Future),
                false,
            )),
            Some(value) => {
                let block =
                    block_ref_from_transaction_watch(running, value, BlockFinality::Best).await?;
                *last_included = Some(block);
                Ok((ExtrinsicWatchEvent::InBlock { block }, false))
            }
            None => Err(contract_error(
                ContractErrorCode::Decode,
                "transactionWatch_v1 bestChainBlockIncluded 缺少 block",
            )),
        },
        "finalized" => {
            let value = map.get("block").ok_or_else(|| {
                contract_error(
                    ContractErrorCode::Decode,
                    "transactionWatch_v1 finalized 缺少 block",
                )
            })?;
            let block = block_ref_from_transaction_watch(running, value, BlockFinality::Finalized)
                .await?
                .require_finalized()?;
            Ok((ExtrinsicWatchEvent::Finalized { block }, true))
        }
        "invalid" => {
            let error = validate_transaction_watch_error(map.get("error"), "invalid")?;
            transaction_diagnostic(
                transaction_invalid_category(error),
                std::time::Duration::ZERO,
            );
            Ok((ExtrinsicWatchEvent::Invalid, true))
        }
        "dropped" => {
            validate_transaction_watch_error(map.get("error"), "dropped")?;
            match map.get("broadcasted").and_then(Value::as_bool) {
                Some(_) => Ok((ExtrinsicWatchEvent::Dropped, true)),
                None => Err(contract_error(
                    ContractErrorCode::Decode,
                    "transactionWatch_v1 dropped 缺少 broadcasted",
                )),
            }
        }
        "error" => {
            let error = validate_transaction_watch_error(map.get("error"), "error")?;
            Err(contract_error(
                ContractErrorCode::Network,
                format!("transactionWatch_v1 观察失败: {error}"),
            ))
        }
        _ => Err(contract_error(
            ContractErrorCode::Decode,
            format!("未知 transactionWatch_v1 状态: {name}"),
        )),
    }
}

/// 原始错误可能携带节点自由文本；诊断仅保留与随包 smoldot 官方枚举一致的闭集。
fn transaction_invalid_category(error: &str) -> &'static str {
    match error {
        "Invalid transaction: Stale" => "invalid_stale",
        "Invalid transaction: Future" => "invalid_future",
        "Invalid transaction: Payment" => "invalid_payment",
        "Invalid transaction: BadProof" => "invalid_bad_proof",
        "Invalid transaction: Call" => "invalid_call",
        "Invalid transaction: AncientBirthBlock" => "invalid_ancient_birth_block",
        "Invalid transaction: ExhaustsResources" => "invalid_exhausts_resources",
        "Invalid transaction: BadMandatory" => "invalid_bad_mandatory",
        "Invalid transaction: MandatoryDispatch" => "invalid_mandatory_dispatch",
        _ => "invalid_other",
    }
}

/// 仅定向真机进程启用；禁止启用上游全量日志，避免把交易哈希带入输出。
fn transaction_diagnostic(stage: &'static str, elapsed: std::time::Duration) {
    if std::env::var_os("CITIZENSDK_TRANSACTION_DIAGNOSTICS").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |value| value.as_millis());
        eprintln!(
            "CITIZENSDK_TX_DIAG at_ms={at_ms} stage={stage} elapsed_us={}",
            elapsed.as_micros()
        );
    }
}

fn validate_transaction_watch_error<'a>(
    value: Option<&'a Value>,
    event: &str,
) -> ContractResult<&'a str> {
    let text = value.and_then(Value::as_str).ok_or_else(|| {
        contract_error(
            ContractErrorCode::Decode,
            format!("transactionWatch_v1 {event} 缺少 error"),
        )
    })?;
    if text.is_empty() || text.len() > 4_096 {
        return Err(contract_error(
            ContractErrorCode::Decode,
            format!("transactionWatch_v1 {event} error 长度非法"),
        ));
    }
    Ok(text)
}

pub(crate) fn parse_hash_value(value: &Value, field: &str) -> ContractResult<Hash32> {
    let bytes = parse_hex_value(value, field)?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|bytes: Vec<u8>| {
        contract_error(
            ContractErrorCode::Decode,
            format!("{field} 必须是 32 字节，实际为 {}", bytes.len()),
        )
    })?;
    Ok(Hash32::from_bytes(bytes))
}

fn parse_hex_value(value: &Value, field: &str) -> ContractResult<Vec<u8>> {
    let text = value.as_str().ok_or_else(|| {
        contract_error(
            ContractErrorCode::Decode,
            format!("{field} 不是 hex 字符串"),
        )
    })?;
    let encoded = text.strip_prefix("0x").ok_or_else(|| {
        contract_error(ContractErrorCode::Decode, format!("{field} 缺少 0x 前缀"))
    })?;
    if encoded.len() % 2 != 0 {
        return Err(contract_error(
            ContractErrorCode::Decode,
            format!("{field} hex 长度不是偶数"),
        ));
    }
    hex::decode(encoded).map_err(|error| {
        contract_error(
            ContractErrorCode::Decode,
            format!("{field} 不是有效 hex: {error}"),
        )
    })
}

fn parse_u64_value(value: &Value, field: &str) -> ContractResult<u64> {
    if let Some(number) = value.as_u64() {
        return Ok(number);
    }
    let text = value
        .as_str()
        .ok_or_else(|| contract_error(ContractErrorCode::Decode, format!("{field} 不是数字")))?;
    if let Some(hex) = text.strip_prefix("0x") {
        return u64::from_str_radix(hex, 16).map_err(|error| {
            contract_error(
                ContractErrorCode::Decode,
                format!("{field} 不是有效十六进制数字: {error}"),
            )
        });
    }
    text.parse::<u64>().map_err(|error| {
        contract_error(
            ContractErrorCode::Decode,
            format!("{field} 不是有效数字: {error}"),
        )
    })
}

fn hash_hex(hash: Hash32) -> String {
    format!("0x{}", hex::encode(hash.as_bytes()))
}

/// Substrate/CitizenChain 对完整 SCALE extrinsic（含其 Compact 长度前缀）使用的
/// Blake2b-256 身份。节点只报告接收结果；provider 必须独立计算后再接受返回 hash。
fn substrate_blake2_256(bytes: &[u8]) -> Hash32 {
    let digest = blake2_rfc::blake2b::blake2b(32, &[], bytes);
    let mut hash = [0_u8; 32];
    hash.copy_from_slice(digest.as_bytes());
    Hash32::from_bytes(hash)
}

fn verify_submitted_hash(
    extrinsic: &[u8],
    returned_hash: Hash32,
) -> ContractResult<SubmittedExtrinsic> {
    if returned_hash != substrate_blake2_256(extrinsic) {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "轻节点返回的 extrinsic hash 与完整已签名字节的本地 Blake2-256 不一致",
        ));
    }
    Ok(SubmittedExtrinsic::new(returned_hash))
}

#[cfg(test)]
#[path = "../../tests/abi/chain.rs"]
mod tests;

impl AccountNonceSource for SmoldotVerifiedChainClient {
    fn account_next_index(
        &self,
        account_id: AccountId32,
        at_best: VerifiedBlockRef,
    ) -> ContractFuture<'_, AccountNonce> {
        Box::pin(async move {
            require_best_request(at_best)?;
            let running = self.running()?;
            let snapshot_future = {
                let client = running.client.lock();
                client
                    .chain_account_next_index_snapshot(
                        running.chain_id,
                        account_id.as_bytes().to_vec(),
                        at_best.hash().into_bytes(),
                        at_best.number(),
                    )
                    .map_err(provider_error)?
            };
            let snapshot = snapshot_future.await.map_err(nonce_error)?;
            account_nonce_from_snapshot(account_id, at_best, snapshot)
        })
    }
}

// 接纳错误按类型映射；证明请求的原网络诊断保持，不解析自由错误文本。
fn nonce_error(error: ChainAccountNonceError) -> ContractError {
    let code = match &error {
        ChainAccountNonceError::InvalidArgument => ContractErrorCode::InvalidArgument,
        ChainAccountNonceError::NotReady => ContractErrorCode::NotReady,
        ChainAccountNonceError::Conflict => ContractErrorCode::Conflict,
        ChainAccountNonceError::Integrity => ContractErrorCode::Integrity,
        ChainAccountNonceError::Runtime(_) => ContractErrorCode::Network,
    };
    contract_error(code, error.to_string())
}

fn require_best_request(at_best: VerifiedBlockRef) -> ContractResult<()> {
    if at_best.finality() != BlockFinality::Best {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "AccountNonceSource 只接受准确 best 块引用",
        ));
    }
    Ok(())
}

fn account_nonce_from_snapshot(
    account_id: AccountId32,
    at_best: VerifiedBlockRef,
    snapshot: ChainAccountNonceSnapshot,
) -> ContractResult<AccountNonce> {
    require_best_request(at_best)?;
    if snapshot.account_id.as_slice() != account_id.as_bytes() {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "typed nonce 快照账户与请求账户不一致",
        ));
    }

    let observed = VerifiedBlockRef::best(
        crate::types::Hash32::from_bytes(snapshot.block_hash),
        snapshot.block_number,
    );
    if observed != at_best {
        return Err(contract_error(
            ContractErrorCode::Conflict,
            "typed nonce runtime call 不属于调用者指定的准确 best 块",
        ));
    }

    AccountNonce::try_new(
        &ChainIdentity::citizenchain(),
        observed,
        account_id,
        snapshot.nonce,
    )
}

#[cfg(test)]
#[path = "../../tests/abi/nonce.rs"]
mod nonce_tests;
