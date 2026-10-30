use std::mem::align_of;
use std::mem::offset_of;
use std::mem::size_of;

use citizensdk::abi::CitizenSdkAccountBalanceInfo;
use citizensdk::abi::CitizenSdkAccountId;
use citizensdk::abi::CitizenSdkAccountNonceInfo;
use citizensdk::abi::CitizenSdkBlockBodyInfo;
use citizensdk::abi::CitizenSdkBlockHeaderInfo;
use citizensdk::abi::CitizenSdkBlockRef;
use citizensdk::abi::CitizenSdkBytesView;
use citizensdk::abi::CitizenSdkCapabilitySnapshot;
use citizensdk::abi::CitizenSdkCapabilityStatus;
use citizensdk::abi::CitizenSdkChainSyncStatusInfo;
use citizensdk::abi::CitizenSdkCreateOptions;
use citizensdk::abi::CitizenSdkDefaultAccountChangeInfo;
use citizensdk::abi::CitizenSdkEvent;
use citizensdk::abi::CitizenSdkEventType;
use citizensdk::abi::CitizenSdkExecutionInfo;
use citizensdk::abi::CitizenSdkExportedStateInfo;
use citizensdk::abi::CitizenSdkFailureStage;
use citizensdk::abi::CitizenSdkFeeSnapshotInfo;
use citizensdk::abi::CitizenSdkHostBoolResultV1;
use citizensdk::abi::CitizenSdkHostBytesKind;
use citizensdk::abi::CitizenSdkHostBytesResultV1;
use citizensdk::abi::CitizenSdkHostId128;
use citizensdk::abi::CitizenSdkHostSecretVaultV1;
use citizensdk::abi::CitizenSdkHostStatusResultV1;
use citizensdk::abi::CitizenSdkHostVaultAvailability;
use citizensdk::abi::CitizenSdkHostVaultAvailabilityResultV1;
use citizensdk::abi::CitizenSdkHostWalletKeyRefV1;
use citizensdk::abi::CitizenSdkMutableBytesView;
use citizensdk::abi::CitizenSdkPreparedTransactionInfo;
use citizensdk::abi::CitizenSdkPreparedWalletInfo;
use citizensdk::abi::CitizenSdkResultInfo;
use citizensdk::abi::CitizenSdkResultKind;
use citizensdk::abi::CitizenSdkRuntimeContextInfo;
use citizensdk::abi::CitizenSdkSigningOutcomeInfo;
use citizensdk::abi::CitizenSdkTransactionExecutionId;
use citizensdk::abi::CitizenSdkTransactionExecutionInfo;
use citizensdk::abi::CitizenSdkTransactionExecutionStatus;
use citizensdk::abi::CitizenSdkTransactionHistoryPageInfo;
use citizensdk::abi::CitizenSdkTransactionHistoryRecordInfo;
use citizensdk::abi::CitizenSdkTransactionHistoryStatus;
use citizensdk::abi::CitizenSdkU128;
use citizensdk::abi::CitizenSdkWalletAccountInfo;
use citizensdk::abi::CitizenSdkWalletOrigin;
use citizensdk::abi::CitizenSdkWalletProfileInfo;
use citizensdk::abi::CitizenSdkWalletStateAccountInfo;
use citizensdk::abi::CitizenSdkWalletStateInfo;
use citizensdk::abi::CitizenSdkWalletWordCount;
use citizensdk::abi::CitizenSdkWatchEventInfo;
use citizensdk::abi::CITIZENSDK_ABI_VERSION;
use citizensdk::abi::CITIZENSDK_CAPABILITY_COUNT;
use citizensdk::abi::CITIZENSDK_HOST_DEK_BYTES;

macro_rules! assert_layout {
    ($type:ty, $size:expr, $align:expr, {$($field:ident: $offset:expr),+ $(,)?}) => {{
        assert_eq!(size_of::<$type>(), $size, concat!(stringify!($type), " size"));
        assert_eq!(align_of::<$type>(), $align, concat!(stringify!($type), " align"));
        $(
            assert_eq!(
                offset_of!($type, $field),
                $offset,
                concat!(stringify!($type), ".", stringify!($field), " offset"),
            );
        )+
    }};
}

