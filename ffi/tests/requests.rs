use std::{
    ffi::c_void,
    sync::{mpsc, Arc, Condvar, Mutex},
    time::{Duration, Instant},
};

use super::{accept, accept_exclusive, accept_watch, WATCH_WORKER_COUNT};
use crate::{
    abi::{CitizenSdkEvent, CitizenSdkEventType},
    ownership::{self, ResultPayload},
    runtime::NativeRuntime,
};

unsafe extern "C" fn completion_callback(context: *mut c_void, event: *const CitizenSdkEvent) {
    // SAFETY: this test owns both pointers through runtime shutdown.
    let sender = unsafe { &*(context.cast::<mpsc::Sender<u64>>()) };
    let event = unsafe { &*event };
    if event.event_type == CitizenSdkEventType::RequestCompleted as u32 && event.result != 0 {
        let _ = sender.send(event.result);
    }
}

fn runtime() -> Arc<NativeRuntime> {
    let assets = crate::assets::verify_assets(
        include_bytes!("../../chain/manifest.json"),
        include_bytes!("../../chain/chainspec.json"),
        include_bytes!("../../chain/light_sync_state.json"),
    )
    .unwrap_or_else(|error| panic!("asset verification failed: {error:?}"));
    NativeRuntime::new(
        9011,
        assets.combined_chain_spec,
        "CitizenSDK-executor-test".to_owned(),
        "1.0.0".to_owned(),
    )
    .unwrap_or_else(|error| panic!("runtime creation failed: {error:?}"))
}

/// 真实调度边界：网络worker被占满时，本地读取仍能返回安全panic并继续服务。
#[test]
fn blocked_network_executor_cannot_starve_catalog_or_leak_panic_payload() {
    let runtime = runtime();
    let (results, received) = mpsc::channel();
    runtime
        .set_event_callback(
            Some(completion_callback),
            (&results as *const mpsc::Sender<u64>).cast_mut().cast(),
        )
        .unwrap();
    let blocked = super::start_executor(1, "citizensdk-test-network").unwrap();
    let (entered, wait_entered) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    super::accept_on(
        Arc::clone(&runtime),
        false,
        false,
        false,
        move |_, _, _| {
            entered.send(()).unwrap();
            gate.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(ResultPayload::Empty)
        },
        &blocked,
    )
    .unwrap();
    wait_entered.recv_timeout(Duration::from_secs(2)).unwrap();
    super::accept_catalog(Arc::clone(&runtime), |_, _, _| {
        super::mark_request_point(super::RequestPoint::LocalRead);
        panic!("synthetic private panic payload")
    })
    .unwrap();
    let result = received.recv_timeout(Duration::from_secs(2)).unwrap();
    let error = ownership::get(result).unwrap();
    assert_eq!(error.code, crate::abi::CitizenSdkErrorCode::Panic);
    assert_eq!(error.message, "CitizenSDK request panicked at LOCAL_READ");
    ownership::release(result).unwrap();
    runtime.result_released();
    super::accept_catalog(Arc::clone(&runtime), |_, _, _| Ok(ResultPayload::Empty)).unwrap();
    let result = received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        ownership::get(result).unwrap().code,
        crate::abi::CitizenSdkErrorCode::Ok
    );
    ownership::release(result).unwrap();
    runtime.result_released();
    release.send(()).unwrap();
    let result = received.recv_timeout(Duration::from_secs(2)).unwrap();
    ownership::release(result).unwrap();
    runtime.result_released();
    drop(blocked);
    let deadline = Instant::now() + Duration::from_secs(2);
    while runtime
        .set_event_callback(None, std::ptr::null_mut())
        .is_err()
    {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    runtime.shutdown().unwrap();
}

