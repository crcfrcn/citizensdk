#![cfg(feature = "chain")]

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier, Mutex,
};

use citizen_sdk_contracts::{
    CapabilityName, CapabilityReason, ChainDatabaseSnapshot, ChainDatabaseStore, ChainIdentity,
    ContractError, ContractErrorCode, ContractFuture, ContractStream, ExecutionConclusion,
    ExportedChainState, ExtrinsicWatchEvent, FinalizedBlockRef, Hash32, RuntimeCacheStore,
    RuntimeContext, RuntimeVersion, SignedExtrinsic, StateImportReceipt, SubmittedExtrinsic,
    UnverifiedReason, VerifiedBlockRef, VerifiedChainClient,
};
use citizen_sdk_engine::{
    signed_extrinsic_hash, CapabilityProbe, CitizenEngine, EngineComponents, EngineLifecycle,
    CHAIN_STATE_FORMAT_VERSION,
};

const METADATA_HEX: &str =
    include_str!("../../../test/transaction/citizenchain-runtime-v14-metadata.hex");
const EVENTS_HEX: &str =
    include_str!("../../../test/transaction/citizenchain-runtime-system-events.hex");
const SYSTEM_EVENTS_STORAGE_KEY: [u8; 32] = [
    0x26, 0xaa, 0x39, 0x4e, 0xea, 0x56, 0x30, 0xe0, 0x7c, 0x48, 0xae, 0x0c, 0x95, 0x58, 0xce, 0xf7,
    0x80, 0xd4, 0x1e, 0x5e, 0x16, 0x05, 0x67, 0x65, 0xbc, 0x84, 0x61, 0x85, 0x10, 0x72, 0xc9, 0xd7,
];

fn hex_bytes(value: &str) -> Vec<u8> {
    let value = value.trim();
    let Some(value) = value.strip_prefix("0x") else {
        panic!("fixture must use 0x prefix");
    };
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = match std::str::from_utf8(pair) {
                Ok(text) => text,
                Err(error) => panic!("fixture is not UTF-8 hex: {error}"),
            };
            match u8::from_str_radix(text, 16) {
                Ok(byte) => byte,
                Err(error) => panic!("fixture contains invalid hex: {error}"),
            }
        })
        .collect()
}

fn identity(genesis: u8) -> ChainIdentity {
    match ChainIdentity::try_new(
        "citizenchain",
        "citizenchain",
        Hash32::from_bytes([genesis; 32]),
    ) {
        Ok(identity) => identity,
        Err(error) => panic!("identity fixture failed: {error}"),
    }
}

struct FakeClient {
    block: VerifiedBlockRef,
    context: RuntimeContext,
    extrinsics: Vec<Vec<u8>>,
    events: Option<Vec<u8>>,
    imports: Arc<AtomicUsize>,
    evidence_reads: Arc<AtomicUsize>,
    exports: Arc<AtomicUsize>,
    import_fails: bool,
}

struct FakeChainDatabase {
    snapshot: Mutex<ChainDatabaseSnapshot>,
    failure: StoreFailure,
}

struct PoisonedRuntimeCache {
    context: RuntimeContext,
    loads: Arc<AtomicUsize>,
}

impl RuntimeCacheStore for PoisonedRuntimeCache {
    fn load(&self, _block_hash: Hash32) -> ContractFuture<'_, Option<RuntimeContext>> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        let context = self.context.clone();
        Box::pin(async move { Ok(Some(context)) })
    }

    fn store(&self, _context: RuntimeContext) -> ContractFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }

    fn delete(&self, _block_hash: Hash32) -> ContractFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl FakeChainDatabase {
    fn new(state: Option<ExportedChainState>, failure: StoreFailure) -> Self {
        Self {
            snapshot: Mutex::new(ChainDatabaseSnapshot::new(0, state)),
            failure,
        }
    }

    fn snapshot(&self) -> ChainDatabaseSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|_| panic!("fake chain store poisoned"))
            .clone()
    }

    fn replace_snapshot(&self, snapshot: ChainDatabaseSnapshot) {
        *self
            .snapshot
            .lock()
            .unwrap_or_else(|_| panic!("fake chain store poisoned")) = snapshot;
    }
}

