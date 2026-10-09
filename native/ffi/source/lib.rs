//! Stable CitizenSDK product C ABI.
//!
//! Only `citizensdk_*` symbols are exported. All chain work crosses the typed
//! `CitizenEngine`; arbitrary JSON-RPC, private keys, child mini-secrets and
//! standalone signed wallet extrinsics are never public. Mnemonic bytes cross
//! only the explicit import/add-account or prepared-backup functions, while
//! host vault callbacks can handle only random DEKs and never account secrets.

// Raw pointer validation and symbol export are confined to this audited crate;
// contracts, Engine and providers continue to forbid unsafe code.
#![allow(unsafe_code)]

#[cfg(feature = "chain")]
use std::cell::Cell;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
};

use citizen_sdk_contracts::{
    BlockFinality, ChainIdentity, ExecutionConclusion, ExportedChainState, ExtrinsicWatchEvent,
    Hash32, Modules, SignedExtrinsic, UnverifiedReason, VerifiedBlockRef,
    MAX_RUNTIME_API_ARGUMENT_BYTES, MAX_RUNTIME_API_METHOD_BYTES, MAX_STORAGE_BATCH_KEY_BYTES,
    MAX_STORAGE_KEYS_PAGE_LIMIT, MAX_STORAGE_KEY_BYTES,
};
use futures_util::{FutureExt, StreamExt};

mod abi;
mod assets;
mod capabilities;
#[cfg(feature = "chain")]
mod chain_monitor;
#[cfg(all(test, feature = "chain"))]
mod chain_monitor_tests;
mod composition;
#[cfg(test)]
mod composition_tests;
mod error;
mod events;
mod handles;
mod host_codec;
#[cfg(test)]
mod host_codec_tests;
mod host_providers;
mod ownership;
mod qr_abi;
mod requests;
mod runtime;
mod transaction_abi;
mod wallet_abi;

pub use abi::*;
#[doc(hidden)]
pub use host_providers::{
    citizensdk_set_secret_presence_provider, citizensdk_encrypted_secret_record_has_secret,
    decode_host_error_code, empty_bytes_view, settle_host_dispatch, validate_bool_result_v1,
    validate_bytes_result_v1, validate_host_bytes_result, validate_host_record_result,
    validate_host_services_presence, validate_host_status_result, validate_mutable_dek_view,
    validate_public_store_v1, validate_record_result_v1, validate_secret_vault_v1,
    validate_secure_store_v1, validate_status_result_v1, validate_vault_availability_result_v1,
    HostCompletionKind, HostDispatchOutcome, HostOperationTracker,
};
pub use qr_abi::*;
pub use wallet_abi::{citizensdk_encode_signing_payload, CitizenSdkPrivateKeyReceiverV1};

use error::{clear_last_error, last_error, set_last_error, FfiError, FfiResult};
use ownership::ResultPayload;
use runtime::NativeRuntime;

const MAX_ABI_INPUT_BYTES: usize = 16 * 1024 * 1024;

/// Android JNI 创建链实例前初始化系统证书验证器；失败封闭，不允许退回弱化验证。
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn citizensdk_android_init_tls(
    raw_env: *mut std::ffi::c_void,
    raw_context: *mut std::ffi::c_void,
) -> i32 {
    ffi_status(|| {
        if raw_env.is_null() || raw_context.is_null() {
            return Err(FfiError::new(
                CitizenSdkErrorCode::InvalidArgument,
                "Android TLS verifier requires JNI environment and Context",
            ));
        }
        // JNI 栈帧与 Context 局部引用只借用于此调用；库内部保存自己的全局引用。
        let mut env = unsafe { jni::EnvUnowned::from_raw(raw_env.cast()) };
        let outcome = env.with_env(|env| {
            let context = unsafe { jni::objects::JObject::from_raw(env, raw_context.cast()) };
            rustls_platform_verifier::android::init_with_env(env, context)
        });
        match outcome.into_outcome() {
            jni::Outcome::Ok(()) => Ok(()),
            jni::Outcome::Err(_) | jni::Outcome::Panic(_) => Err(FfiError::new(
                CitizenSdkErrorCode::Unavailable,
                "Android TLS verifier initialization failed",
            )),
        }
    })
}

/// 启动诊断只保留固定步骤，不读取 panic 内容、宿主数据或链状态。
#[cfg(feature = "chain")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartStep {
    Restore,
    Begin,
    PublishBegin,
    ProviderStart,
    Refresh,
    Complete,
    Services,
    PublishComplete,
}

#[cfg(feature = "chain")]
impl StartStep {
    const fn token(self) -> &'static str {
        match self {
            Self::Restore => "RESTORE",
            Self::Begin => "BEGIN",
            Self::PublishBegin => "PUBLISH_BEGIN",
            Self::ProviderStart => "PROVIDER_START",
            Self::Refresh => "REFRESH",
            Self::Complete => "COMPLETE",
            Self::Services => "SERVICES",
            Self::PublishComplete => "PUBLISH_COMPLETE",
        }
    }
}

/// 在原有异步请求 worker 的隔离之内记录最近一步；普通错误原样返回。
#[cfg(feature = "chain")]
fn diagnose_start<T>(
    step: &Cell<StartStep>,
    converge_panic: impl FnOnce(),
    operation: impl FnOnce() -> FfiResult<T>,
) -> FfiResult<T> {
    catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| {
        // provider 已可能产生副作用；先单向收敛，再把固定阶段送出 JNI。
        let _ = catch_unwind(AssertUnwindSafe(converge_panic));
        Err(FfiError::new(
            CitizenSdkErrorCode::Panic,
            format!("CitizenSDK start panicked at {}", step.get().token()),
        ))
    })
}

/// 平台通道在方法参数解码前接纳准确序号；无业务、设备或网络副作用。
#[no_mangle]
pub extern "C" fn citizensdk_accept_request_sequence(handle: CitizenSdkHandle, request_sequence: u64) -> i32 {
    ffi_status(|| handles::get(handle)?.accept_request_sequence(request_sequence))
}

/// Execute the startup prefix with one frozen host/legacy ordering policy.
/// Host restore failure is terminal for this request and is published by the
/// supplied convergence hook before `begin` or provider start can run.
fn run_start_lifecycle_policy<E>(
    uses_host_services: bool,
    restore: impl FnOnce() -> Result<(), E>,
    converge_restore_failure: impl FnOnce(),
    begin: impl FnOnce() -> Result<(), E>,
    publish_begin: impl FnOnce() -> Result<(), E>,
    provider_start: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    if uses_host_services {
        if let Err(error) = restore() {
            converge_restore_failure();
            return Err(error);
        }
    }
    begin()?;
    publish_begin()?;
    provider_start()
}

/// Select the persistent export only for a runtime composed with host stores.
/// Both closures are lazy so the non-selected path has no provider/store side
/// effects and the legacy product contract remains byte-for-byte callable.
fn select_state_export<T, E>(
    uses_host_services: bool,
    legacy_export: impl FnOnce() -> Result<T, E>,
    persistent_export: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    if uses_host_services {
        persistent_export()
    } else {
        legacy_export()
    }
}

