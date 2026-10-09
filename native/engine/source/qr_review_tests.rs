//! 固定公开向量只用于回归；生产审阅仅接受 VerifiedChainClient 提供的 Runtime。
#![allow(clippy::unwrap_used)]

use citizen_sdk_contracts::{
    ChainIdentity, ContractErrorCode, FinalizedBlockRef, Hash32, RuntimeContext, RuntimeVersion,
    Sr25519PublicKey,
};
use citizen_sdk_qr::SignRequest;
use subxt_core::ext::codec::{Compact, Encode};

use crate::{
    error::EngineError,
    qr_review::{decode_review, QrReview},
};
use citizen_sdk_contracts::{
    ContractError, ContractFuture, ContractStream, ExportedChainState, ExtrinsicWatchEvent,
    SignedExtrinsic, StateImportReceipt, SubmittedExtrinsic, VerifiedBlockRef, VerifiedChainClient,
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

const METADATA: &str =
    include_str!("../../../test/transaction/citizenchain-runtime-v14-metadata.hex");
const VECTOR: &str = include_str!("../../../test/transaction/citizenchain-transfer-build-v1.json");

fn bytes(text: &str) -> Vec<u8> {
    let text = text.trim().trim_start_matches("0x");
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn fixture() -> (SignRequest, RuntimeContext, usize) {
    let vector: serde_json::Value = serde_json::from_str(VECTOR).unwrap();
    let request = SignRequest {
        request_id: "0123456789abcdef".to_owned(),
        expires_at: i64::MAX as u64,
        action: 0x0400,
        signer_public_key: Some(Sr25519PublicKey::from_bytes(
            bytes(vector["transfer"]["source_account_id"].as_str().unwrap())
                .try_into()
                .unwrap()),
        ),
        review_payload: bytes(vector["expected"]["signing_message"].as_str().unwrap()),
    };
    let finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x33; 32]), 77);
    let context = RuntimeContext::try_new(
        finalized.verified(),
        RuntimeVersion::new(0, 0),
        bytes(METADATA),
    )
    .unwrap();
    let call_len = bytes(vector["expected"]["call_data"].as_str().unwrap()).len();
    (request, context, call_len)
}

fn review(request: SignRequest, context: &RuntimeContext) -> Result<QrReview, EngineError> {
    decode_review(
        &ChainIdentity::citizenchain(),
        FinalizedBlockRef::from_parts(context.block().hash(), context.block().number()),
        context,
        request,
    )
}

fn code(result: Result<QrReview, EngineError>, expected: ContractErrorCode) {
    match result.unwrap_err() {
        EngineError::Contract(error) => assert_eq!(error.code(), expected),
        error => panic!("预期结构化错误，实际 {error}"),
    }
}

#[test]
fn complete_scale_payload_exposes_all_confirmed_facts_without_wallet() {
    let (request, context, _) = fixture();
    let reviewed = review(request.clone(), &context).unwrap();
    assert_eq!(reviewed.request(), &request);
    assert_eq!(reviewed.pallet_name(), "OnchainTransaction");
    assert_eq!(reviewed.call_name(), "transfer_with_remark");
    assert!(reviewed.call_arguments().contains("123456"));
    assert!(reviewed.call_arguments().contains("remark"));
    assert_eq!(
        reviewed.genesis_hash(),
        ChainIdentity::citizenchain().genesis_hash()
    );
    assert_eq!(reviewed.block_hash(), reviewed.genesis_hash());
    assert_eq!(reviewed.spec_version(), 0);
    assert_eq!(reviewed.transaction_version(), 0);
    assert_eq!(reviewed.era(), "immortal");
    assert_eq!(reviewed.nonce(), 7);
    assert_eq!(reviewed.tip(), 0);
}

