//! CitizenChain 无根热钱包的 BIP-39、password 与 `//index` 派生真源。
//!
//! 本模块只在 Rust 受控秘密缓冲区中处理助记词、master mini-secret 与 child
//! mini-secret。调用者只能取得公开公钥和仍由 [`SecretBuffer`] 拥有的 child；任何
//! Dart、Kotlin 或公共 C ABI 都不得直接调用这些内部函数导出秘密。

use std::sync::Arc;

use bip39::{Language, Mnemonic};
use citizen_sdk_contracts::{
    ChainSigner, ContractError, ContractErrorCode, ContractResult, DerivationJunction,
    SecretBuffer, Sr25519PublicKey, MAX_WALLET_ACCOUNT_INDEX,
};
use hmac::Hmac;
use pbkdf2::pbkdf2;
use sha2::Sha512;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;
use zeroize::{Zeroize, Zeroizing};

use crate::EngineError;

const BIP39_ROUNDS: u32 = 2_048;
const BIP39_SEED_BYTES: usize = 64;
const MINI_SECRET_BYTES: usize = 32;
const OWNER_BYTES: usize = 16;

/// SDK 创建与恢复只接受 12、18、24 词，不接受 BIP-39 的其他词数。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalletWordCount {
    Words12,
    Words18,
    Words24,
}

impl WalletWordCount {
    pub const fn words(self) -> usize {
        match self {
            Self::Words12 => 12,
            Self::Words18 => 18,
            Self::Words24 => 24,
        }
    }

    const fn entropy_bytes(self) -> usize {
        match self {
            Self::Words12 => 16,
            Self::Words18 => 24,
            Self::Words24 => 32,
        }
    }
}

/// 可注入的安全熵源。测试使用确定性实现，正式 Engine 使用操作系统 CSPRNG。
pub trait WalletEntropySource: Send + Sync {
    fn fill(&self, output: &mut [u8]) -> ContractResult<()>;
}

/// 操作系统安全随机数实现。
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemWalletEntropy;

impl WalletEntropySource for SystemWalletEntropy {
    fn fill(&self, output: &mut [u8]) -> ContractResult<()> {
        getrandom::fill(output).map_err(|_| {
            ContractError::new(ContractErrorCode::Unavailable, "操作系统安全随机数不可用")
        })
    }
}

/// 一个已验证派生账户。`secret` 不实现 Clone，并在析构时清零。
pub struct DerivedWalletAccount {
    index: u32,
    public_key: Sr25519PublicKey,
    secret: SecretBuffer,
}

impl DerivedWalletAccount {
    pub const fn index(&self) -> u32 {
        self.index
    }

    pub const fn public_key(&self) -> Sr25519PublicKey {
        self.public_key
    }

    pub fn into_secret(self) -> SecretBuffer {
        self.secret
    }
}

