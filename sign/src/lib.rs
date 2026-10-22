//! CitizenSDK唯一sr25519签名实现，经安全ChainSigner合同供Core使用。
//!
//! 密码学运算只在私有sr25519模块，使用固定substrate上下文和Ed25519扩展模式。
//! 秘密由SecretBuffer同步借用，算法临时秘密由Zeroizing析构清零；公共C边界归ffi。
#![forbid(unsafe_code)]

mod chain_signer;
mod sr25519;

pub use chain_signer::Sr25519SoftwareSigner;
