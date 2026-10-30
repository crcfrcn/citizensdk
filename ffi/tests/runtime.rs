use std::{
    ffi::c_void,
    sync::{atomic::Ordering, mpsc, Arc, Barrier},
    time::{Duration, Instant},
};

use super::{CitizenSdkHandle, FfiResult, ProductComposition};
use crate::node::ProviderLifecycle;

use crate::{
    abi::{CitizenSdkErrorCode, CitizenSdkEvent, CitizenSdkEventType},
    ownership::{self, ResultHandleAllocator, ResultPayload},
    runtime::NativeRuntime,
};

/// 本地目录可跨链生命周期独占，普通请求仍拒绝，销毁仍等待所有请求。
#[test]
fn catalog_admission_is_independent_of_chain_exclusivity() {
    let runtime = NativeRuntime::new(
        700_001,
        crate::assets::verify_assets(
            include_bytes!("../../chain/manifest.json"),
            include_bytes!("../../chain/chainspec.json"),
            include_bytes!("../../chain/light_sync_state.json"),
        )
        .unwrap()
        .combined_chain_spec,
        "catalog-admission".into(),
        "1.0.0".into(),
    )
    .unwrap();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap();
    let (catalog, _) = runtime.begin_catalog_request().unwrap();
    let (lifecycle, _) = runtime.begin_exclusive_request().unwrap();
    assert!(runtime.begin_request(false).is_err());
    let (second, _) = runtime.begin_catalog_request().unwrap();
    runtime.request_cancel(second).unwrap();
    runtime.reject_request(second);
    runtime.reject_request(lifecycle);
    runtime.reject_request(catalog);
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap();
    runtime.shutdown().unwrap();
}

#[test]
fn lifecycle_waits_for_ordinary_result_commit_after_registry_removal() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap();
    let (request, _) = runtime.begin_request(false).unwrap();
    // 复现complete_request移除登记到finish_request_admission之间的真实窗口。
    let pending = runtime
        .cancellations
        .lock()
        .unwrap()
        .remove(&request)
        .unwrap();
    assert_eq!(
        runtime.begin_exclusive_request().err().unwrap().code,
        CitizenSdkErrorCode::Busy
    );
    runtime
        .cancellations
        .lock()
        .unwrap()
        .insert(request, pending);
    runtime.reject_request(request);
    let (lifecycle, _) = runtime.begin_exclusive_request().unwrap();
    runtime.reject_request(lifecycle);
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap();
    runtime.shutdown().unwrap();
}

#[test]
fn ordinary_requests_cannot_consume_catalog_completion_budget() {
    let runtime = NativeRuntime::new(
        700_002,
        crate::assets::verify_assets(
            include_bytes!("../../chain/manifest.json"),
            include_bytes!("../../chain/chainspec.json"),
            include_bytes!("../../chain/light_sync_state.json"),
        )
        .unwrap()
        .combined_chain_spec,
        "catalog-completion-budget".into(),
        "1.0.0".into(),
    )
    .unwrap();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap();
    let mut ordinary = Vec::new();
    loop {
        match runtime.begin_request(false) {
            Ok((id, _)) => {
                ordinary.push(id);
                assert!(ordinary.len() < 64);
            }
            Err(error) => {
                assert_eq!(error.code, CitizenSdkErrorCode::QueueFull);
                break;
            }
        }
    }
    let catalog: Vec<_> = (0..8)
        .map(|_| runtime.begin_catalog_request().unwrap().0)
        .collect();
    assert_eq!(
        runtime.begin_request(false).err().unwrap().code,
        CitizenSdkErrorCode::QueueFull
    );
    for id in catalog.into_iter().chain(ordinary) {
        runtime.reject_request(id);
    }
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap();
    runtime.shutdown().unwrap();
}

static EXHAUSTED_RESULT_HANDLES: ResultHandleAllocator = ResultHandleAllocator::new(u64::MAX);

unsafe extern "C" fn ignore_event(_context: *mut c_void, _event: *const CitizenSdkEvent) {}