impl core::fmt::Debug for DerivedWalletAccount {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("DerivedWalletAccount")
            .field("index", &self.index)
            .field("public_key", &self.public_key)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

/// 生成 English BIP-39 助记词；返回值仍是不透明可清零缓冲区。
pub fn generate_mnemonic(
    entropy_source: &dyn WalletEntropySource,
    word_count: WalletWordCount,
) -> Result<SecretBuffer, EngineError> {
    let mut entropy = Zeroizing::new(vec![0_u8; word_count.entropy_bytes()]);
    entropy_source.fill(entropy.as_mut_slice())?;
    let mnemonic =
        Mnemonic::from_entropy_in(Language::English, entropy.as_slice()).map_err(|error| {
            EngineError::contract(
                ContractErrorCode::Internal,
                format!("BIP-39 助记词生成失败：{error}"),
            )
        })?;
    let mut sentence = Zeroizing::new(mnemonic.to_string());
    let result = SecretBuffer::try_new(sentence.as_bytes().to_vec()).map_err(EngineError::from);
    sentence.zeroize();
    result
}

/// 从助记词派生多个 child mini-secret；输出顺序与输入 index 完全一致。
pub async fn derive_wallet_accounts(
    signer: Arc<dyn ChainSigner>,
    mnemonic: &SecretBuffer,
    password: &str,
    indices: &[u32],
) -> Result<Vec<DerivedWalletAccount>, EngineError> {
    if indices.is_empty() {
        return Err(EngineError::contract(
            ContractErrorCode::InvalidArgument,
            "派生账户列表不能为空",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    if indices
        .iter()
        .any(|index| *index > MAX_WALLET_ACCOUNT_INDEX || !seen.insert(*index))
    {
        return Err(EngineError::contract(
            ContractErrorCode::InvalidArgument,
            "派生账户 index 必须唯一且位于 0..1989",
        ));
    }

    let normalized_password = validate_wallet_password(password)?;
    let master = mnemonic
        .with_secret(|bytes| derive_master_mini_secret(bytes, normalized_password.as_str()))?;
    let mut accounts = Vec::with_capacity(indices.len());
    for index in indices {
        let junction = DerivationJunction::from_chain_code(hard_junction_chain_code(*index));
        let child = signer.derive_hard(&master, junction).await?;
        let public_key = signer.public_key(&child).await?;
        accounts.push(DerivedWalletAccount {
            index: *index,
            public_key,
            secret: child,
        });
    }
    Ok(accounts)
}

/// 验证并规范化当前产品允许的 BIP-39 password。
///
/// 行为与 Dart `WalletPassword.parse` 一致：空值允许；非空原文和 NFKD 后都必须为
/// 6–30 个 grapheme，且每个 grapheme 只能是单个 ASCII graphic 或 Han 字符。
pub fn validate_wallet_password(password: &str) -> Result<Zeroizing<String>, EngineError> {
    normalize_wallet_password_checked(password).map_err(|reason| {
        use crate::wallet_input::WalletInputReason;
        let message = match reason {
            WalletInputReason::PasswordLength => "密码长度必须为 6–30 位",
            WalletInputReason::PasswordNormalization => "密码包含规范化后无法安全恢复的字符",
            _ => "密码只能使用大写字母、小写字母、数字、指定符号或汉字",
        };
        EngineError::contract(ContractErrorCode::InvalidArgument, message)
    })
}

/// 校验、规范化及错误原因共用此实现，供实际派生与无UI输入事实共同调用。
pub(crate) fn normalize_wallet_password_checked(
    password: &str,
) -> Result<Zeroizing<String>, crate::wallet_input::WalletInputReason> {
    if password.is_empty() {
        return Ok(Zeroizing::new(String::new()));
    }
    validate_password_form(password)?;
    // 先进入可清零容器再做第二次校验；NFKD 后失败也不能遗留普通 String。
    let normalized = Zeroizing::new(password.nfkd().collect::<String>());
    validate_password_form(normalized.as_str())
        .map_err(|_| crate::wallet_input::WalletInputReason::PasswordNormalization)?;
    Ok(normalized)
}

fn validate_password_form(value: &str) -> Result<(), crate::wallet_input::WalletInputReason> {
    use crate::wallet_input::WalletInputReason;
    let graphemes: Vec<_> = UnicodeSegmentation::graphemes(value, true).collect();
    if !(6..=30).contains(&graphemes.len()) {
        return Err(WalletInputReason::PasswordLength);
    }
    if graphemes.iter().any(|grapheme| {
            let mut chars = grapheme.chars();
            let Some(character) = chars.next() else {
                return true;
            };
            chars.next().is_some() || !(character.is_ascii_graphic() || is_han_character(character))
        })
    {
        return Err(WalletInputReason::PasswordFormat);
    }
    Ok(())
}

fn is_han_character(character: char) -> bool {
    // Unicode 16 `Script=Han` 的完整区间。不能用连续 CJK block 粗略代替：例如
    // U+2E9A、U+FA6E 与扩展区间的保留空洞并不属于 Han，而 U+3005、U+3007、
    // U+16FE2 又确实属于 Han。这里与 Dart `\p{Script=Han}` 的语义逐项对齐。
    matches!(
        character as u32,
        0x2E80..=0x2E99
            | 0x2E9B..=0x2EF3
            | 0x2F00..=0x2FD5
            | 0x3005..=0x3005
            | 0x3007..=0x3007
            | 0x3021..=0x3029
            | 0x3038..=0x303B
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFA6D
            | 0xFA70..=0xFAD9
            | 0x16FE2..=0x16FE3
            | 0x16FF0..=0x16FF1
            | 0x20000..=0x2A6DF
            | 0x2A700..=0x2B739
            | 0x2B740..=0x2B81D
            | 0x2B820..=0x2CEA1
            | 0x2CEB0..=0x2EBE0
            | 0x2EBF0..=0x2EE5D
            | 0x2F800..=0x2FA1D
            | 0x30000..=0x3134A
            | 0x31350..=0x323AF
    )
}

fn derive_master_mini_secret(
    mnemonic_bytes: &[u8],
    password: &str,
) -> Result<SecretBuffer, EngineError> {
    let sentence = core::str::from_utf8(mnemonic_bytes).map_err(|_| {
        EngineError::contract(
            ContractErrorCode::InvalidArgument,
            "助记词必须是 UTF-8 English BIP-39 文本",
        )
    })?;
    // UI 校验、导入、恢复和追加账户必须使用同一个词数与 checksum 入口。
    let mnemonic = crate::wallet_input::parse_wallet_mnemonic(sentence, None)?;

    let mut entropy = Zeroizing::new(mnemonic.to_entropy());
    let mut salt = Zeroizing::new(String::with_capacity(8 + password.len()));
    salt.push_str("mnemonic");
    salt.push_str(password);
    let mut seed = Zeroizing::new([0_u8; BIP39_SEED_BYTES]);
    pbkdf2::<Hmac<Sha512>>(
        entropy.as_slice(),
        salt.as_bytes(),
        BIP39_ROUNDS,
        seed.as_mut(),
    )
    .map_err(|_| EngineError::contract(ContractErrorCode::Internal, "Substrate BIP-39 派生失败"))?;
    entropy.zeroize();
    SecretBuffer::try_new(seed[..MINI_SECRET_BYTES].to_vec()).map_err(EngineError::from)
}

/// Substrate `DeriveJunction::fromStr('/index')` 的固定数字 junction 编码。
pub const fn hard_junction_chain_code(index: u32) -> [u8; 32] {
    let mut chain_code = [0_u8; 32];
    let encoded = (index as u64).to_le_bytes();
    let mut offset = 0;
    while offset < encoded.len() {
        chain_code[offset] = encoded[offset];
        offset += 1;
    }
    chain_code
}

/// 从安全熵源铸造不可复用 128 位身份。
pub fn mint_owner(
    entropy_source: &dyn WalletEntropySource,
    forbidden: &std::collections::BTreeSet<[u8; OWNER_BYTES]>,
) -> Result<[u8; OWNER_BYTES], EngineError> {
    for _ in 0..64 {
        let mut candidate = [0_u8; OWNER_BYTES];
        entropy_source.fill(&mut candidate)?;
        if !forbidden.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(EngineError::contract(
        ContractErrorCode::Internal,
        "无法生成不可复用的钱包所有权标识",
    ))
}
