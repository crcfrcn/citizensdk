// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]
// 此黑盒控制夹具组合 chain；无链查看回调反调和关闭排空在组合测试覆盖。
#![cfg(feature = "chain")]

use std::{
    ffi::c_void,
    sync::atomic::{AtomicI32, AtomicU64, Ordering},
    time::{Duration, Instant},
};

use citizensdk::{
    citizensdk_accept_request_sequence, citizensdk_create_with_modules, citizensdk_destroy, citizensdk_get_lifecycle,
    citizensdk_set_event_callback, CitizenSdkBytesView, CitizenSdkCreateOptions,
    CitizenSdkErrorCode, CitizenSdkEvent, CitizenSdkLifecycle, CITIZENSDK_ABI_VERSION,
};

const MANIFEST: &[u8] = include_bytes!("../../../chain/manifest.json");
const CHAIN_SPEC: &[u8] = include_bytes!("../../../chain/chainspec.json");
const LIGHT_STATE: &[u8] = include_bytes!("../../../chain/light_sync_state.json");
static HANDLE: AtomicU64 = AtomicU64::new(0);
static DESTROY_CODE: AtomicI32 = AtomicI32::new(-1);

unsafe extern "C" fn destroy_from_callback(_context: *mut c_void, _event: *const CitizenSdkEvent) {
    let handle = HANDLE.load(Ordering::SeqCst);
    if handle != 0 && DESTROY_CODE.load(Ordering::SeqCst) == -1 {
        // SAFETY: this intentionally exercises the ABI's callback preflight.
        let code = unsafe { citizensdk_destroy(handle) };
        DESTROY_CODE.store(code, Ordering::SeqCst);
    }
}

fn view(bytes: &[u8]) -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    }
}

fn options() -> CitizenSdkCreateOptions {
    CitizenSdkCreateOptions {
        struct_size: std::mem::size_of::<CitizenSdkCreateOptions>() as u32,
        abi_version: CITIZENSDK_ABI_VERSION,
        asset_manifest: view(MANIFEST),
        chain_spec: view(CHAIN_SPEC),
        light_sync_state: view(LIGHT_STATE),
        system_name: view(b"CitizenSDK-test"),
        system_version: view(b"1.0.0"),
    }
}

#[test]
fn channel_sequence_crosses_public_abi_without_creating_native_requests() {
    let mut handles = [0_u64; 2];
    for handle in &mut handles {
        // 只创建未启动的链实例；不使用用户状态、密钥或网络。
        assert_eq!(unsafe { citizensdk_create_with_modules(&options(), std::ptr::null(),
            citizen_sdk_contracts::Modules::CHAIN, handle) }, CitizenSdkErrorCode::Ok.as_i32());
    }
    for handle in handles {
        assert_eq!(citizensdk_accept_request_sequence(handle, 1), CitizenSdkErrorCode::Ok.as_i32());
        assert_eq!(citizensdk_accept_request_sequence(handle, 1), CitizenSdkErrorCode::Conflict.as_i32());
        assert_eq!(citizensdk_accept_request_sequence(handle, 3), CitizenSdkErrorCode::Conflict.as_i32());
        assert_eq!(citizensdk_accept_request_sequence(handle, 2), CitizenSdkErrorCode::Ok.as_i32());
        assert_eq!(unsafe { citizensdk_destroy(handle) }, CitizenSdkErrorCode::Ok.as_i32());
        assert_eq!(citizensdk_accept_request_sequence(handle, 3), CitizenSdkErrorCode::InvalidHandle.as_i32());
    }
    assert_eq!(citizensdk_accept_request_sequence(0, 1), CitizenSdkErrorCode::InvalidHandle.as_i32());
}

#[test]
fn destroy_from_callback_is_busy_before_any_lifecycle_side_effect() {
    let mut handle = 0;
    assert_eq!(
        unsafe {
            citizensdk_create_with_modules(
                &options(),
                std::ptr::null(),
                citizen_sdk_contracts::Modules::CHAIN,
                &mut handle,
            )
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    HANDLE.store(handle, Ordering::SeqCst);
    assert_eq!(
        unsafe {
            citizensdk_set_event_callback(handle, Some(destroy_from_callback), std::ptr::null_mut())
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while DESTROY_CODE.load(Ordering::SeqCst) == -1 {
        assert!(Instant::now() < deadline, "callback destroy timed out");
        std::thread::yield_now();
    }
    assert_eq!(
        DESTROY_CODE.load(Ordering::SeqCst),
        CitizenSdkErrorCode::Busy.as_i32()
    );
    let mut lifecycle = 0;
    assert_eq!(
        unsafe { citizensdk_get_lifecycle(handle, &mut lifecycle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(lifecycle, CitizenSdkLifecycle::Created as u32);
    assert_eq!(
        unsafe { citizensdk_set_event_callback(handle, None, std::ptr::null_mut()) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_destroy(handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
}
