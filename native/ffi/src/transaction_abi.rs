//! 通用 opaque 交易准备、冷热执行、历史读取与安全结果复制的稳定 C ABI 边界。
//!
//! 原生句柄始终绑定单个 CitizenSDK 实例；只有安全摘要跨越 ABI，签名消息、签名和交易模板留在 Engine。

#[cfg(all(feature = "transactions", feature = "qr"))]
use std::future::Future;
use std::{
    collections::HashMap,
    ptr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
};

use citizen_sdk_contracts::{
    AccountId32, ContractErrorCode, ExecutionConclusion, HistoryTransactionStatus,
    PreparedTransactionSummary, TransactionExecutionId, TransactionExecutionResolution,
    TransactionHistoryRecord, TransactionPreparationId, MAX_TRANSACTION_CALL_DATA_BYTES,
    MAX_TRANSACTION_HISTORY_PAGE_SIZE,
};

use crate::{
    abi::{
        CitizenSdkAccountId, CitizenSdkBytesView, CitizenSdkErrorCode,
        CitizenSdkExternalSignerTransport, CitizenSdkHandle, CitizenSdkPreparedTransactionHandle,
        CitizenSdkPreparedTransactionInfo, CitizenSdkRequestId, CitizenSdkResultHandle,
        CitizenSdkTransactionExecutionId, CitizenSdkTransactionExecutionInfo,
        CitizenSdkTransactionExecutionStatus, CitizenSdkTransactionHistoryPageInfo,
        CitizenSdkTransactionHistoryRecordInfo, CitizenSdkTransactionHistoryStatus,
        CITIZENSDK_ABI_VERSION,
    },
    accept_and_write, accept_and_write_watch, block_to_abi, copy_to_host, copy_view,
    error::{FfiError, FfiResult},
    execution_to_abi, ffi_status, handles,
    ownership::{
        self, PreparedTransactionPayload, ResultPayload, TransactionExecutionPayload,
        TransactionExternalSigningPending,
    },
    require_output, validate_output_versioned, wrong_result,
};

#[derive(Clone, Copy, Debug)]
struct PreparedTransactionEntry {
    owner: CitizenSdkHandle,
    preparation_id: TransactionPreparationId,
    summary: PreparedTransactionSummary,
}

static NEXT_PREPARED_TRANSACTION: AtomicU64 = AtomicU64::new(1);
static PREPARED_TRANSACTIONS: OnceLock<
    Mutex<HashMap<CitizenSdkPreparedTransactionHandle, PreparedTransactionEntry>>,
> = OnceLock::new();

#[cfg(all(feature = "transactions", feature = "qr"))]
#[derive(Clone, Debug)]
struct ExternalExecutionEntry {
    owner: CitizenSdkHandle,
    session_id: String,
    attempt: u64,
    state: ExternalExecutionState,
}

/// One QR_V1 transaction execution moves monotonically through these ABI-owned states.
/// `AdmissionPending` closes the race between validation and bounded watch-pool admission;
/// `Active` keeps the long-lived request cancellable by the stable execution id.
#[cfg(all(feature = "transactions", feature = "qr"))]
#[derive(Clone, Debug)]
enum ExternalExecutionState {
    AwaitingResponse,
    AdmissionPending,
    Active {
        request_id: CitizenSdkRequestId,
        cancellation: citizen_sdk_engine::TransactionExecutionCancellation,
    },
}

#[cfg(all(feature = "transactions", feature = "qr"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExternalAttemptFinish { Retry, Terminal, Stale }

/// 只收口当前轮次；取消已移除条目时不能恢复，旧轮迟到时不能清掉新轮。
#[cfg(all(feature = "transactions", feature = "qr"))]
fn finish_external_execution_attempt(id: TransactionExecutionId, owner: CitizenSdkHandle,
    session_id: &str, attempt: u64, retry: bool) -> ExternalAttemptFinish {
    let Ok(mut entries) = lock_external_executions() else { return ExternalAttemptFinish::Stale; };
    let Some(entry) = entries.get_mut(&id) else { return ExternalAttemptFinish::Terminal; };
    if entry.owner != owner || entry.session_id != session_id || entry.attempt != attempt {
        return ExternalAttemptFinish::Stale;
    }
    if retry {
        entry.state = ExternalExecutionState::AwaitingResponse;
        ExternalAttemptFinish::Retry
    } else {
        entries.remove(&id);
        ExternalAttemptFinish::Terminal
    }
}

#[cfg(all(feature = "transactions", feature = "qr"))]
static EXTERNAL_EXECUTIONS: OnceLock<
    Mutex<HashMap<TransactionExecutionId, ExternalExecutionEntry>>,
> = OnceLock::new();

#[cfg(all(feature = "transactions", feature = "qr"))]
fn external_executions() -> &'static Mutex<HashMap<TransactionExecutionId, ExternalExecutionEntry>>
{
    EXTERNAL_EXECUTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(all(feature = "transactions", feature = "qr"))]
fn lock_external_executions(
) -> FfiResult<MutexGuard<'static, HashMap<TransactionExecutionId, ExternalExecutionEntry>>> {
    external_executions()
        .lock()
        .map_err(|_| FfiError::internal("transaction execution registry is poisoned"))
}

fn prepared_transactions(
) -> &'static Mutex<HashMap<CitizenSdkPreparedTransactionHandle, PreparedTransactionEntry>> {
    PREPARED_TRANSACTIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_prepared_transactions() -> FfiResult<
    MutexGuard<'static, HashMap<CitizenSdkPreparedTransactionHandle, PreparedTransactionEntry>>,
> {
    prepared_transactions()
        .lock()
        .map_err(|_| FfiError::internal("prepared transaction registry is poisoned"))
}

