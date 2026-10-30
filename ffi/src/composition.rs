//! 所有原生入口共用唯一模块化产品装配。
//!
//! 钱包管理与签名只共享受保护的账户归属和设备金库，历史独立装配。
//! 未选择模块时不创建替身链、内存钱包或软件金库。

use std::sync::{Arc, Mutex};

use citizen_sdk_contracts::{
    ChainDatabaseSnapshot, ChainDatabaseStore, ChainSigner, ContractError, ContractErrorCode,
    ContractFuture, EncryptedSecretBlobStore, ExportedChainState, Modules, RuntimeCacheStore,
    SecretVault, TransactionHistoryStore, VaultAvailability, WalletProfileStore,
};
use citizen_sdk_engine::{CitizenEngine, EngineComponents};
#[cfg(feature = "chain")]
use crate::node::{SmoldotProviderConfig, SmoldotVerifiedChainClient};
#[cfg(feature = "signing")]
use citizen_signer::Sr25519SoftwareSigner;

use crate::{
    abi::CitizenSdkHostServicesV1,
    capabilities::{product_probes, ProductCapabilityFacts},
    error::{FfiError, FfiResult},
    host_providers::HostServicesAdapter,
};

/// 当前公开 ABI 会话的公开链数据库信封。
///
/// 它只承接同一 `CitizenSdkHandle` 生命周期内的 import/export CAS，不耐久，也不允许
/// 钱包资料、交易历史、密文或秘密进入。真正的平台耐久实现必须单独履行
/// `ChainDatabaseStore`，不能把本类型描述成设备数据库。
pub(crate) struct SessionChainDatabaseStore {
    snapshot: Mutex<ChainDatabaseSnapshot>,
}

impl SessionChainDatabaseStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }
}

impl Default for SessionChainDatabaseStore {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(ChainDatabaseSnapshot::new(0, None)),
        }
    }
}

impl ChainDatabaseStore for SessionChainDatabaseStore {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        let result = self
            .snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| {
                ContractError::new(
                    ContractErrorCode::Internal,
                    "CitizenSDK 会话链数据库状态已损坏",
                )
            });
        Box::pin(async move { result })
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        state: Option<ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        let result = self.snapshot.lock().map_err(|_| {
            ContractError::new(
                ContractErrorCode::Internal,
                "CitizenSDK 会话链数据库状态已损坏",
            )
        });
        let result = result.and_then(|mut snapshot| {
            if snapshot.revision() != expected_revision {
                return Err(ContractError::new(
                    ContractErrorCode::Conflict,
                    "CitizenSDK 会话链数据库 CAS revision 已变化",
                ));
            }
            let revision = expected_revision.checked_add(1).ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::Internal,
                    "CitizenSDK 会话链数据库 revision 已耗尽",
                )
            })?;
            *snapshot = ChainDatabaseSnapshot::new(revision, state);
            Ok(snapshot.clone())
        });
        Box::pin(async move { result })
    }
}

/// 钱包管理与本地签名共享的账户安全边界，不包含交易历史。
/// 密码学实现仍由 SDK 固定；宿主不能注入 signer 或 nonce 实现。
#[derive(Clone)]
pub(crate) struct ProductWalletProviders {
    secret_vault: Arc<dyn SecretVault>,
    wallet_profiles: Arc<dyn WalletProfileStore>,
    encrypted_secrets: Arc<dyn EncryptedSecretBlobStore>,
}

impl ProductWalletProviders {
    pub(crate) fn new(
        secret_vault: Arc<dyn SecretVault>,
        wallet_profiles: Arc<dyn WalletProfileStore>,
        encrypted_secrets: Arc<dyn EncryptedSecretBlobStore>,
    ) -> Self {
        Self {
            secret_vault,
            wallet_profiles,
            encrypted_secrets,
        }
    }
}

