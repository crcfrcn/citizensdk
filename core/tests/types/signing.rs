//! 验证签名载荷原语、域隔离、账户绑定及非法载荷拒绝。

use super::*;

#[test]
fn payload_primitives_keep_original_domains_layouts_and_compact_boundaries() {
    assert_eq!(
        encode_signing_payload(SigningPayload::BinaryPrefix { op_tag: 0x18 }).unwrap(),
        b"GMB\x18"
    );
    assert_eq!(
        encode_signing_payload(SigningPayload::Message {
            op_tag: 0x10,
            scale_payload: &[]
        })
        .unwrap(),
        blake2_256(b"GMB\x10").unwrap()
    );
    assert_eq!(
        encode_signing_payload(SigningPayload::U64Le(u64::MAX)).unwrap(),
        vec![255; 8]
    );
    assert_eq!(
        encode_signing_payload(SigningPayload::ScaleString("公民")).unwrap(),
        [vec![24], "公民".as_bytes().to_vec()].concat()
    );
    for (length, prefix) in [
        (63, vec![252]),
        (64, vec![1, 1]),
        (16383, vec![253, 255]),
        (16384, vec![2, 0, 1, 0]),
    ] {
        let text = "x".repeat(length);
        let encoded = encode_signing_payload(SigningPayload::ScaleString(&text)).unwrap();
        assert_eq!(&encoded[..prefix.len()], prefix.as_slice());
        assert_eq!(&encoded[prefix.len()..], text.as_bytes());
    }
    let activate = encode_signing_payload(SigningPayload::ActivateAdmin {
        cid_number: "CID-7",
        institution_code: [1, 2, 3, 4],
        kind: 9,
        signer_public_key: [7; 32],
        timestamp: 0x0807060504030201,
        nonce: [8; 16],
    })
    .unwrap();
    assert_eq!(activate.len(), 97);
    assert_eq!(&activate[..9], b"GMB\x18CID-7");
    assert_eq!(&activate[9..36], &[0; 27]);
    assert_eq!(&activate[36..41], &[1, 2, 3, 4, 9]);
    assert_eq!(&activate[41..73], &[7; 32]);
    assert_eq!(&activate[73..81], &[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(&activate[81..], &[8; 16]);
    let decrypt = encode_signing_payload(SigningPayload::DecryptAdmin {
        cid_number: "C",
        signer_public_key: [7; 32],
        timestamp: 1,
        nonce: [8; 16],
    })
    .unwrap();
    assert_eq!(decrypt.len(), 92);
    assert_eq!(&decrypt[..5], b"GMB\x19C");
    assert!(encode_signing_payload(SigningPayload::DecryptAdmin {
        cid_number: "",
        signer_public_key: [7; 32],
        timestamp: 1,
        nonce: [8; 16],
    })
    .is_err());
    assert!(encode_signing_payload(SigningPayload::DecryptAdmin {
        cid_number: &"x".repeat(33),
        signer_public_key: [7; 32],
        timestamp: 1,
        nonce: [8; 16],
    })
    .is_err());
}

fn account(byte: u8) -> AccountId32 {
    AccountId32::from_bytes([byte; 32])
}

#[test]
fn transforms_have_exact_boundaries_and_domain_separation() {
    for length in [255, 256] {
        let payload = vec![0x55; length];
        let intent = SigningIntent::try_new(
            account(1),
            payload.clone(),
            SigningTransform::SubstrateSigningPayload,
        )
        .unwrap();
        assert_eq!(
            intent.signing_message().unwrap(),
            mldsa::review_message(account(1).as_bytes(), &payload)
        );
    }
    let payload = vec![0x55; 257];
    let intent = SigningIntent::try_new(
        account(1),
        payload.clone(),
        SigningTransform::SubstrateSigningPayload,
    )
    .unwrap();
    assert_eq!(
        intent.signing_message().unwrap(),
        mldsa::review_message(account(1).as_bytes(), &payload)
    );

    let first = SigningIntent::try_new(
        account(1),
        b"opaque".to_vec(),
        SigningTransform::Blake2Domain(b"consumer-a".to_vec()),
    )
    .unwrap();
    let second = SigningIntent::try_new(
        account(1),
        b"opaque".to_vec(),
        SigningTransform::Blake2Domain(b"consumer-b".to_vec()),
    )
    .unwrap();
    assert_ne!(
        first.signing_message().unwrap(),
        second.signing_message().unwrap()
    );
    assert_eq!(
        SigningIntent::try_new(account(1), b"raw".to_vec(), SigningTransform::Raw)
            .unwrap()
            .signing_message()
            .unwrap(),
        b"raw"
    );
}

#[test]
fn three_unrelated_consumers_remain_opaque_to_the_contract() {
    let fixtures: &[(u16, &[u8])] = &[
        (7, b"reference-app:document"),
        (12, &[0xde, 0xad, 0xbe, 0xef]),
        (u16::MAX, b"travel-order-or-third-party-payload"),
    ];
    for (_, payload) in fixtures {
        let intent =
            SigningIntent::try_new(account(9), payload.to_vec(), SigningTransform::Raw).unwrap();
        assert_eq!(intent.payload(), *payload);
    }
}

#[test]
fn invalid_payloads_and_domains_fail_closed() {
    assert!(SigningIntent::try_new(account(1), Vec::new(), SigningTransform::Raw).is_err());
    assert!(SigningIntent::try_new(
        account(1),
        vec![1],
        SigningTransform::Blake2Domain(Vec::new())
    )
    .is_err());
    assert!(SigningIntent::try_new(
        account(1),
        vec![1],
        SigningTransform::Blake2Domain(vec![0; MAX_SIGNING_DOMAIN_BYTES + 1])
    )
    .is_err());
}

#[test]
fn default_account_payload_matches_the_independent_wallet_layout() {
    let before = vec![account(1), account(2), account(3)];
    let ordered = vec![account(2), account(1), account(3)];
    let authorization = DefaultAccountChangeAuthorization::try_new(
        Hash32::from_bytes([0xaa; 32]),
        41,
        account(1),
        before.clone(),
        ordered.clone(),
        99,
        [0xbb; 16],
    )
    .unwrap();
    let payload = authorization.payload();
    assert_eq!(&payload[..32], &[0xaa; 32]);
    assert_eq!(&payload[32..64], account(1).as_bytes());
    assert_eq!(payload[64], 3 << 2);
    assert_eq!(&payload[65..97], account(2).as_bytes());
    assert_eq!(
        &payload[payload.len() - 24..payload.len() - 16],
        &99_u64.to_le_bytes()
    );
    assert_eq!(&payload[payload.len() - 16..], &[0xbb; 16]);
    assert_eq!(authorization.before_account_ids(), before);
    assert_eq!(authorization.ordered_account_ids(), ordered);
    assert_eq!(
        authorization.signing_intent().unwrap().transform(),
        &SigningTransform::Blake2Domain(DEFAULT_ACCOUNT_CHANGE_DOMAIN.to_vec())
    );
}

#[test]
fn u32_year_cid_uses_the_original_fixed_admin_slots() {
    // 规范 u32 最大年份 CID 恰好占满既有 32 字节；旧短 CID 金标仍保留在原测试中。
    let cid = "GD001-CGOVU-000000001-4294967295";
    assert_eq!(cid.len(), 32);
    let activate = encode_signing_payload(SigningPayload::ActivateAdmin {
        cid_number: cid,
        institution_code: *b"CGOV",
        kind: 0,
        signer_public_key: [7; 32],
        timestamp: 123,
        nonce: [8; 16],
    })
    .unwrap();
    assert_eq!(activate.len(), 97);
    assert_eq!(&activate[4..36], cid.as_bytes());
    assert_eq!(&activate[36..40], b"CGOV");
    assert_eq!(&activate[41..73], &[7; 32]);
    assert_eq!(&activate[73..81], &123u64.to_le_bytes());
    assert_eq!(&activate[81..97], &[8; 16]);
    let decrypt = encode_signing_payload(SigningPayload::DecryptAdmin {
        cid_number: cid,
        signer_public_key: [7; 32],
        timestamp: 123,
        nonce: [8; 16],
    })
    .unwrap();
    assert_eq!(decrypt.len(), 92);
    assert_eq!(&decrypt[4..36], cid.as_bytes());
    assert_eq!(&decrypt[36..68], &[7; 32]);
    assert_eq!(&decrypt[68..76], &123u64.to_le_bytes());
    assert_eq!(&decrypt[76..92], &[8; 16]);
}

#[test]
fn v5_both_algorithms_keep_payload_bounds_and_bind_the_account() {
    let transform = SigningTransform::SubstrateSigningPayload;
    let payload = b"full review";
    for algorithm in [0, 1, 2] {
        let message =
            signing_message_for_account(account(1), payload, &transform, algorithm).unwrap();
        assert_eq!(
            message,
            mldsa::review_message(account(1).as_bytes(), payload)
        );
        assert_ne!(
            message,
            signing_message_for_account(account(2), payload, &transform, algorithm).unwrap()
        );
        assert!(signing_message_for_account(account(1), &[], &transform, algorithm).is_err());
        assert!(signing_message_for_account(
            account(1),
            &vec![1; MAX_SIGNING_PAYLOAD_BYTES + 1],
            &transform,
            algorithm
        )
        .is_err());
    }
    assert!(signing_message_for_account(account(1), payload, &transform, 3).is_err());
    assert!(apply_signing_transform(payload, &transform).is_err());
}