fn next_prepared_transaction_handle() -> FfiResult<CitizenSdkPreparedTransactionHandle> {
    NEXT_PREPARED_TRANSACTION
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_add(1).filter(|next| *next != 0)
        })
        .map_err(|_| FfiError::internal("prepared transaction handle space is exhausted"))
}

fn insert_prepared_transaction(
    owner: CitizenSdkHandle,
    summary: PreparedTransactionSummary,
) -> FfiResult<CitizenSdkPreparedTransactionHandle> {
    let handle = next_prepared_transaction_handle()?;
    let entry = PreparedTransactionEntry {
        owner,
        preparation_id: summary.preparation_id(),
        summary,
    };
    if lock_prepared_transactions()?
        .insert(handle, entry)
        .is_some()
    {
        return Err(FfiError::internal(
            "monotonic prepared transaction handle collided with an existing slot",
        ));
    }
    Ok(handle)
}

pub(crate) fn drop_prepared_for_owner(owner: CitizenSdkHandle) {
    let mut registry = prepared_transactions()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    registry.retain(|_, entry| entry.owner != owner);
    #[cfg(all(feature = "transactions", feature = "qr"))]
    if let Ok(mut executions) = lock_external_executions() {
        executions.retain(|_, entry| entry.owner != owner);
    }
}

#[no_mangle]
/// Accepts one bounded opaque SCALE RuntimeCall and prepares it against exact best-chain state.
///
/// # Safety
/// `source_account_id`, non-empty `call_data`, and `out_request_id` must remain readable/writable
/// for this accepting call. Input bytes are copied before asynchronous execution begins.
pub unsafe extern "C" fn citizensdk_prepare_transaction(
    handle: CitizenSdkHandle,
    source_account_id: *const CitizenSdkAccountId,
    call_data: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "transactions"))]
    {
        let _ = (handle, source_account_id, call_data, out_request_id);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含所需模块",
            ))
        })
    }
    #[cfg(feature = "transactions")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            if source_account_id.is_null() {
                return Err(FfiError::invalid("source_account_id is null"));
            }
            // SAFETY: null was rejected above and the caller contract keeps this fixed-size value
            // readable for the duration of the accepting call.
            let source_account_id = AccountId32::from_bytes(unsafe { (*source_account_id).bytes });
            let call_data = copy_view(
                call_data,
                "transaction callData",
                MAX_TRANSACTION_CALL_DATA_BYTES,
            )?;
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let summary = runtime.drive(
                    runtime
                        .engine()
                        .prepare_transaction(source_account_id, call_data),
                )??;
                let prepared_handle = match insert_prepared_transaction(runtime.handle(), summary) {
                    Ok(prepared_handle) => prepared_handle,
                    Err(error) => {
                        // Do not strand Engine-owned signer material if the ABI handle table cannot
                        // accept the corresponding owner-scoped handle.
                        let _ = runtime
                            .engine()
                            .cancel_prepared_transaction(summary.preparation_id());
                        return Err(error);
                    }
                };
                Ok(ResultPayload::PreparedTransaction(
                    PreparedTransactionPayload {
                        handle: prepared_handle,
                        summary,
                    },
                ))
            })
        })
    }
}

#[no_mangle]
/// Releases one instance-owned transaction preparation exactly once.
pub extern "C" fn citizensdk_prepared_transaction_release(
    handle: CitizenSdkHandle,
    prepared_transaction: CitizenSdkPreparedTransactionHandle,
) -> i32 {
    #[cfg(not(feature = "transactions"))]
    {
        let _ = (handle, prepared_transaction);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含所需模块",
            ))
        })
    }
    #[cfg(feature = "transactions")]
    {
        ffi_status(|| {
            if prepared_transaction == 0 {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::InvalidHandle,
                    "prepared transaction handle 0 is invalid",
                ));
            }
            let runtime = handles::get(handle)?;
            let mut registry = lock_prepared_transactions()?;
            let entry = registry.remove(&prepared_transaction).ok_or_else(|| {
                FfiError::new(
                    CitizenSdkErrorCode::InvalidHandle,
                    "prepared transaction is unknown or already released",
                )
            })?;
            if entry.owner != handle {
                registry.insert(prepared_transaction, entry);
                return Err(FfiError::new(
                    CitizenSdkErrorCode::InvalidHandle,
                    "prepared transaction belongs to another CitizenSDK instance",
                ));
            }
            match runtime
                .engine()
                .cancel_prepared_transaction(entry.preparation_id)
            {
                Ok(()) => Ok(()),
                Err(citizen_sdk_engine::EngineError::Contract(error))
                    if error.code() == ContractErrorCode::NotFound =>
                {
                    // stop/close already invalidated the Engine entry; the ABI handle still closes once.
                    Ok(())
                }
                Err(error) => {
                    registry.insert(prepared_transaction, entry);
                    Err(FfiError::from(error))
                }
            }
        })
    }
}

