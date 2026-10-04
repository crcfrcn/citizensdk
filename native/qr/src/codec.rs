use std::collections::BTreeSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use citizen_sdk_contracts::{
    apply_signing_transform, AccountId32, SigningTransform, Sr25519PublicKey, Sr25519Signature,
};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

use crate::{QrClock, SystemQrClock};

pub const QR_V1: &str = "QR_V1";
/// QR Code Model 2、纠错等级 M 的最大字节容量。
pub const MAX_QR_TEXT_BYTES: usize = 2_331;
pub const MAX_QR_JSON_BYTES: usize = 65_536;
const MAX_REVIEW_PAYLOAD_BYTES: usize = 1_920;
const MAX_REQUEST_ID_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QrErrorCode {
    InvalidFormat,
    InvalidField,
    UnsupportedKind,
    Expired,
    MismatchedRequest,
    MismatchedAccount,
    AlreadyConsumed,
    InvalidSignature,
    CapacityExceeded,
    EntropyUnavailable,
    ClockUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QrError {
    code: QrErrorCode,
    message: &'static str,
}

impl QrError {
    pub const fn new(code: QrErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn code(&self) -> QrErrorCode {
        self.code
    }

    pub const fn message(&self) -> &'static str {
        self.message
    }
}

impl std::fmt::Display for QrError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for QrError {}

pub type QrResult<T> = Result<T, QrError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignRequest {
    pub request_id: String,
    pub expires_at: u64,
    pub action: u16,
    /// 原a10/a11允许由签名端选择账户；None不能伪装成全零账户。
    pub signer_public_key: Option<Sr25519PublicKey>,
    pub review_payload: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignResponse {
    pub request_id: String,
    pub expires_at: u64,
    pub signer_public_key: Sr25519PublicKey,
    pub signature: Sr25519Signature,
    /// 原换绑响应o/r同时有无，类型上禁止只持有其中一半。
    pub current_account: Option<(AccountId32, Sr25519Signature)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountIdCode {
    pub account_id: AccountId32,
}

/// 原用户码仅声明CID与账户；真实链上绑定由对应能力核验，解析不把声明当作认证。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserContactCode {
    pub cid_number: String,
    pub account_id: AccountId32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserTransferCode {
    pub request_id: String,
    pub expires_at: u64,
    pub account_id: AccountId32,
    pub amount: String,
    pub symbol: String,
    pub memo: String,
    pub bank_cid_number: String,
}

/// 只解析原k6密文封装，不在扫码解析过程中解密、导出或持久化用途钥。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountDataKeyResponse {
    pub request_id: String,
    pub expires_at: u64,
    pub signer_public_key: Sr25519PublicKey,
    pub signature: Sr25519Signature,
    pub key_exchange_public_key: [u8; 32],
    pub encryption_nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

/// 宿主用途不是wire码型；唯一允许集在Core，语言绑定只投影位图。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum QrScanPurpose {
    ColdAccountImport = 1,
    TransferRecipient = 2,
    Contact = 3,
    ExternalSignature = 4,
    SigningRequest = 5,
    AccountDataKey = 6,
    GeneralScan = 7,
    AccountTarget = 8,
}

impl QrScanPurpose {
    const fn bit(self) -> u8 { 1 << (self as u8 - 1) }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QrCode {
    SignRequest(SignRequest),
    SignResponse(SignResponse),
    UserContact(UserContactCode),
    UserTransfer(UserTransferCode),
    AccountId(AccountIdCode),
    AccountDataKeyResponse(AccountDataKeyResponse),
}

/// 生产解析只使用 SDK 时钟；测试钟不会进入 FFI 或平台调用合同。
pub fn parse(raw: &str) -> QrResult<QrCode> {
    let now = SystemQrClock.now_epoch_seconds();
    if now == 0 {
        return Err(QrError::new(
            QrErrorCode::ClockUnavailable,
            "系统时钟不可用",
        ));
    }
    parse_at(raw, now)
}

pub(crate) fn parse_at(raw: &str, now_epoch_seconds: u64) -> QrResult<QrCode> {
    if raw.is_empty() || raw.len() > MAX_QR_TEXT_BYTES {
        return Err(QrError::new(
            QrErrorCode::CapacityExceeded,
            "二维码文本为空或超过单码容量",
        ));
    }
    let value = serde_json::from_str::<StrictValue>(raw)
        .map_err(|_| QrError::new(QrErrorCode::InvalidFormat, "二维码不是规范 JSON"))?
        .0;
    let envelope = object(&value, "二维码 envelope 必须是对象")?;
    if string(envelope, "p")? != QR_V1 {
        return Err(QrError::new(
            QrErrorCode::InvalidField,
            "二维码协议必须是 QR_V1",
        ));
    }
    let kind = unsigned(envelope, "k")?;
    // 承接原App现有k3/k4/k6，不重新定义wire；冷导入通过独立用途只接k5。
    match kind {
        1 => parse_sign_request(envelope, now_epoch_seconds),
        2 => parse_sign_response(envelope, now_epoch_seconds),
        3 => parse_user_contact(envelope),
        4 => parse_user_transfer(envelope, now_epoch_seconds),
        5 => parse_account_id(envelope),
        6 => parse_account_data_key(envelope, now_epoch_seconds),
        _ => Err(QrError::new(
            QrErrorCode::UnsupportedKind,
            "CitizenSDK 不处理该二维码类型",
        )),
    }
}


/// 规范长字段输入只在SDK绑定边界使用；真实wire仍只由下列既有编码器产生。
/// 返回编码事实，不产生签名、会话消费或“已认证”声明。
pub fn encode_document(input_json: &str) -> QrResult<Value> {
    if input_json.len() > MAX_QR_JSON_BYTES { return Err(invalid_field("编码输入超过64KiB")); }
    let input = serde_json::from_str::<StrictValue>(input_json)
        .map_err(|_| invalid_field("编码输入不是无重复键JSON"))?.0;
    let fields = object(&input, "编码输入必须是对象")?;
    let kind = unsigned(fields, "kind")?;
    let expiry = |fields: &Map<String, Value>| -> QrResult<u64> {
        decimal(string(fields, "expires_at")?)
    };
    let account = |name| decode_account_id(string(fields, name)?).map(AccountId32::from_bytes);
    let signer = |name| decode_account_id(string(fields, name)?).map(Sr25519PublicKey::from_bytes);
    let fixed = |name, length| -> QrResult<Vec<u8>> {
        let bytes = decode_hex(string(fields, name)?, length)?;
        if bytes.len() != length { return Err(invalid_field("编码字段字节长度无效")); }
        Ok(bytes)
    };
    let code = match kind {
        1 => {
            exact_keys(fields, &["kind", "request_id", "request_id_prefix", "expires_at",
                "action", "signer_account_id", "review_payload"])?;
            let prefix = string(fields, "request_id_prefix")?;
            let request_id = match field(fields, "request_id")? {
                Value::Null => new_request_id(prefix)?,
                Value::String(value) if prefix.is_empty() => value.clone(),
                _ => return Err(invalid_field("请求编号与生成前缀不能形成双重来源")),
            };
            let signer_public_key = match field(fields, "signer_account_id")? {
                Value::Null => None,
                _ => Some(signer("signer_account_id")?),
            };
            QrCode::SignRequest(SignRequest {
                request_id, expires_at: expiry(fields)?,
                action: u16::try_from(unsigned(fields, "action")?).map_err(|_| invalid_field("动作超出u16"))?,
                signer_public_key,
                review_payload: decode_hex(string(fields, "review_payload")?, MAX_REVIEW_PAYLOAD_BYTES)?,
            })
        }
        2 => {
            exact_keys(fields, &["kind", "request_id", "expires_at", "signer_account_id",
                "signature", "current_account_id", "current_account_signature"])?;
            let current_account = match (field(fields, "current_account_id")?, field(fields, "current_account_signature")?) {
                (Value::Null, Value::Null) => None,
                (Value::String(_), Value::String(_)) => Some((account("current_account_id")?,
                    Sr25519Signature::from_bytes(fixed("current_account_signature", 64)?.try_into().map_err(|_| invalid_field("签名长度无效"))?))),
                _ => return Err(invalid_field("当前账户及签名必须同时有无")),
            };
            QrCode::SignResponse(SignResponse {
                request_id: string(fields, "request_id")?.to_owned(), expires_at: expiry(fields)?,
                signer_public_key: signer("signer_account_id")?,
                signature: Sr25519Signature::from_bytes(fixed("signature", 64)?.try_into().map_err(|_| invalid_field("签名长度无效"))?),
                current_account,
            })
        }
        3 => {
            exact_keys(fields, &["kind", "cid_number", "account_id"])?;
            QrCode::UserContact(UserContactCode {
                cid_number: string(fields, "cid_number")?.to_owned(), account_id: account("account_id")?,
            })
        }
        4 => {
            exact_keys(fields, &["kind", "request_id", "expires_at", "account_id",
                "amount", "symbol", "memo", "bank_cid_number"])?;
            QrCode::UserTransfer(UserTransferCode {
                request_id: string(fields, "request_id")?.to_owned(), expires_at: expiry(fields)?,
                account_id: account("account_id")?, amount: string(fields, "amount")?.to_owned(),
                symbol: string(fields, "symbol")?.to_owned(), memo: string(fields, "memo")?.to_owned(),
                bank_cid_number: string(fields, "bank_cid_number")?.to_owned(),
            })
        }
        6 => {
            exact_keys(fields, &["kind", "request_id", "expires_at", "signer_account_id", "signature",
                "key_exchange_public_key", "encryption_nonce", "ciphertext"])?;
            QrCode::AccountDataKeyResponse(AccountDataKeyResponse {
                request_id: string(fields, "request_id")?.to_owned(), expires_at: expiry(fields)?,
                signer_public_key: signer("signer_account_id")?,
                signature: Sr25519Signature::from_bytes(fixed("signature", 64)?.try_into().map_err(|_| invalid_field("签名长度无效"))?),
                key_exchange_public_key: fixed("key_exchange_public_key", 32)?.try_into().map_err(|_| invalid_field("交换公钥长度无效"))?,
                encryption_nonce: fixed("encryption_nonce", 12)?.try_into().map_err(|_| invalid_field("加密nonce长度无效"))?,
                ciphertext: decode_hex(string(fields, "ciphertext")?, MAX_QR_TEXT_BYTES)?,
            })
        }
        // k5已有唯一公开入口encodeAccountId，不另加同义编码路径。
        _ => return Err(QrError::new(QrErrorCode::UnsupportedKind, "该输入种类没有文档编码入口")),
    };
    code.normalized()
}

fn decimal(text: &str) -> QrResult<u64> {
    if text.is_empty() || (text.len() > 1 && text.starts_with('0')) ||
        !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid_field("整数必须是规范十进制字符串"));
    }
    text.parse().map_err(|_| invalid_field("整数超出u64"))
}

fn decode_hex(text: &str, maximum: usize) -> QrResult<Vec<u8>> {
    let raw = text.strip_prefix("0x").ok_or_else(|| invalid_field("字节必须有小写0x前缀"))?;
    if raw.len() % 2 != 0 || raw.len() / 2 > maximum ||
        !raw.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(invalid_field("字节长度或小写十六进制编码无效"));
    }
    raw.as_bytes().chunks_exact(2).map(|pair| {
        let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
        Ok((digit(pair[0]) << 4) | digit(pair[1]))
    }).collect()
}

