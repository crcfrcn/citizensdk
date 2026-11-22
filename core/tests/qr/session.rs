//! 验证二维码会话绑定、期限和消费边界，以及SDK模块唯一入口。

use super::*;
use crate::types::AccountSignature;
use crate::types::SecretBuffer;

struct FixedClock(u64);
impl QrClock for FixedClock {
    fn now_epoch_seconds(&self) -> u64 {
        self.0
    }
}
fn public() -> Sr25519PublicKey {
    crate::sign::public_key(&SecretBuffer::try_new(vec![7; 32]).unwrap()).unwrap()
}
fn response(request: &SignRequest) -> SignResponse {
    SignResponse {
        current_account: None,
        request_id: request.request_id.clone(),
        expires_at: request.expires_at,
        signer_public_key: request.require_signer().unwrap(),
        signature: crate::sign::sign(
            &SecretBuffer::try_new(vec![7; 32]).unwrap(),
            &request.signing_message().unwrap(),
        )
        .unwrap()
        .into(),
    }
}
fn request(store: &mut QrSessionStore<FixedClock>) -> SignRequest {
    store.create(0x0400, public(), vec![4, 0, 3], 30).unwrap()
}
fn invalid(response: &SignResponse) -> SignResponse {
    let mut value = response.clone();
    let mut signature: [u8; 64] = value.signature.as_bytes().try_into().unwrap();
    signature[0] ^= 1;
    value.signature = AccountSignature::from_bytes(signature);
    value
}

#[test]
fn wrong_response_expiry_and_signature_leave_original_session_retryable() {
    let mut store = QrSessionStore::new(FixedClock(10));
    let request = request(&mut store);
    let mut answer = response(&request);
    answer.expires_at += 1;
    assert_eq!(
        store
            .verify_and_consume_response(&answer)
            .unwrap_err()
            .code(),
        QrErrorCode::Expired
    );
    assert!(store.is_pending(&request.request_id).unwrap());
    answer.expires_at = request.expires_at;
    assert_eq!(
        store
            .verify_and_consume_response(&invalid(&answer))
            .unwrap_err()
            .code(),
        QrErrorCode::InvalidSignature
    );
    assert!(store.is_pending(&request.request_id).unwrap());
    store.clock.0 = request.expires_at;
    assert!(!store.is_pending(&request.request_id).unwrap());
    store.clock.0 = 0;
    assert_eq!(
        store.is_pending(&request.request_id).unwrap_err().code(),
        QrErrorCode::ClockUnavailable
    );
}
#[test]
fn response_preflight_cannot_override_cancel_expiry_or_consumption() {
    let mut store = QrSessionStore::new(FixedClock(10));
    let request = request(&mut store);
    let answer = response(&request);
    for _ in 0..2 {
        assert!(store.verify_response(&answer).is_ok());
        assert!(store.is_pending(&request.request_id).unwrap());
    }
    assert_eq!(
        store.verify_response(&invalid(&answer)).unwrap_err().code(),
        QrErrorCode::InvalidSignature
    );
    let mut wrong = answer.clone();
    wrong.signer_public_key = Sr25519PublicKey::from_bytes([3; 32]);
    assert_eq!(
        store.verify_response(&wrong).unwrap_err().code(),
        QrErrorCode::MismatchedAccount
    );
    wrong = answer.clone();
    wrong.request_id = "another-request".into();
    assert_eq!(
        store.verify_response(&wrong).unwrap_err().code(),
        QrErrorCode::MismatchedRequest
    );
    store.clock.0 = request.expires_at;
    assert_eq!(
        store
            .verify_and_consume_response(&answer)
            .unwrap_err()
            .code(),
        QrErrorCode::Expired
    );
    store.clock.0 = 10;
    assert!(store.verify_and_consume_response(&answer).is_ok());
    assert_eq!(
        store.verify_response(&answer).unwrap_err().code(),
        QrErrorCode::AlreadyConsumed
    );
    assert!(store.cancel(&request.request_id));
    assert_eq!(
        store.verify_response(&answer).unwrap_err().code(),
        QrErrorCode::MismatchedRequest
    );
}
#[test]
fn response_is_verified_bound_and_consumed_once() {
    let mut store = QrSessionStore::new(FixedClock(10));
    let request = request(&mut store);
    let answer = response(&request);
    let (_, signature) = store.verify_and_consume_response(&answer).unwrap();
    assert_eq!(signature, answer.signature);
    assert_eq!(
        store
            .verify_and_consume_response(&answer)
            .unwrap_err()
            .code(),
        QrErrorCode::AlreadyConsumed
    );
}
#[test]
fn invalid_signature_does_not_consume_session() {
    let mut store = QrSessionStore::new(FixedClock(10));
    let request = request(&mut store);
    let answer = response(&request);
    assert_eq!(
        store
            .verify_and_consume_response(&invalid(&answer))
            .unwrap_err()
            .code(),
        QrErrorCode::InvalidSignature
    );
    assert!(store.verify_and_consume_response(&answer).is_ok());
}
#[test]
fn active_session_count_is_bounded() {
    let mut store = QrSessionStore::new(FixedClock(10));
    for _ in 0..MAX_ACTIVE_SESSIONS {
        store.create(0x0400, public(), vec![4, 0], 30).unwrap();
    }
    assert_eq!(
        store
            .create(0x0400, public(), vec![4, 0], 30)
            .unwrap_err()
            .code(),
        QrErrorCode::CapacityExceeded
    );
}
#[test]
fn creation_keeps_expiry_in_cross_platform_signed_integer_domain() {
    let mut edge = QrSessionStore::new(FixedClock(i64::MAX as u64 - 1));
    assert_eq!(
        edge.create(0x0400, public(), vec![4, 0], 1)
            .unwrap()
            .expires_at,
        i64::MAX as u64
    );
    let mut overflow = QrSessionStore::new(FixedClock(i64::MAX as u64));
    assert_eq!(
        overflow
            .create(0x0400, public(), vec![4, 0], 1)
            .unwrap_err()
            .code(),
        QrErrorCode::InvalidField
    );
}

