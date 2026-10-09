//! 五个互不替代的类型化数据存储合同。
//!
//! `SecretVault` 是第六个安全边界，但它负责硬件保护与解锁，不属于普通数据仓储。

mod chain_database;
mod encrypted_secret_blob;
mod runtime_cache;
mod transaction_history;
mod wallet_profile;

pub use chain_database::{ChainDatabaseSnapshot, ChainDatabaseStore};
pub use encrypted_secret_blob::{
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretBlobStore,
};
pub use runtime_cache::{
    RuntimeCacheStore, MAX_PERSISTED_RUNTIME_CONTEXTS, MAX_PERSISTED_RUNTIME_METADATA_BYTES,
};
pub use transaction_history::{
    HistoryTransactionStatus, TransactionExecutionRecord, TransactionHistoryCursor,
    TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryPage,
    TransactionHistoryQueryKind, TransactionHistoryRecord, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore,
    MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES, MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    MAX_TRANSACTION_HISTORY_RECORDS, MAX_TRANSACTION_HISTORY_SYNC_BATCH,
    MAX_TRANSACTION_POOL_REASON_BYTES,
};
pub use wallet_profile::WalletProfileStore;
