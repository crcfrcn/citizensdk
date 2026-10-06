use std::{
    collections::BTreeSet,
    mem::{align_of, size_of},
};

use citizensdk::{
    CitizenSdkAccountBalanceInfo, CitizenSdkAccountId, CitizenSdkAccountNonceInfo,
    CitizenSdkFeeSnapshotInfo, CitizenSdkHostBoolResultV1, CitizenSdkHostBytesResultV1,
    CitizenSdkHostHash32, CitizenSdkHostId128, CitizenSdkHostPublicStoreV1,
    CitizenSdkHostRecordResultV1, CitizenSdkHostSecretRefV1, CitizenSdkHostSecretVaultV1,
    CitizenSdkHostSecureStoreV1, CitizenSdkHostServicesV1, CitizenSdkHostStatusResultV1,
    CitizenSdkHostVaultAvailabilityResultV1, CitizenSdkHostWalletKeyRefV1,
    CitizenSdkMutableBytesView, CitizenSdkPreparedWalletInfo, CitizenSdkResultKind,
    CitizenSdkTransactionHistoryPageInfo, CitizenSdkTransactionHistoryRecordInfo, CitizenSdkU128,
    CitizenSdkWalletAccountInfo, CitizenSdkWalletProfileInfo, CitizenSdkWalletStateAccountInfo,
    CitizenSdkWalletStateInfo,
};

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
            .unwrap_or_else(|| panic!("no_mangle without function declaration"));
        let name = declaration
            .split("fn ")
            .nth(1)
            .and_then(|value| value.split(['(', '<']).next())
            .unwrap_or_else(|| panic!("cannot parse export: {declaration}"));
        if name == "$name" {
            continue; // 裁剪构建的宏模板不是额外公开符号。
        }
        assert!(exports.insert(name.to_owned()), "duplicate export {name}");
    }
    exports
}

fn header_functions(header: &str) -> BTreeSet<String> {
    let bytes = header.as_bytes();
    let mut functions = BTreeSet::new();
    let mut offset = 0;
    while let Some(relative) = header[offset..].find("citizensdk_") {
        let start = offset + relative;
        let mut end = start;
        while end < bytes.len()
            && (bytes[end].is_ascii_lowercase()
                || bytes[end].is_ascii_digit()
                || bytes[end] == b'_')
        {
            end += 1;
        }
        let following = header[end..].trim_start();
        if following.starts_with('(') {
            functions.insert(header[start..end].to_owned());
        }
        offset = end.max(start + 1);
    }
    functions
}

