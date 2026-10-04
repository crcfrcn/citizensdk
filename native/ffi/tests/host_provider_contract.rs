// These functions intentionally mirror a C host implementation.
#![allow(unsafe_code, clippy::too_many_arguments)]

use std::ffi::c_void;

use citizensdk::{
    decode_host_error_code, empty_bytes_view, settle_host_dispatch, validate_bool_result_v1,
    validate_bytes_result_v1, validate_host_services_presence, validate_mutable_dek_view,
    validate_public_store_v1, validate_record_result_v1, validate_secret_vault_v1,
    validate_secure_store_v1, validate_status_result_v1, validate_vault_availability_result_v1,
    CitizenSdkBytesView, CitizenSdkErrorCode, CitizenSdkHostBoolCompletionV1,
    CitizenSdkHostBoolResultV1, CitizenSdkHostBytesCompletionV1, CitizenSdkHostBytesKind,
    CitizenSdkHostBytesResultV1, CitizenSdkHostHash32, CitizenSdkHostId128,
    CitizenSdkHostPublicStoreV1, CitizenSdkHostRecordCompletionV1, CitizenSdkHostRecordDomain,
    CitizenSdkHostRecordResultV1, CitizenSdkHostSecretKind, CitizenSdkHostSecretRefV1,
    CitizenSdkHostSecretVaultV1, CitizenSdkHostSecureStoreV1, CitizenSdkHostServicesV1,
    CitizenSdkHostStatusCompletionV1, CitizenSdkHostStatusResultV1,
    CitizenSdkHostVaultAvailability, CitizenSdkHostVaultAvailabilityCompletionV1,
    CitizenSdkHostVaultAvailabilityResultV1, CitizenSdkHostWalletKeyRefV1,
    CitizenSdkMutableBytesView, HostCompletionKind, HostDispatchOutcome, HostOperationTracker,
    CITIZENSDK_ABI_VERSION, CITIZENSDK_HOST_DEK_BYTES,
};

