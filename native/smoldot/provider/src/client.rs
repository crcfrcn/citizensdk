use std::{
    future::Future,
    num::NonZeroU32,
    sync::{Arc, Mutex},
    time::Duration,
};

use citizen_sdk_contracts::{
    AccountNonceSource, ChainIdentity, ContractError, ContractErrorCode, ContractFuture,
    ContractResult, ExportedChainState, FinalizedBlockRef, VerifiedChainClient,
    CITIZENCHAIN_CHAIN_ID, CITIZENCHAIN_GENESIS_HASH, CITIZENCHAIN_PROTOCOL_ID,
};
use futures_util::FutureExt;
use parking_lot::Mutex as ParkingMutex;
use serde_json::Value;
use smoldot_light::{
    platform::DefaultPlatform, AddChainConfig, AddChainConfigJsonRpc, AddChainSuccess, ChainId,
    Client, StartupFinalizedSource,
};

use crate::{legacy::LegacyRpc, verified_chain_client::RuntimeContexts};

pub(crate) const CHAIN_STATE_FORMAT_VERSION: u32 = 1;
pub(crate) const MAX_CHAIN_DATABASE_BYTES: usize = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_WORKER_THREADS: usize = 2;
const MAX_PENDING_REQUESTS: u32 = 256;
const MAX_SUBSCRIPTIONS: u32 = 128;

type NativeClient = Client<Arc<DefaultPlatform>, ()>;

/// smoldot provider 的单向生命周期。失败或停止后必须创建新实例，禁止复用旧状态。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderLifecycle {
    Created,
    Starting,
    Running,
    StartFailed,
    Stopped,
}

/// 由 smoldot 同步服务直接给出的能力事实；不根据 UI 计时或历史高度自行推断。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmoldotProviderStatus {
    pub lifecycle: ProviderLifecycle,
    pub peer_count: u64,
    pub is_syncing: bool,
    pub is_usable: bool,
    pub best_block_number: u64,
    pub best_block_hash: [u8; 32],
    pub verified_finalized_block_number: u64,
    pub verified_finalized_block_hash: [u8; 32],
}

/// 创建正式 CitizenChain smoldot 实例所需的不可变配置。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmoldotProviderConfig {
    pub(crate) chain_spec: String,
    pub(crate) system_name: String,
    pub(crate) system_version: String,
    pub(crate) request_timeout: Duration,
    pub(crate) bootstrap: bool,
}

impl SmoldotProviderConfig {
    /// 接受资产层验证并注入随包 `lightSyncState` #0 checkpoint 的 chainspec JSON。
    ///
    /// 本层再次固定 `id` 与 `protocolId`；genesis hash 会在轻节点真实启动后从其已解析
    /// 链身份读取并核对，不能仅相信 JSON 文本。设备持久化 finalized database 是另一类
    /// 状态，只能经 `VerifiedChainClient::import_state` 在首次启动前单独提供，不能与随包
    /// `lightSyncState` checkpoint 混为一物。
    pub fn try_new(
        chain_spec: impl Into<String>,
        system_name: impl Into<String>,
        system_version: impl Into<String>,
    ) -> ContractResult<Self> {
        let chain_spec = chain_spec.into();
        let parsed: Value = serde_json::from_str(&chain_spec).map_err(|error| {
            contract_error(
                ContractErrorCode::InvalidArgument,
                format!("chainspec 不是有效 JSON: {error}"),
            )
        })?;
        let chain_id = parsed.get("id").and_then(Value::as_str);
        let protocol_id = parsed.get("protocolId").and_then(Value::as_str);
        if chain_id != Some(CITIZENCHAIN_CHAIN_ID) || protocol_id != Some(CITIZENCHAIN_PROTOCOL_ID)
        {
            return Err(contract_error(
                ContractErrorCode::Integrity,
                "chainspec 的 id 与 protocolId 必须均为 citizenchain",
            ));
        }

        let system_name = system_name.into();
        let system_version = system_version.into();
        if system_name.trim().is_empty() || system_version.trim().is_empty() {
            return Err(contract_error(
                ContractErrorCode::InvalidArgument,
                "system_name 与 system_version 不能为空",
            ));
        }

        Ok(Self {
            chain_spec,
            system_name,
            system_version,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            bootstrap: false,
        })
    }

