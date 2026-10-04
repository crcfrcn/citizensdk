#ifndef CITIZENSDK_TYPES_H
#define CITIZENSDK_TYPES_H

#include <stdint.h>

/* 本头文件是CitizenSDK跨语言公共C ABI类型、常量、结构布局与所有权合同的唯一真源。 */

/* Public numeric constants use direct typed literals so C, C++ and Swift all
 * consume the same exported ABI names without platform-specific projections. */

#define CITIZENSDK_ABI_VERSION 1U
#define CITIZENSDK_CAPABILITY_COUNT 10U

/* Immutable instance module selection. Transactions and history require chain.
 * Wallet may reuse crypto internally without enabling the public signing API. */
#define CITIZENSDK_MODULE_WALLET 1U
#define CITIZENSDK_MODULE_SIGNING 2U
#define CITIZENSDK_MODULE_CHAIN 4U
#define CITIZENSDK_MODULE_TRANSACTIONS 8U
#define CITIZENSDK_MODULE_HISTORY 16U
#define CITIZENSDK_MODULE_QR 32U
#define CITIZENSDK_MODULE_FULL 63U

typedef uint64_t citizensdk_handle_t;
typedef uint64_t citizensdk_request_id_t;
typedef uint64_t citizensdk_result_handle_t;
typedef uint64_t citizensdk_prepared_wallet_handle_t;
typedef uint64_t citizensdk_prepared_transaction_handle_t;
typedef struct citizensdk_transaction_execution_id {
  uint8_t bytes[16];
} citizensdk_transaction_execution_id_t;

typedef int32_t citizensdk_error_code_t;
#define CITIZENSDK_OK 0
#define CITIZENSDK_ERROR_INVALID_ARGUMENT 1
#define CITIZENSDK_ERROR_INVALID_HANDLE 2
#define CITIZENSDK_ERROR_INVALID_STATE 3
#define CITIZENSDK_ERROR_UNSUPPORTED 4
#define CITIZENSDK_ERROR_UNAVAILABLE 5
#define CITIZENSDK_ERROR_NOT_READY 6
#define CITIZENSDK_ERROR_NOT_FOUND 7
#define CITIZENSDK_ERROR_CONFLICT 8
#define CITIZENSDK_ERROR_INTEGRITY 9
#define CITIZENSDK_ERROR_AUTHENTICATION_CANCELLED 10
#define CITIZENSDK_ERROR_AUTHENTICATION_REQUIRED 11
#define CITIZENSDK_ERROR_KEY_INVALIDATED 12
#define CITIZENSDK_ERROR_PERMISSION_DENIED 13
#define CITIZENSDK_ERROR_STORAGE 14
#define CITIZENSDK_ERROR_NETWORK 15
#define CITIZENSDK_ERROR_DECODE 16
#define CITIZENSDK_ERROR_TIMEOUT 17
#define CITIZENSDK_ERROR_BUSY 18
#define CITIZENSDK_ERROR_QUEUE_FULL 19
#define CITIZENSDK_ERROR_INTERNAL 20
#define CITIZENSDK_ERROR_PANIC 21
#define CITIZENSDK_ERROR_CANCELLED 22

typedef uint32_t citizensdk_failure_stage_t;
#define CITIZENSDK_FAILURE_STAGE_ADMISSION 1U
#define CITIZENSDK_FAILURE_STAGE_VALIDATION 2U
#define CITIZENSDK_FAILURE_STAGE_AUTHENTICATION 3U
#define CITIZENSDK_FAILURE_STAGE_PERSISTENCE 4U
#define CITIZENSDK_FAILURE_STAGE_PROVIDER 5U
#define CITIZENSDK_FAILURE_STAGE_VERIFICATION 6U
#define CITIZENSDK_FAILURE_STAGE_CANCELLATION 7U
#define CITIZENSDK_FAILURE_STAGE_TEARDOWN 8U

typedef uint32_t citizensdk_lifecycle_t;
#define CITIZENSDK_LIFECYCLE_CREATED 1U
#define CITIZENSDK_LIFECYCLE_IMPORTING_STATE 2U
#define CITIZENSDK_LIFECYCLE_STARTING 3U
#define CITIZENSDK_LIFECYCLE_RUNNING 4U
#define CITIZENSDK_LIFECYCLE_START_FAILED 5U
#define CITIZENSDK_LIFECYCLE_STOPPED 6U
#define CITIZENSDK_LIFECYCLE_DISPOSED 7U

typedef uint32_t citizensdk_finality_t;
#define CITIZENSDK_FINALITY_BEST 1U
#define CITIZENSDK_FINALITY_FINALIZED 2U

typedef uint32_t citizensdk_capability_name_t;
#define CITIZENSDK_CAPABILITY_CHAIN_READ 1U
#define CITIZENSDK_CAPABILITY_TRANSACTION_BUILD 2U
#define CITIZENSDK_CAPABILITY_TRANSACTION_SUBMIT 3U
#define CITIZENSDK_CAPABILITY_TRANSACTION_VERIFY 4U
#define CITIZENSDK_CAPABILITY_WALLET_PROFILE 5U
#define CITIZENSDK_CAPABILITY_LOCAL_SIGNING 6U
#define CITIZENSDK_CAPABILITY_HARDWARE_VAULT 7U
#define CITIZENSDK_CAPABILITY_USER_AUTHENTICATION 8U
#define CITIZENSDK_CAPABILITY_HISTORY 9U
#define CITIZENSDK_CAPABILITY_BACKGROUND_SYNC 10U

