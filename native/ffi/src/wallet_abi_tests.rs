// 仅在测试中要求定时器及预期错误成立；生产 ABI 不以 panic 处理业务错误。
#![allow(clippy::expect_used)]

use super::{
    citizensdk_encode_signing_payload, claim_prepared_wallet, copy_pair, encode_payload,
    lock_prepared_wallets, next_prepared_wallet_handle, require_prepared_owner, secret_utf8,
    u128_from_abi, u128_to_abi, wallet_profile_to_abi, wallet_word_count, PreparedWalletSlot,
};

#[test]
fn pure_payload_abi_rejects_duplicate_fields_and_short_output_without_writes() {
    assert_eq!(
        encode_payload(2, br#"{"op_tag":24}"#, &[]).unwrap(),
        b"GMB\x18"
    );
    for fields in [
        br#"{"op_tag":24,"op_tag":25}"#.as_slice(),
        br#"{"op_tag":24,"title":"not-ui"}"#.as_slice(),
        br#"{"op_tag":256}"#.as_slice(),
    ] {
        assert_eq!(
            encode_payload(2, fields, &[]).unwrap_err().code,
            CitizenSdkErrorCode::InvalidArgument
        );
    }
    assert!(encode_payload(5, b"{}", &[255]).is_err());
    assert!(encode_payload(6, br#"{"value":"01"}"#, &[]).is_err());
    assert_eq!(
        encode_payload(6, br#"{"value":"18446744073709551615"}"#, &[]).unwrap(),
        [255; 8]
    );
    assert!(encode_payload(6, br#"{"value":"18446744073709551616"}"#, &[]).is_err());
    assert!(encode_payload(2, br#"{"op_tag":24}"#, &[1]).is_err());
    let fields = br#"{"op_tag":24}"#;
    let input = CitizenSdkBytesView {
        data: fields.as_ptr(),
        len: fields.len() as u64,
    };
    let empty = CitizenSdkBytesView {
        data: std::ptr::null(),
        len: 0,
    };
    let mut required = 0;
    assert_eq!(
        unsafe {
            citizensdk_encode_signing_payload(
                2,
                input,
                empty,
                std::ptr::null_mut(),
                0,
                &mut required,
            )
        },
        0
    );
    assert_eq!(required, 4);
    let mut output = [0xa5; 3];
    assert_eq!(
        unsafe {
            citizensdk_encode_signing_payload(
                2,
                input,
                empty,
                output.as_mut_ptr(),
                3,
                &mut required,
            )
        },
        CitizenSdkErrorCode::InvalidArgument.as_i32()
    );
    assert_eq!(output, [0xa5; 3]);
}
use crate::abi::{
    CitizenSdkBytesView, CitizenSdkDefaultAccountChangeInfo, CitizenSdkErrorCode,
    CitizenSdkExternalSignerTransport, CitizenSdkSigningOutcomeInfo,
    CitizenSdkSigningOutcomeStatus, CitizenSdkU128, CitizenSdkWalletSignMode,
    CitizenSdkWalletStateAccountInfo, CitizenSdkWalletStateInfo, CitizenSdkWalletWordCount,
};
use citizen_sdk_contracts::{
    citizen_ss58_address, AccountId32, ColdWalletAccount, Hash32, SecretBuffer, SigningCompletion,
    Sr25519Signature, WalletState,
};
use std::sync::Arc;

#[test]
#[cfg(feature = "wallet")]
fn headless_input_validation_checks_abi_and_returns_only_typed_facts() {
    use crate::abi::CitizenSdkWalletInputValidationV1;
    use std::mem::{offset_of, size_of};

    assert_eq!(size_of::<CitizenSdkWalletInputValidationV1>(), 16);
    assert_eq!(offset_of!(CitizenSdkWalletInputValidationV1, reason), 8);
    assert_eq!(offset_of!(CitizenSdkWalletInputValidationV1, position), 12);
    let mut out = CitizenSdkWalletInputValidationV1::default();
    let input = |bytes: &[u8]| CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    };
    unsafe {
        assert_eq!(
            super::citizensdk_validate_wallet_input(1, input(b""), 0, &mut out),
            0
        );
        assert_eq!((out.reason, out.position), (0, u32::MAX));
        assert_eq!(
            super::citizensdk_validate_wallet_input(1, input(b"short"), 0, &mut out),
            0
        );
        assert_eq!((out.reason, out.position), (7, u32::MAX));
        assert_eq!(
            super::citizensdk_validate_wallet_input(2, input(&[0xff]), 12, &mut out),
            0
        );
        assert_eq!((out.reason, out.position), (6, u32::MAX));
        assert_eq!(
            super::citizensdk_validate_wallet_input(2, input(&[b'a'; 1025]), 12, &mut out),
            0
        );
        assert_eq!((out.reason, out.position), (1, u32::MAX));
        let previous = out;
        for (kind, count) in [(0, 0), (3, 0), (1, 12), (2, 15)] {
            assert_eq!(
                super::citizensdk_validate_wallet_input(kind, input(b""), count, &mut out),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(out, previous);
        }
        assert_eq!(
            super::citizensdk_validate_wallet_input(1, input(b""), 0, std::ptr::null_mut()),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        out.struct_size = 8;
        assert_eq!(
            super::citizensdk_validate_wallet_input(1, input(b""), 0, &mut out),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
    }
}

#[test]
fn application_key_result_has_one_exact_secret_copy_surface() {
    use crate::ownership::{self, OwnedResult, ResultPayload};

    let result = ownership::insert(OwnedResult::success(
        71,
        ResultPayload::ApplicationKey(Arc::new(SecretBuffer::try_new(vec![0x5a; 32]).unwrap())),
    ))
    .unwrap();
    let mut output = [0_u8; 32];
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_application_key(result, output.as_mut_ptr()),
            CitizenSdkErrorCode::Ok.as_i32(),
        );
        assert_eq!(
            super::citizensdk_result_get_application_key(result, std::ptr::null_mut()),
            CitizenSdkErrorCode::InvalidArgument.as_i32(),
        );
    }
    assert_eq!(output, [0x5a; 32]);
    ownership::release(result).unwrap();
}

// 准备批次与签名同属一个拥有者；无签名、错误类型、空输出及释放均严格拒绝或清零。
#[test]
fn application_preparation_result_shares_typed_owner_and_optional_signature() {
    use crate::ownership::{self, OwnedResult, ResultPayload};
    for signature in [None, Some(Sr25519Signature::from_bytes([0x6b; 64]))] {
        let result = ownership::insert(OwnedResult::success(
            71,
            ResultPayload::ApplicationKeyPreparation(
                Arc::new(SecretBuffer::try_new(vec![0x5a; 64]).unwrap()),
                signature,
            ),
        ))
        .unwrap();
        let mut key = [0_u8; 32];
        let mut bytes = [0xa5_u8; 64];
        let mut present = 7_u8;
        unsafe {
            assert_eq!(
                super::citizensdk_result_get_application_key_at(result, 1, key.as_mut_ptr()),
                0
            );
            assert_eq!(key, [0x5a; 32]);
            assert_eq!(
                super::citizensdk_result_get_application_preparation_signature(
                    result,
                    bytes.as_mut_ptr(),
                    &mut present
                ),
                0
            );
            assert_eq!(present, u8::from(signature.is_some()));
            assert_eq!(
                bytes,
                if signature.is_some() {
                    [0x6b; 64]
                } else {
                    [0; 64]
                }
            );
            assert_eq!(
                super::citizensdk_result_get_application_preparation_signature(
                    result,
                    std::ptr::null_mut(),
                    &mut present
                ),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(
                super::citizensdk_result_get_application_preparation_signature(
                    result,
                    bytes.as_mut_ptr(),
                    std::ptr::null_mut()
                ),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(
                super::citizensdk_result_get_application_key_at(result, 2, key.as_mut_ptr()),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
        }
        ownership::release(result).unwrap();
        unsafe {
            assert_ne!(
                super::citizensdk_result_get_application_preparation_signature(
                    result,
                    bytes.as_mut_ptr(),
                    &mut present
                ),
                0
            );
        }
        key.fill(0);
        bytes.fill(0);
    }
    let wrong = ownership::insert(OwnedResult::success(
        71,
        ResultPayload::Signature(Sr25519Signature::from_bytes([0x7c; 64])),
    ))
    .unwrap();
    let mut bytes = [0xa5; 64];
    let mut present = 7;
    unsafe {
        assert_ne!(
            super::citizensdk_result_get_application_preparation_signature(
                wrong,
                bytes.as_mut_ptr(),
                &mut present
            ),
            0
        );
    }
    assert_eq!(bytes, [0xa5; 64]);
    assert_eq!(present, 7);
    ownership::release(wrong).unwrap();
    bytes.fill(0);
}

#[test]
fn signing_and_default_change_results_preflight_and_project_each_variant_exactly() {
    use crate::ownership::{
        DefaultAccountChangePayload, ExternalSigningPending, OwnedResult, ResultPayload,
        SigningOutcomePayload,
    };

    let account = AccountId32::from_bytes([0x31; 32]);
    let payload_hash = Hash32::from_bytes([0x32; 32]);
    let signature = Sr25519Signature::from_bytes([0x33; 64]);
    let completed =
        crate::ownership::insert(OwnedResult::success(
            91,
            ResultPayload::SigningOutcome(SigningOutcomePayload::Completed(
                SigningCompletion::new(account, payload_hash, signature),
            )),
        ))
        .unwrap();
    let mut info = CitizenSdkSigningOutcomeInfo::default();
    let mut signature_output = [0_u8; 64];
    let mut signature_required = 0;
    let mut session_required = 99;
    let mut request_required = 99;
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_signing_outcome(
                completed,
                &mut info,
                signature_output.as_mut_ptr(),
                signature_output.len() as u64,
                &mut signature_required,
                std::ptr::null_mut(),
                0,
                &mut session_required,
                std::ptr::null_mut(),
                0,
                &mut request_required,
            ),
            CitizenSdkErrorCode::Ok.as_i32()
        );
    }
    assert_eq!(
        info.status,
        CitizenSdkSigningOutcomeStatus::Completed as u32
    );
    assert_eq!(
        info.transport,
        CitizenSdkExternalSignerTransport::None as u32
    );
    assert_eq!(info.account_id.bytes, account.into_bytes());
    assert_eq!(info.payload_hash, payload_hash.into_bytes());
    assert_eq!(signature_output, [0x33; 64]);
    assert_eq!(
        (signature_required, session_required, request_required),
        (64, 0, 0)
    );
    crate::ownership::release(completed).unwrap();

    let pending_payload = ExternalSigningPending {
        account_id: account,
        payload_hash,
        expires_at: 123,
        session_id: "external-session".to_owned(),
        transport_request: "QR_V1:opaque".to_owned(),
    };
    let pending = crate::ownership::insert(OwnedResult::success(
        92,
        ResultPayload::DefaultAccountChange(DefaultAccountChangePayload::ExternalPending(
            pending_payload,
        )),
    ))
    .unwrap();
    let mut default_info = CitizenSdkDefaultAccountChangeInfo::default();
    let mut short_session = [0xa5_u8; 2];
    let mut request = [0xa5_u8; 12];
    let mut required_session = 0;
    let mut required_request = 0;
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_default_account_change(
                pending,
                &mut default_info,
                short_session.as_mut_ptr(),
                short_session.len() as u64,
                &mut required_session,
                request.as_mut_ptr(),
                request.len() as u64,
                &mut required_request,
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
    }
    assert_eq!(short_session, [0xa5; 2]);
    assert_eq!(request, [0xa5; 12]);
    assert_eq!((required_session, required_request), (0, 0));

    let mut session = vec![0_u8; "external-session".len()];
    let mut request = vec![0_u8; "QR_V1:opaque".len()];
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_default_account_change(
                pending,
                &mut default_info,
                session.as_mut_ptr(),
                session.len() as u64,
                &mut required_session,
                request.as_mut_ptr(),
                request.len() as u64,
                &mut required_request,
            ),
            CitizenSdkErrorCode::Ok.as_i32()
        );
    }
    assert_eq!(
        default_info.status,
        CitizenSdkSigningOutcomeStatus::ExternalPending as u32
    );
    assert_eq!(
        default_info.transport,
        CitizenSdkExternalSignerTransport::QrV1 as u32
    );
    assert_eq!(default_info.expires_at, 123);
    assert_eq!(session, b"external-session");
    assert_eq!(request, b"QR_V1:opaque");
    crate::ownership::release(pending).unwrap();

    let completed_default = crate::ownership::insert(OwnedResult::success(
        93,
        ResultPayload::DefaultAccountChange(DefaultAccountChangePayload::Completed {
            current_default_account_id: account,
            payload_hash,
            committed_revision: 77,
        }),
    ))
    .unwrap();
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_default_account_change(
                completed_default,
                &mut default_info,
                std::ptr::null_mut(),
                0,
                &mut required_session,
                std::ptr::null_mut(),
                0,
                &mut required_request,
            ),
            CitizenSdkErrorCode::Ok.as_i32()
        );
    }
    assert_eq!(
        default_info.status,
        CitizenSdkSigningOutcomeStatus::Completed as u32
    );
    assert_eq!(default_info.committed_revision, 77);
    crate::ownership::release(completed_default).unwrap();
}

fn chain_query_runtime() -> Arc<crate::runtime::NativeRuntime> {
    let assets = crate::assets::verify_assets(
        include_bytes!("../../../chain/manifest.json"),
        include_bytes!("../../../chain/chainspec.json"),
        include_bytes!("../../../chain/light_sync_state.json"),
    )
    .expect("chain assets");
    let runtime = unsafe {
        crate::runtime::NativeRuntime::new_with_modules(
            crate::handles::reserve_handle().expect("handle"),
            Some(assets.combined_chain_spec),
            "CitizenSDK-query-test".to_owned(),
            "1.0.0".to_owned(),
            None,
            citizen_sdk_contracts::Modules::try_new(citizen_sdk_contracts::Modules::CHAIN)
                .expect("chain module"),
        )
    }
    .expect("chain-only runtime");
    crate::handles::insert(Arc::clone(&runtime)).expect("instance registry");
    runtime
}

unsafe extern "C" fn chain_query_event(
    context: *mut std::ffi::c_void,
    event: *const crate::abi::CitizenSdkEvent,
) {
    // 测试持有 channel 到 dispatcher 关闭；只复制公开完成事件，不借用事件指针。
    let sender =
        unsafe { &*context.cast::<std::sync::mpsc::Sender<crate::abi::CitizenSdkEvent>>() };
    let event = unsafe { *event };
    if event.event_type == crate::abi::CitizenSdkEventType::RequestCompleted as u32 {
        let _ = sender.send(event);
    }
}

#[test]
fn chain_query_inputs_and_static_genesis_are_validated_without_starting_provider() {
    use crate::abi::CitizenSdkAccountId;
    let runtime = chain_query_runtime();
    let handle = runtime.handle();
    let mut genesis = [0xa5; 33];
    let mut request = 999;
    let account = CitizenSdkAccountId { bytes: [0x55; 32] };
    unsafe {
        assert_eq!(
            super::citizensdk_get_genesis_hash(handle, genesis.as_mut_ptr()),
            0
        );
        assert_eq!(
            &genesis[..32],
            citizen_sdk_contracts::ChainIdentity::citizenchain()
                .genesis_hash()
                .as_bytes()
        );
        assert_eq!(genesis[32], 0xa5);
        assert_eq!(
            super::citizensdk_get_genesis_hash(handle, std::ptr::null_mut()),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(
            super::citizensdk_get_genesis_hash(0, genesis.as_mut_ptr()),
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
        for count in [1991, u32::MAX] {
            assert_eq!(
                super::citizensdk_get_finalized_account_balances(
                    handle,
                    &account,
                    count,
                    &mut request
                ),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(request, 999);
        }
        assert_eq!(
            super::citizensdk_get_finalized_account_balances(
                handle,
                std::ptr::null(),
                1,
                &mut request
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(
            super::citizensdk_get_finalized_account_balances(
                handle,
                std::ptr::null(),
                0,
                std::ptr::null_mut()
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(
            super::citizensdk_get_finalized_account_balances(0, std::ptr::null(), 0, &mut request),
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
        assert_eq!(crate::citizensdk_destroy(handle), 0);
        assert_eq!(
            super::citizensdk_get_genesis_hash(handle, genesis.as_mut_ptr()),
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
        assert_eq!(
            super::citizensdk_get_finalized_account_balances(
                handle,
                std::ptr::null(),
                0,
                &mut request
            ),
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
    }
}

#[test]
fn empty_batch_is_accepted_but_cannot_bypass_engine_running_gate() {
    let runtime = chain_query_runtime();
    let (sender, receiver) = std::sync::mpsc::channel::<crate::abi::CitizenSdkEvent>();
    let mut sender = Box::new(sender);
    runtime
        .set_event_callback(
            Some(chain_query_event),
            (&mut *sender as *mut std::sync::mpsc::Sender<crate::abi::CitizenSdkEvent>).cast(),
        )
        .expect("callback");
    let mut request = 0;
    unsafe {
        assert_eq!(
            super::citizensdk_get_finalized_account_balances(
                runtime.handle(),
                std::ptr::null(),
                0,
                &mut request
            ),
            0
        );
    }
    let event = receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("query completion");
    assert_eq!(event.request_id, request);
    let result = crate::ownership::get(event.result).expect("query result");
    assert_eq!(result.code, CitizenSdkErrorCode::NotReady);
    assert!(matches!(
        result.payload,
        crate::ownership::ResultPayload::Empty
    ));
    unsafe {
        assert_eq!(
            crate::citizensdk_destroy(runtime.handle()),
            CitizenSdkErrorCode::Busy.as_i32()
        );
        assert_eq!(crate::citizensdk_result_release(event.result), 0);
        assert_eq!(crate::citizensdk_destroy(runtime.handle()), 0);
    }
}

#[test]
fn finite_batch_admission_rejects_cancel_and_close_until_request_and_result_drain() {
    let runtime = chain_query_runtime();
    let (sender, receiver) = std::sync::mpsc::channel::<crate::abi::CitizenSdkEvent>();
    let mut sender = Box::new(sender);
    runtime
        .set_event_callback(
            Some(chain_query_event),
            (&mut *sender as *mut std::sync::mpsc::Sender<crate::abi::CitizenSdkEvent>).cast(),
        )
        .expect("callback");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let mut request = 0;
    // 与公开批量入口共用唯一 finite admission；barrier 让取消/销毁断言不依赖竞速。
    unsafe {
        super::accept_and_write(
            Arc::clone(&runtime),
            &mut request,
            move |_, _, cancellation| {
                assert!(cancellation.is_none());
                entered_tx.send(()).expect("entered");
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .expect("release");
                Ok(crate::ownership::ResultPayload::AccountBalances(Vec::new()))
            },
        )
        .expect("finite acceptance");
    }
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("pending batch");
    unsafe {
        assert_eq!(
            crate::citizensdk_cancel_request(runtime.handle(), request),
            CitizenSdkErrorCode::Unsupported.as_i32()
        );
        assert_eq!(
            crate::citizensdk_destroy(runtime.handle()),
            CitizenSdkErrorCode::Busy.as_i32()
        );
    }
    release_tx.send(()).expect("release pending batch");
    let event = receiver
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("batch completion");
    assert_eq!(event.request_id, request);
    let mut count = u32::MAX;
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_account_balance_count(event.result, &mut count),
            0
        );
        assert_eq!(count, 0);
        assert_eq!(
            crate::citizensdk_destroy(runtime.handle()),
            CitizenSdkErrorCode::Busy.as_i32()
        );
        assert_eq!(crate::citizensdk_result_release(event.result), 0);
        assert_eq!(crate::citizensdk_destroy(runtime.handle()), 0);
    }
    assert!(
        receiver.try_recv().is_err(),
        "finite batch completes exactly once"
    );
}

#[test]
fn batch_result_projection_preserves_order_u128_and_checks_type_size_bounds_and_release() {
    use crate::{
        abi::CitizenSdkAccountBalanceInfo,
        ownership::{self, OwnedResult, ResultPayload},
    };
    use citizen_sdk_contracts::{
        AccountId32, ChainIdentity, FinalizedAccountBalance, FinalizedBlockRef,
    };
    let block = FinalizedBlockRef::from_parts(Hash32::from_bytes([0xaa; 32]), 77);
    let first = FinalizedAccountBalance::try_new(
        &ChainIdentity::citizenchain(),
        block,
        AccountId32::from_bytes([0x55; 32]),
        u128::MAX,
        0,
    )
    .expect("first balance");
    let second = FinalizedAccountBalance::try_new(
        &ChainIdentity::citizenchain(),
        block,
        AccountId32::from_bytes([0x44; 32]),
        7,
        9,
    )
    .expect("second balance");
    let result = ownership::insert(OwnedResult::success(
        0,
        ResultPayload::AccountBalances(vec![first, second, first]),
    ))
    .expect("batch result");
    let wrong = ownership::insert(OwnedResult::success(
        0,
        ResultPayload::AccountBalance(first),
    ))
    .expect("single result");
    let mut count = 999;
    let mut info = CitizenSdkAccountBalanceInfo::default();
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_account_balance_count(result, &mut count),
            0
        );
        assert_eq!(count, 3);
        assert_eq!(
            super::citizensdk_result_get_account_balance_count(result, std::ptr::null_mut()),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        for (index, balance) in [first, second, first].into_iter().enumerate() {
            assert_eq!(
                super::citizensdk_result_get_account_balance_at(result, index as u32, &mut info),
                0
            );
            assert_eq!(info, super::account_balance_to_abi(balance));
        }
        let unchanged = info;
        for index in [3, u32::MAX] {
            assert_eq!(
                super::citizensdk_result_get_account_balance_at(result, index, &mut info),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(info, unchanged);
        }
        assert_eq!(
            super::citizensdk_result_get_account_balance_at(result, 0, std::ptr::null_mut()),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        info.struct_size -= 1;
        let too_short = info;
        assert_eq!(
            super::citizensdk_result_get_account_balance_at(result, 0, &mut info),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(info, too_short);
        info = unchanged;
        info.abi_version += 1;
        assert_eq!(
            super::citizensdk_result_get_account_balance_at(result, 0, &mut info),
            CitizenSdkErrorCode::Unsupported.as_i32()
        );
        info = unchanged;
        count = 999;
        assert_ne!(
            super::citizensdk_result_get_account_balance_count(wrong, &mut count),
            0
        );
        assert_eq!(count, 999);
        assert_ne!(
            super::citizensdk_result_get_account_balance_at(wrong, 0, &mut info),
            0
        );
        assert_eq!(info, unchanged);
        assert_ne!(
            super::citizensdk_result_get_account_balance(result, &mut info),
            0
        );
    }
    ownership::release(wrong).expect("release single");
    ownership::release(result).expect("release batch");
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_account_balance_at(result, 0, &mut info),
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
        assert_eq!(
            super::citizensdk_result_get_account_balance_count(0, &mut count),
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
    }
}

#[test]
fn portable_u128_round_trips_boundary_values() {
    for value in [0, 1, u64::MAX as u128, 1_u128 << 64, u128::MAX] {
        assert_eq!(u128_from_abi(u128_to_abi(value)), value);
    }
    assert_eq!(
        u128_from_abi(CitizenSdkU128 {
            low: 0x0123_4567_89ab_cdef,
            high: 0xfedc_ba98_7654_3210,
        }),
        0xfedc_ba98_7654_3210_0123_4567_89ab_cdef,
    );
}

#[test]
fn wallet_word_count_accepts_only_the_three_supported_values() {
    assert!(wallet_word_count(CitizenSdkWalletWordCount::Words12 as u32).is_ok());
    assert!(wallet_word_count(CitizenSdkWalletWordCount::Words18 as u32).is_ok());
    assert!(wallet_word_count(CitizenSdkWalletWordCount::Words24 as u32).is_ok());
    for invalid in [0, 11, 13, 15, 21, 23, 25, u32::MAX] {
        assert!(wallet_word_count(invalid).is_err());
    }
}

#[test]
fn synchronous_wallet_input_never_needs_a_runtime_or_returns_secrets() {
    fn view(bytes: &[u8]) -> CitizenSdkBytesView {
        CitizenSdkBytesView {
            data: bytes.as_ptr(),
            len: bytes.len() as u64,
        }
    }
    // 安全边界：仅合成输入，缓冲覆盖整个同步调用；无效输入通过原因而非秘密回显。
    unsafe {
        let mut validation = crate::abi::CitizenSdkWalletInputValidationV1::default();
        for accepted in [b"".as_slice(), b"abcdef"] {
            assert_eq!(
                super::citizensdk_validate_wallet_input(1, view(accepted), 0, &mut validation),
                0
            );
            assert_eq!(validation.reason, 0);
        }
        for rejected in [b"short".as_slice(), b"abcdef ", &[0xff]] {
            assert_eq!(
                super::citizensdk_validate_wallet_input(1, view(rejected), 0, &mut validation),
                0
            );
            assert_ne!(validation.reason, 0);
        }
        let mut required = u64::MAX;
        assert_eq!(
            super::citizensdk_wallet_word_suggestions(
                view(b"aban"),
                std::ptr::null_mut(),
                0,
                &mut required
            ),
            0
        );
        assert_eq!(required, 7);
        let mut output = [0xa5; 16];
        assert_eq!(
            super::citizensdk_wallet_word_suggestions(
                view(b"aban"),
                output.as_mut_ptr(),
                6,
                &mut required
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(output, [0xa5; 16]);
        assert_eq!(required, 7);
        assert_eq!(
            super::citizensdk_wallet_word_suggestions(
                view(b"aban"),
                output.as_mut_ptr(),
                16,
                &mut required
            ),
            0
        );
        assert_eq!(&output[..7], b"abandon");
        assert_eq!(output[7], 0xa5);
        assert_ne!(
            super::citizensdk_wallet_word_suggestions(
                view(b"A"),
                output.as_mut_ptr(),
                16,
                &mut required
            ),
            0
        );
        assert_eq!(required, 0);
        assert_ne!(
            super::citizensdk_wallet_word_suggestions(
                view(b"a"),
                output.as_mut_ptr(),
                16,
                std::ptr::null_mut()
            ),
            0
        );
        assert_eq!(
            super::citizensdk_validate_wallet_input(2, view(b""), 18, &mut validation),
            0
        );
        assert_ne!(validation.reason, 0);
        let previous = validation;
        assert_eq!(
            super::citizensdk_validate_wallet_input(2, view(b""), 15, &mut validation),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(validation, previous);
    }
}

#[test]
fn invalid_secret_utf8_is_rejected_before_async_acceptance() {
    let bytes = [0xff, 0xfe];
    let view = CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    };
    // SAFETY: the fixed test array remains readable through the synchronous copy.
    assert!(unsafe { secret_utf8(view, "test secret", bytes.len()) }.is_err());
}

#[test]
fn multi_buffer_copy_validates_every_destination_before_writing_any() {
    let first = b"first";
    let second = b"second";
    let mut first_output = [0xaa; 5];
    let mut second_output = [0xbb; 2];
    let mut first_required = u64::MAX;
    let mut second_required = u64::MAX;
    // SAFETY: all test pointers are valid for their declared capacities. The
    // second capacity is deliberately too small and must fail atomically.
    let result = unsafe {
        copy_pair(
            first,
            first_output.as_mut_ptr(),
            first_output.len() as u64,
            &mut first_required,
            second,
            second_output.as_mut_ptr(),
            second_output.len() as u64,
            &mut second_required,
        )
    };
    assert!(result.is_err());
    assert_eq!(first_output, [0xaa; 5]);
    assert_eq!(second_output, [0xbb; 2]);
    assert_eq!(first_required, u64::MAX);
    assert_eq!(second_required, u64::MAX);
}

#[test]
fn absent_wallet_profile_is_a_successful_zeroed_projection() {
    let info = wallet_profile_to_abi(None)
        .unwrap_or_else(|error| panic!("absent profile projection failed: {error:?}"));
    assert_eq!(info.present, 0);
    assert_eq!(info.origin, 0);
    assert_eq!(info.account_count, 0);
    assert_eq!(info.master_account_id.bytes, [0; 32]);
    assert_eq!(info.active_account_id.bytes, [0; 32]);
}

#[test]
fn diagnostic_projection_and_record_ownership_are_exact_and_atomic() {
    use crate::{
        abi::CitizenSdkWalletDiagnosticInfoV1,
        ownership::{self, OwnedResult, ResultPayload},
    };
    use citizen_sdk_contracts::WalletRecord;
    use std::mem::{offset_of, size_of};

    assert_eq!(size_of::<CitizenSdkWalletDiagnosticInfoV1>(), 80);
    assert_eq!(offset_of!(CitizenSdkWalletDiagnosticInfoV1, account_id), 24);
    assert_eq!(
        offset_of!(CitizenSdkWalletDiagnosticInfoV1, wallet_name_len),
        56
    );
    assert_eq!(
        offset_of!(CitizenSdkWalletDiagnosticInfoV1, ss58_address_len),
        64
    );
    assert_eq!(
        offset_of!(CitizenSdkWalletDiagnosticInfoV1, cleanup_account_count),
        72
    );
    assert_eq!(
        offset_of!(CitizenSdkWalletDiagnosticInfoV1, delete_wallet_wide_key),
        76
    );
    // 公开合成坏模式，不使用真实钱包；空原地址仍有值，不能当作缺失。
    let record = WalletRecord::Account {
        wallet_index: 1,
        sign_mode: "invalid".into(),
        account_id: AccountId32::from_bytes([0x41; 32]),
        ss58_address: String::new(),
        name: "异常钱包".into(),
        created_at_millis: 17,
    };
    let state = WalletState::try_from_catalog_parts(3, None, vec![], vec![], 2, None, None, vec![])
        .unwrap()
        .try_with_diagnostics(vec![record.clone()])
        .unwrap();
    let result = ownership::insert(OwnedResult::success(
        71,
        ResultPayload::WalletState(Box::new(
            citizen_sdk_engine::WalletStateSnapshot::from_state(&state).unwrap(),
        )),
    ))
    .unwrap();
    assert_eq!(super::inspected_record(71, result, 1).unwrap(), (3, record));
    assert_eq!(
        super::inspected_record(72, result, 1).unwrap_err().code,
        CitizenSdkErrorCode::InvalidArgument
    );
    assert_eq!(
        super::inspected_record(71, result, 0).unwrap_err().code,
        CitizenSdkErrorCode::NotFound
    );
    let mut count = 99;
    let mut info = CitizenSdkWalletDiagnosticInfoV1::default();
    let mut required = 99;
    let mut bytes = [0xa5; 32];
    unsafe {
        assert_eq!(
            super::citizensdk_wallet_state_get_diagnostic_count(result, &mut count),
            0
        );
        assert_eq!(count, 1);
        assert_eq!(
            super::citizensdk_wallet_state_get_diagnostic_at(result, 0, &mut info),
            0
        );
        assert_eq!(
            (
                info.wallet_index,
                info.diagnostic_reason,
                info.has_ss58_address,
                info.ss58_address_len
            ),
            (1, 1, 1, 0)
        );
        assert_eq!(info.account_id.bytes, [0x41; 32]);
        assert_eq!(
            (
                info.sign_mode,
                info.cleanup_account_count,
                info.delete_wallet_wide_key
            ),
            (0, 1, 0)
        );
        let mut cleanup = crate::abi::CitizenSdkAccountId { bytes: [0xa5; 32] };
        assert_ne!(
            super::citizensdk_wallet_state_get_diagnostic_cleanup_account(
                result,
                0,
                1,
                &mut cleanup
            ),
            0
        );
        assert_eq!(cleanup.bytes, [0xa5; 32]);
        assert_ne!(
            super::citizensdk_wallet_state_get_diagnostic_cleanup_account(
                result,
                1,
                0,
                &mut cleanup
            ),
            0
        );
        assert_eq!(cleanup.bytes, [0xa5; 32]);
        assert_eq!(
            super::citizensdk_wallet_state_get_diagnostic_cleanup_account(
                result,
                0,
                0,
                &mut cleanup
            ),
            0
        );
        assert_eq!(cleanup.bytes, [0x41; 32]);
        let before = info;
        assert_ne!(
            super::citizensdk_wallet_state_get_diagnostic_at(result, 1, &mut info),
            0
        );
        assert_eq!(info, before);
        assert_ne!(
            super::citizensdk_wallet_state_copy_diagnostic_text(
                result,
                0,
                1,
                bytes.as_mut_ptr(),
                1,
                &mut required
            ),
            0
        );
        assert_eq!((bytes, required), ([0xa5; 32], 99));
        for field in [0, 3, u32::MAX] {
            assert_ne!(
                super::citizensdk_wallet_state_copy_diagnostic_text(
                    result,
                    0,
                    field,
                    bytes.as_mut_ptr(),
                    32,
                    &mut required
                ),
                0
            );
            assert_eq!((bytes, required), ([0xa5; 32], 99));
        }
        assert_eq!(
            super::citizensdk_wallet_state_copy_diagnostic_text(
                result,
                0,
                1,
                bytes.as_mut_ptr(),
                32,
                &mut required
            ),
            0
        );
        assert_eq!(&bytes[..required as usize], "异常钱包".as_bytes());
        assert_eq!(
            super::citizensdk_wallet_state_copy_diagnostic_text(
                result,
                0,
                2,
                std::ptr::null_mut(),
                0,
                &mut required
            ),
            0
        );
        assert_eq!(required, 0);
        info.struct_size = 8;
        let invalid = info;
        assert_ne!(
            super::citizensdk_wallet_state_get_diagnostic_at(result, 0, &mut info),
            0
        );
        assert_eq!(info, invalid);
        assert_ne!(
            super::citizensdk_wallet_state_get_diagnostic_count(result, std::ptr::null_mut()),
            0
        );
    }
    ownership::release(result).unwrap();
    assert!(super::inspected_record(71, result, 1).is_err());
    count = 99;
    assert_ne!(
        unsafe { super::citizensdk_wallet_state_get_diagnostic_count(result, &mut count) },
        0
    );
    assert_eq!(count, 99);
    for wrong in [
        OwnedResult::success(71, ResultPayload::Empty),
        OwnedResult::failure(71, crate::error::FfiError::invalid("合成失败")),
    ] {
        let result = ownership::insert(wrong).unwrap();
        assert!(super::inspected_record(71, result, 1).is_err());
        assert_ne!(
            unsafe { super::citizensdk_wallet_state_get_diagnostic_count(result, &mut count) },
            0
        );
        assert_eq!(count, 99);
        ownership::release(result).unwrap();
    }
}

#[test]
fn wallet_state_projection_is_globally_ordered_and_multi_buffer_copy_is_atomic() {
    use crate::ownership::{self, OwnedResult, ResultPayload};

    let account_id = AccountId32::from_bytes([0xc1; 32]);
    let ss58 = citizen_ss58_address(account_id);
    let cold =
        ColdWalletAccount::try_new(1, account_id, ss58.clone(), "离线签名", 17).expect("冷账户");
    let state = WalletState::try_from_catalog_parts(
        3,
        None,
        vec![cold],
        vec![account_id],
        2,
        None,
        None,
        Vec::new(),
    )
    .expect("统一钱包状态");
    let result = ownership::insert(OwnedResult::success(
        0,
        ResultPayload::WalletState(Box::new(
            citizen_sdk_engine::WalletStateSnapshot::from_state(&state).unwrap(),
        )),
    ))
    .expect("钱包状态 result");

    let mut state_info = CitizenSdkWalletStateInfo::default();
    let mut account_info = CitizenSdkWalletStateAccountInfo::default();
    let mut ss58_required = 0;
    let mut name_required = 0;
    unsafe {
        assert_eq!(
            super::citizensdk_result_get_wallet_state(result, &mut state_info),
            0
        );
        assert_eq!(state_info.revision, 3);
        assert_eq!(state_info.account_count, 1);
        assert_eq!(state_info.has_default_account, 1);
        assert_eq!(state_info.default_account_id.bytes, *account_id.as_bytes());
        let mut initialization = 99;
        let mut cleanup = 99;
        assert_eq!(
            super::citizensdk_wallet_state_get_initialization(
                result,
                &mut initialization,
                &mut cleanup
            ),
            0
        );
        assert_eq!((initialization, cleanup), (1, 0));
        assert_eq!(
            super::citizensdk_wallet_state_get_initialization(
                result,
                &mut initialization,
                std::ptr::null_mut()
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(initialization, 1);

        assert_eq!(
            super::citizensdk_result_get_wallet_state_account(
                result,
                0,
                &mut account_info,
                std::ptr::null_mut(),
                0,
                &mut ss58_required,
                std::ptr::null_mut(),
                0,
                &mut name_required,
            ),
            0
        );
        assert_eq!(
            account_info.sign_mode,
            CitizenSdkWalletSignMode::Cold as u32
        );
        assert_eq!(account_info.wallet_index, 1);
        assert_eq!(account_info.has_account_index, 0);
        assert_eq!(account_info.is_default, 1);
        assert_eq!(ss58_required, ss58.len() as u64);
        assert_eq!(name_required, "离线签名".len() as u64);

        let unchanged = account_info;
        let mut ss58_output = vec![0xaa; ss58.len()];
        let mut short_name = [0xbb; 1];
        ss58_required = u64::MAX;
        name_required = u64::MAX;
        assert_eq!(
            super::citizensdk_result_get_wallet_state_account(
                result,
                0,
                &mut account_info,
                ss58_output.as_mut_ptr(),
                ss58_output.len() as u64,
                &mut ss58_required,
                short_name.as_mut_ptr(),
                short_name.len() as u64,
                &mut name_required,
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(account_info, unchanged);
        assert!(ss58_output.iter().all(|byte| *byte == 0xaa));
        assert_eq!(short_name, [0xbb]);
        assert_eq!(ss58_required, u64::MAX);
        assert_eq!(name_required, u64::MAX);

        assert_eq!(
            super::citizensdk_result_get_wallet_state_account(
                result,
                1,
                &mut account_info,
                std::ptr::null_mut(),
                0,
                &mut ss58_required,
                std::ptr::null_mut(),
                0,
                &mut name_required,
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(account_info, unchanged);
    }
    ownership::release(result).expect("release wallet state result");
}

#[test]
fn prepared_wallet_handles_are_nonzero_monotonic_and_never_reused() {
    let first = next_prepared_wallet_handle()
        .unwrap_or_else(|error| panic!("first prepared handle failed: {error:?}"));
    let second = next_prepared_wallet_handle()
        .unwrap_or_else(|error| panic!("second prepared handle failed: {error:?}"));
    assert_ne!(first, 0);
    assert_eq!(second, first + 1);
}

#[test]
fn prepared_wallet_owner_is_checked_even_while_the_handle_is_claimed() {
    let handle = next_prepared_wallet_handle()
        .unwrap_or_else(|error| panic!("prepared handle failed: {error:?}"));
    lock_prepared_wallets()
        .unwrap_or_else(|error| panic!("prepared registry failed: {error:?}"))
        .insert(handle, PreparedWalletSlot::Claimed { owner: 7001 });

    let error = claim_prepared_wallet(handle, 7002)
        .err()
        .unwrap_or_else(|| panic!("cross-instance claim must fail"));
    assert_eq!(error.code, CitizenSdkErrorCode::InvalidHandle);
    assert_eq!(
        require_prepared_owner(7001, 7002)
            .err()
            .unwrap_or_else(|| panic!("cross-instance owner check must fail"))
            .code,
        CitizenSdkErrorCode::InvalidHandle,
    );

    lock_prepared_wallets()
        .unwrap_or_else(|error| panic!("prepared registry cleanup failed: {error:?}"))
        .remove(&handle);
}

#[test]
fn wallet_metadata_result_projection_is_atomic_and_rejects_wrong_or_released_handles() {
    use crate::ownership::{self, OwnedResult, ResultPayload};
    use citizen_sdk_contracts::{
        SecretOwner, SecretRef, VaultGeneration, WalletAccount, WalletOrigin, WalletProfile,
    };
    let account_id = AccountId32::from_bytes([0xe7; 32]);
    let generation = VaultGeneration::from_bytes([1; 16]);
    let reference =
        SecretRef::account_mini_secret(0, generation, SecretOwner::from_bytes([2; 16]), account_id);
    let account = WalletAccount::try_new(
        0,
        account_id,
        reference,
        citizen_ss58_address(account_id),
        "账户",
        1,
    )
    .unwrap();
    let profile = WalletProfile::try_new(
        0,
        generation,
        account_id,
        WalletOrigin::Created,
        1,
        account_id,
        vec![account],
    )
    .and_then(|profile| profile.try_with_wallet_name("钱包级名称"))
    .unwrap();
    let state = WalletState::try_from_parts(9, Some(profile.clone()), None, None, Vec::new())
        .and_then(|state| state.try_with_active_wallet(Some(0)))
        .unwrap();
    let result = ownership::insert(OwnedResult::success(
        0,
        ResultPayload::WalletState(Box::new(
            citizen_sdk_engine::WalletStateSnapshot::from_state(&state).unwrap(),
        )),
    ))
    .unwrap();
    let hot = ownership::insert(OwnedResult::success(
        0,
        ResultPayload::WalletProfile(Some(profile)),
    ))
    .unwrap();
    let empty =
        ownership::insert(OwnedResult::success(0, ResultPayload::WalletProfile(None))).unwrap();
    unsafe {
        let mut present = 9;
        let mut index = 99;
        assert_eq!(
            super::citizensdk_wallet_state_get_active_wallet(result, &mut present, &mut index),
            0
        );
        assert_eq!((present, index), (1, 0), "零号热钱包不是缺省空值");
        present = 9;
        assert_eq!(
            super::citizensdk_wallet_state_get_active_wallet(
                result,
                &mut present,
                std::ptr::null_mut()
            ),
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(present, 9);
        assert_ne!(
            super::citizensdk_wallet_state_get_active_wallet(hot, &mut present, &mut index),
            0
        );
        assert_eq!(present, 9);
        for handle in [result, hot] {
            let mut required = 99;
            assert_eq!(
                super::citizensdk_wallet_profile_copy_name(
                    handle,
                    std::ptr::null_mut(),
                    0,
                    &mut required
                ),
                0
            );
            assert_eq!(required, "钱包级名称".len() as u64);
            let mut bytes = vec![0xa5; required as usize];
            let capacity = bytes.len() as u64;
            required = 99;
            assert_eq!(
                super::citizensdk_wallet_profile_copy_name(
                    handle,
                    bytes.as_mut_ptr(),
                    capacity - 1,
                    &mut required
                ),
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(required, 99);
            assert!(bytes.iter().all(|byte| *byte == 0xa5));
            assert_eq!(
                super::citizensdk_wallet_profile_copy_name(
                    handle,
                    bytes.as_mut_ptr(),
                    capacity,
                    &mut required
                ),
                0
            );
            assert_eq!(bytes, "钱包级名称".as_bytes());
        }
        let mut required = 99;
        assert_eq!(
            super::citizensdk_wallet_profile_copy_name(
                empty,
                std::ptr::null_mut(),
                0,
                &mut required
            ),
            0
        );
        assert_eq!(required, 0);
        // 合成投影结果未登记runtime；沿同一内部拥有者归还，不伪造公开异步请求。
        ownership::release(result).unwrap();
        assert!(ownership::release(result).is_err());
        assert_ne!(
            super::citizensdk_wallet_state_get_active_wallet(result, &mut present, &mut index),
            0
        );
        assert_eq!(present, 9);
        ownership::release(hot).unwrap();
        ownership::release(empty).unwrap();
    }
}

#[test]
fn add_cancellation_drains_operation_and_preserves_already_committed_success() {
    futures_executor::block_on(async {
        use std::sync::atomic::{AtomicBool, Ordering};
        let flag = Arc::new(AtomicBool::new(false));
        let (cancel, cancellation) = futures_channel::oneshot::channel();
        cancel.send(()).unwrap();
        let observed = flag.clone();
        let operation = async move {
            assert!(observed.load(Ordering::Acquire));
            // 模拟已经在持久提交边界内完成：必须排空并返回实际成功。
            Ok::<_, citizen_sdk_engine::EngineError>(7)
        };
        assert_eq!(
            super::add_accounts_or_cancellation(operation, Some(cancellation), flag)
                .await
                .unwrap(),
            7
        );
    });
}