unsafe extern "C" fn record_event(context: *mut c_void, event: *const CitizenSdkEvent) {
    // SAFETY: tests keep the sender and event callback registration alive.
    let sender = unsafe { &*(context.cast::<mpsc::Sender<CitizenSdkEvent>>()) };
    let event = unsafe { *event };
    let _ = sender.send(event);
}

struct ReentrantRequestContext {
    runtime: Arc<NativeRuntime>,
    sender: mpsc::Sender<(u64, Result<u64, CitizenSdkErrorCode>)>,
}

unsafe extern "C" fn accept_request_from_completion(
    context: *mut c_void,
    event: *const CitizenSdkEvent,
) {
    // SAFETY: the test keeps this context and callback registration alive
    // until the callback is cleared and every delivered result is released.
    let context = unsafe { &*(context.cast::<ReentrantRequestContext>()) };
    // SAFETY: the dispatcher lends a valid event only for this callback.
    let event = unsafe { &*event };
    if event.event_type != CitizenSdkEventType::RequestCompleted as u32 {
        return;
    }
    let accepted = context
        .runtime
        .begin_request(false)
        .map(|(request_id, _)| request_id)
        .map_err(|error| error.code);
    let _ = context.sender.send((event.result, accepted));
}

fn runtime() -> std::sync::Arc<NativeRuntime> {
    let assets = crate::assets::verify_assets(
        include_bytes!("../../chain/manifest.json"),
        include_bytes!("../../chain/chainspec.json"),
        include_bytes!("../../chain/light_sync_state.json"),
    )
    .unwrap_or_else(|error| panic!("asset verification failed: {error:?}"));
    NativeRuntime::new(
        9001,
        assets.combined_chain_spec,
        "CitizenSDK-test".to_owned(),
        "1.0.0".to_owned(),
    )
    .unwrap_or_else(|error| panic!("runtime creation failed: {error:?}"))
}

#[test]
fn request_sequence_admission_is_per_instance_and_survives_parameter_rejection() {
    let first = runtime();
    let second = runtime();
    // 接纳只推进外壳序号；模拟之后的参数拒绝，不创建任何Core异步请求。
    first.accept_request_sequence(1).unwrap();
    assert_eq!(first.request_state.lock().unwrap().next_request, 1);
    first.accept_request_sequence(2).unwrap();
    second.accept_request_sequence(1).unwrap();
    for sequence in [0, i64::MAX as u64 + 1, u64::MAX] {
        assert_eq!(
            first.accept_request_sequence(sequence).unwrap_err().code,
            CitizenSdkErrorCode::InvalidArgument
        );
    }
    for sequence in [1, 2, 4] {
        assert_eq!(
            first.accept_request_sequence(sequence).unwrap_err().code,
            CitizenSdkErrorCode::Conflict
        );
    }
    first.accept_request_sequence(3).unwrap();
    second.accept_request_sequence(2).unwrap();
    assert_eq!(first.pending_requests.load(Ordering::SeqCst), 0);
    first.request_state.lock().unwrap().accepting = false;
    assert_eq!(
        first.accept_request_sequence(4).unwrap_err().code,
        CitizenSdkErrorCode::InvalidState
    );
    assert_eq!(first.request_state.lock().unwrap().next_request_sequence, 4);
}

