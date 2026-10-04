#![cfg(feature = "chain")]

use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use citizen_sdk_contracts::{
    AccountId32, AccountNonce, AccountNonceSource, ChainIdentity, ContractError, ContractErrorCode,
    ContractFuture, ContractStream, ExportedChainState, ExtrinsicWatchEvent, FinalizedBlockRef,
    Hash32, RuntimeContext, RuntimeVersion, SignedExtrinsic, StateImportReceipt,
    SubmittedExtrinsic, VerifiedBlockRef, VerifiedChainClient,
};
use citizen_sdk_engine::{
    account_state::{
        decode_best_fee_snapshot, decode_finalized_account_balance, system_account_storage_key,
        AccountStateService,
    },
    CapabilityProbe, CitizenEngine, EngineComponents, EngineError,
};
use serde_json::Value as JsonValue;
use subxt_core::{ext::codec::Decode, Metadata};

const METADATA_HEX: &str =
    include_str!("../../../test/transaction/citizenchain-runtime-v14-metadata.hex");
const VECTOR_JSON: &str =
    include_str!("../../../test/transaction/citizenchain-balance-fee-v1.json");

struct TestClient {
    identity: ChainIdentity,
    best: VerifiedBlockRef,
    finalized: FinalizedBlockRef,
    runtime_block_override: Option<VerifiedBlockRef>,
    metadata: Vec<u8>,
    values: Mutex<BTreeMap<Vec<u8>, Vec<u8>>>,
    batch_widths: Mutex<Vec<usize>>,
    reads: AtomicUsize,
    batch_blocks: Mutex<Vec<VerifiedBlockRef>>,
    batch_error: Option<ContractErrorCode>,
    omit_last_batch_value: bool,
}

impl TestClient {
    fn new(best: VerifiedBlockRef, finalized: FinalizedBlockRef) -> Self {
        Self {
            identity: ChainIdentity::citizenchain(),
            best,
            finalized,
            runtime_block_override: None,
            metadata: decode_hex(METADATA_HEX),
            values: Mutex::new(BTreeMap::new()),
            batch_widths: Mutex::new(Vec::new()),
            reads: AtomicUsize::new(0),
            batch_blocks: Mutex::new(Vec::new()),
            batch_error: None,
            omit_last_batch_value: false,
        }
    }

    fn insert(&self, key: Vec<u8>, value: Vec<u8>) {
        self.values
            .lock()
            .unwrap_or_else(|error| panic!("values lock poisoned: {error}"))
            .insert(key, value);
    }
}

impl VerifiedChainClient for TestClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let identity = self.identity.clone();
        Box::pin(async move { Ok(identity) })
    }

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let best = self.best;
        Box::pin(async move { Ok(best) })
    }

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let finalized = self.finalized;
        Box::pin(async move { Ok(finalized) })
    }

    fn get_storage_at(
        &self,
        _block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let value = self
            .values
            .lock()
            .unwrap_or_else(|error| panic!("values lock poisoned: {error}"))
            .get(&key)
            .cloned();
        Box::pin(async move { Ok(value) })
    }

    fn get_storage_batch_at(
        &self,
        block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.batch_blocks
            .lock()
            .unwrap_or_else(|error| panic!("batch block lock poisoned: {error}"))
            .push(block);
        self.batch_widths
            .lock()
            .unwrap_or_else(|error| panic!("batch lock poisoned: {error}"))
            .push(keys.len());
        let values = self
            .values
            .lock()
            .unwrap_or_else(|error| panic!("values lock poisoned: {error}"));
        let mut result = keys
            .iter()
            .map(|key| values.get(key).cloned())
            .collect::<Vec<_>>();
        if self.omit_last_batch_value {
            result.pop();
        }
        let error = self.batch_error;
        Box::pin(async move {
            match error {
                Some(code) => Err(ContractError::new(code, "batch test failure")),
                None => Ok(result),
            }
        })
    }

    fn get_runtime_context_at(
        &self,
        block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let returned_block = self.runtime_block_override.unwrap_or(block);
        let metadata = self.metadata.clone();
        Box::pin(async move {
            RuntimeContext::try_new(returned_block, RuntimeVersion::new(0, 0), metadata)
        })
    }

    fn get_block_extrinsics_at(
        &self,
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, Vec<Vec<u8>>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn submit_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractFuture<'_, SubmittedExtrinsic> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "account-state test does not submit",
            ))
        })
    }

    fn watch_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractStream<'_, ExtrinsicWatchEvent> {
        Box::pin(futures::stream::empty())
    }

    fn export_state(&self) -> ContractFuture<'_, ExportedChainState> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "account-state test does not export",
            ))
        })
    }

    fn import_state(&self, _state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "account-state test does not import",
            ))
        })
    }
}

