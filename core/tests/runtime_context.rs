use citizen_sdk_contracts::{Hash32, RuntimeContext, RuntimeVersion, VerifiedBlockRef};
use citizen_sdk_engine::{RuntimeContextCache, RuntimeContextRequest};

fn begin(cache: &mut RuntimeContextCache, block: VerifiedBlockRef) -> RuntimeContextRequest {
    cache
        .begin(block)
        .unwrap_or_else(|error| panic!("runtime context request failed: {error}"))
}

fn context(block: VerifiedBlockRef, spec_version: u32, marker: u8) -> RuntimeContext {
    match RuntimeContext::try_new(
        block,
        RuntimeVersion::new(spec_version, spec_version + 1),
        vec![marker],
    ) {
        Ok(context) => context,
        Err(error) => panic!("runtime context fixture failed: {error}"),
    }
}

#[test]
fn late_old_best_completion_cannot_replace_new_best() {
    let old_block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
    let new_block = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 11);
    let mut cache = RuntimeContextCache::new();
    let old_request = begin(&mut cache, old_block);
    let new_request = begin(&mut cache, new_block);

    assert!(cache
        .complete(new_request, context(new_block, 2, 2))
        .is_ok());
    assert!(cache
        .complete(old_request, context(old_block, 1, 1))
        .is_ok());
    assert_eq!(
        cache.current_best().map(RuntimeContext::block),
        Some(new_block)
    );
    assert!(cache.get(old_block).is_some());
}

#[test]
fn context_must_match_request_and_remain_immutable() {
    let first = VerifiedBlockRef::best(Hash32::from_bytes([3; 32]), 20);
    let other = VerifiedBlockRef::best(Hash32::from_bytes([4; 32]), 21);
    let same_hash_wrong_height = VerifiedBlockRef::best(Hash32::from_bytes([3; 32]), 99);
    let mut cache = RuntimeContextCache::new();

    let request = begin(&mut cache, first);
    assert!(cache.complete(request, context(other, 1, 1)).is_err());

    let request = begin(&mut cache, first);
    assert!(cache.complete(request, context(first, 1, 1)).is_ok());
    let request = begin(&mut cache, first);
    assert!(cache.complete(request, context(first, 2, 2)).is_err());
    let request = begin(&mut cache, same_hash_wrong_height);
    assert!(cache
        .complete(request, context(same_hash_wrong_height, 1, 1))
        .is_err());
}

#[test]
fn finalized_context_does_not_change_best_identity() {
    let best = VerifiedBlockRef::best(Hash32::from_bytes([5; 32]), 30);
    let finalized = VerifiedBlockRef::finalized(Hash32::from_bytes([6; 32]), 29);
    let mut cache = RuntimeContextCache::new();
    let best_request = begin(&mut cache, best);
    assert!(cache.complete(best_request, context(best, 4, 4)).is_ok());
    let finalized_request = begin(&mut cache, finalized);
    assert!(cache
        .complete(finalized_request, context(finalized, 3, 3))
        .is_ok());
    assert_eq!(cache.current_best().map(RuntimeContext::block), Some(best));
    assert!(cache.get(finalized).is_some());
}

#[test]
fn same_hash_context_can_be_promoted_from_best_to_finalized() {
    let hash = Hash32::from_bytes([7; 32]);
    let best = VerifiedBlockRef::best(hash, 31);
    let finalized = VerifiedBlockRef::finalized(hash, 31);
    let mut cache = RuntimeContextCache::new();

    let best_request = begin(&mut cache, best);
    assert!(cache.complete(best_request, context(best, 5, 5)).is_ok());
    let request = begin(&mut cache, finalized);
    let promoted = match cache.complete(request, context(best, 5, 5)) {
        Ok(context) => context,
        Err(error) => panic!("same block promotion failed: {error}"),
    };
    assert_eq!(promoted.block(), finalized);
    assert_eq!(promoted.version().spec_version(), 5);

    let changed_request = begin(&mut cache, finalized);
    assert!(cache
        .complete(changed_request, context(finalized, 6, 6))
        .is_err());
}
