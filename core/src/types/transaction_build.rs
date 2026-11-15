//! 与产品无关的不可变签名载荷和已编码交易值对象。
//!
//! RuntimeCall 字节保持不透明，业务载荷格式由应用持有。

use crate::types::account::require_citizenchain_identity;
use crate::types::AccountId32;
use crate::types::AccountNonce;
use crate::types::AccountPublicKey;
use crate::types::AccountSignature;
use crate::types::ChainIdentity;
use crate::types::ContractError;
use crate::types::ContractErrorCode;
use crate::types::ContractResult;
use crate::types::Hash32;
use crate::types::RuntimeContext;
use crate::types::RuntimeVersion;
use crate::types::SignedExtrinsic;
use crate::types::VerifiedBlockRef;

/// 当前交易准备使用永久有效期。
pub const IMMORTAL_ERA: u8 = 0;

/// 最终签名消息及其公开来源轨迹，账户标识与真实签名公钥分别记录。
///
/// sr 公钥为 32 字节，PQ 公钥为完整 1952 字节；由 mldsa 核对公钥派生的 AccountId。
/// `signing_message` 已应用对应算法的消息规则，消费端不得再次变换，也不接收私密材料。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImmortalSigningPayload {
    block: VerifiedBlockRef,
    runtime_version: RuntimeVersion,
    genesis_hash: Hash32,
    signer_account_id: AccountId32,
    signer_public_key: AccountPublicKey,
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
        signer_public_key: impl Into<AccountPublicKey>,
        call_data: Vec<u8>,
        signing_message: Vec<u8>,
    ) -> ContractResult<Self> {
        require_citizenchain_identity(identity)?;
        let signer_public_key = signer_public_key.into();
        if runtime_context.block() != nonce.best_block() {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "runtime context 与 accountNextIndex nonce 不属于同一准确 best 块",
            ));
        }
        if signer_account_id != nonce.account_id()
            || signer_account_id.into_bytes() != signer_public_key.account_id()
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "签名公钥派生账户、源账户与 nonce 账户不一致",
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

    pub const fn signer_public_key(&self) -> &AccountPublicKey {
        &self.signer_public_key
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

/// 一笔已完成账户签名和 SCALE 交易编码的构造结果。
///
/// 仅封装已核验的公开结果；sr 沿用既有实现，PQ 复用 mldsa，类型合同不重复实现算法。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedTransactionBuild {
    payload: ImmortalSigningPayload,
    signature: AccountSignature,
    extrinsic: SignedExtrinsic,
}

impl SignedTransactionBuild {
    pub fn new(
        payload: ImmortalSigningPayload,
        signature: impl Into<AccountSignature>,
        extrinsic: SignedExtrinsic,
    ) -> Self {
        Self {
            payload,
            signature: signature.into(),
            extrinsic,
        }
    }

    pub const fn payload(&self) -> &ImmortalSigningPayload {
        &self.payload
    }

    pub fn signature(&self) -> AccountSignature {
        self.signature.clone()
    }

    pub const fn extrinsic(&self) -> &SignedExtrinsic {
        &self.extrinsic
    }

    pub fn extrinsic_bytes(&self) -> &[u8] {
        self.extrinsic.as_bytes()
    }
}
