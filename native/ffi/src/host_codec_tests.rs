use crate::{
    abi::CitizenSdkErrorCode,
    host_codec::{
        decode_chain_database_snapshot, decode_encrypted_secret_blob_snapshot, decode_host_record,
        decode_runtime_context, decode_transaction_execution_record,
        decode_transaction_history_host_batch, decode_wallet_state, encode_chain_database_snapshot,
        encode_encrypted_secret_blob_snapshot, encode_host_record, encode_runtime_context,
        encode_transaction_execution_record, encode_transaction_history_host_batch,
        encode_transaction_history_index_query, encode_transaction_history_mutation,
        encode_transaction_history_page_query, encode_transaction_history_record_query,
        encode_wallet_state, HostCodecErrorKind, HostRecordDomain, HOST_RECORD_FORMAT_VERSION,
    },
};
use citizen_sdk_contracts::{
    citizen_ss58_address, AccountId32, ChainDatabaseSnapshot, ColdWalletAccount,
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretEnvelope, Hash32,
    Hash32Bytes, HistoryTransactionStatus, RuntimeContext, RuntimeVersion, SecretOwner, SecretRef,
    SignedExtrinsic, TransactionExecutionId, TransactionExecutionRecord, TransactionHistoryIndex,
    TransactionHistoryMutation, TransactionHistoryQueryKind, VaultGeneration, VerifiedBlockRef,
    WalletState, WalletRecord, WalletDiagnosticReason, MAX_PERSISTED_RUNTIME_METADATA_BYTES,
};

const HEADER_LEN: usize = 56;

#[test]
fn generic_execution_round_trips_complete_recovery_material_and_rejects_wrong_schema() {
    let call_data = vec![4, 0, 7];
    let call_data_hash = Hash32::from_bytes(
        citizen_sdk_contracts::blake2_256(&call_data)
            .unwrap_or_else(|error| panic!("callData hash fixture failed: {error}")),
    );
    let record = citizen_sdk_contracts::TransactionExecutionRecord::try_new(
        citizen_sdk_contracts::TransactionExecutionId::try_new([9; 16])
            .unwrap_or_else(|error| panic!("execution id fixture failed: {error}")),
        AccountId32::from_bytes([1; 32]),
        call_data_hash,
        call_data,
        Hash32::from_bytes([2; 32]),
        citizen_sdk_contracts::SignedExtrinsic::try_new(vec![0x04, 0x84])
            .unwrap_or_else(|error| panic!("extrinsic fixture failed: {error}")),
        VerifiedBlockRef::best(Hash32::from_bytes([7; 32]), 8),
        RuntimeVersion::new(100, 12),
        citizen_sdk_contracts::ChainIdentity::citizenchain().genesis_hash(),
        3,
        citizen_sdk_contracts::HistoryTransactionStatus::Pending,
        6,
        6,
    )
    .unwrap_or_else(|error| panic!("execution fixture failed: {error}"));
    let encoded = encode_transaction_execution_record(&record)
        .unwrap_or_else(|error| panic!("execution encode failed: {error}"));
    assert_eq!(
        decode_transaction_execution_record(&encoded)
            .unwrap_or_else(|error| panic!("execution decode failed: {error}")),
        record
    );

    let payload = decode_host_record(HostRecordDomain::TransactionHistory, &encoded)
        .unwrap_or_else(|error| panic!("host record decode failed: {error}"))
        .payload();
    let mut wrong_schema = payload.to_vec();
    wrong_schema[0] ^= 0xff;
    let invalid = encode_host_record(HostRecordDomain::TransactionHistory, &wrong_schema)
        .unwrap_or_else(|error| panic!("invalid fixture encode failed: {error}"));
    assert!(decode_transaction_execution_record(&invalid).is_err());
}

fn baseline_execution(index: usize) -> TransactionExecutionRecord {
    let ordinal = u128::try_from(index + 1)
        .unwrap_or_else(|error| panic!("baseline ordinal failed: {error}"));
    let mut transaction_hash = [0_u8; 32];
    transaction_hash[..16].copy_from_slice(&ordinal.to_le_bytes());
    let call_data = vec![
        u8::try_from(index % 251)
            .unwrap_or_else(|error| panic!("baseline marker failed: {error}"));
        128
    ];
    let call_data_hash = Hash32::from_bytes(
        citizen_sdk_contracts::blake2_256(&call_data)
            .unwrap_or_else(|error| panic!("baseline callData hash failed: {error}")),
    );
    TransactionExecutionRecord::try_new(
        TransactionExecutionId::try_new(ordinal.to_le_bytes())
            .unwrap_or_else(|error| panic!("baseline execution id failed: {error}")),
        AccountId32::from_bytes([0x11; 32]),
        call_data_hash,
        call_data,
        Hash32::from_bytes(transaction_hash),
        SignedExtrinsic::try_new(vec![0x84; 256])
            .unwrap_or_else(|error| panic!("baseline extrinsic failed: {error}")),
        VerifiedBlockRef::best(Hash32::from_bytes([0x41; 32]), 2),
        RuntimeVersion::new(1, 1),
        citizen_sdk_contracts::ChainIdentity::citizenchain().genesis_hash(),
        u64::try_from(index).unwrap_or_else(|error| panic!("baseline nonce failed: {error}")),
        HistoryTransactionStatus::Pending,
        u64::try_from(index + 1)
            .unwrap_or_else(|error| panic!("baseline timestamp failed: {error}")),
        u64::try_from(index + 1)
            .unwrap_or_else(|error| panic!("baseline timestamp failed: {error}")),
    )
    .unwrap_or_else(|error| panic!("baseline execution failed: {error}"))
}

