//! CitizenSDK Core 的类型化依赖合同。
//!
//! 本 crate 不实现业务，只冻结 Engine 与轻节点、签名器、系统金库及各类持久化之间的
//! 语义边界。公开 trait 均为对象安全接口，不能把 Flutter、具体异步运行时或任意 RPC
//! 方法泄漏到 Core。

#![forbid(unsafe_code)]

use std::{future::Future, pin::Pin};

use futures_core::Stream;

pub mod account;
pub mod capability;
pub mod chain;
pub mod chain_signer;
pub mod error;
pub mod secret_vault;
pub mod signing;
pub mod store;
pub mod transaction;
pub mod transaction_build;
pub mod transaction_prepare;
pub mod wallet;

pub use account::{
    AccountNonce, AccountNonceSource, FinalizedAccountBalance, OnchainFeePolicy,
    PERBILL_DENOMINATOR,
};
pub use capability::{
    CapabilityName, CapabilityReason, CapabilitySnapshot, CapabilityStatus, Modules,
};
pub use chain::{
    validated_finalized_block_range_len, AccountId32, BlockFinality, ChainIdentity,
    ChainSyncStatus, ExportedChainState, FinalizedBlockRef, Hash32, RuntimeContext, RuntimeVersion,
    StateImportReceipt, VerifiedBlockBody, VerifiedBlockHeader, VerifiedBlockRef,
    VerifiedChainClient, CITIZENCHAIN_CHAIN_ID, CITIZENCHAIN_GENESIS_HASH,
    CITIZENCHAIN_PROTOCOL_ID, MAX_BLOCK_BODY_BYTES, MAX_BLOCK_BODY_EXTRINSICS,
    MAX_FINALIZED_BLOCKS_PER_BATCH, MAX_HEADER_DIGEST_BYTES, MAX_RUNTIME_API_ARGUMENT_BYTES,
    MAX_RUNTIME_API_METHOD_BYTES, MAX_RUNTIME_API_OUTPUT_BYTES, MAX_RUNTIME_METADATA_BYTES,
    MAX_STORAGE_BATCH_KEYS, MAX_STORAGE_BATCH_KEY_BYTES, MAX_STORAGE_KEYS_PAGE_BYTES,
    MAX_STORAGE_KEYS_PAGE_LIMIT, MAX_STORAGE_KEY_BYTES,
};
pub use chain_signer::{
    ChainSigner, DerivationJunction, Sr25519PublicKey, Sr25519Signature, SR25519_SIGNING_CONTEXT,
};
pub use error::{ContractError, ContractErrorCode, ContractResult, FailureStage};
pub use secret_vault::{
    EncryptedSecretEnvelope, Hash32Bytes, SecretBuffer, SecretKind, SecretOwner, SecretRef,
    SecretVault, VaultAvailability, VaultGeneration,
};
pub use signing::{
    encode_signing_payload, SigningPayload,
    apply_signing_transform, blake2_256, DefaultAccountChangeAuthorization, SigningCompletion,
    SigningIntent, SigningTransform, DEFAULT_ACCOUNT_CHANGE_DOMAIN,
    DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES, DEFAULT_ACCOUNT_CHANGE_QR_ACTION,
    MAX_DEFAULT_ACCOUNT_CHANGE_ACCOUNTS, MAX_EXTERNAL_SIGNING_TTL_SECONDS,
    MAX_SIGNING_DOMAIN_BYTES, MAX_SIGNING_PAYLOAD_BYTES,
};
pub use store::{
    ChainDatabaseSnapshot, ChainDatabaseStore, EncryptedSecretBlobSnapshot,
    EncryptedSecretBlobState, EncryptedSecretBlobStore, HistoryTransactionStatus,
    RuntimeCacheStore, TransactionExecutionRecord, TransactionHistoryCursor,
    TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryPage,
    TransactionHistoryQueryKind, TransactionHistoryRecord, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore, WalletProfileStore,
    MAX_PERSISTED_RUNTIME_CONTEXTS, MAX_PERSISTED_RUNTIME_METADATA_BYTES,
    MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES, MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    MAX_TRANSACTION_HISTORY_RECORDS, MAX_TRANSACTION_HISTORY_SYNC_BATCH,
    MAX_TRANSACTION_POOL_REASON_BYTES,
};
pub use transaction::{
    DispatchFailure, ExecutionConclusion, ExtrinsicWatchEvent, ModuleDispatchFailure,
    SignedExtrinsic, SubmittedExtrinsic, UnverifiedReason,
};
pub use transaction_build::{ImmortalSigningPayload, SignedTransactionBuild, IMMORTAL_ERA};
pub use transaction_prepare::{
    OpaqueTransactionCall, PreparedTransactionSummary, TransactionExecutionCompleted,
    TransactionExecutionId, TransactionExecutionResolution, TransactionPreparationId,
    MAX_PREPARED_TRANSACTIONS, MAX_TRANSACTION_CALL_DATA_BYTES,
    MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES,
};
pub use wallet::{
    citizen_ss58_address, parse_citizen_ss58_address, ColdWalletAccount, WalletAccount,
    WalletCleanupPlan, WalletOrigin, WalletProfile, WalletProvisioningPlan, WalletSignMode,
    WalletState, WalletRecord, WalletRecordAccount, WalletDiagnosticReason, CITIZEN_SS58_PREFIX, CITIZEN_WALLET_INDEX, FIRST_COLD_WALLET_INDEX,
    MAX_COLD_WALLET_ACCOUNTS, MAX_WALLET_ACCOUNT_INDEX, MAX_WALLET_ACCOUNT_NAME_SCALARS,
};

/// 对象安全合同使用的异步返回值；具体 executor 由调用者决定。
pub type ContractFuture<'a, T> = Pin<Box<dyn Future<Output = ContractResult<T>> + Send + 'a>>;

/// 对象安全合同使用的事件流；每个事件都可以独立报告 provider 错误。
pub type ContractStream<'a, T> = Pin<Box<dyn Stream<Item = ContractResult<T>> + Send + 'a>>;
