//! 固定轻客户端共识能力，并阻止全节点密钥路径进入 CitizenSDK。

use std::path::Path;

const CHAIN: &str = include_str!("../src/chain.rs");
const CHAIN_INFORMATION: &str = include_str!("../src/chain/chain_information.rs");
const FINALITY: &str = include_str!("../src/finality.rs");
const HEADER: &str = include_str!("../src/header.rs");
const IDENTITY: &str = include_str!("../src/identity.rs");
const VERIFY: &str = include_str!("../src/verify.rs");

#[test]
fn required_light_client_consensus_modules_remain_present() {
    for module in [
        "pub mod async_tree;",
        "pub mod blocks_tree;",
        "pub mod chain_information;",
        "pub mod fork_tree;",
    ] {
        assert!(CHAIN.contains(module), "chain 缺少模块: {module}");
    }

    for module in ["pub mod decode;", "pub mod verify;"] {
        assert!(FINALITY.contains(module), "finality 缺少模块: {module}");
    }

    for module in [
        "pub mod aura;",
        "pub mod babe;",
        "pub mod body_only;",
        "pub mod header_only;",
        "pub mod inherents;",
        "pub mod pow;",
    ] {
        assert!(VERIFY.contains(module), "verify 缺少模块: {module}");
    }

    assert!(HEADER.contains("pub fn hash_from_scale_encoded_header"));
    assert!(HEADER.contains("pub fn extrinsics_root"));
    assert!(HEADER.contains("pub fn decode("));
    assert!(CHAIN_INFORMATION.contains("pub struct ValidChainInformation"));
    assert!(CHAIN_INFORMATION.contains("pub enum ChainInformationConsensus"));
    assert!(CHAIN_INFORMATION.contains("pub enum ChainInformationFinality"));
}

#[test]
fn full_node_authoring_and_keystore_sources_are_absent() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for relative in [
        "src/author.rs",
        "src/author",
        "src/identity/keystore.rs",
        "src/identity/seed_phrase.rs",
    ] {
        assert!(
            !root.join(relative).exists(),
            "轻客户端边界出现全节点或第二密钥路径: {relative}"
        );
    }

    assert!(IDENTITY.contains("pub mod ss58;"));
    assert!(!IDENTITY.contains("pub mod keystore;"));
    assert!(!IDENTITY.contains("pub mod seed_phrase;"));
}

#[test]
fn product_features_are_absent_from_consensus_roots() {
    let sources = [CHAIN, CHAIN_INFORMATION, FINALITY, HEADER, VERIFY];
    for forbidden in [
        "chat_mls",
        "openmls",
        "account_crypto",
        "account-crypto",
        "tuyu",
    ] {
        assert!(
            sources
                .iter()
                .all(|source| !source.to_lowercase().contains(forbidden)),
            "链共识核心重新引入了禁止能力: {forbidden}"
        );
    }
}
