//! 无根热钱包生命周期、CAS 写后异常与补偿所有权的 Engine 级测试。
//!
//! 内存 fake 刻意把公开 profile、设备密文与硬件钱包密钥分成三个独立事实源，测试
//! 不会因为一个“万能 Map”而掩盖孤儿密文、误删其它实例成功钱包或删除契约遗漏。

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use crate::{
    error::EngineError,
    wallet_derivation::{WalletEntropySource, WalletWordCount},
    wallet_service::{SigningService, WalletClock, WalletService},
};
use citizen_sdk_contracts::{
    store::{EncryptedSecretBlobStore, WalletProfileStore},
    AccountId32, ChainSigner, ContractError, ContractErrorCode, ContractFuture, ContractResult,
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretEnvelope, Hash32Bytes,
    SecretBuffer, SecretOwner, SecretRef, SecretVault, SigningIntent, SigningTransform,
    Sr25519PublicKey, Sr25519Signature, VaultAvailability, VaultGeneration, WalletCleanupPlan,
    WalletDiagnosticReason, WalletOrigin, WalletProvisioningPlan, WalletRecord, WalletSignMode,
    WalletState,
};
use citizen_signer::Sr25519SoftwareSigner;
use futures::{executor::block_on, join};
use zeroize::Zeroizing;

const KNOWN_MNEMONIC: &str =
    "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum WriteFault {
    #[default]
    None,
    BeforeWrite,
    AfterWrite,
}

#[derive(Debug)]
struct MemoryWalletProfileStore {
    state: Mutex<WalletState>,
    next_fault: Mutex<WriteFault>,
    fail_before_call: Mutex<Option<usize>>,
    cas_calls: AtomicUsize,
}

impl Default for MemoryWalletProfileStore {
    fn default() -> Self {
        Self {
            state: Mutex::new(WalletState::empty()),
            next_fault: Mutex::new(WriteFault::None),
            fail_before_call: Mutex::new(None),
            cas_calls: AtomicUsize::new(0),
        }
    }
}

impl MemoryWalletProfileStore {
    fn fail_next_after_write(&self) {
        *self.next_fault.lock().unwrap() = WriteFault::AfterWrite;
    }

    fn fail_before_exact_call(&self, call: usize) {
        *self.fail_before_call.lock().unwrap() = Some(call);
    }

    fn snapshot(&self) -> WalletState {
        self.state.lock().unwrap().clone()
    }
}

impl WalletProfileStore for MemoryWalletProfileStore {
    fn load(&self) -> ContractFuture<'_, WalletState> {
        Box::pin(async move { Ok(self.state.lock().unwrap().clone()) })
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState> {
        Box::pin(async move {
            let call = self.cas_calls.fetch_add(1, Ordering::SeqCst) + 1;
            let fail_before = {
                let mut planned_call = self.fail_before_call.lock().unwrap();
                if *planned_call == Some(call) {
                    *planned_call = None;
                    true
                } else {
                    false
                }
            };
            if fail_before {
                return Err(storage_error("profile CAS 在写入前失败"));
            }
            let fault = std::mem::replace(&mut *self.next_fault.lock().unwrap(), WriteFault::None);
            if fault == WriteFault::BeforeWrite {
                return Err(storage_error("profile CAS 在写入前失败"));
            }
            let mut state = self.state.lock().unwrap();
            if state.revision() != expected_revision {
                return Err(conflict_error("profile revision 冲突"));
            }
            if next.revision() != expected_revision.saturating_add(1) {
                return Err(storage_error("profile candidate revision 不连续"));
            }
            *state = next.clone();
            if fault == WriteFault::AfterWrite {
                return Err(storage_error("profile CAS 已写入但平台抛错"));
            }
            Ok(next)
        })
    }
}

#[derive(Debug, Default)]
struct MemoryEncryptedSecretStore {
    presence_error: Mutex<Option<ContractErrorCode>>,
    entries: Mutex<HashMap<SecretRef, EncryptedSecretBlobSnapshot>>,
    next_fault: Mutex<WriteFault>,
    deletion_order: Mutex<Vec<SecretRef>>,
    corrupt_next_write: AtomicBool,
}

impl MemoryEncryptedSecretStore {
    fn fail_next_after_write(&self) {
        *self.next_fault.lock().unwrap() = WriteFault::AfterWrite;
    }

    fn envelope_count(&self) -> usize {
        self.entries
            .lock()
            .unwrap()
            .values()
            .filter(|snapshot| snapshot.envelope().is_some())
            .count()
    }

    fn has_envelope(&self, secret_ref: SecretRef) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(&secret_ref)
            .is_some_and(|snapshot| snapshot.envelope().is_some())
    }

    fn remove_without_contract(&self, secret_ref: SecretRef) {
        self.entries
            .lock()
            .unwrap()
            .insert(secret_ref, EncryptedSecretBlobSnapshot::empty());
    }

    fn insert_envelope(&self, secret_ref: SecretRef) {
        let snapshot = EncryptedSecretBlobSnapshot::empty()
            .try_advance(EncryptedSecretBlobState::Sealed {
                provisioning_operation_id: [0x61; 16],
                envelope: test_envelope(secret_ref),
            })
            .unwrap();
        self.entries.lock().unwrap().insert(secret_ref, snapshot);
    }
}

impl EncryptedSecretBlobStore for MemoryEncryptedSecretStore {
    fn has_account_secret(&self, account_id: AccountId32) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            if let Some(code) = *self.presence_error.lock().unwrap() {
                return Err(ContractError::new(code, "合成密文查询失败"));
            }
            Ok(self
                .entries
                .lock()
                .unwrap()
                .iter()
                .any(|(reference, value)| {
                    reference.account_id() == account_id && value.envelope().is_some()
                }))
        })
    }

    fn load(&self, secret_ref: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move {
            Ok(self
                .entries
                .lock()
                .unwrap()
                .get(&secret_ref)
                .cloned()
                .unwrap_or_else(EncryptedSecretBlobSnapshot::empty))
        })
    }

    fn compare_and_swap(
        &self,
        secret_ref: SecretRef,
        expected_revision: u64,
        next_state: EncryptedSecretBlobState,
    ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move {
            let fault = std::mem::replace(&mut *self.next_fault.lock().unwrap(), WriteFault::None);
            if fault == WriteFault::BeforeWrite {
                return Err(storage_error("密文 CAS 在写入前失败"));
            }
            let mut entries = self.entries.lock().unwrap();
            let current = entries
                .get(&secret_ref)
                .cloned()
                .unwrap_or_else(EncryptedSecretBlobSnapshot::empty);
            if current.revision() != expected_revision {
                return Err(conflict_error("密文 revision 冲突"));
            }
            let deleted_existing = current.envelope().is_some() && next_state.is_tombstone();
            let next = current.try_advance(next_state)?;
            entries.insert(secret_ref, next.clone());
            if self.corrupt_next_write.swap(false, Ordering::SeqCst) && next.envelope().is_some() {
                let EncryptedSecretBlobState::Sealed {
                    provisioning_operation_id,
                    ..
                } = next.state()
                else {
                    unreachable!()
                };
                let corrupted = EncryptedSecretBlobSnapshot::empty()
                    .try_advance(EncryptedSecretBlobState::Sealed {
                        provisioning_operation_id: *provisioning_operation_id,
                        envelope: test_envelope(secret_ref),
                    })
                    .unwrap();
                entries.insert(secret_ref, corrupted);
            }
            if deleted_existing {
                self.deletion_order.lock().unwrap().push(secret_ref);
            }
            if fault == WriteFault::AfterWrite {
                return Err(storage_error("密文 CAS 已写入但平台抛错"));
            }
            Ok(next)
        })
    }
}

#[derive(Debug)]
struct MemorySecretVault {
    presence_error: Mutex<Option<ContractErrorCode>>,
    availability: Mutex<VaultAvailability>,
    availability_gate: Mutex<Option<futures::channel::oneshot::Receiver<()>>>,
    availability_entered: Mutex<Option<futures::channel::oneshot::Sender<()>>>,
    wallet_keys: Mutex<HashSet<(u32, VaultGeneration)>>,
    key_owners: Mutex<std::collections::HashMap<(u32, VaultGeneration), [u8; 16]>>,
    ensure_calls: AtomicUsize,
    authorize_calls: AtomicUsize,
    authorize_error: Mutex<Option<ContractErrorCode>>,
    authorize_gate: Mutex<Option<futures::channel::oneshot::Receiver<()>>>,
    authorize_entered: Mutex<Option<futures::channel::oneshot::Sender<()>>>,
    retired_wallets: Mutex<HashSet<(u32, VaultGeneration)>>,
    delete_wallet_calls: AtomicUsize,
    open_calls: AtomicUsize,
    open_completed: AtomicUsize,
    open_gate: Mutex<Option<futures::channel::oneshot::Receiver<()>>>,
    open_entered: Mutex<Option<futures::channel::oneshot::Sender<()>>>,
}

impl Default for MemorySecretVault {
    fn default() -> Self {
        Self {
            presence_error: Mutex::new(None),
            availability: Mutex::new(VaultAvailability::Available),
            availability_gate: Mutex::new(None),
            availability_entered: Mutex::new(None),
            wallet_keys: Mutex::new(HashSet::new()),
            key_owners: Mutex::new(std::collections::HashMap::new()),
            ensure_calls: AtomicUsize::new(0),
            authorize_calls: AtomicUsize::new(0),
            authorize_error: Mutex::new(None),
            authorize_gate: Mutex::new(None),
            authorize_entered: Mutex::new(None),
            retired_wallets: Mutex::new(HashSet::new()),
            delete_wallet_calls: AtomicUsize::new(0),
            open_calls: AtomicUsize::new(0),
            open_completed: AtomicUsize::new(0),
            open_gate: Mutex::new(None),
            open_entered: Mutex::new(None),
        }
    }
}

impl MemorySecretVault {
    fn has_key(&self, wallet_index: u32, generation: VaultGeneration) -> bool {
        self.wallet_keys
            .lock()
            .unwrap()
            .contains(&(wallet_index, generation))
    }
}

