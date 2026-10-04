//! Versioned, domain-separated envelopes for records persisted by a host.
//!
//! The host treats every encoded record as opaque.  The domain is part of the
//! digest input and is checked again while decoding, so bytes returned through
//! one typed store callback cannot be interpreted as another store's value.
//!
//! SHA-256 here detects accidental or host-storage corruption only.  It is not
//! an authenticity boundary: encrypted account material is authenticated by
//! the Rust-owned AES-GCM envelope and its domain-bound AAD before it reaches
//! this codec.

use sha2::{Digest, Sha256};

use crate::abi::CitizenSdkErrorCode;
use citizen_sdk_contracts::{
    AccountId32, BlockFinality, ChainDatabaseSnapshot, ChainIdentity,
    DispatchFailure, EncryptedSecretBlobSnapshot, EncryptedSecretBlobState,
    EncryptedSecretEnvelope, ExecutionConclusion, ExportedChainState, FinalizedBlockRef, Hash32,
    Hash32Bytes, HistoryTransactionStatus, ModuleDispatchFailure, RuntimeContext, RuntimeVersion,
    SecretKind, SecretOwner, SecretRef, TransactionExecutionId, TransactionExecutionRecord,
    TransactionHistoryCursor, TransactionHistoryIndex, TransactionHistoryMutation,
    TransactionHistoryQueryKind, VaultGeneration, VerifiedBlockRef,
    WalletCleanupPlan, WalletOrigin, WalletProfile, WalletProvisioningPlan, WalletState,
    WalletRecord, WalletRecordAccount,
    MAX_COLD_WALLET_ACCOUNTS, MAX_PERSISTED_RUNTIME_METADATA_BYTES, MAX_WALLET_ACCOUNT_INDEX,
};

const HOST_RECORD_MAGIC: [u8; 4] = *b"CSHR";
pub const HOST_RECORD_FORMAT_VERSION: u16 = 1;
const HOST_RECORD_HEADER_LEN: usize = 56;
const HOST_RECORD_FLAGS_NONE: u32 = 0;
const HOST_RECORD_DIGEST_OFFSET: usize = 24;
const HOST_RECORD_DIGEST_LEN: usize = 32;
const HOST_RECORD_DIGEST_DOMAIN: &[u8] = b"CitizenSDK host record\0";
const TYPED_PAYLOAD_VERSION: u16 = 1;
/// 钱包名称和付款选择随目录原子保存；只读v3，拒绝旧格式而不迁移或当作空钱包。
const WALLET_TYPED_PAYLOAD_VERSION: u16 = 3;
const MAX_CHAIN_ID_BYTES: usize = 128;
const RUNTIME_CONTEXT_FIXED_TYPED_BYTES: usize = 55;
const MAX_WALLET_ACCOUNTS: usize = MAX_WALLET_ACCOUNT_INDEX as usize + 1;
const MAX_ORDERED_WALLET_ACCOUNTS: usize = MAX_WALLET_ACCOUNTS + MAX_COLD_WALLET_ACCOUNTS;
const MAX_WALLET_NAME_BYTES: usize = 120;
const MAX_SS58_BYTES: usize = 128;
const MAX_CLEANUP_QUEUE: usize = 64;
const MAX_POOL_REASON_BYTES: usize = 1024;
const MAX_PALLET_NAME_BYTES: usize = 128;
const MAX_ENCRYPTED_ENVELOPE_BYTES: usize = 64 * 1024;

/// The five storage contracts have deliberately separate public callbacks.
/// This discriminant protects their persisted representations; it is not a
/// license to expose a generic `(domain, key, bytes)` host API.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HostRecordDomain {
    ChainDatabase = 1,
    RuntimeCache = 2,
    WalletProfile = 3,
    TransactionHistory = 4,
    EncryptedSecretBlob = 5,
}

impl HostRecordDomain {
    /// Maximum serialized typed payload accepted before any owned result is
    /// allocated.  The limits are intentionally independent per contract.
    pub const fn max_payload_bytes(self) -> usize {
        match self {
            // The verified light-client database is currently capped at 256
            // KiB by Engine.  The envelope allows bounded schema overhead.
            Self::ChainDatabase => 512 * 1024,
            // 四个平台的 SQLite store 都把完整 record 限制为 8 MiB；这里扣除
            // host envelope，让 codec 的 encoded 上限与真实持久化边界一致。
            Self::RuntimeCache => {
                MAX_PERSISTED_RUNTIME_METADATA_BYTES + RUNTIME_CONTEXT_FIXED_TYPED_BYTES
            }
            // Hot and public-only cold account descriptors plus lifecycle
            // plans remain bounded independently of history growth.
            Self::WalletProfile => 1024 * 1024,
            // History is the largest durable record and still has a hard
            // allocation ceiling for hostile/corrupt host responses.
            Self::TransactionHistory => 32 * 1024 * 1024,
            // This contains only an authenticated encrypted envelope and
            // tombstone metadata, never plaintext secret material.
            Self::EncryptedSecretBlob => 64 * 1024,
        }
    }

    pub const fn max_encoded_record_bytes(self) -> usize {
        HOST_RECORD_HEADER_LEN + self.max_payload_bytes()
    }

    const fn from_u32(value: u32) -> Option<Self> {
        match value {
            1 => Some(Self::ChainDatabase),
            2 => Some(Self::RuntimeCache),
            3 => Some(Self::WalletProfile),
            4 => Some(Self::TransactionHistory),
            5 => Some(Self::EncryptedSecretBlob),
            _ => None,
        }
    }
}

/// Stable failure categories used while validating an opaque host record.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostCodecErrorKind {
    Malformed,
    UnsupportedVersion,
    UnknownDomain,
    DomainMismatch,
    PayloadTooLarge,
    LengthMismatch,
    IntegrityMismatch,
}

/// An error contains no persisted bytes and is therefore safe to propagate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostCodecError {
    kind: HostCodecErrorKind,
    message: &'static str,
}

impl HostCodecError {
    const fn new(kind: HostCodecErrorKind, message: &'static str) -> Self {
        Self { kind, message }
    }

    #[cfg(test)]
    pub const fn kind(&self) -> HostCodecErrorKind {
        self.kind
    }

    pub const fn message(&self) -> &'static str {
        self.message
    }

    /// Maps codec failures to the already frozen public error vocabulary.
    pub const fn ffi_code(&self) -> CitizenSdkErrorCode {
        match self.kind {
            HostCodecErrorKind::IntegrityMismatch | HostCodecErrorKind::DomainMismatch => {
                CitizenSdkErrorCode::Integrity
            }
            HostCodecErrorKind::PayloadTooLarge => CitizenSdkErrorCode::InvalidArgument,
            HostCodecErrorKind::Malformed
            | HostCodecErrorKind::UnsupportedVersion
            | HostCodecErrorKind::UnknownDomain
            | HostCodecErrorKind::LengthMismatch => CitizenSdkErrorCode::Decode,
        }
    }
}

impl std::fmt::Display for HostCodecError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for HostCodecError {}

/// A successfully decoded record borrows the caller-owned envelope.  No
/// additional payload buffer is created before all structural checks pass.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedHostRecord<'a> {
    domain: HostRecordDomain,
    payload: &'a [u8],
}