/// 类型化宿主资源；资源存在不能代替不可变的模块选择或授权。
pub(crate) struct ProductHostProviders {
    chain_database: Option<Arc<dyn ChainDatabaseStore>>,
    runtime_cache: Option<Arc<dyn RuntimeCacheStore>>,
    wallet: Option<ProductWalletProviders>,
    history: Option<Arc<dyn TransactionHistoryStore>>,
}

impl ProductHostProviders {
    pub(crate) fn public_abi_session() -> Self {
        Self {
            chain_database: Some(Arc::new(SessionChainDatabaseStore::new())),
            runtime_cache: None,
            wallet: None,
            history: None,
        }
    }

    pub(crate) fn new(
        chain_database: Option<Arc<dyn ChainDatabaseStore>>,
        runtime_cache: Option<Arc<dyn RuntimeCacheStore>>,
        wallet: Option<ProductWalletProviders>,
        history: Option<Arc<dyn TransactionHistoryStore>>,
    ) -> Self {
        Self {
            chain_database,
            runtime_cache,
            wallet,
            history,
        }
    }
}

/// 必须先校验，再读取资产、调用回调或创建设备存储与金库。
pub(crate) fn validate_modules(bits: u32) -> FfiResult<Modules> {
    let modules = Modules::try_new(bits)?;
    let compiled = (if cfg!(feature = "wallet") {
        Modules::WALLET
    } else {
        0
    }) | (if cfg!(feature = "signing") {
        Modules::SIGNING
    } else {
        0
    }) | (if cfg!(feature = "chain") {
        Modules::CHAIN
    } else {
        0
    }) | (if cfg!(feature = "transactions") {
        Modules::TRANSACTIONS
    } else {
        0
    }) | (if cfg!(feature = "history") {
        Modules::HISTORY
    } else {
        0
    }) | (if cfg!(feature = "qr") { Modules::QR } else { 0 });
    if bits & !compiled != 0 {
        return Err(FfiError::new(
            crate::abi::CitizenSdkErrorCode::Unsupported,
            "requested modules are not compiled into this CitizenSDK build",
        ));
    }
    Ok(modules)
}

pub(crate) struct ProductComposition {
    #[cfg(feature = "chain")]
    provider: Option<Arc<SmoldotVerifiedChainClient>>,
    engine: Arc<CitizenEngine>,
    modules: Modules,
    wallet: Option<ProductWalletProviders>,
    history: Option<Arc<dyn TransactionHistoryStore>>,
    host_services: Option<HostServicesAdapter>,
    durable_store: bool,
}

impl ProductComposition {
    pub(crate) unsafe fn set_secret_presence_provider(
        &self,
        provider: crate::host_providers::CitizenSdkHostSecretPresenceV1,
    ) -> FfiResult<()> {
        let host = self.host_services.as_ref().ok_or_else(|| {
            FfiError::new(
                crate::abi::CitizenSdkErrorCode::Unsupported,
                "实例没有Host服务",
            )
        })?;
        unsafe { host.set_secret_presence_provider(provider) }.map_err(FfiError::from)
    }

    pub(crate) fn private_key_view_vault(
        &self,
        authorizing: Arc<dyn Fn(u64) -> i32 + Send + Sync>,
    ) -> Option<Arc<dyn SecretVault>> {
        self.host_services
            .as_ref()
            .and_then(|host| host.private_key_view_vault(authorizing))
    }