struct TestNonceSource {
    returned_account: Option<AccountId32>,
    returned_block: Option<VerifiedBlockRef>,
    value: u64,
}

impl AccountNonceSource for TestNonceSource {
    fn account_next_index(
        &self,
        account_id: AccountId32,
        at_best: VerifiedBlockRef,
    ) -> ContractFuture<'_, AccountNonce> {
        let account = self.returned_account.unwrap_or(account_id);
        let block = self.returned_block.unwrap_or(at_best);
        let value = self.value;
        Box::pin(async move {
            AccountNonce::try_new(&ChainIdentity::citizenchain(), block, account, value)
        })
    }
}

#[test]
fn production_metadata_and_balance_bytes_match_the_frozen_vector() {
    let vector = vector();
    let account = account_id(&vector["account_balance"]["account_id"]);
    let finalized = finalized_from_vector(&vector);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0xbb; 32]), 78);
    let client = Arc::new(TestClient::new(best, finalized));

    let metadata = decode_metadata(&client.metadata);
    let key = system_account_storage_key(&metadata, account)
        .unwrap_or_else(|error| panic!("storage key failed: {error}"));
    assert_eq!(
        hex(&key),
        string(&vector["account_balance"]["system_account_storage_key"])
    );
    client.insert(
        key,
        decode_hex(string(&vector["account_balance"]["account_info"])),
    );

    let service = AccountStateService::new(client.as_ref(), None);
    let balance = futures::executor::block_on(service.finalized_account_balance(account))
        .unwrap_or_else(|error| panic!("balance failed: {error}"));
    assert_eq!(balance.block(), finalized);
    assert_eq!(balance.account_id(), account);
    assert_eq!(
        balance.free_fen(),
        integer(&vector["account_balance"]["free_fen"])
    );
    assert_eq!(
        balance.reserved_fen(),
        integer(&vector["account_balance"]["reserved_fen"])
    );
    assert_eq!(
        balance.total_fen(),
        integer(&vector["account_balance"]["total_fen"])
    );
}

#[test]
fn finalized_batch_deduplicates_provider_keys_but_preserves_order_and_duplicates() {
    let vector = vector();
    let first = account_id(&vector["account_balance"]["account_id"]);
    let second = AccountId32::from_bytes([0x55; 32]);
    let finalized = finalized_from_vector(&vector);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0xbb; 32]), 78);
    let client = Arc::new(TestClient::new(best, finalized));
    let metadata = decode_metadata(&client.metadata);
    client.insert(
        system_account_storage_key(&metadata, first)
            .unwrap_or_else(|error| panic!("storage key failed: {error}")),
        decode_hex(string(&vector["account_balance"]["account_info"])),
    );

    let service = AccountStateService::new(client.as_ref(), None);
    let balances =
        futures::executor::block_on(service.finalized_account_balances(vec![first, second, first]))
            .unwrap_or_else(|error| panic!("batch balance failed: {error}"));
    assert_eq!(balances.len(), 3);
    assert_eq!(balances[0], balances[2]);
    assert_eq!(balances[0].free_fen(), 123_456);
    assert_eq!(balances[1].account_id(), second);
    assert_eq!(balances[1].total_fen(), 0);
    assert!(balances.iter().all(|balance| balance.block() == finalized));
    assert_eq!(
        *client
            .batch_blocks
            .lock()
            .unwrap_or_else(|error| panic!("batch block lock poisoned: {error}")),
        vec![VerifiedBlockRef::from(finalized)]
    );
    assert_eq!(
        *client
            .batch_widths
            .lock()
            .unwrap_or_else(|error| panic!("batch lock poisoned: {error}")),
        vec![2]
    );
}