#[test]
fn execution_history_codec_is_per_record_and_query_batches_are_bounded() {
    const COUNTS: [usize; 4] = [0, 1, 100, 1_000];
    const ROUNDS: usize = 5;
    let reference_len = encode_transaction_execution_record(&baseline_execution(0))
        .unwrap_or_else(|error| panic!("reference execution encode failed: {error}"))
        .len();

    for count in COUNTS {
        let records = (0..count.min(100))
            .map(baseline_execution)
            .collect::<Vec<_>>();
        let mut encode_samples = Vec::with_capacity(ROUNDS);
        let mut decode_samples = Vec::with_capacity(ROUNDS);
        let mut encoded_bytes = 0_usize;
        for _ in 0..ROUNDS {
            let started = std::time::Instant::now();
            let encoded = records
                .iter()
                .map(|record| {
                    encode_transaction_execution_record(record)
                        .unwrap_or_else(|error| panic!("baseline encode failed: {error}"))
                })
                .collect::<Vec<_>>();
            encode_samples.push(started.elapsed().as_nanos());
            encoded_bytes = encoded.iter().map(Vec::len).sum();
            let started = std::time::Instant::now();
            let decoded = encoded
                .iter()
                .map(|value| {
                    decode_transaction_execution_record(value)
                        .unwrap_or_else(|error| panic!("baseline decode failed: {error}"))
                })
                .collect::<Vec<_>>();
            decode_samples.push(started.elapsed().as_nanos());
            assert_eq!(decoded, records);
        }
        assert_eq!(encoded_bytes, records.len() * reference_len);
        assert!(records.iter().all(|record| {
            encode_transaction_execution_record(record)
                .map(|encoded| {
                    encoded.len() <= HostRecordDomain::TransactionHistory.max_encoded_record_bytes()
                })
                .unwrap_or(false)
        }));
        println!(
            "sdk-baseline history_record_codec total_database_records={count} sampled_records={} encoded_bytes={encoded_bytes} encode_ns={encode_samples:?} decode_ns={decode_samples:?}",
            records.len()
        );
    }
}


fn diagnostic_profile_fixture() -> citizen_sdk_contracts::WalletProfile {
    use citizen_sdk_contracts::{WalletAccount, WalletOrigin, WalletProfile};
    let account_id = AccountId32::from_bytes([4; 32]);
    let account = WalletAccount::try_new(0, account_id, secret_ref(0, 1, 2, 4),
        citizen_ss58_address(account_id), "账户名称", 100).unwrap_or_else(|_| panic!("合成账户失败"));
    WalletProfile::try_new(0, VaultGeneration::from_bytes([1; 16]), account_id, WalletOrigin::Created,
        100, account_id, vec![account]).and_then(|value| value.try_with_wallet_name("独立钱包名"))
        .unwrap_or_else(|_| panic!("合成profile失败"))
}