/// Execute graceful stop in dependency order. For host compositions the
/// durable export is the first operation and any failure short-circuits every
/// unsubscribe/service/provider side effect. Legacy compositions skip exactly
/// that first operation and preserve the original stop sequence.
fn run_stop_lifecycle_policy<E>(
    uses_host_services: bool,
    persist: impl FnOnce() -> Result<(), E>,
    unsubscribe: impl FnOnce() -> Result<(), E>,
    stop_products: impl FnOnce() -> Result<(), E>,
    stop_provider: impl FnOnce() -> Result<(), E>,
    mark_stopped: impl FnOnce() -> Result<(), E>,
) -> Result<(), E> {
    if uses_host_services {
        persist()?;
    }
    unsubscribe()?;
    stop_products()?;
    stop_provider()?;
    mark_stopped()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LifecycleAdmissionPolicy {
    Shared,
    Exclusive,
}

/// Host-composed instances make lifecycle/store mutation exclusive. Legacy
/// `citizensdk_create` instances deliberately retain the established shared
/// async admission contract until that constructor adopts host composition.
const fn lifecycle_admission_policy(uses_host_services: bool) -> LifecycleAdmissionPolicy {
    if uses_host_services {
        LifecycleAdmissionPolicy::Exclusive
    } else {
        LifecycleAdmissionPolicy::Shared
    }
}

#[no_mangle]
pub extern "C" fn citizensdk_abi_version() -> u32 {
    CITIZENSDK_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn citizensdk_create_options_size() -> u32 {
    std::mem::size_of::<CitizenSdkCreateOptions>() as u32
}

#[no_mangle]
/// Creates one SDK instance from verified packaged assets.
///
/// # Safety
/// `options` must point to a readable, versioned structure; every non-empty
/// byte view in it must remain readable for the duration of this call.
/// `out_handle` must be writable for one `CitizenSdkHandle`.
pub unsafe extern "C" fn citizensdk_create(
    options: *const CitizenSdkCreateOptions,
    out_handle: *mut CitizenSdkHandle,
) -> i32 {
    ffi_status(|| {
        let options = read_versioned(options, "create options")?;
        let modules = composition::validate_modules(Modules::CHAIN | Modules::TRANSACTIONS)?;
        create_instance(&options, None, modules, out_handle)
    })
}

/// 模块校验是无状态操作，平台必须在读取链资产或创建安全资源之前调用。
#[no_mangle]
pub extern "C" fn citizensdk_validate_modules(modules: u32) -> i32 {
    ffi_status(|| composition::validate_modules(modules).map(|_| ()))
}

/// 按固定模块集合创建实例；完整使用与按模块使用共用唯一装配实现。
///
/// # Safety
/// Options and every supplied host vtable must be readable; output must be
/// writable. Copied host callbacks must live through successful destruction.
#[no_mangle]
pub unsafe extern "C" fn citizensdk_create_with_modules(
    options: *const CitizenSdkCreateOptions,
    host_services: *const CitizenSdkHostServicesV1,
    modules: u32,
    out_handle: *mut CitizenSdkHandle,
) -> i32 {
    ffi_status(|| {
        let modules = composition::validate_modules(modules)?;
        require_output(out_handle, "out_handle")?;
        let options = read_versioned(options, "create options")?;
        let services = if host_services.is_null() {
            None
        } else {
            Some(read_versioned(host_services, "host services")?)
        };
        create_instance(&options, services.as_ref(), modules, out_handle)
    })
}

/// 构造阶段仅复制和校验输入，不调用需要主线程完成的金库或存储回调。
unsafe fn create_instance(
    options: &CitizenSdkCreateOptions,
    services: Option<&CitizenSdkHostServicesV1>,
    modules: Modules,
    out_handle: *mut CitizenSdkHandle,
) -> FfiResult<()> {
    require_output(out_handle, "out_handle")?;
    composition::validate_modules(modules.bits())?;
    let combined_chain_spec = if modules.contains(Modules::CHAIN) {
        let manifest = copy_view(
            options.asset_manifest,
            "asset_manifest",
            MAX_ABI_INPUT_BYTES,
        )?;
        let chain_spec = copy_view(options.chain_spec, "chain_spec", MAX_ABI_INPUT_BYTES)?;
        let light_state = copy_view(
            options.light_sync_state,
            "light_sync_state",
            MAX_ABI_INPUT_BYTES,
        )?;
        Some(assets::verify_assets(&manifest, &chain_spec, &light_state)?.combined_chain_spec)
    } else {
        for view in [
            options.asset_manifest,
            options.chain_spec,
            options.light_sync_state,
        ] {
            if view.len != 0 {
                return Err(FfiError::invalid(
                    "chain assets must be empty when chain is disabled",
                ));
            }
        }
        None
    };
    let system_name = optional_utf8(options.system_name, "system_name", "CitizenSDK")?;
    let system_version = optional_utf8(options.system_version, "system_version", "1.0.0")?;
    let handle = handles::reserve_handle()?;
    let runtime = NativeRuntime::new_with_modules(
        handle,
        combined_chain_spec,
        system_name,
        system_version,
        services,
        modules,
    )?;
    handles::insert(runtime)?;
    ptr::write(out_handle, handle);
    Ok(())
}

/// 纯验签复用既有 sr25519 实现，无实例、金库或链资源，也不开放原始签名密钥。
///
/// # Safety
/// Account and byte views must be readable; out_valid must be writable.
#[no_mangle]
pub unsafe extern "C" fn citizensdk_verify_signature(
    account_id: *const CitizenSdkAccountId,
    signature: CitizenSdkBytesView,
    message: CitizenSdkBytesView,
    out_valid: *mut u8,
) -> i32 {
    ffi_status(|| {
        require_output(out_valid, "out_valid")?;
        #[cfg(not(feature = "signing"))]
        {
            let _ = (account_id, signature, message);
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "signing is not compiled into this build",
            ))
        }
        #[cfg(feature = "signing")]
        {
            use citizen_sdk_contracts::{ChainSigner, Sr25519PublicKey, Sr25519Signature};
            if account_id.is_null() {
                return Err(FfiError::invalid("account_id is null"));
            }
            let public_key = Sr25519PublicKey::from_bytes(ptr::read(account_id).bytes);
            let signature: [u8; 64] = copy_view(signature, "signature", 64)?
                .try_into()
                .map_err(|_| FfiError::invalid("signature must be exactly 64 bytes"))?;
            let message = copy_view(message, "message", MAX_ABI_INPUT_BYTES)?;
            let valid = futures_executor::block_on(citizen_signer::Sr25519SoftwareSigner.verify(
                public_key,
                message,
                Sr25519Signature::from_bytes(signature),
            ))?;
            ptr::write(out_valid, u8::from(valid));
            Ok(())
        }
    })
}

#[no_mangle]
/// Destroys an instance after its requests and results have been drained.
///
/// # Safety
/// `handle` must be a value returned by this library and must not be
/// concurrently destroyed by another host thread.
pub unsafe extern "C" fn citizensdk_destroy(handle: CitizenSdkHandle) -> i32 {
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.shutdown()?;
        // Shutdown has already rejected every outstanding request/result and
        // joined callbacks. Only after that commit point may teardown discard
        // uncommitted recovery-phrase sessions owned by this instance.
        wallet_abi::drop_prepared_for_owner(handle);
        transaction_abi::drop_prepared_for_owner(handle);
        #[cfg(feature = "qr")]
        qr_abi::drop_sessions_for_owner(handle);
        handles::remove(handle, &runtime)
    })
}

#[no_mangle]
/// Installs, replaces, or clears the per-instance event callback.
///
/// # Safety
/// A non-null callback must not unwind across the C boundary. Its `context`
/// must remain valid until callback replacement/clear returns successfully.
pub unsafe extern "C" fn citizensdk_set_event_callback(
    handle: CitizenSdkHandle,
    callback: CitizenSdkEventCallback,
    context: *mut std::ffi::c_void,
) -> i32 {
    ffi_status(|| handles::get(handle)?.set_event_callback(callback, context))
}

#[no_mangle]
/// Copies the current ten-capability snapshot to host memory.
///
/// # Safety
/// `out_snapshot` must be writable and must initially contain the documented
/// `struct_size` and `abi_version` values.
pub unsafe extern "C" fn citizensdk_get_capabilities(
    handle: CitizenSdkHandle,
    out_snapshot: *mut CitizenSdkCapabilitySnapshot,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_snapshot, "capability snapshot")?;
        let runtime = handles::get(handle)?;
        let snapshot = capabilities::snapshot_to_abi(&runtime.capability_snapshot()?);
        ptr::write(out_snapshot, snapshot);
        Ok(())
    })
}

#[no_mangle]
/// Copies the current Engine lifecycle discriminant to host memory.
///
/// # Safety
/// `out_lifecycle` must be writable for one `u32`.
pub unsafe extern "C" fn citizensdk_get_lifecycle(
    handle: CitizenSdkHandle,
    out_lifecycle: *mut u32,
) -> i32 {
    ffi_status(|| {
        require_output(out_lifecycle, "out_lifecycle")?;
        let lifecycle = handles::get(handle)?.engine().lifecycle()?;
        ptr::write(
            out_lifecycle,
            capabilities::lifecycle_to_abi(lifecycle) as u32,
        );
        Ok(())
    })
}

#[no_mangle]
/// Starts provider-driven capability change monitoring.
///
/// # Safety
/// `handle` must be live, and the callback/context previously registered for
/// it must remain valid until unsubscription succeeds.
pub unsafe extern "C" fn citizensdk_subscribe_capability_changes(handle: CitizenSdkHandle) -> i32 {
    ffi_status(|| handles::get(handle)?.subscribe_capability_changes())
}