impl SecretVault for MemorySecretVault {
    fn authorize_add_accounts(
        &self,
        operation: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            assert_ne!(operation, [0; 16]);
            self.authorize_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(entered) = self.authorize_entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            let gate = self.authorize_gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            if let Some(code) = *self.authorize_error.lock().unwrap() {
                return Err(ContractError::new(code, "合成追加认证失败"));
            }
            if !self.has_key(wallet_index, generation) {
                return Err(ContractError::new(
                    ContractErrorCode::KeyInvalidated,
                    "合成钱包钥失效",
                ));
            }
            Ok(())
        })
    }

    // 模拟真实平台：创建代际绑定唯一操作；seal只复用，不再隐式造钥。
    fn ensure_wallet_key(
        &self,
        operation: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            self.ensure_calls.fetch_add(1, Ordering::SeqCst);
            let key = (wallet_index, generation);
            let mut owners = self.key_owners.lock().unwrap();
            if self.retired_wallets.lock().unwrap().contains(&key)
                || owners.get(&key).is_some_and(|owner| owner != &operation)
            {
                return Err(ContractError::new(
                    ContractErrorCode::KeyInvalidated,
                    "代际退休或创建操作不匹配",
                ));
            }
            owners.insert(key, operation);
            self.wallet_keys.lock().unwrap().insert(key);
            Ok(())
        })
    }
    fn has_any_wallet_key(&self, wallet_index: u32) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            if let Some(code) = *self.presence_error.lock().unwrap() {
                return Err(ContractError::new(code, "合成物理钥查询失败"));
            }
            Ok(self
                .wallet_keys
                .lock()
                .unwrap()
                .iter()
                .any(|(index, _)| *index == wallet_index))
        })
    }

    fn availability(&self) -> ContractFuture<'_, VaultAvailability> {
        Box::pin(async move {
            if let Some(entered) = self.availability_entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            let gate = self.availability_gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            Ok(*self.availability.lock().unwrap())
        })
    }

    fn seal(
        &self,
        _provisioning_operation_id: [u8; 16],
        secret_ref: SecretRef,
        secret: SecretBuffer,
    ) -> ContractFuture<'_, EncryptedSecretEnvelope> {
        Box::pin(async move {
            if self
                .retired_wallets
                .lock()
                .unwrap()
                .contains(&(secret_ref.wallet_index(), secret_ref.generation()))
            {
                return Err(ContractError::new(
                    ContractErrorCode::KeyInvalidated,
                    "测试 generation 已退休",
                ));
            }
            if !self.has_key(secret_ref.wallet_index(), secret_ref.generation()) {
                return Err(ContractError::new(
                    ContractErrorCode::KeyInvalidated,
                    "已有钱包密钥缺失",
                ));
            }
            let ciphertext = secret.with_secret(ToOwned::to_owned);
            EncryptedSecretEnvelope::try_new(
                1,
                Hash32Bytes::from_bytes(secret_ref_digest(secret_ref)),
                ciphertext,
            )
        })
    }

    fn open(
        &self,
        secret_ref: SecretRef,
        envelope: EncryptedSecretEnvelope,
    ) -> ContractFuture<'_, SecretBuffer> {
        Box::pin(async move {
            self.open_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(entered) = self.open_entered.lock().unwrap().take() {
                let _ = entered.send(());
            }
            let gate = self.open_gate.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            self.open_completed.fetch_add(1, Ordering::SeqCst);
            if !self.has_key(secret_ref.wallet_index(), secret_ref.generation()) {
                return Err(ContractError::new(
                    ContractErrorCode::KeyInvalidated,
                    "测试钱包密钥不存在",
                ));
            }
            if envelope.associated_data_digest().as_bytes() != &secret_ref_digest(secret_ref) {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "测试密文 AAD 与 SecretRef 不一致",
                ));
            }
            SecretBuffer::try_new(envelope.ciphertext().to_vec())
        })
    }

    fn has_wallet_key(
        &self,
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, bool> {
        Box::pin(async move { Ok(self.has_key(wallet_index, generation)) })
    }

    fn delete_wallet_key(
        &self,
        _cleanup_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()> {
        Box::pin(async move {
            self.delete_wallet_calls.fetch_add(1, Ordering::SeqCst);
            self.retired_wallets
                .lock()
                .unwrap()
                .insert((wallet_index, generation));
            self.wallet_keys
                .lock()
                .unwrap()
                .remove(&(wallet_index, generation));
            Ok(())
        })
    }
}

#[derive(Debug, Default)]
struct CountingEntropy(AtomicU64);

impl WalletEntropySource for CountingEntropy {
    fn fill(&self, output: &mut [u8]) -> ContractResult<()> {
        let sequence = self.0.fetch_add(1, Ordering::SeqCst);
        for (offset, byte) in output.iter_mut().enumerate() {
            *byte = sequence.wrapping_add(offset as u64) as u8;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct IncrementingClock(AtomicU64);

impl Default for IncrementingClock {
    fn default() -> Self {
        Self(AtomicU64::new(1_700_000_000_000))
    }
}

impl WalletClock for IncrementingClock {
    fn now_millis(&self) -> ContractResult<u64> {
        Ok(self.0.fetch_add(1, Ordering::SeqCst))
    }
}

struct Harness {
    service: WalletService,
    signer: Arc<Sr25519SoftwareSigner>,
    vault: Arc<MemorySecretVault>,
    profiles: Arc<MemoryWalletProfileStore>,
    secrets: Arc<MemoryEncryptedSecretStore>,
    entropy: Arc<CountingEntropy>,
    clock: Arc<IncrementingClock>,
}

impl Harness {
    fn new() -> Self {
        let signer = Arc::new(Sr25519SoftwareSigner);
        let vault = Arc::new(MemorySecretVault::default());
        let profiles = Arc::new(MemoryWalletProfileStore::default());
        let secrets = Arc::new(MemoryEncryptedSecretStore::default());
        let entropy = Arc::new(CountingEntropy::default());
        let clock = Arc::new(IncrementingClock::default());
        let service = WalletService::new(
            signer.clone(),
            vault.clone(),
            profiles.clone(),
            secrets.clone(),
            entropy.clone(),
            clock.clone(),
        );
        Self {
            service,
            signer,
            vault,
            profiles,
            secrets,
            entropy,
            clock,
        }
    }

    fn signing_service(&self) -> SigningService {
        SigningService::new(
            self.signer.clone(),
            self.vault.clone(),
            self.profiles.clone(),
            self.secrets.clone(),
        )
    }

    fn engine(&self, modules: citizen_sdk_contracts::Modules) -> crate::CitizenEngine {
        let engine = crate::CitizenEngine::new(
            crate::EngineComponents::new(
                None,
                Some(self.signer.clone()),
                Some(self.vault.clone()),
                None,
                None,
                Some(self.profiles.clone()),
                None,
                Some(self.secrets.clone()),
            )
            .with_modules(modules),
        );
        engine
            .update_capabilities(
                citizen_sdk_contracts::CapabilityName::ALL
                    .into_iter()
                    .map(crate::CapabilityProbe::ready)
                    .collect(),
            )
            .expect("模块能力快照");
        engine
    }

    fn second_service(&self) -> WalletService {
        WalletService::new(
            self.signer.clone(),
            self.vault.clone(),
            self.profiles.clone(),
            self.secrets.clone(),
            self.entropy.clone(),
            self.clock.clone(),
        )
    }
}

#[test]
fn cold_accounts_share_one_order_and_never_call_the_secret_vault() {
    block_on(async {
        let harness = Harness::new();
        *harness.vault.availability.lock().unwrap() = VaultAvailability::Unavailable;
        let first_id = AccountId32::from_bytes([0xa1; 32]);
        let second_id = AccountId32::from_bytes([0xa2; 32]);

        let first = harness
            .service
            .import_cold_account(first_id, " 冷钱包1 ")
            .await
            .expect("AccountId 导入冷账户");
        let second_address = citizen_sdk_contracts::citizen_ss58_address(second_id);
        let second = harness
            .service
            .import_cold_ss58_account(&second_address, "冷钱包2")
            .await
            .expect("SS58 导入冷账户");
        assert_eq!((first.wallet_index(), second.wallet_index()), (1, 2));
        assert_eq!(first.name(), "冷钱包1");
        assert_eq!(
            harness.service.account_sign_mode(first_id).await.unwrap(),
            Some(WalletSignMode::Cold)
        );

        let revision = harness.service.state().await.unwrap().revision();
        let state = harness
            .service
            .reorder_accounts_without_default_change(revision, vec![first_id, second_id])
            .await
            .unwrap();
        assert_eq!(state.default_account_id(), Some(first_id));
        let renamed = harness
            .service
            .rename_cold_account(second_id, " 离线治理 ")
            .await
            .unwrap();
        assert_eq!(renamed.name(), "离线治理");

        assert_contract_code(
            harness
                .service
                .import_cold_account(first_id, "重复")
                .await
                .expect_err("重复冷账户必须拒绝"),
            ContractErrorCode::Conflict,
        );
        assert!(harness
            .service
            .reorder_accounts_without_default_change(
                harness.service.state().await.unwrap().revision(),
                vec![first_id, first_id],
            )
            .await
            .is_err());

        harness.service.delete_cold_account(first_id).await.unwrap();
        let reimported = harness
            .service
            .import_cold_account(first_id, "重新导入")
            .await
            .unwrap();
        assert_eq!(reimported.wallet_index(), 3, "删除后的 index 不得复用");
        let state = harness.profiles.snapshot();
        assert_eq!(state.ordered_account_ids(), &[second_id, first_id]);
        assert_eq!(state.next_cold_wallet_index(), 4);
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), 0);
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
        assert!(harness.vault.wallet_keys.lock().unwrap().is_empty());
        assert_eq!(harness.secrets.envelope_count(), 0);
    });
}

/// 只替换合成MemoryStore中的原槽以模拟持久字段损坏；生产API不提供写入坏模式的入口。
fn seed_diagnostic(harness: &Harness, record: WalletRecord) -> WalletState {
    let before = harness.profiles.snapshot();
    let profile = before
        .profile()
        .filter(|profile| profile.wallet_index() != record.wallet_index())
        .cloned();
    let cold: Vec<_> = before
        .cold_accounts()
        .iter()
        .filter(|account| account.wallet_index() != record.wallet_index())
        .cloned()
        .collect();
    let valid: HashSet<_> = profile
        .iter()
        .flat_map(|profile| profile.accounts())
        .map(|account| account.account_id())
        .chain(cold.iter().map(|account| account.account_id()))
        .collect();
    let order = before
        .ordered_account_ids()
        .iter()
        .copied()
        .filter(|account| valid.contains(account))
        .collect();
    let mut diagnostics: Vec<_> = before
        .diagnostics()
        .iter()
        .filter(|entry| entry.wallet_index() != record.wallet_index())
        .cloned()
        .collect();
    diagnostics.push(record);
    let state = WalletState::try_from_catalog_parts(
        before.revision() + 1,
        profile,
        cold,
        order,
        before.next_cold_wallet_index(),
        None,
        None,
        Vec::new(),
    )
    .unwrap()
    .try_with_diagnostics(diagnostics)
    .unwrap()
    .try_with_active_wallet(before.active_wallet_index())
    .unwrap();
    *harness.profiles.state.lock().unwrap() = state.clone();
    state
}
fn broken_mode(mut record: WalletRecord) -> WalletRecord {
    match &mut record {
        WalletRecord::Profile { sign_mode, .. } | WalletRecord::Account { sign_mode, .. } => {
            *sign_mode = "untrusted-mode".to_owned()
        }
    }
    record
}

#[test]
fn diagnostic_hot_wallet_is_present_but_cannot_sign_create_or_select_until_real_proof() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let raw = broken_mode(WalletRecord::from_profile(&profile));
        assert_eq!(
            raw.diagnostic_reason(),
            Some(WalletDiagnosticReason::InvalidSignMode)
        );
        let before = seed_diagnostic(&harness, raw.clone());
        let snapshot = harness.service.state().await.unwrap();
        assert_eq!(
            snapshot.initialization_state(),
            crate::wallet_service::WalletInitializationState::Ready
        );
        assert!(snapshot.profile().is_none() && snapshot.ordered_account_ids().is_empty());
        assert_eq!(snapshot.diagnostics(), &[raw.clone()]);
        assert_eq!(
            harness
                .service
                .account_sign_mode(profile.master_account_id())
                .await
                .unwrap(),
            None
        );
        assert!(harness
            .signing_service()
            .sign(profile.master_account_id(), vec![1])
            .await
            .is_err());
        assert!(harness
            .service
            .prepare_create(WalletWordCount::Words12, Zeroizing::new(String::new()))
            .await
            .is_err());
        assert!(harness
            .service
            .set_active_wallet(before.revision(), 0)
            .await
            .is_err());
        let opens = harness.vault.open_calls.load(Ordering::SeqCst);
        let restored = harness
            .service
            .repair_hot_wallet(before.revision(), &raw)
            .await
            .unwrap();
        assert_eq!(restored.profile(), Some(&profile));
        assert!(restored.diagnostics().is_empty());
        assert_eq!(restored.active_wallet_index(), Some(0));
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), opens + 1);
        assert!(harness
            .service
            .repair_hot_wallet(before.revision(), &raw)
            .await
            .is_err());
    });
}

#[test]
fn diagnostic_hot_proof_failure_and_stale_snapshot_never_relabel() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let raw = broken_mode(WalletRecord::from_profile(&profile));
        let before = seed_diagnostic(&harness, raw.clone());
        *harness.vault.availability.lock().unwrap() = VaultAvailability::Unavailable;
        assert!(harness
            .service
            .repair_hot_wallet(before.revision(), &raw)
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
        *harness.vault.availability.lock().unwrap() = VaultAvailability::Available;
        harness
            .secrets
            .insert_envelope(profile.accounts()[0].secret_ref()); // 正式signer可识别与目标公钥不匹配的合成秘密。
        assert!(harness
            .service
            .repair_hot_wallet(before.revision(), &raw)
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
        let foreign = raw.try_with_wallet_name("不是原快照").unwrap();
        assert!(harness
            .service
            .repair_hot_wallet(before.revision(), &foreign)
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
    });
}

#[test]
fn diagnostic_proof_rechecks_record_after_pending_authentication_even_at_same_revision() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let raw = broken_mode(WalletRecord::from_profile(&profile));
        let before = seed_diagnostic(&harness, raw.clone());
        let (entered, waiting) = futures::channel::oneshot::channel();
        let (release, gate) = futures::channel::oneshot::channel();
        *harness.vault.open_entered.lock().unwrap() = Some(entered);
        *harness.vault.open_gate.lock().unwrap() = Some(gate);
        let change = async {
            waiting.await.unwrap();
            let changed = raw.try_with_wallet_name("合成并发改名").unwrap();
            *harness.profiles.state.lock().unwrap() =
                before.try_with_diagnostics(vec![changed]).unwrap();
            release.send(()).unwrap();
        };
        let (result, ()) = join!(
            harness.service.repair_hot_wallet(before.revision(), &raw),
            change
        );
        assert_contract_code(result.unwrap_err(), ContractErrorCode::Conflict);
        assert!(harness.profiles.snapshot().profile().is_none());
        assert_eq!(
            harness.profiles.snapshot().diagnostics()[0].wallet_name(),
            "合成并发改名"
        );
    });
}

#[test]
fn cold_reimport_repairs_only_matching_invalid_mode_and_keeps_existing_wallet_facts() {
    block_on(async {
        let harness = Harness::new();
        let account_id = AccountId32::from_bytes([0x51; 32]);
        let account = harness
            .service
            .import_cold_account(account_id, "原名称")
            .await
            .unwrap();
        let raw = broken_mode(WalletRecord::from_cold_account(&account));
        let before = seed_diagnostic(&harness, raw.clone());
        *harness.vault.availability.lock().unwrap() = VaultAvailability::Unavailable; // 元数据查询不依赖强认证可用。
        let restored = harness
            .service
            .import_cold_account(account_id, "不能覆盖原名称")
            .await
            .unwrap();
        assert_eq!(restored, account);
        let state = harness.profiles.snapshot();
        assert_eq!(state.revision(), before.revision() + 1);
        assert_eq!(state.active_wallet_index(), before.active_wallet_index());
        assert_eq!(state.default_account_id(), Some(account_id));
        assert!(state.diagnostics().is_empty());
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), 0);
        assert!(harness
            .service
            .import_cold_account(account_id, "")
            .await
            .is_err());
    });
}

#[test]
fn cold_reimport_never_treats_secrets_keys_errors_or_bad_identity_as_absence() {
    block_on(async {
        for case in 0..6 {
            let harness = Harness::new();
            let account_id = AccountId32::from_bytes([0x52; 32]);
            let account = harness
                .service
                .import_cold_account(account_id, "原名称")
                .await
                .unwrap();
            let mut raw = broken_mode(WalletRecord::from_cold_account(&account));
            if case == 4 {
                if let WalletRecord::Account { ss58_address, .. } = &mut raw {
                    *ss58_address = "invalid".to_owned();
                }
            }
            if case == 5 {
                if let WalletRecord::Account { sign_mode, .. } = &mut raw {
                    *sign_mode = "hot".to_owned();
                }
            }
            let before = seed_diagnostic(&harness, raw);
            match case {
                0 => harness
                    .secrets
                    .insert_envelope(SecretRef::account_mini_secret(
                        0,
                        VaultGeneration::from_bytes([9; 16]),
                        SecretOwner::from_bytes([8; 16]),
                        account_id,
                    )),
                1 => {
                    harness.vault.wallet_keys.lock().unwrap().insert((
                        account.wallet_index(),
                        VaultGeneration::from_bytes([99; 16]),
                    ));
                }
                2 => {
                    *harness.secrets.presence_error.lock().unwrap() =
                        Some(ContractErrorCode::Storage)
                }
                3 => {
                    *harness.vault.presence_error.lock().unwrap() =
                        Some(ContractErrorCode::Unsupported)
                }
                _ => {}
            }
            assert!(harness
                .service
                .import_cold_account(account_id, "")
                .await
                .is_err());
            assert_eq!(harness.profiles.snapshot(), before);
        }
    });
}