unsafe extern "C" fn record_load(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn chain_cas(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _expected_revision: u64,
    _present: u8,
    _candidate_record: CitizenSdkBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn runtime_load(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _block_hash: CitizenSdkHostHash32,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn runtime_store(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _block_hash: CitizenSdkHostHash32,
    _candidate_record: CitizenSdkBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn runtime_delete(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _block_hash: CitizenSdkHostHash32,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn record_cas(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _expected_revision: u64,
    _candidate_record: CitizenSdkBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn history_query(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _query: CitizenSdkBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn encrypted_load(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _secret_ref: CitizenSdkHostSecretRefV1,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn encrypted_cas(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _secret_ref: CitizenSdkHostSecretRefV1,
    _expected_revision: u64,
    _candidate_record: CitizenSdkBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostRecordCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn vault_availability(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostVaultAvailabilityCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn vault_ensure(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    _provisioning_operation_id: CitizenSdkHostId128,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn vault_has(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostBoolCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn vault_wrap(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    _provisioning_operation_id: CitizenSdkHostId128,
    _plaintext_dek: CitizenSdkBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostBytesCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn vault_unwrap(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    _wrapped_dek: CitizenSdkBytesView,
    _plaintext_dek_out: CitizenSdkMutableBytesView,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

unsafe extern "C" fn vault_retire(
    _host_context: *mut c_void,
    _host_operation_id: u64,
    _wallet_key: CitizenSdkHostWalletKeyRefV1,
    _cleanup_operation_id: CitizenSdkHostId128,
    _sdk_context: *mut c_void,
    _completion: CitizenSdkHostStatusCompletionV1,
) -> i32 {
    CitizenSdkErrorCode::Ok.as_i32()
}

fn complete_public_store() -> CitizenSdkHostPublicStoreV1 {
    CitizenSdkHostPublicStoreV1 {
        chain_database_load: Some(record_load),
        chain_database_compare_and_swap: Some(chain_cas),
        runtime_cache_load: Some(runtime_load),
        runtime_cache_store: Some(runtime_store),
        runtime_cache_delete: Some(runtime_delete),
        transaction_history_query: Some(history_query),
        transaction_history_mutate: Some(record_cas),
        ..CitizenSdkHostPublicStoreV1::default()
    }
}

fn complete_secure_store() -> CitizenSdkHostSecureStoreV1 {
    CitizenSdkHostSecureStoreV1 {
        wallet_profile_load: Some(record_load),
        wallet_profile_compare_and_swap: Some(record_cas),
        encrypted_secret_blob_load: Some(encrypted_load),
        encrypted_secret_blob_compare_and_swap: Some(encrypted_cas),
        ..CitizenSdkHostSecureStoreV1::default()
    }
}

fn complete_vault() -> CitizenSdkHostSecretVaultV1 {
    CitizenSdkHostSecretVaultV1 {
        availability: Some(vault_availability),
        ensure_wallet_kek: Some(vault_ensure),
        has_wallet_kek: Some(vault_has),
        wrap_dek: Some(vault_wrap),
        unwrap_dek: Some(vault_unwrap),
        retire_wallet_kek: Some(vault_retire),
        authorize_add_accounts: Some(vault_ensure),
        ..CitizenSdkHostSecretVaultV1::default()
    }
}

#[test]
fn five_domains_and_physical_key_shapes_are_frozen() {
    assert_eq!(CitizenSdkHostRecordDomain::ChainDatabase as u32, 1);
    assert_eq!(CitizenSdkHostRecordDomain::RuntimeCache as u32, 2);
    assert_eq!(CitizenSdkHostRecordDomain::WalletProfile as u32, 3);
    assert_eq!(CitizenSdkHostRecordDomain::TransactionHistory as u32, 4);
    assert_eq!(CitizenSdkHostRecordDomain::EncryptedSecretBlob as u32, 5);
    assert_eq!(CitizenSdkHostSecretKind::AccountMiniSecret as u32, 1);
    assert_eq!(std::mem::size_of::<CitizenSdkHostSecretRefV1>(), 80);
    assert_eq!(std::mem::size_of::<CitizenSdkHostWalletKeyRefV1>(), 32);
    assert_eq!(CITIZENSDK_HOST_DEK_BYTES, 32);
}

#[test]
fn stores_are_complete_only_with_every_explicit_typed_callback() {
    let public = complete_public_store();
    let secure = complete_secure_store();
    let vault = complete_vault();
    assert!(validate_public_store_v1(&public).is_ok());
    assert!(validate_secure_store_v1(&secure).is_ok());
    assert!(validate_secret_vault_v1(&vault).is_ok());
    let mut without_add_authorization = vault;
    without_add_authorization.authorize_add_accounts = None;
    assert!(validate_secret_vault_v1(&without_add_authorization).is_err());
    let mut old_layout = vault;
    old_layout.struct_size = 64;
    assert!(validate_secret_vault_v1(&old_layout).is_err());

    let mut incomplete = public;
    incomplete.runtime_cache_delete = None;
    assert_eq!(
        validate_public_store_v1(&incomplete)
            .err()
            .unwrap_or_else(|| panic!("missing typed callback must fail"))
            .code(),
        CitizenSdkErrorCode::InvalidArgument
    );
}

#[test]
fn secure_store_and_vault_are_an_all_or_none_wallet_bundle() {
    let public = complete_public_store();
    let secure = complete_secure_store();
    let vault = complete_vault();
    let chain_only = CitizenSdkHostServicesV1 {
        public_store: &public,
        ..CitizenSdkHostServicesV1::default()
    };
    assert!(validate_host_services_presence(&chain_only).is_ok());

    let wallet = CitizenSdkHostServicesV1 {
        public_store: &public,
        secure_store: &secure,
        secret_vault: &vault,
        ..CitizenSdkHostServicesV1::default()
    };
    assert!(validate_host_services_presence(&wallet).is_ok());

    // 钱包／签名可完全不提供公开链仓储，但设备安全组仍不可拆开。
    let local_only = CitizenSdkHostServicesV1 {
        public_store: std::ptr::null(),
        ..wallet
    };
    assert!(validate_host_services_presence(&local_only).is_ok());
    assert!(validate_host_services_presence(&CitizenSdkHostServicesV1::default()).is_err());

    let incomplete = CitizenSdkHostServicesV1 {
        public_store: &public,
        secure_store: &secure,
        ..CitizenSdkHostServicesV1::default()
    };
    assert_eq!(
        validate_host_services_presence(&incomplete)
            .err()
            .unwrap_or_else(|| panic!("incomplete wallet bundle must fail"))
            .code(),
        CitizenSdkErrorCode::InvalidArgument
    );
}

#[test]
fn public_store_groups_are_independent_and_each_group_is_complete() {
    let complete = complete_public_store();
    let chain = CitizenSdkHostPublicStoreV1 {
        runtime_cache_load: None,
        runtime_cache_store: None,
        runtime_cache_delete: None,
        transaction_history_query: None,
        transaction_history_mutate: None,
        ..complete
    };
    assert!(validate_public_store_v1(&chain).is_ok());
    let history = CitizenSdkHostPublicStoreV1 {
        chain_database_load: None,
        chain_database_compare_and_swap: None,
        runtime_cache_load: None,
        runtime_cache_store: None,
        runtime_cache_delete: None,
        ..complete
    };
    assert!(validate_public_store_v1(&history).is_ok());
    let partial_chain = CitizenSdkHostPublicStoreV1 {
        chain_database_compare_and_swap: None,
        ..chain
    };
    let partial_history = CitizenSdkHostPublicStoreV1 {
        transaction_history_mutate: None,
        ..history
    };
    assert!(validate_public_store_v1(&partial_chain).is_err());
    assert!(validate_public_store_v1(&partial_history).is_err());
    assert!(validate_public_store_v1(&CitizenSdkHostPublicStoreV1::default()).is_err());
}

#[test]
fn accepted_host_operation_consumes_exactly_one_matching_completion() {
    let tracker = HostOperationTracker::default();
    let operation = tracker
        .reserve(HostCompletionKind::Record(
            CitizenSdkHostRecordDomain::WalletProfile,
        ))
        .unwrap_or_else(|error| panic!("reserve failed: {error}"));
    assert_eq!(
        settle_host_dispatch(&tracker, operation, CitizenSdkErrorCode::Ok.as_i32())
            .unwrap_or_else(|error| panic!("accept failed: {error}")),
        HostDispatchOutcome::Accepted
    );
    assert!(tracker
        .complete(
            operation,
            HostCompletionKind::Record(CitizenSdkHostRecordDomain::WalletProfile)
        )
        .is_ok());
    assert_eq!(
        tracker
            .complete(
                operation,
                HostCompletionKind::Record(CitizenSdkHostRecordDomain::WalletProfile)
            )
            .err()
            .unwrap_or_else(|| panic!("duplicate completion must fail"))
            .code(),
        CitizenSdkErrorCode::Integrity
    );
    assert_eq!(
        tracker
            .pending_count()
            .unwrap_or_else(|error| panic!("count failed: {error}")),
        0
    );
}

#[test]
fn wrong_completion_shape_is_terminal_and_rejected_operations_cannot_complete() {
    let tracker = HostOperationTracker::default();
    let wrong_shape = tracker
        .reserve(HostCompletionKind::Bytes(
            CitizenSdkHostBytesKind::WrappedDek,
        ))
        .unwrap_or_else(|error| panic!("reserve failed: {error}"));
    assert_eq!(
        tracker
            .complete(wrong_shape, HostCompletionKind::Status)
            .err()
            .unwrap_or_else(|| panic!("wrong shape must fail"))
            .code(),
        CitizenSdkErrorCode::Integrity
    );
    assert!(tracker
        .complete(
            wrong_shape,
            HostCompletionKind::Bytes(CitizenSdkHostBytesKind::WrappedDek)
        )
        .is_err());

    let rejected = tracker
        .reserve(HostCompletionKind::Status)
        .unwrap_or_else(|error| panic!("reserve failed: {error}"));
    assert_eq!(
        settle_host_dispatch(&tracker, rejected, CitizenSdkErrorCode::Storage.as_i32())
            .unwrap_or_else(|error| panic!("reject failed: {error}")),
        HostDispatchOutcome::Rejected(CitizenSdkErrorCode::Storage)
    );
    assert!(tracker
        .complete(rejected, HostCompletionKind::Status)
        .is_err());
}

#[test]
fn completion_results_validate_identity_domain_and_borrowed_buffer_shape() {
    let encoded = [7_u8; 56];
    let record = CitizenSdkHostRecordResultV1 {
        host_operation_id: 41,
        domain: CitizenSdkHostRecordDomain::WalletProfile as u32,
        present: 1,
        revision: 3,
        record: CitizenSdkBytesView {
            data: encoded.as_ptr(),
            len: encoded.len() as u64,
        },
        ..CitizenSdkHostRecordResultV1::default()
    };
    assert_eq!(
        validate_record_result_v1(&record, 41, CitizenSdkHostRecordDomain::WalletProfile)
            .unwrap_or_else(|error| panic!("record result failed: {error}")),
        CitizenSdkErrorCode::Ok
    );
    assert!(
        validate_record_result_v1(&record, 41, CitizenSdkHostRecordDomain::TransactionHistory)
            .is_err()
    );

    let mut status = CitizenSdkHostStatusResultV1 {
        host_operation_id: 42,
        ..CitizenSdkHostStatusResultV1::default()
    };
    assert!(validate_status_result_v1(&status, 42).is_ok());
    status.reserved = 1;
    assert!(validate_status_result_v1(&status, 42).is_err());

    let boolean = CitizenSdkHostBoolResultV1 {
        host_operation_id: 43,
        value: 1,
        ..CitizenSdkHostBoolResultV1::default()
    };
    assert_eq!(
        validate_bool_result_v1(&boolean, 43)
            .unwrap_or_else(|error| panic!("bool result failed: {error}")),
        (CitizenSdkErrorCode::Ok, true)
    );
}

#[test]
fn vault_results_are_limited_to_availability_and_wrapped_dek_material() {
    let availability = CitizenSdkHostVaultAvailabilityResultV1 {
        host_operation_id: 50,
        availability: CitizenSdkHostVaultAvailability::Available as u32,
        ..CitizenSdkHostVaultAvailabilityResultV1::default()
    };
    assert_eq!(
        validate_vault_availability_result_v1(&availability, 50)
            .unwrap_or_else(|error| panic!("availability failed: {error}")),
        (
            CitizenSdkErrorCode::Ok,
            Some(CitizenSdkHostVaultAvailability::Available)
        )
    );

    let wrapped_dek = [9_u8; 96];
    let wrapped = CitizenSdkHostBytesResultV1 {
        host_operation_id: 51,
        kind: CitizenSdkHostBytesKind::WrappedDek as u32,
        bytes: CitizenSdkBytesView {
            data: wrapped_dek.as_ptr(),
            len: wrapped_dek.len() as u64,
        },
        ..CitizenSdkHostBytesResultV1::default()
    };
    assert!(validate_bytes_result_v1(&wrapped, 51, CitizenSdkHostBytesKind::WrappedDek).is_ok());

    let failed_with_bytes = CitizenSdkHostBytesResultV1 {
        error_code: CitizenSdkErrorCode::AuthenticationCancelled.as_i32(),
        ..wrapped
    };
    assert!(
        validate_bytes_result_v1(&failed_with_bytes, 51, CitizenSdkHostBytesKind::WrappedDek)
            .is_err()
    );
    let failed_empty = CitizenSdkHostBytesResultV1 {
        bytes: empty_bytes_view(),
        ..failed_with_bytes
    };
    assert_eq!(
        validate_bytes_result_v1(&failed_empty, 51, CitizenSdkHostBytesKind::WrappedDek)
            .unwrap_or_else(|error| panic!("empty failed result should classify: {error}")),
        CitizenSdkErrorCode::AuthenticationCancelled
    );

    let mut rust_owned_dek = [0_u8; CITIZENSDK_HOST_DEK_BYTES as usize];
    let output = CitizenSdkMutableBytesView {
        data: rust_owned_dek.as_mut_ptr(),
        len: rust_owned_dek.len() as u64,
    };
    assert!(validate_mutable_dek_view(output).is_ok());
    assert!(validate_mutable_dek_view(CitizenSdkMutableBytesView {
        data: rust_owned_dek.as_mut_ptr(),
        len: (rust_owned_dek.len() - 1) as u64,
    })
    .is_err());
}

#[test]
fn host_error_numbers_are_frozen_and_unknown_values_become_internal() {
    for value in 0..=22 {
        assert_eq!(
            decode_host_error_code(value)
                .unwrap_or_else(|error| panic!("stable error {value} failed: {error}"))
                .as_i32(),
            value
        );
    }
    let error = decode_host_error_code(99)
        .err()
        .unwrap_or_else(|| panic!("unknown host error must fail"));
    assert_eq!(error.code(), CitizenSdkErrorCode::Internal);
    assert!(!error.message().contains("99"));
}

#[test]
fn versioned_defaults_are_canonical_and_do_not_own_host_buffers() {
    let secret_ref = CitizenSdkHostSecretRefV1::default();
    assert_eq!(secret_ref.abi_version, CITIZENSDK_ABI_VERSION);
    assert_eq!(
        secret_ref.struct_size as usize,
        std::mem::size_of::<CitizenSdkHostSecretRefV1>()
    );
    assert!(empty_bytes_view().data.is_null());
    assert_eq!(empty_bytes_view().len, 0);
}
