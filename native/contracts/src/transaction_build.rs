//! Product-independent immutable signing payload and signed extrinsic value objects.
//!
//! Opaque RuntimeCall bytes remain uninterpreted; applications own their business schema.

use crate::{
    account::require_citizenchain_identity, AccountId32, AccountNonce, ChainIdentity,
    ContractError, ContractErrorCode, ContractResult, Hash32, RuntimeContext, RuntimeVersion,
    SignedExtrinsic, Sr25519PublicKey, Sr25519Signature, VerifiedBlockRef,
};

/// Current CitizenSDK transaction preparation uses an immortal era.
pub const IMMORTAL_ERA: u8 = 0;

/// Engine 交给 sr25519 的最终 immortal 签名消息及其完整公开来源轨迹。
///
/// `signing_message` 是经过 metadata registry 编码、并已应用 Substrate 长载荷规则的最终
/// 消息；绑定层不得自行重编码。该对象刻意不实现任何秘密接口。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImmortalSigningPayload {
    block: VerifiedBlockRef,
    runtime_version: RuntimeVersion,
    genesis_hash: Hash32,
    signer_account_id: AccountId32,
    signer_public_key: Sr25519PublicKey,
    nonce: u64,
    call_data: Vec<u8>,
    signing_message: Vec<u8>,
}

impl ImmortalSigningPayload {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        identity: &ChainIdentity,
        runtime_context: &RuntimeContext,
        nonce: AccountNonce,
        signer_account_id: AccountId32,
        signer_public_key: Sr25519PublicKey,
        call_data: Vec<u8>,
        signing_message: Vec<u8>,
    ) -> ContractResult<Self> {
        require_citizenchain_identity(identity)?;
        if runtime_context.block() != nonce.best_block() {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "runtime context 与 accountNextIndex nonce 不属于同一准确 best 块",
            ));
        }
        if signer_account_id != nonce.account_id()
            || signer_account_id.as_bytes() != signer_public_key.as_bytes()
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "签名账户、公钥与 nonce 账户不一致",
            ));
        }
        if call_data.is_empty() || signing_message.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "call data 与最终签名消息均不能为空",
            ));
        }
        Ok(Self {
            block: runtime_context.block(),
            runtime_version: runtime_context.version(),
            genesis_hash: identity.genesis_hash(),
            signer_account_id,
            signer_public_key,
            nonce: nonce.value(),
            call_data,
            signing_message,
        })
    }

    pub const fn block(&self) -> VerifiedBlockRef {
        self.block
    }

    pub const fn runtime_version(&self) -> RuntimeVersion {
        self.runtime_version
    }

    pub const fn genesis_hash(&self) -> Hash32 {
        self.genesis_hash
    }

    pub const fn signer_account_id(&self) -> AccountId32 {
        self.signer_account_id
    }

    pub const fn signer_public_key(&self) -> Sr25519PublicKey {
        self.signer_public_key
    }

    pub const fn nonce(&self) -> u64 {
        self.nonce
    }

    pub fn call_data(&self) -> &[u8] {
        &self.call_data
    }

    pub fn signing_message(&self) -> &[u8] {
        &self.signing_message
    }
}

/// 一笔已完成 sr25519 签名和 SCALE extrinsic 编码的构造结果。
///
/// 构造器只封装 Engine 已核验的公开结果；密码学验签仍由 `ChainSigner` 完成，合同层不另造
/// 第二份 sr25519 实现。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedTransactionBuild {
    payload: ImmortalSigningPayload,
    signature: Sr25519Signature,
    extrinsic: SignedExtrinsic,
}

impl SignedTransactionBuild {
    pub const fn new(
        payload: ImmortalSigningPayload,
        signature: Sr25519Signature,
        extrinsic: SignedExtrinsic,
    ) -> Self {
        Self {
            payload,
            signature,
            extrinsic,
        }
    }

    pub const fn payload(&self) -> &ImmortalSigningPayload {
        &self.payload
    }

    pub const fn signature(&self) -> Sr25519Signature {
        self.signature
    }

    pub const fn extrinsic(&self) -> &SignedExtrinsic {
        &self.extrinsic
    }

    pub fn extrinsic_bytes(&self) -> &[u8] {
        self.extrinsic.as_bytes()
    }
}
