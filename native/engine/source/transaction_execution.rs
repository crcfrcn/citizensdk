//! Product-independent pending-before-broadcast and exact terminal transaction closure.
//!
//! The opaque RuntimeCall is never decoded here. A provider `Finalized` notification is only an
//! upper-bound fact; the exact canonical body and same-index System outcome are verified before a
//! completed value is created.

use std::sync::Arc;

use citizen_sdk_contracts::{
    store::HistoryTransactionStatus, ContractErrorCode, ExecutionConclusion, ExtrinsicWatchEvent,
    Hash32, SignedExtrinsic, TransactionExecutionCompleted, TransactionExecutionId,
    TransactionExecutionResolution, VerifiedChainClient,
};
use futures::StreamExt;

use crate::{
    chain_monitor::MonitorCancellation,
    error::EngineError,
    system_events::SYSTEM_EVENTS_STORAGE_KEY,
    transaction_history::TransactionHistoryService,
    transaction_outcome::{verify_transaction_outcome, TransactionEvidence},
};

/// Cooperative cancellation for one generic execution after a cold signature is accepted.
///
/// Store writes already entered are always allowed to return. Cancellation prevents a later
/// broadcast, interrupts only provider reads/watch polling, and never deletes durable facts.
#[derive(Clone, Debug, Default)]
pub struct TransactionExecutionCancellation {
    signal: Arc<MonitorCancellation>,
}

impl TransactionExecutionCancellation {
    pub fn cancel(&self) {
        self.signal.cancel();
    }

    /// ABI在无效回扫后决定保留会话时读取同一个真实执行取消信号。
    pub fn is_cancelled(&self) -> bool {
        self.signal.is_cancelled()
    }

    fn ensure_active(&self) -> Result<(), EngineError> {
        if self.signal.is_cancelled() {
            Err(cancelled())
        } else {
            Ok(())
        }
    }

