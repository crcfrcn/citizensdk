//! 账户余额、准确 best Runtime nonce 与链上费率的强类型合同。

use std::future::Future;

use citizen_sdk_contracts::{
    citizen_ss58_address, AccountId32, AccountNonce, AccountNonceSource, ChainIdentity,
    ContractFuture, ContractResult, FinalizedAccountBalance, FinalizedBlockRef, Hash32,
    OnchainFeePolicy, SecretOwner, SecretRef, VaultGeneration, VerifiedBlockRef, WalletAccount,
    WalletOrigin, WalletProfile, PERBILL_DENOMINATOR,
};

fn value_or_panic<T>(result: ContractResult<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("合同调用失败: {error}"),
    }
}

fn wrong_identity() -> ChainIdentity {
    value_or_panic(ChainIdentity::try_new(
        "citizenchain",
        "citizenchain",
        Hash32::from_bytes([0xff; 32]),
    ))
}

#[test]
fn finalized_balance_keeps_exact_block_and_rejects_overflow_or_wrong_network() {
    let identity = ChainIdentity::citizenchain();
    let block = FinalizedBlockRef::from_parts(Hash32::from_bytes([1; 32]), 42);
    let account_id = AccountId32::from_bytes([2; 32]);
    let balance = value_or_panic(FinalizedAccountBalance::try_new(
        &identity, block, account_id, 700, 300,
    ));
    assert_eq!(balance.block(), block);
    assert_eq!(balance.account_id(), account_id);
    assert_eq!(balance.free_fen(), 700);
    assert_eq!(balance.reserved_fen(), 300);
    assert_eq!(balance.total_fen(), 1_000);

    assert!(FinalizedAccountBalance::try_new(&identity, block, account_id, u128::MAX, 1).is_err());
    assert!(FinalizedAccountBalance::try_new(&wrong_identity(), block, account_id, 1, 0,).is_err());
}

struct FakeNonceSource {
    identity: ChainIdentity,
}

impl AccountNonceSource for FakeNonceSource {
    fn account_next_index(
        &self,
        account_id: AccountId32,
        at_best: VerifiedBlockRef,
    ) -> ContractFuture<'_, AccountNonce> {
        let result = AccountNonce::try_new(&self.identity, at_best, account_id, 17);
        Box::pin(async move { result })
    }
}

#[test]
fn account_next_index_is_typed_and_bound_to_an_exact_best_block() {
    let identity = ChainIdentity::citizenchain();
    let best = VerifiedBlockRef::best(Hash32::from_bytes([3; 32]), 43);
    let finalized = VerifiedBlockRef::finalized(Hash32::from_bytes([4; 32]), 42);
    let account_id = AccountId32::from_bytes([5; 32]);
    let nonce = value_or_panic(AccountNonce::try_new(&identity, best, account_id, u64::MAX));
    assert_eq!(nonce.best_block(), best);
    assert_eq!(nonce.account_id(), account_id);
    assert_eq!(nonce.value(), u64::MAX);
    assert!(AccountNonce::try_new(&identity, finalized, account_id, 0).is_err());

    let source: Box<dyn AccountNonceSource> = Box::new(FakeNonceSource { identity });
    let future = source.account_next_index(account_id, best);
    let waker = std::task::Waker::noop();
    let mut context = std::task::Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    let nonce = match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(result) => value_or_panic(result),
        std::task::Poll::Pending => panic!("fake nonce source 不应 pending"),
    };
    assert_eq!(nonce.best_block(), best);
    assert_eq!(nonce.value(), 17);
}

#[test]
fn fee_policy_matches_runtime_rounding_and_has_explicit_overflow_paths() {
    let identity = ChainIdentity::citizenchain();
    let block = VerifiedBlockRef::best(Hash32::from_bytes([6; 32]), 44);
    let policy = value_or_panic(OnchainFeePolicy::try_new(&identity, block, 2_000_000, 10));
    assert_eq!(policy.block(), block);
    assert_eq!(policy.fee_rate_parts(), 2_000_000);
    assert_eq!(policy.minimum_fee_fen(), 10);
    assert_eq!(value_or_panic(policy.estimate(1)), 10);
    assert_eq!(value_or_panic(policy.estimate(5_250)), 11);
    assert_eq!(value_or_panic(policy.minimum_self_pay(90)), 100);

    let saturating = value_or_panic(OnchainFeePolicy::try_new(
        &identity,
        block,
        PERBILL_DENOMINATOR as u32,
        1,
    ));
    assert_eq!(value_or_panic(saturating.estimate(u128::MAX)), u128::MAX);
    assert!(saturating.minimum_self_pay(u128::MAX).is_err());
    assert!(OnchainFeePolicy::try_new(&identity, block, 0, 1).is_err());
    assert!(OnchainFeePolicy::try_new(&identity, block, 1_000_000_001, 1).is_err());
    assert!(OnchainFeePolicy::try_new(&identity, block, 1, 0).is_err());
    assert!(OnchainFeePolicy::try_new(&wrong_identity(), block, 1, 1).is_err());
    assert!(OnchainFeePolicy::try_new(
        &identity,
        VerifiedBlockRef::finalized(Hash32::from_bytes([7; 32]), 44),
        1,
        1,
    )
    .is_err());
}

fn wallet_account(index: u32, account_byte: u8, owner_byte: u8) -> WalletAccount {
    let account_id = AccountId32::from_bytes([account_byte; 32]);
    value_or_panic(WalletAccount::try_new(
        index,
        account_id,
        SecretRef::account_mini_secret(
            0,
            VaultGeneration::from_bytes([1; 16]),
            SecretOwner::from_bytes([owner_byte; 16]),
            account_id,
        ),
        citizen_ss58_address(account_id),
        format!("账户 {index}"),
        100 + u64::from(index),
    ))
}

#[test]
fn wallet_profile_rebuild_helpers_preserve_identity_and_delete_only_children() {
    let master = AccountId32::from_bytes([1; 32]);
    let child = AccountId32::from_bytes([2; 32]);
    let profile = value_or_panic(WalletProfile::try_new(
        0,
        VaultGeneration::from_bytes([1; 16]),
        master,
        WalletOrigin::Created,
        100,
        master,
        vec![wallet_account(0, 1, 3), wallet_account(2, 2, 4)],
    ));
    assert_eq!(
        profile.account_by_index(2).map(WalletAccount::account_id),
        Some(child)
    );

    let active = value_or_panic(profile.try_with_active_account(child));
    assert_eq!(active.active_account_id(), child);
    let renamed = value_or_panic(active.try_with_account_name(child, "  旅费账户  "));
    assert_eq!(
        renamed.account_by_id(child).map(WalletAccount::name),
        Some("旅费账户")
    );

    let (remaining, removed) = value_or_panic(renamed.try_without_child_account(child));
    assert_eq!(removed.account_id(), child);
    assert_eq!(remaining.active_account_id(), master);
    assert_eq!(remaining.accounts().len(), 1);
    assert!(remaining.try_without_child_account(master).is_err());
    assert!(remaining.try_with_account_name(master, " ").is_err());
    assert!(remaining
        .try_with_account_name(master, "中".repeat(31))
        .is_err());
    for control in ['\u{001c}', '\u{001f}', '\u{007f}', '\u{009f}'] {
        assert!(remaining
            .try_with_account_name(master, format!("账户{control}"))
            .is_err());
    }
}