#[test]
fn request_sequence_admission_is_atomic_and_never_wraps() {
    let runtime = runtime();
    let accepted = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let runtime = Arc::clone(&runtime);
                scope.spawn(move || {
                    runtime
                        .accept_request_sequence(1)
                        .map_err(|error| error.code)
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(accepted.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(accepted
        .iter()
        .filter_map(|result| result.as_ref().err())
        .all(|code| *code == CitizenSdkErrorCode::Conflict));
    runtime.request_state.lock().unwrap().next_request_sequence = i64::MAX as u64;
    assert_eq!(
        runtime
            .accept_request_sequence(i64::MAX as u64)
            .unwrap_err()
            .code,
        CitizenSdkErrorCode::Integrity
    );
    assert_eq!(
        runtime.request_state.lock().unwrap().next_request_sequence,
        i64::MAX as u64
    );
}

fn runtime_with_exhausted_result_handles() -> Arc<NativeRuntime> {
    let assets = crate::assets::verify_assets(
        include_bytes!("../../chain/manifest.json"),
        include_bytes!("../../chain/chainspec.json"),
        include_bytes!("../../chain/light_sync_state.json"),
    )
    .unwrap_or_else(|error| panic!("asset verification failed: {error:?}"));
    NativeRuntime::new_with_result_allocator(
        9002,
        assets.combined_chain_spec,
        "CitizenSDK-exhaustion-test".to_owned(),
        "1.0.0".to_owned(),
        &EXHAUSTED_RESULT_HANDLES,
    )
    .unwrap_or_else(|error| panic!("runtime creation failed: {error:?}"))
}

#[test]
fn receiver_revocation_reclaims_only_delivered_foreign_results() {
    let runtime = runtime();
    let native = ownership::insert(ownership::OwnedResult::success(
        runtime.handle,
        ResultPayload::Empty,
    ))
    .unwrap();
    let foreign = ownership::insert(ownership::OwnedResult::success(
        runtime.handle,
        ResultPayload::Empty,
    ))
    .unwrap();
    runtime.owned_results.fetch_add(2, Ordering::SeqCst);
    ownership::mark_foreign(foreign);
    runtime.detach_value_callback().unwrap();
    assert!(ownership::get(foreign).is_err());
    assert!(ownership::get(native).is_ok());
    assert_eq!(runtime.owned_results.load(Ordering::SeqCst), 1);
    runtime.detach_value_callback().unwrap();
    ownership::release(native).unwrap();
    runtime.result_released();
    assert_eq!(runtime.owned_results.load(Ordering::SeqCst), 0);
    runtime.shutdown().unwrap();
}

#[test]
fn retained_wallet_state_uses_existing_owner_allocator_and_shutdown_gate() {
    use crate::{error::FfiError, ownership::OwnedResult};
    let runtime = runtime();
    let snapshot = citizen_sdk_engine::WalletStateSnapshot::from_state(
        &citizen_sdk_contracts::WalletState::empty(),
    )
    .unwrap();
    let source = ownership::insert(OwnedResult::success(
        runtime.handle,
        ResultPayload::WalletState(Box::new(snapshot.clone())),
    ))
    .unwrap();
    let retained = runtime.retain_wallet_state(source).unwrap();
    assert_ne!(source, retained);
    ownership::release(source).unwrap();
    assert!(ownership::get(retained).is_ok());
    assert!(runtime.retain_wallet_state(source).is_err());
    assert_eq!(runtime.owned_results.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.shutdown().unwrap_err().code,
        CitizenSdkErrorCode::Busy
    );
    for wrong in [
        OwnedResult::success(
            runtime.handle + 1,
            ResultPayload::WalletState(Box::new(snapshot.clone())),
        ),
        OwnedResult::success(runtime.handle, ResultPayload::Empty),
        OwnedResult::failure(runtime.handle, FfiError::invalid("合成失败")),
    ] {
        let result = ownership::insert(wrong).unwrap();
        assert!(runtime.retain_wallet_state(result).is_err());
        ownership::release(result).unwrap();
        assert_eq!(runtime.owned_results.load(Ordering::SeqCst), 1);
    }
    runtime.request_state.lock().unwrap().accepting = false;
    assert!(runtime.retain_wallet_state(retained).is_err());
    runtime.request_state.lock().unwrap().accepting = true;
    ownership::release(retained).unwrap();
    runtime.result_released();
    assert_eq!(runtime.owned_results.load(Ordering::SeqCst), 0);
}

#[test]
fn only_explicitly_cancellable_requests_accept_cancel() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

    let (atomic_id, atomic_receiver) = runtime
        .begin_request(false)
        .unwrap_or_else(|error| panic!("atomic request failed: {error:?}"));
    assert!(atomic_receiver.is_none());
    let atomic_flag = runtime.request_cancellation_flag(atomic_id).unwrap();
    let error = runtime
        .request_cancel(atomic_id)
        .err()
        .unwrap_or_else(|| panic!("atomic request cancellation must fail"));
    assert_eq!(error.code, CitizenSdkErrorCode::Unsupported);
    assert!(!atomic_flag.load(Ordering::Acquire));
    runtime.reject_request(atomic_id);

    let (watch_id, watch_receiver) = runtime
        .begin_request(true)
        .unwrap_or_else(|error| panic!("watch request failed: {error:?}"));
    let watch_flag = runtime.request_cancellation_flag(watch_id).unwrap();
    assert!(!watch_flag.load(Ordering::Acquire));
    runtime
        .request_cancel(watch_id)
        .unwrap_or_else(|error| panic!("watch cancellation failed: {error:?}"));
    assert!(watch_flag.load(Ordering::Acquire), "取消不依赖接收方轮询");
    let receiver = watch_receiver.unwrap_or_else(|| panic!("watch receiver is missing"));
    futures_executor::block_on(receiver)
        .unwrap_or_else(|error| panic!("watch cancellation signal failed: {error}"));
    runtime.reject_request(watch_id);

    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[cfg(feature = "qr")]
#[test]
fn qr_cancel_after_work_before_commit_suppresses_success_and_keeps_destroy_busy_until_release() {
    let runtime = runtime();
    let (sender, receiver) = mpsc::channel::<CitizenSdkEvent>();
    runtime
        .set_event_callback(
            Some(record_event),
            (&sender as *const mpsc::Sender<CitizenSdkEvent>)
                .cast_mut()
                .cast(),
        )
        .unwrap();
    for _ in 0..2 {
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    let (id, _cancellation) = runtime.begin_request(true).unwrap();
    assert_eq!(
        runtime.shutdown().unwrap_err().code,
        CitizenSdkErrorCode::Busy
    );
    runtime.request_cancel(id).unwrap();
    runtime.complete_request(id, Ok(ResultPayload::QrSigned("{\"kind\":2}".to_owned())));
    let event = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(event.request_id, id);
    let result = ownership::get(event.result).unwrap();
    assert_eq!(result.code, CitizenSdkErrorCode::Cancelled);
    assert!(matches!(result.payload, ResultPayload::Empty));
    assert_eq!(
        runtime.shutdown().unwrap_err().code,
        CitizenSdkErrorCode::Busy
    );
    ownership::release(event.result).unwrap();
    runtime.result_released();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match runtime.set_event_callback(None, std::ptr::null_mut()) {
            Ok(()) => break,
            Err(error) if error.code == CitizenSdkErrorCode::Busy && Instant::now() < deadline => {
                std::thread::yield_now()
            }
            Err(error) => panic!("callback drain failed: {error:?}"),
        }
    }
    runtime.shutdown().unwrap();
}

#[test]
fn exclusive_lifecycle_request_blocks_controls_and_destroy_across_a_barrier() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

    // 另一线程持有共享请求时独占预留必须失败；
    // 准确请求释放前，另一个共享预留仍按现行准入合同受理。
    let shared_enter = Arc::new(Barrier::new(2));
    let shared_release = Arc::new(Barrier::new(2));
    std::thread::scope(|scope| {
        let thread_runtime = Arc::clone(&runtime);
        let thread_enter = Arc::clone(&shared_enter);
        let thread_release = Arc::clone(&shared_release);
        let holder = scope.spawn(move || {
            let (request_id, _) = thread_runtime
                .begin_request(false)
                .unwrap_or_else(|error| panic!("shared admission failed: {error:?}"));
            thread_enter.wait();
            thread_release.wait();
            thread_runtime.reject_request(request_id);
        });

        shared_enter.wait();
        let exclusive = runtime
            .begin_exclusive_request()
            .err()
            .unwrap_or_else(|| panic!("shared request must block exclusive admission"));
        assert_eq!(exclusive.code, CitizenSdkErrorCode::Busy);
        let (second_shared, _) = runtime
            .begin_request(false)
            .unwrap_or_else(|error| panic!("shared admission regressed: {error:?}"));
        runtime.reject_request(second_shared);
        shared_release.wait();
        holder
            .join()
            .unwrap_or_else(|_| panic!("shared holder panicked"));
    });

    // Hold the exclusive lifecycle reservation on another thread. Every
    // later data request, control transition and destroy must see BUSY.
    let exclusive_enter = Arc::new(Barrier::new(2));
    let exclusive_release = Arc::new(Barrier::new(2));
    std::thread::scope(|scope| {
        let thread_runtime = Arc::clone(&runtime);
        let thread_enter = Arc::clone(&exclusive_enter);
        let thread_release = Arc::clone(&exclusive_release);
        let holder = scope.spawn(move || {
            let (request_id, _) = thread_runtime
                .begin_exclusive_request()
                .unwrap_or_else(|error| panic!("exclusive admission failed: {error:?}"));
            thread_enter.wait();
            thread_release.wait();
            thread_runtime.reject_request(request_id);
        });

        exclusive_enter.wait();
        let request = runtime
            .begin_request(false)
            .err()
            .unwrap_or_else(|| panic!("exclusive request must block later requests"));
        assert_eq!(request.code, CitizenSdkErrorCode::Busy);
        let second_exclusive = runtime
            .begin_exclusive_request()
            .err()
            .unwrap_or_else(|| panic!("exclusive request must block another exclusive"));
        assert_eq!(second_exclusive.code, CitizenSdkErrorCode::Busy);
        let callback = runtime
            .set_event_callback(Some(ignore_event), std::ptr::null_mut())
            .err()
            .unwrap_or_else(|| panic!("exclusive request must block callback changes"));
        assert_eq!(callback.code, CitizenSdkErrorCode::Busy);
        let subscribe = runtime
            .subscribe_capability_changes()
            .err()
            .unwrap_or_else(|| panic!("exclusive request must block subscription changes"));
        assert_eq!(subscribe.code, CitizenSdkErrorCode::Busy);
        let unsubscribe = runtime
            .stop_capability_subscription()
            .err()
            .unwrap_or_else(|| panic!("exclusive request must block external unsubscribe"));
        assert_eq!(unsubscribe.code, CitizenSdkErrorCode::Busy);
        let destroy = runtime
            .shutdown()
            .err()
            .unwrap_or_else(|| panic!("exclusive request must block destroy"));
        assert_eq!(destroy.code, CitizenSdkErrorCode::Busy);
        exclusive_release.wait();
        holder
            .join()
            .unwrap_or_else(|_| panic!("exclusive holder panicked"));
    });

    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn exclusive_stop_owner_can_unsubscribe_its_existing_monitor() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
    runtime
        .subscribe_capability_changes()
        .unwrap_or_else(|error| panic!("subscription failed: {error:?}"));

    let (request_id, _) = runtime
        .begin_exclusive_request()
        .unwrap_or_else(|error| panic!("exclusive admission failed: {error:?}"));
    let wrong_owner = runtime
        .stop_capability_subscription_for_exclusive_request(request_id + 1)
        .err()
        .unwrap_or_else(|| panic!("non-owner request id must not bypass exclusivity"));
    assert_eq!(wrong_owner.code, CitizenSdkErrorCode::Internal);
    let external = runtime
        .stop_capability_subscription()
        .err()
        .unwrap_or_else(|| panic!("external unsubscribe must not bypass exclusivity"));
    assert_eq!(external.code, CitizenSdkErrorCode::Busy);
    runtime
        .stop_capability_subscription_for_exclusive_request(request_id)
        .unwrap_or_else(|error| panic!("exclusive owner unsubscribe failed: {error:?}"));
    {
        let state = runtime
            .request_state
            .lock()
            .unwrap_or_else(|_| panic!("request state poisoned"));
        assert!(!state.capability_subscribed);
        assert_eq!(state.exclusive_request, Some(request_id));
    }
    assert!(runtime
        .capability_monitor
        .lock()
        .unwrap_or_else(|_| panic!("capability monitor state poisoned"))
        .is_none());
    runtime.reject_request(request_id);

    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn exclusive_completion_callback_can_immediately_accept_the_next_request() {
    let runtime = runtime();
    let (sender, receiver) = mpsc::channel();
    let context = ReentrantRequestContext {
        runtime: Arc::clone(&runtime),
        sender,
    };
    runtime
        .set_event_callback(
            Some(accept_request_from_completion),
            (&raw const context).cast_mut().cast(),
        )
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

    let (exclusive_request, _) = runtime
        .begin_exclusive_request()
        .unwrap_or_else(|error| panic!("exclusive admission failed: {error:?}"));
    runtime.complete_request(exclusive_request, Ok(ResultPayload::Empty));

    let (result, next_request) = receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("completion callback did not run: {error}"));
    let next_request = next_request
        .unwrap_or_else(|code| panic!("completion re-entry was rejected with {code:?}"));
    ownership::release(result)
        .unwrap_or_else(|error| panic!("exclusive result release failed: {error:?}"));
    runtime.result_released();
    runtime.reject_request(next_request);

    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn post_start_failure_stops_provider_and_marks_engine_one_way() {
    let runtime = runtime();
    runtime
        .engine()
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("Engine start reservation failed: {error}"));
    runtime
        .provider()
        .unwrap_or_else(|error| panic!("chain missing: {error:?}"))
        .drive(
            runtime
                .provider()
                .unwrap_or_else(|error| panic!("chain missing: {error:?}"))
                .start(),
        )
        .unwrap_or_else(|error| panic!("provider drive failed: {error}"))
        .unwrap_or_else(|error| panic!("provider start failed: {error}"));
    assert_eq!(
        runtime
            .provider()
            .unwrap_or_else(|error| panic!("chain missing: {error:?}"))
            .lifecycle()
            .unwrap_or_else(|error| panic!("provider lifecycle failed: {error}")),
        ProviderLifecycle::Running
    );

    runtime.converge_failed_start();

    assert_ne!(
        runtime
            .provider()
            .unwrap_or_else(|error| panic!("chain missing: {error:?}"))
            .lifecycle()
            .unwrap_or_else(|error| panic!("provider lifecycle failed: {error}")),
        ProviderLifecycle::Running
    );
    assert_eq!(
        runtime
            .engine()
            .lifecycle()
            .unwrap_or_else(|error| panic!("Engine lifecycle failed: {error}")),
        citizen_sdk_engine::EngineLifecycle::StartFailed
    );
    let snapshot = runtime
        .capability_snapshot()
        .unwrap_or_else(|error| panic!("capability snapshot failed: {error:?}"));
    assert!(!snapshot
        .status(citizen_sdk_contracts::CapabilityName::ChainRead)
        .is_some_and(|status| status.is_ready()));

    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn teardown_only_state_rejects_new_requests_callbacks_and_subscriptions() {
    let runtime = runtime();
    runtime
        .request_state
        .lock()
        .unwrap_or_else(|_| panic!("request state poisoned"))
        .accepting = false;

    let request_error = runtime
        .begin_request(false)
        .err()
        .unwrap_or_else(|| panic!("teardown-only request must fail"));
    assert_eq!(request_error.code, CitizenSdkErrorCode::InvalidState);
    let callback_error = runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .err()
        .unwrap_or_else(|| panic!("teardown-only callback change must fail"));
    assert_eq!(callback_error.code, CitizenSdkErrorCode::InvalidState);
    let subscribe_error = runtime
        .subscribe_capability_changes()
        .err()
        .unwrap_or_else(|| panic!("teardown-only subscription must fail"));
    assert_eq!(subscribe_error.code, CitizenSdkErrorCode::InvalidState);

    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("retry destroy failed: {error:?}"));
}

#[test]
fn callback_clear_and_request_acceptance_have_one_linear_order() {
    let runtime = runtime();
    for _ in 0..64 {
        runtime
            .set_event_callback(Some(ignore_event), std::ptr::null_mut())
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
        let barrier = Arc::new(Barrier::new(2));
        let (clear_result, begin_result) = std::thread::scope(|scope| {
            let clear_runtime = Arc::clone(&runtime);
            let clear_barrier = Arc::clone(&barrier);
            let clear = scope.spawn(move || {
                clear_barrier.wait();
                clear_runtime.set_event_callback(None, std::ptr::null_mut())
            });
            let begin_runtime = Arc::clone(&runtime);
            let begin_barrier = Arc::clone(&barrier);
            let begin = scope.spawn(move || {
                begin_barrier.wait();
                begin_runtime.begin_request(false)
            });
            (
                clear
                    .join()
                    .unwrap_or_else(|_| panic!("clear thread panicked")),
                begin
                    .join()
                    .unwrap_or_else(|_| panic!("begin thread panicked")),
            )
        });

        match (clear_result, begin_result) {
            (Ok(()), Err(error)) => assert!(matches!(
                error.code,
                CitizenSdkErrorCode::Busy | CitizenSdkErrorCode::InvalidState
            )),
            (Err(error), Ok((request_id, _))) => {
                assert_eq!(error.code, CitizenSdkErrorCode::Busy);
                runtime.reject_request(request_id);
                runtime
                    .set_event_callback(None, std::ptr::null_mut())
                    .unwrap_or_else(|error| panic!("callback cleanup failed: {error:?}"));
            }
            (Ok(()), Ok((request_id, _))) => {
                runtime.reject_request(request_id);
                panic!("callback clear and request acceptance both committed");
            }
            (Err(clear), Err(begin)) => panic!(
                "neither callback clear nor request acceptance committed: {clear:?}, {begin:?}"
            ),
        }
    }
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn every_control_transition_blocks_requests_controls_and_destroy() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

    for callback_transition in [true, false] {
        {
            let mut state = runtime
                .request_state
                .lock()
                .unwrap_or_else(|_| panic!("request state poisoned"));
            state.callback_transition = callback_transition;
            state.subscription_transition = !callback_transition;
        }
        let request = runtime
            .begin_request(false)
            .err()
            .unwrap_or_else(|| panic!("request must fail during transition"));
        assert_eq!(request.code, CitizenSdkErrorCode::Busy);
        let callback = runtime
            .set_event_callback(Some(ignore_event), std::ptr::null_mut())
            .err()
            .unwrap_or_else(|| panic!("callback control must fail during transition"));
        assert_eq!(callback.code, CitizenSdkErrorCode::Busy);
        let subscribe = runtime
            .subscribe_capability_changes()
            .err()
            .unwrap_or_else(|| panic!("subscribe must fail during transition"));
        assert_eq!(subscribe.code, CitizenSdkErrorCode::Busy);
        let destroy = runtime
            .shutdown()
            .err()
            .unwrap_or_else(|| panic!("destroy must fail during transition"));
        assert_eq!(destroy.code, CitizenSdkErrorCode::Busy);
    }
    {
        let mut state = runtime
            .request_state
            .lock()
            .unwrap_or_else(|_| panic!("request state poisoned"));
        state.callback_transition = false;
        state.subscription_transition = false;
    }
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn active_monitor_keeps_callback_registered_until_unsubscribe_commits() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
    runtime
        .subscribe_capability_changes()
        .unwrap_or_else(|error| panic!("subscription failed: {error:?}"));
    let clear = runtime
        .set_event_callback(None, std::ptr::null_mut())
        .err()
        .unwrap_or_else(|| panic!("active monitor must prevent callback clear"));
    assert_eq!(clear.code, CitizenSdkErrorCode::Busy);
    runtime
        .request_state
        .lock()
        .unwrap_or_else(|_| panic!("request state poisoned"))
        .accepting = false;
    let after_teardown_gate = runtime
        .stop_capability_subscription()
        .err()
        .unwrap_or_else(|| panic!("public unsubscribe must not commit after teardown gate"));
    assert_eq!(after_teardown_gate.code, CitizenSdkErrorCode::InvalidState);
    {
        let mut state = runtime
            .request_state
            .lock()
            .unwrap_or_else(|_| panic!("request state poisoned"));
        assert!(state.capability_subscribed);
        state.accepting = true;
    }
    runtime
        .stop_capability_subscription()
        .unwrap_or_else(|error| panic!("unsubscribe failed: {error:?}"));
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn event_sequence_exhaustion_rejects_before_acceptance_and_destroy_still_finishes() {
    let runtime = runtime();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
    runtime.dispatcher.exhaust_sequences_for_test();
    let error = runtime
        .begin_request(false)
        .err()
        .unwrap_or_else(|| panic!("exhausted completion sequence must reject acceptance"));
    assert_eq!(error.code, CitizenSdkErrorCode::Internal);
    assert_eq!(runtime.pending_requests.load(Ordering::SeqCst), 0);
    assert!(runtime
        .cancellations
        .lock()
        .unwrap_or_else(|_| panic!("pending requests poisoned"))
        .is_empty());
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn result_handle_exhaustion_rolls_back_event_capacity_before_rejecting() {
    let runtime = runtime_with_exhausted_result_handles();
    runtime
        .set_event_callback(Some(ignore_event), std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
    runtime.dispatcher.set_next_sequence_for_test(u64::MAX - 1);
    let error = runtime
        .begin_request(false)
        .err()
        .unwrap_or_else(|| panic!("exhausted result handle must reject acceptance"));
    assert_eq!(error.code, CitizenSdkErrorCode::Internal);
    assert_eq!(runtime.pending_requests.load(Ordering::SeqCst), 0);
    // The failed result reservation dropped its completion reservation, so
    // the final ordinary event sequence remains available.
    runtime
        .publish_lifecycle()
        .unwrap_or_else(|error| panic!("completion capacity leaked: {error:?}"));
    runtime
        .set_event_callback(None, std::ptr::null_mut())
        .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

#[test]
fn accepted_boundary_request_delivers_one_nonzero_result_and_can_destroy() {
    let runtime = runtime();
    let (event_tx, event_rx) = mpsc::channel::<CitizenSdkEvent>();
    runtime
        .set_event_callback(
            Some(record_event),
            (&event_tx as *const mpsc::Sender<CitizenSdkEvent>)
                .cast_mut()
                .cast(),
        )
        .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
    for _ in 0..2 {
        event_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("initial event not drained: {error}"));
    }
    runtime.dispatcher.set_next_sequence_for_test(u64::MAX - 1);
    let (request_id, _) = runtime
        .begin_request(false)
        .unwrap_or_else(|error| panic!("last request reservation failed: {error:?}"));
    assert!(runtime.publish_lifecycle().is_err());
    runtime.complete_request(request_id, Ok(ResultPayload::Empty));

    let completion = event_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap_or_else(|error| panic!("reserved completion not observed: {error}"));
    assert_eq!(
        completion.event_type,
        CitizenSdkEventType::RequestCompleted as u32
    );
    assert_eq!(completion.sequence, u64::MAX - 1);
    assert_eq!(completion.request_id, request_id);
    assert_ne!(completion.result, 0);
    ownership::release(completion.result)
        .unwrap_or_else(|error| panic!("result release failed: {error:?}"));
    runtime.result_released();

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match runtime.set_event_callback(None, std::ptr::null_mut()) {
            Ok(()) => break,
            Err(error) if error.code == CitizenSdkErrorCode::Busy && Instant::now() < deadline => {
                std::thread::yield_now();
            }
            Err(error) => panic!("callback clear failed: {error:?}"),
        }
    }
    runtime
        .shutdown()
        .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
}

// 合成原生实例和结果分配器只在此测试模块装配。
impl super::NativeRuntime {
    #[cfg(all(test, feature = "chain", feature = "transactions"))]
    pub fn new(
        handle: CitizenSdkHandle,
        combined_chain_spec: String,
        system_name: String,
        system_version: String,
    ) -> FfiResult<Arc<Self>> {
        Self::new_with_result_allocator(
            handle,
            combined_chain_spec,
            system_name,
            system_version,
            &ownership::RESULT_HANDLES,
        )
    }
    #[cfg(all(test, feature = "chain", feature = "transactions"))]
    fn new_with_result_allocator(
        handle: CitizenSdkHandle,
        combined_chain_spec: String,
        system_name: String,
        system_version: String,
        result_handles: &'static ResultHandleAllocator,
    ) -> FfiResult<Arc<Self>> {
        let composition =
            ProductComposition::public_abi(combined_chain_spec, system_name, system_version)?;
        Self::new_with_composition(handle, composition, result_handles)
    }
}