#[derive(Clone, Copy)]
enum StoreFailure {
    None,
    BeforeWrite,
    AfterWrite,
    ConcurrentReplacement,
}

impl ChainDatabaseStore for FakeChainDatabase {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        let result = self
            .snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| {
                ContractError::new(ContractErrorCode::Internal, "fake chain store poisoned")
            });
        Box::pin(async move { result })
    }

    fn compare_and_swap(
        &self,
        expected_revision: u64,
        state: Option<ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot> {
        let result = self.snapshot.lock().map_err(|_| {
            ContractError::new(ContractErrorCode::Internal, "fake chain store poisoned")
        });
        let result = result.and_then(|mut snapshot| {
            if matches!(self.failure, StoreFailure::BeforeWrite) {
                return Err(ContractError::new(
                    ContractErrorCode::Internal,
                    "injected store failure before write",
                ));
            }
            if matches!(self.failure, StoreFailure::ConcurrentReplacement) {
                let candidate = state.as_ref().unwrap_or_else(|| {
                    panic!("concurrent replacement fixture requires an imported state")
                });
                let replacement = ExportedChainState::try_new(
                    candidate.identity().clone(),
                    candidate.format_version(),
                    FinalizedBlockRef::from_parts(
                        Hash32::from_bytes([0x77; 32]),
                        candidate.finalized().number(),
                    ),
                    vec![0x77],
                )
                .unwrap_or_else(|error| panic!("replacement state fixture failed: {error}"));
                *snapshot = ChainDatabaseSnapshot::new(expected_revision + 1, Some(replacement));
            }
            if snapshot.revision() == expected_revision {
                *snapshot = ChainDatabaseSnapshot::new(expected_revision + 1, state);
            }
            if matches!(self.failure, StoreFailure::AfterWrite) {
                Err(ContractError::new(
                    ContractErrorCode::Internal,
                    "injected store failure after write",
                ))
            } else {
                Ok(snapshot.clone())
            }
        });
        Box::pin(async move { result })
    }
}

impl VerifiedChainClient for FakeClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        Box::pin(async { Ok(ChainIdentity::citizenchain()) })
    }

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        Box::pin(async move { Ok(self.block) })
    }

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        Box::pin(async move { self.block.require_finalized() })
    }

    fn get_storage_at(
        &self,
        _block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        self.evidence_reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok((key.as_slice() == SYSTEM_EVENTS_STORAGE_KEY)
                .then(|| self.events.clone())
                .flatten())
        })
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
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        self.evidence_reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(self.context.clone()) })
    }

    fn get_block_extrinsics_at(
        &self,
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, Vec<Vec<u8>>> {
        self.evidence_reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(self.extrinsics.clone()) })
    }

    fn submit_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractFuture<'_, SubmittedExtrinsic> {
        Box::pin(async { Ok(SubmittedExtrinsic::new(Hash32::from_bytes([1; 32]))) })
    }

    fn watch_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractStream<'_, ExtrinsicWatchEvent> {
        Box::pin(futures::stream::empty())
    }

    fn export_state(&self) -> ContractFuture<'_, ExportedChainState> {
        self.exports.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            ExportedChainState::try_new(
                ChainIdentity::citizenchain(),
                CHAIN_STATE_FORMAT_VERSION,
                self.block.require_finalized()?,
                vec![1],
            )
        })
    }

    fn import_state(&self, state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        self.imports.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if self.import_fails {
                Err(ContractError::new(
                    ContractErrorCode::Internal,
                    "injected import failure",
                ))
            } else {
                Ok(StateImportReceipt::new(state.finalized()))
            }
        })
    }
}

#[derive(Clone)]
struct FakeCounters {
    imports: Arc<AtomicUsize>,
    evidence_reads: Arc<AtomicUsize>,
    exports: Arc<AtomicUsize>,
    runtime_cache_loads: Arc<AtomicUsize>,
    chain_database: Arc<FakeChainDatabase>,
}

fn all_ready() -> Vec<CapabilityProbe> {
    CapabilityName::ALL
        .into_iter()
        .map(CapabilityProbe::ready)
        .collect()
}

fn engine(
    events: Option<Vec<u8>>,
) -> (CitizenEngine, RuntimeContext, SignedExtrinsic, FakeCounters) {
    engine_with_options(events, false, None, StoreFailure::None)
}