#[test]
fn wallet_v3_preserves_invalid_mode_in_its_original_slot_without_creating_a_signable_account() {
    let profile = diagnostic_profile_fixture();
    let state = WalletState::try_from_parts(9, Some(profile.clone()), None, None, Vec::new())
        .and_then(|value| value.try_with_active_wallet(Some(0))).unwrap_or_else(|_| panic!("合成state失败"));
    let encoded = encode_wallet_state(&state).unwrap_or_else(|_| panic!("合成编码失败"));
    let mut payload = decode_host_record(HostRecordDomain::WalletProfile, &encoded)
        .unwrap_or_else(|_| panic!("合成信封失败")).payload().to_vec();
    let offset = payload.windows(7).position(|bytes| bytes == b"\x03\0\0\0hot")
        .unwrap_or_else(|| panic!("缺少唯一hot槽模式"));
    payload[offset + 4..offset + 7].copy_from_slice(b"bad");
    let modified = encode_host_record(HostRecordDomain::WalletProfile, &payload).unwrap_or_else(|_| panic!("合成模式编码失败"));
    let decoded = decode_wallet_state(&modified).unwrap_or_else(|_| panic!("诊断解码失败"));
    assert!(decoded.profile().is_none() && decoded.ordered_account_ids().is_empty());
    assert_eq!(decoded.active_wallet_index(), Some(0));
    assert_eq!(decoded.diagnostics().len(), 1);
    assert_eq!(decoded.diagnostics()[0].sign_mode(), "bad");
    assert_eq!(decoded.diagnostics()[0].wallet_name(), profile.wallet_name());
    assert_eq!(decoded.diagnostics()[0].diagnostic_reason(), Some(WalletDiagnosticReason::InvalidSignMode));
    assert_eq!(decoded.account_sign_mode(profile.master_account_id()), None);
    let round_trip = encode_wallet_state(&decoded).unwrap_or_else(|_| panic!("诊断编码失败"));
    assert_eq!(decode_wallet_state(&round_trip).unwrap_or_else(|_| panic!("诊断往返失败")), decoded);
    for length in 0..round_trip.len() {
        assert!(decode_wallet_state(&round_trip[..length]).is_err());
    }
    for version in [1u16, 2, 4] {
        let mut wrong = payload.clone(); wrong[..2].copy_from_slice(&version.to_le_bytes());
        let wrong = encode_host_record(HostRecordDomain::WalletProfile, &wrong).unwrap_or_else(|_| panic!("合成版本编码失败"));
        assert!(decode_wallet_state(&wrong).is_err()); // 诊断不是旧版本兼容入口。
    }
}

#[test]
fn wallet_v3_round_trips_hot_and_cold_diagnostics_with_strict_identity_boundaries() {
    let profile = diagnostic_profile_fixture();
    let mut hot = WalletRecord::from_profile(&profile);
    if let WalletRecord::Profile { accounts, .. } = &mut hot { accounts[0].ss58_address = "bad-address".to_owned(); }
    let cold = ColdWalletAccount::try_new(1, AccountId32::from_bytes([9; 32]),
        citizen_ss58_address(AccountId32::from_bytes([9; 32])), "冷钱包", 101)
        .unwrap_or_else(|_| panic!("合成冷账户失败"));
    let mut cold = WalletRecord::from_cold_account(&cold);
    if let WalletRecord::Account { sign_mode, .. } = &mut cold { *sign_mode = "unknown".to_owned(); }
    let state = WalletState::try_from_catalog_parts(10, None, vec![], vec![], 2, None, None, vec![])
        .and_then(|state| state.try_with_diagnostics(vec![cold.clone(), hot.clone()]))
        .and_then(|state| state.try_with_active_wallet(Some(1))).unwrap_or_else(|_| panic!("合成异常目录失败"));
    let encoded = encode_wallet_state(&state).unwrap_or_else(|_| panic!("异常目录编码失败"));
    let decoded = decode_wallet_state(&encoded).unwrap_or_else(|_| panic!("异常目录解码失败"));
    assert_eq!(decoded, state);
    assert_eq!(decoded.diagnostic(0), Some(&hot));
    assert_eq!(decoded.diagnostic(1), Some(&cold));
    assert_eq!(decoded.diagnostic(0).and_then(WalletRecord::diagnostic_reason), Some(WalletDiagnosticReason::InvalidIdentity));
    assert!(decoded.default_account_id().is_none());
}


