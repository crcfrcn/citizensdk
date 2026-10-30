use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::Weak;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;

#[cfg(feature = "chain")]
use crate::chain::ProviderLifecycle;
#[cfg(feature = "chain")]
use crate::chain::SmoldotVerifiedChainClient;
use crate::types::CapabilitySnapshot;
use crate::CitizenEngine;

use crate::abi::capabilities::require_snapshot;
use crate::abi::error::FfiError;
use crate::abi::error::FfiResult;
use crate::abi::events::CompletionEventReservation;
use crate::abi::events::EventDispatcher;
use crate::abi::ownership;
use crate::abi::ownership::OwnedResult;
use crate::abi::ownership::ResultHandleAllocator;
use crate::abi::ownership::ResultPayload;
use crate::abi::ownership::ResultReservation;
use crate::abi::requests::RequestCancellation;
use crate::abi::types::CitizenSdkErrorCode;
use crate::abi::types::CitizenSdkEventCallback;
use crate::abi::types::CitizenSdkEventType;
use crate::abi::types::CitizenSdkHandle;
use crate::abi::types::CitizenSdkRequestId;
use crate::abi::types::CitizenSdkResultHandle;

struct RequestState {
    accepting: bool,
    next_request: u64,
    // 通道序号独立于原生request_id；各平台共用此实例唯一接纳状态。
    next_request_sequence: u64,
    exclusive_request: Option<CitizenSdkRequestId>,
    callback_registered: bool,
    foreign_detached: bool,
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
    catalog: bool,
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
    #[cfg(feature = "chain")]
    provider: Option<Arc<SmoldotVerifiedChainClient>>,
    engine: Arc<CitizenEngine>,
    modules: crate::types::Modules,
    public_store: Option<Arc<crate::store::PublicStore<crate::store::sqlite::Sqlite>>>,
    secure_store: Option<Arc<crate::store::SecureStore<crate::store::sqlite::Sqlite>>>,
    host_services: Option<crate::host::HostSecretVault>,
    dispatcher: EventDispatcher,
    result_handles: &'static ResultHandleAllocator,
    #[cfg(test)]
    test_resources: Vec<Box<dyn std::any::Any + Send + Sync>>,
    request_state: Mutex<RequestState>,
    pending_requests: AtomicU64,
    owned_results: AtomicU64,
    cancellations: Mutex<HashMap<CitizenSdkRequestId, PendingRequest>>,
    capability_monitor: Mutex<Option<CapabilityMonitor>>,
    #[cfg(feature = "chain")]
    chain_monitor: Mutex<Option<crate::abi::chain_monitor::ChainMonitor>>,
}

