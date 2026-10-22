mod db;
use citizen_sdk_contracts::*;
use citizen_sdk_store::{sqlite::Connection, PublicStore};
use futures::executor::block_on;
fn context(index: u8) -> RuntimeContext {
    RuntimeContext::try_new(
        VerifiedBlockRef::best(Hash32::from_bytes([index; 32]), u64::from(index)),
        RuntimeVersion::new(1, 1),
        vec![index],
    )
    .unwrap()
}
#[test]
fn runtime_cache_prunes_promotes_and_rolls_back_failed_pruning() {
    let db = db::Db::open();
    let store = PublicStore::new(db.clone());
    for i in 0..80 {
        block_on(store.store(context(i))).unwrap();
    }
    for i in 0..80 {
        assert_eq!(
            block_on(RuntimeCacheStore::load(&store, context(i).block().hash()))
                .unwrap()
                .is_some(),
            i >= 16
        );
    }
    block_on(store.store(context(16))).unwrap();
    block_on(store.store(context(80))).unwrap();
    assert!(
        block_on(RuntimeCacheStore::load(&store, context(16).block().hash()))
            .unwrap()
            .is_some()
    );
    assert!(
        block_on(RuntimeCacheStore::load(&store, context(17).block().hash()))
            .unwrap()
            .is_none()
    );
    db.0.lock().unwrap().execute("CREATE TRIGGER prune_failure BEFORE DELETE ON runtime_cache BEGIN SELECT RAISE(ABORT,'fixture'); END",&[]).unwrap();
    assert!(block_on(store.store(context(81))).is_err());
    assert!(
        block_on(RuntimeCacheStore::load(&store, context(81).block().hash()))
            .unwrap()
            .is_none()
    );
    assert!(
        block_on(RuntimeCacheStore::load(&store, context(18).block().hash()))
            .unwrap()
            .is_some()
    );
}
#[test]
fn chain_cas_conflict_and_uncertain_commit() {
    let db = db::Db::open();
    let store = PublicStore::new(db.clone());
    assert_eq!(
        block_on(ChainDatabaseStore::load(&store))
            .unwrap()
            .revision(),
        0
    );
    assert_eq!(
        block_on(ChainDatabaseStore::compare_and_swap(&store, 0, None))
            .unwrap()
            .revision(),
        1
    );
    assert_eq!(
        block_on(ChainDatabaseStore::compare_and_swap(&store, 0, None))
            .unwrap_err()
            .code(),
        ContractErrorCode::Conflict
    );
    {
        let mut conn = db.0.lock().unwrap();
        conn.commit_error = true;
        conn.commit_landed = false;
    }
    assert!(block_on(ChainDatabaseStore::compare_and_swap(&store, 1, None)).is_err());
    assert_eq!(
        block_on(ChainDatabaseStore::load(&store))
            .unwrap()
            .revision(),
        1
    );
    {
        let mut conn = db.0.lock().unwrap();
        conn.commit_error = true;
        conn.commit_landed = true;
    }
    assert_eq!(
        block_on(ChainDatabaseStore::compare_and_swap(&store, 1, None))
            .unwrap()
            .revision(),
        2
    );
}
#[test]
fn separate_connections_serialize_cas_and_preserve_reopened_data() {
    let directory = std::env::temp_dir().join(format!(
        "citizensdk-store-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    struct Remove(std::path::PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    let _remove = Remove(directory.clone());
    let name = std::ffi::CString::new(directory.join("public-state-v1.sqlite3").to_str().unwrap())
        .unwrap();
    let first = PublicStore::new(db::Db::named(&name));
    let second = PublicStore::new(db::Db::named(&name));
    block_on(ChainDatabaseStore::load(&first)).unwrap();
    block_on(ChainDatabaseStore::load(&second)).unwrap();
    std::thread::scope(|scope| {
        for store in [&first, &second] {
            scope.spawn(move || {
                for _ in 0..20 {
                    loop {
                        let revision = block_on(ChainDatabaseStore::load(store))
                            .unwrap()
                            .revision();
                        match block_on(ChainDatabaseStore::compare_and_swap(store, revision, None))
                        {
                            Ok(_) => break,
                            Err(error) if error.code() == ContractErrorCode::Conflict => {}
                            Err(error) => panic!("CAS failed: {error}"),
                        }
                    }
                }
            });
        }
    });
    drop(first);
    drop(second);
    assert_eq!(
        block_on(ChainDatabaseStore::load(&PublicStore::new(db::Db::named(
            &name
        ))))
        .unwrap()
        .revision(),
        40
    );
}

#[test]
fn store_survives_process_exit_and_concurrent_writers() {
    const FILE: &str = "CITIZENSDK_STORE_CHILD";
    const WRITES: &str = "CITIZENSDK_STORE_WRITES";
    if let Some(name) = std::env::var_os(FILE) {
        let name = std::ffi::CString::new(name.to_str().unwrap()).unwrap();
        let store = PublicStore::new(db::Db::named(&name));
        let count: usize = std::env::var(WRITES).unwrap().parse().unwrap();
        for _ in 0..count {
            loop {
                let revision = block_on(ChainDatabaseStore::load(&store))
                    .unwrap()
                    .revision();
                match block_on(ChainDatabaseStore::compare_and_swap(&store, revision, None)) {
                    Ok(_) => break,
                    Err(error) if error.code() == ContractErrorCode::Conflict => {}
                    Err(error) => panic!("process CAS failed: {error}"),
                }
            }
        }
        // 故意绕过Rust/SQLite析构，不能依靠close/checkpoint完成耐久提交。
        std::process::exit(0);
    }
    let directory = std::env::temp_dir().join(format!(
        "citizensdk-wal-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    struct Remove(std::path::PathBuf);
    impl Drop for Remove {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    let _remove = Remove(directory.clone());
    let file = directory.join("public-state-v1.sqlite3");
    let name = std::ffi::CString::new(file.to_str().unwrap()).unwrap();
    block_on(ChainDatabaseStore::load(&PublicStore::new(db::Db::named(
        &name,
    ))))
    .unwrap();
    let child = |count: usize| {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store_survives_process_exit_and_concurrent_writers",
                "--nocapture",
            ])
            .env(FILE, &file)
            .env(WRITES, count.to_string())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    };
    assert!(child(1).wait().unwrap().success());
    assert_eq!(
        block_on(ChainDatabaseStore::load(&PublicStore::new(db::Db::named(
            &name
        ))))
        .unwrap()
        .revision(),
        1
    );
    let mut first = child(20);
    let mut second = child(20);
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    assert_eq!(
        block_on(ChainDatabaseStore::load(&PublicStore::new(db::Db::named(
            &name
        ))))
        .unwrap()
        .revision(),
        41
    );
}

#[test]
fn malformed_revisions_and_extra_schema_are_rejected_without_overwrite() {
    for literal in ["-1", "0", "1.5", "'broken'"] {
        let db = db::Db::open();
        let store = PublicStore::new(db.clone());
        block_on(ChainDatabaseStore::compare_and_swap(&store, 0, None)).unwrap();
        let mut conn = db.0.lock().unwrap();
        conn.execute("PRAGMA ignore_check_constraints=ON", &[])
            .unwrap();
        conn.execute(
            &format!("UPDATE singleton_records SET revision={literal}"),
            &[],
        )
        .unwrap();
        let before = conn
            .query(
                "SELECT typeof(revision), quote(revision), hex(record) FROM singleton_records",
                &[],
                1,
                1048576,
            )
            .unwrap();
        drop(conn);
        assert_eq!(
            block_on(ChainDatabaseStore::load(&store))
                .unwrap_err()
                .code(),
            ContractErrorCode::Storage
        );
        assert!(block_on(ChainDatabaseStore::compare_and_swap(&store, 0, None)).is_err());
        assert_eq!(
            db.0.lock()
                .unwrap()
                .query(
                    "SELECT typeof(revision), quote(revision), hex(record) FROM singleton_records",
                    &[],
                    1,
                    1048576
                )
                .unwrap(),
            before
        );
    }
    for sql in [
        "CREATE TABLE sqlitex_extra(value BLOB)",
        "CREATE TRIGGER sqlitex_extra AFTER INSERT ON singleton_records BEGIN SELECT 1; END",
    ] {
        let db = db::Db::open();
        let store = PublicStore::new(db.clone());
        block_on(ChainDatabaseStore::load(&store)).unwrap();
        db.0.lock().unwrap().execute(sql, &[]).unwrap();
        assert_eq!(
            block_on(ChainDatabaseStore::load(&PublicStore::new(db)))
                .unwrap_err()
                .code(),
            ContractErrorCode::Integrity
        );
    }
}
#[test]
fn history_capacity_and_terminal_deletion_are_atomic() {
    let store = PublicStore::new(db::Db::open());
    let weight = db::record(1, 1, HistoryTransactionStatus::Pending).durable_weight_bytes();
    let mut revision = 0;
    for start in (0..4096).step_by(100) {
        let stop = (start + 100).min(4096);
        let records = (start..stop)
            .map(|i| db::record(i + 1, 1, HistoryTransactionStatus::Pending))
            .collect();
        revision += 1;
        let index =
            TransactionHistoryIndex::try_new(revision, stop, stop * weight, stop, stop * weight)
                .unwrap();
        block_on(TransactionHistoryStore::compare_and_swap(
            &store,
            TransactionHistoryMutation::try_new(revision - 1, index, vec![], records).unwrap(),
        ))
        .unwrap();
    }
    let full = block_on(store.load_index()).unwrap();
    let next = TransactionHistoryIndex::try_new(
        revision + 1,
        4096,
        full.durable_weight_bytes(),
        4096,
        full.open_weight_bytes(),
    )
    .unwrap();
    let extra = TransactionHistoryMutation::try_new(
        revision,
        next,
        vec![],
        vec![db::record(4097, 1, HistoryTransactionStatus::Pending)],
    )
    .unwrap();
    assert_eq!(
        block_on(TransactionHistoryStore::compare_and_swap(&store, extra))
            .unwrap_err()
            .code(),
        ContractErrorCode::InvalidArgument
    );
    assert_eq!(block_on(store.load_index()).unwrap(), full);
    let terminal = db::record(
        1,
        1,
        HistoryTransactionStatus::try_pool_rejected("fixture").unwrap(),
    );
    let terminal_weight = terminal.durable_weight_bytes();
    let next = TransactionHistoryIndex::try_new(
        revision + 1,
        4096,
        4095 * weight + terminal_weight,
        4095,
        4095 * weight,
    )
    .unwrap();
    block_on(TransactionHistoryStore::compare_and_swap(
        &store,
        TransactionHistoryMutation::try_new(revision, next, vec![], vec![terminal.clone()])
            .unwrap(),
    ))
    .unwrap();
    revision += 1;
    let next =
        TransactionHistoryIndex::try_new(revision + 1, 4095, 4095 * weight, 4095, 4095 * weight)
            .unwrap();
    block_on(TransactionHistoryStore::compare_and_swap(
        &store,
        TransactionHistoryMutation::try_new(revision, next, vec![terminal.execution_id()], vec![])
            .unwrap(),
    ))
    .unwrap();
    assert!(
        block_on(store.load_record(revision + 1, terminal.execution_id()))
            .unwrap()
            .record()
            .is_none()
    );
}
#[test]
fn history_order_cursor_fence_and_rollback() {
    let db = db::Db::open();
    let store = PublicStore::new(db);
    let a = db::record(1, 10, HistoryTransactionStatus::Pending);
    let b = db::record(2, 10, HistoryTransactionStatus::Pending);
    let weight = a.durable_weight_bytes() + b.durable_weight_bytes();
    let index = TransactionHistoryIndex::try_new(1, 2, weight, 2, weight).unwrap();
    let mutation =
        TransactionHistoryMutation::try_new(0, index, vec![], vec![a.clone(), b.clone()]).unwrap();
    assert_eq!(
        block_on(TransactionHistoryStore::compare_and_swap(&store, mutation)).unwrap(),
        index
    );
    let page = block_on(store.load_page(1, TransactionHistoryQueryKind::Newest, None, 1)).unwrap();
    assert_eq!(page.records(), &[b.clone()]);
    assert!(page.has_more());
    let cursor = TransactionHistoryCursor::new(b.created_at_millis(), b.execution_id());
    let page =
        block_on(store.load_page(1, TransactionHistoryQueryKind::Newest, Some(cursor), 1)).unwrap();
    assert_eq!(page.records(), &[a.clone()]);
    assert!(!page.has_more());
    assert_eq!(
        block_on(store.load_record(0, a.execution_id()))
            .unwrap_err()
            .code(),
        ContractErrorCode::Conflict
    );
    assert!(block_on(store.load_page(1, TransactionHistoryQueryKind::Newest, None, 0)).is_err());
    let invalid = TransactionHistoryMutation::try_new(
        1,
        TransactionHistoryIndex::try_new(
            2,
            1,
            a.durable_weight_bytes(),
            1,
            a.durable_weight_bytes(),
        )
        .unwrap(),
        vec![a.execution_id()],
        vec![],
    )
    .unwrap();
    assert_eq!(
        block_on(TransactionHistoryStore::compare_and_swap(&store, invalid))
            .unwrap_err()
            .code(),
        ContractErrorCode::Integrity
    );
    assert_eq!(block_on(store.load_index()).unwrap(), index);
}
#[test]
fn schema_and_record_corruption_never_reset() {
    let db = db::Db::open();
    db.0.lock()
        .unwrap()
        .execute("CREATE TABLE unexpected(value)", &[])
        .unwrap();
    assert_eq!(
        block_on(ChainDatabaseStore::load(&PublicStore::new(db.clone())))
            .unwrap_err()
            .code(),
        ContractErrorCode::Integrity
    );
    assert!(db
        .0
        .lock()
        .unwrap()
        .query("SELECT * FROM unexpected", &[], 1, 1024)
        .is_ok());
    let db = db::Db::open();
    let store = PublicStore::new(db.clone());
    block_on(ChainDatabaseStore::compare_and_swap(&store, 0, None)).unwrap();
    db.0.lock()
        .unwrap()
        .execute("UPDATE singleton_records SET record=x'00'", &[])
        .unwrap();
    assert!(block_on(ChainDatabaseStore::load(&store)).is_err());
    assert!(block_on(ChainDatabaseStore::compare_and_swap(&store, 1, None)).is_err());
}
