//! 公民链 metadata 驱动的存储、SCALE 与 RuntimeCall 编解码。

use std::panic::catch_unwind;
use std::panic::AssertUnwindSafe;

use crate::types::ContractErrorCode;
use crate::types::OpaqueTransactionCall;
use subxt_core::ext::scale_encode::EncodeAsType;
use subxt_core::ext::scale_value;
use subxt_core::Metadata;

use crate::error::EngineError;

/// Decode the metadata outer RuntimeCall through EOF and require a byte-identical re-encoding.
pub(crate) fn validate_opaque_runtime_call(
    metadata: &Metadata,
    call: &OpaqueTransactionCall,
) -> Result<(), EngineError> {
    let bytes = call.as_bytes();
    if bytes.len() < 2 {
        return Err(invalid_call("callData 缺少 pallet/call index"));
    }
    let pallet = metadata
        .pallet_by_index(bytes[0])
        .ok_or_else(|| invalid_call("callData 的 pallet index 不存在"))?;
    if pallet.call_variant_by_index(bytes[1]).is_none() {
        return Err(invalid_call("callData 的 call index 不存在"));
    }

    let decoded = catch_unwind(AssertUnwindSafe(|| {
        let mut remaining = bytes;
        let value = scale_value::scale::decode_as_type(
            &mut remaining,
            metadata.outer_enums().call_enum_ty(),
            metadata.types(),
        )
        .map_err(|error| error.to_string())?;
        if !remaining.is_empty() {
            return Err("callData 包含 trailing bytes".to_owned());
        }
        let mut canonical = Vec::with_capacity(bytes.len());
        value
            .encode_as_type_to(
                metadata.outer_enums().call_enum_ty(),
                metadata.types(),
                &mut canonical,
            )
            .map_err(|error| error.to_string())?;
        if canonical != bytes {
            return Err("callData 不是当前 RuntimeCall 的 canonical SCALE 编码".to_owned());
        }
        Ok(())
    }))
    .map_err(|_| invalid_call("metadata 驱动的 RuntimeCall 校验发生 panic"))?;
    decoded.map_err(|message| {
        invalid_call(format!("callData 无法按当前 metadata 完整解码：{message}"))
    })
}

pub(crate) fn signed_extension_identifiers(metadata: &Metadata) -> Vec<String> {
    metadata
        .extrinsic()
        .transaction_extensions_to_use_for_encoding()
        .map(|extension| extension.identifier().to_owned())
        .collect()
}

fn invalid_call(message: impl Into<String>) -> EngineError {
    EngineError::contract(ContractErrorCode::InvalidArgument, message)
}


/// Host 仅传公开协议坐标和类型化值，所有字节格式仍由同一 SDK 决定。
#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum CodecRequest {
    Twox128 { value: String },
    Blake2b128 { value: Vec<u8> },
    Blake2b256 { value: Vec<u8> },
    Compact { value: String },
    ReadCompact { value: Vec<u8> },
    UnsignedConstant { pallet: String, name: String },
    Storage { pallet: String, entry: String, keys: Vec<Field> },
    DecodeStorage { pallet: String, entry: String, value: Vec<u8> },
    Call { pallet: String, method: String, args: Field },
    EvmKey { address: Vec<u8> },
    EvmAddress { address: String },
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case", deny_unknown_fields)]
enum Field {
    Bytes(Vec<u8>),
    Encoded(Vec<u8>),
    Integer(String),
    Bool(bool),
    Text(String),
    Sequence(Vec<Field>),
    Variant(String, Vec<Field>),
}

impl Field {
    fn into_value(self) -> Result<scale_value::Value, EngineError> {
        use scale_value::Value;
        Ok(match self {
            Self::Bytes(value) => Value::from_bytes(value),
            Self::Encoded(_) => return Err(invalid_call("缺少已编码 SCALE 的类型")),
            Self::Integer(value) if value.starts_with('-') =>
                Value::i128(value.parse().map_err(|_| invalid_call("SCALE 整数超出 i128"))?),
            Self::Integer(value) =>
                Value::u128(value.parse().map_err(|_| invalid_call("SCALE 整数超出 u128"))?),
            Self::Bool(value) => Value::bool(value),
            Self::Text(value) => Value::string(value),
            Self::Sequence(values) => Value::unnamed_composite(fields(values)?),
            Self::Variant(name, values) => Value::unnamed_variant(name, fields(values)?),
        })
    }
}

fn fields(values: Vec<Field>) -> Result<Vec<scale_value::Value>, EngineError> {
    values.into_iter().map(Field::into_value).collect()
}

fn decode_scale(
    bytes: &mut &[u8], metadata: &Metadata, type_id: u32,
) -> Result<scale_value::Value, EngineError> {
    scale_value::scale::decode_as_type(bytes, type_id, metadata.types())
        .map(|value| value.remove_context()).map_err(|error| invalid_call(error.to_string()))
}

