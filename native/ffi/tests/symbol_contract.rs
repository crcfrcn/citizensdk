use std::collections::{BTreeMap, BTreeSet};

// 独立显式金标固定144项；各函数与公开头逐项一致，不从生产头生成预期。
const EXPECTED_EXPORTS: [&str; 144] = [
    "citizensdk_add_next_wallet_account",
    "citizensdk_delete_diagnostic_wallet",
    "citizensdk_encode_signing_payload",
    "citizensdk_encrypted_secret_record_has_secret",
    "citizensdk_private_key_cancel",
    "citizensdk_private_key_finish",
    "citizensdk_private_key_open",
    "citizensdk_private_key_reveal",
    "citizensdk_qr_encode_document",
    "citizensdk_qr_prepare_account_authorization",
    "citizensdk_qr_validate_sign_response",
    "citizensdk_rename_diagnostic_wallet",
    "citizensdk_rename_wallet",
    "citizensdk_repair_hot_wallet",
    "citizensdk_set_active_wallet",
    "citizensdk_set_secret_presence_provider",
    "citizensdk_sign_and_delete_wallet",
    "citizensdk_validate_wallet_input",
    "citizensdk_wallet_profile_copy_name",
    "citizensdk_wallet_state_copy_diagnostic_text",
    "citizensdk_wallet_state_get_active_wallet",
    "citizensdk_wallet_state_get_diagnostic_at",
    "citizensdk_wallet_state_get_diagnostic_cleanup_account",
    "citizensdk_wallet_state_get_diagnostic_count",
    "citizensdk_wallet_state_get_initialization",
    "citizensdk_wallet_state_retain",
    "citizensdk_abi_version",
    "citizensdk_add_wallet_accounts",
    "citizensdk_begin_default_account_change",
    "citizensdk_begin_signing",
    "citizensdk_call_runtime_api",
    "citizensdk_cancel_signing_session",
    "citizensdk_cancel_request",
    "citizensdk_commit_wallet_creation",
    "citizensdk_consume_default_account_change",
    "citizensdk_consume_external_signature",
    "citizensdk_create",
    "citizensdk_create_options_size",
    "citizensdk_create_with_host",
    "citizensdk_create_with_modules",
    "citizensdk_validate_modules",
    "citizensdk_accept_request_sequence",
    "citizensdk_verify_signature",
    "citizensdk_delete_wallet",
    "citizensdk_delete_wallet_account",
    "citizensdk_destroy",
    "citizensdk_export_state",
    "citizensdk_execute_prepared_transaction",
    "citizensdk_get_account_nonce",
    "citizensdk_get_best_fee_snapshot",
    "citizensdk_get_best_head",
    "citizensdk_get_block_body_at",
    "citizensdk_get_block_header_at",
    "citizensdk_get_capabilities",
    "citizensdk_get_finalized_account_balance",
    "citizensdk_get_finalized_account_balances",
    "citizensdk_get_genesis_hash",
    "citizensdk_get_finalized_head",
    "citizensdk_get_finalized_block_at",
    "citizensdk_get_lifecycle",
    "citizensdk_get_runtime_context_at",
    "citizensdk_get_storage_at",
    "citizensdk_get_storage_batch_at",
    "citizensdk_get_storage_keys_paged",
    "citizensdk_get_sync_status",
    "citizensdk_get_system_events_at",
    "citizensdk_get_transaction_history",
    "citizensdk_get_wallet_profile",
    "citizensdk_get_wallet_state",
    "citizensdk_import_cold_account_id",
    "citizensdk_import_cold_account_ss58",
    "citizensdk_import_state",
    "citizensdk_import_wallet",
    "citizensdk_last_error_copy",
    "citizensdk_prepare_wallet_creation",
    "citizensdk_prepare_transaction",
    "citizensdk_prepared_transaction_release",
    "citizensdk_prepared_wallet_copy_mnemonic",
    "citizensdk_prepared_wallet_release",
    "citizensdk_reconcile_wallet_cleanup",
    "citizensdk_refresh_capabilities",
    "citizensdk_resolve_finalized_block",
    "citizensdk_qr_cancel_sign_request",
    "citizensdk_qr_consume_sign_response",
    "citizensdk_qr_create_sign_request",
    "citizensdk_review_qr_sign_request",
    "citizensdk_sign_qr_request",
    "citizensdk_result_copy_qr",
    "citizensdk_qr_encode_account_id",
    "citizensdk_qr_parse",
    "citizensdk_rename_wallet_account",
    "citizensdk_rename_account",
    "citizensdk_delete_account",
    "citizensdk_reorder_wallet_accounts_without_default_change",
    "citizensdk_result_copy_error_message",
    "citizensdk_result_copy_block_body_extrinsic",
    "citizensdk_result_copy_storage",
    "citizensdk_result_copy_storage_batch_item",
    "citizensdk_result_estimate_fee",
    "citizensdk_result_get_account_balance",
    "citizensdk_result_get_account_balance_count",
    "citizensdk_result_get_account_balance_at",
    "citizensdk_result_get_account_nonce",
    "citizensdk_result_get_block_ref",
    "citizensdk_result_get_block_body_info",
    "citizensdk_result_get_block_header",
    "citizensdk_result_get_execution",
    "citizensdk_result_get_exported_state",
    "citizensdk_result_get_fee_snapshot",
    "citizensdk_result_get_hash",
    "citizensdk_result_get_info",
    "citizensdk_result_get_failure_stage",
    "citizensdk_result_get_prepared_wallet",
    "citizensdk_result_get_prepared_transaction",
    "citizensdk_result_get_transaction_execution",
    "citizensdk_result_get_transaction_history_page",
    "citizensdk_result_get_transaction_history_record",
    "citizensdk_result_get_runtime_context",
    "citizensdk_result_get_signature",
    "citizensdk_result_get_signing_outcome",
    "citizensdk_result_get_storage_batch_count",
    "citizensdk_result_get_sync_status",
    "citizensdk_result_get_wallet_account",
    "citizensdk_result_get_wallet_account_count",
    "citizensdk_result_get_wallet_profile",
    "citizensdk_result_get_wallet_state",
    "citizensdk_result_get_wallet_state_account",
    "citizensdk_result_get_default_account_change",
    "citizensdk_result_get_watch_event",
    "citizensdk_result_release",
    "citizensdk_set_active_wallet_account",
    "citizensdk_set_event_callback",
    "citizensdk_sign_wallet_payload",
    "citizensdk_start",
    "citizensdk_stop",
    "citizensdk_submit_extrinsic",
    "citizensdk_subscribe_capability_changes",
    "citizensdk_sync_transaction_history",
    "citizensdk_transaction_execution_cancel",
    "citizensdk_transaction_execution_consume_qr_response",
    "citizensdk_unsubscribe_capability_changes",
    "citizensdk_verify_transaction_at",
    "citizensdk_wallet_word_suggestions",
    "citizensdk_watch_extrinsic",
];