#[test]
fn incomplete_trailing_action_and_huge_sequence_are_rejected() {
    let (original, context, call_len) = fixture();
    for length in [2, call_len, original.review_payload.len() - 1] {
        let mut request = original.clone();
        request.review_payload.truncate(length);
        code(review(request, &context), ContractErrorCode::Decode);
    }
    let mut request = original.clone();
    request.review_payload.push(0);
    code(review(request, &context), ContractErrorCode::Decode);
    let mut request = original.clone();
    request.review_payload[1] = 1;
    code(review(request, &context), ContractErrorCode::Decode);
    let mut request = original;
    request.review_payload.truncate(2 + 32 + 16);
    request.review_payload.extend(Compact(u32::MAX).encode());
    code(review(request, &context), ContractErrorCode::Decode);
}

#[test]
fn wrong_chain_runtime_and_checkpoint_never_become_a_review() {
    let (original, context, call_len) = fixture();
    // 现有向量：四个 extra 字节，再两个 u32 Runtime 版本，再 genesis/checkpoint。
    for offset in [call_len + 4, call_len + 8, call_len + 12, call_len + 44] {
        let mut request = original.clone();
        request.review_payload[offset] ^= 1;
        code(review(request, &context), ContractErrorCode::Integrity);
    }
    let newer = RuntimeContext::try_new(
        context.block(),
        RuntimeVersion::new(1, 0),
        context.metadata().to_vec(),
    )
    .unwrap();
    code(review(original, &newer), ContractErrorCode::Integrity);
}

#[test]
fn noncanonical_nonce_and_unknown_metadata_hash_mode_are_rejected() {
    let (original, context, call_len) = fixture();
    let mut request = original.clone();
    request
        .review_payload
        .splice(call_len + 1..call_len + 2, [0x1d, 0x00]);
    code(review(request, &context), ContractErrorCode::Decode);
    let mut request = original;
    request.review_payload[call_len + 3] = 1;
    code(review(request, &context), ContractErrorCode::Unsupported);
}

#[test]
fn confirmed_review_allows_head_progress_but_not_request_changes() {
    let (request, context, _) = fixture();
    let first = review(request.clone(), &context).unwrap();
    let next = RuntimeContext::try_new(
        FinalizedBlockRef::from_parts(Hash32::from_bytes([0x44; 32]), 78).verified(),
        context.version(),
        context.metadata().to_vec(),
    )
    .unwrap();
    assert!(first.matches(&review(request.clone(), &next).unwrap()));
    let mut changed = request;
    changed.request_id = "fedcba9876543210".to_owned();
    assert!(!first.matches(&review(changed, &next).unwrap()));
}

#[test]
fn scale_string_review_makes_bidi_and_invisible_controls_visible_without_changing_chinese() {
    use crate::qr_review::visible_review_text;
    use subxt_core::ext::scale_value::Value;
    let value = Value::string("真实金额\u{202e}123\u{2066}\u{200b}\u{feff}元");
    let rendered = visible_review_text(&format!("{value}"));
    assert!(rendered.contains("真实金额"));
    for escaped in ["\\u{202e}", "\\u{2066}", "\\u{200b}", "\\u{feff}"] {
        assert!(rendered.contains(escaped));
    }
    assert!(!rendered
        .chars()
        .any(|c| matches!(c, '\u{202e}' | '\u{2066}' | '\u{200b}' | '\u{feff}')));
    assert!(
        value.as_str().unwrap().contains('\u{202e}'),
        "展示转义不得改原值"
    );
}

struct ReviewClient {
    context: RuntimeContext,
    finalized: FinalizedBlockRef,
    reads: AtomicUsize,
    runtime_gate: Mutex<Option<futures::channel::oneshot::Receiver<()>>>,
}

fn unused<T>() -> ContractFuture<'static, T> {
    Box::pin(async {
        Err(ContractError::new(
            ContractErrorCode::Unsupported,
            "QR 审阅不应读取此接口",
        ))
    })
}

