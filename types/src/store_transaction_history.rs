//! Product-independent durable transaction executions and public history views.
//!
//! Applications own destination, amount, remark, direction, pallet/event and
//! every other business projection. This store keeps only the exact opaque
//! authorization required to recover transactions submitted by CitizenSDK.

use std::collections::BTreeSet;

use crate::{
    AccountId32, ContractError, ContractErrorCode, ContractFuture, ContractResult,
    ExecutionConclusion, Hash32, RuntimeVersion, SignedExtrinsic, TransactionExecutionId,
    VerifiedBlockRef, MAX_TRANSACTION_CALL_DATA_BYTES, MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES,
};

pub const MAX_TRANSACTION_HISTORY_RECORDS: usize = 4096;
pub const MAX_TRANSACTION_HISTORY_PAGE_SIZE: usize = 100;
pub const MAX_TRANSACTION_HISTORY_SYNC_BATCH: usize = 32;
pub const MAX_TRANSACTION_POOL_REASON_BYTES: usize = 512;
/// 通用恢复材料与保守固定开销的总预算；低于 32 MiB host payload 并保留 1 MiB 余量。
pub const MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES: usize = 31 * 1024 * 1024;
/// 覆盖 execution 固定字段以及所有通用状态变体的保守逐条开销。
const TRANSACTION_HISTORY_RECORD_FIXED_WEIGHT_BYTES: usize = 1024;

/// Durable state of an SDK-submitted transaction. Inclusion is not success.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryTransactionStatus {
    Pending,
    InBlock {
        block: VerifiedBlockRef,
    },
    PoolRejected {
        reason: String,
        replacement_hash: Option<Hash32>,
    },
    /// Only a finalized, same-index System outcome is persistable.
    Execution(ExecutionConclusion),
}

impl HistoryTransactionStatus {
    pub fn try_pool_rejected(reason: impl Into<String>) -> ContractResult<Self> {
        Self::try_pool_rejected_with_replacement(reason, None)
    }

    pub fn try_pool_rejected_with_replacement(
        reason: impl Into<String>,
        replacement_hash: Option<Hash32>,
    ) -> ContractResult<Self> {
        let reason = reason.into();
        if reason.trim().is_empty() || reason.len() > MAX_TRANSACTION_POOL_REASON_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "交易池拒绝原因必须包含 1..512 个 UTF-8 字节",
            ));
        }
        Ok(Self::PoolRejected {
            reason,
            replacement_hash,
        })
    }

    pub fn pool_rejection_reason(&self) -> Option<&str> {
        match self {
            Self::PoolRejected { reason, .. } => Some(reason),
            _ => None,
        }
    }

    pub const fn replacement_hash(&self) -> Option<Hash32> {
        match self {
            Self::PoolRejected {
                replacement_hash, ..
            } => *replacement_hash,
            _ => None,
        }
    }

    pub const fn is_chain_terminal(&self) -> bool {
        match self {
            Self::Execution(ExecutionConclusion::Success { block, .. })
            | Self::Execution(ExecutionConclusion::Failed { block, .. }) => block.is_finalized(),
            _ => false,
        }
    }

    pub const fn is_retention_terminal(&self) -> bool {
        self.is_chain_terminal() || matches!(self, Self::PoolRejected { .. })
    }

    pub fn persisted_name(&self) -> Option<&'static str> {
        match self {
            Self::Pending => Some("pending"),
            Self::InBlock { .. } => Some("inBlock"),
            Self::PoolRejected { reason, .. } if !reason.trim().is_empty() => Some("poolRejected"),
            Self::Execution(ExecutionConclusion::Success { block, .. }) if block.is_finalized() => {
                Some("finalizedSuccess")
            }
            Self::Execution(ExecutionConclusion::Failed { block, .. }) if block.is_finalized() => {
                Some("finalizedFailed")
            }
            _ => None,
        }
    }

    /// Evidence can only strengthen. A pool rejection may later be superseded
    /// by an exact finalized execution discovered during reconciliation.
    pub fn allows_transition_to(&self, next: &Self) -> bool {
        if self == next {
            return true;
        }
        match (self, next) {
            (
                Self::Pending,
                Self::InBlock { .. } | Self::PoolRejected { .. } | Self::Execution(_),
            )
            | (
                Self::InBlock { .. },
                Self::InBlock { .. } | Self::PoolRejected { .. } | Self::Execution(_),
            )
            | (Self::PoolRejected { .. }, Self::Execution(_)) => true,
            (Self::Execution(_), _) => false,
            _ => false,
        }
    }
}

