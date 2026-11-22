//! 定义Engine与链客户端、签名器、金库和持久化之间的类型化合同。

#![forbid(unsafe_code)]

use std::future::Future;
use std::pin::Pin;

use futures_core::Stream;

mod account;
mod capability;
mod chain;
mod error;
mod secret_vault;
mod signing;
mod store_encrypted_secret_blob;
mod store_transaction_history;
mod transaction;
mod transaction_build;
mod transaction_prepare;
mod wallet;

pub use account::AccountNonce;
pub use account::AccountNonceSource;
pub use account::FinalizedAccountBalance;
pub use account::OnchainFeePolicy;
pub use account::PERBILL_DENOMINATOR;
pub use capability::CapabilityName;
pub use capability::CapabilityReason;
pub use capability::CapabilitySnapshot;
pub use capability::CapabilityStatus;
pub use capability::Modules;
pub use chain::validated_finalized_block_range_len;
pub use chain::AccountId32;
pub use chain::BlockFinality;
pub use chain::ChainIdentity;
pub use chain::ChainSyncStatus;
pub use chain::ExportedChainState;
pub use chain::FinalizedBlockRef;
pub use chain::Hash32;
pub use chain::RuntimeContext;
pub use chain::RuntimeVersion;
pub use chain::StateImportReceipt;
pub use chain::VerifiedBlockBody;
pub use chain::VerifiedBlockHeader;
pub use chain::VerifiedBlockRef;
pub use chain::VerifiedChainClient;
pub use chain::CITIZENCHAIN_CHAIN_ID;
pub use chain::CITIZENCHAIN_GENESIS_HASH;
pub use chain::CITIZENCHAIN_PROTOCOL_ID;
pub use chain::MAX_BLOCK_BODY_BYTES;
pub use chain::MAX_BLOCK_BODY_EXTRINSICS;
pub use chain::MAX_FINALIZED_BLOCKS_PER_BATCH;
pub use chain::MAX_HEADER_DIGEST_BYTES;
pub use chain::MAX_RUNTIME_API_ARGUMENT_BYTES;
pub use chain::MAX_RUNTIME_API_METHOD_BYTES;
pub use chain::MAX_RUNTIME_API_OUTPUT_BYTES;
pub use chain::MAX_RUNTIME_METADATA_BYTES;
pub use chain::MAX_STORAGE_BATCH_KEYS;
pub use chain::MAX_STORAGE_BATCH_KEY_BYTES;
pub use chain::MAX_STORAGE_KEYS_PAGE_BYTES;
pub use chain::MAX_STORAGE_KEYS_PAGE_LIMIT;
pub use chain::MAX_STORAGE_KEY_BYTES;

pub use error::ContractError;
pub use error::ContractErrorCode;
pub use error::ContractResult;
pub use error::FailureStage;
pub use mldsa::AccountPublicKey;
pub use secret_vault::EncryptedSecretEnvelope;
pub use secret_vault::Hash32Bytes;
pub use secret_vault::SecretBuffer;
pub use secret_vault::SecretKind;
pub use secret_vault::SecretOwner;
pub use secret_vault::SecretRef;
pub use secret_vault::SecretVault;
pub use secret_vault::VaultAvailability;
pub use secret_vault::VaultGeneration;
pub use signing::blake2_256;
pub use signing::encode_signing_payload;
pub use signing::DefaultAccountChangeAuthorization;
pub use signing::DerivationJunction;
pub use signing::SigningCompletion;
pub use signing::SigningIntent;
pub use signing::SigningPayload;
pub use signing::SigningTransform;
pub use signing::Sr25519PublicKey;
pub use signing::DEFAULT_ACCOUNT_CHANGE_DOMAIN;
pub use signing::DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES;
pub use signing::DEFAULT_ACCOUNT_CHANGE_QR_ACTION;
pub use signing::MAX_DEFAULT_ACCOUNT_CHANGE_ACCOUNTS;
pub use signing::MAX_EXTERNAL_SIGNING_TTL_SECONDS;
pub use signing::MAX_SIGNING_DOMAIN_BYTES;
pub use signing::MAX_SIGNING_PAYLOAD_BYTES;
pub use signing::SR25519_SIGNING_CONTEXT;
pub use signing::{apply_signing_transform, signing_message_for_account};
pub use signing::{AccountSignature, Sr25519Signature};
pub use transaction::DispatchFailure;
pub use transaction::ExecutionConclusion;
pub use transaction::ExtrinsicWatchEvent;
pub use transaction::ModuleDispatchFailure;
pub use transaction::SignedExtrinsic;
pub use transaction::SubmittedExtrinsic;
pub use transaction::UnverifiedReason;
pub use transaction_build::ImmortalSigningPayload;
pub use transaction_build::SignedTransactionBuild;
pub use transaction_build::IMMORTAL_ERA;
pub use transaction_prepare::OpaqueTransactionCall;
pub use transaction_prepare::PreparedTransactionSummary;
pub use transaction_prepare::TransactionExecutionCompleted;
pub use transaction_prepare::TransactionExecutionId;
pub use transaction_prepare::TransactionExecutionResolution;
pub use transaction_prepare::TransactionPreparationId;
pub use transaction_prepare::MAX_PREPARED_TRANSACTIONS;
pub use transaction_prepare::MAX_TRANSACTION_CALL_DATA_BYTES;
pub use transaction_prepare::MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES;
pub use wallet::citizen_ss58_address;
pub use wallet::parse_citizen_ss58_address;
pub use wallet::ColdWalletAccount;
pub use wallet::WalletAccount;
pub use wallet::WalletCleanupPlan;
pub use wallet::WalletDiagnosticReason;
pub use wallet::WalletOrigin;
pub use wallet::WalletProfile;
pub use wallet::WalletProvisioningPlan;
pub use wallet::WalletRecord;
pub use wallet::WalletRecordAccount;
pub use wallet::WalletSignMode;
pub use wallet::WalletState;
pub use wallet::CITIZEN_SS58_PREFIX;
pub use wallet::CITIZEN_WALLET_INDEX;
pub use wallet::FIRST_COLD_WALLET_INDEX;
pub use wallet::MAX_COLD_WALLET_ACCOUNTS;
pub use wallet::MAX_WALLET_ACCOUNTS;
pub use wallet::MAX_WALLET_ACCOUNT_INDEX;
pub use wallet::MAX_WALLET_ACCOUNT_NAME_SCALARS;

