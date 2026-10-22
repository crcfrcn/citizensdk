//! 热钱包公开资料、仅公钥冷账户和全局账户顺序的无秘密原子仓储。

use crate::{ContractFuture, WalletState};

/// 只保存 `WalletState`。冷账户没有秘密引用；助记词、母种子、mini-secret、私钥和签名
/// 均不属于该类型。宿主必须把完整状态作为一个 CAS 单元，不能把账户顺序另存为影子真源。
pub trait WalletProfileStore: Send + Sync {
    fn load(&self) -> ContractFuture<'_, WalletState>;

    /// `next.revision` 必须等于 `expected_revision + 1`，并以底层原子 CAS 提交。
    /// 写后异常必须完整回读：等于候选状态才收敛为成功，否则报告冲突/存储错误。
    fn compare_and_swap(
        &self,
        expected_revision: u64,
        next: WalletState,
    ) -> ContractFuture<'_, WalletState>;
}
