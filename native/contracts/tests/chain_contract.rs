//! VerifiedChainClient 的块语义、对象安全和同块 runtime 合同。

use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
};

use citizen_sdk_contracts::{
    BlockFinality, ChainIdentity, ContractFuture, ContractResult, ContractStream,
    ExportedChainState, ExtrinsicWatchEvent, FinalizedBlockRef, Hash32, RuntimeContext,
    RuntimeVersion, SignedExtrinsic, StateImportReceipt, SubmittedExtrinsic, VerifiedBlockRef,
    VerifiedChainClient, CITIZENCHAIN_CHAIN_ID, CITIZENCHAIN_GENESIS_HASH,
    CITIZENCHAIN_PROTOCOL_ID, MAX_RUNTIME_METADATA_BYTES,
};
use futures_core::Stream;

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

struct OneEvent(Option<ContractResult<ExtrinsicWatchEvent>>);

impl Stream for OneEvent {
    type Item = ContractResult<ExtrinsicWatchEvent>;

    fn poll_next(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(self.get_mut().0.take())
    }
}

fn identity() -> ContractResult<ChainIdentity> {
    ChainIdentity::try_new("citizenchain", "citizenchain", Hash32::from_bytes([1; 32]))
}

struct FakeChainClient;

impl VerifiedChainClient for FakeChainClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        Box::pin(async { identity() })
    }

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        Box::pin(async { Ok(VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 8)) })
    }

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        Box::pin(async {
            Ok(FinalizedBlockRef::from_parts(
                Hash32::from_bytes([3; 32]),
                7,
            ))
        })
    }

    fn get_storage_at(
        &self,
        _block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { Ok(Some(key)) })
    }

    fn get_storage_batch_at(
        &self,
        _block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        Box::pin(async move { Ok(keys.into_iter().map(Some).collect()) })
    }

    fn get_runtime_context_at(
        &self,
        block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        Box::pin(async move {
            RuntimeContext::try_new(
                block,
                RuntimeVersion::new(42, 9),
                vec![0x6d, 0x65, 0x74, 0x61],
            )
        })
    }

    fn get_block_extrinsics_at(
        &self,
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, Vec<Vec<u8>>> {
        Box::pin(async { Ok(vec![vec![0x04, 0x84]]) })
    }

    fn submit_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractFuture<'_, SubmittedExtrinsic> {
        Box::pin(async { Ok(SubmittedExtrinsic::new(Hash32::from_bytes([4; 32]))) })
    }

    fn watch_extrinsic(
        &self,
        _extrinsic: SignedExtrinsic,
    ) -> ContractStream<'_, ExtrinsicWatchEvent> {
        Box::pin(OneEvent(Some(Ok(ExtrinsicWatchEvent::InBlock {
            block: VerifiedBlockRef::best(Hash32::from_bytes([5; 32]), 9),
        }))))
    }

    fn export_state(&self) -> ContractFuture<'_, ExportedChainState> {
        Box::pin(async {
            ExportedChainState::try_new(
                identity()?,
                1,
                FinalizedBlockRef::from_parts(Hash32::from_bytes([3; 32]), 7),
                vec![7, 8, 9],
            )
        })
    }

    fn import_state(&self, state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        Box::pin(async move { Ok(StateImportReceipt::new(state.finalized())) })
    }
}

#[test]
fn finalized_only_type_rejects_best_blocks() {
    let best = VerifiedBlockRef::best(Hash32::from_bytes([8; 32]), 12);
    assert_eq!(best.finality(), BlockFinality::Best);
    assert!(best.require_finalized().is_err());

    let finalized = VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 11);
    let narrowed = value_or_panic(finalized.require_finalized());
    assert_eq!(narrowed.number(), 11);
    assert_eq!(narrowed.verified().finality(), BlockFinality::Finalized);
}

#[test]
fn citizenchain_identity_is_the_single_fixed_engine_policy() {
    let identity = ChainIdentity::citizenchain();
    assert_eq!(identity.chain_id(), CITIZENCHAIN_CHAIN_ID);
    assert_eq!(identity.protocol_id(), CITIZENCHAIN_PROTOCOL_ID);
    assert_eq!(identity.genesis_hash(), CITIZENCHAIN_GENESIS_HASH);
    assert_eq!(
        identity.genesis_hash().into_bytes(),
        [
            0x18, 0x84, 0x7a, 0x5d, 0xfd, 0x26, 0x32, 0x72, 0xf2, 0xe7, 0x72, 0x78, 0x36, 0xfe,
            0x65, 0x82, 0xf8, 0xc4, 0x46, 0x3f, 0xf4, 0x86, 0x09, 0xdf, 0x7b, 0x96, 0xd5, 0xe4,
            0xd9, 0xdd, 0x24, 0xdd,
        ]
    );
}