#[test]
fn encrypted_secret_presence_uses_complete_codec_and_preserves_outputs_on_failure() {
    let reference = secret_ref(7, 8, 9, 10);
    let account = AccountId32::from_bytes([10; 32]);
    let sealed = EncryptedSecretBlobSnapshot::empty().try_advance(EncryptedSecretBlobState::Sealed {
        provisioning_operation_id: [11; 16],
        envelope: EncryptedSecretEnvelope::try_new(1, Hash32Bytes::from_bytes([12; 32]), vec![13; 48])
            .unwrap_or_else(|_| panic!("合成信封无效")),
    }).unwrap_or_else(|_| panic!("合成sealed无效"));
    let tombstone = sealed.try_advance(EncryptedSecretBlobState::Tombstone { cleanup_operation_id: [14; 16] })
        .unwrap_or_else(|_| panic!("合成墓碑无效"));
    let direct_tombstone = EncryptedSecretBlobSnapshot::empty().try_advance(
        EncryptedSecretBlobState::Tombstone { cleanup_operation_id: [15; 16] })
        .unwrap_or_else(|_| panic!("合成空槽墓碑无效"));
    for (snapshot, present) in [
        (EncryptedSecretBlobSnapshot::empty(), false), (sealed, true), (tombstone, false), (direct_tombstone, false),
    ] {
        let bytes = encode_encrypted_secret_blob_snapshot(reference, &snapshot).unwrap_or_else(|_| panic!("合成编码失败"));
        let hex = |value: &[u8]| value.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        if present {
            assert_eq!(hex(&bytes), "43534852010038000500000000000000b8000000000000009481a10e6546da63b1c160907fb48acbfa35c6ffdee717bfd4a0094b3d9e57b901000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d");
            let second = encode_encrypted_secret_blob_snapshot(secret_ref(7, 88, 9, 10), &snapshot)
                .unwrap_or_else(|_| panic!("第二代际合成编码失败"));
            assert_eq!(hex(&second), "43534852010038000500000000000000b800000000000000bbf644dec5dde868148f6f1ffe1151f121f1de7e78e2b7ecd7c9e35e0cdd48a501000700000058585858585858585858585858585858090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d");
        } else if snapshot.revision() == 2 {
            assert_eq!(hex(&bytes), "43534852010038000500000000000000600000000000000017b5fd919396d702e90558844acef60fb5a38a41f42bdfa34a449075559ce09101000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010200000000000000030e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e");
        }
        assert_eq!(crate::host_codec::encrypted_secret_record_has_secret(account, snapshot.revision(), &bytes)
            .unwrap_or_else(|_| panic!("存在性解码失败")), present);
        assert!(!crate::host_codec::encrypted_secret_record_has_secret(AccountId32::from_bytes([99; 32]), snapshot.revision(), &bytes)
            .unwrap_or_else(|_| panic!("异账户解码失败")));
        assert!(crate::host_codec::encrypted_secret_record_has_secret(account, snapshot.revision() + 1, &bytes).is_err());
        let c_account = crate::abi::CitizenSdkAccountId { bytes: *account.as_bytes() };
        let mut output = 77u8;
        let code = unsafe { crate::citizensdk_encrypted_secret_record_has_secret(&c_account, snapshot.revision(),
            crate::abi::CitizenSdkBytesView { data: bytes.as_ptr(), len: bytes.len() as u64 }, &mut output) };
        assert_eq!(code, 0); assert_eq!(output, u8::from(present));
        for length in 0..bytes.len() {
            output = 77;
            let code = unsafe { crate::citizensdk_encrypted_secret_record_has_secret(&c_account, snapshot.revision(),
                crate::abi::CitizenSdkBytesView { data: bytes.as_ptr(), len: length as u64 }, &mut output) };
            assert_ne!(code, 0); assert_eq!(output, 77);
        }
        for view in [
            crate::abi::CitizenSdkBytesView { data: std::ptr::null(), len: 1 },
            crate::abi::CitizenSdkBytesView { data: bytes.as_ptr(), len: 65537 },
        ] {
            output = 77;
            assert_ne!(unsafe { crate::citizensdk_encrypted_secret_record_has_secret(&c_account, snapshot.revision(), view, &mut output) }, 0);
            assert_eq!(output, 77);
        }
        let view = crate::abi::CitizenSdkBytesView { data: bytes.as_ptr(), len: bytes.len() as u64 };
        output = 77;
        assert_ne!(unsafe { crate::citizensdk_encrypted_secret_record_has_secret(std::ptr::null(), snapshot.revision(), view, &mut output) }, 0);
        assert_eq!(output, 77);
        assert_ne!(unsafe { crate::citizensdk_encrypted_secret_record_has_secret(&c_account, snapshot.revision(), view, std::ptr::null_mut()) }, 0);
        assert_ne!(unsafe { crate::citizensdk_encrypted_secret_record_has_secret(&c_account, snapshot.revision() + 1, view, &mut output) }, 0);
        assert_eq!(output, 77);
    }
}

#[test]
fn execution_history_host_batch_round_trips_index_and_opaque_records() {
    let records = (0..100).map(baseline_execution).collect::<Vec<_>>();
    let durable_weight = records
        .iter()
        .map(TransactionExecutionRecord::durable_weight_bytes)
        .sum();
    let index = TransactionHistoryIndex::try_new(7, 1_000, durable_weight, 100, durable_weight)
        .unwrap_or_else(|error| panic!("history index fixture failed: {error}"));
    let encoded = encode_transaction_history_host_batch(index, &records, true)
        .unwrap_or_else(|error| panic!("history batch encode failed: {error}"));
    let decoded = decode_transaction_history_host_batch(&encoded)
        .unwrap_or_else(|error| panic!("history batch decode failed: {error}"));
    assert_eq!(decoded.index(), index);
    assert_eq!(decoded.records(), records);
    assert!(decoded.has_more());
}

