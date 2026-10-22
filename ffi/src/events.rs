use std::{
    ffi::c_void,
    sync::{mpsc, Arc, Condvar, Mutex},
    thread::{self, JoinHandle, ThreadId},
};

use crate::{
    abi::{
        CitizenSdkEvent, CitizenSdkEventCallback, CitizenSdkEventType, CitizenSdkRequestId,
        CitizenSdkResultHandle, CITIZENSDK_ABI_VERSION,
    },
    error::{FfiError, FfiResult},
};

const EVENT_QUEUE_CAPACITY: usize = 64;

#[derive(Clone, Copy)]
struct CallbackRegistration {
    callback: unsafe extern "C" fn(*mut c_void, *const CitizenSdkEvent),
    context: usize,
}

struct DispatchState {
    active: bool,
    callback: Option<CallbackRegistration>,
    value_callback: Option<crate::dart::Registration>,
    callbacks_in_flight: usize,
    value_in_flight:usize,
    dispatcher_thread: Option<ThreadId>,
    callback_generation: u64,
}

struct EnqueueState {
    next_sequence: u64,
    reserved_completions: u64,
    queued: usize,
}

/// One mandatory completion-event capacity unit reserved before an async
/// request becomes visible to the host. Dropping an uncommitted reservation
/// returns only the capacity; sequence numbers are assigned at enqueue time so
/// concurrent completions remain strictly ordered by callback observation.
pub struct CompletionEventReservation {
    state: Arc<Mutex<EnqueueState>>,
    committed: bool,
    foreign: bool,
}

impl CompletionEventReservation {pub(crate) fn foreign(mut self)->Self{self.foreign=true;self} pub(crate) fn is_foreign(&self)->bool{self.foreign}}
impl Drop for CompletionEventReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.reserved_completions != 0 {
            state.reserved_completions -= 1;
        }
    }
}

enum DispatchMessage {
    Event {
        event: CitizenSdkEvent,
        callback_generation: u64,
        foreign: bool,
    },
    Shutdown,
}

/// Per-instance event thread. The callback is invoked without any SDK lock so
/// ordinary SDK calls are reentrant. Destroying from the callback itself is
/// rejected rather than deadlocking while waiting for its own return.
pub struct EventDispatcher {
    sender: mpsc::SyncSender<DispatchMessage>,
    state: Arc<(Mutex<DispatchState>, Condvar)>,
    join: Mutex<Option<JoinHandle<()>>>,
    enqueue: Arc<Mutex<EnqueueState>>,
    catalog_reserve: usize,
}

impl EventDispatcher {
    pub fn new() -> FfiResult<Self> { Self::with_catalog_reserve(0) }

    /// 运行实例为本地只读保留真实槽位；普通事件和网络请求都不能占用。
    pub(crate) fn with_catalog_reserve(catalog_reserve: usize) -> FfiResult<Self> {
        if catalog_reserve >= EVENT_QUEUE_CAPACITY { return Err(FfiError::invalid("invalid catalog event reserve")); }
        let (sender, receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let state = Arc::new((
            Mutex::new(DispatchState {
                active: true,
                callback: None,
                value_callback: None,
                callbacks_in_flight: 0,
                value_in_flight:0,
                dispatcher_thread: None,
                callback_generation: 1,
            }),
            Condvar::new(),
        ));
        let thread_state = Arc::clone(&state);
        let enqueue = Arc::new(Mutex::new(EnqueueState {
            next_sequence: 1,
            reserved_completions: 0,
            queued: 0,
        }));
        let thread_enqueue = Arc::clone(&enqueue);
        let join = thread::Builder::new()
            .name("citizensdk-events".to_owned())
            .spawn(move || dispatch_loop(receiver, thread_state, thread_enqueue))
            .map_err(|error| {
                FfiError::internal(format!("failed to start event dispatcher: {error}"))
            })?;
        Ok(Self {
            sender,
            state,
            join: Mutex::new(Some(join)),
            enqueue,
            catalog_reserve,
        })
    }

    pub fn set_callback(
        &self,
        callback: CitizenSdkEventCallback,
        context: *mut c_void,
    ) -> FfiResult<()> {
        let (lock, _) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| FfiError::internal("event dispatcher state is poisoned"))?;
        if !state.active {
            return Err(FfiError::new(
                crate::abi::CitizenSdkErrorCode::InvalidState,
                "event dispatcher is stopped",
            ));
        }
        if state.dispatcher_thread == Some(thread::current().id()) && state.callbacks_in_flight != 0
        {
            return Err(FfiError::new(
                crate::abi::CitizenSdkErrorCode::Busy,
                "event callback cannot replace itself before returning",
            ));
        }
        while state.callbacks_in_flight != 0 {
            state = self
                .state
                .1
                .wait(state)
                .map_err(|_| FfiError::internal("event dispatcher state is poisoned"))?;
        }
        state.callback_generation = state
            .callback_generation
            .checked_add(1)
            .filter(|generation| *generation != 0)
            .ok_or_else(|| FfiError::internal("callback generation space is exhausted"))?;
        state.callback = callback.map(|callback| CallbackRegistration {
            callback,
            context: context as usize,
        });
        Ok(())
    }

