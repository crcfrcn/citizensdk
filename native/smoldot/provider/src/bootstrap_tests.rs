//! 原 Dart 启动清单的信任边界在正式 provider 上验证；不访问公网、不修改服务端 fixture。
// 测试只使用固定公开夹具；解析失败必须终止测试，生产解析仍返回类型化错误。
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

const SPEC: &str = include_str!("../../../../chain/chainspec.json");
const WIRE: &str = include_str!("../../../../test/node/citizensdk_bootstrap_manifest.json");

fn manifest() -> Value {
    let mut wire: Value = serde_json::from_str(WIRE).expect("shared bootstrap fixture");
    let spec: Value = serde_json::from_str(SPEC).expect("bundled chainspec");
    wire["chain"]["genesis_hash"] =
        format!("0x{}", hex::encode(CITIZENCHAIN_GENESIS_HASH.as_bytes())).into();
    wire["chain"]["state_root"] = spec["genesis"]["stateRootHash"].clone();
    wire
}

fn merge(wire: &Value) -> ContractResult<Value> {
    let bytes = serde_json::to_vec(wire).expect("fixture JSON");
    serde_json::from_str(&merge_bootnodes(SPEC, &bytes)?).map_err(|_| invalid())
}

#[test]
fn advice_changes_only_bootnodes_and_preserves_bundled_nodes() {
    let wire = manifest();
    let mut original: Value = serde_json::from_str(SPEC).expect("chainspec");
    let merged = merge(&wire).expect("valid advice");
    let nodes = merged["bootNodes"].as_array().expect("nodes");
    assert_eq!(
        nodes.first(),
        wire["p2p"]["bootnodes"].as_array().unwrap().first()
    );
    for node in original["bootNodes"].as_array().unwrap() {
        assert!(nodes.contains(node));
    }
    original["bootNodes"] = merged["bootNodes"].clone();
    assert_eq!(original, merged);
}

#[test]
fn rejects_unknown_fields_at_every_wire_boundary() {
    for pointer in ["", "/chain", "/light_client", "/p2p", "/security"] {
        let mut wire = manifest();
        wire.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("business".into(), true.into());
        assert!(merge(&wire).is_err(), "{pointer}");
    }
}

#[test]
fn rejects_wrong_identity_or_authority_even_with_valid_bootnodes() {
    for (pointer, bad) in [
        ("/ok", Value::Bool(false)),
        ("/schema", "other".into()),
        ("/chain/chain_id", "other".into()),
        ("/chain/protocol_id", "other".into()),
        (
            "/chain/genesis_hash",
            format!("0x{}", "11".repeat(32)).into(),
        ),
        ("/chain/state_root", format!("0x{}", "22".repeat(32)).into()),
        ("/chain/ss58_format", 42.into()),
        ("/chain/token_symbol", "OTHER".into()),
        ("/chain/token_decimals", 12.into()),
        ("/light_client/mode", "rpc".into()),
        ("/light_client/truth_source", "api".into()),
        ("/light_client/api_is_truth", true.into()),
        (
            "/light_client/bundled_assets_required",
            serde_json::json!([]),
        ),
        ("/generated_at", (-1).into()),
        ("/cache_ttl_seconds", "60".into()),
        ("/p2p/min_peer_count_hint", (-1).into()),
    ] {
        let mut wire = manifest();
        *wire.pointer_mut(pointer).unwrap() = bad;
        assert!(merge(&wire).is_err(), "{pointer}");
    }
    for flag in [
        "exposes_rpc_url",
        "rpc_proxy",
        "exposes_private_key_material",
        "validator_rpc_public",
    ] {
        let mut wire = manifest();
        wire["security"][flag] = true.into();
        assert!(merge(&wire).is_err(), "{flag}");
    }
}

#[test]
fn rejects_rpc_and_checkpoint_keys_recursively_and_case_insensitively() {
    for key in ["rpc_url", "RPC_URLS", "checkpoint", "light_sync_state_url"] {
        let mut wire = manifest();
        wire["p2p"]["bootnodes"] = serde_json::json!([{key: "https://untrusted.invalid"}]);
        assert!(merge(&wire).is_err(), "{key}");
    }
}

#[test]
fn nodes_are_filtered_deduplicated_without_a_second_multiaddr_parser() {
    let mut wire = manifest();
    let first = wire["p2p"]["bootnodes"][0].clone();
    wire["p2p"]["bootnodes"] = serde_json::json!([
        first,
        first,
        false,
        "https://node.invalid",
        "/missing-peer",
        format!("/{}/p2p/id", "a".repeat(256))
    ]);
    let merged = merge(&wire).unwrap();
    assert_eq!(
        merged["bootNodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| **node == first)
            .count(),
        1
    );
    let mut empty = manifest();
    empty["p2p"]["bootnodes"] = serde_json::json!([]);
    let original: Value = serde_json::from_str(SPEC).unwrap();
    assert_eq!(merge(&empty).unwrap(), original);
}

#[test]
fn endpoint_is_fixed_https_and_rejects_credentials_queries_and_fragments() {
    assert_eq!(
        endpoint(" https://example.invalid/api/ ").unwrap().as_str(),
        "https://example.invalid/api/chain/citizensdk/bootstrap"
    );
    for base in [
        "http://example.invalid",
        "https://u:p@example.invalid",
        "https://example.invalid?a=1",
        "https://example.invalid/#x",
        "relative",
    ] {
        assert!(endpoint(base).is_err(), "{base}");
    }
    assert_eq!(TIMEOUT, Duration::from_secs(6));
}

#[test]
fn malformed_or_oversized_responses_are_not_accepted() {
    assert!(merge_bootnodes(SPEC, b"not json").is_err());
    assert!(merge_bootnodes(SPEC, &vec![b' '; MAX_RESPONSE_BYTES + 1]).is_err());
    assert!(merge_bootnodes("{}", &serde_json::to_vec(&manifest()).unwrap()).is_err());
}
