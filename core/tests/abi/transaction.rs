use super::*;
use crate::types::ExecutionConclusion;
use crate::types::Hash32;
use crate::types::RuntimeVersion;
use crate::types::TransactionExecutionCompleted;
use crate::types::TransactionExecutionResolution;
use crate::types::VerifiedBlockRef;

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
    lock_external_executions().unwrap().insert(
        id,
        ExternalExecutionEntry {
            owner,
            session_id: "synthetic-session".into(),
            attempt: 2,
            state: ExternalExecutionState::AdmissionPending,
        },
    );
    assert_eq!(
        finish_external_execution_attempt(id, owner, "synthetic-session", 1, false),
        ExternalAttemptFinish::Stale
    );
    assert_eq!(
        finish_external_execution_attempt(id, owner + 1, "synthetic-session", 2, true),
        ExternalAttemptFinish::Stale
    );
    assert_eq!(
        finish_external_execution_attempt(id, owner, "synthetic-session", 2, true),
        ExternalAttemptFinish::Retry
    );
    assert!(matches!(
        lock_external_executions().unwrap().get(&id).unwrap().state,
        ExternalExecutionState::AwaitingResponse
    ));
    lock_external_executions().unwrap().remove(&id);
    assert_eq!(
        finish_external_execution_attempt(id, owner, "synthetic-session", 2, true),
        ExternalAttemptFinish::Terminal
    );
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
    let pending = TransactionExecutionPayload::ExternalPending(TransactionExternalSigningPending {
        execution_id,
        source_account_id: source,
        call_data_hash: call_hash,
        external: crate::abi::ownership::ExternalSigningPending {
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
