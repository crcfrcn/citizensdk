// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]
// 此所有权用例使用真实 chain 读取；无链查看结果在组合测试单独覆盖。
#![cfg(feature = "chain")]

mod resources;
use citizensdk::{abi, store, types};
use std::ffi::c_void;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use citizensdk::abi::citizensdk_create;
use citizensdk::abi::citizensdk_destroy;
use citizensdk::abi::citizensdk_get_best_head;
use citizensdk::abi::citizensdk_result_release;
use citizensdk::abi::citizensdk_set_event_callback;
use citizensdk::abi::CitizenSdkBytesView;
use citizensdk::abi::CitizenSdkCreateOptions;
use citizensdk::abi::CitizenSdkErrorCode;
use citizensdk::abi::CitizenSdkEvent;
use citizensdk::abi::CitizenSdkEventType;
use citizensdk::abi::CITIZENSDK_ABI_VERSION;

const MANIFEST: &[u8] = include_bytes!("../../../chain/manifest.json");
const CHAIN_SPEC: &[u8] = include_bytes!("../../../chain/chainspec.json");
const LIGHT_STATE: &[u8] = include_bytes!("../../../chain/light_sync_state.json");
static RESULT: OnceLock<Mutex<Option<u64>>> = OnceLock::new();

unsafe extern "C" fn capture_result(_context: *mut c_void, event: *const CitizenSdkEvent) {
    if event.is_null() {
        return;
    }
    let event = unsafe { *event };
    if event.event_type == CitizenSdkEventType::RequestCompleted as u32 {
        if let Ok(mut result) = RESULT.get_or_init(|| Mutex::new(None)).lock() {
            *result = Some(event.result);
        }
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
fn owned_result_blocks_destroy_and_releases_exactly_once() {
    let resources = resources::Resources::new(citizensdk::types::Modules::CHAIN);
    let mut handle = 0;
    assert_eq!(
        unsafe {
            citizensdk_create(
                &options(),
                citizensdk::types::Modules::CHAIN,
                &resources.config(),
                &mut handle,
            )
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe {
            citizensdk_set_event_callback(handle, Some(capture_result), std::ptr::null_mut())
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let mut request = 0;
    assert_eq!(
        unsafe { citizensdk_get_best_head(handle, &mut request) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    let result = loop {
        if let Some(result) = RESULT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .ok()
            .and_then(|value| *value)
        {
            break result;
        }
        assert!(Instant::now() < deadline, "result event timed out");
        std::thread::yield_now();
    };
    assert_eq!(
        unsafe { citizensdk_destroy(handle) },
        CitizenSdkErrorCode::Busy.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_result_release(result) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_result_release(result) },
        CitizenSdkErrorCode::InvalidHandle.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_set_event_callback(handle, None, std::ptr::null_mut()) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_destroy(handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
}
