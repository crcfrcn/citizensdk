//! CitizenChain 账户公开链状态值对象。
//!
//! 本模块只描述可公开的 AccountId、余额、nonce 与链上费率。每个链状态对象都绑定
//! CitizenSDK 唯一正式链身份及准确块锚；它不保存助记词、mini-secret、私钥或金库引用。

use crate::{
    AccountId32, BlockFinality, ChainIdentity, ContractError, ContractErrorCode, ContractFuture,
    ContractResult, FinalizedBlockRef, VerifiedBlockRef, CITIZENCHAIN_CHAIN_ID,
    CITIZENCHAIN_GENESIS_HASH, CITIZENCHAIN_PROTOCOL_ID,
};

/// Substrate `Perbill` 的固定分母。
pub const PERBILL_DENOMINATOR: u128 = 1_000_000_000;

/// 在一个准确 finalized 块解码出的账户余额，单位均为 CitizenChain 整数分。
///
/// `free + reserved` 必须仍能由 u128 精确表示；合同层不会静默回绕或饱和一份链上事实。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FinalizedAccountBalance {
    block: FinalizedBlockRef,
    account_id: AccountId32,
    free_fen: u128,
    reserved_fen: u128,
    total_fen: u128,
}

impl FinalizedAccountBalance {
    pub fn try_new(
        identity: &ChainIdentity,
        block: FinalizedBlockRef,
        account_id: AccountId32,
        free_fen: u128,
        reserved_fen: u128,
    ) -> ContractResult<Self> {
        require_citizenchain_identity(identity)?;
        let total_fen = free_fen.checked_add(reserved_fen).ok_or_else(|| {
            ContractError::new(
                ContractErrorCode::Integrity,
                "账户 free 与 reserved 相加超出 u128，拒绝构造余额事实",
            )
        })?;
        Ok(Self {
            block,
            account_id,
            free_fen,
            reserved_fen,
            total_fen,
        })
    }

    pub const fn block(self) -> FinalizedBlockRef {
        self.block
    }

    pub const fn account_id(self) -> AccountId32 {
        self.account_id
    }

    pub const fn free_fen(self) -> u128 {
        self.free_fen
    }

    pub const fn reserved_fen(self) -> u128 {
        self.reserved_fen
    }

    pub const fn total_fen(self) -> u128 {
        self.total_fen
    }
}

/// 在一个准确 best 块取得的账户 Runtime nonce。
///
/// 交易构造必须把本对象与同一 best 块的 [`crate::RuntimeContext`] 配对，不能把不同时刻
/// 的 nonce、metadata 和 runtime version 拼成一笔交易。本对象只表达链上 Runtime
/// 已确认值，不冒充宿主或本机交易池的并发预留；钱包交易入口还必须在持久历史 CAS 中
/// 执行同账户 single-flight 门禁，确保最多一笔未决提交能够广播。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AccountNonce {
    best_block: VerifiedBlockRef,
    account_id: AccountId32,
    value: u64,
}

impl AccountNonce {
    pub fn try_new(
        identity: &ChainIdentity,
        best_block: VerifiedBlockRef,
        account_id: AccountId32,
        value: u64,
    ) -> ContractResult<Self> {
        require_citizenchain_identity(identity)?;
        if best_block.finality() != BlockFinality::Best {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "交易 nonce 必须绑定准确 best 块",
            ));
        }
        Ok(Self {
            best_block,
            account_id,
            value,
        })
    }

    pub const fn best_block(self) -> VerifiedBlockRef {
        self.best_block
    }

    pub const fn account_id(self) -> AccountId32 {
        self.account_id
    }

    pub const fn value(self) -> u64 {
        self.value
    }
}

/// CitizenChain 准确 best Runtime nonce 来源。
///
/// 生产实现必须在一次已固定的 Runtime 调用内取得 nonce 和准确块身份，不能用调用前后的
/// head 采样拼接，也不能从另一 finalized `System.Account` 读取冒充 best。smoldot 的
/// `AccountNonceApi_account_nonce` 不包含本机交易池预留，因此本合同不宣称 pool-aware；
/// 钱包 Engine 必须另以持久 pending single-flight 门阻止同账户并发复用 nonce。实现必须
/// 返回与 `at_best` 同一准确 best 块、同一账户绑定的 [`AccountNonce`]；本接口不提供任意
/// RPC 方法。
pub trait AccountNonceSource: Send + Sync {
    fn account_next_index(
        &self,
        account_id: AccountId32,
        at_best: VerifiedBlockRef,
    ) -> ContractFuture<'_, AccountNonce>;
}

