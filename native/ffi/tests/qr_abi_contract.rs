// Black-box public ABI regression; only existing public-vector signatures are used.
#![allow(unsafe_code)]

use citizensdk::{
    citizensdk_qr_parse, citizensdk_result_copy_qr, citizensdk_review_qr_sign_request,
    citizensdk_sign_qr_request, CitizenSdkBytesView, CitizenSdkErrorCode,
};

fn view(bytes: &[u8]) -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    }
}

#[cfg(feature = "qr")]
mod enabled {
    use super::*;
    use citizen_sdk_contracts::Sr25519Signature;
    use citizen_sdk_qr::{parse, QrCode, SignRequest, SignResponse};
    use citizensdk::{
        citizensdk_create_with_modules, citizensdk_destroy, citizensdk_qr_consume_sign_response,
        citizensdk_qr_validate_sign_response,
        citizensdk_qr_create_sign_request, citizensdk_qr_encode_account_id, CitizenSdkAccountId,
        CitizenSdkCreateOptions, CITIZENSDK_ABI_VERSION,
    };

    fn instance() -> u64 {
        let options = CitizenSdkCreateOptions {
            struct_size: std::mem::size_of::<CitizenSdkCreateOptions>() as u32,
            abi_version: CITIZENSDK_ABI_VERSION,
            asset_manifest: view(&[]),
            chain_spec: view(&[]),
            light_sync_state: view(&[]),
            system_name: view(&[]),
            system_version: view(&[]),
        };
        let mut handle = 0;
        assert_eq!(
            unsafe {
                citizensdk_create_with_modules(
                    &options,
                    std::ptr::null(),
                    citizen_sdk_contracts::Modules::QR,
                    &mut handle,
                )
            },
            CitizenSdkErrorCode::Ok.as_i32()
        );
        handle
    }

    unsafe fn copy_text(mut call: impl FnMut(*mut u8, u64, *mut u64) -> i32) -> Vec<u8> {
        let mut required = 0;
        assert_eq!(
            call(std::ptr::null_mut(), 0, &mut required),
            CitizenSdkErrorCode::Ok.as_i32()
        );
        assert!((1..=65_536).contains(&required));
        let mut output = vec![0; required as usize];
        assert_eq!(
            call(output.as_mut_ptr(), output.len() as u64, &mut required),
            CitizenSdkErrorCode::Ok.as_i32()
        );
        assert_eq!(required as usize, output.len());
        output
    }

    fn create(handle: u64, account: &CitizenSdkAccountId, payload: &[u8]) -> SignRequest {
        let text = unsafe {
            copy_text(|out, cap, len| {
                citizensdk_qr_create_sign_request(
                    handle,
                    0x0400,
                    account,
                    view(payload),
                    300,
                    out,
                    cap,
                    len,
                )
            })
        };
        let QrCode::SignRequest(request) = parse(std::str::from_utf8(&text).unwrap()).unwrap()
        else {
            panic!("request expected")
        };
        request
    }

