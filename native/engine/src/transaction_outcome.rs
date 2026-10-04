use citizen_sdk_contracts::{
    DispatchFailure, ExecutionConclusion, Hash32, ModuleDispatchFailure, RuntimeContext,
    SignedExtrinsic, UnverifiedReason, VerifiedBlockRef,
};
use subxt_core::config::{substrate::BlakeTwo256, Hasher};

use crate::{
    error::EngineError,
    system_events::{decode_metadata_strict, DecodedDispatchFailure, DecodedSystemOutcome},
};

/// All already-verified block evidence required to decide one transaction's
/// runtime execution result.
pub struct TransactionEvidence<'a> {
    pub block: VerifiedBlockRef,
    pub runtime_context: &'a RuntimeContext,
    pub signed_extrinsic: &'a SignedExtrinsic,
    pub submitted_hash: Hash32,
    pub block_extrinsics: &'a [Vec<u8>],
    pub system_events: Option<&'a [u8]>,
}

/// Verify full extrinsic identity, exact block index, and the same-index
/// `System` outcome. Every incomplete or contradictory path is explicit
/// `Unverified`; block inclusion alone can never produce `Success`.
pub fn verify_transaction_outcome(evidence: TransactionEvidence<'_>) -> ExecutionConclusion {
    if evidence.runtime_context.block() != evidence.block {
        return unverified(
            Some(evidence.block),
            None,
            UnverifiedReason::RuntimeContextUnavailable,
        );
    }
    let metadata = match decode_metadata_strict(evidence.runtime_context.metadata()) {
        Ok(metadata) => metadata,
        Err(_) => {
            return unverified(
                Some(evidence.block),
                None,
                UnverifiedReason::MetadataDecodeFailed,
            );
        }
    };
    let hasher = BlakeTwo256::new(&metadata);
    let local_hash = Hash32::from_bytes(
        hasher
            .hash(evidence.signed_extrinsic.as_bytes())
            .to_fixed_bytes(),
    );
    if local_hash != evidence.submitted_hash {
        return unverified(
            Some(evidence.block),
            None,
            UnverifiedReason::ExtrinsicHashMismatch,
        );
    }

    let matching_indices: Vec<_> = evidence
        .block_extrinsics
        .iter()
        .enumerate()
        .filter_map(|(index, extrinsic)| {
            let hash = Hash32::from_bytes(hasher.hash(extrinsic).to_fixed_bytes());
            (hash == evidence.submitted_hash).then_some(index)
        })
        .collect();
    let index = match matching_indices.as_slice() {
        [] => {
            return unverified(
                Some(evidence.block),
                None,
                UnverifiedReason::ExtrinsicNotFound,
            );
        }
        [index] => *index,
        _ => {
            return unverified(
                Some(evidence.block),
                None,
                UnverifiedReason::MultipleExtrinsicMatches,
            );
        }
    };
    let Ok(extrinsic_index) = u32::try_from(index) else {
        return unverified(
            Some(evidence.block),
            None,
            UnverifiedReason::ExtrinsicNotFound,
        );
    };
    if evidence.block_extrinsics[index].as_slice() != evidence.signed_extrinsic.as_bytes() {
        return unverified(
            Some(evidence.block),
            Some(extrinsic_index),
            UnverifiedReason::ExtrinsicHashMismatch,
        );
    }
    let Some(events) = evidence.system_events.filter(|events| !events.is_empty()) else {
        return unverified(
            Some(evidence.block),
            Some(extrinsic_index),
            UnverifiedReason::SystemEventsUnavailable,
        );
    };
    match crate::system_events::decode_system_outcome(
        evidence.runtime_context.metadata(),
        events,
        extrinsic_index,
    ) {
        Ok(Some(DecodedSystemOutcome::Success)) => ExecutionConclusion::Success {
            block: evidence.block,
            extrinsic_index,
        },
        Ok(Some(DecodedSystemOutcome::Failed(failure))) => {
            let Some(failure) = contract_failure(failure) else {
                return unverified(
                    Some(evidence.block),
                    Some(extrinsic_index),
                    UnverifiedReason::OutcomeEventAmbiguous,
                );
            };
            ExecutionConclusion::Failed {
                block: evidence.block,
                extrinsic_index,
                failure,
            }
        }
        Ok(None) => unverified(
            Some(evidence.block),
            Some(extrinsic_index),
            UnverifiedReason::OutcomeEventMissing,
        ),
        Err(EngineError::InvalidMetadata(_)) => unverified(
            Some(evidence.block),
            Some(extrinsic_index),
            UnverifiedReason::MetadataDecodeFailed,
        ),
        Err(EngineError::InvalidEvents(reason)) if reason.contains("multiple System") => {
            unverified(
                Some(evidence.block),
                Some(extrinsic_index),
                UnverifiedReason::OutcomeEventAmbiguous,
            )
        }
        Err(EngineError::InvalidEvents(_)) => unverified(
            Some(evidence.block),
            Some(extrinsic_index),
            UnverifiedReason::SystemEventsMalformed,
        ),
        Err(_) => unverified(
            Some(evidence.block),
            Some(extrinsic_index),
            UnverifiedReason::ProviderFailure,
        ),
    }
}

/// Calculate the official CitizenChain/Substrate Blake2-256 identity of the
/// complete signed extrinsic bytes using the exact-block metadata context.
pub fn signed_extrinsic_hash(
    runtime_context: &RuntimeContext,
    extrinsic: &SignedExtrinsic,
) -> Result<Hash32, EngineError> {
    let metadata = decode_metadata_strict(runtime_context.metadata())?;
    let hasher = BlakeTwo256::new(&metadata);
    Ok(Hash32::from_bytes(
        hasher.hash(extrinsic.as_bytes()).to_fixed_bytes(),
    ))
}

fn contract_failure(decoded: DecodedDispatchFailure) -> Option<DispatchFailure> {
    let variant = decoded.variant_index;
    let module = if variant == 3 {
        Some(ModuleDispatchFailure::new(
            decoded.module_index?,
            decoded.error_index?,
            decoded.pallet_name,
            decoded.error_name,
        ))
    } else {
        None
    };
    Some(DispatchFailure::new(variant, module))
}

const fn unverified(
    block: Option<VerifiedBlockRef>,
    extrinsic_index: Option<u32>,
    reason: UnverifiedReason,
) -> ExecutionConclusion {
    ExecutionConclusion::Unverified {
        block,
        extrinsic_index,
        reason,
    }
}