/// 从同一准确 runtime metadata 解码出的链上资金交易费率。
///
/// `fee_rate_parts` 对应 `OnchainTransaction.OnchainFeeRate`，`minimum_fee_fen` 对应
/// `OnchainTransaction.OnchainMinFee`。本对象不允许本地默认值或无效的零费率。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OnchainFeePolicy {
    block: VerifiedBlockRef,
    fee_rate_parts: u32,
    minimum_fee_fen: u128,
}

impl OnchainFeePolicy {
    pub fn try_new(
        identity: &ChainIdentity,
        block: VerifiedBlockRef,
        fee_rate_parts: u32,
        minimum_fee_fen: u128,
    ) -> ContractResult<Self> {
        require_citizenchain_identity(identity)?;
        if block.finality() != BlockFinality::Best {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "链上交易费策略必须绑定准确 best 块",
            ));
        }
        if fee_rate_parts == 0 || u128::from(fee_rate_parts) > PERBILL_DENOMINATOR {
            return Err(ContractError::new(
                ContractErrorCode::Decode,
                "OnchainFeeRate 必须是有效的正 Perbill",
            ));
        }
        if minimum_fee_fen == 0 {
            return Err(ContractError::new(
                ContractErrorCode::Decode,
                "OnchainMinFee 必须大于 0 分",
            ));
        }
        Ok(Self {
            block,
            fee_rate_parts,
            minimum_fee_fen,
        })
    }

    pub const fn block(self) -> VerifiedBlockRef {
        self.block
    }

    pub const fn fee_rate_parts(self) -> u32 {
        self.fee_rate_parts
    }

    pub const fn minimum_fee_fen(self) -> u128 {
        self.minimum_fee_fen
    }

    /// 与现有 Dart/Runtime `mul_perbill_round` 一致地估算费用。
    ///
    /// 中间 u128 运算使用饱和语义，余量加半个 Perbill 分母后执行 half-up 整数舍入；
    /// 最终结果不得低于链上最小费用。
    pub fn estimate(&self, amount_fen: u128) -> ContractResult<u128> {
        let parts = u128::from(self.fee_rate_parts);
        let whole = amount_fen / PERBILL_DENOMINATOR;
        let remainder = amount_fen % PERBILL_DENOMINATOR;
        let whole_component = whole.saturating_mul(parts);
        let rounded_remainder = remainder
            .saturating_mul(parts)
            .saturating_add(PERBILL_DENOMINATOR / 2)
            / PERBILL_DENOMINATOR;
        let by_rate = whole_component.saturating_add(rounded_remainder);
        Ok(by_rate.max(self.minimum_fee_fen))
    }

    /// 计算现有钱包“最低链上费用 + 存在性存款”的最低自付余额。
    ///
    /// 与费率估算不同，这是一份必须精确展示给用户的余额门槛，溢出时明确失败，不能饱和。
    pub fn minimum_self_pay(&self, existential_deposit_fen: u128) -> ContractResult<u128> {
        self.minimum_fee_fen
            .checked_add(existential_deposit_fen)
            .ok_or_else(|| {
                ContractError::new(
                    ContractErrorCode::Integrity,
                    "OnchainMinFee 与 ExistentialDeposit 相加超出 u128",
                )
            })
    }
}

/// 只接受 CitizenSDK 随包清单冻结的唯一正式网络身份。
pub(crate) fn require_citizenchain_identity(identity: &ChainIdentity) -> ContractResult<()> {
    if identity.chain_id() != CITIZENCHAIN_CHAIN_ID
        || identity.protocol_id() != CITIZENCHAIN_PROTOCOL_ID
        || identity.genesis_hash() != CITIZENCHAIN_GENESIS_HASH
    {
        return Err(ContractError::new(
            ContractErrorCode::Integrity,
            "链身份不是 CitizenSDK 冻结的正式 citizenchain 网络",
        ));
    }
    Ok(())
}