/// 请求ID熵源由二维码模块唯一维护；前缀不可截断随机部分。
pub(crate) fn new_request_id(prefix: &str) -> QrResult<String> {
    if prefix.len() > MAX_REQUEST_ID_BYTES - 22 ||
        !prefix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(invalid_field("请求编号前缀无效"));
    }
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| QrError::new(QrErrorCode::EntropyUnavailable, "无法生成请求编号"))?;
    Ok(format!("{prefix}{}", URL_SAFE_NO_PAD.encode(entropy)))
}

/// 原a10/a11模板的纯数据准备；不读取链、不改账户、不签名，也不替代服务资格校验。
pub fn prepare_account_authorization(action: u32, payload: &[u8], account_id: &str) -> Value {
    fn rejected(reason: u8) -> Value {
        serde_json::json!({"reason": reason, "genesis_hash": null, "cid_number": null,
            "current_account_id": null, "expected_binding_revision": null,
            "expires_at": null, "materialized_payload": null})
    }
    type Template = ([u8; 32], String, Option<[u8; 32]>, u64, u64, usize);
    fn template(action: u32, payload: &[u8]) -> Option<Template> {
        if !matches!(action, 10 | 11) || payload.len() > MAX_REVIEW_PAYLOAD_BYTES { return None; }
        let genesis = payload.get(..32)?.try_into().ok()?;
        let compact = *payload.get(32)?;
        // CID至多32字节，只允许最短SCALE compact mode0，不接收等价长编码。
        if compact & 3 != 0 { return None; }
        let length = usize::from(compact >> 2);
        if length == 0 || length > 32 { return None; }
        let cid = payload.get(33..33 + length)?;
        if !cid.iter().all(|b| (0x21..=0x7e).contains(b)) { return None; }
        let cid = String::from_utf8(cid.to_vec()).ok()?;
        let mut at = 33 + length;
        let current = if action == 11 {
            let current = payload.get(at..at + 32)?.try_into().ok()?;
            at += 32; Some(current)
        } else { None };
        let slot = at;
        if payload.get(at..at + 32)?.iter().any(|b| *b != 0) { return None; }
        at += 32;
        if payload.len() != at + 16 { return None; }
        let revision = u64::from_le_bytes(payload.get(at..at + 8)?.try_into().ok()?);
        let expiry = u64::from_le_bytes(payload.get(at + 8..at + 16)?.try_into().ok()?);
        if expiry == 0 || (action == 10 && revision != 0) || (action == 11 && revision == 0) { return None; }
        Some((genesis, cid, current, revision, expiry, slot))
    }
    let Some((genesis, cid, current, revision, expiry, slot)) = template(action, payload) else {
        return rejected(1);
    };
    let Ok(account) = decode_account_id(account_id) else { return rejected(2); };
    if current == Some(account) { return rejected(3); }
    let mut materialized = payload.to_vec();
    materialized[slot..slot + 32].copy_from_slice(&account);
    serde_json::json!({"reason": 0, "genesis_hash": hex(&genesis), "cid_number": cid,
        "current_account_id": current.map(|id| hex(&id)), "expected_binding_revision": revision.to_string(),
        "expires_at": expiry.to_string(), "materialized_payload": hex(&materialized)})
}
impl QrCode {
    pub const fn scan_purpose_mask(&self) -> u8 {
        use QrScanPurpose::*;
        match self {
            Self::SignRequest(_) => SigningRequest.bit() | GeneralScan.bit(),
            Self::SignResponse(_) => ExternalSignature.bit(),
            Self::UserContact(_) => TransferRecipient.bit() | Contact.bit() | GeneralScan.bit() | AccountTarget.bit(),
            Self::UserTransfer(_) => TransferRecipient.bit() | GeneralScan.bit(),
            Self::AccountId(_) => ColdAccountImport.bit() | TransferRecipient.bit() | GeneralScan.bit() | AccountTarget.bit(),
            Self::AccountDataKeyResponse(_) => AccountDataKey.bit(),
        }
    }

