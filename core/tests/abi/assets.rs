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

#[test]
fn native_assets_reject_every_manifest_drift_before_provider_creation() {
    let original: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../chain/manifest.json")).unwrap();
    let spec = include_bytes!("../../../chain/chainspec.json");
    let sync = include_bytes!("../../../chain/light_sync_state.json");
    for (key, value) in [
        ("extra", serde_json::Value::Bool(true)),
        ("chain_id", "other-network".into()),
        ("protocol_id", "other-protocol".into()),
        ("product_id", "other-product".into()),
        ("format_version", 2.into()),
        ("sdk_min_version", "99.0.0".into()),
        ("genesis_hash", format!("0x{}", "00".repeat(32)).into()),
        ("chainspec_sha256", "00".repeat(32).into()),
        ("light_sync_state_sha256", "00".repeat(32).into()),
    ] {
        let mut candidate = original.clone();
        candidate[key] = value;
        assert!(
            crate::assets::verify_assets(&serde_json::to_vec(&candidate).unwrap(), spec, sync)
                .is_err(),
            "{key}"
        );
    }
    for key in original.as_object().unwrap().keys() {
        let mut candidate = original.clone();
        candidate.as_object_mut().unwrap().remove(key);
        assert!(
            crate::assets::verify_assets(&serde_json::to_vec(&candidate).unwrap(), spec, sync)
                .is_err(),
            "missing {key}"
        );
    }
    let mut changed_sync = sync.to_vec();
    changed_sync.push(b' ');
    assert!(crate::assets::verify_assets(
        &serde_json::to_vec(&original).unwrap(),
        spec,
        &changed_sync
    )
    .is_err());
}
