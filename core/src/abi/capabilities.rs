#[cfg(feature = "chain")]
use crate::chain::ProviderLifecycle;
use crate::types::CapabilityName;
use crate::types::CapabilityReason;
use crate::types::CapabilitySnapshot;
use crate::types::CapabilityStatus;
use crate::types::Modules;
use crate::types::VaultAvailability;
use crate::CapabilityProbe;
use crate::EngineLifecycle;

use crate::abi::error::FfiError;
use crate::abi::error::FfiResult;
use crate::abi::types::CitizenSdkCapabilityName;
use crate::abi::types::CitizenSdkCapabilityReason;
use crate::abi::types::CitizenSdkCapabilitySnapshot;
use crate::abi::types::CitizenSdkCapabilityStatus;
use crate::abi::types::CitizenSdkLifecycle;

/// 由产品内部组合实际探测出的组件事实；宿主不能直接提交这组布尔值。
///
/// chain-only 与完整钱包的区别由 同一实例所选模块与实际资源推导。任何存储或
/// vault 探测失败都保留“构建支持”事实，但关闭 runtime readiness。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProductCapabilityFacts {
    wallet_composed: bool,
    host_probe_completed: bool,
    vault_availability: VaultAvailability,
    wallet_store_ready: bool,
    encrypted_secrets_ready: bool,
    wallet_key_ready: bool,
    history_store_ready: bool,
    history_probe_completed: bool,
    background_sync_composed: bool,
}

impl ProductCapabilityFacts {
    pub(crate) const fn chain_only() -> Self {
        Self {
            wallet_composed: false,
            host_probe_completed: false,
            vault_availability: VaultAvailability::Unsupported,
            wallet_store_ready: false,
            encrypted_secrets_ready: false,
            wallet_key_ready: false,
            history_store_ready: false,
            history_probe_completed: false,
            background_sync_composed: false,
        }
    }

    pub(crate) const fn wallet(
        vault_availability: VaultAvailability,
        wallet_store_ready: bool,
        encrypted_secrets_ready: bool,
        wallet_key_ready: bool,
        history_store_ready: bool,
        background_sync_composed: bool,
    ) -> Self {
        Self {
            wallet_composed: true,
            host_probe_completed: true,
            vault_availability,
            wallet_store_ready,
            encrypted_secrets_ready,
            wallet_key_ready,
            history_store_ready,
            history_probe_completed: true,
            background_sync_composed,
        }
    }

    /// 历史仓储必须独立执行真实探测，不能从钱包存在性或回调指针猜测可读。
    pub(crate) const fn with_history(
        mut self,
        history_store_ready: bool,
        background_sync_composed: bool,
    ) -> Self {
        self.history_probe_completed = true;
        self.history_store_ready = history_store_ready;
        self.background_sync_composed = background_sync_composed;
        self
    }

    /// 构造阶段只声明钱包组件已经按完整 bundle 组合，不同步调用宿主存储或金库。
    ///
    /// `citizensdk_create` 可以从 Android/iOS 主线程调用；若在构造函数内等待
    /// 宿主异步 completion，会让随后需要回到同一线程的系统金库形成死锁。真实
    /// availability/readiness 在 SDK 工作线程第一次刷新能力时取得。
    pub(crate) const fn wallet_configured() -> Self {
        Self {
            wallet_composed: true,
            host_probe_completed: false,
            vault_availability: VaultAvailability::Unavailable,
            wallet_store_ready: false,
            encrypted_secrets_ready: false,
            wallet_key_ready: false,
            history_store_ready: false,
            history_probe_completed: false,
            background_sync_composed: false,
        }
    }
}

