#![cfg(feature = "chain")]

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use citizen_sdk_contracts::{
    CapabilityName, ChainIdentity, ChainSigner, ChainSyncStatus, ContractError, ContractErrorCode, ContractFuture,
    ContractStream, ExportedChainState, ExtrinsicWatchEvent, FinalizedBlockRef, Hash32, Modules,
    RuntimeContext, SignedExtrinsic, StateImportReceipt, SubmittedExtrinsic, VerifiedBlockRef,
    VerifiedChainClient,
};
use citizen_sdk_engine::{CapabilityProbe, CitizenEngine, EngineComponents, EngineError};

struct CountingClient {
    reads: AtomicUsize,
    submits: AtomicUsize,
    watches: AtomicUsize,
    block: FinalizedBlockRef,
    best_error: Option<ContractErrorCode>,
    sync_ready: std::sync::atomic::AtomicBool,
}

impl CountingClient {
    fn new() -> Self {
        Self {
            reads: AtomicUsize::new(0),
            submits: AtomicUsize::new(0),
            watches: AtomicUsize::new(0),
            block: FinalizedBlockRef::from_parts(Hash32::from_bytes([0x31; 32]), 31),
            best_error: None,
            sync_ready: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn failing_best(code: ContractErrorCode) -> Self {
        Self {
            best_error: Some(code),
            ..Self::new()
        }
    }
}

impl VerifiedChainClient for CountingClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        Box::pin(async { Ok(ChainIdentity::citizenchain()) })
    }

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let error = self.best_error;
        Box::pin(async move {
            if let Some(code) = error {
                Err(ContractError::new(code, "typed best-head failure"))
            } else {
                Ok(self.block.into())
            }
        })
    }

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(self.block) })
    }

    fn get_sync_status(&self) -> ContractFuture<'_, ChainSyncStatus> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let usable = self.sync_ready.load(Ordering::SeqCst);
        Box::pin(async move {
            ChainSyncStatus::try_new(0, !usable, usable,
                VerifiedBlockRef::best(self.block.hash(), self.block.number()), self.block)
        })
    }

    fn get_storage_at(
        &self,
        _block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(Some(key)) })
    }

    fn get_storage_batch_at(
        &self,
        _block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(keys.into_iter().map(Some).collect()) })
    }

    fn get_runtime_context_at(
        &self,
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "not used by this test",
            ))
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
        self.submits.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(SubmittedExtrinsic::new(Hash32::from_bytes([0x44; 32]))) })
    }

    fn watch_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractStream<'_, ExtrinsicWatchEvent> {
        self.watches.fetch_add(1, Ordering::SeqCst);
        Box::pin(futures::stream::iter([Ok(ExtrinsicWatchEvent::Ready)]))
    }

    fn export_state(&self) -> ContractFuture<'_, ExportedChainState> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "not used by this test",
            ))
        })
    }

    fn import_state(&self, _state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "not used by this test",
            ))
        })
    }
}

#[test]
fn syncing_status_is_readable_without_opening_business_data_gates() {
    let client = Arc::new(CountingClient::new());
    let engine = engine(client.clone());
    assert!(futures::executor::block_on(engine.chain_sync_status()).is_err());
    engine.update_chain_readiness(false).unwrap_or_else(|e| panic!("{e}"));
    engine.begin_provider_start().unwrap_or_else(|e| panic!("{e}"));
    assert!(futures::executor::block_on(engine.chain_sync_status()).is_err());
    futures::executor::block_on(engine.complete_provider_start()).unwrap_or_else(|e| panic!("{e}"));
    let status = futures::executor::block_on(engine.chain_sync_status()).unwrap_or_else(|e| panic!("{e}"));
    assert!(!status.is_usable());
    assert!(status.is_syncing());
    assert!(futures::executor::block_on(engine.finalized_head()).is_err(),
        "读取同步状态不能放开链业务数据门禁");
    client.sync_ready.store(true, Ordering::SeqCst);
    engine.update_chain_readiness(true).unwrap_or_else(|e| panic!("{e}"));
    assert!(futures::executor::block_on(engine.chain_sync_status()).unwrap_or_else(|e| panic!("{e}")).is_usable());
    assert!(futures::executor::block_on(engine.finalized_head()).is_ok());
    engine.mark_provider_stopped().unwrap_or_else(|e| panic!("{e}"));
    assert!(futures::executor::block_on(engine.chain_sync_status()).is_err());
    engine.dispose().unwrap_or_else(|e| panic!("{e}"));
    assert!(futures::executor::block_on(engine.chain_sync_status()).is_err());
}

