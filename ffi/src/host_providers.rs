//! Versioned host-provider C contracts.
//!
//! The public and secure stores expose one callback per typed Rust contract.
//! There is deliberately no generic `put(key, bytes)` escape hatch.  Stored
//! values are opaque [`citizen_sdk_store::codec`] records and the Rust adapter checks
//! their exact domain before constructing typed state.
//!
//! Every operation follows one asynchronous rule:
//! - returning `OK` accepts the operation and requires exactly one later
//!   completion callback;
//! - returning any other stable error rejects it and forbids a completion;
//! - ordinary inputs are borrowed only until the operation callback returns;
//! - the `wrap_dek` input is an exception: its Rust-owned zeroizing allocation
//!   remains valid from dispatch through first completion/synchronous reject,
//!   so an asynchronous host must not copy the plaintext DEK into managed code;
//! - completion outputs are borrowed only while the completion callback runs,
//!   and CitizenSDK synchronously copies/validates them;
//! - every non-null completion must repeat the operation ID encoded in its
//!   opaque SDK context; a crossed token/result pair is ignored before the
//!   pending-operation registry is read or changed, while a null result still
//!   terminates the operation identified by its token;
//! - the one `unwrap_dek` mutable output is Rust-owned, exclusively borrowed
//!   until completion (or immediate rejection), and cannot be retained after;
//! - callbacks may complete concurrently on background threads and must not
//!   block a platform main thread.
//!
//! The vault surface owns only KEK lifecycle and 32-byte DEK wrapping.  It can
//! never receive an account child mini-secret, private key, mnemonic, or
//! sr25519 signing request.  Rust authenticates/decrypts the secret envelope,
//! signs, and zeroizes its buffers on its side of this boundary.

use std::{
    collections::{hash_map::Entry, HashMap},
    ffi::c_void,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use citizen_sdk_contracts::{
    AccountId32, ChainDatabaseSnapshot, ChainDatabaseStore, ContractError, ContractErrorCode,
    ContractFuture, EncryptedSecretBlobSnapshot, EncryptedSecretBlobState,
    EncryptedSecretBlobStore, EncryptedSecretEnvelope, Hash32, Hash32Bytes, RuntimeCacheStore,
    RuntimeContext, SecretBuffer, SecretKind, SecretRef, SecretVault, TransactionExecutionId,
    TransactionHistoryCursor, TransactionHistoryIndex, TransactionHistoryMutation,
    TransactionHistoryQueryKind, TransactionHistoryRecordBatch, TransactionHistoryRecordSnapshot,
    TransactionHistoryStore, VaultAvailability, VaultGeneration, WalletProfileStore, WalletState,
};
use futures_channel::oneshot;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::abi::{
    CitizenSdkAccountId, CitizenSdkBytesView, CitizenSdkErrorCode, CITIZENSDK_ABI_VERSION,
};
use citizen_sdk_store::codec::{
    decode_chain_database_snapshot, decode_encrypted_secret_blob_snapshot, decode_runtime_context,
    decode_transaction_history_host_batch, decode_wallet_state, encode_chain_database_snapshot,
    encode_encrypted_secret_blob_snapshot, encode_runtime_context,
    encode_transaction_history_index_query, encode_transaction_history_mutation,
    encode_transaction_history_page_query, encode_transaction_history_record_query,
    encode_wallet_state, HostCodecError, HostRecordDomain, TransactionHistoryHostBatch,
};

#[cfg(not(target_pointer_width = "64"))]
compile_error!("CitizenSDK host provider ABI v1 requires a 64-bit target");

pub const CITIZENSDK_HOST_DEK_BYTES: u64 = 32;

/// Mutable Rust-owned output memory.  This exists only for vault DEK unwrap;
/// it is never a general output buffer and is exactly 32 bytes at invocation.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkMutableBytesView {
    pub data: *mut u8,
    pub len: u64,
}

/// Persisted record identity.  The C vtables still use dedicated functions;
/// this value is returned only so Rust can reject a crossed completion.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkHostRecordDomain {
    ChainDatabase = 1,
    RuntimeCache = 2,
    WalletProfile = 3,
    TransactionHistory = 4,
    EncryptedSecretBlob = 5,
}

impl CitizenSdkHostRecordDomain {
    pub const fn codec_domain(self) -> HostRecordDomain {
        match self {
            Self::ChainDatabase => HostRecordDomain::ChainDatabase,
            Self::RuntimeCache => HostRecordDomain::RuntimeCache,
            Self::WalletProfile => HostRecordDomain::WalletProfile,
            Self::TransactionHistory => HostRecordDomain::TransactionHistory,
            Self::EncryptedSecretBlob => HostRecordDomain::EncryptedSecretBlob,
        }
    }
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkHostSecretKind {
    AccountMiniSecret = 1,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkHostVaultAvailability {
    Available = 1,
    NoStrongUserAuthentication = 2,
    Unsupported = 3,
    Unavailable = 4,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkHostBytesKind {
    WrappedDek = 1,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CitizenSdkHostHash32 {
    pub bytes: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CitizenSdkHostId128 {
    pub bytes: [u8; 16],
}

/// Exact identity of an encrypted child slot.  Only the encrypted-secret
/// store sees this value; the hardware vault is keyed by wallet generation.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkHostSecretRefV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub wallet_index: u32,
    pub kind: u32,
    pub generation: CitizenSdkHostId128,
    pub owner: CitizenSdkHostId128,
    pub account_id: CitizenSdkHostHash32,
}

impl Default for CitizenSdkHostSecretRefV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            wallet_index: 0,
            kind: CitizenSdkHostSecretKind::AccountMiniSecret as u32,
            generation: CitizenSdkHostId128::default(),
            owner: CitizenSdkHostId128::default(),
            account_id: CitizenSdkHostHash32::default(),
        }
    }
}

/// Physical identity of one generation-scoped host KEK.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkHostWalletKeyRefV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub wallet_index: u32,
    pub reserved: u32,
    pub generation: CitizenSdkHostId128,
}

impl Default for CitizenSdkHostWalletKeyRefV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            wallet_index: 0,
            reserved: 0,
            generation: CitizenSdkHostId128::default(),
        }
    }
}

/// Result for typed loads and CAS operations.  `record` is a complete opaque
/// host-codec envelope, never merely its payload.  On error or `present == 0`,
/// it must be `{NULL, 0}`.  The revision is zero for RuntimeCache operations.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostRecordResultV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub host_operation_id: u64,
    pub error_code: i32,
    pub domain: u32,
    pub present: u8,
    pub reserved: [u8; 7],
    pub revision: u64,
    pub record: CitizenSdkBytesView,
}

impl Default for CitizenSdkHostRecordResultV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            host_operation_id: 0,
            error_code: CitizenSdkErrorCode::Ok.as_i32(),
            domain: 0,
            present: 0,
            reserved: [0; 7],
            revision: 0,
            record: empty_bytes_view(),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkHostStatusResultV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub host_operation_id: u64,
    pub error_code: i32,
    pub reserved: u32,
}

impl Default for CitizenSdkHostStatusResultV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            host_operation_id: 0,
            error_code: CitizenSdkErrorCode::Ok.as_i32(),
            reserved: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkHostBoolResultV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub host_operation_id: u64,
    pub error_code: i32,
    pub value: u8,
    pub reserved: [u8; 7],
}

impl Default for CitizenSdkHostBoolResultV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            host_operation_id: 0,
            error_code: CitizenSdkErrorCode::Ok.as_i32(),
            value: 0,
            reserved: [0; 7],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkHostVaultAvailabilityResultV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub host_operation_id: u64,
    pub error_code: i32,
    pub availability: u32,
}

impl Default for CitizenSdkHostVaultAvailabilityResultV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            host_operation_id: 0,
            error_code: CitizenSdkErrorCode::Ok.as_i32(),
            availability: CitizenSdkHostVaultAvailability::Unavailable as u32,
        }
    }
}

/// Byte result used only for a wrapped DEK, which is not secret plaintext.
/// Unwrapped bytes are written directly to SDK-owned mutable Rust memory and
/// therefore never travel through a completion byte view.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostBytesResultV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub host_operation_id: u64,
    pub error_code: i32,
    pub kind: u32,
    pub bytes: CitizenSdkBytesView,
}

impl Default for CitizenSdkHostBytesResultV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            host_operation_id: 0,
            error_code: CitizenSdkErrorCode::Ok.as_i32(),
            kind: 0,
            bytes: empty_bytes_view(),
        }
    }
}

pub type CitizenSdkHostRecordCompletionV1 = Option<
    unsafe extern "C" fn(sdk_context: *mut c_void, result: *const CitizenSdkHostRecordResultV1),
>;
pub type CitizenSdkHostStatusCompletionV1 = Option<
    unsafe extern "C" fn(sdk_context: *mut c_void, result: *const CitizenSdkHostStatusResultV1),
>;
pub type CitizenSdkHostBoolCompletionV1 = Option<
    unsafe extern "C" fn(sdk_context: *mut c_void, result: *const CitizenSdkHostBoolResultV1),
>;
pub type CitizenSdkHostVaultAvailabilityCompletionV1 = Option<
    unsafe extern "C" fn(
        sdk_context: *mut c_void,
        result: *const CitizenSdkHostVaultAvailabilityResultV1,
    ),
>;
pub type CitizenSdkHostBytesCompletionV1 = Option<
    unsafe extern "C" fn(sdk_context: *mut c_void, result: *const CitizenSdkHostBytesResultV1),
>;

pub type CitizenSdkHostChainDatabaseLoadV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;
/// A successful CAS completion returns the exact durable post-write snapshot.
/// If storage reports an error after a possible write, the Rust adapter reloads
/// and compares the full candidate before deciding success versus conflict.
pub type CitizenSdkHostChainDatabaseCompareAndSwapV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        expected_revision: u64,
        present: u8,
        candidate_record: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;
pub type CitizenSdkHostRuntimeCacheLoadV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        block_hash: CitizenSdkHostHash32,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;
/// Stores one exact block-hash-bound runtime context.  The candidate is a
/// RuntimeCache-domain opaque record and cannot be reused by another callback.
pub type CitizenSdkHostRuntimeCacheStoreV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        block_hash: CitizenSdkHostHash32,
        candidate_record: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32,
>;
pub type CitizenSdkHostRuntimeCacheDeleteV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        block_hash: CitizenSdkHostHash32,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32,
>;
/// Runs one bounded index/record/page query encoded by Core. The host may
/// inspect only the fixed history wire header and keeps each Core record opaque.
pub type CitizenSdkHostTransactionHistoryQueryV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        query: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;
/// Applies delete IDs, opaque upserts and the next aggregate index in one host
/// transaction guarded by the expected revision.
pub type CitizenSdkHostTransactionHistoryMutateV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        expected_revision: u64,
        candidate_record: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;

/// Public chain database, runtime cache, and reconstructable history storage.
/// History is deliberately query/mutation based; singleton load/CAS remains
/// only for the bounded chain database value.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostPublicStoreV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub context: *mut c_void,
    pub chain_database_load: CitizenSdkHostChainDatabaseLoadV1,
    pub chain_database_compare_and_swap: CitizenSdkHostChainDatabaseCompareAndSwapV1,
    pub runtime_cache_load: CitizenSdkHostRuntimeCacheLoadV1,
    pub runtime_cache_store: CitizenSdkHostRuntimeCacheStoreV1,
    pub runtime_cache_delete: CitizenSdkHostRuntimeCacheDeleteV1,
    pub transaction_history_query: CitizenSdkHostTransactionHistoryQueryV1,
    pub transaction_history_mutate: CitizenSdkHostTransactionHistoryMutateV1,
}

impl Default for CitizenSdkHostPublicStoreV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            context: std::ptr::null_mut(),
            chain_database_load: None,
            chain_database_compare_and_swap: None,
            runtime_cache_load: None,
            runtime_cache_store: None,
            runtime_cache_delete: None,
            transaction_history_query: None,
            transaction_history_mutate: None,
        }
    }
}

pub type CitizenSdkHostWalletProfileLoadV1 = CitizenSdkHostChainDatabaseLoadV1;
/// Wallet profile and lifecycle/provisioning plans are one atomic revisioned
/// value.  This callback never receives mnemonic or derived secret material.
pub type CitizenSdkHostWalletProfileCompareAndSwapV1 = CitizenSdkHostTransactionHistoryMutateV1;
pub type CitizenSdkHostEncryptedSecretBlobLoadV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        secret_ref: CitizenSdkHostSecretRefV1,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;
/// The host persists the exact `Vacant -> Sealed -> Tombstone` transition.
/// Tombstones are permanent and must never be physically collapsed to vacant.
pub type CitizenSdkHostEncryptedSecretBlobCompareAndSwapV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        secret_ref: CitizenSdkHostSecretRefV1,
        expected_revision: u64,
        candidate_record: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32,
>;

/// Security-sensitive public wallet facts and authenticated ciphertext only.
/// No method accepts `SecretBuffer` or a plaintext account secret.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostSecureStoreV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub context: *mut c_void,
    pub wallet_profile_load: CitizenSdkHostWalletProfileLoadV1,
    pub wallet_profile_compare_and_swap: CitizenSdkHostWalletProfileCompareAndSwapV1,
    pub encrypted_secret_blob_load: CitizenSdkHostEncryptedSecretBlobLoadV1,
    pub encrypted_secret_blob_compare_and_swap: CitizenSdkHostEncryptedSecretBlobCompareAndSwapV1,
}

impl Default for CitizenSdkHostSecureStoreV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            context: std::ptr::null_mut(),
            wallet_profile_load: None,
            wallet_profile_compare_and_swap: None,
            encrypted_secret_blob_load: None,
            encrypted_secret_blob_compare_and_swap: None,
        }
    }
}

pub type CitizenSdkHostVaultAvailabilityV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostVaultAvailabilityCompletionV1,
    ) -> i32,
