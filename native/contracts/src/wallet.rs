//! 不含助记词、母种子、mini-secret 或私钥的钱包公开状态模型。

use std::collections::{BTreeSet, HashSet};

use blake2::{Blake2b512, Digest};

use crate::{
    AccountId32, ContractError, ContractErrorCode, ContractResult, SecretRef, VaultGeneration,
};

/// 与当前已验证热钱包一致的最大硬派生账户 index。
pub const MAX_WALLET_ACCOUNT_INDEX: u32 = 1989;
/// 当前已验证公民链热钱包只有一只无根钱包，固定使用 wallet index 0。
pub const CITIZEN_WALLET_INDEX: u32 = 0;
/// CitizenChain Runtime 与现有稳定 Dart 钱包共同使用的 SS58 prefix。
pub const CITIZEN_SS58_PREFIX: u16 = 2027;
/// 本机账户名称最多包含 30 个 Unicode scalar，与现有 Dart `runes.length` 一致。
pub const MAX_WALLET_ACCOUNT_NAME_SCALARS: usize = 30;
/// 冷账户是独立导入的公开身份；上限只用于约束宿主持久化分配，不代表可派生范围。
pub const MAX_COLD_WALLET_ACCOUNTS: usize = MAX_WALLET_ACCOUNT_INDEX as usize + 1;
/// `0` 永久保留给唯一热钱包；冷账户使用单调且不复用的本机 wallet index。
pub const FIRST_COLD_WALLET_INDEX: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalletOrigin {
    Created,
    Imported,
}

/// 一个账户由本机秘密直接签名，或由独立公民钱包通过二维码完成离线签名。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WalletSignMode {
    Hot,
    Cold,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletAccount {
    index: u32,
    account_id: AccountId32,
    secret_ref: SecretRef,
    ss58_address: String,
    name: String,
    created_at_millis: u64,
}

impl WalletAccount {
    pub fn try_new(
        index: u32,
        account_id: AccountId32,
        secret_ref: SecretRef,
        ss58_address: impl Into<String>,
        name: impl Into<String>,
        created_at_millis: u64,
    ) -> ContractResult<Self> {
        let ss58_address = ss58_address.into();
        let name = normalize_wallet_account_name(name.into())?;
        if secret_ref.account_id() != account_id || ss58_address != citizen_ss58_address(account_id)
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "钱包账户、秘密引用和 SS58 展示地址不一致",
            ));
        }
        Ok(Self {
            index,
            account_id,
            secret_ref,
            ss58_address,
            name,
            created_at_millis,
        })
    }

    pub const fn index(&self) -> u32 {
        self.index
    }

    pub const fn account_id(&self) -> AccountId32 {
        self.account_id
    }

    pub const fn secret_ref(&self) -> SecretRef {
        self.secret_ref
    }

    pub fn ss58_address(&self) -> &str {
        &self.ss58_address
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }

    /// 重建只改变本机展示名称的账户事实；账户、秘密引用和创建时间保持逐字节不变。
    pub fn try_with_name(&self, name: impl Into<String>) -> ContractResult<Self> {
        Self::try_new(
            self.index,
            self.account_id,
            self.secret_ref,
            self.ss58_address.clone(),
            name,
            self.created_at_millis,
        )
    }
}

/// 仅公钥冷账户。它没有派生账户、`SecretRef`、generation 或任何设备秘密生命周期。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ColdWalletAccount {
    wallet_index: u32,
    account_id: AccountId32,
    ss58_address: String,
    name: String,
    created_at_millis: u64,
}

impl ColdWalletAccount {
    pub fn try_new(
        wallet_index: u32,
        account_id: AccountId32,
        ss58_address: impl Into<String>,
        name: impl Into<String>,
        created_at_millis: u64,
    ) -> ContractResult<Self> {
        let ss58_address = ss58_address.into();
        if wallet_index < FIRST_COLD_WALLET_INDEX
            || ss58_address != citizen_ss58_address(account_id)
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "冷账户必须使用非零 wallet index 且 AccountId 与规范 SS58 地址一致",
            ));
        }
        Ok(Self {
            wallet_index,
            account_id,
            ss58_address,
            name: normalize_wallet_account_name(name.into())?,
            created_at_millis,
        })
    }

    pub const fn wallet_index(&self) -> u32 {
        self.wallet_index
    }

    pub const fn account_id(&self) -> AccountId32 {
        self.account_id
    }

    pub fn ss58_address(&self) -> &str {
        &self.ss58_address
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub const fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }

    pub fn try_with_name(&self, name: impl Into<String>) -> ContractResult<Self> {
        Self::try_new(
            self.wallet_index,
            self.account_id,
            self.ss58_address.clone(),
            name,
            self.created_at_millis,
        )
    }
}

/// 由 AccountId32 生成唯一规范的 CitizenChain SS58 展示地址。
pub fn citizen_ss58_address(account_id: AccountId32) -> String {
    let prefix = CITIZEN_SS58_PREFIX;
    let mut payload = Vec::with_capacity(36);
    payload.push(((prefix & 0b0000_0000_1111_1100) as u8) >> 2 | 0b0100_0000);
    payload.push(((prefix >> 8) as u8) | ((prefix & 0b11) as u8) << 6);
    payload.extend_from_slice(account_id.as_bytes());

    let mut hasher = Blake2b512::new();
    hasher.update(b"SS58PRE");
    hasher.update(&payload);
    let checksum = hasher.finalize();
    payload.extend_from_slice(&checksum[..2]);
    bs58::encode(payload).into_string()
}

