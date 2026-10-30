use super::*;
unsafe extern "C" fn once(_: *mut c_void, job: Job, context: *mut c_void) -> i32 {
    job(context)
}
unsafe extern "C" fn twice(_: *mut c_void, job: Job, context: *mut c_void) -> i32 {
    let _ = job(context);
    let _ = job(context);
    0
}
unsafe extern "C" fn missing(_: *mut c_void, _: Job, _: *mut c_void) -> i32 {
    0
}
unsafe extern "C" fn execute(
    _: *mut c_void,
    _: CitizenSdkBytesView,
    _: *const CitizenSdkSqlValue,
    _: u64,
    out: *mut u64,
) -> i32 {
    *out = 1;
    0
}
unsafe extern "C" fn query(
    _: *mut c_void,
    _: CitizenSdkBytesView,
    _: *const CitizenSdkSqlValue,
    _: u64,
    _: u64,
    _: u64,
    row: RowCallback,
    context: *mut c_void,
) -> i32 {
    let bytes = b"SQLite";
    let cell = CitizenSdkSqlValue {
        kind: 2,
        reserved: 0,
        integer: 0,
        bytes: view(bytes),
    };
    let _ = row(context, &cell, 1);
    0 // 验证宿主忽略回调错误时，Rust仍失败封闭。
}
unsafe extern "C" fn ok(_: *mut c_void) -> i32 {
    0
}
unsafe extern "C" fn end(_: *mut c_void, _: u8) -> i32 {
    0
}
fn config() -> CitizenSdkStoreV1 {
    CitizenSdkStoreV1 {
        struct_size: 64,
        abi_version: crate::abi::CITIZENSDK_ABI_VERSION,
        context: ptr::null_mut(),
        run: Some(once),
        execute: Some(execute),
        query: Some(query),
        begin: Some(ok),
        end: Some(end),
        wal: Some(ok),
    }
}
#[test]
fn database_job_must_execute_exactly_once() {
    for run in [
        once as unsafe extern "C" fn(*mut c_void, Job, *mut c_void) -> i32,
        twice,
        missing,
    ] {
        let mut config = config();
        config.run = Some(run);
        let db = unsafe { Sqlite::new(&config) }.unwrap();
        let mut calls = 0;
        let result = db.run(&mut |_| {
            calls += 1;
            Ok(())
        });
        assert_eq!(
            result.is_ok(),
            std::ptr::fn_addr_eq(
                run,
                once as unsafe extern "C" fn(*mut c_void, Job, *mut c_void) -> i32
            )
        );
        assert!(calls <= 1);
    }
}
#[test]
fn actual_fixed_job_failure_survives_host_code_without_changing_code_or_stage() {
    let config = config();
    let db = unsafe { Sqlite::new(&config) }.unwrap();
    for reason in [
        "public database schema version differs",
        "public database object set differs",
        "public database schema differs",
        "public database auto-vacuum differs",
        "public database durability setting differs",
        "public database trusted-schema setting differs",
        "embedded public schema is invalid",
        "host record corruption digest does not match",
        "host record belongs to a different typed store",
        "persisted wallet identity is invalid",
        "persisted cold identity is invalid",
        "persisted wallet order is duplicated",
        "persisted wallet state is invalid",
        "persisted wallet profile is invalid",
    ] {
        let mut calls = 0;
        let failure = db
            .run(&mut |_| {
                calls += 1;
                Err(crate::types::ContractError::at_stage(
                    Code::Integrity,
                    crate::types::FailureStage::Persistence,
                    reason,
                ))
            })
            .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(failure.code(), Code::Integrity);
        assert_eq!(failure.stage(), status(9).unwrap_err().stage());
        assert_eq!(failure.message(), reason);
    }
}
unsafe extern "C" fn reject_before_job(_: *mut c_void, _: Job, _: *mut c_void) -> i32 {
    14
}
unsafe extern "C" fn reject_after_job(_: *mut c_void, job: Job, context: *mut c_void) -> i32 {
    let _ = job(context);
    14
}
#[test]
fn host_failure_before_job_or_with_different_code_keeps_original_priority() {
    for (callback, expected_calls) in [
        (
            reject_before_job as unsafe extern "C" fn(*mut c_void, Job, *mut c_void) -> i32,
            0,
        ),
        (reject_after_job, 1),
    ] {
        for job_failed in [false, true] {
            let mut config = config();
            config.run = Some(callback);
            let db = unsafe { Sqlite::new(&config) }.unwrap();
            let mut calls = 0;
            let failure = db
                .run(&mut |_| {
                    calls += 1;
                    if job_failed {
                        Err(integrity("public database schema differs"))
                    } else {
                        Ok(())
                    }
                })
                .unwrap_err();
            assert_eq!(calls, expected_calls);
            assert_eq!(failure, status(14).unwrap_err());
        }
    }
}
#[test]
fn unknown_job_text_never_escapes_the_fixed_resource_failure() {
    let config = config();
    let db = unsafe { Sqlite::new(&config) }.unwrap();
    for message in [
        "synthetic-private-content",
        "public database schema differs synthetic-private-content",
    ] {
        let failure = db.run(&mut |_| Err(integrity(message))).unwrap_err();
        assert_eq!(failure, status(9).unwrap_err());
        assert!(!failure.message().contains("synthetic-private-content"));
    }
}
#[test]
fn query_copies_borrowed_cells_and_never_ignores_limits() {
    let config = config();
    let mut db = unsafe { Sqlite::new(&config) }.unwrap();
    assert_eq!(
        db.query("SELECT value", &[], 1, 6).unwrap()[0]
            .text(0, 6)
            .unwrap(),
        "SQLite"
    );
    assert!(db.query("SELECT value", &[], 0, 6).is_err());
    assert!(db.query("SELECT value", &[], 1, 5).is_err());
}
#[test]
fn version_and_incomplete_callbacks_fail_before_resource_calls() {
    let mut config = config();
    config.struct_size = 8;
    assert!(unsafe { Sqlite::new(&config) }.is_err());
    config.struct_size = 64;
    config.query = None;
    assert!(unsafe { Sqlite::new(&config) }.is_err());
}
#[test]
fn resource_group_layout_and_private_metadata_outputs_fail_closed() {
    assert_eq!(std::mem::size_of::<CitizenSdkStoresV1>(), 32);
    assert_eq!(std::mem::offset_of!(CitizenSdkStoresV1, secure), 16);
    assert_eq!(std::mem::offset_of!(CitizenSdkStoresV1, vault), 24);
    let mut key: crate::abi::types::CitizenSdkHostWalletKeyRefV1 = unsafe { std::mem::zeroed() };
    key.struct_size = 32;
    key.abi_version = crate::abi::CITIZENSDK_ABI_VERSION;
    key.reserved = 1;
    let mut output = 0xa5;
    assert_ne!(
        unsafe { citizensdk_store_generation(&config(), 2, &key, ptr::null(), &mut output) },
        0
    );
    assert_eq!(output, 0xa5);
    let short = [8u32, 1];
    assert!(unsafe { Stores::new(short.as_ptr().cast()) }.is_err());
}
unsafe extern "C" fn many(
    _: *mut c_void,
    _: CitizenSdkBytesView,
    _: *const CitizenSdkSqlValue,
    _: u64,
    _: u64,
    _: u64,
    row: RowCallback,
    context: *mut c_void,
) -> i32 {
    let cell = CitizenSdkSqlValue {
        kind: 3,
        reserved: 0,
        integer: 0,
        bytes: view(b"row"),
    };
    for _ in 0..3 {
        let code = row(context, &cell, 1);
        if code != 0 {
            return code;
        }
    }
    0
}
#[test]
fn streaming_stop_is_scoped_to_the_current_scan_and_query_keeps_total_budget() {
    let mut config = config();
    config.query = Some(many);
    let mut db = unsafe { Sqlite::new(&config) }.unwrap();
    let mut calls = 0;
    db.scan("SELECT value", &[], 3, 3, &mut |_| {
        calls += 1;
        Ok(true)
    })
    .unwrap();
    assert_eq!(calls, 1);
    assert!(db.query("SELECT value", &[], 3, 8).is_err());
    assert_eq!(db.query("SELECT value", &[], 3, 9).unwrap().len(), 3);
}
