#include <stddef.h>
#include "citizensdk.h"

#ifdef __cplusplus
#include <type_traits>
#define ABI_SIZE(type, expected)                                                \
  static_assert(sizeof(type) == (expected), #type " size ABI")
#define ABI_ALIGN(type, expected)                                               \
  static_assert(alignof(type) == (expected), #type " align ABI")
#define ABI_OFFSET(type, field, expected)                                       \
  static_assert(offsetof(type, field) == (expected), #type "." #field " ABI")
#define ABI_FUNCTION(name, return_type, ...)                                    \
  using name##_signature_t = return_type (*)(__VA_ARGS__);                      \
  name##_signature_t const name##_reference = &(name);                          \
  static_assert(                                                               \
      std::is_same<decltype(&(name)), name##_signature_t>::value,               \
      #name " signature ABI")
#else
#define ABI_SIZE(type, expected)                                                \
  _Static_assert(sizeof(type) == (expected), #type " size ABI")
#define ABI_ALIGN(type, expected)                                               \
  _Static_assert(_Alignof(type) == (expected), #type " align ABI")
#define ABI_OFFSET(type, field, expected)                                       \
  _Static_assert(offsetof(type, field) == (expected), #type "." #field " ABI")
#define ABI_FUNCTION(name, return_type, ...)                                    \
  typedef return_type (*name##_signature_t)(__VA_ARGS__);                       \
  name##_signature_t const name##_reference = &(name);                          \
  _Static_assert(_Generic(&(name), name##_signature_t: 1, default: 0),          \
                 #name " signature ABI")
#endif

_Static_assert(sizeof(void *) == 8, "CitizenSDK v1 ABI requires 64-bit hosts");
_Static_assert(CITIZENSDK_OK == 0, "success code ABI");
_Static_assert(CITIZENSDK_FAILURE_STAGE_ADMISSION == 1 &&
                   CITIZENSDK_FAILURE_STAGE_VALIDATION == 2 &&
                   CITIZENSDK_FAILURE_STAGE_AUTHENTICATION == 3 &&
                   CITIZENSDK_FAILURE_STAGE_PERSISTENCE == 4 &&
                   CITIZENSDK_FAILURE_STAGE_PROVIDER == 5 &&
                   CITIZENSDK_FAILURE_STAGE_VERIFICATION == 6 &&
                   CITIZENSDK_FAILURE_STAGE_CANCELLATION == 7 &&
                   CITIZENSDK_FAILURE_STAGE_TEARDOWN == 8,
               "failure stage ABI");
_Static_assert(CITIZENSDK_EXTERNAL_SIGNER_QR_V1 == 1,
               "external signer literal ABI");
_Static_assert(CITIZENSDK_SIGNING_COMPLETED == 1,
               "signing status literal ABI");

ABI_SIZE(citizensdk_bytes_view_t, 16);
ABI_OFFSET(citizensdk_bytes_view_t, data, 0);
ABI_OFFSET(citizensdk_bytes_view_t, len, 8);

ABI_SIZE(citizensdk_create_options_t, 88);
ABI_OFFSET(citizensdk_create_options_t, struct_size, 0);
ABI_OFFSET(citizensdk_create_options_t, abi_version, 4);
ABI_OFFSET(citizensdk_create_options_t, asset_manifest, 8);
ABI_OFFSET(citizensdk_create_options_t, chain_spec, 24);
ABI_OFFSET(citizensdk_create_options_t, light_sync_state, 40);
ABI_OFFSET(citizensdk_create_options_t, system_name, 56);
ABI_OFFSET(citizensdk_create_options_t, system_version, 72);

ABI_SIZE(citizensdk_block_ref_t, 56);
ABI_OFFSET(citizensdk_block_ref_t, struct_size, 0);
ABI_OFFSET(citizensdk_block_ref_t, abi_version, 4);
ABI_OFFSET(citizensdk_block_ref_t, hash, 8);
ABI_OFFSET(citizensdk_block_ref_t, number, 40);
ABI_OFFSET(citizensdk_block_ref_t, finality, 48);
ABI_OFFSET(citizensdk_block_ref_t, reserved, 52);

ABI_SIZE(citizensdk_capability_status_t, 16);
ABI_OFFSET(citizensdk_capability_status_t, name, 0);
ABI_OFFSET(citizensdk_capability_status_t, reason, 4);
ABI_OFFSET(citizensdk_capability_status_t, supported, 8);
ABI_OFFSET(citizensdk_capability_status_t, available, 9);
ABI_OFFSET(citizensdk_capability_status_t, enabled, 10);
ABI_OFFSET(citizensdk_capability_status_t, ready, 11);
ABI_OFFSET(citizensdk_capability_status_t, reserved, 12);

ABI_SIZE(citizensdk_capability_snapshot_t, 184);
ABI_OFFSET(citizensdk_capability_snapshot_t, struct_size, 0);
ABI_OFFSET(citizensdk_capability_snapshot_t, abi_version, 4);
ABI_OFFSET(citizensdk_capability_snapshot_t, revision, 8);
ABI_OFFSET(citizensdk_capability_snapshot_t, count, 16);
ABI_OFFSET(citizensdk_capability_snapshot_t, reserved, 20);
ABI_OFFSET(citizensdk_capability_snapshot_t, statuses, 24);

ABI_SIZE(citizensdk_event_t, 48);
ABI_OFFSET(citizensdk_event_t, struct_size, 0);
ABI_OFFSET(citizensdk_event_t, abi_version, 4);
ABI_OFFSET(citizensdk_event_t, event_type, 8);
ABI_OFFSET(citizensdk_event_t, reserved, 12);
ABI_OFFSET(citizensdk_event_t, sequence, 16);
ABI_OFFSET(citizensdk_event_t, request_id, 24);
ABI_OFFSET(citizensdk_event_t, result, 32);
ABI_OFFSET(citizensdk_event_t, capability_revision, 40);

ABI_SIZE(citizensdk_result_info_t, 32);
ABI_OFFSET(citizensdk_result_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_result_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_result_info_t, error_code, 8);
ABI_OFFSET(citizensdk_result_info_t, kind, 12);
ABI_OFFSET(citizensdk_result_info_t, payload_len, 16);
ABI_OFFSET(citizensdk_result_info_t, error_message_len, 24);

ABI_SIZE(citizensdk_wallet_state_info_t, 56);
ABI_ALIGN(citizensdk_wallet_state_info_t, 8);
ABI_OFFSET(citizensdk_wallet_state_info_t, revision, 8);
ABI_OFFSET(citizensdk_wallet_state_info_t, account_count, 16);
ABI_OFFSET(citizensdk_wallet_state_info_t, has_default_account, 20);
ABI_OFFSET(citizensdk_wallet_state_info_t, default_account_id, 24);
ABI_SIZE(citizensdk_wallet_diagnostic_info_v1_t, 80);
ABI_ALIGN(citizensdk_wallet_diagnostic_info_v1_t, 8);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, wallet_index, 8);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, diagnostic_reason, 12);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, has_ss58_address, 16);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, sign_mode, 20);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, account_id, 24);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, wallet_name_len, 56);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, ss58_address_len, 64);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, cleanup_account_count, 72);
ABI_OFFSET(citizensdk_wallet_diagnostic_info_v1_t, delete_wallet_wide_key, 76);
ABI_FUNCTION(citizensdk_wallet_state_get_diagnostic_cleanup_account, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t, uint32_t, citizensdk_account_id_t *);
ABI_FUNCTION(citizensdk_wallet_state_retain, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_result_handle_t, citizensdk_result_handle_t *);
ABI_FUNCTION(citizensdk_wallet_state_get_diagnostic_count, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t *);
ABI_FUNCTION(citizensdk_wallet_state_get_diagnostic_at, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t, citizensdk_wallet_diagnostic_info_v1_t *);
ABI_FUNCTION(citizensdk_wallet_state_copy_diagnostic_text, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t, uint32_t, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_repair_hot_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_result_handle_t, uint32_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_rename_diagnostic_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_result_handle_t, uint32_t, citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_delete_diagnostic_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_result_handle_t, uint32_t, citizensdk_request_id_t *);

ABI_SIZE(citizensdk_wallet_state_account_info_t, 88);
ABI_ALIGN(citizensdk_wallet_state_account_info_t, 8);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, sign_mode, 8);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, wallet_index, 12);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, has_account_index, 16);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, account_index, 20);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, is_default, 24);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, account_id, 32);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, created_at_millis, 64);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, ss58_address_len, 72);
ABI_OFFSET(citizensdk_wallet_state_account_info_t, name_len, 80);