    /// 所有公开构造最终进入此处；校验不调用宿主回调。
    /// 真实就绪探测留在工作线程执行，避免主线程等待自身认证回调形成死锁。
    ///
    /// # Safety
    /// See host_abi for the lifetime of non-null host vtables.
    pub(crate) unsafe fn module_abi(
        combined_chain_spec: Option<String>,
        system_name: String,
        system_version: String,
        services: Option<&CitizenSdkHostServicesV1>,
        modules: Modules,
        store: Option<crate::store::Stores>,
    ) -> FfiResult<Self> {
        validate_modules(modules.bits())?;
        let secure_selected = modules.bits() & (Modules::WALLET | Modules::SIGNING) != 0;
        let durable = store.as_ref().is_some_and(|value| value.public.is_some());
        let (host, adapter) = if let Some(store) = store {
            if services.is_some() {
                return Err(FfiError::invalid(
                    "default stores cannot be combined with custom host callbacks",
                ));
            }
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
                .map(|db| Arc::new(citizen_sdk_store::PublicStore::new(db)));
            let secure = store
                .secure
                .map(|db| Arc::new(citizen_sdk_store::SecureStore::new(db)));
            let wallet = if let Some(secure) = secure {
                Some(ProductWalletProviders::new(
                    store
                        .vault
                        .as_ref()
                        .and_then(|value| value.secret_vault())
                        .ok_or_else(|| FfiError::invalid("device vault missing"))?,
                    Arc::clone(&secure) as Arc<dyn WalletProfileStore>,
                    secure as Arc<dyn EncryptedSecretBlobStore>,
                ))
            } else {
                None
            };
            (
                ProductHostProviders::new(
                    if modules.contains(Modules::CHAIN) {
                        public
                            .as_ref()
                            .map(|value| Arc::clone(value) as Arc<dyn ChainDatabaseStore>)
                    } else {
                        None
                    },
                    if modules.contains(Modules::CHAIN) {
                        public
                            .as_ref()
                            .map(|value| Arc::clone(value) as Arc<dyn RuntimeCacheStore>)
                    } else {
                        None
                    },
                    wallet,
                    if modules.contains(Modules::HISTORY) {
                        public.map(|value| value as Arc<dyn TransactionHistoryStore>)
                    } else {
                        None
                    },
                ),
                store.vault,
            )
        } else {
            let adapter = services
                .map(|value| unsafe { HostServicesAdapter::try_from_ffi(value) })
                .transpose()
                .map_err(FfiError::from)?;
            let host = if let Some(adapter) = adapter.as_ref() {
                let wallet = if secure_selected {
                    match (
                        adapter.secret_vault(),
                        adapter.wallet_profile_store(),
                        adapter.encrypted_secret_blob_store(),
                    ) {
                        (Some(vault), Some(profiles), Some(secrets)) => {
                            Some(ProductWalletProviders::new(vault, profiles, secrets))
                        }
                        _ => {
                            return Err(FfiError::invalid(
                                "wallet/signing requires complete secure host services",
                            ))
                        }
                    }
                } else {
                    None
                };
                if modules.contains(Modules::CHAIN) && !adapter.has_chain_database() {
                    return Err(FfiError::invalid("chain requires typed database callbacks"));
                }
                if modules.contains(Modules::HISTORY) && !adapter.has_history() {
                    return Err(FfiError::invalid("history requires typed callbacks"));
                }
                ProductHostProviders::new(
                    modules
                        .contains(Modules::CHAIN)
                        .then(|| adapter.chain_database_store()),
                    (modules.contains(Modules::CHAIN) && adapter.has_runtime_cache())
                        .then(|| adapter.runtime_cache_store()),
                    wallet,
                    modules
                        .contains(Modules::HISTORY)
                        .then(|| adapter.transaction_history_store()),
                )
            } else {
                if secure_selected || modules.contains(Modules::HISTORY) {
                    return Err(FfiError::invalid("selected modules require host services"));
                }
                ProductHostProviders::public_abi_session()
            };
            (host, adapter)
        };
        #[cfg(feature = "chain")]
        let provider = if modules.contains(Modules::CHAIN) {
            let config = SmoldotProviderConfig::try_new(
                combined_chain_spec
                    .ok_or_else(|| FfiError::invalid("chain assets are required"))?,
                system_name,
                system_version,
            )?
            .with_bootstrap();
            Some(SmoldotVerifiedChainClient::new(config)?)
        } else {
            None
        };
        #[cfg(not(feature = "chain"))]
        let _ = (combined_chain_spec, system_name, system_version);
        let mut composition = Self::compose(
            #[cfg(feature = "chain")]
            provider,
            host,
            modules,
        )?;
        composition.host_services = adapter;
        composition.durable_store = durable;
        Ok(composition)
    }



