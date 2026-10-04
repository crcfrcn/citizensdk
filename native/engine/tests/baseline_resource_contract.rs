#![cfg(feature = "chain")]

//! Repeatable, assertion-based resource baseline for the public Engine surface.
//!
//! Timings are evidence only: this test freezes cardinality and ownership limits,
//! but deliberately has no machine-specific latency threshold.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

use citizen_sdk_contracts::{
    AccountId32, CapabilityName, ChainIdentity, ContractError, ContractErrorCode, ContractFuture,
    ContractStream, ExportedChainState, ExtrinsicWatchEvent, FinalizedBlockRef, Hash32,
    HistoryTransactionStatus, Modules, RuntimeCacheStore, RuntimeContext, RuntimeVersion,
    SignedExtrinsic, StateImportReceipt, SubmittedExtrinsic, TransactionExecutionId,
    TransactionExecutionRecord, TransactionHistoryCursor, TransactionHistoryIndex,
    TransactionHistoryMutation, TransactionHistoryQueryKind, TransactionHistoryRecordBatch,
    TransactionHistoryRecordSnapshot, TransactionHistoryStore, VerifiedBlockRef,
    VerifiedChainClient, MAX_PERSISTED_RUNTIME_CONTEXTS, MAX_PERSISTED_RUNTIME_METADATA_BYTES,
    MAX_PREPARED_TRANSACTIONS, MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES,
    MAX_TRANSACTION_HISTORY_PAGE_SIZE, MAX_TRANSACTION_HISTORY_RECORDS,
    MAX_TRANSACTION_HISTORY_SYNC_BATCH,
};
use citizen_sdk_engine::{
    CapabilityProbe, CitizenEngine, EngineComponents, RuntimeContextCache, MAX_RUNTIME_CONTEXTS,
};

const SAMPLE_COUNTS: [usize; 4] = [0, 1, 100, 1_000];
const SAMPLE_ROUNDS: usize = 20;

#[derive(Default)]
struct MemoryHistoryState {
    index: TransactionHistoryIndex,
    records: BTreeMap<TransactionExecutionId, TransactionExecutionRecord>,
    ordered: BTreeSet<(u64, TransactionExecutionId)>,
}

#[derive(Default)]
struct MemoryHistoryStore {
    state: Mutex<MemoryHistoryState>,
    index_loads: AtomicUsize,
    record_loads: AtomicUsize,
    page_loads: AtomicUsize,
    page_records_returned: AtomicUsize,
    writes: AtomicUsize,
}

impl MemoryHistoryStore {
    fn with_records(records: Vec<TransactionExecutionRecord>) -> Self {
        let weight = records
            .iter()
            .map(TransactionExecutionRecord::durable_weight_bytes)
            .sum();
        let open = records
            .iter()
            .filter(|record| !record.status().is_retention_terminal())
            .collect::<Vec<_>>();
        let index = TransactionHistoryIndex::try_new(
            1,
            records.len(),
            weight,
            open.len(),
            open.iter()
                .map(|record| record.durable_weight_bytes())
                .sum(),
        )
        .expect("baseline history index");
        Self {
            state: Mutex::new(MemoryHistoryState {
                index,
                ordered: records
                    .iter()
                    .map(|record| (record.created_at_millis(), record.execution_id()))
                    .collect(),
                records: records
                    .into_iter()
                    .map(|record| (record.execution_id(), record))
                    .collect(),
            }),
            index_loads: AtomicUsize::new(0),
            record_loads: AtomicUsize::new(0),
            page_loads: AtomicUsize::new(0),
            page_records_returned: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
        }
    }
}

