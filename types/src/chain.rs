//! 带验证语义的 CitizenChain 客户端合同。

use std::fmt;

use crate::{
    ContractError, ContractErrorCode, ContractFuture, ContractResult, ContractStream,
    ExtrinsicWatchEvent, SignedExtrinsic, SubmittedExtrinsic,
};

/// CitizenSDK 唯一正式链身份；不得由绑定层另造网络别名。
pub const CITIZENCHAIN_CHAIN_ID: &str = "citizenchain";
pub const CITIZENCHAIN_PROTOCOL_ID: &str = "citizenchain";
/// 单次 finalized ancestry/history 请求允许的最大连续块数；Engine 与 provider 共用本常量。
pub const MAX_FINALIZED_BLOCKS_PER_BATCH: u64 = 120;
/// Public exact-block reads are bounded before provider allocation or host projection.
pub const MAX_STORAGE_KEY_BYTES: usize = 4 * 1024;
pub const MAX_STORAGE_BATCH_KEYS: usize = 1024;
pub const MAX_STORAGE_BATCH_KEY_BYTES: usize = 1024 * 1024;
pub const MAX_STORAGE_KEYS_PAGE_LIMIT: u32 = 1000;
pub const MAX_STORAGE_KEYS_PAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RUNTIME_API_METHOD_BYTES: usize = 128;
pub const MAX_RUNTIME_API_ARGUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_RUNTIME_API_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_HEADER_DIGEST_BYTES: usize = 1024 * 1024;
pub const MAX_RUNTIME_METADATA_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_BLOCK_BODY_EXTRINSICS: usize = 16 * 1024;
pub const MAX_BLOCK_BODY_BYTES: usize = 64 * 1024 * 1024;
pub const CITIZENCHAIN_GENESIS_HASH: Hash32 = Hash32::from_bytes([
    0x18, 0x84, 0x7a, 0x5d, 0xfd, 0x26, 0x32, 0x72, 0xf2, 0xe7, 0x72, 0x78, 0x36, 0xfe, 0x65, 0x82,
    0xf8, 0xc4, 0x46, 0x3f, 0xf4, 0x86, 0x09, 0xdf, 0x7b, 0x96, 0xd5, 0xe4, 0xd9, 0xdd, 0x24, 0xdd,
]);

/// 验证 finalized 闭区间并返回安全的本机元素数量。
///
/// 本函数必须在网络访问和结果集合分配前调用；121 块、反向区间及长度算术溢出均失败。
pub fn validated_finalized_block_range_len(
    start_number: u64,
    end_number: u64,
) -> ContractResult<usize> {
    if start_number > end_number {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "finalized 块闭区间起点不能高于终点",
        ));
    }
    let length = end_number
        .checked_sub(start_number)
        .and_then(|distance| distance.checked_add(1))
        .ok_or_else(|| {
            ContractError::new(
                ContractErrorCode::InvalidArgument,
                "finalized 块闭区间长度溢出",
            )
        })?;
    if length > MAX_FINALIZED_BLOCKS_PER_BATCH {
        return Err(ContractError::new(
            ContractErrorCode::InvalidArgument,
            "finalized 块闭区间不能超过 120 块",
        ));
    }
    usize::try_from(length).map_err(|_| {
        ContractError::new(
            ContractErrorCode::InvalidArgument,
            "finalized 块闭区间超过平台容量",
        )
    })
}

/// 32 字节链哈希。区块哈希、genesis hash 和 extrinsic hash 共享字节宽度，调用处仍须
/// 通过字段名保持业务语义，不允许从可变长度文本猜测。
#[derive(Clone, Copy, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Hash32([u8; 32]);

impl Hash32 {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub const fn into_bytes(self) -> [u8; 32] {
        self.0
    }
}

impl fmt::Debug for Hash32 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("Hash32").field(&self.0).finish()
    }
}

/// CitizenChain AccountId32；与字符串形式的 SS58 展示地址分离。
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AccountId32([u8; 32]);

