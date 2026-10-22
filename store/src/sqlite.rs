//! SQLite薄接口。一个run在同一已有工作线程完成，不跨异步保留连接或Cursor。
use crate::error::{error, integrity};
use citizen_sdk_contracts::{ContractErrorCode, ContractResult};

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
