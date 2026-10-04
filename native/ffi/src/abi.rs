use std::ffi::c_void;

// These C-layout host contracts live beside their validation/tracking logic,
// but remain part of the one public ABI namespace exported by this module.
pub use crate::host_providers::{
    CitizenSdkHostBoolCompletionV1, CitizenSdkHostBoolResultV1, CitizenSdkHostBytesCompletionV1,
    CitizenSdkHostBytesKind, CitizenSdkHostBytesResultV1,
    CitizenSdkHostChainDatabaseCompareAndSwapV1, CitizenSdkHostChainDatabaseLoadV1,
    CitizenSdkHostEncryptedSecretBlobCompareAndSwapV1, CitizenSdkHostEncryptedSecretBlobLoadV1,
    CitizenSdkHostHasAccountSecretV1, CitizenSdkHostHasAnyWalletKeyV1, CitizenSdkHostHash32,
    CitizenSdkHostId128, CitizenSdkHostPublicStoreV1, CitizenSdkHostRecordCompletionV1,
    CitizenSdkHostRecordDomain, CitizenSdkHostRecordResultV1, CitizenSdkHostRuntimeCacheDeleteV1,
    CitizenSdkHostRuntimeCacheLoadV1, CitizenSdkHostRuntimeCacheStoreV1, CitizenSdkHostSecretKind,
    CitizenSdkHostSecretPresenceV1, CitizenSdkHostSecretRefV1, CitizenSdkHostSecretVaultV1,
    CitizenSdkHostSecureStoreV1, CitizenSdkHostServicesV1, CitizenSdkHostStatusCompletionV1,
    CitizenSdkHostStatusResultV1, CitizenSdkHostTransactionHistoryMutateV1,
    CitizenSdkHostTransactionHistoryQueryV1, CitizenSdkHostVaultAuthorizeAddAccountsV1,
    CitizenSdkHostVaultAvailability, CitizenSdkHostVaultAvailabilityCompletionV1,
    CitizenSdkHostVaultAvailabilityResultV1, CitizenSdkHostVaultAvailabilityV1,
    CitizenSdkHostVaultEnsureWalletKekV1, CitizenSdkHostVaultHasWalletKekV1,
    CitizenSdkHostVaultRetireWalletKekV1, CitizenSdkHostVaultUnwrapDekV1,
    CitizenSdkHostVaultWrapDekV1, CitizenSdkHostWalletKeyRefV1,
    CitizenSdkHostWalletProfileCompareAndSwapV1, CitizenSdkHostWalletProfileLoadV1,
    CitizenSdkMutableBytesView, CITIZENSDK_HOST_DEK_BYTES,
};

pub const CITIZENSDK_ABI_VERSION: u32 = 1;
pub const CITIZENSDK_CAPABILITY_COUNT: usize = 10;

pub type CitizenSdkHandle = u64;
pub type CitizenSdkRequestId = u64;
pub type CitizenSdkResultHandle = u64;
/// SDK-owned, single-use wallet-creation session. Dropping the registry entry
/// drops [`citizen_sdk_engine::PreparedWalletCreation`] and zeroizes its
/// mnemonic/password buffers; it is deliberately not an instance/result ID.
pub type CitizenSdkPreparedWalletHandle = u64;
/// Instance-owned opaque transaction preparation; it is never a serialized recovery token.
pub type CitizenSdkPreparedTransactionHandle = u64;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CitizenSdkTransactionExecutionId {
    pub bytes: [u8; 16],
}

#[repr(i32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkErrorCode {
    Ok = 0,
    InvalidArgument = 1,
    InvalidHandle = 2,
    InvalidState = 3,
    Unsupported = 4,
    Unavailable = 5,
    NotReady = 6,
    NotFound = 7,
    Conflict = 8,
    Integrity = 9,
    AuthenticationCancelled = 10,
    AuthenticationRequired = 11,
    KeyInvalidated = 12,
    PermissionDenied = 13,
    Storage = 14,
    Network = 15,
    Decode = 16,
    Timeout = 17,
    Busy = 18,
    QueueFull = 19,
    Internal = 20,
    Panic = 21,
    Cancelled = 22,
}

impl CitizenSdkErrorCode {
    pub const fn as_i32(self) -> i32 {
        self as i32
    }
}

