//! FFI bindings for smoldot-light
//!
//! This library provides C-compatible FFI exports for the smoldot-light
//! Rust library, enabling Dart applications to use a lightweight Substrate/Polkadot client.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use smoldot_light::{
    platform::DefaultPlatform, AddChainConfig, AddChainConfigJsonRpc, AddChainSuccess, ChainId,
    Client, JsonRpcResponses,
};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};

mod error;
mod ffi_types;

// sr25519 逻辑与 FFI 外壳统一来自 CitizenSDK 内部 native/signer。宏在本原生库
// 就地生成 4 个 no_mangle C ABI 入口；正式 Android/iOS 交付和测试用
// iOS 模拟器变体与 macOS 宿主均共享同一实现与符号契约。
citizen_signer::export_citizen_signer_ffi!();

use ffi_types::*;

/// Global registry of clients (handle-based for safety)
static CLIENTS: Lazy<Mutex<HashMap<ClientHandle, Arc<SmoldotClientWrapper>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Global registry of chains (handle-based for safety)
static CHAINS: Lazy<Mutex<HashMap<ChainHandle, Arc<SmoldotChainWrapper>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Wrapper around smoldot Client with interior mutability
struct SmoldotClientWrapper {
    client: Mutex<Client<Arc<DefaultPlatform>, ()>>,
    runtime: tokio::runtime::Runtime,
    capability_executor: NativeCapabilityExecutor,
}

/// Wrapper around Chain and ChainId
struct SmoldotChainWrapper {
    chain_id: ChainId,
    client_handle: ClientHandle,
    raw_json_rpc_responses: Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>>,
    pending_native_requests:
        Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    next_native_request_id: AtomicU64,
}

const SYSTEM_ACCOUNT_PREFIX_HEX: &str =
    "26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
const NATIVE_RPC_TIMEOUT_SECS: u64 = 30;
const TOKIO_WORKER_THREADS: usize = 2;
const NATIVE_CAPABILITY_WORKERS: usize = 2;
const NATIVE_CAPABILITY_QUEUE_CAPACITY: usize = 64;
const ANDROID_SMOLDOT_NICE: c_int = 5;

type NativeCapabilityJob = Box<dyn FnOnce() + Send + 'static>;

/// 固定大小的原生 capability 执行器。
///
/// 中文注释：旧实现每次 FFI 调用都 `std::thread::spawn`，并发查询会无上限创建
/// OS 线程。这里用两个常驻 worker 和有界队列收口资源，同时保留在 worker 内创建
/// `!Send` Future 并 `runtime.block_on` 的能力。
struct NativeCapabilityExecutor {
    sender: mpsc::SyncSender<NativeCapabilityJob>,
}

impl NativeCapabilityExecutor {
    fn new() -> Result<Self, String> {
        let (sender, receiver) =
            mpsc::sync_channel::<NativeCapabilityJob>(NATIVE_CAPABILITY_QUEUE_CAPACITY);
        let receiver = Arc::new(Mutex::new(receiver));

        for worker_index in 0..NATIVE_CAPABILITY_WORKERS {
            let receiver = Arc::clone(&receiver);
            std::thread::Builder::new()
                .name(format!("cit-cap-{worker_index}"))
                .spawn(move || {
                    lower_current_thread_priority();
                    loop {
                        let job = receiver.lock().recv();
                        let Ok(job) = job else { return };
                        job();
                    }
                })
                .map_err(|error| format!("Failed to start native capability worker: {error}"))?;
        }

        Ok(Self { sender })
    }

    fn try_spawn(&self, job: NativeCapabilityJob) -> Result<(), String> {
        self.sender.try_send(job).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => "native_capability_queue_full".to_string(),
            mpsc::TrySendError::Disconnected(_) => "native_capability_executor_stopped".to_string(),
        })
    }
}

fn configured_log_level(max_log_level: u8) -> log::LevelFilter {
    match max_log_level {
        0 => log::LevelFilter::Off,
        1 => log::LevelFilter::Error,
        2 => log::LevelFilter::Warn,
        3 => log::LevelFilter::Info,
        4 => log::LevelFilter::Debug,
        _ => log::LevelFilter::Trace,
    }
}

#[cfg(target_os = "android")]
fn lower_current_thread_priority() {
    // 中文注释：普通 App 无权提高优先级，但允许把自身 worker 调低到 nice=5。
    // 失败只影响调度优化，不得阻断轻节点启动或 capability 回调。
    let result = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, ANDROID_SMOLDOT_NICE) };
    if result != 0 {
        log::warn!("failed to lower smoldot worker priority");
    }
}

#[cfg(not(target_os = "android"))]
fn lower_current_thread_priority() {
    let _ = ANDROID_SMOLDOT_NICE;
}

/// Initialize a new smoldot client
///
/// # Safety
/// - `config_json` must be a valid null-terminated UTF-8 string
/// - Returns 0 on failure
#[no_mangle]
pub unsafe extern "C" fn smoldot_client_init(
    config_json: *const c_char,
    error_out: *mut *mut c_char,
) -> ClientHandle {
    if config_json.is_null() {
        set_error(error_out, "config_json is null");
        return 0;
    }

    let config_str = match CStr::from_ptr(config_json).to_str() {
        Ok(s) => s,
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in config_json");
            return 0;
        }
    };

    let config: ClientConfigJson = match serde_json::from_str(config_str) {
        Ok(c) => c,
        Err(e) => {
            set_error(error_out, &format!("Failed to parse config: {}", e));
            return 0;
        }
    };

    let log_level = configured_log_level(config.max_log_level);

    // 初始化 Android 日志（仅首次调用生效），使 smoldot 内部日志输出到 logcat。
    #[cfg(target_os = "android")]
    {
        let _ = android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log_level)
                .with_tag("smoldot"),
        );
    }
    // 非 Android 平台使用 env_logger
    #[cfg(not(target_os = "android"))]
    {
        let _ = env_logger::Builder::new()
            .filter_level(log_level)
            .try_init();
    }

    // 中文注释：手机核心数不再直接决定同步 worker 数；两个低优先级 worker 是
    // CitizenApp 原生同步的固定 CPU 并发上限，避免再次挤占 Flutter main/raster。
    let tokio_thread_index = AtomicUsize::new(0);
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(TOKIO_WORKER_THREADS)
        .thread_name_fn(move || {
            let index = tokio_thread_index.fetch_add(1, Ordering::Relaxed);
            format!("cit-smol-{index}")
        })
        .on_thread_start(lower_current_thread_priority)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            set_error(error_out, &format!("Failed to create runtime: {}", e));
            return 0;
        }
    };

    // Get system name and version
    let system_name = config
        .system_name
        .unwrap_or_else(|| "Polkadart".to_string());
    let system_version = config.system_version.unwrap_or_else(|| "0.1.0".to_string());

    // Initialize smoldot client (Client::new wraps platform in Arc internally)
    let platform = DefaultPlatform::new(system_name, system_version);

    let client = Client::new(platform);

    let capability_executor = match NativeCapabilityExecutor::new() {
        Ok(executor) => executor,
        Err(error) => {
            set_error(error_out, &error);
            return 0;
        }
    };

    let wrapper = Arc::new(SmoldotClientWrapper {
        client: Mutex::new(client),
        runtime,
        capability_executor,
    });

    // Generate handle
    let handle = generate_client_handle();

    // Store in registry
    CLIENTS.lock().insert(handle, wrapper);

    handle
}

