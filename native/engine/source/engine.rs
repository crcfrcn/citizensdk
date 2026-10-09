use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use citizen_sdk_contracts::{
    store::{
        ChainDatabaseSnapshot, ChainDatabaseStore, EncryptedSecretBlobStore, RuntimeCacheStore,
        TransactionHistoryIndex, TransactionHistoryStore, WalletProfileStore,
        MAX_PERSISTED_RUNTIME_METADATA_BYTES,
    },
    AccountId32, AccountNonce, AccountNonceSource, CapabilityName, CapabilityReason,
    CapabilitySnapshot, ChainSigner, ChainSyncStatus, ContractError, ContractErrorCode,
    DefaultAccountChangeAuthorization, ExecutionConclusion, ExportedChainState,
    ExtrinsicWatchEvent, FinalizedAccountBalance, FinalizedBlockRef, Hash32, Modules,
    OpaqueTransactionCall, PreparedTransactionSummary, RuntimeContext, SecretBuffer, SecretVault,
    SignedExtrinsic, SigningCompletion, SigningIntent, Sr25519PublicKey, Sr25519Signature,
    StateImportReceipt, SubmittedExtrinsic, TransactionExecutionCompleted, TransactionExecutionId,
    TransactionPreparationId, UnverifiedReason, VerifiedBlockBody, VerifiedBlockHeader,
    VerifiedBlockRef, VerifiedChainClient, WalletProfile, WalletRecord, WalletSignMode,
    WalletState,
};
use zeroize::Zeroizing;

use crate::{
    capabilities::{CapabilityProbe, CapabilityTracker},
    error::EngineError,
    runtime_context::RuntimeContextCache,
    state_import::{
        validate_import_startup, validate_state_export, validate_state_import, EngineLifecycle,
        StateImportPolicy, StateImportRejection,
    },
    wallet_derivation::{SystemWalletEntropy, WalletWordCount},
    wallet_service::{
        PreparedWalletCreation, SigningService, SystemWalletClock, WalletPrivateKeyView,
        WalletService, WalletStateSnapshot,
    },
};

#[cfg(feature = "chain")]
use crate::{
    account_state::{AccountStateService, BestFeeSnapshot},
    finalized_history_runtime::{FinalizedHistoryRunGuard, FinalizedHistoryRuntime},
    system_events::SYSTEM_EVENTS_STORAGE_KEY,
    transaction_execution::{persist_submit_and_verify_exact, TransactionExecutionCancellation},
    transaction_history::TransactionHistoryService,
    transaction_outcome::{verify_transaction_outcome, TransactionEvidence},
    transaction_prepare::{
        build_prepared_transaction, PreparedTransaction, PreparedTransactionRegistry,
    },
};

/// Engine async return type; the embedding layer chooses the executor.
pub type EngineFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, EngineError>> + Send + 'a>>;

/// Typed providers and stores available in one host composition.
///
/// 每个实例只组合实际启用的模块；链与钱包都可以缺席，绝不注入假 provider。
/// 完整装配与单模块装配使用同一实现，模块选择和组件存在性共同约束能力快照。
pub struct EngineComponents {
    chain_client: Option<Arc<dyn VerifiedChainClient>>,
    modules: Modules,
    signer: Option<Arc<dyn ChainSigner>>,
    secret_vault: Option<Arc<dyn SecretVault>>,
    chain_database: Option<Arc<dyn ChainDatabaseStore>>,
    runtime_cache: Option<Arc<dyn RuntimeCacheStore>>,
    wallet_profiles: Option<Arc<dyn WalletProfileStore>>,
    transaction_history: Option<Arc<dyn TransactionHistoryStore>>,
    encrypted_secrets: Option<Arc<dyn EncryptedSecretBlobStore>>,
    account_nonce_source: Option<Arc<dyn AccountNonceSource>>,
}

impl EngineComponents {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        chain_client: Option<Arc<dyn VerifiedChainClient>>,
        signer: Option<Arc<dyn ChainSigner>>,
        secret_vault: Option<Arc<dyn SecretVault>>,
        chain_database: Option<Arc<dyn ChainDatabaseStore>>,
        runtime_cache: Option<Arc<dyn RuntimeCacheStore>>,
        wallet_profiles: Option<Arc<dyn WalletProfileStore>>,
        transaction_history: Option<Arc<dyn TransactionHistoryStore>>,
        encrypted_secrets: Option<Arc<dyn EncryptedSecretBlobStore>>,
    ) -> Self {
        Self {
            chain_client,
            modules: Modules::full(),
            signer,
            secret_vault,
            chain_database,
            runtime_cache,
            wallet_profiles,
            transaction_history,
            encrypted_secrets,
            account_nonce_source: None,
        }
    }

    /// 实例模块选择只在创建期间固定，运行时不得绕过资源边界动态启用。
    pub fn with_modules(mut self, modules: Modules) -> Self {
        self.modules = modules;
        self
    }

    pub const fn modules(&self) -> Modules {
        self.modules
    }

    /// 注入绑定准确 best Runtime 的 CitizenChain AccountNonceApi provider。
    ///
    /// 该 API 不是交易池感知 nonce；钱包广播安全由历史仓储中同账户 durable
    /// single-flight pending CAS 门保证；没有该 provider 时不开放钱包交易构造。
    pub fn with_account_nonce_source(
        mut self,
        account_nonce_source: Arc<dyn AccountNonceSource>,
    ) -> Self {
        self.account_nonce_source = Some(account_nonce_source);
        self
    }

    pub(crate) fn chain_client(&self) -> Result<&Arc<dyn VerifiedChainClient>, EngineError> {
        if !self.modules.contains(Modules::CHAIN) {
            return Err(component_missing("chain_module"));
        }
        self.chain_client
            .as_ref()
            .ok_or_else(|| component_missing("chain_client"))
    }

    pub(crate) fn runtime_cache(&self) -> Option<&Arc<dyn RuntimeCacheStore>> {
        self.runtime_cache.as_ref()
    }

    pub(crate) fn chain_database(&self) -> Option<&Arc<dyn ChainDatabaseStore>> {
        self.chain_database.as_ref()
    }

    pub(crate) fn signer(&self) -> Option<&Arc<dyn ChainSigner>> {
        self.signer.as_ref()
    }

    pub(crate) fn secret_vault(&self) -> Option<&Arc<dyn SecretVault>> {
        self.secret_vault.as_ref()
    }

    pub(crate) fn wallet_profiles(&self) -> Option<&Arc<dyn WalletProfileStore>> {
        self.wallet_profiles.as_ref()
    }

    pub(crate) fn transaction_history(&self) -> Option<&Arc<dyn TransactionHistoryStore>> {
        self.transaction_history.as_ref()
    }

    pub(crate) fn encrypted_secrets(&self) -> Option<&Arc<dyn EncryptedSecretBlobStore>> {
        self.encrypted_secrets.as_ref()
    }

    pub(crate) fn account_nonce_source(&self) -> Option<&Arc<dyn AccountNonceSource>> {
        self.account_nonce_source.as_ref()
    }

    /// 是否注入了任何 SDK 热钱包交易栈组件。
    ///
    /// 只要宿主开始组合钱包能力，原始 signed-extrinsic 提交入口就必须服从
    /// pending-before-broadcast 合同，不能因组件只装配了一部分而退回无历史旁路。
    /// nonce provider 只读取公开链状态，不属于秘密组件；纯链提交不能因此被误判为钱包。
    fn has_any_wallet_transaction_component(&self) -> bool {
        self.signer.is_some()
            || self.secret_vault.is_some()
            || self.wallet_profiles.is_some()
            || self.encrypted_secrets.is_some()
    }

    fn enforce_component_presence(&self, probes: &mut [CapabilityProbe]) {
        for probe in probes {
            let (compiled, selected, present) = match probe.name {
                CapabilityName::WalletProfile => (
                    cfg!(feature = "wallet"),
                    self.modules.contains(Modules::WALLET),
                    self.wallet_profiles.is_some(),
                ),
                CapabilityName::LocalSigning => (
                    cfg!(feature = "signing"),
                    self.modules.contains(Modules::SIGNING),
                    self.signer.is_some()
                        && self.secret_vault.is_some()
                        && self.wallet_profiles.is_some()
                        && self.encrypted_secrets.is_some(),
                ),
                CapabilityName::HardwareVault | CapabilityName::UserAuthentication => (
                    cfg!(feature = "wallet") || cfg!(feature = "signing"),
                    self.modules.bits() & (Modules::WALLET | Modules::SIGNING) != 0,
                    self.secret_vault.is_some(),
                ),
                CapabilityName::History => (
                    cfg!(feature = "history"),
                    self.modules.contains(Modules::HISTORY),
                    self.chain_client.is_some() && self.transaction_history.is_some(),
                ),
                CapabilityName::BackgroundSync => (
                    cfg!(feature = "history"),
                    self.modules.contains(Modules::HISTORY),
                    self.chain_client.is_some()
                        && self.chain_database.is_some()
                        && self.transaction_history.is_some(),
                ),
                CapabilityName::TransactionBuild => (
                    cfg!(feature = "transactions"),
                    self.modules.contains(Modules::TRANSACTIONS),
                    self.chain_client.is_some() && self.account_nonce_source.is_some(),
                ),
                CapabilityName::TransactionSubmit | CapabilityName::TransactionVerify => (
                    cfg!(feature = "transactions"),
                    self.modules.contains(Modules::TRANSACTIONS),
                    self.chain_client.is_some(),
                ),
                CapabilityName::ChainRead => (
                    cfg!(feature = "chain"),
                    self.modules.contains(Modules::CHAIN),
                    self.chain_client.is_some(),
                ),
            };
            probe.supported &= compiled;
            if !selected {
                // 实例选择与资源就绪分开：未选模块才关闭 enabled。
                probe.enabled = false;
                probe.runtime_ready = false;
                probe.not_ready_reason = Some(CapabilityReason::HostDisabled);
            } else if !present {
                // 例如纯链交易模块能提交外部签名交易，但无金库时不能构造本地钱包交易。
                probe.runtime_ready = false;
                probe.not_ready_reason = Some(CapabilityReason::DependencyNotReady);
            }
        }
    }
}

/// Product-independent CitizenSDK Core Engine.
pub struct CitizenEngine {
    components: EngineComponents,
    runtime_contexts: Mutex<RuntimeContextCache>,
    capabilities: Mutex<EngineCapabilityState>,
    state: Arc<Mutex<EngineState>>,
    chain_monitor: Mutex<crate::chain_monitor::ChainMonitorState>,
    /// Non-persistent, instance-scoped transaction preparations. Entries contain no wallet secret.
    #[cfg(feature = "chain")]
    prepared_transactions: Mutex<PreparedTransactionRegistry>,
    /// Claimed cold-sign executions; each value is the sole owner of its frozen signer material.
    #[cfg(feature = "chain")]
    transaction_executions: Mutex<HashMap<TransactionExecutionId, ClaimedTransactionExecution>>,
}

#[cfg(feature = "chain")]
struct ClaimedTransactionExecution {
    preparation_id: TransactionPreparationId,
    prepared: PreparedTransaction,
}

/// Engine completion of `execute`: hot accounts are terminal, cold accounts expose only an
/// adapter-ready intent which the FFI immediately binds to the existing QR_V1 session store.
#[derive(Clone, Debug)]
pub enum TransactionExecutionStart {
    Completed(TransactionExecutionCompleted),
    ExternalSigning {
        execution_id: TransactionExecutionId,
        source_account_id: AccountId32,
        call_data_hash: Hash32,
        action: u16,
        intent: SigningIntent,
    },
}

#[derive(Default)]
struct EngineCapabilityState {
    tracker: CapabilityTracker,
    /// 已完成宿主组件过滤、尚未叠加 Engine 生命周期的原始事实。
    base_probes: Option<Vec<CapabilityProbe>>,
}

#[derive(Debug)]
struct EngineState {
    lifecycle: EngineLifecycle,
    generation: u64,
    provisional_import: Option<FinalizedBlockRef>,
    verified_finalized: Option<FinalizedBlockRef>,
    export_in_progress: bool,
    /// 已取得生命周期租约、尚未完成全部 provider/store await 的历史操作数。
    ///
    /// finalized 历史的一次原子提交可能跨越多个 await。stop/dispose 只有在这里为
    /// 0 时才能切换代际，从而保证最后一个 CAS 也不能穿越 Engine 停止边界。
    inflight_history_operations: u64,
    /// 内部安全查看从登记到 UI/认证双排空的租约；普通请求完成不能替代它。
    private_key_views: u64,
    /// QR 审阅/认证期间保持原 Engine 代际，停止必须等待真实 await 排空。
    qr_operations: u64,
    /// 历史读取准入；停止节点后也保持暂停，不能兼作本地钱包操作互斥。
    history_paused: bool,
    /// 仅标记正在排空/执行的钱包变更；与链是否运行无关。
    wallet_mutation_in_progress: bool,
    history_cancel: Arc<crate::chain_monitor::MonitorCancellation>,
    history_drain_waiters: Vec<std::task::Waker>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            lifecycle: EngineLifecycle::Created,
            generation: 0,
            provisional_import: None,
            verified_finalized: None,
            export_in_progress: false,
            inflight_history_operations: 0,
            private_key_views: 0,
            qr_operations: 0,
            history_paused: false,
            wallet_mutation_in_progress: false,
            history_cancel: Arc::new(crate::chain_monitor::MonitorCancellation::default()),
            history_drain_waiters: Vec::new(),
        }
    }
}