/// Product-independent phase in which an SDK operation failed.
/// Existing error-code values and result-structure layouts remain unchanged.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkFailureStage {
    Admission = 1,
    Validation = 2,
    Authentication = 3,
    Persistence = 4,
    Provider = 5,
    Verification = 6,
    Cancellation = 7,
    Teardown = 8,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkLifecycle {
    Created = 1,
    ImportingState = 2,
    Starting = 3,
    Running = 4,
    StartFailed = 5,
    Stopped = 6,
    Disposed = 7,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkFinality {
    Best = 1,
    Finalized = 2,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkCapabilityName {
    ChainRead = 1,
    TransactionBuild = 2,
    TransactionSubmit = 3,
    TransactionVerify = 4,
    WalletProfile = 5,
    LocalSigning = 6,
    HardwareVault = 7,
    UserAuthentication = 8,
    History = 9,
    BackgroundSync = 10,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkCapabilityReason {
    None = 0,
    BuildUnsupported = 1,
    DeviceUnavailable = 2,
    HostDisabled = 3,
    EngineNotRunning = 4,
    DependencyNotReady = 5,
    UserAuthenticationRequired = 6,
    VaultLocked = 7,
    ChainStarting = 8,
    ChainUnsynced = 9,
    StorageUnavailable = 10,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkEventType {
    RequestCompleted = 1,
    WatchUpdate = 2,
    CapabilitiesChanged = 3,
    LifecycleChanged = 4,
    /// 无 payload 的历史失效通知，接收者通过已有历史 API 读取最新状态。
    HistoryChanged = 5,
    /// provider 已验证的 finalized block 变化；result 是一个 BlockRef。
    FinalizedBlockChanged = 6,
    /// 钱包可能变更后的无payload失效通知；宿主回读同实例目录，不推断操作成功。
    WalletChanged = 7,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkResultKind {
    Empty = 0,
    BlockRef = 1,
    StorageValue = 2,
    StorageBatch = 3,
    RuntimeContext = 4,
    ExtrinsicHash = 5,
    ExecutionConclusion = 6,
    WatchEvent = 7,
    ExportedState = 8,
    AccountBalance = 9,
    AccountNonce = 10,
    FeeSnapshot = 11,
    WalletProfile = 12,
    /// 原ABI数值保持不变且不复用；现行Core不再产生此种结果。
    WalletAccounts = 13,
    Signature = 14,
    PreparedWallet = 15,
    /// Numeric 16 is permanently unused after removal of the product-specific
    /// wallet-transfer result.
    TransactionHistoryPage = 17,
    AccountBalances = 18,
    QrReview = 19,
    QrSigned = 20,
    WalletState = 21,
    SigningOutcome = 22,
    DefaultAccountChange = 23,
    ChainSyncStatus = 24,
    BlockHeader = 25,
    BlockBody = 26,
    PreparedTransaction = 27,
    TransactionExecution = 28,
    ApplicationKey = 29,
    ApplicationKeys = 30,
    ApplicationKeyPreparation = 31,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkTransactionExecutionStatus {
    ExternalPending = 1,
    FinalizedSuccess = 2,
    FinalizedFailed = 3,
    PoolRejected = 4,
}

/// Product-independent byte transform selected by one signing intent.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkSigningTransform {
    Raw = 1,
    SubstrateSigningPayload = 2,
    Blake2Domain = 3,
}

/// Optional external signer transport. Additional transports can be added without defining app
/// action semantics; QR_V1's `action` remains an opaque caller-owned u16 value.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkExternalSignerTransport {
    None = 0,
    QrV1 = 1,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkSigningOutcomeStatus {
    Completed = 1,
    ExternalPending = 2,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkWalletWordCount {
    Words12 = 12,
    Words18 = 18,
    Words24 = 24,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkWalletOrigin {
    Created = 1,
    Imported = 2,
}

/// 账户签名由本机热钱包完成，或交给独立冷钱包二维码流程完成。
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkWalletSignMode {
    Hot = 1,
    Cold = 2,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkTransactionHistoryStatus {
    Pending = 1,
    InBlock = 2,
    PoolRejected = 3,
    FinalizedSuccess = 4,
    FinalizedFailed = 5,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkWatchStatus {
    Ready = 1,
    Broadcast = 2,
    Future = 3,
    InBlock = 4,
    Finalized = 5,
    Retracted = 6,
    FinalityTimeout = 7,
    Dropped = 8,
    Invalid = 9,
    Usurped = 10,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CitizenSdkExecutionStatus {
    Success = 1,
    Failed = 2,
    Unverified = 3,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkBytesView {
    pub data: *const u8,
    pub len: u64,
}

/// Portable C representation of one unsigned 128-bit CitizenChain amount.
/// Its numeric value is `high * 2^64 + low`; it is not host-endian byte text.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CitizenSdkU128 {
    pub low: u64,
    pub high: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct CitizenSdkAccountId {
    pub bytes: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct CitizenSdkCreateOptions {
    pub struct_size: u32,
    pub abi_version: u32,
    pub asset_manifest: CitizenSdkBytesView,
    pub chain_spec: CitizenSdkBytesView,
    pub light_sync_state: CitizenSdkBytesView,
    pub system_name: CitizenSdkBytesView,
    pub system_version: CitizenSdkBytesView,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkBlockRef {
    pub struct_size: u32,
    pub abi_version: u32,
    pub hash: [u8; 32],
    pub number: u64,
    pub finality: u32,
    pub reserved: u32,
}

impl Default for CitizenSdkBlockRef {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            hash: [0; 32],
            number: 0,
            finality: 0,
            reserved: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CitizenSdkCapabilityStatus {
    pub name: u32,
    pub reason: u32,
    pub supported: u8,
    pub available: u8,
    pub enabled: u8,
    pub ready: u8,
    pub reserved: [u8; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkCapabilitySnapshot {
    pub struct_size: u32,
    pub abi_version: u32,
    pub revision: u64,
    pub count: u32,
    pub reserved: u32,
    pub statuses: [CitizenSdkCapabilityStatus; CITIZENSDK_CAPABILITY_COUNT],
}

impl Default for CitizenSdkCapabilitySnapshot {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            revision: 0,
            count: CITIZENSDK_CAPABILITY_COUNT as u32,
            reserved: 0,
            statuses: [CitizenSdkCapabilityStatus::default(); CITIZENSDK_CAPABILITY_COUNT],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkEvent {
    pub struct_size: u32,
    pub abi_version: u32,
    pub event_type: u32,
    pub reserved: u32,
    pub sequence: u64,
    pub request_id: CitizenSdkRequestId,
    pub result: CitizenSdkResultHandle,
    pub capability_revision: u64,
}

pub type CitizenSdkEventCallback =
    Option<unsafe extern "C" fn(context: *mut c_void, event: *const CitizenSdkEvent)>;

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkResultInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub error_code: i32,
    pub kind: u32,
    pub payload_len: u64,
    pub error_message_len: u64,
}

impl Default for CitizenSdkResultInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            error_code: CitizenSdkErrorCode::Ok.as_i32(),
            kind: CitizenSdkResultKind::Empty as u32,
            payload_len: 0,
            error_message_len: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkRuntimeContextInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub block: CitizenSdkBlockRef,
    pub spec_version: u32,
    pub transaction_version: u32,
    pub metadata_len: u64,
}

/// One coherent light-node status snapshot. `is_usable` is provider-owned and must not be
/// recomputed by a platform binding or product application.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkChainSyncStatusInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub peer_count: u64,
    pub is_syncing: u8,
    pub is_usable: u8,
    pub reserved: [u8; 6],
    pub best: CitizenSdkBlockRef,
    pub finalized: CitizenSdkBlockRef,
}

impl Default for CitizenSdkChainSyncStatusInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            peer_count: 0,
            is_syncing: 0,
            is_usable: 0,
            reserved: [0; 6],
            best: CitizenSdkBlockRef::default(),
            finalized: CitizenSdkBlockRef::default(),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkBlockHeaderInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub block: CitizenSdkBlockRef,
    pub parent_hash: [u8; 32],
    pub state_root: [u8; 32],
    pub extrinsics_root: [u8; 32],
    pub digest_len: u64,
}

impl Default for CitizenSdkBlockHeaderInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            block: CitizenSdkBlockRef::default(),
            parent_hash: [0; 32],
            state_root: [0; 32],
            extrinsics_root: [0; 32],
            digest_len: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkBlockBodyInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub block: CitizenSdkBlockRef,
    pub extrinsic_count: u32,
    pub reserved: u32,
    pub total_bytes: u64,
}

impl Default for CitizenSdkBlockBodyInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            block: CitizenSdkBlockRef::default(),
            extrinsic_count: 0,
            reserved: 0,
            total_bytes: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWatchEventInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: u32,
    pub peer_count: u32,
    pub has_block: u8,
    pub has_replacement_hash: u8,
    pub reserved: [u8; 6],
    pub block: CitizenSdkBlockRef,
    pub replacement_hash: [u8; 32],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkExecutionInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: u32,
    pub reason_or_dispatch_variant: u32,
    pub has_block: u8,
    pub has_extrinsic_index: u8,
    pub has_module: u8,
    pub reserved: [u8; 5],
    pub block: CitizenSdkBlockRef,
    pub extrinsic_index: u32,
    pub pallet_index: u8,
    pub error_index: u8,
    pub reserved_tail: [u8; 2],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkExportedStateInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub format_version: u32,
    pub reserved: u32,
    pub finalized: CitizenSdkBlockRef,
    pub database_len: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkAccountBalanceInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub block: CitizenSdkBlockRef,
    pub account_id: CitizenSdkAccountId,
    pub free_fen: CitizenSdkU128,
    pub reserved_fen: CitizenSdkU128,
    pub total_fen: CitizenSdkU128,
}

impl Default for CitizenSdkAccountBalanceInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            block: CitizenSdkBlockRef::default(),
            account_id: CitizenSdkAccountId::default(),
            free_fen: CitizenSdkU128::default(),
            reserved_fen: CitizenSdkU128::default(),
            total_fen: CitizenSdkU128::default(),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkAccountNonceInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub best_block: CitizenSdkBlockRef,
    pub account_id: CitizenSdkAccountId,
    pub nonce: u64,
}

impl Default for CitizenSdkAccountNonceInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            best_block: CitizenSdkBlockRef::default(),
            account_id: CitizenSdkAccountId::default(),
            nonce: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkFeeSnapshotInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub best_block: CitizenSdkBlockRef,
    pub fee_rate_parts: u32,
    pub reserved: u32,
    pub minimum_fee_fen: CitizenSdkU128,
    pub existential_deposit_fen: CitizenSdkU128,
}

impl Default for CitizenSdkFeeSnapshotInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            best_block: CitizenSdkBlockRef::default(),
            fee_rate_parts: 0,
            reserved: 0,
            minimum_fee_fen: CitizenSdkU128::default(),
            existential_deposit_fen: CitizenSdkU128::default(),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWalletProfileInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub present: u32,
    pub origin: u32,
    pub wallet_index: u32,
    pub account_count: u32,
    pub created_at_millis: u64,
    pub master_account_id: CitizenSdkAccountId,
    pub active_account_id: CitizenSdkAccountId,
}

impl Default for CitizenSdkWalletProfileInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            present: 0,
            origin: 0,
            wallet_index: 0,
            account_count: 0,
            created_at_millis: 0,
            master_account_id: CitizenSdkAccountId::default(),
            active_account_id: CitizenSdkAccountId::default(),
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWalletAccountInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub index: u32,
    pub is_active: u32,
    pub account_id: CitizenSdkAccountId,
    pub created_at_millis: u64,
    pub ss58_address_len: u64,
    pub name_len: u64,
}

impl Default for CitizenSdkWalletAccountInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            index: 0,
            is_active: 0,
            account_id: CitizenSdkAccountId::default(),
            created_at_millis: 0,
            ss58_address_len: 0,
            name_len: 0,
        }
    }
}

/// 无UI输入校验的固定事实；未知词位置为零起始，其它原因用u32::MAX。
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWalletInputValidationV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub reason: u32,
    pub position: u32,
}

impl Default for CitizenSdkWalletInputValidationV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            reason: 6,
            position: u32::MAX,
        }
    }
}

