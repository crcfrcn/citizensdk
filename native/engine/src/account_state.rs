//! CitizenChain 账户公开状态读取与链上费用策略。
//!
//! 本模块只消费 [`VerifiedChainClient`] 和强类型 [`AccountNonceSource`]：余额始终读取
//! finalized `System.Account`，交易 nonce 始终绑定同一次准确 best Runtime 调用，
//! 费率与存在性存款始终从同一准确 best 块的 metadata 解码。这里没有任意 RPC 逃生口，
//! 也不接触钱包秘密；同账户未决交易的 single-flight 门由历史服务在广播前执行。

use std::collections::BTreeMap;

use citizen_sdk_contracts::{
    AccountId32, AccountNonce, AccountNonceSource, BlockFinality, ChainIdentity, ContractErrorCode,
    FinalizedAccountBalance, FinalizedBlockRef, OnchainFeePolicy, RuntimeContext, VerifiedBlockRef,
    VerifiedChainClient,
};
use subxt_core::{
    constants,
    dynamic::Value,
    ext::scale_value::{Composite, ValueDef},
    storage, Metadata,
};

use crate::{error::EngineError, system_events::decode_metadata_strict};

/// 一份绑定准确 best 块的链上费用事实。
///
/// `policy` 保存 Runtime 的 `OnchainFeeRate` 与 `OnchainMinFee`；
/// `existential_deposit_fen` 保存同一 metadata 的 `Balances.ExistentialDeposit`。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BestFeeSnapshot {
    policy: OnchainFeePolicy,
    existential_deposit_fen: u128,
}

impl BestFeeSnapshot {
    pub const fn policy(self) -> OnchainFeePolicy {
        self.policy
    }

    pub const fn block(self) -> VerifiedBlockRef {
        self.policy.block()
    }

    pub const fn existential_deposit_fen(self) -> u128 {
        self.existential_deposit_fen
    }

    pub fn estimate_fee_fen(self, amount_fen: u128) -> Result<u128, EngineError> {
        self.policy.estimate(amount_fen).map_err(EngineError::from)
    }

    pub fn minimum_self_pay_fen(self) -> Result<u128, EngineError> {
        self.policy
            .minimum_self_pay(self.existential_deposit_fen)
            .map_err(EngineError::from)
    }
}

/// Engine 内部的账户公开状态服务。
///
/// provider 均由宿主组合注入；本服务不会保存 RPC method 名称，也不会把 best 当成
/// finalized。`nonce_source` 可以缺席，使只读宿主仍可读取余额和费用，但 nonce 请求会以
/// `Unsupported` 明确失败。
pub struct AccountStateService<'a> {
    chain_client: &'a dyn VerifiedChainClient,
    nonce_source: Option<&'a dyn AccountNonceSource>,
}

impl<'a> AccountStateService<'a> {
    pub const fn new(
        chain_client: &'a dyn VerifiedChainClient,
        nonce_source: Option<&'a dyn AccountNonceSource>,
    ) -> Self {
        Self {
            chain_client,
            nonce_source,
        }
    }

    /// 读取一个账户在准确 finalized 块上的 free、reserved 与 total。
    pub async fn finalized_account_balance(
        &self,
        account_id: AccountId32,
    ) -> Result<FinalizedAccountBalance, EngineError> {
        let identity = verified_identity(self.chain_client).await?;
        let block = self
            .chain_client
            .get_finalized_head()
            .await
            .map_err(EngineError::from)?;
        let context = verified_runtime_context(self.chain_client, block.into()).await?;
        let metadata = decode_metadata_strict(context.metadata())?;
        let key = system_account_storage_key(&metadata, account_id)?;
        let raw = self
            .chain_client
            .get_finalized_storage_at(block, key)
            .await
            .map_err(EngineError::from)?;
        decode_finalized_account_balance(&identity, block, account_id, raw.as_deref())
    }