#[test]
fn finalized_batch_empty_and_limit_are_checked_before_any_chain_access() {
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0xaa; 32]), 77);
    let client = TestClient::new(
        VerifiedBlockRef::best(Hash32::from_bytes([0xbb; 32]), 78),
        finalized,
    );
    let service = AccountStateService::new(&client, None);
    assert!(
        futures::executor::block_on(service.finalized_account_balances(Vec::new()))
            .unwrap_or_else(|error| panic!("empty batch failed: {error}"))
            .is_empty()
    );
    let account = AccountId32::from_bytes([0x55; 32]);
    let error =
        futures::executor::block_on(service.finalized_account_balances(vec![account; 1991]))
            .err()
            .unwrap_or_else(|| panic!("oversized duplicate batch must fail"));
    assert!(
        matches!(error, EngineError::Contract(error) if error.code() == ContractErrorCode::InvalidArgument)
    );
    assert_eq!(client.reads.load(Ordering::SeqCst), 0);
    let balances =
        futures::executor::block_on(service.finalized_account_balances(vec![account; 1990]))
            .unwrap_or_else(|error| panic!("maximum batch failed: {error}"));
    assert_eq!(balances.len(), 1990);
    assert!(balances
        .iter()
        .all(|balance| balance.account_id() == account && balance.block() == finalized));
    assert_eq!(
        *client
            .batch_widths
            .lock()
            .unwrap_or_else(|error| panic!("batch lock poisoned: {error}")),
        vec![1]
    );
}

#[test]
fn nonempty_batch_can_progress_after_chain_readiness_without_wallet_or_subscription() {
    use citizen_sdk_contracts::{CapabilityName, Modules};
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0xaa; 32]), 77);
    let client = Arc::new(TestClient::new(
        VerifiedBlockRef::best(Hash32::from_bytes([0xbb; 32]), 78),
        finalized,
    ));
    let chain: Arc<dyn VerifiedChainClient> = client.clone();
    let engine = CitizenEngine::new(
        EngineComponents::new(Some(chain), None, None, None, None, None, None, None).with_modules(
            Modules::try_new(Modules::CHAIN)
                .unwrap_or_else(|error| panic!("modules failed: {error}")),
        ),
    );
    engine
        .update_capabilities(
            CapabilityName::ALL
                .into_iter()
                .map(CapabilityProbe::ready)
                .collect(),
        )
        .unwrap_or_else(|error| panic!("capability setup failed: {error}"));
    engine
        .update_chain_readiness(false)
        .unwrap_or_else(|error| panic!("chain not-ready setup failed: {error}"));
    engine
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("start failed: {error}"));
    futures::executor::block_on(engine.complete_provider_start())
        .unwrap_or_else(|error| panic!("start completion failed: {error}"));
    let accounts = vec![AccountId32::from_bytes([0x55; 32])];
    let before = client.reads.load(Ordering::SeqCst);
    assert!(
        futures::executor::block_on(engine.finalized_account_balances(accounts.clone())).is_err()
    );
    assert_eq!(client.reads.load(Ordering::SeqCst), before);
    // provider readiness 是绑定层的真实输入；这里验证 Core 转换，不伪称真实网络验收。
    engine
        .update_chain_readiness(true)
        .unwrap_or_else(|error| panic!("chain-ready setup failed: {error}"));
    let balances = futures::executor::block_on(engine.finalized_account_balances(accounts))
        .unwrap_or_else(|error| panic!("batch failed after readiness: {error}"));
    assert_eq!(balances.len(), 1);
    assert_eq!(balances[0].block(), finalized);
    assert_eq!(balances[0].total_fen(), 0);
}

