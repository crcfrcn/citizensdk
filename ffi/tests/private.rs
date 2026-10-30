use super::*;

#[test]
fn cancellation_drains_pending_work_and_suppresses_its_late_success() {
    futures_executor::block_on(async {
        let (release, pending) = futures_channel::oneshot::channel::<()>();
        let (cancel, cancellation) = futures_channel::oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let completed = Arc::clone(&finished);
        let work = async move {
            let _ = pending.await;
            completed.store(true, Ordering::SeqCst);
            Ok(17_u32)
        };
        let mut operation = Box::pin(drain_cancel(work, cancellation, Arc::clone(&cancelled)));
        cancel.send(()).unwrap();
        assert!(futures_util::poll!(operation.as_mut()).is_pending());
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(!finished.load(Ordering::SeqCst));
        release.send(()).unwrap();
        assert_eq!(
            operation.await.unwrap_err().code,
            CitizenSdkErrorCode::Cancelled
        );
        assert!(finished.load(Ordering::SeqCst));
    });
}

#[test]
fn cancellation_before_work_is_visible_before_any_authentication() {
    futures_executor::block_on(async {
        let (cancel, cancellation) = futures_channel::oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let token = Arc::clone(&cancelled);
        cancel.send(()).unwrap();
        let work = async move {
            assert!(token.load(Ordering::SeqCst));
            Ok(())
        };
        assert_eq!(
            drain_cancel(work, cancellation, cancelled)
                .await
                .unwrap_err()
                .code,
            CitizenSdkErrorCode::Cancelled
        );
    });
}

#[test]
fn expiry_and_cancel_guards_never_accept_a_caller_clock() {
    let request = SignRequest {
        request_id: "0123456789abcdef".into(),
        expires_at: 1,
        action: 0x0400,
        signer_public_key: Some(Sr25519PublicKey::from_bytes([7; 32])),
        review_payload: vec![4, 0, 3],
    };
    assert!(
        matches!(ensure_current(&request, &AtomicBool::new(false)), Err(EngineError::Contract(error)) if error.code() == ContractErrorCode::Timeout)
    );
    assert_eq!(
        ensure_current(&request, &AtomicBool::new(true)),
        Err(EngineError::Cancelled)
    );
}

#[test]
fn review_claim_is_once_only_even_after_reparsing_and_is_bounded_per_owner() {
    let owner = u64::MAX - 901;
    let mut request = SignRequest {
        request_id: "0123456789abcdef".into(),
        expires_at: SystemQrClock.now_epoch_seconds() + 300,
        action: 0x0400,
        signer_public_key: Some(Sr25519PublicKey::from_bytes([7; 32])),
        review_payload: vec![4, 0, 3],
    };
    let claimed = AtomicBool::new(false);
    claim_signing_request(owner, &request, &claimed).unwrap();
    assert_eq!(
        claim_signing_request(owner, &request, &claimed)
            .unwrap_err()
            .code,
        CitizenSdkErrorCode::Conflict
    );
    let reparsed_claim = AtomicBool::new(false);
    assert_eq!(
        claim_signing_request(owner, &request, &reparsed_claim)
            .unwrap_err()
            .code,
        CitizenSdkErrorCode::Conflict
    );
    assert!(!reparsed_claim.load(Ordering::SeqCst));
    for id in 1..64 {
        request.request_id = format!("request_number_{id:03}");
        claim_signing_request(owner, &request, &AtomicBool::new(false)).unwrap();
    }
    request.request_id = "request_number_064".into();
    assert_eq!(
        claim_signing_request(owner, &request, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        CitizenSdkErrorCode::Busy
    );
    // 同一文本在另一实例不是同一个消费者会话；结果句柄另有 owner 门。
    claim_signing_request(owner - 1, &request, &AtomicBool::new(false)).unwrap();
    drop_sessions_for_owner(owner);
    drop_sessions_for_owner(owner - 1);
}

#[test]
fn qr_result_copy_is_typed_bounded_and_invalid_after_release() {
    use crate::ownership::OwnedResult;
    let result = ownership::reserve(u64::MAX - 903)
        .unwrap()
        .commit(OwnedResult::success(
            u64::MAX - 903,
            ResultPayload::QrSigned("{\"kind\":2}".to_owned()),
        ))
        .unwrap();
    let mut required = 0;
    assert_eq!(
        unsafe { citizensdk_result_copy_qr(result, std::ptr::null_mut(), 0, &mut required) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(required, 10);
    let mut buffer = [0xa5; 2];
    assert_eq!(
        unsafe { citizensdk_result_copy_qr(result, buffer.as_mut_ptr(), 2, &mut required) },
        CitizenSdkErrorCode::InvalidArgument.as_i32()
    );
    assert_eq!(buffer, [0xa5; 2]);
    ownership::release(result).unwrap();
    assert_eq!(
        unsafe { citizensdk_result_copy_qr(result, std::ptr::null_mut(), 0, &mut required) },
        CitizenSdkErrorCode::InvalidHandle.as_i32()
    );
    let wrong = ownership::reserve(u64::MAX - 903)
        .unwrap()
        .commit(OwnedResult::success(u64::MAX - 903, ResultPayload::Empty))
        .unwrap();
    assert_eq!(
        unsafe { citizensdk_result_copy_qr(wrong, std::ptr::null_mut(), 0, &mut required) },
        CitizenSdkErrorCode::InvalidArgument.as_i32()
    );
    ownership::release(wrong).unwrap();
}
