//! smoldot 已验证公开链数据库的专用仓储。

use crate::{ContractFuture, ExportedChainState};

/// 带 CAS revision 的轻节点数据库快照。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainDatabaseSnapshot {
    revision: u64,
    state: Option<ExportedChainState>,
}

impl ChainDatabaseSnapshot {
    pub const fn new(revision: u64, state: Option<ExportedChainState>) -> Self {
        Self { revision, state }
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn state(&self) -> Option<&ExportedChainState> {
        self.state.as_ref()
    }
}

/// 只保存公开轻节点数据库。钱包资料、历史、密文和明文秘密均不得进入本合同。
pub trait ChainDatabaseStore: Send + Sync {
    fn load(&self) -> ContractFuture<'_, ChainDatabaseSnapshot>;

    /// 以 revision 原子提交；实现必须处理“写已落盘后抛错”的回读收敛。
    fn compare_and_swap(
        &self,
        expected_revision: u64,
        state: Option<ExportedChainState>,
    ) -> ContractFuture<'_, ChainDatabaseSnapshot>;
}
