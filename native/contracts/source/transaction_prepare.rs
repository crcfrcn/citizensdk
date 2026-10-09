//! Product-independent transaction preparation contracts.
//!
//! Applications own the meaning and SCALE encoding of every opaque RuntimeCall. This module
//! only bounds those bytes and exposes a non-sensitive summary of one Engine-owned preparation;
//! signer messages, signatures and extrinsic templates never cross the public contract.

use crate::{
    blake2_256, AccountId32, ContractError, ContractErrorCode, ContractResult, ExecutionConclusion,
    Hash32, RuntimeVersion, VerifiedBlockRef,
};

/// Maximum opaque RuntimeCall accepted by every CitizenSDK binding.
pub const MAX_TRANSACTION_CALL_DATA_BYTES: usize = 1024 * 1024;
/// Maximum live or in-flight preparations retained by one Engine instance.
pub const MAX_PREPARED_TRANSACTIONS: usize = 256;
/// A signed V4 extrinsic adds only bounded address/signature/extensions framing to callData.
pub const MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES: usize = MAX_TRANSACTION_CALL_DATA_BYTES + 512;

/// Unpredictable, instance-bound identity for one non-persistent preparation.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TransactionPreparationId([u8; 16]);

impl TransactionPreparationId {
    pub fn try_new(bytes: [u8; 16]) -> ContractResult<Self> {
        if bytes == [0; 16] {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "transaction preparation id 不能全零",
            ));
        }
        Ok(Self(bytes))
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    pub const fn into_bytes(self) -> [u8; 16] {
        self.0
    }
}

/// Unpredictable identity for one claimed transaction execution.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TransactionExecutionId([u8; 16]);

impl TransactionExecutionId {
    pub fn try_new(bytes: [u8; 16]) -> ContractResult<Self> {
        if bytes == [0; 16] {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "transaction execution id 不能全零",
            ));
        }
        Ok(Self(bytes))
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }

    pub const fn into_bytes(self) -> [u8; 16] {
        self.0
    }
}

/// The only externally observable terminal states of a submitted generic transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransactionExecutionResolution {
    Finalized(ExecutionConclusion),
    PoolRejected {
        reason: String,
        replacement_hash: Option<Hash32>,
    },
}

/// Safe terminal projection; signing material and the signed extrinsic stay inside Core/store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionExecutionCompleted {
    execution_id: TransactionExecutionId,
    source_account_id: AccountId32,
    call_data_hash: Hash32,
    transaction_hash: Hash32,
    resolution: TransactionExecutionResolution,
}

impl TransactionExecutionCompleted {
    pub fn new(
        execution_id: TransactionExecutionId,
        source_account_id: AccountId32,
        call_data_hash: Hash32,
        transaction_hash: Hash32,
        resolution: TransactionExecutionResolution,
    ) -> Self {
        Self {
            execution_id,
            source_account_id,
            call_data_hash,
            transaction_hash,
            resolution,
        }
    }

    pub const fn execution_id(&self) -> TransactionExecutionId {
        self.execution_id
    }
    pub const fn source_account_id(&self) -> AccountId32 {
        self.source_account_id
    }
    pub const fn call_data_hash(&self) -> Hash32 {
        self.call_data_hash
    }
    pub const fn transaction_hash(&self) -> Hash32 {
        self.transaction_hash
    }
    pub const fn resolution(&self) -> &TransactionExecutionResolution {
        &self.resolution
    }
}

/// Bounded opaque SCALE RuntimeCall supplied by an application.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpaqueTransactionCall(Vec<u8>);

impl OpaqueTransactionCall {
    pub fn try_new(call_data: Vec<u8>) -> ContractResult<Self> {
        if call_data.is_empty() || call_data.len() > MAX_TRANSACTION_CALL_DATA_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "transaction callData 必须包含 1..1MiB 字节",
            ));
        }
        Ok(Self(call_data))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }

    pub fn hash(&self) -> ContractResult<Hash32> {
        Ok(Hash32::from_bytes(blake2_256(&self.0)?))
    }
}

/// Public, non-sensitive facts for one Engine-owned transaction preparation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PreparedTransactionSummary {
    preparation_id: TransactionPreparationId,
    source_account_id: AccountId32,
    call_data_hash: Hash32,
    best_block: VerifiedBlockRef,
    runtime_version: RuntimeVersion,
    nonce: u64,
}

impl PreparedTransactionSummary {
    pub fn try_new(
        preparation_id: TransactionPreparationId,
        source_account_id: AccountId32,
        call_data_hash: Hash32,
        best_block: VerifiedBlockRef,
        runtime_version: RuntimeVersion,
        nonce: u64,
    ) -> ContractResult<Self> {
        if best_block.is_finalized() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "transaction preparation 必须绑定准确 best 块",
            ));
        }
        Ok(Self {
            preparation_id,
            source_account_id,
            call_data_hash,
            best_block,
            runtime_version,
            nonce,
        })
    }

    pub const fn preparation_id(self) -> TransactionPreparationId {
        self.preparation_id
    }

    pub const fn source_account_id(self) -> AccountId32 {
        self.source_account_id
    }

    pub const fn call_data_hash(self) -> Hash32 {
        self.call_data_hash
    }

    pub const fn best_block(self) -> VerifiedBlockRef {
        self.best_block
    }

    pub const fn runtime_version(self) -> RuntimeVersion {
        self.runtime_version
    }

    pub const fn nonce(self) -> u64 {
        self.nonce
    }
}
