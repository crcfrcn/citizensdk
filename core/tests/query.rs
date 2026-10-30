use super::*;

#[cfg(not(feature = "chain"))]
#[test]
fn static_genesis_does_not_enable_an_uncompiled_chain_module() {
    let engine = CitizenEngine::new(None, None, None, None, None, None, None);
    assert!(
        matches!(engine.genesis_hash(), Err(EngineError::Contract(error))
            if error.code() == ContractErrorCode::Unsupported)
    );
}

// 用原状态协调入口验证所有权，不触碰实际钱包、存储或硬件认证。
fn local_engine(lifecycle: EngineLifecycle) -> CitizenEngine {
    let engine = CitizenEngine::new(None, None, None, None, None, None, None);
    engine
        .state
        .lock()
        .unwrap_or_else(|e| panic!("{e}"))
        .lifecycle = lifecycle;
    engine
}

#[test]
fn stopped_or_failed_history_does_not_block_local_wallet_mutations() {
    for lifecycle in [
        EngineLifecycle::Created,
        EngineLifecycle::Stopped,
        EngineLifecycle::StartFailed,
    ] {
        let engine = local_engine(lifecycle);
        engine
            .stop_chain_monitor()
            .unwrap_or_else(|e| panic!("{e}"));
        for _ in 0..2 {
            assert_eq!(
                futures::executor::block_on(engine.with_wallet_history_paused(async { Ok(7) }))
                    .unwrap_or_else(|e| panic!("{e}")),
                7
            );
            let state = engine.state.lock().unwrap_or_else(|e| panic!("{e}"));
            assert!(state.history_paused, "本地操作不能复活已停止的历史读取");
            assert!(!state.wallet_mutation_in_progress);
        }
    }
}

#[test]
fn wallet_mutation_failure_restores_only_its_own_temporary_pause() {
    let engine = local_engine(EngineLifecycle::Running);
    let result: Result<(), EngineError> = futures::executor::block_on(
        engine.with_wallet_history_paused(async { Err(lifecycle_error("synthetic failure")) }),
    );
    assert!(result.is_err());
    let state = engine.state.lock().unwrap_or_else(|e| panic!("{e}"));
    assert!(!state.history_paused);
    assert!(!state.wallet_mutation_in_progress);
    drop(state);
    assert!(
        futures::executor::block_on(engine.with_wallet_history_paused(async { Ok(()) })).is_ok()
    );
}

#[test]
fn wallet_mutation_drains_history_rejects_overlap_and_does_not_undo_stop() {
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        task::Context,
    };
    let engine = local_engine(EngineLifecycle::Running);
    let cancellation = {
        let mut state = engine.state.lock().unwrap_or_else(|e| panic!("{e}"));
        state.inflight_history_operations = 1;
        Arc::clone(&state.history_cancel)
    };
    let lease = EngineHistoryOperationLease {
        state: Arc::clone(&engine.state),
        generation: 0,
        cancellation,
    };
    let began = AtomicBool::new(false);
    let (send, receive) = futures::channel::oneshot::channel::<()>();
    let mut operation = Box::pin(engine.with_wallet_history_paused(async {
        began.store(true, Ordering::SeqCst);
        receive
            .await
            .map_err(|_| lifecycle_error("synthetic channel closed"))?;
        Ok(())
    }));
    let waker = futures::task::noop_waker();
    let mut context = Context::from_waker(&waker);
    assert!(operation.as_mut().poll(&mut context).is_pending());
    assert!(
        !began.load(Ordering::SeqCst),
        "旧历史读未排空不能进入钱包写入"
    );
    assert!(
        futures::executor::block_on(engine.with_wallet_history_paused(async { Ok(()) })).is_err()
    );
    drop(lease);
    assert!(operation.as_mut().poll(&mut context).is_pending());
    assert!(began.load(Ordering::SeqCst));
    engine
        .stop_chain_monitor()
        .unwrap_or_else(|e| panic!("{e}"));
    send.send(()).unwrap_or_else(|_| panic!("receiver missing"));
    assert!(futures::executor::block_on(operation).is_ok());
    let state = engine.state.lock().unwrap_or_else(|e| panic!("{e}"));
    assert!(state.history_paused);
    assert!(!state.wallet_mutation_in_progress);
}

