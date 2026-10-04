use std::{
    collections::{hash_map::Entry, HashMap},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use citizen_sdk_contracts::CapabilitySnapshot;
use citizen_sdk_engine::CitizenEngine;
#[cfg(feature = "chain")]
use citizen_sdk_smoldot_provider::{ProviderLifecycle, SmoldotVerifiedChainClient};

use crate::{
    abi::{
        CitizenSdkErrorCode, CitizenSdkEventCallback, CitizenSdkEventType, CitizenSdkHandle,
        CitizenSdkHostServicesV1, CitizenSdkRequestId, CitizenSdkResultHandle,
    },
    capabilities::require_snapshot,
    composition::ProductComposition,
    error::{FfiError, FfiResult},
    events::{CompletionEventReservation, EventDispatcher},
    ownership::{self, OwnedResult, ResultHandleAllocator, ResultPayload, ResultReservation},
    requests::RequestCancellation,
};

struct RequestState {
    accepting: bool,
    next_request: u64,
    // 通道序号独立于原生request_id；各平台共用此实例唯一接纳状态。
    next_request_sequence: u64,
    exclusive_request: Option<CitizenSdkRequestId>,
    callback_registered: bool,
    callback_transition: bool,
    capability_subscribed: bool,
    subscription_transition: bool,
}

impl RequestState {
    const fn control_transition_in_progress(&self) -> bool {
        self.callback_transition || self.subscription_transition || self.exclusive_request.is_some()
    }
}

enum CancellationState {
    NotCancellable,
    Cancellable(futures_channel::oneshot::Sender<()>),
    Requested,
}

struct PendingRequest {
    cancelled: Arc<AtomicBool>,
    cancellation: CancellationState,
    completion_event: CompletionEventReservation,
    result: ResultReservation,
    exclusive: bool,
}

struct CapabilityMonitor {
    stop: Arc<(Mutex<bool>, Condvar)>,
    join: Option<JoinHandle<()>>,
}

impl CapabilityMonitor {
    fn start(runtime: Weak<NativeRuntime>) -> FfiResult<Self> {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let thread_stop = Arc::clone(&stop);
        let join = thread::Builder::new()
            .name("citizensdk-capabilities".to_owned())
            .spawn(move || capability_monitor_loop(runtime, thread_stop))
            .map_err(|error| {
                FfiError::internal(format!("failed to start capability monitor: {error}"))
            })?;
        Ok(Self {
            stop,
            join: Some(join),
        })
    }

    fn stop(mut self) -> FfiResult<()> {
        {
            let mut stopped = self
                .stop
                .0
                .lock()
                .map_err(|_| FfiError::internal("capability monitor state is poisoned"))?;
            *stopped = true;
            self.stop.1.notify_all();
        }
        if let Some(join) = self.join.take() {
            join.join()
                .map_err(|_| FfiError::internal("capability monitor thread panicked"))?;
        }
        Ok(())
    }
}

pub struct NativeRuntime {
    handle: CitizenSdkHandle,
    composition: ProductComposition,
    dispatcher: EventDispatcher,
    result_handles: &'static ResultHandleAllocator,
    request_state: Mutex<RequestState>,
    pending_requests: AtomicU64,
    owned_results: AtomicU64,
    cancellations: Mutex<HashMap<CitizenSdkRequestId, PendingRequest>>,
    capability_monitor: Mutex<Option<CapabilityMonitor>>,
    #[cfg(feature = "chain")]
    chain_monitor: Mutex<Option<crate::chain_monitor::ChainMonitor>>,
}

impl NativeRuntime {
    /// 外壳先接纳一次，再解方法参数；单次参数失败不得封死后续合法请求。
    /// 只保护传输关联，不分配原生请求，不触发业务、设备或网络操作。
    pub(crate) fn accept_request_sequence(&self, sequence: u64) -> FfiResult<()> {
        if sequence == 0 || sequence > i64::MAX as u64 {
            return Err(FfiError::new(CitizenSdkErrorCode::InvalidArgument, "invalid request sequence"));
        }
        let mut state = self.request_state.lock()
            .map_err(|_| FfiError::internal("request state is poisoned"))?;
        if !state.accepting {
            return Err(FfiError::new(CitizenSdkErrorCode::InvalidState, "instance is shutting down"));
        }
        if sequence != state.next_request_sequence {
            return Err(FfiError::new(CitizenSdkErrorCode::Conflict, "request sequence is not the next instance sequence"));
        }
        if state.next_request_sequence == i64::MAX as u64 {
            return Err(FfiError::new(CitizenSdkErrorCode::Integrity, "request sequence space is exhausted"));
        }
        state.next_request_sequence += 1;
        Ok(())
    }

    pub(crate) unsafe fn set_secret_presence_provider(
        &self, provider: crate::host_providers::CitizenSdkHostSecretPresenceV1,
    ) -> FfiResult<()> {
        // Host唯一操作门同时保护首次登记与关闭；不另建实例状态或回调路由。
        unsafe { self.composition.set_secret_presence_provider(provider) }
    }

    pub(crate) fn private_key_view_vault(
        &self,
        authorizing: Arc<dyn Fn(u64) -> i32 + Send + Sync>,
    ) -> Option<Arc<dyn citizen_sdk_contracts::SecretVault>> {
        self.composition.private_key_view_vault(authorizing)
    }

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

    pub(crate) fn new_with_composition(
        handle: CitizenSdkHandle,
        composition: ProductComposition,
        result_handles: &'static ResultHandleAllocator,
    ) -> FfiResult<Arc<Self>> {
        Ok(Arc::new(Self {
            handle,
            composition,
            dispatcher: EventDispatcher::new()?,
            result_handles,
            request_state: Mutex::new(RequestState {
                accepting: true,
                next_request: 1,
                next_request_sequence: 1,
                exclusive_request: None,
                callback_registered: false,
                callback_transition: false,
                capability_subscribed: false,
                subscription_transition: false,
            }),
            pending_requests: AtomicU64::new(0),
            owned_results: AtomicU64::new(0),
            cancellations: Mutex::new(HashMap::new()),
            capability_monitor: Mutex::new(None),
            #[cfg(feature = "chain")]
            chain_monitor: Mutex::new(None),
        }))
    }

    pub const fn handle(&self) -> CitizenSdkHandle {
        self.handle
    }

    pub fn engine(&self) -> &Arc<CitizenEngine> {
        self.composition.engine()
    }

    pub(crate) const fn has_modules(&self, bits: u32) -> bool {
        self.composition.has_modules(bits)
    }

    #[cfg(feature = "chain")]
    pub fn provider(&self) -> FfiResult<&Arc<SmoldotVerifiedChainClient>> {
        self.composition.provider().ok_or_else(|| {
            FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain module is not selected",
            )
        })
    }

    /// 同一工作线程驱动已组合的真实依赖；纯钱包/签名不创建轻节点运行时。
    pub fn drive<F: std::future::Future>(&self, future: F) -> FfiResult<F::Output> {
        #[cfg(feature = "chain")]
        if let Some(provider) = self.composition.provider() {
            return provider.drive(future).map_err(FfiError::from);
        }
        Ok(futures_executor::block_on(future))
    }

    /// # Safety
    /// Non-null copied host callbacks must outlive successful destruction.
    pub unsafe fn new_with_modules(
        handle: CitizenSdkHandle,
        combined_chain_spec: Option<String>,
        system_name: String,
        system_version: String,
        host_services: Option<&CitizenSdkHostServicesV1>,
        modules: citizen_sdk_contracts::Modules,
    ) -> FfiResult<Arc<Self>> {
        let composition = unsafe {
            ProductComposition::module_abi(
                combined_chain_spec,
                system_name,
                system_version,
                host_services,
                modules,
            )
        }?;
        Self::new_with_composition(handle, composition, &ownership::RESULT_HANDLES)
    }

    pub fn uses_host_services(&self) -> bool {
        self.composition.uses_host_services()
    }

    pub fn set_event_callback(
        &self,
        callback: CitizenSdkEventCallback,
        context: *mut std::ffi::c_void,
    ) -> FfiResult<()> {
        // Do not hold request_state while the dispatcher waits for an in-flight
        // callback: that callback is allowed to re-enter request APIs, which
        // observe this transition and fail Busy instead of deadlocking.
        self.dispatcher
            .ensure_blocking_control_allowed("change the event callback")?;
        {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            ensure_accepting(&state)?;
            ensure_no_control_transition(&state)?;
            if self.pending_requests.load(Ordering::SeqCst) != 0
                || self.owned_results.load(Ordering::SeqCst) != 0
            {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Busy,
                    "event callback cannot change while requests or results are outstanding",
                ));
            }
            if callback.is_none() && state.capability_subscribed {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Busy,
                    "unsubscribe capability changes before clearing the callback",
                ));
            }
            state.callback_transition = true;
        }

        let callback_result = self.dispatcher.set_callback(callback, context);
        {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            if callback_result.is_ok() {
                state.callback_registered = callback.is_some();
            }
            state.callback_transition = false;
        }
        callback_result?;
        if callback.is_some() {
            // Registration is the commit point. Initial notifications are
            // best-effort because returning an error after replacing the old
            // host context would falsely imply that no side effect occurred;
            // hosts can always query both snapshots synchronously.
            let _ = self.publish_capabilities();
            let _ = self.publish_lifecycle();
        }
        Ok(())
    }

    pub fn begin_request(
        &self,
        cancellable: bool,
    ) -> FfiResult<(CitizenSdkRequestId, Option<RequestCancellation>)> {
        self.begin_request_with_policy(cancellable, false)
    }

    /// Reserves one host-composed start, stop or import operation that cannot
    /// overlap any asynchronous SDK request. It closes every interval in which
    /// provider side effects and the corresponding Engine lifecycle transition
    /// must remain one indivisible operation.
    pub fn begin_exclusive_request(
        &self,
    ) -> FfiResult<(CitizenSdkRequestId, Option<RequestCancellation>)> {
        self.begin_request_with_policy(false, true)
    }

    fn begin_request_with_policy(
        &self,
        cancellable: bool,
        exclusive: bool,
    ) -> FfiResult<(CitizenSdkRequestId, Option<RequestCancellation>)> {
        let mut state = self
            .request_state
            .lock()
            .map_err(|_| FfiError::internal("request state is poisoned"))?;
        if !state.accepting {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "CitizenSDK instance is shutting down",
            ));
        }
        if state.control_transition_in_progress() {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Busy,
                "a CitizenSDK callback, subscription, or lifecycle transition is in progress",
            ));
        }
        if exclusive && self.pending_requests.load(Ordering::SeqCst) != 0 {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Busy,
                "a lifecycle request requires every earlier asynchronous request to complete",
            ));
        }
        if !state.callback_registered {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "an event callback must be registered before async requests",
            ));
        }
        let request_id = state.next_request;
        let following_request = state
            .next_request
            .checked_add(1)
            .filter(|next| *next != 0)
            .ok_or_else(|| FfiError::internal("request id space is exhausted"))?;
        // Both resources needed for the unique mandatory completion are
        // reserved before request acceptance becomes observable. Ordinary
        // events and watch updates cannot consume either reservation.
        let completion_event = self.dispatcher.reserve_completion()?;
        let result = ownership::reserve_with(self.handle, self.result_handles)?;
        let (cancel_state, cancel_receiver) = if cancellable {
            let (sender, receiver) = futures_channel::oneshot::channel();
            (CancellationState::Cancellable(sender), Some(receiver))
        } else {
            (CancellationState::NotCancellable, None)
        };
        let mut pending = self
            .cancellations
            .lock()
            .map_err(|_| FfiError::internal("request cancellation state is poisoned"))?;
        match pending.entry(request_id) {
            Entry::Vacant(entry) => {
                entry.insert(PendingRequest {
                    cancellation: cancel_state,
                    cancelled: Arc::new(AtomicBool::new(false)),
                    completion_event,
                    result,
                    exclusive,
                });
            }
            Entry::Occupied(_) => {
                return Err(FfiError::internal(
                    "monotonic request id collided with a pending request",
                ));
            }
        }
        state.next_request = following_request;
        self.pending_requests.fetch_add(1, Ordering::SeqCst);
        if exclusive {
            state.exclusive_request = Some(request_id);
        }
        Ok((request_id, cancel_receiver))
    }

    pub fn reject_request(&self, request_id: CitizenSdkRequestId) {
        let removed = self
            .cancellations
            .lock()
            .ok()
            .and_then(|mut cancellations| cancellations.remove(&request_id));
        if let Some(request) = removed {
            self.finish_request_admission(request_id, request.exclusive);
        }
    }

    /// 取消线程直接置位；即使宿主同步等待认证，Core也能在回调返回后立即拒绝迟到成功。
    pub fn request_cancellation_flag(&self, request_id: CitizenSdkRequestId) -> FfiResult<Arc<AtomicBool>> {
        self.cancellations.lock().map_err(|_| FfiError::internal("request cancellation state is poisoned"))?
            .get(&request_id).map(|request| Arc::clone(&request.cancelled))
            .ok_or_else(|| FfiError::new(CitizenSdkErrorCode::NotFound, "request id is not pending"))
    }

    pub fn request_cancel(&self, request_id: CitizenSdkRequestId) -> FfiResult<()> {
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| FfiError::internal("request cancellation state is poisoned"))?;
        let request = cancellations.get_mut(&request_id).ok_or_else(|| {
            FfiError::new(CitizenSdkErrorCode::NotFound, "request id is not pending")
        })?;
        match std::mem::replace(&mut request.cancellation, CancellationState::Requested) {
            CancellationState::Cancellable(sender) => {
                request.cancelled.store(true, Ordering::Release);
                let _ = sender.send(());
                Ok(())
            }
            CancellationState::NotCancellable => {
                request.cancellation = CancellationState::NotCancellable;
                Err(FfiError::new(
                    CitizenSdkErrorCode::Unsupported,
                    "accepted request has side effects or cannot be safely cancelled",
                ))
            }
            CancellationState::Requested => {
                request.cancellation = CancellationState::Requested;
                Err(FfiError::new(
                    CitizenSdkErrorCode::Conflict,
                    "request cancellation was already requested",
                ))
            }
        }
    }

    pub fn complete_request(
        &self,
        request_id: CitizenSdkRequestId,
        outcome: FfiResult<ResultPayload>,
    ) {
        let pending = self
            .cancellations
            .lock()
            .ok()
            .and_then(|mut cancellations| cancellations.remove(&request_id));
        let Some(PendingRequest {
            cancelled: _,
            cancellation,
            completion_event,
            result: result_reservation,
            exclusive,
        }) = pending
        else {
            return;
        };
        #[cfg(feature = "qr")]
        let outcome = if matches!(cancellation, CancellationState::Requested)
            && matches!(
                &outcome,
                Ok(ResultPayload::QrReview(_) | ResultPayload::QrSigned(_))
            ) {
            // 与取消登记同一 registry 线性化；关闭最后一段计算到结果提交之间的竞态。
            Err(FfiError::new(
                CitizenSdkErrorCode::Cancelled,
                "二维码操作已取消且真实作业已排空",
            ))
        } else {
            outcome
        };
        #[cfg(not(feature = "qr"))]
        let _ = cancellation;
        let result = match outcome {
            Ok(payload) => OwnedResult::success(self.handle, payload),
            Err(error) => OwnedResult::failure(self.handle, error),
        };
        let result_handle = result_reservation.commit(result).ok();
        if result_handle.is_some() {
            self.owned_results.fetch_add(1, Ordering::SeqCst);
        }
        // Release lifecycle exclusivity only after every operation side effect
        // and result commit, but before publishing completion so callback code
        // can immediately issue the next valid request.
        self.finish_request_admission(request_id, exclusive);
        if let Some(result_handle) = result_handle {
            if self
                .dispatcher
                .send_reserved_completion(completion_event, request_id, result_handle)
                .is_err()
            {
                // A disconnected dispatcher is terminal, but it must never
                // leave an unreachable owned result that blocks destroy.
                let _ = ownership::release(result_handle);
                self.result_released();
            }
        }
    }

    fn finish_request_admission(&self, request_id: CitizenSdkRequestId, exclusive: bool) {
        if exclusive {
            let mut state = self
                .request_state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            debug_assert_eq!(state.exclusive_request, Some(request_id));
            let previous = self.pending_requests.fetch_sub(1, Ordering::SeqCst);
            debug_assert_eq!(previous, 1);
            if state.exclusive_request == Some(request_id) {
                state.exclusive_request = None;
            }
            return;
        }
        let previous = self.pending_requests.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0);
    }

    pub fn publish_watch_update(
        &self,
        request_id: CitizenSdkRequestId,
        event: citizen_sdk_contracts::ExtrinsicWatchEvent,
    ) -> FfiResult<()> {
        let result = ownership::insert(OwnedResult::success(
            self.handle,
            ResultPayload::Watch(event),
        ))?;
        self.owned_results.fetch_add(1, Ordering::SeqCst);
        if let Err(error) =
            self.dispatcher
                .try_send(CitizenSdkEventType::WatchUpdate, request_id, result, 0)
        {
            let _ = ownership::release(result);
            self.result_released();
            return Err(error);
        }
        Ok(())
    }

    /// 保留真实同实例钱包快照，复用结果分配器及销毁计数；关闭门内不再产生引用。
    pub fn retain_wallet_state(&self, result: CitizenSdkResultHandle) -> FfiResult<CitizenSdkResultHandle> {
        let state = self.request_state.lock()
            .map_err(|_| FfiError::internal("request state is poisoned"))?;
        ensure_accepting(&state)?;
        let owned = ownership::get(result)?;
        if owned.owner != self.handle || owned.code != CitizenSdkErrorCode::Ok
            || !matches!(&owned.payload, ResultPayload::WalletState(_))
        {
            return Err(FfiError::invalid("检查资源必须来自同实例成功钱包快照"));
        }
        let retained = ownership::reserve_with(self.handle, self.result_handles)?.commit(owned)?;
        self.owned_results.fetch_add(1, Ordering::SeqCst);
        Ok(retained)
    }

    pub fn result_released(&self) {
        let previous = self.owned_results.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0);
    }

    pub fn capability_snapshot(&self) -> FfiResult<CapabilitySnapshot> {
        require_snapshot(self.engine().capabilities()?)
    }

    pub fn publish_capabilities(&self) -> FfiResult<()> {
        let revision = self.capability_snapshot()?.revision();
        self.dispatcher
            .send(CitizenSdkEventType::CapabilitiesChanged, 0, 0, revision)
    }

    /// Refresh readiness from the provider's own verified status. The ABI
    /// never infers usability from peer count, height, elapsed time, or Engine
    /// lifecycle alone.
    pub fn refresh_provider_capabilities(&self) -> FfiResult<CapabilitySnapshot> {
        self.refresh_capability_readiness(false)
    }

    /// 只刷新链读取的真实 provider readiness，不能为公开余额查询探测钱包或金库。
    pub fn refresh_chain_readiness(&self) -> FfiResult<CapabilitySnapshot> {
        self.refresh_capability_readiness(true)
    }

    fn refresh_capability_readiness(&self, chain_only: bool) -> FfiResult<CapabilitySnapshot> {
        let before = self.capability_snapshot()?.revision();
        #[cfg(feature = "chain")]
        let status_error = if let Some(provider) = self.composition.provider() {
            let lifecycle = provider.lifecycle()?;
            if lifecycle == ProviderLifecycle::Running {
                match provider.drive(provider.status()) {
                    Ok(Ok(status)) => (
                        crate::capabilities::provider_runtime_ready(lifecycle, status.is_usable),
                        None,
                    ),
                    Ok(Err(error)) | Err(error) => (false, Some(FfiError::from(error))),
                }
            } else {
                (false, None)
            }
        } else {
            (false, None)
        };
        #[cfg(not(feature = "chain"))]
        let status_error: (bool, Option<FfiError>) = (false, None);
        let snapshot = if chain_only {
            self.engine().update_chain_readiness(status_error.0)?
        } else {
            self.engine()
                .update_capabilities(self.composition.capability_probes(status_error.0))?
        };
        let publish_error = if snapshot.revision() != before {
            self.dispatcher
                .send(
                    CitizenSdkEventType::CapabilitiesChanged,
                    0,
                    0,
                    snapshot.revision(),
                )
                .err()
        } else {
            None
        };
        if let Some(error) = status_error.1 {
            Err(error)
        } else if let Some(error) = publish_error {
            Err(error)
        } else {
            Ok(snapshot)
        }
    }

    pub fn subscribe_capability_changes(self: &Arc<Self>) -> FfiResult<()> {
        // Subscription publishes an initial snapshot through the bounded
        // dispatcher. From inside that dispatcher callback it could otherwise
        // wait on its own full queue, so reject before starting the monitor.
        self.dispatcher
            .ensure_blocking_control_allowed("subscribe capability changes")?;
        {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            ensure_accepting(&state)?;
            ensure_no_control_transition(&state)?;
            if !state.callback_registered {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::InvalidState,
                    "an event callback is required before capability subscription",
                ));
            }
            if state.capability_subscribed {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Conflict,
                    "capability changes are already subscribed",
                ));
            }
            state.subscription_transition = true;
            let monitor = CapabilityMonitor::start(Arc::downgrade(self));
            match monitor {
                Ok(monitor) => {
                    let mut slot = self.capability_monitor.lock().map_err(|_| {
                        state.subscription_transition = false;
                        FfiError::internal("capability monitor state is poisoned")
                    })?;
                    if slot.is_some() {
                        state.subscription_transition = false;
                        return Err(FfiError::internal(
                            "capability monitor exists without subscribed state",
                        ));
                    }
                    *slot = Some(monitor);
                    state.capability_subscribed = true;
                }
                Err(error) => {
                    state.subscription_transition = false;
                    return Err(error);
                }
            }
        }
        // Monitor installation is the commit point. A failed initial event
        // must not turn a live subscription into a failure-with-side-effect;
        // current capability state remains synchronously queryable.
        let _ = self.publish_capabilities();
        let mut state = self
            .request_state
            .lock()
            .map_err(|_| FfiError::internal("request state is poisoned"))?;
        state.subscription_transition = false;
        Ok(())
    }

    pub fn stop_capability_subscription(&self) -> FfiResult<()> {
        // Joining from the dispatch callback can deadlock if the monitor is
        // applying bounded-queue backpressure to that same thread. Reject
        // before taking the monitor or changing subscription state.
        self.dispatcher
            .ensure_blocking_control_allowed("unsubscribe capability changes")?;
        self.stop_capability_subscription_inner(true, None)
    }

    /// Stops capability monitoring from the accepted host lifecycle request
    /// that currently owns the exclusive admission gate.
    ///
    /// The owner id is checked while holding `request_state`, so this bypass
    /// cannot be used by an ordinary request or an external control call.
    pub fn stop_capability_subscription_for_exclusive_request(
        &self,
        request_id: CitizenSdkRequestId,
    ) -> FfiResult<()> {
        self.dispatcher
            .ensure_blocking_control_allowed("unsubscribe capability changes")?;
        self.stop_capability_subscription_inner(true, Some(request_id))
    }

    fn stop_capability_subscription_for_shutdown(&self) -> FfiResult<()> {
        self.stop_capability_subscription_inner(false, None)
    }

    fn stop_capability_subscription_inner(
        &self,
        require_accepting: bool,
        exclusive_owner: Option<CitizenSdkRequestId>,
    ) -> FfiResult<()> {
        let monitor = {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            if require_accepting {
                ensure_accepting(&state)?;
            }
            if let Some(request_id) = exclusive_owner {
                if state.exclusive_request != Some(request_id) {
                    return Err(FfiError::internal(
                        "capability unsubscribe caller does not own the lifecycle admission gate",
                    ));
                }
            }
            ensure_no_control_transition_except(&state, exclusive_owner)?;
            if !state.capability_subscribed {
                return Ok(());
            }
            state.subscription_transition = true;
            match self.capability_monitor.lock() {
                Ok(mut monitor) => monitor.take(),
                Err(_) => {
                    state.subscription_transition = false;
                    return Err(FfiError::internal("capability monitor state is poisoned"));
                }
            }
        };
        let stop_result = match monitor {
            Some(monitor) => monitor.stop(),
            None => Err(FfiError::internal(
                "subscribed state has no capability monitor",
            )),
        };
        {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            state.capability_subscribed = false;
            state.subscription_transition = false;
        }
        stop_result
    }

    pub fn publish_lifecycle(&self) -> FfiResult<()> {
        self.dispatcher
            .send(CitizenSdkEventType::LifecycleChanged, 0, 0, 0)
    }

    pub(crate) fn publish_history_changed(&self) -> FfiResult<()> {
        self.dispatcher
            .send(CitizenSdkEventType::HistoryChanged, 0, 0, 0)
    }

    /// 和请求完成事件分别预留容量；接纳失败或作业未执行时由所有者析构归还。
    pub(crate) fn reserve_wallet_changed(&self) -> FfiResult<CompletionEventReservation> {
        self.dispatcher.reserve_completion()
    }

    pub(crate) fn publish_wallet_changed(&self, reservation: CompletionEventReservation) -> FfiResult<()> {
        self.dispatcher.send_reserved_wallet_changed(reservation)
    }

    pub(crate) fn publish_finalized_block_changed(
        &self,
        finalized: citizen_sdk_contracts::FinalizedBlockRef,
    ) -> FfiResult<()> {
        let result = ownership::insert(OwnedResult::success(
            self.handle,
            ResultPayload::Block(finalized.into()),
        ))?;
        self.owned_results.fetch_add(1, Ordering::SeqCst);
        if let Err(error) =
            self.dispatcher
                .try_send(CitizenSdkEventType::FinalizedBlockChanged, 0, result, 0)
        {
            let _ = ownership::release(result);
            self.result_released();
            return Err(error);
        }
        Ok(())
    }

    #[cfg(feature = "chain")]
    pub(crate) fn start_product_services(self: &Arc<Self>) -> FfiResult<()> {
        let mut monitor = self
            .chain_monitor
            .lock()
            .map_err(|_| FfiError::internal("chain monitor lock poisoned"))?;
        if monitor.is_some() {
            return Err(FfiError::internal("chain monitor already started"));
        }
        let wallet = self.composition.has_wallet_services();
        if wallet {
            self.provider()?
                .drive(self.engine().start_chain_monitor())?
                .map_err(FfiError::from)?;
        }
        *monitor = Some(crate::chain_monitor::ChainMonitor::start(
            Arc::downgrade(self),
            wallet,
        )?);
        Ok(())
    }

    /// Converge every failure after provider startup side effects into the
    /// one-way failed-start state. Cleanup is best-effort so callers can return
    /// the original causal error unchanged; destroy remains the only recovery.
    #[cfg(feature = "chain")]
    pub fn converge_failed_start(&self) {
        let _ = self.stop_product_services();
        let Ok(provider) = self.provider() else {
            return;
        };
        if matches!(provider.lifecycle(), Ok(ProviderLifecycle::Running)) {
            let _ = provider.stop();
        }
        if matches!(
            self.engine().lifecycle(),
            Ok(citizen_sdk_engine::EngineLifecycle::Starting)
        ) {
            let _ = self.engine().mark_provider_start_failed();
        } else if matches!(
            self.engine().lifecycle(),
            Ok(citizen_sdk_engine::EngineLifecycle::Running)
        ) && matches!(provider.lifecycle(), Ok(ProviderLifecycle::Stopped))
        {
            // 最后一个启动阶段（自有 worker 启动）失败时，不能留下 provider 已停、
            // Engine 却仍 Running 的矛盾事实；实例保持单向停止，只能销毁。
            let _ = self.engine().mark_provider_stopped();
        }
        let _ = self.publish_capabilities();
        let _ = self.publish_lifecycle();
    }

    pub fn shutdown(&self) -> FfiResult<()> {
        {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            if state.control_transition_in_progress() {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Busy,
                    "a CitizenSDK callback, subscription, or lifecycle transition is in progress",
                ));
            }
            if self.pending_requests.load(Ordering::SeqCst) != 0
                || self.owned_results.load(Ordering::SeqCst) != 0
            {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Busy,
                    "release all results and await all requests before destroy",
                ));
            }
            // Freeze reservation while holding the same gate that excludes new
            // product requests. The host adapter linearizes close with its
            // global pending insertion, so the following scan cannot miss a
            // capability-monitor reservation racing this destroy call.
            self.composition.close_host_operation_gate()?;
            if let Err(error) = self.composition.require_no_pending_host_operations() {
                // No teardown state changed. A cancelled Engine future or a
                // capability probe may still own one accepted host callback;
                // BUSY must leave the instance and monitor fully usable.
                self.composition.reopen_host_operation_gate()?;
                return Err(error);
            }
            state.accepting = false;
        }

        // This check must precede every provider or Engine lifecycle side
        // effect. Destroy-from-callback returns Busy while the instance stays
        // intact instead of disposing it and then reporting failure.
        if let Err(error) = self
            .dispatcher
            .ensure_blocking_control_allowed("destroy CitizenSDK")
        {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state is poisoned"))?;
            state.accepting = true;
            self.composition.reopen_host_operation_gate()?;
            return Err(error);
        }

        // With the host gate closed and pending count proven zero, a monitor
        // already between probes can no longer start another callback. Its
        // next reserve fails immediately, so join cannot wait on a new host
        // completion. Errors from this point are teardown-only by contract.
        self.stop_capability_subscription_for_shutdown()?;

        // 产品后台服务若存在，必须先停止并 drain；provider 是最后一个被关闭的依赖。
        self.stop_product_services()?;
        #[cfg(feature = "chain")]
        if let Some(provider) = self.composition.provider() {
            if provider.lifecycle()? == ProviderLifecycle::Running {
                provider.stop()?;
                if self.engine().lifecycle()? == citizen_sdk_engine::EngineLifecycle::Running {
                    self.engine().mark_provider_stopped()?;
                }
            }
        }
        self.engine().dispose()?;
        self.dispatcher.shutdown()
    }

    /// 停止显式 `citizensdk_stop` 前的产品侧服务；顺序与 destroy 共用同一组合边界。
    pub fn stop_product_services(&self) -> FfiResult<()> {
        self.engine().stop_chain_monitor()?;
        #[cfg(feature = "chain")]
        {
            let monitor = self
                .chain_monitor
                .lock()
                .map_err(|_| FfiError::internal("chain monitor lock poisoned"))?
                .take();
            if let Some(monitor) = monitor {
                monitor.stop()?;
            }
        }
        self.composition.stop_and_drain_product_services()
    }
}