impl VerifiedChainClient for ReviewClient {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity> {
        Box::pin(async { Ok(ChainIdentity::citizenchain()) })
    }
    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef> {
        unused()
    }
    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef> {
        Box::pin(async { Ok(self.finalized) })
    }
    fn get_runtime_context_at(
        &self,
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        let gate = self.runtime_gate.lock().unwrap().take();
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            Ok(self.context.clone())
        })
    }
    fn get_storage_at(
        &self,
        _: VerifiedBlockRef,
        _: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        unused()
    }
    fn get_storage_batch_at(
        &self,
        _: VerifiedBlockRef,
        _: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        unused()
    }
    fn get_block_extrinsics_at(&self, _: VerifiedBlockRef) -> ContractFuture<'_, Vec<Vec<u8>>> {
        unused()
    }
    fn submit_extrinsic(&self, _: SignedExtrinsic) -> ContractFuture<'_, SubmittedExtrinsic> {
        unused()
    }
    fn watch_extrinsic(&self, _: SignedExtrinsic) -> ContractStream<'_, ExtrinsicWatchEvent> {
        Box::pin(futures::stream::empty())
    }
    fn export_state(&self) -> ContractFuture<'_, ExportedChainState> {
        unused()
    }
    fn import_state(&self, _: ExportedChainState) -> ContractFuture<'_, StateImportReceipt> {
        unused()
    }
}

fn client(context: RuntimeContext) -> ReviewClient {
    ReviewClient {
        finalized: FinalizedBlockRef::from_parts(context.block().hash(), context.block().number()),
        context,
        reads: AtomicUsize::new(0),
        runtime_gate: Mutex::new(None),
    }
}

#[test]
fn mortal_checkpoint_is_verified_against_exact_finalized_chain() {
    futures::executor::block_on(async {
        let (mut request, context, call_len) = fixture();
        let encoded_era = subxt_core::utils::Era::mortal(64, 77).encode();
        request
            .review_payload
            .splice(call_len..call_len + 1, encoded_era.clone());
        let checkpoint = call_len + encoded_era.len() - 1 + 44;
        request.review_payload[checkpoint..checkpoint + 32]
            .copy_from_slice(context.block().hash().as_bytes());
        let provider = client(context);
        let reviewed = crate::qr_review::review_request(&provider, request.clone())
            .await
            .unwrap();
        assert_eq!(reviewed.era(), "mortal(period=64,phase=13,birth=77)");
        request.review_payload[checkpoint] ^= 1;
        code(
            crate::qr_review::review_request(&provider, request).await,
            ContractErrorCode::Integrity,
        );
    });
}

#[test]
fn runtime_from_another_block_is_rejected_before_scale_review() {
    let (request, context, _) = fixture();
    let mut provider = client(context);
    provider.finalized = FinalizedBlockRef::from_parts(Hash32::from_bytes([0x55; 32]), 78);
    code(
        futures::executor::block_on(crate::qr_review::review_request(&provider, request)),
        ContractErrorCode::Integrity,
    );
}

#[test]
fn qr_chain_review_requires_running_and_holds_lifecycle_until_real_work_drains() {
    use citizen_sdk_contracts::{CapabilityName, Modules};
    futures::executor::block_on(async {
        let (request, context, _) = fixture();
        let provider = Arc::new(client(context));
        let components = crate::EngineComponents::new(
            Some(provider.clone()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .with_modules(Modules::try_new(Modules::QR | Modules::CHAIN).unwrap());
        let engine = crate::CitizenEngine::new(components);
        engine
            .update_capabilities(
                CapabilityName::ALL
                    .into_iter()
                    .map(crate::CapabilityProbe::ready)
                    .collect(),
            )
            .unwrap();
        assert!(engine
            .review_qr_sign_request(request.clone())
            .await
            .is_err());
        assert_eq!(
            provider.reads.load(Ordering::SeqCst),
            0,
            "不能暗启或读取未运行链"
        );
        engine.begin_provider_start().unwrap();
        engine.complete_provider_start().await.unwrap();
        let (release, gate) = futures::channel::oneshot::channel();
        *provider.runtime_gate.lock().unwrap() = Some(gate);
        let mut work = engine.review_qr_sign_request(request);
        assert!(futures::poll!(work.as_mut()).is_pending());
        assert_eq!(provider.reads.load(Ordering::SeqCst), 1);
        assert!(engine.mark_provider_stopped().is_err());
        assert!(engine.dispose().is_err());
        release.send(()).unwrap();
        work.await.unwrap();
        engine.mark_provider_stopped().unwrap();
        engine.dispose().unwrap();
    });
}