typedef uint32_t citizensdk_capability_reason_t;
#define CITIZENSDK_CAPABILITY_REASON_NONE 0U
#define CITIZENSDK_CAPABILITY_REASON_BUILD_UNSUPPORTED 1U
#define CITIZENSDK_CAPABILITY_REASON_DEVICE_UNAVAILABLE 2U
#define CITIZENSDK_CAPABILITY_REASON_HOST_DISABLED 3U
#define CITIZENSDK_CAPABILITY_REASON_ENGINE_NOT_RUNNING 4U
#define CITIZENSDK_CAPABILITY_REASON_DEPENDENCY_NOT_READY 5U
#define CITIZENSDK_CAPABILITY_REASON_USER_AUTHENTICATION_REQUIRED 6U
#define CITIZENSDK_CAPABILITY_REASON_VAULT_LOCKED 7U
#define CITIZENSDK_CAPABILITY_REASON_CHAIN_STARTING 8U
#define CITIZENSDK_CAPABILITY_REASON_CHAIN_UNSYNCED 9U
#define CITIZENSDK_CAPABILITY_REASON_STORAGE_UNAVAILABLE 10U

typedef uint32_t citizensdk_event_type_t;
#define CITIZENSDK_EVENT_REQUEST_COMPLETED 1U
#define CITIZENSDK_EVENT_WATCH_UPDATE 2U
#define CITIZENSDK_EVENT_CAPABILITIES_CHANGED 3U
#define CITIZENSDK_EVENT_LIFECYCLE_CHANGED 4U
/* Payloadless invalidation; request_id/result/capability_revision/reserved are zero. */
#define CITIZENSDK_EVENT_HISTORY_CHANGED 5U
/* Verified finalized block change; result is a BLOCK_REF owned by the receiver. */
#define CITIZENSDK_EVENT_FINALIZED_BLOCK_CHANGED 6U
/* 无payload钱包失效通知；sequence以外的请求/result/revision/reserved均为零。 */
#define CITIZENSDK_EVENT_WALLET_CHANGED 7U

typedef uint32_t citizensdk_result_kind_t;
#define CITIZENSDK_RESULT_EMPTY 0U
#define CITIZENSDK_RESULT_BLOCK_REF 1U
#define CITIZENSDK_RESULT_STORAGE_VALUE 2U
#define CITIZENSDK_RESULT_STORAGE_BATCH 3U
#define CITIZENSDK_RESULT_RUNTIME_CONTEXT 4U
#define CITIZENSDK_RESULT_EXTRINSIC_HASH 5U
#define CITIZENSDK_RESULT_EXECUTION_CONCLUSION 6U
#define CITIZENSDK_RESULT_WATCH_EVENT 7U
#define CITIZENSDK_RESULT_EXPORTED_STATE 8U
#define CITIZENSDK_RESULT_ACCOUNT_BALANCE 9U
#define CITIZENSDK_RESULT_ACCOUNT_NONCE 10U
#define CITIZENSDK_RESULT_FEE_SNAPSHOT 11U
#define CITIZENSDK_RESULT_WALLET_PROFILE 12U
/* 原ABI数值保留且不复用；现行追加只产生完整WalletProfile结果。 */
#define CITIZENSDK_RESULT_WALLET_ACCOUNTS 13U
#define CITIZENSDK_RESULT_SIGNATURE 14U
#define CITIZENSDK_RESULT_PREPARED_WALLET 15U
/* Result kind 16 is permanently unused. */
#define CITIZENSDK_RESULT_TRANSACTION_HISTORY_PAGE 17U
#define CITIZENSDK_RESULT_ACCOUNT_BALANCES 18U
#define CITIZENSDK_RESULT_QR_REVIEW 19U
#define CITIZENSDK_RESULT_QR_SIGNED 20U
#define CITIZENSDK_RESULT_WALLET_STATE 21U
#define CITIZENSDK_RESULT_SIGNING_OUTCOME 22U
#define CITIZENSDK_RESULT_DEFAULT_ACCOUNT_CHANGE 23U
#define CITIZENSDK_RESULT_CHAIN_SYNC_STATUS 24U
#define CITIZENSDK_RESULT_BLOCK_HEADER 25U
#define CITIZENSDK_RESULT_BLOCK_BODY 26U
#define CITIZENSDK_RESULT_PREPARED_TRANSACTION 27U
#define CITIZENSDK_RESULT_TRANSACTION_EXECUTION 28U
#define CITIZENSDK_RESULT_APPLICATION_KEY 29U
#define CITIZENSDK_RESULT_APPLICATION_KEYS 30U
#define CITIZENSDK_RESULT_APPLICATION_KEY_PREPARATION 31U

typedef uint32_t citizensdk_transaction_execution_status_t;
#define CITIZENSDK_TRANSACTION_EXECUTION_EXTERNAL_PENDING 1U
#define CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_SUCCESS 2U
#define CITIZENSDK_TRANSACTION_EXECUTION_FINALIZED_FAILED 3U
#define CITIZENSDK_TRANSACTION_EXECUTION_POOL_REJECTED 4U