impl CitizenEngine {
    /// SDK 内部 SPI：仅登记受控查看，不暴露普通账户秘密读取能力。
    #[doc(hidden)]
    pub fn internal_private_key_view(
        &self,
        account_id: AccountId32,
        private_key_view_vault: Option<Arc<dyn SecretVault>>,
    ) -> Result<Arc<InternalPrivateKeyView>, EngineError> {
        if !cfg!(feature = "wallet") || !self.components.modules.contains(Modules::WALLET) {
            return Err(EngineError::contract(
                ContractErrorCode::Unsupported,
                "安全查看要求 wallet 模块",
            ));
        }
        // FFI 只从本实例原 HostBridge 构造专属观察器金库；不是业务可注入的秘密 API。
        let service = self
            .wallet_service_from_components()?
            .with_private_key_view_vault(private_key_view_vault);
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if !matches!(
            state.lifecycle,
            EngineLifecycle::Created | EngineLifecycle::Running | EngineLifecycle::Stopped
        ) || state.private_key_views != 0
        {
            return Err(EngineError::contract(
                ContractErrorCode::Conflict,
                "实例不处于稳定生命周期或已有安全查看",
            ));
        }
        state.private_key_views += 1;
        let lease = EnginePrivateKeyViewLease {
            state: Arc::clone(&self.state),
            generation: state.generation,
        };
        Ok(Arc::new(InternalPrivateKeyView {
            service,
            account_id,
            lease: Mutex::new(Some(lease)),
            state: Mutex::new(InternalPrivateKeyViewState::default()),
        }))
    }

    pub fn new(components: EngineComponents) -> Self {
        Self {
            components,
            runtime_contexts: Mutex::new(RuntimeContextCache::new()),
            capabilities: Mutex::new(EngineCapabilityState::default()),
            state: Arc::new(Mutex::new(EngineState::default())),
            chain_monitor: Mutex::new(crate::chain_monitor::ChainMonitorState::default()),
            #[cfg(feature = "chain")]
            prepared_transactions: Mutex::new(PreparedTransactionRegistry::default()),
            #[cfg(feature = "chain")]
            transaction_executions: Mutex::new(HashMap::new()),
        }
    }

    /// Atomically replace host/provider capability facts. Revision ownership
    /// remains inside the Engine so bindings cannot create divergent counters.
    pub fn update_capabilities(
        &self,
        mut probes: Vec<CapabilityProbe>,
    ) -> Result<CapabilitySnapshot, EngineError> {
        self.components.enforce_component_presence(&mut probes);
        // 所有同时观察 lifecycle/capabilities 的路径统一按 state -> capabilities
        // 加锁，避免 stop/dispose 与宿主 probe 更新交错后发布过期的 Running 快照。
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        let effective = probes_for_lifecycle(probes.clone(), state.lifecycle);
        let mut capabilities = self
            .capabilities
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        let snapshot = capabilities.tracker.update(effective)?;
        capabilities.base_probes = Some(probes);
        Ok(snapshot)
    }

    /// 公开链查询仅刷新真实 provider 就绪事实，不重新读取无关钱包/历史仓储。
    /// 其余原始 probe 保留；模块、组件和 lifecycle 仍经过与全量刷新相同的门。
    pub fn update_chain_readiness(
        &self,
        runtime_ready: bool,
    ) -> Result<CapabilitySnapshot, EngineError> {
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        let mut capabilities = self
            .capabilities
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        let mut probes = capabilities.base_probes.clone().ok_or_else(|| {
            EngineError::CapabilityUnavailable(
                "capability state has not been established".to_owned(),
            )
        })?;
        let chain_read = probes
            .iter_mut()
            .find(|probe| probe.name == CapabilityName::ChainRead)
            .ok_or_else(|| {
                EngineError::CapabilityUnavailable("chain capability is missing".to_owned())
            })?;
        chain_read.runtime_ready = runtime_ready;
        chain_read.not_ready_reason = (!runtime_ready).then_some(CapabilityReason::ChainUnsynced);
        self.components.enforce_component_presence(&mut probes);
        let snapshot = capabilities
            .tracker
            .update(probes_for_lifecycle(probes.clone(), state.lifecycle))?;
        capabilities.base_probes = Some(probes);
        Ok(snapshot)
    }

    pub fn capabilities(&self) -> Result<Option<CapabilitySnapshot>, EngineError> {
        let _state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        Ok(self
            .capabilities
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .tracker
            .current()
            .cloned())
    }

    /// Current Engine-owned lifecycle. Bindings may observe it but cannot set
    /// it to bypass state import gates.
    pub fn lifecycle(&self) -> Result<EngineLifecycle, EngineError> {
        Ok(self
            .state
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .lifecycle)
    }

    /// 返回 SDK 固定链身份中的 genesis_hash，不调用 provider、网络或钱包仓储。
    ///
    /// 静态链身份不依赖 Running 或同步就绪，但仍要求已编译、已选择 chain 模块，
    /// 且实例没有销毁；不能借此为未启用链功能的实例开放另一条链入口。
    pub fn genesis_hash(&self) -> Result<Hash32, EngineError> {
        if !cfg!(feature = "chain") || !self.components.modules.contains(Modules::CHAIN) {
            return Err(EngineError::contract(
                ContractErrorCode::Unsupported,
                "genesis_hash requires the compiled and selected chain module",
            ));
        }
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle == EngineLifecycle::Disposed {
            return Err(lifecycle_error("genesis_hash requires a live Engine"));
        }
        Ok(citizen_sdk_contracts::ChainIdentity::citizenchain().genesis_hash())
    }