>;
/// Creation must atomically reject a retired generation and bind the durable
/// KEK to both wallet index and generation.  A provisioning operation cannot
/// recreate a KEK after retirement, including after process restart.
pub type CitizenSdkHostVaultEnsureWalletKekV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        provisioning_operation_id: CitizenSdkHostId128,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32,
>;
pub type CitizenSdkHostVaultHasWalletKekV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostBoolCompletionV1,
    ) -> i32,
>;
/// Only a random 32-byte DEK crosses this input. Its Rust-owned, zeroizing
/// allocation remains readable until the first completion or synchronous
/// rejection; an asynchronous host should use that stable native pointer and
/// must stop reading it before completion returns. The host wraps it under the
/// exact generation KEK and never sees child-secret plaintext.
pub type CitizenSdkHostVaultWrapDekV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        provisioning_operation_id: CitizenSdkHostId128,
        plaintext_dek: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostBytesCompletionV1,
    ) -> i32,
>;
/// The host writes the unwrapped DEK directly to the SDK-owned 32-byte mutable
/// output, authenticating the user as required by the platform.  It must stop
/// accessing that output before its single status completion returns.
pub type CitizenSdkHostVaultUnwrapDekV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        wrapped_dek: CitizenSdkBytesView,
        plaintext_dek_out: CitizenSdkMutableBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32,
>;
/// Retirement is idempotent and durable.  The generation tombstone must be
/// committed before success completion so late provisioning cannot resurrect
/// the KEK on this or a future process.
pub type CitizenSdkHostVaultRetireWalletKekV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        cleanup_operation_id: CitizenSdkHostId128,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32,
>;

/// 整批追加只认证一次；该回调不创建密钥，也不接收或解封账户秘密。
pub type CitizenSdkHostVaultAuthorizeAddAccountsV1 = Option<
    unsafe extern "C" fn(
        host_context: *mut c_void,
        host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        provisioning_operation_id: CitizenSdkHostId128,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32,
>;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostSecretVaultV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub context: *mut c_void,
    pub availability: CitizenSdkHostVaultAvailabilityV1,
    pub ensure_wallet_kek: CitizenSdkHostVaultEnsureWalletKekV1,
    pub has_wallet_kek: CitizenSdkHostVaultHasWalletKekV1,
    pub wrap_dek: CitizenSdkHostVaultWrapDekV1,
    pub unwrap_dek: CitizenSdkHostVaultUnwrapDekV1,
    pub retire_wallet_kek: CitizenSdkHostVaultRetireWalletKekV1,
    pub authorize_add_accounts: CitizenSdkHostVaultAuthorizeAddAccountsV1,
}

impl Default for CitizenSdkHostSecretVaultV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            context: std::ptr::null_mut(),
            availability: None,
            ensure_wallet_kek: None,
            has_wallet_kek: None,
            wrap_dek: None,
            unwrap_dek: None,
            retire_wallet_kek: None,
            authorize_add_accounts: None,
        }
    }
}

/// CitizenSDK copies the pointed-to vtables before creation returns, so the
/// pointers themselves are borrowed for that call only.  Callback code and
/// each copied `context` must remain valid until instance destruction returns;
/// CitizenSDK never takes ownership of a host context.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostServicesV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub public_store: *const CitizenSdkHostPublicStoreV1,
    pub secure_store: *const CitizenSdkHostSecureStoreV1,
    pub secret_vault: *const CitizenSdkHostSecretVaultV1,
}

impl Default for CitizenSdkHostServicesV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            public_store: std::ptr::null(),
            secure_store: std::ptr::null(),
            secret_vault: std::ptr::null(),
        }
    }
}

/// 独立的只读跨代际存在性投影，不扩长既有Host v1布局，不接收秘密明文。
pub type CitizenSdkHostHasAccountSecretV1 = Option<
    unsafe extern "C" fn(
        *mut c_void,
        u64,
        CitizenSdkAccountId,
        *mut c_void,
        CitizenSdkHostBoolCompletionV1,
    ) -> i32,
>;
pub type CitizenSdkHostHasAnyWalletKeyV1 = Option<
    unsafe extern "C" fn(*mut c_void, u64, u32, *mut c_void, CitizenSdkHostBoolCompletionV1) -> i32,
>;
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkHostSecretPresenceV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub context: *mut c_void,
    pub has_account_secret: CitizenSdkHostHasAccountSecretV1,
    pub has_any_wallet_key: CitizenSdkHostHasAnyWalletKeyV1,
}
#[derive(Clone, Copy)]
struct SendSecretPresence(CitizenSdkHostSecretPresenceV1);
// SAFETY: 与原Host vtable相同，注册者保证回调/context线程安全并保有至真实SDK销毁。
unsafe impl Send for SendSecretPresence {}
unsafe impl Sync for SendSecretPresence {}

/// The expected result shape for one accepted host operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostCompletionKind {
    Record(CitizenSdkHostRecordDomain),
    Status,
    Bool,
    VaultAvailability,
    Bytes(CitizenSdkHostBytesKind),
}

/// Non-secret, stable error produced while policing a host implementation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostProviderError {
    code: CitizenSdkErrorCode,
    message: &'static str,
}

impl HostProviderError {
    const fn new(code: CitizenSdkErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn code(&self) -> CitizenSdkErrorCode {
        self.code
    }

    pub const fn message(&self) -> &'static str {
        self.message
    }
}

impl std::fmt::Display for HostProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for HostProviderError {}

/// Tracks accepted callbacks independently from product request IDs.  The
/// first completion consumes the operation even when it has the wrong shape;
/// a hostile/buggy host therefore cannot repair it by invoking a second
/// callback.  The adapter turns the first failure into the product request's
/// one mandatory completion.
pub struct HostOperationTracker {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, HostCompletionKind>>,
}

impl Default for HostOperationTracker {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }
}

impl HostOperationTracker {
    pub fn reserve(&self, expected: HostCompletionKind) -> Result<u64, HostProviderError> {
        let operation_id = self
            .next
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_add(1).filter(|next| *next != 0)
            })
            .map_err(|_| {
                HostProviderError::new(
                    CitizenSdkErrorCode::Internal,
                    "host operation id space is exhausted",
                )
            })?;
        if operation_id == 0 {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Internal,
                "host operation id 0 is reserved",
            ));
        }
        let mut pending = self.pending.lock().map_err(|_| {
            HostProviderError::new(
                CitizenSdkErrorCode::Internal,
                "host operation tracker is poisoned",
            )
        })?;
        match pending.entry(operation_id) {
            Entry::Vacant(entry) => {
                entry.insert(expected);
            }
            Entry::Occupied(_) => {
                return Err(HostProviderError::new(
                    CitizenSdkErrorCode::Internal,
                    "host operation id collided with a pending operation",
                ));
            }
        }
        Ok(operation_id)
    }

    /// Completes the operation exactly once.  Unknown IDs include both a
    /// duplicate callback and a callback after immediate dispatch rejection.
    pub fn complete(
        &self,
        operation_id: u64,
        actual: HostCompletionKind,
    ) -> Result<(), HostProviderError> {
        if operation_id == 0 {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::InvalidArgument,
                "host completion operation id 0 is invalid",
            ));
        }
        let expected = self
            .pending
            .lock()
            .map_err(|_| {
                HostProviderError::new(
                    CitizenSdkErrorCode::Internal,
                    "host operation tracker is poisoned",
                )
            })?
            .remove(&operation_id)
            .ok_or_else(|| {
                HostProviderError::new(
                    CitizenSdkErrorCode::Integrity,
                    "host completion is unknown or was already consumed",
                )
            })?;
        if expected != actual {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "host completion shape does not match the accepted operation",
            ));
        }
        Ok(())
    }

    /// Removes a reservation only when the operation callback rejected it
    /// synchronously.  A rejected operation must never invoke completion.
    pub fn reject_before_acceptance(&self, operation_id: u64) -> Result<(), HostProviderError> {
        if self
            .pending
            .lock()
            .map_err(|_| {
                HostProviderError::new(
                    CitizenSdkErrorCode::Internal,
                    "host operation tracker is poisoned",
                )
            })?
            .remove(&operation_id)
            .is_none()
        {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "rejected host operation is unknown or already consumed",
            ));
        }
        Ok(())
    }

    pub fn pending_count(&self) -> Result<usize, HostProviderError> {
        self.pending
            .lock()
            .map(|pending| pending.len())
            .map_err(|_| {
                HostProviderError::new(
                    CitizenSdkErrorCode::Internal,
                    "host operation tracker is poisoned",
                )
            })
    }
}

/// Accept only the frozen public error numbers.  Unknown host integers never
/// leak into the SDK result contract and deterministically become INTERNAL.
pub fn decode_host_error_code(value: i32) -> Result<CitizenSdkErrorCode, HostProviderError> {
    let code = match value {
        0 => CitizenSdkErrorCode::Ok,
        1 => CitizenSdkErrorCode::InvalidArgument,
        2 => CitizenSdkErrorCode::InvalidHandle,
        3 => CitizenSdkErrorCode::InvalidState,
        4 => CitizenSdkErrorCode::Unsupported,
        5 => CitizenSdkErrorCode::Unavailable,
        6 => CitizenSdkErrorCode::NotReady,
        7 => CitizenSdkErrorCode::NotFound,
        8 => CitizenSdkErrorCode::Conflict,
        9 => CitizenSdkErrorCode::Integrity,
        10 => CitizenSdkErrorCode::AuthenticationCancelled,
        11 => CitizenSdkErrorCode::AuthenticationRequired,
        12 => CitizenSdkErrorCode::KeyInvalidated,
        13 => CitizenSdkErrorCode::PermissionDenied,
        14 => CitizenSdkErrorCode::Storage,
        15 => CitizenSdkErrorCode::Network,
        16 => CitizenSdkErrorCode::Decode,
        17 => CitizenSdkErrorCode::Timeout,
        18 => CitizenSdkErrorCode::Busy,
        19 => CitizenSdkErrorCode::QueueFull,
        20 => CitizenSdkErrorCode::Internal,
        21 => CitizenSdkErrorCode::Panic,
        22 => CitizenSdkErrorCode::Cancelled,
        _ => {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Internal,
                "host returned an unknown error code",
            ));
        }
    };
    Ok(code)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostDispatchOutcome {
    Accepted,
    Rejected(CitizenSdkErrorCode),
}

/// Applies the synchronous half of the callback contract.  Unknown integers
/// and ordinary rejections both remove the reservation, so a later callback is
/// always rejected as a duplicate/late completion.
pub fn settle_host_dispatch(
    tracker: &HostOperationTracker,
    operation_id: u64,
    status: i32,
) -> Result<HostDispatchOutcome, HostProviderError> {
    match decode_host_error_code(status) {
        Ok(CitizenSdkErrorCode::Ok) => Ok(HostDispatchOutcome::Accepted),
        Ok(code) => {
            tracker.reject_before_acceptance(operation_id)?;
            Ok(HostDispatchOutcome::Rejected(code))
        }
        Err(error) => {
            tracker.reject_before_acceptance(operation_id)?;
            Err(error)
        }
    }
}

pub fn validate_public_store_v1(
    provider: &CitizenSdkHostPublicStoreV1,
) -> Result<(), HostProviderError> {
    validate_versioned_size(
        provider.struct_size,
        std::mem::size_of::<CitizenSdkHostPublicStoreV1>(),
        provider.abi_version,
        "public host store has an incompatible structure",
    )?;
    let chain = [
        provider.chain_database_load.is_some(),
        provider.chain_database_compare_and_swap.is_some(),
    ];
    let runtime = [
        provider.runtime_cache_load.is_some(),
        provider.runtime_cache_store.is_some(),
        provider.runtime_cache_delete.is_some(),
    ];
    let history = [
        provider.transaction_history_query.is_some(),
        provider.transaction_history_mutate.is_some(),
    ];
    let partial = [&chain[..], &runtime[..], &history[..]]
        .iter()
        .any(|group| group.iter().any(|present| *present) && !group.iter().all(|present| *present));
    let empty = !chain[0] && !runtime[0] && !history[0];
    if partial || empty {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "public host store requires nonempty, complete typed callback groups",
        ));
    }
    Ok(())
}

pub fn validate_secure_store_v1(
    provider: &CitizenSdkHostSecureStoreV1,
) -> Result<(), HostProviderError> {
    validate_versioned_size(
        provider.struct_size,
        std::mem::size_of::<CitizenSdkHostSecureStoreV1>(),
        provider.abi_version,
        "secure host store has an incompatible structure",
    )?;
    if provider.wallet_profile_load.is_none()
        || provider.wallet_profile_compare_and_swap.is_none()
        || provider.encrypted_secret_blob_load.is_none()
        || provider.encrypted_secret_blob_compare_and_swap.is_none()
    {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "secure host store must provide every typed callback",
        ));
    }
    Ok(())
}

pub fn validate_secret_vault_v1(
    provider: &CitizenSdkHostSecretVaultV1,
) -> Result<(), HostProviderError> {
    validate_versioned_size(
        provider.struct_size,
        std::mem::size_of::<CitizenSdkHostSecretVaultV1>(),
        provider.abi_version,
        "host secret vault has an incompatible structure",
    )?;
    if provider.availability.is_none()
        || provider.ensure_wallet_kek.is_none()
        || provider.authorize_add_accounts.is_none()
        || provider.has_wallet_kek.is_none()
        || provider.wrap_dek.is_none()
        || provider.unwrap_dek.is_none()
        || provider.retire_wallet_kek.is_none()
    {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "host secret vault must provide every KEK and DEK callback",
        ));
    }
    Ok(())
}

