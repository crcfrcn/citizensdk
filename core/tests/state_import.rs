use citizen_sdk_contracts::{ChainIdentity, ExportedChainState, FinalizedBlockRef, Hash32};
use citizen_sdk_engine::{
    validate_import_startup, validate_state_export, validate_state_import, EngineLifecycle,
    StateImportPolicy, StateImportRejection, CHAIN_STATE_FORMAT_VERSION, MAX_CHAIN_DATABASE_BYTES,
};

fn identity(genesis: u8) -> ChainIdentity {
    match ChainIdentity::try_new(
        "citizenchain",
        "citizenchain",
        Hash32::from_bytes([genesis; 32]),
    ) {
        Ok(identity) => identity,
        Err(error) => panic!("identity fixture failed: {error}"),
    }
}

fn state(
    identity: ChainIdentity,
    format: u32,
    finalized: FinalizedBlockRef,
    database: Vec<u8>,
) -> ExportedChainState {
    match ExportedChainState::try_new(identity, format, finalized, database) {
        Ok(state) => state,
        Err(error) => panic!("state fixture failed: {error}"),
    }
}

#[test]
fn import_accepts_exact_non_regressing_pre_start_state() {
    let chain = ChainIdentity::citizenchain();
    let current = FinalizedBlockRef::from_parts(Hash32::from_bytes([8; 32]), 10);
    let imported = FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 12);
    let policy = StateImportPolicy::citizenchain(Some(current));
    let candidate = state(chain, CHAIN_STATE_FORMAT_VERSION, imported, vec![1, 2, 3]);
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &candidate),
        Ok(())
    );
    assert_eq!(validate_import_startup(imported, imported), Ok(()));
}

#[test]
fn import_rejects_lifecycle_identity_format_size_and_finality_drift() {
    let chain = ChainIdentity::citizenchain();
    let current = FinalizedBlockRef::from_parts(Hash32::from_bytes([8; 32]), 10);
    let policy = StateImportPolicy::citizenchain(Some(current));
    let valid = state(
        chain.clone(),
        1,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 12),
        vec![1],
    );
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Running, &valid),
        Err(StateImportRejection::ProviderAlreadyStarted)
    );
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Stopped, &valid),
        Err(StateImportRejection::ProviderAlreadyStarted)
    );
    for lifecycle in [
        EngineLifecycle::ImportingState,
        EngineLifecycle::Starting,
        EngineLifecycle::StartFailed,
        EngineLifecycle::Disposed,
    ] {
        assert_eq!(
            validate_state_import(&policy, lifecycle, &valid),
            Err(StateImportRejection::ProviderAlreadyStarted)
        );
    }

    let wrong_identity = state(identity(6), 1, valid.finalized(), vec![1]);
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &wrong_identity),
        Err(StateImportRejection::ChainIdentityMismatch)
    );
    let wrong_format = state(chain.clone(), 2, valid.finalized(), vec![1]);
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &wrong_format),
        Err(StateImportRejection::FormatVersionMismatch)
    );
    let too_large = state(
        chain.clone(),
        1,
        valid.finalized(),
        vec![0; MAX_CHAIN_DATABASE_BYTES + 1],
    );
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &too_large),
        Err(StateImportRejection::DatabaseTooLarge)
    );
    let regression = state(
        chain.clone(),
        1,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([3; 32]), 9),
        vec![1],
    );
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &regression),
        Err(StateImportRejection::FinalizedHeightRegression)
    );
    let conflict = state(
        chain,
        1,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([4; 32]), 10),
        vec![1],
    );
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &conflict),
        Err(StateImportRejection::FinalizedHashConflict)
    );
}

#[test]
fn genesis_and_export_anchors_are_strict() {
    let chain = ChainIdentity::citizenchain();
    let policy = StateImportPolicy::citizenchain(None);
    let wrong_genesis = state(
        chain.clone(),
        1,
        FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 0),
        vec![1],
    );
    assert_eq!(
        validate_state_import(&policy, EngineLifecycle::Created, &wrong_genesis),
        Err(StateImportRejection::GenesisAnchorMismatch)
    );

    let anchor = FinalizedBlockRef::from_parts(Hash32::from_bytes([8; 32]), 20);
    let exported = state(chain, 1, anchor, vec![1, 2]);
    assert_eq!(
        validate_state_export(&policy, EngineLifecycle::Running, anchor, &exported, anchor,),
        Ok(())
    );
    let moved = FinalizedBlockRef::from_parts(Hash32::from_bytes([9; 32]), 21);
    assert_eq!(
        validate_state_export(&policy, EngineLifecycle::Running, anchor, &exported, moved,),
        Err(StateImportRejection::ExportAnchorMoved)
    );
    assert_eq!(
        validate_import_startup(
            anchor,
            FinalizedBlockRef::from_parts(Hash32::from_bytes([1; 32]), 19)
        ),
        Err(StateImportRejection::StartupAnchorRegression)
    );
}