    /// Read the provider's verified best head through the Engine capability
    /// and lifecycle gate. Bindings must use this method instead of retaining
    /// or exposing the provider itself.
    pub fn best_head(&self) -> EngineFuture<'_, VerifiedBlockRef> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_best_head()
                .await
                .map_err(EngineError::from)
        })
    }

    /// Read the provider's independently verified finalized head.
    pub fn finalized_head(&self) -> EngineFuture<'_, FinalizedBlockRef> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_finalized_head()
                .await
                .map_err(EngineError::from)
        })
    }

    /// 运行中的轻节点即使尚未同步，也必须能报告真实状态；不能用数据就绪门禁
    /// 阻止读取is_usable本身。模块/宿主准入保留，余额与交易仍走原完整就绪检查。
    pub fn chain_sync_status(&self) -> EngineFuture<'_, ChainSyncStatus> {
        Box::pin(async move {
            self.require_running_capability_admission(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_sync_status()
                .await
                .map_err(EngineError::from)
        })
    }

    /// Resolve one height through the provider's verified finalized ancestry.
    pub fn finalized_block_at(&self, number: u64) -> EngineFuture<'_, FinalizedBlockRef> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_finalized_block_at(number)
                .await
                .map_err(EngineError::from)
        })
    }

    /// Prove that a caller-supplied hash/height pair is the finalized canonical block.
    pub fn resolve_finalized_block(
        &self,
        hash: Hash32,
        number: u64,
    ) -> EngineFuture<'_, FinalizedBlockRef> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .resolve_finalized_block(hash, number)
                .await
                .map_err(EngineError::from)
        })
    }

    /// Read and cryptographically bind the decoded header to one exact verified block.
    pub fn block_header_at(
        &self,
        block: VerifiedBlockRef,
    ) -> EngineFuture<'_, VerifiedBlockHeader> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_block_header_at(block)
                .await
                .map_err(EngineError::from)
        })
    }

    /// Read the ordered opaque extrinsics of one exact verified block.
    pub fn block_body_at(&self, block: VerifiedBlockRef) -> EngineFuture<'_, VerifiedBlockBody> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_block_body_at(block)
                .await
                .map_err(EngineError::from)
        })
    }

    /// Read one storage key at one exact, provider-verified block.
    pub fn storage_at(
        &self,
        block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> EngineFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_storage_at(block, key)
                .await
                .map_err(EngineError::from)
        })
    }

    /// Read a batch of storage keys at one exact block while preserving input
    /// order and duplicate entries.
    pub fn storage_batch_at(
        &self,
        block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> EngineFuture<'_, Vec<Option<Vec<u8>>>> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_storage_batch_at(block, keys)
                .await
                .map_err(EngineError::from)
        })
    }

    /// 读取一个准确 finalized 块上的有界 storage key 页面。
    pub fn storage_keys_paged(
        &self,
        block: FinalizedBlockRef,
        prefix: Vec<u8>,
        start_key: Option<Vec<u8>>,
        limit: u32,
    ) -> EngineFuture<'_, Vec<Vec<u8>>> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_storage_keys_paged(block, prefix, start_key, limit)
                .await
                .map_err(EngineError::from)
        })
    }

    /// 在一个准确 verified block 上执行 opaque Runtime API。
    pub fn call_runtime_api(
        &self,
        block: VerifiedBlockRef,
        method: String,
        arguments: Vec<u8>,
    ) -> EngineFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .call_runtime_api(block, method, arguments)
                .await
                .map_err(EngineError::from)
        })
    }

    /// Return raw finalized `System.Events` bytes. Event decoding and all product semantics stay
    /// in the integrating application; the SDK only fixes the protocol storage key and anchor.
    #[cfg(feature = "chain")]
    pub fn finalized_system_events_at(
        &self,
        block: FinalizedBlockRef,
    ) -> EngineFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            self.components
                .chain_client()?
                .get_finalized_storage_at(block, SYSTEM_EVENTS_STORAGE_KEY.to_vec())
                .await
                .map_err(EngineError::from)
        })
    }

    /// 从准确 finalized `System.Account` 读取一个账户的公开余额。
    #[cfg(feature = "chain")]
    pub fn finalized_account_balance(
        &self,
        account_id: AccountId32,
    ) -> EngineFuture<'_, FinalizedAccountBalance> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            AccountStateService::new(
                self.components.chain_client()?.as_ref(),
                self.components
                    .account_nonce_source()
                    .map(|source| source.as_ref()),
            )
            .finalized_account_balance(account_id)
            .await
        })
    }

    /// 批量余额保持输入顺序和重复项，底层只请求去重后的 storage key。
    #[cfg(feature = "chain")]
    pub fn finalized_account_balances(
        &self,
        account_ids: Vec<AccountId32>,
    ) -> EngineFuture<'_, Vec<FinalizedAccountBalance>> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            AccountStateService::new(
                self.components.chain_client()?.as_ref(),
                self.components
                    .account_nonce_source()
                    .map(|source| source.as_ref()),
            )
            .finalized_account_balances(account_ids)
            .await
        })
    }

    /// 读取绑定准确 best Runtime 的链 nonce；同账户并发由 durable pending 门串行化。
    #[cfg(feature = "chain")]
    pub fn account_next_index(&self, account_id: AccountId32) -> EngineFuture<'_, AccountNonce> {
        Box::pin(async move {
            // 公开链 nonce 读取不接触私钥，不能要求交易构造或钱包模块。
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            AccountStateService::new(
                self.components.chain_client()?.as_ref(),
                self.components
                    .account_nonce_source()
                    .map(|source| source.as_ref()),
            )
            .account_next_index(account_id)
            .await
        })
    }

    /// Prepare one application-owned opaque RuntimeCall without reading or using any wallet key.
    ///
    /// The preparation is non-persistent, instance-bound and single-use. One source account may
    /// have only one in-flight or prepared entry; unrelated source accounts remain concurrent.
    #[cfg(feature = "chain")]
    pub fn prepare_transaction(
        &self,
        source_account_id: AccountId32,
        call_data: Vec<u8>,
    ) -> EngineFuture<'_, PreparedTransactionSummary> {
        let preparation = (|| {
            self.require_capabilities(&[
                CapabilityName::ChainRead,
                CapabilityName::TransactionBuild,
            ])?;
            let call = OpaqueTransactionCall::try_new(call_data)?;
            let generation = {
                let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                if state.lifecycle != EngineLifecycle::Running {
                    return Err(lifecycle_error(
                        "transaction preparation requires a running Engine generation",
                    ));
                }
                state.generation
            };
            let preparation_id = self
                .prepared_transactions
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?
                .reserve(source_account_id)?;
            Ok((
                call,
                generation,
                preparation_id,
                Arc::clone(self.components.chain_client()?),
                Arc::clone(self.components.account_nonce_source().ok_or_else(|| {
                    EngineError::CapabilityUnavailable("account_nonce_source_missing".to_owned())
                })?),
            ))
        })();
        Box::pin(async move {
            let (call, generation, preparation_id, chain_client, nonce_source) = preparation?;
            let built = build_prepared_transaction(
                chain_client.as_ref(),
                nonce_source.as_ref(),
                preparation_id,
                generation,
                source_account_id,
                call,
            )
            .await;
            let prepared = match built {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.prepared_transactions
                        .lock()
                        .map_err(|_| EngineError::StatePoisoned)?
                        .release_reservation(source_account_id, preparation_id);
                    return Err(error);
                }
            };
            let current = {
                let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                state.lifecycle == EngineLifecycle::Running
                    && state.generation == generation
                    && prepared.generation() == generation
            };
            if !current {
                self.prepared_transactions
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?
                    .release_reservation(source_account_id, preparation_id);
                return Err(EngineError::contract(
                    ContractErrorCode::Conflict,
                    "transaction preparation outlived its Engine generation",
                ));
            }
            let mut registry = self
                .prepared_transactions
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?;
            let result = registry.commit(source_account_id, preparation_id, prepared);
            if result.is_err() {
                registry.release_reservation(source_account_id, preparation_id);
            }
            result
        })
    }

    /// Cancel one instance-owned preparation. Unknown or already-consumed identities fail closed.
    #[cfg(feature = "chain")]
    pub fn cancel_prepared_transaction(
        &self,
        preparation_id: TransactionPreparationId,
    ) -> Result<(), EngineError> {
        #[cfg(feature = "chain")]
        self.prepared_transactions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .cancel(preparation_id)
            .map(|_| ())
            .ok_or_else(|| {
                EngineError::contract(
                    ContractErrorCode::NotFound,
                    "transaction preparation 不存在、已取消或已失效",
                )
            })
    }

    /// Atomically consume one preparation and run the generic hot/cold execution closure.
    #[cfg(feature = "chain")]
    pub fn execute_prepared_transaction(
        &self,
        preparation_id: TransactionPreparationId,
    ) -> EngineFuture<'_, TransactionExecutionStart> {
        let claimed = (|| {
            self.require_capabilities(&[
                CapabilityName::ChainRead,
                CapabilityName::TransactionBuild,
                CapabilityName::TransactionSubmit,
                CapabilityName::TransactionVerify,
                CapabilityName::History,
                CapabilityName::WalletProfile,
            ])?;
            let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if state.lifecycle != EngineLifecycle::Running {
                return Err(lifecycle_error(
                    "transaction execution requires a running Engine generation",
                ));
            }
            let generation = state.generation;
            drop(state);
            let prepared = self
                .prepared_transactions
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?
                .claim(preparation_id)
                .ok_or_else(|| {
                    EngineError::contract(
                        ContractErrorCode::NotFound,
                        "transaction preparation 不存在或已经消费",
                    )
                })?;
            Ok((generation, prepared))
        })();
        Box::pin(async move {
            let (generation, prepared) = claimed?;
            let summary = prepared.summary();
            let source = summary.source_account_id();
            let result = async {
                // 准备阶段已冻结同一准确块的 Runtime、nonce 和待签字节。
                // 执行只消费这一份结果；账户并发门及验签继续生效，不再联网重建或换 nonce。
                let execution_is_current = {
                    let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                    state.lifecycle == EngineLifecycle::Running
                        && state.generation == generation
                        && prepared.generation() == generation
                };
                if !execution_is_current {
                    return Err(EngineError::contract(
                        ContractErrorCode::Conflict,
                        "transaction execution outlived its Engine generation",
                    ));
                }
                let sign_mode = self.wallet_account_sign_mode(source).await?;
                self.history_service_from_components()?
                    .preflight_execution_before_signing(
                        source,
                        prepared.call_data().len(),
                        prepared.signed_extrinsic_len(),
                    )
                    .await?;
                let execution_id = next_transaction_execution_id(&self.transaction_executions)?;
                let intent = prepared.signing_intent()?;
                match sign_mode {
                    Some(WalletSignMode::Hot) => {
                        let completion = self.sign_wallet_intent(intent).await?;
                        if completion.account_id() != source
                            || completion.payload_hash()
                                != prepared.signing_intent()?.payload_hash()?
                        {
                            return Err(EngineError::contract(
                                ContractErrorCode::Integrity,
                                "热签完成值与冻结交易不一致",
                            ));
                        }
                        let completed = self
                            .complete_claimed_transaction(
                                execution_id,
                                preparation_id,
                                prepared,
                                completion.signature(),
                                None,
                            )
                            .await?;
                        Ok(TransactionExecutionStart::Completed(completed))
                    }
                    Some(WalletSignMode::Cold) => {
                        let action = prepared.external_action()?;
                        self.transaction_executions
                            .lock()
                            .map_err(|_| EngineError::StatePoisoned)?
                            .insert(
                                execution_id,
                                ClaimedTransactionExecution {
                                    preparation_id,
                                    prepared,
                                },
                            );
                        Ok(TransactionExecutionStart::ExternalSigning {
                            execution_id,
                            source_account_id: source,
                            call_data_hash: summary.call_data_hash(),
                            action,
                            intent,
                        })
                    }
                    None => Err(EngineError::contract(
                        ContractErrorCode::NotFound,
                        "transaction source 不存在于 WalletState",
                    )),
                }
            }
            .await;
            if result.is_err() {
                self.prepared_transactions
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?
                    .finish(source, preparation_id);
            }
            result
        })
    }

    /// Continue one claimed cold execution after the QR_V1 adapter verified its exact response.
    #[cfg(feature = "chain")]
    pub fn complete_external_transaction_execution(
        &self,
        execution_id: TransactionExecutionId,
        signature: Sr25519Signature,
        cancellation: TransactionExecutionCancellation,
    ) -> EngineFuture<'_, TransactionExecutionCompleted> {
        let claimed = self
            .transaction_executions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)
            .and_then(|mut executions| {
                executions.remove(&execution_id).ok_or_else(|| {
                    EngineError::contract(
                        ContractErrorCode::NotFound,
                        "transaction execution 不存在或已经消费",
                    )
                })
            });
        Box::pin(async move {
            let claimed = claimed?;
            let source = claimed.prepared.summary().source_account_id();
            let preparation_id = claimed.preparation_id;
            let result = self
                .complete_claimed_transaction(
                    execution_id,
                    preparation_id,
                    claimed.prepared,
                    signature,
                    Some(&cancellation),
                )
                .await;
            if result.is_err() {
                self.prepared_transactions
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?
                    .finish(source, preparation_id);
            }
            result
        })
    }

    /// Cancel only a not-yet-persisted cold execution. Durable/broadcast facts are never removed.
    #[cfg(feature = "chain")]
    pub fn cancel_transaction_execution(
        &self,
        execution_id: TransactionExecutionId,
    ) -> Result<(), EngineError> {
        let claimed = self
            .transaction_executions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .remove(&execution_id)
            .ok_or_else(|| {
                EngineError::contract(
                    ContractErrorCode::NotFound,
                    "transaction execution 不存在、已消费或已广播",
                )
            })?;
        self.prepared_transactions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .finish(
                claimed.prepared.summary().source_account_id(),
                claimed.preparation_id,
            );
        Ok(())
    }

    #[cfg(feature = "chain")]
    async fn complete_claimed_transaction(
        &self,
        execution_id: TransactionExecutionId,
        preparation_id: TransactionPreparationId,
        prepared: PreparedTransaction,
        signature: Sr25519Signature,
        cancellation: Option<&TransactionExecutionCancellation>,
    ) -> Result<TransactionExecutionCompleted, EngineError> {
        let summary = prepared.summary();
        let source = summary.source_account_id();
        let call_data = prepared.call_data().to_vec();
        let runtime = prepared.runtime_context().clone();
        let genesis_hash = prepared.identity().genesis_hash();
        let nonce = prepared.nonce().value();
        let signer = self
            .components
            .signer()
            .cloned()
            .ok_or_else(|| component_missing("chain_signer"))?;
        let build = prepared
            .complete_with_signature(signer.as_ref(), signature)
            .await?;
        let result = persist_submit_and_verify_exact(
            self.components.chain_client()?.as_ref(),
            &self.history_service_from_components()?,
            execution_id,
            source,
            summary.call_data_hash(),
            call_data,
            summary.best_block(),
            runtime,
            genesis_hash,
            nonce,
            build.extrinsic().clone(),
            cancellation,
        )
        .await;
        self.prepared_transactions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .finish(source, preparation_id);
        result
    }

    /// 从同一准确 best Runtime metadata 解码费率、最低费和存在性存款。
    #[cfg(feature = "chain")]
    pub fn best_fee_snapshot(&self) -> EngineFuture<'_, BestFeeSnapshot> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            AccountStateService::new(
                self.components.chain_client()?.as_ref(),
                self.components
                    .account_nonce_source()
                    .map(|source| source.as_ref()),
            )
            .best_fee_snapshot()
            .await
        })
    }

    /// 读取不含秘密的钱包公开资料；轻节点尚未启动时也可使用本机钱包能力。
    pub fn wallet_profile(&self) -> EngineFuture<'_, Option<WalletProfile>> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.profile().await })
    }

    /// 稳定冷热目录、初始化和待清理事实共享同一读取，不把读取失败合成为空钱包。
    pub fn wallet_state(&self) -> EngineFuture<'_, WalletStateSnapshot> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.state().await })
    }

    /// 公开付款选择不需要签名/金库就绪；修订检查和写入由唯一钱包服务负责。
    /// 诊断快照引用由绑定层验证实例归属；Engine再比对当前修订和完整原记录。
    pub fn repair_hot_wallet(
        &self,
        expected_revision: u64,
        record: WalletRecord,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::LocalSigning,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move {
            let state = self
                .with_wallet_monitor_paused(service?.repair_hot_wallet(expected_revision, &record))
                .await?;
            WalletStateSnapshot::from_state(&state)
        })
    }
    pub fn rename_diagnostic_wallet(
        &self,
        expected_revision: u64,
        record: WalletRecord,
        name: String,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            let state = service?
                .rename_diagnostic_wallet(expected_revision, &record, &name)
                .await?;
            WalletStateSnapshot::from_state(&state)
        })
    }
    pub fn delete_diagnostic_wallet(
        &self,
        expected_revision: u64,
        record: WalletRecord,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        let required: &[CapabilityName] = if matches!(record, WalletRecord::Profile { .. }) {
            &[CapabilityName::WalletProfile, CapabilityName::HardwareVault]
        } else {
            &[CapabilityName::WalletProfile]
        };
        let service = self.local_wallet_service(required);
        Box::pin(async move {
            let state = self
                .with_wallet_monitor_paused(
                    service?.delete_diagnostic_wallet(expected_revision, &record),
                )
                .await?;
            WalletStateSnapshot::from_state(&state)
        })
    }

    pub fn set_active_wallet(
        &self,
        expected_revision: u64,
        wallet_index: u32,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            let state = service?
                .set_active_wallet(expected_revision, wallet_index)
                .await?;
            WalletStateSnapshot::from_state(&state)
        })
    }

    /// 钱包级改名不借用账户改名，不触碰账户身份、默认顺序或密钥。
    pub fn rename_wallet(
        &self,
        expected_revision: u64,
        wallet_index: u32,
        name: String,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            let state = service?
                .rename_wallet(expected_revision, wallet_index, &name)
                .await?;
            WalletStateSnapshot::from_state(&state)
        })
    }

    pub fn import_cold_wallet_account(
        &self,
        account_id: AccountId32,
        name: String,
    ) -> EngineFuture<'_, citizen_sdk_contracts::ColdWalletAccount> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.import_cold_account(account_id, &name).await })
    }

    pub fn import_cold_wallet_ss58(
        &self,
        ss58_address: String,
        name: String,
    ) -> EngineFuture<'_, citizen_sdk_contracts::ColdWalletAccount> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            service?
                .import_cold_ss58_account(&ss58_address, &name)
                .await
        })
    }

    /// 面向公开绑定的唯一普通重排入口：revision 必须匹配，且第一项保持不变。
    pub fn reorder_wallet_accounts_without_default_change(
        &self,
        expected_revision: u64,
        ordered_account_ids: Vec<AccountId32>,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            let state = service?
                .reorder_accounts_without_default_change(expected_revision, ordered_account_ids)
                .await?;
            WalletStateSnapshot::from_state(&state)
        })
    }

    pub fn rename_cold_wallet_account(
        &self,
        account_id: AccountId32,
        name: String,
    ) -> EngineFuture<'_, citizen_sdk_contracts::ColdWalletAccount> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.rename_cold_account(account_id, &name).await })
    }

    pub fn delete_cold_wallet_account(&self, account_id: AccountId32) -> EngineFuture<'_, ()> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.delete_cold_account(account_id).await })
    }

    /// 统一账户改名；账户类型只决定底层公开事实所在位置，不改变业务调用形状。
    pub fn rename_wallet_account_any(
        &self,
        account_id: AccountId32,
        name: String,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        Box::pin(async move {
            match self.wallet_account_sign_mode(account_id).await? {
                Some(WalletSignMode::Hot) => {
                    self.rename_wallet_account(account_id, name).await?;
                }
                Some(WalletSignMode::Cold) => {
                    self.rename_cold_wallet_account(account_id, name).await?;
                }
                None => {
                    return Err(EngineError::contract(
                        ContractErrorCode::NotFound,
                        "钱包账户不存在",
                    ));
                }
            }
            self.wallet_state().await
        })
    }

    /// 统一账户删除；冷账户路径不要求硬件金库，热账户仍执行原有精确清理。
    pub fn delete_wallet_account_any(
        &self,
        account_id: AccountId32,
    ) -> EngineFuture<'_, WalletStateSnapshot> {
        Box::pin(async move {
            match self.wallet_account_sign_mode(account_id).await? {
                Some(WalletSignMode::Hot) => self.delete_wallet_account(account_id).await?,
                Some(WalletSignMode::Cold) => self.delete_cold_wallet_account(account_id).await?,
                None => {
                    return Err(EngineError::contract(
                        ContractErrorCode::NotFound,
                        "钱包账户不存在",
                    ));
                }
            }
            self.wallet_state().await
        })
    }

    pub fn wallet_account_sign_mode(
        &self,
        account_id: AccountId32,
    ) -> EngineFuture<'_, Option<WalletSignMode>> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.account_sign_mode(account_id).await })
    }

    /// 对硬件密钥、全部密文和 child 公钥做一次完整核验。
    pub fn usable_wallet_profile(&self) -> EngineFuture<'_, Option<WalletProfile>> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move { service?.usable_profile().await })
    }

    /// 生成一次性恢复词会话；准备阶段不会写入 profile、密文或硬件 KEK。
    pub fn prepare_wallet_creation(
        &self,
        word_count: WalletWordCount,
        password: Zeroizing<String>,
    ) -> EngineFuture<'_, PreparedWalletCreation> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move { service?.prepare_create(word_count, password).await })
    }

    /// 用户确认已经备份恢复词后消费会话并提交钱包。
    pub fn commit_wallet_creation_after_backup(
        &self,
        prepared: PreparedWalletCreation,
    ) -> EngineFuture<'_, WalletProfile> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(service?.commit_create_after_backup(prepared))
                .await
        })
    }

    pub fn import_wallet(
        &self,
        mnemonic: SecretBuffer,
        password: Zeroizing<String>,
    ) -> EngineFuture<'_, WalletProfile> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(service?.import(&mnemonic, &password))
                .await
        })
    }

    pub fn add_wallet_accounts(
        &self,
        mnemonic: SecretBuffer,
        password: Zeroizing<String>,
        indices: Vec<u32>,
        cancelled: Arc<AtomicBool>,
    ) -> EngineFuture<'_, WalletProfile> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(
                service?
                    .with_add_cancellation(cancelled)
                    .add_accounts(&mnemonic, &password, &indices),
            )
            .await
        })
    }

    /// 显式“下一个账户”，复用与指定追加相同的归属校验、金库和提交路径。
    pub fn add_next_wallet_account(
        &self,
        mnemonic: SecretBuffer,
        password: Zeroizing<String>,
        cancelled: Arc<AtomicBool>,
    ) -> EngineFuture<'_, WalletProfile> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(
                service?
                    .with_add_cancellation(cancelled)
                    .add_next_account(&mnemonic, &password),
            )
            .await
        })
    }

    pub fn set_active_wallet_account(
        &self,
        account_id: AccountId32,
    ) -> EngineFuture<'_, WalletProfile> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.set_active_account(account_id).await })
    }

    pub fn rename_wallet_account(
        &self,
        account_id: AccountId32,
        name: String,
    ) -> EngineFuture<'_, WalletProfile> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move { service?.rename_account(account_id, &name).await })
    }

    /// 使用 SDK 安全账户密文签名；公开签名模块独立于钱包管理模块。
    pub fn sign_wallet_payload(
        &self,
        account_id: AccountId32,
        message: Vec<u8>,
    ) -> EngineFuture<'_, Sr25519Signature> {
        Box::pin(async move {
            self.require_local_capabilities(&[
                CapabilityName::LocalSigning,
                CapabilityName::HardwareVault,
                CapabilityName::UserAuthentication,
            ])?;
            // LocalSigning 可独立于钱包管理模块启用，但仍必须从同一 WalletState
            // 真源核对热/冷账户；不能调用要求 WalletProfile capability 的公开管理入口。
            match self
                .wallet_service_from_components()?
                .account_sign_mode(account_id)
                .await?
            {
                Some(WalletSignMode::Hot) => {}
                Some(WalletSignMode::Cold) => {
                    return Err(EngineError::Contract(ContractError::new(
                        ContractErrorCode::Unsupported,
                        "冷账户必须由独立外部设备完成签名",
                    )));
                }
                None => {
                    return Err(EngineError::Contract(ContractError::new(
                        ContractErrorCode::NotFound,
                        "签名账户不存在",
                    )));
                }
            }
            let service = SigningService::new(
                self.components
                    .signer()
                    .cloned()
                    .ok_or_else(|| component_missing("chain_signer"))?,
                self.components
                    .secret_vault()
                    .cloned()
                    .ok_or_else(|| component_missing("secret_vault"))?,
                self.components
                    .wallet_profiles()
                    .cloned()
                    .ok_or_else(|| component_missing("wallet_profile_store"))?,
                self.components
                    .encrypted_secrets()
                    .cloned()
                    .ok_or_else(|| component_missing("encrypted_secret_blob_store"))?,
            );
            service.sign(account_id, message).await
        })
    }

    /// Product-independent hot signing path for a validated opaque intent.
    ///
    /// WalletState is authoritative for routing. Cold accounts are never allowed to fall through
    /// to Vault, and the returned signature is verified against the frozen transform before it
    /// crosses the Engine boundary.
    pub fn sign_wallet_intent(&self, intent: SigningIntent) -> EngineFuture<'_, SigningCompletion> {
        Box::pin(async move {
            match self
                .wallet_service_from_components()?
                .account_sign_mode(intent.account_id())
                .await?
            {
                Some(WalletSignMode::Hot) => {}
                Some(WalletSignMode::Cold) => {
                    return Err(EngineError::contract(
                        ContractErrorCode::Unsupported,
                        "冷账户必须通过 external signer transport 完成签名",
                    ));
                }
                None => {
                    return Err(EngineError::contract(
                        ContractErrorCode::NotFound,
                        "签名账户不存在",
                    ));
                }
            }
            self.require_local_capabilities(&[
                CapabilityName::LocalSigning,
                CapabilityName::HardwareVault,
                CapabilityName::UserAuthentication,
            ])?;
            let service = SigningService::new(
                self.components
                    .signer()
                    .cloned()
                    .ok_or_else(|| component_missing("chain_signer"))?,
                self.components
                    .secret_vault()
                    .cloned()
                    .ok_or_else(|| component_missing("secret_vault"))?,
                self.components
                    .wallet_profiles()
                    .cloned()
                    .ok_or_else(|| component_missing("wallet_profile_store"))?,
                self.components
                    .encrypted_secrets()
                    .cloned()
                    .ok_or_else(|| component_missing("encrypted_secret_blob_store"))?,
            );
            let message = intent.signing_message()?;
            let signature = service.sign(intent.account_id(), message.clone()).await?;
            let signer = self
                .components
                .signer()
                .ok_or_else(|| component_missing("chain_signer"))?;
            if !signer
                .verify(
                    Sr25519PublicKey::from_bytes(intent.account_id().into_bytes()),
                    message,
                    signature,
                )
                .await?
            {
                return Err(EngineError::contract(
                    ContractErrorCode::Integrity,
                    "热钱包签名未通过原账户和冻结 transform 复核",
                ));
            }
            Ok(SigningCompletion::new(
                intent.account_id(),
                intent.payload_hash()?,
                signature,
            ))
        })
    }

    /// Freeze a default-account mutation using the current SDK wallet revision and CSPRNG nonce.
    pub fn prepare_default_wallet_account_change(
        &self,
        expected_revision: u64,
        ordered_account_ids: Vec<AccountId32>,
        ttl_seconds: u64,
    ) -> EngineFuture<'_, DefaultAccountChangeAuthorization> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            service?
                .prepare_default_account_change(expected_revision, ordered_account_ids, ttl_seconds)
                .await
        })
    }

    /// Commit only a signature over the exact immutable authorization returned above.
    pub fn commit_default_wallet_account_change<'a>(
        &'a self,
        authorization: &'a DefaultAccountChangeAuthorization,
        signature: Sr25519Signature,
    ) -> EngineFuture<'a, WalletState> {
        let service = self.local_wallet_service(&[CapabilityName::WalletProfile]);
        Box::pin(async move {
            service?
                .commit_default_account_change(authorization, signature)
                .await
        })
    }

    /// Hot default changes use the same generic signing intent, then the same exact CAS commit as
    /// external signatures. The account mode is never supplied by the caller.
    pub fn authorize_hot_default_wallet_account_change(
        &self,
        authorization: DefaultAccountChangeAuthorization,
    ) -> EngineFuture<'_, WalletState> {
        Box::pin(async move {
            let intent = authorization.signing_intent()?;
            let completion = self.sign_wallet_intent(intent).await?;
            self.commit_default_wallet_account_change(&authorization, completion.signature())
                .await
        })
    }

    /// 已验证链调用审阅独立于钱包管理；不启动 provider，也不调用宿主传入的 metadata。
    #[cfg(all(feature = "qr", feature = "chain"))]
    pub fn review_qr_sign_request(
        &self,
        request: citizen_sdk_qr::SignRequest,
    ) -> EngineFuture<'_, crate::QrReview> {
        Box::pin(async move {
            let lease = self.begin_qr_operation()?;
            let result =
                crate::qr_review::review_request(self.components.chain_client()?.as_ref(), request)
                    .await?;
            lease.ensure_current()?;
            Ok(result)
        })
    }

    /// 用户确认后的唯一 QR 安全签名管线：复查相同 Runtime，复用 SigningService，最后再验真。
    #[cfg(all(feature = "qr", feature = "chain"))]
    pub fn sign_qr_review<'a>(
        &'a self,
        review: crate::QrReview,
        ensure_current: impl Fn() -> Result<(), EngineError> + Send + Sync + 'a,
    ) -> EngineFuture<'a, Sr25519Signature> {
        Box::pin(async move {
            let lease = self.begin_qr_operation()?;
            self.require_local_capabilities(&[
                CapabilityName::LocalSigning,
                CapabilityName::HardwareVault,
                CapabilityName::UserAuthentication,
            ])?;
            ensure_current()?;
            let client = self.components.chain_client()?;
            let current =
                crate::qr_review::review_request(client.as_ref(), review.request().clone()).await?;
            if !review.matches(&current) {
                return Err(EngineError::contract(
                    ContractErrorCode::Conflict,
                    "确认后交易 Runtime 或检查点已改变",
                ));
            }
            let guard = || {
                lease.ensure_current()?;
                ensure_current()
            };
            let service = SigningService::new(
                self.components
                    .signer()
                    .cloned()
                    .ok_or_else(|| component_missing("chain_signer"))?,
                self.components
                    .secret_vault()
                    .cloned()
                    .ok_or_else(|| component_missing("secret_vault"))?,
                self.components
                    .wallet_profiles()
                    .cloned()
                    .ok_or_else(|| component_missing("wallet_profile_store"))?,
                self.components
                    .encrypted_secrets()
                    .cloned()
                    .ok_or_else(|| component_missing("encrypted_secret_blob_store"))?,
            );
            let message = review.request().signing_message().map_err(|_| {
                EngineError::contract(ContractErrorCode::Decode, "二维码签名载荷无效")
            })?;
            let public_key = review.request().require_signer().map_err(|_| {
                EngineError::contract(ContractErrorCode::Decode, "二维码未绑定签名账户")
            })?;
            let signature = service
                .sign_guarded(
                    AccountId32::from_bytes(*public_key.as_bytes()),
                    message.clone(),
                    &guard,
                )
                .await?;
            guard()?;
            let signer = self
                .components
                .signer()
                .ok_or_else(|| component_missing("chain_signer"))?;
            if !signer.verify(public_key, message, signature).await? {
                return Err(EngineError::contract(
                    ContractErrorCode::Integrity,
                    "二维码签名未通过原账户和已审阅载荷复核",
                ));
            }
            guard()?;
            let current =
                crate::qr_review::review_request(client.as_ref(), review.request().clone()).await?;
            if !review.matches(&current) {
                return Err(EngineError::contract(
                    ContractErrorCode::Conflict,
                    "认证期间交易 Runtime 或检查点已改变",
                ));
            }
            guard()?;
            Ok(signature)
        })
    }

    #[cfg(all(feature = "qr", feature = "chain"))]
    fn begin_qr_operation(&self) -> Result<EngineQrOperationLease, EngineError> {
        if !self
            .components
            .modules
            .contains(Modules::QR | Modules::CHAIN)
        {
            return Err(EngineError::contract(
                ContractErrorCode::Unsupported,
                "链调用审阅要求 qr 与 chain 模块",
            ));
        }
        self.require_capabilities(&[CapabilityName::ChainRead])?;
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running {
            return Err(lifecycle_error("二维码审阅要求已运行的 verified chain"));
        }
        state.qr_operations = state
            .qr_operations
            .checked_add(1)
            .ok_or_else(|| lifecycle_error("二维码操作数量耗尽"))?;
        Ok(EngineQrOperationLease {
            state: Arc::clone(&self.state),
            generation: state.generation,
        })
    }

    pub fn delete_wallet_account(&self, account_id: AccountId32) -> EngineFuture<'_, ()> {
        let service = self
            .local_wallet_service(&[CapabilityName::WalletProfile, CapabilityName::HardwareVault]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(service?.delete_account(account_id))
                .await
        })
    }

    pub fn delete_wallet(&self) -> EngineFuture<'_, ()> {
        let service = self
            .local_wallet_service(&[CapabilityName::WalletProfile, CapabilityName::HardwareVault]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(service?.delete_wallet())
                .await
        })
    }

    /// 签名删除与无签名擦除分开接纳，共用WalletService的唯一清理路径。
    pub fn sign_and_delete_wallet(&self) -> EngineFuture<'_, ()> {
        let service = self.local_wallet_service(&[
            CapabilityName::WalletProfile,
            CapabilityName::LocalSigning,
            CapabilityName::HardwareVault,
            CapabilityName::UserAuthentication,
        ]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(service?.sign_and_delete_wallet())
                .await
        })
    }

    pub fn reconcile_wallet_cleanup(&self) -> EngineFuture<'_, ()> {
        let service = self
            .local_wallet_service(&[CapabilityName::WalletProfile, CapabilityName::HardwareVault]);
        Box::pin(async move {
            self.with_wallet_monitor_paused(service?.reconcile_cleanup())
                .await
        })
    }

    /// Reads a deterministic public page from the local execution-only store.
    #[cfg(feature = "chain")]
    pub fn get_transaction_history(
        &self,
        before_execution_id: Option<TransactionExecutionId>,
        limit: usize,
    ) -> EngineFuture<'_, citizen_sdk_contracts::TransactionHistoryPage> {
        let service = self.history_service_from_components();
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::History])?;
            service?.page(before_execution_id, limit).await
        })
    }

    /// Reconciles at most 32 non-terminal SDK executions against finalized chain evidence.
    #[cfg(feature = "chain")]
    pub fn sync_transaction_history(&self) -> EngineFuture<'_, TransactionHistoryIndex> {
        let preparation = self.prepare_finalized_history_runtime(&[
            CapabilityName::ChainRead,
            CapabilityName::History,
            CapabilityName::TransactionSubmit,
            CapabilityName::TransactionVerify,
        ]);
        Box::pin(async move {
            let (runtime, guard) = preparation?;
            let signer = self.components.signer().ok_or_else(|| {
                EngineError::CapabilityUnavailable("chain_signer_missing".to_owned())
            })?;
            let (mut positions, mut rebroadcasted) = {
                let monitor = self
                    .chain_monitor
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?;
                (
                    monitor.execution_positions.clone(),
                    monitor.rebroadcasted_executions.clone(),
                )
            };
            let state = runtime
                .reconcile_generic_execution_batch(
                    &mut positions,
                    &mut rebroadcasted,
                    signer.as_ref(),
                    &guard,
                )
                .await?;
            guard.ensure_current()?;
            let mut monitor = self
                .chain_monitor
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?;
            monitor.execution_positions = positions;
            monitor.rebroadcasted_executions = rebroadcasted;
            Ok(state)
        })
    }

    /// 提交宿主在 SDK 外部完成签名的完整 extrinsic。
    ///
    /// 这是供已完成签名的纯链客户端使用的高级入口，不是 SDK 钱包交易入口。只要当前
    /// Engine 注入任一钱包交易栈组件，该交易哈希就必须已经由内部钱包路径写入 pending，
    /// 否则拒绝广播。交易池接受仍不等于链上执行成功。
    #[cfg(feature = "chain")]
    pub fn submit_signed_extrinsic(
        &self,
        extrinsic: SignedExtrinsic,
    ) -> EngineFuture<'_, SubmittedExtrinsic> {
        Box::pin(async move {
            self.require_capabilities(&[
                CapabilityName::ChainRead,
                CapabilityName::TransactionSubmit,
            ])?;
            if self.components.has_any_wallet_transaction_component() {
                self.require_capabilities(&[CapabilityName::History])?;
                let best = self.components.chain_client()?.get_best_head().await?;
                let context = self
                    .components
                    .chain_client()?
                    .get_runtime_context_at(best)
                    .await?;
                if context.block() != best {
                    return Err(EngineError::BlockContextMismatch(
                        "原始提交哈希使用的 Runtime context 不属于当前 best 块".to_owned(),
                    ));
                }
                let transaction_hash = crate::signed_extrinsic_hash(&context, &extrinsic)?;
                self.history_service_from_components()?
                    .require_recorded_before_broadcast(transaction_hash)
                    .await?;
            }
            self.components
                .chain_client()?
                .submit_extrinsic(extrinsic)
                .await
                .map_err(EngineError::from)
        })
    }

    /// 提交并监听宿主在 SDK 外部完成签名的完整 extrinsic。
    ///
    /// 这是供已完成签名的纯链客户端使用的高级入口；底层 provider 的 watch 合同会广播
    /// extrinsic，而不是只观察一个既有哈希。只要 Engine 注入任一钱包交易栈组件，就必须
    /// 改用内部高层钱包交易路径，避免绕过 pending-before-broadcast 合同。
    pub fn watch_signed_extrinsic(
        &self,
        extrinsic: SignedExtrinsic,
    ) -> Result<citizen_sdk_contracts::ContractStream<'_, ExtrinsicWatchEvent>, EngineError> {
        self.require_capabilities(&[CapabilityName::ChainRead, CapabilityName::TransactionSubmit])?;
        if self.components.has_any_wallet_transaction_component() {
            return Err(EngineError::contract(
                ContractErrorCode::InvalidState,
                "组合钱包组件后禁止原始 submit-and-watch；钱包交易必须使用高层交易入口",
            ));
        }
        Ok(self.components.chain_client()?.watch_extrinsic(extrinsic))
    }

    /// Reserve the one-way transition into provider startup.
    pub fn begin_provider_start(&self) -> Result<(), EngineError> {
        self.components.chain_client()?;
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Created || state.export_in_progress {
            return Err(lifecycle_error(
                "provider start requires a never-started Engine",
            ));
        }
        require_no_inflight_history_operations(&state, "provider start")?;
        state.generation = next_generation(state.generation)?;
        state.lifecycle = EngineLifecycle::Starting;
        self.refresh_capabilities_while_state_locked(EngineLifecycle::Starting)
    }

    /// Complete startup only after the provider exposes an independently
    /// verified finalized head. A provisional import that regresses or
    /// conflicts moves the Engine to `StartFailed`; the provider adapter must
    /// then destroy its failed instance before a new Engine is created.
    pub fn complete_provider_start(&self) -> EngineFuture<'_, FinalizedBlockRef> {
        let generation = self
            .state
            .lock()
            .map_err(|_| EngineError::StatePoisoned)
            .and_then(|state| {
                if state.lifecycle == EngineLifecycle::Starting {
                    Ok(state.generation)
                } else {
                    Err(lifecycle_error("provider is not starting"))
                }
            });
        Box::pin(async move {
            let generation = generation?;
            let identity = match self.components.chain_client()?.identity().await {
                Ok(identity) => identity,
                Err(error) => {
                    self.fail_start_if_current(generation)?;
                    return Err(EngineError::from(error));
                }
            };
            if identity != *StateImportPolicy::citizenchain(None).identity() {
                self.fail_start_if_current(generation)?;
                return Err(EngineError::contract(
                    ContractErrorCode::Integrity,
                    "provider identity changed away from CitizenChain during startup".to_owned(),
                ));
            }
            let finalized = match self.components.chain_client()?.get_finalized_head().await {
                Ok(finalized) => finalized,
                Err(error) => {
                    self.fail_start_if_current(generation)?;
                    return Err(EngineError::from(error));
                }
            };
            let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if state.lifecycle != EngineLifecycle::Starting || state.generation != generation {
                return Err(lifecycle_error(
                    "provider startup completed after its lifecycle generation ended",
                ));
            }
            if let Some(imported) = state.provisional_import {
                if let Err(rejection) = validate_import_startup(imported, finalized) {
                    state.lifecycle = EngineLifecycle::StartFailed;
                    state.generation = next_generation(state.generation)?;
                    self.refresh_capabilities_while_state_locked(EngineLifecycle::StartFailed)?;
                    return Err(state_rejection_error(rejection));
                }
            }
            state.lifecycle = EngineLifecycle::Running;
            state.provisional_import = None;
            state.verified_finalized = Some(finalized);
            self.refresh_capabilities_while_state_locked(EngineLifecycle::Running)?;
            Ok(finalized)
        })
    }

    /// Record a provider startup failure without allowing the same Engine to
    /// return to the importable state.
    pub fn mark_provider_start_failed(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Starting {
            return Err(lifecycle_error("only a starting provider can fail startup"));
        }
        require_no_inflight_history_operations(&state, "provider start failure")?;
        state.lifecycle = EngineLifecycle::StartFailed;
        state.generation = next_generation(state.generation)?;
        #[cfg(feature = "chain")]
        self.prepared_transactions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .clear();
        #[cfg(feature = "chain")]
        self.transaction_executions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .clear();
        self.refresh_capabilities_while_state_locked(EngineLifecycle::StartFailed)
    }

    pub fn mark_provider_stopped(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running || state.export_in_progress {
            return Err(lifecycle_error("only an idle running provider can stop"));
        }
        require_no_inflight_history_operations(&state, "provider stop")?;
        state.lifecycle = EngineLifecycle::Stopped;
        state.generation = next_generation(state.generation)?;
        state.export_in_progress = false;
        #[cfg(feature = "chain")]
        self.prepared_transactions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .clear();
        #[cfg(feature = "chain")]
        self.transaction_executions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .clear();
        self.refresh_capabilities_while_state_locked(EngineLifecycle::Stopped)
    }

    pub fn dispose(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle == EngineLifecycle::Disposed {
            return Ok(());
        }
        if state.private_key_views != 0 {
            return Err(EngineError::contract(
                ContractErrorCode::Conflict,
                "安全查看尚未完成清理",
            ));
        }
        require_no_inflight_history_operations(&state, "engine dispose")?;
        state.lifecycle = EngineLifecycle::Disposed;
        state.generation = next_generation(state.generation)?;
        state.export_in_progress = false;
        #[cfg(feature = "chain")]
        self.prepared_transactions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .clear();
        #[cfg(feature = "chain")]
        self.transaction_executions
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .clear();
        self.refresh_capabilities_while_state_locked(EngineLifecycle::Disposed)
    }

    /// Load a context at one exact block and reject provider cross-block data.
    pub fn runtime_context_at(&self, block: VerifiedBlockRef) -> EngineFuture<'_, RuntimeContext> {
        Box::pin(async move {
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            let request = self
                .runtime_contexts
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?
                .begin(block)?;

            // 内存 cache 能承载完整 Core 合同允许的 metadata，也是超过宿主持久记录容量时
            // 的唯一缓存层。不能为了持久 cache 的性能上限降低链读取能力。
            let memory_cached = {
                let contexts = self
                    .runtime_contexts
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?;
                contexts.get(block).cloned()
            };
            if let Some(cached) = memory_cached {
                return self
                    .runtime_contexts
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?
                    .complete(request, cached);
            }

            if let Some(store) = self.components.runtime_cache() {
                let cached = store.load(block.hash()).await.map_err(EngineError::from)?;
                // 持久 cache 是可重建的性能层。宿主若返回超出其合同容量的旧/异常记录，
                // 不让它阻塞 provider 读取，也不在这里执行迁移或兼容逻辑。
                if let Some(cached) = cached.filter(|context| {
                    context.metadata().len() <= MAX_PERSISTED_RUNTIME_METADATA_BYTES
                }) {
                    return self
                        .runtime_contexts
                        .lock()
                        .map_err(|_| EngineError::StatePoisoned)?
                        .complete(request, cached);
                }
            }

            let context = self
                .components
                .chain_client()?
                .get_runtime_context_at(block)
                .await
                .map_err(EngineError::from)?;
            let context = self
                .runtime_contexts
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?
                .complete(request, context)?;
            if context.metadata().len() <= MAX_PERSISTED_RUNTIME_METADATA_BYTES {
                if let Some(store) = self.components.runtime_cache() {
                    store
                        .store(context.clone())
                        .await
                        .map_err(EngineError::from)?;
                }
            }
            Ok(context)
        })
    }

    /// Gather evidence for an exact provider-resolved finalized block and return a fail-closed
    /// execution conclusion.
    ///
    /// `VerifiedBlockRef` is serializable host input, not an unforgeable proof token. Therefore
    /// this boundary asks `VerifiedChainClient` to resolve the supplied hash/height onto its
    /// finalized canonical chain before reading Runtime/body/events. A caller-provided finality bit
    /// can never manufacture `Success` or `Failed`, while historical finalized catch-up remains
    /// available after the head advances.
    #[cfg(feature = "chain")]
    pub fn verify_transaction_at(
        &self,
        block: VerifiedBlockRef,
        signed_extrinsic: SignedExtrinsic,
        submitted_hash: Hash32,
    ) -> EngineFuture<'_, ExecutionConclusion> {
        Box::pin(async move {
            if self
                .require_capabilities(&[
                    CapabilityName::ChainRead,
                    CapabilityName::TransactionVerify,
                ])
                .is_err()
            {
                return Ok(unverified(block, None, UnverifiedReason::ProviderFailure));
            }
            if !block.is_finalized() {
                return Ok(unverified(
                    block,
                    None,
                    UnverifiedReason::TargetBlockUnavailable,
                ));
            }
            let provider_finalized = match self
                .components
                .chain_client()?
                .resolve_finalized_block(block.hash(), block.number())
                .await
            {
                Ok(finalized) => finalized,
                Err(error)
                    if matches!(
                        error.code(),
                        ContractErrorCode::Network
                            | ContractErrorCode::Timeout
                            | ContractErrorCode::Unavailable
                            | ContractErrorCode::NotReady
                            | ContractErrorCode::Internal
                    ) =>
                {
                    return Ok(unverified(block, None, UnverifiedReason::ProviderFailure));
                }
                Err(_) => {
                    return Ok(unverified(
                        block,
                        None,
                        UnverifiedReason::TargetBlockUnavailable,
                    ));
                }
            };
            if block != provider_finalized.verified() {
                return Ok(unverified(
                    block,
                    None,
                    UnverifiedReason::TargetBlockUnavailable,
                ));
            }
            // 持久 RuntimeCacheStore 是性能层，不是 provider-issued 证明。执行结论
            // 会按 metadata 解释真实 System.Events，因此安全关键核验必须直接取得
            // 轻节点对该 finalized 块返回的 context；不允许持久 cache 重映射
            // Success/Failed 语义。
            let runtime_context = match self
                .components
                .chain_client()?
                .get_finalized_runtime_context_at(provider_finalized)
                .await
            {
                Ok(context) if context.block() == provider_finalized.verified() => context,
                Ok(_) | Err(_) => {
                    return Ok(unverified(
                        block,
                        None,
                        UnverifiedReason::RuntimeContextUnavailable,
                    ));
                }
            };
            let block_extrinsics = match self
                .components
                .chain_client()?
                .get_finalized_block_extrinsics_at(provider_finalized)
                .await
            {
                Ok(extrinsics) => extrinsics,
                Err(_) => {
                    return Ok(unverified(
                        block,
                        None,
                        UnverifiedReason::BlockBodyUnavailable,
                    ));
                }
            };
            let system_events = self
                .components
                .chain_client()?
                .get_finalized_storage_at(provider_finalized, SYSTEM_EVENTS_STORAGE_KEY.to_vec())
                .await
                .ok()
                .flatten();
            Ok(verify_transaction_outcome(TransactionEvidence {
                block,
                runtime_context: &runtime_context,
                signed_extrinsic: &signed_extrinsic,
                submitted_hash,
                block_extrinsics: &block_extrinsics,
                system_events: system_events.as_deref(),
            }))
        })
    }

    /// Validate all import gates before the provider sees database bytes, then
    /// require its receipt to preserve the exact finalized anchor.
    pub fn import_state(
        &self,
        imported: ExportedChainState,
    ) -> EngineFuture<'_, StateImportReceipt> {
        let preparation = self.prepare_state_import(&imported);
        Box::pin(async move {
            let (reservation, provisional_finalized) = preparation?;
            let store = Arc::clone(self.components.chain_database().ok_or_else(|| {
                EngineError::CapabilityUnavailable(
                    "chain database store is required for state import".to_owned(),
                )
            })?);
            let stored = store.load().await.map_err(EngineError::from)?;
            self.complete_state_import(imported, reservation, provisional_finalized, store, stored)
                .await
        })
    }

    /// Restore the exact opaque light-client state selected by the configured
    /// typed store. An empty store is a successful no-op. Every non-empty value
    /// passes the same import gates, provider receipt check, revision CAS and
    /// one-way post-provider failure semantics as an explicit import.
    pub fn restore_state_from_store(&self) -> EngineFuture<'_, Option<StateImportReceipt>> {
        Box::pin(async move {
            let store = Arc::clone(self.components.chain_database().ok_or_else(|| {
                EngineError::CapabilityUnavailable(
                    "chain database store is required for state restore".to_owned(),
                )
            })?);
            let stored = store.load().await.map_err(EngineError::from)?;
            let Some(imported) = stored.state().cloned() else {
                // Linearize the empty result against startup/import. Returning
                // None while another lifecycle transition already won would
                // falsely claim restore completed before provider startup.
                let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                if state.lifecycle != EngineLifecycle::Created || state.export_in_progress {
                    return Err(lifecycle_error(
                        "empty state restore requires a never-started Engine",
                    ));
                }
                return Ok(None);
            };
            let (reservation, provisional_finalized) = self.prepare_state_import(&imported)?;
            self.complete_state_import(imported, reservation, provisional_finalized, store, stored)
                .await
                .map(Some)
        })
    }

    async fn complete_state_import(
        &self,
        imported: ExportedChainState,
        mut reservation: StateImportReservation,
        provisional_finalized: Option<FinalizedBlockRef>,
        store: Arc<dyn ChainDatabaseStore>,
        stored: ChainDatabaseSnapshot,
    ) -> Result<StateImportReceipt, EngineError> {
        let stored_finalized = validate_persisted_chain_state(&stored)?;
        let current_finalized = merge_finalized_anchors(provisional_finalized, stored_finalized)?;
        let policy = StateImportPolicy::citizenchain(current_finalized);
        validate_state_import(&policy, EngineLifecycle::Created, &imported)
            .map_err(state_rejection_error)?;
        let provider_identity = self
            .components
            .chain_client()?
            .identity()
            .await
            .map_err(EngineError::from)?;
        if &provider_identity != policy.identity() {
            return Err(EngineError::contract(
                ContractErrorCode::Integrity,
                "provider identity does not match CitizenChain".to_owned(),
            ));
        }
        // Prove revision capacity before the irreversible provider import.
        let expected_persisted = next_chain_database_snapshot(&stored, imported.clone())?;
        let expected = imported.finalized();
        reservation.mark_provider_invoked()?;
        let receipt = self
            .components
            .chain_client()?
            .import_state(imported)
            .await
            .map_err(EngineError::from)?;
        if receipt.finalized() != expected {
            return Err(EngineError::BlockContextMismatch(
                "state import receipt changed the finalized anchor".to_owned(),
            ));
        }
        // Even when the loaded state equals the candidate, CAS proves no other
        // process changed that revision while provider import was in flight.
        persist_chain_database_exact(&store, stored.revision(), expected_persisted).await?;
        reservation.commit(expected)?;
        Ok(receipt)
    }

    /// Export only from one stable running generation and require the
    /// provider's verified finalized head to remain unchanged across
    /// serialization.
    pub fn export_state(&self) -> EngineFuture<'_, ExportedChainState> {
        self.export_state_inner(false)
    }

    /// Export one stable provider snapshot and atomically persist it to the
    /// configured typed chain database before releasing the Engine generation.
    pub fn export_and_persist_state(&self) -> EngineFuture<'_, ExportedChainState> {
        self.export_state_inner(true)
    }

    fn export_state_inner(&self, persist: bool) -> EngineFuture<'_, ExportedChainState> {
        let reservation = self.prepare_state_export();
        let store = if persist {
            self.components.chain_database().map(Arc::clone)
        } else {
            None
        };
        Box::pin(async move {
            let mut reservation = reservation?;
            self.require_capabilities(&[CapabilityName::ChainRead])?;
            let stored = if persist {
                let store = store.as_ref().ok_or_else(|| {
                    EngineError::CapabilityUnavailable(
                        "chain database store is required for persistent state export".to_owned(),
                    )
                })?;
                let snapshot = store.load().await.map_err(EngineError::from)?;
                // Reject corrupt persisted envelopes before asking the provider
                // to serialize another database.
                let _ = validate_persisted_chain_state(&snapshot)?;
                Some(snapshot)
            } else {
                None
            };
            let before = self
                .components
                .chain_client()?
                .get_finalized_head()
                .await
                .map_err(EngineError::from)?;
            let provider_identity = self
                .components
                .chain_client()?
                .identity()
                .await
                .map_err(EngineError::from)?;
            if provider_identity != *StateImportPolicy::citizenchain(None).identity() {
                return Err(EngineError::contract(
                    ContractErrorCode::Integrity,
                    "provider identity changed away from CitizenChain during export".to_owned(),
                ));
            }
            if let Some(current) = reservation.verified_finalized {
                validate_import_startup(current, before).map_err(state_rejection_error)?;
            }
            if let Some(stored_finalized) = stored
                .as_ref()
                .and_then(|snapshot| snapshot.state().map(ExportedChainState::finalized))
            {
                validate_import_startup(stored_finalized, before).map_err(state_rejection_error)?;
            }
            let exported = self
                .components
                .chain_client()?
                .export_state()
                .await
                .map_err(EngineError::from)?;
            let after = self
                .components
                .chain_client()?
                .get_finalized_head()
                .await
                .map_err(EngineError::from)?;
            let policy = StateImportPolicy::citizenchain(Some(before));
            validate_state_export(&policy, EngineLifecycle::Running, before, &exported, after)
                .map_err(state_rejection_error)?;
            if let Some(stored) = stored {
                let store = store.as_ref().ok_or_else(|| {
                    EngineError::CapabilityUnavailable(
                        "chain database store disappeared during persistent export".to_owned(),
                    )
                })?;
                let expected_persisted = next_chain_database_snapshot(&stored, exported.clone())?;
                persist_chain_database_exact(store, stored.revision(), expected_persisted).await?;
            }
            reservation.commit(after)?;
            Ok(exported)
        })
    }

    fn prepare_state_import(
        &self,
        imported: &ExportedChainState,
    ) -> Result<(StateImportReservation, Option<FinalizedBlockRef>), EngineError> {
        if self.components.chain_database().is_none() {
            return Err(EngineError::CapabilityUnavailable(
                "chain database store is required for state import".to_owned(),
            ));
        }
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        let policy = StateImportPolicy::citizenchain(state.provisional_import);
        validate_state_import(&policy, state.lifecycle, imported).map_err(state_rejection_error)?;
        require_no_inflight_history_operations(&state, "state import")?;
        state.generation = next_generation(state.generation)?;
        state.lifecycle = EngineLifecycle::ImportingState;
        Ok((
            StateImportReservation::new(Arc::clone(&self.state), state.generation),
            state.provisional_import,
        ))
    }

    fn prepare_state_export(&self) -> Result<StateExportReservation, EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running || state.export_in_progress {
            return Err(lifecycle_error(
                "state export requires one idle running Engine generation",
            ));
        }
        state.export_in_progress = true;
        Ok(StateExportReservation::new(
            Arc::clone(&self.state),
            state.generation,
            state.verified_finalized,
        ))
    }

    fn fail_start_if_current(&self, generation: u64) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        let mut changed = false;
        if state.lifecycle == EngineLifecycle::Starting && state.generation == generation {
            require_no_inflight_history_operations(&state, "provider start failure")?;
            state.lifecycle = EngineLifecycle::StartFailed;
            state.generation = next_generation(state.generation)?;
            changed = true;
        }
        if changed {
            self.refresh_capabilities_while_state_locked(EngineLifecycle::StartFailed)?;
        }
        Ok(())
    }

    fn wallet_service_from_components(&self) -> Result<WalletService, EngineError> {
        let signer = self
            .components
            .signer()
            .cloned()
            .ok_or_else(|| component_missing("chain_signer"))?;
        let vault = self
            .components
            .secret_vault()
            .cloned()
            .ok_or_else(|| component_missing("secret_vault"))?;
        let profiles = self
            .components
            .wallet_profiles()
            .cloned()
            .ok_or_else(|| component_missing("wallet_profile_store"))?;
        let encrypted_secrets = self
            .components
            .encrypted_secrets()
            .cloned()
            .ok_or_else(|| component_missing("encrypted_secret_blob_store"))?;
        Ok(WalletService::new(
            signer,
            vault,
            profiles,
            encrypted_secrets,
            Arc::new(SystemWalletEntropy),
            Arc::new(SystemWalletClock),
        ))
    }

    fn local_wallet_service(
        &self,
        required: &[CapabilityName],
    ) -> Result<WalletService, EngineError> {
        self.require_local_capabilities(required)?;
        self.wallet_service_from_components()
    }

    #[cfg(feature = "chain")]
    fn history_service_from_components(&self) -> Result<TransactionHistoryService, EngineError> {
        let store = self
            .components
            .transaction_history()
            .cloned()
            .ok_or_else(|| component_missing("transaction_history_store"))?;
        Ok(TransactionHistoryService::new(
            store,
            Arc::new(SystemWalletClock),
        ))
    }

    #[cfg(feature = "chain")]
    fn prepare_finalized_history_runtime(
        &self,
        required: &[CapabilityName],
    ) -> Result<(FinalizedHistoryRuntime, EngineHistoryOperationLease), EngineError> {
        self.require_capabilities(required)?;
        // 先解析全部组件，避免租约计数增加后因缺少 store 提前返回而泄漏。
        let runtime = FinalizedHistoryRuntime::new(
            Arc::clone(self.components.chain_client()?),
            self.history_service_from_components()?,
        );
        let (generation, cancellation) = {
            let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if state.lifecycle != EngineLifecycle::Running || state.history_paused {
                return Err(lifecycle_error(
                    "finalized history requires a running Engine generation",
                ));
            }
            state.inflight_history_operations = state
                .inflight_history_operations
                .checked_add(1)
                .ok_or_else(|| lifecycle_error("finalized history operation count overflowed"))?;
            (state.generation, Arc::clone(&state.history_cancel))
        };
        Ok((
            runtime,
            EngineHistoryOperationLease {
                state: Arc::clone(&self.state),
                generation,
                cancellation,
            },
        ))
    }

    /// 只用于同步状态和后台监控接纳，不授予读取链业务数据或发交易的权限。
    /// 未同步属于正常运行阶段；未启用、缺组件或宿主不可用仍然失败关闭。
    fn require_running_capability_admission(
        &self,
        required: &[CapabilityName],
    ) -> Result<(), EngineError> {
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running {
            return Err(EngineError::CapabilityUnavailable(
                "engine_not_running".to_owned(),
            ));
        }
        let capabilities = self
            .capabilities
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        let probes = capabilities.base_probes.as_ref().ok_or_else(|| {
            EngineError::CapabilityUnavailable(
                "capability state has not been established".to_owned(),
            )
        })?;
        for name in required {
            // 原始事实已经过唯一组件/模块过滤；只豁免正常同步等待，缺组件、存储或授权
            // 未就绪不能借此放行。依赖链未就绪也不能反过来禁止启动观察它的监控。
            if !probes
                .iter()
                .find(|probe| probe.name == *name)
                .is_some_and(|probe| {
                    probe.supported
                        && probe.available
                        && probe.enabled
                        && (probe.runtime_ready
                            || probe.not_ready_reason == Some(CapabilityReason::ChainUnsynced))
                })
            {
                return Err(EngineError::CapabilityUnavailable(format!(
                    "{} is unavailable",
                    name.as_str()
                )));
            }
        }
        Ok(())
    }

    fn require_capabilities(&self, required: &[CapabilityName]) -> Result<(), EngineError> {
        self.require_capability_snapshot(required, true)
    }

    fn require_local_capabilities(&self, required: &[CapabilityName]) -> Result<(), EngineError> {
        self.require_capability_snapshot(required, false)
    }

    fn require_capability_snapshot(
        &self,
        required: &[CapabilityName],
        require_running: bool,
    ) -> Result<(), EngineError> {
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if require_running && state.lifecycle != EngineLifecycle::Running {
            return Err(EngineError::CapabilityUnavailable(
                "engine_not_running".to_owned(),
            ));
        }
        let capabilities = self
            .capabilities
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        let Some(snapshot) = capabilities.tracker.current() else {
            return Err(EngineError::CapabilityUnavailable(
                "capability state has not been established".to_owned(),
            ));
        };
        for name in required {
            if !snapshot
                .status(*name)
                .is_some_and(|status| status.is_ready())
            {
                return Err(EngineError::CapabilityUnavailable(format!(
                    "{} is not ready",
                    name.as_str()
                )));
            }
        }
        Ok(())
    }

    /// Refresh a lifecycle-derived snapshot while the caller still owns the
    /// Engine state lock. Every dual-lock path uses state -> capabilities.
    fn refresh_capabilities_while_state_locked(
        &self,
        lifecycle: EngineLifecycle,
    ) -> Result<(), EngineError> {
        let mut capabilities = self
            .capabilities
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        let Some(base_probes) = capabilities.base_probes.clone() else {
            return Ok(());
        };
        let _ = capabilities
            .tracker
            .update(probes_for_lifecycle(base_probes, lifecycle))?;
        Ok(())
    }
}