/// Add a chain to the client
///
/// # Safety
/// - `client_handle` must be a valid handle returned from `smoldot_client_init`
/// - `chain_spec_json` must be a valid null-terminated UTF-8 string
/// - `callback` must be a valid function pointer
#[no_mangle]
pub unsafe extern "C" fn smoldot_add_chain(
    client_handle: ClientHandle,
    chain_spec_json: *const c_char,
    potential_relay_chains: *const ChainHandle,
    relay_chains_count: c_int,
    database_content: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if chain_spec_json.is_null() {
        set_error(error_out, "chain_spec_json is null");
        return -1;
    }

    let chain_spec = match CStr::from_ptr(chain_spec_json).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in chain_spec_json");
            return -1;
        }
    };

    let db_content = if !database_content.is_null() {
        match CStr::from_ptr(database_content).to_str() {
            Ok(s) => s.to_string(),
            Err(_) => {
                set_error(error_out, "Invalid UTF-8 in database_content");
                return -1;
            }
        }
    } else {
        String::new()
    };

    // Get client from registry
    let client_wrapper = {
        let clients = CLIENTS.lock();
        match clients.get(&client_handle) {
            Some(c) => Arc::clone(c),
            None => {
                set_error(error_out, "Invalid client handle");
                return -1;
            }
        }
    };

    // Parse potential relay chains
    let relay_chains: Vec<ChainId> = if !potential_relay_chains.is_null() && relay_chains_count > 0
    {
        let chains_slice =
            std::slice::from_raw_parts(potential_relay_chains, relay_chains_count as usize);

        let chains_lock = CHAINS.lock();
        chains_slice
            .iter()
            .filter_map(|&handle| chains_lock.get(&handle).map(|wrapper| wrapper.chain_id))
            .collect()
    } else {
        Vec::new()
    };

    // Clone Arc to move into async block
    let client_wrapper_clone = Arc::clone(&client_wrapper);

    // Spawn async task to add chain
    client_wrapper.runtime.spawn(async move {
        let config = AddChainConfig {
            specification: &chain_spec,
            json_rpc: AddChainConfigJsonRpc::Enabled {
                max_pending_requests: std::num::NonZeroU32::new(128).unwrap(),
                max_subscriptions: 1024,
            },
            potential_relay_chains: relay_chains.into_iter(),
            database_content: &db_content,
            user_data: (),
        };

        // Get mutable access to client (add_chain is NOT async in 0.18.0)
        let add_result = {
            let mut client = client_wrapper_clone.client.lock();
            client.add_chain(config)
        };

        match add_result {
            Ok(AddChainSuccess {
                chain_id,
                json_rpc_responses,
            }) => {
                let (raw_tx, raw_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

                // Create chain wrapper
                let chain_wrapper = Arc::new(SmoldotChainWrapper {
                    chain_id,
                    client_handle,
                    raw_json_rpc_responses: Arc::new(tokio::sync::Mutex::new(raw_rx)),
                    pending_native_requests: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                    next_native_request_id: AtomicU64::new(1),
                });
                let pending_native_requests = Arc::clone(&chain_wrapper.pending_native_requests);

                if let Some(json_rpc_responses) = json_rpc_responses {
                    client_wrapper_clone.runtime.spawn(async move {
                        forward_json_rpc_responses(
                            json_rpc_responses,
                            raw_tx,
                            pending_native_requests,
                        )
                        .await;
                    });
                } else {
                    let _ = raw_tx.send(
                        json!({
                            "jsonrpc": "2.0",
                            "error": {
                                "code": -32001,
                                "message": "JSON-RPC is disabled for this chain",
                            }
                        })
                        .to_string(),
                    );
                }

                // Generate handle
                let chain_handle = generate_chain_handle();

                // Store in registry
                CHAINS.lock().insert(chain_handle, chain_wrapper);

                // Invoke callback with success
                callback(callback_id, chain_handle as i64, std::ptr::null());
            }
            Err(e) => {
                // Create error message
                let error_msg = CString::new(format!("Failed to add chain: {:?}", e))
                    .unwrap_or_else(|_| CString::new("Unknown error").unwrap());
                callback(callback_id, 0, error_msg.as_ptr());
                // Note: error_msg is leaked here, Dart side must free it
                std::mem::forget(error_msg);
            }
        }
    });

    0 // Success (async operation started)
}