    /// SDK 产品组合显式启用公民网非权威节点建议；裸 provider 不隐式访问额外服务。
    /// 只改变启动时的节点候选，不影响信任资产、验证语义或上游网络算法。
    pub fn with_bootstrap(mut self) -> Self {
        self.bootstrap = true;
        self
    }
}

pub(crate) struct RunningProvider {
    pub(crate) client: Arc<ParkingMutex<NativeClient>>,
    pub(crate) chain_id: ChainId,
    pub(crate) rpc: LegacyRpc,
    pub(crate) runtime_contexts: ParkingMutex<RuntimeContexts>,
}

struct ProviderState {
    lifecycle: ProviderLifecycle,
    running: Option<Arc<RunningProvider>>,
    pending_import: Option<ExportedChainState>,
}

/// 启动 Future 的 panic 先收敛生命周期，再由外层固定 ABI 诊断捕获原 unwind。
async fn converge_start_unwind<T>(
    state: &Mutex<ProviderState>,
    operation: impl Future<Output = T>,
) -> T {
    match std::panic::AssertUnwindSafe(operation).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => {
            let mut state = state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.running = None;
            state.lifecycle = ProviderLifecycle::StartFailed;
            // 抛出前释放锁；否则 panic 会把已收敛状态再次变成不可读取的毒化锁。
            drop(state);
            std::panic::resume_unwind(payload);
        }
    }
}

/// 随包 smoldot 的真实 `VerifiedChainClient` 实现。
pub struct SmoldotVerifiedChainClient {
    pub(crate) config: SmoldotProviderConfig,
    runtime: tokio::runtime::Runtime,
    state: Mutex<ProviderState>,
}

