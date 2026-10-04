//! CitizenSDK 的正式 smoldot `VerifiedChainClient` provider。
//!
//! 上层只能取得类型化链能力；任意 JSON-RPC 方法名和参数都被封装在 crate 私有
//! `legacy` 适配器中，不能穿透到 Flutter、Swift、Kotlin 或 C ABI。

#![forbid(unsafe_code)]

mod account_nonce;
mod bootstrap;
mod client;
mod legacy;
mod verified_chain_client;

pub use client::{
    ProviderLifecycle, SmoldotProviderConfig, SmoldotProviderStatus, SmoldotVerifiedChainClient,
};
