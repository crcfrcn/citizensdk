#![cfg(feature = "chain")]

use citizen_sdk_contracts::{
    ExecutionConclusion, Hash32, RuntimeContext, RuntimeVersion, SignedExtrinsic, UnverifiedReason,
    VerifiedBlockRef,
};
use citizen_sdk_engine::{signed_extrinsic_hash, verify_transaction_outcome, TransactionEvidence};
use subxt_core::{
    config::SubstrateConfig,
    events::{Events, Phase},
    ext::codec::{Compact, Decode, Encode},
    Metadata,
};

const METADATA_HEX: &str =
    include_str!("../../../test/transaction/citizenchain-runtime-v14-metadata.hex");
const EVENTS_HEX: &str =
    include_str!("../../../test/transaction/citizenchain-runtime-system-events.hex");

fn hex_bytes(value: &str) -> Vec<u8> {
    let value = value.trim();
    let Some(value) = value.strip_prefix("0x") else {
        panic!("fixture must use 0x prefix");
    };
    assert_eq!(value.len() % 2, 0, "fixture hex length must be even");
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

fn runtime(block: VerifiedBlockRef) -> RuntimeContext {
    match RuntimeContext::try_new(block, RuntimeVersion::new(100, 12), hex_bytes(METADATA_HEX)) {
        Ok(context) => context,
        Err(error) => panic!("runtime fixture failed: {error}"),
    }
}

fn signed(bytes: &[u8]) -> SignedExtrinsic {
    match SignedExtrinsic::try_new(bytes.to_vec()) {
        Ok(extrinsic) => extrinsic,
        Err(error) => panic!("extrinsic fixture failed: {error}"),
    }
}

fn hash(context: &RuntimeContext, extrinsic: &SignedExtrinsic) -> Hash32 {
    match signed_extrinsic_hash(context, extrinsic) {
        Ok(hash) => hash,
        Err(error) => panic!("hash failed: {error}"),
    }
}

fn fixture_metadata() -> Metadata {
    let bytes = hex_bytes(METADATA_HEX);
    let mut cursor = bytes.as_slice();
    let metadata = match Metadata::decode(&mut cursor) {
        Ok(metadata) => metadata,
        Err(error) => panic!("metadata fixture failed to decode: {error}"),
    };
    assert!(cursor.is_empty(), "metadata fixture has trailing bytes");
    metadata
}

#[test]
fn production_events_prove_index_zero_success_and_index_one_bad_origin() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([9; 32]), 100);
    let context = runtime(block);
    let first = signed(&[0x0c, 0x84, 0x01, 0x02]);
    let second = signed(&[0x08, 0x84, 0x03]);
    let body = vec![first.as_bytes().to_vec(), second.as_bytes().to_vec()];
    let events = hex_bytes(EVENTS_HEX);

    let success = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &first,
        submitted_hash: hash(&context, &first),
        block_extrinsics: &body,
        system_events: Some(&events),
    });
    assert!(matches!(
        success,
        ExecutionConclusion::Success {
            extrinsic_index: 0,
            ..
        }
    ));

    let failed = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &second,
        submitted_hash: hash(&context, &second),
        block_extrinsics: &body,
        system_events: Some(&events),
    });
    match failed {
        ExecutionConclusion::Failed {
            extrinsic_index,
            failure,
            ..
        } => {
            assert_eq!(extrinsic_index, 1);
            assert_eq!(failure.variant(), 2);
            assert!(failure.module().is_none());
        }
        other => panic!("expected BadOrigin failure, got {other:?}"),
    }
}

#[test]
fn hash_block_and_body_identity_fail_closed() {
    let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 10);
    let context = runtime(block);
    let target = signed(&[0x0c, 0x84, 0x01, 0x02]);
    let target_hash = hash(&context, &target);
    let events = hex_bytes(EVENTS_HEX);

    let wrong_hash = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: Hash32::from_bytes([0; 32]),
        block_extrinsics: &[target.as_bytes().to_vec()],
        system_events: Some(&events),
    });
    assert!(matches!(
        wrong_hash,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::ExtrinsicHashMismatch,
            ..
        }
    ));

    let duplicate_body = vec![target.as_bytes().to_vec(), target.as_bytes().to_vec()];
    let duplicate = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &duplicate_body,
        system_events: Some(&events),
    });
    assert!(matches!(
        duplicate,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::MultipleExtrinsicMatches,
            ..
        }
    ));

    let other_block = VerifiedBlockRef::best(Hash32::from_bytes([2; 32]), 11);
    let wrong_block = verify_transaction_outcome(TransactionEvidence {
        block: other_block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &[target.as_bytes().to_vec()],
        system_events: Some(&events),
    });
    assert!(matches!(
        wrong_block,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::RuntimeContextUnavailable,
            ..
        }
    ));
}

