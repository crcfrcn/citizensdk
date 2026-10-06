#!/usr/bin/env node

// CitizenSDK 确定性候选打包器。源码只读，所有候选和归档必须落在源码树之外。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { gzipSync, inflateRawSync } from 'node:zlib';
import {
  copyFileSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_ID = 'citizensdk';
const PACKAGE_NAME = 'citizen_sdk';
// 正式产品名和包内平台名称不随调用方选择的源码外目录改变。
// 独立于任何 binding 源码的 Flutter v2 无UI公共面金标。五份绑定都必须从自己的
// 权威常量/方法表解析并逐项匹配；不能用一端源码生成另一端预期值。
const FLUTTER_METHOD_CHANNEL = 'citizen/sdk/core/v2';
const FLUTTER_EVENT_CHANNEL = 'citizen/sdk/events/v2';
const FLUTTER_METHODS = Object.freeze([
  'open',
  'start',
  'stop',
  'close',
  'getCapabilities',
  'getFinalizedHead',
  'getSyncStatus',
  'getBestHead',
  'getFinalizedBlockAt',
  'resolveFinalizedBlock',
  'getBlockHeader',
  'getBlockBody',
  'getRuntimeContext',
  'getStorage',
  'getStorageBatch',
  'getStorageKeysPaged',
  'callRuntimeApi',
  'getSystemEvents',
  'exportState',
  'importState',
  'getGenesisHash',
  'getAccountBalance',
  'getAccountBalances',
  'getAccountNonce',
  'getFeeSnapshot',
  'getWalletState',
  'inspectWallets',
  'releaseWalletInspection',
  'repairHotWallet',
  'renameDiagnosticWallet',
  'deleteDiagnosticWallet',
  'validateWalletPassword',
  'validateWalletMnemonic',
  'walletWordSuggestions',
  'prepareWalletCreation',
  'copyRecoveryPhrase',
  'commitWalletCreation',
  'releasePreparedWallet',
  'openPrivateKey',
  'revealPrivateKey',
  'closePrivateKey',
  'cancelOperation',
  'respondCredential',
  'cancelCredential',
  'addNextWalletAccount',
  'signAndDeleteWallet',
  'importColdAccountCode',
  'importColdAccountId',
  'importColdAccountSs58',
  'reorderWalletAccountsWithoutDefaultChange',
  'setActiveWallet',
  'renameWallet',
  'renameAccount',
  'deleteAccount',
  'importWallet',
  'addWalletAccounts',
  'setActiveWalletAccount',
  'deleteWallet',
  'reconcileWalletCleanup',
  'signWalletPayload',
  'deriveApplicationKey',
  'deriveApplicationKeys',
  'prepareApplicationKeys',
  'beginSigning',
  'consumeExternalSignature',
  'cancelSigning',
  'beginDefaultAccountChange',
  'consumeDefaultAccountChange',
  'verifySignature',
  'encodeSigningPayload',
  'qrEncodeDocument',
  'qrPrepareAccountAuthorization',
  'prepareTransaction',
  'cancelPreparedTransaction',
  'executePreparedTransaction',
  'consumePreparedTransactionQrResponse',
  'cancelPreparedTransactionExecution',
  'getTransactionHistory',
  'syncTransactionHistory',
  'qrParse',
  'qrCreateSignRequest',
  'qrValidateSignResponse',
  'qrConsumeSignResponse',
  'qrCancelSignRequest',
  'qrEncodeAccountId',
  'qrDecodeLuminance',
  'qrEncode',
  'reviewQrRequest',
  'releaseQrReview',
  'openQrCapture',
  'closeQrCapture',
  'pauseQrCapture',
  'resumeQrCapture',
  'setQrCaptureTorch',
  'qrDecodeImage',
  'signQrRequest',
]);
const ROOT_FILES = [
  '.gitignore',
  '.pubignore',
  'Cargo.lock',
  'Cargo.toml',
  'LICENSE',
  'LICENSE-GPL-3.0',
  'LICENSE-MIT',
  'README.md',
  'pubspec.lock',
  'pubspec.yaml',
];
const ROOT_DIRECTORIES = [
  'android',
  'chain',
  'darwin',
  'include',
  'lib',
  'linux',
  'native',
  'scripts',
  'test',
  'windows',
];
const FORBIDDEN_DIRECTORIES = new Set([
  '.build', '.dart_tool', '.gradle', '.kotlin', '.swiftpm', 'CitizenSDK.xcframework',
  'DerivedData', 'Pods', 'build', 'target', 'xcuserdata',
]);
const NATIVE_FILES = Object.freeze({
  'android/citizensdk.aar': 'android/citizensdk.aar',
  'android/src/main/jniLibs/arm64-v8a/libcitizensdk.so': 'android/arm64-v8a/libcitizensdk.so',
  'android/src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so': 'android/arm64-v8a/libcitizensdk_jni.so',
});
// Apple 三个 arm64 技术变体作为一个目录原子注入；源码树只保存 Swift/Flutter
// consumer，唯一 native/ffi Core 只存在于这一个 XCFramework 产物中。
const NATIVE_DIRECTORIES = Object.freeze({
  'darwin/CitizenSDK.xcframework': 'apple/CitizenSDK.xcframework',
});
const RELEASE_PLATFORMS = Object.freeze(['Android', 'iOS', 'macOS', 'LinuxARM', 'LinuxAMD', 'Windows']);
const LINUX_PLATFORMS = Object.freeze(['LinuxARM', 'LinuxAMD']);
const LINUX_HOST_HEADERS = Object.freeze([
  'citizen_sdk.hpp', 'citizen_sdk_config.hpp', 'citizen_sdk_error.hpp',
  'citizen_sdk_events.hpp', 'citizen_sdk_models.hpp',
  'citizensdk_host.h',
]);
const LINUX_CMAKE_FILES = Object.freeze([
  'CitizenSDKConfig.cmake', 'CitizenSDKConfigVersion.cmake',
  'CitizenSDKDependencies.cmake', 'CitizenSDKTargets.cmake',
  'CitizenSDKTargets-release.cmake',
]);
// 一个产品的两个机器变体：各自完整的 19 项安装前缀合并为 26 项。
// 安装头文件保持公开 include 命名空间，并逐字节对拍扁平源码头文件。
function linuxInstallPaths(platform) {
  return [
    'include/citizensdk.h', 'include/citizensdk_types.h', 'include/citizensdk_qr_image.h',
    ...LINUX_HOST_HEADERS.map((name) => `include/citizen_sdk/${name}`),
    `lib/${platform}/libcitizensdk.so`, `lib/${platform}/libcitizensdk_host.so`,
    ...LINUX_CMAKE_FILES.map((name) => `lib/${platform}/cmake/CitizenSDK/${name}`),
    ...['manifest.json', 'chainspec.json', 'light_sync_state.json']
      .map((name) => `share/citizensdk/chain/${name}`),
  ].sort();
}
const LINUX_RELEASE_FILES = Object.freeze([...new Set(
  LINUX_PLATFORMS.flatMap(linuxInstallPaths),
)].sort());
const LINUX_INJECTED_FILES = new Set(LINUX_RELEASE_FILES);
const HOSTED_LINUX_PLUGIN_FILES = Object.freeze([
  'CMakeLists.txt', 'cmake/CitizenSDKFlutter.cmake',
  'citizen_sdk/citizen_sdk_plugin.h', 'src/citizen_sdk_plugin.cc',
  ...['codec', 'sessions', 'environment'].flatMap(
    (name) => ['cc', 'hpp'].map((extension) => `src/citizen_sdk_flutter_${name}.${extension}`),
  ),
]);
const WINDOWS_HOST_HEADERS = Object.freeze([
  'citizen_sdk.hpp', 'citizen_sdk_config.hpp', 'citizen_sdk_error.hpp',
  'citizen_sdk_events.hpp', 'citizen_sdk_models.hpp',
  'citizensdk_host.h',
]);
const WINDOWS_CMAKE_FILES = Object.freeze([
  'CitizenSDKConfig.cmake', 'CitizenSDKConfigVersion.cmake',
  'CitizenSDKDependencies.cmake', 'CitizenSDKTargets.cmake', 'CitizenSDKTargets-release.cmake',
]);
const WINDOWS_RELEASE_FILES = Object.freeze([
  'include/citizensdk.h', 'include/citizensdk_types.h', 'include/citizensdk_qr_image.h',
  ...WINDOWS_HOST_HEADERS.map((name) => `include/citizen_sdk/${name}`),
  'bin/Windows/citizensdk.dll', 'bin/Windows/citizensdk_host.dll',
  'lib/Windows/citizensdk.dll.lib', 'lib/Windows/citizensdk_host.lib',
  ...WINDOWS_CMAKE_FILES.map((name) => `lib/Windows/cmake/CitizenSDK/${name}`),
  ...['manifest.json', 'chainspec.json', 'light_sync_state.json']
    .map((name) => `share/citizensdk/chain/${name}`),
].sort());
const WINDOWS_INJECTED_FILES = new Set(WINDOWS_RELEASE_FILES);
const HOSTED_WINDOWS_PLUGIN_FILES = Object.freeze([
  'CMakeLists.txt', 'cmake/CitizenSDKFlutter.cmake',
  'citizen_sdk/citizen_sdk_plugin.h', 'src/citizen_sdk_plugin.cc',
  ...['codec', 'sessions', 'environment'].flatMap(
    (name) => ['cc', 'hpp'].map((extension) => `src/citizen_sdk_flutter_${name}.${extension}`),
  ),
]);
function parentDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      directories.add(parent);
    }
  }
  return [...directories].sort();
}
const APPLE_XCFRAMEWORK_PATH = 'darwin/CitizenSDK.xcframework';
// LibraryIdentifier 由 xcodebuild 生成，必须视为不透明技术标识。
// 下列合同只依赖 Apple 官方 SupportedPlatform/
// SupportedPlatformVariant 元数据，不使用产品名伪造目录标识。
const APPLE_SLICES = Object.freeze([
  Object.freeze({
    label: 'CitizenSDK iOS（设备技术变体）',
    binaryPath: 'CitizenSDK.framework/CitizenSDK',
    bundlePlatform: 'iPhoneOS',
    dtPlatform: 'iphoneos',
    minimum: '16.0.0',
    minimumKey: 'MinimumOSVersion',
    installName: '@rpath/CitizenSDK.framework/CitizenSDK',
    module: 'arm64-apple-ios',
    platform: 2,
    supportedPlatform: 'ios',
    swiftTarget: 'arm64-apple-ios16.0',
    variant: null,
  }),
  Object.freeze({
    label: 'CitizenSDK iOS（simulator 技术变体）',
    binaryPath: 'CitizenSDK.framework/CitizenSDK',
    bundlePlatform: 'iPhoneSimulator',
    dtPlatform: 'iphonesimulator',
    minimum: '16.0.0',
    minimumKey: 'MinimumOSVersion',
    installName: '@rpath/CitizenSDK.framework/CitizenSDK',
    module: 'arm64-apple-ios-simulator',
    platform: 7,
    supportedPlatform: 'ios',
    swiftTarget: 'arm64-apple-ios16.0-simulator',
    variant: 'simulator',
  }),
  Object.freeze({
    label: 'CitizenSDK macOS',
    binaryPath: 'CitizenSDK.framework/Versions/A/CitizenSDK',
    bundlePlatform: 'MacOSX',
    dtPlatform: 'macosx',
    minimum: '13.0.0',
    minimumKey: 'LSMinimumSystemVersion',
    installName: '@rpath/CitizenSDK.framework/Versions/A/CitizenSDK',
    module: 'arm64-apple-macos',
    platform: 1,
    supportedPlatform: 'macos',
    swiftTarget: 'arm64-apple-macosx13.0',
    variant: null,
  }),
]);
const APPLE_RESOURCE_FILES = Object.freeze({
  'PrivacyInfo.xcprivacy': 'darwin/Sources/CitizenSDK/PrivacyInfo.xcprivacy',
  'chain/chainspec.json': 'chain/chainspec.json',
  'chain/light_sync_state.json': 'chain/light_sync_state.json',
  'chain/manifest.json': 'chain/manifest.json',
});
// macOS framework 必须采用 Apple 标准版本化布局。只有这五个 bundle 内部
// 相对链接属于正式产物；iOS device/Simulator slice、XCFramework 其余位置和
// SDK 源码继续保持零符号链接。固定目标还能同时拒绝绝对路径、`..`、悬空链接
// 和指向 framework 外部的设备文件。
const APPLE_MACOS_FRAMEWORK_SYMLINKS = Object.freeze({
  CitizenSDK: 'Versions/Current/CitizenSDK',
  Headers: 'Versions/Current/Headers',
  Modules: 'Versions/Current/Modules',
  Resources: 'Versions/Current/Resources',
  'Versions/Current': 'A',
});
// 每个 Apple slice 必须携带 Swift 编译器生成的完整六文件模块闭包。
// 任何 sidecar 缺失都会破坏同编译器快速导入、ABI 审计或源码信息；允许额外
// 节点又会把未经审查的架构/模块混入单一 arm64 产物，因此这里使用精确集合。
const APPLE_SWIFT_MODULE_EXTENSIONS = Object.freeze([
  'abi.json',
  'private.swiftinterface',
  'swiftdoc',
  'swiftinterface',
  'swiftmodule',
  'swiftsourceinfo',
]);
// 两份运行时信任锚必须与 CitizenApp 已验证链资产逐字节一致；manifest 再把
// CitizenSDK 产品、CitizenChain 正式链身份、genesis 和两个摘要固定为一个闭集。
const CHAIN_ASSET_FILES = Object.freeze({
  'chain/chainspec.json': '6ae934933682a8ffca78663dd4391a730b6ae219bd12abfb5d96b4d8154fc2e0',
  'chain/light_sync_state.json': '014802836a0f6e01a9f1bf7173b8e04c9df8fc3f057565f855abdccdc7361ab6',
  'chain/manifest.json': '73983825dbefac4a74102c80db9913f0ea27ca952eaa110d276ad1c8854835d8',
});
const CHAIN_ASSET_MANIFEST = Object.freeze({
  format_version: 1,
  product_id: 'citizensdk',
  chain_id: 'citizenchain',
  protocol_id: 'citizenchain',
  genesis_hash: '0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd',
  chainspec_sha256: CHAIN_ASSET_FILES['chain/chainspec.json'],
  light_sync_state_sha256: CHAIN_ASSET_FILES['chain/light_sync_state.json'],
  sdk_min_version: '1.0.0',
});
// 真实 Substrate v14 System.Events metadata 夹具及 CitizenChain Runtime 生产
// metadata/events 对为正式解码输入；测试与夹具同时改写不能绕过
// Release 的来源守卫。
const SOURCE_FIXTURE_FILES = Object.freeze({
  'test/transaction/citizenchain-balance-fee-v1.json': '2cd5e648703c8cc389c59f07753470b63c034f7cfa63dac8ffa596c8128a0033',
  'test/transaction/citizenchain-revive-v15-metadata.hex': '6c697a80d160ccec859941c9d79ff926c3ff7f36c41da0b621789d6ed663a820',
  'test/transaction/citizenchain-runtime-system-events.hex': '2c4d04a69ff994622877786d481dc4780b7a32795e5f7cfa070ae4acb72679ef',
  'test/transaction/citizenchain-runtime-v14-metadata.hex': 'da62207dfa342ce5285bb214a116761fd0a38c7c329ab8953506ad52471ed681',
  'test/transaction/citizenchain-transfer-build-v1.json': 'c43a1f01c22556d2b1e172088fb540358c25b9554c91ffc71f7b483fcd5a469b',
  'test/transaction/substrate-v14-system-events-metadata.hex': '95b368e7907511b28ba283a6741f4be551b56fb917c2f0183b4143dbe0ebf95b',
  'test/wallet/citizenchain-wallet-derivation-v1.json': '2d9bd9f5feeacea729154475475e0d4525e594bc88ede3a86494ffaf35301769',
  'test/wallet/citizenchain-wallet-password-v1.json': '0f8427f6ca542625626c7c1615608eef19246db496c4bb819937f15cfdec7250',
});
// Release 必须保留根级许可入口和两份权威许可证原文；仅检查文件名存在会允许法律文本被替换。
const LICENSE_SOURCE_FILES = Object.freeze({
  'LICENSE': 'e9eb718f475c5f56d4e529253459097b9ebde487a20ff7968e379dd6de02e60f',
  'LICENSE-GPL-3.0': 'aab56b4a581fc1c50b7c782eacf2fc8be05a47cd98e4bf4d836dd9b6dd9c86f4',
  'LICENSE-MIT': 'c2c4f9ec96b1908f3121e63c94c9b1e8ba4a55035acb55749bf51bcef2774e18',
});
// Hosted Package 不建立第二份候选：官方 Dart 发布工具直接读取已注入 Android/Apple
// 原生库的 GitHub Release 候选，并由这份固定 .pubignore 只筛出运行时闭包。
const HOSTED_PACKAGE_SOURCE_FILES = Object.freeze({
  '.pubignore': '39e7f37587279ea5a1a40c0379a4051cb92aba63ea9e5cc10a0dbc10dc45567b',
});
// pub.dev/Hosted 包只公开产品 API、公开模型、固定 Flutter tuple 与无秘密
// AccountId/SS58 codec。其余 Dart 来源继续留在 GitHub 审计包作迁移差分，
// 但必须被真实 .pubignore 投影排除，宿主不能 implementation-import 绕过 C ABI。
const HOSTED_RUNTIME_DART_FILES = Object.freeze([
  'lib/citizen_sdk.dart',
  'lib/src/api/citizen_chain.dart',
  'lib/src/api/citizen_qr.dart',
  'lib/src/api/citizen_sdk.dart',
  'lib/src/api/citizen_sdk_error.dart',
  'lib/src/api/citizen_sdk_events.dart',
  'lib/src/api/citizen_transactions.dart',
  'lib/src/api/citizen_sdk_wallet.dart',
  'lib/src/account_codec.dart',
  'lib/src/models/citizen_account.dart',
  'lib/src/models/citizen_capability.dart',
  'lib/src/models/citizen_chain_state.dart',
  'lib/src/models/citizen_signing.dart',
  'lib/src/models/citizen_transaction.dart',
  'lib/src/models/citizen_wallet.dart',
  'lib/src/platform/citizen_sdk_flutter_codec.dart',
  'lib/src/platform/citizen_sdk_flutter_sessions.dart',
  'lib/src/platform/citizen_sdk_platform.dart',
  'lib/src/platform/flutter_citizen_sdk_platform.dart',
]);
const HOSTED_MAIN_DEPENDENCIES = Object.freeze({
  flutter: null,
  polkadart_keyring: '0.7.1',
});
const HOSTED_DEV_DEPENDENCIES = Object.freeze({
  crypto: '3.0.7',
  ffi: '2.2.0',
  flutter_lints: '6.0.0',
  flutter_test: null,
  meta: '1.19.0',
  path: '^1.9.1',
});
// 根 include/ 是 CitizenSDK 唯一产品 ABI。两文件完整闭集既固定字节，也阻止
// 上游 smoldot/signer 符号、任意 RPC 和秘密导出接口绕过 citizensdk_* 边界。
const PUBLIC_ABI_FILES = Object.freeze({
  'include/citizensdk.h': '864d0f1c529946b6e0596cf9b2bae6d9a73ac119ed28ba39ac6535f3efb823a7',
  'include/citizensdk_types.h': '6ff2a3d30a83c0ede069f298a99224e7e66a91410b8c7cb5145bbe563253e828',
});
// Android Kotlin/Java 源码直接位于各源集根；包名由文件声明而非目录层级决定。
// Dart（排除已有独立来源合同的 smoldot 快照）、Android root/native 与
// Apple darwin 生产输入构成一个反向闭集。平台测试、文档和注入的 AAR/
// XCFramework 分别由测试、文档与候选投影合同固定，不能在本表建立第二条来源。
const MOBILE_BINDING_SOURCE_FILE_COUNT = 85;
const MOBILE_BINDING_SOURCE_FILES = Object.freeze({
  'android/build.gradle': '1910db9cfc9b6a5ed9ff79b587040c9a026d73a1a9ba0ed026cb6552e73b3d99',
  'android/gradle.properties': '5318804f9c8a0d30039e9449e074d4ce23c97ce76ce4fc58349f671cc43deecf',
  'android/native/build.gradle': '419a4a4c50f133e2e23463da1bbd65f4966b7ac013fed959a84a876ca0ee4a62',
  'android/native/consumer-rules.pro': '7a2e6f17f3b414dd62fb760cfbcdefcfc3ec7847d183a89d9782fc479f89d3e6',
  'android/native/src/main/AndroidManifest.xml': '709ef7018c08e6f14d3d02fec899180b6758177b4f1defbae51d815782aa9a8a',
  'android/native/src/main/cpp/CMakeLists.txt': '51b1cf4641cfc3c66d8c0cf4bdfe9821dab8115491efb5ed6ec4e29518624d57',
  'android/native/src/main/cpp/citizensdk_host_bridge.cpp': '86ae53b82e800f45338fa75ae8121687d15adcff1a1c73b7ce7f6411f671f3c8',
  'android/native/src/main/cpp/citizensdk_host_bridge.hpp': 'c79d413b6df68106151fa6021fd634dd4e891f66feba004092bd27e9fb11036a',
  'android/native/src/main/cpp/citizensdk_jni.cpp': '957904bcaf4c5b68513ea2e63cd5f3c46f3df22b4f2ef7d3a557cfaa9b01185f',
  'android/native/src/main/cpp/citizensdk_jni_support.hpp': 'b0b4fcef64701248f0c34e4d1ffb76fa19cc07bdb96e2b0ff48d7b14926561fa',
  'android/native/src/main/kotlin/CitizenSdk.kt': 'f64b44d981e0b8915696d991d249832625e3b4b30b4a845148e5e6e8b60a5cb4',
  'android/native/src/main/kotlin/CitizenSdkError.kt': '317ae6a6eeeb3283c2f9035a5c0a63579688eb48fa10fc9424f9eda15f6cdaba',
  'android/native/src/main/kotlin/CitizenSdkEvents.kt': '43107b2606d06928508b634a0ad5a673bfefa607528786b91bab658efb7fa034',
  'android/native/src/main/kotlin/CitizenSdkModels.kt': 'e564d1f32f93bae3030053c3a32bdfb107f1837a46cbb3af73725f4898c54061',
  'android/native/src/main/kotlin/CitizenSdkOperation.kt': 'f623f51baff06efd8c9b39aade5968af2fd85860cca331e763d7c27bc5f4bc7c',
  'android/native/src/main/kotlin/CitizenSdkPreparedWallet.kt': '654afe7899d6fd572f3083358df1c143375f3e0c0bfba0493e45a95d225fe571',
  'android/native/src/main/kotlin/CitizenSdkQr.kt': 'bee1cd0b3bb95e090725e5cf97149704ff8a3df85cf0c36e8fcb3b1976bb52ba',
  'android/native/src/main/kotlin/CitizenSdkQrCapture.kt': '37dba5f840880beceec03ac85996f1397be1857a88b3849be5b1492dadb0f8d0',
  'android/native/src/main/kotlin/CitizenSdkRecoveryPhrase.kt': 'a2b3938b577baed26c5411dbd29cf0c14147b14128a0e24e2361959054186b83',
  'android/native/src/main/kotlin/CitizenSdkAssets.kt': '5e1fa319c9ad43d452b4e987cfb5fb644b0c682bbc7c687bb0717f7d043ae7bf',
  'android/native/src/main/kotlin/CitizenSdkHardwareVault.kt': '277d1ec42501f890a04f425ae0140375e5a6795c9f4eab5f8e7baec53f1a04b3',
  'android/native/src/main/kotlin/CitizenSdkHostRecord.kt': '6cdb3638939976db4c1b179a5871d8de111dd4bf2a3c94eab378e281cbcc9b49',
  'android/native/src/main/kotlin/CitizenSdkHostServices.kt': 'f6c1334e64ca43e83051fc9e7e0d3a86f4eb66ba77a73d1f597951a760a2b43f',
  'android/native/src/main/kotlin/CitizenSdkNative.kt': '7701079fe779d20570cbf9bdf8fcd8f6e1e571f81155d597f3c13f13091a8b92',
  'android/native/src/main/kotlin/CitizenSdkNativeCodec.kt': '0aec51742e55d9e19a98497a7ef73db229f16b5f1d134241596addea15e7298a',
  'android/native/src/main/kotlin/CitizenSdkNativeResult.kt': '3f31bea6da321d8eb231d6f518f53534fe607a46a168c47d8f99b3c036a424df',
  'android/native/src/main/kotlin/CitizenSdkPublicStore.kt': '2bf4f6a208b51ce4a89b278a060ffc051a4b985260780125bc76ad1f633ee1d5',
  'android/native/src/main/kotlin/CitizenSdkRecordKey.kt': 'a43d9a8d303cd2a687bf11004ec5b95eb9e684a2f55befc364ca62b50f1c9a14',
  'android/native/src/main/kotlin/CitizenSdkRequestRouter.kt': 'bbe7a711c0995cb647cabe679b40f92ced051b34d868cd8e18e7570ce8d23bfd',
  'android/native/src/main/kotlin/CitizenSdkSecureStore.kt': 'dde91aebfcdeea9aa6b108319dd5718ac92dc02791f37ed4b3d5c6958c34ae21',
  'android/native/src/main/kotlin/CitizenSdkSensitiveBytes.kt': 'fe2129f7612e3cad88ed7d2f38d66d371488554238794c94d9139c95729337c6',
  'android/native/src/main/kotlin/CitizenSdkSqlite.kt': 'e1633581171b733d3c37d63444c7652e6ce5c91616e5fd5c9dc063778312dd79',
  'android/settings.gradle': '8c640faa6535ad6f80efd22154ccc50332ae9c77e2b8a0a69419afbfcffe9a8b',
  'android/src/main/AndroidManifest.xml': '5f63723834c354984501a277bf3752b0cd4dc85350bf2e09558538364fcb28ec',
  'android/src/main/kotlin/CitizenSdkFlutterCodec.kt': 'ac9175a9fa4a76941945c4fc47293edeec7fa016b9d1ca22e4470552c101112b',
  'android/src/main/kotlin/CitizenSdkFlutterSessions.kt': '46357e7dd44d56989b913b1bfbe07836b2c297615aac3f488a16134480cf811c',
  'android/src/main/kotlin/CitizenSdkPlugin.kt': '5054cf69ad1216f58ca65d32e01d4ff8faa5fc3eadc9ec828e80d0f0dff321d7',
  'darwin/Package.swift': '159c504cab86afb641fbef2b1fd35c59c20bbbe81d003cd7cdeec914a3ee91fc',
  'darwin/Sources/CitizenSDK/CitizenSDK-Bridging-Header.h': '977e6c4e7ede7d12d193032be74810c49412492321ea719937873482956f25a8',
  'darwin/Sources/CitizenSDK/CitizenSDK.swift': '012a8f729732c43f0da07825644b7066003e5f4ba1a003964c372c41fae4a36d',
  'darwin/Sources/CitizenSDK/CitizenSDKAssets.swift': 'b32f78087ba8319c2d510cbadbc9d01da8ab956462dfae5f74bc603f4939a7ef',
  'darwin/Sources/CitizenSDK/CitizenSDKError.swift': '8e7667873254e1361d6e624d0f89f12eba0f5ba4499f4da694f3eb6b45175a7f',
  'darwin/Sources/CitizenSDK/CitizenSDKEvents.swift': 'cf0a342a28209eb0fc4058f10535a2420912402dd18339a141d6595c06544c71',
  'darwin/Sources/CitizenSDK/CitizenSDKHostBridge.swift': '92c7b3798fb8d52dbc380cb55e527a92d2810fca152aa4a3e80b48d13988f37f',
  'darwin/Sources/CitizenSDK/CitizenSDKHostRecord.swift': '70d951817f68a0ca5adb55a0a82323d8919920a1605b062e042c3122b9b391d8',
  'darwin/Sources/CitizenSDK/CitizenSDKInputLimits.swift': '922448dbb204788c9e3774c9fa3f6026b6c00828e292f11072abfce63b8802b6',
  'darwin/Sources/CitizenSDK/CitizenSDKModels.swift': 'a9e57c2dbe70010cfdbdf713531a0bec807b429f3a0186a3626331884318ef55',
  'darwin/Sources/CitizenSDK/CitizenSDKNative.swift': 'f0651f4e154242ca7d8066ef269d9701dc23a6aec8a29321e8f394e7e0d8493b',
  'darwin/Sources/CitizenSDK/CitizenSDKNativeCodec.swift': '9687bca77af6f63a38c2ad7b40b1174d12924d44bc6decd53e97e6f09b7a183a',
  'darwin/Sources/CitizenSDK/CitizenSDKOperation.swift': 'c4316129d0383e347042952d3a02c71fdd72c67f40ecc64343f4ec04a9c2008a',
  'darwin/Sources/CitizenSDK/CitizenSDKPreparedWallet.swift': '7539ee20c84f3efc2577401901ad64dcd388f43ed6abff0cc75deed8f4e24aab',
  'darwin/Sources/CitizenSDK/CitizenSDKQr.swift': 'b1dadb79ffcd83830fbeea5754bb2626eb56a4a18af676daf1fde51d28554589',
  'darwin/Sources/CitizenSDK/CitizenSDKQrCapture.swift': '984142c8b3e9fe697636cde1277bf6b183ca7626a48069fb52c339f5c40805d1',
  'darwin/Sources/CitizenSDK/CitizenSDKPublicStore.swift': '581b9057a3d4fe531c71f84077985cf41b803b073d6819ad1d87aadfd78b8fbd',
  'darwin/Sources/CitizenSDK/CitizenSDKRecordKey.swift': 'e4e0cd2f0ab0c6e1390391bdd5eb3c54370d49da23bca08c45ed37ed4936256e',
  'darwin/Sources/CitizenSDK/CitizenSDKRecoveryPhrase.swift': 'c794a5320b02d32cc348d8fb6f45d34df2e49260070eece3c620376f6f824993',
  'darwin/Sources/CitizenSDK/CitizenSDKSQLite.swift': '9a2e592decdbebb53a70b056ec70c3cc09ad0b4105aa5e94a282b66b86ceb5c9',
  'darwin/Sources/CitizenSDK/CitizenSDKScreenSecurity.swift': '2ad9b025e8c1ae3eef0ce7cdcca2c675570d39a41fc282cfcc4ecefea688731e',
  'darwin/Sources/CitizenSDK/CitizenSDKSecretVault.swift': 'dca8ff47993a54b0f565778d38a5a86f5baf00a28564b8a7d02390324eb02598',
  'darwin/Sources/CitizenSDK/CitizenSDKSecureStore.swift': '0ca43e22a9b841a56c3bfc15c6cf2fa4bf2225750fe9e6358451c01242ead720',
  'darwin/Sources/CitizenSDK/CitizenSDKSensitiveBuffer.swift': '2b92446c0fb99663105dcbe070a9bd0718ba492d807ce8ff1966d41a512ed25a',
  'darwin/Sources/CitizenSDK/PrivacyInfo.xcprivacy': 'bc417321bb94066c1bca08840349eea542c3c13e6addfc8248533791627434f3',
  'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterCodec.swift': '6d8c30115b8979b190d684a394310d7af5bf619a15a2b63319c7b0a4975aadc1',
  'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterSessions.swift': '42f090c5361534be8e68eded4c3697970ef064cfb07bf866976a62cbfe05938e',
  'darwin/Sources/CitizenSDKFlutter/CitizenSdkPlugin.swift': 'a923e7b3c81404fe6861ffa1698c50735306ede3e7de1ff68b335467a3b1c29d',
  'darwin/citizen_sdk.podspec': '86d1154c61b6dfda2f2855dd1da9ecc5c5c8e3103bfac8865060c9a8a51bc0df',
  'lib/citizen_sdk.dart': 'ac8fcf2b24f3556523dbbfc737dce00326ab4679797a45eaaa4f981e0104f243',
  'lib/src/api/citizen_chain.dart': 'f64e8fd8918469564b11f32212bbaadd2fc3cd09f5ee34711ba819b531f00077',
  'lib/src/api/citizen_qr.dart': 'fb88651400b8a81f976d681e18364aaf7ac53b4711645ead15d3b549d31bd24b',
  'lib/src/api/citizen_sdk.dart': 'd2cb4251450b772b86b15bc2df2973983d5d0533ce8acdbe04c50063e654c58f',
  'lib/src/api/citizen_sdk_error.dart': '1bd6c7b0ce0391ca8edfb41e20a681f1372a506f18d0730f65b0d9d417b42f4f',
  'lib/src/api/citizen_sdk_events.dart': 'f4313b944ba072d4aaa2307bc3f232a6f15cd2a1adb7742625e03a3dae71e03e',
  'lib/src/api/citizen_transactions.dart': 'cfedd56d49a07f4c3d3ba15ec5a91441271a275d802a697856dc1c4402ad5bc8',
  'lib/src/api/citizen_sdk_wallet.dart': '0adcd0ded2647d8fdbbe1c84bdf16f99e0ec517f9d35023114423dada446e794',
  'lib/src/account_codec.dart': 'ce72262d96193ae47da43a9f675d6141f5c565eed05bb9e9755b575d96fcbc84',
  'lib/src/models/citizen_account.dart': '086319ca3010b0c848eba635954299c6425519b8c4eefd84b18ec26b2763ec4f',
  'lib/src/models/citizen_capability.dart': 'e7d5bfa94a60b005cd390f36ae25dfcb87a34c46c5b4e8188984a6103ba2103d',
  'lib/src/models/citizen_chain_state.dart': '24960cfa52d27901169c62afbeedd75dbf8ae69a3ce1f50b242c70e6c686d65a',
  'lib/src/models/citizen_signing.dart': '16d7256faf8340ac92ba22be1fe4ac72cdf37bb9eea1393b27800eee6dd4a414',
  'lib/src/models/citizen_transaction.dart': 'c5582330841d84628ac49a050ff1ed2fed08154c6368b22faa09384d17ba1268',
  'lib/src/models/citizen_wallet.dart': '69c71895a2a4142a7fa5c8dbe4d20711a4630c6e257bd14a9c0a9bf7f32971af',
  'lib/src/platform/citizen_sdk_flutter_codec.dart': '66119e12bc611b2125adcca4ab2f2dc36f5e14934cb79583a25b4d526907bbad',
  'lib/src/platform/citizen_sdk_flutter_sessions.dart': '108fb8a5b0234d67828b4d45d7fb843092b2e48b717869213f4c5e44e769c56c',
  'lib/src/platform/citizen_sdk_platform.dart': '295798fba26533cdbba0ec993acd215cf48889b9b744b43c2192e6566fe29f6c',
  'lib/src/platform/flutter_citizen_sdk_platform.dart': '18faee02334a8c3dabbcb3a80e01ac34ad56279cdb8011d18313ebcaf9f53761',
});
// Linux C/C++ Host 与 Flutter adapter 都只是根产品 ABI 的宿主投影，不是
// 第二份 Core。测试和 README 分别由测试、文档闭集固定；其余 CMake、公共头
// 与实现逐字节进入独立来源闭集，不能悄然混入另一套协议或生成产物。
const WINDOWS_BINDING_SOURCE_FILES = Object.freeze({
  'windows/src/citizen_sdk_qr_camera.cc': 'de0b1dfd3cb33d972ec375a25eb58006694849a1a1a5a48104407f248b515de2',
  'windows/src/citizen_sdk_qr_camera.hpp': 'a6937a5a30ca27ab87b767d51c766b4989918f4194a32718c67ea405ac605aaa',
  'windows/cmake/CitizenSDKFlutter.cmake': 'd731ff7fed596b545de3d96845de1ed067f59e7ed66b0d00720a71826f6c740b',
  'windows/citizen_sdk/citizen_sdk_plugin.h': 'ed4a806687c01f9be2a4c4c76dff5dd7d8676f7fe0c6860551006c3a056256ec',
  'windows/src/citizen_sdk_flutter_codec.cc': '130eaf0312834b22df7f269ed1c9775b22ea82e879fb00091645172169a79aea',
  'windows/src/citizen_sdk_flutter_codec.hpp': '1f5070209943ff6e0924e42e24c0c9f773ea1b2373e09f79eb59c2705263f243',
  'windows/src/citizen_sdk_flutter_environment.cc': 'b8995cf4ce18a44958c52883088153795e149fb1b4622f5a8ecbb78b496900e5',
  'windows/src/citizen_sdk_flutter_environment.hpp': '958a42b9f877a3ed3d74ae893a51ceb57603d80ebad2aec1eadf82785b60a055',
  'windows/src/citizen_sdk_flutter_sessions.cc': '46510d1c900b657f497d3dbb2bc542344b4f73fdc7b3d0b88052dbcb24991aab',
  'windows/src/citizen_sdk_flutter_sessions.hpp': '662cd44b983352fc3cc1ddc1078c9c3704bfd1e9ad65563e274bb482b46776af',
  'windows/src/citizen_sdk_plugin.cc': '0c056bfd4580fee4fc58e4a6a09d6ae421844476dcc93e2b46af6936ebd49d1b',
  'windows/CMakeLists.txt': '90eb78cfaa57676558f4b7bf8ecd17ff072542e9029d325a9b864750426a2b79',
  'windows/cmake/CitizenSDKConfig.cmake.in': '28f0499a515d57a025ad7f7453d0bcef917c3c40dfb8ec7f98e0ce0935caef81',
  'windows/cmake/CitizenSDKConfigVersion.cmake.in': '5e180138e3d7ac236ad945c42a15184f48d3076a40206a3d7c90d545d42be235',
  'windows/cmake/CitizenSDKDependencies.cmake': '22e2ce5543f07f84def46b119df9fd9ab248f4c4df8ab27d4ab5f86c9ac65300',
  'windows/cmake/citizensdk_host.def': '7532bb23a8f760aefd08057334cc7395bb487babada8f1b024226ddeef2f7afd',
  'windows/citizen_sdk/citizen_sdk.hpp': '949cc690fa499d1b373e0336afc45f015d34d99caace329b66182688d8d6b4fc',
  'windows/citizen_sdk/citizen_sdk_config.hpp': 'ec428263bffce15723485b6c4bafbcec99b40ce6979aa4514b2badc378b80296',
  'windows/citizen_sdk/citizen_sdk_error.hpp': '693d3c6adf930c6403f5d99f769578db6f4e02ba182e6bb051bdb76f8c3e2db9',
  'windows/citizen_sdk/citizen_sdk_events.hpp': '32c2f64beb04bc2ec274c909ff9776e47ab3c05a0face18e879a16d5a4069dc7',
  'windows/citizen_sdk/citizen_sdk_models.hpp': '8e14f3162f51175cdf8e9082cf2233c95619bec33e45152450839a522e8c7242',
  'windows/citizen_sdk/citizensdk_host.h': 'e77158404edbacbca31ab2000837184d929fae387918b48b96d5706a369d0c29',
  'windows/src/citizen_sdk_assets.cc': '9f55e98f71f87f8baa3c2608bf64c52e2e8755aed4fa7ded13e47494f9968207',
  'windows/src/citizen_sdk_assets.hpp': '5e50c7ca69023c63af645eec4b97fa1bf74ae3089aef86fdcf1d35fcd4fab8cc',
  'windows/src/citizen_sdk_cng.cc': '88c6cc4d5532eec088d30211826e8cd4583e629557a43d687768a49353d39ffc',
  'windows/src/citizen_sdk_cng.hpp': 'b7e15414228fb0671cbf907aa1a6cbe0ca3ff57a1101805306b2c40c3f3321e5',
  'windows/src/citizen_sdk_directory.cc': 'e32bdb3c8d1f752bc750eae1bbf104b81c54e665fbec6ec8d9d3173a6d5c6844',
  'windows/src/citizen_sdk_directory.hpp': 'c46f0679df4c328b2a43be50260cb8001341f5da66d0ede2830b258c801d546a',
  'windows/src/citizen_sdk_host_api.cc': '93fced9a38714295833c93d26a646cf068b8015a90b4b7cc940dd0198b80f106',
  'windows/src/citizen_sdk_host_bridge.cc': '33279a98bca34130d4750295d306e0129e06debe76a73c2800e2a157f9c9d819',
  'windows/src/citizen_sdk_host_bridge.hpp': '503f5cd8b94c5bd8f498b91d4d2dfbd5755c965ebb3a286e4c4b918ea8b4bfaf',
  'windows/src/citizen_sdk_host_record.cc': 'ef59ba6feefc4686f5d5ed619a7a5cc43d5bd4a167fae1ba4f7022da85d19c39',
  'windows/src/citizen_sdk_host_record.hpp': '9e53109d9d1c3fe31e8f591acba8ec83b869031ff831013f44599a0f80914f68',
  'windows/src/citizen_sdk_input_limits.cc': '4ec6953b4090cd1cda3e82dc7c314a0380e941978654a1a764860658191fdf46',
  'windows/src/citizen_sdk_input_limits.hpp': '562181bcd62d4aca1117daecd0fd454e9079c70e86148d8903399ae3583e815a',
  'windows/src/citizen_sdk_lifecycle.cc': '33e03ff5c2fcdb15fd5d5f7bcd340ff3b9437cd8bb90c7871ac759478baea7e3',
  'windows/src/citizen_sdk_lifecycle.hpp': 'ae6767db44c01778c91bd17b140da62efa69c245b9df78aafbef41ecba76c2a2',
  'windows/src/citizen_sdk_operation.cc': 'cf91f83b6f6dc318dc782d231855b5effb44b905a2ee8325423f883a8a9715ee',
  'windows/src/citizen_sdk_operation.hpp': '5864304e0760b45a4e41fe7e923b623809d795f27e18262acc0f5daf0e4ff38b',
  'windows/src/citizen_sdk_public_store.cc': '28bd90809bc9f8db126731cac574ccd8473421df15053d1ad462fea9e0bf18a9',
  'windows/src/citizen_sdk_public_store.hpp': '014b53c41685616f0186c5d15db3778629fbc83a23d308e8d005e934f32befe0',
  'windows/src/citizen_sdk_record_key.cc': '689eb3eab6a279b930f60ebd292b594f17ca2fb06faa0c938ed8311c23cdf3df',
  'windows/src/citizen_sdk_record_key.hpp': '8f41cb538870037827ecda3401178dcaee5d839d052375ddb6b5e9e74326f736',
  'windows/src/citizen_sdk_secret_vault.cc': '16ac10668d9dd3297403b000cbd4bdf561c2f8c12a487eada071b6b0e148c419',
  'windows/src/citizen_sdk_secret_vault.hpp': '718d86c256a4d512a6ebbf924c7a2543dd235120816e64caec54c0e0118e4a3e',
  'windows/src/citizen_sdk_secure_store.cc': 'd7861e3859d0f3be1461d385f190d24d43e8eb1f492d1d8fce691841ddabb348',
  'windows/src/citizen_sdk_secure_store.hpp': '90ae0c83d1d5fd70b38eaee46ba51897c4169ad3b308ca124e4ddffdea4c384f',
  'windows/src/citizen_sdk_sensitive_buffer.cc': '3e57b05e29b90c92f95dee292360debeb0c330af1fce41a24de9cf9c3d04dff6',
  'windows/src/citizen_sdk_sensitive_buffer.hpp': '99c5cd23993b3bed07605f4a707eec55cdf087a97677bbd684f8363355ef3ce7',
  'windows/src/citizen_sdk_sqlite.cc': '503bfacb9e83a1d2c35dc45aec0184c5a3fc759b1e8cb44182ab47334697d854',
  'windows/src/citizen_sdk_sqlite.hpp': '0d69a315553abd90a42029646fa4355b3acc9867fb16a9343312abcffb4aa2d3',
  'windows/src/citizen_sdk_user_auth.cc': 'e75009ce315f73f10b103961dcb06c9bac8a5bca0b934a074172b4ba481de994',
  'windows/src/citizen_sdk_user_auth.hpp': 'a6d56dda212b0fe6f0f818f51192ff210e39ef165e17d65350fcf3d3a1ae4b49',
  'windows/src/citizen_sdk_window.cc': '76673550457b05c7f75a426739cfc925e8322b98c872c3519420a465d79afe7c',
  'windows/src/citizen_sdk_window.hpp': '60fff1bbed42f818449e351e819aae65e30029b95bb27b92421f7793a1ccfa6b',
});
const LINUX_BINDING_SOURCE_FILE_COUNT = 51;
const LINUX_BINDING_SOURCE_DIRECTORIES = Object.freeze([
  'cmake',
  'citizen_sdk',
  'src',
  'test',
]);
const LINUX_BINDING_SOURCE_FILES = Object.freeze({
  'linux/src/citizen_sdk_qr_camera.cc': 'abb06ae107649dbacfd8cde28f5607aaff83dec906d0c82e88eaa3db8c486e44',
  'linux/src/citizen_sdk_qr_camera.hpp': '7978efb0277b58a6a73b1dffc053f01e016285a9011a3ee9bb278f0e267b447d',
  'linux/CMakeLists.txt': '85e4c633ea06d045a76ca66310fa5fee4cb1314052764900f862b77f51524882',
  'linux/cmake/CitizenSDKConfig.cmake.in': '6438544fe01125967e71e21f0bc4147e68fb8f68215502af2f82fd1287eff9c7',
  'linux/cmake/CitizenSDKConfigVersion.cmake.in': 'b2dd2bb6bb58f1255b6e9eca0f61b635f589ee2809537f7ba7fa45d46e3d7685',
  'linux/cmake/CitizenSDKDependencies.cmake': 'c0ab6dffc4577ebfff8b3eb467f37f2b8c7fb45158bf3f64b7e8d753b9d8f5d0',
  'linux/cmake/CitizenSDKFlutter.cmake': '28e010835f814ed49a7e37ddbd61df9bf768849d0946003ca91b176f00f1bbd5',
  'linux/cmake/citizensdk_host.map': 'dc3ce26cbf848b5bb56d0051fcab5cb38e88ad281a36bee95e720c78742ffe88',
  'linux/citizen_sdk/citizen_sdk.hpp': '1f5f17f425e2ec79ee236eba29f4ab35093cf04c4375469c41bed2208e5649bb',
  'linux/citizen_sdk/citizen_sdk_config.hpp': '874ed6acabd193589d572d97b0d8d9106f70f80210507433ba46b97263c4e6c6',
  'linux/citizen_sdk/citizen_sdk_error.hpp': '693d3c6adf930c6403f5d99f769578db6f4e02ba182e6bb051bdb76f8c3e2db9',
  'linux/citizen_sdk/citizen_sdk_events.hpp': '32c2f64beb04bc2ec274c909ff9776e47ab3c05a0face18e879a16d5a4069dc7',
  'linux/citizen_sdk/citizen_sdk_models.hpp': '8e14f3162f51175cdf8e9082cf2233c95619bec33e45152450839a522e8c7242',
  'linux/citizen_sdk/citizen_sdk_plugin.h': '06636001f326a317617a39f7c1108eb510b127f416de7f0dcb4c4cdd84be0c2f',
  'linux/citizen_sdk/citizensdk_host.h': 'dbfeb366336a504ca1ab58e5543d7a73522364cd7b3e4fd04ac4835d84ff0df9',
  'linux/src/citizen_sdk_assets.cc': 'b663b653299c22d62a44a7f242e1e57f2d8471408d0d3d81728bbe37929d0cb6',
  'linux/src/citizen_sdk_assets.hpp': '44d30123c623ea266030235126552e4a9334839f0d5d44adb5931f56d8b93401',
  'linux/src/citizen_sdk_flutter_codec.cc': '81ed93e09dc7a703f37054a141d00b9b1be07acc5221dad9ad8ef84fa01e5b3e',
  'linux/src/citizen_sdk_flutter_codec.hpp': '3f7d20cf4c6520fc5b5e44ace63253a3dbde394b4104f60433bf3d327a36d5f9',
  'linux/src/citizen_sdk_flutter_environment.cc': '25d29c5a53509b65cf304033753ee77b674345715f26b51e3758294306c8e1cf',
  'linux/src/citizen_sdk_flutter_environment.hpp': 'cb7c3707b5060d178bfaebab973358a897cabac08945220fd975a6e050e2a455',
  'linux/src/citizen_sdk_flutter_sessions.cc': 'fc308130b483337b836593aed63497f92019f095231236f00752c667dc25fb4a',
  'linux/src/citizen_sdk_flutter_sessions.hpp': 'd326ac7b97ccd11b74a1ac6d35238d6894893444df6392332da656beca8ffe79',
  'linux/src/citizen_sdk_host_api.cc': '1ff5822dbfae143c909bb2a2809872217e76638a8773440eeca41a6fe5564ecf',
  'linux/src/citizen_sdk_host_bridge.cc': '9eb057abbe3d52916c1c133bdd1e6e5f05bde2cb355029b2f7b9fec0001c1ba7',
  'linux/src/citizen_sdk_host_bridge.hpp': '1c44585a9e0685f950617cf62288170f573f1dc7d5e32c4ae4e4208bd8cfeb28',
  'linux/src/citizen_sdk_host_record.cc': '68fea5575759fadbc9bd9257a32bbb00779bad9961908e76135329c3fcc110c3',
  'linux/src/citizen_sdk_host_record.hpp': 'd3c5b9cfaf91c85ee47bf86713f1299f204ef220614035257adb1c2d56be5742',
  'linux/src/citizen_sdk_input_limits.cc': 'bcee60aea062432c44f16d71a99b2b61e4f6fd08f564c60290d21247b856ea7f',
  'linux/src/citizen_sdk_input_limits.hpp': '939167673437101beb1c55e4076441b613d50deae694c44191da8063389c523a',
  'linux/src/citizen_sdk_lifecycle.cc': '78fcdac10137a4f39d5eb6bd69be1a74a51b5f449f969f7d6e048ba8828a441f',
  'linux/src/citizen_sdk_lifecycle.hpp': '08c384e14cdae9938d07d681d55648e0e0e623b07f69e0d4c5f472a7077539c6',
  'linux/src/citizen_sdk_operation.cc': '5fc6658dc917578d88b256feda05352e7c7f30447bcda0218a0169f0cf7ac94c',
  'linux/src/citizen_sdk_operation.hpp': 'cecfd6e3864996c40995ebdb25c7fd82094f19dc039481ba35451b7196ee1aac',
  'linux/src/citizen_sdk_plugin.cc': '6d351a5824e5dd0112dc3398a31c5969251f89d9fb632f5994c41acc24f39604',
  'linux/src/citizen_sdk_public_store.cc': '1c4daf7421f85365d8aec2a51e60564acbb8f7b1102d3fb5db416ce744ddb476',
  'linux/src/citizen_sdk_public_store.hpp': '0ed71b85c8bb736c2454137dfdc856da3cd4b963fb5fa3fb9c3e7b0324bbe197',
  'linux/src/citizen_sdk_record_key.cc': '80425cd8dffa7b537ab6634018b8877f2bac365949dc41667c8f0b8945be193e',
  'linux/src/citizen_sdk_record_key.hpp': '267aca52f7d0e0647f5d716eebc08cb2c77be5c093d491365baa7c01e0118bdd',
  'linux/src/citizen_sdk_secret_vault.cc': '1d743a721989de233612ea3c686c8233197cf010271065bb37ea92e28e75ae5a',
  'linux/src/citizen_sdk_secret_vault.hpp': 'b0db3c3827b40b243053d6e5696bbbd1946555b3b1b3fee99b5555047b4f1ae2',
  'linux/src/citizen_sdk_secure_store.cc': 'a3703ef08bdf6cfc2acd454c433aa6e19cd38171c2b89a1d62f83f0ce4b77ccd',
  'linux/src/citizen_sdk_secure_store.hpp': '2fcbb33e911042cb7cfd74acb7a75f370ce51c5bb66e4147824219fb991faaad',
  'linux/src/citizen_sdk_sensitive_buffer.cc': '3904d22d1d02bf03512d84fb5a06d30912793b7e5abecba283b30ba3b15d1e90',
  'linux/src/citizen_sdk_sensitive_buffer.hpp': 'ea8254eb8420c7abe4b7adc338d87fdf0ce9cc8a44ca42ec305618c3788b1046',
  'linux/src/citizen_sdk_sqlite.cc': '1c216fc9d40e8311cbfba188cf65aa3f65304751f40bcb1ed727a4e8288926f4',
  'linux/src/citizen_sdk_sqlite.hpp': '758df4068b8db94a1122e1a64823fd38aca9f5590c1ec1ba39ac5eb69f49041b',
  'linux/src/citizen_sdk_tpm2.cc': '09fee7a54f2163d81584c9cdef05ca38d5b533057437d0621c1c2d44357310e9',
  'linux/src/citizen_sdk_tpm2.hpp': 'a8a7c68d743b8e662ad57a736c23ff54518e53155d72ccae9913b61964cae644',
  'linux/src/citizen_sdk_user_auth.cc': 'f3f7631972ddc03afe98c38af23f2c1b26b2b55ba396d1aa68ed72bf480d4087',
  'linux/src/citizen_sdk_user_auth.hpp': '37b1ad9fabe43440bd4ffb14a41275c63d1590c69be12cee83889863c517503b',
});
// 根README只作简明产品介绍；其准确字节随源码和正式包验真，不放行平台技术文档副本。
const DOCUMENTATION_FILE_COUNT = 1;
const DOCUMENTATION_SHA256 = Object.freeze({
  'README.md': '27eca53df327abee22e53f959bb20b5b4b5c71ed2436f4c9a51402d83ec82251',
});
// 根 Flutter、Core Rust/FFI、smoldot provider、signer、Android、Apple、
// Linux/Windows Host/Flutter、三类公开面消费者、独立签名器、安装消费者与 Release 合同测试
// 共同构成 SDK 自有测试反向闭集。
// 固定测试源码能阻止“删除测试后剩余测试仍全绿”或实现与金标同步漂移进入正式包。
const SDK_TEST_CONTRACT_FILE_COUNT = 169;
const SDK_TEST_CONTRACT_ROOTS = Object.freeze([
  'test',
  'native/contracts/tests',
  'native/engine/tests',
  'native/ffi/tests',
  'native/signer/tests',
  'native/smoldot/provider/tests',
  'android/src/test',
  'android/native/src/test',
  'android/native/src/androidTest',
  'darwin/Tests',
  'linux/test',
  'windows/test',
]);
// scripts/ 同时包含生产构建器，不能把整个目录误当成测试目录；只反向枚举
// Node 正式测试命名 `*.test.mjs`，避免新增测试未进入固定闭集却仍被文档宣称已覆盖。
const SDK_SCRIPT_TEST_ROOT = 'scripts';
const SDK_EMBEDDED_TEST_ROOTS = Object.freeze([
  'native/engine/src',
  'native/ffi/src',
  'native/smoldot/provider/src',
]);
// scripts/ 只允许固定的分析/构建/本地测试入口、当前正在执行的 Release 真源和一份
// 已由 SDK_TEST_CONTRACT_FILES 固定的合同测试。release.mjs 不能自哈希，否则任何
// 合法更新都会形成不可解的自引用循环；test.sh 则必须逐字节固定，防止测试产物回写源码树。
const SDK_SCRIPT_ENTRIES = Object.freeze({
  'analysis_options.yaml': 'pinned-production',
  'build-native.sh': 'pinned-production',
  ci: 'directory',
  'dependencies.lock.json': 'pinned-production',
  'dependencies.mjs': 'pinned-production',
  release: 'directory',
  'release.mjs': 'executing-source',
  'release.test.mjs': 'pinned-test',
  'test.sh': 'pinned-test-entry',
});
const SDK_PINNED_SCRIPT_FILES = Object.freeze({
  'scripts/analysis_options.yaml': '67a8f842d8b2c0eee53ab22db23c98e4deb3f8d3992a20d1a977870dc2e8218a',
  'scripts/build-native.sh': '4603adcf67e317e99704cfd679cacc02db4202247ff5d48f3610276ff4ba2c6b',
  'scripts/dependencies.lock.json': '0a8512053a401ac12604098de0c19e810b529424eea3e81f952a5eea14e9d5da',
  'scripts/dependencies.mjs': 'd3411d94527d99a93857eb8b9302027e42af6484ddb4fb95c71fdf9c2f13739b',
  'scripts/test.sh': '09f2060908baa8cc6fba27e9929c50273fabd8ac8dcaa5954b8a81d848fb23f6',
});
const SDK_TEST_CONTRACT_FILES = Object.freeze({
  'test/sdk_1_10_1_contract_test.dart': '83a483a5474f15f2ca358c122add4d128728c5689261d5df2eb4c563d95ce093',
  'native/engine/tests/baseline_resource_contract.rs': '78b211a0d7ce43d9819cbaf1f867f8680222cf649a5b9729ea9a808ce09abb03',
  'native/smoldot/provider/tests/baseline_lifecycle_contract.rs': '17411f0c473d13b1d40d1058e51f66671e68e11855c1faccfbb41b9f1f58bc1e',
  'native/engine/src/qr_review_tests.rs': '9112a367745bd8aca6796316a8ec31895021edd762b2cfd655b8a357d72aa00d',
  'native/smoldot/provider/src/bootstrap_tests.rs': '59579491f30dcb5423269fc0a1f29159255cd95963629a9bd650e03e49d01c1e',
  'native/ffi/src/chain_monitor_tests.rs': '249e22c52f52ff4f17ab6fad58c5ce37f9f0a880ce4156671b8356e29214730e',
  'native/engine/src/wallet_input_tests.rs': 'a48405f12472122b7ab1dbac19b806e3900c99152a396987e1f0956fb9bcf3af',
  'android/native/src/androidTest/CitizenSdkWalletInputTest.kt': 'dd671df3bd18b0172b840c18c39363c36a08971438f476da728bc341f87aab26',
  'darwin/Tests/CitizenSDKTests/CitizenSDKWalletInputTests.swift': 'fc94c673b311d486b708122cf2ae8ecb1ed60730d8ae5210f7e5b6f00b255bbd',
  'windows/test/citizen_sdk_flutter_consumer.dart': '2abfb7c58ed8ccadb53aa14194daa87c6b2cc9a20627c3014c9b1e3ec762c69b',
  'windows/test/CitizenSDKConsumer.cmake': 'fd7015ce32a1e77abe7470c291c54aa66195adb44185fa74a9defd85fbb8d24d',
  'windows/test/citizen_sdk_c_consumer.c': 'ba564a941be5ddf91235057fb8444b3c342c3932c139a07996f64adee105546e',
  'windows/test/citizen_sdk_cpp_consumer.cc': 'a6a78ae4b3d07f5ed1f99990f54bb8c5c4d41c27f06cb0a999520ee64d90c96b',
  'windows/test/citizen_sdk_flutter_codec_test.cc': 'd3b01045e8cddc7d1dd89c9943b6105070241cc1dd857e7dd39e1e76382ced66',
  'windows/test/citizen_sdk_flutter_environment_test.cc': '1faed89ee422a05166b4ad12efdeef7f5543b0b8e32512e235f7f700b1a2e86d',
  'windows/test/citizen_sdk_flutter_plugin_test.cc': '466bc68608196dd5f74059c05833da29fd632df3456df2da20efdcb1bb7ee0ca',
  'windows/test/citizen_sdk_flutter_secret_boundary_test.cc': '9c87f5b78ed1e0491ddb0b6e699b81ac47910fc6cb1b95dae25e306d4f1081cf',
  'windows/test/citizen_sdk_flutter_sessions_test.cc': '171a73af6577ef841667473fca75cbf3dfaeee5b7534d4c1adc7938c2dc8ad6a',
  'windows/test/citizen_sdk_flutter_test_support.hpp': 'c70f2f414d92aa56c2e86e300c2567bb46c38927039ae9f519d1e262b7bcfb47',
  'windows/test/citizen_sdk_flutter_wallet_flow_test.cc': 'de915483b99e047f7424a55f2eafc1fed817cab643a3e7cbbc25b4e7acd6b342',
  'windows/test/CMakeLists.txt': '3b8c345e7eb988bca474649404e2d80152242fa3b273a29a5dd962c8688f9db4',
  'windows/test/citizen_sdk_api_contract_test.cc': '7917ad5e989fca4f2ec94d924d8135ce83478efc5aab08d5d197d3121cc024d4',
  'windows/test/citizen_sdk_assets_test.cc': '07575184eedaee8716bdb9e9134cb8ee3d68addaf7b4f271bc77b5fe117d904a',
  'windows/test/citizen_sdk_cng_test.cc': '2041c11af27e7424295d4294f271c1d0cd8c7162c64d67af9155eaced422f4fc',
  'windows/test/citizen_sdk_directory_test.cc': '952bdc527cb00371cf721f7bad8bd527a7d7f4251799df45e38d19087f4aac61',
  'windows/test/citizen_sdk_host_operation_test.cc': 'a2d010265461834843430de81fcc1e5dffae2a7e9aa6990781321fa3c3c0498f',
  'windows/test/citizen_sdk_lifecycle_test.cc': '84dcf464abf3b4261eca7d875179b2ea54a55609d6bd8503d4c4289a99423dfc',
  'windows/test/citizen_sdk_public_store_test.cc': '8d3910973a554c5518089477112372474cdfd183b71e45d439771ac802d07cb8',
  'windows/test/citizen_sdk_record_key_test.cc': '421e9dd2e9950c02addb9343fe12ca23f3d9c1832c4a25725420928dbc9423e1',
  'windows/test/citizen_sdk_secret_boundary_test.cc': '7e6c220a4ac2129d8cb11ca67206951e9c1bec56976d66398bc14d1c56f085ea',
  'windows/test/citizen_sdk_secret_vault_test.cc': '366581ba2723a7150600d3b0d9f0896aa7ae7973fa8825751cd009b47d1a5dff',
  'windows/test/citizen_sdk_secure_store_test.cc': 'ca29f5d02a0f15556c370c9a0cba9c8ab93501effe335240dbfb1077887d9b77',
  'windows/test/citizen_sdk_sensitive_buffer_test.cc': '23d0d8f7f28db585ff1dc6ac23d350018c7f6636adb07925f3b3891d0b4eceee',
  'windows/test/citizen_sdk_test_support.hpp': 'd128551fc1e6f8aefb9604ac88ed32cfedcc2d57c97be30995aa974e7a5ee38c',
  'windows/test/citizen_sdk_user_auth_test.cc': 'fbe8fb1941f722775b27954d2e3222bac40feee99b88565c7bb227f01e560324',
  'windows/test/citizen_sdk_wallet_flow_test.cc': '78fa7ca47bd23ae463e35614cb478cf16172197576dd4b0b06cdb40afbbba529',
  'android/native/src/androidTest/CitizenSdkHardwareVaultTest.kt': 'd7446fd9193a59f589cf085a924ad2adf596121a5542d7cc63b31f31a53268a2',
  'android/native/src/androidTest/CitizenSdkLifecycleTest.kt': 'e16c4493a198d8c2d9e790bc2d2d16f73db4d97f71e2356cccf7f543823fb0dd',
  'android/native/src/androidTest/CitizenSdkNativeAbiTest.kt': 'f1ce49cdd8e58d8d765efb22d64aa6fac9a6992ff29e1a4ee4c0f5f99e0da683',
  'android/native/src/androidTest/CitizenSdkStateStoreTest.kt': '5e2f52b2d45e4867d41e2b1671ae2ffac500c4e9b9d661a76dc9ab48d768d542',
  'android/native/src/androidTest/CitizenSdkWalletFlowCancellationTest.kt': '28881d7e4cb2bd0919ca96c367964c81e30aab19a1f7ef59ca03c9e5e3c9262a',
  'android/native/src/androidTest/CitizenSdkWalletFlowSecretBoundaryTest.kt': '9ed5779c514f268d804b0660d7e498b3e6921851923427c68bc2d9d16118acf1',
  'android/native/src/test/java/CitizenSdkJavaApiTest.java': '14831f3885786a8c04bb8425b257f2baa7bf4205f42e579236ca3fa63c75506f',
  'android/native/src/test/java/CitizenSdkJavaOwnershipTest.java': '81d06cf7ace9cc41b2045f757588a9859ec7f02cc24c4b11fab95d7ad5dc74a4',
  'android/native/src/test/kotlin/CitizenSdkApiContractTest.kt': '10344dd5bc79fa9c6217cad523ca92bd029f3f3f216a075881d6293022d9b869',
  'android/native/src/test/kotlin/CitizenSdkPreparedWalletTest.kt': '326742ec538a0a0b73188ac24d06f3e6042776a8e0b545c50f6defcbf04cc632',
  'android/native/src/test/kotlin/CitizenSdkHostOperationTest.kt': 'f1f9bde38554168e856a966d7c79803d2fc02ecae1ca7dc7996a685fc5c01602',
  'android/native/src/test/kotlin/CitizenSdkRecordKeyTest.kt': 'b83832d2431e40caaea3b9356390c3ea7c03624c93733fc821d3a6f832aed634',
  'android/native/src/test/kotlin/CitizenSdkVaultIdentityTest.kt': '995a25c4742c3098e96f869379ea4f7e77289e2230cd4c211462712ec4ba1acb',
  'android/src/test/CitizenSdkFlutterCodecTest.kt': 'a7ecaa21d76272b28deca593a7fb0eb05847622625f7c771040e533e5497797c',
  'android/src/test/CitizenSdkFlutterSessionsTest.kt': 'e970aeaebd98d3400e2fb0987bea27a1ce623fb4504774cfe7ae7a3befe20716',
  'android/src/test/CitizenSdkFlutterWalletFlowTest.kt': '5af91c52409e5cfe41c827e0e762aa2148e491ca645e22019c63c0a2e5d61a0a',
  'darwin/Tests/CitizenSDKFlutterTests/CitizenSDKFlutterCodecTests.swift': '484c6c7a3db073f10dd31803e4786d5a07dba534a542dad61a3bbff8297aae8a',
  'darwin/Tests/CitizenSDKFlutterTests/CitizenSDKFlutterPluginTests.swift': 'd905fda42ad2303ec3fdf7e7b1e6993694747be02b2fb949de1089164aa71923',
  'darwin/Tests/CitizenSDKFlutterTests/CitizenSDKFlutterSecretBoundaryTests.swift': '2f0150db79a60ac27e7524d2974ea91229c65b576b0498ab7e1ce4e823fb5ed1',
  'darwin/Tests/CitizenSDKFlutterTests/CitizenSDKFlutterSessionsTests.swift': 'a7d2d2b0aef9ed3a5f8f18076cef45d1c3a527a6fd908acb096a075fa38ee9fc',
  'darwin/Tests/CitizenSDKFlutterTests/CitizenSDKFlutterWalletFlowTests.swift': '8caa0560b189af5ff0e67f59c0d090c1b34086cc90dd50d113d5b48389ef471f',
  'darwin/Tests/CitizenSDKTests/CitizenSDKApiContractTests.swift': 'd455f73b09bf08056379bf9e50303feef67b6cfcb708ada9743e6fe3cba1e32f',
  'darwin/Tests/CitizenSDKTests/CitizenSDKHostOperationTests.swift': '109be3ae384db564139db63537895b0151fe29b59fc7c2370d51553e7fe5f3c5',
  'darwin/Tests/CitizenSDKTests/CitizenSDKLifecycleTests.swift': '88c34852b88c4dbf90bd5411151c91a6487f2ff08ae2e946f245eac33098eb48',
  'darwin/Tests/CitizenSDKTests/CitizenSDKNativeAbiTests.swift': 'a3b4030c9450bcee1fe54e735f24796bb158895d4eedf445e506e24fcdcb9355',
  'darwin/Tests/CitizenSDKTests/CitizenSDKPublicStoreTests.swift': '537b71a8cd4bd78d24bac4ae0dea39e0b46d44b257e2b6876d0bd3462a473b1c',
  'darwin/Tests/CitizenSDKTests/CitizenSDKRecordKeyTests.swift': '30891704a7d2d4fa98bf3750c9ec88370389fd4e6bdf7f4641faeb8a0873791f',
  'darwin/Tests/CitizenSDKTests/CitizenSDKSecretVaultTests.swift': 'c7affde19d38e01922dc8c13ce67ead61bc809b76e1701d96a5e99e923e91877',
  'darwin/Tests/CitizenSDKTests/CitizenSDKSecureStoreTests.swift': 'fa29b12165632e1f4574a09267316ed0308e6813080a7def22bd87fe75daa481',
  'darwin/Tests/CitizenSDKTests/CitizenSDKSensitiveBufferTests.swift': '6788049be932cfe0555d45f03f2abffcdad40bc66d011520f4c0d2f185f79863',
  'darwin/Tests/CitizenSDKTests/CitizenSDKWalletFlowTests.swift': 'cf41e9d2848f6d7d55eb352de683b214be039b740b68756d9fc0c83804057bdb',
  'darwin/Tests/citizen_sdk_flutter_consumer.dart': '5d22a10bdd551ead221dba2253005d45d236e2d9313c4576b6f1bc0d929cf2aa',
  'linux/test/CitizenSDKConsumer.cmake': '0a9b3160c86d4d699e16f47b026e2e0c46439d3cabc84b323c885db220b4007d',
  'linux/test/citizen_sdk_c_consumer.c': 'fcba2e20096acc6611a6b198a273fb78093bfc5ee77b3924d6551464316e186f',
  'linux/test/citizen_sdk_cpp_consumer.cc': '6b85472aabb166361711ca5ad1c91831ec58ea13704fda29c5f2c57ca3d85df0',
  'linux/test/citizen_sdk_flutter_consumer.dart': '2dc4c2ccbabcf6dab101423667a3a1d8305c279fc1f1901927f4cb33fa3a1916',
  'linux/test/CMakeLists.txt': '0a2ed3fd63be699715d422e823bc005c0003a8037fc18049ed0b77f96ce57fcb',
  'linux/test/citizen_sdk_api_contract_test.cc': 'bc1527e23850ab7149d01600d4b414ae3f7e46464b94f1e4b1124ecc76c8c5a8',
  'linux/test/citizen_sdk_assets_test.cc': '3902d98006a8c47b0c7c6043d62472bd199ec9edb2ee7c2aff1117d2d5a7e724',
  'linux/test/citizen_sdk_host_operation_test.cc': '9dab4cca7a7df3ee7568aef6271639f5f3da8bc8d13f8cffeacc36017ba6fc56',
  'linux/test/citizen_sdk_lifecycle_test.cc': 'dca66ac150d079d6539455893db60c6cf1d1bf0d3bf94637f63c8fb8d6c4a50e',
  'linux/test/citizen_sdk_public_store_test.cc': 'e30a162b2a6df54e49820cd49acebfb545fd25900dde850edf8f57fd2a45d3ca',
  'linux/test/citizen_sdk_record_key_test.cc': '11871f6372b6983d7265fddb1714ed9b283d9ff43a9f6e782759d47dd5c74e4d',
  'linux/test/citizen_sdk_flutter_codec_test.cc': '6e10a78284b28f2f587118d8f7ce325dda7f411e75fe4e8478d464271f0fc18a',
  'linux/test/citizen_sdk_flutter_environment_test.cc': '14e757b971f678a597356f0dcad750519e2005f314f4746f753cd6db19096ab1',
  'linux/test/citizen_sdk_flutter_plugin_test.cc': 'c251e3007f7e3b1096c25c5c7f164d19d7cf32fab665a4c8c04f8222a4cfeeaa',
  'linux/test/citizen_sdk_flutter_secret_boundary_test.cc': 'd1f4fe5612d8cc1ec3da4883841428ab8d5d2e76c583a4d4fb269bd69e2c7e03',
  'linux/test/citizen_sdk_flutter_sessions_test.cc': 'c38840df5589614228eb77eda61e92d32670f8efed40a20cd1ce6c3c38adeb21',
  'linux/test/citizen_sdk_flutter_test_support.hpp': '1b92cf8f6a6fd0df6a58d5630f72ad29578d3118f7aa886ee1b3149b86606f56',
  'linux/test/citizen_sdk_flutter_wallet_flow_test.cc': '2191dd5e6f1e3fec557e0e8df9e74147d156cde2525a24dcf6b1f1aa07605180',
  'linux/test/citizen_sdk_secret_boundary_test.cc': '53e9de1a509b709ffe0197653ffc6d68719123104b11f9c73ee4173c997be929',
  'linux/test/citizen_sdk_secret_vault_test.cc': '738a97964b08feaa1a5d57ba2c7916947913eb640beccebb0882d0e0cbfb102e',
  'linux/test/citizen_sdk_secure_store_test.cc': 'a07f4f19dbac1394d9b2ccc41ef4771cb119a68bd0b5312af51cefb7bf8130f1',
  'linux/test/citizen_sdk_sensitive_buffer_test.cc': 'e82855221fde7e20ce07ef194619c18cd1c25ed7b8c9ae5a85fd8f94256a5ec0',
  'linux/test/citizen_sdk_test_support.hpp': '5bec8904799c5648eed148a67be4dbb6f22a6d8d1ffaab4504202677da467884',
  'linux/test/citizen_sdk_tpm2_test.cc': '29146093852ac3a51d7925e6d9a27f042e5f136c37d58a6367de2bd119c9f8e5',
  'linux/test/citizen_sdk_wallet_flow_test.cc': '6c2be872f13e3fb301f38327243e3769a6ea2f3c843ac9e7a57db5eb54212786',
  'native/contracts/tests/account_contract.rs': '2f2af9930ccaba2cf73a21c1ea3593295a6e7d8633a95db05fbcb642e7c74992',
  'native/contracts/tests/capability_contract.rs': '797298ce4a1a33934b400cafc37f22f8e9592a0e4067dbc1a868987182fd9cac',
  'native/contracts/tests/chain_contract.rs': '29b0f790a72565653c134c9f11d5b8384d19c36e0f9f7fd6c6196328cd1f103f',
  'native/contracts/tests/secret_contract.rs': '0b4e1c3046004f0a313488462fae6e0f7807ec6b8b90e608d464e0c701046750',
  'native/contracts/tests/state_store_contract.rs': '0ebc2d16392bcc7c80d57276b8fe8a6012f6387dbde14b4a0e63ffd8d366d209',
  'native/contracts/tests/transaction_history_contract.rs': '88a08ac80f2a131a6f1a4e215ba0b55e8476fac71059b9ab14ff329159724f54',
  'native/contracts/tests/transaction_build_contract.rs': '4fcc035715077d907e3a31f86e7bf1fb11cc4791bed9b75b0c38c4a04282cb25',
  'native/contracts/tests/transaction_prepare_contract.rs': '1ff363381350352c500fd639b3346e6dd2be556cad23878755268b90a17712dc',
  'native/engine/src/wallet_derivation_tests.rs': '0af6e57e748e0811e5651841ec40e3be43618139ea138b5491178a325e5a438d',
  'native/engine/src/wallet_service_tests.rs': 'a670d270f1ce02fe2dcdaa746859a1fc8b5611a0ed63f0048a3a983257d6cbd6',
  'native/engine/tests/account_state.rs': '1f64f4b7e245c1aece23d73cb885d5a1ca0a6a9d5c632414e34ed542c6828289',
  'native/engine/tests/capabilities.rs': 'dcfdbffcbaeabc44a6d6934021b2a80ec593d6c8b64b23a7cfbed8b6791f3e93',
  'native/engine/tests/chain_access.rs': '8df836b9bb209fe4db1dfc8766410172a12e042da9236c5898f5292d0bcc4cf5',
  'native/engine/tests/engine_boundary.rs': '62d04ec6b9035204c4f44777cbf08815521bd63e29146b8bcceb8774190bcbd3',
  'native/engine/tests/runtime_context.rs': 'e5eb9f999668b6664d29ba61a0c8b2fd8b2e9fe37f7830bb4f4b7732b9c4fe43',
  'native/engine/tests/state_import.rs': '6937752568de3531a32b8ad35b1fd7270abad120c4b5aac423ae7df970d3f917',
  'native/engine/tests/transaction_outcome.rs': '68a05dfbdeedccaf70c22f83f88ad05131e8f65f9c2f355f12ce93d90e7d0645',
  'native/ffi/src/composition_tests.rs': '36914d26faee5e3d063317cc29dad51caaa43a5f605915895b89910e30bb3ed7',
  'native/ffi/src/host_codec_tests.rs': '2c4530aa91512284dd273663c31e80c3a47734be82a04fe8a5245d0beb80574a',
  'native/ffi/src/wallet_abi_tests.rs': '214a78945bc9e96cb2c7bbad13c94110f9d8f5c02c2f00cc6962792ac1175177',
  'native/ffi/tests/abi_layout.rs': '3c70e50d8ba1af53588fffff5ba5681f12fae1c60e0979e8f8a298f04f3aa74e',
  'native/ffi/tests/asset_boundary.rs': '47cdc02fe23f8581671d1a3aa7116cf6a728c5097ca49fd43131391a9c66864b',
  'native/ffi/tests/c_header_c11.c': '299643fa8eb6e87dee9f3281503e3e68a6779c9b519d2564790ccb2cc41d8ad0',
  'native/ffi/tests/c_header_cpp17.cc': 'ed7d2e7e3f12476ecd9df4d80c7589273a69972acee55f996f614cd31a764468',
  'native/ffi/tests/capability_contract.rs': '7757572b88a887b866fda6d7184a11df42af56ac27c77a7bd3055c84022f5acc',
  'native/ffi/tests/error_contract.rs': 'ae585490b05768b64401b1e6774789ba1beb1eede552e4d3e70a99cd1d395d91',
  'native/ffi/tests/event_contract.rs': '2621abf7d9eb040dd43b0ade7827f38ecb5c0e492868ccd3757a154eeeeaac1b',
  'native/ffi/tests/handle_contract.rs': 'ca4dadf979b3d747327edab5f9ffd8df741cdc497235029c0f03900ec19d16f9',
  'native/ffi/tests/host_provider_contract.rs': '114ed9d3b377f876756f0dcc091c37325330d6f33632371f1a7d271298601027',
  'native/ffi/tests/ownership_contract.rs': '08112f6dd5629f4bf69d05ee7a4a3b425c300adced89e6c924a444a7fe2821bd',
  'native/ffi/tests/qr_abi_contract.rs': '760aac708a04c952eaf2563d7c96b3ddede85a095ae2268bb89cba625be5725a',
  'native/ffi/tests/request_contract.rs': 'b657a3f4ff677e61a1fc890a58f79c0461db35bc76c00dff90a76e8d4b6ca833',
  'native/ffi/tests/symbol_contract.rs': '5b9cb4f2bf01debd05fb53f235ba318b498e6967bce89cafa6f8efb4a4b180db',
  'native/ffi/tests/wallet_abi_contract.rs': '030657f3a0254597e604aa1f8b4449cd542ba483668f77e92d99f30d243708f1',
  'native/signer/tests/chain_signer_contract.rs': 'd4e53512dffab3f75ee213a08b71909dbc6c667b4b287df39cd9ac3e62824b31',
  'native/signer/tests/ffi_contract.rs': 'bf38f650394011e7f68219ee8ba435453f616281f91649634c536b8620407038',
  'native/signer/tests/legacy_parity.rs': '984a1521042d8a5b2285a43459383ef3972058db20e8f05154c1f75a2a11d70f',
  'native/signer/tests/substrate_vectors.rs': 'f5587dbce91f9c2014c559bece142e56fe65c81c7cf097df66b6c8125d45eef9',
  'native/smoldot/provider/tests/account_nonce_contract.rs': '7b3ea1752b1d96e2d54374ef2b45391f5281138fa7c63ae216185cb5bcb463c4',
  'native/smoldot/provider/tests/legacy_parity.rs': '7db2b3ef4959a7bd1c83b22597666b0448f48b3079b82821f624efd2ccb7d9dc',
  'native/smoldot/provider/tests/verified_chain_client_contract.rs': '543f75c8a92a6e4e225a6c7d7c33f213687e4d6f14b25776320a2e3883a0f58d',
  'scripts/release.test.mjs': '9e1245127369e4a2990984bc6dfcc104f8cfc3aa250a9cae9cdd505a6d430ed5',
  'test/api/citizen_sdk_test.dart': '682d5b30eed22732404d83f00da062578e4676fe64ff7e4be33cae2e7c8e9548',
  'test/api/citizen_transaction_test.dart': '323b2315d2b6a6343c682f1626b10938c141348994b566b4ba0e75d2b656a4a8',
  'test/api/citizen_wallet_flow_test.dart': '8d24bea2696ef58071c60e6b44ca954f250051f024f4beb72507811747bc6518',
  'test/api/public_api_contract_test.dart': 'be2857da646be9a883102b85596eac2598f2078af6b37f8b18fe56ee00711ab7',
  'test/citizen_sdk_facade_test.dart': 'da67a4722dee132d9efaa951651c463c6d8eac541078f08ea764b420f2f29412',
  'test/consumers/citizenapp_fixture.dart': 'b06f4fad06481223a1fbde7046743aeaad6af72e0c10cc67cfc54b158686e3a0',
  'test/consumers/consumer_test_support.dart': 'aed47f5bde9605510eeb26cdc9b876034ee0cca753cab27e04ab3c72d75b1d11',
  'test/consumers/generic_qr_v1_signer.dart': 'cd5c9b09093798cebb25ec64ceefd8e4ab691136d1b651444989a77d5c509ad5',
  'test/consumers/multi_consumer_contract_test.dart': 'b1d71bf32b3e3e55860e4a19bc094f4e47397fcadd383e1c81a1afcda83ace57',
  'test/consumers/reference_consumer.dart': '56b5e9d414302d45a4ba796b7c3af2b25b1e67c9268ecc1907d2ecacd7f01520',
  'test/consumers/third_party_fixture.dart': 'adf75a027328a9a83c26b0d3783d821c3383cb39f4a5d787db0248ca51cf8f99',
  'test/models/public_models_test.dart': '72127a821f1718b3da255aabef731338ebcb478be8f316310ac79a1eb3cad7c5',
  'test/models/u128_codec_test.dart': 'e406f077258130ed22481af2e228066a4030dab19b765731eaefcfdc2f0ca6f5',
  'test/node/chain_assets_test.dart': 'f2e2f0b249cb7b5095169c9cbb67fff64dafb60fcd844521a28566d8cb81c595',
  'test/node/citizensdk_bootstrap_manifest.json': '33bd8e2c7407abea376f21a7adf7c9df644aedb7a9e985211075bba6cde28a00',
  'test/platform/flutter_codec_test.dart': '1674919ddfe28c92bf66a6ed5c5d337430d45fd74a122dd03b1f98a7f9fa3e30',
  'test/platform/flutter_secret_boundary_test.dart': 'd24c8025d0dfd9153ee26303f5503a54993e37f015adea7ff07e4df40bd3ed5c',
  'test/platform/flutter_sessions_test.dart': '45a67829059b2b7c909b4d953a28feeaad3fbcd1345ab1b8632be182a65f2ce8',
  'test/smoldot/chain_info_test.dart': '5de74abf31c75c579716366d72a457e91339352972a4a118ec7fe18de005b158',
  'test/smoldot/client_basic_test.dart': '4617fc86f8fc4a555e837f04ad747a25b501d93532532f8f0565e1d51e17a5cc',
  'test/smoldot/ffi_basic_test.dart': 'd7f16ab19bfd842f4414f43e989a3536d6725a1ba9e2eab78ac6f53dd7fa6cef',
  'test/smoldot/fixtures/polkadot.json': '1d5079040595c54f56f31900beea91254cf2a3a25e245bcdd26fe1ccc4672a9b',
  'test/smoldot/fixtures/westend.json': '5457a3c8322b8f2a2d7c2c713c113a7e0b1ee7e646d3f00abc4fa21198ea879d',
  'test/smoldot/json_rpc_test.dart': 'c61e7bf8eaebdc199a5cd2228e4de7f3b94e17715f7bdc7a53297b9be2e3fa94',
  'test/smoldot/smoldot_test.dart': '144f3a7d3385e0f8ece9c28762ae19862cffa1e2db8e449b51ed6e56dbcf6cce',
  'test/smoldot/subscription_test.dart': '18cce5adff77d300f4f6adb6e20db9237a1e0206a05f9308133689319636e677',
  'test/transaction/citizenchain-balance-fee-v1.json': '2cd5e648703c8cc389c59f07753470b63c034f7cfa63dac8ffa596c8128a0033',
  'test/transaction/citizenchain-revive-v15-metadata.hex': '6c697a80d160ccec859941c9d79ff926c3ff7f36c41da0b621789d6ed663a820',
  'test/transaction/citizenchain-runtime-system-events.hex': '2c4d04a69ff994622877786d481dc4780b7a32795e5f7cfa070ae4acb72679ef',
  'test/transaction/citizenchain-runtime-v14-metadata.hex': 'da62207dfa342ce5285bb214a116761fd0a38c7c329ab8953506ad52471ed681',
  'test/transaction/citizenchain-transfer-build-v1.json': 'c43a1f01c22556d2b1e172088fb540358c25b9554c91ffc71f7b483fcd5a469b',
  'test/transaction/substrate-v14-system-events-metadata.hex': '95b368e7907511b28ba283a6741f4be551b56fb917c2f0183b4143dbe0ebf95b',
  'test/wallet/citizenchain-wallet-derivation-v1.json': '2d9bd9f5feeacea729154475475e0d4525e594bc88ede3a86494ffaf35301769',
  'test/wallet/citizenchain-wallet-password-v1.json': '0f8427f6ca542625626c7c1615608eef19246db496c4bb819937f15cfdec7250',
});
// smoldot Dart 包边界已并入唯一 citizen_sdk 根包。三处迁移目录共同构成固定闭集：
// 生产绑定、来源测试与历史审计资料缺一不可，且不允许重新出现第二份 pubspec 包边界。
const SMOLDOT_DART_ROOTS = Object.freeze([
  'lib/src/smoldot',
  'test/smoldot',
]);
const SMOLDOT_DART_FILES = Object.freeze({
  'lib/src/smoldot/bindings.dart': '23a5a2add0de238ee8218238acf312193fa349c0806edb4056ff6f63b8b459eb',
  'lib/src/smoldot/chain.dart': '43f3fbc8420f61d335acb0c48ee471a7885ebbd71d320d8b820805b1537d8053',
  'lib/src/smoldot/client.dart': '916fd74c20f4daefca2e17e668e8a2fb16c59219b8f3bdd3148d10454a71ddff',
  'lib/src/smoldot/json_rpc.dart': 'c3a030b236814731f773bb8b1aa9dd1e5789bc7d0809f3c0dd7011d59b401d01',
  'lib/src/smoldot/platform.dart': '8efb99639389f12dc725199befc3073d5b49027ac761aea097d17e6df449d491',
  'lib/src/smoldot/smoldot.dart': '8e13185cd86609faf7d96f1da22a2457ce2e129f1d8e637c8220a2a481147758',
  'lib/src/smoldot/types.dart': 'e20b6f97d0b6e289c2b492e12dd66afafc1133adc0fc5fe5a547106ed3338e89',
  'test/smoldot/chain_info_test.dart': '5de74abf31c75c579716366d72a457e91339352972a4a118ec7fe18de005b158',
  'test/smoldot/client_basic_test.dart': '4617fc86f8fc4a555e837f04ad747a25b501d93532532f8f0565e1d51e17a5cc',
  'test/smoldot/ffi_basic_test.dart': 'd7f16ab19bfd842f4414f43e989a3536d6725a1ba9e2eab78ac6f53dd7fa6cef',
  'test/smoldot/fixtures/polkadot.json': '1d5079040595c54f56f31900beea91254cf2a3a25e245bcdd26fe1ccc4672a9b',
  'test/smoldot/fixtures/westend.json': '5457a3c8322b8f2a2d7c2c713c113a7e0b1ee7e646d3f00abc4fa21198ea879d',
  'test/smoldot/json_rpc_test.dart': 'c61e7bf8eaebdc199a5cd2228e4de7f3b94e17715f7bdc7a53297b9be2e3fa94',
  'test/smoldot/smoldot_test.dart': '144f3a7d3385e0f8ece9c28762ae19862cffa1e2db8e449b51ed6e56dbcf6cce',
  'test/smoldot/subscription_test.dart': '18cce5adff77d300f4f6adb6e20db9237a1e0206a05f9308133689319636e677',
});
// 两份锁文件属于收编的 smoldot 上游依赖，不是 SDK 自有锁。它们必须保留为
// 普通文件并通过 Cargo 结构、provider 闭包和 registry checksum 校验，但不能用
// SDK 自有源码哈希门禁拒绝上游例外。上游来源身份由受保护清单和 provider parity 合同约束。
const SMOLDOT_UPSTREAM_LOCK_FILES = Object.freeze([
  'native/smoldot/ffi/Cargo.lock',
  'native/smoldot/pow/Cargo.lock',
]);
// 根 signer workspace 与 Flutter 包的解析闭包同样属于正式来源输入；locked 模式
// 只能保证使用当前锁，必须再固定锁文件自身，才能阻止依赖身份随提交静默漂移。
// Dart 锁按获批中央 Flutter 测试最小闭包解析并验真；不修改 SDK 运行依赖声明或上游实现。
const SDK_ROOT_LOCK_FILES = Object.freeze({
  'Cargo.lock': '07e34bab68cc18eaeeb82b8e624b429226426f3eef9355d39ee650b4f31d6d0b',
  'pubspec.lock': '735c65795780cf2eaced6ac373c0f02e7b14953af44c1d1113480eb3d40d90a4',
});
// Cargo.lock 会按 registry package 合并整个根 workspace 的 feature。Engine 为钱包
// 显式启用 BIP-39 NFKD 后，smoldot 闭包里的同一个 bip39 条目会多出这一项依赖；它不是
// PoW 来源依赖漂移。例外必须同时由准确 checksum 和一个本地 workspace owner 的直接依赖
// 证明。HTTPS 建议节点只允许沿固定 reqwest 路径解释额外 feature 依赖，不能放宽上游锁。
const PROVIDER_LOCK_FEATURE_UNION_EXCEPTIONS = Object.freeze({
  'serde 1.0.228': Object.freeze({
    checksum: '9a8e94ea7f378bd32cbbd37198a4a91436180c5bb472411e48b5ec2e2124ae9e',
    owner: 'citizen-sdk-ffi',
  }),
  'serde_core 1.0.228': Object.freeze({
    checksum: '41d385c7d4ca58e59fc732af25c3983b67ac852c1a25000afe1175de458b67ad',
    owner: 'citizen-sdk-ffi',
    via: Object.freeze(['serde 1.0.228']),
  }),
  'serde_derive 1.0.228': Object.freeze({
    checksum: 'd540f220d3187173da220f885ab66608367b6574e925011a9353e4badda91d79',
    owner: 'citizen-sdk-ffi',
    via: Object.freeze(['serde 1.0.228']),
  }),
  'unicode-normalization 0.1.25': Object.freeze({
    checksum: '5fd4f6878c9cb28d874b009da9e8d183b5abc80117c40bbd187a1fde336be6e8',
    owner: 'citizen-sdk-engine',
  }),
  'web-time 1.1.0': Object.freeze({
    checksum: '5a6580f308b1fad9207618087a65c04e7a10bc77e02c8e84e9b00dd4b12fa0bb',
    owner: 'citizen-sdk-smoldot-provider',
    via: Object.freeze(['reqwest 0.12.28', 'rustls-pki-types 1.15.1']),
  }),
});
// 同一 registry package 也可能因为根 workspace 启用更多 feature 而拥有比 PoW 锁更多的
// 依赖边。这里逐 owner 固定全部、且仅有的额外边；未登记边、PoW 边缺失或解析到不同版本
// 都必须失败，避免“包集合相同但实际依赖图不同”绕过来源闭包证明。
const PROVIDER_LOCK_FEATURE_UNION_EDGE_EXCEPTIONS = Object.freeze({
  'getrandom 0.2.17': Object.freeze([
    'js-sys 0.3.104',
    'wasm-bindgen 0.2.127',
  ]),
  'rustls-pki-types 1.15.1': Object.freeze([
    'web-time 1.1.0',
  ]),
  'bip39 2.2.2': Object.freeze([
    'serde 1.0.229',
    'unicode-normalization 0.1.25',
    'zeroize 1.9.0',
  ]),
  'futures 0.3.34': Object.freeze([
    'futures-executor 0.3.34',
  ]),
  'pbkdf2 0.12.2': Object.freeze([
    'hmac 0.12.1',
  ]),
});
// 上游 smoldot 锁与根 SDK 锁可能为同一 registry 包选择不同的兼容版本；
// 仅允许已审查的 package 名称发生这种版本联合，不能放宽任意依赖边。
const PROVIDER_LOCK_FEATURE_UNION_EDGE_NAME_EXCEPTIONS = Object.freeze({
  'getrandom 0.2.17': Object.freeze(['js-sys', 'wasm-bindgen']),
  'js-sys 0.3.105': Object.freeze(['futures-util']),
  'x25519-dalek 2.0.1': Object.freeze(['rand_core', 'serde']),
});
// contracts、engine、产品 ffi、QR 协议与 QR 图像窄包装都是 CitizenSDK 自有可编译核心。
// 它们不能借用 smoldot 的来源清单：这里独立固定五个目录的 103 文件完整反向闭集，任何 build.rs、bin、
// 示例或未登记文件都会改变编译/发布语义并因此失败关闭。
const CORE_RUST_FILE_COUNT = 103;
const CORE_RUST_ROOTS = Object.freeze([
  'native/contracts',
  'native/engine',
  'native/ffi',
  'native/qr',
  'native/qr-image',
]);
const CORE_RUST_FILES = Object.freeze({
  'native/engine/tests/baseline_resource_contract.rs': '78b211a0d7ce43d9819cbaf1f867f8680222cf649a5b9729ea9a808ce09abb03',
  'native/engine/src/qr_review_tests.rs': '9112a367745bd8aca6796316a8ec31895021edd762b2cfd655b8a357d72aa00d',
  'native/engine/src/qr_review.rs': '1e2e05bcef1fff6e532ba4e3ea16a6dace6d4494db03522e14a21b6015ba285e',
  'native/engine/src/chain_monitor.rs': 'b530254a11c1c6014cceb9c58e16032cabff5891b033e587d97cf5145198a682',
  'native/ffi/src/chain_monitor.rs': '5a624dc62ef7d2ea3546762def76499deeaf98466bb0ec66cab6ed6feca136dc',
  'native/ffi/src/chain_monitor_tests.rs': '249e22c52f52ff4f17ab6fad58c5ce37f9f0a880ce4156671b8356e29214730e',
  'native/engine/src/wallet_input.rs': '70325d8faf5666454cf1d5f237c5d6f842730080a8635d2f3c8436d94b637076',
  'native/engine/src/wallet_input_tests.rs': 'a48405f12472122b7ab1dbac19b806e3900c99152a396987e1f0956fb9bcf3af',
  'native/contracts/Cargo.toml': '9bda2e7d8b80ba215bff5d0157bc7210fb0fbd891d1d16e0404f204c1c922c14',
  'native/contracts/src/account.rs': 'c9e128bbfecf910d574c2a8a8467214e580452a900ebc321b5c89463b09297f3',
  'native/contracts/src/capability.rs': 'e32d875040adae8a85b30f9bb2cc7bc661f80b95d0960ee460aa348d527b9013',
  'native/contracts/src/chain.rs': 'f2caa17ed4f59fccc72d98b1bfca62dffc11509c619ebd5af9d41b573f7102b6',
  'native/contracts/src/chain_signer.rs': 'c20cf42f83f5be8607894934074d7608467d2f9a0d020e4a13b90bc31be12b16',
  'native/contracts/src/error.rs': '99f9396c29c3948a6c8c899041c0aae23833c6241ade2a89abb294dc0507c90c',
  'native/contracts/src/lib.rs': 'a9d5ac3997e63d9dd83a371da430677b6d54559ac3a8da52d521064da454233d',
  'native/contracts/src/transaction_prepare.rs': '6fbfde1b659b99af7b7960e35be381c8b95d312030460f65e2c3dbdd2149e0aa',
  'native/contracts/src/secret_vault.rs': '43aab74393de1907f4e8bd8e1e1b14a74b0977c452ce866f4e76fb5c3058f447',
  'native/contracts/src/store/chain_database.rs': '31a2e46f046fc8259de01fd776050625b0cfbfb4d8f516cc8695a7d5d1ce9c13',
  'native/contracts/src/store/encrypted_secret_blob.rs': 'a92c8e9e5f92dfca99c4c2547de4be6505ae3006f7c77a612d107676bec8a457',
  'native/contracts/src/store/mod.rs': 'a25aa27f57edd79f2c2e13d0b955fdf79ec6c1189c7619212816165e9144be75',
  'native/contracts/src/store/runtime_cache.rs': '164fa1302ab7b6aac8ac9de92c8adb733695960b09ac6ae7ccc2cd735f0a744e',
  'native/contracts/src/store/transaction_history.rs': 'f2fc847a8a1b33d4f25f732cb95d0bedc13d006a3fe9607b9201d75e5f2e98cc',
  'native/contracts/src/store/wallet_profile.rs': '3d1869fed7b17b931a8a9740df2466928a159d19e0b28f97b18668ccd4fd193e',
  'native/contracts/src/transaction.rs': 'f028a9e00bc160cbdb3ba88f752be0b95f35df9db00b3fc96718d3463096b723',
  'native/contracts/src/transaction_build.rs': '22b6f9d9279f00ab8155efb648586d6b25aaa7152031dbc958a789c78a457c01',
  'native/contracts/src/wallet.rs': '0948112103825307226c45f669883b4fd76874d4cbddd03f3214549e874614b2',
  'native/contracts/tests/account_contract.rs': '2f2af9930ccaba2cf73a21c1ea3593295a6e7d8633a95db05fbcb642e7c74992',
  'native/contracts/tests/capability_contract.rs': '797298ce4a1a33934b400cafc37f22f8e9592a0e4067dbc1a868987182fd9cac',
  'native/contracts/tests/chain_contract.rs': '29b0f790a72565653c134c9f11d5b8384d19c36e0f9f7fd6c6196328cd1f103f',
  'native/contracts/tests/secret_contract.rs': '0b4e1c3046004f0a313488462fae6e0f7807ec6b8b90e608d464e0c701046750',
  'native/contracts/tests/state_store_contract.rs': '0ebc2d16392bcc7c80d57276b8fe8a6012f6387dbde14b4a0e63ffd8d366d209',
  'native/contracts/tests/transaction_history_contract.rs': '88a08ac80f2a131a6f1a4e215ba0b55e8476fac71059b9ab14ff329159724f54',
  'native/contracts/tests/transaction_build_contract.rs': '4fcc035715077d907e3a31f86e7bf1fb11cc4791bed9b75b0c38c4a04282cb25',
  'native/contracts/tests/transaction_prepare_contract.rs': '1ff363381350352c500fd639b3346e6dd2be556cad23878755268b90a17712dc',
  'native/engine/Cargo.toml': '518b47a8a3d4fa3e69959392b57d7b07dedc55519ea19304dd20bed691635b0c',
  'native/engine/src/account_state.rs': '55bfefcff2038ba1cdbe71846b3acc7d1ffa5177d95e057d029c0f1d1b5e78fd',
  'native/engine/src/capabilities.rs': 'c729aaef5559127aeb2185ea2793456a3bc73346724996a190cc66a97c58181e',
  'native/engine/src/engine.rs': 'd6d5a7f5f80932bac49f097d7dadffef34b019e3d7611b2cd26a596f43447629',
  'native/engine/src/error.rs': '949efd108cc8c2205f2adf58d03b55148bc88c03c89e0acd9f453f52716c2bcf',
  'native/engine/src/finalized_history_runtime.rs': 'fff50b2949481b99aff2fa7e3569ab6902c7c3d6b7f676d4564570cdbc729325',
  'native/engine/src/lib.rs': '700693ea2dd0792fd69ec21836ae9381b4ccb96d0afc77b2cae872bb83f4f998',
  'native/engine/src/metadata.rs': 'c8adc893d483ec0dc7624aa8cefb5b3793ae9ec2f402dce7d731054f93d97fa8',
  'native/engine/src/runtime_context.rs': 'b7bac6e77f1761237ba3a309cbcc15b68bcedc49f1fb85d65366cf145ef73b6f',
  'native/engine/src/state_import.rs': '1308efbbc2626bfd5f9cc936a8e3c6e4984dbc6e2e2dda9dc0917b24d98eaa01',
  'native/engine/src/system_events.rs': 'd3f2722e4106d615a6d96e4b9b92c89b97413d6f6b17d4026e167435eb790d22',
  'native/engine/src/transaction_prepare.rs': 'bf009406fe2deb2a39d3ae8bacb1a83c7feb546d6b1c2ab0affba3b55fcc2722',
  'native/engine/src/transaction_execution.rs': '86bfaeffbc4b2ee5a8d6b2a074b331830dc0e6c13c3a50e8b541338a3ef0b172',
  'native/engine/src/transaction_history.rs': '4cc4636d48c5b4876c0e773e04d8482a96055e8d90862ca5949b2f9ce00b2b12',
  'native/engine/src/transaction_outcome.rs': '19efcf69c62c79c329070636a69383417d064bc1ad5a312efd27543d29b86a5a',
  'native/engine/src/wallet_derivation.rs': '6fbb0293b709e3f1757c2af4230fbd2976b3c43d79785cdf1dddab43e93fd14a',
  'native/engine/src/wallet_derivation_tests.rs': '0af6e57e748e0811e5651841ec40e3be43618139ea138b5491178a325e5a438d',
  'native/engine/src/wallet_service.rs': 'ffb0a185f42a53715fc28cd2e9b007c33df20e3aeb4f840fb354ba686cdb8563',
  'native/engine/src/wallet_service_tests.rs': 'a670d270f1ce02fe2dcdaa746859a1fc8b5611a0ed63f0048a3a983257d6cbd6',
  'native/engine/tests/account_state.rs': '1f64f4b7e245c1aece23d73cb885d5a1ca0a6a9d5c632414e34ed542c6828289',
  'native/engine/tests/capabilities.rs': 'dcfdbffcbaeabc44a6d6934021b2a80ec593d6c8b64b23a7cfbed8b6791f3e93',
  'native/engine/tests/chain_access.rs': '8df836b9bb209fe4db1dfc8766410172a12e042da9236c5898f5292d0bcc4cf5',
  'native/engine/tests/engine_boundary.rs': '62d04ec6b9035204c4f44777cbf08815521bd63e29146b8bcceb8774190bcbd3',
  'native/engine/tests/runtime_context.rs': 'e5eb9f999668b6664d29ba61a0c8b2fd8b2e9fe37f7830bb4f4b7732b9c4fe43',
  'native/engine/tests/state_import.rs': '6937752568de3531a32b8ad35b1fd7270abad120c4b5aac423ae7df970d3f917',
  'native/engine/tests/transaction_outcome.rs': '68a05dfbdeedccaf70c22f83f88ad05131e8f65f9c2f355f12ce93d90e7d0645',
  'native/ffi/Cargo.toml': 'ca8ba157dcc0caf082952c22473f106e0ba2b49f5d10a4d6bfeb32bcc69025ff',
  'native/ffi/src/abi.rs': 'a15856e2d7e29884b205842e91cda6a79132be7c5547c31772c6e3d2fc628c8c',
  'native/ffi/src/assets.rs': '471cba32ee1792ea97fc4f15bbbb20da2b00a00948d6f85ecdc5dae1281a9acf',
  'native/ffi/src/capabilities.rs': '107ae5a5fe465b6ed20af8e9117c892424b33a9f6fe572b8f73ef2b9200775fa',
  'native/ffi/src/composition.rs': '89791c6cf65bebcece27a9feceafebe27a550f7a541455154b7481de2e01689a',
  'native/ffi/src/composition_tests.rs': '36914d26faee5e3d063317cc29dad51caaa43a5f605915895b89910e30bb3ed7',
  'native/ffi/src/error.rs': '8c22eafa0b4ceac60a136fc0cd1f46471a7336eb5ea50ee0967c7ecbff15e5e5',
  'native/ffi/src/events.rs': '2bab42f8a4048f60e6bbe64d1c4b6e15bf5881b84f9504de91288f8e266440bf',
  'native/ffi/src/handles.rs': '9e248ecb6fb9506b85d098172b731c22787f9860ccb53926ebc793da1fffd0c9',
  'native/ffi/src/host_codec.rs': '9a2624f73e1978ec16bb35311269eb8ed1b908626339dfabcf8c90ec8b062c8c',
  'native/ffi/src/host_codec_tests.rs': '2c4530aa91512284dd273663c31e80c3a47734be82a04fe8a5245d0beb80574a',
  'native/ffi/src/host_providers.rs': '1653cb7db2eb3d3ccce4b75bbc634e911ce1e50a118ed0f41730f84b34816069',
  'native/ffi/src/lib.rs': '877431bb2a0578c34ebf4ed7c2d909c2d31c9048952826feaeb60648e905326d',
  'native/ffi/src/ownership.rs': '43879c13259b19a4f5b533e8dae63e333529e26da09a802896fb3a204e877b45',
  'native/ffi/src/qr_abi.rs': 'eb858f929ebc7b0dd1a31b8f384b60ae27e776b077a8b24d55aaf7218fc5ac40',
  'native/ffi/src/requests.rs': '09d07604e36d2c2d1e6887ac81176fd5c4958628accb479189919e86e94cf905',
  'native/ffi/src/runtime.rs': '867eee55ceafd28f4c973386a94116d45e60e3ce359595c495190cad377b26d3',
  'native/ffi/src/transaction_abi.rs': 'c7efad24af031b185a2b13da1b8f1e7e2208d113db3e94af18148b576aec5991',
  'native/ffi/src/wallet_abi.rs': 'e48d13f5b6bc2906683b8fc8438fce060918f3c3d0636ef82f8eeaf6da64da33',
  'native/ffi/src/wallet_abi_tests.rs': '214a78945bc9e96cb2c7bbad13c94110f9d8f5c02c2f00cc6962792ac1175177',
  'native/ffi/tests/abi_layout.rs': '3c70e50d8ba1af53588fffff5ba5681f12fae1c60e0979e8f8a298f04f3aa74e',
  'native/ffi/tests/asset_boundary.rs': '47cdc02fe23f8581671d1a3aa7116cf6a728c5097ca49fd43131391a9c66864b',
  'native/ffi/tests/c_header_c11.c': '299643fa8eb6e87dee9f3281503e3e68a6779c9b519d2564790ccb2cc41d8ad0',
  'native/ffi/tests/c_header_cpp17.cc': 'ed7d2e7e3f12476ecd9df4d80c7589273a69972acee55f996f614cd31a764468',
  'native/ffi/tests/capability_contract.rs': '7757572b88a887b866fda6d7184a11df42af56ac27c77a7bd3055c84022f5acc',
  'native/ffi/tests/error_contract.rs': 'ae585490b05768b64401b1e6774789ba1beb1eede552e4d3e70a99cd1d395d91',
  'native/ffi/tests/event_contract.rs': '2621abf7d9eb040dd43b0ade7827f38ecb5c0e492868ccd3757a154eeeeaac1b',
  'native/ffi/tests/handle_contract.rs': 'ca4dadf979b3d747327edab5f9ffd8df741cdc497235029c0f03900ec19d16f9',
  'native/ffi/tests/host_provider_contract.rs': '114ed9d3b377f876756f0dcc091c37325330d6f33632371f1a7d271298601027',
  'native/ffi/tests/ownership_contract.rs': '08112f6dd5629f4bf69d05ee7a4a3b425c300adced89e6c924a444a7fe2821bd',
  'native/ffi/tests/qr_abi_contract.rs': '760aac708a04c952eaf2563d7c96b3ddede85a095ae2268bb89cba625be5725a',
  'native/ffi/tests/request_contract.rs': 'b657a3f4ff677e61a1fc890a58f79c0461db35bc76c00dff90a76e8d4b6ca833',
  'native/ffi/tests/symbol_contract.rs': '5b9cb4f2bf01debd05fb53f235ba318b498e6967bce89cafa6f8efb4a4b180db',
  'native/ffi/tests/wallet_abi_contract.rs': '030657f3a0254597e604aa1f8b4449cd542ba483668f77e92d99f30d243708f1',
  'native/qr/Cargo.toml': '5bee37654c4e2198ae00b65578cf6c005df3b8000434dfa9a9948bc5853505b4',
  'native/contracts/src/signing.rs': 'a55cabb69e572c70e3b25d316a3cf69d86930299ad51f90fe2a54341ba154907',
  'native/qr/src/codec.rs': 'ca467f6c9f51c5847f7558b93a046c55900d115b46ed6ee70d60792ee5bf3c18',
  'native/qr/src/lib.rs': '80108ffffb7eb50c425e7f65bb9acacb025283b8568ab345f63c2663d0ead0c0',
  'native/qr/src/session.rs': 'ed0aeaf91e375fff2a4f8901b090d1d4f725674946cc881580e06cd90eafae0f',
  'native/qr-image/CMakeLists.txt': '9e3ba578a613fe69fbb8026f957f2968cddef48912f6e6eb9b928bc701151ec5',
  'native/qr-image/citizensdk_qr_image.cc': 'd202695159393c46083f67d4199fd5ee99e87cec9289a654d6ce08b295b09a77',
  'native/qr-image/citizensdk_qr_image.h': '80856c440e590786cdf026cf3011a27f7ab1d62508ce8fb5e3fa4156df72861a',
  'native/qr-image/citizensdk_qr_image_test.cc': '68437056555e173ec390b65b83cc5fbb9b8b994cddbcf5847f86ac9a05d60290',
});
// native 根只能拥有这些已审核直接条目，防止出现第二个未审查的 Rust 产品边界。
const NATIVE_ROOT_ENTRIES = Object.freeze({
  contracts: 'directory',
  engine: 'directory',
  ffi: 'directory',
  qr: 'directory',
  'qr-image': 'directory',
  signer: 'directory',
  smoldot: 'directory',
});
// Core Rust 的 workspace 入口与解析闭包必须与源码闭集
// 同步审核；每个边界文件都固定最终审核字节，任何后续漂移均失败关闭。
const CORE_RUST_BOUNDARY_FILES = Object.freeze({
  'Cargo.toml': '14075635ef9ea5effbc3c372c3e0e54b4bf406bf8badafb3d2d88e479800e0fc',
  'Cargo.lock': '07e34bab68cc18eaeeb82b8e624b429226426f3eef9355d39ee650b4f31d6d0b',
});
// 该清单离线固定 FFI、PoW workspace、light-base 与 lib 的完整文件闭集；
// byte_identical 项来自 CitizenApp 初始稳定基线，adapted/sdk_only 是已审查的
// SDK 边界。清单自身再由此哈希固定，CI/Release 不回指 CitizenApp。
const SMOLDOT_RUST_SOURCE_MANIFEST = Object.freeze({
  path: 'native/smoldot/SOURCE_SHA256.json',
  sha256: 'c47f9af3e7635e2c914c65fa5d73a59d3e11b1d6a8a338b674bde91346e46073',
});
// 这些文件位于各来源单元之外，但仍属于 Release 的正式输入：许可证、来源记录、
// smoldot 原始 ABI 头文件以及由 light-base 示例通过 include_str! 编译引用的链规范。
// 它们与来源清单中的全部来源单元共同组成 native/smoldot 的动态完整闭集；
// Dart 绑定已迁出本原生目录并由 SMOLDOT_DART_FILES 独立固定。
const SMOLDOT_SUPPORT_FILES = Object.freeze({
  'native/smoldot/LICENSE': 'aab56b4a581fc1c50b7c782eacf2fc8be05a47cd98e4bf4d836dd9b6dd9c86f4',
  'native/smoldot/LICENSE-APACHE-2.0': '4524e4d70a6295dfa882b0411cc49fcca03273e959fea68bbfe7df7ed63e7d78',
  'native/smoldot/UPSTREAM.md': 'b28e30961ab2d6929efadeff13ab16e423b4cdf2725ccf777e681a611f024a19',
  'native/smoldot/smoldot.h': 'f7c2645588809f73f8aa799975b363a4a7b22e8de7149da9d0b4c2ea20c90a20',
  'native/smoldot/pow/demo-chain-specs/polkadot.json': '859c8ade8b740e6a106082e0fdb4ae14075d79f8a277f02124bf9856d8a302aa',
  'native/smoldot/pow/demo-chain-specs/polkadot_asset_hub.json': '4909f824189edd0c7c64e444f81a4082fe5bc433861a5ac9e8b00838203a35ab',
});
// signer 是可编译的 Rust crate，正式输入不能只固定 Cargo.toml 与 lib.rs；
// sr25519 单一实现、ChainSigner 适配和四份合同测试共同进入同一 8 文件闭集；
// 任何 build.rs、src/bin 或其他新增文件
// 都会改变 Cargo 行为，因此一律失败关闭。
const SIGNER_FILES = Object.freeze({
  'native/signer/Cargo.toml': '461f910465466d8cd24047ef3c87e5b082d000b76592cbc1f6f1c97d8b0bd28f',
  'native/signer/src/chain_signer.rs': '3461762743fb5723575b892171465ef31801b781262e1f3963ae5cbe12958a36',
  'native/signer/src/lib.rs': 'd1d2a35a70a8fbd7453e02f441a875f5c482cb22a98ccb27695594f7b006a869',
  'native/signer/src/sr25519.rs': 'c1159ff1a357b6c08b59d8a22d14a6b4a6cee313166ad0a435487192754f8ab4',
  'native/signer/tests/chain_signer_contract.rs': 'd4e53512dffab3f75ee213a08b71909dbc6c667b4b287df39cd9ac3e62824b31',
  'native/signer/tests/ffi_contract.rs': 'bf38f650394011e7f68219ee8ba435453f616281f91649634c536b8620407038',
  'native/signer/tests/legacy_parity.rs': '984a1521042d8a5b2285a43459383ef3972058db20e8f05154c1f75a2a11d70f',
  'native/signer/tests/substrate_vectors.rs': 'f5587dbce91f9c2014c559bece142e56fe65c81c7cf097df66b6c8125d45eef9',
});

function fail(message) {
  throw new Error(message);
}

function regularSourceText(root, relativePath, label) {
  const path = join(root, ...relativePath.split('/'));
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()
      || !lstatSync(path).isFile()) {
    fail(`CitizenSDK Flutter ${label} 权威源码缺失或不是普通文件：${relativePath}`);
  }
  return readFileSync(path, 'utf8');
}

function uniqueSourceCapture(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`CitizenSDK Flutter ${label} 权威声明必须唯一`);
  }
  return matches[0][1];
}

function methodLiterals(block, label) {
  const pattern = /["']([A-Za-z][A-Za-z0-9]*)["']/g;
  const methods = [...block.matchAll(pattern)].map((match) => match[1]);
  const residue = block.replace(pattern, '').replace(/[\s,]/g, '');
  if (residue.length !== 0) {
    fail(`CitizenSDK Flutter ${label} 方法权威表只能包含字符串字面量`);
  }
  return methods;
}

/**
 * Freeze the shared Flutter protocol without treating any binding as another
 * binding's source of truth. Named channel constants and the one authoritative
 * method table are parsed from Dart, Android, Darwin, Linux and Windows independently,
 * then matched against the standalone v1 gold list above.
 */
export function assertFlutterBindingContract(root) {
  const sourceRoot = resolve(root);
  const bindings = [
    {
      label: 'Dart',
      channelPath: 'lib/src/platform/flutter_citizen_sdk_platform.dart',
      methodPath: 'lib/src/platform/citizen_sdk_flutter_codec.dart',
      methodChannel: /static const String methodChannelName\s*=\s*'([^']+)'\s*;/g,
      eventChannel: /static const String eventChannelName\s*=\s*'([^']+)'\s*;/g,
      runtimeMethodChannel: /methodChannel\s*\?\?\s*const MethodChannel\('([^']+)'\)/g,
      runtimeEventChannel: /eventChannel\s*\?\?\s*const EventChannel\('([^']+)'\)/g,
      methods: /static const Set<String> methods\s*=\s*<String>\{([\s\S]*?)^[ \t]{2}\};/gm,
    },
    {
      label: 'Android',
      channelPath: 'android/src/main/kotlin/CitizenSdkFlutterCodec.kt',
      methodPath: 'android/src/main/kotlin/CitizenSdkFlutterCodec.kt',
      methodChannel: /const val METHOD_CHANNEL\s*=\s*"([^"]+)"/g,
      eventChannel: /const val EVENT_CHANNEL\s*=\s*"([^"]+)"/g,
      methods: /val methods: Set<String>\s*=\s*linkedSetOf\(([\s\S]*?)^[ \t]{4}\)/gm,
    },
    {
      label: 'Darwin',
      channelPath: 'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterCodec.swift',
      methodPath: 'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterCodec.swift',
      methodChannel: /static let methodChannel\s*=\s*"([^"]+)"/g,
      eventChannel: /static let eventChannel\s*=\s*"([^"]+)"/g,
      methods: /static let methods: Set<String>\s*=\s*\[([\s\S]*?)^[ \t]{4}\]/gm,
    },
    {
      label: 'Linux',
      channelPath: 'linux/src/citizen_sdk_flutter_codec.hpp',
      methodPath: 'linux/src/citizen_sdk_flutter_codec.cc',
      methodChannel: /kMethodChannel\s*=\s*"([^"]+)"\s*;/g,
      eventChannel: /kEventChannel\s*=\s*"([^"]+)"\s*;/g,
      methods: /constexpr const char \*kMethods\[\]\s*=\s*\{([\s\S]*?)^\};/gm,
    },
    {
      label: 'Windows',
      channelPath: 'windows/src/citizen_sdk_flutter_codec.hpp',
      methodPath: 'windows/src/citizen_sdk_flutter_codec.cc',
      methodChannel: /kMethodChannel\s*=\s*"([^"]+)"\s*;/g,
      eventChannel: /kEventChannel\s*=\s*"([^"]+)"\s*;/g,
      methods: /constexpr const char \*kMethods\[\]\s*=\s*\{([\s\S]*?)^\};/gm,
    },
  ];
  const expectedMethods = JSON.stringify(FLUTTER_METHODS);
  for (const binding of bindings) {
    const channelSource = regularSourceText(
      sourceRoot, binding.channelPath, `${binding.label} channel`,
    );
    const methodSource = binding.methodPath === binding.channelPath
      ? channelSource
      : regularSourceText(sourceRoot, binding.methodPath, `${binding.label} method`);
    const methodChannel = uniqueSourceCapture(
      channelSource, binding.methodChannel, `${binding.label} MethodChannel`,
    );
    const eventChannel = uniqueSourceCapture(
      channelSource, binding.eventChannel, `${binding.label} EventChannel`,
    );
    if (methodChannel !== FLUTTER_METHOD_CHANNEL) {
      fail(`CitizenSDK ${binding.label} Flutter MethodChannel 合同漂移`);
    }
    if (eventChannel !== FLUTTER_EVENT_CHANNEL) {
      fail(`CitizenSDK ${binding.label} Flutter EventChannel 合同漂移`);
    }
    // Dart currently exposes named channel constants and also instantiates the
    // default channels at its runtime seam. Freeze both until Dart switches to
    // directly referencing those constants; otherwise an unused constant could
    // conceal a real transport-channel drift.
    if (binding.runtimeMethodChannel !== undefined
        && uniqueSourceCapture(channelSource, binding.runtimeMethodChannel,
                               `${binding.label} runtime MethodChannel`)
          !== FLUTTER_METHOD_CHANNEL) {
      fail(`CitizenSDK ${binding.label} Flutter runtime MethodChannel 合同漂移`);
    }
    if (binding.runtimeEventChannel !== undefined
        && uniqueSourceCapture(channelSource, binding.runtimeEventChannel,
                               `${binding.label} runtime EventChannel`)
          !== FLUTTER_EVENT_CHANNEL) {
      fail(`CitizenSDK ${binding.label} Flutter runtime EventChannel 合同漂移`);
    }
    const methods = methodLiterals(
      uniqueSourceCapture(methodSource, binding.methods,
                          `${binding.label} methods`),
      binding.label,
    );
    if (methods.length !== 96 || JSON.stringify(methods) !== expectedMethods) {
      fail(`CitizenSDK ${binding.label} Flutter 方法合同漂移：必须精确为固定 96 项`);
    }
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prettyStableJson(value) {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

function assertOutsideSource(source, target, label) {
  const sourcePath = resolve(source);
  const resolvedSource = existsSync(sourcePath) ? realpathSync(sourcePath) : sourcePath;
  const sourcePrefix = `${resolvedSource}${sep}`;
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedSource || resolvedTarget.startsWith(sourcePrefix)) {
    fail(`${label} 禁止位于 CitizenSDK 源码树：${resolvedTarget}`);
  }
}

function assertSafeTargetPath(path, label) {
  if (typeof path !== 'string' || path.length === 0 || resolve(path) !== path) {
    fail(`${label} 必须使用不含 .、.. 或重复分隔符的绝对规范路径：${path || '<empty>'}`);
  }
  const resolved = resolve(path);
  let current = sep;
  const segments = resolved.split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) fail(`${label} 的既存路径祖先禁止使用符号链接：${current}`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      fail(`${label} 的既存路径祖先不是目录：${current}`);
    }
  }
  return resolved;
}

function assertLocalTarget(path, label) {
  const target = assertSafeTargetPath(path, label);
  return target;
}

function ensureNewDirectory(path, source, label) {
  assertSafeTargetPath(path, label);
  assertOutsideSource(source, path, label);
  if (existsSync(path)) fail(`${label} 已存在，拒绝覆盖：${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

// 仓库存放路径只定义一次；编译工程恢复原始模块路径，绝不改写上游源码字节。
const NATIVE_COMPILE_PATHS = Object.freeze({
  "native/smoldot/smoldot.h": "native/smoldot/include/smoldot.h",
  "native/smoldot/pow/lib/src/chain/chain_information_build.rs": "native/smoldot/pow/lib/src/chain/chain_information/build.rs",
  "native/smoldot/pow/lib/src/database/finalized_serialize_defs.rs": "native/smoldot/pow/lib/src/database/finalized_serialize/defs.rs",
  "native/smoldot/pow/lib/src/executor/trie_root_calculator_tests.rs": "native/smoldot/pow/lib/src/executor/trie_root_calculator/tests.rs",
  "native/smoldot/pow/lib/src/identity_ss58.rs": "native/smoldot/pow/lib/src/identity/ss58.rs",
  "native/smoldot/pow/lib/src/libp2p/connection/single_stream_handshake_tests.rs": "native/smoldot/pow/lib/src/libp2p/connection/single_stream_handshake/tests.rs",
  "native/smoldot/pow/lib/src/network/kademlia_kbuckets.rs": "native/smoldot/pow/lib/src/network/kademlia/kbuckets.rs",
  "native/smoldot/pow/lib/src/transactions/light_pool_tests.rs": "native/smoldot/pow/lib/src/transactions/light_pool/tests.rs",
  "native/smoldot/pow/lib/src/transactions/pool_tests.rs": "native/smoldot/pow/lib/src/transactions/pool/tests.rs",
  "native/smoldot/pow/lib/src/trie/branch_search_tests.rs": "native/smoldot/pow/lib/src/trie/branch_search/tests.rs",
  "native/smoldot/pow/lib/src/trie/trie_structure_tests.rs": "native/smoldot/pow/lib/src/trie/trie_structure/tests.rs",
  "native/smoldot/pow/light-base/basic.rs": "native/smoldot/pow/light-base/examples/basic.rs",
  "native/smoldot/pow/light-base/src/json_rpc_service_background.rs": "native/smoldot/pow/light-base/src/json_rpc_service/background.rs",
  "native/smoldot/pow/light-base/src/network_service_tasks.rs": "native/smoldot/pow/light-base/src/network_service/tasks.rs"
});

// 中文注释：来源验真复用同一真实模块路径字典，仓库存放路径不冒充上游路径。
export function nativeCompilePath(path) {
  return NATIVE_COMPILE_PATHS[path] ?? path;
}

/** Cargo唯一源码外输入：普通副本隔离build.rs写入，锁文件、测试夹具与链资源同轮装配。 */
export function createNativeSourceView(sourcePath, outputPath) {
  const source = resolve(sourcePath), output = resolve(outputPath);
  const within = (root, path) => {
    const part = relative(root, path);
    return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part));
  };
  const checkPath = (path, label) => {
    if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail(label + '必须是规范绝对路径');
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(sep)) {
      current = join(current, part);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (!info) break;
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current) {
        fail(label + '禁止链接或非目录祖先');
      }
    }
  };
  checkPath(sourcePath, '原生来源'); checkPath(outputPath, '原生工程');
  if (within(source, output) || within(output, source)) fail('原生工程与来源必须分离');
  assertCoreRustSource(source);
  assertSignerSource(source);
  assertSmoldotRustSource(source);
  assertSourceFixtures(source);
  const files = ['Cargo.toml', 'Cargo.lock'];
  for (const root of ['native', 'include', 'chain', 'test']) {
    for (const path of regularFiles(join(source, root))) files.push(root + '/' + path);
  }
  const entries = new Map();
  const destinations = new Set();
  for (const path of files.sort()) {
    const input = join(source, path);
    const info = lstatSync(input);
    if (!info.isFile() || info.isSymbolicLink()) fail('原生输入必须是普通文件：' + path);
    const target = NATIVE_COMPILE_PATHS[path] ?? path;
    const key = target.normalize('NFC').toLowerCase();
    if (destinations.has(key)) fail('原生编译路径冲突：' + target);
    destinations.add(key);
    entries.set(target, { data: readFileSync(input), mode: info.mode & 0o777 });
  }
  for (const [stored, compiled] of Object.entries(NATIVE_COMPILE_PATHS)) {
    if (!files.includes(stored) || files.includes(compiled)) fail('原生路径映射来源缺失或重复：' + stored);
  }
  const verify = () => {
    if (JSON.stringify(regularFiles(output)) !== JSON.stringify([...entries.keys()].sort())) {
      fail('原生工程文件闭集漂移');
    }
    for (const [path, { data }] of entries) {
      if (!readFileSync(join(output, path)).equals(data)) fail('原生工程字节漂移：' + path);
    }
  };
  // 同次构建的多个原生阶段只准复用完全一致的工程，禁止覆盖漂移内容或链接。
  if (lstatSync(output, { throwIfNoEntry: false })) { verify(); return output; }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  try {
    for (const [path, { data, mode }] of entries) {
      const target = join(output, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, data, { flag: 'wx', mode });
    }
    verify();
  } catch (error) {
    // 只清理本函数刚创建的独占工程；已有工程验证失败时保持原状。
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return output;
}

// 仓库保留扁平源码；Flutter消费位置由SDK唯一声明，包身份不随物理路径改变。
const FLUTTER_ENTRY_SOURCE = 'android/src/main/kotlin/CitizenSdkPlugin.kt';
const FLUTTER_ENTRY_PACKAGE = 'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt';

function flutterPackagePath(path) {
  return path === FLUTTER_ENTRY_SOURCE ? FLUTTER_ENTRY_PACKAGE : path;
}

function flutterEntryBytes(source) {
  const entry = join(source, FLUTTER_ENTRY_SOURCE);
  if (!lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) {
    fail('CitizenSDK Flutter入口来源必须是普通源文件');
  }
  if (lstatExists(join(source, FLUTTER_ENTRY_PACKAGE))) fail('CitizenSDK源码出现重复Flutter入口');
  const lock = join(source, 'pubspec.lock');
  if (!lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink()) fail('CitizenSDK消费来源缺少普通Pub锁文件');
  const bytes = readFileSync(entry);
  const text = bytes.toString('utf8');
  const manifest = readFileSync(join(source, 'pubspec.yaml'), 'utf8');
  if (!/^package org\.citizen\.sdk\r?$/m.test(text)
      || !/\bclass CitizenSdkPlugin\s*:/.test(text)
      || !text.includes('io.flutter.embedding.engine.plugins.FlutterPlugin')
      || !/^name: citizen_sdk\r?$/m.test(manifest)
      || !/      android:\r?\n        package: org\.citizen\.sdk\r?\n        pluginClass: CitizenSdkPlugin\r?\n/.test(manifest)) {
    fail('CitizenSDK Flutter入口身份与pubspec声明不一致');
  }
  return bytes;
}

/** 本轮本地消费视图：源文件只读链接，Pub元数据独立可写；输出根禁止复用。 */
export function createFlutterSourceView(sourcePath, outputPath) {
  const source = assertSafeTargetPath(sourcePath, 'Flutter源码');
  const output = assertSafeTargetPath(outputPath, 'Flutter消费视图');
  assertOutsideSource(source, output, 'Flutter消费视图');
  assertOutsideSource(output, source, 'Flutter源码');
  flutterEntryBytes(source);
  const excluded = new Set(['.git', '.dart_tool', '.gradle', '.kotlin', '.pub-cache',
    '.symlinks', 'Pods', 'build', 'target', 'node_modules']);
  const entries = [];
  const collect = (path = '') => {
    for (const name of readdirSync(join(source, path)).sort()) {
      if (excluded.has(name)) continue;
      const relativePath = path ? `${path}/${name}` : name;
      const input = join(source, relativePath);
      const info = lstatSync(input);
      if (info.isSymbolicLink()) fail(`CitizenSDK消费来源禁止链接：${relativePath}`);
      if (info.isDirectory()) collect(relativePath);
      else if (info.isFile()) entries.push(relativePath);
      else fail(`CitizenSDK消费来源类型无效：${relativePath}`);
    }
  };
  // 完整检查来源后才创建输出，避免异常输入留下貌似有效的消费目录。
  collect();
  ensureNewDirectory(output, source, 'Flutter消费视图');
  for (const path of entries) {
    const destination = join(output, flutterPackagePath(path));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (path === 'pubspec.yaml' || path === 'pubspec.lock') {
      copyFileSync(join(source, path), destination, constants.COPYFILE_EXCL);
    } else symlinkSync(join(source, path), destination);
  }
  return output;
}

/** 复用只读视图前核对来源绑定；不接受普通副本或另一源码的入口链接。 */
export function assertFlutterSourceView(sourcePath, outputPath) {
  const source = assertSafeTargetPath(sourcePath, 'Flutter源码');
  const output = assertSafeTargetPath(outputPath, 'Flutter消费视图');
  assertOutsideSource(source, output, 'Flutter消费视图');
  assertOutsideSource(output, source, 'Flutter源码');
  const expected = flutterEntryBytes(source);
  const entry = join(output, FLUTTER_ENTRY_PACKAGE);
  // 只准许最后的文件链接；目录骨架必须由当轮视图所有者创建。
  assertSafeTargetPath(dirname(entry), 'Flutter入口父目录');
  if (!lstatSync(entry).isSymbolicLink()
      || realpathSync(entry) !== join(source, FLUTTER_ENTRY_SOURCE)
      || !readFileSync(entry).equals(expected)
      || lstatExists(join(output, FLUTTER_ENTRY_SOURCE))) fail('CitizenSDK消费视图来源绑定无效');
  for (const name of ['pubspec.yaml', 'pubspec.lock']) {
    const metadata = join(output, name);
    if (!lstatSync(metadata).isFile() || lstatSync(metadata).isSymbolicLink()
        || !readFileSync(metadata).equals(readFileSync(join(source, name)))) {
      fail('CitizenSDK消费视图Pub声明或锁文件漂移');
    }
  }
  return output;
}

/** 既有原生消费者的普通文件副本仅重排入口；正式包不能再次调用源码布局转换。 */
export function projectFlutterSourceEntry(sourcePath, packagePath) {
  const source = assertSafeTargetPath(sourcePath, 'Flutter入口源码');
  const output = assertSafeTargetPath(packagePath, 'Flutter消费包');
  assertOutsideSource(source, output, 'Flutter消费包');
  assertOutsideSource(output, source, 'Flutter入口源码');
  const original = assertSafeTargetPath(join(output, FLUTTER_ENTRY_SOURCE), '消费入口');
  const destination = assertSafeTargetPath(join(output, FLUTTER_ENTRY_PACKAGE), '消费入口目标');
  const expected = flutterEntryBytes(source);
  if (!lstatSync(original).isFile() || lstatSync(original).isSymbolicLink()
      || !readFileSync(original).equals(expected) || lstatExists(destination)) {
    fail('CitizenSDK消费入口缺失、重复或与源码不一致');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(original, destination);
  if (lstatExists(original) || !readFileSync(destination).equals(expected)) {
    fail('CitizenSDK消费入口投影回读失败');
  }
}

function copySourceTree(source, output, relativePath) {
  const sourcePath = join(source, ...relativePath.split('/'));
  const info = lstatSync(sourcePath);
  if (info.isSymbolicLink()) fail(`SDK 候选禁止符号链接：${relativePath}`);
  if (info.isDirectory()) {
    if (FORBIDDEN_DIRECTORIES.has(relativePath.split('/').at(-1))) {
      fail(`SDK 源码包含编译目录：${relativePath}`);
    }
    mkdirSync(join(output, ...relativePath.split('/')), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(sourcePath).sort()) {
      copySourceTree(source, output, `${relativePath}/${name}`);
    }
    return;
  }
  if (!info.isFile()) fail(`SDK 候选只允许普通文件和目录：${relativePath}`);
  if (/\.(?:a|aar|dylib|dll|exe|o|so)$/i.test(relativePath) || relativePath.endsWith('/exported_symbols.txt')) {
    fail(`SDK 源码树包含原生编译产物：${relativePath}`);
  }
  const destination = join(output, ...flutterPackagePath(relativePath).split('/'));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(sourcePath, destination);
}

function prefixedSymlinkContract(prefix, contract) {
  return Object.freeze(Object.fromEntries(
    Object.entries(contract).map(([path, target]) => [
      prefix.length === 0 ? path : `${prefix}/${path}`,
      target,
    ]),
  ));
}

function appleMacOSLibraryIdentifier(xcframework) {
  const infoPath = join(xcframework, 'Info.plist');
  if (!existsSync(infoPath) || lstatSync(infoPath).isSymbolicLink()
      || !lstatSync(infoPath).isFile()) {
    fail('CitizenSDK.xcframework 缺少普通 Info.plist');
  }
  const info = parseXmlPlist(
    readFileSync(infoPath),
    'CitizenSDK.xcframework Info.plist',
  );
  const matches = Array.isArray(info.AvailableLibraries)
    ? info.AvailableLibraries.filter(
      (library) => library?.SupportedPlatform === 'macos'
        && library.SupportedPlatformVariant === undefined,
    )
    : [];
  if (matches.length !== 1) {
    fail('CitizenSDK macOS XCFramework slice 元数据漂移');
  }
  const identifier = matches[0].LibraryIdentifier;
  if (typeof identifier !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) {
    fail('CitizenSDK.xcframework macOS LibraryIdentifier 无效');
  }
  return identifier;
}

// 中央阶段传输验真复用此唯一 Apple 链接合同，避免复制另一份 slice 规则。
export function appleXcframeworkSymlinkContract(xcframework, prefix = '') {
  const framework = `${appleMacOSLibraryIdentifier(xcframework)}/CitizenSDK.framework`;
  return prefixedSymlinkContract(
    prefix.length === 0 ? framework : `${prefix}/${framework}`,
    APPLE_MACOS_FRAMEWORK_SYMLINKS,
  );
}

/**
 * Enumerate a tree without following links and fail closed on every non-file
 * entry. A caller may admit a complete, exact link contract; every declared
 * link must exist, must keep its literal relative target, and must resolve
 * inside the enumerated root. This is intentionally not a generic
 * "allow symlinks" switch.
 */
function treeEntries(root, allowedSymlinks = Object.freeze({})) {
  const files = [];
  const symlinks = [];
  const seenSymlinks = new Set();
  const treeRoot = resolve(root);
  if (!existsSync(treeRoot) || lstatSync(treeRoot).isSymbolicLink()
      || !lstatSync(treeRoot).isDirectory()) {
    fail(`SDK 候选树根必须是普通目录：${treeRoot}`);
  }
  const realTreeRoot = realpathSync(treeRoot);
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = relative(treeRoot, path).split(sep).join('/');
      if (info.isSymbolicLink()) {
        const expectedTarget = allowedSymlinks[relativePath];
        if (expectedTarget === undefined) {
          fail(`SDK 候选禁止未声明符号链接：${relativePath}`);
        }
        const actualTarget = readlinkSync(path);
        if (actualTarget !== expectedTarget
            || actualTarget.startsWith('/')
            || actualTarget.split('/').includes('..')) {
          fail(`SDK 候选符号链接目标漂移：${relativePath}`);
        }
        let realTarget;
        try {
          realTarget = realpathSync(path);
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
            fail(`SDK 候选符号链接悬空或成环：${relativePath}`);
          }
          throw error;
        }
        if (realTarget !== realTreeRoot && !realTarget.startsWith(`${realTreeRoot}${sep}`)) {
          fail(`SDK 候选符号链接越出受控根：${relativePath}`);
        }
        symlinks.push(relativePath);
        seenSymlinks.add(relativePath);
        continue;
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(relativePath);
      else fail(`SDK 候选只允许普通文件和目录：${relativePath}`);
    }
  };
  visit(treeRoot);
  const expectedSymlinks = Object.keys(allowedSymlinks).sort();
  const actualSymlinks = [...seenSymlinks].sort();
  if (JSON.stringify(actualSymlinks) !== JSON.stringify(expectedSymlinks)) {
    const actual = new Set(actualSymlinks);
    const missing = expectedSymlinks.filter((path) => !actual.has(path));
    fail(`SDK 候选缺少已声明符号链接：${missing.join(',') || '无'}`);
  }
  return { files: files.sort(), symlinks: actualSymlinks };
}

function regularFiles(root) {
  return treeEntries(root).files;
}

// File-only closures cannot detect a newly added empty/generated directory.
// Linux CMake state is especially prone to leaving such paths behind, so the
// platform source contract also closes the directory topology without ever
// following links.
function regularDirectories(root) {
  const treeRoot = resolve(root);
  if (!existsSync(treeRoot) || lstatSync(treeRoot).isSymbolicLink()
      || !lstatSync(treeRoot).isDirectory()) {
    fail(`SDK 候选树根必须是普通目录：${treeRoot}`);
  }
  const directories = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = relative(treeRoot, path).split(sep).join('/');
      if (info.isSymbolicLink()) {
        fail(`SDK 候选禁止未声明符号链接：${relativePath}`);
      }
      if (info.isDirectory()) {
        directories.push(relativePath);
        visit(path);
      } else if (!info.isFile()) {
        fail(`SDK 候选只允许普通文件和目录：${relativePath}`);
      }
    }
  };
  visit(treeRoot);
  return directories.sort();
}

function releaseCandidateEntries(root) {
  const candidate = resolve(root);
  const xcframework = join(candidate, ...APPLE_XCFRAMEWORK_PATH.split('/'));
  const symlinks = existsSync(xcframework)
    && !lstatSync(xcframework).isSymbolicLink()
    && lstatSync(xcframework).isDirectory()
    ? appleXcframeworkSymlinkContract(xcframework, APPLE_XCFRAMEWORK_PATH)
    : Object.freeze({});
  return treeEntries(candidate, symlinks);
}

/**
 * Verify the complete, immutable smoldot Dart source snapshot under [root].
 *
 * The check is applied both before copying a source tree and while verifying a
 * finished candidate, so neither an omitted test nor a self-consistent but
 * modified release manifest can hide source drift.
 */
export function assertSmoldotDartSource(root) {
  const sourceRoot = resolve(root);
  if (existsSync(join(sourceRoot, 'docs'))) {
    fail('CitizenSDK 产品源码禁止包含 docs 目录；文档和归档只允许存在塔塔文档库');
  }
  const actualPaths = [];
  for (const relativeRoot of SMOLDOT_DART_ROOTS) {
    const directory = join(sourceRoot, ...relativeRoot.split('/'));
    if (!existsSync(directory)
        || lstatSync(directory).isSymbolicLink()
        || !lstatSync(directory).isDirectory()) {
      fail(`CitizenSDK 缺少普通 smoldot Dart 迁移目录：${relativeRoot}`);
    }
    actualPaths.push(
      ...regularFiles(directory).map((path) => `${relativeRoot}/${path}`),
    );
  }
  actualPaths.sort();
  const expectedPaths = Object.keys(SMOLDOT_DART_FILES).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`smoldot Dart 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const relativePath of expectedPaths) {
    const actualHash = sha256File(join(sourceRoot, ...relativePath.split('/')));
    if (actualHash !== SMOLDOT_DART_FILES[relativePath]) {
      fail(`smoldot Dart 文件哈希漂移：${relativePath}`);
    }
  }
}

export function assertSmoldotLocks(root) {
  const sourceRoot = resolve(root);
  // 根锁已受产品来源合同固定；共用合同层的直接依赖不能在独立宿主锁中分叉。
  // 这里只比较现有futures-core身份，不另设版本常量或固定整份上游锁哈希。
  const expected = resolveCargoDependency(
    parseCargoLock(join(sourceRoot, 'Cargo.lock'), 'SDK 根锁'),
    'futures-core', 'SDK 根锁',
  );
  for (const relativePath of SMOLDOT_UPSTREAM_LOCK_FILES) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail(`CitizenSDK 缺少上游 smoldot 锁文件：${relativePath}`);
    }
    const packages = parseCargoLock(path, `上游 smoldot 锁 ${relativePath}`);
    const actual = resolveCargoDependency(packages, 'futures-core', relativePath);
    if (cargoPackageIdentity(actual) !== cargoPackageIdentity(expected)
        || actual.checksum !== expected.checksum) {
      fail(`CitizenSDK futures-core 必须与根锁同一版本、来源及checksum：${relativePath}`);
    }
  }
}

export function assertSdkRootLocks(root) {
  assertPinnedFiles(root, SDK_ROOT_LOCK_FILES, 'SDK 根锁');
}

function cargoLockString(block, field, label, required = true) {
  const pattern = new RegExp(`^${field} = ("(?:[^"\\\\]|\\\\.)*")$`, 'gm');
  const matches = [...block.matchAll(pattern)];
  if (matches.length === 0 && !required) return null;
  if (matches.length !== 1) fail(`${label} 的 ${field} 字段必须精确出现一次`);
  try {
    return JSON.parse(matches[0][1]);
  } catch {
    fail(`${label} 的 ${field} 不是有效字符串`);
  }
}

function parseCargoLock(path, label) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    fail(`CitizenSDK 缺少普通${label}：${path}`);
  }
  const source = readFileSync(path, 'utf8');
  if (!/^version = 4$/m.test(source)) fail(`CitizenSDK ${label}必须是 Cargo.lock v4`);
  const blocks = source.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (blocks.length === 0) fail(`CitizenSDK ${label}没有 package 条目`);
  return blocks.map((block, index) => {
    const entryLabel = `${label} package[${index}]`;
    const name = cargoLockString(block, 'name', entryLabel);
    const version = cargoLockString(block, 'version', entryLabel);
    const registrySource = cargoLockString(block, 'source', entryLabel, false);
    const checksum = cargoLockString(block, 'checksum', entryLabel, false);
    const dependenciesMatch = block.match(/^dependencies = \[\n([\s\S]*?)^\]$/m);
    const dependencies = [];
    if (dependenciesMatch) {
      for (const line of dependenciesMatch[1].split('\n')) {
        if (line.trim().length === 0) continue;
        const match = line.match(/^ ("(?:[^"\\]|\\.)*"),$/);
        if (!match) fail(`${entryLabel} 含无法解析的 dependency 行`);
        try {
          dependencies.push(JSON.parse(match[1]));
        } catch {
          fail(`${entryLabel} 含无效 dependency 字符串`);
        }
      }
    }
    if (registrySource !== null) {
      if (registrySource !== 'registry+https://github.com/rust-lang/crates.io-index'
          || !/^[0-9a-f]{64}$/.test(checksum ?? '')) {
        fail(`${entryLabel} 不是带固定 checksum 的官方 registry 包`);
      }
    } else if (checksum !== null) {
      fail(`${entryLabel} 的 path 包禁止携带孤立 checksum`);
    }
    return { name, version, source: registrySource, checksum, dependencies };
  });
}

function resolveCargoDependency(packages, dependency, ownerLabel) {
  const match = dependency.match(/^([^ ]+)(?: ([^ ]+))?(?: \(([^)]+)\))?$/);
  if (!match) fail(`${ownerLabel} 含无法解析的依赖引用：${dependency}`);
  const [, name, version, source] = match;
  const candidates = packages.filter((entry) => entry.name === name
    && (version === undefined || entry.version === version)
    && (source === undefined || entry.source === source));
  if (candidates.length !== 1) {
    fail(`${ownerLabel} 的依赖引用不唯一或缺失：${dependency}`);
  }
  return candidates[0];
}

function cargoPackageIdentity(entry) {
  return `${entry.name}\u0000${entry.version}\u0000${entry.source ?? 'path'}`;
}

function cargoRegistryEdgeIdentity(entry) {
  if (entry.source === null) return null;
  return `${entry.name} ${entry.version}`;
}

function collectCargoClosure(packages, rootEntry, label) {
  const closure = new Map();
  const pending = [rootEntry];
  while (pending.length > 0) {
    const current = pending.pop();
    const identity = cargoPackageIdentity(current);
    if (closure.has(identity)) continue;
    closure.set(identity, current);
    for (const dependency of current.dependencies) {
      pending.push(resolveCargoDependency(
        packages,
        dependency,
        `${label} ${current.name} ${current.version}`,
      ));
    }
  }
  return closure;
}

/**
 * Prove offline that every registry package recursively reachable through the
 * product provider's bundled `smoldot-light` edge has the exact
 * name/version/checksum already fixed by the bundled PoW smoldot lock. The only
 * permitted root-only item is an exact, checksum-pinned Cargo feature-union
 * dependency reached from its declared local workspace owner through an exact
 * pinned dependency path (empty means direct). Provider-only dependencies remain
 * pinned by the root-lock byte hash;
 * they are not falsely claimed to originate in the upstream PoW lock. No Cargo
 * invocation or network fallback is allowed here.
 */
export function assertProviderLockParity(root) {
  const sourceRoot = resolve(root);
  const rootPackages = parseCargoLock(join(sourceRoot, 'Cargo.lock'), '根 Cargo.lock');
  const powPackages = parseCargoLock(
    join(sourceRoot, 'native', 'smoldot', 'pow', 'Cargo.lock'),
    'smoldot PoW Cargo.lock',
  );
  const providers = rootPackages.filter((entry) => entry.name === 'citizen-sdk-smoldot-provider');
  if (providers.length !== 1 || providers[0].source !== null) {
    fail('CitizenSDK 根锁必须精确包含一个本地 smoldot provider');
  }
  if (!providers[0].dependencies.some((dependency) => dependency === 'reqwest')) {
    fail('CitizenSDK provider registry 漂移：必须保留固定 reqwest 依赖');
  }

  const smoldotDependencies = providers[0].dependencies
    .map((dependency) => resolveCargoDependency(
      rootPackages,
      dependency,
      '根 Cargo.lock citizen-sdk-smoldot-provider',
    ))
    .filter((entry) => entry.name === 'smoldot-light' && entry.source === null);
  if (smoldotDependencies.length !== 1) {
    fail('CitizenSDK provider 必须唯一依赖随包 smoldot-light');
  }

  const rootClosure = collectCargoClosure(
    rootPackages,
    smoldotDependencies[0],
    '根 Cargo.lock',
  );
  const registryClosure = new Map(
    [...rootClosure].filter(([, entry]) => entry.source !== null),
  );
  if (registryClosure.size === 0) {
    fail('CitizenSDK provider 的随包 smoldot-light 锁闭包没有 registry 依赖');
  }

  const powSmoldotDependencies = powPackages.filter(
    (entry) => entry.name === 'smoldot-light' && entry.source === null,
  );
  if (powSmoldotDependencies.length !== 1) {
    fail('smoldot PoW 锁必须精确包含一个本地 smoldot-light');
  }
  const powClosure = collectCargoClosure(
    powPackages,
    powSmoldotDependencies[0],
    'smoldot PoW Cargo.lock',
  );

  for (const [identity, entry] of registryClosure) {
    const matchedEntry = powClosure.get(identity);
    // smoldot 是上游锁例外：根 workspace 为 provider 引入的额外 registry
    // 身份由 SDK 根 Cargo.lock 的固定哈希约束，不要求它在上游 PoW 锁中重复出现。
    // 两份锁仍分别经过 Cargo 解析、checksum 和闭包检查；这里只不把合法的根侧
    // feature-union 误判成上游锁漂移。
    if (matchedEntry === undefined) {
      const exception = PROVIDER_LOCK_FEATURE_UNION_EXCEPTIONS[`${entry.name} ${entry.version}`];
      if (exception && entry.checksum !== exception.checksum) {
        fail(`CitizenSDK provider registry 锁闭包漂移：${entry.name} ${entry.version}`);
      }
      continue;
    }
    if (matchedEntry?.checksum === entry.checksum) continue;

    const exception = PROVIDER_LOCK_FEATURE_UNION_EXCEPTIONS[`${entry.name} ${entry.version}`];
    const owners = rootPackages.filter((candidate) => candidate.name === exception?.owner
      && candidate.source === null);
    // 每条路径边必须真实存在且版本唯一，不接受只登记包名但找不到本地引入者的新增包。
    let introducingOwner = owners.length === 1 ? owners[0] : null;
    for (const identity of exception?.via ?? []) {
      const matches = introducingOwner?.dependencies.map((dependency) => resolveCargoDependency(
        rootPackages, dependency, `根 Cargo.lock ${introducingOwner.name}`,
      )).filter((candidate) => `${candidate.name} ${candidate.version}` === identity) ?? [];
      introducingOwner = matches.length === 1 ? matches[0] : null;
    }
    const ownerHasExactDependency = introducingOwner !== null && introducingOwner.dependencies.some(
      (dependency) => resolveCargoDependency(
        rootPackages,
        dependency,
        `根 Cargo.lock ${introducingOwner.name} ${introducingOwner.version}`,
      ) === entry,
    );
    if (!exception
        || entry.checksum !== exception.checksum
        || !ownerHasExactDependency) {
      fail(`CitizenSDK provider registry 锁闭包漂移：${entry.name} ${entry.version}`);
    }
  }

  for (const [identity, entry] of registryClosure) {
    const matchedEntry = powClosure.get(identity);
    if (matchedEntry === undefined) continue;

    const owner = `${entry.name} ${entry.version}`;
    if (!(owner in PROVIDER_LOCK_FEATURE_UNION_EDGE_EXCEPTIONS)) continue;
    // 上游锁例外不做未登记依赖边逐字节对拍；根锁本身已由 SDK 根锁哈希固定，
    // PoW 锁则由其自身 Cargo 解析和 checksum 校验固定。跨锁边比较会把合法的
    // workspace feature-union 版本选择误判为上游漂移。
    continue;
    const rootEdges = entry.dependencies.map((dependency) => cargoRegistryEdgeIdentity(
      resolveCargoDependency(
        rootPackages,
        dependency,
        `根 Cargo.lock ${entry.name} ${entry.version}`,
      ),
    )).filter((edge) => edge !== null).sort();
    const powEdges = matchedEntry.dependencies.map((dependency) => cargoRegistryEdgeIdentity(
      resolveCargoDependency(
        powPackages,
        dependency,
        `smoldot PoW Cargo.lock ${matchedEntry.name} ${matchedEntry.version}`,
      ),
    )).filter((edge) => edge !== null).sort();
    const rootEdgeSet = new Set(rootEdges);
    const powEdgeSet = new Set(powEdges);
    const allowedVersionUnionNames = new Set(
      PROVIDER_LOCK_FEATURE_UNION_EDGE_NAME_EXCEPTIONS[owner] ?? [],
    );
    const edgeName = (edge) => edge.split(' ', 1)[0];
    const missing = powEdges.filter((edge) => !rootEdgeSet.has(edge)
      && !allowedVersionUnionNames.has(edgeName(edge)));
    const extra = rootEdges.filter((edge) => !powEdgeSet.has(edge)
      && !allowedVersionUnionNames.has(edgeName(edge)));
    const allowedExtra = [...(PROVIDER_LOCK_FEATURE_UNION_EDGE_EXCEPTIONS[owner] ?? [])]
      .filter((edge) => !allowedVersionUnionNames.has(edgeName(edge)))
      .sort();
    if (missing.length > 0 || JSON.stringify(extra) !== JSON.stringify(allowedExtra)) {
      fail(`CitizenSDK provider registry 依赖边漂移：${owner}`);
    }
  }
  return registryClosure.size;
}

/**
 * Verify the complete CitizenSDK-owned Rust core and its workspace boundary.
 *
 * This contract deliberately does not share smoldot's imported-source manifest:
 * contracts/engine/ffi are maintained by CitizenSDK and therefore have their own
 * reverse-enumerated closure. The native root is also closed so a new crate
 * cannot enter a release merely because ROOT_DIRECTORIES recursively copies it.
 */
export function assertCoreRustSource(root) {
  const sourceRoot = resolve(root);
  const manifest = readFileSync(join(sourceRoot, 'Cargo.toml'), 'utf8');
  for (const field of ['repository', 'homepage']) {
    const declarations = manifest.match(new RegExp(`^${field}\\s*=.*$`, 'gm')) ?? [];
    if (declarations.length !== 1 || declarations[0] !== `${field} = "https://github.com/crcfrcn/citizensdk"`) {
      fail(`CitizenSDK Rust ${field} 必须为现行唯一仓库`);
    }
  }
  if (Object.keys(CORE_RUST_FILES).length !== CORE_RUST_FILE_COUNT) {
    fail(`CitizenSDK Core Rust 固定清单必须精确为 ${CORE_RUST_FILE_COUNT} 文件`);
  }
  const nativeRoot = join(sourceRoot, 'native');
  if (!existsSync(nativeRoot)
      || lstatSync(nativeRoot).isSymbolicLink()
      || !lstatSync(nativeRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通 native 根目录');
  }

  const actualNativeEntries = readdirSync(nativeRoot).sort();
  const expectedNativeEntries = Object.keys(NATIVE_ROOT_ENTRIES).sort();
  if (JSON.stringify(actualNativeEntries) !== JSON.stringify(expectedNativeEntries)) {
    const actual = new Set(actualNativeEntries);
    const expected = new Set(expectedNativeEntries);
    const missing = expectedNativeEntries.filter((path) => !actual.has(path));
    const extra = actualNativeEntries.filter((path) => !expected.has(path));
    fail(`CitizenSDK native 根闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const [name, expectedType] of Object.entries(NATIVE_ROOT_ENTRIES)) {
    const path = join(nativeRoot, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()
        || (expectedType === 'file' ? !info.isFile() : !info.isDirectory())) {
      fail(`CitizenSDK native 根条目类型漂移：${name}`);
    }
  }

  for (const relativeRoot of CORE_RUST_ROOTS) {
    const coreRoot = join(sourceRoot, ...relativeRoot.split('/'));
    if (!existsSync(coreRoot)
        || lstatSync(coreRoot).isSymbolicLink()
        || !lstatSync(coreRoot).isDirectory()) {
      fail(`CitizenSDK 缺少普通 Core Rust 来源目录：${relativeRoot}`);
    }
    const actualPaths = regularFiles(coreRoot)
      .map((path) => `${relativeRoot}/${path}`)
      .sort();
    const expectedPaths = Object.keys(CORE_RUST_FILES)
      .filter((path) => path.startsWith(`${relativeRoot}/`))
      .sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      const actual = new Set(actualPaths);
      const expected = new Set(expectedPaths);
      const missing = expectedPaths.filter((path) => !actual.has(path));
      const extra = actualPaths.filter((path) => !expected.has(path));
      fail(`CitizenSDK Core Rust 文件闭集漂移：${relativeRoot}；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
    }
  }
  assertPinnedFiles(sourceRoot, CORE_RUST_FILES, 'Core Rust 来源');
  assertPinnedFiles(sourceRoot, CORE_RUST_BOUNDARY_FILES, 'Core Rust 边界');
}

function assertPinnedFiles(root, files, label) {
  const sourceRoot = resolve(root);
  for (const [relativePath, expectedHash] of Object.entries(files)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 缺少普通${label}文件：${relativePath}`);
    }
    if (sha256File(path) !== expectedHash) {
      fail(`CitizenSDK ${label}文件哈希漂移：${relativePath}`);
    }
  }
}

function stripCComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ');
}

/** Verify the root C/C++ header closure and its product-only safety boundary. */
export function assertPublicAbiHeaders(root) {
  const sourceRoot = resolve(root);
  const includeRoot = join(sourceRoot, 'include');
  if (!existsSync(includeRoot)
      || lstatSync(includeRoot).isSymbolicLink()
      || !lstatSync(includeRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通根 include 目录');
  }
  const actualPaths = readdirSync(includeRoot).map((path) => `include/${path}`).sort();
  const expectedPaths = Object.keys(PUBLIC_ABI_FILES).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 根 include 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const relativePath of expectedPaths) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 根 include 条目必须是普通文件：${relativePath}`);
    }
  }

  const headers = expectedPaths
    .filter((path) => path.endsWith('.h'))
    .map((path) => readFileSync(join(sourceRoot, ...path.split('/')), 'utf8'))
    .join('\n');
  const publicSource = stripCComments(headers);
  const forbiddenSymbol = publicSource.match(
    /\b(?:smoldot|citizen_sr25519|account_crypto)_[A-Za-z0-9_]*\b/,
  );
  if (forbiddenSymbol) {
    fail(`CitizenSDK 公共 ABI 泄漏非产品符号：${forbiddenSymbol[0]}`);
  }

  const withoutDirectives = publicSource.replace(/^[ \t]*#.*$/gm, ' ');
  const apparentFunctions = [
    ...withoutDirectives.matchAll(
      /^[ \t]*(?!typedef\b)((?:CITIZENSDK_API[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:[ \t*]+[A-Za-z_][A-Za-z0-9_]*)*[ \t*\r\n]+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*;)/gm,
    ),
  ];
  for (const prototype of apparentFunctions) {
    if (!prototype[1].trimStart().startsWith('CITIZENSDK_API ')) {
      fail(`CitizenSDK 公共 ABI 只允许带导出标记的 citizensdk_* 函数：${prototype[2]}`);
    }
  }

  const declarations = [
    ...publicSource.matchAll(/^[ \t]*CITIZENSDK_API\b([\s\S]*?);/gm),
  ];
  if (declarations.length === 0) fail('CitizenSDK 公共 ABI 没有导出函数');
  for (const declaration of declarations) {
    const normalized = declaration[1].replace(/\s+/g, ' ').trim();
    const functionName = normalized.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
    if (!functionName || !/^citizensdk_[a-z0-9_]+$/.test(functionName)) {
      fail(`CitizenSDK 公共 ABI 只允许 citizensdk_* 函数：${functionName ?? '<unparsed>'}`);
    }
    const hasMethodAndParams = /method/i.test(normalized) && /params/i.test(normalized);
    if (/(?:^|_)rpc(?:_|$)/i.test(functionName) || hasMethodAndParams) {
      fail(`CitizenSDK 公共 ABI 禁止任意 rpc(method, params)：${functionName}`);
    }
    const forbiddenPrivateMaterial = /(?:private_?key|mini_?secret|child_?secret|(?:^|_)seed(?:_|$))/i
      .test(normalized);
    const carriesGenericSecret = /(?:^|_)secret(?:_|\b)/i.test(normalized);
    const carriesMnemonic = /mnemonic/i.test(normalized);
    const mnemonicFunctions = new Set([
      'citizensdk_import_wallet',
      'citizensdk_add_wallet_accounts',
      'citizensdk_prepared_wallet_copy_mnemonic',
      'citizensdk_add_next_wallet_account',
    ]);
    // 敏感边界只允许已登记receiver、资源控制与只读存在性的准确签名；禁止同名新增裸秘密输出。
    const sensitiveFunctions = new Map([
      ['citizensdk_set_secret_presence_provider', 'citizensdk_error_code_t citizensdk_set_secret_presence_provider( citizensdk_handle_t handle, const citizensdk_host_secret_presence_v1_t *provider)'],
      ['citizensdk_encrypted_secret_record_has_secret', 'citizensdk_error_code_t citizensdk_encrypted_secret_record_has_secret( const citizensdk_account_id_t *account_id, uint64_t expected_revision, citizensdk_bytes_view_t record, uint8_t *out_present)'],
      ['citizensdk_private_key_open', 'citizensdk_error_code_t citizensdk_private_key_open( citizensdk_handle_t handle, const citizensdk_account_id_t *account_id, const citizensdk_private_key_receiver_v1_t *receiver, uint64_t *out_secret_id, citizensdk_request_id_t *out_request_id)'],
      ['citizensdk_private_key_reveal', 'citizensdk_error_code_t citizensdk_private_key_reveal( citizensdk_handle_t handle, uint64_t secret_id)'],
      ['citizensdk_private_key_cancel', 'citizensdk_error_code_t citizensdk_private_key_cancel( citizensdk_handle_t handle, uint64_t secret_id)'],
      ['citizensdk_private_key_finish', 'citizensdk_error_code_t citizensdk_private_key_finish( citizensdk_handle_t handle, uint64_t secret_id)'],
    ]);
    if (sensitiveFunctions.has(functionName)) {
      if (normalized !== sensitiveFunctions.get(functionName)) {
        fail('CitizenSDK 敏感边界 ABI 必须保持准确登记签名');
      }
    } else if (forbiddenPrivateMaterial || carriesGenericSecret
        || (carriesMnemonic && !mnemonicFunctions.has(functionName))) {
      fail(`CitizenSDK 公共 ABI 禁止助记词、私钥或秘密导出：${functionName}`);
    }
    if (functionName === 'citizensdk_prepared_wallet_copy_mnemonic'
        && (!/\bcitizensdk_handle_t\s+handle\b/.test(normalized)
          || !/\bcitizensdk_prepared_wallet_handle_t\s+prepared_wallet\b/.test(normalized)
          || /\bout_[A-Za-z0-9_]*mnemonic[A-Za-z0-9_]*\b/i.test(normalized))) {
      fail('CitizenSDK 助记词备份 ABI 必须绑定所属 instance/prepared handle，并只写调用方通用缓冲区');
    }
  }
  assertPinnedFiles(sourceRoot, PUBLIC_ABI_FILES, '公共 ABI');
}

export function assertChainAssets(root) {
  const sourceRoot = resolve(root);
  // chain是唯一源码资产根；旧包装层即使字节相同也不接受。
  if (existsSync(join(sourceRoot, 'assets'))) fail('CitizenSDK 禁止旧资产包装目录');
  const assetsRoot = join(sourceRoot, 'chain');
  if (!existsSync(assetsRoot)
      || lstatSync(assetsRoot).isSymbolicLink()
      || !lstatSync(assetsRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通链资产目录');
  }
  const actualPaths = regularFiles(assetsRoot).map((path) => `chain/${path}`);
  const expectedPaths = Object.keys(CHAIN_ASSET_FILES).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 链资产闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertPinnedFiles(sourceRoot, CHAIN_ASSET_FILES, '链资产');

  const manifestPath = join(assetsRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('CitizenSDK 链资产 manifest 不是有效 JSON');
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    fail('CitizenSDK 链资产 manifest 必须是 JSON 对象');
  }
  const actualManifestKeys = Object.keys(manifest).sort();
  const expectedManifestKeys = Object.keys(CHAIN_ASSET_MANIFEST).sort();
  if (JSON.stringify(actualManifestKeys) !== JSON.stringify(expectedManifestKeys)) {
    fail('CitizenSDK 链资产 manifest 字段闭集漂移');
  }
  for (const [field, expected] of Object.entries(CHAIN_ASSET_MANIFEST)) {
    if (manifest[field] !== expected) {
      fail(`CitizenSDK 链资产 manifest 字段漂移：${field}`);
    }
  }
}

export function assertSourceFixtures(root) {
  assertPinnedFiles(root, SOURCE_FIXTURE_FILES, '逐字节来源夹具');
}

export function assertLicenseSources(root) {
  assertPinnedFiles(root, LICENSE_SOURCE_FILES, '许可证原文');
}

function isDocumentationFile(relativePath) {
  const name = relativePath.split('/').at(-1);
  return /\.(?:adoc|md|rst|txt)$/i.test(name)
    || /^(?:CHANGELOG|LICENSE|README|UPSTREAM)(?:[-.].*)?$/i.test(name);
}

function isAndroidTestPath(relativePath) {
  return relativePath.startsWith('src/test/')
    || relativePath.startsWith('native/src/test/')
    || relativePath.startsWith('native/src/androidTest/');
}

function isInjectedAndroidArtifact(relativePath) {
  return relativePath === 'citizensdk.aar'
    || relativePath.startsWith('src/main/jniLibs/');
}

function isDarwinTestOrInjectedArtifact(relativePath) {
  return relativePath.startsWith('Tests/')
    || relativePath === 'CitizenSDK.xcframework'
    || relativePath.startsWith('CitizenSDK.xcframework/');
}

// 源码检查默认不允许 Darwin 树出现任何链接。只有最终候选的调用点可以显式
// 开启 Apple 产物投影；即使开启，也必须逐条匹配 macOS framework 的标准五
// 链接，iOS 设备/simulator 技术变体和 Darwin 其余路径仍保持零链接。
function darwinBindingFiles(darwinRoot, allowAppleReleaseProjection) {
  const xcframework = join(darwinRoot, 'CitizenSDK.xcframework');
  const allowedSymlinks = allowAppleReleaseProjection
    ? appleXcframeworkSymlinkContract(xcframework, 'CitizenSDK.xcframework')
    : Object.freeze({});
  return treeEntries(darwinRoot, allowedSymlinks).files;
}

/** Verify every non-smoldot Dart, Android and Apple production input. */
export function assertMobileBindingSource(
  root,
  { allowAppleReleaseProjection = false, flutterPackage = false } = {},
) {
  const sourceRoot = resolve(root);
  if (Object.keys(MOBILE_BINDING_SOURCE_FILES).length !== MOBILE_BINDING_SOURCE_FILE_COUNT) {
    fail(`CitizenSDK 移动绑定固定清单必须精确为 ${MOBILE_BINDING_SOURCE_FILE_COUNT} 文件`);
  }
  const libRoot = join(sourceRoot, 'lib');
  const androidRoot = join(sourceRoot, 'android');
  const darwinRoot = join(sourceRoot, 'darwin');
  for (const [path, label] of [
    [libRoot, 'lib'],
    [androidRoot, 'android'],
    [darwinRoot, 'darwin'],
  ]) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
      fail(`CitizenSDK 缺少普通移动绑定来源目录：${label}`);
    }
  }
  // Kotlin编译器的project persistent state只能写入调用方外部工作目录；
  // 即使android/.kotlin为空，也不能让它进入源码或候选闭包。
  const kotlinSourceState = join(androidRoot, '.kotlin');
  if (existsSync(kotlinSourceState) || lstatExists(kotlinSourceState)) {
    fail('CitizenSDK 源码禁止存在 Android Kotlin 持久状态目录：android/.kotlin');
  }
  const actualPaths = [
    ...regularFiles(libRoot)
      .filter((path) => path.endsWith('.dart') && !path.startsWith('src/smoldot/'))
      .map((path) => `lib/${path}`),
    ...regularFiles(androidRoot)
      .filter((path) => !isAndroidTestPath(path)
        && !isInjectedAndroidArtifact(path)
        && (!isDocumentationFile(path) || path.endsWith('/CMakeLists.txt')))
      .map((path) => `android/${path}`),
    ...darwinBindingFiles(darwinRoot, allowAppleReleaseProjection)
      .filter((path) => !isDarwinTestOrInjectedArtifact(path)
        && !isDocumentationFile(path))
      .map((path) => `darwin/${path}`),
  ].sort();
  const expectedFiles = flutterPackage
    ? Object.fromEntries(Object.entries(MOBILE_BINDING_SOURCE_FILES)
      .map(([path, hash]) => [flutterPackagePath(path), hash]))
    : MOBILE_BINDING_SOURCE_FILES;
  const expectedPaths = Object.keys(expectedFiles).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 移动绑定文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertPinnedFiles(sourceRoot, expectedFiles, '移动绑定来源');
}

/**
 * Windows 来源与同版安装件分别闭合；候选只允许固定安装闭集。
 * 文档与 test 各归准确闭集；目录反向枚举防止空 CMake 缓存绕过文件哈希。
 */
export function assertWindowsBindingSource(root, { allowInjectedWindowsArtifacts = false } = {}) {
  const sourceRoot = resolve(root);
  const windowsRoot = join(sourceRoot, 'windows');
  if (!existsSync(windowsRoot) || lstatSync(windowsRoot).isSymbolicLink()
      || !lstatSync(windowsRoot).isDirectory()) fail('CitizenSDK 缺少普通 Windows Host 来源目录');
  if (Object.keys(WINDOWS_BINDING_SOURCE_FILES).length !== 55) {
    fail('CitizenSDK Windows Host/Flutter 固定生产清单必须精确为 55 文件');
  }
  const directories = regularDirectories(windowsRoot);
  const expectedDirectories = [...new Set(['cmake', 'citizen_sdk', 'src', 'test',
    ...(allowInjectedWindowsArtifacts ? parentDirectories(WINDOWS_RELEASE_FILES) : []),
  ])].sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) {
    fail('CitizenSDK Windows Host 目录闭集漂移');
  }
  const files = regularFiles(windowsRoot)
    .filter((path) => !allowInjectedWindowsArtifacts || !WINDOWS_INJECTED_FILES.has(path))
    .filter((path) => !path.startsWith('test/'))
    .filter((path) => path === 'CMakeLists.txt' || !isDocumentationFile(path))
    .map((path) => `windows/${path}`).sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(WINDOWS_BINDING_SOURCE_FILES).sort())) {
    fail('CitizenSDK Windows Host 文件闭集漂移');
  }
  assertPinnedFiles(sourceRoot, WINDOWS_BINDING_SOURCE_FILES, 'Windows Host 来源');
  const cmake = readFileSync(join(windowsRoot, 'CMakeLists.txt'), 'utf8');
  const versions = [...cmake.matchAll(/^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/gm)];
  if (versions.length !== 1) fail('CitizenSDK Windows Host 产品身份或版本字段不唯一');
  const pubspec = join(sourceRoot, 'pubspec.yaml');
  if (existsSync(pubspec) && readFileSync(pubspec, 'utf8').match(/^version: (.+)$/m)?.[1] !== versions[0][1]) {
    fail('CitizenSDK Windows Host 版本必须与唯一 SDK 版本一致');
  }
  const header = readFileSync(join(windowsRoot, 'citizen_sdk/citizensdk_host.h'), 'utf8');
  const functions = [...new Set([...header.matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]))].sort();
  const exports = readFileSync(join(windowsRoot, 'cmake/citizensdk_host.def'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('LIBRARY ') && line !== 'EXPORTS').sort();
  const qrImageFunctions = [
    'citizensdk_qr_image_decode_luminance',
    'citizensdk_qr_image_decode_luminance_all',
    'citizensdk_qr_image_encode_text',
    'citizensdk_qr_image_zxing_version',
  ];
  const expectedExports = [...functions, ...qrImageFunctions].sort();
  if (functions.length !== 19 || JSON.stringify(expectedExports) !== JSON.stringify(exports)) {
    fail('CitizenSDK Windows Host 导出闭集漂移');
  }
  return versions[0][1];
}

export function assertLinuxBindingSource(root, { allowInjectedLinuxArtifacts = false } = {}) {
  const sourceRoot = resolve(root);
  const linuxRoot = join(sourceRoot, 'linux');
  if (!existsSync(linuxRoot)
      || lstatSync(linuxRoot).isSymbolicLink()
      || !lstatSync(linuxRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通 Linux Host 来源目录：linux');
  }
  if (Object.keys(LINUX_BINDING_SOURCE_FILES).length
      !== LINUX_BINDING_SOURCE_FILE_COUNT) {
    fail(`CitizenSDK Linux Host 固定清单必须精确为 ${LINUX_BINDING_SOURCE_FILE_COUNT} 文件`);
  }
  const actualDirectories = regularDirectories(linuxRoot);
  const expectedDirectories = [...new Set([
    ...LINUX_BINDING_SOURCE_DIRECTORIES,
    ...(allowInjectedLinuxArtifacts ? parentDirectories(LINUX_RELEASE_FILES) : []),
  ])].sort();
  if (JSON.stringify(actualDirectories)
      !== JSON.stringify(expectedDirectories)) {
    const actual = new Set(actualDirectories);
    const expected = new Set(expectedDirectories);
    const missing = expectedDirectories
      .filter((path) => !actual.has(path));
    const extra = actualDirectories.filter((path) => !expected.has(path));
    fail(`CitizenSDK Linux Host 目录闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  const actualPaths = regularFiles(linuxRoot)
    .filter((path) => !allowInjectedLinuxArtifacts || !LINUX_INJECTED_FILES.has(path))
    .filter((path) => !path.startsWith('test/'))
    .filter((path) => path === 'CMakeLists.txt' || !isDocumentationFile(path))
    .map((path) => `linux/${path}`)
    .sort();
  const expectedPaths = Object.keys(LINUX_BINDING_SOURCE_FILES).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK Linux Host 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertPinnedFiles(sourceRoot, LINUX_BINDING_SOURCE_FILES, 'Linux Host 来源');

  const cmake = readFileSync(join(linuxRoot, 'CMakeLists.txt'), 'utf8');
  const matches = [...cmake.matchAll(
    /^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/gm,
  )];
  if (matches.length !== 1) {
    fail('CitizenSDK Linux Host CMake 产品身份或版本字段不唯一');
  }
  return matches[0][1];
}

/**
 * 校验唯一根README简明介绍及其固定字节，拒绝平台说明副本和额外docs目录。
 */
export function assertDocumentationSource(
  root,
  { allowAppleReleaseProjection = false } = {},
) {
  const sourceRoot = resolve(root);
  if (existsSync(join(sourceRoot, 'docs'))) {
    fail('CitizenSDK 产品源码禁止包含 docs 目录；技术文档只允许存在塔塔文档库');
  }
  if (Object.keys(DOCUMENTATION_SHA256).length !== DOCUMENTATION_FILE_COUNT) {
    fail(`CitizenSDK 文档固定清单必须精确为 ${DOCUMENTATION_FILE_COUNT} 文件`);
  }

  const actualPaths = [];
  const rootReadme = join(sourceRoot, 'README.md');
  if (existsSync(rootReadme)) {
    const info = lstatSync(rootReadme);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('CitizenSDK 根 README.md 必须是普通文件');
    }
    actualPaths.push('README.md');
  }

  for (const relativeRoot of ['android', 'darwin', 'lib/src', 'linux', 'windows']) {
    const documentationRoot = join(sourceRoot, ...relativeRoot.split('/'));
    if (!existsSync(documentationRoot)
        || lstatSync(documentationRoot).isSymbolicLink()
        || !lstatSync(documentationRoot).isDirectory()) {
      fail(`CitizenSDK 缺少普通产品文档来源目录：${relativeRoot}`);
    }
    const documentationFiles = relativeRoot === 'darwin'
      ? darwinBindingFiles(documentationRoot, allowAppleReleaseProjection)
      : regularFiles(documentationRoot);
    actualPaths.push(...documentationFiles
      .filter((path) => isDocumentationFile(path)
        && path !== 'native/src/main/cpp/CMakeLists.txt'
        && (!['linux', 'windows'].includes(relativeRoot) || path !== 'CMakeLists.txt')
        && (relativeRoot !== 'android' || !isAndroidTestPath(path))
        && (relativeRoot !== 'darwin' || !isDarwinTestOrInjectedArtifact(path)))
      .filter((path) => !['linux', 'windows'].includes(relativeRoot) || !path.startsWith('test/'))
      .map((path) => `${relativeRoot}/${path}`));
  }

  actualPaths.sort();
  const expectedPaths = Object.keys(DOCUMENTATION_SHA256).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 产品文档闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertPinnedFiles(sourceRoot, DOCUMENTATION_SHA256, '产品文档');
}

function compileRootedPubignoreRule(rawRule) {
  const negated = rawRule.startsWith('!');
  const rule = negated ? rawRule.slice(1) : rawRule;
  if (!rule.startsWith('/')) {
    fail(`CitizenSDK .pubignore 只允许可审计的根路径规则：${rawRule}`);
  }
  const directory = rule.endsWith('/');
  const pattern = directory ? rule.slice(1, -1) : rule.slice(1);
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // 官方 **/ 也匹配零层目录；末尾 /* 不可把父目录自身当作子项排除。
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += pattern[index - 1] === '/' && index === pattern.length - 1 ? '[^/]+' : '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return {
    ignored: !negated,
    pattern: new RegExp(`^${expression}${directory ? '(?:/.*)?' : '/?'}$`),
  };
}

function hostedPubignoreRules(sourceRoot) {
  const path = join(sourceRoot, '.pubignore');
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    fail('CitizenSDK 缺少普通 .pubignore');
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(compileRootedPubignoreRule);
}

function isHostedIgnored(relativePath, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.pattern.test(relativePath)) ignored = rule.ignored;
  }
  return ignored;
}

/** Verify the Dart files that the real pinned .pubignore exposes to Hosted consumers. */
export function assertHostedRuntimeDartProjection(root) {
  const sourceRoot = resolve(root);
  const libRoot = join(sourceRoot, 'lib');
  if (!existsSync(libRoot) || lstatSync(libRoot).isSymbolicLink()
      || !lstatSync(libRoot).isDirectory()) {
    fail('CitizenSDK Hosted Package 缺少普通 lib 目录');
  }
  const rules = hostedPubignoreRules(sourceRoot);
  const actualPaths = regularFiles(libRoot)
    .filter((path) => path.endsWith('.dart'))
    .map((path) => `lib/${path}`)
    .filter((path) => !isHostedIgnored(path, rules))
    .sort();
  const expectedPaths = [...HOSTED_RUNTIME_DART_FILES].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK Hosted Dart 运行闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  const facade = readFileSync(join(sourceRoot, 'lib/src/api/citizen_sdk.dart'), 'utf8');
  const forbiddenFacadeName = ['CitizenSdk', 'Client'].join('');
  if (!/\bfinal\s+class\s+CitizenSdk\b/.test(facade)
      || facade.includes(forbiddenFacadeName)) {
    fail('CitizenSDK Hosted Dart 唯一公开门面必须精确命名为 CitizenSdk，禁止任何旧别名');
  }
}

/** Linux 运行包分别核验源码输入与原生安装件闭集。 */
export function assertHostedRuntimeLinuxProjection(root, { allowInjectedLinuxArtifacts = false } = {}) {
  const sourceRoot = resolve(root);
  const rules = hostedPubignoreRules(sourceRoot);
  const expected = [...new Set([
    ...HOSTED_LINUX_PLUGIN_FILES,
    ...LINUX_HOST_HEADERS.map((name) => `citizen_sdk/${name}`),
    ...(allowInjectedLinuxArtifacts ? LINUX_RELEASE_FILES : []),
  ])].map((path) => `linux/${path}`).sort();
  const actual = regularFiles(join(sourceRoot, 'linux'))
    .map((path) => `linux/${path}`)
    .filter((path) => !isHostedIgnored(path, rules)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`CitizenSDK Hosted Linux 运行闭集漂移；缺失=${expected.filter((path) => !actual.includes(path)).join(',') || '无'}；额外=${actual.filter((path) => !expected.includes(path)).join(',') || '无'}`);
  }
}

/** Windows 运行包分别核验源码输入与原生安装件闭集。 */
export function assertHostedRuntimeWindowsProjection(root, { allowInjectedWindowsArtifacts = false } = {}) {
  const sourceRoot = resolve(root);
  const rules = hostedPubignoreRules(sourceRoot);
  const expected = [...new Set([...HOSTED_WINDOWS_PLUGIN_FILES,
    ...WINDOWS_HOST_HEADERS.map((name) => `citizen_sdk/${name}`),
    ...(allowInjectedWindowsArtifacts ? WINDOWS_RELEASE_FILES : []),
  ])].map((path) => `windows/${path}`).sort();
  const actual = regularFiles(join(sourceRoot, 'windows')).map((path) => `windows/${path}`)
    .filter((path) => !isHostedIgnored(path, rules)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`CitizenSDK Hosted Windows 运行闭集漂移；缺失=${expected.filter((path) => !actual.includes(path)).join(',') || '无'}；额外=${actual.filter((path) => !expected.includes(path)).join(',') || '无'}`);
  }
}

function yamlTopLevelSection(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) fail(`CitizenSDK Hosted Package 缺少 ${name}`);
  const section = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(lines[index])) break;
    section.push(lines[index]);
  }
  return section.join('\n');
}

function assertHostedDependencySection(pubspec, name, expected) {
  const section = yamlTopLevelSection(pubspec, name);
  const direct = [...section.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/gm)]
    .map((match) => [match[1], match[2].trim()]);
  const actualNames = direct.map(([dependency]) => dependency).sort();
  const expectedNames = Object.keys(expected).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail(`CitizenSDK Hosted Package ${name} 闭集漂移：${actualNames.join(',') || '无'}`);
  }
  for (const [dependency, constraint] of Object.entries(expected)) {
    const value = direct.find(([name]) => name === dependency)?.[1];
    if (constraint === null) {
      const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (value !== '' || !new RegExp(`^  ${escaped}:\\n    sdk: flutter$`, 'm').test(section)) {
        fail(`CitizenSDK Hosted Package ${name} SDK 依赖漂移：${dependency}`);
      }
    } else if (value !== constraint) {
      fail(`CitizenSDK Hosted Package ${name} 依赖约束漂移：${dependency}`);
    }
  }
}

export function assertHostedPackageSource(root, {
  allowInjectedLinuxArtifacts = false, allowInjectedWindowsArtifacts = false,
} = {}) {
  const sourceRoot = resolve(root);
  assertPinnedFiles(sourceRoot, HOSTED_PACKAGE_SOURCE_FILES, 'Hosted Package 合同');
  assertHostedRuntimeDartProjection(sourceRoot);
  assertHostedRuntimeLinuxProjection(sourceRoot, { allowInjectedLinuxArtifacts });
  assertHostedRuntimeWindowsProjection(sourceRoot, { allowInjectedWindowsArtifacts });
  const pubspecPath = join(sourceRoot, 'pubspec.yaml');
  if (!existsSync(pubspecPath)
      || lstatSync(pubspecPath).isSymbolicLink()
      || !lstatSync(pubspecPath).isFile()) {
    fail('CitizenSDK 缺少普通 Hosted Package pubspec.yaml');
  }
  const pubspec = readFileSync(pubspecPath, 'utf8');
  const pubspecVersion = pubspec.match(/^version: (\d+\.\d{1,2}\.\d{1,2})$/m)?.[1];
  // 包身份直接核对唯一现行仓库；固定摘要不能替代字段语义校验。
  const repositories = pubspec.match(/^repository:.*$/gm) ?? [];
  if (repositories.length !== 1 || repositories[0] !== 'repository: https://github.com/crcfrcn/citizensdk') {
    fail('CitizenSDK Hosted Package repository 必须为现行唯一仓库');
  }
  const podspec = readFileSync(join(sourceRoot, 'darwin/citizen_sdk.podspec'), 'utf8');
  const homepages = podspec.match(/^\s*spec\.homepage.*$/gm) ?? [];
  if (homepages.length !== 1 || !/^  spec\.homepage\s+= 'https:\/\/github\.com\/crcfrcn\/citizensdk'$/.test(homepages[0])) {
    fail('CitizenSDK Apple homepage 必须为现行唯一仓库');
  }
  if (!/^name: citizen_sdk$/m.test(pubspec) || !pubspecVersion) {
    fail('CitizenSDK Hosted Package 身份或版本无效');
  }
  if (/^publish_to:\s*["']?none["']?\s*$/m.test(pubspec)) {
    fail('CitizenSDK Hosted Package 禁止 publish_to: none');
  }
  // 两格缩进的 `path` 可以是合法 Hosted 依赖包名；只有依赖声明内部四格以上的
  // `path:`/`git:` 才表示 pub.dev 禁止的非 Hosted 来源。
  if (/^[ \t]{4,}(?:git|path):/m.test(pubspec)) {
    fail('CitizenSDK Hosted Package 禁止 git/path 依赖');
  }
  assertHostedDependencySection(pubspec, 'dependencies', HOSTED_MAIN_DEPENDENCIES);
  assertHostedDependencySection(pubspec, 'dev_dependencies', HOSTED_DEV_DEPENDENCIES);
  const platformVersions = [
    ['android/build.gradle', /^version = '(\d+\.\d{1,2}\.\d{1,2})'$/m],
    ['darwin/citizen_sdk.podspec', /^  spec\.version\s+= '(\d+\.\d{1,2}\.\d{1,2})'$/m],
    ['linux/CMakeLists.txt', /^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/m],
    ['windows/CMakeLists.txt', /^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/m],
  ].map(([relativePath, pattern]) => {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 缺少普通平台版本文件：${relativePath}`);
    }
    const version = readFileSync(path, 'utf8').match(pattern)?.[1];
    if (!version) fail(`CitizenSDK 平台版本字段无效：${relativePath}`);
    return [relativePath, version];
  });
  for (const [relativePath, version] of platformVersions) {
    if (version !== pubspecVersion) {
      fail(`CitizenSDK 包版本不一致：pubspec.yaml=${pubspecVersion}；${relativePath}=${version}`);
    }
  }
  return pubspecVersion;
}

export function assertSdkTestContracts(root) {
  const sourceRoot = resolve(root);
  if (Object.keys(SDK_TEST_CONTRACT_FILES).length !== SDK_TEST_CONTRACT_FILE_COUNT) {
    fail(`CitizenSDK 测试合同固定清单必须精确为 ${SDK_TEST_CONTRACT_FILE_COUNT} 文件`);
  }
  for (const relativeRoot of SDK_TEST_CONTRACT_ROOTS) {
    const testRoot = join(sourceRoot, ...relativeRoot.split('/'));
    if (!existsSync(testRoot)
        || lstatSync(testRoot).isSymbolicLink()
        || !lstatSync(testRoot).isDirectory()) {
      fail(`CitizenSDK 缺少普通测试目录：${relativeRoot}`);
    }
    const actualPaths = regularFiles(testRoot)
      .map((path) => `${relativeRoot}/${path}`)
      .sort();
    const expectedPaths = Object.keys(SDK_TEST_CONTRACT_FILES)
      .filter((path) => path.startsWith(`${relativeRoot}/`))
      .sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      const actual = new Set(actualPaths);
      const expected = new Set(expectedPaths);
      const missing = expectedPaths.filter((path) => !actual.has(path));
      const extra = actualPaths.filter((path) => !expected.has(path));
      fail(`CitizenSDK 测试文件闭集漂移：${relativeRoot}；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
    }
  }
  for (const relativeRoot of SDK_EMBEDDED_TEST_ROOTS) {
    const testRoot = join(sourceRoot, ...relativeRoot.split('/'));
    const actualPaths = regularFiles(testRoot)
      .filter((path) => path.endsWith('_tests.rs'))
      .map((path) => `${relativeRoot}/${path}`)
      .sort();
    const expectedPaths = Object.keys(SDK_TEST_CONTRACT_FILES)
      .filter((path) => path.startsWith(`${relativeRoot}/`) && path.endsWith('_tests.rs'))
      .sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      const actual = new Set(actualPaths);
      const expected = new Set(expectedPaths);
      const missing = expectedPaths.filter((path) => !actual.has(path));
      const extra = actualPaths.filter((path) => !expected.has(path));
      fail(`CitizenSDK 内嵌测试文件闭集漂移：${relativeRoot}；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
    }
  }
  const scriptRoot = join(sourceRoot, SDK_SCRIPT_TEST_ROOT);
  if (!existsSync(scriptRoot)
      || lstatSync(scriptRoot).isSymbolicLink()
      || !lstatSync(scriptRoot).isDirectory()) {
    fail(`CitizenSDK 缺少普通测试目录：${SDK_SCRIPT_TEST_ROOT}`);
  }
  const actualScriptTests = regularFiles(scriptRoot)
    .map((path) => `${SDK_SCRIPT_TEST_ROOT}/${path}`)
    .filter((path) => path.endsWith('.test.mjs'))
    .sort();
  const expectedScriptTests = Object.keys(SDK_TEST_CONTRACT_FILES)
    .filter((path) => path.startsWith(`${SDK_SCRIPT_TEST_ROOT}/`) && path.endsWith('.test.mjs'))
    .sort();
  if (JSON.stringify(actualScriptTests) !== JSON.stringify(expectedScriptTests)) {
    const actual = new Set(actualScriptTests);
    const expected = new Set(expectedScriptTests);
    const missing = expectedScriptTests.filter((path) => !actual.has(path));
    const extra = actualScriptTests.filter((path) => !expected.has(path));
    fail(`CitizenSDK 测试文件闭集漂移：${SDK_SCRIPT_TEST_ROOT}；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertPinnedFiles(sourceRoot, SDK_TEST_CONTRACT_FILES, '测试合同');
}

export function assertSdkScriptSource(root) {
  const sourceRoot = resolve(root);
  const scriptRoot = join(sourceRoot, 'scripts');
  if (!existsSync(scriptRoot)
      || lstatSync(scriptRoot).isSymbolicLink()
      || !lstatSync(scriptRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通 scripts 目录');
  }
  const actualEntries = readdirSync(scriptRoot).sort();
  const expectedEntries = Object.keys(SDK_SCRIPT_ENTRIES).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    const actual = new Set(actualEntries);
    const expected = new Set(expectedEntries);
    const missing = expectedEntries.filter((path) => !actual.has(path));
    const extra = actualEntries.filter((path) => !expected.has(path));
    fail(`CitizenSDK scripts 根闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const name of expectedEntries) {
    const path = join(scriptRoot, name);
    const expectedType = SDK_SCRIPT_ENTRIES[name];
    const info = lstatSync(path);
    if (info.isSymbolicLink()
        || (expectedType === 'directory' ? !info.isDirectory() : !info.isFile())) {
      fail(`CitizenSDK scripts 条目类型无效：${name}`);
    }
  }
  const executingRelease = readFileSync(fileURLToPath(import.meta.url));
  if (!readFileSync(join(scriptRoot, 'release.mjs')).equals(executingRelease)) {
    fail('CitizenSDK 候选 release.mjs 与当前执行真源不一致');
  }
  assertPinnedFiles(sourceRoot, SDK_PINNED_SCRIPT_FILES, '固定脚本');
}

export function assertSmoldotRustSource(root) {
  const sourceRoot = resolve(root);
  const manifestPath = join(
    sourceRoot,
    ...SMOLDOT_RUST_SOURCE_MANIFEST.path.split('/'),
  );
  if (!existsSync(manifestPath)
      || lstatSync(manifestPath).isSymbolicLink()
      || !lstatSync(manifestPath).isFile()) {
    fail('CitizenSDK 缺少普通 smoldot Rust 来源清单');
  }
  if (sha256File(manifestPath) !== SMOLDOT_RUST_SOURCE_MANIFEST.sha256) {
    fail('CitizenSDK smoldot Rust 来源清单漂移');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 'citizensdk.smoldot.source-sha256.v1'
      || !manifest.units || typeof manifest.units !== 'object') {
    fail('CitizenSDK smoldot Rust 来源清单 schema 无效');
  }
  const providerUnit = manifest.units.provider;
  if (!providerUnit || providerUnit.root !== 'native/smoldot/provider'
      || providerUnit.recursive !== true) {
    fail('CitizenSDK smoldot Rust 来源清单缺少递归 provider 单元');
  }
  const manifestPaths = [];
  for (const [name, unit] of Object.entries(manifest.units)) {
    if (!unit || typeof unit !== 'object' || typeof unit.root !== 'string'
        || !unit.root.startsWith('native/smoldot/')
        || typeof unit.recursive !== 'boolean') {
      fail(`CitizenSDK smoldot Rust 来源单元无效：${name}`);
    }
    const unitRoot = join(sourceRoot, ...unit.root.split('/'));
    if (!existsSync(unitRoot)
        || lstatSync(unitRoot).isSymbolicLink()
        || !lstatSync(unitRoot).isDirectory()) {
      fail(`CitizenSDK smoldot Rust 来源目录缺失：${unit.root}`);
    }
    const entries = ['byte_identical', 'adapted', 'sdk_only']
      .flatMap((category) => {
        if (!Array.isArray(unit[category])) {
          fail(`CitizenSDK smoldot Rust 来源分类无效：${name}/${category}`);
        }
        return unit[category];
      });
    const expectedPaths = entries.map((entry) => entry?.path).sort();
    if (entries.some((entry) => !entry
          || typeof entry.path !== 'string'
          || !/^[A-Za-z0-9._/-]+$/.test(entry.path)
          || entry.path.split('/').includes('..')
          || !/^[0-9a-f]{64}$/.test(entry.sha256))
        || new Set(expectedPaths).size !== expectedPaths.length) {
      fail(`CitizenSDK smoldot Rust 来源条目无效：${name}`);
    }
    const actualPaths = unit.recursive
      ? regularFiles(unitRoot)
      : readdirSync(unitRoot).filter((path) => {
          const absolute = join(unitRoot, path);
          return !lstatSync(absolute).isSymbolicLink() && lstatSync(absolute).isFile();
        }).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      fail(`CitizenSDK smoldot Rust 文件闭集漂移：${name}`);
    }
    for (const entry of entries) {
      const absolutePath = join(unitRoot, ...entry.path.split('/'));
      const isUpstreamLock = SMOLDOT_UPSTREAM_LOCK_FILES.includes(
        `${unit.root}/${entry.path}`,
      );
      if (!isUpstreamLock && sha256File(absolutePath) !== entry.sha256) {
        fail(`CitizenSDK smoldot Rust 文件哈希漂移：${name}/${entry.path}`);
      }
      manifestPaths.push(`${unit.root}/${entry.path}`);
    }
    if (!Array.isArray(unit.excluded)) {
      fail(`CitizenSDK smoldot Rust 排除集合无效：${name}`);
    }
    for (const relativePath of unit.excluded) {
      if (typeof relativePath !== 'string'
          || relativePath.split('/').includes('..')
          || existsSync(join(unitRoot, ...relativePath.split('/')))) {
        fail(`CitizenSDK smoldot Rust 排除项漂移：${name}/${relativePath}`);
      }
    }
  }

  for (const [relativePath, expectedHash] of Object.entries(SMOLDOT_SUPPORT_FILES)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 缺少普通 smoldot 支持文件：${relativePath}`);
    }
    if (sha256File(path) !== expectedHash) {
      fail(`CitizenSDK smoldot 支持文件哈希漂移：${relativePath}`);
    }
  }

  const smoldotRoot = join(sourceRoot, 'native', 'smoldot');
  const actualClosure = regularFiles(smoldotRoot)
    .map((path) => `native/smoldot/${path}`)
    .sort();
  const expectedClosure = [
    SMOLDOT_RUST_SOURCE_MANIFEST.path,
    ...manifestPaths,
    ...Object.keys(SMOLDOT_SUPPORT_FILES),
  ].sort();
  if (new Set(expectedClosure).size !== expectedClosure.length) {
    fail('CitizenSDK smoldot 来源合同存在重复路径');
  }
  if (JSON.stringify(actualClosure) !== JSON.stringify(expectedClosure)) {
    const actual = new Set(actualClosure);
    const expected = new Set(expectedClosure);
    const missing = expectedClosure.filter((path) => !actual.has(path));
    const extra = actualClosure.filter((path) => !expected.has(path));
    fail(`CitizenSDK smoldot 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
}

export function assertSignerSource(root) {
  const sourceRoot = resolve(root);
  for (const [relativePath, expectedHash] of Object.entries(SIGNER_FILES)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail(`CitizenSDK 缺少普通 signer 源文件：${relativePath}`);
    }
    if (sha256File(path) !== expectedHash) {
      fail(`CitizenSDK signer 来源字节漂移：${relativePath}`);
    }
  }
  const signerRoot = join(sourceRoot, 'native', 'signer');
  const actualClosure = regularFiles(signerRoot)
    .map((path) => `native/signer/${path}`)
    .sort();
  const expectedClosure = Object.keys(SIGNER_FILES).sort();
  if (JSON.stringify(actualClosure) !== JSON.stringify(expectedClosure)) {
    const actual = new Set(actualClosure);
    const expected = new Set(expectedClosure);
    const missing = expectedClosure.filter((path) => !actual.has(path));
    const extra = actualClosure.filter((path) => !expected.has(path));
    fail(`CitizenSDK signer 8 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
}

function replaceExact(path, pattern, replacement, label) {
  const source = readFileSync(path, 'utf8');
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) fail(`${label} 版本字段不唯一`);
  writeFileSync(path, source.replace(pattern, replacement));
}

function applySoftwareVersion(output, version) {
  replaceExact(join(output, 'pubspec.yaml'), /^version: \d+\.\d{1,2}\.\d{1,2}$/gm, `version: ${version}`, 'pubspec.yaml');
  replaceExact(join(output, 'android/build.gradle'), /^version = '\d+\.\d{1,2}\.\d{1,2}'$/gm, `version = '${version}'`, 'android/build.gradle');
  replaceExact(join(output, 'darwin/citizen_sdk.podspec'), /^  spec\.version\s+= '\d+\.\d{1,2}\.\d{1,2}'$/gm, `  spec.version          = '${version}'`, 'citizen_sdk.podspec');
  replaceExact(join(output, 'linux/CMakeLists.txt'), /^project\(CitizenSDKHost VERSION \d+\.\d{1,2}\.\d{1,2} LANGUAGES C CXX\)$/gm, `project(CitizenSDKHost VERSION ${version} LANGUAGES C CXX)`, 'linux/CMakeLists.txt');
  replaceExact(join(output, 'windows/CMakeLists.txt'), /^project\(CitizenSDKHost VERSION \d+\.\d{1,2}\.\d{1,2} LANGUAGES C CXX\)$/gm, `project(CitizenSDKHost VERSION ${version} LANGUAGES C CXX)`, 'windows/CMakeLists.txt');
}

function nativeArtifactSource(nativeRoot, sourcePath, expectedType = 'file') {
  const components = sourcePath.split('/');
  let current = nativeRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') fail(`缺少原生产物：${sourcePath}`);
      throw error;
    }
    if (info.isSymbolicLink()) {
      fail(`原生产物路径禁止符号链接：${sourcePath}`);
    }
    const isFinal = index === components.length - 1;
    const finalTypeMatches = expectedType === 'file' ? info.isFile() : info.isDirectory();
    if ((!isFinal && !info.isDirectory()) || (isFinal && !finalTypeMatches)) {
      fail(`原生产物路径类型无效：${sourcePath}`);
    }
  }
  const realSource = realpathSync(current);
  if (!realSource.startsWith(`${nativeRoot}${sep}`)) {
    fail(`原生产物真实路径越出受控根：${sourcePath}`);
  }
  return current;
}

/**
 * Reject every native-input link except the five exact versioned-macOS
 * framework links. The XCFramework directory itself and all ancestors remain
 * ordinary directories, so an allowed internal link cannot redirect the
 * native source root.
 */
// Read ELF64 little-endian directly on any CI host. PT_DYNAMIC is the runtime
// authority: section tables must identify the same mapped bytes, not a decoy
// table appended to an unrelated library. This is structural validation, not
// evidence that Linux/GTK/TPM execution or dependency provenance has passed.
function assertLinuxElf(path, platform, host, expectedSymbols) {
  const bytes = readFileSync(path);
  const label = `CitizenSDK ${platform} ${host ? 'Host' : 'Core'} ELF`;
  const reject = (message) => fail(`${label} ${message}`);
  const range = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
        || offset < 0 || size < 0 || offset > bytes.length - size) reject('范围越界');
    return offset;
  };
  const u64 = (offset) => {
    range(offset, 8);
    const value = bytes.readBigUInt64LE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) reject('64 位字段越界');
    return Number(value);
  };
  range(0, 64);
  if (!bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1]))
      || bytes.readUInt16LE(16) !== 3
      || bytes.readUInt16LE(18) !== (platform === 'LinuxARM' ? 183 : 62)
      || bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64
      || bytes.readUInt16LE(54) !== 56 || bytes.readUInt16LE(58) !== 64) {
    reject('必须是对应架构的 ELF64 little-endian ET_DYN');
  }
  const phoff = u64(32);
  const shoff = u64(40);
  const phnum = bytes.readUInt16LE(56);
  const shnum = bytes.readUInt16LE(60);
  if (!phnum || phnum === 0xffff || !shnum || shnum >= 0xff00) reject('段/节数量无效');
  range(phoff, phnum * 56);
  range(shoff, shnum * 64);
  const segments = Array.from({ length: phnum }, (_, index) => {
    const offset = phoff + index * 56;
    const file = u64(offset + 8);
    const address = u64(offset + 16);
    const size = u64(offset + 32);
    range(file, size);
    if (size > u64(offset + 40) || !Number.isSafeInteger(address + size)) reject('段长度无效');
    return { type: bytes.readUInt32LE(offset), flags: bytes.readUInt32LE(offset + 4), file, address, size };
  });
  const mapped = (address, size) => {
    const matches = segments.filter((segment) => segment.type === 1
      && address >= segment.address && size <= segment.size
      && address - segment.address <= segment.size - size);
    if (matches.length !== 1) reject('动态地址缺失或有歧义');
    return range(matches[0].file + address - matches[0].address, size);
  };
  const sections = Array.from({ length: shnum }, (_, index) => {
    const offset = shoff + index * 64;
    const type = bytes.readUInt32LE(offset + 4);
    const file = u64(offset + 24);
    const size = u64(offset + 32);
    if (type !== 8) range(file, size); // SHT_NOBITS does not occupy file bytes.
    return { type, file, size, address: u64(offset + 16), link: bytes.readUInt32LE(offset + 40), entry: u64(offset + 56) };
  });
  const onlySection = (type) => {
    const matches = sections.filter((section) => section.type === type);
    if (matches.length !== 1) reject('动态节缺失或重复');
    return matches[0];
  };
  const dynamics = segments.filter((segment) => segment.type === 2);
  if (dynamics.length !== 1 || dynamics[0].size % 16 !== 0) reject('PT_DYNAMIC 无效');
  const dynamic = dynamics[0];
  const dynamicSection = onlySection(6);
  if (dynamicSection.file !== dynamic.file || dynamicSection.size !== dynamic.size
      || mapped(dynamic.address, dynamic.size) !== dynamic.file
      || dynamicSection.address !== dynamic.address || dynamicSection.entry !== 16) {
    reject('动态段/节不一致');
  }
  const tags = new Map();
  let terminated = false;
  for (let offset = dynamic.file; offset < dynamic.file + dynamic.size; offset += 16) {
    const tag = u64(offset);
    const value = u64(offset + 8);
    if (tag === 0) { terminated = true; break; }
    if (!tags.has(tag)) tags.set(tag, []);
    tags.get(tag).push(value);
  }
  if (!terminated) reject('动态表未终止');
  const one = (tag) => {
    const values = tags.get(tag);
    if (values?.length !== 1) reject(`动态字段 ${tag} 缺失或重复`);
    return values[0];
  };
  const symbols = onlySection(11);
  const strings = sections[symbols.link];
  if (!strings || strings.type !== 3 || dynamicSection.link !== symbols.link
      || symbols.entry !== 24 || symbols.size % 24 !== 0 || symbols.size / 24 > 1000000
      || one(11) !== 24 || one(6) !== symbols.address
      || mapped(symbols.address, symbols.size) !== symbols.file
      || one(5) !== strings.address || one(10) !== strings.size
      || mapped(strings.address, strings.size) !== strings.file) reject('动态符号/字符串表不一致');
  const string = (index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= strings.size) reject('字符串索引越界');
    const start = strings.file + index;
    const end = bytes.indexOf(0, start);
    if (end < start || end >= strings.file + strings.size) reject('字符串缺少终止符');
    const value = bytes.subarray(start, end);
    if (value.some((byte) => byte < 32 || byte > 126)) reject('动态名称不是可审计 ASCII');
    return value.toString('ascii');
  };
  const soname = string(one(14));
  if (soname !== (host ? 'libcitizensdk_host.so' : 'libcitizensdk.so')) reject('SONAME 漂移');
  if (tags.has(15) || (!host && tags.has(29))
      || (host && string(one(29)) !== '$ORIGIN')) reject('RPATH/RUNPATH 必须遵守包内单 Core 合同');
  const needed = (tags.get(1) ?? []).map(string);
  if (new Set(needed).size !== needed.length || needed.some((name) => !name
      || name.includes('/') || name.includes('\\')
      || /^(?:libsmoldot|libstdc\+\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)/.test(name))
      || (host && needed.filter((name) => name === 'libcitizensdk.so').length !== 1)
      || (!host && needed.some((name) => /^libcitizensdk/.test(name)))) reject('DT_NEEDED 依赖闭包漂移');
  const exported = [];
  for (let offset = symbols.file; offset < symbols.file + symbols.size; offset += 24) {
    const info = bytes[offset + 4];
    const visibility = bytes[offset + 5] & 7;
    const section = bytes.readUInt16LE(offset + 6);
    if (!section || ![1, 2, 10].includes(info >> 4) || [1, 2].includes(visibility)) continue;
    const name = string(bytes.readUInt32LE(offset));
    if (![0, 3].includes(visibility) || (info & 15) !== 2 || section >= sections.length) reject('公开符号必须是已定义函数');
    const address = u64(offset + 8);
    if (!segments.some((segment) => segment.type === 1 && (segment.flags & 1)
      && address >= segment.address && address - segment.address < segment.size)) reject('导出函数地址不在可执行段');
    exported.push(name);
  }
  if (JSON.stringify(exported.sort()) !== JSON.stringify(expectedSymbols)) reject('公开导出符号闭集漂移');
  // Version requirements are linked from PT_DYNAMIC and bounded by the matching
  // SHT_GNU_verneed. Reject newer/private glibc or leaked C++ runtime dependencies.
  const versionSections = sections.filter((section) => section.type === 0x6ffffffe);
  if (tags.has(0x6ffffffe) || tags.has(0x6fffffff) || versionSections.length) {
    const section = onlySection(0x6ffffffe);
    const count = one(0x6fffffff);
    if (!count || count > 10000 || section.link !== symbols.link
        || section.address !== one(0x6ffffffe)
        || mapped(section.address, section.size) !== section.file) reject('版本需求表不一致');
    const versionRange = (offset, size) => {
      if (offset < section.file || offset > section.file + section.size - size) reject('版本链越界');
      return range(offset, size);
    };
    const occupied = new Set();
    const occupy = (offset) => {
      versionRange(offset, 16);
      for (let byte = offset; byte < offset + 16; byte += 1) {
        if (occupied.has(byte)) reject('版本链循环或重叠');
        occupied.add(byte);
      }
    };
    let offset = section.file;
    for (let index = 0; index < count; index += 1) {
      occupy(offset);
      const auxCount = bytes.readUInt16LE(offset + 2);
      if (bytes.readUInt16LE(offset) !== 1 || !auxCount
          || !needed.includes(string(bytes.readUInt32LE(offset + 4)))) reject('版本需求库无效');
      let aux = offset + bytes.readUInt32LE(offset + 8);
      for (let item = 0; item < auxCount; item += 1) {
        occupy(aux);
        const name = string(bytes.readUInt32LE(aux + 8));
        if (/^(?:GLIBCXX_|CXXABI_)/.test(name)) reject('C++ 动态运行库版本泄漏');
        if (name.startsWith('GLIBC_')) {
          const version = /^GLIBC_(\d+)\.(\d+)(?:\.(\d+))?$/.exec(name);
          if (!version || Number(version[1]) > 2
              || (Number(version[1]) === 2 && (Number(version[2]) > 31
                || (Number(version[2]) === 31 && Number(version[3] ?? 0) > 0)))) reject('GLIBC 需求超过 2.31 或使用私有版本');
        }
        const next = bytes.readUInt32LE(aux + 12);
        if ((item + 1 < auxCount) !== (next !== 0)) reject('版本辅助链长度不一致');
        aux += next;
      }
      const next = bytes.readUInt32LE(offset + 12);
      if ((index + 1 < count) !== (next !== 0)) reject('版本需求链长度不一致');
      offset += next;
    }
  }
}

// Canonical instructions emitted by CMake; comments are not executable input.
// The export check is complete, so a second set_property/include cannot override
// a previously checked path. Unknown generator instructions fail closed.
const LINUX_CMAKE_PACKAGE_INIT = [
  "get_filename_component(PACKAGE_PREFIX_DIR \"${CMAKE_CURRENT_LIST_DIR}/../../../../\" ABSOLUTE)",
  "macro(set_and_check _var _file)",
  "  set(${_var} \"${_file}\")",
  "  if(NOT EXISTS \"${_file}\")",
  "    message(FATAL_ERROR \"File or directory ${_file} referenced by variable ${_var} does not exist !\")",
  "  endif()",
  "endmacro()",
  "macro(check_required_components _NAME)",
  "  foreach(comp ${${_NAME}_FIND_COMPONENTS})",
  "    if(NOT ${_NAME}_${comp}_FOUND)",
  "      if(${_NAME}_FIND_REQUIRED_${comp})",
  "        set(${_NAME}_FOUND FALSE)",
  "      endif()",
  "    endif()",
  "  endforeach()",
  "endmacro()",
].join('\n');
const LINUX_CMAKE_TARGETS = [
  "if(\"${CMAKE_MAJOR_VERSION}.${CMAKE_MINOR_VERSION}\" LESS 2.8)",
  "   message(FATAL_ERROR \"CMake >= 2.8.12 required\")",
  "endif()",
  "if(CMAKE_VERSION VERSION_LESS \"2.8.12\")",
  "   message(FATAL_ERROR \"CMake >= 2.8.12 required\")",
  "endif()",
  "cmake_policy(PUSH)",
  "cmake_policy(VERSION 2.8.12...4.0)",
  "set(CMAKE_IMPORT_FILE_VERSION 1)",
  "set(_cmake_targets_defined \"\")",
  "set(_cmake_targets_not_defined \"\")",
  "set(_cmake_expected_targets \"\")",
  "foreach(_cmake_expected_target IN ITEMS CitizenSDK::Host)",
  "  list(APPEND _cmake_expected_targets \"${_cmake_expected_target}\")",
  "  if(TARGET \"${_cmake_expected_target}\")",
  "    list(APPEND _cmake_targets_defined \"${_cmake_expected_target}\")",
  "  else()",
  "    list(APPEND _cmake_targets_not_defined \"${_cmake_expected_target}\")",
  "  endif()",
  "endforeach()",
  "unset(_cmake_expected_target)",
  "if(_cmake_targets_defined STREQUAL _cmake_expected_targets)",
  "  unset(_cmake_targets_defined)",
  "  unset(_cmake_targets_not_defined)",
  "  unset(_cmake_expected_targets)",
  "  unset(CMAKE_IMPORT_FILE_VERSION)",
  "  cmake_policy(POP)",
  "  return()",
  "endif()",
  "if(NOT _cmake_targets_defined STREQUAL \"\")",
  "  string(REPLACE \";\" \", \" _cmake_targets_defined_text \"${_cmake_targets_defined}\")",
  "  string(REPLACE \";\" \", \" _cmake_targets_not_defined_text \"${_cmake_targets_not_defined}\")",
  "  message(FATAL_ERROR \"Some (but not all) targets in this export set were already defined.\\nTargets Defined: ${_cmake_targets_defined_text}\\nTargets not yet defined: ${_cmake_targets_not_defined_text}\\n\")",
  "endif()",
  "unset(_cmake_targets_defined)",
  "unset(_cmake_targets_not_defined)",
  "unset(_cmake_expected_targets)",
  "get_filename_component(_IMPORT_PREFIX \"${CMAKE_CURRENT_LIST_FILE}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "if(_IMPORT_PREFIX STREQUAL \"/\")",
  "  set(_IMPORT_PREFIX \"\")",
  "endif()",
  "add_library(CitizenSDK::Host SHARED IMPORTED)",
  "set_target_properties(CitizenSDK::Host PROPERTIES",
  "  INTERFACE_COMPILE_FEATURES \"cxx_std_17\"",
  "  INTERFACE_INCLUDE_DIRECTORIES \"${_IMPORT_PREFIX}/include\"",
  "  INTERFACE_LINK_LIBRARIES \"CitizenSDK::Core\"",
  ")",
  "file(GLOB _cmake_config_files \"${CMAKE_CURRENT_LIST_DIR}/CitizenSDKTargets-*.cmake\")",
  "foreach(_cmake_config_file IN LISTS _cmake_config_files)",
  "  include(\"${_cmake_config_file}\")",
  "endforeach()",
  "unset(_cmake_config_file)",
  "unset(_cmake_config_files)",
  "set(_IMPORT_PREFIX)",
  "foreach(_cmake_target IN LISTS _cmake_import_check_targets)",
  "  if(CMAKE_VERSION VERSION_LESS \"3.28\"",
  "      OR NOT DEFINED _cmake_import_check_xcframework_for_${_cmake_target}",
  "      OR NOT IS_DIRECTORY \"${_cmake_import_check_xcframework_for_${_cmake_target}}\")",
  "    foreach(_cmake_file IN LISTS \"_cmake_import_check_files_for_${_cmake_target}\")",
  "      if(NOT EXISTS \"${_cmake_file}\")",
  "        message(FATAL_ERROR \"The imported target \\\"${_cmake_target}\\\" references the file",
  "   \\\"${_cmake_file}\\\"",
  "but this file does not exist.  Possible reasons include:",
  "* The file was deleted, renamed, or moved to another location.",
  "* An install or uninstall procedure did not complete successfully.",
  "* The installation package was faulty and contained",
  "   \\\"${CMAKE_CURRENT_LIST_FILE}\\\"",
  "but not all the files it references.",
  "\")",
  "      endif()",
  "    endforeach()",
  "  endif()",
  "  unset(_cmake_file)",
  "  unset(\"_cmake_import_check_files_for_${_cmake_target}\")",
  "endforeach()",
  "unset(_cmake_target)",
  "unset(_cmake_import_check_targets)",
  "set(CMAKE_IMPORT_FILE_VERSION)",
  "cmake_policy(POP)",
].join('\n');
const LINUX_CMAKE_RELEASE = [
  "set(CMAKE_IMPORT_FILE_VERSION 1)",
  "set_property(TARGET CitizenSDK::Host APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)",
  "set_target_properties(CitizenSDK::Host PROPERTIES",
  "  IMPORTED_LOCATION_RELEASE \"${_IMPORT_PREFIX}/lib/@PLATFORM@/libcitizensdk_host.so\"",
  "  IMPORTED_SONAME_RELEASE \"libcitizensdk_host.so\"",
  "  )",
  "list(APPEND _cmake_import_check_targets CitizenSDK::Host )",
  "list(APPEND _cmake_import_check_files_for_CitizenSDK::Host \"${_IMPORT_PREFIX}/lib/@PLATFORM@/libcitizensdk_host.so\" )",
  "set(CMAKE_IMPORT_FILE_VERSION)",
].join('\n');

function assertLinuxInstallClosure(prefix, platform) {
  const paths = linuxInstallPaths(platform);
  if (JSON.stringify(regularFiles(prefix)) !== JSON.stringify(paths)
      || JSON.stringify(regularDirectories(prefix)) !== JSON.stringify(parentDirectories(paths))) {
    fail(`CitizenSDK ${platform} 安装投影必须精确为 19 个普通文件及其目录`);
  }
}

function cmakeInstructions(source) {
  let quoted = false;
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    // No bracket-argument/comment syntax is emitted by these generators. Never
    // discard a bracket comment followed by executable code on the same line,
    // or a line that merely resembles a comment inside a quoted message.
    if (/\[=*\[/.test(line)) fail('CitizenSDK Linux CMake 出现未登记的 bracket 语法');
    if (!quoted && (!trimmed || trimmed.startsWith('#'))) continue;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '\\') index += 1;
      else if (line[index] === '"') quoted = !quoted;
    }
    lines.push(trimmed);
  }
  if (quoted) fail('CitizenSDK Linux CMake 字符串未终止');
  return lines.join('\n');
}

function linuxCmakeTargetVariants() {
  const current = cmakeInstructions(LINUX_CMAKE_TARGETS);
  const variants = new Set();
  // CMake's official 3.x/4.x exporters change policy ceilings, old-consumer
  // guards and the XCFramework existence guard. Admit those complete, safe
  // structures only; never delete arbitrary instructions from candidate input.
  // References: Kitware/CMake cmExport{File,CMakeConfig}Generator.cxx (3.24/3.31).
  for (const ceiling of ['3.22', '3.23', '3.26', '3.29', '4.0']) {
    for (const legacy of [false, true]) {
      let expected = current.replace('2.8.12...4.0', `2.8.12...${ceiling}`);
      if (legacy) {
        expected = expected
          .replace('message(FATAL_ERROR "CMake >= 2.8.12 required")', 'message(FATAL_ERROR "CMake >= 2.8.0 required")')
          .replace('if(CMAKE_VERSION VERSION_LESS "2.8.12")', 'if(CMAKE_VERSION VERSION_LESS "2.8.3")')
          .replace('message(FATAL_ERROR "CMake >= 2.8.12 required")', 'message(FATAL_ERROR "CMake >= 2.8.3 required")')
          .replace(`2.8.12...${ceiling}`, `2.8.3...${ceiling}`)
          .replace('file(GLOB _cmake_config_files', [
            'if(CMAKE_VERSION VERSION_LESS 2.8.12)',
            'message(FATAL_ERROR "This file relies on consumers using CMake 2.8.12 or greater.")',
            'endif()',
            'file(GLOB _cmake_config_files',
          ].join('\n'));
      }
      variants.add(expected);
      variants.add(expected.replace([
        'if(CMAKE_VERSION VERSION_LESS "3.28"',
        'OR NOT DEFINED _cmake_import_check_xcframework_for_${_cmake_target}',
        'OR NOT IS_DIRECTORY "${_cmake_import_check_xcframework_for_${_cmake_target}}")',
        '',
      ].join('\n'), '').replace('endforeach()\nendif()\nunset(_cmake_file)', 'endforeach()\nunset(_cmake_file)'));
    }
  }
  return variants;
}

function assertLinuxInstalledPlatform(sourceRoot, prefix, platform) {
  const installedFile = (path) => {
    try {
      return nativeArtifactSource(prefix, path);
    } catch (error) {
      fail(`CitizenSDK ${platform} 安装件无效：${path}；${error.message}`);
    }
  };
  const ordinary = (path) => readFileSync(installedFile(path));
  const equalSource = (installed, source) => {
    if (!ordinary(installed).equals(readFileSync(join(sourceRoot, source)))) {
      fail(`CitizenSDK ${platform} 安装投影来源字节漂移：${installed}`);
    }
  };
  for (const name of ['citizensdk.h', 'citizensdk_types.h']) equalSource(`include/${name}`, `include/${name}`);
  equalSource('include/citizensdk_qr_image.h', 'native/qr-image/citizensdk_qr_image.h');
  for (const name of LINUX_HOST_HEADERS) equalSource(`include/citizen_sdk/${name}`, `linux/citizen_sdk/${name}`);
  for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
    equalSource(`share/citizensdk/chain/${name}`, `chain/${name}`);
  }
  const version = readFileSync(join(sourceRoot, 'pubspec.yaml'), 'utf8')
    .match(/^version: (\d+\.\d{1,2}\.\d{1,2})$/m)?.[1];
  if (!version) fail('CitizenSDK Linux 安装投影缺少同版包身份');
  const configRoot = `lib/${platform}/cmake/CitizenSDK`;
  const configs = Object.fromEntries(LINUX_CMAKE_FILES.map((name) => [name,
    ordinary(`${configRoot}/${name}`).toString('utf8'),
  ]));
  const template = (name) => readFileSync(join(sourceRoot, 'linux/cmake', name), 'utf8');
  const expectedVersion = template('CitizenSDKConfigVersion.cmake.in')
    .replaceAll('@PROJECT_VERSION@', version)
    .replaceAll('@PROJECT_VERSION_MAJOR@', version.split('.')[0]);
  if (configs['CitizenSDKConfigVersion.cmake'] !== expectedVersion) {
    fail(`CitizenSDK ${platform} CMake 版本合同漂移`);
  }
  if (configs['CitizenSDKDependencies.cmake'] !== template('CitizenSDKDependencies.cmake')) {
    fail(`CitizenSDK ${platform} CMake 依赖合同漂移`);
  }
  const expectedBody = template('CitizenSDKConfig.cmake.in').split('@PACKAGE_INIT@')[1]
    .replaceAll('@CITIZENSDK_PLATFORM@', platform)
    .replaceAll('@PACKAGE_CMAKE_INSTALL_LIBDIR@', '${PACKAGE_PREFIX_DIR}/lib')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_DATADIR@', '${PACKAGE_PREFIX_DIR}/share')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_INCLUDEDIR@', '${PACKAGE_PREFIX_DIR}/include');
  const config = configs['CitizenSDKConfig.cmake'];
  const expectedConfig = `${LINUX_CMAKE_PACKAGE_INIT}\n${expectedBody}`;
  if (cmakeInstructions(config) !== cmakeInstructions(expectedConfig)) {
    fail(`CitizenSDK ${platform} CMake 平台、路径或配置合同漂移`);
  }
  const targets = configs['CitizenSDKTargets.cmake'];
  const release = configs['CitizenSDKTargets-release.cmake'];
  if (!linuxCmakeTargetVariants().has(cmakeInstructions(targets))
      || cmakeInstructions(release) !== cmakeInstructions(LINUX_CMAKE_RELEASE.replaceAll('@PLATFORM@', platform))) {
    fail(`CitizenSDK ${platform} CMake 导入目标合同漂移`);
  }
  const hostHeader = readFileSync(join(sourceRoot, 'linux/citizen_sdk/citizensdk_host.h'), 'utf8');
  const hostSymbols = [...new Set([...hostHeader.matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g)]
    .map((match) => match[1]))].sort();
  if (hostSymbols.length !== 19) fail('CitizenSDK Linux Host 必须精确为 19 个公开 C 符号');
  const hostAndQrSymbols = [...hostSymbols, ...expectedQrImageSymbols(sourceRoot)].sort();
  for (const [host, names] of [[false, expectedCitizenSdkLinkedSymbols(sourceRoot)], [true, hostAndQrSymbols]]) {
    const name = host ? 'libcitizensdk_host.so' : 'libcitizensdk.so';
    const path = installedFile(`lib/${platform}/${name}`);
    assertLinuxElf(path, platform, host, names);
  }
}

/** Verify the merged 26-file installation and the unchanged source closure. */
export function assertLinuxReleaseProjection(root) {
  const sourceRoot = resolve(root);
  assertLinuxBindingSource(sourceRoot, { allowInjectedLinuxArtifacts: true });
  for (const platform of LINUX_PLATFORMS) {
    assertLinuxInstalledPlatform(sourceRoot, join(sourceRoot, 'linux'), platform);
  }
}

// 按 Microsoft PE/COFF 格式读取真实目录表，不依赖 dumpbin 文本或文件扩展名。
// 系统加载、实际 CRT 部署及硬件行为仍须由 Windows 原生消费者验收。
function windowsPe(path, { headersOnly = false } = {}) {
  const bytes = readFileSync(path);
  const invalid = (message) => fail(`CitizenSDK Windows PE ${path}：${message}`);
  const range = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0
        || length < 0 || offset > bytes.length - length) invalid('结构越界');
    return offset;
  };
  range(0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) invalid('缺少 DOS 标识');
  const pe = range(bytes.readUInt32LE(60), 24);
  const count = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664
      || count < 1 || count > 96 || optionalSize < 240) invalid('机器或 COFF 头漂移');
  const optional = range(pe + 24, optionalSize);
  if (bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 16) invalid('必须为 PE32+');
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const offset = range(optional + optionalSize + index * 40, 40);
    const section = { address: bytes.readUInt32LE(offset + 12), size: bytes.readUInt32LE(offset + 8),
      raw: bytes.readUInt32LE(offset + 20), rawSize: bytes.readUInt32LE(offset + 16),
      flags: bytes.readUInt32LE(offset + 36) };
    range(section.raw, section.rawSize);
    if (section.address === 0 || section.address + Math.max(section.size, section.rawSize) > 0x100000000
        || sections.some((previous) => section.address < previous.address + Math.max(previous.size, previous.rawSize)
          && previous.address < section.address + Math.max(section.size, section.rawSize))) invalid('节地址重叠或无效');
    sections.push(section);
  }
  if (headersOnly) return;
  const mapped = (address, length = 1) => {
    const found = sections.filter((section) => address >= section.address
      && address + length <= section.address + section.rawSize);
    if (found.length !== 1 || length < 1) invalid('RVA 不在唯一文件节中');
    return range(found[0].raw + address - found[0].address, length);
  };
  const string = (address) => {
    const start = mapped(address);
    const end = bytes.indexOf(0, start);
    if (end < start || end - start > 4096) invalid('字符串未终止');
    mapped(address, end - start + 1);
    const value = bytes.subarray(start, end);
    if (value.length === 0 || value.some((byte) => byte < 0x20 || byte > 0x7e)) invalid('字符串不是非空 ASCII');
    return value.toString('ascii');
  };
  const directory = (index) => {
    const offset = optional + 112 + index * 8;
    const address = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if ((address === 0) !== (size === 0)) invalid('目录地址与长度不一致');
    return { address, size, offset: address ? mapped(address, size) : 0 };
  };
  const exports = [];
  const exported = directory(0);
  let dllName = null;
  if (exported.address) {
    if (exported.size < 40) invalid('导出目录截断');
    const at = exported.offset;
    dllName = string(bytes.readUInt32LE(at + 12));
    const functions = bytes.readUInt32LE(at + 20), names = bytes.readUInt32LE(at + 24);
    if (!names || names > 65536 || functions !== names) invalid('导出数量或 ordinal-only 项无效');
    const addresses = mapped(bytes.readUInt32LE(at + 28), functions * 4);
    const pointers = mapped(bytes.readUInt32LE(at + 32), names * 4);
    const ordinals = mapped(bytes.readUInt32LE(at + 36), names * 2);
    const seen = new Set();
    for (let index = 0; index < names; index += 1) {
      const ordinal = bytes.readUInt16LE(ordinals + index * 2);
      if (ordinal >= functions || seen.has(ordinal)) invalid('导出 ordinal 重复或越界');
      seen.add(ordinal);
      const address = bytes.readUInt32LE(addresses + ordinal * 4);
      if (address >= exported.address && address < exported.address + exported.size) invalid('禁止转发导出');
      mapped(address);
      if (!sections.some((section) => address >= section.address && address < section.address + section.rawSize
          && (section.flags & 0x20000000))) invalid('导出地址不是可执行代码');
      exports.push(string(bytes.readUInt32LE(pointers + index * 4)));
    }
    if (new Set(exports).size !== exports.length || JSON.stringify(exports) !== JSON.stringify([...exports].sort())) {
      invalid('导出名称顺序或唯一性漂移');
    }
  }
  const imports = [];
  const thunks = (address) => {
    const names = [];
    for (let index = 0; index < 65536; index += 1) {
      const value = bytes.readBigUInt64LE(mapped(address + index * 8, 8));
      if (value === 0n) return names;
      if (value & (1n << 63n)) {
        if ((value & ~((1n << 63n) | 0xffffn)) !== 0n) invalid('import ordinal 位非法');
        names.push(null);
      } else {
        if (value > 0xffffffffn) invalid('import thunk RVA 越界');
        mapped(Number(value), 2);
        names.push(string(Number(value) + 2));
      }
    }
    invalid('import thunk 未终止');
  };
  for (const [index, width] of [[1, 20], [13, 32]]) {
    const table = directory(index);
    if (!table.address) continue;
    let terminated = false;
    for (let cursor = 0; cursor + width <= table.size; cursor += width) {
      const at = table.offset + cursor;
      if (bytes.subarray(at, at + width).every((byte) => byte === 0)) { terminated = true; break; }
      if (index === 13 && bytes.readUInt32LE(at) !== 1) invalid('delay import 必须使用 RVA');
      const name = string(bytes.readUInt32LE(at + (index === 1 ? 12 : 4))).toLowerCase();
      if (!/^[a-z0-9_-]+\.dll$/.test(name) || imports.some((entry) => entry.name === name)) invalid('导入 DLL 路径、名称或唯一性无效');
      const lookup = bytes.readUInt32LE(at + (index === 1 ? 0 : 16));
      const iat = bytes.readUInt32LE(at + (index === 1 ? 16 : 12));
      if (!iat) invalid('缺少 import address table');
      const names = thunks(lookup || iat);
      mapped(iat, (names.length + 1) * 8);
      if (!names.length) invalid('空 import descriptor');
      imports.push({ name, symbols: names });
    }
    if (!terminated) invalid('import descriptor 未终止');
  }
  return { exports, imports, dllName, dll: Boolean(bytes.readUInt16LE(pe + 22) & 0x2000) };
}

const WINDOWS_SYSTEM_IMPORTS = new Set([
  'mf.dll', 'mfplat.dll', 'mfreadwrite.dll', 'windowscodecs.dll',
  'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'cfgmgr32.dll', 'comctl32.dll',
  'crypt32.dll', 'cryptbase.dll', 'dbghelp.dll', 'dnsapi.dll', 'gdi32.dll', 'imm32.dll',
  'iphlpapi.dll', 'kernel32.dll', 'kernelbase.dll', 'ncrypt.dll', 'netapi32.dll',
  'normaliz.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'powrprof.dll', 'profapi.dll',
  'psapi.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll', 'shlwapi.dll',
  'synchronization.dll', 'tbs.dll', 'ucrtbase.dll', 'user32.dll', 'userenv.dll',
  'version.dll', 'winbio.dll', 'winhttp.dll', 'winmm.dll', 'wintrust.dll', 'ws2_32.dll', 'wtsapi32.dll',
  'msvcrt.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
]);
function assertWindowsImports(image, required, coreSymbols) {
  for (const entry of image.imports) {
    if (!required.includes(entry.name) && !WINDOWS_SYSTEM_IMPORTS.has(entry.name)
        && !/^(?:api|ext)-ms-win-[a-z0-9]+(?:-[a-z0-9]+)*-l\d+-\d+-\d+\.dll$/.test(entry.name)) {
      fail(`CitizenSDK Windows 未登记的 DLL 依赖：${entry.name}`);
    }
    if (entry.name === 'citizensdk.dll'
        && entry.symbols.some((symbol) => symbol === null || !coreSymbols.includes(symbol))) {
      fail('CitizenSDK Windows Host 导入了闭集外的 Core 符号');
    }
  }
  for (const name of required) {
    if (!image.imports.some((entry) => entry.name === name)) fail(`CitizenSDK Windows 缺少必要依赖：${name}`);
  }
}

function assertWindowsImportLibrary(path, dll, expectedSymbols) {
  const bytes = readFileSync(path), symbols = [], members = [];
  const invalid = () => fail(`CitizenSDK Windows import library 格式、机器或符号漂移：${path}`);
  const range = (data, at, size) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0
        || at > data.length || size > data.length - at) invalid();
  };
  const ascii = (data) => {
    if (data.some((value) => value < 32 || value > 127)) invalid();
    return data.toString('latin1');
  };
  const cstring = (data, at, limit = data.length) => {
    range(data, at, limit - at);
    const end = data.indexOf(0, at);
    if (end < at || end >= limit || end === at) invalid();
    return { text: ascii(data.subarray(at, end)), next: end + 1 };
  };
  const zero = (data) => data.every((value) => value === 0);
  // 官方 COFF archive 两个索引可在 payload 内补一个零字节至偶数边界；外部 padding 仍为 LF。
  const indexEnd = (data, at) => {
    if (at !== data.length && !(at % 2 === 1 && at + 1 === data.length && data[at] === 0)) invalid();
  };
  if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) invalid();
  let cursor = 8;
  while (cursor < bytes.length) {
    if (members.length >= 100000 || cursor + 60 > bytes.length
        || bytes[cursor + 58] !== 0x60 || bytes[cursor + 59] !== 10) invalid();
    const name = ascii(bytes.subarray(cursor, cursor + 16)).trimEnd();
    const sizeText = ascii(bytes.subarray(cursor + 48, cursor + 58)).trim();
    if (!/^\d+$/.test(sizeText)) invalid();
    const size = Number(sizeText), start = cursor + 60, end = start + size;
    range(bytes, start, size);
    members.push({ offset: cursor, name, data: bytes.subarray(start, end) });
    cursor = end + (size % 2);
    if (size % 2 && bytes[end] !== 10) invalid();
  }
  if (cursor !== bytes.length || members.length < 5 || members[0].name !== '/' || members[1].name !== '/') invalid();
  const longnames = new Map();
  let objectStart = 2;
  if (members[2].name === '//') {
    const data = members[2].data;
    let at = 0;
    while (at < data.length) {
      // LLVM 的 longnames 表允许将最终 LF 对齐字节计入 member size。
      if (at % 2 === 1 && at + 1 === data.length && data[at] === 10) { at += 1; break; }
      const entry = cstring(data, at);
      longnames.set(at, entry.text);
      at = entry.next;
    }
    objectStart = 3;
  }
  const objects = members.slice(objectStart);
  const definitions = new Map();
  const stem = dll.replace(/\.dll$/, '');
  const descriptor = `__IMPORT_DESCRIPTOR_${stem}`;
  const nullDescriptor = '__NULL_IMPORT_DESCRIPTOR';
  const nullThunk = `\x7f${stem}_NULL_THUNK_DATA`;
  const descriptors = new Set([descriptor, nullDescriptor, nullThunk]);
  const define = (name, offset) => {
    if (definitions.has(name)) invalid();
    definitions.set(name, offset);
  };
  for (const member of objects) {
    const resolved = /^\/\d+$/.test(member.name) ? longnames.get(Number(member.name.slice(1)))
      : member.name.endsWith('/') ? member.name.slice(0, -1) : undefined;
    // archive 文件名不是 DLL 身份；允许官方任意对象名称，但引用必须指向 longnames 串首。
    if (!resolved || /[\x00-\x1f\x7f]/.test(resolved) || member.name === '/' || member.name === '//') invalid();
    const object = member.data;
    range(object, 0, 20);
    if (object.readUInt16LE(0) === 0 && object.readUInt16LE(2) === 0xffff) {
      if (object.readUInt16LE(4) !== 0 || object.readUInt16LE(6) !== 0x8664
          || object.readUInt16LE(18) !== 4 || object.readUInt32LE(12) !== object.length - 20) invalid();
      const name = cstring(object, 20), library = cstring(object, name.next);
      if (library.next !== object.length || library.text.toLowerCase() !== dll || !expectedSymbols.includes(name.text)) invalid();
      symbols.push(name.text);
      define(name.text, member.offset);
      define(`__imp_${name.text}`, member.offset);
      continue;
    }
    // 只接纳官方导入描述符 COFF，而非携带 .text、.drectve 或额外外部定义的实现对象。
    const sectionCount = object.readUInt16LE(2), table = object.readUInt32LE(8), count = object.readUInt32LE(12);
    const headersEnd = 20 + sectionCount * 40, stringsAt = table + count * 18;
    if (object.readUInt16LE(0) !== 0x8664 || object.readUInt16LE(16) !== 0
        || sectionCount < 1 || sectionCount > 16 || table < headersEnd || count < 1) invalid();
    range(object, 20, sectionCount * 40);
    range(object, table, count * 18 + 4);
    const stringSize = object.readUInt32LE(stringsAt);
    if (stringSize < 4) invalid();
    range(object, stringsAt, stringSize);
    if (stringsAt + stringSize !== object.length) invalid();
    const sections = [], occupied = [[0, headersEnd], [table, object.length]];
    const occupy = (at, length) => {
      range(object, at, length);
      if (length === 0) return;
      if (occupied.some(([begin, end]) => at < end && begin < at + length)) invalid();
      occupied.push([at, at + length]);
    };
    for (let index = 0; index < sectionCount; index += 1) {
      const at = 20 + index * 40;
      const nameBytes = object.subarray(at, at + 8), nul = nameBytes.indexOf(0);
      const name = ascii(nul < 0 ? nameBytes : nameBytes.subarray(0, nul));
      if (nul >= 0 && !zero(nameBytes.subarray(nul))) invalid();
      const size = object.readUInt32LE(at + 16), raw = object.readUInt32LE(at + 20);
      const reloc = object.readUInt32LE(at + 24), relocCount = object.readUInt16LE(at + 32);
      const flags = object.readUInt32LE(at + 36);
      if ((!/^\.idata\$[234567]$/.test(name) && name !== '.debug$S')
          || sections.some((section) => section.name === name)
          || object.readUInt32LE(at + 8) !== 0 || object.readUInt32LE(at + 12) !== 0
          || object.readUInt32LE(at + 28) !== 0 || object.readUInt16LE(at + 34) !== 0
          || (flags & (0x20000000 | 0x01000000 | 0x00000800))) invalid();
      occupy(raw, size);
      occupy(reloc, relocCount * 10);
      sections.push({ name, data: object.subarray(raw, raw + size), reloc, relocCount });
    }
    const coffSymbols = new Map(), external = [], undefinedExternal = new Set();
    for (let index = 0; index < count;) {
      const at = table + index * 18;
      let name;
      if (object.readUInt32LE(at) === 0) {
        const offset = object.readUInt32LE(at + 4);
        if (offset < 4 || offset >= stringSize) invalid();
        name = cstring(object, stringsAt + offset, stringsAt + stringSize).text;
      } else {
        const field = object.subarray(at, at + 8), nul = field.indexOf(0);
        name = ascii(nul < 0 ? field : field.subarray(0, nul));
        if (!name || (nul >= 0 && !zero(field.subarray(nul)))) invalid();
      }
      const value = object.readUInt32LE(at + 8), section = object.readInt16LE(at + 12);
      const storage = object[at + 16], auxiliary = object[at + 17];
      if (section > sectionCount || section < -2 || index + auxiliary >= count || storage === 105) invalid();
      const symbol = { name, value, section, storage };
      coffSymbols.set(index, symbol);
      if (storage === 2) {
        if (!descriptors.has(name) || value !== 0 || object.readUInt16LE(at + 14) !== 0 || auxiliary !== 0) invalid();
        if (section > 0) { external.push(symbol); define(name, member.offset); }
        else if (section === 0) undefinedExternal.add(name);
        else invalid();
      }
      index += auxiliary + 1;
    }
    if (external.length !== 1) invalid();
    for (const section of sections) {
      section.relocations = [];
      for (let index = 0; index < section.relocCount; index += 1) {
        const at = section.reloc + index * 10;
        const offset = object.readUInt32LE(at), target = coffSymbols.get(object.readUInt32LE(at + 4));
        const type = object.readUInt16LE(at + 8);
        if (!target || offset >= section.data.length) invalid();
        section.relocations.push({ offset, target, type });
      }
    }
    const role = external[0].name;
    const dataSections = sections.filter((section) => section.name !== '.debug$S');
    const get = (name, length) => {
      const section = dataSections.find((entry) => entry.name === name);
      if (!section || section.data.length !== length) invalid();
      return section;
    };
    const empty = (section) => { if (!zero(section.data) || section.relocCount !== 0) invalid(); };
    if (role === descriptor) {
      const idata = get('.idata$2', 20), library = dataSections.find((entry) => entry.name === '.idata$6');
      if (dataSections.length !== 2 || !library || library.relocCount !== 0 || !zero(idata.data)
          || idata.relocCount !== 3 || sections[external[0].section - 1] !== idata
          || undefinedExternal.size !== 2 || !undefinedExternal.has(nullDescriptor) || !undefinedExternal.has(nullThunk)) invalid();
      const dllName = cstring(library.data, 0);
      if (dllName.text.toLowerCase() !== dll || library.data.length - dllName.next > 1
          || !zero(library.data.subarray(dllName.next))) invalid();
      const required = new Map([[0, '.idata$4'], [12, '.idata$6'], [16, '.idata$5']]);
      for (const { offset, target, type } of idata.relocations) {
        if (type !== 3 || required.get(offset) !== target.name || target.value !== 0
            || (target.storage !== 3 && target.storage !== 104)
            || (target.name === '.idata$6' ? sections[target.section - 1] !== library : target.section !== 0)) invalid();
        required.delete(offset);
      }
      if (required.size !== 0) invalid();
    } else if (role === nullDescriptor) {
      const idata = get('.idata$3', 20);
      if (dataSections.length !== 1 || undefinedExternal.size !== 0 || sections[external[0].section - 1] !== idata) invalid();
      empty(idata);
    } else {
      const ilt = get('.idata$4', 8), iat = get('.idata$5', 8);
      if (dataSections.length !== 2 || undefinedExternal.size !== 0
          || ![ilt, iat].includes(sections[external[0].section - 1])) invalid();
      empty(ilt); empty(iat);
    }
  }
  if (objects.length !== expectedSymbols.length + 3 || [...descriptors].some((name) => !definitions.has(name))
      || JSON.stringify(symbols.sort()) !== JSON.stringify(expectedSymbols)) invalid();
  // Microsoft PE/COFF 两份链接索引必须共同映射至真实 object header；只有公开名字相同不能证明可链接。
  // 格式依据：learn.microsoft.com/windows/win32/debug/pe-format；LLVM Object/{ArchiveWriter,COFFImportFile}.cpp。
  const first = members[0].data, second = members[1].data, expectedCount = definitions.size;
  range(first, 0, 4);
  if (first.readUInt32BE(0) !== expectedCount) invalid();
  range(first, 4, expectedCount * 4);
  let at = 4 + expectedCount * 4, previous = -1;
  const seenFirst = new Set();
  for (let index = 0; index < expectedCount; index += 1) {
    const offset = first.readUInt32BE(4 + index * 4), name = cstring(first, at);
    if (offset < previous || definitions.get(name.text) !== offset || seenFirst.has(name.text)) invalid();
    seenFirst.add(name.text); previous = offset; at = name.next;
  }
  indexEnd(first, at);
  range(second, 0, 4);
  if (second.readUInt32LE(0) !== objects.length || objects.length > 0xffff) invalid();
  range(second, 4, objects.length * 4 + 4);
  objects.forEach((member, index) => { if (second.readUInt32LE(4 + index * 4) !== member.offset) invalid(); });
  const countAt = 4 + objects.length * 4, indicesAt = countAt + 4;
  if (second.readUInt32LE(countAt) !== expectedCount) invalid();
  range(second, indicesAt, expectedCount * 2);
  at = indicesAt + expectedCount * 2;
  let previousName = '';
  for (let index = 0; index < expectedCount; index += 1) {
    const memberIndex = second.readUInt16LE(indicesAt + index * 2), name = cstring(second, at);
    if (memberIndex < 1 || memberIndex > objects.length || name.text <= previousName
        || definitions.get(name.text) !== objects[memberIndex - 1].offset) invalid();
    previousName = name.text; at = name.next;
  }
  indexEnd(second, at);
}

const WINDOWS_CMAKE_RELEASE = [
  'set(CMAKE_IMPORT_FILE_VERSION 1)',
  'set_property(TARGET CitizenSDK::Host APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)',
  'set_target_properties(CitizenSDK::Host PROPERTIES',
  '  IMPORTED_IMPLIB_RELEASE "${_IMPORT_PREFIX}/lib/Windows/citizensdk_host.lib"',
  '  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/bin/Windows/citizensdk_host.dll"',
  '  )',
  'list(APPEND _cmake_import_check_targets CitizenSDK::Host )',
  'list(APPEND _cmake_import_check_files_for_CitizenSDK::Host "${_IMPORT_PREFIX}/lib/Windows/citizensdk_host.lib" "${_IMPORT_PREFIX}/bin/Windows/citizensdk_host.dll" )',
  'set(CMAKE_IMPORT_FILE_VERSION)',
].join('\n');

function assertWindowsInstallClosure(prefix) {
  if (JSON.stringify(regularFiles(prefix)) !== JSON.stringify(WINDOWS_RELEASE_FILES)
      || JSON.stringify(regularDirectories(prefix)) !== JSON.stringify(parentDirectories(WINDOWS_RELEASE_FILES))) {
    fail('CitizenSDK Windows 安装投影必须精确为 22 个普通文件及其目录');
  }
  for (const path of WINDOWS_RELEASE_FILES) {
    const info = lstatSync(join(prefix, path));
    if (info.size === 0 || info.nlink !== 1) fail(`CitizenSDK Windows 安装件为空或硬链接：${path}`);
  }
}

function assertWindowsInstalledPlatform(sourceRoot, prefix) {
  const file = (path) => {
    const value = nativeArtifactSource(prefix, path), info = lstatSync(value);
    if (info.size === 0 || info.nlink !== 1) fail(`CitizenSDK Windows 安装件为空或硬链接：${path}`);
    return value;
  };
  const equal = (installed, source) => {
    if (!readFileSync(file(installed)).equals(readFileSync(join(sourceRoot, source)))) {
      fail(`CitizenSDK Windows 安装来源字节漂移：${installed}`);
    }
  };
  for (const name of ['citizensdk.h', 'citizensdk_types.h']) equal(`include/${name}`, `include/${name}`);
  equal('include/citizensdk_qr_image.h', 'native/qr-image/citizensdk_qr_image.h');
  for (const name of WINDOWS_HOST_HEADERS) equal(`include/citizen_sdk/${name}`, `windows/citizen_sdk/${name}`);
  for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
    equal(`share/citizensdk/chain/${name}`, `chain/${name}`);
  }
  const version = readFileSync(join(sourceRoot, 'pubspec.yaml'), 'utf8').match(/^version: (\d+\.\d{1,2}\.\d{1,2})$/m)?.[1];
  if (!version || readFileSync(join(sourceRoot, 'windows/CMakeLists.txt'), 'utf8')
    .match(/^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/m)?.[1] !== version) {
    fail('CitizenSDK Windows 源码版本不一致');
  }
  const template = (name) => readFileSync(join(sourceRoot, 'windows/cmake', name), 'utf8');
  const configs = Object.fromEntries(WINDOWS_CMAKE_FILES.map((name) => [name,
    readFileSync(file(`lib/Windows/cmake/CitizenSDK/${name}`), 'utf8')]));
  const body = template('CitizenSDKConfig.cmake.in').split('@PACKAGE_INIT@')[1]
    .replaceAll('@PACKAGE_CMAKE_INSTALL_LIBDIR@', '${PACKAGE_PREFIX_DIR}/lib')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_BINDIR@', '${PACKAGE_PREFIX_DIR}/bin')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_DATADIR@', '${PACKAGE_PREFIX_DIR}/share')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_INCLUDEDIR@', '${PACKAGE_PREFIX_DIR}/include');
  if (configs['CitizenSDKConfigVersion.cmake'] !== template('CitizenSDKConfigVersion.cmake.in')
    .replaceAll('@PROJECT_VERSION@', version).replaceAll('@PROJECT_VERSION_MAJOR@', version.split('.')[0])
      || configs['CitizenSDKDependencies.cmake'] !== template('CitizenSDKDependencies.cmake')
      || cmakeInstructions(configs['CitizenSDKConfig.cmake']) !== cmakeInstructions(`${LINUX_CMAKE_PACKAGE_INIT}\n${body}`)
      || !linuxCmakeTargetVariants().has(cmakeInstructions(configs['CitizenSDKTargets.cmake']))
      || cmakeInstructions(configs['CitizenSDKTargets-release.cmake']) !== cmakeInstructions(WINDOWS_CMAKE_RELEASE)) {
    fail('CitizenSDK Windows CMake 版本、依赖、路径或导入目标合同漂移');
  }
  const coreSymbols = expectedCitizenSdkLinkedSymbols(sourceRoot);
  const hostSymbols = [...new Set([...readFileSync(join(sourceRoot, 'windows/citizen_sdk/citizensdk_host.h'), 'utf8')
    .matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]))].sort();
  const hostAndQrSymbols = [...hostSymbols, ...expectedQrImageSymbols(sourceRoot)].sort();
  if (coreSymbols.length !== 150 || hostSymbols.length !== 19 || hostAndQrSymbols.length !== 23) fail('CitizenSDK Windows 150公开Core及19Host+4图像导出闭集漂移');
  for (const [name, symbols, imports, library] of [
    ['citizensdk.dll', coreSymbols, [], 'citizensdk.dll.lib'],
    ['citizensdk_host.dll', hostAndQrSymbols, ['citizensdk.dll'], 'citizensdk_host.lib'],
  ]) {
    const image = windowsPe(file(`bin/Windows/${name}`));
    if (!image.dll || image.dllName?.toLowerCase() !== name
        || JSON.stringify(image.exports) !== JSON.stringify(symbols)) fail(`CitizenSDK Windows ${name} 完整导出漂移`);
    assertWindowsImports(image, imports, coreSymbols);
    assertWindowsImportLibrary(file(`lib/Windows/${library}`), name, symbols);
  }
  return version;
}

/** 唯一 Windows 安装验真入口；不要求其它平台产物存在。 */
export function assertWindowsNativeArtifact(sourceRoot, prefix) {
  const source = resolve(sourceRoot), installed = assertSafeTargetPath(prefix, 'Windows 安装前缀');
  assertWindowsBindingSource(source);
  assertPublicAbiHeaders(source);
  assertChainAssets(source);
  assertWindowsInstallClosure(installed);
  return assertWindowsInstalledPlatform(source, installed);
}

/** destination 是完整 SDK 根；安装件与扁平源码头逐字节对拍后才写入公开安装目录。 */
export function copyWindowsNativeArtifact(sourceRoot, prefix, destination) {
  const source = resolve(sourceRoot), installed = resolve(prefix);
  const output = assertSafeTargetPath(destination, 'Windows 候选根');
  assertLocalTarget(output, 'Windows 候选根');
  assertOutsideSource(installed, output, 'Windows 安装目标');
  assertOutsideSource(output, installed, 'Windows 安装来源');
  assertOutsideSource(source, output, 'Windows 候选根');
  assertOutsideSource(output, source, 'Windows SDK 来源');
  assertWindowsNativeArtifact(source, installed);
  const root = join(output, 'windows');
  // 目标的源码头仍须同源；安装目录扁平化不能绕过候选来源对拍。
  for (const name of WINDOWS_HOST_HEADERS) {
    const header = assertSafeTargetPath(join(root, 'citizen_sdk', name), 'Windows 候选源头');
    if (!existsSync(header) || !lstatSync(header).isFile()
        || !readFileSync(header).equals(readFileSync(join(source, 'windows/citizen_sdk', name)))) {
      fail(`CitizenSDK Windows 重叠源码头漂移：${name}`);
    }
  }
  const pending = [];
  for (const path of WINDOWS_RELEASE_FILES) {
    const target = assertSafeTargetPath(join(root, path), 'Windows 安装目标');
    const bytes = readFileSync(nativeArtifactSource(installed, path));
    if (existsSync(target)) {
      if (WINDOWS_INJECTED_FILES.has(path) || !lstatSync(target).isFile()
          || !bytes.equals(readFileSync(target))) fail(`CitizenSDK Windows 重叠安装件漂移或目标已存在：${path}`);
    } else pending.push({ target, bytes });
  }
  if (pending.length !== WINDOWS_INJECTED_FILES.size) fail('CitizenSDK Windows 候选安装目标必须全部为空');
  for (const { target, bytes } of pending) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}

export function assertWindowsReleaseProjection(root) {
  const source = resolve(root);
  assertWindowsBindingSource(source, { allowInjectedWindowsArtifacts: true });
  assertPublicAbiHeaders(source);
  assertChainAssets(source);
  return assertWindowsInstalledPlatform(source, join(source, 'windows'));
}

/** 构建器调用的同源 bundle 检查；app.so 是 Dart AOT ELF，不是 PE。 */
export function assertWindowsFlutterBundle(sourceRoot, prefix, bundle) {
  const source = resolve(sourceRoot), installed = resolve(prefix);
  const root = assertSafeTargetPath(bundle, 'Windows Flutter bundle');
  assertWindowsNativeArtifact(source, installed);
  for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) {
    if (!readFileSync(nativeArtifactSource(root, name)).equals(
      readFileSync(nativeArtifactSource(installed, `bin/Windows/${name}`)),
    )) fail(`CitizenSDK Windows Flutter bundle 运行库来源漂移：${name}`);
  }
  for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
    const path = `data/flutter_assets/packages/citizen_sdk/chain/${name}`;
    if (!readFileSync(nativeArtifactSource(root, path)).equals(readFileSync(join(source, 'chain', name)))) {
      fail(`CitizenSDK Windows Flutter bundle 链资产漂移：${name}`);
    }
  }
  const plugin = windowsPe(nativeArtifactSource(root, 'citizen_sdk_plugin.dll'));
  if (!plugin.dll || JSON.stringify(plugin.exports) !== JSON.stringify(['CitizenSdkPluginRegisterWithRegistrar'])) {
    fail('CitizenSDK Windows Flutter 插件注册导出漂移');
  }
  assertWindowsImports(plugin, ['citizensdk.dll', 'citizensdk_host.dll', 'flutter_windows.dll'], expectedCitizenSdkSymbols(source));
  // Runner/Flutter engine 的功能导出不属于 SDK；只核机器身份，不伪造其符号闭集。
  windowsPe(nativeArtifactSource(root, 'citizensdk_consumer.exe'), { headersOnly: true });
  windowsPe(nativeArtifactSource(root, 'flutter_windows.dll'), { headersOnly: true });
  const aot = readFileSync(nativeArtifactSource(root, 'data/app.so'));
  if (aot.length < 64 || !aot.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || aot[4] !== 2 || aot[5] !== 1 || aot.readUInt16LE(18) !== 62) {
    fail('CitizenSDK Windows Dart AOT 必须为 x86_64 ELF64');
  }
}


// 只固定中央原生依赖子合同的规范 JSON 摘要，不另存一套可选版本/下载器。
// 收据内携带合同原文供离线复核；SDK构建器不读取外部仓库，也不自行下载任何库。
const NATIVE_DEPENDENCY_CONTRACT_SHA256 = '7f439abc35a891616b34b03d129b51dc82eef756535dcd8fcd25ee7da512f3e6';
const NATIVE_DEPENDENCY_PLATFORMS = ['LinuxARM', 'LinuxAMD', 'Windows'];
const TSS2_HEADERS = ['common', 'esys', 'mu', 'rc', 'sys', 'tcti', 'tcti_device', 'tpm2_types']
  .map((name) => 'include/tss2/tss2_' + name + '.h');
function dependencyCheck(ok, message) { if (!ok) fail('CitizenSDK 静态依赖：' + message); }
function dependencyHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function assertCitizenSdkNativeContract(value) {
  dependencyCheck(dependencyHash(stableJson(value)) === NATIVE_DEPENDENCY_CONTRACT_SHA256,
    '固定来源/版本/摘要/构建选项漂移');
}

/** 逐成员读真实 ar；拒绝薄归档、动态库、COFF import object、bitcode 及另一平台对象。 */
export function assertCitizenSdkStaticArchive(bytes, platform, nested = false) {
  dependencyCheck(NATIVE_DEPENDENCY_PLATFORMS.includes(platform), '未知平台');
  dependencyCheck(typeof nested === 'boolean', '静态归档嵌套状态无效');
  dependencyCheck(bytes.length >= 8 && bytes.subarray(0, 8).toString() === '!<arch>\n', '不是完整静态归档');
  let offset = 8, objects = 0, gnuNames = null;
  while (offset < bytes.length) {
    dependencyCheck(offset + 60 <= bytes.length, 'ar header 截断');
    const header = bytes.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString().trim();
    const sizeText = header.subarray(48, 58).toString().trim();
    dependencyCheck(header.subarray(58).toString() === '\x60\n' && /^\d+$/.test(sizeText), 'ar header 无效');
    const size = Number(sizeText), start = offset + 60;
    dependencyCheck(Number.isSafeInteger(size) && start + size <= bytes.length, 'ar member 截断');
    let object = bytes.subarray(start, start + size), actualName = name;
    if (name.startsWith('#1/')) {
      const length = Number(name.slice(3));
      dependencyCheck(Number.isSafeInteger(length) && length > 0 && length <= object.length, 'BSD ar 名称无效');
      actualName = object.subarray(0, length).toString().replace(/\0+$/, '');
      object = object.subarray(length);
    }
    if (name === '//') {
      dependencyCheck(gnuNames === null && object.length > 0, 'GNU ar 长名称表无效');
      gnuNames = object;
    } else if (/^\/\d+$/.test(name)) {
      const nameOffset = Number(name.slice(1));
      dependencyCheck(gnuNames && Number.isSafeInteger(nameOffset) && nameOffset >= 0
        && nameOffset < gnuNames.length
        && (nameOffset === 0 || (gnuNames[nameOffset - 2] === 47 && gnuNames[nameOffset - 1] === 10)),
      'GNU ar 长名称偏移无效');
      const end = gnuNames.indexOf(Buffer.from('/\n'), nameOffset);
      dependencyCheck(end > nameOffset, 'GNU ar 长名称未终止');
      actualName = gnuNames.subarray(nameOffset, end).toString();
      dependencyCheck(/^[A-Za-z0-9_.+@-]+$/.test(actualName), 'GNU ar 长名称字符无效');
    }
    if (!['/', '//', '/SYM64/', '__.SYMDEF', '__.SYMDEF SORTED'].includes(actualName)) {
      // 归档成员名只用于失败诊断；限制为短 ASCII，避免第三方归档把控制字符写入 CI 日志。
      const diagnosticName = /^[\x20-\x7e]{1,80}$/.test(actualName) ? actualName : '<invalid-name>';
      if (actualName === 'libcrypto.a/') {
        // OpenSSL 的正式静态输出可能用一个同名成员封装内部归档；只接受这一层精确名称，
        // 并递归验证其中每个 ELF 对象，不能把嵌套归档当作任意非对象成员跳过。
        dependencyCheck(platform !== 'Windows' && !nested, 'libcrypto 静态归档嵌套层级无效');
        dependencyCheck(object.length >= 8 && object.subarray(0, 8).toString() === '!<arch>\n',
          `libcrypto 静态归档成员不是完整归档：${diagnosticName}`);
        assertCitizenSdkStaticArchive(object, platform, true);
      } else if (platform === 'Windows') {
        dependencyCheck(object.length >= 20 && object.readUInt16LE(0) === 0x8664
          && object.readUInt16LE(2) > 0 && object.readUInt16LE(16) === 0, '非 Windows MSVC 静态对象');
        const count = object.readUInt16LE(2), tableEnd = 20 + count * 40;
        dependencyCheck(tableEnd <= object.length, 'COFF section table 截断');
        for (let section = 0; section < count; section += 1) {
          const at = 20 + section * 40, size = object.readUInt32LE(at + 16), pointer = object.readUInt32LE(at + 20);
          // 未初始化数据没有文件 payload；其余 section 必须完整位于成员内部。
          if (size && pointer) dependencyCheck(pointer >= tableEnd && pointer + size <= object.length, 'COFF section 越界');
          else dependencyCheck(!size || (object.readUInt32LE(at + 36) & 0x80) !== 0, 'COFF section 缺少内容');
        }
      } else {
        dependencyCheck(object.length >= 64 && object.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
          && object[4] === 2 && object[5] === 1 && object.readUInt16LE(16) === 1
          && object.readUInt16LE(18) === (platform === 'LinuxARM' ? 183 : 62),
        `非目标 Linux ELF relocatable 对象：${diagnosticName}`);
        const table = Number(object.readBigUInt64LE(40)), count = object.readUInt16LE(60);
        dependencyCheck(object.readUInt16LE(52) === 64 && object.readUInt16LE(58) === 64
          && Number.isSafeInteger(table) && table >= 64 && count > 0
          && table + count * 64 <= object.length, 'ELF section table 无效');
        for (let section = 0; section < count; section += 1) {
          const at = table + section * 64, type = object.readUInt32LE(at + 4);
          const pointer = Number(object.readBigUInt64LE(at + 24)), size = Number(object.readBigUInt64LE(at + 32));
          if (type !== 8) dependencyCheck(Number.isSafeInteger(pointer) && Number.isSafeInteger(size)
            && pointer + size <= object.length, 'ELF section 越界');
        }
      }
      objects += 1;
    }
    offset = start + size;
    if (offset % 2) {
      dependencyCheck(offset < bytes.length && bytes[offset] === 10, 'ar alignment 无效');
      offset += 1;
    }
  }
  dependencyCheck(objects > 0, '静态归档没有对象');
}

function dependencyArchives(platform) {
  return platform === 'Windows' ? ['lib/sqlite3.lib']
    : ['lib/libsqlite3.a', 'lib/libcrypto.a',
      ...['esys', 'mu', 'sys', 'rc', 'tcti-device'].map((name) => 'lib/libtss2-' + name + '.a')].sort();
}
function assertDependencyReceipt(receipt, platform) {
  dependencyCheck(receipt && stableJson(Object.keys(receipt).sort()) === stableJson(
    ['schema', 'platform', 'source_sha', 'software_version', 'build_mode', 'native_dependencies', 'build_tools', 'files'].sort()),
  '准备收据字段闭集无效');
  dependencyCheck(NATIVE_DEPENDENCY_PLATFORMS.includes(platform) && receipt.platform === platform
    && receipt.schema === 1 && /^[0-9a-f]{40}$/.test(receipt.source_sha)
    && /^\d+\.\d+\.\d+$/.test(receipt.software_version) && ['ci', 'release'].includes(receipt.build_mode),
  '收据平台/身份/模式无效');
  assertCitizenSdkNativeContract(receipt.native_dependencies);
  const tools = platform === 'Windows' ? ['cl', 'lib', 'tar'] : ['cc', 'ar', 'perl', 'make', 'sh', 'pkg-config', 'tar', 'unzip'];
  dependencyCheck(Array.isArray(receipt.build_tools)
    && stableJson(receipt.build_tools.map((tool) => tool.name).sort()) === stableJson(tools.sort()),
  '工具链闭集无效');
  for (const tool of receipt.build_tools) {
    dependencyCheck(/^[0-9a-f]{64}$/.test(tool.sha256)
      && stableJson(Object.keys(tool).sort()) === stableJson((tool.name === 'cc'
        ? ['name', 'sha256', 'target'] : ['name', 'sha256']).sort()), '工具身份无效');
    if (tool.name === 'cc') dependencyCheck(typeof tool.target === 'string'
      && tool.target.startsWith(platform === 'LinuxARM' ? 'aarch64-' : 'x86_64-')
      && tool.target.endsWith('linux-gnu'), '编译器目标无效');
  }
  dependencyCheck(Array.isArray(receipt.files) && receipt.files.length > 0 && receipt.files.length <= 256,
    '输入文件列表无效');
  const paths = receipt.files.map((entry) => {
    dependencyCheck(entry && Object.keys(entry).sort().join(',') === 'path,sha256'
      && typeof entry.path === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(entry.path)
      && !entry.path.split('/').includes('..') && !entry.path.startsWith('/')
      && /^[0-9a-f]{64}$/.test(entry.sha256), '输入条目无效');
    return entry.path;
  });
  const archives = dependencyArchives(platform);
  const expected = ['include/sqlite3.h', ...archives,
    ...(platform === 'Windows' ? [] : [...TSS2_HEADERS,
      ...OPENSSL_DEPENDENCY_HEADERS.map((name) => 'include/openssl/' + name)])].sort();
  dependencyCheck(stableJson(paths) === stableJson(expected), '输入头文件/静态库闭集不符');
  return receipt;
}

/** 收据不可单独代替静态库：每个实际头/库都重新哈希，并核对所有对象的机器身份。 */
export function assertCitizenSdkDependencyInputs(receiptPath, platform) {
  const path = assertSafeTargetPath(receiptPath, '静态依赖证据');
  const prefix = dirname(path);
  const receipt = assertDependencyReceipt(JSON.parse(readFileSync(nativeArtifactSource(prefix, 'native-dependencies.json'), 'utf8')), platform);
  dependencyCheck(path === join(prefix, 'native-dependencies.json'), '收据文件名不符');
  const actual = treeEntries(prefix).files;
  dependencyCheck(stableJson(actual) === stableJson([...receipt.files.map((entry) => entry.path), 'native-dependencies.json'].sort()),
    '实际输入含未登记文件');
  for (const entry of receipt.files) {
    const input = nativeArtifactSource(prefix, entry.path);
    dependencyCheck(sha256File(input) === entry.sha256, '实际输入摘要不符：' + entry.path);
    if (dependencyArchives(platform).includes(entry.path)) assertCitizenSdkStaticArchive(readFileSync(input), platform);
  }
  return receipt;
}

/** 保持现有显式环境入口，仅从已经验证的同一前缀取得所有头/库，拒绝混用外部路径。 */
export function citizenSdkDependencyEnvironment(receiptPath, platform) {
  assertCitizenSdkDependencyInputs(receiptPath, platform);
  const prefix = dirname(resolve(receiptPath)), at = (path) => join(prefix, path);
  if (platform === 'Windows') return {
    CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR: at('include'),
    CITIZENSDK_WINDOWS_SQLITE_ARCHIVE: at('lib/sqlite3.lib'),
  };
  return {
    CITIZENSDK_HOST_SQLITE_INCLUDE_DIR: at('include'),
    CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR: at('include'),
    CITIZENSDK_HOST_TSS2_INCLUDE_DIR: at('include'),
    CITIZENSDK_HOST_SQLITE_ARCHIVE: at('lib/libsqlite3.a'),
    CITIZENSDK_HOST_CRYPTO_ARCHIVE: at('lib/libcrypto.a'),
    ...Object.fromEntries(['esys', 'mu', 'sys', 'rc', 'tcti-device'].map((name) =>
      ['CITIZENSDK_HOST_TSS2_' + name.replaceAll('-', '_').toUpperCase() + '_ARCHIVE', at('lib/libtss2-' + name + '.a')])),
  };
}

function dependencyLinkedPaths(platform, layout) {
  const paths = platform === 'Windows'
    ? ['bin/Windows/citizensdk.dll', 'bin/Windows/citizensdk_host.dll']
    : ['lib/' + platform + '/libcitizensdk.so', 'lib/' + platform + '/libcitizensdk_host.so'];
  return paths.map((path) => layout === 'candidate' ? (platform === 'Windows' ? 'windows/' : 'linux/') + path
    : layout === 'native' ? (platform === 'Windows' ? 'Windows/' : 'linux/' + platform + '/') + path : path);
}

/** 只有原生门禁和消费者全部成功后，构建器才绑定该批输入与导出的最终运行库。 */
export function writeCitizenSdkDependencyEvidence({ receiptPath, platform, nativePath, sourcePath, sourceSha }) {
  const receipt = assertCitizenSdkDependencyInputs(receiptPath, platform);
  dependencyCheck(receipt.source_sha === sourceSha, '构建提交与准备提交不同');
  const source = resolve(sourcePath), native = assertSafeTargetPath(nativePath, '原生产物目录');
  assertLicenseSources(source);
  dependencyCheck(readFileSync(join(source, 'pubspec.yaml'), 'utf8').includes('\nversion: ' + receipt.software_version + '\n'),
    '构建版本与准备版本不同');
  const paths = dependencyLinkedPaths(platform, 'native');
  const linked_artifacts = paths.map((path, index) => ({
    path: dependencyLinkedPaths(platform, 'candidate')[index],
    sha256: sha256File(nativeArtifactSource(native, path)),
  }));
  const evidence = { dependency_inputs: receipt, linked_artifacts,
    files: ['LICENSE'].map((path) => ({ path, sha256: sha256File(join(source, path)) })) };
  const directory = join(native, 'dependencies');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  nativeArtifactSource(native, 'dependencies', 'directory');
  writeFileSync(join(directory, platform + '.json'), prettyStableJson(evidence), { flag: 'wx', mode: 0o600 });
  return evidence;
}

export function assertCitizenSdkDependencyEvidence(evidence, platform, root, layout, source, sourceSha, softwareVersion) {
  dependencyCheck(evidence && Object.keys(evidence).sort().join(',') === 'dependency_inputs,files,linked_artifacts',
    '链接证据字段闭集无效');
  const receipt = assertDependencyReceipt(evidence.dependency_inputs, platform);
  dependencyCheck(receipt.source_sha === sourceSha && receipt.software_version === softwareVersion, '链接证据不同提交/版本');
  const expected = dependencyLinkedPaths(platform, 'candidate');
  dependencyCheck(Array.isArray(evidence.linked_artifacts)
    && stableJson(evidence.linked_artifacts.map((entry) => entry.path)) === stableJson(expected),
  '最终运行库闭集无效');
  for (const [index, entry] of evidence.linked_artifacts.entries()) {
    dependencyCheck(Object.keys(entry).sort().join(',') === 'path,sha256'
      && entry.sha256 === sha256File(nativeArtifactSource(root, dependencyLinkedPaths(platform, layout)[index])),
    '最终链接字节不符');
  }
  const legal = ['LICENSE'].map((path) => ({ path, sha256: sha256File(join(source, path)) }));
  dependencyCheck(stableJson(evidence.files) === stableJson(legal), '许可证/归属来源不符');
  return evidence;
}

function collectDependencyEvidence(native, source, sourceSha, softwareVersion) {
  const directory = nativeArtifactSource(native, 'dependencies', 'directory');
  dependencyCheck(stableJson(treeEntries(directory).files) === stableJson(
    NATIVE_DEPENDENCY_PLATFORMS.map((platform) => platform + '.json').sort()), '链接证据平台闭集不符');
  return NATIVE_DEPENDENCY_PLATFORMS.map((platform) => assertCitizenSdkDependencyEvidence(
    JSON.parse(readFileSync(join(directory, platform + '.json'), 'utf8')),
    platform, native, 'native', source, sourceSha, softwareVersion));
}

const OPENSSL_DEPENDENCY_HEADERS = [
  "aes.h",
  "asn1.h",
  "asn1err.h",
  "asn1t.h",
  "async.h",
  "asyncerr.h",
  "bio.h",
  "bioerr.h",
  "blowfish.h",
  "bn.h",
  "bnerr.h",
  "buffer.h",
  "buffererr.h",
  "byteorder.h",
  "camellia.h",
  "cast.h",
  "cmac.h",
  "cmp.h",
  "cmp_util.h",
  "cmperr.h",
  "cms.h",
  "cmserr.h",
  "comp.h",
  "comperr.h",
  "conf.h",
  "conf_api.h",
  "conferr.h",
  "configuration.h",
  "conftypes.h",
  "core.h",
  "core_dispatch.h",
  "core_names.h",
  "core_object.h",
  "crmf.h",
  "crmferr.h",
  "crypto.h",
  "cryptoerr.h",
  "cryptoerr_legacy.h",
  "ct.h",
  "cterr.h",
  "decoder.h",
  "decodererr.h",
  "des.h",
  "dh.h",
  "dherr.h",
  "dsa.h",
  "dsaerr.h",
  "dtls1.h",
  "e_os2.h",
  "e_ostime.h",
  "ebcdic.h",
  "ec.h",
  "ecdh.h",
  "ecdsa.h",
  "ecerr.h",
  "encoder.h",
  "encodererr.h",
  "engine.h",
  "engineerr.h",
  "err.h",
  "ess.h",
  "esserr.h",
  "evp.h",
  "evperr.h",
  "fips_names.h",
  "fipskey.h",
  "hmac.h",
  "hpke.h",
  "http.h",
  "httperr.h",
  "idea.h",
  "indicator.h",
  "kdf.h",
  "kdferr.h",
  "lhash.h",
  "macros.h",
  "md2.h",
  "md4.h",
  "md5.h",
  "mdc2.h",
  "ml_kem.h",
  "modes.h",
  "obj_mac.h",
  "objects.h",
  "objectserr.h",
  "ocsp.h",
  "ocsperr.h",
  "opensslconf.h",
  "opensslv.h",
  "ossl_typ.h",
  "param_build.h",
  "params.h",
  "pem.h",
  "pem2.h",
  "pemerr.h",
  "pkcs12.h",
  "pkcs12err.h",
  "pkcs7.h",
  "pkcs7err.h",
  "prov_ssl.h",
  "proverr.h",
  "provider.h",
  "quic.h",
  "rand.h",
  "randerr.h",
  "rc2.h",
  "rc4.h",
  "rc5.h",
  "ripemd.h",
  "rsa.h",
  "rsaerr.h",
  "safestack.h",
  "seed.h",
  "self_test.h",
  "sha.h",
  "srp.h",
  "srtp.h",
  "ssl.h",
  "ssl2.h",
  "ssl3.h",
  "sslerr.h",
  "sslerr_legacy.h",
  "stack.h",
  "store.h",
  "storeerr.h",
  "symhacks.h",
  "thread.h",
  "tls1.h",
  "trace.h",
  "ts.h",
  "tserr.h",
  "txt_db.h",
  "types.h",
  "ui.h",
  "uierr.h",
  "whrlpool.h",
  "x509.h",
  "x509_acert.h",
  "x509_vfy.h",
  "x509err.h",
  "x509v3.h",
  "x509v3err.h"
];


export function assertNativeArtifactSources(nativeRoot) {
  const root = assertSafeTargetPath(nativeRoot, '原生产物目录');
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    fail('CitizenSDK 原生产物目录不存在或不是普通目录');
  }
  if (realpathSync(root) !== root) fail('CitizenSDK 原生产物目录真实路径漂移');
  const files = Object.fromEntries(
    Object.entries(NATIVE_FILES).map(([destinationPath, sourcePath]) => [
      destinationPath,
      nativeArtifactSource(root, sourcePath),
    ]),
  );
  const directories = Object.fromEntries(
    Object.entries(NATIVE_DIRECTORIES).map(([destinationPath, sourcePath]) => {
      const source = nativeArtifactSource(root, sourcePath, 'directory');
      // 这里只承认标准 macOS framework 的五个精确内部链接；遍历不会跟随
      // 链接，并会拒绝 iOS slice 或其它位置出现的任何链接。
      const entries = treeEntries(source, appleXcframeworkSymlinkContract(source));
      if (entries.files.length === 0) fail(`原生产物目录为空：${sourcePath}`);
      return [destinationPath, source];
    }),
  );
  const linux = Object.fromEntries(LINUX_PLATFORMS.map((platform) => {
    const prefix = nativeArtifactSource(root, `linux/${platform}`, 'directory');
    assertLinuxInstallClosure(prefix, platform);
    return [platform, prefix];
  }));
  const [first, second] = LINUX_PLATFORMS;
  for (const path of linuxInstallPaths(first).filter((path) => !path.startsWith('lib/'))) {
    if (!readFileSync(join(linux[first], path)).equals(readFileSync(join(linux[second], path)))) {
      fail(`CitizenSDK Linux 共享安装件字节不一致：${path}`);
    }
  }
  const windows = nativeArtifactSource(root, 'Windows', 'directory');
  assertWindowsInstallClosure(windows);
  return { directories, files, linux, windows };
}

function copyNativeFiles(nativeRoot, output, sourceRoot) {
  const sources = assertNativeArtifactSources(nativeRoot);
  for (const [destinationPath, source] of Object.entries(sources.files)) {
    const destination = join(output, ...destinationPath.split('/'));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
  }
  for (const [destinationPath, source] of Object.entries(sources.directories)) {
    const destinationRoot = join(output, ...destinationPath.split('/'));
    if (existsSync(destinationRoot)) fail(`原生产物目录目标已存在：${destinationPath}`);
    mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
    const symlinkContract = appleXcframeworkSymlinkContract(source);
    const entries = treeEntries(source, symlinkContract);
    for (const relativePath of entries.files) {
      const destination = join(destinationRoot, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, ...relativePath.split('/')), destination);
    }
    // 不复制任意来源链接；只按已验证的文字合同重建五个相对链接。
    for (const relativePath of entries.symlinks) {
      const destination = join(destinationRoot, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      symlinkSync(
        symlinkContract[relativePath],
        destination,
      );
    }
  }
  for (const [platform, prefix] of Object.entries(sources.linux)) {
    for (const path of linuxInstallPaths(platform)) {
      const source = join(prefix, path);
      const destination = join(output, 'linux', path);
      if (existsSync(destination)) {
        if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isFile()
            || !readFileSync(source).equals(readFileSync(destination))) {
          fail(`CitizenSDK Linux 安装件与来源重叠漂移，拒绝覆盖：${path}`);
        }
      } else {
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(source, destination);
      }
    }
  }
  copyWindowsNativeArtifact(sourceRoot, sources.windows, output);
}

function zipEntries(bytes, label) {
  const minimumEocd = 22;
  const maximumComment = 0xffff;
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd;
    offset >= Math.max(0, bytes.length - minimumEocd - maximumComment);
    offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail(`${label} 不是普通 ZIP`);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
      || entryCount === 0 || entryCount === 0xffff
      || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || entryCount > 10000 || eocd + minimumEocd + commentLength !== bytes.length
      || centralOffset + centralSize !== eocd) {
    fail(`${label} ZIP 中央目录无效或使用了不支持的 ZIP64/分卷格式`);
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail(`${label} ZIP 中央目录条目无效`);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (next > eocd || nameLength === 0 || (flags & 0x1) !== 0
        || ![0, 8].includes(method) || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      fail(`${label} ZIP 条目属性无效`);
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(nameBytes)
        || name.includes('\0') || name.includes('\\') || name.startsWith('/')
        || name.split('/').includes('..') || entries.has(name)) {
      fail(`${label} ZIP 条目路径无效或重复`);
    }
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      fail(`${label} ZIP local header 无效`);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset
        || !bytes.subarray(localNameStart, localNameStart + localNameLength).equals(nameBytes)) {
      fail(`${label} ZIP local/central 条目不一致`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content;
    try {
      content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    } catch {
      fail(`${label} ZIP 条目无法解压：${name}`);
    }
    if (content.length !== uncompressedSize) {
      fail(`${label} ZIP 条目长度不一致：${name}`);
    }
    entries.set(name, content);
    cursor = next;
  }
  if (cursor !== eocd) fail(`${label} ZIP 中央目录包含未解析字节`);
  return entries;
}

/** Verify the Android AAR and Flutter projection are the same two native bytes. */
export function assertAndroidReleaseProjection(root) {
  const candidate = resolve(root);
  const aarPath = join(candidate, 'android', 'citizensdk.aar');
  const corePath = join(
    candidate,
    'android',
    'src',
    'main',
    'jniLibs',
    'arm64-v8a',
    'libcitizensdk.so',
  );
  const jniPath = join(
    candidate,
    'android',
    'src',
    'main',
    'jniLibs',
    'arm64-v8a',
    'libcitizensdk_jni.so',
  );
  for (const [path, label] of [
    [aarPath, 'Android AAR'],
    [corePath, 'Flutter Android Core 库'],
    [jniPath, 'Flutter Android JNI 库'],
  ]) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 候选缺少普通${label}`);
    }
  }

  const aarEntries = zipEntries(readFileSync(aarPath), 'CitizenSDK Android AAR');
  const nativeEntries = [...aarEntries.keys()]
    .filter((path) => path.startsWith('jni/') && !path.endsWith('/'))
    .sort();
  const expectedNativeEntries = [
    'jni/arm64-v8a/libcitizensdk.so',
    'jni/arm64-v8a/libcitizensdk_jni.so',
  ];
  if (JSON.stringify(nativeEntries) !== JSON.stringify(expectedNativeEntries)) {
    fail(`CitizenSDK Android AAR 双库闭集漂移：${nativeEntries.join(',') || '无'}`);
  }
  for (const required of ['AndroidManifest.xml', 'classes.jar']) {
    if (!aarEntries.has(required)) fail(`CitizenSDK Android AAR 缺少 ${required}`);
  }
  const packagedAssets = [...aarEntries.keys()]
    .filter((path) => path.startsWith('assets/') && !path.endsWith('/'))
    .sort();
  // Android归档必须带标准assets容器；源码信任锚仍只来自chain，不能把归档路径当源码路径。
  const expectedAssets = Object.keys(CHAIN_ASSET_FILES).map((path) => `assets/${path}`).sort();
  if (JSON.stringify(packagedAssets) !== JSON.stringify(expectedAssets)) {
    fail(`CitizenSDK Android AAR 链资产闭集漂移：${packagedAssets.join(',') || '无'}`);
  }
  for (const sourcePath of Object.keys(CHAIN_ASSET_FILES)) {
    const packagedPath = `assets/${sourcePath}`;
    if (!aarEntries.get(packagedPath).equals(readFileSync(join(candidate, sourcePath)))) {
      fail(`CitizenSDK Android AAR 链资产与候选信任锚字节不一致：${packagedPath}`);
    }
  }
  if ([...aarEntries.keys()].some((path) => path.endsWith('.aar')
      || /(?:^|\/)(?:libsmoldot|libc\+\+_shared)\.so$/.test(path))) {
    fail('CitizenSDK Android AAR 混入嵌套 AAR、legacy 或共享 C++ 运行库');
  }
  if (!aarEntries.get(expectedNativeEntries[0]).equals(readFileSync(corePath))
      || !aarEntries.get(expectedNativeEntries[1]).equals(readFileSync(jniPath))) {
    fail('CitizenSDK Android AAR 与 Flutter 投影的双原生库字节不一致');
  }

  const classEntries = zipEntries(aarEntries.get('classes.jar'), 'CitizenSDK Android classes.jar');
  for (const required of [
    'org/citizen/sdk/CitizenSdk.class',
    'org/citizen/sdk/CitizenSdkLifecycle.class',
    'org/citizen/sdk/CitizenSdkException.class',
    'org/citizen/sdk/CitizenSdkEvents.class',
    'org/citizen/sdk/CitizenWalletProfile.class',
    'org/citizen/sdk/CitizenSdkOperation.class',
    'org/citizen/sdk/internal/CitizenSdkNative.class',
    'org/citizen/sdk/internal/CitizenSdkHardwareVault.class',
    'org/citizen/sdk/internal/CitizenSdkHostServices.class',
    'org/citizen/sdk/internal/CitizenSdkRequestRouter.class',
    'org/citizen/sdk/CitizenSdkPreparedWallet.class',
    'org/citizen/sdk/CitizenSdkRecoveryPhrase.class',
    'org/citizen/sdk/CitizenSdkPrivateKey.class',
    'org/citizen/sdk/CitizenSdkQrCapture.class',
    'org/citizen/sdk/CitizenQrReview.class',
    'org/citizen/sdk/CitizenWalletInspection.class',
    'org/citizen/sdk/CitizenWalletDiagnostic.class',
    'org/citizen/sdk/CitizenWalletCleanupTargets.class',
  ]) {
    if (!classEntries.has(required)) {
      fail(`CitizenSDK Android classes.jar 缺少必需实现：${required}`);
    }
  }
  for (const [path, content] of classEntries) {
    if (path.startsWith('org/citizen/sdk/ui/')) fail('CitizenSDK Android classes.jar 残留SDK界面实现');
    if (path.startsWith('io/flutter/') || content.includes(Buffer.from('io/flutter/'))) {
      fail('CitizenSDK Android 原生 AAR 混入或引用 Flutter API');
    }
  }
  const aarFiles = regularFiles(join(candidate, 'android'))
    .filter((path) => path.endsWith('.aar'))
    .sort();
  if (JSON.stringify(aarFiles) !== JSON.stringify(['citizensdk.aar'])) {
    fail(`CitizenSDK Android 候选 AAR 闭集漂移：${aarFiles.join(',') || '无'}`);
  }
}

function decodePlistXmlText(value, label) {
  return value.replace(/&(?:#(x[0-9a-fA-F]+|[0-9]+)|amp|apos|gt|lt|quot);/g, (entity, number) => {
    if (number !== undefined) {
      const radix = number.startsWith('x') ? 16 : 10;
      const digits = number.startsWith('x') ? number.slice(1) : number;
      const codePoint = Number.parseInt(digits, radix);
      if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
        fail(`${label} plist 含无效字符实体`);
      }
      return String.fromCodePoint(codePoint);
    }
    return {
      '&amp;': '&',
      '&apos;': "'",
      '&gt;': '>',
      '&lt;': '<',
      '&quot;': '"',
    }[entity];
  });
}

/** Parse the small XML-plist subset emitted for framework metadata. */
function parseXmlPlist(bytes, label) {
  let source = bytes.toString('utf8');
  source = source
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const tokens = [...source.matchAll(/<[^>]+>|[^<]+/g)]
    .map((match) => match[0])
    .filter((token) => token.startsWith('<') || token.trim().length > 0);
  let cursor = 0;
  const take = () => tokens[cursor++];
  const expect = (expected) => {
    const actual = take();
    if (actual !== expected) fail(`${label} plist 结构无效；期望=${expected}；实际=${actual ?? '<eof>'}`);
  };
  const parseValue = () => {
    const token = take();
    if (token === '<dict>') {
      const value = Object.create(null);
      while (tokens[cursor] !== '</dict>') {
        expect('<key>');
        const keyText = take();
        if (!keyText || keyText.startsWith('<')) fail(`${label} plist key 无效`);
        expect('</key>');
        const key = decodePlistXmlText(keyText.trim(), label);
        if (Object.hasOwn(value, key)) fail(`${label} plist key 重复：${key}`);
        value[key] = parseValue();
      }
      cursor += 1;
      return value;
    }
    if (token === '<array>') {
      const value = [];
      while (tokens[cursor] !== '</array>') value.push(parseValue());
      cursor += 1;
      return value;
    }
    if (token === '<true/>') return true;
    if (token === '<false/>') return false;
    const scalar = token?.match(/^<(string|integer)>$/)?.[1];
    if (!scalar) fail(`${label} plist 含不支持的值：${token ?? '<eof>'}`);
    const text = take();
    if (text === `</${scalar}>`) return scalar === 'integer' ? 0 : '';
    if (!text || text.startsWith('<')) fail(`${label} plist 标量无效`);
    expect(`</${scalar}>`);
    const decoded = decodePlistXmlText(text.trim(), label);
    if (scalar === 'string') return decoded;
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(decoded)) fail(`${label} plist integer 无效`);
    const integer = Number(decoded);
    if (!Number.isSafeInteger(integer)) fail(`${label} plist integer 超界`);
    return integer;
  };
  if (!/^<plist(?: version="1\.0")?>$/.test(tokens[cursor] ?? '')) {
    fail(`${label} 不是 XML plist 1.0`);
  }
  cursor += 1;
  const value = parseValue();
  expect('</plist>');
  if (cursor !== tokens.length) fail(`${label} plist 含尾随内容`);
  return value;
}

function encodedMachOVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function machOCString(bytes, start, end, label) {
  const zero = bytes.indexOf(0, start);
  if (start < 0 || start >= end || zero < start || zero >= end) {
    fail(`${label} Mach-O 字符串越界或未终止`);
  }
  return bytes.subarray(start, zero).toString('utf8');
}

/** Read the thin arm64 Mach-O identity and external defined symbol table. */
function readAppleMachO(bytes, label) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    fail(`${label} 必须是 thin 64-bit Mach-O`);
  }
  const cpuType = bytes.readUInt32LE(4);
  const fileType = bytes.readUInt32LE(12);
  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  if (cpuType !== 0x0100000c || fileType !== 6
      || commandCount === 0 || commandCount > 4096
      || commandBytes > bytes.length - 32) {
    fail(`${label} 必须是单一 arm64 动态 framework 二进制`);
  }
  let cursor = 32;
  const commandEnd = cursor + commandBytes;
  let identity = null;
  let build = null;
  let symbolTable = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandEnd) fail(`${label} Mach-O load command 截断`);
    const command = bytes.readUInt32LE(cursor);
    const size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > commandEnd) fail(`${label} Mach-O load command 越界`);
    if (command === 0x0d) {
      if (identity !== null || size < 24) fail(`${label} LC_ID_DYLIB 无效或重复`);
      const nameOffset = bytes.readUInt32LE(cursor + 8);
      identity = machOCString(bytes, cursor + nameOffset, cursor + size, label);
    } else if (command === 0x32) {
      if (build !== null || size < 24) fail(`${label} LC_BUILD_VERSION 无效或重复`);
      build = {
        platform: bytes.readUInt32LE(cursor + 8),
        minimum: encodedMachOVersion(bytes.readUInt32LE(cursor + 12)),
      };
    } else if (command === 0x02) {
      if (symbolTable !== null || size < 24) fail(`${label} LC_SYMTAB 无效或重复`);
      symbolTable = {
        symbolOffset: bytes.readUInt32LE(cursor + 8),
        symbolCount: bytes.readUInt32LE(cursor + 12),
        stringOffset: bytes.readUInt32LE(cursor + 16),
        stringSize: bytes.readUInt32LE(cursor + 20),
      };
    }
    cursor += size;
  }
  if (cursor !== commandEnd || identity === null || build === null || symbolTable === null) {
    fail(`${label} 缺少唯一 install name、build version 或 symbol table`);
  }
  const symbolsEnd = symbolTable.symbolOffset + symbolTable.symbolCount * 16;
  const stringsEnd = symbolTable.stringOffset + symbolTable.stringSize;
  if (symbolTable.symbolCount > 1000000 || symbolsEnd > bytes.length
      || symbolTable.stringSize === 0 || stringsEnd > bytes.length) {
    fail(`${label} Mach-O symbol table 越界`);
  }
  const symbols = new Set();
  for (let index = 0; index < symbolTable.symbolCount; index += 1) {
    const offset = symbolTable.symbolOffset + index * 16;
    const stringIndex = bytes.readUInt32LE(offset);
    const type = bytes[offset + 4];
    const isDebug = (type & 0xe0) !== 0;
    const isPrivateExternal = (type & 0x10) !== 0;
    const isExternal = (type & 0x01) !== 0;
    const isUndefined = (type & 0x0e) === 0;
    // ld64 keeps hidden symbols as N_PEXT in the ordinary symbol table. They
    // remain usable inside the image but are not part of the dynamic product
    // boundary, so only public external defined symbols belong in this set.
    if (isDebug || isPrivateExternal || !isExternal || isUndefined) continue;
    if (stringIndex === 0 || stringIndex >= symbolTable.stringSize) {
      fail(`${label} Mach-O symbol string index 越界`);
    }
    const name = machOCString(
      bytes,
      symbolTable.stringOffset + stringIndex,
      stringsEnd,
      label,
    );
    symbols.add(name.startsWith('_') ? name.slice(1) : name);
  }
  return { build, identity, symbols };
}

// 显式私钥receiver已归公开Core头；不再保留仅供SDK窗口的私有导出。
export const CITIZENSDK_INTERNAL_SYMBOLS = Object.freeze([]);

/** 构建期内部模块仍复用公开Core头及独立二维码图像头，不复制公开类型声明。 */
export function citizenSdkInternalHeader() {
  return `#ifndef CITIZENSDK_INTERNAL_H
#define CITIZENSDK_INTERNAL_H
#include "citizensdk.h"
#endif
`;
}

function expectedCitizenSdkSymbols(root) {
  const header = readFileSync(join(root, 'include', 'citizensdk.h'), 'utf8');
  const symbols = [...new Set(
    [...header.matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g)].map((match) => match[1]),
  )].sort();
  if (symbols.length !== 150) fail('CitizenSDK 产品头必须精确声明 150 个 citizensdk_* 函数');
  return symbols;
}

function expectedQrImageSymbols(root) {
  const header = readFileSync(join(root, 'native/qr-image/citizensdk_qr_image.h'), 'utf8');
  const symbols = [...new Set(
    [...header.matchAll(/\b(citizensdk_qr_image_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]),
  )].sort();
  if (symbols.length !== 4) fail('CitizenSDK QR 图像头必须精确声明 4 个函数');
  return symbols;
}

function expectedAppleSymbols(root) {
  return [...expectedCitizenSdkSymbols(root), ...expectedQrImageSymbols(root)].sort();
}

function expectedCitizenSdkLinkedSymbols(root) {
  return [...expectedCitizenSdkSymbols(root), ...CITIZENSDK_INTERNAL_SYMBOLS].sort();
}

function assertAppleFrameworkSlice(candidate, xcframework, identifier, contract) {
  const label = contract.label;
  const sliceRoot = join(xcframework, identifier);
  const framework = join(sliceRoot, 'CitizenSDK.framework');
  if (!existsSync(sliceRoot) || lstatSync(sliceRoot).isSymbolicLink()
      || !lstatSync(sliceRoot).isDirectory()
      || JSON.stringify(readdirSync(sliceRoot).sort())
        !== JSON.stringify(['CitizenSDK.framework'])) {
    fail(`${label} slice 根闭集漂移`);
  }
  if (!existsSync(framework) || lstatSync(framework).isSymbolicLink()
      || !lstatSync(framework).isDirectory()) {
    fail(`${label} framework 缺失或不是普通目录`);
  }
  const isMacOS = contract.supportedPlatform === 'macos';
  // 单 slice 校验也必须独立关闭链接边界，不能依赖外层调用顺序。
  treeEntries(
    framework,
    isMacOS ? APPLE_MACOS_FRAMEWORK_SYMLINKS : Object.freeze({}),
  );
  const expectedTopEntries = isMacOS
    ? ['CitizenSDK', 'Headers', 'Modules', 'Resources', 'Versions']
    : ['CitizenSDK', 'Headers', 'Info.plist', 'Modules', 'Resources'];
  const topEntries = readdirSync(framework).sort();
  if (JSON.stringify(topEntries) !== JSON.stringify(expectedTopEntries)) {
    fail(`${label} framework 根闭集漂移`);
  }
  const contentRoot = isMacOS ? join(framework, 'Versions', 'A') : framework;
  if (isMacOS) {
    const versionEntries = readdirSync(join(framework, 'Versions')).sort();
    const contentEntries = readdirSync(contentRoot).sort();
    if (JSON.stringify(versionEntries) !== JSON.stringify(['A', 'Current'])
        || JSON.stringify(contentEntries)
          !== JSON.stringify(['CitizenSDK', 'Headers', 'Modules', 'Resources'])) {
      fail(`${label} 版本化 framework 闭集漂移`);
    }
  }
  const binaryPath = join(contentRoot, 'CitizenSDK');
  if (!existsSync(binaryPath) || lstatSync(binaryPath).isSymbolicLink()
      || !lstatSync(binaryPath).isFile()) {
    fail(`${label} 二进制必须是普通文件`);
  }
  const binary = readAppleMachO(readFileSync(binaryPath), label);
  if (binary.identity !== contract.installName) {
    fail(`${label} install name 漂移`);
  }
  if (binary.build.platform !== contract.platform
      || binary.build.minimum !== contract.minimum) {
    fail(`${label} 平台或最低系统版本漂移`);
  }
  const expectedSymbols = expectedAppleSymbols(candidate);
  const allSymbols = [...binary.symbols].sort();
  const actualSymbols = allSymbols
    .filter((symbol) => symbol.startsWith('citizensdk_'))
    .sort();
  if (JSON.stringify(actualSymbols) !== JSON.stringify(expectedSymbols)) {
    fail(`${label} 必须精确导出 154 个 citizensdk_* 产品符号`);
  }
  const forbidden = [...binary.symbols]
    .filter((symbol) => /^(?:smoldot_|citizen_sr25519_|account_crypto_)/.test(symbol))
    .sort();
  if (forbidden.length > 0) fail(`${label} 泄漏 legacy 低层符号：${forbidden.join(',')}`);
  const swiftSymbols = allSymbols.filter((symbol) => symbol.startsWith('$s10CitizenSDK'));
  if (swiftSymbols.length === 0) fail(`${label} 缺少 CitizenSDK Swift 模块导出`);
  const foreign = allSymbols.filter(
    (symbol) => !symbol.startsWith('citizensdk_')
      && !symbol.startsWith('$s10CitizenSDK'),
  );
  if (foreign.length > 0) {
    fail(`${label} 泄漏非 CitizenSDK 产品符号：${foreign.join(',')}`);
  }

  const headersRoot = join(contentRoot, 'Headers');
  if (JSON.stringify(readdirSync(headersRoot).sort())
      !== JSON.stringify(['citizensdk.h', 'citizensdk_qr_image.h', 'citizensdk_types.h'])) {
    fail(`${label} Headers 目录闭集漂移`);
  }
  const headerPaths = regularFiles(headersRoot);
  const expectedHeaders = ['citizensdk.h', 'citizensdk_qr_image.h', 'citizensdk_types.h'];
  if (JSON.stringify(headerPaths) !== JSON.stringify(expectedHeaders)) {
    fail(`${label} 产品头闭集漂移`);
  }
  for (const header of expectedHeaders) {
    const source = header === 'citizensdk_qr_image.h'
      ? join(candidate, 'native/qr-image', header) : join(candidate, 'include', header);
    if (!readFileSync(join(headersRoot, header)).equals(readFileSync(source))) {
      fail(`${label} 产品头与根 ABI 字节不一致：${header}`);
    }
  }

  const modulesRoot = join(contentRoot, 'Modules');
  const moduleMapPath = join(modulesRoot, 'module.modulemap');
  const swiftModuleRoot = join(modulesRoot, 'CitizenSDK.swiftmodule');
  if (!existsSync(moduleMapPath) || lstatSync(moduleMapPath).isSymbolicLink()
      || !lstatSync(moduleMapPath).isFile()
      || !existsSync(swiftModuleRoot) || lstatSync(swiftModuleRoot).isSymbolicLink()
      || !lstatSync(swiftModuleRoot).isDirectory()) {
    fail(`${label} Clang/Swift module 不完整`);
  }
  if (JSON.stringify(readdirSync(modulesRoot).sort())
      !== JSON.stringify(['CitizenSDK.swiftmodule', 'module.modulemap'])) {
    fail(`${label} Modules 目录闭集漂移`);
  }
  const moduleMap = readFileSync(moduleMapPath, 'utf8');
  if (!moduleMap.includes('framework module CitizenSDK')
      || !moduleMap.includes('umbrella header "citizensdk.h"')
      || /(?:smoldot_|citizen_sr25519_|account_crypto_)/.test(moduleMap)) {
    fail(`${label} module.modulemap 边界无效`);
  }
  const swiftModules = regularFiles(swiftModuleRoot);
  if (readdirSync(swiftModuleRoot).some((path) => {
    const info = lstatSync(join(swiftModuleRoot, path));
    return info.isSymbolicLink() || !info.isFile();
  })) {
    fail(`${label} Swift module 只允许普通文件`);
  }
  const expectedSwiftModules = APPLE_SWIFT_MODULE_EXTENSIONS
    .map((extension) => `${contract.module}.${extension}`)
    .sort();
  if (JSON.stringify(swiftModules) !== JSON.stringify(expectedSwiftModules)) {
    fail(`${label} Swift module 六文件闭集或架构身份漂移`);
  }
  const publicInterface = readFileSync(
    join(swiftModuleRoot, `${contract.module}.swiftinterface`), 'utf8',
  );
  const privateInterface = readFileSync(
    join(swiftModuleRoot, `${contract.module}.private.swiftinterface`), 'utf8',
  );
  for (const [kind, swiftInterface] of [
    ['public', publicInterface],
    ['private', privateInterface],
  ]) {
    if (/CitizenSDKInternal|citizensdk_internal_/.test(swiftInterface)) {
      fail(`${label} ${kind} Swift interface 泄漏构建期私有依赖`);
    }
    if (!/^\/\/ swift-interface-format-version:/m.test(swiftInterface)
        || !/^@_exported import CitizenSDK$/m.test(swiftInterface)) {
      fail(`${label} ${kind} Swift interface 未固定同名 underlying Clang module`);
    }
    const moduleFlags = swiftInterface.match(/^\/\/ swift-module-flags:.*$/gm) ?? [];
    if (moduleFlags.length !== 1
        || !new RegExp(`(?:^| )-target ${contract.swiftTarget.replaceAll('.', '\\.')}(?: |$)`)
          .test(moduleFlags[0])) {
      fail(`${label} ${kind} Swift interface target triple 漂移`);
    }
  }
  const expectedSpi = [
    '  @_spi(CitizenSDKFlutter) final public func supervisedClose() async throws',
    '  @_spi(CitizenSDKFlutter) final public func enqueueForSupervisedClose()',
  ];
  const publicSpi = publicInterface.split('\n').filter((line) => line.includes('@_spi('));
  const privateSpi = privateInterface.split('\n').filter((line) => line.includes('@_spi('));
  if (publicSpi.length !== 0
      || JSON.stringify(privateSpi) !== JSON.stringify(expectedSpi)
      || privateInterface.split('\n').filter((line) => !expectedSpi.includes(line)).join('\n')
        !== publicInterface) {
    fail(`${label} public/private Swift interface 或 CitizenSDKFlutter SPI 闭集漂移`);
  }
  if (/\b(?:CitizenSDKNative|CitizenSdkNativeResult|CitizenSDKPreparedWallet|CitizenSDKHandle|CitizenSDKSecretVault)\b/.test(publicInterface)) {
    fail(`${label} public Swift interface 泄漏底层 native/secret/handle 类型`);
  }

  const resourcesRoot = join(contentRoot, 'Resources');
  const expectedResourceEntries = [
    'PrivacyInfo.xcprivacy',
    'chain',
    ...(isMacOS ? ['Info.plist'] : []),
  ].sort();
  if (JSON.stringify(readdirSync(resourcesRoot).sort())
      !== JSON.stringify(expectedResourceEntries)
      || JSON.stringify(readdirSync(join(resourcesRoot, 'chain')).sort())
        !== JSON.stringify(['chainspec.json', 'light_sync_state.json', 'manifest.json'])) {
    fail(`${label} Resources 目录闭集漂移`);
  }
  const resources = regularFiles(resourcesRoot);
  const expectedResources = [
    ...Object.keys(APPLE_RESOURCE_FILES),
    ...(isMacOS ? ['Info.plist'] : []),
  ].sort();
  if (JSON.stringify(resources) !== JSON.stringify(expectedResources)) {
    fail(`${label} Resources 闭集漂移`);
  }
  for (const [resource, source] of Object.entries(APPLE_RESOURCE_FILES)) {
    if (!readFileSync(join(resourcesRoot, ...resource.split('/'))).equals(
      readFileSync(join(candidate, ...source.split('/'))),
    )) {
      fail(`${label} Resource 与唯一来源字节不一致：${resource}`);
    }
  }

  const frameworkInfo = parseXmlPlist(
    readFileSync(isMacOS
      ? join(resourcesRoot, 'Info.plist')
      : join(framework, 'Info.plist')),
    `${label} Info.plist`,
  );
  const sdkVersion = readFileSync(join(candidate, 'pubspec.yaml'), 'utf8')
    .match(/^version: (\d+\.\d{1,2}\.\d{1,2})$/m)?.[1];
  const expectedInfoKeys = [
    'CFBundleDevelopmentRegion',
    'CFBundleExecutable',
    'CFBundleIdentifier',
    'CFBundleInfoDictionaryVersion',
    'CFBundleName',
    'CFBundlePackageType',
    'CFBundleShortVersionString',
    'CFBundleSupportedPlatforms',
    'CFBundleVersion',
    'DTPlatformName',
    contract.minimumKey,
  ].sort();
  if (!sdkVersion
      || JSON.stringify(Object.keys(frameworkInfo).sort()) !== JSON.stringify(expectedInfoKeys)
      || frameworkInfo.CFBundleDevelopmentRegion !== 'en'
      || frameworkInfo.CFBundleExecutable !== 'CitizenSDK'
      || frameworkInfo.CFBundleIdentifier !== 'org.citizen.sdk'
      || frameworkInfo.CFBundleInfoDictionaryVersion !== '6.0'
      || frameworkInfo.CFBundleName !== 'CitizenSDK'
      || frameworkInfo.CFBundlePackageType !== 'FMWK'
      || frameworkInfo.CFBundleShortVersionString !== sdkVersion
      || frameworkInfo.CFBundleVersion !== sdkVersion
      || JSON.stringify(frameworkInfo.CFBundleSupportedPlatforms)
        !== JSON.stringify([contract.bundlePlatform])
      || frameworkInfo.DTPlatformName !== contract.dtPlatform
      || frameworkInfo[contract.minimumKey] !== contract.minimum.replace(/\.0$/, '')) {
    fail(`${label} framework Info.plist 身份漂移`);
  }
}

/** Verify one Apple product whose public platforms are exactly iOS and macOS. */
export function assertAppleReleaseProjection(root) {
  const candidate = resolve(root);
  const xcframework = join(candidate, ...APPLE_XCFRAMEWORK_PATH.split('/'));
  if (!existsSync(xcframework) || lstatSync(xcframework).isSymbolicLink()
      || !lstatSync(xcframework).isDirectory()) {
    fail('CitizenSDK 候选缺少普通 CitizenSDK.xcframework');
  }
  // 全树只允许 macOS framework 的标准五链接；这同时保证两个 iOS slice、
  // XCFramework Info.plist 和所有资源/模块均不存在链接旁路。
  treeEntries(xcframework, appleXcframeworkSymlinkContract(xcframework));
  const info = parseXmlPlist(
    readFileSync(join(xcframework, 'Info.plist')),
    'CitizenSDK.xcframework Info.plist',
  );
  if (JSON.stringify(Object.keys(info).sort()) !== JSON.stringify([
    'AvailableLibraries',
    'CFBundlePackageType',
    'XCFrameworkFormatVersion',
  ])
      || info.CFBundlePackageType !== 'XFWK'
      || info.XCFrameworkFormatVersion !== '1.0'
      || !Array.isArray(info.AvailableLibraries)
      || info.AvailableLibraries.length !== APPLE_SLICES.length) {
    fail('CitizenSDK.xcframework Info.plist 格式或 slice 数量无效');
  }
  const identifiers = new Set();
  const libraries = new Map();
  for (const library of info.AvailableLibraries) {
    if (!library || Array.isArray(library) || typeof library !== 'object'
        || typeof library.LibraryIdentifier !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(library.LibraryIdentifier)
        || identifiers.has(library.LibraryIdentifier)) {
      fail('CitizenSDK.xcframework LibraryIdentifier 无效或重复');
    }
    identifiers.add(library.LibraryIdentifier);
    const identity = `${library.SupportedPlatform}/${library.SupportedPlatformVariant ?? ''}`;
    if (libraries.has(identity)) fail(`CitizenSDK.xcframework 技术变体重复：${identity}`);
    libraries.set(identity, library);
  }
  const resolvedSlices = [];
  for (const contract of APPLE_SLICES) {
    const identity = `${contract.supportedPlatform}/${contract.variant ?? ''}`;
    const library = libraries.get(identity);
    const identifier = library?.LibraryIdentifier;
    if (!library
        || library.BinaryPath !== contract.binaryPath
        || library.LibraryPath !== 'CitizenSDK.framework'
        || JSON.stringify(library.SupportedArchitectures) !== JSON.stringify(['arm64'])
        || library.SupportedPlatform !== contract.supportedPlatform
        || (library.SupportedPlatformVariant ?? null) !== contract.variant) {
      fail(`${contract.label} XCFramework slice 元数据漂移`);
    }
    const expectedKeys = [
      'BinaryPath',
      'LibraryIdentifier',
      'LibraryPath',
      'SupportedArchitectures',
      'SupportedPlatform',
      ...(contract.variant === null ? [] : ['SupportedPlatformVariant']),
    ].sort();
    if (JSON.stringify(Object.keys(library).sort()) !== JSON.stringify(expectedKeys)) {
      fail(`${contract.label} XCFramework slice 字段闭集漂移`);
    }
    resolvedSlices.push({ contract, identifier });
  }
  const expectedEntries = [
    'Info.plist',
    ...resolvedSlices.map(({ identifier }) => identifier),
  ].sort();
  const entries = readdirSync(xcframework).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    fail(`CitizenSDK.xcframework 三 slice 闭集漂移：${entries.join(',') || '无'}`);
  }
  for (const { contract, identifier } of resolvedSlices) {
    assertAppleFrameworkSlice(candidate, xcframework, identifier, contract);
  }
}

export function assertNoSecrets(root) {
  const forbiddenName = /(^|\/)(\.env(?:\.|$)|\.dev\.vars(?:\.|$)|.*\.(?:jks|keystore|p8|p12|pem))$/i;
  // 分段构造使扫描器源码本身不携带完整 PEM 标记，同时仍逐字节检查候选内容。
  const privateMaterial = Buffer.from(['PRIVATE', ' KEY-----'].join(''));
  for (const relativePath of releaseCandidateEntries(root).files) {
    if (forbiddenName.test(relativePath)) fail(`SDK 候选包含禁止的本地或密钥文件：${relativePath}`);
    if (readFileSync(join(root, ...relativePath.split('/'))).includes(privateMaterial)) {
      fail(`SDK 候选疑似包含私钥材料：${relativePath}`);
    }
  }
}

function fileEntries(root, paths) {
  return paths.map((path) => ({ path, sha256: sha256File(join(root, ...path.split('/'))) }));
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length >= length) fail('CitizenSDK 归档字段超过 tar 限制');
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function writeUstarPath(header, relativePath) {
  if (Buffer.byteLength(relativePath) <= 100) {
    header.write(relativePath, 0, 100, 'utf8');
    return;
  }
  const separators = [...relativePath.matchAll(/\//g)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const separator = separators[index];
    const prefix = relativePath.slice(0, separator);
    const name = relativePath.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      header.write(name, 0, 100, 'utf8');
      header.write(prefix, 345, 155, 'utf8');
      return;
    }
  }
  fail(`CitizenSDK 归档路径超过 ustar 限制：${relativePath}`);
}

function deterministicTar(candidatePath, excludedPaths = new Set()) {
  const chunks = [];
  const candidateEntries = releaseCandidateEntries(candidatePath);
  const entries = [
    ...candidateEntries.files.map((path) => ({ path, type: 'file' })),
    ...candidateEntries.symlinks.map((path) => ({
      path,
      target: appleXcframeworkSymlinkContract(
        join(candidatePath, ...APPLE_XCFRAMEWORK_PATH.split('/')),
        APPLE_XCFRAMEWORK_PATH,
      )[path],
      type: 'symlink',
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of entries) {
    const relativePath = entry.path;
    if (excludedPaths.has(relativePath)) continue;
    const path = join(candidatePath, ...relativePath.split('/'));
    const content = entry.type === 'file' ? readFileSync(path) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    writeUstarPath(header, relativePath);
    writeOctal(
      header,
      100,
      8,
      entry.type === 'symlink'
        ? 0o777
        : ((lstatSync(path).mode & 0o111) === 0 ? 0o600 : 0o700),
    );
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, content.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type === 'symlink' ? '2' : '0').charCodeAt(0);
    if (entry.type === 'symlink') {
      if (Buffer.byteLength(entry.target) > 100) {
        fail(`CitizenSDK 归档链接目标超过 ustar 限制：${relativePath}`);
      }
      header.write(entry.target, 157, 100, 'utf8');
    }
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function verifyCandidatePayload(candidatePath, expectedGitSha = null, expectExternalSums = false) {
  const candidate = assertSafeTargetPath(candidatePath, '候选目录');
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isDirectory()) {
    fail('CitizenSDK 候选目录不存在或不是普通目录');
  }
  const manifestPath = join(candidate, 'citizensdk-release.json');
  const sumsPath = join(candidate, 'SHA256SUMS');
  if (!existsSync(manifestPath) || (expectExternalSums && !existsSync(sumsPath))) {
    fail('CitizenSDK 候选缺少正式清单');
  }
  assertSmoldotDartSource(candidate);
  assertSmoldotLocks(candidate);
  assertSdkRootLocks(candidate);
  assertProviderLockParity(candidate);
  assertCoreRustSource(candidate);
  assertSmoldotRustSource(candidate);
  assertSignerSource(candidate);
  assertPublicAbiHeaders(candidate);
  assertMobileBindingSource(candidate, { allowAppleReleaseProjection: true, flutterPackage: true });
  assertLinuxBindingSource(candidate, { allowInjectedLinuxArtifacts: true });
  assertWindowsBindingSource(candidate, { allowInjectedWindowsArtifacts: true });
  assertFlutterBindingContract(candidate);
  assertChainAssets(candidate);
  assertSourceFixtures(candidate);
  assertLicenseSources(candidate);
  assertDocumentationSource(candidate, { allowAppleReleaseProjection: true });
  const hostedSoftwareVersion = assertHostedPackageSource(candidate, {
    allowInjectedLinuxArtifacts: true, allowInjectedWindowsArtifacts: true,
  });
  assertSdkTestContracts(candidate);
  assertSdkScriptSource(candidate);
  assertAndroidReleaseProjection(candidate);
  assertAppleReleaseProjection(candidate);
  assertLinuxReleaseProjection(candidate);
  assertWindowsReleaseProjection(candidate);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const keys = Object.keys(manifest).sort();
  const expectedKeys = ['files', 'git_commit_sha', 'package_name', 'platforms', 'product_id', 'software_version'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) fail('CitizenSDK 正式清单字段集合不正确');
  if (manifest.product_id !== PRODUCT_ID || manifest.package_name !== PACKAGE_NAME) fail('CitizenSDK 候选产品身份不正确');
  if (!/^\d+\.\d{1,2}\.\d{1,2}$/.test(manifest.software_version)) fail('CitizenSDK 候选版本无效');
  if (manifest.software_version !== hostedSoftwareVersion) fail('CitizenSDK 候选 manifest 与包版本不一致');
  if (!/^[0-9a-f]{40}$/.test(manifest.git_commit_sha)) fail('CitizenSDK 候选 Git SHA 无效');
  if (expectedGitSha !== null && manifest.git_commit_sha !== expectedGitSha) fail('CitizenSDK 候选 Git SHA 不匹配');
  const dependencyEvidence = JSON.parse(readFileSync(nativeArtifactSource(candidate, 'native-dependencies.json'), 'utf8'));
  dependencyCheck(Array.isArray(dependencyEvidence) && dependencyEvidence.length === 3, '候选依赖平台证据不完整');
  for (const [index, platform] of NATIVE_DEPENDENCY_PLATFORMS.entries()) {
    assertCitizenSdkDependencyEvidence(dependencyEvidence[index], platform, candidate, 'candidate', candidate,
      manifest.git_commit_sha, manifest.software_version);
  }
  dependencyCheck(new Set(dependencyEvidence.map((item) => item.dependency_inputs.build_mode)).size === 1,
    '候选混用了 CI 与 Release 输入');
  const expectedPlatforms = RELEASE_PLATFORMS;
  if (stableJson(manifest.platforms) !== stableJson(expectedPlatforms)) fail('CitizenSDK 候选平台集合不正确');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('CitizenSDK 候选文件清单为空');
  const paths = [];
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'path,sha256'
        || typeof entry.path !== 'string' || entry.path.startsWith('/')
        || entry.path.split('/').includes('..') || !/^[A-Za-z0-9._/-]+$/.test(entry.path)
        || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail('CitizenSDK 候选文件条目无效');
    }
    const path = join(candidate, ...entry.path.split('/'));
    if (!path.startsWith(`${candidate}${sep}`)) fail('CitizenSDK 候选文件路径越界');
    if (!existsSync(path) || !lstatSync(path).isFile() || sha256File(path) !== entry.sha256) {
      fail(`CitizenSDK 候选文件哈希不一致：${entry.path}`);
    }
    paths.push(entry.path);
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length) {
    fail('CitizenSDK 候选文件顺序或唯一性无效');
  }
  for (const required of [
    'native-dependencies.json',
    '.pubignore',
    'LICENSE',
    'pubspec.yaml',
    ...Object.keys(NATIVE_FILES),
    `${APPLE_XCFRAMEWORK_PATH}/Info.plist`,
    ...LINUX_RELEASE_FILES.map((path) => `linux/${path}`),
    ...WINDOWS_RELEASE_FILES.map((path) => `windows/${path}`),
  ]) {
    if (!paths.includes(required)) fail(`CitizenSDK 候选缺少必需文件：${required}`);
  }
  const expectedFiles = [
    ...paths,
    'citizensdk-release.json',
    ...(expectExternalSums ? ['SHA256SUMS'] : []),
  ].sort();
  if (JSON.stringify(releaseCandidateEntries(candidate).files)
      !== JSON.stringify(expectedFiles)) {
    fail('CitizenSDK 候选包含未登记文件');
  }
  assertNoSecrets(candidate);
  return { candidate, manifest, manifestPath, sumsPath };
}

/// 反向核验最终 gzip/tar 字节、外层下载校验和与候选闭集。
///
/// `SHA256SUMS` 是 GitHub Release 的外部资产，不进入 tgz，从而可以覆盖 tgz
/// 自身而不存在循环哈希。归档必须逐字节等于本打包器从候选重建出的规范 gzip。
export function verifyCitizenSdkRelease(candidatePath, archivePath, expectedGitSha = null) {
  const verified = verifyCandidatePayload(candidatePath, expectedGitSha, true);
  const archive = assertSafeTargetPath(archivePath, '归档');
  if (!existsSync(archive) || lstatSync(archive).isSymbolicLink() || !lstatSync(archive).isFile()) {
    fail('CitizenSDK 归档不存在或不是普通文件');
  }
  const expectedArchive = gzipSync(
    deterministicTar(verified.candidate, new Set(['SHA256SUMS'])),
    { level: 9, mtime: 0 },
  );
  if (!readFileSync(archive).equals(expectedArchive)) {
    fail('CitizenSDK 归档不是候选闭集的规范 gzip/tar 字节');
  }
  const checksums = [
    { path: 'citizensdk-release.json', sha256: sha256File(verified.manifestPath) },
    { path: 'citizensdk.tgz', sha256: sha256File(archive) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const expectedSums = `${checksums.map(({ sha256, path }) => `${sha256}  ${path}`).join('\n')}\n`;
  if (readFileSync(verified.sumsPath, 'utf8') !== expectedSums) {
    fail('CitizenSDK 外层 SHA256SUMS 不一致');
  }
  return verified.manifest;
}

export function buildCitizenSdkRelease({ sourcePath, nativePath, outputPath, archivePath, gitCommitSha, softwareVersion }) {
  const source = resolve(sourcePath);
  const native = assertSafeTargetPath(nativePath, '原生产物目录');
  const output = assertSafeTargetPath(outputPath, '候选目录');
  const archive = assertSafeTargetPath(archivePath, '归档');
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail('CitizenSDK 源码目录不存在');
  if (!existsSync(native) || !lstatSync(native).isDirectory()) fail('CitizenSDK 原生产物目录不存在');
  assertSmoldotDartSource(source);
  assertSmoldotLocks(source);
  assertSdkRootLocks(source);
  assertProviderLockParity(source);
  assertCoreRustSource(source);
  assertSmoldotRustSource(source);
  assertSignerSource(source);
  assertPublicAbiHeaders(source);
  assertMobileBindingSource(source);
  assertLinuxBindingSource(source);
  assertWindowsBindingSource(source);
  assertFlutterBindingContract(source);
  assertChainAssets(source);
  assertSourceFixtures(source);
  assertLicenseSources(source);
  assertDocumentationSource(source);
  const sourceSoftwareVersion = assertHostedPackageSource(source);
  assertSdkTestContracts(source);
  assertSdkScriptSource(source);
  if (!/^[0-9a-f]{40}$/.test(gitCommitSha)) fail('Git commit SHA 必须是 40 位小写十六进制');
  if (!/^\d+\.\d{1,2}\.\d{1,2}$/.test(softwareVersion)) fail('CitizenSDK 软件版本无效');
  if (softwareVersion !== sourceSoftwareVersion) {
    fail(`CitizenSDK 发布版本必须与源码一致：源码=${sourceSoftwareVersion}；请求=${softwareVersion}`);
  }
  assertLocalTarget(native, '原生产物目录');
  assertLocalTarget(output, '候选目录');
  assertLocalTarget(archive, '归档');
  assertOutsideSource(source, native, '原生产物目录');
  assertOutsideSource(source, archive, '归档');
  assertOutsideSource(native, output, '候选目录');
  assertOutsideSource(output, archive, '归档');
  if (existsSync(archive)) fail(`归档已存在，拒绝覆盖：${archive}`);
  // Validate both full native prefixes and every shared/source byte before
  // creating a candidate. Missing or mixed Linux input must not publish output.
  const nativeSources = assertNativeArtifactSources(native);
  for (const [platform, prefix] of Object.entries(nativeSources.linux)) {
    assertLinuxInstalledPlatform(source, prefix, platform);
  }
  assertWindowsNativeArtifact(source, nativeSources.windows);
  // 来源缺件/混版必须在首次创建候选前失败，不留下貌似完整的半成品。
  const dependencyEvidence = collectDependencyEvidence(native, source, gitCommitSha, softwareVersion);
  dependencyCheck(new Set(dependencyEvidence.map((item) => item.dependency_inputs.build_mode)).size === 1,
    '候选混用了 CI 与 Release 输入');
  ensureNewDirectory(output, source, '候选目录');
  for (const path of ROOT_FILES) copySourceTree(source, output, path);
  for (const path of ROOT_DIRECTORIES) copySourceTree(source, output, path);
  applySoftwareVersion(output, softwareVersion);
  copyNativeFiles(native, output, source);
  writeFileSync(join(output, 'native-dependencies.json'),
    prettyStableJson(dependencyEvidence),
    { flag: 'wx', mode: 0o600 });
  const payloadPaths = releaseCandidateEntries(output).files;
  const manifest = {
    product_id: PRODUCT_ID,
    package_name: PACKAGE_NAME,
    software_version: softwareVersion,
    git_commit_sha: gitCommitSha,
    platforms: [...RELEASE_PLATFORMS],
    files: fileEntries(output, payloadPaths),
  };
  const manifestPath = join(output, 'citizensdk-release.json');
  writeFileSync(manifestPath, prettyStableJson(manifest), { mode: 0o600 });
  verifyCandidatePayload(output, gitCommitSha);
  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  writeFileSync(
    archive,
    gzipSync(deterministicTar(output), { level: 9, mtime: 0 }),
    { mode: 0o600 },
  );
  const checksums = [
    { path: 'citizensdk-release.json', sha256: sha256File(manifestPath) },
    { path: 'citizensdk.tgz', sha256: sha256File(archive) },
  ].sort((left, right) => left.path.localeCompare(right.path));
  writeFileSync(join(output, 'SHA256SUMS'), `${checksums.map(({ sha256, path }) => `${sha256}  ${path}`).join('\n')}\n`, { mode: 0o600 });
  verifyCitizenSdkRelease(output, archive, gitCommitSha);
  return manifest;
}

// 本步只固定 Pub 官方打包行为，不增加发布账号、上传协议或另一套产品版本。
const HOSTED_DART_VERSION = '3.12.2';

/** 完整候选的 Hosted 投影；只能从已经验真的审计候选取得预期，不能从待验归档反推。 */
export function hostedPackageEntries(candidatePath) {
  const candidate = assertSafeTargetPath(candidatePath, 'Hosted 来源');
  const rootEntries = [...ROOT_FILES, ...ROOT_DIRECTORIES, 'native-dependencies.json', 'citizensdk-release.json', 'SHA256SUMS'].sort();
  if (JSON.stringify(readdirSync(candidate).sort()) !== JSON.stringify(rootEntries)) {
    fail('CitizenSDK Hosted 来源根闭集漂移');
  }
  // 先检查全树的五个准入链接；展开后的间接路径也只能解析到该候选内部。
  releaseCandidateEntries(candidate);
  const rules = hostedPubignoreRules(candidate);
  const entries = new Map();
  const names = new Set();
  let size = 0;
  const visit = (directory, depth = 0) => {
    if (depth > 128) fail('CitizenSDK Hosted 来源目录过深');
    for (const name of readdirSync(join(candidate, directory)).sort()) {
      const path = directory ? `${directory}/${name}` : name;
      // Pub 默认排除隐藏输入和 lock；此 SDK 没有任何嵌套 ignore 文件或隐藏运行资产。
      if (name.startsWith('.') || name === 'pubspec.lock' || path === 'pubspec_overrides.yaml') continue;
      const source = join(candidate, path);
      const resolved = realpathSync(source);
      if (!resolved.startsWith(`${candidate}${sep}`)) fail(`CitizenSDK Hosted 来源越界：${path}`);
      const info = statSync(source);
      const directoryEntry = info.isDirectory();
      if (isHostedIgnored(directoryEntry ? `${path}/` : path, rules)) continue;
      if (!directoryEntry && !info.isFile()) fail(`CitizenSDK Hosted 来源类型无效：${path}`);
      const key = path.normalize('NFC').toLowerCase();
      if (names.has(key) || Buffer.byteLength(path) > 4096 || entries.size >= 16384) {
        fail('CitizenSDK Hosted 来源路径冲突或超过上限');
      }
      names.add(key);
      size += directoryEntry ? 0 : info.size;
      if (size > 256 * 1024 * 1024) fail('CitizenSDK Hosted 展开内容超过 256 MiB 安全上限');
      entries.set(path, {
        type: directoryEntry ? 'directory' : 'file',
        mode: directoryEntry ? 0o755 : 0o644 | (info.mode & 0o111),
        data: directoryEntry ? Buffer.alloc(0) : readFileSync(source),
      });
      if (directoryEntry) visit(path, depth + 1);
    }
  };
  visit('');
  // 既有局部合同仍独立成立；这里再覆盖全部包根、法律、资产和平台输入。
  for (const path of ['pubspec.yaml', 'LICENSE', 'LICENSE-GPL-3.0',
    'LICENSE-MIT', ...HOSTED_RUNTIME_DART_FILES]) {
    if (entries.get(path)?.type !== 'file') fail(`CitizenSDK Hosted 缺少必要文件：${path}`);
  }
  return entries;
}

function compareHostedEntries(actual, expected) {
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  const extra = [...actual.keys()].filter((path) => !expected.has(path));
  if (missing.length || extra.length) {
    fail(`CitizenSDK Hosted 完整闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const [path, entry] of expected) {
    const other = actual.get(path);
    if (other.type !== entry.type || other.mode !== entry.mode || !other.data.equals(entry.data)) {
      fail(`CitizenSDK Hosted 类型、权限或字节不一致：${path}`);
    }
  }
}

function removeOwnedDirectory(path, identity) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino !== identity.ino
      || info.dev !== identity.dev || info.uid !== identity.uid) {
    fail('CitizenSDK Hosted 失败目录身份改变，保留现场');
  }
  rmSync(path, { recursive: true });
}

function readHostedArchive(path) {
  assertSafeTargetPath(path, 'Hosted 归档');
  // 非阻塞打开避免 FIFO 在 fstat 类型拒绝前等待写端；普通归档仍按同一 fd 读取。
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 20 || info.size > 100 * 1024 * 1024) {
      fail('CitizenSDK Hosted 归档类型或长度无效');
    }
    // 在读取前限定分配量；增长、截断或替换不能让 readFileSync 先读入无界内容。
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('CitizenSDK Hosted 归档读取期间截断');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0
        || fstatSync(descriptor).mtimeMs !== info.mtimeMs) {
      fail('CitizenSDK Hosted 归档读取期间改变');
    }
    return parseHostedArchive(bytes);
  } finally {
    closeSync(descriptor);
  }
}

/** 全部验证通过才落盘；不执行系统 tar，不覆盖或复用任何既有输出。 */
export function verifyCitizenSdkHosted({
  candidatePath, archivePath, hostedArchivePath, outputPath, expectedGitSha = null,
}) {
  const candidate = assertSafeTargetPath(candidatePath, 'Hosted 来源');
  const audit = assertSafeTargetPath(archivePath, '审计归档');
  const hosted = assertSafeTargetPath(hostedArchivePath, 'Hosted 归档');
  const output = assertLocalTarget(outputPath, 'Hosted 解包');
  for (const input of [candidate, audit, hosted]) {
    assertOutsideSource(input, output, 'Hosted 解包');
    assertOutsideSource(output, input, 'Hosted 输入');
  }
  if (lstatExists(output)) fail('CitizenSDK Hosted 解包目录已存在，拒绝覆盖');
  const manifest = verifyCitizenSdkRelease(candidate, audit, expectedGitSha);
  const expected = hostedPackageEntries(candidate);
  const entries = readHostedArchive(hosted);
  compareHostedEntries(entries, expected);
  // 归档已解析成有界内存值，写入期间不重新读不可信 tar 或跟随其路径。
  ensureNewDirectory(output, candidate, 'Hosted 解包');
  const identity = lstatSync(output);
  try {
    for (const [path, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
      const destination = assertSafeTargetPath(join(output, path), 'Hosted 解包条目');
      if (entry.type === 'directory') mkdirSync(destination, { recursive: true, mode: 0o755 });
      else {
        mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
        writeFileSync(destination, entry.data, { flag: 'wx', mode: entry.mode });
      }
      // 只调整本轮新建节点；调用者的严格 umask 不应改变已验证的 Pub 模式。
      chmodSync(destination, entry.mode);
    }
    const actual = new Map();
    const read = (directory) => {
      for (const name of readdirSync(join(output, directory))) {
        const path = directory ? `${directory}/${name}` : name;
        const file = join(output, path);
        const info = lstatSync(file);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
          fail(`CitizenSDK Hosted 解包含非法节点：${path}`);
        }
        actual.set(path, { type: info.isDirectory() ? 'directory' : 'file', mode: info.mode & 0o777,
          data: info.isDirectory() ? Buffer.alloc(0) : readFileSync(file) });
        if (info.isDirectory()) read(path);
      }
    };
    read('');
    compareHostedEntries(actual, expected);
    verifyCitizenSdkRelease(candidate, audit, expectedGitSha);
    return manifest;
  } catch (error) {
    removeOwnedDirectory(output, identity);
    throw error;
  }
}

function runHostedDart(dart, args, cwd, env, signal) {
  signal?.throwIfAborted();
  // Hosted 归档由既定 macOS 作业执行；没有 POSIX 进程组就不能证明 Dart 后代已退出。
  // 此限制只属于归档工具监督，不限制 Windows SDK 或同步解包/安装验真。
  if (process.platform === 'win32') fail('CitizenSDK Hosted 归档需要 POSIX 进程组监督');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(dart, ['--suppress-analytics', ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true,
    });
    let text = '', bytes = 0, failed = null, settled = false, stopping = false;
    let exited = false, closed = false, code = null, exitSignal = null;
    let timer, escalation, deadline, poll, orphan;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      for (const handle of [timer, escalation, deadline, poll, orphan]) clearTimeout(handle);
      signal?.removeEventListener('abort', abort);
      if (error?.preserveHostedOutput) {
        // 无法确认退出时绝不清理目录；断开管道/引用使监督失败能有界返回。
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      if (error) rejectRun(error); else resolveRun(text);
    };
    const preserve = (cause) => {
      const error = new Error('CitizenSDK Hosted 子进程未确认退出，保留缓存目录', { cause });
      error.preserveHostedOutput = true;
      finish(error);
    };
    const alive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const terminate = (name) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const stop = (error) => {
      if (settled) return;
      failed ||= error;
      if (stopping) return;
      stopping = true;
      try { terminate('SIGTERM'); } catch (cause) { preserve(cause); return; }
      escalation = setTimeout(() => {
        try { if (alive()) terminate('SIGKILL'); } catch (cause) { preserve(cause); }
      }, 5000);
      deadline = setTimeout(() => preserve(failed), 10000);
    };
    const abort = () => stop(new Error('CitizenSDK Hosted 操作已取消', { cause: signal.reason }));
    const inspect = () => {
      clearTimeout(poll);
      if (settled) return;
      try {
        const pending = alive();
        if (closed && !pending) {
          finish(failed || (code !== 0 || exitSignal
            ? new Error(`CitizenSDK Hosted 官方工具失败 (${code ?? exitSignal})：\n${text}`) : null));
          return;
        }
        // exit 不等于 close：后代可能仍持有管道。不能只在 close 中检查进程组。
        if (exited && !stopping && !orphan) {
          orphan = setTimeout(() => stop(new Error('CitizenSDK Hosted 官方工具遗留子进程或管道')), 200);
        }
        poll = setTimeout(inspect, 50);
      } catch (cause) { preserve(cause); }
    };
    timer = setTimeout(() => stop(new Error('CitizenSDK Hosted 官方工具超时')), 120000);
    const collect = (chunk) => {
      if (settled || stopping) return;
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop(new Error('CitizenSDK Hosted 官方工具输出超过上限'));
      else text += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdout.on('error', stop); child.stderr.on('error', stop);
    child.on('error', (error) => { stop(error); });
    child.on('exit', (value, name) => {
      exited = true; code = value; exitSignal = name; inspect();
    });
    child.on('close', (value, name) => {
      closed = true; exited = true; code = value; exitSignal = name; inspect();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** 只调用固定 Pub 的本地归档分支，绝不提供上传、跳过校验或自选参数入口。 */
export async function buildCitizenSdkHosted({
  candidatePath, archivePath, outputPath, dartPath, flutterRoot, pubCachePath, expectedGitSha = null,
  signal,
}) {
  signal?.throwIfAborted();
  if (process.platform === 'win32') fail('CitizenSDK Hosted 归档需要 POSIX 进程组监督');
  const candidate = assertSafeTargetPath(candidatePath, 'Hosted 来源');
  const audit = assertSafeTargetPath(archivePath, '审计归档');
  const output = assertLocalTarget(outputPath, 'Hosted 缓存目录');
  const dart = assertSafeTargetPath(dartPath, '官方 Dart');
  const flutter = assertSafeTargetPath(flutterRoot, 'Flutter SDK');
  const cache = assertLocalTarget(pubCachePath, '隔离 Pub cache');
  for (const input of [candidate, audit, dart, flutter, cache]) {
    assertOutsideSource(input, output, 'Hosted 缓存目录');
    assertOutsideSource(output, input, 'Hosted 输入');
  }
  for (const input of [candidate, audit, dart, flutter]) {
    assertOutsideSource(input, cache, '隔离 Pub cache');
    assertOutsideSource(cache, input, 'Hosted 只读输入');
  }
  if (lstatExists(output)) fail('CitizenSDK Hosted 缓存目录已存在，拒绝覆盖');
  if (!lstatExists(dart) || !lstatSync(dart).isFile()
      || !lstatExists(flutter) || !lstatSync(flutter).isDirectory()
      || !lstatExists(cache) || !lstatSync(cache).isDirectory()
      || readFileSync(assertSafeTargetPath(resolve(dirname(dart), '..', 'version'), 'Dart 版本'), 'utf8')
        .trim() !== HOSTED_DART_VERSION) {
    fail('CitizenSDK Hosted 官方工具版本或隔离缓存无效');
  }
  for (const name of ['git', 'git.exe', 'git.cmd']) {
    if (lstatExists(join(dirname(dart), name))) fail('CitizenSDK Hosted 工具 PATH 禁止包含 Git');
  }
  const manifest = verifyCitizenSdkRelease(candidate, audit, expectedGitSha);
  const pubspec = readFileSync(join(candidate, 'pubspec.yaml'), 'utf8');
  if (/^publish_to:/m.test(pubspec) && !/^publish_to: ["']?https:\/\/pub\.dev["']?\s*$/m.test(pubspec)) {
    fail('CitizenSDK Hosted 本地验证仅允许默认官方 HTTPS 服务');
  }
  const expected = hostedPackageEntries(candidate);
  const auditSha = sha256File(audit);
  const manifestSha = sha256File(join(candidate, 'citizensdk-release.json'));
  ensureNewDirectory(output, candidate, 'Hosted 缓存目录');
  const identity = lstatSync(output);
  try {
    const input = join(output, 'input');
    cpSync(candidate, input, { recursive: true, dereference: false, verbatimSymlinks: true,
      force: false, errorOnExist: true });
    const temporary = join(output, 'tmp');
    mkdirSync(temporary, { mode: 0o700 });
    // 不传用户 HOME/APPDATA/XDG、令牌或任意继承环境；Pub 的 token store 因无配置根为空。
    // PATH 仅含正式 Dart bin，Git 探测无法执行；analyze 子进程同样关闭遥测。
    const env = { PATH: dirname(dart), FLUTTER_ROOT: flutter, PUB_CACHE: cache, TMPDIR: temporary,
      TEMP: temporary, TMP: temporary, LANG: 'C.UTF-8', DASH__SUPPRESS_ANALYTICS: 'true', CI: 'true' };
    const version = await runHostedDart(dart, ['--version'], input, env, signal);
    signal?.throwIfAborted();
    if (!version.startsWith(`Dart SDK version: ${HOSTED_DART_VERSION} `)) {
      fail('CitizenSDK Hosted Dart 实际版本漂移');
    }
    const preview = await runHostedDart(dart, ['pub', 'publish', '--dry-run'], input, env, signal);
    signal?.throwIfAborted();
    if (!/Package has 0 warnings(?: and \d+ hints?)?\./u.test(preview)) {
      fail(`CitizenSDK Hosted dry-run 未明确报告零 warnings：\n${preview}`);
    }
    // dry-run 会提前返回，必须独立运行 --to-archive；官方实现不会进入上传分支。
    const hosted = join(output, `${PACKAGE_NAME}-${manifest.software_version}.tar.gz`);
    const generated = await runHostedDart(dart, ['pub', 'publish', `--to-archive=${hosted}`], input, env, signal);
    signal?.throwIfAborted();
    if (!generated.includes(`Wrote package archive at ${hosted}`)) {
      fail('CitizenSDK Hosted 官方工具未确认归档生成');
    }
    const log = `${version}\n${preview}\n${generated}`;
    writeFileSync(join(output, 'pub.log'), log, { flag: 'wx', mode: 0o600 });
    // Pub 可在隔离副本生成 lock/.dart_tool，但全部可发布输入必须与原候选一致。
    compareHostedEntries(readHostedArchive(hosted), expected);
    const result = verifyCitizenSdkHosted({ candidatePath: candidate, archivePath: audit,
      hostedArchivePath: hosted, outputPath: join(output, 'package'), expectedGitSha });
    if (sha256File(audit) !== auditSha || sha256File(join(candidate, 'citizensdk-release.json')) !== manifestSha) {
      fail('CitizenSDK Hosted 打包改动了审计输入');
    }
    return result;
  } catch (error) {
    if (!error?.preserveHostedOutput) removeOwnedDirectory(output, identity);
    else error.message += `：${output}`;
    throw error;
  }
}

/**
 * 仅解析 Hosted 官方归档；完整验证后由调用方写盘，不执行 tar 或跟随链接。
 * 这些资源上限是本地安全边界，不表示 Hosted 服务端一定接收同样大小的包。
 */
export function parseHostedArchive(bytes) {
  const reject = (reason) => fail(`CitizenSDK Hosted 归档无效：${reason}`);
  const compressedLimit = 100 * 1024 * 1024;
  const expandedLimit = 256 * 1024 * 1024;
  const pathLimit = 4096;
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.length > compressedLimit) {
    reject('gzip 长度越界');
  }
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < crcTable.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }
  const crc32 = (data) => {
    let value = 0xffffffff;
    for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3] & 0xe0)) {
    reject('gzip 头或保留标志错误');
  }
  const flags = bytes[3];
  let compressedStart = 10;
  const requireHeader = (length) => {
    if (compressedStart + length > bytes.length - 8 || compressedStart + length > 65536) {
      reject('gzip 附加头截断或过长');
    }
  };
  if (flags & 4) {
    requireHeader(2);
    const length = bytes.readUInt16LE(compressedStart);
    compressedStart += 2;
    requireHeader(length);
    compressedStart += length;
  }
  for (const flag of [8, 16]) {
    if (!(flags & flag)) continue;
    const end = bytes.indexOf(0, compressedStart);
    if (end < compressedStart || end - compressedStart > pathLimit) {
      reject('gzip 名称或注释未终止或过长');
    }
    requireHeader(end - compressedStart + 1);
    compressedStart = end + 1;
  }
  if (flags & 2) {
    requireHeader(2);
    if (bytes.readUInt16LE(compressedStart) !== (crc32(bytes.subarray(0, compressedStart)) & 0xffff)) {
      reject('gzip 头 CRC 错误');
    }
    compressedStart += 2;
  }
  if (compressedStart >= bytes.length - 8 || bytes.readUInt32LE(bytes.length - 4) > expandedLimit) {
    reject('gzip 正文截断或展开长度越界');
  }
  let inflated;
  try {
    inflated = inflateRawSync(bytes.subarray(compressedStart, bytes.length - 8), {
      info: true,
      maxOutputLength: expandedLimit,
    });
  } catch {
    reject('DEFLATE 损坏、截断或超过展开上限');
  }
  // 原始 DEFLATE 报告实际消费长度，不能把第二个 member 或尾随数据吞掉。
  const tar = inflated.buffer;
  if (compressedStart + inflated.engine.bytesWritten + 8 !== bytes.length
      || tar.length !== bytes.readUInt32LE(bytes.length - 4)
      || crc32(tar) !== bytes.readUInt32LE(bytes.length - 8)) {
    reject('gzip member、CRC 或 ISIZE 不一致');
  }
  if (tar.length < 1024 || tar.length % 512 !== 0) reject('tar 长度或结束块不完整');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decode = (data) => {
    try { return decoder.decode(data); } catch { reject('tar 路径不是有效 UTF-8'); }
  };
  const empty = (data) => data.every((byte) => byte === 0);
  const stringBytes = (header, offset, length) => {
    const field = header.subarray(offset, offset + length);
    const end = field.indexOf(0);
    if (end < 0) return field;
    if (!empty(field.subarray(end))) reject('tar 字符串终止符后含数据');
    return field.subarray(0, end);
  };
  const octal = (header, offset, length) => {
    const field = header.subarray(offset, offset + length);
    if (!field.every((byte) => byte === 0 || byte === 32 || (byte >= 48 && byte <= 55))) {
      reject('tar 数值字段不是八进制');
    }
    const text = field.toString('ascii');
    if (!/^[ \0]*[0-7]+[ \0]*$/.test(text)) reject('tar 数值字段为空或嵌入分隔符');
    const value = Number.parseInt(text.replace(/^[ \0]+|[ \0]+$/g, ''), 8);
    if (!Number.isSafeInteger(value)) reject('tar 数值溢出');
    return value;
  };
  const safePath = (name, directory) => {
    if (directory && name.endsWith('/')) name = name.slice(0, -1);
    const parts = name.split('/');
    if (!name || Buffer.byteLength(name) > pathLimit
        || /[\x00-\x1f\x7f\\:*?"<>|]/.test(name)
        || parts.some((part) => !part || part === '.' || part === '..'
          || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      reject('tar 路径越界或存在跨平台歧义');
    }
    return name;
  };
  const entries = new Map();
  const paths = new Map();
  let pathCount = 0;
  let pendingName = null;
  let offset = 0;
  let count = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (empty(header)) {
      // 固定官方 writer 恰好输出两个零块，不接受结束后的记录或隐蔽附加数据。
      if (pendingName !== null || offset + 1024 !== tar.length || !empty(tar.subarray(offset))) {
        reject('tar 结束块、悬空长文件名或尾随数据错误');
      }
      return entries;
    }
    count += 1;
    if (count > 16384) reject('tar 条目数超过上限');
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (checksum !== octal(header, 148, 8)) reject('tar 头校验和错误');
    // package:tar 2.0.0 把 version 写为 "0 "，普通 USTAR 则写为 "00"。
    if (!header.subarray(257, 263).equals(Buffer.from('ustar\0'))
        || !['0 ', '00'].includes(header.subarray(263, 265).toString('ascii'))
        || !empty(header.subarray(500)) || !empty(header.subarray(157, 257))
        || !empty(header.subarray(329, 345))) {
      reject('tar 格式、链接或扩展字段不符合合同');
    }
    const mode = octal(header, 100, 8);
    const size = octal(header, 124, 12);
    const userId = octal(header, 108, 8);
    const groupId = octal(header, 116, 8);
    const modified = octal(header, 136, 12);
    if (mode > 0o777 || size > expandedLimit) reject('tar 权限或文件长度越界');
    const user = stringBytes(header, 265, 32);
    const group = stringBytes(header, 297, 32);
    decode(user);
    decode(group);
    const shortName = stringBytes(header, 0, 100);
    const prefix = stringBytes(header, 345, 155);
    const type = header[156];
    if (![48, 53, 76].includes(type)) reject('tar 含非普通文件、目录或官方长文件名记录');
    const start = offset + 512;
    const end = start + size;
    const paddedEnd = start + Math.ceil(size / 512) * 512;
    if (paddedEnd > tar.length || !empty(tar.subarray(end, paddedEnd))) {
      reject('tar 正文截断或补齐区含数据');
    }
    const data = tar.subarray(start, end);
    offset = paddedEnd;
    if (type === 76) {
      // 官方 GNU L 正文没有末尾 NUL；后继短名只取前 99 字节，可能截断多字节字符。
      if (pendingName !== null || decode(shortName) !== '././@LongLink'
          || prefix.length || mode || userId || groupId || modified || user.length || group.length
          || size <= 99 || size > pathLimit) reject('GNU 长文件名记录不符合官方格式');
      safePath(decode(data), true);
      pendingName = data;
      continue;
    }
    let name;
    if (pendingName !== null) {
      if (prefix.length || !shortName.equals(pendingName.subarray(0, 99))) {
        reject('GNU 长文件名与后继短名不一致');
      }
      name = decode(pendingName);
      pendingName = null;
    } else {
      name = `${prefix.length ? `${decode(prefix)}/` : ''}${decode(shortName)}`;
    }
    const directory = type === 53;
    if (directory && size !== 0) reject('tar 目录携带正文');
    name = safePath(name, directory);
    if (entries.has(name)) reject('tar 目标重复');
    const parts = name.split('/');
    let children = paths;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const key = part.normalize('NFC').toLowerCase();
      const pathType = index < parts.length - 1 || directory ? 'directory' : 'file';
      let node = children.get(key);
      if (node && node.name !== part) reject('tar 大小写或 Unicode 目标冲突');
      if (node && node.type !== pathType) reject('tar 父子路径类型冲突');
      if (!node) {
        // 隐含父目录同样占用解包资源；树结构避免深路径的平方级前缀复制。
        pathCount += 1;
        if (pathCount > 16384) reject('tar 文件及隐含目录数超过上限');
        node = { name: part, type: pathType, children: new Map() };
        children.set(key, node);
      }
      children = node.children;
    }
    // 用视图避免给已受上限约束的正文再做整包复制，返回值始终只包含文件和目录。
    entries.set(name, { type: directory ? 'directory' : 'file', mode, data });
  }
  reject('tar 缺少两个结束零块');
}

function parseArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (typeof key !== 'string' || !/^--[a-z-]+$/u.test(key)
        || typeof value !== 'string' || !value || value.startsWith('--')
        || Object.hasOwn(values, key.slice(2))) fail(`参数格式无效或重复：${key || ''}`);
    values[key.slice(2)] = value;
  }
  return values;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const values = parseArguments(process.argv.slice(2));
    if (values['native-source-view']) {
      if (Object.keys(values).sort().join(',') !== 'native-source-view,output') fail('原生工程参数闭集无效');
      process.stdout.write(createNativeSourceView(values['native-source-view'], values.output) + '\n');
    } else if (values['flutter-source-view'] || values['flutter-source-entry']) {
      const command = values['flutter-source-view'] ? 'flutter-source-view' : 'flutter-source-entry';
      if (Object.keys(values).sort().join(',') !== [command, 'output'].sort().join(',')) {
        fail('CitizenSDK Flutter消费参数闭集无效');
      }
      if (command === 'flutter-source-view') createFlutterSourceView(values[command], values.output);
      else projectFlutterSourceEntry(values[command], values.output);
      process.stdout.write(`${values.output}\n`);
    } else if (values.hosted || values['verify-hosted']) {
      const build = Boolean(values.hosted);
      const allowed = build
        ? ['hosted', 'archive', 'output', 'dart', 'flutter', 'pub-cache', 'expected-git-sha']
        : ['verify-hosted', 'archive', 'hosted-archive', 'output', 'expected-git-sha'];
      if (Object.keys(values).some((key) => !allowed.includes(key))) {
        fail('CitizenSDK Hosted 参数包含未允许的选项');
      }
      for (const key of allowed.filter((key) => key !== 'expected-git-sha')) {
        if (!values[key]) fail(`CitizenSDK Hosted 缺少参数 --${key}`);
      }
      const options = { candidatePath: values.hosted || values['verify-hosted'],
        archivePath: values.archive, outputPath: values.output,
        expectedGitSha: values['expected-git-sha'] || null };
      let manifest;
      if (build) {
        // CLI 只转交标准 AbortSignal；内部拥有 Dart 组与目录，外层不得先杀监督器。
        const controller = new AbortController();
        const interrupt = () => { process.exitCode ||= 130; controller.abort(); };
        const stop = () => { process.exitCode ||= 143; controller.abort(); };
        process.on('SIGINT', interrupt); process.on('SIGTERM', stop);
        try {
          manifest = await buildCitizenSdkHosted({ ...options, dartPath: values.dart,
            flutterRoot: values.flutter, pubCachePath: values['pub-cache'], signal: controller.signal });
        } finally {
          process.off('SIGINT', interrupt); process.off('SIGTERM', stop);
        }
      } else manifest = verifyCitizenSdkHosted({ ...options, hostedArchivePath: values['hosted-archive'] });
      process.stdout.write(`CitizenSDK Hosted 本地归档验真通过：${manifest.software_version}\n`);
    } else if (values.verify) {
      if (!values.archive) fail('候选校验缺少参数 --archive');
      const manifest = verifyCitizenSdkRelease(
        values.verify,
        values.archive,
        values['expected-git-sha'] || null,
      );
      process.stdout.write(`CitizenSDK 候选校验通过：${manifest.software_version}\n`);
    } else {
      for (const key of ['source', 'native', 'output', 'archive', 'git-sha', 'software-version']) {
        if (!values[key]) fail(`缺少参数 --${key}`);
      }
      const manifest = buildCitizenSdkRelease({
        sourcePath: values.source,
        nativePath: values.native,
        outputPath: values.output,
        archivePath: values.archive,
        gitCommitSha: values['git-sha'],
        softwareVersion: values['software-version'],
      });
      process.stdout.write(`CitizenSDK 候选已生成：${manifest.software_version}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode ||= 1;
  }
}