/// 严格解析 CitizenChain AccountId32 地址，并拒绝其它网络、坏校验和及非规范 Base58。
pub fn parse_citizen_ss58_address(address: &str) -> ContractResult<AccountId32> {
    // AccountId32 的双字节 prefix SS58 地址当前为 49 字符；先设小的硬上限再进入 Base58。
    if address.is_empty() || address.len() > 64 {
        return Err(invalid_ss58());
    }
    let decoded = bs58::decode(address)
        .into_vec()
        .map_err(|_| invalid_ss58())?;
    if decoded.len() != 36 {
        return Err(invalid_ss58());
    }
    let expected_prefix = ss58_prefix_bytes(CITIZEN_SS58_PREFIX);
    if decoded[..2] != expected_prefix {
        return Err(invalid_ss58());
    }

    let payload = &decoded[..34];
    let mut hasher = Blake2b512::new();
    hasher.update(b"SS58PRE");
    hasher.update(payload);
    let checksum = hasher.finalize();
    if decoded[34..] != checksum[..2] {
        return Err(invalid_ss58());
    }

    let mut account_id = [0_u8; 32];
    account_id.copy_from_slice(&decoded[2..34]);
    let account_id = AccountId32::from_bytes(account_id);
    if citizen_ss58_address(account_id) != address {
        return Err(invalid_ss58());
    }
    Ok(account_id)
}

fn ss58_prefix_bytes(prefix: u16) -> [u8; 2] {
    [
        ((prefix & 0b0000_0000_1111_1100) as u8) >> 2 | 0b0100_0000,
        ((prefix >> 8) as u8) | ((prefix & 0b11) as u8) << 6,
    ]
}

fn invalid_ss58() -> ContractError {
    ContractError::new(
        ContractErrorCode::InvalidArgument,
        "必须提供 prefix 2027、校验和正确的规范 CitizenChain SS58 地址",
    )
}

fn normalize_wallet_account_name(name: String) -> ContractResult<String> {
    let normalized = name.trim();
    if normalized.is_empty()
        || normalized.chars().count() > MAX_WALLET_ACCOUNT_NAME_SCALARS
        || normalized.chars().any(|character| {
            character <= '\u{001f}' || ('\u{007f}'..='\u{009f}').contains(&character)
        })
    {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "账户名称修剪后必须包含 1..30 个 Unicode scalar 且不得含控制字符",
        ));
    }
    Ok(normalized.to_owned())
}

/// 单只无根热钱包的公开资料。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletProfile {
    wallet_index: u32,
    wallet_name: String,
    generation: VaultGeneration,
    master_account_id: AccountId32,
    origin: WalletOrigin,
    created_at_millis: u64,
    active_account_id: AccountId32,
    accounts: Vec<WalletAccount>,
}

impl WalletProfile {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        wallet_index: u32,
        generation: VaultGeneration,
        master_account_id: AccountId32,
        origin: WalletOrigin,
        created_at_millis: u64,
        active_account_id: AccountId32,
        accounts: Vec<WalletAccount>,
    ) -> ContractResult<Self> {
        if wallet_index != CITIZEN_WALLET_INDEX || accounts.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "公民链热钱包必须使用 wallet index 0 且至少包含一个账户",
            ));
        }
        let indices: BTreeSet<_> = accounts.iter().map(WalletAccount::index).collect();
        let account_ids: BTreeSet<_> = accounts.iter().map(WalletAccount::account_id).collect();
        if indices.len() != accounts.len() || account_ids.len() != accounts.len() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "钱包账户 index 与 AccountId 必须唯一",
            ));
        }
        let account_zero_matches_master = accounts
            .iter()
            .any(|account| account.index() == 0 && account.account_id() == master_account_id);
        if !account_zero_matches_master
            || accounts
                .iter()
                .any(|account| account.index() > MAX_WALLET_ACCOUNT_INDEX)
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "账户0必须是 masterAccountId，且账户 index 不得超过 1989",
            ));
        }
        if !account_ids.contains(&active_account_id)
            || accounts.iter().any(|account| {
                account.secret_ref().wallet_index() != wallet_index
                    || account.secret_ref().generation() != generation
            })
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "active account 或秘密引用不属于当前钱包生命周期",
            ));
        }
        let secret_owners: HashSet<_> = accounts
            .iter()
            .map(|account| account.secret_ref().owner())
            .collect();
        if secret_owners.len() != accounts.len()
            || accounts
                .iter()
                .any(|account| account.secret_ref().owner().as_bytes() == generation.as_bytes())
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "账户秘密 owner 必须唯一且不得复用钱包 generation",
            ));
        }
        Ok(Self {
            wallet_index,
            wallet_name: format!("钱包{wallet_index}"),
            generation,
            master_account_id,
            origin,
            created_at_millis,
            active_account_id,
            accounts,
        })
    }

    pub const fn wallet_index(&self) -> u32 {
        self.wallet_index
    }

    /// 钱包级本机名称独立于每个账户的name，不影响任何链上身份。
    pub fn wallet_name(&self) -> &str { &self.wallet_name }

    pub fn try_with_wallet_name(&self, wallet_name: impl Into<String>) -> ContractResult<Self> {
        let mut next = self.clone();
        next.wallet_name = normalize_wallet_account_name(wallet_name.into())?;
        Ok(next)
    }

    pub const fn generation(&self) -> VaultGeneration {
        self.generation
    }

    pub const fn master_account_id(&self) -> AccountId32 {
        self.master_account_id
    }

    pub const fn origin(&self) -> WalletOrigin {
        self.origin
    }

    pub const fn created_at_millis(&self) -> u64 {
        self.created_at_millis
    }

    pub const fn active_account_id(&self) -> AccountId32 {
        self.active_account_id
    }

    pub fn accounts(&self) -> &[WalletAccount] {
        &self.accounts
    }

    pub fn account_by_id(&self, account_id: AccountId32) -> Option<&WalletAccount> {
        self.accounts
            .iter()
            .find(|account| account.account_id() == account_id)
    }

    pub fn account_by_index(&self, index: u32) -> Option<&WalletAccount> {
        self.accounts
            .iter()
            .find(|account| account.index() == index)
    }

    /// 只切换当前账户；其它 profile 字段和账户顺序保持不变。
    pub fn try_with_active_account(&self, active_account_id: AccountId32) -> ContractResult<Self> {
        Self::try_new(
            self.wallet_index,
            self.generation,
            self.master_account_id,
            self.origin,
            self.created_at_millis,
            active_account_id,
            self.accounts.clone(),
        )?.try_with_wallet_name(self.wallet_name.clone())
    }

    /// 只重命名一个已存在账户，不触碰任何秘密或链上身份。
    pub fn try_with_account_name(
        &self,
        account_id: AccountId32,
        name: impl Into<String>,
    ) -> ContractResult<Self> {
        let Some(position) = self
            .accounts
            .iter()
            .position(|account| account.account_id() == account_id)
        else {
            return Err(ContractError::new(
                ContractErrorCode::NotFound,
                "未找到待重命名的钱包账户",
            ));
        };
        let mut accounts = self.accounts.clone();
        accounts[position] = accounts[position].try_with_name(name)?;
        Self::try_new(
            self.wallet_index,
            self.generation,
            self.master_account_id,
            self.origin,
            self.created_at_millis,
            self.active_account_id,
            accounts,
        )?.try_with_wallet_name(self.wallet_name.clone())
    }

    /// 生成删除一个非锚点账户后的公开 profile，并返回被移除账户供 Engine 建立 exact cleanup。
    ///
    /// 账户0只能通过整钱包删除路径移除；若删除当前账户，active 自动回到账户0锚点。
    pub fn try_without_child_account(
        &self,
        account_id: AccountId32,
    ) -> ContractResult<(Self, WalletAccount)> {
        let Some(position) = self
            .accounts
            .iter()
            .position(|account| account.account_id() == account_id)
        else {
            return Err(ContractError::new(
                ContractErrorCode::NotFound,
                "未找到待删除的钱包账户",
            ));
        };
        if self.accounts[position].index() == 0 {
            return Err(ContractError::new(
                ContractErrorCode::InvalidState,
                "账户0是钱包锚点，只能通过整钱包删除路径移除",
            ));
        }
        let mut accounts = self.accounts.clone();
        let removed = accounts.remove(position);
        let active_account_id = if self.active_account_id == account_id {
            self.master_account_id
        } else {
            self.active_account_id
        };
        let next = Self::try_new(
            self.wallet_index,
            self.generation,
            self.master_account_id,
            self.origin,
            self.created_at_millis,
            active_account_id,
            accounts,
        )?.try_with_wallet_name(self.wallet_name.clone())?;
        Ok((next, removed))
    }
}

