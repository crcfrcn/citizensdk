//! Transaction history 的条数与持久化资源预算合同。

use citizen_sdk_contracts::{
    blake2_256, AccountId32, ChainIdentity, ContractErrorCode, Hash32, HistoryTransactionStatus,
    RuntimeVersion, SignedExtrinsic, TransactionExecutionId, TransactionExecutionRecord,
    TransactionHistoryIndex, VerifiedBlockRef, MAX_TRANSACTION_CALL_DATA_BYTES,
    MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES, MAX_TRANSACTION_HISTORY_RECORDS,
    MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES,
};

fn execution(index: usize, maximum_sized: bool) -> TransactionExecutionRecord {
    let ordinal = u128::try_from(index + 1).expect("execution ordinal");
    let call_data = if maximum_sized {
        vec![0x41; MAX_TRANSACTION_CALL_DATA_BYTES]
    } else {
        vec![u8::try_from(index % 251).expect("call marker")]
    };
    let call_data_hash = Hash32::from_bytes(blake2_256(&call_data).expect("callData hash"));
    let signed_bytes = if maximum_sized {
        MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES
    } else {
        1
    };
    let mut transaction_hash = [0_u8; 32];
    transaction_hash[..16].copy_from_slice(&ordinal.to_le_bytes());
    TransactionExecutionRecord::try_new(
        TransactionExecutionId::try_new(ordinal.to_le_bytes()).expect("execution id"),
        AccountId32::from_bytes([0x11; 32]),
        call_data_hash,
        call_data,
        Hash32::from_bytes(transaction_hash),
        SignedExtrinsic::try_new(vec![0x84; signed_bytes]).expect("signed extrinsic"),
        VerifiedBlockRef::best(Hash32::from_bytes([0x41; 32]), 2),
        RuntimeVersion::new(1, 1),
        ChainIdentity::citizenchain().genesis_hash(),
        u64::try_from(index).expect("nonce"),
        HistoryTransactionStatus::Pending,
        u64::try_from(index + 1).expect("created timestamp"),
        u64::try_from(index + 1).expect("updated timestamp"),
    )
    .expect("execution")
}

#[test]
fn four_thousand_ninety_six_small_records_remain_valid() {
    let weight = execution(0, false).durable_weight_bytes();
    let index = TransactionHistoryIndex::try_new(
        1,
        MAX_TRANSACTION_HISTORY_RECORDS,
        weight * MAX_TRANSACTION_HISTORY_RECORDS,
        MAX_TRANSACTION_HISTORY_RECORDS,
        weight * MAX_TRANSACTION_HISTORY_RECORDS,
    )
    .expect("small history index at count limit");
    assert_eq!(index.record_count(), MAX_TRANSACTION_HISTORY_RECORDS);
    assert!(index.durable_weight_bytes() <= MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES);
}

#[test]
fn aggregate_weight_rejects_before_the_host_record_limit() {
    let record_weight = execution(0, true).durable_weight_bytes();
    let fitting =
        TransactionHistoryIndex::try_new(1, 15, record_weight * 15, 15, record_weight * 15)
            .expect("15 maximum-sized records fit durable budget");
    assert!(fitting.durable_weight_bytes() <= MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES);

    let rejected =
        TransactionHistoryIndex::try_new(1, 16, record_weight * 16, 16, record_weight * 16)
            .err()
            .unwrap_or_else(|| panic!("16 maximum-sized records must fail admission"));
    assert_eq!(rejected.code(), ContractErrorCode::InvalidArgument);
}
