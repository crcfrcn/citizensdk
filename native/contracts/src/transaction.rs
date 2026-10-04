//! 产品无关的交易提交、观察和执行结论。

use crate::{
    ContractError, ContractErrorCode, ContractResult, FinalizedBlockRef, Hash32, VerifiedBlockRef,
};

/// 已由 Engine 构造并签名的完整 SCALE extrinsic。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignedExtrinsic(Vec<u8>);

impl SignedExtrinsic {
    pub fn try_new(bytes: Vec<u8>) -> ContractResult<Self> {
        if bytes.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "已签名 extrinsic 不能为空",
            ));
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

/// 节点已经接收提交的事实；不是链上执行成功证明。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SubmittedExtrinsic {
    hash: Hash32,
}

impl SubmittedExtrinsic {
    pub const fn new(hash: Hash32) -> Self {
        Self { hash }
    }

    pub const fn hash(self) -> Hash32 {
        self.hash
    }
}

/// 轻节点对 extrinsic 生命周期的观察事实。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtrinsicWatchEvent {
    Ready,
    Broadcast { peer_count: u32 },
    Future,
    InBlock { block: VerifiedBlockRef },
    Finalized { block: FinalizedBlockRef },
    Retracted { block: VerifiedBlockRef },
    FinalityTimeout { block: Option<VerifiedBlockRef> },
    Dropped,
    Invalid,
    Usurped { replacement_hash: Hash32 },
}

/// `DispatchError::Module` 的可验证明细。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModuleDispatchFailure {
    pallet_index: u8,
    error_index: u8,
    pallet_name: Option<String>,
    error_name: Option<String>,
}

impl ModuleDispatchFailure {
    pub fn new(
        pallet_index: u8,
        error_index: u8,
        pallet_name: Option<String>,
        error_name: Option<String>,
    ) -> Self {
        Self {
            pallet_index,
            error_index,
            pallet_name,
            error_name,
        }
    }

    pub const fn pallet_index(&self) -> u8 {
        self.pallet_index
    }

    pub const fn error_index(&self) -> u8 {
        self.error_index
    }

    pub fn pallet_name(&self) -> Option<&str> {
        self.pallet_name.as_deref()
    }

    pub fn error_name(&self) -> Option<&str> {
        self.error_name.as_deref()
    }
}

/// runtime `DispatchError`；variant 始终保留，Module 时再附带 pallet/error 身份。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchFailure {
    variant: u8,
    module: Option<ModuleDispatchFailure>,
}

impl DispatchFailure {
    pub const fn new(variant: u8, module: Option<ModuleDispatchFailure>) -> Self {
        Self { variant, module }
    }

    pub const fn variant(&self) -> u8 {
        self.variant
    }

    pub fn module(&self) -> Option<&ModuleDispatchFailure> {
        self.module.as_ref()
    }
}

/// 已入块但无法形成明确执行证明的稳定原因。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnverifiedReason {
    TargetBlockUnavailable,
    RuntimeContextUnavailable,
    MetadataDecodeFailed,
    BlockBodyUnavailable,
    ExtrinsicHashMismatch,
    ExtrinsicNotFound,
    MultipleExtrinsicMatches,
    SystemEventsUnavailable,
    SystemEventsMalformed,
    OutcomeEventMissing,
    OutcomeEventAmbiguous,
    ProviderFailure,
}

/// Engine 对准确目标块、extrinsic index 和同 index System event 的最终核验结论。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExecutionConclusion {
    Success {
        block: VerifiedBlockRef,
        extrinsic_index: u32,
    },
    Failed {
        block: VerifiedBlockRef,
        extrinsic_index: u32,
        failure: DispatchFailure,
    },
    Unverified {
        block: Option<VerifiedBlockRef>,
        extrinsic_index: Option<u32>,
        reason: UnverifiedReason,
    },
}

impl ExecutionConclusion {
    pub const fn is_verified_success(&self) -> bool {
        matches!(self, Self::Success { .. })
    }
}