    pub(crate) fn compose(
        #[cfg(feature = "chain")] provider: Option<Arc<SmoldotVerifiedChainClient>>,
        host: ProductHostProviders,
        modules: Modules,
    ) -> FfiResult<Self> {
        #[cfg(feature = "chain")]
        let chain_client = provider
            .as_ref()
            .map(|provider| Arc::clone(provider) as Arc<dyn citizen_sdk_contracts::VerifiedChainClient>);
        #[cfg(not(feature = "chain"))]
        let chain_client = None;
        #[cfg(feature = "signing")]
        let signer = host
            .wallet
            .as_ref()
            .map(|_| Arc::new(Sr25519SoftwareSigner) as Arc<dyn ChainSigner>);
        #[cfg(not(feature = "signing"))]
        let signer = None;
        let mut components = EngineComponents::new(
            chain_client,
            signer,
            host.wallet
                .as_ref()
                .map(|wallet| Arc::clone(&wallet.secret_vault)),
            host.chain_database,
            host.runtime_cache,
            host.wallet
                .as_ref()
                .map(|wallet| Arc::clone(&wallet.wallet_profiles)),
            host.history.clone(),
            host.wallet
                .as_ref()
                .map(|wallet| Arc::clone(&wallet.encrypted_secrets)),
        )
        .with_modules(modules);
        #[cfg(feature = "chain")]
        if let Some(provider) = provider.as_ref() {
            components = components.with_account_nonce_source(Arc::clone(provider) as Arc<dyn citizen_sdk_contracts::AccountNonceSource>);
        }
        let composition = Self {
            #[cfg(feature = "chain")]
            provider,
            engine: Arc::new(CitizenEngine::new(components)),
            modules,
            wallet: host.wallet,
            history: host.history,
            host_services: None,
            durable_store: false,
        };
        let facts = if composition.wallet.is_some() {
            ProductCapabilityFacts::wallet_configured()
        } else {
            ProductCapabilityFacts::chain_only()
        };
        composition.engine.update_capabilities(product_probes(
            false,
            facts,
            modules,
            composition.history.is_some(),
        ))?;
        Ok(composition)
    }

    pub(crate) fn engine(&self) -> &Arc<CitizenEngine> {
        &self.engine
    }

    pub(crate) const fn has_modules(&self, bits: u32) -> bool {
        self.modules.contains(bits)
    }

    #[cfg(feature = "chain")]
    pub(crate) fn provider(&self) -> Option<&Arc<SmoldotVerifiedChainClient>> {
        self.provider.as_ref()
    }

    /// 只有实际耐久链仓储参与生命周期恢复／持久化，不能从任意宿主资源推断。
    pub(crate) fn uses_host_services(&self) -> bool {
        self.modules.contains(Modules::CHAIN)
            && (self.durable_store || self.host_services.is_some())
    }

    /// Orphaned host operations can outlive a cancelled Engine future. They
    /// retain Rust-owned buffers and the host callback contract, so destroy
    /// must remain recoverably busy until their one completion arrives.
    pub(crate) fn require_no_pending_host_operations(&self) -> FfiResult<()> {
        let Some(host) = self.host_services.as_ref() else {
            return Ok(());
        };
        if host.pending_host_operations().map_err(FfiError::from)? == 0 {
            Ok(())
        } else {
            Err(FfiError::new(
                crate::abi::CitizenSdkErrorCode::Busy,
                "host operations are still pending; retry destroy after completion",
            ))
        }
    }

    /// Freezes host-operation reservation before destroy preflight scans the
    /// pending registry. The adapter linearizes this gate with insertion, so a
    /// successful close cannot be followed by an unobserved reservation.
    pub(crate) fn close_host_operation_gate(&self) -> FfiResult<()> {
        self.host_services
            .as_ref()
            .map_or(Ok(()), |host| host.close_host_operation_gate())
            .map_err(FfiError::from)
    }