#[test]
fn original_public_layout_remains_frozen() {
    assert_eq!(CITIZENSDK_ABI_VERSION, 2);
    assert_eq!(CITIZENSDK_CAPABILITY_COUNT, 10);
    assert_eq!(CitizenSdkFailureStage::Admission as u32, 1);
    assert_eq!(CitizenSdkFailureStage::Validation as u32, 2);
    assert_eq!(CitizenSdkFailureStage::Authentication as u32, 3);
    assert_eq!(CitizenSdkFailureStage::Persistence as u32, 4);
    assert_eq!(CitizenSdkFailureStage::Provider as u32, 5);
    assert_eq!(CitizenSdkFailureStage::Verification as u32, 6);
    assert_eq!(CitizenSdkFailureStage::Cancellation as u32, 7);
    assert_eq!(CitizenSdkFailureStage::Teardown as u32, 8);
    assert_eq!(CitizenSdkEventType::HistoryChanged as u32, 5);
    assert_eq!(CitizenSdkEventType::FinalizedBlockChanged as u32, 6);

    assert_layout!(CitizenSdkBytesView, 16, 8, { data: 0, len: 8 });
    assert_layout!(CitizenSdkU128, 16, 8, { low: 0, high: 8 });
    assert_layout!(CitizenSdkAccountId, 32, 1, { bytes: 0 });
    assert_layout!(CitizenSdkCreateOptions, 88, 8, {
        struct_size: 0,
        abi_version: 4,
        asset_manifest: 8,
        chain_spec: 24,
        light_sync_state: 40,
        system_name: 56,
        system_version: 72,
    });
    assert_layout!(CitizenSdkBlockRef, 56, 8, {
        struct_size: 0,
        abi_version: 4,
        hash: 8,
        number: 40,
        finality: 48,
        reserved: 52,
    });
    assert_layout!(CitizenSdkCapabilityStatus, 16, 4, {
        name: 0,
        reason: 4,
        supported: 8,
        available: 9,
        enabled: 10,
        ready: 11,
        reserved: 12,
    });
    assert_layout!(CitizenSdkCapabilitySnapshot, 184, 8, {
        struct_size: 0,
        abi_version: 4,
        revision: 8,
        count: 16,
        reserved: 20,
        statuses: 24,
    });
    assert_layout!(CitizenSdkEvent, 48, 8, {
        struct_size: 0,
        abi_version: 4,
        event_type: 8,
        reserved: 12,
        sequence: 16,
        request_id: 24,
        result: 32,
        capability_revision: 40,
    });
    assert_layout!(CitizenSdkResultInfo, 32, 8, {
        struct_size: 0,
        abi_version: 4,
        error_code: 8,
        kind: 12,
        payload_len: 16,
        error_message_len: 24,
    });
    assert_layout!(CitizenSdkSigningOutcomeInfo, 112, 8, {
        struct_size: 0,
        abi_version: 4,
        status: 8,
        transport: 12,
        account_id: 16,
        payload_hash: 48,
        expires_at: 80,
        signature_len: 88,
        session_id_len: 96,
        transport_request_len: 104,
    });
    assert_layout!(CitizenSdkDefaultAccountChangeInfo, 112, 8, {
        struct_size: 0,
        abi_version: 4,
        status: 8,
        transport: 12,
        current_default_account_id: 16,
        payload_hash: 48,
        expires_at: 80,
        committed_revision: 88,
        session_id_len: 96,
        transport_request_len: 104,
    });
    assert_layout!(CitizenSdkRuntimeContextInfo, 80, 8, {
        struct_size: 0,
        abi_version: 4,
        block: 8,
        spec_version: 64,
        transaction_version: 68,
        metadata_len: 72,
    });
    assert_layout!(CitizenSdkChainSyncStatusInfo, 136, 8, {
        struct_size: 0,
        abi_version: 4,
        peer_count: 8,
        is_syncing: 16,
        is_usable: 17,
        reserved: 18,
        best: 24,
        finalized: 80,
    });
    assert_layout!(CitizenSdkBlockHeaderInfo, 168, 8, {
        struct_size: 0,
        abi_version: 4,
        block: 8,
        parent_hash: 64,
        state_root: 96,
        extrinsics_root: 128,
        digest_len: 160,
    });
    assert_layout!(CitizenSdkBlockBodyInfo, 80, 8, {
        struct_size: 0,
        abi_version: 4,
        block: 8,
        extrinsic_count: 64,
        reserved: 68,
        total_bytes: 72,
    });
    assert_layout!(CitizenSdkWatchEventInfo, 112, 8, {
        struct_size: 0,
        abi_version: 4,
        status: 8,
        peer_count: 12,
        has_block: 16,
        has_replacement_hash: 17,
        reserved: 18,
        block: 24,
        replacement_hash: 80,
    });
    assert_layout!(CitizenSdkExecutionInfo, 88, 8, {
        struct_size: 0,
        abi_version: 4,
        status: 8,
        reason_or_dispatch_variant: 12,
        has_block: 16,
        has_extrinsic_index: 17,
        has_module: 18,
        reserved: 19,
        block: 24,
        extrinsic_index: 80,
        pallet_index: 84,
        error_index: 85,
        reserved_tail: 86,
    });
    assert_layout!(CitizenSdkExportedStateInfo, 80, 8, {
        struct_size: 0,
        abi_version: 4,
        format_version: 8,
        reserved: 12,
        finalized: 16,
        database_len: 72,
    });
    assert_eq!(CitizenSdkCapabilitySnapshot::default().count, 10);
}

