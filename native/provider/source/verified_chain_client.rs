use futures_channel::oneshot;
use parking_lot::Mutex;
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    num::NonZero,
    sync::Arc,
};

use citizen_sdk_contracts::{
    validated_finalized_block_range_len, BlockFinality, ChainIdentity, ChainSyncStatus,
    ContractError, ContractErrorCode, ContractFuture, ContractResult, ContractStream,
    ExportedChainState, ExtrinsicWatchEvent, FinalizedBlockRef, Hash32, RuntimeContext,
    RuntimeVersion, SignedExtrinsic, StateImportReceipt, SubmittedExtrinsic, VerifiedBlockHeader,
    VerifiedBlockRef, VerifiedChainClient, MAX_FINALIZED_BLOCKS_PER_BATCH, MAX_HEADER_DIGEST_BYTES,
    MAX_RUNTIME_API_ARGUMENT_BYTES, MAX_RUNTIME_API_METHOD_BYTES, MAX_RUNTIME_API_OUTPUT_BYTES,
    MAX_STORAGE_BATCH_KEYS, MAX_STORAGE_BATCH_KEY_BYTES, MAX_STORAGE_KEYS_PAGE_BYTES,
    MAX_STORAGE_KEYS_PAGE_LIMIT, MAX_STORAGE_KEY_BYTES,
};
use futures_channel::mpsc;
use serde_json::{json, Value};
use smoldot_light::{
    ChainFinalizedAncestryError, ChainFinalizedBlocksSnapshot, ChainRuntimeContextSnapshot,
    ChainStorageValuesSnapshot,
};