#[test]
fn diagnostic_rename_and_delete_preserve_other_records_and_use_existing_cleanup() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let cold = harness
            .service
            .import_cold_account(AccountId32::from_bytes([0x53; 32]), "另一个")
            .await
            .unwrap();
        let cold_record = broken_mode(WalletRecord::from_cold_account(&cold));
        seed_diagnostic(&harness, cold_record.clone());
        let hot_record = broken_mode(WalletRecord::from_profile(&profile));
        let before = seed_diagnostic(&harness, hot_record.clone());
        let renamed = harness
            .service
            .rename_diagnostic_wallet(before.revision(), &hot_record, "重命名")
            .await
            .unwrap();
        assert_eq!(renamed.diagnostic(0).unwrap().wallet_name(), "重命名");
        assert_eq!(renamed.diagnostic(cold.wallet_index()), Some(&cold_record));
        assert_eq!(renamed.diagnostic(0).unwrap().sign_mode(), "untrusted-mode");
        assert!(harness
            .service
            .delete_diagnostic_wallet(before.revision(), &hot_record)
            .await
            .is_err());
        let hot = renamed.diagnostic(0).unwrap().clone();
        let opens = harness.vault.open_calls.load(Ordering::SeqCst);
        let removed = harness
            .service
            .delete_diagnostic_wallet(renamed.revision(), &hot)
            .await
            .unwrap();
        assert!(removed.profile().is_none() && removed.cleanup().is_none());
        assert_eq!(removed.diagnostics(), &[cold_record.clone()]);
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), opens); // 无签名删除不得额外取私钥。
        assert!(!harness.vault.has_key(0, profile.generation()));
        let removed_cold = harness
            .service
            .delete_diagnostic_wallet(removed.revision(), &cold_record)
            .await
            .unwrap();
        assert!(removed_cold.diagnostics().is_empty());
        assert_eq!(
            harness
                .service
                .state()
                .await
                .unwrap()
                .initialization_state(),
            crate::wallet_service::WalletInitializationState::Empty
        );
    });
}

#[test]
fn diagnostic_changes_handle_cas_failures_and_plain_wipe_without_losing_pending_ownership() {
    block_on(async {
        for fault in [WriteFault::BeforeWrite, WriteFault::AfterWrite] {
            let harness = Harness::new();
            let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
            let raw = broken_mode(WalletRecord::from_profile(&profile));
            let before = seed_diagnostic(&harness, raw.clone());
            *harness.profiles.next_fault.lock().unwrap() = fault;
            let result = harness
                .service
                .rename_diagnostic_wallet(before.revision(), &raw, "已改名")
                .await;
            if fault == WriteFault::BeforeWrite {
                assert!(result.is_err());
                assert_eq!(harness.profiles.snapshot(), before);
            } else {
                assert_eq!(
                    result.unwrap().diagnostic(0).unwrap().wallet_name(),
                    "已改名"
                );
            }
            harness.service.delete_wallet().await.unwrap();
            assert!(harness.profiles.snapshot().diagnostics().is_empty());
        }
    });
}

struct ProofSigner {
    inner: Sr25519SoftwareSigner,
    messages: Mutex<Vec<Vec<u8>>>,
    reject_verification: bool,
}
impl ChainSigner for ProofSigner {
    fn derive_hard<'a>(
        &'a self,
        parent: &'a SecretBuffer,
        junction: citizen_sdk_contracts::DerivationJunction,
    ) -> ContractFuture<'a, SecretBuffer> {
        self.inner.derive_hard(parent, junction)
    }
    fn public_key<'a>(&'a self, secret: &'a SecretBuffer) -> ContractFuture<'a, Sr25519PublicKey> {
        self.inner.public_key(secret)
    }
    fn sign<'a>(
        &'a self,
        secret: &'a SecretBuffer,
        message: Vec<u8>,
    ) -> ContractFuture<'a, Sr25519Signature> {
        self.messages.lock().unwrap().push(message.clone());
        self.inner.sign(secret, message)
    }
    fn verify(
        &self,
        public_key: Sr25519PublicKey,
        message: Vec<u8>,
        signature: Sr25519Signature,
    ) -> ContractFuture<'_, bool> {
        if self.reject_verification {
            return Box::pin(async { Ok(false) });
        }
        self.inner.verify(public_key, message, signature)
    }
}

#[test]
fn hot_mode_proof_uses_original_0x23_scale_domain_and_failed_verification_never_commits() {
    block_on(async {
        for reject in [false, true] {
            let harness = Harness::new();
            let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
            let raw = broken_mode(WalletRecord::from_profile(&profile));
            let before = seed_diagnostic(&harness, raw.clone());
            let signer = Arc::new(ProofSigner {
                inner: Sr25519SoftwareSigner,
                messages: Mutex::new(Vec::new()),
                reject_verification: reject,
            });
            let service = WalletService::new(
                signer.clone(),
                harness.vault.clone(),
                harness.profiles.clone(),
                harness.secrets.clone(),
                harness.entropy.clone(),
                harness.clock.clone(),
            );
            let next_entropy = harness.entropy.0.load(Ordering::SeqCst);
            let result = service.repair_hot_wallet(before.revision(), &raw).await;
            let mut challenge = [0u8; 32];
            // 同一有限熵源规则仅用于构造公开期望；正式签名仍是Sr25519SoftwareSigner。
            CountingEntropy(AtomicU64::new(next_entropy))
                .fill(&mut challenge)
                .unwrap();
            let mut scale = citizen_sdk_contracts::CITIZENCHAIN_GENESIS_HASH
                .as_bytes()
                .to_vec();
            scale.extend_from_slice(profile.master_account_id().as_bytes());
            scale.extend_from_slice(b"\x0chot");
            scale.extend_from_slice(&challenge);
            let expected = citizen_sdk_contracts::encode_signing_payload(
                citizen_sdk_contracts::SigningPayload::Message {
                    op_tag: 0x23,
                    scale_payload: &scale,
                },
            )
            .unwrap();
            assert_eq!(*signer.messages.lock().unwrap(), vec![expected]);
            if reject {
                assert_contract_code(result.unwrap_err(), ContractErrorCode::Integrity);
                assert_eq!(harness.profiles.snapshot(), before);
            } else {
                assert!(result.unwrap().diagnostics().is_empty());
            }
        }
    });
}

#[test]
fn missing_account_references_never_authorize_unprovable_cleanup() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let mut raw = WalletRecord::from_profile(&profile);
        if let WalletRecord::Profile { accounts, .. } = &mut raw {
            accounts.clear();
        }
        let before = seed_diagnostic(&harness, raw.clone());
        assert_eq!(raw.ss58_address(), None);
        assert!(harness
            .service
            .delete_diagnostic_wallet(before.revision(), &raw)
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
        assert!(harness.vault.has_key(0, profile.generation()));
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn ordinary_account_and_metadata_changes_keep_unrelated_diagnostics_byte_for_byte() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let cold = harness
            .service
            .import_cold_account(AccountId32::from_bytes([0x54; 32]), "异常保留")
            .await
            .unwrap();
        let raw = broken_mode(WalletRecord::from_cold_account(&cold));
        seed_diagnostic(&harness, raw.clone());
        let state = harness.profiles.snapshot();
        harness
            .service
            .set_active_wallet(state.revision(), 0)
            .await
            .unwrap();
        let state = harness.profiles.snapshot();
        harness
            .service
            .rename_wallet(state.revision(), 0, "正常钱包")
            .await
            .unwrap();
        harness
            .service
            .rename_account(profile.master_account_id(), "正常账户")
            .await
            .unwrap();
        harness
            .service
            .add_next_account(&known_mnemonic(), "")
            .await
            .unwrap();
        assert_eq!(harness.profiles.snapshot().diagnostics(), &[raw]);
    });
}

#[test]
fn engine_internal_cold_wallet_surface_uses_the_same_catalog_state() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let account_id = AccountId32::from_bytes([0xac; 32]);
        let imported = engine
            .import_cold_wallet_account(account_id, "冷签账户".to_owned())
            .await
            .unwrap();
        assert_eq!(imported.account_id(), account_id);
        assert_eq!(
            engine.wallet_account_sign_mode(account_id).await.unwrap(),
            Some(WalletSignMode::Cold)
        );
        assert_eq!(
            engine.wallet_state().await.unwrap().default_account_id(),
            Some(account_id)
        );
        engine
            .rename_cold_wallet_account(account_id, "治理冷签".to_owned())
            .await
            .unwrap();
        engine.delete_cold_wallet_account(account_id).await.unwrap();
        assert!(engine
            .wallet_state()
            .await
            .unwrap()
            .cold_accounts()
            .is_empty());
        engine.dispose().unwrap();
    });
}

#[test]
fn public_catalog_reorder_uses_revision_and_cannot_change_the_default_account() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let first = AccountId32::from_bytes([0xad; 32]);
        let second = AccountId32::from_bytes([0xae; 32]);
        engine
            .import_cold_wallet_account(first, "默认冷账户".to_owned())
            .await
            .unwrap();
        engine
            .import_cold_wallet_account(second, "备用冷账户".to_owned())
            .await
            .unwrap();
        let state = engine.wallet_state().await.unwrap();

        let changed_default = engine
            .reorder_wallet_accounts_without_default_change(state.revision(), vec![second, first])
            .await
            .expect_err("未授权默认账户变更必须失败");
        assert_contract_code(changed_default, ContractErrorCode::InvalidArgument);
        assert_eq!(
            engine.wallet_state().await.unwrap().default_account_id(),
            Some(first)
        );

        let stale = engine
            .reorder_wallet_accounts_without_default_change(
                state.revision().saturating_sub(1),
                vec![first, second],
            )
            .await
            .expect_err("过期 revision 必须失败");
        assert_contract_code(stale, ContractErrorCode::Conflict);

        let reordered = engine
            .reorder_wallet_accounts_without_default_change(state.revision(), vec![first, second])
            .await
            .unwrap();
        assert_eq!(reordered.default_account_id(), Some(first));
        assert_eq!(reordered.revision(), state.revision() + 1);

        let renamed = engine
            .rename_wallet_account_any(second, " 离线治理 ".to_owned())
            .await
            .unwrap();
        assert_eq!(
            renamed.cold_account_by_id(second).unwrap().name(),
            "离线治理"
        );
        let deleted = engine.delete_wallet_account_any(second).await.unwrap();
        assert!(deleted.cold_account_by_id(second).is_none());
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), 0);
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
        engine.dispose().unwrap();
    });
}

#[test]
fn generic_signing_intent_routes_hot_and_cold_accounts_without_business_payload_knowledge() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let hot = profile.master_account_id();
        let cold = AccountId32::from_bytes([0xaf; 32]);
        harness
            .service
            .import_cold_account(cold, "外部签名账户")
            .await
            .unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET | Modules::SIGNING).unwrap());

        let intent = SigningIntent::try_new(
            hot,
            b"opaque consumer bytes".to_vec(),
            SigningTransform::Blake2Domain(b"third-party.example".to_vec()),
        )
        .unwrap();
        let signing_message = intent.signing_message().unwrap();
        let payload_hash = intent.payload_hash().unwrap();
        let completion = engine.sign_wallet_intent(intent).await.unwrap();
        assert_eq!(completion.account_id(), hot);
        assert_eq!(completion.payload_hash(), payload_hash);
        assert!(harness
            .signer
            .verify(
                Sr25519PublicKey::from_bytes(hot.into_bytes()),
                signing_message,
                completion.signature(),
            )
            .await
            .unwrap());

        let vault_calls = harness.vault.open_calls.load(Ordering::SeqCst);
        let failure = engine
            .sign_wallet_intent(
                SigningIntent::try_new(cold, vec![0x01], SigningTransform::Raw).unwrap(),
            )
            .await
            .expect_err("冷账户必须交给外部签名 transport");
        assert_contract_code(failure, ContractErrorCode::Unsupported);
        assert_eq!(
            harness.vault.open_calls.load(Ordering::SeqCst),
            vault_calls,
            "冷账户路由不得尝试读取 SDK 热钱包金库",
        );
        engine.dispose().unwrap();
    });
}

#[test]
fn hot_default_account_change_signs_the_frozen_order_and_commits_once() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let hot = profile.master_account_id();
        let cold = AccountId32::from_bytes([0xb0; 32]);
        harness
            .service
            .import_cold_account(cold, "冷账户")
            .await
            .unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET | Modules::SIGNING).unwrap());
        let before = engine.wallet_state().await.unwrap();
        let authorization = engine
            .prepare_default_wallet_account_change(before.revision(), vec![cold, hot], 120)
            .await
            .unwrap();

        assert_eq!(authorization.before_account_ids(), &[hot, cold]);
        assert_eq!(authorization.ordered_account_ids(), &[cold, hot]);
        let committed = engine
            .authorize_hot_default_wallet_account_change(authorization)
            .await
            .unwrap();
        assert_eq!(committed.ordered_account_ids(), &[cold, hot]);
        assert_eq!(committed.default_account_id(), Some(cold));
        assert_eq!(committed.revision(), before.revision() + 1);
        engine.dispose().unwrap();
    });
}

