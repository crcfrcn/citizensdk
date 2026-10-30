use super::*;
use citizen_sdk_contracts::{
    ContractError, ContractErrorCode, ContractFuture, DerivationJunction, SecretBuffer,
};

struct FixedClock(u64);
impl QrClock for FixedClock {
    fn now_epoch_seconds(&self) -> u64 {
        self.0
    }
}

struct FixedSigner(bool);

impl ChainSigner for FixedSigner {
    fn derive_hard<'a>(
        &'a self,
        _parent: &'a SecretBuffer,
        _junction: DerivationJunction,
    ) -> ContractFuture<'a, SecretBuffer> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Internal,
                "测试不执行派生",
            ))
        })
    }

    fn public_key<'a>(&'a self, _secret: &'a SecretBuffer) -> ContractFuture<'a, Sr25519PublicKey> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Internal,
                "测试不读取公钥",
            ))
        })
    }

    fn sign<'a>(
        &'a self,
        _secret: &'a SecretBuffer,
        _message: Vec<u8>,
    ) -> ContractFuture<'a, Sr25519Signature> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Internal,
                "测试不执行签名",
            ))
        })
    }

    fn verify(
        &self,
        _public_key: Sr25519PublicKey,
        _message: Vec<u8>,
        _signature: Sr25519Signature,
    ) -> ContractFuture<'_, bool> {
        let verified = self.0;
        Box::pin(async move { Ok(verified) })
    }
}

