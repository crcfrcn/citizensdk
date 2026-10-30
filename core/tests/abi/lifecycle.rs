use super::*;

#[cfg(feature = "chain")]
#[test]
fn start_diagnostic_keeps_success_and_errors_but_replaces_panic_payload() {
    let step = Cell::new(StartStep::Restore);
    let convergences = Cell::new(0);
    let converge = || convergences.set(convergences.get() + 1);
    assert_eq!(
        diagnose_start(&step, converge, || Ok::<_, FfiError>(7)),
        Ok(7)
    );
    let ordinary = FfiError::new(CitizenSdkErrorCode::Network, "ordinary failure");
    assert_eq!(
        diagnose_start::<()>(&step, converge, || Err(ordinary.clone())),
        Err(ordinary),
    );
    assert_eq!(convergences.get(), 0);
    for current in [
        StartStep::Restore,
        StartStep::Begin,
        StartStep::PublishBegin,
        StartStep::ProviderStart,
        StartStep::Refresh,
        StartStep::Complete,
        StartStep::Services,
        StartStep::PublishComplete,
    ] {
        step.set(current);
        let error = diagnose_start::<()>(&step, converge, || panic!("untrusted panic payload"))
            .expect_err("panic must become a fixed failure");
        assert_eq!(error.code, CitizenSdkErrorCode::Panic);
        assert_eq!(
            error.message,
            format!("CitizenSDK start panicked at {}", current.token())
        );
        assert!(!error.message.contains("untrusted"));
    }

    step.set(StartStep::Restore);
    assert_eq!(convergences.get(), 8);
    let error = diagnose_start::<()>(&step, converge, || {
        run_start_lifecycle_policy(
            true,
            || Ok(()),
            || {},
            || {
                step.set(StartStep::Begin);
                Ok(())
            },
            || {
                step.set(StartStep::PublishBegin);
                Ok(())
            },
            || {
                step.set(StartStep::ProviderStart);
                panic!("injected provider failure")
            },
        )
    })
    .expect_err("a provider panic must keep its startup step");
    assert_eq!(error.message, "CitizenSDK start panicked at PROVIDER_START");
    assert_eq!(convergences.get(), 9);
}

#[test]
fn host_lifecycle_is_exclusive_and_direct_lifecycle_is_shared() {
    assert_eq!(
        lifecycle_admission_policy(true),
        LifecycleAdmissionPolicy::Exclusive
    );
    assert_eq!(
        lifecycle_admission_policy(false),
        LifecycleAdmissionPolicy::Shared
    );
}

#[test]
fn start_policy_restores_only_host_before_begin_and_provider_start() {
    let host_steps = std::cell::RefCell::new(Vec::new());
    run_start_lifecycle_policy(
        true,
        || {
            host_steps.borrow_mut().push("restore");
            Ok::<(), &'static str>(())
        },
        || host_steps.borrow_mut().push("converge"),
        || {
            host_steps.borrow_mut().push("begin");
            Ok(())
        },
        || {
            host_steps.borrow_mut().push("publish-begin");
            Ok(())
        },
        || {
            host_steps.borrow_mut().push("provider-start");
            Ok(())
        },
    )
    .unwrap_or_else(|error| panic!("host start policy failed: {error}"));
    assert_eq!(
        *host_steps.borrow(),
        ["restore", "begin", "publish-begin", "provider-start"]
    );

    let direct_steps = std::cell::RefCell::new(Vec::new());
    run_start_lifecycle_policy(
        false,
        || {
            direct_steps.borrow_mut().push("restore");
            Ok::<(), &'static str>(())
        },
        || direct_steps.borrow_mut().push("converge"),
        || {
            direct_steps.borrow_mut().push("begin");
            Ok(())
        },
        || {
            direct_steps.borrow_mut().push("publish-begin");
            Ok(())
        },
        || {
            direct_steps.borrow_mut().push("provider-start");
            Ok(())
        },
    )
    .unwrap_or_else(|error| panic!("direct start policy failed: {error}"));
    assert_eq!(
        *direct_steps.borrow(),
        ["begin", "publish-begin", "provider-start"]
    );

    let failed_steps = std::cell::RefCell::new(Vec::new());
    let failed = run_start_lifecycle_policy(
        true,
        || {
            failed_steps.borrow_mut().push("restore");
            Err::<(), &'static str>("restore-failed")
        },
        || failed_steps.borrow_mut().push("converge"),
        || {
            failed_steps.borrow_mut().push("begin");
            Ok(())
        },
        || {
            failed_steps.borrow_mut().push("publish-begin");
            Ok(())
        },
        || {
            failed_steps.borrow_mut().push("provider-start");
            Ok(())
        },
    );
    assert_eq!(failed, Err("restore-failed"));
    assert_eq!(*failed_steps.borrow(), ["restore", "converge"]);
}

