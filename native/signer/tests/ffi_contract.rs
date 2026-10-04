//! sr25519 公共原语的成功、篡改和空指针契约。

use std::ptr;

use citizen_signer::{
    citizen_sr25519_derive_hard, citizen_sr25519_public_key, citizen_sr25519_sign,
    citizen_sr25519_verify, CITIZEN_SIGNER_ERR_NULL_ARG, CITIZEN_SIGNER_ERR_VERIFY_FAILED,
    CITIZEN_SIGNER_OK,
};

#[test]
#[allow(unsafe_code)] // 测试目标就是以原始指针调用公开 C ABI；unsafe 只限于本函数。
fn signing_roundtrip_and_tampering_follow_the_contract() {
    let child = [9u8; 32];
    let message = b"citizensdk-sr25519-contract";
    let mut public = [0u8; 32];
    let mut signature = [0u8; 64];

    // SAFETY: 所有非空指针都来自本函数中定长、存活到调用结束的数组或字节串。
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
                public.as_ptr(),
                signature.as_ptr(),
                message.as_ptr(),
                message.len(),
            ),
            CITIZEN_SIGNER_OK
        );

        let tampered_message = b"citizensdk-sr25519-tampered";
        assert_eq!(
            citizen_sr25519_verify(
                public.as_ptr(),
                signature.as_ptr(),
                tampered_message.as_ptr(),
                tampered_message.len(),
            ),
            CITIZEN_SIGNER_ERR_VERIFY_FAILED
        );
    }
}

#[test]
#[allow(unsafe_code)] // 空指针失败契约只能通过 C ABI 的原始指针边界验证。
fn empty_message_is_valid_but_null_required_arguments_are_rejected() {
    let child = [5u8; 32];
    let chain_code = [2u8; 32];
    let mut derived = [0u8; 32];
    let mut public = [0u8; 32];
    let mut signature = [0u8; 64];

    // SAFETY: 非空指针均指向存活的定长缓冲区；空指针是本测试刻意传入的失败输入。
    unsafe {
        assert_eq!(
            citizen_sr25519_sign(child.as_ptr(), ptr::null(), 0, signature.as_mut_ptr(),),
            CITIZEN_SIGNER_OK
        );
        assert_eq!(
            citizen_sr25519_public_key(child.as_ptr(), public.as_mut_ptr()),
            CITIZEN_SIGNER_OK
        );
        assert_eq!(
            citizen_sr25519_verify(public.as_ptr(), signature.as_ptr(), ptr::null(), 0),
            CITIZEN_SIGNER_OK
        );
        assert_eq!(
            citizen_sr25519_derive_hard(ptr::null(), chain_code.as_ptr(), derived.as_mut_ptr(),),
            CITIZEN_SIGNER_ERR_NULL_ARG
        );
        assert_eq!(
            citizen_sr25519_derive_hard(child.as_ptr(), ptr::null(), derived.as_mut_ptr(),),
            CITIZEN_SIGNER_ERR_NULL_ARG
        );
        assert_eq!(
            citizen_sr25519_verify(public.as_ptr(), ptr::null(), ptr::null(), 0),
            CITIZEN_SIGNER_ERR_NULL_ARG
        );
    }
}