impl<'a> DecodedHostRecord<'a> {
    #[cfg(test)]
    pub const fn domain(self) -> HostRecordDomain {
        self.domain
    }

    pub const fn payload(self) -> &'a [u8] {
        self.payload
    }
}

/// Encodes one already-serialized typed value for its dedicated store.
pub fn encode_host_record(
    domain: HostRecordDomain,
    payload: &[u8],
) -> Result<Vec<u8>, HostCodecError> {
    validate_payload_len(domain, payload.len())?;
    let encoded_len = HOST_RECORD_HEADER_LEN
        .checked_add(payload.len())
        .ok_or_else(|| {
            HostCodecError::new(
                HostCodecErrorKind::PayloadTooLarge,
                "host record encoded length overflowed",
            )
        })?;
    let payload_len = u64::try_from(payload.len()).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "host record payload length cannot be represented",
        )
    })?;

    let mut encoded = Vec::with_capacity(encoded_len);
    encoded.extend_from_slice(&HOST_RECORD_MAGIC);
    encoded.extend_from_slice(&HOST_RECORD_FORMAT_VERSION.to_le_bytes());
    encoded.extend_from_slice(&(HOST_RECORD_HEADER_LEN as u16).to_le_bytes());
    encoded.extend_from_slice(&(domain as u32).to_le_bytes());
    encoded.extend_from_slice(&HOST_RECORD_FLAGS_NONE.to_le_bytes());
    encoded.extend_from_slice(&payload_len.to_le_bytes());
    let digest = record_digest(domain, payload_len, payload);
    encoded.extend_from_slice(&digest);
    encoded.extend_from_slice(payload);
    debug_assert_eq!(encoded.len(), encoded_len);
    Ok(encoded)
}

/// Decodes an opaque record only when it belongs to the exact typed callback
/// that requested it.
pub fn decode_host_record<'a>(
    expected_domain: HostRecordDomain,
    encoded: &'a [u8],
) -> Result<DecodedHostRecord<'a>, HostCodecError> {
    if encoded.len() < HOST_RECORD_HEADER_LEN {
        return Err(HostCodecError::new(
            HostCodecErrorKind::Malformed,
            "host record is shorter than its fixed header",
        ));
    }
    if encoded[..4] != HOST_RECORD_MAGIC {
        return Err(HostCodecError::new(
            HostCodecErrorKind::Malformed,
            "host record magic is invalid",
        ));
    }

    let version = read_u16(encoded, 4);
    if version != HOST_RECORD_FORMAT_VERSION {
        return Err(HostCodecError::new(
            HostCodecErrorKind::UnsupportedVersion,
            "host record format version is unsupported",
        ));
    }
    if usize::from(read_u16(encoded, 6)) != HOST_RECORD_HEADER_LEN {
        return Err(HostCodecError::new(
            HostCodecErrorKind::Malformed,
            "host record header length is invalid",
        ));
    }

    let stored_domain = HostRecordDomain::from_u32(read_u32(encoded, 8)).ok_or_else(|| {
        HostCodecError::new(
            HostCodecErrorKind::UnknownDomain,
            "host record domain is unknown",
        )
    })?;
    if stored_domain != expected_domain {
        return Err(HostCodecError::new(
            HostCodecErrorKind::DomainMismatch,
            "host record belongs to a different typed store",
        ));
    }
    if read_u32(encoded, 12) != HOST_RECORD_FLAGS_NONE {
        return Err(HostCodecError::new(
            HostCodecErrorKind::Malformed,
            "host record reserved flags are nonzero",
        ));
    }

    let declared_len_u64 = read_u64(encoded, 16);
    let declared_len = usize::try_from(declared_len_u64).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "host record payload length exceeds this platform",
        )
    })?;
    validate_payload_len(stored_domain, declared_len)?;
    let expected_len = HOST_RECORD_HEADER_LEN
        .checked_add(declared_len)
        .ok_or_else(|| {
            HostCodecError::new(
                HostCodecErrorKind::PayloadTooLarge,
                "host record encoded length overflowed",
            )
        })?;
    if encoded.len() != expected_len {
        return Err(HostCodecError::new(
            HostCodecErrorKind::LengthMismatch,
            "host record payload length does not match its envelope",
        ));
    }

    let payload = &encoded[HOST_RECORD_HEADER_LEN..];
    let expected_digest = record_digest(stored_domain, declared_len_u64, payload);
    let stored_digest =
        &encoded[HOST_RECORD_DIGEST_OFFSET..HOST_RECORD_DIGEST_OFFSET + HOST_RECORD_DIGEST_LEN];
    if stored_digest != &expected_digest[..] {
        return Err(HostCodecError::new(
            HostCodecErrorKind::IntegrityMismatch,
            "host record corruption digest does not match",
        ));
    }

    Ok(DecodedHostRecord {
        domain: stored_domain,
        payload,
    })
}

fn validate_payload_len(
    domain: HostRecordDomain,
    payload_len: usize,
) -> Result<(), HostCodecError> {
    if payload_len > domain.max_payload_bytes() {
        return Err(HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "host record exceeds the typed store payload limit",
        ));
    }
    Ok(())
}

fn record_digest(domain: HostRecordDomain, payload_len: u64, payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(HOST_RECORD_DIGEST_DOMAIN);
    hasher.update(HOST_RECORD_FORMAT_VERSION.to_le_bytes());
    hasher.update((domain as u32).to_le_bytes());
    hasher.update(payload_len.to_le_bytes());
    hasher.update(payload);
    hasher.finalize().into()
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ])
}

// -------------------------------------------------------------------------
// Strict typed payload codecs.  These functions are the only translation
// between host-owned opaque records and contracts-layer value objects.

pub fn encode_chain_database_snapshot(
    snapshot: &ChainDatabaseSnapshot,
) -> Result<Vec<u8>, HostCodecError> {
    encode_typed(HostRecordDomain::ChainDatabase, |writer| {
        writer.u64(snapshot.revision());
        writer.bool(snapshot.state().is_some());
        if let Some(state) = snapshot.state() {
            writer.string(state.identity().chain_id(), MAX_CHAIN_ID_BYTES)?;
            writer.string(state.identity().protocol_id(), MAX_CHAIN_ID_BYTES)?;
            writer.fixed(state.identity().genesis_hash().as_bytes());
            writer.u32(state.format_version());
            encode_finalized_block(writer, state.finalized());
            writer.bytes(state.database(), 256 * 1024)?;
        }
        Ok(())
    })
}

pub fn decode_chain_database_snapshot(
    encoded: &[u8],
) -> Result<ChainDatabaseSnapshot, HostCodecError> {
    decode_typed(HostRecordDomain::ChainDatabase, encoded, |reader| {
        let revision = reader.u64()?;
        let state = if reader.bool()? {
            let identity = ChainIdentity::try_new(
                reader.string(MAX_CHAIN_ID_BYTES)?,
                reader.string(MAX_CHAIN_ID_BYTES)?,
                Hash32::from_bytes(reader.fixed()?),
            )
            .map_err(|_| model_integrity("persisted chain identity is invalid"))?;
            let format_version = reader.u32()?;
            let finalized = decode_finalized_block(reader)?;
            let database = reader.bytes(256 * 1024)?;
            Some(
                ExportedChainState::try_new(identity, format_version, finalized, database)
                    .map_err(|_| model_integrity("persisted chain state is invalid"))?,
            )
        } else {
            None
        };
        Ok(ChainDatabaseSnapshot::new(revision, state))
    })
}