#[test]
fn host_v1_layout_and_constants_are_exact() {
    assert_eq!(CITIZENSDK_HOST_DEK_BYTES, 32);

    assert_layout!(CitizenSdkMutableBytesView, 16, 8, { data: 0, len: 8 });

    assert_layout!(CitizenSdkHostId128, 16, 1, { bytes: 0 });

    assert_layout!(CitizenSdkHostWalletKeyRefV1, 32, 4, {
        struct_size: 0,
        abi_version: 4,
        wallet_index: 8,
        reserved: 12,
        generation: 16,
    });
    assert_layout!(CitizenSdkHostStatusResultV1, 24, 8, {
        struct_size: 0,
        abi_version: 4,
        host_operation_id: 8,
        error_code: 16,
        reserved: 20,
    });
    assert_layout!(CitizenSdkHostBoolResultV1, 32, 8, {
        struct_size: 0,
        abi_version: 4,
        host_operation_id: 8,
        error_code: 16,
        value: 20,
        reserved: 21,
    });
    assert_layout!(CitizenSdkHostVaultAvailabilityResultV1, 24, 8, {
        struct_size: 0,
        abi_version: 4,
        host_operation_id: 8,
        error_code: 16,
        availability: 20,
    });
    assert_layout!(CitizenSdkHostBytesResultV1, 40, 8, {
        struct_size: 0,
        abi_version: 4,
        host_operation_id: 8,
        error_code: 16,
        kind: 20,
        bytes: 24,
    });
    assert_layout!(CitizenSdkHostSecretVaultV1, 80, 8, {
        struct_size: 0,
        abi_version: 4,
        context: 8,
        availability: 16,
        ensure_wallet_kek: 24,
        has_wallet_kek: 32,
        wrap_dek: 40,
        unwrap_dek: 48,
        retire_wallet_kek: 56,
        authorize_add_accounts: 64,
        has_any_wallet_key: 72,
    });

    assert_eq!(CitizenSdkHostVaultAvailability::Available as u32, 1);
    assert_eq!(
        CitizenSdkHostVaultAvailability::NoStrongUserAuthentication as u32,
        2
    );
    assert_eq!(CitizenSdkHostVaultAvailability::Unsupported as u32, 3);
    assert_eq!(CitizenSdkHostVaultAvailability::Unavailable as u32, 4);
    assert_eq!(CitizenSdkHostBytesKind::WrappedDek as u32, 1);
}

