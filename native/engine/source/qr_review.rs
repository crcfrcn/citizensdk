//! 已验证 finalized Runtime 上的完整 QR SCALE 审阅；没有测试快照或调用方 metadata 入口。

use std::{cell::Cell, collections::BTreeSet, marker::PhantomData};

use citizen_sdk_contracts::{
    ChainIdentity, ContractErrorCode, FinalizedBlockRef, Hash32, RuntimeContext,
    VerifiedChainClient,
};
use citizen_sdk_qr::SignRequest;
use sha2::{Digest, Sha256};
use subxt_core::{
    ext::{
        codec::{Compact, Decode, Encode},
        scale_decode::{
            visitor::{self, DecodeError, Unexpected, Visitor},
            TypeResolver,
        },
        scale_value::{self, Value},
    },
    utils::Era,
    Metadata,
};

use crate::{
    account_state::verified_identity, error::EngineError, system_events::decode_metadata_strict,
};

/// 审阅事实只由本模块构造；业务不能把自行拼接的摘要当成已经核验的交易。
#[derive(Clone, Debug)]
pub struct QrReview {
    request: SignRequest,
    metadata_digest: [u8; 32],
    pub(crate) pallet_name: String,
    pub(crate) call_name: String,
    pub(crate) call_arguments: String,
    pub(crate) genesis_hash: Hash32,
    pub(crate) spec_version: u32,
    pub(crate) transaction_version: u32,
    pub(crate) era: String,
    pub(crate) nonce: u64,
    pub(crate) tip: u128,
    pub(crate) block_hash: Hash32,
    mortal_birth: Option<u64>,
}

impl QrReview {
    pub fn request(&self) -> &SignRequest {
        &self.request
    }
    pub fn pallet_name(&self) -> &str {
        &self.pallet_name
    }
    pub fn call_name(&self) -> &str {
        &self.call_name
    }
    pub fn call_arguments(&self) -> &str {
        &self.call_arguments
    }
    pub const fn genesis_hash(&self) -> Hash32 {
        self.genesis_hash
    }
    pub const fn spec_version(&self) -> u32 {
        self.spec_version
    }
    pub const fn transaction_version(&self) -> u32 {
        self.transaction_version
    }
    pub fn era(&self) -> &str {
        &self.era
    }
    pub const fn nonce(&self) -> u64 {
        self.nonce
    }
    pub const fn tip(&self) -> u128 {
        self.tip
    }
    pub const fn block_hash(&self) -> Hash32 {
        self.block_hash
    }

    /// 新 finalized 头可以推进，但 Runtime 和用户确认的交易事实不得改变。
    pub(crate) fn matches(&self, other: &Self) -> bool {
        self.request == other.request
            && self.metadata_digest == other.metadata_digest
            && self.genesis_hash == other.genesis_hash
            && self.spec_version == other.spec_version
            && self.transaction_version == other.transaction_version
            && self.block_hash == other.block_hash
            && self.mortal_birth == other.mortal_birth
    }
}

pub(crate) async fn review_request(
    client: &dyn VerifiedChainClient,
    request: SignRequest,
) -> Result<QrReview, EngineError> {
    request.require_signer().map_err(|_| decode("链扫码审阅必须有明确签名账户"))?;
    let identity = verified_identity(client).await?;
    let finalized = client.get_finalized_head().await?;
    let context = client.get_finalized_runtime_context_at(finalized).await?;
    if context.block() != finalized.verified() {
        return Err(integrity("二维码审阅 Runtime 不属于准确 finalized 块"));
    }
    let review = decode_review(&identity, finalized, &context, request)?;
    if let Some(birth) = review.mortal_birth {
        let checkpoint = client.get_finalized_block_at(birth).await?;
        if checkpoint.number() != birth || checkpoint.hash() != review.block_hash {
            return Err(integrity("二维码有效期检查点不属于已验证 finalized 链"));
        }
    }
    Ok(review)
}

