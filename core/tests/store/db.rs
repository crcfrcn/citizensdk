#![allow(unsafe_code)]
use crate::store::error::error;
use crate::store::sqlite::Connection;
use crate::store::sqlite::Database;
use crate::store::sqlite::Row;
use crate::store::sqlite::Value;
use crate::types::ContractErrorCode;
use crate::types::ContractResult;
use std::ffi::c_char;
use std::ffi::c_int;
use std::ffi::c_void;
use std::ffi::CString;
use std::ptr;
use std::sync::Arc;
use std::sync::Mutex;

#[link(name = "sqlite3")]
unsafe extern "C" {
    fn sqlite3_open(name: *const c_char, out: *mut *mut c_void) -> c_int;
    fn sqlite3_close(db: *mut c_void) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut c_void,
        sql: *const c_char,
        len: c_int,
        out: *mut *mut c_void,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
    fn sqlite3_bind_null(stmt: *mut c_void, i: c_int) -> c_int;
    fn sqlite3_bind_int64(stmt: *mut c_void, i: c_int, v: i64) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut c_void,
        i: c_int,
        p: *const c_char,
        n: c_int,
        d: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_bind_blob(
        stmt: *mut c_void,
        i: c_int,
        p: *const c_void,
        n: c_int,
        d: Option<unsafe extern "C" fn(*mut c_void)>,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_count(stmt: *mut c_void) -> c_int;
    fn sqlite3_column_type(stmt: *mut c_void, i: c_int) -> c_int;
    fn sqlite3_column_int64(stmt: *mut c_void, i: c_int) -> i64;
    fn sqlite3_column_blob(stmt: *mut c_void, i: c_int) -> *const u8;
    fn sqlite3_column_bytes(stmt: *mut c_void, i: c_int) -> c_int;
    fn sqlite3_changes64(db: *mut c_void) -> i64;
}
fn failure() -> crate::types::ContractError {
    error(ContractErrorCode::Storage, "test SQLite failed")
}
struct Statement(*mut c_void);
impl Drop for Statement {
    fn drop(&mut self) {
        unsafe {
            sqlite3_finalize(self.0);
        }
    }
}
pub struct Sqlite {
    db: *mut c_void,
    pub commit_error: bool,
    pub commit_landed: bool,
}

/// 同一真实SQLite夹具直接提供公开C资源表；不复制钱包、历史或链记录实现。
pub struct Resource {
    db: Db,
    current: std::cell::Cell<*mut Sqlite>,
}
// run持有原连接互斥锁，所有机械回调仅在同一同步job内借用current。
unsafe impl Send for Resource {}
unsafe impl Sync for Resource {}
impl Resource {
    pub fn new() -> Self {
        Self {
            db: Db::open(),
            current: std::cell::Cell::new(ptr::null_mut()),
        }
    }
    pub fn config(&self) -> crate::abi::CitizenSdkStoreV1 {
        crate::abi::CitizenSdkStoreV1 {
            struct_size: std::mem::size_of::<crate::abi::CitizenSdkStoreV1>() as u32,
            abi_version: crate::abi::CITIZENSDK_ABI_VERSION,
            context: (self as *const Self).cast_mut().cast(),
            run: Some(resource_run),
            execute: Some(resource_execute),
            query: Some(resource_query),
            begin: Some(resource_begin),
            end: Some(resource_end),
            wal: Some(resource_wal),
        }
    }
}
unsafe fn resource_values(raw: *const crate::abi::CitizenSdkSqlValue, count: u64) -> Vec<Value> {
    let values = if count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(raw, count as usize) }
    };
    values
        .iter()
        .map(|v| {
            let bytes = if v.bytes.len == 0 {
                &[]
            } else {
                unsafe { std::slice::from_raw_parts(v.bytes.data, v.bytes.len as usize) }
            };
            match v.kind {
                0 => Value::Null,
                1 => Value::Integer(v.integer),
                2 => Value::Text(std::str::from_utf8(bytes).unwrap().to_owned()),
                3 => Value::Blob(bytes.to_vec()),
                _ => panic!("SQL资源参数类型无效"),
            }
        })
        .collect()
}
unsafe fn resource_sql<'a>(view: crate::abi::CitizenSdkBytesView) -> &'a str {
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(view.data, view.len as usize) })
        .unwrap()
}
unsafe extern "C" fn resource_run(
    context: *mut c_void,
    job: unsafe extern "C" fn(*mut c_void) -> i32,
    argument: *mut c_void,
) -> i32 {
    let resource = unsafe { &*context.cast::<Resource>() };
    let mut guard = resource.db.0.lock().unwrap();
    assert!(resource.current.get().is_null());
    resource.current.set(&mut *guard);
    let result = unsafe { job(argument) };
    resource.current.set(ptr::null_mut());
    result
}
unsafe extern "C" fn resource_execute(
    context: *mut c_void,
    sql: crate::abi::CitizenSdkBytesView,
    values: *const crate::abi::CitizenSdkSqlValue,
    count: u64,
    changed: *mut u64,
) -> i32 {
    let resource = unsafe { &*context.cast::<Resource>() };
    match unsafe { &mut *resource.current.get() }.execute(unsafe { resource_sql(sql) }, &unsafe {
        resource_values(values, count)
    }) {
        Ok(value) => {
            unsafe { *changed = value };
            0
        }
        Err(_) => 14,
    }
}
unsafe extern "C" fn resource_query(
    context: *mut c_void,
    sql: crate::abi::CitizenSdkBytesView,
    values: *const crate::abi::CitizenSdkSqlValue,
    count: u64,
    rows: u64,
    bytes: u64,
    receive: unsafe extern "C" fn(*mut c_void, *const crate::abi::CitizenSdkSqlValue, u64) -> i32,
    receiver: *mut c_void,
) -> i32 {
    let resource = unsafe { &*context.cast::<Resource>() };
    let result = unsafe { &mut *resource.current.get() }.scan(
        unsafe { resource_sql(sql) },
        &unsafe { resource_values(values, count) },
        rows as usize,
        bytes as usize,
        &mut |row| {
            let values: Vec<_> = row
                .0
                .iter()
                .map(|v| {
                    let (kind, integer, data, len) = match v {
                        Value::Null => (0, 0, ptr::null(), 0),
                        Value::Integer(n) => (1, *n, ptr::null(), 0),
                        Value::Text(s) => (2, 0, s.as_ptr(), s.len()),
                        Value::Blob(b) => (3, 0, b.as_ptr(), b.len()),
                    };
                    crate::abi::CitizenSdkSqlValue {
                        kind,
                        reserved: 0,
                        integer,
                        bytes: crate::abi::CitizenSdkBytesView {
                            data,
                            len: len as u64,
                        },
                    }
                })
                .collect();
            match unsafe { receive(receiver, values.as_ptr(), values.len() as u64) } {
                0 => Ok(false),
                22 => Ok(true),
                _ => Err(failure()),
            }
        },
    );
    if result.is_ok() {
        0
    } else {
        14
    }
}
unsafe extern "C" fn resource_begin(context: *mut c_void) -> i32 {
    let resource = unsafe { &*context.cast::<Resource>() };
    if unsafe { &mut *resource.current.get() }.begin().is_ok() {
        0
    } else {
        14
    }
}
unsafe extern "C" fn resource_end(context: *mut c_void, commit: u8) -> i32 {
    let resource = unsafe { &*context.cast::<Resource>() };
    if unsafe { &mut *resource.current.get() }
        .end(commit == 1)
        .is_ok()
    {
        0
    } else {
        14
    }
}
unsafe extern "C" fn resource_wal(context: *mut c_void) -> i32 {
    let resource = unsafe { &*context.cast::<Resource>() };
    if unsafe { &mut *resource.current.get() }.wal().is_ok() {
        0
    } else {
        14
    }
}
// 每个连接只在Database的互斥锁内借用，SQLite不会跨线程并发调用。
unsafe impl Send for Sqlite {}
impl Drop for Sqlite {
    fn drop(&mut self) {
        unsafe {
            sqlite3_close(self.db);
        }
    }
}
impl Sqlite {
    fn prepare(&self, sql: &str, values: &[Value]) -> ContractResult<Statement> {
        let sql = CString::new(sql).map_err(|_| failure())?;
        let mut raw = ptr::null_mut();
        if unsafe { sqlite3_prepare_v2(self.db, sql.as_ptr(), -1, &mut raw, ptr::null_mut()) } != 0
        {
            return Err(failure());
        }
        let stmt = Statement(raw);
        for (i, value) in values.iter().enumerate() {
            let i = i as c_int + 1;
            let code = unsafe {
                match value {
                    Value::Null => sqlite3_bind_null(raw, i),
                    Value::Integer(n) => sqlite3_bind_int64(raw, i, *n),
                    Value::Text(s) => {
                        sqlite3_bind_text(raw, i, s.as_ptr().cast(), s.len() as c_int, None)
                    }
                    Value::Blob(b) => {
                        sqlite3_bind_blob(raw, i, b.as_ptr().cast(), b.len() as c_int, None)
                    }
                }
            };
            if code != 0 {
                return Err(failure());
            }
        }
        Ok(stmt)
    }
}
impl Connection for Sqlite {
    fn execute(&mut self, sql: &str, values: &[Value]) -> ContractResult<u64> {
        let stmt = self.prepare(sql, values)?;
        loop {
            match unsafe { sqlite3_step(stmt.0) } {
                100 => {}
                101 => break,
                _ => return Err(failure()),
            }
        }
        Ok(unsafe { sqlite3_changes64(self.db) } as u64)
    }
    fn scan(
        &mut self,
        sql: &str,
        values: &[Value],
        maximum: usize,
        budget: usize,
        visitor: &mut dyn FnMut(&Row) -> ContractResult<bool>,
    ) -> ContractResult<()> {
        let stmt = self.prepare(sql, values)?;
        let mut rows = 0;

        loop {
            match unsafe { sqlite3_step(stmt.0) } {
                101 => break,
                100 => {}
                _ => return Err(failure()),
            }
            if rows >= maximum {
                return Err(failure());
            }
            let mut cells = vec![];
            let mut size = 0;
            for i in 0..unsafe { sqlite3_column_count(stmt.0) } {
                let value = match unsafe { sqlite3_column_type(stmt.0, i) } {
                    5 => Value::Null,
                    1 => Value::Integer(unsafe { sqlite3_column_int64(stmt.0, i) }),
                    kind @ (3 | 4) => {
                        let n = unsafe { sqlite3_column_bytes(stmt.0, i) } as usize;
                        size += n;
                        if size > budget {
                            return Err(failure());
                        }
                        let p = unsafe { sqlite3_column_blob(stmt.0, i) };
                        let bytes = if n == 0 {
                            vec![]
                        } else {
                            unsafe { std::slice::from_raw_parts(p, n) }.to_vec()
                        };
                        if kind == 3 {
                            Value::Text(String::from_utf8(bytes).map_err(|_| failure())?)
                        } else {
                            Value::Blob(bytes)
                        }
                    }
                    _ => return Err(failure()),
                };
                cells.push(value);
            }
            rows += 1;
            if visitor(&Row(cells))? {
                break;
            }
        }
        Ok(())
    }
    fn begin(&mut self) -> ContractResult<()> {
        self.execute("BEGIN IMMEDIATE", &[]).map(|_| ())
    }
    fn end(&mut self, commit: bool) -> ContractResult<()> {
        if commit && self.commit_error {
            self.commit_error = false;
            if self.commit_landed {
                self.execute("COMMIT", &[])?;
            }
            return Err(failure());
        }
        self.execute(if commit { "COMMIT" } else { "ROLLBACK" }, &[])
            .map(|_| ())
    }
    fn wal(&mut self) -> ContractResult<()> {
        self.execute("PRAGMA journal_mode=WAL", &[]).map(|_| ())
    }
}
#[derive(Clone)]
pub struct Db(pub Arc<Mutex<Sqlite>>);
impl Db {
    pub fn open() -> Self {
        Self::named(c":memory:")
    }
    pub fn named(name: &std::ffi::CStr) -> Self {
        let mut db = ptr::null_mut();
        assert_eq!(unsafe { sqlite3_open(name.as_ptr(), &mut db) }, 0);
        Self(Arc::new(Mutex::new(Sqlite {
            db,
            commit_error: false,
            commit_landed: false,
        })))
    }
}
impl Database for Db {
    fn run(
        &self,
        job: &mut dyn FnMut(&mut dyn Connection) -> ContractResult<()>,
    ) -> ContractResult<()> {
        job(&mut *self.0.lock().unwrap())
    }
}

pub fn record(
    id: usize,
    time: u64,
    status: crate::types::HistoryTransactionStatus,
) -> crate::types::TransactionExecutionRecord {
    use crate::types::*;
    let call = vec![4, 0, (id % 256) as u8];
    let mut hash = [0; 32];
    hash[..16].copy_from_slice(&(id as u128).to_le_bytes());
    TransactionExecutionRecord::try_new(
        TransactionExecutionId::try_new((id as u128).to_le_bytes()).unwrap(),
        AccountId32::from_bytes([1; 32]),
        Hash32::from_bytes(blake2_256(&call).unwrap()),
        call,
        Hash32::from_bytes(hash),
        SignedExtrinsic::try_new(vec![4, 0x84]).unwrap(),
        VerifiedBlockRef::best(Hash32::from_bytes([7; 32]), 8),
        RuntimeVersion::new(100, 12),
        ChainIdentity::citizenchain().genesis_hash(),
        3,
        status,
        time,
        time,
    )
    .unwrap()
}
