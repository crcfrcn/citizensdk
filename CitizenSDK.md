# CitizenSDK 技术文档

## 当前实现

CitizenSDK是通用无UI区块链SDK。链同步、Runtime、交易准备/执行/历史、钱包、sr25519和二维码协议只在同一Rust Core实现。App拥有页面、展示、业务载荷和用户确认；系统资源由SDK各平台实际拥有者提供。聊天逻辑归TataChatSDK，不在本SDK实现。

源码只保留一个根Cargo包citizensdk；Pub、Cargo、Gradle、podspec与桌面CMake同一基准版本2.0.0，`[lib] path="core/src/lib.rs"`。C ABI=2。Core唯一构造是`citizensdk_create(options, modules, stores, out_handle)`；调用方显式交付所选模块所需真实资源。旧构造、旧包、业务Host回调、自定义Store装配、内存会话仓储、签名器对象及兼容路径均删除。

模块位保持wallet=1、signing=2、chain=4、transactions=8、history=16、qr=32，full=63；依赖和编译能力只由Core校验。QR-only不创建钱包、金库或轻节点；wallet/signing-only不读取链资产。不满足实际资源要求时明确拒绝，不按空数据或替代实现继续。

目录以产品根为0，第一方代码目录不超过3层，不设单文件目录或填充文件；文件名不计入目录层级。上游smoldot保留官方目录、名称、源码和原始锁；image保留同一ZXing-C++来源实现。

```text
citizensdk/
├── Cargo.toml, Cargo.lock, pubspec.yaml, pubspec.lock
├── core/
│   ├── src/
│   │   ├── lib.rs, engine.rs, runtime.rs, host.rs, assets.rs, sign.rs
│   │   └── abi/, chain/, types/, store/, qr/
│   ├── cpp/
│   │   └── host.cc/.hpp, resource.cc, flutter.cc/.hpp, value.cc/.hpp,
│   │       request.hpp, environment.hpp, sqlite.hpp, input.hpp, operation.hpp, secret.hpp
│   └── tests/
│       └── abi/, cpp/, types/, store/, qr/, sign/ 及Core自身测试
├── lib/
│   ├── citizen_sdk.dart, account_codec.dart
│   ├── api/       同一CitizenSdk直接C调用与真实资源
│   ├── models/    公开值类型
│   ├── platform/  bind.dart、memory.dart
│   └── test/      api/, models/, platform/, consumers/
├── include/       citizensdk.h、citizensdk_types.h、citizensdk_host.h
├── android/       src/、flutter/、tests/、native/ 及原构建声明
├── darwin/        src/、flutter/、tests/ 及原Package/podspec
├── linux/         src/、tests/、cmake/ 及CMakeLists
├── windows/       src/、tests/、cmake/ 及CMakeLists
├── image/, chain/, smoldot/
├── scripts/       build.mjs、config.mjs
└── .github/workflows/  sdk.yml、publish.yml
```

## 接口和所有权

公开Core C函数闭集由`include/citizensdk.h`和独立143项符号金标逐项一致校验。图像/Dart辅助6项来自同一image实现；硬件SQL私有机械入口3项不进入公开头。绑定由pubspec的ffigen节点和同仓实际头生成，不手改生成签名。

Dart只有一个CitizenSdk实例，业务直接调用C入口和typed getter。chain/wallet/signing/transactions/history/qr分组对象、Platform、Session、Codec、字符串业务派发和列表结果投影均删除。ReceivePort只接收C声明的五项`kind, sequence, request, result, revision`，由各实例自身端口关联；接纳/取消使用真实Core requestId。

预备钱包、受控备份、钱包检查、二维码审阅、相机和显式取钥是实际final资源类，构造私有；资源字段直接持有实际Core引用或系统资源。钱包提交已消费准备句柄后，释放只归还仍存在的准备；提交前取消归还的准备仍实际清零释放。取消只请求取消，closed只表示真实终态。父关闭先请求取消，再关资源并排空请求、归还结果/准备，再卸载接收者并销毁原生实例；晚到数据按同一拥有者归还。

Swift业务入口直接归CitizenSdk；CitizenSDKCore仅持有真实Core/Host借用、ABI保活、在途请求和关闭状态。CitizenSDKRead只把实际C getter转换成公开值。Android同一CitizenSdk直接调用Bind.kt的JNI声明，values.cpp直接构造实际Kotlin模型；没有私有业务二进制结果帧或NativeResult类型树。CoreResult只拥有真实C结果引用，资源成功登记后才移交。

桌面公开C++业务门面、重复Config、NativeTransport/HostTransport/TransportFactory已删除。实际Host和Flutter系统资源共同源码在core/cpp，OS差异在编译条件内；平台保留实际窗口/GTK、认证、文件/VFS和纹理。唯一Host公开头是include/citizensdk_host.h，资源ABI=2，仅保留citizensdk_host_create(config, modules, out_host)这一资源构造，配置不重复保存模块选择。Flutter官方命名空间注册头只在构建目录生成，实际源码在平台src。

Android使用平面sourceSets和ffiPlugin；每个FlutterEngine由应用通过公开plugins.add显式登记一次CitizenSdkPlugin，Activity必须是FlutterFragmentActivity。Darwin Flutter源码位于darwin/flutter，podspec仍采用Flutter要求的citizen_sdk名称。不制造深Kotlin包目录、副本入口或另一套SDK。

## 算法、数据和安全边界

smoldot是唯一轻节点实现，保留原锁、WSS、系统证书和主机名校验。链资产只来自chain的三份既定输入，Core在创建provider前核验固定身份与完整manifest；调用方给出的manifest不能授权另一个checkpoint。Runtime、nonce、余额、费率、交易准备和执行始终绑定同一准确块事实，不在平台补造链值。

sr25519只有core/src/sign.rs的同步派生、公钥、签名和验签函数；Substrate Ed25519展开、硬派生、签名上下文和冻结向量不变。临时秘密使用原Zeroizing/受控缓冲。设备认证、网络、SQL及真实关闭保持各自异步所有权，不把算法包装成Future。

Core只接受同步SQLite机械资源：run在原线程持有连接/锁并恰好执行一次job；事务固定同一连接，query只借用当前行。未完成事务离开job后连接退休，不自动重开。SQL、schema、CAS、记录域、校验和、历史索引及加密记录语义只归Core Store；平台不提供第二套业务Store/Codec。

公共文件public-state.sqlite3、schema2、七项业务对象，安全文件secure-state.sqlite3、schema1，CSHR/TXR及钱包载荷格式保持所属代码原定义；同版本未知/部分/额外DDL或损坏记录仍拒绝，不迁移、重建或当空。WAL、FULL、外键、trusted_schema和secure_delete按原平台能力应用并回读，Android系统android_metadata不算业务对象。

热派生最大序号19890604，冷账户容量1990，两者和处理批次分别约束；删孔不复用，未提交追加只暴露稳定旧目录。修订、密文信封、provisioning owner和generation必须准确匹配，generation永久退休。历史最多4096条、31MiB耐久权重、页1..100，终态与未知广播事实不被本机重试覆盖。

平台金库只负责KEK生命周期及32字节DEK包裹/解包，不接收账户mini-secret、助记词或sr25519签名请求。Core认证/解密信封并签名。普通结果不返回账户秘密或独立钱包signed extrinsic；备份、密码、助记词输入和显式取钥只经受控资源短时借用。SDK只承诺清零自身实际拥有的内存，不把借用输入或用户返回副本说成已擦除。

未知、交叉实例、已释放或已领取的资源拒绝；完成只对应准确真实请求。回调context、借用DEK、输出缓冲与OS操作保有至真实回调终态；用户取消/通知入队不等于资源结束。销毁BUSY保留原拥有者，恢复单调关闭，不新建替代资源或认证回退。

## 构建、消费和验证

scripts/config.mjs只声明本产品工具/配置/工作流；scripts/build.mjs是唯一构建与测试实现；工作流负责作业编排。Node25.2.1、Rust1.97.1、Flutter3.47.2、NDK28.2.13676358、Gradle9.1.0、CMake3.31.6和原依赖来源不改变。独立执行与控制台调度使用同一入口，产品不读取控制台依赖库存。

同一SDK包含Android arm64-v8a（API24+）、iOS16 arm64、iOS模拟器arm64、macOS13 arm64、LinuxARM64和Windowsx64实际原生件。macOS Framework沿官方Versions/A与五个内部相对链接。完整包、原锁、许可、真实来源及平台原生件不完整时失败，不自动换库或升级。

主Dart测试在lib/test四个分组，根不设test/tests。纯值/接口回归与真实FFI分开，实际FFI使用同轮正式Core、SQLite、ZXing，只有物理金库可用性、确保失败和终态等待点由明确有限夹具提供，不模拟SDK业务或结果。Dart显式显示和相机元数据/关闭确认使用有限物理通道夹具，覆盖迟到拒绝、借用副本清零、真实确认等待、暂停订阅不阻塞归还及早到关闭；这不是设备授权或相机采集正向验收。热准备的成功、作业失败、取消与关闭等待由同轮正式Core及有限物理夹具回归；该结果不代表硬件加密、授权或重启持久性通过。实际Flutter消费者为apple/linux/windows；CitizenApp和TuyuLove只通过公开CitizenSdk接入同一版本。旧合成业务消费者及旧接口替身不作为验收。

实际工具退出码、报告、用例数和跳过必须分别核对；缺报告、零执行或全部跳过不能成功。共同C++/类型检查/有限单元不能替代LinuxARM、Windows、Keychain/Keystore/TPM正向认证和物理相机验收。执行结果只登记唯一任务卡，不在本技术文档保存过程结论。

sdk.yml是唯一公开塔塔自动化入口；publish.yml只由其调用并执行实际发布。交付版本不低于pubspec声明，既有成功交付仅在版本不降低的前提下递增补丁。publish默认false；正式发布和远端历史清理需要独立明确授权。工具下载遵守唯一全局规则，不由重构、安装或自动化授权推定允许。README只保留简介和许可入口。

## 本地钱包目录与安全故障诊断

钱包存储、派生、创建导入、账户管理、金库、认证及签名始终归本SDK；宿主只消费公开接口。本地目录读取不刷新provider、签名或历史能力，不使用provider运行时，也不等待认证事务门。目录由原子仓储load及现有稳定投影返回，热描述、名称和账户能由同一WalletState通过同一C getter读取，读取失败保持真实类型，不能合成空钱包。SDK保留单一实例和实际仓储，新增的只是两线程有界本地读取调度；启停和链状态不参与目录准入，close仍排空全部请求及结果。

readDiagnostics为既有公开诊断方法，零输入、只读，返回最多128个六字段tuple：方法、请求阶段、错误码、失败阶段、固定原生步骤、有界毫秒耗时。当前接口使用C ABI2；持久化格式、密码学金标和既有业务枚举数值保持。诊断不保存账户、会话、参数、异常原文、秘密或其衍生值。Android以SDK自己的noBackup上下文、Apple以SDK应用私有目录原子保留最多64KiB最新记录，Dart直调在同一请求接纳/完成处向既有diagnose资源通道记录闭集，不传业务载荷或另建业务派发；诊断失败不改变原操作。宿主仅通过SDK公开诊断接口读取，不访问SDK私有目录。可捕获panic返回固定步骤；进程终止须结合系统信号与匹配符号分析，不能据此声称钱包丢失或原位恢复。

回归覆盖未启动provider、金库不可用、历史故障、本地真实存储错误、启停并发读取、取消及排空、诊断饱和后的新故障保留与秘密拒绝。本机与GitHub均通过本产品scripts/build.mjs执行；开发期静态差异不表示测试或编译成功。

所有构建/测试入口先实际编译独立C11和C++17头断言；默认test入口再执行Rust所有者测试、严格Dart分析及默认Flutter测试；真实FFI由Apple入口单列执行。各平台使用同一scripts/build.mjs与独占源码投影；缺报告、零用例、失败、全部跳过均拒绝，明确的系统权限/隔离硬件跳过须单列，不计通过。Android单测及Apple公开XCTest入口在原生件上传前执行，Linux与Windows保留各自原生CTest。

原生故障边界同时覆盖默认panic hook：本SDK请求或同步ABI边界内只输出固定故障字节，再返回闭集步骤，不读取panic载荷或源码位置；非SDK的panic继续调用原hook。嵌套边界须恢复线程状态，诊断不得改变原结果或认证权限。桌面Flutter绑定的安全记录为当前实例有界记录，Android及Apple另有私有持久化；不能把实例记录声称为跨重启历史。

每个SDK运行实例的64个真实完成事件槽中，普通事件/请求最多使用56个，其余8个供本地只读接纳；本地worker与事件交付两层都不因普通网络队列饱和而失去进展。保留原通用EventDispatcher默认容量语义，新增运行实例与事件层饱和回归验证；关闭仍等待全部预留及在途结果。

本地创建/导入/账户管理/签名等入口使用本地钱包事实刷新及本地异步驱动；不再顺带探测provider或历史仓储。新刷新只替换同一能力快照中的四项钱包事实，链和历史状态保持由各自所有者维护。认证、金库、目录CAS、在途历史排空和签名验真不减弱；不能将安全排空要求误作可跳过的网络检查。

生命周期准入同时核对登记与实际在途计数；普通请求即使已从取消登记移除，也必须完成结果提交后才允许启停，本地目录例外不扩大到其它请求。相应窗口回归在同一Runtime既有测试中覆盖。

GitHub完整Rust回归显式使用--include-ignored，纳入既有四项受时间上限约束的实网只读验收；无钱包账户输入、不发送有效交易。真实网络不可用按原测试失败，不以忽略或零执行通过；其结果不等同于手机现场复现。

构建缓存原子领取；持有时使用固定源码投影和原文件时间戳复用Cargo产物，缓存占用则使用本轮独占目录。包内Artifact使用目标后缀，最终完整包、Release和Tag仍统一为产品·SDK·版本。

严格Dart分析不降低检查级别；导入排序、语句括号、等价字符串插值及测试集合显式类型由产品源码维护，不在构建现场改写业务或屏蔽诊断。

新正式版上传并回读后才删除旧正式版与对应Tag；旧版本清理失败必须使本轮失败，不能只打印告警后报告整体成功。

Dart平台选择回归依据真实Abi.current验证LinuxARM准入，不把macOS的TargetPlatform覆盖当作真实Linux机器；未支持Linux架构与Fuchsia必须在进入任何通道之前拒绝。固定方法测试包含既有readDiagnostics的零输入和多余字段拒绝。

Windows独立Host与消费者显式使用Ninja生成器及已交付的x64 MSVC环境，不向NMake传递Visual Studio专用-A选项；Flutter消费者仍使用未修改的官方Flutter/Visual Studio工具闭包。

完整Rust回归串行执行，包含全部显式实网只读用例，避免多个实网观察同时争用链状态；断言、超时和失败结果不改。Unix工具close后统一用系统ps只读取得PGID和状态，精确核对本轮独立进程组，不再以受信号权限约束的kill(pid,0)判断退出。无成员或仅剩已退出Z状态才完成；活动成员仍按原50次100ms等待，取消保留原TERM/KILL及2100ms后单次核对。读取失败、格式无效、未知状态或活动超时均失败并keepWork保留现场，不输出完整进程表、命令参数或环境。Windows原taskkill树处理保持。所属构建回归覆盖准确组隔离、短命后代退出序列、僵尸、读取/权限/解析失败和等待边界。

Windows Flutter由同一Resources实际拥有私钥资源：Core仍拥有私钥，PrivateKeyResource负责既有接收器、显式查看、真实关闭和敏感副本清空；资源仅归创建会话，未关闭不得报告排空。交易执行证明沿用SemanticExecution成功布尔事实核对，外内状态不一致必须拒绝。插件声明只投影到本轮CMake构建目录，源码不生成平行头文件；MSVC严格警告保持。

Windows将Core宽字段投影为公开字节前先验原值边界，布尔标志先通过严格0/1解析；禁止通过强制转换掩盖损坏。

插件及其子目录测试共同引用同一生成头根路径，不使用调用方子目录的CMAKE_CURRENT_BINARY_DIR重算位置。

Flutter Linux官方后端固定使用clang/clang++名称；本轮PATH将这两个强制名称指向同一已声明Clang16原件，不安装其他编译器，也不改写Flutter源码或系统工具。


### QR_V1 Action Registry

- 更新日期:2026-08-08
- 状态:人类可读登记表;代码真源为 `citizenchain/crates/qr-protocol/registry/*`
- 范围:`k=1` 签名请求的 `b.a` 数字动作码
- 依赖:
  - `../citizenwallet/CitizenWallet.md`
  - 唯一代码真源:`citizenchain/crates/qr-protocol/registry/actions.yaml`
  - 字段中文真源:`citizenchain/crates/qr-protocol/registry/fields.yaml`
  - QR body 结构真源:`citizenchain/crates/qr-protocol/registry/kinds.yaml`
  - 拒绝原因真源:`citizenchain/crates/qr-protocol/registry/reject_reasons.yaml`
  - Runtime 非链签名常量参考:`citizenchain/runtime/primitives/src/sign.rs`
  - 链交易动作码校验参考:当前 runtime metadata 的 pallet/call index

`k` 只表达扫码流向;`a` 才表达业务动作。任何平台新增扫码签名场景,必须先进入唯一 action registry,再生成或校验各端常量、中文标签和 decoder 映射。不得在 CitizenApp、CitizenWallet、OnChina、node 或 citizenweb 内手写第二套 action 真源。

#### 0.0 账户字段目标命名

ADR-040 已冻结 QR registry 及其生成物的账户字段目标：单一账户使用 `account_id`，多个业务角色账户使用 `<role>_account_id`；签名公钥使用 `signer_public_key`，凭证签名公钥使用 `credential_signer_public_key`，展示地址只使用 `ss58_address`。账户和 32 字节公钥的文本值固定为小写 `0x` 加 64 位十六进制。

上述目标命名已在 registry、生成物和扫码消费端统一落地；旧账户/公钥字段已列入一致性测试禁止清单，不构成兼容路径。

#### 0. 唯一 registry schema

`actions.yaml` 每条 action 必须包含:

| 字段 | 含义 | 强制规则 |
|---|---|---|
| `action_key` | 稳定英文动作键 | 全仓唯一,不得用 UI 文案或临时缩写 |
| `action_code` | QR `b.a` 数字动作码 | 链交易必须与 runtime metadata 校验一致 |
| `action_label_zh` | 用户可见中文动作名 | 缺失即红色拒绝 |
| `kind` | `chain_call` / `offchain_sign` / `hash_only` | 决定 decoder 和签名字节规则 |
| `qr_kind` | 当前必须是 `sign_request` | 不新增登录专用 kind |
| `pallet` | 链交易 pallet 名 | `kind=chain_call` 必填 |
| `call` | 链交易 call 名 | `kind=chain_call` 必填 |
| `decoder` | payload decoder 名 | 缺失即红色拒绝 |
| `hash_only_allowed` | 是否允许 `b.d` 只携带 32B | 只有 Runtime 升级允许为 true |
| `signing_category` | 签名类别 | 用于选择统一签名字节规则 |
| `required_fields` | 必须展示字段 key | 每个字段 key 必须能在 `fields.yaml` 找到中文 |

`fields.yaml` 是扫码展示字段中文名和固定展示值唯一真源。decoder 输出的每个字段 key 都必须能查到中文字段名;查不到时红色拒绝,不得 fallback 成英文 key。固定业务展示值用 `field_value_zh` 登记,例如默认岗位、制度账户、机构费用付款账户；CitizenWallet decoder 只提供 `actor_cid_number` 等动态替换变量,不得在 decoder 里手写第二份中文值。

签名判定统一输出:

```text
Normal/正常: 绿色,允许签名
Reject/拒绝: 红色,禁止签名
```

不存在第三种状态。action 未登记、无中文动作名、无 decoder、payload 无法解码、字段无中文翻译、普通交易 hash-only,一律 `Reject/拒绝`。

CitizenApp 的 QR 解析与动作常量通过 CitizenSDK 公共接口使用，不再持有宿主生成表；CitizenWallet 继续校验 `citizenwallet/lib/qr/generated/qr_action_registry.g.dart`。未登记 action 或字段仍须拒绝，不能显示英文或数字兜底。

#### 1. 非链动作码

