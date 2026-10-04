//! 固定 light-base 的轻节点职责，并拒绝真实的跨产品源码依赖。

const MANIFEST: &str = include_str!("../Cargo.toml");
const LIB_SOURCE: &str = include_str!("../src/lib.rs");
const JSON_RPC: &str = include_str!("../src/json_rpc_service.rs");
const NETWORK: &str = include_str!("../src/network_service.rs");
const RUNTIME: &str = include_str!("../src/runtime_service.rs");
const SYNC: &str = include_str!("../src/sync_service.rs");
const TRANSACTIONS: &str = include_str!("../src/transactions_service.rs");

#[test]
fn required_light_node_services_remain_present() {
    for module in [
        "mod database;",
        "mod json_rpc_service;",
        "mod runtime_service;",
        "mod sync_service;",
        "mod transactions_service;",
        "pub mod network_service;",
        "pub mod platform;",
    ] {
        assert!(LIB_SOURCE.contains(module), "light-base 缺少模块: {module}");
    }

    assert!(JSON_RPC.contains("pub fn service"));
    assert!(NETWORK.contains("pub struct NetworkService"));
    assert!(RUNTIME.contains("pub struct RuntimeService"));
    assert!(SYNC.contains("pub struct SyncService"));
    assert!(TRANSACTIONS.contains("pub struct TransactionsService"));
    assert!(TRANSACTIONS.contains("pub async fn submit_transaction"));
}

#[test]
fn product_features_and_cross_product_paths_are_absent() {
    let sources = [
        MANIFEST,
        LIB_SOURCE,
        JSON_RPC,
        NETWORK,
        RUNTIME,
        SYNC,
        TRANSACTIONS,
    ];
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
            "light-base 重新引入了禁止能力: {forbidden}"
        );
    }

    for forbidden_path in ["citizenapp/", "shared/", "../../"] {
        assert!(
            !MANIFEST.contains(forbidden_path),
            "light-base 清单存在跨产品路径: {forbidden_path}"
        );
    }
}