ABI_SIZE(citizensdk_signing_outcome_info_t, 112);
ABI_ALIGN(citizensdk_signing_outcome_info_t, 8);
ABI_OFFSET(citizensdk_signing_outcome_info_t, status, 8);
ABI_OFFSET(citizensdk_signing_outcome_info_t, transport, 12);
ABI_OFFSET(citizensdk_signing_outcome_info_t, account_id, 16);
ABI_OFFSET(citizensdk_signing_outcome_info_t, payload_hash, 48);
ABI_OFFSET(citizensdk_signing_outcome_info_t, expires_at, 80);
ABI_OFFSET(citizensdk_signing_outcome_info_t, signature_len, 88);
ABI_OFFSET(citizensdk_signing_outcome_info_t, session_id_len, 96);
ABI_OFFSET(citizensdk_signing_outcome_info_t, transport_request_len, 104);

ABI_SIZE(citizensdk_default_account_change_info_t, 112);
ABI_ALIGN(citizensdk_default_account_change_info_t, 8);
ABI_OFFSET(citizensdk_default_account_change_info_t, status, 8);
ABI_OFFSET(citizensdk_default_account_change_info_t, transport, 12);
ABI_OFFSET(citizensdk_default_account_change_info_t, current_default_account_id, 16);
ABI_OFFSET(citizensdk_default_account_change_info_t, payload_hash, 48);
ABI_OFFSET(citizensdk_default_account_change_info_t, expires_at, 80);
ABI_OFFSET(citizensdk_default_account_change_info_t, committed_revision, 88);
ABI_OFFSET(citizensdk_default_account_change_info_t, session_id_len, 96);
ABI_OFFSET(citizensdk_default_account_change_info_t, transport_request_len, 104);

ABI_SIZE(citizensdk_runtime_context_info_t, 80);
ABI_OFFSET(citizensdk_runtime_context_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_runtime_context_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_runtime_context_info_t, block, 8);
ABI_OFFSET(citizensdk_runtime_context_info_t, spec_version, 64);
ABI_OFFSET(citizensdk_runtime_context_info_t, transaction_version, 68);
ABI_OFFSET(citizensdk_runtime_context_info_t, metadata_len, 72);

ABI_SIZE(citizensdk_watch_event_info_t, 112);
ABI_OFFSET(citizensdk_watch_event_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_watch_event_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_watch_event_info_t, status, 8);
ABI_OFFSET(citizensdk_watch_event_info_t, peer_count, 12);
ABI_OFFSET(citizensdk_watch_event_info_t, has_block, 16);
ABI_OFFSET(citizensdk_watch_event_info_t, has_replacement_hash, 17);
ABI_OFFSET(citizensdk_watch_event_info_t, reserved, 18);
ABI_OFFSET(citizensdk_watch_event_info_t, block, 24);
ABI_OFFSET(citizensdk_watch_event_info_t, replacement_hash, 80);