    pub const fn permits(&self, purpose: QrScanPurpose) -> bool {
        self.scan_purpose_mask() & purpose.bit() != 0
    }

    /// 五端唯一公开投影。协议短键、base64 和签名账户转换只在此处处理。
    pub fn normalized(&self) -> QrResult<Value> {
        let mut value = match self {
            Self::SignRequest(v) => serde_json::json!({
                "kind": 1, "canonical_text": v.encode()?, "request_id": v.request_id,
                "expires_at": v.expires_at, "action": v.action,
                "signer_account_id": v.signer_public_key.map(|key| hex(key.as_bytes())),
                "review_payload": hex(&v.review_payload),
            }),
            Self::SignResponse(v) => serde_json::json!({
                "kind": 2, "canonical_text": v.encode()?, "request_id": v.request_id,
                "expires_at": v.expires_at,
                "signer_account_id": hex(v.signer_public_key.as_bytes()),
                "signature": hex(v.signature.as_bytes()),
                "current_account_id": v.current_account.map(|(account, _)| hex(account.as_bytes())),
                "current_account_signature": v.current_account.map(|(_, signature)| hex(signature.as_bytes())),
            }),
            Self::AccountId(v) => serde_json::json!({
                "kind": 5, "canonical_text": v.encode()?, "account_id": hex(v.account_id.as_bytes()),
            }),
            Self::UserContact(v) => serde_json::json!({
                "kind": 3, "canonical_text": v.encode()?, "cid_number": v.cid_number,
                "account_id": hex(v.account_id.as_bytes()),
            }),
            Self::UserTransfer(v) => serde_json::json!({
                "kind": 4, "canonical_text": v.encode()?, "request_id": v.request_id,
                "expires_at": v.expires_at, "account_id": hex(v.account_id.as_bytes()),
                "amount": v.amount, "symbol": v.symbol, "memo": v.memo,
                "bank_cid_number": v.bank_cid_number,
            }),
            Self::AccountDataKeyResponse(v) => serde_json::json!({
                "kind": 6, "canonical_text": v.encode()?, "request_id": v.request_id,
                "expires_at": v.expires_at, "signer_account_id": hex(v.signer_public_key.as_bytes()),
                "signature": hex(v.signature.as_bytes()), "key_exchange_public_key": hex(&v.key_exchange_public_key),
                "encryption_nonce": hex(&v.encryption_nonce), "ciphertext": hex(&v.ciphertext),
            }),
        };
        // 显式对象保证平台不必处理多种返回形状。
        if !value.is_object() {
            return Err(invalid_field("二维码公开投影不是对象"));
        }
        value["scan_purpose_mask"] = Value::from(self.scan_purpose_mask());
        Ok(std::mem::take(&mut value))
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("0x");
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

impl SignRequest {
    /// 普通链签名/固定账户会话必须有确切签名者，不能对匿名模板猜默认账户。
    pub fn require_signer(&self) -> QrResult<Sr25519PublicKey> {
        self.signer_public_key.ok_or_else(|| invalid_field("请求尚未绑定签名账户"))
    }
    /// 仅供 SDK Rust 审阅/验签管线使用，不是公开语言绑定的拆分签名入口。
    #[doc(hidden)]
    pub fn signing_message(&self) -> QrResult<Vec<u8>> {
        signing_bytes(&self.review_payload)
    }

    pub fn encode(&self) -> QrResult<String> {
        validate_request_id(&self.request_id)?;
        validate_expiry_value(self.expires_at)?;
        if self.signer_public_key.is_none() && !matches!(self.action, 10 | 11) {
            return Err(invalid_field("该签名动作不允许空签名账户"));
        }
        if self.review_payload.is_empty() {
            return Err(invalid_field("签名请求的期限和审阅载荷不能为空"));
        }
        if self.review_payload.len() > MAX_REVIEW_PAYLOAD_BYTES {
            return Err(QrError::new(
                QrErrorCode::CapacityExceeded,
                "审阅载荷超过单码安全上限",
            ));
        }
        checked_json(serde_json::json!({
            "p": QR_V1,
            "k": 1,
            "i": self.request_id,
            "e": self.expires_at,
            "b": {
                "a": self.action,
                "g": 1,
                "u": self.signer_public_key.map_or_else(String::new, |key| URL_SAFE_NO_PAD.encode(key.as_bytes())),
                "d": URL_SAFE_NO_PAD.encode(&self.review_payload),
            }
        }))
    }
}

impl SignResponse {
    pub fn encode(&self) -> QrResult<String> {
        validate_request_id(&self.request_id)?;
        validate_expiry_value(self.expires_at)?;
        let mut body = serde_json::json!({
            "u": URL_SAFE_NO_PAD.encode(self.signer_public_key.as_bytes()),
            "s": URL_SAFE_NO_PAD.encode(self.signature.as_bytes()),
        });
        if let Some((account, signature)) = self.current_account {
            body["o"] = Value::from(URL_SAFE_NO_PAD.encode(account.as_bytes()));
            body["r"] = Value::from(URL_SAFE_NO_PAD.encode(signature.as_bytes()));
        }
        checked_json(serde_json::json!({
            "p": QR_V1,
            "k": 2,
            "i": self.request_id,
            "e": self.expires_at,
            "b": body,
        }))
    }
}

impl AccountIdCode {
    pub fn encode(&self) -> QrResult<String> {
        checked_json(serde_json::json!({
            "p": QR_V1,
            "k": 5,
            "b": {"n": account_id_text(self.account_id)}
        }))
    }
}

impl UserContactCode {
    pub fn encode(&self) -> QrResult<String> {
        validate_cid(&self.cid_number)?;
        checked_json(serde_json::json!({"p": QR_V1, "k": 3,
            "b": {"c": self.cid_number, "n": account_id_text(self.account_id)}}))
    }
}

impl UserTransferCode {
    pub fn encode(&self) -> QrResult<String> {
        validate_business_id(&self.request_id)?;
        validate_expiry_value(self.expires_at)?;
        validate_cid(&self.bank_cid_number)?;
        if self.amount.is_empty() || self.symbol.is_empty() { return Err(invalid_field("收款金额和币种不能为空")); }
        checked_json(serde_json::json!({"p": QR_V1, "k": 4, "i": self.request_id, "e": self.expires_at,
            "b": {"n": account_id_text(self.account_id), "v": self.amount, "t": self.symbol,
                "m": self.memo, "l": self.bank_cid_number}}))
    }
}

impl AccountDataKeyResponse {
    pub fn encode(&self) -> QrResult<String> {
        validate_business_id(&self.request_id)?;
        validate_expiry_value(self.expires_at)?;
        if self.ciphertext.len() < 17 { return Err(invalid_field("用途钥密文长度无效")); }
        checked_json(serde_json::json!({"p": QR_V1, "k": 6, "i": self.request_id, "e": self.expires_at,
            "b": {"u": URL_SAFE_NO_PAD.encode(self.signer_public_key.as_bytes()),
                "s": URL_SAFE_NO_PAD.encode(self.signature.as_bytes()),
                "x": URL_SAFE_NO_PAD.encode(self.key_exchange_public_key),
                "q": URL_SAFE_NO_PAD.encode(self.encryption_nonce),
                "z": URL_SAFE_NO_PAD.encode(&self.ciphertext)}}))
    }
}

/// Substrate `SignedPayload::using_encoded` 的唯一签名字节规则。
pub(crate) fn signing_bytes(review_payload: &[u8]) -> QrResult<Vec<u8>> {
    if review_payload.len() > MAX_REVIEW_PAYLOAD_BYTES {
        return Err(invalid_field("review_payload 长度无效"));
    }
    apply_signing_transform(review_payload, &SigningTransform::SubstrateSigningPayload)
        .map_err(|_| invalid_field("review_payload 长度无效"))
}

fn parse_sign_request(envelope: &Map<String, Value>, now: u64) -> QrResult<QrCode> {
    exact_keys(envelope, &["p", "k", "i", "e", "b"])?;
    let request_id = string(envelope, "i")?.to_owned();
    validate_request_id(&request_id)?;
    let expires_at = unsigned(envelope, "e")?;
    validate_expiry(expires_at, now)?;
    let body = object(field(envelope, "b")?, "签名请求 body 必须是对象")?;
    exact_keys(body, &["a", "g", "u", "d"])?;
    let action =
        u16::try_from(unsigned(body, "a")?).map_err(|_| invalid_field("签名动作超出 u16"))?;
    if unsigned(body, "g")? != 1 {
        return Err(invalid_field("签名算法只允许 sr25519"));
    }
    let signer_text = string(body, "u")?;
    let signer_public_key = if signer_text.is_empty() && matches!(action, 10 | 11) {
        None
    } else {
        Some(Sr25519PublicKey::from_bytes(decode_fixed::<32>(
            signer_text, "signer_public_key 长度或编码无效",
        )?))
    };
    let review_payload = decode(string(body, "d")?, MAX_REVIEW_PAYLOAD_BYTES)?;
    if review_payload.is_empty() {
        return Err(invalid_field("review_payload 不能为空"));
    }
    Ok(QrCode::SignRequest(SignRequest {
        request_id,
        expires_at,
        action,
        signer_public_key,
        review_payload,
    }))
}

fn parse_sign_response(envelope: &Map<String, Value>, now: u64) -> QrResult<QrCode> {
    exact_keys(envelope, &["p", "k", "i", "e", "b"])?;
    let request_id = string(envelope, "i")?.to_owned();
    validate_request_id(&request_id)?;
    let expires_at = unsigned(envelope, "e")?;
    validate_expiry(expires_at, now)?;
    let body = object(field(envelope, "b")?, "签名响应 body 必须是对象")?;
    let current_account = if body.contains_key("o") || body.contains_key("r") {
        exact_keys(body, &["u", "s", "o", "r"])?;
        Some((AccountId32::from_bytes(decode_fixed::<32>(string(body, "o")?, "当前账户长度或编码无效")?),
            Sr25519Signature::from_bytes(decode_fixed::<64>(string(body, "r")?, "当前账户签名长度或编码无效")?)))
    } else {
        exact_keys(body, &["u", "s"])?;
        None
    };
    Ok(QrCode::SignResponse(SignResponse {
        current_account,
        request_id,
        expires_at,
        signer_public_key: Sr25519PublicKey::from_bytes(decode_fixed::<32>(
            string(body, "u")?,
            "signer_public_key 长度或编码无效",
        )?),
        signature: Sr25519Signature::from_bytes(decode_fixed::<64>(
            string(body, "s")?,
            "signature 长度或编码无效",
        )?),
    }))
}

fn parse_user_contact(envelope: &Map<String, Value>) -> QrResult<QrCode> {
    exact_keys(envelope, &["p", "k", "b"])?;
    let body = object(field(envelope, "b")?, "用户码body必须是对象")?;
    exact_keys(body, &["c", "n"])?;
    let cid_number = string(body, "c")?.to_owned();
    validate_cid(&cid_number)?;
    Ok(QrCode::UserContact(UserContactCode {
        cid_number, account_id: AccountId32::from_bytes(decode_account_id(string(body, "n")?)?),
    }))
}

fn parse_business_expiry(envelope: &Map<String, Value>, now: u64) -> QrResult<(String, u64)> {
    exact_keys(envelope, &["p", "k", "i", "e", "b"])?;
    let request_id = string(envelope, "i")?.to_owned();
    validate_business_id(&request_id)?;
    let expires_at = unsigned(envelope, "e")?;
    validate_expiry(expires_at, now)?;
    Ok((request_id, expires_at))
}

fn parse_user_transfer(envelope: &Map<String, Value>, now: u64) -> QrResult<QrCode> {
    let (request_id, expires_at) = parse_business_expiry(envelope, now)?;
    let body = object(field(envelope, "b")?, "收款码body必须是对象")?;
    exact_keys(body, &["n", "v", "t", "m", "l"])?;
    let bank_cid_number = string(body, "l")?.to_owned();
    validate_cid(&bank_cid_number)?;
    let amount = string(body, "v")?.to_owned();
    let symbol = string(body, "t")?.to_owned();
    if amount.is_empty() || symbol.is_empty() { return Err(invalid_field("收款金额和币种不能为空")); }
    Ok(QrCode::UserTransfer(UserTransferCode {
        request_id, expires_at, amount, symbol, bank_cid_number,
        account_id: AccountId32::from_bytes(decode_account_id(string(body, "n")?)?),
        memo: string(body, "m")?.to_owned(),
    }))
}

fn parse_account_data_key(envelope: &Map<String, Value>, now: u64) -> QrResult<QrCode> {
    let (request_id, expires_at) = parse_business_expiry(envelope, now)?;
    let body = object(field(envelope, "b")?, "用途钥响应body必须是对象")?;
    exact_keys(body, &["u", "s", "x", "q", "z"])?;
    let ciphertext = decode(string(body, "z")?, MAX_QR_TEXT_BYTES)?;
    if ciphertext.len() < 17 { return Err(invalid_field("用途钥密文长度无效")); }
    Ok(QrCode::AccountDataKeyResponse(AccountDataKeyResponse {
        request_id, expires_at, ciphertext,
        signer_public_key: Sr25519PublicKey::from_bytes(decode_fixed::<32>(string(body, "u")?, "签名账户无效")?),
        signature: Sr25519Signature::from_bytes(decode_fixed::<64>(string(body, "s")?, "签名长度无效")?),
        key_exchange_public_key: decode_fixed::<32>(string(body, "x")?, "会话公钥无效")?,
        encryption_nonce: decode_fixed::<12>(string(body, "q")?, "加密nonce无效")?,
    }))
}

fn validate_cid(value: &str) -> QrResult<()> {
    if value.is_empty() || value.len() > 32 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return Err(invalid_field("CID必须是1至32位ASCII字母数字或连字符"));
    }
    Ok(())
}

fn validate_business_id(value: &str) -> QrResult<()> {
    if value.is_empty() || value.len() > MAX_QR_TEXT_BYTES { return Err(invalid_field("临时码标识不能为空或超长")); }
    Ok(())
}

fn parse_account_id(envelope: &Map<String, Value>) -> QrResult<QrCode> {
    exact_keys(envelope, &["p", "k", "b"])?;
    let body = object(field(envelope, "b")?, "账户码 body 必须是对象")?;
    exact_keys(body, &["n"])?;
    Ok(QrCode::AccountId(AccountIdCode {
        account_id: AccountId32::from_bytes(decode_account_id(string(body, "n")?)?),
    }))
}

/// serde_json 的默认 Value 会覆盖重复对象键；QR_V1 在覆盖发生前失败关闭。
struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("无重复对象键的 JSON 值")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(value.into())))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(value.into())))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .map(StrictValue)
            .ok_or_else(|| E::custom("JSON 浮点数无效"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value.to_owned())))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value)))
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictValue>()? {
            values.push(value.0);
        }
        Ok(StrictValue(Value::Array(values)))
    }

    fn visit_map<A>(self, mut entries: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = entries.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom("JSON 对象含重复键"));
            }
            values.insert(key, entries.next_value::<StrictValue>()?.0);
        }
        Ok(StrictValue(Value::Object(values)))
    }
}