pub fn encode_runtime_context(context: &RuntimeContext) -> Result<Vec<u8>, HostCodecError> {
    if context.metadata().len() > MAX_PERSISTED_RUNTIME_METADATA_BYTES {
        return Err(HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "runtime metadata exceeds the persistent cache capacity",
        ));
    }
    encode_typed(HostRecordDomain::RuntimeCache, |writer| {
        encode_block(writer, context.block());
        writer.u32(context.version().spec_version());
        writer.u32(context.version().transaction_version());
        writer.bytes(context.metadata(), MAX_PERSISTED_RUNTIME_METADATA_BYTES)
    })
}

pub fn decode_runtime_context(encoded: &[u8]) -> Result<RuntimeContext, HostCodecError> {
    decode_typed(HostRecordDomain::RuntimeCache, encoded, |reader| {
        let block = decode_block(reader)?;
        let version = RuntimeVersion::new(reader.u32()?, reader.u32()?);
        let metadata = reader.bytes(MAX_PERSISTED_RUNTIME_METADATA_BYTES)?;
        RuntimeContext::try_new(block, version, metadata)
            .map_err(|_| model_integrity("persisted runtime context is invalid"))
    })
}

pub fn encode_wallet_state(state: &WalletState) -> Result<Vec<u8>, HostCodecError> {
    encode_typed_version(
        HostRecordDomain::WalletProfile,
        WALLET_TYPED_PAYLOAD_VERSION,
        |writer| {
            writer.u64(state.revision());
            writer.bool(state.active_wallet_index().is_some());
            if let Some(wallet_index) = state.active_wallet_index() { writer.u32(wallet_index); }
            let profile = state.profile().map(WalletRecord::from_profile)
                .or_else(|| state.diagnostics().iter().find(|record| matches!(record, WalletRecord::Profile { .. })).cloned());
            encode_optional(writer, profile.as_ref(), encode_profile_record)?;
            let cold: Vec<_> = state.cold_accounts().iter().map(WalletRecord::from_cold_account)
                .chain(state.diagnostics().iter().filter(|record| matches!(record, WalletRecord::Account { .. })).cloned()).collect();
            writer.count(cold.len(), MAX_COLD_WALLET_ACCOUNTS)?;
            for record in &cold { encode_cold_record(writer, record)?; }
            writer.count(
                state.ordered_account_ids().len(),
                MAX_ORDERED_WALLET_ACCOUNTS,
            )?;
            for account_id in state.ordered_account_ids() {
                writer.fixed(account_id.as_bytes());
            }
            writer.u32(state.next_cold_wallet_index());
            encode_optional(writer, state.provisioning(), encode_provisioning_plan)?;
            encode_optional(writer, state.cleanup(), encode_cleanup_plan)?;
            writer.count(state.cleanup_queue().len(), MAX_CLEANUP_QUEUE)?;
            for cleanup in state.cleanup_queue() {
                encode_cleanup_plan(writer, cleanup)?;
            }
            Ok(())
        },
    )
}

pub fn decode_wallet_state(encoded: &[u8]) -> Result<WalletState, HostCodecError> {
    decode_typed_version(
        HostRecordDomain::WalletProfile,
        WALLET_TYPED_PAYLOAD_VERSION,
        encoded,
        |reader| {
            let revision = reader.u64()?;
            let active_wallet_index = if reader.bool()? { Some(reader.u32()?) } else { None };
            let mut diagnostics = Vec::new();
            let profile = match decode_optional(reader, decode_profile_record)? {
                Some(record) if record.diagnostic_reason().is_none() => Some(record.validate_profile_identity()
                    .map_err(|_| model_integrity("persisted wallet identity is invalid"))?),
                Some(record) => { diagnostics.push(record); None }
                None => None,
            };
            let cold_count = reader.count(MAX_COLD_WALLET_ACCOUNTS)?;
            let mut cold_accounts = Vec::with_capacity(cold_count);
            for _ in 0..cold_count {
                let record = decode_cold_record(reader)?;
                if record.diagnostic_reason().is_none() {
                    cold_accounts.push(record.validate_cold_identity().map_err(|_| model_integrity("persisted cold identity is invalid"))?);
                } else { diagnostics.push(record); }
            }
            let ordered_count = reader.count(MAX_ORDERED_WALLET_ACCOUNTS)?;
            let mut ordered_account_ids = Vec::with_capacity(ordered_count);
            for _ in 0..ordered_count {
                ordered_account_ids.push(AccountId32::from_bytes(reader.fixed()?));
            }
            // 沿原有效账户目录投影：只过滤已归属于异常记录的标识；未知或重复顺序仍失败。
            let unique: std::collections::BTreeSet<_> = ordered_account_ids.iter().copied().collect();
            if unique.len() != ordered_account_ids.len() { return Err(model_integrity("persisted wallet order is duplicated")); }
            let invalid: std::collections::BTreeSet<_> = diagnostics.iter().flat_map(WalletRecord::account_ids).collect();
            ordered_account_ids.retain(|account_id| !invalid.contains(account_id));
            let next_cold_wallet_index = reader.u32()?;
            let provisioning = decode_optional(reader, decode_provisioning_plan)?;
            let cleanup = decode_optional(reader, decode_cleanup_plan)?;
            let cleanup_count = reader.count(MAX_CLEANUP_QUEUE)?;
            let mut cleanup_queue = Vec::with_capacity(cleanup_count);
            for _ in 0..cleanup_count {
                cleanup_queue.push(decode_cleanup_plan(reader)?);
            }
            WalletState::try_from_catalog_parts(
                revision,
                profile,
                cold_accounts,
                ordered_account_ids,
                next_cold_wallet_index,
                provisioning,
                cleanup,
                cleanup_queue,
            )
            .and_then(|state| state.try_with_diagnostics(diagnostics))
            .and_then(|state| state.try_with_active_wallet(active_wallet_index))
            .map_err(|_| model_integrity("persisted wallet state is invalid"))
        },
    )
}

fn encode_cold_record(writer: &mut TypedWriter, record: &WalletRecord) -> Result<(), HostCodecError> {
    record.validate_shape().map_err(|_| model_integrity("cold record shape is invalid"))?;
    let WalletRecord::Account { wallet_index, sign_mode, account_id, ss58_address, name, created_at_millis } = record else {
        return Err(model_integrity("cold slot has another record kind"));
    };
    writer.u32(*wallet_index);
    writer.string(sign_mode, 32)?;
    writer.fixed(account_id.as_bytes());
    writer.string(ss58_address, MAX_SS58_BYTES)?;
    writer.string(name, MAX_WALLET_NAME_BYTES)?;
    writer.u64(*created_at_millis);
    Ok(())
}

