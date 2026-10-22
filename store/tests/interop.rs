mod db;
use citizen_sdk_contracts::*;
use citizen_sdk_store::{
    codec,
    sqlite::{Connection, Value},
    PublicStore,
};
use futures::executor::block_on;

#[test]
fn android_system_metadata_is_preserved_and_extra_business_objects_still_fail() {
    let db = db::Db::open();
    let mut conn = db.0.lock().unwrap();
    // 原Android数据文件可能已由系统写入locale表，不能删除或算作未知业务表。
    conn.execute("PRAGMA auto_vacuum=INCREMENTAL", &[]).unwrap();
    conn.execute("CREATE TABLE android_metadata(locale TEXT)", &[])
        .unwrap();
    conn.execute("INSERT INTO android_metadata VALUES('en_US')", &[])
        .unwrap();
    citizen_sdk_store::schema::initialize(&mut *conn, true).unwrap();
    assert_eq!(
        conn.query("SELECT locale FROM android_metadata", &[], 1, 1024)
            .unwrap()[0]
            .text(0, 1024)
            .unwrap(),
        "en_US"
    );
    conn.execute("CREATE TABLE sqlitex_extra(value)", &[])
        .unwrap();
    assert!(citizen_sdk_store::schema::initialize(&mut *conn, true).is_err());
}

#[test]
fn unavailable_android_pragma_is_distinct_from_a_failed_or_weakened_setting() {
    use citizen_sdk_contracts::ContractResult;
    use citizen_sdk_store::sqlite::{Row, Value};
    struct Older<'a>(&'a mut dyn Connection);
    impl Connection for Older<'_> {
        fn execute(&mut self, sql: &str, values: &[Value]) -> ContractResult<u64> {
            if sql == "PRAGMA trusted_schema=OFF" {
                Ok(0)
            } else {
                self.0.execute(sql, values)
            }
        }
        fn query(
            &mut self,
            sql: &str,
            values: &[Value],
            rows: usize,
            bytes: usize,
        ) -> ContractResult<Vec<Row>> {
            if sql == "PRAGMA trusted_schema" {
                Ok(vec![])
            } else {
                self.0.query(sql, values, rows, bytes)
            }
        }
        fn scan(
            &mut self,
            sql: &str,
            values: &[Value],
            rows: usize,
            bytes: usize,
            visitor: &mut dyn FnMut(&Row) -> ContractResult<bool>,
        ) -> ContractResult<()> {
            self.0.scan(sql, values, rows, bytes, visitor)
        }
        fn begin(&mut self) -> ContractResult<()> {
            self.0.begin()
        }
        fn end(&mut self, commit: bool) -> ContractResult<()> {
            self.0.end(commit)
        }
        fn wal(&mut self) -> ContractResult<()> {
            self.0.wal()
        }
    }
    let db = db::Db::open();
    let mut conn = db.0.lock().unwrap();
    citizen_sdk_store::schema::initialize(&mut Older(&mut *conn), true).unwrap();
    assert!(citizen_sdk_store::schema::initialize(&mut Older(&mut *conn), false).is_err());
}

#[test]
fn existing_schema_and_cshr_records_are_read_without_rewrite() {
    let db = db::Db::open();
    let snapshot = ChainDatabaseSnapshot::new(
        7,
        Some(
            ExportedChainState::try_new(
                ChainIdentity::citizenchain(),
                1,
                FinalizedBlockRef::from_parts(Hash32::from_bytes([7; 32]), 17),
                vec![1, 2, 3],
            )
            .unwrap(),
        ),
    );
    let encoded = codec::encode_chain_database_snapshot(&snapshot).unwrap();
    {
        let mut conn = db.0.lock().unwrap();
        conn.execute("PRAGMA auto_vacuum=INCREMENTAL", &[]).unwrap();
        for sql in citizen_sdk_store::schema::STATEMENTS {
            conn.execute(sql, &[]).unwrap();
        }
        conn.execute("PRAGMA user_version=2", &[]).unwrap();
        conn.execute(
            "INSERT INTO singleton_records VALUES(1,7,?)",
            &[Value::Blob(encoded.clone())],
        )
        .unwrap();
    }
    let store = PublicStore::new(db.clone());
    assert_eq!(
        block_on(ChainDatabaseStore::load(&store)).unwrap(),
        snapshot
    );
    let rows =
        db.0.lock()
            .unwrap()
            .query("SELECT record FROM singleton_records", &[], 1, 524288)
            .unwrap();
    assert_eq!(rows[0].bytes(0, 524288).unwrap(), encoded);
}

#[test]
fn records_written_by_rust_are_readable_as_the_existing_cshr_sql_layout() {
    let db = db::Db::open();
    let store = PublicStore::new(db.clone());
    let record = db::record(3, 7, HistoryTransactionStatus::Pending);
    let weight = record.durable_weight_bytes();
    let index = TransactionHistoryIndex::try_new(1, 1, weight, 1, weight).unwrap();
    block_on(TransactionHistoryStore::compare_and_swap(
        &store,
        TransactionHistoryMutation::try_new(0, index, vec![], vec![record.clone()]).unwrap(),
    ))
    .unwrap();
    let rows =
        db.0.lock()
            .unwrap()
            .query(
                "SELECT execution_id, record FROM transaction_history_records",
                &[],
                1,
                33554432,
            )
            .unwrap();
    assert_eq!(
        rows[0].text(0, 32).unwrap(),
        "03000000000000000000000000000000"
    );
    assert_eq!(
        codec::decode_transaction_execution_record(rows[0].bytes(1, 33554432).unwrap()).unwrap(),
        record
    );
}