/// Send a JSON-RPC request to a chain
///
/// # Safety
/// - `chain_handle` must be a valid handle
/// - `request_json` must be a valid null-terminated UTF-8 string
#[no_mangle]
pub unsafe extern "C" fn smoldot_send_json_rpc(
    chain_handle: ChainHandle,
    request_json: *const c_char,
    error_out: *mut *mut c_char,
) -> c_int {
    if request_json.is_null() {
        set_error(error_out, "request_json is null");
        return -1;
    }

    let request = match CStr::from_ptr(request_json).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in request_json");
            return -1;
        }
    };

    // Get chain from registry
    let chain_wrapper = {
        let chains = CHAINS.lock();
        match chains.get(&chain_handle) {
            Some(c) => Arc::clone(c),
            None => {
                set_error(error_out, "Invalid chain handle");
                return -1;
            }
        }
    };

    // Get client
    let client_wrapper = {
        let clients = CLIENTS.lock();
        match clients.get(&chain_wrapper.client_handle) {
            Some(c) => Arc::clone(c),
            None => {
                set_error(error_out, "Invalid client handle");
                return -1;
            }
        }
    };

    // Send JSON-RPC request (needs mutable access)
    let mut client = client_wrapper.client.lock();
    match client.json_rpc_request(&request, chain_wrapper.chain_id) {
        Ok(_) => 0,
        Err(e) => {
            set_error(error_out, &format!("JSON-RPC error: {:?}", e));
            -1
        }
    }
}

/// Get next JSON-RPC response from a chain (blocking)
///
/// # Safety
/// - `chain_handle` must be a valid handle
/// - `callback` must be a valid function pointer
/// - Caller must free the returned string with `smoldot_free_string`
#[no_mangle]
pub unsafe extern "C" fn smoldot_next_json_rpc_response(
    chain_handle: ChainHandle,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    // Get chain from registry
    let chain_wrapper = {
        let chains = CHAINS.lock();
        match chains.get(&chain_handle) {
            Some(c) => Arc::clone(c),
            None => {
                set_error(error_out, "Invalid chain handle");
                return -1;
            }
        }
    };

    // Get client
    let client_wrapper = {
        let clients = CLIENTS.lock();
        match clients.get(&chain_wrapper.client_handle) {
            Some(c) => Arc::clone(c),
            None => {
                set_error(error_out, "Invalid client handle");
                return -1;
            }
        }
    };

    let raw_responses_arc = Arc::clone(&chain_wrapper.raw_json_rpc_responses);

    // Spawn async task
    client_wrapper.runtime.spawn(async move {
        let response_result = {
            let mut responses_lock = raw_responses_arc.lock().await;
            match responses_lock.recv().await {
                Some(response) => Ok(response),
                None => Err("Channel closed"),
            }
        };

        match response_result {
            Ok(response) => {
                // Convert response to C string
                let response_cstr =
                    CString::new(response).unwrap_or_else(|_| CString::new("").unwrap());
                callback(callback_id, response_cstr.as_ptr() as i64, std::ptr::null());
                std::mem::forget(response_cstr); // Dart must free
            }
            Err(error_msg) => {
                let error_cstr = CString::new(error_msg).unwrap();
                callback(callback_id, 0, error_cstr.as_ptr());
                std::mem::forget(error_cstr);
            }
        }
    });

    0 // Success
}

/// Remove a chain from the client
///
/// # Safety
/// - `chain_handle` must be a valid handle
#[no_mangle]
pub unsafe extern "C" fn smoldot_remove_chain(
    chain_handle: ChainHandle,
    error_out: *mut *mut c_char,
) -> c_int {
    // Remove from registry
    let chain_wrapper = {
        let mut chains = CHAINS.lock();
        match chains.remove(&chain_handle) {
            Some(c) => c,
            None => {
                set_error(error_out, "Invalid chain handle");
                return -1;
            }
        }
    };

    // Get client
    let client_wrapper = {
        let clients = CLIENTS.lock();
        match clients.get(&chain_wrapper.client_handle) {
            Some(c) => Arc::clone(c),
            None => {
                set_error(error_out, "Invalid client handle");
                return -1;
            }
        }
    };

    // Remove chain from client (needs mutable access)
    let mut client = client_wrapper.client.lock();
    // upstream 把返回 `TChain` 的 remove_chain 标了 #[must_use]，而本处 TChain 实例化为 `()`：
    // 裸调用触发 unused_must_use，任何形式的绑定又触发 let_unit_value，两个 lint 互相打架。
    // 本处确实不需要 chain 的用户数据，故只对这一条语句放宽 let_unit_value，不扩到函数或模块。
    #[allow(clippy::let_unit_value)]
    let _ = client.remove_chain(chain_wrapper.chain_id);

    0 // Success
}

/// Destroy a client and all its chains
///
/// # Safety
/// - `client_handle` must be a valid handle
/// - All chain handles for this client become invalid
#[no_mangle]
pub unsafe extern "C" fn smoldot_client_destroy(
    client_handle: ClientHandle,
    error_out: *mut *mut c_char,
) -> c_int {
    // Remove all chains for this client
    {
        let mut chains = CHAINS.lock();
        chains.retain(|_, wrapper| wrapper.client_handle != client_handle);
    }

    // Remove client from registry
    let mut clients = CLIENTS.lock();
    if clients.remove(&client_handle).is_none() {
        set_error(error_out, "Invalid client handle");
        return -1;
    }

    0 // Success
}

/// Free a string allocated by Rust
///
/// # Safety
/// - `ptr` must have been allocated by Rust via CString
#[no_mangle]
pub unsafe extern "C" fn smoldot_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr);
    }
}

/// Get the version of the smoldot FFI library
///
/// # Safety
/// - Returned string must be freed with `smoldot_free_string`
#[no_mangle]
pub unsafe extern "C" fn smoldot_version() -> *mut c_char {
    let version = env!("CARGO_PKG_VERSION");
    CString::new(version)
        .unwrap_or_else(|_| CString::new("unknown").unwrap())
        .into_raw()
}

// ──── 异步 FFI 导出（不阻塞 Dart 主线程） ────

fn sync_phase_name(phase: smoldot_light::SyncPhase) -> &'static str {
    match phase {
        smoldot_light::SyncPhase::Regular => "regular",
        smoldot_light::SyncPhase::WarpDownloadingFragments => "warpDownloadingFragments",
        smoldot_light::SyncPhase::WarpVerifyingFragments => "warpVerifyingFragments",
        smoldot_light::SyncPhase::WarpDownloadingTargetState => "warpDownloadingTargetState",
        smoldot_light::SyncPhase::WarpBuildingRuntime => "warpBuildingRuntime",
        smoldot_light::SyncPhase::WarpBuildingChainInformation => "warpBuildingChainInformation",
    }
}