    pub(crate) fn attach_value(&self,callback:crate::dart::ValueCallback,post:crate::dart::Post,port:i64)->FfiResult<()>{
      let callback=callback.ok_or_else(||FfiError::invalid("value callback missing"))?;
      let mut state=self.state.0.lock().map_err(|_|FfiError::internal("event state poisoned"))?;
      if !state.active||state.value_callback.is_some(){return Err(FfiError::new(crate::abi::CitizenSdkErrorCode::InvalidState,"value callback already attached or stopped"));}
      if port<=0||post.is_none(){return Err(FfiError::invalid("receiver port invalid"));}state.value_callback=Some(crate::dart::Registration{callback,post,port});Ok(())
    }
    pub(crate) fn detach_value(&self)->FfiResult<()>{
      let mut state=self.state.0.lock().map_err(|_|FfiError::internal("event state poisoned"))?;let receiver=state.value_callback.take();
      while state.value_in_flight!=0{state=self.state.1.wait(state).map_err(|_|FfiError::internal("event state poisoned"))?;}
      drop(state);if let Some(receiver)=receiver{receiver.post(&CitizenSdkEvent{struct_size:std::mem::size_of::<CitizenSdkEvent>() as u32,abi_version:1,event_type:0,reserved:0,sequence:0,request_id:0,result:0,capability_revision:0});}Ok(())
    }
    pub(crate) fn ensure_value(&self)->FfiResult<()>{
      let state=self.state.0.lock().map_err(|_|FfiError::internal("event state poisoned"))?;
      if !state.active||state.value_callback.is_none(){return Err(FfiError::new(crate::abi::CitizenSdkErrorCode::InvalidState,"value callback unavailable"));}Ok(())
    }
    pub fn send(
        &self,
        event_type: CitizenSdkEventType,
        request_id: CitizenSdkRequestId,
        result: CitizenSdkResultHandle,
        capability_revision: u64,
    ) -> FfiResult<()> {
        // 所有非预留事件均即时入队；禁止持有生产者锁等待回调释放容量。
        self.try_send(event_type, request_id, result, capability_revision)
    }