#[test]
fn export_policy_persists_only_host_compositions() {
    let host_steps = std::cell::RefCell::new(Vec::new());
    let host = select_state_export(
        true,
        || {
            host_steps.borrow_mut().push("provider-export");
            Ok::<u8, ()>(1)
        },
        || {
            host_steps.borrow_mut().push("persistent-export");
            Ok::<u8, ()>(2)
        },
    );
    assert_eq!(host, Ok(2));
    assert_eq!(*host_steps.borrow(), ["persistent-export"]);

    let direct_steps = std::cell::RefCell::new(Vec::new());
    let direct = select_state_export(
        false,
        || {
            direct_steps.borrow_mut().push("provider-export");
            Ok::<u8, ()>(1)
        },
        || {
            direct_steps.borrow_mut().push("persistent-export");
            Ok::<u8, ()>(2)
        },
    );
    assert_eq!(direct, Ok(1));
    assert_eq!(*direct_steps.borrow(), ["provider-export"]);
}

#[test]
fn stop_policy_persists_host_before_every_stop_side_effect() {
    let host_steps = std::cell::RefCell::new(Vec::new());
    run_stop_lifecycle_policy(
        true,
        || {
            host_steps.borrow_mut().push("persist");
            Ok::<(), &'static str>(())
        },
        || {
            host_steps.borrow_mut().push("unsubscribe");
            Ok(())
        },
        || {
            host_steps.borrow_mut().push("stop-products");
            Ok(())
        },
        || {
            host_steps.borrow_mut().push("stop-provider");
            Ok(())
        },
        || {
            host_steps.borrow_mut().push("mark-stopped");
            Ok(())
        },
    )
    .unwrap_or_else(|error| panic!("host stop policy failed: {error}"));
    assert_eq!(
        *host_steps.borrow(),
        [
            "persist",
            "unsubscribe",
            "stop-products",
            "stop-provider",
            "mark-stopped"
        ]
    );

    let direct_steps = std::cell::RefCell::new(Vec::new());
    run_stop_lifecycle_policy(
        false,
        || {
            direct_steps.borrow_mut().push("persist");
            Ok::<(), &'static str>(())
        },
        || {
            direct_steps.borrow_mut().push("unsubscribe");
            Ok(())
        },
        || {
            direct_steps.borrow_mut().push("stop-products");
            Ok(())
        },
        || {
            direct_steps.borrow_mut().push("stop-provider");
            Ok(())
        },
        || {
            direct_steps.borrow_mut().push("mark-stopped");
            Ok(())
        },
    )
    .unwrap_or_else(|error| panic!("direct stop policy failed: {error}"));
    assert_eq!(
        *direct_steps.borrow(),
        [
            "unsubscribe",
            "stop-products",
            "stop-provider",
            "mark-stopped"
        ]
    );

    let failed_steps = std::cell::RefCell::new(Vec::new());
    let failed = run_stop_lifecycle_policy(
        true,
        || {
            failed_steps.borrow_mut().push("persist");
            Err::<(), &'static str>("persist-failed")
        },
        || {
            failed_steps.borrow_mut().push("unsubscribe");
            Ok(())
        },
        || {
            failed_steps.borrow_mut().push("stop-products");
            Ok(())
        },
        || {
            failed_steps.borrow_mut().push("stop-provider");
            Ok(())
        },
        || {
            failed_steps.borrow_mut().push("mark-stopped");
            Ok(())
        },
    );
    assert_eq!(failed, Err("persist-failed"));
    assert_eq!(*failed_steps.borrow(), ["persist"]);
}