#[no_mangle]
/// Consumes one prepared handle and completes hot signing or creates one bound QR_V1 execution.
pub unsafe extern "C" fn citizensdk_execute_prepared_transaction(
    handle: CitizenSdkHandle,
    prepared_transaction: CitizenSdkPreparedTransactionHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "transactions"))]
    {
        let _ = (handle, prepared_transaction, out_request_id);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含交易模块",
            ))
        })
    }
    #[cfg(feature = "transactions")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            {
                let registry = lock_prepared_transactions()?;
                let entry = registry.get(&prepared_transaction).ok_or_else(|| {
                    FfiError::new(
                        CitizenSdkErrorCode::InvalidHandle,
                        "prepared transaction 已消费或不存在",
                    )
                })?;
                if entry.owner != handle {
                    return Err(FfiError::new(
                        CitizenSdkErrorCode::InvalidHandle,
                        "prepared transaction 属于另一实例",
                    ));
                }
            }
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                // A rejected queue admission must not consume the preparation. Consumption occurs
                // inside the admitted job and therefore remains exactly-once under racing callers.
                let entry = {
                    let mut registry = lock_prepared_transactions()?;
                    let entry = registry.remove(&prepared_transaction).ok_or_else(|| {
                        FfiError::new(
                            CitizenSdkErrorCode::InvalidHandle,
                            "prepared transaction 已消费或不存在",
                        )
                    })?;
                    if entry.owner != runtime.handle() {
                        registry.insert(prepared_transaction, entry);
                        return Err(FfiError::new(
                            CitizenSdkErrorCode::InvalidHandle,
                            "prepared transaction 属于另一实例",
                        ));
                    }
                    entry
                };
                runtime.refresh_provider_capabilities()?;
                let start = match runtime.drive(
                    runtime
                        .engine()
                        .execute_prepared_transaction(entry.preparation_id),
                )? {
                    Ok(start) => start,
                    Err(error) => {
                        let _ = runtime
                            .engine()
                            .cancel_prepared_transaction(entry.preparation_id);
                        return Err(FfiError::from(error));
                    }
                };
                match start {
                    citizen_sdk_engine::TransactionExecutionStart::Completed(completed) => {
                        Ok(ResultPayload::TransactionExecution(
                            TransactionExecutionPayload::Completed(completed),
                        ))
                    }
                    citizen_sdk_engine::TransactionExecutionStart::ExternalSigning {
                        execution_id,
                        source_account_id,
                        call_data_hash,
                        action,
                        intent,
                    } => {
                        #[cfg(not(feature = "qr"))]
                        {
                            let _ = (source_account_id, call_data_hash, action, intent);
                            let _ = runtime.engine().cancel_transaction_execution(execution_id);
                            Err(FfiError::new(
                                CitizenSdkErrorCode::Unsupported,
                                "当前构建不包含 QR_V1",
                            ))
                        }
                        #[cfg(feature = "qr")]
                        {
                            let external = match crate::qr_abi::create_external_qr_session(
                                runtime.handle(),
                                action,
                                &intent,
                                120,
                            ) {
                                Ok(external) => external,
                                Err(error) => {
                                    let _ =
                                        runtime.engine().cancel_transaction_execution(execution_id);
                                    return Err(error);
                                }
                            };
                            let registry_entry = ExternalExecutionEntry {
                                owner: runtime.handle(),
                                session_id: external.session_id.clone(),
                                attempt: 0,
                                state: ExternalExecutionState::AwaitingResponse,
                            };
                            if lock_external_executions()?
                                .insert(execution_id, registry_entry)
                                .is_some()
                            {
                                let _ = crate::qr_abi::cancel_unified_signing_session(
                                    runtime.handle(),
                                    &external.session_id,
                                );
                                let _ = runtime.engine().cancel_transaction_execution(execution_id);
                                return Err(FfiError::internal(
                                    "transaction execution id registry collision",
                                ));
                            }
                            Ok(ResultPayload::TransactionExecution(
                                TransactionExecutionPayload::ExternalPending(
                                    TransactionExternalSigningPending {
                                        execution_id,
                                        source_account_id,
                                        call_data_hash,
                                        external,
                                    },
                                ),
                            ))
                        }
                    }
                }
            })
        })
    }
}

