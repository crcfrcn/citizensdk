//! Runtime-metadata validation for application-owned opaque RuntimeCall bytes.
//!
//! The decoder proves only that the bytes are one complete, canonical call for the exact runtime.
//! It never assigns application meaning, maintains an allowlist, or accepts pallet/call names from
//! a binding.

use std::panic::{catch_unwind, AssertUnwindSafe};

use citizen_sdk_contracts::{ContractErrorCode, OpaqueTransactionCall};
use subxt_core::{
    ext::{scale_encode::EncodeAsType, scale_value},
    Metadata,
};

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
mod tests {
    use super::*;
    use crate::system_events::decode_metadata_strict;

    const METADATA_HEX: &str =
        include_str!("../../../test/transaction/citizenchain-runtime-v14-metadata.hex");

    fn metadata() -> Metadata {
        let text = METADATA_HEX
            .trim()
            .strip_prefix("0x")
            .expect("metadata 0x prefix");
        assert_eq!(text.len() % 2, 0, "metadata hex length");
        let bytes = (0..text.len())
            .step_by(2)
            .map(|offset| u8::from_str_radix(&text[offset..offset + 2], 16).expect("metadata hex"))
            .collect::<Vec<_>>();
        decode_metadata_strict(&bytes).expect("production metadata")
    }

    #[test]
    fn three_unrelated_calls_share_one_opaque_validation_path() {
        let metadata = metadata();
        let (system, remark) = call_indices(&metadata, "System", "remark");
        let (timestamp, set) = call_indices(&metadata, "Timestamp", "set");
        let (balances, upgrade) = call_indices(&metadata, "Balances", "upgrade_accounts");
        let calls = [
            vec![system, remark, 0],
            vec![timestamp, set, 0],
            vec![balances, upgrade, 0],
        ];
        for (index, bytes) in calls.into_iter().enumerate() {
            let opaque = OpaqueTransactionCall::try_new(bytes).expect("opaque call");
            validate_opaque_runtime_call(&metadata, &opaque)
                .unwrap_or_else(|error| panic!("generic validation {index}: {error:?}"));
        }
    }

    fn call_indices(metadata: &Metadata, pallet_name: &str, call_name: &str) -> (u8, u8) {
        let pallet = metadata
            .pallet_by_name(pallet_name)
            .expect("fixture pallet");
        let call = pallet
            .call_variant_by_name(call_name)
            .expect("fixture call");
        (pallet.index(), call.index)
    }

    #[test]
    fn unknown_truncated_and_trailing_calls_fail_closed() {
        let metadata = metadata();
        let unknown_pallet = (0_u8..=u8::MAX)
            .find(|index| metadata.pallet_by_index(*index).is_none())
            .expect("metadata cannot occupy every pallet index");
        for bytes in [vec![unknown_pallet, 0], vec![0], vec![0, 0, 0xff]] {
            let opaque = OpaqueTransactionCall::try_new(bytes).expect("bounded opaque call");
            match validate_opaque_runtime_call(&metadata, &opaque).unwrap_err() {
                EngineError::Contract(error) => {
                    assert_eq!(error.code(), ContractErrorCode::InvalidArgument)
                }
                other => panic!("expected invalid-argument contract error, got {other:?}"),
            }
        }
    }
}