#[test]
fn pq_response_round_trips_shared_frames_and_is_consumed_once() {
    let child = [7; 32];
    let public = mldsa::public_key(&child);
    let account = mldsa::account_id(&public);
    let mut store = QrSessionStore::new(FixedClock(10));
    let request = store
        .create(
            0x0400,
            Sr25519PublicKey::from_bytes(account),
            vec![4, 0, 3],
            30,
        )
        .unwrap();
    let message = mldsa::review_message(&account, &request.review_payload);
    let answer = SignResponse {
        current_account: None,
        request_id: request.request_id.clone(),
        expires_at: request.expires_at,
        signer_public_key: request.require_signer().unwrap(),
        signature: crate::types::AccountSignature::pq(
            public,
            mldsa::sign(&child, &message).unwrap(),
        ),
    };
    let encoded = answer.encode().unwrap();
    let parsed = crate::qr::parse_at(&encoded, 10).unwrap();
    let normalized = parsed.normalized().unwrap();
    let frames = normalized["qr_frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(frames.len() > 1);
    assert!(frames.iter().all(|frame| frame.len() <= 2331));
    assert_eq!(mldsa::qr_join(&frames.join("\n")).unwrap(), Some(encoded));
    assert_eq!(
        normalized["signature"].as_str().unwrap().len(),
        2 + 5261 * 2
    );
    let (_, signature) = store.verify_and_consume_response(&answer).unwrap();
    assert_eq!(signature.to_wire().len(), 5261);
    assert!(store.verify_and_consume_response(&answer).is_err());
}

// 模块公开入口必须承载原业务实现，禁止恢复被替代的汇总层。
#[test]
fn qr_store_and_type_entries_have_one_public_surface() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for relative in [
        "core/src/qr/mod.rs",
        "core/src/store/mod.rs",
        "core/src/types/mod.rs",
    ] {
        let source = std::fs::read_to_string(root.join(relative)).unwrap();
        assert!(
            !source
                .lines()
                .any(|line| line.trim_start().starts_with("pub mod ")),
            "{relative}"
        );
    }
    assert!(std::fs::read_to_string(root.join("core/src/qr/mod.rs"))
        .unwrap()
        .contains("pub fn parse"));
    assert!(std::fs::read_to_string(root.join("core/src/store/mod.rs"))
        .unwrap()
        .contains("pub struct PublicStore"));
    assert!(std::fs::read_to_string(root.join("core/src/types/mod.rs"))
        .unwrap()
        .contains("pub trait WalletProfileStore"));
    for relative in [
        "core/src/qr/codec.rs",
        "core/src/store/public.rs",
        "core/src/store/error.rs",
        "core/src/store/key.rs",
        "core/src/types/store.rs",
        "core/src/types/store_chain_database.rs",
        "core/src/types/store_runtime_cache.rs",
        "core/src/types/store_wallet_profile.rs",
    ] {
        assert!(!root.join(relative).exists(), "{relative}");
    }
}