#[no_mangle]
/// Consumes the exact QR_V1 response bound to one cold transaction execution.
pub unsafe extern "C" fn citizensdk_transaction_execution_consume_qr_response(
    handle: CitizenSdkHandle,
    execution_id: *const CitizenSdkTransactionExecutionId,
    response: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(all(feature = "transactions", feature = "qr")))]
    {
        let _ = (handle, execution_id, response, out_request_id);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含交易 QR_V1",
            ))
        })
    }
    #[cfg(all(feature = "transactions", feature = "qr"))]
    {
        ffi_status(|| {
            require_output(out_request_id, "out_request_id")?;
            if execution_id.is_null() {
                return Err(FfiError::invalid("execution_id is null"));
            }
            let id = TransactionExecutionId::try_new((*execution_id).bytes)?;
            let response = String::from_utf8(copy_view(
                response,
                "QR_V1 response",
                citizen_sdk_qr::MAX_QR_TEXT_BYTES,
            )?)
            .map_err(|_| FfiError::invalid("QR_V1 response 必须是 UTF-8"))?;
            let runtime = handles::get(handle)?;
            let (session_id, attempt) = {
                let mut entries = lock_external_executions()?;
                let entry = entries.get_mut(&id).ok_or_else(|| {
                    FfiError::new(
                        CitizenSdkErrorCode::InvalidHandle,
                        "transaction execution 不存在或已消费",
                    )
                })?;
                if entry.owner != handle {
                    return Err(FfiError::new(
                        CitizenSdkErrorCode::InvalidHandle,
                        "transaction execution 属于另一实例",
                    ));
                }
                if !matches!(entry.state, ExternalExecutionState::AwaitingResponse) {
                    return Err(FfiError::new(
                        CitizenSdkErrorCode::Conflict,
                        "transaction execution 已在消费或观察",
                    ));
                }
                entry.attempt = entry.attempt.checked_add(1).ok_or_else(|| FfiError::internal("回扫尝试编号已耗尽"))?;
                entry.state = ExternalExecutionState::AdmissionPending;
                (entry.session_id.clone(), entry.attempt)
            };

            let execution_cancellation =
                citizen_sdk_engine::TransactionExecutionCancellation::default();
            let worker_cancellation = execution_cancellation.clone();
            let worker_session_id = session_id.clone();
            let mut request_id = 0;
            // Cold completion can wait until a proven terminal block. It belongs to the bounded
            // watch pool, not the short-operation workers needed by lifecycle and finite reads.
            let admission = accept_and_write_watch(
                runtime.clone(),
                &mut request_id,
                move |runtime, _, request_cancellation| {
                    let mut cancellation = request_cancellation;
                    let mut signature_accepted = false;
                    let outcome = (|| {
                        if worker_cancellation.is_cancelled() {
                            return Err(FfiError::new(CitizenSdkErrorCode::Cancelled, "交易回扫已取消"));
                        }
                        let receiver = cancellation.as_mut().ok_or_else(|| FfiError::internal("交易取消通道缺失"))?;
                        if !matches!(receiver.try_recv(), Ok(None)) {
                            worker_cancellation.cancel();
                            return Err(FfiError::new(CitizenSdkErrorCode::Cancelled, "交易回扫已取消"));
                        }
                        let completion = crate::qr_abi::consume_external_qr_session(
                            runtime.handle(),
                            &worker_session_id,
                            &response,
                        )?;
                        signature_accepted = true;
                        let request_cancellation = cancellation.take().ok_or_else(|| {
                            FfiError::internal(
                                "transaction execution cancellation channel is missing",
                            )
                        })?;
                        let completed = runtime.drive(transaction_execution_or_cancellation(
                            runtime.engine().complete_external_transaction_execution(
                                id,
                                completion.signature(),
                                worker_cancellation.clone(),
                            ),
                            request_cancellation,
                            worker_cancellation.clone(),
                        ))??;
                        Ok(ResultPayload::TransactionExecution(
                            TransactionExecutionPayload::Completed(completed),
                        ))
                    })();
                    if cancellation.as_mut().is_some_and(|receiver| !matches!(receiver.try_recv(), Ok(None))) {
                        worker_cancellation.cancel();
                    }
                    // 错码/错签名只结束本次请求，原请求仍有效时允许重扫；实际过期、取消和
                    // 正确签名是终态。时钟暂不可用不等于过期，不擅自删除仍未消费的请求。
                    let retry = !signature_accepted && !worker_cancellation.is_cancelled()
                        && crate::qr_abi::external_qr_session_pending(runtime.handle(), &worker_session_id).unwrap_or(true);
                    let finish = finish_external_execution_attempt(id, runtime.handle(), &worker_session_id, attempt, retry);
                    if finish == ExternalAttemptFinish::Terminal && (!signature_accepted || outcome.is_err()) {
                        let _ = crate::qr_abi::cancel_unified_signing_session(runtime.handle(), &worker_session_id);
                        let _ = runtime.engine().cancel_transaction_execution(id);
                    }
                    outcome
                },
            );
            if let Err(error) = admission {
                if let Some(entry) = lock_external_executions()?.get_mut(&id) {
                    if entry.owner == handle
                        && entry.session_id == session_id
                        && entry.attempt == attempt
                        && matches!(entry.state, ExternalExecutionState::AdmissionPending)
                    {
                        entry.state = ExternalExecutionState::AwaitingResponse;
                    }
                }
                return Err(error);
            }

            // 工作线程可能已经返回可重扫结果，甚至新一轮已接纳；旧轮绝不能覆盖新轮状态。
            // 接纳已成功时必须交付原request_id，不能因后置登记变化而藏掉真实请求。
            if let Ok(mut entries) = lock_external_executions() {
                if let Some(entry) = entries.get_mut(&id) {
                    if entry.owner == handle && entry.session_id == session_id && entry.attempt == attempt
                        && matches!(entry.state, ExternalExecutionState::AdmissionPending) {
                        entry.state = ExternalExecutionState::Active { request_id, cancellation: execution_cancellation };
                    }
                }
            }
            ptr::write(out_request_id, request_id);
            Ok(())
        })
    }
}

#[no_mangle]
/// Cancels one not-yet-broadcast cold execution and its QR_V1 session.
pub unsafe extern "C" fn citizensdk_transaction_execution_cancel(
    handle: CitizenSdkHandle,
    execution_id: *const CitizenSdkTransactionExecutionId,
) -> i32 {
    #[cfg(not(all(feature = "transactions", feature = "qr")))]
    {
        let _ = (handle, execution_id);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含交易 QR_V1",
            ))
        })
    }
    #[cfg(all(feature = "transactions", feature = "qr"))]
    {
        ffi_status(|| {
            if execution_id.is_null() {
                return Err(FfiError::invalid("execution_id is null"));
            }
            let id = TransactionExecutionId::try_new((*execution_id).bytes)?;
            let runtime = handles::get(handle)?;
            let entry = {
                let mut entries = lock_external_executions()?;
                let entry = entries.get(&id).ok_or_else(|| {
                    FfiError::new(
                        CitizenSdkErrorCode::InvalidHandle,
                        "transaction execution 不存在或已消费",
                    )
                })?;
                if entry.owner != handle {
                    return Err(FfiError::new(
                        CitizenSdkErrorCode::InvalidHandle,
                        "transaction execution 属于另一实例",
                    ));
                }
                if matches!(entry.state, ExternalExecutionState::AdmissionPending) {
                    return Err(FfiError::new(
                        CitizenSdkErrorCode::Conflict,
                        "transaction execution 正在接受响应",
                    ));
                }
                entries.remove(&id).ok_or_else(|| {
                    FfiError::internal("transaction execution disappeared while locked")
                })?
            };
            match entry.state {
                ExternalExecutionState::AwaitingResponse => {
                    crate::qr_abi::cancel_unified_signing_session(handle, &entry.session_id)?;
                    runtime.engine().cancel_transaction_execution(id)?;
                }
                ExternalExecutionState::Active {
                    request_id,
                    cancellation,
                } => {
                    cancellation.cancel();
                    if let Err(error) = runtime.request_cancel(request_id) {
                        // Completion may have won the race after registry removal. The Engine
                        // token remains cancelled and no further provider operation can start.
                        if error.code != CitizenSdkErrorCode::NotFound {
                            return Err(error);
                        }
                    }
                }
                ExternalExecutionState::AdmissionPending => unreachable!("checked while locked"),
            }
            Ok(())
        })
    }
}