fn startup_finalized_source_name(source: smoldot_light::StartupFinalizedSource) -> &'static str {
    match source {
        smoldot_light::StartupFinalizedSource::BundledCheckpoint => "bundledCheckpoint",
        smoldot_light::StartupFinalizedSource::LocalDatabase => "localDatabase",
    }
}

fn warp_failure_name(failure: smoldot_light::WarpFailure) -> &'static str {
    match failure {
        smoldot_light::WarpFailure::EmptyProof => "emptyProof",
        smoldot_light::WarpFailure::InvalidHeader => "invalidHeader",
        smoldot_light::WarpFailure::InvalidJustification => "invalidJustification",
        smoldot_light::WarpFailure::BlockNumberNotIncrementing => "blockNumberNotIncrementing",
        smoldot_light::WarpFailure::TargetHashMismatch => "targetHashMismatch",
        smoldot_light::WarpFailure::JustificationVerifyFailed => "justificationVerifyFailed",
        smoldot_light::WarpFailure::NonMinimalProof => "nonMinimalProof",
        smoldot_light::WarpFailure::WarpRequestFailed => "warpRequestFailed",
        smoldot_light::WarpFailure::StorageProofRequestFailed => "storageProofRequestFailed",
        smoldot_light::WarpFailure::CallProofRequestFailed => "callProofRequestFailed",
        smoldot_light::WarpFailure::RuntimeBuildFailed => "runtimeBuildFailed",
        smoldot_light::WarpFailure::ChainInformationBuildFailed => "chainInformationBuildFailed",
    }
}

fn finish_native_callback(
    callback_id: i64,
    callback: DartCallback,
    result: Result<String, String>,
) {
    match result {
        Ok(json_str) => {
            let cstr = CString::new(json_str).unwrap_or_else(|_| CString::new("{}").unwrap());
            unsafe { callback(callback_id, cstr.as_ptr() as i64, std::ptr::null()) };
            std::mem::forget(cstr);
        }
        Err(message) => {
            let cstr =
                CString::new(message).unwrap_or_else(|_| CString::new("Unknown error").unwrap());
            unsafe { callback(callback_id, 0, cstr.as_ptr()) };
            std::mem::forget(cstr);
        }
    }
}

/// 异步回调辅助：把 async 闭包提交到固定原生 worker，完成后通过 DartCallback 回调。
///
/// Future 在 worker 内创建，因此无需实现 `Send`。任务只捕获 handle，不持有 client Arc；
/// dispose 后尚未执行的排队任务会在重新查找 handle 时失败，不会延长旧生命周期。
fn spawn_native_capability_async<F, Fut>(
    chain_handle: ChainHandle,
    callback_id: i64,
    callback: DartCallback,
    f: F,
) -> Result<(), String>
where
    F: FnOnce(Arc<SmoldotChainWrapper>, Arc<SmoldotClientWrapper>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let chain_wrapper = get_chain_wrapper(chain_handle)?;
    let client_handle = chain_wrapper.client_handle;
    let client_wrapper = get_client_wrapper(client_handle)?;
    client_wrapper
        .capability_executor
        .try_spawn(Box::new(move || {
            let result = (|| {
                let chain_wrapper = get_chain_wrapper(chain_handle)?;
                if chain_wrapper.client_handle != client_handle {
                    return Err("Chain handle no longer belongs to the original client".to_string());
                }
                let client_wrapper = get_client_wrapper(client_handle)?;
                client_wrapper
                    .runtime
                    .block_on(f(Arc::clone(&chain_wrapper), Arc::clone(&client_wrapper)))
            })();
            finish_native_callback(callback_id, callback, result);
        }))
}

/// 异步 FFI 入口的错误处理宏：参数校验失败时设置 error_out 并返回 -1。
macro_rules! async_ffi_entry {
    ($chain_handle:expr, $callback_id:expr, $callback:expr, $error_out:expr, $body:expr) => {
        match spawn_native_capability_async($chain_handle, $callback_id, $callback, $body) {
            Ok(()) => 0,
            Err(message) => {
                set_error($error_out, &message);
                -1
            }
        }
    };
}

/// 异步读取轻节点状态快照；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_status_snapshot_async(
    chain_handle: ChainHandle,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        |chain_wrapper, client_wrapper| async move {
            let snapshot_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_status_snapshot(chain_wrapper.chain_id)
                    .map_err(|error| error.to_string())?
            };
            let snapshot = snapshot_future.await.map_err(|error| error.to_string())?;
            Ok(json!({
                "peerCount": snapshot.peer_count,
                "isSyncing": snapshot.is_syncing,
                "isUsable": snapshot.is_usable,
                "bestBlockNumber": snapshot.best_block_number,
                "bestBlockHash": format!("0x{}", hex::encode(snapshot.best_block_hash)),
                "finalizedBlockNumber": snapshot.finalized_block_number,
                "finalizedBlockHash": format!("0x{}", hex::encode(snapshot.finalized_block_hash)),
                "syncPhase": sync_phase_name(snapshot.sync_phase),
                "startupFinalizedSource": snapshot.startup_finalized_source.map(startup_finalized_source_name),
                "startupFinalizedBlockNumber": snapshot.startup_finalized_block_number,
                "startupFinalizedBlockHash": snapshot.startup_finalized_block_hash.map(|hash| format!("0x{}", hex::encode(hash))),
                "highestPeerFinalizedBlockNumber": snapshot.highest_peer_finalized_block_number,
                "currentVerifiedFinalizedBlockNumber": snapshot.current_verified_finalized_block_number,
                "currentVerifiedFinalizedBlockHash": format!("0x{}", hex::encode(snapshot.current_verified_finalized_block_hash)),
                "warpTargetFinalizedBlockNumber": snapshot.warp_target_finalized_block_number,
                "warpTargetFinalizedBlockHash": snapshot.warp_target_finalized_block_hash.map(|hash| format!("0x{}", hex::encode(hash))),
                "warpRequestCount": snapshot.warp_request_count,
                "activeWarpFragmentRequestCount": snapshot.active_warp_fragment_request_count,
                "activeWarpStorageRequestCount": snapshot.active_warp_storage_request_count,
                "activeWarpCallProofRequestCount": snapshot.active_warp_call_proof_request_count,
                "warpReceivedFragmentCount": snapshot.warp_received_fragment_count,
                "warpVerifiedFragmentCount": snapshot.warp_verified_fragment_count,
                "warpRejectedFragmentCount": snapshot.warp_rejected_fragment_count,
                "warpLastFailure": snapshot.warp_last_failure.map(warp_failure_name),
            })
            .to_string())
        }
    )
}

