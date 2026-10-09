use core::fmt;

use citizen_sdk_contracts::{ContractError, ContractErrorCode, FailureStage};

/// Stable Rust-side failure categories used before the C ABI maps them to
/// numeric public error codes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineError {
    /// Runtime metadata is malformed, unsupported, or has trailing bytes.
    InvalidMetadata(String),
    /// `System.Events` cannot be decoded completely with the exact metadata.
    InvalidEvents(String),
    /// Evidence combines different blocks or contradicts its verified anchor.
    BlockContextMismatch(String),
    /// A capability dependency is unavailable for the requested operation.
    CapabilityUnavailable(String),
    /// A provider, typed store, or validated contract rejected an operation.
    /// The stable typed code is retained all the way to language bindings.
    Contract(ContractError),
    /// SDK 自有查看已撤销；区别于金库返回的生物认证取消。
    Cancelled,
    /// Internal synchronized state was poisoned and is no longer trustworthy.
    StatePoisoned,
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMetadata(reason) => {
                write!(formatter, "invalid runtime metadata: {reason}")
            }
            Self::InvalidEvents(reason) => write!(formatter, "invalid System.Events: {reason}"),
            Self::BlockContextMismatch(reason) => {
                write!(formatter, "verified block context mismatch: {reason}")
            }
            Self::CapabilityUnavailable(reason) => {
                write!(formatter, "capability unavailable: {reason}")
            }
            Self::Contract(error) => write!(formatter, "typed contract failed: {error}"),
            Self::Cancelled => formatter.write_str("SDK operation was cancelled"),
            Self::StatePoisoned => formatter.write_str("engine synchronized state is poisoned"),
        }
    }
}

impl EngineError {
    pub fn contract(code: ContractErrorCode, message: impl Into<String>) -> Self {
        Self::Contract(ContractError::new(code, message))
    }

    pub fn contract_at(
        stage: FailureStage,
        code: ContractErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self::Contract(ContractError::at_stage(code, stage, message))
    }

    pub(crate) const fn contract_code(&self) -> Option<ContractErrorCode> {
        match self {
            Self::Contract(error) => Some(error.code()),
            _ => None,
        }
    }

    /// 稳定阶段由真实失败边界决定，不要求绑定层解析英文诊断文本。
    pub const fn failure_stage(&self) -> FailureStage {
        match self {
            Self::InvalidMetadata(_) => FailureStage::Validation,
            Self::InvalidEvents(_) | Self::BlockContextMismatch(_) => FailureStage::Verification,
            Self::CapabilityUnavailable(_) => FailureStage::Admission,
            Self::Contract(error) => error.stage(),
            Self::Cancelled => FailureStage::Cancellation,
            Self::StatePoisoned => FailureStage::Teardown,
        }
    }
}

impl From<ContractError> for EngineError {
    fn from(error: ContractError) -> Self {
        Self::Contract(error)
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Contract(error) => Some(error),
            _ => None,
        }
    }
}
