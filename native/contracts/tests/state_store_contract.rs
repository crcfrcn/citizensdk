//! 五类数据仓储的强类型、对象安全和钱包公开状态合同。

use std::{
    future::Future,
    collections::HashMap,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

use citizen_sdk_contracts::{
    citizen_ss58_address, parse_citizen_ss58_address, AccountId32, ChainDatabaseSnapshot,
    ChainDatabaseStore, ColdWalletAccount, ContractFuture, ContractResult,
    EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretBlobStore,
    EncryptedSecretEnvelope, Hash32, Hash32Bytes, RuntimeCacheStore, RuntimeContext,
    RuntimeVersion, SecretOwner, SecretRef, TransactionExecutionId, TransactionHistoryCursor,
    TransactionHistoryIndex, TransactionHistoryMutation, TransactionHistoryQueryKind,
    TransactionHistoryRecordBatch, TransactionHistoryRecordSnapshot, TransactionHistoryStore,
    VaultGeneration, VerifiedBlockRef, WalletAccount, WalletCleanupPlan, WalletOrigin,
    WalletProfile, WalletProfileStore, WalletProvisioningPlan, WalletSignMode, WalletState,
    WalletRecord, WalletDiagnosticReason,
    MAX_PERSISTED_RUNTIME_CONTEXTS, MAX_PERSISTED_RUNTIME_METADATA_BYTES,
};

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

fn value_or_panic<T>(result: ContractResult<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("合同调用失败: {error}"),
    }
}

struct MemoryChainDatabase;

impl ChainDatabaseStore for MemoryChainDatabase {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        Box::pin(async { Ok(ChainDatabaseSnapshot::new(0, None)) })
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        state: Option<citizen_sdk_contracts::ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        Box::pin(async move { Ok(ChainDatabaseSnapshot::new(expected_revision + 1, state)) })
    }
}

struct MemoryRuntimeCache;

impl RuntimeCacheStore for MemoryRuntimeCache {
    fn load(&self, _block_hash: Hash32) -> ContractFuture<'_, Option<RuntimeContext>> {
        Box::pin(async { Ok(None) })
    }

    fn store(&self, _context: RuntimeContext) -> ContractFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn delete(&self, _block_hash: Hash32) -> ContractFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

struct MemoryWalletProfiles;

impl WalletProfileStore for MemoryWalletProfiles {
    fn load(&self) -> ContractFuture<'_, WalletState> {
        Box::pin(async { Ok(WalletState::empty()) })
    }

    fn compare_and_swap(
        &self,
        _expected_revision: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState> {
        Box::pin(async move { Ok(next) })
    }
}

struct MemoryHistory;

impl TransactionHistoryStore for MemoryHistory {
    fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex> {
        Box::pin(async { Ok(TransactionHistoryIndex::empty()) })
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

#[derive(Default)]
struct MemoryEncryptedBlobs {
    entries: Mutex<HashMap<SecretRef, EncryptedSecretBlobSnapshot>>,
    query_error: Mutex<Option<citizen_sdk_contracts::ContractErrorCode>>,
}

impl EncryptedSecretBlobStore for MemoryEncryptedBlobs {
    fn has_account_secret(&self, account_id: AccountId32) -> ContractFuture<'_, bool> {
        Box::pin(async move {
            if let Some(code) = *self.query_error.lock().unwrap_or_else(|_| panic!("合成测试锁不可用")) {
                return Err(citizen_sdk_contracts::ContractError::new(code, "合成存在性查询失败"));
            }
            Ok(self.entries.lock().unwrap_or_else(|_| panic!("合成测试锁不可用")).iter().any(|(reference, value)|
                reference.account_id() == account_id && value.envelope().is_some()))
        })
    }
    fn load(&self, secret_ref: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move { Ok(self.entries.lock().unwrap_or_else(|_| panic!("合成测试锁不可用")).get(&secret_ref).cloned()
            .unwrap_or_else(EncryptedSecretBlobSnapshot::empty)) })
    }

