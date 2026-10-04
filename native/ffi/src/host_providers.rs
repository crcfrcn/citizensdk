//! Versioned host-provider C contracts.
//!
//! The public and secure stores expose one callback per typed Rust contract.
//! There is deliberately no generic `put(key, bytes)` escape hatch.  Stored
//! values are opaque [`crate::host_codec`] records and the Rust adapter checks
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
    AccountId32, ChainDatabaseSnapshot, ChainDatabaseStore, ContractError, ContractErrorCode, ContractFuture,
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretBlobStore,
    EncryptedSecretEnvelope, Hash32, Hash32Bytes, RuntimeCacheStore, RuntimeContext, SecretBuffer,
    SecretKind, SecretRef, SecretVault, TransactionExecutionId, TransactionHistoryCursor,
    TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryQueryKind,
    TransactionHistoryRecordBatch, TransactionHistoryRecordSnapshot, TransactionHistoryStore,
    VaultAvailability, VaultGeneration, WalletProfileStore, WalletState,
};
use futures_channel::oneshot;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::abi::{CitizenSdkAccountId, CitizenSdkBytesView, CitizenSdkErrorCode, CITIZENSDK_ABI_VERSION};
use crate::host_codec::{
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
        host_context: *mut c_void, host_operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        provisioning_operation_id: CitizenSdkHostId128,
        sdk_context: *mut c_void, completion: CitizenSdkHostStatusCompletionV1,
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
pub type CitizenSdkHostHasAccountSecretV1 = Option<unsafe extern "C" fn(
    *mut c_void, u64, CitizenSdkAccountId, *mut c_void, CitizenSdkHostBoolCompletionV1,
) -> i32>;
pub type CitizenSdkHostHasAnyWalletKeyV1 = Option<unsafe extern "C" fn(
    *mut c_void, u64, u32, *mut c_void, CitizenSdkHostBoolCompletionV1,
) -> i32>;
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
    let code = match error.ffi_code() {
        CitizenSdkErrorCode::Integrity => ContractErrorCode::Integrity,
        CitizenSdkErrorCode::InvalidArgument => ContractErrorCode::InvalidArgument,
        _ => ContractErrorCode::Decode,
    };
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
        let gate = self.operation_gate.lock().map_err(|_| ContractError::new(
            ContractErrorCode::Internal, "存在性查询门已损坏"))?;
        if !gate.accepting {
            return Err(ContractError::new(ContractErrorCode::InvalidState, "Host正在关闭"));
        }
        gate.presence.ok_or_else(|| ContractError::new(
            ContractErrorCode::Unsupported, "未登记完整秘密存在性查询"))
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
    pub unsafe fn set_secret_presence_provider(&self, provider: CitizenSdkHostSecretPresenceV1) -> Result<(), ContractError> {
        if provider.struct_size as usize != std::mem::size_of::<CitizenSdkHostSecretPresenceV1>() ||
            provider.abi_version != CITIZENSDK_ABI_VERSION || provider.has_account_secret.is_none() ||
            provider.has_any_wallet_key.is_none() {
            return Err(ContractError::new(ContractErrorCode::InvalidArgument, "秘密存在性回调不完整"));
        }
        if self.bridge.secure.is_none() || self.bridge.vault.is_none() {
            return Err(ContractError::new(ContractErrorCode::Unsupported, "实例没有安全仓储及金库"));
        }
        let mut gate = self.bridge.operation_gate.lock().map_err(|_| ContractError::new(
            ContractErrorCode::Internal, "存在性查询门已损坏"))?;
        if !gate.accepting || gate.started || gate.presence.is_some() {
            return Err(ContractError::new(ContractErrorCode::InvalidState, "存在性提供者已冻结"));
        }
        gate.presence = Some(SendSecretPresence(provider));
        Ok(())
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
                owner_id: next_global_id(
                    &NEXT_HOST_OWNER_ID,
                    "host provider owner id space is exhausted",
                )?,
                operation_gate: Mutex::new(HostOperationGate { accepting: true, started: false, presence: None }),
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
            let callback = provider.0.has_account_secret.ok_or_else(|| ContractError::new(
                ContractErrorCode::Internal, "账户秘密存在性回调缺失"))?;
            let context = provider.0.context as usize;
            let (code, value) = bridge.call_bool(|operation, token, complete| {
                // SAFETY: 提供者在登记时承诺生命周期；公开账户按值传递，不能遗留借用指针。
                unsafe { callback(context as *mut c_void, operation,
                    CitizenSdkAccountId { bytes: *account_id.as_bytes() }, token, complete) }
            }).await?;
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
    fn authorize_add_accounts(&self, operation: [u8; 16], wallet_index: u32,
        generation: VaultGeneration) -> ContractFuture<'_, ()> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let vault = bridge.vault.ok_or_else(|| ContractError::new(
                ContractErrorCode::Unsupported, "host vault is unavailable"))?;
            let callback = vault.0.authorize_add_accounts.ok_or_else(|| ContractError::new(
                ContractErrorCode::Internal, "追加认证回调缺失"))?;
            let context = vault.0.context as usize;
            let code = bridge.call_status(|id, token, complete| {
                // SAFETY: 完整表验证及pending注册表保持context至真实回调终态。
                unsafe { callback(context as *mut c_void, id,
                    host_wallet_key(wallet_index, generation), host_id(operation), token, complete) }
            }).await?;
            require_host_ok(code, "账户追加认证失败")
        })
    }

    fn has_any_wallet_key(&self, wallet_index: u32) -> ContractFuture<'_, bool> {
        let bridge = Arc::clone(&self.bridge);
        Box::pin(async move {
            let provider = bridge.secret_presence()?;
            let callback = provider.0.has_any_wallet_key.ok_or_else(|| ContractError::new(
                ContractErrorCode::Internal, "钱包密钥存在性回调缺失"))?;
            let context = provider.0.context as usize;
            let (code, value) = bridge.call_bool(|operation, token, complete| {
                // SAFETY: 同一Host操作跟踪器验证真实操作ID及完整BoolResult，不重造完成路由。
                unsafe { callback(context as *mut c_void, operation, wallet_index, token, complete) }
            }).await?;
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
            let verified = Zeroizing::new(cipher.decrypt(Nonce::from_slice(&nonce),
                Payload { msg: &ciphertext, aad: &aad }).map_err(|_| {
                    ContractError::new(ContractErrorCode::Integrity, "账户加密结果校验失败")
                })?);
            if !secret.with_secret(|bytes| bytes == verified.as_slice()) {
                return Err(ContractError::new(ContractErrorCode::Integrity, "账户加密回读不一致"));
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
    handle: crate::abi::CitizenSdkHandle, provider: *const CitizenSdkHostSecretPresenceV1,
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
    account_id: *const CitizenSdkAccountId, expected_revision: u64,
    record: CitizenSdkBytesView, out_present: *mut u8,
) -> i32 {
    crate::ffi_status(|| {
        unsafe { crate::require_output(out_present, "out_present")?; }
        if account_id.is_null() { return Err(crate::error::FfiError::invalid("account_id is null")); }
        let account = AccountId32::from_bytes(unsafe { (*account_id).bytes });
        let bytes = unsafe { crate::copy_view(record, "encrypted record", 65536)? };
        let present = crate::host_codec::encrypted_secret_record_has_secret(account, expected_revision, &bytes)
            .map_err(codec_contract_error).map_err(crate::error::FfiError::from)?;
        unsafe { *out_present = u8::from(present); }
        Ok(())
    })
}

#[cfg(test)]
mod production_tests {
    use std::{
        future::Future,
        sync::atomic::{AtomicU8, Ordering},
        task::{Context, Poll},
    };

    use citizen_sdk_contracts::{AccountId32, SecretOwner};
    use futures_executor::block_on;
    use futures_util::task::noop_waker_ref;

    use super::*;

    fn test_secret_ref(wallet: u32, generation: u8, owner: u8, account: u8) -> SecretRef {
        SecretRef::account_mini_secret(
            wallet,
            VaultGeneration::from_bytes([generation; 16]),
            SecretOwner::from_bytes([owner; 16]),
            AccountId32::from_bytes([account; 32]),
        )
    }

    fn test_bridge(
        public: CitizenSdkHostPublicStoreV1,
        secure: Option<CitizenSdkHostSecureStoreV1>,
        vault: Option<CitizenSdkHostSecretVaultV1>,
    ) -> Arc<HostBridge> {
        Arc::new(HostBridge {
            owner_id: next_global_id(&NEXT_HOST_OWNER_ID, "test host owner id space is exhausted")
                .unwrap_or_else(|error| panic!("test owner allocation failed: {error}")),
            operation_gate: Mutex::new(HostOperationGate { accepting: true, started: false, presence: None }),
            public: Some(SendPublicStore(public)),
            secure: secure.map(SendSecureStore),
            vault: vault.map(SendSecretVault),
        })
    }

    fn assert_host_operation_unclaimed(
        operation_id: u64,
        expected_kind: PendingKind,
        receiver: &mut oneshot::Receiver<Result<HostCompletion, ContractError>>,
    ) {
        let registry = host_operations()
            .lock()
            .unwrap_or_else(|_| panic!("host operation registry is poisoned"));
        assert_eq!(
            registry.pending.get(&operation_id).map(|entry| entry.kind),
            Some(expected_kind)
        );
        assert!(!registry.completing.contains_key(&operation_id));
        drop(registry);
        assert!(matches!(receiver.try_recv(), Ok(None)));
    }

    fn assert_terminal_integrity(
        receiver: oneshot::Receiver<Result<HostCompletion, ContractError>>,
    ) {
        let error = block_on(receiver)
            .unwrap_or_else(|_| panic!("host completion receiver was cancelled"))
            .err()
            .unwrap_or_else(|| panic!("null completion must terminate with an error"));
        assert_eq!(error.code(), ContractErrorCode::Integrity);
    }

    unsafe fn borrowed_bytes(view: CitizenSdkBytesView) -> Vec<u8> {
        let len = usize::try_from(view.len)
            .unwrap_or_else(|_| panic!("test host input length exceeds usize"));
        if len == 0 {
            return Vec::new();
        }
        assert!(!view.data.is_null());
        // SAFETY: every production callback contract keeps its borrowed input
        // readable until this callback returns; the fake copies immediately.
        unsafe { std::slice::from_raw_parts(view.data, len) }.to_vec()
    }

    unsafe fn complete_status_ok(
        operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) {
        let result = CitizenSdkHostStatusResultV1 {
            host_operation_id: operation_id,
            ..CitizenSdkHostStatusResultV1::default()
        };
        // SAFETY: the result remains readable for this synchronous call.
        unsafe {
            completion.unwrap_or_else(|| panic!("status completion is missing"))(
                sdk_context,
                &result,
            )
        };
    }

    unsafe fn complete_absent_record(
        operation_id: u64,
        domain: CitizenSdkHostRecordDomain,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) {
        let result = CitizenSdkHostRecordResultV1 {
            host_operation_id: operation_id,
            domain: domain as u32,
            ..CitizenSdkHostRecordResultV1::default()
        };
        // SAFETY: the result remains readable for this synchronous call.
        unsafe {
            completion.unwrap_or_else(|| panic!("record completion is missing"))(
                sdk_context,
                &result,
            )
        };
    }

    unsafe extern "C" fn absent_chain_load(
        _host_context: *mut c_void,
        operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        // SAFETY: this fake completes synchronously with canonical borrowed data.
        unsafe {
            complete_absent_record(
                operation_id,
                CitizenSdkHostRecordDomain::ChainDatabase,
                sdk_context,
                completion,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn absent_runtime_load(
        _host_context: *mut c_void,
        operation_id: u64,
        _block_hash: CitizenSdkHostHash32,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        // SAFETY: this fake completes synchronously with canonical borrowed data.
        unsafe {
            complete_absent_record(
                operation_id,
                CitizenSdkHostRecordDomain::RuntimeCache,
                sdk_context,
                completion,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn absent_wallet_load(
        _host_context: *mut c_void,
        operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        // SAFETY: this fake completes synchronously with canonical borrowed data.
        unsafe {
            complete_absent_record(
                operation_id,
                CitizenSdkHostRecordDomain::WalletProfile,
                sdk_context,
                completion,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn empty_history_query(
        _host_context: *mut c_void,
        operation_id: u64,
        query: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        let query = unsafe { borrowed_bytes(query) };
        assert_eq!(&query[..4], b"THQ1");
        let bytes = crate::host_codec::encode_transaction_history_host_batch(
            TransactionHistoryIndex::empty(),
            &[],
            false,
        )
        .expect("empty history response");
        let result = CitizenSdkHostRecordResultV1 {
            host_operation_id: operation_id,
            domain: CitizenSdkHostRecordDomain::TransactionHistory as u32,
            present: 1,
            record: input_view(&bytes),
            ..CitizenSdkHostRecordResultV1::default()
        };
        unsafe {
            completion.unwrap_or_else(|| panic!("history completion is missing"))(
                sdk_context,
                &result,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn absent_encrypted_load(
        _host_context: *mut c_void,
        operation_id: u64,
        _secret_ref: CitizenSdkHostSecretRefV1,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        // SAFETY: this fake completes synchronously with canonical borrowed data.
        unsafe {
            complete_absent_record(
                operation_id,
                CitizenSdkHostRecordDomain::EncryptedSecretBlob,
                sdk_context,
                completion,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    #[test]
    fn all_five_typed_store_adapters_have_domain_specific_empty_semantics() {
        let public = CitizenSdkHostPublicStoreV1 {
            chain_database_load: Some(absent_chain_load),
            runtime_cache_load: Some(absent_runtime_load),
            transaction_history_query: Some(empty_history_query),
            ..CitizenSdkHostPublicStoreV1::default()
        };
        let secure = CitizenSdkHostSecureStoreV1 {
            wallet_profile_load: Some(absent_wallet_load),
            encrypted_secret_blob_load: Some(absent_encrypted_load),
            ..CitizenSdkHostSecureStoreV1::default()
        };
        let bridge = test_bridge(public, Some(secure), None);
        let chain = HostChainDatabaseStore {
            bridge: Arc::clone(&bridge),
        };
        let runtime = HostRuntimeCacheStore {
            bridge: Arc::clone(&bridge),
        };
        let wallet = HostWalletProfileStore {
            bridge: Arc::clone(&bridge),
        };
        let history = HostTransactionHistoryStore {
            bridge: Arc::clone(&bridge),
        };
        let encrypted = HostEncryptedSecretBlobStore { bridge };

        block_on(async {
            assert_eq!(
                chain
                    .load()
                    .await
                    .unwrap_or_else(|error| panic!("chain load failed: {error}")),
                ChainDatabaseSnapshot::new(0, None)
            );
            assert_eq!(
                runtime
                    .load(Hash32::from_bytes([1; 32]))
                    .await
                    .unwrap_or_else(|error| panic!("runtime load failed: {error}")),
                None
            );
            assert_eq!(
                wallet
                    .load()
                    .await
                    .unwrap_or_else(|error| panic!("wallet load failed: {error}")),
                WalletState::empty()
            );
            assert_eq!(
                history
                    .load_index()
                    .await
                    .unwrap_or_else(|error| panic!("history load failed: {error}")),
                TransactionHistoryIndex::empty()
            );
            assert_eq!(
                encrypted
                    .load(test_secret_ref(2, 3, 4, 5))
                    .await
                    .unwrap_or_else(|error| panic!("encrypted load failed: {error}")),
                EncryptedSecretBlobSnapshot::empty()
            );
        });
    }

    #[derive(Default)]
    struct FakeVault {
        key_owner: Mutex<Option<(u32, [u8; 16], [u8; 16])>>,
        retired: Mutex<bool>,
        ensure_calls: Mutex<usize>,
        seen_plaintext_deks: Mutex<Vec<Vec<u8>>>,
        unwrap_mode: AtomicU8,
        unwrap_operations: Mutex<Vec<u64>>,
    }

    unsafe fn fake_vault<'a>(context: *mut c_void) -> &'a FakeVault {
        assert!(!context.is_null());
        // SAFETY: each test keeps the boxed fake alive through all completions.
        unsafe { &*(context.cast::<FakeVault>()) }
    }

    unsafe extern "C" fn fake_vault_availability(
        _host_context: *mut c_void,
        operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostVaultAvailabilityCompletionV1,
    ) -> i32 {
        let result = CitizenSdkHostVaultAvailabilityResultV1 {
            host_operation_id: operation_id,
            availability: CitizenSdkHostVaultAvailability::Available as u32,
            ..CitizenSdkHostVaultAvailabilityResultV1::default()
        };
        // SAFETY: the result remains readable for this synchronous call.
        unsafe {
            completion.unwrap_or_else(|| panic!("availability completion is missing"))(
                sdk_context,
                &result,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_vault_ensure(
        host_context: *mut c_void, operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1, provisioning: CitizenSdkHostId128,
        sdk_context: *mut c_void, completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32 {
        // SAFETY: 合成金库由测试持有，持久创建归属和退休规则与平台一致。
        let fake = unsafe { fake_vault(host_context) };
        *fake.ensure_calls.lock().unwrap() += 1;
        let identity = (wallet_key.wallet_index, wallet_key.generation.bytes, provisioning.bytes);
        let mut owner = fake.key_owner.lock().unwrap();
        if *fake.retired.lock().unwrap() || owner.as_ref().is_some_and(|old| *old != identity) {
            return CitizenSdkErrorCode::KeyInvalidated.as_i32();
        }
        *owner = Some(identity);
        drop(owner);
        // SAFETY: 同步完成后不保留任何输入借用。
        unsafe { complete_status_ok(operation_id, sdk_context, completion) };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_vault_has(
        host_context: *mut c_void,
        operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostBoolCompletionV1,
    ) -> i32 {
        // SAFETY: 测试持有合成金库，存在性必须反映创建和退休后的实际状态。
        let fake = unsafe { fake_vault(host_context) };
        let present = !*fake.retired.lock().unwrap()
            && fake.key_owner.lock().unwrap().as_ref().is_some_and(|key|
                key.0 == wallet_key.wallet_index && key.1 == wallet_key.generation.bytes);
        let result = CitizenSdkHostBoolResultV1 {
            host_operation_id: operation_id,
            value: u8::from(present),
            ..CitizenSdkHostBoolResultV1::default()
        };
        // SAFETY: the result remains readable for this synchronous call.
        unsafe {
            completion.unwrap_or_else(|| panic!("bool completion is missing"))(sdk_context, &result)
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_vault_wrap(
        host_context: *mut c_void,
        operation_id: u64,
        wallet_key: CitizenSdkHostWalletKeyRefV1,
        _provisioning_operation_id: CitizenSdkHostId128,
        plaintext_dek: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostBytesCompletionV1,
    ) -> i32 {
        // SAFETY: 合成提供者只允许使用既有活动钥，封装不会隐式创建。
        let fake = unsafe { fake_vault(host_context) };
        if *fake.retired.lock().unwrap() || !fake.key_owner.lock().unwrap().as_ref()
            .is_some_and(|key| key.0 == wallet_key.wallet_index && key.1 == wallet_key.generation.bytes) {
            return CitizenSdkErrorCode::KeyInvalidated.as_i32();
        }
        // SAFETY: the SDK lends this exact view for the callback duration.
        let dek = unsafe { borrowed_bytes(plaintext_dek) };
        assert_eq!(dek.len(), CITIZENSDK_HOST_DEK_BYTES as usize);
        unsafe { fake_vault(host_context) }
            .seen_plaintext_deks
            .lock()
            .unwrap_or_else(|_| panic!("fake vault DEK log is poisoned"))
            .push(dek.clone());
        let wrapped: Vec<u8> = dek.into_iter().map(|byte| byte ^ 0xa5).collect();
        let result = CitizenSdkHostBytesResultV1 {
            host_operation_id: operation_id,
            kind: CitizenSdkHostBytesKind::WrappedDek as u32,
            bytes: input_view(&wrapped),
            ..CitizenSdkHostBytesResultV1::default()
        };
        // SAFETY: the adapter copies the borrowed wrapped bytes synchronously.
        unsafe {
            completion.unwrap_or_else(|| panic!("wrapped DEK completion is missing"))(
                sdk_context,
                &result,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_vault_unwrap(
        host_context: *mut c_void,
        operation_id: u64,
        _wallet_key: CitizenSdkHostWalletKeyRefV1,
        wrapped_dek: CitizenSdkBytesView,
        plaintext_dek_out: CitizenSdkMutableBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32 {
        unsafe { fake_vault(host_context) }
            .unwrap_operations
            .lock()
            .unwrap_or_else(|_| panic!("测试操作记录锁损坏"))
            .push(operation_id);
        assert_eq!(plaintext_dek_out.len, CITIZENSDK_HOST_DEK_BYTES);
        assert!(!plaintext_dek_out.data.is_null());
        // SAFETY: both views are valid for this callback, and the SDK-owned
        // output remains exclusively lent until completion returns.
        let wrapped = unsafe { borrowed_bytes(wrapped_dek) };
        let mut dek: Vec<u8> = wrapped.into_iter().map(|byte| byte ^ 0xa5).collect();
        let mode = unsafe { fake_vault(host_context) }
            .unwrap_mode
            .load(Ordering::SeqCst);
        if mode == 2 {
            // Deterministically produce a different complete DEK. A constant
            // replacement has a theoretical chance of equalling the random
            // production DEK and would make this security test probabilistic.
            dek[0] ^= 0xff;
        } else if mode == 1 {
            let final_index = dek.len() - 1;
            // Poison the byte this mode intentionally omits. The SDK buffer is
            // zero-initialized, and an actual DEK may also end in zero; without
            // this sentinel a 31-byte host write could accidentally authenticate.
            // SAFETY: the callback contract provides one writable 32-byte
            // buffer, and `final_index` is the last index of the 32-byte DEK.
            unsafe {
                plaintext_dek_out
                    .data
                    .add(final_index)
                    .write(dek[final_index] ^ 0xff)
            };
        }
        let copied = if mode == 1 { dek.len() - 1 } else { dek.len() };
        // SAFETY: output is exactly 32 bytes, and wrapped DEKs produced by this
        // fake are exactly 32 bytes. Mode 1 intentionally leaves one byte
        // unequal to the expected DEK so AES-GCM must reject the incomplete
        // result.
        unsafe { std::ptr::copy_nonoverlapping(dek.as_ptr(), plaintext_dek_out.data, copied) };
        dek.zeroize();
        // SAFETY: completion terminates the mutable output borrow.
        unsafe { complete_status_ok(operation_id, sdk_context, completion) };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_vault_authorize_add_accounts(
        host_context: *mut c_void, operation_id: u64, _key: CitizenSdkHostWalletKeyRefV1,
        _provisioning: CitizenSdkHostId128, sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32 {
        let fake = unsafe { fake_vault(host_context) };
        if *fake.retired.lock().unwrap() || fake.key_owner.lock().unwrap().is_none() {
            return CitizenSdkErrorCode::KeyInvalidated.as_i32();
        }
        // 合成认证仅回报状态，绝不能调用创建或解封来制造成功。
        unsafe { complete_status_ok(operation_id, sdk_context, completion) };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_vault_retire(
        host_context: *mut c_void,
        operation_id: u64,
        _wallet_key: CitizenSdkHostWalletKeyRefV1,
        _cleanup_operation_id: CitizenSdkHostId128,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostStatusCompletionV1,
    ) -> i32 {
        // SAFETY: 退休只改变本测试拥有的合成金库。
        *unsafe { fake_vault(host_context) }.retired.lock().unwrap() = true;
        // SAFETY: the fake completes synchronously after its durable no-op.
        unsafe { complete_status_ok(operation_id, sdk_context, completion) };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    fn vault_harness() -> (Box<FakeVault>, HostSecretVault, Arc<HostBridge>) {
        let mut fake = Box::<FakeVault>::default();
        let context = (&mut *fake as *mut FakeVault).cast::<c_void>();
        let vtable = CitizenSdkHostSecretVaultV1 {
            context,
            availability: Some(fake_vault_availability),
            ensure_wallet_kek: Some(fake_vault_ensure),
            has_wallet_kek: Some(fake_vault_has),
            wrap_dek: Some(fake_vault_wrap),
            unwrap_dek: Some(fake_vault_unwrap),
            retire_wallet_kek: Some(fake_vault_retire),
            authorize_add_accounts: Some(fake_vault_authorize_add_accounts),
            ..CitizenSdkHostSecretVaultV1::default()
        };
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, Some(vtable));
        let vault = HostSecretVault {
            bridge: Arc::clone(&bridge),
            authorizing: None,
        };
        (fake, vault, bridge)
    }


    #[test]
    fn add_authorization_never_initializes_or_unwraps_a_key() {
        let (fake, vault, _bridge) = vault_harness();
        let generation = VaultGeneration::from_bytes([81; 16]);
        assert!(block_on(vault.authorize_add_accounts([82; 16], 0, generation)).is_err());
        block_on(vault.ensure_wallet_key([83; 16], 0, generation)).unwrap();
        block_on(vault.authorize_add_accounts([82; 16], 0, generation)).unwrap();
        assert_eq!(*fake.ensure_calls.lock().unwrap(), 1);
        assert!(fake.unwrap_operations.lock().unwrap().is_empty());
        assert!(fake.seen_plaintext_deks.lock().unwrap().is_empty());
        *fake.retired.lock().unwrap() = true;
        assert!(block_on(vault.authorize_add_accounts([84; 16], 0, generation)).is_err());
    }

    #[test]
    fn wrapping_reuses_initialized_key_without_rebinding_and_retirement_stays_final() {
        let (fake, vault, bridge) = vault_harness();
        let secret_ref = test_secret_ref(1, 2, 3, 4);
        let seal = || block_on(vault.seal([8; 16], secret_ref, SecretBuffer::try_new(vec![6; 32]).unwrap()));
        assert_eq!(seal().unwrap_err().code(), ContractErrorCode::KeyInvalidated);
        assert_eq!(*fake.ensure_calls.lock().unwrap(), 0);
        assert!(!block_on(vault.has_wallet_key(secret_ref.wallet_index(), secret_ref.generation())).unwrap());
        block_on(vault.ensure_wallet_key([5; 16], secret_ref.wallet_index(), secret_ref.generation())).unwrap();
        assert!(seal().is_ok(), "另一追加操作应复用原钥");
        assert!(block_on(vault.has_wallet_key(secret_ref.wallet_index(), secret_ref.generation())).unwrap());
        assert_eq!(*fake.ensure_calls.lock().unwrap(), 1);
        assert_eq!(block_on(vault.ensure_wallet_key([8; 16], secret_ref.wallet_index(), secret_ref.generation()))
            .unwrap_err().code(), ContractErrorCode::KeyInvalidated, "另一操作不能抢占创建归属");
        block_on(vault.delete_wallet_key([9; 16], secret_ref.wallet_index(), secret_ref.generation())).unwrap();
        assert!(!block_on(vault.has_wallet_key(secret_ref.wallet_index(), secret_ref.generation())).unwrap());
        assert_eq!(seal().unwrap_err().code(), ContractErrorCode::KeyInvalidated);
        assert_eq!(block_on(vault.ensure_wallet_key([5; 16], secret_ref.wallet_index(), secret_ref.generation()))
            .unwrap_err().code(), ContractErrorCode::KeyInvalidated);
        assert_eq!(bridge.pending_count().unwrap(), 0);
    }

    fn rebuild_envelope(
        original: &EncryptedSecretEnvelope,
        digest: [u8; 32],
        ciphertext: Vec<u8>,
    ) -> EncryptedSecretEnvelope {
        EncryptedSecretEnvelope::try_new(
            original.format_version(),
            Hash32Bytes::from_bytes(digest),
            ciphertext,
        )
        .unwrap_or_else(|error| panic!("test envelope rebuild failed: {error}"))
    }

    #[test]
    fn private_view_authorizing_uses_actual_operation_id_and_rejection_drains_without_unwrap() {
        let (fake, ordinary, bridge) = vault_harness();
        let secret_ref = test_secret_ref(7, 8, 9, 10);
        block_on(ordinary.ensure_wallet_key([11; 16], secret_ref.wallet_index(), secret_ref.generation())).unwrap();
        // 复用既有公开测试材料，只记录非秘密 operation_id，不打印密钥或密文。
        let envelope = block_on(ordinary.seal(
            [11; 16],
            secret_ref,
            SecretBuffer::try_new(vec![0x37; 32]).unwrap_or_else(|_| panic!("公开测试材料")),
        ))
        .unwrap_or_else(|_| panic!("fixture seal"));
        for code in [
            CitizenSdkErrorCode::Cancelled as i32,
            CitizenSdkErrorCode::Integrity as i32,
            -1,
        ] {
            let notified = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&notified);
            let view_vault = HostSecretVault {
                bridge: Arc::clone(&bridge),
                authorizing: Some(Arc::new(move |id| {
                    recorded
                        .lock()
                        .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                        .push(id);
                    code
                })),
            };
            assert!(block_on(view_vault.open(secret_ref, envelope.clone())).is_err());
            assert_eq!(
                notified
                    .lock()
                    .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                    .len(),
                1
            );
            assert!(fake
                .unwrap_operations
                .lock()
                .unwrap_or_else(|_| panic!("测试操作记录锁损坏"))
                .is_empty());
            assert_eq!(
                bridge.pending_count().unwrap_or_else(|_| panic!("pending")),
                0
            );
        }
        let notified = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&notified);
        let view_vault = HostSecretVault {
            bridge: Arc::clone(&bridge),
            authorizing: Some(Arc::new(move |id| {
                recorded
                    .lock()
                    .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                    .push(id);
                0
            })),
        };
        drop(
            block_on(view_vault.open(secret_ref, envelope.clone()))
                .unwrap_or_else(|_| panic!("view open")),
        );
        let notifications = notified
            .lock()
            .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
            .clone();
        assert_eq!(
            notifications,
            *fake
                .unwrap_operations
                .lock()
                .unwrap_or_else(|_| panic!("测试操作记录锁损坏"))
        );
        assert_ne!(notifications[0], 0);
        drop(
            block_on(ordinary.open(secret_ref, envelope))
                .unwrap_or_else(|_| panic!("ordinary open")),
        );
        assert_eq!(
            notified
                .lock()
                .unwrap_or_else(|_| panic!("测试通知记录锁损坏"))
                .len(),
            1,
            "同 HostBridge 普通认证不应误带查看归属"
        );
        assert_eq!(
            bridge.pending_count().unwrap_or_else(|_| panic!("pending")),
            0
        );
    }

    #[test]
    fn rust_aes_gcm_round_trip_binds_every_secret_ref_field_and_hides_the_secret() {
        let (fake, vault, bridge) = vault_harness();
        let expected = test_secret_ref(7, 8, 9, 10);
        block_on(vault.ensure_wallet_key([11; 16], expected.wallet_index(), expected.generation())).unwrap();
        let plaintext = vec![0x37; 32];
        let envelope = block_on(
            vault.seal(
                [11; 16],
                expected,
                SecretBuffer::try_new(plaintext.clone())
                    .unwrap_or_else(|error| panic!("secret fixture failed: {error}")),
            ),
        )
        .unwrap_or_else(|error| panic!("vault seal failed: {error}"));
        let second = block_on(
            vault.seal(
                [12; 16],
                expected,
                SecretBuffer::try_new(plaintext.clone())
                    .unwrap_or_else(|error| panic!("second secret fixture failed: {error}")),
            ),
        )
        .unwrap_or_else(|error| panic!("second vault seal failed: {error}"));

        let opened = block_on(vault.open(expected, envelope.clone()))
            .unwrap_or_else(|error| panic!("vault open failed: {error}"));
        opened.with_secret(|bytes| assert_eq!(bytes, plaintext));

        let seen = fake
            .seen_plaintext_deks
            .lock()
            .unwrap_or_else(|_| panic!("fake vault DEK log is poisoned"));
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().all(|dek| dek.len() == 32 && dek != &plaintext));
        assert_ne!(
            seen[0], seen[1],
            "each envelope requires a fresh random DEK"
        );
        drop(seen);
        assert_ne!(envelope.ciphertext(), second.ciphertext());

        for crossed in [
            test_secret_ref(6, 8, 9, 10),
            test_secret_ref(7, 7, 9, 10),
            test_secret_ref(7, 8, 8, 10),
            test_secret_ref(7, 8, 9, 11),
        ] {
            assert_eq!(
                block_on(vault.open(crossed, envelope.clone()))
                    .err()
                    .unwrap_or_else(|| panic!("crossed SecretRef must fail"))
                    .code(),
                ContractErrorCode::Integrity
            );
        }

        // SecretKind has one constructible v1 value.  Prove its explicit tag
        // is part of AAD; a future/host-forged kind tag cannot reuse ciphertext.
        let mut different_kind_aad = secret_aad(expected);
        *different_kind_aad
            .last_mut()
            .unwrap_or_else(|| panic!("AAD kind tag is missing")) = 2;
        let different_kind_digest: [u8; 32] = Sha256::digest(&different_kind_aad).into();
        let different_kind = rebuild_envelope(
            &envelope,
            different_kind_digest,
            envelope.ciphertext().to_vec(),
        );
        assert_eq!(
            block_on(vault.open(expected, different_kind))
                .err()
                .unwrap_or_else(|| panic!("different kind digest must fail"))
                .code(),
            ContractErrorCode::Integrity
        );
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            0
        );
    }

    #[test]
    fn vault_envelope_rejects_truncation_tampering_and_incomplete_unwrap() {
        let (fake, vault, _) = vault_harness();
        let secret_ref = test_secret_ref(1, 2, 3, 4);
        block_on(vault.ensure_wallet_key([5; 16], secret_ref.wallet_index(), secret_ref.generation())).unwrap();
        let envelope = block_on(
            vault.seal(
                [5; 16],
                secret_ref,
                SecretBuffer::try_new(vec![6; 32])
                    .unwrap_or_else(|error| panic!("secret fixture failed: {error}")),
            ),
        )
        .unwrap_or_else(|error| panic!("vault seal failed: {error}"));
        let digest = *envelope.associated_data_digest().as_bytes();

        let mut truncated = envelope.ciphertext().to_vec();
        let _ = truncated.pop();
        assert!(
            block_on(vault.open(secret_ref, rebuild_envelope(&envelope, digest, truncated)))
                .is_err()
        );

        let mut nonce_tamper = envelope.ciphertext().to_vec();
        nonce_tamper[8] ^= 1;
        assert_eq!(
            block_on(vault.open(
                secret_ref,
                rebuild_envelope(&envelope, digest, nonce_tamper)
            ))
            .err()
            .unwrap_or_else(|| panic!("nonce tamper must fail"))
            .code(),
            ContractErrorCode::Integrity
        );

        let wrapped_len = u32::from_le_bytes(
            envelope.ciphertext()[20..24]
                .try_into()
                .unwrap_or_else(|_| panic!("wrapped length fixture is malformed")),
        ) as usize;
        let mut wrapped_tamper = envelope.ciphertext().to_vec();
        wrapped_tamper[28] ^= 1;
        assert!(block_on(vault.open(
            secret_ref,
            rebuild_envelope(&envelope, digest, wrapped_tamper)
        ))
        .is_err());

        let mut ciphertext_tamper = envelope.ciphertext().to_vec();
        ciphertext_tamper[28 + wrapped_len] ^= 1;
        assert!(block_on(vault.open(
            secret_ref,
            rebuild_envelope(&envelope, digest, ciphertext_tamper)
        ))
        .is_err());

        let mut bad_wrapped_length = envelope.ciphertext().to_vec();
        bad_wrapped_length[20..24].copy_from_slice(&0_u32.to_le_bytes());
        assert!(block_on(vault.open(
            secret_ref,
            rebuild_envelope(&envelope, digest, bad_wrapped_length)
        ))
        .is_err());

        fake.unwrap_mode.store(1, Ordering::SeqCst);
        assert_eq!(
            block_on(vault.open(secret_ref, envelope.clone()))
                .err()
                .unwrap_or_else(|| panic!("incomplete unwrap must fail authentication"))
                .code(),
            ContractErrorCode::Integrity
        );
        fake.unwrap_mode.store(2, Ordering::SeqCst);
        assert!(block_on(vault.open(secret_ref, envelope)).is_err());

        let mut short_output = [0_u8; 31];
        assert_eq!(
            validate_mutable_dek_view(CitizenSdkMutableBytesView {
                data: short_output.as_mut_ptr(),
                len: short_output.len() as u64,
            })
            .err()
            .unwrap_or_else(|| panic!("non-32-byte output must fail"))
            .code(),
            CitizenSdkErrorCode::InvalidArgument
        );
    }

    #[test]
    fn mismatched_result_id_kind_domain_and_duplicate_never_settle_another_operation() {
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let (record_id, mut record_receiver) = reserve_host_operation(
            bridge.owner_id,
            PendingKind::Record(CitizenSdkHostRecordDomain::WalletProfile),
            None,
        )
        .unwrap_or_else(|error| panic!("record reserve failed: {error}"));
        let mismatched_identity = CitizenSdkHostRecordResultV1 {
            host_operation_id: 0,
            domain: CitizenSdkHostRecordDomain::WalletProfile as u32,
            ..CitizenSdkHostRecordResultV1::default()
        };
        let wrong_domain = CitizenSdkHostRecordResultV1 {
            host_operation_id: record_id,
            domain: CitizenSdkHostRecordDomain::ChainDatabase as u32,
            ..CitizenSdkHostRecordResultV1::default()
        };

        // A real token paired with a different result ID is ignored before the
        // pending/completing maps or receiver are touched.
        unsafe { production_record_completion(operation_token(record_id), &mismatched_identity) };
        assert_host_operation_unclaimed(
            record_id,
            PendingKind::Record(CitizenSdkHostRecordDomain::WalletProfile),
            &mut record_receiver,
        );
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            1
        );
        // Correct token plus crossed domain consumes only this operation and
        // delivers one deterministic integrity failure.
        unsafe { production_record_completion(operation_token(record_id), &wrong_domain) };
        let error = block_on(record_receiver)
            .unwrap_or_else(|_| panic!("record receiver was cancelled"))
            .err()
            .unwrap_or_else(|| panic!("wrong domain must fail"));
        assert_eq!(error.code(), ContractErrorCode::Integrity);
        unsafe { production_record_completion(operation_token(record_id), &wrong_domain) };

        let (bool_id, bool_receiver) =
            reserve_host_operation(bridge.owner_id, PendingKind::Bool, None)
                .unwrap_or_else(|error| panic!("bool reserve failed: {error}"));
        let status = CitizenSdkHostStatusResultV1 {
            host_operation_id: bool_id,
            ..CitizenSdkHostStatusResultV1::default()
        };
        unsafe { production_status_completion(operation_token(bool_id), &status) };
        let error = block_on(bool_receiver)
            .unwrap_or_else(|_| panic!("bool receiver was cancelled"))
            .err()
            .unwrap_or_else(|| panic!("wrong completion kind must fail"));
        assert_eq!(error.code(), ContractErrorCode::Integrity);
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            0
        );
    }

    #[test]
    fn every_non_null_completion_rejects_crossed_real_identities_before_claim() {
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let (record_id, mut record_receiver) = bridge
            .reserve_operation(
                PendingKind::Record(CitizenSdkHostRecordDomain::WalletProfile),
                None,
            )
            .unwrap_or_else(|error| panic!("record reserve failed: {error}"));
        let (status_id, mut status_receiver) = bridge
            .reserve_operation(PendingKind::Status, None)
            .unwrap_or_else(|error| panic!("status reserve failed: {error}"));
        let (bool_id, mut bool_receiver) = bridge
            .reserve_operation(PendingKind::Bool, None)
            .unwrap_or_else(|error| panic!("bool reserve failed: {error}"));
        let (availability_id, mut availability_receiver) = bridge
            .reserve_operation(PendingKind::VaultAvailability, None)
            .unwrap_or_else(|error| panic!("availability reserve failed: {error}"));
        let (wrapped_id, mut wrapped_receiver) = bridge
            .reserve_operation(
                PendingKind::WrappedDek,
                Some(Zeroizing::new(vec![
                    0x11;
                    CITIZENSDK_HOST_DEK_BYTES as usize
                ])),
            )
            .unwrap_or_else(|error| panic!("wrapped DEK reserve failed: {error}"));
        let (unwrapped_id, mut unwrapped_receiver) = bridge
            .reserve_operation(
                PendingKind::UnwrappedDek,
                Some(Zeroizing::new(vec![
                    0x22;
                    CITIZENSDK_HOST_DEK_BYTES as usize
                ])),
            )
            .unwrap_or_else(|error| panic!("unwrapped DEK reserve failed: {error}"));

        // Every result deliberately carries another live operation's ID. The
        // callback receives its own real token, so none of the six operations
        // may move from pending to completing or settle its receiver.
        let record_result = CitizenSdkHostRecordResultV1 {
            host_operation_id: status_id,
            domain: CitizenSdkHostRecordDomain::WalletProfile as u32,
            ..CitizenSdkHostRecordResultV1::default()
        };
        unsafe { production_record_completion(operation_token(record_id), &record_result) };
        assert_host_operation_unclaimed(
            record_id,
            PendingKind::Record(CitizenSdkHostRecordDomain::WalletProfile),
            &mut record_receiver,
        );

        let status_result = CitizenSdkHostStatusResultV1 {
            host_operation_id: bool_id,
            ..CitizenSdkHostStatusResultV1::default()
        };
        unsafe { production_status_completion(operation_token(status_id), &status_result) };
        assert_host_operation_unclaimed(status_id, PendingKind::Status, &mut status_receiver);

        let bool_result = CitizenSdkHostBoolResultV1 {
            host_operation_id: availability_id,
            ..CitizenSdkHostBoolResultV1::default()
        };
        unsafe { production_bool_completion(operation_token(bool_id), &bool_result) };
        assert_host_operation_unclaimed(bool_id, PendingKind::Bool, &mut bool_receiver);

        let availability_result = CitizenSdkHostVaultAvailabilityResultV1 {
            host_operation_id: wrapped_id,
            ..CitizenSdkHostVaultAvailabilityResultV1::default()
        };
        unsafe {
            production_vault_availability_completion(
                operation_token(availability_id),
                &availability_result,
            )
        };
        assert_host_operation_unclaimed(
            availability_id,
            PendingKind::VaultAvailability,
            &mut availability_receiver,
        );

        let wrapped_result = CitizenSdkHostBytesResultV1 {
            host_operation_id: unwrapped_id,
            kind: CitizenSdkHostBytesKind::WrappedDek as u32,
            ..CitizenSdkHostBytesResultV1::default()
        };
        unsafe { production_wrapped_dek_completion(operation_token(wrapped_id), &wrapped_result) };
        assert_host_operation_unclaimed(wrapped_id, PendingKind::WrappedDek, &mut wrapped_receiver);

        let unwrapped_result = CitizenSdkHostStatusResultV1 {
            host_operation_id: record_id,
            ..CitizenSdkHostStatusResultV1::default()
        };
        unsafe { production_status_completion(operation_token(unwrapped_id), &unwrapped_result) };
        assert_host_operation_unclaimed(
            unwrapped_id,
            PendingKind::UnwrappedDek,
            &mut unwrapped_receiver,
        );
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("crossed completion scan failed: {error}")),
            6
        );

        // Null results have no result ID to cross-check and intentionally
        // remain terminal for the operation selected by their real token.
        unsafe {
            production_record_completion(operation_token(record_id), std::ptr::null());
            production_status_completion(operation_token(status_id), std::ptr::null());
            production_bool_completion(operation_token(bool_id), std::ptr::null());
            production_vault_availability_completion(
                operation_token(availability_id),
                std::ptr::null(),
            );
            production_wrapped_dek_completion(operation_token(wrapped_id), std::ptr::null());
            production_status_completion(operation_token(unwrapped_id), std::ptr::null());
        }
        assert_terminal_integrity(record_receiver);
        assert_terminal_integrity(status_receiver);
        assert_terminal_integrity(bool_receiver);
        assert_terminal_integrity(availability_receiver);
        assert_terminal_integrity(wrapped_receiver);
        assert_terminal_integrity(unwrapped_receiver);
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("post-null completion scan failed: {error}")),
            0
        );
    }

    #[test]
    fn mismatched_result_id_is_ignored_but_null_first_completion_is_terminal() {
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let (status_id, mut status_receiver) = bridge
            .reserve_operation(PendingKind::Status, None)
            .unwrap_or_else(|error| panic!("status reserve failed: {error}"));
        let wrong_id = CitizenSdkHostStatusResultV1 {
            host_operation_id: 0,
            ..CitizenSdkHostStatusResultV1::default()
        };
        unsafe { production_status_completion(operation_token(status_id), &wrong_id) };
        assert_host_operation_unclaimed(status_id, PendingKind::Status, &mut status_receiver);

        unsafe { production_status_completion(operation_token(status_id), std::ptr::null()) };
        assert_terminal_integrity(status_receiver);

        // A later non-null completion cannot repair the null-terminated op.
        let corrected = CitizenSdkHostStatusResultV1 {
            host_operation_id: status_id,
            ..CitizenSdkHostStatusResultV1::default()
        };
        unsafe { production_status_completion(operation_token(status_id), &corrected) };

        let (bool_id, bool_receiver) = bridge
            .reserve_operation(PendingKind::Bool, None)
            .unwrap_or_else(|error| panic!("bool reserve failed: {error}"));
        unsafe { production_bool_completion(operation_token(bool_id), std::ptr::null()) };
        let error = block_on(bool_receiver)
            .unwrap_or_else(|_| panic!("bool receiver was cancelled"))
            .err()
            .unwrap_or_else(|| panic!("null first completion must fail"));
        assert_eq!(error.code(), ContractErrorCode::Integrity);
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            0
        );
    }

    #[test]
    fn unknown_synchronous_status_rejects_without_leaking_pending_state() {
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let error = block_on(bridge.call_status(|_, _, _| i32::MAX))
            .err()
            .unwrap_or_else(|| panic!("unknown host status must fail"));
        assert_eq!(error.code(), ContractErrorCode::Internal);
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|count| panic!("pending count failed: {count}")),
            0
        );
    }

    #[test]
    fn operation_gate_linearizes_close_reserve_scan_and_reopen() {
        use std::{sync::Barrier, thread};

        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        bridge
            .close_operation_gate()
            .unwrap_or_else(|error| panic!("initial gate close failed: {error}"));
        bridge
            .close_operation_gate()
            .unwrap_or_else(|error| panic!("idempotent gate close failed: {error}"));
        assert_eq!(
            bridge
                .reserve_operation(PendingKind::Status, None)
                .err()
                .unwrap_or_else(|| panic!("closed gate must reject"))
                .code(),
            ContractErrorCode::InvalidState
        );
        bridge
            .reopen_operation_gate()
            .unwrap_or_else(|error| panic!("gate reopen failed: {error}"));
        bridge
            .reopen_operation_gate()
            .unwrap_or_else(|error| panic!("idempotent gate reopen failed: {error}"));

        for _ in 0..32 {
            bridge
                .reopen_operation_gate()
                .unwrap_or_else(|error| panic!("loop gate reopen failed: {error}"));
            let barrier = Arc::new(Barrier::new(2));
            let reserve_bridge = Arc::clone(&bridge);
            let reserve_barrier = Arc::clone(&barrier);
            let reserve = thread::spawn(move || {
                reserve_barrier.wait();
                reserve_bridge.reserve_operation(PendingKind::Status, None)
            });
            barrier.wait();
            bridge
                .close_operation_gate()
                .unwrap_or_else(|error| panic!("racing gate close failed: {error}"));
            let reserved = reserve
                .join()
                .unwrap_or_else(|_| panic!("reserve thread panicked"));
            match reserved {
                Ok((operation_id, receiver)) => {
                    // If reserve linearized first, the entry is already visible
                    // when close returns and therefore cannot be missed by scan.
                    assert_eq!(
                        bridge.pending_count().unwrap_or_else(|error| {
                            panic!("post-close pending scan failed: {error}")
                        }),
                        1
                    );
                    drop(receiver);
                    let result = CitizenSdkHostStatusResultV1 {
                        host_operation_id: operation_id,
                        ..CitizenSdkHostStatusResultV1::default()
                    };
                    unsafe { production_status_completion(operation_token(operation_id), &result) };
                }
                Err(error) => {
                    // If close linearized first, the reserve is rejected and no
                    // hidden pending entry exists.
                    assert_eq!(error.code(), ContractErrorCode::InvalidState);
                    assert_eq!(
                        bridge.pending_count().unwrap_or_else(|count| {
                            panic!("closed pending scan failed: {count}")
                        }),
                        0
                    );
                }
            }
        }
        bridge
            .reopen_operation_gate()
            .unwrap_or_else(|error| panic!("final gate reopen failed: {error}"));
    }

    #[test]
    fn claimed_completion_remains_outstanding_until_sdk_completion_finishes() {
        use std::{sync::mpsc, thread};

        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let (operation_id, receiver) = bridge
            .reserve_operation(PendingKind::Status, None)
            .unwrap_or_else(|error| panic!("status reserve failed: {error}"));
        bridge
            .close_operation_gate()
            .unwrap_or_else(|error| panic!("host gate close failed: {error}"));

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let completion = thread::spawn(move || {
            complete_host_operation(operation_id, PendingKind::Status, move |_, _| {
                entered_tx
                    .send(())
                    .unwrap_or_else(|error| panic!("completion entry signal failed: {error}"));
                release_rx
                    .recv()
                    .unwrap_or_else(|error| panic!("completion release signal failed: {error}"));
                Ok(HostCompletion::Status(CitizenSdkErrorCode::Ok))
            });
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("completion was not claimed: {error}"));

        // This is the exact outstanding scan used by destroy after closing the
        // host-operation gate. The pending entry has already been claimed, but
        // the completion path still validates/copies host memory and must keep
        // destroy in BUSY rather than allowing instance-owned state to be freed.
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("completion scan failed: {error}")),
            1
        );

        release_tx
            .send(())
            .unwrap_or_else(|error| panic!("completion release failed: {error}"));
        completion
            .join()
            .unwrap_or_else(|_| panic!("completion thread panicked"));
        assert!(matches!(
            block_on(receiver).unwrap_or_else(|_| panic!("completion receiver was cancelled")),
            Ok(HostCompletion::Status(CitizenSdkErrorCode::Ok))
        ));
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("post-completion scan failed: {error}")),
            0
        );
        bridge
            .reopen_operation_gate()
            .unwrap_or_else(|error| panic!("host gate reopen failed: {error}"));
    }

    #[test]
    fn cancelled_future_keeps_pending_state_until_safe_late_completion() {
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let deferred = Arc::new(Mutex::new(None));
        let captured = Arc::clone(&deferred);
        let mut future = Box::pin(bridge.call_status(
            move |operation_id, sdk_context, completion| {
                *captured
                    .lock()
                    .unwrap_or_else(|_| panic!("deferred completion is poisoned")) =
                    Some((operation_id, sdk_context as usize, completion));
                CitizenSdkErrorCode::Ok.as_i32()
            },
        ));
        let mut context = Context::from_waker(noop_waker_ref());
        assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            1
        );
        drop(future);

        let (operation_id, sdk_context, completion) = deferred
            .lock()
            .unwrap_or_else(|_| panic!("deferred completion is poisoned"))
            .take()
            .unwrap_or_else(|| panic!("dispatch did not capture completion"));
        let result = CitizenSdkHostStatusResultV1 {
            host_operation_id: operation_id,
            ..CitizenSdkHostStatusResultV1::default()
        };
        unsafe {
            completion.unwrap_or_else(|| panic!("deferred completion is missing"))(
                sdk_context as *mut c_void,
                &result,
            )
        };
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            0
        );
        // Duplicate late completion is a safe no-op and never dereferences an
        // instance pointer (sdk_context is only the integer operation token).
        unsafe {
            completion.unwrap_or_else(|| panic!("deferred completion is missing"))(
                sdk_context as *mut c_void,
                &result,
            )
        };
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            0
        );
    }

    #[test]
    fn cancelled_wrap_future_keeps_rust_owned_dek_valid_only_until_completion() {
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        let expected_dek = vec![0x93; CITIZENSDK_HOST_DEK_BYTES as usize];
        let deferred = Arc::new(Mutex::new(None));
        let captured = Arc::clone(&deferred);
        let mut future = Box::pin(bridge.call_wrap_dek(
            Zeroizing::new(expected_dek.clone()),
            move |operation_id, plaintext_dek, sdk_context, completion| {
                *captured
                    .lock()
                    .unwrap_or_else(|_| panic!("deferred wrap is poisoned")) = Some((
                    operation_id,
                    plaintext_dek.data as usize,
                    plaintext_dek.len,
                    sdk_context as usize,
                    completion,
                ));
                CitizenSdkErrorCode::Ok.as_i32()
            },
        ));
        let mut context = Context::from_waker(noop_waker_ref());
        assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
        drop(future);

        let (operation_id, dek_pointer, dek_len, sdk_context, completion) = deferred
            .lock()
            .unwrap_or_else(|_| panic!("deferred wrap is poisoned"))
            .take()
            .unwrap_or_else(|| panic!("wrap dispatch did not run"));
        assert_eq!(dek_len, CITIZENSDK_HOST_DEK_BYTES);
        // SAFETY: cancellation drops only the receiver; the pending registry
        // owns this zeroizing buffer until the first completion below.
        assert_eq!(
            unsafe {
                std::slice::from_raw_parts(
                    dek_pointer as *const u8,
                    usize::try_from(dek_len).unwrap_or_else(|_| panic!("DEK length exceeds usize")),
                )
            },
            expected_dek
        );
        let wrapped = vec![0x39; 32];
        let result = CitizenSdkHostBytesResultV1 {
            host_operation_id: operation_id,
            kind: CitizenSdkHostBytesKind::WrappedDek as u32,
            bytes: input_view(&wrapped),
            ..CitizenSdkHostBytesResultV1::default()
        };
        unsafe {
            completion.unwrap_or_else(|| panic!("wrap completion is missing"))(
                sdk_context as *mut c_void,
                &result,
            )
        };
        assert_eq!(
            bridge
                .pending_count()
                .unwrap_or_else(|error| panic!("pending count failed: {error}")),
            0
        );
        // The pointer is deliberately never read after completion: its owner
        // has zeroized and released the allocation at that linearization point.
    }

    #[derive(Default)]
    struct FakeChainStore {
        durable: Mutex<Option<(u64, Vec<u8>)>>,
        cas_mode: AtomicU8,
    }

    unsafe fn fake_chain<'a>(context: *mut c_void) -> &'a FakeChainStore {
        assert!(!context.is_null());
        // SAFETY: the boxed fake outlives every synchronous completion.
        unsafe { &*(context.cast::<FakeChainStore>()) }
    }

    unsafe extern "C" fn fake_chain_load(
        host_context: *mut c_void,
        operation_id: u64,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        let current = unsafe { fake_chain(host_context) }
            .durable
            .lock()
            .unwrap_or_else(|_| panic!("fake chain store is poisoned"))
            .clone();
        let mut result = CitizenSdkHostRecordResultV1 {
            host_operation_id: operation_id,
            domain: CitizenSdkHostRecordDomain::ChainDatabase as u32,
            ..CitizenSdkHostRecordResultV1::default()
        };
        if let Some((revision, bytes)) = current.as_ref() {
            result.present = 1;
            result.revision = *revision;
            result.record = input_view(bytes);
        }
        // SAFETY: any returned bytes live through this synchronous completion.
        unsafe {
            completion.unwrap_or_else(|| panic!("chain completion is missing"))(
                sdk_context,
                &result,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    unsafe extern "C" fn fake_chain_cas(
        host_context: *mut c_void,
        operation_id: u64,
        expected_revision: u64,
        present: u8,
        candidate_record: CitizenSdkBytesView,
        sdk_context: *mut c_void,
        completion: CitizenSdkHostRecordCompletionV1,
    ) -> i32 {
        assert_eq!(present, 1);
        // SAFETY: the SDK lends this input through callback return only.
        let candidate = unsafe { borrowed_bytes(candidate_record) };
        let fake = unsafe { fake_chain(host_context) };
        if fake.cas_mode.load(Ordering::SeqCst) == 1 {
            *fake
                .durable
                .lock()
                .unwrap_or_else(|_| panic!("fake chain store is poisoned")) =
                Some((expected_revision + 1, candidate));
        }
        let result = CitizenSdkHostRecordResultV1 {
            host_operation_id: operation_id,
            error_code: CitizenSdkErrorCode::Storage.as_i32(),
            domain: CitizenSdkHostRecordDomain::ChainDatabase as u32,
            ..CitizenSdkHostRecordResultV1::default()
        };
        // SAFETY: this simulates a host that cannot tell whether a durable
        // write happened and therefore completes with a storage error.
        unsafe {
            completion.unwrap_or_else(|| panic!("chain completion is missing"))(
                sdk_context,
                &result,
            )
        };
        CitizenSdkErrorCode::Ok.as_i32()
    }

    fn chain_harness(mode: u8) -> (Box<FakeChainStore>, HostChainDatabaseStore) {
        let mut fake = Box::<FakeChainStore>::default();
        fake.cas_mode.store(mode, Ordering::SeqCst);
        let context = (&mut *fake as *mut FakeChainStore).cast::<c_void>();
        let public = CitizenSdkHostPublicStoreV1 {
            context,
            chain_database_load: Some(fake_chain_load),
            chain_database_compare_and_swap: Some(fake_chain_cas),
            ..CitizenSdkHostPublicStoreV1::default()
        };
        let store = HostChainDatabaseStore {
            bridge: test_bridge(public, None, None),
        };
        (fake, store)
    }

    #[test]
    fn cas_write_after_error_converges_only_when_full_candidate_is_durable() {
        let (_written_fake, written_store) = chain_harness(1);
        let actual = block_on(written_store.compare_and_swap(0, None))
            .unwrap_or_else(|error| panic!("durable candidate must converge: {error}"));
        assert_eq!(actual, ChainDatabaseSnapshot::new(1, None));

        let (_unchanged_fake, unchanged_store) = chain_harness(0);
        let error = block_on(unchanged_store.compare_and_swap(0, None))
            .err()
            .unwrap_or_else(|| panic!("non-durable candidate must retain original error"));
        assert_eq!(error.code(), ContractErrorCode::Storage);
        assert_eq!(
            block_on(unchanged_store.load())
                .unwrap_or_else(|load| panic!("post-error load failed: {load}")),
            ChainDatabaseSnapshot::new(0, None)
        );
    }
    unsafe extern "C" fn presence_account(
        context: *mut c_void, operation: u64, account: CitizenSdkAccountId,
        token: *mut c_void, completion: CitizenSdkHostBoolCompletionV1,
    ) -> i32 {
        let mode = unsafe { &*(context.cast::<AtomicU8>()) }.load(Ordering::SeqCst);
        if mode == 3 { return CitizenSdkErrorCode::PermissionDenied.as_i32(); }
        let result = CitizenSdkHostBoolResultV1 {
            host_operation_id: operation,
            error_code: if mode == 1 { CitizenSdkErrorCode::Storage.as_i32() } else { 0 },
            value: if mode == 2 { 2 } else if mode == 1 { 0 } else { u8::from(account.bytes == [7; 32]) },
            ..CitizenSdkHostBoolResultV1::default()
        };
        unsafe { completion.unwrap_or_else(|| panic!("缺少布尔完成"))(token, &result); }
        0
    }
    unsafe extern "C" fn presence_wallet(
        context: *mut c_void, operation: u64, index: u32, token: *mut c_void,
        completion: CitizenSdkHostBoolCompletionV1,
    ) -> i32 {
        unsafe { presence_account(context, operation,
            CitizenSdkAccountId { bytes: [if index == u32::MAX { 7 } else { 0 }; 32] }, token, completion) }
    }

    #[test]
    fn secret_presence_registration_is_exact_once_and_queries_use_existing_completion_validation() {
        assert_eq!(std::mem::size_of::<CitizenSdkHostSecretPresenceV1>(), 32);
        assert_eq!(std::mem::offset_of!(CitizenSdkHostSecretPresenceV1, context), 8);
        assert_eq!(std::mem::offset_of!(CitizenSdkHostSecretPresenceV1, has_account_secret), 16);
        assert_eq!(std::mem::offset_of!(CitizenSdkHostSecretPresenceV1, has_any_wallet_key), 24);
        let bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(),
            Some(CitizenSdkHostSecureStoreV1::default()), Some(CitizenSdkHostSecretVaultV1::default()));
        let adapter = HostServicesAdapter { bridge: Arc::clone(&bridge) };
        let blobs = HostEncryptedSecretBlobStore { bridge: Arc::clone(&bridge) };
        let vault = HostSecretVault { bridge: Arc::clone(&bridge), authorizing: None };
        let mode = AtomicU8::new(0);
        let provider = CitizenSdkHostSecretPresenceV1 {
            struct_size: 32, abi_version: 1, context: (&mode as *const AtomicU8).cast_mut().cast(),
            has_account_secret: Some(presence_account), has_any_wallet_key: Some(presence_wallet),
        };
        assert_eq!(block_on(blobs.has_account_secret(AccountId32::from_bytes([7; 32])))
            .err().unwrap_or_else(|| panic!("应拒绝未登记查询")).code(), ContractErrorCode::Unsupported);
        for malformed in [
            CitizenSdkHostSecretPresenceV1 { struct_size: 31, ..provider },
            CitizenSdkHostSecretPresenceV1 { struct_size: 33, ..provider },
            CitizenSdkHostSecretPresenceV1 { abi_version: 2, ..provider },
            CitizenSdkHostSecretPresenceV1 { has_account_secret: None, ..provider },
            CitizenSdkHostSecretPresenceV1 { has_any_wallet_key: None, ..provider },
        ] {
            assert!(unsafe { adapter.set_secret_presence_provider(malformed) }.is_err());
        }
        unsafe { adapter.set_secret_presence_provider(provider) }.unwrap_or_else(|_| panic!("提供者登记失败"));
        assert!(unsafe { adapter.set_secret_presence_provider(provider) }.is_err());
        assert!(block_on(blobs.has_account_secret(AccountId32::from_bytes([7; 32]))).unwrap_or_else(|_| panic!("存在查询失败")));
        assert!(!block_on(blobs.has_account_secret(AccountId32::from_bytes([8; 32]))).unwrap_or_else(|_| panic!("不存在查询失败")));
        assert!(block_on(vault.has_any_wallet_key(u32::MAX)).unwrap_or_else(|_| panic!("钱包查询失败")));
        assert!(!block_on(vault.has_any_wallet_key(0)).unwrap_or_else(|_| panic!("钱包查询失败")));
        for value in [1, 2, 3] {
            mode.store(value, Ordering::SeqCst);
            assert!(block_on(blobs.has_account_secret(AccountId32::from_bytes([8; 32]))).is_err());
            assert!(block_on(vault.has_any_wallet_key(0)).is_err()); // 错误不能变成不存在。
        }
        bridge.close_operation_gate().unwrap_or_else(|_| panic!("关门失败"));
        assert!(block_on(blobs.has_account_secret(AccountId32::from_bytes([7; 32]))).is_err());

        let late_bridge = test_bridge(CitizenSdkHostPublicStoreV1::default(),
            Some(CitizenSdkHostSecureStoreV1::default()), Some(CitizenSdkHostSecretVaultV1::default()));
        let (operation, pending) = late_bridge.reserve_operation(PendingKind::Bool, None)
            .unwrap_or_else(|_| panic!("Host操作接纳失败"));
        let result = CitizenSdkHostBoolResultV1 { host_operation_id: operation, ..CitizenSdkHostBoolResultV1::default() };
        unsafe { production_bool_completion(operation_token(operation), &result); }
        assert!(block_on(pending).unwrap_or_else(|_| panic!("Host完成丢失")).is_ok());
        assert!(unsafe { HostServicesAdapter { bridge: late_bridge }.set_secret_presence_provider(provider) }.is_err());
        let public_only = test_bridge(CitizenSdkHostPublicStoreV1::default(), None, None);
        assert!(unsafe { HostServicesAdapter { bridge: public_only }.set_secret_presence_provider(provider) }.is_err());
        assert_ne!(unsafe { citizensdk_set_secret_presence_provider(0, &provider) }, 0);
        assert_ne!(unsafe { citizensdk_set_secret_presence_provider(0, std::ptr::null()) }, 0);
    }

}
