//! 金库代际、永久墓碑和硬件对象身份；不执行硬件密钥或认证动作。
use crate::{
    error::{error, integrity, invalid},
    key,
    secure::{Format, SecureStore},
    sqlite::{transaction, transaction_recover, Connection, Database, Row, Value},
};
use citizen_sdk_contracts::{ContractErrorCode as Code, ContractResult, VaultGeneration};

pub const LIMIT: usize = 65536;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Key {
    pub index: u32,
    pub generation: VaultGeneration,
}
#[derive(Clone, Eq, PartialEq)]
pub struct Object {
    pub key_name: String,
    pub public: Vec<u8>,
    pub private: Vec<u8>,
    pub name: Vec<u8>,
    pub salt: Vec<u8>,
}
impl std::fmt::Debug for Object {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultObject(redacted)")
    }
}
struct Generation {
    active: bool,
    operation: [u8; 16],
}
fn generation(conn: &mut dyn Connection, key: Key) -> ContractResult<Option<Generation>> {
    let rows=conn.query("SELECT key_state, operation_id, wallet_index, key_generation FROM generation WHERE wallet_index = ? AND key_generation = ?",&[Value::Integer(key.index.into()),Value::Blob(key.generation.as_bytes().to_vec())],1,1024)?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    if row.integer(2, 0, u32::MAX as i64)? as u32 != key.index
        || row.bytes(3, 16)? != key.generation.as_bytes()
    {
        return Err(integrity("vault generation identity differs"));
    }
    let operation = row
        .bytes(1, 16)?
        .try_into()
        .map_err(|_| integrity("vault operation length differs"))?;
    Ok(Some(Generation {
        active: row.integer(0, 1, 2)? == 1,
        operation,
    }))
}
fn owned(conn: &mut dyn Connection, key: Key, operation: [u8; 16]) -> ContractResult<bool> {
    Ok(generation(conn, key)?.is_some_and(|value| value.active && value.operation == operation))
}
fn key_row(row: &Row) -> ContractResult<Key> {
    let index = row.integer(0, 0, u32::MAX as i64)? as u32;
    let generation = VaultGeneration::from_bytes(
        row.bytes(1, 16)?
            .try_into()
            .map_err(|_| integrity("vault generation length differs"))?,
    );
    Ok(Key { index, generation })
}
fn valid(format: Format, key: Key, value: &Object) -> bool {
    match format {
        Format::Device => false,
        Format::Tpm => {
            value.key_name.is_empty()
                && (1..=8192).contains(&value.public.len())
                && (1..=8192).contains(&value.private.len())
                && value.name.len() == 34
                && value.salt.len() == 16
        }
        Format::Cng => {
            value.key_name == format!("citizensdk.{}", key::hex(key.generation.as_bytes()))
                && (281..=288).contains(&value.public.len())
                && value.private.is_empty()
                && (1..=1024).contains(&value.name.len())
                && value.salt == key.generation.as_bytes()
        }
    }
}
fn object(conn: &mut dyn Connection, format: Format, key: Key) -> ContractResult<Option<Object>> {
    let sql=match format{Format::Tpm=>"SELECT public_blob, private_blob, object_name, auth_salt FROM object WHERE wallet_index = ? AND key_generation = ?",Format::Cng=>"SELECT public_blob, object_name FROM object WHERE wallet_index = ? AND key_generation = ?",Format::Device=>return Err(error(Code::Unsupported,"device vault has no SQL hardware object"))};
    let rows = conn.query(
        sql,
        &[
            Value::Integer(key.index.into()),
            Value::Blob(key.generation.as_bytes().to_vec()),
        ],
        1,
        20000,
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let value = if format == Format::Cng {
        Object {
            key_name: format!("citizensdk.{}", key::hex(key.generation.as_bytes())),
            public: row.bytes(0, 288)?.to_vec(),
            private: vec![],
            name: row.bytes(1, 1024)?.to_vec(),
            salt: key.generation.as_bytes().to_vec(),
        }
    } else {
        Object {
            key_name: String::new(),
            public: row.bytes(0, 8192)?.to_vec(),
            private: row.bytes(1, 8192)?.to_vec(),
            name: row.bytes(2, 34)?.to_vec(),
            salt: row.bytes(3, 16)?.to_vec(),
        }
    };
    if !valid(format, key, &value) {
        return Err(integrity("vault object descriptor differs"));
    }
    Ok(Some(value))
}
impl<D: Database> SecureStore<D> {
    pub fn ensure_generation(&self, key: Key, operation: [u8; 16]) -> ContractResult<bool> {
        self.run(|conn|transaction_recover(conn,|conn|{
  if let Some(current)=generation(conn,key)?{return Ok(current.active&&current.operation==operation);}
  conn.execute("INSERT INTO generation(wallet_index, key_generation, key_state, operation_id) VALUES(?, ?, ?, ?)",&[Value::Integer(key.index.into()),Value::Blob(key.generation.as_bytes().to_vec()),Value::Integer(1),Value::Blob(operation.to_vec())])?;Ok(true)
 },|conn,value|Ok(*value&&owned(conn,key,operation)?)))
    }
    pub fn is_active(&self, key: Key) -> ContractResult<bool> {
        self.run(|conn| Ok(generation(conn, key)?.is_some_and(|g| g.active)))
    }
    pub fn generation_owned_by(&self, key: Key, operation: [u8; 16]) -> ContractResult<bool> {
        self.run(|conn| owned(conn, key, operation))
    }
    pub fn retire_generation(&self, key: Key, operation: [u8; 16]) -> ContractResult<()> {
        self.run(|conn|transaction_recover(conn,|conn|{
  conn.execute("INSERT INTO generation(wallet_index, key_generation, key_state, operation_id) VALUES(?, ?, ?, ?) ON CONFLICT(wallet_index,key_generation) DO UPDATE SET key_state=excluded.key_state,operation_id=excluded.operation_id",&[Value::Integer(key.index.into()),Value::Blob(key.generation.as_bytes().to_vec()),Value::Integer(2),Value::Blob(operation.to_vec())])?;Ok(())
 },|conn,_|Ok(generation(conn,key)?.is_some_and(|g|!g.active&&g.operation==operation))))
    }
    pub fn generations(&self) -> ContractResult<Vec<Key>> {
        self.run(|conn| {
            let mut values = vec![];
            conn.scan(
                "SELECT wallet_index, key_generation, key_state FROM generation LIMIT 65537",
                &[],
                LIMIT + 1,
                1024,
                &mut |row| {
                    if values.len() == LIMIT {
                        return Err(error(
                            Code::Unavailable,
                            "vault generation scan limit exceeded",
                        ));
                    }
                    row.integer(2, 1, 2)?;
                    values.push(key_row(row)?);
                    Ok(false)
                },
            )?;
            Ok(values)
        })
    }
    pub fn has_object_key(&self, index: u32) -> ContractResult<bool> {
        self.run(|conn|{
  if self.format!=Format::Tpm{return Err(error(Code::Unsupported,"physical key enumeration belongs to the platform vault"));}
  let mut found=false;let mut count=0;
  conn.scan("SELECT g.wallet_index, g.key_generation FROM object o LEFT JOIN generation g ON g.wallet_index = o.wallet_index AND g.key_generation = o.key_generation LIMIT 65537",&[],LIMIT+1,1024,&mut |row|{
   count+=1;if count>LIMIT{return Err(error(Code::Unavailable,"vault object scan limit exceeded"));}found=key_row(row)?.index==index;Ok(found)
  })?;Ok(found)
 })
    }
    pub fn load_object(&self, key: Key) -> ContractResult<Option<Object>> {
        self.run(|conn| object(conn, self.format, key))
    }
    pub fn store_object(&self, key: Key, operation: [u8; 16], value: Object) -> ContractResult<()> {
        if !valid(self.format, key, &value) {
            return Err(invalid("vault object bounds or identity differ"));
        }
        self.run(|conn|transaction_recover(conn,|conn|{
   if !owned(conn,key,operation)?{return Err(error(Code::KeyInvalidated,"vault generation is retired or belongs to another operation"));}
   if let Some(current)=object(conn,self.format,key)?{return if current==value {Ok(())}else{Err(error(Code::KeyInvalidated,"vault object was replaced"))};}
   let (sql,fields)=if self.format==Format::Cng{("INSERT INTO object(wallet_index, key_generation, public_blob, object_name) VALUES(?, ?, ?, ?)",vec![Value::Integer(key.index.into()),Value::Blob(key.generation.as_bytes().to_vec()),Value::Blob(value.public.clone()),Value::Blob(value.name.clone())])}
   else{("INSERT INTO object(wallet_index, key_generation, public_blob, private_blob, object_name, auth_salt) VALUES(?, ?, ?, ?, ?, ?)",vec![Value::Integer(key.index.into()),Value::Blob(key.generation.as_bytes().to_vec()),Value::Blob(value.public.clone()),Value::Blob(value.private.clone()),Value::Blob(value.name.clone()),Value::Blob(value.salt.clone())])};
   conn.execute(sql,&fields)?;Ok(())
  },|conn,_|Ok(owned(conn,key,operation)?&&object(conn,self.format,key)?.as_ref()==Some(&value))))
    }
    pub fn object_is_active(&self, key: Key, value: &Object) -> ContractResult<bool> {
        self.run(|conn| {
            transaction(conn, |conn| {
                Ok(generation(conn, key)?.is_some_and(|g| g.active)
                    && object(conn, self.format, key)?.as_ref() == Some(value))
            })
        })
    }
    pub fn delete_object(&self, key: Key) -> ContractResult<()> {
        self.run(|conn| {
            transaction_recover(
                conn,
                |conn| {
                    conn.execute(
                        "DELETE FROM object WHERE wallet_index = ? AND key_generation = ?",
                        &[
                            Value::Integer(key.index.into()),
                            Value::Blob(key.generation.as_bytes().to_vec()),
                        ],
                    )?;
                    Ok(())
                },
                |conn, _| Ok(object(conn, self.format, key)?.is_none()),
            )
        })
    }
}
