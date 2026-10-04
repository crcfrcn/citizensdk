// 固定公开夹具损坏时立即失败；不改变生产错误处理。
#![allow(clippy::unwrap_used)]

use std::sync::Arc;

#[test]
fn native_assets_reject_every_manifest_drift_before_provider_creation() {
    let original: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../chain/manifest.json"))
            .unwrap();
    let spec = include_bytes!("../../../chain/chainspec.json");
    let sync = include_bytes!("../../../chain/light_sync_state.json");
    for (key, value) in [
        ("extra", serde_json::Value::Bool(true)),
        ("chain_id", "other-network".into()),
        ("protocol_id", "other-protocol".into()),
        ("product_id", "other-product".into()),
        ("format_version", 2.into()),
        ("sdk_min_version", "99.0.0".into()),
        ("genesis_hash", format!("0x{}", "00".repeat(32)).into()),
        ("chainspec_sha256", "00".repeat(32).into()),
        ("light_sync_state_sha256", "00".repeat(32).into()),
    ] {
        let mut candidate = original.clone();
        candidate[key] = value;
        assert!(
            crate::assets::verify_assets(&serde_json::to_vec(&candidate).unwrap(), spec, sync)
                .is_err(),
            "{key}"
        );
    }
    for key in original.as_object().unwrap().keys() {
        let mut candidate = original.clone();
        candidate.as_object_mut().unwrap().remove(key);
        assert!(
            crate::assets::verify_assets(&serde_json::to_vec(&candidate).unwrap(), spec, sync)
                .is_err(),
            "missing {key}"
        );
    }
    let mut changed_sync = sync.to_vec();
    changed_sync.push(b' ');
    assert!(crate::assets::verify_assets(
        &serde_json::to_vec(&original).unwrap(),
        spec,
        &changed_sync
    )
    .is_err());
}

use citizen_sdk_contracts::{
    CapabilityName, CapabilityReason, ChainDatabaseStore, ContractError, ContractErrorCode,
    ContractFuture, EncryptedSecretBlobSnapshot, EncryptedSecretBlobState,
    EncryptedSecretBlobStore, EncryptedSecretEnvelope, SecretBuffer, SecretRef, SecretVault,
    TransactionExecutionId, TransactionHistoryCursor, TransactionHistoryIndex,
    TransactionHistoryMutation, TransactionHistoryQueryKind, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore, VaultAvailability, VaultGeneration,
    WalletProfileStore, WalletState,
};
use citizen_sdk_engine::resolve_capabilities;
#[cfg(feature = "chain")]
use citizen_sdk_smoldot_provider::SmoldotProviderConfig;

use crate::composition::{
    ProductComposition, ProductHostProviders, ProductWalletProviders, SessionChainDatabaseStore,
};

struct FakeVault {
    availability: VaultAvailability,
    has_wallet_key: bool,
}

