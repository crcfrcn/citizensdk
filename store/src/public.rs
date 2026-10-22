//! 公共链状态、准确块Runtime缓存和交易历史的唯一SQL实现。
use crate::{
    codec,
    error::{codec as codec_error, error, integrity, invalid},
    key, schema,
    sqlite::{scalar, transaction, transaction_recover, Connection, Database, Row, Value},
};
use citizen_sdk_contracts::{
    ChainDatabaseSnapshot, ChainDatabaseStore, ContractErrorCode, ContractFuture, ContractResult,
    ExportedChainState, Hash32, RuntimeCacheStore, RuntimeContext, TransactionExecutionId,
    TransactionExecutionRecord, TransactionHistoryCursor, TransactionHistoryIndex,
    TransactionHistoryMutation, TransactionHistoryQueryKind, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore, MAX_PERSISTED_RUNTIME_CONTEXTS,
    MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES, MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    MAX_TRANSACTION_HISTORY_RECORDS,
};
use std::sync::Mutex;

const HISTORY_BYTES: usize = 32 * 1024 * 1024;
const RECORD_COLUMNS: &str = "execution_id, created_at_millis, updated_at_millis, durable_weight, retention_terminal, chain_terminal, record";

pub struct PublicStore<D: Database> {
    database: D,
    initialized: Mutex<bool>,
}

impl<D: Database> PublicStore<D> {
    /// 构造只保存资源，模块校验前不打开文件或创建数据库。
    pub fn new(database: D) -> Self {
        Self {
            database,
            initialized: Mutex::new(false),
        }
    }

    fn run<T>(
        &self,
        operation: impl FnOnce(&mut dyn Connection) -> ContractResult<T>,
    ) -> ContractResult<T> {
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| error(ContractErrorCode::Internal, "public store lock is poisoned"))?;
        let mut operation = Some(operation);
        let mut output = None;
        self.database.run(&mut |connection| {
            let operation = operation
                .take()
                .ok_or_else(|| integrity("database job executed twice"))?;
            if !*initialized {
                schema::initialize(connection, cfg!(target_os = "android"))?;
                *initialized = true;
            }
            let value = operation(connection);
            let status = value.as_ref().map(|_| ()).map_err(Clone::clone);
            output = Some(value);
            status
        })?;
        output.ok_or_else(|| integrity("database job was not executed"))?
    }
}

fn integer(value: u64) -> ContractResult<Value> {
    Ok(Value::Integer(i64::try_from(value).map_err(|_| {
        invalid("SQLite integer exceeds signed 64-bit range")
    })?))
}

fn chain_snapshot(connection: &mut dyn Connection) -> ContractResult<ChainDatabaseSnapshot> {
    let rows = connection.query(
        "SELECT revision, record FROM singleton_records WHERE domain = ?",
        &[Value::Integer(1)],
        1,
        524288,
    )?;
    match rows.first() {
        None => Ok(ChainDatabaseSnapshot::new(0, None)),
        Some(row) => {
            let revision = row.integer(0, 1, i64::MAX)? as u64;
            let snapshot = codec::decode_chain_database_snapshot(row.bytes(1, 524288)?)
                .map_err(codec_error)?;
            if snapshot.revision() != revision {
                return Err(integrity("chain database revision differs from its record"));
            }
            Ok(snapshot)
        }
    }
}

impl<D: Database> ChainDatabaseStore for PublicStore<D> {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        Box::pin(async move { self.run(chain_snapshot) })
    }
    fn compare_and_swap(
        &self,
        expected: u64,
        state: Option<ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        Box::pin(async move {
            if expected >= i64::MAX as u64 {
                return Err(error(
                    ContractErrorCode::Conflict,
                    "chain database revision is exhausted",
                ));
            }
            let next = ChainDatabaseSnapshot::new(expected + 1, state);
            let encoded = codec::encode_chain_database_snapshot(&next).map_err(codec_error)?;
            if encoded.len() > 524288 {
                return Err(invalid("chain database record is too large"));
            }
            self.run(|connection| transaction_recover(connection,|connection| {
                if chain_snapshot(connection)?.revision()!=expected { return Err(error(ContractErrorCode::Conflict,"chain database revision changed")); }
                connection.execute("INSERT OR REPLACE INTO singleton_records(domain, revision, record) VALUES(?, ?, ?)",
                    &[Value::Integer(1),integer(next.revision())?,Value::Blob(encoded)])?;
                Ok(next)
            },|connection,next| Ok(chain_snapshot(connection)?==*next)))
        })
    }
}