fn decode_cold_record(reader: &mut TypedReader<'_>) -> Result<WalletRecord, HostCodecError> {
    let record = WalletRecord::Account {
        wallet_index: reader.u32()?,
        sign_mode: reader.string(32)?,
        account_id: AccountId32::from_bytes(reader.fixed()?),
        ss58_address: reader.string(MAX_SS58_BYTES)?,
        name: reader.string(MAX_WALLET_NAME_BYTES)?,
        created_at_millis: reader.u64()?,
    };
    record.validate_shape().map_err(|_| model_integrity("cold record shape is invalid"))?;
    Ok(record)
}

fn encode_wallet_profile(writer: &mut TypedWriter, profile: &WalletProfile) -> Result<(), HostCodecError> {
    encode_profile_record(writer, &WalletRecord::from_profile(profile))
}
fn encode_profile_record(writer: &mut TypedWriter, record: &WalletRecord) -> Result<(), HostCodecError> {
    record.validate_shape().map_err(|_| model_integrity("profile record shape is invalid"))?;
    let WalletRecord::Profile { wallet_index, wallet_name, sign_mode, generation, master_account_id,
        origin, created_at_millis, active_account_id, accounts } = record else {
        return Err(model_integrity("profile slot has another record kind"));
    };
    writer.u32(*wallet_index);
    writer.string(wallet_name, MAX_WALLET_NAME_BYTES)?;
    writer.string(sign_mode, 32)?;
    writer.fixed(generation.as_bytes());
    writer.fixed(master_account_id.as_bytes());
    writer.u8(match origin { WalletOrigin::Created => 1, WalletOrigin::Imported => 2 });
    writer.u64(*created_at_millis);
    writer.fixed(active_account_id.as_bytes());
    writer.count(accounts.len(), MAX_WALLET_ACCOUNTS)?;
    for account in accounts {
        writer.u32(account.index);
        writer.fixed(account.account_id.as_bytes());
        encode_secret_ref(writer, account.secret_ref);
        writer.string(&account.ss58_address, MAX_SS58_BYTES)?;
        writer.string(&account.name, MAX_WALLET_NAME_BYTES)?;
        writer.u64(account.created_at_millis);
    }
    Ok(())
}

fn decode_profile_record(reader: &mut TypedReader<'_>) -> Result<WalletRecord, HostCodecError> {
    let wallet_index = reader.u32()?;
    let wallet_name = reader.string(MAX_WALLET_NAME_BYTES)?;
    let sign_mode = reader.string(32)?;
    let generation = VaultGeneration::from_bytes(reader.fixed()?);
    let master_account_id = AccountId32::from_bytes(reader.fixed()?);
    let origin = match reader.u8()? {
        1 => WalletOrigin::Created, 2 => WalletOrigin::Imported,
        _ => return Err(model_integrity("persisted wallet origin is unknown")),
    };
    let created_at_millis = reader.u64()?;
    let active_account_id = AccountId32::from_bytes(reader.fixed()?);
    let count = reader.count(MAX_WALLET_ACCOUNTS)?;
    let mut accounts = Vec::with_capacity(count);
    for _ in 0..count {
        accounts.push(WalletRecordAccount {
            index: reader.u32()?, account_id: AccountId32::from_bytes(reader.fixed()?),
            secret_ref: decode_secret_ref(reader)?, ss58_address: reader.string(MAX_SS58_BYTES)?,
            name: reader.string(MAX_WALLET_NAME_BYTES)?, created_at_millis: reader.u64()?,
        });
    }
    let record = WalletRecord::Profile { wallet_index, wallet_name, sign_mode, generation,
        master_account_id, origin, created_at_millis, active_account_id, accounts };
    record.validate_shape().map_err(|_| model_integrity("profile record shape is invalid"))?;
    Ok(record)
}

fn decode_wallet_profile(reader: &mut TypedReader<'_>) -> Result<WalletProfile, HostCodecError> {
    let record = decode_profile_record(reader)?;
    // 在途计划的前态不是可展示异常槽；它必须仍是完整可验证的原热钱包所有权。
    if record.sign_mode() != "hot" { return Err(model_integrity("provisioning profile mode is invalid")); }
    record.validate_profile_identity().map_err(|_| model_integrity("persisted wallet profile is invalid"))
}

fn encode_provisioning_plan(
    writer: &mut TypedWriter,
    plan: &WalletProvisioningPlan,
) -> Result<(), HostCodecError> {
    writer.fixed(plan.operation_id());
    writer.u32(plan.wallet_index());
    writer.fixed(plan.generation().as_bytes());
    encode_optional(writer, plan.previous_profile(), encode_wallet_profile)?;
    writer.count(plan.secret_refs().len(), MAX_WALLET_ACCOUNTS)?;
    for secret_ref in plan.secret_refs() {
        encode_secret_ref(writer, *secret_ref);
    }
    writer.bool(plan.delete_wallet_key_on_rollback());
    Ok(())
}

fn decode_provisioning_plan(
    reader: &mut TypedReader<'_>,
) -> Result<WalletProvisioningPlan, HostCodecError> {
    let operation_id = reader.fixed()?;
    let wallet_index = reader.u32()?;
    let generation = VaultGeneration::from_bytes(reader.fixed()?);
    let previous_profile = decode_optional(reader, decode_wallet_profile)?;
    let count = reader.count(MAX_WALLET_ACCOUNTS)?;
    let mut secret_refs = Vec::with_capacity(count);
    for _ in 0..count {
        secret_refs.push(decode_secret_ref(reader)?);
    }
    let delete_wallet_key_on_rollback = reader.bool()?;
    WalletProvisioningPlan::try_new(
        operation_id,
        wallet_index,
        generation,
        previous_profile,
        secret_refs,
        delete_wallet_key_on_rollback,
    )
    .map_err(|_| model_integrity("persisted provisioning plan is invalid"))
}

fn encode_cleanup_plan(
    writer: &mut TypedWriter,
    plan: &WalletCleanupPlan,
) -> Result<(), HostCodecError> {
    writer.fixed(plan.operation_id());
    writer.u32(plan.wallet_index());
    writer.fixed(plan.generation().as_bytes());
    writer.count(plan.secret_refs().len(), MAX_WALLET_ACCOUNTS)?;
    for secret_ref in plan.secret_refs() {
        encode_secret_ref(writer, *secret_ref);
    }
    writer.bool(plan.delete_wallet_key());
    Ok(())
}

fn decode_cleanup_plan(reader: &mut TypedReader<'_>) -> Result<WalletCleanupPlan, HostCodecError> {
    let operation_id = reader.fixed()?;
    let wallet_index = reader.u32()?;
    let generation = VaultGeneration::from_bytes(reader.fixed()?);
    let count = reader.count(MAX_WALLET_ACCOUNTS)?;
    let mut secret_refs = Vec::with_capacity(count);
    for _ in 0..count {
        secret_refs.push(decode_secret_ref(reader)?);
    }
    let delete_wallet_key = reader.bool()?;
    WalletCleanupPlan::try_new(
        operation_id,
        wallet_index,
        generation,
        secret_refs,
        delete_wallet_key,
    )
    .map_err(|_| model_integrity("persisted cleanup plan is invalid"))
}

fn encode_secret_ref(writer: &mut TypedWriter, secret_ref: SecretRef) {
    writer.u32(secret_ref.wallet_index());
    writer.fixed(secret_ref.generation().as_bytes());
    writer.fixed(secret_ref.owner().as_bytes());
    writer.fixed(secret_ref.account_id().as_bytes());
    writer.u8(match secret_ref.kind() {
        SecretKind::AccountMiniSecret => 1,
    });
}