#[no_mangle]
/// Stops capability change monitoring and joins its monitor thread.
///
/// # Safety
/// `handle` must be live and must not be concurrently destroyed. A call from
/// the instance callback is safely rejected with `BUSY`.
pub unsafe extern "C" fn citizensdk_unsubscribe_capability_changes(
    handle: CitizenSdkHandle,
) -> i32 {
    ffi_status(|| handles::get(handle)?.stop_capability_subscription())
}

#[no_mangle]
/// Accepts asynchronous provider/Engine startup.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier. The
/// registered callback/context must remain valid through completion.
pub unsafe extern "C" fn citizensdk_start(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            accept_and_write_lifecycle(runtime, out_request_id, |runtime, _, _| {
                let step = Cell::new(if runtime.uses_host_services() {
                    StartStep::Restore
                } else {
                    StartStep::Begin
                });
                diagnose_start(&step, || runtime.converge_failed_start(), || {
                    // Host-composed instances own a typed public chain-database store.
                    // Restore it before `begin_provider_start` and, critically, before
                    // the provider's start operation can have any side effect. Legacy
                    // `citizensdk_create` instances retain their original startup path.
                    run_start_lifecycle_policy(
                        runtime.uses_host_services(),
                        || -> FfiResult<()> {
                            step.set(StartStep::Restore);
                            match runtime.drive(runtime.engine().restore_state_from_store()) {
                                Ok(Ok(_)) => Ok(()),
                                Ok(Err(error)) => Err(error.into()),
                                Err(error) => Err(error),
                            }
                        },
                        // A provider import followed by failed CAS is already one-way
                        // StartFailed; a pre-provider validation error remains Created.
                        // Publish either exact lifecycle without replacing its cause.
                        || runtime.converge_failed_start(),
                        || {
                            step.set(StartStep::Begin);
                            runtime
                                .engine()
                                .begin_provider_start()
                                .map_err(FfiError::from)
                        },
                        || {
                            step.set(StartStep::PublishBegin);
                            runtime.publish_capabilities()?;
                            runtime.publish_lifecycle()
                        },
                        || -> FfiResult<()> {
                            step.set(StartStep::ProviderStart);
                            match runtime.provider()?.drive(runtime.provider()?.start()) {
                                Ok(Ok(())) => Ok(()),
                                Ok(Err(error)) | Err(error) => {
                                    runtime.converge_failed_start();
                                    Err(error.into())
                                }
                            }
                        },
                    )?;

                    // Status refresh is part of startup validation. Once provider
                    // start has had side effects, every later failure converges to a
                    // stopped provider and one-way Engine StartFailed state.
                    step.set(StartStep::Refresh);
                    if let Err(error) = runtime.refresh_provider_capabilities() {
                        runtime.converge_failed_start();
                        return Err(error);
                    }

                    step.set(StartStep::Complete);
                    match runtime.drive(runtime.engine().complete_provider_start()) {
                        Ok(Ok(_)) => {}
                        Ok(Err(error)) => {
                            runtime.converge_failed_start();
                            return Err(error.into());
                        }
                        Err(error) => {
                            runtime.converge_failed_start();
                            return Err(error);
                        }
                    }

                    // `complete_provider_start` applies the already sampled provider
                    // readiness through the Engine lifecycle gate.
                    step.set(StartStep::Services);
                    if let Err(error) = runtime.start_product_services() {
                        runtime.converge_failed_start();
                        return Err(error);
                    }
                    step.set(StartStep::PublishComplete);
                    if let Err(error) = runtime
                        .publish_capabilities()
                        .and_then(|_| runtime.publish_lifecycle())
                    {
                        // 自有 monitor 已启动；末尾事件入队失败也必须排空，不能留后台孤儿。
                        runtime.converge_failed_start();
                        return Err(error);
                    }
                    Ok(ResultPayload::Empty)
                })
            })
        })
    }
}

#[no_mangle]
/// Accepts asynchronous provider/Engine shutdown.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier. The
/// registered callback/context must remain valid through completion.
pub unsafe extern "C" fn citizensdk_stop(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            accept_and_write_lifecycle(runtime, out_request_id, |runtime, request_id, _| {
                // A host-composed graceful stop persists one exact exported
                // snapshot while every provider/service dependency is still live.
                // Direct destroy is intentionally not a graceful persistence API.
                run_stop_lifecycle_policy(
                    runtime.uses_host_services(),
                    || -> FfiResult<()> {
                        runtime
                            .drive(runtime.engine().export_and_persist_state())?
                            .map(|_| ())
                            .map_err(FfiError::from)
                    },
                    || {
                        if runtime.uses_host_services() {
                            runtime.stop_capability_subscription_for_exclusive_request(request_id)
                        } else {
                            runtime.stop_capability_subscription()
                        }
                    },
                    // 任何已组合的产品 history/background 服务必须先 stop + drain；
                    // provider 是依赖图中最后停止的一层。
                    || runtime.stop_product_services(),
                    || runtime.provider()?.stop().map_err(FfiError::from),
                    || {
                        runtime
                            .engine()
                            .mark_provider_stopped()
                            .map_err(FfiError::from)
                    },
                )?;
                runtime.publish_capabilities()?;
                runtime.publish_lifecycle()?;
                Ok(ResultPayload::Empty)
            })
        })
    }
}

#[no_mangle]
/// Requests cancellation of a pending cancellable operation.
///
/// # Safety
/// `handle` and `request_id` must originate from this library and must not be
/// used concurrently with destruction of the owning instance.
pub unsafe extern "C" fn citizensdk_cancel_request(
    handle: CitizenSdkHandle,
    request_id: CitizenSdkRequestId,
) -> i32 {
    ffi_status(|| handles::get(handle)?.request_cancel(request_id))
}

#[no_mangle]
/// Accepts an asynchronous provider readiness refresh.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier. The
/// registered callback/context must remain valid through completion.
pub unsafe extern "C" fn citizensdk_refresh_capabilities(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        accept_and_write(runtime, out_request_id, |runtime, _, _| {
            let _ = runtime.refresh_provider_capabilities()?;
            Ok(ResultPayload::Empty)
        })
    })
}

#[no_mangle]
/// Accepts an asynchronous verified best-head query.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier. The
/// registered callback/context must remain valid through completion.
pub unsafe extern "C" fn citizensdk_get_best_head(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            accept_and_write(runtime, out_request_id, |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let block = runtime.drive(runtime.engine().best_head())??;
                Ok(ResultPayload::Block(block))
            })
        })
    }
}

#[no_mangle]
/// Accepts an asynchronous verified finalized-head query.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier. The
/// registered callback/context must remain valid through completion.
pub unsafe extern "C" fn citizensdk_get_finalized_head(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            accept_and_write(runtime, out_request_id, |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let block = runtime.drive(runtime.engine().finalized_head())??;
                Ok(ResultPayload::Block(block.into()))
            })
        })
    }
}

#[no_mangle]
/// Accepts one coherent typed light-node synchronization snapshot.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier.
pub unsafe extern "C" fn citizensdk_get_sync_status(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        accept_and_write(runtime, out_request_id, |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let status = runtime.drive(runtime.engine().chain_sync_status())??;
            Ok(ResultPayload::ChainSyncStatus(status))
        })
    })
}

#[no_mangle]
/// Resolves one height through the verified finalized canonical ancestry.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier.
pub unsafe extern "C" fn citizensdk_get_finalized_block_at(
    handle: CitizenSdkHandle,
    number: u64,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let block = runtime.drive(runtime.engine().finalized_block_at(number))??;
            Ok(ResultPayload::Block(block.into()))
        })
    })
}

#[no_mangle]
/// Verifies one caller-supplied hash/height as a finalized canonical block.
///
/// # Safety
/// `hash_32` must be readable for 32 bytes and `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_resolve_finalized_block(
    handle: CitizenSdkHandle,
    hash_32: *const u8,
    number: u64,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        let hash = Hash32::from_bytes(copy_fixed_32(hash_32, "block hash")?);
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let block = runtime.drive(runtime.engine().resolve_finalized_block(hash, number))??;
            Ok(ResultPayload::Block(block.into()))
        })
    })
}

#[no_mangle]
/// Reads a hash-bound header for one exact verified block.
///
/// # Safety
/// `block` must be readable and versioned; `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_get_block_header_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        let block = block_from_abi(read_versioned(block, "block")?)?;
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let header = runtime.drive(runtime.engine().block_header_at(block))??;
            Ok(ResultPayload::BlockHeader(header))
        })
    })
}

#[no_mangle]
/// Reads ordered opaque extrinsics for one exact verified block.
///
/// # Safety
/// `block` must be readable and versioned; `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_get_block_body_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        let block = block_from_abi(read_versioned(block, "block")?)?;
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let body = runtime.drive(runtime.engine().block_body_at(block))??;
            Ok(ResultPayload::BlockBody(body))
        })
    })
}

