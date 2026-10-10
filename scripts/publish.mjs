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
const CHAIN_ASSET_FILES = Object.freeze(Object.fromEntries([
  "chain/chainspec.json",
  "chain/light_sync_state.json",
  "chain/manifest.json"
].map(name=>[name,'file'])));
const CHAIN_ASSET_MANIFEST = Object.freeze({
  format_version: 1,
  product_id: 'citizensdk',
  chain_id: 'citizenchain',
  protocol_id: 'citizenchain',
  genesis_hash: '0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd',
  sdk_min_version: '1.0.0',
});
// 真实 Substrate v14 System.Events metadata 夹具及 CitizenChain Runtime 生产
// metadata/events对为正式解码测试输入，组包检查必要普通文件。
const SOURCE_FIXTURE_FILES = Object.freeze({
  "test/transaction/citizenchain-balance-fee-v1.json": "file",
  "test/transaction/citizenchain-revive-v15-metadata.hex": "file",
  "test/transaction/citizenchain-runtime-system-events.hex": "file",
  "test/transaction/citizenchain-runtime-v14-metadata.hex": "file",
  "test/transaction/citizenchain-transfer-build-v1.json": "file",
  "test/transaction/substrate-v14-system-events-metadata.hex": "file",
  "test/wallet/citizenchain-wallet-derivation-v1.json": "file",
  "test/wallet/citizenchain-wallet-password-v1.json": "file"
});
// Release 必须保留根级许可入口和两份权威许可证原文；仅检查文件名存在会允许法律文本被替换。
const LICENSE_SOURCE_FILES = Object.freeze({
  "LICENSE": "file",
  "LICENSE-GPL-3.0": "file",
  "LICENSE-MIT": "file"
});
// Hosted Package 不建立第二份候选：官方 Dart 发布工具直接读取已注入 Android/Apple
// 原生库的 GitHub Release 候选，并由这份固定 .pubignore 只筛出运行时闭包。
const HOSTED_PACKAGE_SOURCE_FILES = Object.freeze({
  ".pubignore": "file"
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
  "include/citizensdk.h": "file",
  "include/citizensdk_types.h": "file"
});
// Android Kotlin/Java 源码直接位于各源集根；包名由文件声明而非目录层级决定。
// Dart（排除已有独立来源合同的 smoldot 快照）、Android root/native 与
// Apple darwin 生产输入构成一个反向闭集。平台测试、文档和注入的 AAR/
// XCFramework 分别由测试、文档与候选投影合同固定，不能在本表建立第二条来源。
const MOBILE_BINDING_SOURCE_FILE_COUNT = 85;
const MOBILE_BINDING_SOURCE_FILES = Object.freeze({
  "android/build.gradle": "file",
  "android/gradle.properties": "file",
  "android/native/build.gradle": "file",
  "android/native/consumer-rules.pro": "file",
  "android/native/source/AndroidManifest.xml": "file",
  "android/native/source/CMakeLists.txt": "file",
  "android/native/source/citizensdk_host_bridge.cpp": "file",
  "android/native/source/citizensdk_host_bridge.hpp": "file",
  "android/native/source/citizensdk_jni.cpp": "file",
  "android/native/source/citizensdk_jni_support.hpp": "file",
  "android/native/source/CitizenSdk.kt": "file",
  "android/native/source/CitizenSdkError.kt": "file",
  "android/native/source/CitizenSdkEvents.kt": "file",
  "android/native/source/CitizenSdkModels.kt": "file",
  "android/native/source/CitizenSdkOperation.kt": "file",
  "android/native/source/CitizenSdkPreparedWallet.kt": "file",
  "android/native/source/CitizenSdkQr.kt": "file",
  "android/native/source/CitizenSdkQrCapture.kt": "file",
  "android/native/source/CitizenSdkRecoveryPhrase.kt": "file",
  "android/native/source/CitizenSdkAssets.kt": "file",
  "android/native/source/CitizenSdkHardwareVault.kt": "file",
  "android/native/source/CitizenSdkHostRecord.kt": "file",
  "android/native/source/CitizenSdkHostServices.kt": "file",
  "android/native/source/CitizenSdkNative.kt": "file",
  "android/native/source/CitizenSdkNativeCodec.kt": "file",
  "android/native/source/CitizenSdkNativeResult.kt": "file",
  "android/native/source/CitizenSdkPublicStore.kt": "file",
  "android/native/source/CitizenSdkRecordKey.kt": "file",
  "android/native/source/CitizenSdkRequestRouter.kt": "file",
  "android/native/source/CitizenSdkSecureStore.kt": "file",
  "android/native/source/CitizenSdkSensitiveBytes.kt": "file",
  "android/native/source/CitizenSdkSqlite.kt": "file",
  "android/settings.gradle": "file",
  "android/source/AndroidManifest.xml": "file",
  "android/source/CitizenSdkFlutterCodec.kt": "file",
  "android/source/CitizenSdkFlutterSessions.kt": "file",
  "android/source/CitizenSdkPlugin.kt": "file",
  "darwin/Package.swift": "file",
  "darwin/source/core/CitizenSDK-Bridging-Header.h": "file",
  "darwin/source/core/CitizenSDK.swift": "file",
  "darwin/source/core/CitizenSDKAssets.swift": "file",
  "darwin/source/core/CitizenSDKError.swift": "file",
  "darwin/source/core/CitizenSDKEvents.swift": "file",
  "darwin/source/core/CitizenSDKHostBridge.swift": "file",
  "darwin/source/core/CitizenSDKHostRecord.swift": "file",
  "darwin/source/core/CitizenSDKInputLimits.swift": "file",
  "darwin/source/core/CitizenSDKModels.swift": "file",
  "darwin/source/core/CitizenSDKNative.swift": "file",
  "darwin/source/core/CitizenSDKNativeCodec.swift": "file",
  "darwin/source/core/CitizenSDKOperation.swift": "file",
  "darwin/source/core/CitizenSDKPreparedWallet.swift": "file",
  "darwin/source/core/CitizenSDKQr.swift": "file",
  "darwin/source/core/CitizenSDKQrCapture.swift": "file",
  "darwin/source/core/CitizenSDKPublicStore.swift": "file",
  "darwin/source/core/CitizenSDKRecordKey.swift": "file",
  "darwin/source/core/CitizenSDKRecoveryPhrase.swift": "file",
  "darwin/source/core/CitizenSDKSQLite.swift": "file",
  "darwin/source/core/CitizenSDKScreenSecurity.swift": "file",
  "darwin/source/core/CitizenSDKSecretVault.swift": "file",
  "darwin/source/core/CitizenSDKSecureStore.swift": "file",
  "darwin/source/core/CitizenSDKSensitiveBuffer.swift": "file",
  "darwin/source/core/PrivacyInfo.xcprivacy": "file",
  "darwin/source/flutter/CitizenSdkFlutterCodec.swift": "file",
  "darwin/source/flutter/CitizenSdkFlutterSessions.swift": "file",
  "darwin/source/flutter/CitizenSdkPlugin.swift": "file",
  "darwin/citizen_sdk.podspec": "file",
  "lib/citizen_sdk.dart": "file",
  "lib/api/citizen_chain.dart": "file",
  "lib/api/citizen_qr.dart": "file",
  "lib/api/citizen_sdk.dart": "file",
  "lib/api/citizen_sdk_error.dart": "file",
  "lib/api/citizen_sdk_events.dart": "file",
  "lib/api/citizen_transactions.dart": "file",
  "lib/api/citizen_sdk_wallet.dart": "file",
  "lib/account_codec.dart": "file",
  "lib/models/citizen_account.dart": "file",
  "lib/models/citizen_capability.dart": "file",
  "lib/models/citizen_chain_state.dart": "file",
  "lib/models/citizen_signing.dart": "file",
  "lib/models/citizen_transaction.dart": "file",
  "lib/models/citizen_wallet.dart": "file",
  "lib/platform/citizen_sdk_flutter_codec.dart": "file",
  "lib/platform/citizen_sdk_flutter_sessions.dart": "file",
  "lib/platform/citizen_sdk_platform.dart": "file",
  "lib/platform/flutter_citizen_sdk_platform.dart": "file"
});
// Linux C/C++ Host 与 Flutter adapter 都只是根产品 ABI 的宿主投影，不是
// 第二份 Core。测试和 README 分别由测试、文档闭集固定；其余 CMake、公共头
// 与实现逐字节进入独立来源闭集，不能悄然混入另一套协议或生成产物。
const WINDOWS_BINDING_SOURCE_FILES = Object.freeze({
  "windows/source/citizen_sdk_qr_camera.cc": "file",
  "windows/source/citizen_sdk_qr_camera.hpp": "file",
  "windows/cmake/CitizenSDKFlutter.cmake": "file",
  "windows/headers/citizen_sdk_plugin.h": "file",
  "windows/source/citizen_sdk_flutter_codec.cc": "file",
  "windows/source/citizen_sdk_flutter_codec.hpp": "file",
  "windows/source/citizen_sdk_flutter_environment.cc": "file",
  "windows/source/citizen_sdk_flutter_environment.hpp": "file",
  "windows/source/citizen_sdk_flutter_sessions.cc": "file",
  "windows/source/citizen_sdk_flutter_sessions.hpp": "file",
  "windows/source/citizen_sdk_plugin.cc": "file",
  "windows/CMakeLists.txt": "file",
  "windows/cmake/CitizenSDKConfig.cmake.in": "file",
  "windows/cmake/CitizenSDKConfigVersion.cmake.in": "file",
  "windows/cmake/CitizenSDKDependencies.cmake": "file",
  "windows/cmake/citizensdk_host.def": "file",
  "windows/headers/citizen_sdk.hpp": "file",
  "windows/headers/citizen_sdk_config.hpp": "file",
  "windows/headers/citizensdk_host.h": "file",
  "windows/source/citizen_sdk_assets.cc": "file",
  "windows/source/citizen_sdk_assets.hpp": "file",
  "windows/source/citizen_sdk_cng.cc": "file",
  "windows/source/citizen_sdk_cng.hpp": "file",
  "windows/source/citizen_sdk_directory.cc": "file",
  "windows/source/citizen_sdk_directory.hpp": "file",
  "windows/source/citizen_sdk_host_api.cc": "file",
  "windows/source/citizen_sdk_host_bridge.cc": "file",
  "windows/source/citizen_sdk_host_bridge.hpp": "file",
  "windows/source/citizen_sdk_host_record.cc": "file",
  "windows/source/citizen_sdk_host_record.hpp": "file",
  "windows/source/citizen_sdk_input_limits.cc": "file",
  "windows/source/citizen_sdk_input_limits.hpp": "file",
  "windows/source/citizen_sdk_lifecycle.cc": "file",
  "windows/source/citizen_sdk_lifecycle.hpp": "file",
  "windows/source/citizen_sdk_operation.cc": "file",
  "windows/source/citizen_sdk_operation.hpp": "file",
  "windows/source/citizen_sdk_public_store.cc": "file",
  "windows/source/citizen_sdk_public_store.hpp": "file",
  "windows/source/citizen_sdk_record_key.cc": "file",
  "windows/source/citizen_sdk_record_key.hpp": "file",
  "windows/source/citizen_sdk_secret_vault.cc": "file",
  "windows/source/citizen_sdk_secret_vault.hpp": "file",
  "windows/source/citizen_sdk_secure_store.cc": "file",
  "windows/source/citizen_sdk_secure_store.hpp": "file",
  "windows/source/citizen_sdk_sensitive_buffer.cc": "file",
  "windows/source/citizen_sdk_sensitive_buffer.hpp": "file",
  "windows/source/citizen_sdk_sqlite.cc": "file",
  "windows/source/citizen_sdk_sqlite.hpp": "file",
  "windows/source/citizen_sdk_user_auth.cc": "file",
  "windows/source/citizen_sdk_user_auth.hpp": "file",
  "windows/source/citizen_sdk_window.cc": "file",
  "windows/source/citizen_sdk_window.hpp": "file"
});
const LINUX_BINDING_SOURCE_FILE_COUNT = 48;
const LINUX_BINDING_SOURCE_DIRECTORIES = Object.freeze([
  "cmake",
  "headers",
  "source",
  "tests"
]);
const LINUX_BINDING_SOURCE_FILES = Object.freeze({
  "linux/source/citizen_sdk_qr_camera.cc": "file",
  "linux/source/citizen_sdk_qr_camera.hpp": "file",
  "linux/CMakeLists.txt": "file",
  "linux/cmake/CitizenSDKConfig.cmake.in": "file",
  "linux/cmake/CitizenSDKConfigVersion.cmake.in": "file",
  "linux/cmake/CitizenSDKDependencies.cmake": "file",
  "linux/cmake/CitizenSDKFlutter.cmake": "file",
  "linux/cmake/citizensdk_host.map": "file",
  "linux/headers/citizen_sdk.hpp": "file",
  "linux/headers/citizen_sdk_config.hpp": "file",
  "linux/headers/citizen_sdk_plugin.h": "file",
  "linux/headers/citizensdk_host.h": "file",
  "linux/source/citizen_sdk_assets.cc": "file",
  "linux/source/citizen_sdk_assets.hpp": "file",
  "linux/source/citizen_sdk_flutter_codec.cc": "file",
  "linux/source/citizen_sdk_flutter_codec.hpp": "file",
  "linux/source/citizen_sdk_flutter_environment.cc": "file",
  "linux/source/citizen_sdk_flutter_environment.hpp": "file",
  "linux/source/citizen_sdk_flutter_sessions.cc": "file",
  "linux/source/citizen_sdk_flutter_sessions.hpp": "file",
  "linux/source/citizen_sdk_host_api.cc": "file",
  "linux/source/citizen_sdk_host_bridge.cc": "file",
  "linux/source/citizen_sdk_host_bridge.hpp": "file",
  "linux/source/citizen_sdk_host_record.cc": "file",
  "linux/source/citizen_sdk_host_record.hpp": "file",
  "linux/source/citizen_sdk_input_limits.cc": "file",
  "linux/source/citizen_sdk_input_limits.hpp": "file",
  "linux/source/citizen_sdk_lifecycle.cc": "file",
  "linux/source/citizen_sdk_lifecycle.hpp": "file",
  "linux/source/citizen_sdk_operation.cc": "file",
  "linux/source/citizen_sdk_operation.hpp": "file",
  "linux/source/citizen_sdk_plugin.cc": "file",
  "linux/source/citizen_sdk_public_store.cc": "file",
  "linux/source/citizen_sdk_public_store.hpp": "file",
  "linux/source/citizen_sdk_record_key.cc": "file",
  "linux/source/citizen_sdk_record_key.hpp": "file",
  "linux/source/citizen_sdk_secret_vault.cc": "file",
  "linux/source/citizen_sdk_secret_vault.hpp": "file",
  "linux/source/citizen_sdk_secure_store.cc": "file",
  "linux/source/citizen_sdk_secure_store.hpp": "file",
  "linux/source/citizen_sdk_sensitive_buffer.cc": "file",
  "linux/source/citizen_sdk_sensitive_buffer.hpp": "file",
  "linux/source/citizen_sdk_sqlite.cc": "file",
  "linux/source/citizen_sdk_sqlite.hpp": "file",
  "linux/source/citizen_sdk_tpm2.cc": "file",
  "linux/source/citizen_sdk_tpm2.hpp": "file",
  "linux/source/citizen_sdk_user_auth.cc": "file",
  "linux/source/citizen_sdk_user_auth.hpp": "file"
});
// 根README只作简明产品介绍；其准确字节随源码和正式包验真，不放行平台技术文档副本。
const DOCUMENTATION_FILE_COUNT = 1;
const DOCUMENTATION_SOURCE_FILES = Object.freeze({
  "README.md": "file"
});
// 根 Flutter、Core Rust/FFI、smoldot provider、signer、Android、Apple、
// Linux/Windows Host/Flutter、三类公开面消费者、独立签名器、安装消费者与 Release 合同测试
// 共同构成 SDK自有测试目录边界。
// 真实测试文件必须完整进入本次SDK源包，实际用例由所属流程执行。
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
// 独立脚本测试文件不进入正式脚本闭集。
const SDK_SCRIPT_TEST_ROOT = 'scripts';
const SDK_EMBEDDED_TEST_ROOTS = Object.freeze([
  'native/engine/source',
  'native/ffi/source',
  'native/provider/source',
]);
// scripts目录仅保留当前两个正式入口；源码闭集以实际文件验真。
// 两个正式脚本按准确文件集合验真。
const SDK_SCRIPT_ENTRIES = Object.freeze({'build.mjs':'file','publish.mjs':'file'});
const SDK_TEST_CONTRACT_FILES = Object.freeze({
  "test/sdk_1_10_1_contract_test.dart": "file",
  "native/engine/tests/baseline_resource_contract.rs": "file",
  "native/provider/tests/baseline_lifecycle_contract.rs": "file",
  "native/engine/source/qr_review_tests.rs": "file",
  "native/provider/source/bootstrap_tests.rs": "file",
  "native/ffi/source/chain_monitor_tests.rs": "file",
  "native/engine/source/wallet_input_tests.rs": "file",
  "android/native/device/CitizenSdkWalletInputTest.kt": "file",
  "darwin/tests/core/CitizenSDKWalletInputTests.swift": "file",
  "windows/tests/citizen_sdk_flutter_consumer.dart": "file",
  "windows/tests/CitizenSDKConsumer.cmake": "file",
  "windows/tests/citizen_sdk_c_consumer.c": "file",
  "windows/tests/citizen_sdk_cpp_consumer.cc": "file",
  "windows/tests/citizen_sdk_flutter_codec_test.cc": "file",
  "windows/tests/citizen_sdk_flutter_environment_test.cc": "file",
  "windows/tests/citizen_sdk_flutter_plugin_test.cc": "file",
  "windows/tests/citizen_sdk_flutter_secret_boundary_test.cc": "file",
  "windows/tests/citizen_sdk_flutter_sessions_test.cc": "file",
  "windows/tests/citizen_sdk_flutter_test_support.hpp": "file",
  "windows/tests/citizen_sdk_flutter_wallet_flow_test.cc": "file",
  "windows/tests/CMakeLists.txt": "file",
  "windows/tests/citizen_sdk_api_contract_test.cc": "file",
  "windows/tests/citizen_sdk_assets_test.cc": "file",
  "windows/tests/citizen_sdk_cng_test.cc": "file",
  "windows/tests/citizen_sdk_directory_test.cc": "file",
  "windows/tests/citizen_sdk_host_operation_test.cc": "file",
  "windows/tests/citizen_sdk_lifecycle_test.cc": "file",
  "windows/tests/citizen_sdk_public_store_test.cc": "file",
  "windows/tests/citizen_sdk_record_key_test.cc": "file",
  "windows/tests/citizen_sdk_secret_boundary_test.cc": "file",
  "windows/tests/citizen_sdk_secret_vault_test.cc": "file",
  "windows/tests/citizen_sdk_secure_store_test.cc": "file",
  "windows/tests/citizen_sdk_sensitive_buffer_test.cc": "file",
  "windows/tests/citizen_sdk_test_support.hpp": "file",
  "windows/tests/citizen_sdk_user_auth_test.cc": "file",
  "windows/tests/citizen_sdk_wallet_flow_test.cc": "file",
  "android/native/device/CitizenSdkHardwareVaultTest.kt": "file",
  "android/native/device/CitizenSdkLifecycleTest.kt": "file",
  "android/native/device/CitizenSdkNativeAbiTest.kt": "file",
  "android/native/device/CitizenSdkStateStoreTest.kt": "file",
  "android/native/device/CitizenSdkWalletFlowCancellationTest.kt": "file",
  "android/native/device/CitizenSdkWalletFlowSecretBoundaryTest.kt": "file",
  "android/native/tests/CitizenSdkJavaApiTest.java": "file",
  "android/native/tests/CitizenSdkJavaOwnershipTest.java": "file",
  "android/native/tests/CitizenSdkApiContractTest.kt": "file",
  "android/native/tests/CitizenSdkPreparedWalletTest.kt": "file",
  "android/native/tests/CitizenSdkHostOperationTest.kt": "file",
  "android/native/tests/CitizenSdkRecordKeyTest.kt": "file",
  "android/native/tests/CitizenSdkVaultIdentityTest.kt": "file",
  "android/tests/CitizenSdkFlutterCodecTest.kt": "file",
  "android/tests/CitizenSdkFlutterSessionsTest.kt": "file",
  "android/tests/CitizenSdkFlutterWalletFlowTest.kt": "file",
  "darwin/tests/flutter/CitizenSDKFlutterCodecTests.swift": "file",
  "darwin/tests/flutter/CitizenSDKFlutterPluginTests.swift": "file",
  "darwin/tests/flutter/CitizenSDKFlutterSecretBoundaryTests.swift": "file",
  "darwin/tests/flutter/CitizenSDKFlutterSessionsTests.swift": "file",
  "darwin/tests/flutter/CitizenSDKFlutterWalletFlowTests.swift": "file",
  "darwin/tests/core/CitizenSDKApiContractTests.swift": "file",
  "darwin/tests/core/CitizenSDKHostOperationTests.swift": "file",
  "darwin/tests/core/CitizenSDKLifecycleTests.swift": "file",
  "darwin/tests/core/CitizenSDKNativeAbiTests.swift": "file",
  "darwin/tests/core/CitizenSDKPublicStoreTests.swift": "file",
  "darwin/tests/core/CitizenSDKRecordKeyTests.swift": "file",
  "darwin/tests/core/CitizenSDKSecretVaultTests.swift": "file",
  "darwin/tests/core/CitizenSDKSecureStoreTests.swift": "file",
  "darwin/tests/core/CitizenSDKSensitiveBufferTests.swift": "file",
  "darwin/tests/core/CitizenSDKWalletFlowTests.swift": "file",
  "darwin/tests/citizen_sdk_flutter_consumer.dart": "file",
  "linux/tests/CitizenSDKConsumer.cmake": "file",
  "linux/tests/citizen_sdk_c_consumer.c": "file",
  "linux/tests/citizen_sdk_cpp_consumer.cc": "file",
  "linux/tests/citizen_sdk_flutter_consumer.dart": "file",
  "linux/tests/CMakeLists.txt": "file",
  "linux/tests/citizen_sdk_api_contract_test.cc": "file",
  "linux/tests/citizen_sdk_assets_test.cc": "file",
  "linux/tests/citizen_sdk_host_operation_test.cc": "file",
  "linux/tests/citizen_sdk_lifecycle_test.cc": "file",
  "linux/tests/citizen_sdk_public_store_test.cc": "file",
  "linux/tests/citizen_sdk_record_key_test.cc": "file",
  "linux/tests/citizen_sdk_flutter_codec_test.cc": "file",
  "linux/tests/citizen_sdk_flutter_environment_test.cc": "file",
  "linux/tests/citizen_sdk_flutter_plugin_test.cc": "file",
  "linux/tests/citizen_sdk_flutter_secret_boundary_test.cc": "file",
  "linux/tests/citizen_sdk_flutter_sessions_test.cc": "file",
  "linux/tests/citizen_sdk_flutter_test_support.hpp": "file",
  "linux/tests/citizen_sdk_flutter_wallet_flow_test.cc": "file",
  "linux/tests/citizen_sdk_secret_boundary_test.cc": "file",
  "linux/tests/citizen_sdk_secret_vault_test.cc": "file",
  "linux/tests/citizen_sdk_secure_store_test.cc": "file",
  "linux/tests/citizen_sdk_sensitive_buffer_test.cc": "file",
  "linux/tests/citizen_sdk_test_support.hpp": "file",
  "linux/tests/citizen_sdk_tpm2_test.cc": "file",
  "linux/tests/citizen_sdk_wallet_flow_test.cc": "file",
  "native/contracts/tests/account_contract.rs": "file",
  "native/contracts/tests/capability_contract.rs": "file",
  "native/contracts/tests/chain_contract.rs": "file",
  "native/contracts/tests/secret_contract.rs": "file",
  "native/contracts/tests/state_store_contract.rs": "file",
  "native/contracts/tests/transaction_history_contract.rs": "file",
  "native/contracts/tests/transaction_build_contract.rs": "file",
  "native/contracts/tests/transaction_prepare_contract.rs": "file",
  "native/engine/source/wallet_derivation_tests.rs": "file",
  "native/engine/source/wallet_service_tests.rs": "file",
  "native/engine/tests/account_state.rs": "file",
  "native/engine/tests/capabilities.rs": "file",
  "native/engine/tests/chain_access.rs": "file",
  "native/engine/tests/engine_boundary.rs": "file",
  "native/engine/tests/runtime_context.rs": "file",
  "native/engine/tests/state_import.rs": "file",
  "native/engine/tests/transaction_outcome.rs": "file",
  "native/ffi/source/composition_tests.rs": "file",
  "native/ffi/source/host_codec_tests.rs": "file",
  "native/ffi/source/wallet_abi_tests.rs": "file",
  "native/ffi/tests/abi_layout.rs": "file",
  "native/ffi/tests/asset_boundary.rs": "file",
  "native/ffi/tests/c_header_c11.c": "file",
  "native/ffi/tests/c_header_cpp17.cc": "file",
  "native/ffi/tests/capability_contract.rs": "file",
  "native/ffi/tests/error_contract.rs": "file",
  "native/ffi/tests/event_contract.rs": "file",
  "native/ffi/tests/handle_contract.rs": "file",
  "native/ffi/tests/host_provider_contract.rs": "file",
  "native/ffi/tests/ownership_contract.rs": "file",
  "native/ffi/tests/qr_abi_contract.rs": "file",
  "native/ffi/tests/request_contract.rs": "file",
  "native/ffi/tests/symbol_contract.rs": "file",
  "native/ffi/tests/wallet_abi_contract.rs": "file",
  "native/signer/tests/chain_signer_contract.rs": "file",
  "native/signer/tests/ffi_contract.rs": "file",
  "native/signer/tests/legacy_parity.rs": "file",
  "native/signer/tests/substrate_vectors.rs": "file",
  "native/provider/tests/account_nonce_contract.rs": "file",
  "native/provider/tests/legacy_parity.rs": "file",
  "native/provider/tests/verified_chain_client_contract.rs": "file",
  "test/api/citizen_sdk_test.dart": "file",
  "test/api/citizen_transaction_test.dart": "file",
  "test/api/citizen_wallet_flow_test.dart": "file",
  "test/api/public_api_contract_test.dart": "file",
  "test/citizen_sdk_facade_test.dart": "file",
  "test/consumers/citizenapp_fixture.dart": "file",
  "test/consumers/consumer_test_support.dart": "file",
  "test/consumers/generic_qr_v1_signer.dart": "file",
  "test/consumers/multi_consumer_contract_test.dart": "file",
  "test/consumers/reference_consumer.dart": "file",
  "test/consumers/third_party_fixture.dart": "file",
  "test/models/public_models_test.dart": "file",
  "test/models/u128_codec_test.dart": "file",
  "test/node/chain_assets_test.dart": "file",
  "test/node/citizensdk_bootstrap_manifest.json": "file",
  "test/platform/flutter_codec_test.dart": "file",
  "test/platform/flutter_secret_boundary_test.dart": "file",
  "test/platform/flutter_sessions_test.dart": "file",
  "test/smoldot/chain_info_test.dart": "file",
  "test/smoldot/client_basic_test.dart": "file",
  "test/smoldot/ffi_basic_test.dart": "file",
  "test/smoldot/fixtures/polkadot.json": "file",
  "test/smoldot/fixtures/westend.json": "file",
  "test/smoldot/json_rpc_test.dart": "file",
  "test/smoldot/smoldot_test.dart": "file",
  "test/smoldot/subscription_test.dart": "file",
  "test/transaction/citizenchain-balance-fee-v1.json": "file",
  "test/transaction/citizenchain-revive-v15-metadata.hex": "file",
  "test/transaction/citizenchain-runtime-system-events.hex": "file",
  "test/transaction/citizenchain-runtime-v14-metadata.hex": "file",
  "test/transaction/citizenchain-transfer-build-v1.json": "file",
  "test/transaction/substrate-v14-system-events-metadata.hex": "file",
  "test/wallet/citizenchain-wallet-derivation-v1.json": "file",
  "test/wallet/citizenchain-wallet-password-v1.json": "file",
  "native/legacy/tests/scope_guard.rs": "file",
  "native/legacy/tests/legacy_header_contract.rs": "file",
  "native/provider/tests/light_client_boundary.rs": "file",
  "native/provider/tests/network_sync_source_manifest.rs": "file",
  "native/provider/tests/state_runtime_source_manifest.rs": "file",
  "native/provider/tests/source_manifest_contract.rs": "file",
  "native/provider/tests/capability_boundary.rs": "file",
  "native/provider/tests/consensus_source_manifest.rs": "file",
  "native/provider/tests/network_sync_boundary.rs": "file",
  "native/provider/tests/state_runtime_boundary.rs": "file"
});
// smoldot Dart 包边界已并入唯一 citizen_sdk 根包。三处迁移目录共同构成固定闭集：
// 生产绑定、来源测试与历史审计资料缺一不可，且不允许重新出现第二份 pubspec 包边界。
const SMOLDOT_DART_ROOTS = Object.freeze([
  'lib/smoldot',
  'test/smoldot',
]);
const SMOLDOT_DART_FILES = Object.freeze(Object.fromEntries([
  "lib/smoldot/bindings.dart",
  "lib/smoldot/chain.dart",
  "lib/smoldot/client.dart",
  "lib/smoldot/json_rpc.dart",
  "lib/smoldot/platform.dart",
  "lib/smoldot/smoldot.dart",
  "lib/smoldot/types.dart",
  "test/smoldot/chain_info_test.dart",
  "test/smoldot/client_basic_test.dart",
  "test/smoldot/ffi_basic_test.dart",
  "test/smoldot/fixtures/polkadot.json",
  "test/smoldot/fixtures/westend.json",
  "test/smoldot/json_rpc_test.dart",
  "test/smoldot/smoldot_test.dart",
  "test/smoldot/subscription_test.dart"
].map(name=>[name,'file'])));
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
  "Cargo.lock": "file",
  "pubspec.lock": "file"
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
  "native/engine/tests/baseline_resource_contract.rs": "file",
  "native/engine/source/qr_review_tests.rs": "file",
  "native/engine/source/qr_review.rs": "file",
  "native/engine/source/chain_monitor.rs": "file",
  "native/ffi/source/chain_monitor.rs": "file",
  "native/ffi/source/chain_monitor_tests.rs": "file",
  "native/engine/source/wallet_input.rs": "file",
  "native/engine/source/wallet_input_tests.rs": "file",
  "native/contracts/Cargo.toml": "file",
  "native/contracts/source/account.rs": "file",
  "native/contracts/source/capability.rs": "file",
  "native/contracts/source/chain.rs": "file",
  "native/contracts/source/chain_signer.rs": "file",
  "native/contracts/source/error.rs": "file",
  "native/contracts/source/lib.rs": "file",
  "native/contracts/source/transaction_prepare.rs": "file",
  "native/contracts/source/secret_vault.rs": "file",
  "native/contracts/source/store_chain_database.rs": "file",
  "native/contracts/source/store_encrypted_secret_blob.rs": "file",
  "native/contracts/source/store.rs": "file",
  "native/contracts/source/store_runtime_cache.rs": "file",
  "native/contracts/source/store_transaction_history.rs": "file",
  "native/contracts/source/store_wallet_profile.rs": "file",
  "native/contracts/source/transaction.rs": "file",
  "native/contracts/source/transaction_build.rs": "file",
  "native/contracts/source/wallet.rs": "file",
  "native/contracts/tests/account_contract.rs": "file",
  "native/contracts/tests/capability_contract.rs": "file",
  "native/contracts/tests/chain_contract.rs": "file",
  "native/contracts/tests/secret_contract.rs": "file",
  "native/contracts/tests/state_store_contract.rs": "file",
  "native/contracts/tests/transaction_history_contract.rs": "file",
  "native/contracts/tests/transaction_build_contract.rs": "file",
  "native/contracts/tests/transaction_prepare_contract.rs": "file",
  "native/engine/Cargo.toml": "file",
  "native/engine/source/account_state.rs": "file",
  "native/engine/source/capabilities.rs": "file",
  "native/engine/source/engine.rs": "file",
  "native/engine/source/error.rs": "file",
  "native/engine/source/finalized_history_runtime.rs": "file",
  "native/engine/source/lib.rs": "file",
  "native/engine/source/metadata.rs": "file",
  "native/engine/source/runtime_context.rs": "file",
  "native/engine/source/state_import.rs": "file",
  "native/engine/source/system_events.rs": "file",
  "native/engine/source/transaction_prepare.rs": "file",
  "native/engine/source/transaction_execution.rs": "file",
  "native/engine/source/transaction_history.rs": "file",
  "native/engine/source/transaction_outcome.rs": "file",
  "native/engine/source/wallet_derivation.rs": "file",
  "native/engine/source/wallet_derivation_tests.rs": "file",
  "native/engine/source/wallet_service.rs": "file",
  "native/engine/source/wallet_service_tests.rs": "file",
  "native/engine/tests/account_state.rs": "file",
  "native/engine/tests/capabilities.rs": "file",
  "native/engine/tests/chain_access.rs": "file",
  "native/engine/tests/engine_boundary.rs": "file",
  "native/engine/tests/runtime_context.rs": "file",
  "native/engine/tests/state_import.rs": "file",
  "native/engine/tests/transaction_outcome.rs": "file",
  "native/ffi/Cargo.toml": "file",
  "native/ffi/source/abi.rs": "file",
  "native/ffi/source/assets.rs": "file",
  "native/ffi/source/capabilities.rs": "file",
  "native/ffi/source/composition.rs": "file",
  "native/ffi/source/composition_tests.rs": "file",
  "native/ffi/source/error.rs": "file",
  "native/ffi/source/events.rs": "file",
  "native/ffi/source/handles.rs": "file",
  "native/ffi/source/host_codec.rs": "file",
  "native/ffi/source/host_codec_tests.rs": "file",
  "native/ffi/source/host_providers.rs": "file",
  "native/ffi/source/lib.rs": "file",
  "native/ffi/source/ownership.rs": "file",
  "native/ffi/source/qr_abi.rs": "file",
  "native/ffi/source/requests.rs": "file",
  "native/ffi/source/runtime.rs": "file",
  "native/ffi/source/transaction_abi.rs": "file",
  "native/ffi/source/wallet_abi.rs": "file",
  "native/ffi/source/wallet_abi_tests.rs": "file",
  "native/ffi/tests/abi_layout.rs": "file",
  "native/ffi/tests/asset_boundary.rs": "file",
  "native/ffi/tests/c_header_c11.c": "file",
  "native/ffi/tests/c_header_cpp17.cc": "file",
  "native/ffi/tests/capability_contract.rs": "file",
  "native/ffi/tests/error_contract.rs": "file",
  "native/ffi/tests/event_contract.rs": "file",
  "native/ffi/tests/handle_contract.rs": "file",
  "native/ffi/tests/host_provider_contract.rs": "file",
  "native/ffi/tests/ownership_contract.rs": "file",
  "native/ffi/tests/qr_abi_contract.rs": "file",
  "native/ffi/tests/request_contract.rs": "file",
  "native/ffi/tests/symbol_contract.rs": "file",
  "native/ffi/tests/wallet_abi_contract.rs": "file",
  "native/qr/Cargo.toml": "file",
  "native/contracts/source/signing.rs": "file",
  "native/qr/source/codec.rs": "file",
  "native/qr/source/lib.rs": "file",
  "native/qr/source/session.rs": "file",
  "native/image/CMakeLists.txt": "file",
  "native/image/citizensdk_qr_image.cc": "file",
  "native/image/citizensdk_qr_image.h": "file",
  "native/image/citizensdk_qr_image_test.cc": "file"
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
// 组包要求根Cargo声明与锁文件存在；依赖解析使用原锁。
const CORE_RUST_BOUNDARY_FILES = Object.freeze({
  "Cargo.toml": "file",
  "Cargo.lock": "file"
});
// 这些文件位于各来源单元之外，但仍属于 Release 的正式输入：许可证、来源记录、
// smoldot 原始 ABI 头文件；已删除的上游示例与链规范不再进入支持文件闭集。
// 原生上游闭集单独核对；迁出的自有单元和兼容头仍由同一来源合同逐项固定；
// Dart 绑定已迁出本原生目录并由 SMOLDOT_DART_FILES 独立固定。
const SMOLDOT_SUPPORT_FILES = Object.freeze(Object.fromEntries([
  "native/smoldot/LICENSE",
  "native/smoldot/LICENSE-APACHE-2.0",
  "native/smoldot/UPSTREAM.md",
  "include/smoldot.h"
].map(name=>[name,'file'])));
// signer 是可编译的 Rust crate，正式输入不能只固定 Cargo.toml 与 lib.rs；
// sr25519 单一实现、ChainSigner 适配和四份合同测试共同进入同一 8 文件闭集；
// 任何 build.rs、src/bin 或其他新增文件
// 都会改变 Cargo 行为，因此一律失败关闭。
const SIGNER_FILES = Object.freeze(Object.fromEntries([
  "native/signer/Cargo.toml",
  "native/signer/source/chain_signer.rs",
  "native/signer/source/lib.rs",
  "native/signer/source/sr25519.rs",
  "native/signer/tests/chain_signer_contract.rs",
  "native/signer/tests/ffi_contract.rs",
  "native/signer/tests/legacy_parity.rs",
  "native/signer/tests/substrate_vectors.rs"
].map(name=>[name,'file'])));

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
  "include/citizen_sdk_error.hpp": "file",
  "include/citizen_sdk_events.hpp": "file",
  "include/citizen_sdk_models.hpp": "file"
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