pub(crate) fn decode_review(
    identity: &ChainIdentity,
    finalized: FinalizedBlockRef,
    context: &RuntimeContext,
    request: SignRequest,
) -> Result<QrReview, EngineError> {
    request
        .encode()
        .map_err(|_| decode("二维码请求不符合固定协议"))?;
    // Generic QR transport treats action as opaque. This optional chain-review tool alone binds
    // it to the actual SCALE Runtime call index before presenting pallet/call metadata.
    if request.review_payload.len() < 2
        || u16::from_be_bytes([request.review_payload[0], request.review_payload[1]])
            != request.action
    {
        return Err(decode("链审阅 action 与实际 Runtime call 索引不一致"));
    }
    let metadata = decode_metadata_strict(context.metadata())?;
    if !metadata.extrinsic().supported_versions().contains(&4) {
        return Err(unsupported("Runtime 未提供已验证的 V4 签名载荷合同"));
    }
    let pallet = metadata
        .pallet_by_index((request.action >> 8) as u8)
        .ok_or_else(|| decode("动作 pallet 不存在"))?;
    let call = pallet
        .call_variant_by_index(request.action as u8)
        .ok_or_else(|| decode("动作 call 不存在"))?;
    let mut cursor = request.review_payload.as_slice();
    let budget = Cell::new(4096);
    let call_value = decode_value(
        &mut cursor,
        metadata.outer_enums().call_enum_ty(),
        &metadata,
        &budget,
    )?;
    let call_arguments = visible_review_text(&format!("{call_value}"));
    if call_arguments.len() > 48 * 1024 {
        return Err(decode("交易参数审阅文本超过安全上限"));
    }
    let mut extensions = Vec::new();
    let mut unique = BTreeSet::new();
    for extension in metadata
        .extrinsic()
        .transaction_extensions_to_use_for_encoding()
    {
        if !unique.insert(extension.identifier().to_owned()) {
            return Err(decode("重复的交易扩展"));
        }
        let before = cursor;
        decode_value(&mut cursor, extension.extra_ty(), &metadata, &budget)?;
        extensions.push((extension, &before[..before.len() - cursor.len()]));
    }
    let mut spec = None;
    let mut transaction = None;
    let mut genesis = None;
    let mut mortality = None;
    let mut nonce = None;
    let mut tip = None;
    for (extension, extra) in extensions {
        let before = cursor;
        decode_value(&mut cursor, extension.additional_ty(), &metadata, &budget)?;
        let additional = &before[..before.len() - cursor.len()];
        match extension.identifier() {
            "AuthorizeCall"
            | "CheckNonZeroSender"
            | "CheckNonStakeSender"
            | "CheckWeight"
            | "WeightReclaim" => {
                require_empty(extra)?;
                require_empty(additional)?;
            }
            "CheckSpecVersion" => {
                require_empty(extra)?;
                spec = Some(exact::<u32>(additional)?);
            }
            "CheckTxVersion" => {
                require_empty(extra)?;
                transaction = Some(exact::<u32>(additional)?);
            }
            "CheckGenesis" => {
                require_empty(extra)?;
                genesis = Some(exact::<[u8; 32]>(additional)?);
            }
            "CheckMortality" => {
                mortality = Some((exact::<Era>(extra)?, exact::<[u8; 32]>(additional)?));
            }
            "CheckNonce" => {
                require_empty(additional)?;
                nonce = Some(exact::<Compact<u64>>(extra)?.0);
            }
            "ChargeTransactionPayment" => {
                require_empty(additional)?;
                tip = Some(exact::<Compact<u128>>(extra)?.0);
            }
            "CheckMetadataHash" => {
                // SDK 现有交易构造使用 Disabled；不能伪造未知的 metadata-hash additional_signed。
                if extra != [0] || additional != [0] {
                    return Err(unsupported("二维码 metadata-hash 模式不受支持"));
                }
            }
            _ => return Err(unsupported("二维码包含尚未核验语义的交易扩展")),
        }
    }
    if !cursor.is_empty() {
        return Err(decode("完整签名载荷之后存在尾随字节"));
    }
    if spec != Some(context.version().spec_version())
        || transaction != Some(context.version().transaction_version())
    {
        return Err(integrity(
            "二维码 Runtime 版本不匹配已验证 finalized Runtime",
        ));
    }
    if genesis.as_ref() != Some(identity.genesis_hash().as_bytes()) {
        return Err(integrity("二维码 genesis_hash 不属于 CitizenChain"));
    }
    let (era, checkpoint) = mortality.ok_or_else(|| decode("签名载荷缺少有效期扩展"))?;
    let (era_text, mortal_birth) = match era {
        Era::Immortal => {
            if checkpoint != identity.genesis_hash().into_bytes() {
                return Err(integrity("Immortal 检查点不是 genesis_hash"));
            }
            ("immortal".to_owned(), None)
        }
        Era::Mortal { period, phase } => {
            if finalized.number() < phase {
                return Err(integrity("二维码 Mortal phase 位于未来"));
            }
            let birth = ((finalized.number() - phase) / period) * period + phase;
            (
                format!("mortal(period={period},phase={phase},birth={birth})"),
                Some(birth),
            )
        }
    };
    Ok(QrReview {
        request,
        metadata_digest: Sha256::digest(context.metadata()).into(),
        pallet_name: visible_review_text(pallet.name()),
        call_name: visible_review_text(&call.name),
        call_arguments,
        genesis_hash: identity.genesis_hash(),
        spec_version: context.version().spec_version(),
        transaction_version: context.version().transaction_version(),
        era: era_text,
        nonce: nonce.ok_or_else(|| decode("签名载荷缺少 nonce"))?,
        tip: tip.ok_or_else(|| decode("签名载荷缺少手续费小费"))?,
        block_hash: Hash32::from_bytes(checkpoint),
        mortal_birth,
    })
}