#[cfg(feature = "chain")]
fn next_transaction_execution_id(
    registry: &Mutex<HashMap<TransactionExecutionId, ClaimedTransactionExecution>>,
) -> Result<TransactionExecutionId, EngineError> {
    let executions = registry.lock().map_err(|_| EngineError::StatePoisoned)?;
    for _ in 0..32 {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| {
            EngineError::contract(
                ContractErrorCode::Unavailable,
                "操作系统随机源无法生成 transaction execution id",
            )
        })?;
        let Ok(id) = TransactionExecutionId::try_new(bytes) else {
            continue;
        };
        if !executions.contains_key(&id) {
            return Ok(id);
        }
    }
    Err(EngineError::contract(
        ContractErrorCode::Internal,
        "transaction execution id 随机碰撞次数超限",
    ))
}

struct EnginePrivateKeyViewLease {
    state: Arc<Mutex<EngineState>>,
    generation: u64,
}

#[cfg(all(feature = "qr", feature = "chain"))]
struct EngineQrOperationLease {
    state: Arc<Mutex<EngineState>>,
    generation: u64,
}

#[cfg(all(feature = "qr", feature = "chain"))]
impl EngineQrOperationLease {
    fn ensure_current(&self) -> Result<(), EngineError> {
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running || state.generation != self.generation {
            return Err(lifecycle_error("二维码操作越过已验证链代际"));
        }
        Ok(())
    }
}