fn status_is_persistable(status: &HistoryTransactionStatus) -> bool {
    match status {
        HistoryTransactionStatus::Execution(ExecutionConclusion::Success { block, .. })
        | HistoryTransactionStatus::Execution(ExecutionConclusion::Failed { block, .. }) => {
            block.is_finalized()
        }
        HistoryTransactionStatus::Execution(ExecutionConclusion::Unverified { .. }) => false,
        HistoryTransactionStatus::PoolRejected { reason, .. } => {
            !reason.trim().is_empty() && reason.len() <= MAX_TRANSACTION_POOL_REASON_BYTES
        }
        _ => true,
    }
}

/// Complete durable authorization written before the provider is called.
///
/// `call_data` and `signed_extrinsic` are private recovery material. Public
/// history projection is an explicit field whitelist and never exposes them.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionExecutionRecord {
    execution_id: TransactionExecutionId,
    account_id: AccountId32,
    call_data_hash: Hash32,
    call_data: Vec<u8>,
    transaction_hash: Hash32,
    signed_extrinsic: SignedExtrinsic,
    block: VerifiedBlockRef,
    runtime_version: RuntimeVersion,
    genesis_hash: Hash32,
    nonce: u64,
    status: HistoryTransactionStatus,
    created_at_millis: u64,
    updated_at_millis: u64,
}