#[test]
fn sync_status_still_rejects_disabled_or_unavailable_chain() {
    for field in ["supported", "available", "enabled"] {
        let client = Arc::new(CountingClient::new());
        let engine = engine(client.clone());
        let mut facts = probes();
        let probe = facts.iter_mut().find(|p| p.name == CapabilityName::ChainRead)
            .unwrap_or_else(|| panic!("missing chain probe"));
        match field {
            "supported" => probe.supported = false,
            "available" => probe.available = false,
            _ => probe.enabled = false,
        }
        engine.update_capabilities(facts).unwrap_or_else(|e| panic!("{e}"));
        engine.begin_provider_start().unwrap_or_else(|e| panic!("{e}"));
        futures::executor::block_on(engine.complete_provider_start()).unwrap_or_else(|e| panic!("{e}"));
        let before = client.reads.load(Ordering::SeqCst);
        assert!(futures::executor::block_on(engine.chain_sync_status()).is_err());
        assert_eq!(client.reads.load(Ordering::SeqCst), before);
    }
}

#[test]
fn genesis_hash_is_static_but_still_obeys_module_and_dispose_gates() {
    let client = Arc::new(CountingClient::new());
    let engine = engine(client.clone());
    assert_eq!(
        engine
            .genesis_hash()
            .unwrap_or_else(|error| panic!("genesis failed: {error}")),
        ChainIdentity::citizenchain().genesis_hash()
    );
    assert_eq!(client.reads.load(Ordering::SeqCst), 0);
    engine
        .dispose()
        .unwrap_or_else(|error| panic!("dispose failed: {error}"));
    assert!(engine.genesis_hash().is_err());

    let local = CitizenEngine::new(
        EngineComponents::new(None, None, None, None, None, None, None, None).with_modules(
            Modules::try_new(Modules::WALLET)
                .unwrap_or_else(|error| panic!("modules failed: {error}")),
        ),
    );
    assert!(
        matches!(local.genesis_hash(), Err(EngineError::Contract(error)) if error.code() == ContractErrorCode::Unsupported)
    );
}

#[test]
fn empty_balance_batch_requires_running_chain_and_never_reads_provider() {
    let client = Arc::new(CountingClient::new());
    let engine = engine(client.clone());
    assert!(futures::executor::block_on(engine.finalized_account_balances(Vec::new())).is_err());
    assert_eq!(client.reads.load(Ordering::SeqCst), 0);
    engine
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("start failed: {error}"));
    futures::executor::block_on(engine.complete_provider_start())
        .unwrap_or_else(|error| panic!("complete start failed: {error}"));
    let before = client.reads.load(Ordering::SeqCst);
    assert!(
        futures::executor::block_on(engine.finalized_account_balances(Vec::new()))
            .unwrap_or_else(|error| panic!("empty batch failed: {error}"))
            .is_empty()
    );
    assert_eq!(client.reads.load(Ordering::SeqCst), before);
    engine
        .mark_provider_stopped()
        .unwrap_or_else(|error| panic!("stop failed: {error}"));
    assert!(futures::executor::block_on(engine.finalized_account_balances(Vec::new())).is_err());
    assert_eq!(client.reads.load(Ordering::SeqCst), before);
    engine
        .dispose()
        .unwrap_or_else(|error| panic!("dispose failed: {error}"));
    assert!(futures::executor::block_on(engine.finalized_account_balances(Vec::new())).is_err());
}