#[no_mangle]
/// Reads raw `System.Events` bytes at one exact finalized block.
///
/// # Safety
/// `block` must be readable and versioned; `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_get_system_events_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        let block = block_from_abi(read_versioned(block, "block")?)?
            .require_finalized()
            .map_err(FfiError::from)?;
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let events = runtime.drive(runtime.engine().finalized_system_events_at(block))??;
            Ok(ResultPayload::Storage(events))
        })
    })
}

#[no_mangle]
/// Accepts an exact-block verified storage query.
///
/// # Safety
/// `block` must point to a readable versioned block reference, `key` must be
/// readable for its declared length, and `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_get_storage_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    key: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let block = block_from_abi(read_versioned(block, "block")?)?;
            let key = copy_view(key, "storage key", MAX_STORAGE_KEY_BYTES)?;
            if key.is_empty() {
                return Err(FfiError::invalid("storage key must not be empty"));
            }
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let value = runtime.drive(runtime.engine().storage_at(block, key))??;
                Ok(ResultPayload::Storage(value))
            })
        })
    }
}

#[no_mangle]
/// Accepts a bounded exact-block verified storage batch query.
///
/// # Safety
/// `block` and `keys[0..key_count]` must be readable; every key view must be
/// readable for its declared length; `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_get_storage_batch_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    keys: *const CitizenSdkBytesView,
    key_count: u32,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let block = block_from_abi(read_versioned(block, "block")?)?;
            if key_count == 0 || key_count > 1024 || keys.is_null() {
                return Err(FfiError::invalid(
                    "storage batch must contain between 1 and 1024 keys",
                ));
            }
            let views = std::slice::from_raw_parts(keys, key_count as usize);
            let mut copied = Vec::with_capacity(views.len());
            let mut total = 0_usize;
            for (index, view) in views.iter().copied().enumerate() {
                let key = copy_view(view, &format!("storage key {index}"), MAX_STORAGE_KEY_BYTES)?;
                if key.is_empty() {
                    return Err(FfiError::invalid("storage keys must not be empty"));
                }
                total = total
                    .checked_add(key.len())
                    .ok_or_else(|| FfiError::invalid("storage batch is too large"))?;
                if total > MAX_STORAGE_BATCH_KEY_BYTES {
                    return Err(FfiError::invalid("storage batch is too large"));
                }
                copied.push(key);
            }
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let values = runtime.drive(runtime.engine().storage_batch_at(block, copied))??;
                Ok(ResultPayload::StorageBatch(values))
            })
        })
    }
}

#[no_mangle]
/// Reads one bounded page of opaque storage keys at an exact finalized block.
///
/// # Safety
/// `block`, prefix/start views and `out_request_id` must satisfy their ordinary ABI contracts.
pub unsafe extern "C" fn citizensdk_get_storage_keys_paged(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    prefix: CitizenSdkBytesView,
    has_start_key: u8,
    start_key: CitizenSdkBytesView,
    limit: u32,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        let block = block_from_abi(read_versioned(block, "block")?)?
            .require_finalized()
            .map_err(FfiError::from)?;
        let prefix = copy_view(prefix, "storage key prefix", MAX_STORAGE_KEY_BYTES)?;
        if prefix.is_empty() || limit == 0 || limit > MAX_STORAGE_KEYS_PAGE_LIMIT {
            return Err(FfiError::invalid(
                "storage keys page requires a non-empty prefix and limit 1..1000",
            ));
        }
        let start_key = match has_start_key {
            0 => {
                if start_key.len != 0 {
                    return Err(FfiError::invalid(
                        "absent storage start key must have zero length",
                    ));
                }
                None
            }
            1 => {
                let value = copy_view(start_key, "storage start key", MAX_STORAGE_KEY_BYTES)?;
                if value.is_empty() {
                    return Err(FfiError::invalid("storage start key must not be empty"));
                }
                Some(value)
            }
            _ => return Err(FfiError::invalid("has_start_key must be 0 or 1")),
        };
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let keys = runtime.drive(
                runtime
                    .engine()
                    .storage_keys_paged(block, prefix, start_key, limit),
            )??;
            Ok(ResultPayload::StorageBatch(
                keys.into_iter().map(Some).collect(),
            ))
        })
    })
}

#[no_mangle]
/// Executes one bounded opaque Runtime API call at an exact verified block.
///
/// # Safety
/// All pointers/views must satisfy their ordinary ABI contracts.
pub unsafe extern "C" fn citizensdk_call_runtime_api(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    method: CitizenSdkBytesView,
    arguments: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    return ffi_status(|| {
        Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            "chain is not compiled into this build",
        ))
    });
    #[cfg(feature = "chain")]
    ffi_status(|| {
        let runtime = handles::get(handle)?;
        runtime.provider()?;
        let block = block_from_abi(read_versioned(block, "block")?)?;
        let method = String::from_utf8(copy_view(
            method,
            "runtime API method",
            MAX_RUNTIME_API_METHOD_BYTES,
        )?)
        .map_err(|_| FfiError::invalid("runtime API method must be UTF-8"))?;
        let arguments = copy_view(
            arguments,
            "runtime API arguments",
            MAX_RUNTIME_API_ARGUMENT_BYTES,
        )?;
        accept_and_write(runtime, out_request_id, move |runtime, _, _| {
            runtime.refresh_provider_capabilities()?;
            let output =
                runtime.drive(runtime.engine().call_runtime_api(block, method, arguments))??;
            Ok(ResultPayload::Storage(Some(output)))
        })
    })
}

#[no_mangle]
/// Accepts an exact-block runtime-version and metadata query.
///
/// # Safety
/// `block` must point to a readable versioned block reference and
/// `out_request_id` must be writable for one request identifier.
pub unsafe extern "C" fn citizensdk_get_runtime_context_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let block = block_from_abi(read_versioned(block, "block")?)?;
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let context = runtime.drive(runtime.engine().runtime_context_at(block))??;
                Ok(ResultPayload::RuntimeContext(context))
            })
        })
    }
}

#[no_mangle]
/// Accepts submission of an already signed extrinsic.
///
/// # Safety
/// `extrinsic` must be readable for its declared length and
/// `out_request_id` must be writable for one request identifier.
pub unsafe extern "C" fn citizensdk_submit_extrinsic(
    handle: CitizenSdkHandle,
    extrinsic: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let extrinsic = signed_extrinsic(extrinsic)?;
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let submitted =
                    runtime.drive(runtime.engine().submit_signed_extrinsic(extrinsic))??;
                Ok(ResultPayload::Hash(submitted.hash()))
            })
        })
    }
}

#[no_mangle]
/// Accepts watching of an already signed extrinsic.
///
/// # Safety
/// `extrinsic` must be readable for its declared length, `out_request_id`
/// must be writable, and callback/context must remain valid through terminal
/// completion or cancellation.
pub unsafe extern "C" fn citizensdk_watch_extrinsic(
    handle: CitizenSdkHandle,
    extrinsic: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let extrinsic = signed_extrinsic(extrinsic)?;
            accept_and_write_watch(
                runtime,
                out_request_id,
                move |runtime, request_id, cancellation| {
                    runtime.refresh_provider_capabilities()?;
                    let mut stream = runtime.engine().watch_signed_extrinsic(extrinsic)?;
                    futures_executor::block_on(async {
                        let cancellation = cancellation
                            .ok_or_else(|| {
                                FfiError::internal("watch cancellation channel is missing")
                            })?
                            .fuse();
                        futures_util::pin_mut!(cancellation);
                        loop {
                            futures_util::select! {
                                event = stream.next().fuse() => match event {
                                    Some(Ok(event)) => {
                                        let terminal = watch_is_terminal(&event);
                                        runtime.publish_watch_update(request_id, event)?;
                                        if terminal {
                                            return Ok(ResultPayload::Empty);
                                        }
                                    }
                                    Some(Err(error)) => return Err(error.into()),
                                    None => return Err(FfiError::new(
                                        CitizenSdkErrorCode::Unavailable,
                                        "extrinsic watch ended without a terminal event",
                                    )),
                                },
                                _ = cancellation => return Err(FfiError::new(
                                    CitizenSdkErrorCode::Cancelled,
                                    "extrinsic watch was cancelled",
                                )),
                            }
                        }
                    })
                },
            )
        })
    }
}

