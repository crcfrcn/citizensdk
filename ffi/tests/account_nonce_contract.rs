//! smoldot `AccountNonceSource` 的公开生命周期与准确best接纳边界。
//! 块接纳与结果核验的行为回归分别由上游扩展和provider自身单元测试执行。

use crate::node::{SmoldotProviderConfig, SmoldotVerifiedChainClient};
use citizen_sdk_contracts::{
    AccountId32, AccountNonceSource, ContractErrorCode, FinalizedBlockRef, Hash32, VerifiedBlockRef,
};

const CHAIN_SPEC: &str = include_str!("../../chain/chainspec.json");

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
    let _source = std::sync::Arc::clone(&provider) as std::sync::Arc<dyn AccountNonceSource>;
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
