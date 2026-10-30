use std::sync::atomic::Ordering;

use super::get;
use super::insert;
use super::release;
use super::reserve_with;
use super::OwnedResult;
use super::ResultHandleAllocator;
use super::ResultPayload;

#[test]
fn release_is_exactly_once_and_handles_are_not_reused() {
    let first = insert(OwnedResult::success(1, ResultPayload::Empty))
        .unwrap_or_else(|error| panic!("insert failed: {error:?}"));
    let second = insert(OwnedResult::success(1, ResultPayload::Empty))
        .unwrap_or_else(|error| panic!("insert failed: {error:?}"));
    assert_ne!(first, second);
    assert!(get(first).is_ok());
    assert!(release(first).is_ok());
    assert!(release(first).is_err());
    assert!(release(second).is_ok());
}

#[test]
fn exhaustion_is_reported_before_a_result_slot_is_reserved() {
    let allocator = ResultHandleAllocator::new(u64::MAX);
    for _ in 0..2 {
        let error = reserve_with(77, &allocator)
            .err()
            .unwrap_or_else(|| panic!("exhausted result handle must fail"));
        assert_eq!(error.code, crate::abi::types::CitizenSdkErrorCode::Internal);
        assert_eq!(allocator.next.load(Ordering::SeqCst), u64::MAX);
    }
}

#[test]
fn dropped_reservation_removes_placeholder_without_reusing_handle() {
    let allocator = ResultHandleAllocator::new(u64::MAX - 1);
    let reservation = reserve_with(88, &allocator)
        .unwrap_or_else(|error| panic!("last reservation failed: {error:?}"));
    let handle = reservation.handle;
    assert!(get(handle).is_err());
    drop(reservation);
    assert!(get(handle).is_err());
    assert_eq!(allocator.next.load(Ordering::SeqCst), u64::MAX);
    assert!(reserve_with(88, &allocator).is_err());
}