#[cfg(all(feature = "qr", feature = "chain"))]
impl Drop for EngineQrOperationLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.qr_operations = state.qr_operations.saturating_sub(1);
        }
    }
}

impl Drop for EnginePrivateKeyViewLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.private_key_views = state.private_key_views.saturating_sub(1);
        }
    }
}

#[derive(Default)]
struct InternalPrivateKeyViewState {
    bound: Option<Arc<WalletPrivateKeyView>>,
    confirmed: bool,
    revoked: bool,
    ui_finished: bool,
    working: bool,
    displayed: bool,
    notified: bool,
    notifying: bool,
    completed: bool,
    outcome: Option<Result<(), EngineError>>,
}

/// SDK 内部跨 crate 控制对象。只能由受控平台桥接持有，不是普通钱包秘密 getter。
#[doc(hidden)]
pub struct InternalPrivateKeyView {
    service: WalletService,
    account_id: AccountId32,
    lease: Mutex<Option<EnginePrivateKeyViewLease>>,
    state: Mutex<InternalPrivateKeyViewState>,
}

impl InternalPrivateKeyView {
    /// 只预留短阶段作业；空闲 UI 不占用工作线程。
    pub fn reserve_work(&self) -> Result<bool, EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.completed
            || state.working
            || state.revoked
            || state.outcome.is_some()
            || (state.bound.is_some() && !state.confirmed)
        {
            return Ok(false);
        }
        state.working = true;
        Ok(true)
    }

    pub fn confirm(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.completed || state.revoked || state.confirmed || state.outcome.is_some() {
            return Err(EngineError::contract(
                ContractErrorCode::Conflict,
                "查看已确认、撤销或结束",
            ));
        }
        state.confirmed = true;
        Ok(())
    }

    pub fn cancel(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.completed {
            return Err(lifecycle_error("查看已结束"));
        }
        state.revoked = true;
        if state.outcome.as_ref().is_none_or(Result::is_ok) {
            state.outcome = Some(Err(private_key_view_cancelled()));
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.completed {
            return Err(lifecycle_error("查看已结束"));
        }
        state.ui_finished = true;
        state.revoked = true;
        if state.outcome.is_none() {
            state.outcome = Some(if state.displayed {
                Ok(())
            } else {
                Err(private_key_view_cancelled())
            });
        }
        Ok(())
    }

    pub fn fail(&self, error: EngineError) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        state.revoked = true;
        if state.outcome.is_none() {
            state.outcome = Some(Err(error));
        }
        Ok(())
    }

    /// prepare 成功保持静默；确认到达后才进入认证，认证 future 不参与 drop 式取消。
    pub async fn run_work(
        &self,
        display: impl FnOnce(&[u8]) -> Result<(), EngineError>,
    ) -> Result<(), EngineError> {
        let needs_prepare = {
            let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if !state.working || state.completed {
                return Err(lifecycle_error("查看没有已登记作业"));
            }
            if state.revoked {
                return Ok(());
            }
            state.bound.is_none()
        };
        if needs_prepare {
            let bound = self
                .service
                .prepare_private_key_view(self.account_id)
                .await?;
            self.state
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?
                .bound = Some(bound);
        }
        let bound = {
            let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if state.revoked || !state.confirmed {
                return Ok(());
            }
            state
                .bound
                .clone()
                .ok_or_else(|| lifecycle_error("查看账户未绑定"))?
        };
        let outcome = self
            .service
            .reveal_private_key_view(
                &bound,
                || {
                    let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                    if state.revoked || state.completed {
                        Err(private_key_view_cancelled())
                    } else {
                        Ok(())
                    }
                },
                |bytes| {
                    // 同一 Core 门串行化 display 与 cancel/finish；display 合同禁止反调 SDK 或等 UI。
                    let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                    if state.revoked || state.completed {
                        return Err(private_key_view_cancelled());
                    }
                    let lease = self.lease.lock().map_err(|_| EngineError::StatePoisoned)?;
                    let lease = lease
                        .as_ref()
                        .ok_or_else(|| lifecycle_error("查看租约已释放"))?;
                    let engine = lease.state.lock().map_err(|_| EngineError::StatePoisoned)?;
                    if engine.lifecycle == EngineLifecycle::Disposed
                        || engine.generation != lease.generation
                    {
                        return Err(lifecycle_error("查看实例代际已改变"));
                    }
                    drop(engine);
                    display(bytes)?;
                    state.displayed = true;
                    Ok(())
                },
            )
            .await;
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.outcome.is_none() {
            state.outcome = Some(outcome);
        }
        Ok(())
    }

    pub fn release_work(&self) -> Result<(), EngineError> {
        self.state
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .working = false;
        Ok(())
    }

    /// 唯一无秘密阶段通知；回调自身也计入排空，允许 settled 内安全调用 finish。
    pub fn take_notification(&self) -> Result<Option<Result<(), EngineError>>, EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.notified {
            return Ok(None);
        }
        let Some(outcome) = state.outcome.clone() else {
            return Ok(None);
        };
        state.notified = true;
        state.notifying = true;
        Ok(Some(outcome))
    }

    pub fn finish_notification(&self) -> Result<(), EngineError> {
        self.state
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .notifying = false;
        Ok(())
    }

    pub fn take_completion(&self) -> Result<Option<Result<(), EngineError>>, EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.completed
            || !state.ui_finished
            || state.working
            || state.notifying
            || !state.notified
        {
            return Ok(None);
        }
        state.completed = true;
        state.bound.take();
        self.lease
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .take();
        Ok(Some(
            state
                .outcome
                .clone()
                .unwrap_or_else(|| Err(private_key_view_cancelled())),
        ))
    }
}