/// 异步读取runtime 版本；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_runtime_version_async(
    chain_handle: ChainHandle,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        |chain_wrapper, client_wrapper| async move {
            let snapshot_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_runtime_version_snapshot(chain_wrapper.chain_id)
                    .map_err(|error| error.to_string())?
            };
            let runtime_version = snapshot_future.await.map_err(|error| error.to_string())?;
            let apis = runtime_version
                .apis
                .iter()
                .map(|(name_hash, version)| {
                    json!([format!("0x{}", hex::encode(name_hash)), *version])
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "specName": runtime_version.spec_name,
                "implName": runtime_version.impl_name,
                "authoringVersion": runtime_version.authoring_version,
                "specVersion": runtime_version.spec_version,
                "implVersion": runtime_version.impl_version,
                "transactionVersion": runtime_version.transaction_version,
                "stateVersion": runtime_version.state_version,
                "apis": apis,
            })
            .to_string())
        }
    )
}

/// 异步读取runtime metadata；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_metadata_async(
    chain_handle: ChainHandle,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        |chain_wrapper, client_wrapper| async move {
            let metadata_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_metadata(chain_wrapper.chain_id)
                    .map_err(|error| error.to_string())?
            };
            let metadata = metadata_future.await.map_err(|error| error.to_string())?;
            Ok(format!("0x{}", hex::encode(metadata)))
        }
    )
}

/// 异步读取账户下一个可用 nonce；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `account_id_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_account_next_index_async(
    chain_handle: ChainHandle,
    account_id_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if account_id_hex.is_null() {
        set_error(error_out, "account_id_hex is null");
        return -1;
    }
    let account_id_hex = match CStr::from_ptr(account_id_hex).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in account_id_hex");
            return -1;
        }
    };
    let account_id = match decode_account_id_hex(&account_id_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            set_error(error_out, &message);
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let next_index_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_account_next_index(chain_wrapper.chain_id, account_id)
                    .map_err(|error| error.to_string())?
            };
            let next_index = next_index_future.await.map_err(|error| error.to_string())?;
            Ok(next_index.to_string())
        }
    )
}

/// 异步读取指定高度的区块哈希；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `block_number` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_block_hash_async(
    chain_handle: ChainHandle,
    block_number: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if block_number.is_null() {
        set_error(error_out, "block_number is null");
        return -1;
    }
    let block_number = match CStr::from_ptr(block_number).to_str() {
        Ok(value) => value,
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in block_number");
            return -1;
        }
    };
    let block_number = match block_number.parse::<u64>() {
        Ok(value) => value,
        Err(error) => {
            set_error(error_out, &format!("Invalid block_number: {error}"));
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let known_block_hash_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_known_block_hash(chain_wrapper.chain_id, block_number)
                    .map_err(|error| error.to_string())?
            };
            if let Some(block_hash) = known_block_hash_future
                .await
                .map_err(|error| error.to_string())?
            {
                return Ok(format!("0x{}", hex::encode(block_hash)));
            }
            let result = native_json_rpc_request(
                Arc::clone(&chain_wrapper),
                Arc::clone(&client_wrapper),
                "chain_getBlockHash",
                json!([block_number]),
            )
            .await?;
            // 轻节点正常情况——finalized 之前的旧区块没在 smoldot
            // 缓存里，chain_getBlockHash 返回 null。把 null 当作"未知"返回空串，
            // 由 dart 层判定为 None，绝不抛错（否则 PendingTxReconciler 会
            // 对每个老区块号刷一条 non-string 错误日志，淹没真问题）。
            if result.is_null() {
                return Ok(String::new());
            }
            result.as_str().map(|s| s.to_string()).ok_or_else(|| {
                format!(
                    "chain_getBlockHash returned non-string for height {block_number}: {result}"
                )
            })
        }
    )
}

/// 异步读取指定区块的 extrinsic 列表；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `block_hash_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_block_extrinsics_async(
    chain_handle: ChainHandle,
    block_hash_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if block_hash_hex.is_null() {
        set_error(error_out, "block_hash_hex is null");
        return -1;
    }
    let block_hash_hex = match CStr::from_ptr(block_hash_hex).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in block_hash_hex");
            return -1;
        }
    };
    let block_hash = match decode_prefixed_hex(&block_hash_hex) {
        Ok(bytes) => match <[u8; 32]>::try_from(bytes.as_slice()) {
            Ok(hash) => hash,
            Err(_) => {
                set_error(error_out, "block_hash_hex must decode to 32 bytes");
                return -1;
            }
        },
        Err(message) => {
            set_error(error_out, &message);
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let native_extrinsics_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_block_extrinsics(chain_wrapper.chain_id, block_hash)
                    .map_err(|error| error.to_string())?
            };
            let values = match native_extrinsics_future.await {
                Ok(extrinsics) => extrinsics
                    .into_iter()
                    .map(|extrinsic| format!("0x{}", hex::encode(extrinsic)))
                    .collect::<Vec<_>>(),
                Err(error) => {
                    return Err(format!(
                        "Failed to download block body for {block_hash_hex}: {error}"
                    ));
                }
            };
            serde_json::to_string(&values)
                .map_err(|error| format!("Failed to encode block extrinsics JSON: {error}"))
        }
    )
}

