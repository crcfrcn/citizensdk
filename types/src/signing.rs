//! Product-independent signing intents and SDK-owned wallet-mutation authorization.
//!
//! Callers own the meaning and encoding of every opaque payload. CitizenSDK only applies a
//! bounded, explicitly selected byte transform, routes the account by its stored sign mode, and
//! verifies the resulting sr25519 signature. No consumer action registry belongs in this module.

use std::collections::BTreeSet;

use blake2::{digest::Update, digest::VariableOutput, Blake2bVar};

use crate::{
    AccountId32, ContractError, ContractErrorCode, ContractResult, Hash32, Sr25519Signature,
};

/// Hot signing may accept sizeable opaque documents while still placing a hard allocation bound.
pub const MAX_SIGNING_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
/// A domain is a protocol discriminator, not an unbounded application message.
pub const MAX_SIGNING_DOMAIN_BYTES: usize = 32;
/// All external signing sessions share the same bounded lifetime contract.
pub const MAX_EXTERNAL_SIGNING_TTL_SECONDS: u64 = 300;
/// The existing independent CitizenWallet uses QR_V1 action 12 for this SDK wallet mutation.
pub const DEFAULT_ACCOUNT_CHANGE_QR_ACTION: u16 = 12;
/// CitizenChain's stable domain for the local default-account mutation: `GMB || 0x21`.
pub const DEFAULT_ACCOUNT_CHANGE_DOMAIN: &[u8] = b"GMB\x21";
/// The wallet mutation payload deliberately remains compatible with the independent wallet.
pub const DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES: usize = 16;
/// A bounded full account permutation prevents hostile payload amplification.
pub const MAX_DEFAULT_ACCOUNT_CHANGE_ACCOUNTS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SigningTransform {
    /// Sign the opaque payload byte-for-byte.
    Raw,
    /// Match Substrate `SignedPayload::using_encoded`: hash only when length is greater than 256.
    SubstrateSigningPayload,
    /// Sign `blake2_256(domain || payload)` without assigning meaning to the domain bytes.
    Blake2Domain(Vec<u8>),
}

impl SigningTransform {
    pub fn validate(&self) -> ContractResult<()> {
        if let Self::Blake2Domain(domain) = self {
            if domain.is_empty() || domain.len() > MAX_SIGNING_DOMAIN_BYTES {
                return Err(invalid("签名域长度必须位于 1..32 字节"));
            }
        }
        Ok(())
    }
}

/// An application-neutral request to sign bytes with one account already present in WalletState.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningIntent {
    account_id: AccountId32,
    payload: Vec<u8>,
    transform: SigningTransform,
}

impl SigningIntent {
    pub fn try_new(
        account_id: AccountId32,
        payload: Vec<u8>,
        transform: SigningTransform,
    ) -> ContractResult<Self> {
        if payload.is_empty() || payload.len() > MAX_SIGNING_PAYLOAD_BYTES {
            return Err(invalid("签名载荷长度必须位于 1..16MiB"));
        }
        transform.validate()?;
        Ok(Self {
            account_id,
            payload,
            transform,
        })
    }

