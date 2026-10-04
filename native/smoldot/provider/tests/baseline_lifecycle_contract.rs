//! Offline lifecycle baseline through the existing public smoldot provider.
//!
//! No benchmark hook is added to production and `native/smoldot/pow/**` remains
//! read-only. Timings are descriptive samples, while lifecycle assertions are
//! stable release gates.

use std::{sync::Arc, time::Instant};

use citizen_sdk_contracts::{
    ChainIdentity, ExportedChainState, FinalizedBlockRef, Hash32, SignedExtrinsic,
    VerifiedChainClient, CITIZENCHAIN_GENESIS_HASH,
};
use citizen_sdk_smoldot_provider::{
    ProviderLifecycle, SmoldotProviderConfig, SmoldotVerifiedChainClient,
};
use futures::StreamExt;

const CHAIN_SPEC: &str = include_str!("../../../../chain/chainspec.json");
const LIGHT_SYNC_STATE: &str =
    include_str!("../../../../chain/light_sync_state.json");
const SAMPLE_ROUNDS: usize = 5;

fn offline_chain_spec() -> String {
    let mut spec: serde_json::Value = serde_json::from_str(CHAIN_SPEC).expect("baseline chainspec");
    spec["bootNodes"] = serde_json::json!([]);
    spec["lightSyncState"] = serde_json::from_str(LIGHT_SYNC_STATE).expect("baseline light state");
    spec.to_string()
}

fn provider() -> Arc<SmoldotVerifiedChainClient> {
    SmoldotVerifiedChainClient::new(
        SmoldotProviderConfig::try_new(
            offline_chain_spec(),
            "CitizenSDK offline baseline",
            "1.0.0",
        )
        .expect("baseline provider config"),
    )
    .expect("baseline provider")
}

#[test]
fn offline_start_export_stop_has_five_descriptive_samples() {
    let mut create_samples = Vec::with_capacity(SAMPLE_ROUNDS);
    let mut start_samples = Vec::with_capacity(SAMPLE_ROUNDS);
    let mut export_sizes = Vec::with_capacity(SAMPLE_ROUNDS);
    let mut stop_samples = Vec::with_capacity(SAMPLE_ROUNDS);

    for _ in 0..SAMPLE_ROUNDS {
        let started = Instant::now();
        let provider = provider();
        create_samples.push(started.elapsed().as_nanos());
        assert_eq!(
            provider.lifecycle().expect("created lifecycle"),
            ProviderLifecycle::Created
        );

        let started = Instant::now();
        provider
            .drive(provider.start())
            .expect("baseline executor")
            .expect("offline provider start");
        start_samples.push(started.elapsed().as_nanos());
        assert_eq!(
            provider.lifecycle().expect("running lifecycle"),
            ProviderLifecycle::Running
        );

        let state = provider
            .drive(provider.export_state())
            .expect("baseline export executor")
            .expect("baseline export");
        export_sizes.push(state.database().len());
        assert_eq!(state.identity(), &ChainIdentity::citizenchain());

        let started = Instant::now();
        provider.stop().expect("offline provider stop");
        stop_samples.push(started.elapsed().as_nanos());
        assert_eq!(
            provider.lifecycle().expect("stopped lifecycle"),
            ProviderLifecycle::Stopped
        );
    }

    println!(
        "sdk-baseline provider create_ns={create_samples:?} start_ns={start_samples:?} export_bytes={export_sizes:?} stop_ns={stop_samples:?}"
    );
}

#[test]
fn import_and_prestart_watch_keep_existing_fail_closed_lifecycle() {
    let provider = provider();
    let finalized = FinalizedBlockRef::from_parts(CITIZENCHAIN_GENESIS_HASH, 0);
    let state = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        1,
        finalized,
        br#"{"genesisHash":"citizenchain"}"#.to_vec(),
    )
    .expect("baseline imported state");
    let first = futures::executor::block_on(provider.import_state(state.clone()))
        .expect("baseline first import");
    let second = futures::executor::block_on(provider.import_state(state))
        .expect("baseline idempotent import");
    assert_eq!(first.finalized(), finalized);
    assert_eq!(second.finalized(), finalized);

    let extrinsic = SignedExtrinsic::try_new(vec![0x04, 0x84]).expect("baseline extrinsic");
    let mut watch = provider.watch_extrinsic(extrinsic);
    let first = futures::executor::block_on(watch.next());
    assert!(first.is_some_and(|result| result.is_err()));
    assert!(futures::executor::block_on(watch.next()).is_none());

    assert_eq!(
        provider.lifecycle().expect("created lifecycle"),
        ProviderLifecycle::Created
    );
    assert_eq!(
        ChainIdentity::citizenchain().genesis_hash(),
        Hash32::from_bytes(CITIZENCHAIN_GENESIS_HASH.into_bytes())
    );
}
