//! 固定完整轻节点的网络、同步、交易与内部 workspace 边界。

use std::path::Path;

const IDENTITY: &str = include_str!("../src/identity.rs");
const LIB: &str = include_str!("../src/lib.rs");
const LIB_MANIFEST: &str = include_str!("../Cargo.toml");
const LIBP2P: &str = include_str!("../src/libp2p.rs");
const NETWORK: &str = include_str!("../src/network.rs");
const NETWORK_SERVICE: &str = include_str!("../../light-base/src/network_service.rs");
const NOISE: &str = include_str!("../src/libp2p/connection/noise.rs");
const POW_WORKSPACE: &str = include_str!("../../Cargo.toml");
const SYNC: &str = include_str!("../src/sync.rs");
const TRANSACTIONS: &str = include_str!("../src/transactions.rs");

#[test]
fn light_client_module_closure_remains_present() {
    for module in [
        "pub mod chain_spec;",
        "pub mod informant;",
        "pub mod libp2p;",
        "pub mod network;",
        "pub mod sync;",
        "pub mod transactions;",
    ] {
        assert!(LIB.contains(module), "smoldot 入口缺少模块: {module}");
    }

    assert!(LIBP2P.contains("pub mod connection;"));
    assert!(LIBP2P.contains("pub mod peer_id;"));
    assert!(NETWORK.contains("pub mod codec;"));
    assert!(NETWORK.contains("pub mod service;"));
    assert!(SYNC.contains("pub mod all;"));
    assert!(SYNC.contains("pub mod warp_sync;"));
    assert!(TRANSACTIONS.contains("pub mod light_pool;"));
    assert!(TRANSACTIONS.contains("pub mod validate;"));
}

#[test]
fn workspace_contains_only_light_client_crates() {
    assert!(POW_WORKSPACE.contains("default-members = [\"lib\", \"light-base\"]"));
    assert!(!POW_WORKSPACE.contains("\"full-node\""));
    assert!(!POW_WORKSPACE.contains("\"wasm-node/rust\""));
    assert!(!LIB.contains("pub mod author;"));
    assert!(LIB.contains("pub mod identity;"));
    assert!(IDENTITY.contains("pub mod ss58;"));
}

#[test]
fn validated_dependency_closure_is_retained_without_secret_sources() {
    // The manifest retains CitizenApp's validated dependency declarations.
    // Cargo.lock is derived only by pruning unreachable excluded workspace
    // members while preserving every retained registry version/checksum.
    for dependency in [
        "\nbip39 =",
        "\nhmac =",
        "\npbkdf2 =",
        "schnorrkel/getrandom",
    ] {
        assert!(
            LIB_MANIFEST.contains(dependency),
            "已验证依赖闭包缺失: {dependency}"
        );
    }

    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for relative in [
        "src/author.rs",
        "src/author",
        "src/identity/keystore.rs",
        "src/identity/seed_phrase.rs",
    ] {
        assert!(
            !root.join(relative).exists(),
            "出现全节点私钥源码: {relative}"
        );
    }
}

#[test]
fn noise_keys_are_connection_scoped_and_zeroized() {
    assert!(NOISE.contains("zeroize::Zeroizing"));
    assert!(NETWORK_SERVICE.contains("Each connection has its own individual Noise key."));
    assert!(NETWORK_SERVICE.contains("connection::NoiseKey::new"));
    assert!(NETWORK_SERVICE.contains("fill_random_bytes"));
}

#[test]
fn product_features_and_cross_product_paths_are_absent() {
    let sources = [LIB, LIBP2P, NETWORK, SYNC, TRANSACTIONS];
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
            "轻节点核心重新引入了禁止能力: {forbidden}"
        );
    }

    for forbidden_path in ["citizenapp/", "shared/citizen", "../GMB"] {
        assert!(!LIB_MANIFEST.contains(forbidden_path));
        assert!(!POW_WORKSPACE.contains(forbidden_path));
    }
}