#[test]
fn history_query_and_mutation_wire_shapes_are_fixed_and_descriptor_tampering_fails() {
    let record = baseline_execution(0);
    let weight = record.durable_weight_bytes();
    let index = TransactionHistoryIndex::try_new(1, 1, weight, 1, weight)
        .unwrap_or_else(|error| panic!("history index fixture failed: {error}"));

    let index_query = encode_transaction_history_index_query();
    assert_eq!(index_query.len(), 58);
    assert_eq!(&index_query[..5], b"THQ1\x01");
    assert_eq!(
        encode_transaction_history_record_query(1, record.execution_id()).len(),
        58
    );
    assert_eq!(
        encode_transaction_history_page_query(1, TransactionHistoryQueryKind::Newest, None, 100)
            .unwrap_or_else(|error| panic!("history page query failed: {error}"))
            .len(),
        58
    );

    let mutation = TransactionHistoryMutation::try_new(0, index, Vec::new(), vec![record.clone()])
        .unwrap_or_else(|error| panic!("history mutation fixture failed: {error}"));
    let mutation_wire = encode_transaction_history_mutation(&mutation)
        .unwrap_or_else(|error| panic!("history mutation encode failed: {error}"));
    assert_eq!(&mutation_wire[..4], b"THM1");

    let mut batch = encode_transaction_history_host_batch(index, &[record], false)
        .unwrap_or_else(|error| panic!("history batch encode failed: {error}"));
    // The descriptor starts at byte 41. Its indexed executionId must agree
    // with the integrity-protected opaque TXR1 record later in the same value.
    batch[41] ^= 1;
    assert_eq!(
        decode_transaction_history_host_batch(&batch)
            .err()
            .unwrap_or_else(|| panic!("tampered descriptor must fail"))
            .ffi_code(),
        CitizenSdkErrorCode::Integrity
    );
}

#[test]
fn runtime_metadata_persistence_limit_preserves_the_larger_core_contract() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0x55; 32]), 9);
    let persisted = RuntimeContext::try_new(
        block,
        RuntimeVersion::new(1, 1),
        vec![0x42; MAX_PERSISTED_RUNTIME_METADATA_BYTES],
    )
    .unwrap_or_else(|error| panic!("persistable runtime context failed: {error}"));
    let encoded = encode_runtime_context(&persisted)
        .unwrap_or_else(|error| panic!("maximum persistent runtime context failed: {error}"));
    assert_eq!(encoded.len(), 8 * 1024 * 1024);

    let memory_only = RuntimeContext::try_new(
        block,
        RuntimeVersion::new(1, 1),
        vec![0x42; MAX_PERSISTED_RUNTIME_METADATA_BYTES + 1],
    )
    .unwrap_or_else(|error| panic!("Core-valid memory-only context failed: {error}"));
    assert!(memory_only.metadata().len() <= citizen_sdk_contracts::MAX_RUNTIME_METADATA_BYTES);
    let error = encode_runtime_context(&memory_only)
        .err()
        .unwrap_or_else(|| panic!("metadata above persistent capacity must not be encoded"));
    assert_eq!(error.kind(), HostCodecErrorKind::PayloadTooLarge);
    println!(
        "sdk-baseline runtime_metadata contract_limit_bytes={} persistent_metadata_limit_bytes={MAX_PERSISTED_RUNTIME_METADATA_BYTES} encoded_record_bytes={} memory_only_metadata_bytes={}",
        citizen_sdk_contracts::MAX_RUNTIME_METADATA_BYTES,
        encoded.len(),
        memory_only.metadata().len()
    );
}

