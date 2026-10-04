//! Generic opaque transaction preparation value contracts.

use citizen_sdk_contracts::{
    blake2_256, AccountId32, ExecutionConclusion, Hash32, HistoryTransactionStatus,
    OpaqueTransactionCall, PreparedTransactionSummary, RuntimeVersion, SignedExtrinsic,
    TransactionExecutionId, TransactionExecutionRecord, TransactionHistoryIndex,
    TransactionHistoryMutation, TransactionPreparationId, VerifiedBlockRef,
    MAX_TRANSACTION_CALL_DATA_BYTES,
};

#[test]
fn opaque_call_is_bounded_and_hashes_exact_bytes() {
    assert!(OpaqueTransactionCall::try_new(Vec::new()).is_err());
    assert!(OpaqueTransactionCall::try_new(vec![0; MAX_TRANSACTION_CALL_DATA_BYTES + 1]).is_err());
    let call = OpaqueTransactionCall::try_new(vec![4, 0, 7])
        .unwrap_or_else(|error| panic!("opaque call failed: {error}"));
    assert_eq!(call.as_bytes(), &[4, 0, 7]);
    assert_ne!(
        call.hash()
            .unwrap_or_else(|error| panic!("hash failed: {error}")),
        Hash32::from_bytes([0; 32])
    );
}

#[test]
fn summary_accepts_only_best_block_and_exposes_no_payload() {
    let id = TransactionPreparationId::try_new([7; 16])
        .unwrap_or_else(|error| panic!("id failed: {error}"));
    assert!(TransactionPreparationId::try_new([0; 16]).is_err());
    let account = AccountId32::from_bytes([8; 32]);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([9; 32]), 10);
    let summary = PreparedTransactionSummary::try_new(
        id,
        account,
        Hash32::from_bytes([11; 32]),
        best,
        RuntimeVersion::new(12, 13),
        14,
    )
    .unwrap_or_else(|error| panic!("summary failed: {error}"));
    assert_eq!(summary.preparation_id(), id);
    assert_eq!(summary.source_account_id(), account);
    assert_eq!(summary.best_block(), best);
    assert_eq!(summary.runtime_version(), RuntimeVersion::new(12, 13));
    assert_eq!(summary.nonce(), 14);
    assert!(PreparedTransactionSummary::try_new(
        id,
        account,
        Hash32::from_bytes([11; 32]),
        VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 10),
        RuntimeVersion::new(12, 13),
        14,
    )
    .is_err());
}

#[test]
fn durable_generic_execution_binds_exact_opaque_authorization_and_monotonic_status() {
    assert!(TransactionExecutionId::try_new([0; 16]).is_err());
    let id = TransactionExecutionId::try_new([1; 16])
        .unwrap_or_else(|error| panic!("execution id failed: {error}"));
    let call_data = vec![4, 0, 7];
    let call_hash = Hash32::from_bytes(
        blake2_256(&call_data).unwrap_or_else(|error| panic!("call hash failed: {error}")),
    );
    let best = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 3);
    let record = TransactionExecutionRecord::try_new(
        id,
        AccountId32::from_bytes([4; 32]),
        call_hash,
        call_data.clone(),
        Hash32::from_bytes([5; 32]),
        SignedExtrinsic::try_new(vec![8, 4, 0, 7])
            .unwrap_or_else(|error| panic!("extrinsic failed: {error}")),
        best,
        RuntimeVersion::new(6, 7),
        Hash32::from_bytes([8; 32]),
        9,
        HistoryTransactionStatus::Pending,
        10,
        10,
    )
    .unwrap_or_else(|error| panic!("record failed: {error}"));
    assert_eq!(record.call_data(), call_data);
    assert_eq!(record.call_data_hash(), call_hash);
    assert!(TransactionExecutionRecord::try_new(
        id,
        record.account_id(),
        Hash32::from_bytes([0; 32]),
        call_data,
        record.transaction_hash(),
        record.signed_extrinsic().clone(),
        best,
        record.runtime_version(),
        record.genesis_hash(),
        record.nonce(),
        HistoryTransactionStatus::Pending,
        10,
        10,
    )
    .is_err());

    let finalized = record
        .try_with_status(
            HistoryTransactionStatus::Execution(ExecutionConclusion::Success {
                block: VerifiedBlockRef::finalized(Hash32::from_bytes([11; 32]), 12),
                extrinsic_index: 1,
            }),
            13,
        )
        .unwrap_or_else(|error| panic!("terminal transition failed: {error}"));
    assert!(finalized
        .try_with_status(HistoryTransactionStatus::Pending, 14)
        .is_err());
}

#[test]
fn durable_generic_mutation_rejects_duplicate_or_conflicting_execution_ids() {
    let record = execution_record([1; 16], [2; 32]);
    let index = TransactionHistoryIndex::try_new(
        1,
        1,
        record.durable_weight_bytes(),
        1,
        record.durable_weight_bytes(),
    )
    .expect("index");
    assert!(TransactionHistoryMutation::try_new(
        0,
        index,
        Vec::new(),
        vec![record.clone(), record.clone()],
    )
    .is_err());

    assert!(TransactionHistoryMutation::try_new(
        0,
        index,
        vec![record.execution_id()],
        vec![record],
    )
    .is_err());
}

fn execution_record(id: [u8; 16], transaction_hash: [u8; 32]) -> TransactionExecutionRecord {
    let call_data = vec![4, 0];
    let call_hash = Hash32::from_bytes(
        blake2_256(&call_data).unwrap_or_else(|error| panic!("call hash failed: {error}")),
    );
    TransactionExecutionRecord::try_new(
        TransactionExecutionId::try_new(id)
            .unwrap_or_else(|error| panic!("execution id failed: {error}")),
        AccountId32::from_bytes([6; 32]),
        call_hash,
        call_data,
        Hash32::from_bytes(transaction_hash),
        SignedExtrinsic::try_new(vec![4, 1])
            .unwrap_or_else(|error| panic!("extrinsic failed: {error}")),
        VerifiedBlockRef::best(Hash32::from_bytes([7; 32]), 8),
        RuntimeVersion::new(9, 10),
        Hash32::from_bytes([11; 32]),
        12,
        HistoryTransactionStatus::Pending,
        13,
        13,
    )
    .unwrap_or_else(|error| panic!("record failed: {error}"))
}
