//! 唯一sr25519算法。同步借用秘密，所有临时秘密在作用域结束时清零。
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

pub fn verify(
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