fn rust_exports(source: &str) -> BTreeSet<String> {
    let lines: Vec<_> = source.lines().collect();
    let mut exports = BTreeSet::new();
    for (index, line) in lines.iter().enumerate() {
        if line.trim() != "#[no_mangle]" {
            continue;
        }
        let declaration = lines
            .iter()
            .skip(index + 1)
            .find(|candidate| candidate.contains("fn "))
            .unwrap_or_else(|| panic!("no_mangle without a function declaration"));
        let function = declaration
            .split("fn ")
            .nth(1)
            .and_then(|value| value.split(['(', '<']).next())
            .unwrap_or_else(|| panic!("cannot parse exported declaration: {declaration}"));
        // 未编译 QR 的宏模板不是第十个符号；实例化只复用下方精确九个名字。
        if function == "$name" {
            continue;
        }
        assert!(
            function.starts_with("citizensdk_"),
            "unexpected export {function}"
        );
        assert!(
            exports.insert(function.to_owned()),
            "duplicate export {function}"
        );
    }
    exports
}

#[test]
fn retired_private_view_exports_are_absent() {
    let source = include_str!("../src/wallet_abi.rs");
    assert!(!source.contains("fn citizensdk_internal_"));
    for name in [
        "citizensdk_private_key_open",
        "citizensdk_private_key_reveal",
        "citizensdk_private_key_cancel",
        "citizensdk_private_key_finish",
    ] {
        assert!(EXPECTED_EXPORTS.contains(&name));
    }
    assert!(!include_str!("../../../include/citizensdk.h").contains("citizensdk_internal_"));
    assert!(!include_str!("../../../include/citizensdk_types.h").contains("citizensdk_internal_"));
}

