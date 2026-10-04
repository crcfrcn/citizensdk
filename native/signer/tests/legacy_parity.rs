//! `ChainSigner` 与既有四个 FFI 原语的双向差分合同。

#![allow(unsafe_code)]

use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

use citizen_sdk_contracts::{
    ChainSigner, ContractResult, DerivationJunction, SecretBuffer, Sr25519Signature,
};
use citizen_signer::{
    citizen_sr25519_derive_hard, citizen_sr25519_public_key, citizen_sr25519_sign,
    citizen_sr25519_verify, Sr25519SoftwareSigner, CITIZEN_SIGNER_ERR_BAD_KEY,
    CITIZEN_SIGNER_ERR_BAD_SIGNATURE, CITIZEN_SIGNER_OK,
};

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
        Err(error) => panic!("签名差分调用失败: {error}"),
    }
}

#[test]
fn trait_and_legacy_ffi_share_derivation_and_public_key_bytes() {
    let signer = Sr25519SoftwareSigner;
    let parent_bytes = [7_u8; 32];
    let chain_code = [3_u8; 32];
    let parent = value_or_panic(SecretBuffer::try_new(parent_bytes.to_vec()));

    let trait_child = value_or_panic(block_on(
        signer.derive_hard(&parent, DerivationJunction::from_chain_code(chain_code)),
    ));
    let trait_child_bytes = trait_child.with_secret(|bytes| {
        let mut output = [0_u8; 32];
        output.copy_from_slice(bytes);
        output
    });
    let mut ffi_child = [0_u8; 32];
    let derive_status = unsafe {
        citizen_sr25519_derive_hard(
            parent_bytes.as_ptr(),
            chain_code.as_ptr(),
            ffi_child.as_mut_ptr(),
        )
    };
    assert_eq!(derive_status, CITIZEN_SIGNER_OK);
    assert_eq!(trait_child_bytes, ffi_child);

    let trait_public = value_or_panic(block_on(signer.public_key(&trait_child)));
    let mut ffi_public = [0_u8; 32];
    let public_status =
        unsafe { citizen_sr25519_public_key(ffi_child.as_ptr(), ffi_public.as_mut_ptr()) };
    assert_eq!(public_status, CITIZEN_SIGNER_OK);
    assert_eq!(trait_public.as_bytes(), &ffi_public);
}

#[test]
fn trait_and_legacy_ffi_verify_each_others_randomized_signatures() {
    let signer = Sr25519SoftwareSigner;
    let child_bytes = [9_u8; 32];
    let child = value_or_panic(SecretBuffer::try_new(child_bytes.to_vec()));
    let message = b"citizensdk-legacy-parity".to_vec();
    let public = value_or_panic(block_on(signer.public_key(&child)));

    let trait_signature = value_or_panic(block_on(signer.sign(&child, message.clone())));
    let ffi_verification = unsafe {
        citizen_sr25519_verify(
            public.as_bytes().as_ptr(),
            trait_signature.as_bytes().as_ptr(),
            message.as_ptr(),
            message.len(),
        )
    };
    assert_eq!(ffi_verification, CITIZEN_SIGNER_OK);

    let mut ffi_signature = [0_u8; 64];
    let ffi_signing = unsafe {
        citizen_sr25519_sign(
            child_bytes.as_ptr(),
            message.as_ptr(),
            message.len(),
            ffi_signature.as_mut_ptr(),
        )
    };
    assert_eq!(ffi_signing, CITIZEN_SIGNER_OK);
    assert!(value_or_panic(block_on(signer.verify(
        public,
        message.clone(),
        Sr25519Signature::from_bytes(ffi_signature),
    ))));

    assert!(!value_or_panic(block_on(signer.verify(
        public,
        b"tampered".to_vec(),
        Sr25519Signature::from_bytes(ffi_signature),
    ))));
}

#[test]
fn legacy_ffi_preserves_distinct_key_and_signature_format_errors() {
    let child = [9_u8; 32];
    let message = b"citizensdk-format-errors";
    let mut public = [0_u8; 32];
    let mut signature = [0_u8; 64];
    unsafe {
        assert_eq!(
            citizen_sr25519_public_key(child.as_ptr(), public.as_mut_ptr()),
            CITIZEN_SIGNER_OK
        );
        assert_eq!(
            citizen_sr25519_sign(
                child.as_ptr(),
                message.as_ptr(),
                message.len(),
                signature.as_mut_ptr(),
            ),
            CITIZEN_SIGNER_OK
        );

        assert_eq!(
            citizen_sr25519_verify(
                [0xff_u8; 32].as_ptr(),
                signature.as_ptr(),
                message.as_ptr(),
                message.len(),
            ),
            CITIZEN_SIGNER_ERR_BAD_KEY
        );
        assert_eq!(
            citizen_sr25519_verify(
                public.as_ptr(),
                [0xff_u8; 64].as_ptr(),
                message.as_ptr(),
                message.len(),
            ),
            CITIZEN_SIGNER_ERR_BAD_SIGNATURE
        );
    }
}
