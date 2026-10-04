//! 固定轻节点状态、runtime 与 RPC 能力，并拒绝第二套私钥管理路径。

use std::path::Path;

const DATABASE: &str = include_str!("../src/database.rs");
const EXECUTOR: &str = include_str!("../src/executor.rs");
const FULL_SQLITE: &str = include_str!("../src/database/full_sqlite.rs");
const IDENTITY: &str = include_str!("../src/identity.rs");
const JSON_RPC: &str = include_str!("../src/json_rpc.rs");
const SS58: &str = include_str!("../src/identity/ss58.rs");
const TRIE: &str = include_str!("../src/trie.rs");

#[test]
fn required_light_client_state_and_runtime_modules_remain_present() {
    for module in [
        "pub mod branch_search;",
        "pub mod calculate_root;",
        "pub mod minimize_proof;",
        "pub mod prefix_proof;",
        "pub mod proof_decode;",
        "pub mod proof_encode;",
        "pub mod trie_node;",
        "pub mod trie_structure;",
    ] {
        assert!(TRIE.contains(module), "trie 缺少模块: {module}");
    }

    for module in [
        "pub mod host;",
        "pub mod runtime_call;",
        "pub mod storage_diff;",
        "pub mod trie_root_calculator;",
        "pub mod vm;",
    ] {
        assert!(EXECUTOR.contains(module), "executor 缺少模块: {module}");
    }

    assert!(DATABASE.contains("pub mod finalized_serialize;"));
    assert!(DATABASE.contains("pub mod full_sqlite;"));
    assert!(FULL_SQLITE.contains("#![cfg(feature = \"database-sqlite\")]"));

    for module in [
        "pub mod methods;",
        "pub mod parse;",
        "pub mod payment_info;",
        "pub mod service;",
    ] {
        assert!(JSON_RPC.contains(module), "json_rpc 缺少模块: {module}");
    }
}

#[test]
fn identity_namespace_contains_only_public_ss58_capability() {
    assert!(IDENTITY.contains("pub mod ss58;"));
    assert!(!IDENTITY.contains("pub mod keystore;"));
    assert!(!IDENTITY.contains("pub mod seed_phrase;"));
    assert!(SS58.contains("pub fn encode("));
    assert!(SS58.contains("pub fn decode("));

    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for relative in ["src/identity/keystore.rs", "src/identity/seed_phrase.rs"] {
        assert!(
            !root.join(relative).exists(),
            "出现第二套私钥管理文件: {relative}"
        );
    }
}

#[test]
fn product_features_are_absent_from_state_runtime_roots() {
    let sources = [DATABASE, EXECUTOR, IDENTITY, JSON_RPC, SS58, TRIE];
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
            "状态/runtime 核心重新引入了禁止能力: {forbidden}"
        );
    }
}
