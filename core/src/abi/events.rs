use std::ffi::c_void;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::thread;
use std::thread::JoinHandle;
use std::thread::ThreadId;

use crate::abi::error::FfiError;
use crate::abi::error::FfiResult;
use crate::abi::types::CitizenSdkEvent;
use crate::abi::types::CitizenSdkEventCallback;
use crate::abi::types::CitizenSdkEventType;
use crate::abi::types::CitizenSdkRequestId;
use crate::abi::types::CitizenSdkResultHandle;
use crate::abi::types::CITIZENSDK_ABI_VERSION;

const EVENT_QUEUE_CAPACITY: usize = 64;

#[derive(Clone, Copy)]
struct CallbackRegistration {
    callback: unsafe extern "C" fn(*mut c_void, *const CitizenSdkEvent),
    context: usize,
}

struct DispatchState {
    active: bool,
    callback: Option<CallbackRegistration>,
    value_callback: Option<crate::abi::dart::Registration>,
    callbacks_in_flight: usize,
    value_in_flight: usize,
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

impl CompletionEventReservation {
    pub(crate) fn foreign(mut self) -> Self {
        self.foreign = true;
        self
    }
    pub(crate) fn is_foreign(&self) -> bool {
        self.foreign
    }
}
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
    #[cfg(test)]
    pub fn new() -> FfiResult<Self> {
        Self::with_catalog_reserve(0)
    }

