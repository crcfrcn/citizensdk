//! 公共持久化的唯一实现；数据库机械调用与文件安全由平台资源提供。
#![deny(unsafe_code)]
pub mod codec;
pub mod error;
pub mod key;
pub mod public;
pub mod schema;
pub mod secure;
#[allow(unsafe_code)]
pub mod sqlite;
pub mod vault;

pub use public::PublicStore;

pub use secure::SecureStore;
