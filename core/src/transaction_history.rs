//! Product-independent transaction execution history.
//!
//! The store is indexed by generic execution facts. Core never loads or
//! rewrites the complete history value: public pages are limit-bounded, status
//! updates touch one record, and recovery reads only reconcilable records.

use std::sync::{Arc, OnceLock};

use citizen_sdk_contracts::{
    store::{
        HistoryTransactionStatus, TransactionExecutionRecord, TransactionHistoryCursor,
        TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryPage,
        TransactionHistoryQueryKind, TransactionHistoryRecord, TransactionHistoryRecordBatch,
        TransactionHistoryStore,
    },
    AccountId32, ContractErrorCode, Hash32, RuntimeVersion, SignedExtrinsic,
    TransactionExecutionId, VerifiedBlockRef, MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES,
    MAX_TRANSACTION_HISTORY_PAGE_SIZE, MAX_TRANSACTION_HISTORY_RECORDS,
};
use futures::lock::Mutex as AsyncMutex;

use crate::{error::EngineError, wallet_service::WalletClock};

const MAX_HISTORY_CAS_ATTEMPTS: usize = 8;
static HISTORY_MUTATION_GATE: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn history_mutation_gate() -> &'static AsyncMutex<()> {
    HISTORY_MUTATION_GATE.get_or_init(|| AsyncMutex::new(()))
}

#[derive(Clone)]
pub struct TransactionHistoryService {
    store: Arc<dyn TransactionHistoryStore>,
    clock: Arc<dyn WalletClock>,
}

impl TransactionHistoryService {
    pub fn new(store: Arc<dyn TransactionHistoryStore>, clock: Arc<dyn WalletClock>) -> Self {
        Self { store, clock }
    }

    /// Performs read-only admission before a hot-wallet unlock or cold QR
    /// session. The same checks are repeated under the mutation gate before a
    /// pending record is committed.
    pub(crate) async fn preflight_execution_before_signing(
        &self,
        account_id: AccountId32,
        call_data_bytes: usize,
        signed_extrinsic_bytes: usize,
    ) -> Result<(), EngineError> {
        let _guard = history_mutation_gate().lock().await;
        let index = self.index().await?;
        self.require_no_open_account_or_duplicate_hash(index, account_id, None)
            .await?;
        let candidate_weight = TransactionExecutionRecord::try_durable_weight_for_lengths(
            call_data_bytes,
            signed_extrinsic_bytes,
        )?;
        if index.open_count() >= MAX_TRANSACTION_HISTORY_RECORDS
            || index
                .open_weight_bytes()
                .checked_add(candidate_weight)
                .is_none_or(|weight| weight > MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES)
        {
            return Err(error(
                ContractErrorCode::Conflict,
                "transaction history 资源预算不足且 open record 不可驱逐",
            ));
        }
        Ok(())
    }