/// 秘密写入前必须先以 CAS 持久化的操作所有权。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletProvisioningPlan {
    operation_id: [u8; 16],
    wallet_index: u32,
    generation: VaultGeneration,
    previous_profile: Option<WalletProfile>,
    secret_refs: Vec<SecretRef>,
    delete_wallet_key_on_rollback: bool,
}

impl WalletProvisioningPlan {
    pub fn try_new(
        operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
        previous_profile: Option<WalletProfile>,
        secret_refs: Vec<SecretRef>,
        delete_wallet_key_on_rollback: bool,
    ) -> ContractResult<Self> {
        let unique_refs: HashSet<_> = secret_refs.iter().copied().collect();
        if wallet_index != CITIZEN_WALLET_INDEX
            || secret_refs.is_empty()
            || unique_refs.len() != secret_refs.len()
            || secret_refs.iter().any(|secret_ref| {
                secret_ref.wallet_index() != wallet_index || secret_ref.generation() != generation
            })
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "provisioning 计划必须精确拥有当前钱包生命周期的秘密集合",
            ));
        }
        Ok(Self {
            operation_id,
            wallet_index,
            generation,
            previous_profile,
            secret_refs,
            delete_wallet_key_on_rollback,
        })
    }

    pub const fn operation_id(&self) -> &[u8; 16] {
        &self.operation_id
    }

    pub const fn wallet_index(&self) -> u32 {
        self.wallet_index
    }

    pub const fn generation(&self) -> VaultGeneration {
        self.generation
    }

    pub fn previous_profile(&self) -> Option<&WalletProfile> {
        self.previous_profile.as_ref()
    }

    pub fn secret_refs(&self) -> &[SecretRef] {
        &self.secret_refs
    }

    pub const fn delete_wallet_key_on_rollback(&self) -> bool {
        self.delete_wallet_key_on_rollback
    }
}

/// 已提交公开事实后仍需幂等完成的精确补偿计划。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletCleanupPlan {
    operation_id: [u8; 16],
    wallet_index: u32,
    generation: VaultGeneration,
    secret_refs: Vec<SecretRef>,
    delete_wallet_key: bool,
}

/// 实际cleanup计划和只读目标投影共用这一条精确引用边界；不构造假operation_id。
fn validate_cleanup_refs(wallet_index: u32, generation: VaultGeneration, secret_refs: &[SecretRef]) -> ContractResult<()> {
        let unique_refs: HashSet<_> = secret_refs.iter().copied().collect();
        if wallet_index != CITIZEN_WALLET_INDEX
            || secret_refs.is_empty()
            || unique_refs.len() != secret_refs.len()
            || secret_refs.iter().any(|secret_ref| {
                secret_ref.wallet_index() != wallet_index || secret_ref.generation() != generation
            })
        {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "cleanup 计划不得命中其它钱包生命周期",
            ));
        }
    Ok(())
}

