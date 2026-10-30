//! 真实 `同步签名算法` 的秘密边界、Substrate context 与错误分类合同。

#![forbid(unsafe_code)]

use citizensdk::types::ContractErrorCode;
use citizensdk::types::ContractResult;
use citizensdk::types::DerivationJunction;
use citizensdk::types::SecretBuffer;
use citizensdk::types::Sr25519PublicKey;
use citizensdk::types::Sr25519Signature;
use citizensdk::types::SR25519_SIGNING_CONTEXT;

use schnorrkel::signing_context;
use schnorrkel::PublicKey;
use schnorrkel::Signature;

fn value_or_panic<T>(result: ContractResult<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("签名合同调用失败: {error}"),
    }
}

#[test]
fn signing_uses_only_fixed_substrate_context() {
    assert_eq!(SR25519_SIGNING_CONTEXT, b"substrate");

    let secret = value_or_panic(SecretBuffer::try_new(vec![9; 32]));
    let message = b"citizensdk-chain-signer".to_vec();

    let public = value_or_panic(citizensdk::sign::public_key(&secret));
    let signature = value_or_panic(citizensdk::sign::sign(&secret, message.clone()));
    assert!(value_or_panic(citizensdk::sign::verify(
        public,
        message.clone(),
        signature,
    )));

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

    // 验签失败只返回false，不把篡改后的公开消息当成编码错误。
    assert!(!value_or_panic(citizensdk::sign::verify(
        public,
        b"tampered".to_vec(),
        signature,
    )));
    let other = value_or_panic(SecretBuffer::try_new(vec![5; 32]));
    let other_public = value_or_panic(citizensdk::sign::public_key(&other));
    assert!(!value_or_panic(citizensdk::sign::verify(
        other_public,
        message,
        signature,
    )));
}

#[test]
fn hard_derivation_returns_a_secret_buffer_and_is_deterministic() {
    let parent = value_or_panic(SecretBuffer::try_new(vec![7; 32]));
    let junction = DerivationJunction::from_chain_code([3; 32]);
    let first = value_or_panic(citizensdk::sign::derive_hard(&parent, junction));
    let second = value_or_panic(citizensdk::sign::derive_hard(&parent, junction));

    // 只比较受控借用，不在测试断言或失败日志中复制、展示派生秘密。
    assert!(first.with_secret(|left| second.with_secret(|right| left == right)));
    assert!(first.with_secret(|child| parent.with_secret(|root| child != root)));
    assert_eq!(first.with_secret(<[u8]>::len), 32);
    assert_eq!(format!("{first:?}"), "SecretBuffer([REDACTED])");
}

#[test]
fn malformed_secret_length_is_a_typed_invalid_argument() {
    let empty_error = match SecretBuffer::try_new(Vec::new()) {
        Ok(_) => panic!("空秘密不得进入签名接口"),
        Err(error) => error,
    };
    assert_eq!(empty_error.code(), ContractErrorCode::InvalidArgument);
    let malformed = value_or_panic(SecretBuffer::try_new(vec![5; 31]));

    let public_error = match citizensdk::sign::public_key(&malformed) {
        Ok(_) => panic!("31 字节 secret 不得产生公钥"),
        Err(error) => error,
    };
    assert_eq!(public_error.code(), ContractErrorCode::InvalidArgument);
    assert_eq!(
        public_error.message(),
        "sr25519 secret 必须是有效的 32 字节 mini-secret"
    );

    let sign_error = match citizensdk::sign::sign(&malformed, b"payload".to_vec()) {
        Ok(_) => panic!("31 字节 secret 不得签名"),
        Err(error) => error,
    };
    assert_eq!(sign_error.code(), ContractErrorCode::InvalidArgument);

    let derive_error = match citizensdk::sign::derive_hard(
        &malformed,
        DerivationJunction::from_chain_code([2; 32]),
    ) {
        Ok(_) => panic!("31 字节 secret 不得派生"),
        Err(error) => error,
    };
    assert_eq!(derive_error.code(), ContractErrorCode::InvalidArgument);
}

#[test]
fn empty_message_signing_and_verification_succeed() {
    let secret = value_or_panic(SecretBuffer::try_new(vec![5; 32]));
    let public = value_or_panic(citizensdk::sign::public_key(&secret));
    let signature = value_or_panic(citizensdk::sign::sign(&secret, Vec::new()));
    assert!(value_or_panic(citizensdk::sign::verify(
        public,
        Vec::new(),
        signature,
    )));
}

#[test]
fn malformed_public_key_and_signature_keep_distinct_typed_errors() {
    let secret = value_or_panic(SecretBuffer::try_new(vec![9; 32]));
    let message = b"citizensdk-format-errors".to_vec();
    let public = value_or_panic(citizensdk::sign::public_key(&secret));
    let signature = value_or_panic(citizensdk::sign::sign(&secret, message.clone()));

    let public_error = match citizensdk::sign::verify(
        Sr25519PublicKey::from_bytes([0xff; 32]),
        message.clone(),
        signature,
    ) {
        Ok(_) => panic!("畸形公钥必须报告格式错误"),
        Err(error) => error,
    };
    assert_eq!(public_error.code(), ContractErrorCode::InvalidArgument);
    assert_eq!(public_error.message(), "sr25519 公钥编码无效");

    let signature_error =
        match citizensdk::sign::verify(public, message, Sr25519Signature::from_bytes([0xff; 64])) {
            Ok(_) => panic!("畸形签名必须报告格式错误"),
            Err(error) => error,
        };
    assert_eq!(signature_error.code(), ContractErrorCode::InvalidArgument);
    assert_eq!(signature_error.message(), "sr25519 签名编码无效");
}