| a | 名称 | payload | 签名字节 | 生成方 | 扫码/签名方 | 注释 |
|---:|---|---|---|---|---|---|
| 1 | `login` | UTF-8 `onchina` | `QR_V1|2|i|onchina|e|target_signer_public_key_without_0x` | OnChina | CitizenWallet | 先扫描 `k=5 account_id_code`（公民钱包账户详情出示），取 `b.account_id` 单向反查链上 Active 管理员记录后，再生成非空 `b.u` 的定向登录请求 |
| 2 | `citizen_identity` | `VotingIdentityPayload` SCALE bytes | `blake2_256(GMB || 0x10 || payload)` | OnChina | CitizenWallet / CitizenApp(电子护照扫码签名页) | 公民本人确认链上投票身份载荷;CitizenApp 侧解码器在 `my/myid/voting_identity_payload.dart` |
| 3 | `onchina_admin_action` | `onchina_admin_governance` canonical JSON UTF-8 | `blake2_256(GMB || 0x20 || canonical JSON UTF-8)` | OnChina | CitizenWallet | 链上中国平台管理员治理冷钱包确认；2026-08-06 由裸文本直签收敛到统一哈希域 `OP_SIGN_ONCHINA_ADMIN` |
| 5 | `activate_admin_account` | `GMB || 0x18` 二进制 payload | 原文 | citizenchain node / CitizenApp | CitizenWallet | 管理员激活 |
| 6 | `decrypt_admin` | `GMB || 0x19` 二进制 payload | 原文 | citizenchain node | CitizenWallet | 清算行管理员解密 |
| 7 | `runtime_upgrade_hash` | 32B WASM hash | 原文 32B | citizenchain node / CitizenApp | CitizenWallet | Runtime 升级哈希直签 |
| 9 | `square_account_action` | 广场账户动作 SCALE bytes（`action‖account_id‖challenge_id[‖level]‖u64(expires)`） | `signing_message(OP_SIGN_SQUARE_ACTION, payload)` | 官网 citizenweb / CitizenApp | CitizenApp（聊天 tab「扫一扫」，account_id 对应主钥+生物识别） | 会员订阅/取消等账户动作链下签名；account_id 由 QR `u` 在本机定位钱包，两色解码 `signer/square_action_payload.dart`；Worker `account/action_challenge.ts` 构造/验签 |
| 12 | `switch_default_account` | `genesis_hash(32) ‖ current_default_account_id(32) ‖ Vec<AccountId> ‖ expires_at(u64 LE) ‖ nonce(16)` | `signing_message(OP_SIGN_SWITCH_DEFAULT_ACCOUNT=0x21, payload)` | CitizenApp | CitizenApp 热钱包 / CitizenWallet 冷钱包 | 只授权本机账户顺序第一项变化；签名者固定为原默认账户，完整排列必须无重复且第一项变化；不含 CID/绑定版本，不提交链、不调用 Worker 或换绑 |
| 13 | MLS设备登记（mls_device_bind） | SCALE cid_number、binding_revision u64LE、account_id、public_key、issued_at u64LE | signing_message(OP_SIGN_MLS_DEVICE_BIND=0x1C, payload) | CitizenApp | CitizenWallet当前冷账户 | 公钥为同一MLS身份的32字节小写0x hex；账户必须与请求相同，e=issued_at/1000+120 |

钱包签名模式修复不占 QR action：`OP_SIGN_WALLET_MODE=0x23` 只由 CitizenApp 在本机生成
随机挑战，载荷固定为 `genesis_hash(32) ‖ account_id(32) ‖ bounded "hot" ‖ challenge(32)`。
目标账户本机受保护私钥签名并回验 AccountId 后，才允许把非法持久化模式重标为 Hot；
Cold 只能由同账户重新导入且确认本机没有私钥事实。该域不提交链、不调用 Worker、不进入
CitizenWallet，也不能把任何旧值当成兼容输入。

#### 2. 链交易动作码

链交易统一使用:

```text
a = (pallet_index << 8) | call_index
```

示例:`OnchainTransaction(4).transfer_with_remark(0)` 的 `a = 0x0400 = 1024`。

| a(hex) | pallet.call | decoder action | payload 展示字段 | 签发方 |
|---|---|---|---|---|
| `0x0400` | `OnchainTransaction.transfer_with_remark` | `transfer` | `recipient_account_id`, `amount_yuan`, `remark` | citizenchain node / CitizenApp |
| `0x0700` | `PersonalManage.propose_create` | `propose_create_personal` | `account_name`, `admins(account_id + family_name + given_name)`, `admins_len`, `regular_threshold`, `create_threshold`, `amount_yuan` | CitizenApp |
| `0x0701` | `PersonalManage.propose_close` | `propose_close_personal` | `account_id`, `beneficiary_account_id` | CitizenApp |
| `0x1d00` | `PersonalAdmins.propose_admin_set_change` | `propose_personal_admin_set_change` | `institution_code`, `account_id`, `admins`, `new_threshold` | CitizenApp |
| `0x0800` | `ResolutionIssuance.propose_issuance` | `propose_issuance` | `actor_cid_number`, `proposer_role_code`, `reason`, `amount_yuan`, `allocation_count`, `eligible_total`, `province_name`, `signer_public_key` | citizenchain node / CitizenApp |
| `0x0903` | `VotingEngine.finalize_proposal` | `finalize_proposal` | `proposal_id` | citizenchain node / CitizenApp |
| `0x0904` | `VotingEngine.retry_passed_proposal` | `retry_passed_proposal` | `proposal_id` | citizenchain node / CitizenApp |
| `0x0905` | `VotingEngine.cancel_passed_proposal` | `cancel_passed_proposal` | `proposal_id`, `reason` | citizenchain node / CitizenApp |
| `0x0a00` | `CitizenIdentity.register_voting_identity` | `register_voting_identity` | `actor_cid_number`, `actor_role_code`, `cid_number`, `account_id`, `valid_range`, `citizen_status`, `residence` | OnChina |
| `0x0c00` | `RuntimeUpgrade.propose_runtime_upgrade` | `propose_runtime_upgrade` | `wasm_hash` | citizenchain node / CitizenApp |
| `0x0c02` | `RuntimeUpgrade.developer_direct_upgrade` | `developer_direct_upgrade` | `wasm_hash` | citizenchain node / CitizenApp |
| `0x0d00` | `ResolutionDestro.propose_destroy` | `propose_destroy` | `actor_cid_number`, `actor_role_code`, `proposer_role_code`, `institution_account_id`, `operation_fee_payer_description`, `execution_fee_payer_description`, `amount_yuan` | CitizenApp |
| `0x0f00` | `GrandpaKeyChange.propose_emergency_grandpa_key_recovery` | `propose_emergency_grandpa_key_recovery` | `actor_cid_number`, `actor_role_code`, `new_public_key`, `proof_nonce`, `proof_expires_at`, `new_public_key_signature` | citizenchain node |
| `0x0f01` | `GrandpaKeyChange.schedule_grandpa_key_rotation` | `schedule_grandpa_key_rotation` | `actor_cid_number`, `actor_role_code`, `new_public_key`, `proof_nonce`, `proof_expires_at`, `old_public_key_signature`, `new_public_key_signature` | citizenchain node |
| `0x1602` | `ElectionVote.cast_popular_vote` | `cast_popular_vote` | `proposal_id`, `cid_number`, `account_id` | 未来具体公权选举业务模块 / CitizenApp |
| `0x1603` | `ElectionVote.cast_mutual_vote` | `cast_mutual_vote` | `proposal_id`, `voter_role_code`, `cid_number`, `account_id` | 未来具体公权选举业务模块 / CitizenApp |
| `0x1e01` | `PublicManage.propose_close_public_institution` | `propose_close_public_institution` | `actor_cid_number`, `proposer_role_code`, `institution_account_id`, `beneficiary_account_id` | CitizenApp |
| `0x1e06` | `PublicManage.update_institution_info` | `update_public_institution_info` | `cid_number`, `cid_full_name`, `cid_short_name`, `actor_cid_number`, `actor_role_code` | OnChina（注册局登记管理） |
| `0x1e07` | `PublicManage.add_institution_account` | `add_public_institution_account` | `cid_number`, `account_names`, `account_count`, `actor_cid_number`, `actor_role_code` | OnChina（注册局登记管理） |
| `0x1e08` | `PublicManage.propose_institution_governance` | `propose_public_institution_governance` | `cid_number`, `governance_action`, `governance_detail`, `actor_cid_number`, `proposer_role_code`, `fee_payer_description` | OnChina（本机构治理） |
| `0x1e09` | `PublicManage.register_institution_admins` | `register_public_institution_admins` | `cid_number`, `admins(account_id + cid_number + family_name + given_name)`, `actor_cid_number`, `actor_role_code`, `fee_payer_description` | OnChina（注册局直接登记管理员） |
| `0x1f01` | `PrivateManage.propose_close_private_institution` | `propose_close_private_institution` | `actor_cid_number`, `proposer_role_code`, `institution_account_id`, `beneficiary_account_id` | CitizenApp |
| `0x1f06` | `PrivateManage.update_institution_info` | `update_private_institution_info` | `cid_number`, `cid_full_name`, `cid_short_name`, `actor_cid_number`, `actor_role_code` | OnChina（注册局登记管理） |
| `0x1f07` | `PrivateManage.add_institution_account` | `add_private_institution_account` | `cid_number`, `account_names`, `account_count`, `actor_cid_number`, `actor_role_code` | OnChina（注册局登记管理） |
| `0x1f08` | `PrivateManage.propose_institution_governance` | `propose_private_institution_governance` | `cid_number`, `governance_action`, `governance_detail`, `actor_cid_number`, `proposer_role_code`, `fee_payer_description` | OnChina（本机构治理） |
| `0x1f09` | `PrivateManage.register_institution_admins` | `register_private_institution_admins` | `cid_number`, `admins(account_id + family_name + given_name)`, `actor_cid_number`, `actor_role_code`, `fee_payer_description` | OnChina（注册局直接登记管理员） |
| `0x2100` | `AddressRegistry.set_catalog_version` | `set_address_catalog_version` | `actor_cid_number`, `actor_role_code`, `catalog_version`, `catalog_hash` | OnChina |
| `0x2101` | `AddressRegistry.set_address_name` | `set_address_name` | `actor_cid_number`, `actor_role_code`, `province_code`, `city_code`, `town_code`, `address_name_code`, `address_name` | OnChina |
| `0x2102` | `AddressRegistry.remove_address_name` | `remove_address_name` | `actor_cid_number`, `actor_role_code`, `province_code`, `city_code`, `town_code`, `address_name_code` | OnChina |
| `0x2103` | `AddressRegistry.set_address` | `set_address` | `actor_cid_number`, `actor_role_code`, `province_code`, `city_code`, `town_code`, `address_name_code`, `address_local_no`, `address_detail` | OnChina |
| `0x2104` | `AddressRegistry.remove_address` | `remove_address` | `actor_cid_number`, `actor_role_code`, `province_code`, `city_code`, `town_code`, `address_name_code`, `address_local_no`, `address_detail` | OnChina |
| `0x1100` | `MultisigTransfer.propose_transfer` | `propose_transfer` | `operation_fee_payer_description`, `execution_fee_payer_description`, `beneficiary_account_id`, `amount_yuan`, `remark` | citizenchain node / CitizenApp |
| `0x1101` | `MultisigTransfer.propose_safety_fund` | `propose_safety_fund_transfer` | `actor_cid_number`, `proposer_role_code`, `institution_account_id`, `operation_fee_payer_description`, `execution_fee_payer_description`, `beneficiary_account_id`, `amount_yuan`, `remark` | citizenchain node / CitizenApp |
| `0x1102` | `MultisigTransfer.propose_sweep` | `propose_sweep_to_main` | `actor_cid_number`, `proposer_role_code`, `institution_account_id`, `operation_fee_payer_description`, `execution_fee_payer_description`, `amount_yuan` | citizenchain node / CitizenApp |
| `0x2200` | `SquarePost.publish_post` | `publish_post` | `post_id`, `post_type`, `content_hash`, `storage_receipt_id` | CitizenApp |
| `0x2201` | `SquarePost.subscribe` | `subscribe` | `issuer`, `membership_level` 或 `tier_id + billing_period`, `expected_price_fen` | CitizenApp |
| `0x2202` | `SquarePost.cancel` | `cancel` | `issuer` | CitizenApp |
| `0x2203` | `SquarePost.set_creator_plans` | `set_creator_plans` | `tiers` | CitizenApp |
| `0x2204` | `SquarePost.change_subscription_plan` | `change_subscription_plan` | `issuer`, `membership_level` 或 `tier_id + billing_period`, `expected_price_fen` | CitizenApp |
| `0x2205` | `SquarePost.propose_set_platform_price` | `propose_set_platform_price` | `actor_cid_number`, `proposer_role_code`, `membership_level`, `new_price_fen` | OnChina |
| `0x2206` | `SquarePost.update_creator_tier_name` | `update_creator_tier_name` | `tier_id`, `tier_name` | CitizenApp |

永久留洞：`0x0702`、`0x0a05`、`0x1502`、`0x1a00`、`0x1e04`、`0x1e05`、`0x1f04`、`0x1f05`。
这些位置不进入 action registry，不允许 CitizenApp/CitizenWallet 构造、解码或兼容；
人口快照与拒绝终态清理都由 runtime 投票引擎内部完成。
| `0x1332` | `OffchainTransaction.register_clearing_bank` | `register_clearing_bank` | `cid_number`, `peer_id`, `rpc_domain`, `rpc_port` | citizenchain node |
| `0x1333` | `OffchainTransaction.update_clearing_bank_endpoint` | `update_clearing_bank_endpoint` | `cid_number`, `new_domain`, `new_port` | citizenchain node |
| `0x1334` | `OffchainTransaction.unregister_clearing_bank` | `unregister_clearing_bank` | `cid_number` | citizenchain node |
| `0x1400` | `InternalVote.cast` | `internal_vote` | `proposal_id`, `approve` | citizenchain node / CitizenApp |
| `0x1500` | `JointVote.cast_admin` | `joint_vote` | `proposal_id`, `approve` | citizenchain node / CitizenApp |
| `0x1501` | `JointVote.cast_referendum` | `cast_referendum` | `proposal_id`, `voter_role_code`, `approve`, `province_name`, `signer_public_key` | CitizenApp |
| `0x1602` | `ElectionVote.cast_popular_vote` | `cast_popular_vote` | `proposal_id`, `cid_number`, `account_id` | CitizenApp |
| `0x1603` | `ElectionVote.cast_mutual_vote` | `cast_mutual_vote` | `proposal_id`, `voter_role_code`, `cid_number`, `account_id` | CitizenApp |

#### 3. 扫码端展示规则

扫码端不得读取 QR 中的展示摘要。展示内容只能来自:

1. `b.a` 定位业务动作。
2. `b.d` 解码出的 payload 字段。
3. 本地 action label / field label 注册表。

上表“payload 展示字段”是内部解码键，不是 UI 文案。扫码确认页必须把字段名映射成中文标签，例如 `institution_code` 显示为“机构类型”、`amount_yuan` 显示为“金额”、`proposal_id` 显示为“提案编号”、`approve` 显示为“投票意见”。

禁止用户界面显示以下内容作为签名确认:

- `动作 <数字>`
- 英文 action key
- 英文字段 key
- 原始 hex payload
- `载荷 <N> 字节`
- `unknown` / `unsupported` / `decode failed`

如果只能显示上述内容,说明本地 action registry、decoder 或中文字段表不完整,必须红色拒绝。

必须展示给用户核对的内容:

| 字段类型 | 展示规则 |
|---|---|
| 账户/公钥可判定为 AccountId32 | 转 SS58,prefix=2027 |
| 金额 | 分转 GMB,保留 2 位 |
| `approve` | 展示“赞成/反对” |
| `remark` / `reason` / `memo` | 原字符串 |
| Runtime hash | 展示 `0x<64hex>` |
| OnChina 管理文本 | 展示动作类型、主体、公钥/账户、过期时间 |

机器校验字段如 nonce、block hash、payload hash、内部 challenge id 不作为普通确认字段展示,但可用于本地 session 校验。

#### 4. 拒签规则

任一条件成立必须红色拒签:

1. `a` 未登记。
2. `a` 与 payload 解码出的 pallet/call 或文本 domain 不一致。
3. payload 无法解码。
4. `g != 1`。
5. `u` 不是 32B 公钥。
6. `d` 为空。
7. 链 payload >256B 但扫码端未按 Substrate 规则签 `blake2_256(payload)`。
8. action 没有中文动作名。
9. decoder 输出字段缺少中文字段名。
10. 普通链交易 `d` 只有 32B hash/signing bytes,导致无法完整中文展示。

#### 5. 修改流程

1. 先改本文件和 `qr-protocol-spec.md`。
2. 创建或更新 `citizenchain/crates/qr-protocol/registry/*` 唯一代码真源。
3. 从唯一真源生成或校验 Dart/TS/Rust 的 action 常量、body 结构校验器、中文标签、字段标签和 decoder 映射；生成器入口为 `cargo run -p qr-protocol --bin export_registry --`，动作表使用 `--dart`，body 校验器分别使用 `--dart-bodies`、`--ts-bodies`、`--rust-bodies`。
4. 同步 `PayloadDecoder` 和签发方 `review_payload/signing_bytes` 构造。
5. 补跨端 fixture 和真实扫码签名测试。
6. 如需修改 `citizenchain/runtime/` 或 `citizenchain/runtime/primitives/src/sign.rs`,必须按 runtime 二次确认硬规则单独确认后再执行。

#### 6. 移动端生成产物边界

当前移动端已按 registry 生成产物接入签名入口的中文动作名、字段名和拒签规则:

- 生成源:`citizenchain/crates/qr-protocol/registry/actions.yaml`、`fields.yaml`、`kinds.yaml`、`reject_reasons.yaml`。
- 生成器:`citizenchain/crates/qr-protocol/src/export_registry.rs`。
- CitizenApp：经 `citizen_sdk.dart` 导出的 `CitizenQr` 与 `CitizenQrActions` 消费公共合同；宿主不保留 QR 生成表。
- CitizenWallet 产物:`citizenwallet/lib/qr/generated/qr_action_registry.g.dart`。
- 跨端 body 产物：CitizenWallet 的 `qr_bodies.g.dart`、Node / OnChina 的 `qrBodies.g.ts`，以及 OnChina Rust 的 `core/qr/generated.rs`；CitizenApp 经 SDK 解析。
- CitizenWallet 消费点:`citizenwallet/lib/signer/action_labels.dart`、`field_labels.dart`、`payload_decoder.dart`、`citizenwallet/lib/qr/qr_protocols.dart`。
- CitizenApp 消费点:`citizenapp/lib/qr/qr_protocols.dart`、`signer/square_action_payload.dart`。
- OnChina 非链动作码消费点:`citizenchain/onchina/src/core/qr/mod.rs` 通过 `qr-protocol` 读取 `login`、`citizen_identity`、`onchina_admin_action`，不得恢复 `ACTION_LOGIN = 1` 等硬编码常量。

生成文件只是移动端产物,不是第二真源。新增或调整 action 时必须先改
`citizenchain/crates/qr-protocol/registry/actions.yaml` / `fields.yaml` / `kinds.yaml`,再重新生成对应产物并补测试。`qr-protocol` 的生成物一致性测试会校验五份 body 校验产物没有漂移。

#### 7. 防漂移 guard

`citizenchain/crates/qr-protocol/tests/repo_guard.rs` 是全仓 QR 签名协议防漂移护栏。它随
`cargo test --manifest-path citizenchain/crates/qr-protocol/Cargo.toml` 执行,扫描 CitizenApp、CitizenWallet、OnChina、node 和 `citizenchain/crates` 下的代码目录,禁止恢复:

- 移动端手写 action 中文表、action code 反查表、字段中文表。
- OnChina 非链 QR action code `1/2/3` 硬编码常量。
- 移动端手写 Runtime hash-only action 列表。
- 离线签名第三状态或可签名警告态。
- `动作 <数字>`、`载荷 N 字节` 等签名确认兜底展示。

新增扫码签名功能时,正确顺序固定为:先改 registry → 生成两端产物 → 补 decoder/签发方 → 跑 `qr-protocol` 测试。任何绕过 registry 的端侧手写分支都应被 guard 拦下。

---

### QR_V1 统一二维码协议规范

- 版本:`QR_V1`
- 更新日期:2026-08-08
- 状态:当前详细事实源,由 `../citizenwallet/CitizenWallet.md` 统一管辖
- 范围:全仓库所有“生成二维码 -> 扫码识别 -> 签名/确认 -> 签名响应验签”的二维码流程

#### 1. 设计铁律

1. 唯一协议字符串:`QR_V1`。不得恢复历史协议名、登录专用 QR kind 或任何第二套扫码协议名。
2. 唯一 envelope 字段:`p/k/i/e/b`。不得恢复 `proto/kind/id/issued_at/expires_at/body` 作为线上 QR 字段。
3. 唯一签名请求字段:`a/g/u/d`。业务场景放在 `a`,扫码流向放在 `k`。
4. 唯一签名响应字段:`u/s`。签名响应不携带 payload、payload hash、签名时间或展示字段。
5. 唯一验签真源:生成方按 `i` 找回本地 session 中的 action、payload、`signer_public_key` 和过期时间后验签。
6. 唯一展示真源:扫码端必须由 `a + d(review_payload)` 本地解码展示;QR 不携带 `display`、`summary`、`fields`。
7. 固定码不出现时效字段:`i/e` 直接不存在,不是 `null`、`0` 或空串。
8. 不兼容旧字段。解析器遇到旧字段、别名字段、未知字段必须报错。
9. 签名判定只有两种结果:`Normal/正常` 或 `Reject/拒绝`。不得引入未知、警告、部分识别、可忽略等第三状态。
10. 用户可见确认内容必须全部来自本地中文 action registry 和 payload decoder;动作名、字段名或枚举值缺少中文翻译时必须红色拒绝。
11. 扫码输入只接受严格 `QR_V1` envelope；裸 SS58、旧 account scheme 与其它文本不得作为二维码解析。
12. 统一设备层只返回扫码原文，具体业务入口决定允许的 `k`：地址框接受用户码与账户码，通讯录只接受用户码，错误码型必须给出当前入口的明确反馈。

#### 2. 顶层 Envelope

```jsonc
{
  "p": "QR_V1",
  "k": 1,
  "i": "req_01HXYZ4VQK8NRPM2G7FJD9TBC3",
  "e": 1780000000,
  "b": {}
}
```

| 字段 | 类型 | 必填 | 注释 |
|---|---|---|---|
| `p` | string | 是 | 协议版本,恒为 `QR_V1` |
| `k` | int | 是 | 扫码流向码,见第 3 节 |
| `i` | string | 临时码必填 | request/session id,16-128 字符,允许 `[A-Za-z0-9_-]` |
| `e` | int | 临时码必填 | 过期 unix 秒;固定码不出现 |
| `b` | object | 是 | body,字段由 `k` 决定 |

顶层字段只允许 `p/k/i/e/b`。临时码必须有 `i/e`;固定码禁止有 `i/e`。

#### 3. k 扫码流向码