#[test]
fn finalized_batch_rejects_provider_failure_wrong_count_and_overflow_without_partial_result() {
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0xaa; 32]), 77);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0xbb; 32]), 78);
    let account = AccountId32::from_bytes([0x55; 32]);
    let mut client = TestClient::new(best, finalized);
    client.batch_error = Some(ContractErrorCode::Timeout);
    let error = futures::executor::block_on(
        AccountStateService::new(&client, None).finalized_account_balances(vec![account]),
    )
    .err()
    .unwrap_or_else(|| panic!("provider failure must fail batch"));
    assert!(
        matches!(error, EngineError::Contract(error) if error.code() == ContractErrorCode::Timeout)
    );

    client.batch_error = None;
    client.omit_last_batch_value = true;
    assert_integrity(futures::executor::block_on(
        AccountStateService::new(&client, None).finalized_account_balances(vec![account]),
    ));

    client.omit_last_batch_value = false;
    let mut raw = vec![0_u8; 48];
    raw[16..32].copy_from_slice(&u128::MAX.to_le_bytes());
    raw[32..48].copy_from_slice(&1_u128.to_le_bytes());
    client.insert(
        system_account_storage_key(&decode_metadata(&client.metadata), account)
            .unwrap_or_else(|error| panic!("storage key failed: {error}")),
        raw,
    );
    let result = futures::executor::block_on(
        AccountStateService::new(&client, None)
            .finalized_account_balances(vec![AccountId32::from_bytes([0x44; 32]), account]),
    );
    assert!(
        result.is_err(),
        "one overflow must reject the complete batch"
    );
}

#[test]
fn missing_and_short_account_info_are_zero_without_partial_field_guessing() {
    let identity = ChainIdentity::citizenchain();
    let block = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x91; 32]), 9);
    let account = AccountId32::from_bytes([0x22; 32]);
    for raw in [None, Some(&[0_u8; 47][..])] {
        let balance = decode_finalized_account_balance(&identity, block, account, raw)
            .unwrap_or_else(|error| panic!("zero balance decode failed: {error}"));
        assert_eq!(balance.free_fen(), 0);
        assert_eq!(balance.reserved_fen(), 0);
        assert_eq!(balance.total_fen(), 0);
    }
}

#[test]
fn fee_policy_is_decoded_only_from_one_exact_production_runtime_context() {
    let vector = vector();
    let fee = &vector["fee_policy"];
    let best = VerifiedBlockRef::best(
        hash32(&fee["best_block_hash"]),
        fee["best_block_number"]
            .as_u64()
            .unwrap_or_else(|| panic!("best block number is not u64")),
    );
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0xaa; 32]), 77);
    let client = TestClient::new(best, finalized);
    let service = AccountStateService::new(&client, None);
    let snapshot = futures::executor::block_on(service.best_fee_snapshot())
        .unwrap_or_else(|error| panic!("fee snapshot failed: {error}"));

    assert_eq!(snapshot.block(), best);
    assert_eq!(
        snapshot.policy().fee_rate_parts(),
        fee["fee_rate_parts"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or_else(|| panic!("fee rate is not u32"))
    );
    assert_eq!(
        snapshot.policy().minimum_fee_fen(),
        integer(&fee["minimum_fee_fen"])
    );
    assert_eq!(
        snapshot.existential_deposit_fen(),
        integer(&fee["existential_deposit_fen"])
    );
    assert_eq!(
        snapshot
            .minimum_self_pay_fen()
            .unwrap_or_else(|error| panic!("minimum self pay failed: {error}")),
        integer(&fee["minimum_self_pay_fen"])
    );
    for estimate in fee["estimates"]
        .as_array()
        .unwrap_or_else(|| panic!("estimates is not an array"))
    {
        assert_eq!(
            snapshot
                .estimate_fee_fen(integer(&estimate["amount_fen"]))
                .unwrap_or_else(|error| panic!("fee estimate failed: {error}")),
            integer(&estimate["fee_fen"])
        );
    }

    let finalized_context = RuntimeContext::try_new(
        VerifiedBlockRef::finalized(best.hash(), best.number()),
        RuntimeVersion::new(0, 0),
        client.metadata.clone(),
    )
    .unwrap_or_else(|error| panic!("finalized context fixture failed: {error}"));
    let error = decode_best_fee_snapshot(&ChainIdentity::citizenchain(), &finalized_context)
        .err()
        .unwrap_or_else(|| panic!("fee policy must reject a finalized-only anchor"));
    assert!(matches!(
        error,
        EngineError::Contract(ref value) if value.code() == ContractErrorCode::InvalidArgument
    ));
}