fn without_block_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(start) = rest.find("/*") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 2..];
        let end = after_start
            .find("*/")
            .unwrap_or_else(|| panic!("unterminated C block comment"));
        output.push(' ');
        rest = &after_start[end + 2..];
    }
    output.push_str(rest);
    output
}

fn header_declarations(header: &str) -> BTreeMap<String, String> {
    let uncommented = without_block_comments(header);
    let declarations = uncommented
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let mut exports = BTreeMap::new();
    for raw in declarations.split(';') {
        if !raw.contains("CITIZENSDK_API") {
            continue;
        }
        let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut search = normalized.as_str();
        let mut parsed = None;
        while let Some(start) = search.find("citizensdk_") {
            let candidate = &search[start..];
            let name_len = candidate
                .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
                .unwrap_or(candidate.len());
            let name = &candidate[..name_len];
            if candidate[name_len..].trim_start().starts_with('(') {
                parsed = Some(name.to_owned());
                break;
            }
            search = &candidate[name_len..];
        }
        let name =
            parsed.unwrap_or_else(|| panic!("cannot parse public declaration: {normalized}"));
        assert!(
            exports.insert(name.clone(), normalized).is_none(),
            "duplicate header declaration {name}"
        );
    }
    exports
}

#[test]
fn rust_and_c_publish_exactly_the_reviewed_product_symbols() {
    let expected: BTreeSet<_> = EXPECTED_EXPORTS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let source = include_str!("../src/lib.rs");
    let mut rust = rust_exports(source);
    // Android 专用系统证书初始化只供 JNI 内部调用，不扩大跨平台公开 C ABI。
    assert!(source.contains("#[cfg(target_os = \"android\")]\n#[no_mangle]\npub unsafe extern \"C\" fn citizensdk_android_init_tls"));
    assert!(rust.remove("citizensdk_android_init_tls"));
    let wallet = rust_exports(include_str!("../src/wallet_abi.rs"));
    let qr = rust_exports(include_str!("../src/qr_abi.rs"));
    let transaction = rust_exports(include_str!("../src/transaction_abi.rs"));
    assert_eq!(rust.len(), 53, "base Rust export count changed");
    assert_eq!(wallet.len(), 67, "wallet Rust export count changed");
    for export in wallet {
        assert!(
            rust.insert(export.clone()),
            "duplicate Rust export {export}"
        );
    }
    assert_eq!(qr.len(), 11, "QR Rust export count changed");
    for export in qr {
        assert!(
            rust.insert(export.clone()),
            "duplicate Rust export {export}"
        );
    }
    assert_eq!(
        transaction.len(),
        11,
        "transaction Rust export count changed"
    );
    for export in transaction {
        assert!(
            rust.insert(export.clone()),
            "duplicate Rust export {export}"
        );
    }
    let presence = rust_exports(include_str!("../src/host_providers.rs"));
    assert_eq!(presence.len(), 2);
    for export in presence {
        assert!(
            rust.insert(export.clone()),
            "duplicate Rust export {export}"
        );
    }
    let header: BTreeSet<_> = header_declarations(include_str!("../../../include/citizensdk.h"))
        .into_keys()
        .collect();

    assert_eq!(rust.len(), 144, "Rust export count changed");
    assert_eq!(header.len(), 144, "C declaration count changed");
    assert_eq!(rust, expected, "Rust export set changed");
    assert_eq!(header, expected, "C declaration set changed");
    assert!(!rust.contains("citizensdk_set_default_wallet_account"));
    assert!(!header.contains("citizensdk_set_default_wallet_account"));
}