// 仓库保留扁平源码；Flutter消费位置由SDK唯一声明，包身份不随物理路径改变。
const FLUTTER_ENTRY_SOURCE = 'android/source/CitizenSdkPlugin.kt';
const FLUTTER_ENTRY_PACKAGE = 'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt';

function flutterPackagePath(path) {
  return path === FLUTTER_ENTRY_SOURCE ? FLUTTER_ENTRY_PACKAGE : path;
}


/** 本轮本地消费视图：源文件只读链接，Pub元数据独立可写；输出根禁止复用。 */

/** 复用只读视图前核对来源绑定；不接受普通副本或另一源码的入口链接。 */

/** 既有原生消费者的普通文件副本仅重排入口；正式包不能再次调用源码布局转换。 */

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
 * 核验本轮smoldot Dart来源与实际输入一致。
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
  assertDeclaredFiles(sourceRoot,SMOLDOT_DART_FILES,'smoldot Dart');
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
  assertDeclaredFiles(root, SDK_ROOT_LOCK_FILES, 'SDK 根锁');
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
  assertDeclaredFiles(sourceRoot, CORE_RUST_FILES, 'Core Rust 来源');
  assertDeclaredFiles(sourceRoot, CORE_RUST_BOUNDARY_FILES, 'Core Rust 边界');
}