    fn compare_and_swap(
        &self,
        secret_ref: SecretRef,
        expected_revision: u64,
        next: EncryptedSecretBlobState,
    ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
        Box::pin(async move {
            let mut entries = self.entries.lock().unwrap_or_else(|_| panic!("合成测试锁不可用"));
            let current = entries.get(&secret_ref).cloned().unwrap_or_else(EncryptedSecretBlobSnapshot::empty);
            if current.revision() != expected_revision {
                return Err(citizen_sdk_contracts::ContractError::new(
                    citizen_sdk_contracts::ContractErrorCode::Conflict,
                    "测试 revision 冲突",
                ));
            }
            let next = current.try_advance(next)?;
            entries.insert(secret_ref, next.clone());
            Ok(next)
        })
    }
}

fn secret_ref(index: u32, account_byte: u8) -> SecretRef {
    SecretRef::account_mini_secret(
        0,
        VaultGeneration::from_bytes([1; 16]),
        SecretOwner::from_bytes([index as u8; 16]),
        AccountId32::from_bytes([account_byte; 32]),
    )
}

fn secret_ref_for(generation: u8, owner: u8, account_byte: u8) -> SecretRef {
    SecretRef::account_mini_secret(
        0,
        VaultGeneration::from_bytes([generation; 16]),
        SecretOwner::from_bytes([owner; 16]),
        AccountId32::from_bytes([account_byte; 32]),
    )
}

#[test]
fn encrypted_blob_persisted_parts_accept_only_reachable_revisions() {
    let envelope = value_or_panic(EncryptedSecretEnvelope::try_new(
        1,
        Hash32Bytes::from_bytes([7; 32]),
        vec![9; 48],
    ));
    assert!(EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        0,
        EncryptedSecretBlobState::Vacant,
    )
    .is_ok());
    assert!(EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        1,
        EncryptedSecretBlobState::Sealed {
            provisioning_operation_id: [1; 16],
            envelope,
        },
    )
    .is_ok());
    assert!(EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        2,
        EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [2; 16],
        },
    )
    .is_ok());
    assert!(EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        1,
        EncryptedSecretBlobState::Vacant,
    )
    .is_err());
    assert!(EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        2,
        EncryptedSecretBlobState::Sealed {
            provisioning_operation_id: [1; 16],
            envelope: value_or_panic(EncryptedSecretEnvelope::try_new(
                1,
                Hash32Bytes::from_bytes([7; 32]),
                vec![9; 48],
            )),
        },
    )
    .is_err());
    assert!(EncryptedSecretBlobSnapshot::try_from_persisted_parts(
        3,
        EncryptedSecretBlobState::Tombstone {
            cleanup_operation_id: [2; 16],
        },
    )
    .is_err());
}

fn wallet_account(index: u32, owner: u8, account_byte: u8) -> WalletAccount {
    value_or_panic(WalletAccount::try_new(
        index,
        AccountId32::from_bytes([account_byte; 32]),
        secret_ref_for(1, owner, account_byte),
        citizen_ss58_address(AccountId32::from_bytes([account_byte; 32])),
        format!("account-{index}"),
        100 + u64::from(index),
    ))
}

fn wallet_profile(accounts: Vec<WalletAccount>) -> WalletProfile {
    let master = AccountId32::from_bytes([4; 32]);
    value_or_panic(WalletProfile::try_new(
        0,
        VaultGeneration::from_bytes([1; 16]),
        master,
        WalletOrigin::Created,
        100,
        master,
        accounts,
    ))
}

#[test]
fn five_store_traits_are_separate_object_safe_boundaries() {
    let chain: Box<dyn ChainDatabaseStore> = Box::new(MemoryChainDatabase);
    let runtime: Box<dyn RuntimeCacheStore> = Box::new(MemoryRuntimeCache);
    let wallet: Box<dyn WalletProfileStore> = Box::new(MemoryWalletProfiles);
    let history: Box<dyn TransactionHistoryStore> = Box::new(MemoryHistory);
    let blobs: Box<dyn EncryptedSecretBlobStore> = Box::new(MemoryEncryptedBlobs::default());

    assert_eq!(value_or_panic(block_on(chain.load())).revision(), 0);
    assert!(value_or_panic(block_on(runtime.load(Hash32::from_bytes([2; 32])))).is_none());
    assert_eq!(value_or_panic(block_on(wallet.load())).revision(), 0);
    assert_eq!(value_or_panic(block_on(history.load_index())).revision(), 0);
    assert!(value_or_panic(block_on(blobs.load(secret_ref(3, 4))))
        .envelope()
        .is_none());
}