    /// 运行实例为本地只读保留真实槽位；普通事件和网络请求都不能占用。
    pub(crate) fn with_catalog_reserve(catalog_reserve: usize) -> FfiResult<Self> {
        if catalog_reserve >= EVENT_QUEUE_CAPACITY {
            return Err(FfiError::invalid("invalid catalog event reserve"));
        }
        let (sender, receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let state = Arc::new((
            Mutex::new(DispatchState {
                active: true,
                callback: None,
                value_callback: None,
                callbacks_in_flight: 0,
                value_in_flight: 0,
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
                crate::abi::types::CitizenSdkErrorCode::InvalidState,
                "event dispatcher is stopped",
            ));
        }
        if state.dispatcher_thread == Some(thread::current().id()) && state.callbacks_in_flight != 0
        {
            return Err(FfiError::new(
                crate::abi::types::CitizenSdkErrorCode::Busy,
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

    pub(crate) fn attach_value(
        &self,
        callback: crate::abi::dart::ValueCallback,
        post: crate::abi::dart::Post,
        port: i64,
    ) -> FfiResult<()> {
        let callback = callback.ok_or_else(|| FfiError::invalid("value callback missing"))?;
        let mut state = self
            .state
            .0
            .lock()
            .map_err(|_| FfiError::internal("event state poisoned"))?;
        if !state.active || state.value_callback.is_some() {
            return Err(FfiError::new(
                crate::abi::types::CitizenSdkErrorCode::InvalidState,
                "value callback already attached or stopped",
            ));
        }
        if port <= 0 || post.is_none() {
            return Err(FfiError::invalid("receiver port invalid"));
        }
        state.value_callback = Some(crate::abi::dart::Registration {
            callback,
            post,
            port,
        });
        Ok(())
    }
    pub(crate) fn detach_value(&self) -> FfiResult<()> {
        let mut state = self
            .state
            .0
            .lock()
            .map_err(|_| FfiError::internal("event state poisoned"))?;
        let receiver = state.value_callback.take();
        while state.value_in_flight != 0 {
            state = self
                .state
                .1
                .wait(state)
                .map_err(|_| FfiError::internal("event state poisoned"))?;
        }
        drop(state);
        if let Some(receiver) = receiver {
            receiver.post(&CitizenSdkEvent {
                struct_size: std::mem::size_of::<CitizenSdkEvent>() as u32,
                abi_version: crate::abi::types::CITIZENSDK_ABI_VERSION,
                event_type: 0,
                reserved: 0,
                sequence: 0,
                request_id: 0,
                result: 0,
                capability_revision: 0,
            });
        }
        Ok(())
    }
    pub(crate) fn ensure_value(&self) -> FfiResult<()> {
        let state = self
            .state
            .0
            .lock()
            .map_err(|_| FfiError::internal("event state poisoned"))?;
        if !state.active || state.value_callback.is_none() {
            return Err(FfiError::new(
                crate::abi::types::CitizenSdkErrorCode::InvalidState,
                "value callback unavailable",
            ));
        }
        Ok(())
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
                    crate::abi::types::CitizenSdkErrorCode::QueueFull,
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
    fn reserve_completion_with_policy(
        &self,
        catalog: bool,
    ) -> FfiResult<CompletionEventReservation> {
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
        ensure_capacity(
            &enqueue,
            if catalog {
                EVENT_QUEUE_CAPACITY
            } else {
                EVENT_QUEUE_CAPACITY - self.catalog_reserve
            },
        )?;
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

    /// Consume one pre-acceptance completion reservation and enqueue its event
    /// with the next callback-observed sequence number.
    pub fn send_reserved_completion(
        &self,
        reservation: CompletionEventReservation,
        request_id: CitizenSdkRequestId,
        result: CitizenSdkResultHandle,
    ) -> FfiResult<()> {
        self.send_reserved(
            reservation,
            CitizenSdkEventType::RequestCompleted,
            request_id,
            result,
        )
    }

    /// 钱包操作接纳前预留真实队列槽，避免写后因队列满丢失目录通知。
    pub fn send_reserved_wallet_changed(
        &self,
        reservation: CompletionEventReservation,
    ) -> FfiResult<()> {
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
                crate::abi::types::CitizenSdkErrorCode::Busy,
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
                crate::abi::types::CitizenSdkErrorCode::InvalidState,
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
                crate::abi::types::CitizenSdkErrorCode::Busy,
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
            crate::abi::types::CitizenSdkErrorCode::QueueFull,
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
        let (native, value) = {
            let Ok(mut guard) = state.0.lock() else {
                return;
            };
            if !guard.active || guard.callback_generation != callback_generation {
                continue;
            }
            let value = guard
                .value_callback
                .filter(|_| foreign || event.event_type != 1);
            // 请求完成和带result的流事件只有一个拥有者；零载荷状态通知可供平台更新缓存。
            let native = if foreign || (value.is_some() && event.result != 0) {
                None
            } else {
                guard.callback
            };
            if native.is_some() || value.is_some() {
                guard.callbacks_in_flight += 1;
            }

            if value.is_some() {
                guard.value_in_flight += 1;
            }
            (native, value)
        };

        let mut failed_owner = None;
        if let Some(registration) = value {
            // 到发送时才标记交付，保证Runtime结果计数已经增加。
            if event.result != 0 {
                crate::abi::ownership::mark_foreign(event.result);
            }
            let posted = registration.post(&event);
            if let Ok(mut guard) = state.0.lock() {
                guard.value_in_flight = guard.value_in_flight.saturating_sub(1);
                state.1.notify_all();
            }
            if !posted && event.result != 0 {
                failed_owner = crate::abi::ownership::owner(event.result);
                unsafe {
                    crate::abi::citizensdk_result_release(event.result);
                }
            }
        } else if foreign && event.result != 0 {
            unsafe {
                crate::abi::citizensdk_result_release(event.result);
            }
        }
        if let Some(owner) = failed_owner {
            unsafe {
                crate::abi::citizensdk_detach(owner);
            }
        }
        if let Some(registration) = native {
            unsafe {
                (registration.callback)(registration.context as *mut c_void, &event);
            }
        }
        if native.is_some() || value.is_some() {
            if let Ok(mut guard) = state.0.lock() {
                guard.callbacks_in_flight = guard.callbacks_in_flight.saturating_sub(1);
                state.1.notify_all();
            } else {
                return;
            }
        }
    }
}

#[cfg(test)]
#[path = "../../tests/abi/events.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/abi/values.rs"]
mod value_tests;