impl WalletCleanupPlan {
    pub fn try_new(
        operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
        secret_refs: Vec<SecretRef>,
        delete_wallet_key: bool,
    ) -> ContractResult<Self> {
        validate_cleanup_refs(wallet_index, generation, &secret_refs)?;
        Ok(Self {
            operation_id,
            wallet_index,
            generation,
            secret_refs,
            delete_wallet_key,
        })
    }

    pub const fn operation_id(&self) -> &[u8; 16] {
        &self.operation_id
    }

    pub const fn wallet_index(&self) -> u32 {
        self.wallet_index
    }

    pub const fn generation(&self) -> VaultGeneration {
        self.generation
    }

    pub fn secret_refs(&self) -> &[SecretRef] {
        &self.secret_refs
    }

    pub const fn delete_wallet_key(&self) -> bool {
        self.delete_wallet_key
    }
}


/// 诊断只描述不合法事实，不新增第三种可签名模式。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum WalletDiagnosticReason {
    InvalidSignMode = 1,
    InvalidIdentity = 2,
    InvalidStructure = 3,
}

/// 持久槽中的原始公开账户。不能直接用于签名；有效性仍由WalletAccount唯一校验器裁决。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletRecordAccount {
    pub index: u32,
    pub account_id: AccountId32,
    pub secret_ref: SecretRef,
    pub ss58_address: String,
    pub name: String,
    pub created_at_millis: u64,
}
impl WalletRecordAccount {
    fn validate_shape(&self) -> ContractResult<()> {
        if self.ss58_address.len() > 128 || self.name.len() > 120 || normalize_wallet_account_name(self.name.clone())? != self.name {
            return Err(invalid_wallet_record());
        }
        Ok(())
    }
    fn validated(&self) -> ContractResult<WalletAccount> {
        self.validate_shape()?;
        WalletAccount::try_new(self.index, self.account_id, self.secret_ref,
            self.ss58_address.clone(), self.name.clone(), self.created_at_millis)
    }
    fn from_account(value: &WalletAccount) -> Self {
        Self { index: value.index(), account_id: value.account_id(), secret_ref: value.secret_ref(),
            ss58_address: value.ss58_address().to_owned(), name: value.name().to_owned(),
            created_at_millis: value.created_at_millis() }
    }
}

/// Profile/Account只表示唯一v3的原持久槽形状，绝不依据形状猜测hot/cold授权。
/// 异常原文只保存在原槽，正常投影仍使用既有严格模型，不建立另一份持久目录。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WalletRecord {
    Profile {
        wallet_index: u32,
        wallet_name: String,
        sign_mode: String,
        generation: VaultGeneration,
        master_account_id: AccountId32,
        origin: WalletOrigin,
        created_at_millis: u64,
        active_account_id: AccountId32,
        accounts: Vec<WalletRecordAccount>,
    },
    Account {
        wallet_index: u32,
        sign_mode: String,
        account_id: AccountId32,
        ss58_address: String,
        name: String,
        created_at_millis: u64,
    },
}
impl WalletRecord {
    pub fn from_profile(value: &WalletProfile) -> Self {
        Self::Profile { wallet_index: value.wallet_index(), wallet_name: value.wallet_name().to_owned(),
            sign_mode: "hot".to_owned(), generation: value.generation(), master_account_id: value.master_account_id(),
            origin: value.origin(), created_at_millis: value.created_at_millis(),
            active_account_id: value.active_account_id(), accounts: value.accounts().iter().map(WalletRecordAccount::from_account).collect() }
    }
    pub fn from_cold_account(value: &ColdWalletAccount) -> Self {
        Self::Account { wallet_index: value.wallet_index(), sign_mode: "cold".to_owned(),
            account_id: value.account_id(), ss58_address: value.ss58_address().to_owned(),
            name: value.name().to_owned(), created_at_millis: value.created_at_millis() }
    }
    pub fn validate_shape(&self) -> ContractResult<()> {
        if self.sign_mode().len() > 32 || self.wallet_name().len() > 120 || normalize_wallet_account_name(self.wallet_name().to_owned())? != self.wallet_name() {
            return Err(invalid_wallet_record());
        }
        match self {
            Self::Profile { wallet_index, accounts, .. } => {
                if *wallet_index != CITIZEN_WALLET_INDEX || accounts.len() > MAX_WALLET_ACCOUNT_INDEX as usize + 1 {
                    return Err(invalid_wallet_record());
                }
                for account in accounts { account.validate_shape()?; }
            }
            Self::Account { wallet_index, ss58_address, .. } => {
                if *wallet_index < FIRST_COLD_WALLET_INDEX || ss58_address.len() > 128 { return Err(invalid_wallet_record()); }
            }
        }
        Ok(())
    }
    pub fn wallet_index(&self) -> u32 {
        match self { Self::Profile { wallet_index, .. } | Self::Account { wallet_index, .. } => *wallet_index }
    }
    pub fn wallet_name(&self) -> &str {
        match self { Self::Profile { wallet_name, .. } => wallet_name, Self::Account { name, .. } => name }
    }
    pub fn account_id(&self) -> AccountId32 {
        match self { Self::Profile { master_account_id, .. } => *master_account_id, Self::Account { account_id, .. } => *account_id }
    }
    pub fn sign_mode(&self) -> &str {
        match self { Self::Profile { sign_mode, .. } | Self::Account { sign_mode, .. } => sign_mode }
    }
    pub fn mode_is_invalid(&self) -> bool { !matches!(self.sign_mode(), "hot" | "cold") }
    /// 仅投影原文的已知模式供宿主展示；异常记录仍不进入普通签名目录。
    pub fn known_sign_mode(&self) -> Option<WalletSignMode> {
        match self.sign_mode() { "hot" => Some(WalletSignMode::Hot), "cold" => Some(WalletSignMode::Cold), _ => None }
    }
    /// 公开关联清理只投影精确拥有的账户，不携带秘密引用或把SS58别名扩大成目标。
    pub fn cleanup_targets(&self) -> ContractResult<(Vec<AccountId32>, bool)> {
        self.validate_shape()?;
        match self {
            Self::Profile { .. } => {
                let refs = self.cleanup_refs()?;
                let ids: BTreeSet<_> = refs.iter().copied().map(SecretRef::account_id).collect();
                Ok((ids.into_iter().collect(), true))
            }
            Self::Account { account_id, .. } => Ok((vec![*account_id], false)),
        }
    }
    pub fn generation(&self) -> Option<VaultGeneration> {
        match self { Self::Profile { generation, .. } => Some(*generation), Self::Account { .. } => None }
    }
    pub fn ss58_address(&self) -> Option<&str> {
        match self {
            Self::Account { ss58_address, .. } => Some(ss58_address),
            Self::Profile { accounts, .. } => {
                let mut anchors = accounts.iter().filter(|account| account.index == 0);
                let first = anchors.next()?;
                if anchors.next().is_some() { None } else { Some(first.ss58_address.as_str()) }
            }
        }
    }