| k | 名称 | 类型 | 生成方 | 扫码方 | 注释 |
|---:|---|---|---|---|---|
| 1 | `sign_request` | 临时 | CitizenApp / CitizenWallet / CID / citizenchain node | 签名方 | 请求扫码方签名 `b.d` |
| 2 | `sign_response` | 临时 | 签名方 | 请求生成方 | 回传签名结果 |
| 3 | `user_contact` | 固定 | CitizenApp 已绑定 CID 的身份账户 | CitizenApp / CitizenWallet / OnChina | **用户码**:只声明永久 CID 与当前绑定账户，不携带昵称 |
| 4 | `user_transfer` | 临时 | 仅 CitizenApp | 付款方 | **收款码**:一笔收款请求,可带金额和备注 |
| 5 | `account_id_code` | 固定 | CitizenApp / CitizenWallet 任意账户 | CitizenApp / OnChina / citizenchain node | **账户码**:只声明账户,不含任何身份字段 |

展示型二维码按「谁生成 + 表达什么」三分。生成入口固定；扫描后的允许码型与业务动作由当前扫码入口判断，协议层不得代替页面导航或执行业务：

| 码 | 表达 | `k` | 生成端 | 唯一入口 |
|---|---|---:|---|---|
| 用户码 | 人(永久 CID) | 3 | 仅 CitizenApp,且 CID↔AccountId 闭环命中 | 用户主页 |
| 账户码 | 账户 | 5 | CitizenApp + CitizenWallet,任意账户无条件 | 钱包-账户详情 |
| 收款码 | 一笔收款请求 | 4 | 仅 CitizenApp | 聊天-加号-收付款 |

「是否带时效字段」由「生成端是否联网」推导:账户码必须离线端也能出,因此固定;收款码只在联网端生成,因此允许 `i/e`。离线设备无 NTP,不得签发带绝对时间戳的凭证。

登录、公民签名确认、管理员确认、交易签名、运行时升级等都不新增 `k`;它们统一是 `k=1` 签名请求,具体业务由 `b.a` 区分。

`k=5` 曾用于已废止的 `chat_node_pairing`(桌面通信节点配对)。该流程整体取消后码值回收给账户码,规格见第 8 节。不得恢复桌面区块链软件通信节点配对流程;旧字段 `node_peer_id`、`node_multiaddr`、`endpoint_kind` 不属于当前 QR_V1 可解析 body,携带它们的旧码会因 body 字段集不匹配被拒绝。

#### 4. k=1 sign_request

```jsonc
{
  "p": "QR_V1",
  "k": 1,
  "i": "req_01HXYZ4VQK8NRPM2G7FJD9TBC3",
  "e": 1780000000,
  "b": {
    "a": 515,
    "g": 1,
    "u": "1DWTxxX90xxhFBq9BKmf1oIshViFTM3jmlaE56Vton0",
    "d": "AgMA1DWTxxX90xxhFBq9BKmf1oIshViFTM3jmlaE56Vton1BnA"
  }
}
```

| 字段 | 类型 | 必填 | 注释 |
|---|---|---|---|
| `a` | int | 是 | 业务动作码,见 `qr-action-registry.md` |
| `g` | int | 是 | 签名算法码,当前只允许 `1 = sr25519` |
| `u` | string | 是 | 压缩传输键；内部唯一语义名为 `signer_public_key`，通常是期望签名者 32 字节公钥的 base64url 无填充编码；仅 `citizen_occupy/citizen_rebind` 必须为空字符串，由钱包在 `d` 的账户零槽原位填入所选账户 |
| `d` | string | 是 | `review_payload` 原始字节,base64url 无填充;除 Runtime 升级 hash-only 外,必须可被扫码端完整解码和中文展示 |

`review_payload` 与签名字节必须分离:

| 名称 | 含义 | 规则 |
|---|---|---|
| `review_payload` | QR `b.d` 携带、给用户审阅和中文展示的完整载荷 | 普通交易必须完整可解码;不得用 32B hash 冒充 |
| `signing_bytes` | 钱包实际交给 sr25519 签名的字节 | 由扫码端根据 action 和 `review_payload` 本地计算 |

签名字节规则:

| 场景 | `a` 规则 | 签名字节 |
|---|---|---|
| 普通链交易 | `a = (pallet_index << 8) | call_index` | `d` 必须是生成方用当前 runtime 类型构造的完整 `SignedPayload` 原始三元组 SCALE 字节;长度 ≤256B 签原文,>256B 签 `blake2_256(review_payload)` |
| 登录 | `a = 1` | 签 payload 原文 |
| 公民链上身份确认 | `a = 2` | `d` 必须是 `VotingIdentityPayload` SCALE bytes,签 `blake2_256(GMB || 0x10 || d)` |
| 注册局首次绑定 | `a = 10 citizen_occupy` | `d = genesis_hash + bounded cid + 32B 零 account_id 槽 + revision=0(u64 LE) + expires_at(u64 LE)`；钱包严格解码且确认无尾字节后原位填入账户，签 `blake2_256(GMB || 0x12 || 完整授权)` |
| 注册局换绑 | `a = 11 citizen_rebind` | `d = genesis_hash + bounded cid + current_account_id + 32B 零 new_account_id 槽 + nonzero revision(u64 LE) + expires_at(u64 LE)`；钱包拒绝当前账户与新账户相同，原位填入新账户后签 `blake2_256(GMB || 0x1f || 完整授权)` |
| 本机默认账户切换 | `a = 12 switch_default_account` | `d = genesis_hash(32) + current_default_account_id(32) + Vec<AccountId> + expires_at(u64 LE) + nonce(16)`；完整排列必须无重复、第一项必须变化，且 `b.u == current_default_account_id`、外层 `e == expires_at`；签 `blake2_256(GMB || 0x21 || d)` |
| MLS设备登记 | a=13 mls_device_bind | 当前绑定账户授权同一32字节public_key，签名域0x1C，SCALE顺序遵守实际编码接口；外层期限与issued_at一致 |
| OnChina 管理员治理文本载荷 | `a = 3` | `d` 是 `onchina_admin_governance` canonical JSON 的 UTF-8 字节,签 `blake2_256(GMB || 0x20 || d)` |
| 管理员激活 / 解密 | `a = 5/6` | 签二进制 payload 原文 |
| Runtime 升级哈希签名 | `a = 7` 或已登记 RuntimeUpgrade hash-only action | `d` 允许是 32B signing bytes,签该 32B;这是 QR_V1 唯一 hash-only 例外 |

`citizen_occupy/citizen_rebind` 的外层 `e` 必须与内层 `expires_at` 完全相等。账户零槽
非零、CID 非规范 SCALE、revision 不符合上述约束、载荷截断或存在尾字节时，CitizenApp
与 CitizenWallet 都必须拒签；不得恢复旧版 `bounded_cid ++ account_id` 末尾拼接。

`switch_default_account` 只证明变化前的原默认账户授权 CitizenApp 本机完整目标顺序；
它不包含 `cid_number`、`binding_revision` 或换绑字段，不得提交 pallet、Storage、
Extrinsic，不得调用 Worker 或任何 CID 换绑入口。CitizenWallet 只有在外层 `a=12`
已经明确时才按该无 pallet 前缀布局解码，禁止仅凭长度猜测并误识别链交易。

OnChina 登录生成 `a=1` 前必须先扫描 `k=5 account_id_code` 账户码，取 `b.n`
作为唯一目标账户，再按 `account_id → CidByAccountId → CidRegistry Active →
管理员记录 Active` 单向反查确认其为在职管理员；三级中任一不成立必须拒绝登录，不得
「读不到就放行」。管理员私钥保管在离线的 CitizenWallet，登录第 1 步必须由
CitizenWallet 自己出示账户码即可完成，不得要求联网热钱包参与——否则管理员只能在
「私钥落到联网设备」与「无法登录」之间二选一。

二维码不携带 CID 与昵称:CID 由链上 `CidByAccountId` 反查得到，管理员姓名由链上
记录读出，两者都比二维码自述更可靠，且「两字段互不匹配」这类攻击形态从根上不存在。

随后 `k=1` 请求的 `b.u` 必须编码该账户的 32 字节公钥，`b.d` 固定为 UTF-8
`onchina`；不得生成空 `b.u`，不得允许扫码钱包自行选择其它账户。登录响应仍使用
`k=2`，其 `b.u` 必须与请求目标和数据库目标账户一致。

链交易生成方不得手写拼接 `call_data/era/nonce/tip/additional_signed` 或 signed extrinsic。citizenchain node、CitizenApp 热钱包、OnChina 和其它链交易生成方必须统一使用当前 runtime 类型构造 `TxExtension`、`SignedPayload` 和 `UncheckedExtrinsic`；QR `b.d` 放入完整 `review_payload`，实际签名输入单独按 `SignedPayload::using_encoded` 计算。

普通链交易若 `b.d` 只有 32 字节且不能按 action registry 解码为完整业务 payload,扫码端必须红色拒绝,不得展示“载荷 32 字节”后继续签名。

#### 5. k=2 sign_response

```jsonc
{
  "p": "QR_V1",
  "k": 2,
  "i": "req_01HXYZ4VQK8NRPM2G7FJD9TBC3",
  "e": 1780000000,
  "b": {
    "u": "1DWTxxX90xxhFBq9BKmf1oIshViFTM3jmlaE56Vton0",
    "s": "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg"
  }
}
```

| 字段 | 类型 | 必填 | 注释 |
|---|---|---|---|
| `u` | string | 是 | 压缩传输键；内部唯一语义名为 `signer_public_key`，值是实际签名者 32 字节公钥的 base64url 无填充编码 |
| `s` | string | 是 | 64 字节 sr25519 签名,base64url 无填充 |

生成方验签必须使用本地 session:

1. `p == QR_V1`
2. `k == 2`
3. `i == 本地请求 id`
4. `e` 未过期
5. `b.u == 本地 expected signer_public_key`
6. 按本地 session 重新计算 payload hash,必须等于生成请求时保存的 `expected_payload_hash`
7. 按本地 session 的 `a + payload` 计算签名字节后验证 `b.s`

同一业务操作只允许一次密钥签名。扫码端进入签名中状态后必须阻止重复触发；生成出首个 `k=2` 响应二维码后不得对同一 `i` 再次调用密钥或生成第二个响应。需要重试时必须由发起方创建新的请求 id，而不是在原请求上追加确认签名。

#### 6. k=3 user_contact(用户码)

固定码,不带 `i/e`。语义 = 「这是**谁**」。

```jsonc
{
  "p": "QR_V1",
  "k": 3,
  "b": {
    "c": "CN001-CTZN-000000001-2026",
    "n": "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"
  }
}
```

| 键 | 含义 | 类型 | 必填 | 注释 |
|---|---|---|---|---|
| `c` | cid_number | string | 是 | 永久公民身份号；无首尾空格，UTF-8 长度 1–32 字节 |
| `n` | account_id | string | 是 | 当前 CID 绑定账户；小写 `0x` 加 64 位十六进制，走 `isAccountIdText` 单源校验 |

**不含昵称**:本机昵称可随意改写、无任何链上或服务端约束,一旦进码就会被扫码端
当成对方公开身份显示,是冒名风险。真实公开昵称由扫码端按 `c` 从资料接口拉取。

**不含 SS58**:SS58 只是给人看的展示形态,机器一律用 `account_id`;展示用 SS58 由
扫码端从 `n` 自行派生。

用户码只能由 CitizenApp 在链上 CID↔AccountId 闭环命中的身份账户生成，唯一入口是
用户主页；链读失败从严拒绝生成，不得降级成其它码。未注册账户与其它钱包子账户
不出用户码——它们在钱包-账户详情出 `k=5` 账户码。CitizenWallet 是离线钱包，没有
CID 真源，永远只解析 `k=3`、不生成。解析器必须拒绝缺失字段、未知字段、
非规范 CID 与非规范 `account_id`。

用户码是唯一能写入通讯录的码：通讯录关系必须锚永久 CID，不能锚会换绑的账户。
账户码与收款码进通讯录必须拒绝。入库前必须拿 `n` 经链上双向绑定重新解析,
解析出的 CID 与 `c` 完全一致才允许写入。

#### 7. k=4 user_transfer(收款码)

临时码,带 `i/e`。唯一入口是 CitizenApp 聊天-加号-收付款,唯一生成端是 CitizenApp
(联网,时钟可信)。CitizenWallet 永远不生成、不解析收款码。

**当前状态:预留,生成方待实现。** 落地任务卡
`历史实施记录《二维码三码分类用户码钱包码收款码》（卡已删除，规范以本文为准）`。零生成方是已规划
未实现,不是残桩,清扫审计不得删除。生成方落地时必须同批补两件事:金额/备注输入
UI(否则 `v` 恒为空串,该码与账户码无差别),以及扫码侧 `e` 过期即拒绝(当前全仓
`e` 的校验只有签名请求/响应一处,收款码路径无校验)。

```jsonc
{
  "p": "QR_V1",
  "k": 4,
  "i": "pay_01HXYZ4VQK8NRPM2G7FJD9TBC3",
  "e": 1780000000,
  "b": {
    "n": "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    "v": "100.50",
    "t": "GMB",
    "m": "房租",
    "l": "CN001-SFGF-000000001-2026"
  }
}
```

| 键 | 含义 | 类型 | 必填 | 注释 |
|---|---|---|---|---|
| `n` | account_id | string | 是 | 收款账户；小写 `0x` 加 64 位十六进制 |
| `v` | 金额 | string | 是 | 字符串避免浮点精度 |
| `t` | 币种 | string | 是 | 当前 `GMB` |
| `m` | 备注 | string | 是 | 允许空串 |
| `l` | 清算行 CID | string | 是 | 收款方绑定的清算行 `cid_number`,离线支付提交必需 |

**不含收款人姓名**:本机可随意填写,付款方看到的姓名完全由出码方控制,是冒名风险;
真实身份由付款方按链上/服务端数据自行核对。**不含 `cid_number`**(用户决策)。

#### 8. k=5 account_id_code(账户码)

固定码,不带 `i/e`。语义 = 「这是**哪个账户**」。

**钱包没有码,账户才有码** —— 一个钱包由多个账户组成,二维码描述的始终是其中
某一个账户。冷热两端都能生成。

```jsonc
{
  "p": "QR_V1",
  "k": 5,
  "b": {
    "n": "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"
  }
}
```

| 键 | 含义 | 类型 | 必填 | 注释 |
|---|---|---|---|---|
| `n` | account_id | string | 是 | 账户唯一标识；小写 `0x` 加 64 位十六进制，即 sr25519 公钥原字节 |

**不得携带账户名、昵称、CID、SS58 或任何时效字段**:本机账户标签可随意改写,
进码即被扫码端当成对方公开身份显示。展示用 SS58 由扫码端从 `n` 自行派生。

body 只有 `account_id` 一个字段。**不得**携带钱包账户名、公开昵称、CID、SS58 或
任何时效字段：本机钱包标签用户可随意改写、无任何链上或服务端约束，一旦进入二维码
就会被扫码端当成对方公开身份显示。展示用 SS58(prefix 2027)由扫码端从 `account_id`
自行派生。

生成端为 CitizenApp 与 CitizenWallet 的钱包-账户详情，任意账户无条件生成,包括
CID 已绑定的身份账户——账户详情表达的是「账户」，身份由用户主页的用户码表达。

全部码型的账户标识统一为 `n`(`account_id`),不再有 SS58 与 account_id 两套口径:
SS58 只是给人看的展示形态,机器一律用 `account_id`,展示用 SS58 由扫码端自行派生。
这也免掉了每个扫码端一次 decode 与 prefix 校验。

账户码的合法用途只有三类:按账户转账、OnChina 管理员登录第 1 步、OnChina 与
citizenchain node 前端的「扫码识别账户」。**写入通讯录必须拒绝**(无 CID 真源)。

`k=5` 是回收码值:旧 `chat_node_pairing` 已随桌面通信节点配对流程整体废止,其
`node_peer_id`、`node_multiaddr`、`endpoint_kind` 三字段不属于当前 QR_V1 可解析 body。
无需为旧码写专门的拒绝逻辑——顶层字段集精确匹配(`p/k/b`)之后,body 字段集精确匹配
会拒掉它。

#### 9. 签名原文拼接

只有系统对 QR envelope 元信息签名时使用该函数。普通交易签名响应不签 envelope,只签请求 payload。

```
QR_V1|<k>|<i>|<system 或空>|<e 或 0>|<principal>
```

| 字段 | 注释 |
|---|---|
| `k` | 数字扫码流向码 |
| `i` | 请求 id |
| `system` | `onchina` / 空串；`onchina` 是链上中国平台登录签名 payload 常量 |
| `e` | 过期 unix 秒;无则为 `0` |
| `principal` | 去掉 `0x` 的小写 hex 公钥 |

#### 10. Fixture 契约

当前 fixture:

```text
citizenchain/crates/qr-protocol/tests/fixtures/sign_request.json
citizenchain/crates/qr-protocol/tests/fixtures/sign_response.json
citizenchain/crates/qr-protocol/tests/fixtures/user_contact.json
citizenchain/crates/qr-protocol/tests/fixtures/user_transfer.json
```

不得新增登录专用 fixture。登录统一复用 `sign_request.json` / `sign_response.json`,业务含义由 `b.a=1` 表达。

#### 11. 修改流程

1. 先改本文件和 `qr-action-registry.md`。
2. 同步 fixtures。
3. 同步 Rust / TS / Dart 的解析、生成、验签入口。
4. 跑真实扫码签名链路或对应端到端测试。
5. 更新任务卡和模块文档。

#### 12. Action registry 代码真源

当前唯一代码真源:

```text
citizenchain/crates/qr-protocol/registry/actions.yaml
citizenchain/crates/qr-protocol/registry/fields.yaml
citizenchain/crates/qr-protocol/registry/kinds.yaml
citizenchain/crates/qr-protocol/registry/reject_reasons.yaml
```

`kinds.yaml` 是全部 `QrKind`、码值、临时/固定属性、envelope/body 字段、必选/可选关系、长度与文本约束的唯一结构真源；生成器输出 CitizenApp、CitizenWallet、Node、OnChina 前端与 OnChina Rust 接线文件。`../citizenwallet/CitizenWallet.md` 是人类可读登记表和审查入口;代码、测试、生成和跨端校验必须以 `citizenchain/crates/qr-protocol/registry/*` 为准。各端不得再手写第二套码型枚举、action 常量、body 字段集合、中文标签、字段标签或签名判定分支。

当前生成产物：

```text

citizenwallet/lib/qr/generated/qr_bodies.g.dart
citizenchain/node/frontend/shared/qr/qrBodies.g.ts
citizenchain/onchina/frontend/core/qrBodies.g.ts
citizenchain/onchina/src/core/qr/generated.rs
```

##### 12.1 载荷字段编解码代码真源(2026-07-30 收归)

QR body 里的定长字段(公钥 `b.u` 32 字节、签名 `b.s` 64 字节)统一用 base64url(no padding)
承载,进入 Rust 侧后一律转成 ADR-040 规范文本(小写 `0x` + 十六进制)。host 侧唯一实现:

```text
citizenchain/crates/qr-protocol/src/codec.rs
  b64_to_prefixed_hex(value, expected_len, field)  # 解码 + 长度校验
  bytes_to_b64(bytes)                              # 编码
  public_key_b64(bytes, field)                     # 32 字节公钥编码(长度不符即拒)
  PUBLIC_KEY_BYTES = 32 / SIGNATURE_BYTES = 64
```

`node/src/governance/signing.rs` 与 `onchina/src/core/qr/mod.rs` 原各有一份自写实现
(行为相同但错误类型与文案不同),已于创世前审计收归到上面这一份,两侧只保留
错误类型映射。**禁止再各自实现**:两份解码一旦在长度校验或大小写上出现分毫差异,
同一个二维码就会在一端通过、另一端拒绝。

当前已知散落实现只允许作为待收归对象,不得继续作为协议真源:

- `citizenapp/lib/qr/*`
- `citizenwallet/lib/qr/*`
- `citizenchain/onchina/src/core/qr/*`
- `citizenchain/node/src/governance/signing.rs`
- `citizenchain/node/frontend/shared/qr/citizenQr.ts`

---

### QR_V1 扫码签名两色识别方案