#[test]
fn external_signature_can_authorize_cold_default_change_without_opening_the_sdk_vault() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let external_secret = SecretBuffer::try_new(vec![0x41; 32]).unwrap();
        let external_public = harness.signer.public_key(&external_secret).await.unwrap();
        let current = AccountId32::from_bytes(*external_public.as_bytes());
        let next = AccountId32::from_bytes([0xb1; 32]);
        harness
            .service
            .import_cold_account(current, "当前外部账户")
            .await
            .unwrap();
        harness
            .service
            .import_cold_account(next, "下一个外部账户")
            .await
            .unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET | Modules::SIGNING).unwrap());
        let before = engine.wallet_state().await.unwrap();
        let authorization = engine
            .prepare_default_wallet_account_change(before.revision(), vec![next, current], 120)
            .await
            .unwrap();
        let signature = harness
            .signer
            .sign(
                &external_secret,
                authorization
                    .signing_intent()
                    .unwrap()
                    .signing_message()
                    .unwrap(),
            )
            .await
            .unwrap();
        let committed = engine
            .commit_default_wallet_account_change(&authorization, signature)
            .await
            .unwrap();

        assert_eq!(committed.default_account_id(), Some(next));
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), 0);
        engine.dispose().unwrap();
    });
}

#[test]
fn default_account_authorization_rejects_stale_or_expired_snapshots() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let hot = profile.master_account_id();
        let cold = AccountId32::from_bytes([0xb2; 32]);
        harness
            .service
            .import_cold_account(cold, "冷账户")
            .await
            .unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET | Modules::SIGNING).unwrap());
        let before = engine.wallet_state().await.unwrap();
        let stale_authorization = engine
            .prepare_default_wallet_account_change(before.revision(), vec![cold, hot], 120)
            .await
            .unwrap();
        engine
            .rename_wallet_account_any(cold, "已修改目录".to_owned())
            .await
            .unwrap();
        let stale = engine
            .authorize_hot_default_wallet_account_change(stale_authorization)
            .await
            .expect_err("签名期间目录变化必须使授权失效");
        assert_contract_code(stale, ContractErrorCode::Conflict);
        assert_eq!(
            engine.wallet_state().await.unwrap().default_account_id(),
            Some(hot)
        );

        let current = engine.wallet_state().await.unwrap();
        let expired_authorization = harness
            .service
            .prepare_default_account_change(current.revision(), vec![cold, hot], 1)
            .await
            .unwrap();
        harness
            .clock
            .0
            .store(expired_authorization.expires_at() * 1_000, Ordering::SeqCst);
        let expired = harness
            .service
            .commit_default_account_change(
                &expired_authorization,
                Sr25519Signature::from_bytes([0; 64]),
            )
            .await
            .expect_err("过期授权必须在验签或写入前拒绝");
        assert_contract_code(expired, ContractErrorCode::Timeout);
        assert_eq!(
            engine.wallet_state().await.unwrap().default_account_id(),
            Some(hot)
        );
        engine.dispose().unwrap();
    });
}

#[test]
fn hot_wallet_changes_preserve_cold_accounts_and_cross_mode_duplicates_fail() {
    block_on(async {
        let harness = Harness::new();
        let cold_id = AccountId32::from_bytes([0xb1; 32]);
        harness
            .service
            .import_cold_account(cold_id, "冷账户")
            .await
            .unwrap();

        let mnemonic = known_mnemonic();
        let hot = harness.service.import(&mnemonic, "").await.unwrap();
        let hot_id = hot.master_account_id();
        let state = harness.profiles.snapshot();
        assert_eq!(state.ordered_account_ids(), &[cold_id, hot_id]);
        assert_eq!(state.cold_accounts().len(), 1);
        assert_contract_code(
            harness
                .service
                .import_cold_account(hot_id, "重复热账户")
                .await
                .expect_err("热冷 AccountId 不得重复"),
            ContractErrorCode::Conflict,
        );

        let child = harness
            .service
            .add_accounts(&mnemonic, "", &[1])
            .await
            .unwrap()
            .account_by_index(1)
            .unwrap()
            .account_id();
        assert_eq!(
            harness.profiles.snapshot().ordered_account_ids(),
            &[cold_id, hot_id, child]
        );
        harness.service.delete_wallet().await.unwrap();
        let state = harness.profiles.snapshot();
        assert!(state.profile().is_none());
        assert_eq!(state.cold_accounts().len(), 1);
        assert_eq!(state.ordered_account_ids(), &[cold_id]);
        assert_eq!(state.default_account_id(), Some(cold_id));
    });
}

#[test]
fn signing_guard_rejects_before_auth_without_wallet_management() {
    block_on(async {
        let harness = Harness::new();
        let mnemonic = SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        let auth_before = harness.vault.open_calls.load(Ordering::SeqCst);
        let writes_before = harness.profiles.cas_calls.load(Ordering::SeqCst);
        let result = harness
            .signing_service()
            .sign_guarded(profile.master_account_id(), vec![4, 0], &|| {
                Err(EngineError::Cancelled)
            })
            .await;
        assert_eq!(result, Err(EngineError::Cancelled));
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), auth_before);
        assert_eq!(
            harness.profiles.cas_calls.load(Ordering::SeqCst),
            writes_before
        );
    });
}

/// 钱包级标签不能被追加、账户改名或当前账户切换覆盖。
#[test]
fn wallet_name_is_independent_and_survives_account_mutations() {
    block_on(async {
        let h = Harness::new();
        let mnemonic = known_mnemonic();
        let original = h.service.import(&mnemonic, "").await.unwrap();
        let account_name = original.accounts()[0].name().to_owned();
        let before = h.profiles.snapshot();
        let calls = h.vault.open_calls.load(Ordering::SeqCst);
        let renamed = h
            .service
            .rename_wallet(before.revision(), 0, " 我的钱包 ")
            .await
            .unwrap();
        assert_eq!(renamed.profile().unwrap().wallet_name(), "我的钱包");
        assert_eq!(
            renamed.profile().unwrap().accounts()[0].name(),
            account_name
        );
        assert_eq!(renamed.ordered_account_ids(), before.ordered_account_ids());
        assert_eq!(h.vault.open_calls.load(Ordering::SeqCst), calls);
        let expanded = h.service.add_accounts(&mnemonic, "", &[1]).await.unwrap();
        let child = expanded.account_by_index(1).unwrap().account_id();
        assert_eq!(expanded.wallet_name(), "我的钱包");
        assert_eq!(
            h.service
                .set_active_account(child)
                .await
                .unwrap()
                .wallet_name(),
            "我的钱包"
        );
        let changed = h
            .service
            .rename_account(child, "账户单独名称")
            .await
            .unwrap();
        assert_eq!(changed.wallet_name(), "我的钱包");
        h.service.delete_account(child).await.unwrap();
        assert_eq!(
            h.service.profile().await.unwrap().unwrap().wallet_name(),
            "我的钱包"
        );
    });
}

/// 两种当前选择和默认顺序分别不变，冷钱包元数据操作不访问不可用金库。
#[test]
fn payment_wallet_selection_is_revision_bound_and_independent_of_default() {
    block_on(async {
        let h = Harness::new();
        *h.vault.availability.lock().unwrap() = VaultAvailability::Unavailable;
        let a = AccountId32::from_bytes([0xe1; 32]);
        let b = AccountId32::from_bytes([0xe2; 32]);
        h.service.import_cold_account(a, "一").await.unwrap();
        h.service.import_cold_account(b, "二").await.unwrap();
        let before = h.profiles.snapshot();
        assert_eq!(before.active_wallet_index(), Some(2));
        let selected = h
            .service
            .set_active_wallet(before.revision(), 1)
            .await
            .unwrap();
        assert_eq!(selected.active_wallet_index(), Some(1));
        assert_eq!(selected.default_account_id(), before.default_account_id());
        assert_eq!(selected.ordered_account_ids(), before.ordered_account_ids());
        let writes = h.profiles.cas_calls.load(Ordering::SeqCst);
        assert_eq!(
            h.service
                .set_active_wallet(selected.revision(), 1)
                .await
                .unwrap(),
            selected
        );
        assert_eq!(h.profiles.cas_calls.load(Ordering::SeqCst), writes);
        assert_contract_code(
            h.service
                .set_active_wallet(before.revision(), 2)
                .await
                .unwrap_err(),
            ContractErrorCode::Conflict,
        );
        assert_contract_code(
            h.service
                .set_active_wallet(selected.revision(), 99)
                .await
                .unwrap_err(),
            ContractErrorCode::NotFound,
        );
        assert_eq!(h.profiles.snapshot(), selected);
        let renamed = h
            .service
            .rename_wallet(selected.revision(), 2, "冷钱包名字")
            .await
            .unwrap();
        assert_eq!(renamed.cold_account_by_id(b).unwrap().name(), "冷钱包名字");
        assert_eq!(renamed.active_wallet_index(), Some(1));
        assert_eq!(h.vault.open_calls.load(Ordering::SeqCst), 0);
        assert_eq!(h.secrets.envelope_count(), 0);
    });
}

#[test]
fn wallet_metadata_rejects_bad_names_and_preserves_failed_cas() {
    block_on(async {
        let h = Harness::new();
        h.service
            .import_cold_account(AccountId32::from_bytes([0xe3; 32]), "原名")
            .await
            .unwrap();
        let before = h.profiles.snapshot();
        for name in [
            String::new(),
            " ".into(),
            "坏\u{0085}名".into(),
            "名".repeat(31),
        ] {
            assert_contract_code(
                h.service
                    .rename_wallet(before.revision(), 1, &name)
                    .await
                    .unwrap_err(),
                ContractErrorCode::InvalidArgument,
            );
            assert_eq!(h.profiles.snapshot(), before);
        }
        let boundary = "名".repeat(30);
        *h.profiles.next_fault.lock().unwrap() = WriteFault::BeforeWrite;
        assert!(h
            .service
            .rename_wallet(before.revision(), 1, &boundary)
            .await
            .is_err());
        assert_eq!(h.profiles.snapshot(), before);
        h.profiles.fail_next_after_write();
        let after = h
            .service
            .rename_wallet(before.revision(), 1, &boundary)
            .await
            .unwrap();
        assert_eq!(after.cold_accounts()[0].name(), boundary);
        assert_eq!(
            after,
            h.profiles.snapshot(),
            "写后异常只有精确回读候选才算成功"
        );
        assert_contract_code(
            h.service
                .rename_wallet(before.revision(), 1, "旧修订")
                .await
                .unwrap_err(),
            ContractErrorCode::Conflict,
        );
        assert_eq!(h.profiles.snapshot(), after);
    });
}

#[test]
fn deleting_selected_wallet_chooses_last_remaining_without_reordering_accounts() {
    block_on(async {
        let h = Harness::new();
        for byte in 1..=3 {
            h.service
                .import_cold_account(AccountId32::from_bytes([byte; 32]), "")
                .await
                .unwrap();
        }
        let before = h.profiles.snapshot();
        h.service
            .set_active_wallet(before.revision(), 1)
            .await
            .unwrap();
        h.service
            .delete_cold_account(AccountId32::from_bytes([1; 32]))
            .await
            .unwrap();
        let after = h.profiles.snapshot();
        assert_eq!(
            after.active_wallet_index(),
            Some(3),
            "原交互按wallet_index取最后一只"
        );
        assert_eq!(
            after.default_account_id(),
            Some(AccountId32::from_bytes([2; 32]))
        );
        h.service
            .delete_cold_account(AccountId32::from_bytes([3; 32]))
            .await
            .unwrap();
        assert_eq!(h.profiles.snapshot().active_wallet_index(), Some(2));
        h.service
            .delete_cold_account(AccountId32::from_bytes([2; 32]))
            .await
            .unwrap();
        assert_eq!(h.profiles.snapshot().active_wallet_index(), None);
    });
}

#[test]
fn signing_guard_cancellation_drains_late_auth_and_never_returns_signature() {
    use std::sync::atomic::AtomicBool;
    block_on(async {
        let harness = Harness::new();
        harness.entropy.0.store(224, Ordering::SeqCst);
        let mnemonic = SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        let (release, gate) = futures::channel::oneshot::channel();
        *harness.vault.open_gate.lock().unwrap() = Some(gate);
        let (entered, entered_rx) = futures::channel::oneshot::channel();
        *harness.vault.open_entered.lock().unwrap() = Some(entered);
        let cancelled = AtomicBool::new(false);
        let completed = harness.vault.open_completed.load(Ordering::SeqCst);
        let guard = || {
            if cancelled.load(Ordering::SeqCst) {
                Err(EngineError::Cancelled)
            } else {
                Ok(())
            }
        };
        let service = harness.signing_service();
        let work = Box::pin(service.sign_guarded(profile.master_account_id(), vec![4, 0], &guard));
        let work = match futures::future::select(work, entered_rx).await {
            futures::future::Either::Right((Ok(()), work)) => work,
            _ => panic!("必须进入真实授权等待"),
        };
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(
            harness.vault.open_completed.load(Ordering::SeqCst),
            completed
        );
        release.send(()).unwrap();
        assert_eq!(work.await, Err(EngineError::Cancelled));
        assert_eq!(
            harness.vault.open_completed.load(Ordering::SeqCst),
            completed + 1
        );
    });
}