#[test]
fn base_wallet_and_qr_exports_are_exact_and_disjoint() {
    let source = include_str!("../src/lib.rs");
    let mut old = rust_exports(source);
    // Android 系统证书初始化仅是 JNI 内部符号，不能混入钱包/QR 的公开 ABI 计数。
    assert!(source.contains("#[cfg(target_os = \"android\")]\n#[no_mangle]\npub unsafe extern \"C\" fn citizensdk_android_init_tls"));
    assert!(old.remove("citizensdk_android_init_tls"));
    let wallet = rust_exports(include_str!("../src/wallet_abi.rs"));
    let qr = rust_exports(include_str!("../src/qr_abi.rs"));
    // 钱包函数逐项对拍同一144项公开C闭集；被删除的结果编号不重排、不复用。
    assert_eq!(old.len(), 53);
    assert_eq!(wallet.len(), 73);
    assert_eq!(qr.len(), 11);
    assert!(old.is_disjoint(&wallet));
    assert!(old.is_disjoint(&qr));
    assert!(wallet.is_disjoint(&qr));

    let expected_wallet: BTreeSet<_> = [
        "citizensdk_add_next_wallet_account",
        "citizensdk_delete_diagnostic_wallet",
        "citizensdk_encode_signing_payload",
        "citizensdk_private_key_cancel",
        "citizensdk_private_key_finish",
        "citizensdk_private_key_open",
        "citizensdk_private_key_reveal",
        "citizensdk_rename_diagnostic_wallet",
        "citizensdk_rename_wallet",
        "citizensdk_repair_hot_wallet",
        "citizensdk_set_active_wallet",
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
        "citizensdk_create_with_host",
        "citizensdk_wallet_word_suggestions",
        "citizensdk_get_genesis_hash",
        "citizensdk_get_finalized_account_balances",
        "citizensdk_get_finalized_account_balance",
        "citizensdk_get_account_nonce",
        "citizensdk_get_best_fee_snapshot",
        "citizensdk_get_wallet_profile",
        "citizensdk_get_wallet_state",
        "citizensdk_import_cold_account_id",
        "citizensdk_import_cold_account_ss58",
        "citizensdk_reorder_wallet_accounts_without_default_change",
        "citizensdk_rename_account",
        "citizensdk_delete_account",
        "citizensdk_prepare_wallet_creation",
        "citizensdk_prepared_wallet_copy_mnemonic",
        "citizensdk_prepared_wallet_release",
        "citizensdk_commit_wallet_creation",
        "citizensdk_import_wallet",
        "citizensdk_add_wallet_accounts",
        "citizensdk_set_active_wallet_account",
        "citizensdk_rename_wallet_account",
        "citizensdk_delete_wallet_account",
        "citizensdk_delete_wallet",
        "citizensdk_reconcile_wallet_cleanup",
        "citizensdk_sign_wallet_payload",
        "citizensdk_begin_signing",
        "citizensdk_consume_external_signature",
        "citizensdk_cancel_signing_session",
        "citizensdk_begin_default_account_change",
        "citizensdk_consume_default_account_change",
        "citizensdk_result_get_account_balance",
        "citizensdk_result_get_account_balance_count",
        "citizensdk_result_get_account_balance_at",
        "citizensdk_result_get_account_nonce",
        "citizensdk_result_get_fee_snapshot",
        "citizensdk_result_estimate_fee",
        "citizensdk_result_get_wallet_profile",
        "citizensdk_result_get_wallet_state",
        "citizensdk_result_get_wallet_state_account",
        "citizensdk_result_get_wallet_account_count",
        "citizensdk_result_get_wallet_account",
        "citizensdk_result_get_signature",
        "citizensdk_result_get_signing_outcome",
        "citizensdk_result_get_default_account_change",
        "citizensdk_result_get_prepared_wallet",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(wallet, expected_wallet);

    let transaction = rust_exports(include_str!("../src/transaction_abi.rs"));
    let expected_transaction: BTreeSet<_> = [
        "citizensdk_prepare_transaction",
        "citizensdk_prepared_transaction_release",
        "citizensdk_result_get_prepared_transaction",
        "citizensdk_execute_prepared_transaction",
        "citizensdk_transaction_execution_consume_qr_response",
        "citizensdk_transaction_execution_cancel",
        "citizensdk_result_get_transaction_execution",
        "citizensdk_get_transaction_history",
        "citizensdk_sync_transaction_history",
        "citizensdk_result_get_transaction_history_page",
        "citizensdk_result_get_transaction_history_record",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(transaction, expected_transaction);

    let presence = rust_exports(include_str!("../src/host_providers.rs"));
    assert_eq!(
        presence,
        BTreeSet::from([
            "citizensdk_set_secret_presence_provider".to_owned(),
            "citizensdk_encrypted_secret_record_has_secret".to_owned(),
        ])
    );
    assert!(presence.is_disjoint(&old));
    assert!(presence.is_disjoint(&wallet));
    assert!(presence.is_disjoint(&qr));
    assert!(presence.is_disjoint(&transaction));
    let header = header_functions(include_str!("../../../include/citizensdk.h"));
    let all: BTreeSet<_> = old
        .union(&wallet)
        .chain(qr.iter())
        .chain(transaction.iter())
        .chain(presence.iter())
        .cloned()
        .collect();
    assert_eq!(header, all);
}

#[test]
fn new_exports_allow_only_the_reviewed_receiver_not_raw_rpc_or_secret_getters() {
    let wallet = rust_exports(include_str!("../src/wallet_abi.rs"));
    for symbol in wallet {
        if [
            "citizensdk_private_key_open",
            "citizensdk_private_key_reveal",
            "citizensdk_private_key_cancel",
            "citizensdk_private_key_finish",
        ]
        .contains(&symbol.as_str())
        {
            continue; // 四入口的精确签名和receiver布局由C/符号合同另行冻结。
        }
        for forbidden in [
            "rpc",
            "private_key",
            "mini_secret",
            "raw_signer",
            "signed_extrinsic",
        ] {
            assert!(!symbol.contains(forbidden), "forbidden export {symbol}");
        }
    }
}

#[test]
fn appended_result_values_and_portable_product_layouts_are_frozen() {
    assert_eq!(CitizenSdkResultKind::AccountBalance as u32, 9);
    assert_eq!(CitizenSdkResultKind::AccountNonce as u32, 10);
    assert_eq!(CitizenSdkResultKind::FeeSnapshot as u32, 11);
    assert_eq!(CitizenSdkResultKind::WalletProfile as u32, 12);
    assert_eq!(CitizenSdkResultKind::WalletAccounts as u32, 13);
    assert_eq!(CitizenSdkResultKind::Signature as u32, 14);
    assert_eq!(CitizenSdkResultKind::PreparedWallet as u32, 15);
    assert_eq!(CitizenSdkResultKind::TransactionHistoryPage as u32, 17);
    assert_eq!(CitizenSdkResultKind::AccountBalances as u32, 18);
    assert_eq!(CitizenSdkResultKind::QrReview as u32, 19);
    assert_eq!(CitizenSdkResultKind::QrSigned as u32, 20);
    assert_eq!(CitizenSdkResultKind::WalletState as u32, 21);
    // 复合准备仅追加31，既有结果编号保持不变。
    assert!(include_str!("../../../include/citizensdk_types.h")
        .contains("#define CITIZENSDK_RESULT_ACCOUNT_BALANCES 18U"));

    assert_eq!(size_of::<CitizenSdkU128>(), 16);
    assert_eq!(align_of::<CitizenSdkU128>(), 8);
    assert_eq!(size_of::<CitizenSdkAccountId>(), 32);
    assert_eq!(size_of::<CitizenSdkAccountBalanceInfo>(), 144);
    assert_eq!(size_of::<CitizenSdkAccountNonceInfo>(), 104);
    assert_eq!(size_of::<CitizenSdkFeeSnapshotInfo>(), 104);
    assert_eq!(size_of::<CitizenSdkWalletProfileInfo>(), 96);
    assert_eq!(size_of::<CitizenSdkWalletAccountInfo>(), 72);
    assert_eq!(size_of::<CitizenSdkWalletStateInfo>(), 56);
    assert_eq!(size_of::<CitizenSdkWalletStateAccountInfo>(), 88);
    assert_eq!(size_of::<CitizenSdkPreparedWalletInfo>(), 16);
    assert_eq!(size_of::<CitizenSdkTransactionHistoryPageInfo>(), 40);
    assert_eq!(size_of::<CitizenSdkTransactionHistoryRecordInfo>(), 336);
}

#[test]
fn chain_query_sources_keep_one_engine_path_and_no_wallet_probe_or_secret_dependency() {
    let source = include_str!("../src/wallet_abi.rs");
    let genesis = source
        .split("pub unsafe extern \"C\" fn citizensdk_get_genesis_hash(")
        .nth(1)
        .unwrap_or_else(|| panic!("missing genesis entry"))
        .split("#[no_mangle]")
        .next()
        .unwrap_or_default();
    assert!(genesis.contains("runtime.engine().genesis_hash()?"));
    assert!(!genesis.contains("refresh_provider_capabilities"));
    assert!(!genesis.contains("accept_and_write"));
    let balances = source
        .split("pub unsafe extern \"C\" fn citizensdk_get_finalized_account_balances(")
        .nth(1)
        .unwrap_or_else(|| panic!("missing batch entry"))
        .split("#[no_mangle]")
        .next()
        .unwrap_or_default();
    assert!(balances.contains("accept_and_write(runtime, out_request_id"));
    assert!(balances.contains("runtime.engine().finalized_account_balances(accounts)"));
    assert!(balances.contains("account_count == 0"));
    assert!(balances.contains("if !accounts.is_empty()"));
    assert!(balances.contains("runtime.refresh_chain_readiness()?"));
    for forbidden in [
        "refresh_provider_capabilities",
        "wallet_profile",
        "secret_vault",
        "get_storage",
        "requests::accept(",
    ] {
        assert!(
            !balances.contains(forbidden),
            "batch entry must not bypass Engine: {forbidden}"
        );
    }
    for (symbol, accessor) in [
        (
            "citizensdk_result_get_account_balance_count",
            "ownership::account_balance_count(result)?",
        ),
        (
            "citizensdk_result_get_account_balance_at",
            "ownership::account_balance_at(result, index)?",
        ),
    ] {
        let declaration = format!("pub unsafe extern \"C\" fn {symbol}(");
        let projection = source
            .split(declaration.as_str())
            .nth(1)
            .unwrap_or_else(|| panic!("missing batch projection"))
            .split("#[no_mangle]")
            .next()
            .unwrap_or_default();
        assert!(projection.contains(accessor));
        assert!(
            !projection.contains("ownership::get("),
            "per-item read must not clone the complete batch"
        );
    }
}

#[test]
fn host_v1_layout_matches_the_c_header_contract() {
    assert_eq!(size_of::<CitizenSdkMutableBytesView>(), 16);
    assert_eq!(size_of::<CitizenSdkHostHash32>(), 32);
    assert_eq!(size_of::<CitizenSdkHostId128>(), 16);
    assert_eq!(size_of::<CitizenSdkHostSecretRefV1>(), 80);
    assert_eq!(size_of::<CitizenSdkHostWalletKeyRefV1>(), 32);
    assert_eq!(size_of::<CitizenSdkHostRecordResultV1>(), 56);
    assert_eq!(size_of::<CitizenSdkHostStatusResultV1>(), 24);
    assert_eq!(size_of::<CitizenSdkHostBoolResultV1>(), 32);
    assert_eq!(size_of::<CitizenSdkHostVaultAvailabilityResultV1>(), 24);
    assert_eq!(size_of::<CitizenSdkHostBytesResultV1>(), 40);
    assert_eq!(size_of::<CitizenSdkHostPublicStoreV1>(), 72);
    assert_eq!(size_of::<CitizenSdkHostSecureStoreV1>(), 48);
    assert_eq!(size_of::<CitizenSdkHostSecretVaultV1>(), 72);
    assert_eq!(size_of::<CitizenSdkHostServicesV1>(), 32);
}

#[test]
fn header_exposes_mutable_dek_output_but_no_plaintext_completion_kind() {
    let types = include_str!("../../../include/citizensdk_types.h");
    assert!(types.contains("citizensdk_mutable_bytes_view_t plaintext_dek_out"));
    assert!(types.contains("CITIZENSDK_HOST_BYTES_WRAPPED_DEK"));
    assert!(!types.contains("HOST_BYTES_PLAINTEXT_DEK"));
    assert!(!types.contains("host_sign"));
}

#[test]
fn module_validation_rejects_invalid_or_uncompiled_combinations() {
    use citizen_sdk_contracts::Modules;
    use citizensdk::{citizensdk_validate_modules, CitizenSdkErrorCode};
    for bits in [
        0,
        64,
        Modules::ALL | 64,
        Modules::TRANSACTIONS,
        Modules::HISTORY,
    ] {
        assert_eq!(
            citizensdk_validate_modules(bits),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
    }
    let compiled = (if cfg!(feature = "wallet") {
        Modules::WALLET
    } else {
        0
    }) | (if cfg!(feature = "signing") {
        Modules::SIGNING
    } else {
        0
    }) | (if cfg!(feature = "chain") {
        Modules::CHAIN
    } else {
        0
    }) | (if cfg!(feature = "transactions") {
        Modules::TRANSACTIONS
    } else {
        0
    }) | (if cfg!(feature = "history") {
        Modules::HISTORY
    } else {
        0
    }) | (if cfg!(feature = "qr") { Modules::QR } else { 0 });
    for bits in [
        Modules::WALLET,
        Modules::SIGNING,
        Modules::CHAIN,
        Modules::CHAIN | Modules::TRANSACTIONS,
        Modules::CHAIN | Modules::HISTORY,
        Modules::QR,
        Modules::QR | Modules::SIGNING | Modules::CHAIN,
        Modules::ALL,
    ] {
        let expected = if bits & !compiled == 0 {
            CitizenSdkErrorCode::Ok
        } else {
            CitizenSdkErrorCode::Unsupported
        };
        assert_eq!(citizensdk_validate_modules(bits), expected.as_i32());
    }
}

#[cfg(feature = "signing")]
#[test]
#[expect(
    unsafe_code,
    reason = "公开C ABI测试必须跨raw-pointer边界，借用存续与长度由本用例固定"
)]
fn pure_signature_verification_needs_no_wallet_vault_or_chain_instance() {
    use citizensdk::{citizensdk_verify_signature, CitizenSdkBytesView, CitizenSdkErrorCode};
    fn bytes(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).expect("公开金标为ASCII");
                u8::from_str_radix(pair, 16).expect("公开金标为hex")
            })
            .collect()
    }
    fn view(value: &[u8]) -> CitizenSdkBytesView {
        CitizenSdkBytesView {
            data: value.as_ptr(),
            len: value.len() as u64,
        }
    }
    // 只读取既有公开交易金标的公钥、消息和签名，不导入或生成私钥。
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/transaction/citizenchain-transfer-build-v1.json"
    ))
    .expect("公开金标JSON");
    let public_key = bytes(vector["transfer"]["source_account_id"].as_str().unwrap());
    let account = CitizenSdkAccountId {
        bytes: public_key.try_into().expect("32字节公钥"),
    };
    let signature = bytes(
        vector["public_test_signature"]["signature"]
            .as_str()
            .unwrap(),
    );
    let mut message = bytes(vector["expected"]["signing_message"].as_str().unwrap());
    let mut valid = 0;
    // SAFETY: 公开夹具字节与输出在每次同步调用期间存续；短签名仍必须由生产入口拒绝。
    unsafe {
        assert_eq!(
            citizensdk_verify_signature(&account, view(&signature), view(&message), &mut valid),
            CitizenSdkErrorCode::Ok.as_i32()
        );
        assert_eq!(valid, 1);
        message[0] ^= 1;
        assert_eq!(
            citizensdk_verify_signature(&account, view(&signature), view(&message), &mut valid),
            CitizenSdkErrorCode::Ok.as_i32()
        );
        assert_eq!(valid, 0);
        assert_eq!(
            citizensdk_verify_signature(
                &account,
                view(&signature[..63]),
                view(&message),
                &mut valid
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
    }
}

#[cfg(feature = "signing")]
#[test]
#[expect(
    unsafe_code,
    reason = "验证公开C入口拒绝缺失宿主表，全部非空指针均指向本用例存续对象"
)]
fn local_signing_create_rejects_absent_or_partial_secure_resources() {
    use citizen_sdk_contracts::Modules;
    use citizensdk::{
        citizensdk_create_with_modules, CitizenSdkCreateOptions, CitizenSdkErrorCode,
    };
    let empty = citizensdk::CitizenSdkBytesView {
        data: std::ptr::null(),
        len: 0,
    };
    let options = CitizenSdkCreateOptions {
        struct_size: size_of::<CitizenSdkCreateOptions>() as u32,
        abi_version: citizensdk::CITIZENSDK_ABI_VERSION,
        asset_manifest: empty,
        chain_spec: empty,
        light_sync_state: empty,
        system_name: empty,
        system_version: empty,
    };
    let mut handle = 0;
    // SAFETY: options和输出指针有效；空宿主表明确表示未提供资源，必须拒绝。
    unsafe {
        assert_eq!(
            citizensdk_create_with_modules(
                &options,
                std::ptr::null(),
                Modules::SIGNING,
                &mut handle
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
    }
    assert_eq!(handle, 0);
    let secure = CitizenSdkHostSecureStoreV1::default();
    let services = CitizenSdkHostServicesV1 {
        secure_store: &secure,
        ..CitizenSdkHostServicesV1::default()
    };
    // SAFETY: 非空表在调用期间可读；缺失回调必须在接纳前拒绝，绝不执行。
    unsafe {
        assert_eq!(
            citizensdk_create_with_modules(&options, &services, Modules::SIGNING, &mut handle),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
    }
    assert_eq!(handle, 0);
}
