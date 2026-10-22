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
    "CREATE TABLE IF NOT EXISTS wallet_profile (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), revision INTEGER NOT NULL, record BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS encrypted_secret (record_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS vault_generation (record_key TEXT PRIMARY KEY, wallet_index INTEGER NOT NULL, generation BLOB NOT NULL, state INTEGER NOT NULL, operation_id BLOB NOT NULL)",
];
pub(crate) const TPM: &[&str]=&[
    "CREATE TABLE IF NOT EXISTS wallet_profile (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 1048576))",
    "CREATE TABLE IF NOT EXISTS encrypted_secret (record_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 65536))",
    "CREATE TABLE IF NOT EXISTS vault_generation (record_key TEXT PRIMARY KEY, wallet_index INTEGER NOT NULL CHECK(typeof(wallet_index) = 'integer' AND wallet_index >= 0), generation BLOB NOT NULL CHECK(typeof(generation) = 'blob' AND length(generation) = 16), state INTEGER NOT NULL CHECK(typeof(state) = 'integer' AND state IN (1,2)), operation_id BLOB NOT NULL CHECK(typeof(operation_id) = 'blob' AND length(operation_id) = 16))",
    "CREATE TABLE IF NOT EXISTS vault_object (record_key TEXT PRIMARY KEY, public_blob BLOB NOT NULL CHECK(typeof(public_blob) = 'blob' AND length(public_blob) BETWEEN 1 AND 8192), private_blob BLOB NOT NULL CHECK(typeof(private_blob) = 'blob' AND length(private_blob) BETWEEN 1 AND 8192), object_name BLOB NOT NULL CHECK(typeof(object_name) = 'blob' AND length(object_name) = 34), auth_salt BLOB NOT NULL CHECK(typeof(auth_salt) = 'blob' AND length(auth_salt) = 16))",
];
pub(crate) const CNG: &[&str]=&[
    "CREATE TABLE IF NOT EXISTS wallet_profile (wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 1048576))",
    "CREATE TABLE IF NOT EXISTS encrypted_secret (record_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 65536))",
    "CREATE TABLE IF NOT EXISTS vault_generation (record_key TEXT PRIMARY KEY, wallet_index INTEGER NOT NULL CHECK(typeof(wallet_index) = 'integer' AND wallet_index >= 0), generation BLOB NOT NULL CHECK(typeof(generation) = 'blob' AND length(generation) = 16), state INTEGER NOT NULL CHECK(typeof(state) = 'integer' AND state IN (1,2)), operation_id BLOB NOT NULL CHECK(typeof(operation_id) = 'blob' AND length(operation_id) = 16))",
    "CREATE TABLE IF NOT EXISTS vault_object (record_key TEXT PRIMARY KEY, key_name TEXT NOT NULL CHECK(typeof(key_name) = 'text' AND length(key_name) = 43), public_blob BLOB NOT NULL CHECK(typeof(public_blob) = 'blob' AND length(public_blob) BETWEEN 281 AND 288), object_name BLOB NOT NULL CHECK(typeof(object_name) = 'blob' AND length(object_name) BETWEEN 1 AND 1024), auth_salt BLOB NOT NULL CHECK(typeof(auth_salt) = 'blob' AND length(auth_salt) = 16))",
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
        "SELECT revision, record FROM wallet_profile WHERE wallet_index = 0",
        &[],
        1,
        1048576,
    )?;
    let Some(row) = rows.first() else {
        return Ok(WalletState::empty());
    };
    let revision = row.integer(0, 1, i64::MAX)? as u64;
    let state = codec::decode_wallet_state(row.bytes(1, 1048576)?).map_err(decode_error)?;
    if state.revision() != revision {
        return Err(integrity("wallet revision differs from its record"));
    }
    Ok(state)
}
fn encrypted(
    conn: &mut dyn Connection,
    reference: SecretRef,
) -> ContractResult<EncryptedSecretBlobSnapshot> {
    let rows = conn.query(
        "SELECT revision, record FROM encrypted_secret WHERE record_key = ?",
        &[Value::Text(key::secret(reference))],
        1,
        65536,
    )?;
    let Some(row) = rows.first() else {
        return Ok(EncryptedSecretBlobSnapshot::empty());
    };
    let revision = row.integer(0, 1, i64::MAX)? as u64;
    let state = codec::decode_encrypted_secret_blob_snapshot(reference, row.bytes(1, 65536)?)
        .map_err(decode_error)?;
    if state.revision() != revision {
        return Err(integrity("encrypted secret revision differs"));
    }
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
            self.run(|conn|transaction_recover(conn,|conn|{
   if wallet(conn)?.revision()!=expected{return Err(error(ContractErrorCode::Conflict,"wallet revision changed"));}
   conn.execute("INSERT OR REPLACE INTO wallet_profile(wallet_index, revision, record) VALUES(0, ?, ?)",&[Value::Integer(next.revision() as i64),Value::Blob(record)])?;Ok(next)
  },|conn,next|Ok(wallet(conn)?==*next)))
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
            self.run(|conn|{
  let candidate=transaction_recover(conn,|conn|{let current=encrypted(conn,reference)?;
   if current.revision()!=expected{return Err(error(ContractErrorCode::Conflict,"encrypted secret revision changed"));}
   let candidate=current.try_advance(next)?;let record=codec::encode_encrypted_secret_blob_snapshot(reference,&candidate).map_err(decode_error)?;
   conn.execute("INSERT OR REPLACE INTO encrypted_secret(record_key, revision, record) VALUES(?, ?, ?)",&[Value::Text(key::secret(reference)),Value::Integer(candidate.revision() as i64),Value::Blob(record)])?;Ok(candidate)
  },|conn,next|Ok(encrypted(conn,reference)?==*next))?;
  // 密文写入必须准确回读；不能把接纳或COMMIT回执当作完整候选状态。
  if encrypted(conn,reference)?!=candidate{return Err(integrity("encrypted secret readback differs"));}Ok(candidate)
 })
        })
    }
    fn has_account_secret(&self, account: AccountId32) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            self.run(|conn| {
                let mut present = false;
                let mut count = 0;
                conn.scan(
                    "SELECT revision, record FROM encrypted_secret LIMIT 65537",
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
                        let revision = row.integer(0, 1, i64::MAX)? as u64;
                        present = codec::encrypted_secret_record_has_secret(
                            account,
                            revision,
                            row.bytes(1, 65536)?,
                        )
                        .map_err(decode_error)?;
                        Ok(present)
                    },
                )?;
                Ok(present)
            })
        })
    }
}