- 更新日期:2026-08-08
- 状态:当前详细事实源,由 `../citizenwallet/CitizenWallet.md` 统一管辖
- 范围:CitizenWallet / CitizenApp 扫描 QR 后的识别、展示、签名放行和签名响应验签规则
- 依赖:
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenwallet/CitizenWallet.md`

#### 1. 两色终态

| 颜色 | 含义 | 行为 |
|---|---|---|
| 绿色 | QR 结构合法,action 已登记,`review_payload` 可独立解码,动作/字段/枚举值已完整中文翻译,签名者匹配 | 允许签名或提交 |
| 红色 | 任一校验、解码、匹配或中文翻译失败 | 禁止签名或提交 |

扫码端不得因为 QR 里有文字摘要而放行。QR_V1 不携带摘要;所有展示内容必须由本地 decoder 从 `a + d` 推导。

签名判定只有 `Normal/正常` 与 `Reject/拒绝` 两种结果。不得出现未知、警告、部分识别、可忽略、继续确认等第三状态。红色拒绝状态不得显示可触发签名的按钮或入口。

#### 2. k=1 签名请求校验

进入签名页前必须全部通过:

1. `p == QR_V1`
2. `k == 1`
3. `i` 合法且未过期
4. `b.a` 是已登记动作码
5. `b.g == 1`
6. `b.u` 解码为 32 字节公钥；仅已登记的 `citizen_occupy/citizen_rebind` 必须为空，
   由钱包选择账户并填入 `b.d` 的 32 字节零槽
7. `b.d` 解码为非空 `review_payload`
8. 普通动作要求当前钱包 `account_id` 等于规范化后的 `b.u`；当前 sr25519
   `AccountId32` 直接取签名公钥 32 字节。占号/换绑则要求完整模板严格解码、外层
   `e == expires_at`，并禁止换绑当前账户与新账户相同

业务识别:

签名字节:

#### 3. k=2 签名响应校验

生成方收到签名响应后必须从本地 session 取回原请求,不得信任签名响应携带的业务信息。

1. `p == QR_V1`
2. `k == 2`
3. `i == session.request_id`
4. `e` 未过期
5. `b.u == session.expected_signer_public_key`
6. `b.s` 解码为 64 字节
7. 生成方用本地 session 重新计算 `review_payload` hash,必须等于 session.expected_payload_hash
8. 按 session 的 `a + review_payload` 计算签名字节后 sr25519 验签通过

CitizenWallet 对同一已扫描请求只允许调用一次钱包密钥：签名进行中时忽略重复点击，首个响应二维码生成后彻底禁用再次签名。同一业务操作不叠加“字段确认签名”“周期确认签名”或其它第二签名。

签名响应中不得出现 payload、payload hash、签名时间、摘要字段。若出现旧字段,解析器应报错。

citizenchain node 的链交易冷签路径和热钱包路径必须统一调用 `citizenchain/crates/chain-signing` 构造 runtime `TxExtension`、`SignedPayload`、`UncheckedExtrinsic`。普通链交易 QR 只放完整 `review_payload`，实际签名字节由同一真源按 Substrate `using_encoded` 规则计算。任何模块手写拼接 SCALE 字节都属于第二真源,会导致扫码端绿签但链端 `BadProof`。

#### 4. 登录签名

登录不再有独立 QR kind。OnChina 必须先扫描管理员完整的
`k=3 user_contact` 用户码，校验 `b.cid_number / b.ss58_address /
b.display_name` 三字段并由地址确定唯一目标 `account_id`；随后要求二维码 CID 与
AccountId 同时命中链上同一条 Active 管理员记录，再生成 `k=1,a=1`。
`display_name` 只用于登录页展示，不参与授权：

| 字段 | 规则 |
|---|---|
| `b.u` | 用户码确定的目标账户 32 字节公钥；禁止为空、禁止由扫码钱包任选 |
| `b.d` | UTF-8 `onchina` |
| 用户签名 | CitizenWallet 必须先确认当前钱包 `account_id` 等于规范化后的 `b.u`，再签固定登录签名原文 |
| 签名响应 | `k=2` 的 `u/s` |

登录签名原文使用
`QR_V1|2|i|onchina|e|target_signer_public_key_without_0x`。OnChina 完成接口必须同时校验
响应 `b.u`、请求数据库中的目标 `account_id` 和实际验签公钥完全一致；失败不得消费挑战。

#### 5. OnChina 非链载荷

| action | domain / 前缀 | 必须展示 |
|---:|---|---|
| 2 | `VotingIdentityPayload` SCALE bytes | 身份CID、钱包地址、年龄、有效期、公民状态、居住地 |
| 3 | `onchina_admin_governance`（哈希域 `OP_SIGN_ONCHINA_ADMIN=0x20`） | 动作类型、注册局、省份、操作者/目标账户 |

文本载荷内部的 `payload_hash` 只用于生成方本地 session 或 API 防重放,不进入 QR 签名响应。

#### 7. 应红色拒绝

1. 旧协议名或旧字段名。
2. 未登记 `k` 或 `a`。
3. 过期请求。
4. 当前钱包 `account_id` 与规范化后的 `b.u` 不一致。
5. `a` 与 payload 解码出的动作不一致。
6. payload 无法解码。
7. action、字段或枚举值缺少中文翻译。
8. 普通交易 QR 只携带 32B hash/signing bytes,导致扫码端无法完整中文展示。
9. 链 payload >256B 却签原文而不是 `blake2_256(payload)`。
10. UI 只能显示动作数字、英文 action key、原始 hex 或“载荷 N 字节”。
11. 生成方重算的 session payload hash 与请求保存值不一致。
12. 签名响应签名校验失败。

#### 8. 已拒绝方案

1. QR 内携带 `display` 摘要。会导致第二真源和伪造摘要风险,已删除。
2. 登录独立 kind。会增加协议分支,已统一为 `k=1,a=1`。
3. 旧协议兼容解析。会让同一扫码链路出现两套真源,禁止恢复。
4. 黄色/警告/未知但允许签名。会形成第三状态,禁止恢复。

#### 0.0 账户标识目标契约（ADR-040，2026-07-22）

本节冻结全仓账户标识的最终命名和文本编码。任务卡 `历史实施记录《账户官方统一》（卡已删除，规范以本文为准）` 按步骤完成代码、协议和文档收口；现行契约只允许本节定义的 `AccountId`、`account_id`、角色化账户字段、`public_key` 与 `ss58_address`，不得把历史同义字段重新用于实现、接口、注释或文档。

- runtime 账户类型统一为 `AccountId`；单一账户字段统一为 `account_id`。
- 同一结构存在多个业务角色账户时统一为 `<role>_account_id`，例如 `actor_account_id`、`voter_account_id`、`payer_account_id`、`beneficiary_account_id`；这些字段只表达签名、付款、收款或不可变交易事实，不得用作 CID 用户身份主键。
- 签名公钥统一为 `public_key`；当前签名者公钥为 `signer_public_key`；凭证签名者公钥为 `credential_signer_public_key`。
- SS58 字段统一为 `ss58_address`，只用于展示和边界输入输出；授权、索引、存储主键和缓存 key 必须使用账户字节对应的 `account_id`。
- `account_id` 和 32 字节公钥的跨端文本编码唯一为小写 `0x` 加 64 位十六进制，校验式为 `^0x[0-9a-f]{64}$`。
- 验签先由 `signer_public_key` 得到 `signer_account_id`，再与业务要求的 `account_id` 或 `<role>_account_id` 比较；不得直接按 SS58 文本授权。
- 机构岗位权限仍为 `cid_number + role_code + account_id`，公民身份仍为 `cid_number + account_id`；账户命名统一不得改变 CID、岗位和签名职责边界。
- 纯命名重构不得改变账户字节、SCALE 顺序、签名 payload、哈希材料、CID 生成结果或助记词派生。若实现发现必须改变任一协议字节，必须停止并单独确认。
- 命名约定不授权删除链上状态、当前钱包或安全材料；助记词、seed、私钥、Keychain/Keystore 和 Secret 不属于可清理的业务数据。

#### 0.1 机构、岗位、权限与管理员目标契约（ADR-039，2026-07-19）

本节冻结 ADR-039 目标协议。共享类型、entity 岗位/权限/任职/动态岗位生命周期、创世固定权限，以及内部、联合、选举、立法四类投票引擎的岗位快照和席位票据均已落地。现有正式治理、发行、转账和立法入口已按岗位授权执法；旧“admins 即授权、机构投票快照全体 admins”实现不构成兼容路径。

- 机构法定代表人任免生效后，`InstitutionInfo` 必须公开原子结构 `legal_representative: Option<{ family_name, given_name, cid_number, account }>`；创世时没有真实任免资料的机构保持 `None`，不得伪造法定代表人或回退到 `admins[0]`。
- 所有机构管理员集合 `admins` 统一使用 `Admin { account_id, cid_number, family_name, given_name }`；公权、私权不得再建立不同字段布局。`cid_number` 是管理员本人公民 CID 引用，公民身份与账户绑定继续以 `citizen-identity` 为唯一真源。管理员集合只是可任职人员名册，账户本身没有机构业务权限；个人多签虽复用同一 SCALE 结构，但不属于机构管理员，其公民 CID 和姓名是否必填按个人多签规则处理。
- 机构授权主体固定为 `RoleSubject { cid_number, role_code }`。管理员只有同时属于该机构 admins 且对该主体存在有效任职，才能使用该岗位权限。
- CID 决定机构顶层业务能力；岗位权限由强类型 `RoleBusinessPermission(RoleSubject, BusinessActionId, operation)` 表达，`operation` 至少区分 `Propose` 与 `Vote`。不得建立泛化字符串权限表，也不得按管理员账户授权。
- 机构岗位 `InstitutionRole`、岗位权限、`InstitutionRoleNonce`、永久 `UsedRoleCodes` 与任职归 entity；业务动作、指定投票引擎、VotePlan 和通过后执行归对应业务模块。
- 机构管理员任职 `InstitutionAdminAssignment` 归 entity，字段为 `cid_number`、`account_id`、`role_code`、`term_start`、`term_end`、`assignment_source`、`assignment_source_ref`、`assignment_status`。
- `assignment_source` 只允许 `Genesis`、`Registry`、`PopularElection`、`MutualElection`、`NominationAppointment`、`InstitutionGovernance`；由创世、注册局、对应投票/选举引擎结果或本机构内部治理结果写入。本机构内部治理 call 只能写 `InstitutionGovernance` 来源，不能伪装成普选、互选或任命结果。
- 所有已完成业务统一通过 `InstitutionGovernanceResult` 交给 entity；一个结果可同时包含动态岗位定义变化、多个岗位的完整目标任职集合，以及可选的法定代表人原子结构整体设置或清空。
- 每条目标任职独立保存管理员钱包、`term_start`、`term_end`、`assignment_source`、`assignment_source_ref` 和状态；未出现在结果中的岗位保持不变，出现的岗位整体替换目标任职集合。
- `term_start`、`term_end` 统一为自纪元起 `u32` 天；entity 校验任职账户属于既有 admins 后，只提交岗位、任职和法定代表人，绝不反向生成或覆盖管理员集合。
- 每个机构默认且唯一存在 `LR / 法定代表人` 岗位；允许空缺，不得从管理员首位推导法定代表人，岗位码和岗位名永久不可修改或删除。
- 全部创世固定岗位的岗位码、岗位名和岗位权限永久固定，包括公民链技术发展基金会的 `LR`、`GENESIS_PRODUCT_MANAGER`、`GENESIS_PROGRAMMER`。创世机构仍可增加普通动态岗位；NodeGuard 不得以“出现额外岗位”为由拒绝。
- 动态 `role_code` 由 runtime 生成，格式固定为 `R_<32 位大写十六进制>`。生成规则为取 `blake2_256(SCALE(MODULE_TAG, cid_number, institution_role_nonce, proposal_id))` 前 16 字节；客户端不得提交岗位码，删除后 `UsedRoleCodes` 仍永久占用且永不复用。
- 动态岗位仅 `role_name` 可依法修改；岗位权限不可原地修改，改变权限必须删除旧岗位并生成新岗位码。
- 机构治理阈值唯一真源位于对应 entity 的 `InstitutionGovernanceThresholds[cid_number]`，与管理员人数、岗位数和席位数独立；固定治理机构仍由创世常量播种其制度阈值。任职结果不得携带或修改阈值。
- 任职不保存 `creator`；来源由 `assignment_source + assignment_source_ref` 唯一表达。
- 一个公民 `cid_number` 只能绑定一个钱包账户，一个钱包账户也只能绑定一个公民 CID。
- 一个管理员钱包账户可在多个机构、多个岗位任职；各完整 `RoleSubject` 权限互不串用。
- 普通机构创建必须原子建立 admins、强制 LR、至少一个初始治理岗位及权限、初始任职与初始投票规则；不允许临时管理员权限或创建后再补岗位的启动窗口。
- 个人多签及 `personal-admins` 使用独立 `AuthorizationSubject::PersonalMultisig`，不使用机构岗位契约。
- 每个业务模块前置校验 `RoleSubject`，在代码中静态指定唯一投票引擎并绑定 VotePlan；调用方不得选择引擎。投票引擎只做资格快照、票据、阈值、计票和终态，不执行具体业务。

#### 0.2 正式创世版本基线（2026-07-21 定稿，2026-07-26 生效）

正式创世前不存在需要迁移或兼容的链上历史状态，因此项目自身版本统一使用以下初始值，
不得用版本递增掩盖开发期结构调整。该归零阶段已经结束，以下值现为正式创世版本基线：

- runtime 的 `authoring_version`、`spec_version`、`impl_version`、`transaction_version`、`system_version` 全部为 `0`。
- 所有项目 pallet 的 `StorageVersion` 全部为 `0`；结构调整直接落到创世目标结构，不编写 migration、双读或旧 storage 兼容。
- CitizenChain workspace、runtime 和 Node 的项目程序包版本统一为 `0.0.0`。
- 第三方依赖版本不属于项目版本归零范围，不得修改。
- Substrate runtime API trait 的协议版本用于框架 API 协商，不属于项目升级计数，不得为了本规则修改。
- 当前正式创世哈希为
  `0x157558224b682de0384fd50dea0735aff55795f6d145993233c901cf1258671d`，
  状态根为
  `0x363d9c4836875a1a8270940caef743524350a6341199ec75966c3b25065bbe80`。
- 正式创世以后，runtime、Node 或 storage 发生真实升级时，才按对应升级规则递增版本并
  对既有正式链状态执行必要的原子迁移；禁止重新烘焙创世、双读、双写或保留旧协议兼容分支。

#### 3. 统一术语

| 术语 | 含义 | 是否扫码协议 |
|---|---|---|
| 扫码协议 | 二维码外层 envelope 和 `k` 流向规则 | 是 |
| 签名请求 | `QR_V1` 下的 `k = 1` | 否，属于扫码协议中的一种流向 |
| 交易载荷格式 | `b.d` 中某个链上 call data 的字段顺序和编码 | 否 |
| 接口契约 | HTTP / Tauri command / app API 的路径、字段和错误规则 | 否 |
| 凭证载荷 | CID 等系统签发给链端验签的 payload 字段 | 否 |
| storage 契约 | pallet storage 名称、key 类型、读取方和写入方规则 | 否 |

塔塔规则：

```text
扫码协议只有一个：QR_V1。
b.d 里可以有很多不同交易载荷格式，但它们都不是新的扫码协议。
```

##### P-CID-001：CID_NUMBER

- 状态：当前
- 类型：接口契约 / 编码协议
- 唯一真源：`citizenchain/onchina/src/cid/validator.rs`
- 详细文档：`../citizenchain/CitizenChainOnChina.md`
- 生产者：`citizenchain/onchina/src/cid/generator.rs`
- 消费者：`citizenchain/onchina`、`citizenapp`、`citizenwallet`、`citizenchain`
- 字段：
  1. `R5`:省码 2 位 + 市码 3 位
  2. `K3`:主体属性 `K1` + 机构类型 `T2`
  3. `P1`:盈利属性
  4. `C1`:校验位
  5. `N9`:9 位稳定散列序列
  6. `D4`:年份
- 编码：`R5-K3P1C1-N9-D4`,示例 `LN001-NRC0G-944805165-2026`
- 签名/验签规则：本协议只定义身份号码格式;链上或二维码签名按对应协议条目执行。
- 禁止兼容：不兼容历史格式,不保留历史字段别名。
- 禁止事项：
  - 禁止在 OnChina 内部继续使用身份字段别名
  - 禁止恢复独立历史主体属性段
  - 禁止跳过 `C1` 校验
- 必跑测试：`cargo test --manifest-path citizenchain/onchina/Cargo.toml number::`

##### P-API-ONCHINA-001：OnChina 管理员登录态工作台契约

- 状态：当前
- 类型：接口契约
- 唯一真源：
  - 后端：`citizenchain/onchina/src/auth/login/model.rs`
  - 工作台清单：`citizenchain/onchina/src/workspace/model.rs`
  - 前端：`citizenchain/onchina/frontend/auth/types.ts`、`citizenchain/onchina/frontend/workspace/types.ts`
- 详细文档：
  - `../citizenchain/CitizenChainOnChina.md`
  - `../citizenchain/CitizenChainOnChina.md`
  - `../citizenchain/CitizenChainOnChina.md`
- 生产者：OnChina 登录、扫码登录轮询、`/api/admin/auth/check`、`/api/admin/auth/identify`、`/api/admin/own-institution`、平台会员模块
- 消费者：OnChina 前端 `AuthContext` 和 `workspace/WorkspaceRouter`
- 字段：
  - 登录态统一携带 `institution_cid_number`、`institution_code`、`cid_number`、`cid_full_name`、`cid_short_name`、`family_name`、`given_name`、`capabilities`
  - `workspace`
  - `workspace.workspace_kind`: `registry` / `private` / `judicial` / `legislation` / `public` / `unincorporated`
  - `workspace.workspace_title`
  - `workspace.workspace_modules[]`: 当前实例被授权的模块；公民链基金会可包含 `platform_membership_price`
  - `workspace.workspace_sections[]`
  - `workspace_sections[].workspace_section`: `operations` / `display` / `records`
  - `workspace_sections[].workspace_section_title`
  - `workspace_sections[].workspace_actions[]`
  - `workspace_actions[].workspace_action`
  - `workspace_actions[].workspace_action_title`
  - `workspace_actions[].workspace_action_enabled`
  - `/api/admin/own-institution` 返回 `InstitutionDetailOutput`: `institution`、`accounts`、`created_by_family_name`、`created_by_given_name`、`created_by_role`
- 编码：HTTP JSON,字段统一 snake_case;前端类型保持 snake_case,不另造 lowerCamelCase API 别名。
- 签名/验签规则：本契约只描述当前登录态返回；ADR-039 落地后，登录只能确认人员账户和可选机构，业务操作还必须由链上 `RoleSubject + RoleBusinessPermission + 有效任职` 单独授权，active admins 不能直接授予业务权限。
- 平台会员 API：`GET /api/membership/platform-prices` 读取同一 finalized 区块的 `PlatformCidNumber` 与 `PlatformPrice`；`POST /api/membership/platform-prices/propose` 生成一次 `propose_set_platform_price` 签名请求；`POST /api/admin/chain/submit` 是所有 OnChina 链交易唯一响应二维码回扫提交入口。
- 一次签名流程：OnChina 展示请求二维码 → CitizenWallet 只签名一次并展示响应二维码 → OnChina 回扫、验签、dry-run、提交并等待进块。prepare 与 submit 都重新核对节点绑定、准确机构 CID 和链上 active `admins`。
- 禁止兼容：不得恢复“注册局根 UI + 非注册局只塞一个 tab”的旧口径;不得新增第二套 `dashboard` / `外部宿主` / `tenant` 同义字段。
- 禁止事项：
  - 禁止把 `workspace` 或 admins 作为机构业务授权真源。
  - 禁止前端根据本地硬编码越过后端 `capabilities` 显示受限操作。
  - 禁止非注册局机构复用注册局业务 UI。
  - 禁止前端或机构码把平台会员模块授权给非 `PlatformCidNumber` 机构。
  - 禁止业务模块另建链提交 URL、直接钱包广播或第二套签名响应处理。
- 必跑测试：
  - `cargo check --manifest-path citizenchain/onchina/Cargo.toml`
  - `npm --prefix citizenchain/onchina/frontend run build`
  - 真实本地 OnChina 服务的 `/api/admin/auth/check` 和真实页面验收

##### P-QR-001：QR_V1

- 状态：当前
- 类型：扫码协议
- 唯一真源：
  - 当前协议冻结文档：`../citizenwallet/CitizenWallet.md`
  - action registry 代码真源：`citizenchain/crates/qr-protocol/registry/*`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenwallet/CitizenWallet.md`
- 生产者：`citizenapp`、`citizenwallet`（仅 `k=4` 临时收款码）、`citizenchain/node`、`citizenchain/onchina`
- 消费者：`citizenwallet`、`citizenapp`、`citizenchain/onchina`
- 字段：顶层只允许 `p/k/i/e/b`;`k=1/2` 的压缩键 `b.u` 在各端唯一映射为 `signer_public_key`，仅 `citizen_occupy/citizen_rebind` 的请求必须留空并由钱包原位填授权模板零槽;`k=1` 的 `b.d` 是 `review_payload`,除 Runtime 升级 hash-only 外必须完整可解码和可中文展示;`k=3` body 只允许 `cid_number + ss58_address + display_name`，且仅由 CitizenApp 已绑定 CID 的身份账户生成；`k=4` 的展示地址同样只允许 `ss58_address`;具体字段以 `qr-protocol-spec.md` 为准
- 编码：紧凑 JSON envelope
- 签名/验签规则：按 `k` 和 `b.a + b.d(review_payload)` 执行;普通链交易由扫码端按 Substrate 规则从 `review_payload` 计算 `signing_bytes`;签名响应只带 `u/s`
- 注册局占号/换绑：`citizen_occupy` 的 `b.d` 固定为
  `genesis_hash + bounded cid + 32B 零 account 槽 + revision=0 + expires_at`；
  `citizen_rebind` 固定为
  `genesis_hash + bounded cid + current_account_id + 32B 零 new_account 槽`
  `+ nonzero revision + expires_at`。外层 `e` 必须等于内层过期时间；钱包严格解码、确认
  无尾字节并拒绝换绑当前账户与新账户相同后，才可原位填选定账户并分别走
  `0x12/0x1f` 哈希域签名。
  OnChina 段 3 管理员冷签 call 固定为：
  `occupy_cid(10/6) = actor_cid + actor_role + cid + account_id(32B) + expires_at(u64 LE)
  + citizen_signature(Vec64)`；
  `admin_rebind_cid_account_id(10/7) = actor_cid + actor_role + cid + new_account_id(32B)
  + expected_binding_revision(u64 LE) + expires_at(u64 LE) + new_account_signature(Vec64)`。
  call 6 的展示字段用 `account_id`，call 7 同时涉及当前/新账户时必须用
  `current_account_id`/`new_account_id`，不得退回含糊 `account_id`。
- 平台调价动作：`propose_set_platform_price`，pallet/call 为 `SquarePost/propose_set_platform_price`；必审字段为 `actor_cid_number`、`membership_level`、`new_price_fen`。CitizenWallet 必须严格中文解码并输出标准签名响应二维码，OnChina 负责回扫提交。
- 禁止兼容：开发期不做旧协议兼容
- 禁止事项：
  - 禁止为扫码协议新增其它版本标识
  - 禁止新增第二套扫码协议字符串
  - 禁止把某个 `b.d` 的交易载荷格式称为新扫码协议
  - 禁止各端手写第二套 action registry、中文动作名、字段中文名或签名判定分支
  - 禁止普通链交易把 32B hash/signing bytes 放进 `b.d` 冒充可审阅 payload
  - 禁止扫码签名出现正常/拒绝以外的第三状态
  - 禁止未中文翻译的 action、字段或枚举值继续签名
  - 禁止在 registry、decoder、生成物或 QR 端侧恢复含糊账户字段；单一账户只用 `account_id`，多账户按 `<role>_account_id` 命名
- 必跑测试：QR fixture、citizenwallet/citizenapp QR 解析测试

##### P-CHAIN-CITIZENAPP-001：CitizenApp 公权机构 finalized 快照契约

- 状态：当前
- 类型：链快照契约
- 唯一真源：`PublicManage::Institutions` 与 `PublicManage::InstitutionAccounts`
- 实现：
  - 生成器：`citizenapp/tools/generate_public_institution_bundle.mjs`
  - 移动端载入：`citizenapp/lib/citizen/public/data/public_institution_bundle_loader.dart`
- 生产者：连接目标链节点的发布期快照生成器
- 消费者：CitizenApp 公权机构目录、Isar 本地缓存和快照载入服务
- 链读取：`state_getKeysPaged` 与 `state_queryStorageAt` 必须钉在同一个 finalized 块哈希。
- 机构分片字段：`cid_number`、`cid_full_name`、`cid_short_name`、`status`、`province_code`、`city_code`、`town_code`、`institution_code`、`account_count`、`custom_account_names`、`created_at_block`。
- manifest 字段：`chain_id`、`snapshot_block_number`、`snapshot_block_hash`、`genesis_hash`、`state_root`、`chainspec_hash`、`public_institution_root`、`version`、`shard_hashes`、`provinces`；字段集合必须精确匹配，不保留结构版本字段或兼容分支。
- 编码：快照和分片均为 UTF-8 JSON，业务字段统一 snake_case，分片和机构根使用 sha256 hex。
- 权限边界：快照和 Isar 只用于目录查询；身份、绑定、付款和权限操作必须精确读取当前 finalized storage。
- 禁止兼容：机构目录只允许 finalized 链快照和精确链读取，不得建立第二套查询真源。
- 禁止事项：CitizenApp 运行时不得全量扫描 49,593 条机构；行政区名称仍由行政区字典按 code join。
- 必跑测试：`flutter test test/citizen/public/public_institution_bundle_loader_test.dart test/citizen/public/public_institution_dto_test.dart`

##### P-API-CITIZENAPP-004：公开启动清单边界

CitizenSDK只向`https://www.crcfrcn.com/api/chain/citizensdk/bootstrap`读取节点建议，由`core/src/abi/bootstrap.rs`严格解析；生产者为CitizenServe的`chain/bootstrap.rs`与`cloudflare/chain.rs`。本节描述当前代码合同，不作为生产已部署的证明。

- SDK顶层准确八字段：`is_ok`、`schema`、`generated_at`、`cache_ttl_seconds`、`chain`、`light_client`、`p2p`、`security`；`is_ok=true`，schema固定`citizensdk.chain.bootstrap`，未知字段或旧`ok`输入拒绝。
- chain准确包含`chain_id`、`protocol_id`、`genesis_hash`、`state_root`、`ss58_format`、`token_symbol`、`token_decimals`；与随包链身份逐值核对。
- light_client准确包含`mode=smoldot`、`truth_source=p2p_finalized_storage`、`api_is_truth=false`、`bundled_assets_required`；checkpoint和链同步资产只来自签名安装包，不接受远端替换字段、URL或摘要。
- p2p准确包含`bootnodes`、`min_peer_count_hint`；security准确四字段`exposes_rpc_url`、`rpc_proxy`、`exposes_private_key_material`、`validator_rpc_public`，均为false。请求六秒、64 KiB上限及禁止重定向保持。
- 清单仅生成当前实例内存bootNodes投影，不修改随包文件、持久数据库或链上状态。失败沿SDK原节点准备路径处理，不降级为Cloudflare RPC。
- CitizenApp服务发现使用另一个`/api/chain/bootstrap`及`citizenapp.chain.bootstrap`结构，由`citizenapp/lib/network/chain_bootstrap_api.dart`消费；它含App服务发现字段，不能交给SDK解析器。其完整HTTP合同归CitizenServe技术文档。
- Serve当前固定缓存TTL为300秒，bootnodes来自CHAIN_BOOTNODES，公开链身份来自既有声明；Access凭据、私有RPC及用户密钥不得进入响应。配置需求以Serve自身scripts/config.mjs和实际代码为准，不在SDK维护第二份旧变量清单。
- 所属回归为`core/tests/abi/bootstrap.rs`及`core/tests/abi/citizensdk_bootstrap_manifest.json`；跨端生产者回归为Serve的`test/chain_services_contract.rs`，App消费回归为`test/security/chain_bootstrap_api_test.dart`。通过控制台发起所属产品原测试入口；不保留已撤销的TypeScript测试或migrate:local指令。

##### P-API-CITIZENAPP-005：SDK不使用受控交易广播兜底

CitizenSDK与CitizenApp的交易构造、签名、提交和观察沿SDK唯一轻节点；节点或交易错误不能转向Worker广播兜底。不得以服务端接收、广播或tx_hash代替finalized runtime storage或事件成功证明。

Serve既有独立广播接口为`POST /api/chain/extrinsics`，实现归`chain/relay.rs`、`cloudflare/chain.rs`，持久结构归`cloudflare/schema.sql`的chain_relays，完整HTTP与配置合同归CitizenServe技术文档。SDK不作为该接口消费者，不另存旧路由、旧TypeScript文件、旧迁移表或另一份响应字段合同。跨端原回归归Serve的`test/chain_services_contract.rs`。

##### 聊天近场能力归属

聊天近场能力如有需求，只能由 TataChatSDK 实现并通过公开接口供产品依赖使用。撤销在 CitizenApp 原生目录或 transport 目录另行实现聊天近场传输的方案；本条不声明近场能力已经实现。

##### P-TX-013：Square.publish_square_post

- 状态：草案（阶段 4 runtime 发布索引已落地；阶段 5 CitizenApp 交易编码和提交入块闭环已落地；阶段 6 Worker 链上事件确认和正式 feed 入库已落地）
- 类型：交易载荷格式 / storage 契约
- 唯一真源：
  - 方案任务卡：`历史实施记录《公民云服务广场与聊天边缘能力》（卡已删除，规范以本文为准）`
  - 落地后实现真源：`citizenchain/runtime/misc/square-post/`
- 详细文档：
  - `历史实施记录《公民云服务广场与聊天边缘能力》（卡已删除，规范以本文为准）`
  - `../citizenwallet/CitizenWallet.md`
- 生产者：
  - `citizenapp/lib/8964/chain/`
- 消费者：
  - `citizenchain/runtime/misc/square-post/`
  - `citizenserve/src/chain/`
- 交易字段：
  1. `post_id`: `Vec<u8>`，runtime 约束为非空且最多 64 字节。
  2. `post_category`: `SquarePostCategory::Normal` / `SquarePostCategory::Campaign`。
  3. `content_hash`: `[u8; 32]`，必须非全 0。
  4. `storage_receipt_id`: `Vec<u8>`，runtime 约束为非空且最多 96 字节。
  5. `storage_until`: `u64`，必须大于 0。
- 派生字段：
  - `signer_account_id`：由 signed origin 派生，仅作为本次发布交易的签名者审计证据，
    不作为帖子用户归属主键，App 不得作为参数伪造。
  - `cid_number`：由 runtime 按 `signer_account_id` 读取并双向复核当前 active 公民身份
    绑定，作为帖子唯一用户归属主键；缺失、inactive 或双向绑定不一致时拒绝发布。
  - `created_block`：由 runtime 当前区块派生。
- 编码：
  - SCALE call data。
  - pallet index：`34`。
  - call index：`0`。
  - `post_category` 枚举只允许 `Normal = 0` / `Campaign = 1`。
  - `content_hash` 固定为内容 manifest 规范化后的 hash。
  - `storage_receipt_id` 固定引用 P-API-CITIZENAPP-002 的 Worker 上传回执。
  - CitizenApp 编码实现真源：`citizenapp/lib/8964/services/square_chain_service.dart`。
- 链上 storage / event：
  - `SquarePosts[post_id] -> SquarePost`：保存 `post_id`、必填 `cid_number`、
    `signer_account_id`、`post_category`、`content_hash`、`storage_receipt_id`、
    `storage_until`、`created_block`。
  - `PublishedPostCountByCid[cid_number] -> u64`：保存同一公民身份累计成功发布数量，
    CID 换绑不得重置。
  - `SquarePostPublished` 事件：Worker 只能根据入块事件确认发布并写入正式 feed。
- 签名/验签规则：
  - 外层链交易必须由 `account_id` 对应钱包账户签名。
  - runtime 将 `SquarePost` 路由为 `FeeRoute::Onchain { transaction_amount: 0, payer: signer }`，对每条发布交易按 `ONCHAIN_MIN_FEE` 扣 0.1 元发布费。
  - 发布费按既定 8:1:1 规则支付到矿工、国储会费用账户、安全基金账户。
  - `post_category = normal` 时 active 匿名、投票或竞选 CID 均可发布；未绑定 CID 的
    普通钱包账户不得发布。
  - `post_category = campaign` 时 runtime 除 active CID 双向绑定外，还必须通过
    `candidate_subject(account_id, Country)` 确认完整有效的竞选身份；仅有普通投票身份不允许发布。
  - Worker 同步 feed 只能信任已 finalized 或已确认入块的链上事件。
- 禁止兼容：不兼容任何“媒体内容上链”或“链下假发布成功”的旧流程。
- 禁止事项：
  - 禁止把动态正文、图片、视频、封面、manifest 写入 runtime storage。
  - 禁止 runtime 依赖 Worker 判断竞选发布资格。
  - 禁止非认证用户通过传入 `cid_number` 伪造竞选发布。
  - 禁止链上交易未入块时把动态作为正式内容进入 feed。
- 必跑测试：
  - runtime 普通发布成功测试。
  - runtime 未认证用户发布 `campaign` 失败测试。
  - runtime 竞选身份用户发布 `campaign` 成功测试。
  - runtime 仅有投票身份的用户发布 `campaign` 失败测试。
  - runtime `SquarePost` 路由为签名者付款的零金额 `Onchain` 测试；实际最低链上费用 0.1 元和 8:1:1 分账复用现有 `OnchainFeeRouter` 测试。
  - CitizenApp 发布交易编码测试：阶段 5 已由 `citizenapp/test/8964/square_chain_service_test.dart` 覆盖。
  - Worker 链上事件解码与发布确认测试：阶段 6 已由 `citizenserve/test/chain_confirm.test.ts` 覆盖。

##### P-TX-014：SquarePost 公民币订阅交易

- 状态：当前目标契约（实现按 `20260716-citizen-coin-subscription` 分步骤落地）
- 类型：交易载荷格式
- 唯一真源：
  - `../citizenwallet/CitizenWallet.md`
  - `citizenchain/runtime/misc/square/`
  - `citizenchain/runtime/misc/square/tests/subscription_scale_vectors.json`
- 生产者：
  - `citizenapp/lib/my/membership/subscription_chain.dart`
  - `citizenchain/onchina/src/platform/`
- 消费者：
  - `citizenchain/runtime/misc/square/`
  - `citizenserve/src/chain/subscription.ts`
  - `citizenwallet`（负责 SquarePost 0..6 的 Cold 载荷确认、一次签名和响应二维码展示）
- pallet：`SquarePost`
- pallet index：`34 / 0x22`
- call index：
  - `0`：`publish_post`，见 P-TX-013。
  - `1`：`subscribe(issuer, plan, expected_price_fen)`。
  - `2`：`cancel(issuer)`。
  - `3`：`set_creator_plans(tiers)`。
  - `4`：`change_subscription_plan(issuer, new_plan, expected_price_fen)`。
  - `5`：`propose_set_platform_price(actor_cid_number, proposer_role_code, membership_level, new_price_fen)`。
  - `6`：`update_creator_tier_name(tier_id, tier_name)`。
- 类型标签：
  - `IssuerKey::Platform = 0x00`。
  - `IssuerKey::Creator(CidNumber) = 0x01 || Compact(cid_number_len) || cid_number`。
  - `MembershipLevel::Freedom/Democracy/Spark = 0x00/0x01/0x02`。
  - `BillingPeriod::Monthly/Quarterly/Yearly = 0x00/0x01/0x02`。
  - `SubscriptionPlan::Platform{membership_level} = 0x00 || membership_level`。
  - `SubscriptionPlan::Creator{tier_id,billing_period} = 0x01 || Compact(tier_id_len) || tier_id || billing_period`。
  - `SubscriptionStatus::Active/Cancelled/Terminated/Suspended/IssuerPaused =
    0x00/0x01/0x02/0x03/0x04`。
  - `SuspendReason::NeedReconsent/InsufficientBalance/IdentityBindingUnavailable =
    0x00/0x01/0x02`。
- call data 顺序：
  - 平台订阅：`22 01 || 00 || 00 || membership_level || expected_price_fen:u128LE`。
  - 创作者订阅：`22 01 || 01 || Compact(creator_cid_number_len) || creator_cid_number
    || 01 || Compact(tier_id_len) || tier_id || billing_period || expected_price_fen:u128LE`。
  - 平台取消：`22 02 || 00`。
  - 创作者取消：`22 02 || 01 || Compact(creator_cid_number_len) ||
    creator_cid_number`。
  - 创作者覆盖套餐：`22 03 || Compact(tier_count) || CreatorTierInput...`；每个
    CreatorTierInput 为 `Compact(tier_id_len) || tier_id || Compact(tier_name_len) || tier_name || Compact(period_count) || (billing_period || price_fen:u128LE)...`。
  - 换套餐：`22 04 || issuer || new_plan || expected_price_fen:u128LE`。
  - 平台调价：`22 05 || actor_cid_number:SCALE Vec<u8> || proposer_role_code:SCALE Vec<u8> || membership_level || new_price_fen:u128LE`。
  - 创作者档位改名：`22 06 || Compact(tier_id_len) || tier_id || Compact(tier_name_len) || tier_name`。
- 价格规则：
  - `expected_price_fen` 只保护首次扣款或换套餐签名到入块期间的价格；不得写入订阅状态作为续费价格真源。
  - 平台每次扣款读取当前 `PlatformPrice`。
  - 创作者每次扣款读取当前 `CreatorPlans`。
- 签名规则：
  - 订阅者只对 `subscribe/cancel/change_subscription_plan` 签名；创作者只对自己的 `set_creator_plans` 管理调用签名。
  - CitizenApp 必须按当前 `account_id` 在“我的钱包”中的 `SignMode` 分流：
    `Hot` 只允许本机私钥，`Cold` 只允许 CitizenWallet QR_V1；模式缺失、
    账户不匹配、`Hot` 私钥不可用或 Cold 回扫取消都直接拒绝，不得换路。
  - runtime 必须从 signed origin 解析并双向复核当前 active `subscriber_cid_number` /
    `creator_cid_number`，调用方不得提交订阅者 CID 冒充归属。
  - 首次扣款从本次 signed origin 账户支付；自动续费按订阅者 CID 解析当前绑定
    `account_id` 扣款，创作者收款按创作者 CID 解析当前绑定 `account_id`。绑定缺失、
    inactive 或双向不一致时 fail-closed，禁止扣取或支付历史账户。
  - `subscribe` 建立持续自动扣款授权，直到订阅者签名取消；续费和周期推进由 runtime 内部执行，不存在外部 call 或再次签名。
  - 自动续费在 `on_initialize` 使用上一块已确认 `Timestamp.Now` 处理：正常出块最多延后
    一个区块、绝不提前扣款；付款与收款余额变化必须进入 NodeGuard 的 finalize 前状态。
  - `propose_set_platform_price` 由 OnChina 生成 QR_V1/k=1 请求二维码，CitizenWallet 只签名一次并显示响应二维码，OnChina 回扫响应后通过统一提交入口上链；业务 pallet 只创建统一内部投票提案。
- 禁止兼容：
  - 不兼容旧 `SubscriptionPlan::Level/CreatorPrice/Terms` tag。
  - 不兼容 `BillingKeeper/charge_due`。
  - 不兼容 Cloudflare/App 带价续费、外部周期确认、设备签名或旧 call 墓碑。
- 必跑测试：
  - runtime 金标 SCALE 向量和 call index 测试。
  - CitizenApp 编码与 runtime fixture 逐字节一致测试。
  - Cloudflare storage 解码金标测试。
  - CitizenWallet 平台调价动作两态识别测试。

##### P-STORAGE-006：SquarePost 订阅 storage

- 状态：当前目标契约（实现按 `20260716-citizen-coin-subscription` 分步骤落地）
- 类型：storage 契约
- 唯一真源：`citizenchain/runtime/misc/square-post/`
- 详细文档：`../citizenwallet/CitizenWallet.md`
- storage：
  - `Subscriptions<(subscriber_cid_number, IssuerKey)> -> SubscriptionState`，key hasher为
    `Blake2_128Concat`。
  - `PlatformPrice<MembershipLevel> -> u128`，key hasher 为 `Twox64Concat`。
  - `CreatorPlans<creator_cid_number> -> BoundedVec<CreatorTier>`，key hasher 为
    `Blake2_128Concat`。
  - `RenewalSchedule<(due_at_be, subscriber_cid_number, IssuerKey)> -> ()`，第一个 key
    使用大端时间戳保持到期顺序。
  - `RenewalIndex<(subscriber_cid_number, IssuerKey)> -> due_at`，保证每个订阅只有一个
    当前调度项。
- `SubscriptionState` SCALE 字段顺序：
  1. `plan: SubscriptionPlan`。
  2. `started_at: u64LE`。
  3. `last_charged_at: u64LE`。
  4. `charge_fen: u128LE`。
  5. `paid_until: u64LE`。
  6. `subscription_status: SubscriptionStatus`。
  7. `price_fen: u128LE`。
  8. `suspend_reason: Option<SuspendReason>`。
- 状态规则：
  - `Active` 必须有对应 `RenewalSchedule` 和 `RenewalIndex`；`current_timestamp < paid_until` 时权益有效。
  - Cancelled 不再续费，但不得缩短 `paid_until`。
  - Terminated 由余额不足、真实转账失败或套餐失效产生，不再调度且不重试。
  - `Suspended` 保留订阅关系但退出调度，订阅者重新签名后才能恢复。
  - `CreatorPaused` 保留订阅关系和调度，创作者恢复有效平台会员后自动继续。
  - runtime 在 `on_initialize` 读取上一块已确认时间，从最早到期项开始处理；单块最多处理
    `MaxSubscriptionRenewalsPerBlock` 项并按实际处理数返回权重，余额变化发生在 NodeGuard
    finalize 前。
- 生产者：`square-post` subscribe、cancel、change、set plans、runtime 自动续费和平台调价终态回调。
- 消费者：CitizenApp finalized 链读、Cloudflare finalized 镜像和对账器。
- 禁止事项：
  - 禁止恢复 `BillingKeeper` storage。
  - 禁止 D1 保存第二份扣款价格真源。
  - 禁止在 CitizenApp 或 Cloudflare 计算并提交订阅公历到期时间。
  - 禁止使用区块高度、固定天数或固定毫秒推导 `paid_until`。
  - 禁止 App、Cloudflare、keeper 或任意外部账户提交续费；runtime 只处理有界到期索引。
  - 禁止在 `on_finalize` 或 NodeGuard finalize 后阶段执行订阅付款、创作者收款等业务转账。
- 必跑测试：runtime storage key/value 金标、Cloudflare 解码、CitizenApp 解码、TryRuntime pre/post 不变量。

##### P-QR-002：QR_V1 / k=1 sign_request

- 状态：当前
- 类型：扫码协议内签名请求流向
- 唯一真源：`../citizenwallet/CitizenWallet.md`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenwallet/CitizenWallet.md`
- 生产者：`citizenapp`、`citizenchain/node`、`citizenchain/onchina`
- 消费者：`citizenwallet`、`citizenapp`
- 字段：
  - `b.a`:业务动作码
  - `b.g`:签名算法码,当前 `1 = sr25519`
  - `b.u`:压缩传输键；端内唯一语义名为 `signer_public_key`，值为 32B 签名者公钥的 base64url 无填充编码
  - `b.d`:payload bytes,base64url 无填充
- 编码：外层 JSON；`b.d` 内部是具体链上 call data 或已登记的链下业务载荷
- 签名/验签规则：
  - `b.a` 必须已登记
  - `b.d` 必须能被扫码端 decoder 按对应交易载荷格式完整解码
  - `b.a` 必须和 decoder 得到的 action 一致
  - 用户确认页只展示 decoder 产出的 `reviewFields`;左侧分类名必须由统一映射翻译为中文，禁止直接渲染机器 key
  - 用户确认页的账户字段必须展示 SS58 地址，禁止把原始公钥 hex 当作普通用户确认字段展示
  - `activate_admin_account` 载荷中的 `institution_code` 必须用共享机构码编码，禁止各端手写第二套字节映射。
  - **OnChina 塔塔控制台链写动作码（`b.d`=裸 SCALE call data，CitizenWallet 解码核对并只签名一次、显示响应二维码，OnChina 回扫响应后通过统一入口提交）**：链交易统一 `a=(pallet<<8)|call`(禁止扁平小整数,会撞非链动作码 1..9)。本机构治理=公权 `0x1e08`/私权 `0x1f08`，注册局直接登记管理员=公权 `0x1e09`/私权 `0x1f09`(见 P-TX-012);公民投票身份注册=`0x0a00`(CitizenIdentity 10/call 0,见 P-TX-011);公民参选身份上链=`0x0a01`(CitizenIdentity 10/call 1,见 P-TX-011);注册局代办首次绑定=`0x0a06`，注册局代办换绑=`0x0a07`；个人多签管理员集合变更为 `0x1d00`(PersonalAdmins 29/call 0,见 P-TX-007);平台调价提案=`0x2205`(SquarePost 34/call 5,见 P-TX-014);CREG 市注册局无独立链动作码；非链文本治理统一使用 registry 的 `a=3 onchina_admin_action`（`onchina_admin_governance` JSON）。`0x1e05`、`0x1f05` 已永久留洞，旧机构直接创建载荷不得进入 QR。动作码由 `onchina/src/core/institution_call.rs::chain_action_code(pallet,call)` 与 call data 同源派生，非链动作码从 `qr-protocol` registry 读取，均与 `qr-action-registry.md` 同步；动作码 `8` 已取消登记，Chat 设备绑定不得进入 QR。
  - Substrate 交易 payload 长度 >256B 时必须签 `blake2_256(payload)`
- 禁止兼容：开发期严格模式，不做别名兼容
- 禁止事项：
  - 禁止恢复 `display` / `summary` / `fields`
  - 禁止未登记的 `a` 进入生产
  - 禁止把内部哈希、nonce、原始公钥 hex 当作普通用户确认字段展示
- 必跑测试：`citizenwallet/test/signer/payload_decoder_test.dart`、QR sign request 测试

##### P-QR-003：QR_V1 / k=5 account_id_code（账户码）

- 状态：现行（2026-07-29 三码分类落地；`k=5` 码值由已废止的 `chat_node_pairing` 回收）
- 类型：扫码协议内固定码（无 `i/e`）
- 唯一真源：`../citizenwallet/CitizenWallet.md` 第 8 节
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenapp/CitizenApp.md`
  - `../citizenwallet/CitizenWallet.md`
- 生产者：CitizenApp `lib/wallet/widgets/wallet_qr_dialog.dart`、CitizenWallet `lib/ui/account_detail_page.dart`（钱包-账户详情，任意账户无条件生成）
- 消费者：
  - CitizenApp 扫码转账（`transfer`/`dispatch` 模式）
  - OnChina 管理员登录第 1 步（`auth/login/qr_login.rs` → `parse_wallet_code_account_id`）
  - OnChina `core/ScanAccountModal.tsx`、citizenchain node `shared/qr/parseAddressQr.ts` 的「扫码识别账户」
- 字段：
  - `b.account_id`：小写 `0x` 加 64 位十六进制，唯一字段。
  - 禁止携带钱包账户名、公开昵称、CID、SS58 及任何时效字段。展示用 SS58 由扫码端派生。
- 编码：`{"p":"QR_V1","k":5,"b":{"account_id":"0x…"}}`；顶层字段集精确为 `p/k/b`。
- 签名/验签规则：本码不参与签名，只提供目标账户。OnChina 登录据此按
  `account_id → CidByAccountId → CidRegistry Active → 管理员记录 Active` 单向反查，三级
  任一不成立即拒绝登录。
- 为什么不带 CID 与昵称：管理员私钥保管在离线的 CitizenWallet，若要求二维码携带 CID 就只有
  联网热钱包能出码，管理员将被迫在「私钥落到联网设备」与「无法登录」之间二选一。CID 由链上
  反查即可得到，昵称本来就不参与授权（旧实现在后端直接丢弃）。
- 禁止兼容：不得恢复 `chat_node_pairing` 及其 `node_peer_id`/`node_multiaddr`/`endpoint_kind`
  字段；旧载荷靠 body 字段集精确匹配拒绝，不需要专门的拒绝分支。
- 禁止事项：
  - 禁止用账户码写入通讯录（无 CID 真源，通讯录关系必须锚永久 CID）。
  - 禁止在账户码中夹带任何身份或时效字段。
  - 禁止让 CitizenWallet 生成用户码，或让账户码承担「人」的语义。
- 必跑测试：`citizenapp/test/wallet/widgets/wallet_identity_card_test.dart`、
  `citizenapp/test/wallet/pages/wallet_multi_account_ui_test.dart`、
  `citizenapp/test/qr/qr_router_test.dart`、`citizenwallet/test/ui/account_detail_page_test.dart`、
  `citizenchain/onchina/src/core/qr/mod.rs` 的 `wallet_code_parser_*` 测试

##### P-CRED-003：CitizenIdentity VotingIdentityPayload

- 状态：当前
- 类型：凭证载荷 / 交易载荷内层结构
- 唯一真源：`citizenchain/runtime/misc/citizen-identity/src/lib.rs`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenchain/CitizenChainOnChina.md`
- 生产者：`citizenchain/onchina/src/domains/citizens/chain_identity.rs`
- 消费者：
  - `citizenapp/lib/signer/citizen_identity_sign_service.dart`
  - `citizenwallet/lib/signer/payload_decoder.dart`
  - `citizenwallet/lib/signer/qr_signer.dart`
  - `citizenchain/runtime/misc/citizen-identity`
- 字段（投票身份不含年龄）：
  1. `cid_number`
  2. `account_id`
  3. `passport_valid_from`
  4. `passport_valid_until`
  5. `citizen_status`
  6. `residence_province_code`
  7. `residence_city_code`
  8. `residence_town_code`
- 编码：SCALE `VotingIdentityPayload<AccountId>`;字符串字段为 bounded `Vec<u8>`,账户字段为 `AccountId32`。
- 签名/验签规则：
  - action registry 的统一中文动作名为“公民签名确认”；投票/参选只作为载荷详情展示，不得拆成第二套动作标题。
  - `QR_V1` 非链动作 `a=2 citizen_identity` 的签名字节为 `blake2_256(GMB || 0x10 || payload_bytes)`。
  - runtime 通过 `primitives::sign::OP_SIGN_CITIZEN_IDENTITY` 验证目标公民钱包签名。
  - 年龄不入投票载荷:能否投票由 `citizen_status=Normal` + 护照有效期窗口判定;≥16 门只在竞选身份按 `birth_date` 由 runtime 复核,OnChina 侧另按 `citizen_birth_date` 做 ≥16 BFF 防误推(不入链)。
  - 同一上链 operation 固定只允许管理员 Passkey 一次、目标公民钱包签名一次、管理员最终链交易签名一次。`prepare` 创建短期操作，`complete` 只能原子消费对应公民回执，不得再次生成安全 grant 或消费 Passkey。
  - 公民钱包绑定和上链投影必须等最终链交易确认后写入。
- 禁止兼容：不兼容已删除的管道文本载荷，不保留旧签原文规则。
- 禁止事项：
  - 禁止本地新增公民阶段要求钱包账户。
  - 禁止未满 16 周岁公民推送链上身份。
  - 禁止二维码携带展示摘要或字段别名。
  - 禁止 `prepare/complete` 分阶段重复认证同一角色，禁止为最终链签再叠加管理员 grant 钱包签名。
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `citizenwallet/test/signer/qr_signer_test.dart`
  - `cargo test --manifest-path citizenchain/Cargo.toml -p citizen-identity`

##### P-TX-011：CitizenIdentity.register_voting_identity / upgrade_to_candidate_identity

- 状态：runtime 第 3 步已完成，OnChina、CitizenApp、CitizenWallet 与 QR 编解码待本任务第 8 步同步；下列字段顺序为唯一目标协议
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/misc/citizen-identity/src/lib.rs`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenchain/CitizenChainOnChina.md`
- 生产者：`citizenchain/onchina/src/domains/citizens/chain_identity.rs`
- 消费者：
  - `citizenchain/runtime/misc/citizen-identity`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  1. `registrar_account`
  2. `VotingIdentityPayload` 或 `CandidateIdentityPayload`
  3. `citizen_signature`
- 编码：
  - SCALE call data
  - `0x0a00 register_voting_identity` 仅携带投票身份字段。
  - `0x0a01 upgrade_to_candidate_identity` 的最终顺序为投票身份字段 + `birth_province_code / birth_city_code / birth_town_code / family_name / given_name / citizen_sex / birth_date`；其中 `birth_date` 为 `u32` 小端 `YYYYMMDD`，位于性别字段之后且为必填字段；该交易同时写入投票身份和参选身份。
  - pallet index：`10`
  - call index：`register_voting_identity = 0`，`upgrade_to_candidate_identity = 1`
  - 前两个字节分别固定为 `[0x0a, 0x00]`、`[0x0a, 0x01]`
  - 动作码分别为 `a=0x0a00`、`a=0x0a01`
- 签名/验签规则：
  - 外层链交易由当前注册局管理员的 CitizenWallet 只签名一次并显示响应二维码；OnChina 回扫后经统一提交入口上链。
  - 内层 `citizen_signature` 必须来自目标公民钱包对 P-CRED-003 的签名。
  - runtime 校验注册局管理范围、CID 唯一性、公民签名;16 周岁年龄门槛只对竞选身份按 `birth_date` 校验,投票身份不校验年龄。
- 禁止兼容：不兼容旧带 `citizen_age_years` 年龄字段的 `VotingIdentityPayload`，也不兼容姓名合并字段或带主体前缀的姓、名字段；不保留旧字段顺序、别名或双读。
- 禁止事项：
  - 禁止绕过 `citizen-identity` 在业务模块内自建投票身份。
  - 禁止前端或 OnChina 伪造已上链状态。
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `cargo test --manifest-path citizenchain/Cargo.toml -p citizen-identity`

##### P-TX-012：LegislationYuan 法律案提案载荷

- 状态：当前
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/public/legislation-yuan/src/lib.rs`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
- 生产者：
  - `citizenchain/onchina/src/domains/legislation/law/chain_propose.rs`
- 消费者：
  - `citizenchain/runtime/public/legislation-yuan`
  - `citizenwallet` 法律案扫码 decoder
- 字段：
  - `propose_enact_law`: `[pallet=25, call=0] + tier + scope_code + houses + proposer_body + executive + legislature + vote_type + title + title_en + chapters + effective_at`
  - `propose_amend_law`: `[pallet=25, call=1] + law_id + proposer_body + executive + legislature + vote_type + title + title_en + chapters + effective_at`
  - `propose_repeal_law`: `[pallet=25, call=2] + law_id + proposer_body + executive + legislature + vote_type`
- 编码：
  - 裸 SCALE call data
  - `tier`/`vote_type` 为单字节枚举序号
  - `scope_code` 为 `u32`
  - `law_id` 为 `u64`
  - `houses` / `proposer_body` / `executive` / `legislature` 使用 `(InstitutionCode[4], AccountId32)`
  - `chapters` 为 `章 > 节 > 条 > 款` 的 SCALE 结构
  - `effective_at` 为 `u64` 毫秒时间戳，不是块号
  - 动作码：`0x1900` / `0x1901` / `0x1902`
- 签名/验签规则：
  - 外层链交易由当前立法/提案机构管理员的 CitizenWallet 只签名一次并显示响应二维码；OnChina 回扫后经统一提交入口上链。
  - 业务投票、计票、签署和守卫流程统一归投票引擎与 legislation-vote，不得由 OnChina 或客户端复刻。
  - `houses / proposer_body / executive / legislature` 虽作为客户端载荷传入，runtime 必须按 `tier + scope_code + vote_type` 复核法定机构码、机构账户、行政区与院序；客户端传值不是授权真源。
- 禁止兼容：不兼容旧区块高度生效载荷，不保留旧字段顺序。
- 禁止事项：
  - 禁止前端显示或让用户填写旧区块高度生效字段。
  - 禁止未登记动作码进入冷钱包 decoder。
- 必跑测试：
  - `cargo test -p onchina --manifest-path citizenchain/Cargo.toml law`
  - `cargo test -p legislation-yuan --manifest-path citizenchain/Cargo.toml`

##### P-TX-015：ElectionVote 投票交易载荷

- 状态：已完成 Runtime、CitizenWallet 严格解码和 QR 动作登记的最终载荷同步
- 类型：交易载荷格式 / runtime 调用边界
- 唯一真源：`citizenchain/runtime/votingengine/election-vote/src/lib.rs`
- 详细文档：`../citizenchain/CitizenChainRuntime.md`
- 生产者：合法选举活动的投票客户端
- 消费者：`citizenchain/runtime/votingengine/election-vote`
- 字段：
  - `cast_popular_vote`: `[pallet=22, call=2] + proposal_id + candidate_subject`
  - `cast_mutual_vote`: `[pallet=22, call=3] + proposal_id + voter_role_code + candidate_subject`
- 编码：裸 SCALE call data；`proposal_id` 为 `u64`，`candidate_subject` 固定按 `CitizenSubject { cid_number, account_id }` 的同名字段顺序编码，Runtime 当前实现为唯一真源。
- 签名/验签规则：外层链交易由快照内有效选民钱包签名；Popular 从 citizen-identity 的历史资格解析完整选民 `CitizenSubject`，并按 `(proposal_id, voter cid_number)` 防重；Mutual 使用 `institution cid_number + role_code + 当前管理员 account_id` 的机构岗位票据。候选快照和当选结果保存完整 `CitizenSubject`，候选计票以候选 `cid_number` 为唯一键；候选账户必须仍与该 CID 的竞选身份闭环。
- 禁止兼容：底层 `create_popular_election` / `create_mutual_election` 外部调用物理删除，不保留旧创建载荷或过渡入口。
- 禁止事项：
  - 禁止客户端直接向 election-vote 传入组织机构、岗位、席位、候选人或选民快照来创建选举。
  - 禁止跨机构选举；具体业务模块只可绑定本机构 `actor_cid_number + role_code`。
  - 禁止 election-vote 直接写入 entity 岗位、任职或 admins；选举结果必须返回创建该提案的具体选举业务模块复核。
- 必跑测试：
  - `cargo test -p election-vote --manifest-path citizenchain/Cargo.toml`
  - `cargo test -p citizenchain --manifest-path citizenchain/Cargo.toml runtime_call_filter`

##### P-TX-001：已删除的 PublicManage/PrivateManage 机构直接创建载荷

- 状态：已删除（2026-07-19；ADR-039 第 3 步关闭）
- 类型：交易载荷格式
- 唯一真源：无当前生产代码；PublicManage/PrivateManage 的 call index 5 永久留洞
- 生产者：无；OnChina 创建 API 在新业务模块落地前固定返回 `501 Not Implemented`
- 消费者：无；CitizenWallet 和 QR action registry 必须拒绝 `0x1e05`、`0x1f05`
- 字段：无当前字段；旧 `cid_number/cid_full_name/cid_short_name/town_code/admins/actor_cid_number` 布局已删除
- 编码：无当前编码；`[0x1e,0x05]` 与 `[0x1f,0x05]` 是永久留洞，不得复用
- 替代：任务卡第 6 步新增独立机构创建业务模块，原子绑定 admins、LR、初始治理岗位、不可变权限、初始任职和投票规则，并由业务模块静态指定投票引擎；新协议必须另行登记，不得恢复本条旧载荷
- 禁止兼容：不得保留旧 decoder、旧 QR 动作、旧 OnChina 构造器、旧 runtime extrinsic 或按旧字段序重建交易
- 必跑测试：QR registry 生成一致性、CitizenWallet 对两个留洞动作的拒绝测试、PublicManage/PrivateManage metadata/call 测试

##### P-TX-012：PublicManage/PrivateManage 机构治理与注册局登记管理员

- 状态：当前；适用范围为机构维护/治理，机构首次创建走第 6 步独立原子协议
- 类型：交易载荷格式
- 唯一真源：
  - `citizenchain/runtime/entity/public-manage/src/lib.rs`(`propose_institution_governance` call 8 / `register_institution_admins` call 9)
  - `citizenchain/runtime/entity/private-manage/src/lib.rs`(`propose_institution_governance` call 8 / `register_institution_admins` call 9)
  - `citizenchain/runtime/entity/entity-primitives/src/institution_governance.rs`(`InstitutionGovernanceAction`)
- 生产者：
  - `citizenchain/onchina/src/core/institution_call.rs`
- 消费者：
  - `citizenchain/runtime/entity/public-manage` / `citizenchain/runtime/entity/private-manage`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  - `propose_institution_governance(30/31.8)`：`cid_number`、`InstitutionGovernanceAction`、`actor_cid_number`、`proposer_role_code`
  - `register_institution_admins(30/31.9)`：`cid_number`、`admins(account_id + cid_number + family_name + given_name)`、`actor_cid_number`
  - call 只带业务字段，不嵌凭证签名/公钥/nonce/作用域：机构操作 = 任职管理员用签名钱包直接冷签一笔普通 extrinsic，授权由 runtime 在 origin 处校验（治理走 `is_institution_admin` + 岗位码，登记走 `can_register_institution_origin`）。
  - `InstitutionGovernanceAction` discriminant：`ReplaceAdmins=0`、`MutateRolesAndAssignments=1`、`ReplaceAdminsAndMutateRoles=2`。
  - 两个岗位变更分支字段顺序固定为 `role_mutations`、`assignment_changes`、`legal_representative_change`；组合分支在最前增加 `admins`。
  - `InstitutionRoleMutation` discriminant：`Create=0`、`Rename=1`、`Delete=2`。Create 字段为 `role_name`、`term_required`、`permissions`、`assignments`，禁止调用方提交岗位码；Rename 字段为 `role_code`、`role_name`；Delete 只有 `role_code`。
  - `RolePermissionSpec` 字段固定为 `business_action_id`、`operation`；entity 生成岗位码后补齐完整 `RoleSubject` 并写入 `InstitutionRolePermissions`。
- 编码：
  - SCALE 裸 call data
  - pallet index：公权机构=`30`(PublicManage)，私权机构=`31`(PrivateManage)
  - call index：本机构治理=`8`，注册局直接登记管理员=`9`
  - 动作码：`0x1e08`、`0x1e09`、`0x1f08`、`0x1f09`
- 签名/验签规则：
  - 外层 `origin` 是持私钥且存在有效岗位任职的管理员；机构本体和机构账户无私钥，不参与签名。
  - 统一授权查询同时校验 CID 存在、origin 属于 admins、任职在 UTC 日闭区间内有效、岗位具备目标权限、权限主体与 storage key 一致且 CID 顶层能力允许；现有正式机构治理业务入口均已使用该查询。
  - 注册局登记业务也必须按注册局 `RoleSubject` 授权；仅属于注册局机构 admins 不构成登记权限。
  - 管理员集合变更完整替换 `admins`，普通机构至少两名管理员；姓名只展示，`account_id` 只证明人员与签名者，不直接授予业务权限。
  - `InstitutionGovernanceAction` 内的岗位任职来源只能是 `InstitutionGovernance`；普选、互选、任命结果必须由对应业务/投票引擎结果入口写入。
  - 交易费属于机构操作链上费 0.1 元，只从 `actor_cid_number` 的费用账户扣除；管理员钱包只签名，不允许回落扣管理员钱包。
- 禁止兼容：
  - 禁止恢复公权/私权机构管理员集合变更旧 call。
  - 禁止把 admins 当机构业务授权真源；岗位权限必须按完整 `RoleSubject` 与有效任职校验。
  - 禁止 OnChina 本地改库形成第二套管理员集合。
  - 禁止 CitizenWallet 解码后容忍尾字段或未知 `InstitutionGovernanceAction` 变体。
- 必跑测试：
  - `cargo check -p entity-primitives -p internal-vote -p public-manage -p private-manage -p citizenchain`
  - `cargo test -p citizenchain --lib`
  - `cargo test -p onchina core::institution_call`
  - `citizenwallet/test/signer/pallet_registry_test.dart`
  - `citizenwallet/test/signer/payload_decoder_test.dart`

##### P-TX-010：AddressRegistry address payloads

- 状态：当前
- 类型：交易载荷格式
- 唯一真源：
  - `citizenchain/runtime/misc/address-registry/src/lib.rs`
  - `citizenchain/onchina/src/domains/address/chain_call.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
  - `../citizenchain/CitizenChainOnChina.md`
  - `../citizenwallet/CitizenWallet.md`
- 生产者：`citizenchain/onchina/src/domains/address/chain_call.rs`
- 消费者：`citizenchain/runtime/misc/address-registry`
- 字段：
  - `set_catalog_version(33.0)`：`registrar_account`, `catalog_version`, `catalog_hash`
  - `set_address_name(33.1)`：`registrar_account`, `province_code`, `city_code`, `town_code`, `address_name_code`, `address_name`
  - `remove_address_name(33.2)`：`registrar_account`, `province_code`, `city_code`, `town_code`, `address_name_code`
  - `set_address(33.3)`：`registrar_account`, `province_code`, `city_code`, `town_code`, `address_name_code`, `address_local_no`, `address_detail`
  - `remove_address(33.4)`：`registrar_account`, `province_code`, `city_code`, `town_code`, `address_name_code`, `address_local_no`, `address_detail`
- 编码：
  - SCALE 裸 call data
  - pallet index：`33`
  - call index：`0..4`
  - 前两个字节：`[0x21, call_index]`
  - 动作码：`a=(33<<8)|call_index`,即 `0x2100..0x2104`
- 签名/验签规则：
  - `origin` 必须是 `registrar_account` 对应注册局的有效管理员。
  - FRG 省级组只能更新本省地址。
  - CREG 只能更新本市地址。
  - `catalog_version` 与 `catalog_hash` 由 OnChina 当前 `china.sqlite` 派生或由调用方显式传入。
- 禁止兼容：不兼容旧地址全量上链、旧墓碑表、旧变更日志表和旧地址字段。
- 禁止事项：
  - 禁止把地址库全量上链。
  - 禁止在链上保存旧地址历史或墓碑。
  - 禁止绕过 `AddressUpdateAuthority` 直接在 pallet 内复制 FRG/CREG 权限。
- 必跑测试：
  - `cargo check --manifest-path citizenchain/Cargo.toml -p address-registry`
  - `cargo check --manifest-path citizenchain/Cargo.toml -p citizenchain`
  - `cargo check --manifest-path citizenchain/Cargo.toml -p onchina`

##### P-TX-002：JointVote.cast_referendum

- 状态：当前
- 类型：交易载荷格式
- 唯一真源：
  - `citizenchain/runtime/src/lib.rs`
  - `citizenchain/runtime/votingengine/joint-vote/src/lib.rs`
- 详细文档：
  - `citizenchain/runtime/primitives/tests/fixtures/call_data.json`
  - `tasks/`
- 生产者：
  - `CitizenApp` 联合公投签名请求流程
  - Step2D fixture
- 消费者：
  - `citizenchain/runtime/votingengine/joint-vote`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  1. `proposal_id`
  2. `approve`
- 编码：
  - SCALE call data
  - pallet index：`21`
  - call index：`1`
  - 前两个字节固定为 `[0x15, 0x01]`
  - call data 长度为 11 字节，后接标准签名尾部
- 签名/验签规则：
  - runtime 按交易签名账户读取链上公民身份。
  - 联合公投资格和作用域由 `citizen-identity` 判定。
- 禁止兼容：开发期不兼容旧 `VotingEngine(9).call_index=2`
- 禁止事项：
  - 禁止 Step2D fixture 中继续出现 `cast_referendum` 的 `pallet_index=9 / call_index=2`
  - 禁止 `cast_referendum` fixture 继续使用 `0x0902` 前缀
  - 禁止 `CitizenWallet` 与 `CitizenApp` 各自维护重复 Step2D fixture
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `citizenwallet/test/signer/pallet_registry_test.dart`
  - `citizenapp/test/proposal/runtime_upgrade/runtime_upgrade_service_test.dart`

##### P-SIGN-001：Citizenchain signed extrinsic era

- 状态：当前
- 类型：签名 / extrinsic 协议
- 唯一真源：
  - `citizenchain/node/src/governance/signing.rs`
  - `citizensdk/core/`
  - `citizensdk/ffi/`
- 详细文档：
  - `tasks/`
- 生产者：
  - `citizenchain/node`
  - `citizensdk`（构造、签名、提交与 finalized execution 核验）
  - `citizenwallet` 公民钱包一次签名与响应二维码链路（不广播交易）
- 消费者：
  - `citizenchain runtime` signed extension 验签
- 字段：
  - `eraPeriod = 0`
  - `era bytes = 0x00`
  - `blockNumber = 0`
  - `SigningPayload.blockHash = genesisHash`
  - `ExtrinsicPayload.blockNumber = 0`
- 编码：
  - signed extension `CheckEra` 使用 immortal era 单字节 `0x00`
  - `CheckEra` additional signed hash 使用创世块哈希，即 `block_hash(0)`
- 适用范围：
  - 本协议仅约束 **sr25519 外层签名**的 signed extrinsic；PQC(ML-DSA-65)交易不走本协议，见下方 ADR-022 注与 P-TX-008/009。
- 签名/验签规则：
  - 签名前 payload 与最终 extrinsic body 必须使用同一份 immortal era 字节
  - 使用 polkadart 时必须传 `eraPeriod: 0`
  - `SigningPayload.blockHash` 必须传 `genesisHash`，不得传最新块 hash
  - 抗量子升级(ADR-022):PQC 交易改走 General Transaction(无外层 sr25519 签名),由自定义 `GmbPqcAuth` TransactionExtension 携带 ML-DSA-65 签名(proof 在扩展 extra),验签后把 origin 转 `Signed(account)`;未绑定账户首次走 bootstrap(post_dispatch 写 `AccountPqcKey`)无感绑定;AccountId 仍为原 sr25519 锚点。详见 P-TX-008/009。
- 禁止兼容：开发期不兼容热钱包 mortal era
- 禁止事项：
  - 禁止业务 service 自己保留 `_eraPeriod = 64`
  - 禁止 signed extrinsic 构造路径调用 `fetchLatestBlock()` 参与 era 计算
  - 禁止把最新块 hash 写入 immortal era 的 signing payload
- 必跑测试：
  - `citizensdk/core` 交易准备、immortal era、签名与 finalized execution 合同测试
  - `citizensdk/lib/test/api/public_api_contract_test.dart`
  - `flutter test test/transaction/multisig-transfer test/proposal test/trade`

##### P-TX-003：InternalVote.cast

- 状态：当前 ABI；机构投票主体语义待 ADR-039 breaking 改造，个人多签继续独立
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/votingengine/internal-vote/src/lib.rs`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `citizenwallet/lib/signer/pallet_registry.dart`
- 生产者：`citizenapp`、`citizenchain/node`
- 消费者：
  - `citizenchain/runtime/votingengine/internal-vote`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  1. `proposal_id`
  2. `approve`
- 编码：
  - SCALE call data
  - pallet index：`20`
  - call index：`0`
  - 前两个字节固定为 `[0x14, 0x00]`
- 签名/验签规则：
  - 当前入口为 `InternalVote::cast`；ADR-039 目标机构票资格必须来自提案绑定的 voter `RoleSubject` 有效任职快照，不是管理员身份或 CID 全体 admins
  - 业务 pallet 不再承载 `vote_*` wrapper
- 禁止兼容：开发期不兼容旧 `VotingEngine(9)` 投票入口
- 禁止事项：
  - 禁止恢复业务 pallet 内的投票 wrapper
  - 禁止把内部投票编码回 `VotingEngine(9)`
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `citizenwallet/test/signer/pallet_registry_test.dart`

##### P-TX-004：JointVote.cast_admin

- 状态：当前 ABI；`cast_admin` 名称和机构参与主体语义待 ADR-039 breaking 改造
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/votingengine/joint-vote/src/lib.rs`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `citizenwallet/lib/signer/pallet_registry.dart`
- 生产者：`citizenapp`、`citizenchain/node`
- 消费者：
  - `citizenchain/runtime/votingengine/joint-vote`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  1. `proposal_id`
  2. `account_id`
  3. `approve`
- 编码：
  - SCALE call data
  - pallet index：`21`
  - call index：`0`
  - 前两个字节固定为 `[0x15, 0x00]`
- 签名/验签规则：
  - 当前联合机构阶段走 `JointVote::cast_admin`；投票资格只来自提案 `VotePlan` 绑定的 `RoleSubject` 有效任职快照。完整票据为 `CID + role_code + wallet`，同一 CID 内跨岗位分别投票、同一岗位同一钱包只投一次；不按机构全体 admins 判定
  - `account_id` 底层类型为 `AccountId`
- 禁止兼容：开发期不兼容旧 `VotingEngine(9)` 投票入口
- 禁止事项：
  - 禁止恢复旧联合投票 wrapper
  - 禁止把 `account_id` 注释成当前 `InstitutionPalletId`
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `citizenwallet/test/signer/pallet_registry_test.dart`

##### P-CRED-002：PopulationScopeSnapshot

- 状态：当前
- 类型：投票引擎内部人口快照协议
- 唯一真源：`citizenchain/runtime/misc/citizen-identity`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
  - `../citizenchain/CitizenChainRuntime.md`
- 生产者：`citizen-identity` 内部 `CitizenIdentityReader`
- 消费者：
  - `citizenchain/runtime/votingengine/joint-vote`
  - `citizenchain/runtime/votingengine/legislation-vote`
  - `citizenchain/runtime/votingengine/election-vote`
- 字段：
  1. `scope`：`Country / Province / City / Town`
  2. `eligible_total: u64`
  3. `eligibility_revision: u64`
  4. `eligibility_date: u32`（UTC+8，YYYYMMDD）
- 编码：只保存为 runtime 内部 `PopulationData`，再由投票引擎按 `proposal_id` 写入
  `ProposalPopulationSnapshots`；不存在独立 `snapshot_id`、SCALE extrinsic 或客户端
  快照载荷。CitizenIdentity call 5 已用于公民自主首次绑定 CID，不属于人口快照流程；
  JointVote call 2、LegislationVote call 0 永久留洞。
- 创建/授权规则：
  - `citizen-identity::population_data(scope)` 只有在四级人口完整推进到当前日期且没有
    维护故障时返回 `Some`；否则投票引擎返回 `PopulationDataNotReady` 并回滚建案。
  - 人口分母只统计永久 CID Active、CID↔钱包闭环、状态正常、护照在判定日期有效且
    居住地匹配作用域的公民；护照生效和到期由身份模块 `on_idle` 有界维护。
  - 联合公投创建提案时内联创建全国快照。
  - 立法特别案只从已验证的 `actor_cid_number` 推导国家/省/市作用域后内联创建。
  - 快照创建、提案写入和绑定处于同一事务，任何失败全部回滚。
- 禁止兼容：开发期不兼容任何链下签发人口证明格式
- 禁止事项：
  - 禁止前端、OnChina 或冷钱包构造作用域、快照 ID 或人口分母。
  - 禁止恢复独立快照 action、payload、解码和两步准备流程。
  - 禁止跳过 runtime 链上人口读取。
- 必跑测试：
  - `citizenchain/runtime/tests/cases.rs` 中 population snapshot 相关测试
  - `citizenapp/test/proposal/runtime_upgrade/runtime_upgrade_service_test.dart`

##### P-TX-003：ResolutionIssuance.propose_issuance

- 状态：当前
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/issuance/resolution-issuance/src/lib.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 生产者：`citizenchain/node`、`citizenapp`
  - `citizenchain/node/src/transaction/multisig_transfer/`
  - `citizenchain/node/frontend/transaction/multisig-transfer/`
  - `citizenapp/lib/transaction/multisig-transfer/`
- 消费者：
  - `citizenchain/runtime/issuance/resolution-issuance`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  1. `actor_cid_number`
  2. `proposer_role_code`
  3. `reason`
  4. `total_amount`
  5. `allocations`
- 编码：
  - SCALE call data
  - pallet index：`8`
  - call index：`0`
  - 前两个字节固定为 `[0x08, 0x00]`
- 签名/验签规则：
  - runtime 必须按 `RoleSubject(actor_cid_number, proposer_role_code)` 与签名钱包校验 `res-iss/0 + Propose`；管理员身份本身不产生权限。
  - 本交易载荷只包含发行内容,不内嵌人口快照字段。
  - 联合提案在同一建案事务内由 `joint-vote` 创建全国人口快照并绑定，不存在独立快照交易或载荷字段。
- 禁止兼容：开发期不兼容继续把人口快照字段塞回本载荷的旧格式
- 禁止事项：
  - 禁止节点或前端把人口快照字段或旧链下人口证明字段混入本交易载荷
  - 禁止把发行金额显示口径和链端 `u128` 分单位混用
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `citizenchain/runtime/tests/cases.rs`

##### P-TX-005：MultisigTransfer proposal payloads

- 状态：当前
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/transaction/multisig/src/lib.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 生产者：`citizenchain/node`、`citizenapp`
- 消费者：
  - `citizenchain/runtime/transaction/multisig`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- CI 同步：
  - `.github/workflows/.github/workflows/citizenwallet/ci-ios.yml` 与 `.github/workflows/.github/workflows/citizenwallet/ci-android.yml` 必须从 `MultisigTransfer` / `multisig` 同步 `citizenwallet/lib/signer/pallet_registry.dart`
- 字段：
  - `propose_transfer(17.0)`：`org`、`account_id`、`beneficiary`、`amount`、`remark`
  - `propose_safety_fund_transfer(17.1)`：`beneficiary`、`amount`、`remark`
  - `propose_sweep_to_main(17.2)`：`account_id`、`amount`
- 编码：
  - SCALE call data
  - pallet index：`17`
  - call index：`0 / 1 / 2`
- 签名/验签规则：
  - 业务提案由持有私钥且对目标 `RoleSubject` 有有效任职的管理员签名；仅属于 admins 不得创建
  - 投票不走本 pallet，统一走 `P-TX-003`
  - `QR_V1 / k=1` 必须使用 `a + payload` 解码展示 `institution / beneficiary / amount_yuan / remark`，禁止 node 在 QR 中塞展示字段
- 禁止兼容：`call_index=3 / 4 / 5` 留洞不复用
- 禁止事项：
  - 禁止恢复 `execute_transfer / execute_safety_fund / execute_sweep` wrapper
  - 禁止把 `account_id` 注释成当前 `InstitutionPalletId`
  - 多签转账业务唯一归口 `citizenapp/lib/transaction/multisig-transfer/`(公私个共用);禁止在 `citizenapp/lib/citizen/institution/`(机构管理只读)、`citizenchain/node/src/governance/` 或 `citizenchain/node/src/transaction/offchain_transaction/`(链下结算)中另实现多签转账业务
- 必跑测试：
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `cargo test --manifest-path citizenchain/runtime/transaction/multisig/Cargo.toml`

##### P-TX-006：PersonalManage proposal payloads

- 状态：当前
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/private/personal-manage/src/lib.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 生产者：
  - `citizenapp/lib/transaction/personal-manage/personal_manage_service.dart`
- 消费者：
  - `citizenchain/runtime/private/personal-manage`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  - `propose_create(7.0)`：`account_name`、`admins`、`regular_threshold`、`amount`
  - `propose_close(7.1)`：`account`、`beneficiary`
- 编码：
  - SCALE call data
  - pallet index：`7`
  - call index：`0 / 1`
- ProposalData：
  - `MODULE_TAG = b"per-mgmt"`
  - `ACTION_CREATE = 0`：`account`、`proposer`、`amount`、`fee`
  - `ACTION_CLOSE = 1`：`account`、`beneficiary`、`proposer`
- 签名/验签规则：
  - 个人多签独立使用 `PersonalManage(7)` 与 `MODULE_TAG = b"per-mgmt"`
  - 投票统一走 `P-TX-003`
- 禁止兼容：不兼容旧 `OrganizationManage(17).propose_create_personal`，不兼容缺少 `regular_threshold` 的旧 `PersonalManage(7).propose_create`
- 禁止事项：
  - 禁止恢复 `OrganizationManage(17).call_index=3`
  - 禁止混用机构多签和个人多签 action 编号
  - 禁止 CitizenApp / CitizenWallet 保留旧个人多签创建交易载荷解析分支
- 必跑测试：
  - `cargo test --manifest-path citizenchain/Cargo.toml -p personal-manage --lib`
  - `citizenwallet/test/signer/payload_decoder_test.dart`
  - `flutter test test/governance/personal-manage/personal_manage_service_test.dart test/governance/personal-manage/personal_manage_storage_codec_test.dart`

##### P-TX-007：PersonalAdmins.propose_admin_set_change

- 状态：当前（仅个人多签）
- 类型：交易载荷格式
- 唯一真源：`citizenchain/runtime/admins/personal-admins/src/lib.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
- 生产者：
  - `citizenapp/lib/citizen/proposal/admins-change/codec/admin_set_change_call_codec.dart`
- 消费者：
  - `citizenchain/runtime/admins/personal-admins`
  - `citizenwallet/lib/signer/payload_decoder.dart`
- 字段：
  1. `institution_code`
  2. `account_id`
  3. `admins`（`Vec<Admin>`；每项固定为 `account_id + cid_number + family_name + given_name`）
  4. `new_threshold`
- 编码：
  - SCALE call data
  - pallet index：`29`（PersonalAdmins）
  - call index：`0`
  - 前两个字节：`[0x1d, 0x00]`
  - 布局：`institution_code:[u8;4] + account_id:[u8;32] + Compact<Vec<Admin>> + new_threshold:u32_le`；每个 `Admin` 按账户 32 字节、姓 SCALE bounded bytes、名 SCALE bounded bytes 的顺序编码。
- 签名/验签规则：
  - `new_threshold` 是管理员更换通过后写入投票引擎的目标动态阈值。
  - 个人多签阈值必须满足 `threshold * 2 > admins_len && threshold <= admins_len`。
  - 公权/私权机构不使用本 call；其统一四字段管理员人员集合由对应机构 admins pallet 独立保存，不能由 entity 岗位任职反向派生。
- 禁止兼容：不兼容缺少 `new_threshold` 的旧载荷。
- 禁止事项：
  - 禁止把本 call 用于任何公权或私权机构。
  - 禁止 CitizenWallet 公民钱包解码旧载荷或忽略尾部多余字节。
  - 禁止在 CitizenApp / CitizenWallet 内实现投票、计票或通过判定。
- 必跑测试：
  - `citizenapp/test/governance/admins-change/admins_change_codec_test.dart`
  - `citizenwallet/test/signer/payload_decoder_test.dart`

##### P-FEE-001：五类费用路由与付款账户

- 状态：当前
- 类型：费用分类、付款关系与签名尾协议
- 唯一真源：`citizenchain/runtime/primitives/src/fee_policy.rs::FeeRoute<AccountId, Balance>`
- 唯一路由：`citizenchain/runtime/src/configs.rs::RuntimeFeeRouter`
- 收费执行器：
  - 链上交易费、实际投票费：`citizenchain/runtime/transaction/onchain/src/lib.rs::OnchainChargeAdapter`
  - 投票回调中的链上资金执行费：`citizenchain/runtime/transaction/onchain/src/lib.rs::OnchainExecutionFeeCharger`
  - 链下清算费：`citizenchain/runtime/transaction/offchain/`
- 生产者：runtime `RuntimeCall` 路由
- 消费者：runtime 收费执行器、node 事件 RPC、CitizenApp 签名构造、CitizenWallet 冷签校验
- 类型：
  - `Free`
  - `Onchain { transaction_amount, payer }`
  - `Offchain { fee_amount, payer: OffchainFeePayer::BatchItemPayers }`
  - `Vote { payer }`
  - `Reject`
- 规则：
  - 机构发起提案、机构资料操作和机构账户操作统一为 `Onchain`，由 `actor_cid_number` 下唯一 `InstitutionFee` 账户支付最低 0.1 元。
  - 机构具体账户交易必须同时验证 `institution_account` / `funding_account` 属于同一 actor CID。
  - 机构签名者必须属于 `AdminAccounts[actor_cid_number].admins`，并对目标业务 `RoleSubject` 有有效任职和权限；管理员只负责签名，不是机构费用的回落付款人。
  - 实际 `cast_*` / 表决动作统一为 `Vote`，由投票签名者支付 1 元；发起提案不是投票。
  - Fullnode 不是机构，绑定或重绑奖励钱包由其自身签名者支付 0.1 元。
  - 链下清算批次允许多个付款公民；`BatchItemPayers` 明确表示每个 item 的 `payer` 从其 L2 存款支付该 item 的 `fee_amount`，收款方机构费用账户是收款账户，不得错误标成付款账户。
  - `TRANSACTION_TIP = 0`；非零 tip 在 runtime 入池/执行和 CitizenWallet 签名前双重拒绝。
  - `WeightToFee = 0`、`LengthToFee = 0`，不得引入五类之外的框架收费。
  - `OnchainFeeCharger` 只承接业务已核验的确切 `payer + transaction_amount`，不是第二套费用分类或付款路由；它必须复用 `fee_policy` 公式、统一分账与 `FeePaid` 事件。
  - 机构执行期手续费只从 actor CID 的费用账户支付，本金从明确的机构账户支付；个人多签执行期手续费由个人账户支付。扣费和本金变化必须原子执行，任何余额不足都失败，不得改扣管理员。
  - 任何路由、授权、CID/账户关系或费用账户解析失败都返回 `Reject`；不允许默认分类、可选付款人、付款人回落或双轨兼容。
- 签名尾：`era + Compact<nonce> + Compact<tip=0> + mode + additional_signed`；所有热签和冷签必须使用同一布局。
- 必跑测试：
  - `cargo test -p primitives -p onchain -p citizenchain -p chain-signing`
  - `cargo test -p node -p onchina`
  - CitizenApp / CitizenWallet `flutter test`、`flutter analyze`

##### P-AUTH-001：ROLE_SUBJECT

- 状态：共享类型与跨端 SCALE 已实现；内部、联合、选举、立法投票均已接入 `ProposalVotePlans`、岗位快照和完整岗位席位票据，现有正式业务入口已按岗位授权
- 类型：授权主体契约 / storage 契约 / 投票参与者契约
- 唯一真源：架构为 `../citizenwallet/CitizenWallet.md`；共享类型为 `citizenchain/runtime/entity/entity-primitives/src/institution_role.rs` 与 `citizenchain/runtime/votingengine/src/types.rs`；跨端字节金标为受保护测试资产 `citizenchain/runtime/primitives/tests/fixtures/role_permission.json`
- 详细文档：`历史实施记录《机构岗位权限与投票职责统一》（卡已删除，规范以本文为准）`
- 生产者：public/private entity、创世 seeder、依法通过的岗位治理业务模块
- 消费者：全部机构业务模块、votingengine、Node、OnChina、CitizenApp、CitizenWallet
- 字段：
  - `RoleSubject`：`cid_number`、`role_code`
  - `BusinessActionId`：`module_tag`、`action_code: u32`
  - `RoleBusinessPermission`：`role_subject`、`business_action_id`、`operation(Propose|Vote)`
  - `VotePlan`：`business_action_id`、`proposal_owner`、`proposer_subject`、`voter_subjects`、`voting_engine`、`business_object_hash: [u8; 32]`
  - `AuthorizationSubject`：`Institution(RoleSubject)` 或 `PersonalMultisig(personal_account)`
  - 动态岗位码生成状态：`InstitutionRoleNonce[cid_number]`、`UsedRoleCodes[(cid_number, role_code)]`
- 编码：结构字段按上述顺序 SCALE 编码；`action_code` 为 `u32` 小端；`RolePermissionOperation` 为 `Propose = 0`、`Vote = 1`；`AuthorizationSubject` 为 `Institution = 0`、`PersonalMultisig = 1`；`VotingEngineKind` 为 `Internal = 0`、`Joint = 1`、`Election = 2`、`Legislation = 3`
- VotePlan 校验：`proposal_owner == business_action_id.module_tag`；`voter_subjects` 为 1..256 项且完整主体不重复；机构与个人多签不可混用；个人多签的 proposer 和唯一 voter 必须是同一账户
- 金标：runtime/Node/OnChina/CitizenApp/CitizenWallet 统一读取 `citizenchain/runtime/primitives/tests/fixtures/role_permission.json`；客户端严格拒绝非法 UTF-8、非法枚举、越界长度、主体混用和尾随字节
- 动态岗位码：`R_<32 位大写十六进制>`；取 `blake2_256(SCALE(MODULE_TAG, cid_number, institution_role_nonce, proposal_id))` 前 16 字节。客户端不传 role_code，已用码永久不复用
- 授权规则：`origin ∈ admins`、有效任职和岗位业务权限三项全部满足；admins 单独命中没有权限
- 引擎规则：业务模块代码静态选择唯一投票引擎并绑定 VotePlan；调用方不得选择，投票引擎不得执行具体业务
- 联合投票 storage：`ProposalVotePlans[proposal_id]`、`VoterSnapshot[(proposal_id, RoleSubject)]`、`InstitutionTicketCountSnapshot[(proposal_id, cid_number)]`、`JointVotesByTicket[(proposal_id, InstitutionVoteTicket)]`；同 CID 多岗位按岗位票据分别记票，不按钱包合并
- 禁止兼容：不保留 admins 即授权、按 CID 全体 admins 投票、客户端自报 role_code 或自选投票引擎的旧路径
- 禁止事项：
  - 禁止用裸 `account_id`、裸 `cid_number` 或裸 `role_code` 代替完整 RoleSubject
  - 禁止修改岗位权限；变更权限必须删除旧动态岗位并生成新岗位码
  - 禁止删除 `UsedRoleCodes` 占用记录
  - 禁止把个人多签包装成机构 RoleSubject
- 必跑测试：共享类型与跨端 SCALE fixture；`votingengine`、`joint-vote`、`runtime-upgrade`、`resolution-issuance` 岗位快照/授权回归；目标 crate `no_std`；runtime 集成与 fresh 运行态验收

##### P-STORAGE-001：Admins.AdminAccounts

- 状态：当前
- 类型：storage 契约
- 唯一真源：`citizenchain/runtime/admins/{personal-admins,public-admins,private-admins}/src/lib.rs` + `citizenchain/runtime/admins/admin-primitives/src/lib.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
  - `../citizenapp/CitizenApp.md`
- 生产者：各管理员 pallet 生命周期接口与机构/个人创建流程
- 消费者：
  - `citizenchain/runtime`
  - `citizenchain/node`
  - `citizenapp/lib/citizen/proposal/admins-change/services/admin_account_service.dart`
  - `citizenapp/lib/citizen/shared/admin_account_storage_codec.dart`
- 字段：
  - 公权/私权机构 key：机构 `cid_number`；两类 value 都为 `institution_code + BoundedVec<Admin>`，每项固定为 `account_id + cid_number + family_name + given_name`，其中项内 CID 是管理员公民 CID 引用。两类均不重复保存机构 CID、主账户或生命周期状态。
  - 个人多签 key：`personal_account`；value：独立 `AdminAccount`，字段为 `cid_number`（固定空）、`institution_code`、`kind`、`admins`、`creator`、`created_at`、`updated_at`、`status`。
  - 机构岗位、任期和任职来源不进入 AdminAccounts，统一读取 entity 的 `InstitutionRoles` 与 `InstitutionRoleAssignments`。
- 编码：
  - 机构 storage key：`twox128(PublicAdmins|PrivateAdmins) ++ twox128("AdminAccounts") ++ blake2_128_concat(cid_number)`。
  - 个人 storage key：`twox128(PersonalAdmins) ++ twox128("AdminAccounts") ++ blake2_128_concat(personal_account)`。
  - value：SCALE
- 签名/验签规则：storage 本身不签名；写入必须来自链上授权流程
- 禁止兼容：不兼容旧 `AdminsChange::Subjects / AdminsChange::Institutions` 当前路径
- 禁止事项：
  - 禁止恢复 `AdminsChange` 单 pallet 当前真源叙述
  - 禁止恢复机构 `AdminProfile`、机构 `creator/created_at/updated_at` 或岗位来源副本
  - 禁止只凭 `UNIN/SFGT/SFGP` 自动选择 `PrivateAdmins`
- 必跑测试：
  - `public-admins`、`private-admins`、`personal-admins` 单测
  - CitizenApp 多签发现相关测试

##### P-STORAGE-002：PublicManage/PrivateManage.InstitutionAccounts

- 状态：当前(机构生命周期已拆 PublicManage(idx30)/PrivateManage(idx31),storage 名不变但前缀随 pallet 名变;取代旧 `OrganizationManage`)
- 类型：storage 契约
- 唯一真源：
  - `citizenchain/runtime/entity/public-manage/src/lib.rs`(公权机构)
  - `citizenchain/runtime/entity/private-manage/src/lib.rs`(私权机构)
- 详细文档：
  - `../citizenchain/CitizenChainNode.md`
- 生产者：`public-manage` / `private-manage`
- 消费者：
  - `citizenchain/node/src/transaction/offchain_transaction/institution_read/chain.rs`(按机构码路由 PublicManage/PrivateManage 前缀)
  - `citizenapp` 机构读共享核心 storage codec(C 阶段三分后,按机构码路由前缀)
- 字段：
  - key1：`cid_number`
  - key2：`account_name`
  - value：机构账户信息，以 runtime 类型为准
- 同 pallet 的 `Institutions[cid_number] → InstitutionInfo`（法定代表人已收口为 entity 原子结构）：
  - value 字段顺序固定为 `cid_full_name`、`cid_short_name`、`town_code`、`legal_representative: Option<LegalRepresentative>`、`institution_code`、`created_at`（6 项，不保存重复生命周期状态）
  - `LegalRepresentative` 字段顺序固定为 `family_name`、`given_name`、`cid_number`、`account`；整个结构同时存在或为 `None`，不得保存拼接姓名或分裂可选字段
  - 已删 `main_account`/`fee_account`/`admins`/`admins_len`/`threshold`/`creator`/`account_count`：主/费账户由派生且在 `InstitutionAccounts`；管理员真源在 admins 模块；机构阈值真源在同一 entity 的 `InstitutionGovernanceThresholds`
  - 消费方镜像须按机构码路由 PublicManage/PrivateManage 前缀；node、OnChina、CitizenApp、CitizenWallet 已按上述 6 字段及嵌套法定代表人 SCALE 顺序对齐
- 同 pallet 的岗位与任职 storage：
  - `InstitutionRoles[cid_number][role_code] → InstitutionRole`
  - `InstitutionRolePermissions[cid_number][role_code] → BoundedVec<RoleBusinessPermission>`
  - `InstitutionRoleAssignments[cid_number][role_code] → BoundedVec<InstitutionAdminAssignment>`
  - `InstitutionRoleNonce[cid_number] → u64`；动态岗位生成时单调递增
  - `UsedRoleCodes[cid_number][role_code] → bool`；一经使用永久保留，删除岗位不释放
  - `InstitutionRole` 字段顺序：`cid_number`、`role_code`、`role_name`、`term_required`、`role_status`
  - `InstitutionAdminAssignment` 字段顺序：`cid_number`、`account_id`、`role_code`、`term_start:u32`、`term_end:u32`、`assignment_source`、`assignment_source_ref`、`assignment_status`
  - `term_required=true` 时任职有效窗口为 UTC 日闭区间 `[term_start, term_end]`，允许同日起止；`term_required=false` 时必须精确为 `0/0`。
  - 普选/互选结果整体替换目标岗位的有效任职；任职账户必须属于同机构既有 admins，结果不得修改 admins storage。
- 编码：
  - double map storage key(前缀 = `twox_128(PublicManage|PrivateManage)` ++ `twox_128(InstitutionAccounts|Institutions)`)
  - value：SCALE
- 签名/验签规则：storage 本身不签名；岗位治理交易必须覆盖完整 mutation、权限规格、初始任职和提案上下文，动态岗位码只由 runtime 在执行结果时生成
- 禁止兼容：不兼容旧 `Accounts` mirror、不兼容旧 `OrganizationManage` 前缀
- 禁止事项：
  - 禁止活跃代码继续读取已删的 `OrganizationManage::Institutions/InstitutionAccounts`
  - 禁止把机构账户当个人多签账户读取
- 必跑测试：
  - `cargo check -p node`(institution_read 前缀路由)
  - `cargo test --manifest-path citizenchain/node/Cargo.toml cid_lifecycle`（节点守卫镜像与三字段完整性）
  - `public-manage` / `private-manage` 单测

##### P-STORAGE-003：PersonalManage.PersonalAccounts

- 状态：当前
- 类型：storage 契约
- 唯一真源：`citizenchain/runtime/private/personal-manage/src/lib.rs`
- 详细文档：
  - `../citizenchain/CitizenChainRuntime.md`
- 生产者：`personal-manage`
- 消费者：
  - `citizenapp/lib/transaction/personal-manage/personal_manage_storage_codec.dart`
  - `citizenapp/lib/transaction/personal-manage/personal_manage_service.dart`
- 字段：
  - key：`personal_account`
  - value：`Account { creator, account_name, created_at, status }`
- 编码：
  - storage map key
  - value：SCALE
- 签名/验签规则：storage 本身不签名；创建和关闭由 `PersonalManage` 提案流程约束
- 禁止兼容：不兼容旧 `OrganizationManage` 个人多签路径
- 禁止事项：
  - 禁止恢复 `OrganizationManage(17).propose_create_personal`
  - 禁止恢复已删除的个人多签反向索引 storage
  - 禁止把个人多签查询落回机构账户 storage
- 必跑测试：
  - `cargo test --manifest-path citizenchain/Cargo.toml -p personal-manage --lib`
  - `flutter test test/governance/personal-manage/personal_manage_service_test.dart test/governance/personal-manage/personal_manage_storage_codec_test.dart`

##### P-STORAGE-004：Account-level internal admin account（待 ADR-039 机构部分取代）

- 状态：当前实现；机构授权与机构投票主体部分已由 P-AUTH-001 取代并待迁移，个人多签部分继续有效
- 类型：storage 契约 / subject id 契约
- 唯一真源：`../citizenwallet/CitizenWallet.md`
- 详细文档：
  - `../citizenwallet/CitizenWallet.md`
  - `../citizenchain/CitizenChainRuntime.md`
  - `../citizenchain/CitizenChainRuntime.md`
- 生产者：
  - `citizenchain/runtime/admins/admin-primitives`
  - `citizenchain/runtime/admins/{public-admins,private-admins,personal-admins}`
  - `citizenchain/runtime/entity/personal-manage`
  - `citizenchain/runtime/entity/public-manage`
  - `citizenchain/runtime/entity/private-manage`
- 消费者：
  - `citizenchain/runtime/votingengine/internal-vote`
  - `citizenchain/runtime/transaction/*`
  - `citizenapp`
  - `citizenwallet`
- 字段：
  - 机构主体：`actor_cid_number` / `cid_number`
  - 机构具体资产操作账户：`institution_account` / `funding_account`
  - 个人多签主体：`personal_account`
  - `admins`
  - `admins_len`
  - `threshold`
  - `status`
- 编码：
  - 机构以 `cid_number` 作为 `AdminAccounts` 和 public/private entity `InstitutionGovernanceThresholds` key；主账户、费用账户和制度专属账户都只是该 CID 下的账户，不建立独立管理员集合。
  - 公权、私权、个人多签分别存放在 `PublicAdmins`、`PrivateAdmins`、`PersonalAdmins`。
  - 公权、私权机构管理员项统一为 `Admin { account_id, cid_number, family_name, given_name }`；非空公民 CID 必须由 `citizen-identity` 确认 CTZN CID↔账户绑定。个人多签复用同一 SCALE 结构，但不属于机构管理员，其可空字段按个人多签规则处理。
  - 机构 `admins` 是独立可任职人员集合，不从岗位任职派生，也不直接授权；个人多签管理员集合继续由 `PersonalAdmins.propose_admin_set_change` 治理。
- 签名/验签规则：
  - 机构实行一个岗位任职席位一票，票据主体为 `RoleSubject + account_id`；同一账户兼任多岗时可用同一私钥分别行使各岗票权。机构投票资格由业务模块 VotePlan 指定的 `RoleSubject` 有效任职快照决定，不能锁定 CID 的全体 admins；个人多签仍按 `personal_account_id` 的管理员账户一人一票。
  - 公权/私权机构读取对应 entity 的 `InstitutionGovernanceThresholds[cid_number]`，个人多签读取 `ActivePersonalThresholds[personal_account_id]`；机构阈值与 admins 账户数解耦。
  - 机构任职结果只允许沿用既有阈值，不能创建或修改阈值制度。
- 禁止兼容：不保留机构 `AdminProfile`、机构 Pending 管理员变更或旧管理员集合 call
- 禁止事项：
  - 禁止省储行永久质押账户进入内部投票
  - 禁止给任一机构账户建立第二套管理员集合，禁止用主账户替代 CID 授权
  - 禁止业务模块绕过 entity 直接改机构 admins
  - 禁止把个人多签管理员模型混入机构岗位任职
  - 禁止继续用 CID 全体 admins 作为机构投票主体
- 必跑测试：
  - `cargo test -p public-admins -p private-admins -p personal-admins --lib`
  - `cargo test -p primitives --lib`
  - `cargo test -p internal-vote --lib`
  - `cargo test -p personal-manage --lib`
  - `cargo test -p public-manage --lib`
  - `cargo test -p private-manage --lib`

##### P-TX-008：GmbPqcAuth bootstrap（未绑定账户首次无感绑定+执行）

- 状态：草案（ADR-022，待实现）
- 类型：交易载荷格式（General Transaction + `GmbPqcAuth` 扩展 `extra`）
- 唯一真源：`GmbPqcAuth` TransactionExtension + `account-keys` pallet（待实现）
- 详细文档：`../citizenwallet/CitizenWallet.md`
- 生产者：`citizenapp`、`citizenwallet`　消费者：`GmbPqcAuth` 扩展 + `account-keys`、`citizenwallet` decoder
- 字段（扩展 extra）：`account`、`pqc_pubkey`(ML-DSA-65,~1952B)、`alg`(0x02)、`key_version`、`nonce`、`sr25519_bootstrap_signature`、`ml_dsa_signature`（业务 call 是普通 General Transaction call）
- 编码：General Transaction + `GmbPqcAuth` 扩展 `extra`（**非 pallet call**）
- payload 使用 bootstrap 专用 `op_tag` 并调用 `signing_message(op_tag)`；字段集与普通 PQC 交易对齐：`genesis_hash`、`spec_version`、`transaction_version`、`account`、`pqc_pubkey_hash`、`key_version`、`nonce`、`era_or_deadline`、`tip`、`call_hash`、`following_extensions_hash`
- 规则（验序钉死，hash 全 `blake2_256`）：
  - ① `blake2_256(body.pqc_pubkey) == payload.pqc_pubkey_hash`
  - ② `sr25519_bootstrap_signature = sr25519_sign(signing_message(bootstrap_op_tag, SCALE(genesis_hash,spec_version,transaction_version,account,pqc_pubkey_hash,key_version,nonce,call_hash,following_extensions_hash)))`——**sr25519 必须覆盖 pqc_pubkey_hash**（防 body 公钥替换），`account`=sr25519 公钥派生的当前 AccountId
  - ③ `ml_dsa_signature` 验交易 payload + `call_hash==blake2_256(body.call)`，且**反向覆盖 `blake2_256(sr25519_bootstrap_signature)`**（双向交叉绑定）
  - 三验过 → origin 转 `Signed(account)` → nonce/扣费/业务 dispatch；**绑定写 `AccountPqcKey` 在 `post_dispatch`**
  - 失败语义：绑定在 post_dispatch（nonce/扣费已跑），**内层 call 失败绑定仍保留、内层失败照常收费**；🔴 **post_dispatch 绝不返回 Err**（否则作废整区块），冲突（已绑定不同值）判定前移 validate 拒
  - 🔴 bootstrap 账户须 providers/sufficients>0（否则 CheckNonce 以 Payment 先拒）；body 长度上限硬校验 + 未绑定按 (account,source) 限速
  - 已绑定账户拒绝再次 sr25519 覆盖（first-bind-wins）
  - extrinsic body 携带完整 ML-DSA 公钥（~1952B）+ sr25519 bootstrap 签名（64B）+ ML-DSA 交易签名（~3309B）
- 禁止：扩 `MultiSignature`；用 PQC 公钥/hash 派生新 AccountId；CID 托管助记词/私钥
- 必跑测试：bootstrap 双签成功/拒绝、已绑定拒覆盖、写表+派发原子性

##### P-TX-009：GmbPqcAuth PQC 交易（已绑定账户）

- 状态：草案（ADR-022，待实现）
- 类型：交易载荷格式（General Transaction + `GmbPqcAuth` 扩展 `extra`）
- 唯一真源：`GmbPqcAuth` TransactionExtension（待实现）
- 详细文档：`../citizenwallet/CitizenWallet.md`
- 生产者：`citizenapp`、`citizenwallet`　消费者：`GmbPqcAuth` 扩展、`citizenwallet` decoder
- 字段（扩展 extra）：`account`、`sig`(ML-DSA-65；公钥由链端按 account 从 `AccountPqcKey` 读，交易不带公钥)、`auth_mode`、`key_version`（业务 call 是普通 General Transaction call）
- 编码：General Transaction + `GmbPqcAuth` 扩展 `extra`（**非 pallet call**）
- payload 使用普通 PQC 交易专用 `op_tag` 并调用 `signing_message(op_tag)`：`genesis_hash`、`spec_version`、`transaction_version`、`account`、`nonce`、`era_or_deadline`、`tip`、`call_hash`、`key_version`、`following_extensions_hash`（`ss58_format` 为纯展示字段，链上无对应 implicit，不参与一致性比对）
- 规则（路线 A 定稿）：
  - `GmbPqcAuth` 读 `AccountPqcKey[account].pubkey` 验 ML-DSA 签名 + `call_hash==blake2_256(body.call)` + `alg==AccountPqcKey.alg`（防降级） → **把 origin 转 `Signed(account)`** → 后续 `CheckNonce`/`ChargeTransactionPayment` 走系统标准逻辑
  - 🔴 `following_extensions_hash` = SDK `inherited_implication` **精确递归编码**（`ImplicationParts{base,explicit,implicit}`，非扁平拼接；嵌套 tuple 下与链端 `inherited_implication.encode()` 逐字节对拍 `mod.rs:712-869`），覆盖 CheckGenesis/CheckMortality(immortal→genesis)/CheckNonce/ChargeTransactionPayment/CheckMetadataHash(Disabled→None)/WeightReclaim 等 implicit
  - 🔴 **tuple 12 上限**：嵌套 `(GmbPqcAuth, AuthorizeCall)` 占第一项槽位，不加第 13 项；`GmbPqcAuth` 兼管"已绑定拒 sr25519"；`extra=None` 透明放行原 origin 给 AuthorizeCall
  - txpool `provides=(account,nonce)` 由 CheckNonce 自动产生（GmbPqcAuth 不重复设）；**era 默认 immortal**（CheckMortality.implicit 仍 genesis，纳入 hash）
  - `weight()` 按 extra 变体路由 card1 benchmark 常量（禁读 state）；PqcPolicy 缺失 fail-open（不冻结全链）；`validate` 轻量无副作用
- 禁止：跳过 `nonce`/`genesis_hash` 域隔离；decoder 解码后仍有剩余字节
- 必跑测试：authorize 成功/拒绝、nonce 防重放、`citizenwallet` decoder

##### P-STORAGE-005：account-keys.AccountPqcKey

- 状态：草案（ADR-022，待实现）
- 类型：storage 契约　唯一真源：account-keys pallet（待实现）
- 详细文档：`../citizenwallet/CitizenWallet.md`
- 生产者：`GmbPqcAuth`（bootstrap `post_dispatch` 写）+ `account-keys`（轮换 call 写）　消费者：`GmbPqcAuth`（PQC 交易验签读）、`offchain-transaction`（批签取公钥）
- **pallet_index=35**（契约真源；当前 runtime 最高 idx=34，下一空号=35）
- 字段：
  - key：`AccountId`（sr25519 锚点）
  - value：`alg:u8`(0x02)、`key_version:u32`、`pubkey:BoundedVec<u8,ConstU32<2048>>`(完整 ML-DSA-65 公钥 ~1952B)、`bound_at:BlockNumber`（**删 bootstrap_mode**）
  - 另有 `PqcPolicy` storage（phase/bootstrap_deadline/reject_sr25519_when_bound/allow_bootstrap_unbound，安全默认 phase=B/reject=false/allow=true/deadline=None）
- 编码：SCALE，`StorageMap<Blake2_128Concat, AccountId, AccountPqcKeyRecord>`
- 规则：存完整公钥（非 hash）；first-bind-wins（冲突在 validate 拒）；**轮换双签**：当前 PQC 私钥授权 + 新私钥对 `(新公钥+key_version+account+genesis)` 自签 PoP，两签过才 `key_version++`；**账户不派生 ML-KEM**（决策3）；绑定后无 sr25519 回退恢复（决策1/2）
- 禁止：存私钥；用 PQC 公钥（或其 hash）当 AccountId；给账户加签名算法 state 字段（阶段策略在链层 A/B/C/D 治理，不做 per-account 状态切换）
- 必跑测试：`account-keys` pallet 单测、`offchain-transaction` 批签集成测试

#### 6. 登记维护要求

新增或修改协议时，必须在本文件按编号登记；无法确认字段时必须先向用户报告，不得把未确认字段写成当前协议。

---