#[test]
fn every_supported_word_count_round_trips_backup_import_accounts_and_deletion() {
    block_on(async {
        for count in [
            WalletWordCount::Words12,
            WalletWordCount::Words18,
            WalletWordCount::Words24,
        ] {
            for password in ["", "abcdef"] {
                let created = Harness::new();
                let prepared = created
                    .service
                    .prepare_create(count, Zeroizing::new(password.to_owned()))
                    .await
                    .unwrap();
                assert!(created.profiles.snapshot().profile().is_none());
                assert_eq!(created.secrets.envelope_count(), 0);
                let backup = prepared.with_mnemonic(|words| {
                    assert_eq!(
                        std::str::from_utf8(words)
                            .unwrap()
                            .split_whitespace()
                            .count(),
                        count.words()
                    );
                    SecretBuffer::try_new(words.to_vec()).unwrap()
                });
                let profile = created
                    .service
                    .commit_create_after_backup(prepared)
                    .await
                    .unwrap();
                let restored = Harness::new();
                let imported = restored.service.import(&backup, password).await.unwrap();
                assert_eq!(profile.master_account_id(), imported.master_account_id());
                let accounts = restored
                    .service
                    .add_accounts(&backup, password, &[1989, 1])
                    .await
                    .unwrap();
                assert_eq!(
                    accounts
                        .accounts()
                        .iter()
                        .filter(|account| account.index() != 0)
                        .map(|account| account.index())
                        .collect::<Vec<_>>(),
                    vec![1, 1989]
                );
                let before = restored.profiles.snapshot();
                assert!(restored
                    .service
                    .add_accounts(&backup, "wrong!", &[2])
                    .await
                    .is_err());
                assert_eq!(restored.profiles.snapshot(), before);
                restored
                    .service
                    .delete_account(accounts.account_by_index(1).unwrap().account_id())
                    .await
                    .unwrap();
                restored.service.delete_wallet().await.unwrap();
                assert!(restored.service.profile().await.unwrap().is_none());
                assert_eq!(restored.secrets.envelope_count(), 0);
            }
        }
    });
}

#[test]
fn create_add_accounts_usability_and_local_signing_form_one_complete_lifecycle() {
    block_on(async {
        let harness = Harness::new();
        let (created_profile, mnemonic) =
            create_confirmed(&harness.service, WalletWordCount::Words12, "Aa1!中华").await;
        assert_eq!(created_profile.origin(), WalletOrigin::Created);
        assert_eq!(created_profile.accounts().len(), 1);
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(created_profile.clone())
        );

        let master = created_profile.master_account_id();
        let message = b"CitizenSDK wallet signing contract".to_vec();
        let signature = harness
            .signing_service()
            .sign(master, message.clone())
            .await
            .expect("账户0本地签名");
        assert!(harness
            .signer
            .verify(
                citizen_sdk_contracts::Sr25519PublicKey::from_bytes(*master.as_bytes()),
                message,
                signature,
            )
            .await
            .unwrap());

        let added = harness
            .service
            .add_accounts(&mnemonic, "Aa1!中华", &[2, 1])
            .await
            .expect("追加账户按 index 排序");
        assert_eq!(
            added
                .accounts()
                .iter()
                .filter(|account| account.index() != 0)
                .map(|account| account.index())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        let child_one = added.account_by_index(1).unwrap().account_id();
        let active = harness
            .service
            .set_active_account(child_one)
            .await
            .expect("切换 active account");
        assert_eq!(active.active_account_id(), child_one);
        let renamed = harness
            .service
            .rename_account(child_one, " 日常账户 ")
            .await
            .expect("重命名账户");
        assert_eq!(renamed.account_by_id(child_one).unwrap().name(), "日常账户");
        assert_eq!(harness.secrets.envelope_count(), 3);
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(renamed)
        );

        let before = harness.profiles.snapshot();
        assert_contract_code(
            harness
                .service
                .add_accounts(&mnemonic, "wrong!", &[3])
                .await
                .expect_err("错误 password 不得追加账户"),
            ContractErrorCode::AuthenticationRequired,
        );
        assert_eq!(harness.profiles.snapshot(), before);
    });
}

#[test]
fn application_key_is_deterministic_domain_separated_and_rejects_cold_accounts() {
    use citizen_sdk_contracts::Modules;

    block_on(async {
        let harness = Harness::new();
        let (profile, _) = create_confirmed(&harness.service, WalletWordCount::Words12, "").await;
        let engine = harness.engine(Modules::try_new(Modules::WALLET | Modules::SIGNING).unwrap());
        let account = profile.master_account_id();
        let first = engine
            .derive_application_key(account, [7; 32], b"consumer.example/data".to_vec())
            .await
            .unwrap();
        let repeated = engine
            .derive_application_key(account, [7; 32], b"consumer.example/data".to_vec())
            .await
            .unwrap();
        let other = engine
            .derive_application_key(account, [8; 32], b"consumer.example/data".to_vec())
            .await
            .unwrap();
        let first_bytes = first.with_secret(ToOwned::to_owned);
        let repeated_bytes = repeated.with_secret(ToOwned::to_owned);
        let other_bytes = other.with_secret(ToOwned::to_owned);
        assert_eq!(first_bytes.len(), 32);
        assert_eq!(first_bytes, repeated_bytes);
        assert_ne!(first_bytes, other_bytes);

        let opens_before_batch = harness.vault.open_calls.load(Ordering::SeqCst);
        let batch = engine
            .derive_application_keys(
                account,
                [7; 32],
                vec![
                    b"consumer.example/data".to_vec(),
                    b"consumer.example/index".to_vec(),
                ],
            )
            .await
            .unwrap();
        assert_eq!(
            harness.vault.open_calls.load(Ordering::SeqCst),
            opens_before_batch + 1
        );
        let batch_bytes = batch.with_secret(ToOwned::to_owned);
        assert_eq!(batch_bytes.len(), 64);
        assert_eq!(&batch_bytes[..32], first_bytes.as_slice());
        let separate_index = engine
            .derive_application_key(account, [7; 32], b"consumer.example/index".to_vec())
            .await
            .unwrap();
        assert_eq!(
            &batch_bytes[32..],
            separate_index.with_secret(ToOwned::to_owned).as_slice()
        );
        // 派生与证明共用一次打开，派生字节保持既有KDF，签名绑定原账户。
        let opens = harness.vault.open_calls.load(Ordering::SeqCst);
        let message = vec![0x42; 32];
        let (prepared, signature) = engine
            .prepare_application_keys(
                account,
                [7; 32],
                vec![b"consumer.example/data".to_vec()],
                Some(message.clone()),
                &|| Ok(()),
            )
            .await
            .unwrap();
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), opens + 1);
        assert_eq!(prepared.with_secret(ToOwned::to_owned), first_bytes);
        assert!(harness
            .signer
            .verify(
                Sr25519PublicKey::from_bytes(account.into_bytes()),
                message,
                signature.unwrap()
            )
            .await
            .unwrap());
        let opens = harness.vault.open_calls.load(Ordering::SeqCst);
        assert_contract_code(
            engine
                .prepare_application_keys(
                    account,
                    [7; 32],
                    vec![vec![1]],
                    Some(vec![1; 31]),
                    &|| Ok(()),
                )
                .await
                .err()
                .unwrap(),
            ContractErrorCode::InvalidArgument,
        );
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), opens);
        let checks = AtomicUsize::new(0);
        let cancel_after_open = || {
            if checks.fetch_add(1, Ordering::SeqCst) >= 2 {
                Err(EngineError::Cancelled)
            } else {
                Ok(())
            }
        };
        assert!(matches!(
            engine
                .prepare_application_keys(
                    account,
                    [7; 32],
                    vec![vec![1]],
                    Some(vec![1; 32]),
                    &cancel_after_open
                )
                .await,
            Err(EngineError::Cancelled)
        ));
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), opens + 1);
        assert_eq!(
            harness.vault.open_completed.load(Ordering::SeqCst),
            opens + 1
        );
        let opens = harness.vault.open_calls.load(Ordering::SeqCst);
        assert!(matches!(
            engine
                .prepare_application_keys(account, [7; 32], vec![vec![1]], None, &|| Err(
                    EngineError::Cancelled
                ))
                .await,
            Err(EngineError::Cancelled)
        ));
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), opens);

        for infos in [Vec::new(), vec![vec![1]; 17], vec![Vec::new()]] {
            assert_contract_code(
                engine
                    .derive_application_keys(account, [7; 32], infos)
                    .await
                    .expect_err("invalid batch must fail before vault open"),
                ContractErrorCode::InvalidArgument,
            );
        }

        let cold = AccountId32::from_bytes([0xc1; 32]);
        harness
            .service
            .import_cold_account(cold, "独立外部设备")
            .await
            .unwrap();
        assert_contract_code(
            engine
                .derive_application_key(cold, [7; 32], vec![1])
                .await
                .expect_err("冷账户不得进入本机派生"),
            ContractErrorCode::Unsupported,
        );
        assert_contract_code(
            engine
                .derive_application_key(account, [7; 32], Vec::new())
                .await
                .expect_err("空 info 必须失败"),
            ContractErrorCode::InvalidArgument,
        );
        assert_contract_code(
            engine
                .derive_application_key(account, [7; 32], vec![0; 257])
                .await
                .expect_err("超长 info 必须失败"),
            ContractErrorCode::InvalidArgument,
        );
        engine.dispose().unwrap();
    });
}

#[test]
fn import_uses_the_same_verified_account_and_missing_ciphertext_is_not_usable() {
    block_on(async {
        let harness = Harness::new();
        let mnemonic = known_mnemonic();
        let imported = harness
            .service
            .import(&mnemonic, "")
            .await
            .expect("导入冻结助记词");
        assert_eq!(imported.origin(), WalletOrigin::Imported);
        assert_eq!(
            imported.master_account_id().as_bytes(),
            &decode_fixed_hex::<32>(
                "2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972"
            )
        );
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(imported.clone())
        );

        harness
            .secrets
            .remove_without_contract(imported.accounts()[0].secret_ref());
        assert_eq!(harness.service.usable_profile().await.unwrap(), None);
    });
}

#[test]
fn unavailable_security_never_persists_creation_or_import_side_effects() {
    block_on(async {
        for (availability, code) in [
            (
                VaultAvailability::NoStrongUserAuthentication,
                ContractErrorCode::AuthenticationRequired,
            ),
            (
                VaultAvailability::Unsupported,
                ContractErrorCode::Unsupported,
            ),
            (
                VaultAvailability::Unavailable,
                ContractErrorCode::Unavailable,
            ),
        ] {
            let harness = Harness::new();
            *harness.vault.availability.lock().unwrap() = availability;
            assert_contract_code(
                harness
                    .service
                    .prepare_create(WalletWordCount::Words12, Zeroizing::new(String::new()))
                    .await
                    .unwrap_err(),
                code,
            );
            assert_contract_code(
                harness
                    .service
                    .import(&known_mnemonic(), "")
                    .await
                    .unwrap_err(),
                code,
            );
            assert_eq!(harness.profiles.snapshot(), WalletState::empty());
            assert_eq!(harness.profiles.cas_calls.load(Ordering::SeqCst), 0);
            assert_eq!(harness.secrets.envelope_count(), 0);
            assert!(harness.vault.wallet_keys.lock().unwrap().is_empty());
        }
    });
}

#[test]
fn public_profile_and_rename_need_no_unlock_and_invalid_names_never_commit() {
    block_on(async {
        let harness = Harness::new();
        assert!(harness.service.profile().await.unwrap().is_none());
        assert!(harness.service.usable_profile().await.unwrap().is_none());
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        *harness.vault.availability.lock().unwrap() = VaultAvailability::Unavailable;
        assert_eq!(
            harness.service.profile().await.unwrap(),
            Some(profile.clone())
        );
        let renamed = harness
            .service
            .rename_account(profile.master_account_id(), " 本地名称 ")
            .await
            .unwrap();
        assert_eq!(renamed.accounts()[0].name(), "本地名称");
        let before = harness.profiles.snapshot();
        for name in ["", "   ", &"a".repeat(257)] {
            assert!(harness
                .service
                .rename_account(profile.master_account_id(), name)
                .await
                .is_err());
        }
        let unknown = AccountId32::from_bytes([0xf1; 32]);
        assert!(harness
            .service
            .rename_account(unknown, "未知")
            .await
            .is_err());
        assert!(harness.service.set_active_account(unknown).await.is_err());
        assert!(harness
            .signing_service()
            .sign(unknown, vec![])
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
        assert_eq!(harness.secrets.envelope_count(), 1);
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn missing_key_or_any_existing_child_blocks_append_before_new_facts() {
    block_on(async {
        for missing_key in [false, true] {
            let harness = Harness::new();
            let mnemonic = known_mnemonic();
            let profile = harness.service.import(&mnemonic, "").await.unwrap();
            let child = harness
                .service
                .add_accounts(&mnemonic, "", &[1])
                .await
                .unwrap();
            if missing_key {
                harness
                    .vault
                    .wallet_keys
                    .lock()
                    .unwrap()
                    .remove(&(profile.wallet_index(), profile.generation()));
            } else {
                harness
                    .secrets
                    .remove_without_contract(child.account_by_index(1).unwrap().secret_ref());
            }
            let before = harness.profiles.snapshot();
            let count = harness.secrets.envelope_count();
            assert!(harness.service.usable_profile().await.unwrap().is_none());
            assert!(harness
                .service
                .add_accounts(&mnemonic, "", &[2])
                .await
                .is_err());
            assert_eq!(harness.profiles.snapshot(), before);
            assert_eq!(harness.secrets.envelope_count(), count);
        }
    });
}

#[test]
fn mismatched_child_ciphertext_is_not_usable_and_cannot_sign() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        harness
            .secrets
            .insert_envelope(profile.accounts()[0].secret_ref());
        let before = harness.profiles.snapshot();
        assert!(harness.service.usable_profile().await.unwrap().is_none());
        assert_contract_code(
            harness
                .signing_service()
                .sign(profile.master_account_id(), b"public test message".to_vec())
                .await
                .unwrap_err(),
            ContractErrorCode::Integrity,
        );
        assert_eq!(harness.profiles.snapshot(), before);
    });
}

#[test]
fn independent_signing_rechecks_device_security_before_opening_a_secret() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        for (availability, code) in [
            (
                VaultAvailability::NoStrongUserAuthentication,
                ContractErrorCode::AuthenticationRequired,
            ),
            (
                VaultAvailability::Unsupported,
                ContractErrorCode::Unsupported,
            ),
            (
                VaultAvailability::Unavailable,
                ContractErrorCode::Unavailable,
            ),
        ] {
            *harness.vault.availability.lock().unwrap() = availability;
            let before = harness.profiles.snapshot();
            assert_contract_code(
                harness
                    .signing_service()
                    .sign(profile.master_account_id(), Vec::new())
                    .await
                    .expect_err("设备保护不可用时独立签名必须拒绝"),
                code,
            );
            assert_eq!(harness.profiles.snapshot(), before);
        }
    });
}