impl TransactionHistoryStore for MemoryHistoryStore {
    fn load_index(&self) -> ContractFuture<'_, TransactionHistoryIndex> {
        self.index_loads.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .lock()
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "baseline store poisoned"))
            .map(|state| state.index);
        Box::pin(async move { result })
    }

    fn load_record(
        &self,
        expected_revision: u64,
        execution_id: TransactionExecutionId,
    ) -> ContractFuture<'_, TransactionHistoryRecordSnapshot> {
        self.record_loads.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .lock()
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "baseline store poisoned"))
            .and_then(|state| {
                if state.index.revision() != expected_revision {
                    return Err(ContractError::new(
                        ContractErrorCode::Conflict,
                        "baseline query conflict",
                    ));
                }
                Ok(TransactionHistoryRecordSnapshot::new(
                    state.index,
                    state.records.get(&execution_id).cloned(),
                ))
            });
        Box::pin(async move { result })
    }

    fn load_page(
        &self,
        expected_revision: u64,
        kind: TransactionHistoryQueryKind,
        before: Option<TransactionHistoryCursor>,
        limit: usize,
    ) -> ContractFuture<'_, TransactionHistoryRecordBatch> {
        self.page_loads.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .lock()
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "baseline store poisoned"))
            .and_then(|state| {
                if state.index.revision() != expected_revision {
                    return Err(ContractError::new(
                        ContractErrorCode::Conflict,
                        "baseline query conflict",
                    ));
                }
                let mut records = match kind {
                    TransactionHistoryQueryKind::Newest => state
                        .ordered
                        .iter()
                        .rev()
                        .filter(|key| {
                            before.is_none_or(|cursor| {
                                **key < (cursor.created_at_millis(), cursor.execution_id())
                            })
                        })
                        .take(limit + 1)
                        .filter_map(|(_, execution_id)| state.records.get(execution_id).cloned())
                        .collect::<Vec<_>>(),
                    _ => {
                        let mut values = state
                            .records
                            .values()
                            .filter(|record| match kind {
                                TransactionHistoryQueryKind::OldestRetentionTerminal => {
                                    record.status().is_retention_terminal()
                                }
                                TransactionHistoryQueryKind::OldestReconcilable => {
                                    !record.status().is_chain_terminal()
                                }
                                TransactionHistoryQueryKind::Newest => unreachable!(),
                            })
                            .filter(|record| {
                                before.is_none_or(|cursor| {
                                    (record.created_at_millis(), record.execution_id())
                                        > (cursor.created_at_millis(), cursor.execution_id())
                                })
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        values.sort_by_key(|record| {
                            (record.created_at_millis(), record.execution_id())
                        });
                        values.truncate(limit + 1);
                        values
                    }
                };
                let has_more = records.len() > limit;
                records.truncate(limit);
                TransactionHistoryRecordBatch::try_new(state.index, records, has_more)
            });
        if let Ok(batch) = &result {
            self.page_records_returned
                .fetch_add(batch.records().len(), Ordering::SeqCst);
        }
        Box::pin(async move { result })
    }

    fn compare_and_swap(
        &self,
        mutation: TransactionHistoryMutation,
    ) -> ContractFuture<'_, TransactionHistoryIndex> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .lock()
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "baseline store poisoned"))
            .and_then(|mut state| {
                if state.index.revision() != mutation.expected_revision() {
                    return Err(ContractError::new(
                        ContractErrorCode::Conflict,
                        "baseline CAS conflict",
                    ));
                }
                for execution_id in mutation.deletes() {
                    if let Some(record) = state.records.remove(execution_id) {
                        state
                            .ordered
                            .remove(&(record.created_at_millis(), record.execution_id()));
                    }
                }
                for record in mutation.upserts() {
                    if let Some(previous) = state
                        .records
                        .get(&record.execution_id())
                        .map(|value| (value.created_at_millis(), value.execution_id()))
                    {
                        state.ordered.remove(&previous);
                    }
                    state.records.insert(record.execution_id(), record.clone());
                    state
                        .ordered
                        .insert((record.created_at_millis(), record.execution_id()));
                }
                state.index = mutation.next_index();
                Ok(state.index)
            });
        Box::pin(async move { result })
    }
}

struct BaselineClient {
    metadata_bytes: usize,
    runtime_requests: Arc<AtomicUsize>,
}