ABI_SIZE(citizensdk_execution_info_t, 88);
ABI_OFFSET(citizensdk_execution_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_execution_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_execution_info_t, status, 8);
ABI_OFFSET(citizensdk_execution_info_t, reason_or_dispatch_variant, 12);
ABI_OFFSET(citizensdk_execution_info_t, has_block, 16);
ABI_OFFSET(citizensdk_execution_info_t, has_extrinsic_index, 17);
ABI_OFFSET(citizensdk_execution_info_t, has_module, 18);
ABI_OFFSET(citizensdk_execution_info_t, reserved, 19);
ABI_OFFSET(citizensdk_execution_info_t, block, 24);
ABI_OFFSET(citizensdk_execution_info_t, extrinsic_index, 80);
ABI_OFFSET(citizensdk_execution_info_t, pallet_index, 84);
ABI_OFFSET(citizensdk_execution_info_t, error_index, 85);
ABI_OFFSET(citizensdk_execution_info_t, reserved_tail, 86);

ABI_SIZE(citizensdk_exported_state_info_t, 80);
ABI_OFFSET(citizensdk_exported_state_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_exported_state_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_exported_state_info_t, format_version, 8);
ABI_OFFSET(citizensdk_exported_state_info_t, reserved, 12);
ABI_OFFSET(citizensdk_exported_state_info_t, finalized, 16);
ABI_OFFSET(citizensdk_exported_state_info_t, database_len, 72);

ABI_SIZE(citizensdk_u128_t, 16);
ABI_ALIGN(citizensdk_u128_t, 8);
ABI_OFFSET(citizensdk_u128_t, low, 0);
ABI_OFFSET(citizensdk_u128_t, high, 8);

ABI_SIZE(citizensdk_account_id_t, 32);
ABI_ALIGN(citizensdk_account_id_t, 1);
ABI_OFFSET(citizensdk_account_id_t, bytes, 0);

ABI_SIZE(citizensdk_mutable_bytes_view_t, 16);
ABI_ALIGN(citizensdk_mutable_bytes_view_t, 8);
ABI_OFFSET(citizensdk_mutable_bytes_view_t, data, 0);
ABI_OFFSET(citizensdk_mutable_bytes_view_t, len, 8);

ABI_SIZE(citizensdk_host_hash32_t, 32);
ABI_ALIGN(citizensdk_host_hash32_t, 1);
ABI_OFFSET(citizensdk_host_hash32_t, bytes, 0);

ABI_SIZE(citizensdk_host_id128_t, 16);
ABI_ALIGN(citizensdk_host_id128_t, 1);
ABI_OFFSET(citizensdk_host_id128_t, bytes, 0);

ABI_SIZE(citizensdk_host_secret_ref_v1_t, 80);
ABI_ALIGN(citizensdk_host_secret_ref_v1_t, 4);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, wallet_index, 8);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, kind, 12);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, generation, 16);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, owner, 32);
ABI_OFFSET(citizensdk_host_secret_ref_v1_t, account_id, 48);

ABI_SIZE(citizensdk_host_wallet_key_ref_v1_t, 32);
ABI_ALIGN(citizensdk_host_wallet_key_ref_v1_t, 4);
ABI_OFFSET(citizensdk_host_wallet_key_ref_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_wallet_key_ref_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_wallet_key_ref_v1_t, wallet_index, 8);
ABI_OFFSET(citizensdk_host_wallet_key_ref_v1_t, reserved, 12);
ABI_OFFSET(citizensdk_host_wallet_key_ref_v1_t, generation, 16);

ABI_SIZE(citizensdk_host_record_result_v1_t, 56);
ABI_ALIGN(citizensdk_host_record_result_v1_t, 8);
ABI_OFFSET(citizensdk_host_record_result_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_record_result_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_record_result_v1_t, host_operation_id, 8);
ABI_OFFSET(citizensdk_host_record_result_v1_t, error_code, 16);
ABI_OFFSET(citizensdk_host_record_result_v1_t, domain, 20);
ABI_OFFSET(citizensdk_host_record_result_v1_t, present, 24);
ABI_OFFSET(citizensdk_host_record_result_v1_t, reserved, 25);
ABI_OFFSET(citizensdk_host_record_result_v1_t, revision, 32);
ABI_OFFSET(citizensdk_host_record_result_v1_t, record, 40);

ABI_SIZE(citizensdk_host_status_result_v1_t, 24);
ABI_ALIGN(citizensdk_host_status_result_v1_t, 8);
ABI_OFFSET(citizensdk_host_status_result_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_status_result_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_status_result_v1_t, host_operation_id, 8);
ABI_OFFSET(citizensdk_host_status_result_v1_t, error_code, 16);
ABI_OFFSET(citizensdk_host_status_result_v1_t, reserved, 20);

ABI_SIZE(citizensdk_host_bool_result_v1_t, 32);
ABI_ALIGN(citizensdk_host_bool_result_v1_t, 8);
ABI_OFFSET(citizensdk_host_bool_result_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_bool_result_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_bool_result_v1_t, host_operation_id, 8);
ABI_OFFSET(citizensdk_host_bool_result_v1_t, error_code, 16);
ABI_OFFSET(citizensdk_host_bool_result_v1_t, value, 20);
ABI_OFFSET(citizensdk_host_bool_result_v1_t, reserved, 21);

ABI_SIZE(citizensdk_host_vault_availability_result_v1_t, 24);
ABI_ALIGN(citizensdk_host_vault_availability_result_v1_t, 8);
ABI_OFFSET(citizensdk_host_vault_availability_result_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_vault_availability_result_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_vault_availability_result_v1_t, host_operation_id,
           8);
ABI_OFFSET(citizensdk_host_vault_availability_result_v1_t, error_code, 16);
ABI_OFFSET(citizensdk_host_vault_availability_result_v1_t, availability, 20);

ABI_SIZE(citizensdk_host_bytes_result_v1_t, 40);
ABI_ALIGN(citizensdk_host_bytes_result_v1_t, 8);
ABI_OFFSET(citizensdk_host_bytes_result_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_bytes_result_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_bytes_result_v1_t, host_operation_id, 8);
ABI_OFFSET(citizensdk_host_bytes_result_v1_t, error_code, 16);
ABI_OFFSET(citizensdk_host_bytes_result_v1_t, kind, 20);
ABI_OFFSET(citizensdk_host_bytes_result_v1_t, bytes, 24);