#[test]
fn create_converges_when_profile_and_ciphertext_cas_throw_after_writing() {
    block_on(async {
        let harness = Harness::new();
        harness.profiles.fail_next_after_write();
        harness.secrets.fail_next_after_write();

        let prepared = harness
            .service
            .prepare_create(WalletWordCount::Words12, Zeroizing::new(String::new()))
            .await
            .expect("准备创建");
        let profile = harness
            .service
            .commit_create_after_backup(prepared)
            .await
            .expect("写后抛错必须通过完整回读收敛");
        assert_eq!(
            harness.service.profile().await.unwrap(),
            Some(profile.clone())
        );
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(profile)
        );
        assert_eq!(harness.secrets.envelope_count(), 1);
    });
}

#[test]
fn incomplete_create_never_exposes_the_uncommitted_target_profile() {
    block_on(async {
        let harness = Harness::new();
        let (profile, _mnemonic) =
            create_confirmed(&harness.service, WalletWordCount::Words12, "").await;
        let plan = WalletProvisioningPlan::try_new(
            [0x77; 16],
            profile.wallet_index(),
            profile.generation(),
            None,
            profile
                .accounts()
                .iter()
                .map(|account| account.secret_ref())
                .collect(),
            true,
        )
        .unwrap();
        let current = harness.profiles.snapshot();
        *harness.profiles.state.lock().unwrap() = WalletState::try_from_parts(
            current.revision() + 1,
            Some(profile.clone()),
            Some(plan),
            None,
            Vec::new(),
        )
        .unwrap();

        assert_eq!(harness.service.profile().await.unwrap(), None);
        let visible = harness.service.state().await.unwrap();
        assert!(visible.profile().is_none());
        assert!(visible.ordered_account_ids().is_empty());
        assert_eq!(
            visible.initialization_state(),
            crate::WalletInitializationState::Recovering
        );
        assert!(!visible.cleanup_pending());
        assert_eq!(harness.service.usable_profile().await.unwrap(), None);
        assert_contract_code(
            harness
                .signing_service()
                .sign(profile.master_account_id(), b"must stay hidden".to_vec())
                .await
                .expect_err("未完成 create 的目标 profile 不得进入签名路径"),
            ContractErrorCode::NotFound,
        );
    });
}

#[test]
fn signed_deletion_authorizes_account_zero_but_plain_wipe_does_not_open_a_secret() {
    block_on(async {
        let signed = Harness::new();
        signed.service.import(&known_mnemonic(), "").await.unwrap();
        let before = signed.vault.open_calls.load(Ordering::SeqCst);
        signed.service.sign_and_delete_wallet().await.unwrap();
        assert_eq!(signed.vault.open_calls.load(Ordering::SeqCst), before + 1);
        assert!(signed.service.profile().await.unwrap().is_none());

        let wipe = Harness::new();
        let profile = wipe.service.import(&known_mnemonic(), "").await.unwrap();
        wipe.vault
            .wallet_keys
            .lock()
            .unwrap()
            .remove(&(profile.wallet_index(), profile.generation()));
        let before = wipe.profiles.snapshot();
        assert_contract_code(
            wipe.service.sign_and_delete_wallet().await.unwrap_err(),
            ContractErrorCode::KeyInvalidated,
        );
        assert_eq!(wipe.profiles.snapshot(), before);
        assert_eq!(wipe.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
        let opens = wipe.vault.open_calls.load(Ordering::SeqCst);
        wipe.service.delete_wallet().await.unwrap();
        assert_eq!(wipe.vault.open_calls.load(Ordering::SeqCst), opens);
        assert!(wipe.service.profile().await.unwrap().is_none());
    });
}

#[test]
fn signed_deletion_does_not_remove_a_snapshot_changed_during_authorization() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let (entered, waiting) = futures::channel::oneshot::channel();
        let (release, gate) = futures::channel::oneshot::channel();
        *harness.vault.open_entered.lock().unwrap() = Some(entered);
        *harness.vault.open_gate.lock().unwrap() = Some(gate);
        let change = async {
            waiting.await.unwrap();
            let before = harness.profiles.snapshot();
            let renamed = profile
                .try_with_account_name(profile.master_account_id(), "合成并发改名")
                .unwrap();
            *harness.profiles.state.lock().unwrap() = WalletState::try_from_parts(
                before.revision() + 1,
                Some(renamed),
                None,
                None,
                Vec::new(),
            )
            .unwrap();
            release.send(()).unwrap();
        };
        let (result, ()) = join!(harness.service.sign_and_delete_wallet(), change);
        assert_contract_code(result.unwrap_err(), ContractErrorCode::Conflict);
        assert!(harness.service.profile().await.unwrap().is_some());
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn headless_next_account_is_atomic_and_does_not_reuse_a_deleted_hole() {
    block_on(async {
        let harness = Harness::new();
        let mnemonic = known_mnemonic();
        harness.service.import(&mnemonic, "").await.unwrap();
        let (first, second) = futures::join!(
            harness.service.add_next_account(&mnemonic, ""),
            harness.service.add_next_account(&mnemonic, ""),
        );
        let mut counts = [
            first.unwrap().accounts().len(),
            second.unwrap().accounts().len(),
        ];
        counts.sort();
        assert_eq!(counts, [2, 3]);
        let profile = harness.service.profile().await.unwrap().unwrap();
        harness
            .service
            .delete_account(profile.account_by_index(1).unwrap().account_id())
            .await
            .unwrap();
        let profile = harness
            .service
            .add_next_account(&mnemonic, "")
            .await
            .unwrap();
        assert!(profile.account_by_index(1).is_none());
        assert!(profile.account_by_index(3).is_some());
        let before = harness.profiles.snapshot();
        assert!(harness
            .service
            .add_next_account(&mnemonic, "wrong!")
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
        harness
            .service
            .add_accounts(&mnemonic, "", &[1989])
            .await
            .unwrap();
        let before = harness.profiles.snapshot();
        assert!(harness
            .service
            .add_next_account(&mnemonic, "")
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
    });
}

#[test]
fn headless_initialization_is_empty_or_ready_without_touching_hot_secrets() {
    block_on(async {
        let harness = Harness::new();
        assert_eq!(
            harness
                .service
                .state()
                .await
                .unwrap()
                .initialization_state(),
            crate::WalletInitializationState::Empty
        );
        let before = harness.vault.open_calls.load(Ordering::SeqCst);
        harness
            .service
            .import_cold_account(AccountId32::from_bytes([0x74; 32]), "合成冷账户")
            .await
            .unwrap();
        let snapshot = harness.service.state().await.unwrap();
        assert_eq!(
            snapshot.initialization_state(),
            crate::WalletInitializationState::Ready
        );
        assert!(!snapshot.cleanup_pending());
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), before);
    });
}

#[test]
fn failed_create_recovers_orphan_ciphertext_and_owned_wallet_key() {
    block_on(async {
        let harness = Harness::new();
        // 第一次 CAS 取得 provisioning 所有权；第二次 CAS 本应清除 provisioning。
        // 在第二次写入前失败，验证已经写下的密文与本操作 generation 均被补偿清理。
        harness.profiles.fail_before_exact_call(2);
        let prepared = harness
            .service
            .prepare_create(WalletWordCount::Words12, Zeroizing::new(String::new()))
            .await
            .expect("准备创建");
        assert_contract_code(
            harness
                .service
                .commit_create_after_backup(prepared)
                .await
                .expect_err("完成事实写入失败应返回原错误"),
            ContractErrorCode::Storage,
        );

        let recovered = harness.profiles.snapshot();
        assert!(recovered.profile().is_none());
        assert!(recovered.provisioning().is_none());
        assert!(recovered.cleanup().is_none());
        assert!(recovered.cleanup_queue().is_empty());
        assert_eq!(harness.secrets.envelope_count(), 0);
        assert_eq!(harness.vault.wallet_keys.lock().unwrap().len(), 0);
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn concurrent_instances_loser_never_deletes_the_winner_wallet() {
    block_on(async {
        let harness = Harness::new();
        let other = harness.second_service();
        let import_mnemonic = known_mnemonic();
        let prepared = harness
            .service
            .prepare_create(WalletWordCount::Words12, Zeroizing::new(String::new()))
            .await
            .expect("准备创建");
        // `join!` 的轮询次序不是钱包锁所有权证据。让 create 在设备安全检查中
        // 显式通知已经持有进程级钱包操作锁，再放行 import 进入竞争。
        let (availability_entered, create_holds_gate) = futures::channel::oneshot::channel();
        let (release_create, availability_gate) = futures::channel::oneshot::channel();
        *harness.vault.availability_entered.lock().unwrap() = Some(availability_entered);
        *harness.vault.availability_gate.lock().unwrap() = Some(availability_gate);
        let release_after_create_enters = async move {
            let _ = create_holds_gate.await;
            let _ = release_create.send(());
        };
        let (create_result, import_result, ()) = join!(
            harness.service.commit_create_after_backup(prepared),
            other.import(&import_mnemonic, ""),
            release_after_create_enters,
        );

        let winner = create_result.expect("先取得全局操作所有权的 create 应成功");
        assert_contract_code(
            import_result.expect_err("另一个实例不得覆盖已成功钱包"),
            ContractErrorCode::InvalidState,
        );
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(winner.clone())
        );
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
        assert!(harness
            .vault
            .has_key(winner.wallet_index(), winner.generation()));
        assert_eq!(harness.secrets.envelope_count(), 1);
    });
}

#[test]
fn prepared_creation_is_storage_free_until_explicit_commit() {
    block_on(async {
        let harness = Harness::new();
        let prepared = harness
            .service
            .prepare_create(
                WalletWordCount::Words12,
                Zeroizing::new("Aa1!待清零".to_owned()),
            )
            .await
            .expect("准备一次性创建会话");
        assert!(!prepared.with_mnemonic(|words| words.is_empty()));
        assert_eq!(harness.profiles.snapshot(), WalletState::empty());
        assert_eq!(harness.secrets.envelope_count(), 0);
        assert!(harness.vault.wallet_keys.lock().unwrap().is_empty());

        drop(prepared);
        assert_eq!(harness.profiles.snapshot(), WalletState::empty());
        assert_eq!(harness.secrets.envelope_count(), 0);
        assert!(harness.vault.wallet_keys.lock().unwrap().is_empty());

        let (profile, _backup) =
            create_confirmed(&harness.service, WalletWordCount::Words12, "").await;
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(profile)
        );
    });
}

#[test]
fn add_accounts_write_after_errors_preserve_active_and_every_added_account() {
    block_on(async {
        let harness = Harness::new();
        let mnemonic = known_mnemonic();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        let first = harness
            .service
            .add_accounts(&mnemonic, "", &[1])
            .await
            .unwrap()
            .account_by_index(1)
            .unwrap()
            .clone();
        harness
            .service
            .set_active_account(first.account_id())
            .await
            .unwrap();

        harness.profiles.fail_next_after_write();
        harness.secrets.fail_next_after_write();
        // 追加返回完整profile；原账户与新增账户必须同时保留。
        let added = harness
            .service
            .add_accounts(&mnemonic, "", &[3, 2])
            .await
            .expect("profile/首个密文写后异常均应收敛");
        assert_eq!(
            added
                .accounts()
                .iter()
                .map(|account| account.index())
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );

        let current = harness.service.profile().await.unwrap().unwrap();
        assert_eq!(current.master_account_id(), profile.master_account_id());
        assert_eq!(current.active_account_id(), first.account_id());
        assert_eq!(
            current
                .accounts()
                .iter()
                .map(|account| account.index())
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert!(current
            .accounts()
            .iter()
            .all(|account| harness.secrets.has_envelope(account.secret_ref())));
        assert_eq!(
            harness.service.usable_profile().await.unwrap(),
            Some(current)
        );
    });
}

#[test]
fn child_anchor_and_whole_wallet_deletion_honor_exact_ownership() {
    block_on(async {
        let harness = Harness::new();
        let mnemonic = known_mnemonic();
        let base = harness.service.import(&mnemonic, "").await.unwrap();
        let added = harness
            .service
            .add_accounts(&mnemonic, "", &[1, 2])
            .await
            .unwrap();
        let child_one = added.account_by_index(1).unwrap().clone();
        let child_two = added.account_by_index(2).unwrap().clone();
        harness
            .service
            .set_active_account(child_one.account_id())
            .await
            .unwrap();

        harness
            .service
            .delete_account(child_one.account_id())
            .await
            .expect("删除 active 子账户");
        let after_child = harness.service.profile().await.unwrap().unwrap();
        assert_eq!(after_child.active_account_id(), base.master_account_id());
        assert!(after_child.account_by_id(child_one.account_id()).is_none());
        assert!(!harness.secrets.has_envelope(child_one.secret_ref()));
        assert!(harness
            .vault
            .has_key(base.wallet_index(), base.generation()));

        assert_contract_code(
            harness
                .service
                .delete_account(base.master_account_id())
                .await
                .expect_err("仍有子账户时锚点不得单独删除"),
            ContractErrorCode::InvalidState,
        );
        harness
            .service
            .delete_account(child_two.account_id())
            .await
            .unwrap();
        harness
            .service
            .delete_account(base.master_account_id())
            .await
            .expect("只剩锚点时该入口等价整钱包删除");
        assert!(harness.service.profile().await.unwrap().is_none());
        assert_eq!(harness.secrets.envelope_count(), 0);
        assert!(!harness
            .vault
            .has_key(base.wallet_index(), base.generation()));

        // 同一设备可建立新生命周期，显式 delete_wallet 也必须清除全部物理目标。
        let replacement = harness.service.import(&mnemonic, "").await.unwrap();
        harness.service.delete_wallet().await.unwrap();
        assert!(harness.service.profile().await.unwrap().is_none());
        assert_eq!(harness.secrets.envelope_count(), 0);
        assert!(!harness
            .vault
            .has_key(replacement.wallet_index(), replacement.generation()));
    });
}

#[test]
fn deleted_generation_and_secret_ref_reject_every_late_writer() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness
            .service
            .import(&known_mnemonic(), "")
            .await
            .expect("建立待删除钱包");
        let secret_ref = profile.accounts()[0].secret_ref();

        harness.service.delete_wallet().await.expect("删除钱包");
        let tombstone = harness.secrets.load(secret_ref).await.unwrap();
        assert!(tombstone.is_tombstone());

        let vault_error = harness
            .vault
            .seal(
                [0xE1; 16],
                secret_ref,
                SecretBuffer::try_new(vec![0xA5; 32]).unwrap(),
            )
            .await
            .expect_err("退休 generation 不得由迟到 seal 复活硬件密钥");
        assert_eq!(vault_error.code(), ContractErrorCode::KeyInvalidated);

        let blob_error = harness
            .secrets
            .compare_and_swap(
                secret_ref,
                tombstone.revision(),
                EncryptedSecretBlobState::Sealed {
                    provisioning_operation_id: [0xE1; 16],
                    envelope: test_envelope(secret_ref),
                },
            )
            .await
            .expect_err("永久墓碑不得由迟到密文写入覆盖");
        assert_eq!(blob_error.code(), ContractErrorCode::Conflict);
        assert!(harness
            .secrets
            .load(secret_ref)
            .await
            .unwrap()
            .is_tombstone());
    });
}

