//! 存储错误使用现有类型合同；公开C数字码只在FFI边界映射。
use citizen_sdk_contracts::{ContractError, ContractErrorCode};

pub fn error(code: ContractErrorCode, message: &'static str) -> ContractError {
    ContractError::new(code, message)
}

pub fn integrity(message: &'static str) -> ContractError {
    error(ContractErrorCode::Integrity, message)
}

pub fn invalid(message: &'static str) -> ContractError {
    error(ContractErrorCode::InvalidArgument, message)
}

pub fn codec(value: crate::codec::HostCodecError) -> ContractError {
    error(value.contract_code(), value.message())
}