#[test]
fn saturated_watch_pool_never_starves_short_atomic_requests() {
    let runtime = runtime();
    let (result_tx, result_rx) = mpsc::channel();
    runtime
        .set_event_callback(
            Some(completion_callback),
            (&result_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
        )
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let (entered_tx, entered_rx) = mpsc::channel();
    for _ in 0..WATCH_WORKER_COUNT {
        let gate = Arc::clone(&gate);
        let entered = entered_tx.clone();
        accept_watch(Arc::clone(&runtime), move |_, _, _| {
            entered
                .send(())
                .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
            let mut released = gate
                .0
                .lock()
                .map_err(|_| crate::error::FfiError::internal("watch gate poisoned"))?;
            while !*released {
                released = gate
                    .1
                    .wait(released)
                    .map_err(|_| crate::error::FfiError::internal("watch gate poisoned"))?;
            }
            Ok(ResultPayload::Empty)
        })
        .unwrap_or_else(|error| panic!("watch acceptance failed: {error:?}"));
    }
    for _ in 0..WATCH_WORKER_COUNT {
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("watch worker did not enter: {error}"));
    }

    let (short_tx, short_rx) = mpsc::channel();
    accept(Arc::clone(&runtime), false, move |_, _, _| {
        short_tx
            .send(())
            .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
        Ok(ResultPayload::Empty)
    })
    .unwrap_or_else(|error| panic!("short request acceptance failed: {error:?}"));
    short_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("short request was starved by watches: {error}"));

    {
        let mut released = gate
            .0
            .lock()
            .unwrap_or_else(|_| panic!("watch gate poisoned"));
        *released = true;
        gate.1.notify_all();
    }

    for _ in 0..(WATCH_WORKER_COUNT + 1) {
        let result = result_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("completion result not observed: {error}"));
        ownership::release(result)
            .unwrap_or_else(|error| panic!("result release failed: {error:?}"));
        runtime.result_released();
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match runtime.set_event_callback(None, std::ptr::null_mut()) {
            Ok(()) => break,
            Err(error)
                if error.code == crate::abi::CitizenSdkErrorCode::Busy
                    && Instant::now() < deadline =>
            {
                std::thread::yield_now();
            }
            Err(error) => panic!("callback clear failed: {error:?}"),
        }
    }
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn executor_enforces_shared_then_exclusive_admission_barriers() {
    let runtime = runtime();
    let (result_tx, result_rx) = mpsc::channel();
    runtime
        .set_event_callback(
            Some(completion_callback),
            (&result_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
        )
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

    let (shared_entered_tx, shared_entered_rx) = mpsc::channel();
    let (shared_release_tx, shared_release_rx) = mpsc::channel();
    accept(Arc::clone(&runtime), false, move |_, _, _| {
        shared_entered_tx
            .send(())
            .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
        shared_release_rx
            .recv()
            .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
        Ok(ResultPayload::Empty)
    })
    .unwrap_or_else(|error| panic!("shared request acceptance failed: {error:?}"));
    shared_entered_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("shared worker did not enter: {error}"));

    // 无宿主仓储实例的生命周期调用使用同一共享准入，不占用独占槽。
    accept(Arc::clone(&runtime), false, |_, _, _| {
        Ok(ResultPayload::Empty)
    })
    .unwrap_or_else(|error| panic!("second shared request was rejected: {error:?}"));
    let shared_result = result_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("second shared result not observed: {error}"));
    ownership::release(shared_result)
        .unwrap_or_else(|error| panic!("shared result release failed: {error:?}"));
    runtime.result_released();

    let blocked_exclusive =
        accept_exclusive(Arc::clone(&runtime), |_, _, _| Ok(ResultPayload::Empty))
            .err()
            .unwrap_or_else(|| panic!("earlier shared request must block exclusive admission"));
    assert_eq!(
        blocked_exclusive.code,
        crate::abi::CitizenSdkErrorCode::Busy
    );
    shared_release_tx
        .send(())
        .unwrap_or_else(|error| panic!("shared worker release failed: {error}"));
    let first_result = result_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("first shared result not observed: {error}"));
    ownership::release(first_result)
        .unwrap_or_else(|error| panic!("shared result release failed: {error:?}"));
    runtime.result_released();

    let (exclusive_entered_tx, exclusive_entered_rx) = mpsc::channel();
    let (exclusive_release_tx, exclusive_release_rx) = mpsc::channel();
    accept_exclusive(Arc::clone(&runtime), move |_, _, _| {
        exclusive_entered_tx
            .send(())
            .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
        exclusive_release_rx
            .recv()
            .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
        Ok(ResultPayload::Empty)
    })
    .unwrap_or_else(|error| panic!("exclusive request acceptance failed: {error:?}"));
    exclusive_entered_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("exclusive worker did not enter: {error}"));
    let blocked_shared = accept(Arc::clone(&runtime), false, |_, _, _| {
        Ok(ResultPayload::Empty)
    })
    .err()
    .unwrap_or_else(|| panic!("exclusive request must block later shared admission"));
    assert_eq!(blocked_shared.code, crate::abi::CitizenSdkErrorCode::Busy);
    exclusive_release_tx
        .send(())
        .unwrap_or_else(|error| panic!("exclusive worker release failed: {error}"));
    let exclusive_result = result_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("exclusive result not observed: {error}"));
    ownership::release(exclusive_result)
        .unwrap_or_else(|error| panic!("exclusive result release failed: {error:?}"));
    runtime.result_released();

    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}