#[test]
fn runtime_cache_capacity_is_a_persistence_limit_not_a_core_limit() {
    assert_eq!(MAX_PERSISTED_RUNTIME_CONTEXTS, 64);
    assert_eq!(
        MAX_PERSISTED_RUNTIME_METADATA_BYTES,
        (8 * 1024 * 1024) - 56 - 55
    );
    assert!(
        citizen_sdk_contracts::MAX_RUNTIME_METADATA_BYTES > MAX_PERSISTED_RUNTIME_METADATA_BYTES
    );
}

#[test]
fn citizen_ss58_profile_address_matches_the_existing_wallet_golden_vector() {
    let account_id = AccountId32::from_bytes([
        0x2a, 0xfb, 0xa9, 0x27, 0x8e, 0x30, 0xcc, 0xf6, 0xa6, 0xce, 0xb3, 0xa8, 0xb6, 0xe3, 0x36,
        0xb7, 0x00, 0x68, 0xf0, 0x45, 0xc6, 0x66, 0xf2, 0xe7, 0xf4, 0xf9, 0xcc, 0x5f, 0x47, 0xdb,
        0x89, 0x72,
    ]);
    assert_eq!(
        citizen_ss58_address(account_id),
        "w5CZACAABUbK4jspzPB5be9trhtSgRCRZFafGe7kvFPvxq8M2"
    );
    let secret_ref = SecretRef::account_mini_secret(
        0,
        VaultGeneration::from_bytes([1; 16]),
        SecretOwner::from_bytes([2; 16]),
        account_id,
    );
    assert!(WalletAccount::try_new(0, account_id, secret_ref, "wrong", "", 0).is_err());

    let encoded = citizen_ss58_address(account_id);
    assert_eq!(
        value_or_panic(parse_citizen_ss58_address(&encoded)),
        account_id
    );
    assert!(parse_citizen_ss58_address(&format!("{encoded}1")).is_err());
    assert!(
        parse_citizen_ss58_address("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXQaE4iAqYvFfu").is_err()
    );
}

#[test]
fn unified_wallet_catalog_requires_exact_unique_hot_and_cold_order() {
    let hot = wallet_profile(vec![wallet_account(0, 3, 4)]);
    let hot_id = hot.master_account_id();
    let cold_id = AccountId32::from_bytes([9; 32]);
    let cold = value_or_panic(ColdWalletAccount::try_new(
        1,
        cold_id,
        citizen_ss58_address(cold_id),
        " 冷账户 ",
        200,
    ));
    let state = value_or_panic(WalletState::try_from_catalog_parts(
        7,
        Some(hot.clone()),
        vec![cold.clone()],
        vec![cold_id, hot_id],
        2,
        None,
        None,
        Vec::new(),
    ));
    assert_eq!(state.default_account_id(), Some(cold_id));
    assert_eq!(state.account_sign_mode(hot_id), Some(WalletSignMode::Hot));
    assert_eq!(state.account_sign_mode(cold_id), Some(WalletSignMode::Cold));
    assert_eq!(state.cold_account_by_index(1), Some(&cold));
    assert_eq!(cold.name(), "冷账户");

    for invalid_order in [
        vec![hot_id],
        vec![cold_id, cold_id],
        vec![cold_id, hot_id, AccountId32::from_bytes([8; 32])],
    ] {
        assert!(WalletState::try_from_catalog_parts(
            7,
            Some(hot.clone()),
            vec![cold.clone()],
            invalid_order,
            2,
            None,
            None,
            Vec::new(),
        )
        .is_err());
}


    let duplicates_hot = value_or_panic(ColdWalletAccount::try_new(
        1,
        hot_id,
        citizen_ss58_address(hot_id),
        "重复",
        200,
    ));
    assert!(WalletState::try_from_catalog_parts(
        7,
        Some(hot),
        vec![duplicates_hot],
        vec![hot_id],
        2,
        None,
        None,
        Vec::new(),
    )
    .is_err());

    assert!(WalletState::try_from_catalog_parts(
        7,
        None,
        vec![cold.clone()],
        vec![cold_id],
        1,
        None,
        None,
        Vec::new(),
    )
    .is_err());
    assert!(
        ColdWalletAccount::try_new(0, cold_id, citizen_ss58_address(cold_id), "非法", 200,)
            .is_err()
    );
}