fn account_id_text(account_id: AccountId32) -> String {
    let mut output = String::with_capacity(66);
    output.push_str("0x");
    for byte in account_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn validate_request_id(request_id: &str) -> QrResult<()> {
    if request_id.len() < 16
        || request_id.len() > MAX_REQUEST_ID_BYTES
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(invalid_field("request_id 格式无效"));
    }
    Ok(())
}

fn validate_expiry(expires_at: u64, now: u64) -> QrResult<()> {
    validate_expiry_value(expires_at)?;
    if expires_at <= now {
        return Err(QrError::new(QrErrorCode::Expired, "二维码已经过期"));
    }
    Ok(())
}

fn validate_expiry_value(expires_at: u64) -> QrResult<()> {
    // 五端 JSON 整数共同的精确正 Unix 秒域，不能让平台分别截断或转 Double。
    if expires_at == 0 || expires_at > i64::MAX as u64 {
        return Err(invalid_field("二维码过期时间必须位于 1..i64::MAX"));
    }
    Ok(())
}

fn checked_json(value: Value) -> QrResult<String> {
    let encoded = serde_json::to_string(&value)
        .map_err(|_| QrError::new(QrErrorCode::InvalidFormat, "二维码编码失败"))?;
    if encoded.len() > MAX_QR_TEXT_BYTES {
        return Err(QrError::new(
            QrErrorCode::CapacityExceeded,
            "二维码文本超过单码容量",
        ));
    }
    Ok(encoded)
}

