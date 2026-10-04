//! 合同层稳定错误类别；C ABI 数字码不在本层冻结。

use std::{error::Error, fmt};

/// Engine 可以稳定分类的合同错误。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractErrorCode {
    InvalidArgument,
    InvalidState,
    Unsupported,
    Unavailable,
    NotReady,
    NotFound,
    Conflict,
    Integrity,
    AuthenticationCancelled,
    AuthenticationRequired,
    KeyInvalidated,
    PermissionDenied,
    Storage,
    Network,
    Decode,
    Timeout,
    Internal,
}

/// 与业务无关的失败阶段。错误码回答“发生了什么”，阶段回答“在哪个 SDK 边界失败”。
///
/// 该闭集不得承载 App action、pallet、页面或产品语义；绑定层可以稳定地把它投影到
/// Android、Apple、Dart、Linux 和 Windows，而不解析诊断文本。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureStage {
    Admission,
    Validation,
    Authentication,
    Persistence,
    Provider,
    Verification,
    Cancellation,
    Teardown,
}

impl FailureStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::Validation => "validation",
            Self::Authentication => "authentication",
            Self::Persistence => "persistence",
            Self::Provider => "provider",
            Self::Verification => "verification",
            Self::Cancellation => "cancellation",
            Self::Teardown => "teardown",
        }
    }
}

impl ContractErrorCode {
    /// 稳定、与语言无关的文本码；面向用户的本地化文案由绑定层处理。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "invalid_argument",
            Self::InvalidState => "invalid_state",
            Self::Unsupported => "unsupported",
            Self::Unavailable => "unavailable",
            Self::NotReady => "not_ready",
            Self::NotFound => "not_found",
            Self::Conflict => "conflict",
            Self::Integrity => "integrity",
            Self::AuthenticationCancelled => "authentication_cancelled",
            Self::AuthenticationRequired => "authentication_required",
            Self::KeyInvalidated => "key_invalidated",
            Self::PermissionDenied => "permission_denied",
            Self::Storage => "storage",
            Self::Network => "network",
            Self::Decode => "decode",
            Self::Timeout => "timeout",
            Self::Internal => "internal",
        }
    }
}

/// 不包含秘密字节的合同错误。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractError {
    code: ContractErrorCode,
    stage: FailureStage,
    message: String,
}

impl ContractError {
    pub fn new(code: ContractErrorCode, message: impl Into<String>) -> Self {
        Self::at_stage(code, default_stage(code), message)
    }

    /// 在实际失败边界显式标注阶段；诊断文本仍不得包含秘密或原始链数据。
    pub fn at_stage(
        code: ContractErrorCode,
        stage: FailureStage,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            stage,
            message: message.into(),
        }
    }

    pub fn with_stage(mut self, stage: FailureStage) -> Self {
        self.stage = stage;
        self
    }

    pub const fn code(&self) -> ContractErrorCode {
        self.code
    }

    pub const fn stage(&self) -> FailureStage {
        self.stage
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

const fn default_stage(code: ContractErrorCode) -> FailureStage {
    match code {
        ContractErrorCode::InvalidArgument | ContractErrorCode::Decode => FailureStage::Validation,
        ContractErrorCode::AuthenticationCancelled
        | ContractErrorCode::AuthenticationRequired
        | ContractErrorCode::KeyInvalidated
        | ContractErrorCode::PermissionDenied => FailureStage::Authentication,
        ContractErrorCode::Storage => FailureStage::Persistence,
        ContractErrorCode::Unavailable
        | ContractErrorCode::Network
        | ContractErrorCode::Timeout => FailureStage::Provider,
        ContractErrorCode::Integrity => FailureStage::Verification,
        ContractErrorCode::Internal => FailureStage::Teardown,
        ContractErrorCode::InvalidState
        | ContractErrorCode::Unsupported
        | ContractErrorCode::NotReady
        | ContractErrorCode::NotFound
        | ContractErrorCode::Conflict => FailureStage::Admission,
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl Error for ContractError {}

pub type ContractResult<T> = Result<T, ContractError>;

#[cfg(test)]
mod tests {
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
}