#[test]
fn reconcile_drains_queued_cleanup_before_the_active_cleanup() {
    block_on(async {
        let harness = Harness::new();
        let active_generation = VaultGeneration::from_bytes([0x11; 16]);
        let queued_generation = VaultGeneration::from_bytes([0x22; 16]);
        let active_ref = SecretRef::account_mini_secret(
            0,
            active_generation,
            SecretOwner::from_bytes([0x31; 16]),
            AccountId32::from_bytes([0x41; 32]),
        );
        let queued_ref = SecretRef::account_mini_secret(
            0,
            queued_generation,
            SecretOwner::from_bytes([0x32; 16]),
            AccountId32::from_bytes([0x42; 32]),
        );
        let active =
            WalletCleanupPlan::try_new([0x51; 16], 0, active_generation, vec![active_ref], true)
                .unwrap();
        let queued =
            WalletCleanupPlan::try_new([0x52; 16], 0, queued_generation, vec![queued_ref], true)
                .unwrap();
        harness.secrets.insert_envelope(active_ref);
        harness.secrets.insert_envelope(queued_ref);
        harness
            .vault
            .wallet_keys
            .lock()
            .unwrap()
            .extend([(0, active_generation), (0, queued_generation)]);
        *harness.profiles.state.lock().unwrap() =
            WalletState::try_from_parts(1, None, None, Some(active), vec![queued]).unwrap();

        harness.service.reconcile_cleanup().await.unwrap();
        assert_eq!(
            *harness.secrets.deletion_order.lock().unwrap(),
            vec![queued_ref, active_ref]
        );
        let state = harness.profiles.snapshot();
        assert!(state.cleanup().is_none());
        assert!(state.cleanup_queue().is_empty());
        assert_eq!(harness.secrets.envelope_count(), 0);
        assert!(harness.vault.wallet_keys.lock().unwrap().is_empty());
    });
}

fn known_mnemonic() -> SecretBuffer {
    SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap()
}

async fn create_confirmed(
    service: &WalletService,
    word_count: WalletWordCount,
    password: &str,
) -> (citizen_sdk_contracts::WalletProfile, SecretBuffer) {
    let prepared = service
        .prepare_create(word_count, Zeroizing::new(password.to_owned()))
        .await
        .expect("准备创建钱包");
    // 测试副本模拟用户已完成的离线备份；生产绑定必须用受控一次性展示句柄。
    let backup = prepared.with_mnemonic(|words| SecretBuffer::try_new(words.to_vec()).unwrap());
    let profile = service
        .commit_create_after_backup(prepared)
        .await
        .expect("确认备份后提交钱包");
    (profile, backup)
}

fn assert_contract_code(error: EngineError, expected: ContractErrorCode) {
    match error {
        EngineError::Contract(contract) => assert_eq!(contract.code(), expected, "{contract:?}"),
        other => panic!("期望 typed contract error，实际为 {other:?}"),
    }
}

fn storage_error(message: &str) -> ContractError {
    ContractError::new(ContractErrorCode::Storage, message)
}

fn conflict_error(message: &str) -> ContractError {
    ContractError::new(ContractErrorCode::Conflict, message)
}

fn secret_ref_digest(secret_ref: SecretRef) -> [u8; 32] {
    let mut digest = [0_u8; 32];
    digest[..16].copy_from_slice(secret_ref.generation().as_bytes());
    digest[16..].copy_from_slice(secret_ref.owner().as_bytes());
    for (target, account) in digest.iter_mut().zip(secret_ref.account_id().as_bytes()) {
        *target ^= account;
    }
    digest[0] ^= secret_ref.wallet_index() as u8;
    digest
}

fn test_envelope(secret_ref: SecretRef) -> EncryptedSecretEnvelope {
    EncryptedSecretEnvelope::try_new(
        1,
        Hash32Bytes::from_bytes(secret_ref_digest(secret_ref)),
        vec![0xAA; 32],
    )
    .unwrap()
}

fn decode_fixed_hex<const N: usize>(encoded: &str) -> [u8; N] {
    assert_eq!(encoded.len(), N * 2);
    let mut output = [0_u8; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16).unwrap();
    }
    output
}

#[cfg(feature = "wallet")]
#[test]
fn private_key_view_requires_confirmation_and_holds_wallet_until_ui_and_notification_finish() {
    use citizen_sdk_contracts::Modules;
    block_on(async {
        let harness = Harness::new();
        harness.entropy.0.store(160, Ordering::SeqCst);
        let mnemonic = SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let view = engine
            .internal_private_key_view(profile.master_account_id(), None)
            .unwrap();
        let before_auth = harness.vault.open_calls.load(Ordering::SeqCst);
        assert!(view.reserve_work().unwrap());
        view.run_work(|_| panic!("准备阶段不得调用显示"))
            .await
            .unwrap();
        view.release_work().unwrap();
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), before_auth);
        assert!(view.take_notification().unwrap().is_none());
        assert!(view.take_completion().unwrap().is_none());
        assert!(engine.dispose().is_err());
        assert!(harness.second_service().delete_wallet().await.is_err());
        assert!(harness
            .service
            .rename_account(profile.master_account_id(), "禁止变更")
            .await
            .is_err());
        let revision = harness.profiles.snapshot().revision();
        view.confirm().unwrap();
        assert!(view.confirm().is_err(), "用户确认只允许一次");
        assert!(view.reserve_work().unwrap());
        let displayed = AtomicUsize::new(0);
        view.run_work(|bytes| {
            assert_eq!(bytes.len(), 32);
            displayed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
        view.release_work().unwrap();
        assert_eq!(displayed.load(Ordering::SeqCst), 1);
        assert_eq!(
            harness.profiles.snapshot().revision(),
            revision,
            "查看不持久写入"
        );
        assert_eq!(view.take_notification().unwrap(), Some(Ok(())));
        view.finish().unwrap();
        assert!(
            view.take_completion().unwrap().is_none(),
            "settled 自身仍未返回"
        );
        view.finish_notification().unwrap();
        assert_eq!(view.take_completion().unwrap(), Some(Ok(())));
        assert!(view.take_completion().unwrap().is_none());
        assert!(view.take_notification().unwrap().is_none());
        assert!(!view.reserve_work().unwrap());
        harness.service.delete_wallet().await.unwrap();
        engine.dispose().unwrap();
    });
}

