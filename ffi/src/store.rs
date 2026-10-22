//! 同步SQLite资源边界；业务SQL、schema和记录解释只归Rust Store。
use crate::{
    abi::CitizenSdkBytesView,
    error::{catch_native_panic, FfiError, FfiResult},
};
use citizen_sdk_contracts::{ContractErrorCode as Code, ContractResult};
use citizen_sdk_store::{
    error::{error, integrity},
    sqlite::{Connection, Database, Row, Value},
};
use std::{ffi::c_void, ptr, slice};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CitizenSdkSqlValue {
    pub kind: u32,
    pub reserved: u32,
    pub integer: i64,
    pub bytes: CitizenSdkBytesView,
}
pub type Job = unsafe extern "C" fn(*mut c_void) -> i32;
pub type RowCallback = unsafe extern "C" fn(*mut c_void, *const CitizenSdkSqlValue, u64) -> i32;
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CitizenSdkStoreV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub context: *mut c_void,
    pub run: Option<unsafe extern "C" fn(*mut c_void, Job, *mut c_void) -> i32>,
    pub execute: Option<
        unsafe extern "C" fn(
            *mut c_void,
            CitizenSdkBytesView,
            *const CitizenSdkSqlValue,
            u64,
            *mut u64,
        ) -> i32,
    >,
    pub query: Option<
        unsafe extern "C" fn(
            *mut c_void,
            CitizenSdkBytesView,
            *const CitizenSdkSqlValue,
            u64,
            u64,
            u64,
            RowCallback,
            *mut c_void,
        ) -> i32,
    >,
    pub begin: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub end: Option<unsafe extern "C" fn(*mut c_void, u8) -> i32>,
    pub wal: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct CitizenSdkStoresV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub public: *const CitizenSdkStoreV1,
    pub secure: *const CitizenSdkStoreV1,
    pub vault: *const crate::abi::CitizenSdkHostSecretVaultV1,
}
pub(crate) struct Stores {
    pub public: Option<Sqlite>,
    pub secure: Option<Sqlite>,
    pub vault: Option<crate::host_providers::HostServicesAdapter>,
}
impl Stores {
    pub(crate) unsafe fn new(config: *const CitizenSdkStoresV1) -> FfiResult<Self> {
        let config = crate::read_versioned(config, "store configuration")?;
        Ok(Self {
            public: if config.public.is_null() {
                None
            } else {
                Some(Sqlite::new(config.public)?)
            },
            secure: if config.secure.is_null() {
                None
            } else {
                Some(Sqlite::new(config.secure)?)
            },
            vault: if config.vault.is_null() {
                None
            } else {
                Some(
                    crate::host_providers::HostServicesAdapter::from_vault(config.vault)
                        .map_err(FfiError::from)?,
                )
            },
        })
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Sqlite(CitizenSdkStoreV1);
// 配置的宿主合同保证run串行化连接，回调同步结束且上下文存活到Core完全销毁。
unsafe impl Send for Sqlite {}
unsafe impl Sync for Sqlite {}
impl Sqlite {
    pub(crate) unsafe fn new(config: *const CitizenSdkStoreV1) -> FfiResult<Self> {
        if config.is_null() {
            return Err(FfiError::invalid("SQLite resource is null"));
        }
        // 先读取公共头，禁止在尺寸不足时读取整个结构。
        let size = ptr::read(config.cast::<u32>());
        let version = ptr::read(config.cast::<u32>().add(1));
        if size as usize != std::mem::size_of::<CitizenSdkStoreV1>() || version != 1 {
            return Err(FfiError::invalid("SQLite resource version differs"));
        }
        let value = ptr::read(config);
        if value.run.is_none()
            || value.execute.is_none()
            || value.query.is_none()
            || value.begin.is_none()
            || value.end.is_none()
            || value.wal.is_none()
        {
            return Err(FfiError::invalid(
                "SQLite resource callbacks are incomplete",
            ));
        }
        Ok(Self(value))
    }
}
fn status(value: i32) -> ContractResult<()> {
    let code = crate::host_providers::decode_host_error_code(value)
        .unwrap_or(crate::abi::CitizenSdkErrorCode::Internal);
    if code == crate::abi::CitizenSdkErrorCode::Ok {
        Ok(())
    } else {
        Err(crate::host_providers::host_error(
            code,
            "SQLite resource operation failed",
        ))
    }
}

fn view(bytes: &[u8]) -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    }
}
fn parameters(values: &[Value]) -> Vec<CitizenSdkSqlValue> {
    values
        .iter()
        .map(|value| {
            let (kind, integer, bytes) = match value {
                Value::Null => (0, 0, &[][..]),
                Value::Integer(n) => (1, *n, &[][..]),
                Value::Text(s) => (2, 0, s.as_bytes()),
                Value::Blob(b) => (3, 0, b.as_slice()),
            };
            CitizenSdkSqlValue {
                kind,
                reserved: 0,
                integer,
                bytes: view(bytes),
            }
        })
        .collect()
}
struct Work<'a> {
    database: Sqlite,
    job: &'a mut dyn FnMut(&mut dyn Connection) -> ContractResult<()>,
    result: Option<ContractResult<()>>,
}
unsafe extern "C" fn run_job(context: *mut c_void) -> i32 {
    let work = &mut *context.cast::<Work<'_>>();
    if work.result.is_some() {
        work.result = Some(Err(integrity("SQLite job executed twice")));
        return 9;
    }
    let result = catch_native_panic(|| (work.job)(&mut work.database))
        .unwrap_or_else(|_| Err(error(Code::Internal, "SQLite job panicked")));
    let code = result
        .as_ref()
        .map_or_else(|e| FfiError::from(e.clone()).code as i32, |_| 0);
    work.result = Some(result);
    code
}
impl Database for Sqlite {
    fn run(
        &self,
        job: &mut dyn FnMut(&mut dyn Connection) -> ContractResult<()>,
    ) -> ContractResult<()> {
        let mut work = Work {
            database: *self,
            job,
            result: None,
        };
        let code = unsafe {
            self.0.run.unwrap()(self.0.context, run_job, (&mut work as *mut Work<'_>).cast())
        };
        status(code)?;
        work.result
            .ok_or_else(|| integrity("SQLite job was not executed"))?
    }
}
struct Rows<'a> {
    visitor: &'a mut dyn FnMut(&Row) -> ContractResult<bool>,
    count: usize,
    stopped: bool,
    maximum: usize,
    budget: usize,
    failure: Option<citizen_sdk_contracts::ContractError>,
}
unsafe extern "C" fn receive_row(
    context: *mut c_void,
    cells: *const CitizenSdkSqlValue,
    count: u64,
) -> i32 {
    let rows = &mut *context.cast::<Rows<'_>>();
    if rows.failure.is_some() || rows.stopped {
        return 9;
    }
    let mut remaining = rows.budget;
    let result = catch_native_panic(|| -> ContractResult<()> {
        if count > 64 || (count != 0 && cells.is_null()) || rows.count >= rows.maximum {
            return Err(integrity("SQLite row limit differs"));
        }
        let cells = if count == 0 {
            &[]
        } else {
            slice::from_raw_parts(cells, count as usize)
        };
        let mut values = Vec::with_capacity(cells.len());
        for cell in cells {
            if cell.reserved != 0 {
                return Err(integrity("SQLite cell reserved field differs"));
            }
            let value = match cell.kind {
                0 => Value::Null,
                1 => Value::Integer(cell.integer),
                2 | 3 => {
                    let size = usize::try_from(cell.bytes.len)
                        .map_err(|_| integrity("SQLite cell length overflow"))?;
                    remaining = remaining
                        .checked_sub(size)
                        .ok_or_else(|| integrity("SQLite byte budget exceeded"))?;
                    if size != 0 && cell.bytes.data.is_null() {
                        return Err(integrity("SQLite cell pointer is null"));
                    }
                    let bytes = if size == 0 {
                        &[]
                    } else {
                        slice::from_raw_parts(cell.bytes.data, size)
                    };
                    if cell.kind == 2 {
                        Value::Text(
                            std::str::from_utf8(bytes)
                                .map_err(|_| integrity("SQLite text is not UTF-8"))?
                                .to_owned(),
                        )
                    } else {
                        Value::Blob(bytes.to_vec())
                    }
                }
                _ => return Err(integrity("SQLite value type differs")),
            };
            values.push(value);
        }
        rows.count += 1;
        rows.stopped = (rows.visitor)(&Row(values))?;
        Ok(())
    })
    .unwrap_or_else(|_| Err(error(Code::Internal, "SQLite row copy panicked")));
    match result {
        Ok(()) => {
            if rows.stopped {
                22
            } else {
                0
            }
        }
        Err(failure) => {
            let code = FfiError::from(failure.clone()).code as i32;
            rows.failure = Some(failure);
            code
        }
    }
}
impl Connection for Sqlite {
    fn execute(&mut self, sql: &str, values: &[Value]) -> ContractResult<u64> {
        let values = parameters(values);
        let mut changes = 0;
        status(unsafe {
            self.0.execute.unwrap()(
                self.0.context,
                view(sql.as_bytes()),
                values.as_ptr(),
                values.len() as u64,
                &mut changes,
            )
        })?;
        Ok(changes)
    }
    fn scan(
        &mut self,
        sql: &str,
        values: &[Value],
        maximum: usize,
        budget: usize,
        visitor: &mut dyn FnMut(&Row) -> ContractResult<bool>,
    ) -> ContractResult<()> {
        let values = parameters(values);
        let mut rows = Rows {
            visitor,
            count: 0,
            stopped: false,
            maximum,
            budget,
            failure: None,
        };
        let code = unsafe {
            self.0.query.unwrap()(
                self.0.context,
                view(sql.as_bytes()),
                values.as_ptr(),
                values.len() as u64,
                maximum as u64,
                budget as u64,
                receive_row,
                (&mut rows as *mut Rows<'_>).cast(),
            )
        };
        if let Some(failure) = rows.failure {
            return Err(failure);
        }
        if rows.stopped {
            if code != 22 {
                return Err(integrity("SQLite row stop was not respected"));
            }
            return Ok(());
        }
        status(code)?;
        Ok(())
    }
    fn begin(&mut self) -> ContractResult<()> {
        status(unsafe { self.0.begin.unwrap()(self.0.context) })
    }
    fn end(&mut self, commit: bool) -> ContractResult<()> {
        status(unsafe { self.0.end.unwrap()(self.0.context, u8::from(commit)) })
    }
    fn wal(&mut self) -> ContractResult<()> {
        status(unsafe { self.0.wal.unwrap()(self.0.context) })
    }
}

// 平台硬件金库只借用既有数据库资源访问同一Rust状态规则；无新实例/结果表。
fn secure_resource(
    config: *const CitizenSdkStoreV1,
) -> FfiResult<citizen_sdk_store::SecureStore<Sqlite>> {
    Ok(citizen_sdk_store::SecureStore::new(unsafe {
        Sqlite::new(config)?
    }))
}
unsafe fn vault_key(
    key: *const crate::abi::CitizenSdkHostWalletKeyRefV1,
) -> FfiResult<citizen_sdk_store::vault::Key> {
    if key.is_null() {
        return Err(FfiError::invalid("vault key is null"));
    }
    let key = crate::read_versioned(key, "vault key")?;
    if key.reserved != 0 {
        return Err(FfiError::invalid("vault key reserved field differs"));
    }
    Ok(citizen_sdk_store::vault::Key {
        index: key.wallet_index,
        generation: citizen_sdk_contracts::VaultGeneration::from_bytes(key.generation.bytes),
    })
}
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_generation(
    config: *const CitizenSdkStoreV1,
    action: u32,
    key: *const crate::abi::CitizenSdkHostWalletKeyRefV1,
    operation: *const crate::abi::CitizenSdkHostId128,
    out: *mut u8,
) -> i32 {
    crate::ffi_status(|| {
        crate::require_output(out, "vault status")?;
        let key = vault_key(key)?;
        if matches!(action, 1 | 3 | 4) && operation.is_null() {
            return Err(FfiError::invalid("vault operation is null"));
        }
        let operation = if operation.is_null() {
            [0; 16]
        } else {
            (*operation).bytes
        };
        let store = secure_resource(config)?;
        let value = match action {
            1 => store.ensure_generation(key, operation)?,
            2 => store.is_active(key)?,
            3 => store.generation_owned_by(key, operation)?,
            4 => {
                store.retire_generation(key, operation)?;
                true
            }
            5 => store.has_object_key(key.index)?,
            _ => return Err(FfiError::invalid("vault generation action differs")),
        };
        ptr::write(out, u8::from(value));
        Ok(())
    })
}
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_generations(
    config: *const CitizenSdkStoreV1,
    output: *mut crate::abi::CitizenSdkHostWalletKeyRefV1,
    capacity: u64,
    required: *mut u64,
) -> i32 {
    crate::ffi_status(|| {
        crate::require_output(required, "generation count")?;
        let values = secure_resource(config)?.generations()?;
        if capacity < values.len() as u64 || (!values.is_empty() && output.is_null()) {
            return Err(FfiError::invalid("generation output is too small"));
        }
        for (i, value) in values.iter().enumerate() {
            ptr::write(
                output.add(i),
                crate::abi::CitizenSdkHostWalletKeyRefV1 {
                    struct_size: std::mem::size_of::<crate::abi::CitizenSdkHostWalletKeyRefV1>()
                        as u32,
                    abi_version: 1,
                    reserved: 0,
                    wallet_index: value.index,
                    generation: crate::abi::CitizenSdkHostId128 {
                        bytes: *value.generation.as_bytes(),
                    },
                },
            );
        }
        ptr::write(required, values.len() as u64);
        Ok(())
    })
}
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_has_secret(
    config: *const CitizenSdkStoreV1,
    account: *const crate::abi::CitizenSdkAccountId,
    out: *mut u8,
) -> i32 {
    crate::ffi_status(|| {
        use citizen_sdk_contracts::EncryptedSecretBlobStore;
        crate::require_output(out, "secret presence")?;
        if account.is_null() {
            return Err(FfiError::invalid("account is null"));
        }
        let value = futures_executor::block_on(secure_resource(config)?.has_account_secret(
            citizen_sdk_contracts::AccountId32::from_bytes((*account).bytes),
        ))?;
        ptr::write(out, u8::from(value));
        Ok(())
    })
}
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_object(
    config: *const CitizenSdkStoreV1,
    action: u32,
    key: *const crate::abi::CitizenSdkHostWalletKeyRefV1,
    operation: *const crate::abi::CitizenSdkHostId128,
    input: *const CitizenSdkBytesView,
    output: *const crate::abi::CitizenSdkMutableBytesView,
    lengths: *mut u64,
    present: *mut u8,
) -> i32 {
    crate::ffi_status(|| {
        crate::require_output(present, "object presence")?;
        let key = vault_key(key)?;
        let store = secure_resource(config)?;
        let operation = if operation.is_null() {
            [0; 16]
        } else {
            (*operation).bytes
        };
        let value = if matches!(action, 2 | 3) {
            if input.is_null() {
                return Err(FfiError::invalid("object fields missing"));
            }
            let fields = slice::from_raw_parts(input, 5);
            let bounds = [43, 8192, 8192, 1024, 16];
            let mut bytes = Vec::with_capacity(5);
            for (field, bound) in fields.iter().zip(bounds) {
                bytes.push(crate::copy_view(*field, "vault object", bound)?);
            }
            let key_name = String::from_utf8(bytes.remove(0))
                .map_err(|_| FfiError::invalid("object key name is not UTF-8"))?;
            Some(citizen_sdk_store::vault::Object {
                key_name,
                public: bytes.remove(0),
                private: bytes.remove(0),
                name: bytes.remove(0),
                salt: bytes.remove(0),
            })
        } else {
            None
        };
        match action {
            1 => {
                crate::require_output(lengths, "object lengths")?;
                if output.is_null() {
                    return Err(FfiError::invalid("object buffers missing"));
                }
                let value = store.load_object(key)?;
                let fields: [&[u8]; 5] = if let Some(value) = value.as_ref() {
                    [
                        value.key_name.as_bytes(),
                        &value.public,
                        &value.private,
                        &value.name,
                        &value.salt,
                    ]
                } else {
                    [&[]; 5]
                };
                let buffers = slice::from_raw_parts(output, 5);
                for (field, buffer) in fields.iter().zip(buffers) {
                    if field.len() as u64 > buffer.len
                        || (!field.is_empty() && buffer.data.is_null())
                    {
                        return Err(FfiError::invalid("object output too small"));
                    }
                }
                for (i, (field, buffer)) in fields.iter().zip(buffers).enumerate() {
                    if !field.is_empty() {
                        ptr::copy_nonoverlapping(field.as_ptr(), buffer.data, field.len());
                    }
                    ptr::write(lengths.add(i), field.len() as u64);
                }
                ptr::write(present, u8::from(value.is_some()));
            }
            2 => {
                store.store_object(key, operation, value.unwrap())?;
                ptr::write(present, 1);
            }
            3 => {
                ptr::write(
                    present,
                    u8::from(store.object_is_active(key, &value.unwrap())?),
                );
            }
            4 => {
                store.delete_object(key)?;
                ptr::write(present, 0);
            }
            _ => return Err(FfiError::invalid("vault object action differs")),
        }
        Ok(())
    })
}
#[cfg(test)]
mod tests {
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
            abi_version: 1,
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
        let mut key: crate::abi::CitizenSdkHostWalletKeyRefV1 = unsafe { std::mem::zeroed() };
        key.struct_size = 32;
        key.abi_version = 1;
        key.reserved = 1;
        let mut output = 0xa5;
        assert_ne!(
            unsafe { citizensdk_store_generation(&config(), 2, &key, ptr::null(), &mut output) },
            0
        );
        assert_eq!(output, 0xa5);
        assert_ne!(
            unsafe { citizensdk_store_has_secret(&config(), ptr::null(), &mut output) },
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
}