fn exact_keys(object: &Map<String, Value>, expected: &[&str]) -> QrResult<()> {
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(invalid_field("二维码字段集合不符合 QR_V1"));
    }
    Ok(())
}

fn decode(value: &str, max: usize) -> QrResult<Vec<u8>> {
    if value.contains('=') {
        return Err(invalid_field("base64url 不允许填充"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| invalid_field("base64url 编码无效"))?;
    if bytes.len() > max || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(invalid_field("base64url 不是规范编码或超过长度"));
    }
    Ok(bytes)
}

fn decode_fixed<const N: usize>(value: &str, message: &'static str) -> QrResult<[u8; N]> {
    let bytes = decode(value, N)?;
    bytes
        .try_into()
        .map_err(|_| QrError::new(QrErrorCode::InvalidField, message))
}

fn decode_account_id(value: &str) -> QrResult<[u8; 32]> {
    let text = value
        .strip_prefix("0x")
        .ok_or_else(|| invalid_field("account_id 必须使用小写 0x 十六进制"))?;
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid_field("account_id 长度或字符无效"));
    }
    if text.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(invalid_field("account_id 必须使用小写十六进制"));
    }
    let mut output = [0_u8; 32];
    for (index, chunk) in text.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| invalid_field("account_id 无效"))?;
        output[index] =
            u8::from_str_radix(pair, 16).map_err(|_| invalid_field("account_id 无效"))?;
    }
    Ok(output)
}