ABI_SIZE(citizensdk_host_public_store_v1_t, 72);
ABI_ALIGN(citizensdk_host_public_store_v1_t, 8);
ABI_OFFSET(citizensdk_host_public_store_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_public_store_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_public_store_v1_t, context, 8);
ABI_OFFSET(citizensdk_host_public_store_v1_t, chain_database_load, 16);
ABI_OFFSET(citizensdk_host_public_store_v1_t,
           chain_database_compare_and_swap, 24);
ABI_OFFSET(citizensdk_host_public_store_v1_t, runtime_cache_load, 32);
ABI_OFFSET(citizensdk_host_public_store_v1_t, runtime_cache_store, 40);
ABI_OFFSET(citizensdk_host_public_store_v1_t, runtime_cache_delete, 48);
ABI_OFFSET(citizensdk_host_public_store_v1_t, transaction_history_query, 56);
ABI_OFFSET(citizensdk_host_public_store_v1_t, transaction_history_mutate, 64);

ABI_SIZE(citizensdk_host_secure_store_v1_t, 48);
ABI_ALIGN(citizensdk_host_secure_store_v1_t, 8);
ABI_OFFSET(citizensdk_host_secure_store_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_secure_store_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_secure_store_v1_t, context, 8);
ABI_OFFSET(citizensdk_host_secure_store_v1_t, wallet_profile_load, 16);
ABI_OFFSET(citizensdk_host_secure_store_v1_t,
           wallet_profile_compare_and_swap, 24);
ABI_OFFSET(citizensdk_host_secure_store_v1_t, encrypted_secret_blob_load, 32);
ABI_OFFSET(citizensdk_host_secure_store_v1_t,
           encrypted_secret_blob_compare_and_swap, 40);

ABI_SIZE(citizensdk_host_secret_vault_v1_t, 72);
ABI_ALIGN(citizensdk_host_secret_vault_v1_t, 8);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, context, 8);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, availability, 16);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, ensure_wallet_kek, 24);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, has_wallet_kek, 32);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, wrap_dek, 40);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, unwrap_dek, 48);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, retire_wallet_kek, 56);
ABI_OFFSET(citizensdk_host_secret_vault_v1_t, authorize_add_accounts, 64);

/* 新增独立存在性结构，不扩长上方原Host v1结构。 */
ABI_SIZE(citizensdk_host_secret_presence_v1_t, 32);
ABI_ALIGN(citizensdk_host_secret_presence_v1_t, 8);
ABI_OFFSET(citizensdk_host_secret_presence_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_secret_presence_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_secret_presence_v1_t, context, 8);
ABI_OFFSET(citizensdk_host_secret_presence_v1_t, has_account_secret, 16);
ABI_OFFSET(citizensdk_host_secret_presence_v1_t, has_any_wallet_key, 24);
ABI_FUNCTION(citizensdk_set_secret_presence_provider, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_host_secret_presence_v1_t *);
ABI_FUNCTION(citizensdk_encrypted_secret_record_has_secret, citizensdk_error_code_t,
             const citizensdk_account_id_t *, uint64_t, citizensdk_bytes_view_t, uint8_t *);

ABI_SIZE(citizensdk_host_services_v1_t, 32);
ABI_ALIGN(citizensdk_host_services_v1_t, 8);
ABI_OFFSET(citizensdk_host_services_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_host_services_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_host_services_v1_t, public_store, 8);
ABI_OFFSET(citizensdk_host_services_v1_t, secure_store, 16);
ABI_OFFSET(citizensdk_host_services_v1_t, secret_vault, 24);

ABI_SIZE(citizensdk_account_balance_info_t, 144);
ABI_ALIGN(citizensdk_account_balance_info_t, 8);
ABI_OFFSET(citizensdk_account_balance_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_account_balance_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_account_balance_info_t, block, 8);
ABI_OFFSET(citizensdk_account_balance_info_t, account_id, 64);
ABI_OFFSET(citizensdk_account_balance_info_t, free_fen, 96);
ABI_OFFSET(citizensdk_account_balance_info_t, reserved_fen, 112);
ABI_OFFSET(citizensdk_account_balance_info_t, total_fen, 128);

ABI_SIZE(citizensdk_account_nonce_info_t, 104);
ABI_ALIGN(citizensdk_account_nonce_info_t, 8);
ABI_OFFSET(citizensdk_account_nonce_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_account_nonce_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_account_nonce_info_t, best_block, 8);
ABI_OFFSET(citizensdk_account_nonce_info_t, account_id, 64);
ABI_OFFSET(citizensdk_account_nonce_info_t, nonce, 96);

ABI_SIZE(citizensdk_fee_snapshot_info_t, 104);
ABI_ALIGN(citizensdk_fee_snapshot_info_t, 8);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, best_block, 8);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, fee_rate_parts, 64);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, reserved, 68);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, minimum_fee_fen, 72);
ABI_OFFSET(citizensdk_fee_snapshot_info_t, existential_deposit_fen, 88);

ABI_SIZE(citizensdk_wallet_profile_info_t, 96);
ABI_ALIGN(citizensdk_wallet_profile_info_t, 8);
ABI_OFFSET(citizensdk_wallet_profile_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_wallet_profile_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_wallet_profile_info_t, present, 8);
ABI_OFFSET(citizensdk_wallet_profile_info_t, origin, 12);
ABI_OFFSET(citizensdk_wallet_profile_info_t, wallet_index, 16);
ABI_OFFSET(citizensdk_wallet_profile_info_t, account_count, 20);
ABI_OFFSET(citizensdk_wallet_profile_info_t, created_at_millis, 24);
ABI_OFFSET(citizensdk_wallet_profile_info_t, master_account_id, 32);
ABI_OFFSET(citizensdk_wallet_profile_info_t, active_account_id, 64);