use crate::{
    client::{
        contract_error, provider_error, RunningProvider, SmoldotVerifiedChainClient,
        CHAIN_STATE_FORMAT_VERSION, MAX_CHAIN_DATABASE_BYTES,
    },
    legacy::subscription_result,
};

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
            let snapshot_future = {
                let client = running.client.lock();
                client
                    .chain_status_snapshot(running.chain_id)
                    .map_err(provider_error)?
            };
            let snapshot = snapshot_future.await.map_err(provider_error)?;
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
        let (sender, receiver) = mpsc::unbounded();
        let running = match self.running() {
            Ok(running) => running,
            Err(error) => {
                let _ = sender.unbounded_send(Err(error));
                return Box::pin(receiver);
            }
        };
        let lease = match running.rpc.reserve_finalized_worker() {
            Ok(lease) => lease,
            Err(error) => {
                let _ = sender.unbounded_send(Err(error));
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
                    let _ = sender.unbounded_send(Err(error));
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
                        let _ = sender.unbounded_send(Err(contract_error(
                            ContractErrorCode::Network,
                            "交易观察事件队列溢出，不能保证状态连续性",
                        )));
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let Some(status) = subscription_result(&value, &subscription) else {
                    continue;
                };
                match parse_watch_event(&running, status, &mut last_included).await {
                    Ok((event, terminal)) => {
                        if sender.unbounded_send(Ok(event)).is_err() || terminal {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.unbounded_send(Err(error));
                        break;
                    }
                }
            }
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

async fn best_head(running: &RunningProvider) -> ContractResult<VerifiedBlockRef> {
    let snapshot_future = {
        let client = running.client.lock();
        client
            .chain_status_snapshot(running.chain_id)
            .map_err(provider_error)?
    };
    let snapshot = snapshot_future.await.map_err(provider_error)?;
    Ok(VerifiedBlockRef::best(
        Hash32::from_bytes(snapshot.best_block_hash),
        snapshot.best_block_number,
    ))
}

async fn finalized_head(running: &RunningProvider) -> ContractResult<FinalizedBlockRef> {
    let snapshot_future = {
        let client = running.client.lock();
        client
            .chain_status_snapshot(running.chain_id)
            .map_err(provider_error)?
    };
    let snapshot = snapshot_future.await.map_err(provider_error)?;
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
    let snapshot_future = {
        let client = running.client.lock();
        client
            .chain_status_snapshot(running.chain_id)
            .map_err(provider_error)?
    };
    let snapshot = snapshot_future.await.map_err(provider_error)?;
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
    let mut values = Vec::with_capacity(keys.len());
    for key in keys {
        values.push(storage_at(running, block, key).await?);
    }
    Ok(values)
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
mod tests {
    use super::*;
    use smoldot_light::ChainFinalizedBlockSnapshot;

    fn runtime_fixture(block: VerifiedBlockRef, version: u32) -> RuntimeContext {
        RuntimeContext::try_new(block, RuntimeVersion::new(version, 1), vec![version as u8])
            .expect("fixture")
    }

    /// 同块finality推进只改变已独立验证的标记；不同块/升级绝不沿用旧内容。
    #[test]
    fn runtime_cache_reuses_exact_block_and_separates_forks_and_upgrades() {
        futures::executor::block_on(async {
            let cache = Mutex::new(RuntimeContexts::default());
            let a = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
            let finalized = VerifiedBlockRef::finalized(a.hash(), a.number());
            cached_runtime_context(&cache, a, async { Ok(runtime_fixture(a, 1)) })
                .await
                .expect("first");
            let second = cached_runtime_context(&cache, finalized, async {
                panic!("same block must not reload")
            })
            .await
            .expect("hit");
            assert_eq!(second.block(), finalized);
            assert_eq!(second.version().spec_version(), 1);
            let fork = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 10);
            let upgrade = VerifiedBlockRef::best(Hash32::from_bytes([3; 32]), 11);
            for block in [fork, upgrade] {
                let value =
                    cached_runtime_context(&cache, block, async { Ok(runtime_fixture(block, 2)) })
                        .await
                        .expect("distinct block");
                assert_eq!(value.version().spec_version(), 2);
            }
            let wrong_height = VerifiedBlockRef::best(a.hash(), 12);
            assert!(cached_runtime_context(&cache, wrong_height, async {
                panic!("invalid identity")
            })
            .await
            .is_err());
        });
    }

    /// 一个网络读取服务并发请求；另一个块可以在其等待期间独立完成。
    #[test]
    fn runtime_cache_coalesces_requests_without_serializing_other_blocks() {
        futures::executor::block_on(async {
            let cache = Mutex::new(RuntimeContexts::default());
            let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
            let (tx, rx) = oneshot::channel();
            let mut owner = Box::pin(cached_runtime_context(&cache, block, async {
                rx.await.expect("release");
                Ok(runtime_fixture(block, 1))
            }));
            assert!(futures::poll!(&mut owner).is_pending());
            let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
                panic!("duplicate network load")
            }));
            assert!(futures::poll!(&mut waiter).is_pending());
            let other = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 11);
            cached_runtime_context(&cache, other, async { Ok(runtime_fixture(other, 1)) })
                .await
                .expect("independent");
            tx.send(()).expect("send");
            assert_eq!(owner.await.expect("owner"), waiter.await.expect("waiter"));
            assert!(cache.lock().pending.is_empty());
        });
    }

    /// 失败向全部等待者传播一次且不缓存；下一次显式调用可以重新读取。
    #[test]
    fn runtime_cache_failure_is_shared_and_retry_is_not_poisoned() {
        futures::executor::block_on(async {
            let cache = Mutex::new(RuntimeContexts::default());
            let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
            let (tx, rx) = oneshot::channel();
            let mut owner = Box::pin(cached_runtime_context(&cache, block, async {
                rx.await.expect("release");
                Err(contract_error(
                    ContractErrorCode::Network,
                    "fixture failure",
                ))
            }));
            assert!(futures::poll!(&mut owner).is_pending());
            let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
                panic!("must share failure")
            }));
            assert!(futures::poll!(&mut waiter).is_pending());
            tx.send(()).expect("send");
            assert_eq!(
                owner.await.expect_err("failure").code(),
                ContractErrorCode::Network
            );
            assert_eq!(
                waiter.await.expect_err("failure").code(),
                ContractErrorCode::Network
            );
            assert!(cache.lock().ready.is_empty());
            cached_runtime_context(&cache, block, async { Ok(runtime_fixture(block, 1)) })
                .await
                .expect("retry");
        });
    }

    #[test]
    fn runtime_cache_owner_cancel_wakes_waiters_and_stop_rejects_late_success() {
        futures::executor::block_on(async {
            let cache = Mutex::new(RuntimeContexts::default());
            let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
            let mut owner = Box::pin(cached_runtime_context(
                &cache,
                block,
                std::future::pending(),
            ));
            assert!(futures::poll!(&mut owner).is_pending());
            let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
                panic!("duplicate")
            }));
            assert!(futures::poll!(&mut waiter).is_pending());
            drop(owner);
            assert_eq!(
                waiter.await.expect_err("cancel").code(),
                ContractErrorCode::Unavailable
            );
            assert!(cache.lock().pending.is_empty());
            let (tx, rx) = oneshot::channel();
            let mut late = Box::pin(cached_runtime_context(&cache, block, async {
                rx.await.expect("release");
                Ok(runtime_fixture(block, 1))
            }));
            assert!(futures::poll!(&mut late).is_pending());
            let mut stopped_waiter = Box::pin(cached_runtime_context(&cache, block, async {
                panic!("duplicate")
            }));
            assert!(futures::poll!(&mut stopped_waiter).is_pending());
            cache.lock().close();
            assert_eq!(
                stopped_waiter.await.expect_err("stop").code(),
                ContractErrorCode::NotReady
            );
            tx.send(()).expect("send");
            assert_eq!(
                late.await.expect_err("late").code(),
                ContractErrorCode::NotReady
            );
            assert!(cache.lock().ready.is_empty());
            assert!(
                cached_runtime_context(&cache, block, async { panic!("stopped") })
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn runtime_cache_waiter_cancel_preserves_owner_and_bounds_requests() {
        futures::executor::block_on(async {
            let cache = Mutex::new(RuntimeContexts::default());
            let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
            let (tx, rx) = oneshot::channel();
            let mut owner = Box::pin(cached_runtime_context(&cache, block, async {
                rx.await.expect("release");
                Ok(runtime_fixture(block, 1))
            }));
            assert!(futures::poll!(&mut owner).is_pending());
            let mut waiter = Box::pin(cached_runtime_context(&cache, block, async {
                panic!("duplicate")
            }));
            assert!(futures::poll!(&mut waiter).is_pending());
            drop(waiter);
            tx.send(()).expect("send");
            owner.await.expect("owner survives");
            for n in 0..=MAX_RUNTIME_CONTEXTS {
                let next =
                    VerifiedBlockRef::best(Hash32::from_bytes([(n + 2) as u8; 32]), n as u64);
                cached_runtime_context(&cache, next, async { Ok(runtime_fixture(next, 1)) })
                    .await
                    .expect("bounded insert");
            }
            assert_eq!(cache.lock().ready.len(), MAX_RUNTIME_CONTEXTS);
            assert!(cache.lock().bytes <= MAX_RUNTIME_CONTEXT_BYTES);
            let mut pending = RuntimeContexts::default();
            for n in 0..MAX_RUNTIME_CONTEXTS {
                let next = VerifiedBlockRef::best(Hash32::from_bytes([n as u8; 32]), n as u64);
                assert!(matches!(pending.begin(next), Ok(RuntimeContextRead::Fetch)));
            }
            let next = VerifiedBlockRef::best(Hash32::from_bytes([255; 32]), 255);
            assert!(pending.begin(next).is_err());
            let first = VerifiedBlockRef::best(Hash32::from_bytes([0; 32]), 0);
            let mut receivers = Vec::new();
            for _ in 0..MAX_RUNTIME_WAITERS {
                match pending.begin(first).expect("wait") {
                    RuntimeContextRead::Wait(receiver) => receivers.push(receiver),
                    _ => panic!("expected wait"),
                }
            }
            assert!(pending.begin(first).is_err());
            drop(receivers);
            assert!(matches!(
                pending.begin(first),
                Ok(RuntimeContextRead::Wait(_))
            ));
        });
    }

    /// 总字节淘汰与条数淘汰独立，不能让少量大metadata突破内存上限。
    #[test]
    fn runtime_cache_evicts_by_total_metadata_bytes() {
        let mut cache = RuntimeContexts::default();
        let size = MAX_RUNTIME_CONTEXT_BYTES / 2 + 1;
        for n in 0..2 {
            let block = VerifiedBlockRef::best(Hash32::from_bytes([n; 32]), u64::from(n));
            assert!(matches!(cache.begin(block), Ok(RuntimeContextRead::Fetch)));
            let context = RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), vec![1; size])
                .expect("large context");
            cache
                .complete(runtime_context_key(block), Ok(Arc::new(context)))
                .expect("cache insert");
        }
        assert_eq!(cache.ready.len(), 1);
        assert_eq!(cache.bytes, size);
    }

    #[test]
    fn runtime_snapshot_rejects_wrong_identity_and_empty_metadata() {
        let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
        for (hash, number, metadata) in [
            ([2; 32], 10, vec![1]),
            ([1; 32], 11, vec![1]),
            ([1; 32], 10, vec![]),
        ] {
            assert!(runtime_context_from_snapshot(
                block,
                ChainRuntimeContextSnapshot {
                    block_hash: hash,
                    block_number: number,
                    spec_version: 1,
                    transaction_version: 1,
                    metadata,
                }
            )
            .is_err());
        }
        futures::executor::block_on(async {
            let cache = Mutex::new(RuntimeContexts::default());
            let wrong = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 10);
            assert!(
                cached_runtime_context(&cache, block, async { Ok(runtime_fixture(wrong, 1)) })
                    .await
                    .is_err()
            );
            assert!(cache.lock().ready.is_empty());
        });
    }

    #[test]
    fn transaction_diagnostics_only_expose_fixed_categories() {
        // 成功分类、未知内容、伪装前缀和超长输入都不能透传任意描述。
        assert_eq!(
            transaction_invalid_category("Invalid transaction: Stale"),
            "invalid_stale"
        );
        assert_eq!(
            transaction_invalid_category("Invalid transaction: Payment"),
            "invalid_payment"
        );
        assert_eq!(
            transaction_invalid_category("Invalid transaction: Stale extra"),
            "invalid_other"
        );
        assert_eq!(transaction_invalid_category(""), "invalid_other");
        assert_eq!(
            transaction_invalid_category(&"x".repeat(4096)),
            "invalid_other"
        );
    }

    #[test]
    fn strict_hash_parser_rejects_wrong_width_and_prefix() {
        assert!(parse_hash_value(&json!(format!("0x{}", "11".repeat(32))), "hash").is_ok());
        assert!(parse_hash_value(&json!("11".repeat(32)), "hash").is_err());
        assert!(parse_hash_value(&json!(format!("0x{}", "11".repeat(31))), "hash").is_err());
    }

    #[test]
    fn number_parser_accepts_rpc_hex_and_json_numbers() {
        assert_eq!(parse_u64_value(&json!("0x2a"), "number").ok(), Some(42));
        assert_eq!(parse_u64_value(&json!(42), "number").ok(), Some(42));
    }

    #[test]
    fn scale_compact_u64_covers_all_substrate_modes() {
        assert_eq!(scale_compact_u64(0), [0]);
        assert_eq!(scale_compact_u64(63), [0xfc]);
        assert_eq!(scale_compact_u64(64), [0x01, 0x01]);
        assert_eq!(scale_compact_u64((1 << 14) - 1), [0xfd, 0xff]);
        assert_eq!(scale_compact_u64(1 << 14), [0x02, 0x00, 0x01, 0x00]);
        assert_eq!(scale_compact_u64(1 << 30), [0x03, 0x00, 0x00, 0x00, 0x40]);
        assert_eq!(
            scale_compact_u64(u64::MAX),
            [0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
        );
    }

    #[test]
    fn header_decoder_rebuilds_and_verifies_the_exact_scale_header_hash() {
        let parent = Hash32::from_bytes([1; 32]);
        let state = Hash32::from_bytes([2; 32]);
        let extrinsics = Hash32::from_bytes([3; 32]);
        let digest_log = vec![0x06, 0x42, 0x41, 0x42, 0x45];
        let mut encoded = Vec::new();
        encoded.extend_from_slice(parent.as_bytes());
        encoded.extend_from_slice(&scale_compact_u64(42));
        encoded.extend_from_slice(state.as_bytes());
        encoded.extend_from_slice(extrinsics.as_bytes());
        encoded.extend_from_slice(&scale_compact_u64(1));
        encoded.extend_from_slice(&digest_log);
        let block = VerifiedBlockRef::finalized(substrate_blake2_256(&encoded), 42);
        let value = json!({
            "number": "0x2a",
            "parentHash": hash_hex(parent),
            "stateRoot": hash_hex(state),
            "extrinsicsRoot": hash_hex(extrinsics),
            "digest": {"logs": [format!("0x{}", hex::encode(&digest_log))]},
        });
        let header = decode_verified_header(block, &value)
            .unwrap_or_else(|error| panic!("verified header failed: {error:?}"));
        assert_eq!(header.block(), block);
        assert_eq!(header.digest(), [scale_compact_u64(1), digest_log].concat());

        let wrong = VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 42);
        let error = decode_verified_header(wrong, &value)
            .err()
            .unwrap_or_else(|| panic!("wrong header hash must fail"));
        assert_eq!(error.code(), ContractErrorCode::Integrity);
    }

    #[test]
    fn current_storage_batch_routes_only_exact_matching_heads() {
        let best = VerifiedBlockRef::best(Hash32::from_bytes([0x11; 32]), 11);
        let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x09; 32]), 9);
        let heads = StorageBatchHeads {
            best,
            surface_finalized: finalized,
            verified_finalized: finalized,
        };
        assert_eq!(
            select_storage_batch_route(best, heads),
            StorageBatchRoute::CurrentBest
        );
        assert_eq!(
            select_storage_batch_route(finalized.verified(), heads),
            StorageBatchRoute::CurrentVerifiedFinalized
        );

        let historical = VerifiedBlockRef::finalized(Hash32::from_bytes([0x08; 32]), 8);
        assert_eq!(
            select_storage_batch_route(historical, heads),
            StorageBatchRoute::ExactHash
        );

        let warp_surface = StorageBatchHeads {
            surface_finalized: FinalizedBlockRef::from_parts(Hash32::from_bytes([0x0a; 32]), 10),
            ..heads
        };
        assert_eq!(
            select_storage_batch_route(finalized.verified(), warp_surface),
            StorageBatchRoute::ExactHash
        );
    }

    #[test]
    fn best_block_validation_uses_verified_heads_and_rejects_unproven_history() {
        let best = VerifiedBlockRef::best(Hash32::from_bytes([0x11; 32]), 11);
        let verified_finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x09; 32]), 9);
        let heads = StorageBatchHeads {
            best,
            // 表面 finalized 高度不能扩大可接受的历史 best 范围。
            surface_finalized: FinalizedBlockRef::from_parts(Hash32::from_bytes([0x0a; 32]), 10),
            verified_finalized,
        };
        assert_eq!(
            best_block_needs_finalized_proof(best, heads).ok(),
            Some(false)
        );
        let old_finalized = VerifiedBlockRef::best(verified_finalized.hash(), 9);
        assert_eq!(
            best_block_needs_finalized_proof(old_finalized, heads).ok(),
            Some(true)
        );
        // 高度已 finalized 但 hash 错误时仍必须交给 ancestry 核对，不能直接放行。
        let wrong_finalized = VerifiedBlockRef::best(Hash32::from_bytes([0xff; 32]), 9);
        assert_eq!(
            best_block_needs_finalized_proof(wrong_finalized, heads).ok(),
            Some(true)
        );
        for unproven in [
            VerifiedBlockRef::best(Hash32::from_bytes([0x0a; 32]), 10),
            VerifiedBlockRef::best(Hash32::from_bytes([0xff; 32]), 11),
            VerifiedBlockRef::best(Hash32::from_bytes([0x12; 32]), 12),
        ] {
            let error = best_block_needs_finalized_proof(unproven, heads)
                .err()
                .unwrap_or_else(|| panic!("unproven best block must fail"));
            assert_eq!(error.code(), ContractErrorCode::Conflict);
        }
    }

    #[test]
    fn historical_storage_params_always_carry_the_requested_exact_hash() {
        let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0xab; 32]), 42);
        let params = exact_storage_params(block, vec![0x01, 0x02]);
        assert_eq!(params, json!(["0x0102", format!("0x{}", "ab".repeat(32))]));
        assert!(validate_storage_keys(&[vec![0x01], vec![0x01]]).is_ok());
        let Err(error) = validate_storage_keys(&[vec![0x01], Vec::new()]) else {
            panic!("empty key in a batch must fail before native dispatch");
        };
        assert_eq!(error.code(), ContractErrorCode::InvalidArgument);
        assert!(validate_storage_batch_len(2, 2).is_ok());
        let Err(error) = validate_storage_batch_len(2, 1) else {
            panic!("typed batch length mismatch must fail closed");
        };
        assert_eq!(error.code(), ContractErrorCode::Integrity);

        let oversized_key = vec![0; MAX_STORAGE_KEY_BYTES + 1];
        assert!(validate_storage_keys(&[oversized_key]).is_err());
        let too_many = vec![vec![1]; MAX_STORAGE_BATCH_KEYS + 1];
        assert!(validate_storage_keys(&too_many).is_err());
        let too_large = vec![
            vec![1; MAX_STORAGE_KEY_BYTES];
            MAX_STORAGE_BATCH_KEY_BYTES / MAX_STORAGE_KEY_BYTES + 1
        ];
        assert!(validate_storage_keys(&too_large).is_err());
    }

    #[test]
    fn storage_key_pages_enforce_prefix_cursor_order_count_and_bytes() {
        assert!(validate_storage_keys_page_request(&[1], None, 1).is_ok());
        assert!(validate_storage_keys_page_request(
            &vec![1; MAX_STORAGE_KEY_BYTES],
            Some(&[1, 0]),
            MAX_STORAGE_KEYS_PAGE_LIMIT,
        )
        .is_ok());
        assert!(validate_storage_keys_page_request(&[], None, 1).is_err());
        assert!(validate_storage_keys_page_request(&[1], None, 0).is_err());
        assert!(
            validate_storage_keys_page_request(&[1], None, MAX_STORAGE_KEYS_PAGE_LIMIT + 1,)
                .is_err()
        );

        let page = json!(["0x0101", "0x0102"]);
        assert_eq!(
            parse_storage_keys_page(&page, &[1], None, 2).unwrap(),
            vec![vec![1, 1], vec![1, 2]],
        );
        let next_page = json!(["0x0102"]);
        assert_eq!(
            parse_storage_keys_page(&next_page, &[1], Some(&[1, 1]), 2).unwrap(),
            vec![vec![1, 2]],
        );
        assert!(
            parse_storage_keys_page(&page, &[1], Some(&[1, 1]), 2).is_err(),
            "排他 start_key 不能在下一页重复返回",
        );
        assert!(parse_storage_keys_page(&page, &[2], None, 2).is_err());
        assert!(parse_storage_keys_page(&json!(["0x0102", "0x0101"]), &[1], None, 2).is_err());
        assert!(parse_storage_keys_page(&page, &[1], None, 1).is_err());
    }

    #[test]
    fn runtime_api_request_is_bounded_opaque_and_requires_trait_method_shape() {
        assert!(validate_runtime_api_request("CitizenApi_items", &[]).is_ok());
        let longest = format!("A_{}", "b".repeat(MAX_RUNTIME_API_METHOD_BYTES - 2));
        let maximum_arguments = vec![0; MAX_RUNTIME_API_ARGUMENT_BYTES];
        assert!(validate_runtime_api_request(&longest, &maximum_arguments).is_ok());
        for invalid in ["", "CitizenApi", "_items", "CitizenApi-items"] {
            assert!(
                validate_runtime_api_request(invalid, &[]).is_err(),
                "{invalid}"
            );
        }
        assert!(validate_runtime_api_request(
            "CitizenApi_items",
            &vec![0; MAX_RUNTIME_API_ARGUMENT_BYTES + 1],
        )
        .is_err());
    }

    #[test]
    fn typed_storage_snapshot_must_identify_the_exact_requested_block() {
        let requested = VerifiedBlockRef::best(Hash32::from_bytes([0x11; 32]), 11);
        let matching = ChainStorageValuesSnapshot {
            block_number: 11,
            block_hash: [0x11; 32],
            values: vec![Some(vec![1]), None, Some(vec![1])],
        };
        assert!(storage_snapshot_matches_block(&matching, requested));
        assert_eq!(matching.values[0], matching.values[2]);

        // Models the dangerous middle observation in an A→B→A head sequence:
        // even if outer head samples both see A, values proved against B are
        // rejected and the caller must fall back to an exact-hash query for A.
        let observed_middle_block = ChainStorageValuesSnapshot {
            block_number: 12,
            block_hash: [0x22; 32],
            values: vec![Some(vec![2]), None, Some(vec![2])],
        };
        assert!(!storage_snapshot_matches_block(
            &observed_middle_block,
            requested
        ));

        let wrong_number = ChainStorageValuesSnapshot {
            block_number: 12,
            block_hash: [0x11; 32],
            values: matching.values.clone(),
        };
        assert!(!storage_snapshot_matches_block(&wrong_number, requested));
    }

    #[test]
    fn submitted_hash_uses_complete_extrinsic_blake2_256() {
        let extrinsic = [0x04, 0x01, 0x02, 0x03];
        let actual = substrate_blake2_256(&extrinsic);
        assert_eq!(
            hex::encode(actual.as_bytes()),
            "d1db84052dee9bd43d7a1c22a4349bab845afcb162da4807166309d92d3dfa40"
        );
        assert!(verify_submitted_hash(&extrinsic, actual).is_ok());
        let Err(error) = verify_submitted_hash(&extrinsic[1..], actual) else {
            panic!("hash calculated without the Compact length prefix must fail");
        };
        assert_eq!(error.code(), ContractErrorCode::Integrity);
    }

    #[test]
    fn finalized_batch_projection_requires_exact_bounds_length_and_order() {
        let snapshot = ChainFinalizedBlocksSnapshot {
            upper_block_number: 42,
            upper_block_hash: [0xaa; 32],
            blocks: vec![
                ChainFinalizedBlockSnapshot {
                    block_number: 40,
                    block_hash: [0x40; 32],
                },
                ChainFinalizedBlockSnapshot {
                    block_number: 41,
                    block_hash: [0x41; 32],
                },
            ],
        };
        let refs = finalized_refs_from_snapshot(snapshot.clone(), 40, 41)
            .unwrap_or_else(|error| panic!("valid batch: {error}"));
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].number(), 40);
        assert_eq!(refs[1].number(), 41);

        let mut partial = snapshot.clone();
        partial.blocks.pop();
        assert!(finalized_refs_from_snapshot(partial, 40, 41).is_err());

        let mut wrong_order = snapshot.clone();
        wrong_order.blocks.swap(0, 1);
        assert!(finalized_refs_from_snapshot(wrong_order, 40, 41).is_err());

        assert!(finalized_refs_from_snapshot(snapshot.clone(), 43, 42).is_err());
        assert!(finalized_refs_from_snapshot(snapshot, 41, 43).is_err());
    }

    #[test]
    fn ancestry_error_kinds_preserve_security_classification() {
        let cases = [
            (
                ChainFinalizedAncestryError::InvalidArgument("range".to_owned()),
                ContractErrorCode::InvalidArgument,
            ),
            (
                ChainFinalizedAncestryError::AboveVerifiedUpper("future".to_owned()),
                ContractErrorCode::NotFound,
            ),
            (
                ChainFinalizedAncestryError::Integrity("fork".to_owned()),
                ContractErrorCode::Integrity,
            ),
            (
                ChainFinalizedAncestryError::Unavailable("offline".to_owned()),
                ContractErrorCode::Network,
            ),
        ];
        for (source, expected) in cases {
            assert_eq!(finalized_ancestry_error(source).code(), expected);
        }
    }
}