impl SecretVault for FakeVault {
    fn authorize_add_accounts(&self, _: [u8; 16], _: u32, _: VaultGeneration) -> ContractFuture<'_, ()> {
        panic!("此夹具不得执行追加认证")
    }
    fn ensure_wallet_key(&self, _: [u8; 16], _: u32, _: VaultGeneration) -> ContractFuture<'_, ()> {
        Box::pin(async { Err(ContractError::new(ContractErrorCode::Unsupported, "装配夹具不创建金库钥")) })
    }
    fn has_any_wallet_key(&self, _wallet_index: u32) -> ContractFuture<'_, bool> {
        Box::pin(async { Err(ContractError::new(ContractErrorCode::Unsupported, "该装配夹具不模拟物理钥枚举")) })
    }

    fn availability(&self) -> ContractFuture<'_, VaultAvailability> {
        let availability = self.availability;
        Box::pin(async move { Ok(availability) })
    }

    fn seal(
        &self,
        _provisioning_operation_id: [u8; 16],
        _secret_ref: SecretRef,
        secret: SecretBuffer,
    ) -> ContractFuture<'_, EncryptedSecretEnvelope> {
        Box::pin(async move {
            drop(secret);
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "fake vault 不执行 seal",
            ))
        })
    }

    fn open(
        &self,
        _secret_ref: SecretRef,
        _envelope: EncryptedSecretEnvelope,
    ) -> ContractFuture<'_, SecretBuffer> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "fake vault 不执行 open",
            ))
        })
    }

    fn has_wallet_key(
        &self,
        _wallet_index: u32,
        _generation: VaultGeneration,
    ) -> ContractFuture<'_, bool> {
        let has_wallet_key = self.has_wallet_key;
        Box::pin(async move { Ok(has_wallet_key) })
    }

    fn delete_wallet_key(
        &self,
        _cleanup_operation_id: [u8; 16],
        _wallet_index: u32,
        _generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

struct FakeWalletProfileStore {
    fail_load: bool,
}

impl WalletProfileStore for FakeWalletProfileStore {
    fn load(&self) -> ContractFuture<'_, WalletState> {
        let fail_load = self.fail_load;
        Box::pin(async move {
            if fail_load {
                Err(ContractError::new(
                    ContractErrorCode::Storage,
                    "fake wallet profile storage failure",
                ))
            } else {
                Ok(WalletState::empty())
            }
        })
    }

    fn compare_and_swap(
        &self,
        _expected_revision: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState> {
        Box::pin(async move { Ok(next) })
    }
}

struct FakeEncryptedSecretStore;

#[cfg(feature = "wallet")]
struct PrivateKeyViewProfileStore {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::Mutex<Option<futures_channel::oneshot::Receiver<()>>>,
}

#[cfg(feature = "wallet")]
impl WalletProfileStore for PrivateKeyViewProfileStore {
    fn load(&self) -> ContractFuture<'_, WalletState> {
        Box::pin(async move {
            let gate = self.release.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = self.entered.send(());
                let _ = gate.await;
            }
            Ok(WalletState::empty())
        })
    }
    fn compare_and_swap(&self, _: u64, _: WalletState) -> ContractFuture<'_, WalletState> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "查看测试不允许写入",
            ))
        })
    }
}

