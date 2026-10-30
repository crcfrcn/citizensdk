use super::{product_probes, ProductCapabilityFacts};
use citizen_sdk_contracts::{CapabilityName, CapabilityReason, Modules, VaultAvailability};
use citizen_sdk_engine::CapabilityTracker;

fn selected(bits: u32) -> Modules {
    Modules::try_new(bits).expect("有效模块组合")
}

#[cfg(all(feature = "chain", feature = "transactions"))]
#[test]
fn cold_transaction_build_does_not_depend_on_local_vault_or_wallet_probe() {
    // 构造仅绑定链状态/nonce；真正执行仍由冷热签名能力分别核验。
    for vault in [
        VaultAvailability::Unsupported,
        VaultAvailability::Unavailable,
        VaultAvailability::NoStrongUserAuthentication,
    ] {
        let mut facts = ProductCapabilityFacts::wallet_configured();
        facts.vault_availability = vault;
        for usable in [true, false] {
            let snapshot = CapabilityTracker::new()
                .update(product_probes(
                    usable,
                    facts,
                    selected(Modules::CHAIN | Modules::TRANSACTIONS),
                    false,
                ))
                .expect("只读构造能力快照");
            let build = snapshot.status(CapabilityName::TransactionBuild).unwrap();
            assert!(build.available());
            assert_eq!(build.is_ready(), usable);
            assert!(!snapshot
                .status(CapabilityName::LocalSigning)
                .unwrap()
                .enabled());
        }
    }
}

#[cfg(feature = "chain")]
#[test]
fn provider_is_usable_is_the_only_chain_readiness_input() {
    use crate::node::ProviderLifecycle;
    let mut tracker = CapabilityTracker::new();
    let modules = selected(Modules::CHAIN);
    for (lifecycle, is_usable, expected) in [
        (ProviderLifecycle::Running, false, false),
        (ProviderLifecycle::Running, true, true),
        (ProviderLifecycle::Stopped, true, false),
    ] {
        let snapshot = tracker
            .update(product_probes(
                super::provider_runtime_ready(lifecycle, is_usable),
                ProductCapabilityFacts::chain_only(),
                modules,
                false,
            ))
            .expect("链能力快照");
        assert_eq!(
            snapshot
                .status(CapabilityName::ChainRead)
                .unwrap()
                .is_ready(),
            expected
        );
        assert!(!snapshot
            .status(CapabilityName::TransactionSubmit)
            .unwrap()
            .enabled());
    }
}

#[cfg(feature = "wallet")]
#[test]
fn configured_wallet_is_supported_but_not_ready_before_host_probe() {
    let probes = product_probes(
        false,
        ProductCapabilityFacts::wallet_configured(),
        selected(Modules::WALLET),
        false,
    );
    let snapshot = CapabilityTracker::new()
        .update(probes)
        .expect("未探测钱包快照");
    let wallet = snapshot.status(CapabilityName::WalletProfile).unwrap();
    assert!(wallet.supported());
    assert!(!wallet.available());
    assert!(!wallet.is_ready());
    assert_eq!(wallet.reason(), Some(CapabilityReason::DependencyNotReady));
    assert!(!snapshot
        .status(CapabilityName::ChainRead)
        .unwrap()
        .enabled());
}

#[cfg(all(feature = "wallet", feature = "signing"))]
#[test]
fn wallet_and_signing_selection_are_independent() {
    let facts = ProductCapabilityFacts::wallet(
        VaultAvailability::Available,
        true,
        true,
        true,
        false,
        false,
    );
    for (bits, wallet_ready, signing_ready) in [
        (Modules::WALLET, true, false),
        (Modules::SIGNING, false, true),
        (Modules::WALLET | Modules::SIGNING, true, true),
    ] {
        let snapshot = CapabilityTracker::new()
            .update(product_probes(false, facts, selected(bits), false))
            .expect("独立本地模块快照");
        assert_eq!(
            snapshot
                .status(CapabilityName::WalletProfile)
                .unwrap()
                .is_ready(),
            wallet_ready
        );
        assert_eq!(
            snapshot
                .status(CapabilityName::LocalSigning)
                .unwrap()
                .is_ready(),
            signing_ready
        );
        assert!(!snapshot
            .status(CapabilityName::ChainRead)
            .unwrap()
            .enabled());
    }
}