/// 统一热／冷钱包目录的固定部分；第一项（若存在）是只读默认账户。
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWalletStateInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub revision: u64,
    pub account_count: u32,
    pub has_default_account: u32,
    pub default_account_id: CitizenSdkAccountId,
}

impl Default for CitizenSdkWalletStateInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            revision: 0,
            account_count: 0,
            has_default_account: 0,
            default_account_id: CitizenSdkAccountId::default(),
        }
    }
}

/// 同次快照中的异常记录事实；不是可签名账户，不暴露秘密引用或代际。
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWalletDiagnosticInfoV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub wallet_index: u32,
    pub diagnostic_reason: u32,
    pub has_ss58_address: u32,
    pub sign_mode: u32,
    pub account_id: CitizenSdkAccountId,
    pub wallet_name_len: u64,
    pub ss58_address_len: u64,
    pub cleanup_account_count: u32,
    pub delete_wallet_wide_key: u32,
}

impl Default for CitizenSdkWalletDiagnosticInfoV1 {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            wallet_index: 0,
            diagnostic_reason: 0,
            has_ss58_address: 0,
            sign_mode: 0,
            account_id: CitizenSdkAccountId::default(),
            wallet_name_len: 0,
            ss58_address_len: 0,
            cleanup_account_count: 0,
            delete_wallet_wide_key: 0,
        }
    }
}