impl<D: Database> RuntimeCacheStore for PublicStore<D> {
    fn load(&self, block: Hash32) -> ContractFuture<'_, Option<RuntimeContext>> {
        Box::pin(async move {
            self.run(|connection| {
                let rows = connection.query(
                    "SELECT record FROM runtime_cache WHERE record_key = ?",
                    &[Value::Text(key::block(block))],
                    1,
                    8 * 1024 * 1024,
                )?;
                let Some(row) = rows.first() else {
                    return Ok(None);
                };
                let context = codec::decode_runtime_context(row.bytes(0, 8 * 1024 * 1024)?)
                    .map_err(codec_error)?;
                if context.block().hash() != block {
                    return Err(integrity("runtime cache block differs"));
                }
                Ok(Some(context))
            })
        })
    }
    fn store(&self, context: RuntimeContext) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            let record = codec::encode_runtime_context(&context).map_err(codec_error)?;
            if record.len() > 8 * 1024 * 1024 {
                return Err(invalid("runtime cache record is too large"));
            }
            self.run(|connection| transaction(connection,|connection| {
                connection.execute("INSERT OR REPLACE INTO runtime_cache(record_key, record) VALUES(?, ?)",
                    &[Value::Text(key::block(context.block().hash())),Value::Blob(record)])?;
                connection.execute("DELETE FROM runtime_cache WHERE rowid NOT IN (SELECT rowid FROM runtime_cache ORDER BY rowid DESC LIMIT ?)",
                    &[Value::Integer(MAX_PERSISTED_RUNTIME_CONTEXTS as i64)])?;
                Ok(())
            }))
        })
    }
    fn delete(&self, block: Hash32) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            self.run(|connection| {
                transaction(connection, |connection| {
                    connection.execute(
                        "DELETE FROM runtime_cache WHERE record_key = ?",
                        &[Value::Text(key::block(block))],
                    )?;
                    Ok(())
                })
            })
        })
    }
}

fn history_index(connection: &mut dyn Connection) -> ContractResult<TransactionHistoryIndex> {
    let rows=connection.query("SELECT revision, record_count, durable_weight, open_count, open_weight FROM transaction_history_meta WHERE singleton = 1",&[],1,1024)?;
    let Some(row) = rows.first() else {
        return Ok(TransactionHistoryIndex::empty());
    };
    TransactionHistoryIndex::try_new(
        row.integer(0, 1, i64::MAX)? as u64,
        row.integer(1, 0, MAX_TRANSACTION_HISTORY_RECORDS as i64)? as usize,
        row.integer(2, 0, MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES as i64)? as usize,
        row.integer(3, 0, MAX_TRANSACTION_HISTORY_RECORDS as i64)? as usize,
        row.integer(4, 0, MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES as i64)? as usize,
    )
    .map_err(|_| integrity("history index is inconsistent"))
}

fn history_row(row: &Row) -> ContractResult<TransactionExecutionRecord> {
    let id = key::parse_execution(row.text(0, 32)?)?;
    let created = row.integer(1, 0, i64::MAX)? as u64;
    let updated = row.integer(2, 0, i64::MAX)? as u64;
    let weight = row.integer(3, 1, MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES as i64)? as usize;
    let retention = row.integer(4, 0, 1)? != 0;
    let terminal = row.integer(5, 0, 1)? != 0;
    let record = codec::decode_transaction_execution_record(row.bytes(6, HISTORY_BYTES)?)
        .map_err(codec_error)?;
    if record.execution_id() != id
        || record.created_at_millis() != created
        || record.updated_at_millis() != updated
        || record.durable_weight_bytes() != weight
        || record.status().is_retention_terminal() != retention
        || record.status().is_chain_terminal() != terminal
    {
        return Err(integrity("history SQL descriptor differs from its record"));
    }
    Ok(record)
}

