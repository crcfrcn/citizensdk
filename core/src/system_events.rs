use subxt_core::{
    config::SubstrateConfig,
    events::{Events, Phase},
    ext::{
        codec::{Compact, Decode, Encode},
        scale_value::{Composite, Value, ValueDef},
    },
    Metadata,
};

use crate::error::EngineError;

/// `twox128("System") ++ twox128("Events")`, a chain protocol storage key.
pub(crate) const SYSTEM_EVENTS_STORAGE_KEY: [u8; 32] = [
    0x26, 0xaa, 0x39, 0x4e, 0xea, 0x56, 0x30, 0xe0, 0x7c, 0x48, 0xae, 0x0c, 0x95, 0x58, 0xce, 0xf7,
    0x80, 0xd4, 0x1e, 0x5e, 0x16, 0x05, 0x67, 0x65, 0xbc, 0x84, 0x61, 0x85, 0x10, 0x72, 0xc9, 0xd7,
];

/// Dynamically decoded `DispatchError` evidence from
/// `System.ExtrinsicFailed`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedDispatchFailure {
    /// SCALE variant index read directly from the DispatchError field bytes.
    pub variant_index: u8,
    /// Runtime variant name such as `BadOrigin` or `Module`.
    pub variant: String,
    /// Pallet index when the runtime returned `DispatchError::Module`.
    pub module_index: Option<u8>,
    /// First module error byte when the runtime returned `Module`.
    pub error_index: Option<u8>,
    /// Pallet name resolved from the exact block metadata for Module errors.
    pub pallet_name: Option<String>,
    /// Pallet error name resolved from the exact block metadata.
    pub error_name: Option<String>,
    /// Lossless diagnostic rendering of the dynamically decoded error value.
    pub detail: String,
}

/// Explicit System outcome for one exact extrinsic index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DecodedSystemOutcome {
    /// The runtime emitted `System.ExtrinsicSuccess` for the target index.
    Success,
    /// The runtime emitted `System.ExtrinsicFailed` for the target index.
    Failed(DecodedDispatchFailure),
}

/// Decode all events and return the single explicit System outcome for
/// `extrinsic_index`.
///
/// The entire SCALE vector is consumed even after a candidate outcome is
/// found. A malformed trailing event, trailing byte, or contradictory second
/// outcome invalidates the evidence instead of allowing an early success.
pub fn decode_system_outcome(
    metadata_bytes: &[u8],
    events_bytes: &[u8],
    extrinsic_index: u32,
) -> Result<Option<DecodedSystemOutcome>, EngineError> {
    let metadata = decode_metadata_strict(metadata_bytes)?;
    let mut prefix_cursor = events_bytes;
    let declared_count = Compact::<u32>::decode(&mut prefix_cursor)
        .map_err(|error| EngineError::InvalidEvents(error.to_string()))?
        .0;
    let prefix_length = events_bytes.len().saturating_sub(prefix_cursor.len());
    let canonical_prefix = Compact(declared_count).encode();
    if events_bytes.get(..prefix_length) != Some(canonical_prefix.as_slice()) {
        return Err(EngineError::InvalidEvents(
            "event vector uses a non-canonical Compact length".to_owned(),
        ));
    }
    let events = Events::<SubstrateConfig>::decode_from(events_bytes.to_vec(), metadata.clone());
    if events.len() != declared_count {
        return Err(EngineError::InvalidEvents(
            "event vector length prefix was not preserved".to_owned(),
        ));
    }

    let mut decoded_count = 0_u32;
    let mut consumed = prefix_length;
    let mut outcome = None;
    for event in events.iter() {
        let event = event.map_err(|error| EngineError::InvalidEvents(error.to_string()))?;
        decoded_count = decoded_count.saturating_add(1);
        consumed = consumed.saturating_add(event.bytes().len());
        if event.phase() != Phase::ApplyExtrinsic(extrinsic_index)
            || event.pallet_name() != "System"
        {
            continue;
        }

        let candidate = match event.variant_name() {
            "ExtrinsicSuccess" => Some(DecodedSystemOutcome::Success),
            "ExtrinsicFailed" => {
                let fields = event
                    .field_values()
                    .map_err(|error| EngineError::InvalidEvents(error.to_string()))?;
                Some(DecodedSystemOutcome::Failed(decode_dispatch_failure(
                    &fields,
                    event.field_bytes(),
                    &metadata,
                )?))
            }
            _ => None,
        };
        if let Some(candidate) = candidate {
            if outcome.is_some() {
                return Err(EngineError::InvalidEvents(format!(
                    "multiple System execution outcomes for extrinsic index {extrinsic_index}"
                )));
            }
            outcome = Some(candidate);
        }
    }

    if decoded_count != declared_count || consumed != events_bytes.len() {
        return Err(EngineError::InvalidEvents(
            "event vector was not consumed exactly".to_owned(),
        ));
    }
    Ok(outcome)
}