impl AccountId32 {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub const fn into_bytes(self) -> [u8; 32] {
        self.0
    }
}

/// provider 已核对出的块语义；不能把 best 口头当成 finalized。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockFinality {
    Best,
    Finalized,
}

/// 带哈希、高度和验证语义的准确块引用。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerifiedBlockRef {
    hash: Hash32,
    number: u64,
    finality: BlockFinality,
}

impl VerifiedBlockRef {
    pub const fn best(hash: Hash32, number: u64) -> Self {
        Self {
            hash,
            number,
            finality: BlockFinality::Best,
        }
    }

    pub const fn finalized(hash: Hash32, number: u64) -> Self {
        Self {
            hash,
            number,
            finality: BlockFinality::Finalized,
        }
    }

    pub const fn hash(&self) -> Hash32 {
        self.hash
    }

    pub const fn number(&self) -> u64 {
        self.number
    }

    pub const fn finality(&self) -> BlockFinality {
        self.finality
    }

    pub const fn is_finalized(&self) -> bool {
        matches!(self.finality, BlockFinality::Finalized)
    }

    pub fn require_finalized(self) -> ContractResult<FinalizedBlockRef> {
        FinalizedBlockRef::try_from(self)
    }
}

/// 编译期强制 finalized-only 调用不能接收 best 块。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FinalizedBlockRef(VerifiedBlockRef);

impl FinalizedBlockRef {
    pub const fn from_parts(hash: Hash32, number: u64) -> Self {
        Self(VerifiedBlockRef::finalized(hash, number))
    }

    pub const fn verified(self) -> VerifiedBlockRef {
        self.0
    }

    pub const fn hash(self) -> Hash32 {
        self.0.hash()
    }

    pub const fn number(self) -> u64 {
        self.0.number()
    }
}

impl TryFrom<VerifiedBlockRef> for FinalizedBlockRef {
    type Error = ContractError;

    fn try_from(value: VerifiedBlockRef) -> Result<Self, Self::Error> {
        if value.is_finalized() {
            Ok(Self(value))
        } else {
            Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "finalized-only 操作拒绝 best 块引用",
            ))
        }
    }
}

impl From<FinalizedBlockRef> for VerifiedBlockRef {
    fn from(value: FinalizedBlockRef) -> Self {
        value.verified()
    }
}

/// One typed snapshot from the same running light-client instance.
///
/// Peer and progress facts never manufacture finality: both block references were already
/// verified by the provider, and callers must use `is_usable` rather than infer readiness from
/// peer count or height movement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChainSyncStatus {
    peer_count: u64,
    is_syncing: bool,
    is_usable: bool,
    best: VerifiedBlockRef,
    finalized: FinalizedBlockRef,
}

impl ChainSyncStatus {
    pub fn try_new(
        peer_count: u64,
        is_syncing: bool,
        is_usable: bool,
        best: VerifiedBlockRef,
        finalized: FinalizedBlockRef,
    ) -> ContractResult<Self> {
        if best.finality() != BlockFinality::Best {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "同步状态的 best 块必须具有 best finality",
            ));
        }
        if finalized.number() > best.number() {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "同步状态的 finalized 高度不能超过 best 高度",
            ));
        }
        Ok(Self {
            peer_count,
            is_syncing,
            is_usable,
            best,
            finalized,
        })
    }

    pub const fn peer_count(self) -> u64 {
        self.peer_count
    }

    pub const fn is_syncing(self) -> bool {
        self.is_syncing
    }

    pub const fn is_usable(self) -> bool {
        self.is_usable
    }

    pub const fn best(self) -> VerifiedBlockRef {
        self.best
    }

    pub const fn finalized(self) -> FinalizedBlockRef {
        self.finalized
    }
}

/// Header fields decoded from one exact provider-verified block.
///
/// `digest` is the complete SCALE encoding of the header Digest (compact log count followed by
/// the encoded DigestItems). It remains a chain-level opaque value and is never interpreted as an
/// application event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedBlockHeader {
    block: VerifiedBlockRef,
    parent_hash: Hash32,
    state_root: Hash32,
    extrinsics_root: Hash32,
    digest: Vec<u8>,
}