#[test]
fn wallet_profile_rejects_duplicate_or_cross_generation_secret_refs() {
    let generation = VaultGeneration::from_bytes([1; 16]);
    let first_id = AccountId32::from_bytes([4; 32]);
    let first = value_or_panic(WalletAccount::try_new(
        0,
        first_id,
        secret_ref(1, 4),
        citizen_ss58_address(first_id),
        "first",
        100,
    ));
    let duplicate_index = value_or_panic(WalletAccount::try_new(
        0,
        AccountId32::from_bytes([5; 32]),
        secret_ref(2, 5),
        citizen_ss58_address(AccountId32::from_bytes([5; 32])),
        "second",
        101,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        first_id,
        WalletOrigin::Created,
        100,
        first_id,
        vec![first.clone(), duplicate_index],
    )
    .is_err());

    let foreign_ref = SecretRef::account_mini_secret(
        1,
        generation,
        SecretOwner::from_bytes([3; 16]),
        AccountId32::from_bytes([6; 32]),
    );
    let foreign = value_or_panic(WalletAccount::try_new(
        1,
        AccountId32::from_bytes([6; 32]),
        foreign_ref,
        citizen_ss58_address(AccountId32::from_bytes([6; 32])),
        "foreign",
        102,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        first_id,
        WalletOrigin::Created,
        100,
        first_id,
        vec![first.clone(), foreign],
    )
    .is_err());

    let foreign_generation_ref = SecretRef::account_mini_secret(
        0,
        VaultGeneration::from_bytes([2; 16]),
        SecretOwner::from_bytes([4; 16]),
        AccountId32::from_bytes([7; 32]),
    );
    let foreign_generation = value_or_panic(WalletAccount::try_new(
        1,
        AccountId32::from_bytes([7; 32]),
        foreign_generation_ref,
        citizen_ss58_address(AccountId32::from_bytes([7; 32])),
        "generation",
        103,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        first_id,
        WalletOrigin::Created,
        100,
        first_id,
        vec![first, foreign_generation],
    )
    .is_err());
}

#[test]
fn wallet_profile_requires_account_zero_master_and_bounded_indices() {
    let generation = VaultGeneration::from_bytes([1; 16]);
    let master = AccountId32::from_bytes([4; 32]);
    let wrong_anchor = value_or_panic(WalletAccount::try_new(
        1,
        master,
        secret_ref(1, 4),
        citizen_ss58_address(master),
        "master",
        100,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        master,
        WalletOrigin::Created,
        100,
        master,
        vec![wrong_anchor],
    )
    .is_err());

    let wrong_zero_id = AccountId32::from_bytes([5; 32]);
    let wrong_zero = value_or_panic(WalletAccount::try_new(
        0,
        wrong_zero_id,
        secret_ref(2, 5),
        citizen_ss58_address(wrong_zero_id),
        "wrong-zero",
        100,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        master,
        WalletOrigin::Created,
        100,
        wrong_zero_id,
        vec![wrong_zero],
    )
    .is_err());

    let valid_zero = value_or_panic(WalletAccount::try_new(
        0,
        master,
        secret_ref(3, 4),
        citizen_ss58_address(master),
        "master",
        100,
    ));
    let maximum_id = AccountId32::from_bytes([6; 32]);
    let maximum = value_or_panic(WalletAccount::try_new(
        1989,
        maximum_id,
        secret_ref(4, 6),
        citizen_ss58_address(maximum_id),
        "maximum",
        101,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        master,
        WalletOrigin::Created,
        100,
        maximum_id,
        vec![valid_zero.clone(), maximum],
    )
    .is_ok());

    let too_high = value_or_panic(WalletAccount::try_new(
        1990,
        maximum_id,
        secret_ref(5, 6),
        citizen_ss58_address(maximum_id),
        "too-high",
        100,
    ));
    assert!(WalletProfile::try_new(
        0,
        generation,
        master,
        WalletOrigin::Created,
        100,
        master,
        vec![valid_zero, too_high],
    )
    .is_err());
}