    /// Restores a gate closed by a recoverable destroy preflight. This is used
    /// only before teardown side effects, while the instance must remain fully
    /// usable after returning `BUSY`.
    pub(crate) fn reopen_host_operation_gate(&self) -> FfiResult<()> {
        self.host_services
            .as_ref()
            .map_or(Ok(()), |host| host.reopen_host_operation_gate())
            .map_err(FfiError::from)
    }

    pub(crate) fn capability_probes(
        &self,
        provider_is_usable: bool,
    ) -> Vec<citizen_sdk_engine::CapabilityProbe> {
        product_probes(
            provider_is_usable,
            self.wallet_capability_facts(true),
            self.modules,
            self.history.is_some(),
        )
    }

    /// 本地仓储和金库的排空不需要 smoldot；仅对实际存在的 provider 排空订阅。
    pub(crate) fn stop_and_drain_product_services(&self) -> FfiResult<()> {
        self.engine.stop_chain_monitor()?;
        futures_executor::block_on(self.engine.drain_chain_monitor()).map_err(FfiError::from)?;
        #[cfg(feature = "chain")]
        if let Some(provider) = self.provider.as_ref() {
            if matches!(
                provider.lifecycle(),
                Ok(crate::node::ProviderLifecycle::Running)
            ) {
                provider
                    .drive(provider.drain_finalized_subscriptions())?
                    .map_err(FfiError::from)?;
            }
        }
        Ok(())
    }

    pub(crate) fn has_wallet_services(&self) -> bool {
        self.modules
            .contains(Modules::WALLET | Modules::CHAIN | Modules::HISTORY)
            && self.wallet.is_some()
            && self.history.is_some()
    }

    /// 本地钱包操作只探测自身仓储/金库，链与历史事实由各自刷新维护。
    pub(crate) fn local_wallet_probes(&self) -> Vec<citizen_sdk_engine::CapabilityProbe> {
        product_probes(
            false,
            self.wallet_capability_facts(false),
            self.modules,
            self.history.is_some(),
        )
    }

    fn wallet_capability_facts(&self, probe_history: bool) -> ProductCapabilityFacts {
        let history_store_ready = probe_history
            && self
                .history
                .as_ref()
                .is_some_and(|history| futures_executor::block_on(history.load_index()).is_ok());
        let Some(wallet) = self.wallet.as_ref() else {
            return ProductCapabilityFacts::chain_only().with_history(history_store_ready, false);
        };
        let vault_availability = futures_executor::block_on(wallet.secret_vault.availability())
            .unwrap_or(VaultAvailability::Unavailable);
        let wallet_state = futures_executor::block_on(wallet.wallet_profiles.load()).ok();
        let wallet_store_ready = wallet_state.is_some();
        // A missing envelope never grants signing readiness. Empty wallet state
        // remains creatable; actual signing still requires a current account.
        let encrypted_secrets_ready = wallet_state.as_ref().is_some_and(|state| {
            state.profile().is_none_or(|profile| profile.accounts().iter().all(|account| {
                matches!(futures_executor::block_on(wallet.encrypted_secrets.load(account.secret_ref())),
                    Ok(snapshot) if snapshot.envelope().is_some())
            }))
        });
        let wallet_key_ready = vault_availability == VaultAvailability::Available
            && wallet_state.as_ref().is_some_and(|state| {
                state.profile().is_none_or(|profile| {
                    matches!(
                        futures_executor::block_on(
                            wallet
                                .secret_vault
                                .has_wallet_key(profile.wallet_index(), profile.generation())
                        ),
                        Ok(true)
                    )
                })
            });
        ProductCapabilityFacts::wallet(
            vault_availability,
            wallet_store_ready,
            encrypted_secrets_ready,
            wallet_key_ready,
            history_store_ready,
            false,
        )
    }
}

#[cfg(test)]
#[path = "../tests/composition.rs"]
mod tests;