#[no_mangle]
/// Accepts proof-oriented execution outcome verification at an exact block.
///
/// # Safety
/// `block`, `extrinsic`, and exactly 32 bytes at `submitted_hash` must be
/// readable; `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_verify_transaction_at(
    handle: CitizenSdkHandle,
    block: *const CitizenSdkBlockRef,
    extrinsic: CitizenSdkBytesView,
    submitted_hash: *const u8,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let block = block_from_abi(read_versioned(block, "block")?)?;
            let extrinsic = signed_extrinsic(extrinsic)?;
            let submitted_hash = copy_fixed_32(submitted_hash, "submitted_hash")?;
            accept_and_write(runtime, out_request_id, move |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let conclusion = runtime.drive(runtime.engine().verify_transaction_at(
                    block,
                    extrinsic,
                    Hash32::from_bytes(submitted_hash),
                ))??;
                Ok(ResultPayload::Execution(conclusion))
            })
        })
    }
}

#[no_mangle]
/// Accepts export of provider state anchored to verified finality.
///
/// # Safety
/// `out_request_id` must be writable for one request identifier. The
/// registered callback/context must remain valid through completion.
pub unsafe extern "C" fn citizensdk_export_state(
    handle: CitizenSdkHandle,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            accept_and_write(runtime, out_request_id, |runtime, _, _| {
                runtime.refresh_provider_capabilities()?;
                let state = select_state_export(
                    runtime.uses_host_services(),
                    || runtime.drive(runtime.engine().export_state()),
                    || runtime.drive(runtime.engine().export_and_persist_state()),
                )??;
                Ok(ResultPayload::ExportedState(state))
            })
        })
    }
}

#[no_mangle]
/// Accepts a pre-start import of a bounded chain database snapshot.
///
/// # Safety
/// `finalized` must point to a readable versioned finalized reference,
/// `database` must be readable for its declared length, and
/// `out_request_id` must be writable.
pub unsafe extern "C" fn citizensdk_import_state(
    handle: CitizenSdkHandle,
    finalized: *const CitizenSdkBlockRef,
    format_version: u32,
    database: CitizenSdkBytesView,
    out_request_id: *mut CitizenSdkRequestId,
) -> i32 {
    #[cfg(not(feature = "chain"))]
    {
        ffi_status(|| {
            Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "chain is not compiled into this build",
            ))
        })
    }
    #[cfg(feature = "chain")]
    {
        ffi_status(|| {
            let runtime = handles::get(handle)?;
            runtime.provider()?;
            let finalized = block_from_abi(read_versioned(finalized, "finalized block")?)?
                .require_finalized()?;
            let database = copy_view(database, "chain database", 256 * 1024)?;
            let state = ExportedChainState::try_new(
                ChainIdentity::citizenchain(),
                format_version,
                finalized,
                database,
            )?;
            accept_and_write_lifecycle(runtime, out_request_id, move |runtime, _, _| {
                let receipt = runtime.drive(runtime.engine().import_state(state))??;
                Ok(ResultPayload::Block(receipt.finalized().into()))
            })
        })
    }
}

#[no_mangle]
/// Copies stable result metadata to a versioned output structure.
///
/// # Safety
/// `out_info` must be writable and must initially contain the documented
/// `struct_size` and `abi_version` values.
pub unsafe extern "C" fn citizensdk_result_get_info(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkResultInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "result info")?;
        ptr::write(out_info, ownership::get(result)?.info());
        Ok(())
    })
}

#[no_mangle]
/// Copies the product-independent stage retained by a ready failed result.
///
/// # Safety
/// `out_stage` must be writable. Successful results do not have a failure stage.
pub unsafe extern "C" fn citizensdk_result_get_failure_stage(
    result: CitizenSdkResultHandle,
    out_stage: *mut CitizenSdkFailureStage,
) -> i32 {
    ffi_status(|| {
        if out_stage.is_null() {
            return Err(FfiError::invalid("failure stage output is null"));
        }
        let owned = ownership::get(result)?;
        let stage = owned.failure_stage.ok_or_else(|| {
            FfiError::new(
                CitizenSdkErrorCode::InvalidState,
                "successful result does not have a failure stage",
            )
        })?;
        ptr::write(out_stage, stage);
        Ok(())
    })
}

#[no_mangle]
/// Copies or size-queries the UTF-8 diagnostic owned by a result.
///
/// # Safety
/// `out_required` must be writable. For a copy, `buffer` must be writable for
/// at least `capacity` bytes; for a size query use null with zero capacity.
pub unsafe extern "C" fn citizensdk_result_copy_error_message(
    result: CitizenSdkResultHandle,
    buffer: *mut u8,
    capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        copy_to_host(
            &ownership::get(result)?.message,
            buffer,
            capacity,
            out_required,
        )
    })
}

#[no_mangle]
/// Copies a block-reference result into a versioned output structure.
///
/// # Safety
/// `out_block` must be writable and must initially contain the documented
/// `struct_size` and `abi_version` values.
pub unsafe extern "C" fn citizensdk_result_get_block_ref(
    result: CitizenSdkResultHandle,
    out_block: *mut CitizenSdkBlockRef,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_block, "block result")?;
        let owned = ownership::get(result)?;
        let ResultPayload::Block(block) = owned.payload else {
            return Err(wrong_result("block reference"));
        };
        ptr::write(out_block, block_to_abi(block));
        Ok(())
    })
}

#[no_mangle]
/// Copies one coherent light-node synchronization snapshot.
///
/// # Safety
/// `out_info` must be writable and initialized with the supported ABI prefix.
pub unsafe extern "C" fn citizensdk_result_get_sync_status(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkChainSyncStatusInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "chain sync status info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::ChainSyncStatus(status) = owned.payload else {
            return Err(wrong_result("chain sync status"));
        };
        ptr::write(
            out_info,
            CitizenSdkChainSyncStatusInfo {
                struct_size: std::mem::size_of::<CitizenSdkChainSyncStatusInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                peer_count: status.peer_count(),
                is_syncing: u8::from(status.is_syncing()),
                is_usable: u8::from(status.is_usable()),
                reserved: [0; 6],
                best: block_to_abi(status.best()),
                finalized: block_to_abi(status.finalized().into()),
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Copies a verified header descriptor and its complete SCALE Digest bytes.
///
/// # Safety
/// `out_info` and `out_required` must be writable. For a copy, `digest_buffer` must be writable
/// for at least `digest_capacity` bytes.
pub unsafe extern "C" fn citizensdk_result_get_block_header(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkBlockHeaderInfo,
    digest_buffer: *mut u8,
    digest_capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "block header info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::BlockHeader(header) = owned.payload else {
            return Err(wrong_result("block header"));
        };
        copy_to_host(
            header.digest(),
            digest_buffer,
            digest_capacity,
            out_required,
        )?;
        ptr::write(
            out_info,
            CitizenSdkBlockHeaderInfo {
                struct_size: std::mem::size_of::<CitizenSdkBlockHeaderInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                block: block_to_abi(header.block()),
                parent_hash: header.parent_hash().into_bytes(),
                state_root: header.state_root().into_bytes(),
                extrinsics_root: header.extrinsics_root().into_bytes(),
                digest_len: header.digest().len() as u64,
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Copies fixed-width information for an ordered opaque block body.
///
/// # Safety
/// `out_info` must be writable and initialized with the supported ABI prefix.
pub unsafe extern "C" fn citizensdk_result_get_block_body_info(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkBlockBodyInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "block body info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::BlockBody(body) = owned.payload else {
            return Err(wrong_result("block body"));
        };
        let extrinsic_count = u32::try_from(body.extrinsics().len())
            .map_err(|_| FfiError::internal("block body extrinsic count exceeds u32"))?;
        let total_bytes = body
            .extrinsics()
            .iter()
            .try_fold(0_u64, |total, extrinsic| {
                let length = u64::try_from(extrinsic.len())
                    .map_err(|_| FfiError::internal("block body extrinsic length exceeds u64"))?;
                total
                    .checked_add(length)
                    .ok_or_else(|| FfiError::internal("block body length exceeds u64"))
            })?;
        ptr::write(
            out_info,
            CitizenSdkBlockBodyInfo {
                struct_size: std::mem::size_of::<CitizenSdkBlockBodyInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                block: block_to_abi(body.block()),
                extrinsic_count,
                reserved: 0,
                total_bytes,
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Copies or size-queries one ordered opaque extrinsic from a block body.
///
/// # Safety
/// `out_required` must be writable. For a copy, `buffer` must be writable for `capacity` bytes.
pub unsafe extern "C" fn citizensdk_result_copy_block_body_extrinsic(
    result: CitizenSdkResultHandle,
    index: u32,
    buffer: *mut u8,
    capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        let owned = ownership::get(result)?;
        let ResultPayload::BlockBody(body) = owned.payload else {
            return Err(wrong_result("block body"));
        };
        let extrinsic = body
            .extrinsics()
            .get(index as usize)
            .ok_or_else(|| FfiError::invalid("block body extrinsic index is out of range"))?;
        copy_to_host(extrinsic, buffer, capacity, out_required)
    })
}

#[no_mangle]
/// Copies or size-queries an optional storage-value result.
///
/// # Safety
/// `out_present` and `out_required` must be writable. For a copy, `buffer`
/// must be writable for at least `capacity` bytes.
pub unsafe extern "C" fn citizensdk_result_copy_storage(
    result: CitizenSdkResultHandle,
    out_present: *mut u8,
    buffer: *mut u8,
    capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        require_output(out_present, "out_present")?;
        let owned = ownership::get(result)?;
        let ResultPayload::Storage(value) = owned.payload else {
            return Err(wrong_result("storage value"));
        };
        ptr::write(out_present, u8::from(value.is_some()));
        copy_to_host(
            value.as_deref().unwrap_or_default(),
            buffer,
            capacity,
            out_required,
        )
    })
}

#[no_mangle]
/// Copies the number of items in a storage-batch result.
///
/// # Safety
/// `out_count` must be writable for one `u32`.
pub unsafe extern "C" fn citizensdk_result_get_storage_batch_count(
    result: CitizenSdkResultHandle,
    out_count: *mut u32,
) -> i32 {
    ffi_status(|| {
        require_output(out_count, "out_count")?;
        let owned = ownership::get(result)?;
        let ResultPayload::StorageBatch(values) = owned.payload else {
            return Err(wrong_result("storage batch"));
        };
        let count = u32::try_from(values.len())
            .map_err(|_| FfiError::internal("storage batch result is too large"))?;
        ptr::write(out_count, count);
        Ok(())
    })
}

#[no_mangle]
/// Copies or size-queries one optional storage-batch item.
///
/// # Safety
/// `out_present` and `out_required` must be writable. For a copy, `buffer`
/// must be writable for at least `capacity` bytes.
pub unsafe extern "C" fn citizensdk_result_copy_storage_batch_item(
    result: CitizenSdkResultHandle,
    index: u32,
    out_present: *mut u8,
    buffer: *mut u8,
    capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        require_output(out_present, "out_present")?;
        let owned = ownership::get(result)?;
        let ResultPayload::StorageBatch(values) = owned.payload else {
            return Err(wrong_result("storage batch"));
        };
        let value = values
            .get(index as usize)
            .ok_or_else(|| FfiError::invalid("storage batch index is out of range"))?;
        ptr::write(out_present, u8::from(value.is_some()));
        copy_to_host(
            value.as_deref().unwrap_or_default(),
            buffer,
            capacity,
            out_required,
        )
    })
}