impl Default for BaselineClient {
    fn default() -> Self {
        Self {
            metadata_bytes: 1,
            runtime_requests: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl BaselineClient {
    fn with_metadata_bytes(metadata_bytes: usize) -> (Self, Arc<AtomicUsize>) {
        let runtime_requests = Arc::new(AtomicUsize::new(0));
        (
            Self {
                metadata_bytes,
                runtime_requests: Arc::clone(&runtime_requests),
            },
            runtime_requests,
        )
    }
}

#[derive(Default)]
struct MemoryRuntimeCacheState {
    contexts: HashMap<Hash32, RuntimeContext>,
    fifo: VecDeque<Hash32>,
}

#[derive(Default)]
struct MemoryRuntimeCacheStore {
    state: Mutex<MemoryRuntimeCacheState>,
    stores: AtomicUsize,
    deletes: AtomicUsize,
}

impl RuntimeCacheStore for MemoryRuntimeCacheStore {
    fn load(&self, block_hash: Hash32) -> ContractFuture<'_, Option<RuntimeContext>> {
        let result = self
            .state
            .lock()
            .map(|state| state.contexts.get(&block_hash).cloned())
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "cache poisoned"));
        Box::pin(async move { result })
    }

    fn store(&self, context: RuntimeContext) -> ContractFuture<'_, ()> {
        self.stores.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .lock()
            .map(|mut state| {
                let hash = context.block().hash();
                state.fifo.retain(|stored| stored != &hash);
                state.contexts.insert(hash, context);
                state.fifo.push_back(hash);
                while state.fifo.len() > MAX_PERSISTED_RUNTIME_CONTEXTS {
                    if let Some(oldest) = state.fifo.pop_front() {
                        state.contexts.remove(&oldest);
                    }
                }
            })
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "cache poisoned"));
        Box::pin(async move { result })
    }

    fn delete(&self, block_hash: Hash32) -> ContractFuture<'_, ()> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        let result = self
            .state
            .lock()
            .map(|mut state| {
                state.fifo.retain(|stored| stored != &block_hash);
                state.contexts.remove(&block_hash);
            })
            .map_err(|_| ContractError::new(ContractErrorCode::Internal, "cache poisoned"));
        Box::pin(async move { result })
    }
}

impl VerifiedChainClient for BaselineClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        Box::pin(async { Ok(ChainIdentity::citizenchain()) })
    }

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        Box::pin(async { Ok(VerifiedBlockRef::best(Hash32::from_bytes([0x41; 32]), 2)) })
    }

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        Box::pin(async {
            Ok(FinalizedBlockRef::from_parts(
                Hash32::from_bytes([0x40; 32]),
                1,
            ))
        })
    }

    fn get_storage_at(
        &self,
        _block: VerifiedBlockRef,
        _key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        Box::pin(async { Ok(None) })
    }

    fn get_storage_batch_at(
        &self,
        _block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        Box::pin(async move { Ok(keys.into_iter().map(|_| None).collect()) })
    }

    fn get_runtime_context_at(
        &self,
        block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        self.runtime_requests.fetch_add(1, Ordering::SeqCst);
        let metadata_bytes = self.metadata_bytes;
        Box::pin(async move {
            RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), vec![0x01; metadata_bytes])
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
                "baseline client does not submit",
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
            ExportedChainState::try_new(
                ChainIdentity::citizenchain(),
                1,
                FinalizedBlockRef::from_parts(Hash32::from_bytes([0x40; 32]), 1),
                vec![0x01],
            )
        })
    }

    fn import_state(&self, state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        Box::pin(async move { Ok(StateImportReceipt::new(state.finalized())) })
    }
}

fn execution(index: usize) -> TransactionExecutionRecord {
    let ordinal = u128::try_from(index + 1).expect("baseline ordinal");
    let mut transaction_hash = [0_u8; 32];
    transaction_hash[..16].copy_from_slice(&ordinal.to_le_bytes());
    let call_data = vec![u8::try_from(index % 251).expect("baseline marker"); 128];
    let call_data_hash = Hash32::from_bytes(
        citizen_sdk_contracts::blake2_256(&call_data).expect("baseline callData hash"),
    );
    TransactionExecutionRecord::try_new(
        TransactionExecutionId::try_new(ordinal.to_le_bytes()).expect("baseline execution id"),
        AccountId32::from_bytes([0x11; 32]),
        call_data_hash,
        call_data,
        Hash32::from_bytes(transaction_hash),
        SignedExtrinsic::try_new(vec![0x84; 256]).expect("baseline signed extrinsic"),
        VerifiedBlockRef::best(Hash32::from_bytes([0x41; 32]), 2),
        RuntimeVersion::new(1, 1),
        ChainIdentity::citizenchain().genesis_hash(),
        u64::try_from(index).expect("baseline nonce"),
        HistoryTransactionStatus::Pending,
        u64::try_from(index + 1).expect("baseline timestamp"),
        u64::try_from(index + 1).expect("baseline timestamp"),
    )
    .expect("baseline execution")
}