    async fn provider<T>(
        &self,
        future: impl std::future::Future<Output = T>,
    ) -> Result<T, EngineError> {
        let mut future = std::pin::pin!(future);
        std::future::poll_fn(|context| {
            if self.signal.poll_cancelled(context).is_ready() {
                return std::task::Poll::Ready(Err(cancelled()));
            }
            future.as_mut().poll(context).map(Ok)
        })
        .await
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn persist_submit_and_verify_exact(
    chain: &dyn VerifiedChainClient,
    history: &TransactionHistoryService,
    execution_id: TransactionExecutionId,
    source: citizen_sdk_contracts::AccountId32,
    call_data_hash: Hash32,
    call_data: Vec<u8>,
    prepared_block: citizen_sdk_contracts::VerifiedBlockRef,
    runtime_context: citizen_sdk_contracts::RuntimeContext,
    genesis_hash: Hash32,
    nonce: u64,
    signed_extrinsic: SignedExtrinsic,
    cancellation: Option<&TransactionExecutionCancellation>,
) -> Result<TransactionExecutionCompleted, EngineError> {
    let execution_span = crate::transaction_diagnostic::Span::start("submit_and_observe");
    let persist_span = crate::transaction_diagnostic::Span::start("persist_before_broadcast");
    ensure_active(cancellation)?;
    let transaction_hash =
        crate::transaction_outcome::signed_extrinsic_hash(&runtime_context, &signed_extrinsic)?;
    history
        .record_execution_before_broadcast(
            execution_id,
            source,
            call_data_hash,
            call_data,
            transaction_hash,
            signed_extrinsic.clone(),
            prepared_block,
            runtime_context.version(),
            genesis_hash,
            nonce,
        )
        .await?;
    // A store call already entered is drained before this check. Cancellation here leaves the
    // exact authorization durable but guarantees that this request never reaches the provider.
    ensure_active(cancellation)?;
    let (_, durable) = history.require_execution_snapshot(execution_id).await?;
    ensure_active(cancellation)?;
    if durable.account_id() != source
        || durable.call_data_hash() != call_data_hash
        || durable.transaction_hash() != transaction_hash
        || durable.signed_extrinsic() != &signed_extrinsic
        || !matches!(durable.status(), HistoryTransactionStatus::Pending)
    {
        return Err(integrity("通用交易 CAS 写后回读与待广播授权不一致"));
    }

    persist_span.finish();
    crate::transaction_diagnostic::event("watch_open");
    let mut watch = chain.watch_extrinsic(signed_extrinsic.clone());
    loop {
        let next = match cancellation {
            Some(token) => token.provider(watch.next()).await?,
            None => watch.next().await,
        };
        let Some(item) = next else { break };
        let item = item?;
        // 闭集事件名不携带区块、节点、账户或原始错误文本。
        crate::transaction_diagnostic::event(match &item {
            ExtrinsicWatchEvent::Ready => "watch_ready",
            ExtrinsicWatchEvent::Broadcast { .. } => "watch_broadcast",
            ExtrinsicWatchEvent::Future => "watch_future",
            ExtrinsicWatchEvent::InBlock { .. } => "watch_in_block",
            ExtrinsicWatchEvent::Invalid => "watch_invalid",
            ExtrinsicWatchEvent::Usurped { .. } => "watch_usurped",
            ExtrinsicWatchEvent::Finalized { .. } => "watch_finalized",
            _ => "watch_other",
        });
        match item {
            ExtrinsicWatchEvent::Ready
            | ExtrinsicWatchEvent::Broadcast { .. }
            | ExtrinsicWatchEvent::Future => {}
            ExtrinsicWatchEvent::InBlock { block } => {
                history
                    .update_execution_status(
                        execution_id,
                        HistoryTransactionStatus::InBlock { block },
                    )
                    .await?;
                ensure_active(cancellation)?;
            }
            event @ (ExtrinsicWatchEvent::Invalid | ExtrinsicWatchEvent::Usurped { .. }) => {
                let (reason, replacement_hash) = match event {
                    ExtrinsicWatchEvent::Invalid => ("invalid".to_owned(), None),
                    ExtrinsicWatchEvent::Usurped { replacement_hash } => {
                        ("usurped".to_owned(), Some(replacement_hash))
                    }
                    _ => unreachable!(),
                };
                history
                    .update_execution_status(
                        execution_id,
                        HistoryTransactionStatus::try_pool_rejected_with_replacement(
                            reason.clone(),
                            replacement_hash,
                        )?,
                    )
                    .await?;
                execution_span.finish();
                return Ok(TransactionExecutionCompleted::new(
                    execution_id,
                    source,
                    call_data_hash,
                    transaction_hash,
                    TransactionExecutionResolution::PoolRejected {
                        reason,
                        replacement_hash,
                    },
                ));
            }
            ExtrinsicWatchEvent::Finalized { block } => {
                let proof_span = crate::transaction_diagnostic::Span::start("finalized_proof");
                let canonical = provider(
                    cancellation,
                    chain.resolve_finalized_block(block.hash(), block.number()),
                )
                .await??;
                if canonical != block {
                    return Err(integrity("provider finalized block 与 canonical 锚不一致"));
                }
                let runtime = provider(
                    cancellation,
                    chain.get_finalized_runtime_context_at(canonical),
                )
                .await??;
                let body = provider(
                    cancellation,
                    chain.get_finalized_block_extrinsics_at(canonical),
                )
                .await??;
                let events = provider(
                    cancellation,
                    chain.get_finalized_storage_at(canonical, SYSTEM_EVENTS_STORAGE_KEY.to_vec()),
                )
                .await??;
                let conclusion = verify_transaction_outcome(TransactionEvidence {
                    block: canonical.verified(),
                    runtime_context: &runtime,
                    signed_extrinsic: &signed_extrinsic,
                    submitted_hash: transaction_hash,
                    block_extrinsics: &body,
                    system_events: events.as_deref(),
                });
                if !matches!(
                    conclusion,
                    ExecutionConclusion::Success { .. } | ExecutionConclusion::Failed { .. }
                ) {
                    return Err(EngineError::contract(
                        ContractErrorCode::Unavailable,
                        "finalized 块尚未形成同 index Runtime 执行证明；保持 Pending/InBlock",
                    ));
                }
                history
                    .update_execution_status(
                        execution_id,
                        HistoryTransactionStatus::Execution(conclusion.clone()),
                    )
                    .await?;
                ensure_active(cancellation)?;
                proof_span.finish();
                execution_span.finish();
                return Ok(TransactionExecutionCompleted::new(
                    execution_id,
                    source,
                    call_data_hash,
                    transaction_hash,
                    TransactionExecutionResolution::Finalized(conclusion),
                ));
            }
            ExtrinsicWatchEvent::Retracted { .. }
            | ExtrinsicWatchEvent::FinalityTimeout { .. }
            | ExtrinsicWatchEvent::Dropped => {
                return Err(EngineError::contract(
                    ContractErrorCode::Network,
                    "交易观察在明确终态前中断；持久 Pending/InBlock 保留",
                ));
            }
        }
    }
    Err(EngineError::contract(
        ContractErrorCode::Network,
        "交易观察流在明确终态前结束；持久 Pending/InBlock 保留",
    ))
}

fn ensure_active(
    cancellation: Option<&TransactionExecutionCancellation>,
) -> Result<(), EngineError> {
    cancellation.map_or(Ok(()), TransactionExecutionCancellation::ensure_active)
}

async fn provider<T>(
    cancellation: Option<&TransactionExecutionCancellation>,
    future: impl std::future::Future<Output = T>,
) -> Result<T, EngineError> {
    match cancellation {
        Some(token) => token.provider(future).await,
        None => Ok(future.await),
    }
}

fn cancelled() -> EngineError {
    EngineError::Cancelled
}

fn integrity(message: &str) -> EngineError {
    EngineError::contract(ContractErrorCode::Integrity, message)
}

#[cfg(test)]
mod tests {
    use std::{future::Future, task::Context};

    use futures::task::noop_waker_ref;

    use super::TransactionExecutionCancellation;
    use crate::EngineError;

    #[test]
    fn cancellation_wakes_an_in_flight_provider_wait() {
        let cancellation = TransactionExecutionCancellation::default();
        let mut wait = std::pin::pin!(cancellation.provider(futures::future::pending::<()>()));
        let mut context = Context::from_waker(noop_waker_ref());
        assert!(wait.as_mut().poll(&mut context).is_pending());

        cancellation.cancel();

        assert!(matches!(
            wait.as_mut().poll(&mut context),
            std::task::Poll::Ready(Err(EngineError::Cancelled))
        ));
    }
}