#[no_mangle]
/// Copies runtime context metadata and its versioned fixed-width descriptor.
///
/// # Safety
/// `out_info` and `out_required` must be writable; `out_info` must contain a
/// supported prefix. For a copy, `metadata_buffer` must fit its capacity.
pub unsafe extern "C" fn citizensdk_result_get_runtime_context(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkRuntimeContextInfo,
    metadata_buffer: *mut u8,
    metadata_capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "runtime context info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::RuntimeContext(context) = owned.payload else {
            return Err(wrong_result("runtime context"));
        };
        copy_to_host(
            context.metadata(),
            metadata_buffer,
            metadata_capacity,
            out_required,
        )?;
        ptr::write(
            out_info,
            CitizenSdkRuntimeContextInfo {
                struct_size: std::mem::size_of::<CitizenSdkRuntimeContextInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                block: block_to_abi(context.block()),
                spec_version: context.version().spec_version(),
                transaction_version: context.version().transaction_version(),
                metadata_len: context.metadata().len() as u64,
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Copies a 32-byte hash result.
///
/// # Safety
/// `out_hash` must be writable for exactly 32 bytes.
pub unsafe extern "C" fn citizensdk_result_get_hash(
    result: CitizenSdkResultHandle,
    out_hash: *mut u8,
) -> i32 {
    ffi_status(|| {
        require_output(out_hash, "out_hash")?;
        let owned = ownership::get(result)?;
        let ResultPayload::Hash(hash) = owned.payload else {
            return Err(wrong_result("hash"));
        };
        ptr::copy_nonoverlapping(hash.as_bytes().as_ptr(), out_hash, 32);
        Ok(())
    })
}

#[no_mangle]
/// Copies a proof-oriented execution conclusion.
///
/// # Safety
/// `out_info` must be writable and must initially contain the documented
/// `struct_size` and `abi_version` values.
pub unsafe extern "C" fn citizensdk_result_get_execution(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkExecutionInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "execution info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::Execution(conclusion) = owned.payload else {
            return Err(wrong_result("execution conclusion"));
        };
        ptr::write(out_info, execution_to_abi(&conclusion));
        Ok(())
    })
}

#[no_mangle]
/// Copies one extrinsic-watch event result.
///
/// # Safety
/// `out_info` must be writable and must initially contain the documented
/// `struct_size` and `abi_version` values.
pub unsafe extern "C" fn citizensdk_result_get_watch_event(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkWatchEventInfo,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "watch event info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::Watch(event) = owned.payload else {
            return Err(wrong_result("watch event"));
        };
        ptr::write(out_info, watch_to_abi(&event));
        Ok(())
    })
}

#[no_mangle]
/// Copies or size-queries an exported provider database and descriptor.
///
/// # Safety
/// `out_info` and `out_required` must be writable; `out_info` must contain a
/// supported prefix. For a copy, `database_buffer` must fit its capacity.
pub unsafe extern "C" fn citizensdk_result_get_exported_state(
    result: CitizenSdkResultHandle,
    out_info: *mut CitizenSdkExportedStateInfo,
    database_buffer: *mut u8,
    database_capacity: u64,
    out_required: *mut u64,
) -> i32 {
    ffi_status(|| {
        validate_output_versioned(out_info, "exported state info")?;
        let owned = ownership::get(result)?;
        let ResultPayload::ExportedState(state) = owned.payload else {
            return Err(wrong_result("exported state"));
        };
        copy_to_host(
            state.database(),
            database_buffer,
            database_capacity,
            out_required,
        )?;
        ptr::write(
            out_info,
            CitizenSdkExportedStateInfo {
                struct_size: std::mem::size_of::<CitizenSdkExportedStateInfo>() as u32,
                abi_version: CITIZENSDK_ABI_VERSION,
                format_version: state.format_version(),
                reserved: 0,
                finalized: block_to_abi(state.finalized().into()),
                database_len: state.database().len() as u64,
            },
        );
        Ok(())
    })
}

#[no_mangle]
/// Releases one owned result exactly once.
///
/// # Safety
/// `result` must be a nonzero result handle emitted by this library. Calling
/// this function concurrently for the same handle is permitted, but only one
/// caller succeeds.
pub unsafe extern "C" fn citizensdk_result_release(result: CitizenSdkResultHandle) -> i32 {
    ffi_status(|| {
        let owned = ownership::get(result)?;
        let runtime = handles::get(owned.owner)?;
        let _released = ownership::release(result)?;
        runtime.result_released();
        Ok(())
    })
}

#[no_mangle]
/// Copies or size-queries this thread's last synchronous ABI diagnostic.
///
/// # Safety
/// `out_required` must be writable. For a copy, `buffer` must be writable for
/// at least `capacity` bytes; for a size query use null with zero capacity.
pub unsafe extern "C" fn citizensdk_last_error_copy(
    buffer: *mut u8,
    capacity: u64,
    out_required: *mut u64,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(|| {
        let value = last_error();
        copy_to_host(value.as_bytes(), buffer, capacity, out_required)
    })) {
        Ok(Ok(())) => CitizenSdkErrorCode::Ok.as_i32(),
        Ok(Err(error)) => error.code.as_i32(),
        Err(_) => CitizenSdkErrorCode::Panic.as_i32(),
    }
}

fn ffi_status(operation: impl FnOnce() -> FfiResult<()>) -> i32 {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(())) => {
            clear_last_error();
            CitizenSdkErrorCode::Ok.as_i32()
        }
        Ok(Err(error)) => {
            set_last_error(&error);
            error.code.as_i32()
        }
        Err(_) => {
            let error = FfiError::new(CitizenSdkErrorCode::Panic, "CitizenSDK ABI panicked");
            set_last_error(&error);
            error.code.as_i32()
        }
    }
}

