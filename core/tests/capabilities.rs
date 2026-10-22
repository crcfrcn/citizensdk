use citizen_sdk_contracts::{CapabilityName, CapabilityReason, CapabilitySnapshot};
use citizen_sdk_engine::{resolve_capabilities, CapabilityProbe, CapabilityTracker};

fn all_ready() -> Vec<CapabilityProbe> {
    CapabilityName::ALL
        .into_iter()
        .map(CapabilityProbe::ready)
        .collect()
}

fn probe_mut(probes: &mut [CapabilityProbe], name: CapabilityName) -> &mut CapabilityProbe {
    match probes.iter_mut().find(|probe| probe.name == name) {
        Some(probe) => probe,
        None => panic!("missing probe: {}", name.as_str()),
    }
}

#[test]
fn chain_read_failure_closes_chain_dependent_capabilities() {
    let mut probes = all_ready();
    let chain = probe_mut(&mut probes, CapabilityName::ChainRead);
    chain.runtime_ready = false;
    chain.not_ready_reason = Some(CapabilityReason::ChainUnsynced);

    let snapshot = match resolve_capabilities(7, probes) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("capability resolution failed: {error}"),
    };
    assert_eq!(snapshot.revision(), 7);
    assert_eq!(snapshot.statuses().len(), 10);
    assert_eq!(
        snapshot
            .status(CapabilityName::ChainRead)
            .and_then(|status| status.reason()),
        Some(CapabilityReason::ChainUnsynced)
    );
    for dependent in [
        CapabilityName::TransactionBuild,
        CapabilityName::TransactionSubmit,
        CapabilityName::TransactionVerify,
        CapabilityName::History,
        CapabilityName::BackgroundSync,
    ] {
        let status = match snapshot.status(dependent) {
            Some(status) => status,
            None => panic!("missing status: {}", dependent.as_str()),
        };
        assert!(!status.is_ready());
        assert_eq!(status.reason(), Some(CapabilityReason::DependencyNotReady));
    }
    assert!(snapshot
        .status(CapabilityName::WalletProfile)
        .is_some_and(|status| status.is_ready()));
}

#[test]
fn signing_requires_device_security_but_not_wallet_management() {
    let mut probes = all_ready();
    probe_mut(&mut probes, CapabilityName::TransactionBuild).enabled = false;
    probe_mut(&mut probes, CapabilityName::WalletProfile).enabled = false;
    probe_mut(&mut probes, CapabilityName::HardwareVault).supported = false;
    probe_mut(&mut probes, CapabilityName::UserAuthentication).supported = false;

    let snapshot = match resolve_capabilities(8, probes) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("capability resolution failed: {error}"),
    };
    assert!(snapshot
        .status(CapabilityName::TransactionSubmit)
        .is_some_and(|status| status.is_ready()));
    assert!(!snapshot
        .status(CapabilityName::LocalSigning)
        .is_some_and(|status| status.is_ready()));
    assert!(!snapshot
        .status(CapabilityName::HardwareVault)
        .is_some_and(|status| status.is_ready()));
}

#[test]
fn duplicate_or_missing_probes_fail_closed() {
    let mut probes = all_ready();
    let _ = probes.pop();
    assert!(resolve_capabilities(1, probes).is_err());

    let mut duplicate = all_ready();
    duplicate[9].name = CapabilityName::ChainRead;
    assert!(resolve_capabilities(2, duplicate).is_err());
}

#[test]
fn unavailable_probe_preserves_an_explicit_not_ready_reason() {
    let mut probes = all_ready();
    let wallet = probe_mut(&mut probes, CapabilityName::WalletProfile);
    wallet.available = false;
    wallet.runtime_ready = false;
    wallet.not_ready_reason = Some(CapabilityReason::DependencyNotReady);
    let snapshot = resolve_capabilities(9, probes)
        .unwrap_or_else(|error| panic!("capability resolution failed: {error}"));
    assert_eq!(
        snapshot
            .status(CapabilityName::WalletProfile)
            .and_then(|status| status.reason()),
        Some(CapabilityReason::DependencyNotReady)
    );
}

#[test]
fn tracker_advances_only_for_a_complete_semantic_change() {
    let mut tracker = CapabilityTracker::new();
    assert!(tracker.current().is_none());

    let first = match tracker.update(all_ready()) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("initial capability update failed: {error}"),
    };
    assert_eq!(first.revision(), 1);

    let unchanged = match tracker.update(all_ready()) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("unchanged capability update failed: {error}"),
    };
    assert_eq!(unchanged.revision(), 1);

    let mut changed = all_ready();
    let history = probe_mut(&mut changed, CapabilityName::History);
    history.runtime_ready = false;
    history.not_ready_reason = Some(CapabilityReason::StorageUnavailable);
    let second = match tracker.update(changed) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("changed capability update failed: {error}"),
    };
    assert_eq!(second.revision(), 2);
    assert_eq!(
        second
            .status(CapabilityName::History)
            .and_then(|status| status.reason()),
        Some(CapabilityReason::StorageUnavailable)
    );

    let mut invalid = all_ready();
    let _ = invalid.pop();
    assert!(tracker.update(invalid).is_err());
    assert_eq!(tracker.current().map(CapabilitySnapshot::revision), Some(2));
}

#[test]
fn disabling_wallet_management_does_not_disable_signing() {
    let mut probes = all_ready();
    probe_mut(&mut probes, CapabilityName::WalletProfile).enabled = false;
    let snapshot = resolve_capabilities(1, probes).expect("完整能力合同");
    assert!(snapshot
        .status(CapabilityName::LocalSigning)
        .unwrap()
        .is_ready());
}