#[test]
fn v1_wire_layout_has_a_frozen_cross_language_vector() {
    let encoded = encode_host_record(HostRecordDomain::WalletProfile, b"citizen")
        .unwrap_or_else(|error| panic!("golden encode failed: {error}"));
    assert_eq!(&encoded[..4], b"CSHR");
    assert_eq!(&encoded[4..6], &[1, 0]);
    assert_eq!(&encoded[6..8], &[56, 0]);
    assert_eq!(&encoded[8..12], &[3, 0, 0, 0]);
    assert_eq!(&encoded[12..16], &[0; 4]);
    assert_eq!(&encoded[16..24], &[7, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(
        &encoded[24..56],
        &[
            0xc7, 0x00, 0xc1, 0x99, 0x84, 0x96, 0x66, 0x41, 0x15, 0x0e, 0x5f, 0x22, 0x5a, 0x25,
            0xc1, 0x78, 0x9b, 0xf4, 0xea, 0x30, 0x78, 0xc8, 0xad, 0x11, 0xe9, 0xdb, 0x0b, 0xb3,
            0xd9, 0x98, 0xfd, 0x34,
        ]
    );
    assert_eq!(&encoded[56..], b"citizen");
}

#[test]
fn every_typed_domain_round_trips_without_copying_the_decoded_payload() {
    let domains = [
        HostRecordDomain::ChainDatabase,
        HostRecordDomain::RuntimeCache,
        HostRecordDomain::WalletProfile,
        HostRecordDomain::TransactionHistory,
        HostRecordDomain::EncryptedSecretBlob,
    ];

    for domain in domains {
        let payload = [domain as u8, 0, 0xff, 7];
        let encoded = encode_host_record(domain, &payload)
            .unwrap_or_else(|error| panic!("encode {domain:?} failed: {error}"));
        let decoded = decode_host_record(domain, &encoded)
            .unwrap_or_else(|error| panic!("decode {domain:?} failed: {error}"));
        assert_eq!(decoded.domain(), domain);
        assert_eq!(decoded.payload(), payload);
        assert_eq!(decoded.payload().as_ptr(), encoded[HEADER_LEN..].as_ptr());
    }
}

#[test]
fn empty_typed_payload_has_one_canonical_representation() {
    let encoded = encode_host_record(HostRecordDomain::ChainDatabase, &[])
        .unwrap_or_else(|error| panic!("empty payload failed: {error}"));
    assert_eq!(encoded.len(), HEADER_LEN);
    assert_eq!(&encoded[4..6], &HOST_RECORD_FORMAT_VERSION.to_le_bytes());
    assert!(
        decode_host_record(HostRecordDomain::ChainDatabase, &encoded)
            .unwrap_or_else(|error| panic!("empty payload decode failed: {error}"))
            .payload()
            .is_empty()
    );
}

#[test]
fn the_same_payload_cannot_cross_a_typed_store_domain() {
    let encoded = encode_host_record(HostRecordDomain::WalletProfile, b"public wallet facts")
        .unwrap_or_else(|error| panic!("encode failed: {error}"));
    let error = decode_host_record(HostRecordDomain::TransactionHistory, &encoded)
        .err()
        .unwrap_or_else(|| panic!("cross-domain decode must fail"));
    assert_eq!(error.kind(), HostCodecErrorKind::DomainMismatch);
    assert_eq!(error.ffi_code(), CitizenSdkErrorCode::Integrity);
}

#[test]
fn header_and_payload_corruption_are_detected_before_typed_decode() {
    let encoded = encode_host_record(HostRecordDomain::RuntimeCache, b"metadata")
        .unwrap_or_else(|error| panic!("encode failed: {error}"));

    let mut bad_magic = encoded.clone();
    bad_magic[0] ^= 1;
    assert_eq!(
        decode_host_record(HostRecordDomain::RuntimeCache, &bad_magic)
            .err()
            .unwrap_or_else(|| panic!("bad magic must fail"))
            .kind(),
        HostCodecErrorKind::Malformed
    );

    let mut bad_flags = encoded.clone();
    bad_flags[12] = 1;
    assert_eq!(
        decode_host_record(HostRecordDomain::RuntimeCache, &bad_flags)
            .err()
            .unwrap_or_else(|| panic!("reserved flags must fail"))
            .kind(),
        HostCodecErrorKind::Malformed
    );

    let mut bad_payload = encoded;
    *bad_payload
        .last_mut()
        .unwrap_or_else(|| panic!("encoded payload is unexpectedly empty")) ^= 1;
    assert_eq!(
        decode_host_record(HostRecordDomain::RuntimeCache, &bad_payload)
            .err()
            .unwrap_or_else(|| panic!("corrupt payload must fail"))
            .kind(),
        HostCodecErrorKind::IntegrityMismatch
    );
}

#[test]
fn unsupported_versions_unknown_domains_and_length_mismatches_are_stable() {
    let encoded = encode_host_record(HostRecordDomain::ChainDatabase, b"db")
        .unwrap_or_else(|error| panic!("encode failed: {error}"));

    let mut unknown_version = encoded.clone();
    unknown_version[4..6].copy_from_slice(&2_u16.to_le_bytes());
    assert_eq!(
        decode_host_record(HostRecordDomain::ChainDatabase, &unknown_version)
            .err()
            .unwrap_or_else(|| panic!("unknown version must fail"))
            .kind(),
        HostCodecErrorKind::UnsupportedVersion
    );

    let mut unknown_domain = encoded.clone();
    unknown_domain[8..12].copy_from_slice(&99_u32.to_le_bytes());
    assert_eq!(
        decode_host_record(HostRecordDomain::ChainDatabase, &unknown_domain)
            .err()
            .unwrap_or_else(|| panic!("unknown domain must fail"))
            .kind(),
        HostCodecErrorKind::UnknownDomain
    );

    let mut truncated = encoded;
    let _ = truncated.pop();
    assert_eq!(
        decode_host_record(HostRecordDomain::ChainDatabase, &truncated)
            .err()
            .unwrap_or_else(|| panic!("truncated record must fail"))
            .kind(),
        HostCodecErrorKind::LengthMismatch
    );
}

#[test]
fn each_domain_rejects_payloads_above_its_own_limit() {
    let domain = HostRecordDomain::EncryptedSecretBlob;
    let oversized = vec![0_u8; domain.max_payload_bytes() + 1];
    let error = encode_host_record(domain, &oversized)
        .err()
        .unwrap_or_else(|| panic!("oversized secret envelope must fail"));
    assert_eq!(error.kind(), HostCodecErrorKind::PayloadTooLarge);
    assert_eq!(error.ffi_code(), CitizenSdkErrorCode::InvalidArgument);
}

#[test]
fn malformed_records_map_to_decode_without_echoing_stored_bytes() {
    let error = decode_host_record(HostRecordDomain::WalletProfile, b"not an envelope")
        .err()
        .unwrap_or_else(|| panic!("malformed host bytes must fail"));
    assert_eq!(error.kind(), HostCodecErrorKind::Malformed);
    assert_eq!(error.ffi_code(), CitizenSdkErrorCode::Decode);
    assert!(!error.to_string().contains("not an envelope"));
}

#[test]
fn singleton_models_and_per_execution_history_round_trip_through_strict_binary_codecs() {
    let chain = ChainDatabaseSnapshot::new(0, None);
    let encoded = encode_chain_database_snapshot(&chain)
        .unwrap_or_else(|error| panic!("chain encode failed: {error}"));
    assert_eq!(
        decode_chain_database_snapshot(&encoded)
            .unwrap_or_else(|error| panic!("chain decode failed: {error}")),
        chain
    );

    let runtime = RuntimeContext::try_new(
        VerifiedBlockRef::finalized(Hash32::from_bytes([21; 32]), 34),
        RuntimeVersion::new(55, 89),
        vec![0x6d, 0x65, 0x74, 0x61],
    )
    .unwrap_or_else(|error| panic!("runtime fixture failed: {error}"));
    let encoded = encode_runtime_context(&runtime)
        .unwrap_or_else(|error| panic!("runtime encode failed: {error}"));
    assert_eq!(
        decode_runtime_context(&encoded)
            .unwrap_or_else(|error| panic!("runtime decode failed: {error}")),
        runtime
    );

    let wallet = WalletState::empty();
    let encoded = encode_wallet_state(&wallet)
        .unwrap_or_else(|error| panic!("wallet encode failed: {error}"));
    assert_eq!(
        decode_wallet_state(&encoded)
            .unwrap_or_else(|error| panic!("wallet decode failed: {error}")),
        wallet
    );

    let history = baseline_execution(0);
    let encoded = encode_transaction_execution_record(&history)
        .unwrap_or_else(|error| panic!("history record encode failed: {error}"));
    assert_eq!(
        decode_transaction_execution_record(&encoded)
            .unwrap_or_else(|error| panic!("history record decode failed: {error}")),
        history
    );

    let secret_ref = secret_ref(1, 2, 3, 4);
    let secret = EncryptedSecretBlobSnapshot::empty();
    let encoded = encode_encrypted_secret_blob_snapshot(secret_ref, &secret)
        .unwrap_or_else(|error| panic!("secret encode failed: {error}"));
    assert_eq!(
        decode_encrypted_secret_blob_snapshot(secret_ref, &encoded)
            .unwrap_or_else(|error| panic!("secret decode failed: {error}")),
        secret
    );
}

#[test]
fn wallet_v3_round_trips_selection_and_rejects_old_versions_without_fallback() {
    let account_id = AccountId32::from_bytes([0x91; 32]);
    let cold = ColdWalletAccount::try_new(
        1,
        account_id,
        citizen_ss58_address(account_id),
        "离线账户",
        123,
    )
    .unwrap_or_else(|error| panic!("cold fixture failed: {error}"));
    let state = WalletState::try_from_catalog_parts(
        9,
        None,
        vec![cold],
        vec![account_id],
        2,
        None,
        None,
        Vec::new(),
    )
    .and_then(|state| state.try_with_active_wallet(Some(1)))
    .unwrap_or_else(|error| panic!("wallet fixture failed: {error}"));
    let encoded = encode_wallet_state(&state)
        .unwrap_or_else(|error| panic!("wallet v3 encode failed: {error}"));
    assert_eq!(
        decode_wallet_state(&encoded)
            .unwrap_or_else(|error| panic!("wallet v3 decode failed: {error}")),
        state
    );
    let payload = decode_host_record(HostRecordDomain::WalletProfile, &encoded)
        .unwrap_or_else(|error| panic!("wallet envelope failed: {error}"))
        .payload();
    assert_eq!(&payload[..2], &3_u16.to_le_bytes());
    assert_eq!(state.active_wallet_index(), Some(1));

    // 使用完整有效载荷再仅改版本，避免靠损坏/截断碰巧触发失败。
    for version in [0_u16, 1, 2, 4, u16::MAX] {
        let mut unsupported = payload.to_vec();
        unsupported[..2].copy_from_slice(&version.to_le_bytes());
        let encoded = encode_host_record(HostRecordDomain::WalletProfile, &unsupported)
            .unwrap_or_else(|error| panic!("version fixture failed: {error}"));
        let error = decode_wallet_state(&encoded).err()
            .unwrap_or_else(|| panic!("unsupported wallet version must be rejected"));
        assert_eq!(error.kind(), HostCodecErrorKind::UnsupportedVersion);
    }
    for selection in [[2_u8, 1, 0, 0, 0], [1, 99, 0, 0, 0]] {
        let mut invalid = payload.to_vec();
        invalid[10..15].copy_from_slice(&selection);
        let encoded = encode_host_record(HostRecordDomain::WalletProfile, &invalid)
            .unwrap_or_else(|error| panic!("selection fixture failed: {error}"));
        assert!(decode_wallet_state(&encoded).is_err(), "坏presence/不存在钱包不能变成默认选择");
    }
}

fn secret_ref(wallet_index: u32, generation: u8, owner: u8, account: u8) -> SecretRef {
    SecretRef::account_mini_secret(
        wallet_index,
        VaultGeneration::from_bytes([generation; 16]),
        SecretOwner::from_bytes([owner; 16]),
        AccountId32::from_bytes([account; 32]),
    )
}

#[test]
fn encrypted_secret_records_bind_the_complete_secret_ref_even_for_tombstones() {
    let expected = secret_ref(7, 8, 9, 10);
    let sealed = EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        1,
        EncryptedSecretBlobState::Sealed {
            provisioning_operation_id: [11; 16],
            envelope: EncryptedSecretEnvelope::try_new(
                1,
                Hash32Bytes::from_bytes([12; 32]),
                vec![13; 48],
            )
            .unwrap_or_else(|error| panic!("test envelope failed: {error}")),
        },
    )
    .unwrap_or_else(|error| panic!("sealed snapshot failed: {error}"));
    let tombstone = EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        1,
        EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [14; 16],
        },
    )
    .unwrap_or_else(|error| panic!("tombstone snapshot failed: {error}"));

    for snapshot in [&sealed, &tombstone] {
        let encoded = encode_encrypted_secret_blob_snapshot(expected, snapshot)
            .unwrap_or_else(|error| panic!("secret record encode failed: {error}"));
        assert_eq!(
            decode_encrypted_secret_blob_snapshot(expected, &encoded)
                .unwrap_or_else(|error| panic!("same-ref decode failed: {error}")),
            *snapshot
        );

        for crossed in [
            secret_ref(8, 8, 9, 10),
            secret_ref(7, 7, 9, 10),
            secret_ref(7, 8, 8, 10),
            secret_ref(7, 8, 9, 11),
        ] {
            assert_eq!(
                decode_encrypted_secret_blob_snapshot(crossed, &encoded)
                    .err()
                    .unwrap_or_else(|| panic!("crossed SecretRef must fail"))
                    .ffi_code(),
                CitizenSdkErrorCode::Integrity
            );
        }
    }
}