/// Public storage is optional for wallet/signing-only instances. Secure
/// account storage and the device vault remain an all-or-none security bundle.
pub fn validate_host_services_presence(
    services: &CitizenSdkHostServicesV1,
) -> Result<(), HostProviderError> {
    validate_versioned_size(
        services.struct_size,
        std::mem::size_of::<CitizenSdkHostServicesV1>(),
        services.abi_version,
        "host services have an incompatible structure",
    )?;
    if services.public_store.is_null()
        && services.secure_store.is_null()
        && services.secret_vault.is_null()
    {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "host services must contain at least one typed resource group",
        ));
    }
    if services.secure_store.is_null() != services.secret_vault.is_null() {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "secure store and secret vault must be supplied together",
        ));
    }
    Ok(())
}

pub fn validate_record_result_v1(
    result: &CitizenSdkHostRecordResultV1,
    expected_operation_id: u64,
    expected_domain: CitizenSdkHostRecordDomain,
) -> Result<CitizenSdkErrorCode, HostProviderError> {
    validate_versioned_size(
        result.struct_size,
        std::mem::size_of::<CitizenSdkHostRecordResultV1>(),
        result.abi_version,
        "host record completion has an incompatible structure",
    )?;
    validate_operation_id(result.host_operation_id, expected_operation_id)?;
    if result.domain != expected_domain as u32 || result.reserved != [0; 7] {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "host record completion crossed a typed domain or used reserved bytes",
        ));
    }
    let code = decode_host_error_code(result.error_code)?;
    if code != CitizenSdkErrorCode::Ok {
        if result.present != 0 || result.revision != 0 || !is_canonical_empty(result.record) {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "failed host record completion must not return state",
            ));
        }
        return Ok(code);
    }
    if result.present > 1 {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "host record presence flag is not boolean",
        ));
    }
    if result.present == 0 {
        if !is_canonical_empty(result.record) {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "absent host record must use a canonical empty view",
            ));
        }
    } else {
        validate_nonempty_view(
            result.record,
            expected_domain.codec_domain().max_encoded_record_bytes(),
            "host record completion has an invalid byte view",
        )?;
    }
    Ok(code)
}

pub fn validate_status_result_v1(
    result: &CitizenSdkHostStatusResultV1,
    expected_operation_id: u64,
) -> Result<CitizenSdkErrorCode, HostProviderError> {
    validate_versioned_size(
        result.struct_size,
        std::mem::size_of::<CitizenSdkHostStatusResultV1>(),
        result.abi_version,
        "host status completion has an incompatible structure",
    )?;
    validate_operation_id(result.host_operation_id, expected_operation_id)?;
    if result.reserved != 0 {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "host status completion used reserved bytes",
        ));
    }
    decode_host_error_code(result.error_code)
}

pub fn validate_bool_result_v1(
    result: &CitizenSdkHostBoolResultV1,
    expected_operation_id: u64,
) -> Result<(CitizenSdkErrorCode, bool), HostProviderError> {
    validate_versioned_size(
        result.struct_size,
        std::mem::size_of::<CitizenSdkHostBoolResultV1>(),
        result.abi_version,
        "host boolean completion has an incompatible structure",
    )?;
    validate_operation_id(result.host_operation_id, expected_operation_id)?;
    let code = decode_host_error_code(result.error_code)?;
    if result.reserved != [0; 7] || result.value > 1 {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "host boolean completion is not canonical",
        ));
    }
    if code != CitizenSdkErrorCode::Ok && result.value != 0 {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "failed host boolean completion must not return a value",
        ));
    }
    Ok((code, result.value == 1))
}

pub fn validate_vault_availability_result_v1(
    result: &CitizenSdkHostVaultAvailabilityResultV1,
    expected_operation_id: u64,
) -> Result<(CitizenSdkErrorCode, Option<CitizenSdkHostVaultAvailability>), HostProviderError> {
    validate_versioned_size(
        result.struct_size,
        std::mem::size_of::<CitizenSdkHostVaultAvailabilityResultV1>(),
        result.abi_version,
        "vault availability completion has an incompatible structure",
    )?;
    validate_operation_id(result.host_operation_id, expected_operation_id)?;
    let code = decode_host_error_code(result.error_code)?;
    if code != CitizenSdkErrorCode::Ok {
        if result.availability != 0 {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "failed vault availability completion must not return a value",
            ));
        }
        return Ok((code, None));
    }
    let availability = match result.availability {
        1 => CitizenSdkHostVaultAvailability::Available,
        2 => CitizenSdkHostVaultAvailability::NoStrongUserAuthentication,
        3 => CitizenSdkHostVaultAvailability::Unsupported,
        4 => CitizenSdkHostVaultAvailability::Unavailable,
        _ => {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "vault availability completion returned an unknown value",
            ));
        }
    };
    Ok((code, Some(availability)))
}

pub fn validate_bytes_result_v1(
    result: &CitizenSdkHostBytesResultV1,
    expected_operation_id: u64,
    expected_kind: CitizenSdkHostBytesKind,
) -> Result<CitizenSdkErrorCode, HostProviderError> {
    const MAX_WRAPPED_DEK_BYTES: usize = 16 * 1024;

    validate_versioned_size(
        result.struct_size,
        std::mem::size_of::<CitizenSdkHostBytesResultV1>(),
        result.abi_version,
        "host byte completion has an incompatible structure",
    )?;
    validate_operation_id(result.host_operation_id, expected_operation_id)?;
    if result.kind != expected_kind as u32 {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "host byte completion kind does not match the accepted operation",
        ));
    }
    let code = decode_host_error_code(result.error_code)?;
    if code != CitizenSdkErrorCode::Ok {
        if !is_canonical_empty(result.bytes) {
            return Err(HostProviderError::new(
                CitizenSdkErrorCode::Integrity,
                "failed host byte completion must not return bytes",
            ));
        }
        return Ok(code);
    }
    validate_nonempty_view(
        result.bytes,
        MAX_WRAPPED_DEK_BYTES,
        "host DEK completion has an invalid byte view",
    )?;
    Ok(code)
}

// Hidden Rust test exports keep the public C names in `abi.rs` uncluttered.
pub fn validate_host_record_result(
    result: &CitizenSdkHostRecordResultV1,
    expected_operation_id: u64,
    expected_domain: CitizenSdkHostRecordDomain,
) -> Result<CitizenSdkErrorCode, HostProviderError> {
    validate_record_result_v1(result, expected_operation_id, expected_domain)
}

pub fn validate_host_status_result(
    result: &CitizenSdkHostStatusResultV1,
    expected_operation_id: u64,
) -> Result<CitizenSdkErrorCode, HostProviderError> {
    validate_status_result_v1(result, expected_operation_id)
}

pub fn validate_host_bytes_result(
    result: &CitizenSdkHostBytesResultV1,
    expected_operation_id: u64,
    expected_kind: CitizenSdkHostBytesKind,
) -> Result<CitizenSdkErrorCode, HostProviderError> {
    validate_bytes_result_v1(result, expected_operation_id, expected_kind)
}

/// Validates the sole mutable C view before it is handed to the host.  The
/// adapter owns and zeroizes the backing allocation after completion.
pub fn validate_mutable_dek_view(
    view: CitizenSdkMutableBytesView,
) -> Result<(), HostProviderError> {
    if view.data.is_null() || view.len != CITIZENSDK_HOST_DEK_BYTES {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "vault unwrap output must be a writable 32-byte Rust buffer",
        ));
    }
    Ok(())
}

fn validate_versioned_size(
    actual_size: u32,
    expected_size: usize,
    actual_version: u32,
    message: &'static str,
) -> Result<(), HostProviderError> {
    let expected_size = u32::try_from(expected_size).map_err(|_| {
        HostProviderError::new(
            CitizenSdkErrorCode::Internal,
            "host ABI structure size cannot be represented",
        )
    })?;
    if actual_size != expected_size || actual_version != CITIZENSDK_ABI_VERSION {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            message,
        ));
    }
    Ok(())
}

fn validate_operation_id(actual: u64, expected: u64) -> Result<(), HostProviderError> {
    if actual == 0 || actual != expected {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            "host completion operation id does not match",
        ));
    }
    Ok(())
}

fn validate_nonempty_view(
    view: CitizenSdkBytesView,
    max_len: usize,
    message: &'static str,
) -> Result<(), HostProviderError> {
    let len = usize::try_from(view.len)
        .map_err(|_| HostProviderError::new(CitizenSdkErrorCode::Integrity, message))?;
    if view.data.is_null() || len == 0 || len > max_len {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::Integrity,
            message,
        ));
    }
    Ok(())
}

const fn is_canonical_empty(view: CitizenSdkBytesView) -> bool {
    view.data.is_null() && view.len == 0
}

pub const fn empty_bytes_view() -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: std::ptr::null(),
        len: 0,
    }
}

// -------------------------------------------------------------------------
// Production bridge. Completion callbacks use a process-global 64-bit token
// registry and never dereference `sdk_context`, eliminating instance-pointer
// UAF when a host completes after an SDK future was cancelled.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingKind {
    Record(CitizenSdkHostRecordDomain),
    Status,
    Bool,
    VaultAvailability,
    WrappedDek,
    UnwrappedDek,
}

enum HostCompletion {
    Record {
        code: CitizenSdkErrorCode,
        present: bool,
        revision: u64,
        record: Option<Vec<u8>>,
    },
    Status(CitizenSdkErrorCode),
    Bool(CitizenSdkErrorCode, bool),
    VaultAvailability(CitizenSdkErrorCode, Option<CitizenSdkHostVaultAvailability>),
    WrappedDek(CitizenSdkErrorCode, Option<Vec<u8>>),
    UnwrappedDek(CitizenSdkErrorCode, Zeroizing<Vec<u8>>),
}

struct PendingHostOperation {
    owner_id: u64,
    kind: PendingKind,
    sender: oneshot::Sender<Result<HostCompletion, ContractError>>,
    secret_buffer: Option<Zeroizing<Vec<u8>>>,
}

#[derive(Default)]
struct HostOperationRegistry {
    pending: HashMap<u64, PendingHostOperation>,
    /// A completion has atomically claimed this operation but its callback has
    /// not returned yet. Destroy must count this phase as outstanding because
    /// the callback still executes SDK code and may still copy host memory.
    completing: HashMap<u64, u64>,
}

static NEXT_HOST_OWNER_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_HOST_OPERATION_ID: AtomicU64 = AtomicU64::new(1);
static HOST_OPERATIONS: OnceLock<Mutex<HostOperationRegistry>> = OnceLock::new();

fn host_operations() -> &'static Mutex<HostOperationRegistry> {
    HOST_OPERATIONS.get_or_init(|| Mutex::new(HostOperationRegistry::default()))
}

fn next_global_id(counter: &AtomicU64, message: &'static str) -> Result<u64, ContractError> {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_add(1).filter(|next| *next != 0)
        })
        .map_err(|_| ContractError::new(ContractErrorCode::Internal, message))
}

fn reserve_host_operation(
    owner_id: u64,
    kind: PendingKind,
    secret_buffer: Option<Zeroizing<Vec<u8>>>,
) -> Result<
    (
        u64,
        oneshot::Receiver<Result<HostCompletion, ContractError>>,
    ),
    ContractError,
> {
    let operation_id = next_global_id(
        &NEXT_HOST_OPERATION_ID,
        "host operation id space is exhausted",
    )?;
    let (sender, receiver) = oneshot::channel();
    let mut registry = host_operations().lock().map_err(|_| {
        ContractError::new(
            ContractErrorCode::Internal,
            "host operation registry is poisoned",
        )
    })?;
    if registry.completing.contains_key(&operation_id) {
        return Err(ContractError::new(
            ContractErrorCode::Internal,
            "host operation id collided with an active completion",
        ));
    }
    match registry.pending.entry(operation_id) {
        Entry::Vacant(entry) => {
            entry.insert(PendingHostOperation {
                owner_id,
                kind,
                sender,
                secret_buffer,
            });
        }
        Entry::Occupied(_) => {
            return Err(ContractError::new(
                ContractErrorCode::Internal,
                "host operation id collided with a pending operation",
            ));
        }
    }
    Ok((operation_id, receiver))
}

fn operation_token(operation_id: u64) -> *mut c_void {
    operation_id as usize as *mut c_void
}

fn token_operation_id(context: *mut c_void) -> u64 {
    context as usize as u64
}

fn reject_host_operation(operation_id: u64) -> Result<(), ContractError> {
    let removed = host_operations()
        .lock()
        .map_err(|_| {
            ContractError::new(
                ContractErrorCode::Internal,
                "host operation registry is poisoned",
            )
        })?
        .pending
        .remove(&operation_id);
    if removed.is_none() {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "host completed an operation and then rejected its dispatch",
        ));
    }
    Ok(())
}

fn settle_production_dispatch(operation_id: u64, status: i32) -> Result<(), ContractError> {
    match decode_host_error_code(status) {
        Ok(CitizenSdkErrorCode::Ok) => Ok(()),
        Ok(code) => {
            reject_host_operation(operation_id)?;
            Err(host_error(code, "host rejected CitizenSDK operation"))
        }
        Err(error) => {
            // Unknown synchronous integers are still rejection-before-acceptance:
            // remove the reservation before surfacing their stable INTERNAL map.
            reject_host_operation(operation_id)?;
            Err(host_provider_contract_error(error))
        }
    }
}

async fn await_host_completion(
    receiver: oneshot::Receiver<Result<HostCompletion, ContractError>>,
) -> Result<HostCompletion, ContractError> {
    receiver.await.map_err(|_| {
        ContractError::new(
            ContractErrorCode::Internal,
            "host completion channel closed before exactly-once completion",
        )
    })?
}