#[test]
fn block_round_trip_preserves_exact_finality() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0x55; 32]), 55);
    let abi = block_to_abi(block);
    assert_eq!(
        block_from_abi(abi).unwrap_or_else(|error| panic!("round trip failed: {error:?}")),
        block
    );
}

#[test]
fn failure_stage_getter_accepts_only_ready_failed_results() {
    use ownership::OwnedResult;

    let failed = ownership::insert(OwnedResult::failure(
        7,
        FfiError::at_stage(
            CitizenSdkErrorCode::Network,
            CitizenSdkFailureStage::Provider,
            "provider unavailable",
        ),
    ))
    .unwrap_or_else(|error| panic!("failed result insert failed: {error:?}"));
    let mut stage = CitizenSdkFailureStage::Admission;
    assert_eq!(
        unsafe { citizensdk_result_get_failure_stage(failed, &mut stage) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(stage, CitizenSdkFailureStage::Provider);
    assert_eq!(
        unsafe { citizensdk_result_get_failure_stage(failed, ptr::null_mut()) },
        CitizenSdkErrorCode::InvalidArgument.as_i32()
    );
    ownership::release(failed)
        .unwrap_or_else(|error| panic!("failed result release failed: {error:?}"));
    assert_eq!(
        unsafe { citizensdk_result_get_failure_stage(failed, &mut stage) },
        CitizenSdkErrorCode::InvalidHandle.as_i32()
    );

    let success = ownership::insert(OwnedResult::success(7, ResultPayload::Empty))
        .unwrap_or_else(|error| panic!("success result insert failed: {error:?}"));
    assert_eq!(
        unsafe { citizensdk_result_get_failure_stage(success, &mut stage) },
        CitizenSdkErrorCode::InvalidState.as_i32()
    );
    ownership::release(success)
        .unwrap_or_else(|error| panic!("success result release failed: {error:?}"));
}

#[test]
fn chain_sync_header_and_body_results_copy_exact_bounded_values() {
    use crate::types::{
        ChainSyncStatus, FinalizedBlockRef, VerifiedBlockBody, VerifiedBlockHeader,
    };
    use ownership::OwnedResult;

    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x22; 32]), 22);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x23; 32]), 23);
    let sync_result = ownership::insert(OwnedResult::success(
        1,
        ResultPayload::ChainSyncStatus(
            ChainSyncStatus::try_new(7, true, true, best, finalized)
                .unwrap_or_else(|error| panic!("sync status failed: {error:?}")),
        ),
    ))
    .unwrap_or_else(|error| panic!("result insert failed: {error:?}"));
    let mut sync = CitizenSdkChainSyncStatusInfo::default();
    assert_eq!(
        unsafe { citizensdk_result_get_sync_status(sync_result, &mut sync) },
        0
    );
    assert_eq!(sync.peer_count, 7);
    assert_eq!(sync.best.number, 23);
    assert_eq!(sync.finalized.number, 22);
    ownership::release(sync_result)
        .unwrap_or_else(|error| panic!("result release failed: {error:?}"));

    let block: VerifiedBlockRef = finalized.into();
    let header = VerifiedBlockHeader::try_new(
        block,
        Hash32::from_bytes([1; 32]),
        Hash32::from_bytes([2; 32]),
        Hash32::from_bytes([3; 32]),
        vec![4, 5, 6],
    )
    .unwrap_or_else(|error| panic!("header failed: {error:?}"));
    let header_result =
        ownership::insert(OwnedResult::success(1, ResultPayload::BlockHeader(header)))
            .unwrap_or_else(|error| panic!("result insert failed: {error:?}"));
    let mut header_info = CitizenSdkBlockHeaderInfo::default();
    let mut required = 0;
    assert_eq!(
        unsafe {
            citizensdk_result_get_block_header(
                header_result,
                &mut header_info,
                ptr::null_mut(),
                0,
                &mut required,
            )
        },
        0
    );
    assert_eq!(required, 3);
    let mut digest = vec![0; required as usize];
    assert_eq!(
        unsafe {
            citizensdk_result_get_block_header(
                header_result,
                &mut header_info,
                digest.as_mut_ptr(),
                digest.len() as u64,
                &mut required,
            )
        },
        0
    );
    assert_eq!(digest, [4, 5, 6]);
    ownership::release(header_result)
        .unwrap_or_else(|error| panic!("result release failed: {error:?}"));

    let body = VerifiedBlockBody::try_new(block, vec![vec![7], vec![8, 9]])
        .unwrap_or_else(|error| panic!("body failed: {error:?}"));
    let body_result = ownership::insert(OwnedResult::success(1, ResultPayload::BlockBody(body)))
        .unwrap_or_else(|error| panic!("result insert failed: {error:?}"));
    let mut body_info = CitizenSdkBlockBodyInfo::default();
    assert_eq!(
        unsafe { citizensdk_result_get_block_body_info(body_result, &mut body_info) },
        0
    );
    assert_eq!((body_info.extrinsic_count, body_info.total_bytes), (2, 3));
    let mut second_required = 0;
    assert_eq!(
        unsafe {
            citizensdk_result_copy_block_body_extrinsic(
                body_result,
                1,
                ptr::null_mut(),
                0,
                &mut second_required,
            )
        },
        0
    );
    let mut second = vec![0; second_required as usize];
    assert_eq!(
        unsafe {
            citizensdk_result_copy_block_body_extrinsic(
                body_result,
                1,
                second.as_mut_ptr(),
                second.len() as u64,
                &mut second_required,
            )
        },
        0
    );
    assert_eq!(second, [8, 9]);
    ownership::release(body_result)
        .unwrap_or_else(|error| panic!("result release failed: {error:?}"));
}

