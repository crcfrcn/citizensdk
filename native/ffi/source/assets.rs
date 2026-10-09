use blake2::{digest::Update, digest::VariableOutput, Blake2bVar};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{FfiError, FfiResult};

const EXPECTED_PRODUCT_ID: &str = "citizensdk";
const EXPECTED_CHAIN_ID: &str = "citizenchain";
const EXPECTED_PROTOCOL_ID: &str = "citizenchain";
const EXPECTED_GENESIS_HASH: &str =
    "0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd";
const EXPECTED_CHAINSPEC_SHA256: &str =
    "6ae934933682a8ffca78663dd4391a730b6ae219bd12abfb5d96b4d8154fc2e0";
const EXPECTED_LIGHT_SYNC_STATE_SHA256: &str =
    "014802836a0f6e01a9f1bf7173b8e04c9df8fc3f057565f855abdccdc7361ab6";
const EXPECTED_SDK_MIN_VERSION: &str = "1.0.0";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetManifest {
    format_version: u32,
    product_id: String,
    chain_id: String,
    protocol_id: String,
    genesis_hash: String,
    chainspec_sha256: String,
    light_sync_state_sha256: String,
    sdk_min_version: String,
}

#[derive(Deserialize)]
struct LightSyncState {
    #[serde(rename = "finalizedBlockHeader")]
    finalized_block_header: String,
    #[serde(rename = "grandpaAuthoritySet")]
    grandpa_authority_set: String,
}

#[derive(Clone, Debug)]
pub struct VerifiedAssets {
    pub combined_chain_spec: String,
}

/// Verify raw packaged bytes before constructing a smoldot provider. Digest
/// checks intentionally precede JSON content parsing.
pub fn verify_assets(
    manifest_bytes: &[u8],
    chain_spec_bytes: &[u8],
    light_state_bytes: &[u8],
) -> FfiResult<VerifiedAssets> {
    let manifest: AssetManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| FfiError::invalid(format!("invalid asset manifest: {error}")))?;
    validate_manifest(&manifest)?;
    verify_digest(chain_spec_bytes, &manifest.chainspec_sha256, "chainspec")?;
    verify_digest(
        light_state_bytes,
        &manifest.light_sync_state_sha256,
        "light sync state",
    )?;

    let mut chain_spec: Value = serde_json::from_slice(chain_spec_bytes)
        .map_err(|error| FfiError::invalid(format!("invalid chainspec JSON: {error}")))?;
    let chain = chain_spec
        .as_object_mut()
        .ok_or_else(|| FfiError::invalid("chainspec must be a JSON object"))?;
    let light_state: LightSyncState = serde_json::from_slice(light_state_bytes)
        .map_err(|error| FfiError::invalid(format!("invalid light sync state JSON: {error}")))?;
    let light_value: Value = serde_json::from_slice(light_state_bytes)
        .map_err(|error| FfiError::invalid(format!("invalid light sync state JSON: {error}")))?;

    let chain_id = chain.get("id").and_then(Value::as_str);
    let protocol_id = chain.get("protocolId").and_then(Value::as_str);
    if chain_id != Some(EXPECTED_CHAIN_ID) || protocol_id != Some(EXPECTED_PROTOCOL_ID) {
        return Err(FfiError::invalid(
            "chainspec id/protocolId does not match citizenchain",
        ));
    }

    let header = decode_hex(&light_state.finalized_block_header, "finalizedBlockHeader")?;
    if header.len() < 65 || header.get(32) != Some(&0) {
        return Err(FfiError::invalid(
            "light sync state must contain a complete genesis #0 header",
        ));
    }
    let authority_set = decode_hex(&light_state.grandpa_authority_set, "grandpaAuthoritySet")?;
    if authority_set.is_empty() {
        return Err(FfiError::invalid("grandpaAuthoritySet must not be empty"));
    }
    let genesis_hash = blake2b256(&header)?;
    if format!("0x{}", encode_hex(&genesis_hash)) != EXPECTED_GENESIS_HASH {
        return Err(FfiError::invalid(
            "checkpoint genesis hash does not match CitizenChain",
        ));
    }
    let checkpoint_state_root = format!("0x{}", encode_hex(&header[33..65]));
    let spec_state_root = chain
        .get("genesis")
        .and_then(Value::as_object)
        .and_then(|genesis| genesis.get("stateRootHash"))
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase);
    if spec_state_root.as_deref() != Some(checkpoint_state_root.as_str()) {
        return Err(FfiError::invalid(
            "chainspec stateRootHash does not match the #0 checkpoint",
        ));
    }

    chain.insert("lightSyncState".to_owned(), light_value);
    let combined_chain_spec = serde_json::to_string(&chain_spec)
        .map_err(|error| FfiError::internal(format!("chainspec encoding failed: {error}")))?;
    Ok(VerifiedAssets {
        combined_chain_spec,
    })
}

