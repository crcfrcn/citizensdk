//! Runtime-metadata validation for application-owned opaque RuntimeCall bytes.
//!
//! The decoder proves only that the bytes are one complete, canonical call for the exact runtime.
//! It never assigns application meaning, maintains an allowlist, or accepts pallet/call names from
//! a binding.

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

#[cfg(test)]
#[path = "../tests/metadata.rs"]
mod tests;