#[test]
fn chain_readiness_refresh_preserves_local_facts_and_cannot_open_a_stopped_engine() {
    let client = Arc::new(CountingClient::new());
    let engine = engine(client);
    let before = engine
        .capabilities()
        .unwrap_or_else(|error| panic!("snapshot failed: {error}"))
        .unwrap_or_else(|| panic!("snapshot missing"));
    engine
        .update_chain_readiness(false)
        .unwrap_or_else(|error| panic!("chain update failed: {error}"));
    engine
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("start failed: {error}"));
    futures::executor::block_on(engine.complete_provider_start())
        .unwrap_or_else(|error| panic!("complete start failed: {error}"));
    assert!(futures::executor::block_on(engine.finalized_account_balances(Vec::new())).is_err());
    let ready = engine
        .update_chain_readiness(true)
        .unwrap_or_else(|error| panic!("chain update failed: {error}"));
    assert!(ready
        .status(CapabilityName::ChainRead)
        .is_some_and(|status| status.is_ready()));
    for name in [
        CapabilityName::WalletProfile,
        CapabilityName::LocalSigning,
        CapabilityName::HardwareVault,
        CapabilityName::UserAuthentication,
    ] {
        assert_eq!(ready.status(name), before.status(name));
    }
    engine
        .mark_provider_stopped()
        .unwrap_or_else(|error| panic!("stop failed: {error}"));
    let stopped = engine
        .update_chain_readiness(true)
        .unwrap_or_else(|error| panic!("chain update failed: {error}"));
    assert!(!stopped
        .status(CapabilityName::ChainRead)
        .is_some_and(|status| status.is_ready()));
    assert!(engine.genesis_hash().is_ok());
}

#[test]
fn provider_contract_error_code_survives_the_engine_boundary() {
    let client = Arc::new(CountingClient::failing_best(ContractErrorCode::Timeout));
    let engine = engine(client);
    engine
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("begin start failed: {error}"));
    futures::executor::block_on(engine.complete_provider_start())
        .unwrap_or_else(|error| panic!("complete start failed: {error}"));

    let error = futures::executor::block_on(engine.best_head())
        .err()
        .unwrap_or_else(|| panic!("best head must fail"));
    match error {
        EngineError::Contract(error) => {
            assert_eq!(error.code(), ContractErrorCode::Timeout);
            assert_eq!(error.message(), "typed best-head failure");
        }
        other => panic!("unexpected Engine error: {other}"),
    }
}

fn probes() -> Vec<CapabilityProbe> {
    CapabilityName::ALL
        .into_iter()
        .map(|name| match name {
            CapabilityName::ChainRead
            | CapabilityName::TransactionSubmit
            | CapabilityName::TransactionVerify => CapabilityProbe::ready(name),
            _ => CapabilityProbe {
                name,
                supported: false,
                available: false,
                enabled: false,
                runtime_ready: false,
                not_ready_reason: None,
            },
        })
        .collect()
}

fn engine(client: Arc<CountingClient>) -> CitizenEngine {
    let chain: Arc<dyn VerifiedChainClient> = client;
    let engine = CitizenEngine::new(EngineComponents::new(
        Some(chain),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    ));
    engine
        .update_capabilities(probes())
        .unwrap_or_else(|error| panic!("capabilities failed: {error}"));
    engine
}

