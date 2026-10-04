//! 固定当前 Dart 运行路径使用的 legacy `libsmoldot` 边界。
//!
//! 产品级 `citizensdk_*` 头已迁到根 `include/`；这里不再伪装成产品公共 SDK 头，但
//! 动态库名、smoldot 函数、回调以及 signer 宏导出的四个符号必须继续兼容。

const MANIFEST: &str = include_str!("../Cargo.toml");
const LIB_SOURCE: &str = include_str!("../src/lib.rs");
const NODE_HEADER: &str = include_str!("../../include/smoldot.h");

#[test]
fn legacy_node_header_keeps_every_current_operation() {
    assert!(MANIFEST.contains("name = \"smoldot\""));
    assert!(NODE_HEADER.contains("typedef void (*SmoldotDartCallback)"));
    for symbol in [
        "smoldot_client_init",
        "smoldot_add_chain",
        "smoldot_send_json_rpc",
        "smoldot_next_json_rpc_response",
        "smoldot_remove_chain",
        "smoldot_client_destroy",
        "smoldot_free_string",
        "smoldot_version",
        "smoldot_get_status_snapshot_async",
        "smoldot_get_runtime_version_async",
        "smoldot_get_metadata_async",
        "smoldot_get_account_next_index_async",
        "smoldot_get_block_hash_async",
        "smoldot_get_block_extrinsics_async",
        "smoldot_submit_extrinsic_async",
        "smoldot_get_system_account_async",
        "smoldot_get_finalized_system_account_async",
        "smoldot_get_storage_value_async",
        "smoldot_get_finalized_storage_value_async",
        "smoldot_get_storage_values_async",
        "smoldot_get_finalized_storage_values_async",
    ] {
        assert!(NODE_HEADER.contains(symbol), "smoldot.h 缺少 {symbol}");
        assert!(LIB_SOURCE.contains(symbol), "legacy Rust 缺少 {symbol}");
    }
}

#[test]
fn legacy_library_still_embeds_all_sr25519_exports() {
    assert!(MANIFEST.contains("citizen-signer = { path = \"../../signer\" }"));
    assert!(LIB_SOURCE.contains("citizen_signer::export_citizen_signer_ffi!();"));
    for symbol in [
        "citizen_sr25519_derive_hard",
        "citizen_sr25519_public_key",
        "citizen_sr25519_sign",
        "citizen_sr25519_verify",
    ] {
        let signer_source = include_str!("../../../signer/src/lib.rs");
        assert!(signer_source.contains(symbol), "signer 宏缺少 {symbol}");
    }
}