#[test]
fn disposed_engine_does_not_enter_local_wallet_mutation() {
    let engine = local_engine(EngineLifecycle::Disposed);
    let entered = std::sync::atomic::AtomicBool::new(false);
    let result = futures::executor::block_on(engine.with_wallet_history_paused(async {
        entered.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }));
    assert!(result.is_err());
    assert!(!entered.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn monitor_can_start_while_syncing_but_not_when_stopped_or_disabled() {
    let engine = local_engine(EngineLifecycle::Running);
    // 此用例只隔离监控状态机；公开组件/模块过滤由chain_access回归验证。
    let mut probes = CapabilityName::ALL
        .into_iter()
        .map(CapabilityProbe::ready)
        .collect::<Vec<_>>();
    for probe in &mut probes {
        if matches!(
            probe.name,
            CapabilityName::ChainRead | CapabilityName::History
        ) {
            probe.runtime_ready = false;
            probe.not_ready_reason = Some(CapabilityReason::ChainUnsynced);
        }
    }
    {
        let mut capabilities = engine.capabilities.lock().unwrap_or_else(|e| panic!("{e}"));
        capabilities.base_probes = Some(probes.clone());
        capabilities
            .tracker
            .update(probes.clone())
            .unwrap_or_else(|e| panic!("{e}"));
    }
    assert!(futures::executor::block_on(engine.start_chain_monitor()).is_ok());
    assert!(
        engine
            .chain_monitor
            .lock()
            .unwrap_or_else(|e| panic!("{e}"))
            .running
    );
    assert!(
        engine
            .require_capabilities(&[CapabilityName::ChainRead])
            .is_err(),
        "监控可启动不代表业务读取已就绪"
    );
    engine
        .stop_chain_monitor()
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(futures::executor::block_on(engine.start_chain_monitor()).is_err());
    for lifecycle in [
        EngineLifecycle::Created,
        EngineLifecycle::Stopped,
        EngineLifecycle::StartFailed,
        EngineLifecycle::Disposed,
    ] {
        engine
            .state
            .lock()
            .unwrap_or_else(|e| panic!("{e}"))
            .lifecycle = lifecycle;
        assert!(futures::executor::block_on(engine.start_chain_monitor()).is_err());
    }
    {
        let mut state = engine.state.lock().unwrap_or_else(|e| panic!("{e}"));
        state.lifecycle = EngineLifecycle::Running;
        state.history_paused = false;
    }
    for name in [CapabilityName::ChainRead, CapabilityName::History] {
        let mut disabled = probes.clone();
        disabled
            .iter_mut()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("probe missing"))
            .enabled = false;
        {
            let mut capabilities = engine.capabilities.lock().unwrap_or_else(|e| panic!("{e}"));
            capabilities.base_probes = Some(disabled.clone());
            capabilities
                .tracker
                .update(disabled)
                .unwrap_or_else(|e| panic!("{e}"));
        }
        assert!(futures::executor::block_on(engine.start_chain_monitor()).is_err());
    }
}

#[test]
fn chain_only_refresh_preserves_every_other_raw_probe() {
    let engine = CitizenEngine::new(None, None, None, None, None, None, None);
    engine
        .update_capabilities(
            CapabilityName::ALL
                .into_iter()
                .map(CapabilityProbe::ready)
                .collect(),
        )
        .unwrap_or_else(|error| panic!("capability setup failed: {error}"));
    let raw = || {
        engine
            .capabilities
            .lock()
            .unwrap_or_else(|error| panic!("capability lock failed: {error}"))
            .base_probes
            .clone()
            .unwrap_or_else(|| panic!("base probes missing"))
            .into_iter()
            .filter(|probe| probe.name != CapabilityName::ChainRead)
            .collect::<Vec<_>>()
    };
    let before = raw();
    for ready in [false, true, false] {
        engine
            .update_chain_readiness(ready)
            .unwrap_or_else(|error| panic!("chain update failed: {error}"));
        assert_eq!(
            raw(),
            before,
            "wallet/history/security facts must not be reprobed or overwritten"
        );
    }
}