#[test]
fn wallet_state_accepts_exact_create_and_append_provisioning() {
    let account_zero = wallet_account(0, 3, 4);
    let created_profile = wallet_profile(vec![account_zero.clone()]);
    let create = value_or_panic(WalletProvisioningPlan::try_new(
        [1; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        None,
        vec![account_zero.secret_ref()],
        true,
    ));
    assert!(WalletState::try_from_parts(
        1,
        Some(created_profile.clone()),
        Some(create),
        None,
        Vec::new(),
    )
    .is_ok());

    let added = wallet_account(1, 2, 5);
    let expanded_profile = wallet_profile(vec![account_zero, added.clone()]);
    let append = value_or_panic(WalletProvisioningPlan::try_new(
        [2; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        Some(created_profile),
        vec![added.secret_ref()],
        false,
    ));
    assert!(
        WalletState::try_from_parts(2, Some(expanded_profile), Some(append), None, Vec::new(),)
            .is_ok()
    );
}

#[test]
fn wallet_state_accepts_exact_import_provisioning() {
    let account_zero = wallet_account(0, 3, 4);
    let master = AccountId32::from_bytes([4; 32]);
    let imported_profile = value_or_panic(WalletProfile::try_new(
        0,
        VaultGeneration::from_bytes([1; 16]),
        master,
        WalletOrigin::Imported,
        100,
        master,
        vec![account_zero.clone()],
    ));
    assert_eq!(imported_profile.origin(), WalletOrigin::Imported);

    let import = value_or_panic(WalletProvisioningPlan::try_new(
        [3; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        None,
        vec![account_zero.secret_ref()],
        true,
    ));
    assert!(
        WalletState::try_from_parts(1, Some(imported_profile), Some(import), None, Vec::new(),)
            .is_ok()
    );
}

#[test]
fn wallet_state_rejects_incomplete_or_misattributed_provisioning() {
    let account_zero = wallet_account(0, 3, 4);
    let created_profile = wallet_profile(vec![account_zero.clone()]);
    let no_wallet_key_rollback = value_or_panic(WalletProvisioningPlan::try_new(
        [1; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        None,
        vec![account_zero.secret_ref()],
        false,
    ));
    assert!(WalletState::try_from_parts(
        1,
        Some(created_profile.clone()),
        Some(no_wallet_key_rollback),
        None,
        Vec::new(),
    )
    .is_err());

    let added = wallet_account(1, 2, 5);
    let expanded_profile = wallet_profile(vec![account_zero.clone(), added.clone()]);
    let previous_is_not_a_strict_prefix = value_or_panic(WalletProvisioningPlan::try_new(
        [2; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        Some(expanded_profile.clone()),
        vec![added.secret_ref()],
        false,
    ));
    assert!(WalletState::try_from_parts(
        2,
        Some(expanded_profile.clone()),
        Some(previous_is_not_a_strict_prefix),
        None,
        Vec::new(),
    )
    .is_err());

    let wrong_secret_set = value_or_panic(WalletProvisioningPlan::try_new(
        [3; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        Some(created_profile),
        vec![account_zero.secret_ref(), added.secret_ref()],
        false,
    ));
    assert!(WalletState::try_from_parts(
        2,
        Some(expanded_profile),
        Some(wrong_secret_set),
        None,
        Vec::new(),
    )
    .is_err());
}

#[test]
fn cleanup_never_targets_current_wallet_and_physical_targets_do_not_overlap() {
    let current = wallet_profile(vec![wallet_account(0, 3, 4)]);
    let current_secret = current.accounts()[0].secret_ref();
    let targets_current_secret = value_or_panic(WalletCleanupPlan::try_new(
        [1; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        vec![current_secret],
        false,
    ));
    assert!(WalletState::try_from_parts(
        1,
        Some(current.clone()),
        None,
        Some(targets_current_secret),
        Vec::new(),
    )
    .is_err());

    let old_ref = secret_ref_for(2, 8, 8);
    let non_current_same_generation_ref = secret_ref_for(1, 8, 8);
    let deletes_current_wallet_key = value_or_panic(WalletCleanupPlan::try_new(
        [2; 16],
        0,
        VaultGeneration::from_bytes([1; 16]),
        vec![non_current_same_generation_ref],
        true,
    ));
    assert!(WalletState::try_from_parts(
        1,
        Some(current.clone()),
        None,
        Some(deletes_current_wallet_key),
        Vec::new(),
    )
    .is_err());

    let first = value_or_panic(WalletCleanupPlan::try_new(
        [3; 16],
        0,
        VaultGeneration::from_bytes([2; 16]),
        vec![old_ref],
        true,
    ));
    let duplicate_target = value_or_panic(WalletCleanupPlan::try_new(
        [4; 16],
        0,
        VaultGeneration::from_bytes([2; 16]),
        vec![old_ref],
        false,
    ));
    assert!(WalletState::try_from_parts(
        1,
        Some(current.clone()),
        None,
        Some(first.clone()),
        vec![duplicate_target],
    )
    .is_err());
    assert!(WalletState::try_from_parts(1, Some(current), None, Some(first), Vec::new()).is_ok());
}

#[test]
fn cleanup_contract_requires_exact_nonempty_bounded_plans() {
    assert!(WalletCleanupPlan::try_new(
        [1; 16],
        0,
        VaultGeneration::from_bytes([2; 16]),
        Vec::new(),
        true,
    )
    .is_err());

    assert!(WalletCleanupPlan::try_new([1; 16], 0, VaultGeneration::from_bytes([2; 16]), Vec::new(), false).is_err());

    let without_wallet_key = value_or_panic(WalletCleanupPlan::try_new(
        [2; 16],
        0,
        VaultGeneration::from_bytes([2; 16]),
        vec![secret_ref_for(2, 2, 2)],
        false,
    ));
    assert!(
        WalletState::try_from_parts(1, None, None, Some(without_wallet_key), Vec::new(),).is_err()
    );

    let queue: Vec<_> = (1_u8..=65)
        .map(|id| {
            value_or_panic(WalletCleanupPlan::try_new(
                [id; 16],
                0,
                VaultGeneration::from_bytes([2; 16]),
                vec![secret_ref_for(2, id, id)],
                false,
            ))
        })
        .collect();
    assert!(WalletState::try_from_parts(1, None, None, None, queue).is_err());
}

#[test]
fn runtime_cache_value_carries_its_exact_block_identity() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 88);
    let context = value_or_panic(RuntimeContext::try_new(
        block,
        RuntimeVersion::new(17, 3),
        vec![1, 2, 3],
    ));
    assert_eq!(context.block(), block);
    assert_eq!(context.version().spec_version(), 17);
}

#[test]
fn encrypted_secret_tombstone_is_a_permanent_late_writer_fence() {
    let envelope = value_or_panic(EncryptedSecretEnvelope::try_new(
        1,
        Hash32Bytes::from_bytes([0x11; 32]),
        vec![0x22; 32],
    ));
    let sealed = value_or_panic(EncryptedSecretBlobSnapshot::empty().try_advance(
        EncryptedSecretBlobState::Sealed {
            provisioning_operation_id: [0x33; 16],
            envelope: envelope.clone(),
        },
    ));
    assert_eq!(sealed.envelope(), Some(&envelope));
    assert!(sealed
        .try_advance(EncryptedSecretBlobState::Sealed {
            provisioning_operation_id: [0x44; 16],
            envelope: envelope.clone(),
        })
        .is_err());

    let tombstone = value_or_panic(sealed.try_advance(EncryptedSecretBlobState::Tombstone {
        cleanup_operation_id: [0x55; 16],
    }));
    assert!(tombstone.is_tombstone());
    assert!(tombstone
        .try_advance(EncryptedSecretBlobState::Sealed {
            provisioning_operation_id: [0x33; 16],
            envelope,
        })
        .is_err());
}


#[test]
fn diagnostic_records_are_not_accounts_and_keep_original_mode_and_independent_name() {
    let profile = wallet_profile(vec![wallet_account(0, 2, 4)]);
    let mut record = WalletRecord::from_profile(&profile);
    if let WalletRecord::Profile { sign_mode, .. } = &mut record { *sign_mode = "unsupported-mode".to_owned(); }
    assert_eq!(record.diagnostic_reason(), Some(WalletDiagnosticReason::InvalidSignMode));
    assert_eq!(value_or_panic(record.validate_profile_identity()), profile);
    let state = value_or_panic(WalletState::try_from_parts(1, None, None, None, Vec::new()));
    let state = value_or_panic(state.try_with_diagnostics(vec![record.clone()]));
    let state = value_or_panic(state.try_with_active_wallet(Some(0)));
    assert!(state.has_hot_wallet_record() && state.contains_wallet(0));
    assert!(state.profile().is_none() && state.default_account_id().is_none());
    assert_eq!(state.account_sign_mode(record.account_id()), None);
    assert_eq!(state.diagnostic_for_account(record.account_id()), Some(&record));
    let renamed = value_or_panic(record.try_with_wallet_name("另一个钱包名"));
    assert_eq!(renamed.sign_mode(), "unsupported-mode");
    assert_eq!(renamed.wallet_name(), "另一个钱包名");
    if let WalletRecord::Profile { accounts, .. } = &renamed { assert_eq!(accounts[0].name, profile.accounts()[0].name()); }
    assert!(state.try_with_diagnostics(Vec::new()).is_err()); // 已选择的异常槽不能被无声丢弃。
    assert!(state.try_with_diagnostics(vec![record.clone(), record.clone()]).is_err());
    assert!(WalletState::empty().try_with_diagnostics(vec![WalletRecord::from_profile(&profile)]).is_err());
    let valid = value_or_panic(WalletState::try_from_parts(1, Some(profile), None, None, Vec::new()));
    assert!(valid.try_with_diagnostics(vec![record]).is_err()); // 正常与异常不可占用同一槽。
}

#[test]
fn diagnostic_identity_is_nullable_not_fabricated_and_cleanup_never_crosses_lifecycles() {
    let mut record = WalletRecord::from_profile(&wallet_profile(vec![wallet_account(0, 2, 4)]));
    if let WalletRecord::Profile { accounts, .. } = &mut record { accounts[0].ss58_address = "invalid-address".to_owned(); }
    assert_eq!(record.diagnostic_reason(), Some(WalletDiagnosticReason::InvalidIdentity));
    assert!(record.validate_profile_identity().is_err());
    assert_eq!(value_or_panic(record.cleanup_refs()).len(), 1);
    if let WalletRecord::Profile { accounts, .. } = &mut record {
        accounts[0].secret_ref = secret_ref_for(9, 2, 4);
    }
    assert!(record.cleanup_refs().is_err());
    if let WalletRecord::Profile { accounts, .. } = &mut record { accounts.clear(); }
    assert_eq!(record.ss58_address(), None);
    assert_eq!(record.diagnostic_reason(), Some(WalletDiagnosticReason::InvalidStructure));
    assert!(record.cleanup_refs().is_err());
    assert!(record.cleanup_targets().is_err());
    if let WalletRecord::Profile { sign_mode, .. } = &mut record { *sign_mode = "x".repeat(33); }
    assert!(record.validate_shape().is_err());
    assert!(WalletState::empty().try_with_diagnostics(vec![record]).is_err());
}

#[test]
fn diagnostic_cleanup_targets_share_exact_validation_and_never_expand_from_display_facts() {
    let mut record = WalletRecord::from_profile(&wallet_profile(vec![wallet_account(0, 2, 4), wallet_account(1, 3, 5)]));
    assert_eq!(record.known_sign_mode(), Some(citizen_sdk_contracts::WalletSignMode::Hot));
    let expected = vec![AccountId32::from_bytes([4; 32]), AccountId32::from_bytes([5; 32])];
    assert_eq!(value_or_panic(record.cleanup_targets()), (expected.clone(), true));
    if let WalletRecord::Profile { sign_mode, accounts, .. } = &mut record {
        *sign_mode = "cold".into();
        accounts[0].ss58_address = citizen_ss58_address(AccountId32::from_bytes([9; 32]));
    }
    assert_eq!(record.known_sign_mode(), Some(citizen_sdk_contracts::WalletSignMode::Cold));
    assert_eq!(value_or_panic(record.cleanup_targets()), (expected, true)); // 颜色事实不改变原清理范围。
    if let WalletRecord::Profile { sign_mode, accounts, .. } = &mut record {
        *sign_mode = "unknown".into();
        accounts[1].secret_ref = secret_ref_for(7, 3, 5);
    }
    assert_eq!(record.known_sign_mode(), None);
    assert!(record.cleanup_targets().is_err());
    let cold = WalletRecord::Account { wallet_index: 1, sign_mode: "unknown".into(),
        account_id: AccountId32::from_bytes([4; 32]), ss58_address: citizen_ss58_address(AccountId32::from_bytes([9; 32])),
        name: "异常".into(), created_at_millis: 1 };
    assert_eq!(value_or_panic(cold.cleanup_targets()), (vec![AccountId32::from_bytes([4; 32])], false));
}

#[test]
fn cold_diagnostic_index_counter_and_cross_record_identity_remain_strict() {
    let account = value_or_panic(ColdWalletAccount::try_new(1, AccountId32::from_bytes([9; 32]),
        citizen_ss58_address(AccountId32::from_bytes([9; 32])), "冷钱包", 7));
    let mut record = WalletRecord::from_cold_account(&account);
    if let WalletRecord::Account { sign_mode, .. } = &mut record { *sign_mode = "".to_owned(); }
    let base = value_or_panic(WalletState::try_from_catalog_parts(1, None, vec![], vec![], 2, None, None, vec![]));
    let state = value_or_panic(base.try_with_diagnostics(vec![record.clone()]));
    assert_eq!(state.last_wallet_index(), Some(1));
    assert!(state.cold_accounts().is_empty());
    assert_eq!(value_or_panic(record.validate_cold_identity()), account);
    assert!(WalletState::empty().try_with_diagnostics(vec![record.clone()]).is_err()); // 计数器不能复用该索引。
    let other = value_or_panic(ColdWalletAccount::try_new(2, account.account_id(), account.ss58_address(), "正常", 8));
    let valid = value_or_panic(WalletState::try_from_catalog_parts(2, None, vec![other], vec![account.account_id()], 3, None, None, vec![]));
    assert!(valid.try_with_diagnostics(vec![record]).is_err());
}

// 独立用例必须处于模块层级，确保Cargo实际发现并执行跨代际查询回归。
#[test]
fn account_secret_presence_covers_generations_and_ignores_tombstones_without_hiding_errors() {
    use citizen_sdk_contracts::ContractErrorCode;
    let store = MemoryEncryptedBlobs::default();
    let account = AccountId32::from_bytes([4; 32]);
    let first = secret_ref_for(1, 2, 4);
    let second = secret_ref_for(9, 8, 4);
    let foreign = secret_ref_for(1, 3, 5);
    assert!(!value_or_panic(block_on(store.has_account_secret(account))));
    let sealed = || EncryptedSecretBlobState::Sealed {
        provisioning_operation_id: [1; 16],
        envelope: value_or_panic(EncryptedSecretEnvelope::try_new(1, Hash32Bytes::from_bytes([2; 32]), vec![3; 48])),
    };
    value_or_panic(block_on(store.compare_and_swap(foreign, 0, sealed())));
    assert!(!value_or_panic(block_on(store.has_account_secret(account))));
    for reference in [first, second] { value_or_panic(block_on(store.compare_and_swap(reference, 0, sealed()))); }
    assert!(value_or_panic(block_on(store.has_account_secret(account))));
    value_or_panic(block_on(store.compare_and_swap(first, 1, EncryptedSecretBlobState::Tombstone { cleanup_operation_id: [5; 16] })));
    assert!(value_or_panic(block_on(store.has_account_secret(account))));
    value_or_panic(block_on(store.compare_and_swap(second, 1, EncryptedSecretBlobState::Tombstone { cleanup_operation_id: [6; 16] })));
    assert!(!value_or_panic(block_on(store.has_account_secret(account))));
    for code in [ContractErrorCode::Storage, ContractErrorCode::PermissionDenied, ContractErrorCode::AuthenticationCancelled] {
        *store.query_error.lock().unwrap_or_else(|_| panic!("合成测试锁不可用")) = Some(code);
        assert!(block_on(store.has_account_secret(account)).is_err());
    }
}