/// 模块选择、编译支持、设备事实和运行时就绪分别投影；不从平台名称推断业务能力。
/// 钱包与签名共享设备安全资源，但互不依赖公开能力的启用状态；历史探测独立于钱包。
pub(crate) fn product_probes(
    provider_is_usable: bool,
    facts: ProductCapabilityFacts,
    modules: Modules,
    history_present: bool,
) -> Vec<CapabilityProbe> {
    let vault_device_available = matches!(
        facts.vault_availability,
        VaultAvailability::Available | VaultAvailability::NoStrongUserAuthentication
    );
    let vault_ready = facts.vault_availability == VaultAvailability::Available;
    let vault_not_ready_reason = match facts.vault_availability {
        VaultAvailability::Available => None,
        VaultAvailability::NoStrongUserAuthentication => {
            Some(CapabilityReason::UserAuthenticationRequired)
        }
        VaultAvailability::Unsupported | VaultAvailability::Unavailable => {
            Some(CapabilityReason::DeviceUnavailable)
        }
    };
    let signing_storage_ready =
        facts.wallet_store_ready && facts.encrypted_secrets_ready && facts.wallet_key_ready;
    let signing_ready = facts.wallet_composed && signing_storage_ready && vault_ready;
    let signing_reason = if !vault_ready {
        vault_not_ready_reason
    } else if !signing_storage_ready {
        Some(CapabilityReason::StorageUnavailable)
    } else {
        None
    };

    CapabilityName::ALL
        .into_iter()
        .map(|name| {
            let (supported, enabled) = match name {
                CapabilityName::ChainRead => {
                    (cfg!(feature = "chain"), modules.contains(Modules::CHAIN))
                }
                CapabilityName::TransactionBuild
                | CapabilityName::TransactionSubmit
                | CapabilityName::TransactionVerify => (
                    cfg!(feature = "transactions"),
                    modules.contains(Modules::TRANSACTIONS),
                ),
                CapabilityName::WalletProfile => {
                    (cfg!(feature = "wallet"), modules.contains(Modules::WALLET))
                }
                CapabilityName::LocalSigning => (
                    cfg!(feature = "signing"),
                    modules.contains(Modules::SIGNING),
                ),
                CapabilityName::HardwareVault | CapabilityName::UserAuthentication => (
                    cfg!(feature = "wallet") || cfg!(feature = "signing"),
                    modules.bits() & (Modules::WALLET | Modules::SIGNING) != 0,
                ),
                CapabilityName::History | CapabilityName::BackgroundSync => (
                    cfg!(feature = "history"),
                    modules.contains(Modules::HISTORY),
                ),
            };
            // 未选择模块时不探测设备，更不能把“未装配”误报成“构建不支持”。
            let mut probe = CapabilityProbe {
                name,
                supported,
                available: true,
                enabled,
                runtime_ready: false,
                not_ready_reason: Some(CapabilityReason::HostDisabled),
            };
            if !supported {
                probe.not_ready_reason = Some(CapabilityReason::BuildUnsupported);
                return probe;
            }
            if !enabled {
                return probe;
            }
            match name {
                CapabilityName::ChainRead
                | CapabilityName::TransactionBuild
                | CapabilityName::TransactionSubmit
                | CapabilityName::TransactionVerify => {
                    probe.runtime_ready = provider_is_usable;
                    probe.not_ready_reason =
                        (!provider_is_usable).then_some(CapabilityReason::ChainUnsynced);
                }
                CapabilityName::History | CapabilityName::BackgroundSync => {
                    if !history_present {
                        probe.not_ready_reason = Some(CapabilityReason::StorageUnavailable);
                    } else if !facts.history_probe_completed {
                        probe.not_ready_reason = Some(CapabilityReason::DependencyNotReady);
                    } else if name == CapabilityName::BackgroundSync
                        && !facts.background_sync_composed
                    {
                        probe.not_ready_reason = Some(CapabilityReason::HostDisabled);
                    } else {
                        probe.runtime_ready = provider_is_usable && facts.history_store_ready;
                        probe.not_ready_reason = if !provider_is_usable {
                            Some(CapabilityReason::ChainUnsynced)
                        } else {
                            (!facts.history_store_ready)
                                .then_some(CapabilityReason::StorageUnavailable)
                        };
                    }
                }
                _ if !facts.wallet_composed => {
                    probe.not_ready_reason = Some(CapabilityReason::DependencyNotReady);
                }
                _ if !facts.host_probe_completed => {
                    probe.available = false;
                    probe.not_ready_reason = Some(CapabilityReason::DependencyNotReady);
                }
                CapabilityName::WalletProfile => {
                    probe.runtime_ready = facts.wallet_store_ready;
                    probe.not_ready_reason =
                        (!facts.wallet_store_ready).then_some(CapabilityReason::StorageUnavailable);
                }
                CapabilityName::LocalSigning => {
                    probe.available = vault_device_available;
                    probe.runtime_ready = signing_ready;
                    probe.not_ready_reason = signing_reason;
                }
                CapabilityName::HardwareVault | CapabilityName::UserAuthentication => {
                    probe.available = vault_device_available;
                    probe.runtime_ready = vault_ready;
                    probe.not_ready_reason = vault_not_ready_reason;
                }
            }
            probe
        })
        .collect()
}

