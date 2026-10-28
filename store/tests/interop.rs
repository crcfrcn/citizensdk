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
            "INSERT INTO chain VALUES(1,?)",
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
            .query("SELECT record_data FROM chain", &[], 1, 524288)
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
                "SELECT execution_id, record_data FROM entry",
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

#[test]
fn physical_tables_and_columns_are_exact_and_have_no_derived_keys() {
    use citizen_sdk_store::{secure::Format, SecureStore};
    for format in [
        None,
        Some(Format::Device),
        Some(Format::Tpm),
        Some(Format::Cng),
    ] {
        let db = db::Db::open();
        let expected = if let Some(format) = format {
            block_on(WalletProfileStore::load(&SecureStore::with_format(
                db.clone(),
                format,
            )))
            .unwrap();
            if format == Format::Device {
                vec!["generation", "secret", "wallet"]
            } else {
                vec!["generation", "object", "secret", "wallet"]
            }
        } else {
            block_on(ChainDatabaseStore::load(&PublicStore::new(db.clone()))).unwrap();
            vec!["chain", "entry", "history", "runtime"]
        };
        let mut conn = db.0.lock().unwrap();
        let rows=conn.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",&[],4,1024).unwrap();
        let names = rows
            .iter()
            .map(|r| r.text(0, 64).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, expected);
        for table in names {
            let rows = conn
                .query(&format!("PRAGMA table_info({table})"), &[], 16, 4096)
                .unwrap();
            for row in &rows {
                let name = row.text(1, 64).unwrap();
                let words = name.split('_').collect::<Vec<_>>();
                assert_eq!(words.len(), 2, "{table}.{name}");
                assert!(words
                    .iter()
                    .all(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase())));
            }
            if table == "generation" {
                assert_eq!(rows.len(), 4);
            }
            if table == "object" {
                assert_eq!(rows.len(), if format == Some(Format::Cng) { 4 } else { 6 });
            }
            if matches!(table, "chain" | "wallet" | "secret" | "history") {
                assert_eq!(rows.len(), 2);
            }
            if table == "entry" {
                assert_eq!(rows.len(), 5);
            }
        }
    }
}
