use std::cell::RefCell;

use citizen_sdk_engine::EngineError;

use crate::abi::{CitizenSdkErrorCode, CitizenSdkFailureStage};

pub type FfiResult<T> = Result<T, FfiError>;

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FfiError {
    pub code: CitizenSdkErrorCode,
    pub stage: CitizenSdkFailureStage,
    pub message: String,
}

impl FfiError {
    pub fn new(code: CitizenSdkErrorCode, message: impl Into<String>) -> Self {
        Self::at_stage(code, default_stage(code), message)
    }

    pub fn at_stage(
        code: CitizenSdkErrorCode,
        stage: CitizenSdkFailureStage,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(CitizenSdkErrorCode::InvalidArgument, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CitizenSdkErrorCode::Internal, message)
    }
}

pub fn set_last_error(error: &FfiError) {
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = error.message.clone();
    });
}

pub fn clear_last_error() {
    LAST_ERROR.with(|slot| slot.borrow_mut().clear());
}

pub fn last_error() -> String {
    LAST_ERROR.with(|slot| slot.borrow().clone())
}

impl From<EngineError> for FfiError {
    fn from(error: EngineError) -> Self {
        let stage = map_contract_stage(error.failure_stage());
        match error {
            EngineError::Contract(contract) => Self::from(contract),
            other => {
                let code = match &other {
                    EngineError::InvalidMetadata(_) | EngineError::InvalidEvents(_) => {
                        CitizenSdkErrorCode::Decode
                    }
                    EngineError::BlockContextMismatch(_) => CitizenSdkErrorCode::Integrity,
                    EngineError::CapabilityUnavailable(_) => CitizenSdkErrorCode::NotReady,
                    EngineError::Cancelled => CitizenSdkErrorCode::Cancelled,
                    EngineError::Contract(_) => unreachable!("handled above"),
                    EngineError::StatePoisoned => CitizenSdkErrorCode::Internal,
                };
                Self::at_stage(code, stage, other.to_string())
            }
        }
    }
}

impl From<citizen_sdk_contracts::ContractError> for FfiError {
    fn from(error: citizen_sdk_contracts::ContractError) -> Self {
        use citizen_sdk_contracts::ContractErrorCode as Contract;
        let code = match error.code() {
            Contract::InvalidArgument => CitizenSdkErrorCode::InvalidArgument,
            Contract::InvalidState => CitizenSdkErrorCode::InvalidState,
            Contract::Unsupported => CitizenSdkErrorCode::Unsupported,
            Contract::Unavailable => CitizenSdkErrorCode::Unavailable,
            Contract::NotReady => CitizenSdkErrorCode::NotReady,
            Contract::NotFound => CitizenSdkErrorCode::NotFound,
            Contract::Conflict => CitizenSdkErrorCode::Conflict,
            Contract::Integrity => CitizenSdkErrorCode::Integrity,
            Contract::AuthenticationCancelled => CitizenSdkErrorCode::AuthenticationCancelled,
            Contract::AuthenticationRequired => CitizenSdkErrorCode::AuthenticationRequired,
            Contract::KeyInvalidated => CitizenSdkErrorCode::KeyInvalidated,
            Contract::PermissionDenied => CitizenSdkErrorCode::PermissionDenied,
            Contract::Storage => CitizenSdkErrorCode::Storage,
            Contract::Network => CitizenSdkErrorCode::Network,
            Contract::Decode => CitizenSdkErrorCode::Decode,
            Contract::Timeout => CitizenSdkErrorCode::Timeout,
            Contract::Internal => CitizenSdkErrorCode::Internal,
        };
        Self::at_stage(code, map_contract_stage(error.stage()), error.to_string())
    }
}

const fn map_contract_stage(stage: citizen_sdk_contracts::FailureStage) -> CitizenSdkFailureStage {
    use citizen_sdk_contracts::FailureStage as Contract;
    match stage {
        Contract::Admission => CitizenSdkFailureStage::Admission,
        Contract::Validation => CitizenSdkFailureStage::Validation,
        Contract::Authentication => CitizenSdkFailureStage::Authentication,
        Contract::Persistence => CitizenSdkFailureStage::Persistence,
        Contract::Provider => CitizenSdkFailureStage::Provider,
        Contract::Verification => CitizenSdkFailureStage::Verification,
        Contract::Cancellation => CitizenSdkFailureStage::Cancellation,
        Contract::Teardown => CitizenSdkFailureStage::Teardown,
    }
}

const fn default_stage(code: CitizenSdkErrorCode) -> CitizenSdkFailureStage {
    match code {
        CitizenSdkErrorCode::InvalidArgument | CitizenSdkErrorCode::Decode => {
            CitizenSdkFailureStage::Validation
        }
        CitizenSdkErrorCode::AuthenticationCancelled
        | CitizenSdkErrorCode::AuthenticationRequired
        | CitizenSdkErrorCode::KeyInvalidated
        | CitizenSdkErrorCode::PermissionDenied => CitizenSdkFailureStage::Authentication,
        CitizenSdkErrorCode::Storage => CitizenSdkFailureStage::Persistence,
        CitizenSdkErrorCode::Unavailable
        | CitizenSdkErrorCode::Network
        | CitizenSdkErrorCode::Timeout => CitizenSdkFailureStage::Provider,
        CitizenSdkErrorCode::Integrity => CitizenSdkFailureStage::Verification,
        CitizenSdkErrorCode::Cancelled => CitizenSdkFailureStage::Cancellation,
        CitizenSdkErrorCode::Internal | CitizenSdkErrorCode::Panic => {
            CitizenSdkFailureStage::Teardown
        }
        CitizenSdkErrorCode::Ok
        | CitizenSdkErrorCode::InvalidHandle
        | CitizenSdkErrorCode::InvalidState
        | CitizenSdkErrorCode::Unsupported
        | CitizenSdkErrorCode::NotReady
        | CitizenSdkErrorCode::NotFound
        | CitizenSdkErrorCode::Conflict
        | CitizenSdkErrorCode::Busy
        | CitizenSdkErrorCode::QueueFull => CitizenSdkFailureStage::Admission,
    }
}

#[cfg(test)]
mod tests {
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
}