#[test]
fn account_wallet_and_history_layout_and_constants_are_exact() {
    assert_layout!(CitizenSdkAccountBalanceInfo, 144, 8, {
        struct_size: 0,
        abi_version: 4,
        block: 8,
        account_id: 64,
        free_fen: 96,
        reserved_fen: 112,
        total_fen: 128,
    });
    assert_layout!(CitizenSdkAccountNonceInfo, 104, 8, {
        struct_size: 0,
        abi_version: 4,
        best_block: 8,
        account_id: 64,
        nonce: 96,
    });
    assert_layout!(CitizenSdkFeeSnapshotInfo, 104, 8, {
        struct_size: 0,
        abi_version: 4,
        best_block: 8,
        fee_rate_parts: 64,
        reserved: 68,
        minimum_fee_fen: 72,
        existential_deposit_fen: 88,
    });
    assert_layout!(CitizenSdkWalletProfileInfo, 96, 8, {
        struct_size: 0,
        abi_version: 4,
        present: 8,
        origin: 12,
        wallet_index: 16,
        account_count: 20,
        created_at_millis: 24,
        master_account_id: 32,
        active_account_id: 64,
    });
    assert_layout!(CitizenSdkWalletAccountInfo, 72, 8, {
        struct_size: 0,
        abi_version: 4,
        index: 8,
        is_active: 12,
        account_id: 16,
        created_at_millis: 48,
        ss58_address_len: 56,
        name_len: 64,
    });
    assert_layout!(CitizenSdkWalletStateInfo, 56, 8, {
        struct_size: 0,
        abi_version: 4,
        revision: 8,
        account_count: 16,
        has_default_account: 20,
        default_account_id: 24,
    });
    assert_layout!(CitizenSdkWalletStateAccountInfo, 88, 8, {
        struct_size: 0,
        abi_version: 4,
        sign_mode: 8,
        wallet_index: 12,
        has_account_index: 16,
        account_index: 20,
        is_default: 24,
        reserved: 28,
        account_id: 32,
        created_at_millis: 64,
        ss58_address_len: 72,
        name_len: 80,
    });
    assert_layout!(CitizenSdkPreparedWalletInfo, 16, 8, {
        struct_size: 0,
        abi_version: 4,
        prepared_wallet: 8,
    });
    assert_layout!(CitizenSdkPreparedTransactionInfo, 168, 8, {
        struct_size: 0,
        abi_version: 4,
        prepared_transaction: 8,
        preparation_id: 16,
        source_account_id: 32,
        call_data_hash: 64,
        best_block: 96,
        runtime_spec_number: 152,
        transaction_format_number: 156,
        nonce: 160,
    });
    assert_layout!(CitizenSdkTransactionExecutionId, 16, 1, { bytes: 0 });
    assert_layout!(CitizenSdkTransactionExecutionInfo, 288, 8, {
        struct_size: 0,
        abi_version: 4,
        status: 8,
        transport: 12,
        execution_id: 16,
        source_account_id: 32,
        call_data_hash: 64,
        transaction_hash: 96,
        expires_at: 128,
        has_block: 136,
        has_extrinsic_index: 140,
        has_dispatch_failure: 144,
        has_module_failure: 148,
        has_replacement_hash: 152,
        dispatch_variant: 156,
        pallet_index: 160,
        error_index: 164,
        block: 168,
        extrinsic_index: 224,
        replacement_hash: 228,
        session_id_len: 264,
        transport_request_len: 272,
        pool_rejection_reason_len: 280,
    });
    assert_layout!(CitizenSdkTransactionHistoryPageInfo, 40, 8, {
        struct_size: 0,
        abi_version: 4,
        revision: 8,
        record_count: 16,
        has_next_before_execution_id: 20,
        next_before_execution_id: 24,
    });
    assert_layout!(CitizenSdkTransactionHistoryRecordInfo, 336, 8, {
        struct_size: 0,
        abi_version: 4,
        execution_id: 8,
        source_account_id: 24,
        call_data_hash: 56,
        transaction_hash: 88,
        status: 120,
        has_block: 124,
        block: 128,
        has_execution: 184,
        has_replacement_hash: 188,
        execution: 192,
        replacement_hash: 280,
        created_at_millis: 312,
        updated_at_millis: 320,
        pool_rejection_reason_len: 328,
    });

    assert_eq!(CitizenSdkResultKind::AccountBalance as u32, 9);
    assert_eq!(CitizenSdkResultKind::AccountNonce as u32, 10);
    assert_eq!(CitizenSdkResultKind::FeeSnapshot as u32, 11);
    assert_eq!(CitizenSdkResultKind::WalletProfile as u32, 12);
    assert_eq!(CitizenSdkResultKind::WalletAccounts as u32, 13);
    assert_eq!(CitizenSdkResultKind::Signature as u32, 14);
    assert_eq!(CitizenSdkResultKind::PreparedWallet as u32, 15);
    assert_eq!(CitizenSdkResultKind::TransactionHistoryPage as u32, 17);
    assert_eq!(CitizenSdkResultKind::PreparedTransaction as u32, 27);
    assert_eq!(CitizenSdkResultKind::TransactionExecution as u32, 28);
    assert_eq!(
        CitizenSdkTransactionExecutionStatus::ExternalPending as u32,
        1
    );
    assert_eq!(
        CitizenSdkTransactionExecutionStatus::FinalizedSuccess as u32,
        2
    );
    assert_eq!(
        CitizenSdkTransactionExecutionStatus::FinalizedFailed as u32,
        3
    );
    assert_eq!(CitizenSdkTransactionExecutionStatus::PoolRejected as u32, 4);
    assert_eq!(CitizenSdkTransactionHistoryStatus::Pending as u32, 1);
    assert_eq!(
        CitizenSdkTransactionHistoryStatus::FinalizedFailed as u32,
        5
    );
    assert_eq!(CitizenSdkWalletWordCount::Words12 as u32, 12);
    assert_eq!(CitizenSdkWalletWordCount::Words18 as u32, 18);
    assert_eq!(CitizenSdkWalletWordCount::Words24 as u32, 24);
    assert_eq!(CitizenSdkWalletOrigin::Created as u32, 1);
    assert_eq!(CitizenSdkWalletOrigin::Imported as u32, 2);
    assert_eq!(CitizenSdkTransactionHistoryStatus::Pending as u32, 1);
    assert_eq!(CitizenSdkTransactionHistoryStatus::InBlock as u32, 2);
    assert_eq!(CitizenSdkTransactionHistoryStatus::PoolRejected as u32, 3);
    assert_eq!(
        CitizenSdkTransactionHistoryStatus::FinalizedSuccess as u32,
        4
    );
    assert_eq!(
        CitizenSdkTransactionHistoryStatus::FinalizedFailed as u32,
        5
    );
}

#[test]
fn sqlite_resource_layout_is_separate_from_existing_host_tables() {
    assert_layout!(citizensdk::abi::CitizenSdkSqlValue,32,8,{kind:0,reserved:4,integer:8,bytes:16});
    assert_layout!(citizensdk::abi::CitizenSdkStoreV1,64,8,{struct_size:0,abi_version:4,context:8,run:16,execute:24,query:32,begin:40,end:48,wal:56});
}

#[test]
fn stores_resource_group_layout_is_fixed() {
    assert_layout!(citizensdk::abi::CitizenSdkStoresV1,32,8,{struct_size:0,abi_version:4,public:8,secure:16,vault:24});
}
