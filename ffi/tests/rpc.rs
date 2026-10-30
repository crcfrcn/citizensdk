use super::*;

#[test]
fn notification_filter_requires_exact_subscription() {
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "author_extrinsicUpdate",
        "params": {"subscription": "7", "result": {"inBlock": "0x00"}}
    });
    assert!(subscription_result(&notification, "7").is_some());
    assert!(subscription_result(&notification, "8").is_none());
}

#[test]
fn request_id_exhaustion_is_permanent_and_never_wraps_to_zero() {
    let next = AtomicU64::new(u64::MAX - 1);
    assert_eq!(reserve_request_number(&next).ok(), Some(u64::MAX - 1));
    assert_eq!(next.load(Ordering::Relaxed), u64::MAX);

    for _ in 0..2 {
        let Err(error) = reserve_request_number(&next) else {
            panic!("exhausted request id counter must remain fail closed");
        };
        assert_eq!(error.code(), ContractErrorCode::Internal);
        assert_eq!(next.load(Ordering::Relaxed), u64::MAX);
    }
}