#[test]
fn encrypted_secret_record_rejects_truncation_and_trailing_bytes() {
    let secret_ref = secret_ref(1, 2, 3, 4);
    let snapshot = EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        1,
        EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [5; 16],
        },
    )
    .unwrap_or_else(|error| panic!("snapshot failed: {error}"));
    let encoded = encode_encrypted_secret_blob_snapshot(secret_ref, &snapshot)
        .unwrap_or_else(|error| panic!("encode failed: {error}"));

    let mut truncated = encoded.clone();
    let _ = truncated.pop();
    assert!(decode_encrypted_secret_blob_snapshot(secret_ref, &truncated).is_err());

    let mut trailing = encoded;
    trailing.push(0);
    assert!(decode_encrypted_secret_blob_snapshot(secret_ref, &trailing).is_err());
}

#[test]
fn wallet_v3_round_trips_independent_hot_name_without_changing_account_label() {
    use citizen_sdk_contracts::{WalletAccount, WalletOrigin, WalletProfile};
    let account_id = AccountId32::from_bytes([4; 32]);
    let account = WalletAccount::try_new(0, account_id, secret_ref(0, 1, 2, 4),
        citizen_ss58_address(account_id), "账户名称", 100)
        .unwrap_or_else(|error| panic!("account fixture: {error}"));
    let profile = WalletProfile::try_new(0, VaultGeneration::from_bytes([1; 16]),
        account_id, WalletOrigin::Created, 100, account_id, vec![account])
        .and_then(|profile| profile.try_with_wallet_name("独立钱包名称"))
        .unwrap_or_else(|error| panic!("profile fixture: {error}"));
    let state = WalletState::try_from_parts(7, Some(profile), None, None, Vec::new())
        .and_then(|state| state.try_with_active_wallet(Some(0)))
        .unwrap_or_else(|error| panic!("state fixture: {error}"));
    let encoded = encode_wallet_state(&state).unwrap_or_else(|error| panic!("encode: {error}"));
    let decoded = decode_wallet_state(&encoded).unwrap_or_else(|error| panic!("decode: {error}"));
    assert_eq!(decoded, state);
    let profile = decoded.profile().unwrap_or_else(|| panic!("profile required"));
    assert_eq!(profile.wallet_name(), "独立钱包名称");
    assert_eq!(profile.accounts()[0].name(), "账户名称");
    assert_eq!(decoded.active_wallet_index(), Some(0));
    for length in 0..encoded.len() {
        assert!(decode_wallet_state(&encoded[..length]).is_err(), "截断不能返回部分目录");
    }
}
