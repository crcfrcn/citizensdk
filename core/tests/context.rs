use citizen_sdk_contracts::{
    ContractErrorCode, Hash32, RuntimeContext, RuntimeVersion, VerifiedBlockRef,
};

use super::{RuntimeContextCache, MAX_RUNTIME_CONTEXTS};
use crate::EngineError;

#[test]
#[allow(clippy::expect_used)]
fn invalidation_rejects_late_best_completion_but_keeps_exact_context() {
    let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 1);
    let mut cache = RuntimeContextCache::new();
    let request = cache.begin(block).expect("request");
    cache.invalidate_current_best();
    let context =
        RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), vec![1]).expect("context");
    cache
        .complete(request, context.clone())
        .expect("exact context");
    assert!(cache.current_best().is_none());
    assert_eq!(cache.get(block), Some(&context));
}

#[test]
fn request_sequence_exhaustion_is_permanent_and_never_reuses_identity() {
    let mut cache = RuntimeContextCache::new();
    cache.next_sequence = u64::MAX - 1;
    let block = VerifiedBlockRef::best(Hash32::from_bytes([0x7f; 32]), 7);
    let last = cache
        .begin(block)
        .unwrap_or_else(|error| panic!("last request failed: {error}"));
    assert_eq!(last.sequence, u64::MAX - 1);
    assert_eq!(cache.latest_best_request, Some(u64::MAX - 1));

    for _ in 0..2 {
        let error = cache
            .begin(block)
            .err()
            .unwrap_or_else(|| panic!("exhausted sequence must fail"));
        match error {
            EngineError::Contract(error) => {
                assert_eq!(error.code(), ContractErrorCode::Internal)
            }
            other => panic!("unexpected exhaustion error: {other}"),
        }
        assert_eq!(cache.next_sequence, u64::MAX);
        assert_eq!(cache.latest_best_request, Some(u64::MAX - 1));
    }
}

#[test]
fn runtime_contexts_are_bounded_and_current_best_is_not_evicted() {
    let mut cache = RuntimeContextCache::new();
    let protected = VerifiedBlockRef::best(Hash32::from_bytes([0xff; 32]), 1);
    let protected_request = cache
        .begin(protected)
        .unwrap_or_else(|error| panic!("protected request failed: {error}"));
    let protected_context =
        RuntimeContext::try_new(protected, RuntimeVersion::new(1, 1), vec![0xff])
            .unwrap_or_else(|error| panic!("protected context failed: {error}"));
    cache
        .complete(protected_request, protected_context)
        .unwrap_or_else(|error| panic!("protected completion failed: {error}"));

    for index in 0..(MAX_RUNTIME_CONTEXTS + 16) {
        let number = u64::try_from(index + 2)
            .unwrap_or_else(|error| panic!("height conversion failed: {error}"));
        let marker = u8::try_from(index + 2)
            .unwrap_or_else(|error| panic!("marker conversion failed: {error}"));
        let block = VerifiedBlockRef::finalized(Hash32::from_bytes([marker; 32]), number);
        let request = cache
            .begin(block)
            .unwrap_or_else(|error| panic!("request failed: {error}"));
        let context = RuntimeContext::try_new(
            block,
            RuntimeVersion::new(marker.into(), marker.into()),
            vec![marker],
        )
        .unwrap_or_else(|error| panic!("context failed: {error}"));
        cache
            .complete(request, context)
            .unwrap_or_else(|error| panic!("completion failed: {error}"));
    }

    assert_eq!(cache.contexts.len(), MAX_RUNTIME_CONTEXTS);
    assert!(cache.get(protected).is_some());
    assert_eq!(
        cache.current_best().map(RuntimeContext::block),
        Some(protected)
    );
    let first_evicted = VerifiedBlockRef::finalized(Hash32::from_bytes([0x02; 32]), 2);
    assert!(cache.get(first_evicted).is_none());
}

// 总字节预算必须独立于条数，单次合法读取不能因缓存预算变为失败。
#[test]
#[allow(clippy::expect_used)]
fn runtime_cache_limits_bytes_and_preserves_best_when_another_context_does_not_fit() {
    let mut cache = RuntimeContextCache::new();
    let best = VerifiedBlockRef::best(Hash32::from_bytes([0x80; 32]), 1);
    let size = super::MAX_RUNTIME_CONTEXT_BYTES / 2 + 1;
    let request = cache.begin(best).expect("best request");
    cache
        .complete(
            request,
            RuntimeContext::try_new(best, RuntimeVersion::new(1, 1), vec![1; size])
                .expect("best context"),
        )
        .expect("best complete");
    let other = VerifiedBlockRef::finalized(Hash32::from_bytes([0x81; 32]), 2);
    let request = cache.begin(other).expect("other request");
    let returned = cache
        .complete(
            request,
            RuntimeContext::try_new(other, RuntimeVersion::new(1, 1), vec![2; size])
                .expect("other context"),
        )
        .expect("valid uncached result");
    assert_eq!(returned.metadata().len(), size);
    assert!(cache.get(best).is_some());
    assert!(cache.get(other).is_none());
    // 真正的新best可替换旧best，随后小结果可进入剩余预算。
    let next = VerifiedBlockRef::best(Hash32::from_bytes([0x82; 32]), 3);
    let request = cache.begin(next).expect("next request");
    cache
        .complete(
            request,
            RuntimeContext::try_new(next, RuntimeVersion::new(1, 1), vec![3; size])
                .expect("next context"),
        )
        .expect("next complete");
    assert!(cache.get(best).is_none());
    assert_eq!(cache.current_best().map(RuntimeContext::block), Some(next));
    let request = cache.begin(other).expect("small request");
    cache
        .complete(
            request,
            RuntimeContext::try_new(other, RuntimeVersion::new(1, 1), vec![2])
                .expect("small context"),
        )
        .expect("small complete");
    assert!(cache.get(other).is_some());
    assert!(
        cache
            .contexts
            .iter()
            .map(|value| value.metadata().len())
            .sum::<usize>()
            <= super::MAX_RUNTIME_CONTEXT_BYTES
    );
}