/// 对象安全合同使用的异步返回值；具体 executor 由调用者决定。
pub type ContractFuture<'a, T> = Pin<Box<dyn Future<Output = ContractResult<T>> + Send + 'a>>;

/// 对象安全合同使用的事件流；每个事件都可以独立报告 provider 错误。
pub type ContractStream<'a, T> = Pin<Box<dyn Stream<Item = ContractResult<T>> + Send + 'a>>;

pub use store_encrypted_secret_blob::{
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretBlobStore,
};

pub use store_transaction_history::{
    HistoryTransactionStatus, TransactionExecutionRecord, TransactionHistoryCursor,
    TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryPage,
    TransactionHistoryQueryKind, TransactionHistoryRecord, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore,
    MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES, MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    MAX_TRANSACTION_HISTORY_RECORDS, MAX_TRANSACTION_HISTORY_SYNC_BATCH,
    MAX_TRANSACTION_POOL_REASON_BYTES,
};

/// 带 CAS revision 的轻节点数据库快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainDatabaseSnapshot {
    revision: u64,
    state: Option<ExportedChainState>,
}

impl ChainDatabaseSnapshot {
    pub const fn new(revision: u64, state: Option<ExportedChainState>) -> Self {
        Self { revision, state }
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn state(&self) -> Option<&ExportedChainState> {
        self.state.as_ref()
    }
}

/// 只保存公开轻节点数据库。钱包资料、历史、密文和明文秘密均不得进入本合同。
pub trait ChainDatabaseStore: Send + Sync {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot>;

    /// 以 revision 原子提交；实现必须处理“写已落盘后抛错”的回读收敛。
    fn compare_and_swap(
        &self,
        expected_revision: u64,
        state: Option<ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot>;
}

/// 跨平台宿主最多持久化 64 个准确块的 runtime context。
///
/// 这是可重建性能缓存的资源上限，不限制 Core 当前内存可使用的 runtime metadata。
pub const MAX_PERSISTED_RUNTIME_CONTEXTS: usize = 64;

/// 单条持久 runtime cache 记录允许承载的 metadata 字节数。
///
/// 四个平台把完整 host record 限制为 8 MiB；扣除 56-byte host envelope 与
/// 55-byte typed runtime context 字段后，剩余字节才能用于 metadata。更大的、但仍符合
/// [`crate::types::MAX_RUNTIME_METADATA_BYTES`] 的 metadata 可以在 Core 内存中使用，不进入持久缓存。
pub const MAX_PERSISTED_RUNTIME_METADATA_BYTES: usize = (8 * 1024 * 1024) - 56 - 55;

/// Runtime cache 只能按准确块哈希命中，不能只按 specVersion 猜测块身份。
pub trait RuntimeCacheStore: Send + Sync {
    fn load(&self, block_hash: Hash32) -> ContractFuture<'_, Option<RuntimeContext>>;

    /// 写入的 context 自带同块 runtime version、transaction version 与 metadata。
    ///
    /// 实现必须把插入/替换和 FIFO 淘汰放在同一事务中，提交后至多保留
    /// [`MAX_PERSISTED_RUNTIME_CONTEXTS`] 条；相同 block hash 的替换只占一条。
    fn store(&self, context: RuntimeContext) -> ContractFuture<'_, ()>;

    fn delete(&self, block_hash: Hash32) -> ContractFuture<'_, ()>;
}

/// 只保存 `WalletState`。冷账户没有秘密引用；助记词、母种子、mini-secret、私钥和签名
/// 均不属于该类型。宿主必须把完整状态作为一个 CAS 单元，不能把账户顺序另存为影子真源。
pub trait WalletProfileStore: Send + Sync {
    fn load(&self) -> ContractFuture<'_, WalletState>;

    /// `next.revision` 必须等于 `expected_revision + 1`，并以底层原子 CAS 提交。
    /// 写后异常必须完整回读：等于候选状态才收敛为成功，否则报告冲突/存储错误。
    fn compare_and_swap(
        &self,
        expected_revision: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState>;
}

pub(crate) use account::{blake2b, require_citizenchain_identity};