#[cfg(feature = "wallet")]
#[test]
fn private_receiver_cancel_finish_and_reentrant_settled_drain_real_pending_prepare() {
    use crate::{abi::*, citizensdk_destroy, citizensdk_result_release, wallet_abi::*};
    use std::{ffi::c_void, mem::size_of, sync::mpsc, time::Duration};
    struct ViewContext {
        handle: CitizenSdkHandle,
        settled: mpsc::Sender<(u64, i32, i32)>,
        events: mpsc::Sender<CitizenSdkEvent>,
        received: std::sync::atomic::AtomicBool,
    }
    unsafe extern "C" fn receive(context: *mut c_void, _: u64, _: CitizenSdkBytesView) -> i32 {
        let context = unsafe { &*context.cast::<ViewContext>() };
        context
            .received
            .store(true, std::sync::atomic::Ordering::SeqCst);
        CitizenSdkErrorCode::Internal as i32
    }
    unsafe extern "C" fn settled(context: *mut c_void, view_id: u64, code: i32) {
        let context = unsafe { &*context.cast::<ViewContext>() };
        // 本用例不交付秘密；在阶段通知内确认接收副本已归还，仍须等待真实准备排空。
        let finished =
            unsafe { citizensdk_private_key_finish(context.handle, view_id) };
        let _ = context.settled.send((view_id, code, finished));
    }
    unsafe extern "C" fn event(context: *mut c_void, event: *const CitizenSdkEvent) {
        let context = unsafe { &*context.cast::<ViewContext>() };
        let event = unsafe { *event };
        if event.event_type == CitizenSdkEventType::RequestCompleted as u32 {
            let _ = context.events.send(event);
        }
    }
    unsafe extern "C" fn authorizing(_: *mut c_void, _: u64, _: u64) -> i32 {
        0
    }
    let (entered, entered_rx) = mpsc::channel();
    let (release, gate) = futures_channel::oneshot::channel();
    let composition = ProductComposition::compose(
        #[cfg(feature = "chain")]
        None,
        ProductHostProviders::new(
            None,
            None,
            Some(ProductWalletProviders::new(
                Arc::new(FakeVault {
                    availability: VaultAvailability::Available,
                    has_wallet_key: false,
                }),
                Arc::new(PrivateKeyViewProfileStore {
                    entered,
                    release: std::sync::Mutex::new(Some(gate)),
                }),
                Arc::new(FakeEncryptedSecretStore),
            )),
            None,
        ),
        citizen_sdk_contracts::Modules::try_new(citizen_sdk_contracts::Modules::WALLET).unwrap(),
    )
    .unwrap();
    let handle = crate::handles::reserve_handle().unwrap();
    let runtime = crate::runtime::NativeRuntime::new_with_composition(
        handle,
        composition,
        &crate::ownership::RESULT_HANDLES,
    )
    .unwrap();
    crate::handles::insert(runtime.clone()).unwrap();
    let (settled_tx, settled_rx) = mpsc::channel();
    let (events, events_rx) = mpsc::channel();
    let mut context = Box::new(ViewContext {
        handle,
        settled: settled_tx,
        events,
        received: false.into(),
    });
    let context_pointer = (&mut *context as *mut ViewContext).cast();
    runtime
        .set_event_callback(Some(event), context_pointer)
        .unwrap();
    let table = CitizenSdkPrivateKeyReceiverV1 {
        struct_size: size_of::<CitizenSdkPrivateKeyReceiverV1>() as u32,
        abi_version: 1,
        context: context_pointer,
        receive: Some(receive),
        settled: Some(settled),
        authorizing: Some(authorizing),
    };
    let mut view_id = 0;
    let mut request_id = 0;
    let account_id = CitizenSdkAccountId { bytes: [0; 32] };
    unsafe {
        assert_eq!(
            citizensdk_private_key_open(
                handle,
                &account_id,
                &table,
                &mut view_id,
                &mut request_id
            ),
            0
        );
    }
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    unsafe {
        assert_eq!(
            citizensdk_private_key_reveal(handle, view_id),
            0,
            "确认可以在准备完成前登记"
        );
        assert_eq!(
            citizensdk_private_key_reveal(handle, view_id),
            CitizenSdkErrorCode::Conflict as i32
        );
        assert_eq!(citizensdk_destroy(handle), CitizenSdkErrorCode::Busy as i32);
        assert_eq!(
            citizensdk_private_key_cancel(handle, view_id),
            0
        );
    }
    assert_eq!(
        settled_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        (view_id, CitizenSdkErrorCode::Cancelled as i32, 0)
    );
    assert!(
        events_rx.try_recv().is_err(),
        "receiver finish 不得提前结束仍借用宿主资源的准备阶段"
    );
    unsafe {
        assert_eq!(citizensdk_destroy(handle), CitizenSdkErrorCode::Busy as i32);
    }
    release.send(()).unwrap();
    let completion = events_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(completion.request_id, request_id);
    let result = crate::ownership::get(completion.result).unwrap();
    assert_eq!(result.code, CitizenSdkErrorCode::Cancelled);
    assert!(matches!(
        result.payload,
        crate::ownership::ResultPayload::Empty
    ));
    assert!(!context.received.load(std::sync::atomic::Ordering::SeqCst));
    assert!(settled_rx.try_recv().is_err());
    unsafe {
        assert_eq!(
            citizensdk_private_key_finish(handle, view_id),
            CitizenSdkErrorCode::NotFound as i32
        );
        assert_eq!(citizensdk_result_release(completion.result), 0);
        let previous_view_id = view_id;
        let previous_request_id = request_id;
        assert_eq!(
            citizensdk_private_key_open(
                handle,
                &account_id,
                &table,
                &mut view_id,
                &mut request_id
            ),
            0
        );
        assert!(view_id > previous_view_id);
        assert!(request_id > previous_request_id);
        // 没有账户的准备失败可早于 open 返回；context 和回调参数必须足够路由。
        assert_eq!(
            settled_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            (view_id, CitizenSdkErrorCode::NotFound as i32, 0)
        );
        let completion = events_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(completion.request_id, request_id);
        assert_eq!(
            crate::ownership::get(completion.result).unwrap().code,
            CitizenSdkErrorCode::NotFound
        );
        assert_eq!(citizensdk_result_release(completion.result), 0);
        assert_eq!(citizensdk_destroy(handle), 0);
    }
}