#[test]
fn nonce_is_exact_best_runtime_typed_and_cross_block_or_cross_account_results_are_rejected() {
    let account = AccountId32::from_bytes([0x31; 32]);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x32; 32]), 32);
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x30; 32]), 30);
    let client = TestClient::new(best, finalized);
    let valid_source = TestNonceSource {
        returned_account: None,
        returned_block: None,
        value: 8,
    };
    let service = AccountStateService::new(&client, Some(&valid_source));
    let nonce = futures::executor::block_on(service.account_next_index(account))
        .unwrap_or_else(|error| panic!("nonce failed: {error}"));
    assert_eq!(nonce.account_id(), account);
    assert_eq!(nonce.best_block(), best);
    assert_eq!(nonce.value(), 8);

    let wrong_account = TestNonceSource {
        returned_account: Some(AccountId32::from_bytes([0x44; 32])),
        returned_block: None,
        value: 8,
    };
    let service = AccountStateService::new(&client, Some(&wrong_account));
    assert_integrity(futures::executor::block_on(
        service.account_next_index(account),
    ));

    let wrong_block = TestNonceSource {
        returned_account: None,
        returned_block: Some(VerifiedBlockRef::best(Hash32::from_bytes([0x45; 32]), 33)),
        value: 8,
    };
    let service = AccountStateService::new(&client, Some(&wrong_block));
    assert_integrity(futures::executor::block_on(
        service.account_next_index(account),
    ));
}

#[test]
fn mismatched_runtime_context_is_rejected_before_chain_state_is_decoded() {
    let account = AccountId32::from_bytes([0x61; 32]);
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x62; 32]), 62);
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x60; 32]), 60);
    let mut client = TestClient::new(best, finalized);
    client.runtime_block_override = Some(VerifiedBlockRef::finalized(
        Hash32::from_bytes([0x63; 32]),
        60,
    ));
    let service = AccountStateService::new(&client, None);
    let error = futures::executor::block_on(service.finalized_account_balance(account))
        .err()
        .unwrap_or_else(|| panic!("mismatched runtime block must fail"));
    assert!(matches!(error, EngineError::BlockContextMismatch(_)));
}

fn vector() -> JsonValue {
    serde_json::from_str(VECTOR_JSON)
        .unwrap_or_else(|error| panic!("balance/fee vector JSON failed: {error}"))
}

fn finalized_from_vector(vector: &JsonValue) -> FinalizedBlockRef {
    let balance = &vector["account_balance"];
    FinalizedBlockRef::from_parts(
        hash32(&balance["finalized_block_hash"]),
        balance["finalized_block_number"]
            .as_u64()
            .unwrap_or_else(|| panic!("finalized block number is not u64")),
    )
}

fn account_id(value: &JsonValue) -> AccountId32 {
    AccountId32::from_bytes(fixed_bytes(string(value)))
}

fn hash32(value: &JsonValue) -> Hash32 {
    Hash32::from_bytes(fixed_bytes(string(value)))
}

fn fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    let bytes = decode_hex(value);
    bytes
        .try_into()
        .unwrap_or_else(|bytes: Vec<u8>| panic!("expected {N} bytes, got {}", bytes.len()))
}

fn integer(value: &JsonValue) -> u128 {
    string(value)
        .parse()
        .unwrap_or_else(|error| panic!("u128 string failed: {error}"))
}

fn string(value: &JsonValue) -> &str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("JSON value is not a string"))
}

fn decode_metadata(bytes: &[u8]) -> Metadata {
    let mut cursor = bytes;
    let metadata = Metadata::decode(&mut cursor)
        .unwrap_or_else(|error| panic!("metadata decode failed: {error}"));
    assert!(cursor.is_empty(), "metadata has trailing bytes");
    metadata
}

fn decode_hex(value: &str) -> Vec<u8> {
    let compact = value.trim().strip_prefix("0x").unwrap_or(value.trim());
    assert_eq!(compact.len() % 2, 0, "hex length must be even");
    (0..compact.len())
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&compact[offset..offset + 2], 16)
                .unwrap_or_else(|error| panic!("hex decode failed at {offset}: {error}"))
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn assert_integrity<T>(result: Result<T, EngineError>) {
    match result {
        Err(EngineError::Contract(error)) => {
            assert_eq!(error.code(), ContractErrorCode::Integrity)
        }
        Err(other) => panic!("unexpected error: {other}"),
        Ok(_) => panic!("integrity mismatch must fail"),
    }
}