ABI_SIZE(citizensdk_wallet_account_info_t, 72);
ABI_ALIGN(citizensdk_wallet_account_info_t, 8);
ABI_OFFSET(citizensdk_wallet_account_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_wallet_account_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_wallet_account_info_t, index, 8);
ABI_OFFSET(citizensdk_wallet_account_info_t, is_active, 12);
ABI_OFFSET(citizensdk_wallet_account_info_t, account_id, 16);
ABI_OFFSET(citizensdk_wallet_account_info_t, created_at_millis, 48);
ABI_OFFSET(citizensdk_wallet_account_info_t, ss58_address_len, 56);
ABI_OFFSET(citizensdk_wallet_account_info_t, name_len, 64);

ABI_SIZE(citizensdk_prepared_wallet_info_t, 16);
ABI_ALIGN(citizensdk_prepared_wallet_info_t, 8);
ABI_OFFSET(citizensdk_prepared_wallet_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_prepared_wallet_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_prepared_wallet_info_t, prepared_wallet, 8);

ABI_SIZE(citizensdk_prepared_transaction_info_t, 168);
ABI_ALIGN(citizensdk_prepared_transaction_info_t, 8);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, prepared_transaction, 8);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, preparation_id, 16);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, source_account_id, 32);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, call_data_hash, 64);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, best_block, 96);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, runtime_spec_number, 152);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, transaction_format_number, 156);
ABI_OFFSET(citizensdk_prepared_transaction_info_t, nonce, 160);

ABI_SIZE(citizensdk_transaction_execution_id_t, 16);
ABI_ALIGN(citizensdk_transaction_execution_id_t, 1);
ABI_OFFSET(citizensdk_transaction_execution_id_t, bytes, 0);

ABI_SIZE(citizensdk_transaction_execution_info_t, 288);
ABI_ALIGN(citizensdk_transaction_execution_info_t, 8);
ABI_OFFSET(citizensdk_transaction_execution_info_t, status, 8);
ABI_OFFSET(citizensdk_transaction_execution_info_t, transport, 12);
ABI_OFFSET(citizensdk_transaction_execution_info_t, execution_id, 16);
ABI_OFFSET(citizensdk_transaction_execution_info_t, source_account_id, 32);
ABI_OFFSET(citizensdk_transaction_execution_info_t, call_data_hash, 64);
ABI_OFFSET(citizensdk_transaction_execution_info_t, transaction_hash, 96);
ABI_OFFSET(citizensdk_transaction_execution_info_t, expires_at, 128);
ABI_OFFSET(citizensdk_transaction_execution_info_t, has_block, 136);
ABI_OFFSET(citizensdk_transaction_execution_info_t, has_extrinsic_index, 140);
ABI_OFFSET(citizensdk_transaction_execution_info_t, has_dispatch_failure, 144);
ABI_OFFSET(citizensdk_transaction_execution_info_t, has_module_failure, 148);
ABI_OFFSET(citizensdk_transaction_execution_info_t, has_replacement_hash, 152);
ABI_OFFSET(citizensdk_transaction_execution_info_t, dispatch_variant, 156);
ABI_OFFSET(citizensdk_transaction_execution_info_t, pallet_index, 160);
ABI_OFFSET(citizensdk_transaction_execution_info_t, error_index, 164);
ABI_OFFSET(citizensdk_transaction_execution_info_t, block, 168);
ABI_OFFSET(citizensdk_transaction_execution_info_t, extrinsic_index, 224);
ABI_OFFSET(citizensdk_transaction_execution_info_t, replacement_hash, 228);
ABI_OFFSET(citizensdk_transaction_execution_info_t, session_id_len, 264);
ABI_OFFSET(citizensdk_transaction_execution_info_t, transport_request_len, 272);
ABI_OFFSET(citizensdk_transaction_execution_info_t, pool_rejection_reason_len, 280);

ABI_SIZE(citizensdk_transaction_history_page_info_t, 40);
ABI_ALIGN(citizensdk_transaction_history_page_info_t, 8);
ABI_OFFSET(citizensdk_transaction_history_page_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_transaction_history_page_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_transaction_history_page_info_t, revision, 8);
ABI_OFFSET(citizensdk_transaction_history_page_info_t, record_count, 16);
ABI_OFFSET(citizensdk_transaction_history_page_info_t,
           has_next_before_execution_id, 20);
ABI_OFFSET(citizensdk_transaction_history_page_info_t,
           next_before_execution_id, 24);

ABI_SIZE(citizensdk_transaction_history_record_info_t, 336);
ABI_ALIGN(citizensdk_transaction_history_record_info_t, 8);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, struct_size, 0);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, abi_version, 4);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, execution_id, 8);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, source_account_id, 24);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, call_data_hash, 56);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, transaction_hash, 88);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, status, 120);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, has_block, 124);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, block, 128);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, has_execution, 184);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, has_replacement_hash, 188);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, execution, 192);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, replacement_hash, 280);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, created_at_millis, 312);
ABI_OFFSET(citizensdk_transaction_history_record_info_t, updated_at_millis, 320);
ABI_OFFSET(citizensdk_transaction_history_record_info_t,
           pool_rejection_reason_len, 328);

_Static_assert(CITIZENSDK_CAPABILITY_COUNT == 10, "capability count ABI");
_Static_assert(CITIZENSDK_UNVERIFIED_PROVIDER_FAILURE == 12,
               "unverified reason ABI");
_Static_assert(CITIZENSDK_DISPATCH_ERROR_ROOT_NOT_ALLOWED == 13,
               "dispatch variant ABI");

_Static_assert(CITIZENSDK_HOST_DEK_BYTES == 32, "host DEK bytes ABI");
_Static_assert(CITIZENSDK_HOST_RECORD_CHAIN_DATABASE == 1,
               "host record domain ABI");
_Static_assert(CITIZENSDK_HOST_RECORD_RUNTIME_CACHE == 2,
               "host record domain ABI");
_Static_assert(CITIZENSDK_HOST_RECORD_WALLET_PROFILE == 3,
               "host record domain ABI");
_Static_assert(CITIZENSDK_HOST_RECORD_TRANSACTION_HISTORY == 4,
               "host record domain ABI");
