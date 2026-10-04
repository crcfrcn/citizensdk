use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use citizen_sdk_contracts::{
    apply_signing_transform, ChainSigner, SigningTransform, Sr25519PublicKey, Sr25519Signature,
};

use crate::{QrError, QrErrorCode, SignRequest, SignResponse};

const MAX_ACTIVE_SESSIONS: usize = 64;

pub trait QrClock: Send + Sync {
    fn now_epoch_seconds(&self) -> u64;
}

pub struct SystemQrClock;

impl QrClock for SystemQrClock {
    fn now_epoch_seconds(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QrSession {
    request: SignRequest,
    transform: SigningTransform,
    consumed: bool,
}

impl QrSession {
    pub const fn request(&self) -> &SignRequest {
        &self.request
    }

    pub const fn is_consumed(&self) -> bool {
        self.consumed
    }

    /// The transform is local session state and is never inferred from opaque QR action values.
    pub const fn transform(&self) -> &SigningTransform {
        &self.transform
    }
}

pub struct QrSessionStore<C: QrClock> {
    clock: C,
    sessions: BTreeMap<String, QrSession>,
}

impl<C: QrClock> QrSessionStore<C> {
    pub const fn new(clock: C) -> Self {
        Self {
            clock,
            sessions: BTreeMap::new(),
        }
    }

    pub fn create(
        &mut self,
        action: u16,
        signer_public_key: Sr25519PublicKey,
        review_payload: Vec<u8>,
        ttl_seconds: u64,
    ) -> Result<SignRequest, QrError> {
        self.create_with_transform(
            action,
            signer_public_key,
            review_payload,
            SigningTransform::SubstrateSigningPayload,
            ttl_seconds,
        )
    }

    /// Creates one transport session whose cryptographic transform is fixed by the caller's
    /// generic signing intent. `action` remains opaque transport metadata.
    pub fn create_with_transform(
        &mut self,
        action: u16,
        signer_public_key: Sr25519PublicKey,
        review_payload: Vec<u8>,
        transform: SigningTransform,
        ttl_seconds: u64,
    ) -> Result<SignRequest, QrError> {
        if ttl_seconds == 0 || ttl_seconds > 300 {
            return Err(QrError::new(
                QrErrorCode::InvalidField,
                "二维码签名期限必须位于 1 到 300 秒",
            ));
        }
        let now = self.clock.now_epoch_seconds();
        if now == 0 {
            return Err(QrError::new(
                QrErrorCode::ClockUnavailable,
                "系统时钟不可用",
            ));
        }
        let expires_at = now
            .checked_add(ttl_seconds)
            .ok_or_else(|| QrError::new(QrErrorCode::InvalidField, "二维码期限溢出"))?;
        self.create_with_transform_until(
            action,
            signer_public_key,
            review_payload,
            transform,
            expires_at,
        )
    }

    /// Creates a session ending at an already frozen Unix timestamp. SDK wallet mutations use
    /// this so their signed expiry and transport expiry are exactly the same bytes.
    pub fn create_with_transform_until(
        &mut self,
        action: u16,
        signer_public_key: Sr25519PublicKey,
        review_payload: Vec<u8>,
        transform: SigningTransform,
        expires_at: u64,
    ) -> Result<SignRequest, QrError> {
        let now = self.clock.now_epoch_seconds();
        if now == 0 {
            return Err(QrError::new(
                QrErrorCode::ClockUnavailable,
                "系统时钟不可用",
            ));
        }
        if expires_at <= now || expires_at.saturating_sub(now) > 300 {
            return Err(QrError::new(
                QrErrorCode::InvalidField,
                "二维码签名期限必须位于当前时间之后 1 到 300 秒",
            ));
        }
        self.sessions
            .retain(|_, session| session.request.expires_at > now);
        if self.sessions.len() >= MAX_ACTIVE_SESSIONS {
            return Err(QrError::new(
                QrErrorCode::CapacityExceeded,
                "同一实例的有效二维码签名会话超过上限",
            ));
        }
        let request_id = crate::codec::new_request_id("")?;
        let request = SignRequest {
            request_id: request_id.clone(),
            expires_at,
            action,
            signer_public_key: Some(signer_public_key),
            review_payload,
        };
        transform
            .validate()
            .map_err(|_| QrError::new(QrErrorCode::InvalidField, "签名 transform 无效"))?;
        request.encode()?;
        self.sessions.insert(
            request_id,
            QrSession {
                request: request.clone(),
                transform,
                consumed: false,
            },
        );
        Ok(request)
    }

    /// 核对关联、账户、期限和实际 sr25519 签名后原子消费响应。
    ///
    /// 无效签名绝不改变会话状态；同一请求只有首次有效响应可以成功。
    /// 只验证原会话，不消费；预检与最终消费共用同一账户、期限和transform校验。
    pub async fn verify_response(
        &self,
        signer: &dyn ChainSigner,
        response: &SignResponse,
    ) -> Result<(SignRequest, Sr25519Signature), QrError> {
        let session = self.sessions.get(&response.request_id).ok_or_else(|| {
            QrError::new(QrErrorCode::MismatchedRequest, "签名响应没有对应的本地请求")
        })?;
        if session.consumed {
            return Err(QrError::new(
                QrErrorCode::AlreadyConsumed,
                "签名请求已经消费",
            ));
        }
        let now = self.clock.now_epoch_seconds();
        if now == 0 { return Err(QrError::new(QrErrorCode::ClockUnavailable, "系统时钟不可用")); }
        if session.request.expires_at <= now
            || response.expires_at != session.request.expires_at
        {
            return Err(QrError::new(QrErrorCode::Expired, "签名响应已经过期"));
        }
        if Some(response.signer_public_key) != session.request.signer_public_key {
            return Err(QrError::new(
                QrErrorCode::MismatchedAccount,
                "签名响应账户与请求不一致",
            ));
        }
        let request = session.request.clone();
        let message = apply_signing_transform(&request.review_payload, &session.transform)
            .map_err(|_| QrError::new(QrErrorCode::InvalidField, "签名 transform 或载荷无效"))?;
        let verified = signer
            .verify(response.signer_public_key, message, response.signature)
            .await
            .map_err(|_| {
                QrError::new(
                    QrErrorCode::InvalidSignature,
                    "签名响应无法通过 sr25519 验证",
                )
            })?;
        if !verified {
            return Err(QrError::new(
                QrErrorCode::InvalidSignature,
                "签名响应无法通过 sr25519 验证",
            ));
        }
        let verified_at = self.clock.now_epoch_seconds();
        if verified_at == 0 { return Err(QrError::new(QrErrorCode::ClockUnavailable, "系统时钟不可用")); }
        if request.expires_at <= verified_at {
            return Err(QrError::new(QrErrorCode::Expired, "验签完成时请求已过期"));
        }
        Ok((request, response.signature))
    }

    /// 预检不是可复用授权：每次消费重新执行同一校验，再单次标记消费。
    pub async fn verify_and_consume_response(
        &mut self,
        signer: &dyn ChainSigner,
        response: &SignResponse,
    ) -> Result<(SignRequest, Sr25519Signature), QrError> {
        let verified = self.verify_response(signer, response).await?;
        let session = self.sessions.get_mut(&response.request_id).ok_or_else(|| {
            QrError::new(QrErrorCode::MismatchedRequest, "签名响应没有对应的本地请求")
        })?;
        if session.consumed {
            return Err(QrError::new(
                QrErrorCode::AlreadyConsumed,
                "签名请求已经消费",
            ));
        }
        session.consumed = true;
        Ok(verified)
    }

    pub fn cancel(&mut self, request_id: &str) -> bool {
        self.sessions.remove(request_id).is_some()
    }

    /// 重扫依据本地原请求期限，而不是错误回扫自己声明的期限；不在查询中消费。
    pub fn is_pending(&self, request_id: &str) -> Result<bool, QrError> {
        let now = self.clock.now_epoch_seconds();
        if now == 0 { return Err(QrError::new(QrErrorCode::ClockUnavailable, "系统时钟不可用")); }
        Ok(self.sessions.get(request_id).is_some_and(|session| !session.consumed && session.request.expires_at > now))
    }
}

#[cfg(test)]
mod tests {
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

        fn public_key<'a>(
            &'a self,
            _secret: &'a SecretBuffer,
        ) -> ContractFuture<'a, Sr25519PublicKey> {
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
            let request = sessions.create(0x0400, Sr25519PublicKey::from_bytes([2; 32]), vec![4, 0, 3], 30).unwrap();
            let mut response = SignResponse {
                current_account: None,
                request_id: request.request_id.clone(), expires_at: request.expires_at + 1,
                signer_public_key: request.require_signer().unwrap(), signature: Sr25519Signature::from_bytes([4; 64]),
            };
            assert_eq!(sessions.verify_and_consume_response(&FixedSigner(true), &response).await.unwrap_err().code(), QrErrorCode::Expired);
            assert!(sessions.is_pending(&request.request_id).unwrap());
            response.expires_at = request.expires_at;
            assert_eq!(sessions.verify_and_consume_response(&FixedSigner(false), &response).await.unwrap_err().code(), QrErrorCode::InvalidSignature);
            assert!(sessions.is_pending(&request.request_id).unwrap());
            sessions.clock.0 = request.expires_at;
            assert!(!sessions.is_pending(&request.request_id).unwrap());
            sessions.clock.0 = 0;
            assert_eq!(sessions.is_pending(&request.request_id).unwrap_err().code(), QrErrorCode::ClockUnavailable);
        });
    }

    #[test]
    fn response_preflight_is_repeatable_and_cannot_override_cancel_expiry_or_consumption() {
        futures_executor::block_on(async {
            let mut sessions = QrSessionStore::new(FixedClock(10));
            let request = sessions.create(0x0400, Sr25519PublicKey::from_bytes([2; 32]), vec![4, 0, 3], 30).unwrap();
            let response = SignResponse { current_account: None, request_id: request.request_id.clone(),
                expires_at: request.expires_at, signer_public_key: request.require_signer().unwrap(),
                signature: Sr25519Signature::from_bytes([4; 64]) };
            for _ in 0..2 {
                assert!(sessions.verify_response(&FixedSigner(true), &response).await.is_ok());
                assert!(sessions.is_pending(&request.request_id).unwrap());
            }
            assert_eq!(sessions.verify_response(&FixedSigner(false), &response).await.unwrap_err().code(), QrErrorCode::InvalidSignature);
            let mut wrong = response.clone();
            wrong.signer_public_key = Sr25519PublicKey::from_bytes([3; 32]);
            assert_eq!(sessions.verify_response(&FixedSigner(true), &wrong).await.unwrap_err().code(), QrErrorCode::MismatchedAccount);
            wrong = response.clone();
            wrong.request_id = "another-request".into();
            assert_eq!(sessions.verify_response(&FixedSigner(true), &wrong).await.unwrap_err().code(), QrErrorCode::MismatchedRequest);
            sessions.clock.0 = request.expires_at;
            assert_eq!(sessions.verify_and_consume_response(&FixedSigner(true), &response).await.unwrap_err().code(), QrErrorCode::Expired);
            sessions.clock.0 = 10;
            assert!(sessions.verify_and_consume_response(&FixedSigner(true), &response).await.is_ok());
            assert_eq!(sessions.verify_response(&FixedSigner(true), &response).await.unwrap_err().code(), QrErrorCode::AlreadyConsumed);
            assert!(sessions.cancel(&request.request_id));
            assert_eq!(sessions.verify_response(&FixedSigner(true), &response).await.unwrap_err().code(), QrErrorCode::MismatchedRequest);
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
}
