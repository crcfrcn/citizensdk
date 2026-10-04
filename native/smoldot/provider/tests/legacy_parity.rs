//! The product provider is additive. Current Dart keeps loading `libsmoldot`, so every legacy
//! light-client and signer export remains frozen until a later explicitly approved migration.

const LEGACY_SOURCE: &str = include_str!("../../ffi/src/lib.rs");
const LEGACY_HEADER: &str = include_str!("../../include/smoldot.h");
const LEGACY_MANIFEST: &str = include_str!("../../ffi/Cargo.toml");

#[test]
fn legacy_library_name_callbacks_and_symbols_remain_unchanged() {
    assert!(LEGACY_MANIFEST.contains("name = \"smoldot\""));
    assert!(LEGACY_MANIFEST.contains("citizen-signer = { path = \"../../signer\" }"));
    assert!(LEGACY_SOURCE.contains("citizen_signer::export_citizen_signer_ffi!();"));
    assert!(LEGACY_HEADER.contains("typedef void (*SmoldotDartCallback)"));

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
        assert!(LEGACY_SOURCE.contains(symbol), "legacy Rust 缺少 {symbol}");
        assert!(
            LEGACY_HEADER.contains(symbol),
            "legacy header 缺少 {symbol}"
        );
    }
}

#[test]
fn provider_does_not_rename_or_reexport_legacy_symbols() {
    for source in [
        include_str!("../src/lib.rs"),
        include_str!("../src/client.rs"),
        include_str!("../src/verified_chain_client.rs"),
    ] {
        assert!(!source.contains("#[no_mangle]"));
        assert!(!source.contains("extern \"C\""));
    }
}