impl EncryptedSecretBlobStore for FakeEncryptedSecretStore {
    fn has_account_secret(&self, _account_id: citizen_sdk_contracts::AccountId32) -> ContractFuture<'_, bool> {
        Box::pin(async { Err(ContractError::new(ContractErrorCode::Unsupported, "该装配夹具不模拟完整密文仓储")) })
    }

    fn load(&self, _secret_ref: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async { Ok(EncryptedSecretBlobSnapshot::empty()) })
    }

    fn compare_and_swap(
        &self,
        _secret_ref: SecretRef,
        expected_revision: u64,
        next: EncryptedSecretBlobState,
    ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move {
            if expected_revision != 0 {
                return Err(ContractError::new(
                    ContractErrorCode::Conflict,
                    "fake encrypted-secret revision conflict",
                ));
            }
            EncryptedSecretBlobSnapshot::empty().try_advance(next)
        })
    }
}

struct FakeHistoryStore {
    fail_load: bool,
}

impl TransactionHistoryStore for FakeHistoryStore {
    fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex> {
        let fail_load = self.fail_load;
        Box::pin(async move {
            if fail_load {
                Err(ContractError::new(
                    ContractErrorCode::Storage,
                    "fake history storage failure",
                ))
            } else {
                Ok(TransactionHistoryIndex::empty())
            }
        })
    }

    fn load_record(
        &self,
        _expected_revision: u64,
        _execution_id: TransactionExecutionId,
    ) -> ContractFuture<'_, TransactionHistoryRecordSnapshot> {
        Box::pin(async {
            Ok(TransactionHistoryRecordSnapshot::new(
                TransactionHistoryIndex::empty(),
                None,
            ))
        })
    }

    fn load_page(
        &self,
        _expected_revision: u64,
        _kind: TransactionHistoryQueryKind,
        _before: Option<TransactionHistoryCursor>,
        _limit: usize,
    ) -> ContractFuture<'_, TransactionHistoryRecordBatch> {
        Box::pin(async {
            TransactionHistoryRecordBatch::try_new(
                TransactionHistoryIndex::empty(),
                Vec::new(),
                false,
            )
        })
    }

    fn compare_and_swap(
        &self,
        mutation: TransactionHistoryMutation,
    ) -> ContractFuture<'_, TransactionHistoryIndex> {
        Box::pin(async move { Ok(mutation.next_index()) })
    }
}

#[cfg(feature = "chain")]
fn provider_config(name: &str) -> SmoldotProviderConfig {
    let assets = crate::assets::verify_assets(
        include_bytes!("../../../chain/manifest.json"),
        include_bytes!("../../../chain/chainspec.json"),
        include_bytes!("../../../chain/light_sync_state.json"),
    )
    .unwrap_or_else(|error| panic!("asset verification failed: {error:?}"));
    SmoldotProviderConfig::try_new(
        assets.combined_chain_spec,
        name.to_owned(),
        "1.0.0".to_owned(),
    )
    .unwrap_or_else(|error| panic!("provider config failed: {error}"))
}

fn wallet_bundle(availability: VaultAvailability, profile_fails: bool) -> ProductWalletProviders {
    ProductWalletProviders::new(
        Arc::new(FakeVault {
            availability,
            has_wallet_key: true,
        }),
        Arc::new(FakeWalletProfileStore {
            fail_load: profile_fails,
        }),
        Arc::new(FakeEncryptedSecretStore),
    )
}

fn status(
    snapshot: &citizen_sdk_contracts::CapabilitySnapshot,
    name: CapabilityName,
) -> &citizen_sdk_contracts::CapabilityStatus {
    snapshot
        .status(name)
        .unwrap_or_else(|| panic!("capability {name:?} is missing"))
}

