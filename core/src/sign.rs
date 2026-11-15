//! sr 同步算法与账户签名适配；PQ 算法及账户派生关系复用 mldsa。
#![forbid(unsafe_code)]
use crate::types::{
    ContractError, ContractErrorCode, ContractResult, DerivationJunction, SecretBuffer,
    Sr25519PublicKey, Sr25519Signature, SR25519_SIGNING_CONTEXT,
};
use schnorrkel::{
    derive::ChainCode, signing_context, ExpansionMode, MiniSecretKey, PublicKey, SecretKey,
    Signature,
};
use zeroize::Zeroizing;

fn invalid(message: &str) -> ContractError {
    ContractError::new(ContractErrorCode::InvalidArgument, message)
}

pub fn derive_hard(
    parent: &SecretBuffer,
    junction: DerivationJunction,
) -> ContractResult<SecretBuffer> {
    parent.with_secret(|bytes| {
        let mini = Zeroizing::new(
            MiniSecretKey::from_bytes(bytes)
                .map_err(|_| invalid("sr25519 secret 必须是有效的 32 字节 mini-secret"))?,
        );
        let secret: Zeroizing<SecretKey> = Zeroizing::new(mini.expand(ExpansionMode::Ed25519));
        let (child, _) =
            secret.hard_derive_mini_secret_key(Some(ChainCode(*junction.chain_code())), b"");
        let child = Zeroizing::new(child);
        SecretBuffer::try_new(Zeroizing::new(child.to_bytes()).to_vec())
    })
}

pub fn public_key(secret: &SecretBuffer) -> ContractResult<Sr25519PublicKey> {
    secret.with_secret(|bytes| {
        let mini = Zeroizing::new(
            MiniSecretKey::from_bytes(bytes)
                .map_err(|_| invalid("sr25519 secret 必须是有效的 32 字节 mini-secret"))?,
        );
        let key = Zeroizing::new(mini.expand_to_keypair(ExpansionMode::Ed25519));
        Ok(Sr25519PublicKey::from_bytes(key.public.to_bytes()))
    })
}

pub fn sign(secret: &SecretBuffer, message: impl AsRef<[u8]>) -> ContractResult<Sr25519Signature> {
    secret.with_secret(|bytes| {
        let mini = Zeroizing::new(
            MiniSecretKey::from_bytes(bytes)
                .map_err(|_| invalid("sr25519 secret 必须是有效的 32 字节 mini-secret"))?,
        );
        let key = Zeroizing::new(mini.expand_to_keypair(ExpansionMode::Ed25519));
        Ok(Sr25519Signature::from_bytes(
            key.sign(signing_context(SR25519_SIGNING_CONTEXT).bytes(message.as_ref()))
                .to_bytes(),
        ))
    })
}

pub fn verify_sr25519(
    public: Sr25519PublicKey,
    message: impl AsRef<[u8]>,
    signature: Sr25519Signature,
) -> ContractResult<bool> {
    let public =
        PublicKey::from_bytes(public.as_bytes()).map_err(|_| invalid("sr25519 公钥编码无效"))?;
    let signature =
        Signature::from_bytes(signature.as_bytes()).map_err(|_| invalid("sr25519 签名编码无效"))?;
    Ok(public
        .verify(
            signing_context(SR25519_SIGNING_CONTEXT).bytes(message.as_ref()),
            &signature,
        )
        .is_ok())
}

/// 按 AccountId 验签；sr 公钥可经既有转换传入，PQ 从签名信封取得真实公钥。
pub fn verify(
    account: impl Into<crate::types::AccountId32>,
    message: impl AsRef<[u8]>,
    signature: impl Into<crate::types::AccountSignature>,
) -> ContractResult<bool> {
    let account = account.into();
    match signature.into() {
        crate::types::AccountSignature::Sr25519(signature) => verify_sr25519(
            Sr25519PublicKey::from_bytes(account.into_bytes()),
            message,
            signature,
        ),
        crate::types::AccountSignature::Mldsa65(value) => Ok(mldsa::verify_account_signature(
            account.as_bytes(),
            &value.0,
            message.as_ref(),
            &value.1,
        )),
    }
}

pub fn pq_public_key(secret: &SecretBuffer) -> ContractResult<mldsa::PublicKey> {
    secret.with_secret(|bytes| {
        let child: &[u8; 32] = bytes
            .try_into()
            .map_err(|_| invalid("account seed must be 32 bytes"))?;
        Ok(mldsa::public_key(child))
    })
}
pub fn matches_account(
    secret: &SecretBuffer,
    account: crate::types::AccountId32,
) -> ContractResult<bool> {
    if public_key(secret)?.as_bytes() == account.as_bytes() {
        return Ok(true);
    }
    Ok(mldsa::account_id(&pq_public_key(secret)?) == account.into_bytes())
}
pub fn sign_account(
    secret: &SecretBuffer,
    account: crate::types::AccountId32,
    message: &[u8],
) -> ContractResult<crate::types::AccountSignature> {
    if public_key(secret)?.as_bytes() == account.as_bytes() {
        if !mldsa::legacy_derivation_allowed() {
            return Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "sr25519 accounts are disabled in operation",
            ));
        }
        return sign(secret, message).map(Into::into);
    }
    secret.with_secret(|bytes| {
        let child: &[u8; 32] = bytes
            .try_into()
            .map_err(|_| invalid("account seed must be 32 bytes"))?;
        let (public, signature) = mldsa::sign_with_public(child, message).map_err(invalid)?;
        if mldsa::account_id(&public) != account.into_bytes() {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "account seed does not match AccountId",
            ));
        }
        Ok(crate::types::AccountSignature::pq(public, signature))
    })
}
