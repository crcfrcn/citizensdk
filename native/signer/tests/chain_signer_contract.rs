//! 真实 `ChainSigner` 的秘密边界、Substrate context 与错误分类合同。

use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

use citizen_sdk_contracts::{
    ChainSigner, ContractErrorCode, ContractResult, DerivationJunction, SecretBuffer,
    SR25519_SIGNING_CONTEXT,
};
use citizen_signer::Sr25519SoftwareSigner;
use schnorrkel::{signing_context, PublicKey, Signature};

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn value_or_panic<T>(result: ContractResult<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("签名合同调用失败: {error}"),
    }
}

#[test]
fn software_signer_uses_substrate_context_and_never_accepts_an_injected_context() {
    assert_eq!(SR25519_SIGNING_CONTEXT, b"substrate");
    let signer: Box<dyn ChainSigner> = Box::new(Sr25519SoftwareSigner);
    let secret = value_or_panic(SecretBuffer::try_new(vec![9; 32]));
    let message = b"citizensdk-chain-signer".to_vec();

    let public = value_or_panic(block_on(signer.public_key(&secret)));
    let signature = value_or_panic(block_on(signer.sign(&secret, message.clone())));
    assert!(value_or_panic(block_on(signer.verify(
        public,
        message.clone(),
        signature,
    ))));

    let raw_public = match PublicKey::from_bytes(public.as_bytes()) {
        Ok(value) => value,
        Err(error) => panic!("signer 产生了无效公钥: {error}"),
    };
    let raw_signature = match Signature::from_bytes(signature.as_bytes()) {
        Ok(value) => value,
        Err(error) => panic!("signer 产生了无效签名: {error}"),
    };
    assert!(raw_public
        .verify(
            signing_context(b"substrate").bytes(&message),
            &raw_signature,
        )
        .is_ok());
    assert!(raw_public
        .verify(
            signing_context(b"not-substrate").bytes(&message),
            &raw_signature,
        )
        .is_err());
}

#[test]
fn hard_derivation_returns_a_secret_buffer_and_is_deterministic() {
    let signer = Sr25519SoftwareSigner;
    let parent = value_or_panic(SecretBuffer::try_new(vec![7; 32]));
    let junction = DerivationJunction::from_chain_code([3; 32]);
    let first = value_or_panic(block_on(signer.derive_hard(&parent, junction)));
    let second = value_or_panic(block_on(signer.derive_hard(&parent, junction)));

    let first_bytes = first.with_secret(<[u8]>::to_vec);
    let second_bytes = second.with_secret(<[u8]>::to_vec);
    assert_eq!(first_bytes, second_bytes);
    assert_ne!(first_bytes, vec![7; 32]);
    assert_eq!(format!("{first:?}"), "SecretBuffer([REDACTED])");
}

#[test]
fn malformed_secret_length_is_a_typed_invalid_argument() {
    let signer = Sr25519SoftwareSigner;
    let malformed = value_or_panic(SecretBuffer::try_new(vec![5; 31]));

    let public_error = match block_on(signer.public_key(&malformed)) {
        Ok(_) => panic!("31 字节 secret 不得产生公钥"),
        Err(error) => error,
    };
    assert_eq!(public_error.code(), ContractErrorCode::InvalidArgument);
    assert_eq!(
        public_error.message(),
        "sr25519 secret 必须是有效的 32 字节 mini-secret"
    );

    let sign_error = match block_on(signer.sign(&malformed, b"payload".to_vec())) {
        Ok(_) => panic!("31 字节 secret 不得签名"),
        Err(error) => error,
    };
    assert_eq!(sign_error.code(), ContractErrorCode::InvalidArgument);

    let derive_error = match block_on(
        signer.derive_hard(&malformed, DerivationJunction::from_chain_code([2; 32])),
    ) {
        Ok(_) => panic!("31 字节 secret 不得派生"),
        Err(error) => error,
    };
    assert_eq!(derive_error.code(), ContractErrorCode::InvalidArgument);
}
