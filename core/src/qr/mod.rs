//! CitizenSDK 唯一 QR_V1 协议与扫码签名会话。
//!
//! 本 crate 严格区分二维码公开传输与账户秘密：这里只保存有界公开载荷、请求身份和
//! 签名结果；私钥只能由现有 signing 模块在设备授权后使用。

#![forbid(unsafe_code)]

mod codec;
mod session;

pub use codec::encode_document;
pub use codec::parse;
pub use codec::prepare_account_authorization;
pub use codec::AccountIdCode;
pub use codec::QrCode;
pub use codec::QrError;
pub use codec::QrErrorCode;
pub use codec::QrScanPurpose;
pub use codec::SignRequest;
pub use codec::SignResponse;
pub use codec::UserContactCode;
pub use codec::UserTransferCode;
pub use codec::MAX_QR_JSON_BYTES;
pub use codec::MAX_QR_TEXT_BYTES;
pub use codec::QR_V1;
pub use session::QrClock;
pub use session::QrSession;
pub use session::QrSessionStore;
pub use session::SystemQrClock;