impl NativeRuntime {
    /// 外壳先接纳一次，再解方法参数；单次参数失败不得封死后续合法请求。
    /// 只保护传输关联，不分配原生请求，不触发业务、设备或网络操作。
    pub(crate) fn accept_request_sequence(&self, sequence: u64) -> FfiResult<()> {
        if sequence == 0 || sequence > i64::MAX as u64 {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidArgument,
                "invalid request sequence",
            ));
        }
        let mut state = self
            .request_state
            .lock()
            .map_err(|_| FfiError::internal("request state is poisoned"))?;
        if !state.accepting {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "instance is shutting down",
            ));
        }
        if sequence != state.next_request_sequence {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Conflict,
                "request sequence is not the next instance sequence",
            ));
        }
        if state.next_request_sequence == i64::MAX as u64 {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Integrity,
                "request sequence space is exhausted",
            ));
        }
        state.next_request_sequence += 1;
        Ok(())
    }

    pub(crate) fn private_key_view_vault(
        &self,
        authorizing: Arc<dyn Fn(u64) -> i32 + Send + Sync>,
    ) -> Option<Arc<dyn crate::types::SecretVault>> {
        self.host_services
            .as_ref()
            .and_then(|host| host.private_key_view_vault(authorizing))
    }

    pub const fn handle(&self) -> CitizenSdkHandle {
        self.handle
    }

    pub fn engine(&self) -> &Arc<CitizenEngine> {
        &self.engine
    }

    pub(crate) const fn has_modules(&self, bits: u32) -> bool {
        self.modules.contains(bits)
    }

    #[cfg(feature = "chain")]
    pub fn provider(&self) -> FfiResult<&Arc<SmoldotVerifiedChainClient>> {
        self.provider.as_ref().ok_or_else(|| {
            FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain module is not selected",
            )
        })
    }

    /// 同一工作线程驱动已组合的真实依赖；纯钱包/签名不创建轻节点运行时。
    pub fn drive<F: std::future::Future>(&self, future: F) -> FfiResult<F::Output> {
        #[cfg(feature = "chain")]
        if let Some(provider) = self.provider.as_ref() {
            return provider.drive(future).map_err(FfiError::from);
        }
        Ok(futures_executor::block_on(future))
    }

    /// # Safety
    /// Non-null copied host callbacks must outlive successful destruction.
    /// 直接创建唯一业务引擎和请求所有者；不创建装配容器或会话仓储替身。
    pub unsafe fn new_with_modules(
        handle: CitizenSdkHandle,
        combined_chain_spec: Option<String>,
        system_name: String,
        system_version: String,
        modules: crate::types::Modules,
        store: crate::store::sqlite::Stores,
    ) -> FfiResult<Arc<Self>> {
        use crate::types::{
            ChainDatabaseStore, EncryptedSecretBlobStore, Modules, RuntimeCacheStore,
            TransactionHistoryStore, WalletProfileStore,
        };
        crate::capabilities::validate_modules(modules.bits())?;
        let secure_selected = modules.bits() & (Modules::WALLET | Modules::SIGNING) != 0;
        if modules.contains(Modules::CHAIN) && store.public.is_none() {
            return Err(FfiError::invalid("chain requires a public SQLite resource"));
        }
        if secure_selected && (store.secure.is_none() || store.vault.is_none()) {
            return Err(FfiError::invalid(
                "wallet/signing requires secure SQLite and device vault",
            ));
        }
        if !secure_selected && (store.secure.is_some() || store.vault.is_some()) {
            return Err(FfiError::invalid("unselected secure resources supplied"));
        }
        if !modules.contains(Modules::CHAIN) && store.public.is_some() {
            return Err(FfiError::invalid("unselected public resource supplied"));
        }
        let public = store
            .public
            .map(|db| Arc::new(crate::store::PublicStore::new(db)));
        let secure = store
            .secure
            .map(|db| Arc::new(crate::store::SecureStore::new(db)));
        let vault = store
            .vault
            .as_ref()
            .map(|value| Arc::new(value.clone()) as Arc<dyn crate::types::SecretVault>);
        if secure_selected && vault.is_none() {
            return Err(FfiError::invalid("device vault missing"));
        }
        #[cfg(feature = "chain")]
        let provider = if modules.contains(Modules::CHAIN) {
            let config = crate::chain::SmoldotProviderConfig::try_new(
                combined_chain_spec
                    .ok_or_else(|| FfiError::invalid("chain assets are required"))?,
                system_name,
                system_version,
            )?
            .with_bootstrap();
            Some(crate::chain::SmoldotVerifiedChainClient::new(config)?)
        } else {
            None
        };
        #[cfg(not(feature = "chain"))]
        let _ = (combined_chain_spec, system_name, system_version);
        #[cfg(feature = "chain")]
        let chain = provider
            .as_ref()
            .map(|p| Arc::clone(p) as Arc<dyn crate::types::VerifiedChainClient>);
        #[cfg(not(feature = "chain"))]
        let chain = None;

        let mut engine = CitizenEngine::new(
            chain,
            vault,
            public
                .as_ref()
                .map(|db| Arc::clone(db) as Arc<dyn ChainDatabaseStore>),
            public
                .as_ref()
                .map(|db| Arc::clone(db) as Arc<dyn RuntimeCacheStore>),
            secure
                .as_ref()
                .map(|db| Arc::clone(db) as Arc<dyn WalletProfileStore>),
            if modules.contains(Modules::HISTORY) {
                public
                    .as_ref()
                    .map(|db| Arc::clone(db) as Arc<dyn TransactionHistoryStore>)
            } else {
                None
            },
            secure
                .as_ref()
                .map(|db| Arc::clone(db) as Arc<dyn EncryptedSecretBlobStore>),
        )
        .with_modules(modules);
        #[cfg(feature = "chain")]
        if let Some(provider) = provider.as_ref() {
            engine = engine.with_account_nonce_source(
                Arc::clone(provider) as Arc<dyn crate::types::AccountNonceSource>
            );
        }
        let engine = Arc::new(engine);
        let facts = if secure.is_some() {
            crate::abi::capabilities::ProductCapabilityFacts::wallet_configured()
        } else {
            crate::abi::capabilities::ProductCapabilityFacts::chain_only()
        };
        engine.update_capabilities(crate::abi::capabilities::product_probes(
            false,
            facts,
            modules,
            modules.contains(Modules::HISTORY) && public.is_some(),
        ))?;
        let result_handles = &ownership::RESULT_HANDLES;

        Ok(Arc::new(Self {
            handle,
            #[cfg(feature = "chain")]
            provider,
            engine,
            modules,
            public_store: public,
            secure_store: secure,
            host_services: store.vault,
            dispatcher: EventDispatcher::with_catalog_reserve(8)?,
            result_handles,
            request_state: Mutex::new(RequestState {
                accepting: true,
                next_request: 1,
                next_request_sequence: 1,
                exclusive_request: None,
                callback_registered: false,
                foreign_detached: false,
                callback_transition: false,
                capability_subscribed: false,
                subscription_transition: false,
            }),
            pending_requests: AtomicU64::new(0),
            owned_results: AtomicU64::new(0),
            cancellations: Mutex::new(HashMap::new()),
            capability_monitor: Mutex::new(None),
            #[cfg(test)]
            test_resources: Vec::new(),
            #[cfg(feature = "chain")]
            chain_monitor: Mutex::new(None),
        }))
    }

    pub fn uses_host_services(&self) -> bool {
        self.modules.contains(crate::types::Modules::CHAIN) && self.public_store.is_some()
    }

    pub(crate) fn attach_value_callback(
        &self,
        callback: crate::abi::dart::ValueCallback,
        post: crate::abi::dart::Post,
        port: i64,
    ) -> FfiResult<()> {
        let state = self
            .request_state
            .lock()
            .map_err(|_| FfiError::internal("request state poisoned"))?;
        ensure_no_control_transition(&state)?;
        if self.pending_requests.load(Ordering::SeqCst) != 0 {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Busy,
                "requests are pending",
            ));
        }
        if state.foreign_detached {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "receiver retired",
            ));
        }
        self.dispatcher.attach_value(callback, post, port)
    }
    pub(crate) fn ensure_value_callback(&self) -> FfiResult<()> {
        self.dispatcher.ensure_value()
    }
    pub(crate) fn detach_value_callback(&self) -> FfiResult<()> {
        let ids = {
            let mut state = self
                .request_state
                .lock()
                .map_err(|_| FfiError::internal("request state poisoned"))?;
            if state.foreign_detached {
                return Ok(());
            }
            state.foreign_detached = true;
            self.cancellations
                .lock()
                .map_err(|_| FfiError::internal("request state poisoned"))?
                .iter()
                .filter(|(_, r)| r.completion_event.is_foreign())
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
        };
        // 不持请求锁等待发送结束；平台原回调仍可重入并完成真实认证。
        self.dispatcher.detach_value()?;
        for id in ids {
            let _ = self.request_cancel(id);
        }
        // 入队不等于接收：只回收已经交付Dart的结果，无需等待isolate回复。
        for _ in 0..ownership::reclaim_foreign(self.handle) {
            self.result_released();
        }
        Ok(())
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
        self.begin_request_with_policy(cancellable, false, false)
    }

    /// Reserves one host-composed start, stop or import operation that cannot
    /// overlap any asynchronous SDK request. It closes every interval in which
    /// provider side effects and the corresponding Engine lifecycle transition
    /// must remain one indivisible operation.
    pub fn begin_exclusive_request(
        &self,
    ) -> FfiResult<(CitizenSdkRequestId, Option<RequestCancellation>)> {
        self.begin_request_with_policy(false, true, false)
    }

    /// 本地只读不等待链启停；关闭和回调更换仍具有完整排他性。
    pub(crate) fn begin_catalog_request(
        &self,
    ) -> FfiResult<(CitizenSdkRequestId, Option<RequestCancellation>)> {
        self.begin_request_with_policy(true, false, true)
    }

    fn begin_request_with_policy(
        &self,
        cancellable: bool,
        exclusive: bool,
        catalog: bool,
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
        if state.callback_transition
            || (!catalog && (state.subscription_transition || state.exclusive_request.is_some()))
        {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Busy,
                "a CitizenSDK callback, subscription, or lifecycle transition is in progress",
            ));
        }
        // 完成过程会先移除登记、再提交结果并归还计数；两者之间仍须排空普通请求。
        // 已移除的本地请求至多使启停短暂返回Busy，不能放行尚未完成的普通请求。
        let catalog_pending = self
            .cancellations
            .lock()
            .map_err(|_| FfiError::internal("request cancellation state is poisoned"))?
            .values()
            .filter(|request| request.catalog)
            .count() as u64;
        if exclusive && self.pending_requests.load(Ordering::SeqCst) > catalog_pending {
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
        if crate::abi::dart::owns(self.handle) && state.foreign_detached {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "receiver retired",
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
        let completion_event = if catalog {
            self.dispatcher.reserve_catalog_completion()?
        } else {
            self.dispatcher.reserve_completion()?
        };
        let completion_event = if crate::abi::dart::owns(self.handle) {
            self.dispatcher.ensure_value()?;
            completion_event.foreign()
        } else {
            completion_event
        };
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
                    catalog,
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
    pub fn request_cancellation_flag(
        &self,
        request_id: CitizenSdkRequestId,
    ) -> FfiResult<Arc<AtomicBool>> {
        self.cancellations
            .lock()
            .map_err(|_| FfiError::internal("request cancellation state is poisoned"))?
            .get(&request_id)
            .map(|request| Arc::clone(&request.cancelled))
            .ok_or_else(|| {
                FfiError::new(CitizenSdkErrorCode::NotFound, "request id is not pending")
            })
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
            catalog,
        }) = pending
        else {
            return;
        };
        // 只撤销本次公开目录结果；真实load和宿主completion退出后才完成请求。
        let outcome = if catalog && matches!(cancellation, CancellationState::Requested) {
            Err(FfiError::new(
                CitizenSdkErrorCode::Cancelled,
                "wallet catalog read cancelled",
            ))
        } else {
            outcome
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
            debug_assert!(previous > 0);
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
        event: crate::types::ExtrinsicWatchEvent,
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
    pub fn retain_wallet_state(
        &self,
        result: CitizenSdkResultHandle,
    ) -> FfiResult<CitizenSdkResultHandle> {
        let state = self
            .request_state
            .lock()
            .map_err(|_| FfiError::internal("request state is poisoned"))?;
        ensure_accepting(&state)?;
        let owned = ownership::get(result)?;
        if owned.foreign && state.foreign_detached {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "receiver retired",
            ));
        }
        if owned.owner != self.handle
            || owned.code != CitizenSdkErrorCode::Ok
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

    /// 本地钱包完整能力仍由真实仓储和金库决定，不探测provider或历史。
    pub(crate) fn refresh_local_wallet_capabilities(&self) -> FfiResult<CapabilitySnapshot> {
        let before = self.capability_snapshot()?.revision();
        let snapshot = self
            .engine()
            .update_local_wallet_readiness(self.local_wallet_probes())?;
        if snapshot.revision() != before {
            self.dispatcher.send(
                CitizenSdkEventType::CapabilitiesChanged,
                0,
                0,
                snapshot.revision(),
            )?;
        }
        Ok(snapshot)
    }

    pub(crate) fn drive_local<F: std::future::Future>(&self, future: F) -> FfiResult<F::Output> {
        Ok(futures_executor::block_on(future))
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
        let status_error = if let Some(provider) = self.provider.as_ref() {
            let lifecycle = provider.lifecycle()?;
            if lifecycle == ProviderLifecycle::Running {
                match provider.drive(provider.status()) {
                    Ok(Ok(status)) => (
                        crate::abi::capabilities::provider_runtime_ready(
                            lifecycle,
                            status.is_usable,
                        ),
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
                .update_capabilities(self.capability_probes(status_error.0))?
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

    pub(crate) fn publish_wallet_changed(
        &self,
        reservation: CompletionEventReservation,
    ) -> FfiResult<()> {
        self.dispatcher.send_reserved_wallet_changed(reservation)
    }

    pub(crate) fn publish_finalized_block_changed(
        &self,
        finalized: crate::types::FinalizedBlockRef,
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
        let wallet = self.has_wallet_services();
        if wallet {
            self.provider()?
                .drive(self.engine().start_chain_monitor())?
                .map_err(FfiError::from)?;
        }
        *monitor = Some(crate::abi::chain_monitor::ChainMonitor::start(
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
            Ok(crate::EngineLifecycle::Starting)
        ) {
            let _ = self.engine().mark_provider_start_failed();
        } else if matches!(
            self.engine().lifecycle(),
            Ok(crate::EngineLifecycle::Running)
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
            self.close_host_operation_gate()?;
            if let Err(error) = self.require_no_pending_host_operations() {
                // No teardown state changed. A cancelled Engine future or a
                // capability probe may still own one accepted host callback;
                // BUSY must leave the instance and monitor fully usable.
                self.reopen_host_operation_gate()?;
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
            self.reopen_host_operation_gate()?;
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
        if let Some(provider) = self.provider.as_ref() {
            if provider.lifecycle()? == ProviderLifecycle::Running {
                provider.stop()?;
                if self.engine().lifecycle()? == crate::EngineLifecycle::Running {
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
        self.stop_and_drain_product_services()
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
#[path = "../tests/abi/runtime.rs"]
mod tests;

impl NativeRuntime {
    pub(crate) fn require_no_pending_host_operations(&self) -> FfiResult<()> {
        let Some(host) = self.host_services.as_ref() else {
            return Ok(());
        };
        if host.pending_host_operations().map_err(FfiError::from)? == 0 {
            Ok(())
        } else {
            Err(FfiError::new(
                crate::abi::types::CitizenSdkErrorCode::Busy,
                "host operations are still pending; retry destroy after completion",
            ))
        }
    }

    pub(crate) fn close_host_operation_gate(&self) -> FfiResult<()> {
        self.host_services
            .as_ref()
            .map_or(Ok(()), |host| host.close_host_operation_gate())
            .map_err(FfiError::from)
    }

    pub(crate) fn reopen_host_operation_gate(&self) -> FfiResult<()> {
        self.host_services
            .as_ref()
            .map_or(Ok(()), |host| host.reopen_host_operation_gate())
            .map_err(FfiError::from)
    }

    pub(crate) fn stop_and_drain_product_services(&self) -> FfiResult<()> {
        self.engine.stop_chain_monitor()?;
        futures_executor::block_on(self.engine.drain_chain_monitor()).map_err(FfiError::from)?;
        #[cfg(feature = "chain")]
        if let Some(provider) = self.provider.as_ref() {
            if matches!(
                provider.lifecycle(),
                Ok(crate::chain::ProviderLifecycle::Running)
            ) {
                provider
                    .drive(provider.drain_finalized_subscriptions())?
                    .map_err(FfiError::from)?;
            }
        }
        Ok(())
    }

    fn has_wallet_services(&self) -> bool {
        self.modules.contains(
            crate::types::Modules::WALLET
                | crate::types::Modules::CHAIN
                | crate::types::Modules::HISTORY,
        ) && self.secure_store.is_some()
            && self.public_store.is_some()
    }
    fn capability_probes(&self, usable: bool) -> Vec<crate::CapabilityProbe> {
        crate::abi::capabilities::product_probes(
            usable,
            self.wallet_capability_facts(true),
            self.modules,
            self.modules.contains(crate::types::Modules::HISTORY) && self.public_store.is_some(),
        )
    }
    fn local_wallet_probes(&self) -> Vec<crate::CapabilityProbe> {
        crate::abi::capabilities::product_probes(
            false,
            self.wallet_capability_facts(false),
            self.modules,
            self.modules.contains(crate::types::Modules::HISTORY) && self.public_store.is_some(),
        )
    }
    fn wallet_capability_facts(
        &self,
        probe_history: bool,
    ) -> crate::abi::capabilities::ProductCapabilityFacts {
        use crate::abi::capabilities::ProductCapabilityFacts;
        use crate::types::{
            EncryptedSecretBlobStore, TransactionHistoryStore, VaultAvailability,
            WalletProfileStore,
        };
        let history_ready = probe_history
            && self.modules.contains(crate::types::Modules::HISTORY)
            && self
                .public_store
                .as_ref()
                .is_some_and(|db| futures_executor::block_on(db.load_index()).is_ok());
        let Some(secure) = self.secure_store.as_ref() else {
            return ProductCapabilityFacts::chain_only().with_history(history_ready, false);
        };
        let Some(vault) = self
            .host_services
            .as_ref()
            .map(|host| Arc::new(host.clone()) as Arc<dyn crate::types::SecretVault>)
        else {
            return ProductCapabilityFacts::chain_only().with_history(history_ready, false);
        };
        let availability = futures_executor::block_on(vault.availability())
            .unwrap_or(VaultAvailability::Unavailable);
        let wallet = futures_executor::block_on(WalletProfileStore::load(secure.as_ref())).ok();
        let encrypted = wallet.as_ref().is_some_and(|state| state.profile().is_none_or(|p| p.accounts().iter().all(|account| {
            matches!(futures_executor::block_on(EncryptedSecretBlobStore::load(secure.as_ref(), account.secret_ref())), Ok(s) if s.envelope().is_some())
        })));
        let key = availability == VaultAvailability::Available
            && wallet.as_ref().is_some_and(|state| {
                state.profile().is_none_or(|p| {
                    matches!(
                        futures_executor::block_on(
                            vault.has_wallet_key(p.wallet_index(), p.generation())
                        ),
                        Ok(true)
                    )
                })
            });
        ProductCapabilityFacts::wallet(
            availability,
            wallet.is_some(),
            encrypted,
            key,
            history_ready,
            false,
        )
    }
}
