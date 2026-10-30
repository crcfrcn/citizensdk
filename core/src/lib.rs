//! CitizenSDK product-independent Rust Core Engine.

#![deny(unsafe_code)]

#[cfg(feature = "chain")]
pub mod account_state;
pub mod capabilities;
mod chain_monitor;
pub mod engine;
pub mod error;
#[cfg(feature = "chain")]
mod finalized_history_runtime;
#[cfg(feature = "chain")]
mod metadata;
#[cfg(all(feature = "qr", feature = "chain"))]
mod qr_review;
#[cfg(all(test, feature = "qr", feature = "chain"))]
#[path = "../tests/review.rs"]
mod qr_review_tests;
pub mod runtime_context;
pub mod state_import;
#[cfg(feature = "chain")]
pub mod system_events;
#[cfg(feature = "chain")]
mod transaction_execution;
#[cfg(feature = "chain")]
mod transaction_history;
#[cfg(feature = "chain")]
pub mod transaction_outcome;
#[cfg(feature = "chain")]
mod transaction_prepare;
mod wallet_derivation;
#[cfg(test)]
#[path = "../tests/derivation.rs"]
mod wallet_derivation_tests;
mod wallet_input;
#[cfg(test)]
#[path = "../tests/input.rs"]
mod wallet_input_tests;
mod wallet_service;

#[cfg(feature = "chain")]
pub use account_state::AccountStateService;
#[cfg(feature = "chain")]
pub use account_state::BestFeeSnapshot;
pub use capabilities::resolve_capabilities;
pub use capabilities::CapabilityProbe;
pub use capabilities::CapabilityTracker;
pub use chain_monitor::ChainMonitorUpdate;
pub use engine::CitizenEngine;
pub use engine::EngineFuture;
pub use engine::TransactionExecutionStart;
pub use error::EngineError;
#[cfg(all(feature = "qr", feature = "chain"))]
pub use qr_review::QrReview;
pub use runtime_context::RuntimeContextCache;
pub use runtime_context::RuntimeContextRequest;
pub use runtime_context::MAX_RUNTIME_CONTEXTS;
pub use state_import::validate_import_startup;
pub use state_import::validate_state_export;
pub use state_import::validate_state_import;
pub use state_import::EngineLifecycle;
pub use state_import::StateImportPolicy;
pub use state_import::StateImportRejection;
pub use state_import::CHAIN_STATE_FORMAT_VERSION;
pub use state_import::MAX_CHAIN_DATABASE_BYTES;
#[cfg(feature = "chain")]
pub use system_events::decode_system_outcome;
#[cfg(feature = "chain")]
pub use system_events::DecodedDispatchFailure;
#[cfg(feature = "chain")]
pub use system_events::DecodedSystemOutcome;
#[cfg(feature = "chain")]
pub use transaction_execution::TransactionExecutionCancellation;
#[cfg(feature = "chain")]
pub use transaction_outcome::signed_extrinsic_hash;
#[cfg(feature = "chain")]
pub use transaction_outcome::verify_transaction_outcome;
#[cfg(feature = "chain")]
pub use transaction_outcome::TransactionEvidence;
pub use wallet_derivation::validate_wallet_password;
pub use wallet_derivation::WalletWordCount;
pub use wallet_input::validate_wallet_mnemonic;
pub use wallet_input::wallet_mnemonic_validation;
pub use wallet_input::wallet_password_validation;
pub use wallet_input::wallet_word_suggestions;
pub use wallet_input::WalletInputReason;
pub use wallet_input::WalletInputValidation;
pub use wallet_service::PreparedWalletCreation;
pub use wallet_service::WalletInitializationState;
pub use wallet_service::WalletStateSnapshot;

/// 定向真机交易诊断只输出编译期阶段名与耗时，不接收账户、签名或错误描述。
/// 默认关闭；诊断进程显式启用后，失败和取消也由作用域析构记录，避免漏掉慢阶段。
pub(crate) mod transaction_diagnostic {
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    pub(crate) struct Span {
        stage: &'static str,
        started: Option<Instant>,
        completed: bool,
    }

    pub(crate) fn event(stage: &'static str) {
        if enabled() {
            eprintln!("CITIZENSDK_TX_DIAG at_ms={} stage={stage}", timestamp());
        }
    }

    fn enabled() -> bool {
        std::env::var_os("CITIZENSDK_TRANSACTION_DIAGNOSTICS").as_deref()
            == Some(std::ffi::OsStr::new("1"))
    }

    fn timestamp() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |value| value.as_millis())
    }

    impl Span {
        pub(crate) fn start(stage: &'static str) -> Self {
            let started = enabled().then(Instant::now);
            if started.is_some() {
                event(stage);
            }
            Self {
                stage,
                started,
                completed: false,
            }
        }

        pub(crate) fn finish(mut self) {
            self.completed = true;
        }
    }

    impl Drop for Span {
        fn drop(&mut self) {
            if let Some(started) = self.started {
                eprintln!(
                    "CITIZENSDK_TX_DIAG at_ms={} stage={} elapsed_us={} completed={}",
                    timestamp(),
                    self.stage,
                    started.elapsed().as_micros(),
                    self.completed
                );
            }
        }
    }
}

// 一个Rust库直接拥有业务、系统资源和C导出；不再跨第一方包装配。
#[allow(unsafe_code)]
pub mod abi;
pub(crate) mod assets;
#[cfg(feature = "chain")]
pub(crate) mod chain;
#[allow(unsafe_code)]
pub(crate) mod host;
#[cfg(feature = "qr")]
pub mod qr;
#[allow(unsafe_code)]
pub(crate) mod runtime;
pub mod sign;
pub mod store;
pub mod types;