typedef uint32_t citizensdk_signing_transform_t;
#define CITIZENSDK_SIGNING_TRANSFORM_RAW 1U
#define CITIZENSDK_SIGNING_TRANSFORM_SUBSTRATE_PAYLOAD 2U
#define CITIZENSDK_SIGNING_TRANSFORM_BLAKE2_DOMAIN 3U

typedef uint32_t citizensdk_external_signer_transport_t;
#define CITIZENSDK_EXTERNAL_SIGNER_NONE 0U
#define CITIZENSDK_EXTERNAL_SIGNER_QR_V1 1U

typedef uint32_t citizensdk_signing_outcome_status_t;
#define CITIZENSDK_SIGNING_COMPLETED 1U
#define CITIZENSDK_SIGNING_EXTERNAL_PENDING 2U

typedef uint32_t citizensdk_wallet_word_count_t;
#define CITIZENSDK_WALLET_WORDS_12 12U
#define CITIZENSDK_WALLET_WORDS_18 18U
#define CITIZENSDK_WALLET_WORDS_24 24U

typedef uint32_t citizensdk_wallet_origin_t;
#define CITIZENSDK_WALLET_ORIGIN_CREATED 1U
#define CITIZENSDK_WALLET_ORIGIN_IMPORTED 2U

typedef uint32_t citizensdk_wallet_sign_mode_t;
#define CITIZENSDK_WALLET_SIGN_HOT 1U
#define CITIZENSDK_WALLET_SIGN_COLD 2U

typedef uint32_t citizensdk_transaction_history_status_t;
#define CITIZENSDK_TRANSACTION_HISTORY_PENDING 1U
#define CITIZENSDK_TRANSACTION_HISTORY_IN_BLOCK 2U
#define CITIZENSDK_TRANSACTION_HISTORY_POOL_REJECTED 3U
#define CITIZENSDK_TRANSACTION_HISTORY_FINALIZED_SUCCESS 4U
#define CITIZENSDK_TRANSACTION_HISTORY_FINALIZED_FAILED 5U

typedef uint32_t citizensdk_watch_status_t;
#define CITIZENSDK_WATCH_READY 1U
#define CITIZENSDK_WATCH_BROADCAST 2U
#define CITIZENSDK_WATCH_FUTURE 3U
#define CITIZENSDK_WATCH_IN_BLOCK 4U
#define CITIZENSDK_WATCH_FINALIZED 5U
#define CITIZENSDK_WATCH_RETRACTED 6U
#define CITIZENSDK_WATCH_FINALITY_TIMEOUT 7U
#define CITIZENSDK_WATCH_DROPPED 8U
#define CITIZENSDK_WATCH_INVALID 9U
#define CITIZENSDK_WATCH_USURPED 10U

typedef uint32_t citizensdk_execution_status_t;
#define CITIZENSDK_EXECUTION_SUCCESS 1U
#define CITIZENSDK_EXECUTION_FAILED 2U
#define CITIZENSDK_EXECUTION_UNVERIFIED 3U

/* Values in execution_info.reason_or_dispatch_variant for UNVERIFIED. */
typedef uint32_t citizensdk_unverified_reason_t;
#define CITIZENSDK_UNVERIFIED_TARGET_BLOCK_UNAVAILABLE 1U
#define CITIZENSDK_UNVERIFIED_RUNTIME_CONTEXT_UNAVAILABLE 2U
#define CITIZENSDK_UNVERIFIED_METADATA_DECODE_FAILED 3U
#define CITIZENSDK_UNVERIFIED_BLOCK_BODY_UNAVAILABLE 4U
#define CITIZENSDK_UNVERIFIED_EXTRINSIC_HASH_MISMATCH 5U
#define CITIZENSDK_UNVERIFIED_EXTRINSIC_NOT_FOUND 6U
#define CITIZENSDK_UNVERIFIED_MULTIPLE_EXTRINSIC_MATCHES 7U
#define CITIZENSDK_UNVERIFIED_SYSTEM_EVENTS_UNAVAILABLE 8U
#define CITIZENSDK_UNVERIFIED_SYSTEM_EVENTS_MALFORMED 9U
#define CITIZENSDK_UNVERIFIED_OUTCOME_EVENT_MISSING 10U
#define CITIZENSDK_UNVERIFIED_OUTCOME_EVENT_AMBIGUOUS 11U
#define CITIZENSDK_UNVERIFIED_PROVIDER_FAILURE 12U

/* CitizenChain's current Substrate DispatchError discriminants, returned in
 * reason_or_dispatch_variant for FAILED. */