    /// 修复和普通解码共用原严格身份校验；本函数本身不授予合法模式或设备控制权。
    pub fn validate_profile_identity(&self) -> ContractResult<WalletProfile> {
        self.validate_shape()?;
        let Self::Profile { wallet_index, wallet_name, generation, master_account_id, origin,
            created_at_millis, active_account_id, accounts, .. } = self else { return Err(invalid_wallet_record()); };
        let accounts = accounts.iter().map(WalletRecordAccount::validated).collect::<ContractResult<Vec<_>>>()?;
        WalletProfile::try_new(*wallet_index, *generation, *master_account_id, *origin,
            *created_at_millis, *active_account_id, accounts)?.try_with_wallet_name(wallet_name.clone())
    }
    pub fn validate_cold_identity(&self) -> ContractResult<ColdWalletAccount> {
        self.validate_shape()?;
        let Self::Account { wallet_index, account_id, ss58_address, name, created_at_millis, .. } = self else {
            return Err(invalid_wallet_record());
        };
        ColdWalletAccount::try_new(*wallet_index, *account_id, ss58_address.clone(), name.clone(), *created_at_millis)
    }
    pub fn diagnostic_reason(&self) -> Option<WalletDiagnosticReason> {
        if self.validate_shape().is_err() { return Some(WalletDiagnosticReason::InvalidStructure); }
        if self.mode_is_invalid() { return Some(WalletDiagnosticReason::InvalidSignMode); }
        if self.ss58_address().is_some_and(|address| address != citizen_ss58_address(self.account_id())) {
            return Some(WalletDiagnosticReason::InvalidIdentity);
        }
        if let Self::Profile { accounts, .. } = self {
            if accounts.iter().any(|account| account.account_id != account.secret_ref.account_id() ||
                account.ss58_address != citizen_ss58_address(account.account_id)) {
                return Some(WalletDiagnosticReason::InvalidIdentity);
            }
        }
        let valid = match self {
            Self::Profile { sign_mode, .. } => sign_mode == "hot" && self.validate_profile_identity().is_ok(),
            Self::Account { sign_mode, .. } => sign_mode == "cold" && self.validate_cold_identity().is_ok(),
        };
        (!valid).then_some(WalletDiagnosticReason::InvalidStructure)
    }
    pub fn try_with_wallet_name(&self, value: &str) -> ContractResult<Self> {
        let value = normalize_wallet_account_name(value.to_owned())?;
        let mut next = self.clone();
        match &mut next { Self::Profile { wallet_name, .. } => *wallet_name = value, Self::Account { name, .. } => *name = value }
        Ok(next)
    }

    /// 清理只接受同一完整wallet/generation的精确引用；展示地址损坏不允许改指其它秘密。
    pub fn cleanup_refs(&self) -> ContractResult<Vec<SecretRef>> {
        self.validate_shape()?;
        let Self::Profile { wallet_index, generation, accounts, .. } = self else { return Err(invalid_wallet_record()); };
        let refs: Vec<_> = accounts.iter().map(|account| account.secret_ref).collect();
        validate_cleanup_refs(*wallet_index, *generation, &refs)?;
        if accounts.iter().any(|account| account.secret_ref.wallet_index() != *wallet_index ||
            account.secret_ref.generation() != *generation || account.secret_ref.account_id() != account.account_id) {
            return Err(invalid_wallet_record());
        }
        Ok(refs)
    }
    pub fn account_ids(&self) -> BTreeSet<AccountId32> {
        let mut ids = BTreeSet::from([self.account_id()]);
        if let Some(address) = self.ss58_address() {
            if let Ok(account_id) = parse_citizen_ss58_address(address) { ids.insert(account_id); }
        }
        if let Self::Profile { accounts, .. } = self {
            for account in accounts {
                ids.insert(account.account_id); ids.insert(account.secret_ref.account_id());
                if let Ok(account_id) = parse_citizen_ss58_address(&account.ss58_address) { ids.insert(account_id); }
            }
        }
        ids
    }
    pub fn contains_account(&self, account_id: AccountId32) -> bool { self.account_ids().contains(&account_id) }
}

fn invalid_wallet_record() -> ContractError {
    ContractError::new(ContractErrorCode::InvalidArgument, "钱包记录边界或身份归属无效")
}