#[test]
fn malformed_metadata_events_and_wrong_index_never_guess_success() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([3; 32]), 30);
    let context = runtime(block);
    let target = signed(&[0x0c, 0x84, 0x01, 0x02]);
    let target_hash = hash(&context, &target);
    let body = vec![target.as_bytes().to_vec()];
    let mut trailing_events = hex_bytes(EVENTS_HEX);
    trailing_events.push(0);
    let trailing = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &body,
        system_events: Some(&trailing_events),
    });
    assert!(matches!(
        trailing,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::SystemEventsMalformed,
            ..
        }
    ));

    let canonical_events = hex_bytes(EVENTS_HEX);
    assert_eq!(canonical_events.first(), Some(&0x10));
    let mut noncanonical_events = vec![0x11, 0x00];
    noncanonical_events.extend_from_slice(&canonical_events[1..]);
    let noncanonical = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &body,
        system_events: Some(&noncanonical_events),
    });
    assert!(matches!(
        noncanonical,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::SystemEventsMalformed,
            ..
        }
    ));

    let third = signed(&[0x04, 0x99]);
    let third_body = vec![vec![0x04], vec![0x08], third.as_bytes().to_vec()];
    let no_outcome = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &third,
        submitted_hash: hash(&context, &third),
        block_extrinsics: &third_body,
        system_events: Some(&hex_bytes(EVENTS_HEX)),
    });
    assert!(matches!(
        no_outcome,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::OutcomeEventMissing,
            ..
        }
    ));

    let mut bad_metadata = context.metadata().to_vec();
    bad_metadata.push(0);
    let bad_context =
        match RuntimeContext::try_new(block, RuntimeVersion::new(100, 12), bad_metadata) {
            Ok(context) => context,
            Err(error) => panic!("bad metadata fixture construction failed: {error}"),
        };
    let rejected_metadata = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &bad_context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &body,
        system_events: Some(&hex_bytes(EVENTS_HEX)),
    });
    assert!(matches!(
        rejected_metadata,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::MetadataDecodeFailed,
            ..
        }
    ));
}

#[test]
fn compact_length_prefix_is_part_of_the_transaction_hash() {
    let block = VerifiedBlockRef::best(Hash32::from_bytes([4; 32]), 40);
    let context = runtime(block);
    let complete = signed(&[0x0c, 0x84, 0x01, 0x02]);
    let without_prefix = signed(&[0x84, 0x01, 0x02]);
    assert_ne!(hash(&context, &complete), hash(&context, &without_prefix));
}

#[test]
fn zero_body_match_and_duplicate_system_outcome_are_unverified() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([5; 32]), 50);
    let context = runtime(block);
    let target = signed(&[0x0c, 0x84, 0x01, 0x02]);
    let target_hash = hash(&context, &target);
    let events = hex_bytes(EVENTS_HEX);

    let missing = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &[],
        system_events: Some(&events),
    });
    assert!(matches!(
        missing,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::ExtrinsicNotFound,
            ..
        }
    ));

    let decoded = Events::<SubstrateConfig>::decode_from(events.clone(), fixture_metadata());
    let success_bytes = decoded
        .iter()
        .filter_map(Result::ok)
        .find(|event| {
            event.phase() == Phase::ApplyExtrinsic(0)
                && event.pallet_name() == "System"
                && event.variant_name() == "ExtrinsicSuccess"
        })
        .map(|event| event.bytes().to_vec())
        .unwrap_or_else(|| panic!("production fixture has no index-zero success"));
    assert_eq!(events.first(), Some(&0x10));
    let mut ambiguous_events = Compact(5_u32).encode();
    ambiguous_events.extend_from_slice(&events[1..]);
    ambiguous_events.extend_from_slice(&success_bytes);
    let ambiguous = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &target,
        submitted_hash: target_hash,
        block_extrinsics: &[target.as_bytes().to_vec()],
        system_events: Some(&ambiguous_events),
    });
    assert!(matches!(
        ambiguous,
        ExecutionConclusion::Unverified {
            reason: UnverifiedReason::OutcomeEventAmbiguous,
            ..
        }
    ));
}

#[test]
fn module_dispatch_error_preserves_raw_pallet_and_error_indices() {
    let block = VerifiedBlockRef::finalized(Hash32::from_bytes([6; 32]), 60);
    let context = runtime(block);
    let first = signed(&[0x0c, 0x84, 0x01, 0x02]);
    let second = signed(&[0x08, 0x84, 0x03]);
    let body = vec![first.as_bytes().to_vec(), second.as_bytes().to_vec()];
    let events = hex_bytes(EVENTS_HEX);
    let decoded = Events::<SubstrateConfig>::decode_from(events.clone(), fixture_metadata());
    let decoded_base = decoded.bytes().as_ptr() as usize;
    let mut balances_index = None;
    let mut failed_field_offset = None;
    for event in decoded.iter() {
        let event = match event {
            Ok(event) => event,
            Err(error) => panic!("production event failed to decode: {error}"),
        };
        if event.pallet_name() == "Balances" {
            balances_index = Some(event.pallet_index());
        }
        if event.phase() == Phase::ApplyExtrinsic(1)
            && event.pallet_name() == "System"
            && event.variant_name() == "ExtrinsicFailed"
        {
            failed_field_offset = Some(event.field_bytes().as_ptr() as usize - decoded_base);
        }
    }
    let pallet_index = balances_index.unwrap_or_else(|| panic!("Balances event missing"));
    let offset = failed_field_offset.unwrap_or_else(|| panic!("failed event missing"));
    assert_eq!(
        events.get(offset),
        Some(&2),
        "fixture must begin with BadOrigin"
    );

    let error_index = 0_u8;
    let mut module_events = Vec::with_capacity(events.len() + 5);
    module_events.extend_from_slice(&events[..offset]);
    module_events.extend_from_slice(&[3, pallet_index, error_index, 0, 0, 0]);
    module_events.extend_from_slice(&events[offset + 1..]);
    let failed = verify_transaction_outcome(TransactionEvidence {
        block,
        runtime_context: &context,
        signed_extrinsic: &second,
        submitted_hash: hash(&context, &second),
        block_extrinsics: &body,
        system_events: Some(&module_events),
    });
    match failed {
        ExecutionConclusion::Failed { failure, .. } => {
            assert_eq!(failure.variant(), 3);
            let module = failure
                .module()
                .unwrap_or_else(|| panic!("Module failure details missing"));
            assert_eq!(module.pallet_index(), pallet_index);
            assert_eq!(module.error_index(), error_index);
        }
        other => panic!("expected Module failure, got {other:?}"),
    }
}
