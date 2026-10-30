use std::cell::Cell;
use std::cell::RefCell;
use std::sync::Once;

use crate::EngineError;

use crate::abi::types::CitizenSdkErrorCode;
use crate::abi::types::CitizenSdkFailureStage;

pub type FfiResult<T> = Result<T, FfiError>;

static SAFE_PANIC_HOOK: Once = Once::new();
thread_local! { static IN_SDK_BOUNDARY: Cell<bool> = const { Cell::new(false) }; }
struct SdkPanicScope(bool);
impl Drop for SdkPanicScope {
    fn drop(&mut self) {
        let _ = IN_SDK_BOUNDARY.try_with(|active| active.set(self.0));
    }
}

/// catch_unwind之前的默认hook也会打印载荷；SDK边界内必须抑制它，不能只清洗返回值。
/// 非SDK线程及宿主自己的panic仍交还原hook，不改变其原始诊断行为。
pub(crate) fn catch_native_panic<T>(operation: impl FnOnce() -> T) -> std::thread::Result<T> {
    if !std::thread::panicking() {
        SAFE_PANIC_HOOK.call_once(|| {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if IN_SDK_BOUNDARY.try_with(Cell::get).unwrap_or(false) {
                    // 固定字节，不读取payload、source location或任何被捕获对象。
                    let _ = std::io::Write::write_all(
                        &mut std::io::stderr(),
                        b"CitizenSDK native panic captured\n",
                    );
                } else {
                    previous(info);
                }
            }));
        });
    }
    let old = IN_SDK_BOUNDARY.with(|active| active.replace(true));
    let _scope = SdkPanicScope(old);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
}

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

impl From<crate::types::ContractError> for FfiError {
    fn from(error: crate::types::ContractError) -> Self {
        use crate::types::ContractErrorCode as Contract;
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

const fn map_contract_stage(stage: crate::types::FailureStage) -> CitizenSdkFailureStage {
    use crate::types::FailureStage as Contract;
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
#[path = "../../tests/abi/error.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/abi/panic.rs"]
mod safe_panic_tests;