fn decode_secret_ref(reader: &mut TypedReader<'_>) -> Result<SecretRef, HostCodecError> {
    let wallet_index = reader.u32()?;
    let generation = VaultGeneration::from_bytes(reader.fixed()?);
    let owner = SecretOwner::from_bytes(reader.fixed()?);
    let account_id = AccountId32::from_bytes(reader.fixed()?);
    if reader.u8()? != 1 {
        return Err(model_integrity("persisted secret kind is unknown"));
    }
    Ok(SecretRef::account_mini_secret(
        wallet_index,
        generation,
        owner,
        account_id,
    ))
}

fn encode_block(writer: &mut TypedWriter, block: VerifiedBlockRef) {
    writer.u8(match block.finality() {
        BlockFinality::Best => 1,
        BlockFinality::Finalized => 2,
    });
    writer.fixed(block.hash().as_bytes());
    writer.u64(block.number());
}

fn decode_block(reader: &mut TypedReader<'_>) -> Result<VerifiedBlockRef, HostCodecError> {
    let finality = reader.u8()?;
    let hash = Hash32::from_bytes(reader.fixed()?);
    let number = reader.u64()?;
    match finality {
        1 => Ok(VerifiedBlockRef::best(hash, number)),
        2 => Ok(VerifiedBlockRef::finalized(hash, number)),
        _ => Err(model_integrity("persisted block finality is unknown")),
    }
}

fn encode_finalized_block(writer: &mut TypedWriter, block: FinalizedBlockRef) {
    encode_block(writer, block.verified());
}

fn decode_finalized_block(
    reader: &mut TypedReader<'_>,
) -> Result<FinalizedBlockRef, HostCodecError> {
    decode_block(reader)?
        .require_finalized()
        .map_err(|_| model_integrity("persisted block is not finalized"))
}

pub fn encode_transaction_execution_record(
    record: &TransactionExecutionRecord,
) -> Result<Vec<u8>, HostCodecError> {
    encode_typed(HostRecordDomain::TransactionHistory, |writer| {
        writer.fixed(b"TXR1");
        encode_transaction_execution_record_fields(writer, record)
    })
}

pub fn decode_transaction_execution_record(
    encoded: &[u8],
) -> Result<TransactionExecutionRecord, HostCodecError> {
    decode_typed(HostRecordDomain::TransactionHistory, encoded, |reader| {
        if reader.fixed::<4>()? != *b"TXR1" {
            return Err(model_integrity(
                "persisted transaction execution is not the per-record schema",
            ));
        }
        decode_transaction_execution_record_fields(reader)
    })
}

fn encode_transaction_execution_record_fields(
    writer: &mut TypedWriter,
    record: &TransactionExecutionRecord,
) -> Result<(), HostCodecError> {
    writer.fixed(record.execution_id().as_bytes());
    writer.fixed(record.account_id().as_bytes());
    writer.fixed(record.call_data_hash().as_bytes());
    writer.bytes(
        record.call_data(),
        citizen_sdk_contracts::MAX_TRANSACTION_CALL_DATA_BYTES,
    )?;
    writer.fixed(record.transaction_hash().as_bytes());
    writer.bytes(
        record.signed_extrinsic().as_bytes(),
        citizen_sdk_contracts::MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES,
    )?;
    encode_block(writer, record.block());
    writer.u32(record.runtime_version().spec_version());
    writer.u32(record.runtime_version().transaction_version());
    writer.fixed(record.genesis_hash().as_bytes());
    writer.u64(record.nonce());
    encode_history_status(writer, record.status())?;
    writer.u64(record.created_at_millis());
    writer.u64(record.updated_at_millis());
    Ok(())
}

fn decode_transaction_execution_record_fields(
    reader: &mut TypedReader<'_>,
) -> Result<TransactionExecutionRecord, HostCodecError> {
    let execution_id = TransactionExecutionId::try_new(reader.fixed()?)
        .map_err(|_| model_integrity("persisted execution id is invalid"))?;
    let account_id = AccountId32::from_bytes(reader.fixed()?);
    let call_data_hash = Hash32::from_bytes(reader.fixed()?);
    let call_data = reader.bytes(citizen_sdk_contracts::MAX_TRANSACTION_CALL_DATA_BYTES)?;
    let transaction_hash = Hash32::from_bytes(reader.fixed()?);
    let signed_extrinsic = citizen_sdk_contracts::SignedExtrinsic::try_new(
        reader.bytes(citizen_sdk_contracts::MAX_TRANSACTION_SIGNED_EXTRINSIC_BYTES)?,
    )
    .map_err(|_| model_integrity("persisted generic signed extrinsic is invalid"))?;
    let block = decode_block(reader)?;
    let runtime_version = RuntimeVersion::new(reader.u32()?, reader.u32()?);
    let genesis_hash = Hash32::from_bytes(reader.fixed()?);
    let nonce = reader.u64()?;
    let status = decode_history_status(reader)?;
    let created = reader.u64()?;
    let updated = reader.u64()?;
    TransactionExecutionRecord::try_new(
        execution_id,
        account_id,
        call_data_hash,
        call_data,
        transaction_hash,
        signed_extrinsic,
        block,
        runtime_version,
        genesis_hash,
        nonce,
        status,
        created,
        updated,
    )
    .map_err(|_| model_integrity("persisted generic transaction execution is invalid"))
}

/// Decoded host query result. The host indexes only generic timestamps,
/// terminal flags and resource weight; every descriptor is cross-checked
/// against the integrity-protected opaque Core record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransactionHistoryHostBatch {
    index: TransactionHistoryIndex,
    records: Vec<TransactionExecutionRecord>,
    has_more: bool,
}

impl TransactionHistoryHostBatch {
    pub const fn index(&self) -> TransactionHistoryIndex {
        self.index
    }
    pub fn records(&self) -> &[TransactionExecutionRecord] {
        &self.records
    }
    pub const fn has_more(&self) -> bool {
        self.has_more
    }
}

pub fn encode_transaction_history_index_query() -> Vec<u8> {
    encode_transaction_history_query(1, u64::MAX, None, None, 0)
}

pub fn encode_transaction_history_record_query(
    expected_revision: u64,
    execution_id: TransactionExecutionId,
) -> Vec<u8> {
    encode_transaction_history_query(2, expected_revision, Some(execution_id), None, 1)
}

pub fn encode_transaction_history_page_query(
    expected_revision: u64,
    kind: TransactionHistoryQueryKind,
    before: Option<TransactionHistoryCursor>,
    limit: usize,
) -> Result<Vec<u8>, HostCodecError> {
    if !(1..=citizen_sdk_contracts::MAX_TRANSACTION_HISTORY_PAGE_SIZE).contains(&limit) {
        return Err(model_integrity("history query limit is outside 1..100"));
    }
    let wire_kind = match kind {
        TransactionHistoryQueryKind::Newest => 3,
        TransactionHistoryQueryKind::OldestRetentionTerminal => 4,
        TransactionHistoryQueryKind::OldestReconcilable => 5,
    };
    let limit = u32::try_from(limit)
        .map_err(|_| model_integrity("history query limit cannot fit the wire u32"))?;
    Ok(encode_transaction_history_query(
        wire_kind,
        expected_revision,
        None,
        before,
        limit,
    ))
}