/// A stale status sample cannot keep chain capabilities open after provider
/// stop. Apart from the lifecycle gate, the provider's own `is_usable` field
/// is consumed verbatim; the ABI does not reinterpret peers or block heights.
#[cfg(feature = "chain")]
pub const fn provider_runtime_ready(
    lifecycle: ProviderLifecycle,
    provider_is_usable: bool,
) -> bool {
    matches!(lifecycle, ProviderLifecycle::Running) && provider_is_usable
}

pub fn snapshot_to_abi(snapshot: &CapabilitySnapshot) -> CitizenSdkCapabilitySnapshot {
    let mut output = CitizenSdkCapabilitySnapshot {
        revision: snapshot.revision(),
        ..CitizenSdkCapabilitySnapshot::default()
    };
    for (index, status) in snapshot.statuses().iter().enumerate() {
        if let Some(slot) = output.statuses.get_mut(index) {
            *slot = status_to_abi(status);
        }
    }
    output
}

pub fn lifecycle_to_abi(lifecycle: EngineLifecycle) -> CitizenSdkLifecycle {
    match lifecycle {
        EngineLifecycle::Created => CitizenSdkLifecycle::Created,
        EngineLifecycle::ImportingState => CitizenSdkLifecycle::ImportingState,
        EngineLifecycle::Starting => CitizenSdkLifecycle::Starting,
        EngineLifecycle::Running => CitizenSdkLifecycle::Running,
        EngineLifecycle::StartFailed => CitizenSdkLifecycle::StartFailed,
        EngineLifecycle::Stopped => CitizenSdkLifecycle::Stopped,
        EngineLifecycle::Disposed => CitizenSdkLifecycle::Disposed,
    }
}

pub fn require_snapshot(snapshot: Option<CapabilitySnapshot>) -> FfiResult<CapabilitySnapshot> {
    snapshot.ok_or_else(|| FfiError::internal("Engine capability snapshot is missing"))
}

fn status_to_abi(status: &CapabilityStatus) -> CitizenSdkCapabilityStatus {
    CitizenSdkCapabilityStatus {
        name: name_to_abi(status.name()) as u32,
        reason: status
            .reason()
            .map_or(CitizenSdkCapabilityReason::None, reason_to_abi) as u32,
        supported: u8::from(status.supported()),
        available: u8::from(status.available()),
        enabled: u8::from(status.enabled()),
        ready: u8::from(status.is_ready()),
        reserved: [0; 4],
    }
}

const fn name_to_abi(name: CapabilityName) -> CitizenSdkCapabilityName {
    match name {
        CapabilityName::ChainRead => CitizenSdkCapabilityName::ChainRead,
        CapabilityName::TransactionBuild => CitizenSdkCapabilityName::TransactionBuild,
        CapabilityName::TransactionSubmit => CitizenSdkCapabilityName::TransactionSubmit,
        CapabilityName::TransactionVerify => CitizenSdkCapabilityName::TransactionVerify,
        CapabilityName::WalletProfile => CitizenSdkCapabilityName::WalletProfile,
        CapabilityName::LocalSigning => CitizenSdkCapabilityName::LocalSigning,
        CapabilityName::HardwareVault => CitizenSdkCapabilityName::HardwareVault,
        CapabilityName::UserAuthentication => CitizenSdkCapabilityName::UserAuthentication,
        CapabilityName::History => CitizenSdkCapabilityName::History,
        CapabilityName::BackgroundSync => CitizenSdkCapabilityName::BackgroundSync,
    }
}

const fn reason_to_abi(reason: CapabilityReason) -> CitizenSdkCapabilityReason {
    match reason {
        CapabilityReason::BuildUnsupported => CitizenSdkCapabilityReason::BuildUnsupported,
        CapabilityReason::DeviceUnavailable => CitizenSdkCapabilityReason::DeviceUnavailable,
        CapabilityReason::HostDisabled => CitizenSdkCapabilityReason::HostDisabled,
        CapabilityReason::EngineNotRunning => CitizenSdkCapabilityReason::EngineNotRunning,
        CapabilityReason::DependencyNotReady => CitizenSdkCapabilityReason::DependencyNotReady,
        CapabilityReason::UserAuthenticationRequired => {
            CitizenSdkCapabilityReason::UserAuthenticationRequired
        }
        CapabilityReason::VaultLocked => CitizenSdkCapabilityReason::VaultLocked,
        CapabilityReason::ChainStarting => CitizenSdkCapabilityReason::ChainStarting,
        CapabilityReason::ChainUnsynced => CitizenSdkCapabilityReason::ChainUnsynced,
        CapabilityReason::StorageUnavailable => CitizenSdkCapabilityReason::StorageUnavailable,
    }
}

#[cfg(test)]
#[path = "../../tests/abi/capabilities.rs"]
mod tests;
