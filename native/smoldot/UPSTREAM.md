# CitizenSDK smoldot PoW 上游记录

## 固定基线

- 上游仓库：`https://github.com/smol-dot/smoldot`
- 收编基线提交：`f471baac1f0fa821569c42ebb14c4f8533ba77ad`
- CitizenSDK 产品快照：`native/smoldot/pow/lib` 与 `native/smoldot/pow/light-base`

`native/smoldot/provider` 是 CitizenSDK 自有适配层，不属于上游 smoldot 快照。它只能依赖
上述收编源码并实现 `VerifiedChainClient`，不能把上游 JSON-RPC 任意透传成产品公共 API。

本目录不保存 `.git`、构建产物或临时 patch，CI/Release 也不联网拉取上游源码。GMB
`citizensdk` 是发布时的唯一源码输入。

交易服务 `pow/light-base/src/transactions_service.rs` 从上述官方基线恢复原有顺序后，
仅增加已确认的 best==finalized 验证支持：保留当前最终块头及该订阅的 Runtime 固定引用，
使用同一 Runtime 验证函数；接受当前最终块的结果，丢弃旧根及已清理分叉的迟到结果。
最终块更替时准确释放旧引用，订阅重建时不复用旧上下文，异步启动前已释放的块重新选择。
交易池 `pow/lib/src/transactions/light_pool.rs` 保持官方原件；验证、广播、无效清理和最终化
保留官方顺序，不添加提前广播或已入块优先的分支，也不插入诊断。
`SOURCE_SHA256.json` 的 adapted 类别记录交易服务当前源码及内联回归摘要。
空闲链验收必须证明无需新区块即可执行验证，源码摘要或离线通过不能代替真实验证。

`pow/light-base/src/lib.rs`的SDK typed nonce入口统一使用同次订阅的
`pin_pinned_block_runtime`，best为最终根或非最终块时均复用准确块已有Runtime，
不额外下载`:code`和`:heappages`。原`runtime_call`的API版本、状态证明和输出解码
继续生效，返回的账户、块身份由provider严格核验。该入口的固定阶段耗时默认关闭；
取消、失败和正常完成共用一次清理动作。RuntimeService和交易池算法均不因该优化改动。

准确块Runtime上下文入口同样位于既有`pow/light-base/src/lib.rs`：在同一次订阅中
固定请求hash的Runtime，以同一对象读取版本并执行原Metadata API证明。订阅报告之外
的历史块继续校验目标header hash/高度和代码存储证明，不用当前头替代；报告后pin失败
直接返回失败。nonce与上下文共用取消安全的订阅释放实现，原RuntimeService不改动。
SDK自有provider只在本次运行实例中有界缓存成功验证过的准确块上下文并合并同块并发；
finality每次独立核验，关闭清空缓存并唤醒等待者，失败/取消不缓存，不读取宿主性能缓存
作为证明。旧JSON-RPC的两个Runtime请求已从正式provider上下文入口移除。

## 基线已有的 PoW + GRANDPA 改动

收编前相对上游基线已有本地改动：

```text
lib/src/chain/blocks_tree.rs
lib/src/chain/blocks_tree/finality.rs
lib/src/chain/blocks_tree/verify.rs
lib/src/chain/chain_information.rs
lib/src/chain/chain_information/build.rs
lib/src/header.rs
lib/src/sync/warp_sync.rs
lib/src/verify.rs
lib/src/verify/header_only.rs
lib/src/verify/pow.rs
light-base/src/sync_service/standalone.rs
```

这些文件共同构成当前 PoW + GRANDPA 轻节点基线，不应在同步官方 smoldot 时丢失。

## 同步规则

1. 在临时目录检出上游目标提交，不在 CitizenSDK 内嵌套 `.git`。
2. 仅比较和更新 `lib`、`light-base`；CitizenSDK 不收编 `full-node` 或 `wasm-node`。
3. 先生成上游差异与文件闭集，确认上述 PoW 改动、轻客户端排除项和许可证。
4. 在独立 fork/分支上 rebase PoW 补丁并完成冲突审查，再逐字节回灌临时候选。
5. 同步测试夹具、内联测试、Cargo manifests、`Cargo.lock`、来源 manifest 和本文件。
6. 在源码树外完成三个 Rust workspace、Dart/Flutter、移动原生构建与候选验证后才接受更新。

同步上游后还必须执行 provider 的 exact-block、finalized、runtime context、提交/观察和
state import/export 合同测试，并证明 legacy `libsmoldot` 的库名、回调及全部既有导出未变。

临时 patch、上游 checkout 和构建目录使用后全部删除，不得进入 Release。完整产品来源分类
见塔塔文档库中的 CitizenSDK 来源记录。
