//! 准确块身份绑定的 runtime metadata cache。

use crate::{ContractFuture, Hash32, RuntimeContext};

/// 跨平台宿主最多持久化 64 个准确块的 runtime context。
///
/// 这是可重建性能缓存的资源上限，不限制 Core 当前内存可使用的 runtime metadata。
pub const MAX_PERSISTED_RUNTIME_CONTEXTS: usize = 64;

/// 单条持久 runtime cache 记录允许承载的 metadata 字节数。
///
/// 四个平台把完整 host record 限制为 8 MiB；扣除 56-byte host envelope 与
/// 55-byte typed runtime context 字段后，剩余字节才能用于 metadata。更大的、但仍符合
/// [`crate::MAX_RUNTIME_METADATA_BYTES`] 的 metadata 可以在 Core 内存中使用，不进入持久缓存。
pub const MAX_PERSISTED_RUNTIME_METADATA_BYTES: usize = (8 * 1024 * 1024) - 56 - 55;

/// Runtime cache 只能按准确块哈希命中，不能只按 specVersion 猜测块身份。
pub trait RuntimeCacheStore: Send + Sync {
    fn load(&self, block_hash: Hash32) -> ContractFuture<'_, Option<RuntimeContext>>;

    /// 写入的 context 自带同块 runtime version、transaction version 与 metadata。
    ///
    /// 实现必须把插入/替换和 FIFO 淘汰放在同一事务中，提交后至多保留
    /// [`MAX_PERSISTED_RUNTIME_CONTEXTS`] 条；相同 block hash 的替换只占一条。
    fn store(&self, context: RuntimeContext) -> ContractFuture<'_, ()>;

    fn delete(&self, block_hash: Hash32) -> ContractFuture<'_, ()>;
}