fn history_record(
    connection: &mut dyn Connection,
    id: TransactionExecutionId,
) -> ContractResult<Option<TransactionExecutionRecord>> {
    let rows = connection.query(
        &format!("SELECT {RECORD_COLUMNS} FROM transaction_history_records WHERE execution_id = ?"),
        &[Value::Text(key::execution(id))],
        1,
        HISTORY_BYTES,
    )?;
    rows.first().map(history_row).transpose()
}

fn fenced(
    connection: &mut dyn Connection,
    expected: u64,
) -> ContractResult<TransactionHistoryIndex> {
    let index = history_index(connection)?;
    if index.revision() != expected {
        return Err(error(
            ContractErrorCode::Conflict,
            "history revision changed",
        ));
    }
    Ok(index)
}

fn update_counts(
    values: &mut [usize; 4],
    record: &TransactionExecutionRecord,
    add: bool,
) -> ContractResult<()> {
    let delta = [
        1,
        record.durable_weight_bytes(),
        usize::from(!record.status().is_retention_terminal()),
        if record.status().is_retention_terminal() {
            0
        } else {
            record.durable_weight_bytes()
        },
    ];
    for (value, delta) in values.iter_mut().zip(delta) {
        *value = if add {
            value.checked_add(delta)
        } else {
            value.checked_sub(delta)
        }
        .ok_or_else(|| integrity("history aggregate overflow or underflow"))?;
    }
    Ok(())
}

fn recovery_matches(
    connection: &mut dyn Connection,
    mutation: &TransactionHistoryMutation,
) -> ContractResult<bool> {
    let next = mutation.next_index();
    if history_index(connection)? != next {
        return Ok(false);
    }
    for id in mutation.deletes() {
        if history_record(connection, *id)?.is_some() {
            return Ok(false);
        }
    }
    for record in mutation.upserts() {
        if history_record(connection, record.execution_id())?.as_ref() != Some(record) {
            return Ok(false);
        }
    }
    // revision再次核对，拒绝跨进程写入期间的混合回读。
    Ok(history_index(connection)? == next)
}