/// 统一目录中的一个公开账户。冷账户没有派生 index，使用 `has_account_index=0`。
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkWalletStateAccountInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub sign_mode: u32,
    pub wallet_index: u32,
    pub has_account_index: u32,
    pub account_index: u32,
    pub is_default: u32,
    pub reserved: u32,
    pub account_id: CitizenSdkAccountId,
    pub created_at_millis: u64,
    pub ss58_address_len: u64,
    pub name_len: u64,
}

/// Fixed part of a generic signing result. Variable bytes are copied atomically by the dedicated
/// result getter; a completed result has 64 signature bytes and no session/request text.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkSigningOutcomeInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: u32,
    pub transport: u32,
    pub account_id: CitizenSdkAccountId,
    pub payload_hash: [u8; 32],
    pub expires_at: u64,
    pub signature_len: u64,
    pub session_id_len: u64,
    pub transport_request_len: u64,
}

impl Default for CitizenSdkSigningOutcomeInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            status: 0,
            transport: 0,
            account_id: CitizenSdkAccountId::default(),
            payload_hash: [0; 32],
            expires_at: 0,
            signature_len: 0,
            session_id_len: 0,
            transport_request_len: 0,
        }
    }
}

/// Default-account mutation result. A completed result exposes only the committed revision;
/// callers refresh the normal WalletState projection. A pending result carries one external
/// request and never exposes a raw setter or an unverified authorization token.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkDefaultAccountChangeInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: u32,
    pub transport: u32,
    pub current_default_account_id: CitizenSdkAccountId,
    pub payload_hash: [u8; 32],
    pub expires_at: u64,
    pub committed_revision: u64,
    pub session_id_len: u64,
    pub transport_request_len: u64,
}