impl SmoldotVerifiedChainClient {
    pub fn new(config: SmoldotProviderConfig) -> ContractResult<Arc<Self>> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(PROVIDER_WORKER_THREADS)
            .thread_name("cit-sdk-smoldot")
            .enable_all()
            .build()
            .map_err(|error| {
                contract_error(
                    ContractErrorCode::Unavailable,
                    format!("无法创建 smoldot provider runtime: {error}"),
                )
            })?;
        Ok(Arc::new(Self {
            config,
            runtime,
            state: Mutex::new(ProviderState {
                lifecycle: ProviderLifecycle::Created,
                running: None,
                pending_import: None,
            }),
        }))
    }

    /// 返回可直接注入 `EngineComponents` 的类型擦除链合同。
    pub fn as_verified_chain_client(self: &Arc<Self>) -> Arc<dyn VerifiedChainClient> {
        Arc::clone(self) as Arc<dyn VerifiedChainClient>
    }

    /// 返回与链客户端共享同一 smoldot 实例和单向生命周期的 nonce 合同。
    pub fn as_account_nonce_source(self: &Arc<Self>) -> Arc<dyn AccountNonceSource> {
        Arc::clone(self) as Arc<dyn AccountNonceSource>
    }

    pub fn lifecycle(&self) -> ContractResult<ProviderLifecycle> {
        Ok(self.lock_state()?.lifecycle)
    }

    /// 真实启动 smoldot，并在公开 Running 前核对 genesis 与导入锚。
    pub fn start(&self) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            let pending_import = {
                let mut state = self.lock_state()?;
                if state.lifecycle != ProviderLifecycle::Created {
                    return Err(contract_error(
                        ContractErrorCode::InvalidState,
                        "smoldot provider 只能启动一次",
                    ));
                }
                state.lifecycle = ProviderLifecycle::Starting;
                state.pending_import.clone()
            };

            // HTTPS 证书或轻节点启动中的 panic 不能把 STARTING 留给 UI。
            let result =
                converge_start_unwind(&self.state, self.start_inner(pending_import.as_ref())).await;
            match result {
                Ok(running) => {
                    let mut state = self.lock_state()?;
                    if state.lifecycle != ProviderLifecycle::Starting {
                        Self::remove_running_chain(&running);
                        return Err(contract_error(
                            ContractErrorCode::Conflict,
                            "provider 启动完成时生命周期已改变",
                        ));
                    }
                    state.running = Some(running);
                    state.pending_import = None;
                    state.lifecycle = ProviderLifecycle::Running;
                    Ok(())
                }
                Err(error) => {
                    let mut state = self.lock_state()?;
                    state.running = None;
                    state.lifecycle = ProviderLifecycle::StartFailed;
                    Err(error)
                }
            }
        })
    }

    pub fn stop(&self) -> ContractResult<()> {
        let running = {
            let mut state = self.lock_state()?;
            if state.lifecycle != ProviderLifecycle::Running {
                return Err(contract_error(
                    ContractErrorCode::InvalidState,
                    "只有 Running provider 可以停止",
                ));
            }
            if let Some(running) = &state.running {
                if !running.rpc.close_finalized_gate_if_idle() {
                    return Err(contract_error(
                        ContractErrorCode::InvalidState,
                        "finalized subscriptions must be drained before provider stop",
                    ));
                }
            }
            state.lifecycle = ProviderLifecycle::Stopped;
            state.running.take().ok_or_else(|| {
                contract_error(
                    ContractErrorCode::Integrity,
                    "Running provider 缺少 smoldot 实例",
                )
            })?
        };
        running.runtime_contexts.lock().close();
        Self::remove_running_chain(&running);
        Ok(())
    }

    /// 排空 SDK 订阅适配任务，不实现或重启 smoldot 的网络服务。
    pub fn drain_finalized_subscriptions(&self) -> ContractFuture<'_, ()> {
        Box::pin(async move { self.running()?.rpc.drain_finalized_subscriptions().await })
    }

    pub fn status(&self) -> ContractFuture<'_, SmoldotProviderStatus> {
        Box::pin(async move {
            let running = self.running()?;
            let snapshot_future = {
                let client = running.client.lock();
                client
                    .chain_status_snapshot(running.chain_id)
                    .map_err(provider_error)?
            };
            let snapshot = snapshot_future.await.map_err(provider_error)?;
            Ok(SmoldotProviderStatus {
                lifecycle: ProviderLifecycle::Running,
                peer_count: snapshot.peer_count,
                is_syncing: snapshot.is_syncing,
                is_usable: snapshot.is_usable,
                best_block_number: snapshot.best_block_number,
                best_block_hash: snapshot.best_block_hash,
                verified_finalized_block_number: snapshot.current_verified_finalized_block_number,
                verified_finalized_block_hash: snapshot.current_verified_finalized_block_hash,
            })
        })
    }

    pub(crate) fn running(&self) -> ContractResult<Arc<RunningProvider>> {
        let state = self.lock_state()?;
        if state.lifecycle != ProviderLifecycle::Running {
            return Err(contract_error(
                ContractErrorCode::NotReady,
                "smoldot provider 尚未运行",
            ));
        }
        state.running.as_ref().cloned().ok_or_else(|| {
            contract_error(
                ContractErrorCode::Integrity,
                "Running provider 缺少 smoldot 实例",
            )
        })
    }

    pub(crate) fn runtime_handle(&self) -> tokio::runtime::Handle {
        self.runtime.handle().clone()
    }

    /// 在 provider 自有 Tokio runtime 上驱动 provider 或 Engine future。
    ///
    /// C ABI 的固定 worker 是普通 `std::thread`；它必须通过本入口执行可能使用
    /// `tokio::time` 的链 future，禁止改用 `futures::executor::block_on`。本入口只负责
    /// executor，不暴露 JSON-RPC、Client 或 Tokio handle。为避免嵌套 runtime panic，
    /// 已处于任意 Tokio context 的调用会 fail closed。
    pub fn drive<F>(&self, future: F) -> ContractResult<F::Output>
    where
        F: Future,
    {
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(contract_error(
                ContractErrorCode::InvalidState,
                "provider.drive 只能从非 Tokio 宿主线程调用",
            ));
        }
        Ok(self.runtime.block_on(future))
    }

    pub(crate) fn import_before_start(
        &self,
        imported: ExportedChainState,
    ) -> ContractResult<FinalizedBlockRef> {
        validate_import(&imported)?;
        let finalized = imported.finalized();
        let mut state = self.lock_state()?;
        if state.lifecycle != ProviderLifecycle::Created {
            return Err(contract_error(
                ContractErrorCode::InvalidState,
                "链状态只能在 provider 首次启动前导入",
            ));
        }
        if let Some(existing) = &state.pending_import {
            if existing == &imported {
                return Ok(finalized);
            }
            return Err(contract_error(
                ContractErrorCode::Conflict,
                "provider 已缓存另一份待导入链状态",
            ));
        }
        state.pending_import = Some(imported);
        Ok(finalized)
    }

    async fn start_inner(
        &self,
        pending_import: Option<&ExportedChainState>,
    ) -> ContractResult<Arc<RunningProvider>> {
        // 建议不具备信任权限；失败、超时或链身份不符时不采用建议，随包资产原值保留。
        let suggested = if self.config.bootstrap {
            crate::bootstrap::discover(&self.config.chain_spec)
                .await
                .ok()
        } else {
            None
        };
        let platform = DefaultPlatform::new(
            self.config.system_name.clone(),
            self.config.system_version.clone(),
        );
        let mut client = Client::new(platform);
        let max_pending_requests = NonZeroU32::new(MAX_PENDING_REQUESTS).ok_or_else(|| {
            contract_error(
                ContractErrorCode::Internal,
                "smoldot pending request 上限配置无效",
            )
        })?;
        let database = match pending_import {
            Some(imported) => std::str::from_utf8(imported.database()).map_err(|error| {
                contract_error(
                    ContractErrorCode::Decode,
                    format!("导入数据库不是 UTF-8 JSON: {error}"),
                )
            })?,
            None => "",
        };
        let added = client
            .add_chain(AddChainConfig {
                specification: suggested.as_deref().unwrap_or(&self.config.chain_spec),
                json_rpc: AddChainConfigJsonRpc::Enabled {
                    max_pending_requests,
                    max_subscriptions: MAX_SUBSCRIPTIONS,
                },
                potential_relay_chains: std::iter::empty(),
                database_content: database,
                user_data: (),
            })
            .map_err(|error| {
                contract_error(
                    ContractErrorCode::Integrity,
                    format!("smoldot 拒绝 CitizenChain 配置: {error:?}"),
                )
            })?;
        let AddChainSuccess {
            chain_id,
            json_rpc_responses,
        } = added;
        let responses = json_rpc_responses.ok_or_else(|| {
            contract_error(
                ContractErrorCode::Internal,
                "smoldot 未创建内部 JSON-RPC 响应流",
            )
        })?;
        let client = Arc::new(ParkingMutex::new(client));
        let rpc = LegacyRpc::new(
            Arc::clone(&client),
            chain_id,
            self.config.request_timeout,
            responses,
            self.runtime.handle(),
        );
        let running = Arc::new(RunningProvider {
            client,
            chain_id,
            rpc,
            runtime_contexts: ParkingMutex::new(RuntimeContexts::default()),
        });

        if let Err(error) = verify_started_identity(&running).await {
            Self::remove_running_chain(&running);
            return Err(error);
        }
        if let Some(imported) = pending_import {
            if let Err(error) = verify_import_startup(&running, imported.finalized()).await {
                Self::remove_running_chain(&running);
                return Err(error);
            }
        }
        Ok(running)
    }

    fn remove_running_chain(running: &RunningProvider) {
        let mut client = running.client.lock();
        #[allow(clippy::let_unit_value)]
        let _ = client.remove_chain(running.chain_id);
    }

    fn lock_state(&self) -> ContractResult<std::sync::MutexGuard<'_, ProviderState>> {
        self.state.lock().map_err(|_| {
            contract_error(
                ContractErrorCode::Internal,
                "smoldot provider lifecycle lock poisoned",
            )
        })
    }
}