unsafe fn accept_and_write<F>(
    runtime: std::sync::Arc<NativeRuntime>,
    out_request_id: *mut CitizenSdkRequestId,
    operation: F,
) -> FfiResult<()>
where
    F: FnOnce(
            &std::sync::Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<requests::RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    require_output(out_request_id, "out_request_id")?;
    let request_id = requests::accept(runtime, false, operation)?;
    ptr::write(out_request_id, request_id);
    Ok(())
}

unsafe fn accept_and_write_exclusive<F>(
    runtime: std::sync::Arc<NativeRuntime>,
    out_request_id: *mut CitizenSdkRequestId,
    operation: F,
) -> FfiResult<()>
where
    F: FnOnce(
            &std::sync::Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<requests::RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    require_output(out_request_id, "out_request_id")?;
    let request_id = requests::accept_exclusive(runtime, operation)?;
    ptr::write(out_request_id, request_id);
    Ok(())
}

unsafe fn accept_and_write_lifecycle<F>(
    runtime: std::sync::Arc<NativeRuntime>,
    out_request_id: *mut CitizenSdkRequestId,
    operation: F,
) -> FfiResult<()>
where
    F: FnOnce(
            &std::sync::Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<requests::RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    match lifecycle_admission_policy(runtime.uses_host_services()) {
        LifecycleAdmissionPolicy::Shared => {
            // SAFETY: forwarded from this helper's caller contract.
            unsafe { accept_and_write(runtime, out_request_id, operation) }
        }
        LifecycleAdmissionPolicy::Exclusive => {
            // SAFETY: forwarded from this helper's caller contract.
            unsafe { accept_and_write_exclusive(runtime, out_request_id, operation) }
        }
    }
}

unsafe fn accept_and_write_watch<F>(
    runtime: std::sync::Arc<NativeRuntime>,
    out_request_id: *mut CitizenSdkRequestId,
    operation: F,
) -> FfiResult<()>
where
    F: FnOnce(
            &std::sync::Arc<NativeRuntime>,
            CitizenSdkRequestId,
            Option<requests::RequestCancellation>,
        ) -> FfiResult<ResultPayload>
        + Send
        + 'static,
{
    require_output(out_request_id, "out_request_id")?;
    let request_id = requests::accept_watch(runtime, operation)?;
    ptr::write(out_request_id, request_id);
    Ok(())
}

unsafe fn read_versioned<T: Copy>(pointer: *const T, name: &str) -> FfiResult<T> {
    if pointer.is_null() {
        return Err(FfiError::invalid(format!("{name} is null")));
    }
    validate_versioned_prefix(pointer.cast::<u8>(), std::mem::size_of::<T>(), name)?;
    Ok(ptr::read(pointer))
}

unsafe fn validate_output_versioned<T>(pointer: *mut T, name: &str) -> FfiResult<()> {
    if pointer.is_null() {
        return Err(FfiError::invalid(format!("{name} output is null")));
    }
    validate_versioned_prefix(pointer.cast::<u8>(), std::mem::size_of::<T>(), name)
}

unsafe fn validate_versioned_prefix(
    pointer: *const u8,
    expected_size: usize,
    name: &str,
) -> FfiResult<()> {
    let struct_size = ptr::read_unaligned(pointer.cast::<u32>()) as usize;
    let abi_version = ptr::read_unaligned(pointer.add(4).cast::<u32>());
    if struct_size < expected_size {
        return Err(FfiError::invalid(format!(
            "{name} struct_size is too small"
        )));
    }
    if abi_version != CITIZENSDK_ABI_VERSION {
        return Err(FfiError::new(
            CitizenSdkErrorCode::Unsupported,
            format!("{name} ABI version is unsupported"),
        ));
    }
    Ok(())
}

unsafe fn require_output<T>(pointer: *mut T, name: &str) -> FfiResult<()> {
    if pointer.is_null() {
        Err(FfiError::invalid(format!("{name} is null")))
    } else {
        Ok(())
    }
}

unsafe fn copy_view(view: CitizenSdkBytesView, name: &str, maximum: usize) -> FfiResult<Vec<u8>> {
    let len = usize::try_from(view.len)
        .map_err(|_| FfiError::invalid(format!("{name} length is too large")))?;
    if len > maximum {
        return Err(FfiError::invalid(format!("{name} exceeds its size limit")));
    }
    if len == 0 {
        return Ok(Vec::new());
    }
    if view.data.is_null() {
        return Err(FfiError::invalid(format!("{name} data is null")));
    }
    Ok(std::slice::from_raw_parts(view.data, len).to_vec())
}

unsafe fn optional_utf8(view: CitizenSdkBytesView, name: &str, default: &str) -> FfiResult<String> {
    let bytes = copy_view(view, name, 1024)?;
    if bytes.is_empty() {
        return Ok(default.to_owned());
    }
    String::from_utf8(bytes).map_err(|_| FfiError::invalid(format!("{name} is not UTF-8")))
}

unsafe fn copy_fixed_32(pointer: *const u8, name: &str) -> FfiResult<[u8; 32]> {
    if pointer.is_null() {
        return Err(FfiError::invalid(format!("{name} is null")));
    }
    let mut output = [0_u8; 32];
    ptr::copy_nonoverlapping(pointer, output.as_mut_ptr(), output.len());
    Ok(output)
}

unsafe fn copy_to_host(
    bytes: impl AsRef<[u8]>,
    buffer: *mut u8,
    capacity: u64,
    out_required: *mut u64,
) -> FfiResult<()> {
    require_output(out_required, "out_required")?;
    let bytes = bytes.as_ref();
    ptr::write(out_required, bytes.len() as u64);
    let capacity =
        usize::try_from(capacity).map_err(|_| FfiError::invalid("output capacity is too large"))?;
    if bytes.is_empty() {
        return Ok(());
    }
    if buffer.is_null() && capacity == 0 {
        return Ok(());
    }
    if buffer.is_null() || capacity < bytes.len() {
        return Err(FfiError::invalid("output buffer is null or too small"));
    }
    ptr::copy_nonoverlapping(bytes.as_ptr(), buffer, bytes.len());
    Ok(())
}

fn signed_extrinsic(view: CitizenSdkBytesView) -> FfiResult<SignedExtrinsic> {
    // SAFETY: every exported caller is already responsible for the view's
    // pointer validity; this helper copies it before asynchronous execution.
    let bytes = unsafe { copy_view(view, "signed extrinsic", MAX_ABI_INPUT_BYTES)? };
    SignedExtrinsic::try_new(bytes).map_err(Into::into)
}

fn block_from_abi(block: CitizenSdkBlockRef) -> FfiResult<VerifiedBlockRef> {
    let hash = Hash32::from_bytes(block.hash);
    match block.finality {
        value if value == CitizenSdkFinality::Best as u32 => {
            Ok(VerifiedBlockRef::best(hash, block.number))
        }
        value if value == CitizenSdkFinality::Finalized as u32 => {
            Ok(VerifiedBlockRef::finalized(hash, block.number))
        }
        _ => Err(FfiError::invalid("block finality is invalid")),
    }
}

fn block_to_abi(block: VerifiedBlockRef) -> CitizenSdkBlockRef {
    CitizenSdkBlockRef {
        struct_size: std::mem::size_of::<CitizenSdkBlockRef>() as u32,
        abi_version: CITIZENSDK_ABI_VERSION,
        hash: block.hash().into_bytes(),
        number: block.number(),
        finality: match block.finality() {
            BlockFinality::Best => CitizenSdkFinality::Best,
            BlockFinality::Finalized => CitizenSdkFinality::Finalized,
        } as u32,
        reserved: 0,
    }
}

fn watch_is_terminal(event: &ExtrinsicWatchEvent) -> bool {
    matches!(
        event,
        ExtrinsicWatchEvent::Finalized { .. }
            | ExtrinsicWatchEvent::Invalid
            | ExtrinsicWatchEvent::Usurped { .. }
    )
}