fn engine_with_import_failure(
    events: Option<Vec<u8>>,
    import_fails: bool,
) -> (CitizenEngine, RuntimeContext, SignedExtrinsic, FakeCounters) {
    engine_with_options(events, import_fails, None, StoreFailure::None)
}

fn engine_with_options(
    events: Option<Vec<u8>>,
    import_fails: bool,
    stored_state: Option<ExportedChainState>,
    store_failure: StoreFailure,
) -> (CitizenEngine, RuntimeContext, SignedExtrinsic, FakeCounters) {
    engine_with_options_and_runtime_cache(events, import_fails, stored_state, store_failure, None)
}

fn engine_with_options_and_runtime_cache(
    events: Option<Vec<u8>>,
    import_fails: bool,
    stored_state: Option<ExportedChainState>,
    store_failure: StoreFailure,
    poisoned_runtime_metadata: Option<Vec<u8>>,
) -> (CitizenEngine, RuntimeContext, SignedExtrinsic, FakeCounters) {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 100);
    let context =
        match RuntimeContext::try_new(block, RuntimeVersion::new(100, 12), hex_bytes(METADATA_HEX))
        {
            Ok(context) => context,
            Err(error) => panic!("runtime fixture failed: {error}"),
        };
    let signed = match SignedExtrinsic::try_new(vec![0x0c, 0x84, 0x01, 0x02]) {
        Ok(extrinsic) => extrinsic,
        Err(error) => panic!("extrinsic fixture failed: {error}"),
    };
    let imports = Arc::new(AtomicUsize::new(0));
    let evidence_reads = Arc::new(AtomicUsize::new(0));
    let exports = Arc::new(AtomicUsize::new(0));
    let runtime_cache_loads = Arc::new(AtomicUsize::new(0));
    let client = Arc::new(FakeClient {
        block,
        context: context.clone(),
        extrinsics: vec![signed.as_bytes().to_vec()],
        events,
        imports: Arc::clone(&imports),
        evidence_reads: Arc::clone(&evidence_reads),
        exports: Arc::clone(&exports),
        import_fails,
    });
    let chain_database = Arc::new(FakeChainDatabase::new(stored_state, store_failure));
    let runtime_cache: Option<Arc<dyn RuntimeCacheStore>> =
        poisoned_runtime_metadata.map(|metadata| {
            let poisoned = RuntimeContext::try_new(block, context.version(), metadata)
                .unwrap_or_else(|error| panic!("poisoned runtime cache fixture failed: {error}"));
            let store: Arc<dyn RuntimeCacheStore> = Arc::new(PoisonedRuntimeCache {
                context: poisoned,
                loads: Arc::clone(&runtime_cache_loads),
            });
            store
        });
    let components = EngineComponents::new(
        Some(client),
        None,
        None,
        Some(Arc::clone(&chain_database) as Arc<dyn ChainDatabaseStore>),
        runtime_cache,
        None,
        None,
        None,
    )
    .with_modules(
        citizen_sdk_contracts::Modules::try_new(
            citizen_sdk_contracts::Modules::CHAIN
                | if cfg!(feature = "transactions") {
                    citizen_sdk_contracts::Modules::TRANSACTIONS
                } else {
                    0
                },
        )
        .unwrap_or_else(|error| panic!("chain fixture module selection: {error}")),
    );
    let engine = CitizenEngine::new(components);
    if let Err(error) = engine.update_capabilities(all_ready()) {
        panic!("capability initialization failed: {error}");
    }
    (
        engine,
        context,
        signed,
        FakeCounters {
            imports,
            evidence_reads,
            exports,
            runtime_cache_loads,
            chain_database,
        },
    )
}

fn running_engine(
    events: Option<Vec<u8>>,
) -> (CitizenEngine, RuntimeContext, SignedExtrinsic, FakeCounters) {
    let result = engine(events);
    start_engine(&result.0);
    result
}

fn start_engine(engine: &CitizenEngine) {
    if let Err(error) = engine.begin_provider_start() {
        panic!("provider start reservation failed: {error}");
    }
    if let Err(error) = futures::executor::block_on(engine.complete_provider_start()) {
        panic!("provider startup verification failed: {error}");
    }
}