fn running_history_engine(
    records: Vec<TransactionExecutionRecord>,
) -> (CitizenEngine, Arc<MemoryHistoryStore>) {
    let store = Arc::new(MemoryHistoryStore::with_records(records));
    let components = EngineComponents::new(
        Some(Arc::new(BaselineClient::default())),
        None,
        None,
        None,
        None,
        None,
        Some(Arc::clone(&store) as Arc<dyn TransactionHistoryStore>),
        None,
    )
    .with_modules(Modules::try_new(Modules::CHAIN | Modules::HISTORY).expect("baseline modules"));
    let engine = CitizenEngine::new(components);
    let probes = CapabilityName::ALL
        .into_iter()
        .map(CapabilityProbe::ready)
        .collect();
    engine
        .update_capabilities(probes)
        .expect("baseline capabilities");
    engine
        .begin_provider_start()
        .expect("baseline start reservation");
    futures::executor::block_on(engine.complete_provider_start()).expect("baseline start");
    (engine, store)
}

fn timing_summary(samples: &[u128]) -> (u128, u128, u128, f64) {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let percentile = |numerator: usize| {
        let rank = (sorted.len() * numerator).div_ceil(100).saturating_sub(1);
        sorted[rank.min(sorted.len() - 1)]
    };
    let mean = samples.iter().map(|value| *value as f64).sum::<f64>() / samples.len() as f64;
    let variance = samples
        .iter()
        .map(|value| {
            let delta = *value as f64 - mean;
            delta * delta
        })
        .sum::<f64>()
        / samples.len() as f64;
    (
        percentile(50),
        percentile(95),
        *sorted.last().expect("nonempty timing sample"),
        variance.sqrt() / mean,
    )
}

#[test]
fn history_page_cost_is_measured_without_weakening_fixed_limits() {
    assert_eq!(MAX_TRANSACTION_HISTORY_RECORDS, 4_096);
    assert_eq!(MAX_TRANSACTION_HISTORY_PAGE_SIZE, 100);
    assert_eq!(MAX_TRANSACTION_HISTORY_SYNC_BATCH, 32);

    for count in SAMPLE_COUNTS {
        let records = (0..count).map(execution).collect::<Vec<_>>();
        let (engine, store) = running_history_engine(records);
        let warmup = futures::executor::block_on(
            engine.get_transaction_history(None, MAX_TRANSACTION_HISTORY_PAGE_SIZE),
        )
        .expect("baseline history warmup");
        assert_eq!(
            warmup.records().len(),
            count.min(MAX_TRANSACTION_HISTORY_PAGE_SIZE)
        );
        store.index_loads.store(0, Ordering::SeqCst);
        store.page_loads.store(0, Ordering::SeqCst);
        store.page_records_returned.store(0, Ordering::SeqCst);
        let mut samples = Vec::with_capacity(SAMPLE_ROUNDS);
        for _ in 0..SAMPLE_ROUNDS {
            let started = Instant::now();
            let page = futures::executor::block_on(
                engine.get_transaction_history(None, MAX_TRANSACTION_HISTORY_PAGE_SIZE),
            )
            .expect("baseline history page");
            samples.push(started.elapsed().as_nanos());
            assert_eq!(
                page.records().len(),
                count.min(MAX_TRANSACTION_HISTORY_PAGE_SIZE)
            );
            assert_eq!(
                page.next_before_execution_id().is_some(),
                count > MAX_TRANSACTION_HISTORY_PAGE_SIZE
            );
        }
        assert_eq!(store.index_loads.load(Ordering::SeqCst), SAMPLE_ROUNDS);
        assert_eq!(store.page_loads.load(Ordering::SeqCst), SAMPLE_ROUNDS);
        assert_eq!(store.record_loads.load(Ordering::SeqCst), 0);
        assert_eq!(store.writes.load(Ordering::SeqCst), 0);
        assert_eq!(
            store.page_records_returned.load(Ordering::SeqCst),
            SAMPLE_ROUNDS * count.min(MAX_TRANSACTION_HISTORY_PAGE_SIZE)
        );
        let (median, p95, maximum, cv) = timing_summary(&samples);
        println!(
            "sdk-baseline history_page count={count} median_ns={median} p95_ns={p95} max_ns={maximum} cv={cv:.6} returned_per_round={}",
            count.min(MAX_TRANSACTION_HISTORY_PAGE_SIZE)
        );
    }

    assert!(
        TransactionHistoryIndex::try_new(1, MAX_TRANSACTION_HISTORY_RECORDS + 1, 0, 0, 0,).is_err()
    );
    assert_eq!(
        MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES,
        31 * 1024 * 1024
    );
}