fn complete_host_operation(
    operation_id: u64,
    actual_kind: PendingKind,
    build: impl FnOnce(PendingKind, Option<Zeroizing<Vec<u8>>>) -> Result<HostCompletion, ContractError>,
) {
    let Some(mut claim) = claim_host_operation(operation_id) else {
        // Duplicate, late-after-rejection, and unknown completions are ignored
        // without dereferencing any instance-owned pointer.
        return;
    };
    let Some(entry) = claim.entry.take() else {
        // `claim_host_operation` constructs this guard with an entry. Keep the
        // callback boundary panic-free and fail closed if that invariant is
        // ever broken by a future internal change.
        return;
    };
    let completion = if pending_kinds_match(entry.kind, actual_kind) {
        build(entry.kind, entry.secret_buffer)
    } else {
        Err(ContractError::new(
            ContractErrorCode::Integrity,
            "host completion kind does not match the accepted operation",
        ))
    };
    let _ = entry.sender.send(completion);
    // `claim` remains alive through validation, host-memory copying and result
    // delivery. Its Drop is the linearization point at which destroy may stop
    // counting this callback as outstanding.
}

struct ClaimedHostOperation {
    operation_id: u64,
    owner_id: u64,
    entry: Option<PendingHostOperation>,
}

impl Drop for ClaimedHostOperation {
    fn drop(&mut self) {
        if let Ok(mut registry) = host_operations().lock() {
            let removed = registry.completing.remove(&self.operation_id);
            debug_assert_eq!(removed, Some(self.owner_id));
        }
    }
}

/// Atomically moves one operation from pending to callback-in-progress. This
/// preserves exactly-once claim while closing the destroy/remove callback gap.
fn claim_host_operation(operation_id: u64) -> Option<ClaimedHostOperation> {
    let mut registry = host_operations().lock().ok()?;
    let entry = registry.pending.remove(&operation_id)?;
    let owner_id = entry.owner_id;
    if registry.completing.contains_key(&operation_id) {
        // Monotonic IDs make this unreachable; restore the pending fact and
        // fail closed if registry corruption is ever observed.
        registry.pending.insert(operation_id, entry);
        return None;
    }
    registry.completing.insert(operation_id, owner_id);
    Some(ClaimedHostOperation {
        operation_id,
        owner_id,
        entry: Some(entry),
    })
}

const fn pending_kinds_match(expected: PendingKind, actual: PendingKind) -> bool {
    matches!(
        (expected, actual),
        (PendingKind::Record(_), PendingKind::Record(_))
            | (PendingKind::Status, PendingKind::Status)
            | (PendingKind::Bool, PendingKind::Bool)
            | (
                PendingKind::VaultAvailability,
                PendingKind::VaultAvailability
            )
            | (PendingKind::WrappedDek, PendingKind::WrappedDek)
            | (PendingKind::UnwrappedDek, PendingKind::UnwrappedDek)
    )
}

fn completion_guard(operation: impl FnOnce() + std::panic::UnwindSafe) {
    let _ = std::panic::catch_unwind(operation);
}

/// Rejects a crossed non-null completion before it can claim an unrelated
/// operation. The host receives both values at dispatch and must return them as
/// one inseparable identity pair. This check deliberately performs no registry
/// access; a late or malicious callback cannot use a real token together with
/// another result ID to cancel, complete, or otherwise observe that operation.
const fn completion_identity_matches(token: u64, result_operation_id: u64) -> bool {
    token == result_operation_id
}

unsafe extern "C" fn production_record_completion(
    sdk_context: *mut c_void,
    result: *const CitizenSdkHostRecordResultV1,
) {
    completion_guard(|| {
        let token = token_operation_id(sdk_context);
        if token == 0 {
            return;
        }
        if result.is_null() {
            complete_host_operation(
                token,
                PendingKind::Record(CitizenSdkHostRecordDomain::ChainDatabase),
                |_, _| {
                    Err(ContractError::new(
                        ContractErrorCode::Integrity,
                        "host record completion result is null",
                    ))
                },
            );
            return;
        }
        // SAFETY: the host contract keeps the result readable for this call.
        let result = unsafe { *result };
        if !completion_identity_matches(token, result.host_operation_id) {
            return;
        }
        complete_host_operation(
            token,
            PendingKind::Record(CitizenSdkHostRecordDomain::ChainDatabase),
            |expected, _| {
                let PendingKind::Record(domain) = expected else {
                    return Err(ContractError::new(
                        ContractErrorCode::Integrity,
                        "host record completion reached a non-record operation",
                    ));
                };
                let code = validate_record_result_v1(&result, token, domain)
                    .map_err(host_provider_contract_error)?;
                let record = if code == CitizenSdkErrorCode::Ok && result.present == 1 {
                    Some(copy_host_view(result.record)?)
                } else {
                    None
                };
                Ok(HostCompletion::Record {
                    code,
                    present: result.present == 1,
                    revision: result.revision,
                    record,
                })
            },
        );
    });
}

unsafe extern "C" fn production_status_completion(
    sdk_context: *mut c_void,
    result: *const CitizenSdkHostStatusResultV1,
) {
    completion_guard(|| {
        let token = token_operation_id(sdk_context);
        if token == 0 {
            return;
        }
        if result.is_null() {
            complete_host_operation(token, PendingKind::Status, |_, _| {
                Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "host status completion result is null",
                ))
            });
            return;
        }
        // SAFETY: the host contract keeps the result readable for this call.
        let result = unsafe { *result };
        if !completion_identity_matches(token, result.host_operation_id) {
            return;
        }
        let kind = host_operations()
            .lock()
            .ok()
            .and_then(|registry| registry.pending.get(&token).map(|entry| entry.kind));
        let Some(kind @ (PendingKind::Status | PendingKind::UnwrappedDek)) = kind else {
            complete_host_operation(token, PendingKind::Status, |_, _| {
                Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "host status completion reached the wrong operation kind",
                ))
            });
            return;
        };
        complete_host_operation(token, kind, |expected, secret_buffer| {
            let code =
                validate_status_result_v1(&result, token).map_err(host_provider_contract_error)?;
            match expected {
                PendingKind::Status => Ok(HostCompletion::Status(code)),
                PendingKind::UnwrappedDek => {
                    let buffer = secret_buffer.ok_or_else(|| {
                        ContractError::new(
                            ContractErrorCode::Internal,
                            "unwrap operation lost its Rust-owned DEK buffer",
                        )
                    })?;
                    Ok(HostCompletion::UnwrappedDek(code, buffer))
                }
                _ => Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "host status completion reached an incompatible operation",
                )),
            }
        });
    });
}

unsafe extern "C" fn production_bool_completion(
    sdk_context: *mut c_void,
    result: *const CitizenSdkHostBoolResultV1,
) {
    completion_guard(|| {
        let token = token_operation_id(sdk_context);
        if token == 0 {
            return;
        }
        if result.is_null() {
            complete_host_operation(token, PendingKind::Bool, |_, _| {
                Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "host boolean completion result is null",
                ))
            });
            return;
        }
        // SAFETY: the host contract keeps the result readable for this call.
        let result = unsafe { *result };
        if !completion_identity_matches(token, result.host_operation_id) {
            return;
        }
        complete_host_operation(token, PendingKind::Bool, |_, _| {
            let (code, value) =
                validate_bool_result_v1(&result, token).map_err(host_provider_contract_error)?;
            Ok(HostCompletion::Bool(code, value))
        });
    });
}

unsafe extern "C" fn production_vault_availability_completion(
    sdk_context: *mut c_void,
    result: *const CitizenSdkHostVaultAvailabilityResultV1,
) {
    completion_guard(|| {
        let token = token_operation_id(sdk_context);
        if token == 0 {
            return;
        }
        if result.is_null() {
            complete_host_operation(token, PendingKind::VaultAvailability, |_, _| {
                Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "vault availability completion result is null",
                ))
            });
            return;
        }
        // SAFETY: the host contract keeps the result readable for this call.
        let result = unsafe { *result };
        if !completion_identity_matches(token, result.host_operation_id) {
            return;
        }
        complete_host_operation(token, PendingKind::VaultAvailability, |_, _| {
            let (code, availability) = validate_vault_availability_result_v1(&result, token)
                .map_err(host_provider_contract_error)?;
            Ok(HostCompletion::VaultAvailability(code, availability))
        });
    });
}

unsafe extern "C" fn production_wrapped_dek_completion(
    sdk_context: *mut c_void,
    result: *const CitizenSdkHostBytesResultV1,
) {
    completion_guard(|| {
        let token = token_operation_id(sdk_context);
        if token == 0 {
            return;
        }
        if result.is_null() {
            complete_host_operation(token, PendingKind::WrappedDek, |_, _| {
                Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "wrapped DEK completion result is null",
                ))
            });
            return;
        }
        // SAFETY: the host contract keeps the result readable for this call.
        let result = unsafe { *result };
        if !completion_identity_matches(token, result.host_operation_id) {
            return;
        }
        complete_host_operation(token, PendingKind::WrappedDek, |_, _| {
            let code =
                validate_bytes_result_v1(&result, token, CitizenSdkHostBytesKind::WrappedDek)
                    .map_err(host_provider_contract_error)?;
            let bytes = if code == CitizenSdkErrorCode::Ok {
                Some(copy_host_view(result.bytes)?)
            } else {
                None
            };
            Ok(HostCompletion::WrappedDek(code, bytes))
        });
    });
}

fn copy_host_view(view: CitizenSdkBytesView) -> Result<Vec<u8>, ContractError> {
    let len = usize::try_from(view.len).map_err(|_| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "host byte view length exceeds this platform",
        )
    })?;
    if len == 0 {
        return Ok(Vec::new());
    }
    if view.data.is_null() {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "host returned a null non-empty byte view",
        ));
    }
    // SAFETY: the host contract keeps this view readable for the completion
    // call; all public validators bounded `len` before this copy.
    Ok(unsafe { std::slice::from_raw_parts(view.data, len) }.to_vec())
}

fn host_provider_contract_error(error: HostProviderError) -> ContractError {
    host_error(error.code(), error.message())
}

fn codec_contract_error(error: HostCodecError) -> ContractError {
    let code = error.contract_code();
    ContractError::new(code, error.message())
}

pub(crate) fn host_error(code: CitizenSdkErrorCode, message: &'static str) -> ContractError {
    let contract = match code {
        CitizenSdkErrorCode::InvalidArgument | CitizenSdkErrorCode::InvalidHandle => {
            ContractErrorCode::InvalidArgument
        }
        CitizenSdkErrorCode::InvalidState | CitizenSdkErrorCode::Busy => {
            ContractErrorCode::InvalidState
        }
        CitizenSdkErrorCode::Unsupported => ContractErrorCode::Unsupported,
        CitizenSdkErrorCode::Unavailable => ContractErrorCode::Unavailable,
        CitizenSdkErrorCode::NotReady | CitizenSdkErrorCode::QueueFull => {
            ContractErrorCode::NotReady
        }
        CitizenSdkErrorCode::NotFound => ContractErrorCode::NotFound,
        CitizenSdkErrorCode::Conflict => ContractErrorCode::Conflict,
        CitizenSdkErrorCode::Integrity => ContractErrorCode::Integrity,
        CitizenSdkErrorCode::AuthenticationCancelled | CitizenSdkErrorCode::Cancelled => {
            ContractErrorCode::AuthenticationCancelled
        }
        CitizenSdkErrorCode::AuthenticationRequired => ContractErrorCode::AuthenticationRequired,
        CitizenSdkErrorCode::KeyInvalidated => ContractErrorCode::KeyInvalidated,
        CitizenSdkErrorCode::PermissionDenied => ContractErrorCode::PermissionDenied,
        CitizenSdkErrorCode::Storage => ContractErrorCode::Storage,
        CitizenSdkErrorCode::Network => ContractErrorCode::Network,
        CitizenSdkErrorCode::Decode => ContractErrorCode::Decode,
        CitizenSdkErrorCode::Timeout => ContractErrorCode::Timeout,
        CitizenSdkErrorCode::Ok | CitizenSdkErrorCode::Internal | CitizenSdkErrorCode::Panic => {
            ContractErrorCode::Internal
        }
    };
    ContractError::new(contract, message)
}

#[derive(Clone, Copy)]
struct SendPublicStore(CitizenSdkHostPublicStoreV1);
// SAFETY: creation requires the host to keep callback code/context valid and
// thread-safe until destruction; raw contexts are only passed back verbatim.
unsafe impl Send for SendPublicStore {}
// SAFETY: same contract as `Send` and callbacks may complete concurrently.
unsafe impl Sync for SendPublicStore {}

#[derive(Clone, Copy)]
struct SendSecureStore(CitizenSdkHostSecureStoreV1);
// SAFETY: see `SendPublicStore`.
unsafe impl Send for SendSecureStore {}
// SAFETY: see `SendPublicStore`.
unsafe impl Sync for SendSecureStore {}

#[derive(Clone, Copy)]
struct SendSecretVault(CitizenSdkHostSecretVaultV1);
// SAFETY: see `SendPublicStore`.
unsafe impl Send for SendSecretVault {}
// SAFETY: see `SendPublicStore`.
unsafe impl Sync for SendSecretVault {}

struct HostBridge {
    // 默认装配已在同一构造边界核验Rust安全资源；自定义宿主仍需原secure回调组。
    rust_secure: bool,
    owner_id: u64,
    operation_gate: Mutex<HostOperationGate>,
    public: Option<SendPublicStore>,
    secure: Option<SendSecureStore>,
    vault: Option<SendSecretVault>,
}

struct HostOperationGate {
    accepting: bool,
    started: bool,
    presence: Option<SendSecretPresence>,
}