typedef uint32_t citizensdk_dispatch_error_variant_t;
#define CITIZENSDK_DISPATCH_ERROR_OTHER 0U
#define CITIZENSDK_DISPATCH_ERROR_CANNOT_LOOKUP 1U
#define CITIZENSDK_DISPATCH_ERROR_BAD_ORIGIN 2U
#define CITIZENSDK_DISPATCH_ERROR_MODULE 3U
#define CITIZENSDK_DISPATCH_ERROR_CONSUMER_REMAINING 4U
#define CITIZENSDK_DISPATCH_ERROR_NO_PROVIDERS 5U
#define CITIZENSDK_DISPATCH_ERROR_TOO_MANY_CONSUMERS 6U
#define CITIZENSDK_DISPATCH_ERROR_TOKEN 7U
#define CITIZENSDK_DISPATCH_ERROR_ARITHMETIC 8U
#define CITIZENSDK_DISPATCH_ERROR_TRANSACTIONAL 9U
#define CITIZENSDK_DISPATCH_ERROR_EXHAUSTED 10U
#define CITIZENSDK_DISPATCH_ERROR_CORRUPTION 11U
#define CITIZENSDK_DISPATCH_ERROR_UNAVAILABLE 12U
#define CITIZENSDK_DISPATCH_ERROR_ROOT_NOT_ALLOWED 13U

typedef struct citizensdk_bytes_view {
  const uint8_t *data;
  uint64_t len;
} citizensdk_bytes_view_t;

/* Numeric value is high * 2^64 + low. This is not a byte-string encoding. */
typedef struct citizensdk_u128 {
  uint64_t low;
  uint64_t high;
} citizensdk_u128_t;

typedef struct citizensdk_account_id {
  uint8_t bytes[32];
} citizensdk_account_id_t;

#define CITIZENSDK_HOST_DEK_BYTES 32ULL

/* Rust-owned mutable memory used only by vault unwrap_dek. */
typedef struct citizensdk_mutable_bytes_view {
  uint8_t *data;
  uint64_t len;
} citizensdk_mutable_bytes_view_t;

typedef uint32_t citizensdk_host_record_domain_t;
#define CITIZENSDK_HOST_RECORD_CHAIN_DATABASE 1U
#define CITIZENSDK_HOST_RECORD_RUNTIME_CACHE 2U
#define CITIZENSDK_HOST_RECORD_WALLET_PROFILE 3U
#define CITIZENSDK_HOST_RECORD_TRANSACTION_HISTORY 4U
#define CITIZENSDK_HOST_RECORD_ENCRYPTED_SECRET_BLOB 5U

typedef uint32_t citizensdk_host_secret_kind_t;
#define CITIZENSDK_HOST_SECRET_ACCOUNT_MINI_SECRET 1U

typedef uint32_t citizensdk_host_vault_availability_t;
#define CITIZENSDK_HOST_VAULT_AVAILABLE 1U
#define CITIZENSDK_HOST_VAULT_NO_STRONG_USER_AUTHENTICATION 2U
#define CITIZENSDK_HOST_VAULT_UNSUPPORTED 3U
#define CITIZENSDK_HOST_VAULT_UNAVAILABLE 4U

typedef uint32_t citizensdk_host_bytes_kind_t;
#define CITIZENSDK_HOST_BYTES_WRAPPED_DEK 1U

typedef struct citizensdk_host_hash32 {
  uint8_t bytes[32];
} citizensdk_host_hash32_t;

typedef struct citizensdk_host_id128 {
  uint8_t bytes[16];
} citizensdk_host_id128_t;

typedef struct citizensdk_host_secret_ref_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t wallet_index;
  citizensdk_host_secret_kind_t kind;
  citizensdk_host_id128_t generation;
  citizensdk_host_id128_t owner;
  citizensdk_host_hash32_t account_id;
} citizensdk_host_secret_ref_v1_t;

typedef struct citizensdk_host_wallet_key_ref_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t wallet_index;
  uint32_t reserved;
  citizensdk_host_id128_t generation;
} citizensdk_host_wallet_key_ref_v1_t;

typedef struct citizensdk_host_record_result_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t host_operation_id;
  citizensdk_error_code_t error_code;
  citizensdk_host_record_domain_t domain;
  uint8_t present;
  uint8_t reserved[7];
  uint64_t revision;
  citizensdk_bytes_view_t record;
} citizensdk_host_record_result_v1_t;

typedef struct citizensdk_host_status_result_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t host_operation_id;
  citizensdk_error_code_t error_code;
  uint32_t reserved;
} citizensdk_host_status_result_v1_t;

typedef struct citizensdk_host_bool_result_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t host_operation_id;
  citizensdk_error_code_t error_code;
  uint8_t value;
  uint8_t reserved[7];
} citizensdk_host_bool_result_v1_t;

typedef struct citizensdk_host_vault_availability_result_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t host_operation_id;
  citizensdk_error_code_t error_code;
  citizensdk_host_vault_availability_t availability;
} citizensdk_host_vault_availability_result_v1_t;

/* This byte completion is only for a non-plaintext wrapped DEK. */
typedef struct citizensdk_host_bytes_result_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t host_operation_id;
  citizensdk_error_code_t error_code;
  citizensdk_host_bytes_kind_t kind;
  citizensdk_bytes_view_t bytes;
} citizensdk_host_bytes_result_v1_t;

typedef void (*citizensdk_host_record_completion_v1_t)(
    void *sdk_context, const citizensdk_host_record_result_v1_t *result);
typedef void (*citizensdk_host_status_completion_v1_t)(
    void *sdk_context, const citizensdk_host_status_result_v1_t *result);
typedef void (*citizensdk_host_bool_completion_v1_t)(
    void *sdk_context, const citizensdk_host_bool_result_v1_t *result);
typedef void (*citizensdk_host_vault_availability_completion_v1_t)(
    void *sdk_context,
    const citizensdk_host_vault_availability_result_v1_t *result);
