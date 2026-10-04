//! CitizenSDK 能力发现合同。

use std::collections::BTreeSet;

use crate::{ContractError, ContractErrorCode, ContractResult};

/// 实例启用模块集合；位值与中央 CitizenSDK 字典保持一致。
///
/// 模块选择与设备能力不同：未选模块不得装配资源；交易和历史必须显式选择链。
/// 钱包与签名分别启用，钱包内部派生所需的密码学实现不代表开放公开签名入口。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Modules(u32);

impl Modules {
    pub const WALLET: u32 = 1;
    pub const SIGNING: u32 = 2;
    pub const CHAIN: u32 = 4;
    pub const TRANSACTIONS: u32 = 8;
    pub const HISTORY: u32 = 16;
    pub const QR: u32 = 32;
    pub const ALL: u32 = 63;

    pub fn try_new(bits: u32) -> ContractResult<Self> {
        if bits == 0 || bits & !Self::ALL != 0 {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "modules 必须是非空且仅包含已登记模块位的集合",
            ));
        }
        if bits & (Self::TRANSACTIONS | Self::HISTORY) != 0 && bits & Self::CHAIN == 0 {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "交易或历史模块必须同时启用链模块",
            ));
        }
        Ok(Self(bits))
    }

    pub const fn bits(self) -> u32 {
        self.0
    }

    /// 判断请求的全部位，不能将任意一位相交误判为依赖已满足。
    pub const fn contains(self, bits: u32) -> bool {
        self.0 & bits == bits
    }

    pub const fn full() -> Self {
        Self(Self::ALL)
    }
}

/// CitizenSDK 唯一正式能力名；不得增加近义别名制造第二套能力语义。
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum CapabilityName {
    ChainRead,
    TransactionBuild,
    TransactionSubmit,
    TransactionVerify,
    WalletProfile,
    LocalSigning,
    HardwareVault,
    UserAuthentication,
    History,
    BackgroundSync,
}
impl CapabilityName {
    pub const ALL: [Self; 10] = [
        Self::ChainRead,
        Self::TransactionBuild,
        Self::TransactionSubmit,
        Self::TransactionVerify,
        Self::WalletProfile,
        Self::LocalSigning,
        Self::HardwareVault,
        Self::UserAuthentication,
        Self::History,
        Self::BackgroundSync,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChainRead => "CHAIN_READ",
            Self::TransactionBuild => "TRANSACTION_BUILD",
            Self::TransactionSubmit => "TRANSACTION_SUBMIT",
            Self::TransactionVerify => "TRANSACTION_VERIFY",
            Self::WalletProfile => "WALLET_PROFILE",
            Self::LocalSigning => "LOCAL_SIGNING",
            Self::HardwareVault => "HARDWARE_VAULT",
            Self::UserAuthentication => "USER_AUTHENTICATION",
            Self::History => "HISTORY",
            Self::BackgroundSync => "BACKGROUND_SYNC",
        }
    }
}

/// 能力尚未 ready 的稳定原因。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityReason {
    BuildUnsupported,
    DeviceUnavailable,
    HostDisabled,
    EngineNotRunning,
    DependencyNotReady,
    UserAuthenticationRequired,
    VaultLocked,
    ChainStarting,
    ChainUnsynced,
    StorageUnavailable,
}

impl CapabilityReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BuildUnsupported => "build_unsupported",
            Self::DeviceUnavailable => "device_unavailable",
            Self::HostDisabled => "host_disabled",
            Self::EngineNotRunning => "engine_not_running",
            Self::DependencyNotReady => "dependency_not_ready",
            Self::UserAuthenticationRequired => "user_authentication_required",
            Self::VaultLocked => "vault_locked",
            Self::ChainStarting => "chain_starting",
            Self::ChainUnsynced => "chain_unsynced",
            Self::StorageUnavailable => "storage_unavailable",
        }
    }
}

/// 单项能力在当前构建、设备、宿主配置和运行时中的完整状态。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityStatus {
    name: CapabilityName,
    supported: bool,
    available: bool,
    enabled: bool,
    ready: bool,
    reason: Option<CapabilityReason>,
}

impl CapabilityStatus {
    pub fn try_new(
        name: CapabilityName,
        supported: bool,
        available: bool,
        enabled: bool,
        ready: bool,
        reason: Option<CapabilityReason>,
    ) -> ContractResult<Self> {
        if ready && (!supported || !available || !enabled || reason.is_some()) {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "ready 能力必须同时 supported、available、enabled 且无失败原因",
            ));
        }
        if !ready && reason.is_none() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "未 ready 的能力必须携带稳定原因",
            ));
        }
        Ok(Self {
            name,
            supported,
            available,
            enabled,
            ready,
            reason,
        })
    }

    pub fn ready(name: CapabilityName) -> Self {
        Self {
            name,
            supported: true,
            available: true,
            enabled: true,
            ready: true,
            reason: None,
        }
    }

    pub const fn name(&self) -> CapabilityName {
        self.name
    }

    pub const fn supported(&self) -> bool {
        self.supported
    }

    pub const fn available(&self) -> bool {
        self.available
    }

    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    pub const fn is_ready(&self) -> bool {
        self.ready
    }

    pub const fn reason(&self) -> Option<CapabilityReason> {
        self.reason
    }
}

/// 一次原子读取的完整能力快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilitySnapshot {
    revision: u64,
    statuses: Vec<CapabilityStatus>,
}

impl CapabilitySnapshot {
    /// 快照必须把十个正式能力各包含一次，防止“未返回”被上层误当成 false 或 true。
    pub fn try_new(revision: u64, mut statuses: Vec<CapabilityStatus>) -> ContractResult<Self> {
        let names: BTreeSet<_> = statuses.iter().map(CapabilityStatus::name).collect();
        let expected: BTreeSet<_> = CapabilityName::ALL.into_iter().collect();
        if statuses.len() != CapabilityName::ALL.len() || names != expected {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "能力快照必须精确包含十个正式能力且不得重复",
            ));
        }
        statuses.sort_by_key(CapabilityStatus::name);
        Ok(Self { revision, statuses })
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn statuses(&self) -> &[CapabilityStatus] {
        &self.statuses
    }

    pub fn status(&self, name: CapabilityName) -> Option<&CapabilityStatus> {
        self.statuses.iter().find(|status| status.name() == name)
    }
}