fn encode_transaction_history_query(
    kind: u8,
    expected_revision: u64,
    execution_id: Option<TransactionExecutionId>,
    before: Option<TransactionHistoryCursor>,
    limit: u32,
) -> Vec<u8> {
    let mut writer = TypedWriter::new();
    writer.fixed(b"THQ1");
    writer.u8(kind);
    writer.u64(expected_revision);
    writer.u32(limit);
    writer.fixed(
        execution_id
            .map(|value| *value.as_bytes())
            .unwrap_or([0; 16])
            .as_slice(),
    );
    writer.bool(before.is_some());
    writer.u64(before.map_or(0, |cursor| cursor.created_at_millis()));
    writer.fixed(
        before
            .map(|cursor| *cursor.execution_id().as_bytes())
            .unwrap_or([0; 16])
            .as_slice(),
    );
    writer.bytes
}

pub fn encode_transaction_history_mutation(
    mutation: &TransactionHistoryMutation,
) -> Result<Vec<u8>, HostCodecError> {
    let mut writer = TypedWriter::new();
    writer.fixed(b"THM1");
    encode_history_index(&mut writer, mutation.next_index())?;
    writer.count(
        mutation.deletes().len(),
        citizen_sdk_contracts::MAX_TRANSACTION_HISTORY_RECORDS,
    )?;
    for execution_id in mutation.deletes() {
        writer.fixed(execution_id.as_bytes());
    }
    writer.count(
        mutation.upserts().len(),
        citizen_sdk_contracts::MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    )?;
    for record in mutation.upserts() {
        encode_history_descriptor(&mut writer, record)?;
    }
    if writer.bytes.len() > HostRecordDomain::TransactionHistory.max_payload_bytes() {
        return Err(HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history mutation exceeds the host wire limit",
        ));
    }
    Ok(writer.bytes)
}

#[allow(dead_code)] // Production hosts emit this wire value; Rust uses it for conformance vectors.
pub fn encode_transaction_history_host_batch(
    index: TransactionHistoryIndex,
    records: &[TransactionExecutionRecord],
    has_more: bool,
) -> Result<Vec<u8>, HostCodecError> {
    let mut writer = TypedWriter::new();
    writer.fixed(b"THB1");
    encode_history_index(&mut writer, index)?;
    writer.bool(has_more);
    writer.count(
        records.len(),
        citizen_sdk_contracts::MAX_TRANSACTION_HISTORY_PAGE_SIZE,
    )?;
    for record in records {
        encode_history_descriptor(&mut writer, record)?;
    }
    if writer.bytes.len() > HostRecordDomain::TransactionHistory.max_payload_bytes() {
        return Err(HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history query response exceeds the host wire limit",
        ));
    }
    Ok(writer.bytes)
}

pub fn decode_transaction_history_host_batch(
    encoded: &[u8],
) -> Result<TransactionHistoryHostBatch, HostCodecError> {
    if encoded.len() > HostRecordDomain::TransactionHistory.max_payload_bytes() {
        return Err(HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history query response exceeds the host wire limit",
        ));
    }
    let mut reader = TypedReader::new(encoded);
    if reader.fixed::<4>()? != *b"THB1" {
        return Err(model_integrity("history query response magic is invalid"));
    }
    let index = decode_history_index(&mut reader)?;
    let has_more = reader.bool()?;
    let count = reader.count(citizen_sdk_contracts::MAX_TRANSACTION_HISTORY_PAGE_SIZE)?;
    let mut records = Vec::with_capacity(count);
    for _ in 0..count {
        records.push(decode_history_descriptor(&mut reader)?);
    }
    reader.finish()?;
    if records.len() > index.record_count() || (records.is_empty() && has_more) {
        return Err(model_integrity("history query response count is invalid"));
    }
    Ok(TransactionHistoryHostBatch {
        index,
        records,
        has_more,
    })
}

fn encode_history_index(
    writer: &mut TypedWriter,
    index: TransactionHistoryIndex,
) -> Result<(), HostCodecError> {
    writer.u64(index.revision());
    writer.u32(u32::try_from(index.record_count()).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history record count cannot be represented",
        )
    })?);
    writer.u64(u64::try_from(index.durable_weight_bytes()).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history durable weight cannot be represented",
        )
    })?);
    writer.u32(u32::try_from(index.open_count()).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history open count cannot be represented",
        )
    })?);
    writer.u64(u64::try_from(index.open_weight_bytes()).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history open weight cannot be represented",
        )
    })?);
    Ok(())
}

fn decode_history_index(
    reader: &mut TypedReader<'_>,
) -> Result<TransactionHistoryIndex, HostCodecError> {
    let revision = reader.u64()?;
    let record_count = usize::try_from(reader.u32()?)
        .map_err(|_| model_integrity("history record count exceeds this platform"))?;
    let durable_weight = usize::try_from(reader.u64()?)
        .map_err(|_| model_integrity("history durable weight exceeds this platform"))?;
    let open_count = usize::try_from(reader.u32()?)
        .map_err(|_| model_integrity("history open count exceeds this platform"))?;
    let open_weight = usize::try_from(reader.u64()?)
        .map_err(|_| model_integrity("history open weight exceeds this platform"))?;
    TransactionHistoryIndex::try_new(
        revision,
        record_count,
        durable_weight,
        open_count,
        open_weight,
    )
    .map_err(|_| model_integrity("history index is invalid"))
}

fn encode_history_descriptor(
    writer: &mut TypedWriter,
    record: &TransactionExecutionRecord,
) -> Result<(), HostCodecError> {
    writer.fixed(record.execution_id().as_bytes());
    writer.u64(record.created_at_millis());
    writer.u64(record.updated_at_millis());
    writer.u64(u64::try_from(record.durable_weight_bytes()).map_err(|_| {
        HostCodecError::new(
            HostCodecErrorKind::PayloadTooLarge,
            "history record weight cannot be represented",
        )
    })?);
    writer.bool(record.status().is_retention_terminal());
    writer.bool(record.status().is_chain_terminal());
    let encoded = encode_transaction_execution_record(record)?;
    writer.bytes(
        &encoded,
        HostRecordDomain::TransactionHistory.max_encoded_record_bytes(),
    )
}

fn decode_history_descriptor(
    reader: &mut TypedReader<'_>,
) -> Result<TransactionExecutionRecord, HostCodecError> {
    let execution_id = TransactionExecutionId::try_new(reader.fixed()?)
        .map_err(|_| model_integrity("history descriptor execution id is invalid"))?;
    let created = reader.u64()?;
    let updated = reader.u64()?;
    let weight = usize::try_from(reader.u64()?)
        .map_err(|_| model_integrity("history descriptor weight exceeds this platform"))?;
    let retention_terminal = reader.bool()?;
    let chain_terminal = reader.bool()?;
    let encoded = reader.bytes(HostRecordDomain::TransactionHistory.max_encoded_record_bytes())?;
    let record = decode_transaction_execution_record(&encoded)?;
    if record.execution_id() != execution_id
        || record.created_at_millis() != created
        || record.updated_at_millis() != updated
        || record.durable_weight_bytes() != weight
        || record.status().is_retention_terminal() != retention_terminal
        || record.status().is_chain_terminal() != chain_terminal
    {
        return Err(model_integrity(
            "history descriptor disagrees with its opaque record",
        ));
    }
    Ok(record)
}

