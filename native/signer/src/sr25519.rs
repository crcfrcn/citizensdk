//! CitizenSDK 唯一 sr25519 密码学实现。
//!
//! 本模块只接受 Rust 借用并返回定长公开结果或 `Zeroizing` 秘密结果；裸指针、FFI
//! 错误码和异步合同分别留在 `lib.rs` 与 `chain_signer.rs`。这样 legacy 四原语与
//! `ChainSigner` 不可能各自维护一套 schnorrkel 口径。

use citizen_sdk_contracts::SR25519_SIGNING_CONTEXT;
use schnorrkel::{
    derive::ChainCode, signing_context, ExpansionMode, MiniSecretKey, PublicKey, SecretKey,
    Signature,
};
use zeroize::Zeroizing;

/// 不携带输入字节的密码学错误；错误信息不得把秘密材料带出 Rust 边界。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Sr25519Error {
    Secret,
    PublicKey,
    Signature,
}

/// 按 Substrate `ExpansionMode::Ed25519` 硬派生一层 child mini-secret。
pub(crate) fn derive_hard(
    parent: &[u8],
    chain_code: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, Sr25519Error> {
    let mini = Zeroizing::new(MiniSecretKey::from_bytes(parent).map_err(|_| Sr25519Error::Secret)?);
    let secret: Zeroizing<SecretKey> = Zeroizing::new(mini.expand(ExpansionMode::Ed25519));
    let (child, _) = secret.hard_derive_mini_secret_key(Some(ChainCode(*chain_code)), b"");
    let child = Zeroizing::new(child);
    Ok(Zeroizing::new(child.to_bytes()))
}

/// child mini-secret 对应的 32 字节 AccountId32 公钥。
pub(crate) fn public_key(secret: &[u8]) -> Result<[u8; 32], Sr25519Error> {
    let mini = Zeroizing::new(MiniSecretKey::from_bytes(secret).map_err(|_| Sr25519Error::Secret)?);
    let keypair = Zeroizing::new(mini.expand_to_keypair(ExpansionMode::Ed25519));
    Ok(keypair.public.to_bytes())
}

/// 使用固定 `substrate` context 签名；调用者不能注入或改写 context。
pub(crate) fn sign(secret: &[u8], message: &[u8]) -> Result<[u8; 64], Sr25519Error> {
    let mini = Zeroizing::new(MiniSecretKey::from_bytes(secret).map_err(|_| Sr25519Error::Secret)?);
    let keypair = Zeroizing::new(mini.expand_to_keypair(ExpansionMode::Ed25519));
    Ok(keypair
        .sign(signing_context(SR25519_SIGNING_CONTEXT).bytes(message))
        .to_bytes())
}

/// 使用固定 `substrate` context 验签；格式正确但签名不匹配时返回 `Ok(false)`。
pub(crate) fn verify(
    public_key: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<bool, Sr25519Error> {
    let public_key = PublicKey::from_bytes(public_key).map_err(|_| Sr25519Error::PublicKey)?;
    let signature = Signature::from_bytes(signature).map_err(|_| Sr25519Error::Signature)?;
    Ok(public_key
        .verify(
            signing_context(SR25519_SIGNING_CONTEXT).bytes(message),
            &signature,
        )
        .is_ok())
}