#[test]
fn single_execution_mutation_never_queries_or_rewrites_other_999_rows() {
    let store = MemoryHistoryStore::with_records((0..1_000).map(execution).collect());
    let index = futures::executor::block_on(store.load_index()).expect("history index");
    let id = TransactionExecutionId::try_new(500_u128.to_le_bytes()).expect("execution id");
    let snapshot = futures::executor::block_on(store.load_record(index.revision(), id))
        .expect("target execution");
    let updated = snapshot
        .record()
        .expect("target record")
        .try_with_status(
            HistoryTransactionStatus::InBlock {
                block: VerifiedBlockRef::best(Hash32::from_bytes([0x51; 32]), 3),
            },
            2_000,
        )
        .expect("status update");
    let next = TransactionHistoryIndex::try_new(
        index.revision() + 1,
        index.record_count(),
        index.durable_weight_bytes(),
        index.open_count(),
        index.open_weight_bytes(),
    )
    .expect("next history index");
    let mutation =
        TransactionHistoryMutation::try_new(index.revision(), next, vec![], vec![updated])
            .expect("single-record mutation");
    assert_eq!(
        futures::executor::block_on(store.compare_and_swap(mutation)).expect("history mutation"),
        next
    );
    assert_eq!(store.index_loads.load(Ordering::SeqCst), 1);
    assert_eq!(store.record_loads.load(Ordering::SeqCst), 1);
    assert_eq!(store.page_loads.load(Ordering::SeqCst), 0);
    assert_eq!(store.writes.load(Ordering::SeqCst), 1);
}

#[test]
fn runtime_and_session_cardinalities_remain_explicit_and_bounded() {
    let mut cache = RuntimeContextCache::new();
    for index in 0..(MAX_RUNTIME_CONTEXTS + 16) {
        let ordinal = u64::try_from(index + 1).expect("baseline runtime ordinal");
        let mut hash = [0_u8; 32];
        hash[..8].copy_from_slice(&ordinal.to_le_bytes());
        let block = VerifiedBlockRef::finalized(Hash32::from_bytes(hash), ordinal);
        let request = cache.begin(block).expect("baseline runtime request");
        let context = RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), vec![0x01])
            .expect("baseline runtime context");
        cache
            .complete(request, context)
            .expect("baseline runtime completion");
    }
    let retained = (0..(MAX_RUNTIME_CONTEXTS + 16))
        .filter(|index| {
            let ordinal = u64::try_from(index + 1).expect("baseline runtime ordinal");
            let mut hash = [0_u8; 32];
            hash[..8].copy_from_slice(&ordinal.to_le_bytes());
            cache
                .get(VerifiedBlockRef::finalized(
                    Hash32::from_bytes(hash),
                    ordinal,
                ))
                .is_some()
        })
        .count();
    assert_eq!(retained, MAX_RUNTIME_CONTEXTS);
    assert_eq!(MAX_PREPARED_TRANSACTIONS, 256);

    let qr_session_source = include_str!("../../qr/src/session.rs");
    assert!(qr_session_source.contains("const MAX_ACTIVE_SESSIONS: usize = 64;"));
    assert!(qr_session_source.contains("self.sessions.len() >= MAX_ACTIVE_SESSIONS"));
    let wallet_source = include_str!("../src/wallet_service.rs");
    assert!(wallet_source.contains("const MAX_CLEANUP_QUEUE: usize = 64;"));
    assert!(wallet_source.contains("state.cleanup_queue().len() >= MAX_CLEANUP_QUEUE"));
    let preparation_source = include_str!("../src/transaction_prepare.rs");
    assert!(preparation_source.contains("self.sources.len() >= MAX_PREPARED_TRANSACTIONS"));
}