    /// Atomically persists exact recovery material before the provider is
    /// called. Open records are never evicted; only the oldest retention-
    /// terminal records are deleted in the same revision transition.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn record_execution_before_broadcast(
        &self,
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
    ) -> Result<TransactionHistoryIndex, EngineError> {
        let _guard = history_mutation_gate().lock().await;
        let now = self.clock.now_millis()?;
        let candidate = TransactionExecutionRecord::try_new(
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
            HistoryTransactionStatus::Pending,
            now,
            now,
        )?;

        for _ in 0..MAX_HISTORY_CAS_ATTEMPTS {
            let current = self.index().await?;
            if let Some(existing) = self.record_at(current, candidate.execution_id()).await? {
                existing.require_same_submission_facts(&candidate)?;
                return if matches!(existing.status(), HistoryTransactionStatus::Pending) {
                    Ok(current)
                } else {
                    Err(error(
                        ContractErrorCode::InvalidState,
                        "通用交易已离开 Pending",
                    ))
                };
            }
            self.require_no_open_account_or_duplicate_hash(
                current,
                account_id,
                Some(transaction_hash),
            )
            .await?;
            let deletes = self.make_room(current, &candidate).await?;
            let removed_weight = deletes.iter().try_fold(0_usize, |total, record| {
                total
                    .checked_add(record.durable_weight_bytes())
                    .ok_or_else(|| integrity("transaction history 驱逐资源权重溢出"))
            })?;
            let next_count = current
                .record_count()
                .checked_sub(deletes.len())
                .and_then(|count| count.checked_add(1))
                .ok_or_else(|| integrity("transaction history 记录数量溢出"))?;
            let next_weight = current
                .durable_weight_bytes()
                .checked_sub(removed_weight)
                .and_then(|weight| weight.checked_add(candidate.durable_weight_bytes()))
                .ok_or_else(|| integrity("transaction history 资源权重溢出"))?;
            let next_index = TransactionHistoryIndex::try_new(
                next_revision(current.revision())?,
                next_count,
                next_weight,
                current
                    .open_count()
                    .checked_add(1)
                    .ok_or_else(|| integrity("transaction history open 数量溢出"))?,
                current
                    .open_weight_bytes()
                    .checked_add(candidate.durable_weight_bytes())
                    .ok_or_else(|| integrity("transaction history open 权重溢出"))?,
            )?;
            let mutation = TransactionHistoryMutation::try_new(
                current.revision(),
                next_index,
                deletes
                    .iter()
                    .map(TransactionExecutionRecord::execution_id)
                    .collect(),
                vec![candidate.clone()],
            )?;
            match self.commit(mutation).await {
                Ok(index) => return Ok(index),
                Err(failure) if failure.contract_code() == Some(ContractErrorCode::Conflict) => {
                    continue
                }
                Err(failure) => return Err(failure),
            }
        }
        Err(conflict("交易历史 CAS 超过 8 次仍冲突"))
    }

    pub(crate) async fn require_execution_snapshot(
        &self,
        execution_id: TransactionExecutionId,
    ) -> Result<(TransactionHistoryIndex, TransactionExecutionRecord), EngineError> {
        let index = self.index().await?;
        let record = self
            .record_at(index, execution_id)
            .await?
            .ok_or_else(|| error(ContractErrorCode::NotFound, "通用交易恢复记录不存在"))?;
        Ok((index, record))
    }

    /// Verifies that the low-level submit path cannot bypass a durable pending
    /// authorization. This uncommon guard scans bounded pages without ever
    /// materializing or rewriting the complete history value.
    pub(crate) async fn require_recorded_before_broadcast(
        &self,
        transaction_hash: Hash32,
    ) -> Result<TransactionExecutionRecord, EngineError> {
        let index = self.index().await?;
        let mut before = None;
        let mut found = None;
        loop {
            let batch = self
                .batch_at(
                    index,
                    TransactionHistoryQueryKind::Newest,
                    before,
                    MAX_TRANSACTION_HISTORY_PAGE_SIZE,
                )
                .await?;
            for record in batch.records() {
                if record.transaction_hash() == transaction_hash {
                    if found.is_some() {
                        return Err(integrity("transactionHash 对应多条通用交易记录"));
                    }
                    found = Some(record.clone());
                }
            }
            if !batch.has_more() {
                break;
            }
            before = batch.records().last().map(record_cursor);
        }
        match found {
            Some(record) if matches!(record.status(), HistoryTransactionStatus::Pending) => {
                Ok(record)
            }
            Some(record) => Err(error(
                ContractErrorCode::InvalidState,
                format!(
                    "通用交易已经离开 Pending：{}",
                    record.status().persisted_name().unwrap_or("invalid")
                ),
            )),
            None => Err(error(
                ContractErrorCode::InvalidState,
                "通用交易必须先持久化再广播",
            )),
        }
    }

    pub(crate) async fn update_execution_status(
        &self,
        execution_id: TransactionExecutionId,
        status: HistoryTransactionStatus,
    ) -> Result<TransactionHistoryIndex, EngineError> {
        let _guard = history_mutation_gate().lock().await;
        let now = self.clock.now_millis()?;
        for _ in 0..MAX_HISTORY_CAS_ATTEMPTS {
            let current = self.index().await?;
            let record = self
                .record_at(current, execution_id)
                .await?
                .ok_or_else(|| error(ContractErrorCode::NotFound, "通用交易恢复记录不存在"))?;
            if record.status() == &status {
                return Ok(current);
            }
            let next_record = record.try_with_status(status.clone(), now)?;
            let became_terminal = !record.status().is_retention_terminal()
                && next_record.status().is_retention_terminal();
            let (open_count, open_weight) = if became_terminal {
                (
                    current
                        .open_count()
                        .checked_sub(1)
                        .ok_or_else(|| integrity("transaction history open 数量下溢"))?,
                    current
                        .open_weight_bytes()
                        .checked_sub(record.durable_weight_bytes())
                        .ok_or_else(|| integrity("transaction history open 权重下溢"))?,
                )
            } else {
                (current.open_count(), current.open_weight_bytes())
            };
            let next_index = TransactionHistoryIndex::try_new(
                next_revision(current.revision())?,
                current.record_count(),
                current.durable_weight_bytes(),
                open_count,
                open_weight,
            )?;
            let mutation = TransactionHistoryMutation::try_new(
                current.revision(),
                next_index,
                Vec::new(),
                vec![next_record],
            )?;
            match self.commit(mutation).await {
                Ok(index) => return Ok(index),
                Err(failure) if failure.contract_code() == Some(ContractErrorCode::Conflict) => {
                    continue
                }
                Err(failure) => return Err(failure),
            }
        }
        Err(conflict("交易历史 CAS 超过 8 次仍冲突"))
    }

    pub(crate) async fn index(&self) -> Result<TransactionHistoryIndex, EngineError> {
        self.store.load_index().await.map_err(EngineError::from)
    }

    pub(crate) async fn page(
        &self,
        before: Option<TransactionExecutionId>,
        limit: usize,
    ) -> Result<TransactionHistoryPage, EngineError> {
        if !(1..=MAX_TRANSACTION_HISTORY_PAGE_SIZE).contains(&limit) {
            return Err(error(
                ContractErrorCode::InvalidArgument,
                "transaction history limit 必须为 1..100",
            ));
        }
        let index = self.index().await?;
        let before = match before {
            None => None,
            Some(execution_id) => Some(record_cursor(
                &self.record_at(index, execution_id).await?.ok_or_else(|| {
                    error(
                        ContractErrorCode::NotFound,
                        "beforeExecutionId 不属于当前 transaction history 快照",
                    )
                })?,
            )),
        };
        let batch = self
            .batch_at(index, TransactionHistoryQueryKind::Newest, before, limit)
            .await?;
        let records = batch
            .records()
            .iter()
            .map(TransactionHistoryRecord::from)
            .collect::<Vec<_>>();
        let next = batch
            .has_more()
            .then(|| records.last().map(TransactionHistoryRecord::execution_id))
            .flatten();
        Ok(TransactionHistoryPage::new(index.revision(), records, next))
    }

    pub(crate) async fn open_batch(
        &self,
        limit: usize,
    ) -> Result<(TransactionHistoryIndex, Vec<TransactionExecutionRecord>), EngineError> {
        if !(1..=MAX_TRANSACTION_HISTORY_PAGE_SIZE).contains(&limit) {
            return Err(error(
                ContractErrorCode::InvalidArgument,
                "transaction history recovery limit 必须为 1..100",
            ));
        }
        let index = self.index().await?;
        let batch = self
            .batch_at(
                index,
                TransactionHistoryQueryKind::OldestReconcilable,
                None,
                limit,
            )
            .await?;
        Ok((index, batch.records().to_vec()))
    }

    async fn record_at(
        &self,
        index: TransactionHistoryIndex,
        execution_id: TransactionExecutionId,
    ) -> Result<Option<TransactionExecutionRecord>, EngineError> {
        let snapshot = self
            .store
            .load_record(index.revision(), execution_id)
            .await?;
        if snapshot.index() != index {
            return Err(integrity("transaction history record 查询汇总不一致"));
        }
        if snapshot
            .record()
            .is_some_and(|record| record.execution_id() != execution_id)
        {
            return Err(integrity(
                "transaction history record 查询返回错误 executionId",
            ));
        }
        Ok(snapshot.into_record())
    }

    async fn batch_at(
        &self,
        index: TransactionHistoryIndex,
        kind: TransactionHistoryQueryKind,
        before: Option<TransactionHistoryCursor>,
        limit: usize,
    ) -> Result<TransactionHistoryRecordBatch, EngineError> {
        let batch = self
            .store
            .load_page(index.revision(), kind, before, limit)
            .await?;
        if batch.index() != index {
            return Err(integrity("transaction history page 查询汇总不一致"));
        }
        validate_batch(kind, before, batch.records())?;
        Ok(batch)
    }

    async fn require_no_open_account_or_duplicate_hash(
        &self,
        index: TransactionHistoryIndex,
        account_id: AccountId32,
        transaction_hash: Option<Hash32>,
    ) -> Result<(), EngineError> {
        let mut before = None;
        loop {
            let batch = self
                .batch_at(
                    index,
                    TransactionHistoryQueryKind::Newest,
                    before,
                    MAX_TRANSACTION_HISTORY_PAGE_SIZE,
                )
                .await?;
            for record in batch.records() {
                if record.account_id() == account_id && !record.status().is_retention_terminal() {
                    return Err(conflict("同一账户已有 Pending/InBlock 交易"));
                }
                if transaction_hash.is_some_and(|hash| record.transaction_hash() == hash) {
                    return Err(error(
                        ContractErrorCode::InvalidArgument,
                        "transactionHash 已属于另一通用 execution",
                    ));
                }
            }
            if !batch.has_more() {
                return Ok(());
            }
            before = batch.records().last().map(record_cursor);
        }
    }

    async fn make_room(
        &self,
        index: TransactionHistoryIndex,
        candidate: &TransactionExecutionRecord,
    ) -> Result<Vec<TransactionExecutionRecord>, EngineError> {
        if candidate.durable_weight_bytes() > MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES {
            return Err(error(
                ContractErrorCode::InvalidArgument,
                "单条通用交易超过 transaction history 持久化资源预算",
            ));
        }
        let mut next_count = index.record_count();
        let mut next_weight = index.durable_weight_bytes();
        let mut deletes = Vec::new();
        let mut before = None;
        loop {
            if next_count < MAX_TRANSACTION_HISTORY_RECORDS
                && next_weight
                    .checked_add(candidate.durable_weight_bytes())
                    .is_some_and(|weight| weight <= MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES)
            {
                return Ok(deletes);
            }
            let batch = self
                .batch_at(
                    index,
                    TransactionHistoryQueryKind::OldestRetentionTerminal,
                    before,
                    MAX_TRANSACTION_HISTORY_PAGE_SIZE,
                )
                .await?;
            if batch.records().is_empty() {
                return Err(conflict(
                    "transaction history 条数或资源预算已满且没有可驱逐的终态记录",
                ));
            }
            for record in batch.records() {
                deletes.push(record.clone());
                next_count = next_count
                    .checked_sub(1)
                    .ok_or_else(|| integrity("transaction history 记录数量下溢"))?;
                next_weight = next_weight
                    .checked_sub(record.durable_weight_bytes())
                    .ok_or_else(|| integrity("transaction history 资源权重下溢"))?;
                if next_count < MAX_TRANSACTION_HISTORY_RECORDS
                    && next_weight
                        .checked_add(candidate.durable_weight_bytes())
                        .is_some_and(|weight| {
                            weight <= MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES
                        })
                {
                    return Ok(deletes);
                }
            }
            if !batch.has_more() {
                return Err(conflict(
                    "transaction history 资源预算不足且 open record 不可驱逐",
                ));
            }
            before = batch.records().last().map(record_cursor);
        }
    }

    async fn commit(
        &self,
        mutation: TransactionHistoryMutation,
    ) -> Result<TransactionHistoryIndex, EngineError> {
        let expected = mutation.next_index();
        match self.store.compare_and_swap(mutation.clone()).await {
            Ok(observed) if observed == expected => Ok(observed),
            Ok(_) => Err(integrity("交易历史 mutation 返回的 index 与候选不一致")),
            Err(write_error) => {
                let observed = self.store.load_index().await;
                if observed.as_ref().is_ok_and(|index| index == &expected)
                    && self.mutation_visible(expected, &mutation).await?
                {
                    Ok(expected)
                } else {
                    Err(EngineError::from(write_error))
                }
            }
        }
    }

    async fn mutation_visible(
        &self,
        index: TransactionHistoryIndex,
        mutation: &TransactionHistoryMutation,
    ) -> Result<bool, EngineError> {
        for execution_id in mutation.deletes() {
            if self.record_at(index, *execution_id).await?.is_some() {
                return Ok(false);
            }
        }
        for candidate in mutation.upserts() {
            if self
                .record_at(index, candidate.execution_id())
                .await?
                .as_ref()
                != Some(candidate)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn record_cursor(record: &TransactionExecutionRecord) -> TransactionHistoryCursor {
    TransactionHistoryCursor::new(record.created_at_millis(), record.execution_id())
}

fn validate_batch(
    kind: TransactionHistoryQueryKind,
    before: Option<TransactionHistoryCursor>,
    records: &[TransactionExecutionRecord],
) -> Result<(), EngineError> {
    for record in records {
        match kind {
            TransactionHistoryQueryKind::Newest => {}
            TransactionHistoryQueryKind::OldestRetentionTerminal
                if !record.status().is_retention_terminal() =>
            {
                return Err(integrity("history terminal 查询返回非终态记录"));
            }
            TransactionHistoryQueryKind::OldestReconcilable
                if record.status().is_chain_terminal() =>
            {
                return Err(integrity("history recovery 查询返回链终态记录"));
            }
            _ => {}
        }
    }
    for pair in records.windows(2) {
        let left = record_cursor(&pair[0]);
        let right = record_cursor(&pair[1]);
        let ordered = match kind {
            TransactionHistoryQueryKind::Newest => {
                (left.created_at_millis(), left.execution_id())
                    > (right.created_at_millis(), right.execution_id())
            }
            _ => {
                (left.created_at_millis(), left.execution_id())
                    < (right.created_at_millis(), right.execution_id())
            }
        };
        if !ordered {
            return Err(integrity("history page 排序或 executionId 唯一性无效"));
        }
    }
    if let (Some(cursor), Some(first)) = (before, records.first()) {
        let first = record_cursor(first);
        let after_cursor = match kind {
            TransactionHistoryQueryKind::Newest => {
                (first.created_at_millis(), first.execution_id())
                    < (cursor.created_at_millis(), cursor.execution_id())
            }
            _ => {
                (first.created_at_millis(), first.execution_id())
                    > (cursor.created_at_millis(), cursor.execution_id())
            }
        };
        if !after_cursor {
            return Err(integrity("history page 没有严格越过请求游标"));
        }
    }
    Ok(())
}

fn next_revision(revision: u64) -> Result<u64, EngineError> {
    revision
        .checked_add(1)
        .ok_or_else(|| error(ContractErrorCode::InvalidState, "交易历史 revision 已耗尽"))
}

fn conflict(message: impl Into<String>) -> EngineError {
    error(ContractErrorCode::Conflict, message)
}

fn integrity(message: impl Into<String>) -> EngineError {
    error(ContractErrorCode::Integrity, message)
}

fn error(code: ContractErrorCode, message: impl Into<String>) -> EngineError {
    EngineError::contract(code, message)
}