/// 异步读取提交 extrinsic 到交易池；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `extrinsic_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_submit_extrinsic_async(
    chain_handle: ChainHandle,
    extrinsic_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if extrinsic_hex.is_null() {
        set_error(error_out, "extrinsic_hex is null");
        return -1;
    }
    let extrinsic_hex = match CStr::from_ptr(extrinsic_hex).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in extrinsic_hex");
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let result = native_json_rpc_request(
                Arc::clone(&chain_wrapper),
                Arc::clone(&client_wrapper),
                "author_submitExtrinsic",
                json!([extrinsic_hex]),
            )
            .await?;
            let tx_hash = result
                .as_str()
                .ok_or_else(|| "author_submitExtrinsic result is not a string".to_string())?;
            Ok(tx_hash.to_string())
        }
    )
}

/// 异步读取最新块的 System::Account；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `account_id_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_system_account_async(
    chain_handle: ChainHandle,
    account_id_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if account_id_hex.is_null() {
        set_error(error_out, "account_id_hex is null");
        return -1;
    }
    let account_id_hex = match CStr::from_ptr(account_id_hex).to_str() {
        Ok(value) => value,
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in account_id_hex");
            return -1;
        }
    };
    let account_id = match decode_account_id_hex(account_id_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            set_error(error_out, &message);
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let storage_key = build_system_account_storage_key(&account_id);
            let storage_key_bytes = decode_prefixed_hex(&storage_key)?;
            let native_storage_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_storage_values(chain_wrapper.chain_id, vec![storage_key_bytes])
                    .map_err(|error| error.to_string())?
            };
            let storage_value_hex = native_storage_future
                .await
                .map_err(|error| error.to_string())?
                .pop()
                .flatten()
                .map(|value_bytes| format!("0x{}", hex::encode(value_bytes)));

            if storage_value_hex.is_none() {
                return Ok(json!({
                    "storageKey": storage_key,
                    "exists": false,
                })
                .to_string());
            }

            let value_hex = storage_value_hex.unwrap();
            let value_bytes = decode_prefixed_hex(&value_hex)?;
            let nonce = if value_bytes.len() >= 4 {
                Some(u32::from_le_bytes([
                    value_bytes[0],
                    value_bytes[1],
                    value_bytes[2],
                    value_bytes[3],
                ]) as u64)
            } else {
                None
            };
            let free_fen = if value_bytes.len() >= 32 {
                Some(read_u128_le_string(&value_bytes, 16)?)
            } else {
                None
            };

            Ok(json!({
                "storageKey": storage_key,
                "exists": true,
                "valueHex": value_hex,
                "nonce": nonce,
                "freeFen": free_fen,
            })
            .to_string())
        }
    )
}

/// 异步读取finalized 的 System::Account；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `account_id_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_finalized_system_account_async(
    chain_handle: ChainHandle,
    account_id_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if account_id_hex.is_null() {
        set_error(error_out, "account_id_hex is null");
        return -1;
    }
    let account_id_hex = match CStr::from_ptr(account_id_hex).to_str() {
        Ok(value) => value,
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in account_id_hex");
            return -1;
        }
    };
    let account_id = match decode_account_id_hex(account_id_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            set_error(error_out, &message);
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let storage_key = build_system_account_storage_key(&account_id);
            let storage_key_bytes = decode_prefixed_hex(&storage_key)?;
            let native_storage_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_finalized_storage_values(chain_wrapper.chain_id, vec![storage_key_bytes])
                    .map_err(|error| error.to_string())?
            };
            let storage_value_hex = native_storage_future
                .await
                .map_err(|error| error.to_string())?
                .pop()
                .flatten()
                .map(|value_bytes| format!("0x{}", hex::encode(value_bytes)));

            if storage_value_hex.is_none() {
                return Ok(json!({
                    "storageKey": storage_key,
                    "exists": false,
                })
                .to_string());
            }

            let value_hex = storage_value_hex.unwrap();
            let value_bytes = decode_prefixed_hex(&value_hex)?;
            let nonce = if value_bytes.len() >= 4 {
                Some(u32::from_le_bytes([
                    value_bytes[0],
                    value_bytes[1],
                    value_bytes[2],
                    value_bytes[3],
                ]) as u64)
            } else {
                None
            };
            let free_fen = if value_bytes.len() >= 32 {
                Some(read_u128_le_string(&value_bytes, 16)?)
            } else {
                None
            };

            Ok(json!({
                "storageKey": storage_key,
                "exists": true,
                "valueHex": value_hex,
                "nonce": nonce,
                "freeFen": free_fen,
            })
            .to_string())
        }
    )
}

/// 异步读取最新块的单个 storage 值；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `storage_key_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_storage_value_async(
    chain_handle: ChainHandle,
    storage_key_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if storage_key_hex.is_null() {
        set_error(error_out, "storage_key_hex is null");
        return -1;
    }
    let storage_key_hex = match CStr::from_ptr(storage_key_hex).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in storage_key_hex");
            return -1;
        }
    };
    let storage_key_bytes = match decode_prefixed_hex(&storage_key_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            set_error(error_out, &message);
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let native_storage_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_storage_values(chain_wrapper.chain_id, vec![storage_key_bytes])
                    .map_err(|error| error.to_string())?
            };
            let storage_value = native_storage_future
                .await
                .map_err(|error| error.to_string())?
                .pop()
                .flatten();
            Ok(json_storage_value_response_from_bytes(&storage_key_hex, storage_value).to_string())
        }
    )
}

/// 异步读取finalized 的单个 storage 值；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `storage_key_hex` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_finalized_storage_value_async(
    chain_handle: ChainHandle,
    storage_key_hex: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if storage_key_hex.is_null() {
        set_error(error_out, "storage_key_hex is null");
        return -1;
    }
    let storage_key_hex = match CStr::from_ptr(storage_key_hex).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in storage_key_hex");
            return -1;
        }
    };
    let storage_key_bytes = match decode_prefixed_hex(&storage_key_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            set_error(error_out, &message);
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let native_storage_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_finalized_storage_values(chain_wrapper.chain_id, vec![storage_key_bytes])
                    .map_err(|error| error.to_string())?
            };
            let storage_value = native_storage_future
                .await
                .map_err(|error| error.to_string())?
                .pop()
                .flatten();
            Ok(json_storage_value_response_from_bytes(&storage_key_hex, storage_value).to_string())
        }
    )
}

