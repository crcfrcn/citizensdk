//! 只接受系统金库密文信封、写入所有权与永久删除墓碑的专用仓储。

use crate::{
    ContractError, ContractErrorCode, ContractFuture, ContractResult, EncryptedSecretEnvelope,
    SecretRef, AccountId32,
};

/// 一个 SecretRef 的持久状态。
///
/// `Tombstone` 必须永久保留：它是跨 Engine/跨进程阻止 provisioning late writer 在
/// cleanup 完成后复活密文的唯一持久屏障。SecretRef 本身不可复用，因此墓碑不需要回收。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EncryptedSecretBlobState {
    Vacant,
    Sealed {
        provisioning_operation_id: [u8; 16],
        envelope: EncryptedSecretEnvelope,
    },
    Tombstone {
        cleanup_operation_id: [u8; 16],
    },
}

impl EncryptedSecretBlobState {
    pub fn envelope(&self) -> Option<&EncryptedSecretEnvelope> {
        match self {
            Self::Sealed { envelope, .. } => Some(envelope),
            Self::Vacant | Self::Tombstone { .. } => None,
        }
    }

    pub const fn is_tombstone(&self) -> bool {
        matches!(self, Self::Tombstone { .. })
    }
}

/// 单个精确 SecretRef 的 CAS 快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncryptedSecretBlobSnapshot {
    revision: u64,
    state: EncryptedSecretBlobState,
}

impl EncryptedSecretBlobSnapshot {
    pub const fn empty() -> Self {
        Self {
            revision: 0,
            state: EncryptedSecretBlobState::Vacant,
        }
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn state(&self) -> &EncryptedSecretBlobState {
        &self.state
    }

    pub fn envelope(&self) -> Option<&EncryptedSecretEnvelope> {
        self.state.envelope()
    }

    pub const fn is_tombstone(&self) -> bool {
        self.state.is_tombstone()
    }

    /// Strict persistence reconstruction without inventing transition history.
    ///
    /// A slot can only be vacant at revision 0, sealed at revision 1, and a
    /// tombstone at revision 1 (vacant cleanup) or revision 2 (sealed cleanup).
    /// This is intentionally narrower than a generic parts constructor and is
    /// used only after the host codec has validated its complete input.
    pub fn try_from_persisted_parts(
        revision: u64,
        state: EncryptedSecretBlobState,
    ) -> ContractResult<Self> {
        let valid = matches!(
            (revision, &state),
            (0, EncryptedSecretBlobState::Vacant)
                | (1, EncryptedSecretBlobState::Sealed { .. })
                | (1 | 2, EncryptedSecretBlobState::Tombstone { .. })
        );
        if !valid {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "设备密文持久 revision 与单向状态不一致",
            ));
        }
        Ok(Self { revision, state })
    }

    /// 生成唯一合法的下一 revision。墓碑是终态，任何 late writer 都不能复活该槽。
    pub fn try_advance(
        &self,
        next: EncryptedSecretBlobState,
    ) -> ContractResult<EncryptedSecretBlobSnapshot> {
        let allowed = matches!(
            (&self.state, &next),
            (
                EncryptedSecretBlobState::Vacant,
                EncryptedSecretBlobState::Sealed { .. }
                    | EncryptedSecretBlobState::Tombstone { .. }
            ) | (
                EncryptedSecretBlobState::Sealed { .. },
                EncryptedSecretBlobState::Tombstone { .. }
            )
        );
        if !allowed {
            return Err(ContractError::new(
                ContractErrorCode::Conflict,
                "设备密文状态不得覆盖 sealed 值或越过永久 tombstone",
            ));
        }
        let revision = self.revision.checked_add(1).ok_or_else(|| {
            ContractError::new(ContractErrorCode::InvalidState, "设备密文 revision 已耗尽")
        })?;
        Ok(Self {
            revision,
            state: next,
        })
    }
}

/// 已加密秘密的精确身份仓储；API 在类型上拒绝 `SecretBuffer` 和普通明文字节。
pub trait EncryptedSecretBlobStore: Send + Sync {
    /// 只读检查该账户在当前仓储全部钱包/代际/owner下是否仍有sealed秘密。
    /// Vacant/Tombstone不算秘密；失败、取消或不可证明完整范围必须报错，不能返回false。
    fn has_account_secret(&self, account_id: AccountId32) -> ContractFuture<'_, bool>;

    fn load(&self, secret_ref: SecretRef) -> ContractFuture<'_, EncryptedSecretBlobSnapshot>;

    /// 实现必须以 [`EncryptedSecretBlobSnapshot::try_advance`] 校验状态迁移；cleanup
    /// 必须写永久 `Tombstone`，不能物理删除成可再次写入的空槽。调用返回前必须回读
    /// 确认完整候选状态。
    fn compare_and_swap(
        &self,
        secret_ref: SecretRef,
        expected_revision: u64,
        next: EncryptedSecretBlobState,
    ) -> ContractFuture<'_, EncryptedSecretBlobSnapshot>;
}
