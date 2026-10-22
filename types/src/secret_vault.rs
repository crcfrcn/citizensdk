//! 系统金库和 Rust 受控秘密缓冲区合同。

use std::fmt;

use zeroize::Zeroizing;

use crate::{AccountId32, ContractError, ContractErrorCode, ContractFuture, ContractResult};

/// 只能保存在热钱包中的账户 child mini-secret；本合同不增加第二套母种子持久化入口。
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum SecretKind {
    AccountMiniSecret,
}

/// 每次钱包生命周期独占的 128 位硬件密钥 generation。
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct VaultGeneration([u8; 16]);

impl VaultGeneration {
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// 每个秘密槽不可复用的 128 位 owner。
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SecretOwner([u8; 16]);

impl SecretOwner {
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// 一份账户秘密的完整、不可复用身份，也作为系统金库 AAD 的结构化输入。
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SecretRef {
    wallet_index: u32,
    generation: VaultGeneration,
    owner: SecretOwner,
    account_id: AccountId32,
    kind: SecretKind,
}

impl SecretRef {
    pub const fn account_mini_secret(
        wallet_index: u32,
        generation: VaultGeneration,
        owner: SecretOwner,
        account_id: AccountId32,
    ) -> Self {
        Self {
            wallet_index,
            generation,
            owner,
            account_id,
            kind: SecretKind::AccountMiniSecret,
        }
    }

    pub const fn wallet_index(self) -> u32 {
        self.wallet_index
    }

    pub const fn generation(self) -> VaultGeneration {
        self.generation
    }

    pub const fn owner(self) -> SecretOwner {
        self.owner
    }

    pub const fn account_id(self) -> AccountId32 {
        self.account_id
    }

    pub const fn kind(self) -> SecretKind {
        self.kind
    }
}

/// 本类型拥有的一份 Rust 缓冲区会在析构时清零；它不承诺锁页、进程硬隔离或清除受信任闭包另行产生的副本。
///
/// ```compile_fail
/// use citizen_sdk_contracts::SecretBuffer;
/// let secret = SecretBuffer::try_new(vec![7; 32]).unwrap();
/// let copied = secret.clone();
/// # let _ = copied;
/// ```
pub struct SecretBuffer {
    bytes: Zeroizing<Vec<u8>>,
}

impl SecretBuffer {
    pub fn try_new(bytes: Vec<u8>) -> ContractResult<Self> {
        if bytes.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "秘密缓冲区不能为空",
            ));
        }
        Ok(Self {
            bytes: Zeroizing::new(bytes),
        })
    }

    /// 只直接借给同步 Rust 闭包；本 API 不直接归还切片或普通 `Vec`。
    ///
    /// 闭包实现仍属于受信任 Rust 边界，技术上可以复制输入，因此 provider 审查与后续
    /// C ABI 的不透明所有权同样是安全合同的一部分，不能把本方法描述成进程内硬隔离。
    pub fn with_secret<T>(&self, operation: impl FnOnce(&[u8]) -> T) -> T {
        operation(self.bytes.as_slice())
    }
}

impl fmt::Debug for SecretBuffer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBuffer([REDACTED])")
    }
}

/// 系统金库产生的密文信封；它不是秘密明文，可以交给专用密文仓储。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncryptedSecretEnvelope {
    format_version: u32,
    associated_data_digest: Hash32Bytes,
    ciphertext: Vec<u8>,
}

/// AAD 摘要使用独立类型，避免与区块哈希混用。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Hash32Bytes([u8; 32]);

impl Hash32Bytes {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl EncryptedSecretEnvelope {
    pub fn try_new(
        format_version: u32,
        associated_data_digest: Hash32Bytes,
        ciphertext: Vec<u8>,
    ) -> ContractResult<Self> {
        if format_version == 0 || ciphertext.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "密文信封格式版本和正文必须有效",
            ));
        }
        Ok(Self {
            format_version,
            associated_data_digest,
            ciphertext,
        })
    }

    pub const fn format_version(&self) -> u32 {
        self.format_version
    }

    pub const fn associated_data_digest(&self) -> Hash32Bytes {
        self.associated_data_digest
    }

    pub fn ciphertext(&self) -> &[u8] {
        &self.ciphertext
    }
}

/// 当前设备上的系统金库能力事实。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultAvailability {
    Available,
    NoStrongUserAuthentication,
    Unsupported,
    Unavailable,
}

/// 系统硬件/安全金库合同。它不能冒充 sr25519 签名器。
pub trait SecretVault: Send + Sync {
    fn availability(&self) -> ContractFuture<'_, VaultAvailability>;

    /// 对一次完整追加请求进行生物认证；不解封账户，不缓存成功，不修改金库密钥。
    /// Core固定本次钱包与目标集合，并在认证后重新核对状态；平台仅回报真实认证终态。
    fn authorize_add_accounts(
        &self,
        provisioning_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()>;

    /// 仅新建/导入钱包在取得 provisioning 后调用；同一 generation 只允许原创建操作初始化。
    /// 永久退休的 generation 不能复活；追加账户不得调用本方法。
    fn ensure_wallet_key(
        &self,
        provisioning_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()>;

    /// 使用既有活动密钥，以完整 SecretRef 作为 AAD 保护秘密；成功后输入缓冲区结束生命周期。
    /// Core 在封装前后核对本次 provisioning 对账户秘密的所有权；平台在持久锁内核对
    /// generation 与物理钥仍有效。缺钥或已退休必须失败，本方法不得初始化或重建密钥。
    fn seal(
        &self,
        provisioning_operation_id: [u8; 16],
        secret_ref: SecretRef,
        secret: SecretBuffer,
    ) -> ContractFuture<'_, EncryptedSecretEnvelope>;

    /// 解锁后的秘密只返回 Rust `SecretBuffer`，后续绑定层不得导出它。
    fn open(
        &self,
        secret_ref: SecretRef,
        envelope: EncryptedSecretEnvelope,
    ) -> ContractFuture<'_, SecretBuffer>;

    /// 检查同一钱包索引全部实际物理钥，不因代际退休就忽略尚未删除的钥。
    /// 只返回存在性，不解锁/导出钥；无法完整查询时必须报错，不能猜测不存在。
    fn has_any_wallet_key(&self, wallet_index: u32) -> ContractFuture<'_, bool>;

    fn has_wallet_key(
        &self,
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, bool>;

    /// 删除必须幂等，并持久写入 generation 退休墓碑；只有整钱包删除或已取得所有权的
    /// 补偿计划可以调用。墓碑必须先于返回成功落盘，使旧 `seal` 永远不能复活密钥。
    fn delete_wallet_key(
        &self,
        cleanup_operation_id: [u8; 16],
        wallet_index: u32,
        generation: VaultGeneration,
    ) -> ContractFuture<'_, ()>;
}