typedef void (*citizensdk_host_bytes_completion_v1_t)(
    void *sdk_context, const citizensdk_host_bytes_result_v1_t *result);

typedef citizensdk_error_code_t (*citizensdk_host_chain_database_load_v1_t)(
    void *host_context, uint64_t host_operation_id, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion);
typedef citizensdk_error_code_t
    (*citizensdk_host_chain_database_compare_and_swap_v1_t)(
        void *host_context, uint64_t host_operation_id,
        uint64_t expected_revision, uint8_t present,
        citizensdk_bytes_view_t candidate_record, void *sdk_context,
        citizensdk_host_record_completion_v1_t completion);
typedef citizensdk_error_code_t (*citizensdk_host_runtime_cache_load_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_hash32_t block_hash, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion);
typedef citizensdk_error_code_t (*citizensdk_host_runtime_cache_store_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_hash32_t block_hash,
    citizensdk_bytes_view_t candidate_record, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion);
typedef citizensdk_error_code_t (*citizensdk_host_runtime_cache_delete_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_hash32_t block_hash, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion);
typedef citizensdk_error_code_t (*citizensdk_host_transaction_history_query_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_bytes_view_t query, void *sdk_context,
    citizensdk_host_record_completion_v1_t completion);
typedef citizensdk_error_code_t
    (*citizensdk_host_transaction_history_mutate_v1_t)(
        void *host_context, uint64_t host_operation_id,
        uint64_t expected_revision, citizensdk_bytes_view_t candidate_record,
        void *sdk_context, citizensdk_host_record_completion_v1_t completion);

typedef struct citizensdk_host_public_store_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  citizensdk_host_chain_database_load_v1_t chain_database_load;
  citizensdk_host_chain_database_compare_and_swap_v1_t
      chain_database_compare_and_swap;
  citizensdk_host_runtime_cache_load_v1_t runtime_cache_load;
  citizensdk_host_runtime_cache_store_v1_t runtime_cache_store;
  citizensdk_host_runtime_cache_delete_v1_t runtime_cache_delete;
  citizensdk_host_transaction_history_query_v1_t transaction_history_query;
  citizensdk_host_transaction_history_mutate_v1_t transaction_history_mutate;
} citizensdk_host_public_store_v1_t;

typedef citizensdk_host_chain_database_load_v1_t
    citizensdk_host_wallet_profile_load_v1_t;
typedef citizensdk_host_transaction_history_mutate_v1_t
    citizensdk_host_wallet_profile_compare_and_swap_v1_t;
typedef citizensdk_error_code_t
    (*citizensdk_host_encrypted_secret_blob_load_v1_t)(
        void *host_context, uint64_t host_operation_id,
        citizensdk_host_secret_ref_v1_t secret_ref, void *sdk_context,
        citizensdk_host_record_completion_v1_t completion);
typedef citizensdk_error_code_t
    (*citizensdk_host_encrypted_secret_blob_compare_and_swap_v1_t)(
        void *host_context, uint64_t host_operation_id,
        citizensdk_host_secret_ref_v1_t secret_ref,
        uint64_t expected_revision, citizensdk_bytes_view_t candidate_record,
        void *sdk_context, citizensdk_host_record_completion_v1_t completion);

typedef struct citizensdk_host_secure_store_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  citizensdk_host_wallet_profile_load_v1_t wallet_profile_load;
  citizensdk_host_wallet_profile_compare_and_swap_v1_t
      wallet_profile_compare_and_swap;
  citizensdk_host_encrypted_secret_blob_load_v1_t encrypted_secret_blob_load;
  citizensdk_host_encrypted_secret_blob_compare_and_swap_v1_t
      encrypted_secret_blob_compare_and_swap;
} citizensdk_host_secure_store_v1_t;

typedef citizensdk_error_code_t (*citizensdk_host_vault_availability_v1_t)(
    void *host_context, uint64_t host_operation_id, void *sdk_context,
    citizensdk_host_vault_availability_completion_v1_t completion);
typedef citizensdk_error_code_t
    (*citizensdk_host_vault_ensure_wallet_kek_v1_t)(
        void *host_context, uint64_t host_operation_id,
        citizensdk_host_wallet_key_ref_v1_t wallet_key,
        citizensdk_host_id128_t provisioning_operation_id, void *sdk_context,
        citizensdk_host_status_completion_v1_t completion);
typedef citizensdk_error_code_t (*citizensdk_host_vault_has_wallet_kek_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_wallet_key_ref_v1_t wallet_key, void *sdk_context,
    citizensdk_host_bool_completion_v1_t completion);
/* plaintext_dek is an exact Rust-owned 32-byte view. On acceptance it remains
 * valid until the first completion; on rejection it expires when this callback
 * returns. The host must never retain it beyond that boundary. */
typedef citizensdk_error_code_t (*citizensdk_host_vault_wrap_dek_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_wallet_key_ref_v1_t wallet_key,
    citizensdk_host_id128_t provisioning_operation_id,
    citizensdk_bytes_view_t plaintext_dek, void *sdk_context,
    citizensdk_host_bytes_completion_v1_t completion);
/* plaintext_dek_out is exact Rust-owned mutable memory, exclusively borrowed
 * by the accepted operation until its first completion. */