impl TransactionExecutionRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        execution_id: TransactionExecutionId,
        account_id: AccountId32,
        call_data_hash: Hash32,
        call_data: Vec<u8>,
        transaction_hash: Hash32,
        signed_extrinsic: SignedExtrinsic,
        block: VerifiedBlockRef,
        runtime_version: RuntimeVersion,
        genesis_hash: Hash32,
        nonce: u64,
        status: HistoryTransactionStatus,
        created_at_millis: u64,
        updated_at_millis: u64,
    ) -> ContractResult<Self> {
        if call_data.is_empty() || call_data.len() > MAX_TRANSACTION_CALL_DATA_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易恢复 callData 必须包含 1..1MiB 字节",
            ));
        }
        if Hash32::from_bytes(crate::blake2_256(&call_data)?) != call_data_hash {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "通用交易恢复 callData hash 不一致",
            ));
        }
        if signed_extrinsic.as_bytes().len() > MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易恢复 signed extrinsic 超过固定上限",
            ));
        }
        if updated_at_millis < created_at_millis || !status_is_persistable(&status) {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易恢复状态或时间无效",
            ));
        }
        Ok(Self {
            execution_id,
            account_id,
            call_data_hash,
            call_data,
            transaction_hash,
            signed_extrinsic,
            block,
            runtime_version,
            genesis_hash,
            nonce,
            status,
            created_at_millis,
            updated_at_millis,
        })
    }

    pub const fn execution_id(&self) -> TransactionExecutionId {
        self.execution_id
    }
    pub const fn account_id(&self) -> AccountId32 {
        self.account_id
    }
    pub const fn call_data_hash(&self) -> Hash32 {
        self.call_data_hash
    }
    pub fn call_data(&self) -> &[u8] {
        &self.call_data
    }
    pub const fn transaction_hash(&self) -> Hash32 {
        self.transaction_hash
    }
    pub const fn signed_extrinsic(&self) -> &SignedExtrinsic {
        &self.signed_extrinsic
    }
    pub const fn block(&self) -> VerifiedBlockRef {
        self.block
    }
    pub const fn runtime_version(&self) -> RuntimeVersion {
        self.runtime_version
    }
    pub const fn genesis_hash(&self) -> Hash32 {
        self.genesis_hash
    }
    pub const fn nonce(&self) -> u64 {
        self.nonce
    }
    pub const fn status(&self) -> &HistoryTransactionStatus {
        &self.status
    }
    pub const fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }
    pub const fn updated_at_millis(&self) -> u64 {
        self.updated_at_millis
    }

    /// 用于持久化 admission 的通用资源权重；不包含任何 App 业务分类。
    pub fn durable_weight_bytes(&self) -> usize {
        // try_new 已把两段变长输入限制在固定上限；最大总和远低于 32 位
        // usize，已构造记录的 getter 不再引入 panic 或重复的失败分支。
        TRANSACTION_HISTORY_RECORD_FIXED_WEIGHT_BYTES
            + self.call_data.len()
            + self.signed_extrinsic.as_bytes().len()
    }

    /// 在签名前用已经冻结的 extrinsic template 长度执行精确资源准入。
    pub fn try_durable_weight_for_lengths(
        call_data_bytes: usize,
        signed_extrinsic_bytes: usize,
    ) -> ContractResult<usize> {
        if !(1..=MAX_TRANSACTION_CALL_DATA_BYTES).contains(&call_data_bytes)
            || !(1..=MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES).contains(&signed_extrinsic_bytes)
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易恢复材料长度超出固定资源合同",
            ));
        }
        TRANSACTION_HISTORY_RECORD_FIXED_WEIGHT_BYTES
            .checked_add(call_data_bytes)
            .and_then(|weight| weight.checked_add(signed_extrinsic_bytes))
            .ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "通用交易恢复材料资源权重溢出",
                )
            })
    }

    pub fn require_same_submission_facts(&self, other: &Self) -> ContractResult<()> {
        if self.execution_id != other.execution_id
            || self.account_id != other.account_id
            || self.call_data_hash != other.call_data_hash
            || self.call_data != other.call_data
            || self.transaction_hash != other.transaction_hash
            || self.signed_extrinsic != other.signed_extrinsic
            || self.block != other.block
            || self.runtime_version != other.runtime_version
            || self.genesis_hash != other.genesis_hash
            || self.nonce != other.nonce
        {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "同一 executionId 的通用交易提交事实不一致",
            ));
        }
        Ok(())
    }

    pub fn try_with_status(
        &self,
        status: HistoryTransactionStatus,
        updated_at_millis: u64,
    ) -> ContractResult<Self> {
        if !self.status.allows_transition_to(&status) {
            return Err(ContractError::new(
                ContractErrorCode::InvalidState,
                "通用交易状态不能倒退或改写终态",
            ));
        }
        Self::try_new(
            self.execution_id,
            self.account_id,
            self.call_data_hash,
            self.call_data.clone(),
            self.transaction_hash,
            self.signed_extrinsic.clone(),
            self.block,
            self.runtime_version,
            self.genesis_hash,
            self.nonce,
            status,
            self.created_at_millis,
            updated_at_millis,
        )
    }
}

/// Safe public whitelist projection of one durable execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionHistoryRecord {
    execution_id: TransactionExecutionId,
    source_account_id: AccountId32,
    call_data_hash: Hash32,
    transaction_hash: Hash32,
    status: HistoryTransactionStatus,
    created_at_millis: u64,
    updated_at_millis: u64,
}

impl From<&TransactionExecutionRecord> for TransactionHistoryRecord {
    fn from(record: &TransactionExecutionRecord) -> Self {
        Self {
            execution_id: record.execution_id(),
            source_account_id: record.account_id(),
            call_data_hash: record.call_data_hash(),
            transaction_hash: record.transaction_hash(),
            status: record.status().clone(),
            created_at_millis: record.created_at_millis(),
            updated_at_millis: record.updated_at_millis(),
        }
    }
}