fn encode_history_status(
    writer: &mut TypedWriter,
    status: &HistoryTransactionStatus,
) -> Result<(), HostCodecError> {
    match status {
        HistoryTransactionStatus::Pending => writer.u8(1),
        HistoryTransactionStatus::InBlock { block } => {
            writer.u8(2);
            encode_block(writer, *block);
        }
        HistoryTransactionStatus::PoolRejected {
            reason,
            replacement_hash,
        } => {
            writer.u8(3);
            writer.string(reason, MAX_POOL_REASON_BYTES)?;
            writer.bool(replacement_hash.is_some());
            if let Some(hash) = replacement_hash {
                writer.fixed(hash.as_bytes());
            }
        }
        HistoryTransactionStatus::Execution(ExecutionConclusion::Success {
            block,
            extrinsic_index,
        }) => {
            writer.u8(4);
            encode_block(writer, *block);
            writer.u32(*extrinsic_index);
        }
        HistoryTransactionStatus::Execution(ExecutionConclusion::Failed {
            block,
            extrinsic_index,
            failure,
        }) => {
            writer.u8(5);
            encode_block(writer, *block);
            writer.u32(*extrinsic_index);
            encode_dispatch_failure(writer, failure)?;
        }
        HistoryTransactionStatus::Execution(ExecutionConclusion::Unverified { .. }) => {
            return Err(model_integrity(
                "unverified execution cannot be persisted in history",
            ));
        }
    }
    Ok(())
}

fn decode_history_status(
    reader: &mut TypedReader<'_>,
) -> Result<HistoryTransactionStatus, HostCodecError> {
    match reader.u8()? {
        1 => Ok(HistoryTransactionStatus::Pending),
        2 => Ok(HistoryTransactionStatus::InBlock {
            block: decode_block(reader)?,
        }),
        3 => {
            let reason = reader.string(MAX_POOL_REASON_BYTES)?;
            let replacement_hash = if reader.bool()? {
                Some(Hash32::from_bytes(reader.fixed()?))
            } else {
                None
            };
            HistoryTransactionStatus::try_pool_rejected_with_replacement(reason, replacement_hash)
                .map_err(|_| model_integrity("persisted pool rejection is invalid"))
        }
        4 => Ok(HistoryTransactionStatus::Execution(
            ExecutionConclusion::Success {
                block: decode_block(reader)?,
                extrinsic_index: reader.u32()?,
            },
        )),
        5 => Ok(HistoryTransactionStatus::Execution(
            ExecutionConclusion::Failed {
                block: decode_block(reader)?,
                extrinsic_index: reader.u32()?,
                failure: decode_dispatch_failure(reader)?,
            },
        )),
        _ => Err(model_integrity(
            "persisted transaction status is unknown or unverified",
        )),
    }
}

fn encode_dispatch_failure(
    writer: &mut TypedWriter,
    failure: &DispatchFailure,
) -> Result<(), HostCodecError> {
    writer.u8(failure.variant());
    writer.bool(failure.module().is_some());
    if let Some(module) = failure.module() {
        writer.u8(module.pallet_index());
        writer.u8(module.error_index());
        encode_optional_string(writer, module.pallet_name(), MAX_PALLET_NAME_BYTES)?;
        encode_optional_string(writer, module.error_name(), MAX_PALLET_NAME_BYTES)?;
    }
    Ok(())
}

fn decode_dispatch_failure(
    reader: &mut TypedReader<'_>,
) -> Result<DispatchFailure, HostCodecError> {
    let variant = reader.u8()?;
    let module = if reader.bool()? {
        Some(ModuleDispatchFailure::new(
            reader.u8()?,
            reader.u8()?,
            decode_optional_string(reader, MAX_PALLET_NAME_BYTES)?,
            decode_optional_string(reader, MAX_PALLET_NAME_BYTES)?,
        ))
    } else {
        None
    };
    Ok(DispatchFailure::new(variant, module))
}

pub fn encode_encrypted_secret_blob_snapshot(
    secret_ref: SecretRef,
    snapshot: &EncryptedSecretBlobSnapshot,
) -> Result<Vec<u8>, HostCodecError> {
    encode_typed(HostRecordDomain::EncryptedSecretBlob, |writer| {
        // The host callback is keyed by SecretRef, but the opaque value binds
        // that identity again.  This prevents a host from crossing sealed or
        // tombstone records between slots while preserving a valid envelope.
        encode_secret_ref(writer, secret_ref);
        writer.u64(snapshot.revision());
        match snapshot.state() {
            EncryptedSecretBlobState::Vacant => writer.u8(1),
            EncryptedSecretBlobState::Sealed {
                provisioning_operation_id,
                envelope,
            } => {
                writer.u8(2);
                writer.fixed(provisioning_operation_id);
                writer.u32(envelope.format_version());
                writer.fixed(envelope.associated_data_digest().as_bytes());
                writer.bytes(envelope.ciphertext(), MAX_ENCRYPTED_ENVELOPE_BYTES)?;
            }
            EncryptedSecretBlobState::Tombstone {
                cleanup_operation_id,
            } => {
                writer.u8(3);
                writer.fixed(cleanup_operation_id);
            }
        }
        Ok(())
    })
}

pub fn decode_encrypted_secret_blob_snapshot(
    expected_secret_ref: SecretRef, encoded: &[u8],
) -> Result<EncryptedSecretBlobSnapshot, HostCodecError> {
    let (secret_ref, snapshot) = decode_encrypted_secret_blob(encoded)?;
    if secret_ref != expected_secret_ref {
        return Err(model_integrity("persisted secret blob is bound to another SecretRef"));
    }
    Ok(snapshot)
}

/// 平台存在性查询复用同一完整解码；不让各语言按偏移猜sealed/tombstone状态。
pub fn encrypted_secret_record_has_secret(
    account_id: AccountId32, expected_revision: u64, encoded: &[u8],
) -> Result<bool, HostCodecError> {
    let (secret_ref, snapshot) = decode_encrypted_secret_blob(encoded)?;
    if snapshot.revision() != expected_revision {
        return Err(model_integrity("encrypted record revision does not match storage"));
    }
    Ok(secret_ref.account_id() == account_id && snapshot.envelope().is_some())
}

fn decode_encrypted_secret_blob(encoded: &[u8]) -> Result<(SecretRef, EncryptedSecretBlobSnapshot), HostCodecError> {
    decode_typed(HostRecordDomain::EncryptedSecretBlob, encoded, |reader| {
        let persisted_secret_ref = decode_secret_ref(reader)?;
        let revision = reader.u64()?;
        let state = match reader.u8()? {
            1 => EncryptedSecretBlobState::Vacant,
            2 => EncryptedSecretBlobState::Sealed {
                provisioning_operation_id: reader.fixed()?,
                envelope: EncryptedSecretEnvelope::try_new(
                    reader.u32()?,
                    Hash32Bytes::from_bytes(reader.fixed()?),
                    reader.bytes(MAX_ENCRYPTED_ENVELOPE_BYTES)?,
                )
                .map_err(|_| model_integrity("persisted secret envelope is invalid"))?,
            },
            3 => EncryptedSecretBlobState::Tombstone {
                cleanup_operation_id: reader.fixed()?,
            },
            _ => return Err(model_integrity("persisted secret blob state is unknown")),
        };
        let snapshot = EncryptedSecretBlobSnapshot::try_from_persisted_parts(revision, state)
            .map_err(|_| model_integrity("persisted secret blob revision is unreachable"))?;
        Ok((persisted_secret_ref, snapshot))
    })
}