/// 异步读取最新块的批量 storage 值；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `storage_keys_json` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_storage_values_async(
    chain_handle: ChainHandle,
    storage_keys_json: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if storage_keys_json.is_null() {
        set_error(error_out, "storage_keys_json is null");
        return -1;
    }
    let storage_keys_json = match CStr::from_ptr(storage_keys_json).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in storage_keys_json");
            return -1;
        }
    };
    let storage_keys: Vec<String> = match serde_json::from_str(&storage_keys_json) {
        Ok(value) => value,
        Err(error) => {
            set_error(
                error_out,
                &format!("Failed to parse storage_keys_json: {error}"),
            );
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let decoded_storage_keys = storage_keys
                .iter()
                .map(|storage_key_hex| decode_prefixed_hex(storage_key_hex))
                .collect::<Result<Vec<_>, _>>()?;
            let native_storage_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_storage_values(chain_wrapper.chain_id, decoded_storage_keys)
                    .map_err(|error| error.to_string())?
            };
            let native_values = native_storage_future
                .await
                .map_err(|error| error.to_string())?;
            let mut values = serde_json::Map::with_capacity(storage_keys.len());
            for (storage_key_hex, storage_value) in
                storage_keys.iter().zip(native_values.into_iter())
            {
                let value_hex = storage_value
                    .map(|value_bytes| Value::String(format!("0x{}", hex::encode(value_bytes))))
                    .unwrap_or(Value::Null);
                values.insert(storage_key_hex.clone(), value_hex);
            }
            Ok(Value::Object(values).to_string())
        }
    )
}

/// 异步读取finalized 的批量 storage 值；结果经 `callback` 回传，本函数立即返回。
///
/// # Safety
/// - `chain_handle` 必须来自 `smoldot_add_chain` 且未被 `smoldot_remove_chain` 释放；
///   句柄失效会在运行期被检出并返回 -1，不构成 UB。
/// - `storage_keys_json` 必须是有效的 NUL 结尾字符串；空指针与非 UTF-8 已在函数内检出并返回 -1。
/// - `error_out` 允许为空；非空时必须是可写的 `*mut *mut c_char`。仅在返回 -1 时写入，
///   写入的字符串所有权转移给调用方，必须用 `smoldot_free_string` 释放。
/// - `callback` 必须在异步操作完成前一直有效，且**会在原生 worker 线程上被调用**，
///   不是调用本函数的那个线程。
/// - 回调拿到的 result 指针（成功路径，以 i64 传递）与 error 指针（失败路径）
///   均转移所有权给调用方，两者都必须用 `smoldot_free_string` 释放，否则泄漏。
#[no_mangle]
pub unsafe extern "C" fn smoldot_get_finalized_storage_values_async(
    chain_handle: ChainHandle,
    storage_keys_json: *const c_char,
    callback_id: i64,
    callback: DartCallback,
    error_out: *mut *mut c_char,
) -> c_int {
    if storage_keys_json.is_null() {
        set_error(error_out, "storage_keys_json is null");
        return -1;
    }
    let storage_keys_json = match CStr::from_ptr(storage_keys_json).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            set_error(error_out, "Invalid UTF-8 in storage_keys_json");
            return -1;
        }
    };
    let storage_keys: Vec<String> = match serde_json::from_str(&storage_keys_json) {
        Ok(value) => value,
        Err(error) => {
            set_error(
                error_out,
                &format!("Failed to parse storage_keys_json: {error}"),
            );
            return -1;
        }
    };

    async_ffi_entry!(
        chain_handle,
        callback_id,
        callback,
        error_out,
        move |chain_wrapper, client_wrapper| async move {
            let decoded_storage_keys = storage_keys
                .iter()
                .map(|storage_key_hex| decode_prefixed_hex(storage_key_hex))
                .collect::<Result<Vec<_>, _>>()?;
            let native_storage_future = {
                let client = client_wrapper.client.lock();
                client
                    .chain_finalized_storage_values(chain_wrapper.chain_id, decoded_storage_keys)
                    .map_err(|error| error.to_string())?
            };
            let native_values = native_storage_future
                .await
                .map_err(|error| error.to_string())?;
            let mut values = serde_json::Map::with_capacity(storage_keys.len());
            for (storage_key_hex, storage_value) in
                storage_keys.iter().zip(native_values.into_iter())
            {
                let value_hex = storage_value
                    .map(|value_bytes| Value::String(format!("0x{}", hex::encode(value_bytes))))
                    .unwrap_or(Value::Null);
                values.insert(storage_key_hex.clone(), value_hex);
            }
            Ok(Value::Object(values).to_string())
        }
    )
}

// Helper functions