fn private_key_view_cancelled() -> EngineError {
    EngineError::Cancelled
}

impl CitizenEngine {
    /// 启动SDK自有钱包监控；没有钱包或尚未同步都是合法初始状态。
    /// 后台具体读取仍复核完整就绪条件，不能因监控启动过早而停掉正在同步的节点。
    pub fn start_chain_monitor(&self) -> EngineFuture<'_, ()> {
        Box::pin(async move {
            self.require_running_capability_admission(&[
                CapabilityName::ChainRead,
                CapabilityName::History,
            ])?;
            let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if state.lifecycle != EngineLifecycle::Running || state.history_paused {
                return Err(lifecycle_error(
                    "chain monitor requires a running, unpaused Engine",
                ));
            }
            let mut monitor = self
                .chain_monitor
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?;
            if !monitor.running {
                monitor.execution_positions.clear();
                monitor.rebroadcasted_executions.clear();
            }
            monitor.running = true;
            Ok(())
        })
    }

    /// 先使旧账户代际不可继续发起读取/CAS；真正的持久化排空由 drain 完成。
    pub fn stop_chain_monitor(&self) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        state.history_paused = true;
        state.history_cancel.cancel();
        // 独立 stop 不得被先前正在执行的钱包变更恢复；更换 token 防止迟到恢复。
        state.history_cancel = Arc::new(crate::chain_monitor::MonitorCancellation::default());
        state.history_cancel.cancel();
        let mut monitor = self
            .chain_monitor
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        monitor.running = false;
        monitor.execution_positions.clear();
        monitor.rebroadcasted_executions.clear();
        Ok(())
    }

    pub fn drain_chain_monitor(&self) -> EngineFuture<'_, ()> {
        Box::pin(std::future::poll_fn(|cx| {
            let mut state = match self.state.lock() {
                Ok(state) => state,
                Err(_) => return std::task::Poll::Ready(Err(EngineError::StatePoisoned)),
            };
            if state.inflight_history_operations == 0 {
                return std::task::Poll::Ready(Ok(()));
            }
            if !state
                .history_drain_waiters
                .iter()
                .any(|w| w.will_wake(cx.waker()))
            {
                state.history_drain_waiters.push(cx.waker().clone());
            }
            std::task::Poll::Pending
        }))
    }

    async fn with_wallet_monitor_paused<T>(
        &self,
        mutation: impl Future<Output = Result<T, EngineError>>,
    ) -> Result<T, EngineError> {
        if !self
            .components
            .modules
            .contains(Modules::CHAIN | Modules::HISTORY)
            || self.components.chain_client.is_none()
            || self.components.transaction_history.is_none()
        {
            return mutation.await;
        }
        self.with_wallet_history_paused(mutation).await
    }

    /// 单一历史协调入口：模块筛选与状态所有权分开，停止不再冒充钱包变更占用。
    async fn with_wallet_history_paused<T>(
        &self,
        mutation: impl Future<Output = Result<T, EngineError>>,
    ) -> Result<T, EngineError> {
        let (generation, cancellation, was_paused) = {
            let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            if state.lifecycle == EngineLifecycle::Disposed {
                return Err(lifecycle_error("wallet mutation requires a live Engine"));
            }
            if state.wallet_mutation_in_progress {
                return Err(lifecycle_error("wallet mutation is already in progress"));
            }
            let was_paused = state.history_paused;
            state.wallet_mutation_in_progress = true;
            state.history_paused = true;
            state.history_cancel.cancel();
            (
                state.generation,
                Arc::clone(&state.history_cancel),
                was_paused,
            )
        };
        // 停止/启动失败只关闭链历史准入，不关闭本地钱包。两种状态都先排空旧读取；
        // 已接纳的store/CAS仍等真实返回，不能用丢弃future或清暂停标志伪造取消。
        let result = match self.drain_chain_monitor().await {
            Ok(()) => mutation.await,
            Err(error) => Err(error),
        };
        {
            let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
            state.wallet_mutation_in_progress = false;
            // 只归还自己取得的临时暂停；停止、失败或并发stop换过的取消代次不复活。
            if !was_paused
                && state.generation == generation
                && Arc::ptr_eq(&state.history_cancel, &cancellation)
                && !matches!(
                    state.lifecycle,
                    EngineLifecycle::Stopped
                        | EngineLifecycle::Disposed
                        | EngineLifecycle::StartFailed
                )
            {
                state.history_paused = false;
                state.history_cancel =
                    Arc::new(crate::chain_monitor::MonitorCancellation::default());
            }
        }
        // 成功和失败都使旧集合失效；下次 tick 从真实 WalletProfileStore 重读，不猜测回滚结果。
        let mut monitor = self
            .chain_monitor
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        monitor.revision = None;
        result
    }

    /// Runs one bounded generic execution reconciliation batch.
    #[cfg(feature = "chain")]
    pub fn poll_chain_monitor(&self) -> EngineFuture<'_, crate::ChainMonitorUpdate> {
        Box::pin(async move {
            {
                let mut monitor = self
                    .chain_monitor
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?;
                if !monitor.running || monitor.polling {
                    return Err(lifecycle_error("chain monitor is stopped or busy"));
                }
                monitor.polling = true;
            }
            struct PollLease<'a>(&'a Mutex<crate::chain_monitor::ChainMonitorState>);
            impl Drop for PollLease<'_> {
                fn drop(&mut self) {
                    if let Ok(mut state) = self.0.lock() {
                        state.polling = false;
                    }
                }
            }
            let _poll = PollLease(&self.chain_monitor);
            let (runtime, guard) = self.prepare_finalized_history_runtime(&[
                CapabilityName::History,
                CapabilityName::ChainRead,
                CapabilityName::TransactionSubmit,
                CapabilityName::TransactionVerify,
            ])?;
            let (local, reconcilable) = self
                .history_service_from_components()?
                .open_batch(1)
                .await?;
            guard.ensure_current()?;
            let has_reconcilable = !reconcilable.is_empty();
            let (mut positions, mut rebroadcasted, chain_revision, should_sync) = {
                let monitor = self
                    .chain_monitor
                    .lock()
                    .map_err(|_| EngineError::StatePoisoned)?;
                (
                    monitor.execution_positions.clone(),
                    monitor.rebroadcasted_executions.clone(),
                    monitor.chain_revision,
                    has_reconcilable
                        || monitor.revision.is_none()
                        || monitor.chain_revision != monitor.synced_chain_revision,
                )
            };
            let mut finalized_block = None;
            let history = if should_sync {
                finalized_block = Some(
                    crate::finalized_history_runtime::cancellable_chain(
                        self.components.chain_client()?.get_finalized_head(),
                        &guard,
                    )
                    .await??,
                );
                let signer = self.components.signer().ok_or_else(|| {
                    EngineError::CapabilityUnavailable("chain_signer_missing".to_owned())
                })?;
                runtime
                    .reconcile_generic_execution_batch(
                        &mut positions,
                        &mut rebroadcasted,
                        signer.as_ref(),
                        &guard,
                    )
                    .await?
            } else {
                local
            };
            guard.ensure_current()?;
            let pending_count = history.open_count();
            let mut monitor = self
                .chain_monitor
                .lock()
                .map_err(|_| EngineError::StatePoisoned)?;
            let history_changed = monitor.revision != Some(history.revision());
            monitor.revision = Some(history.revision());
            monitor.execution_positions = positions;
            monitor.rebroadcasted_executions = rebroadcasted;
            monitor.synced_chain_revision = chain_revision;
            monitor.needs_catchup = false;
            Ok(crate::ChainMonitorUpdate {
                finalized_block,
                history_revision: history.revision(),
                history_changed,
                pending_count,
            })
        })
    }

    pub fn invalidate_chain_read_cache(&self) -> Result<(), EngineError> {
        let mut monitor = self
            .chain_monitor
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?;
        monitor.chain_revision = monitor
            .chain_revision
            .checked_add(1)
            .ok_or_else(|| lifecycle_error("chain notification revision exhausted"))?;
        drop(monitor);
        self.runtime_contexts
            .lock()
            .map_err(|_| EngineError::StatePoisoned)?
            .invalidate_current_best();
        Ok(())
    }
}