pub(crate) fn decode_metadata_strict(bytes: &[u8]) -> Result<Metadata, EngineError> {
    let mut cursor = bytes;
    let metadata = Metadata::decode(&mut cursor)
        .map_err(|error| EngineError::InvalidMetadata(error.to_string()))?;
    if !cursor.is_empty() {
        return Err(EngineError::InvalidMetadata(
            "trailing bytes after RuntimeMetadataPrefixed".to_owned(),
        ));
    }
    Ok(metadata)
}

fn decode_dispatch_failure(
    fields: &Composite<u32>,
    field_bytes: &[u8],
    metadata: &Metadata,
) -> Result<DecodedDispatchFailure, EngineError> {
    let Some(variant_index) = field_bytes.first().copied() else {
        return Err(EngineError::InvalidEvents(
            "ExtrinsicFailed has no DispatchError bytes".to_owned(),
        ));
    };
    let Some(dispatch_error) = fields.values().next() else {
        return Err(EngineError::InvalidEvents(
            "ExtrinsicFailed has no DispatchError field".to_owned(),
        ));
    };
    let ValueDef::Variant(variant) = &dispatch_error.value else {
        return Err(EngineError::InvalidEvents(
            "ExtrinsicFailed first field is not DispatchError".to_owned(),
        ));
    };
    if known_dispatch_variant(&variant.name).is_some_and(|known| known != variant_index) {
        return Err(EngineError::InvalidEvents(
            "DispatchError bytes and metadata variant disagree".to_owned(),
        ));
    }
    let (module_index, error_index) = if variant.name == "Module" {
        decode_module_error(&variant.values)
    } else {
        (None, None)
    };
    let pallet = module_index.and_then(|index| metadata.pallet_by_index(index));
    let pallet_name = pallet.map(|pallet| pallet.name().to_owned());
    let error_name = pallet
        .and_then(|pallet| error_index.and_then(|index| pallet.error_variant_by_index(index)))
        .map(|error| error.name.clone());
    Ok(DecodedDispatchFailure {
        variant_index,
        variant: variant.name.clone(),
        module_index,
        error_index,
        pallet_name,
        error_name,
        detail: format!("{dispatch_error:?}"),
    })
}

fn known_dispatch_variant(name: &str) -> Option<u8> {
    match name {
        "Other" => Some(0),
        "CannotLookup" => Some(1),
        "BadOrigin" => Some(2),
        "Module" => Some(3),
        "ConsumerRemaining" => Some(4),
        "NoProviders" => Some(5),
        "TooManyConsumers" => Some(6),
        "Token" => Some(7),
        "Arithmetic" => Some(8),
        "Transactional" => Some(9),
        "Exhausted" => Some(10),
        "Corruption" => Some(11),
        "Unavailable" => Some(12),
        "RootNotAllowed" => Some(13),
        _ => None,
    }
}

fn decode_module_error(values: &Composite<u32>) -> (Option<u8>, Option<u8>) {
    match values {
        Composite::Named(fields) => {
            let module_index = fields
                .iter()
                .find(|(name, _)| name == "index")
                .and_then(|(_, value)| value.as_u128())
                .and_then(|value| u8::try_from(value).ok());
            let error_index = fields
                .iter()
                .find(|(name, _)| name == "error")
                .and_then(|(_, value)| first_byte(value));
            (module_index, error_index)
        }
        Composite::Unnamed(fields) => {
            if let [value] = fields.as_slice() {
                if let ValueDef::Composite(values) = &value.value {
                    return decode_module_error(values);
                }
            }
            let module_index = fields
                .first()
                .and_then(Value::as_u128)
                .and_then(|value| u8::try_from(value).ok());
            let error_index = fields.get(1).and_then(first_byte);
            (module_index, error_index)
        }
    }
}

fn first_byte(value: &Value<u32>) -> Option<u8> {
    if let Some(value) = value.as_u128() {
        return u8::try_from(value).ok();
    }
    match &value.value {
        ValueDef::Composite(values) => values
            .values()
            .next()
            .and_then(Value::as_u128)
            .and_then(|value| u8::try_from(value).ok()),
        ValueDef::Variant(variant) => variant.values.values().next().and_then(first_byte),
        ValueDef::BitSequence(_) | ValueDef::Primitive(_) => None,
    }
}
