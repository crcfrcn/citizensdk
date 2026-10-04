//! smoldot `AccountNonceSource` 的生命周期、账户与单次快照边界。

use citizen_sdk_contracts::{
    AccountId32, AccountNonceSource, ContractErrorCode, FinalizedBlockRef, Hash32, VerifiedBlockRef,
};
use citizen_sdk_smoldot_provider::{SmoldotProviderConfig, SmoldotVerifiedChainClient};

const CHAIN_SPEC: &str = include_str!("../../../../chain/chainspec.json");

fn require_ok<T, E>(result: Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(_) => panic!("{context}"),
    }
}

fn require_err<T, E>(result: Result<T, E>, context: &str) -> E {
    match result {
        Err(error) => error,
        Ok(_) => panic!("{context}"),
    }
}

fn assert_nonce_source<T: AccountNonceSource>() {}

#[test]
fn concrete_provider_and_arc_projection_implement_nonce_contract() {
    assert_nonce_source::<SmoldotVerifiedChainClient>();
    let config = require_ok(
        SmoldotProviderConfig::try_new(CHAIN_SPEC, "CitizenSDK nonce test", "1.0.0"),
        "bundled chainspec must be valid",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(config),
        "provider runtime must construct",
    );
    let _source = provider.as_account_nonce_source();
}

#[test]
fn nonce_reads_require_running_lifecycle_and_a_best_anchor() {
    let config = require_ok(
        SmoldotProviderConfig::try_new(CHAIN_SPEC, "CitizenSDK nonce test", "1.0.0"),
        "bundled chainspec must be valid",
    );
    let provider = require_ok(
        SmoldotVerifiedChainClient::new(config),
        "provider runtime must construct",
    );
    let account = AccountId32::from_bytes([0x11; 32]);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x22; 32]), 9);
    let not_running = require_err(
        futures::executor::block_on(provider.account_next_index(account, best)),
        "created provider must not return nonce",
    );
    assert_eq!(not_running.code(), ContractErrorCode::NotReady);

    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x22; 32]), 9);
    let wrong_finality = require_err(
        futures::executor::block_on(provider.account_next_index(account, finalized.verified())),
        "finalized anchor must not be relabelled as best",
    );
    assert_eq!(wrong_finality.code(), ContractErrorCode::InvalidArgument);
}

#[test]
fn provider_consumes_one_identity_bearing_typed_nonce_snapshot() {
    let source = include_str!("../src/account_nonce.rs");
    assert_eq!(
        source
            .matches(".chain_account_next_index_snapshot(")
            .count(),
        1
    );
    assert!(!source.contains("get_best_head"));
    assert!(!source.contains("chain_status_snapshot"));
    assert!(source.contains("snapshot.account_id.as_slice() != account_id.as_bytes()"));
    assert!(source.contains("if observed != at_best"));

    let light_base = include_str!("../../pow/light-base/src/lib.rs");
    assert_eq!(
        light_base
            .matches("pub fn chain_account_next_index_snapshot(")
            .count(),
        1
    );
    assert!(light_base.contains("Ok(ChainAccountNonceSnapshot {"));
    assert!(light_base.contains("block_number,"));
    assert!(light_base.contains("block_hash,"));
    assert!(light_base.contains("snapshot.await.map(|snapshot| snapshot.nonce)"));
}