    pub const fn account_id(&self) -> AccountId32 {
        self.account_id
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    pub const fn transform(&self) -> &SigningTransform {
        &self.transform
    }

    /// Rebuild the exact bytes that the selected account must sign.
    pub fn signing_message(&self) -> ContractResult<Vec<u8>> {
        apply_signing_transform(&self.payload, &self.transform)
    }

    /// Stable correlation hash over the original opaque payload, independent of its transform.
    pub fn payload_hash(&self) -> ContractResult<Hash32> {
        Ok(Hash32::from_bytes(blake2_256(&self.payload)?))
    }
}

/// Apply a generic transform without requiring a wallet lookup. Transport adapters use this to
/// verify an already-bound session; application code should normally construct [`SigningIntent`].
pub fn apply_signing_transform(
    payload: &[u8],
    transform: &SigningTransform,
) -> ContractResult<Vec<u8>> {
    if payload.is_empty() || payload.len() > MAX_SIGNING_PAYLOAD_BYTES {
        return Err(invalid("签名载荷长度必须位于 1..16MiB"));
    }
    transform.validate()?;
    match transform {
        SigningTransform::Raw => Ok(payload.to_vec()),
        SigningTransform::SubstrateSigningPayload if payload.len() <= 256 => Ok(payload.to_vec()),
        SigningTransform::SubstrateSigningPayload => Ok(blake2_256(payload)?.to_vec()),
        SigningTransform::Blake2Domain(domain) => {
            let mut bytes = Vec::with_capacity(domain.len() + payload.len());
            bytes.extend_from_slice(domain);
            bytes.extend_from_slice(payload);
            Ok(blake2_256(&bytes)?.to_vec())
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningCompletion {
    account_id: AccountId32,
    payload_hash: Hash32,
    signature: Sr25519Signature,
}

impl SigningCompletion {
    pub const fn new(
        account_id: AccountId32,
        payload_hash: Hash32,
        signature: Sr25519Signature,
    ) -> Self {
        Self {
            account_id,
            payload_hash,
            signature,
        }
    }

    pub const fn account_id(&self) -> AccountId32 {
        self.account_id
    }

    pub const fn payload_hash(&self) -> Hash32 {
        self.payload_hash
    }

    pub const fn signature(&self) -> Sr25519Signature {
        self.signature
    }

    pub const fn signature_bytes(&self) -> &[u8; 64] {
        self.signature.as_bytes()
    }
}

/// 由原宿主移入的有界载荷原语；只有数据转换，没有账户选择、认证或签名副作用。
pub enum SigningPayload<'a> {
    Message { op_tag: u8, scale_payload: &'a [u8] },
    BinaryPrefix { op_tag: u8 },
    ActivateAdmin { cid_number: &'a str, institution_code: [u8; 4], kind: u8,
        signer_public_key: [u8; 32], timestamp: u64, nonce: [u8; 16] },
    DecryptAdmin { cid_number: &'a str, signer_public_key: [u8; 32], timestamp: u64, nonce: [u8; 16] },
    ScaleString(&'a str),
    U64Le(u64),
}

/// 六种原语共用现有Rust哈希/SCALE实现，绑定层不保留第二份算法。
pub fn encode_signing_payload(input: SigningPayload<'_>) -> ContractResult<Vec<u8>> {
    fn prefix(tag: u8) -> Vec<u8> { vec![b'G', b'M', b'B', tag] }
    fn admin(tag: u8, cid: &str, fields: &[u8], timestamp: u64, nonce: [u8; 16]) -> ContractResult<Vec<u8>> {
        let cid = cid.as_bytes();
        if cid.is_empty() || cid.len() > 32 { return Err(invalid("CID字段长度必须为1..32字节")); }
        let mut bytes = prefix(tag);
        bytes.extend_from_slice(cid);
        bytes.resize(4 + 32, 0);
        bytes.extend_from_slice(fields);
        bytes.extend_from_slice(&timestamp.to_le_bytes());
        bytes.extend_from_slice(&nonce);
        Ok(bytes)
    }
    match input {
        SigningPayload::Message { op_tag, scale_payload } => {
            if scale_payload.len() > MAX_SIGNING_PAYLOAD_BYTES { return Err(invalid("签名消息超过16MiB")); }
            let mut bytes = prefix(op_tag);
            bytes.extend_from_slice(scale_payload);
            // 与普通SigningTransform共用唯一blake2_256；空SCALE载荷仍是有效的原语输入。
            Ok(blake2_256(&bytes)?.to_vec())
        }
        SigningPayload::BinaryPrefix { op_tag } => Ok(prefix(op_tag)),
        SigningPayload::ActivateAdmin { cid_number, institution_code, kind, signer_public_key, timestamp, nonce } => {
            let mut fields = Vec::with_capacity(37);
            fields.extend_from_slice(&institution_code); fields.push(kind);
            fields.extend_from_slice(&signer_public_key);
            admin(0x18, cid_number, &fields, timestamp, nonce)
        }
        SigningPayload::DecryptAdmin { cid_number, signer_public_key, timestamp, nonce } =>
            admin(0x19, cid_number, &signer_public_key, timestamp, nonce),
        SigningPayload::ScaleString(value) => {
            if value.len() > MAX_SIGNING_PAYLOAD_BYTES - 5 { return Err(invalid("SCALE字符串超过载荷上限")); }
            let mut bytes = Vec::with_capacity(value.len() + 5);
            encode_scale_compact_len(value.len(), &mut bytes)?;
            bytes.extend_from_slice(value.as_bytes());
            Ok(bytes)
        }
        SigningPayload::U64Le(value) => Ok(value.to_le_bytes().to_vec()),
    }
}

/// Immutable authorization snapshot for the SDK-owned default-account list mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DefaultAccountChangeAuthorization {
    expected_revision: u64,
    current_default_account_id: AccountId32,
    before_account_ids: Vec<AccountId32>,
    ordered_account_ids: Vec<AccountId32>,
    expires_at: u64,
    nonce: [u8; DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES],
    payload: Vec<u8>,
}

impl DefaultAccountChangeAuthorization {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        genesis_hash: Hash32,
        expected_revision: u64,
        current_default_account_id: AccountId32,
        before_account_ids: Vec<AccountId32>,
        ordered_account_ids: Vec<AccountId32>,
        expires_at: u64,
        nonce: [u8; DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES],
    ) -> ContractResult<Self> {
        validate_default_account_change(
            current_default_account_id,
            &before_account_ids,
            &ordered_account_ids,
        )?;
        if expires_at == 0 || expires_at > i64::MAX as u64 {
            return Err(invalid("默认账户授权期限超出跨平台整数范围"));
        }
        let mut payload = Vec::with_capacity(
            32 + 32 + 2 + ordered_account_ids.len() * 32 + 8 + DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES,
        );
        payload.extend_from_slice(genesis_hash.as_bytes());
        payload.extend_from_slice(current_default_account_id.as_bytes());
        encode_scale_compact_len(ordered_account_ids.len(), &mut payload)?;
        for account_id in &ordered_account_ids {
            payload.extend_from_slice(account_id.as_bytes());
        }
        payload.extend_from_slice(&expires_at.to_le_bytes());
        payload.extend_from_slice(&nonce);
        Ok(Self {
            expected_revision,
            current_default_account_id,
            before_account_ids,
            ordered_account_ids,
            expires_at,
            nonce,
            payload,
        })
    }

    pub const fn expected_revision(&self) -> u64 {
        self.expected_revision
    }

    pub const fn current_default_account_id(&self) -> AccountId32 {
        self.current_default_account_id
    }

    pub fn before_account_ids(&self) -> &[AccountId32] {
        &self.before_account_ids
    }

    pub fn ordered_account_ids(&self) -> &[AccountId32] {
        &self.ordered_account_ids
    }

    pub const fn expires_at(&self) -> u64 {
        self.expires_at
    }

    pub const fn nonce(&self) -> &[u8; DEFAULT_ACCOUNT_CHANGE_NONCE_BYTES] {
        &self.nonce
    }

    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    pub fn signing_intent(&self) -> ContractResult<SigningIntent> {
        SigningIntent::try_new(
            self.current_default_account_id,
            self.payload.clone(),
            SigningTransform::Blake2Domain(DEFAULT_ACCOUNT_CHANGE_DOMAIN.to_vec()),
        )
    }
}

pub fn blake2_256(bytes: &[u8]) -> ContractResult<[u8; 32]> {
    let mut output = [0_u8; 32];
    let mut hasher =
        Blake2bVar::new(output.len()).map_err(|_| internal("无法初始化 blake2_256"))?;
    hasher.update(bytes);
    hasher
        .finalize_variable(&mut output)
        .map_err(|_| internal("无法生成 blake2_256"))?;
    Ok(output)
}

fn validate_default_account_change(
    current_default_account_id: AccountId32,
    before_account_ids: &[AccountId32],
    ordered_account_ids: &[AccountId32],
) -> ContractResult<()> {
    if before_account_ids.is_empty()
        || before_account_ids.len() > MAX_DEFAULT_ACCOUNT_CHANGE_ACCOUNTS
        || before_account_ids.first().copied() != Some(current_default_account_id)
        || before_account_ids.len() != ordered_account_ids.len()
        || ordered_account_ids.first().copied() == Some(current_default_account_id)
    {
        return Err(invalid(
            "默认账户变更必须覆盖当前完整账户排列且首项确实改变",
        ));
    }
    let before = before_account_ids.iter().copied().collect::<BTreeSet<_>>();
    let ordered = ordered_account_ids.iter().copied().collect::<BTreeSet<_>>();
    if before.len() != before_account_ids.len()
        || ordered.len() != ordered_account_ids.len()
        || before != ordered
    {
        return Err(invalid("默认账户变更目标必须是当前账户的完整无重复排列"));
    }
    Ok(())
}

fn encode_scale_compact_len(length: usize, output: &mut Vec<u8>) -> ContractResult<()> {
    let length = u32::try_from(length).map_err(|_| invalid("SCALE长度超出u32"))?;
    if length < 1 << 6 {
        output.push((length << 2) as u8);
    } else if length < 1 << 14 {
        output.extend_from_slice(&(((length << 2) | 1) as u16).to_le_bytes());
    } else if length < 1 << 30 {
        output.extend_from_slice(&((length << 2) | 2).to_le_bytes());
    } else {
        return Err(invalid("SCALE长度超出已登记compact范围"));
    }
    Ok(())
}

fn invalid(message: &'static str) -> ContractError {
    ContractError::new(ContractErrorCode::InvalidArgument, message)
}

fn internal(message: &'static str) -> ContractError {
    ContractError::new(ContractErrorCode::Internal, message)
}

#[cfg(test)]
#[path = "../tests/signing.rs"]
mod tests;