impl HostBridge {
    fn secret_presence(&self) -> Result<SendSecretPresence, ContractError> {
        let gate = self
            .operation_gate
            .lock()
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "存在性查询门已损坏"))?;
        if !gate.accepting {
            return Err(ContractError::new(
                ContractErrorCode::InvalidState,
                "Host正在关闭",
            ));
        }
        gate.presence.ok_or_else(|| {
            ContractError::new(ContractErrorCode::Unsupported, "未登记完整秘密存在性查询")
        })
    }

    fn public(&self) -> Result<SendPublicStore, ContractError> {
        self.public.ok_or_else(|| {
            ContractError::new(
                ContractErrorCode::Unsupported,
                "public store is not composed for these modules",
            )
        })
    }

    /// Linearizes the accepting check and insertion into the global pending
    /// registry. Once `close_operation_gate` returns, no operation for this
    /// owner can be inserted until an explicit reopen.
    fn reserve_operation(
        &self,
        kind: PendingKind,
        secret_buffer: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<
        (
            u64,
            oneshot::Receiver<Result<HostCompletion, ContractError>>,
        ),
        ContractError,
    > {
        let mut gate = self.operation_gate.lock().map_err(|_| {
            ContractError::new(
                ContractErrorCode::Internal,
                "host operation gate is poisoned",
            )
        })?;
        if !gate.accepting {
            return Err(ContractError::new(
                ContractErrorCode::InvalidState,
                "host operation gate is closed for teardown",
            ));
        }
        // Keep the gate locked until the pending entry is visible. A concurrent
        // close therefore happens entirely before this reservation or after it.
        gate.started = true;
        reserve_host_operation(self.owner_id, kind, secret_buffer)
    }

    fn close_operation_gate(&self) -> Result<(), ContractError> {
        let mut gate = self.operation_gate.lock().map_err(|_| {
            ContractError::new(
                ContractErrorCode::Internal,
                "host operation gate is poisoned",
            )
        })?;
        gate.accepting = false;
        Ok(())
    }

    fn reopen_operation_gate(&self) -> Result<(), ContractError> {
        let mut gate = self.operation_gate.lock().map_err(|_| {
            ContractError::new(
                ContractErrorCode::Internal,
                "host operation gate is poisoned",
            )
        })?;
        gate.accepting = true;
        Ok(())
    }

    async fn call_record(
        &self,
        domain: CitizenSdkHostRecordDomain,
        dispatch: impl FnOnce(u64, *mut c_void, CitizenSdkHostRecordCompletionV1) -> i32,
    ) -> Result<HostRecordCompletion, ContractError> {
        let (operation_id, receiver) = self.reserve_operation(PendingKind::Record(domain), None)?;
        let status = dispatch(
            operation_id,
            operation_token(operation_id),
            Some(production_record_completion),
        );
        settle_production_dispatch(operation_id, status)?;
        match await_host_completion(receiver).await? {
            HostCompletion::Record {
                code,
                present,
                revision,
                record,
            } => Ok(HostRecordCompletion {
                code,
                present,
                revision,
                record,
            }),
            _ => Err(ContractError::new(
                ContractErrorCode::Integrity,
                "host record operation received a different completion payload",
            )),
        }
    }

    async fn call_status(
        &self,
        dispatch: impl FnOnce(u64, *mut c_void, CitizenSdkHostStatusCompletionV1) -> i32,
    ) -> Result<CitizenSdkErrorCode, ContractError> {
        let (operation_id, receiver) = self.reserve_operation(PendingKind::Status, None)?;
        let status = dispatch(
            operation_id,
            operation_token(operation_id),
            Some(production_status_completion),
        );
        settle_production_dispatch(operation_id, status)?;
        match await_host_completion(receiver).await? {
            HostCompletion::Status(code) => Ok(code),
            _ => Err(ContractError::new(
                ContractErrorCode::Integrity,
                "host status operation received a different completion payload",
            )),
        }
    }

    async fn call_bool(
        &self,
        dispatch: impl FnOnce(u64, *mut c_void, CitizenSdkHostBoolCompletionV1) -> i32,
    ) -> Result<(CitizenSdkErrorCode, bool), ContractError> {
        let (operation_id, receiver) = self.reserve_operation(PendingKind::Bool, None)?;
        let status = dispatch(
            operation_id,
            operation_token(operation_id),
            Some(production_bool_completion),
        );
        settle_production_dispatch(operation_id, status)?;
        match await_host_completion(receiver).await? {
            HostCompletion::Bool(code, value) => Ok((code, value)),
            _ => Err(ContractError::new(
                ContractErrorCode::Integrity,
                "host boolean operation received a different completion payload",
            )),
        }
    }

    async fn call_availability(
        &self,
        dispatch: impl FnOnce(u64, *mut c_void, CitizenSdkHostVaultAvailabilityCompletionV1) -> i32,
    ) -> Result<(CitizenSdkErrorCode, Option<CitizenSdkHostVaultAvailability>), ContractError> {
        let (operation_id, receiver) =
            self.reserve_operation(PendingKind::VaultAvailability, None)?;
        let status = dispatch(
            operation_id,
            operation_token(operation_id),
            Some(production_vault_availability_completion),
        );
        settle_production_dispatch(operation_id, status)?;
        match await_host_completion(receiver).await? {
            HostCompletion::VaultAvailability(code, availability) => Ok((code, availability)),
            _ => Err(ContractError::new(
                ContractErrorCode::Integrity,
                "vault availability received a different completion payload",
            )),
        }
    }

    async fn call_wrap_dek(
        &self,
        plaintext_dek: Zeroizing<Vec<u8>>,
        dispatch: impl FnOnce(
            u64,
            CitizenSdkBytesView,
            *mut c_void,
            CitizenSdkHostBytesCompletionV1,
        ) -> i32,
    ) -> Result<(CitizenSdkErrorCode, Option<Vec<u8>>), ContractError> {
        if plaintext_dek.len() != CITIZENSDK_HOST_DEK_BYTES as usize {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "vault wrap input must be exactly 32 bytes",
            ));
        }
        // The Vec allocation remains stable when its owner moves into the
        // pending registry. It is zeroized/dropped by the first completion or
        // synchronous rejection, even if the awaiting SDK future is cancelled.
        let input = input_view(plaintext_dek.as_ref());
        let (operation_id, receiver) =
            self.reserve_operation(PendingKind::WrappedDek, Some(plaintext_dek))?;
        let status = dispatch(
            operation_id,
            input,
            operation_token(operation_id),
            Some(production_wrapped_dek_completion),
        );
        settle_production_dispatch(operation_id, status)?;
        match await_host_completion(receiver).await? {
            HostCompletion::WrappedDek(code, bytes) => Ok((code, bytes)),
            _ => Err(ContractError::new(
                ContractErrorCode::Integrity,
                "vault wrap received a different completion payload",
            )),
        }
    }

    async fn call_unwrap_dek(
        &self,
        dispatch: impl FnOnce(
            u64,
            CitizenSdkMutableBytesView,
            *mut c_void,
            CitizenSdkHostStatusCompletionV1,
        ) -> i32,
    ) -> Result<(CitizenSdkErrorCode, Zeroizing<Vec<u8>>), ContractError> {
        // Keep the raw mutable view entirely on the synchronous dispatch side
        // of this future.  The pending registry owns the backing buffer across
        // the await and hands it back only after the exactly-once completion.
        let receiver = {
            let mut buffer = Zeroizing::new(vec![0_u8; CITIZENSDK_HOST_DEK_BYTES as usize]);
            let output = CitizenSdkMutableBytesView {
                data: buffer.as_mut_ptr(),
                len: buffer.len() as u64,
            };
            validate_mutable_dek_view(output).map_err(host_provider_contract_error)?;
            let (operation_id, receiver) =
                self.reserve_operation(PendingKind::UnwrappedDek, Some(buffer))?;
            let status = dispatch(
                operation_id,
                output,
                operation_token(operation_id),
                Some(production_status_completion),
            );
            settle_production_dispatch(operation_id, status)?;
            receiver
        };
        match await_host_completion(receiver).await? {
            HostCompletion::UnwrappedDek(code, buffer) => Ok((code, buffer)),
            _ => Err(ContractError::new(
                ContractErrorCode::Integrity,
                "vault unwrap received a different completion payload",
            )),
        }
    }

    fn pending_count(&self) -> Result<usize, ContractError> {
        let registry = host_operations().lock().map_err(|_| {
            ContractError::new(
                ContractErrorCode::Internal,
                "host operation registry is poisoned",
            )
        })?;
        let pending = registry
            .pending
            .values()
            .filter(|entry| entry.owner_id == self.owner_id)
            .count();
        let completing = registry
            .completing
            .values()
            .filter(|owner_id| **owner_id == self.owner_id)
            .count();
        pending.checked_add(completing).ok_or_else(|| {
            ContractError::new(
                ContractErrorCode::Internal,
                "host operation outstanding count overflowed",
            )
        })
    }
}

struct HostRecordCompletion {
    code: CitizenSdkErrorCode,
    present: bool,
    revision: u64,
    record: Option<Vec<u8>>,
}

/// Owns copied host vtables and projects them into the five typed contracts.
#[derive(Clone)]
pub struct HostServicesAdapter {
    bridge: Arc<HostBridge>,
}

impl HostServicesAdapter {
    /// 只能在首次Host操作之前登记一次；不允许在正在使用的context下原地换提供者。
    /// # Safety
    /// 回调代码与context必须线程安全，并保有至SDK成功销毁。
    pub unsafe fn set_secret_presence_provider(
        &self,
        provider: CitizenSdkHostSecretPresenceV1,
    ) -> Result<(), ContractError> {
        if provider.struct_size as usize != std::mem::size_of::<CitizenSdkHostSecretPresenceV1>()
            || provider.abi_version != CITIZENSDK_ABI_VERSION
            || provider.has_account_secret.is_none()
            || provider.has_any_wallet_key.is_none()
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "秘密存在性回调不完整",
            ));
        }
        if self.bridge.vault.is_none() || (!self.bridge.rust_secure && self.bridge.secure.is_none())
        {
            return Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "实例没有安全仓储及金库",
            ));
        }
        let mut gate =
            self.bridge.operation_gate.lock().map_err(|_| {
                ContractError::new(ContractErrorCode::Internal, "存在性查询门已损坏")
            })?;
        if !gate.accepting || gate.started || gate.presence.is_some() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidState,
                "存在性提供者已冻结",
            ));
        }
        gate.presence = Some(SendSecretPresence(provider));
        Ok(())
    }

    pub(crate) unsafe fn from_vault(
        value: *const CitizenSdkHostSecretVaultV1,
    ) -> Result<Self, ContractError> {
        let vault = crate::read_versioned(value, "secret vault").map_err(|_| {
            ContractError::new(ContractErrorCode::InvalidArgument, "vault ABI differs")
        })?;
        validate_secret_vault_v1(&vault).map_err(host_provider_contract_error)?;
        Ok(Self {
            bridge: Arc::new(HostBridge {
                rust_secure: true,
                owner_id: next_global_id(&NEXT_HOST_OWNER_ID, "host provider owner id exhausted")?,
                operation_gate: Mutex::new(HostOperationGate {
                    accepting: true,
                    started: false,
                    presence: None,
                }),
                public: None,
                secure: None,
                vault: Some(SendSecretVault(vault)),
            }),
        })
    }

    /// Copies validated host vtables. Callback contexts remain host-owned.
    ///
    /// # Safety
    /// Every non-null vtable pointer must be readable for this call, and its
    /// callback code/context must remain valid and thread-safe until the SDK
    /// instance is successfully destroyed.
    pub unsafe fn try_from_ffi(services: &CitizenSdkHostServicesV1) -> Result<Self, ContractError> {
        validate_host_services_presence(services).map_err(host_provider_contract_error)?;
        // SAFETY: guaranteed by this constructor's caller contract.
        let public = if services.public_store.is_null() {
            None
        } else {
            let public = unsafe { *services.public_store };
            validate_public_store_v1(&public).map_err(host_provider_contract_error)?;
            Some(SendPublicStore(public))
        };
        let (secure, vault) = if services.secure_store.is_null() {
            (None, None)
        } else {
            // SAFETY: all-or-none presence was validated above and guaranteed
            // readable by this constructor's caller contract.
            let secure = unsafe { *services.secure_store };
            // SAFETY: same as secure store.
            let vault = unsafe { *services.secret_vault };
            validate_secure_store_v1(&secure).map_err(host_provider_contract_error)?;
            validate_secret_vault_v1(&vault).map_err(host_provider_contract_error)?;
            (Some(SendSecureStore(secure)), Some(SendSecretVault(vault)))
        };
        Ok(Self {
            bridge: Arc::new(HostBridge {
                rust_secure: false,
                owner_id: next_global_id(
                    &NEXT_HOST_OWNER_ID,
                    "host provider owner id space is exhausted",
                )?,
                operation_gate: Mutex::new(HostOperationGate {
                    accepting: true,
                    started: false,
                    presence: None,
                }),
                public,
                secure,
                vault,
            }),
        })
    }

    pub fn has_chain_database(&self) -> bool {
        self.bridge
            .public
            .is_some_and(|store| store.0.chain_database_load.is_some())
    }

    pub fn has_runtime_cache(&self) -> bool {
        self.bridge
            .public
            .is_some_and(|store| store.0.runtime_cache_load.is_some())
    }

    pub fn has_history(&self) -> bool {
        self.bridge
            .public
            .is_some_and(|store| store.0.transaction_history_query.is_some())
    }

    pub fn chain_database_store(&self) -> Arc<dyn ChainDatabaseStore> {
        Arc::new(HostChainDatabaseStore {
            bridge: Arc::clone(&self.bridge),
        })
    }

    pub fn runtime_cache_store(&self) -> Arc<dyn RuntimeCacheStore> {
        Arc::new(HostRuntimeCacheStore {
            bridge: Arc::clone(&self.bridge),
        })
    }

    pub fn transaction_history_store(&self) -> Arc<dyn TransactionHistoryStore> {
        Arc::new(HostTransactionHistoryStore {
            bridge: Arc::clone(&self.bridge),
        })
    }

    pub fn wallet_profile_store(&self) -> Option<Arc<dyn WalletProfileStore>> {
        self.bridge.secure.map(|_| {
            Arc::new(HostWalletProfileStore {
                bridge: Arc::clone(&self.bridge),
            }) as Arc<dyn WalletProfileStore>
        })
    }

    pub fn encrypted_secret_blob_store(&self) -> Option<Arc<dyn EncryptedSecretBlobStore>> {
        self.bridge.secure.map(|_| {
            Arc::new(HostEncryptedSecretBlobStore {
                bridge: Arc::clone(&self.bridge),
            }) as Arc<dyn EncryptedSecretBlobStore>
        })
    }

    pub fn secret_vault(&self) -> Option<Arc<dyn SecretVault>> {
        self.bridge.vault.map(|_| {
            Arc::new(HostSecretVault {
                bridge: Arc::clone(&self.bridge),
                authorizing: None,
            }) as Arc<dyn SecretVault>
        })
    }

    /// 只为当前查看创建值级观察器，仍共享本实例原 HostBridge/AES 路径；禁止全局认证标记。
    pub(crate) fn private_key_view_vault(
        &self,
        authorizing: Arc<dyn Fn(u64) -> i32 + Send + Sync>,
    ) -> Option<Arc<dyn SecretVault>> {
        self.bridge.vault.map(|_| {
            Arc::new(HostSecretVault {
                bridge: Arc::clone(&self.bridge),
                authorizing: Some(authorizing),
            }) as Arc<dyn SecretVault>
        })
    }

    pub fn pending_host_operations(&self) -> Result<usize, ContractError> {
        self.bridge.pending_count()
    }

    /// Idempotently freezes creation of host operations for teardown. The
    /// accepting check and pending-map insertion share one mutex, so a pending
    /// scan performed after this returns cannot miss a concurrent reservation.
    pub fn close_host_operation_gate(&self) -> Result<(), ContractError> {
        self.bridge.close_operation_gate()
    }

    /// Idempotently restores operation acceptance after a recoverable destroy
    /// preflight (for example BUSY because an accepted host callback remains).
    pub fn reopen_host_operation_gate(&self) -> Result<(), ContractError> {
        self.bridge.reopen_operation_gate()
    }
}