    /// 一次 batch 读取多个 finalized `System.Account`，返回顺序和重复项与输入完全一致。
    ///
    /// 相同 AccountId 只生成一个 storage key 并只向 provider 请求一次；空输入不会触发
    /// 任何链访问。单次最多接受 1990 项，限制在去重前执行，避免大量重复项绕过
    /// 输入/输出内存上限；直接使用 Rust 服务也执行与跨端绑定相同的边界。
    pub async fn finalized_account_balances(
        &self,
        account_ids: Vec<AccountId32>,
    ) -> Result<Vec<FinalizedAccountBalance>, EngineError> {
        if account_ids.len() > 1990 {
            return Err(EngineError::contract(
                ContractErrorCode::InvalidArgument,
                "finalized account balance batch 最多接受 1990 项",
            ));
        }
        if account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let identity = verified_identity(self.chain_client).await?;
        let block = self
            .chain_client
            .get_finalized_head()
            .await
            .map_err(EngineError::from)?;
        let context = verified_runtime_context(self.chain_client, block.into()).await?;
        let metadata = decode_metadata_strict(context.metadata())?;

        let mut unique_accounts = Vec::new();
        let mut unique_indices = BTreeMap::new();
        for account_id in &account_ids {
            if !unique_indices.contains_key(account_id) {
                unique_indices.insert(*account_id, unique_accounts.len());
                unique_accounts.push(*account_id);
            }
        }
        let keys = unique_accounts
            .iter()
            .copied()
            .map(|account_id| system_account_storage_key(&metadata, account_id))
            .collect::<Result<Vec<_>, _>>()?;
        let values = self
            .chain_client
            .get_finalized_storage_batch_at(block, keys)
            .await
            .map_err(EngineError::from)?;
        if values.len() != unique_accounts.len() {
            return Err(EngineError::contract(
                ContractErrorCode::Integrity,
                "finalized System.Account batch 返回数量与请求不一致",
            ));
        }

        let mut unique_balances = Vec::with_capacity(unique_accounts.len());
        for (account_id, raw) in unique_accounts.into_iter().zip(values) {
            unique_balances.push(decode_finalized_account_balance(
                &identity,
                block,
                account_id,
                raw.as_deref(),
            )?);
        }
        account_ids
            .into_iter()
            .map(|account_id| {
                let index = unique_indices.get(&account_id).copied().ok_or_else(|| {
                    EngineError::contract(ContractErrorCode::Internal, "账户 batch 去重索引丢失")
                })?;
                unique_balances.get(index).copied().ok_or_else(|| {
                    EngineError::contract(ContractErrorCode::Internal, "账户 batch 结果索引越界")
                })
            })
            .collect()
    }

    /// 取得同一次 Runtime 调用产生、并绑定准确 best 块的账户 nonce。
    pub async fn account_next_index(
        &self,
        account_id: AccountId32,
    ) -> Result<AccountNonce, EngineError> {
        let _identity = verified_identity(self.chain_client).await?;
        let best = self
            .chain_client
            .get_best_head()
            .await
            .map_err(EngineError::from)?;
        let source = self.nonce_source.ok_or_else(|| {
            EngineError::contract(
                ContractErrorCode::Unsupported,
                "宿主未注入准确 best Runtime AccountNonceSource",
            )
        })?;
        let nonce = source
            .account_next_index(account_id, best)
            .await
            .map_err(EngineError::from)?;
        if nonce.account_id() != account_id || nonce.best_block() != best {
            return Err(EngineError::contract(
                ContractErrorCode::Integrity,
                "AccountNonceSource 返回了不同账户或不同 best 块的 nonce",
            ));
        }
        Ok(nonce)
    }

    /// 从同一准确 best 块 metadata 解码费率、最低费与存在性存款。
    pub async fn best_fee_snapshot(&self) -> Result<BestFeeSnapshot, EngineError> {
        let identity = verified_identity(self.chain_client).await?;
        let best = self
            .chain_client
            .get_best_head()
            .await
            .map_err(EngineError::from)?;
        let context = verified_runtime_context(self.chain_client, best).await?;
        decode_best_fee_snapshot(&identity, &context)
    }
}

/// 获取并核对 SDK 唯一正式 CitizenChain 身份。
pub(crate) async fn verified_identity(
    chain_client: &dyn VerifiedChainClient,
) -> Result<ChainIdentity, EngineError> {
    let identity = chain_client.identity().await.map_err(EngineError::from)?;
    if identity != ChainIdentity::citizenchain() {
        return Err(EngineError::contract(
            ContractErrorCode::Integrity,
            "provider 链身份与 CitizenSDK 随包 citizenchain 身份不一致",
        ));
    }
    Ok(identity)
}

/// 获取并核对一个准确块的 runtime version + metadata 原子上下文。
pub(crate) async fn verified_runtime_context(
    chain_client: &dyn VerifiedChainClient,
    block: VerifiedBlockRef,
) -> Result<RuntimeContext, EngineError> {
    let context = chain_client
        .get_runtime_context_at(block)
        .await
        .map_err(EngineError::from)?;
    if context.block() != block {
        return Err(EngineError::BlockContextMismatch(
            "runtime context 与请求的准确块不一致".to_owned(),
        ));
    }
    Ok(context)
}

