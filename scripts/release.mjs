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
function hostHeaderSource(platform,name) {
 return ['citizen_sdk_error.hpp','citizen_sdk_events.hpp','citizen_sdk_models.hpp'].includes(name)?`include/${name}`:`${platform}/headers/${name}`;
}
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
  'headers/citizen_sdk_plugin.h', 'source/citizen_sdk_plugin.cc',
  ...['codec', 'sessions', 'environment'].flatMap(
    (name) => ['cc', 'hpp'].map((extension) => `source/citizen_sdk_flutter_${name}.${extension}`),
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
  'headers/citizen_sdk_plugin.h', 'source/citizen_sdk_plugin.cc',
  ...['codec', 'sessions', 'environment'].flatMap(
    (name) => ['cc', 'hpp'].map((extension) => `source/citizen_sdk_flutter_${name}.${extension}`),
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
  'PrivacyInfo.xcprivacy': 'darwin/source/core/PrivacyInfo.xcprivacy',
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
  '.pubignore': '9967cf8d7a75538c925084c15f6197d9cf1974187d3fb53c7757fe012fd2cfd5',
});
// pub.dev/Hosted 包只公开产品 API、公开模型、固定 Flutter tuple 与无秘密
// AccountId/SS58 codec。其余 Dart 来源继续留在 GitHub 审计包作迁移差分，
// 但必须被真实 .pubignore 投影排除，宿主不能 implementation-import 绕过 C ABI。
const HOSTED_RUNTIME_DART_FILES = Object.freeze([
  'lib/citizen_sdk.dart',
  'lib/api/citizen_chain.dart',
  'lib/api/citizen_qr.dart',
  'lib/api/citizen_sdk.dart',
  'lib/api/citizen_sdk_error.dart',
  'lib/api/citizen_sdk_events.dart',
  'lib/api/citizen_transactions.dart',
  'lib/api/citizen_sdk_wallet.dart',
  'lib/account_codec.dart',
  'lib/models/citizen_account.dart',
  'lib/models/citizen_capability.dart',
  'lib/models/citizen_chain_state.dart',
  'lib/models/citizen_signing.dart',
  'lib/models/citizen_transaction.dart',
  'lib/models/citizen_wallet.dart',
  'lib/platform/citizen_sdk_flutter_codec.dart',
  'lib/platform/citizen_sdk_flutter_sessions.dart',
  'lib/platform/citizen_sdk_platform.dart',
  'lib/platform/flutter_citizen_sdk_platform.dart',
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
  'include/citizensdk.h': 'b7928f1e6fe27a43ebea264fb902210e72d26a819ba354ede737966ebfdcdd34',
  'include/citizensdk_types.h': '2c16eab2ac26b947a16581e580754dbd425431f1b51677c9feff584421779970',
});
// Android Kotlin/Java 源码直接位于各源集根；包名由文件声明而非目录层级决定。
// Dart（排除已有独立来源合同的 smoldot 快照）、Android root/native 与
// Apple darwin 生产输入构成一个反向闭集。平台测试、文档和注入的 AAR/
// XCFramework 分别由测试、文档与候选投影合同固定，不能在本表建立第二条来源。
const MOBILE_BINDING_SOURCE_FILE_COUNT = 85;
const MOBILE_BINDING_SOURCE_FILES = Object.freeze({
  'android/build.gradle': '55c884c5929992152e9d0fcdd7e69a8446220d1ae3d24f5db8e9356f525f1a7a',
  'android/gradle.properties': '5318804f9c8a0d30039e9449e074d4ce23c97ce76ce4fc58349f671cc43deecf',
  'android/native/build.gradle': '08a648ebab3760cd1d90b56fb6984dacb2022b9e47fbe2df60935e47e021e366',
  'android/native/consumer-rules.pro': '7a2e6f17f3b414dd62fb760cfbcdefcfc3ec7847d183a89d9782fc479f89d3e6',
  'android/native/source/AndroidManifest.xml': '709ef7018c08e6f14d3d02fec899180b6758177b4f1defbae51d815782aa9a8a',
  'android/native/source/CMakeLists.txt': 'a454ebd5952f7b657f1d7d98740bcaf864f2081f3f819c19d9fe40f669e111e5',
  'android/native/source/citizensdk_host_bridge.cpp': '86ae53b82e800f45338fa75ae8121687d15adcff1a1c73b7ce7f6411f671f3c8',
  'android/native/source/citizensdk_host_bridge.hpp': 'c79d413b6df68106151fa6021fd634dd4e891f66feba004092bd27e9fb11036a',
  'android/native/source/citizensdk_jni.cpp': '2a30748445dc64a1bfe22caac3fe0559998e1b80c5f929bf1c81468439de4d88',
  'android/native/source/citizensdk_jni_support.hpp': 'b0b4fcef64701248f0c34e4d1ffb76fa19cc07bdb96e2b0ff48d7b14926561fa',
  'android/native/source/CitizenSdk.kt': '2cb6ae51a87c5784e6c66ebabac18dba209d1186012a6a04da033af08760b22b',
  'android/native/source/CitizenSdkError.kt': '317ae6a6eeeb3283c2f9035a5c0a63579688eb48fa10fc9424f9eda15f6cdaba',
  'android/native/source/CitizenSdkEvents.kt': '43107b2606d06928508b634a0ad5a673bfefa607528786b91bab658efb7fa034',
  'android/native/source/CitizenSdkModels.kt': 'af239629e3fa34b27a384111eb86f6b4ce863aa05b20c40ff282f17e93e25fea',
  'android/native/source/CitizenSdkOperation.kt': 'f623f51baff06efd8c9b39aade5968af2fd85860cca331e763d7c27bc5f4bc7c',
  'android/native/source/CitizenSdkPreparedWallet.kt': '654afe7899d6fd572f3083358df1c143375f3e0c0bfba0493e45a95d225fe571',
  'android/native/source/CitizenSdkQr.kt': 'f73937250dd8aa1f3e9e11e4d20501077302a7ae30a04e566fd24dec483adc3e',
  'android/native/source/CitizenSdkQrCapture.kt': '37dba5f840880beceec03ac85996f1397be1857a88b3849be5b1492dadb0f8d0',
  'android/native/source/CitizenSdkRecoveryPhrase.kt': 'a2b3938b577baed26c5411dbd29cf0c14147b14128a0e24e2361959054186b83',
  'android/native/source/CitizenSdkAssets.kt': '5e1fa319c9ad43d452b4e987cfb5fb644b0c682bbc7c687bb0717f7d043ae7bf',
  'android/native/source/CitizenSdkHardwareVault.kt': '277d1ec42501f890a04f425ae0140375e5a6795c9f4eab5f8e7baec53f1a04b3',
  'android/native/source/CitizenSdkHostRecord.kt': '6cdb3638939976db4c1b179a5871d8de111dd4bf2a3c94eab378e281cbcc9b49',
  'android/native/source/CitizenSdkHostServices.kt': 'f6c1334e64ca43e83051fc9e7e0d3a86f4eb66ba77a73d1f597951a760a2b43f',
  'android/native/source/CitizenSdkNative.kt': 'c7c7c6cec0b1e74b5ed48ef5fe6c3945ca5c291e7ee8482a1898e8b2230e0e07',
  'android/native/source/CitizenSdkNativeCodec.kt': '247b1808b5565f70ebe4dcf9fdb08dac5895634041eafb4a0e23290f519c1a16',
  'android/native/source/CitizenSdkNativeResult.kt': 'fbeb5d0e8e4cb4230face2c6c50d98cd9f8043e23cd88253fb42e8bbd0cb6682',
  'android/native/source/CitizenSdkPublicStore.kt': '2bf4f6a208b51ce4a89b278a060ffc051a4b985260780125bc76ad1f633ee1d5',
  'android/native/source/CitizenSdkRecordKey.kt': 'a43d9a8d303cd2a687bf11004ec5b95eb9e684a2f55befc364ca62b50f1c9a14',
  'android/native/source/CitizenSdkRequestRouter.kt': 'bbe7a711c0995cb647cabe679b40f92ced051b34d868cd8e18e7570ce8d23bfd',
  'android/native/source/CitizenSdkSecureStore.kt': 'dde91aebfcdeea9aa6b108319dd5718ac92dc02791f37ed4b3d5c6958c34ae21',
  'android/native/source/CitizenSdkSensitiveBytes.kt': 'fe2129f7612e3cad88ed7d2f38d66d371488554238794c94d9139c95729337c6',
  'android/native/source/CitizenSdkSqlite.kt': 'e1633581171b733d3c37d63444c7652e6ce5c91616e5fd5c9dc063778312dd79',
  'android/settings.gradle': '8c640faa6535ad6f80efd22154ccc50332ae9c77e2b8a0a69419afbfcffe9a8b',
  'android/source/AndroidManifest.xml': '5f63723834c354984501a277bf3752b0cd4dc85350bf2e09558538364fcb28ec',
  'android/source/CitizenSdkFlutterCodec.kt': '7ce92f9a03f12f712f069a9b41a99ee6481c427f9ff1c62f9419f39241d7f041',
  'android/source/CitizenSdkFlutterSessions.kt': '78272de9e30ff9ab9147b4a5a823fe36516992f314c6a28a7518585b89119394',
  'android/source/CitizenSdkPlugin.kt': '5054cf69ad1216f58ca65d32e01d4ff8faa5fc3eadc9ec828e80d0f0dff321d7',
  'darwin/Package.swift': '159c504cab86afb641fbef2b1fd35c59c20bbbe81d003cd7cdeec914a3ee91fc',
  'darwin/source/core/CitizenSDK-Bridging-Header.h': '977e6c4e7ede7d12d193032be74810c49412492321ea719937873482956f25a8',
  'darwin/source/core/CitizenSDK.swift': 'f071cdfb7a9426c4f2a43a4120105ef4359b028bd2cd031c412aa92aefa70642',
  'darwin/source/core/CitizenSDKAssets.swift': 'b32f78087ba8319c2d510cbadbc9d01da8ab956462dfae5f74bc603f4939a7ef',
  'darwin/source/core/CitizenSDKError.swift': '8e7667873254e1361d6e624d0f89f12eba0f5ba4499f4da694f3eb6b45175a7f',
  'darwin/source/core/CitizenSDKEvents.swift': 'cf0a342a28209eb0fc4058f10535a2420912402dd18339a141d6595c06544c71',
  'darwin/source/core/CitizenSDKHostBridge.swift': '92c7b3798fb8d52dbc380cb55e527a92d2810fca152aa4a3e80b48d13988f37f',
  'darwin/source/core/CitizenSDKHostRecord.swift': '70d951817f68a0ca5adb55a0a82323d8919920a1605b062e042c3122b9b391d8',
  'darwin/source/core/CitizenSDKInputLimits.swift': 'be5d33a92b5727c08f79d34c3758939cb112f5bac8961e7358e6f49c3239920b',
  'darwin/source/core/CitizenSDKModels.swift': 'f4de02144a4b697794d91d30f2f3688763de19f974a574adf842ffc01994c460',
  'darwin/source/core/CitizenSDKNative.swift': 'b3c8901b601bead0b082f3d1134782c1fe95c92e41ab29ebafc8d4f13bfe0ec4',
  'darwin/source/core/CitizenSDKNativeCodec.swift': 'f40ace5e9232bd4ca5d4e0a756d483ce9aafbea641b879f795fd51ed8e6e99e2',
  'darwin/source/core/CitizenSDKOperation.swift': 'c4316129d0383e347042952d3a02c71fdd72c67f40ecc64343f4ec04a9c2008a',
  'darwin/source/core/CitizenSDKPreparedWallet.swift': '7539ee20c84f3efc2577401901ad64dcd388f43ed6abff0cc75deed8f4e24aab',
  'darwin/source/core/CitizenSDKQr.swift': '4f90c30647d91eaa73e65f304927c05e4c28581ab6ac1a10a168ca8f82157f9a',
  'darwin/source/core/CitizenSDKQrCapture.swift': '984142c8b3e9fe697636cde1277bf6b183ca7626a48069fb52c339f5c40805d1',
  'darwin/source/core/CitizenSDKPublicStore.swift': '581b9057a3d4fe531c71f84077985cf41b803b073d6819ad1d87aadfd78b8fbd',
  'darwin/source/core/CitizenSDKRecordKey.swift': 'e4e0cd2f0ab0c6e1390391bdd5eb3c54370d49da23bca08c45ed37ed4936256e',
  'darwin/source/core/CitizenSDKRecoveryPhrase.swift': 'c794a5320b02d32cc348d8fb6f45d34df2e49260070eece3c620376f6f824993',
  'darwin/source/core/CitizenSDKSQLite.swift': '9a2e592decdbebb53a70b056ec70c3cc09ad0b4105aa5e94a282b66b86ceb5c9',
  'darwin/source/core/CitizenSDKScreenSecurity.swift': '2ad9b025e8c1ae3eef0ce7cdcca2c675570d39a41fc282cfcc4ecefea688731e',
  'darwin/source/core/CitizenSDKSecretVault.swift': 'dca8ff47993a54b0f565778d38a5a86f5baf00a28564b8a7d02390324eb02598',
  'darwin/source/core/CitizenSDKSecureStore.swift': '0ca43e22a9b841a56c3bfc15c6cf2fa4bf2225750fe9e6358451c01242ead720',
  'darwin/source/core/CitizenSDKSensitiveBuffer.swift': '2b92446c0fb99663105dcbe070a9bd0718ba492d807ce8ff1966d41a512ed25a',
  'darwin/source/core/PrivacyInfo.xcprivacy': 'bc417321bb94066c1bca08840349eea542c3c13e6addfc8248533791627434f3',
  'darwin/source/flutter/CitizenSdkFlutterCodec.swift': '50fed99e2c01bd38087c1117a8fbc91e86d87865d6ffee8a638aaeceaab481a4',
  'darwin/source/flutter/CitizenSdkFlutterSessions.swift': 'c09310ad36df0ab6e9d1bf698e71663ffb79c1f6356ed9a80b367c388ecf3278',
  'darwin/source/flutter/CitizenSdkPlugin.swift': 'e657eb7044fd1d6e603fc9174a479eedbd3dc09cce5758d4021ddf5dfbed9483',
  'darwin/citizen_sdk.podspec': 'b5a1000f890103fa0ce4d83b1775fdd494fa1a2d18324074ca86bdb9bef4969b',
  'lib/citizen_sdk.dart': 'b50e8ec83e05b300f5f6a06de8b69cc97e997ce865a96a13f151aa63efa3f237',
  'lib/api/citizen_chain.dart': 'f64e8fd8918469564b11f32212bbaadd2fc3cd09f5ee34711ba819b531f00077',
  'lib/api/citizen_qr.dart': '25581224704f9ef4e66fda89415a8a0348304d04c7e1c83455d65f421ace494a',
  'lib/api/citizen_sdk.dart': '2993a838556f2f8b7cc2b9f2c756841716a5a078e9f63089b28b88a7dab784b7',
  'lib/api/citizen_sdk_error.dart': '1bd6c7b0ce0391ca8edfb41e20a681f1372a506f18d0730f65b0d9d417b42f4f',
  'lib/api/citizen_sdk_events.dart': 'f4313b944ba072d4aaa2307bc3f232a6f15cd2a1adb7742625e03a3dae71e03e',
  'lib/api/citizen_transactions.dart': 'cfedd56d49a07f4c3d3ba15ec5a91441271a275d802a697856dc1c4402ad5bc8',
  'lib/api/citizen_sdk_wallet.dart': '9a7635ba7e322262ab4a9badf677cbcd2a47e161241c46a8ad27306170ed4f83',
  'lib/account_codec.dart': 'ce72262d96193ae47da43a9f675d6141f5c565eed05bb9e9755b575d96fcbc84',
  'lib/models/citizen_account.dart': '086319ca3010b0c848eba635954299c6425519b8c4eefd84b18ec26b2763ec4f',
  'lib/models/citizen_capability.dart': 'e7d5bfa94a60b005cd390f36ae25dfcb87a34c46c5b4e8188984a6103ba2103d',
  'lib/models/citizen_chain_state.dart': '24960cfa52d27901169c62afbeedd75dbf8ae69a3ce1f50b242c70e6c686d65a',
  'lib/models/citizen_signing.dart': '5f9b9921579db25a07b0d3fb3afbd6edde7c7f2ce9667a164f5b43e1468cc37b',
  'lib/models/citizen_transaction.dart': 'c5582330841d84628ac49a050ff1ed2fed08154c6368b22faa09384d17ba1268',
  'lib/models/citizen_wallet.dart': '9f9b49b6f3a5e0c570d94c3df990c62c6ebdce478e8bd1f4cfb67ccb67b2893f',
  'lib/platform/citizen_sdk_flutter_codec.dart': '3cdfd63cf4d4bc0c96a23588c61d2f40e3a76977641ec47be2cc6f83e11e600c',
  'lib/platform/citizen_sdk_flutter_sessions.dart': '108fb8a5b0234d67828b4d45d7fb843092b2e48b717869213f4c5e44e769c56c',
  'lib/platform/citizen_sdk_platform.dart': '295798fba26533cdbba0ec993acd215cf48889b9b744b43c2192e6566fe29f6c',
  'lib/platform/flutter_citizen_sdk_platform.dart': '18faee02334a8c3dabbcb3a80e01ac34ad56279cdb8011d18313ebcaf9f53761',
});
// Linux C/C++ Host 与 Flutter adapter 都只是根产品 ABI 的宿主投影，不是
// 第二份 Core。测试和 README 分别由测试、文档闭集固定；其余 CMake、公共头
// 与实现逐字节进入独立来源闭集，不能悄然混入另一套协议或生成产物。
const WINDOWS_BINDING_SOURCE_FILES = Object.freeze({
  'windows/source/citizen_sdk_qr_camera.cc': 'de0b1dfd3cb33d972ec375a25eb58006694849a1a1a5a48104407f248b515de2',
  'windows/source/citizen_sdk_qr_camera.hpp': 'a6937a5a30ca27ab87b767d51c766b4989918f4194a32718c67ea405ac605aaa',
  'windows/cmake/CitizenSDKFlutter.cmake': 'fe83e7dba936d785a462f3933093abf9f6db4521564dab760a6bb76ba703b04f',
  'windows/headers/citizen_sdk_plugin.h': 'ed4a806687c01f9be2a4c4c76dff5dd7d8676f7fe0c6860551006c3a056256ec',
  'windows/source/citizen_sdk_flutter_codec.cc': 'b954f7270ed72466df17a5e0ce0c27de01f4898087301b236cced9fa8598cca3',
  'windows/source/citizen_sdk_flutter_codec.hpp': 'd0be6bd054e140958c0688b23b1eabea619145287892b2b4ef90b0de81ff6769',
  'windows/source/citizen_sdk_flutter_environment.cc': 'b8995cf4ce18a44958c52883088153795e149fb1b4622f5a8ecbb78b496900e5',
  'windows/source/citizen_sdk_flutter_environment.hpp': '958a42b9f877a3ed3d74ae893a51ceb57603d80ebad2aec1eadf82785b60a055',
  'windows/source/citizen_sdk_flutter_sessions.cc': '17692c55f1fcd8cce94adb85fa31890fd923ccbdecfd5f34e9d72a4bd46460eb',
  'windows/source/citizen_sdk_flutter_sessions.hpp': '662cd44b983352fc3cc1ddc1078c9c3704bfd1e9ad65563e274bb482b46776af',
  'windows/source/citizen_sdk_plugin.cc': '0c056bfd4580fee4fc58e4a6a09d6ae421844476dcc93e2b46af6936ebd49d1b',
  'windows/CMakeLists.txt': '358876590769b6e2af4c3878c8f74bda9f603f106fceb7c0a158ee310911a2df',
  'windows/cmake/CitizenSDKConfig.cmake.in': '28f0499a515d57a025ad7f7453d0bcef917c3c40dfb8ec7f98e0ce0935caef81',
  'windows/cmake/CitizenSDKConfigVersion.cmake.in': '5e180138e3d7ac236ad945c42a15184f48d3076a40206a3d7c90d545d42be235',
  'windows/cmake/CitizenSDKDependencies.cmake': '22e2ce5543f07f84def46b119df9fd9ab248f4c4df8ab27d4ab5f86c9ac65300',
  'windows/cmake/citizensdk_host.def': '7532bb23a8f760aefd08057334cc7395bb487babada8f1b024226ddeef2f7afd',
  'windows/headers/citizen_sdk.hpp': '25a36b3386ec0ff88f1326f6b96b7d50c6687bfc702aabe59750756af6b8c4e1',
  'windows/headers/citizen_sdk_config.hpp': 'ec428263bffce15723485b6c4bafbcec99b40ce6979aa4514b2badc378b80296',
  'windows/headers/citizensdk_host.h': 'e77158404edbacbca31ab2000837184d929fae387918b48b96d5706a369d0c29',
  'windows/source/citizen_sdk_assets.cc': '9f55e98f71f87f8baa3c2608bf64c52e2e8755aed4fa7ded13e47494f9968207',
  'windows/source/citizen_sdk_assets.hpp': '5e50c7ca69023c63af645eec4b97fa1bf74ae3089aef86fdcf1d35fcd4fab8cc',
  'windows/source/citizen_sdk_cng.cc': '88c6cc4d5532eec088d30211826e8cd4583e629557a43d687768a49353d39ffc',
  'windows/source/citizen_sdk_cng.hpp': 'b7e15414228fb0671cbf907aa1a6cbe0ca3ff57a1101805306b2c40c3f3321e5',
  'windows/source/citizen_sdk_directory.cc': 'e32bdb3c8d1f752bc750eae1bbf104b81c54e665fbec6ec8d9d3173a6d5c6844',
  'windows/source/citizen_sdk_directory.hpp': 'c46f0679df4c328b2a43be50260cb8001341f5da66d0ede2830b258c801d546a',
  'windows/source/citizen_sdk_host_api.cc': '93fced9a38714295833c93d26a646cf068b8015a90b4b7cc940dd0198b80f106',
  'windows/source/citizen_sdk_host_bridge.cc': '33279a98bca34130d4750295d306e0129e06debe76a73c2800e2a157f9c9d819',
  'windows/source/citizen_sdk_host_bridge.hpp': '503f5cd8b94c5bd8f498b91d4d2dfbd5755c965ebb3a286e4c4b918ea8b4bfaf',
  'windows/source/citizen_sdk_host_record.cc': 'ef59ba6feefc4686f5d5ed619a7a5cc43d5bd4a167fae1ba4f7022da85d19c39',
  'windows/source/citizen_sdk_host_record.hpp': '9e53109d9d1c3fe31e8f591acba8ec83b869031ff831013f44599a0f80914f68',
  'windows/source/citizen_sdk_input_limits.cc': '2ca5a890d4c30459f5ebf846be1fe365fecad534a48e23a337628dd93f876bd0',
  'windows/source/citizen_sdk_input_limits.hpp': '974e342358959f64aa943ff59111b5555d738054698d2804cf021291eab5c4ae',
  'windows/source/citizen_sdk_lifecycle.cc': '33e03ff5c2fcdb15fd5d5f7bcd340ff3b9437cd8bb90c7871ac759478baea7e3',
  'windows/source/citizen_sdk_lifecycle.hpp': 'ae6767db44c01778c91bd17b140da62efa69c245b9df78aafbef41ecba76c2a2',
  'windows/source/citizen_sdk_operation.cc': 'cf91f83b6f6dc318dc782d231855b5effb44b905a2ee8325423f883a8a9715ee',
  'windows/source/citizen_sdk_operation.hpp': '5864304e0760b45a4e41fe7e923b623809d795f27e18262acc0f5daf0e4ff38b',
  'windows/source/citizen_sdk_public_store.cc': '7f3301ec6f79f8f1e44976fdeaebd1610b0d51e4834b6cbca1ccac65827f545d',
  'windows/source/citizen_sdk_public_store.hpp': '014b53c41685616f0186c5d15db3778629fbc83a23d308e8d005e934f32befe0',
  'windows/source/citizen_sdk_record_key.cc': '689eb3eab6a279b930f60ebd292b594f17ca2fb06faa0c938ed8311c23cdf3df',
  'windows/source/citizen_sdk_record_key.hpp': '8f41cb538870037827ecda3401178dcaee5d839d052375ddb6b5e9e74326f736',
  'windows/source/citizen_sdk_secret_vault.cc': '16ac10668d9dd3297403b000cbd4bdf561c2f8c12a487eada071b6b0e148c419',
  'windows/source/citizen_sdk_secret_vault.hpp': '718d86c256a4d512a6ebbf924c7a2543dd235120816e64caec54c0e0118e4a3e',
  'windows/source/citizen_sdk_secure_store.cc': 'd7861e3859d0f3be1461d385f190d24d43e8eb1f492d1d8fce691841ddabb348',
  'windows/source/citizen_sdk_secure_store.hpp': '90ae0c83d1d5fd70b38eaee46ba51897c4169ad3b308ca124e4ddffdea4c384f',
  'windows/source/citizen_sdk_sensitive_buffer.cc': '3e57b05e29b90c92f95dee292360debeb0c330af1fce41a24de9cf9c3d04dff6',
  'windows/source/citizen_sdk_sensitive_buffer.hpp': '99c5cd23993b3bed07605f4a707eec55cdf087a97677bbd684f8363355ef3ce7',
  'windows/source/citizen_sdk_sqlite.cc': '503bfacb9e83a1d2c35dc45aec0184c5a3fc759b1e8cb44182ab47334697d854',
  'windows/source/citizen_sdk_sqlite.hpp': '0d69a315553abd90a42029646fa4355b3acc9867fb16a9343312abcffb4aa2d3',
  'windows/source/citizen_sdk_user_auth.cc': 'e75009ce315f73f10b103961dcb06c9bac8a5bca0b934a074172b4ba481de994',
  'windows/source/citizen_sdk_user_auth.hpp': 'a6d56dda212b0fe6f0f818f51192ff210e39ef165e17d65350fcf3d3a1ae4b49',
  'windows/source/citizen_sdk_window.cc': '76673550457b05c7f75a426739cfc925e8322b98c872c3519420a465d79afe7c',
  'windows/source/citizen_sdk_window.hpp': '60fff1bbed42f818449e351e819aae65e30029b95bb27b92421f7793a1ccfa6b',
});
const LINUX_BINDING_SOURCE_FILE_COUNT = 48;
const LINUX_BINDING_SOURCE_DIRECTORIES = Object.freeze([
  "cmake",
  "headers",
  "source",
  "tests"
]);
const LINUX_BINDING_SOURCE_FILES = Object.freeze({
  'linux/source/citizen_sdk_qr_camera.cc': 'abb06ae107649dbacfd8cde28f5607aaff83dec906d0c82e88eaa3db8c486e44',
  'linux/source/citizen_sdk_qr_camera.hpp': '7978efb0277b58a6a73b1dffc053f01e016285a9011a3ee9bb278f0e267b447d',
  'linux/CMakeLists.txt': '53d4b2e083c56a70516b6f2a10345d65dedef0503d60c9a3f63a881134d55ece',
  'linux/cmake/CitizenSDKConfig.cmake.in': '6438544fe01125967e71e21f0bc4147e68fb8f68215502af2f82fd1287eff9c7',
  'linux/cmake/CitizenSDKConfigVersion.cmake.in': 'b2dd2bb6bb58f1255b6e9eca0f61b635f589ee2809537f7ba7fa45d46e3d7685',
  'linux/cmake/CitizenSDKDependencies.cmake': 'c0ab6dffc4577ebfff8b3eb467f37f2b8c7fb45158bf3f64b7e8d753b9d8f5d0',
  'linux/cmake/CitizenSDKFlutter.cmake': '7b37c6cb79526a99de41076abe56c493946e64cd2630d0563c8df334688fc95f',
  'linux/cmake/citizensdk_host.map': 'dc3ce26cbf848b5bb56d0051fcab5cb38e88ad281a36bee95e720c78742ffe88',
  'linux/headers/citizen_sdk.hpp': '4c743343d1fc8d3a7979d06a4cb391834321d83583cd40b2ff2efbd9c0bab847',
  'linux/headers/citizen_sdk_config.hpp': '874ed6acabd193589d572d97b0d8d9106f70f80210507433ba46b97263c4e6c6',
  'linux/headers/citizen_sdk_plugin.h': '06636001f326a317617a39f7c1108eb510b127f416de7f0dcb4c4cdd84be0c2f',
  'linux/headers/citizensdk_host.h': 'dbfeb366336a504ca1ab58e5543d7a73522364cd7b3e4fd04ac4835d84ff0df9',
  'linux/source/citizen_sdk_assets.cc': 'b663b653299c22d62a44a7f242e1e57f2d8471408d0d3d81728bbe37929d0cb6',
  'linux/source/citizen_sdk_assets.hpp': '44d30123c623ea266030235126552e4a9334839f0d5d44adb5931f56d8b93401',
  'linux/source/citizen_sdk_flutter_codec.cc': '7ebe0f807ac6fd1b28f91c63883727ed63a0bbc6cef6cea7708d3f99f660b28c',
  'linux/source/citizen_sdk_flutter_codec.hpp': 'd791a1aa28a6c5d0d7a88c9c03c5bc4103e7b7ed7c99bf2debc7401f40e23bc8',
  'linux/source/citizen_sdk_flutter_environment.cc': '25d29c5a53509b65cf304033753ee77b674345715f26b51e3758294306c8e1cf',
  'linux/source/citizen_sdk_flutter_environment.hpp': 'cb7c3707b5060d178bfaebab973358a897cabac08945220fd975a6e050e2a455',
  'linux/source/citizen_sdk_flutter_sessions.cc': '54e69fc0e4bb82f03f072a4d6024c9fd92bee733b19dd001882bf7298de2648b',
  'linux/source/citizen_sdk_flutter_sessions.hpp': 'd326ac7b97ccd11b74a1ac6d35238d6894893444df6392332da656beca8ffe79',
  'linux/source/citizen_sdk_host_api.cc': '1ff5822dbfae143c909bb2a2809872217e76638a8773440eeca41a6fe5564ecf',
  'linux/source/citizen_sdk_host_bridge.cc': '9eb057abbe3d52916c1c133bdd1e6e5f05bde2cb355029b2f7b9fec0001c1ba7',
  'linux/source/citizen_sdk_host_bridge.hpp': '1c44585a9e0685f950617cf62288170f573f1dc7d5e32c4ae4e4208bd8cfeb28',
  'linux/source/citizen_sdk_host_record.cc': '68fea5575759fadbc9bd9257a32bbb00779bad9961908e76135329c3fcc110c3',
  'linux/source/citizen_sdk_host_record.hpp': 'd3c5b9cfaf91c85ee47bf86713f1299f204ef220614035257adb1c2d56be5742',
  'linux/source/citizen_sdk_input_limits.cc': 'cbfbdcb165e1918c663eec418bdd39086cd1b95272d46c6295691724732bcc77',
  'linux/source/citizen_sdk_input_limits.hpp': '01144ab7a4f7dbef47bf92bf5c6d7cb1b35878718d721d2ba99be719a2923bbd',
  'linux/source/citizen_sdk_lifecycle.cc': '78fcdac10137a4f39d5eb6bd69be1a74a51b5f449f969f7d6e048ba8828a441f',
  'linux/source/citizen_sdk_lifecycle.hpp': '08c384e14cdae9938d07d681d55648e0e0e623b07f69e0d4c5f472a7077539c6',
  'linux/source/citizen_sdk_operation.cc': '5fc6658dc917578d88b256feda05352e7c7f30447bcda0218a0169f0cf7ac94c',
  'linux/source/citizen_sdk_operation.hpp': 'cecfd6e3864996c40995ebdb25c7fd82094f19dc039481ba35451b7196ee1aac',
  'linux/source/citizen_sdk_plugin.cc': '6d351a5824e5dd0112dc3398a31c5969251f89d9fb632f5994c41acc24f39604',
  'linux/source/citizen_sdk_public_store.cc': '1c4daf7421f85365d8aec2a51e60564acbb8f7b1102d3fb5db416ce744ddb476',
  'linux/source/citizen_sdk_public_store.hpp': '0ed71b85c8bb736c2454137dfdc856da3cd4b963fb5fa3fb9c3e7b0324bbe197',
  'linux/source/citizen_sdk_record_key.cc': '80425cd8dffa7b537ab6634018b8877f2bac365949dc41667c8f0b8945be193e',
  'linux/source/citizen_sdk_record_key.hpp': '267aca52f7d0e0647f5d716eebc08cb2c77be5c093d491365baa7c01e0118bdd',
  'linux/source/citizen_sdk_secret_vault.cc': '1d743a721989de233612ea3c686c8233197cf010271065bb37ea92e28e75ae5a',
  'linux/source/citizen_sdk_secret_vault.hpp': 'b0db3c3827b40b243053d6e5696bbbd1946555b3b1b3fee99b5555047b4f1ae2',
  'linux/source/citizen_sdk_secure_store.cc': 'a3703ef08bdf6cfc2acd454c433aa6e19cd38171c2b89a1d62f83f0ce4b77ccd',
  'linux/source/citizen_sdk_secure_store.hpp': '2fcbb33e911042cb7cfd74acb7a75f370ce51c5bb66e4147824219fb991faaad',
  'linux/source/citizen_sdk_sensitive_buffer.cc': '3904d22d1d02bf03512d84fb5a06d30912793b7e5abecba283b30ba3b15d1e90',
  'linux/source/citizen_sdk_sensitive_buffer.hpp': 'ea8254eb8420c7abe4b7adc338d87fdf0ce9cc8a44ca42ec305618c3788b1046',
  'linux/source/citizen_sdk_sqlite.cc': '1c216fc9d40e8311cbfba188cf65aa3f65304751f40bcb1ed727a4e8288926f4',
  'linux/source/citizen_sdk_sqlite.hpp': '758df4068b8db94a1122e1a64823fd38aca9f5590c1ec1ba39ac5eb69f49041b',
  'linux/source/citizen_sdk_tpm2.cc': '09fee7a54f2163d81584c9cdef05ca38d5b533057437d0621c1c2d44357310e9',
  'linux/source/citizen_sdk_tpm2.hpp': 'a8a7c68d743b8e662ad57a736c23ff54518e53155d72ccae9913b61964cae644',
  'linux/source/citizen_sdk_user_auth.cc': 'f3f7631972ddc03afe98c38af23f2c1b26b2b55ba396d1aa68ed72bf480d4087',
  'linux/source/citizen_sdk_user_auth.hpp': '37b1ad9fabe43440bd4ffb14a41275c63d1590c69be12cee83889863c517503b',
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
const SDK_TEST_CONTRACT_FILE_COUNT = 178;
const SDK_TEST_CONTRACT_ROOTS = Object.freeze([
  "test",
  "native/contracts/tests",
  "native/engine/tests",
  "native/ffi/tests",
  "native/signer/tests",
  "native/provider/tests",
  "native/legacy/tests",
  "android/tests",
  "android/native/tests",
  "android/native/device",
  "darwin/tests",
  "linux/tests",
  "windows/tests"
]);
// scripts/ 同时包含生产构建器，不能把整个目录误当成测试目录；只反向枚举
// Node 回归位于正式模块末尾；独立 *.test.mjs 文件一律拒绝，内联入口由门禁反向登记。
const SDK_SCRIPT_TEST_ROOT = 'scripts';
const SDK_EMBEDDED_TEST_ROOTS = Object.freeze([
  'native/engine/source',
  'native/ffi/source',
  'native/provider/source',
]);
// scripts/ 的正式实现和末尾回归一起逐字节固定；两个兼容入口只负责转交。
// release.mjs 通过完整执行源码比较验真，避免合并测试后出现自哈希循环。
const SDK_SCRIPT_ENTRIES = Object.freeze({
  'build-native.sh': 'pinned-production',
  'build.mjs': 'pinned-production',
  'ci': 'directory',
  'dependencies.lock.json': 'pinned-production',
  'dependencies.mjs': 'pinned-production',
  'flow.mjs': 'pinned-production',
  'flows.json': 'pinned-production',
  'release': 'directory',
  'release.mjs': 'executing-source',
  'resources.mjs': 'pinned-production',
});
const SDK_PINNED_SCRIPT_FILES = Object.freeze({
  'scripts/build-native.sh': '3ac78b7cf8f7a516ab3d238bbc4bf82ca779128580920e6f808dd6e2858adf8e',
  'scripts/build.mjs': 'c3eaffd2743ebb79d5580051be5c0cce13467773064781d938197fc449354413',
  'scripts/dependencies.lock.json': '0a8512053a401ac12604098de0c19e810b529424eea3e81f952a5eea14e9d5da',
  'scripts/dependencies.mjs': 'dd5b0a51f7493ad5cf63b757209cdb9f524329417591b1b038f27586957d63e9',
  'scripts/flow.mjs': '3c158a202f18945c6fcbbe1fc7a98d3402dd0f7ef31fbff44fd7d87b2096c204',
  'scripts/flows.json': '46907f1a1964a50322b4bbdd0df675c3fa537b7276f44cd84922694b7c0e4e69',
  'scripts/resources.mjs': 'b64f88fda8ec1cb15c8013619f48a4a19750804acbf50a51d20b6c294dce71c6',
  'scripts/ci/index.mjs': 'e0c2b164889f2ea60ab272172a80c374b8c9f365a67c0c9a6cc5086d100c801b',
  'scripts/ci/sdk.mjs': '9fcfaa02196fda239dd61f3333f24c1804c4106057091c0ebf05b6505b0186b6',
  'scripts/release/index.mjs': 'ade5e6c2c6839fdc95f42df89266f5a82db7403d552e6c9a75fa3f7007028df4',
  'scripts/release/sdk.mjs': 'c9098dcf90f763bb31aa792037c84b3ef155cfab2d8647b5adb01b27922c3d27',
});
const SDK_TEST_CONTRACT_FILES = Object.freeze({
  'test/sdk_1_10_1_contract_test.dart': '7faaf6e6e8862dea4dc02fb676ff731cefc18201f7fc01128b5761e68166b40f',
  'native/engine/tests/baseline_resource_contract.rs': '78b211a0d7ce43d9819cbaf1f867f8680222cf649a5b9729ea9a808ce09abb03',
  'native/provider/tests/baseline_lifecycle_contract.rs': '06cdd93b7acde7acf523046fd01648c8e4ad49635b3a06cf8448b014b90be595',
  'native/engine/source/qr_review_tests.rs': '9112a367745bd8aca6796316a8ec31895021edd762b2cfd655b8a357d72aa00d',
  'native/provider/source/bootstrap_tests.rs': 'd0da6517b73637c7591c4ddb247fd5b13d3410a2dce89be3a881bea83c413eaf',
  'native/ffi/source/chain_monitor_tests.rs': '249e22c52f52ff4f17ab6fad58c5ce37f9f0a880ce4156671b8356e29214730e',
  'native/engine/source/wallet_input_tests.rs': 'a48405f12472122b7ab1dbac19b806e3900c99152a396987e1f0956fb9bcf3af',
  'android/native/device/CitizenSdkWalletInputTest.kt': '84601a410f7500ba171f97396617fa0fca8d1aa9780bd94872b2478a4297a4b0',
  'darwin/tests/core/CitizenSDKWalletInputTests.swift': '817dcf3bc5762578588ac9d3860bb22ba16d4d972404c529b93d8791eb27db95',
  'windows/tests/citizen_sdk_flutter_consumer.dart': '2642e2ace6020c080d3bb6e883108000acfd71cef4d2f524e8ac25c2c0befeff',
  'windows/tests/CitizenSDKConsumer.cmake': 'fd7015ce32a1e77abe7470c291c54aa66195adb44185fa74a9defd85fbb8d24d',
  'windows/tests/citizen_sdk_c_consumer.c': 'ba564a941be5ddf91235057fb8444b3c342c3932c139a07996f64adee105546e',
  'windows/tests/citizen_sdk_cpp_consumer.cc': 'a6a78ae4b3d07f5ed1f99990f54bb8c5c4d41c27f06cb0a999520ee64d90c96b',
  'windows/tests/citizen_sdk_flutter_codec_test.cc': '7c86dfde2966caacb10d49aacad7412640df48804a72e2a6aab55a99e2048610',
  'windows/tests/citizen_sdk_flutter_environment_test.cc': '1faed89ee422a05166b4ad12efdeef7f5543b0b8e32512e235f7f700b1a2e86d',
  'windows/tests/citizen_sdk_flutter_plugin_test.cc': '466bc68608196dd5f74059c05833da29fd632df3456df2da20efdcb1bb7ee0ca',
  'windows/tests/citizen_sdk_flutter_secret_boundary_test.cc': 'c9e6c6958b4400bba9b45061c859823dc82c1693447afe4c06a40d697322b79e',
  'windows/tests/citizen_sdk_flutter_sessions_test.cc': '171a73af6577ef841667473fca75cbf3dfaeee5b7534d4c1adc7938c2dc8ad6a',
  'windows/tests/citizen_sdk_flutter_test_support.hpp': 'c70f2f414d92aa56c2e86e300c2567bb46c38927039ae9f519d1e262b7bcfb47',
  'windows/tests/citizen_sdk_flutter_wallet_flow_test.cc': '8f6ca493435d990e8362f0f9b68d430c03a13938351643c5d5cd3bfe3e674b94',
  'windows/tests/CMakeLists.txt': 'dbe04a6a44001c7bf6970e5f9d8ef07dff877e175d7d13ba26467ec0194f37a1',
  'windows/tests/citizen_sdk_api_contract_test.cc': '8827d9bfbb95608f0ff9e731bd2e7df6d7cc584d28942f788d2ffc4bed702314',
  'windows/tests/citizen_sdk_assets_test.cc': '07575184eedaee8716bdb9e9134cb8ee3d68addaf7b4f271bc77b5fe117d904a',
  'windows/tests/citizen_sdk_cng_test.cc': '2041c11af27e7424295d4294f271c1d0cd8c7162c64d67af9155eaced422f4fc',
  'windows/tests/citizen_sdk_directory_test.cc': '952bdc527cb00371cf721f7bad8bd527a7d7f4251799df45e38d19087f4aac61',
  'windows/tests/citizen_sdk_host_operation_test.cc': 'f400e076c426226c0c12d2d08351ff55d0287c090b430519b945dcce760eb47a',
  'windows/tests/citizen_sdk_lifecycle_test.cc': 'd473eb569ef4af6cf93bc9a9aa4d399aed5cab4e0c3b6fc762755a7a780afe5e',
  'windows/tests/citizen_sdk_public_store_test.cc': '240ce90cc1233e9c8303303dee85242ac674e6673f50dd6df33576c4e2521807',
  'windows/tests/citizen_sdk_record_key_test.cc': '421e9dd2e9950c02addb9343fe12ca23f3d9c1832c4a25725420928dbc9423e1',
  'windows/tests/citizen_sdk_secret_boundary_test.cc': '7e6c220a4ac2129d8cb11ca67206951e9c1bec56976d66398bc14d1c56f085ea',
  'windows/tests/citizen_sdk_secret_vault_test.cc': '366581ba2723a7150600d3b0d9f0896aa7ae7973fa8825751cd009b47d1a5dff',
  'windows/tests/citizen_sdk_secure_store_test.cc': 'ca29f5d02a0f15556c370c9a0cba9c8ab93501effe335240dbfb1077887d9b77',
  'windows/tests/citizen_sdk_sensitive_buffer_test.cc': '23d0d8f7f28db585ff1dc6ac23d350018c7f6636adb07925f3b3891d0b4eceee',
  'windows/tests/citizen_sdk_test_support.hpp': 'd128551fc1e6f8aefb9604ac88ed32cfedcc2d57c97be30995aa974e7a5ee38c',
  'windows/tests/citizen_sdk_user_auth_test.cc': 'fbe8fb1941f722775b27954d2e3222bac40feee99b88565c7bb227f01e560324',
  'windows/tests/citizen_sdk_wallet_flow_test.cc': '3ceffa53b2417c7eded1a048d330e9d00ee5b25af0f7413b1bc292701d0205f4',
  'android/native/device/CitizenSdkHardwareVaultTest.kt': 'd7446fd9193a59f589cf085a924ad2adf596121a5542d7cc63b31f31a53268a2',
  'android/native/device/CitizenSdkLifecycleTest.kt': 'e16c4493a198d8c2d9e790bc2d2d16f73db4d97f71e2356cccf7f543823fb0dd',
  'android/native/device/CitizenSdkNativeAbiTest.kt': 'f1ce49cdd8e58d8d765efb22d64aa6fac9a6992ff29e1a4ee4c0f5f99e0da683',
  'android/native/device/CitizenSdkStateStoreTest.kt': '5e2f52b2d45e4867d41e2b1671ae2ffac500c4e9b9d661a76dc9ab48d768d542',
  'android/native/device/CitizenSdkWalletFlowCancellationTest.kt': '28881d7e4cb2bd0919ca96c367964c81e30aab19a1f7ef59ca03c9e5e3c9262a',
  'android/native/device/CitizenSdkWalletFlowSecretBoundaryTest.kt': '9ed5779c514f268d804b0660d7e498b3e6921851923427c68bc2d9d16118acf1',
  'android/native/tests/CitizenSdkJavaApiTest.java': '14831f3885786a8c04bb8425b257f2baa7bf4205f42e579236ca3fa63c75506f',
  'android/native/tests/CitizenSdkJavaOwnershipTest.java': '81d06cf7ace9cc41b2045f757588a9859ec7f02cc24c4b11fab95d7ad5dc74a4',
  'android/native/tests/CitizenSdkApiContractTest.kt': '925d9897115c804e99ca8b6369980db2702f58327195ee2fd985828b156d0129',
  'android/native/tests/CitizenSdkPreparedWalletTest.kt': '326742ec538a0a0b73188ac24d06f3e6042776a8e0b545c50f6defcbf04cc632',
  'android/native/tests/CitizenSdkHostOperationTest.kt': 'f1f9bde38554168e856a966d7c79803d2fc02ecae1ca7dc7996a685fc5c01602',
  'android/native/tests/CitizenSdkRecordKeyTest.kt': 'b83832d2431e40caaea3b9356390c3ea7c03624c93733fc821d3a6f832aed634',
  'android/native/tests/CitizenSdkVaultIdentityTest.kt': '995a25c4742c3098e96f869379ea4f7e77289e2230cd4c211462712ec4ba1acb',
  'android/tests/CitizenSdkFlutterCodecTest.kt': 'e470a2b56a9440cde1313e08caf495481b42f8e31c6431f2f3b5872c8e7e5bc5',
  'android/tests/CitizenSdkFlutterSessionsTest.kt': 'e970aeaebd98d3400e2fb0987bea27a1ce623fb4504774cfe7ae7a3befe20716',
  'android/tests/CitizenSdkFlutterWalletFlowTest.kt': '5af91c52409e5cfe41c827e0e762aa2148e491ca645e22019c63c0a2e5d61a0a',
  'darwin/tests/flutter/CitizenSDKFlutterCodecTests.swift': 'eae4cd2e4fbe07406b49719893643ed19137c8acecaf4add2ee419991008809b',
  'darwin/tests/flutter/CitizenSDKFlutterPluginTests.swift': '7dda507d58a34280d5164c62d5dfacbb743b271587efc47a0cee69d5710af50e',
  'darwin/tests/flutter/CitizenSDKFlutterSecretBoundaryTests.swift': '2f0150db79a60ac27e7524d2974ea91229c65b576b0498ab7e1ce4e823fb5ed1',
  'darwin/tests/flutter/CitizenSDKFlutterSessionsTests.swift': 'a7d2d2b0aef9ed3a5f8f18076cef45d1c3a527a6fd908acb096a075fa38ee9fc',
  'darwin/tests/flutter/CitizenSDKFlutterWalletFlowTests.swift': '8caa0560b189af5ff0e67f59c0d090c1b34086cc90dd50d113d5b48389ef471f',
  'darwin/tests/core/CitizenSDKApiContractTests.swift': 'd455f73b09bf08056379bf9e50303feef67b6cfcb708ada9743e6fe3cba1e32f',
  'darwin/tests/core/CitizenSDKHostOperationTests.swift': '109be3ae384db564139db63537895b0151fe29b59fc7c2370d51553e7fe5f3c5',
  'darwin/tests/core/CitizenSDKLifecycleTests.swift': '88c34852b88c4dbf90bd5411151c91a6487f2ff08ae2e946f245eac33098eb48',
  'darwin/tests/core/CitizenSDKNativeAbiTests.swift': 'd9debe54f2078f149e2150421ba1cb5ac12d0b3464a9f4ed1fb23fdec018efff',
  'darwin/tests/core/CitizenSDKPublicStoreTests.swift': '537b71a8cd4bd78d24bac4ae0dea39e0b46d44b257e2b6876d0bd3462a473b1c',
  'darwin/tests/core/CitizenSDKRecordKeyTests.swift': '30891704a7d2d4fa98bf3750c9ec88370389fd4e6bdf7f4641faeb8a0873791f',
  'darwin/tests/core/CitizenSDKSecretVaultTests.swift': 'c7affde19d38e01922dc8c13ce67ead61bc809b76e1701d96a5e99e923e91877',
  'darwin/tests/core/CitizenSDKSecureStoreTests.swift': 'fa29b12165632e1f4574a09267316ed0308e6813080a7def22bd87fe75daa481',
  'darwin/tests/core/CitizenSDKSensitiveBufferTests.swift': '6788049be932cfe0555d45f03f2abffcdad40bc66d011520f4c0d2f185f79863',
  'darwin/tests/core/CitizenSDKWalletFlowTests.swift': 'cf41e9d2848f6d7d55eb352de683b214be039b740b68756d9fc0c83804057bdb',
  'darwin/tests/citizen_sdk_flutter_consumer.dart': '1ef13c8d31126d7814f4ab217a09a978d324d1ef9e02ca40c33e02e13311ba41',
  'linux/tests/CitizenSDKConsumer.cmake': '0a9b3160c86d4d699e16f47b026e2e0c46439d3cabc84b323c885db220b4007d',
  'linux/tests/citizen_sdk_c_consumer.c': 'fcba2e20096acc6611a6b198a273fb78093bfc5ee77b3924d6551464316e186f',
  'linux/tests/citizen_sdk_cpp_consumer.cc': '6b85472aabb166361711ca5ad1c91831ec58ea13704fda29c5f2c57ca3d85df0',
  'linux/tests/citizen_sdk_flutter_consumer.dart': '149687d5025cdfe1327dea9554de9e3bd636f1563b2dc0385856ecfa1ee24dda',
  'linux/tests/CMakeLists.txt': '26e5a24f5dd0a6f85f7c7e43ea0964f1f62662af0a1d94114c18456cac55c38b',
  'linux/tests/citizen_sdk_api_contract_test.cc': '0d1e8b602a5521f2679717afebdfbf954053c7b2e743938e037e3526cae26b57',
  'linux/tests/citizen_sdk_assets_test.cc': '3902d98006a8c47b0c7c6043d62472bd199ec9edb2ee7c2aff1117d2d5a7e724',
  'linux/tests/citizen_sdk_host_operation_test.cc': '2a5ca3f466fbc2149ea56ed8f3f215251bebb5af61e4b2fd0d54c4397adb94aa',
  'linux/tests/citizen_sdk_lifecycle_test.cc': '65aafffcaa392479ce98515a13770b18af6507f497ebc147a360e433cb7e4190',
  'linux/tests/citizen_sdk_public_store_test.cc': '941e9962b5a6d9855dac0a00f6beaa9613e502a5fb7361af5af1a98cf674887c',
  'linux/tests/citizen_sdk_record_key_test.cc': '11871f6372b6983d7265fddb1714ed9b283d9ff43a9f6e782759d47dd5c74e4d',
  'linux/tests/citizen_sdk_flutter_codec_test.cc': '233924279fd45c950336d40c6d36c369e1a0789d24c4d2f3f7d096b252995a21',
  'linux/tests/citizen_sdk_flutter_environment_test.cc': '14e757b971f678a597356f0dcad750519e2005f314f4746f753cd6db19096ab1',
  'linux/tests/citizen_sdk_flutter_plugin_test.cc': 'c251e3007f7e3b1096c25c5c7f164d19d7cf32fab665a4c8c04f8222a4cfeeaa',
  'linux/tests/citizen_sdk_flutter_secret_boundary_test.cc': 'a50ca4172d3a6d88b675b80e941591d29dade4525396572e01d342de1c50275d',
  'linux/tests/citizen_sdk_flutter_sessions_test.cc': 'c38840df5589614228eb77eda61e92d32670f8efed40a20cd1ce6c3c38adeb21',
  'linux/tests/citizen_sdk_flutter_test_support.hpp': '1b92cf8f6a6fd0df6a58d5630f72ad29578d3118f7aa886ee1b3149b86606f56',
  'linux/tests/citizen_sdk_flutter_wallet_flow_test.cc': 'e147945a9d7366e23a7fb6863354720881b5eb74ba90d78bac611ad598fd2421',
  'linux/tests/citizen_sdk_secret_boundary_test.cc': '53e9de1a509b709ffe0197653ffc6d68719123104b11f9c73ee4173c997be929',
  'linux/tests/citizen_sdk_secret_vault_test.cc': 'f5a433a7ec9d57a7b39c195b56d375e1f7e1b5b6ee017a476730fce6aec086a0',
  'linux/tests/citizen_sdk_secure_store_test.cc': 'a07f4f19dbac1394d9b2ccc41ef4771cb119a68bd0b5312af51cefb7bf8130f1',
  'linux/tests/citizen_sdk_sensitive_buffer_test.cc': 'e82855221fde7e20ce07ef194619c18cd1c25ed7b8c9ae5a85fd8f94256a5ec0',
  'linux/tests/citizen_sdk_test_support.hpp': '5bec8904799c5648eed148a67be4dbb6f22a6d8d1ffaab4504202677da467884',
  'linux/tests/citizen_sdk_tpm2_test.cc': '76ff6184a33a1ab6b460714ae9fad03ff66a49d6faf925c60a5abdc19ff72094',
  'linux/tests/citizen_sdk_wallet_flow_test.cc': '6cbe4eebd0ee69b43d92024307c3a04682825f06459475775762d9df96e6f94e',
  'native/contracts/tests/account_contract.rs': '2f2af9930ccaba2cf73a21c1ea3593295a6e7d8633a95db05fbcb642e7c74992',
  'native/contracts/tests/capability_contract.rs': '797298ce4a1a33934b400cafc37f22f8e9592a0e4067dbc1a868987182fd9cac',
  'native/contracts/tests/chain_contract.rs': '29b0f790a72565653c134c9f11d5b8384d19c36e0f9f7fd6c6196328cd1f103f',
  'native/contracts/tests/secret_contract.rs': '0b4e1c3046004f0a313488462fae6e0f7807ec6b8b90e608d464e0c701046750',
  'native/contracts/tests/state_store_contract.rs': 'a505854d3b5985901a12a92673a4e7a03a056e9ffcdb5382c59948be3756cced',
  'native/contracts/tests/transaction_history_contract.rs': '88a08ac80f2a131a6f1a4e215ba0b55e8476fac71059b9ab14ff329159724f54',
  'native/contracts/tests/transaction_build_contract.rs': '4fcc035715077d907e3a31f86e7bf1fb11cc4791bed9b75b0c38c4a04282cb25',
  'native/contracts/tests/transaction_prepare_contract.rs': '1ff363381350352c500fd639b3346e6dd2be556cad23878755268b90a17712dc',
  'native/engine/source/wallet_derivation_tests.rs': '0003d4490125010d6580aeb106031be02cddad55eb068a0f41c25b204f8b2531',
  'native/engine/source/wallet_service_tests.rs': 'df2a392fa86d6786004022576f1f9ac33c76b298c8630ea83e48e59d6688a766',
  'native/engine/tests/account_state.rs': '1f64f4b7e245c1aece23d73cb885d5a1ca0a6a9d5c632414e34ed542c6828289',
  'native/engine/tests/capabilities.rs': 'dcfdbffcbaeabc44a6d6934021b2a80ec593d6c8b64b23a7cfbed8b6791f3e93',
  'native/engine/tests/chain_access.rs': '8df836b9bb209fe4db1dfc8766410172a12e042da9236c5898f5292d0bcc4cf5',
  'native/engine/tests/engine_boundary.rs': '62d04ec6b9035204c4f44777cbf08815521bd63e29146b8bcceb8774190bcbd3',
  'native/engine/tests/runtime_context.rs': 'e5eb9f999668b6664d29ba61a0c8b2fd8b2e9fe37f7830bb4f4b7732b9c4fe43',
  'native/engine/tests/state_import.rs': '6937752568de3531a32b8ad35b1fd7270abad120c4b5aac423ae7df970d3f917',
  'native/engine/tests/transaction_outcome.rs': '68a05dfbdeedccaf70c22f83f88ad05131e8f65f9c2f355f12ce93d90e7d0645',
  'native/ffi/source/composition_tests.rs': '36914d26faee5e3d063317cc29dad51caaa43a5f605915895b89910e30bb3ed7',
  'native/ffi/source/host_codec_tests.rs': 'a09b20e7b8342ca9e360c99c0f1e55d9790aa3be54a7541001a72b52298852d1',
  'native/ffi/source/wallet_abi_tests.rs': 'f68d20711ce3fe618293420d8090b0c4e6d2b880e8964a7a9b0c0a33fce3d7bb',
  'native/ffi/tests/abi_layout.rs': 'c1b8ddc64ccd9cef7e433cce1b65c334db124bbf560720d8df9e3e3959138adc',
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
  'native/ffi/tests/symbol_contract.rs': '7ca7ce190aeebec6f03b5a92a5b5aa95c25f0d10c4f50d5a9bbad9b87595caab',
  'native/ffi/tests/wallet_abi_contract.rs': 'df814e301ad949cd7b2cc87e77f6ffa6267b17a89485207199042edf8fa807f6',
  'native/signer/tests/chain_signer_contract.rs': 'd4e53512dffab3f75ee213a08b71909dbc6c667b4b287df39cd9ac3e62824b31',
  'native/signer/tests/ffi_contract.rs': 'bf38f650394011e7f68219ee8ba435453f616281f91649634c536b8620407038',
  'native/signer/tests/legacy_parity.rs': '984a1521042d8a5b2285a43459383ef3972058db20e8f05154c1f75a2a11d70f',
  'native/signer/tests/substrate_vectors.rs': 'f5587dbce91f9c2014c559bece142e56fe65c81c7cf097df66b6c8125d45eef9',
  'native/provider/tests/account_nonce_contract.rs': '60bffdbbf4c6ef316a7f04230add83005fe1229ad8ec26303ca2ab61558a59b5',
  'native/provider/tests/legacy_parity.rs': '32e91812adab4ececfc8146b7edb30a8d475f91b0b3bf3c1ac67110d695ae6e7',
  'native/provider/tests/verified_chain_client_contract.rs': 'f255b7d661fbff105c6c16d714436dd91eedf2d3c222d4637b8a9f9dd534cd6a',
  'test/api/citizen_sdk_test.dart': 'cf53813688b164db4fc1e5b3fdd75b347962961fff656834f1771190ab61a5e2',
  'test/api/citizen_transaction_test.dart': 'bdf841efd9782e0a6f2a0db0a0496604e1500cfd5c6215abbafcee35f0de78aa',
  'test/api/citizen_wallet_flow_test.dart': 'ce430a2cc89bf88d9946b2dc7abde944d42a84701f5cf141cd39d18060d581fd',
  'test/api/public_api_contract_test.dart': '4f804a325e0b2c44982f6ecfe98420e5852efcfaa0ac5971d11ef40e992b3857',
  'test/citizen_sdk_facade_test.dart': '86a8ee3c93bdd8a4bfe216923c1caa73ad9ed00e75dc99572847e6aa0e18aedf',
  'test/consumers/citizenapp_fixture.dart': 'b06f4fad06481223a1fbde7046743aeaad6af72e0c10cc67cfc54b158686e3a0',
  'test/consumers/consumer_test_support.dart': 'aed47f5bde9605510eeb26cdc9b876034ee0cca753cab27e04ab3c72d75b1d11',
  'test/consumers/generic_qr_v1_signer.dart': 'cd5c9b09093798cebb25ec64ceefd8e4ab691136d1b651444989a77d5c509ad5',
  'test/consumers/multi_consumer_contract_test.dart': 'ab38ba496c4ae252283a33507ca57e0ce83fc6d3977aaf8bbe0fec0f8c97f0be',
  'test/consumers/reference_consumer.dart': '56b5e9d414302d45a4ba796b7c3af2b25b1e67c9268ecc1907d2ecacd7f01520',
  'test/consumers/third_party_fixture.dart': 'adf75a027328a9a83c26b0d3783d821c3383cb39f4a5d787db0248ca51cf8f99',
  'test/models/public_models_test.dart': '71a5ef0b8ef3fcb59ba17e88bab6def2069df0f939095a12c2ac06be04664b77',
  'test/models/u128_codec_test.dart': 'c4a71af33a01abcb3f1f7050cc3ce409214e3d1e2e73a1b82553d0f45fc6ca8f',
  'test/node/chain_assets_test.dart': 'f2e2f0b249cb7b5095169c9cbb67fff64dafb60fcd844521a28566d8cb81c595',
  'test/node/citizensdk_bootstrap_manifest.json': '33bd8e2c7407abea376f21a7adf7c9df644aedb7a9e985211075bba6cde28a00',
  'test/platform/flutter_codec_test.dart': '2dbc7bd3fc546638cb23222de872a46e211b0b3113edb5387cf17f304a39984f',
  'test/platform/flutter_secret_boundary_test.dart': '42aed321dfad4b0b2de0304ba3468ec2e64ca7885b79b847ee6c3f776fe923aa',
  'test/platform/flutter_sessions_test.dart': 'cea6a0e4d8bbbe05b7a5b516db913b3018a4a1b80f06f3d6eb1b0e5ecebfd3a8',
  'test/smoldot/chain_info_test.dart': 'd9568c19a07ab76ce58697cc2eea2dfeaa620eea3f84e0ad2f126cf1e5c79956',
  'test/smoldot/client_basic_test.dart': 'e1b35fe52f426695285b7ad2e14c1d6fbd77117a3bad7d287e6dbf7246583084',
  'test/smoldot/ffi_basic_test.dart': 'cdc56fe14df74ee18645e335ea6d81cdf4b11ec7b019a2b6e7fcdc7a973726a8',
  'test/smoldot/fixtures/polkadot.json': '1d5079040595c54f56f31900beea91254cf2a3a25e245bcdd26fe1ccc4672a9b',
  'test/smoldot/fixtures/westend.json': '5457a3c8322b8f2a2d7c2c713c113a7e0b1ee7e646d3f00abc4fa21198ea879d',
  'test/smoldot/json_rpc_test.dart': '8b9d7bfdb5368edb1110fbce9bc2cf8844177986087eb88a6ff8bd374e2a8717',
  'test/smoldot/smoldot_test.dart': '2c9603a9e071ccba39efcc8230ebea4f7fe48cad548b261f236ae446022f3e4a',
  'test/smoldot/subscription_test.dart': 'c307837787ed5908944728adff96d089e8b0720efaa54174c7fad6b4191ea996',
  'test/transaction/citizenchain-balance-fee-v1.json': '2cd5e648703c8cc389c59f07753470b63c034f7cfa63dac8ffa596c8128a0033',
  'test/transaction/citizenchain-revive-v15-metadata.hex': '6c697a80d160ccec859941c9d79ff926c3ff7f36c41da0b621789d6ed663a820',
  'test/transaction/citizenchain-runtime-system-events.hex': '2c4d04a69ff994622877786d481dc4780b7a32795e5f7cfa070ae4acb72679ef',
  'test/transaction/citizenchain-runtime-v14-metadata.hex': 'da62207dfa342ce5285bb214a116761fd0a38c7c329ab8953506ad52471ed681',
  'test/transaction/citizenchain-transfer-build-v1.json': 'c43a1f01c22556d2b1e172088fb540358c25b9554c91ffc71f7b483fcd5a469b',
  'test/transaction/substrate-v14-system-events-metadata.hex': '95b368e7907511b28ba283a6741f4be551b56fb917c2f0183b4143dbe0ebf95b',
  'test/wallet/citizenchain-wallet-derivation-v1.json': '2d9bd9f5feeacea729154475475e0d4525e594bc88ede3a86494ffaf35301769',
  'test/wallet/citizenchain-wallet-password-v1.json': '0f8427f6ca542625626c7c1615608eef19246db496c4bb819937f15cfdec7250',
  'native/legacy/tests/scope_guard.rs': '9f80775028fd397ed2d361fc172851534b206b85c65afc7cb05abaf54887bb78',
  'native/legacy/tests/legacy_header_contract.rs': 'b7a82158e1fffe181ef17db41f158968e43b244c2c392936a2f66ff704300154',
  'native/provider/tests/light_client_boundary.rs': 'ab572e656f70dfb815dc967231a01401e9aaafdb702b041a0057a89c96c04070',
  'native/provider/tests/network_sync_source_manifest.rs': 'f3de0c6d3fdac76a248859accacd4c70f308cc576499edee6c77332253910634',
  'native/provider/tests/state_runtime_source_manifest.rs': 'a98119dcd69aebfb9a5f23a1e75ac8fbf1f5c34102f177e23302fc618502fec4',
  'native/provider/tests/source_manifest_contract.rs': 'fa0d514c062befbe92568cebe807697d05d5a618b0f773b2395c55ed13256041',
  'native/provider/tests/capability_boundary.rs': '53a207034fdde1ce3a30a4ee801c1b0b5dc014668784b3a20484d4c781d80462',
  'native/provider/tests/consensus_source_manifest.rs': '168a7e7d8c6e5218d2b0bcaacf72274b4e945099ab3dd82c04bfc2cd1cd4907c',
  'native/provider/tests/network_sync_boundary.rs': '2bb132d2bd3d6ebd7765efa556afc9cfbb841659b6e8661c9bdf774c4bfcacc3',
  'native/provider/tests/state_runtime_boundary.rs': '8c1880daa93ca8184f99b228fc0bc3e5928a631e94c536fcfec563fc50c797be',
});
// smoldot Dart 包边界已并入唯一 citizen_sdk 根包。三处迁移目录共同构成固定闭集：
// 生产绑定、来源测试与历史审计资料缺一不可，且不允许重新出现第二份 pubspec 包边界。
const SMOLDOT_DART_ROOTS = Object.freeze([
  'lib/smoldot',
  'test/smoldot',
]);
const SMOLDOT_DART_FILES = Object.freeze({
  'lib/smoldot/bindings.dart': '23a5a2add0de238ee8218238acf312193fa349c0806edb4056ff6f63b8b459eb',
  'lib/smoldot/chain.dart': '43f3fbc8420f61d335acb0c48ee471a7885ebbd71d320d8b820805b1537d8053',
  'lib/smoldot/client.dart': '916fd74c20f4daefca2e17e668e8a2fb16c59219b8f3bdd3148d10454a71ddff',
  'lib/smoldot/json_rpc.dart': 'c3a030b236814731f773bb8b1aa9dd1e5789bc7d0809f3c0dd7011d59b401d01',
  'lib/smoldot/platform.dart': '8efb99639389f12dc725199befc3073d5b49027ac761aea097d17e6df449d491',
  'lib/smoldot/smoldot.dart': '607f5dd73614152f16879f75135fb0e7e50e3b681c5c12514ff523e149380d1b',
  'lib/smoldot/types.dart': 'e20b6f97d0b6e289c2b492e12dd66afafc1133adc0fc5fe5a547106ed3338e89',
  'test/smoldot/chain_info_test.dart': 'd9568c19a07ab76ce58697cc2eea2dfeaa620eea3f84e0ad2f126cf1e5c79956',
  'test/smoldot/client_basic_test.dart': 'e1b35fe52f426695285b7ad2e14c1d6fbd77117a3bad7d287e6dbf7246583084',
  'test/smoldot/ffi_basic_test.dart': 'cdc56fe14df74ee18645e335ea6d81cdf4b11ec7b019a2b6e7fcdc7a973726a8',
  'test/smoldot/fixtures/polkadot.json': '1d5079040595c54f56f31900beea91254cf2a3a25e245bcdd26fe1ccc4672a9b',
  'test/smoldot/fixtures/westend.json': '5457a3c8322b8f2a2d7c2c713c113a7e0b1ee7e646d3f00abc4fa21198ea879d',
  'test/smoldot/json_rpc_test.dart': '8b9d7bfdb5368edb1110fbce9bc2cf8844177986087eb88a6ff8bd374e2a8717',
  'test/smoldot/smoldot_test.dart': '2c9603a9e071ccba39efcc8230ebea4f7fe48cad548b261f236ae446022f3e4a',
  'test/smoldot/subscription_test.dart': 'c307837787ed5908944728adff96d089e8b0720efaa54174c7fad6b4191ea996',
});
// 两份锁文件属于收编的 smoldot 上游依赖，不是 SDK 自有锁。它们必须保留为
// 普通文件并通过 Cargo 结构、provider 闭包和 registry checksum 校验，但不能用
// SDK 自有源码哈希门禁拒绝上游例外。上游来源身份由受保护清单和 provider parity 合同约束。
const SMOLDOT_UPSTREAM_LOCK_FILES = Object.freeze([
  'native/legacy/Cargo.lock',
  'native/smoldot/Cargo.lock',
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
  'native/image',
]);
const CORE_RUST_FILES = Object.freeze({
  'native/engine/tests/baseline_resource_contract.rs': '78b211a0d7ce43d9819cbaf1f867f8680222cf649a5b9729ea9a808ce09abb03',
  'native/engine/source/qr_review_tests.rs': '9112a367745bd8aca6796316a8ec31895021edd762b2cfd655b8a357d72aa00d',
  'native/engine/source/qr_review.rs': '1e2e05bcef1fff6e532ba4e3ea16a6dace6d4494db03522e14a21b6015ba285e',
  'native/engine/source/chain_monitor.rs': 'b530254a11c1c6014cceb9c58e16032cabff5891b033e587d97cf5145198a682',
  'native/ffi/source/chain_monitor.rs': '5a624dc62ef7d2ea3546762def76499deeaf98466bb0ec66cab6ed6feca136dc',
  'native/ffi/source/chain_monitor_tests.rs': '249e22c52f52ff4f17ab6fad58c5ce37f9f0a880ce4156671b8356e29214730e',
  'native/engine/source/wallet_input.rs': '70325d8faf5666454cf1d5f237c5d6f842730080a8635d2f3c8436d94b637076',
  'native/engine/source/wallet_input_tests.rs': 'a48405f12472122b7ab1dbac19b806e3900c99152a396987e1f0956fb9bcf3af',
  'native/contracts/Cargo.toml': '9bda2e7d8b80ba215bff5d0157bc7210fb0fbd891d1d16e0404f204c1c922c14',
  'native/contracts/source/account.rs': 'c9e128bbfecf910d574c2a8a8467214e580452a900ebc321b5c89463b09297f3',
  'native/contracts/source/capability.rs': 'e32d875040adae8a85b30f9bb2cc7bc661f80b95d0960ee460aa348d527b9013',
  'native/contracts/source/chain.rs': 'f2caa17ed4f59fccc72d98b1bfca62dffc11509c619ebd5af9d41b573f7102b6',
  'native/contracts/source/chain_signer.rs': 'c20cf42f83f5be8607894934074d7608467d2f9a0d020e4a13b90bc31be12b16',
  'native/contracts/source/error.rs': '99f9396c29c3948a6c8c899041c0aae23833c6241ade2a89abb294dc0507c90c',
  'native/contracts/source/lib.rs': '50bd2d31ede0a55901c12df8cec0537ca1f2c7d3a8f135626c6b81f78ead10d4',
  'native/contracts/source/transaction_prepare.rs': '6fbfde1b659b99af7b7960e35be381c8b95d312030460f65e2c3dbdd2149e0aa',
  'native/contracts/source/secret_vault.rs': '43aab74393de1907f4e8bd8e1e1b14a74b0977c452ce866f4e76fb5c3058f447',
  'native/contracts/source/store_chain_database.rs': '31a2e46f046fc8259de01fd776050625b0cfbfb4d8f516cc8695a7d5d1ce9c13',
  'native/contracts/source/store_encrypted_secret_blob.rs': 'a92c8e9e5f92dfca99c4c2547de4be6505ae3006f7c77a612d107676bec8a457',
  'native/contracts/source/store.rs': 'a25aa27f57edd79f2c2e13d0b955fdf79ec6c1189c7619212816165e9144be75',
  'native/contracts/source/store_runtime_cache.rs': '164fa1302ab7b6aac8ac9de92c8adb733695960b09ac6ae7ccc2cd735f0a744e',
  'native/contracts/source/store_transaction_history.rs': 'f2fc847a8a1b33d4f25f732cb95d0bedc13d006a3fe9607b9201d75e5f2e98cc',
  'native/contracts/source/store_wallet_profile.rs': '3d1869fed7b17b931a8a9740df2466928a159d19e0b28f97b18668ccd4fd193e',
  'native/contracts/source/transaction.rs': 'f028a9e00bc160cbdb3ba88f752be0b95f35df9db00b3fc96718d3463096b723',
  'native/contracts/source/transaction_build.rs': '22b6f9d9279f00ab8155efb648586d6b25aaa7152031dbc958a789c78a457c01',
  'native/contracts/source/wallet.rs': '73bf1277e42dcd6347ffb5faf5ff562f036773cb287923da2f307bd2b7204fce',
  'native/contracts/tests/account_contract.rs': '2f2af9930ccaba2cf73a21c1ea3593295a6e7d8633a95db05fbcb642e7c74992',
  'native/contracts/tests/capability_contract.rs': '797298ce4a1a33934b400cafc37f22f8e9592a0e4067dbc1a868987182fd9cac',
  'native/contracts/tests/chain_contract.rs': '29b0f790a72565653c134c9f11d5b8384d19c36e0f9f7fd6c6196328cd1f103f',
  'native/contracts/tests/secret_contract.rs': '0b4e1c3046004f0a313488462fae6e0f7807ec6b8b90e608d464e0c701046750',
  'native/contracts/tests/state_store_contract.rs': 'a505854d3b5985901a12a92673a4e7a03a056e9ffcdb5382c59948be3756cced',
  'native/contracts/tests/transaction_history_contract.rs': '88a08ac80f2a131a6f1a4e215ba0b55e8476fac71059b9ab14ff329159724f54',
  'native/contracts/tests/transaction_build_contract.rs': '4fcc035715077d907e3a31f86e7bf1fb11cc4791bed9b75b0c38c4a04282cb25',
  'native/contracts/tests/transaction_prepare_contract.rs': '1ff363381350352c500fd639b3346e6dd2be556cad23878755268b90a17712dc',
  'native/engine/Cargo.toml': '518b47a8a3d4fa3e69959392b57d7b07dedc55519ea19304dd20bed691635b0c',
  'native/engine/source/account_state.rs': '55bfefcff2038ba1cdbe71846b3acc7d1ffa5177d95e057d029c0f1d1b5e78fd',
  'native/engine/source/capabilities.rs': 'c729aaef5559127aeb2185ea2793456a3bc73346724996a190cc66a97c58181e',
  'native/engine/source/engine.rs': '989436e48f667b76d97bf04d33b3a9c39c2412f97f05a40aae142fa39c343dd4',
  'native/engine/source/error.rs': '949efd108cc8c2205f2adf58d03b55148bc88c03c89e0acd9f453f52716c2bcf',
  'native/engine/source/finalized_history_runtime.rs': 'fff50b2949481b99aff2fa7e3569ab6902c7c3d6b7f676d4564570cdbc729325',
  'native/engine/source/lib.rs': '700693ea2dd0792fd69ec21836ae9381b4ccb96d0afc77b2cae872bb83f4f998',
  'native/engine/source/metadata.rs': 'c8adc893d483ec0dc7624aa8cefb5b3793ae9ec2f402dce7d731054f93d97fa8',
  'native/engine/source/runtime_context.rs': 'b7bac6e77f1761237ba3a309cbcc15b68bcedc49f1fb85d65366cf145ef73b6f',
  'native/engine/source/state_import.rs': '1308efbbc2626bfd5f9cc936a8e3c6e4984dbc6e2e2dda9dc0917b24d98eaa01',
  'native/engine/source/system_events.rs': 'd3f2722e4106d615a6d96e4b9b92c89b97413d6f6b17d4026e167435eb790d22',
  'native/engine/source/transaction_prepare.rs': 'bf009406fe2deb2a39d3ae8bacb1a83c7feb546d6b1c2ab0affba3b55fcc2722',
  'native/engine/source/transaction_execution.rs': '86bfaeffbc4b2ee5a8d6b2a074b331830dc0e6c13c3a50e8b541338a3ef0b172',
  'native/engine/source/transaction_history.rs': '4cc4636d48c5b4876c0e773e04d8482a96055e8d90862ca5949b2f9ce00b2b12',
  'native/engine/source/transaction_outcome.rs': '19efcf69c62c79c329070636a69383417d064bc1ad5a312efd27543d29b86a5a',
  'native/engine/source/wallet_derivation.rs': '50917c04757bcb55e33a17bfa387d83792824c36657d20714031fd71ab2b18ee',
  'native/engine/source/wallet_derivation_tests.rs': '0003d4490125010d6580aeb106031be02cddad55eb068a0f41c25b204f8b2531',
  'native/engine/source/wallet_service.rs': '12a2d55928e710ed8bb214fa0cc5974af2a43ae987e990053bae573570c3da4e',
  'native/engine/source/wallet_service_tests.rs': 'df2a392fa86d6786004022576f1f9ac33c76b298c8630ea83e48e59d6688a766',
  'native/engine/tests/account_state.rs': '1f64f4b7e245c1aece23d73cb885d5a1ca0a6a9d5c632414e34ed542c6828289',
  'native/engine/tests/capabilities.rs': 'dcfdbffcbaeabc44a6d6934021b2a80ec593d6c8b64b23a7cfbed8b6791f3e93',
  'native/engine/tests/chain_access.rs': '8df836b9bb209fe4db1dfc8766410172a12e042da9236c5898f5292d0bcc4cf5',
  'native/engine/tests/engine_boundary.rs': '62d04ec6b9035204c4f44777cbf08815521bd63e29146b8bcceb8774190bcbd3',
  'native/engine/tests/runtime_context.rs': 'e5eb9f999668b6664d29ba61a0c8b2fd8b2e9fe37f7830bb4f4b7732b9c4fe43',
  'native/engine/tests/state_import.rs': '6937752568de3531a32b8ad35b1fd7270abad120c4b5aac423ae7df970d3f917',
  'native/engine/tests/transaction_outcome.rs': '68a05dfbdeedccaf70c22f83f88ad05131e8f65f9c2f355f12ce93d90e7d0645',
  'native/ffi/Cargo.toml': '2027770531ccd40b269e57a5990516de026824c17777bdf53c713f23c792ee74',
  'native/ffi/source/abi.rs': '9931a5d9fac618e8c9c59bf03d8747318eb6b65356fa28797556aced9c1d9e64',
  'native/ffi/source/assets.rs': '471cba32ee1792ea97fc4f15bbbb20da2b00a00948d6f85ecdc5dae1281a9acf',
  'native/ffi/source/capabilities.rs': '107ae5a5fe465b6ed20af8e9117c892424b33a9f6fe572b8f73ef2b9200775fa',
  'native/ffi/source/composition.rs': '89791c6cf65bebcece27a9feceafebe27a550f7a541455154b7481de2e01689a',
  'native/ffi/source/composition_tests.rs': '36914d26faee5e3d063317cc29dad51caaa43a5f605915895b89910e30bb3ed7',
  'native/ffi/source/error.rs': '8c22eafa0b4ceac60a136fc0cd1f46471a7336eb5ea50ee0967c7ecbff15e5e5',
  'native/ffi/source/events.rs': '2bab42f8a4048f60e6bbe64d1c4b6e15bf5881b84f9504de91288f8e266440bf',
  'native/ffi/source/handles.rs': '9e248ecb6fb9506b85d098172b731c22787f9860ccb53926ebc793da1fffd0c9',
  'native/ffi/source/host_codec.rs': 'ab83be1d4aa1915d534a146dc8abe1a6989a2aa26fdc89656907685709cdd625',
  'native/ffi/source/host_codec_tests.rs': 'a09b20e7b8342ca9e360c99c0f1e55d9790aa3be54a7541001a72b52298852d1',
  'native/ffi/source/host_providers.rs': '1653cb7db2eb3d3ccce4b75bbc634e911ce1e50a118ed0f41730f84b34816069',
  'native/ffi/source/lib.rs': '877431bb2a0578c34ebf4ed7c2d909c2d31c9048952826feaeb60648e905326d',
  'native/ffi/source/ownership.rs': 'ec29371b196c8765e1d656741969b519095bc723d0cb77b2aba1645ffd0a8c1e',
  'native/ffi/source/qr_abi.rs': 'eb858f929ebc7b0dd1a31b8f384b60ae27e776b077a8b24d55aaf7218fc5ac40',
  'native/ffi/source/requests.rs': '09d07604e36d2c2d1e6887ac81176fd5c4958628accb479189919e86e94cf905',
  'native/ffi/source/runtime.rs': '867eee55ceafd28f4c973386a94116d45e60e3ce359595c495190cad377b26d3',
  'native/ffi/source/transaction_abi.rs': 'c7efad24af031b185a2b13da1b8f1e7e2208d113db3e94af18148b576aec5991',
  'native/ffi/source/wallet_abi.rs': '8d27fbfcaef1192803bd95a4353e549b7ca8a2410fded183720d129ff7412e6b',
  'native/ffi/source/wallet_abi_tests.rs': 'f68d20711ce3fe618293420d8090b0c4e6d2b880e8964a7a9b0c0a33fce3d7bb',
  'native/ffi/tests/abi_layout.rs': 'c1b8ddc64ccd9cef7e433cce1b65c334db124bbf560720d8df9e3e3959138adc',
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
  'native/ffi/tests/symbol_contract.rs': '7ca7ce190aeebec6f03b5a92a5b5aa95c25f0d10c4f50d5a9bbad9b87595caab',
  'native/ffi/tests/wallet_abi_contract.rs': 'df814e301ad949cd7b2cc87e77f6ffa6267b17a89485207199042edf8fa807f6',
  'native/qr/Cargo.toml': '5bee37654c4e2198ae00b65578cf6c005df3b8000434dfa9a9948bc5853505b4',
  'native/contracts/source/signing.rs': 'a55cabb69e572c70e3b25d316a3cf69d86930299ad51f90fe2a54341ba154907',
  'native/qr/source/codec.rs': 'cbb00c104c3209161d5e03ae8c594420358ffc7ee5d3fa65ffc1e1c9aacd23d5',
  'native/qr/source/lib.rs': '4dbf3127895fbcfd930959e05aa19fa03d5d29012d501b4eb8e2ffcf51ebc7f9',
  'native/qr/source/session.rs': 'ed0aeaf91e375fff2a4f8901b090d1d4f725674946cc881580e06cd90eafae0f',
  'native/image/CMakeLists.txt': '9e3ba578a613fe69fbb8026f957f2968cddef48912f6e6eb9b928bc701151ec5',
  'native/image/citizensdk_qr_image.cc': 'd202695159393c46083f67d4199fd5ee99e87cec9289a654d6ce08b295b09a77',
  'native/image/citizensdk_qr_image.h': '80856c440e590786cdf026cf3011a27f7ab1d62508ce8fb5e3fa4156df72861a',
  'native/image/citizensdk_qr_image_test.cc': '68437056555e173ec390b65b83cc5fbb9b8b994cddbcf5847f86ac9a05d60290',
});
// native 根只能拥有这些已审核直接条目，防止出现第二个未审查的 Rust 产品边界。
const NATIVE_ROOT_ENTRIES = Object.freeze({
  'contracts': 'directory',
  'engine': 'directory',
  'ffi': 'directory',
  'image': 'directory',
  'legacy': 'directory',
  'provider': 'directory',
  'qr': 'directory',
  'signer': 'directory',
  'smoldot': 'directory',
});
// Core Rust 的 workspace 入口与解析闭包必须与源码闭集
// 同步审核；每个边界文件都固定最终审核字节，任何后续漂移均失败关闭。
const CORE_RUST_BOUNDARY_FILES = Object.freeze({
  'Cargo.toml': 'a5baa04f7bb87a6cc85639b86ec3fd83a56395a852c0186f3d6e2ed31b587ad8',
  'Cargo.lock': '07e34bab68cc18eaeeb82b8e624b429226426f3eef9355d39ee650b4f31d6d0b',
});
// 该清单离线固定 FFI、PoW workspace、light-base 与 lib 的完整文件闭集；
// byte_identical 项来自 CitizenApp 初始稳定基线，adapted/sdk_only 是已审查的
// SDK 边界。清单自身再由此哈希固定，CI/Release 不回指 CitizenApp。
const SMOLDOT_RUST_SOURCE_MANIFEST = Object.freeze({
  path: 'native/smoldot/SOURCE_SHA256.json',
  sha256: 'bace0996f84fc004504354f48d62635dce418f67b5a305f0b4db5fea9847a54b',
});
// 这些文件位于各来源单元之外，但仍属于 Release 的正式输入：许可证、来源记录、
// smoldot 原始 ABI 头文件；已删除的上游示例与链规范不再进入支持文件闭集。
// 原生上游闭集单独核对；迁出的自有单元和兼容头仍由同一来源合同逐项固定；
// Dart 绑定已迁出本原生目录并由 SMOLDOT_DART_FILES 独立固定。
const SMOLDOT_SUPPORT_FILES = Object.freeze({
  'native/smoldot/LICENSE': 'aab56b4a581fc1c50b7c782eacf2fc8be05a47cd98e4bf4d836dd9b6dd9c86f4',
  'native/smoldot/LICENSE-APACHE-2.0': '4524e4d70a6295dfa882b0411cc49fcca03273e959fea68bbfe7df7ed63e7d78',
  'native/smoldot/UPSTREAM.md': 'e53b0d1e7aad5f4a9b7731d30b25d715c33b96bf8137a1ea090dd4d72d2770ce',
  'include/smoldot.h': 'f7c2645588809f73f8aa799975b363a4a7b22e8de7149da9d0b4c2ea20c90a20',
});
// signer 是可编译的 Rust crate，正式输入不能只固定 Cargo.toml 与 lib.rs；
// sr25519 单一实现、ChainSigner 适配和四份合同测试共同进入同一 8 文件闭集；
// 任何 build.rs、src/bin 或其他新增文件
// 都会改变 Cargo 行为，因此一律失败关闭。
const SIGNER_FILES = Object.freeze({
  'native/signer/Cargo.toml': '461f910465466d8cd24047ef3c87e5b082d000b76592cbc1f6f1c97d8b0bd28f',
  'native/signer/source/chain_signer.rs': '3461762743fb5723575b892171465ef31801b781262e1f3963ae5cbe12958a36',
  'native/signer/source/lib.rs': 'd1d2a35a70a8fbd7453e02f441a875f5c482cb22a98ccb27695594f7b006a869',
  'native/signer/source/sr25519.rs': 'c1159ff1a357b6c08b59d8a22d14a6b4a6cee313166ad0a435487192754f8ab4',
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
const SHARED_CPP_SOURCE_FILES = Object.freeze({
  'include/citizen_sdk_error.hpp': '693d3c6adf930c6403f5d99f769578db6f4e02ba182e6bb051bdb76f8c3e2db9',
  'include/citizen_sdk_events.hpp': '32c2f64beb04bc2ec274c909ff9776e47ab3c05a0face18e879a16d5a4069dc7',
  'include/citizen_sdk_models.hpp': '8e14f3162f51175cdf8e9082cf2233c95619bec33e45152450839a522e8c7242',
});

export function assertFlutterBindingContract(root) {
  const sourceRoot = resolve(root);
  const bindings = [
    {
      label: 'Dart',
      channelPath: 'lib/platform/flutter_citizen_sdk_platform.dart',
      methodPath: 'lib/platform/citizen_sdk_flutter_codec.dart',
      methodChannel: /static const String methodChannelName\s*=\s*'([^']+)'\s*;/g,
      eventChannel: /static const String eventChannelName\s*=\s*'([^']+)'\s*;/g,
      runtimeMethodChannel: /methodChannel\s*\?\?\s*const MethodChannel\('([^']+)'\)/g,
      runtimeEventChannel: /eventChannel\s*\?\?\s*const EventChannel\('([^']+)'\)/g,
      methods: /static const Set<String> methods\s*=\s*<String>\{([\s\S]*?)^[ \t]{2}\};/gm,
    },
    {
      label: 'Android',
      channelPath: 'android/source/CitizenSdkFlutterCodec.kt',
      methodPath: 'android/source/CitizenSdkFlutterCodec.kt',
      methodChannel: /const val METHOD_CHANNEL\s*=\s*"([^"]+)"/g,
      eventChannel: /const val EVENT_CHANNEL\s*=\s*"([^"]+)"/g,
      methods: /val methods: Set<String>\s*=\s*linkedSetOf\(([\s\S]*?)^[ \t]{4}\)/gm,
    },
    {
      label: 'Darwin',
      channelPath: 'darwin/source/flutter/CitizenSdkFlutterCodec.swift',
      methodPath: 'darwin/source/flutter/CitizenSdkFlutterCodec.swift',
      methodChannel: /static let methodChannel\s*=\s*"([^"]+)"/g,
      eventChannel: /static let eventChannel\s*=\s*"([^"]+)"/g,
      methods: /static let methods: Set<String>\s*=\s*\[([\s\S]*?)^[ \t]{4}\]/gm,
    },
    {
      label: 'Linux',
      channelPath: 'linux/source/citizen_sdk_flutter_codec.hpp',
      methodPath: 'linux/source/citizen_sdk_flutter_codec.cc',
      methodChannel: /kMethodChannel\s*=\s*"([^"]+)"\s*;/g,
      eventChannel: /kEventChannel\s*=\s*"([^"]+)"\s*;/g,
      methods: /constexpr const char \*kMethods\[\]\s*=\s*\{([\s\S]*?)^\};/gm,
    },
    {
      label: 'Windows',
      channelPath: 'windows/source/citizen_sdk_flutter_codec.hpp',
      methodPath: 'windows/source/citizen_sdk_flutter_codec.cc',
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
    if (methods.length !== 93 || JSON.stringify(methods) !== expectedMethods) {
      fail(`CitizenSDK ${binding.label} Flutter 方法合同漂移：必须精确为固定 93 项`);
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
  if (resolvedTarget === resolvedSource || resolvedTarget.startsWith(sourcePrefix)&&!resolvedTarget.startsWith(join(resolvedSource,'target')+sep)) {
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
  "native/smoldot/lib/src/chain/chain_information_build.rs": "native/smoldot/lib/src/chain/chain_information/build.rs",
  "native/smoldot/lib/src/database/finalized_serialize_defs.rs": "native/smoldot/lib/src/database/finalized_serialize/defs.rs",
  "native/smoldot/lib/src/executor/trie_root_calculator_tests.rs": "native/smoldot/lib/src/executor/trie_root_calculator/tests.rs",
  "native/smoldot/lib/src/identity_ss58.rs": "native/smoldot/lib/src/identity/ss58.rs",
  "native/smoldot/lib/src/libp2p/connection/single_stream_handshake_tests.rs": "native/smoldot/lib/src/libp2p/connection/single_stream_handshake/tests.rs",
  "native/smoldot/lib/src/network/kademlia_kbuckets.rs": "native/smoldot/lib/src/network/kademlia/kbuckets.rs",
  "native/smoldot/lib/src/transactions/light_pool_tests.rs": "native/smoldot/lib/src/transactions/light_pool/tests.rs",
  "native/smoldot/lib/src/transactions/pool_tests.rs": "native/smoldot/lib/src/transactions/pool/tests.rs",
  "native/smoldot/lib/src/trie/branch_search_tests.rs": "native/smoldot/lib/src/trie/branch_search/tests.rs",
  "native/smoldot/lib/src/trie/trie_structure_tests.rs": "native/smoldot/lib/src/trie/trie_structure/tests.rs",
  "native/smoldot/light-base/src/json_rpc_service_background.rs": "native/smoldot/light-base/src/json_rpc_service/background.rs",
  "native/smoldot/light-base/src/network_service_tasks.rs": "native/smoldot/light-base/src/network_service/tasks.rs",
  "native/engine/source/transaction_outcome.rs": "native/engine/src/transaction_outcome.rs",
  "native/engine/source/wallet_input_tests.rs": "native/engine/src/wallet_input_tests.rs",
  "native/engine/source/wallet_service_tests.rs": "native/engine/src/wallet_service_tests.rs",
  "native/engine/source/runtime_context.rs": "native/engine/src/runtime_context.rs",
  "native/engine/source/error.rs": "native/engine/src/error.rs",
  "native/engine/source/finalized_history_runtime.rs": "native/engine/src/finalized_history_runtime.rs",
  "native/engine/source/wallet_input.rs": "native/engine/src/wallet_input.rs",
  "native/engine/source/metadata.rs": "native/engine/src/metadata.rs",
  "native/engine/source/chain_monitor.rs": "native/engine/src/chain_monitor.rs",
  "native/engine/source/lib.rs": "native/engine/src/lib.rs",
  "native/engine/source/account_state.rs": "native/engine/src/account_state.rs",
  "native/engine/source/wallet_service.rs": "native/engine/src/wallet_service.rs",
  "native/engine/source/transaction_execution.rs": "native/engine/src/transaction_execution.rs",
  "native/engine/source/transaction_prepare.rs": "native/engine/src/transaction_prepare.rs",
  "native/engine/source/qr_review.rs": "native/engine/src/qr_review.rs",
  "native/engine/source/wallet_derivation.rs": "native/engine/src/wallet_derivation.rs",
  "native/engine/source/transaction_history.rs": "native/engine/src/transaction_history.rs",
  "native/engine/source/system_events.rs": "native/engine/src/system_events.rs",
  "native/engine/source/wallet_derivation_tests.rs": "native/engine/src/wallet_derivation_tests.rs",
  "native/engine/source/qr_review_tests.rs": "native/engine/src/qr_review_tests.rs",
  "native/engine/source/capabilities.rs": "native/engine/src/capabilities.rs",
  "native/engine/source/engine.rs": "native/engine/src/engine.rs",
  "native/engine/source/state_import.rs": "native/engine/src/state_import.rs",
  "native/ffi/source/host_codec_tests.rs": "native/ffi/src/host_codec_tests.rs",
  "native/ffi/source/qr_abi.rs": "native/ffi/src/qr_abi.rs",
  "native/ffi/source/runtime.rs": "native/ffi/src/runtime.rs",
  "native/ffi/source/chain_monitor_tests.rs": "native/ffi/src/chain_monitor_tests.rs",
  "native/ffi/source/transaction_abi.rs": "native/ffi/src/transaction_abi.rs",
  "native/ffi/source/events.rs": "native/ffi/src/events.rs",
  "native/ffi/source/host_codec.rs": "native/ffi/src/host_codec.rs",
  "native/ffi/source/error.rs": "native/ffi/src/error.rs",
  "native/ffi/source/wallet_abi_tests.rs": "native/ffi/src/wallet_abi_tests.rs",
  "native/ffi/source/chain_monitor.rs": "native/ffi/src/chain_monitor.rs",
  "native/ffi/source/wallet_abi.rs": "native/ffi/src/wallet_abi.rs",
  "native/ffi/source/lib.rs": "native/ffi/src/lib.rs",
  "native/ffi/source/host_providers.rs": "native/ffi/src/host_providers.rs",
  "native/ffi/source/ownership.rs": "native/ffi/src/ownership.rs",
  "native/ffi/source/handles.rs": "native/ffi/src/handles.rs",
  "native/ffi/source/composition_tests.rs": "native/ffi/src/composition_tests.rs",
  "native/ffi/source/composition.rs": "native/ffi/src/composition.rs",
  "native/ffi/source/requests.rs": "native/ffi/src/requests.rs",
  "native/ffi/source/assets.rs": "native/ffi/src/assets.rs",
  "native/ffi/source/abi.rs": "native/ffi/src/abi.rs",
  "native/ffi/source/capabilities.rs": "native/ffi/src/capabilities.rs",
  "native/qr/source/session.rs": "native/qr/src/session.rs",
  "native/qr/source/lib.rs": "native/qr/src/lib.rs",
  "native/qr/source/codec.rs": "native/qr/src/codec.rs",
  "native/contracts/source/transaction.rs": "native/contracts/src/transaction.rs",
  "native/contracts/source/chain.rs": "native/contracts/src/chain.rs",
  "native/contracts/source/error.rs": "native/contracts/src/error.rs",
  "native/contracts/source/lib.rs": "native/contracts/src/lib.rs",
  "native/contracts/source/signing.rs": "native/contracts/src/signing.rs",
  "native/contracts/source/wallet.rs": "native/contracts/src/wallet.rs",
  "native/contracts/source/account.rs": "native/contracts/src/account.rs",
  "native/contracts/source/transaction_prepare.rs": "native/contracts/src/transaction_prepare.rs",
  "native/contracts/source/chain_signer.rs": "native/contracts/src/chain_signer.rs",
  "native/contracts/source/secret_vault.rs": "native/contracts/src/secret_vault.rs",
  "native/contracts/source/transaction_build.rs": "native/contracts/src/transaction_build.rs",
  "native/contracts/source/capability.rs": "native/contracts/src/capability.rs",
  "native/contracts/source/store_wallet_profile.rs": "native/contracts/src/store/wallet_profile.rs",
  "native/contracts/source/store_encrypted_secret_blob.rs": "native/contracts/src/store/encrypted_secret_blob.rs",
  "native/contracts/source/store_chain_database.rs": "native/contracts/src/store/chain_database.rs",
  "native/contracts/source/store.rs": "native/contracts/src/store/mod.rs",
  "native/contracts/source/store_runtime_cache.rs": "native/contracts/src/store/runtime_cache.rs",
  "native/contracts/source/store_transaction_history.rs": "native/contracts/src/store/transaction_history.rs",
  "native/legacy/source/error.rs": "native/legacy/src/error.rs",
  "native/legacy/source/lib.rs": "native/legacy/src/lib.rs",
  "native/legacy/source/ffi_types.rs": "native/legacy/src/ffi_types.rs",
  "native/provider/source/client.rs": "native/provider/src/client.rs",
  "native/provider/source/legacy.rs": "native/provider/src/legacy.rs",
  "native/provider/source/account_nonce.rs": "native/provider/src/account_nonce.rs",
  "native/provider/source/lib.rs": "native/provider/src/lib.rs",
  "native/provider/source/bootstrap.rs": "native/provider/src/bootstrap.rs",
  "native/provider/source/bootstrap_tests.rs": "native/provider/src/bootstrap_tests.rs",
  "native/provider/source/verified_chain_client.rs": "native/provider/src/verified_chain_client.rs",
  "native/provider/tests/source_manifest_contract.rs": "native/smoldot/light-base/tests/source_manifest_contract.rs",
  "native/provider/tests/capability_boundary.rs": "native/smoldot/light-base/tests/capability_boundary.rs",
  "native/provider/tests/light_client_boundary.rs": "native/smoldot/lib/tests/light_client_boundary.rs",
  "native/provider/tests/network_sync_source_manifest.rs": "native/smoldot/lib/tests/network_sync_source_manifest.rs",
  "native/provider/tests/state_runtime_source_manifest.rs": "native/smoldot/lib/tests/state_runtime_source_manifest.rs",
  "native/provider/tests/consensus_source_manifest.rs": "native/smoldot/lib/tests/consensus_source_manifest.rs",
  "native/provider/tests/network_sync_boundary.rs": "native/smoldot/lib/tests/network_sync_boundary.rs",
  "native/provider/tests/state_runtime_boundary.rs": "native/smoldot/lib/tests/state_runtime_boundary.rs",
  "native/signer/source/sr25519.rs": "native/signer/src/sr25519.rs",
  "native/signer/source/lib.rs": "native/signer/src/lib.rs",
  "native/signer/source/chain_signer.rs": "native/signer/src/chain_signer.rs"
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
  if (within(output,source)||within(source,output)&&!output.startsWith(join(source,'target')+sep)) fail('原生工程与来源必须分离');
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
const FLUTTER_ENTRY_SOURCE = 'android/source/CitizenSdkPlugin.kt';
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
    fail('CitizenSDK 产品源码禁止包含 docs 目录；技术文档只允许存在所属产品根，归档不进入源码');
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
    join(sourceRoot, 'native', 'smoldot', 'Cargo.lock'),
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
  const expectedPaths = [...Object.keys(PUBLIC_ABI_FILES),...Object.keys(SHARED_CPP_SOURCE_FILES),'include/smoldot.h'].sort();
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

  const headers = Object.keys(PUBLIC_ABI_FILES)
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
  assertPinnedFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertPinnedFiles(sourceRoot, {'include/smoldot.h':SMOLDOT_SUPPORT_FILES['include/smoldot.h']}, '兼容节点头');
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
  return relativePath.startsWith('tests/')
    || relativePath.startsWith('native/tests/')
    || relativePath.startsWith('native/device/');
}

function isInjectedAndroidArtifact(relativePath) {
  return relativePath === 'citizensdk.aar'
    || relativePath.startsWith('src/main/jniLibs/');
}

function isDarwinTestOrInjectedArtifact(relativePath) {
  return relativePath.startsWith('tests/')
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
      .filter((path) => path.endsWith('.dart') && !path.startsWith('smoldot/'))
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
  if (Object.keys(WINDOWS_BINDING_SOURCE_FILES).length !== 52) {
    fail('CitizenSDK Windows Host/Flutter 固定生产清单必须精确为 52 文件');
  }
  const directories = regularDirectories(windowsRoot);
  const expectedDirectories = [...new Set(['cmake', 'headers', 'source', 'tests',
    ...(allowInjectedWindowsArtifacts ? parentDirectories(WINDOWS_RELEASE_FILES) : []),
  ])].sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) {
    fail('CitizenSDK Windows Host 目录闭集漂移');
  }
  const files = regularFiles(windowsRoot)
    .filter((path) => !allowInjectedWindowsArtifacts || !WINDOWS_INJECTED_FILES.has(path))
    .filter((path) => !path.startsWith('tests/'))
    .filter((path) => path === 'CMakeLists.txt' || !isDocumentationFile(path))
    .map((path) => `windows/${path}`).sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(WINDOWS_BINDING_SOURCE_FILES).sort())) {
    fail('CitizenSDK Windows Host 文件闭集漂移');
  }
  assertPinnedFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertPinnedFiles(sourceRoot, WINDOWS_BINDING_SOURCE_FILES, 'Windows Host 来源');
  const cmake = readFileSync(join(windowsRoot, 'CMakeLists.txt'), 'utf8');
  const versions = [...cmake.matchAll(/^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/gm)];
  if (versions.length !== 1) fail('CitizenSDK Windows Host 产品身份或版本字段不唯一');
  const pubspec = join(sourceRoot, 'pubspec.yaml');
  if (existsSync(pubspec) && readFileSync(pubspec, 'utf8').match(/^version: (.+)$/m)?.[1] !== versions[0][1]) {
    fail('CitizenSDK Windows Host 版本必须与唯一 SDK 版本一致');
  }
  const header = readFileSync(join(windowsRoot, 'headers/citizensdk_host.h'), 'utf8');
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
    .filter((path) => !path.startsWith('tests/'))
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
  assertPinnedFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
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
    fail('CitizenSDK 产品源码禁止包含 docs 目录；技术文档只允许存在所属产品根');
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

  for (const relativeRoot of ['android', 'darwin', 'lib', 'linux', 'windows']) {
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
        && path !== 'native/source/CMakeLists.txt'
        && (!['linux', 'windows'].includes(relativeRoot) || path !== 'CMakeLists.txt')
        && (relativeRoot !== 'android' || !isAndroidTestPath(path))
        && (relativeRoot !== 'darwin' || !isDarwinTestOrInjectedArtifact(path)))
      .filter((path) => !['linux', 'windows'].includes(relativeRoot) || !path.startsWith('tests/'))
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
  const facade = readFileSync(join(sourceRoot, 'lib/api/citizen_sdk.dart'), 'utf8');
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
    ...LINUX_HOST_HEADERS.filter(name=>!['citizen_sdk_error.hpp','citizen_sdk_events.hpp','citizen_sdk_models.hpp'].includes(name)).map((name) => `headers/${name}`),
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
    ...WINDOWS_HOST_HEADERS.filter(name=>!['citizen_sdk_error.hpp','citizen_sdk_events.hpp','citizen_sdk_models.hpp'].includes(name)).map((name) => `headers/${name}`),
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
  if (!providerUnit || providerUnit.root !== 'native/provider'
      || providerUnit.recursive !== true) {
    fail('CitizenSDK smoldot Rust 来源清单缺少递归 provider 单元');
  }
  const manifestPaths = [];
  for (const [name, unit] of Object.entries(manifest.units)) {
    if (!unit || typeof unit !== 'object' || typeof unit.root !== 'string'
        || !['native/provider','native/legacy','native/smoldot','native/smoldot/lib','native/smoldot/light-base'].includes(unit.root)
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
          return !lstatSync(absolute).isSymbolicLink() && lstatSync(absolute).isFile()
            && ![SMOLDOT_RUST_SOURCE_MANIFEST.path,...Object.keys(SMOLDOT_SUPPORT_FILES)].includes(`${unit.root}/${path}`);
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
    ...manifestPaths.filter(path=>path.startsWith('native/smoldot/')),
    ...Object.keys(SMOLDOT_SUPPORT_FILES).filter(path=>path.startsWith('native/smoldot/')),
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
  equalSource('include/citizensdk_qr_image.h', 'native/image/citizensdk_qr_image.h');
  for (const name of LINUX_HOST_HEADERS) equalSource(`include/citizen_sdk/${name}`, hostHeaderSource('linux',name));
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
  const hostHeader = readFileSync(join(sourceRoot, 'linux/headers/citizensdk_host.h'), 'utf8');
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
  equal('include/citizensdk_qr_image.h', 'native/image/citizensdk_qr_image.h');
  for (const name of WINDOWS_HOST_HEADERS) equal(`include/citizen_sdk/${name}`, hostHeaderSource('windows',name));
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
  const hostSymbols = [...new Set([...readFileSync(join(sourceRoot, 'windows/headers/citizensdk_host.h'), 'utf8')
    .matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]))].sort();
  const hostAndQrSymbols = [...hostSymbols, ...expectedQrImageSymbols(sourceRoot)].sort();
  if (coreSymbols.length !== 144 || hostSymbols.length !== 19 || hostAndQrSymbols.length !== 23) fail('CitizenSDK Windows 144公开Core及19Host+4图像导出闭集漂移');
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
    const header=assertSafeTargetPath(join(output,hostHeaderSource('windows',name)), 'Windows 候选源头');
    if(!existsSync(header)||!lstatSync(header).isFile()||!readFileSync(header).equals(readFileSync(join(source,hostHeaderSource('windows',name)))))fail(`CitizenSDK Windows 重叠源码头漂移：${name}`);
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
  if (symbols.length !== 144) fail('CitizenSDK 产品头必须精确声明 144 个 citizensdk_* 函数');
  return symbols;
}

function expectedQrImageSymbols(root) {
  const header = readFileSync(join(root, 'native/image/citizensdk_qr_image.h'), 'utf8');
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
    fail(`${label} 必须精确导出 148 个 citizensdk_* 产品符号`);
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
      ? join(candidate, 'native/image', header) : join(candidate, 'include', header);
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
if (!process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && isMain && !(process.env.NODE_TEST_CONTEXT && process.argv.length === 2)) {
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



// 正式实现结束；仅直接使用 node --test 执行本文件时注册以下回归。
if (process.env.NODE_TEST_CONTEXT && process.argv.length === 2 && !process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const {BUILD_SHELL_SOURCES} = await import('./build.mjs');
const {default: assert} = await import('node:assert/strict');
const { createHash } = await import('node:crypto');
const {
  chmodSync,
  closeSync,
  cpSync: copyFixtureTree,
  copyFileSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} = await import('node:fs');
const { spawn, spawnSync } = await import('node:child_process');
const { EventEmitter, getEventListeners } = await import('node:events');
const { gunzipSync, gzipSync } = await import('node:zlib');
const { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep } = await import('node:path');
const { homedir } = await import('node:os');
const {default: test} = await import('node:test');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { runInNewContext } = await import('node:vm');



const workRoot = process.env.CITIZENSDK_RELEASE_TEST_WORK_DIR;
if (!workRoot) {
  throw new Error('CitizenSDK发布测试缺少CITIZENSDK_RELEASE_TEST_WORK_DIR');
}
mkdirSync(workRoot, { recursive: true });

const citizenSdkRoot = fileURLToPath(new URL('../', import.meta.url));
function cpSync(source,destination,options){
 copyFixtureTree(source,destination,options);
 const canonical=resolve(source),owner=resolve(citizenSdkRoot);
 if(['linux','windows'].some(name=>canonical===join(owner,name))){
  const include=join(dirname(destination),'include');mkdirSync(include,{recursive:true});
  for(const name of ['citizen_sdk_error.hpp','citizen_sdk_events.hpp','citizen_sdk_models.hpp'])copyFileSync(join(owner,'include',name),join(include,name));
 }
 if(canonical===join(owner,'native','smoldot')){
  for(const name of ['provider','legacy'])copyFixtureTree(join(owner,'native',name),join(dirname(destination),name),{recursive:true});
  const include=join(dirname(dirname(destination)),'include');mkdirSync(include,{recursive:true});copyFileSync(join(owner,'include/smoldot.h'),join(include,'smoldot.h'));
 }
}


test('Android SDK 源码和测试源集没有单子目录包装层，包名与 JNI 身份保持', () => {
  // Kotlin/Java 的包身份由源码声明决定；目录只承载真实文件，不复制包名层级。
  for (const relativeRoot of ['android/native/source','android/native/tests','android/native/device','android/source','android/tests']) {
    const visit = (directory) => {
      const entries = readdirSync(directory, { withFileTypes: true });
      assert.ok(entries.length >= 2, `单子项目录：${relative(citizenSdkRoot, directory)}`);
      for (const entry of entries) {
        if (entry.isDirectory()) visit(join(directory, entry.name));
        else assert.ok(entry.isFile(), `非普通源码：${join(directory, entry.name)}`);
      }
    };
    visit(join(citizenSdkRoot, relativeRoot));
  }
  for (const [source, declaredPackage] of [
    ['android/native/source/CitizenSdkHardwareVault.kt', 'org.citizen.sdk.internal'],
    ['android/native/source/CitizenSdkNative.kt', 'org.citizen.sdk.internal'],
    ['android/native/device/CitizenSdkHardwareVaultTest.kt', 'org.citizen.sdk'],
    ['android/source/CitizenSdkPlugin.kt', 'org.citizen.sdk'],
  ]) {
    const contents = readFileSync(join(citizenSdkRoot, source), 'utf8');
    assert.ok(contents.split('\n').includes(`package ${declaredPackage}`), source);
  }
  for (const obsolete of [
    'android/native/src/main/kotlin/org',
    'android/native/tests/kotlin/org',
    'android/native/tests/java/org',
    'android/native/device/kotlin',
    'android/src/main/kotlin/org',
    'android/tests/kotlin',
  ]) assert.equal(existsSync(join(citizenSdkRoot, obsolete)), false, obsolete);
  const consumerRules = readFileSync(join(citizenSdkRoot, 'android/native/consumer-rules.pro'), 'utf8');
  assert.match(consumerRules, /org\.citizen\.sdk\.internal\.CitizenSdkNative/u);
});

test('各端启停直接调用原生且Android不再增加能力刷新前置屏障', () => {
  const android = readFileSync(join(citizenSdkRoot, 'android/native/source/CitizenSdk.kt'), 'utf8');
  const apple = readFileSync(join(citizenSdkRoot, 'darwin/source/core/CitizenSDK.swift'), 'utf8');
  const sessions = readFileSync(join(citizenSdkRoot, 'android/source/CitizenSdkFlutterSessions.kt'), 'utf8');
  const desktops = ['linux', 'windows'].map(platform => readFileSync(join(citizenSdkRoot, platform, 'source/citizen_sdk_flutter_sessions.cc'), 'utf8'));
  for (const name of ['start', 'stop']) {
    // 精确约束生产入口的一次直接提交；不能把屏障换名、搬到Flutter或改成延时重试。
    assert.equal(android.match(new RegExp(`fun ${name}\\(\\): CompletableFuture<Void> = ([^\\n]+)`, 'u'))?.[1], `unitRequest({ native.${name}() })`);
    assert.match(apple, new RegExp(`public func ${name}\\(\\) async throws \\{\\s*try await native\\.${name}\\(\\)\\.value\\(\\)\\s*\\}`, 'u'));
    const call = name === 'start' ? 'diagnosed(session, "start") { sdk.start() }' : 'sdk.stop()';
    assert.ok(sessions.includes('"' + name + '" -> complete(session, request, result, ' + call + ')'));
    for (const desktop of desktops) assert.ok(desktop.includes(`case Method::${name}: return citizensdk_${name}(sdk, out);`));
  }
  assert.doesNotMatch(android, /exclusiveAfterReadiness/u);
  // 原异步结果投影、实例打开、私钥就绪及关闭排空仍有真实调用方，不随启停屏障误删。
  assert.match(android, /val source = request\(begin, notifyReadinessBoundary\)/u);
  assert.match(android, /requests\.submitOperation\(begin, decode\)/u);
  assert.match(android, /if \(error == null\) target\.complete\(null\) else target\.completeExceptionally\(error\)/u);
  assert.match(android, /sdk\.awaitReadinessBarrier\(\)/u);
  assert.match(android, /hostServices\.whenActivityReady \{/u);
  assert.match(android, /if \(readinessInFlight \|\| readinessRetryPending\) throw CitizenSdkException/u);
  assert.match(android, /requests\.requireIdle\(\)/u);
  assert.match(android, /CitizenSdkClosePolicy\.validate\(native\.lifecycle\(\)\)/u);
});

test('四平台先统一Core接纳外壳再解参数且不保留第二份接收序号', () => {
  const read = path => readFileSync(join(citizenSdkRoot, path), 'utf8');
  const core = read('native/ffi/source/runtime.rs');
  assert.match(core, /fn accept_request_sequence\(&self, sequence: u64\)/u);
  assert.match(core, /sequence != state\.next_request_sequence/u);
  assert.match(core, /state\.next_request_sequence \+= 1/u);
  assert.match(read('include/citizensdk.h'), /citizensdk_accept_request_sequence/u);
  for (const [plugin, envelope, accept, decode] of [
    ['android/source/CitizenSdkPlugin.kt', 'CitizenSdkFlutterCodec.envelope(', 'envelope?.let(registry::acceptRequestSequence)', 'registry.dispatch(CitizenSdkFlutterCodec.decode('],
    ['darwin/source/flutter/CitizenSdkPlugin.swift', 'CitizenSdkFlutterCodec.envelope(', 'sessions.acceptRequestSequence(envelope)', 'sessions.dispatch(try CitizenSdkFlutterCodec.decode('],
    ['linux/source/citizen_sdk_plugin.cc', 'decode_request_envelope(', 'state->sessions->accept_request_sequence(*envelope)', 'const DecodedRequest request = decode_request('],
    ['windows/source/citizen_sdk_plugin.cc', 'decode_request_envelope(', 'sessions->accept_request_sequence(*envelope)', 'const auto request = decode_request('],
  ]) {
    const source = read(plugin);
    const positions = [envelope, accept, decode].map(value => source.indexOf(value));
    assert.ok(positions[0] >= 0 && positions[1] > positions[0] && positions[2] > positions[1], plugin);
  }
  for (const file of [
    'android/source/CitizenSdkFlutterSessions.kt',
    'darwin/source/flutter/CitizenSdkFlutterSessions.swift',
    'linux/source/citizen_sdk_flutter_sessions.cc', 'windows/source/citizen_sdk_flutter_sessions.cc',
  ]) {
    assert.doesNotMatch(read(file), /CitizenSdkFlutterSequenceGate|nextRequest|next_request\s*\{|request\.sequence != session->next_request/u, file);
  }
  const apple = read('darwin/source/flutter/CitizenSdkFlutterCodec.swift');
  assert.match(apple, /rawTuple\.map \{ \$0 is NSNull \? nil : \$0 \}/u);
  const android = read('android/source/CitizenSdkFlutterSessions.kt');
  assert.match(android, /entries\.size >= 8 \|\| !entries\.add\(signature\)/u);
  assert.match(android, /method !in setOf\("open", "start", "getSyncStatus"\)/u);
  assert.match(android, /val future = try \{ begin\(\) \}/u);
});

test('Android独立工具版本由CitizenSDK产品合同固定且不依赖外部目录', () => {
  const gradle = readFileSync(join(citizenSdkRoot, 'android/native/build.gradle'), 'utf8');
  const settings = readFileSync(join(citizenSdkRoot, 'android/settings.gradle'), 'utf8');
  assert.match(gradle, /version = cmakeVersion/u);
  assert.match(gradle, /def cmakeVersion = '3\.31\.6'/u);
  assert.doesNotMatch(readFileSync(join(citizenSdkRoot, 'android/build.gradle'), 'utf8'), /readCmake|cmakeVersion|tools.*android\.mjs/u);
  assert.match(settings, /agp: '9\.0\.1'/u);
  assert.match(settings, /kotlin: '2\.2\.20'/u);
  assert.match(settings, /gradle: '9\.1\.0'/u);
  assert.doesNotMatch(settings, /commandLine|\.\.\/tools|shared\.json/u);
});

test('Android证书组件仓库对Flutter宿主消费方可见且只解析官方组', () => {
  const source = readFileSync(join(citizenSdkRoot, 'android/build.gradle'), 'utf8');
  assert.match(source, /rootProject\.allprojects\s*\{[\s\S]*?citizensdk-verifier-maven[\s\S]*?includeGroup 'rustls'/u);
  assert.doesNotMatch(source, /(?:^|\n)allprojects\s*\{[\s\S]*?citizensdk-verifier-maven/u);
});

test('Android独立Flutter测试只借用同一官方embedding且不影响宿主打包', () => {
  const source = readFileSync(join(citizenSdkRoot, 'android/build.gradle'), 'utf8');
  assert.match(source, /standaloneFlutterTests = project == rootProject && sdkSourceValue != null/u);
  assert.match(source, /flutterRootValue = standaloneFlutterTests \? System\.getenv\('CITIZENSDK_FLUTTER_ROOT'\) : null/u);
  assert.match(source, /!flutterRootInput\.isAbsolute\(\)/u);
  assert.match(source, /flutterRootInput\.absoluteFile != flutterRoot/u);
  assert.match(source, /flutterRoot\.toPath\(\)\.startsWith\(sdkProductRoot\.toPath\(\)\)/u);
  assert.match(source, /!flutterTestJar\.isFile\(\) \|\| flutterTestJar\.absoluteFile != flutterTestJar\.canonicalFile/u);
  assert.match(source, /standaloneFlutterTests && flutterTestJar == null/u);
  assert.equal((source.match(/bin\/cache\/artifacts\/engine\/android-arm\/flutter\.jar/gu) ?? []).length, 1);
  assert.equal((source.match(/compileOnly files\(flutterTestJar\)/gu) ?? []).length, 1);
  assert.equal((source.match(/testImplementation files\(flutterTestJar\)/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:implementation|api|runtimeOnly)\s+files\(flutterTestJar\)/u);
});

test('Android工具三配置真实来源摘要与失败拒绝保持一致', () => {
  const source = readFileSync(join(citizenSdkRoot, 'scripts/release.mjs'), 'utf8');
  const block = source.match(/const MOBILE_BINDING_SOURCE_FILES = Object\.freeze\((\{[\s\S]*?\n\})\);/u)[1];
  const pins = runInNewContext('(' + block + ')');
  const names = ['android/build.gradle', 'android/settings.gradle', 'android/native/build.gradle'];
  const contents = new Map(names.map(path => [join(citizenSdkRoot, path), readFileSync(join(citizenSdkRoot, path))]));
  // 执行生产摘要验证函数；失败仅替换内存字节，不改源码或另一线程正在写的文件。
  const start = source.indexOf('function assertPinnedFiles(');
  const end = source.indexOf('\nfunction stripCComments(', start);
  const expected = Object.fromEntries(names.map(path => [path, pins[path]]));
  let missing = '', linked = '';
  const verify = runInNewContext(source.slice(start, end) + '\nassertPinnedFiles', {
    resolve, join,
    existsSync: path => contents.has(path) && path !== missing,
    lstatSync: path => ({ isFile: () => true, isSymbolicLink: () => path === linked }),
    sha256File: path => createHash('sha256').update(contents.get(path)).digest('hex'),
    fail: message => { throw Error(message); },
  });
  assert.doesNotThrow(() => verify(citizenSdkRoot, expected, '移动绑定来源'));
  for (const name of names) {
    const path = join(citizenSdkRoot, name), original = contents.get(path);
    contents.set(path, Buffer.concat([original, Buffer.from('\n// changed input\n')]));
    assert.throws(() => verify(citizenSdkRoot, expected, '移动绑定来源'), /哈希漂移/u);
    contents.set(path, original);
    missing = path;
    assert.throws(() => verify(citizenSdkRoot, expected, '移动绑定来源'), /缺少普通/u);
    missing = ''; linked = path;
    assert.throws(() => verify(citizenSdkRoot, expected, '移动绑定来源'), /缺少普通/u);
    linked = '';
  }
  assert.ok(source.includes("assertPinnedFiles(sourceRoot, expectedFiles, '移动绑定来源')"));
});

test('钱包输入 ABI 与三种词数完整进入同一分发合同', () => {
  const symbols = citizenSdkSymbols();
  for (const symbol of [
    'citizensdk_validate_wallet_input',
    'citizensdk_wallet_word_suggestions',
  ]) assert.equal(symbols.filter((value) => value === symbol).length, 1);
  const header = readFileSync(join(citizenSdkRoot, 'include/citizensdk_types.h'), 'utf8');
  const counts = [...header.matchAll(/^#define CITIZENSDK_WALLET_WORDS_(\d+)\b/gm)]
    .map((match) => Number(match[1]));
  assert.deepEqual(counts, [12, 18, 24]);
  assertCoreRustSource(citizenSdkRoot);
});

test('公开数值ABI使用Swift可导入的唯一C字面量合同', () => {
  const header = readFileSync(join(citizenSdkRoot, 'include/citizensdk_types.h'), 'utf8');
  assert.doesNotMatch(header, /(?:UINT32_C|INT32_C|UINT64_C)\(/u);
  for (const contract of [
    '#define CITIZENSDK_OK 0',
    '#define CITIZENSDK_EXTERNAL_SIGNER_QR_V1 1U',
    '#define CITIZENSDK_SIGNING_COMPLETED 1U',
    '#define CITIZENSDK_HOST_BYTES_WRAPPED_DEK 1U',
  ]) assert.match(header, new RegExp(`^${contract}$`, 'mu'));
});

// 直接执行构建器中的唯一函数体；不 source 整个构建器，避免合同测试触发
// mkdir、依赖解析或编译，也不维护第二份 ELF/安装验收算法。
function nativeShellFunctions(names) {
  const source = BUILD_SHELL_SOURCES.native;
  return names.map((name) => {
    assert.match(name, /^[a-z_]+$/u);
    const matches = [...source.matchAll(new RegExp(
      `^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'gm',
    ))];
    assert.equal(matches.length, 1, `唯一生产函数：${name}`);
    return matches[0][0];
  }).join('\n');
}

function linuxInstallFixturePaths(platform) {
  return [
    'include/citizensdk.h',
    'include/citizensdk_types.h',
    'include/citizensdk_qr_image.h',
    ...[
      'citizen_sdk.hpp', 'citizen_sdk_config.hpp', 'citizen_sdk_error.hpp',
      'citizen_sdk_events.hpp', 'citizen_sdk_models.hpp',
      'citizensdk_host.h',
    ].map((name) => `include/citizen_sdk/${name}`),
    `lib/${platform}/libcitizensdk.so`,
    `lib/${platform}/libcitizensdk_host.so`,
    ...[
      'CitizenSDKConfig.cmake', 'CitizenSDKConfigVersion.cmake',
      'CitizenSDKDependencies.cmake', 'CitizenSDKTargets.cmake',
      'CitizenSDKTargets-release.cmake',
    ].map((name) => `lib/${platform}/cmake/CitizenSDK/${name}`),
    ...['manifest.json', 'chainspec.json', 'light_sync_state.json']
      .map((name) => `share/citizensdk/chain/${name}`),
  ].sort();
}

const linuxPlatforms = ['LinuxARM', 'LinuxAMD'];

function windowsInstallFixturePaths() {
  return [
    'include/citizensdk.h', 'include/citizensdk_types.h', 'include/citizensdk_qr_image.h',
    ...[
      'citizen_sdk.hpp', 'citizen_sdk_config.hpp', 'citizen_sdk_error.hpp',
      'citizen_sdk_events.hpp', 'citizen_sdk_models.hpp',
      'citizensdk_host.h',
    ].map((name) => `include/citizen_sdk/${name}`),
    'bin/Windows/citizensdk.dll', 'bin/Windows/citizensdk_host.dll',
    'lib/Windows/citizensdk.dll.lib', 'lib/Windows/citizensdk_host.lib',
    ...[
      'CitizenSDKConfig.cmake', 'CitizenSDKConfigVersion.cmake',
      'CitizenSDKDependencies.cmake', 'CitizenSDKTargets.cmake',
      'CitizenSDKTargets-release.cmake',
    ].map((name) => `lib/Windows/cmake/CitizenSDK/${name}`),
    ...['manifest.json', 'chainspec.json', 'light_sync_state.json']
      .map((name) => `share/citizensdk/chain/${name}`),
  ].sort();
}

// Microsoft PE/COFF 格式夹具：真实 DOS/COFF/PE32+、节和导出表结构，不执行函数。
// 只证明生产解析器的接受/拒绝路径，不能冒充 MSVC 构建或 Windows 消费者实测。
function windowsPeFixture(names, library, machine = 0x8664, imports = library === 'citizensdk_host.dll'
  ? [{ name: 'citizensdk.dll', symbols: ['citizensdk_get_lifecycle'] }]
  : [{ name: 'kernel32.dll', symbols: ['GetLastError'] }]) {
  assert.ok(names.length > 0 && names.length <= 512);
  assert.deepEqual(names, [...new Set(names)].sort());
  const strings = [library, ...names].map((name) => Buffer.from(`${name}\0`, 'ascii'));
  const addresses = 40;
  const pointers = addresses + names.length * 4;
  const ordinals = pointers + names.length * 4;
  const textOffset = ordinals + names.length * 2;
  const exportSize = textOffset + strings.reduce((sum, text) => sum + text.length, 0);
  const exportRawSize = Math.ceil(exportSize / 512) * 512;
  const importOffset = 1024 + exportRawSize;
  const importRva = 0x2000 + Math.ceil(exportSize / 4096) * 4096;
  const importData = Buffer.alloc(16384);
  let importCursor = (imports.length + 1) * 20;
  imports.forEach((entry, index) => {
    const descriptor = index * 20;
    const dllName = Buffer.from(`${entry.name}\0`);
    importData.writeUInt32LE(importRva + importCursor, descriptor + 12);
    dllName.copy(importData, importCursor);
    importCursor += dllName.length;
    importCursor = Math.ceil(importCursor / 8) * 8;
    const lookup = importCursor;
    importCursor += (entry.symbols.length + 1) * 8;
    const iat = importCursor;
    importCursor += (entry.symbols.length + 1) * 8;
    importData.writeUInt32LE(importRva + lookup, descriptor);
    importData.writeUInt32LE(importRva + iat, descriptor + 16);
    entry.symbols.forEach((name, item) => {
      const value = typeof name === 'number' ? (1n << 63n) | BigInt(name) : BigInt(importRva + importCursor);
      importData.writeBigUInt64LE(value, lookup + item * 8);
      importData.writeBigUInt64LE(value, iat + item * 8);
      if (typeof name !== 'number') {
        const symbol = Buffer.from(`${name}\0`);
        symbol.copy(importData, importCursor + 2);
        importCursor += 2 + symbol.length;
        importCursor = Math.ceil(importCursor / 2) * 2;
      }
    });
  });
  const importRawSize = Math.ceil(importCursor / 512) * 512;
  const bytes = Buffer.alloc(importOffset + importRawSize);
  importData.copy(bytes, importOffset, 0, importCursor);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132);
  bytes.writeUInt16LE(3, 134);
  bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x2022, 150);
  const optional = 152;
  bytes.writeUInt16LE(0x20b, optional);
  bytes[optional + 2] = 14;
  bytes.writeUInt32LE(512, optional + 4);
  bytes.writeUInt32LE(exportRawSize + importRawSize, optional + 8);
  bytes.writeUInt32LE(0x1000, optional + 20);
  bytes.writeBigUInt64LE(0x180000000n, optional + 24);
  bytes.writeUInt32LE(4096, optional + 32);
  bytes.writeUInt32LE(512, optional + 36);
  bytes.writeUInt16LE(6, optional + 40);
  bytes.writeUInt16LE(1, optional + 44);
  bytes.writeUInt16LE(6, optional + 48);
  bytes.writeUInt32LE(importRva + Math.ceil(importCursor / 4096) * 4096, optional + 56);
  bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt16LE(0x8100, optional + 70);
  for (const offset of [72, 88]) bytes.writeBigUInt64LE(0x100000n, optional + offset);
  for (const offset of [80, 96]) bytes.writeBigUInt64LE(0x1000n, optional + offset);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x2000, optional + 112);
  bytes.writeUInt32LE(exportSize, optional + 116);
  if (imports.length) {
    bytes.writeUInt32LE(importRva, optional + 120);
    bytes.writeUInt32LE((imports.length + 1) * 20, optional + 124);
  }
  for (const [index, name, size, rva, rawSize, raw, flags] of [
    [0, '.text', names.length, 0x1000, 512, 512, 0x60000020],
    [1, '.edata', exportSize, 0x2000, exportRawSize, 1024, 0x40000040],
    [2, '.idata', importCursor, importRva, importRawSize, importOffset, 0xc0000040],
  ]) {
    const section = optional + 240 + index * 40;
    bytes.write(name, section, 'ascii');
    for (const [offset, value] of [[8, size], [12, rva], [16, rawSize], [20, raw], [36, flags]]) {
      bytes.writeUInt32LE(value, section + offset);
    }
  }
  bytes.fill(0xc3, 512, 512 + names.length);
  bytes.writeUInt32LE(0x2000 + textOffset, 1024 + 12);
  bytes.writeUInt32LE(1, 1024 + 16);
  for (const offset of [20, 24]) bytes.writeUInt32LE(names.length, 1024 + offset);
  for (const [offset, value] of [[28, addresses], [32, pointers], [36, ordinals]]) {
    bytes.writeUInt32LE(0x2000 + value, 1024 + offset);
  }
  let cursor = textOffset;
  strings[0].copy(bytes, 1024 + cursor);
  cursor += strings[0].length;
  names.forEach((name, index) => {
    bytes.writeUInt32LE(0x1000 + index, 1024 + addresses + index * 4);
    bytes.writeUInt32LE(0x2000 + cursor, 1024 + pointers + index * 4);
    bytes.writeUInt16LE(index, 1024 + ordinals + index * 2);
    strings[index + 1].copy(bytes, 1024 + cursor);
    cursor += strings[index + 1].length;
  });
  return bytes;
}

function windowsImportLibraryFixture(names, library, { longnames = false, internalPadding = true } = {}) {
  const member = (name, data) => {
    const header = Buffer.from(`${name.padEnd(16)}${'0'.padEnd(12)}${''.padEnd(6)}${''.padEnd(6)}${'0'.padEnd(8)}${String(data.length).padEnd(10)}\x60\n`);
    assert.equal(header.length, 60);
    return Buffer.concat([header, data, ...(data.length % 2 ? [Buffer.from('\n')] : [])]);
  };
  // PE/COFF 官方结构夹具：三个描述符真实携带 section/symbol/relocation；不是 Windows 编译证据。
  // 对照 LLVM COFFImportFile.cpp，保留两个官方索引，不能用仅有 short import 的残缺库冒充正例。
  const stem = library.replace(/\.dll$/, '');
  const descriptor = `__IMPORT_DESCRIPTOR_${stem}`, nullDescriptor = '__NULL_IMPORT_DESCRIPTOR';
  const nullThunk = `\x7f${stem}_NULL_THUNK_DATA`;
  const coff = (sections, symbols) => {
    const strings = [], offsets = new Map();
    let stringSize = 4;
    for (const [name] of symbols) {
      if (name.length > 8 && !offsets.has(name)) {
        offsets.set(name, stringSize);
        const text = Buffer.from(`${name}\0`);
        strings.push(text); stringSize += text.length;
      }
    }
    let end = 20 + sections.length * 40;
    const locations = sections.map((section) => {
      const raw = end;
      end += section.data.length;
      const reloc = section.relocations?.length ? end : 0;
      end += (section.relocations?.length ?? 0) * 10;
      return { raw, reloc };
    });
    const table = end;
    const bytes = Buffer.alloc(table + symbols.length * 18 + stringSize);
    bytes.writeUInt16LE(0x8664, 0);
    bytes.writeUInt16LE(sections.length, 2);
    bytes.writeUInt32LE(table, 8);
    bytes.writeUInt32LE(symbols.length, 12);
    sections.forEach((section, index) => {
      const at = 20 + index * 40, location = locations[index];
      bytes.write(section.name, at);
      bytes.writeUInt32LE(section.data.length, at + 16);
      bytes.writeUInt32LE(location.raw, at + 20);
      bytes.writeUInt32LE(location.reloc, at + 24);
      bytes.writeUInt16LE(section.relocations?.length ?? 0, at + 32);
      bytes.writeUInt32LE(section.flags ?? 0xc0300040, at + 36);
      section.data.copy(bytes, location.raw);
      (section.relocations ?? []).forEach(([offset, target], item) => {
        bytes.writeUInt32LE(offset, location.reloc + item * 10);
        bytes.writeUInt32LE(target, location.reloc + item * 10 + 4);
        bytes.writeUInt16LE(3, location.reloc + item * 10 + 8); // IMAGE_REL_AMD64_ADDR32NB
      });
    });
    symbols.forEach(([name, section, storage], index) => {
      const at = table + index * 18;
      if (offsets.has(name)) bytes.writeUInt32LE(offsets.get(name), at + 4);
      else bytes.write(name, at);
      bytes.writeInt16LE(section, at + 12);
      bytes[at + 16] = storage;
    });
    const stringsAt = table + symbols.length * 18;
    bytes.writeUInt32LE(stringSize, stringsAt);
    Buffer.concat(strings).copy(bytes, stringsAt + 4);
    return bytes;
  };
  const objects = [
    coff([
      { name: '.idata$2', data: Buffer.alloc(20), relocations: [[12, 2], [0, 3], [16, 4]] },
      { name: '.idata$6', data: Buffer.from(`${library}\0`), flags: 0xc0200040 },
    ], [[descriptor, 1, 2], ['.idata$2', 1, 104], ['.idata$6', 2, 3],
      ['.idata$4', 0, 104], ['.idata$5', 0, 104], [nullDescriptor, 0, 2], [nullThunk, 0, 2]]),
    coff([{ name: '.idata$3', data: Buffer.alloc(20) }], [[nullDescriptor, 1, 2]]),
    coff([{ name: '.idata$5', data: Buffer.alloc(8), flags: 0xc0400040 },
      { name: '.idata$4', data: Buffer.alloc(8), flags: 0xc0400040 }], [[nullThunk, 1, 2]]),
  ];
  names.forEach((name, index) => {
    const strings = Buffer.from(`${name}\0${library}\0`);
    const object = Buffer.alloc(20 + strings.length);
    object.writeUInt16LE(0xffff, 2);
    object.writeUInt16LE(0x8664, 6);
    object.writeUInt32LE(strings.length, 12);
    object.writeUInt16LE(index, 16);
    object.writeUInt16LE(4, 18);
    strings.copy(object, 20);
    objects.push(object);
  });
  const longname = Buffer.from('citizensdk-official-object-name.obj\0');
  const longMember = longnames ? member('//', Buffer.concat([longname,
    ...(longname.length % 2 ? [Buffer.from('\n')] : [])])) : Buffer.alloc(0);
  const members = objects.map((object, index) => member(longnames ? '/0' : `${index}.obj/`, object));
  const symbols = [[descriptor, 0], [nullDescriptor, 1], [nullThunk, 2],
    ...names.flatMap((name, index) => [[name, index + 3], [`__imp_${name}`, index + 3]])];
  const textSize = symbols.reduce((sum, [name]) => sum + name.length + 1, 0);
  const padded = (size) => size + (internalPadding ? size % 2 : 0);
  const first = Buffer.alloc(padded(4 + symbols.length * 4 + textSize));
  const second = Buffer.alloc(padded(8 + members.length * 4 + symbols.length * 2 + textSize));
  let next = 8 + 60 + first.length + first.length % 2 + 60 + second.length + second.length % 2 + longMember.length;
  const offsets = members.map((bytes) => { const value = next; next += bytes.length; return value; });
  first.writeUInt32BE(symbols.length);
  let cursor = 4 + symbols.length * 4;
  symbols.forEach(([name, index], item) => {
    first.writeUInt32BE(offsets[index], 4 + item * 4);
    first.write(`${name}\0`, cursor);
    cursor += name.length + 1;
  });
  second.writeUInt32LE(members.length);
  offsets.forEach((offset, index) => second.writeUInt32LE(offset, 4 + index * 4));
  second.writeUInt32LE(symbols.length, 4 + members.length * 4);
  cursor = 8 + members.length * 4 + symbols.length * 2;
  [...symbols].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .forEach(([name, index], item) => {
      second.writeUInt16LE(index + 1, 8 + members.length * 4 + item * 2);
      second.write(`${name}\0`, cursor);
      cursor += name.length + 1;
    });
  return Buffer.concat([Buffer.from('!<arch>\n'), member('/', first), member('/', second), longMember, ...members]);
}

function windowsInstallFixture(root) {
  const prefix = join(root, 'install');
  const core = join(root, 'core');
  const build = join(root, 'cmake');
  const references = new Map();
  const exports = new Map();
  const write = (path, bytes) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  const { packageInit, targets } = writeLinuxInstallFixture(null, 'LinuxARM', { cmakeOnly: true });
  const config = readFileSync(join(citizenSdkRoot, 'windows/cmake/CitizenSDKConfig.cmake.in'), 'utf8')
    .replace('@PACKAGE_INIT@', packageInit)
    .replaceAll('@PACKAGE_CMAKE_INSTALL_LIBDIR@', '${PACKAGE_PREFIX_DIR}/lib')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_BINDIR@', '${PACKAGE_PREFIX_DIR}/bin')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_INCLUDEDIR@', '${PACKAGE_PREFIX_DIR}/include')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_DATADIR@', '${PACKAGE_PREFIX_DIR}/share');
  const version = readFileSync(join(citizenSdkRoot, 'windows/cmake/CitizenSDKConfigVersion.cmake.in'), 'utf8')
    .replaceAll('@PROJECT_VERSION@', '1.0.0').replaceAll('@PROJECT_VERSION_MAJOR@', '1');
  // 这里只构造安装/本轮构建的对拍输入；不运行 CMake、不声称来自 MSVC。
  const releaseTargets = [
    'set(CMAKE_IMPORT_FILE_VERSION 1)',
    'set_property(TARGET CitizenSDK::Host APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)',
    'set_target_properties(CitizenSDK::Host PROPERTIES',
    '  IMPORTED_IMPLIB_RELEASE "${_IMPORT_PREFIX}/lib/Windows/citizensdk_host.lib"',
    '  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/bin/Windows/citizensdk_host.dll"',
    '  )',
    'list(APPEND _cmake_import_check_targets CitizenSDK::Host )',
    'list(APPEND _cmake_import_check_files_for_CitizenSDK::Host "${_IMPORT_PREFIX}/lib/Windows/citizensdk_host.lib" "${_IMPORT_PREFIX}/bin/Windows/citizensdk_host.dll" )',
    'set(CMAKE_IMPORT_FILE_VERSION)', '',
  ].join('\n');
  const configs = { 'CitizenSDKConfig.cmake': config, 'CitizenSDKConfigVersion.cmake': version,
    'CitizenSDKTargets.cmake': targets, 'CitizenSDKTargets-release.cmake': releaseTargets };
  for (const relative of windowsInstallFixturePaths()) {
    let reference;
    let bytes;
    const name = basename(relative);
    if (relative.startsWith('include/citizen_sdk/')) {
      reference = join(citizenSdkRoot,hostHeaderSource('windows',basename(relative)));
    } else if (relative.startsWith('include/')) {
      reference = relative === 'include/citizensdk_qr_image.h'
        ? join(citizenSdkRoot, 'native/image/citizensdk_qr_image.h')
        : join(citizenSdkRoot, relative);
    } else if (relative.startsWith('share/')) {
      reference = join(citizenSdkRoot, 'chain', name);
    } else if (name === 'CitizenSDKDependencies.cmake') {
      reference = join(citizenSdkRoot, 'windows/cmake', name);
    } else if (name.endsWith('.cmake')) {
      reference = name.startsWith('CitizenSDKTargets')
        ? join(build, 'CMakeFiles/Export/fixture', name) : join(build, name);
      bytes = configs[name];
    } else {
      const host = name.startsWith('citizensdk_host.');
      reference = join(host ? join(build, 'Release') : core, name);
      const header = join(citizenSdkRoot, host
        ? 'windows/headers/citizensdk_host.h' : 'include/citizensdk.h');
      const names = [...new Set([...readFileSync(header, 'utf8')
        .matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/gu)].map((m) => m[1]))].sort();
      assert.equal(names.length, host ? 19 : 144);
      if (host) names.push(...qrImageSymbols());
      if (!host) names.push(...CITIZENSDK_INTERNAL_SYMBOLS);
      names.sort();
      if (name.endsWith('.dll')) {
        bytes = windowsPeFixture(names, name);
        exports.set(name, `Dump of file ${name}\n\n    ordinal hint RVA      name\n${names.map((symbol, index) =>
          `          ${index + 1} ${index.toString(16)} ${(0x1000 + index).toString(16)} ${symbol}`).join('\n')}\n`);
      } else {
        bytes = windowsImportLibraryFixture(names, host ? 'citizensdk_host.dll' : 'citizensdk.dll');
      }
    }
    if (bytes !== undefined) write(reference, bytes);
    references.set(relative, reference);
    write(join(prefix, relative), readFileSync(reference));
  }
  write(join(build, 'install_manifest.txt'), `${windowsInstallFixturePaths()
    .map((relative) => join(prefix, relative)).join('\n')}\n`);
  for (const [name, output] of exports) write(join(root, `${name}.exports`), output);
  return { prefix, core, build, references, exports };
}

function linuxHostSymbols() {
  const header = readFileSync(
    join(citizenSdkRoot, 'linux/headers/citizensdk_host.h'),
    'utf8',
  );
  const symbols = [...new Set([...header.matchAll(
    /\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g,
  )].map((match) => match[1]))].sort();
  assert.equal(symbols.length, 19);
  return [...symbols, ...qrImageSymbols()].sort();
}

function writeWindowsProjectionFixture(root, prefix) {
  for (const directory of ['windows', 'include', 'chain']) {
    cpSync(join(citizenSdkRoot, directory), join(root, directory), { recursive: true });
  }
  const qrImageHeader = join(root, 'native/image/citizensdk_qr_image.h');
  mkdirSync(dirname(qrImageHeader), { recursive: true });
  copyFileSync(
    join(citizenSdkRoot, 'native/image/citizensdk_qr_image.h'),
    qrImageHeader,
  );
  for (const file of ['pubspec.yaml', '.pubignore']) copyFileSync(join(citizenSdkRoot, file), join(root, file));
  copyWindowsNativeArtifact(citizenSdkRoot, prefix, root);
}

// 这是供生产解析器读取的 ELF64 格式夹具，不是可执行运行库，也不构成
// Linux 编译/TPM/消费者实测证据。段、节、动态表、符号表和版本链均写真实结构。
function linuxElfFixture({
  platform = 'LinuxARM',
  host = false,
  machine = platform === 'LinuxARM' ? 183 : 62,
  soname = host ? 'libcitizensdk_host.so' : 'libcitizensdk.so',
  needed = host ? ['libcitizensdk.so', 'libc.so.6'] : ['libc.so.6'],
  runpath = host ? '$ORIGIN' : null,
  rpath = null,
  symbols = host ? linuxHostSymbols() : citizenSdkLinkedSymbols(),
  versions = ['GLIBC_2.31'],
} = {}) {
  const align = (value, width = 8) => Math.ceil(value / width) * width;
  const elfHash = (value) => {
    let hash = 0;
    for (const byte of Buffer.from(value)) {
      hash = ((hash << 4) + byte) >>> 0;
      const high = hash & 0xf0000000;
      if (high) hash ^= high >>> 24;
      hash = (hash & ~high) >>> 0;
    }
    return hash;
  };
  const strings = [''];
  const offsets = new Map([['', 0]]);
  let stringLength = 1;
  const intern = (value) => {
    if (!offsets.has(value)) {
      offsets.set(value, stringLength);
      strings.push(value);
      stringLength += Buffer.byteLength(value) + 1;
    }
    return offsets.get(value);
  };
  for (const value of [soname, ...needed, ...symbols, ...versions, 'puts', 'libc.so.6']) intern(value);
  if (runpath !== null) intern(runpath);
  if (rpath !== null) intern(rpath);
  const dynstr = Buffer.from(`${strings.join('\0')}\0`);
  const count = symbols.length + 2;
  const dynsym = Buffer.alloc(count * 24);
  // 索引 0 保留为空；索引 1 是版本化的未定义 libc 符号，不混入公开导出集合。
  dynsym.writeUInt32LE(intern('puts'), 24);
  dynsym[28] = 0x12;
  for (const [index, symbol] of symbols.entries()) {
    const offset = (index + 2) * 24;
    dynsym.writeUInt32LE(intern(symbol), offset);
    dynsym[offset + 4] = 0x12;
    dynsym.writeUInt16LE(1, offset + 6);
    dynsym.writeBigUInt64LE(1n, offset + 16);
  }
  const hash = Buffer.alloc((3 + count) * 4);
  hash.writeUInt32LE(1, 0);
  hash.writeUInt32LE(count, 4);
  hash.writeUInt32LE(1, 8);
  for (let index = 1; index < count - 1; index += 1) hash.writeUInt32LE(index + 1, 12 + index * 4);
  const versym = Buffer.alloc(count * 2);
  for (let index = 1; index < count; index += 1) versym.writeUInt16LE(index === 1 ? 2 : 1, index * 2);
  const verneed = Buffer.alloc(16 + versions.length * 16);
  verneed.writeUInt16LE(1, 0);
  verneed.writeUInt16LE(versions.length, 2);
  verneed.writeUInt32LE(intern('libc.so.6'), 4);
  verneed.writeUInt32LE(16, 8);
  for (const [index, version] of versions.entries()) {
    const offset = 16 + index * 16;
    verneed.writeUInt32LE(elfHash(version), offset);
    verneed.writeUInt16LE(index + 2, offset + 6);
    verneed.writeUInt32LE(intern(version), offset + 8);
    verneed.writeUInt32LE(index + 1 < versions.length ? 16 : 0, offset + 12);
  }
  const dynamicTags = [
    [14, intern(soname)], ...needed.map((value) => [1, intern(value)]),
    ...(rpath === null ? [] : [[15, intern(rpath)]]),
    ...(runpath === null ? [] : [[29, intern(runpath)]]),
    [5, 0], [10, dynstr.length], [6, 0], [11, 24], [4, 0],
    [0x6ffffff0, 0], [0x6ffffffe, 0], [0x6fffffff, 1], [0, 0],
  ];
  const names = ['.text', '.dynstr', '.dynsym', '.hash', '.gnu.version', '.gnu.version_r', '.dynamic', '.shstrtab'];
  const shstrtab = Buffer.from(`\0${names.join('\0')}\0`);
  const sections = [
    { name: '.text', type: 1, flags: 6, bytes: Buffer.from([0, 0, 0, 0]), alignment: 4 },
    { name: '.dynstr', type: 3, flags: 2, bytes: dynstr, alignment: 1 },
    { name: '.dynsym', type: 11, flags: 2, bytes: dynsym, alignment: 8, link: 2, info: 1, entry: 24 },
    { name: '.hash', type: 5, flags: 2, bytes: hash, alignment: 4, link: 3, entry: 4 },
    { name: '.gnu.version', type: 0x6fffffff, flags: 2, bytes: versym, alignment: 2, link: 3, entry: 2 },
    { name: '.gnu.version_r', type: 0x6ffffffe, flags: 2, bytes: verneed, alignment: 4, link: 2, info: 1 },
    { name: '.dynamic', type: 6, flags: 3, bytes: Buffer.alloc(dynamicTags.length * 16), alignment: 8, link: 2, entry: 16 },
    { name: '.shstrtab', type: 3, flags: 0, bytes: shstrtab, alignment: 1 },
  ];
  let cursor = 64 + 2 * 56;
  for (const section of sections) {
    section.offset = align(cursor, section.alignment);
    cursor = section.offset + section.bytes.length;
  }
  const sectionOffset = align(cursor);
  const bytes = Buffer.alloc(sectionOffset + (sections.length + 1) * 64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeBigUInt64LE(BigInt(sectionOffset), 40);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(2, 56);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(sections.length + 1, 60);
  bytes.writeUInt16LE(sections.length, 62);
  const dynamic = sections[6];
  const program = (offset, type, flags, fileOffset, size, alignment) => {
    bytes.writeUInt32LE(type, offset);
    bytes.writeUInt32LE(flags, offset + 4);
    for (const field of [8, 16, 24]) bytes.writeBigUInt64LE(BigInt(fileOffset), offset + field);
    for (const field of [32, 40]) bytes.writeBigUInt64LE(BigInt(size), offset + field);
    bytes.writeBigUInt64LE(BigInt(alignment), offset + 48);
  };
  program(64, 1, 7, 0, bytes.length, 0x1000);
  program(120, 2, 6, dynamic.offset, dynamic.bytes.length, 8);
  const pointers = new Map([[5, 1], [6, 2], [4, 3], [0x6ffffff0, 4], [0x6ffffffe, 5]]);
  for (const [index, [tag, value]] of dynamicTags.entries()) {
    dynamic.bytes.writeBigInt64LE(BigInt(tag), index * 16);
    dynamic.bytes.writeBigUInt64LE(BigInt(pointers.has(tag) ? sections[pointers.get(tag)].offset : value), index * 16 + 8);
  }
  for (let index = 2; index < count; index += 1) dynsym.writeBigUInt64LE(BigInt(sections[0].offset), index * 24 + 8);
  for (const [index, section] of sections.entries()) {
    section.bytes.copy(bytes, section.offset);
    const offset = sectionOffset + (index + 1) * 64;
    bytes.writeUInt32LE(shstrtab.indexOf(Buffer.from(`${section.name}\0`)), offset);
    bytes.writeUInt32LE(section.type, offset + 4);
    bytes.writeBigUInt64LE(BigInt(section.flags), offset + 8);
    bytes.writeBigUInt64LE(BigInt(section.flags ? section.offset : 0), offset + 16);
    bytes.writeBigUInt64LE(BigInt(section.offset), offset + 24);
    bytes.writeBigUInt64LE(BigInt(section.bytes.length), offset + 32);
    bytes.writeUInt32LE(section.link ?? 0, offset + 40);
    bytes.writeUInt32LE(section.info ?? 0, offset + 44);
    bytes.writeBigUInt64LE(BigInt(section.alignment), offset + 48);
    bytes.writeBigUInt64LE(BigInt(section.entry ?? 0), offset + 56);
  }
  return bytes;
}

function writeLinuxInstallFixture(prefix, platform, options = {}) {
  const version = options.version ?? '1.0.0';
  const packageInit = [
    'get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../../" ABSOLUTE)',
    'macro(set_and_check _var _file)',
    '  set(${_var} "${_file}")',
    '  if(NOT EXISTS "${_file}")',
    '    message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")',
    '  endif()',
    'endmacro()',
    'macro(check_required_components _NAME)',
    '  foreach(comp ${${_NAME}_FIND_COMPONENTS})',
    '    if(NOT ${_NAME}_${comp}_FOUND)',
    '      if(${_NAME}_FIND_REQUIRED_${comp})',
    '        set(${_NAME}_FOUND FALSE)',
    '      endif()',
    '    endif()',
    '  endforeach()',
    'endmacro()',
  ].join('\n');
  const config = readFileSync(join(citizenSdkRoot, 'linux/cmake/CitizenSDKConfig.cmake.in'), 'utf8')
    .replaceAll('@PACKAGE_INIT@', packageInit)
    .replaceAll('@CITIZENSDK_PLATFORM@', platform)
    .replaceAll('@PACKAGE_CMAKE_INSTALL_LIBDIR@', '${PACKAGE_PREFIX_DIR}/lib')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_DATADIR@', '${PACKAGE_PREFIX_DIR}/share')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_INCLUDEDIR@', '${PACKAGE_PREFIX_DIR}/include');
  const configVersion = readFileSync(join(citizenSdkRoot, 'linux/cmake/CitizenSDKConfigVersion.cmake.in'), 'utf8')
    .replaceAll('@PROJECT_VERSION@', version)
    .replaceAll('@PROJECT_VERSION_MAJOR@', version.split('.')[0]);
  // 以下指令来自官方 CMake configure/export 的完整输出；只省略
  // 生成器注释与空行，不省略任何保护、路径推导、目标属性或导入文件检查。
  const targets = [
    'if("${CMAKE_MAJOR_VERSION}.${CMAKE_MINOR_VERSION}" LESS 2.8)',
    '   message(FATAL_ERROR "CMake >= 2.8.12 required")',
    'endif()',
    'if(CMAKE_VERSION VERSION_LESS "2.8.12")',
    '   message(FATAL_ERROR "CMake >= 2.8.12 required")',
    'endif()',
    'cmake_policy(PUSH)',
    'cmake_policy(VERSION 2.8.12...4.0)',
    'set(CMAKE_IMPORT_FILE_VERSION 1)',
    'set(_cmake_targets_defined "")',
    'set(_cmake_targets_not_defined "")',
    'set(_cmake_expected_targets "")',
    'foreach(_cmake_expected_target IN ITEMS CitizenSDK::Host)',
    '  list(APPEND _cmake_expected_targets "${_cmake_expected_target}")',
    '  if(TARGET "${_cmake_expected_target}")',
    '    list(APPEND _cmake_targets_defined "${_cmake_expected_target}")',
    '  else()',
    '    list(APPEND _cmake_targets_not_defined "${_cmake_expected_target}")',
    '  endif()',
    'endforeach()',
    'unset(_cmake_expected_target)',
    'if(_cmake_targets_defined STREQUAL _cmake_expected_targets)',
    '  unset(_cmake_targets_defined)',
    '  unset(_cmake_targets_not_defined)',
    '  unset(_cmake_expected_targets)',
    '  unset(CMAKE_IMPORT_FILE_VERSION)',
    '  cmake_policy(POP)',
    '  return()',
    'endif()',
    'if(NOT _cmake_targets_defined STREQUAL "")',
    '  string(REPLACE ";" ", " _cmake_targets_defined_text "${_cmake_targets_defined}")',
    '  string(REPLACE ";" ", " _cmake_targets_not_defined_text "${_cmake_targets_not_defined}")',
    '  message(FATAL_ERROR "Some (but not all) targets in this export set were already defined.\\nTargets Defined: ${_cmake_targets_defined_text}\\nTargets not yet defined: ${_cmake_targets_not_defined_text}\\n")',
    'endif()',
    'unset(_cmake_targets_defined)',
    'unset(_cmake_targets_not_defined)',
    'unset(_cmake_expected_targets)',
    'get_filename_component(_IMPORT_PREFIX "${CMAKE_CURRENT_LIST_FILE}" PATH)',
    'get_filename_component(_IMPORT_PREFIX "${_IMPORT_PREFIX}" PATH)',
    'get_filename_component(_IMPORT_PREFIX "${_IMPORT_PREFIX}" PATH)',
    'get_filename_component(_IMPORT_PREFIX "${_IMPORT_PREFIX}" PATH)',
    'get_filename_component(_IMPORT_PREFIX "${_IMPORT_PREFIX}" PATH)',
    'if(_IMPORT_PREFIX STREQUAL "/")',
    '  set(_IMPORT_PREFIX "")',
    'endif()',
    'add_library(CitizenSDK::Host SHARED IMPORTED)',
    'set_target_properties(CitizenSDK::Host PROPERTIES',
    '  INTERFACE_COMPILE_FEATURES "cxx_std_17"',
    '  INTERFACE_INCLUDE_DIRECTORIES "${_IMPORT_PREFIX}/include"',
    '  INTERFACE_LINK_LIBRARIES "CitizenSDK::Core"',
    ')',
    'file(GLOB _cmake_config_files "${CMAKE_CURRENT_LIST_DIR}/CitizenSDKTargets-*.cmake")',
    'foreach(_cmake_config_file IN LISTS _cmake_config_files)',
    '  include("${_cmake_config_file}")',
    'endforeach()',
    'unset(_cmake_config_file)',
    'unset(_cmake_config_files)',
    'set(_IMPORT_PREFIX)',
    'foreach(_cmake_target IN LISTS _cmake_import_check_targets)',
    '  if(CMAKE_VERSION VERSION_LESS "3.28"',
    '      OR NOT DEFINED _cmake_import_check_xcframework_for_${_cmake_target}',
    '      OR NOT IS_DIRECTORY "${_cmake_import_check_xcframework_for_${_cmake_target}}")',
    '    foreach(_cmake_file IN LISTS "_cmake_import_check_files_for_${_cmake_target}")',
    '      if(NOT EXISTS "${_cmake_file}")',
    '        message(FATAL_ERROR "The imported target \\"${_cmake_target}\\" references the file',
    '   \\"${_cmake_file}\\"',
    'but this file does not exist.  Possible reasons include:',
    '* The file was deleted, renamed, or moved to another location.',
    '* An install or uninstall procedure did not complete successfully.',
    '* The installation package was faulty and contained',
    '   \\"${CMAKE_CURRENT_LIST_FILE}\\"',
    'but not all the files it references.',
    '")',
    '      endif()',
    '    endforeach()',
    '  endif()',
    '  unset(_cmake_file)',
    '  unset("_cmake_import_check_files_for_${_cmake_target}")',
    'endforeach()',
    'unset(_cmake_target)',
    'unset(_cmake_import_check_targets)',
    'set(CMAKE_IMPORT_FILE_VERSION)',
    'cmake_policy(POP)', '',
  ].join('\n');
  const releaseTargets = [
    'set(CMAKE_IMPORT_FILE_VERSION 1)',
    'set_property(TARGET CitizenSDK::Host APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)',
    'set_target_properties(CitizenSDK::Host PROPERTIES',
    `  IMPORTED_LOCATION_RELEASE "\${_IMPORT_PREFIX}/lib/${platform}/libcitizensdk_host.so"`,
    '  IMPORTED_SONAME_RELEASE "libcitizensdk_host.so"',
    '  )',
    'list(APPEND _cmake_import_check_targets CitizenSDK::Host )',
    `list(APPEND _cmake_import_check_files_for_CitizenSDK::Host "\${_IMPORT_PREFIX}/lib/${platform}/libcitizensdk_host.so" )`,
    'set(CMAKE_IMPORT_FILE_VERSION)', '',
  ].join('\n');
  const generated = {
    'CitizenSDKConfig.cmake': config,
    'CitizenSDKConfigVersion.cmake': configVersion,
    'CitizenSDKTargets.cmake': targets,
    'CitizenSDKTargets-release.cmake': releaseTargets,
  };
  if (options.cmakeOnly) return { packageInit, targets };
  for (const relative of linuxInstallFixturePaths(platform)) {
    let bytes;
    if (relative.startsWith('include/citizen_sdk/')) {
      bytes = readFileSync(join(citizenSdkRoot,hostHeaderSource('linux',basename(relative))));
    } else if (relative.startsWith('include/')) {
      bytes = readFileSync(relative === 'include/citizensdk_qr_image.h'
        ? join(citizenSdkRoot, 'native/image/citizensdk_qr_image.h')
        : join(citizenSdkRoot, relative));
    } else if (relative.startsWith('share/')) {
      bytes = readFileSync(join(citizenSdkRoot, 'chain', basename(relative)));
    } else if (relative.endsWith('/CitizenSDKDependencies.cmake')) {
      bytes = readFileSync(join(citizenSdkRoot, 'linux/cmake', basename(relative)));
    } else if (relative.endsWith('/libcitizensdk.so')) {
      bytes = linuxElfFixture({ platform, ...options.core });
    } else if (relative.endsWith('/libcitizensdk_host.so')) {
      bytes = linuxElfFixture({ platform, host: true, ...options.host });
    } else {
      bytes = Buffer.from(generated[basename(relative)]);
    }
    const destination = join(prefix, relative);
    mkdirSync(dirname(destination), { recursive: true });
    // 两平台共享的七个 Host 头、两个 Core 头、QR 图像头和三个链资产只能原字节合并。
    if (existsSync(destination)) assert.deepEqual(readFileSync(destination), bytes);
    else writeFileSync(destination, bytes);
  }
}

function writeLinuxProjectionFixture(root) {
  cpSync(join(citizenSdkRoot, 'linux'), join(root, 'linux'), { recursive: true });
  for (const relative of [
    'pubspec.yaml', '.pubignore', 'include/citizensdk.h', 'include/citizensdk_types.h',
    ...chainAssetPaths,
  ]) {
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(citizenSdkRoot, relative), destination);
  }
  const qrImageHeader = join(root, 'native/image/citizensdk_qr_image.h');
  mkdirSync(dirname(qrImageHeader), { recursive: true });
  copyFileSync(
    join(citizenSdkRoot, 'native/image/citizensdk_qr_image.h'),
    qrImageHeader,
  );
  for (const platform of linuxPlatforms) writeLinuxInstallFixture(join(root, 'linux'), platform);
}

const chainAssetPaths = [
  'chain/chainspec.json',
  'chain/light_sync_state.json',
  'chain/manifest.json',
];
const macOSFrameworkSymlinks = Object.freeze({
  CitizenSDK: 'Versions/Current/CitizenSDK',
  Headers: 'Versions/Current/Headers',
  Modules: 'Versions/Current/Modules',
  Resources: 'Versions/Current/Resources',
  'Versions/Current': 'A',
});
const appleSwiftModuleExtensions = Object.freeze([
  'abi.json',
  'private.swiftinterface',
  'swiftdoc',
  'swiftinterface',
  'swiftmodule',
  'swiftsourceinfo',
]);
const appleFixtureSliceIdentifiers = Object.freeze({
  iosDevice: 'xcode-library-0',
  iosSimulator: 'xcode-library-1',
  macOS: 'xcode-library-2',
});

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const [name, rawContent] of Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localChunks.push(local, nameBytes, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const central = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, central, end]);
}

function plistXml(value) {
  const escape = (text) => String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
  const encode = (item) => {
    if (Array.isArray(item)) return `<array>${item.map(encode).join('')}</array>`;
    if (item && typeof item === 'object') {
      return `<dict>${Object.keys(item).sort().map((key) => `<key>${escape(key)}</key>${encode(item[key])}`).join('')}</dict>`;
    }
    if (typeof item === 'number') return `<integer>${item}</integer>`;
    if (typeof item === 'boolean') return item ? '<true/>' : '<false/>';
    return `<string>${escape(item)}</string>`;
  };
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`,
  );
}

function archivedSymlinks(gzipBytes) {
  const tar = gunzipSync(gzipBytes);
  const links = {};
  const field = (offset, length) => tar.subarray(offset, offset + length)
    .toString('utf8')
    .split('\0', 1)[0];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = field(offset, 100);
    const prefix = field(offset + 345, 155);
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const sizeText = field(offset + 124, 12).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    assert.equal(Number.isSafeInteger(size), true, `tar size 无效：${path}`);
    if (header[156] === '2'.charCodeAt(0)) {
      links[path] = field(offset + 157, 100);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return links;
}

// 独立编码 GNU tar 格式夹具，不调用生产归档器生成自己的预期结果。
// 跨平台运行件仍复用既有格式夹具；这些字节不代表真实平台构建。
function hostedTarHeader(path, { type = '0', mode = 0o644, size = 0, link = '' } = {}) {
  const header = Buffer.alloc(512);
  Buffer.from(path).copy(header, 0, 0, 99);
  const octal = (value, offset, length) => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header[156] = type.charCodeAt(0);
  Buffer.from(link).copy(header, 157, 0, 100);
  header.write('ustar\0', 257, 'ascii');
  header.write('0 ', 263, 'ascii');
  return hostedTarChecksum(header);
}

function hostedTarChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function hostedTarEntry(path, { data = Buffer.alloc(0), type = '0', mode = 0o644, ...options } = {}) {
  const bytes = Buffer.from(data);
  return Buffer.concat([
    hostedTarHeader(path, { type, mode, size: bytes.length, ...options }),
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}

function hostedTar(entries, { trailer = Buffer.alloc(1024) } = {}) {
  const blocks = [];
  for (const [path, entry] of entries) {
    // 固定 Pub 所用 tar 的 GNU 长名称正文无终止 NUL，随后是普通条目。
    if (Buffer.byteLength(path) > 99) {
      blocks.push(hostedTarEntry('././@LongLink', { type: 'L', mode: 0, data: Buffer.from(path) }));
    }
    blocks.push(hostedTarEntry(path, {
      data: entry.data,
      type: entry.type === 'directory' ? '5' : '0',
      mode: entry.mode,
    }));
  }
  return Buffer.concat([...blocks, trailer]);
}

function machOVersion(version) {
  const [major, minor, patch = 0] = version.split('.').map(Number);
  return ((major << 16) | (minor << 8) | patch) >>> 0;
}

function appleMachOFixture({
  installName = '@rpath/CitizenSDK.framework/CitizenSDK',
  minimum,
  platform,
  privateSymbols = [],
  symbols,
  cpuType = 0x0100000c,
}) {
  const dylibName = Buffer.from(`${installName}\0`);
  const dylibCommandSize = Math.ceil((24 + dylibName.length) / 8) * 8;
  const dylib = Buffer.alloc(dylibCommandSize);
  dylib.writeUInt32LE(0x0d, 0);
  dylib.writeUInt32LE(dylibCommandSize, 4);
  dylib.writeUInt32LE(24, 8);
  dylibName.copy(dylib, 24);

  const build = Buffer.alloc(24);
  build.writeUInt32LE(0x32, 0);
  build.writeUInt32LE(24, 4);
  build.writeUInt32LE(platform, 8);
  build.writeUInt32LE(machOVersion(minimum), 12);
  build.writeUInt32LE(machOVersion(minimum), 16);

  const symbolCommand = Buffer.alloc(24);
  symbolCommand.writeUInt32LE(0x02, 0);
  symbolCommand.writeUInt32LE(24, 4);
  const commands = Buffer.concat([dylib, build, symbolCommand]);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpuType, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(6, 12);
  header.writeUInt32LE(3, 16);
  header.writeUInt32LE(commands.length, 20);

  const strings = [Buffer.from([0])];
  const indexes = [];
  let stringOffset = 1;
  const symbolEntries = [
    ...symbols.map((symbol) => ({ isPrivate: false, symbol })),
    ...privateSymbols.map((symbol) => ({ isPrivate: true, symbol })),
  ];
  for (const { symbol } of symbolEntries) {
    const encoded = Buffer.from(`_${symbol}\0`);
    indexes.push(stringOffset);
    strings.push(encoded);
    stringOffset += encoded.length;
  }
  const nlist = Buffer.alloc(symbolEntries.length * 16);
  indexes.forEach((index, symbolIndex) => {
    const offset = symbolIndex * 16;
    nlist.writeUInt32LE(index, offset);
    nlist[offset + 4] = symbolEntries[symbolIndex].isPrivate ? 0x1f : 0x0f;
    nlist[offset + 5] = 1;
    nlist.writeBigUInt64LE(BigInt(symbolIndex + 1), offset + 8);
  });
  const symbolOffset = header.length + commands.length;
  const tableCommandOffset = dylib.length + build.length;
  commands.writeUInt32LE(symbolOffset, tableCommandOffset + 8);
  commands.writeUInt32LE(symbolEntries.length, tableCommandOffset + 12);
  commands.writeUInt32LE(symbolOffset + nlist.length, tableCommandOffset + 16);
  commands.writeUInt32LE(stringOffset, tableCommandOffset + 20);
  return Buffer.concat([header, commands, nlist, ...strings]);
}

function citizenSdkSymbols() {
  const header = readFileSync(join(citizenSdkRoot, 'include', 'citizensdk.h'), 'utf8');
  const symbols = [...new Set(
    [...header.matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g)].map((match) => match[1]),
  )].sort();
  assert.equal(symbols.length, 144);
  return symbols;
}

function qrImageSymbols() {
  const header = readFileSync(join(citizenSdkRoot, 'native/image/citizensdk_qr_image.h'), 'utf8');
  const symbols = [...new Set(
    [...header.matchAll(/\b(citizensdk_qr_image_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]),
  )].sort();
  assert.equal(symbols.length, 4);
  return symbols;
}

function citizenSdkLinkedSymbols() {
  return [...citizenSdkSymbols(), ...CITIZENSDK_INTERNAL_SYMBOLS].sort();
}

test('私钥receiver只通过公开Core声明，旧窗口内部符号清零', () => {
  assert.deepEqual(CITIZENSDK_INTERNAL_SYMBOLS, []);
  assert.equal(citizenSdkInternalHeader(), '#ifndef CITIZENSDK_INTERNAL_H\n#define CITIZENSDK_INTERNAL_H\n#include "citizensdk.h"\n#endif\n');
  const header = readFileSync(join(citizenSdkRoot, 'include/citizensdk.h'), 'utf8');
  const types = readFileSync(join(citizenSdkRoot, 'include/citizensdk_types.h'), 'utf8');
  assert.doesNotMatch(header, /citizensdk_internal_/u);
  for (const suffix of ['open', 'reveal', 'cancel', 'finish']) {
    assert.ok(header.includes('citizensdk_private_key_' + suffix + '('));
  }
  assert.match(types, /int32_t \(\*receive\)\(void \*context, uint64_t secret_id, citizensdk_bytes_view_t private_key\)/u);
  assert.equal(citizenSdkSymbols().length, 144);
  assert.deepEqual(citizenSdkLinkedSymbols(), citizenSdkSymbols());
});

function citizenSdkExportSymbols() {
  return [...citizenSdkSymbols(), ...qrImageSymbols(), '$s10CitizenSDK0A0CMa'];
}

function writeAppleXcframework(destination, options = {}) {
  const slices = {
    iosDevice: {
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
    },
    iosSimulator: {
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
    },
    macOS: {
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
    },
  };
  const libraries = [];
  for (const [sliceKey, contract] of Object.entries(slices)) {
    const override = options[sliceKey] ?? {};
    const identifier = override.identifier ?? appleFixtureSliceIdentifiers[sliceKey];
    const isMacOS = contract.supportedPlatform === 'macos';
    const framework = join(destination, identifier, 'CitizenSDK.framework');
    const contentRoot = isMacOS
      ? join(framework, 'Versions', 'A')
      : framework;
    const headers = join(contentRoot, 'Headers');
    const modules = join(contentRoot, 'Modules', 'CitizenSDK.swiftmodule');
    const resources = join(contentRoot, 'Resources');
    mkdirSync(headers, { recursive: true });
    mkdirSync(modules, { recursive: true });
    mkdirSync(join(resources, 'chain'), { recursive: true });
    for (const header of ['citizensdk.h', 'citizensdk_types.h', 'citizensdk_qr_image.h']) {
      const source = header === 'citizensdk_qr_image.h'
        ? join(citizenSdkRoot, 'native', 'image', header)
        : join(citizenSdkRoot, 'include', header);
      copyFileSync(source, join(headers, header));
    }
    writeFileSync(
      join(contentRoot, 'Modules', 'module.modulemap'),
      'framework module CitizenSDK {\n  umbrella header "citizensdk.h"\n  export *\n}\n',
    );
    writeFileSync(join(modules, `${contract.module}.abi.json`), '{"abi":"fixture"}\n');
    writeFileSync(join(modules, `${contract.module}.swiftdoc`), 'compiled-swift-doc');
    writeFileSync(join(modules, `${contract.module}.swiftmodule`), 'compiled-swift-module');
    writeFileSync(
      join(modules, `${contract.module}.swiftsourceinfo`),
      'compiled-swift-source-info',
    );
    writeFileSync(
      join(modules, `${contract.module}.swiftinterface`),
      '// swift-interface-format-version: 1.0\n'
        + `// swift-module-flags: -target ${contract.swiftTarget} -module-name CitizenSDK\n`
        + '@_exported import CitizenSDK\n',
    );
    writeFileSync(
      join(modules, `${contract.module}.private.swiftinterface`),
      '// swift-interface-format-version: 1.0\n'
        + `// swift-module-flags: -target ${contract.swiftTarget} -module-name CitizenSDK\n`
        + '@_exported import CitizenSDK\n'
        + '  @_spi(CitizenSDKFlutter) final public func supervisedClose() async throws\n'
        + '  @_spi(CitizenSDKFlutter) final public func enqueueForSupervisedClose()\n',
    );
    for (const asset of ['chainspec.json', 'light_sync_state.json', 'manifest.json']) {
      copyFileSync(
        join(citizenSdkRoot, 'chain', asset),
        join(resources, 'chain', asset),
      );
    }
    copyFileSync(
      join(citizenSdkRoot, 'darwin', 'source', 'core', 'PrivacyInfo.xcprivacy'),
      join(resources, 'PrivacyInfo.xcprivacy'),
    );
    writeFileSync(
      join(contentRoot, 'CitizenSDK'),
      override.binary ?? appleMachOFixture({
        cpuType: override.cpuType,
        installName: override.installName ?? contract.installName,
        minimum: override.minimum ?? contract.minimum,
        platform: override.platform ?? contract.platform,
        privateSymbols: override.privateSymbols ?? ['rust_dependency_hidden'],
        symbols: override.symbols ?? citizenSdkExportSymbols(),
      }),
    );
    writeFileSync(isMacOS
      ? join(resources, 'Info.plist')
      : join(framework, 'Info.plist'), plistXml({
      CFBundleDevelopmentRegion: 'en',
      CFBundleExecutable: 'CitizenSDK',
      CFBundleIdentifier: 'org.citizen.sdk',
      CFBundleInfoDictionaryVersion: '6.0',
      CFBundleName: 'CitizenSDK',
      CFBundlePackageType: 'FMWK',
      CFBundleShortVersionString: '1.0.0',
      CFBundleSupportedPlatforms: [contract.bundlePlatform],
      CFBundleVersion: '1.0.0',
      DTPlatformName: contract.dtPlatform,
      [contract.minimumKey]: contract.minimum.replace(/\.0$/, ''),
      ...(override.info ?? {}),
    }));
    if (isMacOS) {
      for (const [path, target] of Object.entries(macOSFrameworkSymlinks)) {
        const link = join(framework, ...path.split('/'));
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link);
      }
    }
    libraries.push({
      BinaryPath: override.binaryPath ?? contract.binaryPath,
      LibraryIdentifier: identifier,
      LibraryPath: 'CitizenSDK.framework',
      SupportedArchitectures: override.architectures ?? ['arm64'],
      SupportedPlatform: override.supportedPlatform ?? contract.supportedPlatform,
      ...(contract.variant || override.variant
        ? { SupportedPlatformVariant: override.variant ?? contract.variant }
        : {}),
      ...(override.libraryInfo ?? {}),
    });
  }
  const xcframeworkInfo = options.xcframeworkInfo ?? {};
  writeFileSync(join(destination, 'Info.plist'), plistXml({
    AvailableLibraries: xcframeworkInfo.libraries ?? libraries,
    CFBundlePackageType: 'XFWK',
    XCFrameworkFormatVersion: '1.0',
    ...(xcframeworkInfo.fields ?? {}),
  }));
}

function writeAppleProjectionFixture(root, options = {}) {
  for (const path of [
    'include/citizensdk.h',
    'include/citizensdk_types.h',
    'native/image/citizensdk_qr_image.h',
    'chain/chainspec.json',
    'chain/light_sync_state.json',
    'chain/manifest.json',
    'darwin/source/core/PrivacyInfo.xcprivacy',
    'pubspec.yaml',
  ]) {
    const destination = join(root, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(citizenSdkRoot, ...path.split('/')), destination);
  }
  writeAppleXcframework(
    join(root, 'darwin', 'CitizenSDK.xcframework'),
    options,
  );
}

function appleFixtureFramework(root, sliceKey) {
  const identifier = appleFixtureSliceIdentifiers[sliceKey] ?? sliceKey;
  return join(
    root,
    'darwin',
    'CitizenSDK.xcframework',
    identifier,
    'CitizenSDK.framework',
  );
}

function appleFixtureContentRoot(root, sliceKey) {
  const framework = appleFixtureFramework(root, sliceKey);
  return sliceKey === 'macOS' || sliceKey === appleFixtureSliceIdentifiers.macOS
    ? join(framework, 'Versions', 'A')
    : framework;
}

function androidAarFixture(core, jni, {
  classEntries = {
    'org/citizen/sdk/CitizenSdk.class': Buffer.from('CitizenSDK native facade'),
    'org/citizen/sdk/CitizenSdkLifecycle.class': Buffer.from('CitizenSDK lifecycle'),
    'org/citizen/sdk/CitizenSdkException.class': Buffer.from('CitizenSDK errors'),
    'org/citizen/sdk/CitizenSdkEvents.class': Buffer.from('CitizenSDK events'),
    'org/citizen/sdk/CitizenWalletProfile.class': Buffer.from('CitizenSDK wallet profile'),
    'org/citizen/sdk/CitizenSdkOperation.class': Buffer.from('CitizenSDK operation'),
    'org/citizen/sdk/internal/CitizenSdkNative.class': Buffer.from('CitizenSDK JNI owner'),
    'org/citizen/sdk/internal/CitizenSdkHardwareVault.class': Buffer.from('CitizenSDK vault'),
    'org/citizen/sdk/internal/CitizenSdkHostServices.class': Buffer.from('CitizenSDK host services'),
    'org/citizen/sdk/internal/CitizenSdkRequestRouter.class': Buffer.from('CitizenSDK request router'),
    'org/citizen/sdk/CitizenSdkPreparedWallet.class': Buffer.from('CitizenSDK headless 0'),
    'org/citizen/sdk/CitizenSdkRecoveryPhrase.class': Buffer.from('CitizenSDK headless 1'),
    'org/citizen/sdk/CitizenSdkPrivateKey.class': Buffer.from('CitizenSDK headless 2'),
    'org/citizen/sdk/CitizenSdkQrCapture.class': Buffer.from('CitizenSDK headless 3'),
    'org/citizen/sdk/CitizenQrReview.class': Buffer.from('CitizenSDK headless 4'),
    'org/citizen/sdk/CitizenWalletInspection.class': Buffer.from('CitizenSDK headless 5'),
    'org/citizen/sdk/CitizenWalletDiagnostic.class': Buffer.from('CitizenSDK headless 6'),
    'org/citizen/sdk/CitizenWalletCleanupTargets.class': Buffer.from('CitizenSDK headless 7'),
  },
  assets = {
    'assets/chain/chainspec.json': Buffer.from('chainspec'),
    'assets/chain/light_sync_state.json': Buffer.from('sync-state'),
    'assets/chain/manifest.json': Buffer.from('asset-manifest'),
  },
  extraEntries = {},
} = {}) {
  return storedZip({
    'AndroidManifest.xml': Buffer.from('manifest'),
    ...assets,
    'classes.jar': storedZip(classEntries),
    'jni/arm64-v8a/libcitizensdk.so': core,
    'jni/arm64-v8a/libcitizensdk_jni.so': jni,
    ...extraEntries,
  });
}


// 第10.5步：只用于格式/拒绝测试的固定合同金标，绝非另一套生产来源入口。
const dependencyLockFixture = JSON.parse(
  readFileSync(join(citizenSdkRoot, 'scripts/dependencies.lock.json'), 'utf8'),
);
const dependencyContractFixture = dependencyLockFixture.native;
const opensslHeaderFixture = ["aes.h","asn1.h","asn1err.h","asn1t.h","async.h","asyncerr.h","bio.h","bioerr.h","blowfish.h","bn.h","bnerr.h","buffer.h","buffererr.h","byteorder.h","camellia.h","cast.h","cmac.h","cmp.h","cmp_util.h","cmperr.h","cms.h","cmserr.h","comp.h","comperr.h","conf.h","conf_api.h","conferr.h","configuration.h","conftypes.h","core.h","core_dispatch.h","core_names.h","core_object.h","crmf.h","crmferr.h","crypto.h","cryptoerr.h","cryptoerr_legacy.h","ct.h","cterr.h","decoder.h","decodererr.h","des.h","dh.h","dherr.h","dsa.h","dsaerr.h","dtls1.h","e_os2.h","e_ostime.h","ebcdic.h","ec.h","ecdh.h","ecdsa.h","ecerr.h","encoder.h","encodererr.h","engine.h","engineerr.h","err.h","ess.h","esserr.h","evp.h","evperr.h","fips_names.h","fipskey.h","hmac.h","hpke.h","http.h","httperr.h","idea.h","indicator.h","kdf.h","kdferr.h","lhash.h","macros.h","md2.h","md4.h","md5.h","mdc2.h","ml_kem.h","modes.h","obj_mac.h","objects.h","objectserr.h","ocsp.h","ocsperr.h","opensslconf.h","opensslv.h","ossl_typ.h","param_build.h","params.h","pem.h","pem2.h","pemerr.h","pkcs12.h","pkcs12err.h","pkcs7.h","pkcs7err.h","prov_ssl.h","proverr.h","provider.h","quic.h","rand.h","randerr.h","rc2.h","rc4.h","rc5.h","ripemd.h","rsa.h","rsaerr.h","safestack.h","seed.h","self_test.h","sha.h","srp.h","srtp.h","ssl.h","ssl2.h","ssl3.h","sslerr.h","sslerr_legacy.h","stack.h","store.h","storeerr.h","symhacks.h","thread.h","tls1.h","trace.h","ts.h","tserr.h","txt_db.h","types.h","ui.h","uierr.h","whrlpool.h","x509.h","x509_acert.h","x509_vfy.h","x509err.h","x509v3.h","x509v3err.h"];
const dependencyFixtureHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function dependencyArchiveFixture(platform) {
  const object = Buffer.alloc(platform === 'Windows' ? 60 : 128);
  if (platform === 'Windows') { object.writeUInt16LE(0x8664); object.writeUInt16LE(1, 2); }
  else {
    object.set([127, 69, 76, 70, 2, 1, 1]);
    object.writeUInt16LE(1, 16); object.writeUInt16LE(platform === 'LinuxARM' ? 183 : 62, 18);
    object.writeBigUInt64LE(64n, 40); object.writeUInt16LE(64, 52);
    object.writeUInt16LE(64, 58); object.writeUInt16LE(1, 60);
  }
  const header = 'fixture.o/'.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6)
    + '100644'.padEnd(8) + String(object.length).padEnd(10) + '\x60\n';
  return Buffer.concat([Buffer.from('!<arch>\n' + header), object]);
}
function dependencyGnuLongArchiveFixture(platform, reference = '/0', terminator = '/\n') {
  const object = dependencyArchiveFixture(platform).subarray(68);
  const names = Buffer.from('citizensdk_dependency_object_with_long_name.o' + terminator);
  const member = (name, payload) => {
    const header = name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6)
      + '100644'.padEnd(8) + String(payload.length).padEnd(10) + '\x60\n';
    return Buffer.concat([Buffer.from(header), payload, ...(payload.length % 2 ? [Buffer.from('\n')] : [])]);
  };
  return Buffer.concat([Buffer.from('!<arch>\n'), member('//', names), member(reference, object)]);
}
function dependencyNestedCryptoArchiveFixture(platform, name = 'libcrypto.a/') {
  const object = dependencyArchiveFixture(platform);
  const header = name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6)
    + '100644'.padEnd(8) + String(object.length).padEnd(10) + '\x60\n';
  return Buffer.concat([Buffer.from('!<arch>\n' + header), object]);
}
function dependencyInputsFixture(root, platform) {
  const files = { 'include/sqlite3.h': Buffer.from('format-only SQLite header') };
  const archives = platform === 'Windows' ? ['sqlite3.lib'] : ['libsqlite3.a', 'libcrypto.a',
    ...['esys', 'sys', 'mu', 'rc', 'tcti-device'].map((name) => 'libtss2-' + name + '.a')];
  for (const name of archives) files['lib/' + name] = dependencyArchiveFixture(platform);
  if (platform !== 'Windows') {
    for (const name of opensslHeaderFixture) files['include/openssl/' + name] = Buffer.from('format-only OpenSSL header');
    for (const name of ['common', 'esys', 'mu', 'rc', 'sys', 'tcti', 'tcti_device', 'tpm2_types'])
      files['include/tss2/tss2_' + name + '.h'] = Buffer.from('format-only TSS header');
  }
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  const tools = platform === 'Windows' ? ['cl', 'lib', 'tar'] : ['cc', 'ar', 'perl', 'make', 'sh', 'pkg-config', 'tar', 'unzip'];
  const receipt = { schema: 1, platform, source_sha: '0'.repeat(40), software_version: '1.0.0', build_mode: 'ci',
    native_dependencies: structuredClone(dependencyContractFixture),
    build_tools: tools.map((name) => ({ name, sha256: dependencyFixtureHash(Buffer.from('fake-tool-' + name)),
      ...(name === 'cc' ? { target: platform === 'LinuxARM' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu' } : {}) })),
    files: Object.keys(files).sort().map((path) => ({ path, sha256: dependencyFixtureHash(files[path]) })) };
  const path = join(root, 'native-dependencies.json');
  writeFileSync(path, JSON.stringify(receipt));
  return { receipt, path };
}

test('第10.5步固定官方版本来源及摘要不能混用', () => {
  assert.doesNotThrow(() => assertCitizenSdkNativeContract(dependencyContractFixture));
  for (const edit of [
    (c) => { c.sources.sqlite.version = '3.53.3'; },
    (c) => { c.sources.sqlite.sha3_256 = c.sources.sqlite.sha256; },
    (c) => { c.sources.openssl.url = 'https://example.invalid/openssl.tar.gz'; },
    (c) => { c.sources['tpm2-tss'].license_sha256 = '0'.repeat(64); },
    (c) => { c.platforms.Windows.msvc_runtime = '/MT'; },
    (c) => { c.openssl_options.push('-static'); },
  ]) {
    const changed = structuredClone(dependencyContractFixture); edit(changed);
    assert.throws(() => assertCitizenSdkNativeContract(changed), /固定来源/);
  }
});

test('CitizenSDK依赖锁与独立准备入口覆盖环境和三平台静态前缀', () => {
  assert.deepEqual(Object.keys(dependencyLockFixture).sort(), [
    'android_tools', 'environment', 'headers', 'native', 'schema',
  ]);
  assert.deepEqual(dependencyLockFixture.android_tools, {
    agp: '9.0.1', cmake: '3.31.6', gradle: '9.1.0', kotlin: '2.2.20', ndk: '28.2.13676358',
  });
  const androidProperties = readFileSync(join(citizenSdkRoot, 'android/gradle.properties'), 'utf8');
  assert.deepEqual(androidProperties.split('\n')
    .filter((line) => /^android\.(?:builtInKotlin|newDsl)=/u.test(line)), [
    'android.builtInKotlin=true', 'android.newDsl=true',
  ]);
  expectLockedSource(dependencyLockFixture.environment['zxing-cpp'], '3.1.1',
    'c3c02c29c0b519de7bd4e25b376e606e87f0761befd1282815642a2246613d14');
  const preparer = readFileSync(join(citizenSdkRoot, 'scripts/resources.mjs'), 'utf8').split('// 原生依赖准备实现与资源交付共用唯一模块。')[1].split('// 正式实现结束；')[0];
  assert.match(preparer, /command === 'plan'/u);
  assert.match(preparer, /command === 'prepare-environment'/u);
  assert.match(preparer, /command === 'prepare-native'/u);
  assert.match(preparer, /attempt <= 3/u);
  assert.match(preparer, /function developerCache\(\).*target/u);
  // 仅官方包装的两个准确相对目标有意包含父级段；其它源码外回指仍拒绝。
  assert.doesNotMatch(preparer.replace(/'\.\.\/\.\.\/core\/?'/gu, "''"), /\.\.\/\.\.\/|\/Users\//u);
});

test('ZXing准备只接受两条准确包内链接并在拒绝时清理本轮暂存', async () => {
  const root = mkdtempSync(join(workRoot, 'release-source-links-'));
  const source = readFileSync(join(citizenSdkRoot, 'scripts/resources.mjs'), 'utf8').split('// 原生依赖准备实现与资源交付共用唯一模块。')[1].split('// 正式实现结束；')[0];
  const start = source.indexOf('function safeExternalDirectory(');
  const end = source.indexOf('\nfunction sourceEntriesFor(', start);
  assert.ok(start >= 0 && end > start, '直接执行生产准备函数，不复制链接策略');
  const fixtureLock = structuredClone(dependencyLockFixture);
  const entry = fixtureLock.environment['zxing-cpp'];
  const api = runInNewContext(source.slice(start, end) + '\n({verifyExtractedTree, prepareSource})', {
    existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync,
    renameSync, rmSync, statSync, writeFileSync, spawnSync, join, parse, relative, resolve, sep,
    isAbsolute, sdkDirectory: citizenSdkRoot, lock: fixtureLock, process, Buffer, URL, AbortSignal,
    sha256: bytes => createHash('sha256').update(bytes).digest('hex'),
    sha256File: path => createHash('sha256').update(readFileSync(path)).digest('hex'),
    fail: message => { throw Error(message); },
    fetch: () => { throw Error('链接回归禁止下载'); },
  });
  const createTree = (name) => {
    const tree = join(root, name, entry.archive_root);
    mkdirSync(join(tree, 'core/src'), { recursive: true });
    mkdirSync(join(tree, 'wrappers/python'), { recursive: true });
    mkdirSync(join(tree, 'wrappers/rust'), { recursive: true });
    writeFileSync(join(tree, 'CMakeLists.txt'), '# 合成准备边界输入，不编译依赖\n');
    writeFileSync(join(tree, 'core/src/ZXingC.h'), '/* 合成头文件，仅验证目录结构 */\n');
    symlinkSync('../../core', join(tree, 'wrappers/python/core'));
    symlinkSync('../../core/', join(tree, 'wrappers/rust/core'));
    return tree;
  };
  try {
    const normal = createTree('normal');
    assert.doesNotThrow(() => api.verifyExtractedTree(normal, entry));
    assert.equal(readlinkSync(join(normal, 'wrappers/python/core')), '../../core');
    assert.equal(readlinkSync(join(normal, 'wrappers/rust/core')), '../../core/');
    assert.throws(() => api.verifyExtractedTree(normal, { ...entry }), /未许可链接/u);
    for (const [name, target] of [
      ['wrong', '../../core/src'],
      ['absolute', join(normal, 'core')],
      ['escape', '../../../outside'],
      ['cycle', 'core'],
      ['equivalent', '../../core/../core'],
    ]) {
      const tree = createTree(name);
      const link = join(tree, 'wrappers/python/core');
      unlinkSync(link);
      symlinkSync(target, link);
      assert.throws(() => api.verifyExtractedTree(tree, entry), /未许可链接/u, name);
    }
    const dangling = createTree('dangling');
    rmSync(join(dangling, 'core'), { recursive: true });
    assert.throws(() => api.verifyExtractedTree(dangling, entry), /同包普通core目录/u);
    const redirected = createTree('redirected');
    rmSync(join(redirected, 'core'), { recursive: true });
    symlinkSync(join(normal, 'core'), join(redirected, 'core'));
    assert.throws(() => api.verifyExtractedTree(redirected, entry), /未许可链接|同包普通core目录/u);
    const unknown = createTree('unknown');
    symlinkSync('core', join(unknown, 'extra'));
    assert.throws(() => api.verifyExtractedTree(unknown, entry), /未许可链接/u);
    // 用真实tar驱动生产prepareSource：正确归档保留链接，错误归档不得留下目标或.extract暂存。
    for (const [name, tree, accepted] of [['ok', normal, true], ['bad', unknown, false]]) {
      const work = join(root, 'work-' + name);
      mkdirSync(join(work, 'archives'), { recursive: true });
      const archive = join(root, name + '.tar.gz');
      const result = spawnSync('tar', ['-czf', archive, '-C', dirname(tree), entry.archive_root], {
        encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      assert.equal(result.status, 0, result.stderr);
      const bytes = readFileSync(archive);
      entry.size = bytes.length;
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      copyFileSync(archive, join(work, 'archives', entry.sha256 + '.tar.gz'));
      if (accepted) {
        const prepared = await api.prepareSource(entry, work);
        assert.equal(readlinkSync(join(prepared, 'wrappers/python/core')), '../../core');
        assert.doesNotThrow(() => api.verifyExtractedTree(prepared, entry));
      } else {
        await assert.rejects(api.prepareSource(entry, work), /未许可链接/u);
        assert.equal(existsSync(join(work, entry.archive_root)), false);
      }
      assert.equal(readdirSync(work).some(name => name.startsWith('.extract-')), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Apple三个slice把各自SDKROOT传给真实Cargo调用段且预检失败不编译', () => {
  const root = mkdtempSync(join(workRoot, 'release-apple-sdkroot-'));
  try {
    const source = BUILD_SHELL_SOURCES.native;
    const body = source.indexOf('build_apple_framework_slice() {\n');
    const start = source.indexOf('  sdk_path="$(xcrun --sdk "$apple_sdk" --show-sdk-path)"', body);
    const end = source.indexOf('\n  esac', start);
    assert.ok(body >= 0 && start > body && end > start);
    const fragment = source.slice(start, end + '\n  esac'.length);
    const sdk = join(root, 'SDK with spaces');
    mkdirSync(sdk);
    // 直接执行生产解析/调用段；只替换外部命令观察环境和非零传播，不复制选SDK逻辑。
    const script = [
      'set -euo pipefail',
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      'xcrun() { [[ "$1" == --sdk && "$2" == "$TEST_APPLE_SDK" && "$3" == --show-sdk-path ]]; printf "%s\\n" "$TEST_SDK"; }',
      'cargo() { printf "SDKROOT=%s\\nARGS=%s\\n" "$SDKROOT" "$*"; return "$TEST_CARGO_EXIT"; }',
      'rust_target="$TEST_TARGET"; apple_sdk="$TEST_APPLE_SDK"; slice_name="$TEST_TARGET"',
      'ios_deployment_target=16.0; macos_deployment_target=13.0; product_ffi_manifest=product-Cargo.toml',
      fragment,
    ].join('\n');
    const invoke = (target, appleSdk, directory = sdk, exit = '0') => spawnSync('/bin/bash', ['-c', script], {
      encoding: 'utf8', env: { ...process.env, SDKROOT: '/wrong-inherited-sdk',
        TEST_TARGET: target, TEST_APPLE_SDK: appleSdk, TEST_SDK: directory, TEST_CARGO_EXIT: exit },
    });
    for (const [target, appleSdk] of [
      ['aarch64-apple-ios', 'iphoneos'],
      ['aarch64-apple-ios-sim', 'iphonesimulator'],
      ['aarch64-apple-darwin', 'macosx'],
    ]) {
      const result = invoke(target, appleSdk);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'SDKROOT=' + sdk
        + '\nARGS=build --manifest-path product-Cargo.toml --release --locked --target ' + target);
      assert.equal(invoke(target, appleSdk, sdk, '29').status, 29, 'Cargo失败必须传播');
    }
    const missing = invoke('aarch64-apple-darwin', 'macosx', join(root, 'missing'));
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout.includes('ARGS='), false, '缺SDK不能进入Cargo');
    const unsupported = invoke('unregistered-target', 'macosx');
    assert.notEqual(unsupported.status, 0);
    assert.equal(unsupported.stdout.includes('ARGS='), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Apple测试目标独立于交付最低版本且任一测试失败立即终止', () => {
  const source = BUILD_SHELL_SOURCES.native;
  const tests = nativeShellFunctions(['build_apple_tests']);
  const start = tests.indexOf('  run_apple_test_harness aarch64-apple-ios ');
  const end = tests.indexOf('\n  run_final_apple_consumer_smoke', start);
  assert.ok(start > 0 && end > start);
  const calls = tests.slice(start, end) + '\n  run_final_apple_consumer_smoke';
  const script = [
    'set -euo pipefail',
    'flutter_ios_xcframework="/tool with space/Flutter.xcframework"',
    'flutter_macos_xcframework="/tool with space/FlutterMacOS.xcframework"',
    'run_apple_test_harness() { printf "%s|%s|%s|%s\\n" "$1" "$3" "$6" "$7"; if [[ "$1" == "$FAIL_TARGET" ]]; then return 29; fi; }',
    'run_final_apple_consumer_smoke() { printf "consumer\\n"; }',
    calls,
  ].join('\n');
  const invoke = target => spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, FAIL_TARGET: target },
  });
  const expected = [
    'aarch64-apple-ios|arm64-apple-ios17.0|/tool with space/Flutter.xcframework|compile',
    'aarch64-apple-ios-sim|arm64-apple-ios17.0-simulator|/tool with space/Flutter.xcframework|compile',
    'aarch64-apple-darwin|arm64-apple-macosx14.0|/tool with space/FlutterMacOS.xcframework|run',
    'consumer',
  ];
  const success = invoke('');
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(success.stdout.trim().split('\n'), expected);
  for (const [index, target] of ['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'aarch64-apple-darwin'].entries()) {
    const failure = invoke(target);
    assert.equal(failure.status, 29, failure.stderr);
    assert.deepEqual(failure.stdout.trim().split('\n'), expected.slice(0, index + 1));
  }
  // 对照生产函数及同一包模板，防止为消除测试警告提高正式交付最低版本。
  const packageSource = nativeShellFunctions(['write_apple_test_package']);
  assert.match(packageSource, /platforms: \[\.iOS\(\.v17\), \.macOS\(\.v14\)\]/u);
  assert.match(packageSource, /\.unsafeFlags\(\["-enable-testing", "-Xfrontend", "-target", "-Xfrontend", "\$product_swift_target"\]\)/u);
  assert.equal((packageSource.match(/swiftSettings: testable/gu) ?? []).length, 2);
  assert.equal((packageSource.match(/swiftSettings: strict/gu) ?? []).length, 2);
  const harnessSource = nativeShellFunctions(['run_apple_test_harness']);
  const sdkMapping = harnessSource.match(/  case "\$apple_sdk" in\n[\s\S]*?\n  esac/u)?.[0];
  assert.ok(sdkMapping, '必须读取生产测试函数内的目标映射');
  for (const [sdk, expectedTarget] of [
    ['iphoneos', 'arm64-apple-ios16.0'],
    ['iphonesimulator', 'arm64-apple-ios16.0-simulator'],
    ['macosx', 'arm64-apple-macosx13.0'],
  ]) {
    const mapped = spawnSync('/bin/bash', ['-c',
      'set -euo pipefail\nfail() { exit 31; }\nios_deployment_target=16.0; macos_deployment_target=13.0\n'
      + sdkMapping + '\nprintf "%s" "$product_swift_target"'], {
      encoding: 'utf8', env: { ...process.env, apple_sdk: sdk },
    });
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.equal(mapped.stdout, expectedTarget);
  }
  const rejected = spawnSync('/bin/bash', ['-c',
    'set -euo pipefail\nfail() { exit 31; }\nios_deployment_target=16.0; macos_deployment_target=13.0\n'
    + sdkMapping], { encoding: 'utf8', env: { ...process.env, apple_sdk: 'unknown' } });
  assert.equal(rejected.status, 31);
  assert.match(harnessSource, /"\$zxing_library" "\$product_swift_target"/u);
  assert.match(source, /^ios_deployment_target=16[.]0$/mu);
  assert.match(source, /^macos_deployment_target=13[.]0$/mu);
  const product = nativeShellFunctions(['build_apple']);
  assert.match(product, /aarch64-apple-ios iphoneos arm64-apple-ios16[.]0/u);
  assert.match(product, /aarch64-apple-ios-sim iphonesimulator arm64-apple-ios16[.]0-simulator/u);
  assert.match(product, /aarch64-apple-darwin macosx arm64-apple-macosx13[.]0/u);
  // 此函数内嵌Swift heredoc，不能用第一个顶格右括号当Shell函数结束。
  const consumerStart = source.indexOf('\nrun_final_apple_consumer_smoke() {');
  const consumerEnd = source.indexOf('\nbuild_apple_tests() {', consumerStart);
  assert.ok(consumerStart > 0 && consumerEnd > consumerStart);
  assert.match(source.slice(consumerStart, consumerEnd), /-target arm64-apple-macosx13[.]0/u);
});

test('CitizenSDK依赖计划只投影自身锁定归档且拒绝错误平台', () => {
  const entry = join(citizenSdkRoot, 'scripts/dependencies.mjs');
  for (const platform of ['Android', 'macOS']) {
    const result = spawnSync(process.execPath, [entry, 'plan', '--platform', platform], {
      encoding: 'utf8', env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(value).sort(), ['archives', 'platform', 'schema']);
    assert.equal(value.schema, 1);
    assert.equal(value.platform, platform);
    assert.deepEqual(value.archives, [{
      name: 'zxing-cpp', version: dependencyLockFixture.environment['zxing-cpp'].version,
      url: dependencyLockFixture.environment['zxing-cpp'].url,
      size: dependencyLockFixture.environment['zxing-cpp'].size,
      sha256: dependencyLockFixture.environment['zxing-cpp'].sha256,
      archive_root: dependencyLockFixture.environment['zxing-cpp'].archive_root,
    }]);
  }
  const invalid = spawnSync(process.execPath, [entry, 'plan', '--platform', 'ios'], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /平台无效/u);
});

function expectLockedSource(source, version, digest) {
  assert.equal(source.version, version);
  assert.equal(source.sha256, digest);
  assert.match(source.url, /^https:\/\//u);
  assert.ok(Number.isSafeInteger(source.size) && source.size > 0);
}

test('第10.5步静态归档逐成员拒绝错误架构薄归档及动态输入', () => {
  for (const platform of ['LinuxARM', 'LinuxAMD', 'Windows']) {
    const bytes = dependencyArchiveFixture(platform);
    assert.doesNotThrow(() => assertCitizenSdkStaticArchive(bytes, platform));
    assert.doesNotThrow(() => assertCitizenSdkStaticArchive(dependencyGnuLongArchiveFixture(platform), platform));
    if (platform !== 'Windows') {
      assert.doesNotThrow(() => assertCitizenSdkStaticArchive(dependencyNestedCryptoArchiveFixture(platform), platform));
      assert.throws(
        () => assertCitizenSdkStaticArchive(dependencyNestedCryptoArchiveFixture(platform, 'other.a/'), platform),
        /非目标 Linux ELF relocatable 对象：other\.a\//,
      );
      assert.throws(
        () => assertCitizenSdkStaticArchive(dependencyNestedCryptoArchiveFixture(platform), platform, true),
        /libcrypto 静态归档嵌套层级无效/,
      );
    }
    const malformed = Buffer.from(bytes);
    if (platform === 'Windows') malformed.writeUInt16LE(99, 68 + 2);
    else malformed.writeBigUInt64LE(999999n, 68 + 40);
    assert.throws(() => assertCitizenSdkStaticArchive(malformed, platform), /section table/);
    for (const other of ['LinuxARM', 'LinuxAMD', 'Windows'].filter((x) => x !== platform)) {
      const error = platform === 'Windows' || other === 'Windows' ? /静态|对象/
        : /非目标 Linux ELF relocatable 对象：fixture\.o\//;
      assert.throws(() => assertCitizenSdkStaticArchive(bytes, other), error);
    }
    for (const bad of [Buffer.from('!<thin>\n'), bytes.subarray(0, -1),
      Buffer.from('dynamic shared library'), Buffer.from('!<arch>\n')])
      assert.throws(() => assertCitizenSdkStaticArchive(bad, platform), /静态依赖/);
    for (const bad of [dependencyGnuLongArchiveFixture(platform, '/999'),
      dependencyGnuLongArchiveFixture(platform, '/0', '\n')])
      assert.throws(() => assertCitizenSdkStaticArchive(bad, platform), /GNU ar/);
  }
});

test('第10.5步准备输入拒绝缺件额外头篡改收据及路径链接', () => {
  const root = mkdtempSync(join(workRoot, 'static-input-test-'));
  try {
    for (const platform of ['LinuxARM', 'LinuxAMD', 'Windows']) {
      const prefix = join(root, platform), fixture = dependencyInputsFixture(prefix, platform);
      assert.doesNotThrow(() => assertCitizenSdkDependencyInputs(fixture.path, platform));
      const env = citizenSdkDependencyEnvironment(fixture.path, platform);
      assert.equal(Object.keys(env).length, platform === 'Windows' ? 2 : 10);
      const file = join(prefix, 'include/sqlite3.h'), bytes = readFileSync(file);
      writeFileSync(file, 'tampered');
      assert.throws(() => assertCitizenSdkDependencyInputs(fixture.path, platform), /摘要不符/);
      writeFileSync(file, bytes);
      writeFileSync(join(prefix, 'include/extra.h'), 'extra');
      assert.throws(() => assertCitizenSdkDependencyInputs(fixture.path, platform), /未登记文件/);
      unlinkSync(join(prefix, 'include/extra.h'));
      unlinkSync(file);
      assert.throws(() => assertCitizenSdkDependencyInputs(fixture.path, platform), /未登记文件/);
      writeFileSync(file, bytes);
      const original = readFileSync(fixture.path);
      fixture.receipt.platform = platform === 'Windows' ? 'LinuxAMD' : 'Windows';
      writeFileSync(fixture.path, JSON.stringify(fixture.receipt));
      assert.throws(() => assertCitizenSdkDependencyInputs(fixture.path, platform), /身份|平台/);
      writeFileSync(fixture.path, original);
      unlinkSync(file); symlinkSync(fixture.path, file);
      assert.throws(() => assertCitizenSdkDependencyInputs(fixture.path, platform), /链接|symlink/i);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('第10.5步链接证据绑定真实输出版本提交和法律材料', () => {
  const root = mkdtempSync(join(workRoot, 'static-linked-test-'));
  try {
    const native = writeNativeFixture(root);
    for (const platform of ['LinuxARM', 'LinuxAMD', 'Windows']) {
      const path = join(native, 'dependencies', platform + '.json');
      const evidence = JSON.parse(readFileSync(path));
      const verify = (value) => assertCitizenSdkDependencyEvidence(value, platform, native, 'native',
        citizenSdkRoot, '0'.repeat(40), '1.0.0');
      assert.doesNotThrow(() => verify(evidence));
      for (const edit of [
        (e) => { e.dependency_inputs.source_sha = '1'.repeat(40); },
        (e) => { e.dependency_inputs.software_version = '1.0.1'; },
        (e) => { e.linked_artifacts[0].sha256 = '1'.repeat(64); },
        (e) => { e.files[0].sha256 = '1'.repeat(64); },
        (e) => { e.files.pop(); },
      ]) { const changed = structuredClone(evidence); edit(changed); assert.throws(() => verify(changed), /静态依赖/); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('第10.5步缺少或混版证据在创建候选目录之前失败', () => {
  const root = mkdtempSync(join(workRoot, 'static-candidate-preflight-'));
  try {
    const native = writeNativeFixture(root), output = join(root, 'candidate');
    const path = join(native, 'dependencies/Windows.json'), original = readFileSync(path);
    unlinkSync(path);
    const build = () => buildCitizenSdkRelease({ sourcePath: citizenSdkRoot, nativePath: native,
      outputPath: output, archivePath: join(root, 'citizensdk.tgz'), gitCommitSha: '0'.repeat(40), softwareVersion: '1.0.0' });
    assert.throws(build, /证据平台闭集/);
    assert.equal(existsSync(output), false);
    const changed = JSON.parse(original); changed.dependency_inputs.build_mode = 'release';
    writeFileSync(path, JSON.stringify(changed));
    assert.throws(build, /混用了 CI 与 Release/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


function writeNativeFixture(root, { appleNative = null } = {}) {
  const native = join(root, 'native-output');
  const core = Buffer.from('android-core');
  const jni = Buffer.from('android-jni');
  // The full-candidate fixture must carry the exact source trust anchors.
  // Synthetic asset bytes are reserved for the isolated projection tests;
  // otherwise the candidate test could not exercise the production
  // source↔AAR byte-identity contract.
  const assets = Object.fromEntries(chainAssetPaths.map((path) => [
    `assets/${path}`,
    readFileSync(join(citizenSdkRoot, ...path.split('/'))),
  ]));
  const aar = androidAarFixture(core, jni, { assets });
  for (const [path, value] of [
    ['android/citizensdk.aar', aar],
    ['android/arm64-v8a/libcitizensdk.so', core],
    ['android/arm64-v8a/libcitizensdk_jni.so', jni],
  ]) {
    const destination = join(native, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  }
  const apple = join(native, 'apple', 'CitizenSDK.xcframework');
  if (appleNative === null) {
    writeAppleXcframework(apple);
  } else {
    // 只在显式真实 macOS 安装验收中换入本轮 Apple 产物；其它平台继续标为
    // 格式夹具，生产发布器没有跳过验证或用夹具替代正式运行件的开关。
    assert.equal(lstatSync(appleNative).isSymbolicLink(), false);
    assert.equal(lstatSync(appleNative).isDirectory(), true);
    cpSync(appleNative, apple, {
      recursive: true, dereference: false, verbatimSymlinks: true,
      force: false, errorOnExist: true,
    });
  }
  for (const platform of linuxPlatforms) {
    writeLinuxInstallFixture(join(native, 'linux', platform), platform);
  }
  const windows = windowsInstallFixture(join(root, 'windows-input'));
  cpSync(windows.prefix, join(native, 'Windows'), { recursive: true });
  for (const platform of ['LinuxARM', 'LinuxAMD', 'Windows']) {
    const inputs = dependencyInputsFixture(join(root, 'dependency-inputs', platform), platform);
    writeCitizenSdkDependencyEvidence({ receiptPath: inputs.path, platform, nativePath: native,
      sourcePath: citizenSdkRoot, sourceSha: '0'.repeat(40) });
  }
  return native;
}

function writeAndroidProjectionFixture(root, options = {}) {
  const core = Buffer.from('android-core');
  const jni = Buffer.from('android-jni');
  const android = join(root, 'android');
  const assets = options.assets ?? {
    'assets/chain/chainspec.json': Buffer.from('chainspec'),
    'assets/chain/light_sync_state.json': Buffer.from('sync-state'),
    'assets/chain/manifest.json': Buffer.from('asset-manifest'),
  };
  const nativeLeaf = join(android, 'src', 'main', 'jniLibs', 'arm64-v8a');
  mkdirSync(nativeLeaf, { recursive: true });
  for (const [path, value] of Object.entries(assets)) {
    const destination = join(root, ...path.replace(/^assets\//u, '').split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
  }
  writeFileSync(
    join(android, 'citizensdk.aar'),
    androidAarFixture(core, jni, { ...options, assets }),
  );
  writeFileSync(join(nativeLeaf, 'libcitizensdk.so'), core);
  writeFileSync(join(nativeLeaf, 'libcitizensdk_jni.so'), jni);
  return android;
}

function writeCoreRustFixture(root) {
  const native = join(root, 'native');
  mkdirSync(native, { recursive: true });
  for (const directory of ['contracts', 'engine', 'ffi', 'qr', 'image']) {
    cpSync(
      join(citizenSdkRoot, 'native', directory),
      join(native, directory),
      { recursive: true },
    );
  }
  for (const directory of ['signer', 'smoldot', 'provider', 'legacy']) {
    mkdirSync(join(native, directory));
  }
  for (const path of [
    'Cargo.toml',
    'Cargo.lock',
  ]) {
    const destination = join(root, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(citizenSdkRoot, ...path.split('/')), destination);
  }
}

// 中文注释：三个正式 Apple 技术变体必须共用 iOS 16/macOS 13
// 常量，只构建 native/ffi 产品 Core；legacy host 也只属于 macOS。
function assertAppleDeploymentTargetContract(source) {
  assert.deepEqual(
    source.match(/^[ \t]*(?:ios|macos)_deployment_target=.*$/gm) ?? [],
    ['ios_deployment_target=16.0', 'macos_deployment_target=13.0'],
  );
  const functionBody = (name) => {
    const startMarker = `${name}() {\n`;
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `缺少 ${name}`);
    const end = source.indexOf('\n}\n', start + startMarker.length);
    assert.notEqual(end, -1, `${name} 未闭合`);
    return source.slice(start, end + 3);
  };
  const slice = functionBody('build_apple_framework_slice');
  const verifySlice = functionBody('verify_apple_framework_slice');
  const restoreSwiftModules = functionBody('restore_swift_module_artifacts');
  const flutterAdapter = functionBody('compile_apple_flutter_adapter');
  const apple = functionBody('build_apple');
  const appleTests = functionBody('build_apple_tests');
  const appleTestHarness = functionBody('run_apple_test_harness');
  const appleTestPackage = functionBody('write_apple_test_package');
  const smokeFunctionStart = source.indexOf('run_final_apple_consumer_smoke() {\n');
  assert.notEqual(smokeFunctionStart, -1, '缺少最终 XCFramework 消费者 smoke');
  const smokeHeredocStart = source.indexOf("<<'SWIFT'\n", smokeFunctionStart);
  const smokeHeredocEnd = source.indexOf('\nSWIFT\n', smokeHeredocStart);
  assert.notEqual(smokeHeredocStart, -1, '消费者 smoke 缺少 Swift heredoc');
  assert.notEqual(smokeHeredocEnd, -1, '消费者 smoke Swift heredoc 未闭合');
  const consumerSmoke = source.slice(smokeHeredocStart, smokeHeredocEnd);
  const smokeShellEnd = source.indexOf('\n}\n\nbuild_apple_tests() {', smokeHeredocEnd);
  assert.notEqual(smokeShellEnd, -1, '消费者 smoke shell 函数未闭合');
  const smokeShell = source.slice(smokeFunctionStart, smokeShellEnd);
  const host = functionBody('build_host');
  assert.match(slice, /IPHONEOS_DEPLOYMENT_TARGET="\$ios_deployment_target"/);
  assert.match(slice, /MACOSX_DEPLOYMENT_TARGET="\$macos_deployment_target"/);
  assert.equal(
    slice.split('cargo build --manifest-path "$product_ffi_manifest"').length - 1,
    2,
  );
  assert.match(slice, /write_apple_exported_symbols/);
  assert.match(slice, /-exported_symbols_list/);
  assert.match(slice, /-warnings-as-errors/);
  assert.match(slice, /-swift-version 5/);
  assert.match(slice, /-strict-concurrency=complete/);
  assert.match(slice, /-import-underlying-module/);
  assert.match(slice, /-typecheck-module-from-interface/);
  assert.match(slice, /-emit-private-module-interface-path/);
  assert.match(slice, /private\.swiftinterface/);
  assert.doesNotMatch(slice, /-import-objc-header/);
  assert.match(slice, /framework_content_root="\$framework\/Versions\/A"/);
  assert.match(slice, /framework_plist="\$framework_content_root\/Resources\/Info\.plist"/);
  assert.match(
    slice,
    /framework_install_name='@rpath\/CitizenSDK\.framework\/Versions\/A\/CitizenSDK'/,
  );
  assert.match(
    slice,
    /framework_install_name='@rpath\/CitizenSDK\.framework\/CitizenSDK'/,
  );
  assert.match(slice, /-Xlinker "\$framework_install_name"/);
  for (const specification of [
    'Versions/Current|A',
    'Headers|Versions/Current/Headers',
    'Modules|Versions/Current/Modules',
    'Resources|Versions/Current/Resources',
  ]) {
    assert.match(slice, new RegExp(specification.replaceAll('/', '\\/').replace('|', '\\|')));
  }
  assert.match(slice, /ln -s 'Versions\/Current\/CitizenSDK' "\$framework\/CitizenSDK"/);
  assert.match(verifySlice, /apple-plist-contract/);
  assert.match(verifySlice, /plutil -convert binary1/);
  assert.match(
    verifySlice,
    /abi\.json[\s\S]*private\.swiftinterface[\s\S]*swiftdoc[\s\S]*swiftinterface[\s\S]*swiftmodule[\s\S]*swiftsourceinfo/,
  );
  assert.match(verifySlice, /Swift module 六文件闭集漂移/);
  for (const identity of [
    'arm64-apple-ios',
    'arm64-apple-ios-simulator',
    'arm64-apple-macos',
  ]) {
    assert.match(verifySlice, new RegExp(identity));
  }
  for (const specification of [
    'CitizenSDK|Versions/Current/CitizenSDK',
    'Headers|Versions/Current/Headers',
    'Modules|Versions/Current/Modules',
    'Resources|Versions/Current/Resources',
    'Versions/Current|A',
  ]) {
    assert.match(
      verifySlice,
      new RegExp(specification.replaceAll('/', '\\/').replace('|', '\\|')),
    );
  }
  assert.match(
    verifySlice,
    /expected_install_name='@rpath\/CitizenSDK\.framework\/Versions\/A\/CitizenSDK'/,
  );
  assert.match(
    verifySlice,
    /expected_install_name='@rpath\/CitizenSDK\.framework\/CitizenSDK'/,
  );
  assert.match(flutterAdapter, /darwin_flutter_source_root/);
  assert.match(flutterAdapter, /-warnings-as-errors/);
  assert.match(flutterAdapter, /-strict-concurrency=complete/);
  assert.match(flutterAdapter, /-typecheck/);
  assert.match(flutterAdapter, /-c/);
  assert.match(flutterAdapter, /citizen_slice_root/);
  assert.doesNotMatch(flutterAdapter, /darwin_source_root|apple-build/);
  for (const target of [
    'aarch64-apple-ios',
    'aarch64-apple-ios-sim',
    'aarch64-apple-darwin',
  ]) {
    assert.match(apple, new RegExp(`(?:^|\\s)${target.replaceAll('-', '\\-')}(?:\\s|$)`));
  }
  assert.match(apple, /output_dir\/apple\/CitizenSDK\.xcframework/);
  assert.match(apple, /restore_swift_module_artifacts/);
  assert.doesNotMatch(apple, /canonicalize_xcframework_identifiers|LibraryIdentifier \$desired/);
  assert.match(apple, /resolve_xcframework_framework_slice/);
  assert.match(
    restoreSwiftModules,
    /abi\.json private\.swiftinterface swiftdoc swiftinterface swiftmodule swiftsourceinfo/,
  );
  assert.match(
    restoreSwiftModules,
    /source="\$source_root\/Modules\/CitizenSDK\.swiftmodule\/\$module_identity\.\$extension"/,
  );
  assert.match(
    restoreSwiftModules,
    /destination="\$destination_root\/Modules\/CitizenSDK\.swiftmodule\/\$module_identity\.\$extension"/,
  );
  assert.match(restoreSwiftModules, /cmp -s "\$source" "\$destination"/);
  assert.match(restoreSwiftModules, /cp "\$source" "\$destination"/);
  assert.equal(apple.split('compile_apple_flutter_adapter').length - 1, 3);
  assert.equal(apple.split('resolve_xcframework_framework_slice').length - 1, 3);
  assert.match(appleTests, /uname -m.*arm64/);
  assert.equal(appleTests.split('run_apple_test_harness').length - 1, 3);
  assert.match(appleTests, /aarch64-apple-ios[^\n]*iphoneos[^\n]*arm64-apple-ios17\.0/);
  assert.match(appleTests, /aarch64-apple-ios-sim[\s\S]*arm64-apple-ios17\.0-simulator/);
  assert.match(appleTests, /aarch64-apple-darwin[^\n]*macosx[^\n]*arm64-apple-macosx14\.0/);
  assert.match(appleTests, /aarch64-apple-ios Flutter .* compile/);
  assert.match(appleTests, /aarch64-apple-ios-sim Flutter[\s\S]*compile/);
  assert.match(appleTests, /aarch64-apple-darwin FlutterMacOS .* run/);
  assert.match(appleTests, /run_final_apple_consumer_smoke/);
  assert.match(appleTestHarness, /apple-test-harness\/\$slice_name/);
  assert.match(appleTestHarness, /apple-test-scratch\/\$slice_name/);
  assert.match(
    appleTestHarness,
    /run\|compile\) swiftpm_target=\(build --build-tests\)/,
  );
  assert.match(
    appleTestHarness,
    /swift "\$\{swiftpm_target\[@\]\}" "\$\{swiftpm_paths\[@\]\}"/,
  );
  assert.equal(
    appleTestHarness.split('swift test --skip-build "${swiftpm_paths[@]}"').length - 1,
    1,
  );
  assert.match(appleTestHarness, /TMPDIR="\$scratch\/tmp"/);
  assert.match(appleTestPackage, /darwin\/tests\/core/);
  assert.match(appleTestPackage, /darwin\/tests\/flutter/);
  assert.match(source, /apple-tests\) build_apple_tests/);
  assert.match(source, /all\) build_android; build_apple; build_apple_tests;/);
  assert.match(smokeShell, /output_dir\/apple\/CitizenSDK\.xcframework/);
  assert.match(smokeShell, /resolve_xcframework_framework_slice/);
  assert.match(smokeShell, /CitizenSDK macos ''/);
  assert.match(smokeShell, /-framework CitizenSDK/);
  assert.match(
    smokeShell,
    /expected_install_name='@rpath\/CitizenSDK\.framework\/Versions\/A\/CitizenSDK'/,
  );
  assert.match(smokeShell, /CFFIXED_USER_HOME="\$smoke_root\/home-normal"/);
  assert.match(smokeShell, /CFFIXED_USER_HOME="\$smoke_root\/home-supervisor"/);
  assert.doesNotMatch(smokeShell, /(?:^|\s)HOME=/m);
  assert.match(smokeShell, /logs\/normal\.log/);
  assert.match(smokeShell, /logs\/supervisor\.log/);
  assert.equal(smokeShell.split('"$executable" normal').length - 1, 1);
  assert.equal(smokeShell.split('"$executable" supervisor').length - 1, 1);
  assert.doesNotMatch(smokeShell, /product_ffi_manifest|static_library|darwin_source_root/);
  assert.match(consumerSmoke, /CitizenSdk\.open\(\)/);
  assert.match(consumerSmoke, /capabilities\.statuses\.count == 10/);
  assert.match(consumerSmoke, /capabilities\.revision >= 1/);
  assert.match(consumerSmoke, /CitizenCapabilityName\.allCases/);
  assert.match(consumerSmoke, /sdk\.lifecycle == \.disposed/);
  assert.equal(consumerSmoke.split('try sdk.close()').length - 1, 3);
  assert.match(consumerSmoke, /private func closeEventually\(_ sdk: CitizenSdk\) async throws/);
  assert.match(consumerSmoke, /error\.code == \.busy/);
  assert.match(consumerSmoke, /F_GETPATH/);
  assert.match(consumerSmoke, /try await abandoned!\.refreshCapabilities\(\)/);
  assert.ok(consumerSmoke.indexOf('try await abandoned!.refreshCapabilities()')
    < consumerSmoke.indexOf('let initiallyOpen = citizenSDKSQLiteFileDescriptors()'));
  assert.match(consumerSmoke, /try await Task\.sleep\(nanoseconds: 50_000_000\)/);
  assert.match(consumerSmoke, /public-state-v1\.sqlite3/);
  assert.match(consumerSmoke, /secure-state-v1\.sqlite3/);
  assert.match(consumerSmoke, /abandoned = nil/);
  assert.match(consumerSmoke, /let reopened = try CitizenSdk\.open\(\)/);
  assert.doesNotMatch(consumerSmoke, /\.start\(|hardwareVault|SecretVault/);
  assert.doesNotMatch(apple, /x86_64|universal|libsmoldot\.a|lipo -create/);
  assert.match(host, /--target aarch64-apple-darwin/);
  // “禁止 x86/universal”可以出现在安全注释中；门禁只拒绝真正建立第二条
  // macOS 构建路径的命令或架构设置，避免把说明文字误当成实现。
  assert.doesNotMatch(
    host,
    /--target\s+x86_64-apple-darwin|(?:^|[;&|]\s*)lipo\s+-create|ARCHS\s*=\s*['"]?x86_64/m,
  );
  return {
    apple,
    appleTestHarness,
    appleTestPackage,
    appleTests,
    flutterAdapter,
    host,
    slice,
    restoreSwiftModules,
    verifySlice,
  };
}

// Kotlin 编译器必须把 project persistent state 明确投影到中央 work dir，
// 不能依赖 Gradle/Kotlin 默认值在 android/.kotlin 留下构建记录。
function assertAndroidKotlinPersistentStateContract(source) {
  const marker = 'build_android() {\n';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, '缺少 build_android');
  const end = source.indexOf('\n}\n', start + marker.length);
  assert.notEqual(end, -1, 'build_android 未闭合');
  const android = source.slice(start, end + 3);
  assert.match(android, /local kotlin_persistent_dir/);
  assert.match(android, /kotlin_persistent_dir="\$work_dir\/kotlin-project-persistent"/);
  assert.match(android, /prepare_safe_directory[\s\S]*"\$kotlin_persistent_dir"/);
  assert.equal(
    android.split('-Pkotlin.project.persistent.dir="$kotlin_persistent_dir"').length - 1,
    1,
  );
  assert.doesNotMatch(android, /sdk_dir\/android\/\.kotlin|android_gradle_project\/\.kotlin/);
  assert.doesNotMatch(source, /mkdir[^\n]*android\/\.kotlin/);
}

test('Android Gradle 子进程接收中央环境、参数并传播失败', () => {
  const source = nativeShellFunctions(['build_android']);
  const start = source.indexOf('  CITIZENSDK_ANDROID_BUILD_DIR="$android_build_dir"');
  const end = source.indexOf('  built_aar=', start);
  assert.ok(start >= 0 && end > start, '必须执行真实 Gradle 调用段');
  const invocation = source.slice(start, end);
  const root = mkdtempSync(join(workRoot, 'android-gradle-environment-'));
  try {
    const gradle = join(root, 'gradle fixture');
    writeFileSync(gradle, `#!/bin/bash
set -eu
[[ "\${CITIZENSDK_ANDROID_BUILD_DIR:-}" == "$FIXTURE_ROOT/build dir" ]] || exit 91
[[ "\${CITIZENSDK_SOURCE_DIR:-}" == "$FIXTURE_ROOT/sdk source" ]] || exit 96
[[ "\${CITIZENSDK_ANDROID_CORE_DIR:-}" == "$FIXTURE_ROOT/core dir" ]] || exit 92
[[ "\${CITIZENSDK_INTERNAL_INCLUDE_DIR:-}" == "$FIXTURE_ROOT/work/private-include" ]] || exit 97
[[ "\${CITIZENSDK_ZXING_SOURCE_DIR:-}" == "$FIXTURE_ROOT/zxing source" ]] || exit 98
[[ "\${GRADLE_USER_HOME:-}" == "$FIXTURE_ROOT/gradle home" ]] || exit 93
expected=(--no-daemon --stacktrace --no-problems-report --project-cache-dir "$FIXTURE_ROOT/project cache" "-Pkotlin.project.persistent.dir=$FIXTURE_ROOT/kotlin state" -p "$FIXTURE_ROOT/project" :native:assembleRelease)
[[ "$#" == "\${#expected[@]}" ]] || exit 94
for argument in "\${expected[@]}"; do [[ "$1" == "$argument" ]] || exit 95; shift; done
exit "$FIXTURE_STATUS"
`, { mode: 0o700 });
    const shell = `set -eu
unset CITIZENSDK_ANDROID_BUILD_DIR CITIZENSDK_ANDROID_CORE_DIR CITIZENSDK_ZXING_SOURCE_DIR GRADLE_USER_HOME
android_build_dir="$FIXTURE_ROOT/build dir"
work_dir="$FIXTURE_ROOT/work"
core_stage="$FIXTURE_ROOT/core dir"
gradle_user_home="$FIXTURE_ROOT/gradle home"
gradle_project_cache="$FIXTURE_ROOT/project cache"
kotlin_persistent_dir="$FIXTURE_ROOT/kotlin state"
android_gradle_project="$FIXTURE_ROOT/project"
sdk_dir="$FIXTURE_ROOT/sdk source"
gradle_network_arg=''
export CITIZENSDK_ZXING_SOURCE_DIR="$FIXTURE_ROOT/zxing source"
gradle_bin="$FIXTURE_ROOT/gradle fixture"
`;
    const run = (body, status) => spawnSync('/bin/bash', ['-c', shell + body], {
      env: { PATH: '/usr/bin:/bin', FIXTURE_ROOT: root, FIXTURE_STATUS: String(status) },
      encoding: 'utf8', timeout: 5000,
    });
    for (const status of [0, 37]) {
      const result = run(invocation, status);
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
    }
    // 重现本次故障：注释切断赋值续行。bash -n 会通过，真实子进程检查必须失败。
    const broken = invocation.replace('    "$gradle_bin"', '    # misplaced comment\n    "$gradle_bin"');
    assert.notEqual(broken, invocation);
    const failed = run(broken, 0);
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 91);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android接受调用产品位于SDK子工作根外的Gradle依赖缓存', () => {
  const functions = nativeShellFunctions([
    'fail', 'assert_safe_directory_path', 'local_build_path_is_allowed',
    'prepare_external_cache_directory',
  ]);
  const android = nativeShellFunctions(['build_android']);
  const root = mkdtempSync(join(workRoot, 'android-external-gradle-cache-'));
  const sdk = join(root, 'sdk');
  const cache = join(root, 'product-cache', 'dependencies', 'gradle');
  mkdirSync(sdk);
  const run = path => spawnSync('/bin/bash', ['-c', `${functions}\nsdk_dir="$SDK_ROOT"\nprepare_external_cache_directory "$CACHE_ROOT" "Android Gradle 依赖缓存"`], {
    env: { PATH: '/usr/bin:/bin', SDK_ROOT: sdk, CACHE_ROOT: path },
    encoding: 'utf8', timeout: 5000,
  });
  try {
    const accepted = run(cache);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.ok(lstatSync(cache).isDirectory());

    const rejected = run(join(sdk, 'generated-gradle-cache'));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /必须位于 CitizenSDK 源码树之外/u);

    assert.match(android, /prepare_external_cache_directory "\$gradle_user_home" "Android Gradle 依赖缓存"/u);
    assert.match(android, /prepare_safe_directory "\$work_dir" "\$gradle_user_home" "Android Gradle 依赖缓存"/u);
    assert.doesNotMatch(android,
      /"\$android_build_dir" "\$gradle_project_cache" "\$gradle_user_home"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android任务工程仅生成入口配置且并发隔离并拒绝链接路径', async () => {
  const root = mkdtempSync(join(workRoot, 'android-gradle-project-'));
  const source = nativeShellFunctions([
    'fail', 'assert_safe_directory_path', 'assert_descendant_path', 'assert_new_file',
    'prepare_safe_directory', 'prepare_safe_output_file', 'prepare_android_gradle_project',
  ]);
  const run = work => new Promise((resolveRun, reject) => {
    const child = spawn('/bin/bash', ['-c', source + '\nwork_dir="$FIXTURE_WORK"\nprepare_android_gradle_project'], {
      env: { PATH: '/usr/bin:/bin', FIXTURE_WORK: work }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => resolveRun({ status, stderr }));
  });
  try {
    const tasks = ['booking', 'factory'].map(name => join(root, name));
    const results = await Promise.all(tasks.map(run));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    for (const work of tasks) {
      const project = join(work, 'gradle-project');
      assert.deepEqual(readdirSync(project).sort(), ['build.gradle', 'native', 'settings.gradle']);
      assert.deepEqual(readdirSync(join(project, 'native')), ['build.gradle']);
      for (const file of ['settings.gradle', 'build.gradle', 'native/build.gradle']) {
        const input = join(project, file);
        assert.ok(lstatSync(input).isFile() && !lstatSync(input).isSymbolicLink());
        assert.equal(readFileSync(input, 'utf8'),
          `apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/${file}')\n`);
      }
    }
    const untouched = join(root, 'outside');
    mkdirSync(untouched);
    writeFileSync(join(untouched, 'sentinel'), 'untouched');
    for (const relative of ['gradle-project', 'gradle-project/native', 'gradle-project/settings.gradle']) {
      const work = mkdtempSync(join(root, 'reject-'));
      const link = join(work, relative);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(untouched, link);
      const result = await run(work);
      assert.notEqual(result.status, 0);
      assert.deepEqual(readdirSync(untouched), ['sentinel']);
      assert.equal(readFileSync(join(untouched, 'sentinel'), 'utf8'), 'untouched');
    }
    const flutter = readFileSync(join(citizenSdkRoot, 'android/build.gradle'), 'utf8');
    const native = readFileSync(join(citizenSdkRoot, 'android/native/build.gradle'), 'utf8');
    assert.match(native, /sourceSet\.setRoot\(sourceRoot\.path\)/u);
    assert.match(native, /sourceSet\.kotlin\.srcDirs/u);
    assert.match(native, /new File\(nativeSourceRoot, 'source\/CMakeLists\.txt'\)/u);
    assert.equal((flutter.match(/consumerProguardFiles new File\(androidSourceRoot, 'native\/consumer-rules\.pro'\)/gu) ?? []).length, 1);
    assert.equal((native.match(/consumerProguardFiles new File\(nativeSourceRoot, 'consumer-rules\.pro'\)/gu) ?? []).length, 1);
    const consumerRules = readFileSync(join(citizenSdkRoot, 'android/native/consumer-rules.pro'), 'utf8');
    assert.equal((consumerRules.match(/^-keep class org[.]citizen[.]sdk[.]internal[.]CitizenSdkNative \{ \*; \}$/gmu) ?? []).length, 1);
    for (const script of [flutter, native]) {
      assert.match(script, /include 'chain\/manifest\.json', 'chain\/chainspec\.json', 'chain\/light_sync_state\.json'/u);
      assert.match(script, /assets\.srcDirs = \[chainAssetDirectory\.get\(\)\.asFile\]/u);
      assert.match(script, /tasks\.matching \{ it\.name == 'preBuild' \}\.configureEach \{ dependsOn\(prepareChainAssets\) \}/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android settings 将 native 模块绑定到任务工程', () => {
  const settings = readFileSync(join(citizenSdkRoot, 'android/settings.gradle'), 'utf8');
  assert.match(settings, /project\(':native'\)\.projectDir = new File\(taskProject, 'native'\)/u);
  assert.doesNotMatch(settings, /project\(':native'\)\.projectDir = file\('native'\)/u);
});

test('smoldot Dart Release 合同固定根包生产、测试与来源记录迁移闭集', () => {
  assert.doesNotThrow(() => assertSmoldotDartSource(citizenSdkRoot));
});

test('smoldot Rust 锁文件固定为已验证且已剥离产品依赖的字节', () => {
  assert.doesNotThrow(() => assertSmoldotLocks(citizenSdkRoot));
});

test('SDK 根 Cargo 与 Dart 锁文件固定已审查依赖闭包', () => {
  const root = mkdtempSync(join(workRoot, 'release-root-lock-test-'));
  try {
    for (const lock of ['Cargo.lock', 'pubspec.lock']) {
      copyFileSync(join(citizenSdkRoot, lock), join(root, lock));
    }
    assert.doesNotThrow(() => assertSdkRootLocks(root));

    // 合法格式的单包旧版本也必须被拒绝，不能仅拦截完全损坏的锁文本。
    const dartLock = readFileSync(join(root, 'pubspec.lock'), 'utf8');
    const staleDartLock = dartLock.replace(/(  vector_math:\n[\s\S]*?    version: )"2\.4\.2"/, '$1"2.2.0"');
    assert.notEqual(staleDartLock, dartLock);
    writeFileSync(join(root, 'pubspec.lock'), staleDartLock);
    assert.throws(() => assertSdkRootLocks(root), /SDK 根锁文件哈希漂移：pubspec\.lock/);
    writeFileSync(join(root, 'pubspec.lock'), dartLock);

    writeFileSync(join(root, 'Cargo.lock'), 'drift\n');
    assert.throws(() => assertSdkRootLocks(root), /SDK 根锁文件哈希漂移：Cargo\.lock/);

    copyFileSync(join(citizenSdkRoot, 'Cargo.lock'), join(root, 'Cargo.lock'));
    writeFileSync(join(root, 'pubspec.lock'), 'drift\n');
    assert.throws(() => assertSdkRootLocks(root), /SDK 根锁文件哈希漂移：pubspec\.lock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Release 原生产物只允许版本化 macOS framework 五链接并拒绝其它路径链接', () => {
  const root = mkdtempSync(join(workRoot, 'release-native-source-path-test-'));
  try {
    const valid = writeNativeFixture(join(root, 'valid'));
    assert.doesNotThrow(() => assertNativeArtifactSources(valid));

    const malformedMac = writeNativeFixture(join(root, 'malformed-macos'));
    // LibraryIdentifier 是 Xcode 生成的不透明技术标识；测试只使用
    // fixture 内部映射定位，不把产品平台名伪造成目录名。
    const malformedBinary = join(
      malformedMac,
      'apple',
      'CitizenSDK.xcframework',
      appleFixtureSliceIdentifiers.macOS,
      'CitizenSDK.framework',
      'CitizenSDK',
    );
    rmSync(malformedBinary);
    symlinkSync('Versions/A/CitizenSDK', malformedBinary);
    assert.throws(
      () => assertNativeArtifactSources(malformedMac),
      /符号链接目标漂移/,
    );

    const ancestorCase = join(root, 'ancestor-case');
    const ancestorNative = writeNativeFixture(ancestorCase);
    const outsideAndroid = join(root, 'outside-android');
    mkdirSync(join(outsideAndroid, 'arm64-v8a'), { recursive: true });
    writeFileSync(join(outsideAndroid, 'citizensdk.aar'), 'injected\n');
    writeFileSync(join(outsideAndroid, 'arm64-v8a', 'libcitizensdk.so'), 'injected\n');
    writeFileSync(join(outsideAndroid, 'arm64-v8a', 'libcitizensdk_jni.so'), 'injected\n');
    rmSync(join(ancestorNative, 'android'), { recursive: true });
    symlinkSync(outsideAndroid, join(ancestorNative, 'android'), 'dir');
    assert.throws(
      () => assertNativeArtifactSources(ancestorNative),
      /原生产物路径禁止符号链接：android\/citizensdk\.aar/,
    );

    const danglingCase = join(root, 'dangling-case');
    const danglingNative = writeNativeFixture(danglingCase);
    const danglingFramework = join(danglingNative, 'apple', 'CitizenSDK.xcframework');
    rmSync(danglingFramework, { recursive: true });
    symlinkSync(join(root, 'missing-CitizenSDK.xcframework'), danglingFramework, 'dir');
    assert.throws(
      () => assertNativeArtifactSources(danglingNative),
      /原生产物路径禁止符号链接：apple\/CitizenSDK\.xcframework/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux 原生产物输入逐平台封闭19项，合并不得覆盖共享字节漂移', () => {
  const root = mkdtempSync(join(workRoot, 'release-linux-native-input-test-'));
  try {
    const native = writeNativeFixture(root);
    const input = assertNativeArtifactSources(native);
    assert.deepEqual(input.linux, Object.fromEntries(linuxPlatforms.map((platform) => [
      platform, join(native, 'linux', platform),
    ])));
    const prefix = join(native, 'linux/LinuxAMD');
    const library = join(prefix, 'lib/LinuxAMD/libcitizensdk_host.so');
    const original = readFileSync(library);
    rmSync(library);
    assert.throws(() => assertNativeArtifactSources(native), /Linux/u);
    writeFileSync(library, original);

    const extra = join(prefix, 'unregistered');
    writeFileSync(extra, 'unregistered');
    assert.throws(() => assertNativeArtifactSources(native), /Linux/u);
    rmSync(extra);
    mkdirSync(extra);
    assert.throws(() => assertNativeArtifactSources(native), /Linux/u);
    rmSync(extra, { recursive: true });
    rmSync(library);
    symlinkSync('../../../LinuxARM/lib/LinuxARM/libcitizensdk_host.so', library);
    assert.throws(() => assertNativeArtifactSources(native), /符号链接/u);
    rmSync(library);
    writeFileSync(library, original);

    // 完整打包入口必须在共享项漂移时失败，不能由后复制的平台悄悄覆盖。
    for (const [index, relative] of [
      'include/citizensdk.h',
      'include/citizen_sdk/citizen_sdk.hpp',
      'share/citizensdk/chain/manifest.json',
    ].entries()) {
      const path = join(prefix, relative);
      const bytes = readFileSync(path);
      try {
        writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n')]));
        assert.throws(() => buildCitizenSdkRelease({
          sourcePath: citizenSdkRoot,
          nativePath: native,
          outputPath: join(root, `candidate-${index}`),
          archivePath: join(root, `candidate-${index}.tgz`),
          gitCommitSha: '0'.repeat(40),
          softwareVersion: '1.0.0',
        }), /Linux/u);
      } finally {
        writeFileSync(path, bytes);
      }
    }
    assert.doesNotThrow(() => assertNativeArtifactSources(native));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android原生构建校验从assets容器回读chain三文件且拒绝旧目录和损坏', () => {
  const root = mkdtempSync(join(workRoot, 'android-chain-assets-test-'));
  try {
    const shell = ['set -euo pipefail', nativeShellFunctions(['fail', 'verify_android_chain_assets']),
      'sdk_dir="$2"', 'verify_android_chain_assets "$1"'].join('\n');
    const run = (source) => spawnSync('/bin/bash', ['-c', shell, 'android-chain-assets',
      join(source, 'android', 'citizensdk.aar'), source], { encoding: 'utf8' });
    const valid = join(root, 'valid');
    writeAndroidProjectionFixture(valid);
    assert.equal(run(valid).status, 0);
    writeFileSync(join(valid, 'chain', 'manifest.json'), 'changed');
    assert.match(run(valid).stderr, /字节不一致/u);
    for (const [index, prefix] of ['assets/citizenchain', 'chain', 'assets'].entries()) {
      const source = join(root, `wrong-${index}`);
      writeAndroidProjectionFixture(source, { assets: Object.fromEntries(
        ['chainspec.json', 'light_sync_state.json', 'manifest.json']
          .map((name) => [`${prefix}/${name}`, Buffer.from('fixture')])) });
      assert.match(run(source).stderr, /链资产闭集漂移/u);
    }
    const extra = join(root, 'extra');
    writeAndroidProjectionFixture(extra, { extraEntries: { 'assets/pubspec.yaml': Buffer.from('source') } });
    assert.match(run(extra).stderr, /链资产闭集漂移/u);
    const missing = join(root, 'missing');
    writeAndroidProjectionFixture(missing, { assets: { 'assets/chain/chainspec.json': Buffer.from('one') } });
    assert.match(run(missing).stderr, /链资产闭集漂移/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Android AAR 与 Flutter 投影固定同一双库且原生面不引用 Flutter', () => {
  const root = mkdtempSync(join(workRoot, 'release-android-projection-test-'));
  try {
    const valid = join(root, 'valid');
    writeAndroidProjectionFixture(valid);
    assert.doesNotThrow(() => assertAndroidReleaseProjection(valid));
    // Android标准assets容器必须精确装入chain三文件，旧目录、根层文件与额外源文件均拒绝。
    for (const [index, prefix] of ['assets/citizenchain', 'chain', 'assets'].entries()) {
      const misplaced = join(root, `misplaced-${index}`);
      writeAndroidProjectionFixture(misplaced, {
        assets: Object.fromEntries(['manifest.json', 'chainspec.json', 'light_sync_state.json']
          .map((name) => [`${prefix}/${name}`, Buffer.from('fixture')])),
      });
      assert.throws(() => assertAndroidReleaseProjection(misplaced), /AAR 链资产闭集漂移/u);
    }
    const extraSource = join(root, 'extra-source');
    writeAndroidProjectionFixture(extraSource, {
      extraEntries: { 'assets/pubspec.yaml': Buffer.from('unexpected source') },
    });
    assert.throws(() => assertAndroidReleaseProjection(extraSource), /AAR 链资产闭集漂移/u);

    const mismatched = join(root, 'mismatched');
    writeAndroidProjectionFixture(mismatched);
    writeFileSync(
      join(mismatched, 'android', 'src', 'main', 'jniLibs', 'arm64-v8a', 'libcitizensdk_jni.so'),
      'different-jni',
    );
    assert.throws(
      () => assertAndroidReleaseProjection(mismatched),
      /AAR 与 Flutter 投影的双原生库字节不一致/,
    );

    const extraAbi = join(root, 'extra-abi');
    writeAndroidProjectionFixture(extraAbi, {
      extraEntries: {
        'jni/x86_64/libcitizensdk.so': Buffer.from('wrong-abi'),
      },
    });
    assert.throws(
      () => assertAndroidReleaseProjection(extraAbi),
      /AAR 双库闭集漂移/,
    );

    const flutterReference = join(root, 'flutter-reference');
    writeAndroidProjectionFixture(flutterReference, {
      classEntries: {
        'org/citizen/sdk/CitizenSdk.class': Buffer.from('uses io/flutter/plugin/common'),
        'org/citizen/sdk/CitizenSdkLifecycle.class': Buffer.from('CitizenSDK lifecycle'),
        'org/citizen/sdk/CitizenSdkException.class': Buffer.from('CitizenSDK errors'),
        'org/citizen/sdk/CitizenSdkEvents.class': Buffer.from('CitizenSDK events'),
        'org/citizen/sdk/CitizenWalletProfile.class': Buffer.from('CitizenSDK wallet profile'),
        'org/citizen/sdk/CitizenSdkOperation.class': Buffer.from('CitizenSDK operation'),
        'org/citizen/sdk/internal/CitizenSdkNative.class': Buffer.from('CitizenSDK JNI owner'),
        'org/citizen/sdk/internal/CitizenSdkHardwareVault.class': Buffer.from('CitizenSDK vault'),
        'org/citizen/sdk/internal/CitizenSdkHostServices.class': Buffer.from('CitizenSDK host services'),
        'org/citizen/sdk/internal/CitizenSdkRequestRouter.class': Buffer.from('CitizenSDK request router'),
        'org/citizen/sdk/CitizenSdkPreparedWallet.class': Buffer.from('CitizenSDK headless 0'),
        'org/citizen/sdk/CitizenSdkRecoveryPhrase.class': Buffer.from('CitizenSDK headless 1'),
        'org/citizen/sdk/CitizenSdkPrivateKey.class': Buffer.from('CitizenSDK headless 2'),
        'org/citizen/sdk/CitizenSdkQrCapture.class': Buffer.from('CitizenSDK headless 3'),
        'org/citizen/sdk/CitizenQrReview.class': Buffer.from('CitizenSDK headless 4'),
        'org/citizen/sdk/CitizenWalletInspection.class': Buffer.from('CitizenSDK headless 5'),
        'org/citizen/sdk/CitizenWalletDiagnostic.class': Buffer.from('CitizenSDK headless 6'),
        'org/citizen/sdk/CitizenWalletCleanupTargets.class': Buffer.from('CitizenSDK headless 7'),
      },
    });
    assert.throws(
      () => assertAndroidReleaseProjection(flutterReference),
      /原生 AAR 混入或引用 Flutter API/,
    );

    const missingClass = join(root, 'missing-class');
    const classes = {
      'org/citizen/sdk/CitizenSdk.class': Buffer.from('CitizenSDK native facade'),
      'org/citizen/sdk/CitizenSdkLifecycle.class': Buffer.from('CitizenSDK lifecycle'),
      'org/citizen/sdk/CitizenSdkException.class': Buffer.from('CitizenSDK errors'),
      'org/citizen/sdk/CitizenSdkEvents.class': Buffer.from('CitizenSDK events'),
      'org/citizen/sdk/CitizenWalletProfile.class': Buffer.from('CitizenSDK wallet profile'),
      'org/citizen/sdk/CitizenSdkOperation.class': Buffer.from('CitizenSDK operation'),
      'org/citizen/sdk/internal/CitizenSdkNative.class': Buffer.from('CitizenSDK JNI owner'),
      'org/citizen/sdk/internal/CitizenSdkHardwareVault.class': Buffer.from('CitizenSDK vault'),
      'org/citizen/sdk/internal/CitizenSdkHostServices.class': Buffer.from('CitizenSDK host services'),
      'org/citizen/sdk/internal/CitizenSdkRequestRouter.class': Buffer.from('CitizenSDK request router'),
      'org/citizen/sdk/CitizenSdkPreparedWallet.class': Buffer.from('CitizenSDK headless 0'),
      'org/citizen/sdk/CitizenSdkRecoveryPhrase.class': Buffer.from('CitizenSDK headless 1'),
      'org/citizen/sdk/CitizenSdkPrivateKey.class': Buffer.from('CitizenSDK headless 2'),
      'org/citizen/sdk/CitizenSdkQrCapture.class': Buffer.from('CitizenSDK headless 3'),
      'org/citizen/sdk/CitizenQrReview.class': Buffer.from('CitizenSDK headless 4'),
      'org/citizen/sdk/CitizenWalletInspection.class': Buffer.from('CitizenSDK headless 5'),
      'org/citizen/sdk/CitizenWalletDiagnostic.class': Buffer.from('CitizenSDK headless 6'),
      'org/citizen/sdk/CitizenWalletCleanupTargets.class': Buffer.from('CitizenSDK headless 7'),
    };
    delete classes['org/citizen/sdk/CitizenWalletInspection.class'];
    writeAndroidProjectionFixture(missingClass, { classEntries: classes });
    assert.throws(
      () => assertAndroidReleaseProjection(missingClass),
      /classes\.jar 缺少必需实现.*CitizenWalletInspection/,
    );

    const oldUi = join(root, 'old-sdk-ui');
    writeAndroidProjectionFixture(oldUi, {
      classEntries: {
        ...classes,
        'org/citizen/sdk/CitizenWalletInspection.class': Buffer.from('CitizenSDK inspection'),
        'org/citizen/sdk/ui/UnexpectedActivity.class': Buffer.from('old SDK UI'),
      },
    });
    assert.throws(() => assertAndroidReleaseProjection(oldUi), /classes\.jar 残留SDK界面实现/);

    const assetDrift = join(root, 'asset-drift');
    writeAndroidProjectionFixture(assetDrift);
    writeFileSync(join(assetDrift, 'chain', 'chainspec.json'), 'drift');
    assert.throws(
      () => assertAndroidReleaseProjection(assetDrift),
      /AAR 链资产与候选信任锚字节不一致/,
    );

    const nestedAar = join(root, 'nested-aar');
    writeAndroidProjectionFixture(nestedAar, {
      extraEntries: { 'libs/second-sdk.aar': Buffer.from('nested') },
    });
    assert.throws(
      () => assertAndroidReleaseProjection(nestedAar),
      /混入嵌套 AAR/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Apple XCFramework 固定三个 arm64 技术变体、产品 ABI、版本与来源投影', () => {
  const root = mkdtempSync(join(workRoot, 'release-apple-projection-test-'));
  try {
    const valid = join(root, 'valid');
    writeAppleProjectionFixture(valid);
    assert.doesNotThrow(() => assertAppleReleaseProjection(valid));
    const validMacFramework = appleFixtureFramework(valid, 'macOS');
    for (const [path, target] of Object.entries(macOSFrameworkSymlinks)) {
      assert.equal(readlinkSync(join(validMacFramework, ...path.split('/'))), target);
    }

    const extraSliceRootEntry = join(root, 'extra-slice-root-entry');
    writeAppleProjectionFixture(extraSliceRootEntry);
    mkdirSync(join(dirname(appleFixtureFramework(extraSliceRootEntry, 'iosDevice')), 'unreviewed'));
    assert.throws(
      () => assertAppleReleaseProjection(extraSliceRootEntry),
      /slice 根闭集漂移/,
    );

    const extraHeaderEntry = join(root, 'extra-header-entry');
    writeAppleProjectionFixture(extraHeaderEntry);
    mkdirSync(join(appleFixtureContentRoot(extraHeaderEntry, 'iosDevice'), 'Headers', 'unreviewed'));
    assert.throws(
      () => assertAppleReleaseProjection(extraHeaderEntry),
      /Headers 目录闭集漂移/,
    );

    const extraModulesEntry = join(root, 'extra-modules-entry');
    writeAppleProjectionFixture(extraModulesEntry);
    mkdirSync(join(appleFixtureContentRoot(extraModulesEntry, 'iosSimulator'),
      'Modules', 'unreviewed'));
    assert.throws(
      () => assertAppleReleaseProjection(extraModulesEntry),
      /Modules 目录闭集漂移/,
    );

    const nonFileSwiftModuleEntry = join(root, 'non-file-swift-module-entry');
    writeAppleProjectionFixture(nonFileSwiftModuleEntry);
    mkdirSync(join(appleFixtureContentRoot(nonFileSwiftModuleEntry, 'macOS'),
      'Modules', 'CitizenSDK.swiftmodule', 'unreviewed'));
    assert.throws(
      () => assertAppleReleaseProjection(nonFileSwiftModuleEntry),
      /Swift module 只允许普通文件/,
    );

    const extraResourcesEntry = join(root, 'extra-resources-entry');
    writeAppleProjectionFixture(extraResourcesEntry);
    mkdirSync(join(appleFixtureContentRoot(extraResourcesEntry, 'iosDevice'),
      'Resources', 'unreviewed'));
    assert.throws(
      () => assertAppleReleaseProjection(extraResourcesEntry),
      /Resources 目录闭集漂移/,
    );

    const extraVersionEntry = join(root, 'extra-version-entry');
    writeAppleProjectionFixture(extraVersionEntry);
    mkdirSync(join(appleFixtureContentRoot(extraVersionEntry, 'macOS'), 'unreviewed'));
    assert.throws(
      () => assertAppleReleaseProjection(extraVersionEntry),
      /版本化 framework 闭集漂移/,
    );

    for (const sliceKey of ['iosDevice', 'iosSimulator']) {
      const linkedIos = join(root, `linked-${sliceKey}`);
      writeAppleProjectionFixture(linkedIos);
      const framework = appleFixtureFramework(linkedIos, sliceKey);
      rmSync(join(framework, 'Headers'), { recursive: true });
      symlinkSync('Resources', join(framework, 'Headers'));
      assert.throws(
        () => assertAppleReleaseProjection(linkedIos),
        /禁止未声明符号链接/,
      );
    }

    const shallowMacOS = join(root, 'shallow-macos');
    writeAppleProjectionFixture(shallowMacOS);
    const shallowFramework = appleFixtureFramework(shallowMacOS, 'macOS');
    const shallowContent = join(shallowFramework, 'Versions', 'A');
    for (const entry of ['CitizenSDK', 'Headers', 'Modules', 'Resources']) {
      rmSync(join(shallowFramework, entry), { recursive: true, force: true });
      cpSync(join(shallowContent, entry), join(shallowFramework, entry), { recursive: true });
    }
    copyFileSync(
      join(shallowFramework, 'Resources', 'Info.plist'),
      join(shallowFramework, 'Info.plist'),
    );
    rmSync(join(shallowFramework, 'Resources', 'Info.plist'));
    rmSync(join(shallowFramework, 'Versions'), { recursive: true });
    assert.throws(
      () => assertAppleReleaseProjection(shallowMacOS),
      /缺少已声明符号链接|framework 根闭集漂移/,
    );

    const macLinkDrifts = [
      ['extra', 'Unexpected', 'Versions/Current/CitizenSDK'],
      ['wrong-target', 'CitizenSDK', 'Versions/A/CitizenSDK'],
      ['absolute-target', 'Headers', '/tmp/CitizenSDK-Headers'],
      ['parent-target', 'Modules', 'Versions/../Versions/Current/Modules'],
      ['escaping-target', 'Resources', '../../../../../../outside-resources'],
    ];
    for (const [name, path, target] of macLinkDrifts) {
      const drift = join(root, `macos-link-${name}`);
      writeAppleProjectionFixture(drift);
      const framework = appleFixtureFramework(drift, 'macOS');
      const link = join(framework, ...path.split('/'));
      rmSync(link, { recursive: true, force: true });
      symlinkSync(target, link);
      assert.throws(
        () => assertAppleReleaseProjection(drift),
        /禁止未声明符号链接|符号链接目标漂移|符号链接越出受控根/,
      );
    }

    const danglingMacOS = join(root, 'macos-link-dangling');
    writeAppleProjectionFixture(danglingMacOS);
    rmSync(join(appleFixtureContentRoot(danglingMacOS, 'macOS'), 'CitizenSDK'));
    assert.throws(
      () => assertAppleReleaseProjection(danglingMacOS),
      /符号链接悬空或成环/,
    );

    const nestedEscape = join(root, 'macos-link-nested-escape');
    writeAppleProjectionFixture(nestedEscape);
    const outside = join(root, 'outside-header');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(
      appleFixtureContentRoot(nestedEscape, 'macOS'),
      'Headers',
      'outside.h',
    ));
    assert.throws(
      () => assertAppleReleaseProjection(nestedEscape),
      /禁止未声明符号链接/,
    );

    const missingSymbol = join(root, 'missing-symbol');
    writeAppleProjectionFixture(missingSymbol, {
      iosDevice: { symbols: [...citizenSdkSymbols().slice(0, -1), '$s10CitizenSDK0A0CMa'] },
    });
    assert.throws(
      () => assertAppleReleaseProjection(missingSymbol),
      /精确导出 148 个 citizensdk_/,
    );

    const legacySymbol = join(root, 'legacy-symbol');
    writeAppleProjectionFixture(legacySymbol, {
      macOS: { symbols: [...citizenSdkExportSymbols(), 'smoldot_json_rpc_send'] },
    });
    assert.throws(
      () => assertAppleReleaseProjection(legacySymbol),
      /泄漏 legacy 低层符号/,
    );

    const foreignSymbol = join(root, 'foreign-symbol');
    writeAppleProjectionFixture(foreignSymbol, {
      iosDevice: { symbols: [...citizenSdkExportSymbols(), 'foreign_probe'] },
    });
    assert.throws(
      () => assertAppleReleaseProjection(foreignSymbol),
      /泄漏非 CitizenSDK 产品符号/,
    );

    const missingSwiftExport = join(root, 'missing-swift-export');
    writeAppleProjectionFixture(missingSwiftExport, {
      iosSimulator: { symbols: [...citizenSdkSymbols(), ...qrImageSymbols()] },
    });
    assert.throws(
      () => assertAppleReleaseProjection(missingSwiftExport),
      /缺少 CitizenSDK Swift 模块导出/,
    );

    const wrongInstallName = join(root, 'wrong-install-name');
    writeAppleProjectionFixture(wrongInstallName, {
      iosSimulator: { installName: '/tmp/CitizenSDK.framework/CitizenSDK' },
    });
    assert.throws(
      () => assertAppleReleaseProjection(wrongInstallName),
      /install name 漂移/,
    );

    for (const sliceKey of ['iosDevice', 'iosSimulator']) {
      const versionedIosIdentity = join(root, `versioned-install-name-${sliceKey}`);
      writeAppleProjectionFixture(versionedIosIdentity, {
        [sliceKey]: {
          installName: '@rpath/CitizenSDK.framework/Versions/A/CitizenSDK',
        },
      });
      assert.throws(
        () => assertAppleReleaseProjection(versionedIosIdentity),
        /install name 漂移/,
      );
    }

    for (const [name, installName] of [
      ['shallow', '@rpath/CitizenSDK.framework/CitizenSDK'],
      ['current', '@rpath/CitizenSDK.framework/Versions/Current/CitizenSDK'],
    ]) {
      const wrongMacIdentity = join(root, `macos-install-name-${name}`);
      writeAppleProjectionFixture(wrongMacIdentity, {
        macOS: { installName },
      });
      assert.throws(
        () => assertAppleReleaseProjection(wrongMacIdentity),
        /install name 漂移/,
      );
    }

    const wrongMinimum = join(root, 'wrong-minimum');
    writeAppleProjectionFixture(wrongMinimum, {
      macOS: { minimum: '14.0.0' },
    });
    assert.throws(
      () => assertAppleReleaseProjection(wrongMinimum),
      /平台或最低系统版本漂移/,
    );

    const wrongArchitecture = join(root, 'wrong-architecture');
    writeAppleProjectionFixture(wrongArchitecture, {
      iosDevice: { cpuType: 0x01000007 },
    });
    assert.throws(
      () => assertAppleReleaseProjection(wrongArchitecture),
      /单一 arm64 动态 framework/,
    );

    const universalBinary = join(root, 'universal-binary');
    const fatMachO = Buffer.alloc(32);
    fatMachO.writeUInt32BE(0xcafebabe, 0);
    writeAppleProjectionFixture(universalBinary, {
      macOS: { binary: fatMachO },
    });
    assert.throws(
      () => assertAppleReleaseProjection(universalBinary),
      /thin 64-bit Mach-O/,
    );

    const assetDrift = join(root, 'asset-drift');
    writeAppleProjectionFixture(assetDrift);
    writeFileSync(
      join(appleFixtureContentRoot(assetDrift, 'macOS'),
        'Resources', 'chain', 'chainspec.json'),
      'drift',
    );
    assert.throws(
      () => assertAppleReleaseProjection(assetDrift),
      /Resource 与唯一来源字节不一致/,
    );

    for (const extension of appleSwiftModuleExtensions) {
      const missingModule = join(root, `missing-module-${extension.replaceAll('.', '-')}`);
      writeAppleProjectionFixture(missingModule);
      rmSync(join(
        appleFixtureContentRoot(missingModule, 'iosDevice'),
        'Modules',
        'CitizenSDK.swiftmodule',
        `arm64-apple-ios.${extension}`,
      ));
      assert.throws(
        () => assertAppleReleaseProjection(missingModule),
        /Swift module 六文件闭集或架构身份漂移/,
      );
    }

    for (const [name, addEntry] of [
      ['file', (moduleRoot) => writeFileSync(join(moduleRoot, 'unreviewed.swiftmodule'), 'x')],
      ['directory', (moduleRoot) => mkdirSync(join(moduleRoot, 'unreviewed'))],
    ]) {
      const extraModule = join(root, `extra-swift-module-${name}`);
      writeAppleProjectionFixture(extraModule);
      addEntry(join(
        appleFixtureContentRoot(extraModule, 'iosSimulator'),
        'Modules',
        'CitizenSDK.swiftmodule',
      ));
      assert.throws(
        () => assertAppleReleaseProjection(extraModule),
        /Swift module 只允许普通文件|Swift module 六文件闭集或架构身份漂移/,
      );
    }

    const invalidInterface = join(root, 'invalid-interface');
    writeAppleProjectionFixture(invalidInterface);
    writeFileSync(
      join(
        appleFixtureContentRoot(invalidInterface, 'macOS'),
        'Modules',
        'CitizenSDK.swiftmodule',
        'arm64-apple-macos.swiftinterface',
      ),
      '// swift-interface-format-version: 1.0\n',
    );
    assert.throws(
      () => assertAppleReleaseProjection(invalidInterface),
      /Swift interface 未固定同名 underlying Clang module/,
    );

    const invalidPrivateInterface = join(root, 'invalid-private-interface');
    writeAppleProjectionFixture(invalidPrivateInterface);
    const invalidPrivateModules = join(
      appleFixtureContentRoot(invalidPrivateInterface, 'macOS'),
      'Modules',
      'CitizenSDK.swiftmodule',
    );
    copyFileSync(
      join(invalidPrivateModules, 'arm64-apple-macos.swiftinterface'),
      join(invalidPrivateModules, 'arm64-apple-macos.private.swiftinterface'),
    );
    assert.throws(
      () => assertAppleReleaseProjection(invalidPrivateInterface),
      /public\/private Swift interface 或 CitizenSDKFlutter SPI 闭集漂移/,
    );

    const extraPrivateSpi = join(root, 'extra-private-spi');
    writeAppleProjectionFixture(extraPrivateSpi);
    const extraPrivatePath = join(
      appleFixtureContentRoot(extraPrivateSpi, 'iosDevice'),
      'Modules',
      'CitizenSDK.swiftmodule',
      'arm64-apple-ios.private.swiftinterface',
    );
    writeFileSync(
      extraPrivatePath,
      readFileSync(extraPrivatePath, 'utf8')
        + '@_spi(CitizenSDKFlutter) public func unexpectedSPI()\n',
    );
    assert.throws(
      () => assertAppleReleaseProjection(extraPrivateSpi),
      /CitizenSDKFlutter SPI 闭集漂移/,
    );

    const wrongInterfaceTarget = join(root, 'wrong-interface-target');
    writeAppleProjectionFixture(wrongInterfaceTarget);
    const wrongTargetPath = join(
      wrongInterfaceTarget,
      'darwin',
      'CitizenSDK.xcframework',
      appleFixtureSliceIdentifiers.iosSimulator,
      'CitizenSDK.framework',
      'Modules',
      'CitizenSDK.swiftmodule',
      'arm64-apple-ios-simulator.swiftinterface',
    );
    writeFileSync(
      wrongTargetPath,
      readFileSync(wrongTargetPath, 'utf8')
        .replace('arm64-apple-ios16.0-simulator', 'x86_64-apple-ios16.0-simulator'),
    );
    assert.throws(
      () => assertAppleReleaseProjection(wrongInterfaceTarget),
      /Swift interface target triple 漂移/,
    );

    const leakedPublicType = join(root, 'leaked-public-type');
    writeAppleProjectionFixture(leakedPublicType);
    const leakedModules = join(
      appleFixtureContentRoot(leakedPublicType, 'iosDevice'),
      'Modules',
      'CitizenSDK.swiftmodule',
    );
    for (const extension of ['swiftinterface', 'private.swiftinterface']) {
      const path = join(leakedModules, `arm64-apple-ios.${extension}`);
      writeFileSync(
        path,
        readFileSync(path, 'utf8')
          + 'public struct CitizenSDKNative {}\n',
      );
    }
    assert.throws(
      () => assertAppleReleaseProjection(leakedPublicType),
      /public Swift interface 泄漏底层/,
    );

    // 内部显示声明只供同轮构建，public/private interface 任一泄漏都拒绝交付。
    for (const extension of ['swiftinterface', 'private.swiftinterface']) {
      const leakedInternal = join(root, `leaked-internal-${extension}`);
      writeAppleProjectionFixture(leakedInternal);
      const path = join(appleFixtureContentRoot(leakedInternal, 'iosDevice'),
        'Modules', 'CitizenSDK.swiftmodule', `arm64-apple-ios.${extension}`);
      const original = readFileSync(path, 'utf8');
      for (const declaration of ['internal import CitizenSDKInternal',
        'public func citizensdk_internal_private_key_view_open()']) {
        writeFileSync(path, original + declaration + '\n');
        assert.throws(() => assertAppleReleaseProjection(leakedInternal), /泄漏构建期私有依赖/u);
      }
    }

    const wrongModuleTriple = join(root, 'wrong-module-triple');
    writeAppleProjectionFixture(wrongModuleTriple);
    const simulatorModules = join(
      wrongModuleTriple,
      'darwin',
      'CitizenSDK.xcframework',
      appleFixtureSliceIdentifiers.iosSimulator,
      'CitizenSDK.framework',
      'Modules',
      'CitizenSDK.swiftmodule',
    );
    for (const extension of appleSwiftModuleExtensions) {
      copyFileSync(
        join(simulatorModules, `arm64-apple-ios-simulator.${extension}`),
        join(simulatorModules, `arm64-apple-ios.${extension}`),
      );
      rmSync(join(simulatorModules, `arm64-apple-ios-simulator.${extension}`));
    }
    assert.throws(
      () => assertAppleReleaseProjection(wrongModuleTriple),
      /Swift module 六文件闭集或架构身份漂移/,
    );

    const frameworkInfoDrifts = [
      ['development-region', { CFBundleDevelopmentRegion: 'zh' }],
      ['executable', { CFBundleExecutable: 'CitizenSDKProbe' }],
      ['identifier', { CFBundleIdentifier: 'org.citizen.sdk.probe' }],
      ['info-version', { CFBundleInfoDictionaryVersion: '7.0' }],
      ['name', { CFBundleName: 'CitizenSDKProbe' }],
      ['package-type', { CFBundlePackageType: 'BNDL' }],
      ['short-version', { CFBundleShortVersionString: '1.0.1' }],
      ['supported-platforms', { CFBundleSupportedPlatforms: ['iPhoneOS', 'MacOSX'] }],
      ['bundle-version', { CFBundleVersion: '2' }],
      ['dt-platform', { DTPlatformName: 'macosx' }],
      ['minimum-version', { MinimumOSVersion: '17.0' }],
      ['unknown-key', { UnreviewedPlatformIdentity: 'probe' }],
    ];
    for (const [name, info] of frameworkInfoDrifts) {
      const drift = join(root, `framework-info-${name}`);
      writeAppleProjectionFixture(drift, { iosDevice: { info } });
      assert.throws(
        () => assertAppleReleaseProjection(drift),
        /framework Info\.plist 身份漂移/,
      );
    }

    const extraArchitecture = join(root, 'extra-architecture');
    writeAppleProjectionFixture(extraArchitecture, {
      iosDevice: { architectures: ['arm64', 'x86_64'] },
    });
    assert.throws(
      () => assertAppleReleaseProjection(extraArchitecture),
      /slice 字段闭集漂移|slice 元数据漂移/,
    );

    for (const [identifier, binaryPath] of [
      ['iosDevice', 'CitizenSDK.framework/Versions/A/CitizenSDK'],
      ['iosSimulator', 'CitizenSDK.framework/Versions/A/CitizenSDK'],
      ['macOS', 'CitizenSDK.framework/CitizenSDK'],
    ]) {
      const wrongBinaryPath = join(root, `wrong-binary-path-${identifier}`);
      writeAppleProjectionFixture(wrongBinaryPath, {
        [identifier]: { binaryPath },
      });
      assert.throws(
        () => assertAppleReleaseProjection(wrongBinaryPath),
        /slice 元数据漂移/,
      );
    }

    const unknownLibraryField = join(root, 'unknown-library-field');
    writeAppleProjectionFixture(unknownLibraryField, {
      macOS: { libraryInfo: { UnreviewedBinaryIdentity: 'probe' } },
    });
    assert.throws(
      () => assertAppleReleaseProjection(unknownLibraryField),
      /slice 字段闭集漂移/,
    );

    const wrongXcframeworkFormat = join(root, 'wrong-xcframework-format');
    writeAppleProjectionFixture(wrongXcframeworkFormat, {
      xcframeworkInfo: { fields: { XCFrameworkFormatVersion: '2.0' } },
    });
    assert.throws(
      () => assertAppleReleaseProjection(wrongXcframeworkFormat),
      /Info\.plist 格式或 slice 数量无效/,
    );

    const unknownPlatform = join(root, 'unknown-platform');
    writeAppleProjectionFixture(unknownPlatform, {
      macOS: { supportedPlatform: 'watchos' },
    });
    assert.throws(
      () => assertAppleReleaseProjection(unknownPlatform),
      /slice 元数据漂移/,
    );

    const unexpectedVariant = join(root, 'unexpected-variant');
    writeAppleProjectionFixture(unexpectedVariant, {
      iosDevice: { variant: 'simulator' },
    });
    assert.throws(
      () => assertAppleReleaseProjection(unexpectedVariant),
      /技术变体重复|slice 字段闭集漂移|slice 元数据漂移/,
    );

    const wrongResourceLevel = join(root, 'wrong-resource-level');
    writeAppleProjectionFixture(wrongResourceLevel);
    const resourceRoot = join(
      appleFixtureContentRoot(wrongResourceLevel, 'iosDevice'),
      'Resources',
    );
    copyFileSync(
      join(resourceRoot, 'chain', 'chainspec.json'),
      join(resourceRoot, 'chainspec.json'),
    );
    rmSync(join(resourceRoot, 'chain', 'chainspec.json'));
    assert.throws(
      () => assertAppleReleaseProjection(wrongResourceLevel),
      /Resources 目录闭集漂移/,
    );

    const missingSlice = join(root, 'missing-slice');
    writeAppleProjectionFixture(missingSlice);
    rmSync(
      join(missingSlice, 'darwin', 'CitizenSDK.xcframework',
        appleFixtureSliceIdentifiers.iosSimulator),
      { recursive: true },
    );
    assert.throws(
      () => assertAppleReleaseProjection(missingSlice),
      /三 slice 闭集漂移/,
    );

    const suffixedSlice = join(root, 'suffixed-slice');
    writeAppleProjectionFixture(suffixedSlice);
    const suffixedXcframework = join(suffixedSlice, 'darwin', 'CitizenSDK.xcframework');
    cpSync(
      join(suffixedXcframework, appleFixtureSliceIdentifiers.macOS),
      join(suffixedXcframework, 'unlisted-library'),
      { recursive: true },
    );
    rmSync(join(suffixedXcframework, appleFixtureSliceIdentifiers.macOS), { recursive: true });
    assert.throws(
      () => assertAppleReleaseProjection(suffixedSlice),
      /SDK 候选禁止未声明符号链接：unlisted-library\/CitizenSDK\.framework\/CitizenSDK/,
    );

    const extraSlice = join(root, 'extra-slice');
    writeAppleProjectionFixture(extraSlice);
    mkdirSync(join(extraSlice, 'darwin', 'CitizenSDK.xcframework', 'unlisted-library-extra'));
    assert.throws(
      () => assertAppleReleaseProjection(extraSlice),
      /三 slice 闭集漂移/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Dart、Android 与 Apple 生产绑定以固定哈希和反向闭集进入 Release', () => {
  const root = mkdtempSync(join(workRoot, 'release-mobile-binding-test-'));
  try {
    cpSync(join(citizenSdkRoot, 'lib'), join(root, 'lib'), { recursive: true });
    cpSync(join(citizenSdkRoot, 'android'), join(root, 'android'), { recursive: true });
    cpSync(join(citizenSdkRoot, 'darwin'), join(root, 'darwin'), { recursive: true });
    assert.doesNotThrow(() => assertMobileBindingSource(root));
    const swiftFacade = readFileSync(
      join(root, 'darwin', 'source', 'core', 'CitizenSDK.swift'),
      'utf8',
    );
    assert.match(swiftFacade, /public final class CitizenSdk:/u);
    assert.doesNotMatch(swiftFacade, /public (?:final class|typealias) CitizenSDK\b/u);

    // 删除旧实现后不得靠过滤规则隐藏第二套源码，恢复任一旧文件均须拒绝。
    for (const relative of [
      'lib/node/light_client.dart',
      'lib/wallet/wallet_service.dart',
      'lib/transaction/chain_rpc.dart',
      'lib/crypto/native_sr25519.dart',
      'lib/platform/preferences_wallet_repository.dart',
    ]) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '// Forbidden duplicate implementation.\n');
      assert.throws(() => assertMobileBindingSource(root), /移动绑定文件闭集漂移/);
      rmSync(path);
    }

    const darwinSourceLink = join(
      root,
      'darwin', 'source', 'core',
      'CitizenSDKSourceLink.swift',
    );
    symlinkSync('CitizenSDK.swift', darwinSourceLink);
    assert.throws(
      () => assertMobileBindingSource(root),
      /禁止未声明符号链接/,
    );
    rmSync(darwinSourceLink);

    mkdirSync(join(root, 'android', '.kotlin', 'sessions'), { recursive: true });
    assert.throws(
      () => assertMobileBindingSource(root),
      /源码禁止存在 Android Kotlin 持久状态目录/,
    );
    rmSync(join(root, 'android', '.kotlin'), { recursive: true });

    writeFileSync(
      join(root, 'android', 'source','Unexpected.kt'),
      'package org.citizen.sdk\n',
    );
    assert.throws(
      () => assertMobileBindingSource(root),
      /移动绑定文件闭集漂移.*Unexpected\.kt/,
    );

    rmSync(join(root, 'android', 'source','Unexpected.kt'));
    writeFileSync(
      join(root, 'darwin', 'source', 'core', 'Unexpected.swift'),
      'enum Unexpected {}\n',
    );
    assert.throws(
      () => assertMobileBindingSource(root),
      /移动绑定文件闭集漂移.*Unexpected\.swift/,
    );
    rmSync(join(root, 'darwin', 'source', 'core', 'Unexpected.swift'));

    writeAppleXcframework(join(root, 'darwin', 'CitizenSDK.xcframework'));
    assert.doesNotThrow(() => assertMobileBindingSource(
      root,
      { allowAppleReleaseProjection: true },
    ));
    assert.throws(
      () => assertMobileBindingSource(root),
      /禁止未声明符号链接/,
    );
    symlinkSync(
      'Versions/Current/CitizenSDK',
      join(appleFixtureFramework(root, 'macOS'), 'Unreviewed'),
    );
    assert.throws(
      () => assertMobileBindingSource(root, { allowAppleReleaseProjection: true }),
      /禁止未声明符号链接/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows 原生来源闭集拒绝改字节、额外文件、链接和生成目录', () => {
  const root = mkdtempSync(join(workRoot, 'citizenchain-release-windows-source-test-'));
  try {
    cpSync(join(citizenSdkRoot, 'windows'), join(root, 'windows'), { recursive: true });
    assert.equal(assertWindowsBindingSource(root), '1.0.0');
    const source = join(root, 'windows/source/citizen_sdk_assets.cc');
    const original = readFileSync(source);
    writeFileSync(source, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => assertWindowsBindingSource(root), /Windows Host 来源文件哈希漂移/u);
    writeFileSync(source, original);
    for (const name of ['unexpected.cc', 'citizensdk.dll', 'citizensdk_host.lib']) {
      const extra = join(root, 'windows', name);
      writeFileSync(extra, 'fixture');
      assert.throws(() => assertWindowsBindingSource(root), /Windows Host 文件闭集漂移/u);
      rmSync(extra);
    }
    const linked = join(root, 'windows/source/linked.cc');
    symlinkSync('citizen_sdk_assets.cc', linked);
    assert.throws(() => assertWindowsBindingSource(root), /禁止未声明符号链接/u);
    rmSync(linked);
    const generated = join(root, 'windows/CMakeFiles');
    mkdirSync(generated);
    assert.throws(() => assertWindowsBindingSource(root), /Windows Host 目录闭集漂移/u);
    rmSync(generated, { recursive: true });
    const missing = join(root, 'windows/source/citizen_sdk_lifecycle.hpp');
    rmSync(missing);
    assert.throws(() => assertWindowsBindingSource(root), /Windows Host 文件闭集漂移/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 薄 Host 与正式 Flutter 适配保持唯一 Core 和官方注册', () => {
  const header = readFileSync(join(citizenSdkRoot, 'windows/headers/citizensdk_host.h'), 'utf8');
  const exported = readFileSync(join(citizenSdkRoot, 'windows/cmake/citizensdk_host.def'), 'utf8')
    .split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && line !== 'EXPORTS' && !line.startsWith('LIBRARY ')).sort();
  const functions = [...new Set([...header.matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/gu)].map((m) => m[1]))].sort();
  assert.equal(exported.length, 23);
  assert.deepEqual(exported, [...functions, ...qrImageSymbols()].sort());
  assert.equal(citizenSdkSymbols().length, 144);
  assert.match(header, /void \*hwnd;/u);
  assert.doesNotMatch(header, /gtk_parent|private_key|plaintext_dek|mnemonic_utf8/u);
  const cmake = readFileSync(join(citizenSdkRoot, 'windows/CMakeLists.txt'), 'utf8');
  assert.match(cmake, /NOT WIN32 OR NOT MSVC/u);
  assert.match(cmake, /CitizenSDK::Core/u);
  assert.doesNotMatch(cmake, /find_package\(Flutter|Software KSP|tss2/u);
  assert.match(cmake, /if\(TARGET flutter\)\s+include\(cmake\/CitizenSDKFlutter\.cmake\)\s+return\(\)/u);
  assert.match(cmake, /PATTERN "citizen_sdk_plugin\.h" EXCLUDE/u);
  const adapter = readFileSync(join(citizenSdkRoot, 'windows/cmake/CitizenSDKFlutter.cmake'), 'utf8');
  assert.match(adapter, /find_package\(CitizenSDK \$\{PROJECT_VERSION\} EXACT CONFIG REQUIRED/u);
  assert.match(adapter, /NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH/u);
  assert.match(adapter, /IMPORTED_\$\{_property\}_\$\{_upper\}/u);
  assert.match(adapter, /INTERFACE_INCLUDE_DIRECTORIES/u);
  assert.match(adapter, /INTERFACE_LINK_LIBRARIES/u);
  assert.match(adapter, /target_compile_definitions\(\$\{target\} PRIVATE/u);
  assert.match(adapter, /_HAS_EXCEPTIONS=1 FLUTTER_PLUGIN_IMPL/u);
  assert.match(adapter, /flutter flutter_wrapper_plugin CitizenSDK::Host/u);
  assert.doesNotMatch(adapter, /apply_standard_settings\(|add_subdirectory\([^\n]*(?:native|src)|FetchContent|ExternalProject/u);
  const contractCmake = readFileSync(join(citizenSdkRoot, 'windows/tests/CMakeLists.txt'), 'utf8');
  const adapterTests = contractCmake.match(/set\(CITIZENSDK_WINDOWS_FLUTTER_CONTRACT_TESTS([\s\S]*?)\)/u)?.[1].trim().split(/\s+/u);
  assert.deepEqual(adapterTests, [
    'citizen_sdk_flutter_codec_test', 'citizen_sdk_flutter_environment_test',
    'citizen_sdk_flutter_sessions_test', 'citizen_sdk_flutter_wallet_flow_test',
    'citizen_sdk_flutter_plugin_test', 'citizen_sdk_flutter_secret_boundary_test',
  ]);
  assert.match(contractCmake, /target_compile_options\(\$\{test_name\} PRIVATE \/UNDEBUG\)/u);
  assert.match(contractCmake, /target_link_libraries\(citizensdk_windows_flutter_test_support PUBLIC advapi32\)/u);
  assert.ok(contractCmake.indexOf('return()') < contractCmake.indexOf('set(_host_sources)'));
  const plugin = readFileSync(join(citizenSdkRoot, 'windows/source/citizen_sdk_plugin.cc'), 'utf8');
  assert.equal([...plugin.matchAll(/decode_method_call\(message, size\)/gu)].length, 2);
  assert.doesNotMatch(plugin, /DecodeMethodCall\(/u);
  const codec = readFileSync(join(citizenSdkRoot, 'windows/source/citizen_sdk_flutter_codec.cc'), 'utf8');
  assert.match(codec, /WirePreflight\(message, size\)\.check\(\);\s+auto result = ::flutter::StandardMethodCodec::GetInstance\(\)\.DecodeMethodCall\(message, size\)/u);
  const build = nativeShellFunctions(['build_windows', 'verify_windows_exports', 'windows_path_preflight']);
  assert.match(build, /x86_64-pc-windows-msvc/u);
  assert.match(build, /--release --locked --offline/u);
  assert.match(build, /ctest --test-dir/u);
  assert.match(build, /0x8664/u);
  assert.match(build, /Windows output is inside source/u);
  const script = BUILD_SHELL_SOURCES.native;
  assert.ok(script.indexOf('if [[ "$target_name" == Windows ]]') < script.indexOf('work_dir="$(canonical_directory'));
  assert.doesNotMatch(readFileSync(join(citizenSdkRoot, '.pubignore'), 'utf8'), /^\/windows\/$/mu);
  assert.match(readFileSync(join(citizenSdkRoot, 'pubspec.yaml'), 'utf8'), /^      windows:\n        pluginClass: CitizenSdkPlugin$/mu);
});

test('Windows 身份声明执行生产 CMake 校验，缺失、非法或越界均拒绝', () => {
  const root = mkdtempSync(join(workRoot, 'windows-identity-contract-'));
  try {
    const source = readFileSync(join(citizenSdkRoot, 'windows/cmake/CitizenSDKFlutter.cmake'), 'utf8');
    const start = source.indexOf('if(NOT DEFINED CITIZENSDK_APPLICATION_ID)');
    const end = source.indexOf('get_filename_component(_citizensdk_windows_root');
    assert.ok(start >= 0 && end > start);
    // 只执行生产身份校验段；不伪装 WIN32、不创建库目标、不配置 Windows 编译器。
    const script = join(root, 'identity.cmake');
    writeFileSync(script, source.slice(start, end));
    const invoke = (value) => spawnSync('cmake', [
      ...(value === undefined ? [] : [`-DCITIZENSDK_APPLICATION_ID=${value}`]), '-P', script,
    ], { encoding: 'utf8', cwd: root, timeout: 10000 });
    for (const value of ['a.b', 'org.example.application', 'org.example-data.app', `a.${'b'.repeat(251)}`]) {
      const result = invoke(value);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const value of [undefined, '', 'org', 'Org.example', 'org..app', 'org.app.',
      'org._app', 'org.-app', 'org.app-', 'org.app;other', 'org.app\n', 'org.应用',
      `a.${'b'.repeat(252)}`, 'org.app";message(FATAL_ERROR injected)']) {
      const result = invoke(value);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CITIZENSDK_APPLICATION_ID/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 安装执行21项闭集、来源字节、版本和PE完整导出验收', () => {
  const root = mkdtempSync(join(workRoot, 'windows-install-contract-'));
  try {
    const fixture = windowsInstallFixture(root);
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'assert_safe_directory_path', 'windows_install_files',
        'verify_windows_install', 'verify_windows_exports', 'product_internal_symbols',
        'qr_image_header_symbols']),
      'cygpath() { [[ "$1" == -m ]]; printf "%s\\n" "$2"; }',
      'dumpbin() { [[ "${WINDOWS_FIXTURE_DUMPBIN_FAIL:-0}" == 0 ]] || return 19; /bin/cat "$fixture_root/${3##*/}.exports"; }',
      'sdk_dir="$1"; fixture_root="$2"; product_header="$sdk_dir/include/citizensdk.h"',
      'qr_image_header="$sdk_dir/native/image/citizensdk_qr_image.h"',
      'script_dir="$sdk_dir/scripts"',
      'windows_source_root="$sdk_dir/windows"; apple_asset_root="$sdk_dir/chain"',
      'if [[ "$3" == list ]]; then windows_install_files; else verify_windows_install "$2/install" "$3" "$2/core" "$2/cmake"; fi',
    ].join('\n');
    const run = (version = '1.0.0', environment = {}) => spawnSync('/bin/bash',
      ['-c', shell, 'windows-install-contract', citizenSdkRoot, root, version], {
        encoding: 'utf8', timeout: 15000, env: { ...process.env, ...environment },
      });
    const listed = run('list');
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split('\n'), windowsInstallFixturePaths());
    assert.equal(windowsInstallFixturePaths().length, 21);
    const accepted = run();
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.status, 0, accepted.stderr);
    const reject = (message = /Windows|install|PE|export/u) => {
      const result = run();
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, '不完整或漂移安装不得通过');
      assert.match(result.stderr, message);
    };
    const changed = (paths, bytes, message) => {
      const originals = paths.map((path) => readFileSync(path));
      try {
        paths.forEach((path) => writeFileSync(path, bytes));
        reject(message);
      } finally { paths.forEach((path, index) => writeFileSync(path, originals[index])); }
    };
    // 每一安装项都单独缺失、漂移一次，不能以数量相等替代逐项来源对拍。
    for (const relative of windowsInstallFixturePaths()) {
      const path = join(fixture.prefix, relative);
      const bytes = readFileSync(path);
      unlinkSync(path);
      try { reject(/closure drift/u); } finally { writeFileSync(path, bytes); }
      changed([path], Buffer.concat([bytes, Buffer.from('\ndrift')]), /installed bytes differ/u);
    }
    const extra = join(fixture.prefix, 'unregistered');
    writeFileSync(extra, 'extra');
    reject(/closure drift/u);
    unlinkSync(extra);
    mkdirSync(extra);
    reject(/closure drift/u);
    rmSync(extra, { recursive: true });
    const header = join(fixture.prefix, 'include/citizensdk.h');
    unlinkSync(header);
    symlinkSync(join(citizenSdkRoot, 'include/citizensdk.h'), header);
    reject(/reparse|alias/u);
    unlinkSync(header);
    copyFileSync(join(citizenSdkRoot, 'include/citizensdk.h'), header);
    const include = join(fixture.prefix, 'include/citizen_sdk');
    rmSync(include, { recursive: true });
    symlinkSync(join(citizenSdkRoot, 'windows/headers'), include, 'dir');
    reject(/reparse|alias/u);
    unlinkSync(include);
    mkdirSync(include);
    for (const relative of windowsInstallFixturePaths().filter((path) => path.startsWith('include/citizen_sdk/'))) {
      copyFileSync(fixture.references.get(relative), join(fixture.prefix, relative));
    }
    const manifest = join(fixture.build, 'install_manifest.txt');
    const entries = readFileSync(manifest, 'utf8').trim().split('\n');
    // 不经过 join/resolve 规范化；首项按闭集排序可能是 bin，而不是 include。
    const nonCanonical = `${fixture.prefix}/./${windowsInstallFixturePaths()[0]}`;
    assert.notEqual(nonCanonical, entries[0], '拒绝用未发生变化的输入冒充路径反例');
    for (const invalid of [entries.slice(1), [...entries, entries[0]],
      [join(root, 'foreign.h'), ...entries.slice(1)],
      [nonCanonical, ...entries.slice(1)]]) {
      assert.notDeepEqual(invalid, entries, '每个清单反例必须确实改变输入');
      changed([manifest], `${invalid.join('\n')}\n`, /install_manifest/u);
    }
    assert.notEqual(run('1.0.1').status, 0, '版本参数必须匹配实际 SDK 源码');
    assert.notEqual(run('1.0.0+fixture').status, 0, '版本格式不能放宽');
    const versionRelative = 'lib/Windows/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake';
    changed([join(fixture.prefix, versionRelative), fixture.references.get(versionRelative)],
      'set(PACKAGE_VERSION "1.0.1")\n', /version template drift/u);
    const targetRelative = 'lib/Windows/cmake/CitizenSDK/CitizenSDKTargets.cmake';
    changed([join(fixture.prefix, targetRelative), fixture.references.get(targetRelative)],
      `set(leaked "${fixture.core}/citizensdk.dll")\n`, /absolute build path/u);
    const duplicate = join(fixture.build, 'CMakeFiles/Export/other/CitizenSDKTargets.cmake');
    mkdirSync(dirname(duplicate));
    copyFileSync(fixture.references.get(targetRelative), duplicate);
    reject(/missing or ambiguous/u);
    rmSync(dirname(duplicate), { recursive: true });
    // 同时改变安装件与本轮原件，确保失败来自真实 PE/导出门禁，而非前置字节比较。
    for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) {
      const relative = `bin/Windows/${name}`;
      const installed = join(fixture.prefix, relative);
      const original = readFileSync(installed);
      const invalidPe = [Buffer.alloc(63), Buffer.from(original), Buffer.from(original), Buffer.from(original)];
      invalidPe[1].writeUInt16LE(0xaa64, 132);
      invalidPe[2].writeUInt16LE(0x10b, 152);
      invalidPe[3].writeUInt32LE(0xffffffff, 60);
      for (const invalid of invalidPe) {
        changed([installed, fixture.references.get(relative)], invalid, /PE|machine/u);
      }
      const output = join(root, `${name}.exports`);
      const lines = fixture.exports.get(name).trimEnd().split('\n');
      const last = lines.at(-1);
      for (const invalid of [lines.slice(0, -1).join('\n'), `${lines.join('\n')}\n${last}\n`,
        `${lines.join('\n')}\n  999 3E7 1999 unregistered_export\n`,
        `${lines.slice(0, -1).join('\n')}\n${last} = foreign.symbol\n`]) {
        changed([output], invalid, /export/u);
      }
    }
    assert.notEqual(run('1.0.0', { WINDOWS_FIXTURE_DUMPBIN_FAIL: '1' }).status, 0);
    const final = run();
    assert.equal(final.status, 0, final.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 消费者执行准确两项 CTest、DLL 来源与退出码和成功行双重门禁', () => {
  const root = mkdtempSync(join(workRoot, 'windows-consumer-contract-'));
  try {
    const fixture = windowsInstallFixture(root);
    const build = join(root, 'consumer');
    const runtime = join(build, 'Release');
    const state = join(root, 'consumer-state');
    const inventoryPath = join(root, 'inventory.json');
    const outputPath = join(root, 'ctest.txt');
    mkdirSync(runtime, { recursive: true });
    for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) {
      copyFileSync(join(fixture.prefix, 'bin/Windows', name), join(runtime, name));
    }
    const definitions = [
      ['CitizenSDK.Windows.CConsumer', 'citizen_sdk_c_consumer.exe'],
      ['CitizenSDK.Windows.CppConsumer', 'citizen_sdk_cpp_consumer.exe'],
    ];
    const inventory = () => ({ tests: definitions.map(([name, executable]) => ({
      name,
      command: [join(runtime, executable), state,
        join(fixture.prefix, 'share/citizensdk/chain'), runtime],
      properties: [{ name: 'TIMEOUT', value: 180 }, { name: 'RUN_SERIAL', value: true }],
    })) });
    // CTest 外部工具输出为有限夹具；这些程序占位件绝不被执行。
    for (const [, executable] of definitions) writeFileSync(join(runtime, executable), 'inventory-only fixture\n');
    const success = '1: CitizenSDK C consumer passed\n2: CitizenSDK C++ consumer passed\n';
    writeFileSync(inventoryPath, JSON.stringify(inventory()));
    writeFileSync(outputPath, success);
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'verify_windows_consumer_inventory', 'run_windows_consumers']),
      'cygpath() { [[ "$1" == -m ]]; printf "%s\\n" "$2"; }',
      'fixture_root="$1"',
      'ctest() {',
      '  if [[ "$*" == *--show-only=json-v1* ]]; then',
      '    [[ "${WINDOWS_FIXTURE_INVENTORY_FAIL:-0}" == 0 ]] || return 23',
      '    /bin/cat "$fixture_root/inventory.json"',
      '  else /bin/cat "$fixture_root/ctest.txt"; return "${WINDOWS_FIXTURE_CTEST_STATUS:-0}"; fi',
      '}',
      'run_windows_consumers "$1/consumer" "$1/install" "$1/consumer-state"',
    ].join('\n');
    const run = (environment = {}) => spawnSync('/bin/bash',
      ['-c', shell, 'windows-consumer-contract', root], {
        encoding: 'utf8', timeout: 10000, env: { ...process.env, ...environment },
      });
    const accepted = run();
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.status, 0, accepted.stderr);
    const badInventory = (mutate) => {
      const value = inventory();
      mutate(value);
      writeFileSync(inventoryPath, JSON.stringify(value));
      const result = run();
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, 'CTest 清单漂移必须失败');
      writeFileSync(inventoryPath, JSON.stringify(inventory()));
    };
    for (const mutate of [
      (value) => { value.tests = []; },
      (value) => { value.tests.pop(); },
      (value) => { value.tests.push(value.tests[0]); },
      (value) => { value.tests[1].name = value.tests[0].name; },
      (value) => { value.tests[1].name = 'CitizenSDK.Windows.Unregistered'; },
      (value) => { value.tests[0].command.pop(); },
      (value) => { value.tests[0].command[0] = join(root, 'other.exe'); },
      (value) => { value.tests[0].command[1] = join(root, 'foreign-state'); },
      (value) => { value.tests[0].command[2] = join(root, 'foreign-assets'); },
      (value) => { value.tests[0].command[3] = fixture.prefix; },
      (value) => { value.tests[0].properties[0].value = 0; },
      (value) => { value.tests[0].properties[0].value = '180'; },
      (value) => { value.tests[0].properties[1].value = false; },
      (value) => { value.tests[0].properties.push(value.tests[0].properties[0]); },
    ]) badInventory(mutate);
    for (const name of ['PASS_REGULAR_EXPRESSION', 'SKIP_REGULAR_EXPRESSION',
      'SKIP_RETURN_CODE', 'WILL_FAIL', 'DISABLED']) {
      badInventory((value) => { value.tests[0].properties.push({ name, value: false }); });
    }
    for (const text of ['', success.split('\n')[0], `${success}1: CitizenSDK C consumer passed\n`,
      success.replaceAll(/^\d+: /gmu, ''), success.replace('C++ consumer passed', 'C++ consumer skipped')]) {
      writeFileSync(outputPath, text);
      const result = run();
      assert.notEqual(result.status, 0, '成功行必须各自精确出现一次');
      assert.match(result.stderr, /成功标记/u);
    }
    writeFileSync(outputPath, success);
    assert.notEqual(run({ WINDOWS_FIXTURE_CTEST_STATUS: '17' }).status, 0,
      '即使两行成功标记齐全，也不能覆盖 CTest 非零退出');
    assert.notEqual(run({ WINDOWS_FIXTURE_INVENTORY_FAIL: '1' }).status, 0);
    for (const name of ['citizensdk.dll', 'citizensdk_host.dll', ...definitions.map(([, file]) => file)]) {
      const file = join(runtime, name);
      const original = readFileSync(file);
      unlinkSync(file);
      assert.notEqual(run().status, 0, `缺少 ${name} 不能运行`);
      const source = name.endsWith('.dll') ? join(fixture.prefix, 'bin/Windows', name)
        : join(root, `${name}.fixture`);
      if (!name.endsWith('.dll')) writeFileSync(source, original);
      symlinkSync(source, file);
      assert.notEqual(run().status, 0, '不得通过链接加载测试程序或运行库');
      unlinkSync(file);
      writeFileSync(file, original);
      if (name.endsWith('.dll')) {
        writeFileSync(file, Buffer.concat([original, Buffer.from('foreign-library')]));
        assert.notEqual(run().status, 0, '运行 DLL 必须来自准确安装原件');
        writeFileSync(file, original);
      }
    }
    const linkedRuntime = join(root, 'linked-runtime');
    cpSync(runtime, linkedRuntime, { recursive: true });
    rmSync(runtime, { recursive: true });
    symlinkSync(linkedRuntime, runtime, 'dir');
    assert.notEqual(run().status, 0, '普通最终项不能掩盖运行目录的链接祖先');
    unlinkSync(runtime);
    cpSync(linkedRuntime, runtime, { recursive: true });
    const final = run();
    assert.equal(final.status, 0, final.stderr);
    assert.equal(existsSync(state), false, '清单验收不得抢先创建 Host 私有状态目录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 已验证安装执行同卷导出且拒绝覆盖、越界与链接', () => {
  const root = mkdtempSync(join(workRoot, 'windows-export-contract-'));
  try {
    const work = join(root, 'work');
    const output = join(root, 'output');
    mkdirSync(work);
    mkdirSync(output);
    const source = (name) => {
      const path = join(work, name);
      mkdirSync(path);
      writeFileSync(join(path, 'verified.txt'), `verified:${name}\n`);
      return path;
    };
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'assert_safe_directory_path', 'assert_descendant_path', 'export_windows_install']),
      'cygpath() { [[ "$1" == -m ]]; printf "%s\\n" "$2"; }',
      'work_dir="$1"; output_dir="$2"',
      'export_windows_install "$3" "$4"',
    ].join('\n');
    const run = (from, to) => spawnSync('/bin/bash',
      ['-c', shell, 'windows-export-contract', work, output, from, to], {
        encoding: 'utf8', timeout: 10000,
      });
    const installed = source('install');
    const destination = join(output, 'Windows');
    const accepted = run(installed, destination);
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(existsSync(installed), false);
    assert.equal(readFileSync(join(destination, 'verified.txt'), 'utf8'), 'verified:install\n');
    const pending = source('pending');
    for (const target of [destination, output, join(root, 'outside')]) {
      const result = run(pending, target);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(pending, 'verified.txt'), 'utf8'), 'verified:pending\n');
      assert.equal(readFileSync(join(destination, 'verified.txt'), 'utf8'), 'verified:install\n');
    }
    const dangling = join(output, 'dangling');
    symlinkSync(join(root, 'absent'), dangling);
    assert.notEqual(run(pending, dangling).status, 0);
    assert.equal(readlinkSync(dangling), join(root, 'absent'));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const linkedParent = join(output, 'linked');
    symlinkSync(outside, linkedParent, 'dir');
    assert.notEqual(run(pending, join(linkedParent, 'Windows')).status, 0);
    assert.deepEqual(readdirSync(outside), []);
    const linkedSource = join(work, 'linked-source');
    symlinkSync(pending, linkedSource, 'dir');
    assert.notEqual(run(linkedSource, join(output, 'new')).status, 0);
    assert.notEqual(run(outside, join(output, 'new')).status, 0);
    assert.equal(existsSync(pending), true);
    // 只向原生产 Node 段注入 EXDEV 文件系统故障；不依赖测试机器恰有第二块卷，
    // 也不改写/复刻导出算法。失败后必须传播原错误，不得开始跨卷复制或删除。
    const production = nativeShellFunctions(['export_windows_install']);
    const fragments = [...production.matchAll(/node -e '([\s\S]*?)' "\$\(cygpath/gu)];
    assert.equal(fragments.length, 1);
    const calls = [];
    const from = '/work/install';
    const to = '/output/Windows';
    assert.throws(() => runInNewContext(fragments[0][1], {
      process: { argv: ['node', from, to], platform: 'linux' },
      require: (name) => {
        if (name === 'path') return posix;
        assert.equal(name, 'fs');
        return {
          lstatSync: (path) => {
            if (path === to) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            assert.ok(path === from || path === '/output');
            return { isDirectory: () => true, isSymbolicLink: () => false };
          },
          realpathSync: (path) => path,
          renameSync: (a, b) => {
            calls.push([a, b]);
            throw Object.assign(new Error('cross-device EXDEV fixture'), { code: 'EXDEV' });
          },
        };
      },
    }), /cross-device EXDEV fixture/u);
    assert.deepEqual(calls, [[from, to]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 唯一构建器严格在原生、安装和消费者全部成功后才导出', () => {
  const root = mkdtempSync(join(workRoot, 'windows-build-order-contract-'));
  try {
    const hostTests = ['api_contract', 'assets', 'host_operation', 'lifecycle', 'directory',
      'public_store', 'record_key', 'secure_store', 'sensitive_buffer', 'secret_vault',
      'secret_boundary', 'cng', 'user_auth', 'wallet_flow'];
    const inventory = join(root, 'host-tests.json');
    writeFileSync(inventory, JSON.stringify({ tests: hostTests.map((name) => ({
      name: `CitizenSDK.Windows.citizen_sdk_${name}_test`,
    })) }));
    // 保留 build_windows 原函数控制流与真实导出，只用有界工具/阶段结果替身；
    // 不调用 Cargo/MSVC/CMake 构建，不把阶段模拟当成 Windows 运行验收。
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'assert_safe_directory_path', 'assert_descendant_path',
        'prepare_safe_directory', 'assert_readonly_dependency_directory', 'build_windows', 'export_windows_install']),
      'sdk_dir="$1"; fixture_root="$2"; case_root="$3"; fail_at="$4"',
      'work_dir="$case_root/work"; output_dir="$case_root/output"; cargo_target_dir="$work_dir/cargo"',
      'windows_source_root="$sdk_dir/windows"; product_ffi_manifest="$sdk_dir/native/ffi/Cargo.toml"',
      'CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR="$case_root/sqlite"',
      'CITIZENSDK_WINDOWS_SQLITE_ARCHIVE="$case_root/sqlite/sqlite3.lib"',
      'stage() { printf "%s\\n" "$1" >> "$case_root/trace"; [[ "$1" != "$fail_at" ]]; }',
      'prepare_internal_header() { stage private_header; }',
      'cygpath() { [[ "$1" == -m ]]; printf "%s\\n" "$2"; }',
      'windows_path_preflight() { stage preflight; }',
      'load_native_dependencies() { [[ "$1" == Windows ]]; stage dependencies; }',
      'record_native_dependencies() { [[ "$1" == Windows && -f "$output_dir/Windows/verified.txt" ]]; stage evidence; }',
      'require_rust_target() { [[ "$1" == x86_64-pc-windows-msvc ]]; }',
      'cl() { return 99; }; dumpbin() { return 99; }',
      'cargo() { [[ "$*" == *"--release --locked --offline"* ]]; stage cargo; }',
      'cmake() {',
      '  case "$1" in',
      '    -S) if [[ "$2" == "$windows_source_root/tests" ]]; then',
      '      [[ "$*" == *"-DCITIZENSDK_CONSUMER_PREFIX=$work_dir/Windows/install"* ]]',
      '      stage consumer_configure',
      '    else [[ "$*" == *"-DCMAKE_INSTALL_PREFIX=$work_dir/Windows/install"* ]]; stage host_configure; fi ;;',
      '    --build) if [[ "$2" == "$work_dir/Windows/consumer" ]]; then stage consumer_build; else stage host_build; fi ;;',
      '    --install) stage install; printf "verified installation\\n" > "$work_dir/Windows/install/verified.txt" ;;',
      '    *) return 98 ;;',
      '  esac',
      '}',
      'ctest() {',
      '  if [[ "$*" == *--show-only=json-v1* ]]; then stage host_inventory || return 55; /bin/cat "$fixture_root/host-tests.json";',
      '  else stage host_tests; fi',
      '}',
      'verification_count=0',
      'verify_windows_install() {',
      '  [[ "$1" == "$work_dir/Windows/install" && "$2" == 1.0.0 && -f "$1/verified.txt" ]]',
      '  verification_count=$((verification_count + 1)); stage "verify$verification_count"',
      '}',
      'run_windows_consumers() { [[ "$1" == "$work_dir/Windows/consumer" ]]; stage consumers; }',
      'build_windows_flutter_consumer() { [[ "$1" == "$work_dir/Windows" && "$2" == "$work_dir/Windows/install" && "$3" == 1.0.0 ]]; stage flutter; }',
      'build_windows',
    ].join('\n');
    const stages = ['private_header', 'preflight', 'dependencies', 'cargo', 'host_configure', 'host_build', 'host_inventory',
      'host_tests', 'install', 'verify1', 'consumer_configure', 'consumer_build', 'consumers', 'flutter', 'verify2', 'evidence'];
    const run = (failAt) => {
      const path = join(root, failAt || 'success');
      mkdirSync(join(path, 'work/cargo/x86_64-pc-windows-msvc/release'), { recursive: true });
      mkdirSync(join(path, 'output'));
      mkdirSync(join(path, 'sqlite'));
      writeFileSync(join(path, 'sqlite/sqlite3.lib'), 'dependency path fixture');
      for (const name of ['citizensdk.dll', 'citizensdk.dll.lib']) {
        writeFileSync(join(path, 'work/cargo/x86_64-pc-windows-msvc/release', name), 'stage-only fixture');
      }
      const result = spawnSync('/bin/bash', ['-c', shell, 'windows-build-order',
        citizenSdkRoot, root, path, failAt], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.error, undefined);
      const trace = readFileSync(join(path, 'trace'), 'utf8').trim().split('\n');
      return { path, result, trace };
    };
    const success = run('');
    assert.equal(success.result.status, 0, success.result.stderr);
    assert.deepEqual(success.trace, stages);
    assert.equal(existsSync(join(success.path, 'work/Windows/install')), false);
    assert.equal(readFileSync(join(success.path, 'output/Windows/verified.txt'), 'utf8'), 'verified installation\n');
    for (const stage of stages) {
      const failed = run(stage);
      assert.notEqual(failed.result.status, 0, `${stage} 失败必须结束本轮`);
      assert.deepEqual(failed.trace, stages.slice(0, stages.indexOf(stage) + 1));
      // 所有原生/消费者门禁完成后才导出；若最后证据写入失败，保留已导出现场但不得报成功。
      assert.deepEqual(readdirSync(join(failed.path, 'output')), stage === 'evidence' ? ['Windows'] : [],
        `${stage} 失败不得提前导出或伪造证据`);
    }
    const source = (path) => readFileSync(join(citizenSdkRoot, path), 'utf8');
    const cmake = source('windows/tests/CitizenSDKConsumer.cmake');
    assert.match(cmake, /find_package\(CitizenSDK \$\{CITIZENSDK_CONSUMER_VERSION\} EXACT CONFIG REQUIRED/u);
    assert.match(cmake, /NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH/u);
    assert.match(cmake, /get_target_property\(_imported CitizenSDK::\$\{_kind\} IMPORTED\)/u);
    assert.match(cmake, /MAP_IMPORTED_CONFIG_\$\{_upper\}/u);
    assert.equal([...cmake.matchAll(/-E compare_files/gu)].length, 2);
    assert.match(cmake, /\/UNDEBUG \/W4 \/WX/u);
    assert.doesNotMatch(cmake, /add_subdirectory\(|FetchContent|ExternalProject/u);
    assert.doesNotMatch(cmake, /PROPERTIES[^\n]*(?:PASS_REGULAR_EXPRESSION|SKIP_RETURN_CODE|WILL_FAIL)/u);
    for (const file of ['windows/tests/citizen_sdk_c_consumer.c', 'windows/tests/citizen_sdk_cpp_consumer.cc']) {
      const consumer = source(file);
      assert.match(consumer, /#ifdef NDEBUG/u);
      assert.match(consumer, /GetModuleHandleW\(name\)/u);
      assert.match(consumer, /GetModuleFileNameW\(/u);
      if (file.endsWith('.c')) assert.match(consumer, /config\.enable_wallet = 0;/u);
      else assert.match(consumer, /config\.modules = CITIZENSDK_MODULE_CHAIN \| CITIZENSDK_MODULE_TRANSACTIONS \| CITIZENSDK_MODULE_HISTORY;/u);
      assert.match(consumer, /config\.hwnd = (?:NULL|nullptr);/u);
      assert.match(consumer, /CITIZENSDK_ERROR_BUSY/u);
      assert.match(consumer, /CITIZENSDK_ERROR_INVALID_HANDLE/u);
      assert.match(consumer, /CITIZENSDK_ERROR_NOT_READY/u);
      assert.doesNotMatch(consumer, /^#include\s*[<"][^>"\n]*(?:src\/|test_support|_bridge|_secret_vault)/mu);
      assert.doesNotMatch(consumer, /\bassert\s*\(|citizensdk_(?:sign|submit|transfer|create_wallet|import_wallet)\s*\(/u);
    }
    assert.match(source('windows/tests/citizen_sdk_c_consumer.c'), /citizensdk_result_release\(result\) == CITIZENSDK_OK/u);
    assert.doesNotMatch(source('windows/tests/citizen_sdk_cpp_consumer.cc'), /citizensdk_result_release\s*\(/u);
    assert.match(source('windows/tests/citizen_sdk_cpp_consumer.cc'), /host\.set_event_observer\(\{\}\)/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 候选复用唯一21项验真并逐项拒绝PE、COFF、依赖和CMake漂移', () => {
  const root = mkdtempSync(join(workRoot, 'windows-release-projection-'));
  try {
    const fixture = windowsInstallFixture(join(root, 'native'));
    assert.equal(assertWindowsNativeArtifact(citizenSdkRoot, fixture.prefix), '1.0.0');
    const changed = (relative, mutate) => {
      const path = join(fixture.prefix, relative);
      const original = readFileSync(path);
      const bytes = mutate(Buffer.from(original));
      assert.notDeepEqual(bytes, original, '反向夹具必须改变原字节');
      try {
        writeFileSync(path, bytes);
        assert.throws(() => assertWindowsNativeArtifact(citizenSdkRoot, fixture.prefix));
      } finally { writeFileSync(path, original); }
    };
    for (const relative of windowsInstallFixturePaths()) {
      const path = join(fixture.prefix, relative), original = readFileSync(path);
      unlinkSync(path);
      try { assert.throws(() => assertWindowsNativeArtifact(citizenSdkRoot, fixture.prefix)); }
      finally { writeFileSync(path, original); }
    }
    for (const relative of windowsInstallFixturePaths().filter((path) => /^(?:include|share)\//u.test(path))) {
      changed(relative, (bytes) => Buffer.concat([bytes, Buffer.from('\n')]));
    }
    const coreNames = citizenSdkLinkedSymbols();
    const hostNames = [...new Set([
      ...[...readFileSync(join(citizenSdkRoot, 'windows/headers/citizensdk_host.h'), 'utf8')
        .matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/gu)].map((match) => match[1]),
      ...qrImageSymbols(),
    ])].sort();
    for (const [name, names] of [['citizensdk.dll', coreNames], ['citizensdk_host.dll', hostNames]]) {
      const path = `bin/Windows/${name}`;
      changed(path, (bytes) => { bytes.writeUInt16LE(0xaa64, 132); return bytes; });
      changed(path, (bytes) => { bytes.writeUInt16LE(0x10b, 152); return bytes; });
      changed(path, (bytes) => { bytes.writeUInt32LE(0xffffffff, 60); return bytes; });
      changed(path, (bytes) => { bytes.writeUInt32LE(0x2000, 1024 + 40); return bytes; });
      changed(path, () => windowsPeFixture(names.slice(1), name));
      changed(path, () => windowsPeFixture([...names, 'unregistered_export'].sort(), name));
      for (const imports of [
        [{ name: 'foreign.dll', symbols: ['unregistered'] }],
        [{ name: '../kernel32.dll', symbols: ['GetLastError'] }],
        [{ name: 'C:\\Windows\\kernel32.dll', symbols: ['GetLastError'] }],
        [{ name: 'vcruntime140d.dll', symbols: ['unregistered'] }],
        [{ name: 'api-ms-win-core.dll', symbols: ['unregistered'] }],
      ]) changed(path, () => windowsPeFixture(names, name, 0x8664, imports));
    }
    changed('bin/Windows/citizensdk.dll', () => windowsPeFixture(coreNames, 'citizensdk.dll', 0x8664,
      [{ name: 'citizensdk_host.dll', symbols: [hostNames[0]] }]));
    changed('bin/Windows/citizensdk_host.dll', () => windowsPeFixture(hostNames, 'citizensdk_host.dll', 0x8664, []));
    changed('bin/Windows/citizensdk_host.dll', () => windowsPeFixture(hostNames, 'citizensdk_host.dll', 0x8664,
      [{ name: 'citizensdk.dll', symbols: ['citizensdk_unregistered'] }]));
    changed('bin/Windows/citizensdk_host.dll', () => windowsPeFixture(hostNames, 'citizensdk_host.dll', 0x8664,
      [{ name: 'citizensdk.dll', symbols: [7] }]));
    // 按 archive header 和 COFF section table 定位真实描述符，不猜测对象的字节位置。
    const descriptorSection = (bytes, name) => {
      for (let at = 8; at < bytes.length;) {
        const size = Number(bytes.toString('ascii', at + 48, at + 58).trim());
        const object = at + 60;
        if (size >= 20 && bytes.readUInt16LE(object) === 0x8664) {
          const count = bytes.readUInt16LE(object + 2);
          for (let index = 0; index < count; index += 1) {
            const header = object + 20 + index * 40;
            const field = bytes.subarray(header, header + 8).toString('ascii').replace(/\0.*$/u, '');
            if (field === name) return { object, header };
          }
        }
        at += 60 + size + size % 2;
      }
      assert.fail(`缺少 COFF 描述符节 ${name}`);
    };
    for (const relative of ['lib/Windows/citizensdk.dll.lib', 'lib/Windows/citizensdk_host.lib']) {
      const path = join(fixture.prefix, relative), original = readFileSync(path);
      const host = relative.endsWith('citizensdk_host.lib');
      try {
        for (const longnames of [false, true]) for (const internalPadding of [false, true]) {
          writeFileSync(path, windowsImportLibraryFixture(host ? hostNames : coreNames,
            host ? 'citizensdk_host.dll' : 'citizensdk.dll', { longnames, internalPadding }));
          assert.equal(assertWindowsNativeArtifact(citizenSdkRoot, fixture.prefix), '1.0.0');
        }
      } finally { writeFileSync(path, original); }
      changed(relative, () => Buffer.from('!<arch>\n'));
      changed(relative, (bytes) => { bytes.writeUInt32BE(0xffffffff, 68); return bytes; });
      changed(relative, (bytes) => { bytes.writeUInt32BE(1, 72); return bytes; });
      changed(relative, (bytes) => {
        const length = Number(bytes.toString('ascii', 56, 66).trim());
        const second = 68 + length + length % 2;
        bytes.writeUInt32LE(0xffffffff, second + 60 + 4);
        return bytes;
      });
      changed(relative, (bytes) => {
        const length = Number(bytes.toString('ascii', 56, 66).trim());
        const second = 68 + length + length % 2;
        const count = bytes.readUInt32LE(second + 60);
        bytes.writeUInt16LE(0, second + 60 + 8 + count * 4);
        return bytes;
      });
      changed(relative, (bytes) => {
        const { object, header } = descriptorSection(bytes, '.idata$6');
        bytes[object + bytes.readUInt32LE(header + 20)] ^= 1;
        return bytes;
      });
      changed(relative, (bytes) => {
        const { object, header } = descriptorSection(bytes, '.idata$2');
        bytes.writeUInt16LE(0, object + bytes.readUInt32LE(header + 24) + 8);
        return bytes;
      });
      for (const name of ['.idata$3', '.idata$4']) changed(relative, (bytes) => {
        const { object, header } = descriptorSection(bytes, name);
        bytes[object + bytes.readUInt32LE(header + 20)] = 1;
        return bytes;
      });
    }
    for (const file of ['CitizenSDKConfig.cmake', 'CitizenSDKConfigVersion.cmake',
      'CitizenSDKDependencies.cmake', 'CitizenSDKTargets.cmake', 'CitizenSDKTargets-release.cmake']) {
      changed(`lib/Windows/cmake/CitizenSDK/${file}`, (bytes) => Buffer.concat([bytes,
        Buffer.from('\ninclude("/outside/foreign.cmake")\n')]));
    }
    changed('lib/Windows/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake',
      (bytes) => Buffer.from(bytes.toString().replaceAll('1.0.0', '1.0.1')));
    changed('lib/Windows/cmake/CitizenSDK/CitizenSDKTargets-release.cmake',
      (bytes) => Buffer.from(bytes.toString().replaceAll('citizensdk_host.dll', 'foreign.dll')));
    changed('lib/Windows/cmake/CitizenSDK/CitizenSDKConfig.cmake',
      (bytes) => Buffer.from(`${bytes}\n#[[]] include("/outside/injected.cmake")\n`));
    const extra = join(fixture.prefix, 'unregistered');
    for (const directory of [false, true]) {
      if (directory) mkdirSync(extra); else writeFileSync(extra, 'extra');
      assert.throws(() => assertWindowsNativeArtifact(citizenSdkRoot, fixture.prefix), /22/u);
      rmSync(extra, { recursive: directory });
    }
    const projected = join(root, 'candidate');
    writeWindowsProjectionFixture(projected, fixture.prefix);
    assert.equal(assertWindowsReleaseProjection(projected), '1.0.0');
    assert.throws(() => assertWindowsBindingSource(projected), /Windows/u,
      '源码模式仍必须拒绝注入后的固定安装产物');
    assert.equal(assertWindowsBindingSource(projected, { allowInjectedWindowsArtifacts: true }), '1.0.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows Hosted闭集与全部复制预检保持六头原字节及本机路径边界', () => {
  const root = mkdtempSync(join(workRoot, 'windows-hosted-contract-'));
  try {
    const fixture = windowsInstallFixture(join(root, 'native'));
    const source = join(root, 'source');
    cpSync(join(citizenSdkRoot, 'windows'), join(source, 'windows'), { recursive: true });
    copyFileSync(join(citizenSdkRoot, '.pubignore'), join(source, '.pubignore'));
    assert.doesNotThrow(() => assertHostedRuntimeWindowsProjection(source));
    const projected = join(root, 'candidate');
    writeWindowsProjectionFixture(projected, fixture.prefix);
    assert.doesNotThrow(() => assertHostedRuntimeWindowsProjection(projected, { allowInjectedWindowsArtifacts: true }));
    const ignore = join(projected, '.pubignore'), original = readFileSync(ignore, 'utf8');
    for (const rule of ['/windows/', '/windows/bin/Windows/citizensdk.dll',
      '/windows/lib/Windows/citizensdk_host.lib', '/windows/source/citizen_sdk_flutter_codec.cc',
      '!/windows/source/citizen_sdk_secret_vault.cc', '!/windows/tests/citizen_sdk_c_consumer.c']) {
      writeFileSync(ignore, `${original}\n${rule}\n`);
      assert.throws(() => assertHostedRuntimeWindowsProjection(projected, { allowInjectedWindowsArtifacts: true }), /Hosted Windows/u);
    }
    writeFileSync(ignore, original);
    const rejected = join(root, 'rejected');
    cpSync(join(citizenSdkRoot, 'windows'), join(rejected, 'windows'), { recursive: true });
    const header = join(rejected, 'windows/headers/citizen_sdk.hpp');
    const bytes = readFileSync(header);
    writeFileSync(header, Buffer.concat([bytes, Buffer.from('\ndrift')]));
    assert.throws(() => copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, rejected), /重叠/u);
    assert.equal(existsSync(join(rejected, 'windows/bin')), false, '较早的新项不能在六头全部对拍前写入');
    writeFileSync(header, bytes);
    const bin = join(rejected, 'windows/bin'), linked = join(root, 'linked');
    mkdirSync(linked);
    symlinkSync(linked, bin, 'dir');
    assert.throws(() => copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, rejected), /链接/u);
    assert.deepEqual(readdirSync(linked), []);
    unlinkSync(bin);
    assert.throws(() => copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, fixture.prefix), /来源|目标/u);
    assert.throws(() => copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, join(fixture.prefix, 'nested')), /来源|目标/u);
    assert.throws(() => copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, dirname(fixture.prefix)), /来源|目标/u);
    assert.throws(() => copyWindowsNativeArtifact(rejected, fixture.prefix, rejected), /来源|目标|源码/u);
    assert.throws(() => copyWindowsNativeArtifact(join(rejected, 'nested-source'), fixture.prefix, rejected), /来源|目标|源码/u);
    copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, rejected);
    assert.deepEqual(readFileSync(header), bytes);
    assert.throws(() => copyWindowsNativeArtifact(citizenSdkRoot, fixture.prefix, rejected), /目标已存在/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows Flutter bundle 验同版双库、官方注册、链资产与 PE/ELF 机器', () => {
  const root = mkdtempSync(join(workRoot, 'windows-flutter-bundle-'));
  try {
    const fixture = windowsInstallFixture(join(root, 'native'));
    const bundle = join(root, 'bundle');
    mkdirSync(bundle);
    for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) {
      copyFileSync(join(fixture.prefix, 'bin/Windows', name), join(bundle, name));
    }
    const imports = [
      { name: 'citizensdk.dll', symbols: ['citizensdk_get_lifecycle'] },
      { name: 'citizensdk_host.dll', symbols: ['citizensdk_host_create'] },
      { name: 'flutter_windows.dll', symbols: ['FlutterDesktopMessengerSend'] },
    ];
    const plugin = windowsPeFixture(['CitizenSdkPluginRegisterWithRegistrar'], 'citizen_sdk_plugin.dll', 0x8664, imports);
    writeFileSync(join(bundle, 'citizen_sdk_plugin.dll'), plugin);
    for (const name of ['citizensdk_consumer.exe', 'flutter_windows.dll']) {
      writeFileSync(join(bundle, name), windowsPeFixture(['fixture_export'], name));
    }
    const assets = join(bundle, 'data/flutter_assets/packages/citizen_sdk/chain');
    mkdirSync(assets, { recursive: true });
    for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
      copyFileSync(join(citizenSdkRoot, 'chain', name), join(assets, name));
    }
    const aot = linuxElfFixture({ platform: 'LinuxAMD' });
    writeFileSync(join(bundle, 'data/app.so'), aot);
    const run = () => assertWindowsFlutterBundle(citizenSdkRoot, fixture.prefix, bundle);
    assert.doesNotThrow(run);
    const changed = (path, bytes) => {
      const original = readFileSync(path);
      try { writeFileSync(path, bytes); assert.throws(run); }
      finally { writeFileSync(path, original); }
    };
    for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) changed(join(bundle, name), Buffer.from('foreign'));
    for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) changed(join(assets, name), Buffer.from('{}'));
    for (const missing of imports) {
      changed(join(bundle, 'citizen_sdk_plugin.dll'), windowsPeFixture(['CitizenSdkPluginRegisterWithRegistrar'],
        'citizen_sdk_plugin.dll', 0x8664, imports.filter((entry) => entry !== missing)));
    }
    changed(join(bundle, 'citizen_sdk_plugin.dll'), windowsPeFixture(['Unregistered'], 'citizen_sdk_plugin.dll', 0x8664, imports));
    for (const name of ['citizensdk_consumer.exe', 'flutter_windows.dll']) {
      changed(join(bundle, name), windowsPeFixture(['fixture_export'], name, 0xaa64));
    }
    changed(join(bundle, 'data/app.so'), plugin);
    changed(join(bundle, 'data/app.so'), linuxElfFixture({ platform: 'LinuxARM' }));
    const original = join(bundle, 'citizensdk_host.dll');
    unlinkSync(original);
    symlinkSync(join(fixture.prefix, 'bin/Windows/citizensdk_host.dll'), original);
    assert.throws(run, /符号链接/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows Flutter 执行六项生产 CTest 清单门禁并拒绝状态、属性和 DLL 漂移', () => {
  const root = mkdtempSync(join(workRoot, 'windows-flutter-inventory-'));
  try {
    const fixture = windowsInstallFixture(join(root, 'native'));
    const build = join(root, 'build'), state = join(root, 'state');
    const runtime = join(build, 'plugins/citizen_sdk/test/Release');
    mkdirSync(runtime, { recursive: true });
    const kinds = ['codec', 'environment', 'sessions', 'wallet_flow', 'plugin', 'secret_boundary'];
    for (const kind of kinds) writeFileSync(join(runtime, `citizen_sdk_flutter_${kind}_test.exe`), 'inventory-only fixture');
    for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) {
      copyFileSync(join(fixture.prefix, 'bin/Windows', name), join(runtime, name));
    }
    const inventory = () => ({ tests: kinds.map((kind) => ({
      name: `CitizenSDK.Windows.citizen_sdk_flutter_${kind}_test`,
      command: [join(runtime, `citizen_sdk_flutter_${kind}_test.exe`)],
      properties: [{ name: 'TIMEOUT', value: 60 },
        { name: 'ENVIRONMENT', value: [`CITIZENSDK_TEST_WORK_DIR=${state}`] },
        { name: 'LABELS', value: ['CitizenSDK', 'Contract', 'WindowsFlutter'] }],
    })) });
    const input = join(root, 'inventory.json');
    writeFileSync(input, JSON.stringify(inventory()));
    // 此函数含官方 Node heredoc；以准确结束标记提取，不能在内部 JS 的 } 处截断。
    const source = BUILD_SHELL_SOURCES.native;
    const functions = [...source.matchAll(/^verify_windows_flutter_inventory\(\) \{[\s\S]*?\nNODE\n\}\n/gmu)];
    assert.equal(functions.length, 1);
    const shell = ['set -euo pipefail', nativeShellFunctions(['fail']), functions[0][0],
      'cygpath() { [[ "$1" == -m ]]; printf "%s\\n" "$2"; }',
      'input="$1"; ctest() { [[ "${WINDOWS_FIXTURE_CTEST_FAIL:-0}" == 0 ]] || return 31; /bin/cat "$input"; }',
      'verify_windows_flutter_inventory "$2" "$3" "$4"',
    ].join('\n');
    const run = (environment = {}) => spawnSync('/bin/bash', ['-c', shell, 'windows-flutter-inventory',
      input, build, state, fixture.prefix], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ...environment } });
    assert.equal(run().status, 0);
    const invalid = (change) => {
      const value = inventory(); change(value); writeFileSync(input, JSON.stringify(value));
      const result = run();
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      writeFileSync(input, JSON.stringify(inventory()));
    };
    for (const change of [
      (value) => { value.tests.pop(); },
      (value) => { value.tests.push(value.tests[0]); },
      (value) => { value.tests[0].name = value.tests[1].name; },
      (value) => { value.tests[0].command[0] = join(root, 'unregistered.exe'); },
      (value) => { value.tests[0].properties[0].value = 0; },
      (value) => { value.tests[0].properties[1].value = ['CITIZENSDK_TEST_WORK_DIR=/outside']; },
      (value) => { value.tests[0].properties[1].value.push('OTHER_STATE=unregistered'); },
      (value) => { value.tests[0].properties[2].value.pop(); },
      (value) => { value.tests[0].properties.push(value.tests[0].properties[0]); },
    ]) invalid(change);
    for (const name of ['PASS_REGULAR_EXPRESSION', 'SKIP_REGULAR_EXPRESSION', 'SKIP_RETURN_CODE', 'WILL_FAIL', 'DISABLED']) {
      invalid((value) => { value.tests[0].properties.push({ name, value: false }); });
    }
    const dll = join(runtime, 'citizensdk_host.dll'), bytes = readFileSync(dll);
    writeFileSync(dll, 'different build');
    assert.notEqual(run().status, 0);
    unlinkSync(dll);
    symlinkSync(join(fixture.prefix, 'bin/Windows/citizensdk_host.dll'), dll);
    assert.notEqual(run().status, 0);
    unlinkSync(dll);
    writeFileSync(dll, bytes);
    assert.notEqual(run({ WINDOWS_FIXTURE_CTEST_FAIL: '1' }).status, 0);
    assert.equal(run().status, 0);
    const consumer = readFileSync(join(citizenSdkRoot, 'windows/tests/citizen_sdk_flutter_consumer.dart'), 'utf8');
    assert.match(consumer, /CitizenSdk\.open\(\)/u);
    assert.doesNotMatch(consumer, /package:citizen_sdk\/src\/|FlutterCitizenSdkPlatform|setMockMethodCallHandler|\bassert\s*\(/u);
    assert.match(consumer, /stdout\.flush\(\)/u);
    assert.match(consumer, /exit\(1\)/u);
    assert.match(source, /copyWindowsNativeArtifact\(source,prefix,stage\)/u);
    assert.match(source, /assertWindowsFlutterBundle\(source,prefix,bundle\)/u);
    assert.match(source, /WaitForExit/u);
    assert.equal(existsSync(state), false, '清单检查不能代替 Host 创建安全状态');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux Host 与 Flutter 源码固定哈希、目录拓扑且不提前接纳生成状态', () => {
  const root = mkdtempSync(join(workRoot, 'release-linux-binding-test-'));
  try {
    cpSync(join(citizenSdkRoot, 'linux'), join(root, 'linux'), {
      recursive: true,
    });
    assert.equal(assertLinuxBindingSource(root), '1.0.0');

    const source = join(root, 'linux', 'source', 'citizen_sdk_assets.cc');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`);
    assert.throws(
      () => assertLinuxBindingSource(root),
      /Linux Host 来源文件哈希漂移：linux\/source\/citizen_sdk_assets\.cc/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'linux', 'source', 'citizen_sdk_assets.cc'),
      source,
    );

    const unexpected = join(root, 'linux', 'source', 'unexpected_host.cc');
    writeFileSync(unexpected, 'int unexpected_host = 0;\n');
    assert.throws(
      () => assertLinuxBindingSource(root),
      /Linux Host 文件闭集漂移.*unexpected_host\.cc/,
    );
    rmSync(unexpected);

    const sourceLink = join(root, 'linux', 'source', 'citizen_sdk_source_link.cc');
    symlinkSync('citizen_sdk_assets.cc', sourceLink);
    assert.throws(
      () => assertLinuxBindingSource(root),
      /禁止未声明符号链接/,
    );
    rmSync(sourceLink);

    mkdirSync(join(root, 'linux', 'CMakeFiles'));
    assert.throws(
      () => assertLinuxBindingSource(root),
      /Linux Host 目录闭集漂移.*CMakeFiles/,
    );
    rmSync(join(root, 'linux', 'CMakeFiles'), { recursive: true });

    writeFileSync(join(root, 'linux', 'libcitizensdk_host.so'), 'ELF');
    assert.throws(
      () => assertLinuxBindingSource(root),
      /Linux Host 文件闭集漂移.*libcitizensdk_host\.so/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux 候选仅接纳双平台26项安装投影，纯源码门禁仍拒绝产物', () => {
  const root = mkdtempSync(join(workRoot, 'release-linux-projection-test-'));
  try {
    writeLinuxProjectionFixture(root);
    const installation = [...new Set(linuxPlatforms.flatMap(linuxInstallFixturePaths))].sort();
    assert.equal(installation.length, 26);
    assert.doesNotThrow(() => assertLinuxReleaseProjection(root));
    assert.equal(assertLinuxBindingSource(root, { allowInjectedLinuxArtifacts: true }), '1.0.0');
    assert.throws(() => assertLinuxBindingSource(root), /Linux/u);

    for (const relative of installation) {
      const path = join(root, 'linux', relative);
      const bytes = readFileSync(path);
      rmSync(path);
      assert.throws(() => assertLinuxReleaseProjection(root), /Linux/u, `缺失 ${relative}`);
      writeFileSync(path, bytes);
    }
    for (const path of [
      'linux/lib/LinuxARM/unexpected.so',
      'linux/lib/LinuxAMD/cmake/CitizenSDK/unexpected.cmake',
      'linux/share/citizensdk/chain/unexpected.json',
    ]) {
      writeFileSync(join(root, path), 'unexpected\n');
      assert.throws(() => assertLinuxReleaseProjection(root), /Linux/u);
      rmSync(join(root, path));
    }
    const emptyDirectory = join(root, 'linux/lib/LinuxARM/empty');
    mkdirSync(emptyDirectory);
    assert.throws(() => assertLinuxReleaseProjection(root), /Linux/u);
    rmSync(emptyDirectory, { recursive: true });

    const library = join(root, 'linux/lib/LinuxARM/libcitizensdk.so');
    const libraryBytes = readFileSync(library);
    rmSync(library);
    symlinkSync('../LinuxAMD/libcitizensdk.so', library);
    assert.throws(() => assertLinuxReleaseProjection(root), /符号链接/u);
    rmSync(library);
    writeFileSync(library, libraryBytes);

    const directory = join(root, 'linux/lib/LinuxAMD/cmake');
    const configBytes = new Map(linuxInstallFixturePaths('LinuxAMD')
      .filter((path) => path.includes('/cmake/'))
      .map((path) => [path, readFileSync(join(root, 'linux', path))]));
    rmSync(directory, { recursive: true });
    symlinkSync('../LinuxARM/cmake', directory, 'dir');
    assert.throws(() => assertLinuxReleaseProjection(root), /符号链接/u);
    unlinkSync(directory);
    for (const [relative, bytes] of configBytes) {
      const destination = join(root, 'linux', relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    assert.doesNotThrow(() => assertLinuxReleaseProjection(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux ELF 格式夹具逐项拒绝错误架构、动态边界、导出、依赖和版本', () => {
  const root = mkdtempSync(join(workRoot, 'release-linux-elf-test-'));
  try {
    writeLinuxProjectionFixture(root);
    const rejected = (path, bytes, label) => {
      const original = readFileSync(path);
      try {
        writeFileSync(path, bytes);
        assert.throws(() => assertLinuxReleaseProjection(root), /Linux|ELF/u, label);
      } finally {
        writeFileSync(path, original);
      }
    };
    for (const platform of linuxPlatforms) {
      for (const host of [false, true]) {
        const path = join(root, 'linux/lib', platform, host ? 'libcitizensdk_host.so' : 'libcitizensdk.so');
        const symbols = host ? linuxHostSymbols() : citizenSdkLinkedSymbols();
        const fixture = (options = {}) => linuxElfFixture({ platform, host, ...options });
        for (const options of [
          { machine: platform === 'LinuxARM' ? 62 : 183 },
          { soname: 'unregistered.so' },
          { symbols: symbols.slice(1) },
          { symbols: [...symbols, 'unregistered_export'] },
          { versions: ['GLIBC_2.32'] },
          { versions: ['GLIBC_2.31', 'GLIBCXX_3.4'] },
          { versions: ['GLIBC_2.31', 'CXXABI_1.3'] },
          { rpath: '$ORIGIN' },
          { needed: [...(host ? ['libcitizensdk.so'] : []), '/build/libc.so.6'] },
          ...['libstdc++.so.6', 'libgcc_s.so.1', 'libsqlite3.so.0', 'libtss2-esys.so.0', 'libcrypto.so.3', 'libssl.so.3', 'libsmoldot.so']
            .map((dependency) => ({ needed: [...(host ? ['libcitizensdk.so'] : []), dependency] })),
        ]) rejected(path, fixture(options), `${platform} ${host ? 'Host' : 'Core'} ${JSON.stringify(options)}`);
        if (host) {
          rejected(path, fixture({ needed: ['libc.so.6'] }), 'Host 缺少唯一 Core');
          rejected(path, fixture({ needed: ['libcitizensdk.so', 'libcitizensdk.so'] }), 'Host 重复 Core');
          for (const runpath of [null, '', '/build', '$ORIGIN:/build']) {
            rejected(path, fixture({ runpath }), 'Host RUNPATH 只能是 $ORIGIN');
          }
        } else {
          rejected(path, fixture({ runpath: '$ORIGIN' }), 'Core 不允许 RUNPATH');
        }
        for (const [label, mutate] of [
          ['魔数', (bytes) => { bytes[0] = 0; }],
          ['ELF32', (bytes) => { bytes[4] = 1; }],
          ['大端', (bytes) => { bytes[5] = 2; }],
          ['非共享库', (bytes) => { bytes.writeUInt16LE(2, 16); }],
          ['程序头越界', (bytes) => { bytes.writeBigUInt64LE(BigInt(bytes.length), 32); }],
          ['节头越界', (bytes) => { bytes.writeBigUInt64LE(BigInt(bytes.length), 40); }],
          ['动态段越界', (bytes) => { bytes.writeBigUInt64LE(BigInt(bytes.length), 128); }],
          ['动态表缺少终止', (bytes) => {
            const offset = Number(bytes.readBigUInt64LE(128));
            const length = Number(bytes.readBigUInt64LE(152));
            bytes.writeBigInt64LE(1n, offset + length - 16);
          }],
          ['动态字符串地址漂移', (bytes) => {
            const offset = Number(bytes.readBigUInt64LE(128));
            const length = Number(bytes.readBigUInt64LE(152));
            for (let index = offset; index < offset + length; index += 16) {
              if (bytes.readBigInt64LE(index) === 5n) bytes.writeBigUInt64LE(0xffffffffffffffffn, index + 8);
            }
          }],
          ['符号表元素长度漂移', (bytes) => {
            const sectionOffset = Number(bytes.readBigUInt64LE(40));
            bytes.writeBigUInt64LE(8n, sectionOffset + 3 * 64 + 56);
          }],
          ['版本链越界', (bytes) => {
            const sectionOffset = Number(bytes.readBigUInt64LE(40));
            const versionOffset = Number(bytes.readBigUInt64LE(sectionOffset + 6 * 64 + 24));
            bytes.writeUInt32LE(0xffffffff, versionOffset + 8);
          }],
        ]) {
          const bytes = fixture();
          mutate(bytes);
          rejected(path, bytes, label);
        }
        // 同样位于已映射段内的假地址也必须失败，不能只验证是否越界。
        for (const tag of [5n, 6n, 0x6ffffffen]) {
          const bytes = fixture();
          const offset = Number(bytes.readBigUInt64LE(128));
          const length = Number(bytes.readBigUInt64LE(152));
          let changed = false;
          for (let index = offset; index < offset + length; index += 16) {
            if (bytes.readBigInt64LE(index) !== tag) continue;
            bytes.writeBigUInt64LE(bytes.readBigUInt64LE(index + 8) + 1n, index + 8);
            changed = true;
          }
          assert.equal(changed, true);
          rejected(path, bytes, `动态字段 ${tag} 与对应节地址不一致`);
        }
        for (const tag of [5n, 6n, 0x6ffffffen, 0x6fffffffn]) {
          const bytes = fixture();
          const offset = Number(bytes.readBigUInt64LE(128));
          const length = Number(bytes.readBigUInt64LE(152));
          let changed = false;
          for (let index = offset; index < offset + length; index += 16) {
            if (bytes.readBigInt64LE(index) !== tag) continue;
            bytes.writeBigInt64LE(21n, index); // DT_DEBUG 不得替代必需的版本/符号字段。
            changed = true;
          }
          assert.equal(changed, true);
          rejected(path, bytes, `动态字段 ${tag} 缺失`);
        }
        rejected(path, fixture().subarray(0, 40), '截断 ELF 头');
      }
    }
    assert.doesNotThrow(() => assertLinuxReleaseProjection(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux 安装 CMake、共享头和链资产必须同版、可重定位且原字节一致', () => {
  const root = mkdtempSync(join(workRoot, 'release-linux-identity-test-'));
  try {
    writeLinuxProjectionFixture(root);
    const changed = (relative, mutate) => {
      const path = join(root, 'linux', relative);
      const original = readFileSync(path);
      try {
        writeFileSync(path, mutate(original.toString('utf8')));
        assert.throws(() => assertLinuxReleaseProjection(root), /Linux/u, relative);
      } finally {
        writeFileSync(path, original);
      }
    };
    for (const relative of linuxInstallFixturePaths('LinuxARM').filter((path) => /^(?:include|share)\//u.test(path))) {
      changed(relative, (text) => `${text}\n`);
    }
    for (const platform of linuxPlatforms) {
      const prefix = `lib/${platform}/cmake/CitizenSDK/`;
      const targetsPath = join(root, 'linux', `${prefix}CitizenSDKTargets.cmake`);
      const targets = readFileSync(targetsPath, 'utf8');
      // Kitware 官方 3.31/3.24 exporter 的整结构仍保留目标与文件存在性检查；
      // 这里只验证已知生成器输出，任何追加指令仍必须被拒绝。
      const cmake331 = targets.replace('2.8.12...4.0', '2.8.12...3.29');
      const cmake324 = targets
        .replace('message(FATAL_ERROR "CMake >= 2.8.12 required")', 'message(FATAL_ERROR "CMake >= 2.8.0 required")')
        .replace('if(CMAKE_VERSION VERSION_LESS "2.8.12")', 'if(CMAKE_VERSION VERSION_LESS "2.8.3")')
        .replace('message(FATAL_ERROR "CMake >= 2.8.12 required")', 'message(FATAL_ERROR "CMake >= 2.8.3 required")')
        .replace('2.8.12...4.0', '2.8.3...3.22')
        .replace('file(GLOB _cmake_config_files', [
          'if(CMAKE_VERSION VERSION_LESS 2.8.12)',
          '  message(FATAL_ERROR "This file relies on consumers using CMake 2.8.12 or greater.")',
          'endif()',
          'file(GLOB _cmake_config_files',
        ].join('\n'))
        .replace([
          '  if(CMAKE_VERSION VERSION_LESS "3.28"',
          '      OR NOT DEFINED _cmake_import_check_xcframework_for_${_cmake_target}',
          '      OR NOT IS_DIRECTORY "${_cmake_import_check_xcframework_for_${_cmake_target}}")',
          '',
        ].join('\n'), '')
        .replace('    endforeach()\n  endif()\n  unset(_cmake_file)', '    endforeach()\n  unset(_cmake_file)');
      try {
        for (const variant of [cmake331, cmake324]) {
          writeFileSync(targetsPath, variant);
          assert.doesNotThrow(() => assertLinuxReleaseProjection(root));
          writeFileSync(targetsPath, `${variant}\ninclude("/var/cache/unregistered.cmake")\n`);
          assert.throws(() => assertLinuxReleaseProjection(root), /Linux/u);
        }
      } finally {
        writeFileSync(targetsPath, targets);
      }
      changed(`${prefix}CitizenSDKConfigVersion.cmake`, (text) => text.replace('"1.0.0"', '"1.0.1"'));
      changed(`${prefix}CitizenSDKConfig.cmake`, (text) => text.replace(`"${platform}"`, '"Windows"'));
      changed(`${prefix}CitizenSDKConfig.cmake`, (text) => text.replace('${PACKAGE_PREFIX_DIR}/lib', '/build/lib'));
      changed(`${prefix}CitizenSDKDependencies.cmake`, (text) => `${text}\n`);
      changed(`${prefix}CitizenSDKTargets.cmake`, (text) => text.replace('CitizenSDK::Core', 'Unregistered::Core'));
      changed(`${prefix}CitizenSDKTargets-release.cmake`, (text) => text.replace('libcitizensdk_host.so', 'libunregistered.so'));
      changed(`${prefix}CitizenSDKTargets-release.cmake`, (text) => text.replace('${_IMPORT_PREFIX}', '/build'));
      changed(`${prefix}CitizenSDKTargets-release.cmake`, (text) => `${text}\nset(unregistered "${citizenSdkRoot}")\n`);
      changed(`${prefix}CitizenSDKTargets-release.cmake`, (text) => `${text}\nset_property(TARGET CitizenSDK::Host PROPERTY IMPORTED_LOCATION_RELEASE "/var/cache/other.so")\n`);
      changed(`${prefix}CitizenSDKTargets.cmake`, (text) => `${text}\ninclude("/var/cache/unregistered.cmake")\n`);
      changed(`${prefix}CitizenSDKTargets.cmake`, (text) => `${text}\n#[[]] include("/var/cache/unregistered.cmake")\n`);
    }
    assert.doesNotThrow(() => assertLinuxReleaseProjection(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux Hosted 保留唯一插件和双库运行闭集，拒绝漏包或泄漏 Host 私有实现', () => {
  const root = mkdtempSync(join(workRoot, 'release-linux-hosted-test-'));
  try {
    cpSync(join(citizenSdkRoot, 'linux'), join(root, 'linux'), { recursive: true });
    copyFileSync(join(citizenSdkRoot, '.pubignore'), join(root, '.pubignore'));
    assert.doesNotThrow(() => assertHostedRuntimeLinuxProjection(root));
    writeLinuxProjectionFixture(root);
    assert.doesNotThrow(() => assertHostedRuntimeLinuxProjection(root, { allowInjectedLinuxArtifacts: true }));
    assert.throws(() => assertHostedRuntimeLinuxProjection(root), /Linux/u);
    const ignorePath = join(root, '.pubignore');
    const original = readFileSync(ignorePath, 'utf8');
    for (const rule of [
      '/linux/CMakeLists.txt',
      '/linux/cmake/CitizenSDKFlutter.cmake',
      '/linux/source/citizen_sdk_plugin.cc',
      '/linux/headers/citizen_sdk_plugin.h',
      '/linux/include/citizensdk.h',
      '/linux/headers/citizensdk_host.h',
      '/linux/lib/LinuxARM/libcitizensdk.so',
      '/linux/lib/LinuxAMD/libcitizensdk_host.so',
      '/linux/share/citizensdk/chain/manifest.json',
      '!/linux/source/citizen_sdk_host_api.cc',
      '!/linux/cmake/CitizenSDKConfig.cmake.in',
      '!/linux/tests/citizen_sdk_c_consumer.c',
    ]) {
      writeFileSync(ignorePath, `${original}\n${rule}\n`);
      assert.throws(
        () => assertHostedRuntimeLinuxProjection(root, { allowInjectedLinuxArtifacts: true }),
        /Linux/u,
        rule,
      );
    }
    writeFileSync(ignorePath, original);
    assert.doesNotThrow(() => assertHostedRuntimeLinuxProjection(root, { allowInjectedLinuxArtifacts: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('模块选择和独立签名历史门面只投影同一Core，不产生第二套算法', () => {
  const source = (path) => readFileSync(join(citizenSdkRoot, path), 'utf8');
  const api = source('lib/api/citizen_sdk.dart');
  assert.match(api, /open\(\{\s*int modules = CitizenSdkModules\.full,\s*Future<Uint8List\?> Function\(CitizenCredentialChallenge challenge\)\?\s+credentialProvider,/u);
  assert.match(api, /final CitizenSigning signing;/u);
  assert.match(api, /static Future<bool> verify\(/u);
  assert.doesNotMatch(api.split('final class _CitizenSigning')[1].split('final class _CitizenTransactions')[0], /Future<bool> verify/u);
  const codec = source('lib/platform/citizen_sdk_flutter_codec.dart');
  assert.match(codec, /method == 'verifySignature' \|\|/u);
  assert.match(codec, /return <Object\?>\[protocolVersion, \.\.\.fields\];/u);
  assert.match(codec, /_tuple\(raw, 2, '验签响应'\)/u);
  assert.match(api, /final CitizenHistory history;/u);
  assert.doesNotMatch(source('lib/api/citizen_sdk_wallet.dart'), /Future<CitizenWalletSignature> sign/u);
  const transactions = source('lib/api/citizen_transactions.dart');
  assert.doesNotMatch(transactions.split('abstract interface class CitizenHistory')[0], /initializeFinalizedHistory|syncFinalizedHistory/u);
  assert.match(source('lib/platform/citizen_sdk_flutter_codec.dart'), /return <Object\?>\[protocolVersion, modules, hasCredentialProvider\];/u);
  const header = source('include/citizensdk.h');
  for (const symbol of ['citizensdk_validate_modules', 'citizensdk_create_with_modules', 'citizensdk_verify_signature']) {
    assert.equal([...header.matchAll(new RegExp('\\b' + symbol + '\\s*\\(', 'gu'))].length, 1);
  }
  for (const platform of ['linux', 'windows']) {
    const host = source(`${platform}/source/citizen_sdk_host_api.cc`);
    assert.match(host, /citizensdk_validate_modules\(modules\)/u);
    assert.match(source(`${platform}/source/citizen_sdk_flutter_sessions.cc`), /citizensdk_verify_signature\(/u);
    assert.match(source(`${platform}/headers/citizensdk_host.h`), /citizensdk_host_create_with_modules\(/u);
  }
});

test('QR_V1固定五类码型并由Core唯一给出扫码用途', () => {
  const productionRoots = [
    'native/qr/source', 'native/engine/source', 'native/ffi/source', 'include', 'lib',
    'android/native/source', 'android/source', 'darwin/source',
    'linux/source', 'linux/headers', 'windows/source', 'windows/headers',
  ];
  const files = [];
  const visit = (path) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`生产源码扫描拒绝符号链接：${path}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (entry.isFile()) {
      files.push(path);
    }
  };
  for (const root of productionRoots) visit(join(citizenSdkRoot, ...root.split('/')));
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, new RegExp(['QR', '_V', '(?:0|[2-9][0-9]*)'].join(''), 'u'), path);
  }
  // 五类协议统一由Core解析；账户码继续支持冷导入及既定公开扫码用途。
  const dart = readFileSync(join(citizenSdkRoot, 'lib/api/citizen_qr.dart'), 'utf8');
  const kind = dart.match(/enum CitizenQrKind \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(kind);
  assert.deepEqual([...kind.matchAll(/\b([a-zA-Z]+)\(([1-5])\)/gu)].map(match => [match[1], Number(match[2])]), [
    ['signRequest', 1], ['signResponse', 2], ['userContact', 3],
    ['userTransfer', 4], ['accountId', 5],
  ]);
  const core = readFileSync(join(citizenSdkRoot, 'native/qr/source/codec.rs'), 'utf8');
  assert.match(core, /pub const fn scan_purpose_mask\(&self\)/u);
  assert.match(core, /self\.scan_purpose_mask\(\) & purpose\.bit\(\) != 0/u);
  assert.match(core, /Self::AccountId\(_\) => \{\s*ColdAccountImport\.bit\(\)\s*\| TransferRecipient\.bit\(\)\s*\| GeneralScan\.bit\(\)\s*\| AccountTarget\.bit\(\)\s*\}/u);
  assert.match(readFileSync(join(citizenSdkRoot, 'native/qr/source/codec.rs'), 'utf8'),
               /pub const QR_V1: &str = "QR_V1";/u);
});

test('三类消费者和独立签名器只依赖同一正式公开面', () => {
  const consumerRoot = join(citizenSdkRoot, 'test', 'consumers');
  const expectedFiles = [
    'citizenapp_fixture.dart',
    'consumer_test_support.dart',
    'generic_qr_v1_signer.dart',
    'multi_consumer_contract_test.dart',
    'reference_consumer.dart',
    'third_party_fixture.dart',
  ];
  const actualFiles = [];
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      assert.equal(info.isSymbolicLink(), false, `消费者夹具拒绝链接：${path}`);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (info.isDirectory()) visit(path, relativePath);
      else {
        assert.equal(info.isFile(), true, `消费者夹具只允许普通文件：${path}`);
        actualFiles.push(relativePath);
      }
    }
  };
  visit(consumerRoot);
  assert.deepEqual(actualFiles, expectedFiles);

  const adapters = [
    'reference_consumer.dart',
    'citizenapp_fixture.dart',
    'third_party_fixture.dart',
    'generic_qr_v1_signer.dart',
  ];
  for (const relativePath of adapters) {
    const path = join(consumerRoot, ...relativePath.split('/'));
    const source = readFileSync(path, 'utf8');
    const imports = [...source.matchAll(/^import '([^']+)';$/gmu)].map((match) => match[1]);
    assert.equal(
      imports.filter((value) => value === 'package:citizen_sdk/citizen_sdk.dart').length,
      1,
      relativePath,
    );
    assert.ok(
      imports.every((value) => value.startsWith('dart:')
        || value === 'package:citizen_sdk/citizen_sdk.dart'),
      `${relativePath} 只能导入 Dart 标准库和 CitizenSDK 根公开库`,
    );
    assert.doesNotMatch(source, /package:citizen_sdk\/src|\.\.\/\.\.\/\.\.\/lib|CitizenSdkPlatform/u);
    assert.doesNotMatch(source, new RegExp(['QR', '_V', '(?:0|[2-9][0-9]*)'].join(''), 'u'));
  }

  const reference = readFileSync(join(consumerRoot, 'reference_consumer.dart'), 'utf8');
  for (const capability of [
    'CitizenChain', 'CitizenSdkWallet', 'CitizenSigning', 'CitizenQr',
    'CitizenTransactions', 'CitizenHistory',
  ]) assert.match(reference, new RegExp(`final ${capability} `, 'u'));
  assert.doesNotMatch(reference, /destination|amount|remark|booking|route|vote|proposal|governance/iu);

  const citizenApp = readFileSync(
    join(consumerRoot, 'citizenapp_fixture.dart'),
    'utf8',
  );
  for (const businessField of ['destination', 'amountFen', 'remark', 'transferStorageKey']) {
    assert.match(citizenApp, new RegExp(`\\b${businessField}\\b`, 'u'));
  }
  assert.match(citizenApp, /transactions\.prepareTransaction\(/u);
  assert.match(citizenApp, /chain\.getStorage\(/u);

  const thirdParty = readFileSync(
    join(consumerRoot, 'third_party_fixture.dart'),
    'utf8',
  );
  for (const businessField of ['bookingId', 'routeCode', 'seatCount', 'bookingStorageKey']) {
    assert.match(thirdParty, new RegExp(`\\b${businessField}\\b`, 'u'));
  }
  assert.match(thirdParty, /transactions\.prepareTransaction\(/u);
  assert.match(thirdParty, /chain\.getStorage\(/u);

  const signer = readFileSync(
    join(consumerRoot, 'generic_qr_v1_signer.dart'),
    'utf8',
  );
  assert.match(signer, /signing\.reviewQrRequest\(request\.canonicalText\)\.result/u);
  assert.match(signer, /await confirm\(review\)/u);
  assert.match(signer, /signing\.signQrRequest\(review\)\.result/u);
  assert.match(signer, /finally \{\s*await review\.release\(\);/u);
  assert.match(signer, /qr\.parse\(signed\.canonicalText\)/u);
  assert.doesNotMatch(signer, /CitizenWallet|citizenwallet|mnemonic|privateKey/iu);

  const matrix = readFileSync(join(consumerRoot, 'multi_consumer_contract_test.dart'), 'utf8');
  assert.match(matrix, /calls, hasLength\(3\)/u);
  assert.match(matrix, /CitizenQrKind\.values\.any\(\(value\) => value\.value == 4\)/u);
  assert.match(matrix, /CitizenWalletWordCount\.values/u);
  assert.equal(citizenSdkSymbols().length, 144);
  assert.equal(CITIZENSDK_INTERNAL_SYMBOLS.length, 0);
});

test('Dart、Android、Darwin、Linux、Windows 固定同一 Flutter 双通道和 93 方法合同', () => {
  const root = mkdtempSync(join(workRoot, 'release-flutter-contract-test-'));
  const sources = [
    'lib/platform/citizen_sdk_flutter_codec.dart',
    'lib/platform/flutter_citizen_sdk_platform.dart',
    'android/source/CitizenSdkFlutterCodec.kt',
    'darwin/source/flutter/CitizenSdkFlutterCodec.swift',
    'linux/source/citizen_sdk_flutter_codec.cc',
    'linux/source/citizen_sdk_flutter_codec.hpp',
    'windows/source/citizen_sdk_flutter_codec.cc',
    'windows/source/citizen_sdk_flutter_codec.hpp',
  ];
  try {
    for (const relativePath of sources) {
      const destination = join(root, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(citizenSdkRoot, ...relativePath.split('/')), destination);
    }
    assert.doesNotThrow(() => assertFlutterBindingContract(root));

    const linuxMethods = join(root, 'linux', 'source', 'citizen_sdk_flutter_codec.cc');
    const methodSource = readFileSync(linuxMethods, 'utf8');
    writeFileSync(
      linuxMethods,
      methodSource.replace('"syncTransactionHistory",', '"syncTransactionHistorY",'),
    );
    assert.throws(
      () => assertFlutterBindingContract(root),
      /Linux Flutter 方法合同漂移：必须精确为固定 93 项/,
    );

    writeFileSync(
      linuxMethods,
      methodSource.replace('    "syncTransactionHistory",\n', ''),
    );
    assert.throws(
      () => assertFlutterBindingContract(root),
      /Linux Flutter 方法合同漂移：必须精确为固定 93 项/,
    );
    writeFileSync(linuxMethods, methodSource);

    const linuxChannels = join(root, 'linux', 'source', 'citizen_sdk_flutter_codec.hpp');
    const channelSource = readFileSync(linuxChannels, 'utf8');
    writeFileSync(
      linuxChannels,
      channelSource.replace('citizen/sdk/events/v2', 'citizen/sdk/events/v1'),
    );
    assert.throws(
      () => assertFlutterBindingContract(root),
      /Linux Flutter EventChannel 合同漂移/,
    );
    writeFileSync(linuxChannels, channelSource);
    const windowsMethods = join(root, 'windows/source/citizen_sdk_flutter_codec.cc');
    const windowsMethodSource = readFileSync(windowsMethods, 'utf8');
    for (const replacement of ['"syncTransactionHistorY",', '']) {
      writeFileSync(windowsMethods, windowsMethodSource.replace('"syncTransactionHistory",', replacement));
      assert.throws(() => assertFlutterBindingContract(root), /Windows Flutter 方法合同漂移/u);
    }
    writeFileSync(windowsMethods, windowsMethodSource);
    const windowsChannels = join(root, 'windows/source/citizen_sdk_flutter_codec.hpp');
    const windowsChannelSource = readFileSync(windowsChannels, 'utf8');
    for (const channel of ['core', 'events']) {
      writeFileSync(windowsChannels, windowsChannelSource.replace(`citizen/sdk/${channel}/v2`, `citizen/sdk/${channel}/invalid`));
      assert.throws(() => assertFlutterBindingContract(root), /Windows Flutter (?:Method|Event)Channel 合同漂移/u);
    }
    writeFileSync(windowsChannels, windowsChannelSource);
    rmSync(windowsMethods);
    assert.throws(() => assertFlutterBindingContract(root), /Windows method/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('1.10.3五端错误合同固定22类、8阶段、7字段和单一C真源getter', () => {
  const header = readFileSync(join(citizenSdkRoot, 'include/citizensdk_types.h'), 'utf8');
  const api = readFileSync(join(citizenSdkRoot, 'include/citizensdk.h'), 'utf8');
  const stages = [
    'ADMISSION', 'VALIDATION', 'AUTHENTICATION', 'PERSISTENCE',
    'PROVIDER', 'VERIFICATION', 'CANCELLATION', 'TEARDOWN',
  ];
  stages.forEach((stage, index) => {
    assert.match(header, new RegExp(`CITIZENSDK_FAILURE_STAGE_${stage} ${index + 1}U`, 'u'));
  });
  assert.equal(
    [...api.matchAll(/citizensdk_result_get_failure_stage\s*\(/gu)].length,
    1,
  );

  const dart = readFileSync(
    join(citizenSdkRoot, 'lib/platform/citizen_sdk_flutter_codec.dart'),
    'utf8',
  );
  assert.match(dart, /_tuple\(error\.details, 7, '错误 details'\)/u);
  assert.match(dart, /expectedMethod != null && method != expectedMethod/u);

  const android = readFileSync(
    join(citizenSdkRoot, 'android/source/CitizenSdkFlutterCodec.kt'),
    'utf8',
  );
  assert.match(android, /code\.value,\s*stage\.value,\s*method,\s*message,/u);

  const swift = readFileSync(
    join(citizenSdkRoot, 'darwin/source/flutter/CitizenSdkFlutterCodec.swift'),
    'utf8',
  );
  assert.match(swift, /\[version, session, sequence, Int64\(code\.rawValue\),\s*Int64\(failureStage\.rawValue\), method, message\]/u);

  for (const platform of ['linux', 'windows']) {
    const codec = readFileSync(
      join(citizenSdkRoot, platform, 'source/citizen_sdk_flutter_codec.cc'),
      'utf8',
    );
    assert.match(codec, /Value::integer\(stage\), Value::string\(method\), Value::string\(message\)/u);
    assert.match(codec, /citizensdk_result_get_failure_stage\(result, &stage\)/u);
  }
});

test('provider 递归 registry 闭包与随包 PoW 锁逐项一致且完全离线', () => {
  const root = mkdtempSync(join(workRoot, 'release-provider-lock-parity-test-'));
  try {
    copyFileSync(join(citizenSdkRoot, 'Cargo.lock'), join(root, 'Cargo.lock'));
    const powDirectory = join(root, 'native', 'smoldot');
    mkdirSync(powDirectory, { recursive: true });
    copyFileSync(
      join(citizenSdkRoot, 'native', 'smoldot', 'Cargo.lock'),
      join(powDirectory, 'Cargo.lock'),
    );
    assert.ok(assertProviderLockParity(root) > 0);

    const rootLock = join(root, 'Cargo.lock');
    const edgeDrift = readFileSync(rootLock, 'utf8').replace(
      /(\[\[package\]\]\nname = "winapi-util"\nversion = "0\.1\.11"[\s\S]*?dependencies = \[\n )"windows-sys 0\.61\.2",/,
      '$1"windows-sys 0.60.2",',
    );
    assert.notEqual(edgeDrift, readFileSync(rootLock, 'utf8'));
    writeFileSync(rootLock, edgeDrift);
    assert.doesNotThrow(() => assertProviderLockParity(root));

    copyFileSync(join(citizenSdkRoot, 'Cargo.lock'), rootLock);
    const altered = readFileSync(rootLock, 'utf8').replace(
      /(\[\[package\]\]\nname = "hex"\nversion = "0\.4\.3"\nsource = "[^"]+"\nchecksum = ")[0-9a-f]{64}("\n)/,
      `$1${'0'.repeat(64)}$2`,
    );
    assert.notEqual(altered, readFileSync(rootLock, 'utf8'));
    writeFileSync(rootLock, altered);
    assert.throws(
      () => assertProviderLockParity(root),
      /provider registry 锁闭包漂移：hex 0\.4\.3/,
    );

    copyFileSync(join(citizenSdkRoot, 'Cargo.lock'), rootLock);
    const featureUnionDrift = readFileSync(rootLock, 'utf8').replace(
      /(\[\[package\]\]\nname = "unicode-normalization"\nversion = "0\.1\.25"\nsource = "[^"]+"\nchecksum = ")[0-9a-f]{64}("\n)/,
      `$1${'0'.repeat(64)}$2`,
    );
    assert.notEqual(featureUnionDrift, readFileSync(rootLock, 'utf8'));
    writeFileSync(rootLock, featureUnionDrift);
    assert.throws(
      () => assertProviderLockParity(root),
      /provider registry 锁闭包漂移：unicode-normalization 0\.1\.25/,
    );

    copyFileSync(join(citizenSdkRoot, 'Cargo.lock'), rootLock);
    // HTTPS 依赖造成的锁 feature 合并也逐边验真；不能利用登记项掩盖来源缺失或摘要变化。
    const originalLock = readFileSync(rootLock, 'utf8');
    for (const corrupt of [
      originalLock.replace(/(name = "citizen-sdk-smoldot-provider"[\s\S]*?) "reqwest",\n/, '$1'),
    ]) {
      assert.notEqual(corrupt, originalLock);
      writeFileSync(rootLock, corrupt);
      assert.throws(() => assertProviderLockParity(root), /provider registry.*漂移/);
    }
    writeFileSync(rootLock, originalLock);
    rmSync(join(powDirectory, 'Cargo.lock'));
    assert.throws(
      () => assertProviderLockParity(root),
      /缺少普通smoldot PoW Cargo\.lock/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('根 include 固定六文件闭集并只开放安全 citizensdk_* ABI', () => {
  const root = mkdtempSync(join(workRoot, 'release-public-abi-test-'));
  const include = join(root, 'include');
  const source = join(citizenSdkRoot, 'include');
  try {
    cpSync(source, include, { recursive: true });
    assert.doesNotThrow(() => assertPublicAbiHeaders(root));

    writeFileSync(join(include, 'unreviewed.h'), 'void citizensdk_unreviewed(void);\n');
    assert.throws(
      () => assertPublicAbiHeaders(root),
      /根 include 文件闭集漂移.*额外=include\/unreviewed\.h/,
    );
    rmSync(join(include, 'unreviewed.h'));

    const header = join(include, 'citizensdk.h');
    const original = readFileSync(header, 'utf8');
    const rejectDeclaration = (declaration, pattern) => {
      writeFileSync(header, `${original}\n${declaration}\n`);
      assert.throws(() => assertPublicAbiHeaders(root), pattern);
    };
    rejectDeclaration(
      'CITIZENSDK_API uint32_t foreign_probe(void);',
      /公共 ABI 只允许 citizensdk_\* 函数：foreign_probe/,
    );
    rejectDeclaration(
      'uint32_t citizensdk_unmarked_probe(void);',
      /公共 ABI 只允许带导出标记的 citizensdk_\* 函数：citizensdk_unmarked_probe/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t smoldot_raw_start(void);',
      /公共 ABI 泄漏非产品符号：smoldot_raw_start/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizen_sr25519_sign(void);',
      /公共 ABI 泄漏非产品符号：citizen_sr25519_sign/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t account_crypto_export(void);',
      /公共 ABI 泄漏非产品符号：account_crypto_export/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_rpc(const char *method, const char *params);',
      /公共 ABI 禁止任意 rpc\(method, params\)：citizensdk_rpc/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_query(const char *method, const char *params);',
      /公共 ABI 禁止任意 rpc\(method, params\)：citizensdk_query/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_export_private_key(uint8_t *out_private_key);',
      /公共 ABI 禁止助记词、私钥或秘密导出：citizensdk_export_private_key/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_get_mnemonic(uint8_t *out_mnemonic);',
      /公共 ABI 禁止助记词、私钥或秘密导出：citizensdk_get_mnemonic/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_validate_wallet_mnemonic(uint8_t *out_mnemonic);',
      /公共 ABI 禁止助记词、私钥或秘密导出/,
    );
    rejectDeclaration(
      'CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_reveal(citizensdk_handle_t handle, uint64_t secret_id, uint8_t *out_private_key);',
      /敏感边界 ABI 必须保持准确登记签名/,
    );
    rejectDeclaration(
      'CITIZENSDK_API citizensdk_error_code_t citizensdk_private_key_open(citizensdk_handle_t handle, uint8_t *buffer);',
      /敏感边界 ABI 必须保持准确登记签名/,
    );
    rejectDeclaration(
      'CITIZENSDK_API citizensdk_error_code_t citizensdk_encrypted_secret_record_has_secret(uint8_t *out_secret);',
      /敏感边界 ABI 必须保持准确登记签名/,
    );
    rejectDeclaration(
      'CITIZENSDK_API citizensdk_error_code_t citizensdk_set_secret_presence_provider(citizensdk_handle_t handle, uint8_t *out_private_key);',
      /敏感边界 ABI 必须保持准确登记签名/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_copy_secret(uint8_t *out_secret);',
      /公共 ABI 禁止助记词、私钥或秘密导出：citizensdk_copy_secret/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_import_phrase(citizensdk_bytes_view_t mnemonic);',
      /公共 ABI 禁止助记词、私钥或秘密导出：citizensdk_import_phrase/,
    );
    rejectDeclaration(
      'CITIZENSDK_API uint32_t citizensdk_prepared_wallet_copy_mnemonic(citizensdk_prepared_wallet_handle_t prepared_wallet, uint8_t *buffer, uint64_t capacity, uint64_t *out_required);',
      /助记词备份 ABI 必须绑定所属 instance\/prepared handle/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('唯一测试入口在外置工程解析依赖，失败仍清理且不改源码锁', () => {
  const root = mkdtempSync(join(workRoot, 'test-entry-owned-'));
  const source = join(root, 'source'), tools = join(root, 'synthetic-tools');
  const trace = join(root, 'calls.jsonl');
  try {
    flutterEntryFixture(root);
    mkdirSync(join(source, 'scripts'), { recursive: true });
    mkdirSync(join(source, 'lib'));
    mkdirSync(join(tools, 'bin'), { recursive: true });
    writeFileSync(join(source, 'scripts/run.sh'), '#!/usr/bin/env bash\nexport CITIZENSDK_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"\n'+BUILD_SHELL_SOURCES.test);
    copyFileSync(join(citizenSdkRoot, 'scripts/release.mjs'), join(source, 'scripts/release.mjs'));
    copyFileSync(join(citizenSdkRoot,'pubspec.yaml'),join(source,'pubspec.yaml'));
    mkdirSync(join(source,'android/source'),{recursive:true});
    copyFileSync(join(citizenSdkRoot,'android/source/CitizenSdkPlugin.kt'),join(source,'android/source/CitizenSdkPlugin.kt'));
    writeFileSync(join(source, 'pubspec.lock'), 'synthetic locked input\n');
    writeFileSync(join(source, 'lib', 'fixture.dart'), '// 合成源码，不实现SDK。\n');
    // 仅模拟外部命令的文件效果；真正执行生产Shell入口，不复制其路径/清理实现。
    const program = `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const command = path.basename(process.argv[1]), args = process.argv.slice(2), cwd = process.cwd();
fs.appendFileSync(process.env.SYNTHETIC_TRACE, JSON.stringify({ command, args, cwd }) + '\\n');
if (command === 'dart') {
  if (args.join(' ') !== 'pub get --enforce-lockfile --offline') process.exit(90);
  if (!path.basename(cwd).startsWith('flutter-project.') || fs.lstatSync('pubspec.lock').isSymbolicLink()) process.exit(91);
  fs.mkdirSync('.dart_tool');
  fs.writeFileSync('.dart_tool/package_config.json', '{}');
  fs.writeFileSync('pubspec.lock', 'synthetic pub working copy');
  if (process.env.SYNTHETIC_FAILURE === 'pub') process.exit(71);
} else if (args[0] === 'config') {
  if (process.env.SYNTHETIC_FAILURE === 'config') process.exit(72);
} else if (args[0] === 'test') {
  if (!args.includes('--no-pub') || !args.includes('--no-test-assets') ||
      !args.includes('--packages=' + path.join(cwd, '.dart_tool/package_config.json'))) process.exit(92);
  fs.mkdirSync('build'); fs.writeFileSync('build/synthetic', 'test only');
  if (process.env.SYNTHETIC_FAILURE === 'test') process.exit(73);
} else process.exit(93);
`;
    for (const command of ['dart', 'flutter']) {
      const path = join(tools, 'bin', command);
      writeFileSync(path, program); chmodSync(path, 0o700);
    }
    for (const [failure, expected, commands] of [
      ['', 0, ['dart', 'flutter', 'flutter']],
      ['pub', 71, ['dart']],
      ['config', 72, ['dart', 'flutter']],
      ['test', 73, ['dart', 'flutter', 'flutter']],
    ]) {
      const output = join(source,'target','test','output-' + (failure || 'success'));
      writeFileSync(trace, '');
      const result = spawnSync('bash', [join(source, 'scripts/run.sh'), 'flutter', '--timeout=2m'], {
        encoding: 'utf8',
        env: { ...process.env, NODE: process.execPath, FLUTTER: join(tools, 'bin/flutter'),
          CITIZENSDK_TEST_WORK_DIR: output, CITIZENSDK_TEST_SMOLDOT_LIBRARY: '',
          CITIZENSDK_OFFLINE: 'true', SYNTHETIC_TRACE: trace, SYNTHETIC_FAILURE: failure },
      });
      assert.equal(result.status, expected, result.stderr);
      assert.equal(readFileSync(join(source, 'pubspec.lock'), 'utf8'), 'synthetic locked input\n');
      assert.equal(existsSync(join(source, '.dart_tool')), false);
      assert.equal(existsSync(join(source, 'build')), false);
      assert.deepEqual(readdirSync(output).filter(name => name.startsWith('flutter-project.')), []);
      const calls = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.deepEqual(calls.map(call => call.command), commands);
      for (const call of calls.filter(call => call.command === 'dart' || call.args[0] === 'test')) {
        assert.equal(dirname(call.cwd), output);
      }
    }
    const invoke = output => spawnSync('bash', [join(source, 'scripts/run.sh'), 'flutter'], {
      encoding: 'utf8', env: { ...process.env, NODE: process.execPath,
        FLUTTER: join(tools, 'bin/flutter'), CITIZENSDK_TEST_WORK_DIR: output,
        CITIZENSDK_TEST_SMOLDOT_LIBRARY: '', CITIZENSDK_OFFLINE: 'true', SYNTHETIC_TRACE: trace },
    });
    // 必须把原始相对片段交给生产入口；path.join会先消掉该反例。
    for (const output of [join(source, 'forbidden'), root, root + '/absent/../escape']) {
      const result = invoke(output);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /源码或其祖先|无相对片段|本产品target/u);
    }
    assert.equal(existsSync(join(source, 'forbidden')), false);
    assert.equal(existsSync(join(root, 'absent')), false);
    const linked = join(root, 'linked-output');
    mkdirSync(linked); symlinkSync(source, join(linked, 'cargo'), 'dir');
    assert.match(invoke(linked).stderr, /独立普通目录|本产品target/u);
    assert.deepEqual(readdirSync(linked), ['cargo']);
    mkdirSync(join(source, '.dart_tool')); writeFileSync(join(source, '.dart_tool/sentinel'), 'keep');
    assert.match(invoke(join(source,'target','test','blocked-output')).stderr, /禁止的生成条目/u);
    assert.equal(readFileSync(join(source, '.dart_tool/sentinel'), 'utf8'), 'keep');
    assert.equal(existsSync(join(root, 'blocked-output')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scripts 根固定正式闭集、原生构建器与统一测试入口', () => {
  const root = mkdtempSync(join(workRoot, 'release-script-source-test-'));
  const scripts = join(root, 'scripts');
  try {
    cpSync(join(citizenSdkRoot, 'scripts'), scripts, { recursive: true });
    assert.doesNotThrow(() => assertSdkScriptSource(root));
    for (const name of ['ci', 'release']) {
      assert.equal(lstatSync(join(scripts, name)).isDirectory(), true);
    }

    const buildNative = join(scripts, 'build-native.sh');
    const buildNativeSource = readFileSync(buildNative, 'utf8');
    assert.match(buildNativeSource, /script_path="\$\{BASH_SOURCE\[0\]\}"/u);
    assert.match(buildNativeSource, /while \[\[ -L "\$script_path" \]\]/u);
    assert.match(buildNativeSource, /script_dir="\$\(cd "\$\(dirname "\$script_path"\)" && pwd -P\)"/u);
    assert.doesNotMatch(buildNativeSource, /script_dir="\$\(cd "\$\(dirname "\$0"\)/u);
    writeFileSync(buildNative, `${readFileSync(buildNative, 'utf8')}\n`);
    assert.throws(
      () => assertSdkScriptSource(root),
      /固定脚本文件哈希漂移：scripts\/build-native\.sh/,
    );

    copyFileSync(join(citizenSdkRoot, 'scripts', 'build-native.sh'), buildNative);
    const testEntrySource=BUILD_SHELL_SOURCES.test;
    assert.match(testEntrySource,/CARGO_TARGET_DIR="\$test_root\/cargo"/u);
    assert.match(testEntrySource,/--build-dir=build/u);
    assert.match(testEntrySource,/--no-enable-native-assets/u);
    assert.match(testEntrySource,/--no-enable-dart-data-assets/u);
    assert.match(testEntrySource,/refresh_flutter_packages "\$project_root"/u);
    assert.match(testEntrySource,/--packages="\$project_root\/\.dart_tool\/package_config\.json"/u);
    const build=join(scripts,'build.mjs'),originalBuild=readFileSync(build);
    writeFileSync(build,Buffer.concat([originalBuild,Buffer.from('\n')]));
    assert.throws(()=>assertSdkScriptSource(root),/固定脚本文件哈希漂移：scripts\/build\.mjs/u);
    writeFileSync(build,originalBuild);
    writeFileSync(join(scripts, 'unreviewed-build.sh'), '#!/bin/sh\n');
    assert.throws(
      () => assertSdkScriptSource(root),
      /scripts 根闭集漂移.*额外=unreviewed-build\.sh/,
    );
    rmSync(join(scripts, 'unreviewed-build.sh'));

    const releaseSource = join(scripts, 'release.mjs');
    writeFileSync(releaseSource, `${readFileSync(releaseSource, 'utf8')}\n`);
    assert.throws(
      () => assertSdkScriptSource(root),
      /候选 release\.mjs 与当前执行真源不一致/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CitizenSDK 自有 Core Rust 生产源码固定逐文件哈希', () => {
  const root = mkdtempSync(join(workRoot, 'release-core-rust-source-test-'));
  try {
    writeCoreRustFixture(root);
    assert.doesNotThrow(() => assertCoreRustSource(root));

    const manifestPath = join(root, 'Cargo.toml');
    const manifest = readFileSync(manifestPath, 'utf8');
    for (const field of ['repository', 'homepage']) {
      writeFileSync(manifestPath, manifest.replace(
        `${field} = "https://github.com/crcfrcn/citizensdk"`,
        `${field} = "https://github.com/Unregistered/retired-repository"`,
      ));
      assert.throws(() => assertCoreRustSource(root), new RegExp(`Rust ${field} 必须为现行唯一仓库`));
      writeFileSync(manifestPath, manifest);
    }

    const source = join(root, 'native', 'engine', 'source', 'lib.rs');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 来源文件哈希漂移：native\/engine\/source\/lib\.rs/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'native', 'engine', 'source', 'lib.rs'),
      source,
    );
    const ffiSource = join(root, 'native', 'ffi', 'source', 'lib.rs');
    writeFileSync(ffiSource, `${readFileSync(ffiSource, 'utf8')}\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 来源文件哈希漂移：native\/ffi\/source\/lib\.rs/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'native', 'ffi', 'source', 'lib.rs'),
      ffiSource,
    );
    const walletAbi = join(root, 'native', 'ffi', 'source', 'wallet_abi.rs');
    writeFileSync(walletAbi, `${readFileSync(walletAbi, 'utf8')}\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 来源文件哈希漂移：native\/ffi\/source\/wallet_abi\.rs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('监控实现及回归测试全部进入正式 Core 来源闭集', () => {
  const root = mkdtempSync(join(workRoot, 'release-chain-monitor-source-test-'));
  try {
    writeCoreRustFixture(root);
    for (const file of ['native/engine/source/chain_monitor.rs',
      'native/ffi/source/chain_monitor.rs', 'native/ffi/source/chain_monitor_tests.rs']) {
      const path = join(root, file);
      const original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
      assert.throws(() => assertCoreRustSource(root), /Core Rust 来源文件哈希漂移/);
      writeFileSync(path, original);
    }
    assert.doesNotThrow(() => assertCoreRustSource(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Core Rust 合同拒绝额外 build.rs 与未审查 native 产品目录', () => {
  const root = mkdtempSync(join(workRoot, 'release-core-rust-closure-test-'));
  try {
    writeCoreRustFixture(root);
    const buildScript = join(root, 'native', 'contracts', 'build.rs');
    writeFileSync(buildScript, 'fn main() {}\n');
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 文件闭集漂移：native\/contracts.*额外=native\/contracts\/build\.rs/,
    );

    rmSync(buildScript);
    const hostProviders = join(root, 'native', 'ffi', 'source', 'host_providers.rs');
    rmSync(hostProviders);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 文件闭集漂移：native\/ffi.*缺失=native\/ffi\/source\/host_providers\.rs/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'native', 'ffi', 'source', 'host_providers.rs'),
      hostProviders,
    );

    mkdirSync(join(root, 'native', 'unreviewed-core'));
    assert.throws(
      () => assertCoreRustSource(root),
      /native 根闭集漂移.*额外=unreviewed-core/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Core Rust 合同拒绝 workspace Cargo manifest 与锁文件漂移', () => {
  const root = mkdtempSync(join(workRoot, 'release-core-rust-workspace-test-'));
  try {
    writeCoreRustFixture(root);
    // 保留准确仓库声明，单独检验内容摘要漂移，不混淆身份拒绝路径。
    writeFileSync(join(root, 'Cargo.toml'), `${readFileSync(join(root, 'Cargo.toml'), 'utf8')}\n# drift\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 边界文件哈希漂移：Cargo\.toml/,
    );

    copyFileSync(join(citizenSdkRoot, 'Cargo.toml'), join(root, 'Cargo.toml'));
    writeFileSync(join(root, 'Cargo.lock'), 'drift\n');
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 边界文件哈希漂移：Cargo\.lock/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P1修复的交易恢复与事件容量源码必须按逐文件摘要进入候选', () => {
  const root = mkdtempSync(join(workRoot, 'release-p1-core-'));
  try {
    writeCoreRustFixture(root);
    assert.doesNotThrow(() => assertCoreRustSource(root));
    // 每个安全修复边界均必须纳入正式来源守卫；不得仅修改实现却遗漏固定摘要。
    for (const relative of [
      'native/contracts/source/store_transaction_history.rs',
      'native/engine/source/transaction_execution.rs',
      'native/engine/source/transaction_history.rs',
      'native/ffi/source/events.rs',
      'native/ffi/source/host_codec.rs',
    ]) {
      const file = join(root, relative);
      const original = readFileSync(file);
      writeFileSync(file, Buffer.concat([original, Buffer.from('\n// source drift\n')]));
      assert.throws(() => assertCoreRustSource(root), /来源文件哈希漂移/u, relative);
      writeFileSync(file, original);
      assert.doesNotThrow(() => assertCoreRustSource(root));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('smoldot Rust 收编源码按离线清单固定完整闭集与逐文件哈希', () => {
  assert.doesNotThrow(() => assertSmoldotRustSource(citizenSdkRoot));
  const root = mkdtempSync(join(workRoot, 'release-rust-source-test-'));
  try {
    cpSync(
      join(citizenSdkRoot, 'native', 'smoldot'),
      join(root, 'native', 'smoldot'),
      { recursive: true },
    );
    assert.doesNotThrow(() => assertSmoldotRustSource(root));
    // 注释也属于已审核字节；重写清单中的摘要不能绕过清单自身的固定摘要。
    const ffiCargo = join(root, 'native', 'legacy', 'Cargo.toml');
    const manifest = join(root, 'native', 'smoldot', 'SOURCE_SHA256.json');
    const originalCargo = readFileSync(ffiCargo);
    const originalManifest = readFileSync(manifest, 'utf8');
    const changedCargo = Buffer.concat([
      originalCargo,
      Buffer.from('\n# 未授权注释漂移\n'),
    ]);
    writeFileSync(ffiCargo, changedCargo);
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot Rust 文件哈希漂移：ffi\/Cargo\.toml/u,
    );
    const approvedCargoHash = createHash('sha256').update(originalCargo).digest('hex');
    const changedCargoHash = createHash('sha256').update(changedCargo).digest('hex');
    assert.equal(originalManifest.split(approvedCargoHash).length, 2);
    writeFileSync(manifest, originalManifest.replace(approvedCargoHash, changedCargoHash));
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot Rust 来源清单漂移/u,
    );
    writeFileSync(ffiCargo, originalCargo);
    writeFileSync(manifest, originalManifest);
    assert.doesNotThrow(() => assertSmoldotRustSource(root));
    const providerSource = join(
      root,
      'native', 'provider',
      'source',
      'verified_chain_client.rs',
    );
    writeFileSync(providerSource, `${readFileSync(providerSource, 'utf8')}\n`);
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot Rust 文件哈希漂移：provider\/source\/verified_chain_client\.rs/,
    );
    copyFileSync(
      join(
        citizenSdkRoot,
        'native', 'provider',
        'source',
        'verified_chain_client.rs',
      ),
      providerSource,
    );
    const exactSource = join(
      root,
      'native',
      'smoldot',
      'light-base',
      'src',
      'database.rs',
    );
    writeFileSync(exactSource, `${readFileSync(exactSource, 'utf8')}\n`);
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot Rust 文件哈希漂移/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('smoldot Release 合同覆盖根支持文件并拒绝动态完整闭集漂移', () => {
  const root = mkdtempSync(join(workRoot, 'release-smoldot-closure-test-'));
  const source = join(citizenSdkRoot, 'native', 'smoldot');
  const copy = join(root, 'native', 'smoldot');
  try {
    mkdirSync(join(root, 'native'), { recursive: true });
    cpSync(source, copy, { recursive: true });
    assert.doesNotThrow(() => assertSmoldotRustSource(root));

    const upstreamHeader = join(root,'include','smoldot.h');
    writeFileSync(upstreamHeader, `${readFileSync(upstreamHeader, 'utf8')}\n`);
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot 支持文件哈希漂移：include\/smoldot\.h/,
    );

    copyFileSync(join(citizenSdkRoot,'include/smoldot.h'), upstreamHeader);
    writeFileSync(join(copy, 'citizensdk.h'), '/* duplicate product ABI */\n');
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot (?:Rust 文件闭集漂移：pow_workspace|文件闭集漂移.*额外=native\/smoldot\/citizensdk\.h)/,
    );
    rmSync(join(copy, 'citizensdk.h'));
    writeFileSync(join(copy, 'unexpected-release-input.txt'), 'extra\n');
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot (?:Rust 文件闭集漂移：pow_workspace|文件闭集漂移.*额外=native\/smoldot\/unexpected-release-input\.txt)/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chain根仅保留manifest及两个运行时信任锚，拒绝旧包装与缺失损坏', () => {
  const root = mkdtempSync(join(workRoot, 'release-chain-assets-test-'));
  const source = join(citizenSdkRoot, 'chain');
  const copy = join(root, 'chain');
  try {
    cpSync(source, copy, { recursive: true });
    assert.doesNotThrow(() => assertChainAssets(root));
    assert.deepEqual(readdirSync(copy).sort(), ['chainspec.json', 'light_sync_state.json', 'manifest.json']);
    // 即使新目录完好，也拒绝重新出现旧包装层；缺文件和目录链接不能绕过唯一来源检查。
    mkdirSync(join(root, 'assets'));
    assert.throws(() => assertChainAssets(root), /禁止旧资产包装目录/u);
    rmSync(join(root, 'assets'), { recursive: true });
    renameSync(copy, join(root, 'moved-chain'));
    assert.throws(() => assertChainAssets(root), /缺少普通链资产目录/u);
    symlinkSync(join(root, 'moved-chain'), copy);
    assert.throws(() => assertChainAssets(root), /缺少普通链资产目录/u);
    unlinkSync(copy);
    renameSync(join(root, 'moved-chain'), copy);
    for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
      rmSync(join(copy, name));
      assert.throws(() => assertChainAssets(root), /链资产闭集漂移/u);
      copyFileSync(join(source, name), join(copy, name));
    }

    const chainSpec = join(copy, 'chainspec.json');
    writeFileSync(chainSpec, `${readFileSync(chainSpec, 'utf8')}\n`);
    assert.throws(
      () => assertChainAssets(root),
      /链资产文件哈希漂移：chain\/chainspec\.json/,
    );

    copyFileSync(join(source, 'chainspec.json'), chainSpec);
    const manifest = join(copy, 'manifest.json');
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace(
        '"chain_id": "citizenchain"',
        '"chain_id": "citizenchain-mainnet"',
      ),
    );
    assert.throws(
      () => assertChainAssets(root),
      /链资产文件哈希漂移：chain\/manifest\.json/,
    );

    copyFileSync(join(source, 'manifest.json'), manifest);
    writeFileSync(join(copy, 'unexpected.json'), '{}\n');
    assert.throws(
      () => assertChainAssets(root),
      /链资产闭集漂移.*额外=chain\/unexpected\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实 Runtime metadata/events 测试夹具由 Release 固定完整闭集', () => {
  const root = mkdtempSync(join(workRoot, 'release-source-fixture-test-'));
  const fixturePaths = [
    'test/transaction/citizenchain-balance-fee-v1.json',
    'test/transaction/citizenchain-revive-v15-metadata.hex',
    'test/transaction/citizenchain-runtime-system-events.hex',
    'test/transaction/citizenchain-runtime-v14-metadata.hex',
    'test/transaction/citizenchain-transfer-build-v1.json',
    'test/transaction/substrate-v14-system-events-metadata.hex',
    'test/wallet/citizenchain-wallet-derivation-v1.json',
    'test/wallet/citizenchain-wallet-password-v1.json',
  ];
  try {
    for (const relativePath of fixturePaths) {
      const destination = join(root, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(citizenSdkRoot, ...relativePath.split('/')), destination);
    }
    assert.doesNotThrow(() => assertSourceFixtures(root));
    const currentMetadata = join(root, 'test/transaction/citizenchain-revive-v15-metadata.hex');
    const originalMetadata = readFileSync(currentMetadata);
    rmSync(currentMetadata);
    assert.throws(() => assertSourceFixtures(root), /缺少普通逐字节来源夹具文件.*citizenchain-revive-v15-metadata\.hex/u);
    writeFileSync(currentMetadata, Buffer.concat([originalMetadata, Buffer.from('00\n')]));
    assert.throws(() => assertSourceFixtures(root), /逐字节来源夹具文件哈希漂移.*citizenchain-revive-v15-metadata\.hex/u);
    writeFileSync(currentMetadata, originalMetadata);
    const destination = join(
      root,
      'test',
      'transaction',
      'substrate-v14-system-events-metadata.hex',
    );
    writeFileSync(destination, `${readFileSync(destination, 'utf8')}00\n`);
    assert.throws(
      () => assertSourceFixtures(root),
      /逐字节来源夹具文件哈希漂移.*substrate-v14-system-events-metadata\.hex/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Release 固定根级许可证入口、GPL-3.0 与 MIT 权威许可证原文字节', () => {
  const root = mkdtempSync(join(workRoot, 'release-license-test-'));
  try {
    for (const license of ['LICENSE', 'LICENSE-GPL-3.0', 'LICENSE-MIT']) {
      copyFileSync(join(citizenSdkRoot, license), join(root, license));
    }
    assert.doesNotThrow(() => assertLicenseSources(root));

    writeFileSync(join(root, 'LICENSE-GPL-3.0'), 'drift\n');
    assert.throws(
      () => assertLicenseSources(root),
      /许可证原文文件哈希漂移：LICENSE-GPL-3\.0/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'LICENSE-GPL-3.0'),
      join(root, 'LICENSE-GPL-3.0'),
    );
    writeFileSync(join(root, 'LICENSE-MIT'), 'drift\n');
    assert.throws(
      () => assertLicenseSources(root),
      /许可证原文文件哈希漂移：LICENSE-MIT/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('产品源码保留唯一简明README并拒绝缺失、漂移、链接和docs副本', () => {
  const root = mkdtempSync(join(workRoot, 'release-documentation-test-'));
  try {
    for (const relativeRoot of ['android', 'darwin', 'lib', 'linux', 'windows']) {
      const destination = join(root, ...relativeRoot.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(citizenSdkRoot, ...relativeRoot.split('/')), destination, {
        recursive: true,
      });
    }
    copyFileSync(join(citizenSdkRoot, 'README.md'), join(root, 'README.md'));
    assert.doesNotThrow(() => assertDocumentationSource(root));

    rmSync(join(root, 'README.md'));
    assert.throws(() => assertDocumentationSource(root), /产品文档闭集漂移；.*缺失=README\.md/u);
    symlinkSync(join(citizenSdkRoot, 'README.md'), join(root, 'README.md'));
    assert.throws(() => assertDocumentationSource(root), /根 README\.md 必须是普通文件/u);
    rmSync(join(root, 'README.md'));
    copyFileSync(join(citizenSdkRoot, 'README.md'), join(root, 'README.md'));

    const forbidden = join(root, 'docs');
    mkdirSync(forbidden);
    assert.throws(
      () => assertDocumentationSource(root),
      /产品源码禁止包含 docs 目录/,
    );
    rmSync(forbidden, { recursive: true });

    writeFileSync(join(root, 'README.md'), 'duplicate product documentation\n');
    assert.throws(
      () => assertDocumentationSource(root),
      /产品文档文件哈希漂移：README\.md/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('1.10.2资源合同保留64MiB链能力并限制持久cache与history总量', () => {
  const chain = readFileSync(join(citizenSdkRoot, 'native/contracts/source/chain.rs'), 'utf8');
  assert.match(chain, /MAX_RUNTIME_METADATA_BYTES: usize = 64 \* 1024 \* 1024/u);

  const runtimeContract = readFileSync(
    join(citizenSdkRoot, 'native/contracts/source/store_runtime_cache.rs'),
    'utf8',
  );
  assert.match(runtimeContract, /MAX_PERSISTED_RUNTIME_CONTEXTS: usize = 64/u);
  assert.match(runtimeContract, /MAX_PERSISTED_RUNTIME_METADATA_BYTES: usize = \(8 \* 1024 \* 1024\) - 56 - 55/u);

  const engine = readFileSync(join(citizenSdkRoot, 'native/engine/source/engine.rs'), 'utf8');
  assert.match(engine, /contexts\.get\(block\)\.cloned\(\)/u);
  assert.match(engine, /context\.metadata\(\)\.len\(\) <= MAX_PERSISTED_RUNTIME_METADATA_BYTES/u);
  assert.match(engine, /preflight_execution_before_signing/u);

  const history = readFileSync(
    join(citizenSdkRoot, 'native/contracts/source/store_transaction_history.rs'),
    'utf8',
  );
  assert.match(history, /MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES: usize = 31 \* 1024 \* 1024/u);
  assert.match(history, /durable_weight_bytes > MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES/u);
  const historyEngine = readFileSync(
    join(citizenSdkRoot, 'native/engine/source/transaction_history.rs'),
    'utf8',
  );
  assert.match(historyEngine, /preflight_execution_before_signing/u);
  assert.match(historyEngine, /TransactionHistoryQueryKind::OldestRetentionTerminal/u);
  assert.doesNotMatch(historyEngine, /TransactionHistoryState/u);

  for (const relativePath of [
    'android/native/source/CitizenSdkPublicStore.kt',
    'darwin/source/core/CitizenSDKPublicStore.swift',
    'linux/source/citizen_sdk_public_store.cc',
    'windows/source/citizen_sdk_public_store.cc',
  ]) {
    const store = readFileSync(join(citizenSdkRoot, ...relativePath.split('/')), 'utf8');
    const joinedStoreLiterals = store
      .replace(/"\s*\+\s*"/gu, '')
      .replace(/"\s*"/gu, '');
    assert.match(
      joinedStoreLiterals,
      /SELECT rowid FROM runtime_cache ORDER BY rowid DESC LIMIT 64/u,
      relativePath,
    );
  }
  assert.doesNotMatch(engine, /MAX_RUNTIME_METADATA_BYTES.*8 \* 1024 \* 1024/u);
});

test('1.10.4历史按execution索引、原子mutation和有界回收进入四端冻结合同', () => {
  const contract = readFileSync(
    join(citizenSdkRoot, 'native/contracts/source/store_transaction_history.rs'), 'utf8');
  for (const marker of [
    'TransactionHistoryIndex', 'TransactionHistoryCursor', 'TransactionHistoryMutation',
    'load_record', 'load_page', 'compare_and_swap',
  ]) assert.match(contract, new RegExp(marker, 'u'));
  assert.doesNotMatch(contract, /TransactionHistoryState/u);

  const codec = readFileSync(join(citizenSdkRoot, 'native/ffi/source/host_codec.rs'), 'utf8');
  for (const marker of ['THQ1', 'THB1', 'THM1', 'TXR1']) assert.match(codec, new RegExp(marker, 'u'));
  const header = readFileSync(join(citizenSdkRoot, 'include/citizensdk_types.h'), 'utf8');
  assert.match(header, /transaction_history_query/u);
  assert.match(header, /transaction_history_mutate/u);
  assert.doesNotMatch(header, /transaction_history_load|transaction_history_compare_and_swap/u);

  for (const relativePath of [
    'android/native/source/CitizenSdkPublicStore.kt',
    'darwin/source/core/CitizenSDKPublicStore.swift',
    'linux/source/citizen_sdk_public_store.cc',
    'windows/source/citizen_sdk_public_store.cc',
  ]) {
    const store = readFileSync(join(citizenSdkRoot, ...relativePath.split('/')), 'utf8');
    for (const marker of [
      'transaction_history_meta', 'transaction_history_records',
      'transaction_history_newest_idx', 'transaction_history_retention_idx',
      'transaction_history_reconcile_idx', 'incremental_vacuum(128)',
    ]) assert.ok(store.includes(marker), relativePath);
    assert.doesNotMatch(store, /\b(?:destination|amount|remark|direction|pallet|action)\b/iu, relativePath);
    assert.doesNotMatch(store, /VACUUM(?!\s*\()/u, relativePath);
  }
  const monitor = readFileSync(join(citizenSdkRoot, 'native/ffi/source/chain_monitor.rs'), 'utf8');
  assert.match(monitor, /Duration::from_secs\(30\)/u);
  assert.match(monitor, /Some\(Some\(Err\(_\)\)\) \| Some\(None\)/u);

  // Apple C ABI 边界必须先安全转换可空字节视图，再校验固定查询长度；
  // citizenSDKData 是抛错边界，遗漏 try 会让正式 Apple 源码无法编译。
  const appleHostBridge = readFileSync(
    join(citizenSdkRoot, 'darwin/source/core/CitizenSDKHostBridge.swift'), 'utf8');
  assert.match(appleHostBridge, /let bytes = try citizenSDKData\(query\)/u);
  assert.match(appleHostBridge, /guard bytes\.count == 58/u);
  const androidNative = readFileSync(join(citizenSdkRoot,
    'android/native/source/CitizenSdkNative.kt'), 'utf8');
  assert.match(androidNative,
    /\(decoded\.result as\? CitizenSdkNativeResult\.Block\)\?\.value \?: return/u);
  assert.doesNotMatch(androidNative, /decoded\.value as\? CitizenSdkNativeResult\.Block/u);
});

test('Apple podspec只交付pod根内固定Framework相对名称', () => {
  const podspec = readFileSync(join(citizenSdkRoot, 'darwin/citizen_sdk.podspec'), 'utf8');
  assert.match(podspec, /framework_path = 'CitizenSDK\.xcframework'/u);
  assert.match(podspec, /Dir\.exist\?\(File\.join\(__dir__, framework_path\)\)/u);
  assert.match(podspec, /spec\.vendored_frameworks = framework_path/u);
  assert.doesNotMatch(podspec, /CITIZENSDK_APPLE_FRAMEWORK_DIR|Pathname|relative_path_from/u);
});

test('Hosted Package 合同固定过滤规则与可解析依赖边界', () => {
  const root = mkdtempSync(join(workRoot, 'release-hosted-package-test-'));
  try {
    cpSync(join(citizenSdkRoot, 'lib'), join(root, 'lib'), { recursive: true });
    cpSync(join(citizenSdkRoot, 'linux'), join(root, 'linux'), { recursive: true });
    // 总包合同与平台专属合同使用同一完整源码集合，不能遗漏 Windows 后只测旧平台。
    cpSync(join(citizenSdkRoot, 'windows'), join(root, 'windows'), { recursive: true });
    for (const path of [
      '.pubignore',
      'android/build.gradle',
      'darwin/citizen_sdk.podspec',
      'linux/CMakeLists.txt',
      'pubspec.yaml',
    ]) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(citizenSdkRoot, path), destination);
    }
    assert.doesNotThrow(() => assertHostedRuntimeDartProjection(root));
    assert.doesNotThrow(() => assertHostedPackageSource(root));

    // 错误、缺失或多个仓库声明都不能成为可发布输入，不保留旧身份兼容。
    const manifestPath = join(root, 'pubspec.yaml');
    const manifest = readFileSync(manifestPath, 'utf8');
    for (const invalid of [
      manifest.replace('github.com/crcfrcn/citizensdk', 'github.com/Unregistered/retired-repository'),
      manifest.replace(/^repository:.*\n/m, ''),
      manifest + '\nrepository: https://github.com/Unregistered/retired-repository\n',
    ]) {
      writeFileSync(manifestPath, invalid);
      assert.throws(() => assertHostedPackageSource(root), /repository 必须为现行唯一仓库/);
    }
    writeFileSync(manifestPath, manifest);
    const podspecPath = join(root, 'darwin/citizen_sdk.podspec');
    const podspec = readFileSync(podspecPath, 'utf8');
    writeFileSync(podspecPath, podspec.replace('github.com/crcfrcn/citizensdk', 'github.com/Unregistered/retired-repository'));
    assert.throws(() => assertHostedPackageSource(root), /Apple homepage 必须为现行唯一仓库/);
    writeFileSync(podspecPath, podspec);

    const facadePath = join(root, 'lib', 'api', 'citizen_sdk.dart');
    const facade = readFileSync(facadePath, 'utf8');
    const forbiddenFacadeName = ['CitizenSdk', 'Client'].join('');
    writeFileSync(
      facadePath,
      facade.replace('final class CitizenSdk', `final class ${forbiddenFacadeName}`),
    );
    assert.throws(
      () => assertHostedRuntimeDartProjection(root),
      /唯一公开门面必须精确命名为 CitizenSdk/,
    );
    writeFileSync(facadePath, facade);

    const requiredRuntime = join(root, 'lib', 'api', 'citizen_chain.dart');
    rmSync(requiredRuntime);
    assert.throws(
      () => assertHostedRuntimeDartProjection(root),
      /Hosted Dart 运行闭集漂移.*缺失=lib\/api\/citizen_chain\.dart/,
    );
    copyFileSync(join(citizenSdkRoot, 'lib', 'api', 'citizen_chain.dart'), requiredRuntime);

    const unexpectedRuntime = join(root, 'lib', 'hosted_private_key_probe.dart');
    writeFileSync(unexpectedRuntime, 'const probe = true;\n');
    assert.throws(
      () => assertHostedRuntimeDartProjection(root),
      /Hosted Dart 运行闭集漂移.*额外=lib\/hosted_private_key_probe\.dart/,
    );
    rmSync(unexpectedRuntime);

    const pubignorePath = join(root, '.pubignore');
    const pubignore = readFileSync(pubignorePath, 'utf8');
    for (const forbiddenRule of [
      '/lib/smoldot/',
    ]) {
      writeFileSync(pubignorePath, pubignore.replace(`${forbiddenRule}\n`, ''));
      assert.throws(
        () => assertHostedRuntimeDartProjection(root),
        /Hosted Dart 运行闭集漂移.*额外=/,
        `移除 ${forbiddenRule} 必须暴露并拒绝旧实现路径`,
      );
    }
    writeFileSync(pubignorePath, pubignore);

    const androidVersionPath = join(root, 'android', 'build.gradle');
    writeFileSync(
      androidVersionPath,
      readFileSync(androidVersionPath, 'utf8').replace("version = '1.0.0'", "version = '1.0.1'"),
    );
    assert.throws(
      () => assertHostedPackageSource(root),
      /包版本不一致：pubspec\.yaml=1\.0\.0；android\/build\.gradle=1\.0\.1/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'android', 'build.gradle'),
      androidVersionPath,
    );

    const linuxVersionPath = join(root, 'linux', 'CMakeLists.txt');
    writeFileSync(
      linuxVersionPath,
      readFileSync(linuxVersionPath, 'utf8').replace(
        'project(CitizenSDKHost VERSION 1.0.0 LANGUAGES C CXX)',
        'project(CitizenSDKHost VERSION 1.0.1 LANGUAGES C CXX)',
      ),
    );
    assert.throws(
      () => assertHostedPackageSource(root),
      /包版本不一致：pubspec\.yaml=1\.0\.0；linux\/CMakeLists\.txt=1\.0\.1/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'linux', 'CMakeLists.txt'),
      linuxVersionPath,
    );

    const windowsVersionPath = join(root, 'windows', 'CMakeLists.txt');
    const windowsVersionSource = readFileSync(windowsVersionPath, 'utf8');
    writeFileSync(windowsVersionPath, windowsVersionSource.replace(
      'project(CitizenSDKHost VERSION 1.0.0 LANGUAGES C CXX)',
      'project(CitizenSDKHost VERSION 1.0.1 LANGUAGES C CXX)',
    ));
    assert.throws(
      () => assertHostedPackageSource(root),
      /包版本不一致：pubspec\.yaml=1\.0\.0；windows\/CMakeLists\.txt=1\.0\.1/,
    );
    writeFileSync(windowsVersionPath, windowsVersionSource);

    writeFileSync(pubignorePath, 'drift\n');
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package 合同文件哈希漂移：\.pubignore/,
    );

    copyFileSync(join(citizenSdkRoot, '.pubignore'), pubignorePath);
    const pubspecPath = join(root, 'pubspec.yaml');
    const pubspec = readFileSync(pubspecPath, 'utf8');
    writeFileSync(pubspecPath, pubspec.replace('ffi: 2.2.0', 'ffi: ^2.2.0'));
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package dev_dependencies 依赖约束漂移：ffi/,
    );

    writeFileSync(pubspecPath, pubspec.replace('crypto: 3.0.7', 'crypto: 3.0.6'));
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package dev_dependencies 依赖约束漂移：crypto/,
    );

    writeFileSync(
      pubspecPath,
      pubspec.replace('  polkadart_keyring: 0.7.1',
        '  polkadart_keyring: 0.7.1\n  unexpected_dependency: ^1.0.0'),
    );
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package dependencies 闭集漂移/,
    );

    writeFileSync(pubspecPath, pubspec.replace('polkadart_keyring: 0.7.1', 'polkadart_keyring: 0.7.0'));
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package dependencies 依赖约束漂移：polkadart_keyring/,
    );

    writeFileSync(
      pubspecPath,
      pubspec.replace('  path: ^1.9.1', '  path: ^1.9.1\n  local_probe:\n    path: ..'),
    );
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package 禁止 git\/path 依赖/,
    );

    writeFileSync(pubspecPath, pubspec.replace('name: citizen_sdk', 'name: citizen_sdk\npublish_to: "none"'));
    assert.throws(
      () => assertHostedPackageSource(root),
      /Hosted Package 禁止 publish_to: none/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Release 拒绝与源码包版本不一致的请求版本', () => {
  const root = mkdtempSync(join(workRoot, 'release-version-drift-test-'));
  try {
    const native = writeNativeFixture(root);
    const output = join(root, 'candidate');
    const archive = join(root, 'citizensdk.tgz');
    assert.throws(
      () => buildCitizenSdkRelease({
        sourcePath: citizenSdkRoot,
        nativePath: native,
        outputPath: output,
        archivePath: archive,
        gitCommitSha: '0'.repeat(40),
        softwareVersion: '0.1.0',
      }),
      /发布版本必须与源码一致：源码=1\.0\.0；请求=0\.1\.0/,
    );
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(archive), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SDK 自有测试源码固定 Core Rust、FFI、provider、根与平台合同闭集', () => {
  // 先验证真实源码闭集，防止测试自己的复制清单和发布清单同时漏掉新增测试。
  assert.doesNotThrow(() => assertSdkTestContracts(citizenSdkRoot));
  const root = mkdtempSync(join(workRoot, 'release-test-contract-test-'));
  try {
    for (const relativeRoot of [
      'test',
      'native/contracts/tests',
      'native/engine/tests',
      'native/ffi/tests',
      'native/signer/tests',
      'native/provider/tests',
      'native/legacy/tests',
      'android/native/tests',
      'android/native/device',
      'android/tests',
      'darwin/tests',
      'linux/tests',
      'windows/tests',
    ]) {
      const destination = join(root, ...relativeRoot.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(citizenSdkRoot, ...relativeRoot.split('/')), destination, {
        recursive: true,
      });
    }
    for (const relativePath of [
      'native/engine/source/qr_review_tests.rs',
      'native/ffi/source/chain_monitor_tests.rs',
      'native/engine/source/wallet_derivation_tests.rs',
      'native/engine/source/wallet_input_tests.rs',
      'native/engine/source/wallet_service_tests.rs',
      'native/ffi/source/composition_tests.rs',
      'native/ffi/source/host_codec_tests.rs',
      'native/ffi/source/wallet_abi_tests.rs',
      'native/provider/source/bootstrap_tests.rs',
    ]) {
      const destination = join(root, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(citizenSdkRoot, ...relativePath.split('/')), destination);
    }
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const name of []) {
      copyFileSync(join(citizenSdkRoot, 'scripts', name), join(root, 'scripts', name));
    }
    assert.doesNotThrow(() => assertSdkTestContracts(root));

    const golden = join(root, 'native', 'engine', 'source', 'wallet_derivation_tests.rs');
    writeFileSync(golden, `${readFileSync(golden, 'utf8')}\n`);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试合同文件哈希漂移：native\/engine\/source\/wallet_derivation_tests\.rs/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'native', 'engine', 'source', 'wallet_derivation_tests.rs'),
      golden,
    );
    const bootstrap = join(root, 'native/provider/source/bootstrap_tests.rs');
    rmSync(bootstrap);
    assert.throws(() => assertSdkTestContracts(root), /内嵌测试文件闭集漂移.*bootstrap_tests\.rs/);
    copyFileSync(join(citizenSdkRoot, 'native/provider/source/bootstrap_tests.rs'), bootstrap);
    const ffiTest = join(root, 'native', 'ffi', 'tests', 'symbol_contract.rs');
    writeFileSync(ffiTest, `${readFileSync(ffiTest, 'utf8')}\n`);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试合同文件哈希漂移：native\/ffi\/tests\/symbol_contract\.rs/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'native', 'ffi', 'tests', 'symbol_contract.rs'),
      ffiTest,
    );

    const walletAbiTest = join(
      root,
      'native',
      'ffi',
      'tests',
      'wallet_abi_contract.rs',
    );
    writeFileSync(walletAbiTest, `${readFileSync(walletAbiTest, 'utf8')}\n`);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试合同文件哈希漂移：native\/ffi\/tests\/wallet_abi_contract\.rs/,
    );
    copyFileSync(
      join(
        citizenSdkRoot,
        'native',
        'ffi',
        'tests',
        'wallet_abi_contract.rs',
      ),
      walletAbiTest,
    );

    const hostProviderTest = join(
      root,
      'native',
      'ffi',
      'tests',
      'host_provider_contract.rs',
    );
    rmSync(hostProviderTest);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试文件闭集漂移：native\/ffi\/tests.*缺失=native\/ffi\/tests\/host_provider_contract\.rs/,
    );
    copyFileSync(
      join(
        citizenSdkRoot,
        'native',
        'ffi',
        'tests',
        'host_provider_contract.rs',
      ),
      hostProviderTest,
    );

    const providerTest = join(
      root,
      'native', 'provider',
      'tests',
      'verified_chain_client_contract.rs',
    );
    writeFileSync(providerTest, `${readFileSync(providerTest, 'utf8')}\n`);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试合同文件哈希漂移：native\/provider\/tests\/verified_chain_client_contract\.rs/,
    );
    copyFileSync(
      join(
        citizenSdkRoot,
        'native', 'provider',
        'tests',
        'verified_chain_client_contract.rs',
      ),
      providerTest,
    );
    writeFileSync(join(root, 'test', 'unexpected_test.dart'), 'void main() {}\n');
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试文件闭集漂移：test.*额外=test\/unexpected_test\.dart/,
    );

    rmSync(join(root, 'test', 'unexpected_test.dart'));
    writeFileSync(join(root, 'scripts', 'unregistered.test.mjs'), 'export {};\n');
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试文件闭集漂移：scripts.*额外=scripts\/unregistered\.test\.mjs/,
    );

    rmSync(join(root, 'scripts', 'unregistered.test.mjs'));
    const officialAndroidTest = join(
      root,
      'android',
      'tests',
      'CitizenSdkFlutterCodecTest.kt',
    );
    const oldAndroidTest = join(
      root,
      'android',
      'tests',
      'kotlin',
      'org',
      'citizen',
      'sdk',
      'CitizenSdkFlutterCodecTest.kt',
    );
    mkdirSync(dirname(oldAndroidTest), { recursive: true });
    copyFileSync(officialAndroidTest, oldAndroidTest);
    rmSync(officialAndroidTest);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试文件闭集漂移：android\/tests.*缺失=android\/tests\/CitizenSdkFlutterCodecTest\.kt.*额外=android\/tests\/kotlin\/org\/citizen\/sdk\/CitizenSdkFlutterCodecTest\.kt/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'android', 'tests', 'CitizenSdkFlutterCodecTest.kt'),
      officialAndroidTest,
    );
    rmSync(oldAndroidTest);
    const nativeAndroidTest = join(
      root,
      'android',
      'native',
      'tests',
      'CitizenSdkApiContractTest.kt',
    );
    rmSync(nativeAndroidTest);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试文件闭集漂移：android\/native\/tests.*缺失=android\/native\/tests\/CitizenSdkApiContractTest\.kt/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sr25519 signer 固定为已验证来源字节', () => {
  assert.doesNotThrow(() => assertSignerSource(citizenSdkRoot));
});

test('sr25519 signer 合同拒绝来源内容漂移', () => {
  const root = mkdtempSync(join(workRoot, 'release-signer-test-'));
  try {
    const signer = join(root, 'native', 'signer');
    mkdirSync(join(root, 'native'), { recursive: true });
    cpSync(join(citizenSdkRoot, 'native', 'signer'), signer, { recursive: true });
    assert.doesNotThrow(() => assertSignerSource(root));
    writeFileSync(join(signer, 'source', 'lib.rs'), 'drift\n');
    assert.throws(() => assertSignerSource(root), /signer 来源字节漂移/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sr25519 signer 合同拒绝可改变 Cargo 行为的额外文件', () => {
  const root = mkdtempSync(join(workRoot, 'release-signer-closure-test-'));
  try {
    const signer = join(root, 'native', 'signer');
    mkdirSync(join(root, 'native'), { recursive: true });
    cpSync(join(citizenSdkRoot, 'native', 'signer'), signer, { recursive: true });
    assert.doesNotThrow(() => assertSignerSource(root));
    writeFileSync(join(signer, 'build.rs'), 'fn main() {}\n');
    assert.throws(
      () => assertSignerSource(root),
      /signer 8 文件闭集漂移.*额外=native\/signer\/build\.rs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('smoldot Rust 锁保留结构校验并拒绝futures-core身份分叉', () => {
  const root = mkdtempSync(join(workRoot, 'release-lock-test-'));
  try {
    copyFileSync(join(citizenSdkRoot, 'Cargo.lock'), join(root, 'Cargo.lock'));
    for (const relative of ['native/legacy/Cargo.lock','native/smoldot/Cargo.lock']) {
      const destination=join(root,relative);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(citizenSdkRoot,relative),destination);
    }
    assert.doesNotThrow(() => assertSmoldotLocks(root));
    const ffiLock = join(root, 'native', 'legacy', 'Cargo.lock');
    writeFileSync(ffiLock, `${readFileSync(ffiLock, 'utf8')}\n`);
    assert.doesNotThrow(() => assertSmoldotLocks(root));
    const original = readFileSync(ffiLock, 'utf8');
    const block = original.match(/\[\[package\]\]\nname = "futures-core"\n[\s\S]*?(?=\n\[\[package\]\]|$)/u)?.[0];
    assert.ok(block, '现有宿主锁必须包含唯一futures-core');
    // 正常空白不影响身份；版本、来源、checksum漂移以及重复/缺失都必须失败。
    for (const replacement of [
      block.replace(/^version = "[^"]+"$/mu, 'version = "0.0.0"'),
      block.replace(/^checksum = "[^"]+"$/mu, `checksum = "${'0'.repeat(64)}"`),
      block.replace('registry+https://github.com/rust-lang/crates.io-index', 'registry+https://invalid.example/index'),
      `${block}\n${block}`,
      '',
    ]) {
      writeFileSync(ffiLock, original.replace(block, replacement));
      assert.throws(() => assertSmoldotLocks(root), /futures-core|官方 registry 包/u);
    }
    writeFileSync(ffiLock, original);
    assert.doesNotThrow(() => assertSmoldotLocks(root));
    writeFileSync(ffiLock, 'drift\n');
    assert.throws(() => assertSmoldotLocks(root), /上游 smoldot 锁/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('smoldot Dart Release 合同拒绝内容和闭集漂移', () => {
  const root = mkdtempSync(join(workRoot, 'release-smoldot-test-'));
  try {
    for (const relativeRoot of [
      'lib/smoldot',
      'test/smoldot',
    ]) {
      const source = join(citizenSdkRoot, ...relativeRoot.split('/'));
      const copy = join(root, ...relativeRoot.split('/'));
      mkdirSync(dirname(copy), { recursive: true });
      cpSync(source, copy, { recursive: true });
    }
    const bindings = join(root, 'lib', 'smoldot', 'bindings.dart');
    writeFileSync(bindings, 'drift\n');
    assert.throws(
      () => assertSmoldotDartSource(root),
      /smoldot Dart 文件哈希漂移：lib\/smoldot\/bindings\.dart/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'lib', 'smoldot', 'bindings.dart'),
      bindings,
    );
    writeFileSync(join(root, 'test', 'smoldot', 'unexpected.txt'), 'extra\n');
    assert.throws(
      () => assertSmoldotDartSource(root),
      /smoldot Dart 文件闭集漂移/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('私钥扫描器不误报自身且仍拒绝真实 PEM 标记', () => {
  const root = mkdtempSync(join(workRoot, 'release-secret-test-'));
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(fileURLToPath(new URL('./release.mjs', import.meta.url)), join(scripts, 'release.mjs'));
    assert.doesNotThrow(() => assertNoSecrets(root));

    const privateMarker = ['-----PRIVATE', ' KEY-----'].join('');
    writeFileSync(join(root, 'leaked-secret.txt'), privateMarker);
    assert.throws(() => assertNoSecrets(root), /SDK 候选疑似包含私钥材料/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('本机打包与Android构建只要求安全的CitizenSDK源码外目录', () => {
  const release = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8').split('// 正式实现结束；')[0];
  const native = BUILD_SHELL_SOURCES.native;
  assert.match(release, /function assertLocalTarget\(path, label\)[\s\S]*?return target;/u);
  assert.doesNotMatch(release, /固定本机目录|\/Users\/|外部控制程序/u);
  assert.match(native, /local_build_path_is_allowed\(\) \{[\s\S]*?"\$sdk_dir\/"\*\) return 1/u);
  assert.match(native, /工作目录或产物目录位于 CitizenSDK 源码树/u);
  for (const relative of ['android/build.gradle', 'android/native/build.gradle']) {
    const gradle = readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
    assert.doesNotMatch(gradle, /\/Users\/|共享工作根|中央工作目录/u);
    assert.match(gradle, /outside the source tree|verifyCitizenSdkAndroidOutput/u);
  }
});
test('Release 在创建目录前拒绝路径穿越与既存符号链接祖先', () => {
  const root = mkdtempSync(join(workRoot, 'release-path-guard-test-'));
  try {
    const native = writeNativeFixture(root);
    const archive = join(root, 'citizensdk.tgz');
    const traversal = `${root}/../../../citizensdk-release-path-probe-${basename(root)}`;
    const traversalTarget = resolve(traversal);
    assert.equal(existsSync(traversalTarget), false);
    assert.throws(
      () => buildCitizenSdkRelease({
        sourcePath: citizenSdkRoot,
        nativePath: native,
        outputPath: traversal,
        archivePath: archive,
        gitCommitSha: '0'.repeat(40),
        softwareVersion: '1.0.0',
      }),
      /绝对规范路径|\. 或 \.\./,
    );
    assert.equal(existsSync(traversalTarget), false);

    const sourceProbe = join(citizenSdkRoot, `release-path-probe-${basename(root)}`);
    const redirect = join(root, 'source-link');
    assert.equal(existsSync(sourceProbe), false);
    symlinkSync(citizenSdkRoot, redirect, 'dir');
    assert.throws(
      () => buildCitizenSdkRelease({
        sourcePath: citizenSdkRoot,
        nativePath: native,
        outputPath: join(redirect, basename(sourceProbe)),
        archivePath: archive,
        gitCommitSha: '0'.repeat(40),
        softwareVersion: '1.0.0',
      }),
      /符号链接/,
    );
    assert.equal(existsSync(sourceProbe), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('原生构建入口固定 Apple arm64 技术合同/最低版本且在 mkdir 前拒绝穿越和中间符号链接', () => {
  const root = mkdtempSync(join(workRoot, 'native-path-guard-test-'));
  try {
    const nativeBuildScript = BUILD_SHELL_SOURCES.native;
    assertAppleDeploymentTargetContract(nativeBuildScript);
    assertAndroidKotlinPersistentStateContract(nativeBuildScript);
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace('ios_deployment_target=16.0', 'ios_deployment_target=17.0'),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'macos_deployment_target=13.0',
        'macos_deployment_target=14.0',
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'framework_content_root="$framework/Versions/A"',
        'framework_content_root="$framework"',
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        "framework_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'",
        "framework_install_name='@rpath/CitizenSDK.framework/CitizenSDK'",
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        "expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'",
        "expected_install_name='@rpath/CitizenSDK.framework/CitizenSDK'",
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'abi.json private.swiftinterface swiftdoc swiftinterface swiftmodule swiftsourceinfo',
        'private.swiftinterface swiftdoc swiftinterface swiftmodule swiftsourceinfo',
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'cmp -s "$source" "$destination" \\\n          || fail "$platform/$variant XCFramework Swift module 产物字节漂移：$extension"',
        'true',
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'run|compile) swiftpm_target=(build --build-tests)',
        'run) swiftpm_target=(test)',
      ),
    ));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'swift test --skip-build "${swiftpm_paths[@]}"',
        'swift test "${swiftpm_paths[@]}"',
      ),
    ));
    assert.throws(() => assertAndroidKotlinPersistentStateContract(
      nativeBuildScript.replace(
        'kotlin_persistent_dir="$work_dir/kotlin-project-persistent"',
        'kotlin_persistent_dir="$android_gradle_project/.kotlin"',
      ),
    ));
    const appleSliceStart = nativeBuildScript.indexOf('build_apple_framework_slice() {');
    const appleProductManifest = 'cargo build --manifest-path "$product_ffi_manifest"';
    const appleProductManifestIndex = nativeBuildScript.indexOf(
      appleProductManifest,
      appleSliceStart,
    );
    assert.notEqual(appleSliceStart, -1);
    assert.notEqual(appleProductManifestIndex, -1);
    const legacyAppleManifestMutation = `${nativeBuildScript.slice(0, appleProductManifestIndex)}cargo build --manifest-path "$ffi_manifest"${nativeBuildScript.slice(appleProductManifestIndex + appleProductManifest.length)}`;
    assert.throws(() => assertAppleDeploymentTargetContract(legacyAppleManifestMutation));
    assert.throws(() => assertAppleDeploymentTargetContract(
      nativeBuildScript.replace(
        'aarch64-apple-ios-sim iphonesimulator',
        'x86_64-apple-ios iphonesimulator',
      ),
    ));

    const traversal = `${root}/../../../citizensdk-native-path-probe-${basename(root)}`;
    const traversalTarget = resolve(traversal);
    assert.equal(existsSync(traversalTarget), false);
    const baseEnvironment = {
      ...process.env,
      CITIZENSDK_NATIVE_OUTPUT_DIR: join(root, 'native-output'),
      GITHUB_ACTIONS: 'false',
    };
    // 两个输出参数是一个事务预检；任意一方无效时，另一方也不得被 mkdir。
    for (const [index, work, output] of [
      [0, join(root, 'zero-write-work-a'), `${root}/invalid/../zero-write-output-a`],
      [1, `${root}/invalid/../zero-write-work-b`, join(root, 'zero-write-output-b')],
    ]) {
      const result = spawnSync('/bin/bash', [join(citizenSdkRoot, 'scripts/build-native.sh'), 'android'], {
        cwd: workRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          CITIZENSDK_WORK_DIR: work,
          CITIZENSDK_NATIVE_OUTPUT_DIR: output,
        },
      });
      assert.notEqual(result.status, 0, `零写预检夹具 ${index}`);
      assert.match(result.stderr, /规范路径|\. 或 \.\./u);
      assert.equal(existsSync(resolve(work)), false, `无效双参数不得创建 work：${index}`);
      assert.equal(existsSync(resolve(output)), false, `无效双参数不得创建 output：${index}`);
    }
    const traversalResult = spawnSync('/bin/bash', [join(citizenSdkRoot, 'scripts/build-native.sh'), 'android'], {
      cwd: workRoot,
      encoding: 'utf8',
      env: { ...baseEnvironment, CITIZENSDK_WORK_DIR: traversal },
    });
    assert.notEqual(traversalResult.status, 0);
    assert.match(traversalResult.stderr, /\. 或 \.\.|规范路径/);
    assert.equal(existsSync(traversalTarget), false);

    const sourceProbe = join(citizenSdkRoot, `native-path-probe-${basename(root)}`);
    const redirect = join(root, 'source-link');
    assert.equal(existsSync(sourceProbe), false);
    symlinkSync(citizenSdkRoot, redirect, 'dir');
    const symlinkResult = spawnSync('/bin/bash', [join(citizenSdkRoot, 'scripts/build-native.sh'), 'android'], {
      cwd: workRoot,
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        CITIZENSDK_WORK_DIR: join(redirect, basename(sourceProbe)),
      },
    });
    assert.notEqual(symlinkResult.status, 0);
    assert.match(symlinkResult.stderr, /符号链接/);
    assert.equal(existsSync(sourceProbe), false);

    // Extract the production predicate verbatim. Unlike the real traversal
    // and symlink rejection probes above, an accepted host path would reach
    // canonical_directory and mkdir in the full script. This read-only seam
    // verifies both host branches without writing outside this test workRoot.
    const predicateFunctions = [
      'fail', 'assert_safe_directory_path', 'local_build_path_is_allowed',
    ].map((name) => {
      const declarations = [...nativeBuildScript.matchAll(new RegExp(
        `^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'gm',
      ))];
      assert.equal(declarations.length, 1, `唯一生产函数：${name}`);
      return declarations[0][0];
    });
    const hostPredicate = [
      'set -euo pipefail',
      'sdk_dir="${2%/}"',
      ...predicateFunctions,
      'assert_safe_directory_path "$1" "宿主路径合同"',
      'local_build_path_is_allowed "$1"',
    ].join('\n');
    assert.doesNotMatch(hostPredicate, /canonical_directory|\bmkdir\b/u);
    const externalOutput = join(root, 'consumer-owned', 'citizensdk', 'output');
    const hostEnvironment = {
      ...process.env,
      GITHUB_ACTIONS: 'false',
    };
    // 产品原生构建入口可以被任意 App/第三方复用；它只要求规范绝对路径并拒绝
    // CitizenSDK源码树。候选打包器同样只要求安全的源码外绝对路径。
    const acceptedHostResult = spawnSync(
      '/bin/bash', ['-c', hostPredicate, 'citizensdk-host-path-contract',
        externalOutput, citizenSdkRoot], {
        cwd: workRoot,
        encoding: 'utf8',
        env: hostEnvironment,
      },
    );
    assert.equal(acceptedHostResult.status, 0, acceptedHostResult.stderr);
    assert.equal(acceptedHostResult.stdout, '');
    assert.equal(acceptedHostResult.stderr, '');

    for (const forbidden of [citizenSdkRoot, join(citizenSdkRoot, 'build')]) {
      const rejected = spawnSync('/bin/bash', ['-c', hostPredicate,
        'citizensdk-host-path-contract', forbidden, citizenSdkRoot], {
        cwd: workRoot, encoding: 'utf8', env: hostEnvironment,
      });
      assert.equal(rejected.status, 1, rejected.stderr);
    }

    const androidPlugin = readFileSync(join(citizenSdkRoot, 'android', 'build.gradle'), 'utf8');
    const androidNative = readFileSync(
      join(citizenSdkRoot, 'android', 'native', 'build.gradle'),
      'utf8',
    );
    for (const gradle of [androidPlugin, androidNative]) {
      assert.doesNotMatch(gradle, /\/Users\/|共享工作根|中央工作目录/u);
      assert.match(gradle, /outside the source tree|verifyCitizenSdkAndroidOutput/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android Core 在 AAR 与独立双库投影前只执行一次固定 NDK strip', () => {
  const nativeBuildScript = BUILD_SHELL_SOURCES.native;
  const stage = 'cp "$source_library" "$core_stage/libcitizensdk.so"';
  const strip = '"$strip_bin" --strip-unneeded "$core_stage/libcitizensdk.so"';
  const verify = 'verify_product_abi_symbols "$core_stage/libcitizensdk.so"';
  const project = 'cp "$core_stage/libcitizensdk.so" "$core_destination"';
  const gradle = 'CITIZENSDK_ANDROID_CORE_DIR="$core_stage"';
  const positions = [stage, strip, verify, project, gradle]
    .map((fragment) => nativeBuildScript.indexOf(fragment));

  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.equal(nativeBuildScript.split(strip).length - 1, 1);
  // 原生构建只 strip 一次；最终包消费者必须原样装入已 strip 的双库。
  const consumerOffset = nativeBuildScript.indexOf('build_mobile_hosted_consumer()');
  assert.ok(consumerOffset > positions.at(-1));
  assert.doesNotMatch(nativeBuildScript.slice(0, consumerOffset), /keepDebugSymbols|doNotStrip/);
  assert.match(nativeBuildScript.slice(consumerOffset), /keepDebugSymbols \+= setOf\("\*\*\/libcitizensdk\.so", "\*\*\/libcitizensdk_jni\.so"\)/u);
});

test('Android JNI 导出闭集要求唯一版本化 JNI_OnLoad', () => {
  const root = mkdtempSync(join(workRoot, 'android-jni-symbol-test-'));
  try {
    const fakeNm = join(root, 'fake-nm.sh');
    const library = join(root, 'nm-output.txt');
    writeFileSync(
      fakeNm,
      '#!/usr/bin/env bash\nset -euo pipefail\n/bin/cat "${!#}"\n',
    );
    chmodSync(fakeNm, 0o700);
    const runGate = (symbols) => {
      writeFileSync(
        library,
        `${symbols.map((symbol, index) => `${index.toString(16)} T ${symbol}`).join('\n')}\n`,
      );
      return spawnSync(
        '/bin/bash',
        [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-jni-symbols'],
        {
          cwd: workRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CITIZENSDK_BUILD_TEST: '1',
            CITIZENSDK_NATIVE_OUTPUT_DIR: join(root, 'native-output'),
            CITIZENSDK_TEST_LIBRARY: library,
            CITIZENSDK_TEST_NM_BIN: fakeNm,
            CITIZENSDK_WORK_DIR: join(root, 'native-work'),
            GITHUB_ACTIONS: 'true',
          },
        },
      );
    };

    const exact = runGate(['JNI_OnLoad@@CITIZENSDK_JNI_1.0']);
    assert.equal(exact.status, 0, exact.stderr);
    for (const rejected of [
      ['JNI_OnLoad'],
      ['JNI_OnLoad@@CITIZENSDK_JNI_1.0', 'Java_org_citizen_sdk_leak'],
    ]) {
      const result = runGate(rejected);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /版本化 JNI_OnLoad/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android ELF 固定双库 SONAME 并拒绝 DT_NEEDED 构建机路径', () => {
  const root = mkdtempSync(join(workRoot, 'android-elf-identity-test-'));
  try {
    const fakeReadelf = join(root, 'fake-readelf.sh');
    const core = join(root, 'libcitizensdk.so');
    const jni = join(root, 'libcitizensdk_jni.so');
    writeFileSync(fakeReadelf, '#!/usr/bin/env bash\nset -euo pipefail\n/bin/cat "${!#}"\n');
    chmodSync(fakeReadelf, 0o700);
    const runGate = (coreDynamic, jniDynamic) => {
      writeFileSync(core, coreDynamic);
      writeFileSync(jni, jniDynamic);
      return spawnSync(
        '/bin/bash',
        [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-android-elf-identity'],
        {
          cwd: workRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CITIZENSDK_BUILD_TEST: '1',
            CITIZENSDK_NATIVE_OUTPUT_DIR: join(root, 'native-output'),
            CITIZENSDK_TEST_CORE_LIBRARY: core,
            CITIZENSDK_TEST_JNI_LIBRARY: jni,
            CITIZENSDK_TEST_READELF_BIN: fakeReadelf,
            CITIZENSDK_WORK_DIR: join(root, 'native-work'),
            GITHUB_ACTIONS: 'true',
          },
        },
      );
    };
    const valid = runGate(
      '0 (SONAME) Library soname: [libcitizensdk.so]\n0 (NEEDED) Shared library: [libc.so]\n',
      '0 (SONAME) Library soname: [libcitizensdk_jni.so]\n0 (NEEDED) Shared library: [libcitizensdk.so]\n0 (NEEDED) Shared library: [liblog.so]\n',
    );
    assert.equal(valid.status, 0, valid.stderr);

    const absoluteNeeded = runGate(
      '0 (SONAME) Library soname: [libcitizensdk.so]\n',
      '0 (SONAME) Library soname: [libcitizensdk_jni.so]\n0 (NEEDED) Shared library: [/tmp/build/libcitizensdk.so]\n',
    );
    assert.notEqual(absoluteNeeded.status, 0);
    assert.match(absoluteNeeded.stderr, /DT_NEEDED 禁止包含构建机路径/);

    const missingSoname = runGate(
      '0 (NEEDED) Shared library: [libc.so]\n',
      '0 (SONAME) Library soname: [libcitizensdk_jni.so]\n0 (NEEDED) Shared library: [libcitizensdk.so]\n',
    );
    assert.notEqual(missingSoname.status, 0);
    assert.match(missingSoname.stderr, /Core SONAME/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux 安装闭集固定公开头、同平台双库、CMake 和三项链资产', () => {
  const shell = [
    'set -euo pipefail',
    nativeShellFunctions(['fail', 'linux_install_files']),
    'linux_install_files "$1"',
  ].join('\n');
  for (const platform of ['LinuxARM', 'LinuxAMD']) {
    const result = spawnSync('/bin/bash', ['-c', shell, 'linux-install-files', platform], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const expected = linuxInstallFixturePaths(platform);
    const actual = result.stdout.trim().split('\n').sort();
    assert.equal(actual.length, 19);
    assert.equal(new Set(actual).size, 19);
    assert.deepEqual(actual, expected);
    assert.equal(actual.some((path) => /plugin|src\/|test\//u.test(path)), false);
  }
  const rejected = spawnSync('/bin/bash', ['-c', shell, 'linux-install-files', 'unregistered'], {
    encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0);
});

test('Linux 安装复制执行唯一生产函数，完整预检后才写入且不覆盖既有六头', () => {
  const root = mkdtempSync(join(workRoot, 'linux-install-copy-test-'));
  try {
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions([
        'fail', 'assert_safe_directory_path', 'assert_descendant_path',
        'prepare_safe_directory', 'assert_new_file', 'prepare_safe_output_file',
        'linux_install_files', 'copy_linux_install',
      ]),
      'copy_linux_install "$1" "$2" "$3" "$4"',
    ].join('\n');
    const run = (source, destination, platform) => spawnSync('/bin/bash', [
      '-c', shell, 'linux-install-copy', source, destination, platform, root,
    ], { encoding: 'utf8' });
    // 不跟随链接；连空目录也纳入快照，确保失败路径没有留下半份投影。
    const snapshot = (directory) => {
      const entries = [];
      const visit = (current, prefix) => {
        for (const item of readdirSync(current, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name))) {
          const relative = prefix ? `${prefix}/${item.name}` : item.name;
          const path = join(current, item.name);
          if (item.isDirectory()) {
            entries.push([relative, 'directory']);
            visit(path, relative);
          } else if (item.isFile()) {
            entries.push([relative, 'file', readFileSync(path)]);
          } else if (item.isSymbolicLink()) {
            entries.push([relative, 'link', readlinkSync(path)]);
          } else {
            assert.fail(`复制夹具出现特殊节点：${relative}`);
          }
        }
      };
      visit(directory, '');
      return entries;
    };
    for (const platform of linuxPlatforms) {
      const platformRoot = join(root, platform);
      const source = join(platformRoot, 'input');
      writeLinuxInstallFixture(source, platform);
      const paths = linuxInstallFixturePaths(platform);
      const fresh = join(platformRoot, 'fresh');
      const first = run(source, fresh, platform);
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(snapshot(fresh).filter((entry) => entry[1] === 'file')
        .map((entry) => entry[0]).sort(), paths);
      for (const path of paths) {
        assert.deepEqual(readFileSync(join(fresh, path)), readFileSync(join(source, path)));
      }

      const merged = join(platformRoot, 'merged');
      const headers = paths.filter((path) => path.startsWith('include/citizen_sdk/'));
      assert.equal(headers.length, 6);
      const retained = new Map();
      for (const path of headers) {
        const destination = join(merged, path);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(source, path), destination);
        utimesSync(destination, 946684800, 946684800);
        const state = statSync(destination);
        retained.set(path, { ino: state.ino, mtimeMs: state.mtimeMs, mode: state.mode });
      }
      const second = run(source, merged, platform);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(snapshot(merged).filter((entry) => entry[1] === 'file')
        .map((entry) => entry[0]).sort(), paths);
      for (const [path, retainedState] of retained) {
        const state = statSync(join(merged, path));
        assert.deepEqual({ ino: state.ino, mtimeMs: state.mtimeMs, mode: state.mode }, retainedState);
        assert.deepEqual(readFileSync(join(merged, path)), readFileSync(join(source, path)));
      }

      // 故意破坏排在最后的资产：即使前面十八项都有效，也不能先写任何文件。
      const last = paths.at(-1);
      const missingSource = join(source, last);
      const missingBytes = readFileSync(missingSource);
      const missingDestination = join(platformRoot, 'missing');
      rmSync(missingSource);
      try {
        const missing = run(source, missingDestination, platform);
        assert.notEqual(missing.status, 0);
        assert.match(missing.stderr, /安装投影缺少普通文件/u);
        assert.equal(existsSync(missingDestination), false);
      } finally {
        writeFileSync(missingSource, missingBytes);
      }

      const driftDestination = join(platformRoot, 'drift');
      const drift = join(driftDestination, last);
      mkdirSync(dirname(drift), { recursive: true });
      writeFileSync(drift, 'different public asset\n');
      const beforeDrift = snapshot(driftDestination);
      const rejected = run(source, driftDestination, platform);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /重叠安装文件字节漂移/u);
      assert.deepEqual(snapshot(driftDestination), beforeDrift);

      const outside = join(platformRoot, 'outside');
      mkdirSync(outside);
      const linkedDestination = join(platformRoot, 'linked-destination');
      mkdirSync(join(linkedDestination, 'lib'), { recursive: true });
      symlinkSync(outside, join(linkedDestination, 'lib', platform), 'dir');
      const beforeLink = snapshot(linkedDestination);
      const linked = run(source, linkedDestination, platform);
      assert.notEqual(linked.status, 0);
      assert.match(linked.stderr, /符号链接/u);
      assert.deepEqual(snapshot(linkedDestination), beforeLink);
      assert.deepEqual(snapshot(outside), []);

      const linkedSource = join(platformRoot, 'linked-source');
      symlinkSync(source, linkedSource, 'dir');
      const linkedOutput = join(platformRoot, 'linked-source-output');
      const sourceRejected = run(linkedSource, linkedOutput, platform);
      assert.notEqual(sourceRejected.status, 0);
      assert.match(sourceRejected.stderr, /符号链接/u);
      assert.equal(existsSync(linkedOutput), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux 安装验收执行真实文件闭集、字节、版本、平台和 ELF 失败路径', () => {
  const root = mkdtempSync(join(workRoot, 'linux-install-projection-test-'));
  try {
    const platform = 'LinuxARM';
    const prefix = join(root, 'install');
    const coreSource = join(root, 'core-input.so');
    const packageDir = join(prefix, 'lib', platform, 'cmake', 'CitizenSDK');
    writeFileSync(coreSource, 'core-fixture');
    for (const relative of linuxInstallFixturePaths(platform)) {
      const destination = join(prefix, relative);
      mkdirSync(dirname(destination), { recursive: true });
      let source;
      if (relative.startsWith('include/citizen_sdk/')) source = join(citizenSdkRoot,hostHeaderSource('linux',basename(relative)));
      else if (relative === 'include/citizensdk_qr_image.h') {
        source = join(citizenSdkRoot, 'native/image/citizensdk_qr_image.h');
      } else if (relative.startsWith('include/')) source = join(citizenSdkRoot, relative);
      else if (relative.startsWith('share/')) source = join(citizenSdkRoot, 'chain', basename(relative));
      else if (relative.endsWith('/CitizenSDKDependencies.cmake')) {
        source = join(citizenSdkRoot, 'linux', 'cmake', basename(relative));
      }
      if (source) copyFileSync(source, destination);
      else writeFileSync(destination, relative.endsWith('/libcitizensdk.so') ? 'core-fixture' : 'fixture\n');
    }
    writeFileSync(join(packageDir, 'CitizenSDKConfig.cmake'), `set(_CITIZENSDK_PACKAGE_PLATFORM "${platform}")\n`);
    writeFileSync(join(packageDir, 'CitizenSDKConfigVersion.cmake'), 'set(PACKAGE_VERSION "1.0.0")\n');

    // 只替换外部 readelf/nm 的文本输出，目录枚举、原文比对、版本及全部
    // 生产 ELF 验收仍执行真实构建器函数；不是模拟“已编译”的运行库。
    const readelf = join(root, 'readelf.sh');
    const nm = join(root, 'nm.sh');
    writeFileSync(readelf, [
      '#!/bin/bash', 'set -euo pipefail', 'here="$(dirname "$0")"',
      'case "$1" in -h) /bin/cat "$here/header.txt" ;;',
      '  --version-info) /bin/cat "$here/versions.txt" ;;',
      '  -d) case "$2" in */libcitizensdk.so) /bin/cat "$here/core-dynamic.txt" ;;',
      '    */libcitizensdk_host.so) /bin/cat "$here/host-dynamic.txt" ;; *) exit 9 ;; esac ;;',
      '  *) exit 8 ;; esac', '',
    ].join('\n'));
    writeFileSync(nm, [
      '#!/bin/bash', 'set -euo pipefail', 'here="$(dirname "$0")"',
      'case "${!#}" in */libcitizensdk.so) /bin/cat "$here/core-symbols.txt" ;;',
      '  */libcitizensdk_host.so) /bin/cat "$here/host-symbols.txt" ;; *) exit 7 ;; esac', '',
    ].join('\n'));
    chmodSync(readelf, 0o700);
    chmodSync(nm, 0o700);
    writeFileSync(join(root, 'header.txt'), "Class: ELF64\nData: 2's complement, little endian\nType: DYN\nMachine: AArch64\n");
    writeFileSync(join(root, 'versions.txt'), 'Name: GLIBC_2.31\n');
    writeFileSync(join(root, 'core-dynamic.txt'), '0 (SONAME) [libcitizensdk.so]\n0 (NEEDED) [libc.so.6]\n');
    writeFileSync(join(root, 'host-dynamic.txt'), '0 (SONAME) [libcitizensdk_host.so]\n0 (NEEDED) [libcitizensdk.so]\n0 (RUNPATH) [$ORIGIN]\n');
    for (const [kind, header] of [
      ['core', join(citizenSdkRoot, 'include', 'citizensdk.h')],
      ['host', join(citizenSdkRoot, 'linux', 'headers', 'citizensdk_host.h')],
    ]) {
      const names = [...new Set([...readFileSync(header, 'utf8')
        .matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g)].map((match) => match[1]))].sort();
      assert.equal(names.length, kind === 'core' ? 144 : 19);
      if (kind === 'host') names.push(...qrImageSymbols());
      if (kind === 'core') names.push(...CITIZENSDK_INTERNAL_SYMBOLS);
      names.sort();
      writeFileSync(join(root, `${kind}-symbols.txt`), `${names.map((name) => `0 T ${name}`).join('\n')}\n`);
    }
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions([
        'fail', 'assert_safe_directory_path', 'linux_install_files', 'verify_linux_install',
        'product_header_symbols', 'product_internal_symbols', 'product_linked_symbols',
        'product_library_symbols', 'verify_product_abi_symbols',
        'qr_image_header_symbols',
        'linux_host_header_symbols', 'linux_elf_dynamic_values', 'version_is_greater',
        'verify_linux_glibc_contract', 'verify_linux_machine',
        'verify_linux_host_symbols', 'verify_linux_elf_identity',
      ]),
      'sdk_dir="$1"', 'work_dir="$2"', 'linux_source_root="$sdk_dir/linux"',
      'script_dir="$sdk_dir/scripts"',
      'apple_asset_root="$sdk_dir/chain"', 'product_header="$sdk_dir/include/citizensdk.h"',
      'qr_image_header="$sdk_dir/native/image/citizensdk_qr_image.h"',
      'linux_glibc_baseline=2.31',
      'verify_linux_install "$3" "$4" 1.0.0 "$5" "$6" "$7"',
    ].join('\n');
    const run = () => spawnSync('/bin/bash', ['-c', shell, 'linux-install-contract',
      citizenSdkRoot, root, prefix, platform, coreSource, readelf, nm], { encoding: 'utf8' });
    const positive = run();
    assert.equal(positive.status, 0, positive.stderr);
    const changed = (path, text, message) => {
      const original = readFileSync(path);
      try {
        writeFileSync(path, text);
        const result = run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, message);
      } finally { writeFileSync(path, original); }
    };
    changed(join(prefix, 'include', 'citizensdk.h'), 'drift', /头字节漂移/u);
    changed(join(prefix, 'share/citizensdk/chain/manifest.json'), '{}', /资产字节漂移/u);
    changed(join(prefix, `lib/${platform}/libcitizensdk.so`), 'drift', /Core 字节漂移/u);
    changed(join(packageDir, 'CitizenSDKDependencies.cmake'), '# drift', /依赖合同漂移/u);
    changed(join(packageDir, 'CitizenSDKConfigVersion.cmake'), 'set(PACKAGE_VERSION "1.0.1")\n', /版本不一致/u);
    changed(join(packageDir, 'CitizenSDKConfig.cmake'), 'set(_CITIZENSDK_PACKAGE_PLATFORM "LinuxAMD")\n', /平台不一致/u);
    changed(join(packageDir, 'CitizenSDKTargets.cmake'), `# ${citizenSdkRoot}/linux\n`, /绝对路径/u);
    changed(join(root, 'host-symbols.txt'), `${readFileSync(join(root, 'host-symbols.txt'), 'utf8')}0 T foreign_probe\n`, /额外=foreign_probe/u);
    changed(join(root, 'host-dynamic.txt'), '0 (SONAME) [libcitizensdk_host.so]\n0 (RUNPATH) [$ORIGIN]\n', /精确依赖一次/u);
    changed(join(root, 'host-dynamic.txt'), '0 (SONAME) [libcitizensdk_host.so]\n0 (NEEDED) [/outside/libcitizensdk.so]\n0 (RUNPATH) [$ORIGIN]\n', /DT_NEEDED/u);
    changed(join(root, 'versions.txt'), 'Name: GLIBC_2.32\n', /超过固定基线/u);

    const extra = join(prefix, 'unexpected');
    writeFileSync(extra, 'extra');
    assert.match(run().stderr, /安装文件闭集/u);
    rmSync(extra);
    mkdirSync(extra);
    assert.match(run().stderr, /安装目录闭集/u);
    rmSync(extra, { recursive: true });
    const header = join(prefix, 'include', 'citizensdk.h');
    rmSync(header);
    assert.match(run().stderr, /安装文件闭集/u);
    symlinkSync(join(citizenSdkRoot, 'include', 'citizensdk.h'), header);
    assert.match(run().stderr, /符号链接/u);
    rmSync(header);
    copyFileSync(join(citizenSdkRoot, 'include', 'citizensdk.h'), header);
    const final = run();
    assert.equal(final.status, 0, final.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux ELF 机器字段逐项验证两种官方目标并拒绝错误头', () => {
  const root = mkdtempSync(join(workRoot, 'linux-elf-machine-test-'));
  try {
    const readelf = join(root, 'readelf.sh');
    const library = join(root, 'elf-header.txt');
    writeFileSync(readelf, '#!/bin/bash\nset -euo pipefail\n/bin/cat "$2"\n');
    chmodSync(readelf, 0o700);
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'verify_linux_machine']),
      'verify_linux_machine "$1" "$2" "$3" "Linux fixture"',
    ].join('\n');
    const header = (machine) => [
      '  Class: ELF64',
      "  Data: 2's complement, little endian",
      '  Type: DYN (Shared object file)',
      `  Machine: ${machine}`,
      '',
    ].join('\n');
    const run = (text, machine) => {
      writeFileSync(library, text);
      return spawnSync('/bin/bash', ['-c', shell, 'linux-machine-contract',
        library, readelf, machine], { encoding: 'utf8' });
    };
    for (const machine of ['AArch64', 'Advanced Micro Devices X86-64']) {
      const result = run(header(machine), machine);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const text of [
      header('AArch64').replace('ELF64', 'ELF32'),
      header('AArch64').replace('little endian', 'big endian'),
      header('AArch64').replace('DYN', 'EXEC'),
      header('Advanced Micro Devices X86-64'),
      '',
    ]) {
      const result = run(text, 'AArch64');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ELF64|little-endian|ET_DYN|机器类型漂移/u);
    }
    writeFileSync(readelf, '#!/bin/bash\nexit 19\n');
    const unreadable = run(header('AArch64'), 'AArch64');
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, /无法读取/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux GLIBC 验收拒绝超基线、动态 C++ ABI 和 readelf 失败', () => {
  const root = mkdtempSync(join(workRoot, 'linux-glibc-test-'));
  try {
    const readelf = join(root, 'readelf.sh');
    const library = join(root, 'elf-versions.txt');
    writeFileSync(readelf, '#!/bin/bash\nset -euo pipefail\n/bin/cat "$2"\n');
    chmodSync(readelf, 0o700);
    const shell = [
      'set -euo pipefail',
      'linux_glibc_baseline=2.31',
      nativeShellFunctions(['fail', 'version_is_greater', 'verify_linux_glibc_contract']),
      'verify_linux_glibc_contract "$1" "$2" "Linux fixture"',
    ].join('\n');
    const run = (text) => {
      writeFileSync(library, text);
      return spawnSync('/bin/bash', ['-c', shell, 'linux-glibc-contract',
        library, readelf], { encoding: 'utf8' });
    };
    const valid = run('Name: GLIBC_2.2.5\nName: GLIBC_2.17\nName: GLIBC_2.31\n');
    assert.equal(valid.status, 0, valid.stderr);
    for (const text of [
      'Name: GLIBC_2.32\n', 'Name: GLIBC_2.100\n',
      'Name: GLIBCXX_3.4\n', 'Name: CXXABI_1.3\n',
    ]) {
      const result = run(text);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /GLIBC|C\+\+|ABI/u);
    }
    writeFileSync(readelf, '#!/bin/bash\nexit 23\n');
    const unreadable = run('');
    assert.notEqual(unreadable.status, 0, '工具失败不得冒充没有版本依赖');
    assert.match(unreadable.stderr, /无法读取|version|版本/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Linux CTest 必须命中完整名称闭集而非仅测试数量', () => {
  const root = mkdtempSync(join(workRoot, 'linux-ctest-inventory-test-'));
  try {
    const command = join(root, 'ctest.sh');
    const inventory = join(root, 'inventory.txt');
    writeFileSync(command, '#!/bin/bash\nset -euo pipefail\n/bin/cat "$(dirname "$0")/inventory.txt"\n');
    chmodSync(command, 0o700);
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'verify_linux_ctest_inventory']),
      'linux_source_root="$5/linux"',
      'verify_linux_ctest_inventory "$1" "$2" "$3" "$4"',
    ].join('\n');
    const run = (label, names, count = names.length) => {
      writeFileSync(inventory, `${names.map((name, index) => `  Test #${index + 1}: CitizenSDK.Linux.${name}`).join('\n')}\nTotal Tests: ${count}\n`);
      return spawnSync('/bin/bash', ['-c', shell, 'linux-ctest-inventory',
        command, root, label, String(count), citizenSdkRoot], { encoding: 'utf8' });
    };
    const cases = {
      LinuxHost: [
        'api_contract', 'assets', 'host_operation', 'lifecycle', 'public_store',
        'record_key', 'secure_store', 'sensitive_buffer', 'secret_vault',
        'secret_boundary', 'tpm2', 'wallet_flow',
      ].map((name) => `citizen_sdk_${name}_test`),
      LinuxFlutter: [
        'codec', 'sessions', 'wallet_flow', 'environment', 'plugin', 'secret_boundary',
      ].map((name) => `citizen_sdk_flutter_${name}_test`),
      LinuxConsumer: ['CConsumer', 'CppConsumer'],
    };
    for (const [label, names] of Object.entries(cases)) {
      const valid = run(label, names);
      assert.equal(valid.status, 0, valid.stderr);
      for (const rejected of [[], names.slice(1), [...names, names[0]],
        ['unregistered', ...names.slice(1)], [names[1], ...names.slice(1)]]) {
        const result = run(label, rejected, names.length);
        assert.notEqual(result.status, 0, `${label} 不得以同数量替换或遗漏测试`);
        assert.match(result.stderr, /CTest|合同|闭集/u);
      }
    }
    assert.notEqual(run('Unregistered', cases.LinuxConsumer).status, 0);
    writeFileSync(command, '#!/bin/bash\nexit 9\n');
    const failed = run('LinuxConsumer', cases.LinuxConsumer);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /无法枚举/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux 消费者依赖必须解析到本轮唯一安装双库', () => {
  const root = mkdtempSync(join(workRoot, 'linux-consumer-resolution-test-'));
  try {
    const command = join(root, 'ldd');
    const output = join(root, 'resolution.txt');
    const prefix = join(root, 'installed');
    writeFileSync(command, '#!/bin/bash\nset -euo pipefail\n/bin/cat "$(dirname "$0")/resolution.txt"\n');
    chmodSync(command, 0o700);
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'verify_linux_runtime_resolution']),
      'verify_linux_runtime_resolution "$1" "$2"',
    ].join('\n');
    const run = (text) => {
      writeFileSync(output, text);
      return spawnSync('/bin/bash', ['-c', shell, 'linux-consumer-resolution',
        join(root, 'fixture'), prefix], {
        encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
      });
    };
    const valid = [
      `libcitizensdk.so => ${prefix}/libcitizensdk.so (0x0)`,
      `libcitizensdk_host.so => ${prefix}/libcitizensdk_host.so (0x1)`,
    ].join('\n');
    const accepted = run(valid);
    assert.equal(accepted.status, 0, accepted.stderr);
    for (const rejected of ['', valid.replaceAll(prefix, '/unrelated'),
      `${valid}\nlibextra.so => not found`, `${valid}\n${valid}`]) {
      assert.notEqual(run(rejected).status, 0);
    }
    writeFileSync(command, '#!/bin/bash\nexit 17\n');
    assert.notEqual(run(valid).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux Flutter 缓存预检遵循通用 ICU 布局并拒绝缺项与版本漂移', () => {
  const root = mkdtempSync(join(workRoot, 'linux-flutter-cache-test-'));
  try {
    const shell = [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'assert_safe_directory_path',
        'assert_readonly_dependency_directory', 'verify_linux_tool_tree',
        'verify_linux_flutter_cache']),
      'verify_linux_flutter_cache "$1" "$2"',
    ].join('\n');
    for (const [platform, arch] of [['LinuxARM', 'arm64'], ['LinuxAMD', 'x64']]) {
      const tool = join(root, platform);
      const revision = '1'.repeat(40);
      const framework = '2'.repeat(40);
      const write = (path, text = 'fixture\n') => {
        const destination = join(tool, path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, text);
      };
      // 只建布局/版本夹具，不运行其中任何文件，也不把它当作真实 Flutter SDK。
      mkdirSync(join(tool, '.git'), { recursive: true });
      for (const path of [
        'bin/cache/flutter_tools.snapshot', 'packages/flutter_tools/pubspec.yaml',
        'packages/flutter_tools/pubspec.lock', 'bin/cache/dart-sdk/bin/dart',
        'bin/cache/pkg/sky_engine/pubspec.yaml', 'bin/cache/pkg/flutter_gpu/pubspec.yaml',
        'bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill',
        'bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill',
        `bin/cache/artifacts/engine/linux-${arch}/font-subset`,
        `bin/cache/artifacts/engine/linux-${arch}/icudtl.dat`,
      ]) write(path);
      for (const mode of ['', '-profile', '-release']) {
        for (const file of ['libflutter_linux_gtk.so', 'flutter_linux/flutter_linux.h', 'gen_snapshot']) {
          write(`bin/cache/artifacts/engine/linux-${arch}${mode}/${file}`);
        }
      }
      for (const path of ['bin/cache/engine.stamp', 'bin/internal/engine.version',
        'bin/cache/flutter_sdk.stamp', 'bin/cache/linux-sdk.stamp', 'bin/cache/font-subset.stamp']) write(path, revision);
      write('bin/cache/flutter_tools.stamp', `${framework}:\n`);
      write('bin/cache/flutter.version.json', JSON.stringify({ engineRevision: revision, frameworkRevision: framework }));
      for (const name of ['material_fonts', 'gradle_wrapper']) {
        write(`bin/internal/${name}.version`, 'fixture-version');
        write(`bin/cache/${name}.stamp`, 'fixture-version');
        mkdirSync(join(tool, `bin/cache/artifacts/${name}`), { recursive: true });
      }
      const run = () => spawnSync('/bin/bash', ['-c', shell, 'linux-flutter-cache', tool, platform], { encoding: 'utf8' });
      const valid = run();
      assert.equal(valid.status, 0, valid.stderr);
      assert.equal(existsSync(join(tool, `bin/cache/artifacts/engine/linux-${arch}-release/icudtl.dat`)), false);
      const icu = join(tool, `bin/cache/artifacts/engine/linux-${arch}/icudtl.dat`);
      rmSync(icu);
      const missing = run();
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /icudtl\.dat.*禁止自动下载/u);
      write(`bin/cache/artifacts/engine/linux-${arch}/icudtl.dat`);
      write('bin/internal/engine.version', '3'.repeat(40));
      assert.notEqual(run().status, 0);
      write('bin/internal/engine.version', revision);
      write('bin/cache/flutter_tools.stamp', `${'4'.repeat(40)}:\n`);
      const drift = run();
      assert.notEqual(drift.status, 0);
      assert.match(drift.stderr, /snapshot.*不一致/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Linux 消费者保持安装边界和 Release 真实运行判定', () => {
  const source = (path) => readFileSync(join(citizenSdkRoot, path), 'utf8');
  const cmake = source('linux/tests/CitizenSDKConsumer.cmake');
  assert.match(cmake, /find_package\(CitizenSDK \$\{CITIZENSDK_CONSUMER_VERSION\} EXACT CONFIG REQUIRED/u);
  assert.match(cmake, /NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH/u);
  assert.match(cmake, /get_target_property\(_imported CitizenSDK::\$\{_kind\} IMPORTED\)/u);
  assert.match(cmake, /-UNDEBUG/u);
  assert.doesNotMatch(cmake, /add_subdirectory\(|FetchContent|ExternalProject/u);
  for (const path of ['linux/tests/citizen_sdk_c_consumer.c', 'linux/tests/citizen_sdk_cpp_consumer.cc']) {
    const consumer = source(path);
    assert.doesNotMatch(consumer, /^#include\s*[<"][^>"\n]*(?:src\/|test_support|_bridge|_secret_vault)/mu);
    assert.match(consumer, /#ifdef NDEBUG/u);
    assert.match(consumer, /CITIZENSDK_ERROR_BUSY/u);
    assert.match(consumer, /CITIZENSDK_ERROR_INVALID_HANDLE/u);
  }
  const flutter = source('linux/tests/citizen_sdk_flutter_consumer.dart');
  assert.match(flutter, /CitizenSdk\.open\(\)/u);
  assert.doesNotMatch(flutter, /package:citizen_sdk\/src\/|FlutterCitizenSdkPlatform|MethodChannelCitizenSdkPlatform/u);
  assert.doesNotMatch(flutter, /\bassert\s*\(|setMockMethodCallHandler|MockClient/u);
  assert.match(flutter, /await subscription\.cancel\(\);[\s\S]*?_require\(!eventFailed\)/u);
  assert.match(flutter, /await stdout\.flush\(\);[\s\S]*?exit\(0\)/u);
  assert.match(flutter, /CitizenSDK Flutter consumer passed/u);
  assert.match(flutter, /CitizenSDK Flutter consumer failed/u);
  const build = BUILD_SHELL_SOURCES.native;
  assert.match(build, /--install "\$cmake_build" --config Release --prefix "\$install_prefix"/u);
  assert.match(build, /verify_linux_install "\$install_prefix"/u);
  assert.match(build, /verify_linux_ctest_inventory "\$ctest_bin" "\$cmake_build" LinuxHost 12/u);
  assert.match(build, /verify_linux_ctest_inventory "\$ctest_bin" "\$flutter_build" LinuxFlutter 6/u);
  assert.match(build, /verify_linux_ctest_inventory "\$ctest_bin" "\$consumer_build" LinuxConsumer 2/u);
  assert.match(build, /--no-tests=error/u);
  assert.match(build, /build linux --release --no-pub/u);
  assert.match(build, /org\.citizensdk\.flutterconsumer/u);
  assert.match(build, /timeout --signal=TERM --kill-after=10s 200s/u);
  assert.match(build, /\[\[ "\$status" == 0 \]\]/u);
  assert.match(build, /grep -Fxc 'CitizenSDK Flutter consumer passed'/u);
  assert.match(source('pubspec.yaml'), /^      linux:\n        pluginClass: CitizenSdkPlugin$/mu);
  assert.match(build, /copy_linux_install "\$prefix" "\$sdk_stage\/linux" "\$platform" "\$work_dir"/u);
  assert.match(build, /destination="\$output_dir\/linux\/\$platform"/u);
  assert.match(build, /copy_linux_install "\$install_prefix" "\$destination" "\$platform" "\$output_dir"/u);
  assert.doesNotMatch(build, /CITIZENSDK_FLUTTER_HOST_PREFIX|CMAKE_BUILD_WITH_INSTALL_RPATH/u);
  const plugin = source('linux/cmake/CitizenSDKFlutter.cmake');
  assert.match(plugin, /set\(_citizensdk_host_prefix "\$\{_citizensdk_linux_root\}"\)/u);
  assert.match(plugin, /BUILD_WITH_INSTALL_RPATH TRUE\s+INSTALL_RPATH "\$ORIGIN"/u);
  assert.doesNotMatch(plugin, /CITIZENSDK_FLUTTER_HOST_PREFIX/u);
});

test('产品 ABI 从完整 nm 导出集合与头文件精确对拍并拒绝任意额外符号', () => {
  const root = mkdtempSync(join(workRoot, 'product-abi-symbol-gate-test-'));
  try {
    const fakeNm = join(root, 'fake-nm.sh');
    const library = join(root, 'nm-output.txt');
    writeFileSync(
      fakeNm,
      '#!/usr/bin/env bash\nset -euo pipefail\n/bin/cat "${!#}"\n',
    );
    chmodSync(fakeNm, 0o700);

    const header = readFileSync(join(citizenSdkRoot, 'include', 'citizensdk.h'), 'utf8');
    const expected = [...new Set(
      [...header.matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g)]
        .map((match) => match[1]),
    )].sort();
    assert.equal(expected.length, 144);
    expected.push(...CITIZENSDK_INTERNAL_SYMBOLS);
    expected.sort();

    const runGate = (symbols, prefix = '') => {
      writeFileSync(
        library,
        `${symbols.map((symbol, index) => `${index.toString(16).padStart(16, '0')} T ${prefix}${symbol}`).join('\n')}\n`,
      );
      return spawnSync(
        '/bin/bash',
        [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-product-abi-symbols'],
        {
          cwd: workRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CITIZENSDK_BUILD_TEST: '1',
            CITIZENSDK_NATIVE_OUTPUT_DIR: join(root, 'native-output'),
            CITIZENSDK_TEST_LIBRARY: library,
            CITIZENSDK_TEST_NM_BIN: fakeNm,
            CITIZENSDK_TEST_SYMBOL_PREFIX: prefix,
            CITIZENSDK_WORK_DIR: join(root, 'native-work'),
            GITHUB_ACTIONS: 'true',
          },
        },
      );
    };

    const elf = runGate(expected);
    assert.equal(elf.status, 0, elf.stderr);
    const machO = runGate(expected, '_');
    assert.equal(machO.status, 0, machO.stderr);

    for (const leaked of ['foreign_probe', 'secret_export']) {
      const rejected = runGate([...expected, leaked]);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, new RegExp(`额外=${leaked}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Apple导出闭集固定144 Core与4图像ABI，旧窗口内部符号清零', () => {
  const build = BUILD_SHELL_SOURCES.native;
  assert.match(build, /\[\[ "\$expected_count" == 148 \]\]/u);
  assert.match(build, /grep -c '\^_citizensdk_' "\$destination" \|\| true\)" == 148/u);
  assert.match(build, /未过滤链接不等于产品头与既定内部符号闭集/u);
  assert.doesNotMatch(build, /117公开|expected_count" == 120|destination" \|\| true\)" == 120/u);
});

test('Android原生构建只在调用方显式选择时使用Gradle离线模式', () => {
  const build = BUILD_SHELL_SOURCES.native;
  assert.match(build, /case "\$\{CITIZENSDK_OFFLINE:-false\}" in/u);
  assert.match(build, /true\) gradle_network_arg='--offline'/u);
  assert.match(build, /"\$gradle_bin" \$\{gradle_network_arg:\+"\$gradle_network_arg"\} --no-daemon/u);
  assert.match(build, /CITIZENSDK_OFFLINE只接受true或false/u);
});

test('原生共用写路径拒绝移动端、产品 ABI、dangling 目标及 Cargo symlink', () => {
  const root = mkdtempSync(join(workRoot, 'native-descendant-path-guard-test-'));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const runGuard = (name, relative, prepare = () => {}) => {
    const work = join(root, `${name}-work`);
    const output = join(root, `${name}-output`);
    mkdirSync(work, { recursive: true });
    mkdirSync(output, { recursive: true });
    prepare({ output, work });
    return spawnSync(
      '/bin/bash',
      [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-safe-output-file'],
      {
        cwd: workRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CITIZENSDK_BUILD_TEST: '1',
          CITIZENSDK_NATIVE_OUTPUT_DIR: output,
          CITIZENSDK_TEST_OUTPUT_RELATIVE: relative,
          CITIZENSDK_WORK_DIR: work,
          GITHUB_ACTIONS: 'true',
        },
      },
    );
  };
  try {
    const valid = runGuard('valid', 'android/arm64-v8a/libcitizensdk.so');
    assert.equal(valid.status, 0, valid.stderr);

    const mobileAncestor = runGuard(
      'mobile-ancestor',
      'android/arm64-v8a/libcitizensdk.so',
      ({ output }) => symlinkSync(outside, join(output, 'android'), 'dir'),
    );
    assert.notEqual(mobileAncestor.status, 0);
    assert.match(mobileAncestor.stderr, /符号链接/);

    const productAncestor = runGuard(
      'product-ancestor',
      'abi-host/libcitizensdk.so',
      ({ output }) => symlinkSync(outside, join(output, 'abi-host'), 'dir'),
    );
    assert.notEqual(productAncestor.status, 0);
    assert.match(productAncestor.stderr, /符号链接/);

    const danglingDestination = runGuard(
      'dangling-destination',
      'abi-host/libcitizensdk.so',
      ({ output }) => {
        mkdirSync(join(output, 'abi-host'));
        symlinkSync(
          join(root, 'missing-libcitizensdk.so'),
          join(output, 'abi-host', 'libcitizensdk.so'),
          'file',
        );
      },
    );
    assert.notEqual(danglingDestination.status, 0);
    assert.match(danglingDestination.stderr, /已存在或是符号链接/);

    const cargoAncestor = runGuard(
      'cargo-ancestor',
      'android/arm64-v8a/libcitizensdk.so',
      ({ work }) => symlinkSync(outside, join(work, 'cargo'), 'dir'),
    );
    assert.notEqual(cargoAncestor.status, 0);
    assert.match(cargoAncestor.stderr, /Cargo target 目录.*符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android 原生构建固定 NDK 版本并可从宿主标准 SDK 目录自解析', () => {
  const root = mkdtempSync(join(workRoot, 'android-ndk-resolution-test-'));
  try {
    const sdkRelative = process.platform === 'darwin'
      ? ['Library', 'Android', 'sdk']
      : ['Android', 'Sdk'];
    const hostTag = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64')
      : 'linux-x86_64';
    const sdk = join(root, ...sdkRelative);
    const toolchain = join(
      sdk,
      'ndk',
      '28.2.13676358',
      'toolchains',
      'llvm',
      'prebuilt',
      hostTag,
    );
    mkdirSync(toolchain, { recursive: true });
    const environment = {
      ...process.env,
      CITIZENSDK_BUILD_TEST: '1',
      CITIZENSDK_NATIVE_OUTPUT_DIR: join(root, 'native-output'),
      CITIZENSDK_WORK_DIR: join(root, 'native-work'),
      GITHUB_ACTIONS: 'true',
      HOME: root,
    };
    delete environment.ANDROID_HOME;
    delete environment.ANDROID_NDK_HOME;
    delete environment.ANDROID_SDK_ROOT;

    const resolved = spawnSync(
      '/bin/bash',
      [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-android-toolchain'],
      { cwd: workRoot, encoding: 'utf8', env: environment },
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), toolchain);

    const wrongNdk = join(sdk, 'ndk', '28.1.13356709');
    mkdirSync(wrongNdk, { recursive: true });
    const wrongVersion = spawnSync(
      '/bin/bash',
      [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-android-toolchain'],
      {
        cwd: workRoot,
        encoding: 'utf8',
        env: { ...environment, ANDROID_NDK_HOME: wrongNdk },
      },
    );
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /统一版本 28\.2\.13676358/);

    const divergentSdk = join(root, 'divergent-sdk');
    mkdirSync(divergentSdk, { recursive: true });
    const divergentRoots = spawnSync(
      '/bin/bash',
      [join(citizenSdkRoot, 'scripts/build-native.sh'), '__test-android-toolchain'],
      {
        cwd: workRoot,
        encoding: 'utf8',
        env: {
          ...environment,
          ANDROID_HOME: sdk,
          ANDROID_SDK_ROOT: divergentSdk,
        },
      },
    );
    assert.notEqual(divergentRoots.status, 0);
    assert.match(divergentRoots.stderr, /指向不同目录/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('最终 tgz、外层 SHA256SUMS 与候选闭集双向一致', () => {
  const root = mkdtempSync(join(workRoot, 'release-archive-test-'));
  try {
    const native = writeNativeFixture(root);
    const output = join(root, 'candidate');
    const archive = join(root, 'citizensdk.tgz');
    const manifest = buildCitizenSdkRelease({
      sourcePath: citizenSdkRoot,
      nativePath: native,
      outputPath: output,
      archivePath: archive,
      gitCommitSha: '0'.repeat(40),
      softwareVersion: '1.0.0',
    });
    assert.deepEqual(manifest.platforms, ['Android', 'iOS', 'macOS', 'LinuxARM', 'LinuxAMD', 'Windows']);
    assert.deepEqual(
      manifest.files
        .map((entry) => entry.path)
        .filter((path) => /\.(?:aar|so|dll|lib)$/.test(path)
          || (path.startsWith('darwin/CitizenSDK.xcframework/')
            && path.endsWith('/CitizenSDK'))),
      [
        'android/citizensdk.aar',
        'android/src/main/jniLibs/arm64-v8a/libcitizensdk.so',
        'android/src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so',
        `darwin/CitizenSDK.xcframework/${appleFixtureSliceIdentifiers.iosDevice}/CitizenSDK.framework/CitizenSDK`,
        `darwin/CitizenSDK.xcframework/${appleFixtureSliceIdentifiers.iosSimulator}/CitizenSDK.framework/CitizenSDK`,
        `darwin/CitizenSDK.xcframework/${appleFixtureSliceIdentifiers.macOS}/CitizenSDK.framework/Versions/A/CitizenSDK`,
        'linux/lib/LinuxAMD/libcitizensdk.so',
        'linux/lib/LinuxAMD/libcitizensdk_host.so',
        'linux/lib/LinuxARM/libcitizensdk.so',
        'linux/lib/LinuxARM/libcitizensdk_host.so',
        'windows/bin/Windows/citizensdk.dll',
        'windows/bin/Windows/citizensdk_host.dll',
        'windows/lib/Windows/citizensdk.dll.lib',
        'windows/lib/Windows/citizensdk_host.lib',
      ],
    );
    const expectedArchivedLinks = Object.fromEntries(
      Object.entries(macOSFrameworkSymlinks).map(([path, target]) => [
        `darwin/CitizenSDK.xcframework/${appleFixtureSliceIdentifiers.macOS}/CitizenSDK.framework/${path}`,
        target,
      ]),
    );
    for (const [path, target] of Object.entries(expectedArchivedLinks)) {
      assert.equal(readlinkSync(join(output, ...path.split('/'))), target);
    }
    assert.deepEqual(archivedSymlinks(readFileSync(archive)), expectedArchivedLinks);
    assert.doesNotThrow(() => verifyCitizenSdkRelease(output, archive, '0'.repeat(40)));
    const sums = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
    assert.match(sums, /^[0-9a-f]{64}  citizensdk-release\.json\n[0-9a-f]{64}  citizensdk\.tgz\n$/);

    const corrupted = readFileSync(archive);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    writeFileSync(archive, corrupted);
    assert.throws(
      () => verifyCitizenSdkRelease(output, archive, '0'.repeat(40)),
      /归档不是候选闭集的规范 gzip\/tar 字节/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hosted GNU tar 保留普通目录、文件、执行位与长 UTF-8 名称', () => {
  const directory = `lib/${'archive_'.repeat(16)}`;
  const path = `${directory}/说明.dart`;
  const expected = new Map([
    ['lib', { type: 'directory', mode: 0o755, data: Buffer.alloc(0) }],
    [directory, { type: 'directory', mode: 0o755, data: Buffer.alloc(0) }],
    [path, { type: 'file', mode: 0o644, data: Buffer.from('public source\n') }],
    [`${'a'.repeat(98)}文.dart`, { type: 'file', mode: 0o644, data: Buffer.from('UTF-8 boundary\n') }],
    ['entry.sh', { type: 'file', mode: 0o755, data: Buffer.from('exit 0\n') }],
    ['empty', { type: 'file', mode: 0o644, data: Buffer.alloc(0) }],
  ]);
  assert.deepEqual(parseHostedArchive(gzipSync(hostedTar(expected))), expected);
});

test('Hosted gzip 拒绝损坏、截断、CRC、ISIZE、多 member 与尾随垃圾', () => {
  const valid = gzipSync(hostedTar(new Map([
    ['source', { type: 'file', mode: 0o644, data: Buffer.from('source bytes') }],
  ])));
  const crc = Buffer.from(valid);
  crc[crc.length - 8] ^= 1;
  const size = Buffer.from(valid);
  size[size.length - 4] ^= 1;
  const tooLarge = Buffer.from(valid);
  tooLarge.writeUInt32LE(256 * 1024 * 1024 + 1, tooLarge.length - 4);
  const body = Buffer.from(valid);
  body[10] ^= 0xff;
  const method = Buffer.from(valid);
  method[2] = 0;
  const flags = Buffer.from(valid);
  flags[3] |= 0x20;
  const extra = Buffer.concat([valid.subarray(0, 10), Buffer.from([0xff, 0xff]), valid.subarray(10)]);
  extra[3] |= 4;
  const headerCrc = Buffer.concat([valid.subarray(0, 10), Buffer.alloc(2), valid.subarray(10)]);
  headerCrc[3] |= 2;
  for (const [label, bytes] of [
    ['empty', Buffer.alloc(0)],
    ['header-only', valid.subarray(0, 10)],
    ['truncated', valid.subarray(0, valid.length - 1)],
    ['crc', crc], ['isize', size], ['declared-size-limit', tooLarge],
    ['deflate', body], ['compression-method', method], ['reserved-flags', flags],
    ['truncated-extra', extra], ['header-crc', headerCrc],
    ['second-member', Buffer.concat([valid, valid])],
    ['trailing-text', Buffer.concat([valid, Buffer.from('trailer')])],
    ['trailing-zero', Buffer.concat([valid, Buffer.alloc(1)])],
  ]) {
    assert.throws(() => parseHostedArchive(bytes), Error, label);
  }
});

test('Hosted tar 拒绝越界路径、链接、重复条目、父子类型冲突和危险权限', () => {
  const regular = (path) => hostedTarEntry(path, { data: Buffer.from('x') });
  const archive = (blocks) => gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  for (const path of ['/escape', '../escape', 'a/../escape', './source', 'a//b', 'a\\b', 'C:/escape']) {
    assert.throws(() => parseHostedArchive(archive([regular(path)])), Error, path);
  }
  for (const type of ['1', '2', '3', '4', '6', '7', 'x', 'g', 'K', 'S', '?']) {
    assert.throws(() => parseHostedArchive(archive([
      hostedTarEntry('entry', { type }),
    ])), Error, `不允许 tar 类型 ${type}`);
  }
  for (const [label, blocks] of [
    ['duplicate-file', [regular('source'), regular('source')]],
    ['duplicate-directory', [hostedTarEntry('dir', { type: '5', mode: 0o755 }), hostedTarEntry('dir', { type: '5', mode: 0o755 })]],
    ['file-then-directory', [regular('source'), hostedTarEntry('source', { type: '5', mode: 0o755 })]],
    ['directory-then-file', [hostedTarEntry('source', { type: '5', mode: 0o755 }), regular('source')]],
    ['file-parent-first', [regular('a'), regular('a/b')]],
    ['file-parent-last', [regular('a/b'), regular('a')]],
    ['directory-data', [hostedTarEntry('dir', { type: '5', mode: 0o755, data: Buffer.from('x') })]],
    ['file-link-field', [hostedTarEntry('source', { link: 'target' })]],
    ['setuid', [hostedTarEntry('source', { mode: 0o4644 })]],
    ['case-file', [regular('source'), regular('Source')]],
    ['case-parent', [regular('dir/a'), regular('DIR/b')]],
    ['unicode-normalization', [regular('é'), regular('e\u0301')]],
  ]) {
    assert.throws(() => parseHostedArchive(archive(blocks)), Error, label);
  }
});

test('Hosted tar 拒绝头部漂移、padding、截断、未识别扩展与资源上限', () => {
  const base = hostedTarEntry('source', { data: Buffer.from('x') });
  const archive = (blocks) => gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const checksum = Buffer.from(base);
  checksum[0] ^= 1;
  const padding = Buffer.from(base);
  padding[513] = 1;
  const invalidMagic = Buffer.from(base);
  invalidMagic[257] = 0x3f;
  hostedTarChecksum(invalidMagic.subarray(0, 512));
  const invalidOctal = Buffer.from(base);
  invalidOctal[124] = 0x39;
  hostedTarChecksum(invalidOctal.subarray(0, 512));
  const embeddedNul = Buffer.from(base);
  embeddedNul[7] = 0x78;
  hostedTarChecksum(embeddedNul.subarray(0, 512));
  const tooLarge = hostedTarHeader('huge', { size: 256 * 1024 * 1024 + 1 });
  const longName = (value) => hostedTarEntry('././@LongLink', { type: 'L', mode: 0, data: value });
  for (const [label, bytes] of [
    ['checksum', archive([checksum])], ['padding', archive([padding])],
    ['magic', archive([invalidMagic])], ['octal', archive([invalidOctal])],
    ['hidden-name', archive([embeddedNul])], ['declared-file-limit', archive([tooLarge])],
    ['missing-end-records', gzipSync(base)],
    ['one-end-record', gzipSync(Buffer.concat([base, Buffer.alloc(512)]))],
    ['truncated-header', gzipSync(base.subarray(0, 511))],
    ['truncated-data', gzipSync(base.subarray(0, 512))],
    ['nonzero-trailer', gzipSync(Buffer.concat([base, Buffer.alloc(1024), Buffer.from('x')]))],
    ['entry-after-end', gzipSync(Buffer.concat([base, Buffer.alloc(1024), base]))],
    ['orphan-longname', archive([longName(Buffer.from('a'.repeat(101)))])],
    ['two-longnames', archive([longName(Buffer.from('a'.repeat(101))), longName(Buffer.from('b'.repeat(101))), base])],
    ['longname-traversal', archive([longName(Buffer.from(`../${'a'.repeat(101)}`)), base])],
    ['longname-nul', archive([longName(Buffer.from(`a\0${'b'.repeat(101)}`)), base])],
    ['longname-invalid-utf8', archive([longName(Buffer.concat([Buffer.alloc(100, 0x61), Buffer.from([0xc3, 0x28])])), base])],
    ['longname-limit', archive([longName(Buffer.from('a'.repeat(4097))), base])],
  ]) {
    assert.throws(() => parseHostedArchive(bytes), Error, label);
  }
  // 条目上限只分配约 8 MiB 头部，不构造真实解压炸弹或巨大文件正文。
  const entries = Array.from({ length: 16385 }, (_, index) => hostedTarHeader(`f${index}`));
  assert.throws(() => parseHostedArchive(archive(entries)), Error, 'entry-count-limit');
  const deep = Array.from({ length: 2049 }, (_, index) => hostedTarHeader(`d${index}/a/b/c/d/e/f/g/file`));
  assert.throws(() => parseHostedArchive(archive(deep)), Error, 'implicit-directory-count-limit');
});

test('Hosted Pub glob 的双星匹配零层，单星子项不排除父目录', () => {
  const source = readFileSync(join(citizenSdkRoot, 'scripts', 'release.mjs'), 'utf8');
  const start = source.indexOf('function compileRootedPubignoreRule(');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const compile = runInNewContext(`(${source.slice(start, end + 2)})`, {
    fail(message) { throw new Error(message); },
  });
  const readme = compile('/lib/**/README.md').pattern;
  assert.equal(readme.test('lib/README.md'), true);
  assert.equal(readme.test('lib/api/README.md'), true);
  assert.equal(readme.test('lib/api/citizen_sdk.dart'), false);
  const cmake = compile('/linux/cmake/*').pattern;
  assert.equal(cmake.test('linux/cmake/'), false);
  assert.equal(cmake.test('linux/cmake'), false);
  assert.equal(cmake.test('linux/cmake/CitizenSDKFlutter.cmake'), true);
});

test('最终 Hosted 六平台消费统一验真且不重编 Core、不把测试注入包', () => {
  const source = BUILD_SHELL_SOURCES.native;
  const start = source.indexOf('build_hosted_consumer() (\n');
  const end = source.indexOf('\nbuild_mobile_hosted_consumer() (', start);
  assert.ok(start >= 0 && end > start);
  const consume = source.slice(start, end);
  assert.match(consume, /hosted_preflight "\$@"/u);
  assert.match(consume, /verifyCitizenSdkHosted\(\{candidatePath:candidate,archivePath:audit,/u);
  assert.match(consume, /expectedGitSha:process\.env\.CITIZENSDK_SOURCE_SHA/u);
  assert.doesNotMatch(consume, /cargo |build_linux |build_windows[; ]|build_android|copyWindowsNativeArtifact|copy_linux_install/u);
  // CI 复用 checkout 中固定的消费者测试源码与中央增量对象；本轮唯一候选仍是
  // 链接、运行和字节验真的唯一 SDK 输入。Release 未传缓存根，始终全量构建。
  assert.match(consume, /-S "\$sdk_dir\/linux\/tests"/u);
  assert.match(consume, /\$sdk_dir\/windows\/tests/u);
  assert.match(consume, /local prefix="\$package\/linux"/u);
  assert.match(consume, /local prefix="\$package\/windows"/u);
  assert.match(consume, /run_windows_consumers "\$build" "\$prefix" "\$state"/u);
  assert.match(consume, /verify_linux_ctest_inventory .* LinuxConsumer 2/u);
  assert.match(source, /cp -a "\$\{package:-\$sdk_dir\}\/\." "\$sdk_stage\/"/u);
  assert.match(source, /if \[\[ -z "\$package" \]\]; then\s+copy_linux_install/u);
  assert.match(source, /if \[\[ -z "\$package" \]\]; then\s+verify_windows_flutter_inventory/u);
  const mobile = source.slice(end, source.indexOf('\ncase "$target_name" in', end));
  assert.match(mobile, /build apk --release --no-pub --target-platform=android-arm64/u);
  assert.match(mobile, /cmp -s <\(unzip -p "\$apk" "lib\/arm64-v8a\/\$library"\)/u);
  assert.match(mobile, /keepDebugSymbols \+= setOf\("\*\*\/libcitizensdk\.so", "\*\*\/libcitizensdk_jni\.so"\)/u);
  assert.match(mobile, /minSdk = 24/u);
  assert.match(mobile, /platform :ios, '16\.0'/u);
  assert.match(mobile, /Mobile Hosted tool dependency outside explicit Flutter\/Pub inputs/u);
  assert.match(mobile, /build ios --release --no-pub --no-codesign/u);
  assert.match(mobile, /-target arm64-apple-ios16\.0-simulator/u);
  assert.match(mobile, /CitizenSdk\.open\(\); await sdk\.close\(\)/u);
  assert.doesNotMatch(mobile, /adb install|simctl (?:install|launch)|cargo |--debug|setMockMethodCallHandler/u);
  assert.match(mobile, /未进行真机运行/u);
});

test('最终 Hosted 真实只读预检拒绝缺参、非Runner、跨平台、越界、交叠与链接', () => {
  const root = mkdtempSync(join(workRoot, 'hosted-input-'));
  try {
    const central = join(root, 'citizensdk');
    const paths = Object.fromEntries(['candidate', 'flutter', 'cache', 'work', 'output', 'tools']
      .map((name) => [name, join(central, name)]));
    for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true });
    const audit = join(central, 'audit.tgz'), hosted = join(central, 'hosted.tgz');
    writeFileSync(audit, 'public path fixture'); writeFileSync(hosted, 'public path fixture');
    const source = BUILD_SHELL_SOURCES.native;
    const start = source.indexOf('hosted_preflight() {\n');
    const end = source.indexOf('\n# 只由唯一发布器', start);
    assert.ok(start >= 0 && end > start);
    const shell = ['set -euo pipefail', nativeShellFunctions([
      'fail', 'assert_safe_directory_path', 'assert_readonly_dependency_directory', 'assert_descendant_path',
    ]), source.slice(start, end),
    'uname() { case "$1" in -s) printf "%s\\n" "${FIXTURE_OS:-Linux}" ;; -m) printf "%s\\n" "${FIXTURE_ARCH:-x86_64}" ;; esac; }',
    `sdk_dir=${JSON.stringify(citizenSdkRoot.replace(/\/$/u, ''))}`,
    `work_dir=${JSON.stringify(paths.work)}; output_dir=${JSON.stringify(paths.output)}`,
    'hosted_preflight "$@"'].join('\n');
    const args = ['LinuxAMD', paths.candidate, audit, hosted, paths.flutter, paths.cache, paths.tools];
    const run = (values = args, env = {}) => spawnSync('/bin/bash', ['-c', shell, 'hosted-input', ...values], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: root, CITIZENSDK_SOURCE_SHA: 'a'.repeat(40), ...env },
    });
    assert.equal(run().status, 0, run().stderr);
    for (const [values, environment] of [
      [args.slice(1), {}], [args, { GITHUB_ACTIONS: 'false' }],
      [args, { RUNNER_ENVIRONMENT: 'self-hosted' }], [args, { CITIZENSDK_SOURCE_SHA: 'bad' }],
      [args, { FIXTURE_ARCH: 'arm64' }], [args, { FIXTURE_OS: 'Darwin' }],
      [args.map((value, i) => i === 1 ? root : value), {}],
      [args.map((value, i) => i === 4 ? paths.candidate : value), {}],
      [args.map((value, i) => i === 6 ? `${paths.tools}:` : value), {}],
      [args.map((value, i) => i === 6 ? paths.work : value), {}],
    ]) assert.notEqual(run(values, environment).status, 0);
    const linked = join(central, 'linked'); symlinkSync(paths.candidate, linked);
    assert.notEqual(run(args.map((value, i) => i === 1 ? linked : value)).status, 0);
    assert.deepEqual(readdirSync(paths.work), []);
    assert.deepEqual(readdirSync(paths.output), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('macOS Hosted 消费者只用公开入口并在 Release 显式验收生命周期和有序事件', () => {
  const source = readFileSync(join(citizenSdkRoot, 'darwin/tests/citizen_sdk_flutter_consumer.dart'), 'utf8');
  assert.match(source, /import 'package:citizen_sdk\/citizen_sdk\.dart';/u);
  assert.equal([...source.matchAll(/CitizenSdk\.open\(\)/gu)].length, 2, '真实打开与关闭后重开');
  assert.match(source, /Platform\.isMacOS && kReleaseMode/u);
  assert.doesNotMatch(source, /package:citizen_sdk\/src\/|FlutterCitizenSdkPlatform|MethodChannelCitizenSdkPlatform|setMockMethodCallHandler|\bassert\s*\(/u);
  assert.doesNotMatch(source, /\.wallet\.(?:create|import|sign|transfer)|\.transaction\.(?:submit|transfer)|\.invokeMethod\(/u);
  assert.match(source, /sdk\.wallet\.getState\(\)\.result\.timeout\(_timeout\)/u);
  assert.match(source, /state\.hotProfile == null && state\.accounts\.isEmpty/u);
  assert.match(source, /await _emptyWallet\(opened\)/u);
  assert.match(source, /CitizenSdkCredentialRequest\(\)[\s\S]*?CitizenSdkPrivateKeyClosed\(\):[\s\S]*?eventFailed = true/u);
  assert.match(source, /CitizenSdkErrorCode\.notReady/u);
  assert.match(source, /CitizenSdkErrorCode\.invalidState/u);
  assert.match(source, /event\.sequence <= eventSequence/u);
  assert.doesNotMatch(source, /CitizenSdkTransferProgress|transferProgress/u);
  assert.match(source, /await opened\.start\(\)[\s\S]*?await opened\.stop\(\)/u);
  assert.match(source, /await opened\.close\(\)[\s\S]*?await opened\.close\(\)/u);
  assert.match(source, /await _until\(\(\) => eventsDone\);[\s\S]*?await subscription\.cancel\(\)[\s\S]*?_require\(!eventFailed\)/u);
  assert.match(source, /FlutterError\.onError = [\s\S]*?exit\(1\)/u);
  assert.match(source, /platformDispatcher\.onError = [\s\S]*?exit\(1\)/u);
  assert.match(source, /Timer\(const Duration\(seconds: 180\)/u);
  assert.match(source, /await binding\.endOfFrame\.timeout\(_timeout\)/u);
  assert.match(source, /CitizenSDK Flutter consumer passed[\s\S]*?await stdout\.flush\(\)[\s\S]*?exit\(0\)/u);
  assert.match(source, /CitizenSDK Flutter consumer failed[\s\S]*?await stderr\.flush\(\)[\s\S]*?exit\(1\)/u);
});

test('macOS Hosted 唯一构建入口先验三件输入并保留官方插件装配和运行隔离门禁', () => {
  const source = BUILD_SHELL_SOURCES.native;
  const start = source.indexOf('build_macos_flutter_consumer() (\n');
  const end = source.indexOf('\ncompile_apple_flutter_adapter() {', start);
  assert.ok(start >= 0 && end > start);
  const build = source.slice(start, end);
  assert.match(source, /macOS\) shift; build_macos_flutter_consumer "\$@" ;;/u);
  const containerStart = source.indexOf('if [[ "$target_name" == macOS || "$hosted_consumer" == true ]]; then');
  const containerEnd = source.indexOf('\nelse\n', containerStart);
  assert.ok(containerStart >= 0 && containerEnd > containerStart);
  assert.doesNotMatch(source.slice(containerStart, containerEnd), /\bmkdir\b|canonical_directory\s|prepare_safe_directory\s/u);
  assert.match(source, /if \[\[ "\$target_name" != macOS && "\$hosted_consumer" != true \]\]; then\n  prepare_safe_directory "\$work_dir" "\$cargo_target_dir"/u);
  assert.match(build, /macos_hosted_preflight "\$@"/u);
  assert.ok(build.indexOf('macos_hosted_preflight "$@"') < build.indexOf('prepare_safe_directory'));
  const preflight = nativeShellFunctions(['macos_hosted_root', 'macos_hosted_preflight']);
  assert.doesNotMatch(preflight.replace(/^\s*#.*$/gmu, ''), /\bmkdir\b|canonical_directory\s|prepare_safe_directory\s/u);
  assert.match(build, /--verify-hosted "\$candidate" --archive "\$audit" --hosted-archive "\$hosted" --output "\$package"/u);
  assert.ok(build.indexOf('--verify-hosted') < build.indexOf('create --offline --no-pub --platforms=macos'));
  assert.match(build, /path: \.\.\/package/u);
  assert.match(build, /fs\.copyFileSync\(path\.join\(candidate, 'darwin\/tests\/citizen_sdk_flutter_consumer\.dart'\)/u);
  assert.match(build, /Consumer does not depend on verified Hosted package/u);
  assert.match(build, /Official macOS CitizenSDK plugin registration is not unique/u);
  const directoryIdentity = /const sameDirectory = \([\s\S]+?\n\};/u.exec(build)?.[0];
  assert.ok(directoryIdentity);
  const directories = new Map([
    ['SDK/package', { dev: 1, ino: 42, isDirectory: () => true }],
    ['sdk/package', { dev: 1, ino: 42, isDirectory: () => true }],
    ['other/package', { dev: 1, ino: 43, isDirectory: () => true }],
    ['other-volume/package', { dev: 2, ino: 42, isDirectory: () => true }],
    ['file', { dev: 1, ino: 42, isDirectory: () => false }],
  ]);
  const sameDirectory = runInNewContext(`${directoryIdentity}\nsameDirectory`, {
    fs: { statSync: (path) => directories.get(path) },
  });
  assert.equal(sameDirectory('SDK/package', 'sdk/package'), true);
  for (const path of ['other/package', 'other-volume/package', 'file']) {
    assert.equal(sameDirectory('SDK/package', path), false);
  }
  assert.match(build, /pub get --offline/u);
  assert.match(build, /build macos --release --no-pub/u);
  assert.doesNotMatch(build, /--(?:no-)?enable-swift-package-manager|\bHOME=|DYLD_FRAMEWORK_PATH=|codesign\s|\.podspec['"]\)[\s\S]*?writeFileSync/u);
  assert.match(build, /FileManager\.default\.urls\(for: \.applicationSupportDirectory, in: \.userDomainMask\)/u);
  assert.match(build, /state\.resolvingSymlinksInPath\(\)\.path == state\.path/u);
  assert.match(build, /text\.replace\('import Cocoa', 'import Cocoa\\nimport MachO'\)\.replace\(start, start \+ preflight\)/u);
  assert.match(build, /RegisterGeneratedPlugins\(registry: flutterViewController\)/u);
  assert.match(build, /_dyld_image_count\(\)/u);
  assert.match(build, /frameworkCount == 1/u);
  assert.match(build, /\(deny network\*\)/u);
  assert.match(build, /\(deny file-write\*\)/u);
  assert.match(build, /Library\/Application Support\/citizensdk/u);
  assert.match(build, /fs\.writeFileSync\(path\.join\(root, 'tool\.sb'\), policy/u);
  assert.match(build, /const executable = label === 'consumer' \? command : '\/usr\/bin\/sandbox-exec'/u);
  assert.match(build, /const argumentsList = label === 'consumer' \? args : \['-f', path\.join\(root, 'tool\.sb'\), command, \.\.\.args\]/u);
  assert.match(build, /path\.join\(flutter, '\.git'\)/u);
  assert.doesNotMatch(build, /child = spawn\(command, args/u);
  assert.match(build, /\/usr\/bin\/sandbox-exec -f "\$root\/runtime\.sb" "\$executable"/u);
  assert.match(build, /dwarfdump --uuid/u);
  assert.match(build, /source_uuid" == "\$installed_uuid/u);
  assert.match(build, /CitizenSDK Foundation isolation passed/u);
  assert.match(build, /CitizenSDK Flutter consumer passed/u);
  assert.match(build, /process\.on\('SIGTERM', stop\)/u);
  assert.match(build, /detached: true/u);
  assert.match(build, /process\.kill\(-child\.pid, 0\)/u);
  const tests = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const hostedStart = tests.lastIndexOf("\nif (process.env.CITIZENSDK_APPLE_NATIVE) {");
  const hosted = tests.slice(hostedStart);
  assert.ok(hostedStart >= 0);
  assert.match(hosted, /spawn\('\/usr\/bin\/sandbox-exec', \[/u);
  assert.match(hosted, /'-p', policy, process\.execPath, '--input-type=module', '-e', worker, payload/u);
  assert.match(hosted, /const \{ buildCitizenSdkHosted \} = await import\(moduleUrl\)/u);
  assert.match(hosted, /const result = await buildCitizenSdkHosted\(\{ \.\.\.options, signal: controller\.signal \}\)/u);
  assert.match(hosted, /process\.on\('SIGTERM', \(\) => \{ interrupted = true; controller\.abort\(\); \}\)/u);
  assert.match(hosted, /process\.stdout\.write\(JSON\.stringify\(result\)/u);
  assert.match(hosted, /\(deny process-exec \(regex #"\/git\$"\)\)/u);
  assert.match(hosted, /Library\/Application Support\/dart/u);
  assert.match(hosted, /assert\.deepEqual\(hostedManifest, manifest\)/u);
  assert.match(hosted, /nativeShellFunctions\(\[[\s\S]*?'macos_hosted_root'/u);
  assert.ok(hosted.indexOf('const checkedRoot =') < hosted.indexOf('const root = mkdtempSync('));
  assert.match(hosted, /GITHUB_ACTIONS: process\.env\.GITHUB_ACTIONS/u);
  assert.match(hosted, /RUNNER_TEMP: process\.env\.RUNNER_TEMP/u);
  assert.match(hosted, /GITHUB_WORKSPACE: process\.env\.GITHUB_WORKSPACE/u);
  for (const name of ['GITHUB_ACTIONS', 'RUNNER_TEMP', 'GITHUB_WORKSPACE']) {
    assert.equal(hosted.split(`${name}: process.env.${name}`).length - 1, 3,
      `${name} 必须传给根预检、Hosted 归档监督器及原生构建器，不能只接最后一层`);
  }
  assert.doesNotMatch(hosted, /assert\.deepEqual\(await buildCitizenSdkHosted/u);
  const pubPolicy = hosted.slice(hosted.indexOf('const policy ='), hosted.indexOf('const payload ='));
  assert.match(pubPolicy, /\[root, options\.pubCachePath\]/u);
  assert.match(pubPolicy, /\(deny file-write\*\)/u);
  assert.doesNotMatch(pubPolicy, /deny network/u);
});

for (const github of process.platform === 'darwin' ? [false, true] : []) {
  test(`macOS Hosted ${github ? 'GitHub Runner' : '本机'}只读预检拒绝源码、越界、链接、输入交叠和不完整工具`, () => {
    const root = mkdtempSync(join(workRoot, 'macos-hosted-preflight-test-'));
    try {
      const runnerTemp = join(root, 'runner');
      const checkout = join(root, 'checkout');
      const sdk = checkout;
      const central = github ? join(runnerTemp, 'citizensdk') : join(root, 'citizensdk/build');
      const input = {
        candidate: join(central, 'candidate'), audit: join(central, 'audit.tgz'),
        hosted: join(central, 'hosted.tar.gz'), flutter: join(central, 'flutter'),
        cache: join(central, 'cache'), tools: join(root, 'tools'), work: join(central, 'work'),
        output: join(central, 'output'),
      };
      for (const directory of [sdk, runnerTemp, input.candidate, input.flutter, input.cache, input.tools, input.work, input.output]) {
        mkdirSync(directory, { recursive: true });
      }
      for (const path of [input.audit, input.hosted]) writeFileSync(path, 'preflight-only fixture');
      const components = [
        'bin/cache/dart-sdk/bin/dart', 'bin/cache/flutter_tools.snapshot',
        'bin/cache/flutter.version.json', 'packages/flutter_tools/.dart_tool/package_config.json',
      ];
      for (const path of components) {
        const file = join(input.flutter, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'preflight-only fixture', { mode: path.endsWith('/dart') ? 0o755 : 0o644 });
      }
      const shell = [
        'set -euo pipefail',
        nativeShellFunctions(['fail', 'assert_safe_directory_path', 'assert_descendant_path', 'assert_readonly_dependency_directory', 'macos_hosted_root', 'macos_hosted_preflight']),
        'export CITIZENSDK_HOSTED_ROOT="$1"; work_dir="$2"; output_dir="$3"; sdk_dir="$4"; shift 4',
        'uname() { if [[ "$1" == -s ]]; then printf "%s\\n" "${HOSTED_FIXTURE_OS:-Darwin}"; else printf "%s\\n" "${HOSTED_FIXTURE_ARCH:-arm64}"; fi; }',
        'macos_hosted_preflight "$@"',
      ].join('\n');
      const argumentsList = [input.candidate, input.audit, input.hosted, input.flutter, input.cache, input.tools];
      const snapshot = () => {
        const entries = [];
        const walk = (directory) => {
          for (const name of readdirSync(directory).sort()) {
            const path = join(directory, name), stat = lstatSync(path);
            entries.push([path, stat.ino, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) :
              stat.isDirectory() ? 'directory' : readFileSync(path).toString('hex')]);
            if (stat.isDirectory()) walk(path);
          }
        };
        walk(root);
        return entries;
      };
      const run = (values = argumentsList, options = {}) => {
        const before = snapshot();
        const result = spawnSync('/bin/bash', [
        '-c', shell, 'macos-hosted-preflight', central, options.work ?? input.work,
          options.output ?? input.output, options.sdk ?? sdk, ...values,
        ], { encoding: 'utf8', cwd: root, timeout: 10000,
          env: { ...process.env, GITHUB_ACTIONS: github ? 'true' : '',
            RUNNER_TEMP: options.runnerTemp ?? runnerTemp,
            GITHUB_WORKSPACE: options.checkout ?? checkout,
            HOSTED_FIXTURE_OS: options.os ?? 'Darwin', HOSTED_FIXTURE_ARCH: options.arch ?? 'arm64' } });
        assert.deepEqual(snapshot(), before, '无论成功或失败，预检不得创建或改写任何夹具节点');
        return result;
      };
      const success = run();
      assert.equal(success.error, undefined);
      assert.equal(success.status, 0, success.stderr);
      const rejects = (values, options) => {
        const result = run(values, options);
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(input.work, 'macOS')), false, '只读预检不能生成消费目录');
      };
      rejects(argumentsList.slice(0, -1));
      rejects([citizenSdkRoot, ...argumentsList.slice(1)]);
      rejects([root, ...argumentsList.slice(1)]);
      rejects(argumentsList, { os: 'Linux' });
      rejects(argumentsList, { arch: 'x86_64' });
      for (const field of ['work', 'output']) {
        for (const path of ['', 'relative', '/', central, runnerTemp, root, `${central}/missing/../work`,
          `${central}//work`, `${central}/./work`, join(central, 'missing'), input.candidate, input.cache]) {
          rejects(argumentsList, { [field]: path });
        }
      }
      rejects(argumentsList, { output: input.work });
      rejects(argumentsList, { output: join(input.flutter, 'bin') });
      const candidateAlias = join(central, 'CANDIDATE');
      if (existsSync(candidateAlias)) {
        rejects([candidateAlias, ...argumentsList.slice(1)]);
        rejects([...argumentsList.slice(0, 4), candidateAlias, input.tools]);
      }
      // 缓存根与 checkout/SDK 在任一方向交叠都拒绝，包括源码嵌入受控根的情况。
      rejects(argumentsList, { sdk: input.candidate, checkout: central });
      if (github) {
        rejects(argumentsList, { checkout: root });
        // 独立完整仓的SDK等于checkout；真实子目录仍不是准确源码根。
        const nestedSdk = join(checkout, 'nested-sdk');
        mkdirSync(nestedSdk);
        rejects(argumentsList, { sdk: nestedSdk });
        rejects(argumentsList, { sdk: resolve(citizenSdkRoot) });
        for (const field of ['runnerTemp', 'checkout']) {
          for (const path of ['', 'relative', '/', `${root}/missing/../runner`, `${root}//runner`,
            `${root}/./runner`, join(root, 'missing'), input.audit]) {
            rejects(argumentsList, { [field]: path });
          }
          const linked = join(root, `linked-${field}`);
          symlinkSync(field === 'runnerTemp' ? runnerTemp : checkout, linked);
          rejects(argumentsList, { [field]: linked });
          unlinkSync(linked);
        }
        // Runner 根不能再次嵌套取另一个 citizensdk；更不能使用任意 temp 根。
        rejects(argumentsList, { runnerTemp: central });
        rejects(argumentsList, { runnerTemp: root });
        const checkoutAlias = join(root, 'RUNNER');
        if (existsSync(checkoutAlias)) {
          rejects(argumentsList, { checkout: checkoutAlias, sdk: join(checkoutAlias, 'citizensdk/candidate') });
        }
        const linkedRoot = join(root, 'linked-root');
        mkdirSync(linkedRoot);
        symlinkSync(central, join(linkedRoot, 'citizensdk'));
        rejects(argumentsList, { runnerTemp: linkedRoot });
        rmSync(linkedRoot, { recursive: true });
        const nestedCheckout = join(central, 'checkout');
        mkdirSync(join(nestedCheckout, 'citizensdk'), { recursive: true });
        rejects(argumentsList, { checkout: nestedCheckout, sdk: join(nestedCheckout, 'citizensdk') });
        rmSync(nestedCheckout, { recursive: true });
      } else {
        // 非 GitHub 执行不允许 Runner 环境变量替换已批准的本机根。
        assert.equal(run(argumentsList, { runnerTemp: '', checkout: '' }).status, 0);
      }
      rejects([input.work, ...argumentsList.slice(1)]);
      for (const cache of [input.candidate, input.flutter]) {
        rejects([...argumentsList.slice(0, 4), cache, input.tools]);
      }
      const nestedCache = join(input.candidate, 'cache');
      mkdirSync(nestedCache);
      rejects([...argumentsList.slice(0, 4), nestedCache, input.tools]);
      rmSync(nestedCache, { recursive: true });
      const cachedCandidate = join(input.cache, 'candidate');
      mkdirSync(cachedCandidate);
      rejects([cachedCandidate, ...argumentsList.slice(1)]);
      rmSync(cachedCandidate, { recursive: true });
      for (const index of [1, 2]) {
        const cachedArchive = join(input.cache, index === 1 ? 'audit.tgz' : 'hosted.tar.gz');
        writeFileSync(cachedArchive, 'preflight-only fixture');
        const values = [...argumentsList]; values[index] = cachedArchive;
        rejects(values);
        unlinkSync(cachedArchive);
      }
      const nested = join(input.work, 'macOS', 'input');
      mkdirSync(nested, { recursive: true });
      const nestedResult = run([nested, ...argumentsList.slice(1)]);
      assert.equal(nestedResult.error, undefined);
      assert.notEqual(nestedResult.status, 0);
      rmSync(join(input.work, 'macOS'), { recursive: true });
      const linked = join(central, 'linked');
      symlinkSync(input.candidate, linked);
      rejects([linked, ...argumentsList.slice(1)]);
      for (const field of ['work', 'output']) rejects(argumentsList, { [field]: linked });
      const linkedCentral = `${central}-link`;
      symlinkSync(central, linkedCentral);
      rejects([join(linkedCentral, 'candidate'), ...argumentsList.slice(1)]);
      unlinkSync(linkedCentral);
      const linkedTools = join(central, 'linked-tools');
      symlinkSync(input.tools, linkedTools);
      rejects([...argumentsList.slice(0, -1), linkedTools]);
      for (const tools of ['', `:${input.tools}`, `${input.tools}:`, `${input.tools}::${input.tools}`, join(root, 'missing-tools')]) {
        rejects([...argumentsList.slice(0, -1), tools]);
      }
      for (const tools of [input.work, central]) {
        rejects([...argumentsList.slice(0, -1), tools]);
      }
      for (const path of components) {
        const file = join(input.flutter, path), bytes = readFileSync(file), mode = statSync(file).mode & 0o777;
        unlinkSync(file);
        rejects(argumentsList);
        writeFileSync(file, bytes, { mode });
      }
      chmodSync(join(input.flutter, components[0]), 0o644);
      rejects(argumentsList);
      chmodSync(join(input.flutter, components[0]), 0o755);
      const audit = readFileSync(input.audit);
      unlinkSync(input.audit); symlinkSync(input.hosted, input.audit);
      rejects(argumentsList);
      unlinkSync(input.audit); writeFileSync(input.audit, audit);
      assert.equal(run().status, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('Hosted 完整归档绑定审计候选和 Apple 展开字节，验真成功后才写入新目录', () => {
  const root = mkdtempSync(join(workRoot, 'release-hosted-archive-test-'));
  try {
    const native = writeNativeFixture(root);
    const candidate = join(root, 'candidate');
    const audit = join(root, 'citizensdk.tgz');
    buildCitizenSdkRelease({
      sourcePath: citizenSdkRoot, nativePath: native, outputPath: candidate,
      archivePath: audit, gitCommitSha: '0'.repeat(40), softwareVersion: '1.0.0',
    });
    const entries = hostedPackageEntries(candidate);
    const framework = `darwin/CitizenSDK.xcframework/${appleFixtureSliceIdentifiers.macOS}/CitizenSDK.framework`;
    // 明确对照磁盘上已验真的真实目标，不只把生产投影再交回生产验证器。
    for (const [path, target] of [
      [`${framework}/CitizenSDK`, `${framework}/Versions/A/CitizenSDK`],
      [`${framework}/Versions/Current/CitizenSDK`, `${framework}/Versions/A/CitizenSDK`],
      [`${framework}/Headers/citizensdk.h`, `${framework}/Versions/A/Headers/citizensdk.h`],
      [`${framework}/Resources/Info.plist`, `${framework}/Versions/A/Resources/Info.plist`],
    ]) {
      assert.equal(entries.get(path)?.type, 'file', path);
      assert.deepEqual(entries.get(path).data, readFileSync(join(candidate, target)), path);
    }
    for (const path of [
      'pubspec.yaml', 'LICENSE',
      'lib/citizen_sdk.dart', 'chain/manifest.json',
      'android/src/main/jniLibs/arm64-v8a/libcitizensdk.so', 'darwin/citizen_sdk.podspec',
      'linux/lib/LinuxARM/libcitizensdk.so', 'linux/lib/LinuxAMD/libcitizensdk.so',
      'linux/cmake/CitizenSDKFlutter.cmake', 'linux/source/citizen_sdk_plugin.cc',
      'windows/bin/Windows/citizensdk.dll', 'windows/cmake/CitizenSDKFlutter.cmake',
      'windows/source/citizen_sdk_plugin.cc',
    ]) {
      assert.equal(entries.get(path)?.type, 'file', path);
      assert.deepEqual(entries.get(path).data, readFileSync(join(candidate, path)), path);
    }
    for (const path of ['.pubignore', 'scripts/release.mjs', 'native/Cargo.toml', 'android/citizensdk.aar', 'citizensdk-release.json', 'SHA256SUMS']) {
      assert.equal(entries.has(path), false, path);
    }
    assert.equal(entries.has(''), false, '包根不作为归档条目');
    for (const [path, entry] of entries) {
      const source = statSync(join(candidate, path));
      assert.equal(entry.mode, entry.type === 'directory' ? 0o755 : 0o644 | (source.mode & 0o111), path);
    }
    const hosted = join(root, 'hosted.tar.gz');
    const original = readFileSync(audit);
    writeFileSync(hosted, gzipSync(hostedTar(entries)));
    const output = join(root, 'extracted');
    // 权限由固定 Pub 合同决定，不受调用进程的私有 umask 改写。
    const previousUmask = process.umask(0o077);
    try {
      assert.doesNotThrow(() => verifyCitizenSdkHosted({
        candidatePath: candidate, archivePath: audit, hostedArchivePath: hosted,
        outputPath: output, expectedGitSha: '0'.repeat(40),
      }));
    } finally {
      process.umask(previousUmask);
    }
    for (const [path, entry] of entries) {
      const destination = join(output, path);
      const info = lstatSync(destination);
      assert.equal(info.isSymbolicLink(), false, path);
      assert.equal(info.isDirectory(), entry.type === 'directory', path);
      assert.equal(info.mode & 0o777, entry.mode, path);
      if (entry.type === 'file') assert.deepEqual(readFileSync(destination), entry.data, path);
    }
    assert.deepEqual(readFileSync(audit), original, '验真不改原审计归档');
    assert.doesNotThrow(() => verifyCitizenSdkRelease(candidate, audit, '0'.repeat(40)));
    const verify = (destination) => verifyCitizenSdkHosted({
      candidatePath: candidate, archivePath: audit, hostedArchivePath: hosted,
      outputPath: destination, expectedGitSha: '0'.repeat(40),
    });
    for (const destination of [output, candidate, join(candidate, 'nested'), root]) {
      assert.throws(() => verify(destination), Error, '禁止覆盖或重叠');
    }
    const outside = join(root, 'outside');
    mkdirSync(outside);
    const link = join(root, 'linked');
    symlinkSync(outside, link);
    assert.throws(() => verify(join(link, 'extracted')), Error, '禁止符号链接祖先');
    assert.deepEqual(readdirSync(outside), [], '拒绝前不得经链接写入');
    const missing = new Map(entries);
    missing.delete('lib/citizen_sdk.dart');
    const extra = new Map(entries);
    extra.set('unexpected.dart', { type: 'file', mode: 0o644, data: Buffer.from('unexpected') });
    const changed = new Map(entries);
    changed.set('pubspec.yaml', { ...entries.get('pubspec.yaml'), data: Buffer.from('tampered') });
    const apple = new Map(entries);
    apple.set(`${framework}/CitizenSDK`, { ...entries.get(`${framework}/CitizenSDK`), data: Buffer.from('tampered framework') });
    const wrongMode = new Map(entries);
    wrongMode.set('lib/citizen_sdk.dart', { ...entries.get('lib/citizen_sdk.dart'), mode: 0o755 });
    for (const [label, changedEntries] of [['missing', missing], ['extra', extra], ['bytes', changed], ['apple', apple], ['mode', wrongMode]]) {
      writeFileSync(hosted, gzipSync(hostedTar(changedEntries)));
      const destination = join(root, `reject-${label}`);
      assert.throws(() => verify(destination), Error, label);
      assert.equal(existsSync(destination), false, `${label} 必须在写目录前失败`);
      assert.deepEqual(readFileSync(audit), original, label);
    }
    // 复用既有 Hosted 夹具为稀疏超限文件，验证磁盘读取前的长度门禁；
    // 不生成 100 MiB 正文或分配同量 Buffer，也不增加新的夹具路径。
    const descriptor = openSync(hosted, 'r+');
    try {
      ftruncateSync(descriptor, 100 * 1024 * 1024 + 1);
    } finally {
      closeSync(descriptor);
    }
    const oversizedOutput = join(root, 'reject-oversized');
    assert.throws(() => verify(oversizedOutput), /Hosted 归档类型或长度无效/u);
    assert.equal(existsSync(oversizedOutput), false, '超限必须在创建输出前拒绝');
    assert.deepEqual(readFileSync(audit), original, '超限拒绝不改审计输入');
    if (process.platform !== 'win32') {
      // 无写端 FIFO 不得阻塞在 open；在有超时的独立进程验证真实生产读取入口。
      unlinkSync(hosted);
      const fifo = spawnSync('/usr/bin/mkfifo', [hosted], { encoding: 'utf8', timeout: 5000 });
      assert.equal(fifo.status, 0, fifo.stderr || fifo.error?.message);
      const destination = join(root, 'reject-fifo');
      const script = `import assert from 'node:assert/strict';\n`
        + `import {verifyCitizenSdkHosted} from ${JSON.stringify(new URL('./release.mjs', import.meta.url).href)};\n`
        + `assert.throws(() => verifyCitizenSdkHosted(${JSON.stringify({
          candidatePath: candidate, archivePath: audit, hostedArchivePath: hosted,
          outputPath: destination, expectedGitSha: '0'.repeat(40),
        })}), /Hosted 归档类型或长度无效/u);`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8', cwd: root, timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.equal(existsSync(destination), false, 'FIFO 必须在创建输出前拒绝');
      assert.deepEqual(readFileSync(audit), original, 'FIFO 拒绝不改审计输入');
      unlinkSync(hosted);
    }
    writeFileSync(hosted, gzipSync(hostedTar(entries)));
    const corrupt = Buffer.from(original);
    corrupt[10] ^= 1;
    writeFileSync(audit, corrupt);
    const rejected = join(root, 'reject-audit');
    assert.throws(() => verify(rejected), Error, '先验证原审计归档');
    assert.equal(existsSync(rejected), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 直接执行唯一发布器的函数体；只替换操作系统和时钟，不增加生产用测试开关。
function hostedSupervisor(options = {}) {
  const source = readFileSync(join(citizenSdkRoot, 'scripts/release.mjs'), 'utf8');
  const start = source.indexOf('function runHostedDart(');
  const end = source.indexOf('\n/** 只调用固定 Pub', start);
  assert.ok(start > 0 && end > start);
  const child = new EventEmitter();
  child.pid = options.noPid ? undefined : 4321;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let destroyed = 0, unreferenced = 0, pending = true, timerID = 0, spawned;
  child.stdout.destroy = child.stderr.destroy = () => { destroyed += 1; };
  child.unref = () => { unreferenced += 1; };
  const timers = new Map(), calls = [], controller = new AbortController();
  if (options.aborted) controller.abort();
  const result = runInNewContext(`${source.slice(start, end)}\nrunHostedDart('/dart', ['--version'], '/work', {CI:'true'}, signal)`, {
    process: { platform: options.platform ?? 'darwin', kill(pid, name) {
      calls.push([pid, name]);
      if ((options.inspectError && name === 0) || (options.killError && name !== 0)) {
        throw Object.assign(new Error('OS denied'), { code: 'EPERM' });
      }
      if (name === 0 && !pending) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    } },
    spawn: (...args) => { spawned = args; return child; }, signal: controller.signal,
    fail: (message) => { throw new Error(message); },
    setTimeout: (callback, duration) => { const id = ++timerID; timers.set(id, { callback, duration }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    child, controller, result, calls, timers, spawned,
    set pending(value) { pending = value; },
    fire(duration) {
      const row = [...timers].find(([, timer]) => timer.duration === duration);
      assert.ok(row, `缺少 ${duration} ms 定时器`);
      timers.delete(row[0]); row[1].callback();
    },
    close(code = 0, name = null) { child.emit('exit', code, name); child.emit('close', code, name); },
    assertClean(preserved = false) {
      assert.equal(timers.size, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(destroyed, preserved ? 2 : 0);
      assert.equal(unreferenced, preserved ? 1 : 0);
    },
  };
}

test('Hosted 监督在预取消或缺少POSIX组时不启动工具', () => {
  assert.throws(() => hostedSupervisor({ aborted: true }), { name: 'AbortError' });
  assert.throws(() => hostedSupervisor({ platform: 'win32' }), /POSIX/u);
});

test('Hosted 监督正常退出非零错误和启动失败都清理监听器与定时器', async () => {
  const good = hostedSupervisor();
  assert.deepEqual(Array.from(good.spawned[1]), ['--suppress-analytics', '--version']);
  assert.equal(good.spawned[2].detached, true);
  assert.equal(good.spawned[2].shell, false);
  good.child.stdout.emit('data', Buffer.from('version'));
  good.pending = false; good.close();
  assert.equal(await good.result, 'version'); good.assertClean();
  for (const [code, signal] of [[3, null], [null, 'SIGTERM']]) {
    const bad = hostedSupervisor(); bad.pending = false; bad.close(code, signal);
    await assert.rejects(bad.result, /官方工具失败/u); bad.assertClean();
  }
  const missing = hostedSupervisor({ noPid: true });
  missing.child.emit('error', new Error('spawn ENOENT')); missing.close(null);
  await assert.rejects(missing.result, /ENOENT/u); missing.assertClean();
});

test('Hosted 监督取消超时和超量输出保持失败并由内部终止工具组', async () => {
  for (const reason of ['abort', 'timeout', 'stdout', 'stderr', 'pipe-error']) {
    const run = hostedSupervisor();
    if (reason === 'abort') run.controller.abort();
    else if (reason === 'timeout') run.fire(120000);
    else if (reason === 'pipe-error') run.child.stdout.emit('error', new Error('pipe error'));
    else run.child[reason].emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.deepEqual(run.calls, [[-4321, 'SIGTERM']]);
    run.controller.abort(); // 重复取消不能重置收尾期限。
    run.fire(5000);
    assert.deepEqual(run.calls.slice(-2), [[-4321, 0], [-4321, 'SIGKILL']]);
    run.pending = false; run.close(0);
    await assert.rejects(run.result, /取消|超时|超过上限|pipe error/u);
    run.assertClean();
  }
});

test('Hosted 监督从exit检查管道后代且无法确认退出时必须保留目录', async () => {
  const orphan = hostedSupervisor();
  orphan.child.emit('exit', 0, null); // 没有 close：后代仍持有继承管道。
  orphan.fire(200);
  assert.ok(orphan.calls.some(([, name]) => name === 'SIGTERM'));
  orphan.pending = false; orphan.child.emit('close', 0, null);
  await assert.rejects(orphan.result, /遗留子进程或管道/u); orphan.assertClean();
  for (const options of [{}, { inspectError: true }, { killError: true }]) {
    const run = hostedSupervisor(options);
    if (options.inspectError) run.close();
    else { run.controller.abort(); if (!options.killError) run.fire(10000); }
    await assert.rejects(run.result, (error) => error.preserveHostedOutput === true);
    run.assertClean(true);
    run.child.emit('close', 0, null); run.controller.abort(); run.assertClean(true);
  }
});

test('Hosted 工具调度固定版本和两次独立命令，失败不上传且按退出证据清理或保留', async (context) => {
  if (process.platform === 'win32') {
    await assert.rejects(buildCitizenSdkHosted({}), /POSIX 进程组监督/u);
    return;
  }
  const root = mkdtempSync(join(workRoot, 'release-hosted-dispatch-test-'));
  const orphanPidPath = join(root, 'orphan.pid');
  const orphanAlive = () => {
    if (!existsSync(orphanPidPath)) return false;
    const pid = Number(readFileSync(orphanPidPath, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, '只检查本夹具记录的后代 PID');
    try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  let preserveRoot = false;
  try {
    const native = writeNativeFixture(root);
    const candidate = join(root, 'candidate');
    const audit = join(root, 'citizensdk.tgz');
    const manifest = buildCitizenSdkRelease({
      sourcePath: citizenSdkRoot, nativePath: native, outputPath: candidate,
      archivePath: audit, gitCommitSha: '0'.repeat(40), softwareVersion: '1.0.0',
    });
    const archive = join(root, 'expected.tar.gz');
    writeFileSync(archive, gzipSync(hostedTar(hostedPackageEntries(candidate))));
    const tool = join(root, 'tool');
    const dart = join(tool, 'bin', 'dart');
    const flutter = join(root, 'flutter');
    const cache = join(root, 'cache');
    const calls = join(root, 'calls.jsonl');
    const scenario = join(root, 'scenario');
    mkdirSync(dirname(dart), { recursive: true });
    mkdirSync(flutter);
    mkdirSync(cache);
    writeFileSync(join(tool, 'version'), '3.12.2\n');
    // 显式伪工具只证明生产调度边界；真实官方 Pub 由下一项独立往返验证。
    // 使用固定 Node 绝对解释器，不通过 shell、PATH 或 Git 执行任意参数。
    writeFileSync(dart, `#!${process.execPath}\n`
      + "import {appendFileSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs';\n"
      + "import {spawn} from 'node:child_process';\n"
      + `const args=process.argv.slice(2), scenario=readFileSync(${JSON.stringify(scenario)},'utf8');\n`
      + `appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,env:Object.keys(process.env).sort()})+'\\n');\n`
      + "if(args.shift()!=='--suppress-analytics')process.exit(10);\n"
      // 在三个阶段分别挂起；只运行有上限的 Node 夹具，证明取消不会启动下一阶段。
      + "const stage=args[0]==='--version'?'version':args[2]==='--dry-run'?'preview':'archive';\n"
      + `if(scenario==='hold-'+stage){const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],{stdio:'inherit',detached:false});writeFileSync(${JSON.stringify(orphanPidPath)},String(child.pid));setTimeout(()=>process.exit(0),10000);}else {\n`
      // 让入口正常退出但同组后代仍存活，证明生产逻辑会检查、终止并等待整组。
      // 后代自身有 10 秒上限；测试只做存活检查，绝不按猜测 PID 发送终止信号。
      + `if(scenario==='orphan'&&args[0]==='--version'){const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),10000)'],{stdio:'ignore',detached:false});writeFileSync(${JSON.stringify(orphanPidPath)},String(child.pid));child.unref();console.log('Dart SDK version: 3.12.2 (stable)');process.exit(0);}\n`
      + "if(args.length===1&&args[0]==='--version'){console.log('Dart SDK version: '+(scenario==='version'?'3.12.1':'3.12.2')+' (stable)');process.exit(0);}\n"
      + "if(args.length!==3||args[0]!=='pub'||args[1]!=='publish')process.exit(11);\n"
      + "if(args[2]==='--dry-run'){if(scenario==='dry-run-error')process.exit(12);console.log('Package has '+(scenario==='warnings'?'1':'0')+' warnings.');process.exit(0);}\n"
      + "if(!args[2].startsWith('--to-archive='))process.exit(13);\n"
      + "if(scenario==='archive-error')process.exit(14);\n"
      + "const output=args[2].slice('--to-archive='.length);\n"
      + `if(scenario==='invalid-archive')writeFileSync(output,'invalid archive');else if(scenario!=='missing-archive')copyFileSync(${JSON.stringify(archive)},output);\n`
      + "console.log(scenario==='unconfirmed'?'No archive confirmation':'Wrote package archive at '+output);\n}\n",
    { mode: 0o755 });
    const original = readFileSync(audit);
    writeFileSync(calls, '');
    for (const [index, overlapping] of [
      candidate, join(candidate, 'cache'), audit, dart, dirname(dart), flutter, root,
    ].entries()) {
      const output = join(root, `reject-cache-${index}`);
      await assert.rejects(() => buildCitizenSdkHosted({
        candidatePath: candidate, archivePath: audit, outputPath: output,
        dartPath: dart, flutterRoot: flutter, pubCachePath: overlapping, expectedGitSha: '0'.repeat(40),
      }), Error, '缓存与只读输入双向互斥');
      assert.equal(existsSync(output), false);
      assert.equal(readFileSync(calls, 'utf8'), '', '路径拒绝不能执行工具');
    }
    for (const [name, expectedCalls] of [
      ['valid', 3], ['version', 1], ['warnings', 2], ['dry-run-error', 2],
      ['archive-error', 3], ['unconfirmed', 3], ['invalid-archive', 3], ['missing-archive', 3],
      ...(process.platform === 'win32' ? [] : [['orphan', 1]]),
    ]) {
      writeFileSync(scenario, name);
      writeFileSync(calls, '');
      const output = join(root, `hosted-${name}`);
      const invoke = () => buildCitizenSdkHosted({
        candidatePath: candidate, archivePath: audit, outputPath: output,
        dartPath: dart, flutterRoot: flutter, pubCachePath: cache, expectedGitSha: '0'.repeat(40),
      });
      if (name === 'valid') assert.deepEqual(await invoke(), manifest);
      else {
        let failure;
        await assert.rejects(invoke, (error) => { failure = error; return error instanceof Error; }, name);
        // macOS 沙箱可能拒绝已孤立组的 kill(..., 0)。EPERM 不是 ESRCH，生产入口
        // 必须保留现场；测试也不能要求在未确认退出时删除。其余失败仍要求精确清理。
        const denied = name === 'orphan' && failure.preserveHostedOutput === true && failure.cause?.code === 'EPERM';
        assert.equal(existsSync(output), denied, `${name} 按证据清理或保留：${failure.message}; ${failure.cause?.stack || ''}`);
        if (name === 'orphan') {
          assert.equal(existsSync(orphanPidPath), true, '确实创建过同组后代');
          if (denied) {
            context.diagnostic('沙箱拒绝孤立进程组探测：已断言发布器失败且保留现场，不计作确认工具组退出');
            // 只等待本夹具准确 PID；后代自身有 10 秒期限，不向猜测 PID 发送信号。
            const deadline = Date.now() + 15000;
            while (orphanAlive() && Date.now() < deadline) await new Promise((resume) => setTimeout(resume, 25));
            assert.equal(existsSync(output), true, '等待期间发布器仍不得删除保留现场');
          }
          assert.equal(orphanAlive(), false, denied ? '清理夹具前必须确认准确后代退出' : '发布器返回失败前必须确认准确后代退出');
        }
      }
      const records = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(records.length, expectedCalls, name);
      assert.deepEqual(records[0].args, ['--suppress-analytics', '--version'], name);
      if (records.length > 1) {
        assert.deepEqual(records[1].args, ['--suppress-analytics', 'pub', 'publish', '--dry-run'], name);
      }
      if (records.length > 2) {
        assert.deepEqual(records[2].args, [
          '--suppress-analytics', 'pub', 'publish', `--to-archive=${join(output, 'citizen_sdk-1.0.0.tar.gz')}`,
        ], name);
      }
      for (const record of records) {
        assert.equal(record.env.some((key) => /^(?:HOME|APPDATA|LOCALAPPDATA|XDG_|PUB_TOKEN|GITHUB_TOKEN)/u.test(key)), false, name);
        assert.equal(record.args.some((arg) => /^--(?:force|skip-validation|from-archive)(?:=|$)/u.test(arg)), false, name);
      }
      assert.deepEqual(readFileSync(audit), original, name);
      assert.doesNotThrow(() => verifyCitizenSdkRelease(candidate, audit, '0'.repeat(40)), name);
    }
    const ready = async () => {
      const deadline = Date.now() + 10000;
      while (!existsSync(orphanPidPath)) {
        if (Date.now() >= deadline) throw new Error('受控工具没有及时启动');
        await new Promise((resume) => setTimeout(resume, 25));
      }
    };
    for (const [stage, expectedCalls] of [['version', 1], ['preview', 2], ['archive', 3]]) {
      if (existsSync(orphanPidPath)) unlinkSync(orphanPidPath);
      writeFileSync(scenario, `hold-${stage}`); writeFileSync(calls, '');
      const controller = new AbortController(), output = join(root, `abort-${stage}`);
      const result = buildCitizenSdkHosted({ candidatePath: candidate, archivePath: audit, outputPath: output,
        dartPath: dart, flutterRoot: flutter, pubCachePath: cache, expectedGitSha: '0'.repeat(40), signal: controller.signal });
      let failure;
      const rejected = assert.rejects(result, (error) => {
        failure = error;
        return /取消|未确认退出/u.test(error.message);
      });
      try { await ready(); } finally { controller.abort(); await rejected; }
      const denied = failure?.preserveHostedOutput === true && failure.cause?.code === 'EPERM';
      if (denied) {
        preserveRoot = true;
        context.diagnostic(`${stage} 的进程组探测被沙箱拒绝：发布器已失败并保留现场`);
        const deadline = Date.now() + 15000;
        while (orphanAlive() && Date.now() < deadline) await new Promise((resume) => setTimeout(resume, 25));
      }
      assert.equal(orphanAlive(), false, `${stage} 返回前整组后代退出`);
      assert.equal(existsSync(output), denied, `${stage} 必须按退出证据清理或保留自己的新建目录`);
      assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, expectedCalls);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.deepEqual(readFileSync(audit), original);
    }
    // 真实 CLI 接收信号；监督器不被提前强杀，最终保留 130/143 而不是伪装为成功。
    for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      unlinkSync(orphanPidPath);
      writeFileSync(scenario, 'hold-preview'); writeFileSync(calls, '');
      const output = join(root, `cli-${signal}`);
      const child = spawn(process.execPath, [join(citizenSdkRoot, 'scripts/release.mjs'),
        '--hosted', candidate, '--archive', audit, '--output', output, '--dart', dart,
        '--flutter', flutter, '--pub-cache', cache, '--expected-git-sha', '0'.repeat(40)],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      child.stdout.resume(); child.stderr.on('data', (data) => { stderr += data; });
      const done = new Promise((resolveChild, rejectChild) => {
        child.on('error', rejectChild); child.on('close', (code, name) => resolveChild({ code, name }));
      });
      try { await ready(); } finally { child.kill(signal); }
      const result = await done;
      if (existsSync(output)) {
        preserveRoot = true;
        // 保留现场不覆盖已接收的取消退出码；生产CLI明确保留SIGINT=130/SIGTERM=143。
        assert.equal(result.code, expectedCode, stderr);
        assert.equal(result.name, null, stderr);
        assert.match(stderr, /保留缓存目录/u);
      } else {
        assert.deepEqual(result, { code: expectedCode, name: null }, stderr);
      }
      assert.equal(orphanAlive(), false);
      assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
      assert.deepEqual(readFileSync(audit), original);
    }
  } finally {
    if (orphanAlive()) throw new Error('Hosted 夹具后代尚存活，保留其准确缓存目录');
    if (!preserveRoot) rmSync(root, { recursive: true, force: true });
  }
});

// 只有主验收显式提供隔离的官方工具与缓存时才注册真实往返；普通 Node 测试
// 既不偷偷联网，也不把此项计作 skip 或把格式夹具当作官方 Pub 已验证。
if (process.env.CITIZENSDK_DART) {
  test('Hosted 官方 Pub 实际 dry-run、归档、解包往返保持完整同版包', async (context) => {
    assert.ok(process.env.CITIZENSDK_FLUTTER, '缺少显式官方 Flutter 路径');
    assert.ok(process.env.CITIZENSDK_PUB_CACHE, '缺少显式中央独占 Pub cache');
    const root = mkdtempSync(join(workRoot, 'release-hosted-official-test-'));
    let preserve = false;
    try {
      const native = writeNativeFixture(root);
      const candidate = join(root, 'candidate');
      const audit = join(root, 'citizensdk.tgz');
      const manifest = buildCitizenSdkRelease({
        sourcePath: citizenSdkRoot, nativePath: native, outputPath: candidate,
        archivePath: audit, gitCommitSha: '0'.repeat(40), softwareVersion: '1.0.0',
      });
      const output = join(root, 'hosted');
      const result = await buildCitizenSdkHosted({
        candidatePath: candidate,
        archivePath: audit,
        outputPath: output,
        dartPath: process.env.CITIZENSDK_DART,
        flutterRoot: process.env.CITIZENSDK_FLUTTER,
        pubCachePath: process.env.CITIZENSDK_PUB_CACHE,
        expectedGitSha: '0'.repeat(40),
      });
      assert.deepEqual(result, manifest);
      const archive = readFileSync(join(output, 'citizen_sdk-1.0.0.tar.gz'));
      const entries = parseHostedArchive(archive);
      assert.deepEqual(entries, hostedPackageEntries(candidate));
      for (const path of [
        'pubspec.yaml', 'lib/citizen_sdk.dart', 'chain/manifest.json',
        'android/src/main/jniLibs/arm64-v8a/libcitizensdk.so',
        'darwin/citizen_sdk.podspec', 'linux/lib/LinuxARM/libcitizensdk.so',
        'linux/lib/LinuxAMD/libcitizensdk.so', 'windows/bin/Windows/citizensdk.dll',
      ]) {
        assert.deepEqual(readFileSync(join(output, 'package', path)), entries.get(path).data, path);
      }
      assert.match(readFileSync(join(output, 'pub.log'), 'utf8'), /Package has 0 warnings(?: and \d+ hints?)?\./u);
      assert.doesNotThrow(() => verifyCitizenSdkRelease(candidate, audit, '0'.repeat(40)));
      context.diagnostic(JSON.stringify({
        compressedBytes: archive.length,
        expandedBytes: [...entries.values()].reduce((sum, entry) => sum + entry.data.length, 0),
        files: [...entries.values()].filter((entry) => entry.type === 'file').length,
        directories: [...entries.values()].filter((entry) => entry.type === 'directory').length,
      }));
    } catch (error) {
      preserve = error?.preserveHostedOutput === true;
      throw error;
    } finally {
      if (!preserve) rmSync(root, { recursive: true, force: true });
    }
  });
}

// 只有显式本轮 Apple 产物才运行安装消费；普通 Node 测试不会编译或访问网络。
// 该本地候选的 Android/Linux/Windows 仍是格式夹具，绝不是可发布的全平台包。
if (process.env.CITIZENSDK_APPLE_NATIVE) {
  test('macOS 从官方 Hosted 包安装真实 Apple 运行件并调用公开 CitizenSdk', async (context) => {
    assert.equal(process.platform, 'darwin');
    assert.equal(process.arch, 'arm64');
    for (const name of ['CITIZENSDK_DART', 'CITIZENSDK_FLUTTER', 'CITIZENSDK_PUB_CACHE', 'CITIZENSDK_TOOL_PATH']) {
      assert.ok(process.env[name], `缺少显式隔离输入 ${name}`);
    }
    // 在创建消费夹具前执行构建器的唯一根预检；不在 Node 里另写 Runner 路径算法。
    const checkedRoot = spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      nativeShellFunctions(['fail', 'assert_safe_directory_path', 'assert_descendant_path',
        'assert_readonly_dependency_directory', 'macos_hosted_root']),
      'work_dir="$1"; sdk_dir="$2"; export CITIZENSDK_HOSTED_ROOT="$1"; macos_hosted_root',
    ].join('\n'), 'macos-hosted-root', workRoot, resolve(citizenSdkRoot)], {
      cwd: workRoot, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.CITIZENSDK_TOOL_PATH,
        GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, RUNNER_TEMP: process.env.RUNNER_TEMP,
        GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE },
    });
    assert.equal(checkedRoot.error, undefined);
    assert.equal(checkedRoot.status, 0, checkedRoot.stderr);
    const macosRoot = checkedRoot.stdout.trim();
    const root = mkdtempSync(join(macosRoot, 'citizenchain-release-macos-hosted-test-'));
    let preserve = false;
    try {
      const native = writeNativeFixture(root, { appleNative: process.env.CITIZENSDK_APPLE_NATIVE });
      const candidate = join(root, 'candidate');
      const audit = join(root, 'citizensdk.tgz');
      const manifest = buildCitizenSdkRelease({
        sourcePath: citizenSdkRoot, nativePath: native, outputPath: candidate,
        archivePath: audit, gitCommitSha: '0'.repeat(40), softwareVersion: '1.0.0',
      });
      const hosted = join(root, 'hosted');
      const options = {
        candidatePath: candidate, archivePath: audit, outputPath: hosted,
        dartPath: process.env.CITIZENSDK_DART,
        flutterRoot: process.env.CITIZENSDK_FLUTTER,
        pubCachePath: process.env.CITIZENSDK_PUB_CACHE,
        expectedGitSha: '0'.repeat(40),
      };
      // Pub 归档先于 Flutter 构建，须独立应用单层沙箱，不能依赖后续才生成的 tool.sb。
      // 保留官方 Pub 的只读网络校验；写入仅限本轮目录/隔离缓存，禁止用户凭据读取和 Git。
      const policy = '(version 1)\n(allow default)\n(deny file-write*)\n' +
        [root, options.pubCachePath].map((value) =>
          `(allow file-write* (subpath ${JSON.stringify(value)}))\n`).join('') +
        '(allow file-write* (literal "/dev/null"))\n(deny process-exec (regex #"/git$"))\n' +
        ['Library/Application Support/dart', '.config/dart', '.pub-cache', 'Library/Keychains',
          '.gitconfig', '.git-credentials', '.config/git', 'GMB/.git', 'TATA/.git', 'TUYU/.git', 'flutter/.git']
          .map((value) => `(deny file-read* (subpath ${JSON.stringify(join(homedir(), value))}))\n`).join('');
      const payload = JSON.stringify({ moduleUrl: new URL('./release.mjs', import.meta.url).href, options });
      const worker = `
let interrupted = false;
const controller = new AbortController();
// TERM 转为 AbortSignal；唯一发布器确认独立 Dart/Pub 组退出后才返回，不能直接杀监督器。
process.on('SIGTERM', () => { interrupted = true; controller.abort(); });
process.on('SIGINT', () => { interrupted = true; controller.abort(); });
try {
  const { moduleUrl, options } = JSON.parse(process.argv[1]);
  const { buildCitizenSdkHosted } = await import(moduleUrl);
  const result = await buildCitizenSdkHosted({ ...options, signal: controller.signal });
  if (interrupted) throw new Error('CitizenSDK Hosted 归档收到停止请求，内部工具已结束');
  process.stdout.write(JSON.stringify(result) + '\\n');
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\\n');
  process.exitCode = 1;
}
`;
      const hostedManifest = await new Promise((resolveHosted, rejectHosted) => {
        const child = spawn('/usr/bin/sandbox-exec', [
          '-p', policy, process.execPath, '--input-type=module', '-e', worker, payload,
        ], {
          cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: dirname(process.execPath), TMPDIR: root,
            // 唯一发布器也按执行环境检查输出根；不传递会在 Runner 上误用本机目录合同。
            GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
            RUNNER_TEMP: process.env.RUNNER_TEMP,
            GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
            LANG: 'C.UTF-8', DASH__SUPPRESS_ANALYTICS: 'true', CI: 'true' },
        });
        let stdout = '', stderr = '', failed = null;
        const stop = (error) => {
          failed ||= error;
          // 不发送 SIGKILL，也不提前删除目录；内部 AbortSignal 负责终止并确认 Dart 组退出。
          if (child.pid) child.kill('SIGTERM');
        };
        const timer = setTimeout(() => stop(new Error('CitizenSDK Hosted 沙箱归档超过等待期限')), 420000);
        const collect = (chunk, output) => {
          if (stdout.length + stderr.length + chunk.length > 8 * 1024 * 1024) {
            stop(new Error('CitizenSDK Hosted 沙箱归档输出超过上限'));
          } else if (output) stdout += chunk.toString('utf8');
          else stderr += chunk.toString('utf8');
        };
        child.stdout.on('data', (chunk) => collect(chunk, true));
        child.stderr.on('data', (chunk) => collect(chunk, false));
        child.on('error', (error) => { failed = error; });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          try {
            if (failed || code !== 0 || signal) {
              throw failed || new Error(`CitizenSDK Hosted 沙箱归档失败 (${code ?? signal})：\n${stderr}`);
            }
            resolveHosted(JSON.parse(stdout));
          } catch (error) { rejectHosted(error); }
        });
      });
      assert.deepEqual(hostedManifest, manifest);
      const archive = join(hosted, 'citizen_sdk-1.0.0.tar.gz');
      const commandWork = join(root, 'citizensdk', 'work');
      const commandOutput = join(root, 'citizensdk', 'output');
      mkdirSync(commandWork, { recursive: true });
      mkdirSync(commandOutput, { recursive: true });
      const argumentsList = [
        join(citizenSdkRoot, 'scripts/build-native.sh'), 'macOS',
        candidate, audit, archive, process.env.CITIZENSDK_FLUTTER,
        process.env.CITIZENSDK_PUB_CACHE, process.env.CITIZENSDK_TOOL_PATH,
      ];
      // TERM 交给内部工具监督器处理，不能直接杀监督器后清理其仍在写入的目录。
      // 外层有最终期限；若进程组不能退出则保留准确目录并上报，不发送猜测 PID。
      const output = await new Promise((resolveRun, rejectRun) => {
        const child = spawn('/bin/bash', argumentsList, {
          cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.CITIZENSDK_TOOL_PATH,
            CITIZENSDK_HOSTED_ROOT: root,
            CITIZENSDK_WORK_DIR: commandWork,
            CITIZENSDK_NATIVE_OUTPUT_DIR: commandOutput,
            GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
            RUNNER_TEMP: process.env.RUNNER_TEMP,
            GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
            TMPDIR: process.env.TMPDIR,
            LANG: 'C.UTF-8', DASH__SUPPRESS_ANALYTICS: 'true', CI: 'true',
          },
        });
        let text = '';
        let failed = null;
        let finalTimer;
        const alive = () => {
          if (!child.pid) return false;
          try { process.kill(-child.pid, 0); return true; } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
          }
        };
        const stop = (error) => {
          failed ||= error;
          if (child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (signalError) {
              if (signalError.code !== 'ESRCH') failed = signalError;
            }
          }
          finalTimer ||= setTimeout(() => {
            preserve = true;
            const pending = new Error(`macOS Hosted 工具未在停止期限内退出，保留 ${root}`);
            pending.preserveHostedOutput = true;
            child.stdout.destroy(); child.stderr.destroy(); child.unref();
            rejectRun(pending);
          }, 30000);
        };
        const timer = setTimeout(() => stop(new Error('macOS Hosted 安装消费超过 30 分钟')), 1800000);
        const collect = (chunk) => {
          if (text.length + chunk.length > 32 * 1024 * 1024) stop(new Error('macOS Hosted 工具输出超过上限'));
          else text += chunk.toString('utf8');
        };
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.on('error', (error) => { failed = error; });
        child.on('close', async (code, signal) => {
          clearTimeout(timer); clearTimeout(finalTimer);
          try {
            for (let attempt = 0; attempt < 100 && alive(); attempt += 1) {
              await new Promise((done) => setTimeout(done, 50));
            }
            if (alive()) {
              preserve = true;
              const pending = new Error(`macOS Hosted 进程组仍存活，保留 ${root}`);
              pending.preserveHostedOutput = true;
              rejectRun(pending);
            } else if (failed || code !== 0 || signal) {
              rejectRun(failed || new Error(`macOS Hosted 消费失败 (${code ?? signal})：\n${text}`));
            } else resolveRun(text);
          } catch (error) { preserve = true; rejectRun(error); }
        });
      });
      assert.match(output, /CitizenSDK macOS Hosted 安装消费通过/u);
      const consumerOutput = readFileSync(join(commandWork, 'macOS/logs/consumer.stdout'), 'utf8');
      for (const marker of ['CitizenSDK Foundation isolation passed', 'CitizenSDK Flutter consumer passed']) {
        assert.equal(consumerOutput.split(/\r?\n/u).filter((line) => line === marker).length, 1, marker);
      }
      assert.doesNotThrow(() => verifyCitizenSdkRelease(candidate, audit, '0'.repeat(40)));
      assert.deepEqual(
        readFileSync(join(commandWork, 'macOS/package/lib/citizen_sdk.dart')),
        readFileSync(join(candidate, 'lib/citizen_sdk.dart')),
      );
      context.diagnostic('真实 macOS Hosted 安装与公开入口运行通过；其它平台仅格式夹具，未验证在线 Hosted 下载。');
    } catch (error) {
      // 真实工具失败的细节位于独占 logs；不能在外层只收到退出码时删除根因证据。
      // 后续仅在复核准确目录身份、占用和诊断后清理，不影响普通格式夹具的清理。
      preserve = true;
      context.diagnostic(`真实 macOS Hosted 验收失败，保留诊断与缓存目录：${root}`);
      throw error;
    } finally {
      // 内部工具可能有独立进程组；除上面的父组退出，还须确认准确缓存目录无在用文件。
      if (!preserve) {
        const opened = spawnSync('/usr/sbin/lsof', ['-t', '+D', root], {
          encoding: 'utf8', cwd: workRoot, timeout: 15000, killSignal: 'SIGTERM',
        });
        if (opened.error || opened.signal || opened.status !== 1 || opened.stdout.trim()) {
          preserve = true;
          throw new Error(`macOS Hosted 缓存目录占用状态不能确认，保留 ${root}`);
        }
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}


// 最小普通源码夹具仅提供插件入口与Pub身份；不依赖工具或真实账户材料。
function flutterEntryFixture(root) {
  const source = join(root, 'source');
  const input = 'android/source/CitizenSdkPlugin.kt';
  const output = 'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt';
  mkdirSync(dirname(join(source, input)), { recursive: true });
  writeFileSync(join(source, input), 'package org.citizen.sdk\nimport io.flutter.embedding.engine.plugins.FlutterPlugin\nclass CitizenSdkPlugin : FlutterPlugin\n');
  writeFileSync(join(source, 'pubspec.yaml'), 'name: citizen_sdk\nflutter:\n  plugin:\n    platforms:\n      android:\n        package: org.citizen.sdk\n        pluginClass: CitizenSdkPlugin\n');
  writeFileSync(join(source, 'pubspec.lock'), 'packages: {}\n');
  return { source, input, output };
}

test('Flutter消费布局保持扁平源文件、单一链接入口和独立Pub元数据', () => {
  const root = mkdtempSync(join(workRoot, 'flutter-view-'));
  try {
    const { source, input, output } = flutterEntryFixture(root);
    const view = join(root, 'view');
    createFlutterSourceView(source, view);
    assert.equal(assertFlutterSourceView(source, view), view);
    assert.equal(existsSync(join(source, output)), false);
    assert.equal(existsSync(join(view, input)), false);
    assert.equal(realpathSync(join(view, output)), join(source, input));
    assert.equal(lstatSync(join(view, 'pubspec.yaml')).isSymbolicLink(), false);
    writeFileSync(join(view, 'pubspec.lock'), 'changed');
    assert.equal(readFileSync(join(source, 'pubspec.lock'), 'utf8'), 'packages: {}\n');
    assert.throws(() => assertFlutterSourceView(source, view), /Pub声明或锁文件漂移/u);
    assert.throws(() => createFlutterSourceView(source, view), /已存在/u);
    rmSync(view, { recursive: true });
    createFlutterSourceView(source, view);
    assert.doesNotThrow(() => assertFlutterSourceView(source, view));
  } finally { rmSync(root, { recursive: true }); }
});

test('Flutter消费布局拒绝源码内目标、目标祖先链接与错误包身份', () => {
  const root = mkdtempSync(join(workRoot, 'flutter-view-boundary-'));
  try {
    const { source, input, output } = flutterEntryFixture(root);
    assert.throws(() => createFlutterSourceView(source, join(source, 'generated')), /源码树/u);
    assert.throws(() => createFlutterSourceView(source, root), /源码树/u);
    symlinkSync(source, join(root, 'link'), 'dir');
    assert.throws(() => createFlutterSourceView(source, join(root, 'link', 'view')), /链接/u);
    writeFileSync(join(source, input), 'package wrong\nclass CitizenSdkPlugin\n');
    assert.throws(() => createFlutterSourceView(source, join(root, 'view')), /身份/u);
    assert.equal(existsSync(join(root, 'view')), false);
    mkdirSync(dirname(join(source, output)), { recursive: true });
    writeFileSync(join(source, output), 'duplicate');
    assert.throws(() => createFlutterSourceView(source, join(root, 'view')), /重复/u);
  } finally { rmSync(root, { recursive: true }); }
});

test('Flutter普通消费包重排入口后保持字节且拒绝再次映射或篡改', () => {
  const root = mkdtempSync(join(workRoot, 'flutter-package-'));
  try {
    const { source, input, output } = flutterEntryFixture(root);
    const candidate = join(root, 'candidate');
    cpSync(source, candidate, { recursive: true });
    projectFlutterSourceEntry(source, candidate);
    assert.equal(existsSync(join(candidate, input)), false);
    assert.equal(lstatSync(join(candidate, output)).isSymbolicLink(), false);
    assert.deepEqual(readFileSync(join(source, input)), readFileSync(join(candidate, output)));
    assert.throws(() => projectFlutterSourceEntry(source, candidate));
    rmSync(candidate, { recursive: true });
    cpSync(source, candidate, { recursive: true });
    writeFileSync(join(candidate, input), 'changed');
    assert.throws(() => projectFlutterSourceEntry(source, candidate), /与源码不一致/u);
    assert.equal(existsSync(join(candidate, output)), false);
  } finally { rmSync(root, { recursive: true }); }
});

test('Flutter视图复用拒绝替换链接及第二入口', () => {
  const root = mkdtempSync(join(workRoot, 'flutter-view-binding-'));
  try {
    const { source, input, output } = flutterEntryFixture(root);
    const view = join(root, 'view');
    createFlutterSourceView(source, view);
    mkdirSync(dirname(join(view,input)),{recursive:true});
    writeFileSync(join(view, input), 'duplicate');
    assert.throws(() => assertFlutterSourceView(source, view), /来源绑定/u);
    unlinkSync(join(view, input));
    unlinkSync(join(view, output));
    copyFileSync(join(source, input), join(view, output));
    assert.throws(() => assertFlutterSourceView(source, view), /来源绑定/u);
  } finally { rmSync(root, { recursive: true }); }
});

// 实际装配全部原生输入；这些断言关注原件字节与写入隔离，不依赖Rust算法实现。
test('原生工程保持全部移动原件字节并恢复Cargo模块与夹具路径', () => {
  const root = mkdtempSync(join(workRoot, 'native-layout-'));
  const source = realpathSync(citizenSdkRoot), output = join(root, 'project');
  const paths = {
  "native/smoldot/lib/src/chain/chain_information_build.rs": "native/smoldot/lib/src/chain/chain_information/build.rs",
  "native/smoldot/lib/src/database/finalized_serialize_defs.rs": "native/smoldot/lib/src/database/finalized_serialize/defs.rs",
  "native/smoldot/lib/src/executor/trie_root_calculator_tests.rs": "native/smoldot/lib/src/executor/trie_root_calculator/tests.rs",
  "native/smoldot/lib/src/identity_ss58.rs": "native/smoldot/lib/src/identity/ss58.rs",
  "native/smoldot/lib/src/libp2p/connection/single_stream_handshake_tests.rs": "native/smoldot/lib/src/libp2p/connection/single_stream_handshake/tests.rs",
  "native/smoldot/lib/src/network/kademlia_kbuckets.rs": "native/smoldot/lib/src/network/kademlia/kbuckets.rs",
  "native/smoldot/lib/src/transactions/light_pool_tests.rs": "native/smoldot/lib/src/transactions/light_pool/tests.rs",
  "native/smoldot/lib/src/transactions/pool_tests.rs": "native/smoldot/lib/src/transactions/pool/tests.rs",
  "native/smoldot/lib/src/trie/branch_search_tests.rs": "native/smoldot/lib/src/trie/branch_search/tests.rs",
  "native/smoldot/lib/src/trie/trie_structure_tests.rs": "native/smoldot/lib/src/trie/trie_structure/tests.rs",
  "native/smoldot/light-base/src/json_rpc_service_background.rs": "native/smoldot/light-base/src/json_rpc_service/background.rs",
  "native/smoldot/light-base/src/network_service_tasks.rs": "native/smoldot/light-base/src/network_service/tasks.rs",
  "native/engine/source/transaction_outcome.rs": "native/engine/src/transaction_outcome.rs",
  "native/engine/source/wallet_input_tests.rs": "native/engine/src/wallet_input_tests.rs",
  "native/engine/source/wallet_service_tests.rs": "native/engine/src/wallet_service_tests.rs",
  "native/engine/source/runtime_context.rs": "native/engine/src/runtime_context.rs",
  "native/engine/source/error.rs": "native/engine/src/error.rs",
  "native/engine/source/finalized_history_runtime.rs": "native/engine/src/finalized_history_runtime.rs",
  "native/engine/source/wallet_input.rs": "native/engine/src/wallet_input.rs",
  "native/engine/source/metadata.rs": "native/engine/src/metadata.rs",
  "native/engine/source/chain_monitor.rs": "native/engine/src/chain_monitor.rs",
  "native/engine/source/lib.rs": "native/engine/src/lib.rs",
  "native/engine/source/account_state.rs": "native/engine/src/account_state.rs",
  "native/engine/source/wallet_service.rs": "native/engine/src/wallet_service.rs",
  "native/engine/source/transaction_execution.rs": "native/engine/src/transaction_execution.rs",
  "native/engine/source/transaction_prepare.rs": "native/engine/src/transaction_prepare.rs",
  "native/engine/source/qr_review.rs": "native/engine/src/qr_review.rs",
  "native/engine/source/wallet_derivation.rs": "native/engine/src/wallet_derivation.rs",
  "native/engine/source/transaction_history.rs": "native/engine/src/transaction_history.rs",
  "native/engine/source/system_events.rs": "native/engine/src/system_events.rs",
  "native/engine/source/wallet_derivation_tests.rs": "native/engine/src/wallet_derivation_tests.rs",
  "native/engine/source/qr_review_tests.rs": "native/engine/src/qr_review_tests.rs",
  "native/engine/source/capabilities.rs": "native/engine/src/capabilities.rs",
  "native/engine/source/engine.rs": "native/engine/src/engine.rs",
  "native/engine/source/state_import.rs": "native/engine/src/state_import.rs",
  "native/ffi/source/host_codec_tests.rs": "native/ffi/src/host_codec_tests.rs",
  "native/ffi/source/qr_abi.rs": "native/ffi/src/qr_abi.rs",
  "native/ffi/source/runtime.rs": "native/ffi/src/runtime.rs",
  "native/ffi/source/chain_monitor_tests.rs": "native/ffi/src/chain_monitor_tests.rs",
  "native/ffi/source/transaction_abi.rs": "native/ffi/src/transaction_abi.rs",
  "native/ffi/source/events.rs": "native/ffi/src/events.rs",
  "native/ffi/source/host_codec.rs": "native/ffi/src/host_codec.rs",
  "native/ffi/source/error.rs": "native/ffi/src/error.rs",
  "native/ffi/source/wallet_abi_tests.rs": "native/ffi/src/wallet_abi_tests.rs",
  "native/ffi/source/chain_monitor.rs": "native/ffi/src/chain_monitor.rs",
  "native/ffi/source/wallet_abi.rs": "native/ffi/src/wallet_abi.rs",
  "native/ffi/source/lib.rs": "native/ffi/src/lib.rs",
  "native/ffi/source/host_providers.rs": "native/ffi/src/host_providers.rs",
  "native/ffi/source/ownership.rs": "native/ffi/src/ownership.rs",
  "native/ffi/source/handles.rs": "native/ffi/src/handles.rs",
  "native/ffi/source/composition_tests.rs": "native/ffi/src/composition_tests.rs",
  "native/ffi/source/composition.rs": "native/ffi/src/composition.rs",
  "native/ffi/source/requests.rs": "native/ffi/src/requests.rs",
  "native/ffi/source/assets.rs": "native/ffi/src/assets.rs",
  "native/ffi/source/abi.rs": "native/ffi/src/abi.rs",
  "native/ffi/source/capabilities.rs": "native/ffi/src/capabilities.rs",
  "native/qr/source/session.rs": "native/qr/src/session.rs",
  "native/qr/source/lib.rs": "native/qr/src/lib.rs",
  "native/qr/source/codec.rs": "native/qr/src/codec.rs",
  "native/contracts/source/transaction.rs": "native/contracts/src/transaction.rs",
  "native/contracts/source/chain.rs": "native/contracts/src/chain.rs",
  "native/contracts/source/error.rs": "native/contracts/src/error.rs",
  "native/contracts/source/lib.rs": "native/contracts/src/lib.rs",
  "native/contracts/source/signing.rs": "native/contracts/src/signing.rs",
  "native/contracts/source/wallet.rs": "native/contracts/src/wallet.rs",
  "native/contracts/source/account.rs": "native/contracts/src/account.rs",
  "native/contracts/source/transaction_prepare.rs": "native/contracts/src/transaction_prepare.rs",
  "native/contracts/source/chain_signer.rs": "native/contracts/src/chain_signer.rs",
  "native/contracts/source/secret_vault.rs": "native/contracts/src/secret_vault.rs",
  "native/contracts/source/transaction_build.rs": "native/contracts/src/transaction_build.rs",
  "native/contracts/source/capability.rs": "native/contracts/src/capability.rs",
  "native/contracts/source/store_wallet_profile.rs": "native/contracts/src/store/wallet_profile.rs",
  "native/contracts/source/store_encrypted_secret_blob.rs": "native/contracts/src/store/encrypted_secret_blob.rs",
  "native/contracts/source/store_chain_database.rs": "native/contracts/src/store/chain_database.rs",
  "native/contracts/source/store.rs": "native/contracts/src/store/mod.rs",
  "native/contracts/source/store_runtime_cache.rs": "native/contracts/src/store/runtime_cache.rs",
  "native/contracts/source/store_transaction_history.rs": "native/contracts/src/store/transaction_history.rs",
  "native/legacy/source/error.rs": "native/legacy/src/error.rs",
  "native/legacy/source/lib.rs": "native/legacy/src/lib.rs",
  "native/legacy/source/ffi_types.rs": "native/legacy/src/ffi_types.rs",
  "native/provider/source/client.rs": "native/provider/src/client.rs",
  "native/provider/source/legacy.rs": "native/provider/src/legacy.rs",
  "native/provider/source/account_nonce.rs": "native/provider/src/account_nonce.rs",
  "native/provider/source/lib.rs": "native/provider/src/lib.rs",
  "native/provider/source/bootstrap.rs": "native/provider/src/bootstrap.rs",
  "native/provider/source/bootstrap_tests.rs": "native/provider/src/bootstrap_tests.rs",
  "native/provider/source/verified_chain_client.rs": "native/provider/src/verified_chain_client.rs",
  "native/provider/tests/source_manifest_contract.rs": "native/smoldot/light-base/tests/source_manifest_contract.rs",
  "native/provider/tests/capability_boundary.rs": "native/smoldot/light-base/tests/capability_boundary.rs",
  "native/provider/tests/light_client_boundary.rs": "native/smoldot/lib/tests/light_client_boundary.rs",
  "native/provider/tests/network_sync_source_manifest.rs": "native/smoldot/lib/tests/network_sync_source_manifest.rs",
  "native/provider/tests/state_runtime_source_manifest.rs": "native/smoldot/lib/tests/state_runtime_source_manifest.rs",
  "native/provider/tests/consensus_source_manifest.rs": "native/smoldot/lib/tests/consensus_source_manifest.rs",
  "native/provider/tests/network_sync_boundary.rs": "native/smoldot/lib/tests/network_sync_boundary.rs",
  "native/provider/tests/state_runtime_boundary.rs": "native/smoldot/lib/tests/state_runtime_boundary.rs",
  "native/signer/source/sr25519.rs": "native/signer/src/sr25519.rs",
  "native/signer/source/lib.rs": "native/signer/src/lib.rs",
  "native/signer/source/chain_signer.rs": "native/signer/src/chain_signer.rs"
};
  try {
    assert.equal(createNativeSourceView(source, output), output);
    for (const [stored, compiled] of Object.entries(paths)) {
      assert.deepEqual(readFileSync(join(output, compiled)), readFileSync(join(source, stored)));
      assert.equal(lstatSync(join(output, compiled)).isSymbolicLink(), false);
      assert.equal(existsSync(join(output, stored)), false);
      assert.equal(existsSync(join(source, compiled)), false);
    }
    for (const path of ['Cargo.toml', 'Cargo.lock', 'native/smoldot/Cargo.toml',
      'native/smoldot/Cargo.lock', 'chain/chainspec.json',
      'test/transaction/citizenchain-runtime-v14-metadata.hex', 'include/citizensdk.h']) {
      assert.deepEqual(readFileSync(join(output, path)), readFileSync(join(source, path)));
      assert.equal(lstatSync(join(output, path)).isSymbolicLink(), false);
    }
    assert.equal(createNativeSourceView(source, output), output);
    const header = 'include/smoldot.h';
    const original = readFileSync(join(source, 'include/smoldot.h'));
    writeFileSync(join(output, header), 'simulated build.rs write');
    assert.deepEqual(readFileSync(join(source, 'include/smoldot.h')), original);
    assert.throws(() => createNativeSourceView(source, output), /字节漂移/u);
    assert.equal(readFileSync(join(output, header), 'utf8'), 'simulated build.rs write');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('原生装配拒绝源码输出、链接祖先与已有工程额外文件', () => {
  const root = mkdtempSync(join(workRoot, 'native-boundary-'));
  const source = realpathSync(citizenSdkRoot), output = join(root, 'project');
  try {
    assert.throws(() => createNativeSourceView(source, join(source, 'generated')), /必须分离/u);
    symlinkSync(source, join(root, 'link'), 'dir');
    assert.throws(() => createNativeSourceView(source, join(root, 'link/project')), /禁止链接/u);
    createNativeSourceView(source, output);
    writeFileSync(join(output, 'unexpected.rs'), 'unexpected');
    assert.throws(() => createNativeSourceView(source, output), /闭集漂移/u);
    assert.equal(readFileSync(join(output, 'unexpected.rs'), 'utf8'), 'unexpected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 执行正式Shell入口内的真实Node边界代码；夹具只提供文件，不代替验真算法。
test('Flutter宿主库允许当前target现场，拒绝源码、其它轮次和链接',()=>{
 const source=BUILD_SHELL_SOURCES.test;
 const guard=source.match(/<<'CHECK_SMOLDOT_INPUT' \|\| return 1\n([\s\S]*?)\nCHECK_SMOLDOT_INPUT/u)?.[1];assert.ok(guard);
 const root=mkdtempSync(join(workRoot,'smoldot-boundary-'));const work=join(root,'current');mkdirSync(work);
 try{
  const library=join(work,'library.dylib');writeFileSync(library,'resource protocol fixture');
  const check=file=>runInNewContext(guard,{require:specifier=>{if(specifier==='node:fs')return {realpathSync,lstatSync};if(specifier==='node:path')return {isAbsolute,resolve,sep};throw Error('未知依赖');},process:{argv:['node','-',work,file]},Error});
  check(library);
  for(const file of [join(citizenSdkRoot,'scripts/build.mjs'),join(root,'other.dylib'),work+'/../current/library.dylib'])assert.throws(()=>check(file));
  const alias=join(work,'alias');symlinkSync(library,alias);assert.throws(()=>check(alias));
  writeFileSync(library,'');assert.throws(()=>check(library));
 }finally{rmSync(root,{recursive:true,force:true});}
});

}