fn field_value(field: Field, metadata: &Metadata, type_id: u32) -> Result<scale_value::Value, EngineError> {
    if let Field::Encoded(value) = field {
        let mut bytes = value.as_slice();
        let value = decode_scale(&mut bytes, metadata, type_id)?;
        if !bytes.is_empty() { return Err(invalid_call("SCALE 字段存在尾部字节")); }
        Ok(value)
    } else { field.into_value() }
}

fn storage_key(
    metadata: &Metadata, pallet: &str, entry: &str, keys: Vec<scale_value::Value>,
) -> Result<Vec<u8>, EngineError> {
    use subxt_core::storage::{self, address::Address};
    let storage = metadata.pallet_by_name(pallet).and_then(|p| p.storage())
        .ok_or_else(|| invalid_call("metadata 没有指定存储模块"))?;
    if storage.entry_by_name(entry).is_none() {
        return Err(invalid_call("metadata 没有指定存储条目"));
    }
    let address = storage::address::dynamic(pallet, entry, keys);
    let prefix = storage::address::dynamic(storage.prefix(), entry, ());
    let mut key = storage::get_address_root_bytes(&prefix);
    address.append_entry_bytes(metadata, &mut key)
        .map_err(|error| invalid_call(error.to_string()))?;
    Ok(key)
}

pub(crate) fn composite_json<T>(value: scale_value::Composite<T>) -> serde_json::Value {
    use scale_value::Composite;
    match value {
        Composite::Named(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name, value_json(value)))
                .collect(),
        ),
        Composite::Unnamed(fields) => {
            serde_json::Value::Array(fields.into_iter().map(value_json).collect())
        }
    }
}

fn value_json<T>(value: scale_value::Value<T>) -> serde_json::Value {
    use scale_value::{Primitive, ValueDef};
    match value.value {
        ValueDef::Composite(value) => composite_json(value),
        ValueDef::Variant(value) => serde_json::json!({"variant": value.name, "fields": composite_json(value.values)}),
        ValueDef::Primitive(Primitive::Bool(value)) => serde_json::Value::Bool(value),
        ValueDef::Primitive(Primitive::String(value)) => serde_json::Value::String(value),
        ValueDef::Primitive(Primitive::Char(value)) => serde_json::Value::String(value.to_string()),
        ValueDef::Primitive(Primitive::U128(value)) => serde_json::Value::String(value.to_string()),
        ValueDef::Primitive(Primitive::I128(value)) => serde_json::Value::String(value.to_string()),
        ValueDef::Primitive(Primitive::U256(value) | Primitive::I256(value)) =>
            serde_json::Value::String(hex::encode(value)),
        ValueDef::BitSequence(value) =>
            serde_json::Value::Array(value.iter().map(serde_json::Value::Bool).collect()),
    }
}