fn encode_typed(
    domain: HostRecordDomain,
    encode: impl FnOnce(&mut TypedWriter) -> Result<(), HostCodecError>,
) -> Result<Vec<u8>, HostCodecError> {
    encode_typed_version(domain, TYPED_PAYLOAD_VERSION, encode)
}

fn encode_typed_version(
    domain: HostRecordDomain,
    version: u16,
    encode: impl FnOnce(&mut TypedWriter) -> Result<(), HostCodecError>,
) -> Result<Vec<u8>, HostCodecError> {
    let mut writer = TypedWriter::new();
    writer.u16(version);
    encode(&mut writer)?;
    encode_host_record(domain, &writer.bytes)
}

fn decode_typed<T>(
    domain: HostRecordDomain,
    encoded: &[u8],
    decode: impl FnOnce(&mut TypedReader<'_>) -> Result<T, HostCodecError>,
) -> Result<T, HostCodecError> {
    decode_typed_version(domain, TYPED_PAYLOAD_VERSION, encoded, decode)
}

fn decode_typed_version<T>(
    domain: HostRecordDomain,
    version: u16,
    encoded: &[u8],
    decode: impl FnOnce(&mut TypedReader<'_>) -> Result<T, HostCodecError>,
) -> Result<T, HostCodecError> {
    let record = decode_host_record(domain, encoded)?;
    let mut reader = TypedReader::new(record.payload());
    if reader.u16()? != version {
        return Err(HostCodecError::new(
            HostCodecErrorKind::UnsupportedVersion,
            "typed host payload version is unsupported",
        ));
    }
    let value = decode(&mut reader)?;
    reader.finish()?;
    Ok(value)
}

fn encode_optional<T>(
    writer: &mut TypedWriter,
    value: Option<&T>,
    encode: impl FnOnce(&mut TypedWriter, &T) -> Result<(), HostCodecError>,
) -> Result<(), HostCodecError> {
    writer.bool(value.is_some());
    if let Some(value) = value {
        encode(writer, value)?;
    }
    Ok(())
}

fn decode_optional<T>(
    reader: &mut TypedReader<'_>,
    decode: impl FnOnce(&mut TypedReader<'_>) -> Result<T, HostCodecError>,
) -> Result<Option<T>, HostCodecError> {
    if reader.bool()? {
        decode(reader).map(Some)
    } else {
        Ok(None)
    }
}

fn encode_optional_string(
    writer: &mut TypedWriter,
    value: Option<&str>,
    max_len: usize,
) -> Result<(), HostCodecError> {
    writer.bool(value.is_some());
    if let Some(value) = value {
        writer.string(value, max_len)?;
    }
    Ok(())
}

fn decode_optional_string(
    reader: &mut TypedReader<'_>,
    max_len: usize,
) -> Result<Option<String>, HostCodecError> {
    if reader.bool()? {
        reader.string(max_len).map(Some)
    } else {
        Ok(None)
    }
}

fn model_integrity(message: &'static str) -> HostCodecError {
    HostCodecError::new(HostCodecErrorKind::IntegrityMismatch, message)
}

struct TypedWriter {
    bytes: Vec<u8>,
}

impl TypedWriter {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn fixed(&mut self, value: &[u8]) {
        self.bytes.extend_from_slice(value);
    }

    fn count(&mut self, value: usize, max: usize) -> Result<(), HostCodecError> {
        if value > max {
            return Err(model_integrity("typed host collection exceeds its limit"));
        }
        self.u32(u32::try_from(value).map_err(|_| {
            HostCodecError::new(
                HostCodecErrorKind::PayloadTooLarge,
                "typed host collection count cannot be represented",
            )
        })?);
        Ok(())
    }

    fn bytes(&mut self, value: &[u8], max: usize) -> Result<(), HostCodecError> {
        self.count(value.len(), max)?;
        self.fixed(value);
        Ok(())
    }

    fn string(&mut self, value: &str, max: usize) -> Result<(), HostCodecError> {
        self.bytes(value.as_bytes(), max)
    }
}

struct TypedReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> TypedReader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], HostCodecError> {
        let end = self.offset.checked_add(len).ok_or_else(|| {
            HostCodecError::new(
                HostCodecErrorKind::LengthMismatch,
                "typed host payload offset overflowed",
            )
        })?;
        if end > self.bytes.len() {
            return Err(HostCodecError::new(
                HostCodecErrorKind::LengthMismatch,
                "typed host payload ended unexpectedly",
            ));
        }
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn fixed<const N: usize>(&mut self) -> Result<[u8; N], HostCodecError> {
        self.take(N)?.try_into().map_err(|_| {
            HostCodecError::new(
                HostCodecErrorKind::LengthMismatch,
                "typed host fixed field has the wrong length",
            )
        })
    }

    fn u8(&mut self) -> Result<u8, HostCodecError> {
        Ok(self.fixed::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, HostCodecError> {
        Ok(u16::from_le_bytes(self.fixed()?))
    }

    fn u32(&mut self) -> Result<u32, HostCodecError> {
        Ok(u32::from_le_bytes(self.fixed()?))
    }

    fn u64(&mut self) -> Result<u64, HostCodecError> {
        Ok(u64::from_le_bytes(self.fixed()?))
    }

    fn bool(&mut self) -> Result<bool, HostCodecError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(model_integrity("typed host boolean is not canonical")),
        }
    }

    fn count(&mut self, max: usize) -> Result<usize, HostCodecError> {
        let value = usize::try_from(self.u32()?).map_err(|_| {
            HostCodecError::new(
                HostCodecErrorKind::PayloadTooLarge,
                "typed host collection count exceeds this platform",
            )
        })?;
        if value > max {
            return Err(HostCodecError::new(
                HostCodecErrorKind::PayloadTooLarge,
                "typed host collection exceeds its limit",
            ));
        }
        Ok(value)
    }

    fn bytes(&mut self, max: usize) -> Result<Vec<u8>, HostCodecError> {
        let len = self.count(max)?;
        Ok(self.take(len)?.to_vec())
    }

    fn string(&mut self, max: usize) -> Result<String, HostCodecError> {
        String::from_utf8(self.bytes(max)?).map_err(|_| {
            HostCodecError::new(
                HostCodecErrorKind::Malformed,
                "typed host string is not valid UTF-8",
            )
        })
    }

    fn finish(self) -> Result<(), HostCodecError> {
        if self.offset != self.bytes.len() {
            return Err(HostCodecError::new(
                HostCodecErrorKind::LengthMismatch,
                "typed host payload contains trailing bytes",
            ));
        }
        Ok(())
    }
}
