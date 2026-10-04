use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
};

use crate::{
    abi::{CitizenSdkErrorCode, CitizenSdkRequestId},
    error::{FfiError, FfiResult},
    ownership::ResultPayload,
    runtime::NativeRuntime,
};

pub type RequestCancellation = futures_channel::oneshot::Receiver<()>;

const SHORT_WORKER_COUNT: usize = 4;
const WATCH_WORKER_COUNT: usize = 4;
const QUEUE_CAPACITY: usize = 64;

type RequestOperation = Box<
    dyn FnOnce(
            &Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
>;

struct StandardRequestJob {
    runtime: Arc<NativeRuntime>,
    request_id: CitizenSdkRequestId,
    cancellation: Option<RequestCancellation>,
    operation: RequestOperation,
}

enum RequestJob {
    Standard(StandardRequestJob),
    /// 私有查看阶段自行收敛；不把阶段返回误作整个 UI 生命周期完成。
    PrivateView(Box<dyn FnOnce() + Send + 'static>),
}

struct RequestExecutor {
    sender: mpsc::SyncSender<RequestJob>,
}

static SHORT_EXECUTOR: OnceLock<Result<RequestExecutor, String>> = OnceLock::new();
static WATCH_EXECUTOR: OnceLock<Result<RequestExecutor, String>> = OnceLock::new();

pub fn accept<F>(
    runtime: Arc<NativeRuntime>,
    cancellable: bool,
    operation: F,
) -> FfiResult<CitizenSdkRequestId>
where
    F: FnOnce(
            &Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    let executor = short_executor()?;
    accept_on(runtime, cancellable, false, operation, executor)
}

/// Accepts a lifecycle operation only when no earlier asynchronous request is
/// outstanding, then blocks every new asynchronous request until completion.
pub fn accept_exclusive<F>(
    runtime: Arc<NativeRuntime>,
    operation: F,
) -> FfiResult<CitizenSdkRequestId>
where
    F: FnOnce(
            &Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    let executor = short_executor()?;
    accept_on(runtime, false, true, operation, executor)
}

/// Accept a long-lived chain watch on a separate bounded pool so raw watches
/// and high-level wallet terminal observation can never consume every worker
/// needed by lifecycle, finite reads, state mutation, or submit.
pub fn accept_watch<F>(runtime: Arc<NativeRuntime>, operation: F) -> FfiResult<CitizenSdkRequestId>
where
    F: FnOnce(
            &Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    let executor = watch_executor()?;
    accept_on(runtime, true, false, operation, executor)
}

fn accept_on<F>(
    runtime: Arc<NativeRuntime>,
    cancellable: bool,
    exclusive: bool,
    operation: F,
    executor: &RequestExecutor,
) -> FfiResult<CitizenSdkRequestId>
where
    F: FnOnce(
            &Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    let (request_id, cancellation) = if exclusive {
        runtime.begin_exclusive_request()?
    } else {
        runtime.begin_request(cancellable)?
    };
    let job = RequestJob::Standard(StandardRequestJob {
        runtime: Arc::clone(&runtime),
        request_id,
        cancellation,
        operation: Box::new(operation),
    });
    if let Err(error) = executor.sender.try_send(job) {
        runtime.reject_request(request_id);
        let (code, message) = match error {
            mpsc::TrySendError::Full(_) => (
                CitizenSdkErrorCode::QueueFull,
                "CitizenSDK request queue is full",
            ),
            mpsc::TrySendError::Disconnected(_) => (
                CitizenSdkErrorCode::Internal,
                "CitizenSDK request executor is disconnected",
            ),
        };
        return Err(FfiError::new(code, message));
    }
    Ok(request_id)
}

fn short_executor() -> FfiResult<&'static RequestExecutor> {
    SHORT_EXECUTOR
        .get_or_init(|| start_executor(SHORT_WORKER_COUNT, "citizensdk-worker"))
        .as_ref()
        .map_err(|message| FfiError::internal(message.clone()))
}

/// 共用有界短队列，只执行准备或认证阶段，绝不在作业中等待用户点击或整个 UI 寿命。
pub(crate) fn execute_private_view(operation: impl FnOnce() + Send + 'static) -> FfiResult<()> {
    short_executor()?
        .sender
        .try_send(RequestJob::PrivateView(Box::new(operation)))
        .map_err(|error| match error {
            mpsc::TrySendError::Full(_) => {
                FfiError::new(CitizenSdkErrorCode::QueueFull, "安全查看阶段队列已满")
            }
            mpsc::TrySendError::Disconnected(_) => FfiError::internal("安全查看阶段队列已关闭"),
        })
}

fn watch_executor() -> FfiResult<&'static RequestExecutor> {
    WATCH_EXECUTOR
        .get_or_init(|| start_executor(WATCH_WORKER_COUNT, "citizensdk-watch"))
        .as_ref()
        .map_err(|message| FfiError::internal(message.clone()))
}