/// Cooperatively cancels one admitted cold transaction execution and then drains the same Engine
/// future. An already-entered host CAS is therefore allowed to return before request ownership is
/// released, while the Engine token prevents a later provider read or broadcast.
#[cfg(all(feature = "transactions", feature = "qr"))]
async fn transaction_execution_or_cancellation<F>(
    execution: F,
    cancellation: crate::requests::RequestCancellation,
    execution_cancellation: citizen_sdk_engine::TransactionExecutionCancellation,
) -> FfiResult<citizen_sdk_contracts::TransactionExecutionCompleted>
where
    F: Future<
        Output = Result<
            citizen_sdk_contracts::TransactionExecutionCompleted,
            citizen_sdk_engine::EngineError,
        >,
    >,
{
    use futures_util::FutureExt;

    let execution = execution.fuse();
    let cancellation = cancellation.fuse();
    futures_util::pin_mut!(execution, cancellation);
    futures_util::select_biased! {
        _ = cancellation => {
            execution_cancellation.cancel();
            // Do not drop an Engine future that may own an in-flight store operation.
            let _ = execution.await;
            Err(FfiError::new(
                CitizenSdkErrorCode::Cancelled,
                "transaction execution was cancelled after draining; durable pending/in-block facts were retained",
            ))
        },
        result = execution => result.map_err(FfiError::from),
    }
}

#[no_mangle]
/// Reads one deterministic page of product-independent SDK transaction facts.
/// A null cursor starts at the newest record; a non-null cursor is exclusive.
///
/// # Safety
/// `before_execution_id`, when non-null, must be readable for 16 bytes and
/// `out_request_id` must be writable for the accepting call.
pub unsafe extern "C" fn citizensdk_get_transaction_history(
    handle: CitizenSdkHandle,
    before_execution_id: *const CitizenSdkTransactionExecutionId,
    limit: u32,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "history"))]
    {
        let _ = (handle, before_execution_id, limit, out_request_id);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含交易历史模块",
            ))
        })
    }
    #[cfg(feature = "history")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            let before = if before_execution_id.is_null() {
                None
            } else {
                Some(TransactionExecutionId::try_new(
                    (*before_execution_id).bytes,
                )?)
            };
            let limit = usize::try_from(limit)
                .map_err(|_| FfiError::invalid("transaction history limit is too large"))?;
            if !(1..=MAX_TRANSACTION_HISTORY_PAGE_SIZE).contains(&limit) {
                return Err(FfiError::invalid(
                    "transaction history limit must be within 1..100",
                ));
            }
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                let page =
                    runtime.drive(runtime.engine().get_transaction_history(before, limit))??;
                Ok(ResultPayload::TransactionHistoryPage(page))
            })
        })
    }
}

#[no_mangle]
/// Reconciles a bounded batch of SDK-submitted executions and returns the
/// newest public page. It never scans accounts or decodes application events.
///
/// # Safety
/// `out_request_id` must be writable for the accepting call.
pub unsafe extern "C" fn citizensdk_sync_transaction_history(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "history"))]
    {
        let _ = (handle, out_request_id);
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "当前构建不包含交易历史模块",
            ))
        })
    }
    #[cfg(feature = "history")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let _ = runtime.drive(runtime.engine().sync_transaction_history())??;
                let page = runtime.drive(
                    runtime
                        .engine()
                        .get_transaction_history(None, MAX_TRANSACTION_HISTORY_PAGE_SIZE),
                )??;
                Ok(ResultPayload::TransactionHistoryPage(page))
            })
        })
    }
}

