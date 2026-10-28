//! 钱包目录与密文的唯一持久化实现；不接收明文秘密。
use crate::{
    codec,
    error::{codec as decode_error, error, integrity, invalid},
    key, schema,
    sqlite::{transaction_recover, Connection, Database, Value},
};
use citizen_sdk_contracts::*;
use std::sync::Mutex;
pub(crate) const DEVICE: &[&str]=&[
    "CREATE TABLE IF NOT EXISTS wallet (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), record_data BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS secret (record_key TEXT PRIMARY KEY, record_data BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS generation (wallet_index INTEGER NOT NULL, key_generation BLOB NOT NULL, key_state INTEGER NOT NULL, operation_id BLOB NOT NULL, PRIMARY KEY(wallet_index,key_generation))",
];
pub(crate) const TPM: &[&str]=&[
    "CREATE TABLE IF NOT EXISTS wallet (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), record_data BLOB NOT NULL CHECK(typeof(record_data) = 'blob' AND length(record_data) <= 1048576))",
    "CREATE TABLE IF NOT EXISTS secret (record_key TEXT PRIMARY KEY, record_data BLOB NOT NULL CHECK(typeof(record_data) = 'blob' AND length(record_data) <= 65536))",
    "CREATE TABLE IF NOT EXISTS generation (wallet_index INTEGER NOT NULL CHECK(typeof(wallet_index) = 'integer' AND wallet_index >= 0), key_generation BLOB NOT NULL CHECK(typeof(key_generation) = 'blob' AND length(key_generation) = 16), key_state INTEGER NOT NULL CHECK(typeof(key_state) = 'integer' AND key_state IN (1,2)), operation_id BLOB NOT NULL CHECK(typeof(operation_id) = 'blob' AND length(operation_id) = 16), PRIMARY KEY(wallet_index,key_generation))",
    "CREATE TABLE IF NOT EXISTS object (wallet_index INTEGER NOT NULL, key_generation BLOB NOT NULL, public_blob BLOB NOT NULL CHECK(typeof(public_blob) = 'blob' AND length(public_blob) BETWEEN 1 AND 8192), private_blob BLOB NOT NULL CHECK(typeof(private_blob) = 'blob' AND length(private_blob) BETWEEN 1 AND 8192), object_name BLOB NOT NULL CHECK(typeof(object_name) = 'blob' AND length(object_name) = 34), auth_salt BLOB NOT NULL CHECK(typeof(auth_salt) = 'blob' AND length(auth_salt) = 16), PRIMARY KEY(wallet_index,key_generation), FOREIGN KEY(wallet_index,key_generation) REFERENCES generation(wallet_index,key_generation))",
];
pub(crate) const CNG: &[&str]=&[
    "CREATE TABLE IF NOT EXISTS wallet (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), record_data BLOB NOT NULL CHECK(typeof(record_data) = 'blob' AND length(record_data) <= 1048576))",
    "CREATE TABLE IF NOT EXISTS secret (record_key TEXT PRIMARY KEY, record_data BLOB NOT NULL CHECK(typeof(record_data) = 'blob' AND length(record_data) <= 65536))",
    "CREATE TABLE IF NOT EXISTS generation (wallet_index INTEGER NOT NULL CHECK(typeof(wallet_index) = 'integer' AND wallet_index >= 0), key_generation BLOB NOT NULL CHECK(typeof(key_generation) = 'blob' AND length(key_generation) = 16), key_state INTEGER NOT NULL CHECK(typeof(key_state) = 'integer' AND key_state IN (1,2)), operation_id BLOB NOT NULL CHECK(typeof(operation_id) = 'blob' AND length(operation_id) = 16), PRIMARY KEY(wallet_index,key_generation))",
    "CREATE TABLE IF NOT EXISTS object (wallet_index INTEGER NOT NULL, key_generation BLOB NOT NULL, public_blob BLOB NOT NULL CHECK(typeof(public_blob) = 'blob' AND length(public_blob) BETWEEN 281 AND 288), object_name BLOB NOT NULL CHECK(typeof(object_name) = 'blob' AND length(object_name) BETWEEN 1 AND 1024), PRIMARY KEY(wallet_index,key_generation), FOREIGN KEY(wallet_index,key_generation) REFERENCES generation(wallet_index,key_generation))",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    Device,
    Tpm,
    Cng,
}
impl Format {
    pub const fn native() -> Self {
        if cfg!(target_os = "windows") {
            Self::Cng
        } else if cfg!(target_os = "linux") {
            Self::Tpm
        } else {
            Self::Device
        }
    }
    pub fn statements(self) -> &'static [&'static str] {
        match self {
            Self::Device => DEVICE,
            Self::Tpm => TPM,
            Self::Cng => CNG,
        }
    }
}
pub struct SecureStore<D: Database> {
    database: D,
    initialized: Mutex<bool>,
    pub(crate) format: Format,
}
impl<D: Database> SecureStore<D> {
    pub fn new(database: D) -> Self {
        Self::with_format(database, Format::native())
    }
    pub fn with_format(database: D, format: Format) -> Self {
        Self {
            database,
            initialized: Mutex::new(false),
            format,
        }
    }
    pub(crate) fn run<T>(
        &self,
        operation: impl FnOnce(&mut dyn Connection) -> ContractResult<T>,
    ) -> ContractResult<T> {
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| error(ContractErrorCode::Internal, "secure store lock poisoned"))?;
        let mut operation = Some(operation);
        let mut output = None;
        self.database.run(&mut |conn| {
            let job = operation
                .take()
                .ok_or_else(|| integrity("secure job executed twice"))?;
            if !*initialized {
                schema::initialize_schema(
                    conn,
                    self.format.statements(),
                    1,
                    0,
                    cfg!(target_os = "android"),
                    true,
                )?;
                *initialized = true;
            }
            let value = job(conn);
            let status = value.as_ref().map(|_| ()).map_err(Clone::clone);
            output = Some(value);
            status
        })?;
        output.ok_or_else(|| integrity("secure job missing"))?
    }
}
fn wallet(conn: &mut dyn Connection) -> ContractResult<WalletState> {
    let rows = conn.query(
        "SELECT record_data FROM wallet WHERE wallet_index = 0",
        &[],
        1,
        1048576,
    )?;
    let Some(row) = rows.first() else {
        return Ok(WalletState::empty());
    };
    let state = codec::decode_wallet_state(row.bytes(0, 1048576)?).map_err(decode_error)?;
    Ok(state)
}
fn encrypted(
    conn: &mut dyn Connection,
    reference: SecretRef,
) -> ContractResult<EncryptedSecretBlobSnapshot> {
    let rows = conn.query(
        "SELECT record_data FROM secret WHERE record_key = ?",
        &[Value::Text(key::secret(reference))],
        1,
        65536,
    )?;
    let Some(row) = rows.first() else {
        return Ok(EncryptedSecretBlobSnapshot::empty());
    };
    let state = codec::decode_encrypted_secret_blob_snapshot(reference, row.bytes(0, 65536)?)
        .map_err(decode_error)?;
    Ok(state)
}
impl<D: Database> WalletProfileStore for SecureStore<D> {
    fn load(&self) -> ContractFuture<'_, WalletState> {
        Box::pin(async move { self.run(wallet) })
    }
    fn compare_and_swap(
        &self,
        expected: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState> {
        Box::pin(async move {
            if expected >= i64::MAX as u64 || next.revision() != expected + 1 {
                return Err(error(
                    ContractErrorCode::Conflict,
                    "wallet revision changed or exhausted",
                ));
            }
            let record = codec::encode_wallet_state(&next).map_err(decode_error)?;
            if record.len() > 1048576 {
                return Err(invalid("wallet record too large"));
            }
            self.run(|conn| {
                transaction_recover(
                    conn,
                    |conn| {
                        if wallet(conn)?.revision() != expected {
                            return Err(error(
                                ContractErrorCode::Conflict,
                                "wallet revision changed",
                            ));
                        }
                        conn.execute(
                            "INSERT OR REPLACE INTO wallet(wallet_index, record_data) VALUES(0, ?)",
                            &[Value::Blob(record)],
                        )?;
                        Ok(next)
                    },
                    |conn, next| Ok(wallet(conn)? == *next),
                )
            })
        })
    }
}
impl<D: Database> EncryptedSecretBlobStore for SecureStore<D> {
    fn load(&self, reference: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move { self.run(|conn| encrypted(conn, reference)) })
    }
    fn compare_and_swap(
        &self,
        reference: SecretRef,
        expected: u64,
        next: EncryptedSecretBlobState,
    ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move {
            self.run(|conn| {
                let candidate = transaction_recover(
                    conn,
                    |conn| {
                        let current = encrypted(conn, reference)?;
                        if current.revision() != expected {
                            return Err(error(
                                ContractErrorCode::Conflict,
                                "encrypted secret revision changed",
                            ));
                        }
                        let candidate = current.try_advance(next)?;
                        let record =
                            codec::encode_encrypted_secret_blob_snapshot(reference, &candidate)
                                .map_err(decode_error)?;
                        conn.execute(
                            "INSERT OR REPLACE INTO secret(record_key, record_data) VALUES(?, ?)",
                            &[Value::Text(key::secret(reference)), Value::Blob(record)],
                        )?;
                        Ok(candidate)
                    },
                    |conn, next| Ok(encrypted(conn, reference)? == *next),
                )?;
                // 密文写入必须准确回读；不能把接纳或COMMIT回执当作完整候选状态。
                if encrypted(conn, reference)? != candidate {
                    return Err(integrity("encrypted secret readback differs"));
                }
                Ok(candidate)
            })
        })
    }
    fn has_account_secret(&self, account: AccountId32) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            self.run(|conn| {
                let mut present = false;
                let mut count = 0;
                conn.scan(
                    "SELECT record_data FROM secret LIMIT 65537",
                    &[],
                    65537,
                    65536,
                    &mut |row| {
                        count += 1;
                        if count > 65536 {
                            return Err(error(
                                ContractErrorCode::Unavailable,
                                "secret scan limit exceeded",
                            ));
                        }
                        // SQL只保存原封套；同一codec解码出属主与单向状态，不保存修订副本。
                        let (reference, snapshot) =
                            codec::decode_encrypted_secret_blob(row.bytes(0, 65536)?)
                                .map_err(decode_error)?;
                        present =
                            reference.account_id() == account && snapshot.envelope().is_some();
                        Ok(present)
                    },
                )?;
                Ok(present)
            })
        })
    }
}