    /// Non-critical stream updates never grow memory without bound. A full
    /// queue reports QueueFull. 已接收请求的完成事件使用独立预留的真实槽位。
    pub fn try_send(
        &self,
        event_type: CitizenSdkEventType,
        request_id: CitizenSdkRequestId,
        result: CitizenSdkResultHandle,
        capability_revision: u64,
    ) -> FfiResult<()> {
        let mut enqueue = self
            .enqueue
            .lock()
            .map_err(|_| FfiError::internal("event enqueue state is poisoned"))?;
        let generation = self.current_generation()?;
        let (sequence, following) = reserve_unreserved_sequence(&enqueue)?;
        ensure_capacity(&enqueue, EVENT_QUEUE_CAPACITY - self.catalog_reserve)?;
        self.sender
            .try_send(DispatchMessage::Event {
                event: CitizenSdkEvent {
                    struct_size: std::mem::size_of::<CitizenSdkEvent>() as u32,
                    abi_version: CITIZENSDK_ABI_VERSION,
                    event_type: event_type as u32,
                    reserved: 0,
                    sequence,
                    request_id,
                    result,
                    capability_revision,
                },
                callback_generation: generation,
                foreign: false,
            })
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => FfiError::new(
                    crate::abi::CitizenSdkErrorCode::QueueFull,
                    "CitizenSDK event queue is full",
                ),
                mpsc::TrySendError::Disconnected(_) => {
                    FfiError::internal("event dispatcher disconnected")
                }
            })?;
        enqueue.next_sequence = following;
        enqueue.queued += 1;
        Ok(())
    }

    /// Reserve the capacity required for one mandatory completion before the
    /// request is accepted. Other event producers cannot consume this unit.
    pub fn reserve_completion(&self) -> FfiResult<CompletionEventReservation> {
        self.reserve_completion_with_policy(false)
    }
    pub(crate) fn reserve_catalog_completion(&self) -> FfiResult<CompletionEventReservation> {
        self.reserve_completion_with_policy(true)
    }
    fn reserve_completion_with_policy(&self, catalog: bool) -> FfiResult<CompletionEventReservation> {
        let mut enqueue = self
            .enqueue
            .lock()
            .map_err(|_| FfiError::internal("event enqueue state is poisoned"))?;
        self.current_generation()?;
        let remaining = remaining_sequences(enqueue.next_sequence);
        if enqueue.reserved_completions >= remaining {
            return Err(FfiError::internal(
                "event sequence space cannot reserve another request completion",
            ));
        }
        // 预留的是有界队列真实容量，不仅是 sequence。普通事件不能占用它。
        ensure_capacity(&enqueue, if catalog { EVENT_QUEUE_CAPACITY } else { EVENT_QUEUE_CAPACITY - self.catalog_reserve })?;
        enqueue.reserved_completions = enqueue
            .reserved_completions
            .checked_add(1)
            .ok_or_else(|| FfiError::internal("completion reservation count exhausted"))?;
        Ok(CompletionEventReservation {
            state: Arc::clone(&self.enqueue),
            committed: false,
            foreign: false,
        })
    }

    #[cfg(test)]
    pub fn exhaust_sequences_for_test(&self) {
        self.set_next_sequence_for_test(u64::MAX);
    }

    #[cfg(test)]
    pub fn set_next_sequence_for_test(&self, next_sequence: u64) {
        let mut enqueue = self
            .enqueue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        enqueue.next_sequence = next_sequence;
    }

    /// Consume one pre-acceptance completion reservation and enqueue its event
    /// with the next callback-observed sequence number.
    pub fn send_reserved_completion(
        &self,
        reservation: CompletionEventReservation,
        request_id: CitizenSdkRequestId,
        result: CitizenSdkResultHandle,
    ) -> FfiResult<()> {
        self.send_reserved(reservation, CitizenSdkEventType::RequestCompleted, request_id, result)
    }

    /// 钱包操作接纳前预留真实队列槽，避免写后因队列满丢失目录通知。
    pub fn send_reserved_wallet_changed(&self, reservation: CompletionEventReservation) -> FfiResult<()> {
        self.send_reserved(reservation, CitizenSdkEventType::WalletChanged, 0, 0)
    }

    fn send_reserved(
        &self,
        mut reservation: CompletionEventReservation,
        event_type: CitizenSdkEventType,
        request_id: CitizenSdkRequestId,
        result: CitizenSdkResultHandle,
    ) -> FfiResult<()> {
        if !Arc::ptr_eq(&reservation.state, &self.enqueue) {
            return Err(FfiError::internal(
                "completion reservation belongs to another dispatcher",
            ));
        }
        let mut enqueue = self
            .enqueue
            .lock()
            .map_err(|_| FfiError::internal("event enqueue state is poisoned"))?;
        if enqueue.reserved_completions == 0 {
            return Err(FfiError::internal(
                "completion reservation accounting is empty",
            ));
        }
        let generation = self.current_generation()?;
        let (sequence, following) = reserve_sequence(enqueue.next_sequence)?;
        self.sender
            .try_send(DispatchMessage::Event {
                event: CitizenSdkEvent {
                    struct_size: std::mem::size_of::<CitizenSdkEvent>() as u32,
                    abi_version: CITIZENSDK_ABI_VERSION,
                    event_type: event_type as u32,
                    reserved: 0,
                    sequence,
                    request_id,
                    result,
                    capability_revision: 0,
                },
                callback_generation: generation,
                foreign: reservation.foreign,
            })
            .map_err(|_| FfiError::internal("event dispatcher disconnected"))?;
        enqueue.next_sequence = following;
        enqueue.queued += 1;
        enqueue.reserved_completions -= 1;
        reservation.committed = true;
        Ok(())
    }

    /// Reject a control call which could wait on this dispatcher while it is
    /// executing the caller's callback. The preflight must run before any
    /// subscription or lifecycle side effect.
    pub fn ensure_blocking_control_allowed(&self, operation: &str) -> FfiResult<()> {
        let (lock, _) = &*self.state;
        let state = lock
            .lock()
            .map_err(|_| FfiError::internal("event dispatcher state is poisoned"))?;
        if state.dispatcher_thread == Some(thread::current().id()) && state.callbacks_in_flight != 0
        {
            return Err(FfiError::new(
                crate::abi::CitizenSdkErrorCode::Busy,
                format!("cannot {operation} from the CitizenSDK event callback"),
            ));
        }
        Ok(())
    }

    fn current_generation(&self) -> FfiResult<u64> {
        let (lock, _) = &*self.state;
        let state = lock
            .lock()
            .map_err(|_| FfiError::internal("event dispatcher state is poisoned"))?;
        if !state.active {
            return Err(FfiError::new(
                crate::abi::CitizenSdkErrorCode::InvalidState,
                "event dispatcher is stopped",
            ));
        }
        Ok(state.callback_generation)
    }

    pub fn shutdown(&self) -> FfiResult<()> {
        let (lock, wake) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| FfiError::internal("event dispatcher state is poisoned"))?;
        if state.dispatcher_thread == Some(thread::current().id()) {
            return Err(FfiError::new(
                crate::abi::CitizenSdkErrorCode::Busy,
                "cannot destroy CitizenSDK from its event callback",
            ));
        }
        state.active = false;
        while state.callbacks_in_flight != 0 {
            state = wake
                .wait(state)
                .map_err(|_| FfiError::internal("event dispatcher state is poisoned"))?;
        }
        drop(state);

        // Serialize the terminal marker after producers which already passed
        // the active-state gate.
        let enqueue = self
            .enqueue
            .lock()
            .map_err(|_| FfiError::internal("event enqueue state is poisoned"))?;
        // active=false 已拒绝生产者；消费者归还槽位也需要 enqueue，故等待前释放。
        drop(enqueue);
        let _ = self.sender.send(DispatchMessage::Shutdown);
        let join = self
            .join
            .lock()
            .map_err(|_| FfiError::internal("event dispatcher join state is poisoned"))?
            .take();
        if let Some(join) = join {
            join.join()
                .map_err(|_| FfiError::internal("event dispatcher thread panicked"))?;
        }
        Ok(())
    }
}