#[no_mangle]
/// Copies the safe summary and independently-owned prepared handle from a completion result.
///
/// # Safety
/// `out_info` must contain the supported ABI prefix and be writable.
pub unsafe extern "C" fn citizensdk_result_get_prepared_transaction(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkPreparedTransactionInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "prepared transaction info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::PreparedTransaction(payload) = owned.payload else {
            return Err(wrong_result("prepared transaction"));
        };
        let entry = lock_prepared_transactions()?
            .get(&payload.handle)
            .copied()
            .ok_or_else(|| {
                FfiError::new(
                    CitizenSdkErrorCode::InvalidHandle,
                    "prepared transaction result refers to a released handle",
                )
            })?;
        if entry.owner != owned.owner || entry.summary != payload.summary {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Integrity,
                "prepared transaction result does not match its registry entry",
            ));
        }
        let summary = payload.summary;
        ptr::write(
            out_info,
            CitizenSdkPreparedTransactionInfo {
                struct_size: std::mem::size_of::<CitizenSdkPreparedTransactionInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                prepared_transaction: payload.handle,
                preparation_id: summary.preparation_id().into_bytes(),
                source_account_id: CitizenSdkAccountId {
                    bytes: summary.source_account_id().into_bytes(),
                },
                call_data_hash: summary.call_data_hash().into_bytes(),
                best_block: block_to_abi(summary.best_block()),
                runtime_spec_number: summary.runtime_version().spec_version(),
                transaction_format_number: summary.runtime_version().transaction_version(),
                nonce: summary.nonce(),
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Copies the fixed header of a generic transaction-history page.
///
/// # Safety
/// `out_info` must contain a supported ABI prefix and be writable.
pub unsafe extern "C" fn citizensdk_result_get_transaction_history_page(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkTransactionHistoryPageInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "transaction history page info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::TransactionHistoryPage(page) = owned.payload else {
            return Err(wrong_result("transaction history page"));
        };
        let next = page.next_before_execution_id();
        ptr::write(
            out_info,
            CitizenSdkTransactionHistoryPageInfo {
                revision: page.revision(),
                record_count: u32::try_from(page.records().len())
                    .map_err(|_| FfiError::internal("transaction history count exceeds u32"))?,
                has_next_before_execution_id: u32::from(next.is_some()),
                next_before_execution_id: CitizenSdkTransactionExecutionId {
                    bytes: next.map_or([0; 16], TransactionExecutionId::into_bytes),
                },
                ..CitizenSdkTransactionHistoryPageInfo::default()
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Copies one safe generic history record plus its optional pool-rejection text.
/// Recovery-only callData, extrinsic bytes and nonce are deliberately absent.
///
/// # Safety
/// Every output pointer follows the documented CitizenSDK copy contract.
pub unsafe extern "C" fn citizensdk_result_get_transaction_history_record(
    result: CitizenSdkResultHandle,
    index: u32,
    out_info: *mut CitizenSdkTransactionHistoryRecordInfo,
    reason_buffer: *mut u8,
    reason_capacity: u64,
    out_reason_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "transaction history record info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::TransactionHistoryPage(page) = owned.payload else {
            return Err(wrong_result("transaction history page"));
        };
        let record = page
            .records()
            .get(index as usize)
            .ok_or_else(|| FfiError::invalid("transaction history record index is out of range"))?;
        let (status, block, execution, reason, replacement_hash) =
            transaction_history_status(record)?;
        copy_to_host(
            reason.as_bytes(),
            reason_buffer,
            reason_capacity,
            out_reason_required,
        )?;
        ptr::write(
            out_info,
            CitizenSdkTransactionHistoryRecordInfo {
                execution_id: CitizenSdkTransactionExecutionId {
                    bytes: record.execution_id().into_bytes(),
                },
                source_account_id: CitizenSdkAccountId {
                    bytes: record.source_account_id().into_bytes(),
                },
                call_data_hash: record.call_data_hash().into_bytes(),
                transaction_hash: record.transaction_hash().into_bytes(),
                status,
                has_block: u32::from(block.is_some()),
                block: block.map(block_to_abi).unwrap_or_default(),
                has_execution: u32::from(execution.is_some()),
                has_replacement_hash: u32::from(replacement_hash.is_some()),
                execution: execution
                    .as_ref()
                    .map(execution_to_abi)
                    .unwrap_or_else(|| CitizenSdkTransactionHistoryRecordInfo::default().execution),
                replacement_hash: replacement_hash
                    .map_or([0; 32], citizen_sdk_contracts::Hash32::into_bytes),
                created_at_millis: record.created_at_millis(),
                updated_at_millis: record.updated_at_millis(),
                pool_rejection_reason_len: reason.len() as u64,
                ..CitizenSdkTransactionHistoryRecordInfo::default()
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Atomically copies the safe transaction execution projection and its bounded text fields.
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn citizensdk_result_get_transaction_execution(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkTransactionExecutionInfo,
    session_id_buffer: *mut u8,
    session_id_capacity: u64,
    out_session_id_required: *mut u64,
    transport_request_buffer: *mut u8,
    transport_request_capacity: u64,
    out_transport_request_required: *mut u64,
    reason_buffer: *mut u8,
    reason_capacity: u64,
    out_reason_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "transaction execution info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::TransactionExecution(execution) = &owned.payload else {
            return Err(wrong_result("transaction execution"));
        };
        let (info, session, request, reason) = transaction_execution_info(execution)?;
        copy_three_atomic(
            session,
            session_id_buffer,
            session_id_capacity,
            out_session_id_required,
            request,
            transport_request_buffer,
            transport_request_capacity,
            out_transport_request_required,
            reason,
            reason_buffer,
            reason_capacity,
            out_reason_required,
        )?;
        ptr::write(out_info, info);
        Ok(())
    })
}

type TransactionHistoryStatusProjection<'a> = (
    u32,
    Option<citizen_sdk_contracts::VerifiedBlockRef>,
    Option<ExecutionConclusion>,
    &'a str,
    Option<citizen_sdk_contracts::Hash32>,
);

fn transaction_history_status(
    record: &TransactionHistoryRecord,
) -> FfiResult<TransactionHistoryStatusProjection<'_>> {
    match record.status() {
        HistoryTransactionStatus::Pending => Ok((
            CitizenSdkTransactionHistoryStatus::Pending as u32,
            None,
            None,
            "",
            None,
        )),
        HistoryTransactionStatus::InBlock { block } => Ok((
            CitizenSdkTransactionHistoryStatus::InBlock as u32,
            Some(*block),
            None,
            "",
            None,
        )),
        HistoryTransactionStatus::PoolRejected {
            reason,
            replacement_hash,
        } => Ok((
            CitizenSdkTransactionHistoryStatus::PoolRejected as u32,
            None,
            None,
            reason,
            *replacement_hash,
        )),
        HistoryTransactionStatus::Execution(
            conclusion @ ExecutionConclusion::Success { block, .. },
        ) => Ok((
            CitizenSdkTransactionHistoryStatus::FinalizedSuccess as u32,
            Some(*block),
            Some(conclusion.clone()),
            "",
            None,
        )),
        HistoryTransactionStatus::Execution(
            conclusion @ ExecutionConclusion::Failed { block, .. },
        ) => Ok((
            CitizenSdkTransactionHistoryStatus::FinalizedFailed as u32,
            Some(*block),
            Some(conclusion.clone()),
            "",
            None,
        )),
        HistoryTransactionStatus::Execution(ExecutionConclusion::Unverified { .. }) => {
            Err(FfiError::new(
                CitizenSdkErrorCode::Integrity,
                "persisted transaction history contains an unverified execution",
            ))
        }
    }
}

type TransactionExecutionInfo<'a> = (
    CitizenSdkTransactionExecutionInfo,
    &'a [u8],
    &'a [u8],
    &'a [u8],
);

