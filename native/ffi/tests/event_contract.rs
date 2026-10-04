// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]
// 本文件用链读取请求验证事件合同；无链事件/查看排空由内部组合运行测试覆盖。
#![cfg(feature = "chain")]

use std::{
    ffi::c_void,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use citizensdk::{
    citizensdk_create_with_modules, citizensdk_destroy, citizensdk_get_best_head,
    citizensdk_result_get_info, citizensdk_result_release, citizensdk_set_event_callback,
    CitizenSdkBytesView, CitizenSdkCreateOptions, CitizenSdkErrorCode, CitizenSdkEvent,
    CitizenSdkEventType, CitizenSdkResultInfo, CITIZENSDK_ABI_VERSION,
};

const MANIFEST: &[u8] = include_bytes!("../../../chain/manifest.json");
const CHAIN_SPEC: &[u8] = include_bytes!("../../../chain/chainspec.json");
const LIGHT_STATE: &[u8] = include_bytes!("../../../chain/light_sync_state.json");
static EVENTS: OnceLock<Mutex<Vec<CitizenSdkEvent>>> = OnceLock::new();

unsafe extern "C" fn record_event(_context: *mut c_void, event: *const CitizenSdkEvent) {
    if event.is_null() {
        return;
    }
    // SAFETY: ABI guarantees the event pointer for callback duration; copy is immediate.
    let event = unsafe { *event };
    if let Ok(mut events) = EVENTS.get_or_init(|| Mutex::new(Vec::new())).lock() {
        events.push(event);
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
fn every_accepted_request_has_one_completion_on_the_dispatch_thread() {
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
    assert_eq!(
        unsafe { citizensdk_set_event_callback(handle, Some(record_event), std::ptr::null_mut()) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let mut request = 0;
    assert_eq!(
        unsafe { citizensdk_get_best_head(handle, &mut request) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_ne!(request, 0);

    let deadline = Instant::now() + Duration::from_secs(3);
    let completion = loop {
        let found = EVENTS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .ok()
            .and_then(|events| {
                events
                    .iter()
                    .find(|event| {
                        event.event_type == CitizenSdkEventType::RequestCompleted as u32
                            && event.request_id == request
                    })
                    .copied()
            });
        if let Some(event) = found {
            break event;
        }
        assert!(Instant::now() < deadline, "completion event timed out");
        std::thread::yield_now();
    };
    assert_ne!(completion.result, 0);
    let mut info = CitizenSdkResultInfo::default();
    assert_eq!(
        unsafe { citizensdk_result_get_info(completion.result, &mut info) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(info.error_code, CitizenSdkErrorCode::NotReady.as_i32());
    std::thread::sleep(Duration::from_millis(20));
    let completions = EVENTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map(|events| {
            events
                .iter()
                .filter(|event| {
                    event.event_type == CitizenSdkEventType::RequestCompleted as u32
                        && event.request_id == request
                })
                .count()
        })
        .unwrap_or(0);
    assert_eq!(completions, 1);
    assert_eq!(
        unsafe { citizensdk_result_release(completion.result) },
        CitizenSdkErrorCode::Ok.as_i32()
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