impl VerifiedBlockHeader {
    pub fn try_new(
        block: VerifiedBlockRef,
        parent_hash: Hash32,
        state_root: Hash32,
        extrinsics_root: Hash32,
        digest: Vec<u8>,
    ) -> ContractResult<Self> {
        if digest.len() > MAX_HEADER_DIGEST_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "block header digest 超过 1 MiB",
            ));
        }
        Ok(Self {
            block,
            parent_hash,
            state_root,
            extrinsics_root,
            digest,
        })
    }

    pub const fn block(&self) -> VerifiedBlockRef {
        self.block
    }

    pub const fn parent_hash(&self) -> Hash32 {
        self.parent_hash
    }

    pub const fn state_root(&self) -> Hash32 {
        self.state_root
    }

    pub const fn extrinsics_root(&self) -> Hash32 {
        self.extrinsics_root
    }

    pub fn digest(&self) -> &[u8] {
        &self.digest
    }
}

/// Opaque ordered extrinsics from one exact provider-verified block.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedBlockBody {
    block: VerifiedBlockRef,
    extrinsics: Vec<Vec<u8>>,
}

impl VerifiedBlockBody {
    pub fn try_new(block: VerifiedBlockRef, extrinsics: Vec<Vec<u8>>) -> ContractResult<Self> {
        if extrinsics.len() > MAX_BLOCK_BODY_EXTRINSICS {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "block body extrinsic 数量超过 16384",
            ));
        }
        let total = extrinsics.iter().try_fold(0_usize, |total, value| {
            if value.is_empty() {
                return Err(ContractError::new(
                    ContractErrorCode::Integrity,
                    "block body 包含空 extrinsic",
                ));
            }
            total.checked_add(value.len()).ok_or_else(|| {
                ContractError::new(ContractErrorCode::Integrity, "block body 长度溢出")
            })
        })?;
        if total > MAX_BLOCK_BODY_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::Integrity,
                "block body 超过 64 MiB",
            ));
        }
        Ok(Self { block, extrinsics })
    }

    pub const fn block(&self) -> VerifiedBlockRef {
        self.block
    }

    pub fn extrinsics(&self) -> &[Vec<u8>] {
        &self.extrinsics
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeVersion {
    spec_version: u32,
    transaction_version: u32,
}

impl RuntimeVersion {
    pub const fn new(spec_version: u32, transaction_version: u32) -> Self {
        Self {
            spec_version,
            transaction_version,
        }
    }

    pub const fn spec_version(self) -> u32 {
        self.spec_version
    }

    pub const fn transaction_version(self) -> u32 {
        self.transaction_version
    }
}

/// 同一准确块上的 runtime version 与完整 SCALE metadata。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeContext {
    block: VerifiedBlockRef,
    version: RuntimeVersion,
    metadata: Vec<u8>,
}

impl RuntimeContext {
    pub fn try_new(
        block: VerifiedBlockRef,
        version: RuntimeVersion,
        metadata: Vec<u8>,
    ) -> ContractResult<Self> {
        if metadata.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "runtime metadata 不能为空",
            ));
        }
        if metadata.len() > MAX_RUNTIME_METADATA_BYTES {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "runtime metadata 超过 64 MiB",
            ));
        }
        Ok(Self {
            block,
            version,
            metadata,
        })
    }

    pub const fn block(&self) -> VerifiedBlockRef {
        self.block
    }

    pub const fn version(&self) -> RuntimeVersion {
        self.version
    }

    pub fn metadata(&self) -> &[u8] {
        &self.metadata
    }
}

/// 一条链的不可混淆身份。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainIdentity {
    chain_id: String,
    protocol_id: String,
    genesis_hash: Hash32,
}