typedef citizensdk_error_code_t (*citizensdk_host_vault_unwrap_dek_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_wallet_key_ref_v1_t wallet_key,
    citizensdk_bytes_view_t wrapped_dek,
    citizensdk_mutable_bytes_view_t plaintext_dek_out, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion);
typedef citizensdk_error_code_t
    (*citizensdk_host_vault_retire_wallet_kek_v1_t)(
        void *host_context, uint64_t host_operation_id,
        citizensdk_host_wallet_key_ref_v1_t wallet_key,
        citizensdk_host_id128_t cleanup_operation_id, void *sdk_context,
        citizensdk_host_status_completion_v1_t completion);

/* 本次整批追加独立认证；不接收秘密，不解封账户，不缓存成功。 */
typedef citizensdk_error_code_t (*citizensdk_host_vault_authorize_add_accounts_v1_t)(
    void *host_context, uint64_t host_operation_id,
    citizensdk_host_wallet_key_ref_v1_t wallet_key,
    citizensdk_host_id128_t provisioning_operation_id, void *sdk_context,
    citizensdk_host_status_completion_v1_t completion);

typedef struct citizensdk_host_secret_vault_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  citizensdk_host_vault_availability_v1_t availability;
  citizensdk_host_vault_ensure_wallet_kek_v1_t ensure_wallet_kek;
  citizensdk_host_vault_has_wallet_kek_v1_t has_wallet_kek;
  citizensdk_host_vault_wrap_dek_v1_t wrap_dek;
  citizensdk_host_vault_unwrap_dek_v1_t unwrap_dek;
  citizensdk_host_vault_retire_wallet_kek_v1_t retire_wallet_kek;
  citizensdk_host_vault_authorize_add_accounts_v1_t authorize_add_accounts;
} citizensdk_host_secret_vault_v1_t;

/* Vtable pointers are borrowed only during create_with_host and copied by SDK. */
typedef struct citizensdk_host_services_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  const citizensdk_host_public_store_v1_t *public_store;
  const citizensdk_host_secure_store_v1_t *secure_store;
  const citizensdk_host_secret_vault_v1_t *secret_vault;
} citizensdk_host_services_v1_t;

/* 只读跨代际存在性，不改变原HostServices/SecureStore/Vault v1结构。
 * 输入按值传递，回调/context必须保有至SDK成功销毁；输出复用原BoolResult。 */
typedef citizensdk_error_code_t (*citizensdk_host_has_account_secret_v1_t)(
    void *context, uint64_t host_operation_id, citizensdk_account_id_t account_id,
    void *sdk_context, citizensdk_host_bool_completion_v1_t completion);
typedef citizensdk_error_code_t (*citizensdk_host_has_any_wallet_key_v1_t)(
    void *context, uint64_t host_operation_id, uint32_t wallet_index,
    void *sdk_context, citizensdk_host_bool_completion_v1_t completion);
typedef struct citizensdk_host_secret_presence_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  citizensdk_host_has_account_secret_v1_t has_account_secret;
  citizensdk_host_has_any_wallet_key_v1_t has_any_wallet_key;
} citizensdk_host_secret_presence_v1_t;


typedef struct citizensdk_create_options {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_bytes_view_t asset_manifest;
  citizensdk_bytes_view_t chain_spec;
  citizensdk_bytes_view_t light_sync_state;
  citizensdk_bytes_view_t system_name;
  citizensdk_bytes_view_t system_version;
} citizensdk_create_options_t;

typedef struct citizensdk_block_ref {
  uint32_t struct_size;
  uint32_t abi_version;
  uint8_t hash[32];
  uint64_t number;
  citizensdk_finality_t finality;
  uint32_t reserved;
} citizensdk_block_ref_t;

typedef struct citizensdk_capability_status {
  citizensdk_capability_name_t name;
  citizensdk_capability_reason_t reason;
  uint8_t supported;
  uint8_t available;
  uint8_t enabled;
  uint8_t ready;
  uint8_t reserved[4];
} citizensdk_capability_status_t;

typedef struct citizensdk_capability_snapshot {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t revision;
  uint32_t count;
  uint32_t reserved;
  citizensdk_capability_status_t statuses[CITIZENSDK_CAPABILITY_COUNT];
} citizensdk_capability_snapshot_t;

typedef struct citizensdk_event {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_event_type_t event_type;
  uint32_t reserved;
  uint64_t sequence;
  citizensdk_request_id_t request_id;
  citizensdk_result_handle_t result;
  uint64_t capability_revision;
} citizensdk_event_t;

typedef void (*citizensdk_event_callback_t)(void *context,
                                            const citizensdk_event_t *event);

typedef struct citizensdk_result_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_error_code_t error_code;
  citizensdk_result_kind_t kind;
  uint64_t payload_len;
  uint64_t error_message_len;
} citizensdk_result_info_t;

typedef struct citizensdk_runtime_context_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_block_ref_t block;
  uint32_t spec_version;
  uint32_t transaction_version;
  uint64_t metadata_len;
} citizensdk_runtime_context_info_t;

/* One same-instant snapshot from the typed light client. Consumers must use
 * is_usable directly instead of reconstructing readiness from other fields. */
