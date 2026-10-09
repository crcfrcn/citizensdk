use std::collections::{BTreeMap, BTreeSet};

use citizen_sdk_contracts::{
    CapabilityName, CapabilityReason, CapabilitySnapshot, CapabilityStatus,
};

use crate::error::EngineError;

/// Raw facts reported by the build, device, host configuration, and runtime
/// for one formal capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityProbe {
    pub name: CapabilityName,
    pub supported: bool,
    pub available: bool,
    pub enabled: bool,
    pub runtime_ready: bool,
    pub not_ready_reason: Option<CapabilityReason>,
}

/// Process-local owner of the monotonically increasing capability revision.
///
/// Bindings must not invent revisions independently. The tracker compares the
/// complete ten-capability semantics and advances exactly once only when that
/// semantic state changes. A rejected update leaves the last valid snapshot
/// untouched.
#[derive(Default)]
pub struct CapabilityTracker {
    current: Option<CapabilitySnapshot>,
}

impl CapabilityTracker {
    pub const fn new() -> Self {
        Self { current: None }
    }

    pub fn current(&self) -> Option<&CapabilitySnapshot> {
        self.current.as_ref()
    }

    pub fn update(
        &mut self,
        probes: Vec<CapabilityProbe>,
    ) -> Result<CapabilitySnapshot, EngineError> {
        let candidate = resolve_capabilities(0, probes)?;
        if let Some(current) = self.current.as_ref() {
            if current.statuses() == candidate.statuses() {
                return Ok(current.clone());
            }
        }
        let revision = match self.current.as_ref() {
            Some(current) => current.revision().checked_add(1).ok_or_else(|| {
                EngineError::CapabilityUnavailable(
                    "capability revision overflowed and cannot remain monotonic".to_owned(),
                )
            })?,
            None => 1,
        };
        let snapshot = CapabilitySnapshot::try_new(revision, candidate.statuses().to_vec())
            .map_err(EngineError::from)?;
        self.current = Some(snapshot.clone());
        Ok(snapshot)
    }
}

impl CapabilityProbe {
    pub const fn ready(name: CapabilityName) -> Self {
        Self {
            name,
            supported: true,
            available: true,
            enabled: true,
            runtime_ready: true,
            not_ready_reason: None,
        }
    }
}

/// Resolve an exact ten-capability snapshot and enforce dependency closure.
///
/// A host cannot make a dependent capability ready by setting a flag while a
/// prerequisite is unavailable. Discovery remains advisory; sensitive Engine
/// operations still recheck the corresponding capability at call time.
pub fn resolve_capabilities(
    revision: u64,
    probes: Vec<CapabilityProbe>,
) -> Result<CapabilitySnapshot, EngineError> {
    let names: BTreeSet<_> = probes.iter().map(|probe| probe.name).collect();
    let expected: BTreeSet<_> = CapabilityName::ALL.into_iter().collect();
    if probes.len() != CapabilityName::ALL.len() || names != expected {
        return Err(EngineError::CapabilityUnavailable(
            "capability probes must contain every formal capability exactly once".to_owned(),
        ));
    }
    let by_name: BTreeMap<_, _> = probes
        .into_iter()
        .map(|probe| (probe.name, probe))
        .collect();

    let mut statuses = Vec::with_capacity(CapabilityName::ALL.len());
    for name in CapabilityName::ALL {
        let Some(probe) = by_name.get(&name).copied() else {
            return Err(EngineError::CapabilityUnavailable(
                "capability probe disappeared during resolution".to_owned(),
            ));
        };
        let base_ready = probe.supported && probe.available && probe.enabled && probe.runtime_ready;
        let dependencies_ready = dependencies(name)
            .iter()
            .all(|dependency| is_ready(*dependency, &by_name, &mut BTreeSet::new()));
        let ready = base_ready && dependencies_ready;
        let reason = if ready {
            None
        } else if !probe.supported {
            Some(CapabilityReason::BuildUnsupported)
        } else if !probe.available {
            // available=false 也用于“宿主探测尚未完成”。探测器给出的准确原因
            // 优先于默认设备原因，避免把未知状态误报成实体设备故障。
            Some(
                probe
                    .not_ready_reason
                    .unwrap_or(CapabilityReason::DeviceUnavailable),
            )
        } else if !probe.enabled {
            Some(CapabilityReason::HostDisabled)
        } else if !probe.runtime_ready {
            Some(
                probe
                    .not_ready_reason
                    .unwrap_or(CapabilityReason::DependencyNotReady),
            )
        } else {
            Some(CapabilityReason::DependencyNotReady)
        };
        let status = CapabilityStatus::try_new(
            name,
            probe.supported,
            probe.available,
            probe.enabled,
            ready,
            reason,
        )
        .map_err(EngineError::from)?;
        statuses.push(status);
    }
    CapabilitySnapshot::try_new(revision, statuses).map_err(EngineError::from)
}

fn is_ready(
    name: CapabilityName,
    probes: &BTreeMap<CapabilityName, CapabilityProbe>,
    visiting: &mut BTreeSet<CapabilityName>,
) -> bool {
    if !visiting.insert(name) {
        return false;
    }
    let ready = probes.get(&name).is_some_and(|probe| {
        probe.supported
            && probe.available
            && probe.enabled
            && probe.runtime_ready
            && dependencies(name)
                .iter()
                .all(|dependency| is_ready(*dependency, probes, visiting))
    });
    visiting.remove(&name);
    ready
}

const fn dependencies(name: CapabilityName) -> &'static [CapabilityName] {
    use CapabilityName::{
        BackgroundSync, ChainRead, HardwareVault, History, LocalSigning, TransactionBuild,
        UserAuthentication, WalletProfile,
    };
    match name {
        CapabilityName::ChainRead | HardwareVault | UserAuthentication | WalletProfile => &[],
        TransactionBuild | CapabilityName::TransactionVerify => &[ChainRead],
        // A complete signed extrinsic can be submitted without wallet/build
        // capabilities. Provider readiness remains an independent probe.
        CapabilityName::TransactionSubmit => &[ChainRead],
        // 签名独立于钱包管理，但永远依赖真实设备金库与用户认证。
        LocalSigning => &[HardwareVault, UserAuthentication],
        History => &[ChainRead],
        BackgroundSync => &[ChainRead, History],
    }
}
