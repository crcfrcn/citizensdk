use std::cell::Cell;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;

use crate::abi::error::FfiError;
use crate::abi::error::FfiResult;
use crate::abi::ownership::ResultPayload;
use crate::abi::types::CitizenSdkErrorCode;
use crate::abi::types::CitizenSdkRequestId;
use crate::runtime::NativeRuntime;

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
static CATALOG_EXECUTOR: OnceLock<Result<RequestExecutor, String>> = OnceLock::new();
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
    accept_on(runtime, cancellable, false, false, operation, executor)
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
    accept_on(runtime, false, true, false, operation, executor)
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
    accept_on(runtime, true, false, false, operation, executor)
}

/// 钱包目录独占两个有界worker，不与网络请求或用户认证共用可占满的队列。
pub(crate) fn accept_catalog<F>(
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
    let executor = CATALOG_EXECUTOR
        .get_or_init(|| start_executor(2, "citizensdk-catalog"))
        .as_ref()
        .map_err(|message| FfiError::internal(message.clone()))?;
    accept_on(runtime, true, false, true, operation, executor)
}

/// 只记录固定步骤；panic载荷、账户、秘密与请求参数永不进入诊断。
#[derive(Clone, Copy)]
pub(crate) enum RequestPoint {
    Admission,
    LocalRead,
    ResultReady,
}
impl RequestPoint {
    const fn token(self) -> &'static str {
        match self {
            Self::Admission => "ADMISSION",
            Self::LocalRead => "LOCAL_READ",
            Self::ResultReady => "RESULT_READY",
        }
    }
}
thread_local! { static REQUEST_POINT: Cell<RequestPoint> = const { Cell::new(RequestPoint::Admission) }; }
pub(crate) fn mark_request_point(point: RequestPoint) {
    REQUEST_POINT.with(|value| value.set(point));
}

fn accept_on<F>(
    runtime: Arc<NativeRuntime>,
    cancellable: bool,
    exclusive: bool,
    catalog: bool,
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
    let (request_id, cancellation) = if catalog {
        runtime.begin_catalog_request()?
    } else if exclusive {
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
                let _ = crate::abi::error::catch_native_panic(operation);
                continue;
            }
        };
        mark_request_point(RequestPoint::Admission);
        let outcome = crate::abi::error::catch_native_panic(|| {
            (job.operation)(&job.runtime, job.request_id, job.cancellation)
        })
        .unwrap_or_else(|_| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Panic,
                REQUEST_POINT.with(|point| {
                    format!("CitizenSDK request panicked at {}", point.get().token())
                }),
            ))
        });
        job.runtime.complete_request(job.request_id, outcome);
    }
}

#[cfg(all(test, feature = "chain", feature = "transactions"))]
#[path = "../../tests/abi/requests.rs"]
mod tests;
