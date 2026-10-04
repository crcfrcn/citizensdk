// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]

use citizensdk::{
    citizensdk_get_capabilities, citizensdk_last_error_copy, CitizenSdkCapabilitySnapshot,
    CitizenSdkErrorCode,
};

#[test]
fn stable_error_code_and_thread_local_diagnostic_are_available() {
    let mut snapshot = CitizenSdkCapabilitySnapshot::default();
    // SAFETY: output structure is valid; handle 0 is intentionally invalid.
    let code = unsafe { citizensdk_get_capabilities(0, &mut snapshot) };
    assert_eq!(code, CitizenSdkErrorCode::InvalidHandle.as_i32());

    let mut required = 0_u64;
    // SAFETY: query mode uses a null buffer and valid required-length pointer.
    let query = unsafe { citizensdk_last_error_copy(std::ptr::null_mut(), 0, &mut required) };
    assert_eq!(query, CitizenSdkErrorCode::Ok.as_i32());
    assert!(required > 0);
    let mut buffer = vec![0_u8; required as usize];
    // SAFETY: the allocated buffer matches the required byte count.
    let copied = unsafe {
        citizensdk_last_error_copy(buffer.as_mut_ptr(), buffer.len() as u64, &mut required)
    };
    assert_eq!(copied, CitizenSdkErrorCode::Ok.as_i32());
    let text = String::from_utf8(buffer)
        .unwrap_or_else(|error| panic!("last error is not UTF-8: {error}"));
    assert!(text.contains("invalid"));
}