/// finalized 协调器持有的不可复用 Engine 代际与完整操作租约。
///
/// guard 从 prepare 开始一直活到所有 provider/store await 与最后一次 CAS 结束。只要
/// guard 存活，stop/dispose 就会失败关闭；这比单纯在 await 前后比较 generation 更强，
/// 因为代际切换无法插入最后一次检查与异步 CAS 之间。
#[cfg(feature = "chain")]
struct EngineHistoryOperationLease {
    state: Arc<Mutex<EngineState>>,
    generation: u64,
    cancellation: Arc<crate::chain_monitor::MonitorCancellation>,
}

#[cfg(feature = "chain")]
impl FinalizedHistoryRunGuard for EngineHistoryOperationLease {
    fn ensure_current(&self) -> Result<(), EngineError> {
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running
            || state.generation != self.generation
            || self.cancellation.is_cancelled()
        {
            return Err(lifecycle_error(
                "finalized history operation outlived its running Engine generation",
            ));
        }
        Ok(())
    }

    fn poll_cancelled(&self, cx: &mut std::task::Context<'_>) -> std::task::Poll<()> {
        self.cancellation.poll_cancelled(cx)
    }
}

#[cfg(feature = "chain")]
impl Drop for EngineHistoryOperationLease {
    fn drop(&mut self) {
        // Drop 不能返回错误；锁若已 poisoned，Engine 后续所有状态入口本来也会失败。
        if let Ok(mut state) = self.state.lock() {
            if let Some(remaining) = state.inflight_history_operations.checked_sub(1) {
                state.inflight_history_operations = remaining;
                if remaining == 0 {
                    for waiter in std::mem::take(&mut state.history_drain_waiters) {
                        waiter.wake();
                    }
                }
            }
        }
    }
}