fn exact<T: Decode + Encode>(bytes: &[u8]) -> Result<T, EngineError> {
    let mut input = bytes;
    let value = T::decode(&mut input).map_err(|_| decode("交易扩展 SCALE 结构错误"))?;
    if !input.is_empty() || value.encode() != bytes {
        return Err(decode("交易扩展不是唯一规范 SCALE 编码"));
    }
    Ok(value)
}
fn require_empty(bytes: &[u8]) -> Result<(), EngineError> {
    if bytes.is_empty() {
        Ok(())
    } else {
        Err(decode("无数据交易扩展出现隐藏字段"))
    }
}
fn decode(message: &str) -> EngineError {
    EngineError::contract(ContractErrorCode::Decode, message)
}
fn integrity(message: &str) -> EngineError {
    EngineError::contract(ContractErrorCode::Integrity, message)
}
fn unsupported(message: &str) -> EngineError {
    EngineError::contract(ContractErrorCode::Unsupported, message)
}

/// 官方 SCALE Display 保留部分 Unicode 格式字符；统一显式呈现，防止 UI 双向重排
/// 或不可见字符伪装用户确认的交易。只改变展示文本，绝不改 payload 或待签字节。
pub(crate) fn visible_review_text(text: &str) -> String {
    use std::fmt::Write;
    let mut visible = String::with_capacity(text.len());
    for character in text.chars() {
        let point = u32::from(character);
        let invisible = character.is_control()
            || matches!(point,
            0x00ad | 0x034f | 0x061c | 0x115f..=0x1160 | 0x17b4..=0x17b5 |
            0x180b..=0x180f | 0x200b..=0x200f | 0x2028..=0x202e |
            0x2060..=0x206f | 0x3164 | 0xfe00..=0xfe0f | 0xfeff | 0xffa0 |
            0xfff9..=0xfffb | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a |
            0xe0000..=0xe0fff);
        if invisible {
            let _ = write!(visible, "\\u{{{point:04x}}}");
        } else {
            visible.push(character);
        }
    }
    visible
}