impl TransactionHistoryRecord {
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
    pub const fn status(&self) -> &HistoryTransactionStatus {
        &self.status
    }
    pub const fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }
    pub const fn updated_at_millis(&self) -> u64 {
        self.updated_at_millis
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionHistoryPage {
    revision: u64,
    records: Vec<TransactionHistoryRecord>,
    next_before_execution_id: Option<TransactionExecutionId>,
}

impl TransactionHistoryPage {
    pub fn new(
        revision: u64,
        records: Vec<TransactionHistoryRecord>,
        next_before_execution_id: Option<TransactionExecutionId>,
    ) -> Self {
        Self {
            revision,
            records,
            next_before_execution_id,
        }
    }
    pub const fn revision(&self) -> u64 {
        self.revision
    }
    pub fn records(&self) -> &[TransactionHistoryRecord] {
        &self.records
    }
    pub const fn next_before_execution_id(&self) -> Option<TransactionExecutionId> {
        self.next_before_execution_id
    }
}

/// O(1) aggregate facts for the execution-only store.
///
/// Hosts may index only these product-independent resource facts. Account IDs,
/// call data and signed extrinsics remain inside the opaque per-record value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransactionHistoryIndex {
    revision: u64,
    record_count: usize,
    durable_weight_bytes: usize,
    open_count: usize,
    open_weight_bytes: usize,
}

impl TransactionHistoryIndex {
    pub fn try_new(
        revision: u64,
        record_count: usize,
        durable_weight_bytes: usize,
        open_count: usize,
        open_weight_bytes: usize,
    ) -> ContractResult<Self> {
        if record_count > MAX_TRANSACTION_HISTORY_RECORDS {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史超过 4096 条固定上限",
            ));
        }
        if durable_weight_bytes > MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史超过 31 MiB 持久化资源预算",
            ));
        }
        if open_count > record_count || open_weight_bytes > durable_weight_bytes {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史 open 汇总超过总汇总",
            ));
        }
        Ok(Self {
            revision,
            record_count,
            durable_weight_bytes,
            open_count,
            open_weight_bytes,
        })
    }

    pub const fn empty() -> Self {
        Self {
            revision: 0,
            record_count: 0,
            durable_weight_bytes: 0,
            open_count: 0,
            open_weight_bytes: 0,
        }
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }
    pub const fn record_count(&self) -> usize {
        self.record_count
    }
    pub const fn durable_weight_bytes(&self) -> usize {
        self.durable_weight_bytes
    }
    pub const fn open_count(&self) -> usize {
        self.open_count
    }
    pub const fn open_weight_bytes(&self) -> usize {
        self.open_weight_bytes
    }
}

impl Default for TransactionHistoryIndex {
    fn default() -> Self {
        Self::empty()
    }
}

/// Stable record position. Ordering always includes the execution ID so equal
/// timestamps cannot duplicate or omit records between pages.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TransactionHistoryCursor {
    created_at_millis: u64,
    execution_id: TransactionExecutionId,
}

impl TransactionHistoryCursor {
    pub const fn new(created_at_millis: u64, execution_id: TransactionExecutionId) -> Self {
        Self {
            created_at_millis,
            execution_id,
        }
    }
    pub const fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }
    pub const fn execution_id(&self) -> TransactionExecutionId {
        self.execution_id
    }
}

/// Closed query vocabulary for generic history storage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionHistoryQueryKind {
    Newest,
    OldestRetentionTerminal,
    OldestReconcilable,
}

/// One revision-fenced record lookup.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionHistoryRecordSnapshot {
    index: TransactionHistoryIndex,
    record: Option<TransactionExecutionRecord>,
}

impl TransactionHistoryRecordSnapshot {
    pub const fn new(
        index: TransactionHistoryIndex,
        record: Option<TransactionExecutionRecord>,
    ) -> Self {
        Self { index, record }
    }
    pub const fn index(&self) -> TransactionHistoryIndex {
        self.index
    }
    pub const fn record(&self) -> Option<&TransactionExecutionRecord> {
        self.record.as_ref()
    }
    pub fn into_record(self) -> Option<TransactionExecutionRecord> {
        self.record
    }
}

