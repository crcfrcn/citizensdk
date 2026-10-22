# CitizenSDK smoldot PoW 上游记录

## 固定基线

- 上游仓库：`https://github.com/smol-dot/smoldot`
- 收编基线提交：`f471baac1f0fa821569c42ebb14c4f8533ba77ad`
- CitizenSDK 产品快照：`smoldot/lib`与`smoldot/light-base`

`net`是CitizenSDK自有适配层，不属于上游smoldot快照。它只能依赖
上述收编源码并实现 `VerifiedChainClient`，不能把上游 JSON-RPC 任意透传成产品公共 API。
SDK自有边界测试位于`net/tests`，由该crate直接编译，并显式读取所属上游源码。
上游按标准Cargo模块路径保存，自有crate采用标准`src`；不再依赖构建时目录重排。
源码、manifest与原锁不因归位改变，正式Flutter绑定经产品C ABI调用。

本目录不保存 `.git`、构建产物或临时 patch，CI/Release 也不联网拉取上游源码。GMB
`citizensdk` 是发布时的唯一源码输入。

交易服务 `light-base/src/transactions_service.rs` 从上述官方基线恢复原有顺序后，
仅增加已确认的 best==finalized 验证支持：保留当前最终块头及该订阅的 Runtime 固定引用，
使用同一 Runtime 验证函数；接受当前最终块的结果，丢弃旧根及已清理分叉的迟到结果。
最终块更替时准确释放旧引用，订阅重建时不复用旧上下文，异步启动前已释放的块重新选择。
交易池`lib/src/transactions/light_pool.rs`保持官方原件；验证、广播、无效清理和最终化
保留官方顺序，不添加提前广播或已入块优先的分支，也不插入诊断。
空闲链验收必须证明无需新区块即可执行验证，源码摘要或离线通过不能代替真实验证。

`light-base/src/lib.rs`的SDK唯一typed nonce入口接收请求账户及已验证best的hash/高度。
同一Runtime订阅先核对目标身份，Runtime落后明确返回NotReady，换块或高度不符返回Conflict；
只有准确目标接纳后才调用`pin_pinned_block_runtime`，固定结果的高度仍须再次核对。
最终根和非最终best共用同一执行路径，不下载额外`:code`/`:heappages`或改查另一块。
闭集`ChainAccountNonceError`由provider按类型映射，不解析错误正文；证明网络诊断保持。
原`runtime_call`的API版本、状态证明、三次尝试和u32解码继续生效；返回账户/块仍由provider核验。
取消、失败和正常完成共用一次清理，固定阶段诊断默认关闭。RuntimeService与交易池算法保持官方基线。
扩展的块接纳、解码及清理回归归现有`runtime_query_tests`，由唯一产品测试入口按本目录原锁、
std且不启用Wasmtime定向执行，随后执行原有全量回归。

`light-base/src/runtime_service.rs`仅在已有调用证明网络失败分支接入受限诊断：复用
`CITIZENSDK_TRANSACTION_DIAGNOSTICS=1`，记录实际公开PeerID、固定nonce/Metadata调用名、
原三次尝试内的序号、闭集网络类别及时间。格式与分类归`light-base/src/lib.rs`，原
`runtime_query_tests`覆盖两个合成对端、两种调用、全部十二类网络错误与开关/非法输入边界。
诊断不接收账户、块、参数、Runtime、证明或原始错误正文；no_std不读取环境或输出，输出失败
不覆盖原错误。原节点选择、三次尝试、每次五秒、并行一、验证及断开顺序保持；不新增请求。
空证明协议未携带服务端内部原因，日志只能定位实际响应节点，不能替代节点端错误证据。

`light-base/src/platform/default.rs`在官方PlatformRef连接边界增加不可变的实例级WSS
域名/端口限制。默认构造沿同一实现传入None；provider定向配置传入明确地址，其他地址在DNS
及套接字创建前返回PermissionDenied，动态发现也不能绕过。限制实例只声明WSS DNS连接能力，
既有TLS证书、主机名及libp2p PeerID握手保持。所属内联runtime_query_tests覆盖地址/端口/
传输拒绝及真实Stream错误传播，由原产品回归入口执行。此项为本产品定向验收策略，官方并未
要求固定国储会；网络、同步、选点和证明算法仍使用同一实现。

准确块Runtime上下文入口同样位于既有`light-base/src/lib.rs`：在同一次订阅中
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
5. 同步测试夹具、内联测试、Cargo manifests、`Cargo.lock`和本文件。
6. 在源码树外完成三个 Rust workspace、Dart/Flutter、移动原生构建与候选验证后才接受更新。

同步上游后还必须执行 provider 的 exact-block、finalized、runtime context、提交/观察和
state import/export合同测试，并核验SDK当前公开C接口与生命周期合同。

临时patch、上游checkout和构建目录使用后全部删除，不得进入Release；上游来源与适配说明以本文件为准。

## 示例裁剪（2026-10-09）

按用户要求删除 Polkadot/Asset Hub 两份示例链配置及 basic.rs 示例，并移除 light-base 的 basic 示例目标。其余上游库、模块、锁文件、算法和测试夹具不变；Cargo.toml 的配置裁剪归 adapted 来源。SDK 生产链资产仍唯一位于根 chain/。