#[cfg(feature = "wallet")]
#[test]
fn private_key_view_cancel_and_finish_do_not_drop_pending_authentication_or_allow_late_display() {
    use citizen_sdk_contracts::Modules;
    block_on(async {
        let harness = Harness::new();
        harness.entropy.0.store(176, Ordering::SeqCst);
        let mnemonic = SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let view = engine
            .internal_private_key_view(profile.master_account_id(), None)
            .unwrap();
        view.confirm().unwrap(); // open 准备尚未完成时原生确认可以先排队。
        assert!(view.reserve_work().unwrap());
        let (release, gate) = futures::channel::oneshot::channel();
        *harness.vault.open_gate.lock().unwrap() = Some(gate);
        let before_completed = harness.vault.open_completed.load(Ordering::SeqCst);
        let (entered, entered_rx) = futures::channel::oneshot::channel();
        *harness.vault.open_entered.lock().unwrap() = Some(entered);
        let displayed = AtomicUsize::new(0);
        let work = Box::pin(view.run_work(|_| {
            displayed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        let work = match futures::future::select(work, entered_rx).await {
            futures::future::Either::Right((Ok(()), work)) => work,
            _ => panic!("必须先真实进入授权等待"),
        };
        view.cancel().unwrap();
        assert_eq!(
            view.take_notification().unwrap(),
            Some(Err(EngineError::Cancelled))
        );
        view.finish().unwrap();
        view.finish_notification().unwrap();
        assert!(
            view.take_completion().unwrap().is_none(),
            "取消不能丢弃实际授权 future"
        );
        assert_eq!(
            harness.vault.open_completed.load(Ordering::SeqCst),
            before_completed
        );
        assert!(harness.service.delete_wallet().await.is_err());
        assert!(engine.dispose().is_err());
        release.send(()).unwrap();
        work.await.unwrap();
        view.release_work().unwrap();
        assert_eq!(displayed.load(Ordering::SeqCst), 0);
        assert_eq!(
            harness.vault.open_completed.load(Ordering::SeqCst),
            before_completed + 1
        );
        assert_eq!(
            view.take_completion().unwrap(),
            Some(Err(EngineError::Cancelled))
        );
        assert!(view.take_notification().unwrap().is_none());
        harness.service.delete_wallet().await.unwrap();
        engine.dispose().unwrap();
    });
}

#[cfg(feature = "wallet")]
#[test]
fn private_key_view_cancel_before_work_never_loads_a_secret_and_missing_account_settles_once() {
    use citizen_sdk_contracts::Modules;
    block_on(async {
        let harness = Harness::new();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let missing = AccountId32::from_bytes([0; 32]);
        let view = engine.internal_private_key_view(missing, None).unwrap();
        view.cancel().unwrap();
        assert!(!view.reserve_work().unwrap());
        assert_eq!(
            view.take_notification().unwrap(),
            Some(Err(EngineError::Cancelled))
        );
        view.finish_notification().unwrap();
        view.finish().unwrap();
        assert_eq!(
            view.take_completion().unwrap(),
            Some(Err(EngineError::Cancelled))
        );
        let view = engine.internal_private_key_view(missing, None).unwrap();
        assert!(view.reserve_work().unwrap());
        let failure = view
            .run_work(|_| panic!("缺账户不得显示"))
            .await
            .unwrap_err();
        view.fail(failure).unwrap();
        let error = view.take_notification().unwrap().unwrap().unwrap_err();
        assert_contract_code(error, ContractErrorCode::NotFound);
        view.release_work().unwrap();
        view.finish().unwrap();
        assert!(view.take_completion().unwrap().is_none());
        view.finish_notification().unwrap();
        assert!(view.take_completion().unwrap().unwrap().is_err());
        assert_eq!(harness.vault.open_calls.load(Ordering::SeqCst), 0);
        assert_eq!(harness.profiles.cas_calls.load(Ordering::SeqCst), 0);
        assert!(harness
            .engine(Modules::try_new(Modules::SIGNING).unwrap())
            .internal_private_key_view(missing, None)
            .is_err());
    });
}

#[cfg(feature = "wallet")]
#[test]
fn private_key_view_rechecks_generation_after_pending_authorization() {
    use citizen_sdk_contracts::Modules;
    block_on(async {
        let harness = Harness::new();
        harness.entropy.0.store(192, Ordering::SeqCst);
        let replacement = Harness::new();
        replacement.entropy.0.store(208, Ordering::SeqCst);
        let mnemonic = SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        replacement.service.import(&mnemonic, "").await.unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let view = engine
            .internal_private_key_view(profile.master_account_id(), None)
            .unwrap();
        view.confirm().unwrap();
        assert!(view.reserve_work().unwrap());
        let (release, gate) = futures::channel::oneshot::channel();
        *harness.vault.open_gate.lock().unwrap() = Some(gate);
        let (entered, entered_rx) = futures::channel::oneshot::channel();
        *harness.vault.open_entered.lock().unwrap() = Some(entered);
        let work = Box::pin(view.run_work(|_| panic!("换代账户不得显示")));
        // Pending 也可能是钱包门竞争；必须等明确的 vault.open 进入信号后才能模拟换代。
        let work = match futures::future::select(work, entered_rx).await {
            futures::future::Either::Right((Ok(()), work)) => work,
            _ => panic!("必须先真实进入授权等待"),
        };
        // 模拟外部持久层被置换，不绕过 SDK 变更门制造成功路径。
        *harness.profiles.state.lock().unwrap() = replacement.profiles.snapshot();
        release.send(()).unwrap();
        work.await.unwrap();
        view.release_work().unwrap();
        let failure = view.take_notification().unwrap().unwrap().unwrap_err();
        assert_contract_code(failure, ContractErrorCode::Conflict);
        view.finish_notification().unwrap();
        view.finish().unwrap();
        assert!(view.take_completion().unwrap().unwrap().is_err());
        engine.dispose().unwrap();
    });
}

#[cfg(feature = "wallet")]
#[test]
fn private_key_view_rejects_missing_ciphertext_invalidated_key_and_wrong_account_public_key() {
    use citizen_sdk_contracts::Modules;
    block_on(async {
        let harness = Harness::new();
        harness.entropy.0.store(224, Ordering::SeqCst);
        let mnemonic = SecretBuffer::try_new(KNOWN_MNEMONIC.as_bytes().to_vec()).unwrap();
        let profile = harness.service.import(&mnemonic, "").await.unwrap();
        let child = harness
            .service
            .add_accounts(&mnemonic, "", &[1])
            .await
            .unwrap()
            .account_by_index(1)
            .unwrap()
            .clone();
        let master = profile.account_by_id(profile.master_account_id()).unwrap();
        let master_ref = master.secret_ref();
        let original = harness.secrets.entries.lock().unwrap()[&master_ref].clone();
        let child_envelope = harness.secrets.entries.lock().unwrap()[&child.secret_ref()]
            .envelope()
            .cloned()
            .unwrap();
        let engine = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        for expected in [
            ContractErrorCode::AuthenticationRequired,
            ContractErrorCode::KeyInvalidated,
            ContractErrorCode::Integrity,
        ] {
            harness
                .secrets
                .entries
                .lock()
                .unwrap()
                .insert(master_ref, original.clone());
            harness
                .vault
                .wallet_keys
                .lock()
                .unwrap()
                .insert((master_ref.wallet_index(), master_ref.generation()));
            match expected {
                ContractErrorCode::AuthenticationRequired => {
                    harness.secrets.remove_without_contract(master_ref)
                }
                ContractErrorCode::KeyInvalidated => {
                    harness.vault.wallet_keys.lock().unwrap().clear();
                }
                ContractErrorCode::Integrity => {
                    // 仅复用已有公开向量派生的另一个 child；不输出或断言秘密内容。
                    let envelope = EncryptedSecretEnvelope::try_new(
                        1,
                        Hash32Bytes::from_bytes(secret_ref_digest(master_ref)),
                        child_envelope.ciphertext().to_vec(),
                    )
                    .unwrap();
                    let swapped = EncryptedSecretBlobSnapshot::empty()
                        .try_advance(EncryptedSecretBlobState::Sealed {
                            provisioning_operation_id: [0x61; 16],
                            envelope,
                        })
                        .unwrap();
                    harness
                        .secrets
                        .entries
                        .lock()
                        .unwrap()
                        .insert(master_ref, swapped);
                }
                _ => unreachable!(),
            }
            let view = engine
                .internal_private_key_view(master.account_id(), None)
                .unwrap();
            view.confirm().unwrap();
            assert!(view.reserve_work().unwrap());
            view.run_work(|_| panic!("无效设备秘密不得进入显示"))
                .await
                .unwrap();
            view.release_work().unwrap();
            assert_contract_code(
                view.take_notification().unwrap().unwrap().unwrap_err(),
                expected,
            );
            view.finish_notification().unwrap();
            view.finish().unwrap();
            assert!(view.take_completion().unwrap().unwrap().is_err());
        }
        engine.dispose().unwrap();
    });
}

#[cfg(all(feature = "wallet", feature = "signing"))]
#[test]
fn wallet_and_signing_modules_are_independent_without_a_chain_or_history() {
    use citizen_sdk_contracts::{CapabilityName, Modules, Sr25519PublicKey};
    block_on(async {
        let harness = Harness::new();
        let wallet = harness.engine(Modules::try_new(Modules::WALLET).unwrap());
        let prepared = wallet
            .prepare_wallet_creation(WalletWordCount::Words12, Zeroizing::new(String::new()))
            .await
            .expect("钱包独立创建不需要公开签名模块");
        let profile = wallet
            .commit_wallet_creation_after_backup(prepared)
            .await
            .expect("钱包独立备份提交");
        assert!(wallet.begin_provider_start().is_err(), "不能伪造轻节点启动");
        assert!(wallet.start_chain_monitor().await.is_err());
        let account_id = profile.master_account_id();
        assert!(wallet
            .sign_wallet_payload(account_id, b"module boundary".to_vec())
            .await
            .is_err());
        assert!(wallet
            .capabilities()
            .unwrap()
            .unwrap()
            .status(CapabilityName::WalletProfile)
            .unwrap()
            .is_ready());
        assert!(!wallet
            .capabilities()
            .unwrap()
            .unwrap()
            .status(CapabilityName::LocalSigning)
            .unwrap()
            .enabled());

        let signing = harness.engine(Modules::try_new(Modules::SIGNING).unwrap());
        assert!(
            signing.wallet_profile().await.is_err(),
            "签名不开放钱包管理"
        );
        assert!(
            signing
                .capabilities()
                .unwrap()
                .unwrap()
                .status(CapabilityName::LocalSigning)
                .unwrap()
                .is_ready(),
            "钱包管理关闭不应关闭独立签名"
        );
        let message = b"module boundary".to_vec();
        let signature = signing
            .sign_wallet_payload(account_id, message.clone())
            .await
            .expect("签名模块读取已有安全账户");
        assert!(harness
            .signer
            .verify(
                Sr25519PublicKey::from_bytes(*account_id.as_bytes()),
                message,
                signature,
            )
            .await
            .unwrap());
        let before = harness.profiles.snapshot();
        assert!(
            signing
                .sign_wallet_payload(AccountId32::from_bytes([0x98; 32]), Vec::new(),)
                .await
                .is_err(),
            "独立签名不得伪造账户归属"
        );
        assert_eq!(harness.profiles.snapshot(), before);

        wallet
            .delete_wallet()
            .await
            .expect("本地删除不需要历史监控");
        assert!(signing
            .sign_wallet_payload(account_id, Vec::new())
            .await
            .is_err());
        signing.dispose().unwrap();
        assert!(
            !signing
                .capabilities()
                .unwrap()
                .unwrap()
                .status(CapabilityName::LocalSigning)
                .unwrap()
                .is_ready(),
            "关闭后本地签名也必须失效"
        );
    });
}

#[test]
fn append_reuses_original_key_for_next_and_explicit_accounts() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        let generation = profile.generation();
        let original = harness
            .secrets
            .load(profile.accounts()[0].secret_ref())
            .await
            .unwrap();
        assert_eq!(harness.vault.ensure_calls.load(Ordering::SeqCst), 1);
        let first = harness
            .service
            .add_next_account(&known_mnemonic(), "")
            .await
            .unwrap();
        let final_profile = harness
            .service
            .add_accounts(&known_mnemonic(), "", &[5, 9])
            .await
            .unwrap();
        assert_eq!(first.generation(), generation);
        assert_eq!(final_profile.generation(), generation);
        assert_eq!(final_profile.accounts().len(), 4);
        assert_eq!(
            harness.vault.ensure_calls.load(Ordering::SeqCst),
            1,
            "追加不能重新初始化钱包钥"
        );
        assert_eq!(
            harness
                .secrets
                .load(profile.accounts()[0].secret_ref())
                .await
                .unwrap(),
            original
        );
        assert_eq!(harness.vault.delete_wallet_calls.load(Ordering::SeqCst), 0);
        harness
            .signing_service()
            .sign(
                profile.master_account_id(),
                b"synthetic-after-append".to_vec(),
            )
            .await
            .expect("原账户追加后仍可签名");
        let before = harness.profiles.snapshot();
        assert!(harness
            .service
            .add_accounts(&known_mnemonic(), "", &[5])
            .await
            .is_err());
        assert_eq!(harness.profiles.snapshot(), before);
        assert_eq!(harness.vault.ensure_calls.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn append_cannot_recreate_a_missing_original_wallet_key() {
    block_on(async {
        let harness = Harness::new();
        let profile = harness.service.import(&known_mnemonic(), "").await.unwrap();
        harness
            .vault
            .wallet_keys
            .lock()
            .unwrap()
            .remove(&(profile.wallet_index(), profile.generation()));
        let before = harness.profiles.snapshot();
        assert_contract_code(
            harness
                .service
                .add_next_account(&known_mnemonic(), "")
                .await
                .unwrap_err(),
            // 追加先检查原钥是否存在，缺钥在认证和封装前即被拒绝。
            ContractErrorCode::AuthenticationRequired,
        );
        assert_eq!(harness.profiles.snapshot(), before);
        assert_eq!(harness.vault.ensure_calls.load(Ordering::SeqCst), 1);
        assert!(!harness
            .vault
            .has_key(profile.wallet_index(), profile.generation()));
    });
}

/// 明确验证每次请求次数；不能只断言初始化钥次数而漏掉交互解封。
#[test]
fn append_authenticates_once_for_next_single_and_batch_without_opening_accounts() {
    block_on(async {
        let h = Harness::new();
        let mnemonic = known_mnemonic();
        let base = h.service.import(&mnemonic, "").await.unwrap();
        let original = h
            .secrets
            .load(base.accounts()[0].secret_ref())
            .await
            .unwrap();
        let opens = h.vault.open_calls.load(Ordering::SeqCst);
        h.service.add_next_account(&mnemonic, "").await.unwrap();
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 1);
        h.service.add_accounts(&mnemonic, "", &[7]).await.unwrap();
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 2);
        let profile = h
            .service
            .add_accounts(&mnemonic, "", &[1989, 12, 4])
            .await
            .unwrap();
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 3);
        assert_eq!(h.vault.open_calls.load(Ordering::SeqCst), opens);
        assert_eq!(
            h.secrets
                .load(base.accounts()[0].secret_ref())
                .await
                .unwrap(),
            original
        );
        // 新账户实际可签名；验收读取不作为追加流程的一部分。
        for index in [1, 7, 1989, 12, 4] {
            h.signing_service()
                .sign(
                    profile.account_by_index(index).unwrap().account_id(),
                    b"synthetic-append".to_vec(),
                )
                .await
                .unwrap();
        }
    });
}

#[test]
fn invalid_append_and_cancelled_authentication_leave_no_new_facts() {
    block_on(async {
        let h = Harness::new();
        let mnemonic = known_mnemonic();
        h.service.import(&mnemonic, "").await.unwrap();
        let before = h.profiles.snapshot();
        for indices in [&[][..], &[0], &[1, 1], &[1990]] {
            assert!(h
                .service
                .add_accounts(&mnemonic, "", indices)
                .await
                .is_err());
        }
        assert!(h
            .service
            .add_accounts(&mnemonic, "wrong!", &[1])
            .await
            .is_err());
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 0);
        *h.vault.authorize_error.lock().unwrap() = Some(ContractErrorCode::AuthenticationCancelled);
        assert_contract_code(
            h.service
                .add_accounts(&mnemonic, "", &[1, 2])
                .await
                .unwrap_err(),
            ContractErrorCode::AuthenticationCancelled,
        );
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.profiles.snapshot(), before);
        assert_eq!(h.secrets.envelope_count(), 1);
    });
}

#[test]
fn append_rejects_late_authorization_after_cancellation_or_state_replacement() {
    block_on(async {
        for replace in [false, true] {
            let h = Harness::new();
            let mnemonic = known_mnemonic();
            h.service.import(&mnemonic, "").await.unwrap();
            let before = h.profiles.snapshot();
            let cancelled = Arc::new(AtomicBool::new(false));
            let service = WalletService::new(
                h.signer.clone(),
                h.vault.clone(),
                h.profiles.clone(),
                h.secrets.clone(),
                h.entropy.clone(),
                h.clock.clone(),
            )
            .with_add_cancellation(cancelled.clone());
            let (send, gate) = futures::channel::oneshot::channel();
            let (entered, waiting) = futures::channel::oneshot::channel();
            *h.vault.authorize_gate.lock().unwrap() = Some(gate);
            *h.vault.authorize_entered.lock().unwrap() = Some(entered);
            let work = Box::pin(service.add_accounts(&mnemonic, "", &[1, 2]));
            let work = match futures::future::select(work, waiting).await {
                futures::future::Either::Right((Ok(()), work)) => work,
                _ => panic!("必须进入追加认证"),
            };
            if replace {
                *h.profiles.state.lock().unwrap() = WalletState::empty();
            } else {
                cancelled.store(true, Ordering::Release);
            }
            send.send(()).unwrap();
            assert_contract_code(
                work.await.unwrap_err(),
                if replace {
                    ContractErrorCode::Conflict
                } else {
                    ContractErrorCode::AuthenticationCancelled
                },
            );
            assert_eq!(h.secrets.envelope_count(), 1);
            assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 1);
            if !replace {
                assert_eq!(h.profiles.snapshot(), before);
            }
        }
    });
}

#[test]
fn append_storage_failure_rolls_back_without_another_authentication() {
    block_on(async {
        let h = Harness::new();
        let mnemonic = known_mnemonic();
        let base = h.service.import(&mnemonic, "").await.unwrap();
        *h.secrets.next_fault.lock().unwrap() = WriteFault::BeforeWrite;
        let opens = h.vault.open_calls.load(Ordering::SeqCst);
        assert!(h
            .service
            .add_accounts(&mnemonic, "", &[1, 2])
            .await
            .is_err());
        assert_eq!(h.service.profile().await.unwrap(), Some(base));
        assert_eq!(h.secrets.envelope_count(), 1);
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 1);
        assert_eq!(h.vault.open_calls.load(Ordering::SeqCst), opens);
        h.service
            .add_accounts(&mnemonic, "", &[1, 2])
            .await
            .unwrap();
        assert_eq!(
            h.vault.authorize_calls.load(Ordering::SeqCst),
            2,
            "重试必须重新认证"
        );
    });
}

#[test]
fn append_checks_fresh_persistent_envelope_instead_of_trusting_cas_response() {
    block_on(async {
        let h = Harness::new();
        let mnemonic = known_mnemonic();
        let base = h.service.import(&mnemonic, "").await.unwrap();
        h.secrets.corrupt_next_write.store(true, Ordering::SeqCst);
        assert!(h.service.add_accounts(&mnemonic, "", &[1]).await.is_err());
        // 返回成功的CAS没有证明持久字节正确；损坏的新账户必须回滚。
        assert_eq!(h.service.profile().await.unwrap(), Some(base));
        assert_eq!(h.vault.authorize_calls.load(Ordering::SeqCst), 1);
    });
}
