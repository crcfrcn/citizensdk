use super::*;
// 只有纯协议测试可注入时间；生产入口始终读取 SDK 时钟。
use super::parse_at as parse;

// 原App解析器移除后的协议回归仍运行真实SDK解析器，不能用页面fake代替。
#[test]
fn original_app_router_rejection_vectors_remain_closed_in_core() {
    let account = hex(&[7; 32]);
    let contact = serde_json::json!({"p":"QR_V1","k":3,"b":{"c":"CID-7","n":account}});
    assert!(parse(&contact.to_string(), 99).is_ok());
    for bad in [
        serde_json::json!("5"),
        serde_json::json!(" 5"),
        serde_json::json!("+5"),
        serde_json::json!("0x5"),
        serde_json::json!(5.0),
        serde_json::json!(true),
    ] {
        let mut value = contact.clone();
        value["k"] = bad;
        assert!(parse(&value.to_string(), 99).is_err());
    }
    for extra in ["display_name", "x", "ss58_address"] {
        let mut value = contact.clone();
        value["b"][extra] = "not-authoritative".into();
        assert!(parse(&value.to_string(), 99).is_err());
    }
    let legacy = serde_json::json!({"p":"QR_V1","k":3,"b":{
            "cid_number":"CID-7","ss58_address":"old-format","display_name":"name"}});
    assert!(parse(&legacy.to_string(), 99).is_err());
    for cid in ["\u{200b}CID-7", "\u{200b}\u{200b}"] {
        let mut value = contact.clone();
        value["b"]["c"] = cid.into();
        assert!(parse(&value.to_string(), 99).is_err());
    }
    for bad in [
        account.to_uppercase(),
        account[2..].to_owned(),
        "0x8eaf".into(),
    ] {
        let value = serde_json::json!({"p":"QR_V1","k":5,"b":{"n":bad}});
        assert!(parse(&value.to_string(), 99).is_err());
    }
    let request = serde_json::json!({"p":"QR_V1","k":1,"i":"request-identifier","e":100,
            "b":{"a":1024,"g":1,"u":URL_SAFE_NO_PAD.encode([7;32]),"d":"AQID"}});
    assert!(parse(&request.to_string(), 99).is_ok());
    for bad in ["++++", "AA==", "A/A"] {
        let mut value = request.clone();
        value["b"]["u"] = bad.into();
        assert!(parse(&value.to_string(), 99).is_err());
    }
    let mut extra = request;
    extra["b"]["display"] = "fake-ui".into();
    assert!(parse(&extra.to_string(), 99).is_err());
    let incomplete = serde_json::json!({"p":"QR_V1","k":2,"i":"request-identifier","e":100,
            "b":{"u":URL_SAFE_NO_PAD.encode([7;32]),"s":URL_SAFE_NO_PAD.encode([0;64]),"o":URL_SAFE_NO_PAD.encode([8;32])}});
    assert!(parse(&incomplete.to_string(), 99).is_err());
    for raw in [
        "",
        "hello world",
        "gmb://account/removed",
        "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        r#"{"p":"UNKNOWN_PROTO","foo":"bar"}"#,
    ] {
        assert!(parse(raw, 99).is_err());
    }
}