fn ensure_accepting(state: &RequestState) -> FfiResult<()> {
    if state.accepting {
        Ok(())
    } else {
        Err(FfiError::new(
            CitizenSdkErrorCode::InvalidState,
            "CitizenSDK is in teardown-only state; retry destroy",
        ))
    }
}

fn ensure_no_control_transition(state: &RequestState) -> FfiResult<()> {
    ensure_no_control_transition_except(state, None)
}

fn ensure_no_control_transition_except(
    state: &RequestState,
    exclusive_owner: Option<CitizenSdkRequestId>,
) -> FfiResult<()> {
    let foreign_exclusive = state
        .exclusive_request
        .is_some_and(|request_id| Some(request_id) != exclusive_owner);
    if state.callback_transition || state.subscription_transition || foreign_exclusive {
        Err(FfiError::new(
            CitizenSdkErrorCode::Busy,
            "a CitizenSDK callback, subscription, or lifecycle transition is in progress",
        ))
    } else {
        Ok(())
    }
}

fn capability_monitor_loop(runtime: Weak<NativeRuntime>, stop: Arc<(Mutex<bool>, Condvar)>) {
    loop {
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        let _ = runtime.refresh_provider_capabilities();
        drop(runtime);

        let Ok(stopped) = stop.0.lock() else {
            return;
        };
        if *stopped {
            return;
        }
        let Ok((stopped, _)) = stop.1.wait_timeout(stopped, Duration::from_millis(500)) else {
            return;
        };
        if *stopped {
            return;
        }
    }
}

