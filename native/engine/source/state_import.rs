use citizen_sdk_contracts::{ChainIdentity, ExportedChainState, FinalizedBlockRef};

/// CitizenSDK 当前公开链数据库信封格式。
pub const CHAIN_STATE_FORMAT_VERSION: u32 = 1;

/// Provider lifecycle relevant to state import. Import is legal only while an
/// Engine instance has never started its light client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineLifecycle {
    Created,
    ImportingState,
    Starting,
    Running,
    Stopped,
    StartFailed,
    Disposed,
}

/// Stable, fail-closed reasons for rejecting imported light-client state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateImportRejection {
    ProviderAlreadyStarted,
    ChainIdentityMismatch,
    FormatVersionMismatch,
    DatabaseTooLarge,
    GenesisAnchorMismatch,
    FinalizedHeightRegression,
    FinalizedHashConflict,
    StartupAnchorRegression,
    ExportLifecycleInvalid,
    ExportAnchorMoved,
    ExportEnvelopeMismatch,
}

/// Same public database ceiling as the existing verified CitizenSDK light
/// client implementation.
pub const MAX_CHAIN_DATABASE_BYTES: usize = 256 * 1024;

/// Immutable import expectations established from the verified bundled chain
/// manifest and any already persisted finalized anchor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateImportPolicy {
    identity: ChainIdentity,
    format_version: u32,
    current_finalized: Option<FinalizedBlockRef>,
}

impl StateImportPolicy {
    /// 只建立 CitizenSDK 随包 manifest 对应的正式链策略；绑定层不能注入第二套链身份或格式。
    pub fn citizenchain(current_finalized: Option<FinalizedBlockRef>) -> Self {
        Self {
            identity: ChainIdentity::citizenchain(),
            format_version: CHAIN_STATE_FORMAT_VERSION,
            current_finalized,
        }
    }

    pub fn identity(&self) -> &ChainIdentity {
        &self.identity
    }

    pub const fn format_version(&self) -> u32 {
        self.format_version
    }

    pub const fn current_finalized(&self) -> Option<FinalizedBlockRef> {
        self.current_finalized
    }
}

/// Validate state before passing it to `VerifiedChainClient::import_state`.
pub fn validate_state_import(
    policy: &StateImportPolicy,
    lifecycle: EngineLifecycle,
    state: &ExportedChainState,
) -> Result<(), StateImportRejection> {
    if lifecycle != EngineLifecycle::Created {
        return Err(StateImportRejection::ProviderAlreadyStarted);
    }
    if state.identity() != policy.identity() {
        return Err(StateImportRejection::ChainIdentityMismatch);
    }
    if state.format_version() != policy.format_version() {
        return Err(StateImportRejection::FormatVersionMismatch);
    }
    if state.database().len() > MAX_CHAIN_DATABASE_BYTES {
        return Err(StateImportRejection::DatabaseTooLarge);
    }
    if state.finalized().number() == 0
        && state.finalized().hash() != policy.identity().genesis_hash()
    {
        return Err(StateImportRejection::GenesisAnchorMismatch);
    }
    if let Some(current) = policy.current_finalized() {
        let imported = state.finalized();
        if imported.number() < current.number() {
            return Err(StateImportRejection::FinalizedHeightRegression);
        }
        if imported.number() == current.number() && imported.hash() != current.hash() {
            return Err(StateImportRejection::FinalizedHashConflict);
        }
    }
    Ok(())
}

/// Complete the provisional import gate after the provider has started and
/// exposed its independently verified finalized head.
pub fn validate_import_startup(
    receipt: FinalizedBlockRef,
    verified_finalized: FinalizedBlockRef,
) -> Result<(), StateImportRejection> {
    if verified_finalized.number() < receipt.number() {
        return Err(StateImportRejection::StartupAnchorRegression);
    }
    if verified_finalized.number() == receipt.number()
        && verified_finalized.hash() != receipt.hash()
    {
        return Err(StateImportRejection::FinalizedHashConflict);
    }
    Ok(())
}

/// Validate an exported state against stable finalized anchors captured before
/// and after serialization. A moving anchor must be retried, never persisted
/// as if it were an atomic snapshot.
pub fn validate_state_export(
    policy: &StateImportPolicy,
    lifecycle: EngineLifecycle,
    before: FinalizedBlockRef,
    state: &ExportedChainState,
    after: FinalizedBlockRef,
) -> Result<(), StateImportRejection> {
    if lifecycle != EngineLifecycle::Running {
        return Err(StateImportRejection::ExportLifecycleInvalid);
    }
    if before != after {
        return Err(StateImportRejection::ExportAnchorMoved);
    }
    if state.identity() != policy.identity()
        || state.format_version() != policy.format_version()
        || state.finalized() != before
        || state.database().len() > MAX_CHAIN_DATABASE_BYTES
    {
        return Err(StateImportRejection::ExportEnvelopeMismatch);
    }
    Ok(())
}