/// At most one public page of records from one exact store revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionHistoryRecordBatch {
    index: TransactionHistoryIndex,
    records: Vec<TransactionExecutionRecord>,
    has_more: bool,
}

impl TransactionHistoryRecordBatch {
    pub fn try_new(
        index: TransactionHistoryIndex,
        records: Vec<TransactionExecutionRecord>,
        has_more: bool,
    ) -> ContractResult<Self> {
        if records.len() > MAX_TRANSACTION_HISTORY_PAGE_SIZE
            || records.len() > index.record_count()
            || (records.is_empty() && has_more)
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史查询批次无效",
            ));
        }
        let ids = records
            .iter()
            .map(TransactionExecutionRecord::execution_id)
            .collect::<BTreeSet<_>>();
        if ids.len() != records.len() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史查询批次包含重复 executionId",
            ));
        }
        Ok(Self {
            index,
            records,
            has_more,
        })
    }
    pub const fn index(&self) -> TransactionHistoryIndex {
        self.index
    }
    pub fn records(&self) -> &[TransactionExecutionRecord] {
        &self.records
    }
    pub const fn has_more(&self) -> bool {
        self.has_more
    }
}

/// One atomic revision transition. Deletes and upserts become visible with the
/// next aggregate index or none of them do.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionHistoryMutation {
    expected_revision: u64,
    next_index: TransactionHistoryIndex,
    deletes: Vec<TransactionExecutionId>,
    upserts: Vec<TransactionExecutionRecord>,
}

impl TransactionHistoryMutation {
    pub fn try_new(
        expected_revision: u64,
        next_index: TransactionHistoryIndex,
        deletes: Vec<TransactionExecutionId>,
        upserts: Vec<TransactionExecutionRecord>,
    ) -> ContractResult<Self> {
        if next_index.revision()
            != expected_revision.checked_add(1).ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::InvalidState,
                    "通用交易历史 revision 已耗尽",
                )
            })?
            || deletes.len() > MAX_TRANSACTION_HISTORY_RECORDS
            || upserts.len() > MAX_TRANSACTION_HISTORY_PAGE_SIZE
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史 mutation 形状无效",
            ));
        }
        let delete_ids = deletes.iter().copied().collect::<BTreeSet<_>>();
        let upsert_ids = upserts
            .iter()
            .map(TransactionExecutionRecord::execution_id)
            .collect::<BTreeSet<_>>();
        if delete_ids.len() != deletes.len()
            || upsert_ids.len() != upserts.len()
            || !delete_ids.is_disjoint(&upsert_ids)
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "通用交易历史 mutation executionId 重复或冲突",
            ));
        }
        Ok(Self {
            expected_revision,
            next_index,
            deletes,
            upserts,
        })
    }
    pub const fn expected_revision(&self) -> u64 {
        self.expected_revision
    }
    pub const fn next_index(&self) -> TransactionHistoryIndex {
        self.next_index
    }
    pub fn deletes(&self) -> &[TransactionExecutionId] {
        &self.deletes
    }
    pub fn upserts(&self) -> &[TransactionExecutionRecord] {
        &self.upserts
    }
}

pub trait TransactionHistoryStore: Send + Sync {
    fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex>;

    fn load_record(
        &self,
        expected_revision: u64,
        execution_id: TransactionExecutionId,
    ) -> ContractFuture<'_, TransactionHistoryRecordSnapshot>;

    fn load_page(
        &self,
        expected_revision: u64,
        kind: TransactionHistoryQueryKind,
        before: Option<TransactionHistoryCursor>,
        limit: usize,
    ) -> ContractFuture<'_, TransactionHistoryRecordBatch>;

    fn compare_and_swap(
        &self,
        mutation: TransactionHistoryMutation,
    ) -> ContractFuture<'_, TransactionHistoryIndex>;
}