    fn bytes(text: &str) -> Vec<u8> {
        text.trim()
            .trim_start_matches("0x")
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    #[test]
    fn qr_only_parses_one_normalized_model_without_chain_wallet_or_vault() {
        let handle = instance();
        let account = CitizenSdkAccountId { bytes: [7; 32] };
        let encoded = unsafe {
            copy_text(|out, cap, len| {
                citizensdk_qr_encode_account_id(handle, &account, out, cap, len)
            })
        };
        let json = unsafe {
            copy_text(|out, cap, len| citizensdk_qr_parse(handle, view(&encoded), out, cap, len))
        };
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(value["kind"], 5);
        assert_eq!(
            value["canonical_text"],
            std::str::from_utf8(&encoded).unwrap()
        );
        assert_eq!(value["account_id"], format!("0x{}", "07".repeat(32)));
        let request = create(handle, &account, &[4, 0, 3]);
        let encoded = request.encode().unwrap();
        let json = unsafe {
            copy_text(|out, cap, len| {
                citizensdk_qr_parse(handle, view(encoded.as_bytes()), out, cap, len)
            })
        };
        let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(value["kind"], 1);
        assert_eq!(value["review_payload"], "0x040003");
        assert_eq!(value["signer_account_id"], format!("0x{}", "07".repeat(32)));
        let mut id = 123;
        assert_eq!(
            unsafe { citizensdk_review_qr_sign_request(handle, view(encoded.as_bytes()), &mut id) },
            CitizenSdkErrorCode::Unsupported.as_i32()
        );
        assert_eq!(
            unsafe { citizensdk_sign_qr_request(handle, 0, &mut id) },
            CitizenSdkErrorCode::Unsupported.as_i32()
        );
        assert_eq!(id, 123);
        assert_eq!(
            unsafe { citizensdk_destroy(handle) },
            CitizenSdkErrorCode::Ok.as_i32()
        );
        assert_eq!(
            unsafe {
                citizensdk_qr_parse(
                    handle,
                    view(encoded.as_bytes()),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                )
            },
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
    }

    #[test]
    fn qr_consume_verifies_binding_and_returns_signature_exactly_once() {
        let handle = instance();
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/transaction/citizenchain-transfer-build-v1.json"
        ))
        .unwrap();
        let account = CitizenSdkAccountId {
            bytes: bytes(vector["transfer"]["source_account_id"].as_str().unwrap())
                .try_into()
                .unwrap(),
        };
        let request = create(
            handle,
            &account,
            &bytes(vector["expected"]["signing_message"].as_str().unwrap()),
        );
        let signature: [u8; 64] = bytes(
            vector["public_test_signature"]["signature"]
                .as_str()
                .unwrap(),
        )
        .try_into()
        .unwrap();
        let response = SignResponse {
                current_account: None,
            request_id: request.request_id.clone(),
            expires_at: request.expires_at,
            signer_public_key: request.require_signer().unwrap(),
            signature: Sr25519Signature::from_bytes(signature),
        };
        let mut output = [0xa5; 64];
        let mut invalid = response.clone();
        invalid.signature = Sr25519Signature::from_bytes([0; 64]);
        let encoded = invalid.encode().unwrap();
        assert_eq!(
            unsafe {
                citizensdk_qr_consume_sign_response(
                    handle,
                    view(encoded.as_bytes()),
                    output.as_mut_ptr(),
                )
            },
            CitizenSdkErrorCode::Integrity.as_i32()
        );
        assert_eq!(output, [0xa5; 64]);
        let mut wrong_account = response.clone();
        wrong_account.signer_public_key =
            citizen_sdk_contracts::Sr25519PublicKey::from_bytes([9; 32]);
        let encoded = wrong_account.encode().unwrap();
        assert_eq!(
            unsafe {
                citizensdk_qr_consume_sign_response(
                    handle,
                    view(encoded.as_bytes()),
                    output.as_mut_ptr(),
                )
            },
            CitizenSdkErrorCode::Conflict.as_i32()
        );
        let encoded = response.encode().unwrap();
        // 真实公开签名向量：多次预检不消费；错误实例/请求/签名不能放行。
        let another = instance();
        let session = view(response.request_id.as_bytes());
        for _ in 0..2 {
            assert_eq!(unsafe { citizensdk_qr_validate_sign_response(handle, session, view(encoded.as_bytes())) }, 0);
        }
        assert_eq!(unsafe { citizensdk_qr_validate_sign_response(another, session, view(encoded.as_bytes())) }, CitizenSdkErrorCode::Conflict.as_i32());
        assert_eq!(unsafe { citizensdk_qr_validate_sign_response(handle, view(b"wrong-request"), view(encoded.as_bytes())) }, CitizenSdkErrorCode::Conflict.as_i32());
        let invalid_text = invalid.encode().unwrap();
        assert_eq!(unsafe { citizensdk_qr_validate_sign_response(handle, session, view(invalid_text.as_bytes())) }, CitizenSdkErrorCode::Integrity.as_i32());
        assert_eq!(unsafe { citizensdk_destroy(another) }, 0);
        assert_eq!(
            unsafe {
                citizensdk_qr_consume_sign_response(
                    handle,
                    view(encoded.as_bytes()),
                    std::ptr::null_mut(),
                )
            },
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert_eq!(
            unsafe {
                citizensdk_qr_consume_sign_response(
                    handle,
                    view(encoded.as_bytes()),
                    output.as_mut_ptr(),
                )
            },
            CitizenSdkErrorCode::Ok.as_i32()
        );
        assert_eq!(output, signature);
        assert_eq!(unsafe { citizensdk_qr_validate_sign_response(handle, session, view(encoded.as_bytes())) }, CitizenSdkErrorCode::Conflict.as_i32());
        output.fill(0xa5);
        assert_eq!(
            unsafe {
                citizensdk_qr_consume_sign_response(
                    handle,
                    view(encoded.as_bytes()),
                    output.as_mut_ptr(),
                )
            },
            CitizenSdkErrorCode::Conflict.as_i32()
        );
        assert_eq!(output, [0xa5; 64]);
        assert_eq!(
            unsafe { citizensdk_destroy(handle) },
            CitizenSdkErrorCode::Ok.as_i32()
        );
    }

    #[test]
    fn parser_rejects_expiry_utf8_overflow_and_short_output_without_write() {
        let handle = instance();
        let account = CitizenSdkAccountId { bytes: [7; 32] };
        let mut request = create(handle, &account, &[4, 0, 3]);
        request.expires_at = 1;
        let text = request.encode().unwrap();
        let mut required = 99;
        let mut output = [0xa5; 2];
        assert_eq!(
            unsafe {
                citizensdk_qr_parse(
                    handle,
                    view(text.as_bytes()),
                    output.as_mut_ptr(),
                    2,
                    &mut required,
                )
            },
            CitizenSdkErrorCode::Timeout.as_i32()
        );
        assert_eq!(
            unsafe {
                citizensdk_qr_parse(handle, view(&[0xff]), output.as_mut_ptr(), 2, &mut required)
            },
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        let oversized = CitizenSdkBytesView {
            data: std::ptr::null(),
            len: u64::MAX,
        };
        assert_eq!(
            unsafe {
                citizensdk_qr_parse(handle, oversized, output.as_mut_ptr(), 2, &mut required)
            },
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        let encoded = unsafe {
            copy_text(|out, cap, len| {
                citizensdk_qr_encode_account_id(handle, &account, out, cap, len)
            })
        };
        assert_eq!(
            unsafe {
                citizensdk_qr_parse(
                    handle,
                    view(&encoded),
                    output.as_mut_ptr(),
                    2,
                    &mut required,
                )
            },
            CitizenSdkErrorCode::InvalidArgument.as_i32()
        );
        assert!(required > 2);
        assert_eq!(output, [0xa5; 2]);
        assert_eq!(
            unsafe { citizensdk_result_copy_qr(0, std::ptr::null_mut(), 0, &mut required) },
            CitizenSdkErrorCode::InvalidHandle.as_i32()
        );
        assert_eq!(
            unsafe { citizensdk_destroy(handle) },
            CitizenSdkErrorCode::Ok.as_i32()
        );
    }
}

#[cfg(not(feature = "qr"))]
#[test]
fn disabled_qr_keeps_public_symbols_and_does_not_touch_outputs() {
    let mut required = 99;
    let mut request = 77;
    let bad = CitizenSdkBytesView {
        data: std::ptr::null(),
        len: u64::MAX,
    };
    assert_eq!(
        unsafe { citizensdk_qr_parse(0, bad, std::ptr::null_mut(), 0, &mut required) },
        CitizenSdkErrorCode::Unsupported.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_review_qr_sign_request(0, view(&[]), &mut request) },
        CitizenSdkErrorCode::Unsupported.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_sign_qr_request(0, 0, &mut request) },
        CitizenSdkErrorCode::Unsupported.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_result_copy_qr(0, std::ptr::null_mut(), 0, &mut required) },
        CitizenSdkErrorCode::Unsupported.as_i32()
    );
    assert_eq!(required, 99);
    assert_eq!(request, 77);
}