fn require_no_inflight_history_operations(
    state: &EngineState,
    operation: &str,
) -> Result<(), EngineError> {
    if state.qr_operations != 0 {
        return Err(lifecycle_error(format!(
            "{operation} requires QR authentication and review operations to drain"
        )));
    }
    if state.private_key_views != 0 {
        return Err(lifecycle_error(format!(
            "{operation} requires the private-key view UI and authentication to drain"
        )));
    }
    if state.inflight_history_operations != 0 {
        return Err(lifecycle_error(format!(
            "{operation} requires all finalized history operations to drain"
        )));
    }
    Ok(())
}

fn probes_for_lifecycle(
    mut probes: Vec<CapabilityProbe>,
    lifecycle: EngineLifecycle,
) -> Vec<CapabilityProbe> {
    if lifecycle == EngineLifecycle::Disposed {
        for probe in &mut probes {
            probe.runtime_ready = false;
            probe.not_ready_reason = Some(CapabilityReason::EngineNotRunning);
        }
    }
    if lifecycle != EngineLifecycle::Running {
        if let Some(chain_read) = probes
            .iter_mut()
            .find(|probe| probe.name == CapabilityName::ChainRead)
        {
            chain_read.runtime_ready = false;
            chain_read.not_ready_reason = Some(CapabilityReason::EngineNotRunning);
        }
    }
    probes
}

struct StateImportReservation {
    state: Arc<Mutex<EngineState>>,
    generation: u64,
    provider_invoked: bool,
    committed: bool,
}

impl StateImportReservation {
    const fn new(state: Arc<Mutex<EngineState>>, generation: u64) -> Self {
        Self {
            state,
            generation,
            provider_invoked: false,
            committed: false,
        }
    }

    fn mark_provider_invoked(&mut self) -> Result<(), EngineError> {
        let state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::ImportingState || state.generation != self.generation
        {
            return Err(lifecycle_error(
                "state import lost its lifecycle reservation before provider mutation",
            ));
        }
        self.provider_invoked = true;
        Ok(())
    }

    fn commit(&mut self, finalized: FinalizedBlockRef) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::ImportingState || state.generation != self.generation
        {
            return Err(lifecycle_error(
                "state import completed after its lifecycle generation ended",
            ));
        }
        state.lifecycle = EngineLifecycle::Created;
        state.provisional_import = Some(finalized);
        self.committed = true;
        Ok(())
    }
}

impl Drop for StateImportReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state.lifecycle == EngineLifecycle::ImportingState
                && state.generation == self.generation
            {
                if self.provider_invoked {
                    state.lifecycle = EngineLifecycle::StartFailed;
                    state.generation = state.generation.saturating_add(1);
                } else {
                    state.lifecycle = EngineLifecycle::Created;
                }
            }
        }
    }
}

struct StateExportReservation {
    state: Arc<Mutex<EngineState>>,
    generation: u64,
    verified_finalized: Option<FinalizedBlockRef>,
    committed: bool,
}

impl StateExportReservation {
    const fn new(
        state: Arc<Mutex<EngineState>>,
        generation: u64,
        verified_finalized: Option<FinalizedBlockRef>,
    ) -> Self {
        Self {
            state,
            generation,
            verified_finalized,
            committed: false,
        }
    }

    fn commit(&mut self, finalized: FinalizedBlockRef) -> Result<(), EngineError> {
        let mut state = self.state.lock().map_err(|_| EngineError::StatePoisoned)?;
        if state.lifecycle != EngineLifecycle::Running || state.generation != self.generation {
            return Err(lifecycle_error(
                "state export completed after its lifecycle generation ended",
            ));
        }
        state.export_in_progress = false;
        state.verified_finalized = Some(finalized);
        self.committed = true;
        Ok(())
    }
}

impl Drop for StateExportReservation {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state.generation == self.generation {
                state.export_in_progress = false;
            }
        }
    }
}

fn next_generation(current: u64) -> Result<u64, EngineError> {
    current
        .checked_add(1)
        .ok_or_else(|| lifecycle_error("engine lifecycle generation overflowed"))
}

/// Validate a persisted public light-client snapshot before any provider
/// mutation. The typed host codec protects its binary shape; the Engine still
/// owns CitizenChain identity, format, size and genesis semantics.
fn validate_persisted_chain_state(
    snapshot: &ChainDatabaseSnapshot,
) -> Result<Option<FinalizedBlockRef>, EngineError> {
    let Some(state) = snapshot.state() else {
        return Ok(None);
    };
    validate_state_import(
        &StateImportPolicy::citizenchain(None),
        EngineLifecycle::Created,
        state,
    )
    .map_err(state_rejection_error)?;
    Ok(Some(state.finalized()))
}

/// Build the one exact revisioned fact expected after a chain-database CAS.
/// Computing this before a provider import proves revision capacity before the
/// provider receives the irreversible database mutation.
fn next_chain_database_snapshot(
    current: &ChainDatabaseSnapshot,
    candidate: ExportedChainState,
) -> Result<ChainDatabaseSnapshot, EngineError> {
    let revision = current
        .revision()
        .checked_add(1)
        .ok_or_else(|| lifecycle_error("chain database revision is exhausted"))?;
    Ok(ChainDatabaseSnapshot::new(revision, Some(candidate)))
}

/// Persist one exact chain-database candidate and converge only the ambiguous
/// "write committed, then host reported failure" case. A state-only match at
/// another revision is deliberately insufficient: revision is part of the
/// durable fact and prevents a competing writer from being mistaken for this
/// operation.
async fn persist_chain_database_exact(
    store: &Arc<dyn ChainDatabaseStore>,
    expected_revision: u64,
    expected: ChainDatabaseSnapshot,
) -> Result<(), EngineError> {
    let candidate = expected.state().cloned().ok_or_else(|| {
        EngineError::contract(
            ContractErrorCode::Internal,
            "persistent chain database candidate unexpectedly omitted state",
        )
    })?;
    match store
        .compare_and_swap(expected_revision, Some(candidate))
        .await
    {
        Ok(observed) if observed == expected => Ok(()),
        Ok(_) => Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "chain database CAS returned a fact other than the exact revisioned candidate",
        )),
        Err(write_error) => {
            let observed = store.load().await;
            if observed
                .as_ref()
                .is_ok_and(|snapshot| snapshot == &expected)
            {
                Ok(())
            } else {
                Err(EngineError::from(write_error))
            }
        }
    }
}

fn merge_finalized_anchors(
    left: Option<FinalizedBlockRef>,
    right: Option<FinalizedBlockRef>,
) -> Result<Option<FinalizedBlockRef>, EngineError> {
    match (left, right) {
        (None, None) => Ok(None),
        (Some(anchor), None) | (None, Some(anchor)) => Ok(Some(anchor)),
        (Some(left), Some(right)) if left.number() == right.number() => {
            if left.hash() == right.hash() {
                Ok(Some(left))
            } else {
                Err(EngineError::BlockContextMismatch(
                    "persisted and provisional finalized anchors conflict at one height".to_owned(),
                ))
            }
        }
        (Some(left), Some(right)) => Ok(Some(if left.number() > right.number() {
            left
        } else {
            right
        })),
    }
}

fn lifecycle_error(reason: impl Into<String>) -> EngineError {
    EngineError::contract(ContractErrorCode::InvalidState, reason)
}

fn component_missing(name: &str) -> EngineError {
    EngineError::CapabilityUnavailable(format!("{name}_missing"))
}

fn state_rejection_error(rejection: StateImportRejection) -> EngineError {
    let code = match rejection {
        StateImportRejection::ProviderAlreadyStarted
        | StateImportRejection::ExportLifecycleInvalid => ContractErrorCode::InvalidState,
        StateImportRejection::FormatVersionMismatch => ContractErrorCode::Unsupported,
        StateImportRejection::DatabaseTooLarge => ContractErrorCode::InvalidArgument,
        StateImportRejection::ChainIdentityMismatch
        | StateImportRejection::GenesisAnchorMismatch
        | StateImportRejection::FinalizedHeightRegression
        | StateImportRejection::FinalizedHashConflict
        | StateImportRejection::StartupAnchorRegression
        | StateImportRejection::ExportAnchorMoved
        | StateImportRejection::ExportEnvelopeMismatch => ContractErrorCode::Integrity,
    };
    EngineError::contract(code, format!("{rejection:?}"))
}

const fn unverified(
    block: VerifiedBlockRef,
    extrinsic_index: Option<u32>,
    reason: UnverifiedReason,
) -> ExecutionConclusion {
    ExecutionConclusion::Unverified {
        block: Some(block),
        extrinsic_index,
        reason,
    }
}

#[cfg(test)]
mod chain_query_tests {
    use super::*;

    #[cfg(not(feature = "chain"))]
    #[test]
    fn static_genesis_does_not_enable_an_uncompiled_chain_module() {
        let engine = CitizenEngine::new(EngineComponents::new(
            None, None, None, None, None, None, None, None,
        ));
        assert!(
            matches!(engine.genesis_hash(), Err(EngineError::Contract(error))
            if error.code() == ContractErrorCode::Unsupported)
        );
    }

    // 用原状态协调入口验证所有权，不触碰实际钱包、存储或硬件认证。
    fn local_engine(lifecycle: EngineLifecycle) -> CitizenEngine {
        let engine = CitizenEngine::new(EngineComponents::new(
            None, None, None, None, None, None, None, None,
        ));
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
            futures::executor::block_on(engine.with_wallet_history_paused(async { Ok(()) }))
                .is_ok()
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
            futures::executor::block_on(engine.with_wallet_history_paused(async { Ok(()) }))
                .is_err()
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
        let engine = CitizenEngine::new(EngineComponents::new(
            None, None, None, None, None, None, None, None,
        ));
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
}