/// 先用官方 visitor 无分配遍历，限制深度/总节点/序列长度，再交同一 scale-value 解码。
/// 单码字节上限不能阻止 Vec<()> 的巨量声明，因此不能只在解码后检查长度。
struct Limits<'a, R> {
    budget: &'a Cell<usize>,
    depth: usize,
    resolver: PhantomData<R>,
}
impl<'a, R> Limits<'a, R> {
    fn child(&self) -> Result<Self, DecodeError> {
        if self.depth >= 32 || self.budget.get() == 0 {
            return Err(DecodeError::CodecError("二维码 SCALE 资源上限".into()));
        }
        self.budget.set(self.budget.get() - 1);
        Ok(Self {
            budget: self.budget,
            depth: self.depth + 1,
            resolver: PhantomData,
        })
    }
}
macro_rules! bounded_items {
    ($method:ident, $kind:ident) => {
        fn $method<'scale, 'info>(
            self,
            value: &mut visitor::types::$kind<'scale, 'info, R>,
            _: R::TypeId,
        ) -> Result<Self::Value<'scale, 'info>, Self::Error> {
            let count = value.remaining();
            if count > 4096 {
                return Err(DecodeError::CodecError("二维码 SCALE 序列上限".into()));
            }
            // Tuple::remaining 在现有官方版本返回总字段数，不能以它作为循环终止状态。
            for _ in 0..count {
                value
                    .decode_item(self.child()?)
                    .ok_or_else(|| DecodeError::CodecError("二维码 SCALE 容器边界无效".into()))??;
            }
            Ok(())
        }
    };
}
impl<R: TypeResolver> Visitor for Limits<'_, R> {
    type Value<'scale, 'info> = ();
    type Error = DecodeError;
    type TypeResolver = R;
    fn visit_unexpected<'scale, 'info>(
        self,
        _: Unexpected,
    ) -> Result<Self::Value<'scale, 'info>, Self::Error> {
        Ok(())
    }
    bounded_items!(visit_sequence, Sequence);
    bounded_items!(visit_array, Array);
    bounded_items!(visit_tuple, Tuple);
    bounded_items!(visit_composite, Composite);
    fn visit_variant<'scale, 'info>(
        self,
        value: &mut visitor::types::Variant<'scale, 'info, R>,
        id: R::TypeId,
    ) -> Result<Self::Value<'scale, 'info>, Self::Error> {
        self.visit_composite(value.fields(), id)
    }
    fn visit_str<'scale, 'info>(
        self,
        value: &mut visitor::types::Str<'scale>,
        _: R::TypeId,
    ) -> Result<Self::Value<'scale, 'info>, Self::Error> {
        value.as_str()?;
        Ok(())
    }
    fn visit_bitsequence<'scale, 'info>(
        self,
        value: &mut visitor::types::BitSequence<'scale>,
        _: R::TypeId,
    ) -> Result<Self::Value<'scale, 'info>, Self::Error> {
        let mut count = 0;
        for bit in value.decode()? {
            bit?;
            count += 1;
            if count > 4096 {
                return Err(DecodeError::CodecError("二维码位序列上限".into()));
            }
        }
        Ok(())
    }
}

fn decode_value(
    cursor: &mut &[u8],
    type_id: u32,
    metadata: &Metadata,
    budget: &Cell<usize>,
) -> Result<Value<u32>, EngineError> {
    let original = *cursor;
    if budget.get() == 0 {
        return Err(decode("二维码 SCALE 总节点上限"));
    }
    budget.set(budget.get() - 1);
    let mut preflight = original;
    visitor::decode_with_visitor(
        &mut preflight,
        type_id,
        metadata.types(),
        Limits {
            budget,
            depth: 0,
            resolver: PhantomData,
        },
    )
    .map_err(|_| decode("二维码 SCALE 结构或资源上限无效"))?;
    let value = scale_value::scale::decode_as_type(cursor, type_id, metadata.types())
        .map_err(|_| decode("二维码 SCALE 解码失败"))?;
    if *cursor != preflight {
        return Err(decode("二维码 SCALE 两次消费边界不一致"));
    }
    let mut canonical = Vec::new();
    scale_value::scale::encode_as_type(&value, type_id, metadata.types(), &mut canonical)
        .map_err(|_| decode("二维码 SCALE 重编码失败"))?;
    if canonical != original[..original.len() - cursor.len()] {
        return Err(decode("二维码 SCALE 编码非规范"));
    }
    Ok(value)
}