#[test]
#[cfg(feature = "transactions")]
fn engine_gathers_provider_evidence_without_arbitrary_rpc() {
    let (engine, context, signed, _) = running_engine(Some(hex_bytes(EVENTS_HEX)));
    let hash = match signed_extrinsic_hash(&context, &signed) {
        Ok(hash) => hash,
        Err(error) => panic!("hash failed: {error}"),
    };
    let outcome = match futures::executor::block_on(engine.verify_transaction_at(
        context.block(),
        signed,
        hash,
    )) {
        Ok(outcome) => outcome,
        Err(error) => panic!("engine verification failed: {error}"),
    };
    assert!(
        matches!(outcome, ExecutionConclusion::Success { .. }),
        "expected provider evidence to prove success, got {outcome:?}"
    );
}

#[test]
#[cfg(feature = "transactions")]
fn persistent_runtime_cache_is_never_transaction_execution_evidence() {
    let (engine, context, signed, counters) = engine_with_options_and_runtime_cache(
        Some(hex_bytes(EVENTS_HEX)),
        false,
        None,
        StoreFailure::None,
        Some(vec![0xff]),
    );
    start_engine(&engine);
    let hash = signed_extrinsic_hash(&context, &signed)
        .unwrap_or_else(|error| panic!("hash failed: {error}"));
    let outcome =
        futures::executor::block_on(engine.verify_transaction_at(context.block(), signed, hash))
            .unwrap_or_else(|error| panic!("engine verification failed: {error}"));

    assert!(
        matches!(outcome, ExecutionConclusion::Success { .. }),
        "expected live provider evidence to prove success, got {outcome:?}"
    );
    assert_eq!(
        counters.runtime_cache_loads.load(Ordering::SeqCst),
        0,
        "持久 runtime cache 不得参与交易执行证据解释"
    );
}

#[test]
#[cfg(feature = "transactions")]
fn caller_finality_label_cannot_forge_the_provider_finalized_head() {
    let (engine, context, signed, counters) = running_engine(Some(hex_bytes(EVENTS_HEX)));
    let hash = match signed_extrinsic_hash(&context, &signed) {
        Ok(hash) => hash,
        Err(error) => panic!("hash failed: {error}"),
    };
    let forged = VerifiedBlockRef::finalized(Hash32::from_bytes([0x55; 32]), 100);
    let reads_before = counters.evidence_reads.load(Ordering::SeqCst);
    let outcome =
        match futures::executor::block_on(engine.verify_transaction_at(forged, signed, hash)) {
            Ok(outcome) => outcome,
            Err(error) => panic!("forged finality must fail closed, not error: {error}"),
        };
    assert!(matches!(
        outcome,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::TargetBlockUnavailable,
            ..
        }
    ));
    assert_eq!(
        counters.evidence_reads.load(Ordering::SeqCst),
        reads_before,
        "伪造的 finalized 输入不能触发 Runtime/body/events 读取"
    );
}

#[test]
#[cfg(feature = "transactions")]
fn capability_change_is_rechecked_before_provider_evidence() {
    let (engine, context, signed, counters) = running_engine(Some(hex_bytes(EVENTS_HEX)));
    let mut unavailable = all_ready();
    let chain = unavailable
        .iter_mut()
        .find(|probe| probe.name == CapabilityName::ChainRead)
        .unwrap_or_else(|| panic!("CHAIN_READ probe missing"));
    chain.runtime_ready = false;
    chain.not_ready_reason = Some(CapabilityReason::ChainUnsynced);
    if let Err(error) = engine.update_capabilities(unavailable) {
        panic!("capability update failed: {error}");
    }
    let hash = match signed_extrinsic_hash(&context, &signed) {
        Ok(hash) => hash,
        Err(error) => panic!("hash failed: {error}"),
    };
    let outcome = match futures::executor::block_on(engine.verify_transaction_at(
        context.block(),
        signed,
        hash,
    )) {
        Ok(outcome) => outcome,
        Err(error) => panic!("capability gate returned an unexpected error: {error}"),
    };
    assert!(matches!(
        outcome,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::ProviderFailure,
            ..
        }
    ));
    assert_eq!(counters.evidence_reads.load(Ordering::SeqCst), 0);
}

