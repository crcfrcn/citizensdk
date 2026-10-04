//! CitizenSDK 唯一 QR_V1 协议与扫码签名会话。
//!
//! 本 crate 严格区分二维码公开传输与账户秘密：这里只保存有界公开载荷、请求身份和
//! 签名结果；私钥只能由现有 signing 模块在设备授权后使用。

#![forbid(unsafe_code)]

mod codec;
mod session;

pub use codec::{
    encode_document, prepare_account_authorization,
    parse, AccountIdCode, AccountDataKeyResponse, UserContactCode, UserTransferCode,
    QrCode, QrScanPurpose, QrError, QrErrorCode, SignRequest, SignResponse,
    MAX_QR_JSON_BYTES, MAX_QR_TEXT_BYTES, QR_V1,
};
pub use session::{QrClock, QrSession, QrSessionStore, SystemQrClock};