impl ChainIdentity {
    /// 构造由随包资产 manifest 固定的唯一 CitizenChain 身份。
    pub fn citizenchain() -> Self {
        Self {
            chain_id: CITIZENCHAIN_CHAIN_ID.to_owned(),
            protocol_id: CITIZENCHAIN_PROTOCOL_ID.to_owned(),
            genesis_hash: CITIZENCHAIN_GENESIS_HASH,
        }
    }

    pub fn try_new(
        chain_id: impl Into<String>,
        protocol_id: impl Into<String>,
        genesis_hash: Hash32,
    ) -> ContractResult<Self> {
        let chain_id = chain_id.into();
        let protocol_id = protocol_id.into();
        if chain_id.trim().is_empty() || protocol_id.trim().is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "chain_id 与 protocol_id 不能为空",
            ));
        }
        Ok(Self {
            chain_id,
            protocol_id,
            genesis_hash,
        })
    }

    pub fn chain_id(&self) -> &str {
        &self.chain_id
    }

    pub fn protocol_id(&self) -> &str {
        &self.protocol_id
    }

    pub const fn genesis_hash(&self) -> Hash32 {
        self.genesis_hash
    }
}

/// provider 导出的轻节点数据库信封；只含公开链状态，不含钱包或秘密。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExportedChainState {
    identity: ChainIdentity,
    format_version: u32,
    finalized: FinalizedBlockRef,
    database: Vec<u8>,
}

impl ExportedChainState {
    pub fn try_new(
        identity: ChainIdentity,
        format_version: u32,
        finalized: FinalizedBlockRef,
        database: Vec<u8>,
    ) -> ContractResult<Self> {
        if format_version == 0 || database.is_empty() {
            return Err(ContractError::new(
                ContractErrorCode::InvalidArgument,
                "链状态格式版本和数据库正文必须有效",
            ));
        }
        Ok(Self {
            identity,
            format_version,
            finalized,
            database,
        })
    }

    pub const fn format_version(&self) -> u32 {
        self.format_version
    }

    pub fn identity(&self) -> &ChainIdentity {
        &self.identity
    }

    pub const fn finalized(&self) -> FinalizedBlockRef {
        self.finalized
    }

    pub fn database(&self) -> &[u8] {
        &self.database
    }

    pub fn into_database(self) -> Vec<u8> {
        self.database
    }
}

/// provider 接受导入后的回执；Engine 仍须在调用前独立完成全部门禁。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StateImportReceipt {
    finalized: FinalizedBlockRef,
}

impl StateImportReceipt {
    pub const fn new(finalized: FinalizedBlockRef) -> Self {
        Self { finalized }
    }

    pub const fn finalized(self) -> FinalizedBlockRef {
        self.finalized
    }
}

/// 经过验证语义收口的链客户端；不得增加任意 JSON-RPC 公共入口。
pub trait VerifiedChainClient: Send + Sync {
    fn identity(&self) -> ContractFuture<'_, ChainIdentity>;

    fn get_best_head(&self) -> ContractFuture<'_, VerifiedBlockRef>;

    fn get_finalized_head(&self) -> ContractFuture<'_, FinalizedBlockRef>;