typedef struct citizensdk_chain_sync_status_info {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t peer_count;
  uint8_t is_syncing;
  uint8_t is_usable;
  uint8_t reserved[6];
  citizensdk_block_ref_t best;
  citizensdk_block_ref_t finalized;
} citizensdk_chain_sync_status_info_t;

/* digest is copied separately as complete SCALE Digest bytes. */
typedef struct citizensdk_block_header_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_block_ref_t block;
  uint8_t parent_hash[32];
  uint8_t state_root[32];
  uint8_t extrinsics_root[32];
  uint64_t digest_len;
} citizensdk_block_header_info_t;

/* Extrinsics remain ordered opaque SCALE bytes and are copied one item at a time. */
typedef struct citizensdk_block_body_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_block_ref_t block;
  uint32_t extrinsic_count;
  uint32_t reserved;
  uint64_t total_bytes;
} citizensdk_block_body_info_t;

typedef struct citizensdk_watch_event_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_watch_status_t status;
  uint32_t peer_count;
  uint8_t has_block;
  uint8_t has_replacement_hash;
  uint8_t reserved[6];
  citizensdk_block_ref_t block;
  uint8_t replacement_hash[32];
} citizensdk_watch_event_info_t;

typedef struct citizensdk_execution_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_execution_status_t status;
  uint32_t reason_or_dispatch_variant;
  uint8_t has_block;
  uint8_t has_extrinsic_index;
  uint8_t has_module;
  uint8_t reserved[5];
  citizensdk_block_ref_t block;
  uint32_t extrinsic_index;
  uint8_t pallet_index;
  uint8_t error_index;
  uint8_t reserved_tail[2];
} citizensdk_execution_info_t;

typedef struct citizensdk_exported_state_info {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t format_version;
  uint32_t reserved;
  citizensdk_block_ref_t finalized;
  uint64_t database_len;
} citizensdk_exported_state_info_t;

typedef struct citizensdk_account_balance_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_block_ref_t block;
  citizensdk_account_id_t account_id;
  citizensdk_u128_t free_fen;
  citizensdk_u128_t reserved_fen;
  citizensdk_u128_t total_fen;
} citizensdk_account_balance_info_t;

typedef struct citizensdk_account_nonce_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_block_ref_t best_block;
  citizensdk_account_id_t account_id;
  uint64_t nonce;
} citizensdk_account_nonce_info_t;

typedef struct citizensdk_fee_snapshot_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_block_ref_t best_block;
  uint32_t fee_rate_parts;
  uint32_t reserved;
  citizensdk_u128_t minimum_fee_fen;
  citizensdk_u128_t existential_deposit_fen;
} citizensdk_fee_snapshot_info_t;

typedef struct citizensdk_wallet_profile_info {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t present;
  citizensdk_wallet_origin_t origin;
  uint32_t wallet_index;
  uint32_t account_count;
  uint64_t created_at_millis;
  citizensdk_account_id_t master_account_id;
  citizensdk_account_id_t active_account_id;
} citizensdk_wallet_profile_info_t;

typedef struct citizensdk_wallet_account_info {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t index;
  uint32_t is_active;
  citizensdk_account_id_t account_id;
  uint64_t created_at_millis;
  uint64_t ss58_address_len;
  uint64_t name_len;
} citizensdk_wallet_account_info_t;

/* 无UI输入原因；位置仅用于词表外单词，不返回任何原始敏感输入。 */
#define CITIZENSDK_WALLET_INPUT_PASSWORD 1U
#define CITIZENSDK_WALLET_INPUT_MNEMONIC 2U
#define CITIZENSDK_WALLET_INPUT_VALID 0U
#define CITIZENSDK_WALLET_INPUT_TOO_LONG 1U
#define CITIZENSDK_WALLET_INPUT_WORD_COUNT 2U
#define CITIZENSDK_WALLET_INPUT_UNKNOWN_WORD 3U
#define CITIZENSDK_WALLET_INPUT_CHECKSUM 4U
#define CITIZENSDK_WALLET_INPUT_PASSWORD_FORMAT 5U
#define CITIZENSDK_WALLET_INPUT_MNEMONIC_FORMAT 6U
#define CITIZENSDK_WALLET_INPUT_PASSWORD_LENGTH 7U
#define CITIZENSDK_WALLET_INPUT_PASSWORD_NORMALIZATION 8U
#define CITIZENSDK_WALLET_INITIALIZATION_EMPTY 0U
#define CITIZENSDK_WALLET_INITIALIZATION_READY 1U
#define CITIZENSDK_WALLET_INITIALIZATION_RECOVERING 2U
typedef struct citizensdk_wallet_input_validation_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t reason;
  uint32_t position;
} citizensdk_wallet_input_validation_v1_t;

/* 显式私钥查看的无UI接收者；receive仅同步借用32字节，context存续到request真实终态。
 * settled是阶段通知而非生命周期结束；回调不能等待UI线程或反调Core。
 * authorizing只关联真实设备操作，不代替设备授权或直接交付私钥。 */
typedef struct citizensdk_private_key_receiver_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  void *context;
  int32_t (*receive)(void *context, uint64_t secret_id, citizensdk_bytes_view_t private_key);
  void (*settled)(void *context, uint64_t secret_id, int32_t error_code);
  int32_t (*authorizing)(void *context, uint64_t secret_id, uint64_t host_operation_id);
} citizensdk_private_key_receiver_v1_t;

