//! 真实系统金库C回调与拥有者。
//!
//! SQLite业务和记录验证直接由Core仓储执行；此处仅保有物理金库操作。
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

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use crate::types::ContractError;
use crate::types::ContractErrorCode;
use crate::types::ContractFuture;
use crate::types::EncryptedSecretEnvelope;
use crate::types::Hash32Bytes;
use crate::types::SecretBuffer;
use crate::types::SecretKind;
use crate::types::SecretRef;
use crate::types::SecretVault;
use crate::types::VaultAvailability;
use crate::types::VaultGeneration;
use aes_gcm::aead::Aead;
use aes_gcm::aead::KeyInit;
use aes_gcm::aead::Payload;
use aes_gcm::Aes256Gcm;
use aes_gcm::Nonce;
use futures_channel::oneshot;
use sha2::Digest;
use sha2::Sha256;
use zeroize::Zeroize;
use zeroize::Zeroizing;

use crate::abi::types::CitizenSdkBytesView;
use crate::abi::types::CitizenSdkErrorCode;
use crate::abi::types::CITIZENSDK_ABI_VERSION;

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
pub struct CitizenSdkHostId128 {
    pub bytes: [u8; 16],
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

pub type CitizenSdkHostVaultHasAnyWalletKeyV1 = Option<
    unsafe extern "C" fn(*mut c_void, u64, u32, *mut c_void, CitizenSdkHostBoolCompletionV1) -> i32,
>;
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
    pub has_any_wallet_key: CitizenSdkHostVaultHasAnyWalletKeyV1,
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
            has_any_wallet_key: None,
        }
    }
}

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
        || provider.has_any_wallet_key.is_none()
    {
        return Err(HostProviderError::new(
            CitizenSdkErrorCode::InvalidArgument,
            "host secret vault must provide every KEK and DEK callback",
        ));
    }
    Ok(())
}

/// 核对实际设备操作完成身份、当前ABI与固定状态。
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
    Status,
    Bool,
    VaultAvailability,
    WrappedDek,
    UnwrappedDek,
}

enum HostCompletion {
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
        (PendingKind::Status, PendingKind::Status)
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
struct SendSecretVault(CitizenSdkHostSecretVaultV1);
// SAFETY: 宿主保证回调/context线程安全并持有到Core成功销毁。
unsafe impl Send for SendSecretVault {}
// SAFETY: 宿主保证回调/context线程安全并持有到Core成功销毁。
unsafe impl Sync for SendSecretVault {}

struct HostBridge {
    owner_id: u64,
    operation_gate: Mutex<HostOperationGate>,
    vault: Option<SendSecretVault>,
}

struct HostOperationGate {
    accepting: bool,
}

impl HostBridge {
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
        let gate = self.operation_gate.lock().map_err(|_| {
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

/// 实际金库拥有者；保有宿主回调和所有未完成的秘密缓冲。
#[derive(Clone)]
pub struct HostSecretVault {
    bridge: Arc<HostBridge>,
    authorizing: Option<Arc<dyn Fn(u64) -> i32 + Send + Sync>>,
}

impl HostSecretVault {
    pub(crate) unsafe fn from_vault(
        value: *const CitizenSdkHostSecretVaultV1,
    ) -> Result<Self, ContractError> {
        let vault = crate::abi::read_versioned(value, "secret vault").map_err(|_| {
            ContractError::new(ContractErrorCode::InvalidArgument, "vault ABI differs")
        })?;
        validate_secret_vault_v1(&vault).map_err(host_provider_contract_error)?;
        Ok(Self {
            authorizing: None,
            bridge: Arc::new(HostBridge {
                owner_id: next_global_id(&NEXT_HOST_OWNER_ID, "host provider owner id exhausted")?,
                operation_gate: Mutex::new(HostOperationGate { accepting: true }),
                vault: Some(SendSecretVault(vault)),
            }),
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

fn input_view(bytes: &[u8]) -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    }
}

fn host_id(bytes: [u8; 16]) -> CitizenSdkHostId128 {
    CitizenSdkHostId128 { bytes }
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
            let provider = bridge
                .vault
                .ok_or_else(|| ContractError::new(ContractErrorCode::Unsupported, "金库未提供"))?;
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

#[cfg(test)]
#[path = "../tests/abi/host.rs"]
mod production_tests;