#[cfg(all(feature = "chain", feature = "transactions"))]
#[test]
fn public_abi_composition_is_truthfully_chain_only() {
    let composition = ProductComposition::try_new(
        provider_config("CitizenSDK-chain-only-test"),
        ProductHostProviders::public_abi_session(),
    )
    .unwrap_or_else(|error| panic!("chain-only composition failed: {error:?}"));
    let snapshot = composition
        .engine()
        .capabilities()
        .unwrap_or_else(|error| panic!("capability read failed: {error}"))
        .unwrap_or_else(|| panic!("capability snapshot missing"));

    for name in [
        CapabilityName::TransactionBuild,
        CapabilityName::WalletProfile,
        CapabilityName::LocalSigning,
        CapabilityName::HardwareVault,
        CapabilityName::UserAuthentication,
        CapabilityName::History,
        CapabilityName::BackgroundSync,
    ] {
        let compiled = match name {
            CapabilityName::TransactionBuild => cfg!(feature = "transactions"),
            CapabilityName::WalletProfile => cfg!(feature = "wallet"),
            CapabilityName::LocalSigning => cfg!(feature = "signing"),
            CapabilityName::HardwareVault | CapabilityName::UserAuthentication => {
                cfg!(feature = "wallet") || cfg!(feature = "signing")
            }
            CapabilityName::History | CapabilityName::BackgroundSync => cfg!(feature = "history"),
            _ => unreachable!(),
        };
        assert_eq!(status(&snapshot, name).supported(), compiled, "{name:?}");
        assert_eq!(
            status(&snapshot, name).enabled(),
            name == CapabilityName::TransactionBuild,
            "{name:?}"
        );
        assert!(!status(&snapshot, name).is_ready(), "{name:?}");
    }
}

#[cfg(all(
    feature = "chain",
    feature = "wallet",
    feature = "signing",
    feature = "transactions",
    feature = "history"
))]
#[test]
fn complete_wallet_bundle_derives_ready_wallet_facts_without_host_signer_or_nonce() {
    let composition = ProductComposition::try_new(
        provider_config("CitizenSDK-wallet-composition-test"),
        ProductHostProviders::new(
            Some(Arc::new(SessionChainDatabaseStore::new()) as Arc<dyn ChainDatabaseStore>),
            None,
            Some(wallet_bundle(VaultAvailability::Available, false)),
            Some(Arc::new(FakeHistoryStore { fail_load: false })),
        ),
    )
    .unwrap_or_else(|error| panic!("wallet composition failed: {error:?}"));
    let engine_snapshot = composition
        .engine()
        .capabilities()
        .unwrap_or_else(|error| panic!("Engine capability read failed: {error}"))
        .unwrap_or_else(|| panic!("Engine capability snapshot missing"));
    for name in [
        CapabilityName::TransactionBuild,
        CapabilityName::WalletProfile,
        CapabilityName::LocalSigning,
        CapabilityName::HardwareVault,
        CapabilityName::UserAuthentication,
        CapabilityName::History,
    ] {
        assert!(status(&engine_snapshot, name).supported(), "{name:?}");
        assert!(status(&engine_snapshot, name).enabled(), "{name:?}");
    }

    let snapshot = resolve_capabilities(1, composition.capability_probes(true))
        .unwrap_or_else(|error| panic!("capability resolution failed: {error}"));

    for name in [
        CapabilityName::TransactionBuild,
        CapabilityName::WalletProfile,
        CapabilityName::LocalSigning,
        CapabilityName::HardwareVault,
        CapabilityName::UserAuthentication,
        CapabilityName::History,
    ] {
        assert!(status(&snapshot, name).supported(), "{name:?}");
        assert!(status(&snapshot, name).is_ready(), "{name:?}");
    }
    assert!(status(&snapshot, CapabilityName::BackgroundSync).supported());
    assert!(!status(&snapshot, CapabilityName::BackgroundSync).is_ready());
}

#[cfg(all(
    feature = "chain",
    feature = "wallet",
    feature = "signing",
    feature = "transactions",
    feature = "history"
))]
#[test]
fn unavailable_vault_closes_local_signing_but_preserves_transaction_build() {
    let composition = ProductComposition::try_new(
        provider_config("CitizenSDK-unavailable-vault-test"),
        ProductHostProviders::new(
            None,
            None,
            Some(wallet_bundle(VaultAvailability::Unavailable, false)),
            Some(Arc::new(FakeHistoryStore { fail_load: false })),
        ),
    )
    .unwrap_or_else(|error| panic!("wallet composition failed: {error:?}"));
    let snapshot = resolve_capabilities(1, composition.capability_probes(true))
        .unwrap_or_else(|error| panic!("capability resolution failed: {error}"));

    for name in [
        CapabilityName::LocalSigning,
        CapabilityName::HardwareVault,
        CapabilityName::UserAuthentication,
    ] {
        let capability = status(&snapshot, name);
        assert!(capability.supported(), "{name:?}");
        assert!(!capability.is_ready(), "{name:?}");
        assert_eq!(
            capability.reason(),
            Some(CapabilityReason::DeviceUnavailable)
        );
    }
    // 交易准备依赖真实链事实，不因本机热签金库或钱包存储不可用而关闭。
    assert!(status(&snapshot, CapabilityName::TransactionBuild).is_ready());
}

