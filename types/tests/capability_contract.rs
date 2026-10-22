//! 能力名称闭集、完整快照和状态不变量。

use citizen_sdk_contracts::{
    CapabilityName, CapabilityReason, CapabilitySnapshot, CapabilityStatus,
};

fn ready_statuses() -> Vec<CapabilityStatus> {
    CapabilityName::ALL
        .into_iter()
        .map(CapabilityStatus::ready)
        .collect()
}

#[test]
fn capability_names_are_the_exact_public_contract() {
    let names: Vec<_> = CapabilityName::ALL
        .into_iter()
        .map(CapabilityName::as_str)
        .collect();
    assert_eq!(
        names,
        vec![
            "CHAIN_READ",
            "TRANSACTION_BUILD",
            "TRANSACTION_SUBMIT",
            "TRANSACTION_VERIFY",
            "WALLET_PROFILE",
            "LOCAL_SIGNING",
            "HARDWARE_VAULT",
            "USER_AUTHENTICATION",
            "HISTORY",
            "BACKGROUND_SYNC",
        ]
    );
}

#[test]
fn capability_snapshot_is_complete_unique_and_revisioned() {
    let snapshot = match CapabilitySnapshot::try_new(17, ready_statuses()) {
        Ok(value) => value,
        Err(error) => panic!("完整能力快照被拒绝: {error}"),
    };
    assert_eq!(snapshot.revision(), 17);
    assert_eq!(snapshot.statuses().len(), 10);
    assert!(snapshot
        .status(CapabilityName::TransactionVerify)
        .is_some_and(CapabilityStatus::is_ready));

    let mut missing = ready_statuses();
    assert!(missing.pop().is_some());
    assert!(CapabilitySnapshot::try_new(18, missing).is_err());

    let mut duplicate = ready_statuses();
    duplicate[9] = CapabilityStatus::ready(CapabilityName::ChainRead);
    assert!(CapabilitySnapshot::try_new(19, duplicate).is_err());
}

#[test]
fn ready_and_not_ready_states_cannot_be_ambiguous() {
    assert!(CapabilityStatus::try_new(
        CapabilityName::HardwareVault,
        true,
        true,
        true,
        true,
        Some(CapabilityReason::VaultLocked),
    )
    .is_err());
    assert!(CapabilityStatus::try_new(
        CapabilityName::HardwareVault,
        true,
        false,
        true,
        false,
        None,
    )
    .is_err());

    let unavailable = match CapabilityStatus::try_new(
        CapabilityName::HardwareVault,
        true,
        false,
        true,
        false,
        Some(CapabilityReason::DeviceUnavailable),
    ) {
        Ok(value) => value,
        Err(error) => panic!("合法的不可用能力被拒绝: {error}"),
    };
    assert!(!unavailable.is_ready());
    assert_eq!(
        unavailable.reason().map(CapabilityReason::as_str),
        Some("device_unavailable")
    );
    assert_eq!(
        CapabilityReason::EngineNotRunning.as_str(),
        "engine_not_running"
    );
}

#[test]
fn modules_validate_every_combination_and_reject_unknown_bits() {
    use citizen_sdk_contracts::Modules;
    assert_eq!(Modules::full().bits(), Modules::ALL);
    for bits in 0..=Modules::ALL {
        let valid = bits != 0
            && (bits & (Modules::TRANSACTIONS | Modules::HISTORY) == 0
                || bits & Modules::CHAIN != 0);
        assert_eq!(Modules::try_new(bits).is_ok(), valid, "modules={bits}");
    }
    assert!(Modules::try_new(Modules::ALL | 64).is_err());
    assert!(Modules::try_new(u32::MAX).is_err());
    let wallet = Modules::try_new(Modules::WALLET).expect("钱包可独立选择");
    assert!(wallet.contains(Modules::WALLET));
    assert!(!wallet.contains(Modules::WALLET | Modules::SIGNING));
    assert!(Modules::try_new(Modules::SIGNING).is_ok());
    assert!(Modules::try_new(Modules::QR).is_ok());
}