#[test]
fn typed_chain_access_is_closed_before_start_and_open_while_running() {
    let client = Arc::new(CountingClient::new());
    let engine = engine(Arc::clone(&client));

    assert!(futures::executor::block_on(engine.best_head()).is_err());
    assert_eq!(client.reads.load(Ordering::SeqCst), 0);

    engine
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("begin start failed: {error}"));
    futures::executor::block_on(engine.complete_provider_start())
        .unwrap_or_else(|error| panic!("complete start failed: {error}"));

    let best = futures::executor::block_on(engine.best_head())
        .unwrap_or_else(|error| panic!("best head failed: {error}"));
    let finalized = futures::executor::block_on(engine.finalized_head())
        .unwrap_or_else(|error| panic!("finalized head failed: {error}"));
    assert_eq!(best.number(), 31);
    assert_eq!(finalized.number(), 31);

    let values =
        futures::executor::block_on(engine.storage_batch_at(best, vec![vec![1], vec![2], vec![1]]))
            .unwrap_or_else(|error| panic!("batch storage failed: {error}"));
    assert_eq!(values, vec![Some(vec![1]), Some(vec![2]), Some(vec![1])]);

    #[cfg(feature = "transactions")]
    {
        let signed = SignedExtrinsic::try_new(vec![0x08, 0xaa])
            .unwrap_or_else(|error| panic!("extrinsic fixture failed: {error}"));
        let submitted = futures::executor::block_on(engine.submit_signed_extrinsic(signed.clone()))
            .unwrap_or_else(|error| panic!("submit failed: {error}"));
        assert_eq!(submitted.hash(), Hash32::from_bytes([0x44; 32]));

        let mut watch = engine
            .watch_signed_extrinsic(signed)
            .unwrap_or_else(|error| panic!("watch failed: {error}"));
        let event = futures::executor::block_on(futures::StreamExt::next(&mut watch));
        assert_eq!(event, Some(Ok(ExtrinsicWatchEvent::Ready)));
        assert_eq!(client.submits.load(Ordering::SeqCst), 1);
        assert_eq!(client.watches.load(Ordering::SeqCst), 1);
    }

    engine
        .mark_provider_stopped()
        .unwrap_or_else(|error| panic!("stop failed: {error}"));
    let reads_after_stop = client.reads.load(Ordering::SeqCst);
    assert!(futures::executor::block_on(engine.finalized_head()).is_err());
    assert_eq!(client.reads.load(Ordering::SeqCst), reads_after_stop);
}

#[test]
#[cfg(feature = "transactions")]
fn raw_broadcast_entries_cannot_bypass_generic_pending_before_broadcast() {
    let client = Arc::new(CountingClient::new());
    let chain: Arc<dyn VerifiedChainClient> = client.clone();
    let signer: Arc<dyn ChainSigner> = Arc::new(citizen_signer::Sr25519SoftwareSigner);
    let engine = CitizenEngine::new(EngineComponents::new(
        Some(chain),
        Some(signer),
        None,
        None,
        None,
        None,
        None,
        None,
    ));
    engine
        .update_capabilities(probes())
        .unwrap_or_else(|error| panic!("capabilities failed: {error}"));
    engine
        .begin_provider_start()
        .unwrap_or_else(|error| panic!("begin start failed: {error}"));
    futures::executor::block_on(engine.complete_provider_start())
        .unwrap_or_else(|error| panic!("complete start failed: {error}"));

    let signed = SignedExtrinsic::try_new(vec![0x08, 0xbb])
        .unwrap_or_else(|error| panic!("extrinsic fixture failed: {error}"));
    let error = match futures::executor::block_on(engine.submit_signed_extrinsic(signed.clone())) {
        Err(error) => error,
        Ok(_) => panic!("交易恢复栈不完整时原始提交必须在广播前关闭"),
    };
    assert!(matches!(error, EngineError::CapabilityUnavailable(_)));
    assert_eq!(client.submits.load(Ordering::SeqCst), 0);

    let watch_error = match engine.watch_signed_extrinsic(signed) {
        Err(error) => error,
        Ok(_) => panic!("组合交易恢复组件后原始 submit-and-watch 必须在广播前关闭"),
    };
    assert!(matches!(
        watch_error,
        EngineError::Contract(ref error) if error.code() == ContractErrorCode::InvalidState
    ));
    assert_eq!(client.watches.load(Ordering::SeqCst), 0);
}