#[cfg(feature = "signing")]
#[test]
fn signing_fails_closed_for_missing_device_security_or_account_storage() {
    let modules = selected(Modules::SIGNING);
    for (vault, secrets_ready, key_ready, expected) in [
        (
            VaultAvailability::NoStrongUserAuthentication,
            true,
            true,
            CapabilityReason::UserAuthenticationRequired,
        ),
        (
            VaultAvailability::Unavailable,
            true,
            true,
            CapabilityReason::DeviceUnavailable,
        ),
        (
            VaultAvailability::Available,
            false,
            true,
            CapabilityReason::StorageUnavailable,
        ),
        (
            VaultAvailability::Available,
            true,
            false,
            CapabilityReason::StorageUnavailable,
        ),
    ] {
        let facts =
            ProductCapabilityFacts::wallet(vault, true, secrets_ready, key_ready, false, false);
        let snapshot = CapabilityTracker::new()
            .update(product_probes(false, facts, modules, false))
            .expect("签名失败快照");
        let signing = snapshot.status(CapabilityName::LocalSigning).unwrap();
        assert!(!signing.is_ready());
        assert_eq!(signing.reason(), Some(expected));
    }
}

#[cfg(all(feature = "chain", feature = "history"))]
#[test]
fn history_is_independent_of_wallet_and_requires_real_storage_probe() {
    let modules = selected(Modules::CHAIN | Modules::HISTORY);
    for (facts, expected, reason) in [
        (
            ProductCapabilityFacts::chain_only(),
            false,
            Some(CapabilityReason::DependencyNotReady),
        ),
        (
            ProductCapabilityFacts::chain_only().with_history(false, false),
            false,
            Some(CapabilityReason::StorageUnavailable),
        ),
        (
            ProductCapabilityFacts::chain_only().with_history(true, false),
            true,
            None,
        ),
    ] {
        let snapshot = CapabilityTracker::new()
            .update(product_probes(true, facts, modules, true))
            .expect("历史独立快照");
        let history = snapshot.status(CapabilityName::History).unwrap();
        assert_eq!(history.is_ready(), expected);
        assert_eq!(history.reason(), reason);
        assert!(!snapshot
            .status(CapabilityName::WalletProfile)
            .unwrap()
            .enabled());
        assert!(!snapshot
            .status(CapabilityName::TransactionVerify)
            .unwrap()
            .enabled());
    }
}

#[test]
fn compile_support_and_host_selection_are_distinct_facts() {
    let snapshot = CapabilityTracker::new()
        .update(product_probes(
            false,
            ProductCapabilityFacts::chain_only(),
            selected(Modules::SIGNING),
            false,
        ))
        .expect("构建事实快照");
    for (name, compiled) in [
        (CapabilityName::WalletProfile, cfg!(feature = "wallet")),
        (CapabilityName::LocalSigning, cfg!(feature = "signing")),
        (CapabilityName::ChainRead, cfg!(feature = "chain")),
        (CapabilityName::History, cfg!(feature = "history")),
        (
            CapabilityName::TransactionSubmit,
            cfg!(feature = "transactions"),
        ),
    ] {
        let status = snapshot.status(name).unwrap();
        assert_eq!(status.supported(), compiled);
        if !compiled {
            assert_eq!(status.reason(), Some(CapabilityReason::BuildUnsupported));
        } else if name != CapabilityName::LocalSigning {
            assert!(!status.enabled());
            assert_eq!(status.reason(), Some(CapabilityReason::HostDisabled));
        }
    }
}