/// 钱包公开事实、在途所有权和补偿队列的一次原子快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WalletState {
    revision: u64,
    active_wallet_index: Option<u32>,
    profile: Option<WalletProfile>,
    cold_accounts: Vec<ColdWalletAccount>,
    diagnostics: Vec<WalletRecord>,
    ordered_account_ids: Vec<AccountId32>,
    next_cold_wallet_index: u32,
    provisioning: Option<WalletProvisioningPlan>,
    cleanup: Option<WalletCleanupPlan>,
    cleanup_queue: Vec<WalletCleanupPlan>,
}

impl WalletState {
    pub const fn empty() -> Self {
        Self {
            revision: 0,
            active_wallet_index: None,
            profile: None,
            cold_accounts: Vec::new(),
            diagnostics: Vec::new(),
            ordered_account_ids: Vec::new(),
            next_cold_wallet_index: FIRST_COLD_WALLET_INDEX,
            provisioning: None,
            cleanup: None,
            cleanup_queue: Vec::new(),
        }
    }

    pub fn try_from_parts(
        revision: u64,
        profile: Option<WalletProfile>,
        provisioning: Option<WalletProvisioningPlan>,
        cleanup: Option<WalletCleanupPlan>,
        cleanup_queue: Vec<WalletCleanupPlan>,
    ) -> ContractResult<Self> {
        let ordered_account_ids = profile
            .as_ref()
            .map(|profile| {
                profile
                    .accounts()
                    .iter()
                    .map(WalletAccount::account_id)
                    .collect()
            })
            .unwrap_or_default();
        Self::try_from_catalog_parts(
            revision,
            profile,
            Vec::new(),
            ordered_account_ids,
            FIRST_COLD_WALLET_INDEX,
            provisioning,
            cleanup,
            cleanup_queue,
        )
    }