#[test]
fn product_header_has_only_the_reviewed_mnemonic_crossings() {
    let declarations = header_declarations(include_str!("../../../include/citizensdk.h"));
    let mnemonic_crossings: BTreeSet<_> = declarations
        .iter()
        .filter(|(_, declaration)| declaration.contains("mnemonic"))
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        mnemonic_crossings,
        BTreeSet::from([
            "citizensdk_add_wallet_accounts",
            "citizensdk_import_wallet",
            "citizensdk_prepared_wallet_copy_mnemonic",
            "citizensdk_add_next_wallet_account",
        ])
    );

    for name in [
        "citizensdk_add_wallet_accounts",
        "citizensdk_add_next_wallet_account",
        "citizensdk_import_wallet",
    ] {
        let declaration = &declarations[name];
        assert!(declaration.contains("citizensdk_bytes_view_t mnemonic"));
        assert!(!declaration.contains("uint8_t *buffer"));
    }

    let copy = &declarations["citizensdk_prepared_wallet_copy_mnemonic"];
    assert!(copy.contains("citizensdk_handle_t handle"));
    assert!(copy.contains("citizensdk_prepared_wallet_handle_t prepared_wallet"));
    assert!(copy.contains("uint8_t *buffer"));
    assert!(copy.contains("uint64_t *out_required"));

    let release = &declarations["citizensdk_prepared_wallet_release"];
    assert!(release.contains("citizensdk_handle_t handle"));
    assert!(release.contains("citizensdk_prepared_wallet_handle_t prepared_wallet"));

    // 同时冻结Rust的准备资源owner；三种导入/追加都使用原受控输入与Core校验。
    let wallet_source = include_str!("../src/wallet_abi.rs")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(wallet_source.contains(
        "fn citizensdk_prepared_wallet_copy_mnemonic( handle: CitizenSdkHandle, \
         prepared_wallet: CitizenSdkPreparedWalletHandle,"
    ));
    assert!(wallet_source.contains(
        "fn citizensdk_prepared_wallet_release( handle: CitizenSdkHandle, \
         prepared_wallet: CitizenSdkPreparedWalletHandle,"
    ));
    assert!(wallet_source.contains(
        "fn citizensdk_import_wallet( handle: CitizenSdkHandle, mnemonic: CitizenSdkBytesView,"
    ));
    assert!(wallet_source.contains(
        "fn citizensdk_add_wallet_accounts( handle: CitizenSdkHandle, \
         mnemonic: CitizenSdkBytesView,"
    ));
}

#[test]
fn product_exports_have_no_provider_rpc_or_secret_escape_hatch() {
    let header = include_str!("../../../include/citizensdk.h");
    let declarations = header_declarations(header);
    // 只允许绑定实例与receiver的既定四签名；同名改参数也必须失败。
    assert_eq!(declarations["citizensdk_private_key_open"],
        "CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_open( citizensdk_handle_t handle, const citizensdk_account_id_t *account_id, const citizensdk_private_key_receiver_v1_t *receiver, uint64_t *out_secret_id, citizensdk_request_id_t *out_request_id)");
    for name in [
        "citizensdk_private_key_reveal",
        "citizensdk_private_key_cancel",
        "citizensdk_private_key_finish",
    ] {
        assert_eq!(declarations[name],
            format!("CITIZENSDK_API citizensdk_error_code_t {name}( citizensdk_handle_t handle, uint64_t secret_id)"));
    }
    let exported_surface = declarations
        .iter()
        // 仅既定四项receiver允许私钥词项，下面独立核对完整签名，不能按前缀放行。
        .filter(|(name, _)| {
            ![
                "citizensdk_private_key_open",
                "citizensdk_private_key_reveal",
                "citizensdk_private_key_cancel",
                "citizensdk_private_key_finish",
            ]
            .contains(&name.as_str())
        })
        .map(|(name, declaration)| format!("{name} {declaration}"))
        .collect::<Vec<_>>()
        .join("\n")
        .to_ascii_lowercase();

    for forbidden in [
        "private_key",
        "mini_secret",
        "rpc_method",
        "json_rpc",
        "raw_rpc",
        "smoldot_",
        "citizen_sr25519_",
        "account_crypto_",
        "export_secret",
        "get_secret",
    ] {
        assert!(
            !exported_surface.contains(forbidden),
            "forbidden public escape hatch {forbidden}"
        );
    }
    assert!(!header.contains("smoldot.h"));
    assert!(
        !declarations
            .keys()
            .any(|name| name.contains("signed_extrinsic") && name.contains("result")),
        "signed extrinsic result export is forbidden"
    );

    let types = include_str!("../../../include/citizensdk_types.h");
    assert!(types.contains("CITIZENSDK_CAPABILITY_COUNT 10U"));
    assert!(types.contains("CITIZENSDK_HOST_SECRET_ACCOUNT_MINI_SECRET 1U"));
    assert!(!types.contains("UINT32_C("));
    assert!(!types.contains("INT32_C("));
}