fn ensure_capacity(state: &EnqueueState, capacity: usize) -> FfiResult<()> {
    if state.queued + state.reserved_completions as usize >= capacity {
        return Err(FfiError::new(
            crate::abi::CitizenSdkErrorCode::QueueFull,
            "CitizenSDK event queue is full",
        ));
    }
    Ok(())
}

fn reserve_sequence(next: u64) -> FfiResult<(u64, u64)> {
    let following = next
        .checked_add(1)
        .filter(|value| *value != 0)
        .ok_or_else(|| FfiError::internal("event sequence space is exhausted"))?;
    Ok((next, following))
}

fn remaining_sequences(next: u64) -> u64 {
    u64::MAX - next
}

fn reserve_unreserved_sequence(state: &EnqueueState) -> FfiResult<(u64, u64)> {
    if remaining_sequences(state.next_sequence) <= state.reserved_completions {
        return Err(FfiError::internal(
            "event sequence space is reserved for accepted request completions",
        ));
    }
    reserve_sequence(state.next_sequence)
}

fn dispatch_loop(
    receiver: mpsc::Receiver<DispatchMessage>,
    state: Arc<(Mutex<DispatchState>, Condvar)>,
    enqueue: Arc<Mutex<EnqueueState>>,
) {
    if let Ok(mut guard) = state.0.lock() {
        guard.dispatcher_thread = Some(thread::current().id());
    } else {
        return;
    }

    while let Ok(message) = receiver.recv() {
        let DispatchMessage::Event {
            event,
            callback_generation,
            foreign,
        } = message
        else {
            return;
        };
        // 先归还出队槽位，随后才获取回调状态；任何宿主回调均不持有这两把锁。
        if let Ok(mut guard) = enqueue.lock() {
            guard.queued -= 1;
        } else {
            return;
        }
        let (native,value)={
            let Ok(mut guard)=state.0.lock() else{return;};
            if !guard.active||guard.callback_generation!=callback_generation{continue;}
            let value=guard.value_callback.filter(|_|foreign||event.event_type!=1);
            // 请求完成和带result的流事件只有一个拥有者；零载荷状态通知可供平台更新缓存。
            let native=if foreign||(value.is_some()&&event.result!=0){None}else{guard.callback};
            if native.is_some()||value.is_some(){guard.callbacks_in_flight+=1;}if value.is_some(){guard.value_in_flight+=1;}
            (native,value)
        };

        let mut failed_owner=None;
        if let Some(registration)=value {
          // 到发送时才标记交付，保证Runtime结果计数已经增加。
          if event.result!=0 {crate::ownership::mark_foreign(event.result);}
          let posted=registration.post(&event);
          if let Ok(mut guard)=state.0.lock(){guard.value_in_flight=guard.value_in_flight.saturating_sub(1);state.1.notify_all();}
          if !posted&&event.result!=0{failed_owner=crate::ownership::owner(event.result);unsafe{crate::citizensdk_result_release(event.result);}}
        } else if foreign&&event.result!=0 {unsafe{crate::citizensdk_result_release(event.result);}}
        if let Some(owner)=failed_owner{unsafe{crate::citizensdk_detach(owner);}}
        if let Some(registration)=native {unsafe{(registration.callback)(registration.context as *mut c_void,&event);}}
        if native.is_some()||value.is_some(){if let Ok(mut guard)=state.0.lock(){guard.callbacks_in_flight=guard.callbacks_in_flight.saturating_sub(1);state.1.notify_all();}else{return;}}

    }
}

#[cfg(test)]
mod tests {
    // 回调/通道的测试前提失败须立即暴露；允许项只作用于测试，不影响生产事件分发。
    #![allow(clippy::unwrap_used)]