#[cfg(all(test, feature = "chain", feature = "transactions"))]
mod tests {
    use std::{
        ffi::c_void,
        sync::{atomic::Ordering, mpsc, Arc, Barrier},
        time::{Duration, Instant},
    };

    use citizen_sdk_smoldot_provider::ProviderLifecycle;

    use crate::{
        abi::{CitizenSdkErrorCode, CitizenSdkEvent, CitizenSdkEventType},
        ownership::{self, ResultHandleAllocator, ResultPayload},
        runtime::NativeRuntime,
    };

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
            include_bytes!("../../../chain/manifest.json"),
            include_bytes!("../../../chain/chainspec.json"),
            include_bytes!("../../../chain/light_sync_state.json"),
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
            assert_eq!(first.accept_request_sequence(sequence).unwrap_err().code, CitizenSdkErrorCode::InvalidArgument);
        }
        for sequence in [1, 2, 4] {
            assert_eq!(first.accept_request_sequence(sequence).unwrap_err().code, CitizenSdkErrorCode::Conflict);
        }
        first.accept_request_sequence(3).unwrap();
        second.accept_request_sequence(2).unwrap();
        assert_eq!(first.pending_requests.load(Ordering::SeqCst), 0);
        first.request_state.lock().unwrap().accepting = false;
        assert_eq!(first.accept_request_sequence(4).unwrap_err().code, CitizenSdkErrorCode::InvalidState);
        assert_eq!(first.request_state.lock().unwrap().next_request_sequence, 4);
    }

    #[test]
    fn request_sequence_admission_is_atomic_and_never_wraps() {
        let runtime = runtime();
        let accepted = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8).map(|_| {
                let runtime = Arc::clone(&runtime);
                scope.spawn(move || runtime.accept_request_sequence(1).map_err(|error| error.code))
            }).collect();
            workers.into_iter().map(|worker| worker.join().unwrap()).collect::<Vec<_>>()
        });
        assert_eq!(accepted.iter().filter(|result| result.is_ok()).count(), 1);
        assert!(accepted.iter().filter_map(|result| result.as_ref().err()).all(|code| *code == CitizenSdkErrorCode::Conflict));
        runtime.request_state.lock().unwrap().next_request_sequence = i64::MAX as u64;
        assert_eq!(runtime.accept_request_sequence(i64::MAX as u64).unwrap_err().code, CitizenSdkErrorCode::Integrity);
        assert_eq!(runtime.request_state.lock().unwrap().next_request_sequence, i64::MAX as u64);
    }

    fn runtime_with_exhausted_result_handles() -> Arc<NativeRuntime> {
        let assets = crate::assets::verify_assets(
            include_bytes!("../../../chain/manifest.json"),
            include_bytes!("../../../chain/chainspec.json"),
            include_bytes!("../../../chain/light_sync_state.json"),
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
    fn retained_wallet_state_uses_existing_owner_allocator_and_shutdown_gate() {
        use crate::{error::FfiError, ownership::OwnedResult};
        let runtime = runtime();
        let snapshot = citizen_sdk_engine::WalletStateSnapshot::from_state(
            &citizen_sdk_contracts::WalletState::empty()).unwrap();
        let source = ownership::insert(OwnedResult::success(runtime.handle,
            ResultPayload::WalletState(Box::new(snapshot.clone())))).unwrap();
        let retained = runtime.retain_wallet_state(source).unwrap();
        assert_ne!(source, retained);
        ownership::release(source).unwrap();
        assert!(ownership::get(retained).is_ok());
        assert!(runtime.retain_wallet_state(source).is_err());
        assert_eq!(runtime.owned_results.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.shutdown().unwrap_err().code, CitizenSdkErrorCode::Busy);
        for wrong in [
            OwnedResult::success(runtime.handle + 1, ResultPayload::WalletState(Box::new(snapshot.clone()))),
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
    fn qr_cancel_after_work_before_commit_suppresses_success_and_keeps_destroy_busy_until_release()
    {
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
                Err(error)
                    if error.code == CitizenSdkErrorCode::Busy && Instant::now() < deadline =>
                {
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

        // Hold a shared request on another thread. The exclusive reservation
        // must fail until that exact admission is released, while a second
        // shared reservation remains valid for the legacy contract.
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
                Err(error)
                    if error.code == CitizenSdkErrorCode::Busy && Instant::now() < deadline =>
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
}
