//! SDK 无界面的钱包输入能力；词表、checksum 与派生使用同一个 BIP-39 依赖。
//! 不生成钱包、不访问金库、不持久化输入，错误仅携带位置而不包含单词或秘密。

use bip39::{Language, Mnemonic};
use citizen_sdk_contracts::ContractErrorCode;

use crate::{EngineError, WalletWordCount};

const MAX_INPUT_BYTES: usize = 1024;
const MAX_SUGGESTIONS: usize = 6;

/// 跨语言输入校验原因；只携带功能事实，不提供界面文案或回显输入。
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalletInputReason {
    Valid = 0,
    InputTooLong = 1,
    WordCount = 2,
    UnknownWord = 3,
    Checksum = 4,
    PasswordFormat = 5,
    MnemonicFormat = 6,
    PasswordLength = 7,
    PasswordNormalization = 8,
}

/// position仅在UnknownWord时包含零起始词位置，所有其它原因均为None。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WalletInputValidation {
    pub reason: WalletInputReason,
    pub position: Option<usize>,
}

impl WalletInputValidation {
    pub const fn new(reason: WalletInputReason) -> Self {
        Self { reason, position: None }
    }

    fn into_error(self) -> EngineError {
        let message = match self.reason {
            WalletInputReason::Valid => "钱包输入有效".to_owned(),
            WalletInputReason::InputTooLong => "助记词输入超过长度上限".to_owned(),
            WalletInputReason::WordCount => "助记词只允许与所选词数一致的12、18或24词".to_owned(),
            WalletInputReason::UnknownWord => format!(
                "第 {} 个助记词不在英文词表中", self.position.unwrap_or(0) + 1,
            ),
            WalletInputReason::Checksum => "助记词校验和不正确".to_owned(),
            WalletInputReason::PasswordFormat => "钱包派生密码格式不符".to_owned(),
            WalletInputReason::MnemonicFormat => "助记词无效".to_owned(),
            WalletInputReason::PasswordLength => "密码长度必须为 6–30 位".to_owned(),
            WalletInputReason::PasswordNormalization => "密码包含规范化后无法安全恢复的字符".to_owned(),
        };
        invalid(message)
    }
}

/// 密码规范化与派生共用既有唯一规则；成功后立即释放规范化的可清零副本。
pub fn wallet_password_validation(password: &str) -> WalletInputValidation {
    let reason = if password.len() > MAX_INPUT_BYTES {
        WalletInputReason::InputTooLong
    } else {
        match crate::wallet_derivation::normalize_wallet_password_checked(password) {
            Ok(_) => WalletInputReason::Valid,
            Err(reason) => reason,
        }
    };
    WalletInputValidation::new(reason)
}

/// 返回无UI校验事实；与实际导入/派生走同一解析器，不在绑定层复制BIP-39。
pub fn wallet_mnemonic_validation(
    sentence: &str,
    word_count: WalletWordCount,
) -> WalletInputValidation {
    match parse_mnemonic_checked(sentence, Some(word_count)) {
        Ok(_) => WalletInputValidation::new(WalletInputReason::Valid),
        Err(validation) => validation,
    }
}

/// 校验所选词数和 English BIP-39 checksum；成功不返回助记词副本。
pub fn validate_wallet_mnemonic(
    sentence: &str,
    word_count: WalletWordCount,
) -> Result<(), EngineError> {
    parse_wallet_mnemonic(sentence, Some(word_count)).map(|_| ())
}

/// 只返回官方词表中的静态候选词，最多六项；不会返回调用方输入。
/// 空前缀无建议。前缀仅接受小写 ASCII，不隐式改写用户正在输入的单词。
pub fn wallet_word_suggestions(prefix: &str) -> Result<Vec<&'static str>, EngineError> {
    if prefix.len() > MAX_INPUT_BYTES || !prefix.bytes().all(|byte| byte.is_ascii_lowercase()) {
        return Err(invalid("助记词前缀必须是小写英文字母"));
    }
    if prefix.is_empty() {
        return Ok(Vec::new());
    }
    Ok(Language::English
        .word_list()
        .iter()
        .copied()
        .filter(|word| word.starts_with(prefix))
        .take(MAX_SUGGESTIONS)
        .collect())
}

/// `None`仅供核心派生从输入识别词数；公开校验必须传入显式选择值。
/// Mnemonic 开启上游 zeroize 特性，验证和派生返回后其内部索引也会清零。
pub(crate) fn parse_wallet_mnemonic(
    sentence: &str,
    selected: Option<WalletWordCount>,
) -> Result<Mnemonic, EngineError> {
    parse_mnemonic_checked(sentence, selected).map_err(WalletInputValidation::into_error)
}

fn parse_mnemonic_checked(
    sentence: &str,
    selected: Option<WalletWordCount>,
) -> Result<Mnemonic, WalletInputValidation> {
    if sentence.len() > MAX_INPUT_BYTES {
        return Err(WalletInputValidation::new(WalletInputReason::InputTooLong));
    }
    let count = sentence.split_whitespace().count();
    if !matches!(count, 12 | 18 | 24) {
        return Err(WalletInputValidation::new(WalletInputReason::WordCount));
    }
    if selected.is_some_and(|word_count| word_count.words() != count) {
        return Err(WalletInputValidation::new(WalletInputReason::WordCount));
    }
    Mnemonic::parse_in(Language::English, sentence.trim()).map_err(|error| match error {
        bip39::Error::UnknownWord(index) => WalletInputValidation {
            reason: WalletInputReason::UnknownWord,
            position: Some(index),
        },
        bip39::Error::InvalidChecksum => WalletInputValidation::new(WalletInputReason::Checksum),
        _ => WalletInputValidation::new(WalletInputReason::MnemonicFormat),
    })
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::contract(ContractErrorCode::InvalidArgument, message)
}