    /// 重建完整钱包事实。该入口是宿主持久化解码和 Engine CAS 的唯一完整状态构造器。
    #[allow(clippy::too_many_arguments)]
    pub fn try_from_catalog_parts(
        revision: u64,
        profile: Option<WalletProfile>,
        cold_accounts: Vec<ColdWalletAccount>,
        ordered_account_ids: Vec<AccountId32>,
        next_cold_wallet_index: u32,
        provisioning: Option<WalletProvisioningPlan>,
        cleanup: Option<WalletCleanupPlan>,
        cleanup_queue: Vec<WalletCleanupPlan>,
    ) -> ContractResult<Self> {
        validate_account_catalog(
            profile.as_ref(),
            &cold_accounts,
            &ordered_account_ids,
            next_cold_wallet_index,
        )?;
        if cleanup_queue.len() > 64 {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "cleanup queue 不得超过 64 项",
            ));
        }
        if provisioning.is_some() && cleanup.is_some() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "provisioning 与 cleanup 不能同时取得钱包操作所有权",
            ));
        }

        let mut wallet_indices = BTreeSet::new();
        if let Some(profile) = profile.as_ref() {
            wallet_indices.insert(profile.wallet_index());
        }
        if let Some(plan) = provisioning.as_ref() {
            wallet_indices.insert(plan.wallet_index());
            let Some(target) = profile.as_ref() else {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "provisioning 必须携带本次操作的目标公开事实",
                ));
            };
            if plan.wallet_index() != target.wallet_index()
                || plan.generation() != target.generation()
            {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "provisioning 必须属于目标钱包生命周期",
                ));
            }
            match plan.previous_profile() {
                None => {
                    let target_refs: HashSet<_> = target
                        .accounts()
                        .iter()
                        .map(WalletAccount::secret_ref)
                        .collect();
                    let planned_refs: HashSet<_> = plan.secret_refs().iter().copied().collect();
                    if !plan.delete_wallet_key_on_rollback() || planned_refs != target_refs {
                        return Err(ContractError::new(
                            ContractErrorCode::InvalidArgument,
                            "新钱包 provisioning 必须拥有全部目标秘密并在回滚时删除钱包密钥",
                        ));
                    }
                }
                Some(previous) => {
                    if plan.delete_wallet_key_on_rollback()
                        || !profile_is_exact_subset(previous, target)
                    {
                        return Err(ContractError::new(
                            ContractErrorCode::InvalidArgument,
                            "追加账户 provisioning 的前态必须是目标 profile 的严格前缀",
                        ));
                    }
                    let previous_owners: HashSet<_> = previous
                        .accounts()
                        .iter()
                        .map(|account| account.secret_ref().owner())
                        .collect();
                    let added_refs: HashSet<_> = target
                        .accounts()
                        .iter()
                        .filter(|account| !previous_owners.contains(&account.secret_ref().owner()))
                        .map(WalletAccount::secret_ref)
                        .collect();
                    let planned_refs: HashSet<_> = plan.secret_refs().iter().copied().collect();
                    if planned_refs != added_refs {
                        return Err(ContractError::new(
                            ContractErrorCode::InvalidArgument,
                            "追加账户 provisioning 必须精确拥有新增账户秘密",
                        ));
                    }
                }
            }
        }
        if let Some(plan) = cleanup.as_ref() {
            wallet_indices.insert(plan.wallet_index());
            if profile.is_none() && !plan.delete_wallet_key() {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "整钱包删除计划必须清理钱包硬件密钥",
                ));
            }
            if profile
                .as_ref()
                .is_some_and(|profile| !cleanup_can_coexist_with_profile(plan, profile))
            {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "活动 cleanup 不得指向现存公开账户或钱包密钥",
                ));
            }
        }
        for plan in &cleanup_queue {
            wallet_indices.insert(plan.wallet_index());
        }
        if wallet_indices.len() > 1 {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "一个 WalletState 不得混合不同 wallet index",
            ));
        }

        let mut operation_ids = HashSet::new();
        let mut accepted_cleanup = Vec::new();
        if let Some(plan) = provisioning.as_ref() {
            operation_ids.insert(*plan.operation_id());
        }
        if let Some(plan) = cleanup.as_ref() {
            if !operation_ids.insert(*plan.operation_id()) {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "钱包操作所有权标识不得重复",
                ));
            }
            accepted_cleanup.push(plan);
        }
        for plan in &cleanup_queue {
            if !operation_ids.insert(*plan.operation_id()) {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "钱包在途操作与补偿队列的 operation id 必须唯一",
                ));
            }
            if profile
                .as_ref()
                .is_some_and(|profile| !cleanup_can_coexist_with_profile(plan, profile))
            {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "cleanup queue 不得指向现存公开账户或钱包密钥",
                ));
            }
            if accepted_cleanup
                .iter()
                .any(|accepted| cleanup_plans_overlap(accepted, plan))
            {
                return Err(ContractError::new(
                    ContractErrorCode::InvalidArgument,
                    "cleanup 计划不得重复拥有相同物理清理目标",
                ));
            }
            accepted_cleanup.push(plan);
        }

        Ok(Self {
            revision,
            active_wallet_index: None,
            profile,
            cold_accounts,
            diagnostics: Vec::new(),
            ordered_account_ids,
            next_cold_wallet_index,
            provisioning,
            cleanup,
            cleanup_queue,
        })
    }

    /// 将原槽中的异常记录附着到同一快照；禁止把合法记录复制成第二目录。
    pub fn try_with_diagnostics(&self, mut diagnostics: Vec<WalletRecord>) -> ContractResult<Self> {
        if diagnostics.len() > MAX_COLD_WALLET_ACCOUNTS + 1 { return Err(invalid_wallet_record()); }
        let cold_count = self.cold_accounts.len() + diagnostics.iter().filter(|record| matches!(record, WalletRecord::Account { .. })).count();
        if cold_count > MAX_COLD_WALLET_ACCOUNTS || diagnostics.len() > MAX_COLD_WALLET_ACCOUNTS + 1 {
            return Err(invalid_wallet_record());
        }
        let mut indices: BTreeSet<_> = self.profile.iter().map(WalletProfile::wallet_index)
            .chain(self.cold_accounts.iter().map(ColdWalletAccount::wallet_index)).collect();
        let mut accounts: BTreeSet<_> = self.profile.iter().flat_map(WalletProfile::accounts).map(WalletAccount::account_id)
            .chain(self.cold_accounts.iter().map(ColdWalletAccount::account_id)).collect();
        for record in &diagnostics {
            record.validate_shape()?;
            if record.diagnostic_reason().is_none() || !indices.insert(record.wallet_index()) ||
                (matches!(record, WalletRecord::Account { .. }) && record.wallet_index() >= self.next_cold_wallet_index) {
                return Err(invalid_wallet_record());
            }
            let record_accounts = record.account_ids();
            if record_accounts.iter().any(|account| accounts.contains(account)) { return Err(invalid_wallet_record()); }
            accounts.extend(record_accounts);
            if let Some(generation) = record.generation() {
                // 异常热槽也不能与在途写入/清理争夺同一生命周期；这种状态无法局部修复。
                if self.provisioning.is_some() || self.cleanup.iter().chain(self.cleanup_queue.iter())
                    .any(|plan| plan.generation() == generation) { return Err(invalid_wallet_record()); }
            }
        }
        diagnostics.sort_by_key(WalletRecord::wallet_index);
        let mut next = self.clone();
        next.diagnostics = diagnostics;
        if next.active_wallet_index.is_some_and(|index| !next.contains_wallet(index)) {
            return Err(ContractError::new(ContractErrorCode::NotFound, "付款钱包不存在"));
        }
        Ok(next)
    }
    pub fn diagnostics(&self) -> &[WalletRecord] { &self.diagnostics }
    pub fn diagnostic(&self, wallet_index: u32) -> Option<&WalletRecord> {
        self.diagnostics.iter().find(|record| record.wallet_index() == wallet_index)
    }
    pub fn diagnostic_for_account(&self, account_id: AccountId32) -> Option<&WalletRecord> {
        self.diagnostics.iter().find(|record| record.contains_account(account_id))
    }
    pub fn has_hot_wallet_record(&self) -> bool {
        self.profile.is_some() || self.diagnostics.iter().any(|record| matches!(record, WalletRecord::Profile { .. }))
    }

    /// 付款钱包选择与全局默认账户、热钱包内部当前账户完全独立。
    pub const fn active_wallet_index(&self) -> Option<u32> { self.active_wallet_index }

    /// 从完整目录恢复/改变已选钱包，只接受当前存在的索引，不修改修订或账户顺序。
    pub fn try_with_active_wallet(&self, wallet_index: Option<u32>) -> ContractResult<Self> {
        if wallet_index.is_some_and(|index| !self.contains_wallet(index)) {
            return Err(ContractError::new(ContractErrorCode::NotFound, "付款钱包不存在"));
        }
        let mut next = self.clone();
        next.active_wallet_index = wallet_index;
        Ok(next)
    }

    pub fn contains_wallet(&self, wallet_index: u32) -> bool {
        self.profile.as_ref().is_some_and(|profile| profile.wallet_index() == wallet_index)
            || self.cold_account_by_index(wallet_index).is_some()
            || self.diagnostic(wallet_index).is_some()
    }

    /// 原删除交互选择剩余最后一个钱包，不按账户排序或冷热优先级重新定义。
    pub fn last_wallet_index(&self) -> Option<u32> {
        self.profile.iter().map(WalletProfile::wallet_index)
            .chain(self.cold_accounts.iter().map(ColdWalletAccount::wallet_index))
            .chain(self.diagnostics.iter().map(WalletRecord::wallet_index)).max()
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn profile(&self) -> Option<&WalletProfile> {
        self.profile.as_ref()
    }

    pub fn cold_accounts(&self) -> &[ColdWalletAccount] {
        &self.cold_accounts
    }

    /// 热、冷账户共享的稳定顺序；第一项是全局默认账户。
    pub fn ordered_account_ids(&self) -> &[AccountId32] {
        &self.ordered_account_ids
    }

    pub const fn next_cold_wallet_index(&self) -> u32 {
        self.next_cold_wallet_index
    }

    pub fn default_account_id(&self) -> Option<AccountId32> {
        self.ordered_account_ids.first().copied()
    }

    pub fn cold_account_by_id(&self, account_id: AccountId32) -> Option<&ColdWalletAccount> {
        self.cold_accounts
            .iter()
            .find(|account| account.account_id() == account_id)
    }

    pub fn cold_account_by_index(&self, wallet_index: u32) -> Option<&ColdWalletAccount> {
        self.cold_accounts
            .iter()
            .find(|account| account.wallet_index() == wallet_index)
    }

    pub fn account_sign_mode(&self, account_id: AccountId32) -> Option<WalletSignMode> {
        if self
            .profile
            .as_ref()
            .is_some_and(|profile| profile.account_by_id(account_id).is_some())
        {
            Some(WalletSignMode::Hot)
        } else if self.cold_account_by_id(account_id).is_some() {
            Some(WalletSignMode::Cold)
        } else {
            None
        }
    }

    pub fn provisioning(&self) -> Option<&WalletProvisioningPlan> {
        self.provisioning.as_ref()
    }

    pub fn cleanup(&self) -> Option<&WalletCleanupPlan> {
        self.cleanup.as_ref()
    }

    pub fn cleanup_queue(&self) -> &[WalletCleanupPlan] {
        &self.cleanup_queue
    }
}