impl Default for CitizenSdkDefaultAccountChangeInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            status: 0,
            transport: 0,
            current_default_account_id: CitizenSdkAccountId::default(),
            payload_hash: [0; 32],
            expires_at: 0,
            committed_revision: 0,
            session_id_len: 0,
            transport_request_len: 0,
        }
    }
}

impl Default for CitizenSdkWalletStateAccountInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            sign_mode: 0,
            wallet_index: 0,
            has_account_index: 0,
            account_index: 0,
            is_default: 0,
            reserved: 0,
            account_id: CitizenSdkAccountId::default(),
            created_at_millis: 0,
            ss58_address_len: 0,
            name_len: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkPreparedWalletInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub prepared_wallet: CitizenSdkPreparedWalletHandle,
}

impl Default for CitizenSdkPreparedWalletInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            prepared_wallet: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkPreparedTransactionInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub prepared_transaction: CitizenSdkPreparedTransactionHandle,
    pub preparation_id: [u8; 16],
    pub source_account_id: CitizenSdkAccountId,
    pub call_data_hash: [u8; 32],
    pub best_block: CitizenSdkBlockRef,
    pub runtime_spec_number: u32,
    pub transaction_format_number: u32,
    pub nonce: u64,
}

/// Safe projection of either an external QR_V1 request or one accurately verified terminal.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkTransactionExecutionInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub status: u32,
    pub transport: u32,
    pub execution_id: [u8; 16],
    pub source_account_id: CitizenSdkAccountId,
    pub call_data_hash: [u8; 32],
    pub transaction_hash: [u8; 32],
    pub expires_at: u64,
    pub has_block: u32,
    pub has_extrinsic_index: u32,
    pub has_dispatch_failure: u32,
    pub has_module_failure: u32,
    pub has_replacement_hash: u32,
    pub dispatch_variant: u32,
    pub pallet_index: u32,
    pub error_index: u32,
    pub block: CitizenSdkBlockRef,
    pub extrinsic_index: u32,
    pub replacement_hash: [u8; 32],
    pub session_id_len: u64,
    pub transport_request_len: u64,
    pub pool_rejection_reason_len: u64,
}

impl Default for CitizenSdkTransactionExecutionInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            status: 0,
            transport: 0,
            execution_id: [0; 16],
            source_account_id: CitizenSdkAccountId::default(),
            call_data_hash: [0; 32],
            transaction_hash: [0; 32],
            expires_at: 0,
            has_block: 0,
            has_extrinsic_index: 0,
            has_dispatch_failure: 0,
            has_module_failure: 0,
            has_replacement_hash: 0,
            dispatch_variant: 0,
            pallet_index: 0,
            error_index: 0,
            block: CitizenSdkBlockRef::default(),
            extrinsic_index: 0,
            replacement_hash: [0; 32],
            session_id_len: 0,
            transport_request_len: 0,
            pool_rejection_reason_len: 0,
        }
    }
}

impl Default for CitizenSdkPreparedTransactionInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            prepared_transaction: 0,
            preparation_id: [0; 16],
            source_account_id: CitizenSdkAccountId::default(),
            call_data_hash: [0; 32],
            best_block: CitizenSdkBlockRef::default(),
            runtime_spec_number: 0,
            transaction_format_number: 0,
            nonce: 0,
        }
    }
}

/// Header for one deterministic page of SDK-submitted generic transactions.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkTransactionHistoryPageInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub revision: u64,
    pub record_count: u32,
    pub has_next_before_execution_id: u32,
    pub next_before_execution_id: CitizenSdkTransactionExecutionId,
}

impl Default for CitizenSdkTransactionHistoryPageInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            revision: 0,
            record_count: 0,
            has_next_before_execution_id: 0,
            next_before_execution_id: CitizenSdkTransactionExecutionId { bytes: [0; 16] },
        }
    }
}

/// Safe whitelist projection of one durable generic transaction execution.
/// Opaque call bytes, signed extrinsic bytes, nonce and signer material never
/// cross the public ABI.
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CitizenSdkTransactionHistoryRecordInfo {
    pub struct_size: u32,
    pub abi_version: u32,
    pub execution_id: CitizenSdkTransactionExecutionId,
    pub source_account_id: CitizenSdkAccountId,
    pub call_data_hash: [u8; 32],
    pub transaction_hash: [u8; 32],
    pub status: u32,
    pub has_block: u32,
    pub block: CitizenSdkBlockRef,
    pub has_execution: u32,
    pub has_replacement_hash: u32,
    pub execution: CitizenSdkExecutionInfo,
    pub replacement_hash: [u8; 32],
    pub created_at_millis: u64,
    pub updated_at_millis: u64,
    pub pool_rejection_reason_len: u64,
}

impl Default for CitizenSdkTransactionHistoryRecordInfo {
    fn default() -> Self {
        Self {
            struct_size: std::mem::size_of::<Self>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            execution_id: CitizenSdkTransactionExecutionId { bytes: [0; 16] },
            source_account_id: CitizenSdkAccountId::default(),
            call_data_hash: [0; 32],
            transaction_hash: [0; 32],
            status: 0,
            has_block: 0,
            block: CitizenSdkBlockRef::default(),
            has_execution: 0,
            has_replacement_hash: 0,
            execution: CitizenSdkExecutionInfo {
                struct_size: std::mem::size_of::<CitizenSdkExecutionInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                status: 0,
                reason_or_dispatch_variant: 0,
                has_block: 0,
                has_extrinsic_index: 0,
                has_module: 0,
                reserved: [0; 5],
                block: CitizenSdkBlockRef::default(),
                extrinsic_index: 0,
                pallet_index: 0,
                error_index: 0,
                reserved_tail: [0; 2],
            },
            replacement_hash: [0; 32],
            created_at_millis: 0,
            updated_at_millis: 0,
            pool_rejection_reason_len: 0,
        }
    }
}
