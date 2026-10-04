//! sr25519 签名合同；平台硬件金库不实现此 trait。

use crate::{ContractFuture, SecretBuffer};

/// 与当前 CitizenChain/Substrate 已验证实现逐字节一致的签名上下文。
pub const SR25519_SIGNING_CONTEXT: &[u8] = b"substrate";

/// Substrate 硬派生 junction 的 32 字节 chain code。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DerivationJunction([u8; 32]);

impl DerivationJunction {
    pub const fn from_chain_code(chain_code: [u8; 32]) -> Self {
        Self(chain_code)
    }

    pub const fn chain_code(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sr25519PublicKey([u8; 32]);

impl Sr25519PublicKey {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sr25519Signature([u8; 64]);

impl Sr25519Signature {
    pub const fn from_bytes(bytes: [u8; 64]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 64] {
        &self.0
    }
}

/// 产品无关 sr25519 实现边界。签名 context 固定为 `substrate`，不由调用者注入。
pub trait ChainSigner: Send + Sync {
    fn derive_hard<'a>(
        &'a self,
        parent: &'a SecretBuffer,
        junction: DerivationJunction,
    ) -> ContractFuture<'a, SecretBuffer>;

    fn public_key<'a>(&'a self, secret: &'a SecretBuffer) -> ContractFuture<'a, Sr25519PublicKey>;

    fn sign<'a>(
        &'a self,
        secret: &'a SecretBuffer,
        message: Vec<u8>,
    ) -> ContractFuture<'a, Sr25519Signature>;

    fn verify(
        &self,
        public_key: Sr25519PublicKey,
        message: Vec<u8>,
        signature: Sr25519Signature,
    ) -> ContractFuture<'_, bool>;
}