fn validate_manifest(manifest: &AssetManifest) -> FfiResult<()> {
    if manifest.format_version != 1
        || manifest.product_id != EXPECTED_PRODUCT_ID
        || manifest.chain_id != EXPECTED_CHAIN_ID
        || manifest.protocol_id != EXPECTED_PROTOCOL_ID
        || manifest.genesis_hash != EXPECTED_GENESIS_HASH
        || manifest.sdk_min_version != EXPECTED_SDK_MIN_VERSION
    {
        return Err(FfiError::invalid(
            "asset manifest identity or version is unsupported",
        ));
    }
    if !is_lower_hex(&manifest.chainspec_sha256, false)
        || !is_lower_hex(&manifest.light_sync_state_sha256, false)
    {
        return Err(FfiError::invalid(
            "asset manifest SHA-256 fields must be 64 lowercase hex digits",
        ));
    }
    if manifest.chainspec_sha256 != EXPECTED_CHAINSPEC_SHA256
        || manifest.light_sync_state_sha256 != EXPECTED_LIGHT_SYNC_STATE_SHA256
    {
        return Err(FfiError::new(
            crate::abi::CitizenSdkErrorCode::Integrity,
            "asset manifest digests do not match the packaged CitizenChain anchors",
        ));
    }
    Ok(())
}

fn verify_digest(bytes: &[u8], expected: &str, name: &str) -> FfiResult<()> {
    let actual = encode_hex(&Sha256::digest(bytes));
    if actual != expected {
        return Err(FfiError::new(
            crate::abi::CitizenSdkErrorCode::Integrity,
            format!("{name} SHA-256 mismatch"),
        ));
    }
    Ok(())
}

fn blake2b256(bytes: &[u8]) -> FfiResult<[u8; 32]> {
    let mut output = [0_u8; 32];
    let mut hasher = Blake2bVar::new(output.len())
        .map_err(|_| FfiError::internal("failed to initialize Blake2b-256"))?;
    hasher.update(bytes);
    hasher
        .finalize_variable(&mut output)
        .map_err(|_| FfiError::internal("failed to finalize Blake2b-256"))?;
    Ok(output)
}

fn decode_hex(value: &str, name: &str) -> FfiResult<Vec<u8>> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    if clean.is_empty()
        || !clean.len().is_multiple_of(2)
        || !clean.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(FfiError::invalid(format!("{name} is not valid hex")));
    }
    clean
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|text| u8::from_str_radix(text, 16).ok())
                .ok_or_else(|| FfiError::invalid(format!("{name} is not valid hex")))
        })
        .collect()
}

fn is_lower_hex(value: &str, prefixed: bool) -> bool {
    let clean = if prefixed {
        let Some(clean) = value.strip_prefix("0x") else {
            return false;
        };
        clean
    } else {
        value
    };
    clean.len() == 64
        && clean
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::{encode_hex, verify_assets};

    const MANIFEST: &[u8] = include_bytes!("../../../chain/manifest.json");
    const CHAIN_SPEC: &[u8] = include_bytes!("../../../chain/chainspec.json");
    const LIGHT_STATE: &[u8] = include_bytes!("../../../chain/light_sync_state.json");

    #[test]
    fn packaged_assets_verify_and_combine() {
        let assets = verify_assets(MANIFEST, CHAIN_SPEC, LIGHT_STATE)
            .unwrap_or_else(|error| panic!("asset verification failed: {error:?}"));
        assert!(assets.combined_chain_spec.contains("\"lightSyncState\""));
    }

    #[test]
    fn digest_drift_fails_before_chain_json_is_consumed() {
        let error = verify_assets(MANIFEST, b"{broken", LIGHT_STATE)
            .err()
            .unwrap_or_else(|| panic!("drifted asset must fail"));
        assert_eq!(error.code, crate::abi::CitizenSdkErrorCode::Integrity);
    }

    #[test]
    fn caller_supplied_manifest_cannot_self_authorize_a_different_checkpoint() {
        let mut altered_state = LIGHT_STATE.to_vec();
        altered_state.push(b'\n');
        let altered_hash = encode_hex(&Sha256::digest(&altered_state));
        let manifest = String::from_utf8(MANIFEST.to_vec())
            .unwrap_or_else(|error| panic!("manifest UTF-8 failed: {error}"))
            .replace(
                "014802836a0f6e01a9f1bf7173b8e04c9df8fc3f057565f855abdccdc7361ab6",
                &altered_hash,
            );
        let error = verify_assets(manifest.as_bytes(), CHAIN_SPEC, &altered_state)
            .err()
            .unwrap_or_else(|| panic!("self-authorized checkpoint drift must fail"));
        assert_eq!(error.code, crate::abi::CitizenSdkErrorCode::Integrity);
    }
}
