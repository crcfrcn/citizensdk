//! SQLite同步资源。一个run在同一已有工作线程完成，不跨异步保留连接或Cursor。
use crate::store::error::error;
use crate::store::error::integrity;
use crate::types::ContractErrorCode;
use crate::types::ContractResult;

#[derive(Clone, Eq, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Text(String),
    Blob(Vec<u8>),
}

impl std::fmt::Debug for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不把持久化字节或SQL参数写入诊断。
        match self {
            Self::Null => f.write_str("Null"),
            Self::Integer(_) => f.write_str("Integer"),
            Self::Text(value) => f.debug_tuple("Text").field(&value.len()).finish(),
            Self::Blob(value) => f.debug_tuple("Blob").field(&value.len()).finish(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Row(pub Vec<Value>);

impl Row {
    pub fn integer(&self, index: usize, minimum: i64, maximum: i64) -> ContractResult<i64> {
        match self.0.get(index) {
            Some(Value::Integer(value)) if *value >= minimum && *value <= maximum => Ok(*value),
            _ => Err(error(
                ContractErrorCode::Storage,
                "SQLite integer type or range is invalid",
            )),
        }
    }
    pub fn text(&self, index: usize, maximum: usize) -> ContractResult<&str> {
        match self.0.get(index) {
            Some(Value::Text(value)) if value.len() <= maximum => Ok(value),
            _ => Err(error(
                ContractErrorCode::Storage,
                "SQLite text type or length is invalid",
            )),
        }
    }
    pub fn bytes(&self, index: usize, maximum: usize) -> ContractResult<&[u8]> {
        match self.0.get(index) {
            Some(Value::Blob(value)) if value.len() <= maximum => Ok(value),
            _ => Err(error(
                ContractErrorCode::Storage,
                "SQLite blob type or length is invalid",
            )),
        }
    }
}

/// 实现只负责SQLite调用，不解释仓储域、revision、历史状态或业务记录。
pub trait Connection {
    fn execute(&mut self, sql: &str, values: &[Value]) -> ContractResult<u64>;
    fn query(
        &mut self,
        sql: &str,
        values: &[Value],
        rows: usize,
        bytes: usize,
    ) -> ContractResult<Vec<Row>> {
        let mut output = vec![];
        let mut remaining = bytes;
        self.scan(sql, values, rows, bytes, &mut |row| {
            for value in &row.0 {
                let size = match value {
                    Value::Text(v) => v.len(),
                    Value::Blob(v) => v.len(),
                    _ => 0,
                };
                remaining = remaining
                    .checked_sub(size)
                    .ok_or_else(|| integrity("SQLite query byte budget exceeded"))?;
            }
            output.push(row.clone());
            Ok(false)
        })?;
        Ok(output)
    }
    /// 单条借用逐条消费；true只停止当前扫描，不是事务/请求取消。bytes为每条上限。
    fn scan(
        &mut self,
        sql: &str,
        values: &[Value],
        rows: usize,
        bytes: usize,
        visitor: &mut dyn FnMut(&Row) -> ContractResult<bool>,
    ) -> ContractResult<()>;
    fn begin(&mut self) -> ContractResult<()>;
    /// 提交前检查文件安全；成功提交后不得追加可失败的检查。
    fn end(&mut self, commit: bool) -> ContractResult<()>;
    /// Android通过公开enableWriteAheadLogging配置连接池，其他平台使用SQLite C接口。
    fn wal(&mut self) -> ContractResult<()>;
}

/// SDK的异步请求已在工作线程执行；资源调用及借用严格限于本次同步run。
/// 实现必须持有同一数据库资源、当前线程会话和平台锁，并恰好调用job一次；事务内不得切换底层连接。
pub trait Database: Send + Sync {
    fn run(
        &self,
        job: &mut dyn FnMut(&mut dyn Connection) -> ContractResult<()>,
    ) -> ContractResult<()>;
}

pub fn transaction<T>(
    connection: &mut dyn Connection,
    operation: impl FnOnce(&mut dyn Connection) -> ContractResult<T>,
) -> ContractResult<T> {
    connection.begin()?;
    match operation(connection) {
        Ok(value) => match connection.end(true) {
            Ok(()) => Ok(value),
            Err(value) => {
                let _ = connection.end(false);
                Err(value)
            }
        },
        Err(value) => {
            let _ = connection.end(false);
            Err(value)
        }
    }
}

/// 仅在COMMIT返回错误时核对准确写入结果；普通CAS冲突不被当作成功。
pub fn transaction_recover<T>(
    connection: &mut dyn Connection,
    operation: impl FnOnce(&mut dyn Connection) -> ContractResult<T>,
    recover: impl FnOnce(&mut dyn Connection, &T) -> ContractResult<bool>,
) -> ContractResult<T> {
    connection.begin()?;
    let value = match operation(connection) {
        Ok(value) => value,
        Err(value) => {
            let _ = connection.end(false);
            return Err(value);
        }
    };
    match connection.end(true) {
        Ok(()) => Ok(value),
        Err(failure) => {
            let _ = connection.end(false);
            if recover(connection, &value).unwrap_or(false) {
                Ok(value)
            } else {
                Err(failure)
            }
        }
    }
}

pub fn scalar(connection: &mut dyn Connection, sql: &str) -> ContractResult<i64> {
    let rows = connection.query(sql, &[], 1, 1024)?;
    if rows.len() != 1 {
        return Err(integrity("SQLite scalar result is missing"));
    }
    rows[0].integer(0, 0, i64::MAX)
}

// 原生SQLite调用与SQL操作在同一所有者内直接执行。

// 同步SQLite资源边界；业务SQL、schema和记录解释只归Rust Store。
use crate::abi::error::catch_native_panic;
use crate::abi::error::FfiError;
use crate::abi::error::FfiResult;
use crate::abi::types::CitizenSdkBytesView;
use crate::types::ContractErrorCode as Code;
use std::ffi::c_void;
use std::ptr;
use std::slice;

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
    pub vault: *const crate::abi::types::CitizenSdkHostSecretVaultV1,
}
pub(crate) struct Stores {
    pub public: Option<Sqlite>,
    pub secure: Option<Sqlite>,
    pub vault: Option<crate::host::HostSecretVault>,
}
impl Stores {
    pub(crate) unsafe fn new(config: *const CitizenSdkStoresV1) -> FfiResult<Self> {
        let config = crate::abi::read_versioned(config, "store configuration")?;
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
                    crate::host::HostSecretVault::from_vault(config.vault)
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
        if size as usize != std::mem::size_of::<CitizenSdkStoreV1>()
            || version != crate::abi::types::CITIZENSDK_ABI_VERSION
        {
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
    let code = crate::host::decode_host_error_code(value)
        .unwrap_or(crate::abi::types::CitizenSdkErrorCode::Internal);
    if code == crate::abi::types::CitizenSdkErrorCode::Ok {
        Ok(())
    } else {
        Err(crate::host::host_error(
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
fn callback<T>(value: Option<T>) -> ContractResult<T> {
    value.ok_or_else(|| integrity("validated SQLite callback missing"))
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
            (callback(self.0.run)?)(self.0.context, run_job, (&mut work as *mut Work<'_>).cast())
        };
        if let Err(failure) = status(code) {
            // 宿主返回码和阶段仍优先；只补传同码job已实际产生的固定诊断。
            // 未知文本不回显，不改变SQL、事务、清理或成功/失败控制流。
            if let Some(Err(inner)) = work.result.as_ref() {
                if inner.code() == failure.code()
                    && matches!(
                        inner.message(),
                        "public database schema version differs"
                            | "public database object set differs"
                            | "public database schema differs"
                            | "public database auto-vacuum differs"
                            | "public database durability setting differs"
                            | "public database trusted-schema setting differs"
                            | "embedded public schema is invalid"
                            | "host record corruption digest does not match"
                            | "host record belongs to a different typed store"
                            | "persisted wallet identity is invalid"
                            | "persisted cold identity is invalid"
                            | "persisted wallet order is duplicated"
                            | "persisted wallet state is invalid"
                            | "persisted wallet profile is invalid"
                    )
                {
                    return Err(crate::types::ContractError::at_stage(
                        failure.code(),
                        failure.stage(),
                        inner.message(),
                    ));
                }
            }
            return Err(failure);
        }
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
    failure: Option<crate::types::ContractError>,
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
            (callback(self.0.execute)?)(
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
            (callback(self.0.query)?)(
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
        status(unsafe { (callback(self.0.begin)?)(self.0.context) })
    }
    fn end(&mut self, commit: bool) -> ContractResult<()> {
        status(unsafe { (callback(self.0.end)?)(self.0.context, u8::from(commit)) })
    }
    fn wal(&mut self) -> ContractResult<()> {
        status(unsafe { (callback(self.0.wal)?)(self.0.context) })
    }
}

// 平台硬件金库只借用既有数据库资源访问同一Rust状态规则；无新实例/结果表。
fn secure_resource(
    config: *const CitizenSdkStoreV1,
) -> FfiResult<crate::store::SecureStore<Sqlite>> {
    Ok(crate::store::SecureStore::new(unsafe {
        Sqlite::new(config)?
    }))
}
unsafe fn vault_key(
    key: *const crate::abi::types::CitizenSdkHostWalletKeyRefV1,
) -> FfiResult<crate::store::vault::Key> {
    if key.is_null() {
        return Err(FfiError::invalid("vault key is null"));
    }
    let key = crate::abi::read_versioned(key, "vault key")?;
    if key.reserved != 0 {
        return Err(FfiError::invalid("vault key reserved field differs"));
    }
    Ok(crate::store::vault::Key {
        index: key.wallet_index,
        generation: crate::types::VaultGeneration::from_bytes(key.generation.bytes),
    })
}
/// 同步硬件SQL操作只借用本次配置与输入。
/// # Safety
/// 配置、身份、输入和输出指针须满足声明大小/容量并在本次调用内有效；
/// 数据库回调保持同线程、同步完成，不保留借用单元格或缓冲。
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_generation(
    config: *const CitizenSdkStoreV1,
    action: u32,
    key: *const crate::abi::types::CitizenSdkHostWalletKeyRefV1,
    operation: *const crate::abi::types::CitizenSdkHostId128,
    out: *mut u8,
) -> i32 {
    crate::abi::ffi_status(|| {
        crate::abi::require_output(out, "vault status")?;
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
/// 同步硬件SQL操作只借用本次配置与输入。
/// # Safety
/// 配置、身份、输入和输出指针须满足声明大小/容量并在本次调用内有效；
/// 数据库回调保持同线程、同步完成，不保留借用单元格或缓冲。
/// 同步硬件SQL操作只借用本次配置与输入。
/// # Safety
/// 配置、身份、输入和输出指针须满足声明大小/容量并在本次调用内有效；
/// 数据库回调保持同线程、同步完成，不保留借用单元格或缓冲。
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_generations(
    config: *const CitizenSdkStoreV1,
    output: *mut crate::abi::types::CitizenSdkHostWalletKeyRefV1,
    capacity: u64,
    required: *mut u64,
) -> i32 {
    crate::abi::ffi_status(|| {
        crate::abi::require_output(required, "generation count")?;
        let values = secure_resource(config)?.generations()?;
        if capacity < values.len() as u64 || (!values.is_empty() && output.is_null()) {
            return Err(FfiError::invalid("generation output is too small"));
        }
        for (i, value) in values.iter().enumerate() {
            ptr::write(
                output.add(i),
                crate::abi::types::CitizenSdkHostWalletKeyRefV1 {
                    struct_size: std::mem::size_of::<crate::abi::types::CitizenSdkHostWalletKeyRefV1>(
                    ) as u32,
                    abi_version: crate::abi::types::CITIZENSDK_ABI_VERSION,
                    reserved: 0,
                    wallet_index: value.index,
                    generation: crate::abi::types::CitizenSdkHostId128 {
                        bytes: *value.generation.as_bytes(),
                    },
                },
            );
        }
        ptr::write(required, values.len() as u64);
        Ok(())
    })
}

/// 同步硬件SQL操作只借用本次配置与输入。
/// # Safety
/// 配置、身份、输入和输出指针须满足声明大小/容量并在本次调用内有效；
/// 数据库回调保持同线程、同步完成，不保留借用单元格或缓冲。
#[no_mangle]
pub unsafe extern "C" fn citizensdk_store_object(
    config: *const CitizenSdkStoreV1,
    action: u32,
    key: *const crate::abi::types::CitizenSdkHostWalletKeyRefV1,
    operation: *const crate::abi::types::CitizenSdkHostId128,
    input: *const CitizenSdkBytesView,
    output: *const crate::abi::types::CitizenSdkMutableBytesView,
    lengths: *mut u64,
    present: *mut u8,
) -> i32 {
    crate::abi::ffi_status(|| {
        crate::abi::require_output(present, "object presence")?;
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
                bytes.push(crate::abi::copy_view(*field, "vault object", bound)?);
            }
            let key_name = String::from_utf8(bytes.remove(0))
                .map_err(|_| FfiError::invalid("object key name is not UTF-8"))?;
            Some(crate::store::vault::Object {
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
                crate::abi::require_output(lengths, "object lengths")?;
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
                store.store_object(
                    key,
                    operation,
                    value.ok_or_else(|| FfiError::invalid("hardware object value missing"))?,
                )?;
                ptr::write(present, 1);
            }
            3 => {
                ptr::write(
                    present,
                    u8::from(store.object_is_active(
                        key,
                        &value.ok_or_else(|| FfiError::invalid("hardware object value missing"))?,
                    )?),
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
#[path = "../../tests/abi/store.rs"]
mod tests;