fn start_executor(worker_count: usize, thread_prefix: &str) -> Result<RequestExecutor, String> {
    let (sender, receiver) = mpsc::sync_channel::<RequestJob>(QUEUE_CAPACITY);
    let receiver = Arc::new(Mutex::new(receiver));
    for index in 0..worker_count {
        let receiver = Arc::clone(&receiver);
        thread::Builder::new()
            .name(format!("{thread_prefix}-{index}"))
            .spawn(move || worker_loop(receiver))
            .map_err(|error| format!("failed to start request worker: {error}"))?;
    }
    Ok(RequestExecutor { sender })
}

fn worker_loop(receiver: Arc<Mutex<mpsc::Receiver<RequestJob>>>) {
    loop {
        let job = {
            let Ok(receiver) = receiver.lock() else {
                return;
            };
            receiver.recv()
        };
        let Ok(job) = job else {
            return;
        };
        let job = match job {
            RequestJob::Standard(job) => job,
            RequestJob::PrivateView(operation) => {
                // 作业持有会话并自行把 panic 转为受控错误；外层隔离防止单个视图杀死共享 worker。
                let _ = catch_unwind(AssertUnwindSafe(operation));
                continue;
            }
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            (job.operation)(&job.runtime, job.request_id, job.cancellation)
        }))
        .unwrap_or_else(|_| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Panic,
                "CitizenSDK request panicked",
            ))
        });
        job.runtime.complete_request(job.request_id, outcome);
    }
}

#[cfg(all(test, feature = "chain", feature = "transactions"))]
mod tests {
    use std::{
        ffi::c_void,
        sync::{mpsc, Arc, Condvar, Mutex},
        time::{Duration, Instant},
    };

    use super::{accept, accept_exclusive, accept_watch, WATCH_WORKER_COUNT};
    use crate::{
        abi::{CitizenSdkEvent, CitizenSdkEventType},
        ownership::{self, ResultPayload},
        runtime::NativeRuntime,
    };

    unsafe extern "C" fn completion_callback(context: *mut c_void, event: *const CitizenSdkEvent) {
        // SAFETY: this test owns both pointers through runtime shutdown.
        let sender = unsafe { &*(context.cast::<mpsc::Sender<u64>>()) };
        let event = unsafe { &*event };
        if event.event_type == CitizenSdkEventType::RequestCompleted as u32 && event.result != 0 {
            let _ = sender.send(event.result);
        }
    }

    fn runtime() -> Arc<NativeRuntime> {
        let assets = crate::assets::verify_assets(
            include_bytes!("../../../chain/manifest.json"),
            include_bytes!("../../../chain/chainspec.json"),
            include_bytes!("../../../chain/light_sync_state.json"),
        )
        .unwrap_or_else(|error| panic!("asset verification failed: {error:?}"));
        NativeRuntime::new(
            9011,
            assets.combined_chain_spec,
            "CitizenSDK-executor-test".to_owned(),
            "1.0.0".to_owned(),
        )
        .unwrap_or_else(|error| panic!("runtime creation failed: {error:?}"))
    }