    use std::{
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Arc, Barrier, Mutex,
        },
        time::Duration,
    };

    use super::{EventDispatcher, EVENT_QUEUE_CAPACITY};
    use crate::abi::{CitizenSdkErrorCode, CitizenSdkEvent, CitizenSdkEventType};

    struct BlockingContext {
        first: AtomicBool,
        calls: AtomicUsize,
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    unsafe extern "C" fn blocking_callback(context: *mut c_void, _event: *const CitizenSdkEvent) {
        // SAFETY: tests keep the boxed context alive until dispatcher shutdown.
        let context = unsafe { &*(context.cast::<BlockingContext>()) };
        context.calls.fetch_add(1, Ordering::SeqCst);
        if context.first.swap(false, Ordering::SeqCst) {
            let _ = context.entered.send(());
            if let Ok(release) = context.release.lock() {
                let _ = release.recv();
            }
        }
    }

    unsafe extern "C" fn counting_callback(context: *mut c_void, _event: *const CitizenSdkEvent) {
        // SAFETY: tests keep the atomic counter alive until dispatcher shutdown.
        let counter = unsafe { &*(context.cast::<AtomicUsize>()) };
        counter.fetch_add(1, Ordering::SeqCst);
    }

    unsafe extern "C" fn sequence_callback(context: *mut c_void, event: *const CitizenSdkEvent) {
        // SAFETY: the test owns both pointers until dispatcher shutdown.
        let sender = unsafe { &*(context.cast::<mpsc::Sender<u64>>()) };
        let event = unsafe { &*event };
        let _ = sender.send(event.sequence);
    }

    #[test]
    fn wallet_invalidation_and_completion_keep_reserved_slots_when_queue_is_full() {
        struct Context {
            first: AtomicBool,
            events: mpsc::Sender<CitizenSdkEvent>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        unsafe extern "C" fn callback(raw: *mut c_void, event: *const CitizenSdkEvent) {
            // SAFETY: 下方DrainGuard在Context析构前释放阻塞并join分发线程。
            let context = unsafe { &*raw.cast::<Context>() };
            let first = context.first.swap(false, Ordering::SeqCst);
            let _ = context.events.send(unsafe { *event });
            if first { let _ = context.release.lock().unwrap().recv(); }
        }
        struct DrainGuard<'a>(&'a EventDispatcher, mpsc::Sender<()>);
        impl Drop for DrainGuard<'_> {
            fn drop(&mut self) { let _ = self.1.send(()); let _ = self.0.shutdown(); }
        }
        let dispatcher = EventDispatcher::new().unwrap();
        let (events_tx, events_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let context = Box::new(Context {
            first: AtomicBool::new(true), events: events_tx, release: Mutex::new(release_rx),
        });
        let _drain = DrainGuard(&dispatcher, release_tx.clone());
        dispatcher.set_callback(Some(callback), (&*context as *const Context).cast_mut().cast()).unwrap();
        dispatcher.send(CitizenSdkEventType::WatchUpdate, 0, 0, 0).unwrap();
        let first = events_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let wallet = dispatcher.reserve_completion().unwrap();
        let completion = dispatcher.reserve_completion().unwrap();
        for _ in 0..EVENT_QUEUE_CAPACITY - 2 {
            dispatcher.send(CitizenSdkEventType::WatchUpdate, 0, 0, 0).unwrap();
        }
        assert_eq!(dispatcher.send(CitizenSdkEventType::WatchUpdate, 0, 0, 0).unwrap_err().code, CitizenSdkErrorCode::QueueFull);
        dispatcher.send_reserved_wallet_changed(wallet).unwrap();
        dispatcher.send_reserved_completion(completion, 91, 92).unwrap();
        release_tx.send(()).unwrap();
        let delivered: Vec<_> = (0..EVENT_QUEUE_CAPACITY)
            .map(|_| events_rx.recv_timeout(Duration::from_secs(2)).unwrap()).collect();
        for (index, event) in delivered.iter().enumerate() {
            assert_eq!(event.sequence, first.sequence + index as u64 + 1);
        }
        let wallet = &delivered[EVENT_QUEUE_CAPACITY - 2];
        assert_eq!(wallet.event_type, CitizenSdkEventType::WalletChanged as u32);
        assert_eq!((wallet.request_id, wallet.result, wallet.capability_revision, wallet.reserved), (0, 0, 0, 0));
        let completion = &delivered[EVENT_QUEUE_CAPACITY - 1];
        assert_eq!((completion.event_type, completion.request_id, completion.result), (CitizenSdkEventType::RequestCompleted as u32, 91, 92));
    }

    #[test]
    fn bounded_watch_queue_reports_stable_queue_full() {
        let dispatcher = EventDispatcher::new()
            .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}"));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let context = Box::new(BlockingContext {
            first: AtomicBool::new(true),
            calls: AtomicUsize::new(0),
            entered: entered_tx,
            release: Mutex::new(release_rx),
        });
        dispatcher
            .set_callback(
                Some(blocking_callback),
                (&*context as *const BlockingContext).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
        dispatcher
            .send(CitizenSdkEventType::WatchUpdate, 1, 0, 0)
            .unwrap_or_else(|error| panic!("first event failed: {error:?}"));
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("callback did not block: {error}"));

        for sequence in 0..EVENT_QUEUE_CAPACITY {
            dispatcher
                .try_send(CitizenSdkEventType::WatchUpdate, sequence as u64 + 2, 0, 0)
                .unwrap_or_else(|error| panic!("queue fill failed: {error:?}"));
        }
        let full = dispatcher
            .try_send(CitizenSdkEventType::WatchUpdate, 99, 0, 0)
            .err()
            .unwrap_or_else(|| panic!("one event beyond capacity must fail"));
        assert_eq!(full.code, CitizenSdkErrorCode::QueueFull);
        release_tx
            .send(())
            .unwrap_or_else(|error| panic!("callback release failed: {error}"));
        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }

    #[test]
    fn catalog_completion_slots_survive_ordinary_reservation_saturation() {
        let dispatcher = EventDispatcher::with_catalog_reserve(8).unwrap();
        let ordinary: Vec<_> = (0..EVENT_QUEUE_CAPACITY - 8).map(|_| dispatcher.reserve_completion().unwrap()).collect();
        assert_eq!(dispatcher.reserve_completion().err().unwrap().code, CitizenSdkErrorCode::QueueFull);
        let mut catalog: Vec<_> = (0..8).map(|_| dispatcher.reserve_catalog_completion().unwrap()).collect();
        assert_eq!(dispatcher.reserve_catalog_completion().err().unwrap().code, CitizenSdkErrorCode::QueueFull);
        drop(catalog.pop());
        assert!(dispatcher.reserve_completion().is_err());
        assert!(dispatcher.reserve_catalog_completion().is_ok());
        drop(catalog);drop(ordinary);dispatcher.shutdown().unwrap();
    }

    #[test]
    fn completion_slots_are_bounded_and_released_before_acceptance() {
        let dispatcher = EventDispatcher::new().unwrap();
        let mut reservations: Vec<_> = (0..EVENT_QUEUE_CAPACITY)
            .map(|_| dispatcher.reserve_completion().unwrap())
            .collect();
        assert_eq!(
            dispatcher.reserve_completion().err().unwrap().code,
            CitizenSdkErrorCode::QueueFull
        );
        assert_eq!(
            dispatcher
                .send(CitizenSdkEventType::WatchUpdate, 0, 0, 0)
                .unwrap_err()
                .code,
            CitizenSdkErrorCode::QueueFull
        );
        drop(reservations.pop());
        let restored = dispatcher.reserve_completion().unwrap();
        drop(restored);
        drop(reservations);
        dispatcher.shutdown().unwrap();
        assert!(dispatcher.reserve_completion().is_err());
    }

    struct ReentrantContext {
        dispatcher: Arc<EventDispatcher>,
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        result: mpsc::Sender<CitizenSdkErrorCode>,
        first: AtomicBool,
    }

    unsafe extern "C" fn reserve_from_callback(context: *mut c_void, _: *const CitizenSdkEvent) {
        // SAFETY: 测试在关闭 dispatcher 后才释放上下文。
        let context = unsafe { &*context.cast::<ReentrantContext>() };
        if context.first.swap(false, Ordering::SeqCst) {
            context.entered.send(()).unwrap();
            context.release.lock().unwrap().recv().unwrap();
            let code = context.dispatcher.reserve_completion().err().unwrap().code;
            context.result.send(code).unwrap();
        }
    }

    #[test]
    fn full_queue_completion_and_callback_reentry_never_wait_on_each_other() {
        let dispatcher = Arc::new(EventDispatcher::new().unwrap());
        let completion = dispatcher.reserve_completion().unwrap();
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (result, result_rx) = mpsc::channel();
        let context = Box::new(ReentrantContext {
            dispatcher: Arc::clone(&dispatcher),
            entered,
            release: Mutex::new(release_rx),
            result,
            first: AtomicBool::new(true),
        });
        dispatcher
            .set_callback(
                Some(reserve_from_callback),
                (&*context as *const ReentrantContext).cast_mut().cast(),
            )
            .unwrap();
        dispatcher
            .send(CitizenSdkEventType::WatchUpdate, 0, 0, 0)
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 1..EVENT_QUEUE_CAPACITY {
            dispatcher
                .try_send(CitizenSdkEventType::WatchUpdate, 0, 0, 0)
                .unwrap();
        }
        assert_eq!(
            dispatcher
                .try_send(CitizenSdkEventType::WatchUpdate, 0, 0, 0)
                .unwrap_err()
                .code,
            CitizenSdkErrorCode::QueueFull
        );
        // 回调仍被屏障阻塞，预留完成必须立即入队，不能等消费者继续运行。
        let producer = Arc::clone(&dispatcher);
        let (completed, completed_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            completed
                .send(producer.send_reserved_completion(completion, 1, 0))
                .unwrap();
        });
        let sent = completed_rx.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        assert!(sent.unwrap().is_ok());
        assert_eq!(
            result_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            CitizenSdkErrorCode::QueueFull
        );
        worker.join().unwrap();
        dispatcher.shutdown().unwrap();
    }

    #[test]
    fn replacement_waits_for_old_context_before_returning() {
        let dispatcher = Arc::new(
            EventDispatcher::new()
                .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}")),
        );
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let old = Box::new(BlockingContext {
            first: AtomicBool::new(true),
            calls: AtomicUsize::new(0),
            entered: entered_tx,
            release: Mutex::new(release_rx),
        });
        let new = Box::new(AtomicUsize::new(0));
        dispatcher
            .set_callback(
                Some(blocking_callback),
                (&*old as *const BlockingContext).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("old callback registration failed: {error:?}"));
        dispatcher
            .send(CitizenSdkEventType::CapabilitiesChanged, 0, 0, 1)
            .unwrap_or_else(|error| panic!("old event failed: {error:?}"));
        entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("old callback did not enter: {error}"));

        let replacement = Arc::clone(&dispatcher);
        let new_pointer = (&*new as *const AtomicUsize).cast_mut() as usize;
        let (replaced_tx, replaced_rx) = mpsc::channel();
        let replace_thread = std::thread::spawn(move || {
            let result =
                replacement.set_callback(Some(counting_callback), new_pointer as *mut c_void);
            let _ = replaced_tx.send(result);
        });
        assert!(replaced_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx
            .send(())
            .unwrap_or_else(|error| panic!("old callback release failed: {error}"));
        replaced_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("replacement did not finish: {error}"))
            .unwrap_or_else(|error| panic!("replacement failed: {error:?}"));
        replace_thread
            .join()
            .unwrap_or_else(|_| panic!("replacement thread panicked"));

        dispatcher
            .send(CitizenSdkEventType::CapabilitiesChanged, 0, 0, 2)
            .unwrap_or_else(|error| panic!("new event failed: {error:?}"));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while new.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(new.load(Ordering::SeqCst), 1);
        assert_eq!(old.calls.load(Ordering::SeqCst), 1);
        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }

    #[test]
    fn exhausted_sequence_never_wraps_or_reuses_zero() {
        let dispatcher = EventDispatcher::new()
            .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}"));
        dispatcher.exhaust_sequences_for_test();
        for _ in 0..2 {
            let error = dispatcher
                .try_send(CitizenSdkEventType::WatchUpdate, 1, 0, 0)
                .err()
                .unwrap_or_else(|| panic!("exhausted sequence must fail closed"));
            assert_eq!(error.code, CitizenSdkErrorCode::Internal);
            assert_eq!(
                dispatcher
                    .enqueue
                    .lock()
                    .unwrap_or_else(|_| panic!("event sequence state poisoned"))
                    .next_sequence,
                u64::MAX
            );
        }
        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }

    #[test]
    fn accepted_completion_capacity_cannot_be_stolen_at_sequence_boundary() {
        let dispatcher = EventDispatcher::new()
            .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}"));
        let (sequence_tx, sequence_rx) = mpsc::channel::<u64>();
        dispatcher
            .set_callback(
                Some(sequence_callback),
                (&sequence_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
        dispatcher
            .enqueue
            .lock()
            .unwrap_or_else(|_| panic!("event sequence state poisoned"))
            .next_sequence = u64::MAX - 1;

        let completion = dispatcher
            .reserve_completion()
            .unwrap_or_else(|error| panic!("last completion reservation failed: {error:?}"));
        let ordinary = dispatcher
            .try_send(CitizenSdkEventType::WatchUpdate, 1, 0, 0)
            .err()
            .unwrap_or_else(|| panic!("ordinary event must not steal completion capacity"));
        assert_eq!(ordinary.code, CitizenSdkErrorCode::Internal);
        dispatcher
            .send_reserved_completion(completion, 77, 99)
            .unwrap_or_else(|error| panic!("reserved completion failed: {error:?}"));
        assert_eq!(
            sequence_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_else(|error| panic!("completion not observed: {error}")),
            u64::MAX - 1
        );
        assert!(dispatcher.reserve_completion().is_err());
        let enqueue = dispatcher
            .enqueue
            .lock()
            .unwrap_or_else(|_| panic!("event sequence state poisoned"));
        assert_eq!(enqueue.next_sequence, u64::MAX);
        assert_eq!(enqueue.reserved_completions, 0);
        drop(enqueue);
        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }

    #[test]
    fn rejected_request_releases_completion_capacity_without_reusing_sequence() {
        let dispatcher = EventDispatcher::new()
            .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}"));
        dispatcher
            .enqueue
            .lock()
            .unwrap_or_else(|_| panic!("event sequence state poisoned"))
            .next_sequence = u64::MAX - 1;
        let completion = dispatcher
            .reserve_completion()
            .unwrap_or_else(|error| panic!("completion reservation failed: {error:?}"));
        drop(completion);
        dispatcher
            .send(CitizenSdkEventType::LifecycleChanged, 0, 0, 0)
            .unwrap_or_else(|error| panic!("released capacity was not restored: {error:?}"));
        let enqueue = dispatcher
            .enqueue
            .lock()
            .unwrap_or_else(|_| panic!("event sequence state poisoned"));
        assert_eq!(enqueue.next_sequence, u64::MAX);
        assert_eq!(enqueue.reserved_completions, 0);
        drop(enqueue);
        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }

    #[test]
    fn concurrent_reserved_completions_consume_aggregate_capacity_in_queue_order() {
        const COMPLETIONS: usize = 4;
        let dispatcher = Arc::new(
            EventDispatcher::new()
                .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}")),
        );
        let (sequence_tx, sequence_rx) = mpsc::channel::<u64>();
        dispatcher
            .set_callback(
                Some(sequence_callback),
                (&sequence_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
        dispatcher.set_next_sequence_for_test(u64::MAX - COMPLETIONS as u64);
        let reservations: Vec<_> = (0..COMPLETIONS)
            .map(|_| {
                dispatcher
                    .reserve_completion()
                    .unwrap_or_else(|error| panic!("completion reservation failed: {error:?}"))
            })
            .collect();
        assert!(dispatcher.reserve_completion().is_err());
        assert!(dispatcher
            .try_send(CitizenSdkEventType::WatchUpdate, 0, 0, 0)
            .is_err());

        let barrier = Arc::new(Barrier::new(COMPLETIONS));
        std::thread::scope(|scope| {
            for (index, reservation) in reservations.into_iter().enumerate() {
                let dispatcher = Arc::clone(&dispatcher);
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    dispatcher
                        .send_reserved_completion(reservation, index as u64 + 1, index as u64 + 100)
                        .unwrap_or_else(|error| {
                            panic!("concurrent reserved completion failed: {error:?}")
                        });
                });
            }
        });
        let observed: Vec<u64> = (0..COMPLETIONS)
            .map(|_| {
                sequence_rx
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap_or_else(|error| panic!("completion not observed: {error}"))
            })
            .collect();
        assert_eq!(
            observed,
            (u64::MAX - COMPLETIONS as u64..u64::MAX).collect::<Vec<_>>()
        );
        let enqueue = dispatcher
            .enqueue
            .lock()
            .unwrap_or_else(|_| panic!("event sequence state poisoned"));
        assert_eq!(enqueue.next_sequence, u64::MAX);
        assert_eq!(enqueue.reserved_completions, 0);
        drop(enqueue);
        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }

    #[test]
    fn concurrent_producers_are_observed_in_strict_sequence_order() {
        const PRODUCERS: usize = 8;
        const EVENTS_PER_PRODUCER: usize = 32;

        let dispatcher = Arc::new(
            EventDispatcher::new()
                .unwrap_or_else(|error| panic!("dispatcher creation failed: {error:?}")),
        );
        let (sequence_tx, sequence_rx) = mpsc::channel();
        dispatcher
            .set_callback(
                Some(sequence_callback),
                (&sequence_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));
        let barrier = Arc::new(Barrier::new(PRODUCERS));
        std::thread::scope(|scope| {
            for producer in 0..PRODUCERS {
                let dispatcher = Arc::clone(&dispatcher);
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    for index in 0..EVENTS_PER_PRODUCER {
                        loop {
                            match dispatcher.send(
                                CitizenSdkEventType::CapabilitiesChanged,
                                (producer * EVENTS_PER_PRODUCER + index) as u64,
                                0,
                                0,
                            ) {
                                Ok(()) => break,
                                Err(error) if error.code == CitizenSdkErrorCode::QueueFull => {
                                    std::thread::yield_now()
                                }
                                Err(error) => panic!("concurrent send failed: {error:?}"),
                            }
                        }
                    }
                });
            }
        });

        let observed: Vec<u64> = (0..PRODUCERS * EVENTS_PER_PRODUCER)
            .map(|_| {
                sequence_rx
                    .recv_timeout(Duration::from_secs(2))
                    .unwrap_or_else(|error| panic!("event not observed: {error}"))
            })
            .collect();
        assert!(observed.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(observed.first(), Some(&1));
        assert_eq!(observed.last(), Some(&(observed.len() as u64)));

        dispatcher
            .shutdown()
            .unwrap_or_else(|error| panic!("dispatcher shutdown failed: {error:?}"));
    }
}

