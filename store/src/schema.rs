//! 原public-state-v1.sqlite3格式；不升级或重建现有数据库。
use crate::{
    error::integrity,
    sqlite::{scalar, transaction, Connection, Value},
};
use citizen_sdk_contracts::ContractResult;
pub const VERSION: i64 = 2;
pub const STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS singleton_records (domain INTEGER PRIMARY KEY CHECK(domain = 1), revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 524288))",
    "CREATE TABLE IF NOT EXISTS runtime_cache (record_key TEXT PRIMARY KEY, record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 8388608))",
    "CREATE TABLE IF NOT EXISTS transaction_history_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision > 0), record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 4096), durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 0 AND 32505856), open_count INTEGER NOT NULL CHECK(open_count BETWEEN 0 AND record_count), open_weight INTEGER NOT NULL CHECK(open_weight BETWEEN 0 AND durable_weight))",
    "CREATE TABLE IF NOT EXISTS transaction_history_records (execution_id TEXT PRIMARY KEY CHECK(length(execution_id) = 32 AND execution_id NOT GLOB '*[^0-9a-f]*'), created_at_millis INTEGER NOT NULL CHECK(created_at_millis >= 0), updated_at_millis INTEGER NOT NULL CHECK(updated_at_millis >= created_at_millis), durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 1 AND 32505856), retention_terminal INTEGER NOT NULL CHECK(retention_terminal IN (0,1)), chain_terminal INTEGER NOT NULL CHECK(chain_terminal IN (0,1) AND chain_terminal <= retention_terminal), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 33554432))",
    "CREATE INDEX IF NOT EXISTS transaction_history_newest_idx ON transaction_history_records(created_at_millis DESC, execution_id DESC)",
    "CREATE INDEX IF NOT EXISTS transaction_history_retention_idx ON transaction_history_records(retention_terminal, created_at_millis, execution_id)",
    "CREATE INDEX IF NOT EXISTS transaction_history_reconcile_idx ON transaction_history_records(chain_terminal, created_at_millis, execution_id)",
];

fn canonical(value: &str) -> String {
    let mut output = String::new();
    let mut chars = value.chars().peekable();
    let mut quote = None;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            output.push(c);
            let end = if q == '[' { ']' } else { q };
            if c == end {
                if q != '[' && chars.peek() == Some(&end) {
                    output.push(chars.next().unwrap());
                } else {
                    quote = None;
                }
            }
        } else if matches!(c, '\'' | '"' | '\x60' | '[') {
            quote = Some(c);
            output.push(c);
        } else if !c.is_ascii_whitespace() {
            output.push(c.to_ascii_lowercase());
        }
    }
    for prefix in ["createtable", "createindex"] {
        let optional = format!("{prefix}ifnotexists");
        if output.starts_with(&optional) {
            return format!("{prefix}{}", &output[optional.len()..]);
        }
    }
    output
}

fn settings(connection: &mut dyn Connection, secure: bool) -> ContractResult<()> {
    for sql in [
        "PRAGMA busy_timeout=5000",
        "PRAGMA temp_store=MEMORY",
        "PRAGMA trusted_schema=OFF",
        "PRAGMA wal_autocheckpoint=1000",
    ] {
        connection.execute(sql, &[])?;
    }
    connection.execute(
        if secure {
            "PRAGMA secure_delete=ON"
        } else {
            "PRAGMA secure_delete=OFF"
        },
        &[],
    )?;
    Ok(())
}
fn objects(connection: &mut dyn Connection, android: bool) -> ContractResult<i64> {
    scalar(
        connection,
        if android {
            // NO_LOCALIZED_COLLATORS不再创建此表；已有Android系统元数据保持原样。
            "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND NOT(type = 'table' AND name = 'android_metadata')"
        } else {
            "SELECT count(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'"
        },
    )
}
pub fn initialize(connection: &mut dyn Connection, android: bool) -> ContractResult<()> {
    initialize_schema(connection, STATEMENTS, VERSION, 2, android, false)
}

pub(crate) fn initialize_schema(
    connection: &mut dyn Connection,
    statements: &[&str],
    version_expected: i64,
    vacuum: i64,
    android: bool,
    secure: bool,
) -> ContractResult<()> {
    settings(connection, secure)?;
    let version = scalar(connection, "PRAGMA user_version")?;
    let count = objects(connection, android)?;
    if version == 0 && count == 0 {
        connection.execute(
            if vacuum == 2 {
                "PRAGMA auto_vacuum=INCREMENTAL"
            } else {
                "PRAGMA auto_vacuum=NONE"
            },
            &[],
        )?;
        transaction(connection, |connection| {
            // 另一个实例可能已先完成初始化；在写锁内重新检查。
            let version = scalar(connection, "PRAGMA user_version")?;
            let count = objects(connection, android)?;
            if version == 0 && count == 0 {
                for sql in statements {
                    connection.execute(sql, &[])?;
                }
                connection.execute(&format!("PRAGMA user_version={version_expected}"), &[])?;
            } else if version != version_expected {
                return Err(integrity("public database schema version differs"));
            }
            Ok(())
        })?;
    } else if version != version_expected {
        return Err(integrity("public database schema version differs"));
    }
    if scalar(connection, "PRAGMA user_version")? != version_expected
        || objects(connection, android)? != statements.len() as i64
    {
        return Err(integrity("public database object set differs"));
    }
    for expected in statements {
        let (kind, prefix, delimiter) = if expected.starts_with("CREATE TABLE") {
            ("table", "CREATE TABLE IF NOT EXISTS ", '(')
        } else {
            ("index", "CREATE INDEX IF NOT EXISTS ", ' ')
        };
        let name = expected
            .strip_prefix(prefix)
            .and_then(|tail| tail.split(delimiter).next())
            .ok_or_else(|| integrity("embedded public schema is invalid"))?
            .trim();
        let rows = connection.query(
            "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
            &[Value::Text(kind.into()), Value::Text(name.into())],
            1,
            16 * 1024,
        )?;
        if rows.len() != 1 || canonical(rows[0].text(0, 16 * 1024)?) != canonical(expected) {
            return Err(integrity("public database schema differs"));
        }
    }
    if scalar(connection, "PRAGMA auto_vacuum")? != vacuum {
        return Err(integrity("public database auto-vacuum differs"));
    }
    connection.wal()?;
    connection.execute("PRAGMA foreign_keys=ON", &[])?;
    // Android外键/WAL公开API会重配连接池，随后重新应用同一设置到线程会话。
    settings(connection, secure)?;
    for sql in ["PRAGMA synchronous=FULL", "PRAGMA busy_timeout=5000"] {
        connection.execute(sql, &[])?;
    }
    for (sql, expected) in [
        ("PRAGMA synchronous", 2),
        ("PRAGMA foreign_keys", 1),
        ("PRAGMA busy_timeout", 5000),
        ("PRAGMA temp_store", 2),
        ("PRAGMA secure_delete", i64::from(secure)),
        ("PRAGMA wal_autocheckpoint", 1000),
    ] {
        if scalar(connection, sql)? != expected {
            return Err(integrity("public database durability setting differs"));
        }
    }
    let trusted = connection.query("PRAGMA trusted_schema", &[], 1, 1024)?;
    // trusted_schema自SQLite3.31提供；Android API24..30原系统引擎没有此设置。
    // 仅该已知平台能力允许空结果；执行错误、错误值及其它平台缺失均拒绝。
    if !(android && trusted.is_empty()) && (trusted.len() != 1 || trusted[0].integer(0, 0, 1)? != 0)
    {
        return Err(integrity("public database trusted-schema setting differs"));
    }
    Ok(())
}