#[cfg(all(
    feature = "chain",
    feature = "wallet",
    feature = "signing",
    feature = "transactions",
    feature = "history"
))]
#[test]
fn wallet_storage_failure_closes_profile_and_local_signing_not_transaction_build() {
    let composition = ProductComposition::try_new(
        provider_config("CitizenSDK-storage-failure-test"),
        ProductHostProviders::new(
            None,
            None,
            Some(wallet_bundle(VaultAvailability::Available, true)),
            Some(Arc::new(FakeHistoryStore { fail_load: false })),
        ),
    )
    .unwrap_or_else(|error| panic!("wallet composition failed: {error:?}"));
    let snapshot = resolve_capabilities(1, composition.capability_probes(true))
        .unwrap_or_else(|error| panic!("capability resolution failed: {error}"));

    for name in [
        CapabilityName::WalletProfile,
        CapabilityName::LocalSigning,
    ] {
        let capability = status(&snapshot, name);
        assert!(capability.supported(), "{name:?}");
        assert!(!capability.is_ready(), "{name:?}");
        assert_eq!(
            capability.reason(),
            Some(CapabilityReason::StorageUnavailable),
            "{name:?}"
        );
    }
    assert!(status(&snapshot, CapabilityName::History).is_ready());
    // 交易准备依赖真实链事实，不因本机热签金库或钱包存储不可用而关闭。
    assert!(status(&snapshot, CapabilityName::TransactionBuild).is_ready());
}

#[cfg(all(
    feature = "chain",
    feature = "wallet",
    feature = "signing",
    feature = "transactions",
    feature = "history"
))]
#[test]
fn history_storage_failure_only_closes_history_dependents() {
    let composition = ProductComposition::try_new(
        provider_config("CitizenSDK-history-failure-test"),
        ProductHostProviders::new(
            None,
            None,
            Some(wallet_bundle(VaultAvailability::Available, false)),
            Some(Arc::new(FakeHistoryStore { fail_load: true })),
        ),
    )
    .unwrap_or_else(|error| panic!("wallet composition failed: {error:?}"));
    let snapshot = resolve_capabilities(1, composition.capability_probes(true))
        .unwrap_or_else(|error| panic!("capability resolution failed: {error}"));

    assert!(status(&snapshot, CapabilityName::LocalSigning).is_ready());
    assert!(!status(&snapshot, CapabilityName::History).is_ready());
    assert_eq!(
        status(&snapshot, CapabilityName::History).reason(),
        Some(CapabilityReason::StorageUnavailable)
    );
}

#[test]
fn session_chain_database_uses_monotonic_cas_without_wallet_state() {
    let store = SessionChainDatabaseStore::new();
    let initial = futures_executor::block_on(store.load())
        .unwrap_or_else(|error| panic!("session load failed: {error}"));
    assert_eq!(initial.revision(), 0);
    assert!(initial.state().is_none());

    let next = futures_executor::block_on(store.compare_and_swap(0, None))
        .unwrap_or_else(|error| panic!("session CAS failed: {error}"));
    assert_eq!(next.revision(), 1);
    assert!(next.state().is_none());

    let stale = futures_executor::block_on(store.compare_and_swap(0, None))
        .err()
        .unwrap_or_else(|| panic!("stale session CAS must fail"));
    assert_eq!(stale.code(), ContractErrorCode::Conflict);
}