#[derive(Clone)]
struct HostChainDatabaseStore {
    bridge: Arc<HostBridge>,
}

#[derive(Clone)]
struct HostRuntimeCacheStore {
    bridge: Arc<HostBridge>,
}

#[derive(Clone)]
struct HostTransactionHistoryStore {
    bridge: Arc<HostBridge>,
}

#[derive(Clone)]
struct HostWalletProfileStore {
    bridge: Arc<HostBridge>,
}

#[derive(Clone)]
struct HostEncryptedSecretBlobStore {
    bridge: Arc<HostBridge>,
}

#[derive(Clone)]
struct HostSecretVault {
    bridge: Arc<HostBridge>,
    authorizing: Option<Arc<dyn Fn(u64) -> i32 + Send + Sync>>,
}

fn input_view(bytes: &[u8]) -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    }
}

fn host_hash(hash: Hash32) -> CitizenSdkHostHash32 {
    CitizenSdkHostHash32 {
        bytes: hash.into_bytes(),
    }
}

fn host_id(bytes: [u8; 16]) -> CitizenSdkHostId128 {
    CitizenSdkHostId128 { bytes }
}

fn host_secret_ref(secret_ref: SecretRef) -> CitizenSdkHostSecretRefV1 {
    CitizenSdkHostSecretRefV1 {
        wallet_index: secret_ref.wallet_index(),
        generation: host_id(*secret_ref.generation().as_bytes()),
        owner: host_id(*secret_ref.owner().as_bytes()),
        account_id: CitizenSdkHostHash32 {
            bytes: secret_ref.account_id().into_bytes(),
        },
        kind: CitizenSdkHostSecretKind::AccountMiniSecret as u32,
        ..CitizenSdkHostSecretRefV1::default()
    }
}

fn host_wallet_key(wallet_index: u32, generation: VaultGeneration) -> CitizenSdkHostWalletKeyRefV1 {
    CitizenSdkHostWalletKeyRefV1 {
        wallet_index,
        generation: host_id(*generation.as_bytes()),
        ..CitizenSdkHostWalletKeyRefV1::default()
    }
}

fn require_host_ok(code: CitizenSdkErrorCode, message: &'static str) -> Result<(), ContractError> {
    if code == CitizenSdkErrorCode::Ok {
        Ok(())
    } else {
        Err(host_error(code, message))
    }
}

async fn load_chain_database(
    bridge: &Arc<HostBridge>,
) -> Result<ChainDatabaseSnapshot, ContractError> {
    let callback = bridge
        .public()?
        .0
        .chain_database_load
        .ok_or_else(|| ContractError::new(ContractErrorCode::Internal, "chain load missing"))?;
    // Raw host contexts are never dereferenced by Rust.  Capture their numeric
    // value so the `Send` store future never carries a raw pointer over await.
    let context = bridge.public()?.0.context as usize;
    let completion = bridge
        .call_record(
            CitizenSdkHostRecordDomain::ChainDatabase,
            |operation_id, sdk_context, complete| {
                // SAFETY: copied vtable/context satisfy HostServicesAdapter's
                // construction contract and inputs are borrowed for this call.
                unsafe { callback(context as *mut c_void, operation_id, sdk_context, complete) }
            },
        )
        .await?;
    require_host_ok(completion.code, "host chain database load failed")?;
    if !completion.present {
        if completion.revision != 0 {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "absent chain database record has a nonzero revision",
            ));
        }
        return Ok(ChainDatabaseSnapshot::new(0, None));
    }
    let encoded = completion.record.ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "present chain database record has no bytes",
        )
    })?;
    let snapshot = decode_chain_database_snapshot(&encoded).map_err(codec_contract_error)?;
    if snapshot.revision() != completion.revision {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "chain database revision disagrees with its typed payload",
        ));
    }
    Ok(snapshot)
}

impl ChainDatabaseStore for HostChainDatabaseStore {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move { load_chain_database(&bridge).await })
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        state: Option<citizen_sdk_contracts::ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let revision = expected_revision.checked_add(1).ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::InvalidState,
                    "chain database revision is exhausted",
                )
            })?;
            let candidate = ChainDatabaseSnapshot::new(revision, state);
            let encoded =
                encode_chain_database_snapshot(&candidate).map_err(codec_contract_error)?;
            let attempt = async {
                let callback = bridge
                    .public()?
                    .0
                    .chain_database_compare_and_swap
                    .ok_or_else(|| {
                        ContractError::new(ContractErrorCode::Internal, "chain CAS missing")
                    })?;
                let context = bridge.public()?.0.context as usize;
                let completion = bridge
                    .call_record(
                        CitizenSdkHostRecordDomain::ChainDatabase,
                        |operation_id, sdk_context, complete| {
                            // SAFETY: see `load_chain_database`.
                            unsafe {
                                callback(
                                    context as *mut c_void,
                                    operation_id,
                                    expected_revision,
                                    1,
                                    input_view(&encoded),
                                    sdk_context,
                                    complete,
                                )
                            }
                        },
                    )
                    .await?;
                require_host_ok(completion.code, "host chain database CAS failed")?;
                let returned = completion.record.ok_or_else(|| {
                    ContractError::new(
                        ContractErrorCode::Integrity,
                        "successful chain CAS returned no record",
                    )
                })?;
                let actual =
                    decode_chain_database_snapshot(&returned).map_err(codec_contract_error)?;
                if !completion.present
                    || completion.revision != actual.revision()
                    || actual != candidate
                {
                    return Err(ContractError::new(
                        ContractErrorCode::Integrity,
                        "host chain CAS did not return the exact candidate",
                    ));
                }
                Ok(actual)
            }
            .await;
            match attempt {
                Ok(actual) => Ok(actual),
                Err(original) => match load_chain_database(&bridge).await {
                    Ok(actual) if actual == candidate => Ok(actual),
                    _ => Err(original),
                },
            }
        })
    }
}

async fn load_runtime_cache(
    bridge: &Arc<HostBridge>,
    block_hash: Hash32,
) -> Result<Option<RuntimeContext>, ContractError> {
    let callback = bridge.public()?.0.runtime_cache_load.ok_or_else(|| {
        ContractError::new(ContractErrorCode::Internal, "runtime cache load missing")
    })?;
    let context = bridge.public()?.0.context as usize;
    let completion = bridge
        .call_record(
            CitizenSdkHostRecordDomain::RuntimeCache,
            |operation_id, sdk_context, complete| {
                // SAFETY: copied callback/context contract.
                unsafe {
                    callback(
                        context as *mut c_void,
                        operation_id,
                        host_hash(block_hash),
                        sdk_context,
                        complete,
                    )
                }
            },
        )
        .await?;
    require_host_ok(completion.code, "host runtime cache load failed")?;
    if completion.revision != 0 {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "runtime cache completion must use revision zero",
        ));
    }
    if !completion.present {
        return Ok(None);
    }
    let encoded = completion.record.ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "present runtime cache record has no bytes",
        )
    })?;
    let value = decode_runtime_context(&encoded).map_err(codec_contract_error)?;
    if value.block().hash() != block_hash {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "runtime cache record is bound to another block hash",
        ));
    }
    Ok(Some(value))
}

impl RuntimeCacheStore for HostRuntimeCacheStore {
    fn load(&self, block_hash: Hash32) -> ContractFuture<'_, Option<RuntimeContext>> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move { load_runtime_cache(&bridge, block_hash).await })
    }

    fn store(&self, context: RuntimeContext) -> ContractFuture<'_, ()> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let block_hash = context.block().hash();
            let encoded = encode_runtime_context(&context).map_err(codec_contract_error)?;
            let attempt = async {
                let callback = bridge.public()?.0.runtime_cache_store.ok_or_else(|| {
                    ContractError::new(ContractErrorCode::Internal, "runtime cache store missing")
                })?;
                let host_context = bridge.public()?.0.context as usize;
                let code = bridge
                    .call_status(|operation_id, sdk_context, complete| {
                        // SAFETY: copied callback/context contract.
                        unsafe {
                            callback(
                                host_context as *mut c_void,
                                operation_id,
                                host_hash(block_hash),
                                input_view(&encoded),
                                sdk_context,
                                complete,
                            )
                        }
                    })
                    .await?;
                require_host_ok(code, "host runtime cache store failed")
            }
            .await;
            match attempt {
                Ok(()) => Ok(()),
                Err(original) => match load_runtime_cache(&bridge, block_hash).await {
                    Ok(Some(actual)) if actual == context => Ok(()),
                    _ => Err(original),
                },
            }
        })
    }

    fn delete(&self, block_hash: Hash32) -> ContractFuture<'_, ()> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let attempt = async {
                let callback = bridge.public()?.0.runtime_cache_delete.ok_or_else(|| {
                    ContractError::new(ContractErrorCode::Internal, "runtime cache delete missing")
                })?;
                let host_context = bridge.public()?.0.context as usize;
                let code = bridge
                    .call_status(|operation_id, sdk_context, complete| {
                        // SAFETY: copied callback/context contract.
                        unsafe {
                            callback(
                                host_context as *mut c_void,
                                operation_id,
                                host_hash(block_hash),
                                sdk_context,
                                complete,
                            )
                        }
                    })
                    .await?;
                require_host_ok(code, "host runtime cache delete failed")
            }
            .await;
            match attempt {
                Ok(()) => Ok(()),
                Err(original) => match load_runtime_cache(&bridge, block_hash).await {
                    Ok(None) => Ok(()),
                    _ => Err(original),
                },
            }
        })
    }
}

async fn load_wallet_state(bridge: &Arc<HostBridge>) -> Result<WalletState, ContractError> {
    let secure = bridge.secure.ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Unsupported,
            "wallet store is unavailable",
        )
    })?;
    let callback = secure.0.wallet_profile_load.ok_or_else(|| {
        ContractError::new(ContractErrorCode::Internal, "wallet profile load missing")
    })?;
    let host_context = secure.0.context as usize;
    let completion = bridge
        .call_record(
            CitizenSdkHostRecordDomain::WalletProfile,
            |operation_id, sdk_context, complete| {
                // SAFETY: copied callback/context contract.
                unsafe {
                    callback(
                        host_context as *mut c_void,
                        operation_id,
                        sdk_context,
                        complete,
                    )
                }
            },
        )
        .await?;
    require_host_ok(completion.code, "host wallet profile load failed")?;
    if !completion.present {
        if completion.revision != 0 {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "absent wallet profile record has a nonzero revision",
            ));
        }
        return Ok(WalletState::empty());
    }
    let state = decode_wallet_state(&completion.record.ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "present wallet profile record has no bytes",
        )
    })?)
    .map_err(codec_contract_error)?;
    if state.revision() != completion.revision {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "wallet profile revision disagrees with its typed payload",
        ));
    }
    Ok(state)
}

impl WalletProfileStore for HostWalletProfileStore {
    fn load(&self) -> ContractFuture<'_, WalletState> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move { load_wallet_state(&bridge).await })
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            if next.revision()
                != expected_revision.checked_add(1).ok_or_else(|| {
                    ContractError::new(
                        ContractErrorCode::InvalidState,
                        "wallet profile revision is exhausted",
                    )
                })?
            {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "wallet profile candidate revision is not expected + 1",
                ));
            }
            let encoded = encode_wallet_state(&next).map_err(codec_contract_error)?;
            let attempt = async {
                let secure = bridge.secure.ok_or_else(|| {
                    ContractError::new(ContractErrorCode::Unsupported, "wallet store unavailable")
                })?;
                let callback = secure.0.wallet_profile_compare_and_swap.ok_or_else(|| {
                    ContractError::new(ContractErrorCode::Internal, "wallet profile CAS missing")
                })?;
                let host_context = secure.0.context as usize;
                let completion = bridge
                    .call_record(
                        CitizenSdkHostRecordDomain::WalletProfile,
                        |operation_id, sdk_context, complete| {
                            // SAFETY: copied callback/context contract.
                            unsafe {
                                callback(
                                    host_context as *mut c_void,
                                    operation_id,
                                    expected_revision,
                                    input_view(&encoded),
                                    sdk_context,
                                    complete,
                                )
                            }
                        },
                    )
                    .await?;
                require_host_ok(completion.code, "host wallet profile CAS failed")?;
                let actual = decode_wallet_state(&completion.record.ok_or_else(|| {
                    ContractError::new(
                        ContractErrorCode::Integrity,
                        "successful wallet profile CAS returned no record",
                    )
                })?)
                .map_err(codec_contract_error)?;
                if !completion.present || completion.revision != actual.revision() || actual != next
                {
                    return Err(ContractError::new(
                        ContractErrorCode::Integrity,
                        "host wallet profile CAS did not return the exact candidate",
                    ));
                }
                Ok(actual)
            }
            .await;
            match attempt {
                Ok(actual) => Ok(actual),
                Err(original) => match load_wallet_state(&bridge).await {
                    Ok(actual) if actual == next => Ok(actual),
                    _ => Err(original),
                },
            }
        })
    }
}