fn transaction_execution_info(
    execution: &TransactionExecutionPayload,
) -> FfiResult<TransactionExecutionInfo<'_>> {
    match execution {
        TransactionExecutionPayload::ExternalPending(pending) => Ok((
            CitizenSdkTransactionExecutionInfo {
                status: CitizenSdkTransactionExecutionStatus::ExternalPending as u32,
                transport: CitizenSdkExternalSignerTransport::QrV1 as u32,
                execution_id: pending.execution_id.into_bytes(),
                source_account_id: CitizenSdkAccountId {
                    bytes: pending.source_account_id.into_bytes(),
                },
                call_data_hash: pending.call_data_hash.into_bytes(),
                expires_at: pending.external.expires_at,
                session_id_len: pending.external.session_id.len() as u64,
                transport_request_len: pending.external.transport_request.len() as u64,
                ..CitizenSdkTransactionExecutionInfo::default()
            },
            pending.external.session_id.as_bytes(),
            pending.external.transport_request.as_bytes(),
            &[],
        )),
        TransactionExecutionPayload::Completed(completed) => {
            let mut info = CitizenSdkTransactionExecutionInfo {
                execution_id: completed.execution_id().into_bytes(),
                source_account_id: CitizenSdkAccountId {
                    bytes: completed.source_account_id().into_bytes(),
                },
                call_data_hash: completed.call_data_hash().into_bytes(),
                transaction_hash: completed.transaction_hash().into_bytes(),
                ..CitizenSdkTransactionExecutionInfo::default()
            };
            let reason = match completed.resolution() {
                TransactionExecutionResolution::Finalized(conclusion) => {
                    let (status, block, index, failure) = match conclusion {
                        ExecutionConclusion::Success {
                            block,
                            extrinsic_index,
                        } => (
                            CitizenSdkTransactionExecutionStatus::FinalizedSuccess,
                            *block,
                            *extrinsic_index,
                            None,
                        ),
                        ExecutionConclusion::Failed {
                            block,
                            extrinsic_index,
                            failure,
                        } => (
                            CitizenSdkTransactionExecutionStatus::FinalizedFailed,
                            *block,
                            *extrinsic_index,
                            Some(failure),
                        ),
                        ExecutionConclusion::Unverified { .. } => {
                            return Err(FfiError::new(
                                CitizenSdkErrorCode::Integrity,
                                "unverified execution cannot cross ABI",
                            ));
                        }
                    };
                    info.status = status as u32;
                    info.has_block = 1;
                    info.has_extrinsic_index = 1;
                    info.block = block_to_abi(block);
                    info.extrinsic_index = index;
                    if let Some(failure) = failure {
                        info.has_dispatch_failure = 1;
                        info.dispatch_variant = u32::from(failure.variant());
                        if let Some(module) = failure.module() {
                            info.has_module_failure = 1;
                            info.pallet_index = u32::from(module.pallet_index());
                            info.error_index = u32::from(module.error_index());
                        }
                    }
                    &[][..]
                }
                TransactionExecutionResolution::PoolRejected {
                    reason,
                    replacement_hash,
                } => {
                    info.status = CitizenSdkTransactionExecutionStatus::PoolRejected as u32;
                    info.pool_rejection_reason_len = reason.len() as u64;
                    if let Some(hash) = replacement_hash {
                        info.has_replacement_hash = 1;
                        info.replacement_hash = hash.into_bytes();
                    }
                    reason.as_bytes()
                }
            };
            Ok((info, &[], &[], reason))
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn copy_three_atomic(
    first: &[u8],
    first_buffer: *mut u8,
    first_capacity: u64,
    first_required: *mut u64,
    second: &[u8],
    second_buffer: *mut u8,
    second_capacity: u64,
    second_required: *mut u64,
    third: &[u8],
    third_buffer: *mut u8,
    third_capacity: u64,
    third_required: *mut u64,
) -> FfiResult<()> {
    require_output(first_required, "session_id_required")?;
    require_output(second_required, "transport_request_required")?;
    require_output(third_required, "reason_required")?;
    for (bytes, buffer, capacity, name) in [
        (first, first_buffer, first_capacity, "session_id"),
        (second, second_buffer, second_capacity, "transport_request"),
        (third, third_buffer, third_capacity, "reason"),
    ] {
        let capacity = usize::try_from(capacity)
            .map_err(|_| FfiError::invalid(format!("{name} capacity too large")))?;
        if !bytes.is_empty()
            && (buffer.is_null() && capacity != 0 || !buffer.is_null() && capacity < bytes.len())
        {
            return Err(FfiError::invalid(format!("{name} buffer is too small")));
        }
    }
    ptr::write(first_required, first.len() as u64);
    ptr::write(second_required, second.len() as u64);
    ptr::write(third_required, third.len() as u64);
    if !first.is_empty() && !first_buffer.is_null() {
        ptr::copy_nonoverlapping(first.as_ptr(), first_buffer, first.len());
    }
    if !second.is_empty() && !second_buffer.is_null() {
        ptr::copy_nonoverlapping(second.as_ptr(), second_buffer, second.len());
    }
    if !third.is_empty() && !third_buffer.is_null() {
        ptr::copy_nonoverlapping(third.as_ptr(), third_buffer, third.len());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use citizen_sdk_contracts::{
        ExecutionConclusion, Hash32, RuntimeVersion, TransactionExecutionCompleted,
        TransactionExecutionResolution, VerifiedBlockRef,
    };

    fn summary(seed: u8) -> PreparedTransactionSummary {
        PreparedTransactionSummary::try_new(
            TransactionPreparationId::try_new([seed; 16]).expect("preparation id"),
            AccountId32::from_bytes([seed; 32]),
            Hash32::from_bytes([seed.wrapping_add(1); 32]),
            VerifiedBlockRef::best(Hash32::from_bytes([seed.wrapping_add(2); 32]), 42),
            RuntimeVersion::new(7, 9),
            11,
        )
        .expect("summary")
    }

    #[cfg(all(feature = "transactions", feature = "qr"))]
    #[test]
    fn response_retry_is_owner_and_attempt_scoped_and_cancel_cannot_be_resurrected() {
        let id = TransactionExecutionId::try_new([0xe7; 16]).unwrap();
        let owner = u64::MAX - 111;
        lock_external_executions().unwrap().insert(id, ExternalExecutionEntry {
            owner, session_id: "synthetic-session".into(), attempt: 2,
            state: ExternalExecutionState::AdmissionPending,
        });
        assert_eq!(finish_external_execution_attempt(id, owner, "synthetic-session", 1, false), ExternalAttemptFinish::Stale);
        assert_eq!(finish_external_execution_attempt(id, owner + 1, "synthetic-session", 2, true), ExternalAttemptFinish::Stale);
        assert_eq!(finish_external_execution_attempt(id, owner, "synthetic-session", 2, true), ExternalAttemptFinish::Retry);
        assert!(matches!(lock_external_executions().unwrap().get(&id).unwrap().state, ExternalExecutionState::AwaitingResponse));
        lock_external_executions().unwrap().remove(&id);
        assert_eq!(finish_external_execution_attempt(id, owner, "synthetic-session", 2, true), ExternalAttemptFinish::Terminal);
        assert!(!lock_external_executions().unwrap().contains_key(&id));
    }

    #[test]
    fn handles_are_monotonic_owner_scoped_and_destroy_cleanup_is_exact() {
        let owner = u64::MAX - 100;
        let first = insert_prepared_transaction(owner, summary(1)).expect("first handle");
        let second = insert_prepared_transaction(owner, summary(2)).expect("second handle");
        assert_ne!(first, 0);
        assert!(second > first);
        assert_eq!(
            lock_prepared_transactions()
                .expect("registry")
                .get(&first)
                .expect("first entry")
                .owner,
            owner
        );
        drop_prepared_for_owner(owner);
        let registry = lock_prepared_transactions().expect("registry after cleanup");
        assert!(!registry.contains_key(&first));
        assert!(!registry.contains_key(&second));
    }

    #[test]
    fn transaction_execution_projection_is_a_closed_safe_union() {
        let execution_id = TransactionExecutionId::try_new([1; 16]).expect("execution id");
        let source = AccountId32::from_bytes([2; 32]);
        let call_hash = Hash32::from_bytes([3; 32]);
        let pending =
            TransactionExecutionPayload::ExternalPending(TransactionExternalSigningPending {
                execution_id,
                source_account_id: source,
                call_data_hash: call_hash,
                external: crate::ownership::ExternalSigningPending {
                    account_id: source,
                    payload_hash: Hash32::from_bytes([4; 32]),
                    expires_at: 123,
                    session_id: "abcdefghijklmnop".to_owned(),
                    transport_request: "QR_V1".to_owned(),
                },
            });
        let (info, session, request, reason) =
            transaction_execution_info(&pending).expect("pending projection");
        assert_eq!(
            info.status,
            CitizenSdkTransactionExecutionStatus::ExternalPending as u32
        );
        assert_eq!(
            info.transport,
            CitizenSdkExternalSignerTransport::QrV1 as u32
        );
        assert_eq!(info.transaction_hash, [0; 32]);
        assert_eq!(session, b"abcdefghijklmnop");
        assert_eq!(request, b"QR_V1");
        assert!(reason.is_empty());

        let finalized_block = VerifiedBlockRef::finalized(Hash32::from_bytes([5; 32]), 6);
        let completed = TransactionExecutionPayload::Completed(TransactionExecutionCompleted::new(
            execution_id,
            source,
            call_hash,
            Hash32::from_bytes([7; 32]),
            TransactionExecutionResolution::Finalized(ExecutionConclusion::Success {
                block: finalized_block,
                extrinsic_index: 8,
            }),
        ));
        let (info, session, request, reason) =
            transaction_execution_info(&completed).expect("finalized projection");
        assert_eq!(
            info.status,
            CitizenSdkTransactionExecutionStatus::FinalizedSuccess as u32
        );
        assert_eq!(
            info.transport,
            CitizenSdkExternalSignerTransport::None as u32
        );
        assert_eq!((info.has_block, info.has_extrinsic_index), (1, 1));
        assert_eq!(info.extrinsic_index, 8);
        assert!(session.is_empty() && request.is_empty() && reason.is_empty());

        let pool = TransactionExecutionPayload::Completed(TransactionExecutionCompleted::new(
            execution_id,
            source,
            call_hash,
            Hash32::from_bytes([9; 32]),
            TransactionExecutionResolution::PoolRejected {
                reason: "usurped".to_owned(),
                replacement_hash: Some(Hash32::from_bytes([10; 32])),
            },
        ));
        let (info, session, request, reason) =
            transaction_execution_info(&pool).expect("pool projection");
        assert_eq!(
            info.status,
            CitizenSdkTransactionExecutionStatus::PoolRejected as u32
        );
        assert_eq!(info.has_replacement_hash, 1);
        assert_eq!(reason, b"usurped");
        assert!(session.is_empty() && request.is_empty());
    }
}