#[cfg(feature = "signing")]
#[test]
fn signing_only_composition_has_no_chain_history_or_wallet_management() {
    use citizen_sdk_contracts::{AccountId32, Modules};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct ReadOnlyAccounts(Arc<AtomicUsize>);
    impl WalletProfileStore for ReadOnlyAccounts {
        fn load(&self) -> ContractFuture<'_, WalletState> {
            Box::pin(async { Ok(WalletState::empty()) })
        }
        fn compare_and_swap(
            &self,
            _revision: u64,
            _next: WalletState,
        ) -> ContractFuture<'_, WalletState> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(ContractError::new(
                    ContractErrorCode::InvalidState,
                    "签名不得管理钱包",
                ))
            })
        }
    }
    let writes = Arc::new(AtomicUsize::new(0));
    let resources = ProductWalletProviders::new(
        Arc::new(FakeVault {
            availability: VaultAvailability::Available,
            has_wallet_key: true,
        }),
        Arc::new(ReadOnlyAccounts(writes.clone())),
        Arc::new(FakeEncryptedSecretStore),
    );
    let modules = Modules::try_new(Modules::SIGNING).unwrap();
    let composition = ProductComposition::compose(
        #[cfg(feature = "chain")]
        None,
        ProductHostProviders::new(None, None, Some(resources), None),
        modules,
    )
    .unwrap();
    #[cfg(feature = "chain")]
    assert!(composition.provider().is_none());
    assert!(!composition.has_wallet_services());
    let snapshot = composition
        .engine()
        .update_capabilities(composition.capability_probes(false))
        .unwrap();
    assert!(!status(&snapshot, CapabilityName::WalletProfile).enabled());
    assert!(status(&snapshot, CapabilityName::LocalSigning).is_ready());
    assert!(!status(&snapshot, CapabilityName::ChainRead).enabled());
    assert!(!status(&snapshot, CapabilityName::History).enabled());
    assert!(futures_executor::block_on(composition.engine().wallet_profile()).is_err());
    let failure = futures_executor::block_on(
        composition
            .engine()
            .sign_wallet_payload(AccountId32::from_bytes([0x33; 32]), Vec::new()),
    )
    .expect_err("没有 SDK 安全账户时禁止凭空签名");
    assert!(
        matches!(failure, citizen_sdk_engine::EngineError::Contract(error)
        if error.code() == ContractErrorCode::NotFound)
    );
    assert_eq!(
        writes.load(Ordering::SeqCst),
        0,
        "签名只允许读取安全账户归属"
    );
    assert!(composition.engine().begin_provider_start().is_err());
}

#[cfg(feature = "wallet")]
#[test]
fn wallet_only_composition_keeps_signing_disabled_and_reads_no_chain_assets() {
    use citizen_sdk_contracts::Modules;
    let composition = ProductComposition::compose(
        #[cfg(feature = "chain")]
        None,
        ProductHostProviders::new(
            None,
            None,
            Some(wallet_bundle(VaultAvailability::Available, false)),
            None,
        ),
        Modules::try_new(Modules::WALLET).unwrap(),
    )
    .unwrap();
    let snapshot = composition
        .engine()
        .update_capabilities(composition.capability_probes(false))
        .unwrap();
    assert!(status(&snapshot, CapabilityName::WalletProfile).is_ready());
    assert!(!status(&snapshot, CapabilityName::LocalSigning).enabled());
    assert!(!status(&snapshot, CapabilityName::ChainRead).enabled());
    assert!(!composition.has_wallet_services());
    assert!(
        futures_executor::block_on(composition.engine().wallet_profile())
            .unwrap()
            .is_none()
    );
}

#[cfg(feature = "signing")]
#[test]
fn missing_secure_resource_groups_fail_before_callbacks_or_provider_creation() {
    use crate::abi::{CitizenSdkErrorCode, CitizenSdkHostSecureStoreV1, CitizenSdkHostServicesV1};
    use citizen_sdk_contracts::Modules;
    let modules = Modules::try_new(Modules::SIGNING).unwrap();
    let missing_host = unsafe {
        ProductComposition::module_abi(None, "module-test".into(), "1.0.0".into(), None, modules)
    };
    assert_eq!(
        missing_host.err().unwrap().code,
        CitizenSdkErrorCode::InvalidArgument
    );

    let secure = CitizenSdkHostSecureStoreV1::default();
    let services = CitizenSdkHostServicesV1 {
        secure_store: &secure,
        ..CitizenSdkHostServicesV1::default()
    };
    let missing_vault = unsafe {
        ProductComposition::module_abi(
            None,
            "module-test".into(),
            "1.0.0".into(),
            Some(&services),
            modules,
        )
    };
    assert_eq!(
        missing_vault.err().unwrap().code,
        CitizenSdkErrorCode::InvalidArgument
    );
}