#[test]
fn runtime_context_keeps_version_metadata_and_exact_block_together() {
    let block = VerifiedBlockRef::best(Hash32::from_bytes([6; 32]), 31);
    let context = value_or_panic(RuntimeContext::try_new(
        block,
        RuntimeVersion::new(100, 12),
        vec![0x6d, 0x65, 0x74, 0x61],
    ));
    assert_eq!(context.block(), block);
    assert_eq!(context.version().spec_version(), 100);
    assert_eq!(context.version().transaction_version(), 12);
    assert_eq!(context.metadata(), b"meta");
    assert!(RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), Vec::new()).is_err());
}

#[test]
fn runtime_metadata_functional_limit_remains_sixty_four_mib() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([0x6a; 32]), 32);
    let context = value_or_panic(RuntimeContext::try_new(
        block,
        RuntimeVersion::new(101, 13),
        vec![0x6d; MAX_RUNTIME_METADATA_BYTES],
    ));
    assert_eq!(context.metadata().len(), 64 * 1024 * 1024);
    drop(context);

    let rejected = RuntimeContext::try_new(
        block,
        RuntimeVersion::new(101, 13),
        vec![0x6d; MAX_RUNTIME_METADATA_BYTES + 1],
    )
    .err()
    .unwrap_or_else(|| panic!("64 MiB + 1 metadata must be rejected"));
    assert_eq!(
        rejected.code(),
        citizen_sdk_contracts::ContractErrorCode::InvalidArgument
    );
}

#[test]
fn verified_client_is_object_safe_and_never_implies_submit_success() {
    let client: Box<dyn VerifiedChainClient> = Box::new(FakeChainClient);
    let best = value_or_panic(block_on(client.get_best_head()));
    let finalized = value_or_panic(block_on(client.get_finalized_head()));
    assert_eq!(best.number(), 8);
    assert_eq!(finalized.number(), 7);
    let by_number = value_or_panic(block_on(client.get_finalized_block_at(7)));
    assert_eq!(by_number, finalized);
    assert!(block_on(client.get_finalized_block_at(6)).is_err());
    assert!(block_on(client.get_finalized_block_at(8)).is_err());
    let singleton = value_or_panic(block_on(client.get_finalized_blocks_at(7, 7)));
    assert_eq!(singleton, vec![finalized]);
    assert!(block_on(client.get_finalized_blocks_at(8, 7)).is_err());
    assert!(block_on(client.get_finalized_blocks_at(0, 120)).is_err());
    let resolved = value_or_panic(block_on(
        client.resolve_finalized_block(finalized.hash(), finalized.number()),
    ));
    assert_eq!(resolved, finalized);
    assert!(block_on(client.resolve_finalized_block(Hash32::from_bytes([9; 32]), 7)).is_err());

    let context = value_or_panic(block_on(client.get_runtime_context_at(best)));
    assert_eq!(context.block(), best);

    let finalized_value = value_or_panic(block_on(
        client.get_finalized_storage_at(finalized, vec![0x26, 0xaa]),
    ));
    assert_eq!(finalized_value, Some(vec![0x26, 0xaa]));

    let signed = value_or_panic(SignedExtrinsic::try_new(vec![0x04, 0x84]));
    let submitted = value_or_panic(block_on(client.submit_extrinsic(signed)));
    assert_eq!(submitted.hash(), Hash32::from_bytes([4; 32]));

    let watched = value_or_panic(SignedExtrinsic::try_new(vec![0x04, 0x84]));
    let mut stream = client.watch_extrinsic(watched);
    let waker = Waker::noop();
    let mut poll_context = Context::from_waker(waker);
    let event = match stream.as_mut().poll_next(&mut poll_context) {
        Poll::Ready(Some(result)) => value_or_panic(result),
        other => panic!("watch 没有返回预期事件: {other:?}"),
    };
    assert!(matches!(event, ExtrinsicWatchEvent::InBlock { .. }));

    let exported = value_or_panic(block_on(client.export_state()));
    assert_eq!(exported.identity().chain_id(), "citizenchain");
    assert_eq!(exported.identity().protocol_id(), "citizenchain");
    assert_eq!(exported.finalized().number(), 7);
}