fn object<'a>(value: &'a Value, message: &'static str) -> QrResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| QrError::new(QrErrorCode::InvalidField, message))
}

fn field<'a>(object: &'a Map<String, Value>, key: &str) -> QrResult<&'a Value> {
    object
        .get(key)
        .ok_or_else(|| invalid_field("二维码缺少必填字段"))
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> QrResult<&'a str> {
    field(object, key)?
        .as_str()
        .ok_or_else(|| invalid_field("二维码字段必须是字符串"))
}

fn unsigned(object: &Map<String, Value>, key: &str) -> QrResult<u64> {
    field(object, key)?
        .as_u64()
        .ok_or_else(|| invalid_field("二维码字段必须是非负整数"))
}

const fn invalid_field(message: &'static str) -> QrError {
    QrError::new(QrErrorCode::InvalidField, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 只有纯协议测试可注入时间；生产入口始终读取 SDK 时钟。
    use super::parse_at as parse;

    // 原App解析器移除后的协议回归仍运行真实SDK解析器，不能用页面fake代替。
    #[test]
    fn original_app_router_rejection_vectors_remain_closed_in_core() {
        let account = hex(&[7; 32]);
        let contact = serde_json::json!({"p":"QR_V1","k":3,"b":{"c":"CID-7","n":account}});
        assert!(parse(&contact.to_string(), 99).is_ok());
        for bad in [serde_json::json!("5"), serde_json::json!(" 5"), serde_json::json!("+5"),
                    serde_json::json!("0x5"), serde_json::json!(5.0), serde_json::json!(true)] {
            let mut value = contact.clone(); value["k"] = bad;
            assert!(parse(&value.to_string(), 99).is_err());
        }
        for extra in ["display_name", "x", "ss58_address"] {
            let mut value = contact.clone(); value["b"][extra] = "not-authoritative".into();
            assert!(parse(&value.to_string(), 99).is_err());
        }
        let legacy = serde_json::json!({"p":"QR_V1","k":3,"b":{
            "cid_number":"CID-7","ss58_address":"old-format","display_name":"name"}});
        assert!(parse(&legacy.to_string(), 99).is_err());
        for cid in ["\u{200b}CID-7", "\u{200b}\u{200b}"] {
            let mut value = contact.clone(); value["b"]["c"] = cid.into();
            assert!(parse(&value.to_string(), 99).is_err());
        }
        for bad in [account.to_uppercase(), account[2..].to_owned(), "0x8eaf".into()] {
            let value = serde_json::json!({"p":"QR_V1","k":5,"b":{"n":bad}});
            assert!(parse(&value.to_string(), 99).is_err());
        }
        let request = serde_json::json!({"p":"QR_V1","k":1,"i":"request-identifier","e":100,
            "b":{"a":1024,"g":1,"u":URL_SAFE_NO_PAD.encode([7;32]),"d":"AQID"}});
        assert!(parse(&request.to_string(), 99).is_ok());
        for bad in ["++++", "AA==", "A/A"] {
            let mut value = request.clone(); value["b"]["u"] = bad.into();
            assert!(parse(&value.to_string(), 99).is_err());
        }
        let mut extra = request; extra["b"]["display"] = "fake-ui".into();
        assert!(parse(&extra.to_string(), 99).is_err());
        let incomplete = serde_json::json!({"p":"QR_V1","k":2,"i":"request-identifier","e":100,
            "b":{"u":URL_SAFE_NO_PAD.encode([7;32]),"s":URL_SAFE_NO_PAD.encode([0;64]),"o":URL_SAFE_NO_PAD.encode([8;32])}});
        assert!(parse(&incomplete.to_string(), 99).is_err());
        for raw in ["", "hello world", "gmb://account/removed",
                    "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", r#"{"p":"UNKNOWN_PROTO","foo":"bar"}"#] {
            assert!(parse(raw, 99).is_err());
        }
    }

    #[test]
    fn document_encoding_preserves_original_fields_and_explicit_deadline() {
        let contact = serde_json::json!({"kind": 3, "cid_number": "CID-7", "account_id": hex(&[7; 32])});
        let document = encode_document(&contact.to_string()).unwrap();
        let raw: Value = serde_json::from_str(document["canonical_text"].as_str().unwrap()).unwrap();
        assert_eq!(raw, serde_json::json!({"p":"QR_V1","k":3,"b":{"c":"CID-7","n":hex(&[7;32])}}));
        let request = serde_json::json!({"kind":1,"request_id":null,"request_id_prefix":"data-key-",
            "expires_at":"100","action":10,"signer_account_id":null,"review_payload":"0x0102"});
        let document = encode_document(&request.to_string()).unwrap();
        assert_eq!(document["expires_at"], 100);
        assert!(document["request_id"].as_str().unwrap().starts_with("data-key-"));
        assert!(document["signer_account_id"].is_null());
        let parsed = parse(document["canonical_text"].as_str().unwrap(), 99).unwrap();
        let QrCode::SignRequest(parsed) = parsed else { panic!("request kind") };
        assert!(parsed.require_signer().is_err());
        assert_eq!(parsed.signer_public_key, None);
        let mut invalid = request.clone();
        invalid["action"] = 12.into();
        assert!(encode_document(&invalid.to_string()).is_err());
        invalid = request.clone(); invalid["title"] = "not-ui".into();
        assert!(encode_document(&invalid.to_string()).is_err());
        invalid = request; invalid["request_id"] = "0123456789abcdef".into();
        assert!(encode_document(&invalid.to_string()).is_err());
        assert!(encode_document(r#"{"kind":3,"kind":3,"cid_number":"C","account_id":"bad"}"#).is_err());
        assert!(encode_document(&serde_json::json!({"kind":5,"account_id":hex(&[7;32])}).to_string()).is_err());
    }

    #[test]
    fn rebind_response_round_trips_paired_current_account_proof() {
        let response = SignResponse { request_id: "0123456789abcdef".into(), expires_at: 100,
            signer_public_key: Sr25519PublicKey::from_bytes([7; 32]),
            signature: Sr25519Signature::from_bytes([8; 64]),
            current_account: Some((AccountId32::from_bytes([9; 32]), Sr25519Signature::from_bytes([10; 64]))),
        };
        let encoded = response.encode().unwrap();
        assert_eq!(parse(&encoded, 99).unwrap(), QrCode::SignResponse(response.clone()));
        let value = QrCode::SignResponse(response).normalized().unwrap();
        assert_eq!(value["current_account_id"], hex(&[9; 32]));
        let mut invalid: Value = serde_json::from_str(&encoded).unwrap();
        invalid["b"].as_object_mut().unwrap().remove("r");
        assert!(parse(&invalid.to_string(), 99).is_err());
        let input = serde_json::json!({"kind":2,"request_id":"0123456789abcdef","expires_at":"100",
            "signer_account_id":hex(&[7;32]),"signature":hex(&[8;64]),
            "current_account_id":hex(&[9;32]),"current_account_signature":hex(&[10;64])});
        assert_eq!(encode_document(&input.to_string()).unwrap(), value);
    }

    #[test]
    fn authorization_preparation_preserves_template_slots_and_rejects_malformed_inputs() {
        fn payload(action: u32) -> Vec<u8> {
            let mut p = vec![1; 32]; p.extend_from_slice(&[12, b'C', b'I', b'D']);
            if action == 11 { p.extend_from_slice(&[7; 32]); }
            p.extend_from_slice(&[0; 32]);
            p.extend_from_slice(&(if action == 11 { 9_u64 } else { 0_u64 }).to_le_bytes());
            p.extend_from_slice(&100_u64.to_le_bytes()); p
        }
        for action in [10, 11] {
            let raw = payload(action);
            let result = prepare_account_authorization(action, &raw, &hex(&[8; 32]));
            assert_eq!(result["reason"], 0);
            assert_eq!(result["cid_number"], "CID");
            assert_eq!(result["expires_at"], "100");
            let slot = if action == 11 { 68 } else { 36 };
            let mut expected = raw.clone(); expected[slot..slot + 32].copy_from_slice(&[8; 32]);
            assert_eq!(result["materialized_payload"], hex(&expected));
            assert_eq!(&raw[slot..slot + 32], &[0; 32]);
            assert_eq!(prepare_account_authorization(action, &raw, "bad")["reason"], 2);
            let mut extra = raw.clone(); extra.push(0);
            assert_eq!(prepare_account_authorization(action, &extra, &hex(&[8; 32]))["reason"], 1);
            let mut polluted = raw.clone(); polluted[slot] = 1;
            assert_eq!(prepare_account_authorization(action, &polluted, &hex(&[8; 32]))["reason"], 1);
        }
        assert_eq!(prepare_account_authorization(11, &payload(11), &hex(&[7; 32]))["reason"], 3);
        assert_eq!(prepare_account_authorization(12, &payload(10), &hex(&[8; 32]))["reason"], 1);
        for length in 0..payload(10).len() {
            assert_eq!(prepare_account_authorization(10, &payload(10)[..length], &hex(&[8; 32]))["reason"], 1);
        }
    }

    fn request() -> SignRequest {
        SignRequest {
            request_id: "0123456789abcdef".to_owned(),
            expires_at: 100,
            action: 0x0400,
            signer_public_key: Some(Sr25519PublicKey::from_bytes([7; 32])),
            review_payload: vec![0x04, 0x00, 3],
        }
    }

    #[test]
    fn sign_request_round_trip_is_strict() {
        let encoded = request().encode().unwrap();
        assert_eq!(parse(&encoded, 99), Ok(QrCode::SignRequest(request())));
    }

    #[test]
    fn rejects_unknown_fields_but_accepts_any_opaque_u16_action() {
        let encoded = request().encode().unwrap();
        let injected = encoded.replacen("{\"a\"", "{\"extra\":true,\"a\"", 1);
        assert_eq!(
            parse(&injected, 99).unwrap_err().code(),
            QrErrorCode::InvalidField
        );
        let mut request = request();
        request.action = 2;
        request.review_payload = b"third-party opaque payload".to_vec();
        let encoded = request.encode().unwrap();
        assert_eq!(parse(&encoded, 99), Ok(QrCode::SignRequest(request)));
    }

    #[test]
    fn host_scan_purpose_does_not_allocate_a_wire_kind() {
        let text = r#"{"p":"QR_V1","k":7,"i":"0123456789abcdef","e":100,"b":{}}"#;
        assert_eq!(
            parse(text, 99).unwrap_err().code(),
            QrErrorCode::UnsupportedKind
        );
    }

    #[test]
    fn original_business_codes_round_trip_without_changing_wire_fields() {
        let account = format!("0x{}", "07".repeat(32));
        let contact = format!(r#"{{"p":"QR_V1","k":3,"b":{{"c":"CID-7","n":"{account}"}}}}"#);
        let transfer = format!(r#"{{"p":"QR_V1","k":4,"i":"original-id","e":100,"b":{{"n":"{account}","v":"1.25","t":"GMB","m":"原备注","l":"BANK-7"}}}}"#);
        for raw in [&contact, &transfer] {
            let parsed = parse(raw, 99).unwrap();
            let normalized = parsed.normalized().unwrap();
            let encoded = normalized["canonical_text"].as_str().unwrap();
            assert_eq!(serde_json::from_str::<Value>(raw).unwrap(), serde_json::from_str::<Value>(encoded).unwrap());
            assert!(!parsed.permits(QrScanPurpose::ColdAccountImport));
            assert!(parsed.permits(QrScanPurpose::TransferRecipient));
            assert!(parsed.permits(QrScanPurpose::GeneralScan));
            assert_eq!(normalized["scan_purpose_mask"], Value::from(parsed.scan_purpose_mask()));
        }
        assert!(parse(&contact, 99).unwrap().permits(QrScanPurpose::AccountTarget));
        assert!(!parse(&transfer, 99).unwrap().permits(QrScanPurpose::AccountTarget));
        assert_eq!(parse(&transfer, 100).unwrap_err().code(), QrErrorCode::Expired);
        assert_eq!(parse(&contact.replace("CID-7", "CID\u{200b}7"), 99).unwrap_err().code(), QrErrorCode::InvalidField);
        assert_eq!(parse(&contact.replace("\"c\":", "\"c\":\"CID-8\",\"c\":"), 99).unwrap_err().code(), QrErrorCode::InvalidFormat);
    }

    #[test]
    fn scan_purposes_are_separate_from_cold_import_and_wire_kinds() {
        let codes = [
            QrCode::SignRequest(request()),
            QrCode::SignResponse(SignResponse {
                current_account: None,
                request_id: "0123456789abcdef".into(), expires_at: 100,
                signer_public_key: Sr25519PublicKey::from_bytes([7; 32]),
                signature: Sr25519Signature::from_bytes([0; 64]),
            }),
            QrCode::UserContact(UserContactCode { cid_number: "CID-7".into(), account_id: AccountId32::from_bytes([7; 32]) }),
            QrCode::UserTransfer(UserTransferCode { request_id: "original-id".into(), expires_at: 100,
                account_id: AccountId32::from_bytes([7; 32]), amount: "1".into(), symbol: "GMB".into(), memo: "".into(), bank_cid_number: "BANK-7".into() }),
            QrCode::AccountId(AccountIdCode { account_id: AccountId32::from_bytes([7; 32]) }),
            QrCode::AccountDataKeyResponse(AccountDataKeyResponse { request_id: "original-id".into(), expires_at: 100,
                signer_public_key: Sr25519PublicKey::from_bytes([7; 32]), signature: Sr25519Signature::from_bytes([0; 64]),
                key_exchange_public_key: [8; 32], encryption_nonce: [0; 12], ciphertext: vec![9; 17] }),
        ];
        assert_eq!(codes.map(|code| code.scan_purpose_mask()), [80, 8, 198, 66, 195, 32]);
    }

    #[test]
    fn encrypted_account_data_key_response_has_exact_lengths_and_no_plaintext_field() {
        let value = AccountDataKeyResponse { request_id: "session".into(), expires_at: 100,
            signer_public_key: Sr25519PublicKey::from_bytes([7; 32]), signature: Sr25519Signature::from_bytes([0; 64]),
            key_exchange_public_key: [8; 32], encryption_nonce: [0; 12], ciphertext: vec![9; 17] };
        let encoded = value.encode().unwrap();
        assert_eq!(parse(&encoded, 99), Ok(QrCode::AccountDataKeyResponse(value.clone())));
        let mut invalid: Value = serde_json::from_str(&encoded).unwrap();
        invalid["b"]["q"] = Value::from(URL_SAFE_NO_PAD.encode([0; 11]));
        assert_eq!(parse(&invalid.to_string(), 99).unwrap_err().code(), QrErrorCode::InvalidField);
        let mut short = value;
        short.ciphertext.pop();
        assert_eq!(short.encode().unwrap_err().code(), QrErrorCode::InvalidField);
    }

    #[test]
    fn rejects_duplicate_keys_without_imposing_payload_action_semantics() {
        let encoded = request().encode().unwrap();
        // serde_json 的对象键序不是协议合同的一部分；直接在根对象首位插入
        // 第二个 `p`，保证无论规范编码的键顺序如何都确实形成重复键。
        let duplicate = format!("{{\"p\":\"QR_V1\",{}", &encoded[1..]);
        assert_eq!(
            parse(&duplicate, 99).unwrap_err().code(),
            QrErrorCode::InvalidFormat
        );
        let mut mismatched = request();
        mismatched.review_payload[1] = 1;
        let encoded = mismatched.encode().unwrap();
        assert_eq!(parse(&encoded, 99), Ok(QrCode::SignRequest(mismatched)));
    }

    #[test]
    fn rejects_expired_and_oversized_values() {
        assert_eq!(
            parse(&request().encode().unwrap(), 100).unwrap_err().code(),
            QrErrorCode::Expired
        );
        assert_eq!(
            parse(&"x".repeat(MAX_QR_TEXT_BYTES + 1), 0)
                .unwrap_err()
                .code(),
            QrErrorCode::CapacityExceeded
        );
    }

    #[test]
    fn expiry_uses_the_same_exact_positive_i64_domain_in_every_wire_kind() {
        let mut request = request();
        request.expires_at = i64::MAX as u64;
        let response = SignResponse {
                current_account: None,
            request_id: request.request_id.clone(),
            expires_at: request.expires_at,
            signer_public_key: request.require_signer().unwrap(),
            signature: Sr25519Signature::from_bytes([0; 64]),
        };
        for text in [request.encode().unwrap(), response.encode().unwrap()] {
            assert!(parse(&text, 99).is_ok());
            let invalid = text.replace(&i64::MAX.to_string(), &(i64::MAX as u64 + 1).to_string());
            assert_eq!(
                parse(&invalid, 99).unwrap_err().code(),
                QrErrorCode::InvalidField
            );
        }
        request.expires_at += 1;
        assert_eq!(
            request.encode().unwrap_err().code(),
            QrErrorCode::InvalidField
        );
        let mut response = response;
        response.expires_at += 1;
        assert_eq!(
            response.encode().unwrap_err().code(),
            QrErrorCode::InvalidField
        );
    }
}
