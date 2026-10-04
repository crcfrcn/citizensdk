// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]
#![cfg(all(feature = "chain", feature = "transactions"))]

use std::{
    ffi::c_void,
    sync::atomic::{AtomicBool, AtomicI32, AtomicU64, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use citizensdk::{
    citizensdk_create, citizensdk_destroy, citizensdk_get_capabilities,
    citizensdk_set_event_callback, citizensdk_subscribe_capability_changes,
    citizensdk_unsubscribe_capability_changes, CitizenSdkBytesView, CitizenSdkCapabilityName,
    CitizenSdkCapabilityReason, CitizenSdkCapabilitySnapshot, CitizenSdkCreateOptions,
    CitizenSdkErrorCode, CitizenSdkEvent, CITIZENSDK_ABI_VERSION,
};

const MANIFEST: &[u8] = include_bytes!("../../../chain/manifest.json");
const CHAIN_SPEC: &[u8] = include_bytes!("../../../chain/chainspec.json");
const LIGHT_STATE: &[u8] = include_bytes!("../../../chain/light_sync_state.json");

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

unsafe extern "C" fn ignore_event(_context: *mut c_void, _event: *const CitizenSdkEvent) {}

static SUB_HANDLE: AtomicU64 = AtomicU64::new(0);
static SUB_ARMED: AtomicBool = AtomicBool::new(false);
static SUB_CODE: AtomicI32 = AtomicI32::new(-1);
static SUB_INITIAL_EVENTS: AtomicUsize = AtomicUsize::new(0);

static START_SUB_HANDLE: AtomicU64 = AtomicU64::new(0);
static START_SUB_ARMED: AtomicBool = AtomicBool::new(false);
static START_SUB_CODE: AtomicI32 = AtomicI32::new(-1);

unsafe extern "C" fn unsubscribe_from_callback(
    _context: *mut c_void,
    _event: *const CitizenSdkEvent,
) {
    SUB_INITIAL_EVENTS.fetch_add(1, Ordering::SeqCst);
    if SUB_ARMED.load(Ordering::SeqCst) && SUB_CODE.load(Ordering::SeqCst) == -1 {
        let handle = SUB_HANDLE.load(Ordering::SeqCst);
        // SAFETY: this intentionally tests the callback-thread deadlock preflight.
        let code = unsafe { citizensdk_unsubscribe_capability_changes(handle) };
        SUB_CODE.store(code, Ordering::SeqCst);
    }
}

unsafe extern "C" fn subscribe_from_callback(
    _context: *mut c_void,
    _event: *const CitizenSdkEvent,
) {
    if START_SUB_ARMED.load(Ordering::SeqCst) && START_SUB_CODE.load(Ordering::SeqCst) == -1 {
        let handle = START_SUB_HANDLE.load(Ordering::SeqCst);
        // SAFETY: this intentionally tests bounded-publication deadlock preflight.
        let code = unsafe { citizensdk_subscribe_capability_changes(handle) };
        START_SUB_CODE.store(code, Ordering::SeqCst);
    }
}

#[test]
fn snapshot_always_contains_ten_truthful_capabilities() {
    let mut handle = 0;
    // SAFETY: packaged inputs and output pointer are valid.
    assert_eq!(
        unsafe { citizensdk_create(&options(), &mut handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let mut snapshot = CitizenSdkCapabilitySnapshot::default();
    // SAFETY: versioned output and instance handle are valid.
    assert_eq!(
        unsafe { citizensdk_get_capabilities(handle, &mut snapshot) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(snapshot.count, 10);
    let names: Vec<_> = snapshot.statuses.iter().map(|value| value.name).collect();
    assert_eq!(names, (1_u32..=10).collect::<Vec<_>>());
    let chain = &snapshot.statuses[CitizenSdkCapabilityName::ChainRead as usize - 1];
    assert_eq!(chain.ready, 0);
    for (name, compiled) in [
        (
            CitizenSdkCapabilityName::TransactionBuild,
            cfg!(feature = "transactions"),
        ),
        (
            CitizenSdkCapabilityName::WalletProfile,
            cfg!(feature = "wallet"),
        ),
        (
            CitizenSdkCapabilityName::LocalSigning,
            cfg!(feature = "signing"),
        ),
        (
            CitizenSdkCapabilityName::HardwareVault,
            cfg!(feature = "wallet") || cfg!(feature = "signing"),
        ),
        (
            CitizenSdkCapabilityName::UserAuthentication,
            cfg!(feature = "wallet") || cfg!(feature = "signing"),
        ),
        (CitizenSdkCapabilityName::History, cfg!(feature = "history")),
        (
            CitizenSdkCapabilityName::BackgroundSync,
            cfg!(feature = "history"),
        ),
    ] {
        let status = &snapshot.statuses[name as usize - 1];
        // 纯链实例没有钱包/历史资源，不等于当前完整构建删掉了这些功能。
        assert_eq!(status.supported, u8::from(compiled));
        let selected = name == CitizenSdkCapabilityName::TransactionBuild;
        assert_eq!(status.enabled, u8::from(selected));
        assert_eq!(status.ready, 0);
        assert_eq!(
            status.reason,
            if compiled && selected {
                // 未启动的纯链实例没有同步事实；不再伪报缺少热钱包依赖。
                CitizenSdkCapabilityReason::ChainUnsynced
            } else if compiled {
                CitizenSdkCapabilityReason::HostDisabled
            } else {
                CitizenSdkCapabilityReason::BuildUnsupported
            } as u32
        );
    }

    // SAFETY: callback has no context and remains valid for the registration.
    assert_eq!(
        unsafe { citizensdk_set_event_callback(handle, Some(ignore_event), std::ptr::null_mut()) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    // SAFETY: registered callback receives the initial and later revisions.
    assert_eq!(
        unsafe { citizensdk_subscribe_capability_changes(handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_unsubscribe_capability_changes(handle) },
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

#[test]
fn unsubscribe_from_callback_is_rejected_before_monitor_join() {
    let mut handle = 0;
    assert_eq!(
        unsafe { citizensdk_create(&options(), &mut handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    SUB_HANDLE.store(handle, Ordering::SeqCst);
    SUB_ARMED.store(false, Ordering::SeqCst);
    SUB_CODE.store(-1, Ordering::SeqCst);
    SUB_INITIAL_EVENTS.store(0, Ordering::SeqCst);
    assert_eq!(
        unsafe {
            citizensdk_set_event_callback(
                handle,
                Some(unsubscribe_from_callback),
                std::ptr::null_mut(),
            )
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let initial_deadline = Instant::now() + Duration::from_secs(3);
    while SUB_INITIAL_EVENTS.load(Ordering::SeqCst) < 2 {
        assert!(
            Instant::now() < initial_deadline,
            "initial events timed out"
        );
        std::thread::yield_now();
    }
    SUB_ARMED.store(true, Ordering::SeqCst);
    assert_eq!(
        unsafe { citizensdk_subscribe_capability_changes(handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while SUB_CODE.load(Ordering::SeqCst) == -1 {
        assert!(Instant::now() < deadline, "unsubscribe callback timed out");
        std::thread::yield_now();
    }
    assert_eq!(
        SUB_CODE.load(Ordering::SeqCst),
        CitizenSdkErrorCode::Busy.as_i32()
    );
    SUB_ARMED.store(false, Ordering::SeqCst);
    assert_eq!(
        unsafe { citizensdk_unsubscribe_capability_changes(handle) },
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

#[test]
fn subscribe_from_callback_is_rejected_before_monitor_start() {
    let mut handle = 0;
    assert_eq!(
        unsafe { citizensdk_create(&options(), &mut handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    START_SUB_HANDLE.store(handle, Ordering::SeqCst);
    START_SUB_CODE.store(-1, Ordering::SeqCst);
    START_SUB_ARMED.store(true, Ordering::SeqCst);
    assert_eq!(
        unsafe {
            citizensdk_set_event_callback(
                handle,
                Some(subscribe_from_callback),
                std::ptr::null_mut(),
            )
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while START_SUB_CODE.load(Ordering::SeqCst) == -1 {
        assert!(Instant::now() < deadline, "subscribe callback timed out");
        std::thread::yield_now();
    }
    assert_eq!(
        START_SUB_CODE.load(Ordering::SeqCst),
        CitizenSdkErrorCode::Busy.as_i32()
    );

    // BUSY was a pure preflight: after the callback returns, the same
    // subscription still succeeds and can be cleanly joined.
    START_SUB_ARMED.store(false, Ordering::SeqCst);
    assert_eq!(
        unsafe { citizensdk_subscribe_capability_changes(handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_unsubscribe_capability_changes(handle) },
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
