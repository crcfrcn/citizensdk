//! Product-independent immortal signing payload and signed-build contracts.

use citizen_sdk_contracts::{
    AccountId32, AccountNonce, ChainIdentity, ContractResult, Hash32, ImmortalSigningPayload,
    RuntimeContext, RuntimeVersion, SignedExtrinsic, SignedTransactionBuild, Sr25519PublicKey,
    Sr25519Signature, VerifiedBlockRef,
};

fn value_or_panic<T>(result: ContractResult<T>) -> T {
    result.unwrap_or_else(|error| panic!("合同调用失败: {error}"))
}

fn valid_payload() -> ImmortalSigningPayload {
    let identity = ChainIdentity::citizenchain();
    let best = VerifiedBlockRef::best(Hash32::from_bytes([7; 32]), 51);
    let account_id = AccountId32::from_bytes([8; 32]);
    let runtime = value_or_panic(RuntimeContext::try_new(
        best,
        RuntimeVersion::new(42, 7),
        vec![0x6d, 0x65, 0x74, 0x61],
    ));
    let nonce = value_or_panic(AccountNonce::try_new(&identity, best, account_id, 9));
    value_or_panic(ImmortalSigningPayload::try_new(
        &identity,
        &runtime,
        nonce,
        account_id,
        Sr25519PublicKey::from_bytes(account_id.into_bytes()),
        vec![4, 0],
        vec![0xaa, 0xbb],
    ))
}

#[test]
fn signing_payload_binds_account_nonce_runtime_and_genesis() {
    let payload = valid_payload();
    assert_eq!(payload.block().number(), 51);
    assert_eq!(payload.runtime_version().spec_version(), 42);
    assert_eq!(payload.runtime_version().transaction_version(), 7);
    assert_eq!(
        payload.genesis_hash(),
        ChainIdentity::citizenchain().genesis_hash()
    );
    assert_eq!(
        payload.signer_account_id(),
        AccountId32::from_bytes([8; 32])
    );
    assert_eq!(payload.signer_public_key().as_bytes(), &[8; 32]);
    assert_eq!(payload.nonce(), 9);
    assert_eq!(payload.call_data(), &[4, 0]);
    assert_eq!(payload.signing_message(), &[0xaa, 0xbb]);
}

#[test]
fn signing_payload_rejects_cross_block_cross_account_and_wrong_network() {
    let identity = ChainIdentity::citizenchain();
    let best = VerifiedBlockRef::best(Hash32::from_bytes([7; 32]), 51);
    let other_best = VerifiedBlockRef::best(Hash32::from_bytes([9; 32]), 52);
    let account_id = AccountId32::from_bytes([8; 32]);
    let runtime = value_or_panic(RuntimeContext::try_new(
        best,
        RuntimeVersion::new(42, 7),
        vec![1],
    ));
    let other_nonce = value_or_panic(AccountNonce::try_new(&identity, other_best, account_id, 0));
    assert!(ImmortalSigningPayload::try_new(
        &identity,
        &runtime,
        other_nonce,
        account_id,
        Sr25519PublicKey::from_bytes([8; 32]),
        vec![4, 0],
        vec![1],
    )
    .is_err());

    let nonce = value_or_panic(AccountNonce::try_new(&identity, best, account_id, 0));
    assert!(ImmortalSigningPayload::try_new(
        &identity,
        &runtime,
        nonce,
        account_id,
        Sr25519PublicKey::from_bytes([1; 32]),
        vec![4, 0],
        vec![1],
    )
    .is_err());

    let wrong = value_or_panic(ChainIdentity::try_new(
        "citizenchain",
        "citizenchain",
        Hash32::from_bytes([0; 32]),
    ));
    let nonce = value_or_panic(AccountNonce::try_new(&identity, best, account_id, 0));
    assert!(ImmortalSigningPayload::try_new(
        &wrong,
        &runtime,
        nonce,
        account_id,
        Sr25519PublicKey::from_bytes([8; 32]),
        vec![4, 0],
        vec![1],
    )
    .is_err());
}

#[test]
fn signed_build_exposes_only_public_trace_signature_and_extrinsic() {
    let build = SignedTransactionBuild::new(
        valid_payload(),
        Sr25519Signature::from_bytes([3; 64]),
        value_or_panic(SignedExtrinsic::try_new(vec![0x04, 0x84, 0x01])),
    );
    assert_eq!(build.payload().nonce(), 9);
    assert_eq!(build.signature().as_bytes(), &[3; 64]);
    assert_eq!(build.extrinsic().as_bytes(), &[0x04, 0x84, 0x01]);
}