#[test]
fn wrong_response_expiry_and_signature_leave_the_original_session_retryable() {
    futures_executor::block_on(async {
        let mut sessions = QrSessionStore::new(FixedClock(10));
        let request = sessions
            .create(
                0x0400,
                Sr25519PublicKey::from_bytes([2; 32]),
                vec![4, 0, 3],
                30,
            )
            .unwrap();
        let mut response = SignResponse {
            current_account: None,
            request_id: request.request_id.clone(),
            expires_at: request.expires_at + 1,
            signer_public_key: request.require_signer().unwrap(),
            signature: Sr25519Signature::from_bytes([4; 64]),
        };
        assert_eq!(
            sessions
                .verify_and_consume_response(&FixedSigner(true), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::Expired
        );
        assert!(sessions.is_pending(&request.request_id).unwrap());
        response.expires_at = request.expires_at;
        assert_eq!(
            sessions
                .verify_and_consume_response(&FixedSigner(false), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::InvalidSignature
        );
        assert!(sessions.is_pending(&request.request_id).unwrap());
        sessions.clock.0 = request.expires_at;
        assert!(!sessions.is_pending(&request.request_id).unwrap());
        sessions.clock.0 = 0;
        assert_eq!(
            sessions.is_pending(&request.request_id).unwrap_err().code(),
            QrErrorCode::ClockUnavailable
        );
    });
}

#[test]
fn response_preflight_is_repeatable_and_cannot_override_cancel_expiry_or_consumption() {
    futures_executor::block_on(async {
        let mut sessions = QrSessionStore::new(FixedClock(10));
        let request = sessions
            .create(
                0x0400,
                Sr25519PublicKey::from_bytes([2; 32]),
                vec![4, 0, 3],
                30,
            )
            .unwrap();
        let response = SignResponse {
            current_account: None,
            request_id: request.request_id.clone(),
            expires_at: request.expires_at,
            signer_public_key: request.require_signer().unwrap(),
            signature: Sr25519Signature::from_bytes([4; 64]),
        };
        for _ in 0..2 {
            assert!(sessions
                .verify_response(&FixedSigner(true), &response)
                .await
                .is_ok());
            assert!(sessions.is_pending(&request.request_id).unwrap());
        }
        assert_eq!(
            sessions
                .verify_response(&FixedSigner(false), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::InvalidSignature
        );
        let mut wrong = response.clone();
        wrong.signer_public_key = Sr25519PublicKey::from_bytes([3; 32]);
        assert_eq!(
            sessions
                .verify_response(&FixedSigner(true), &wrong)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::MismatchedAccount
        );
        wrong = response.clone();
        wrong.request_id = "another-request".into();
        assert_eq!(
            sessions
                .verify_response(&FixedSigner(true), &wrong)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::MismatchedRequest
        );
        sessions.clock.0 = request.expires_at;
        assert_eq!(
            sessions
                .verify_and_consume_response(&FixedSigner(true), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::Expired
        );
        sessions.clock.0 = 10;
        assert!(sessions
            .verify_and_consume_response(&FixedSigner(true), &response)
            .await
            .is_ok());
        assert_eq!(
            sessions
                .verify_response(&FixedSigner(true), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::AlreadyConsumed
        );
        assert!(sessions.cancel(&request.request_id));
        assert_eq!(
            sessions
                .verify_response(&FixedSigner(true), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::MismatchedRequest
        );
    });
}

#[test]
fn response_is_verified_bound_and_consumed_once() {
    futures_executor::block_on(async {
        let mut sessions = QrSessionStore::new(FixedClock(10));
        let request = sessions
            .create(
                0x0400,
                Sr25519PublicKey::from_bytes([2; 32]),
                vec![4, 0, 3],
                30,
            )
            .unwrap();
        let response = SignResponse {
            current_account: None,
            request_id: request.request_id.clone(),
            expires_at: request.expires_at,
            signer_public_key: request.require_signer().unwrap(),
            signature: Sr25519Signature::from_bytes([4; 64]),
        };
        assert!(sessions
            .verify_and_consume_response(&FixedSigner(true), &response)
            .await
            .is_ok());
        assert_eq!(
            sessions
                .verify_and_consume_response(&FixedSigner(true), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::AlreadyConsumed
        );
    });
}

#[test]
fn invalid_signature_does_not_consume_session() {
    futures_executor::block_on(async {
        let mut sessions = QrSessionStore::new(FixedClock(10));
        let request = sessions
            .create(
                0x0400,
                Sr25519PublicKey::from_bytes([2; 32]),
                vec![4, 0, 3],
                30,
            )
            .unwrap();
        let response = SignResponse {
            current_account: None,
            request_id: request.request_id.clone(),
            expires_at: request.expires_at,
            signer_public_key: request.require_signer().unwrap(),
            signature: Sr25519Signature::from_bytes([4; 64]),
        };
        assert_eq!(
            sessions
                .verify_and_consume_response(&FixedSigner(false), &response)
                .await
                .unwrap_err()
                .code(),
            QrErrorCode::InvalidSignature
        );
        assert!(sessions
            .verify_and_consume_response(&FixedSigner(true), &response)
            .await
            .is_ok());
    });
}

#[test]
fn active_session_count_is_bounded() {
    let mut sessions = QrSessionStore::new(FixedClock(10));
    for _ in 0..MAX_ACTIVE_SESSIONS {
        sessions
            .create(
                0x0400,
                Sr25519PublicKey::from_bytes([2; 32]),
                vec![4, 0],
                30,
            )
            .unwrap();
    }
    assert_eq!(
        sessions
            .create(
                0x0400,
                Sr25519PublicKey::from_bytes([2; 32]),
                vec![4, 0],
                30
            )
            .unwrap_err()
            .code(),
        QrErrorCode::CapacityExceeded
    );
}

#[test]
fn creation_keeps_expiry_in_the_cross_platform_signed_integer_domain() {
    let public = Sr25519PublicKey::from_bytes([2; 32]);
    let mut at_edge = QrSessionStore::new(FixedClock(i64::MAX as u64 - 1));
    assert_eq!(
        at_edge
            .create(0x0400, public, vec![4, 0], 1)
            .unwrap()
            .expires_at,
        i64::MAX as u64
    );
    let mut overflow = QrSessionStore::new(FixedClock(i64::MAX as u64));
    assert_eq!(
        overflow
            .create(0x0400, public, vec![4, 0], 1)
            .unwrap_err()
            .code(),
        QrErrorCode::InvalidField
    );
    assert!(overflow.sessions.is_empty(), "拒绝的跨端溢出不得留下会话");
}