_Static_assert(CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB == 5,
               "host record domain ABI");
_Static_assert(CITIZENSDK_HOST_SECRET_ACCOUNT_MINI_SECRET == 1,
               "host secret kind ABI");
_Static_assert(CITIZENSDK_HOST_VAULT_AVAILABLE == 1,
               "host vault availability ABI");
_Static_assert(CITIZENSDK_HOST_VAULT_NO_STRONG_USER_AUTHENTICATION == 2,
               "host vault availability ABI");
_Static_assert(CITIZENSDK_HOST_VAULT_UNSUPPORTED == 3,
               "host vault availability ABI");
_Static_assert(CITIZENSDK_HOST_VAULT_UNAVAILABLE == 4,
               "host vault availability ABI");
_Static_assert(CITIZENSDK_HOST_BYTES_WRAPPED_DEK == 1,
               "host bytes kind ABI");
_Static_assert(CITIZENSDK_RESULT_ACCOUNT_BALANCE == 9, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_ACCOUNT_NONCE == 10, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_FEE_SNAPSHOT == 11, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_WALLET_PROFILE == 12, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_WALLET_ACCOUNTS == 13, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_SIGNATURE == 14, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_PREPARED_WALLET == 15, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_TRANSACTION_HISTORY_PAGE == 17,
               "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_ACCOUNT_BALANCES == 18, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_QR_REVIEW == 19, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_QR_SIGNED == 20, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_WALLET_STATE == 21, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_SIGNING_OUTCOME == 22, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_DEFAULT_ACCOUNT_CHANGE == 23, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_PREPARED_TRANSACTION == 27, "result kind ABI");
_Static_assert(CITIZENSDK_RESULT_TRANSACTION_EXECUTION == 28, "result kind ABI");
_Static_assert(CITIZENSDK_TRANSACTION_EXECUTION_EXTERNAL_PENDING == 1,
               "transaction execution status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS == 2,
               "transaction execution status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_FAILED == 3,
               "transaction execution status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_EXECUTION_POOL_REJECTED == 4,
               "transaction execution status ABI");
_Static_assert(CITIZENSDK_SIGNING_TRANSFORM_RAW == 1, "signing transform ABI");
_Static_assert(CITIZENSDK_SIGNING_TRANSFORM_SUBSTRATE_PAYLOAD == 2, "signing transform ABI");
_Static_assert(CITIZENSDK_SIGNING_TRANSFORM_BLAKE2_DOMAIN == 3, "signing transform ABI");
_Static_assert(CITIZENSDK_EXTERNAL_SIGNER_NONE == 0, "external signer ABI");
_Static_assert(CITIZENSDK_EXTERNAL_SIGNER_QR_V1 == 1, "external signer ABI");
_Static_assert(CITIZENSDK_SIGNING_COMPLETED == 1, "signing status ABI");
_Static_assert(CITIZENSDK_SIGNING_EXTERNAL_PENDING == 2, "signing status ABI");
_Static_assert(CITIZENSDK_WALLET_WORDS_12 == 12, "wallet word count ABI");
_Static_assert(CITIZENSDK_WALLET_WORDS_18 == 18, "wallet word count ABI");
_Static_assert(CITIZENSDK_WALLET_WORDS_24 == 24, "wallet word count ABI");
_Static_assert(CITIZENSDK_WALLET_ORIGIN_CREATED == 1, "wallet origin ABI");
_Static_assert(CITIZENSDK_WALLET_ORIGIN_IMPORTED == 2, "wallet origin ABI");
_Static_assert(CITIZENSDK_TRANSACTION_HISTORY_PENDING == 1,
               "transaction history status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_HISTORY_IN_BLOCK == 2,
               "transaction history status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_HISTORY_POOL_REJECTED == 3,
               "transaction history status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_HISTORY_FINALIZED_SUCCESS == 4,
               "transaction history status ABI");
_Static_assert(CITIZENSDK_TRANSACTION_HISTORY_FINALIZED_FAILED == 5,
               "transaction history status ABI");

ABI_FUNCTION(citizensdk_abi_version, uint32_t, void);
ABI_FUNCTION(citizensdk_create_options_size, uint32_t, void);
ABI_FUNCTION(citizensdk_validate_modules, citizensdk_error_code_t, uint32_t);
ABI_FUNCTION(citizensdk_accept_request_sequence, citizensdk_error_code_t, citizensdk_handle_t, uint64_t);
ABI_FUNCTION(citizensdk_create_with_modules, citizensdk_error_code_t,
             const citizensdk_create_options_t *,
             const citizensdk_host_services_v1_t *, uint32_t, citizensdk_handle_t *);
ABI_FUNCTION(citizensdk_verify_signature, citizensdk_error_code_t,
             const citizensdk_account_id_t *, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, uint8_t *);
ABI_FUNCTION(citizensdk_create, citizensdk_error_code_t,
             const citizensdk_create_options_t *, citizensdk_handle_t *);
ABI_FUNCTION(citizensdk_create_with_host, citizensdk_error_code_t,
             const citizensdk_create_options_t *,
             const citizensdk_host_services_v1_t *, citizensdk_handle_t *);
ABI_FUNCTION(citizensdk_destroy, citizensdk_error_code_t, citizensdk_handle_t);
ABI_FUNCTION(citizensdk_set_event_callback, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_event_callback_t, void *);
ABI_FUNCTION(citizensdk_get_capabilities, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_capability_snapshot_t *);
ABI_FUNCTION(citizensdk_get_lifecycle, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_lifecycle_t *);
ABI_FUNCTION(citizensdk_subscribe_capability_changes, citizensdk_error_code_t,
             citizensdk_handle_t);
ABI_FUNCTION(citizensdk_unsubscribe_capability_changes,
             citizensdk_error_code_t, citizensdk_handle_t);
ABI_FUNCTION(citizensdk_start, citizensdk_error_code_t, citizensdk_handle_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_stop, citizensdk_error_code_t, citizensdk_handle_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_cancel_request, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t);
ABI_FUNCTION(citizensdk_refresh_capabilities, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_best_head, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_finalized_head, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_storage_at, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_block_ref_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_storage_batch_at, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_block_ref_t *,
             const citizensdk_bytes_view_t *, uint32_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_runtime_context_at, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_block_ref_t *,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_finalized_account_balance,
             citizensdk_error_code_t, citizensdk_handle_t,
             const citizensdk_account_id_t *, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_genesis_hash, citizensdk_error_code_t,
             citizensdk_handle_t, uint8_t *);
ABI_FUNCTION(citizensdk_get_finalized_account_balances, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *, uint32_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_account_nonce, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_best_fee_snapshot, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_qr_parse, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_qr_create_sign_request, citizensdk_error_code_t,
             citizensdk_handle_t, uint16_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, uint64_t, uint8_t *, uint64_t,
             uint64_t *);
ABI_FUNCTION(citizensdk_review_qr_sign_request, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_sign_qr_request, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_result_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_result_copy_qr, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_qr_consume_sign_response, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t, uint8_t *);
ABI_FUNCTION(citizensdk_qr_cancel_sign_request, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t, uint8_t *);
ABI_FUNCTION(citizensdk_qr_encode_account_id, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *, uint8_t *,
             uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_get_wallet_profile, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_get_wallet_state, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_import_cold_account_id, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_import_cold_account_ss58, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_reorder_wallet_accounts_without_default_change,
             citizensdk_error_code_t, citizensdk_handle_t, uint64_t,
             const citizensdk_account_id_t *, uint32_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_begin_signing, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, citizensdk_signing_transform_t,
             citizensdk_bytes_view_t, citizensdk_external_signer_transport_t,
             uint16_t, uint64_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_consume_external_signature, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_cancel_signing_session, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t, uint8_t *);
ABI_FUNCTION(citizensdk_begin_default_account_change, citizensdk_error_code_t,
             citizensdk_handle_t, uint64_t, const citizensdk_account_id_t *,
             uint32_t, uint64_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_consume_default_account_change, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_rename_account, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_delete_account, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_request_id_t *);
/* 无UI输入及资源合同：冻结准确布局和签名，不再接受旧二入口。 */
ABI_SIZE(citizensdk_wallet_input_validation_v1_t, 16);
ABI_ALIGN(citizensdk_wallet_input_validation_v1_t, 4);
ABI_OFFSET(citizensdk_wallet_input_validation_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_wallet_input_validation_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_wallet_input_validation_v1_t, reason, 8);
ABI_OFFSET(citizensdk_wallet_input_validation_v1_t, position, 12);
ABI_SIZE(citizensdk_private_key_receiver_v1_t, 40);
ABI_ALIGN(citizensdk_private_key_receiver_v1_t, 8);
ABI_OFFSET(citizensdk_private_key_receiver_v1_t, struct_size, 0);
ABI_OFFSET(citizensdk_private_key_receiver_v1_t, abi_version, 4);
ABI_OFFSET(citizensdk_private_key_receiver_v1_t, context, 8);
ABI_OFFSET(citizensdk_private_key_receiver_v1_t, receive, 16);
ABI_OFFSET(citizensdk_private_key_receiver_v1_t, settled, 24);
ABI_OFFSET(citizensdk_private_key_receiver_v1_t, authorizing, 32);
_Static_assert(CITIZENSDK_EVENT_WALLET_CHANGED == 7, "wallet event ABI");
ABI_FUNCTION(citizensdk_validate_wallet_input, citizensdk_error_code_t,
             uint32_t, citizensdk_bytes_view_t, citizensdk_wallet_word_count_t,
             citizensdk_wallet_input_validation_v1_t *);
ABI_FUNCTION(citizensdk_private_key_open, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             const citizensdk_private_key_receiver_v1_t *, uint64_t *,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_private_key_reveal, citizensdk_error_code_t,
             citizensdk_handle_t, uint64_t);
ABI_FUNCTION(citizensdk_private_key_cancel, citizensdk_error_code_t,
             citizensdk_handle_t, uint64_t);
ABI_FUNCTION(citizensdk_private_key_finish, citizensdk_error_code_t,
             citizensdk_handle_t, uint64_t);
ABI_FUNCTION(citizensdk_wallet_state_get_initialization, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t *, uint8_t *);
ABI_FUNCTION(citizensdk_add_next_wallet_account, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_sign_and_delete_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_set_active_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, uint64_t, uint32_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_rename_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, uint64_t, uint32_t, citizensdk_bytes_view_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_wallet_state_get_active_wallet, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *, uint32_t *);
ABI_FUNCTION(citizensdk_wallet_profile_copy_name, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_encode_signing_payload, citizensdk_error_code_t,
             uint32_t, citizensdk_bytes_view_t, citizensdk_bytes_view_t,
             uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_qr_encode_document, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_qr_prepare_account_authorization, citizensdk_error_code_t,
             citizensdk_handle_t, uint32_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_qr_validate_sign_response, int32_t,
             citizensdk_handle_t, citizensdk_bytes_view_t, citizensdk_bytes_view_t);
ABI_FUNCTION(citizensdk_wallet_word_suggestions, citizensdk_error_code_t,
             citizensdk_bytes_view_t, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_prepare_wallet_creation, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_wallet_word_count_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_prepared_wallet_copy_mnemonic,
             citizensdk_error_code_t, citizensdk_handle_t,
             citizensdk_prepared_wallet_handle_t, uint8_t *, uint64_t,
             uint64_t *);
ABI_FUNCTION(citizensdk_prepared_wallet_release, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_prepared_wallet_handle_t);
ABI_FUNCTION(citizensdk_commit_wallet_creation, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_prepared_wallet_handle_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_import_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_add_wallet_accounts, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_bytes_view_t, const uint32_t *, uint32_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_set_active_wallet_account, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_rename_wallet_account, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_delete_wallet_account, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_delete_wallet, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_reconcile_wallet_cleanup, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_sign_wallet_payload, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_prepare_transaction, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_account_id_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_prepared_transaction_release, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_prepared_transaction_handle_t);
ABI_FUNCTION(citizensdk_execute_prepared_transaction, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_prepared_transaction_handle_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_transaction_execution_consume_qr_response,
             citizensdk_error_code_t, citizensdk_handle_t,
             const citizensdk_transaction_execution_id_t *,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_transaction_execution_cancel, citizensdk_error_code_t,
             citizensdk_handle_t,
             const citizensdk_transaction_execution_id_t *);
ABI_FUNCTION(citizensdk_get_transaction_history, citizensdk_error_code_t,
             citizensdk_handle_t,
             const citizensdk_transaction_execution_id_t *, uint32_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_sync_transaction_history, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_submit_extrinsic, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_watch_extrinsic, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_bytes_view_t,
             citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_verify_transaction_at, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_block_ref_t *,
             citizensdk_bytes_view_t, const uint8_t *, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_export_state, citizensdk_error_code_t,
             citizensdk_handle_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_import_state, citizensdk_error_code_t,
             citizensdk_handle_t, const citizensdk_block_ref_t *, uint32_t,
             citizensdk_bytes_view_t, citizensdk_request_id_t *);
ABI_FUNCTION(citizensdk_result_get_info, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_result_info_t *);
ABI_FUNCTION(citizensdk_result_get_failure_stage, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_failure_stage_t *);
ABI_FUNCTION(citizensdk_result_copy_error_message, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_block_ref, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_block_ref_t *);
ABI_FUNCTION(citizensdk_result_copy_storage, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *, uint8_t *, uint64_t,
             uint64_t *);
ABI_FUNCTION(citizensdk_result_get_storage_batch_count,
             citizensdk_error_code_t, citizensdk_result_handle_t, uint32_t *);
ABI_FUNCTION(citizensdk_result_copy_storage_batch_item,
             citizensdk_error_code_t, citizensdk_result_handle_t, uint32_t,
             uint8_t *, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_runtime_context,
             citizensdk_error_code_t, citizensdk_result_handle_t,
             citizensdk_runtime_context_info_t *, uint8_t *, uint64_t,
             uint64_t *);
ABI_FUNCTION(citizensdk_result_get_hash, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *);
ABI_FUNCTION(citizensdk_result_get_execution, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_execution_info_t *);
ABI_FUNCTION(citizensdk_result_get_watch_event, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_watch_event_info_t *);
ABI_FUNCTION(citizensdk_result_get_exported_state, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_exported_state_info_t *,
             uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_account_balance, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_account_balance_info_t *);
ABI_FUNCTION(citizensdk_result_get_account_balance_count, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t *);
ABI_FUNCTION(citizensdk_result_get_account_balance_at, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t, citizensdk_account_balance_info_t *);
ABI_FUNCTION(citizensdk_result_get_account_nonce, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_account_nonce_info_t *);
ABI_FUNCTION(citizensdk_result_get_fee_snapshot, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_fee_snapshot_info_t *);
ABI_FUNCTION(citizensdk_result_estimate_fee, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_u128_t,
             citizensdk_u128_t *, citizensdk_u128_t *);
ABI_FUNCTION(citizensdk_result_get_wallet_profile, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_wallet_profile_info_t *);
ABI_FUNCTION(citizensdk_result_get_wallet_state, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_wallet_state_info_t *);
ABI_FUNCTION(citizensdk_result_get_wallet_state_account,
             citizensdk_error_code_t, citizensdk_result_handle_t, uint32_t,
             citizensdk_wallet_state_account_info_t *, uint8_t *, uint64_t,
             uint64_t *, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_wallet_account_count,
             citizensdk_error_code_t, citizensdk_result_handle_t, uint32_t *);
ABI_FUNCTION(citizensdk_result_get_wallet_account, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint32_t,
             citizensdk_wallet_account_info_t *, uint8_t *, uint64_t,
             uint64_t *, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_signature, citizensdk_error_code_t,
             citizensdk_result_handle_t, uint8_t *);
ABI_FUNCTION(citizensdk_result_get_signing_outcome, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_signing_outcome_info_t *,
             uint8_t *, uint64_t, uint64_t *, uint8_t *, uint64_t, uint64_t *,
             uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_default_account_change, citizensdk_error_code_t,
             citizensdk_result_handle_t, citizensdk_default_account_change_info_t *,
             uint8_t *, uint64_t, uint64_t *, uint8_t *, uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_get_prepared_wallet,
             citizensdk_error_code_t, citizensdk_result_handle_t,
             citizensdk_prepared_wallet_info_t *);
ABI_FUNCTION(citizensdk_result_get_prepared_transaction,
             citizensdk_error_code_t, citizensdk_result_handle_t,
             citizensdk_prepared_transaction_info_t *);
ABI_FUNCTION(citizensdk_result_get_transaction_execution,
             citizensdk_error_code_t, citizensdk_result_handle_t,
             citizensdk_transaction_execution_info_t *, uint8_t *, uint64_t,
             uint64_t *, uint8_t *, uint64_t, uint64_t *, uint8_t *, uint64_t,
             uint64_t *);
ABI_FUNCTION(citizensdk_result_get_transaction_history_page,
             citizensdk_error_code_t, citizensdk_result_handle_t,
             citizensdk_transaction_history_page_info_t *);
ABI_FUNCTION(citizensdk_result_get_transaction_history_record,
             citizensdk_error_code_t, citizensdk_result_handle_t, uint32_t,
             citizensdk_transaction_history_record_info_t *, uint8_t *,
             uint64_t, uint64_t *);
ABI_FUNCTION(citizensdk_result_release, citizensdk_error_code_t,
             citizensdk_result_handle_t);
ABI_FUNCTION(citizensdk_last_error_copy, citizensdk_error_code_t, uint8_t *,
             uint64_t, uint64_t *);

int main(void) { return citizensdk_abi_version() == CITIZENSDK_ABI_VERSION ? 0 : 1; }