    #[test]
    fn saturated_watch_pool_never_starves_short_atomic_requests() {
        let runtime = runtime();
        let (result_tx, result_rx) = mpsc::channel();
        runtime
            .set_event_callback(
                Some(completion_callback),
                (&result_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered_tx, entered_rx) = mpsc::channel();
        for _ in 0..WATCH_WORKER_COUNT {
            let gate = Arc::clone(&gate);
            let entered = entered_tx.clone();
            accept_watch(Arc::clone(&runtime), move |_, _, _| {
                entered
                    .send(())
                    .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
                let mut released = gate
                    .0
                    .lock()
                    .map_err(|_| crate::error::FfiError::internal("watch gate poisoned"))?;
                while !*released {
                    released = gate
                        .1
                        .wait(released)
                        .map_err(|_| crate::error::FfiError::internal("watch gate poisoned"))?;
                }
                Ok(ResultPayload::Empty)
            })
            .unwrap_or_else(|error| panic!("watch acceptance failed: {error:?}"));
        }
        for _ in 0..WATCH_WORKER_COUNT {
            entered_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_else(|error| panic!("watch worker did not enter: {error}"));
        }

        let (short_tx, short_rx) = mpsc::channel();
        accept(Arc::clone(&runtime), false, move |_, _, _| {
            short_tx
                .send(())
                .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
            Ok(ResultPayload::Empty)
        })
        .unwrap_or_else(|error| panic!("short request acceptance failed: {error:?}"));
        short_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("short request was starved by watches: {error}"));

        {
            let mut released = gate
                .0
                .lock()
                .unwrap_or_else(|_| panic!("watch gate poisoned"));
            *released = true;
            gate.1.notify_all();
        }

        for _ in 0..(WATCH_WORKER_COUNT + 1) {
            let result = result_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_else(|error| panic!("completion result not observed: {error}"));
            ownership::release(result)
                .unwrap_or_else(|error| panic!("result release failed: {error:?}"));
            runtime.result_released();
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match runtime.set_event_callback(None, std::ptr::null_mut()) {
                Ok(()) => break,
                Err(error)
                    if error.code == crate::abi::CitizenSdkErrorCode::Busy
                        && Instant::now() < deadline =>
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

    #[test]
    fn executor_enforces_shared_then_exclusive_admission_barriers() {
        let runtime = runtime();
        let (result_tx, result_rx) = mpsc::channel();
        runtime
            .set_event_callback(
                Some(completion_callback),
                (&result_tx as *const mpsc::Sender<u64>).cast_mut().cast(),
            )
            .unwrap_or_else(|error| panic!("callback registration failed: {error:?}"));

        let (shared_entered_tx, shared_entered_rx) = mpsc::channel();
        let (shared_release_tx, shared_release_rx) = mpsc::channel();
        accept(Arc::clone(&runtime), false, move |_, _, _| {
            shared_entered_tx
                .send(())
                .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
            shared_release_rx
                .recv()
                .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
            Ok(ResultPayload::Empty)
        })
        .unwrap_or_else(|error| panic!("shared request acceptance failed: {error:?}"));
        shared_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("shared worker did not enter: {error}"));

        // The ordinary admission path deliberately remains shared: this is
        // the behavior retained by legacy `citizensdk_create` lifecycle calls.
        accept(Arc::clone(&runtime), false, |_, _, _| {
            Ok(ResultPayload::Empty)
        })
        .unwrap_or_else(|error| panic!("second shared request was rejected: {error:?}"));
        let shared_result = result_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("second shared result not observed: {error}"));
        ownership::release(shared_result)
            .unwrap_or_else(|error| panic!("shared result release failed: {error:?}"));
        runtime.result_released();

        let blocked_exclusive =
            accept_exclusive(Arc::clone(&runtime), |_, _, _| Ok(ResultPayload::Empty))
                .err()
                .unwrap_or_else(|| panic!("earlier shared request must block exclusive admission"));
        assert_eq!(
            blocked_exclusive.code,
            crate::abi::CitizenSdkErrorCode::Busy
        );
        shared_release_tx
            .send(())
            .unwrap_or_else(|error| panic!("shared worker release failed: {error}"));
        let first_result = result_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("first shared result not observed: {error}"));
        ownership::release(first_result)
            .unwrap_or_else(|error| panic!("shared result release failed: {error:?}"));
        runtime.result_released();

        let (exclusive_entered_tx, exclusive_entered_rx) = mpsc::channel();
        let (exclusive_release_tx, exclusive_release_rx) = mpsc::channel();
        accept_exclusive(Arc::clone(&runtime), move |_, _, _| {
            exclusive_entered_tx
                .send(())
                .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
            exclusive_release_rx
                .recv()
                .map_err(|error| crate::error::FfiError::internal(error.to_string()))?;
            Ok(ResultPayload::Empty)
        })
        .unwrap_or_else(|error| panic!("exclusive request acceptance failed: {error:?}"));
        exclusive_entered_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("exclusive worker did not enter: {error}"));
        let blocked_shared = accept(Arc::clone(&runtime), false, |_, _, _| {
            Ok(ResultPayload::Empty)
        })
        .err()
        .unwrap_or_else(|| panic!("exclusive request must block later shared admission"));
        assert_eq!(blocked_shared.code, crate::abi::CitizenSdkErrorCode::Busy);
        exclusive_release_tx
            .send(())
            .unwrap_or_else(|error| panic!("exclusive worker release failed: {error}"));
        let exclusive_result = result_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| panic!("exclusive result not observed: {error}"));
        ownership::release(exclusive_result)
            .unwrap_or_else(|error| panic!("exclusive result release failed: {error:?}"));
        runtime.result_released();

        runtime
            .set_event_callback(None, std::ptr::null_mut())
            .unwrap_or_else(|error| panic!("callback clear failed: {error:?}"));
        runtime
            .shutdown()
            .unwrap_or_else(|error| panic!("runtime shutdown failed: {error:?}"));
    }
}