fn validate_account_catalog(
    profile: Option<&WalletProfile>,
    cold_accounts: &[ColdWalletAccount],
    ordered_account_ids: &[AccountId32],
    next_cold_wallet_index: u32,
) -> ContractResult<()> {
    if cold_accounts.len() > MAX_COLD_WALLET_ACCOUNTS
        || next_cold_wallet_index < FIRST_COLD_WALLET_INDEX
    {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "冷账户数量或下一个 wallet index 超出合同边界",
        ));
    }

    let cold_indices: BTreeSet<_> = cold_accounts
        .iter()
        .map(ColdWalletAccount::wallet_index)
        .collect();
    let cold_ids: BTreeSet<_> = cold_accounts
        .iter()
        .map(ColdWalletAccount::account_id)
        .collect();
    if cold_indices.len() != cold_accounts.len()
        || cold_ids.len() != cold_accounts.len()
        || cold_accounts.iter().any(|account| {
            account.wallet_index() < FIRST_COLD_WALLET_INDEX
                || account.wallet_index() >= next_cold_wallet_index
        })
    {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "冷账户 wallet index 与 AccountId 必须唯一，且已分配 index 必须小于单调计数器",
        ));
    }

    let mut all_ids: BTreeSet<AccountId32> = profile
        .into_iter()
        .flat_map(WalletProfile::accounts)
        .map(WalletAccount::account_id)
        .collect();
    let hot_count = all_ids.len();
    all_ids.extend(cold_ids);
    if all_ids.len() != hot_count + cold_accounts.len() {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "同一 AccountId 不得同时或重复存在于热钱包与冷账户",
        ));
    }

    let ordered_set: BTreeSet<_> = ordered_account_ids.iter().copied().collect();
    if ordered_set.len() != ordered_account_ids.len()
        || ordered_account_ids.len() != all_ids.len()
        || ordered_set != all_ids
    {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "orderedAccountIds 必须是全部热、冷账户 AccountId 的无重复精确排列",
        ));
    }
    Ok(())
}

/// 与已验证 Dart 钱包一致：追加账户只能在列表尾部扩展，既有 profile 字段与账户逐项不变。
fn profile_is_exact_subset(previous: &WalletProfile, target: &WalletProfile) -> bool {
    previous.wallet_index() == target.wallet_index()
        && previous.wallet_name() == target.wallet_name()
        && previous.generation() == target.generation()
        && previous.master_account_id() == target.master_account_id()
        && previous.origin() == target.origin()
        && previous.created_at_millis() == target.created_at_millis()
        && previous.active_account_id() == target.active_account_id()
        && previous.accounts().len() < target.accounts().len()
        && previous
            .accounts()
            .iter()
            .zip(target.accounts())
            .all(|(left, right)| left == right)
}

fn cleanup_can_coexist_with_profile(cleanup: &WalletCleanupPlan, profile: &WalletProfile) -> bool {
    if cleanup.delete_wallet_key() && cleanup.generation() == profile.generation() {
        return false;
    }
    cleanup.secret_refs().iter().all(|secret_ref| {
        !profile.accounts().iter().any(|account| {
            secret_ref.generation() == profile.generation()
                && secret_ref.owner() == account.secret_ref().owner()
                && secret_ref.account_id() == account.account_id()
        })
    })
}

fn cleanup_plans_overlap(left: &WalletCleanupPlan, right: &WalletCleanupPlan) -> bool {
    if left == right || left.operation_id() == right.operation_id() {
        return true;
    }
    if left.delete_wallet_key()
        && right.delete_wallet_key()
        && left.generation() == right.generation()
    {
        return true;
    }
    let left_refs: HashSet<_> = left.secret_refs().iter().copied().collect();
    right
        .secret_refs()
        .iter()
        .any(|secret_ref| left_refs.contains(secret_ref))
}