pub(crate) fn chain_codec(metadata: &[u8], request: &[u8]) -> Result<Vec<u8>, EngineError> {
    use subxt_core::{storage, tx::payload::Payload};
    use crate::types::account::blake2b;
    let request: CodecRequest = serde_json::from_slice(request)
        .map_err(|error| invalid_call(error.to_string()))?;
    let request = match request {
        CodecRequest::Twox128 { value } =>
            return Ok(storage::get_address_root_bytes(&storage::address::dynamic(value, "", ()))[..16].to_vec()),
        CodecRequest::Blake2b128 { value } => return Ok(blake2b::<16>(&value).to_vec()),
        CodecRequest::Blake2b256 { value } => return Ok(blake2b::<32>(&value).to_vec()),
        CodecRequest::Compact { value } => {
            use subxt_core::ext::codec::{Compact, Encode};
            let number = value.parse::<u128>().map_err(|_| invalid_call("Compact 超出 u128"))?;
            return Ok(Compact(number).encode());
        }
        CodecRequest::ReadCompact { value } => {
            use subxt_core::ext::codec::{Compact, Decode, Encode};
            let mut bytes = value.as_slice();
            let number = Compact::<u128>::decode(&mut bytes).map_err(|error| invalid_call(error.to_string()))?;
            let consumed = value.len() - bytes.len();
            if number.encode() != value[..consumed] {
                return Err(invalid_call("Compact 不是 canonical SCALE"));
            }
            return serde_json::to_vec(&(number.0.to_string(), consumed))
                .map_err(|error| invalid_call(error.to_string()));
        }

        CodecRequest::EvmAddress { address } => {
            use sha3::{Digest, Keccak256};
            let value = address.strip_prefix("0x").ok_or_else(|| invalid_call("EVM 地址缺少 0x"))?;
            if value.len() != 40 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(invalid_call("EVM 地址必须是 20 字节十六进制"));
            }
            let lower = value.to_ascii_lowercase();
            if value.bytes().any(|b| b.is_ascii_lowercase()) && value.bytes().any(|b| b.is_ascii_uppercase()) {
                let hash = Keccak256::digest(lower.as_bytes());
                for (i, b) in value.bytes().enumerate() {
                    let nibble = if i % 2 == 0 { hash[i / 2] >> 4 } else { hash[i / 2] & 15 };
                    if b.is_ascii_alphabetic() && b.is_ascii_uppercase() != (nibble >= 8) {
                        return Err(invalid_call("EVM 地址大小写校验和无效"));
                    }
                }
            }
            return hex::decode(lower).map_err(|error| invalid_call(error.to_string()));
        }
        request => request,
    };
    let metadata = crate::system_events::decode_metadata_strict(metadata)?;
    match request {
        CodecRequest::UnsignedConstant { pallet, name } => {
            let value = crate::account_state::decode_integer_constant(&metadata, &pallet, &name)?;
            Ok(value.to_string().into_bytes())
        }
        CodecRequest::Storage { pallet, entry, keys } => {
            use subxt_core::storage::address::StorageHashers;
            let storage = metadata.pallet_by_name(&pallet).and_then(|p| p.storage())
                .and_then(|s| s.entry_by_name(&entry))
                .ok_or_else(|| invalid_call("metadata 没有指定存储条目"))?;
            let types = StorageHashers::new(storage.entry_type(), metadata.types())
                .map_err(|error| invalid_call(error.to_string()))?;
            if keys.len() > types.iter().len() { return Err(invalid_call("存储键字段数量不匹配")); }
            let keys = keys.into_iter().zip(types.iter())
                .map(|(field, (_, ty))| field_value(field, &metadata, ty))
                .collect::<Result<Vec<_>, _>>()?;
            storage_key(&metadata, &pallet, &entry, keys)
        }
        CodecRequest::DecodeStorage { pallet, entry, value } => {
            let storage = metadata.pallet_by_name(&pallet).and_then(|p| p.storage())
                .and_then(|s| s.entry_by_name(&entry))
                .ok_or_else(|| invalid_call("metadata 没有指定存储条目"))?;
            let mut bytes = value.as_slice();
            let decoded = decode_scale(&mut bytes, &metadata, storage.entry_type().value_ty())?;
            if !bytes.is_empty() { return Err(invalid_call("SCALE 存储值存在尾部字节")); }
            serde_json::to_vec(&value_json(decoded)).map_err(|error| invalid_call(error.to_string()))
        }
        CodecRequest::Call { pallet, method, args } => {
            let call = metadata.pallet_by_name(&pallet).and_then(|p| p.call_variant_by_name(&method))
                .ok_or_else(|| invalid_call("metadata 没有指定 RuntimeCall"))?;
            let args = match args {
                Field::Sequence(fields) if fields.len() == call.fields.len() =>
                    fields.into_iter().zip(&call.fields).map(|(field, meta)| field_value(field, &metadata, meta.ty.id))
                        .collect::<Result<Vec<_>, _>>()?,
                Field::Encoded(bytes) => {
                    let mut input = bytes.as_slice();
                    let fields = call.fields.iter().map(|meta| decode_scale(&mut input, &metadata, meta.ty.id))
                        .collect::<Result<Vec<_>, _>>()?;
                    if !input.is_empty() { return Err(invalid_call("RuntimeCall 参数存在尾部字节")); }
                    fields
                }
                _ => return Err(invalid_call("RuntimeCall 参数不符合 metadata")),
            };
            let payload = subxt_core::tx::payload::dynamic(pallet, method, args);
            payload.encode_call_data(&metadata).map_err(|error| invalid_call(error.to_string()))
        }
        CodecRequest::EvmKey { address } => {
            use subxt_core::storage::address::StorageHashers;
            if address.len() != 20 { return Err(invalid_call("EVM 地址长度无效")); }
            let entry = metadata.pallet_by_name("Revive").and_then(|p| p.storage())
                .and_then(|s| s.entry_by_name("OriginalAccount"))
                .ok_or_else(|| invalid_call("metadata 没有 Revive.OriginalAccount"))?;
            let hashers = StorageHashers::new(entry.entry_type(), metadata.types())
                .map_err(|error| invalid_call(error.to_string()))?;
            let hashes = hashers.iter().map(|(hash, _)| format!("{hash:?}")).collect::<Vec<_>>();
            if hashes != ["Identity"] || format!("{:?}", entry.modifier()) != "Optional" {
                return Err(invalid_call("Revive.OriginalAccount 存储格式无效"));
            }
            storage_key(&metadata, "Revive", "OriginalAccount", vec![scale_value::Value::from_bytes(address)])
        }
        _ => unreachable!("已处理纯协议操作"),
    }
}

#[cfg(test)]
#[path = "../tests/metadata.rs"]
mod tests;
