//! 五个互不替代的类型化数据存储合同。
//!
//! `SecretVault` 是第六个安全边界，但它负责硬件保护与解锁，不属于普通数据仓储。


pub use crate::store_chain_database::{ChainDatabaseSnapshot, ChainDatabaseStore};
pub use crate::store_encrypted_secret_blob::{
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretBlobStore,
};
pub use crate::store_runtime_cache::{
    RuntimeCacheStore, MAX_PERSISTED_RUNTIME_CONTEXTS, MAX_PERSISTED_RUNTIME_METADATA_BYTES,
};
pub use crate::store_transaction_history::{
    HistoryTransactionStatus, TransactionExecutionRecord, TransactionHistoryCursor,
    TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryPage,
    TransactionHistoryQueryKind, TransactionHistoryRecord, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore,
    MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES, MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    MAX_TRANSACTION_HISTORY_RECORDS, MAX_TRANSACTION_HISTORY_SYNC_BATCH,
    MAX_TRANSACTION_POOL_REASON_BYTES,
};
pub use crate::store_wallet_profile::WalletProfileStore;