/// 按准确 metadata 生成 `System.Account` 的 `Blake2_128Concat(AccountId32)` storage key。
///
/// pallet/entry 前缀、map hasher 和 key 类型全部由 metadata 验证，避免在 Runtime 改变时
/// 继续静默使用一份本地猜测。
pub fn system_account_storage_key(
    metadata: &Metadata,
    account_id: AccountId32,
) -> Result<Vec<u8>, EngineError> {
    let address = storage::address::dynamic(
        "System",
        "Account",
        vec![Value::from_bytes(account_id.as_bytes())],
    );
    storage::get_address_bytes(&address, metadata)
        .map_err(|error| EngineError::InvalidMetadata(error.to_string()))
}

/// 解码现有 Runtime `AccountInfo` 布局：16B 计数头、free u128、reserved u128。
///
/// 与已验证 Dart 行为保持一致：账户不存在或字节短于 reserved 末尾时统一是零余额；
/// 长数据只读取当前稳定字段，不凭尾部字节猜测新含义。
pub fn decode_finalized_account_balance(
    identity: &ChainIdentity,
    block: FinalizedBlockRef,
    account_id: AccountId32,
    raw: Option<&[u8]>,
) -> Result<FinalizedAccountBalance, EngineError> {
    let (free_fen, reserved_fen) = match raw {
        Some(bytes) if bytes.len() >= 48 => (read_u128_le(bytes, 16), read_u128_le(bytes, 32)),
        Some(_) | None => (0, 0),
    };
    FinalizedAccountBalance::try_new(identity, block, account_id, free_fen, reserved_fen)
        .map_err(EngineError::from)
}

/// 解码准确 best Runtime 中的三项资金常量，不使用本地默认值。
pub fn decode_best_fee_snapshot(
    identity: &ChainIdentity,
    context: &RuntimeContext,
) -> Result<BestFeeSnapshot, EngineError> {
    if context.block().finality() != BlockFinality::Best {
        return Err(EngineError::contract(
            ContractErrorCode::InvalidArgument,
            "链上交易费策略必须绑定准确 best 块",
        ));
    }
    let metadata = decode_metadata_strict(context.metadata())?;
    let fee_rate = decode_integer_constant(&metadata, "OnchainTransaction", "OnchainFeeRate")?;
    let fee_rate = u32::try_from(fee_rate).map_err(|_| {
        EngineError::contract(
            ContractErrorCode::Decode,
            "OnchainTransaction.OnchainFeeRate 超出 u32",
        )
    })?;
    let minimum_fee_fen =
        decode_integer_constant(&metadata, "OnchainTransaction", "OnchainMinFee")?;
    let existential_deposit_fen =
        decode_integer_constant(&metadata, "Balances", "ExistentialDeposit")?;
    let policy = OnchainFeePolicy::try_new(identity, context.block(), fee_rate, minimum_fee_fen)
        .map_err(EngineError::from)?;
    Ok(BestFeeSnapshot {
        policy,
        existential_deposit_fen,
    })
}

fn decode_integer_constant(
    metadata: &Metadata,
    pallet: &str,
    name: &str,
) -> Result<u128, EngineError> {
    let address = constants::address::dynamic(pallet, name);
    let thunk = constants::get(&address, metadata)
        .map_err(|error| EngineError::InvalidMetadata(error.to_string()))?;
    let value = thunk
        .to_value()
        .map_err(|error| EngineError::InvalidMetadata(error.to_string()))?;
    transparent_u128(&value).ok_or_else(|| {
        EngineError::contract(
            ContractErrorCode::Decode,
            format!("链上常量 {pallet}.{name} 不是无符号整数"),
        )
    })
}

/// `Perbill` 等 Runtime newtype 在 metadata 中是单字段透明 composite；只逐层剥离
/// 单字段包装，绝不从多字段结构中猜一个整数。
fn transparent_u128(value: &subxt_core::ext::scale_value::Value<u32>) -> Option<u128> {
    if let Some(value) = value.as_u128() {
        return Some(value);
    }
    match &value.value {
        ValueDef::Composite(Composite::Named(fields)) if fields.len() == 1 => {
            transparent_u128(&fields[0].1)
        }
        ValueDef::Composite(Composite::Unnamed(fields)) if fields.len() == 1 => {
            transparent_u128(&fields[0])
        }
        ValueDef::BitSequence(_)
        | ValueDef::Composite(_)
        | ValueDef::Primitive(_)
        | ValueDef::Variant(_) => None,
    }
}

fn read_u128_le(bytes: &[u8], offset: usize) -> u128 {
    let mut raw = [0_u8; 16];
    raw.copy_from_slice(&bytes[offset..offset + 16]);
    u128::from_le_bytes(raw)
}