#[test]
#[cfg(feature = "transactions")]
fn missing_events_remain_unverified() {
    let (engine, context, signed, _) = running_engine(None);
    let hash = match signed_extrinsic_hash(&context, &signed) {
        Ok(hash) => hash,
        Err(error) => panic!("hash failed: {error}"),
    };
    let outcome = match futures::executor::block_on(engine.verify_transaction_at(
        context.block(),
        signed,
        hash,
    )) {
        Ok(outcome) => outcome,
        Err(error) => panic!("engine verification failed: {error}"),
    };
    assert!(matches!(
        outcome,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::SystemEventsUnavailable,
            ..
        }
    ));
}

#[test]
fn failed_import_preflight_never_reaches_provider() {
    let (engine, context, _, counters) = engine(None);
    let chain = identity(7);
    let state = match ExportedChainState::try_new(
        chain.clone(),
        CHAIN_STATE_FORMAT_VERSION,
        context
            .block()
            .require_finalized()
            .unwrap_or_else(|error| panic!("finalized fixture failed: {error}")),
        vec![1],
    ) {
        Ok(state) => state,
        Err(error) => panic!("state fixture failed: {error}"),
    };
    let result = futures::executor::block_on(engine.import_state(state));
    assert!(result.is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 0);
}

#[test]
fn engine_owns_import_startup_and_export_lifecycle() {
    let (engine, context, _, counters) = engine(None);
    let finalized = context
        .block()
        .require_finalized()
        .unwrap_or_else(|error| panic!("finalized fixture failed: {error}"));
    let imported = match ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        finalized,
        vec![1],
    ) {
        Ok(state) => state,
        Err(error) => panic!("state fixture failed: {error}"),
    };
    if let Err(error) = futures::executor::block_on(engine.import_state(imported.clone())) {
        panic!("valid pre-start import failed: {error}");
    }
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));

    if let Err(error) = engine.begin_provider_start() {
        panic!("provider start reservation failed: {error}");
    }
    assert!(futures::executor::block_on(engine.import_state(imported)).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    let started = match futures::executor::block_on(engine.complete_provider_start()) {
        Ok(finalized) => finalized,
        Err(error) => panic!("provider startup verification failed: {error}"),
    };
    assert_eq!(started, finalized);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Running));

    let exported = match futures::executor::block_on(engine.export_state()) {
        Ok(state) => state,
        Err(error) => panic!("stable state export failed: {error}"),
    };
    assert_eq!(exported.finalized(), finalized);
    assert_eq!(counters.exports.load(Ordering::SeqCst), 1);
}

#[test]
fn empty_chain_database_restore_is_a_pre_start_noop() {
    let (engine, _, _, counters) = engine(None);

    let restored = futures::executor::block_on(engine.restore_state_from_store())
        .unwrap_or_else(|error| panic!("empty restore failed: {error}"));

    assert!(restored.is_none());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 0);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));
    assert_eq!(
        counters.chain_database.snapshot(),
        ChainDatabaseSnapshot::new(0, None)
    );
}

#[test]
fn stored_chain_database_is_restored_and_revision_committed_before_start() {
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 100);
    let stored = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        finalized,
        vec![0x51, 0x52],
    )
    .unwrap_or_else(|error| panic!("stored state fixture failed: {error}"));
    let (engine, _, _, counters) =
        engine_with_options(None, false, Some(stored.clone()), StoreFailure::None);

    let receipt = futures::executor::block_on(engine.restore_state_from_store())
        .unwrap_or_else(|error| panic!("stored restore failed: {error}"))
        .unwrap_or_else(|| panic!("non-empty store unexpectedly restored nothing"));

    assert_eq!(receipt.finalized(), finalized);
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));
    assert_eq!(
        counters.chain_database.snapshot(),
        ChainDatabaseSnapshot::new(1, Some(stored))
    );

    start_engine(&engine);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Running));
}