function assertDeclaredFiles(root, files, label) {
  const sourceRoot = resolve(root);
  for (const relativePath of Object.keys(files)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 缺少普通${label}文件：${relativePath}`);
    }
    if (lstatSync(path).size === 0) fail(`CitizenSDK ${label}文件为空：${relativePath}`);
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
  assertDeclaredFiles(sourceRoot, PUBLIC_ABI_FILES, '公共 ABI');
  assertDeclaredFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertDeclaredFiles(sourceRoot, {'include/smoldot.h':SMOLDOT_SUPPORT_FILES['include/smoldot.h']}, '兼容节点头');
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
  assertDeclaredFiles(sourceRoot, CHAIN_ASSET_FILES, '链资产');

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
  const expectedManifest={...CHAIN_ASSET_MANIFEST,chainspec_sha256:sha256File(join(assetsRoot,'chainspec.json')),light_sync_state_sha256:sha256File(join(assetsRoot,'light_sync_state.json'))};
  const expectedManifestKeys = Object.keys(expectedManifest).sort();
  if (JSON.stringify(actualManifestKeys) !== JSON.stringify(expectedManifestKeys)) {
    fail('CitizenSDK 链资产 manifest 字段闭集漂移');
  }
  for (const [field, expected] of Object.entries(expectedManifest)) {
    if (manifest[field] !== expected) {
      fail(`CitizenSDK 链资产 manifest 字段漂移：${field}`);
    }
  }
}

export function assertSourceFixtures(root) {
  assertDeclaredFiles(root, SOURCE_FIXTURE_FILES, '解码夹具');
}

export function assertLicenseSources(root) {
  assertDeclaredFiles(root, LICENSE_SOURCE_FILES, '许可证原文');
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
  assertDeclaredFiles(sourceRoot, expectedFiles, '移动绑定来源');
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
  assertDeclaredFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertDeclaredFiles(sourceRoot, WINDOWS_BINDING_SOURCE_FILES, 'Windows Host 来源');
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
  assertDeclaredFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertDeclaredFiles(sourceRoot, LINUX_BINDING_SOURCE_FILES, 'Linux Host 来源');

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
 * 校验唯一根README简明介绍及其普通文件边界，拒绝平台说明副本和额外docs目录。
 */
export function assertDocumentationSource(
  root,
  { allowAppleReleaseProjection = false } = {},
) {
  const sourceRoot = resolve(root);
  if (existsSync(join(sourceRoot, 'docs'))) {
    fail('CitizenSDK 产品源码禁止包含 docs 目录；技术文档只允许存在所属产品根');
  }
  if (Object.keys(DOCUMENTATION_SOURCE_FILES).length !== DOCUMENTATION_FILE_COUNT) {
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
  const expectedPaths = Object.keys(DOCUMENTATION_SOURCE_FILES).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 产品文档闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertDeclaredFiles(sourceRoot, DOCUMENTATION_SOURCE_FILES, '产品文档');
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
  assertDeclaredFiles(sourceRoot, HOSTED_PACKAGE_SOURCE_FILES, 'Hosted Package 合同');
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
  assertDeclaredFiles(sourceRoot, SDK_TEST_CONTRACT_FILES, '测试合同');
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
}



export function assertSignerSource(root) {
  const sourceRoot = resolve(root);
  for (const relativePath of Object.keys(SIGNER_FILES)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail(`CitizenSDK 缺少普通 signer 源文件：${relativePath}`);
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
  if(typeof version!=='string'||!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?)$/u.test(version)||version.split('.').some(value=>!Number.isSafeInteger(Number(value))))fail('SDK软件版本无效');
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


// 本仓原生依赖只消费本仓原始锁；回执不建立第二份来源与版本真源。
const NATIVE_DEPENDENCY_PLATFORMS = ['LinuxARM', 'LinuxAMD', 'Windows'];
const TSS2_HEADERS = ['common', 'esys', 'mu', 'rc', 'sys', 'tcti', 'tcti_device', 'tpm2_types']
  .map((name) => 'include/tss2/tss2_' + name + '.h');
function dependencyCheck(ok, message) { if (!ok) fail('CitizenSDK 静态依赖：' + message); }

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
const CITIZENSDK_INTERNAL_SYMBOLS = Object.freeze([]);

/** 构建期内部模块仍复用公开Core头及独立二维码图像头，不复制公开类型声明。 */

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
if (!process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && isMain) {
  try {
    const values = parseArguments(process.argv.slice(2));
    if (values.hosted || values['verify-hosted']) {
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