async fn query_history(
    bridge: &Arc<HostBridge>,
    query: Vec<u8>,
) -> Result<TransactionHistoryHostBatch, ContractError> {
    let callback = bridge
        .public()?
        .0
        .transaction_history_query
        .ok_or_else(|| ContractError::new(ContractErrorCode::Internal, "history query missing"))?;
    let host_context = bridge.public()?.0.context as usize;
    let completion = bridge
        .call_record(
            CitizenSdkHostRecordDomain::TransactionHistory,
            |operation_id, sdk_context, complete| {
                // SAFETY: copied callback/context contract.
                unsafe {
                    callback(
                        host_context as *mut c_void,
                        operation_id,
                        input_view(&query),
                        sdk_context,
                        complete,
                    )
                }
            },
        )
        .await?;
    require_host_ok(completion.code, "host history query failed")?;
    if !completion.present {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "successful history query returned no payload",
        ));
    }
    let batch = decode_transaction_history_host_batch(&completion.record.ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "successful history query returned no bytes",
        )
    })?)
    .map_err(codec_contract_error)?;
    if batch.index().revision() != completion.revision {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "history query revision disagrees with its payload",
        ));
    }
    Ok(batch)
}

impl TransactionHistoryStore for HostTransactionHistoryStore {
    fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let batch = query_history(&bridge, encode_transaction_history_index_query()).await?;
            if !batch.records().is_empty() || batch.has_more() {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "history index query returned records",
                ));
            }
            Ok(batch.index())
        })
    }

    fn load_record(
        &self,
        expected_revision: u64,
        execution_id: TransactionExecutionId,
    ) -> ContractFuture<'_, TransactionHistoryRecordSnapshot> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let batch = query_history(
                &bridge,
                encode_transaction_history_record_query(expected_revision, execution_id),
            )
            .await?;
            if batch.index().revision() != expected_revision
                || batch.records().len() > 1
                || batch.has_more()
                || batch
                    .records()
                    .first()
                    .is_some_and(|record| record.execution_id() != execution_id)
            {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "history record query returned an invalid result",
                ));
            }
            Ok(TransactionHistoryRecordSnapshot::new(
                batch.index(),
                batch.records().first().cloned(),
            ))
        })
    }

    fn load_page(
        &self,
        expected_revision: u64,
        kind: TransactionHistoryQueryKind,
        before: Option<TransactionHistoryCursor>,
        limit: usize,
    ) -> ContractFuture<'_, TransactionHistoryRecordBatch> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let query =
                encode_transaction_history_page_query(expected_revision, kind, before, limit)
                    .map_err(codec_contract_error)?;
            let batch = query_history(&bridge, query).await?;
            if batch.index().revision() != expected_revision || batch.records().len() > limit {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "history page query returned an invalid revision or count",
                ));
            }
            TransactionHistoryRecordBatch::try_new(
                batch.index(),
                batch.records().to_vec(),
                batch.has_more(),
            )
        })
    }

    fn compare_and_swap(
        &self,
        mutation: TransactionHistoryMutation,
    ) -> ContractFuture<'_, TransactionHistoryIndex> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let encoded =
                encode_transaction_history_mutation(&mutation).map_err(codec_contract_error)?;
            let callback = bridge
                .public()?
                .0
                .transaction_history_mutate
                .ok_or_else(|| {
                    ContractError::new(ContractErrorCode::Internal, "history mutation missing")
                })?;
            let host_context = bridge.public()?.0.context as usize;
            let completion = bridge
                .call_record(
                    CitizenSdkHostRecordDomain::TransactionHistory,
                    |operation_id, sdk_context, complete| {
                        // SAFETY: copied callback/context contract. Host borrows
                        // mutation bytes only until this invocation returns.
                        unsafe {
                            callback(
                                host_context as *mut c_void,
                                operation_id,
                                mutation.expected_revision(),
                                input_view(&encoded),
                                sdk_context,
                                complete,
                            )
                        }
                    },
                )
                .await?;
            require_host_ok(completion.code, "host history mutation failed")?;
            if !completion.present {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "successful history mutation returned no payload",
                ));
            }
            let batch =
                decode_transaction_history_host_batch(&completion.record.ok_or_else(|| {
                    ContractError::new(
                        ContractErrorCode::Integrity,
                        "successful history mutation returned no bytes",
                    )
                })?)
                .map_err(codec_contract_error)?;
            if completion.revision != batch.index().revision()
                || batch.index() != mutation.next_index()
                || !batch.records().is_empty()
                || batch.has_more()
            {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "host history mutation returned an invalid index",
                ));
            }
            Ok(batch.index())
        })
    }
}

async fn load_encrypted_blob(
    bridge: &Arc<HostBridge>,
    secret_ref: SecretRef,
) -> Result<EncryptedSecretBlobSnapshot, ContractError> {
    let secure = bridge.secure.ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Unsupported,
            "encrypted secret store is unavailable",
        )
    })?;
    let callback = secure.0.encrypted_secret_blob_load.ok_or_else(|| {
        ContractError::new(ContractErrorCode::Internal, "encrypted blob load missing")
    })?;
    let host_context = secure.0.context as usize;
    let completion = bridge
        .call_record(
            CitizenSdkHostRecordDomain::EncryptedSecretBlob,
            |operation_id, sdk_context, complete| {
                // SAFETY: copied callback/context contract.
                unsafe {
                    callback(
                        host_context as *mut c_void,
                        operation_id,
                        host_secret_ref(secret_ref),
                        sdk_context,
                        complete,
                    )
                }
            },
        )
        .await?;
    require_host_ok(completion.code, "host encrypted blob load failed")?;
    if !completion.present {
        if completion.revision != 0 {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "absent encrypted blob has a nonzero revision",
            ));
        }
        return Ok(EncryptedSecretBlobSnapshot::empty());
    }
    let snapshot = decode_encrypted_secret_blob_snapshot(
        secret_ref,
        &completion.record.ok_or_else(|| {
            ContractError::new(
                ContractErrorCode::Integrity,
                "present encrypted blob has no bytes",
            )
        })?,
    )
    .map_err(codec_contract_error)?;
    if snapshot.revision() != completion.revision {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "encrypted blob revision disagrees with its typed payload",
        ));
    }
    Ok(snapshot)
}

impl EncryptedSecretBlobStore for HostEncryptedSecretBlobStore {
    fn has_account_secret(&self, account_id: AccountId32) -> ContractFuture<'_, bool> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let provider = bridge.secret_presence()?;
            let callback = provider.0.has_account_secret.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "账户秘密存在性回调缺失")
            })?;
            let context = provider.0.context as usize;
            let (code, value) = bridge
                .call_bool(|operation, token, complete| {
                    // SAFETY: 提供者在登记时承诺生命周期；公开账户按值传递，不能遗留借用指针。
                    unsafe {
                        callback(
                            context as *mut c_void,
                            operation,
                            CitizenSdkAccountId {
                                bytes: *account_id.as_bytes(),
                            },
                            token,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "账户秘密存在性查询失败")?;
            Ok(value)
        })
    }

    fn load(&self, secret_ref: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move { load_encrypted_blob(&bridge, secret_ref).await })
    }

    fn compare_and_swap(
        &self,
        secret_ref: SecretRef,
        expected_revision: u64,
        next: EncryptedSecretBlobState,
    ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let current = load_encrypted_blob(&bridge, secret_ref).await?;
            if current.revision() != expected_revision {
                return Err(ContractError::new(
                    ContractErrorCode::Conflict,
                    "encrypted blob revision changed before CAS",
                ));
            }
            let candidate = current.try_advance(next)?;
            let encoded = encode_encrypted_secret_blob_snapshot(secret_ref, &candidate)
                .map_err(codec_contract_error)?;
            let attempt = async {
                let secure = bridge.secure.ok_or_else(|| {
                    ContractError::new(
                        ContractErrorCode::Unsupported,
                        "encrypted secret store unavailable",
                    )
                })?;
                let callback =
                    secure
                        .0
                        .encrypted_secret_blob_compare_and_swap
                        .ok_or_else(|| {
                            ContractError::new(
                                ContractErrorCode::Internal,
                                "encrypted blob CAS missing",
                            )
                        })?;
                let host_context = secure.0.context as usize;
                let completion = bridge
                    .call_record(
                        CitizenSdkHostRecordDomain::EncryptedSecretBlob,
                        |operation_id, sdk_context, complete| {
                            // SAFETY: copied callback/context contract.
                            unsafe {
                                callback(
                                    host_context as *mut c_void,
                                    operation_id,
                                    host_secret_ref(secret_ref),
                                    expected_revision,
                                    input_view(&encoded),
                                    sdk_context,
                                    complete,
                                )
                            }
                        },
                    )
                    .await?;
                require_host_ok(completion.code, "host encrypted blob CAS failed")?;
                let actual = decode_encrypted_secret_blob_snapshot(
                    secret_ref,
                    &completion.record.ok_or_else(|| {
                        ContractError::new(
                            ContractErrorCode::Integrity,
                            "successful encrypted blob CAS returned no record",
                        )
                    })?,
                )
                .map_err(codec_contract_error)?;
                if !completion.present
                    || completion.revision != actual.revision()
                    || actual != candidate
                {
                    return Err(ContractError::new(
                        ContractErrorCode::Integrity,
                        "host encrypted blob CAS did not return the exact candidate",
                    ));
                }
                Ok(actual)
            }
            .await;
            match attempt {
                Ok(actual) => Ok(actual),
                Err(original) => match load_encrypted_blob(&bridge, secret_ref).await {
                    Ok(actual) if actual == candidate => Ok(actual),
                    _ => Err(original),
                },
            }
        })
    }
}

const VAULT_ENVELOPE_FORMAT_VERSION: u32 = 1;
const VAULT_INNER_MAGIC: [u8; 4] = *b"CSVE";
const VAULT_INNER_VERSION: u16 = 1;
const VAULT_NONCE_BYTES: usize = 12;
const MAX_WRAPPED_DEK_BYTES: usize = 16 * 1024;
const MAX_VAULT_CIPHERTEXT_BYTES: usize = 64 * 1024;
const SECRET_AAD_PREFIX: &[u8] = b"citizensdk\0account-secret\0v1\0";

