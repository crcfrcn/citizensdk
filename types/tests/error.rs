use super::{ContractError, ContractErrorCode, FailureStage};

#[test]
fn all_eight_stage_names_are_stable_and_business_neutral() {
    let stages = [
        FailureStage::Admission,
        FailureStage::Validation,
        FailureStage::Authentication,
        FailureStage::Persistence,
        FailureStage::Provider,
        FailureStage::Verification,
        FailureStage::Cancellation,
        FailureStage::Teardown,
    ];
    assert_eq!(
        stages.map(FailureStage::as_str),
        [
            "admission",
            "validation",
            "authentication",
            "persistence",
            "provider",
            "verification",
            "cancellation",
            "teardown",
        ]
    );
}

#[test]
fn explicit_boundary_stage_overrides_only_the_orthogonal_stage() {
    let error = ContractError::new(ContractErrorCode::Network, "provider failed")
        .with_stage(FailureStage::Verification);
    assert_eq!(error.code(), ContractErrorCode::Network);
    assert_eq!(error.stage(), FailureStage::Verification);
    assert_eq!(error.message(), "provider failed");
}