    /// Return one internally consistent status snapshot from the running verified provider.
    fn get_sync_status(&self) -> ContractFuture<'_, ChainSyncStatus> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "provider does not expose typed sync status",
            ))
        })
    }

    /// 通知只表示 provider 已验证的 finalized 快照变化；不得把未验证 RPC 头当作证明。
    /// 未提供订阅的组合明确失败一次后结束，不以轮询伪装订阅。
    fn subscribe_finalized_heads(&self) -> ContractStream<'_, FinalizedBlockRef> {
        struct Unsupported(bool);
        impl futures_core::Stream for Unsupported {
            type Item = crate::ContractResult<FinalizedBlockRef>;
            fn poll_next(
                mut self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Ready(if std::mem::replace(&mut self.0, false) {
                    Some(Err(ContractError::new(
                        ContractErrorCode::Unsupported,
                        "provider does not support finalized subscriptions",
                    )))
                } else {
                    None
                })
            }
        }
        Box::pin(Unsupported(true))
    }

    /// 读取一个准确 finalized 块上的有界 storage key 页面。
    ///
    /// prefix/start key 都是 opaque 字节；provider 不解释业务 storage，也不得把本方法
    /// 扩展为任意 RPC。默认实现明确拒绝，不以扫描或逐 key 查询伪装分页能力。
    fn get_storage_keys_paged(
        &self,
        _block: FinalizedBlockRef,
        _prefix: Vec<u8>,
        _start_key: Option<Vec<u8>>,
        _limit: u32,
    ) -> ContractFuture<'_, Vec<Vec<u8>>> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "provider does not expose storage keys paging",
            ))
        })
    }

    /// 在一个 provider-verified 准确块上执行有界 Runtime API。
    ///
    /// method 和 arguments 对 SDK 保持 opaque；业务方法、参数与返回解码属于调用 App。
    fn call_runtime_api(
        &self,
        _block: VerifiedBlockRef,
        _method: String,
        _arguments: Vec<u8>,
    ) -> ContractFuture<'_, Vec<u8>> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "provider does not expose runtime API calls",
            ))
        })
    }

    /// 解析一个高度在当前 verified finalized 上界内的 canonical finalized 块。
    ///
    /// 生产 provider 必须先读取 verified finalized 上界，再解析目标高度的 canonical hash；
    /// 不得先读 hash、再用稍后的头部采样补写 finality。默认实现只返回它能直接证明的当前
    /// finalized head：历史高度和未来高度均失败关闭，绝不为未知高度伪造 hash。
    fn get_finalized_block_at(&self, number: u64) -> ContractFuture<'_, FinalizedBlockRef> {
        Box::pin(async move {
            let upper = self.get_finalized_head().await?;
            if upper.number() == number {
                Ok(upper)
            } else {
                Err(ContractError::new(
                    ContractErrorCode::NotFound,
                    "默认 provider 不能证明目标高度的 finalized canonical hash",
                ))
            }
        })
    }

    /// 按高度升序解析一个闭区间内的 canonical finalized 块。
    ///
    /// 生产 provider 应从一次准确 verified finalized 锚完成整段 ancestry 验证，避免每个
    /// 高度分别从链头回溯形成 O(n²)。默认实现仅逐项委托强类型单块入口，安全但不承诺
    /// 历史解析能力；空区间以参数错误失败，绝不返回部分结果。
    fn get_finalized_blocks_at(
        &self,
        start_number: u64,
        end_number: u64,
    ) -> ContractFuture<'_, Vec<FinalizedBlockRef>> {
        Box::pin(async move {
            let expected_len = validated_finalized_block_range_len(start_number, end_number)?;

            let mut blocks = Vec::with_capacity(expected_len);
            let mut number = start_number;
            loop {
                let block = self.get_finalized_block_at(number).await?;
                if block.number() != number {
                    return Err(ContractError::new(
                        ContractErrorCode::Integrity,
                        "provider 返回的 finalized 块高度偏离请求顺序",
                    ));
                }
                blocks.push(block);
                if number == end_number {
                    break;
                }
                number = number.checked_add(1).ok_or_else(|| {
                    ContractError::new(
                        ContractErrorCode::InvalidArgument,
                        "finalized 块闭区间高度溢出",
                    )
                })?;
            }
            Ok(blocks)
        })
    }

    /// 把不受信任的 hash/height 解析为 provider 已证明位于 finalized canonical 链上的块。
    ///
    /// 生产 provider 必须支持历史 finalized 块；默认实现只安全接受当前 finalized head，供
    /// 最小只读 provider 使用。Engine 不得把宿主传入的 `finality` 位当成证明。
    fn resolve_finalized_block(
        &self,
        hash: Hash32,
        number: u64,
    ) -> ContractFuture<'_, FinalizedBlockRef> {
        Box::pin(async move {
            let canonical = self.get_finalized_block_at(number).await?;
            if canonical.hash() == hash {
                Ok(canonical)
            } else {
                Err(ContractError::new(
                    ContractErrorCode::Conflict,
                    "目标 hash 不是该高度的 finalized canonical hash",
                ))
            }
        })
    }

    fn get_storage_at(
        &self,
        block: VerifiedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>>;

    fn get_storage_batch_at(
        &self,
        block: VerifiedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>>;

    /// finalized-only 强类型读取；余额、历史和不可逆事实必须使用该入口。
    fn get_finalized_storage_at(
        &self,
        block: FinalizedBlockRef,
        key: Vec<u8>,
    ) -> ContractFuture<'_, Option<Vec<u8>>> {
        self.get_storage_at(block.into(), key)
    }

    /// finalized-only 批量读取，返回顺序必须与输入 key 完全一致。
    fn get_finalized_storage_batch_at(
        &self,
        block: FinalizedBlockRef,
        keys: Vec<Vec<u8>>,
    ) -> ContractFuture<'_, Vec<Option<Vec<u8>>>> {
        self.get_storage_batch_at(block.into(), keys)
    }

    fn get_runtime_context_at(&self, block: VerifiedBlockRef)
        -> ContractFuture<'_, RuntimeContext>;

    /// Return header fields for the exact requested block. Providers must revalidate the block
    /// identity and must not answer from an unrelated moving head.
    fn get_block_header_at(
        &self,
        _block: VerifiedBlockRef,
    ) -> ContractFuture<'_, VerifiedBlockHeader> {
        Box::pin(async {
            Err(ContractError::new(
                ContractErrorCode::Unsupported,
                "provider does not expose verified block headers",
            ))
        })
    }

    fn get_finalized_runtime_context_at(
        &self,
        block: FinalizedBlockRef,
    ) -> ContractFuture<'_, RuntimeContext> {
        self.get_runtime_context_at(block.into())
    }

    /// 读取目标块完整 extrinsic 字节，供 Engine 按完整哈希定位准确 index。
    fn get_block_extrinsics_at(&self, block: VerifiedBlockRef) -> ContractFuture<'_, Vec<Vec<u8>>>;

    fn get_block_body_at(&self, block: VerifiedBlockRef) -> ContractFuture<'_, VerifiedBlockBody> {
        Box::pin(async move {
            let extrinsics = self.get_block_extrinsics_at(block).await?;
            VerifiedBlockBody::try_new(block, extrinsics)
        })
    }

    fn get_finalized_block_extrinsics_at(
        &self,
        block: FinalizedBlockRef,
    ) -> ContractFuture<'_, Vec<Vec<u8>>> {
        self.get_block_extrinsics_at(block.into())
    }

    /// 节点接收只返回提交事实，不代表入块、finalized 或 runtime 执行成功。
    fn submit_extrinsic(
        &self,
        extrinsic: SignedExtrinsic,
    ) -> ContractFuture<'_, SubmittedExtrinsic>;

    /// watch 事件的块锚必须携带 provider 已核对的 `VerifiedBlockRef`。
    fn watch_extrinsic(
        &self,
        extrinsic: SignedExtrinsic,
    ) -> ContractStream<'_, ExtrinsicWatchEvent>;

    fn export_state(&self) -> ContractFuture<'_, ExportedChainState>;

    /// 只允许在 provider 启动前调用。Engine 仍须先核对身份、格式、finalized 与非倒退。
    fn import_state(&self, state: ExportedChainState) -> ContractFuture<'_, StateImportReceipt>;
}

#[cfg(test)]
mod finalized_block_range_tests {
    use super::*;

    #[test]
    fn range_limit_accepts_120_and_rejects_121_reverse_and_overflow() {
        assert_eq!(validated_finalized_block_range_len(1, 120).ok(), Some(120));
        assert!(validated_finalized_block_range_len(1, 121).is_err());
        assert!(validated_finalized_block_range_len(2, 1).is_err());
        assert!(validated_finalized_block_range_len(0, u64::MAX).is_err());
    }
}