#[test]
fn corrupt_persisted_chain_state_is_rejected_before_provider_import() {
    let corrupt = ExportedChainState::try_new(
        identity(0x44),
        CHAIN_STATE_FORMAT_VERSION,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 100),
        vec![1],
    )
    .unwrap_or_else(|error| panic!("corrupt state fixture failed: {error}"));
    let (engine, _, _, counters) =
        engine_with_options(None, false, Some(corrupt), StoreFailure::None);

    assert!(futures::executor::block_on(engine.restore_state_from_store()).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 0);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));
}

#[test]
fn restore_cas_conflict_after_provider_import_is_one_way_start_failed() {
    let stored = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 100),
        vec![0x51],
    )
    .unwrap_or_else(|error| panic!("stored state fixture failed: {error}"));
    let (engine, _, _, counters) = engine_with_options(
        None,
        false,
        Some(stored),
        StoreFailure::ConcurrentReplacement,
    );

    assert!(futures::executor::block_on(engine.restore_state_from_store()).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::StartFailed));
    assert!(engine.begin_provider_start().is_err());
}

#[test]
fn restore_rejects_finalized_rollback_against_provisional_import() {
    let (engine, context, _, counters) = engine(None);
    let newer = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([0x10; 32]), 101),
        vec![0x10],
    )
    .unwrap_or_else(|error| panic!("newer state fixture failed: {error}"));
    futures::executor::block_on(engine.import_state(newer))
        .unwrap_or_else(|error| panic!("provisional import failed: {error}"));

    let older = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        context
            .block()
            .require_finalized()
            .unwrap_or_else(|error| panic!("finalized fixture failed: {error}")),
        vec![0x09],
    )
    .unwrap_or_else(|error| panic!("older state fixture failed: {error}"));
    counters
        .chain_database
        .replace_snapshot(ChainDatabaseSnapshot::new(2, Some(older)));

    assert!(futures::executor::block_on(engine.restore_state_from_store()).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));
}

#[test]
fn persistent_export_commits_the_exact_revisioned_snapshot() {
    let (engine, context, _, counters) = running_engine(None);

    let exported = futures::executor::block_on(engine.export_and_persist_state())
        .unwrap_or_else(|error| panic!("persistent export failed: {error}"));

    assert_eq!(
        exported.finalized(),
        context
            .block()
            .require_finalized()
            .unwrap_or_else(|error| panic!("finalized fixture failed: {error}"))
    );
    assert_eq!(counters.exports.load(Ordering::SeqCst), 1);
    assert_eq!(
        counters.chain_database.snapshot(),
        ChainDatabaseSnapshot::new(1, Some(exported))
    );
}

#[test]
fn persistent_export_converges_only_the_exact_write_after_error() {
    let (converging, _, _, converging_counters) =
        engine_with_options(None, false, None, StoreFailure::AfterWrite);
    start_engine(&converging);
    let exported = futures::executor::block_on(converging.export_and_persist_state())
        .unwrap_or_else(|error| panic!("durable write-after-error must converge: {error}"));
    assert_eq!(
        converging_counters.chain_database.snapshot(),
        ChainDatabaseSnapshot::new(1, Some(exported))
    );

    let (competing, _, _, competing_counters) =
        engine_with_options(None, false, None, StoreFailure::ConcurrentReplacement);
    start_engine(&competing);
    assert!(futures::executor::block_on(competing.export_and_persist_state()).is_err());
    assert_eq!(competing_counters.exports.load(Ordering::SeqCst), 1);
    assert_eq!(competing.lifecycle(), Ok(EngineLifecycle::Running));
    let replacement = competing_counters.chain_database.snapshot();
    assert_eq!(replacement.revision(), 1);
    assert_eq!(
        replacement
            .state()
            .unwrap_or_else(|| panic!("competing state missing"))
            .finalized()
            .hash(),
        Hash32::from_bytes([0x77; 32])
    );
}

#[test]
fn provider_stop_cannot_overtake_persistent_export_reservation() {
    let (engine, _, _, counters) = running_engine(None);

    let pending_export = engine.export_and_persist_state();
    assert!(engine.mark_provider_stopped().is_err());
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Running));
    assert_eq!(
        counters.chain_database.snapshot(),
        ChainDatabaseSnapshot::new(0, None)
    );
    drop(pending_export);

    let exported = futures::executor::block_on(engine.export_and_persist_state())
        .unwrap_or_else(|error| panic!("persistent export failed: {error}"));
    assert_eq!(
        counters.chain_database.snapshot(),
        ChainDatabaseSnapshot::new(1, Some(exported))
    );
    engine
        .mark_provider_stopped()
        .unwrap_or_else(|error| panic!("provider stop after persistence failed: {error}"));
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Stopped));
}