impl<D: Database> TransactionHistoryStore for PublicStore<D> {
    fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex> {
        Box::pin(async move { self.run(history_index) })
    }
    fn load_record(
        &self,
        expected: u64,
        id: TransactionExecutionId,
    ) -> ContractFuture<'_, TransactionHistoryRecordSnapshot> {
        Box::pin(async move {
            self.run(|connection| {
                transaction(connection, |connection| {
                    let index = fenced(connection, expected)?;
                    let record = history_record(connection, id)?;
                    if index.record_count() == 0 && record.is_some() {
                        return Err(integrity("history record is outside its index"));
                    }
                    Ok(TransactionHistoryRecordSnapshot::new(index, record))
                })
            })
        })
    }
    fn load_page(
        &self,
        expected: u64,
        kind: TransactionHistoryQueryKind,
        cursor: Option<TransactionHistoryCursor>,
        limit: usize,
    ) -> ContractFuture<'_, TransactionHistoryRecordBatch> {
        Box::pin(async move {
            if limit == 0 || limit > MAX_TRANSACTION_HISTORY_PAGE_SIZE {
                return Err(invalid("history page limit is invalid"));
            }
            self.run(|connection| transaction(connection,|connection| {
                let index=fenced(connection,expected)?;
                let (filter,comparison,order)=match kind {
                    TransactionHistoryQueryKind::Newest => ("1 = 1","<","DESC"),
                    TransactionHistoryQueryKind::OldestRetentionTerminal => ("retention_terminal = 1",">","ASC"),
                    TransactionHistoryQueryKind::OldestReconcilable => ("chain_terminal = 0",">","ASC"),
                };
                let mut sql=format!("SELECT {RECORD_COLUMNS} FROM transaction_history_records WHERE {filter}");
                let mut values=Vec::new();
                if let Some(cursor)=cursor {
                    sql.push_str(&format!(" AND (created_at_millis {comparison} ? OR (created_at_millis = ? AND execution_id {comparison} ?))"));
                    values.extend([integer(cursor.created_at_millis())?,integer(cursor.created_at_millis())?,Value::Text(key::execution(cursor.execution_id()))]);
                }
                sql.push_str(&format!(" ORDER BY created_at_millis {order}, execution_id {order} LIMIT ?"));
                values.push(Value::Integer(limit as i64+1));
                let rows=connection.query(&sql,&values,limit+1,HISTORY_BYTES)?;
                let more=rows.len()>limit;
                let records=rows.iter().take(limit).map(history_row).collect::<ContractResult<Vec<_>>>()?;
                TransactionHistoryRecordBatch::try_new(index,records,more).map_err(|_| integrity("history page is inconsistent"))
            }))
        })
    }
    fn compare_and_swap(
        &self,
        mutation: TransactionHistoryMutation,
    ) -> ContractFuture<'_, TransactionHistoryIndex> {
        Box::pin(async move {
            if mutation.expected_revision() >= i64::MAX as u64 {
                return Err(invalid("history revision is exhausted"));
            }
            let encoded = mutation
                .upserts()
                .iter()
                .map(|record| {
                    codec::encode_transaction_execution_record(record).map_err(codec_error)
                })
                .collect::<ContractResult<Vec<_>>>()?;
            self.run(|connection| {
                let result=transaction_recover(connection,|connection| {
                    let current=fenced(connection,mutation.expected_revision())?;
                    let mut counts=[current.record_count(),current.durable_weight_bytes(),current.open_count(),current.open_weight_bytes()];
                    for id in mutation.deletes() {
                        let current=history_record(connection,*id)?.ok_or_else(|| integrity("history delete target is missing"))?;
                        if !current.status().is_retention_terminal() { return Err(integrity("history mutation cannot delete an open execution")); }
                        update_counts(&mut counts,&current,false)?;
                        connection.execute("DELETE FROM transaction_history_records WHERE execution_id = ?",&[Value::Text(key::execution(*id))])?;
                    }
                    for (record,encoded) in mutation.upserts().iter().zip(&encoded) {
                        if let Some(current)=history_record(connection,record.execution_id())? { update_counts(&mut counts,&current,false)?; }
                        update_counts(&mut counts,record,true)?;
                        let _=TransactionHistoryIndex::try_new(current.revision(),counts[0],counts[1],counts[2],counts[3])?;
                        connection.execute("INSERT OR REPLACE INTO transaction_history_records(execution_id, created_at_millis, updated_at_millis, durable_weight, retention_terminal, chain_terminal, record) VALUES(?, ?, ?, ?, ?, ?, ?)",
                            &[Value::Text(key::execution(record.execution_id())),integer(record.created_at_millis())?,integer(record.updated_at_millis())?,
                              integer(record.durable_weight_bytes() as u64)?,Value::Integer(i64::from(record.status().is_retention_terminal())),
                              Value::Integer(i64::from(record.status().is_chain_terminal())),Value::Blob(encoded.clone())])?;
                    }
                    let next=mutation.next_index();
                    let computed=TransactionHistoryIndex::try_new(next.revision(),counts[0],counts[1],counts[2],counts[3])?;
                    if computed!=next { return Err(integrity("history mutation aggregate is inconsistent")); }
                    connection.execute("INSERT OR REPLACE INTO transaction_history_meta(singleton, revision, record_count, durable_weight, open_count, open_weight) VALUES(1, ?, ?, ?, ?, ?)",
                        &[integer(next.revision())?,integer(next.record_count() as u64)?,integer(next.durable_weight_bytes() as u64)?,integer(next.open_count() as u64)?,integer(next.open_weight_bytes() as u64)?])?;
                    Ok(next)
                },|connection,_| transaction(connection,|connection| recovery_matches(connection,&mutation)))?;
                if !mutation.deletes().is_empty() {
                    let pages=scalar(connection,"PRAGMA page_count")?;
                    let free=scalar(connection,"PRAGMA freelist_count")?;
                    if free>16 && free.saturating_mul(4)>pages {
                        connection.execute("PRAGMA incremental_vacuum(128)",&[])?;
                        connection.query("PRAGMA wal_checkpoint(PASSIVE)",&[],1,1024)?;
                    }
                }
                Ok(result)
            })
        })
    }
}