fn watch_to_abi(event: &ExtrinsicWatchEvent) -> CitizenSdkWatchEventInfo {
    let mut output = CitizenSdkWatchEventInfo {
        struct_size: std::mem::size_of::<CitizenSdkWatchEventInfo>() as u32,
        abi_version: CITIZENSDK_ABI_VERSION,
        status: 0,
        peer_count: 0,
        has_block: 0,
        has_replacement_hash: 0,
        reserved: [0; 6],
        block: CitizenSdkBlockRef::default(),
        replacement_hash: [0; 32],
    };
    match event {
        ExtrinsicWatchEvent::Ready => output.status = CitizenSdkWatchStatus::Ready as u32,
        ExtrinsicWatchEvent::Broadcast { peer_count } => {
            output.status = CitizenSdkWatchStatus::Broadcast as u32;
            output.peer_count = *peer_count;
        }
        ExtrinsicWatchEvent::Future => output.status = CitizenSdkWatchStatus::Future as u32,
        ExtrinsicWatchEvent::InBlock { block } => {
            output.status = CitizenSdkWatchStatus::InBlock as u32;
            output.has_block = 1;
            output.block = block_to_abi(*block);
        }
        ExtrinsicWatchEvent::Finalized { block } => {
            output.status = CitizenSdkWatchStatus::Finalized as u32;
            output.has_block = 1;
            output.block = block_to_abi((*block).into());
        }
        ExtrinsicWatchEvent::Retracted { block } => {
            output.status = CitizenSdkWatchStatus::Retracted as u32;
            output.has_block = 1;
            output.block = block_to_abi(*block);
        }
        ExtrinsicWatchEvent::FinalityTimeout { block } => {
            output.status = CitizenSdkWatchStatus::FinalityTimeout as u32;
            if let Some(block) = block {
                output.has_block = 1;
                output.block = block_to_abi(*block);
            }
        }
        ExtrinsicWatchEvent::Dropped => output.status = CitizenSdkWatchStatus::Dropped as u32,
        ExtrinsicWatchEvent::Invalid => output.status = CitizenSdkWatchStatus::Invalid as u32,
        ExtrinsicWatchEvent::Usurped { replacement_hash } => {
            output.status = CitizenSdkWatchStatus::Usurped as u32;
            output.has_replacement_hash = 1;
            output.replacement_hash = replacement_hash.into_bytes();
        }
    }
    output
}

fn execution_to_abi(conclusion: &ExecutionConclusion) -> CitizenSdkExecutionInfo {
    let mut output = CitizenSdkExecutionInfo {
        struct_size: std::mem::size_of::<CitizenSdkExecutionInfo>() as u32,
        abi_version: CITIZENSDK_ABI_VERSION,
        status: 0,
        reason_or_dispatch_variant: 0,
        has_block: 0,
        has_extrinsic_index: 0,
        has_module: 0,
        reserved: [0; 5],
        block: CitizenSdkBlockRef::default(),
        extrinsic_index: 0,
        pallet_index: 0,
        error_index: 0,
        reserved_tail: [0; 2],
    };
    match conclusion {
        ExecutionConclusion::Success {
            block,
            extrinsic_index,
        } => {
            output.status = CitizenSdkExecutionStatus::Success as u32;
            output.has_block = 1;
            output.has_extrinsic_index = 1;
            output.block = block_to_abi(*block);
            output.extrinsic_index = *extrinsic_index;
        }
        ExecutionConclusion::Failed {
            block,
            extrinsic_index,
            failure,
        } => {
            output.status = CitizenSdkExecutionStatus::Failed as u32;
            output.reason_or_dispatch_variant = failure.variant() as u32;
            output.has_block = 1;
            output.has_extrinsic_index = 1;
            output.block = block_to_abi(*block);
            output.extrinsic_index = *extrinsic_index;
            if let Some(module) = failure.module() {
                output.has_module = 1;
                output.pallet_index = module.pallet_index();
                output.error_index = module.error_index();
            }
        }
        ExecutionConclusion::Unverified {
            block,
            extrinsic_index,
            reason,
        } => {
            output.status = CitizenSdkExecutionStatus::Unverified as u32;
            output.reason_or_dispatch_variant = unverified_reason(*reason);
            if let Some(block) = block {
                output.has_block = 1;
                output.block = block_to_abi(*block);
            }
            if let Some(index) = extrinsic_index {
                output.has_extrinsic_index = 1;
                output.extrinsic_index = *index;
            }
        }
    }
    output
}

const fn unverified_reason(reason: UnverifiedReason) -> u32 {
    match reason {
        UnverifiedReason::TargetBlockUnavailable => 1,
        UnverifiedReason::RuntimeContextUnavailable => 2,
        UnverifiedReason::MetadataDecodeFailed => 3,
        UnverifiedReason::BlockBodyUnavailable => 4,
        UnverifiedReason::ExtrinsicHashMismatch => 5,
        UnverifiedReason::ExtrinsicNotFound => 6,
        UnverifiedReason::MultipleExtrinsicMatches => 7,
        UnverifiedReason::SystemEventsUnavailable => 8,
        UnverifiedReason::SystemEventsMalformed => 9,
        UnverifiedReason::OutcomeEventMissing => 10,
        UnverifiedReason::OutcomeEventAmbiguous => 11,
        UnverifiedReason::ProviderFailure => 12,
    }
}

fn wrong_result(expected: &str) -> FfiError {
    FfiError::invalid(format!("result does not contain {expected}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "chain")]
    #[test]
    fn start_diagnostic_keeps_success_and_errors_but_replaces_panic_payload() {
        let step = Cell::new(StartStep::Restore);
        let convergences = Cell::new(0);
        let converge = || convergences.set(convergences.get() + 1);
        assert_eq!(diagnose_start(&step, converge, || Ok::<_, FfiError>(7)), Ok(7));
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
            assert_eq!(error.message, format!("CitizenSDK start panicked at {}", current.token()));
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
    fn host_lifecycle_uses_exclusive_admission_while_legacy_remains_shared() {
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

        let legacy_steps = std::cell::RefCell::new(Vec::new());
        run_start_lifecycle_policy(
            false,
            || {
                legacy_steps.borrow_mut().push("restore");
                Ok::<(), &'static str>(())
            },
            || legacy_steps.borrow_mut().push("converge"),
            || {
                legacy_steps.borrow_mut().push("begin");
                Ok(())
            },
            || {
                legacy_steps.borrow_mut().push("publish-begin");
                Ok(())
            },
            || {
                legacy_steps.borrow_mut().push("provider-start");
                Ok(())
            },
        )
        .unwrap_or_else(|error| panic!("legacy start policy failed: {error}"));
        assert_eq!(
            *legacy_steps.borrow(),
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
                host_steps.borrow_mut().push("legacy-export");
                Ok::<u8, ()>(1)
            },
            || {
                host_steps.borrow_mut().push("persistent-export");
                Ok::<u8, ()>(2)
            },
        );
        assert_eq!(host, Ok(2));
        assert_eq!(*host_steps.borrow(), ["persistent-export"]);

        let legacy_steps = std::cell::RefCell::new(Vec::new());
        let legacy = select_state_export(
            false,
            || {
                legacy_steps.borrow_mut().push("legacy-export");
                Ok::<u8, ()>(1)
            },
            || {
                legacy_steps.borrow_mut().push("persistent-export");
                Ok::<u8, ()>(2)
            },
        );
        assert_eq!(legacy, Ok(1));
        assert_eq!(*legacy_steps.borrow(), ["legacy-export"]);
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

        let legacy_steps = std::cell::RefCell::new(Vec::new());
        run_stop_lifecycle_policy(
            false,
            || {
                legacy_steps.borrow_mut().push("persist");
                Ok::<(), &'static str>(())
            },
            || {
                legacy_steps.borrow_mut().push("unsubscribe");
                Ok(())
            },
            || {
                legacy_steps.borrow_mut().push("stop-products");
                Ok(())
            },
            || {
                legacy_steps.borrow_mut().push("stop-provider");
                Ok(())
            },
            || {
                legacy_steps.borrow_mut().push("mark-stopped");
                Ok(())
            },
        )
        .unwrap_or_else(|error| panic!("legacy stop policy failed: {error}"));
        assert_eq!(
            *legacy_steps.borrow(),
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
        use citizen_sdk_contracts::{
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
        let body_result =
            ownership::insert(OwnedResult::success(1, ResultPayload::BlockBody(body)))
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
        let source = include_str!("lib.rs");
        for suffix in ["build_transaction", "wallet_create", "sign_secret"] {
            let forbidden = ["citizensdk_", suffix].concat();
            assert!(!source.contains(&forbidden));
        }
    }

    #[test]
    fn watch_terminal_policy_does_not_confuse_network_loss_with_finality() {
        let block = citizen_sdk_contracts::FinalizedBlockRef::from_parts(
            Hash32::from_bytes([0x44; 32]),
            44,
        );
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
}
