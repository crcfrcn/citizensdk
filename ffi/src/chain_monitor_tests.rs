//! SDK 后台事件合同；不分配结果句柄，不把版本字段借作历史 revision。
#![allow(unsafe_code, clippy::unwrap_used)]
use crate::{
    abi::{CitizenSdkEvent, CitizenSdkEventType},
    events::EventDispatcher,
};
use std::{
    ffi::c_void,
    sync::{mpsc, Weak},
    time::Duration,
};

unsafe extern "C" fn collect(context: *mut c_void, event: *const CitizenSdkEvent) {
    // SAFETY: test owns sender until dispatcher shutdown; ABI lends event during callback.
    let sender = unsafe { &*context.cast::<mpsc::Sender<CitizenSdkEvent>>() };
    let _ = sender.send(unsafe { *event });
}

#[test]
fn history_invalidation_has_zero_payload_and_ordered_sequence() {
    let dispatcher = EventDispatcher::new().unwrap();
    let (sender, receiver) = mpsc::channel::<CitizenSdkEvent>();
    dispatcher
        .set_callback(
            Some(collect),
            (&sender as *const mpsc::Sender<CitizenSdkEvent>)
                .cast_mut()
                .cast(),
        )
        .unwrap();
    for _ in 0..2 {
        dispatcher
            .send(CitizenSdkEventType::HistoryChanged, 0, 0, 0)
            .unwrap();
    }
    let first = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    let second = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(first.event_type, 5);
    assert_eq!(
        (
            first.request_id,
            first.result,
            first.capability_revision,
            first.reserved
        ),
        (0, 0, 0, 0)
    );
    assert!(second.sequence > first.sequence);
    dispatcher.shutdown().unwrap();
    assert!(dispatcher
        .send(CitizenSdkEventType::HistoryChanged, 0, 0, 0)
        .is_err());
}

#[test]
fn finalized_notification_owns_one_exact_block_result() {
    use crate::ownership::{self, OwnedResult, ResultPayload};
    use citizen_sdk_contracts::{Hash32, VerifiedBlockRef};

    let dispatcher = EventDispatcher::new().unwrap();
    let (sender, receiver) = mpsc::channel::<CitizenSdkEvent>();
    dispatcher
        .set_callback(
            Some(collect),
            (&sender as *const mpsc::Sender<CitizenSdkEvent>)
                .cast_mut()
                .cast(),
        )
        .unwrap();
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0x33; 32]), 44);
    let result = ownership::insert(OwnedResult::success(8, ResultPayload::Block(block))).unwrap();
    dispatcher
        .try_send(CitizenSdkEventType::FinalizedBlockChanged, 0, result, 0)
        .unwrap();
    let event = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(event.event_type, 6);
    assert_eq!(
        (event.request_id, event.result, event.capability_revision),
        (0, result, 0)
    );
    let owned = ownership::get(result).unwrap();
    assert!(matches!(owned.payload, ResultPayload::Block(value) if value == block));
    ownership::release(result).unwrap();
    dispatcher.shutdown().unwrap();
}

#[test]
fn worker_without_an_owner_stops_without_starting_a_provider() {
    crate::chain_monitor::ChainMonitor::start(Weak::new(), true)
        .unwrap()
        .stop()
        .unwrap();
}

#[test]
fn database_schedule_is_one_minute_and_retries_without_forgetting_success() {
    use crate::chain_monitor::DatabaseRefresh;
    use citizen_sdk_contracts::{FinalizedBlockRef, Hash32};
    let now = std::time::Instant::now();
    let mut schedule = DatabaseRefresh::new(now);
    assert!(!schedule.due(now + Duration::from_secs(59)));
    assert!(schedule.due(now + Duration::from_secs(60)));
    assert!(schedule.should_save(10, [1; 32]));
    schedule.attempted(now + Duration::from_secs(60));
    assert!(!schedule.due(now + Duration::from_secs(61)));
    // 未调用 saved 代表导出/写入失败，下一分钟必须允许重试同一块。
    assert!(schedule.due(now + Duration::from_secs(120)));
    assert!(schedule.should_save(10, [1; 32]));
    schedule.saved(FinalizedBlockRef::from_parts(
        Hash32::from_bytes([1; 32]),
        10,
    ));
    assert!(!schedule.should_save(10, [1; 32]));
    assert!(!schedule.should_save(9, [2; 32]));
    assert!(schedule.should_save(11, [2; 32]));
    // 同高度冲突交给 Engine 的强制身份校验拒绝，不清库、不覆盖成功标记。
    assert!(schedule.should_save(10, [2; 32]));
    assert!(!schedule.should_save(10, [1; 32]));
}

#[test]
fn finalized_resubscription_backoff_caps_at_thirty_seconds_and_success_resets_it() {
    use crate::chain_monitor::FinalizedRetry;
    let started = std::time::Instant::now();
    let mut retry = FinalizedRetry::new(started);
    assert!(retry.due(started));
    for (elapsed, expected_delay) in [(0, 2), (1, 4), (3, 8), (7, 16), (15, 30), (31, 30)] {
        let now = started + Duration::from_secs(elapsed);
        retry.failed(now);
        assert_eq!(retry.delay(), Duration::from_secs(expected_delay));
        assert!(!retry.due(now));
    }
    let recovered = started + Duration::from_secs(100);
    retry.succeeded(recovered);
    assert_eq!(retry.delay(), Duration::from_secs(1));
    assert!(retry.due(recovered));
}