#[test]
fn persistent_runtime_cache_retains_only_the_latest_sixty_four_contexts() {
    let store = Arc::new(MemoryRuntimeCacheStore::default());
    let components = EngineComponents::new(
        Some(Arc::new(BaselineClient::default())),
        None,
        None,
        None,
        Some(Arc::clone(&store) as Arc<dyn RuntimeCacheStore>),
        None,
        None,
        None,
    )
    .with_modules(Modules::try_new(Modules::CHAIN).expect("baseline chain module"));
    let engine = CitizenEngine::new(components);
    let probes = CapabilityName::ALL
        .into_iter()
        .map(CapabilityProbe::ready)
        .collect();
    engine
        .update_capabilities(probes)
        .expect("baseline capabilities");
    engine
        .begin_provider_start()
        .expect("baseline start reservation");
    futures::executor::block_on(engine.complete_provider_start()).expect("baseline start");

    let requested = MAX_RUNTIME_CONTEXTS + 16;
    for index in 0..requested {
        let ordinal = u64::try_from(index + 1).expect("baseline runtime ordinal");
        let mut hash = [0_u8; 32];
        hash[..8].copy_from_slice(&ordinal.to_le_bytes());
        let block = VerifiedBlockRef::finalized(Hash32::from_bytes(hash), ordinal);
        let context = futures::executor::block_on(engine.runtime_context_at(block))
            .expect("baseline runtime context");
        assert_eq!(context.block(), block);
    }

    let state = store.state.lock().expect("baseline cache lock");
    let persisted = state.contexts.len();
    assert_eq!(persisted, MAX_PERSISTED_RUNTIME_CONTEXTS);
    for index in 0..requested {
        let ordinal = u64::try_from(index + 1).expect("baseline runtime ordinal");
        let mut hash = [0_u8; 32];
        hash[..8].copy_from_slice(&ordinal.to_le_bytes());
        assert_eq!(
            state.contexts.contains_key(&Hash32::from_bytes(hash)),
            index >= requested - MAX_PERSISTED_RUNTIME_CONTEXTS
        );
    }
    drop(state);
    assert_eq!(store.stores.load(Ordering::SeqCst), requested);
    assert_eq!(store.deletes.load(Ordering::SeqCst), 0);
    println!(
        "sdk-baseline persistent_runtime_cache memory_limit={MAX_RUNTIME_CONTEXTS} persisted={persisted} deletes=0"
    );
}

#[test]
fn runtime_metadata_above_persistent_capacity_remains_memory_usable() {
    let store = Arc::new(MemoryRuntimeCacheStore::default());
    let metadata_bytes = MAX_PERSISTED_RUNTIME_METADATA_BYTES + 1;
    let (client, runtime_requests) = BaselineClient::with_metadata_bytes(metadata_bytes);
    let components = EngineComponents::new(
        Some(Arc::new(client)),
        None,
        None,
        None,
        Some(Arc::clone(&store) as Arc<dyn RuntimeCacheStore>),
        None,
        None,
        None,
    )
    .with_modules(Modules::try_new(Modules::CHAIN).expect("baseline chain module"));
    let engine = CitizenEngine::new(components);
    engine
        .update_capabilities(
            CapabilityName::ALL
                .into_iter()
                .map(CapabilityProbe::ready)
                .collect(),
        )
        .expect("baseline capabilities");
    engine
        .begin_provider_start()
        .expect("baseline start reservation");
    futures::executor::block_on(engine.complete_provider_start()).expect("baseline start");

    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0x71; 32]), 71);
    for _ in 0..2 {
        let context = futures::executor::block_on(engine.runtime_context_at(block))
            .expect("oversized metadata remains usable");
        assert_eq!(context.metadata().len(), metadata_bytes);
    }

    assert_eq!(runtime_requests.load(Ordering::SeqCst), 1);
    assert_eq!(store.stores.load(Ordering::SeqCst), 0);
    assert!(store
        .state
        .lock()
        .expect("baseline cache lock")
        .contexts
        .is_empty());
}