/* Unified secret-free account catalog. Its first account is the default; this
 * ABI intentionally has no unauthorised default-account setter. */
typedef struct citizensdk_wallet_state_info {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t revision;
  uint32_t account_count;
  uint32_t has_default_account;
  citizensdk_account_id_t default_account_id;
} citizensdk_wallet_state_info_t;

/* 同次快照中的只读异常事实，不可用于普通签名；原因1=模式、2=身份、3=结构。
 * has_ss58_address=0表示原记录不能提供唯一地址，不以空串伪造地址。 */
typedef struct citizensdk_wallet_diagnostic_info_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t wallet_index;
  uint32_t diagnostic_reason;
  uint32_t has_ss58_address;
  uint32_t sign_mode; /* 0=原文无已知值；1=hot、2=cold，仅展示事实。 */
  citizensdk_account_id_t account_id;
  uint64_t wallet_name_len;
  uint64_t ss58_address_len;
  uint32_t cleanup_account_count; /* 0=无可信目标，非空最多1990项。 */
  uint32_t delete_wallet_wide_key;
} citizensdk_wallet_diagnostic_info_v1_t;

typedef struct citizensdk_wallet_state_account_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_wallet_sign_mode_t sign_mode;
  uint32_t wallet_index;
  uint32_t has_account_index;
  uint32_t account_index;
  uint32_t is_default;
  uint32_t reserved;
  citizensdk_account_id_t account_id;
  uint64_t created_at_millis;
  uint64_t ss58_address_len;
  uint64_t name_len;
} citizensdk_wallet_state_account_info_t;

typedef struct citizensdk_signing_outcome_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_signing_outcome_status_t status;
  citizensdk_external_signer_transport_t transport;
  citizensdk_account_id_t account_id;
  uint8_t payload_hash[32];
  uint64_t expires_at;
  uint64_t signature_len;
  uint64_t session_id_len;
  uint64_t transport_request_len;
} citizensdk_signing_outcome_info_t;

typedef struct citizensdk_default_account_change_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_signing_outcome_status_t status;
  citizensdk_external_signer_transport_t transport;
  citizensdk_account_id_t current_default_account_id;
  uint8_t payload_hash[32];
  uint64_t expires_at;
  uint64_t committed_revision;
  uint64_t session_id_len;
  uint64_t transport_request_len;
} citizensdk_default_account_change_info_t;

typedef struct citizensdk_prepared_wallet_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_prepared_wallet_handle_t prepared_wallet;
} citizensdk_prepared_wallet_info_t;

/* Safe summary only. The signer message and extrinsic template remain inside Core. */
typedef struct citizensdk_prepared_transaction_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_prepared_transaction_handle_t prepared_transaction;
  uint8_t preparation_id[16];
  citizensdk_account_id_t source_account_id;
  uint8_t call_data_hash[32];
  citizensdk_block_ref_t best_block;
  uint32_t runtime_spec_number;
  uint32_t transaction_format_number;
  uint64_t nonce;
} citizensdk_prepared_transaction_info_t;

/* Either a bounded existing QR_V1 request or an accurately verified terminal. */
typedef struct citizensdk_transaction_execution_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_transaction_execution_status_t status;
  citizensdk_external_signer_transport_t transport;
  uint8_t execution_id[16];
  citizensdk_account_id_t source_account_id;
  uint8_t call_data_hash[32];
  uint8_t transaction_hash[32];
  uint64_t expires_at;
  uint32_t has_block;
  uint32_t has_extrinsic_index;
  uint32_t has_dispatch_failure;
  uint32_t has_module_failure;
  uint32_t has_replacement_hash;
  uint32_t dispatch_variant;
  uint32_t pallet_index;
  uint32_t error_index;
  citizensdk_block_ref_t block;
  uint32_t extrinsic_index;
  uint8_t replacement_hash[32];
  uint64_t session_id_len;
  uint64_t transport_request_len;
  uint64_t pool_rejection_reason_len;
} citizensdk_transaction_execution_info_t;

/* Deterministic page over transactions submitted by CitizenSDK itself. */
typedef struct citizensdk_transaction_history_page_info {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t revision;
  uint32_t record_count;
  uint32_t has_next_before_execution_id;
  citizensdk_transaction_execution_id_t next_before_execution_id;
} citizensdk_transaction_history_page_info_t;

/* Product-independent public projection. callData, signed extrinsic, nonce and
 * application meanings such as destination/amount/remark are never exposed. */
typedef struct citizensdk_transaction_history_record_info {
  uint32_t struct_size;
  uint32_t abi_version;
  citizensdk_transaction_execution_id_t execution_id;
  citizensdk_account_id_t source_account_id;
  uint8_t call_data_hash[32];
  uint8_t transaction_hash[32];
  citizensdk_transaction_history_status_t status;
  uint32_t has_block;
  citizensdk_block_ref_t block;
  uint32_t has_execution;
  uint32_t has_replacement_hash;
  citizensdk_execution_info_t execution;
  uint8_t replacement_hash[32];
  uint64_t created_at_millis;
  uint64_t updated_at_millis;
  uint64_t pool_rejection_reason_len;
} citizensdk_transaction_history_record_info_t;

#endif /* CITIZENSDK_TYPES_H */
