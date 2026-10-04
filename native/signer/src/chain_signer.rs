//! `citizen_sdk_contracts::ChainSigner` 的真实 schnorrkel 适配器。
//!
//! 系统 Keystore、StrongBox、Secure Enclave 或 TPM 只负责 `SecretVault`；它们不能
//! 冒充 sr25519 signer。解锁后的 `SecretBuffer` 仅在同步 Rust 闭包内借给本实现，
//! 不经过 Dart、Swift、Kotlin 或公共 C ABI。

use citizen_sdk_contracts::{
    ChainSigner, ContractError, ContractErrorCode, ContractFuture, DerivationJunction,
    SecretBuffer, Sr25519PublicKey, Sr25519Signature,
};

use crate::sr25519::{self, Sr25519Error};

/// CitizenSDK 的软件 sr25519 signer；本类型不持有秘密或可变状态。
#[derive(Clone, Copy, Debug, Default)]
pub struct Sr25519SoftwareSigner;

impl ChainSigner for Sr25519SoftwareSigner {
    fn derive_hard<'a>(
        &'a self,
        parent: &'a SecretBuffer,
        junction: DerivationJunction,
    ) -> ContractFuture<'a, SecretBuffer> {
        Box::pin(async move {
            let derived = parent
                .with_secret(|secret| sr25519::derive_hard(secret, junction.chain_code()))
                .map_err(contract_error)?;
            // `derived` 与新建的 SecretBuffer 都具备析构清零；秘密不会作为普通返回值
            // 离开 Rust。`try_new` 对固定 32 字节输入不会走空缓冲错误分支。
            SecretBuffer::try_new(derived.to_vec())
        })
    }

    fn public_key<'a>(&'a self, secret: &'a SecretBuffer) -> ContractFuture<'a, Sr25519PublicKey> {
        Box::pin(async move {
            secret
                .with_secret(sr25519::public_key)
                .map(Sr25519PublicKey::from_bytes)
                .map_err(contract_error)
        })
    }

    fn sign<'a>(
        &'a self,
        secret: &'a SecretBuffer,
        message: Vec<u8>,
    ) -> ContractFuture<'a, Sr25519Signature> {
        Box::pin(async move {
            secret
                .with_secret(|secret| sr25519::sign(secret, &message))
                .map(Sr25519Signature::from_bytes)
                .map_err(contract_error)
        })
    }

    fn verify(
        &self,
        public_key: Sr25519PublicKey,
        message: Vec<u8>,
        signature: Sr25519Signature,
    ) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            sr25519::verify(public_key.as_bytes(), &message, signature.as_bytes())
                .map_err(contract_error)
        })
    }
}

fn contract_error(error: Sr25519Error) -> ContractError {
    let message = match error {
        Sr25519Error::Secret => "sr25519 secret 必须是有效的 32 字节 mini-secret",
        Sr25519Error::PublicKey => "sr25519 公钥编码无效",
        Sr25519Error::Signature => "sr25519 签名编码无效",
    };
    ContractError::new(ContractErrorCode::InvalidArgument, message)
}