fn validate_import(imported: &ExportedChainState) -> ContractResult<()> {
    if imported.identity() != &ChainIdentity::citizenchain() {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "导入链状态不属于 CitizenChain",
        ));
    }
    if imported.format_version() != CHAIN_STATE_FORMAT_VERSION {
        return Err(contract_error(
            ContractErrorCode::Unsupported,
            "导入链状态格式版本不受支持",
        ));
    }
    if imported.database().is_empty() || imported.database().len() > MAX_CHAIN_DATABASE_BYTES {
        return Err(contract_error(
            ContractErrorCode::InvalidArgument,
            "导入数据库必须非空且不超过 256 KiB",
        ));
    }
    if imported.finalized().number() == 0
        && imported.finalized().hash() != CITIZENCHAIN_GENESIS_HASH
    {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "高度 #0 的导入锚必须是 CitizenChain genesis",
        ));
    }
    let database: Value = serde_json::from_slice(imported.database()).map_err(|error| {
        contract_error(
            ContractErrorCode::Decode,
            format!("导入数据库不是有效 JSON: {error}"),
        )
    })?;
    if !database.is_object() {
        return Err(contract_error(
            ContractErrorCode::Decode,
            "导入数据库根必须是 JSON object",
        ));
    }
    Ok(())
}