// 经过真实 Engine 准备与冷签执行入口，验证执行不再二次读取链状态或 nonce。
#[test]
fn prepared_execution_reads_nonce_once_and_keeps_single_use_and_source_isolation() {
    use citizen_sdk_contracts::{
        citizen_ss58_address, CapabilityName, ColdWalletAccount, TransactionExecutionId,
        TransactionHistoryCursor, TransactionHistoryIndex, TransactionHistoryMutation,
        TransactionHistoryQueryKind, TransactionHistoryRecordBatch,
        TransactionHistoryRecordSnapshot, TransactionHistoryStore, WalletProfileStore, WalletState,
    };
    use citizen_sdk_contracts::{
        EncryptedSecretBlobSnapshot, EncryptedSecretBlobState, EncryptedSecretBlobStore,
        EncryptedSecretEnvelope, SecretBuffer, SecretRef, SecretVault, VaultAvailability,
        VaultGeneration,
    };
    use citizen_sdk_engine::TransactionExecutionStart;
    // 冷签只读取公开目录；任何秘密、金库或密文操作都会使本测试失败。
    struct NoSecrets;
    impl SecretVault for NoSecrets {
    fn authorize_add_accounts(&self, _: [u8; 16], _: u32, _: VaultGeneration) -> ContractFuture<'_, ()> {
        panic!("此夹具不得执行追加认证")
    }
        fn ensure_wallet_key(&self, _: [u8; 16], _: u32, _: VaultGeneration) -> ContractFuture<'_, ()> {
            panic!("冷签不能初始化金库")
        }
        fn availability(&self) -> ContractFuture<'_, VaultAvailability> {
            panic!("冷签不能读取金库")
        }
        fn seal(
            &self,
            _: [u8; 16],
            _: SecretRef,
            _: SecretBuffer,
        ) -> ContractFuture<'_, EncryptedSecretEnvelope> {
            panic!("冷签不能写秘密")
        }
        fn open(
            &self,
            _: SecretRef,
            _: EncryptedSecretEnvelope,
        ) -> ContractFuture<'_, SecretBuffer> {
            panic!("冷签不能打开秘密")
        }
        fn has_any_wallet_key(&self, _: u32) -> ContractFuture<'_, bool> {
            panic!("冷签不能查询金库")
        }
        fn has_wallet_key(&self, _: u32, _: VaultGeneration) -> ContractFuture<'_, bool> {
            panic!("冷签不能查询金库")
        }
        fn delete_wallet_key(
            &self,
            _: [u8; 16],
            _: u32,
            _: VaultGeneration,
        ) -> ContractFuture<'_, ()> {
            panic!("冷签不能删除金库")
        }
    }
    impl EncryptedSecretBlobStore for NoSecrets {
        fn has_account_secret(&self, _: AccountId32) -> ContractFuture<'_, bool> {
            panic!("冷签不能查询密文")
        }
        fn load(&self, _: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
            panic!("冷签不能读取密文")
        }
        fn compare_and_swap(
            &self,
            _: SecretRef,
            _: u64,
            _: EncryptedSecretBlobState,
        ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot> {
            panic!("冷签不能修改密文")
        }
    }
    struct Nonce(AtomicUsize);
    impl AccountNonceSource for Nonce {
        fn account_next_index(
            &self,
            account: AccountId32,
            block: VerifiedBlockRef,
        ) -> ContractFuture<'_, AccountNonce> {
            let attempt = self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                AccountNonce::try_new(
                    &ChainIdentity::citizenchain(),
                    block,
                    account,
                    attempt as u64,
                )
            })
        }
    }
    struct Profile(WalletState);
    impl WalletProfileStore for Profile {
        fn load(&self) -> ContractFuture<'_, WalletState> {
            Box::pin(async { Ok(self.0.clone()) })
        }
        fn compare_and_swap(&self, _: u64, _: WalletState) -> ContractFuture<'_, WalletState> {
            Box::pin(async { panic!("准备/冷签不能改写钱包") })
        }
    }
    struct History;
    impl TransactionHistoryStore for History {
        fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex> {
            Box::pin(async { Ok(TransactionHistoryIndex::empty()) })
        }
        fn load_record(
            &self,
            _: u64,
            _: TransactionExecutionId,
        ) -> ContractFuture<'_, TransactionHistoryRecordSnapshot> {
            Box::pin(async { panic!("空历史不应读取交易记录") })
        }
        fn load_page(
            &self,
            _: u64,
            _: TransactionHistoryQueryKind,
            _: Option<TransactionHistoryCursor>,
            _: usize,
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
            _: TransactionHistoryMutation,
        ) -> ContractFuture<'_, TransactionHistoryIndex> {
            Box::pin(async { panic!("未完成用户冷签不得持久化或广播") })
        }
    }
    let account = AccountId32::from_bytes([0x51; 32]);
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x42; 32]), 42);
    let best = VerifiedBlockRef::best(finalized.hash(), finalized.number());
    let chain = Arc::new(TestClient::new(best, finalized));
    let metadata = decode_metadata(&chain.metadata);
    let pallet = metadata.pallet_by_name("System").expect("System metadata");
    let call = pallet
        .call_variant_by_name("remark")
        .expect("remark metadata");
    let call_data = vec![pallet.index(), call.index, 0];
    let profile = WalletState::try_from_catalog_parts(
        1,
        None,
        vec![
            ColdWalletAccount::try_new(2, account, citizen_ss58_address(account), "合成钱包", 0)
                .expect("synthetic cold account"),
        ],
        vec![account],
        3,
        None,
        None,
        Vec::new(),
    )
    .expect("synthetic wallet state");
    let nonce = Arc::new(Nonce(AtomicUsize::new(0)));
    let engine = CitizenEngine::new(
        EngineComponents::new(
            Some(chain.clone()),
            Some(Arc::new(citizen_signer::Sr25519SoftwareSigner)),
            Some(Arc::new(NoSecrets)),
            None,
            None,
            Some(Arc::new(Profile(profile))),
            Some(Arc::new(History)),
            Some(Arc::new(NoSecrets)),
        )
        .with_account_nonce_source(nonce.clone()),
    );
    engine
        .update_capabilities(
            CapabilityName::ALL
                .into_iter()
                .map(CapabilityProbe::ready)
                .collect(),
        )
        .expect("capabilities");
    engine.begin_provider_start().expect("start");
    futures::executor::block_on(engine.complete_provider_start()).expect("started");
    engine
        .update_capabilities(
            CapabilityName::ALL
                .into_iter()
                .map(CapabilityProbe::ready)
                .collect(),
        )
        .expect("running capabilities");
    let prepared =
        futures::executor::block_on(engine.prepare_transaction(account, call_data.clone()))
            .expect("one preparation");
    let reads = chain.reads.load(Ordering::SeqCst);
    assert_eq!(nonce.0.load(Ordering::SeqCst), 1);
    assert!(
        futures::executor::block_on(engine.prepare_transaction(account, call_data.clone()))
            .is_err()
    );
    let execution =
        futures::executor::block_on(engine.execute_prepared_transaction(prepared.preparation_id()))
            .expect("frozen preparation reaches cold signing without another nonce");
    let TransactionExecutionStart::ExternalSigning { execution_id, .. } = execution else {
        panic!("cold wallet must await its external signature");
    };
    assert_eq!(nonce.0.load(Ordering::SeqCst), 1);
    assert_eq!(chain.reads.load(Ordering::SeqCst), reads);
    assert!(futures::executor::block_on(
        engine.execute_prepared_transaction(prepared.preparation_id())
    )
    .is_err());
    assert!(
        futures::executor::block_on(engine.prepare_transaction(account, call_data.clone()))
            .is_err()
    );
    engine
        .cancel_transaction_execution(execution_id)
        .expect("cancel cold execution");
    let next = futures::executor::block_on(engine.prepare_transaction(account, call_data))
        .expect("new user operation can prepare once again");
    assert_eq!(nonce.0.load(Ordering::SeqCst), 2);
    engine
        .cancel_prepared_transaction(next.preparation_id())
        .expect("cancel preparation");
    assert!(futures::executor::block_on(
        engine.execute_prepared_transaction(next.preparation_id())
    )
    .is_err());
    assert_eq!(nonce.0.load(Ordering::SeqCst), 2);
}