impl SecretVault for HostSecretVault {
    fn authorize_add_accounts(
        &self,
        operation: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let callback = vault.0.authorize_add_accounts.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "追加认证回调缺失")
            })?;
            let context = vault.0.context as usize;
            let code = bridge
                .call_status(|id, token, complete| {
                    // SAFETY: 完整表验证及pending注册表保持context至真实回调终态。
                    unsafe {
                        callback(
                            context as *mut c_void,
                            id,
                            host_wallet_key(wallet_index, generation),
                            host_id(operation),
                            token,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "账户追加认证失败")
        })
    }

    fn has_any_wallet_key(&self, wallet_index: u32) -> ContractFuture<'_, bool> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let provider = bridge.secret_presence()?;
            let callback = provider.0.has_any_wallet_key.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "钱包密钥存在性回调缺失")
            })?;
            let context = provider.0.context as usize;
            let (code, value) = bridge
                .call_bool(|operation, token, complete| {
                    // SAFETY: 同一Host操作跟踪器验证真实操作ID及完整BoolResult，不重造完成路由。
                    unsafe {
                        callback(
                            context as *mut c_void,
                            operation,
                            wallet_index,
                            token,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "钱包密钥存在性查询失败")?;
            Ok(value)
        })
    }

    fn availability(&self) -> ContractFuture<'_, VaultAvailability> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let callback = vault.0.availability.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "vault availability missing")
            })?;
            let host_context = vault.0.context as usize;
            let (code, availability) = bridge
                .call_availability(|operation_id, sdk_context, complete| {
                    // SAFETY: copied callback/context contract.
                    unsafe {
                        callback(
                            host_context as *mut c_void,
                            operation_id,
                            sdk_context,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "host vault availability failed")?;
            match availability.ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::Integrity,
                    "successful vault availability returned no value",
                )
            })? {
                CitizenSdkHostVaultAvailability::Available => Ok(VaultAvailability::Available),
                CitizenSdkHostVaultAvailability::NoStrongUserAuthentication => {
                    Ok(VaultAvailability::NoStrongUserAuthentication)
                }
                CitizenSdkHostVaultAvailability::Unsupported => Ok(VaultAvailability::Unsupported),
                CitizenSdkHostVaultAvailability::Unavailable => Ok(VaultAvailability::Unavailable),
            }
        })
    }

    // 密钥初始化只供新钱包调用；封装复用既有钥，不能把追加操作误认成创建所有者。
    fn ensure_wallet_key(
        &self,
        provisioning_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let ensure = vault.0.ensure_wallet_kek.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "vault KEK ensure missing")
            })?;
            let host_context = vault.0.context as usize;
            let code = bridge
                .call_status(|operation_id, sdk_context, complete| {
                    // SAFETY: copied callback/context contract.
                    unsafe {
                        ensure(
                            host_context as *mut c_void,
                            operation_id,
                            host_wallet_key(wallet_index, generation),
                            host_id(provisioning_operation_id),
                            sdk_context,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "host vault failed to ensure wallet KEK")
        })
    }

    fn seal(
        &self,
        provisioning_operation_id: [u8; 16],
        secret_ref: SecretRef,
        secret: SecretBuffer,
    ) -> ContractFuture<'_, EncryptedSecretEnvelope> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let aad = secret_aad(secret_ref);
            let aad_digest: [u8; 32] = Sha256::digest(&aad).into();
            let mut dek = Zeroizing::new(vec![0_u8; CITIZENSDK_HOST_DEK_BYTES as usize]);
            getrandom::fill(dek.as_mut_slice()).map_err(|_| {
                ContractError::new(
                    ContractErrorCode::Unavailable,
                    "operating system randomness is unavailable for vault DEK",
                )
            })?;
            let mut nonce = [0_u8; VAULT_NONCE_BYTES];
            getrandom::fill(&mut nonce).map_err(|_| {
                ContractError::new(
                    ContractErrorCode::Unavailable,
                    "operating system randomness is unavailable for vault nonce",
                )
            })?;
            let cipher = Aes256Gcm::new_from_slice(dek.as_ref()).map_err(|_| {
                ContractError::new(ContractErrorCode::Internal, "AES-256 key width is invalid")
            })?;
            let ciphertext = secret.with_secret(|bytes| {
                if bytes.len() != 32 {
                    return Err(ContractError::new(
                        ContractErrorCode::InvalidArgument,
                        "account child mini-secret must be exactly 32 bytes",
                    ));
                }
                cipher
                    .encrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: bytes,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| {
                        ContractError::new(
                            ContractErrorCode::Internal,
                            "AES-GCM secret encryption failed",
                        )
                    })
            })?;

            // 封装前用本次既有DEK校验完整AES-GCM结果；不调用硬件解封、不缓存授权。
            let verified = Zeroizing::new(
                cipher
                    .decrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: &ciphertext,
                            aad: &aad,
                        },
                    )
                    .map_err(|_| {
                        ContractError::new(ContractErrorCode::Integrity, "账户加密结果校验失败")
                    })?,
            );
            if !secret.with_secret(|bytes| bytes == verified.as_slice()) {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "账户加密回读不一致",
                ));
            }
            drop(verified);
            let wrap = vault.0.wrap_dek.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "vault DEK wrap missing")
            })?;
            let host_context = vault.0.context as usize;
            let (code, wrapped_dek) = bridge
                .call_wrap_dek(dek, |operation_id, plaintext_dek, sdk_context, complete| {
                    // SAFETY: copied callback/context contract. The DEK view
                    // is backed by the pending registry through completion.
                    unsafe {
                        wrap(
                            host_context as *mut c_void,
                            operation_id,
                            host_wallet_key(secret_ref.wallet_index(), secret_ref.generation()),
                            host_id(provisioning_operation_id),
                            plaintext_dek,
                            sdk_context,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "host vault failed to wrap DEK")?;
            let wrapped_dek = wrapped_dek.ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::Integrity,
                    "successful vault wrap returned no wrapped DEK",
                )
            })?;
            let inner = encode_vault_inner(&nonce, &wrapped_dek, &ciphertext)?;
            EncryptedSecretEnvelope::try_new(
                VAULT_ENVELOPE_FORMAT_VERSION,
                Hash32Bytes::from_bytes(aad_digest),
                inner,
            )
        })
    }

    fn open(
        &self,
        secret_ref: SecretRef,
        envelope: EncryptedSecretEnvelope,
    ) -> ContractFuture<'_, SecretBuffer> {
        let bridge = Arc::clone(&self.bridge);
        let authorizing = self.authorizing.clone();
        Box::pin(async move {
            if envelope.format_version() != VAULT_ENVELOPE_FORMAT_VERSION {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "secret envelope format version is unsupported",
                ));
            }
            let aad = secret_aad(secret_ref);
            let aad_digest: [u8; 32] = Sha256::digest(&aad).into();
            if envelope.associated_data_digest().as_bytes() != &aad_digest {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "secret envelope AAD identity does not match SecretRef",
                ));
            }
            let DecodedVaultInner {
                nonce,
                wrapped_dek,
                ciphertext,
            } = decode_vault_inner(envelope.ciphertext())?;
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let unwrap = vault.0.unwrap_dek.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "vault DEK unwrap missing")
            })?;
            let host_context = vault.0.context as usize;
            let (code, dek) = bridge
                .call_unwrap_dek(|operation_id, output, sdk_context, complete| {
                    // 操作号已保留但尚未派发；拒绝会走原 settle_production_dispatch 回收 pending/DEK。
                    if let Some(authorizing) = authorizing.as_ref() {
                        let status = authorizing(operation_id);
                        if status != CitizenSdkErrorCode::Ok as i32 {
                            return status;
                        }
                    }
                    // SAFETY: copied callback/context contract. `output` is
                    // owned by the pending registry until completion.
                    unsafe {
                        unwrap(
                            host_context as *mut c_void,
                            operation_id,
                            host_wallet_key(secret_ref.wallet_index(), secret_ref.generation()),
                            input_view(&wrapped_dek),
                            output,
                            sdk_context,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "host vault failed to unwrap DEK")?;
            if dek.len() != CITIZENSDK_HOST_DEK_BYTES as usize {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "host vault returned a non-32-byte DEK",
                ));
            }
            let cipher = Aes256Gcm::new_from_slice(dek.as_ref()).map_err(|_| {
                ContractError::new(
                    ContractErrorCode::Integrity,
                    "unwrapped DEK width is invalid",
                )
            })?;
            let mut plaintext = cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| {
                    ContractError::new(
                        ContractErrorCode::Integrity,
                        "secret envelope AES-GCM authentication failed",
                    )
                })?;
            if plaintext.len() != 32 {
                plaintext.zeroize();
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "decrypted child mini-secret has the wrong length",
                ));
            }
            SecretBuffer::try_new(plaintext)
        })
    }

    fn has_wallet_key(
        &self,
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, bool> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let callback = vault.0.has_wallet_kek.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "vault KEK query missing")
            })?;
            let host_context = vault.0.context as usize;
            let (code, value) = bridge
                .call_bool(|operation_id, sdk_context, complete| {
                    // SAFETY: copied callback/context contract.
                    unsafe {
                        callback(
                            host_context as *mut c_void,
                            operation_id,
                            host_wallet_key(wallet_index, generation),
                            sdk_context,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "host vault KEK query failed")?;
            Ok(value)
        })
    }

    fn delete_wallet_key(
        &self,
        cleanup_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Unsupported, "host vault is unavailable")
            })?;
            let callback = vault.0.retire_wallet_kek.ok_or_else(|| {
                ContractError::new(ContractErrorCode::Internal, "vault KEK retire missing")
            })?;
            let host_context = vault.0.context as usize;
            let code = bridge
                .call_status(|operation_id, sdk_context, complete| {
                    // SAFETY: copied callback/context contract. Host success
                    // means generation retirement is already durable.
                    unsafe {
                        callback(
                            host_context as *mut c_void,
                            operation_id,
                            host_wallet_key(wallet_index, generation),
                            host_id(cleanup_operation_id),
                            sdk_context,
                            complete,
                        )
                    }
                })
                .await?;
            require_host_ok(code, "host vault KEK retirement failed")
        })
    }
}

fn secret_aad(secret_ref: SecretRef) -> Vec<u8> {
    let mut aad = Vec::with_capacity(SECRET_AAD_PREFIX.len() + 4 + 16 + 16 + 32 + 1);
    aad.extend_from_slice(SECRET_AAD_PREFIX);
    aad.extend_from_slice(&secret_ref.wallet_index().to_le_bytes());
    aad.extend_from_slice(secret_ref.generation().as_bytes());
    aad.extend_from_slice(secret_ref.owner().as_bytes());
    aad.extend_from_slice(secret_ref.account_id().as_bytes());
    aad.push(match secret_ref.kind() {
        SecretKind::AccountMiniSecret => 1,
    });
    aad
}

fn encode_vault_inner(
    nonce: &[u8; VAULT_NONCE_BYTES],
    wrapped_dek: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, ContractError> {
    if wrapped_dek.is_empty()
        || wrapped_dek.len() > MAX_WRAPPED_DEK_BYTES
        || ciphertext.is_empty()
        || ciphertext.len() > MAX_VAULT_CIPHERTEXT_BYTES
    {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "vault envelope component length is invalid",
        ));
    }
    let wrapped_len = u32::try_from(wrapped_dek.len()).map_err(|_| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "wrapped DEK length cannot be represented",
        )
    })?;
    let ciphertext_len = u32::try_from(ciphertext.len()).map_err(|_| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "vault ciphertext length cannot be represented",
        )
    })?;
    let mut encoded =
        Vec::with_capacity(4 + 2 + 2 + 12 + 4 + 4 + wrapped_dek.len() + ciphertext.len());
    encoded.extend_from_slice(&VAULT_INNER_MAGIC);
    encoded.extend_from_slice(&VAULT_INNER_VERSION.to_le_bytes());
    encoded.extend_from_slice(&0_u16.to_le_bytes());
    encoded.extend_from_slice(nonce);
    encoded.extend_from_slice(&wrapped_len.to_le_bytes());
    encoded.extend_from_slice(&ciphertext_len.to_le_bytes());
    encoded.extend_from_slice(wrapped_dek);
    encoded.extend_from_slice(ciphertext);
    Ok(encoded)
}

struct DecodedVaultInner {
    nonce: [u8; 12],
    wrapped_dek: Vec<u8>,
    ciphertext: Vec<u8>,
}

fn decode_vault_inner(encoded: &[u8]) -> Result<DecodedVaultInner, ContractError> {
    const HEADER: usize = 28;
    if encoded.len() < HEADER || encoded[..4] != VAULT_INNER_MAGIC {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "vault envelope header is malformed",
        ));
    }
    if u16::from_le_bytes([encoded[4], encoded[5]]) != VAULT_INNER_VERSION
        || u16::from_le_bytes([encoded[6], encoded[7]]) != 0
    {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "vault envelope version or reserved field is invalid",
        ));
    }
    let nonce: [u8; 12] = encoded[8..20].try_into().map_err(|_| {
        ContractError::new(ContractErrorCode::Integrity, "vault nonce is truncated")
    })?;
    let wrapped_len = u32::from_le_bytes(encoded[20..24].try_into().map_err(|_| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "wrapped DEK length is truncated",
        )
    })?) as usize;
    let ciphertext_len = u32::from_le_bytes(encoded[24..28].try_into().map_err(|_| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "ciphertext length is truncated",
        )
    })?) as usize;
    if wrapped_len == 0
        || wrapped_len > MAX_WRAPPED_DEK_BYTES
        || ciphertext_len == 0
        || ciphertext_len > MAX_VAULT_CIPHERTEXT_BYTES
    {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "vault envelope component length exceeds its limit",
        ));
    }
    let wrapped_end = HEADER.checked_add(wrapped_len).ok_or_else(|| {
        ContractError::new(
            ContractErrorCode::Integrity,
            "wrapped DEK offset overflowed",
        )
    })?;
    let ciphertext_end = wrapped_end.checked_add(ciphertext_len).ok_or_else(|| {
        ContractError::new(ContractErrorCode::Integrity, "ciphertext offset overflowed")
    })?;
    if ciphertext_end != encoded.len() {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "vault envelope is truncated or has trailing bytes",
        ));
    }
    Ok(DecodedVaultInner {
        nonce,
        wrapped_dek: encoded[HEADER..wrapped_end].to_vec(),
        ciphertext: encoded[wrapped_end..ciphertext_end].to_vec(),
    })
}

/// 登记只读存在性回调，不新增窗口、Keychain项目或存储副本。
/// # Safety
/// provider可读，回调/context在SDK成功销毁前始终有效；只允许首次Host操作前调用一次。
#[no_mangle]
pub unsafe extern "C" fn citizensdk_set_secret_presence_provider(
    handle: crate::abi::CitizenSdkHandle,
    provider: *const CitizenSdkHostSecretPresenceV1,
) -> i32 {
    crate::ffi_status(|| {
        // SAFETY: 上述C调用合同，read_versioned先检查前缀再复制完整结构。
        let provider = unsafe { crate::read_versioned(provider, "secret presence provider")? };
        unsafe { crate::handles::get(handle)?.set_secret_presence_provider(provider) }
    })
}

/// 单条已加密记录的存在性投影，使用唯一Core信封/身份/状态解码。
/// # Safety
/// 输入视图可读，out_present可写；失败保持输出原值，不返回任何记录或秘密字节。
#[no_mangle]
pub unsafe extern "C" fn citizensdk_encrypted_secret_record_has_secret(
    account_id: *const CitizenSdkAccountId,
    expected_revision: u64,
    record: CitizenSdkBytesView,
    out_present: *mut u8,
) -> i32 {
    crate::ffi_status(|| {
        unsafe {
            crate::require_output(out_present, "out_present")?;
        }
        if account_id.is_null() {
            return Err(crate::error::FfiError::invalid("account_id is null"));
        }
        let account = AccountId32::from_bytes(unsafe { (*account_id).bytes });
        let bytes = unsafe { crate::copy_view(record, "encrypted record", 65536)? };
        let present = citizen_sdk_store::codec::encrypted_secret_record_has_secret(
            account,
            expected_revision,
            &bytes,
        )
        .map_err(codec_contract_error)
        .map_err(crate::error::FfiError::from)?;
        unsafe {
            *out_present = u8::from(present);
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "../tests/host.rs"]
mod production_tests;

#[cfg(test)]
#[path = "../tests/presence.rs"]
mod presence;