#[test]
fn provider_import_failure_cannot_reopen_the_same_engine() {
    let (engine, context, _, counters) = engine_with_import_failure(None, true);
    let finalized = context
        .block()
        .require_finalized()
        .unwrap_or_else(|error| panic!("finalized fixture failed: {error}"));
    let imported = match ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        finalized,
        vec![1],
    ) {
        Ok(state) => state,
        Err(error) => panic!("state fixture failed: {error}"),
    };
    assert!(futures::executor::block_on(engine.import_state(imported)).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::StartFailed));
    assert!(engine.begin_provider_start().is_err());
}

#[test]
fn rebuilt_engine_rejects_state_older_than_persisted_finalized_anchor() {
    let stored_finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([10; 32]), 101);
    let stored = match ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        stored_finalized,
        vec![2],
    ) {
        Ok(state) => state,
        Err(error) => panic!("stored state fixture failed: {error}"),
    };
    let (engine, context, _, counters) =
        engine_with_options(None, false, Some(stored), StoreFailure::None);
    let older = match ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        context
            .block()
            .require_finalized()
            .unwrap_or_else(|error| panic!("finalized fixture failed: {error}")),
        vec![1],
    ) {
        Ok(state) => state,
        Err(error) => panic!("import fixture failed: {error}"),
    };

    assert!(futures::executor::block_on(engine.import_state(older)).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 0);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));
}

#[test]
fn rebuilt_engine_rejects_same_height_persisted_finality_conflict() {
    let stored = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([8; 32]), 100),
        vec![2],
    )
    .unwrap_or_else(|error| panic!("stored state fixture failed: {error}"));
    let (engine, context, _, counters) =
        engine_with_options(None, false, Some(stored), StoreFailure::None);
    let conflicting = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        context
            .block()
            .require_finalized()
            .unwrap_or_else(|error| panic!("finalized fixture failed: {error}")),
        vec![1],
    )
    .unwrap_or_else(|error| panic!("import fixture failed: {error}"));

    assert!(futures::executor::block_on(engine.import_state(conflicting)).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 0);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Created));
}

#[test]
fn chain_database_write_after_error_converges_but_missing_write_closes_engine() {
    let (converging, context, _, converging_counters) =
        engine_with_options(None, false, None, StoreFailure::AfterWrite);
    let imported = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        context
            .block()
            .require_finalized()
            .unwrap_or_else(|error| panic!("finalized fixture failed: {error}")),
        vec![1],
    )
    .unwrap_or_else(|error| panic!("import fixture failed: {error}"));
    assert!(futures::executor::block_on(converging.import_state(imported.clone())).is_ok());
    assert_eq!(converging_counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(converging.lifecycle(), Ok(EngineLifecycle::Created));

    let (failing, _, _, failing_counters) =
        engine_with_options(None, false, None, StoreFailure::BeforeWrite);
    assert!(futures::executor::block_on(failing.import_state(imported)).is_err());
    assert_eq!(failing_counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(failing.lifecycle(), Ok(EngineLifecycle::StartFailed));
    assert!(failing.begin_provider_start().is_err());
}

#[test]
fn chain_database_cas_detects_replacement_even_when_loaded_state_matches_import() {
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 100);
    let imported = ExportedChainState::try_new(
        ChainIdentity::citizenchain(),
        CHAIN_STATE_FORMAT_VERSION,
        finalized,
        vec![1],
    )
    .unwrap_or_else(|error| panic!("import fixture failed: {error}"));
    let (engine, _, _, counters) = engine_with_options(
        None,
        false,
        Some(imported.clone()),
        StoreFailure::ConcurrentReplacement,
    );

    assert!(futures::executor::block_on(engine.import_state(imported)).is_err());
    assert_eq!(counters.imports.load(Ordering::SeqCst), 1);
    assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::StartFailed));
    assert!(engine.begin_provider_start().is_err());
}