async fn verify_started_identity(running: &RunningProvider) -> ContractResult<()> {
    let result = running
        .rpc
        .request("chainSpec_v1_genesisHash", Value::Array(Vec::new()))
        .await?;
    let genesis = crate::verified_chain_client::parse_hash_value(&result, "genesis hash")?;
    if genesis != CITIZENCHAIN_GENESIS_HASH {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "smoldot 解析出的 genesis hash 不是 CitizenChain",
        ));
    }
    Ok(())
}

async fn verify_import_startup(
    running: &RunningProvider,
    imported: FinalizedBlockRef,
) -> ContractResult<()> {
    let snapshot_future = {
        let client = running.client.lock();
        client
            .chain_status_snapshot(running.chain_id)
            .map_err(provider_error)?
    };
    let snapshot = snapshot_future.await.map_err(provider_error)?;
    if snapshot.startup_finalized_source != Some(StartupFinalizedSource::LocalDatabase)
        || snapshot.startup_finalized_block_number != Some(imported.number())
        || snapshot.startup_finalized_block_hash != Some(imported.hash().into_bytes())
        || snapshot.current_verified_finalized_block_number < imported.number()
    {
        return Err(contract_error(
            ContractErrorCode::Integrity,
            "smoldot 未从导入数据库的准确 finalized 锚启动",
        ));
    }
    Ok(())
}

pub(crate) fn contract_error(code: ContractErrorCode, message: impl Into<String>) -> ContractError {
    ContractError::new(code, message)
}

pub(crate) fn provider_error(message: impl Into<String>) -> ContractError {
    contract_error(ContractErrorCode::Network, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_SPEC: &str = r#"{
        "name":"CitizenChain",
        "id":"citizenchain",
        "protocolId":"citizenchain",
        "genesis":{"stateRootHash":"0x00"}
    }"#;

    #[test]
    fn config_fixes_chain_and_protocol_identity() {
        assert!(SmoldotProviderConfig::try_new(VALID_SPEC, "test", "1").is_ok());
        let wrong = VALID_SPEC.replace(
            "\"protocolId\":\"citizenchain\"",
            "\"protocolId\":\"other\"",
        );
        let Err(error) = SmoldotProviderConfig::try_new(wrong, "test", "1") else {
            panic!("wrong protocol must fail");
        };
        assert_eq!(error.code(), ContractErrorCode::Integrity);
    }

    #[test]
    fn owned_runtime_drives_future_from_plain_std_thread() {
        let Ok(config) = SmoldotProviderConfig::try_new(VALID_SPEC, "test", "1") else {
            panic!("valid provider config must parse");
        };
        let Ok(provider) = SmoldotVerifiedChainClient::new(config) else {
            panic!("provider runtime must start");
        };
        let worker = std::thread::spawn(move || provider.drive(async { 42_u64 }));
        let Ok(driven) = worker.join() else {
            panic!("worker must not panic");
        };
        let Ok(value) = driven else {
            panic!("provider runtime must drive the future");
        };
        assert_eq!(value, 42);
    }

    #[test]
    fn start_future_panic_converges_once_without_changing_ordinary_results() {
        let state = Mutex::new(ProviderState {
            lifecycle: ProviderLifecycle::Starting,
            running: None,
            pending_import: None,
        });
        // 正常结果和普通失败均由调用方既有分支处理，不能被误判为 panic。
        assert_eq!(
            futures::executor::block_on(converge_start_unwind(&state, async { 7_u8 })),
            7
        );
        assert_eq!(
            state.lock().expect("state lock").lifecycle,
            ProviderLifecycle::Starting
        );
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            futures::executor::block_on(converge_start_unwind(&state, async {
                panic!("injected HTTPS verifier panic")
            }))
        }));
        assert!(panic.is_err());
        assert_eq!(
            state.lock().expect("state lock").lifecycle,
            ProviderLifecycle::StartFailed
        );
    }
}