#[test]
fn unsupported_capabilities_are_not_present_as_exports() {
    let source = include_str!("../../src/abi/mod.rs");
    for suffix in ["build_transaction", "wallet_create", "sign_secret"] {
        let forbidden = ["citizensdk_", suffix].concat();
        assert!(!source.contains(&forbidden));
    }
}

#[test]
fn watch_terminal_policy_does_not_confuse_network_loss_with_finality() {
    let block = crate::types::FinalizedBlockRef::from_parts(Hash32::from_bytes([0x44; 32]), 44);
    assert!(watch_is_terminal(&ExtrinsicWatchEvent::Finalized { block }));
    assert!(watch_is_terminal(&ExtrinsicWatchEvent::Invalid));
    assert!(watch_is_terminal(&ExtrinsicWatchEvent::Usurped {
        replacement_hash: Hash32::from_bytes([0x55; 32]),
    }));
    assert!(!watch_is_terminal(&ExtrinsicWatchEvent::Dropped));
    assert!(!watch_is_terminal(&ExtrinsicWatchEvent::FinalityTimeout {
        block: None
    }));
}

#[test]
fn unverified_reason_numbers_match_the_public_header_contract() {
    let cases = [
        (UnverifiedReason::TargetBlockUnavailable, 1),
        (UnverifiedReason::RuntimeContextUnavailable, 2),
        (UnverifiedReason::MetadataDecodeFailed, 3),
        (UnverifiedReason::BlockBodyUnavailable, 4),
        (UnverifiedReason::ExtrinsicHashMismatch, 5),
        (UnverifiedReason::ExtrinsicNotFound, 6),
        (UnverifiedReason::MultipleExtrinsicMatches, 7),
        (UnverifiedReason::SystemEventsUnavailable, 8),
        (UnverifiedReason::SystemEventsMalformed, 9),
        (UnverifiedReason::OutcomeEventMissing, 10),
        (UnverifiedReason::OutcomeEventAmbiguous, 11),
        (UnverifiedReason::ProviderFailure, 12),
    ];
    for (reason, expected) in cases {
        assert_eq!(unverified_reason(reason), expected);
    }
}

#[test]
fn panic_boundary_returns_stable_code_and_does_not_poison_next_call() {
    let panic_code = ffi_status(|| -> FfiResult<()> { panic!("injected ABI panic") });
    assert_eq!(panic_code, CitizenSdkErrorCode::Panic.as_i32());
    assert_eq!(ffi_status(|| Ok(())), CitizenSdkErrorCode::Ok.as_i32());
}