#[test]
fn lifecycle_closes_chain_capabilities_before_start_and_after_stop() {
    let (engine, context, signed, counters) = engine(Some(hex_bytes(EVENTS_HEX)));
    let created = engine
        .capabilities()
        .unwrap_or_else(|error| panic!("capability read failed: {error}"))
        .unwrap_or_else(|| panic!("capability snapshot missing"));
    assert_eq!(created.revision(), 1);
    assert!(!created
        .status(CapabilityName::WalletProfile)
        .unwrap()
        .enabled());
    assert_eq!(
        created
            .status(CapabilityName::ChainRead)
            .and_then(|status| status.reason()),
        Some(CapabilityReason::EngineNotRunning)
    );
    assert_eq!(
        created
            .status(CapabilityName::WalletProfile)
            .and_then(|status| status.reason()),
        Some(if cfg!(feature = "wallet") {
            CapabilityReason::HostDisabled
        } else {
            CapabilityReason::BuildUnsupported
        })
    );

    start_engine(&engine);
    let running = engine
        .capabilities()
        .unwrap_or_else(|error| panic!("capability read failed: {error}"))
        .unwrap_or_else(|| panic!("capability snapshot missing"));
    assert_eq!(running.revision(), 2);
    assert!(running
        .status(CapabilityName::ChainRead)
        .is_some_and(|status| status.is_ready()));

    if let Err(error) = engine.mark_provider_stopped() {
        panic!("provider stop failed: {error}");
    }
    let stopped = engine
        .capabilities()
        .unwrap_or_else(|error| panic!("capability read failed: {error}"))
        .unwrap_or_else(|| panic!("capability snapshot missing"));
    assert_eq!(stopped.revision(), 3);
    assert_eq!(
        stopped
            .status(CapabilityName::ChainRead)
            .and_then(|status| status.reason()),
        Some(CapabilityReason::EngineNotRunning)
    );

    let hash = match signed_extrinsic_hash(&context, &signed) {
        Ok(hash) => hash,
        Err(error) => panic!("hash failed: {error}"),
    };
    let outcome =
        futures::executor::block_on(engine.verify_transaction_at(context.block(), signed, hash))
            .unwrap_or_else(|error| panic!("stopped capability gate failed: {error}"));
    assert!(matches!(
        outcome,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::ProviderFailure,
            ..
        }
    ));
    assert_eq!(counters.evidence_reads.load(Ordering::SeqCst), 0);
}

#[test]
fn concurrent_probe_updates_cannot_reopen_capabilities_after_stop() {
    // Repeat the boundary to exercise both scheduling orders. The production
    // lock order is state -> capabilities, so an update that overlaps stop
    // either publishes before stop or observes Stopped; it can never publish a
    // stale Running snapshot after the lifecycle transition completes.
    for _ in 0..64 {
        let (engine, _, _, _) = running_engine(None);
        let engine = Arc::new(engine);
        let barrier = Arc::new(Barrier::new(3));

        let updating_engine = Arc::clone(&engine);
        let updating_barrier = Arc::clone(&barrier);
        let updater = std::thread::spawn(move || {
            updating_barrier.wait();
            updating_engine.update_capabilities(all_ready())
        });

        let stopping_engine = Arc::clone(&engine);
        let stopping_barrier = Arc::clone(&barrier);
        let stopper = std::thread::spawn(move || {
            stopping_barrier.wait();
            stopping_engine.mark_provider_stopped()
        });

        barrier.wait();
        updater
            .join()
            .unwrap_or_else(|_| panic!("capability updater thread panicked"))
            .unwrap_or_else(|error| panic!("capability update failed: {error}"));
        stopper
            .join()
            .unwrap_or_else(|_| panic!("provider stopper thread panicked"))
            .unwrap_or_else(|error| panic!("provider stop failed: {error}"));

        let stopped = engine
            .capabilities()
            .unwrap_or_else(|error| panic!("capability read failed: {error}"))
            .unwrap_or_else(|| panic!("capability snapshot missing"));
        assert_eq!(engine.lifecycle(), Ok(EngineLifecycle::Stopped));
        assert_eq!(
            stopped
                .status(CapabilityName::ChainRead)
                .and_then(|status| status.reason()),
            Some(CapabilityReason::EngineNotRunning)
        );
    }
}