#[cfg(test)]mod value_tests {
 use super::*;use std::sync::mpsc;
 unsafe extern "C" fn native(context:*mut c_void,event:*const CitizenSdkEvent){let sender=&*context.cast::<mpsc::Sender<(u32,u64)>>();sender.send(((*event).event_type,(*event).result)).unwrap();}
 unsafe extern "C" fn post(_:i64,_:*mut crate::dart::DartObject)->bool{true}
 unsafe extern "C" fn copied(_:crate::dart::Post,port:i64,kind:u32,seq:u64,request:u64,result:u64,revision:u64)->i8{let sender=&*(port as usize as *const mpsc::Sender<i64>);for value in[kind as i64,seq as i64,request as i64,result as i64,revision as i64]{sender.send(value).unwrap();}1}
 #[test]fn completions_have_one_owner_and_state_notifications_have_no_borrowed_pointer(){
  let d=EventDispatcher::new().unwrap();let(tx,rx)=mpsc::channel::<(u32,u64)>();let(vtx,vrx)=mpsc::channel::<i64>();d.set_callback(Some(native),(&tx as *const mpsc::Sender<(u32,u64)>).cast_mut().cast()).unwrap();d.attach_value(Some(copied),Some(post),&vtx as *const mpsc::Sender<i64> as usize as i64).unwrap();assert!(d.attach_value(Some(copied),Some(post),1).is_err());
  d.send_reserved_completion(d.reserve_completion().unwrap().foreign(),1,101).unwrap();assert_eq!((0..5).map(|_|vrx.recv_timeout(std::time::Duration::from_secs(2)).unwrap()).collect::<Vec<_>>(),vec![1,1,1,101,0]);assert!(rx.try_recv().is_err());
  d.send_reserved_completion(d.reserve_completion().unwrap(),2,102).unwrap();assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),(1,102));assert!(vrx.try_recv().is_err());
  d.send(CitizenSdkEventType::WalletChanged,0,0,0).unwrap();assert_eq!((0..5).map(|_|vrx.recv_timeout(std::time::Duration::from_secs(2)).unwrap()).collect::<Vec<_>>(),vec![7,3,0,0,0]);assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),(7,0));d.shutdown().unwrap();
 }
}
