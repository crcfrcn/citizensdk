use citizen_sdk_contracts::{ContractError, ContractErrorCode, FailureStage};
use citizen_sdk_engine::EngineError;

use super::FfiError;
use crate::abi::{CitizenSdkErrorCode, CitizenSdkFailureStage};

#[test]
fn every_typed_contract_code_survives_engine_and_abi_mapping() {
    let cases = [
        (
            ContractErrorCode::InvalidArgument,
            CitizenSdkErrorCode::InvalidArgument,
        ),
        (
            ContractErrorCode::InvalidState,
            CitizenSdkErrorCode::InvalidState,
        ),
        (
            ContractErrorCode::Unsupported,
            CitizenSdkErrorCode::Unsupported,
        ),
        (
            ContractErrorCode::Unavailable,
            CitizenSdkErrorCode::Unavailable,
        ),
        (ContractErrorCode::NotReady, CitizenSdkErrorCode::NotReady),
        (ContractErrorCode::NotFound, CitizenSdkErrorCode::NotFound),
        (ContractErrorCode::Conflict, CitizenSdkErrorCode::Conflict),
        (ContractErrorCode::Integrity, CitizenSdkErrorCode::Integrity),
        (
            ContractErrorCode::AuthenticationCancelled,
            CitizenSdkErrorCode::AuthenticationCancelled,
        ),
        (
            ContractErrorCode::AuthenticationRequired,
            CitizenSdkErrorCode::AuthenticationRequired,
        ),
        (
            ContractErrorCode::KeyInvalidated,
            CitizenSdkErrorCode::KeyInvalidated,
        ),
        (
            ContractErrorCode::PermissionDenied,
            CitizenSdkErrorCode::PermissionDenied,
        ),
        (ContractErrorCode::Storage, CitizenSdkErrorCode::Storage),
        (ContractErrorCode::Network, CitizenSdkErrorCode::Network),
        (ContractErrorCode::Decode, CitizenSdkErrorCode::Decode),
        (ContractErrorCode::Timeout, CitizenSdkErrorCode::Timeout),
        (ContractErrorCode::Internal, CitizenSdkErrorCode::Internal),
    ];

    for (contract, expected) in cases {
        let engine = EngineError::from(ContractError::new(contract, "typed failure"));
        let ffi = FfiError::from(engine);
        assert_eq!(ffi.code, expected, "contract code {contract:?}");
        assert_ne!(ffi.stage as u32, 0, "contract stage {contract:?}");
        assert!(ffi.message.contains(contract.as_str()));
    }
}

#[test]
fn explicit_contract_stage_survives_engine_and_abi_mapping() {
    for (contract, expected) in [
        (FailureStage::Admission, CitizenSdkFailureStage::Admission),
        (FailureStage::Validation, CitizenSdkFailureStage::Validation),
        (
            FailureStage::Authentication,
            CitizenSdkFailureStage::Authentication,
        ),
        (
            FailureStage::Persistence,
            CitizenSdkFailureStage::Persistence,
        ),
        (FailureStage::Provider, CitizenSdkFailureStage::Provider),
        (
            FailureStage::Verification,
            CitizenSdkFailureStage::Verification,
        ),
        (
            FailureStage::Cancellation,
            CitizenSdkFailureStage::Cancellation,
        ),
        (FailureStage::Teardown, CitizenSdkFailureStage::Teardown),
    ] {
        let ffi = FfiError::from(EngineError::from(ContractError::at_stage(
            ContractErrorCode::Conflict,
            contract,
            "stage test",
        )));
        assert_eq!(ffi.code, CitizenSdkErrorCode::Conflict);
        assert_eq!(ffi.stage, expected);
    }
}

#[test]
fn all_twenty_two_public_failure_codes_have_one_closed_default_stage() {
    use CitizenSdkErrorCode as Code;
    use CitizenSdkFailureStage as Stage;

    let cases = [
        (Code::InvalidArgument, Stage::Validation),
        (Code::InvalidHandle, Stage::Admission),
        (Code::InvalidState, Stage::Admission),
        (Code::Unsupported, Stage::Admission),
        (Code::Unavailable, Stage::Provider),
        (Code::NotReady, Stage::Admission),
        (Code::NotFound, Stage::Admission),
        (Code::Conflict, Stage::Admission),
        (Code::Integrity, Stage::Verification),
        (Code::AuthenticationCancelled, Stage::Authentication),
        (Code::AuthenticationRequired, Stage::Authentication),
        (Code::KeyInvalidated, Stage::Authentication),
        (Code::PermissionDenied, Stage::Authentication),
        (Code::Storage, Stage::Persistence),
        (Code::Network, Stage::Provider),
        (Code::Decode, Stage::Validation),
        (Code::Timeout, Stage::Provider),
        (Code::Busy, Stage::Admission),
        (Code::QueueFull, Stage::Admission),
        (Code::Internal, Stage::Teardown),
        (Code::Panic, Stage::Teardown),
        (Code::Cancelled, Stage::Cancellation),
    ];
    assert_eq!(cases.len(), 22);
    for (code, expected) in cases {
        assert_eq!(super::default_stage(code), expected, "code {code:?}");
    }
}