fn generate_client_handle() -> ClientHandle {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn generate_chain_handle() -> ChainHandle {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

pub(crate) unsafe fn set_error(error_out: *mut *mut c_char, message: &str) {
    if !error_out.is_null() {
        let error_cstr =
            CString::new(message).unwrap_or_else(|_| CString::new("Unknown error").unwrap());
        *error_out = error_cstr.into_raw();
    }
}

async fn forward_json_rpc_responses(
    mut responses: JsonRpcResponses<Arc<DefaultPlatform>>,
    raw_tx: tokio::sync::mpsc::UnboundedSender<String>,
    pending_native_requests: Arc<
        tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>,
    >,
) {
    while let Some(response) = responses.next().await {
        // 未被原生请求认领的响应才转发给 Dart 侧通道；通道关闭即结束转发循环。
        if !dispatch_native_response(&pending_native_requests, &response).await
            && raw_tx.send(response).is_err()
        {
            break;
        }
    }
}

async fn dispatch_native_response(
    pending_native_requests: &Arc<
        tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<String>>>,
    >,
    response: &str,
) -> bool {
    let Ok(json_value) = serde_json::from_str::<Value>(response) else {
        return false;
    };
    let Some(id_value) = json_value.get("id") else {
        return false;
    };
    let request_id = match id_value {
        Value::String(value) => value.clone(),
        _ => id_value.to_string(),
    };

    let sender = {
        let mut pending = pending_native_requests.lock().await;
        pending.remove(&request_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(response.to_string());
        return true;
    }
    false
}

/// 在 tokio runtime 上同步执行原生 capability 闭包。
///
/// # Safety (threading)
/// 必须从非 tokio 线程调用（即 Dart FFI 同步回调线程）。
/// 如果从 tokio runtime 内部调用会导致死锁。
fn get_chain_wrapper(chain_handle: ChainHandle) -> Result<Arc<SmoldotChainWrapper>, String> {
    let chains = CHAINS.lock();
    chains
        .get(&chain_handle)
        .cloned()
        .ok_or_else(|| "Invalid chain handle".to_string())
}

fn get_client_wrapper(client_handle: ClientHandle) -> Result<Arc<SmoldotClientWrapper>, String> {
    let clients = CLIENTS.lock();
    clients
        .get(&client_handle)
        .cloned()
        .ok_or_else(|| "Invalid client handle".to_string())
}

async fn native_json_rpc_request(
    chain_wrapper: Arc<SmoldotChainWrapper>,
    client_wrapper: Arc<SmoldotClientWrapper>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let request_id = format!(
        "__native_{}",
        chain_wrapper
            .next_native_request_id
            .fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();

    {
        let mut pending = chain_wrapper.pending_native_requests.lock().await;
        pending.insert(request_id.clone(), sender);
    }

    let request = json!({
        "id": request_id,
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    })
    .to_string();

    {
        let mut client = client_wrapper.client.lock();
        client
            .json_rpc_request(request, chain_wrapper.chain_id)
            .map_err(|error| format!("JSON-RPC queue error for {method}: {error:?}"))?;
    }

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(NATIVE_RPC_TIMEOUT_SECS),
        receiver,
    )
    .await
    .map_err(|_| format!("JSON-RPC timeout for {method}"))?
    .map_err(|_| format!("JSON-RPC channel closed for {method}"))?;

    let response_json: Value = serde_json::from_str(&response)
        .map_err(|error| format!("Invalid JSON-RPC response for {method}: {error}"))?;
    if let Some(error) = response_json.get("error") {
        return Err(format!("JSON-RPC error for {method}: {error}"));
    }
    Ok(response_json.get("result").cloned().unwrap_or(Value::Null))
}

fn decode_account_id_hex(account_id_hex: &str) -> Result<Vec<u8>, String> {
    let bytes = decode_prefixed_hex(account_id_hex)?;
    if bytes.len() != 32 {
        return Err(format!(
            "account_id_hex must decode to 32 bytes, got {}",
            bytes.len()
        ));
    }
    Ok(bytes)
}

fn build_system_account_storage_key(account_id: &[u8]) -> String {
    let mut key = hex::decode(SYSTEM_ACCOUNT_PREFIX_HEX).unwrap_or_default();
    let blake2 = blake2_rfc::blake2b::blake2b(16, &[], account_id);
    key.extend_from_slice(blake2.as_bytes());
    key.extend_from_slice(account_id);
    format!("0x{}", hex::encode(key))
}

fn decode_prefixed_hex(value: &str) -> Result<Vec<u8>, String> {
    let clean = value.strip_prefix("0x").unwrap_or(value);
    hex::decode(clean).map_err(|error| format!("Invalid hex string: {error}"))
}

fn read_u128_le_string(bytes: &[u8], offset: usize) -> Result<String, String> {
    let slice = bytes
        .get(offset..offset + 16)
        .ok_or_else(|| "u128 slice out of bounds".to_string())?;
    let mut value = 0u128;
    for (index, byte) in slice.iter().enumerate() {
        value |= (*byte as u128) << (index * 8);
    }
    Ok(value.to_string())
}

fn json_storage_value_response_from_bytes(
    storage_key_hex: &str,
    storage_value: Option<Vec<u8>>,
) -> Value {
    match storage_value {
        Some(value_bytes) => json!({
            "storageKey": storage_key_hex,
            "exists": true,
            "valueHex": format!("0x{}", hex::encode(value_bytes)),
        }),
        None => json!({
            "storageKey": storage_key_hex,
            "exists": false,
        }),
    }
}

// ──── 测试模块统一置于文件末尾:clippy items_after_test_module 要求
// 真实条目不得排在 #[cfg(test)] 模块之后,否则易被误读成"测试之后没有代码"。
#[cfg(test)]
mod resource_constraint_tests {
    use super::{
        configured_log_level, NativeCapabilityExecutor, NATIVE_CAPABILITY_QUEUE_CAPACITY,
        NATIVE_CAPABILITY_WORKERS,
    };
    use std::sync::{Arc, Barrier};

    #[test]
    fn native_capability_executor_has_fixed_workers_and_bounded_queue() {
        let executor = NativeCapabilityExecutor::new().expect("executor starts");
        let started = Arc::new(Barrier::new(NATIVE_CAPABILITY_WORKERS + 1));
        let release = Arc::new(Barrier::new(NATIVE_CAPABILITY_WORKERS + 1));

        for _ in 0..NATIVE_CAPABILITY_WORKERS {
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            executor
                .try_spawn(Box::new(move || {
                    started.wait();
                    release.wait();
                }))
                .expect("worker blocker enqueued");
        }
        started.wait();

        for _ in 0..NATIVE_CAPABILITY_QUEUE_CAPACITY {
            executor
                .try_spawn(Box::new(|| {}))
                .expect("bounded queue slot available");
        }
        let error = executor
            .try_spawn(Box::new(|| {}))
            .expect_err("queue over capacity must fail");
        assert_eq!(error, "native_capability_queue_full");

        release.wait();
    }

    #[test]
    fn configured_log_level_matches_dart_contract() {
        assert_eq!(configured_log_level(0), log::LevelFilter::Off);
        assert_eq!(configured_log_level(1), log::LevelFilter::Error);
        assert_eq!(configured_log_level(2), log::LevelFilter::Warn);
        assert_eq!(configured_log_level(3), log::LevelFilter::Info);
        assert_eq!(configured_log_level(4), log::LevelFilter::Debug);
        assert_eq!(configured_log_level(5), log::LevelFilter::Trace);
    }
}