#[test]
fn document_encoding_preserves_original_fields_and_explicit_deadline() {
    let contact =
        serde_json::json!({"kind": 3, "cid_number": "CID-7", "account_id": hex(&[7; 32])});
    let document = encode_document(&contact.to_string()).unwrap();
    let raw: Value = serde_json::from_str(document["canonical_text"].as_str().unwrap()).unwrap();
    assert_eq!(
        raw,
        serde_json::json!({"p":"QR_V1","k":3,"b":{"c":"CID-7","n":hex(&[7;32])}})
    );
    let request = serde_json::json!({"kind":1,"request_id":null,"request_id_prefix":"data-key-",
            "expires_at":"100","action":10,"signer_account_id":null,"review_payload":"0x0102"});
    let document = encode_document(&request.to_string()).unwrap();
    assert_eq!(document["expires_at"], 100);
    assert!(document["request_id"]
        .as_str()
        .unwrap()
        .starts_with("data-key-"));
    assert!(document["signer_account_id"].is_null());
    let parsed = parse(document["canonical_text"].as_str().unwrap(), 99).unwrap();
    let QrCode::SignRequest(parsed) = parsed else {
        panic!("request kind")
    };
    assert!(parsed.require_signer().is_err());
    assert_eq!(parsed.signer_public_key, None);
    let mut invalid = request.clone();
    invalid["action"] = 12.into();
    assert!(encode_document(&invalid.to_string()).is_err());
    invalid = request.clone();
    invalid["title"] = "not-ui".into();
    assert!(encode_document(&invalid.to_string()).is_err());
    invalid = request;
    invalid["request_id"] = "0123456789abcdef".into();
    assert!(encode_document(&invalid.to_string()).is_err());
    assert!(encode_document(r#"{"kind":3,"kind":3,"cid_number":"C","account_id":"bad"}"#).is_err());
    assert!(
        encode_document(&serde_json::json!({"kind":5,"account_id":hex(&[7;32])}).to_string())
            .is_err()
    );
}

#[test]
fn rebind_response_round_trips_paired_current_account_proof() {
    let response = SignResponse {
        request_id: "0123456789abcdef".into(),
        expires_at: 100,
        signer_public_key: Sr25519PublicKey::from_bytes([7; 32]),
        signature: Sr25519Signature::from_bytes([8; 64]),
        current_account: Some((
            AccountId32::from_bytes([9; 32]),
            Sr25519Signature::from_bytes([10; 64]),
        )),
    };
    let encoded = response.encode().unwrap();
    assert_eq!(
        parse(&encoded, 99).unwrap(),
        QrCode::SignResponse(response.clone())
    );
    let value = QrCode::SignResponse(response).normalized().unwrap();
    assert_eq!(value["current_account_id"], hex(&[9; 32]));
    let mut invalid: Value = serde_json::from_str(&encoded).unwrap();
    invalid["b"].as_object_mut().unwrap().remove("r");
    assert!(parse(&invalid.to_string(), 99).is_err());
    let input = serde_json::json!({"kind":2,"request_id":"0123456789abcdef","expires_at":"100",
            "signer_account_id":hex(&[7;32]),"signature":hex(&[8;64]),
            "current_account_id":hex(&[9;32]),"current_account_signature":hex(&[10;64])});
    assert_eq!(encode_document(&input.to_string()).unwrap(), value);
}

#[test]
fn authorization_preparation_preserves_template_slots_and_rejects_malformed_inputs() {
    fn payload(action: u32) -> Vec<u8> {
        let mut p = vec![1; 32];
        p.extend_from_slice(&[12, b'C', b'I', b'D']);
        if action == 11 {
            p.extend_from_slice(&[7; 32]);
        }
        p.extend_from_slice(&[0; 32]);
        p.extend_from_slice(&(if action == 11 { 9_u64 } else { 0_u64 }).to_le_bytes());
        p.extend_from_slice(&100_u64.to_le_bytes());
        p
    }
    for action in [10, 11] {
        let raw = payload(action);
        let result = prepare_account_authorization(action, &raw, &hex(&[8; 32]));
        assert_eq!(result["reason"], 0);
        assert_eq!(result["cid_number"], "CID");
        assert_eq!(result["expires_at"], "100");
        let slot = if action == 11 { 68 } else { 36 };
        let mut expected = raw.clone();
        expected[slot..slot + 32].copy_from_slice(&[8; 32]);
        assert_eq!(result["materialized_payload"], hex(&expected));
        assert_eq!(&raw[slot..slot + 32], &[0; 32]);
        assert_eq!(
            prepare_account_authorization(action, &raw, "bad")["reason"],
            2
        );
        let mut extra = raw.clone();
        extra.push(0);
        assert_eq!(
            prepare_account_authorization(action, &extra, &hex(&[8; 32]))["reason"],
            1
        );
        let mut polluted = raw.clone();
        polluted[slot] = 1;
        assert_eq!(
            prepare_account_authorization(action, &polluted, &hex(&[8; 32]))["reason"],
            1
        );
    }
    assert_eq!(
        prepare_account_authorization(11, &payload(11), &hex(&[7; 32]))["reason"],
        3
    );
    assert_eq!(
        prepare_account_authorization(12, &payload(10), &hex(&[8; 32]))["reason"],
        1
    );
    for length in 0..payload(10).len() {
        assert_eq!(
            prepare_account_authorization(10, &payload(10)[..length], &hex(&[8; 32]))["reason"],
            1
        );
    }
}

fn request() -> SignRequest {
    SignRequest {
        request_id: "0123456789abcdef".to_owned(),
        expires_at: 100,
        action: 0x0400,
        signer_public_key: Some(Sr25519PublicKey::from_bytes([7; 32])),
        review_payload: vec![0x04, 0x00, 3],
    }
}

#[test]
fn sign_request_round_trip_is_strict() {
    let encoded = request().encode().unwrap();
    assert_eq!(parse(&encoded, 99), Ok(QrCode::SignRequest(request())));
}

#[test]
fn rejects_unknown_fields_but_accepts_any_opaque_u16_action() {
    let encoded = request().encode().unwrap();
    let injected = encoded.replacen("{\"a\"", "{\"extra\":true,\"a\"", 1);
    assert_eq!(
        parse(&injected, 99).unwrap_err().code(),
        QrErrorCode::InvalidField
    );
    let mut request = request();
    request.action = 2;
    request.review_payload = b"third-party opaque payload".to_vec();
    let encoded = request.encode().unwrap();
    assert_eq!(parse(&encoded, 99), Ok(QrCode::SignRequest(request)));
}

#[test]
fn host_scan_purpose_does_not_allocate_a_wire_kind() {
    let text = r#"{"p":"QR_V1","k":7,"i":"0123456789abcdef","e":100,"b":{}}"#;
    assert_eq!(
        parse(text, 99).unwrap_err().code(),
        QrErrorCode::UnsupportedKind
    );
}

#[test]
fn original_business_codes_round_trip_without_changing_wire_fields() {
    let account = format!("0x{}", "07".repeat(32));
    let contact = format!(r#"{{"p":"QR_V1","k":3,"b":{{"c":"CID-7","n":"{account}"}}}}"#);
    let transfer = format!(
        r#"{{"p":"QR_V1","k":4,"i":"original-id","e":100,"b":{{"n":"{account}","v":"1.25","t":"GMB","m":"原备注","l":"BANK-7"}}}}"#
    );
    for raw in [&contact, &transfer] {
        let parsed = parse(raw, 99).unwrap();
        let normalized = parsed.normalized().unwrap();
        let encoded = normalized["canonical_text"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(raw).unwrap(),
            serde_json::from_str::<Value>(encoded).unwrap()
        );
        assert!(!parsed.permits(QrScanPurpose::ColdAccountImport));
        assert!(parsed.permits(QrScanPurpose::TransferRecipient));
        assert!(parsed.permits(QrScanPurpose::GeneralScan));
        assert_eq!(
            normalized["scan_purpose_mask"],
            Value::from(parsed.scan_purpose_mask())
        );
    }
    assert!(parse(&contact, 99)
        .unwrap()
        .permits(QrScanPurpose::AccountTarget));
    assert!(!parse(&transfer, 99)
        .unwrap()
        .permits(QrScanPurpose::AccountTarget));
    assert_eq!(
        parse(&transfer, 100).unwrap_err().code(),
        QrErrorCode::Expired
    );
    assert_eq!(
        parse(&contact.replace("CID-7", "CID\u{200b}7"), 99)
            .unwrap_err()
            .code(),
        QrErrorCode::InvalidField
    );
    assert_eq!(
        parse(&contact.replace("\"c\":", "\"c\":\"CID-8\",\"c\":"), 99)
            .unwrap_err()
            .code(),
        QrErrorCode::InvalidFormat
    );
}

#[test]
fn scan_purposes_are_separate_from_cold_import_and_wire_kinds() {
    let codes = [
        QrCode::SignRequest(request()),
        QrCode::SignResponse(SignResponse {
            current_account: None,
            request_id: "0123456789abcdef".into(),
            expires_at: 100,
            signer_public_key: Sr25519PublicKey::from_bytes([7; 32]),
            signature: Sr25519Signature::from_bytes([0; 64]),
        }),
        QrCode::UserContact(UserContactCode {
            cid_number: "CID-7".into(),
            account_id: AccountId32::from_bytes([7; 32]),
        }),
        QrCode::UserTransfer(UserTransferCode {
            request_id: "original-id".into(),
            expires_at: 100,
            account_id: AccountId32::from_bytes([7; 32]),
            amount: "1".into(),
            symbol: "GMB".into(),
            memo: "".into(),
            bank_cid_number: "BANK-7".into(),
        }),
        QrCode::AccountId(AccountIdCode {
            account_id: AccountId32::from_bytes([7; 32]),
        }),
    ];
    assert_eq!(
        codes.map(|code| code.scan_purpose_mask()),
        [80, 8, 198, 66, 195]
    );
}

#[test]
fn unsupported_wire_kind_is_rejected() {
    let text = r#"{"p":"QR_V1","k":6,"i":"request-id","e":100,"b":{}}"#;
    assert_eq!(
        parse(text, 99).unwrap_err().code(),
        QrErrorCode::UnsupportedKind
    );
    assert_eq!(
        encode_document(r#"{"kind":6}"#).unwrap_err().code(),
        QrErrorCode::UnsupportedKind
    );
}

#[test]
fn rejects_duplicate_keys_without_imposing_payload_action_semantics() {
    let encoded = request().encode().unwrap();
    // serde_json 的对象键序不是协议合同的一部分；直接在根对象首位插入
    // 第二个 `p`，保证无论规范编码的键顺序如何都确实形成重复键。
    let duplicate = format!("{{\"p\":\"QR_V1\",{}", &encoded[1..]);
    assert_eq!(
        parse(&duplicate, 99).unwrap_err().code(),
        QrErrorCode::InvalidFormat
    );
    let mut mismatched = request();
    mismatched.review_payload[1] = 1;
    let encoded = mismatched.encode().unwrap();
    assert_eq!(parse(&encoded, 99), Ok(QrCode::SignRequest(mismatched)));
}

#[test]
fn rejects_expired_and_oversized_values() {
    assert_eq!(
        parse(&request().encode().unwrap(), 100).unwrap_err().code(),
        QrErrorCode::Expired
    );
    assert_eq!(
        parse(&"x".repeat(MAX_QR_TEXT_BYTES + 1), 0)
            .unwrap_err()
            .code(),
        QrErrorCode::CapacityExceeded
    );
}

#[test]
fn expiry_uses_the_same_exact_positive_i64_domain_in_every_wire_kind() {
    let mut request = request();
    request.expires_at = i64::MAX as u64;
    let response = SignResponse {
        current_account: None,
        request_id: request.request_id.clone(),
        expires_at: request.expires_at,
        signer_public_key: request.require_signer().unwrap(),
        signature: Sr25519Signature::from_bytes([0; 64]),
    };
    for text in [request.encode().unwrap(), response.encode().unwrap()] {
        assert!(parse(&text, 99).is_ok());
        let invalid = text.replace(&i64::MAX.to_string(), &(i64::MAX as u64 + 1).to_string());
        assert_eq!(
            parse(&invalid, 99).unwrap_err().code(),
            QrErrorCode::InvalidField
        );
    }
    request.expires_at += 1;
    assert_eq!(
        request.encode().unwrap_err().code(),
        QrErrorCode::InvalidField
    );
    let mut response = response;
    response.expires_at += 1;
    assert_eq!(
        response.encode().unwrap_err().code(),
        QrErrorCode::InvalidField
    );
}
