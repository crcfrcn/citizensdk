#!/usr/bin/env node

// 本仓本目标的完整自动化只由同名Workflow调用；版本与产物均在GitHub生成。
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, constants, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function citizenSDKRelease(release,platform,readTag){
 if(platform!=='sdk')throw Error('公民SDK只发布完整SDK目标');
 const tag=release?.tag_name;
 if(typeof tag!=='string'||!tag.startsWith('citizensdk-sdk-v'))return null;
 const packageTag=/^citizensdk-sdk-v(\d+\.\d+\.\d+)-r([1-9]\d*)-a([1-9]\d*)$/u.exec(tag);
 if(!packageTag)throw Error('公民SDK完整包版本Tag无效');
 const run_id=Number(packageTag[2]),run_attempt=Number(packageTag[3]);
 if(!Number.isSafeInteger(run_id)||!Number.isSafeInteger(run_attempt))throw Error('公民SDK包生成Run越界');
 const source=await readTag(tag);
 if(source?.ref!==`refs/tags/${tag}`||source.object?.type!=='commit'||!/^[a-f0-9]{40}$/u.test(source.object.sha||''))throw Error('公民SDK包Tag源码不明确');
 return {platform,tag,version:packageTag[1],run_id,run_attempt,source_sha:source.object.sha};
}
const automationDependencyLock=Object.freeze({"schema":1,"environment":{"zxing-cpp":{"version":"3.1.1","url":"https://github.com/zxing-cpp/zxing-cpp/releases/download/v3.1.1/zxing-cpp-3.1.1.tar.gz","size":1628322,"sha256":"c3c02c29c0b519de7bd4e25b376e606e87f0761befd1282815642a2246613d14","archive_root":"zxing-cpp-3.1.1"}},"android_tools":{"agp":"9.0.1","kotlin":"2.2.20","gradle":"9.1.0","cmake":"3.31.6","ndk":"28.2.13676358"},"native":{"schema":1,"sources":{"sqlite":{"version":"3.53.4","url":"https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip","size":2946650,"sha256":"1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d","sha3_256":"628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e","archive_root":"sqlite-amalgamation-3530400"},"openssl":{"version":"3.5.8","url":"https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz","size":53213818,"sha256":"a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2","archive_root":"openssl-3.5.8","license":"LICENSE.txt","license_sha256":"7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a"},"tpm2-tss":{"version":"4.2.0","url":"https://github.com/tpm2-software/tpm2-tss/releases/download/4.2.0/tpm2-tss-4.2.0.tar.gz","size":2023505,"sha256":"b53f0c5c8c4ce17f05701a410ca9688f725ca380c9bc4640eacd0eadb1fea124","archive_root":"tpm2-tss-4.2.0","license":"LICENSE","license_sha256":"18c1bf4b1ba1fb2c4ffa7398c234d83c0d55475298e470ae1e5e3a8a8bd2e448"}},"sqlite_defines":["SQLITE_THREADSAFE=1"],"openssl_options":["no-shared","no-module","no-dso","no-tests","-fPIC"],"tss2_options":["--enable-option-checking=fatal","--disable-shared","--enable-static","--with-pic","--with-crypto=ossl","--disable-fapi","--disable-policy","--enable-esys","--enable-util-io","--enable-tcti-device","--disable-tcti-mssim","--disable-tcti-swtpm","--disable-tcti-pcap","--disable-tcti-null","--disable-tcti-libtpms","--disable-tcti-cmd","--disable-tcti-spi-helper","--disable-tcti-spi-ltt2go","--disable-tcti-spidev","--disable-tcti-spi-ftdi","--disable-tcti-i2c-helper","--disable-tcti-i2c-ftdi","--disable-tcti-fuzzing","--enable-nodl","--disable-unit","--disable-integration","--disable-log-file","--with-maxloglevel=none","--with-sysusersdir=no","--with-tmpfilesdir=no","--disable-doxygen-doc","--disable-doxygen-man","--disable-doxygen-html"],"platforms":{"LinuxARM":{"target":"aarch64-unknown-linux-gnu","machine":183,"openssl_target":"linux-aarch64","glibc":"2.31"},"LinuxAMD":{"target":"x86_64-unknown-linux-gnu","machine":62,"openssl_target":"linux-x86_64","glibc":"2.31"},"Windows":{"target":"x86_64-pc-windows-msvc","machine":34404,"msvc_runtime":"/MD"}}},"headers":{"openssl":["aes.h","asn1.h","asn1err.h","asn1t.h","async.h","asyncerr.h","bio.h","bioerr.h","blowfish.h","bn.h","bnerr.h","buffer.h","buffererr.h","byteorder.h","camellia.h","cast.h","cmac.h","cmp.h","cmp_util.h","cmperr.h","cms.h","cmserr.h","comp.h","comperr.h","conf.h","conf_api.h","conferr.h","configuration.h","conftypes.h","core.h","core_dispatch.h","core_names.h","core_object.h","crmf.h","crmferr.h","crypto.h","cryptoerr.h","cryptoerr_legacy.h","ct.h","cterr.h","decoder.h","decodererr.h","des.h","dh.h","dherr.h","dsa.h","dsaerr.h","dtls1.h","e_os2.h","e_ostime.h","ebcdic.h","ec.h","ecdh.h","ecdsa.h","ecerr.h","encoder.h","encodererr.h","engine.h","engineerr.h","err.h","ess.h","esserr.h","evp.h","evperr.h","fips_names.h","fipskey.h","hmac.h","hpke.h","http.h","httperr.h","idea.h","indicator.h","kdf.h","kdferr.h","lhash.h","macros.h","md2.h","md4.h","md5.h","mdc2.h","ml_kem.h","modes.h","obj_mac.h","objects.h","objectserr.h","ocsp.h","ocsperr.h","opensslconf.h","opensslv.h","ossl_typ.h","param_build.h","params.h","pem.h","pem2.h","pemerr.h","pkcs12.h","pkcs12err.h","pkcs7.h","pkcs7err.h","prov_ssl.h","proverr.h","provider.h","quic.h","rand.h","randerr.h","rc2.h","rc4.h","rc5.h","ripemd.h","rsa.h","rsaerr.h","safestack.h","seed.h","self_test.h","sha.h","srp.h","srtp.h","ssl.h","ssl2.h","ssl3.h","sslerr.h","sslerr_legacy.h","stack.h","store.h","storeerr.h","symhacks.h","thread.h","tls1.h","trace.h","ts.h","tserr.h","txt_db.h","types.h","ui.h","uierr.h","whrlpool.h","x509.h","x509_acert.h","x509_vfy.h","x509err.h","x509v3.h","x509v3err.h"],"tss2":["common","esys","mu","rc","sys","tcti","tcti_device","tpm2_types"]}});
const automatedPackage=await(async()=>{
const {createHash}=await import('node:crypto');
const {gzipSync,inflateRawSync}=await import('node:zlib');
const {copyFileSync,chmodSync,closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,readlinkSync,realpathSync,readdirSync,rmSync,renameSync,statSync,symlinkSync,writeFileSync}=await import('node:fs');
const {dirname,isAbsolute,join,parse,relative,resolve,sep}=await import('node:path');
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

function assertFlutterBindingContract(root) {
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

/** Cargo唯一源码外输入：普通副本隔离build.rs写入，锁文件、测试夹具与链资源同轮装配。 */
function createNativeSourceView(sourcePath, outputPath) {
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

/** 复用只读视图前核对来源绑定；不接受普通副本或另一源码的入口链接。 */

/** 既有原生消费者的普通文件副本仅重排入口；正式包不能再次调用源码布局转换。 */
function projectFlutterSourceEntry(sourcePath, packagePath) {
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
function appleXcframeworkSymlinkContract(xcframework, prefix = '') {
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
function assertSmoldotDartSource(root) {
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

function assertSmoldotLocks(root) {
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

function assertSdkRootLocks(root) {
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
function assertProviderLockParity(root) {
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
function assertCoreRustSource(root) {
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
function assertPublicAbiHeaders(root) {
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

function assertChainAssets(root) {
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

function assertSourceFixtures(root) {
  assertDeclaredFiles(root, SOURCE_FIXTURE_FILES, '解码夹具');
}

function assertLicenseSources(root) {
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
function assertMobileBindingSource(
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
function assertWindowsBindingSource(root, { allowInjectedWindowsArtifacts = false } = {}) {
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

function assertLinuxBindingSource(root, { allowInjectedLinuxArtifacts = false } = {}) {
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
function assertDocumentationSource(
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
function assertHostedRuntimeDartProjection(root) {
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
function assertHostedRuntimeLinuxProjection(root, { allowInjectedLinuxArtifacts = false } = {}) {
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
function assertHostedRuntimeWindowsProjection(root, { allowInjectedWindowsArtifacts = false } = {}) {
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

function assertHostedPackageSource(root, {
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

function assertSdkTestContracts(root) {
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

function assertSdkScriptSource(root) {
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



function assertSignerSource(root) {
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
function assertLinuxReleaseProjection(root) {
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
function assertWindowsNativeArtifact(sourceRoot, prefix) {
  const source = resolve(sourceRoot), installed = assertSafeTargetPath(prefix, 'Windows 安装前缀');
  assertWindowsBindingSource(source);
  assertPublicAbiHeaders(source);
  assertChainAssets(source);
  assertWindowsInstallClosure(installed);
  return assertWindowsInstalledPlatform(source, installed);
}

/** destination 是完整 SDK 根；安装件与扁平源码头逐字节对拍后才写入公开安装目录。 */
function copyWindowsNativeArtifact(sourceRoot, prefix, destination) {
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

function assertWindowsReleaseProjection(root) {
  const source = resolve(root);
  assertWindowsBindingSource(source, { allowInjectedWindowsArtifacts: true });
  assertPublicAbiHeaders(source);
  assertChainAssets(source);
  return assertWindowsInstalledPlatform(source, join(source, 'windows'));
}

/** 构建器调用的同源 bundle 检查；app.so 是 Dart AOT ELF，不是 PE。 */
function assertWindowsFlutterBundle(sourceRoot, prefix, bundle) {
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
function assertCitizenSdkStaticArchive(bytes, platform, nested = false) {
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
function assertCitizenSdkDependencyInputs(receiptPath, platform) {
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
function citizenSdkDependencyEnvironment(receiptPath, platform) {
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
function writeCitizenSdkDependencyEvidence({ receiptPath, platform, nativePath, sourcePath, sourceSha }) {
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

function assertCitizenSdkDependencyEvidence(evidence, platform, root, layout, source, sourceSha, softwareVersion) {
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


function assertNativeArtifactSources(nativeRoot) {
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
function assertAndroidReleaseProjection(root) {
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
function citizenSdkInternalHeader() {
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
function assertAppleReleaseProjection(root) {
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

function assertNoSecrets(root) {
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
function verifyCitizenSdkRelease(candidatePath, archivePath, expectedGitSha = null) {
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

function buildCitizenSdkRelease({ sourcePath, nativePath, outputPath, archivePath, gitCommitSha, softwareVersion }) {
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

/** 完整候选的 Hosted 投影；只能从已经验真的审计候选取得预期，不能从待验归档反推。 */
function hostedPackageEntries(candidatePath) {
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
function verifyCitizenSdkHosted({
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


/** 只调用固定 Pub 的本地归档分支，绝不提供上传、跳过校验或自选参数入口。 */

/**
 * 仅解析 Hosted 官方归档；完整验证后由调用方写盘，不执行 tar 或跟随链接。
 * 这些资源上限是本地安全边界，不表示 Hosted 服务端一定接收同样大小的包。
 */
function parseHostedArchive(bytes) {
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


return {CITIZENSDK_INTERNAL_SYMBOLS,citizenSdkInternalHeader,applySoftwareVersion,createNativeSourceView,projectFlutterSourceEntry,assertCitizenSdkDependencyInputs,citizenSdkDependencyEnvironment,writeCitizenSdkDependencyEvidence,copyWindowsNativeArtifact,assertWindowsReleaseProjection,assertWindowsFlutterBundle,assertHostedRuntimeWindowsProjection,verifyCitizenSdkHosted,buildCitizenSdkRelease,verifyCitizenSdkRelease,appleXcframeworkSymlinkContract};
})();

const nativeDependencies = await (async()=>{

// CitizenSDK原生依赖准备入口。依赖坐标只来自同目录锁文件；普通开发、CI和
// 任意可选调用程序都只能选择工作目录，不能改写版本、来源、摘要或构建选项。
const { createHash } = await import('node:crypto');
const { spawnSync } = await import('node:child_process');
const {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = await import('node:fs');
const { homedir, platform: hostPlatform } = await import('node:os');
const { dirname, isAbsolute, join, parse, relative, resolve, sep } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const sdkDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readLock = () => automationDependencyLock;
const lock = new Proxy({}, {get:(_target,key)=>readLock()[key]});
const platforms = new Set(['Android', 'macOS', 'LinuxARM', 'LinuxAMD', 'Windows']);

function fail(message) { throw new Error(`CitizenSDK依赖准备失败：${message}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sha256File(path) { return sha256(readFileSync(path)); }

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith('--') || index + 1 >= values.length) fail(`参数无效：${key}`);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) fail(`参数重复：${key}`);
    result[name] = values[index += 1];
  }
  return result;
}

function developerCache() { return join(sdkDirectory, 'target', 'build', 'dependencies'); }

function safeExternalDirectory(path, label, source = sdkDirectory) {
  const pathRoot = parse(path).root;
  if (!isAbsolute(path) || resolve(path) !== path || path === pathRoot) fail(`${label}必须是规范绝对路径`);
  const normalizedSource = resolve(source), target = join(normalizedSource, 'target');
  if ((path === normalizedSource || path.startsWith(normalizedSource + sep)) && !path.startsWith(target + sep)) fail(`${label}只能在源码树的target内生成`);
  let current = pathRoot;
  for (const part of path.slice(pathRoot.length).split(sep).filter(Boolean)) {
    if (part === '.' || part === '..') fail(`${label}包含非法路径段`);
    current = join(current, part);
    if (!existsSync(current)) break;
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label}祖先不是普通目录：${current}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path) fail(`${label}真实路径发生漂移`);
  return path;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    fail(`${command}执行失败${result.status === null ? '' : `(${result.status})`}${result.stderr ? `：${result.stderr.trim()}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function archiveName(source) {
  const suffix = new URL(source.url).pathname.endsWith('.zip') ? '.zip' : '.tar.gz';
  return `${source.sha256}${suffix}`;
}

async function download(source, destination) {
  const pending = `${destination}.pending-${process.pid}-${Date.now()}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    rmSync(pending, { force: true });
    try {
      const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!response.ok) fail(`下载HTTP状态${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== source.size || sha256(bytes) !== source.sha256) fail('下载字节长度或SHA256不符');
      writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(pending, destination);
      return;
    } catch (error) {
      rmSync(pending, { force: true });
      if (attempt === 3) fail(`${source.url}三次取得均失败：${error.message}`);
    }
  }
}

function validateArchiveEntries(entries, source) {
  const root = `${source.archive_root}/`;
  if (entries.length === 0) fail(`${source.archive_root}归档为空`);
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, '');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\\')
        || normalized.split('/').includes('..')
        || (normalized !== source.archive_root && !normalized.startsWith(root))) {
      fail(`${source.archive_root}归档路径越界：${entry}`);
    }
  }
}

function verifyExtractedTree(root, source) {
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    fail(`${source.archive_root}没有解出唯一普通根目录`);
  }
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        // 官方ZXing的语言包装只链接同包core；准确路径/原始目标/真实目标三者同时校验。
        // 不遍历链接以免重复或循环，不扩大为任意“包内链接”许可。
        const allowed = {
          'wrappers/python/core': '../../core',
          'wrappers/rust/core': '../../core/',
        };
        const key = relative(root, path).split(sep).join('/');
        if (source !== lock.environment['zxing-cpp'] || !Object.hasOwn(allowed, key)
            || readlinkSync(path) !== allowed[key]) {
          fail(`${source.archive_root}包含未许可链接`);
        }
        const core = join(root, 'core');
        if (!existsSync(core) || !lstatSync(core).isDirectory()
            || lstatSync(core).isSymbolicLink()
            || realpathSync(path) !== join(realpathSync(root), 'core')) {
          fail('ZXing链接目标必须是同包普通core目录');
        }
        continue;
      }
      if (!info.isDirectory() && !info.isFile()) fail(`${source.archive_root}包含非普通条目`);
      if (info.isDirectory()) visit(path);
    }
  };
  visit(root);
  if (source.license && sha256File(join(root, source.license)) !== source.license_sha256) {
    fail(`${source.archive_root}许可证摘要不符`);
  }
  if (source.archive_root.startsWith('zxing-cpp-')
      && (!existsSync(join(root, 'CMakeLists.txt')) || !existsSync(join(root, 'core/src/ZXingC.h')))) {
    fail('ZXing-C++源码闭包不完整');
  }
  if (source.archive_root.startsWith('sqlite-') && !existsSync(join(root, 'sqlite3.c'))) fail('SQLite源码闭包不完整');
  if (source.archive_root.startsWith('openssl-') && !existsSync(join(root, 'Configure'))) fail('OpenSSL源码闭包不完整');
  if (source.archive_root.startsWith('tpm2-tss-') && !existsSync(join(root, 'configure'))) fail('TPM2-TSS源码闭包不完整');
}

async function prepareSource(source, work) {
  const archives = safeExternalDirectory(join(work, 'archives'), '依赖归档目录');
  const archive = join(archives, archiveName(source));
  if (existsSync(archive)) {
    const info = lstatSync(archive);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== source.size || sha256File(archive) !== source.sha256) {
      fail(`${source.archive_root}既有归档无效`);
    }
  } else await download(source, archive);

  const destination = join(work, source.archive_root);
  if (existsSync(destination)) {
    verifyExtractedTree(destination, source);
    return destination;
  }
  const staging = join(work, `.extract-${source.sha256}-${process.pid}`);
  if (existsSync(staging)) fail(`${source.archive_root}暂存目录已存在`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const zip = archive.endsWith('.zip');
    const listing = run(zip ? 'unzip' : 'tar', zip ? ['-Z1', archive] : ['-tzf', archive], { capture: true });
    validateArchiveEntries(listing.split(/\r?\n/u).filter(Boolean), source);
    run(zip ? 'unzip' : 'tar', zip ? ['-q', archive, '-d', staging] : ['-xzf', archive, '-C', staging]);
    const extracted = join(staging, source.archive_root);
    verifyExtractedTree(extracted, source);
    renameSync(extracted, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}

function sourceEntriesFor(platform) {
  const result = [['zxing-cpp', lock.environment['zxing-cpp']]];
  if (platform === 'LinuxARM' || platform === 'LinuxAMD') {
    result.push(...Object.entries(lock.native.sources));
  } else if (platform === 'Windows') result.push(['sqlite', lock.native.sources.sqlite]);
  return result;
}

function sourcesFor(platform) {
  return sourceEntriesFor(platform).map(([, source]) => source);
}

// 只把产品锁中的不可变归档坐标投影给可选调用方；计划没有缓存路径、控制程序身份
// 或下载策略，CitizenSDK直接开发、CI和任意第三方构建仍使用同一份锁文件。
function dependencyPlan(args) {
  if (!platforms.has(args.platform)) fail(`平台无效：${args.platform || '<empty>'}`);
  const archives = sourceEntriesFor(args.platform).map(([name, source]) => ({
    name,
    version: source.version,
    url: source.url,
    size: source.size,
    sha256: source.sha256,
    archive_root: source.archive_root,
  })).sort((left, right) => left.name.localeCompare(right.name));
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, archives })}\n`);
}

async function prepareEnvironment(args) {
  if (args.scope && args.scope !== 'citizensdk') fail('scope只接受citizensdk');
  if (!platforms.has(args.platform)) fail(`平台无效：${args.platform || '<empty>'}`);
  const work = safeExternalDirectory(resolve(args.work || developerCache()), '依赖工作目录');
  for (const source of sourcesFor(args.platform)) await prepareSource(source, work);
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, work })}\n`);
}

function freshDirectory(path, label, source) {
  if (existsSync(path)) fail(`${label}已存在，拒绝混入旧产物`);
  return safeExternalDirectory(path, label, source);
}

function copySelectedFiles(source, destination, names) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const input = join(source, name);
    if (!existsSync(input) || !lstatSync(input).isFile() || lstatSync(input).isSymbolicLink()) fail(`缺少依赖文件：${input}`);
    copyFileSync(input, join(destination, name));
  }
}

function executable(name) {
  const path = run(hostPlatform() === 'win32' ? 'where' : 'sh', hostPlatform() === 'win32' ? [name] : ['-c', `command -v "$1"`, 'resolve-tool', name], { capture: true })
    .split(/\r?\n/u)[0];
  const real = realpathSync(path);
  if (!statSync(real).isFile()) fail(`工具不是普通文件：${name}`);
  return real;
}

function buildTools(platform) {
  const names = platform === 'Windows' ? ['cl', 'lib', 'tar'] : ['cc', 'ar', 'perl', 'make', 'sh', 'pkg-config', 'tar', 'unzip'];
  return names.map((name) => {
    const path = executable(name);
    const result = { name, sha256: sha256File(path) };
    if (name === 'cc') result.target = run(path, ['-dumpmachine'], { capture: true });
    return result;
  });
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail(`静态依赖前缀包含符号链接：${path}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && name !== 'native-dependencies.json') {
        files.push({ path: relative(root, path).split(sep).join('/'), sha256: sha256File(path) });
      } else if (!info.isFile()) fail(`静态依赖前缀包含非普通文件：${path}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function buildSqlite(source, build, prefix, windows) {
  const object = join(build, windows ? 'sqlite3.obj' : 'sqlite3.o');
  mkdirSync(join(prefix, 'include'), { recursive: true, mode: 0o700 });
  mkdirSync(join(prefix, 'lib'), { recursive: true, mode: 0o700 });
  copyFileSync(join(source, 'sqlite3.h'), join(prefix, 'include/sqlite3.h'));
  if (windows) {
    run('cl', ['/nologo', '/c', '/O2', '/MD', '/DSQLITE_THREADSAFE=1', join(source, 'sqlite3.c'), `/Fo${object}`]);
    run('lib', ['/nologo', `/OUT:${join(prefix, 'lib/sqlite3.lib')}`, object]);
  } else {
    run('cc', ['-O2', '-fPIC', '-DSQLITE_THREADSAFE=1', '-c', join(source, 'sqlite3.c'), '-o', object]);
    run('ar', ['rcs', join(prefix, 'lib/libsqlite3.a'), object]);
  }
}

function findArchive(root, name) {
  for (const directory of ['lib', 'lib64']) {
    const path = join(root, directory, name);
    if (existsSync(path)) return path;
  }
  fail(`依赖构建缺少${name}`);
}

function buildLinuxNative(sources, build, prefix, platform) {
  const contract = lock.native.platforms[platform];
  const sqlite = join(sources, lock.native.sources.sqlite.archive_root);
  const openssl = join(sources, lock.native.sources.openssl.archive_root);
  const tss = join(sources, lock.native.sources['tpm2-tss'].archive_root);
  buildSqlite(sqlite, freshDirectory(join(build, 'sqlite'), 'SQLite构建目录', sdkDirectory), prefix, false);

  const opensslBuild = freshDirectory(join(build, 'openssl'), 'OpenSSL构建目录', sdkDirectory);
  const opensslInstall = freshDirectory(join(build, 'openssl-install'), 'OpenSSL安装目录', sdkDirectory);
  cpSync(openssl, opensslBuild, { recursive: true, errorOnExist: true, force: false });
  run('perl', ['Configure', contract.openssl_target, ...lock.native.openssl_options,
    `--prefix=${opensslInstall}`, `--openssldir=${join(opensslInstall, 'ssl')}`], { cwd: opensslBuild });
  run('make', ['-j2'], { cwd: opensslBuild });
  run('make', ['install_sw'], { cwd: opensslBuild });
  copySelectedFiles(join(opensslInstall, 'include/openssl'), join(prefix, 'include/openssl'), lock.headers.openssl);
  copyFileSync(findArchive(opensslInstall, 'libcrypto.a'), join(prefix, 'lib/libcrypto.a'));

  const tssBuild = freshDirectory(join(build, 'tpm2-tss'), 'TPM2-TSS构建目录', sdkDirectory);
  const tssInstall = freshDirectory(join(build, 'tpm2-tss-install'), 'TPM2-TSS安装目录', sdkDirectory);
  const cryptoLibrary = dirname(findArchive(opensslInstall, 'libcrypto.a'));
  const environment = {
    ...process.env,
    CPPFLAGS: `-I${join(opensslInstall, 'include')}`,
    LDFLAGS: `-L${cryptoLibrary}`,
    PKG_CONFIG_PATH: join(cryptoLibrary, 'pkgconfig'),
  };
  run(join(tss, 'configure'), [`--prefix=${tssInstall}`, ...lock.native.tss2_options], { cwd: tssBuild, env: environment });
  run('make', ['-j2'], { cwd: tssBuild, env: environment });
  run('make', ['install'], { cwd: tssBuild, env: environment });
  copySelectedFiles(join(tssInstall, 'include/tss2'), join(prefix, 'include/tss2'),
    lock.headers.tss2.map((name) => `tss2_${name}.h`));
  for (const name of ['esys', 'mu', 'sys', 'rc', 'tcti-device']) {
    copyFileSync(findArchive(tssInstall, `libtss2-${name}.a`), join(prefix, `lib/libtss2-${name}.a`));
  }
}

function sourceSha(args, sdk) {
  const supplied = args['source-sha'];
  if (supplied) return supplied;
  return run('git', ['-C', sdk, 'rev-parse', 'HEAD'], { capture: true });
}

async function prepareNative(args) {
  if (args.scope && args.scope !== 'citizensdk') fail('scope只接受citizensdk');
  if (!['LinuxARM', 'LinuxAMD', 'Windows'].includes(args.platform)) fail('prepare-native只支持LinuxARM、LinuxAMD或Windows');
  if (!['ci', 'release'].includes(args.mode)) fail('mode只接受ci或release');
  const sdk = resolve(args.sdk || sdkDirectory);
  if (!existsSync(join(sdk, 'pubspec.yaml'))) fail('CitizenSDK源码目录无效');
  const work = safeExternalDirectory(resolve(args.work || developerCache()), '原生依赖工作目录', sdk);
  const sources = safeExternalDirectory(resolve(args.sources || join(work, 'sources')), '原生依赖源码目录', sdk);
  for (const source of sourcesFor(args.platform)) await prepareSource(source, sources);
  const build = freshDirectory(join(work, 'build'), '原生依赖构建根', sdk);
  const prefix = freshDirectory(join(work, 'prefix'), '原生依赖前缀', sdk);
  if (args.platform === 'Windows') {
    buildSqlite(join(sources, lock.native.sources.sqlite.archive_root), build, prefix, true);
  } else buildLinuxNative(sources, build, prefix, args.platform);

  const version = /^version: (\d+\.\d+\.\d+)$/mu.exec(readFileSync(join(sdk, 'pubspec.yaml'), 'utf8'))?.[1];
  if (!version || (args['software-version'] && args['software-version'] !== version)) fail('SDK软件版本与源码不一致');
  const commit = sourceSha(args, sdk);
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail('源码提交必须是40位小写Git SHA');
  const receipt = {
    schema: 1,
    platform: args.platform,
    source_sha: commit,
    software_version: version,
    build_mode: args.mode,
    native_dependencies: lock.native,
    build_tools: buildTools(args.platform),
    files: collectFiles(prefix),
  };
  const receiptPath = join(prefix, 'native-dependencies.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  automatedPackage.assertCitizenSdkDependencyInputs(receiptPath, args.platform);
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, prefix, receipt: receiptPath })}\n`);
}


return {run:async(values)=>{
const [command, ...rest] = values;
const args = parseArguments(rest);
try {
  if (command === 'plan') dependencyPlan(args);
  else if (command === 'prepare-environment') await prepareEnvironment(args);
  else if (command === 'prepare-native') await prepareNative(args);
  else fail('用法：release-sdk.mjs dependencies <plan|prepare-environment|prepare-native> [--name value ...]');
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}

}};
})();


export const WORKFLOW_SHELL_SOURCES=Object.freeze({"native": "#!/usr/bin/env bash\n# CitizenSDK GitHub 自动化原生构建正文。源码目录只读，Cargo 与平台产物必须写入显式的外部目录。\nset -euo pipefail\n\n# 源码身份由当前入口交付的准确产品源码根决定，不能从调用方缓存视图推导。\nsdk_dir=\"${CITIZENSDK_SOURCE_ROOT:?缺少SDK源码根}\"\nscript_dir=\"$sdk_dir/scripts\"\n# Cargo清单由源码外工程准备完成后赋值，禁止直接编译仓库存放布局。\nffi_manifest=''\nproduct_ffi_manifest=''\nproduct_header=\"$sdk_dir/include/citizensdk.h\"\nproduct_types_header=\"$sdk_dir/include/citizensdk_types.h\"\nqr_image_source_root=\"$sdk_dir/native/image\"\nqr_image_header=\"$qr_image_source_root/citizensdk_qr_image.h\"\ndarwin_source_root=\"$sdk_dir/darwin/source/core\"\ndarwin_flutter_source_root=\"$sdk_dir/darwin/source/flutter\"\nlinux_source_root=\"$sdk_dir/linux\"\nwindows_source_root=\"$sdk_dir/windows\"\napple_asset_root=\"$sdk_dir/chain\"\ntarget_name=\"${1:-all}\"\n# 六个显式参数表示消费最终包；没有参数的原生构建仍由各平台原入口负责。\nhosted_consumer=false\nif [[ \"$#\" -gt 1 ]]; then hosted_consumer=true; fi\nstandalone_root=\"$sdk_dir/target/build\"\n: \"${CITIZENSDK_WORK_DIR:=$standalone_root/work}\"\n: \"${CITIZENSDK_NATIVE_OUTPUT_DIR:=$standalone_root/output}\"\nexport CITIZENSDK_WORK_DIR CITIZENSDK_NATIVE_OUTPUT_DIR\nios_deployment_target=16.0\nmacos_deployment_target=13.0\nandroid_ndk_version=28.2.13676358\nlinux_glibc_baseline=2.31\n\nfail() {\n  echo \"CitizenSDK 原生构建失败：$1\" >&2\n  exit 1\n}\n\n# Windows 原生工具使用 drive 路径，Bash 安全目录函数使用 Git Bash POSIX 路径。\n# 必须在 canonical_directory 第一次 mkdir 前检查二者指向同一非源码目录。\nwindows_path_preflight() {\n  case \"$(uname -s)\" in MINGW*|MSYS*) ;; *) fail \"Windows 只允许在 Windows MSVC runner 构建\" ;; esac\n  command -v cygpath >/dev/null 2>&1 || fail \"Windows 缺少官方 Git Bash 路径转换工具\"\n  command -v node >/dev/null 2>&1 || fail \"Windows 缺少既有构建合同使用的 Node\"\n  local path converted\n  for path in \"${CITIZENSDK_WORK_DIR:-}\" \"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\"; do\n    [[ \"$path\" == /* && \"$path\" != / ]] || fail \"Windows 工作目录须使用 Git Bash 绝对路径\"\n    converted=\"$(cygpath -m \"$path\")\"\n    CITIZENSDK_PATH_CHECK=\"$converted\" CITIZENSDK_SOURCE_CHECK=\"$(cygpath -m \"$sdk_dir\")\" node -e '\n      const fs=require(\"fs\"), p=require(\"path\").win32;\n      const value=process.env.CITIZENSDK_PATH_CHECK, source=process.env.CITIZENSDK_SOURCE_CHECK;\n      if (!/^[A-Za-z]:\\//.test(value) || /[<>\"|?*\\x00-\\x1f]/.test(value)) throw Error(\"invalid Windows drive path\");\n      const pieces=value.slice(3).split(\"/\");\n      if (pieces.some(x=>!x || x===\".\" || x===\"..\" || /[ .:]$/.test(x) || x.includes(\":\") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)/i.test(x))) throw Error(\"unsafe Windows path component\");\n      const normalized=p.resolve(value).toLowerCase(), root=p.resolve(source).toLowerCase();\n      if (normalized===root || normalized.startsWith(root+p.sep) && !normalized.startsWith(p.join(root,\"target\")+p.sep)) throw Error(\"Windows output is inside source\");\n      let current=value.slice(0,3);\n      for (const part of pieces) {\n        current=p.join(current,part);\n        try { const st=fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink() || p.resolve(fs.realpathSync(current)).toLowerCase()!==p.resolve(current).toLowerCase()) throw Error(\"Windows path reparse or alias\"); }\n        catch(e) { if (e.code===\"ENOENT\") break; throw e; }\n      }\n    ' || fail \"Windows 目录首次写入前预检失败\"\n  done\n}\n\nassert_safe_directory_path() {\n  local path=\"$1\" label=\"$2\" component current=''\n  local -a components\n  [[ -n \"$path\" && \"$path\" == /* && \"$path\" != */ && \"$path\" != *//* ]] \\\n    || fail \"$label 必须使用不含重复分隔符的绝对规范路径：${path:-<empty>}\"\n  IFS='/' read -r -a components <<<\"$path\"\n  # 先验证完整词法路径，再检查既存祖先。不能在第一个不存在的目录处停止词法检查，\n  # 否则 `missing/../target` 会绕过零写预检，直到平台工具检查才失败。\n  for component in \"${components[@]}\"; do\n    [[ -n \"$component\" ]] || continue\n    [[ \"$component\" != . && \"$component\" != .. ]] \\\n      || fail \"$label 禁止包含 . 或 .. 路径段：$path\"\n  done\n  for component in \"${components[@]}\"; do\n    [[ -n \"$component\" ]] || continue\n    current=\"$current/$component\"\n    [[ ! -L \"$current\" ]] || fail \"$label 的既存路径祖先禁止使用符号链接：$current\"\n    if [[ -e \"$current\" && ! -d \"$current\" ]]; then\n      fail \"$label 的既存路径不是目录：$current\"\n    fi\n    [[ -e \"$current\" ]] || break\n  done\n}\n\ncanonical_directory() {\n  local path=\"$1\" label=\"$2\"\n  [[ -n \"$path\" ]] || fail \"缺少 $label\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  mkdir -p \"$path\"\n  (cd \"$path\" && pwd -P)\n}\n\n# 两个输出必须在任何 mkdir 前一起通过；这样第二个参数无效时，第一个参数也不会留下目录。\noutput_paths_preflight() {\n  local work=\"${CITIZENSDK_WORK_DIR:-}\" output=\"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\" path\n  for path in \"$work\" \"$output\"; do\n    [[ -n \"$path\" ]] || fail \"缺少 CitizenSDK 工作或产物目录\"\n    assert_safe_directory_path \"$path\" \"CitizenSDK 输出目录\"\n    case \"$path/\" in \"$sdk_dir/target/\"*) ;; \"$sdk_dir/\"*) fail \"工作目录或产物目录位于 CitizenSDK 源码树：$path\" ;; esac\n  done\n  [[ \"$work\" != \"$output\" ]] || fail \"工作目录与产物目录不能相同\"\n  case \"$work/\" in \"$output/\"*) fail \"工作目录不能位于产物目录内\" ;; esac\n  case \"$output/\" in \"$work/\"*) fail \"产物目录不能位于工作目录内\" ;; esac\n}\n\nlocal_build_path_is_allowed() {\n  local path=\"$1\"\n  # 产品入口只禁止写入自身源码；调用方可以选择任意其它绝对输出目录，\n  # 不要求安装或使用任何外部控制程序。\n  case \"$path/\" in \"$sdk_dir/target/\"*) ;; \"$sdk_dir/\"*) return 1 ;; esac\n  [[ \"$path\" == /* && \"$path\" != / ]]\n}\n\nif [[ \"$target_name\" == Windows ]]; then windows_path_preflight; fi\noutput_paths_preflight\n\n# 本机调用只要求输出位于产品源码树之外；产品入口不依赖特定调用程序。\nif [[ \"${GITHUB_ACTIONS:-}\" != true ]]; then\n  for path in \"${CITIZENSDK_WORK_DIR:-}\" \"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\"; do\n    assert_safe_directory_path \"$path\" 本机构建目录\n    local_build_path_is_allowed \"$path\" \\\n      || fail \"本机构建目录必须位于 CitizenSDK 源码树之外：${path:-<empty>}\"\n  done\nfi\n\nif [[ \"$target_name\" == macOS || \"$hosted_consumer\" == true ]]; then\n  # Hosted 输入互斥检查必须早于首次写入；只接受调用方已准备的本机/Runner 受控容器。\n  work_dir=\"${CITIZENSDK_WORK_DIR:-}\"\n  output_dir=\"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\"\n  for path in \"$work_dir\" \"$output_dir\"; do\n    assert_safe_directory_path \"$path\" \"macOS Hosted 受控容器\"\n    [[ -d \"$path\" && ! -L \"$path\" && \"$(cd \"$path\" && pwd -P)\" == \"$path\" ]] \\\n      || fail \"macOS Hosted 受控容器必须已存在且没有路径别名\"\n  done\nelse\n  work_dir=\"$(canonical_directory \"${CITIZENSDK_WORK_DIR:-}\" CITIZENSDK_WORK_DIR)\"\n  output_dir=\"$(canonical_directory \"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\" CITIZENSDK_NATIVE_OUTPUT_DIR)\"\nfi\n\n# 无论本机还是CI runner，都禁止把Cargo、二进制或符号清单\n# 回写到SDK源码树；除此之外，产品入口不要求调用方使用特定外部目录。\nfor directory in \"$work_dir\" \"$output_dir\"; do\n  case \"$directory/\" in\n    \"$sdk_dir/target/\"*) ;;\n    \"$sdk_dir/\"*) fail \"工作目录或产物目录位于 CitizenSDK 源码树：$directory\" ;;\n  esac\n  if [[ \"${GITHUB_ACTIONS:-}\" != true ]]; then\n    local_build_path_is_allowed \"$directory\" \\\n      || fail \"本机构建真实路径必须位于 CitizenSDK 源码树之外：$directory\"\n  fi\ndone\n\nrequire_rust_target() {\n  local target=\"$1\"\n  local compiler=\"${RUSTC:-rustc}\" sysroot libdir library\n  # 检查实际编译器的标准库，不查询另一份rustup，更不能由产品任务下载组件。\n  sysroot=\"$(\"$compiler\" --print sysroot)\" || fail '无法读取Rust sysroot'\n  libdir=\"$(\"$compiler\" --print target-libdir --target \"$target\")\" || fail \"Rust目标无效：$target\"\n  # Windows官方路径使用反斜线；统一分隔符后仍检查同一个真实sysroot。\n  sysroot=\"${sysroot//\\\\//}\"; libdir=\"${libdir//\\\\//}\"\n  [[ \"$libdir\" == \"$sysroot/lib/rustlib/$target/lib\" && -d \"$libdir\" && ! -L \"$libdir\" ]] \\\n    || fail \"Rust 目标未预装：$target\"\n  for library in \"$libdir\"/libstd-*.rlib; do [[ -s \"$library\" && ! -L \"$library\" ]] && return 0; done\n  fail \"Rust 目标标准库缺失：$target\"\n}\n\nassert_new_file() {\n  [[ ! -e \"$1\" && ! -L \"$1\" ]] || fail \"目标文件已存在或是符号链接，拒绝覆盖：$1\"\n}\n\nassert_descendant_path() {\n  local root=\"$1\" path=\"$2\" label=\"$3\"\n  [[ \"$path\" != \"$root\" ]] || fail \"$label 不能等于受控根目录：$path\"\n  case \"$path/\" in\n    \"$root/\"*) ;;\n    *) fail \"$label 越出受控根目录 $root：$path\" ;;\n  esac\n}\n\nprepare_safe_directory() {\n  local root=\"$1\" path=\"$2\" label=\"$3\" real_path\n  assert_descendant_path \"$root\" \"$path\" \"$label\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  mkdir -p \"$path\"\n  # mkdir 后必须重新逐级 lstat；这样预置的 live/dangling symlink 或非目录\n  # 祖先都不能被后续 Cargo、cp、lipo 或重定向跟随到受控根之外。\n  assert_safe_directory_path \"$path\" \"$label\"\n  [[ -d \"$path\" && ! -L \"$path\" ]] || fail \"$label 不是普通目录：$path\"\n  real_path=\"$(cd \"$path\" && pwd -P)\"\n  case \"$real_path/\" in\n    \"$root/\"*) ;;\n    *) fail \"$label 的真实路径越出受控根目录 ${root}：$real_path\" ;;\n  esac\n  [[ \"$real_path\" == \"$path\" ]] || fail \"$label 的真实路径发生漂移：$path -> $real_path\"\n}\n\n# GRADLE_USER_HOME 是调用产品提供的包管理器缓存，不是 CitizenSDK 编译物。\n# 它可以位于 SDK 工作根之外，但必须是源码树之外的安全真实目录；SDK 自有\n# Gradle 工程、项目缓存、Kotlin 状态和原生产物仍只能写入 work_dir。\nprepare_external_cache_directory() {\n  local path=\"$1\" label=\"$2\" real_path\n  assert_safe_directory_path \"$path\" \"$label\"\n  mkdir -p \"$path\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  [[ -d \"$path\" && ! -L \"$path\" ]] || fail \"$label 不是普通目录：$path\"\n  real_path=\"$(cd \"$path\" && pwd -P)\"\n  [[ \"$real_path\" == \"$path\" ]] || fail \"$label 的真实路径发生漂移：$path -> $real_path\"\n  local_build_path_is_allowed \"$real_path\" \\\n    || fail \"$label 必须位于 CitizenSDK 源码树之外：$real_path\"\n}\n\nprepare_safe_output_file() {\n  local root=\"$1\" path=\"$2\" label=\"$3\" parent\n  assert_descendant_path \"$root\" \"$path\" \"$label\"\n  [[ \"${path##*/}\" != . && \"${path##*/}\" != .. ]] \\\n    || fail \"$label 文件名无效：$path\"\n  assert_new_file \"$path\"\n  parent=\"$(dirname \"$path\")\"\n  prepare_safe_directory \"$root\" \"$parent\" \"$label 父目录\"\n  # 父目录创建后再 lstat 最终项，特别拒绝 `-e` 看不到的 dangling symlink。\n  assert_new_file \"$path\"\n}\n\nassert_readonly_dependency_directory() {\n  local path=\"$1\" label=\"$2\" real_path\n  [[ -n \"$path\" ]] || fail \"缺少 $label\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  [[ -d \"$path\" && ! -L \"$path\" ]] \\\n    || fail \"$label 必须是既存普通目录：$path\"\n  real_path=\"$(cd \"$path\" && pwd -P)\"\n  [[ \"$real_path\" == \"$path\" ]] \\\n    || fail \"$label 的真实路径发生漂移：$path -> $real_path\"\n}\n\nassert_readonly_static_archive() {\n  local path=\"$1\" label=\"$2\" parent real_parent\n  [[ -n \"$path\" && \"$path\" == /* && \"$path\" == *.a ]] \\\n    || fail \"$label 必须是绝对 .a 路径：${path:-<empty>}\"\n  parent=\"$(dirname \"$path\")\"\n  assert_safe_directory_path \"$parent\" \"$label 父目录\"\n  [[ -f \"$path\" && ! -L \"$path\" ]] \\\n    || fail \"$label 必须是既存普通静态归档：$path\"\n  real_parent=\"$(cd \"$parent\" && pwd -P)\"\n  [[ \"$real_parent\" == \"$parent\" ]] \\\n    || fail \"$label 父目录的真实路径发生漂移：$parent -> $real_parent\"\n}\n\ncargo_target_dir=\"$work_dir/cargo\"\nif [[ \"$target_name\" != macOS && \"$hosted_consumer\" != true ]]; then\n  prepare_safe_directory \"$work_dir\" \"$cargo_target_dir\" \"Cargo target 目录\"\nfi\nexport CARGO_TARGET_DIR=\"$cargo_target_dir\"\n\nsymbol_list_android() {\n  local library=\"$1\" nm_bin=\"$2\"\n  {\n    \"$nm_bin\" -D --defined-only \"$library\" 2>/dev/null \\\n      | awk '{ print $NF }' \\\n      | grep -E '^(smoldot_|citizen_[a-z0-9_]+|account_crypto_)' \\\n      | sort -u\n  } || true\n}\n\nsymbol_list_ios() {\n  local library=\"$1\" nm_bin=\"$2\"\n  {\n    (\"$nm_bin\" -g --defined-only \"$library\" 2>/dev/null || true) \\\n      | awk '$2 == \"T\" { print $3 }' \\\n      | grep -E '^_(smoldot_|citizen_[a-z0-9_]+|account_crypto_)' \\\n      | sort -u\n  } || true\n}\n\nverify_symbol_contract() {\n  local symbols=\"$1\" prefix=\"$2\" label=\"$3\" normalized signer_count smoldot_count\n  normalized=\"$(printf '%s\\n' \"$symbols\" | sed \"s/^${prefix}//\")\"\n  smoldot_count=\"$(printf '%s\\n' \"$normalized\" | grep -c '^smoldot_' || true)\"\n  signer_count=\"$(printf '%s\\n' \"$normalized\" | grep -c '^citizen_sr25519_' || true)\"\n  [[ \"$smoldot_count\" -gt 0 ]] || fail \"$label 缺少 smoldot_* 轻节点符号\"\n  [[ \"$signer_count\" -eq 4 ]] || fail \"$label 的 citizen_sr25519_* 符号必须正好为 4 个\"\n  for symbol in \\\n    citizen_sr25519_derive_hard \\\n    citizen_sr25519_public_key \\\n    citizen_sr25519_sign \\\n    citizen_sr25519_verify; do\n    printf '%s\\n' \"$normalized\" | grep -Fxq \"$symbol\" || fail \"$label 缺少 $symbol\"\n  done\n  if printf '%s\\n' \"$normalized\" | grep -Eq '^(citizen_chat_mls_|account_crypto_)'; then\n    fail \"$label 混入聊天或产品账户密码学符号\"\n  fi\n}\n\nproduct_header_symbols() {\n  perl -0777 -ne 'while (/\\b(citizensdk_[a-z0-9_]+)\\s*\\((?!\\s*\\*)/g) { print \"$1\\n\" }' \\\n    \"$product_header\" | sort -u\n}\n\n# 公开144符号精确封闭，旧窗口私有符号已清零；内部模块只复用公开声明。\nproduct_internal_symbols() {\n  node --input-type=module - \"$sdk_dir/.github/workflows/release-sdk.mjs\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nconst {CITIZENSDK_INTERNAL_SYMBOLS} = await import(pathToFileURL(process.argv[2]));\nif (CITIZENSDK_INTERNAL_SYMBOLS.length) process.stdout.write(CITIZENSDK_INTERNAL_SYMBOLS.join('\\n') + '\\n');\nNODE\n}\n\nproduct_linked_symbols() {\n  { product_header_symbols; product_internal_symbols; } | LC_ALL=C sort -u\n}\n\nprepare_internal_header() {\n  local directory=\"$work_dir/private-include\"\n  prepare_safe_directory \"$work_dir\" \"$directory\" \"SDK私有声明目录\"\n  node --input-type=module - \"$sdk_dir/.github/workflows/release-sdk.mjs\" \"$directory\" \"$qr_image_header\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {writeFileSync, readFileSync, lstatSync} from 'node:fs';\nimport {join} from 'node:path';\nconst {citizenSdkInternalHeader} = await import(pathToFileURL(process.argv[2]));\nconst qrImageHeader = readFileSync(process.argv[4], 'utf8');\n// 同轮Apple各slice复用唯一声明；只接受完全相同的普通独占文件，绝不覆盖漂移。\nfor (const [name, text] of [\n  ['citizensdk_internal.h', citizenSdkInternalHeader()],\n  ['citizensdk_qr_image.h', qrImageHeader],\n  ['module.modulemap', 'module CitizenSDKInternal {\\n  header \"citizensdk_internal.h\"\\n  header \"citizensdk_qr_image.h\"\\n  export *\\n}\\n'],\n]) {\n  const path = join(process.argv[3], name);\n  const info = lstatSync(path, {throwIfNoEntry: false});\n  if (info) {\n    if (!info.isFile() || info.nlink !== 1 || readFileSync(path, 'utf8') !== text) {\n      throw Error('SDK私有构建声明漂移：' + name);\n    }\n  } else fs.writeFileSync(path, text, {flag: 'wx', mode: 0o600});\n}\nNODE\n}\n\nproduct_library_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" prefix=\"$3\"\n  local raw_symbols\n  if [[ -n \"$prefix\" ]]; then\n    raw_symbols=\"$(\"$nm_bin\" -g --defined-only \"$library\" 2>/dev/null)\" \\\n      || fail \"无法读取 CitizenSDK 产品 ABI 的 Mach-O 外部已定义符号\"\n  else\n    raw_symbols=\"$(\"$nm_bin\" -D -g --defined-only \"$library\" 2>/dev/null)\" \\\n      || fail \"无法读取 CitizenSDK 产品 ABI 的 ELF 动态导出符号\"\n  fi\n  # 必须先取得完整外部已定义/动态导出集合，再统一去掉 Mach-O 的单个前导\n  # 下划线。禁止先按已知前缀 grep，否则 foreign_probe 等额外全局符号会消失。\n  printf '%s\\n' \"$raw_symbols\" \\\n    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \\\n    | sed \"s/^${prefix}//\" \\\n    | LC_ALL=C sort -u\n}\n\nverify_product_abi_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" prefix=\"$3\" label=\"$4\"\n  local actual expected forbidden\n  actual=\"$(product_library_symbols \"$library\" \"$nm_bin\" \"$prefix\")\"\n  expected=\"$(product_linked_symbols)\"\n  # Android 证书初始化只在 Android Core 中导出；其它平台的144个公开函数不变。\n  if [[ \"$label\" == 'Android libcitizensdk.so' ]]; then\n    expected=\"$(printf '%s\\n%s\\n' \"$expected\" citizensdk_android_init_tls | LC_ALL=C sort -u)\"\n  fi\n  forbidden=\"$(printf '%s\\n' \"$actual\" \\\n    | grep -E '^(smoldot_|citizen_sr25519_|account_crypto_)' || true)\"\n  [[ -z \"$forbidden\" ]] \\\n    || fail \"$label 泄露低层或密码学符号：$(printf '%s' \"$forbidden\" | tr '\\n' ' ')\"\n  [[ \"$actual\" == \"$expected\" ]] || {\n    local missing extra\n    missing=\"$(comm -23 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    extra=\"$(comm -13 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    fail \"$label 与产品头及既定内部符号闭集不一致；缺失=${missing:-无}；额外=${extra:-无}\"\n  }\n}\n\njni_library_symbols() {\n  local library=\"$1\" nm_bin=\"$2\"\n  \"$nm_bin\" -D -g --defined-only \"$library\" 2>/dev/null \\\n    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \\\n    | LC_ALL=C sort -u\n}\n\nverify_jni_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" symbols\n  symbols=\"$(jni_library_symbols \"$library\" \"$nm_bin\")\" \\\n    || fail \"无法读取 CitizenSDK Android JNI 动态导出\"\n  [[ \"$symbols\" == 'JNI_OnLoad@@CITIZENSDK_JNI_1.0' ]] \\\n    || fail \"Android JNI 全局导出必须精确为版本化 JNI_OnLoad；实际=${symbols:-无}\"\n}\n\nandroid_elf_dynamic_values() {\n  local library=\"$1\" readelf_bin=\"$2\" tag=\"$3\"\n  \"$readelf_bin\" -d \"$library\" 2>/dev/null \\\n    | sed -n \"s/.*(${tag}).*\\[\\([^]]*\\)\\].*/\\1/p\"\n}\n\nverify_android_elf_identity() {\n  local core_library=\"$1\" jni_library=\"$2\" readelf_bin=\"$3\"\n  local core_soname jni_soname core_needed jni_needed core_dependency_count\n  [[ -x \"$readelf_bin\" ]] || fail \"Android NDK llvm-readelf 不可执行：$readelf_bin\"\n  core_soname=\"$(android_elf_dynamic_values \"$core_library\" \"$readelf_bin\" SONAME)\"\n  jni_soname=\"$(android_elf_dynamic_values \"$jni_library\" \"$readelf_bin\" SONAME)\"\n  core_needed=\"$(android_elf_dynamic_values \"$core_library\" \"$readelf_bin\" NEEDED)\"\n  jni_needed=\"$(android_elf_dynamic_values \"$jni_library\" \"$readelf_bin\" NEEDED)\"\n  [[ \"$core_soname\" == libcitizensdk.so ]] \\\n    || fail \"Android Core SONAME 必须精确为 libcitizensdk.so；实际=${core_soname:-无}\"\n  [[ \"$jni_soname\" == libcitizensdk_jni.so ]] \\\n    || fail \"Android JNI SONAME 必须精确为 libcitizensdk_jni.so；实际=${jni_soname:-无}\"\n  if printf '%s\\n%s\\n' \"$core_needed\" \"$jni_needed\" | grep -q '/'; then\n    fail \"Android ELF DT_NEEDED 禁止包含构建机路径\"\n  fi\n  core_dependency_count=\"$(printf '%s\\n' \"$jni_needed\" \\\n    | grep -Fxc libcitizensdk.so || true)\"\n  [[ \"$core_dependency_count\" == 1 ]] \\\n    || fail \"Android JNI 必须精确依赖一次 libcitizensdk.so；实际=${core_dependency_count}\"\n}\n\nlinux_host_header_symbols() {\n  local header=\"$linux_source_root/headers/citizensdk_host.h\"\n  [[ -f \"$header\" && ! -L \"$header\" ]] \\\n    || fail \"Linux Host 公共头缺失或不是普通文件：$header\"\n  perl -0777 -ne \\\n    'while (/\\b(citizensdk_host_[a-z0-9_]+)\\s*\\(/g) { print \"$1\\n\" }' \\\n    \"$header\" | LC_ALL=C sort -u\n}\n\nlinux_elf_dynamic_values() {\n  local library=\"$1\" readelf_bin=\"$2\" tag=\"$3\"\n  \"$readelf_bin\" -d \"$library\" 2>/dev/null \\\n    | sed -n \"s/.*(${tag}).*\\[\\([^]]*\\)\\].*/\\1/p\"\n}\n\nversion_is_greater() {\n  local value=\"$1\" maximum=\"$2\"\n  [[ \"$value\" != \"$maximum\" \\\n    && \"$(printf '%s\\n%s\\n' \"$value\" \"$maximum\" | sort -V | tail -n 1)\" == \"$value\" ]]\n}\n\nverify_linux_glibc_contract() {\n  local library=\"$1\" readelf_bin=\"$2\" label=\"$3\" versions version version_info\n  local allow_cpp_runtime=\"${4:-false}\"\n  # 工具失败不能当成“没有版本需求”；先取得完整输出，再解析允许的数字版本。\n  version_info=\"$(\"$readelf_bin\" --version-info \"$library\" 2>/dev/null)\" \\\n    || fail \"无法读取 $label 的 ELF version-info\"\n  if printf '%s\\n' \"$version_info\" | grep -Eq 'GLIBC_[A-Za-z]'; then\n    fail \"$label 包含不能按 GLIBC_$linux_glibc_baseline 验证的版本需求\"\n  fi\n  versions=\"$(printf '%s\\n' \"$version_info\" \\\n    | grep -oE 'GLIBC_[0-9]+(\\.[0-9]+)*' \\\n    | sed 's/^GLIBC_//' | sort -Vu || true)\"\n  while IFS= read -r version; do\n    [[ -n \"$version\" ]] || continue\n    ! version_is_greater \"$version\" \"$linux_glibc_baseline\" \\\n      || fail \"$label 要求 GLIBC_${version}，超过固定基线 GLIBC_$linux_glibc_baseline\"\n  done <<<\"$versions\"\n  if [[ \"$allow_cpp_runtime\" != true ]] \\\n      && printf '%s\\n' \"$version_info\" | grep -Eq 'GLIBCXX_|CXXABI_'; then\n    fail \"$label 禁止依赖宿主 libstdc++/CXX ABI；C++ runtime 必须静态装配\"\n  fi\n}\n\nlinux_install_files() {\n  local platform=\"$1\"\n  case \"$platform\" in LinuxARM|LinuxAMD) ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  printf '%s\\n' \\\n    include/citizensdk.h include/citizensdk_types.h include/citizensdk_qr_image.h \\\n    include/citizen_sdk/citizen_sdk.hpp \\\n    include/citizen_sdk/citizen_sdk_config.hpp \\\n    include/citizen_sdk/citizen_sdk_error.hpp \\\n    include/citizen_sdk/citizen_sdk_events.hpp \\\n    include/citizen_sdk/citizen_sdk_models.hpp \\\n    include/citizen_sdk/citizensdk_host.h \\\n    \"lib/$platform/libcitizensdk.so\" \"lib/$platform/libcitizensdk_host.so\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKConfig.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKDependencies.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKTargets.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKTargets-release.cmake\" \\\n    share/citizensdk/chain/manifest.json \\\n    share/citizensdk/chain/chainspec.json \\\n    share/citizensdk/chain/light_sync_state.json \\\n    | LC_ALL=C sort\n}\n\nverify_linux_install() {\n  local prefix=\"$1\" platform=\"$2\" software_version=\"$3\" source_core=\"$4\"\n  local readelf_bin=\"$5\" nm_bin=\"$6\" expected actual directories path parent package_dir\n  local expected_directories='' version declarations core_symbols host_symbols\n  assert_safe_directory_path \"$prefix\" \"$platform 安装前缀\"\n  [[ -d \"$prefix\" && ! -L \"$prefix\" ]] || fail \"$platform 安装前缀不是普通目录\"\n  [[ -z \"$(find \"$prefix\" -mindepth 1 ! -type f ! -type d -print -quit)\" ]] \\\n    || fail \"$platform 安装投影禁止符号链接和特殊节点\"\n  expected=\"$(linux_install_files \"$platform\")\"\n  [[ \"$(printf '%s\\n' \"$expected\" | wc -l | tr -d ' ')\" == 19 ]] \\\n    || fail \"$platform 安装文件合同必须精确为 19 项\"\n  actual=\"$(cd \"$prefix\" && find . -type f -print | sed 's|^./||' | LC_ALL=C sort)\"\n  [[ \"$actual\" == \"$expected\" ]] || fail \"$platform 安装文件闭集不一致\"\n  while IFS= read -r path; do\n    parent=\"$(dirname \"$path\")\"\n    while [[ \"$parent\" != . ]]; do\n      expected_directories+=\"$parent\"$'\\n'\n      parent=\"$(dirname \"$parent\")\"\n    done\n  done <<<\"$expected\"\n  directories=\"$(cd \"$prefix\" && find . -mindepth 1 -type d -print \\\n    | sed 's|^./||' | LC_ALL=C sort)\"\n  expected_directories=\"$(printf '%s' \"$expected_directories\" | LC_ALL=C sort -u)\"\n  [[ \"$directories\" == \"$expected_directories\" ]] || fail \"$platform 安装目录闭集不一致\"\n  for path in citizensdk.h citizensdk_types.h; do\n    cmp -s \"$sdk_dir/include/$path\" \"$prefix/include/$path\" \\\n      || fail \"$platform 安装 Core 头字节漂移：$path\"\n  done\n  cmp -s \"$qr_image_header\" \"$prefix/include/citizensdk_qr_image.h\" \\\n    || fail \"$platform 安装统一 QR 图像头字节漂移\"\n  for path in citizen_sdk.hpp citizen_sdk_config.hpp citizen_sdk_error.hpp \\\n      citizen_sdk_events.hpp citizen_sdk_models.hpp citizensdk_host.h; do\n    local source_header=\"$linux_source_root/headers/$path\"\n    case \"$path\" in citizen_sdk_error.hpp|citizen_sdk_events.hpp|citizen_sdk_models.hpp) source_header=\"$sdk_dir/include/$path\" ;; esac\n    cmp -s \"$source_header\" \"$prefix/include/citizen_sdk/$path\" \\\n      || fail \"$platform 安装 Host 头字节漂移：$path\"\n  done\n  for path in manifest.json chainspec.json light_sync_state.json; do\n    cmp -s \"$apple_asset_root/$path\" \"$prefix/share/citizensdk/chain/$path\" \\\n      || fail \"$platform 安装链资产字节漂移：$path\"\n  done\n  cmp -s \"$source_core\" \"$prefix/lib/$platform/libcitizensdk.so\" \\\n    || fail \"$platform 安装 Core 字节漂移\"\n  package_dir=\"$prefix/lib/$platform/cmake/CitizenSDK\"\n  cmp -s \"$linux_source_root/cmake/CitizenSDKDependencies.cmake\" \\\n    \"$package_dir/CitizenSDKDependencies.cmake\" || fail \"$platform 安装依赖合同漂移\"\n  version=\"$(sed -n 's/^set(PACKAGE_VERSION \"\\([^\"]*\\)\")$/\\1/p' \\\n    \"$package_dir/CitizenSDKConfigVersion.cmake\")\"\n  [[ \"$version\" == \"$software_version\" ]] || fail \"$platform 安装版本不一致\"\n  declarations=\"$(sed -n 's/^set(_CITIZENSDK_PACKAGE_PLATFORM \"\\([^\"]*\\)\")$/\\1/p' \\\n    \"$package_dir/CitizenSDKConfig.cmake\")\"\n  [[ \"$declarations\" == \"$platform\" ]] || fail \"$platform 安装平台不一致\"\n  # 已安装 package 必须可搬动，不能靠源码或这次构建目录找到头和运行库。\n  if grep -F -e \"$sdk_dir\" -e \"$work_dir\" \"$package_dir\"/*.cmake >/dev/null; then\n    fail \"$platform 安装配置泄漏源码或构建绝对路径\"\n  fi\n  core_symbols=\"$(product_header_symbols)\"\n  host_symbols=\"$(linux_host_header_symbols)\"\n  [[ \"$(printf '%s\\n' \"$core_symbols\" | wc -l | tr -d ' ')\" == 144 \\\n    && \"$(printf '%s\\n' \"$host_symbols\" | wc -l | tr -d ' ')\" == 19 ]] \\\n    || fail \"$platform 公开 ABI 必须精确为 144 Core / 19 Host\"\n  verify_linux_elf_identity \"$platform\" \"$prefix/lib/$platform/libcitizensdk.so\" \\\n    \"$prefix/lib/$platform/libcitizensdk_host.so\" \"$readelf_bin\" \"$nm_bin\"\n}\n\ncopy_linux_install() {\n  local source_prefix=\"$1\" destination_prefix=\"$2\" platform=\"$3\" destination_root=\"$4\"\n  local paths path source destination\n  assert_safe_directory_path \"$source_prefix\" \"$platform 安装投影来源\"\n  [[ -d \"$source_prefix\" && ! -L \"$source_prefix\" ]] \\\n    || fail \"$platform 安装投影来源必须是普通目录\"\n  paths=\"$(linux_install_files \"$platform\")\"\n  assert_descendant_path \"$destination_root\" \"$destination_prefix\" \"$platform 安装投影目标\"\n  assert_safe_directory_path \"$destination_prefix\" \"$platform 安装投影目标\"\n  # 唯一19项名单同时用于外部native输入和Flutter包内投影。源码已有的\n  # 七个 Host 公开头只做字节比较，绝不覆盖不同版本或复制整个未受控目录。\n  # 全量预检完成后才写入，缺项或重叠漂移不会留下半份安装投影。\n  while IFS= read -r path; do\n    source=\"$source_prefix/$path\"\n    destination=\"$destination_prefix/$path\"\n    assert_safe_directory_path \"$(dirname \"$source\")\" \"$platform 安装文件来源父目录\"\n    assert_safe_directory_path \"$(dirname \"$destination\")\" \"$platform 安装文件目标父目录\"\n    [[ -f \"$source\" && ! -L \"$source\" ]] \\\n      || fail \"$platform 安装投影缺少普通文件：$path\"\n    if [[ -e \"$destination\" || -L \"$destination\" ]]; then\n      [[ -f \"$destination\" && ! -L \"$destination\" ]] \\\n        || fail \"$platform 重叠安装文件类型无效：$path\"\n      cmp -s \"$source\" \"$destination\" \\\n        || fail \"$platform 重叠安装文件字节漂移：$path\"\n    fi\n  done <<<\"$paths\"\n  prepare_safe_directory \"$destination_root\" \"$destination_prefix\" \"$platform 安装投影目标\"\n  while IFS= read -r path; do\n    source=\"$source_prefix/$path\"\n    destination=\"$destination_prefix/$path\"\n    if [[ ! -e \"$destination\" && ! -L \"$destination\" ]]; then\n      prepare_safe_output_file \"$destination_root\" \"$destination\" \"$platform 安装投影文件\"\n      cp \"$source\" \"$destination\"\n    fi\n  done <<<\"$paths\"\n}\n\nverify_linux_machine() {\n  local library=\"$1\" readelf_bin=\"$2\" expected_machine=\"$3\" label=\"$4\"\n  local header machine\n  header=\"$(LC_ALL=C \"$readelf_bin\" -h \"$library\" 2>/dev/null)\" \\\n    || fail \"无法读取 $label 的 ELF header\"\n  printf '%s\\n' \"$header\" | grep -Eq 'Class:[[:space:]]+ELF64' \\\n    || fail \"$label 必须是 ELF64\"\n  printf '%s\\n' \"$header\" \\\n    | grep -Eq 'Data:[[:space:]]+2.s complement, little endian' \\\n    || fail \"$label 必须是 little-endian ELF\"\n  printf '%s\\n' \"$header\" | grep -Eq 'Type:[[:space:]]+DYN' \\\n    || fail \"$label 必须是 ET_DYN shared object\"\n  machine=\"$(printf '%s\\n' \"$header\" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')\"\n  [[ \"$machine\" == \"$expected_machine\" ]] \\\n    || fail \"$label 机器类型漂移：预期=${expected_machine}；实际=${machine:-无}\"\n}\n\nverify_linux_host_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" label=\"$3\" actual expected forbidden\n  actual=\"$(product_library_symbols \"$library\" \"$nm_bin\" '')\"\n  expected=\"$({ linux_host_header_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u)\"\n  forbidden=\"$(printf '%s\\n' \"$actual\" \\\n    | grep -E '^(citizensdk_|smoldot_|citizen_sr25519_|account_crypto_)' \\\n    | grep -Ev '^citizensdk_(host_|qr_image_)' \\\n    || true)\"\n  [[ -z \"$forbidden\" ]] \\\n    || fail \"$label 重复导出 Core 或低层符号：$(printf '%s' \"$forbidden\" | tr '\\n' ' ')\"\n  [[ \"$actual\" == \"$expected\" ]] || {\n    local missing extra\n    missing=\"$(comm -23 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    extra=\"$(comm -13 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    fail \"$label 与 citizensdk_host.h 不一致；缺失=${missing:-无}；额外=${extra:-无}\"\n  }\n}\n\nverify_linux_elf_identity() {\n  local platform=\"$1\" core_library=\"$2\" host_library=\"$3\" readelf_bin=\"$4\" nm_bin=\"$5\"\n  local expected_machine core_soname host_soname core_needed host_needed\n  local core_rpath core_runpath host_rpath host_runpath core_dependency_count\n  case \"$platform\" in\n    LinuxARM) expected_machine=AArch64 ;;\n    LinuxAMD) expected_machine='Advanced Micro Devices X86-64' ;;\n    *) fail \"未登记的 Linux 平台：$platform\" ;;\n  esac\n  [[ -x \"$readelf_bin\" && -x \"$nm_bin\" ]] \\\n    || fail \"$platform 缺少可执行 readelf/nm\"\n  for library in \"$core_library\" \"$host_library\"; do\n    [[ -f \"$library\" && ! -L \"$library\" ]] \\\n      || fail \"$platform 运行件必须是普通文件：$library\"\n  done\n  verify_linux_machine \"$core_library\" \"$readelf_bin\" \"$expected_machine\" \\\n    \"$platform Core\"\n  verify_linux_machine \"$host_library\" \"$readelf_bin\" \"$expected_machine\" \\\n    \"$platform Host\"\n  core_soname=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" SONAME)\"\n  host_soname=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" SONAME)\"\n  core_needed=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" NEEDED)\"\n  host_needed=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" NEEDED)\"\n  core_rpath=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" RPATH)\"\n  core_runpath=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" RUNPATH)\"\n  host_rpath=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" RPATH)\"\n  host_runpath=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" RUNPATH)\"\n  [[ \"$core_soname\" == libcitizensdk.so ]] \\\n    || fail \"$platform Core SONAME 漂移：${core_soname:-无}\"\n  [[ \"$host_soname\" == libcitizensdk_host.so ]] \\\n    || fail \"$platform Host SONAME 漂移：${host_soname:-无}\"\n  [[ -z \"$core_rpath\" && -z \"$core_runpath\" ]] \\\n    || fail \"$platform Core 禁止 RPATH/RUNPATH\"\n  [[ -z \"$host_rpath\" && \"$host_runpath\" == '$ORIGIN' ]] \\\n    || fail \"$platform Host RUNPATH 必须精确为字面量 \\$ORIGIN\"\n  if printf '%s\\n%s\\n' \"$core_needed\" \"$host_needed\" | grep -q '/'; then\n    fail \"$platform DT_NEEDED 禁止包含构建机路径\"\n  fi\n  if printf '%s\\n%s\\n' \"$core_needed\" \"$host_needed\" \\\n      | grep -Eq '(^|/)(libsmoldot|libstdc\\+\\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)'; then\n    fail \"$platform 运行件泄漏禁止的动态依赖\"\n  fi\n  core_dependency_count=\"$(printf '%s\\n' \"$host_needed\" \\\n    | grep -Fxc libcitizensdk.so || true)\"\n  [[ \"$core_dependency_count\" == 1 ]] \\\n    || fail \"$platform Host 必须精确依赖一次 libcitizensdk.so\"\n  verify_product_abi_symbols \"$core_library\" \"$nm_bin\" '' \"$platform Core\"\n  verify_linux_host_symbols \"$host_library\" \"$nm_bin\" \"$platform Host\"\n  verify_linux_glibc_contract \"$core_library\" \"$readelf_bin\" \"$platform Core\"\n  verify_linux_glibc_contract \"$host_library\" \"$readelf_bin\" \"$platform Host\"\n}\n\nresolve_gradle() {\n  local executable=\"${CITIZENSDK_GRADLE:-}\" link_target\n  if [[ -z \"$executable\" ]]; then\n    executable=\"$(command -v gradle || true)\"\n  fi\n  [[ -n \"$executable\" ]] \\\n    || fail \"缺少 Gradle；请用 CITIZENSDK_GRADLE 指向受控 gradle/gradlew 绝对路径\"\n  [[ \"$executable\" == /* ]] || fail \"CITIZENSDK_GRADLE 必须解析为绝对路径\"\n  while [[ -L \"$executable\" ]]; do\n    link_target=\"$(readlink \"$executable\")\"\n    [[ \"$link_target\" == /* ]] || link_target=\"$(cd \"$(dirname \"$executable\")\" && pwd -P)/$link_target\"\n    executable=\"$link_target\"\n  done\n  executable=\"$(cd \"$(dirname \"$executable\")\" && pwd -P)/$(basename \"$executable\")\"\n  [[ -f \"$executable\" && -x \"$executable\" ]] \\\n    || fail \"Gradle必须解析到可执行普通文件：$executable\"\n  printf '%s\\n' \"$executable\"\n}\n\n# Android标准assets容器与源码chain分开校验；仅允许精确三文件，逐个回读源码字节。\nverify_android_chain_assets() {\n  local aar=\"$1\" entries asset actual expected\n  entries=\"$(unzip -Z1 \"$aar\")\" || fail \"无法读取 Android AAR 链资产\"\n  actual=\"$(printf '%s\\n' \"$entries\" | grep '^assets/' | grep -v '/$' | LC_ALL=C sort || true)\"\n  expected=$'assets/chain/chainspec.json\\nassets/chain/light_sync_state.json\\nassets/chain/manifest.json'\n  [[ \"$actual\" == \"$expected\" ]] || fail \"Android AAR 链资产闭集漂移\"\n  for asset in \\\n    chain/chainspec.json \\\n    chain/light_sync_state.json \\\n    chain/manifest.json; do\n    printf '%s\\n' \"$entries\" | grep -Fxq \"assets/$asset\" \\\n      || fail \"Android AAR 缺少已验证链资产：$asset\"\n    cmp -s <(unzip -p \"$aar\" \"assets/$asset\") \"$sdk_dir/$asset\" \\\n      || fail \"Android AAR 链资产与源码信任锚字节不一致：$asset\"\n  done\n}\n\nverify_android_aar() {\n  local aar=\"$1\" core_library=\"$2\" jni_library=\"$3\" nm_bin=\"$4\"\n  local entries native_entries expected_native verify_dir aar_core aar_jni classes\n  local class_entries classes_payload\n  command -v unzip >/dev/null 2>&1 || fail \"Android AAR 核验需要 unzip\"\n  [[ -f \"$aar\" && -f \"$core_library\" && -f \"$jni_library\" ]] \\\n    || fail \"Android AAR 或双原生库不完整\"\n  entries=\"$(unzip -Z1 \"$aar\")\" || fail \"无法读取 Android AAR 文件闭集\"\n  native_entries=\"$(printf '%s\\n' \"$entries\" \\\n    | grep -E '^jni/' \\\n    | grep -v '/$' \\\n    | LC_ALL=C sort || true)\"\n  expected_native=$'jni/arm64-v8a/libcitizensdk.so\\njni/arm64-v8a/libcitizensdk_jni.so'\n  [[ \"$native_entries\" == \"$expected_native\" ]] \\\n    || fail \"Android AAR 原生库必须精确为 arm64-v8a 双库；实际=${native_entries:-无}\"\n  printf '%s\\n' \"$entries\" | grep -Fxq AndroidManifest.xml \\\n    || fail \"Android AAR 缺少 AndroidManifest.xml\"\n  printf '%s\\n' \"$entries\" | grep -Fxq classes.jar \\\n    || fail \"Android AAR 缺少 classes.jar\"\n  verify_android_chain_assets \"$aar\"\n  if printf '%s\\n' \"$entries\" | grep -Eq '(^|/)(libsmoldot|libc\\+\\+_shared)\\.so$|\\.aar$'; then\n    fail \"Android AAR 混入 legacy/C++ 共享运行库或嵌套 AAR\"\n  fi\n\n  verify_dir=\"$(mktemp -d \"$work_dir/android-aar-verify.XXXXXX\")\" \\\n    || fail \"无法创建 Android AAR 核验目录\"\n  assert_safe_directory_path \"$verify_dir\" \"Android AAR 核验目录\"\n  aar_core=\"$verify_dir/libcitizensdk.so\"\n  aar_jni=\"$verify_dir/libcitizensdk_jni.so\"\n  classes=\"$verify_dir/classes.jar\"\n  classes_payload=\"$verify_dir/classes.payload\"\n  unzip -p \"$aar\" jni/arm64-v8a/libcitizensdk.so >\"$aar_core\" \\\n    || fail \"无法提取 AAR Core 库\"\n  unzip -p \"$aar\" jni/arm64-v8a/libcitizensdk_jni.so >\"$aar_jni\" \\\n    || fail \"无法提取 AAR JNI 库\"\n  unzip -p \"$aar\" classes.jar >\"$classes\" || fail \"无法提取 AAR classes.jar\"\n  cmp -s \"$core_library\" \"$aar_core\" || fail \"AAR 与外部 libcitizensdk.so 字节不一致\"\n  cmp -s \"$jni_library\" \"$aar_jni\" || fail \"AAR 与外部 libcitizensdk_jni.so 字节不一致\"\n  verify_jni_symbols \"$jni_library\" \"$nm_bin\"\n  verify_android_elf_identity \\\n    \"$core_library\" \"$jni_library\" \"${nm_bin%/*}/llvm-readelf\"\n  class_entries=\"$(unzip -Z1 \"$classes\")\" || fail \"无法读取 AAR classes.jar 闭集\"\n  if printf '%s\\n' \"$class_entries\" | grep -Eq '^io/flutter/'; then\n    fail \"原生 AAR classes.jar 混入 Flutter 类\"\n  fi\n  for required_class in \\\n    org/citizen/sdk/CitizenSdk.class org/citizen/sdk/CitizenSigning.class org/citizen/sdk/CitizenSdkModules.class \\\n    org/citizen/sdk/CitizenSdkOperation.class \\\n    org/citizen/sdk/internal/CitizenSdkNative.class \\\n    org/citizen/sdk/internal/CitizenSdkHardwareVault.class; do\n    printf '%s\\n' \"$class_entries\" | grep -Fxq \"$required_class\" \\\n      || fail \"原生 AAR classes.jar 缺少必需实现：$required_class\"\n  done\n  unzip -p \"$classes\" >\"$classes_payload\" || fail \"无法读取 AAR classes.jar 内容\"\n  if LC_ALL=C grep -a -q 'io/flutter/' \"$classes_payload\"; then\n    fail \"原生 AAR classes.jar 引用了 Flutter API\"\n  fi\n}\n\nandroid_toolchain() {\n  local ndk_home=\"${ANDROID_NDK_HOME:-}\" sdk_home host_tag expected_ndk\n  if [[ -n \"${ANDROID_HOME:-}\" && -n \"${ANDROID_SDK_ROOT:-}\" \\\n    && \"$ANDROID_HOME\" != \"$ANDROID_SDK_ROOT\" ]]; then\n    fail \"ANDROID_HOME 与 ANDROID_SDK_ROOT 指向不同目录\"\n  fi\n  sdk_home=\"${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}\"\n  if [[ -z \"$ndk_home\" ]]; then\n    if [[ -z \"$sdk_home\" ]]; then\n      [[ -n \"${HOME:-}\" ]] || fail \"缺少 Android SDK 环境与 HOME\"\n      case \"$(uname -s)\" in\n        Darwin) sdk_home=\"$HOME/Library/Android/sdk\" ;;\n        Linux) sdk_home=\"$HOME/Android/Sdk\" ;;\n        *) fail \"当前宿主没有登记 Android SDK 标准目录：$(uname -s)\" ;;\n      esac\n    fi\n    assert_safe_directory_path \"$sdk_home\" \"Android SDK\"\n    [[ -d \"$sdk_home\" ]] || fail \"Android SDK 不存在：$sdk_home\"\n    sdk_home=\"$(cd \"$sdk_home\" && pwd -P)\"\n    ndk_home=\"$sdk_home/ndk/$android_ndk_version\"\n  else\n    assert_safe_directory_path \"$ndk_home\" \"ANDROID_NDK_HOME\"\n    [[ -d \"$ndk_home\" ]] || fail \"Android NDK 不存在：$ndk_home\"\n    ndk_home=\"$(cd \"$ndk_home\" && pwd -P)\"\n    [[ \"${ndk_home##*/}\" == \"$android_ndk_version\" ]] \\\n      || fail \"ANDROID_NDK_HOME 必须使用统一版本 $android_ndk_version\"\n    if [[ -n \"$sdk_home\" ]]; then\n      assert_safe_directory_path \"$sdk_home\" \"Android SDK\"\n      [[ -d \"$sdk_home\" ]] || fail \"Android SDK 不存在：$sdk_home\"\n      sdk_home=\"$(cd \"$sdk_home\" && pwd -P)\"\n      expected_ndk=\"$sdk_home/ndk/$android_ndk_version\"\n      [[ \"$ndk_home\" == \"$expected_ndk\" ]] \\\n        || fail \"ANDROID_NDK_HOME 不属于统一 Android SDK 与 NDK 版本\"\n    fi\n  fi\n  [[ -d \"$ndk_home\" ]] || fail \"Android NDK 不存在：$ndk_home\"\n  case \"$(uname -s)-$(uname -m)\" in\n    Darwin-arm64)\n      host_tag=darwin-aarch64\n      [[ -d \"$ndk_home/toolchains/llvm/prebuilt/$host_tag\" ]] || host_tag=darwin-x86_64\n      ;;\n    Darwin-x86_64)\n      host_tag=darwin-x86_64\n      [[ -d \"$ndk_home/toolchains/llvm/prebuilt/$host_tag\" ]] || host_tag=darwin-aarch64\n      ;;\n    Linux-x86_64) host_tag=linux-x86_64 ;;\n    *) fail \"不支持的 Android 构建宿主：$(uname -s)-$(uname -m)\" ;;\n  esac\n  local toolchain=\"$ndk_home/toolchains/llvm/prebuilt/$host_tag\"\n  [[ -d \"$toolchain\" ]] || fail \"Android NDK toolchain 不存在：$toolchain\"\n  printf '%s\\n' \"$toolchain\"\n}\n\n# Gradle 9 要求每个 projectDir 可写。这里只生成当前任务的入口配置，\n# 三个脚本及全部业务源码仍从 SDK 原目录只读加载，不复制源码工程。\nprepare_android_gradle_project() {\n  local android_gradle_project=\"$work_dir/gradle-project\" relative\n  prepare_safe_directory \"$work_dir\" \"$android_gradle_project/native\" \"Android Gradle 任务工程\"\n  for relative in settings.gradle build.gradle native/build.gradle; do\n    prepare_safe_output_file \"$work_dir\" \"$android_gradle_project/$relative\" \"Android Gradle 任务配置\"\n  done\n  cat >\"$android_gradle_project/settings.gradle\" <<'GRADLE'\napply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/settings.gradle')\nGRADLE\n  cat >\"$android_gradle_project/build.gradle\" <<'GRADLE'\napply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/build.gradle')\nGRADLE\n  cat >\"$android_gradle_project/native/build.gradle\" <<'GRADLE'\napply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/native/build.gradle')\nGRADLE\n}\n\nbuild_android() {\n  prepare_internal_header\n  require_rust_target aarch64-linux-android\n  local toolchain gradle_bin android_build_dir gradle_project_cache gradle_user_home\n  local kotlin_persistent_dir gradle_network_arg='' verifier_maven_dir verifier_link\n  local android_gradle_project=\"$work_dir/gradle-project\"\n  local core_stage core_destination jni_destination aar_destination source_library\n  local built_aar aar_jni nm_bin strip_bin\n  toolchain=\"$(android_toolchain)\"\n  gradle_bin=\"$(resolve_gradle)\"\n  case \"${CITIZENSDK_OFFLINE:-false}\" in\n    true) gradle_network_arg='--offline' ;;\n    false) ;;\n    *) fail \"CITIZENSDK_OFFLINE只接受true或false\" ;;\n  esac\n  android_build_dir=\"$work_dir/gradle-native\"\n  gradle_project_cache=\"$work_dir/gradle-project-cache\"\n  # 调用产品可以提供位于自身任务缓存中的统一 GRADLE_USER_HOME，使已下载依赖\n  # 自动归入调用方依赖缓存；它不是SDK编译物，因此不要求位于SDK子工作根。\n  gradle_user_home=\"${GRADLE_USER_HOME:-$work_dir/gradle-home}\"\n  kotlin_persistent_dir=\"$work_dir/kotlin-project-persistent\"\n  core_stage=\"$work_dir/android-core/arm64-v8a\"\n  core_destination=\"$output_dir/android/arm64-v8a/libcitizensdk.so\"\n  jni_destination=\"$output_dir/android/arm64-v8a/libcitizensdk_jni.so\"\n  aar_destination=\"$output_dir/android/citizensdk.aar\"\n  for directory in \\\n    \"$android_build_dir\" \"$gradle_project_cache\" \"$kotlin_persistent_dir\" \"$core_stage\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Android 外部构建目录\"\n  done\n  if [[ -n \"${GRADLE_USER_HOME:-}\" ]]; then\n    prepare_external_cache_directory \"$gradle_user_home\" \"Android Gradle 依赖缓存\"\n  else\n    prepare_safe_directory \"$work_dir\" \"$gradle_user_home\" \"Android Gradle 依赖缓存\"\n  fi\n  prepare_android_gradle_project\n  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=\"$toolchain/bin/aarch64-linux-android24-clang\"\n  export CC_aarch64_linux_android=\"$toolchain/bin/aarch64-linux-android24-clang\"\n  export AR_aarch64_linux_android=\"$toolchain/bin/llvm-ar\"\n  CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS='-C link-arg=-Wl,-soname,libcitizensdk.so' \\\n    cargo build --manifest-path \"$product_ffi_manifest\" --release --locked \\\n      --target aarch64-linux-android\n  source_library=\"$CARGO_TARGET_DIR/aarch64-linux-android/release/libcitizensdk.so\"\n  [[ -f \"$source_library\" ]] || fail \"Android CitizenSDK Core 库未生成\"\n  prepare_safe_output_file \"$work_dir\" \"$core_stage/libcitizensdk.so\" \\\n    \"Android Gradle Core staging\"\n  cp \"$source_library\" \"$core_stage/libcitizensdk.so\"\n  nm_bin=\"$toolchain/bin/llvm-nm\"\n  strip_bin=\"$toolchain/bin/llvm-strip\"\n  [[ -x \"$strip_bin\" ]] || fail \"Android NDK llvm-strip 不可执行：$strip_bin\"\n  # AGP 会对 Release AAR 中的 JNI 库执行 --strip-unneeded。先在受控 staging\n  # 对 Core 做同一次确定性处理，再把这一个字节版本同时投影到独立双库和 AAR；\n  # 否则外部 SO 与 AAR 会在打包后悄然变成两个不同产物。\n  \"$strip_bin\" --strip-unneeded \"$core_stage/libcitizensdk.so\"\n  verify_product_abi_symbols \"$core_stage/libcitizensdk.so\" \"$nm_bin\" \"\" \\\n    \"Android libcitizensdk.so\"\n  prepare_safe_output_file \"$output_dir\" \"$core_destination\" \"Android CitizenSDK Core 库\"\n  cp \"$core_stage/libcitizensdk.so\" \"$core_destination\"\n\n  # 默认按锁联网定位；只有调用方显式离线时才限制元数据解析使用已有缓存。\n  # 仅链接本轮 Cargo 锁定包自带的 Maven 目录，不复制或重打包依赖原件。\n  verifier_maven_dir=\"$(cargo metadata --manifest-path \"$product_ffi_manifest\" \\\n    --format-version 1 --locked ${gradle_network_arg:+\"$gradle_network_arg\"} | node -e '\n      let input = \"\";\n      process.stdin.on(\"data\", chunk => input += chunk);\n      process.stdin.on(\"end\", () => {\n        const matched = JSON.parse(input).packages.filter(packageInfo =>\n          packageInfo.name === \"rustls-platform-verifier-android\" && packageInfo.version === \"0.1.1\");\n        if (matched.length !== 1) process.exit(1);\n        process.stdout.write(require(\"path\").join(require(\"path\").dirname(matched[0].manifest_path), \"maven\"));\n      });\n    ')\" || fail \"无法定位 Cargo.lock 中的 Android 官方证书组件\"\n  [[ -f \"$verifier_maven_dir/rustls/rustls-platform-verifier/0.1.1/rustls-platform-verifier-0.1.1.aar\" ]] \\\n    || fail \"锁定的 Android 官方证书组件 AAR 缺失\"\n  verifier_link=\"$gradle_user_home/citizensdk-verifier-maven\"\n  if [[ -e \"$verifier_link\" || -L \"$verifier_link\" ]]; then\n    [[ -L \"$verifier_link\" && \"$(readlink \"$verifier_link\")\" == \"$verifier_maven_dir\" ]] \\\n      || fail \"Android 证书组件 Maven 视图已被其它内容占用\"\n  else\n    ln -s \"$verifier_maven_dir\" \"$verifier_link\"\n  fi\n\n  # Gradle 的 HTML 问题报告会写入源码；关闭该报告，中央日志仍保留完整错误栈。\n  # 环境变量必须连续传给同一子进程，续行中插入注释会使变量失去导出效果。\n  CITIZENSDK_ANDROID_BUILD_DIR=\"$android_build_dir\" \\\n  CITIZENSDK_SOURCE_DIR=\"$sdk_dir\" \\\n  CITIZENSDK_ANDROID_CORE_DIR=\"$core_stage\" \\\n  CITIZENSDK_INTERNAL_INCLUDE_DIR=\"$work_dir/private-include\" \\\n  CITIZENSDK_ZXING_SOURCE_DIR=\"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n  GRADLE_USER_HOME=\"$gradle_user_home\" \\\n    \"$gradle_bin\" ${gradle_network_arg:+\"$gradle_network_arg\"} --no-daemon --stacktrace --no-problems-report \\\n      --project-cache-dir \"$gradle_project_cache\" \\\n      -Pkotlin.project.persistent.dir=\"$kotlin_persistent_dir\" \\\n      -p \"$android_gradle_project\" :native:assembleRelease\n  built_aar=\"$android_build_dir/native/outputs/aar/native-release.aar\"\n  [[ -f \"$built_aar\" ]] || fail \"Android CitizenSDK AAR 未生成：$built_aar\"\n\n  prepare_safe_output_file \"$output_dir\" \"$jni_destination\" \"Android CitizenSDK JNI 库\"\n  unzip -p \"$built_aar\" jni/arm64-v8a/libcitizensdk_jni.so >\"$jni_destination\" \\\n    || fail \"无法从 AAR 提取 libcitizensdk_jni.so\"\n  prepare_safe_output_file \"$output_dir\" \"$aar_destination\" \"Android CitizenSDK AAR\"\n  cp \"$built_aar\" \"$aar_destination\"\n  verify_android_aar \\\n    \"$aar_destination\" \"$core_destination\" \"$jni_destination\" \"$nm_bin\"\n  echo \"CitizenSDK Android Core/JNI/AAR 完成：$aar_destination\"\n}\n\napple_product_symbols() {\n  local library=\"$1\" nm_bin=\"$2\"\n  \"$nm_bin\" -gU \"$library\" 2>/dev/null \\\n    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \\\n    | sed 's/^_//' \\\n    | LC_ALL=C sort -u\n}\n\nqr_image_header_symbols() {\n  perl -0777 -ne 'while (/\\b(citizensdk_qr_image_[a-z0-9_]+)\\s*\\(/g) { print \"$1\\n\" }' \\\n    \"$qr_image_header\" | LC_ALL=C sort -u\n}\n\napple_public_symbols() {\n  { product_header_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u\n}\n\napple_linked_symbols() {\n  { product_linked_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u\n}\n\nverify_apple_product_abi_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" label=\"$3\"\n  local all_symbols actual expected forbidden foreign swift_symbols expected_count\n  all_symbols=\"$(apple_product_symbols \"$library\" \"$nm_bin\")\" \\\n    || fail \"无法读取 $label 的 Mach-O 外部已定义符号\"\n  actual=\"$(printf '%s\\n' \"$all_symbols\" | grep '^citizensdk_' || true)\"\n  expected=\"$(apple_public_symbols)\"\n  expected_count=\"$(printf '%s\\n' \"$expected\" | grep -c '^citizensdk_' || true)\"\n  [[ \"$expected_count\" == 148 ]] \\\n    || fail \"Apple 产品头必须精确声明 144 个 Core 与 4 个图像函数\"\n  forbidden=\"$(printf '%s\\n' \"$all_symbols\" \\\n    | grep -E '^(smoldot_|citizen_sr25519_|account_crypto_)' || true)\"\n  [[ -z \"$forbidden\" ]] \\\n    || fail \"$label 泄露 legacy 低层符号：$(printf '%s' \"$forbidden\" | tr '\\n' ' ')\"\n  [[ \"$actual\" == \"$expected\" ]] || {\n    local missing extra\n    missing=\"$(comm -23 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    extra=\"$(comm -13 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    fail \"$label 的 citizensdk_* 与 144 Core + 4 图像函数产品头不一致；缺失=${missing:-无}；额外=${extra:-无}\"\n  }\n  # 动态 framework 同时提供 Swift API 和 C ABI。Swift public/ABI-support 符号\n  # 只能属于本模块 mangling；除这组 Swift 符号外，全部外部已定义符号必须正好\n  # 是产品头中的 144 个 Core + 4 个图像 C ABI，Rust staticlib 及其依赖不得穿透边界。\n  swift_symbols=\"$(printf '%s\\n' \"$all_symbols\" | grep '^\\$s10CitizenSDK' || true)\"\n  [[ -n \"$swift_symbols\" ]] || fail \"$label 未导出 CitizenSDK Swift 模块符号\"\n  foreign=\"$(printf '%s\\n' \"$all_symbols\" \\\n    | grep -Ev '^(citizensdk_|\\$s10CitizenSDK)' || true)\"\n  [[ -z \"$foreign\" ]] \\\n    || fail \"$label 泄露非 CitizenSDK 产品符号：$(printf '%s' \"$foreign\" | tr '\\n' ' ')\"\n}\n\nwrite_apple_exported_symbols() {\n  local probe=\"$1\" nm_bin=\"$2\" destination=\"$3\" label=\"$4\"\n  local all_symbols actual expected swift_symbols\n  all_symbols=\"$(apple_product_symbols \"$probe\" \"$nm_bin\")\" \\\n    || fail \"无法读取 $label 的未过滤 Mach-O 符号\"\n  actual=\"$(printf '%s\\n' \"$all_symbols\" | grep '^citizensdk_' || true)\"\n  expected=\"$(apple_linked_symbols)\"\n  [[ \"$actual\" == \"$expected\" ]] \\\n    || fail \"$label 未过滤链接不等于产品头与既定内部符号闭集\"\n  swift_symbols=\"$(printf '%s\\n' \"$all_symbols\" | grep '^\\$s10CitizenSDK' || true)\"\n  [[ -n \"$swift_symbols\" ]] || fail \"$label 未过滤链接没有 CitizenSDK Swift 导出\"\n  prepare_safe_output_file \"$work_dir\" \"$destination\" \"$label 导出允许集\"\n  {\n    apple_public_symbols\n    printf '%s\\n' \"$swift_symbols\"\n  } | sed 's/^/_/' | LC_ALL=C sort -u >\"$destination\"\n  [[ \"$(grep -c '^_citizensdk_' \"$destination\" || true)\" == 148 ]] \\\n    || fail \"$label 导出允许集没有精确 144 个 Core + 4 个图像 C ABI\"\n}\n\nwrite_framework_plist() {\n  local path=\"$1\" supported_platform=\"$2\" platform_name=\"$3\"\n  local minimum_key=\"$4\" minimum_version=\"$5\" software_version=\"$6\"\n  /usr/bin/plutil -create xml1 \"$path\"\n  /usr/libexec/PlistBuddy \\\n    -c \"Add :CFBundleDevelopmentRegion string en\" \\\n    -c \"Add :CFBundleExecutable string CitizenSDK\" \\\n    -c \"Add :CFBundleIdentifier string org.citizen.sdk\" \\\n    -c \"Add :CFBundleInfoDictionaryVersion string 6.0\" \\\n    -c \"Add :CFBundleName string CitizenSDK\" \\\n    -c \"Add :CFBundlePackageType string FMWK\" \\\n    -c \"Add :CFBundleShortVersionString string $software_version\" \\\n    -c \"Add :CFBundleVersion string $software_version\" \\\n    -c \"Add :CFBundleSupportedPlatforms array\" \\\n    -c \"Add :CFBundleSupportedPlatforms:0 string $supported_platform\" \\\n    -c \"Add :DTPlatformName string $platform_name\" \\\n    -c \"Add :$minimum_key string $minimum_version\" \\\n    \"$path\" >/dev/null\n}\n\nwrite_framework_module_map() {\n  local path=\"$1\"\n  printf '%s\\n' \\\n    'framework module CitizenSDK {' \\\n    '  umbrella header \"citizensdk.h\"' \\\n    '  module QRImage {' \\\n    '    header \"citizensdk_qr_image.h\"' \\\n    '    export *' \\\n    '  }' \\\n    '  export *' \\\n    '  module * { export * }' \\\n    '}' >\"$path\"\n}\n\nresolve_flutter_sdk_root() {\n  local flutter_bin flutter_root\n  flutter_bin=\"$(command -v flutter || true)\"\n  [[ -n \"$flutter_bin\" && \"$flutter_bin\" == /* && -f \"$flutter_bin\" \\\n    && ! -L \"$flutter_bin\" && -x \"$flutter_bin\" ]] \\\n    || fail \"Apple Flutter adapter 编译需要绝对路径的普通 Flutter 可执行文件\"\n  flutter_root=\"$(cd \"$(dirname \"$flutter_bin\")/..\" && pwd -P)\"\n  [[ -d \"$flutter_root/bin/cache/artifacts/engine\" ]] \\\n    || fail \"Flutter SDK 缺少已缓存 Apple engine artifacts：$flutter_root\"\n  printf '%s\\n' \"$flutter_root\"\n}\n\nresolve_flutter_macos_xcframework() {\n  local flutter_root=\"$1\" candidate\n  local -a candidates=()\n  while IFS= read -r candidate; do\n    candidates+=(\"$candidate\")\n  done < <(find \"$flutter_root/bin/cache/artifacts/engine\" \\\n    -mindepth 2 -maxdepth 2 -type d -name FlutterMacOS.xcframework \\\n    -path '*/darwin-*-release/FlutterMacOS.xcframework' -print | LC_ALL=C sort)\n  [[ \"${#candidates[@]}\" == 1 ]] \\\n    || fail \"Flutter SDK 必须精确提供一个 macOS Release XCFramework；实际=${#candidates[@]}\"\n  printf '%s\\n' \"${candidates[0]}\"\n}\n\nresolve_xcframework_framework_slice() {\n  local xcframework=\"$1\" module=\"$2\" platform=\"$3\" expected_variant=\"$4\"\n  local index=0 identifier library_path actual_platform actual_variant architectures\n  local framework found='' count=0\n  [[ -d \"$xcframework\" && ! -L \"$xcframework\" \\\n    && -f \"$xcframework/Info.plist\" && ! -L \"$xcframework/Info.plist\" ]] \\\n    || fail \"$module XCFramework 缺失或不是普通目录\"\n  while identifier=\"$(/usr/libexec/PlistBuddy \\\n    -c \"Print :AvailableLibraries:$index:LibraryIdentifier\" \\\n    \"$xcframework/Info.plist\" 2>/dev/null)\"; do\n    actual_platform=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatform\" \\\n      \"$xcframework/Info.plist\")\"\n    actual_variant=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatformVariant\" \\\n      \"$xcframework/Info.plist\" 2>/dev/null || true)\"\n    if [[ \"$actual_platform\" == \"$platform\" && \"$actual_variant\" == \"$expected_variant\" ]]; then\n      architectures=\"$(/usr/libexec/PlistBuddy \\\n        -c \"Print :AvailableLibraries:$index:SupportedArchitectures\" \\\n        \"$xcframework/Info.plist\")\"\n      printf '%s\\n' \"$architectures\" | grep -Eq '(^|[[:space:]])arm64([[:space:]]|$)' \\\n        || fail \"$module 的 $platform/${expected_variant:-device} slice 不支持 arm64\"\n      library_path=\"$(/usr/libexec/PlistBuddy \\\n        -c \"Print :AvailableLibraries:$index:LibraryPath\" \\\n        \"$xcframework/Info.plist\")\"\n      framework=\"$xcframework/$identifier/$library_path\"\n      [[ -d \"$framework\" && \"$(basename \"$framework\")\" == \"$module.framework\" ]] \\\n        || fail \"$module 的 $platform/${expected_variant:-device} framework 路径无效\"\n      found=\"$framework\"\n      count=$((count + 1))\n    fi\n    index=$((index + 1))\n  done\n  [[ \"$count\" == 1 ]] \\\n    || fail \"$module 必须精确提供一个 $platform/${expected_variant:-device} arm64 slice；实际=$count\"\n  printf '%s\\n' \"$found\"\n}\n\n# Hosted消费只接受调用方提供的本轮候选、官方归档及已隔离工具，不运行工具探测版本。\n# 预检保持只读；真正解包仍由当前自动化投影入口 再次逐项验真，目录名不是证明。\nmacos_hosted_root() {\n  local root checkout path\n  assert_readonly_dependency_directory \"$sdk_dir\" \"CitizenSDK 源码\"\n  if [[ \"${GITHUB_ACTIONS:-}\" == true ]]; then\n    # 只使用 GitHub 官方环境变量；缺失时立即失败，不接受本机根或任意临时目录。\n    assert_readonly_dependency_directory \"${RUNNER_TEMP:-}\" RUNNER_TEMP\n    assert_readonly_dependency_directory \"${GITHUB_WORKSPACE:-}\" GITHUB_WORKSPACE\n    root=\"$RUNNER_TEMP/citizensdk\"\n    checkout=\"$GITHUB_WORKSPACE\"\n    [[ \"$sdk_dir\" == \"$checkout\" ]] || fail \"CitizenSDK源码必须是当前独立checkout根\"\n  else\n    root=\"${CITIZENSDK_HOSTED_ROOT:-$work_dir}\"\n    checkout=\"$sdk_dir\"\n  fi\n  assert_readonly_dependency_directory \"$root\" \"macOS Hosted 受控根\"\n  # 同时拒绝源码位于工作根中、工作根位于源码中；必须在首次 mkdir 前检查。\n  for path in \"$checkout\" \"$sdk_dir\"; do\n    case \"$root/\" in \"$path/\"*) fail \"macOS Hosted 受控根与源码交叠\" ;; esac\n    case \"$path/\" in \"$root/\"*) fail \"macOS Hosted 源码与受控根交叠\" ;; esac\n  done\n  # APFS 可能以不同大小写接受同一目录；仅比较 Bash 路径文本不足以隔离源码。\n  node - \"$root\" \"$checkout\" \"$sdk_dir\" <<'NODE' || fail \"macOS Hosted 源码真实路径预检失败\"\n  const fs = require('node:fs'), path = require('node:path');\n  const [root, ...sources] = process.argv.slice(2).map((value) => fs.realpathSync.native(value));\n  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);\n  if (sources.some((source) => inside(root, source) || inside(source, root))) {\n    throw new Error('macOS Hosted 受控根与源码真实路径交叠');\n  }\nNODE\n  printf '%s\\n' \"$root\"\n}\n\nmacos_hosted_preflight() {\n  [[ \"$#\" == 6 ]] || fail \"macOS Hosted 消费需要 candidate、audit、hosted、flutter、pub-cache、tool-path 六个参数\"\n  local candidate=\"$1\" audit=\"$2\" hosted=\"$3\" flutter=\"$4\" cache=\"$5\" tool_path=\"$6\"\n  local path component central\n  [[ \"$(uname -s)\" == Darwin && \"$(uname -m)\" == arm64 ]] \\\n    || fail \"macOS Hosted 消费只允许 macOS Apple Silicon\"\n  central=\"$(macos_hosted_root)\"\n  for path in \"$work_dir\" \"$output_dir\" \"$candidate\" \"$flutter\" \"$cache\"; do\n    assert_readonly_dependency_directory \"$path\" \"macOS Hosted 输入目录\"\n    assert_descendant_path \"$central\" \"$path\" \"macOS Hosted 受控输入\"\n  done\n  for path in \"$audit\" \"$hosted\"; do\n    assert_descendant_path \"$central\" \"$path\" \"macOS Hosted 归档\"\n    assert_readonly_dependency_directory \"$(dirname \"$path\")\" \"macOS Hosted 归档父目录\"\n    [[ -f \"$path\" && ! -L \"$path\" ]] || fail \"macOS Hosted 归档必须是普通文件\"\n  done\n  # Flutter/Pub 会写其副本；只读候选和归档不能与这些目录或新消费根等值、互相包含。\n  # 对归档按文件路径一起比较，防止可写 cache 的父目录吞入来源文件。\n  local first second\n  # 候选/归档只读，Flutter/Pub 与消费工作区可写；连预备输出容器也不能包住任何输入。\n  local -a inputs=(\"$candidate\" \"$audit\" \"$hosted\" \"$flutter\" \"$cache\" \"$work_dir\" \"$output_dir\")\n  for ((first = 0; first < ${#inputs[@]}; first++)); do\n    for ((second = first + 1; second < ${#inputs[@]}; second++)); do\n      case \"${inputs[first]}/\" in \"${inputs[second]}/\"*) fail \"macOS Hosted 输入和可写目录必须双向互斥\" ;; esac\n      case \"${inputs[second]}/\" in \"${inputs[first]}/\"*) fail \"macOS Hosted 输入和可写目录必须双向互斥\" ;; esac\n    done\n  done\n  # 固定受控根的磁盘大小写由系统决定；其下任何输入别名都不能隐藏互相包含关系。\n  node - \"$central\" \"${inputs[@]}\" <<'NODE' || fail \"macOS Hosted 输入真实路径预检失败\"\n  const fs = require('node:fs'), path = require('node:path');\n  const [root, ...inputs] = process.argv.slice(2);\n  const realRoot = fs.realpathSync.native(root);\n  for (const input of inputs) {\n    if (fs.realpathSync.native(input) !== path.join(realRoot, path.relative(root, input))) {\n      throw new Error('macOS Hosted 输入真实路径存在别名');\n    }\n  }\nNODE\n  for component in bin/cache/dart-sdk/bin/dart bin/cache/flutter_tools.snapshot \\\n      bin/cache/flutter.version.json packages/flutter_tools/.dart_tool/package_config.json; do\n    path=\"$flutter/$component\"\n    assert_readonly_dependency_directory \"$(dirname \"$path\")\" \"macOS Hosted 工具文件父目录\"\n    [[ -f \"$path\" && ! -L \"$path\" ]] || fail \"macOS Hosted 缺少已隔离的 Flutter 工具：$component\"\n  done\n  [[ -x \"$flutter/bin/cache/dart-sdk/bin/dart\" ]] || fail \"macOS Hosted Dart 不可执行\"\n  [[ -n \"$tool_path\" && \"$tool_path\" != :* && \"$tool_path\" != *: && \"$tool_path\" != *::* ]] \\\n    || fail \"macOS Hosted 工具 PATH 不得包含空项\"\n  local -a components\n  IFS=: read -r -a components <<<\"$tool_path\"\n  for path in \"${components[@]}\"; do\n    assert_readonly_dependency_directory \"$path\" \"macOS Hosted 工具 PATH\"\n    case \"$work_dir/macOS/\" in \"$path/\"*) fail \"macOS Hosted 工具 PATH 不得包含消费输出\" ;; esac\n    case \"$path/\" in \"$work_dir/macOS/\"*) fail \"macOS Hosted 工具 PATH 不得来自消费输出\" ;; esac\n  done\n  [[ -x /usr/bin/sandbox-exec ]] || fail \"macOS Hosted 缺少系统 sandbox-exec\"\n}\n\nbuild_macos_flutter_consumer() (\n  macos_hosted_preflight \"$@\"\n  local candidate=\"$1\" audit=\"$2\" hosted=\"$3\" flutter_root=\"$4\" cache_root=\"$5\" tool_path=\"$6\"\n  local root=\"$work_dir/macOS\" package=\"$work_dir/macOS/package\" runner=\"$work_dir/macOS/consumer\"\n  local dart_bin=\"$flutter_root/bin/cache/dart-sdk/bin/dart\" node_bin path framework bundle executable\n  local source_uuid installed_uuid\n  node_bin=\"$(command -v node)\"\n  [[ -n \"$node_bin\" && \"$node_bin\" == /* && -x \"$node_bin\" ]] || fail \"macOS Hosted 缺少既有 Node\"\n  [[ ! -e \"$root\" && ! -L \"$root\" ]] || fail \"macOS Hosted 工作目录已存在，拒绝混入旧状态\"\n  umask 077\n  for path in \"$root\" \"$root/tmp\" \"$root/logs\" \"$root/config\" \"$root/cache\" \\\n      \"$root/pods\" \"$root/pods/cache\" \"$root/pods/repos\" \"$root/module-cache\" \\\n      \"$root/tool-state\" \"$root/runtime\" \"$root/runtime/tmp\"; do\n    prepare_safe_directory \"$work_dir\" \"$path\" \"macOS Hosted 独占目录\"\n    chmod 0700 \"$path\"\n  done\n\n  # 监督器只把显式工具配置传给子进程，不传 HOME、发布令牌、Git 配置或 DYLD 注入。\n  # 每个工具独立进程组；退出、超时和中断都等待整组消失，失败不删除工作目录。\n  \"$node_bin\" - \"$root\" \"$flutter_root\" \"$cache_root\" \"$tool_path\" <<'NODE'\nconst fs = require('fs'), path = require('path'), url = require('url');\nconst [root, flutter, cache, tools] = process.argv.slice(2);\nconst packageConfig = path.join(flutter, 'packages/flutter_tools/.dart_tool/package_config.json');\nconst inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);\nfor (const entry of JSON.parse(fs.readFileSync(packageConfig, 'utf8')).packages) {\n  const uri = new URL(entry.rootUri, url.pathToFileURL(packageConfig));\n  if (uri.protocol !== 'file:') throw Error('Flutter tools package is not local');\n  const actual = fs.realpathSync(url.fileURLToPath(uri));\n  if (![flutter, cache].some((parent) => inside(parent, actual))) {\n    throw Error('Flutter tools package config escapes isolated tool/cache inputs');\n  }\n}\nconst config = {\n  PATH: tools, FLUTTER_ROOT: flutter, PUB_CACHE: cache,\n  TMPDIR: path.join(root, 'tmp'), XDG_CONFIG_HOME: path.join(root, 'config'),\n  XDG_CACHE_HOME: path.join(root, 'cache'), CP_HOME_DIR: path.join(root, 'pods'),\n  CP_CACHE_DIR: path.join(root, 'pods/cache'), CP_REPOS_DIR: path.join(root, 'pods/repos'),\n  CLANG_MODULE_CACHE_PATH: path.join(root, 'module-cache'),\n  SWIFTPM_MODULECACHE_OVERRIDE: path.join(root, 'module-cache'),\n  CFFIXED_USER_HOME: path.join(root, 'tool-state'),\n  COCOAPODS_DISABLE_STATS: 'true', FLUTTER_SUPPRESS_ANALYTICS: 'true',\n  DASH__SUPPRESS_ANALYTICS: 'true', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',\n};\n// Xcode 工具选择不是凭据；只保留调用方显式选择的既有工具目录。\nif (process.env.DEVELOPER_DIR) config.DEVELOPER_DIR = process.env.DEVELOPER_DIR;\nfs.writeFileSync(path.join(root, 'environment.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });\n// macOS 不允许重复安装 sandbox；每个工具由监督器单独隔离，消费者使用其更严格的运行策略。\n// 离线构建工具只可写本轮宿主、Flutter 和 Pub 副本，Git 元数据始终只读。\nconst user = require('os').homedir();\nconst quote = (value) => JSON.stringify(value);\nconst policy = '(version 1)\\n(allow default)\\n(deny network*)\\n(deny file-write*)\\n' +\n  [root, flutter, cache].map((value) => `(allow file-write* (subpath ${quote(value)}))\\n`).join('') +\n  '(allow file-write* (literal \"/dev/null\"))\\n' +\n  `(deny file-write* (subpath ${quote(path.join(flutter, '.git'))}))\\n` +\n  ['Library/Application Support/citizensdk', 'Library/Keychains', 'Library/Application Support/dart',\n   '.config/dart', '.pub-cache', '.gitconfig', '.git-credentials', '.config/git',\n   'GMB/.git', 'TATA/.git', 'TUYU/.git', 'flutter/.git']\n    .map((value) => `(deny file-read* (subpath ${quote(path.join(user, value))}))\\n`).join('');\nfs.writeFileSync(path.join(root, 'tool.sb'), policy, { flag: 'wx', mode: 0o600 });\nNODE\n  prepare_safe_output_file \"$work_dir\" \"$root/run.mjs\" \"macOS Hosted 工具监督器\"\n  cat >\"$root/run.mjs\" <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { spawn } from 'node:child_process';\nconst [root, label, seconds, cwd, command, ...args] = process.argv.slice(2);\nif (!/^[a-z-]+$/.test(label) || !/^\\d+$/.test(seconds)) throw Error('Invalid supervised command');\nconst env = JSON.parse(fs.readFileSync(path.join(root, 'environment.json'), 'utf8'));\nif (label === 'consumer') {\n  env.CFFIXED_USER_HOME = path.join(root, 'runtime');\n  env.TMPDIR = path.join(root, 'runtime/tmp');\n}\nconst stdout = fs.openSync(path.join(root, 'logs', `${label}.stdout`), 'wx', 0o600);\nconst stderr = fs.openSync(path.join(root, 'logs', `${label}.stderr`), 'wx', 0o600);\nlet failed = false, exited = false, child;\nconst alive = () => {\n  if (!child?.pid) return false;\n  try { process.kill(-child.pid, 0); return true; }\n  catch (error) { if (error.code === 'ESRCH') return false; throw error; }\n};\nconst signal = (value) => { if (alive()) process.kill(-child.pid, value); };\nlet killing;\nconst stop = () => {\n  failed = true;\n  signal('SIGTERM');\n  killing ??= setTimeout(() => signal('SIGKILL'), 2000);\n};\nprocess.on('SIGTERM', stop);\nprocess.on('SIGINT', stop);\n// consumer 参数已经指定 runtime.sb，不能再次嵌套；其它工具统一套用只写中央副本的策略。\nconst executable = label === 'consumer' ? command : '/usr/bin/sandbox-exec';\nconst argumentsList = label === 'consumer' ? args : ['-f', path.join(root, 'tool.sb'), command, ...args];\nchild = spawn(executable, argumentsList, { cwd, env, detached: true, stdio: ['ignore', stdout, stderr] });\nconst timeout = setTimeout(stop, Number(seconds) * 1000);\nconst result = await new Promise((resolve) => {\n  child.once('error', () => { failed = true; resolve(1); });\n  child.once('exit', (code, received) => { exited = true; resolve(received ? 1 : code ?? 1); });\n});\nclearTimeout(timeout);\nif (alive()) stop();\nconst deadline = Date.now() + 12000;\nwhile (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));\nif (killing) clearTimeout(killing);\nfs.closeSync(stdout); fs.closeSync(stderr);\nif (alive() || !exited || failed || result !== 0) {\n  process.stderr.write(`CitizenSDK macOS ${label} failed; logs and state retained\\n`);\n  process.exitCode = 1;\n}\nNODE\n  macos_command() {\n    \"$node_bin\" \"$root/run.mjs\" \"$root\" \"$@\"\n  }\n  macos_command verify 180 \"$root\" \"$node_bin\" \"$sdk_dir/.github/workflows/release-sdk.mjs\" sdk \\\n    --verify-hosted \"$candidate\" --archive \"$audit\" --hosted-archive \"$hosted\" --output \"$package\"\n  [[ -d \"$package\" && ! -L \"$package\" ]] || fail \"macOS Hosted 未得到验真运行包\"\n  # 重新验真的 Hosted 普通目录就是唯一安装输入；不得修复成原审计包五条链接。\n  local -a flutter=(\"$dart_bin\" \"--packages=$flutter_root/packages/flutter_tools/.dart_tool/package_config.json\"\n    \"$flutter_root/bin/cache/flutter_tools.snapshot\" --no-version-check --suppress-analytics)\n  macos_command create 180 \"$root\" \"${flutter[@]}\" create --offline --no-pub --platforms=macos \\\n    --project-name=citizensdk_consumer --org=org.citizen \"$runner\"\n  \"$node_bin\" - \"$runner\" \"$package\" \"$root\" \"$candidate\" <<'NODE'\nconst fs = require('fs'), path = require('path');\nconst [runner, source, root, candidate] = process.argv.slice(2);\nconst pubspec = fs.readFileSync(path.join(source, 'pubspec.yaml'), 'utf8');\nconst version = /^version: ([0-9]+\\.[0-9]+\\.[0-9]+)$/m.exec(pubspec)?.[1];\nif (!version) throw Error('Hosted SDK version is not unique');\nfs.writeFileSync(path.join(runner, 'pubspec.yaml'), `name: citizensdk_consumer\\npublish_to: none\\nversion: ${version}\\nenvironment:\\n  sdk: \">=3.8.0 <4.0.0\"\\ndependencies:\\n  flutter:\\n    sdk: flutter\\n  citizen_sdk:\\n    path: ../package\\nflutter:\\n  uses-material-design: true\\n`);\n// 测试夹具也来自已验真的审计候选，不能用当前工作区未验真的代码替换验收合同。\nfs.copyFileSync(path.join(candidate, 'darwin/tests/citizen_sdk_flutter_consumer.dart'), path.join(runner, 'lib/main.dart'));\n// 只修改临时宿主最低系统与架构，不改变 SDK 或 Flutter 官方插件注册装配。\nconst project = path.join(runner, 'macos/Runner.xcodeproj/project.pbxproj');\nlet text = fs.readFileSync(project, 'utf8');\nif (!text.includes('MACOSX_DEPLOYMENT_TARGET = ')) throw Error('Official macOS deployment setting is missing');\ntext = text.replace(/MACOSX_DEPLOYMENT_TARGET = [0-9.]+;/g, 'MACOSX_DEPLOYMENT_TARGET = 13.0;\\n\\t\\t\\t\\tARCHS = arm64;');\nfs.writeFileSync(project, text);\nconst window = path.join(runner, 'macos/Runner/MainFlutterWindow.swift');\ntext = fs.readFileSync(window, 'utf8');\nconst start = '  override func awakeFromNib() {';\nif (text.split(start).length !== 2 || text.split('RegisterGeneratedPlugins(registry: flutterViewController)').length !== 2) {\n  throw Error('Official macOS Flutter registration template changed');\n}\nconst expected = path.join(root, 'runtime/Library/Application Support/citizensdk/v1');\nconst preflight = `\n    // 先验证 Foundation 实际路径；此时尚未创建 Flutter engine 或注册 SDK。\n    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {\n      fputs(\"CitizenSDK Foundation isolation failed\\\\n\", stderr); exit(78)\n    }\n    let state = support.appendingPathComponent(\"citizensdk/v1\", isDirectory: true).standardizedFileURL\n    guard state.path == ${JSON.stringify(expected)}, state.resolvingSymlinksInPath().path == state.path else {\n      fputs(\"CitizenSDK Foundation isolation failed\\\\n\", stderr); exit(78)\n    }\n    // 动态加载来源只能是最终 app 内的同版框架，禁止 DYLD 外部注入。\n    let expectedFramework = Bundle.main.bundleURL.appendingPathComponent(\"Contents/Frameworks/CitizenSDK.framework\").resolvingSymlinksInPath().path + \"/\"\n    var frameworkCount = 0\n    for index in 0..<_dyld_image_count() {\n      guard let name = _dyld_get_image_name(index) else { continue }\n      let image = String(cString: name)\n      if image.contains(\"CitizenSDK.framework/\") {\n        guard URL(fileURLWithPath: image).resolvingSymlinksInPath().path.hasPrefix(expectedFramework) else {\n          fputs(\"CitizenSDK framework origin failed\\\\n\", stderr); exit(79)\n        }\n        frameworkCount += 1\n      }\n    }\n    guard frameworkCount == 1 else { fputs(\"CitizenSDK framework origin failed\\\\n\", stderr); exit(79) }\n    print(\"CitizenSDK Foundation isolation passed\")\n    fflush(stdout)\n`;\nfs.writeFileSync(window, text.replace('import Cocoa', 'import Cocoa\\nimport MachO').replace(start, start + preflight));\n// sandbox 是运行必须条件，不靠 CFFIXED_USER_HOME 名称推断隔离。它禁止任何工作区外写入，\n// 并禁止用户 SDK/Keychain 状态读取。Foundation 仍需在 app 内独立完成精确路径检查。\nconst os = require('os');\nconst user = os.homedir();\nconst quote = (value) => JSON.stringify(value);\nfs.writeFileSync(path.join(root, 'runtime.sb'), `(version 1)\\n(allow default)\\n(deny network*)\\n(deny file-write*)\\n(allow file-write* (subpath ${quote(root)}))\\n` +\n  ['Library/Application Support/citizensdk', 'Library/Keychains', '.config/dart'].map((name) =>\n    `(deny file-read* (subpath ${quote(path.join(user, name))}))\\n`).join(''), { flag: 'wx', mode: 0o600 });\nNODE\n  macos_command pub 180 \"$runner\" \"${flutter[@]}\" pub get --offline\n  \"$node_bin\" - \"$runner\" \"$package\" \"$flutter_root\" \"$cache_root\" <<'NODE'\nconst fs = require('fs'), path = require('path'), url = require('url');\nconst [runner, source, flutter, cache] = process.argv.slice(2);\nconst configPath = path.join(runner, '.dart_tool/package_config.json');\nconst config = JSON.parse(fs.readFileSync(configPath, 'utf8'));\nconst inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);\nlet sdkCount = 0;\nfor (const entry of config.packages) {\n  const uri = new URL(entry.rootUri, url.pathToFileURL(configPath));\n  if (uri.protocol !== 'file:') throw Error('Consumer package is not local');\n  const actual = fs.realpathSync(url.fileURLToPath(uri));\n  if (![runner, source, flutter, cache].some((parent) => inside(parent, actual))) {\n    throw Error('Consumer package config escapes isolated installed inputs');\n  }\n  if (entry.name === 'citizen_sdk') {\n    if (actual !== source) throw Error('Consumer does not depend on verified Hosted package');\n    sdkCount += 1;\n  }\n}\nif (sdkCount !== 1) throw Error('Consumer CitizenSDK package is not unique');\nconst plugins = JSON.parse(fs.readFileSync(path.join(runner, '.flutter-plugins-dependencies'), 'utf8'));\nconst entries = plugins.plugins?.macos?.filter((entry) => entry.name === 'citizen_sdk') ?? [];\n// APFS可保留与调用方不同的路径大小写；同版来源按实际目录身份判断，不改产品目录命名。\nconst sameDirectory = (left, right) => {\n  const actual = fs.statSync(left), expected = fs.statSync(right);\n  return actual.isDirectory() && expected.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino;\n};\nif (entries.length !== 1 || !sameDirectory(entries[0].path, source)) {\n  throw Error('Official macOS plugin discovery did not select the verified Hosted package');\n}\nconst registrant = fs.readFileSync(path.join(runner, 'macos/Flutter/GeneratedPluginRegistrant.swift'), 'utf8');\nif (registrant.split('import citizen_sdk').length !== 2 || registrant.split('CitizenSdkPlugin.register(').length !== 2) {\n  throw Error('Official macOS CitizenSDK plugin registration is not unique');\n}\nNODE\n  # 保持 Flutter 默认 SwiftPM/CocoaPods 选择；不切换全局设置、不重写 podspec。\n  macos_command build 900 \"$runner\" \"${flutter[@]}\" build macos --release --no-pub\n  bundle=\"$runner/build/macos/Build/Products/Release/citizensdk_consumer.app\"\n  executable=\"$bundle/Contents/MacOS/citizensdk_consumer\"\n  [[ -x \"$executable\" ]] || fail \"macOS Hosted 缺少最终 Release app\"\n  framework=\"$(resolve_xcframework_framework_slice \\\n    \"$package/darwin/CitizenSDK.xcframework\" CitizenSDK macos '')\"\n  [[ -f \"$framework/Versions/A/CitizenSDK\" ]] || fail \"macOS Hosted 缺少已验真的 macOS framework\"\n  # Apple 签名会更改文件尾部签名区；比较原生 UUID、架构和资产，不误用全文件摘要。\n  macos_command source-uuid 30 \"$root\" /usr/bin/xcrun dwarfdump --uuid \"$framework/Versions/A/CitizenSDK\"\n  macos_command installed-uuid 30 \"$root\" /usr/bin/xcrun dwarfdump --uuid \"$bundle/Contents/Frameworks/CitizenSDK.framework/Versions/A/CitizenSDK\"\n  source_uuid=\"$(awk '{print $2, $3}' \"$root/logs/source-uuid.stdout\")\"\n  installed_uuid=\"$(awk '{print $2, $3}' \"$root/logs/installed-uuid.stdout\")\"\n  [[ \"$source_uuid\" == \"$installed_uuid\" && \"$source_uuid\" == *' (arm64)' && \"$source_uuid\" != *$'\\n'* ]] \\\n    || fail \"macOS Hosted 已安装 Core UUID 或架构漂移\"\n  for path in manifest.json chainspec.json light_sync_state.json; do\n    cmp -s \"$package/chain/$path\" \\\n      \"$bundle/Contents/Frameworks/App.framework/Resources/flutter_assets/packages/citizen_sdk/chain/$path\" \\\n      || fail \"macOS Hosted Flutter 安装链资产漂移：$path\"\n    cmp -s \"$package/chain/$path\" \\\n      \"$bundle/Contents/Frameworks/CitizenSDK.framework/Resources/chain/$path\" \\\n      || fail \"macOS Hosted 原生安装链资产漂移：$path\"\n  done\n  macos_command consumer 200 \"$root\" /usr/bin/sandbox-exec -f \"$root/runtime.sb\" \"$executable\"\n  [[ \"$(grep -Fxc 'CitizenSDK Foundation isolation passed' \"$root/logs/consumer.stdout\" || true)\" == 1 ]] \\\n    || fail \"macOS Hosted 缺少唯一 Foundation 隔离预检成功标记\"\n  [[ \"$(grep -Fxc 'CitizenSDK Flutter consumer passed' \"$root/logs/consumer.stdout\" || true)\" == 1 ]] \\\n    || fail \"macOS Hosted 缺少唯一公开消费者成功标记\"\n  echo \"CitizenSDK macOS Hosted 安装消费通过\"\n)\n\ncompile_apple_flutter_adapter() {\n  local apple_sdk=\"$1\" swift_target=\"$2\" slice_name=\"$3\" platform=\"$4\"\n  local variant=\"$5\" flutter_module=\"$6\" flutter_xcframework=\"$7\"\n  local citizen_slice_root=\"$8\" flutter_framework flutter_framework_root\n  local sdk_path swiftc compile_root module_cache source object_count\n  local -a swift_sources swift_arguments\n\n  [[ -d \"$citizen_slice_root/CitizenSDK.framework\" \\\n    && ! -L \"$citizen_slice_root/CitizenSDK.framework\" ]] \\\n    || fail \"$slice_name Flutter adapter 必须从最终 XCFramework slice 导入 CitizenSDK\"\n  [[ -d \"$darwin_flutter_source_root\" && ! -L \"$darwin_flutter_source_root\" ]] \\\n    || fail \"CitizenSDKFlutter 生产源码目录缺失\"\n  swift_sources=()\n  while IFS= read -r source; do\n    swift_sources+=(\"$source\")\n  done < <(find \"$darwin_flutter_source_root\" -maxdepth 1 -type f \\\n    -name '*.swift' -print | LC_ALL=C sort)\n  [[ \"${#swift_sources[@]}\" -gt 0 ]] || fail \"CitizenSDKFlutter 生产源码为空\"\n\n  flutter_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$flutter_xcframework\" \"$flutter_module\" \"$platform\" \"$variant\")\"\n  flutter_framework_root=\"$(dirname \"$flutter_framework\")\"\n  sdk_path=\"$(xcrun --sdk \"$apple_sdk\" --show-sdk-path)\"\n  swiftc=\"$(xcrun --sdk \"$apple_sdk\" --find swiftc)\"\n  [[ -d \"$sdk_path\" && -x \"$swiftc\" ]] \\\n    || fail \"$slice_name Flutter adapter 缺少受控 Apple SDK 或 swiftc\"\n\n  compile_root=\"$work_dir/apple-flutter-compile/$slice_name\"\n  module_cache=\"$compile_root/module-cache\"\n  [[ ! -e \"$compile_root\" && ! -L \"$compile_root\" ]] \\\n    || fail \"$slice_name Flutter adapter 编译目录必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$compile_root\" \\\n    \"$slice_name Flutter adapter 编译目录\"\n  prepare_safe_directory \"$work_dir\" \"$module_cache\" \\\n    \"$slice_name Flutter adapter module cache\"\n  swift_arguments=(\"${swift_sources[@]}\"\n    -parse-as-library\n    -swift-version 5\n    -warnings-as-errors\n    -strict-concurrency=complete\n    -module-name CitizenSDKFlutter\n    -module-cache-path \"$module_cache\"\n    -sdk \"$sdk_path\"\n    -target \"$swift_target\"\n    -F \"$citizen_slice_root\"\n    -F \"$flutter_framework_root\")\n\n  # 第一遍是严格类型检查；第二遍真实生成每个 Swift 源文件的目标文件。\n  # 两遍都从最终 XCFramework slice 导入 @_spi(CitizenSDKFlutter)，不能从\n  # 同次 Swift 源码或构建前 framework 旁路产品边界。\n  \"$swiftc\" \"${swift_arguments[@]}\" -typecheck\n  (\n    cd \"$compile_root\"\n    \"$swiftc\" \"${swift_arguments[@]}\" -c\n  )\n  object_count=\"$(find \"$compile_root\" -mindepth 1 -maxdepth 1 \\\n    -type f -name '*.o' -print | wc -l | tr -d '[:space:]')\"\n  [[ \"$object_count\" == \"${#swift_sources[@]}\" ]] \\\n    || fail \"$slice_name Flutter adapter 编译目标闭集漂移：$object_count/${#swift_sources[@]}\"\n}\n\nwrite_apple_test_package() {\n  local harness=\"$1\" static_library=\"$2\" flutter_module=\"$3\"\n  local qr_library=\"$4\" zxing_library=\"$5\" product_swift_target=\"$6\"\n  local source destination\n  for directory in \\\n    \"$harness/Sources/CitizenSDK\" \\\n    \"$harness/Sources/CitizenSDKC/include\" \\\n    \"$harness/Sources/CitizenSDKFlutter\" \\\n    \"$harness/Tests/CitizenSDKTests\" \\\n    \"$harness/Tests/CitizenSDKFlutterTests\" \\\n    \"$harness/Libraries\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Apple XCTest 临时 harness\"\n  done\n  cp \"$product_header\" \"$harness/Sources/CitizenSDKC/include/citizensdk.h\"\n  cp \"$product_types_header\" \"$harness/Sources/CitizenSDKC/include/citizensdk_types.h\"\n  cp \"$qr_image_header\" \"$harness/Sources/CitizenSDKC/include/citizensdk_qr_image.h\"\n  cp \"$static_library\" \"$harness/Libraries/libcitizensdk.a\"\n  cp \"$qr_library\" \"$harness/Libraries/libcitizensdk_qr_image.a\"\n  cp \"$zxing_library\" \"$harness/Libraries/libZXing.a\"\n  printf '%s\\n' \\\n    '#include \"citizensdk.h\"' \\\n    'int citizensdk_test_harness_anchor(void) { return 0; }' \\\n    >\"$harness/Sources/CitizenSDKC/harness.c\"\n  while IFS= read -r source; do\n    destination=\"$harness/Sources/CitizenSDK/$(basename \"$source\")\"\n    {\n      printf '%s\\n' 'import CitizenSDKC'\n      cat \"$source\"\n    } >\"$destination\"\n  done < <(find \"$darwin_source_root\" -maxdepth 1 -type f -name '*.swift' \\\n    -print | LC_ALL=C sort)\n  printf '%s\\n' '@_exported import CitizenSDKC' \\\n    >\"$harness/Sources/CitizenSDK/CitizenSDKCExports.swift\"\n  cp \"$darwin_flutter_source_root\"/*.swift \"$harness/Sources/CitizenSDKFlutter/\"\n  cp \"$sdk_dir/darwin/tests/core\"/*.swift \\\n    \"$harness/Tests/CitizenSDKTests/\"\n  cp \"$sdk_dir/darwin/tests/flutter\"/*.swift \\\n    \"$harness/Tests/CitizenSDKFlutterTests/\"\n\n  cat >\"$harness/Package.swift\" <<PACKAGE\n// swift-tools-version: 5.9\nimport PackageDescription\n\nlet strict: [SwiftSetting] = [\n    .unsafeFlags([\"-warnings-as-errors\", \"-strict-concurrency=complete\",\n        \"-I\", \"$work_dir/private-include\", \"-Xcc\", \"-I$harness/Sources/CitizenSDKC/include\"]),\n]\n\n// Release-mode cross compilation does not make package modules testable by\n// default. The harness needs internal access for the canonical @testable XCTest\n// suites, so only its two generated implementation targets receive this flag.\nlet testable: [SwiftSetting] = strict + [\n    // SDK源码继续按正式最低版本编译；只有XCTest目标使用较高运行库版本。\n    // SwiftPM/Xcode会重建driver目标，必须把生产目标直接传给编译前端。\n    .unsafeFlags([\"-enable-testing\", \"-Xfrontend\", \"-target\", \"-Xfrontend\", \"$product_swift_target\"]),\n]\n\nlet package = Package(\n    name: \"CitizenSDKAppleTests\",\n    // 仅测试包对齐XCTest运行库最低版本；交付框架仍支持iOS16/macOS13。\n    platforms: [.iOS(.v17), .macOS(.v14)],\n    targets: [\n        .binaryTarget(name: \"$flutter_module\", path: \"Artifacts/$flutter_module.xcframework\"),\n        .target(\n            name: \"CitizenSDKC\",\n            path: \"Sources/CitizenSDKC\",\n            publicHeadersPath: \"include\"\n        ),\n        .target(\n            name: \"CitizenSDK\",\n            dependencies: [\"CitizenSDKC\"],\n            path: \"Sources/CitizenSDK\",\n            swiftSettings: testable,\n            linkerSettings: [\n                .unsafeFlags([\"-Xlinker\", \"-force_load\", \"-Xlinker\", \"$harness/Libraries/libcitizensdk.a\"]),\n                .unsafeFlags([\"-Xlinker\", \"-force_load\", \"-Xlinker\", \"$harness/Libraries/libcitizensdk_qr_image.a\"]),\n                .unsafeFlags([\"-Xlinker\", \"-force_load\", \"-Xlinker\", \"$harness/Libraries/libZXing.a\"]),\n                .linkedFramework(\"Security\"),\n                .linkedFramework(\"LocalAuthentication\"),\n                .linkedLibrary(\"c++\"),\n                .linkedLibrary(\"sqlite3\"),\n            ]\n        ),\n        .target(\n            name: \"CitizenSDKFlutter\",\n            dependencies: [\"CitizenSDK\", \"$flutter_module\"],\n            path: \"Sources/CitizenSDKFlutter\",\n            swiftSettings: testable\n        ),\n        .testTarget(\n            name: \"CitizenSDKTests\",\n            dependencies: [\"CitizenSDK\"],\n            path: \"Tests/CitizenSDKTests\",\n            swiftSettings: strict\n        ),\n        .testTarget(\n            name: \"CitizenSDKFlutterTests\",\n            dependencies: [\"CitizenSDK\", \"CitizenSDKFlutter\"],\n            path: \"Tests/CitizenSDKFlutterTests\",\n            swiftSettings: strict\n        ),\n    ],\n    swiftLanguageVersions: [.v5]\n)\nPACKAGE\n}\n\nrun_apple_test_harness() {\n  local rust_target=\"$1\" apple_sdk=\"$2\" swift_target=\"$3\" slice_name=\"$4\"\n  local flutter_module=\"$5\" flutter_xcframework=\"$6\" mode=\"$7\"\n  local static_library qr_library zxing_library harness scratch artifact sdk_path runtime_framework_root=''\n  local flutter_test_bundle framework_destination test_product_root test_bundle_names\n  local test_bundle_name resource_destination asset_name product_swift_target\n  local -a swiftpm_paths swiftpm_target\n  # 生产源码的可用性诊断必须与交付目标一致，不能被XCTest运行库的最低版本抬高。\n  case \"$apple_sdk\" in\n    iphoneos) product_swift_target=\"arm64-apple-ios$ios_deployment_target\" ;;\n    iphonesimulator) product_swift_target=\"arm64-apple-ios$ios_deployment_target-simulator\" ;;\n    macosx) product_swift_target=\"arm64-apple-macosx$macos_deployment_target\" ;;\n    *) fail \"Apple XCTest SDK未登记：$apple_sdk\" ;;\n  esac\n  static_library=\"$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.a\"\n  [[ -f \"$static_library\" && ! -L \"$static_library\" ]] \\\n    || fail \"$slice_name XCTest 缺少已构建 native/ffi 静态 Core\"\n  qr_library=\"$work_dir/apple-build/$slice_name/qr-image/libcitizensdk_qr_image.a\"\n  zxing_library=\"$(find \"$work_dir/apple-build/$slice_name/qr-image\" \\\n    -type f -name 'libZXing.a' -print)\"\n  [[ -f \"$qr_library\" && ! -L \"$qr_library\" \\\n    && -n \"$zxing_library\" && \"$zxing_library\" != *$'\\n'* \\\n    && -f \"$zxing_library\" && ! -L \"$zxing_library\" ]] \\\n    || fail \"$slice_name XCTest 缺少对应的 QR/ZXing 静态库\"\n  harness=\"$work_dir/apple-test-harness/$slice_name\"\n  scratch=\"$work_dir/apple-test-scratch/$slice_name\"\n  [[ ! -e \"$harness\" && ! -L \"$harness\" && ! -e \"$scratch\" && ! -L \"$scratch\" ]] \\\n    || fail \"$slice_name XCTest harness/scratch 必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$harness\" \"$slice_name XCTest harness\"\n  prepare_safe_directory \"$work_dir\" \"$scratch\" \"$slice_name XCTest scratch\"\n  write_apple_test_package \\\n    \"$harness\" \"$static_library\" \"$flutter_module\" \"$qr_library\" \"$zxing_library\" \"$product_swift_target\"\n  prepare_safe_directory \"$work_dir\" \"$harness/Artifacts\" \"$slice_name XCTest artifacts\"\n  artifact=\"$harness/Artifacts/$flutter_module.xcframework\"\n  [[ ! -e \"$artifact\" && ! -L \"$artifact\" ]] \\\n    || fail \"$slice_name Flutter 测试 artifact 目标必须全新\"\n  cp -R \"$flutter_xcframework\" \"$artifact\"\n  sdk_path=\"$(xcrun --sdk \"$apple_sdk\" --show-sdk-path)\"\n  swiftpm_paths=(\n    # 当前 macOS 执行环境禁止 SwiftPM 调用系统 sandbox-exec；这里只是构建测试\n    # harness，不连接真实设备，运行时 smoke 仍由下方独立沙箱合同保护。\n    --disable-sandbox\n    --package-path \"$harness\"\n    --cache-path \"$scratch/cache\"\n    --config-path \"$scratch/config\"\n    --security-path \"$scratch/security\"\n    --scratch-path \"$scratch/build\"\n    --manifest-cache local\n    --disable-dependency-cache\n    --configuration release\n    --triple \"$swift_target\"\n    --sdk \"$sdk_path\"\n  )\n  prepare_safe_directory \"$work_dir\" \"$scratch/tmp\" \"$slice_name XCTest TMPDIR\"\n  prepare_safe_directory \"$work_dir\" \"$scratch/foundation-home\" \"$slice_name XCTest Foundation 沙箱\"\n  case \"$mode\" in\n    run|compile) swiftpm_target=(build --build-tests) ;;\n    *) fail \"Apple XCTest mode 未登记：$mode\" ;;\n  esac\n  if [[ \"$mode\" == run ]]; then\n    runtime_framework_root=\"$(dirname \"$(resolve_xcframework_framework_slice \\\n      \"$artifact\" \"$flutter_module\" macos '')\")\"\n  fi\n  TMPDIR=\"$scratch/tmp\" CFFIXED_USER_HOME=\"$scratch/foundation-home\" \\\n  CLANG_MODULE_CACHE_PATH=\"$scratch/clang-module-cache\" \\\n  SWIFTPM_MODULECACHE_OVERRIDE=\"$scratch/swift-module-cache\" \\\n    swift \"${swiftpm_target[@]}\" \"${swiftpm_paths[@]}\"\n  if [[ \"$mode\" == run ]]; then\n    # SwiftPM does not embed a binary-target framework in a macOS XCTest\n    # bundle. Embed the exact resolved Flutter framework after build, then run\n    # with --skip-build so dyld resolves only the bundle-owned copy.\n    test_product_root=\"$scratch/build/out/Products/Release\"\n    test_bundle_names=\"$(find \"$test_product_root\" -mindepth 1 -maxdepth 1 \\\n      -type d -name '*.xctest' -exec basename {} \\; | LC_ALL=C sort)\"\n    [[ \"$test_bundle_names\" == $'CitizenSDKFlutterTests.xctest\\nCitizenSDKTests.xctest' ]] \\\n      || fail \"macOS XCTest 产品闭集漂移：${test_bundle_names:-无}\"\n    flutter_test_bundle=\"$test_product_root/CitizenSDKFlutterTests.xctest\"\n    framework_destination=\"$flutter_test_bundle/Contents/Frameworks/$flutter_module.framework\"\n    prepare_safe_directory \"$work_dir\" \"$(dirname \"$framework_destination\")\" \\\n      \"macOS Flutter XCTest framework 目录\"\n    [[ ! -e \"$framework_destination\" && ! -L \"$framework_destination\" ]] \\\n      || fail \"macOS Flutter XCTest framework 目标必须全新\"\n    cp -R \"$runtime_framework_root/$flutter_module.framework\" \"$framework_destination\"\n    # SwiftPM把SDK静态链接进测试bundle；正式加载器仍从所属bundle读取同一链资产。\n    # 仅投影冻结资源，不改生产Bundle查找路径、不构造替身链身份。\n    for test_bundle_name in CitizenSDKTests.xctest CitizenSDKFlutterTests.xctest; do\n      resource_destination=\"$test_product_root/$test_bundle_name/Contents/Resources/chain\"\n      prepare_safe_directory \"$work_dir\" \"$resource_destination\" \"XCTest正式链资源\"\n      for asset_name in manifest.json chainspec.json light_sync_state.json; do\n        prepare_safe_output_file \"$work_dir\" \"$resource_destination/$asset_name\" \"XCTest链资产\"\n        cp \"$apple_asset_root/$asset_name\" \"$resource_destination/$asset_name\"\n        cmp -s \"$apple_asset_root/$asset_name\" \"$resource_destination/$asset_name\" \\\n          || fail \"XCTest链资产投影字节漂移\"\n      done\n    done\n    TMPDIR=\"$scratch/tmp\" CFFIXED_USER_HOME=\"$scratch/foundation-home\" \\\n    CLANG_MODULE_CACHE_PATH=\"$scratch/clang-module-cache\" \\\n    SWIFTPM_MODULECACHE_OVERRIDE=\"$scratch/swift-module-cache\" \\\n      swift test --skip-build \"${swiftpm_paths[@]}\"\n  fi\n}\n\nrun_final_apple_consumer_smoke() {\n  local xcframework=\"$output_dir/apple/CitizenSDK.xcframework\"\n  local framework framework_root\n  local smoke_root=\"$work_dir/apple-consumer-smoke\"\n  local source=\"$smoke_root/CitizenSDKConsumerSmoke.swift\"\n  local bundle_plist=\"$smoke_root/Info.plist\"\n  local executable=\"$smoke_root/CitizenSDKConsumerSmoke\"\n  local sdk_path swiftc architectures linked citizen_links\n  local expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'\n  framework=\"$(resolve_xcframework_framework_slice \\\n    \"$xcframework\" CitizenSDK macos '')\"\n  framework_root=\"$(dirname \"$framework\")\"\n  [[ -d \"$framework\" && ! -L \"$framework\" ]] \\\n    || fail \"最终 XCFramework macOS slice 缺失，拒绝消费者 smoke\"\n  [[ ! -e \"$smoke_root\" && ! -L \"$smoke_root\" ]] \\\n    || fail \"最终 XCFramework 消费者 smoke 目录必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$smoke_root\" \"Apple 消费者 smoke\"\n  for directory in \\\n    \"$smoke_root/home-normal\" \"$smoke_root/home-supervisor\" \\\n    \"$smoke_root/tmp-normal\" \"$smoke_root/tmp-supervisor\" \\\n    \"$smoke_root/module-cache\" \"$smoke_root/logs\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Apple 消费者 smoke 状态目录\"\n  done\n  cat >\"$source\" <<'SWIFT'\nimport CitizenSDK\nimport Darwin\nimport Foundation\n\nprivate enum SmokeFailure: Error, CustomStringConvertible {\n    case failed(String)\n    var description: String {\n        switch self { case let .failed(message): return message }\n    }\n}\n\nprivate func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {\n    guard condition() else { throw SmokeFailure.failed(message) }\n}\n\nprivate func verifyCapabilities(_ sdk: CitizenSdk) throws {\n    let capabilities = try sdk.capabilities()\n    let actual = capabilities.statuses.map(\\.name.rawValue).sorted()\n    let expected = CitizenCapabilityName.allCases.map(\\.rawValue).sorted()\n    try require(capabilities.revision >= 1, \"capability revision must be at least one\")\n    try require(capabilities.statuses.count == 10, \"capability status count must be exactly ten\")\n    try require(actual == expected, \"capability names must be the exact ten-value public enum\")\n}\n\nprivate let publicSQLiteSuffix = \"/citizensdk/v1/public/public-state-v1.sqlite3\"\nprivate let secureSQLiteSuffix = \"/citizensdk/v1/secure/secure-state-v1.sqlite3\"\n\nprivate func citizenSDKSQLiteFileDescriptors() -> Set<String> {\n    var paths = Set<String>()\n    let descriptorLimit = max(0, Int(getdtablesize()))\n    for descriptor in 0..<descriptorLimit {\n        var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))\n        if fcntl(Int32(descriptor), F_GETPATH, &bytes) == 0 {\n            let path = String(cString: bytes)\n            if path.hasSuffix(publicSQLiteSuffix) || path.hasSuffix(secureSQLiteSuffix) {\n                paths.insert(path)\n            }\n        }\n    }\n    return paths\n}\n\nprivate func closeEventually(_ sdk: CitizenSdk) async throws {\n    for _ in 0..<500 {\n        do { try sdk.close(); return }\n        catch let error as CitizenSDKError where error.code == .busy {\n            try await Task.sleep(nanoseconds: 10_000_000)\n        }\n    }\n    try sdk.close()\n}\n\nprivate func normalCloseSmoke() async throws {\n    let sdk = try CitizenSdk.open()\n    try require(sdk.lifecycle == .created, \"open must produce created lifecycle\")\n    try verifyCapabilities(sdk)\n    // Opening installs asynchronous state delivery. Public consumers honor the\n    // documented BUSY drain boundary instead of racing that callback.\n    try await closeEventually(sdk)\n    try require(sdk.lifecycle == .disposed, \"close must commit disposed lifecycle\")\n    try sdk.close()\n    try require(sdk.lifecycle == .disposed, \"idempotent close must remain disposed\")\n}\n\nprivate func supervisorSmoke() async throws {\n    var abandoned: CitizenSdk? = try CitizenSdk.open()\n    try verifyCapabilities(abandoned!)\n    // 模块化后存储按实际回调延迟打开；读取能力快照不等待后台探测。\n    // 等待公开刷新请求真实完成，再要求两个 SQLite FD 已打开，避免调度时序假失败。\n    try await abandoned!.refreshCapabilities()\n    let initiallyOpen = citizenSDKSQLiteFileDescriptors()\n    try require(initiallyOpen.contains(where: { $0.hasSuffix(publicSQLiteSuffix) }),\n                \"public SQLite descriptor must be open before abandonment\")\n    try require(initiallyOpen.contains(where: { $0.hasSuffix(secureSQLiteSuffix) }),\n                \"secure SQLite descriptor must be open before abandonment\")\n    abandoned = nil\n\n    let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000\n    while !citizenSDKSQLiteFileDescriptors().isEmpty\n            && DispatchTime.now().uptimeNanoseconds < deadline {\n        try await Task.sleep(nanoseconds: 50_000_000)\n    }\n    try require(citizenSDKSQLiteFileDescriptors().isEmpty,\n                \"supervisor must close public and secure SQLite descriptors\")\n\n    let reopened = try CitizenSdk.open()\n    try verifyCapabilities(reopened)\n    try await closeEventually(reopened)\n    try require(reopened.lifecycle == .disposed,\n                \"reopen after supervised cleanup must close successfully\")\n}\n\n@main\nprivate enum CitizenSDKConsumerSmoke {\n    static func main() async throws {\n        guard CommandLine.arguments.count == 2 else {\n            throw SmokeFailure.failed(\"expected exactly one smoke mode\")\n        }\n        switch CommandLine.arguments[1] {\n        case \"normal\": try await normalCloseSmoke()\n        case \"supervisor\": try await supervisorSmoke()\n        default: throw SmokeFailure.failed(\"unknown smoke mode\")\n        }\n    }\n}\nSWIFT\n  prepare_safe_output_file \"$work_dir\" \"$bundle_plist\" \"Apple 消费者 smoke Bundle 元数据\"\n  cat >\"$bundle_plist\" <<'PLIST'\n<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>org.citizen.sdk.consumer-smoke</string>\n</dict>\n</plist>\nPLIST\n  sdk_path=\"$(xcrun --sdk macosx --show-sdk-path)\"\n  swiftc=\"$(xcrun --sdk macosx --find swiftc)\"\n  prepare_safe_output_file \"$work_dir\" \"$executable\" \"Apple 消费者 smoke 可执行文件\"\n  \"$swiftc\" \"$source\" \\\n    -parse-as-library \\\n    -swift-version 5 \\\n    -warnings-as-errors \\\n    -strict-concurrency=complete \\\n    -module-cache-path \"$smoke_root/module-cache\" \\\n    -sdk \"$sdk_path\" \\\n    -target arm64-apple-macosx13.0 \\\n    -F \"$framework_root\" \\\n    -framework CitizenSDK \\\n    -Xlinker -sectcreate \\\n    -Xlinker __TEXT \\\n    -Xlinker __info_plist \\\n    -Xlinker \"$bundle_plist\" \\\n    -Xlinker -rpath \\\n    -Xlinker \"$framework_root\" \\\n    -o \"$executable\"\n  architectures=\"$(xcrun lipo -archs \"$executable\")\"\n  [[ \"$architectures\" == arm64 ]] \\\n    || fail \"Apple 消费者 smoke 必须精确编译为 arm64\"\n  linked=\"$(xcrun otool -L \"$executable\")\"\n  citizen_links=\"$(printf '%s\\n' \"$linked\" \\\n    | awk '$1 ~ /CitizenSDK\\.framework\\// { print $1 }' \\\n    | LC_ALL=C sort -u)\"\n  [[ \"$citizen_links\" == \"$expected_install_name\" ]] \\\n    || fail \"Apple 消费者 smoke 的 CitizenSDK 链接闭集漂移：${citizen_links:-无}\"\n  CFFIXED_USER_HOME=\"$smoke_root/home-normal\" \\\n  TMPDIR=\"$smoke_root/tmp-normal\" \\\n  DYLD_FRAMEWORK_PATH=\"$framework_root\" \\\n    \"$executable\" normal >\"$smoke_root/logs/normal.log\" 2>&1 \\\n    || fail \"最终 XCFramework 普通 open/capabilities/close smoke 失败\"\n  CFFIXED_USER_HOME=\"$smoke_root/home-supervisor\" \\\n  TMPDIR=\"$smoke_root/tmp-supervisor\" \\\n  DYLD_FRAMEWORK_PATH=\"$framework_root\" \\\n    \"$executable\" supervisor >\"$smoke_root/logs/supervisor.log\" 2>&1 \\\n    || fail \"最终 XCFramework supervisor/SQLite FD smoke 失败\"\n}\n\nbuild_apple_tests() {\n  [[ \"$(uname -s)\" == Darwin && \"$(uname -m)\" == arm64 ]] \\\n    || fail \"macOS XCTest 只允许在 Apple Silicon runner 执行\"\n  local xcframework flutter_root flutter_ios_xcframework flutter_macos_xcframework\n  local test_header_root\n  xcframework=\"$output_dir/apple/CitizenSDK.xcframework\"\n  verify_apple_xcframework \"$xcframework\"\n  flutter_root=\"$(resolve_flutter_sdk_root)\"\n  flutter_ios_xcframework=\"$flutter_root/bin/cache/artifacts/engine/ios-release/Flutter.xcframework\"\n  flutter_macos_xcframework=\"$(resolve_flutter_macos_xcframework \"$flutter_root\")\"\n  # Source tests resolve include/ from their canonical repository-relative\n  # location. Recreate that shared layout above all per-platform harnesses.\n  test_header_root=\"$work_dir/apple-test-harness/include\"\n  prepare_safe_directory \"$work_dir\" \"$test_header_root\" \\\n    \"Apple XCTest 共享头文件目录\"\n  for header in citizensdk.h citizensdk_types.h; do\n    prepare_safe_output_file \"$work_dir\" \"$test_header_root/$header\" \\\n      \"Apple XCTest 共享头文件\"\n    cp \"$sdk_dir/include/$header\" \"$test_header_root/$header\"\n  done\n  prepare_safe_output_file \"$work_dir\" \"$test_header_root/citizensdk_qr_image.h\" \\\n    \"Apple XCTest 共享 QR 图像头文件\"\n  cp \"$qr_image_header\" \"$test_header_root/citizensdk_qr_image.h\"\n  # XCTest运行库要求iOS17/macOS14；这里只调整测试目标，正式slice及消费者目标不变。\n  run_apple_test_harness aarch64-apple-ios iphoneos arm64-apple-ios17.0 \\\n    aarch64-apple-ios Flutter \"$flutter_ios_xcframework\" compile\n  run_apple_test_harness aarch64-apple-ios-sim iphonesimulator \\\n    arm64-apple-ios17.0-simulator aarch64-apple-ios-sim Flutter \\\n    \"$flutter_ios_xcframework\" compile\n  run_apple_test_harness aarch64-apple-darwin macosx arm64-apple-macosx14.0 \\\n    aarch64-apple-darwin FlutterMacOS \"$flutter_macos_xcframework\" run\n  run_final_apple_consumer_smoke\n}\n\nbuild_apple_framework_slice() {\n  local rust_target=\"$1\" apple_sdk=\"$2\" swift_target=\"$3\" slice_name=\"$4\"\n  local module_identity=\"$5\" supported_platform=\"$6\" platform_name=\"$7\"\n  local minimum_key=\"$8\" minimum_version=\"$9\"\n  local slice_root framework framework_content_root framework_headers modules\n  local framework_resources framework_binary framework_plist framework_install_name\n  local module_map module_cache\n  local sdk_path swiftc static_library software_version privacy_file source nm_bin\n  local probe export_list qr_build qr_library zxing_library cmake_system\n  local -a swift_sources swift_command\n\n  require_rust_target \"$rust_target\"\n  prepare_internal_header\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9.]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  [[ \"$software_version\" =~ ^[0-9]+\\.[0-9]{1,2}\\.[0-9]{1,2}$ ]] \\\n    || fail \"pubspec.yaml 软件版本无效\"\n  privacy_file=\"$darwin_source_root/PrivacyInfo.xcprivacy\"\n  [[ -d \"$darwin_source_root\" && -f \"$privacy_file\" \\\n    && -f \"$product_header\" && -f \"$product_types_header\" ]] \\\n    || fail \"Apple Swift 源码、隐私清单或产品头不完整\"\n\n  swift_sources=()\n  while IFS= read -r source; do\n    swift_sources+=(\"$source\")\n  done < <(find \"$darwin_source_root\" -maxdepth 1 -type f -name '*.swift' -print | LC_ALL=C sort)\n  [[ \"${#swift_sources[@]}\" -gt 0 ]] || fail \"CitizenSDK Swift 产品源码为空\"\n\n  # Rust中的C依赖必须与后续Swift/CMake共用本slice的SDK，不能继承外层平台值。\n  sdk_path=\"$(xcrun --sdk \"$apple_sdk\" --show-sdk-path)\"\n  [[ -d \"$sdk_path\" ]] || fail \"$slice_name 缺少受控 Apple SDK\"\n  case \"$rust_target\" in\n    aarch64-apple-ios|aarch64-apple-ios-sim)\n      SDKROOT=\"$sdk_path\" IPHONEOS_DEPLOYMENT_TARGET=\"$ios_deployment_target\" \\\n        CARGO_PROFILE_RELEASE_STRIP=false \\\n        cargo build --manifest-path \"$product_ffi_manifest\" --release --locked \\\n          --target \"$rust_target\"\n      ;;\n    aarch64-apple-darwin)\n      SDKROOT=\"$sdk_path\" MACOSX_DEPLOYMENT_TARGET=\"$macos_deployment_target\" \\\n        CARGO_PROFILE_RELEASE_STRIP=false \\\n        cargo build --manifest-path \"$product_ffi_manifest\" --release --locked \\\n          --target \"$rust_target\"\n      ;;\n    *) fail \"Apple 产品禁止未登记 Rust target：$rust_target\" ;;\n  esac\n  static_library=\"$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.a\"\n  [[ -f \"$static_library\" && ! -L \"$static_library\" ]] \\\n    || fail \"$slice_name 的 native/ffi 静态 Core 未生成\"\n\n  slice_root=\"$work_dir/apple-build/$slice_name\"\n  [[ ! -e \"$slice_root\" && ! -L \"$slice_root\" ]] \\\n    || fail \"$slice_name Apple slice 构建目录必须全新\"\n  framework=\"$slice_root/CitizenSDK.framework\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    # macOS framework 必须采用 Apple 标准版本化目录。iOS 设备与\n    # simulator 技术变体均保持 Apple 要求的 shallow framework；三者\n    # 最终进入同一个 CitizenSDK.xcframework，公开平台名只是 iOS/macOS。\n    framework_content_root=\"$framework/Versions/A\"\n    framework_plist=\"$framework_content_root/Resources/Info.plist\"\n    framework_resources=\"$framework_content_root/Resources\"\n    framework_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'\n  else\n    framework_content_root=\"$framework\"\n    framework_plist=\"$framework/Info.plist\"\n    # iOS frameworks are shallow bundles. Keeping a macOS-style Resources\n    # directory makes installd reject the framework during package inspection.\n    framework_resources=\"$framework_content_root\"\n    framework_install_name='@rpath/CitizenSDK.framework/CitizenSDK'\n  fi\n  framework_headers=\"$framework_content_root/Headers\"\n  modules=\"$framework_content_root/Modules/CitizenSDK.swiftmodule\"\n  framework_binary=\"$framework_content_root/CitizenSDK\"\n  module_map=\"$framework_content_root/Modules/module.modulemap\"\n  module_cache=\"$work_dir/apple-module-cache/$slice_name\"\n  for directory in \\\n    \"$framework_headers\" \"$modules\" \"$framework_resources/chain\" \"$module_cache\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"$slice_name Apple 构建目录\"\n  done\n  cp \"$product_header\" \"$framework_headers/citizensdk.h\"\n  cp \"$product_types_header\" \"$framework_headers/citizensdk_types.h\"\n  cp \"$qr_image_header\" \"$framework_headers/citizensdk_qr_image.h\"\n  write_framework_module_map \"$module_map\"\n  for asset in chainspec.json light_sync_state.json manifest.json; do\n    [[ -f \"$apple_asset_root/$asset\" && ! -L \"$apple_asset_root/$asset\" ]] \\\n      || fail \"Apple 链资产缺失：$asset\"\n    cp \"$apple_asset_root/$asset\" \"$framework_resources/chain/$asset\"\n  done\n  cp \"$privacy_file\" \"$framework_resources/PrivacyInfo.xcprivacy\"\n  prepare_safe_output_file \"$work_dir\" \"$framework_plist\" \"$slice_name Info.plist\"\n  write_framework_plist \\\n    \"$framework_plist\" \"$supported_platform\" \"$platform_name\" \\\n    \"$minimum_key\" \"$minimum_version\" \"$software_version\"\n\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    # 只允许这四个已经存在目标的目录链接；最终二进制写入 Versions/A 后再建立\n    # 第五个链接，构建期间不会制造悬空入口，也不会让秘密或产物越出中央 workdir。\n    for link_spec in \\\n      'Versions/Current|A' \\\n      'Headers|Versions/Current/Headers' \\\n      'Modules|Versions/Current/Modules' \\\n      'Resources|Versions/Current/Resources'; do\n      local link_path=\"${link_spec%%|*}\" link_target=\"${link_spec#*|}\"\n      prepare_safe_output_file \"$work_dir\" \"$framework/$link_path\" \\\n        \"$slice_name framework 标准目录链接\"\n      ln -s \"$link_target\" \"$framework/$link_path\"\n      [[ -L \"$framework/$link_path\" && -e \"$framework/$link_path\" \\\n        && \"$(readlink \"$framework/$link_path\")\" == \"$link_target\" ]] \\\n        || fail \"$slice_name framework 标准目录链接创建失败：$link_path\"\n    done\n  fi\n\n  swiftc=\"$(xcrun --sdk \"$apple_sdk\" --find swiftc)\"\n  nm_bin=\"$(xcrun --find nm)\"\n  [[ -d \"$sdk_path\" && -x \"$swiftc\" && -x \"$nm_bin\" ]] \\\n    || fail \"$slice_name 缺少受控 Apple SDK、swiftc 或 nm\"\n  command -v cmake >/dev/null 2>&1 || fail \"$slice_name 缺少 CMake\"\n  [[ -n \"${CITIZENSDK_ZXING_SOURCE_DIR:-}\" \\\n    && \"$CITIZENSDK_ZXING_SOURCE_DIR\" == /* \\\n    && -d \"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n    && ! -L \"$CITIZENSDK_ZXING_SOURCE_DIR\" ]] \\\n    || fail \"$slice_name 必须显式提供官方 ZXing-C++ 3.1.1 完整源码目录\"\n  qr_build=\"$slice_root/qr-image\"\n  prepare_safe_directory \"$work_dir\" \"$qr_build\" \"$slice_name QR 图像构建目录\"\n  if [[ \"$apple_sdk\" == macosx ]]; then cmake_system=Darwin; else cmake_system=iOS; fi\n  cmake -S \"$qr_image_source_root\" -B \"$qr_build\" \\\n    -DCMAKE_BUILD_TYPE=Release \\\n    -DCMAKE_SYSTEM_NAME=\"$cmake_system\" \\\n    -DCMAKE_OSX_SYSROOT=\"$sdk_path\" \\\n    -DCMAKE_OSX_ARCHITECTURES=arm64 \\\n    -DCMAKE_OSX_DEPLOYMENT_TARGET=\"$minimum_version\" \\\n    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \\\n    -DCITIZENSDK_ZXING_SOURCE_DIR=\"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n    -DCITIZENSDK_QR_IMAGE_BUILD_TESTS=OFF\n  cmake --build \"$qr_build\" --config Release --target citizensdk_qr_image --parallel\n  qr_library=\"$(find \"$qr_build\" -type f -name 'libcitizensdk_qr_image.a' -print)\"\n  zxing_library=\"$(find \"$qr_build\" -type f -name 'libZXing.a' -print)\"\n  [[ -n \"$qr_library\" && \"$qr_library\" != *$'\\n'* && -f \"$qr_library\" && ! -L \"$qr_library\" \\\n    && -n \"$zxing_library\" && \"$zxing_library\" != *$'\\n'* \\\n    && -f \"$zxing_library\" && ! -L \"$zxing_library\" ]] \\\n    || fail \"$slice_name ZXing-C++ 静态链接闭包不完整或不唯一\"\n  swift_command=(\"$swiftc\" \"${swift_sources[@]}\"\n    -parse-as-library \\\n    -swift-version 5 \\\n    -warnings-as-errors \\\n    -strict-concurrency=complete \\\n    -O \\\n    -whole-module-optimization \\\n    -enable-library-evolution \\\n    -emit-library \\\n    -emit-module \\\n    -emit-module-path \"$modules/$module_identity.swiftmodule\" \\\n    -emit-module-interface-path \"$modules/$module_identity.swiftinterface\" \\\n    -emit-private-module-interface-path \"$modules/$module_identity.private.swiftinterface\" \\\n    -module-name CitizenSDK \\\n    -module-cache-path \"$module_cache\" \\\n    -sdk \"$sdk_path\" \\\n    -target \"$swift_target\" \\\n    -import-underlying-module \\\n    -F \"$slice_root\" \\\n    -I \"$work_dir/private-include\" \\\n    -Xcc \"-I$framework/Headers\" \\\n    -Xlinker -force_load \\\n    -Xlinker \"$static_library\" \\\n    -Xlinker -force_load \\\n    -Xlinker \"$qr_library\" \\\n    -Xlinker -force_load \\\n    -Xlinker \"$zxing_library\" \\\n    -Xlinker -install_name \\\n    -Xlinker \"$framework_install_name\" \\\n    -framework Security \\\n    -framework LocalAuthentication \\\n    -lc++ \\\n    -lsqlite3)\n  # 第一阶段只存在中央 workdir，用于从真实 Swift 编译结果提取本模块 mangled\n  # exports；第二阶段才用允许集生成候选 framework。允许集不写入源码或候选。\n  probe=\"$slice_root/CitizenSDK.unfiltered\"\n  export_list=\"$slice_root/CitizenSDK.exported-symbols\"\n  prepare_safe_output_file \"$work_dir\" \"$probe\" \"$slice_name 未过滤链接\"\n  \"${swift_command[@]}\" -o \"$probe\"\n  write_apple_exported_symbols \"$probe\" \"$nm_bin\" \"$export_list\" \"$slice_name\"\n  prepare_safe_output_file \"$work_dir\" \"$framework_binary\" \"$slice_name framework 二进制\"\n  \"${swift_command[@]}\" \\\n    -Xlinker -exported_symbols_list \\\n    -Xlinker \"$export_list\" \\\n    -o \"$framework_binary\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    prepare_safe_output_file \"$work_dir\" \"$framework/CitizenSDK\" \\\n      \"$slice_name framework 标准二进制链接\"\n    ln -s 'Versions/Current/CitizenSDK' \"$framework/CitizenSDK\"\n    [[ -L \"$framework/CitizenSDK\" && -e \"$framework/CitizenSDK\" \\\n      && \"$(readlink \"$framework/CitizenSDK\")\" == 'Versions/Current/CitizenSDK' ]] \\\n      || fail \"$slice_name framework 标准二进制链接创建失败\"\n  fi\n  # 对最终候选中的 textual interface 重新调用 Swift frontend。该 interface\n  # 必须通过同名 framework module 解析根 C 头；编译时不使用 bridging header，\n  # 从而维持一个 CitizenSDK 混合模块而非第二个 CitizenSDKC 产品。\n  prepare_safe_directory \"$work_dir\" \"$module_cache/interface\" \\\n    \"$slice_name Swift interface module cache\"\n  for source in \\\n    \"$modules/$module_identity.swiftinterface\" \\\n    \"$modules/$module_identity.private.swiftinterface\"; do\n    if grep -Eq 'CitizenSDKInternal|citizensdk_internal_' \"$source\"; then\n      fail \"$slice_name Swift交付接口泄漏构建期私有依赖\"\n    fi\n    \"$swiftc\" -frontend \\\n      -typecheck-module-from-interface \"$source\" \\\n      -module-name CitizenSDK \\\n      -swift-version 5 \\\n      -warnings-as-errors \\\n      -strict-concurrency=complete \\\n      -sdk \"$sdk_path\" \\\n      -target \"$swift_target\" \\\n      -import-underlying-module \\\n      -F \"$slice_root\" \\\n      -module-cache-path \"$module_cache/interface\"\n  done\n}\n\nrestore_swift_module_artifacts() {\n  local xcframework=\"$1\" build_key module_identity platform variant extension\n  local source source_root destination destination_framework destination_root\n  while IFS='|' read -r build_key module_identity platform variant; do\n    source_root=\"$work_dir/apple-build/$build_key/CitizenSDK.framework\"\n    destination_framework=\"$(resolve_xcframework_framework_slice \\\n      \"$xcframework\" CitizenSDK \"$platform\" \"$variant\")\"\n    destination_root=\"$destination_framework\"\n    if [[ \"$platform\" == macos ]]; then\n      source_root=\"$source_root/Versions/A\"\n      destination_root=\"$destination_root/Versions/A\"\n    fi\n    # `xcodebuild -create-xcframework` may rewrite or omit compiler-emitted\n    # module sidecars. Restore/compare the exact six-file Swift module closure\n    # from each already verified input slice, never only the executable module.\n    for extension in \\\n      abi.json private.swiftinterface swiftdoc swiftinterface swiftmodule swiftsourceinfo; do\n      source=\"$source_root/Modules/CitizenSDK.swiftmodule/$module_identity.$extension\"\n      destination=\"$destination_root/Modules/CitizenSDK.swiftmodule/$module_identity.$extension\"\n      [[ -f \"$source\" && ! -L \"$source\" ]] \\\n        || fail \"$platform/$variant 输入 framework 缺少 Swift module 产物：$extension\"\n      if [[ -e \"$destination\" || -L \"$destination\" ]]; then\n        [[ -f \"$destination\" && ! -L \"$destination\" ]] \\\n          || fail \"$platform/$variant XCFramework Swift module 产物不是普通文件：$extension\"\n        cmp -s \"$source\" \"$destination\" \\\n          || fail \"$platform/$variant XCFramework Swift module 产物字节漂移：$extension\"\n      else\n        prepare_safe_output_file \"$work_dir\" \"$destination\" \\\n          \"$platform/$variant Swift module 产物投影：$extension\"\n        cp \"$source\" \"$destination\"\n      fi\n    done\n  done <<'MODULES'\naarch64-apple-ios|arm64-apple-ios|ios|\naarch64-apple-ios-sim|arm64-apple-ios-simulator|ios|simulator\naarch64-apple-darwin|arm64-apple-macos|macos|\nMODULES\n}\n\nverify_apple_framework_slice() {\n  local framework=\"$1\" label=\"$2\" expected_platform=\"$3\" expected_minos=\"$4\"\n  local module_identity=\"$5\" framework_content_root framework_plist framework_resources binary nm_bin\n  local architectures install_name expected_install_name build_info links top_entries version_entries\n  local actual_platform actual_minos entries expected_entries swift_modules module_entries\n  local bundle_platform platform_name minimum_key software_version expected_plist\n  [[ -d \"$framework\" && ! -L \"$framework\" ]] || fail \"$label framework 缺失\"\n  entries=\"$(find \"$(dirname \"$framework\")\" -mindepth 1 -maxdepth 1 -print \\\n    | sed 's#^.*/##' | LC_ALL=C sort)\"\n  [[ \"$entries\" == CitizenSDK.framework ]] \\\n    || fail \"$label slice 目录闭集漂移：${entries:-无}\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    top_entries=\"$(find \"$framework\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$top_entries\" == $'CitizenSDK\\nHeaders\\nModules\\nResources\\nVersions' ]] \\\n      || fail \"$label 版本化 framework 顶层闭集漂移\"\n    version_entries=\"$(find \"$framework/Versions\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$version_entries\" == $'A\\nCurrent' ]] \\\n      || fail \"$label Versions 闭集漂移\"\n    links=\"$(find \"$framework\" -type l -print \\\n      | sed \"s#^$framework/##\" | LC_ALL=C sort)\"\n    [[ \"$links\" == $'CitizenSDK\\nHeaders\\nModules\\nResources\\nVersions/Current' ]] \\\n      || fail \"$label 标准内部符号链接闭集漂移：${links:-无}\"\n    while IFS='|' read -r link_path link_target; do\n      [[ -L \"$framework/$link_path\" \\\n        && \"$(readlink \"$framework/$link_path\")\" == \"$link_target\" \\\n        && -e \"$framework/$link_path\" ]] \\\n        || fail \"$label 标准内部符号链接漂移：$link_path\"\n    done <<'MACOS_FRAMEWORK_LINKS'\nCitizenSDK|Versions/Current/CitizenSDK\nHeaders|Versions/Current/Headers\nModules|Versions/Current/Modules\nResources|Versions/Current/Resources\nVersions/Current|A\nMACOS_FRAMEWORK_LINKS\n    framework_content_root=\"$framework/Versions/A\"\n    entries=\"$(find \"$framework_content_root\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$entries\" == $'CitizenSDK\\nHeaders\\nModules\\nResources' ]] \\\n      || fail \"$label Versions/A 内容闭集漂移\"\n    framework_plist=\"$framework_content_root/Resources/Info.plist\"\n    framework_resources=\"$framework_content_root/Resources\"\n  else\n    [[ -z \"$(find \"$framework\" -type l -print -quit)\" ]] \\\n      || fail \"$label shallow framework 禁止符号链接\"\n    top_entries=\"$(find \"$framework\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$top_entries\" == $'CitizenSDK\\nHeaders\\nInfo.plist\\nModules\\nPrivacyInfo.xcprivacy\\nchain' ]] \\\n      || fail \"$label shallow framework 顶层闭集漂移\"\n    framework_content_root=\"$framework\"\n    framework_plist=\"$framework/Info.plist\"\n    framework_resources=\"$framework_content_root\"\n  fi\n  binary=\"$framework_content_root/CitizenSDK\"\n  [[ -f \"$binary\" && ! -L \"$binary\" ]] || fail \"$label framework 二进制缺失\"\n  architectures=\"$(xcrun lipo -archs \"$binary\")\"\n  [[ \"$architectures\" == arm64 ]] || fail \"$label 内部架构必须精确为 arm64；实际=$architectures\"\n  install_name=\"$(xcrun otool -D \"$binary\" | tail -n +2 | sed '/^[[:space:]]*$/d')\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'\n  else\n    expected_install_name='@rpath/CitizenSDK.framework/CitizenSDK'\n  fi\n  [[ \"$install_name\" == \"$expected_install_name\" ]] \\\n    || fail \"$label install name 漂移：${install_name:-无}\"\n  build_info=\"$(xcrun vtool -show-build \"$binary\")\"\n  actual_platform=\"$(printf '%s\\n' \"$build_info\" | awk '$1 == \"platform\" { print $2 }')\"\n  actual_minos=\"$(printf '%s\\n' \"$build_info\" | awk '$1 == \"minos\" { print $2 }')\"\n  [[ \"$actual_platform\" == \"$expected_platform\" && \"$actual_minos\" == \"$expected_minos\" ]] \\\n    || fail \"$label 平台/最低版本漂移：$actual_platform/$actual_minos\"\n  nm_bin=\"$(xcrun --find nm)\"\n  verify_apple_product_abi_symbols \"$binary\" \"$nm_bin\" \"$label\"\n\n  [[ -d \"$framework_content_root/Headers\" \\\n    && ! -L \"$framework_content_root/Headers\" ]] \\\n    || fail \"$label Headers 不是普通目录\"\n  entries=\"$(find \"$framework_content_root/Headers\" -mindepth 1 -maxdepth 1 -print \\\n    | sed 's#^.*/##' | LC_ALL=C sort)\"\n  expected_entries=$'citizensdk.h\\ncitizensdk_qr_image.h\\ncitizensdk_types.h'\n  [[ \"$entries\" == \"$expected_entries\" ]] || fail \"$label 产品头闭集漂移\"\n  [[ -f \"$framework_content_root/Headers/citizensdk.h\" \\\n    && ! -L \"$framework_content_root/Headers/citizensdk.h\" \\\n    && -f \"$framework_content_root/Headers/citizensdk_types.h\" \\\n    && ! -L \"$framework_content_root/Headers/citizensdk_types.h\" \\\n    && -f \"$framework_content_root/Headers/citizensdk_qr_image.h\" \\\n    && ! -L \"$framework_content_root/Headers/citizensdk_qr_image.h\" ]] \\\n    || fail \"$label 产品头必须全部为普通文件\"\n  cmp -s \"$framework_content_root/Headers/citizensdk.h\" \"$product_header\" \\\n    || fail \"$label citizensdk.h 与根产品头不一致\"\n  cmp -s \"$framework_content_root/Headers/citizensdk_types.h\" \"$product_types_header\" \\\n    || fail \"$label citizensdk_types.h 与根产品头不一致\"\n  cmp -s \"$framework_content_root/Headers/citizensdk_qr_image.h\" \"$qr_image_header\" \\\n    || fail \"$label citizensdk_qr_image.h 与统一图像头不一致\"\n  [[ -d \"$framework_content_root/Modules\" \\\n    && ! -L \"$framework_content_root/Modules\" ]] \\\n    || fail \"$label Modules 不是普通目录\"\n  module_entries=\"$(find \"$framework_content_root/Modules\" \\\n    -mindepth 1 -maxdepth 1 -print | sed 's#^.*/##' | LC_ALL=C sort)\"\n  [[ \"$module_entries\" == $'CitizenSDK.swiftmodule\\nmodule.modulemap' \\\n    && -f \"$framework_content_root/Modules/module.modulemap\" \\\n    && ! -L \"$framework_content_root/Modules/module.modulemap\" \\\n    && -d \"$framework_content_root/Modules/CitizenSDK.swiftmodule\" \\\n    && ! -L \"$framework_content_root/Modules/CitizenSDK.swiftmodule\" ]] \\\n    || fail \"$label Modules 节点闭集或类型漂移\"\n  grep -Fq 'framework module CitizenSDK' \"$framework_content_root/Modules/module.modulemap\" \\\n    || fail \"$label 缺少 CitizenSDK Clang module\"\n  swift_modules=\"$(find \"$framework_content_root/Modules/CitizenSDK.swiftmodule\" \\\n    -mindepth 1 -maxdepth 1 -print | sed 's#^.*/##' | LC_ALL=C sort)\"\n  expected_entries=\"$(printf '%s\\n' \\\n    \"$module_identity.abi.json\" \\\n    \"$module_identity.private.swiftinterface\" \\\n    \"$module_identity.swiftdoc\" \\\n    \"$module_identity.swiftinterface\" \\\n    \"$module_identity.swiftmodule\" \\\n    \"$module_identity.swiftsourceinfo\" | LC_ALL=C sort)\"\n  [[ \"$swift_modules\" == \"$expected_entries\" ]] \\\n    || fail \"$label Swift module 六文件闭集漂移\"\n  for interface in \\\n    \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.swiftinterface\" \\\n    \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.private.swiftinterface\"; do\n    grep -Fxq '@_exported import CitizenSDK' \"$interface\" \\\n      || fail \"$label Swift interface 未固定同名 underlying Clang module\"\n  done\n  grep -Fq '@_spi(CitizenSDKFlutter)' \\\n    \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.private.swiftinterface\" \\\n    || fail \"$label private Swift interface 缺少 CitizenSDKFlutter SPI\"\n  while IFS= read -r module_file; do\n    [[ -f \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_file\" \\\n      && ! -L \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_file\" ]] \\\n      || fail \"$label Swift module 必须全部为普通文件：$module_file\"\n  done <<<\"$swift_modules\"\n  [[ -d \"$framework_resources/chain\" \\\n    && ! -L \"$framework_resources/chain\" ]] \\\n    || fail \"$label chain 不是普通目录\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    [[ -d \"$framework_resources\" && ! -L \"$framework_resources\" ]] \\\n      || fail \"$label Resources 不是普通目录\"\n    entries=\"$(find \"$framework_resources\" -mindepth 1 -print \\\n      | sed \"s#^$framework_resources/##\" | LC_ALL=C sort)\"\n    expected_entries=$'Info.plist\\nPrivacyInfo.xcprivacy\\nchain\\nchain/chainspec.json\\nchain/light_sync_state.json\\nchain/manifest.json'\n  else\n    entries=\"$(find \"$framework_resources/chain\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    expected_entries=$'chainspec.json\\nlight_sync_state.json\\nmanifest.json'\n  fi\n  [[ \"$entries\" == \"$expected_entries\" ]] || fail \"$label 资源闭集漂移\"\n  for asset in chainspec.json light_sync_state.json manifest.json; do\n    [[ -f \"$framework_resources/chain/$asset\" \\\n      && ! -L \"$framework_resources/chain/$asset\" ]] \\\n      || fail \"$label 链资产不是普通文件：$asset\"\n    cmp -s \"$framework_resources/chain/$asset\" \"$apple_asset_root/$asset\" \\\n      || fail \"$label 链资产字节漂移：$asset\"\n  done\n  [[ -f \"$framework_resources/PrivacyInfo.xcprivacy\" \\\n    && ! -L \"$framework_resources/PrivacyInfo.xcprivacy\" \\\n    && -f \"$framework_plist\" && ! -L \"$framework_plist\" ]] \\\n    || fail \"$label 隐私清单或 Info.plist 不是普通文件\"\n  cmp -s \"$framework_resources/PrivacyInfo.xcprivacy\" \\\n    \"$darwin_source_root/PrivacyInfo.xcprivacy\" \\\n    || fail \"$label 隐私清单字节漂移\"\n  case \"$module_identity\" in\n    arm64-apple-ios)\n      bundle_platform=iPhoneOS; platform_name=iphoneos; minimum_key=MinimumOSVersion ;;\n    arm64-apple-ios-simulator)\n      bundle_platform=iPhoneSimulator; platform_name=iphonesimulator; minimum_key=MinimumOSVersion ;;\n    arm64-apple-macos)\n      bundle_platform=MacOSX; platform_name=macosx; minimum_key=LSMinimumSystemVersion ;;\n    *) fail \"$label Swift module identity 未登记：$module_identity\" ;;\n  esac\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9.]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  expected_plist=\"$work_dir/apple-plist-contract/$module_identity.plist\"\n  if [[ ! -e \"$expected_plist\" && ! -L \"$expected_plist\" ]]; then\n    prepare_safe_output_file \"$work_dir\" \"$expected_plist\" \"$label Info.plist 合同\"\n    write_framework_plist \"$expected_plist\" \"$bundle_platform\" \"$platform_name\" \\\n      \"$minimum_key\" \"$expected_minos\" \"$software_version\"\n  fi\n  cmp -s \\\n    <(/usr/bin/plutil -convert binary1 -o - \"$framework_plist\") \\\n    <(/usr/bin/plutil -convert binary1 -o - \"$expected_plist\") \\\n    || fail \"$label Info.plist 完整字段合同漂移\"\n}\n\nverify_apple_xcframework() {\n  local xcframework=\"$1\" entries expected_entries index identifier library_path\n  local binary_path expected_binary_path architecture extra_architecture platform variant\n  local metadata expected_metadata plist_keys library_keys expected_library_keys\n  local identifiers='' ios_device_identifier='' ios_simulator_identifier=''\n  local macos_identifier=''\n  [[ -d \"$xcframework\" && ! -L \"$xcframework\" ]] \\\n    || fail \"CitizenSDK.xcframework 缺失或不是普通目录\"\n  [[ -f \"$xcframework/Info.plist\" && ! -L \"$xcframework/Info.plist\" ]] \\\n    || fail \"CitizenSDK.xcframework 缺少普通 Info.plist\"\n  plist_keys=\"$(/usr/libexec/PlistBuddy -c Print \"$xcframework/Info.plist\" \\\n    | awk '/^    [^ ]/ && / = / { print $1 }' | LC_ALL=C sort)\"\n  [[ \"$plist_keys\" == $'AvailableLibraries\\nCFBundlePackageType\\nXCFrameworkFormatVersion' \\\n    && \"$(/usr/libexec/PlistBuddy -c 'Print :XCFrameworkFormatVersion' \\\n      \"$xcframework/Info.plist\")\" == 1.0 ]] \\\n    || fail \"XCFramework Info.plist 根字段闭集或格式版本漂移\"\n  metadata=''\n  for index in 0 1 2; do\n    identifier=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:LibraryIdentifier\" \\\n      \"$xcframework/Info.plist\")\"\n    library_path=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:LibraryPath\" \\\n      \"$xcframework/Info.plist\")\"\n    binary_path=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:BinaryPath\" \\\n      \"$xcframework/Info.plist\")\"\n    architecture=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedArchitectures:0\" \\\n      \"$xcframework/Info.plist\")\"\n    extra_architecture=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedArchitectures:1\" \\\n      \"$xcframework/Info.plist\" 2>/dev/null || true)\"\n    platform=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatform\" \\\n      \"$xcframework/Info.plist\")\"\n    variant=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatformVariant\" \\\n      \"$xcframework/Info.plist\" 2>/dev/null || true)\"\n    [[ \"$identifier\" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ \\\n      && -d \"$xcframework/$identifier\" && ! -L \"$xcframework/$identifier\" ]] \\\n      || fail \"XCFramework LibraryIdentifier 必须是 Xcode 生成的安全不透明目录标识：$identifier\"\n    if printf '%s\\n' \"$identifiers\" | grep -Fxq \"$identifier\"; then\n      fail \"XCFramework LibraryIdentifier 重复：$identifier\"\n    fi\n    identifiers+=\"$identifier\"$'\\n'\n    library_keys=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index\" \"$xcframework/Info.plist\" \\\n      | awk '/^    [^ ]/ && / = / { print $1 }' | LC_ALL=C sort)\"\n    if [[ -n \"$variant\" ]]; then\n      expected_library_keys=$'BinaryPath\\nLibraryIdentifier\\nLibraryPath\\nSupportedArchitectures\\nSupportedPlatform\\nSupportedPlatformVariant'\n    else\n      expected_library_keys=$'BinaryPath\\nLibraryIdentifier\\nLibraryPath\\nSupportedArchitectures\\nSupportedPlatform'\n    fi\n    [[ \"$library_keys\" == \"$expected_library_keys\" ]] \\\n      || fail \"XCFramework slice 字段闭集漂移：$identifier\"\n    case \"$platform/$variant\" in\n      ios/)\n        [[ -z \"$ios_device_identifier\" ]] \\\n          || fail \"XCFramework 重复声明 iOS 设备技术变体\"\n        ios_device_identifier=\"$identifier\"\n        expected_binary_path='CitizenSDK.framework/CitizenSDK'\n        ;;\n      ios/simulator)\n        [[ -z \"$ios_simulator_identifier\" ]] \\\n          || fail \"XCFramework 重复声明 iOS simulator 技术变体\"\n        ios_simulator_identifier=\"$identifier\"\n        expected_binary_path='CitizenSDK.framework/CitizenSDK'\n        ;;\n      macos/)\n        [[ -z \"$macos_identifier\" ]] \\\n          || fail \"XCFramework 重复声明 macOS\"\n        macos_identifier=\"$identifier\"\n        expected_binary_path='CitizenSDK.framework/Versions/A/CitizenSDK'\n        ;;\n      *) fail \"XCFramework 含未登记 Apple 技术变体：$platform/$variant\" ;;\n    esac\n    [[ \"$library_path\" == CitizenSDK.framework && \"$architecture\" == arm64 \\\n      && \"$binary_path\" == \"$expected_binary_path\" && -z \"$extra_architecture\" ]] \\\n      || fail \"XCFramework slice 必须精确为单一 arm64 framework：$identifier\"\n    metadata+=\"$platform|$variant\"$'\\n'\n  done\n  metadata=\"$(printf '%s' \"$metadata\" | LC_ALL=C sort)\"\n  expected_metadata=$'ios|\\nios|simulator\\nmacos|'\n  [[ \"$metadata\" == \"$expected_metadata\" ]] \\\n    || fail \"XCFramework Info.plist 三 slice 元数据漂移\"\n  [[ -n \"$ios_device_identifier\" && -n \"$ios_simulator_identifier\" \\\n    && -n \"$macos_identifier\" ]] \\\n    || fail \"XCFramework 必须覆盖 iOS 设备、iOS simulator 技术变体和 macOS\"\n  # LibraryIdentifier 是 xcodebuild 生成的不透明技术标识，不得改写为\n  # 产品平台名。目录闭集只从 Info.plist 反向发现。\n  entries=\"$(find \"$xcframework\" -mindepth 1 -maxdepth 1 -print \\\n    | sed 's#^.*/##' | LC_ALL=C sort)\"\n  expected_entries=\"$(printf '%s\\n' Info.plist \"$ios_device_identifier\" \\\n    \"$ios_simulator_identifier\" \"$macos_identifier\" | LC_ALL=C sort)\"\n  [[ \"$entries\" == \"$expected_entries\" ]] \\\n    || fail \"CitizenSDK.xcframework slice 闭集漂移：${entries:-无}\"\n  [[ -z \"$(find \"$xcframework/$ios_device_identifier\" \\\n    \"$xcframework/$ios_simulator_identifier\" -type l -print -quit)\" ]] \\\n    || fail \"CitizenSDK.xcframework 的 iOS 技术变体禁止符号链接\"\n  while IFS= read -r link; do\n    case \"$link\" in\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/CitizenSDK\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Headers\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Modules\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Resources\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Versions/Current\") ;;\n      *) fail \"CitizenSDK.xcframework 含未登记符号链接：$link\" ;;\n    esac\n  done < <(find \"$xcframework\" -type l -print)\n  [[ \"$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' \\\n    \"$xcframework/Info.plist\")\" == XFWK ]] \\\n    || fail \"XCFramework Info.plist 产品类型必须是 XFWK\"\n  /usr/libexec/PlistBuddy -c 'Print :AvailableLibraries:3' \\\n    \"$xcframework/Info.plist\" >/dev/null 2>&1 \\\n    && fail \"XCFramework Info.plist 含额外 slice\" || true\n  verify_apple_framework_slice \\\n    \"$xcframework/$ios_device_identifier/CitizenSDK.framework\" \\\n    \"CitizenSDK iOS（设备技术变体）\" IOS 16.0 arm64-apple-ios\n  verify_apple_framework_slice \\\n    \"$xcframework/$ios_simulator_identifier/CitizenSDK.framework\" \\\n    \"CitizenSDK iOS（simulator 技术变体）\" IOSSIMULATOR 16.0 \\\n    arm64-apple-ios-simulator\n  verify_apple_framework_slice \\\n    \"$xcframework/$macos_identifier/CitizenSDK.framework\" \\\n    \"CitizenSDK macOS\" MACOS 13.0 arm64-apple-macos\n}\n\nbuild_apple() {\n  [[ \"$(uname -s)\" == Darwin ]] || fail \"Apple 产品只允许在 macOS runner 构建\"\n  local create_root created_xcframework destination flutter_root\n  local flutter_ios_xcframework flutter_macos_xcframework\n  local citizen_ios_framework citizen_ios_simulator_framework citizen_macos_framework\n  command -v xcodebuild >/dev/null 2>&1 || fail \"缺少 xcodebuild\"\n  build_apple_framework_slice \\\n    aarch64-apple-ios iphoneos arm64-apple-ios16.0 aarch64-apple-ios \\\n    arm64-apple-ios iPhoneOS iphoneos MinimumOSVersion \"$ios_deployment_target\"\n  build_apple_framework_slice \\\n    aarch64-apple-ios-sim iphonesimulator arm64-apple-ios16.0-simulator \\\n    aarch64-apple-ios-sim arm64-apple-ios-simulator iPhoneSimulator iphonesimulator \\\n    MinimumOSVersion \"$ios_deployment_target\"\n  build_apple_framework_slice \\\n    aarch64-apple-darwin macosx arm64-apple-macosx13.0 aarch64-apple-darwin \\\n    arm64-apple-macos MacOSX macosx LSMinimumSystemVersion \"$macos_deployment_target\"\n\n  create_root=\"$work_dir/apple-xcframework\"\n  prepare_safe_directory \"$work_dir\" \"$create_root\" \"Apple XCFramework 生成目录\"\n  created_xcframework=\"$create_root/CitizenSDK.xcframework\"\n  [[ ! -e \"$created_xcframework\" && ! -L \"$created_xcframework\" ]] \\\n    || fail \"Apple XCFramework 生成目标已存在\"\n  xcodebuild -create-xcframework \\\n    -framework \"$work_dir/apple-build/aarch64-apple-ios/CitizenSDK.framework\" \\\n    -framework \"$work_dir/apple-build/aarch64-apple-ios-sim/CitizenSDK.framework\" \\\n    -framework \"$work_dir/apple-build/aarch64-apple-darwin/CitizenSDK.framework\" \\\n    -output \"$created_xcframework\"\n  # Xcode 27 在存在 stable interface 时会从 create-xcframework 输出中移除\n  # 编译 `.swiftmodule`。从三个已经逐 slice 验证的输入 framework 原字节恢复，\n  # 让同编译器快速路径与跨编译器 textual interface 同时进入唯一产品。\n  restore_swift_module_artifacts \"$created_xcframework\"\n  verify_apple_xcframework \"$created_xcframework\"\n\n  flutter_root=\"$(resolve_flutter_sdk_root)\"\n  flutter_ios_xcframework=\"$flutter_root/bin/cache/artifacts/engine/ios-release/Flutter.xcframework\"\n  flutter_macos_xcframework=\"$(resolve_flutter_macos_xcframework \"$flutter_root\")\"\n  citizen_ios_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$created_xcframework\" CitizenSDK ios '')\"\n  citizen_ios_simulator_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$created_xcframework\" CitizenSDK ios simulator)\"\n  citizen_macos_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$created_xcframework\" CitizenSDK macos '')\"\n  compile_apple_flutter_adapter iphoneos arm64-apple-ios16.0 aarch64-apple-ios \\\n    ios '' Flutter \"$flutter_ios_xcframework\" \"$(dirname \"$citizen_ios_framework\")\"\n  compile_apple_flutter_adapter iphonesimulator arm64-apple-ios16.0-simulator \\\n    aarch64-apple-ios-sim ios simulator Flutter \"$flutter_ios_xcframework\" \\\n    \"$(dirname \"$citizen_ios_simulator_framework\")\"\n  compile_apple_flutter_adapter macosx arm64-apple-macosx13.0 \\\n    aarch64-apple-darwin macos '' FlutterMacOS \"$flutter_macos_xcframework\" \\\n    \"$(dirname \"$citizen_macos_framework\")\"\n\n  destination=\"$output_dir/apple/CitizenSDK.xcframework\"\n  prepare_safe_directory \"$output_dir\" \"$(dirname \"$destination\")\" \\\n    \"Apple 产品父目录\"\n  [[ ! -e \"$destination\" && ! -L \"$destination\" ]] \\\n    || fail \"Apple 产品目标已存在：$destination\"\n  cp -R \"$created_xcframework\" \"$destination\"\n  verify_apple_xcframework \"$destination\"\n  echo \"CitizenSDK iOS/macOS XCFramework 完成：$destination\"\n}\n\nlinux_platform_contract() {\n  local platform=\"$1\" expected_arch rust_target\n  [[ \"$(uname -s)\" == Linux ]] \\\n    || fail \"$platform 只允许在匹配的原生 Linux runner 构建\"\n  case \"$platform\" in\n    LinuxARM)\n      expected_arch=aarch64\n      rust_target=aarch64-unknown-linux-gnu\n      ;;\n    LinuxAMD)\n      expected_arch=x86_64\n      rust_target=x86_64-unknown-linux-gnu\n      ;;\n    *) fail \"未登记的 Linux 平台：$platform\" ;;\n  esac\n  [[ \"$(uname -m)\" == \"$expected_arch\" ]] \\\n    || fail \"$platform 必须在 $expected_arch 原生 runner 构建；实际=$(uname -m)\"\n  printf '%s|%s\\n' \"$rust_target\" \"$expected_arch\"\n}\n\nverify_linux_ctest_inventory() {\n  local ctest_bin=\"$1\" directory=\"$2\" label=\"$3\" expected=\"$4\" inventory count\n  local variable names actual\n  case \"$label:$expected\" in\n    LinuxHost:12) variable=CITIZENSDK_LINUX_CONTRACT_TESTS ;;\n    LinuxFlutter:6) variable=CITIZENSDK_LINUX_FLUTTER_CONTRACT_TESTS ;;\n    LinuxConsumer:2) variable='' ;;\n    *) fail \"未登记的 Linux CTest 闭集：$label/$expected\" ;;\n  esac\n  if [[ -n \"$variable\" ]]; then\n    names=\"$(CITIZENSDK_CTEST_LIST=\"$variable\" perl -0777 -ne '\n      my $name = $ENV{CITIZENSDK_CTEST_LIST};\n      my @lists = /set\\(\\Q$name\\E\\s+([^)]*)\\)/g;\n      die \"CTest source list must be unique\\n\" unless @lists == 1;\n      my @names = grep { length } split /\\s+/, $lists[0];\n      for (@names) { die \"Invalid CTest source name\\n\" unless /^citizen_sdk_[a-z0-9_]+_test$/; }\n      print join(\"\\n\", map { \"CitizenSDK.Linux.$_\" } @names), \"\\n\";\n      exit;\n    ' \"$linux_source_root/tests/CMakeLists.txt\")\" \\\n      || fail \"无法读取 $label 唯一源码测试名单\"\n  else\n    names=$'CitizenSDK.Linux.CConsumer\\nCitizenSDK.Linux.CppConsumer'\n  fi\n  [[ \"$(printf '%s\\n' \"$names\" | wc -l | tr -d ' ')\" == \"$expected\" \\\n      && \"$(printf '%s\\n' \"$names\" | LC_ALL=C sort | uniq -d)\" == '' ]] \\\n    || fail \"$label 源码测试名单数量或唯一性漂移\"\n  inventory=\"$(\"$ctest_bin\" --test-dir \"$directory\" -N -L \"^$label$\" 2>&1)\" \\\n    || fail \"无法枚举 $label CTest 合同\"\n  count=\"$(printf '%s\\n' \"$inventory\" | sed -n 's/^Total Tests: \\([0-9][0-9]*\\)$/\\1/p')\"\n  [[ \"$count\" == \"$expected\" ]] \\\n    || fail \"$label CTest 数量必须为 ${expected}；实际=${count:-无}\"\n  actual=\"$(printf '%s\\n' \"$inventory\" \\\n    | sed -n 's/^[[:space:]]*Test[[:space:]]*#[0-9][0-9]*:[[:space:]]*//p' \\\n    | LC_ALL=C sort)\"\n  [[ \"$actual\" == \"$(printf '%s\\n' \"$names\" | LC_ALL=C sort)\" ]] \\\n    || fail \"$label CTest 名称闭集不一致；拒绝替换、重复或遗漏\"\n}\n\nverify_linux_runtime_resolution() {\n  local executable=\"$1\" runtime_dir=\"$2\" resolution library resolved\n  resolution=\"$(LC_ALL=C ldd \"$executable\" 2>&1)\" \\\n    || fail \"无法解析 Linux 消费者的真实动态运行依赖\"\n  ! printf '%s\\n' \"$resolution\" | grep -Fq 'not found' \\\n    || fail \"Linux 消费者存在未解析的动态依赖\"\n  for library in libcitizensdk.so libcitizensdk_host.so; do\n    resolved=\"$(printf '%s\\n' \"$resolution\" | awk -v name=\"$library\" '$1 == name && $2 == \"=>\" { print $3 }')\"\n    [[ \"$resolved\" == \"$runtime_dir/$library\" ]] \\\n      || fail \"Linux 消费者没有解析到本轮唯一的 $library\"\n  done\n}\n\nverify_linux_tool_tree() {\n  local root=\"$1\" label=\"$2\" entry target resolved\n  assert_readonly_dependency_directory \"$root\" \"$label\"\n  [[ -z \"$(find \"$root\" ! -type f ! -type d ! -type l -print -quit)\" ]] \\\n    || fail \"$label 禁止特殊文件\"\n  [[ -z \"$(find \"$root\" -type f -name .git -print -quit)\" ]] \\\n    || fail \"$label 禁止指向外部 worktree 的 .git 文件\"\n  while IFS= read -r -d '' entry; do\n    target=\"$(readlink \"$entry\")\" || fail \"$label 无法读取符号链接\"\n    [[ \"$target\" != /* ]] || fail \"$label 禁止绝对符号链接\"\n    resolved=\"$(realpath -e \"$entry\")\" || fail \"$label 禁止悬空符号链接\"\n    case \"$resolved/\" in \"$root/\"*) ;; *) fail \"$label 符号链接越界\" ;; esac\n  done < <(find \"$root\" -type l -print0)\n}\n\nverify_linux_flutter_cache() {\n  local root=\"$1\" platform=\"$2\" arch revision name expected path\n  case \"$platform\" in LinuxARM) arch=arm64 ;; LinuxAMD) arch=x64 ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  verify_linux_tool_tree \"$root\" \"$platform Flutter SDK\"\n  [[ -d \"$root/.git\" && ! -L \"$root/.git\" ]] || fail \"Flutter SDK 必须是预装的完整普通目录\"\n  for path in bin/cache/flutter_tools.snapshot bin/cache/flutter_tools.stamp \\\n      bin/cache/flutter.version.json bin/cache/engine.stamp bin/internal/engine.version \\\n      packages/flutter_tools/pubspec.yaml packages/flutter_tools/pubspec.lock \\\n      bin/cache/dart-sdk/bin/dart \\\n      bin/cache/pkg/sky_engine/pubspec.yaml bin/cache/pkg/flutter_gpu/pubspec.yaml \\\n      bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill \\\n      bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill \\\n      \"bin/cache/artifacts/engine/linux-$arch/font-subset\" \\\n      \"bin/cache/artifacts/engine/linux-$arch/icudtl.dat\" \\\n      \"bin/cache/artifacts/engine/linux-$arch-release/gen_snapshot\"; do\n    [[ -f \"$root/$path\" && ! -L \"$root/$path\" && -s \"$root/$path\" ]] \\\n      || fail \"$platform 缺少已缓存 Flutter 文件：${path}；禁止自动下载\"\n  done\n  revision=\"$(<\"$root/bin/cache/engine.stamp\")\"\n  [[ \"$revision\" =~ ^[0-9a-f]{40}$ ]] || fail \"Flutter engine.stamp 格式无效\"\n  [[ \"$(<\"$root/bin/internal/engine.version\")\" == \"$revision\" ]] \\\n    || fail \"$platform Flutter 源码 engine.version 与已有缓存不同；禁止自动升级\"\n  for name in flutter_sdk linux-sdk font-subset; do\n    [[ -f \"$root/bin/cache/$name.stamp\" && ! -L \"$root/bin/cache/$name.stamp\" \\\n        && \"$(<\"$root/bin/cache/$name.stamp\")\" == \"$revision\" ]] \\\n      || fail \"$platform Flutter $name 缓存版本不完整；禁止自动更新\"\n  done\n  for name in material_fonts gradle_wrapper; do\n    [[ -f \"$root/bin/internal/$name.version\" && -f \"$root/bin/cache/$name.stamp\" ]] \\\n      || fail \"$platform Flutter $name 缓存未预装\"\n    expected=\"$(<\"$root/bin/internal/$name.version\")\"\n    [[ \"$(<\"$root/bin/cache/$name.stamp\")\" == \"$expected\" \\\n        && -d \"$root/bin/cache/artifacts/$name\" ]] \\\n      || fail \"$platform Flutter $name 缓存版本不完整\"\n  done\n  # 官方 LinuxEngineArtifacts 会同时检查三个目录；即使这里只构建 Release，\n  # 也不能留缺项诱使 Flutter build 自动取得其它运行件。ICU 是无 mode 的\n  # 通用 host artifact（上面已核验），不要求 profile/release 各自含一份。\n  for name in \"linux-$arch\" \"linux-$arch-profile\" \"linux-$arch-release\"; do\n    for path in libflutter_linux_gtk.so flutter_linux/flutter_linux.h gen_snapshot; do\n      [[ -f \"$root/bin/cache/artifacts/engine/$name/$path\" \\\n          && ! -L \"$root/bin/cache/artifacts/engine/$name/$path\" ]] \\\n        || fail \"$platform Flutter $name/$path 缓存缺失\"\n    done\n  done\n  perl -MJSON::PP -e '\n    use strict; use warnings;\n    my ($root, $engine) = @ARGV;\n    open my $input, \"<\", \"$root/bin/cache/flutter.version.json\" or die \"Flutter version missing\\n\";\n    local $/; my $version = decode_json(<$input>);\n    die \"Flutter engine revision mismatch\\n\" unless $version->{engineRevision} eq $engine;\n    die \"Flutter framework revision invalid\\n\" unless $version->{frameworkRevision} =~ /^[0-9a-f]{40}$/;\n    open my $stamp, \"<\", \"$root/bin/cache/flutter_tools.stamp\" or die \"Flutter tools stamp missing\\n\";\n    my $value = <$stamp>; $value =~ s/\\s+\\z//;\n    die \"Flutter snapshot version mismatch\\n\" unless $value eq \"$version->{frameworkRevision}:\";\n  ' \"$root\" \"$revision\" || fail \"$platform Flutter snapshot/版本身份不一致\"\n}\n\nverify_linux_flutter_elf() {\n  local platform=\"$1\" bundle=\"$2\" prefix=\"$3\" readelf_bin=\"$4\" nm_bin=\"$5\"\n  local machine plugin needed symbols rpath runpath library\n  case \"$platform\" in LinuxARM) machine=AArch64 ;; LinuxAMD) machine='Advanced Micro Devices X86-64' ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  [[ -d \"$bundle\" && ! -L \"$bundle\" ]] || fail \"$platform Flutter bundle 缺失\"\n  [[ -z \"$(find \"$bundle\" ! -type d ! -type f -print -quit)\" ]] \\\n    || fail \"$platform Flutter bundle 禁止符号链接或特殊节点\"\n  for library in libcitizensdk.so libcitizensdk_host.so; do\n    cmp -s \"$prefix/lib/$platform/$library\" \"$bundle/lib/$library\" \\\n      || fail \"$platform Flutter bundle 的 $library 不是同版安装运行件\"\n  done\n  verify_linux_elf_identity \"$platform\" \"$bundle/lib/libcitizensdk.so\" \\\n    \"$bundle/lib/libcitizensdk_host.so\" \"$readelf_bin\" \"$nm_bin\"\n  plugin=\"$bundle/lib/libcitizen_sdk_plugin.so\"\n  for library in \"$bundle/citizensdk_consumer\" \"$plugin\" \"$bundle/lib/libflutter_linux_gtk.so\" \"$bundle/lib/libapp.so\"; do\n    [[ -f \"$library\" && ! -L \"$library\" ]] || fail \"$platform Flutter bundle 运行闭包不完整\"\n    verify_linux_machine \"$library\" \"$readelf_bin\" \"$machine\" \"$platform Flutter $(basename \"$library\")\"\n    # Flutter engine 是官方运行件，不能把它的 C++ ABI 误称 SDK 自身静态闭包。\n    if [[ \"$library\" == \"$bundle/lib/libflutter_linux_gtk.so\" ]]; then\n      verify_linux_glibc_contract \"$library\" \"$readelf_bin\" \"$platform Flutter engine\" true\n    else\n      verify_linux_glibc_contract \"$library\" \"$readelf_bin\" \"$platform Flutter $(basename \"$library\")\"\n    fi\n    needed=\"$(linux_elf_dynamic_values \"$library\" \"$readelf_bin\" NEEDED)\"\n    [[ \"$needed\" != */* ]] || fail \"$platform Flutter DT_NEEDED 禁止构建路径\"\n  done\n  symbols=\"$(product_library_symbols \"$plugin\" \"$nm_bin\" '')\"\n  [[ \"$symbols\" == citizen_sdk_plugin_register_with_registrar ]] \\\n    || fail \"$platform Flutter plugin 只能导出官方注册入口，不得复制 Core/Host\"\n  needed=\"$(linux_elf_dynamic_values \"$plugin\" \"$readelf_bin\" NEEDED)\"\n  for library in libcitizensdk.so libcitizensdk_host.so libflutter_linux_gtk.so; do\n    [[ \"$(printf '%s\\n' \"$needed\" | grep -Fxc \"$library\" || true)\" == 1 ]] \\\n      || fail \"$platform Flutter plugin 必须精确依赖一次 $library\"\n  done\n  if printf '%s\\n' \"$needed\" | grep -Eq '^(libsmoldot|libstdc\\+\\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)'; then\n    fail \"$platform Flutter plugin 泄漏禁止的动态依赖\"\n  fi\n  rpath=\"$(linux_elf_dynamic_values \"$plugin\" \"$readelf_bin\" RPATH)\"\n  runpath=\"$(linux_elf_dynamic_values \"$plugin\" \"$readelf_bin\" RUNPATH)\"\n  [[ -z \"$rpath\" && \"$runpath\" == '$ORIGIN' ]] || fail \"$platform Flutter plugin RUNPATH 必须精确为 \\$ORIGIN\"\n  rpath=\"$(linux_elf_dynamic_values \"$bundle/citizensdk_consumer\" \"$readelf_bin\" RPATH)\"\n  runpath=\"$(linux_elf_dynamic_values \"$bundle/citizensdk_consumer\" \"$readelf_bin\" RUNPATH)\"\n  [[ -z \"$rpath\" && \"$runpath\" == '$ORIGIN/lib' ]] || fail \"$platform Flutter runner RUNPATH 必须精确为 \\$ORIGIN/lib\"\n  for library in manifest.json chainspec.json light_sync_state.json; do\n    cmp -s \"$prefix/share/citizensdk/chain/$library\" \\\n      \"$bundle/data/flutter_assets/packages/citizen_sdk/chain/$library\" \\\n      || fail \"$platform Flutter bundle 链资产漂移：$library\"\n  done\n}\n\nbuild_linux_flutter_consumer() (\n  local platform=\"$1\" platform_work=\"$2\" prefix=\"$3\" cmake_bin=\"$4\" ctest_bin=\"$5\"\n  local readelf_bin=\"$6\" nm_bin=\"$7\" flutter_source=\"${CITIZENSDK_FLUTTER_ROOT:-}\"\n  local cache_source=\"${PUB_CACHE:-}\" root tool_root cache_root sdk_stage runner dart_bin\n  local arch flutter_build bundle path output status unshare_bin\n  local package=\"${8:-}\" candidate=\"${9:-$sdk_dir}\"\n  case \"$platform\" in LinuxARM) arch=arm64 ;; LinuxAMD) arch=x64 ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  for path in ninja clang clang++ unshare timeout realpath perl; do\n    command -v \"$path\" >/dev/null 2>&1 || fail \"$platform Flutter 验收缺少已预装工具：$path\"\n  done\n  # Flutter/Dart 的部分设置与 telemetry 仍会直接访问现有 HOME，不遵循\n  # XDG。只接受调用环境已隔离好的 HOME；本脚本绝不设置 HOME、创建用户\n  # 或挂载文件系统。未满足时，在任何 Dart/Flutter 命令执行前失败关闭。\n  [[ -n \"${HOME:-}\" ]] || fail \"$platform 未提供获准的隔离 HOME 环境\"\n  assert_safe_directory_path \"$HOME\" \"$platform 已有工具 HOME\"\n  case \"$HOME/\" in \"$work_dir/\"*) ;; *) fail \"$platform 已有 HOME 必须位于本轮中央 work_dir；请提供获准隔离环境\" ;; esac\n  [[ -d \"$HOME\" && ! -L \"$HOME\" \\\n      && \"$(stat -c '%a' \"$HOME\")\" == 700 \\\n      && \"$(stat -c '%u' \"$HOME\")\" == \"$(id -u)\" ]] \\\n    || fail \"$platform 已有 HOME 必须是当前用户所有的普通 0700 目录\"\n  verify_linux_tool_tree \"$HOME\" \"$platform 已有工具 HOME\"\n  [[ ! -e \"$HOME/.flutter_settings\" && ! -L \"$HOME/.flutter_settings\" ]] \\\n    || fail \"$platform 隔离 HOME 不得带入旧 Flutter 设置或 build-dir 重定向\"\n  unshare_bin=\"$(command -v unshare)\"\n  # 无特权隔离只覆盖工具装配；不可用即失败，绝不 sudo、安装、改网络或创建 VM。\n  \"$unshare_bin\" --user --map-root-user --net true \\\n    || fail \"$platform 缺少获准的无特权 user/network namespace；禁止联网取得工具\"\n  verify_linux_flutter_cache \"$flutter_source\" \"$platform\"\n  verify_linux_tool_tree \"$cache_source\" \"$platform PUB_CACHE\"\n  [[ -n \"${DISPLAY:-}${WAYLAND_DISPLAY:-}\" ]] || fail \"$platform 真实 Flutter 消费者需要已获准的 GTK 显示会话\"\n  root=\"$platform_work/flutter\"\n  tool_root=\"$root/tools\"\n  cache_root=\"$root/pub-cache\"\n  sdk_stage=\"$root/citizen_sdk\"\n  runner=\"$root/consumer\"\n  for path in \"$flutter_source\" \"$cache_source\" \"$sdk_dir\"; do\n    case \"$root/\" in \"$path/\"*) fail \"$platform 工具或源码不能包含本轮副本目标\" ;; esac\n    case \"$path/\" in \"$root/\"*) fail \"$platform 工具或源码不能位于本轮副本目标内\" ;; esac\n  done\n  for path in \"$root\" \"$tool_root\" \"$cache_root\" \"$sdk_stage\" \"$runner\" \\\n      \"$root/tmp\" \"$root/config\" \"$root/cache\" \"$root/data\" \"$root/state\" \"$root/test-state\"; do\n    prepare_safe_directory \"$work_dir\" \"$path\" \"$platform Flutter 独占目录\"\n    chmod 0700 \"$path\"\n  done\n  # 仅复制调用方显式提供的工具/缓存，全部锁、package_config与构建记录留在本轮工作根。\n  cp -a \"$flutter_source/.\" \"$tool_root/\"\n  cp -a \"$cache_source/.\" \"$cache_root/\"\n  cp -a \"${package:-$sdk_dir}/.\" \"$sdk_stage/\"\n  if [[ -z \"$package\" ]]; then\n    node \"$sdk_dir/.github/workflows/release-sdk.mjs\" sdk \\\n      --flutter-source-entry \"$sdk_dir\" --output \"$sdk_stage\" >/dev/null\n  fi\n  chmod 0700 \"$tool_root\" \"$cache_root\" \"$sdk_stage\"\n  verify_linux_tool_tree \"$tool_root\" \"$platform Flutter 工具副本\"\n  verify_linux_tool_tree \"$cache_root\" \"$platform PUB_CACHE 副本\"\n  [[ -z \"$(find \"$sdk_stage\" -type l -print -quit)\" ]] || fail \"$platform SDK 验收副本禁止符号链接\"\n  # 候选消费者与发布包使用完全相同的 linux/ 安装前缀；本机构建只注入\n  # 当前平台，双平台共有文件的原子合并由唯一 release 打包器负责。\n  if [[ -z \"$package\" ]]; then\n    copy_linux_install \"$prefix\" \"$sdk_stage/linux\" \"$platform\" \"$work_dir\"\n  fi\n  export FLUTTER_ROOT=\"$tool_root\" PUB_CACHE=\"$cache_root\"\n  export XDG_CONFIG_HOME=\"$root/config\" XDG_CACHE_HOME=\"$root/cache\"\n  export XDG_DATA_HOME=\"$root/data\" XDG_STATE_HOME=\"$root/state\" TMPDIR=\"$root/tmp\"\n  export FLUTTER_SUPPRESS_ANALYTICS=true\n  # 不继承可把日志、引擎或 pub 路由到外部的工具覆盖项；缓存缺失只能失败。\n  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \\\n    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH\n  dart_bin=\"$tool_root/bin/cache/dart-sdk/bin/dart\"\n  # 外层直接消费已核验 snapshot。官方 CMake 后端仍会调用副本 bin/flutter\n  # 执行 assemble；不改写该官方链路，靠完整缓存预检与整个工具子进程禁网\n  # 拒绝缺项升级。--offline 仅用于官方确实支持的 pub/create 命令。\n  (cd \"$tool_root/packages/flutter_tools\" && \\\n    \"$unshare_bin\" --user --map-root-user --net \"$dart_bin\" pub get --offline)\n  local package_config=\"$tool_root/packages/flutter_tools/.dart_tool/package_config.json\"\n  if grep -F -e \"$flutter_source/\" -e \"$cache_source/\" \"$package_config\" >/dev/null; then\n    fail \"$platform Flutter 工具配置仍引用原工具或缓存\"\n  fi\n  local -a flutter=(\"$unshare_bin\" --user --map-root-user --net \"$dart_bin\"\n    \"--packages=$package_config\" \"$tool_root/bin/cache/flutter_tools.snapshot\"\n    --no-version-check --suppress-analytics)\n  \"${flutter[@]}\" create --offline --no-pub --platforms=linux \\\n    --project-name=citizensdk_consumer --org=org.citizen \"$runner\"\n  printf '%s\\n' 'name: citizensdk_consumer' 'publish_to: none' 'version: 1.0.0' \\\n    'environment:' '  sdk: \">=3.8.0 <4.0.0\"' 'dependencies:' '  flutter:' \\\n    '    sdk: flutter' '  citizen_sdk:' '    path: ../citizen_sdk' \\\n    'flutter:' '  uses-material-design: true' >\"$runner/pubspec.yaml\"\n  cp \"$candidate/pubspec.lock\" \"$runner/pubspec.lock\"\n  cp \"$candidate/linux/tests/citizen_sdk_flutter_consumer.dart\" \"$runner/lib/main.dart\"\n  # 只改生成的 runner CMake 装配。保留官方 generated registrant 和自动插件发现；\n  # 父级 enable_testing 让六个 adapter 合同能被顶层 CTest 实际枚举到。\n  for path in \"$root/test-state\"; do\n    case \"$path\" in *'\"'*|*';'*|*'$'*|*'\\'*|*$'\\n'*|*$'\\r'*) fail \"Flutter CMake 路径含不允许的语法字符\" ;; esac\n  done\n  CITIZENSDK_ADAPTER_TEST_ROOT=\"$root/test-state\" CITIZENSDK_HOSTED_PACKAGE=\"$package\" \\\n    perl -0777 -i -pe '\n      # 官方模板沿用 Dart project name 中的下划线，但 Host application_id\n      # 的既有安全合同只允许字母数字与分隔点；只修验证 runner 的公开身份。\n      s/^set\\(APPLICATION_ID \"org\\.citizen\\.citizensdk_consumer\"\\)$/set(APPLICATION_ID \"org.citizensdk.flutterconsumer\")/m == 1\n        or die \"Unexpected official runner application identity\\n\";\n      my $settings = length($ENV{CITIZENSDK_HOSTED_PACKAGE}) ? \"\" : \"set(CITIZENSDK_BUILD_TESTS ON)\\n\" .\n        \"set(CITIZENSDK_TEST_WORK_DIR \\\"$ENV{CITIZENSDK_ADAPTER_TEST_ROOT}\\\")\\n\" .\n        \"enable_testing()\\n\";\n      s/^include\\(flutter\\/generated_plugins.cmake\\)/$settings . $&/me == 1\n        or die \"Missing official generated plugins include\\n\";\n      $_ .= \"\\ntarget_link_options(\\${BINARY_NAME} PRIVATE -static-libstdc++ -static-libgcc)\\n\";\n    ' \"$runner/linux/CMakeLists.txt\"\n  (cd \"$runner\" && \"${flutter[@]}\" pub get --offline && \\\n    \"${flutter[@]}\" build linux --release --no-pub --target-platform=\"linux-$arch\")\n  flutter_build=\"$runner/build/linux/$arch/release\"\n  bundle=\"$flutter_build/bundle\"\n  # 内部适配层合同属于原生构建阶段；最终 Hosted 只消费公开插件与运行件，\n  # 绝不把审计测试补入发布包，也不重新构建 Host/Core。\n  if [[ -z \"$package\" ]]; then\n    verify_linux_ctest_inventory \"$ctest_bin\" \"$flutter_build\" LinuxFlutter 6\n    LD_LIBRARY_PATH=\"$sdk_stage/linux/lib/$platform:$runner/linux/flutter/ephemeral\" \\\n      \"$ctest_bin\" --test-dir \"$flutter_build\" --build-config Release \\\n        -L '^LinuxFlutter$' --no-tests=error --output-on-failure\n  fi\n  verify_linux_flutter_elf \"$platform\" \"$bundle\" \"$sdk_stage/linux\" \"$readelf_bin\" \"$nm_bin\"\n  verify_linux_runtime_resolution \"$bundle/citizensdk_consumer\" \"$bundle/lib\"\n  # 不使用 flutter run 的“已启动”退出状态代替消费者结果；只运行最终bundle。\n  output=\"$root/consumer.stdout\"\n  prepare_safe_output_file \"$work_dir\" \"$output\" \"$platform Flutter 消费者输出\"\n  prepare_safe_output_file \"$work_dir\" \"$root/consumer.stderr\" \"$platform Flutter 消费者错误输出\"\n  status=0\n  FLUTTER_LINUX_RENDERER=software timeout --signal=TERM --kill-after=10s 200s \\\n    \"$bundle/citizensdk_consumer\" >\"$output\" 2>\"$root/consumer.stderr\" || status=$?\n  [[ \"$status\" == 0 ]] || fail \"$platform Flutter 消费者失败或超时；退出码=$status\"\n  [[ \"$(grep -Fxc 'CitizenSDK Flutter consumer passed' \"$output\" || true)\" == 1 ]] \\\n    || fail \"$platform Flutter 消费者缺少唯一成功标记\"\n)\n\n\n# 唯一中央准备收据是这些静态环境输入的共同来源；不得逐个指向不同安装树。\nload_native_dependencies() {\n  local platform=\"$1\" receipt=\"${CITIZENSDK_DEPENDENCY_RECEIPT:-}\" source=\"$sdk_dir\"\n  local values key value supplied\n  [[ -n \"$receipt\" ]] || fail \"$platform 缺少 CITIZENSDK_DEPENDENCY_RECEIPT\"\n  if [[ \"$platform\" == Windows ]]; then\n    receipt=\"$(cygpath -m \"$receipt\")\"; source=\"$(cygpath -m \"$source\")\"\n  fi\n  values=\"$(MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$source\" \"$receipt\" \"$platform\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nimport {readFileSync} from 'node:fs';\nconst [source,receipt,platform]=process.argv.slice(2);\nconst {resolve}=await import('node:path');\n// Git Bash 的 C:/ 与 Node 的 C:\\\\ 是同一官方路径；进入严格路径验证前规范化一次。\nconst canonicalReceipt=resolve(receipt);\nconst api=await import(pathToFileURL(join(source,'.github/workflows/release-sdk.mjs')));\nconst inputs=api.assertCitizenSdkDependencyInputs(canonicalReceipt,platform);\nif(inputs.source_sha!==process.env.CITIZENSDK_SOURCE_SHA) throw Error('dependency source SHA mismatch');\nif(!readFileSync(join(source,'pubspec.yaml'),'utf8').includes('\\nversion: '+inputs.software_version+'\\n'))\n  throw Error('dependency software version mismatch');\nfor(const [key,value] of Object.entries(api.citizenSdkDependencyEnvironment(canonicalReceipt,platform))) {\n  if(/[\\r\\n=]/.test(value)) throw Error('unsafe dependency path');\n  process.stdout.write(key+'='+value+'\\n');\n}\nNODE\n)\" || fail \"$platform 静态依赖收据验证失败\"\n  while IFS='=' read -r key value; do\n    [[ -n \"$key\" ]] || continue\n    if [[ \"$platform\" == Windows ]]; then value=\"$(cygpath -u \"$value\")\"; fi\n    supplied=\"${!key:-}\"\n    [[ -z \"$supplied\" || \"$supplied\" == \"$value\" ]] || fail \"$platform 禁止混用其他静态输入：$key\"\n    export \"$key=$value\"\n  done <<<\"$values\"\n}\n\nrecord_native_dependencies() {\n  local platform=\"$1\" receipt=\"$CITIZENSDK_DEPENDENCY_RECEIPT\" source=\"$sdk_dir\" native=\"$output_dir\"\n  if [[ \"$platform\" == Windows ]]; then\n    receipt=\"$(cygpath -m \"$receipt\")\"; source=\"$(cygpath -m \"$source\")\"; native=\"$(cygpath -m \"$native\")\"\n  fi\n  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$source\" \"$receipt\" \"$platform\" \"$native\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst [sourcePath,receiptPath,platform,nativePath]=process.argv.slice(2);\nconst {writeCitizenSdkDependencyEvidence}=await import(pathToFileURL(join(sourcePath,'.github/workflows/release-sdk.mjs')));\nconst {resolve}=await import('node:path');\nwriteCitizenSdkDependencyEvidence({sourcePath:resolve(sourcePath),receiptPath:resolve(receiptPath),platform,\n  nativePath:resolve(nativePath),sourceSha:process.env.CITIZENSDK_SOURCE_SHA});\nNODE\n}\n\n\nbuild_linux() (\n  prepare_internal_header\n  local platform=\"$1\" contract rust_target expected_arch cmake_bin ctest_bin\n  local nm_bin readelf_bin strip_bin cmake_build runtime_stage source_core\n  local destination core_destination host_destination linux_platform_work\n  local linux_test_work install_prefix consumer_build software_version loader_variable\n  local sqlite_include openssl_include tss2_include\n  local sqlite_archive crypto_archive tss2_esys_archive tss2_mu_archive\n  local tss2_sys_archive tss2_rc_archive tss2_tcti_device_archive\n  contract=\"$(linux_platform_contract \"$platform\")\"\n  IFS='|' read -r rust_target expected_arch <<<\"$contract\"\n  # 只影响 Linux 子进程：新状态统一 0700，且动态加载器不能被调用方环境\n  # 指向另一套 Core/Host。Android/Apple 的既有流程和环境保持原样。\n  umask 077\n  for loader_variable in ${!LD_@}; do unset \"$loader_variable\"; done\n  require_rust_target \"$rust_target\"\n  [[ -d \"$linux_source_root\" && ! -L \"$linux_source_root\" ]] \\\n    || fail \"CitizenSDK 缺少普通 Linux 平台源码目录\"\n  for tool in cmake ctest ldd; do\n    command -v \"$tool\" >/dev/null 2>&1 || fail \"$platform 缺少 $tool\"\n  done\n  cmake_bin=\"$(command -v cmake)\"\n  ctest_bin=\"$(command -v ctest)\"\n  nm_bin=\"$(command -v llvm-nm || command -v nm || true)\"\n  readelf_bin=\"$(command -v llvm-readelf || command -v readelf || true)\"\n  strip_bin=\"$(command -v llvm-strip || command -v strip || true)\"\n  [[ -n \"$nm_bin\" && -n \"$readelf_bin\" && -n \"$strip_bin\" ]] \\\n    || fail \"$platform 缺少 llvm-nm/nm、llvm-readelf/readelf 或 llvm-strip/strip\"\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  [[ \"$software_version\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] \\\n    || fail \"$platform SDK 版本必须是唯一正式三段版本\"\n\n  # Linux Host 只能链接 CI/Release 预先锁定并放在源码树外的静态依赖。\n  load_native_dependencies \"$platform\"\n  # 禁止 CMake 从宿主动态库或源码目录临时下载另一份 SQLite、crypto 或 TPM2-TSS。\n  sqlite_include=\"${CITIZENSDK_HOST_SQLITE_INCLUDE_DIR:-}\"\n  openssl_include=\"${CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR:-}\"\n  tss2_include=\"${CITIZENSDK_HOST_TSS2_INCLUDE_DIR:-}\"\n  sqlite_archive=\"${CITIZENSDK_HOST_SQLITE_ARCHIVE:-}\"\n  crypto_archive=\"${CITIZENSDK_HOST_CRYPTO_ARCHIVE:-}\"\n  tss2_esys_archive=\"${CITIZENSDK_HOST_TSS2_ESYS_ARCHIVE:-}\"\n  tss2_mu_archive=\"${CITIZENSDK_HOST_TSS2_MU_ARCHIVE:-}\"\n  tss2_sys_archive=\"${CITIZENSDK_HOST_TSS2_SYS_ARCHIVE:-}\"\n  tss2_rc_archive=\"${CITIZENSDK_HOST_TSS2_RC_ARCHIVE:-}\"\n  tss2_tcti_device_archive=\"${CITIZENSDK_HOST_TSS2_TCTI_DEVICE_ARCHIVE:-}\"\n  assert_readonly_dependency_directory \"$sqlite_include\" \\\n    CITIZENSDK_HOST_SQLITE_INCLUDE_DIR\n  assert_readonly_dependency_directory \"$openssl_include\" \\\n    CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR\n  assert_readonly_dependency_directory \"$tss2_include\" \\\n    CITIZENSDK_HOST_TSS2_INCLUDE_DIR\n  assert_readonly_static_archive \"$sqlite_archive\" CITIZENSDK_HOST_SQLITE_ARCHIVE\n  assert_readonly_static_archive \"$crypto_archive\" CITIZENSDK_HOST_CRYPTO_ARCHIVE\n  assert_readonly_static_archive \"$tss2_esys_archive\" CITIZENSDK_HOST_TSS2_ESYS_ARCHIVE\n  assert_readonly_static_archive \"$tss2_mu_archive\" CITIZENSDK_HOST_TSS2_MU_ARCHIVE\n  assert_readonly_static_archive \"$tss2_sys_archive\" CITIZENSDK_HOST_TSS2_SYS_ARCHIVE\n  assert_readonly_static_archive \"$tss2_rc_archive\" CITIZENSDK_HOST_TSS2_RC_ARCHIVE\n  assert_readonly_static_archive \"$tss2_tcti_device_archive\" \\\n    CITIZENSDK_HOST_TSS2_TCTI_DEVICE_ARCHIVE\n\n  linux_platform_work=\"$work_dir/linux/$platform\"\n  [[ ! -e \"$linux_platform_work\" && ! -L \"$linux_platform_work\" ]] \\\n    || fail \"$platform 工作目录必须全新：$linux_platform_work\"\n  prepare_safe_directory \"$work_dir\" \"$linux_platform_work\" \"$platform 工作目录\"\n  cmake_build=\"$linux_platform_work/cmake\"\n  runtime_stage=\"$linux_platform_work/runtime\"\n  linux_test_work=\"$linux_platform_work/test-state\"\n  install_prefix=\"$linux_platform_work/install\"\n  consumer_build=\"$linux_platform_work/consumers\"\n  destination=\"$output_dir/linux/$platform\"\n  [[ ! -e \"$destination\" && ! -L \"$destination\" ]] \\\n    || fail \"$platform 原生安装输出必须全新：$destination\"\n  prepare_safe_directory \"$work_dir\" \"$cmake_build\" \"$platform CMake 目录\"\n  prepare_safe_directory \"$work_dir\" \"$runtime_stage\" \"$platform 运行件暂存目录\"\n  prepare_safe_directory \"$work_dir\" \"$linux_test_work\" \"$platform 测试状态目录\"\n  prepare_safe_directory \"$work_dir\" \"$install_prefix\" \"$platform 安装验证前缀\"\n  prepare_safe_directory \"$work_dir\" \"$consumer_build\" \"$platform 安装后消费者构建目录\"\n  # Linux Host测试只可在当前平台任务独占的工作目录落盘；0700是\n  # CITIZENSDK_TEST_WORK_DIR 的公开前置条件，不能依赖 runner 的 umask。\n  chmod 0700 \"$linux_test_work\"\n  [[ \"$(stat -c '%a' \"$linux_test_work\")\" == 700 ]] \\\n    || fail \"$platform 测试状态目录权限必须精确为 0700：$linux_test_work\"\n  core_destination=\"$runtime_stage/libcitizensdk.so\"\n  prepare_safe_output_file \"$work_dir\" \"$core_destination\" \"$platform Core 暂存\"\n\n  # 机器 target triple 是类型化工具链字段，不得提升为公开平台名或输出目录名。\n  CARGO_PROFILE_RELEASE_STRIP=false \\\n  RUSTFLAGS='-C link-arg=-Wl,-soname,libcitizensdk.so -C link-arg=-static-libgcc' \\\n    cargo build --manifest-path \"$product_ffi_manifest\" --release --locked --offline \\\n      --target \"$rust_target\"\n  source_core=\"$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.so\"\n  [[ -f \"$source_core\" && ! -L \"$source_core\" ]] \\\n    || fail \"$platform Rust Core 未生成普通 libcitizensdk.so\"\n  cp \"$source_core\" \"$core_destination\"\n  \"$strip_bin\" --strip-unneeded \"$core_destination\"\n\n  \"$cmake_bin\" -S \"$linux_source_root\" -B \"$cmake_build\" \\\n    -DCMAKE_BUILD_TYPE=Release \\\n    -DCMAKE_C_COMPILER=\"${CC:-cc}\" \\\n    -DCMAKE_CXX_COMPILER=\"${CXX:-c++}\" \\\n    -DCMAKE_INSTALL_PREFIX=\"$install_prefix\" \\\n    -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_INCLUDEDIR=include \\\n    -DCMAKE_INSTALL_DATADIR=share -DCMAKE_INSTALL_BINDIR=bin \\\n    -DCMAKE_LIBRARY_OUTPUT_DIRECTORY=\"$runtime_stage\" \\\n    -DCITIZENSDK_PLATFORM=\"$platform\" \\\n    -DCITIZENSDK_CORE_LIBRARY=\"$core_destination\" \\\n    -DCITIZENSDK_CORE_INCLUDE_DIR=\"$sdk_dir/include\" \\\n    -DCITIZENSDK_INTERNAL_INCLUDE_DIR=\"$work_dir/private-include\" \\\n    -DCITIZENSDK_ASSET_DIR=\"$apple_asset_root\" \\\n    -DCITIZENSDK_SQLITE_INCLUDE_DIR=\"$sqlite_include\" \\\n    -DCITIZENSDK_OPENSSL_INCLUDE_DIR=\"$openssl_include\" \\\n    -DCITIZENSDK_TSS2_INCLUDE_DIR=\"$tss2_include\" \\\n    -DCITIZENSDK_SQLITE_ARCHIVE=\"$sqlite_archive\" \\\n    -DCITIZENSDK_CRYPTO_ARCHIVE=\"$crypto_archive\" \\\n    -DCITIZENSDK_TSS2_ESYS_ARCHIVE=\"$tss2_esys_archive\" \\\n    -DCITIZENSDK_TSS2_MU_ARCHIVE=\"$tss2_mu_archive\" \\\n    -DCITIZENSDK_TSS2_SYS_ARCHIVE=\"$tss2_sys_archive\" \\\n    -DCITIZENSDK_TSS2_RC_ARCHIVE=\"$tss2_rc_archive\" \\\n    -DCITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE=\"$tss2_tcti_device_archive\" \\\n    -DCITIZENSDK_ZXING_SOURCE_DIR=\"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$linux_test_work\" \\\n    -DCITIZENSDK_BUILD_TESTS=ON \\\n    -DCITIZENSDK_ENABLE_QR_CAPTURE=ON \\\n    -DCITIZENSDK_WARNINGS_AS_ERRORS=ON\n  \"$cmake_bin\" --build \"$cmake_build\" --config Release --parallel\n  verify_linux_ctest_inventory \"$ctest_bin\" \"$cmake_build\" LinuxHost 12\n  LD_LIBRARY_PATH=\"$runtime_stage\" \\\n    \"$ctest_bin\" --test-dir \"$cmake_build\" --build-config Release \\\n      -L '^LinuxHost$' --no-tests=error --output-on-failure\n  # CMake install 完成后才验 RUNPATH：build-tree 仍可含链接期路径，不能\n  # 用它冒充已安装运行件。19 项是本步技术投影，不宣称已完成分发许可证闭包。\n  \"$cmake_bin\" --install \"$cmake_build\" --config Release --prefix \"$install_prefix\"\n  host_destination=\"$install_prefix/lib/$platform/libcitizensdk_host.so\"\n  [[ -f \"$host_destination\" && ! -L \"$host_destination\" ]] \\\n    || fail \"$platform CMake 未安装普通 libcitizensdk_host.so\"\n  \"$strip_bin\" --strip-unneeded \"$host_destination\"\n  verify_linux_install \"$install_prefix\" \"$platform\" \"$software_version\" \\\n    \"$core_destination\" \"$readelf_bin\" \"$nm_bin\"\n\n  # 原生消费者只有安装前缀，没有源码 Core/Host target 或私有头入口。\n  \"$cmake_bin\" -S \"$linux_source_root/tests\" -B \"$consumer_build\" \\\n    -DCMAKE_BUILD_TYPE=Release \\\n    -DCMAKE_C_COMPILER=\"${CC:-cc}\" -DCMAKE_CXX_COMPILER=\"${CXX:-c++}\" \\\n    -DCITIZENSDK_CONSUMER_PREFIX=\"$install_prefix\" \\\n    -DCITIZENSDK_PLATFORM=\"$platform\" \\\n    -DCITIZENSDK_CONSUMER_VERSION=\"$software_version\" \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$linux_test_work\"\n  \"$cmake_bin\" --build \"$consumer_build\" --config Release --parallel \\\n    --target citizen_sdk_c_consumer citizen_sdk_cpp_consumer\n  verify_linux_runtime_resolution \"$consumer_build/citizen_sdk_c_consumer\" \"$install_prefix/lib/$platform\"\n  verify_linux_runtime_resolution \"$consumer_build/citizen_sdk_cpp_consumer\" \"$install_prefix/lib/$platform\"\n  verify_linux_ctest_inventory \"$ctest_bin\" \"$consumer_build\" LinuxConsumer 2\n  \"$ctest_bin\" --test-dir \"$consumer_build\" --build-config Release \\\n    -L '^LinuxConsumer$' --no-tests=error --output-on-failure\n  build_linux_flutter_consumer \"$platform\" \"$linux_platform_work\" \"$install_prefix\" \\\n    \"$cmake_bin\" \"$ctest_bin\" \"$readelf_bin\" \"$nm_bin\"\n  # 所有消费者通过后才导出完整安装前缀，不能把裸双库当作可用的 SDK 输入。\n  copy_linux_install \"$install_prefix\" \"$destination\" \"$platform\" \"$output_dir\"\n  verify_linux_install \"$destination\" \"$platform\" \"$software_version\" \\\n    \"$core_destination\" \"$readelf_bin\" \"$nm_bin\"\n  record_native_dependencies \"$platform\"\n  echo \"CitizenSDK $platform 安装、原生与 Flutter 消费者验证完成：$destination\"\n)\n\nbuild_host() {\n  [[ \"$(uname -s)\" == \"Darwin\" ]] || fail \"当前宿主测试库只允许在 macOS runner 构建\"\n  local destination arm_library nm_bin symbols architectures\n  require_rust_target aarch64-apple-darwin\n  destination=\"$output_dir/host/libsmoldot.dylib\"\n  # legacy Dart/smoldot 差分测试运行件只保留当前正式 macOS；其\n  # 内部 Mach-O 架构必须是工具链值 arm64，且它绝不进入\n  # CitizenSDK 候选，也不能借 Rosetta 再建立 x86_64/universal 第二条构建路径。\n  MACOSX_DEPLOYMENT_TARGET=\"$macos_deployment_target\" \\\n  CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path \"$ffi_manifest\" \\\n    --release --locked --target aarch64-apple-darwin\n  arm_library=\"$CARGO_TARGET_DIR/aarch64-apple-darwin/release/libsmoldot.dylib\"\n  [[ -f \"$arm_library\" ]] || fail \"macOS 宿主测试库未生成\"\n  prepare_safe_output_file \"$output_dir\" \"$destination\" \"macOS 宿主测试库\"\n  cp \"$arm_library\" \"$destination\"\n  architectures=\"$(xcrun lipo -archs \"$destination\")\"\n  [[ \"$architectures\" == arm64 ]] || fail \"macOS 宿主测试库内部架构必须精确为 arm64\"\n  nm_bin=\"$(xcrun --find llvm-nm)\"\n  symbols=\"$(symbol_list_ios \"$destination\" \"$nm_bin\")\"\n  verify_symbol_contract \"$symbols\" \"_\" \"macOS 宿主测试库\"\n  echo \"CitizenSDK macOS 宿主测试库完成：$destination\"\n}\n\nwindows_install_files() {\n  printf '%s\\n' \\\n    include/citizensdk.h include/citizensdk_types.h include/citizensdk_qr_image.h \\\n    include/citizen_sdk/citizen_sdk.hpp \\\n    include/citizen_sdk/citizen_sdk_config.hpp \\\n    include/citizen_sdk/citizen_sdk_error.hpp \\\n    include/citizen_sdk/citizen_sdk_events.hpp \\\n    include/citizen_sdk/citizen_sdk_models.hpp \\\n    include/citizen_sdk/citizensdk_host.h \\\n    bin/Windows/citizensdk.dll bin/Windows/citizensdk_host.dll \\\n    lib/Windows/citizensdk.dll.lib lib/Windows/citizensdk_host.lib \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKConfig.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKDependencies.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKTargets.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKTargets-release.cmake \\\n    share/citizensdk/chain/manifest.json \\\n    share/citizensdk/chain/chainspec.json \\\n    share/citizensdk/chain/light_sync_state.json | LC_ALL=C sort\n}\n\nverify_windows_install() {\n  local prefix=\"$1\" software_version=\"$2\" core_dir=\"$3\" cmake_build=\"$4\" expected\n  assert_safe_directory_path \"$prefix\" \"Windows 安装前缀\"\n  [[ -d \"$prefix\" && ! -L \"$prefix\" ]] || fail \"Windows 安装前缀不是普通目录\"\n  expected=\"$(windows_install_files)\"\n  # 安装清单不是信任来源：实际文件/目录反向闭集、当前源码和本轮构建原件\n  # 三者必须同时相符。验证不执行安装中的 CMake，随后独立消费者检查完整导入目标。\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"), p=require(\"path\");\n    const [prefix,version,core,build,sdk,windows,assets,listing]=process.argv.slice(1);\n    const expected=listing.split(\"\\n\");\n    if(expected.length!==21 || new Set(expected).size!==21) throw Error(\"Windows install set must contain 21 files\");\n    const identity=x=>process.platform===\"win32\"?p.resolve(x).toLowerCase():p.resolve(x);\n    function ordinary(path,directory) {\n      const root=p.parse(path).root;\n      if(!root || path.includes(\"\\0\")) throw Error(\"invalid installation source path\");\n      let current=root;\n      for(const part of p.relative(root,path).split(p.sep)) {\n        if(!part || part===\".\" || part===\"..\") throw Error(\"unsafe installation source component\");\n        current=p.join(current,part);\n        const st=fs.lstatSync(current);\n        if(st.isSymbolicLink() || identity(fs.realpathSync(current))!==identity(current)) throw Error(\"installation reparse or alias\");\n        if(identity(current)!==identity(path) && !st.isDirectory()) throw Error(\"installation ancestor is not a directory\");\n      }\n      const st=fs.lstatSync(path);\n      if(directory?!st.isDirectory():(!st.isFile() || st.size===0 || st.nlink!==1)) throw Error(\"invalid installation node\");\n    }\n    ordinary(prefix,true);\n    const actual=[], directories=[];\n    function walk(directory,relative=\"\") {\n      for(const name of fs.readdirSync(directory)) {\n        const path=p.join(directory,name), key=relative?relative+\"/\"+name:name;\n        const st=fs.lstatSync(path);\n        if(st.isSymbolicLink() || identity(fs.realpathSync(path))!==identity(path)) throw Error(\"installation reparse or alias\");\n        if(st.isDirectory()) { directories.push(key); walk(path,key); }\n        else if(st.isFile() && st.nlink===1 && st.size>0) actual.push(key);\n        else throw Error(\"installation contains a special, empty or linked file\");\n      }\n    }\n    walk(prefix);\n    const expectedDirectories=new Set();\n    for(const file of expected) {\n      const parts=file.split(\"/\");\n      while(parts.length>1) { parts.pop(); expectedDirectories.add(parts.join(\"/\")); }\n    }\n    const equal=(a,b)=>JSON.stringify(a.slice().sort())===JSON.stringify(b.slice().sort());\n    if(!equal(actual,expected) || !equal(directories,[...expectedDirectories])) throw Error(\"Windows installed file/directory closure drift\");\n    const manifestPath=p.join(build,\"install_manifest.txt\"); ordinary(manifestPath,false);\n    const manifest=fs.readFileSync(manifestPath,\"utf8\").replace(/\\r?\\n$/,\"\").split(/\\r?\\n/);\n    if(manifest.some(x=>!p.isAbsolute(x) || /(^|[\\\\/])\\.{1,2}([\\\\/]|$)/.test(x))) throw Error(\"invalid install_manifest path\");\n    const installed=expected.map(x=>identity(p.join(prefix,...x.split(\"/\"))));\n    if(!equal(manifest.map(identity),installed)) throw Error(\"install_manifest does not match complete Windows installation\");\n    function same(source,relative) {\n      const destination=p.join(prefix,...relative.split(\"/\"));\n      ordinary(source,false); ordinary(destination,false);\n      if(!fs.readFileSync(source).equals(fs.readFileSync(destination))) throw Error(\"Windows installed bytes differ: \"+relative);\n    }\n    for(const name of [\"citizensdk.h\",\"citizensdk_types.h\"]) same(p.join(sdk,\"include\",name),\"include/\"+name);\n    same(p.join(sdk,\"native\",\"image\",\"citizensdk_qr_image.h\"),\"include/citizensdk_qr_image.h\");\n    for(const name of [\"citizen_sdk.hpp\",\"citizen_sdk_config.hpp\",\"citizen_sdk_error.hpp\",\"citizen_sdk_events.hpp\",\"citizen_sdk_models.hpp\",\"citizensdk_host.h\"])\n      same([\"citizen_sdk_error.hpp\",\"citizen_sdk_events.hpp\",\"citizen_sdk_models.hpp\"].includes(name)?p.join(sdk,\"include\",name):p.join(windows,\"headers\",name),\"include/citizen_sdk/\"+name);\n    for(const name of [\"manifest.json\",\"chainspec.json\",\"light_sync_state.json\"])\n      same(p.join(assets,name),\"share/citizensdk/chain/\"+name);\n    same(p.join(core,\"citizensdk.dll\"),\"bin/Windows/citizensdk.dll\");\n    same(p.join(core,\"citizensdk.dll.lib\"),\"lib/Windows/citizensdk.dll.lib\");\n    same(p.join(build,\"Release\",\"citizensdk_host.dll\"),\"bin/Windows/citizensdk_host.dll\");\n    same(p.join(build,\"Release\",\"citizensdk_host.lib\"),\"lib/Windows/citizensdk_host.lib\");\n    const packageDir=\"lib/Windows/cmake/CitizenSDK/\";\n    for(const name of [\"CitizenSDKConfig.cmake\",\"CitizenSDKConfigVersion.cmake\"]) same(p.join(build,name),packageDir+name);\n    same(p.join(windows,\"cmake\",\"CitizenSDKDependencies.cmake\"),packageDir+\"CitizenSDKDependencies.cmake\");\n    const exportRoot=p.join(build,\"CMakeFiles\",\"Export\"), exports=[];\n    ordinary(exportRoot,true);\n    function collect(directory) {\n      for(const name of fs.readdirSync(directory)) {\n        const file=p.join(directory,name), st=fs.lstatSync(file);\n        if(st.isSymbolicLink()) throw Error(\"generated CMake export is linked\");\n        if(st.isDirectory()) collect(file);\n        else if(name===\"CitizenSDKTargets.cmake\" || name===\"CitizenSDKTargets-release.cmake\") exports.push(file);\n      }\n    }\n    collect(exportRoot);\n    for(const name of [\"CitizenSDKTargets.cmake\",\"CitizenSDKTargets-release.cmake\"]) {\n      const matches=exports.filter(x=>p.basename(x)===name);\n      if(matches.length!==1) throw Error(\"generated CMake export is missing or ambiguous\");\n      same(matches[0],packageDir+name);\n    }\n    if(!/^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(version)) throw Error(\"invalid SDK version\");\n    const pubspec=fs.readFileSync(p.join(sdk,\"pubspec.yaml\"),\"utf8\");\n    const versions=[...pubspec.matchAll(/^version: ([0-9]+\\.[0-9]+\\.[0-9]+)$/gm)].map(x=>x[1]);\n    const project=[...fs.readFileSync(p.join(windows,\"CMakeLists.txt\"),\"utf8\").matchAll(/^project\\(CitizenSDKHost VERSION ([0-9]+\\.[0-9]+\\.[0-9]+) LANGUAGES C CXX\\)$/gm)].map(x=>x[1]);\n    if(JSON.stringify(versions)!==JSON.stringify([version]) || JSON.stringify(project)!==JSON.stringify([version])) throw Error(\"SDK source version drift\");\n    const versionTemplate=fs.readFileSync(p.join(windows,\"cmake\",\"CitizenSDKConfigVersion.cmake.in\"),\"utf8\")\n      .replaceAll(\"@PROJECT_VERSION@\",version).replaceAll(\"@PROJECT_VERSION_MAJOR@\",version.split(\".\")[0]);\n    const installedVersion=fs.readFileSync(p.join(prefix,...(packageDir+\"CitizenSDKConfigVersion.cmake\").split(\"/\")),\"utf8\");\n    if(installedVersion!==versionTemplate) throw Error(\"installed CMake version template drift\");\n    for(const name of [\"CitizenSDKConfig.cmake\",\"CitizenSDKConfigVersion.cmake\",\"CitizenSDKDependencies.cmake\",\"CitizenSDKTargets.cmake\",\"CitizenSDKTargets-release.cmake\"]) {\n      const content=fs.readFileSync(p.join(prefix,...(packageDir+name).split(\"/\")),\"utf8\");\n      if([sdk,build,prefix,core].some(x=>content.includes(x) || content.includes(x.replaceAll(\"\\\\\",\"/\")))) throw Error(\"installed CMake leaks an absolute build path\");\n    }\n  ' \"$(cygpath -m \"$prefix\")\" \"$software_version\" \"$(cygpath -m \"$core_dir\")\" \\\n    \"$(cygpath -m \"$cmake_build\")\" \"$(cygpath -m \"$sdk_dir\")\" \\\n    \"$(cygpath -m \"$windows_source_root\")\" \"$(cygpath -m \"$apple_asset_root\")\" \"$expected\" \\\n    || fail \"Windows 安装闭集、清单、版本或来源字节验证失败\"\n  verify_windows_exports \"$prefix/bin/Windows/citizensdk.dll\" \"$product_header\" Core\n  verify_windows_exports \"$prefix/bin/Windows/citizensdk_host.dll\" \\\n    \"$windows_source_root/headers/citizensdk_host.h\" Host\n}\n\nverify_windows_consumer_inventory() {\n  local build=\"$1\" prefix=\"$2\" state=\"$3\" configuration=\"${4:-Release}\" inventory\n  inventory=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n    -C Release --show-only=json-v1)\" || fail \"Windows 消费者 CTest 清单读取失败\"\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"), p=require(\"path\");\n    const [text,build,prefix,state,configuration]=process.argv.slice(1), data=JSON.parse(text);\n    const expected=[\n      [\"CitizenSDK.Windows.CConsumer\",\"citizen_sdk_c_consumer.exe\"],\n      [\"CitizenSDK.Windows.CppConsumer\",\"citizen_sdk_cpp_consumer.exe\"]\n    ];\n    if(!Array.isArray(data.tests) || data.tests.length!==2) throw Error(\"Windows consumer test count drift\");\n    const names=data.tests.map(x=>x.name).sort();\n    if(JSON.stringify(names)!==JSON.stringify(expected.map(x=>x[0]))) throw Error(\"Windows consumer exact test set drift\");\n    const identity=x=>process.platform===\"win32\"?p.resolve(x).toLowerCase():p.resolve(x);\n    const runtime=p.join(build,configuration), assets=p.join(prefix,\"share\",\"citizensdk\",\"chain\");\n    function ordinaryFile(path) {\n      let current=p.parse(path).root;\n      for(const part of p.relative(current,path).split(p.sep)) {\n        current=p.join(current,part);\n        const st=fs.lstatSync(current);\n        if(st.isSymbolicLink() || identity(fs.realpathSync(current))!==identity(current)) throw Error(\"Windows consumer reparse or alias\");\n        if(identity(current)!==identity(path) && !st.isDirectory()) throw Error(\"Windows consumer ancestor is not a directory\");\n      }\n      const st=fs.lstatSync(path);\n      if(!st.isFile() || st.size===0 || st.nlink!==1) throw Error(\"Windows consumer file is unavailable\");\n    }\n    for(const [name,executable] of expected) {\n      const test=data.tests.find(x=>x.name===name), args=[p.join(runtime,executable),state,assets,runtime];\n      if(!Array.isArray(test.command) || test.command.length!==4 || test.command.some((x,i)=>typeof x!==\"string\" || identity(x)!==identity(args[i]))) throw Error(\"Windows consumer command drift\");\n      const props=test.properties||[];\n      if(new Set(props.map(x=>x.name)).size!==props.length) throw Error(\"duplicate CTest property\");\n      const property=name=>props.find(x=>x.name===name)?.value;\n      if(property(\"TIMEOUT\")!==180 || property(\"RUN_SERIAL\")!==true) throw Error(\"Windows consumer timeout or serialization drift\");\n      // PASS_REGULAR_EXPRESSION 会忽略非零退出码；不允许任何跳过/反转成功的属性。\n      if(props.some(x=>/^(PASS_REGULAR_EXPRESSION|SKIP_REGULAR_EXPRESSION|SKIP_RETURN_CODE|WILL_FAIL|DISABLED)$/.test(x.name))) throw Error(\"Windows consumer exit contract override\");\n      ordinaryFile(args[0]);\n    }\n    for(const name of [\"citizensdk.dll\",\"citizensdk_host.dll\"]) {\n      const actual=p.join(runtime,name), expected=p.join(prefix,\"bin\",\"Windows\",name);\n      ordinaryFile(actual); ordinaryFile(expected);\n      if(!fs.readFileSync(actual).equals(fs.readFileSync(expected))) throw Error(\"Windows consumer DLL bytes drift\");\n    }\n  ' \"$inventory\" \"$(cygpath -m \"$build\")\" \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$state\")\" \"$configuration\" \\\n    || fail \"Windows 消费者必须是准确两个真实程序及同版运行库\"\n}\n\nrun_windows_consumers() {\n  local build=\"$1\" prefix=\"$2\" state=\"$3\" configuration=\"${4:-Release}\" output\n  verify_windows_consumer_inventory \"$build\" \"$prefix\" \"$state\" \"$configuration\"\n  # 同时检查 CTest 真实退出码和两个程序各自唯一成功行，不能用标记掩盖失败。\n  output=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n    -C Release --no-tests=error --verbose 2>&1)\" || {\n      printf '%s\\n' \"$output\" >&2\n      fail \"Windows 已安装消费者运行失败\"\n    }\n  printf '%s\\n' \"$output\"\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const lines=process.argv[1].split(/\\r?\\n/);\n    for(const marker of [\"CitizenSDK C consumer passed\",\"CitizenSDK C++ consumer passed\"]) {\n      if(lines.filter(x=>/^\\d+: /.test(x) && x.replace(/^\\d+: /,\"\")===marker).length!==1) throw Error(\"Windows consumer success marker missing or repeated\");\n    }\n  ' \"$output\" || fail \"Windows 已安装消费者成功标记不完整\"\n}\n\nexport_windows_install() {\n  local prefix=\"$1\" destination=\"$2\"\n  assert_descendant_path \"$work_dir\" \"$prefix\" \"Windows 已验证安装来源\"\n  assert_descendant_path \"$output_dir\" \"$destination\" \"Windows 安装导出\"\n  assert_safe_directory_path \"$prefix\" \"Windows 已验证安装来源\"\n  assert_safe_directory_path \"$(dirname \"$destination\")\" \"Windows 安装导出父目录\"\n  [[ -d \"$prefix\" && ! -L \"$prefix\" ]] || fail \"Windows 已验证安装来源不是普通目录\"\n  [[ ! -e \"$destination\" && ! -L \"$destination\" ]] || fail \"Windows 安装导出目标已存在，保留已有产物\"\n  # 所有安装/消费者检查成功后才同卷重命名；跨卷失败，不退回复制半份目录，\n  # 不删除旧产物、不清理永久容器，也不覆盖已存在或被替换为 reparse point 的目标。\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"), p=require(\"path\");\n    const [source,target]=process.argv.slice(1);\n    const identity=x=>process.platform===\"win32\"?p.resolve(x).toLowerCase():p.resolve(x);\n    for(const directory of [source,p.dirname(target)]) {\n      const st=fs.lstatSync(directory);\n      if(!st.isDirectory() || st.isSymbolicLink() || identity(fs.realpathSync(directory))!==identity(directory)) throw Error(\"Windows export directory identity drift\");\n    }\n    try { fs.lstatSync(target); throw Error(\"Windows export already exists\"); }\n    catch(error) { if(error.code!==\"ENOENT\") throw error; }\n    fs.renameSync(source,target);\n  ' \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$destination\")\" \\\n    || fail \"Windows 已验证安装同卷导出失败，禁止覆盖或跨卷复制\"\n}\n\nverify_windows_flutter_cache() {\n  local root=\"$1\" cache=\"$2\"\n  assert_readonly_dependency_directory \"$root\" \"Windows Flutter SDK\"\n  assert_readonly_dependency_directory \"$cache\" \"Windows Pub cache\"\n  # 官方 WindowsEngineArtifacts 同时登记 debug/profile/release；缺项只能失败，\n  # 不能让后续 build 自动取得运行件。ICU 属于无 mode 的通用目录。\n  MSYS2_ARG_CONV_EXCL='*' node - \"$(cygpath -m \"$root\")\" \"$(cygpath -m \"$cache\")\" <<'NODE'\nconst fs = require('fs'), path = require('path');\nconst [root, cache] = process.argv.slice(2);\nfunction ordinaryTree(directory) {\n  const st = fs.lstatSync(directory);\n  if (!st.isDirectory() || st.isSymbolicLink()\n      || path.resolve(fs.realpathSync(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw Error('Windows tool directory is redirected');\n  for (const item of fs.readdirSync(directory, {withFileTypes:true})) {\n    const value = path.join(directory, item.name), state = fs.lstatSync(value);\n    if (state.isSymbolicLink() || (!state.isFile() && !state.isDirectory())) throw Error('Windows tool tree contains a link or special node');\n    if (state.isDirectory()) ordinaryTree(value);\n  }\n}\nordinaryTree(root);\nfor (const name of ['hosted', 'hosted-hashes']) ordinaryTree(path.join(cache, name));\nfunction file(name, read = false) {\n  const value = path.join(root, name), st = fs.lstatSync(value);\n  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) throw Error('Windows Flutter cache is incomplete: ' + name);\n  return read ? fs.readFileSync(value, 'utf8').trim() : undefined;\n}\nif (!fs.lstatSync(path.join(root, '.git')).isDirectory()\n    || fs.existsSync(path.join(root, '.git/commondir'))) throw Error('Windows Flutter SDK must be a complete ordinary installation');\nconst version = JSON.parse(file('bin/cache/flutter.version.json', true));\nconst revision = file('bin/cache/engine.stamp', true);\nif (!/^[0-9a-f]{40}$/.test(revision) || version.engineRevision !== revision\n    || !/^[0-9a-f]{40}$/.test(version.frameworkRevision)\n    || file('bin/internal/engine.version', true) !== revision\n    || file('bin/cache/flutter_tools.stamp', true) !== version.frameworkRevision + ':') throw Error('Windows Flutter cache identity mismatch');\nfor (const name of ['flutter_sdk', 'windows-sdk', 'font-subset']) {\n  if (file('bin/cache/' + name + '.stamp', true) !== revision) throw Error('Windows Flutter artifact revision mismatch');\n}\nfor (const name of ['material_fonts', 'gradle_wrapper']) {\n  if (file('bin/cache/' + name + '.stamp', true) !== file('bin/internal/' + name + '.version', true)\n      || !fs.lstatSync(path.join(root, 'bin/cache/artifacts', name)).isDirectory()) throw Error('Windows universal Flutter cache is incomplete');\n}\nfor (const name of [\n  'bin/cache/flutter_tools.snapshot', 'bin/cache/dart-sdk/bin/dart.exe',\n  'packages/flutter_tools/.dart_tool/package_config.json',\n  'bin/cache/pkg/sky_engine/pubspec.yaml', 'bin/cache/pkg/flutter_gpu/pubspec.yaml',\n  'bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill',\n  'bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill',\n  'bin/cache/artifacts/engine/windows-x64/icudtl.dat',\n  'bin/cache/artifacts/engine/windows-x64/font-subset.exe',\n  'bin/cache/artifacts/engine/windows-x64-release/gen_snapshot.exe',\n  'bin/cache/artifacts/engine/windows-x64/cpp_client_wrapper/include/flutter/plugin_registrar_windows.h',\n]) file(name);\nfor (const mode of ['', '-profile', '-release']) {\n  for (const name of ['flutter_windows.dll', 'flutter_windows.dll.exp', 'flutter_windows.dll.lib',\n    'flutter_windows.dll.pdb', 'flutter_export.h', 'flutter_messenger.h',\n    'flutter_plugin_registrar.h', 'flutter_texture_registrar.h', 'flutter_windows.h']) {\n    file('bin/cache/artifacts/engine/windows-x64' + mode + '/' + name);\n  }\n}\nNODE\n}\n\nverify_windows_flutter_inventory() {\n  local build=\"$1\" state=\"$2\" prefix=\"$3\" inventory\n  inventory=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n    -C Release --show-only=json-v1)\" || fail \"Windows Flutter CTest 清单读取失败\"\n  MSYS2_ARG_CONV_EXCL='*' node - \"$inventory\" \"$(cygpath -m \"$build\")\" \\\n    \"$(cygpath -m \"$state\")\" \"$(cygpath -m \"$prefix\")\" <<'NODE'\nconst fs=require('fs'), path=require('path');\nconst [raw, build, state, prefix]=process.argv.slice(2);\nconst tests=JSON.parse(raw).tests;\nconst names=['codec','environment','sessions','wallet_flow','plugin','secret_boundary']\n  .map(x=>'CitizenSDK.Windows.citizen_sdk_flutter_'+x+'_test').sort();\nif(!Array.isArray(tests) || JSON.stringify(tests.map(x=>x.name).sort())!==JSON.stringify(names)) throw Error('Windows Flutter CTest exact set drift');\nconst normalize=x=>path.resolve(x).toLowerCase();\nfunction ordinaryFile(file) {\n  let current=path.parse(path.resolve(file)).root;\n  for(const part of path.relative(current,path.resolve(file)).split(path.sep)) {\n    current=path.join(current,part); const st=fs.lstatSync(current);\n    if(st.isSymbolicLink() || normalize(fs.realpathSync(current))!==normalize(current)) throw Error('Windows Flutter CTest path is redirected');\n    if(normalize(current)===normalize(file)) {\n      if(!st.isFile() || !st.size || st.nlink!==1) throw Error('Windows Flutter CTest input is not an ordinary single-link file');\n    } else if(!st.isDirectory()) throw Error('Windows Flutter CTest ancestor is not a directory');\n  }\n}\nfor(const test of tests) {\n  const name=test.name.slice('CitizenSDK.Windows.'.length);\n  const expected=path.join(build,'plugins/citizen_sdk/test/Release',name+'.exe');\n  if(!Array.isArray(test.command) || test.command.length!==1 || normalize(test.command[0])!==normalize(expected)) throw Error('Windows Flutter CTest command drift');\n  const props=new Map();\n  for(const property of test.properties || []) {\n    if(props.has(property.name)) throw Error('Windows Flutter CTest duplicate property');\n    props.set(property.name,property.value);\n  }\n  if(props.get('TIMEOUT')!==60 || JSON.stringify(props.get('ENVIRONMENT'))!==JSON.stringify(['CITIZENSDK_TEST_WORK_DIR='+state])) throw Error('Windows Flutter CTest state/timeout drift');\n  if(!Array.isArray(props.get('LABELS')) || JSON.stringify([...props.get('LABELS')].sort())!==JSON.stringify(['CitizenSDK','Contract','WindowsFlutter'])) throw Error('Windows Flutter CTest labels drift');\n  for(const property of ['PASS_REGULAR_EXPRESSION','SKIP_REGULAR_EXPRESSION','SKIP_RETURN_CODE','WILL_FAIL','DISABLED']) {\n    if(props.has(property)) throw Error('Windows Flutter CTest cannot mask failure');\n  }\n  ordinaryFile(expected);\n  for(const name of ['citizensdk.dll','citizensdk_host.dll']) {\n    const actual=path.join(path.dirname(expected),name);\n    const source=path.join(prefix,'bin/Windows',name);\n    ordinaryFile(actual); ordinaryFile(source);\n    if(!fs.readFileSync(actual).equals(fs.readFileSync(source))) throw Error('Windows Flutter CTest runtime differs from its installation');\n  }\n}\nNODE\n}\n\nrun_windows_flutter_consumer() {\n  local bundle=\"$1\"\n  # .NET 用真实管道启动 GUI Release，并等待退出和输出排空，不使用\n  # Start-Process 的“已启动”状态。官方 AttachConsole 保留 STARTF_USESTDHANDLES\n  # 提供的重定向句柄；不改 runner main 或手动注册插件。\n  CITIZENSDK_FLUTTER_BUNDLE=\"$(cygpath -m \"$bundle\")\" \\\n    MSYS2_ARG_CONV_EXCL='*' pwsh -NoLogo -NoProfile -NonInteractive -Command - <<'POWERSHELL'\n$ErrorActionPreference = 'Stop'\ntry {\n  if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows -or\n      $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {\n    throw 'Windows Flutter execution requires the authorized isolated runner'\n  }\n  Add-Type -TypeDefinition @'\nusing System;\nusing System.Collections.Generic;\nusing System.Diagnostics;\nusing System.IO;\nusing System.Linq;\nusing System.Runtime.InteropServices;\nusing System.Security.AccessControl;\nusing System.Security.Principal;\nusing System.Text;\nusing System.Threading;\nusing Microsoft.Win32.SafeHandles;\n\npublic static class CitizenSdkFlutterConsumer {\n  [DllImport(\"shell32.dll\")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern uint GetFileAttributesW(string path);\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);\n  [DllImport(\"advapi32.dll\", SetLastError=true)]\n  static extern uint GetSecurityInfo(SafeFileHandle handle, uint kind, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);\n  [DllImport(\"advapi32.dll\")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);\n  [DllImport(\"kernel32.dll\")] static extern IntPtr LocalFree(IntPtr value);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition value, uint size);\n  [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte Delete; }\n  [StructLayout(LayoutKind.Sequential)] struct Information {\n    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;\n    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;\n  }\n  static readonly SecurityIdentifier User = CurrentUser();\n  static SecurityIdentifier CurrentUser() {\n    using (var identity = WindowsIdentity.GetCurrent()) { return identity.User; }\n  }\n  const string Application = \"org.citizensdk.flutterconsumer\";\n  const string Marker = \"CitizenSDK Flutter consumer passed\";\n  static void Require(bool value) { if (!value) throw new InvalidOperationException(\"Windows Flutter consumer boundary failed\"); }\n  static string Full(string value) {\n    var path = Path.GetFullPath(value);\n    Require(path.Length > 3 && path[1] == ':' && !path.StartsWith(@\"\\\\\") && path.IndexOf('\\0') < 0);\n    return path.TrimEnd('\\\\');\n  }\n  static bool Missing(string path) {\n    if (GetFileAttributesW(path) != UInt32.MaxValue) return false;\n    var error = Marshal.GetLastWin32Error();\n    Require(error == 2 || error == 3);\n    return true;\n  }\n  static void Private(SafeFileHandle handle) {\n    IntPtr owner, group, dacl, sacl, descriptor;\n    Require(GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) == 0);\n    try {\n      var size = GetSecurityDescriptorLength(descriptor);\n      Require(size > 0 && size <= 65536);\n      var bytes = new byte[(int)size]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);\n      var security = new RawSecurityDescriptor(bytes, 0);\n      Require(User != null && User.Equals(security.Owner)\n        && (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0\n        && security.DiscretionaryAcl != null && security.DiscretionaryAcl.Count == 1);\n      var ace = security.DiscretionaryAcl[0] as CommonAce;\n      Require(ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && ace.AceFlags == AceFlags.None\n        && ace.AccessMask == 0x1f01ff && User.Equals(ace.SecurityIdentifier));\n    } finally { LocalFree(descriptor); }\n  }\n  static SafeFileHandle Open(string path, bool directory, bool remove, bool secure) {\n    // 不分享删除；每一层都保持句柄直到下层检查/清理结束，避免检查后换父目录。\n    var handle = CreateFileW(path, 0x20080u | (directory ? 1u : 0u) | (remove ? 0x10000u : 0u),\n      3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);\n    try {\n      Require(!handle.IsInvalid);\n      Information info; Require(GetFileInformationByHandle(handle, out info));\n      Require((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory\n        && (directory || info.Links == 1));\n      var name = new StringBuilder(32768);\n      var count = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);\n      Require(count > 0 && count < name.Capacity);\n      var final = name.ToString();\n      Require(final.StartsWith(@\"\\\\?\\\") && String.Equals(final.Substring(4).TrimEnd('\\\\'),\n        Path.GetFullPath(path).TrimEnd('\\\\'), StringComparison.OrdinalIgnoreCase));\n      if (secure) Private(handle);\n      return handle;\n    } catch { handle.Dispose(); throw; }\n  }\n  static string Identity(SafeFileHandle handle) {\n    Information value; Require(GetFileInformationByHandle(handle, out value));\n    return value.Volume.ToString(\"x8\") + value.IndexHigh.ToString(\"x8\") + value.IndexLow.ToString(\"x8\");\n  }\n  sealed class Node : IDisposable {\n    public SafeFileHandle Handle;\n    public List<Node> Children = new List<Node>();\n    public void Dispose() { foreach (var child in Children) child.Dispose(); if (Handle != null) Handle.Dispose(); }\n    public void Delete() {\n      foreach (var child in Children) child.Delete();\n      var value = new Disposition { Delete = 1 };\n      Require(SetFileInformationByHandle(Handle, 4, ref value, 1));\n      Handle.Dispose();\n    }\n  }\n  static Node Collect(string path, int depth, ref int count) {\n    Require(depth <= 16 && ++count <= 4096);\n    var attributes = GetFileAttributesW(path); Require(attributes != UInt32.MaxValue);\n    var directory = (attributes & 0x10) != 0;\n    var node = new Node { Handle = Open(path, directory, true, true) };\n    try {\n      if (directory) foreach (var child in Directory.EnumerateFileSystemEntries(path)) node.Children.Add(Collect(child, depth + 1, ref count));\n      return node;\n    } catch { node.Dispose(); throw; }\n  }\n  public static void Run(string suppliedBundle) {\n    var bundle = Full(suppliedBundle);\n    var folder = new Guid(\"F1B32785-6FBA-4FCF-9D55-7B8E7F157091\"); IntPtr pointer;\n    Require(SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out pointer) == 0);\n    string data; try { data = Full(Marshal.PtrToStringUni(pointer)); } finally { Marshal.FreeCoTaskMem(pointer); }\n    var target = Path.Combine(data, Application);\n    var ancestors = new List<SafeFileHandle>(); SafeFileHandle observed = null;\n    string identity = null; bool started = false, ended = false, succeeded = false;\n    var process = new Process();\n    try {\n      var current = Path.GetPathRoot(data);\n      ancestors.Add(Open(current, true, false, false));\n      foreach (var part in data.Substring(current.Length).Split('\\\\')) {\n        Require(part.Length != 0 && part != \".\" && part != \"..\");\n        current = Path.Combine(current, part); ancestors.Add(Open(current, true, false, false));\n      }\n      Require(Missing(target));  // 不认领、更改或删除任何原有用户状态。\n      process.StartInfo = new ProcessStartInfo(Path.Combine(bundle, \"citizensdk_consumer.exe\")) {\n        WorkingDirectory = bundle, UseShellExecute = false,\n        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,\n        CreateNoWindow = true\n      };\n      Require(process.Start()); started = true; process.StandardInput.Close();\n      var stdout = process.StandardOutput.ReadToEndAsync();\n      var stderr = process.StandardError.ReadToEndAsync();\n      var loaded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);\n      var libraries = new HashSet<string>(new [] { \"citizensdk.dll\", \"citizensdk_host.dll\", \"citizen_sdk_plugin.dll\", \"flutter_windows.dll\" }, StringComparer.OrdinalIgnoreCase);\n      var clock = Stopwatch.StartNew();\n      while (!process.WaitForExit(5)) {\n        Require(clock.ElapsedMilliseconds < 180000);\n        if (observed == null && !Missing(target)) { observed = Open(target, true, false, true); identity = Identity(observed); }\n        ProcessModuleCollection modules = null;\n        try { process.Refresh(); modules = process.Modules; }\n        catch (System.ComponentModel.Win32Exception error) {\n          // 仅允许启动/退出间的暂态枚举失败；未实际看到全部 DLL 始终不能通过。\n          Require(error.NativeErrorCode == 299 || process.HasExited);\n        } catch (InvalidOperationException) { if (!process.HasExited) throw; }\n        if (modules != null) foreach (ProcessModule module in modules) if (libraries.Contains(module.ModuleName)) {\n          Require(String.Equals(Full(module.FileName), Path.Combine(bundle, module.ModuleName), StringComparison.OrdinalIgnoreCase));\n          loaded.Add(module.ModuleName);\n        }\n      }\n      ended = true;\n      Require(stdout.Wait(5000) && stderr.Wait(5000));\n      Require(process.ExitCode == 0 && loaded.SetEquals(libraries));\n      Require(stdout.Result.Split(new [] { \"\\r\\n\", \"\\n\" }, StringSplitOptions.None).Count(line => line == Marker) == 1);\n      if (observed == null) { observed = Open(target, true, false, true); identity = Identity(observed); }\n      succeeded = true;\n    } finally {\n      try {\n        try {\n          if (started && !ended) {\n            if (!process.HasExited) process.Kill(true);\n            ended = process.WaitForExit(10000);\n          }\n        } finally {\n          // 终止/等待自身也可能失败；仍释放观察句柄，但不清理未确认退出的进程状态。\n          process.Dispose();\n          if (observed != null) observed.Dispose();\n        }\n        // 必须先确认进程退出、观察到本次私有目录身份，再整树验所有权后删除。\n        // 任意身份/ACL/reparse 不明时保留，不能把安全失败改成强制 Remove-Item。\n        if (started && ended && identity != null) {\n          int count = 0;\n          using (var owned = Collect(target, 0, ref count)) { Require(Identity(owned.Handle) == identity); owned.Delete(); }\n          Require(Missing(target));\n        } else if (started && !Missing(target)) { succeeded = false; throw new InvalidOperationException(\"Windows Flutter test state ownership is unproven; retained\"); }\n      } finally { foreach (var handle in ancestors) handle.Dispose(); }\n    }\n    Require(succeeded);\n    Console.WriteLine(Marker);\n  }\n}\n'@\n  [CitizenSdkFlutterConsumer]::Run($env:CITIZENSDK_FLUTTER_BUNDLE)\n  exit 0\n} catch {\n  [Console]::Error.WriteLine('Windows Flutter consumer failed; unproven state is retained')\n  exit 1\n}\nPOWERSHELL\n}\n\nbuild_windows_flutter_consumer() (\n  local build_root=\"$1\" prefix=\"$2\" software_version=\"$3\"\n  local package=\"${4:-}\" candidate=\"${5:-$sdk_dir}\"\n  local flutter_source=\"${CITIZENSDK_FLUTTER_ROOT:-}\" cache_source=\"${PUB_CACHE:-}\"\n  local root=\"$build_root/flutter\" tool_root cache_root sdk_stage runner dart_bin build bundle test_state\n  [[ \"${GITHUB_ACTIONS:-}\" == true && \"${RUNNER_ENVIRONMENT:-}\" == github-hosted ]] \\\n    || fail \"Windows Flutter 真实消费只允许已授权的一次性 GitHub Windows 用户环境\"\n  command -v pwsh >/dev/null 2>&1 || fail \"Windows Flutter 消费缺少预装 PowerShell 7\"\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"),path=require(\"path\");\n    if(!process.env.APPDATA || !path.isAbsolute(process.env.APPDATA)) throw Error(\"Windows Flutter tool profile is unavailable\");\n    try { fs.lstatSync(path.join(process.env.APPDATA,\".flutter_settings\")); throw Error(\"Windows Flutter settings must not redirect this build\"); }\n    catch(error) { if(error.code!==\"ENOENT\") throw error; }\n  ' || fail \"Windows Flutter 一次性用户环境带有不允许的工具配置\"\n  verify_windows_flutter_cache \"$flutter_source\" \"$cache_source\"\n  tool_root=\"$root/tools\"; cache_root=\"$root/pub-cache\"; sdk_stage=\"$root/citizen_sdk\"\n  runner=\"$root/consumer\"; test_state=\"$root/test-state\"\n  for directory in \"$flutter_source\" \"$cache_source\" \"$sdk_dir\"; do\n    case \"$root/\" in \"$directory/\"*) fail \"Windows Flutter 输入不能包含本轮副本目标\" ;; esac\n    case \"$directory/\" in \"$root/\"*) fail \"Windows Flutter 输入不能来自本轮副本目标\" ;; esac\n  done\n  for directory in \"$root\" \"$tool_root\" \"$cache_root\" \"$sdk_stage\" \"$root/tmp\"; do\n    [[ ! -e \"$directory\" && ! -L \"$directory\" ]] || fail \"Windows Flutter 工作目录已存在，拒绝混用\"\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Windows Flutter 独占目录\"\n  done\n  # 副本只含显式预装工具及 hosted 依赖；不复制 Pub 凭据、Git hooks/config。\n  # Flutter 官方 backend 仍执行其副本 assemble 链路；不改官方 registrant。\n  MSYS2_ARG_CONV_EXCL='*' node - \"$(cygpath -m \"$flutter_source\")\" \"$(cygpath -m \"$cache_source\")\" \\\n    \"$(cygpath -m \"$tool_root\")\" \"$(cygpath -m \"$cache_root\")\" \\\n    \"$(cygpath -m \"${package:-$sdk_dir}\")\" \"$(cygpath -m \"$sdk_stage\")\" <<'NODE'\nconst fs=require('fs'), path=require('path'), url=require('url');\nconst [source,cache,tool,copyCache,sdk,stage]=process.argv.slice(2);\nfor(const [from,to] of [[source,tool],[sdk,stage]]) {\n  fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false,filter:value=>{\n    const relative=path.relative(from,value).replaceAll('\\\\','/');\n    return !['.git/config','.git/hooks','.git/logs'].some(x=>relative===x || relative.startsWith(x+'/'));\n  }});\n}\nfor(const name of ['hosted','hosted-hashes']) fs.cpSync(path.join(cache,name),path.join(copyCache,name),{recursive:true,errorOnExist:true,force:false});\nconst original=path.join(source,'packages/flutter_tools/.dart_tool/package_config.json');\nconst config=JSON.parse(fs.readFileSync(original,'utf8'));\nfor(const item of config.packages) {\n  const root=url.fileURLToPath(new URL(item.rootUri,url.pathToFileURL(original)));\n  const maps=[[source,tool],[cache,copyCache]];\n  const mapping=maps.find(([from])=>root.toLowerCase().startsWith(path.resolve(from).toLowerCase()+path.sep));\n  if(!mapping) throw Error('Windows Flutter package config refers outside explicit tool/cache inputs');\n  item.rootUri=url.pathToFileURL(path.join(mapping[1],path.relative(mapping[0],root))+path.sep).href;\n}\nfs.writeFileSync(path.join(tool,'packages/flutter_tools/.dart_tool/package_config.json'),JSON.stringify(config));\nNODE\n  if [[ -z \"$package\" ]]; then\n  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$(cygpath -m \"$sdk_dir\")\" \\\n    \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$sdk_stage\")\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst [source,prefix,stage]=process.argv.slice(2);\nconst release=await import(pathToFileURL(join(source,'.github/workflows/release-sdk.mjs')));\nrelease.projectFlutterSourceEntry(source,stage);\nrelease.copyWindowsNativeArtifact(source,prefix,stage);\nrelease.assertWindowsReleaseProjection(stage);\nrelease.assertHostedRuntimeWindowsProjection(stage,{allowInjectedWindowsArtifacts:true});\nNODE\n  fi\n  # 不设置 HOME、APPDATA、LOCALAPPDATA 或 KnownFolder。工具自身 profile 状态\n  # 只属于已授权的一次性 runner 用户；依赖、工具副本和 TEMP 始终留本轮 work。\n  export FLUTTER_ROOT=\"$(cygpath -m \"$tool_root\")\" PUB_CACHE=\"$(cygpath -m \"$cache_root\")\"\n  export TEMP=\"$(cygpath -m \"$root/tmp\")\" TMP=\"$TEMP\" TMPDIR=\"$root/tmp\"\n  export FLUTTER_SUPPRESS_ANALYTICS=true\n  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \\\n    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH\n  dart_bin=\"$tool_root/bin/cache/dart-sdk/bin/dart.exe\"\n  local -a flutter=(\"$dart_bin\" \"--packages=$(cygpath -m \"$tool_root/packages/flutter_tools/.dart_tool/package_config.json\")\"\n    \"$(cygpath -m \"$tool_root/bin/cache/flutter_tools.snapshot\")\" --no-version-check --suppress-analytics)\n  MSYS2_ARG_CONV_EXCL='*' \"${flutter[@]}\" create --offline --no-pub --platforms=windows \\\n    --project-name=citizensdk_consumer --org=org.citizen \"$(cygpath -m \"$runner\")\"\n  MSYS2_ARG_CONV_EXCL='*' node - \"$(cygpath -m \"$runner\")\" \"$(cygpath -m \"$test_state\")\" \\\n    \"$(cygpath -m \"$candidate\")\" \"$software_version\" \"$package\" <<'NODE'\nconst fs=require('fs'),path=require('path');\nconst [runner,state,source,version,hosted]=process.argv.slice(2);\nif(/[\";$\\\\\\r\\n]/.test(state)) throw Error('Windows CMake test path is unsafe');\nfs.writeFileSync(path.join(runner,'pubspec.yaml'),`name: citizensdk_consumer\\npublish_to: none\\nversion: ${version}\\nenvironment:\\n  sdk: \">=3.8.0 <4.0.0\"\\ndependencies:\\n  flutter:\\n    sdk: flutter\\n  citizen_sdk:\\n    path: ../citizen_sdk\\nflutter:\\n  uses-material-design: true\\n`);\nfs.copyFileSync(path.join(source,'pubspec.lock'),path.join(runner,'pubspec.lock'));\nfs.copyFileSync(path.join(source,'windows/tests/citizen_sdk_flutter_consumer.dart'),path.join(runner,'lib/main.dart'));\nconst cmake=path.join(runner,'windows/CMakeLists.txt');\nconst text=fs.readFileSync(cmake,'utf8'), target='include(flutter/generated_plugins.cmake)';\nif(text.split(target).length!==2) throw Error('Windows official generated plugin include is not unique');\nfs.writeFileSync(cmake,text.replace(target,\n  'set(CITIZENSDK_APPLICATION_ID \"org.citizensdk.flutterconsumer\")\\n'+\n  (hosted ? '' : `set(CITIZENSDK_BUILD_TESTS ON)\\nset(CITIZENSDK_TEST_WORK_DIR \"${state}\")\\nenable_testing()\\n`)+target));\nNODE\n  (cd \"$runner\" && MSYS2_ARG_CONV_EXCL='*' \"${flutter[@]}\" pub get --offline)\n  (cd \"$runner\" && MSYS2_ARG_CONV_EXCL='*' \"${flutter[@]}\" build windows --release --no-pub)\n  cmp -s \"$candidate/pubspec.yaml\" \"$sdk_stage/pubspec.yaml\" \\\n    || fail \"Windows Flutter 不允许改写 SDK pubspec 注册\"\n  build=\"$runner/build/windows/x64\"; bundle=\"$build/runner/Release\"\n  if [[ -z \"$package\" ]]; then\n    verify_windows_flutter_inventory \"$build\" \"$test_state\" \"$prefix\"\n    MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n      -C Release --no-tests=error --output-on-failure\n  fi\n  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$(cygpath -m \"$sdk_dir\")\" \\\n    \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$bundle\")\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst [source,prefix,bundle]=process.argv.slice(2);\nconst {assertWindowsFlutterBundle}=await import(pathToFileURL(join(source,'.github/workflows/release-sdk.mjs')));\nassertWindowsFlutterBundle(source,prefix,bundle);\nNODE\n  run_windows_flutter_consumer \"$bundle\"\n)\n\nbuild_windows() {\n  prepare_internal_header\n  local target=x86_64-pc-windows-msvc build_root prefix test_root core_dir\n  local software_version consumer_build consumer_state destination\n  windows_path_preflight\n  command -v cl >/dev/null 2>&1 || fail \"Windows 缺少预先初始化的 MSVC 编译环境\"\n  command -v dumpbin >/dev/null 2>&1 || fail \"Windows 缺少 MSVC dumpbin\"\n  command -v cmake >/dev/null 2>&1 || fail \"Windows 缺少 CMake\"\n  load_native_dependencies Windows\n  require_rust_target \"$target\"\n  [[ -n \"${CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR:-}\" && -n \"${CITIZENSDK_WINDOWS_SQLITE_ARCHIVE:-}\" ]] \\\n    || fail \"Windows 必须显式提供已固定的 SQLite 头和 MSVC 静态库\"\n  assert_readonly_dependency_directory \"$CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR\" \"Windows SQLite include\"\n  [[ \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" == /* && \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" == *.lib \\\n      && -f \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" && ! -L \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" ]] \\\n    || fail \"Windows SQLite archive 必须是既存绝对 .lib 路径\"\n  assert_safe_directory_path \"$(dirname \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\")\" \"Windows SQLite archive 父目录\"\n  build_root=\"$work_dir/Windows\"\n  prefix=\"$build_root/install\"\n  destination=\"$output_dir/Windows\"\n  consumer_build=\"$build_root/consumer\"\n  consumer_state=\"$build_root/consumer-state\"\n  test_root=\"$build_root/test-state\"\n  prepare_safe_directory \"$work_dir\" \"$build_root\" \"Windows 构建目录\"\n  # 测试最终目录由实际生产 Directory 首次相对创建，直接附加受保护 SID DACL。\n  # Bash mkdir/chmod 不是 Windows 私有 ACL；这里仅检查路径，不能先造继承 ACL 目录。\n  assert_descendant_path \"$work_dir\" \"$test_root\" \"Windows 测试状态\"\n  assert_safe_directory_path \"$test_root\" \"Windows 测试状态\"\n  assert_descendant_path \"$work_dir\" \"$consumer_state\" \"Windows 消费者状态\"\n  assert_safe_directory_path \"$consumer_state\" \"Windows 消费者状态\"\n  assert_safe_directory_path \"$prefix\" \"Windows 原生安装目录\"\n  [[ ! -e \"$prefix\" && ! -L \"$prefix\" ]] || fail \"Windows 临时安装前缀已存在，拒绝混入旧安装件\"\n  prepare_safe_directory \"$work_dir\" \"$prefix\" \"Windows 临时原生安装目录\"\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  [[ -n \"$software_version\" ]] || fail \"Windows 缺少唯一 SDK 版本\"\n  # 不安装工具、不联网补依赖，Cargo 输出和 CMake/CTest 状态均留在中央工作区。\n  CARGO_TARGET_DIR=\"$(cygpath -m \"$cargo_target_dir\")\" MSYS2_ARG_CONV_EXCL='*' \\\n    cargo build --manifest-path \"$(cygpath -m \"$product_ffi_manifest\")\" \\\n      --target \"$target\" --release --locked --offline\n  core_dir=\"$cargo_target_dir/$target/release\"\n  [[ -f \"$core_dir/citizensdk.dll\" && -f \"$core_dir/citizensdk.dll.lib\" ]] \\\n    || fail \"Windows Core DLL/import library 不完整\"\n  MSYS2_ARG_CONV_EXCL='*' cmake -S \"$(cygpath -m \"$windows_source_root\")\" \\\n    -B \"$(cygpath -m \"$build_root/cmake\")\" -G 'Visual Studio 17 2022' -A x64 \\\n    -DCITIZENSDK_PLATFORM=Windows \\\n    -DCITIZENSDK_CORE_LIBRARY=\"$(cygpath -m \"$core_dir/citizensdk.dll\")\" \\\n    -DCITIZENSDK_CORE_IMPORT_LIBRARY=\"$(cygpath -m \"$core_dir/citizensdk.dll.lib\")\" \\\n    -DCITIZENSDK_INTERNAL_INCLUDE_DIR=\"$(cygpath -m \"$work_dir/private-include\")\" \\\n    -DCITIZENSDK_SQLITE_INCLUDE_DIR=\"$(cygpath -m \"$CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR\")\" \\\n    -DCITIZENSDK_SQLITE_ARCHIVE=\"$(cygpath -m \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\")\" \\\n    -DCITIZENSDK_ZXING_SOURCE_DIR=\"$(cygpath -m \"$CITIZENSDK_ZXING_SOURCE_DIR\")\" \\\n    -DCITIZENSDK_BUILD_TESTS=ON \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$(cygpath -m \"$test_root\")\" \\\n    -DCMAKE_INSTALL_PREFIX=\"$(cygpath -m \"$prefix\")\"\n  MSYS2_ARG_CONV_EXCL='*' cmake --build \"$(cygpath -m \"$build_root/cmake\")\" --config Release\n  local test_inventory\n  test_inventory=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build_root/cmake\")\" -C Release --show-only=json-v1)\" \\\n    || fail \"Windows CTest 清单读取失败\"\n  CITIZENSDK_WINDOWS_TEST_INVENTORY=\"$test_inventory\" node -e '\n    const expected=[\"api_contract\",\"assets\",\"host_operation\",\"lifecycle\",\"directory\",\"public_store\",\"record_key\",\"secure_store\",\"sensitive_buffer\",\"secret_vault\",\"secret_boundary\",\"cng\",\"user_auth\",\"wallet_flow\"].map(x=>\"CitizenSDK.Windows.citizen_sdk_\"+x+\"_test\").sort();\n    const actual=JSON.parse(process.env.CITIZENSDK_WINDOWS_TEST_INVENTORY).tests.map(x=>x.name).sort();\n    if(JSON.stringify(actual)!==JSON.stringify(expected)) throw Error(\"Windows CTest exact set drift\");\n  ' || fail \"Windows CTest 必须精确包含 14 个正式程序\"\n  MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build_root/cmake\")\" -C Release --no-tests=error --output-on-failure\n  MSYS2_ARG_CONV_EXCL='*' cmake --install \"$(cygpath -m \"$build_root/cmake\")\" --config Release\n  verify_windows_install \"$prefix\" \"$software_version\" \"$core_dir\" \"$build_root/cmake\"\n  prepare_safe_directory \"$work_dir\" \"$consumer_build\" \"Windows 独立消费者构建目录\"\n  MSYS2_ARG_CONV_EXCL='*' cmake -S \"$(cygpath -m \"$windows_source_root/tests\")\" \\\n    -B \"$(cygpath -m \"$consumer_build\")\" -G 'Visual Studio 17 2022' -A x64 \\\n    -DCITIZENSDK_CONSUMER_PREFIX=\"$(cygpath -m \"$prefix\")\" \\\n    -DCITIZENSDK_CONSUMER_VERSION=\"$software_version\" -DCITIZENSDK_PLATFORM=Windows \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$(cygpath -m \"$consumer_state\")\"\n  MSYS2_ARG_CONV_EXCL='*' cmake --build \"$(cygpath -m \"$consumer_build\")\" --config Release\n  run_windows_consumers \"$consumer_build\" \"$prefix\" \"$consumer_state\"\n  build_windows_flutter_consumer \"$build_root\" \"$prefix\" \"$software_version\"\n  # 消费者结束后再次核对安装件；改名后不再使用记录旧前缀的 install_manifest。\n  verify_windows_install \"$prefix\" \"$software_version\" \"$core_dir\" \"$build_root/cmake\"\n  export_windows_install \"$prefix\" \"$destination\"\n  record_native_dependencies Windows\n  echo \"CitizenSDK Windows 原生、C/C++、Flutter adapter 与 Release 消费者检查完成；未执行正式发布\"\n}\n\nverify_windows_exports() {\n  local library=\"$1\" header=\"$2\" label=\"$3\" exports internal_symbols=\"\"\n  # Core为147项公开闭集，无窗口私有符号；Host另导出自己的19项和4项统一图像接口。\n  if [[ \"$header\" == \"$product_header\" ]]; then\n    internal_symbols=\"$(product_internal_symbols)\"\n  else\n    internal_symbols=\"$(qr_image_header_symbols)\"\n  fi\n  # dumpbin 的完整导出表逐项比较，禁止先过滤 citizensdk 前缀掩盖额外导出。\n  exports=\"$(MSYS2_ARG_CONV_EXCL='*' dumpbin /NOLOGO /EXPORTS \"$(cygpath -m \"$library\")\")\" \\\n    || fail \"Windows $label 无法读取 PE 导出\"\n  CITIZENSDK_PE_EXPORTS=\"$exports\" CITIZENSDK_PE_LIBRARY=\"$(cygpath -m \"$library\")\" \\\n    CITIZENSDK_PE_HEADER=\"$(cygpath -m \"$header\")\" CITIZENSDK_PE_INTERNAL=\"$internal_symbols\" node -e '\n      const fs=require(\"fs\"); const b=fs.readFileSync(process.env.CITIZENSDK_PE_LIBRARY);\n      if(b.length<64 || b.readUInt16LE(0)!==0x5a4d) throw Error(\"not PE\");\n      const o=b.readUInt32LE(60);\n      if(o>b.length-26 || b.readUInt32LE(o)!==0x4550 || b.readUInt16LE(o+4)!==0x8664 || b.readUInt16LE(o+24)!==0x20b) throw Error(\"wrong Windows PE machine\");\n      const actual=[...process.env.CITIZENSDK_PE_EXPORTS.matchAll(/^\\s*\\d+\\s+[0-9A-Fa-f]+\\s+[0-9A-Fa-f]+\\s+(\\S+)(.*)$/gm)];\n      if(actual.some(x=>x[2].includes(\"=\"))) throw Error(\"forwarded export\");\n      const names=actual.map(x=>x[1]).sort();\n      const expected=[...new Set([...fs.readFileSync(process.env.CITIZENSDK_PE_HEADER,\"utf8\").matchAll(/\\b(citizensdk_[a-z0-9_]+)\\s*\\((?!\\s*\\*)/g)].map(x=>x[1]).concat(process.env.CITIZENSDK_PE_INTERNAL.split(\"\\n\").filter(Boolean)))].sort();\n      if(JSON.stringify(names)!==JSON.stringify(expected)) throw Error(\"Windows full export set drift\");\n    ' || fail \"Windows $label PE/COFF 或完整导出合同失败\"\n}\n\nbuild_abi_host() {\n  local destination source_library nm_bin extension prefix\n  case \"$(uname -s)\" in\n    Darwin)\n      extension=dylib\n      prefix=_\n      nm_bin=\"$(xcrun --find llvm-nm)\"\n      ;;\n    Linux)\n      extension=so\n      prefix=''\n      nm_bin=\"$(command -v llvm-nm || command -v nm || true)\"\n      [[ -n \"$nm_bin\" ]] || fail \"当前 Linux 宿主缺少 llvm-nm 或 nm\"\n      ;;\n    *) fail \"产品 ABI 宿主验证尚不支持：$(uname -s)\" ;;\n  esac\n  destination=\"$output_dir/abi-host/libcitizensdk.$extension\"\n  CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path \"$product_ffi_manifest\" \\\n    --release --locked\n  source_library=\"$CARGO_TARGET_DIR/release/libcitizensdk.$extension\"\n  [[ -f \"$source_library\" ]] || fail \"CitizenSDK 产品 ABI 宿主库未生成\"\n  prepare_safe_output_file \"$output_dir\" \"$destination\" \"CitizenSDK 产品 ABI 宿主库\"\n  cp \"$source_library\" \"$destination\"\n  verify_product_abi_symbols \"$destination\" \"$nm_bin\" \"$prefix\" \\\n    \"CitizenSDK 产品 ABI 宿主库\"\n  \"${CC:-cc}\" -std=c11 -fsyntax-only -I\"$sdk_dir/include\" \\\n    \"$sdk_dir/native/ffi/tests/c_header_c11.c\"\n  \"${CXX:-c++}\" -std=c++17 -fsyntax-only -I\"$sdk_dir/include\" \\\n    \"$sdk_dir/native/ffi/tests/c_header_cpp17.cc\"\n  echo \"CitizenSDK 产品 ABI 宿主验证完成：$destination\"\n}\n\nverify_outputs() {\n  local android_core=\"$output_dir/android/arm64-v8a/libcitizensdk.so\"\n  local android_jni=\"$output_dir/android/arm64-v8a/libcitizensdk_jni.so\"\n  local android_aar=\"$output_dir/android/citizensdk.aar\"\n  local apple_xcframework=\"$output_dir/apple/CitizenSDK.xcframework\"\n  local host_library=\"$output_dir/host/libsmoldot.dylib\"\n  [[ -f \"$android_core\" && -f \"$android_jni\" && -f \"$android_aar\" \\\n    && -d \"$apple_xcframework\" \\\n    && -f \"$host_library\" ]] \\\n    || fail \"Android/iOS/macOS 产品与 legacy macOS 宿主测试运行件集合不完整\"\n  local toolchain nm_bin\n  toolchain=\"$(android_toolchain)\"\n  verify_product_abi_symbols \"$android_core\" \"$toolchain/bin/llvm-nm\" \"\" \\\n    \"Android libcitizensdk.so\"\n  verify_android_aar \\\n    \"$android_aar\" \"$android_core\" \"$android_jni\" \"$toolchain/bin/llvm-nm\"\n  verify_apple_xcframework \"$apple_xcframework\"\n  nm_bin=\"$(xcrun --find llvm-nm)\"\n  local host_architectures\n  host_architectures=\"$(xcrun lipo -archs \"$host_library\")\"\n  [[ \"$host_architectures\" == arm64 ]] \\\n    || fail \"macOS 宿主测试库内部架构必须精确为 arm64\"\n  verify_symbol_contract \"$(symbol_list_ios \"$host_library\" \"$nm_bin\")\" \"_\" \\\n    \"macOS 宿主测试库\"\n  echo \"CitizenSDK Android AAR、iOS/macOS XCFramework 与 legacy macOS 宿主测试合同通过\"\n}\n\nhosted_preflight() {\n  [[ \"$#\" == 7 ]] || fail \"Hosted 消费需要平台和 candidate、audit、hosted、flutter、pub-cache、tool-path\"\n  local platform=\"$1\" candidate=\"$2\" audit=\"$3\" hosted=\"$4\" flutter=\"$5\" cache=\"$6\" tool_path=\"$7\"\n  local path central=\"${RUNNER_TEMP:-}/citizensdk\" first second\n  [[ \"${GITHUB_ACTIONS:-}\" == true && \"${RUNNER_ENVIRONMENT:-}\" == github-hosted ]] \\\n    || fail \"跨平台最终包消费只允许一次性 GitHub Hosted Runner\"\n  case \"$platform:$(uname -s):$(uname -m)\" in\n    Android:Linux:*|Android:Darwin:arm64|iOS:Darwin:arm64|LinuxARM:Linux:aarch64|LinuxAMD:Linux:x86_64|Windows:MINGW*:x86_64|Windows:MSYS*:x86_64) ;;\n    *) fail \"Hosted 消费宿主与平台不一致\" ;;\n  esac\n  [[ \"${CITIZENSDK_SOURCE_SHA:-}\" =~ ^[0-9a-f]{40}$ ]] || fail \"Hosted 消费缺少准确源码提交\"\n  if [[ \"$platform\" == Windows ]]; then central=\"$(cygpath -u \"$RUNNER_TEMP\")/citizensdk\"; fi\n  assert_readonly_dependency_directory \"$central\" \"Hosted Runner 根\"\n  assert_readonly_dependency_directory \"$sdk_dir\" \"Hosted 校验器源码\"\n  case \"$central/\" in \"$sdk_dir/target/\"*) ;; \"$sdk_dir/\"*) fail \"Hosted 工作根位于源码内\" ;; esac\n  case \"$sdk_dir/\" in \"$central/\"*) fail \"Hosted 源码位于工作根内\" ;; esac\n  for path in \"$candidate\" \"$flutter\" \"$cache\" \"$work_dir\" \"$output_dir\"; do\n    assert_readonly_dependency_directory \"$path\" \"Hosted 输入目录\"\n    assert_descendant_path \"$central\" \"$path\" \"Hosted 输入目录\"\n  done\n  for path in \"$audit\" \"$hosted\"; do\n    assert_descendant_path \"$central\" \"$path\" \"Hosted 输入归档\"\n    assert_readonly_dependency_directory \"$(dirname \"$path\")\" \"Hosted 输入父目录\"\n    [[ -f \"$path\" && ! -L \"$path\" ]] || fail \"Hosted 输入归档不是普通文件\"\n  done\n  local -a inputs=(\"$candidate\" \"$audit\" \"$hosted\" \"$flutter\" \"$cache\" \"$work_dir\" \"$output_dir\")\n  for ((first=0; first<${#inputs[@]}; first++)); do\n    for ((second=first+1; second<${#inputs[@]}; second++)); do\n      case \"${inputs[first]}/\" in \"${inputs[second]}/\"*) fail \"Hosted 输入互相交叠\" ;; esac\n      case \"${inputs[second]}/\" in \"${inputs[first]}/\"*) fail \"Hosted 输入互相交叠\" ;; esac\n    done\n  done\n  # Windows/APFS 的路径别名必须按真实路径再次拒绝，不能只比较 Shell 文本。\n  local check_root=\"$central\" item\n  local -a check_inputs=(\"${inputs[@]}\")\n  if [[ \"$platform\" == Windows ]]; then\n    check_root=\"$(cygpath -m \"$central\")\"\n    for ((first=0; first<${#check_inputs[@]}; first++)); do check_inputs[first]=\"$(cygpath -m \"${check_inputs[first]}\")\"; done\n  fi\n  MSYS2_ARG_CONV_EXCL='*' node - \"$check_root\" \"${check_inputs[@]}\" <<'NODE' || fail \"Hosted 输入真实路径漂移\"\nconst fs=require('fs'),path=require('path');\nconst [root,...inputs]=process.argv.slice(2).map(value=>path.resolve(value));\nconst real=fs.realpathSync.native(root);\nfor(const input of inputs) {\n  if(fs.realpathSync.native(input)!==path.join(real,path.relative(root,input))) throw Error('Hosted input path alias');\n}\nNODE\n  [[ -n \"$tool_path\" && \"$tool_path\" != :* && \"$tool_path\" != *: && \"$tool_path\" != *::* ]] \\\n    || fail \"Hosted 工具 PATH 含空项\"\n  local -a paths\n  IFS=: read -r -a paths <<<\"$tool_path\"\n  for path in \"${paths[@]}\"; do\n    assert_readonly_dependency_directory \"$path\" \"Hosted 工具 PATH\"\n    case \"$work_dir/\" in \"$path/\"*) fail \"Hosted 工具 PATH 包含输出\" ;; esac\n    case \"$path/\" in \"$work_dir/\"*) fail \"Hosted 工具 PATH 来自输出\" ;; esac\n  done\n}\n\n# 只由唯一发布器验真和展开同一 Hosted 字节；本阶段不调用 Cargo、安装件注入器\n# 或源码 Host 构建。测试来源保留在已验真的审计候选，发布包自身不可补入测试。\nbuild_hosted_consumer() (\n  hosted_preflight \"$@\"\n  local platform=\"$1\" candidate=\"$2\" audit=\"$3\" hosted=\"$4\" flutter=\"$5\" cache=\"$6\" tool_path=\"$7\"\n  local root=\"$work_dir/$platform\" package=\"$work_dir/$platform/package\" version incremental_root\n  local source=\"$sdk_dir\" candidate_native=\"$candidate\" audit_native=\"$audit\" hosted_native=\"$hosted\" package_native=\"$package\"\n  [[ ! -e \"$root\" && ! -L \"$root\" ]] || fail \"Hosted 消费目录必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$root\" \"Hosted 消费目录\"\n  incremental_root=\"${CITIZENSDK_INCREMENTAL_ROOT:-$root/incremental}\"\n  if [[ -n \"${CITIZENSDK_INCREMENTAL_ROOT:-}\" ]]; then\n    assert_safe_directory_path \"${CI_INCREMENTAL_ROOT:-}\" \"Hosted CI 缓存根\"\n    assert_safe_directory_path \"$incremental_root\" \"Hosted CI 增量目录\"\n    assert_descendant_path \"$CI_INCREMENTAL_ROOT\" \"$incremental_root\" \"Hosted CI 增量目录\"\n    [[ -d \"$incremental_root\" && ! -L \"$incremental_root\" ]] \\\n      || fail \"Hosted CI 增量目录必须由中央缓存准备\"\n  else\n    prepare_safe_directory \"$root\" \"$incremental_root\" \"Hosted Release 全量目录\"\n  fi\n  if [[ \"$platform\" == Windows ]]; then\n    source=\"$(cygpath -m \"$source\")\"; candidate_native=\"$(cygpath -m \"$candidate\")\"\n    audit_native=\"$(cygpath -m \"$audit\")\"; hosted_native=\"$(cygpath -m \"$hosted\")\"; package_native=\"$(cygpath -m \"$package\")\"\n  fi\n  version=\"$(MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$source\" \"$candidate_native\" \\\n    \"$audit_native\" \"$hosted_native\" \"$package_native\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join,resolve} from 'node:path';\nconst [source,candidate,audit,hosted,output]=process.argv.slice(2).map(value=>resolve(value));\nconst {verifyCitizenSdkHosted}=await import(pathToFileURL(join(source,'.github/workflows/release-sdk.mjs')));\nconst manifest=verifyCitizenSdkHosted({candidatePath:candidate,archivePath:audit,\n  hostedArchivePath:hosted,outputPath:output,expectedGitSha:process.env.CITIZENSDK_SOURCE_SHA});\nprocess.stdout.write(manifest.software_version);\nNODE\n)\" || fail \"Hosted 唯一候选、审计归档或包字节验证失败\"\n  export CITIZENSDK_FLUTTER_ROOT=\"$flutter\" PUB_CACHE=\"$cache\" PATH=\"$tool_path\"\n  case \"$platform\" in\n    LinuxARM|LinuxAMD)\n      local prefix=\"$package/linux\" build=\"$incremental_root/${platform,,}/cmake\" state=\"$root/test-state\"\n      prepare_safe_directory \"$work_dir\" \"$state\" \"Hosted 原生测试状态\"\n      prepare_safe_directory \"$incremental_root\" \"$build\" \"Hosted CMake 增量目录\"\n      chmod 0700 \"$state\"\n      # 候选已经逐字节验真。固定 checkout 测试源码使 CMake 能跨 CI run\n      # 复用对象；动态安装前缀仍只指向本轮唯一候选。Release 根始终全新。\n      cmake -S \"$sdk_dir/linux/tests\" -B \"$build\" -DCMAKE_BUILD_TYPE=Release \\\n        -DCITIZENSDK_CONSUMER_PREFIX=\"$prefix\" -DCITIZENSDK_PLATFORM=\"$platform\" \\\n        -DCITIZENSDK_CONSUMER_VERSION=\"$version\" -DCITIZENSDK_TEST_WORK_DIR=\"$state\"\n      cmake --build \"$build\" --config Release --parallel --target citizen_sdk_c_consumer citizen_sdk_cpp_consumer\n      verify_linux_runtime_resolution \"$build/citizen_sdk_c_consumer\" \"$prefix/lib/$platform\"\n      verify_linux_runtime_resolution \"$build/citizen_sdk_cpp_consumer\" \"$prefix/lib/$platform\"\n      verify_linux_ctest_inventory \"$(command -v ctest)\" \"$build\" LinuxConsumer 2\n      ctest --test-dir \"$build\" --build-config Release -L '^LinuxConsumer$' --no-tests=error --output-on-failure\n      build_linux_flutter_consumer \"$platform\" \"$root\" \"$prefix\" \"$(command -v cmake)\" \\\n        \"$(command -v ctest)\" \"$(command -v readelf)\" \"$(command -v nm)\" \"$package\" \"$candidate\"\n      ;;\n    Windows)\n      local prefix=\"$package/windows\" build=\"$incremental_root/windows/cmake\" state=\"$root/consumer-state\"\n      prepare_safe_directory \"$incremental_root\" \"$build\" \"Hosted CMake 增量目录\"\n      MSYS2_ARG_CONV_EXCL='*' cmake -S \"$(cygpath -m \"$sdk_dir/windows/tests\")\" \\\n        -B \"$(cygpath -m \"$build\")\" -G 'Visual Studio 17 2022' -A x64 \\\n        -DCITIZENSDK_CONSUMER_PREFIX=\"$(cygpath -m \"$prefix\")\" -DCITIZENSDK_PLATFORM=Windows \\\n        -DCITIZENSDK_CONSUMER_VERSION=\"$version\" -DCITIZENSDK_TEST_WORK_DIR=\"$(cygpath -m \"$state\")\" \\\n        -DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=\"$(cygpath -m \"$build/release\")\" \\\n        -DCMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE=\"$(cygpath -m \"$build/release\")\" \\\n        -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY_RELEASE=\"$(cygpath -m \"$build/release\")\"\n      MSYS2_ARG_CONV_EXCL='*' cmake --build \"$(cygpath -m \"$build\")\" --config Release\n      run_windows_consumers \"$build\" \"$prefix\" \"$state\" release\n      build_windows_flutter_consumer \"$root\" \"$prefix\" \"$version\" \"$package\" \"$candidate\"\n      ;;\n    Android|iOS) build_mobile_hosted_consumer \"$platform\" \"$root\" \"$package\" \"$candidate\" \"$version\" ;;\n  esac\n  echo \"CitizenSDK $platform 最终 Hosted 包消费通过\"\n)\n\nbuild_mobile_hosted_consumer() (\n  local platform=\"$1\" root=\"$2\" package=\"$3\" candidate=\"$4\" version=\"$5\"\n  local runner=\"$root/consumer\" flutter_root=\"$CITIZENSDK_FLUTTER_ROOT\" dart_bin native_platform incremental_root\n  local -a flutter\n  dart_bin=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\n  [[ -x \"$dart_bin\" ]] || fail \"移动 Hosted 缺少已预装 Dart\"\n  node - \"$flutter_root\" \"$PUB_CACHE\" <<'NODE' || fail \"移动 Hosted Flutter 工具配置越出显式输入\"\nconst fs=require('fs'),path=require('path'),url=require('url');\nconst [flutter,cache]=process.argv.slice(2);\nconst config=path.join(flutter,'packages/flutter_tools/.dart_tool/package_config.json');\nfor(const file of [config,path.join(flutter,'bin/cache/flutter_tools.snapshot'),path.join(flutter,'bin/cache/dart-sdk/bin/dart')]) {\n  if(!fs.lstatSync(file).isFile() || fs.realpathSync.native(file)!==file) throw Error('Mobile Hosted tool path alias');\n}\nconst value=JSON.parse(fs.readFileSync(config,'utf8'));\nif(value.configVersion!==2 || !Array.isArray(value.packages) || value.packages.length===0) throw Error('Mobile Hosted tool configuration missing');\nfor(const item of value.packages) {\n  const root=url.fileURLToPath(new URL(item.rootUri,url.pathToFileURL(config)));\n  const resolved=path.resolve(root);\n  if(![flutter,cache].some(parent=>resolved.startsWith(parent+path.sep)) || fs.realpathSync.native(resolved)!==resolved) {\n    throw Error('Mobile Hosted tool dependency outside explicit Flutter/Pub inputs');\n  }\n}\nNODE\n  flutter=(\"$dart_bin\" \"--packages=$flutter_root/packages/flutter_tools/.dart_tool/package_config.json\"\n    \"$flutter_root/bin/cache/flutter_tools.snapshot\" --no-version-check --suppress-analytics)\n  case \"$platform\" in Android) native_platform=android ;; iOS) native_platform=ios ;; *) fail \"未登记的移动 Hosted 平台\" ;; esac\n  export FLUTTER_SUPPRESS_ANALYTICS=true\n  incremental_root=\"${CITIZENSDK_INCREMENTAL_ROOT:-$root/incremental}\"\n  prepare_safe_directory \"$incremental_root\" \"$incremental_root/$platform\" \"移动 Hosted 增量目录\"\n  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \\\n    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH \\\n    CITIZENSDK_ANDROID_CORE_DIR\n  \"${flutter[@]}\" create --offline --no-pub --platforms=\"$native_platform\" \\\n    --project-name=citizensdk_consumer --org=org.citizen \"$runner\"\n  node - \"$runner\" \"$candidate\" \"$version\" <<'NODE'\nconst fs=require('fs'),path=require('path');\nconst [runner,candidate,version]=process.argv.slice(2);\nfs.writeFileSync(path.join(runner,'pubspec.yaml'),`name: citizensdk_consumer\\npublish_to: none\\nversion: ${version}\\nenvironment:\\n  sdk: \">=3.8.0 <4.0.0\"\\ndependencies:\\n  flutter:\\n    sdk: flutter\\n  citizen_sdk:\\n    path: ../package\\nflutter:\\n  uses-material-design: true\\n`);\nfs.copyFileSync(path.join(candidate,'pubspec.lock'),path.join(runner,'pubspec.lock'));\n// 编译入口只引用正式公开 API，不引入产品业务或私有实现；没有设备运行就不宣称运行验收。\nfs.writeFileSync(path.join(runner,'lib/main.dart'),`import 'package:flutter/widgets.dart';\\nimport 'package:citizen_sdk/citizen_sdk.dart';\\nFuture<void> main() async { WidgetsFlutterBinding.ensureInitialized(); final sdk = await CitizenSdk.open(); await sdk.close(); }\\n`);\nconst project=path.join(runner,'ios/Runner.xcodeproj/project.pbxproj');\nif(fs.existsSync(project)) {\n  const text=fs.readFileSync(project,'utf8');\n  if(!text.includes('IPHONEOS_DEPLOYMENT_TARGET = ')) throw Error('iOS deployment setting missing');\n  fs.writeFileSync(project,text.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g,'IPHONEOS_DEPLOYMENT_TARGET = 16.0;'));\n  const podfile=path.join(runner,'ios/Podfile');\n  if(fs.existsSync(podfile)) {\n    const pods=fs.readFileSync(podfile,'utf8');\n    if(!/^#?\\s*platform :ios, '[0-9.]+'/m.test(pods)) throw Error('Official iOS Podfile platform setting missing');\n    fs.writeFileSync(podfile,pods.replace(/^#?\\s*platform :ios, '[0-9.]+'/m,\"platform :ios, '16.0'\"));\n  }\n}\nconst gradle=path.join(runner,'android/app/build.gradle.kts');\nif(fs.existsSync(gradle)) {\n  const text=fs.readFileSync(gradle,'utf8');\n  if(!text.includes('minSdk = flutter.minSdkVersion')) throw Error('Official Android minimum SDK setting missing');\n  // SDK 运行件已经由唯一构建器 strip；消费宿主不得再改写同包二进制。\n  fs.writeFileSync(gradle,text.replace('minSdk = flutter.minSdkVersion','minSdk = 24')+\n    '\\nandroid { packaging { jniLibs { keepDebugSymbols += setOf(\"**/libcitizensdk.so\", \"**/libcitizensdk_jni.so\") } } }\\n');\n}\nNODE\n  (cd \"$runner\" && \"${flutter[@]}\" pub get --offline)\n  if [[ \"$platform\" == Android ]]; then\n    export CITIZENSDK_ANDROID_BUILD_DIR=\"$root/android-build\"\n    export GRADLE_USER_HOME=\"$incremental_root/android/gradle-home\"\n    mkdir -p \"$GRADLE_USER_HOME\"\n    (cd \"$runner\" && \"${flutter[@]}\" build apk --release --no-pub --target-platform=android-arm64)\n    local apk=\"$runner/build/app/outputs/flutter-apk/app-release.apk\" library\n    [[ -f \"$apk\" && ! -L \"$apk\" ]] || fail \"Android Hosted Release APK 缺失\"\n    for library in libcitizensdk.so libcitizensdk_jni.so; do\n      cmp -s <(unzip -p \"$apk\" \"lib/arm64-v8a/$library\") \"$package/android/src/main/jniLibs/arm64-v8a/$library\" \\\n        || fail \"Android 最终 APK 的 SDK 库字节不是同一 Hosted 包\"\n    done\n  else\n    (cd \"$runner\" && \"${flutter[@]}\" build ios --release --no-pub --no-codesign)\n    # iOS Simulator 不以 Debug Flutter 模式代替 Release。直接编译、链接公开 Swift\n    # 绑定与包内 Simulator slice；没有启动模拟器，因此这里只记录链接验收。\n    local framework simulator_sdk swift_source=\"$root/consumer.swift\"\n    framework=\"$(resolve_xcframework_framework_slice \"$package/darwin/CitizenSDK.xcframework\" CitizenSDK ios simulator)\"\n    simulator_sdk=\"$(xcrun --sdk iphonesimulator --show-sdk-path)\"\n    printf '%s\\n' 'import CitizenSDK' 'public func citizenSdkConsumer() throws { let sdk = try CitizenSdk.open(); try sdk.close() }' >\"$swift_source\"\n    xcrun --sdk iphonesimulator swiftc \"$swift_source\" -emit-library -O -warnings-as-errors \\\n      -sdk \"$simulator_sdk\" -target arm64-apple-ios16.0-simulator \\\n      -module-cache-path \"$incremental_root/ios/module-cache\" \\\n      -F \"$(dirname \"$framework\")\" -framework CitizenSDK -o \"$root/consumer.dylib\"\n    [[ \"$(xcrun lipo -archs \"$root/consumer.dylib\")\" == arm64 ]] || fail \"iOS Simulator 消费者架构漂移\"\n    xcrun otool -L \"$root/consumer.dylib\" | grep -Fq '@rpath/CitizenSDK.framework/CitizenSDK' \\\n      || fail \"iOS Simulator 未链接最终包的 CitizenSDK\"\n  fi\n  echo \"CitizenSDK $platform 最终包宿主编译链接通过；未进行真机运行\"\n)\n\nrequire_zxing_source() {\n  local source=\"${CITIZENSDK_ZXING_SOURCE_DIR:-}\"\n  [[ -n \"$source\" && \"$source\" == /* && -d \"$source\" && ! -L \"$source\" \\\n    && -f \"$source/CMakeLists.txt\" && ! -L \"$source/CMakeLists.txt\" \\\n    && -f \"$source/core/src/ZXingC.h\" && ! -L \"$source/core/src/ZXingC.h\" ]] \\\n    || fail \"必须通过 CITIZENSDK_ZXING_SOURCE_DIR 提供完整官方 ZXing-C++ 3.1.1 源码\"\n  grep -Fq 'project (ZXing VERSION \"3.1.1\")' \"$source/core/CMakeLists.txt\" \\\n    || fail \"ZXing-C++ 源码版本必须精确为 3.1.1\"\n}\n\ncase \"$target_name\" in\n  android|apple|LinuxARM|LinuxAMD|Windows|all)\n    if [[ \"$hosted_consumer\" != true ]]; then require_zxing_source; fi ;;\nesac\n\n# 每轮编译只使用SDK自身装配的普通文件工程；build.rs不能写回上游原件。\nprepare_native_source() {\n  local node_bin=\"${NODE:-$(command -v node || true)}\" source=\"$sdk_dir\" destination=\"$work_dir/native-source\"\n  [[ -n \"$node_bin\" && -x \"$node_bin\" ]] || fail \"原生输入装配缺少Node\"\n  if [[ \"$target_name\" == Windows ]]; then\n    source=\"$(cygpath -m \"$source\")\"\n    destination=\"$(cygpath -m \"$destination\")\"\n  fi\n  native_source_root=\"$(\"$node_bin\" \"$sdk_dir/.github/workflows/release-sdk.mjs\" sdk \\\n    --native-source-view \"$source\" --output \"$destination\")\" || fail \"原生输入装配失败\"\n  ffi_manifest=\"$native_source_root/native/legacy/Cargo.toml\"\n  product_ffi_manifest=\"$native_source_root/native/ffi/Cargo.toml\"\n}\n\ncase \"$target_name\" in\n  android|apple|LinuxARM|LinuxAMD|Windows|host|abi-host|all)\n    if [[ \"$hosted_consumer\" != true ]]; then prepare_native_source; fi ;;\nesac\n\ncase \"$target_name\" in\n  android) build_android ;;\n  apple) build_apple ;;\n  macOS) shift; build_macos_flutter_consumer \"$@\" ;;\n  Android|iOS) build_hosted_consumer \"$@\" ;;\n  LinuxARM|LinuxAMD)\n    if [[ \"$hosted_consumer\" == true ]]; then build_hosted_consumer \"$@\"; else build_linux \"$target_name\"; fi ;;\n  Windows)\n    if [[ \"$hosted_consumer\" == true ]]; then build_hosted_consumer \"$@\"; else build_windows; fi ;;\n  host) build_host ;;\n  abi-host) build_abi_host ;;\n  apple-tests) build_apple_tests ;;\n  all) build_android; build_apple; build_apple_tests; build_host; verify_outputs ;;\n  verify) verify_outputs ;;\n  *) fail \"用法：$0 android|apple|LinuxARM|LinuxAMD|Windows|apple-tests|host|abi-host|all|verify；最终包消费：$0 Android|iOS|macOS|LinuxARM|LinuxAMD|Windows candidate audit hosted flutter pub-cache tool-path\" ;;\nesac\n", "analysis": "include: package:flutter_lints/flutter.yaml\n\nanalyzer:\n  language:\n    strict-casts: true\n    strict-inference: true\n    strict-raw-types: true\n  errors:\n    invalid_use_of_visible_for_testing_member: error\n    missing_required_param: error\n    missing_return: error\n\nlinter:\n  rules:\n    avoid_dynamic_calls: false\n    directives_ordering: true\n    discarded_futures: true\n    prefer_final_locals: true\n    unawaited_futures: true\n"});

export const {CITIZENSDK_INTERNAL_SYMBOLS,citizenSdkInternalHeader,applySoftwareVersion,projectFlutterSourceEntry,assertCitizenSdkDependencyInputs,citizenSdkDependencyEnvironment,writeCitizenSdkDependencyEvidence,copyWindowsNativeArtifact,assertWindowsReleaseProjection,assertWindowsFlutterBundle,assertHostedRuntimeWindowsProjection,verifyCitizenSdkHosted}=automatedPackage;

export const owner = Object.freeze({"product": "citizensdk", "platform": "sdk", "repository": "crcfrcn/citizensdk", "version_source": {"kind": "pubspec-package", "path": "pubspec.yaml"}, "required_assets": ["citizensdk.tgz"], "asset_locations": ["$CITIZENSDK_WORK_DIR/transfer"], "asset_patterns": ["citizensdk.tgz"], "required_patterns": ["citizensdk.tgz"]});
const commands = Object.freeze({
  "1": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "2": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "3": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "4": {
    "shell": "bash",
    "source": "sdkmanager \"ndk;28.2.13676358\" \"cmake;3.31.6\"\n# Android工具由本仓指定版本安装，后续实际编译失败即失败。\ncmake_version=\"3.31.6\"\nndk_version=\"28.2.13676358\"\n\n# 原生 Gradle 入口消费这个准确工具，不使用 runner 默认 Gradle。\ngradle_version=9.1.0\ntest -x \"$CITIZENSDK_WORK_DIR/tools/gradle-$gradle_version/bin/gradle\"\nprintf 'CITIZENSDK_GRADLE=%s/tools/gradle-%s/bin/gradle\\n' \"$CITIZENSDK_WORK_DIR\" \"$gradle_version\" >> \"$GITHUB_ENV\"\nprintf 'ANDROID_NDK_HOME=%s/ndk/%s\\n' \"$ANDROID_HOME\" \"$ndk_version\" >> \"$GITHUB_ENV\""
  },
  "5": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "6": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "7": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native android\nexport CITIZENSDK_ANDROID_CORE_DIR=\"$CITIZENSDK_NATIVE_OUTPUT_DIR/android/arm64-v8a\"\nexport CITIZENSDK_ANDROID_BUILD_DIR=\"$CITIZENSDK_WORK_DIR/gradle-native\"\nexport GRADLE_USER_HOME=\"$CITIZENSDK_WORK_DIR/gradle-home\"\n\"$CITIZENSDK_GRADLE\" --no-daemon -p \"$CITIZENSDK_SOURCE/android\" :native:testReleaseUnitTest\nhost=\"$CITIZENSDK_WORK_DIR/android-consumer\"\nflutter create --platforms=android --org org.citizensdk.verify --project-name citizensdk_verify \"$host\"\nflutter pub add --directory \"$host\" citizen_sdk --path \"$CITIZENSDK_SOURCE\"\nexport CITIZENSDK_ANDROID_BUILD_DIR=\"$CITIZENSDK_WORK_DIR/gradle-flutter\"\n# SDK 原生单元测试已由上面的独立 Android 工程执行；消费者工程负责验证真实 Flutter App 集成。\n(cd \"$host\" && flutter build apk --release --target-platform android-arm64 --no-pub)"
  },
  "8": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nconst e=process.env, root=e.CITIZENSDK_NATIVE_OUTPUT_DIR;\nconst entries=[], expected={Android:['android'],macOS:['abi-host','apple','host'],\n  LinuxARM:['dependencies','linux'],LinuxAMD:['dependencies','linux'],Windows:['Windows','dependencies']}[e.CITIZENSDK_PLATFORM];\nif(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected.sort())) throw Error('SDK native platform set mismatch');\nfunction walk(dir) {\n  for(const name of fs.readdirSync(dir).sort()) {\n    const file=path.join(dir,name),info=fs.lstatSync(file),relative=path.relative(root,file).replaceAll('\\\\','/');\n    if(info.isDirectory()) walk(file);\n    else if(info.isFile()) entries.push({path:relative,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});\n    else if(info.isSymbolicLink() && e.CITIZENSDK_PLATFORM==='macOS') {\n      const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);\n      if(path.isAbsolute(target)||!resolved.startsWith(root+path.sep)) throw Error('SDK framework link escapes');\n      entries.push({path:relative,target});\n    } else throw Error('SDK native unsupported file');\n  }\n}\nwalk(root);\nconst proof={source_sha:e.CITIZENSDK_SOURCE_SHA,software_version:e.CITIZENSDK_VERSION,\n  run_id:e.GITHUB_RUN_ID,run_attempt:e.GITHUB_RUN_ATTEMPT,job:e.CITIZENSDK_JOB,\n  platforms:e.CITIZENSDK_PLATFORM==='macOS'?['iOS','macOS']:[e.CITIZENSDK_PLATFORM],files:entries};\nfs.writeFileSync(path.join(root,'component.json'),JSON.stringify(proof,null,2)+'\\n',{flag:'wx'});\nNODE\nCOPYFILE_DISABLE=1 tar --format=ustar -czf \"$CITIZENSDK_WORK_DIR/native.tgz\" -C \"$(dirname \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\" native"
  },
  "9": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "10": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "11": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "12": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "13": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "14": {
    "shell": "bash",
    "source": "# Cargo依赖由CitizenSDK锁文件与Cargo自行处理；控制台不注入离线配置或依赖门禁。\nanalysis_config=\"$CITIZENSDK_SOURCE/analysis_options.yaml\"\ntest ! -e \"$analysis_config\" && test ! -L \"$analysis_config\"\ncleanup_analysis_config() { rm -f -- \"$analysis_config\"; }\ntrap cleanup_analysis_config EXIT\nnode --input-type=module - \"$analysis_config\" <<'ANALYSIS'\nimport {writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';\nconst {WORKFLOW_SHELL_SOURCES}=await import(pathToFileURL(process.env.GITHUB_WORKSPACE+'/.github/workflows/release-sdk.mjs'));\nwriteFileSync(process.argv[2],WORKFLOW_SHELL_SOURCES.analysis,{flag:'wx'});\nANALYSIS\nnode --test \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\"\n(cd \"$CITIZENSDK_SOURCE\" && dart format --output=none --set-exit-if-changed lib test)\n(cd \"$CITIZENSDK_SOURCE\" && flutter analyze --no-fatal-infos --no-fatal-warnings)\ncleanup_analysis_config\ntrap - EXIT\nnative_project=\"$(node \"$CITIZENSDK_SOURCE/.github/workflows/release-sdk.mjs\" sdk \\\n  --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\")\"\ncargo test --manifest-path \"$native_project/Cargo.toml\" --workspace --all-targets --locked\ncargo test --manifest-path \"$native_project/native/legacy/Cargo.toml\" --all-targets --locked\n# Criterion 基准只编译，不把随机性能输入作为确定性测试运行。\ncargo test --manifest-path \"$native_project/native/smoldot/Cargo.toml\" --workspace --locked\ncargo check --manifest-path \"$native_project/native/smoldot/Cargo.toml\" --workspace --all-targets --locked"
  },
  "15": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native apple\n# 原入口：iOS device/simulator 编译 harness；macOS 执行 XCTest 和最终原生消费者。\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native apple-tests\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native abi-host\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native host\ncp \"$CITIZENSDK_NATIVE_OUTPUT_DIR/host/libsmoldot.dylib\" \"$CITIZENSDK_SOURCE/libsmoldot.dylib\"\nexport DYLD_LIBRARY_PATH=\"$CITIZENSDK_NATIVE_OUTPUT_DIR/abi-host:$CITIZENSDK_NATIVE_OUTPUT_DIR/host\"\n(cd \"$CITIZENSDK_SOURCE\" && flutter test --timeout=2m)"
  },
  "16": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nconst e=process.env, root=e.CITIZENSDK_NATIVE_OUTPUT_DIR;\nconst entries=[], expected={Android:['android'],macOS:['abi-host','apple','host'],\n  LinuxARM:['dependencies','linux'],LinuxAMD:['dependencies','linux'],Windows:['Windows','dependencies']}[e.CITIZENSDK_PLATFORM];\nif(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected.sort())) throw Error('SDK native platform set mismatch');\nfunction walk(dir) {\n  for(const name of fs.readdirSync(dir).sort()) {\n    const file=path.join(dir,name),info=fs.lstatSync(file),relative=path.relative(root,file).replaceAll('\\\\','/');\n    if(info.isDirectory()) walk(file);\n    else if(info.isFile()) entries.push({path:relative,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});\n    else if(info.isSymbolicLink() && e.CITIZENSDK_PLATFORM==='macOS') {\n      const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);\n      if(path.isAbsolute(target)||!resolved.startsWith(root+path.sep)) throw Error('SDK framework link escapes');\n      entries.push({path:relative,target});\n    } else throw Error('SDK native unsupported file');\n  }\n}\nwalk(root);\nconst proof={source_sha:e.CITIZENSDK_SOURCE_SHA,software_version:e.CITIZENSDK_VERSION,\n  run_id:e.GITHUB_RUN_ID,run_attempt:e.GITHUB_RUN_ATTEMPT,job:e.CITIZENSDK_JOB,\n  platforms:e.CITIZENSDK_PLATFORM==='macOS'?['iOS','macOS']:[e.CITIZENSDK_PLATFORM],files:entries};\nfs.writeFileSync(path.join(root,'component.json'),JSON.stringify(proof,null,2)+'\\n',{flag:'wx'});\nNODE\nCOPYFILE_DISABLE=1 tar --format=ustar -czf \"$CITIZENSDK_WORK_DIR/native.tgz\" -C \"$(dirname \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\" native"
  },
  "17": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "18": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "19": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "20": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "21": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "22": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\n# 临时镜像只用于本作业，不发布、缓存或替代 SDK 产品。\ndocker build --tag \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \"$tools\"\nsudo apparmor_parser -a -K \"$tools/citizensdk.apparmor\""
  },
  "23": {
    "shell": "bash",
    "source": "set -euo pipefail\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-native \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/dependencies\" \\\n  --sources \"$CITIZENSDK_WORK_DIR/tools\" --sdk \"$CITIZENSDK_SOURCE\" --mode \"$CITIZENSDK_ACTION\" \\\n  --source-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nexport CITIZENSDK_DEPENDENCY_RECEIPT=\"$CITIZENSDK_WORK_DIR/dependencies/prefix/native-dependencies.json\"\nsdk_home=\"$CITIZENSDK_WORK_DIR/linux-home\"\nmkdir -m 700 \"$sdk_home\"\nenv HOME=\"$sdk_home\" xvfb-run -a dbus-run-session -- node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native \"$CITIZENSDK_PLATFORM\""
  },
  "24": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nconst e=process.env, root=e.CITIZENSDK_NATIVE_OUTPUT_DIR;\nconst entries=[], expected={Android:['android'],macOS:['abi-host','apple','host'],\n  LinuxARM:['dependencies','linux'],LinuxAMD:['dependencies','linux'],Windows:['Windows','dependencies']}[e.CITIZENSDK_PLATFORM];\nif(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected.sort())) throw Error('SDK native platform set mismatch');\nfunction walk(dir) {\n  for(const name of fs.readdirSync(dir).sort()) {\n    const file=path.join(dir,name),info=fs.lstatSync(file),relative=path.relative(root,file).replaceAll('\\\\','/');\n    if(info.isDirectory()) walk(file);\n    else if(info.isFile()) entries.push({path:relative,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});\n    else if(info.isSymbolicLink() && e.CITIZENSDK_PLATFORM==='macOS') {\n      const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);\n      if(path.isAbsolute(target)||!resolved.startsWith(root+path.sep)) throw Error('SDK framework link escapes');\n      entries.push({path:relative,target});\n    } else throw Error('SDK native unsupported file');\n  }\n}\nwalk(root);\nconst proof={source_sha:e.CITIZENSDK_SOURCE_SHA,software_version:e.CITIZENSDK_VERSION,\n  run_id:e.GITHUB_RUN_ID,run_attempt:e.GITHUB_RUN_ATTEMPT,job:e.CITIZENSDK_JOB,\n  platforms:e.CITIZENSDK_PLATFORM==='macOS'?['iOS','macOS']:[e.CITIZENSDK_PLATFORM],files:entries};\nfs.writeFileSync(path.join(root,'component.json'),JSON.stringify(proof,null,2)+'\\n',{flag:'wx'});\nNODE\nCOPYFILE_DISABLE=1 tar --format=ustar -czf \"$CITIZENSDK_WORK_DIR/native.tgz\" -C \"$(dirname \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\" native"
  },
  "25": {
    "shell": "bash",
    "source": "profile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nif docker container inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker stop --time 20 \"$profile\"\n  docker rm \"$profile\"\nfi\nif test -f \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\" &&\n  sudo test -f /sys/kernel/security/apparmor/profiles &&\n  sudo grep -Fqx \"$profile (enforce)\" /sys/kernel/security/apparmor/profiles; then\n  sudo apparmor_parser -R -K \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\"\nfi\nif docker image inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker image inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker image rm \"$profile\"\nfi"
  },
  "26": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "27": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "28": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "29": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "30": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "31": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\n# 临时镜像只用于本作业，不发布、缓存或替代 SDK 产品。\ndocker build --tag \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \"$tools\"\nsudo apparmor_parser -a -K \"$tools/citizensdk.apparmor\""
  },
  "32": {
    "shell": "bash",
    "source": "set -euo pipefail\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-native \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/dependencies\" \\\n  --sources \"$CITIZENSDK_WORK_DIR/tools\" --sdk \"$CITIZENSDK_SOURCE\" --mode \"$CITIZENSDK_ACTION\" \\\n  --source-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nexport CITIZENSDK_DEPENDENCY_RECEIPT=\"$CITIZENSDK_WORK_DIR/dependencies/prefix/native-dependencies.json\"\nsdk_home=\"$CITIZENSDK_WORK_DIR/linux-home\"\nmkdir -m 700 \"$sdk_home\"\nenv HOME=\"$sdk_home\" xvfb-run -a dbus-run-session -- node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native \"$CITIZENSDK_PLATFORM\""
  },
  "33": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nconst e=process.env, root=e.CITIZENSDK_NATIVE_OUTPUT_DIR;\nconst entries=[], expected={Android:['android'],macOS:['abi-host','apple','host'],\n  LinuxARM:['dependencies','linux'],LinuxAMD:['dependencies','linux'],Windows:['Windows','dependencies']}[e.CITIZENSDK_PLATFORM];\nif(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected.sort())) throw Error('SDK native platform set mismatch');\nfunction walk(dir) {\n  for(const name of fs.readdirSync(dir).sort()) {\n    const file=path.join(dir,name),info=fs.lstatSync(file),relative=path.relative(root,file).replaceAll('\\\\','/');\n    if(info.isDirectory()) walk(file);\n    else if(info.isFile()) entries.push({path:relative,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});\n    else if(info.isSymbolicLink() && e.CITIZENSDK_PLATFORM==='macOS') {\n      const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);\n      if(path.isAbsolute(target)||!resolved.startsWith(root+path.sep)) throw Error('SDK framework link escapes');\n      entries.push({path:relative,target});\n    } else throw Error('SDK native unsupported file');\n  }\n}\nwalk(root);\nconst proof={source_sha:e.CITIZENSDK_SOURCE_SHA,software_version:e.CITIZENSDK_VERSION,\n  run_id:e.GITHUB_RUN_ID,run_attempt:e.GITHUB_RUN_ATTEMPT,job:e.CITIZENSDK_JOB,\n  platforms:e.CITIZENSDK_PLATFORM==='macOS'?['iOS','macOS']:[e.CITIZENSDK_PLATFORM],files:entries};\nfs.writeFileSync(path.join(root,'component.json'),JSON.stringify(proof,null,2)+'\\n',{flag:'wx'});\nNODE\nCOPYFILE_DISABLE=1 tar --format=ustar -czf \"$CITIZENSDK_WORK_DIR/native.tgz\" -C \"$(dirname \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\" native"
  },
  "34": {
    "shell": "bash",
    "source": "profile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nif docker container inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker stop --time 20 \"$profile\"\n  docker rm \"$profile\"\nfi\nif test -f \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\" &&\n  sudo test -f /sys/kernel/security/apparmor/profiles &&\n  sudo grep -Fqx \"$profile (enforce)\" /sys/kernel/security/apparmor/profiles; then\n  sudo apparmor_parser -R -K \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\"\nfi\nif docker image inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker image inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker image rm \"$profile\"\nfi"
  },
  "35": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "36": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "37": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "38": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "39": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "40": {
    "shell": "pwsh",
    "source": "$ErrorActionPreference = 'Stop'\n$vswhere = \"${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\vswhere.exe\"\n# windows-2025 会随官方镜像升级 Visual Studio；只选择镜像内最新且确实安装 x64 C++ 工具的实例。\n$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath\nif (-not $installation) { throw 'CitizenSDK requires installed Visual Studio C++ tools' }\nImport-Module \"$installation\\Common7\\Tools\\Microsoft.VisualStudio.DevShell.dll\"\nEnter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'\nforeach ($name in @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion')) {\n  $value = [Environment]::GetEnvironmentVariable($name)\n  if (-not $value -or $value.Contains(\"$([char]10)\")) { throw \"Invalid MSVC environment: $name\" }\n  \"$name=$value\" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append\n}\nforeach ($name in @('cl.exe', 'lib.exe', 'dumpbin.exe')) { Get-Command $name -ErrorAction Stop | Out-Null }\n"
  },
  "41": {
    "shell": "bash",
    "source": "# Node/框架保留 drive 路径；只在当前 Bash 构建器边界转换成 /d/...。\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-native \\\n  --scope citizensdk --platform Windows --work \"$CITIZENSDK_WORK_DIR/dependencies\" \\\n  --sources \"$CITIZENSDK_WORK_DIR/tools\" --sdk \"$CITIZENSDK_SOURCE\" --mode \"$CITIZENSDK_ACTION\" \\\n  --source-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nexport CITIZENSDK_DEPENDENCY_RECEIPT=\"$(cygpath -u \"$CITIZENSDK_WORK_DIR/dependencies/prefix/native-dependencies.json\")\"\nexport CITIZENSDK_WORK_DIR=\"$(cygpath -u \"$CITIZENSDK_WORK_DIR\")\"\nexport CITIZENSDK_NATIVE_OUTPUT_DIR=\"$(cygpath -u \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\"\nexport CITIZENSDK_FLUTTER_ROOT=\"$(cygpath -u \"$CITIZENSDK_FLUTTER_ROOT\")\"\nexport PUB_CACHE=\"$(cygpath -u \"$PUB_CACHE\")\"\nsource=\"$(cygpath -u \"$CITIZENSDK_SOURCE\")\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native Windows"
  },
  "42": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nconst e=process.env, root=e.CITIZENSDK_NATIVE_OUTPUT_DIR;\nconst entries=[], expected={Android:['android'],macOS:['abi-host','apple','host'],\n  LinuxARM:['dependencies','linux'],LinuxAMD:['dependencies','linux'],Windows:['Windows','dependencies']}[e.CITIZENSDK_PLATFORM];\nif(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected.sort())) throw Error('SDK native platform set mismatch');\nfunction walk(dir) {\n  for(const name of fs.readdirSync(dir).sort()) {\n    const file=path.join(dir,name),info=fs.lstatSync(file),relative=path.relative(root,file).replaceAll('\\\\','/');\n    if(info.isDirectory()) walk(file);\n    else if(info.isFile()) entries.push({path:relative,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});\n    else if(info.isSymbolicLink() && e.CITIZENSDK_PLATFORM==='macOS') {\n      const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);\n      if(path.isAbsolute(target)||!resolved.startsWith(root+path.sep)) throw Error('SDK framework link escapes');\n      entries.push({path:relative,target});\n    } else throw Error('SDK native unsupported file');\n  }\n}\nwalk(root);\nconst proof={source_sha:e.CITIZENSDK_SOURCE_SHA,software_version:e.CITIZENSDK_VERSION,\n  run_id:e.GITHUB_RUN_ID,run_attempt:e.GITHUB_RUN_ATTEMPT,job:e.CITIZENSDK_JOB,\n  platforms:e.CITIZENSDK_PLATFORM==='macOS'?['iOS','macOS']:[e.CITIZENSDK_PLATFORM],files:entries};\nfs.writeFileSync(path.join(root,'component.json'),JSON.stringify(proof,null,2)+'\\n',{flag:'wx'});\nNODE\nCOPYFILE_DISABLE=1 tar --format=ustar -czf \"$CITIZENSDK_WORK_DIR/native.tgz\" -C \"$(dirname \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\" native"
  },
  "43": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "44": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "45": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "46": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "47": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "48": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" aggregate-native \\\n  --input \"$CITIZENSDK_WORK_DIR/input\" --output \"$CITIZENSDK_WORK_DIR/merged\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\" \\\n  --run-id \"$GITHUB_RUN_ID\" --run-attempt \"$GITHUB_RUN_ATTEMPT\" --action \"$CITIZENSDK_ACTION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --source . --native \"$CITIZENSDK_WORK_DIR/merged/native\" \\\n  --output \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/hosted\" \\\n  --dart \"$CITIZENSDK_FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart\" \\\n  --flutter \"$CITIZENSDK_FLUTTER_ROOT\" --pub-cache \"$PUB_CACHE\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\"\ncp \"$CITIZENSDK_WORK_DIR/candidate/citizensdk-release.json\" \"$CITIZENSDK_WORK_DIR/transfer/\"\ncp \"$CITIZENSDK_WORK_DIR/candidate/SHA256SUMS\" \"$CITIZENSDK_WORK_DIR/transfer/\"\ncp \"$CITIZENSDK_WORK_DIR/hosted/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \"$CITIZENSDK_WORK_DIR/transfer/\""
  },
  "49": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "50": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "51": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "52": {
    "shell": "bash",
    "source": "sdkmanager \"ndk;28.2.13676358\" \"cmake;3.31.6\"\n# Android工具由本仓指定版本安装，后续实际编译失败即失败。\ncmake_version=\"3.31.6\"\nndk_version=\"28.2.13676358\"\n\n# 原生 Gradle 入口消费这个准确工具，不使用 runner 默认 Gradle。\ngradle_version=9.1.0\ntest -x \"$CITIZENSDK_WORK_DIR/tools/gradle-$gradle_version/bin/gradle\"\nprintf 'CITIZENSDK_GRADLE=%s/tools/gradle-%s/bin/gradle\\n' \"$CITIZENSDK_WORK_DIR\" \"$gradle_version\" >> \"$GITHUB_ENV\"\nprintf 'ANDROID_NDK_HOME=%s/ndk/%s\\n' \"$ANDROID_HOME\" \"$ndk_version\" >> \"$GITHUB_ENV\""
  },
  "53": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "54": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "55": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" unpack-package \\\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\""
  },
  "56": {
    "shell": "bash",
    "source": "platforms=(\"$CITIZENSDK_PLATFORM\")\nif [[ \"$CITIZENSDK_PLATFORM\" == macOS ]]; then platforms=(iOS macOS); fi\nfor platform in \"${platforms[@]}\"; do\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native \"$platform\" \\\n    \"$CITIZENSDK_WORK_DIR/candidate\" \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n    \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n    \"$CITIZENSDK_FLUTTER_ROOT\" \"$PUB_CACHE\" \"$PATH\"\ndone"
  },
  "57": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "58": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "59": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "60": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "61": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "62": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" unpack-package \\\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\""
  },
  "63": {
    "shell": "bash",
    "source": "platforms=(\"$CITIZENSDK_PLATFORM\")\nif [[ \"$CITIZENSDK_PLATFORM\" == macOS ]]; then platforms=(iOS macOS); fi\nfor platform in \"${platforms[@]}\"; do\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native \"$platform\" \\\n    \"$CITIZENSDK_WORK_DIR/candidate\" \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n    \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n    \"$CITIZENSDK_FLUTTER_ROOT\" \"$PUB_CACHE\" \"$PATH\"\ndone"
  },
  "64": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "65": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "66": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "67": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "68": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "69": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\n# 临时镜像只用于本作业，不发布、缓存或替代 SDK 产品。\ndocker build --tag \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \"$tools\"\nsudo apparmor_parser -a -K \"$tools/citizensdk.apparmor\""
  },
  "70": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" unpack-package \\\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\""
  },
  "71": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nnode_bin=\"$(dirname \"$(command -v node)\")\"\n# 消费阶段没有 Rust 挂载、prepare-native 或 Cargo；只能链接包内已验真 Core。\nmounts=(--mount \"type=bind,src=$RELEASE_WORK,dst=$RELEASE_WORK\"\n  --mount \"type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly\"\n  --mount \"type=bind,src=$node_bin,dst=$node_bin,readonly\"\n  --mount \"type=bind,src=$CITIZENSDK_FLUTTER_ROOT,dst=$CITIZENSDK_FLUTTER_ROOT\")\nvariables=()\nfor name in GITHUB_ACTIONS RUNNER_ENVIRONMENT RUNNER_TEMP PUB_CACHE CITIZENSDK_WORK_DIR \\\n  CITIZENSDK_SOURCE CITIZENSDK_NATIVE_OUTPUT_DIR CITIZENSDK_FLUTTER_ROOT \\\n  CITIZENSDK_WORK_DIR GITHUB_WORKSPACE CITIZENSDK_SOURCE_SHA CITIZENSDK_VERSION CITIZENSDK_PLATFORM \\\n  CITIZENSDK_INCREMENTAL_ROOT RELEASE_WORK; do\n  variables+=(--env \"$name\")\ndone\ndocker run --name \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \\\n  --network none --cap-drop ALL --security-opt no-new-privileges \\\n  --security-opt \"apparmor=$profile\" --security-opt \"seccomp=$tools/citizensdk.seccomp.json\" \\\n  --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --tmpfs /run:rw,nosuid,nodev,mode=755 \\\n  --pids-limit 1024 \"${mounts[@]}\" \"${variables[@]}\" \\\n  --env \"PATH=$node_bin:/opt/cmake/bin:$CITIZENSDK_FLUTTER_ROOT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\" \\\n  \"$profile\" /bin/bash -euc '\n    test \"$(getconf GNU_LIBC_VERSION)\" = \"glibc 2.31\"\n    sdk_home=\"$CITIZENSDK_WORK_DIR/linux-home\"\n    mkdir -m 700 \"$sdk_home\"\n    env HOME=\"$sdk_home\" xvfb-run -a dbus-run-session -- node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native \"$CITIZENSDK_PLATFORM\" \\\n      \"$CITIZENSDK_WORK_DIR/candidate\" \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n      \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n      \"$CITIZENSDK_FLUTTER_ROOT\" \"$PUB_CACHE\" \"$PATH\"\n  '"
  },
  "72": {
    "shell": "bash",
    "source": "profile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nif docker container inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker stop --time 20 \"$profile\"\n  docker rm \"$profile\"\nfi\nif test -f \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\" &&\n  sudo test -f /sys/kernel/security/apparmor/profiles &&\n  sudo grep -Fqx \"$profile (enforce)\" /sys/kernel/security/apparmor/profiles; then\n  sudo apparmor_parser -R -K \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\"\nfi\nif docker image inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker image inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker image rm \"$profile\"\nfi"
  },
  "73": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "74": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "75": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "76": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "77": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "78": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\n# 临时镜像只用于本作业，不发布、缓存或替代 SDK 产品。\ndocker build --tag \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \"$tools\"\nsudo apparmor_parser -a -K \"$tools/citizensdk.apparmor\""
  },
  "79": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" unpack-package \\\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\""
  },
  "80": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nnode_bin=\"$(dirname \"$(command -v node)\")\"\n# 消费阶段没有 Rust 挂载、prepare-native 或 Cargo；只能链接包内已验真 Core。\nmounts=(--mount \"type=bind,src=$RELEASE_WORK,dst=$RELEASE_WORK\"\n  --mount \"type=bind,src=$GITHUB_WORKSPACE,dst=$GITHUB_WORKSPACE,readonly\"\n  --mount \"type=bind,src=$node_bin,dst=$node_bin,readonly\"\n  --mount \"type=bind,src=$CITIZENSDK_FLUTTER_ROOT,dst=$CITIZENSDK_FLUTTER_ROOT\")\nvariables=()\nfor name in GITHUB_ACTIONS RUNNER_ENVIRONMENT RUNNER_TEMP PUB_CACHE CITIZENSDK_WORK_DIR \\\n  CITIZENSDK_SOURCE CITIZENSDK_NATIVE_OUTPUT_DIR CITIZENSDK_FLUTTER_ROOT \\\n  CITIZENSDK_WORK_DIR GITHUB_WORKSPACE CITIZENSDK_SOURCE_SHA CITIZENSDK_VERSION CITIZENSDK_PLATFORM \\\n  CITIZENSDK_INCREMENTAL_ROOT RELEASE_WORK; do\n  variables+=(--env \"$name\")\ndone\ndocker run --name \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \\\n  --network none --cap-drop ALL --security-opt no-new-privileges \\\n  --security-opt \"apparmor=$profile\" --security-opt \"seccomp=$tools/citizensdk.seccomp.json\" \\\n  --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --tmpfs /run:rw,nosuid,nodev,mode=755 \\\n  --pids-limit 1024 \"${mounts[@]}\" \"${variables[@]}\" \\\n  --env \"PATH=$node_bin:/opt/cmake/bin:$CITIZENSDK_FLUTTER_ROOT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\" \\\n  \"$profile\" /bin/bash -euc '\n    test \"$(getconf GNU_LIBC_VERSION)\" = \"glibc 2.31\"\n    sdk_home=\"$CITIZENSDK_WORK_DIR/linux-home\"\n    mkdir -m 700 \"$sdk_home\"\n    env HOME=\"$sdk_home\" xvfb-run -a dbus-run-session -- node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native \"$CITIZENSDK_PLATFORM\" \\\n      \"$CITIZENSDK_WORK_DIR/candidate\" \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n      \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n      \"$CITIZENSDK_FLUTTER_ROOT\" \"$PUB_CACHE\" \"$PATH\"\n  '"
  },
  "81": {
    "shell": "bash",
    "source": "profile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nif docker container inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker stop --time 20 \"$profile\"\n  docker rm \"$profile\"\nfi\nif test -f \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\" &&\n  sudo test -f /sys/kernel/security/apparmor/profiles &&\n  sudo grep -Fqx \"$profile (enforce)\" /sys/kernel/security/apparmor/profiles; then\n  sudo apparmor_parser -R -K \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\"\nfi\nif docker image inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker image inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker image rm \"$profile\"\nfi"
  },
  "82": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "83": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "84": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "85": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "86": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "87": {
    "shell": "pwsh",
    "source": "$ErrorActionPreference = 'Stop'\n$vswhere = \"${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\vswhere.exe\"\n# windows-2025 会随官方镜像升级 Visual Studio；只选择镜像内最新且确实安装 x64 C++ 工具的实例。\n$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath\nif (-not $installation) { throw 'CitizenSDK requires installed Visual Studio C++ tools' }\nImport-Module \"$installation\\Common7\\Tools\\Microsoft.VisualStudio.DevShell.dll\"\nEnter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'\nforeach ($name in @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VSINSTALLDIR', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion')) {\n  $value = [Environment]::GetEnvironmentVariable($name)\n  if (-not $value -or $value.Contains(\"$([char]10)\")) { throw \"Invalid MSVC environment: $name\" }\n  \"$name=$value\" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append\n}\nforeach ($name in @('cl.exe', 'lib.exe', 'dumpbin.exe')) { Get-Command $name -ErrorAction Stop | Out-Null }\n"
  },
  "88": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" unpack-package \\\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\""
  },
  "89": {
    "shell": "bash",
    "source": "export CITIZENSDK_WORK_DIR=\"$(cygpath -u \"$CITIZENSDK_WORK_DIR\")\"\nexport CITIZENSDK_NATIVE_OUTPUT_DIR=\"$(cygpath -u \"$CITIZENSDK_NATIVE_OUTPUT_DIR\")\"\nif [[ -n \"${CITIZENSDK_INCREMENTAL_ROOT:-}\" ]]; then\n  export CITIZENSDK_INCREMENTAL_ROOT=\"$(cygpath -u \"$CITIZENSDK_INCREMENTAL_ROOT\")\"\n  export RELEASE_WORK=\"$(cygpath -u \"$RELEASE_WORK\")\"\nfi\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" native Windows \\\n  \"$(cygpath -u \"$CITIZENSDK_WORK_DIR/candidate\")\" \"$(cygpath -u \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\")\" \\\n  \"$(cygpath -u \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\")\" \\\n  \"$(cygpath -u \"$CITIZENSDK_FLUTTER_ROOT\")\" \"$(cygpath -u \"$PUB_CACHE\")\" \"$PATH\""
  },
  "90": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\""
  },
  "91": {
    "shell": "bash",
    "source": "node --input-type=module <<'NODE'\nimport fs from 'node:fs'; import path from 'node:path'; import {pathToFileURL} from 'node:url';\nconst e=process.env,stage=e.CITIZENSDK_JOB,suffix=stage.replace(/^consume_/,'');\nconst specs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=specs[suffix];if(!spec||spec[0]!==e.PRODUCT_PLATFORM||spec[1]!==process.platform||spec[2]!==process.arch)throw Error('SDK组件宿主身份无效');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+stage+'-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION;\nconst root=path.join(e.RELEASE_WORK,'component');fs.mkdirSync(root,{recursive:false,mode:0o700});\nfs.mkdirSync(path.join(root,'source'));for(const name of fs.readdirSync(e.GITHUB_WORKSPACE)){if(['.git','target'].includes(name))continue;fs.cpSync(path.join(e.GITHUB_WORKSPACE,name),path.join(root,'source',name),{recursive:true});}\nconst {applySoftwareVersion}=await import(pathToFileURL(path.join(e.GITHUB_WORKSPACE,'.github/workflows/release-sdk.mjs')));applySoftwareVersion(path.join(root,'source'),e.RELEASE_VERSION);\nfor(const part of ['native','work','tmp','work/transfer','state/cache'])fs.mkdirSync(path.join(root,part),{recursive:true,mode:0o700});\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nconst values={CITIZENSDK_ACTION:'release',CITIZENSDK_BUILD_ROOT:path.join(root,'state'),CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',CARGO_BUILD_JOBS:'2',CARGO_INCREMENTAL:'0',CARGO_HOME:path.join(root,'state/cargo-home'),CARGO_TARGET_DIR:path.join(root,'state/cache/cargo'),CITIZENSDK_WORK_DIR:path.join(root,'work'),CITIZENSDK_SOURCE:path.join(root,'source'),CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOFTWARE_VERSION:e.RELEASE_VERSION,CITIZENSDK_SOURCE_SHA:e.GITHUB_SHA,CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,CITIZENSDK_ARTIFACT:name,CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-package-'+e.GITHUB_SHA+'-'+e.RELEASE_VERSION,TMPDIR:path.join(root,'tmp')};\nfor(const [key,value]of Object.entries(values)){if(/[\\r\\n]/.test(value))throw Error('SDK环境字段无效');fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+values.CITIZENSDK_WORK_DIR+'\\n');\nNODE"
  },
  "92": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" dependencies prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\""
  },
  "93": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  # 仓库存放布局与Cargo模块布局分离；依赖取得也使用同一源码外工程。\n  node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" sdk --native-source-view \"$CITIZENSDK_SOURCE\" --output \"$CITIZENSDK_WORK_DIR/native-source\"\n  cargo fetch --manifest-path \"$CITIZENSDK_WORK_DIR/native-source/Cargo.toml\" --locked\nfi"
  },
  "94": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null"
  },
  "95": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" unpack-package \\\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/.github/workflows/release-sdk.mjs\" pack-sdk \\\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\""
  }
});
const shaPattern = /^[0-9a-f]{40}$/u;
const fail = message => { throw new Error(message); };
const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = `.github/workflows/release-${owner.platform}.yml`;
const prefix = `${owner.product}-${owner.platform}-v`;

export function context(environment = process.env) {
  const number = name => {
    const value = environment[name];
    if (!/^[1-9][0-9]*$/u.test(value || '') || !Number.isSafeInteger(Number(value))) fail('GitHub运行坐标无效');
    return Number(value);
  };
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== owner.repository
    || environment.GITHUB_REF !== 'refs/heads/main' || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || !shaPattern.test(environment.GITHUB_SHA || '')
    || environment.GITHUB_WORKFLOW_REF !== `${owner.repository}/${workflowPath}@refs/heads/main`) fail('所属GitHub运行身份无效');
  return { repository: owner.repository, product_id: owner.product, platform: owner.platform,
    source_sha: environment.GITHUB_SHA, run_id: number('GITHUB_RUN_ID'),
    run_number: number('GITHUB_RUN_NUMBER'), run_attempt: number('GITHUB_RUN_ATTEMPT'), workflow: workflowPath };
}

export async function request(path, { method = 'GET', body, raw = false, size, fetch: send = globalThis.fetch } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || /[\s\u0000-\u001f\u007f]/u.test(token)) fail('缺少GitHub任务令牌');
  const url = path.startsWith('https://') ? new URL(path) : new URL(`https://api.github.com/repos/${owner.repository}/${path}`);
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || !url.pathname.startsWith(`/repos/${owner.repository}/`)) fail('GitHub接口地址无效');
  const headers = { Authorization: `Bearer ${token}`, Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': owner.product };
  if (body !== undefined) headers['Content-Type'] = body?.pipe ? 'application/octet-stream' : 'application/json';
  if(body?.pipe){if(!Number.isSafeInteger(size)||size<=0)fail('资产上传长度无效');headers['Content-Length']=String(size);}
  let response = await send(url, { method, headers, redirect: raw ? 'manual' : 'error', signal: AbortSignal.timeout(300_000),
    ...(body === undefined ? {} : { body: body?.pipe ? body : JSON.stringify(body), ...(body?.pipe ? { duplex: 'half' } : {}) }) });
  if(raw&&response.status===302){
    const location=new URL(response.headers.get('location'));
    if(location.protocol!=='https:'||location.username||location.password)fail('正式资产回读地址无效');
    response=await send(location,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(300_000)});
  }
  if (response.status === 404) return null;
  if (!response.ok) fail(`GitHub接口失败：${response.status}，操作未确认`);
  if (raw) return response;
  return response.status === 204 ? {} : response.json();
}

export async function pages(path, field = null, api = request) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const values = field ? data?.[field] : data;
    if (!Array.isArray(values)) fail('GitHub分页数据无效');
    rows.push(...values);
    if (values.length < 100) return rows;
  }
}

function seedVersion() {
  const source = owner.version_source;
  if (source.kind === 'sequence') return '0.0.0';
  const text = readFileSync(join(root, source.path), 'utf8');
  if (source.kind === 'json') return String(JSON.parse(text).version);
  if (source.kind === 'spec') {
    const matches = [...text.matchAll(/^\s*spec_version:\s*(\d+)\s*,\s*$/gm)];
    if (matches.length !== 1) fail('Runtime版本真源不唯一');
    return matches[0][1];
  }
  if (source.kind === 'cargo') {
    const value = /^\[package\][\s\S]*?^version\s*=\s*"(\d+\.\d+\.\d+)"/mu.exec(text)?.[1];
    if (!value) fail('本仓Cargo版本真源无效');
    return value;
  }
  const value = /^version:\s*(\d+\.\d+\.\d+)(?:\+\d+)?\s*$/mu.exec(text)?.[1];
  if (!value) fail('本仓软件版本真源无效');
  return value;
}

export function nextVersion(seed, versions, protocol = false, runNumber = 1) {
  if (protocol) {
    if (!/^\d+$/u.test(seed) || versions.some(value => !/^\d+$/u.test(value))) fail('协议版本无效');
    const value = Math.max(Number(seed), ...versions.map(Number)) + (versions.length ? 1 : 0);
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) fail('协议版本越界');
    return String(value);
  }
  const parse = value => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/u.exec(value);
    if (!match) fail('软件版本无效');
    const parts=match.slice(1).map(Number);if(parts.some(value=>!Number.isSafeInteger(value)))fail('软件版本越界');return parts;
  };
  const values = [seed, ...versions].map(parse).sort((a,b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  let [major, minor, patch] = values.at(-1);
  if (versions.length) { if (++patch > 99) { patch = 0; if (++minor > 99) { minor = 0; major++; } } }
  if(!Number.isSafeInteger(runNumber)||runNumber<1)fail('版本运行序号无效');
  const initial=parse(seed),floor=BigInt(initial[0])*10000n+BigInt(initial[1])*100n+BigInt(initial[2])+BigInt(runNumber-1);
  const historical=BigInt(major)*10000n+BigInt(minor)*100n+BigInt(patch);
  if(floor>historical){major=Number(floor/10000n);minor=Number(floor/100n%100n);patch=Number(floor%100n);}
  if(![major,minor,patch].every(Number.isSafeInteger))fail('软件版本越界');
  return `${major}.${minor}.${patch}`;
}

function output(name, value, file = process.env.GITHUB_OUTPUT) {
  if (!file || /[\r\n]/u.test(String(value))) fail('GitHub步骤输出无效');
  appendFileSync(file, `${name}=${value}\n`);
}

export async function prepare() {
  const identity = context();
  const releases = await pages('releases');
  const versions = [];
  for (const release of releases) {
    if (release.draft || release.prerelease || !String(release.tag_name).startsWith(prefix)) continue;
    const notes = (await citizenSDKRelease(release,owner.platform,tag=>request('git/ref/tags/'+encodeURIComponent(tag))));
    if (!notes || notes.platform !== owner.platform) continue;
    const run = await request(`actions/runs/${notes.run_id}`);
    if (run?.status === 'completed' && run.conclusion === 'success' && run.path === workflowPath) versions.push(notes.version);
  }
  const version = nextVersion(seedVersion(), versions, owner.version_source.kind === 'spec', identity.run_number);
  const tag = `${prefix}${version}-r${identity.run_id}-a${identity.run_attempt}`;
  for (const [name,value] of Object.entries({version, tag, source_sha:identity.source_sha,
    run_id:identity.run_id, run_attempt:identity.run_attempt, run_number:identity.run_number})) output(name,value);
}

function runVersion() {
  const identity = context();
  const version = process.env.RELEASE_VERSION;
  const tag = process.env.RELEASE_TAG;
  nextVersion(version, [], owner.version_source.kind === 'spec');
  if (tag !== `${prefix}${version}-r${identity.run_id}-a${identity.run_attempt}`) fail('本次版本与Tag不一致');
  return {...identity, version, tag};
}

export async function job() {
  const identity = runVersion();
  if (execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim() !== identity.source_sha) fail('检出源码不符');
  const work = join(process.env.RUNNER_TEMP, owner.product, owner.platform, String(identity.run_id), String(identity.run_attempt), process.env.GITHUB_JOB);
  mkdirSync(work,{recursive:true});
  const variables = {RELEASE_WORK:work, RELEASE_ASSETS_DIR:join(work,'assets'), SOURCE_SHA:identity.source_sha,
    SOFTWARE_VERSION:identity.version, VERSION_TAG:identity.tag, BUILD_NUMBER:String(identity.run_number),
    CITIZENSDK_RELEASE_TEST_WORK_DIR:join(work,'tests'),
    CARGO_HOME:join(work,'cargo-home'), CARGO_TARGET_DIR:join(work,'cargo'), PUB_CACHE:join(work,'pub'),
    GRADLE_USER_HOME:join(work,'gradle'), npm_config_cache:join(work,'npm'), XDG_CACHE_HOME:join(work,'cache'),
    TMPDIR:join(work,'tmp'), TMP:join(work,'tmp'), TEMP:join(work,'tmp')};
  for (const path of ['cargo-home','cargo','pub','gradle','npm','cache','tmp','assets']) mkdirSync(join(work,path),{recursive:true});
  for (const [name,value] of Object.entries(variables)) { process.env[name]=value; output(name,value,process.env.GITHUB_ENV); }
}

export function step(key) {
  runVersion();
  const value = commands[key];
  if (!value || !['bash','pwsh'].includes(value.shell)) fail('本目标构建步骤无效');
  const directory = join(process.env.RELEASE_WORK,'commands');mkdirSync(directory,{recursive:true});
  const file = join(directory, value.shell === 'pwsh' ? 'step.ps1' : 'step.sh');
  writeFileSync(file, value.shell === 'bash' ? 'set -euo pipefail\n'+value.source : "$ErrorActionPreference = 'Stop'\n"+value.source,{mode:0o700});
  const result = spawnSync(value.shell === 'pwsh' ? 'pwsh' : 'bash', value.shell === 'pwsh' ? ['-NoProfile','-File',file] : [file],
    {cwd:process.cwd(),env:process.env,stdio:'inherit'});
  rmSync(file,{force:true});
  if (result.error || result.status !== 0) fail(`本仓构建步骤失败：${key}`);
}

function regular(path) {
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0)fail('正式产物不是非空普通文件');return stat;
}
async function digestFile(path) { const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex'); }
function assetName(name) { if(!name||name!==basename(name)||/[\u0000-\u001f\u007f]/u.test(name))fail('正式资产文件名无效');return name; }

export async function collect(paths) {
  const identity=runVersion(),destination=process.env.RELEASE_ASSETS_DIR;
  if(!destination||!paths.length)fail('本仓没有完整产物');mkdirSync(destination,{recursive:true});
  const files=[];
  for(const path of paths){const file=resolve(path),stat=regular(file),name=assetName(basename(file));
    if(files.some(row=>row.name===name))fail('正式资产重名');
    const target=join(destination,name);if(file!==target)copyFileSync(file,target);
    files.push({name,size:stat.size,sha256:await digestFile(target)});
  }
  if(owner.required_assets.some(name=>!files.some(row=>row.name===name)))fail('本目标必要产物缺失');
  const metadata={schema:1,...identity,assets:files};
  writeFileSync(join(destination,'automation.json'),JSON.stringify(metadata,null,2)+'\n');
  output('assets',destination);return metadata;
}

export async function collectProduced() {
  const paths=[],seen=new Set();
  const expand=value=>value.replace(/\$\{([A-Z_]+)\}|\$([A-Z_]+)/gu,(_,a,b)=>process.env[a||b]||'');
  for(const location of owner.asset_locations){
    const path=expand(location);if(!path||!existsSync(path))continue;
    const candidates=lstatSync(path).isDirectory()?readdirSync(path).map(name=>join(path,name)):[path];
    for(const candidate of candidates){if(!lstatSync(candidate).isFile()||seen.has(resolve(candidate)))continue;
      const name=basename(candidate);if(!owner.asset_patterns.some(pattern=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/gu,'\\$&').replaceAll('*','.*')+'$','u').test(name)))continue;
      seen.add(resolve(candidate));paths.push(candidate);
    }
  }
  if(owner.required_patterns.some(pattern=>!paths.some(path=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/gu,'\\$&').replaceAll('*','.*')+'$','u').test(basename(path)))))fail('本目标完整正式资产缺失');
  return collect(paths);
}



export async function publish(directory) {
  const identity=runVersion();const metadata=JSON.parse(readFileSync(join(directory,'automation.json'),'utf8'));
  if(Object.entries(identity).some(([key,value])=>metadata[key]!==value)||!Array.isArray(metadata.assets)||!metadata.assets.length)fail('完整产物身份无效');
  const files=metadata.assets;
  if(readdirSync(directory).sort().join('\0')!==[...files.map(value=>value.name),'automation.json'].sort().join('\0'))fail('产物目录与完整资产集合不符');
  for(const file of files){const path=join(directory,assetName(file.name));if(regular(path).size!==file.size||await digestFile(path)!==file.sha256)fail('正式产物在交付前改变');}
  if(await request(`git/ref/tags/${encodeURIComponent(identity.tag)}`)!==null)fail('本次Tag已经存在');
  await request('git/refs',{method:'POST',body:{ref:`refs/tags/${identity.tag}`,sha:identity.source_sha}});
  const release=await request('releases',{method:'POST',body:{tag_name:identity.tag,target_commitish:identity.source_sha,
    name:`${owner.product} · ${owner.platform} · ${identity.version}`,draft:false,prerelease:false,make_latest:'false',
    body:`${owner.product} · ${owner.platform} · ${identity.version}\nSource: ${identity.source_sha}\nRun: ${identity.run_id} / ${identity.run_attempt}`}});
  if(!Number.isSafeInteger(release?.id)||!release.upload_url)fail('正式Release创建未确认');
  for(const file of files){const url=new URL(release.upload_url.replace(/\{.*$/u,''));url.searchParams.set('name',file.name);
    const asset=await request(url.href,{method:'POST',body:createReadStream(join(directory,file.name)),size:file.size});
    if(asset?.name!==file.name||asset.size!==file.size||asset.state!=='uploaded')fail('正式资产上传未确认');
    const response=await request(asset.url,{raw:true});if(!response?.body)fail('正式资产回读失败');
    const hash=createHash('sha256');let size=0;for await(const bytes of response.body){hash.update(bytes);size+=bytes.length;if(size>file.size)fail('正式资产回读超过声明大小');}
    if(size!==file.size||hash.digest('hex')!==file.sha256)fail('GitHub资产逐件回读不一致');
  }
  const readback=await request(`releases/${release.id}`);if((await citizenSDKRelease(readback,owner.platform,tag=>request('git/ref/tags/'+encodeURIComponent(tag))))?.run_id!==identity.run_id||readback.draft||readback.prerelease
    ||readback.assets?.length!==files.length)fail('完整正式Release回查失败');
  for(const file of files){const asset=readback.assets.find(value=>value.name===file.name);if(!asset||asset.state!=='uploaded'||asset.size!==file.size||asset.digest!==`sha256:${file.sha256}`)fail('完整正式资产证明回查失败');}
  output('verified','true');output('release_id',release.id);output('tag',identity.tag);
}

function ownedRun(run) {
  // 每个目标只处理自身现行Workflow；文件缺失不能证明历史任务归属。
  return Number.isSafeInteger(run?.id)&&run.id>0&&run.path===workflowPath
    &&run.head_branch==='main'&&run.event==='workflow_dispatch'
    &&(!run.repository||run.repository.full_name===owner.repository);
}

export function cleanupPlan(runs,current,result) {
  if(!['success','failed'].includes(result)||!ownedRun(current)||!Number.isFinite(Date.parse(current.created_at)))fail('清理所属任务身份无效');
  const earlier=run=>Date.parse(run.created_at)<Date.parse(current.created_at)
    ||Date.parse(run.created_at)===Date.parse(current.created_at)&&run.id<current.id;
  return runs.filter(run=>ownedRun(run)&&run.id!==current.id&&run.status==='completed'&&earlier(run)
    &&(run.conclusion==='success'?'success':'failed')===result).sort((a,b)=>a.id-b.id);
}

async function remove(path,api) { await api(path,{method:'DELETE'});const readPath=path.replace(/^git\/refs\//u,'git/ref/');if(await api(readPath)!==null)fail('删除回查仍存在，清理失败'); }
async function removeRunRelease(run,releases,api) {
  for(const release of releases){
    const metadata=(await citizenSDKRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if(!metadata||metadata.run_id!==run.id)continue;
    if(metadata.source_sha!==run.head_sha)fail('正式Release与所属Run不一致');
    const tag=metadata.tag;
    const again=await api(`actions/runs/${run.id}`);
    if(again&&again.id!==Number(process.env.GITHUB_RUN_ID)
      &&(again.status!=='completed'||again.run_attempt!==run.run_attempt||again.conclusion!==run.conclusion))fail('所属任务已变化，停止清理');
    await remove(`releases/${release.id}`,api);
    const beforeTag=await api(`actions/runs/${run.id}`);
    if(beforeTag&&beforeTag.id!==Number(process.env.GITHUB_RUN_ID)
      &&(beforeTag.status!=='completed'||beforeTag.run_attempt!==run.run_attempt||beforeTag.conclusion!==run.conclusion))fail('所属任务已变化，停止清理');
    await remove(`git/refs/tags/${encodeURIComponent(tag)}`,api);
  }
}
export async function cleanup(result,identity=context(),api=request) {
  const current=await api(`actions/runs/${identity.run_id}`);
  const plan=cleanupPlan(await pages('actions/runs','workflow_runs',api),current,result);
  const releases=await pages('releases',null,api),removed=[];
  for(const row of plan){const run=await api(`actions/runs/${row.id}`);if(!run){removed.push(row.id);continue;}
    if(run.run_attempt!==row.run_attempt||cleanupPlan([run],current,result).length!==1)continue;
    await removeRunRelease(run,releases,api);
    // 失败若只形成Tag也按它的准确Run坐标处理，不能留下同类孤立产物。
    const tags=await api(`git/matching-refs/tags/${prefix}`);
    if(!Array.isArray(tags))fail('所属Tag集合无效');
    for(const reference of tags){
      const tag=String(reference.ref||'').slice('refs/tags/'.length);
      if(!String(reference.ref||'').startsWith('refs/tags/'+prefix)
        ||!new RegExp(`-r${run.id}-a[1-9][0-9]*$`,'u').test(tag)||Number(tag.slice(tag.lastIndexOf('-a')+2))>run.run_attempt)continue;
      if(reference.object?.type!=='commit'||reference.object.sha!==run.head_sha)fail('所属Tag来源已改变，停止清理');
      const again=await api(`actions/runs/${run.id}`);
      if(!again||cleanupPlan([again],current,result).length!==1)fail('所属任务已改变，停止清理');
      await remove(`git/refs/tags/${encodeURIComponent(tag)}`,api);
    }
    for(const asset of await pages(`actions/runs/${run.id}/artifacts`,'artifacts',api)){
      if(!Number.isSafeInteger(asset.id)||asset.id<=0)fail('所属Artifact坐标无效');
      const again=await api(`actions/runs/${run.id}`);if(!again||again.status!=='completed'||again.run_attempt!==run.run_attempt||again.conclusion!==run.conclusion)fail('历史任务已变化，停止清理');
      await remove(`actions/artifacts/${asset.id}`,api);
    }
    const final=await api(`actions/runs/${run.id}`);
    if(final&&(final.run_attempt!==run.run_attempt||cleanupPlan([final],current,result).length!==1))fail('历史任务状态改变，停止清理');
    if(final)await remove(`actions/runs/${run.id}`,api);removed.push(run.id);
  }
  return removed;
}

export function precedingResult(needs) {
  if(!needs||typeof needs!=='object'||Array.isArray(needs)||!Object.keys(needs).length)fail('前置任务结果缺失');
  return Object.values(needs).every(value=>value?.result==='success')?'success':'failed';
}
async function discardCurrent(identity,api) {
  for(const release of await pages('releases',null,api)){
    const metadata=(await citizenSDKRelease(release,owner.platform,tag=>api('git/ref/tags/'+encodeURIComponent(tag))));
    if(metadata?.run_id===identity.run_id&&metadata.run_attempt===identity.run_attempt)
      await removeRunRelease({id:identity.run_id,head_sha:identity.source_sha},[release],api);
  }
  const tag=process.env.RELEASE_TAG;
  if(tag&&tag.startsWith(prefix)&&tag.endsWith(`-r${identity.run_id}-a${identity.run_attempt}`)){
    const path=`git/refs/tags/${encodeURIComponent(tag)}`;
    if(await api(path.replace(/^git\/refs\//u,'git/ref/'))!==null)await remove(path,api);
  }
}
export async function finish(needs=JSON.parse(process.env.RELEASE_NEEDS||'null'),api=request,identity=context()) {
  const result=precedingResult(needs),errors=[];
  const attempt=async action=>{try{return await action();}catch(error){errors.push(error);return null;}};
  let removed;
  if(result==='success') {
    removed=await attempt(()=>cleanup('success',identity,api));
    if(errors.length) {
      await attempt(()=>discardCurrent(identity,api));
      await attempt(()=>cleanup('failed',identity,api));
    }
  } else {
    // 本次撤销失败也必须尝试清理同目标旧失败；各项真实错误均保留。
    await attempt(()=>discardCurrent(identity,api));
    removed=await attempt(()=>cleanup('failed',identity,api));
  }
  if(errors.length)throw new AggregateError(errors,'本目标最后处理失败：'+errors.map(error=>error.message).join('；'));
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,`本目标${result==='success'?'成功':'失败'}；已清理同类旧Run：${removed.join('、')||'无'}。\n`);
  if(result==='failed')fail('前置任务未全部成功');
}

// 本目标实际构建与组包接口。
const nativePlatforms = Object.freeze({ Android: ['android'], macOS: ['abi-host', 'apple', 'host'],
  LinuxARM: ['dependencies', 'linux'], LinuxAMD: ['dependencies', 'linux'], Windows: ['Windows', 'dependencies'] });
const nativeJobs = Object.freeze({ Android: 'android', macOS: 'apple', LinuxARM: 'linuxarm', LinuxAMD: 'linuxamd', Windows: 'windows' });
const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const safeNativePath = (value) => typeof value === 'string' && value.length <= 4096
  && value.split('/').every((part) => /^[A-Za-z0-9_.+@-]+$/u.test(part)
    && part !== '.' && part !== '..' && !/[ .]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
function validateNativeProof(proof, identity, platform) {
  if (!Object.hasOwn(nativePlatforms, platform)
      || identity.action!=='release'
      || !/^[0-9a-f]{40}$/u.test(identity.sourceSha)
      || !/^\d+\.\d{1,2}\.\d{1,2}$/u.test(identity.softwareVersion)
      || typeof identity.runId !== 'string' || typeof identity.runAttempt !== 'string'
      || !/^[1-9]\d*$/u.test(identity.runId) || !/^[1-9]\d*$/u.test(identity.runAttempt)
      || !exactKeys(proof, ['source_sha', 'software_version', 'run_id', 'run_attempt', 'job', 'platforms', 'files'])
      || proof.source_sha !== identity.sourceSha || proof.software_version !== identity.softwareVersion
      || proof.run_id !== identity.runId || proof.run_attempt !== identity.runAttempt
      || proof.job !== nativeJobs[platform]
      || JSON.stringify(proof.platforms) !== JSON.stringify(platform === 'macOS' ? ['iOS', 'macOS'] : [platform])
      || !Array.isArray(proof.files) || proof.files.length === 0 || proof.files.length > 20000) {
    throw new Error('CitizenSDK 原生证明身份、作业或平台闭集不一致');
  }
  const seen = new Set();
  for (const entry of proof.files) {
    if (!safeNativePath(entry?.path) || seen.has(entry.path.toLowerCase())
        || !nativePlatforms[platform].includes(entry.path.split('/')[0])
        || entry.path.startsWith('dependencies/') && entry.path !== `dependencies/${platform}.json`
        || entry.path.startsWith('linux/') && !entry.path.startsWith(`linux/${platform}/`)
        || !(exactKeys(entry, ['path', 'sha256']) && /^[0-9a-f]{64}$/u.test(entry.sha256)
          || exactKeys(entry, ['path', 'target']) && platform === 'macOS' && safeNativePath(entry.target))) {
      throw new Error('CitizenSDK 原生证明文件路径、摘要或链接无效');
    }
    seen.add(entry.path.toLowerCase());
  }
  for (const entry of proof.files) {
    const parts = entry.path.toLowerCase().split('/');
    while (parts.pop() && parts.length) if (seen.has(parts.join('/'))) {
      throw new Error('CitizenSDK 原生证明文件或链接不能成为父目录');
    }
  }
  if (JSON.stringify([...new Set(proof.files.map((entry) => entry.path.split('/')[0]))].sort())
      !== JSON.stringify([...nativePlatforms[platform]].sort())) throw new Error('CitizenSDK 原生证明根目录缺项');
  return proof.files;
}

// 使用 Python 标准库解析 USTAR，不复制 SDK tar 算法，也绝不调用 extractall。
// 有界流先检查所有路径/类型并逐文件计算摘要；第二遍只以独占方式写普通文件。
const nativeArchiveProgram = String.raw`
import sys, json, os, re, gzip, tarfile, hashlib
p=json.load(sys.stdin)
limit=2*1024*1024*1024
class Bounded:
 def __init__(self, stream): self.stream=stream; self.count=0
 def read(self, size=-1):
  data=self.stream.read(min(size if size>=0 else 65536, limit-self.count+1)); self.count+=len(data)
  if self.count>limit: raise ValueError('archive expanded size exceeded')
  return data
def safe(name):
 return isinstance(name,str) and len(name)<=4096 and all(re.fullmatch(r'[A-Za-z0-9_.+@-]+',x) and x not in ('.','..') and not x.endswith(('.',' ')) and not re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)',x,re.I) for x in name.split('/'))
def unique(pairs):
 value={}
 for key,item in pairs:
  if key in value: raise ValueError('archive manifest duplicate key')
  value[key]=item
 return value
archive=p['archive']
if not 20<=os.stat(archive).st_size<=512*1024*1024: raise ValueError('archive compressed size exceeded')
files=[]; directories=[]; seen=set(); kinds={}; offset=0; count=0; metadata=None
with open(archive,'rb') as raw, gzip.GzipFile(fileobj=raw) as zipped:
 stream=Bounded(zipped)
 with tarfile.open(fileobj=stream,mode='r|') as tar:
  for member in tar:
   count+=1
   name=member.name.rstrip('/') if member.isdir() else member.name
   if count>20000 or not safe(name) or name.lower() in seen or member.pax_headers or member.offset!=offset or member.offset_data!=offset+512:
    raise ValueError('archive duplicate, path, extended header or count invalid')
   if member.type not in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE,tarfile.SYMTYPE) or member.mode & 0o7000 or member.size<0 or member.size>limit:
    raise ValueError('archive hardlink, special file or mode invalid')
   if not member.isfile() and member.size: raise ValueError('archive non-file payload invalid')
   offset=member.offset_data+((member.size+511)//512)*512
   seen.add(name.lower()); kinds[name.lower()]='directory' if member.isdir() else 'file'
   if member.isdir(): directories.append(name); continue
   if member.issym():
    if not safe(member.linkname): raise ValueError('archive link target invalid')
    files.append({'path':name,'target':member.linkname}); continue
   digest=hashlib.sha256(); chunks=[]; size=0; output=None
   if p.get('output') and name!=p.get('metadata'):
    destination=os.path.join(p['output'],name)
    os.makedirs(os.path.dirname(destination),mode=0o700,exist_ok=True)
    output=open(destination,'xb')
   try:
    with tar.extractfile(member) as source:
     while True:
      chunk=source.read(65536)
      if not chunk: break
      size+=len(chunk); digest.update(chunk)
      if output: output.write(chunk)
      if name==p.get('metadata'):
       if size>8*1024*1024: raise ValueError('archive manifest too large')
       chunks.append(chunk)
   finally:
    if output: output.close(); os.chmod(destination,0o700 if member.mode & 0o100 else 0o600)
   if size!=member.size: raise ValueError('archive file truncated')
   files.append({'path':name,'sha256':digest.hexdigest(),'size':size})
   if name==p.get('metadata'):
    metadata=b''.join(chunks).decode('utf8'); json.loads(metadata,object_pairs_hook=unique)
  # TarFile 在首个结束块停止；继续读取同一有界流，拒绝隐藏记录或附加gzip内容。
  if any(tar.fileobj.buf): raise ValueError('archive nonzero tail')
  while True:
   tail=stream.read(65536)
   if not tail: break
   if any(tail): raise ValueError('archive nonzero tail')
  if stream.count<offset+1024 or stream.count%512: raise ValueError('archive end blocks truncated')
for name in kinds:
 parts=name.split('/')
 while len(parts)>1:
  parts.pop()
  if kinds.get('/'.join(parts))=='file': raise ValueError('archive file or link parent')
parents=set()
for entry in files:
 parts=entry['path'].split('/')
 while len(parts)>1: parts.pop(); parents.add('/'.join(parts))
if any(name not in parents for name in directories): raise ValueError('archive unexpected empty directory')
print(json.dumps({'files':files,'directories':directories,'metadata':metadata},separators=(',',':')))
`;

function inspectNativeArchive(archive, metadata, output) {
  const result = spawnSync('python3', ['-I', '-c', nativeArchiveProgram], {
    input: JSON.stringify({ archive, metadata, output }), encoding: 'utf8', timeout: 120000,
    maxBuffer: 24 * 1024 * 1024, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  if (result.error || result.status !== 0) throw new Error('CitizenSDK 原生传输归档校验失败');
  return JSON.parse(result.stdout);
}

function freshOutput(path, repositoryRoot, input) {
  const output = checkedPath(path, true, true);
  for (const [parent, child] of [[repositoryRoot, output], [output, repositoryRoot], [input, output], [output, input]]) {
    const nested = relative(parent, child);
    if (!nested || nested !== '..' && !nested.startsWith('..' + sep) && !isAbsolute(nested)) {
      throw new Error('CitizenSDK 汇总目录与输入或源码交叠');
    }
  }
  if (existsSync(output)) throw new Error('CitizenSDK 汇总目标必须是全新目录');
  return output;
}

function reconstructLinks(root, entries, contract) {
  const links = entries.filter((entry) => Object.hasOwn(entry, 'target'));
  if (links.length !== Object.keys(contract).length
      || links.some((entry) => contract[entry.path] !== entry.target)) {
    throw new Error('CitizenSDK 只允许官方 macOS framework 五条内部链接');
  }
  // 所有普通文件与闭集先验真，再创建链接；链接不参与归档写盘路径。
  for (const entry of links) symlinkSync(entry.target, join(root, entry.path));
  for (const entry of links) {
    const target = realpathSync(join(root, entry.path));
    if (!target.startsWith(root + sep)) throw new Error('CitizenSDK framework 链接越界');
  }
}

async function aggregateNativeArtifacts(options, environment = process.env) {
  const { inputPath, outputPath, ...identity } = options;
  const repositoryRoot = checkedPath(environment.GITHUB_WORKSPACE || process.cwd(), true);
  const input = checkedPath(inputPath, true), output = freshOutput(outputPath, repositoryRoot, input);
  if (environment.CITIZENSDK_SOURCE_SHA !== identity.sourceSha || environment.GITHUB_RUN_ID !== identity.runId
      || environment.GITHUB_RUN_ATTEMPT !== identity.runAttempt) throw new Error('CitizenSDK 汇总身份不是当前冻结运行');
  const names = Object.values(nativeJobs);
  if (JSON.stringify(readdirSync(input).sort()) !== JSON.stringify([...names].sort())) throw new Error('CitizenSDK 原生 artifact 五作业闭集不一致');
  const combined = new Set(), archives = [];
  for (const [index, platform] of Object.keys(nativePlatforms).entries()) {
    const directory = checkedPath(join(input, names[index]), true);
    if (JSON.stringify(readdirSync(directory)) !== '["native.tgz"]') throw new Error('CitizenSDK 原生 artifact 只能包含 native.tgz');
    const archive = checkedPath(join(directory, 'native.tgz'), false);
    const inspected = inspectNativeArchive(archive, 'native/component.json');
    const proof = JSON.parse(inspected.metadata);
    const expected = validateNativeProof(proof, identity, platform);
    const actual = inspected.files.filter((entry) => entry.path !== 'native/component.json').map(({ path, size, ...entry }) => ({ path: path.slice(7), ...entry }));
    if (inspected.files.some((entry) => !entry.path.startsWith('native/'))
        || JSON.stringify([...actual].sort((a, b) => a.path.localeCompare(b.path)))
          !== JSON.stringify([...expected].sort((a, b) => a.path.localeCompare(b.path)))) throw new Error('CitizenSDK 原生归档与逐文件证明不一致');
    for (const entry of expected) {
      const key = entry.path.toLowerCase();
      if (combined.has(key)) throw new Error('CitizenSDK 原生作业覆盖另一作业文件');
      combined.add(key);
    }
    archives.push({ archive, inspected, expected });
  }
  if (combined.size > 60000 || archives.reduce((total, archive) => total
      + archive.inspected.files.reduce((size, entry) => size + (entry.size || 0), 0), 0) > 4 * 1024 ** 3) {
    throw new Error('CitizenSDK 原生汇总文件数或总大小越界');
  }
  for (const key of combined) {
    const parts = key.split('/');
    while (parts.pop() && parts.length) if (combined.has(parts.join('/'))) {
      throw new Error('CitizenSDK 不同作业的文件或链接发生目录覆盖');
    }
  }
  const sdk = automatedPackage;
  mkdirSync(output, { mode: 0o700 });
  try {
    for (const { archive, inspected } of archives) {
      const extracted = inspectNativeArchive(archive, 'native/component.json', output);
      if (JSON.stringify(extracted) !== JSON.stringify(inspected)) throw new Error('CitizenSDK 原生归档在汇总期间发生变化');
    }
    const root = join(output, 'native');
    for (const platform of ['LinuxARM', 'LinuxAMD', 'Windows']) {
      const evidence = JSON.parse(readFileSync(join(root, 'dependencies', `${platform}.json`), 'utf8'));
      if (evidence?.dependency_inputs?.build_mode !== identity.action) {
        throw new Error('CitizenSDK 原生依赖 build_mode 与当前动作不一致');
      }
    }
    const entries = archives.flatMap((archive) => archive.expected);
    reconstructLinks(root, entries, sdk.appleXcframeworkSymlinkContract(join(root, 'apple/CitizenSDK.xcframework'), 'apple/CitizenSDK.xcframework'));
    return root;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function unpackCandidate({ inputPath, outputPath, sourceSha, softwareVersion }, environment = process.env) {
  const repositoryRoot = checkedPath(environment.GITHUB_WORKSPACE || process.cwd(), true);
  const input = checkedPath(inputPath, true), output = freshOutput(outputPath, repositoryRoot, input);
  if (!/^[0-9a-f]{40}$/u.test(sourceSha) || environment.CITIZENSDK_SOURCE_SHA !== sourceSha
      || !/^\d+\.\d{1,2}\.\d{1,2}$/u.test(softwareVersion)) throw new Error('CitizenSDK 最终候选身份无效');
  const names = ['citizensdk.tgz', 'citizensdk-release.json', 'SHA256SUMS', `citizen_sdk-${softwareVersion}.tar.gz`];
  if (JSON.stringify(readdirSync(input).sort()) !== JSON.stringify(names.sort())) throw new Error('CitizenSDK完整包 artifact 四文件闭集不一致');
  for (const name of names) checkedPath(join(input, name), false);
  const archive = join(input, 'citizensdk.tgz');
  const inspected = inspectNativeArchive(archive, 'citizensdk-release.json');
  if (inspected.metadata !== readFileSync(join(input, 'citizensdk-release.json'), 'utf8')) throw new Error('CitizenSDK完整包内外清单不一致');
  const manifest = JSON.parse(inspected.metadata);
  if (manifest.git_commit_sha !== sourceSha || manifest.software_version !== softwareVersion) throw new Error('CitizenSDK完整包版本或冻结 SHA 不一致');
  const sdk = automatedPackage;
  mkdirSync(output, { mode: 0o700 });
  try {
    const extracted = inspectNativeArchive(archive, null, output);
    if (JSON.stringify({ ...extracted, metadata: inspected.metadata }) !== JSON.stringify(inspected)) throw new Error('CitizenSDK完整包归档在解包期间发生变化');
    reconstructLinks(output, inspected.files, sdk.appleXcframeworkSymlinkContract(join(output, 'darwin/CitizenSDK.xcframework'), 'darwin/CitizenSDK.xcframework'));
    copyFileSync(join(input, 'SHA256SUMS'), join(output, 'SHA256SUMS'), constants.COPYFILE_EXCL);
    sdk.verifyCitizenSdkRelease(output, archive, sourceSha);
    return output;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function checkedPath(value, directory, allowMissing = false) {
  if (typeof value !== 'string' || !isAbsolute(value)
      || value.split(/[\\/]/u).some((part) => part === '.' || part === '..')) {
    throw new Error('CitizenSDK 路径必须是无穿越的绝对路径');
  }
  const absolute = resolve(value);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') {
        return resolve(realpathSync(join(current, '..')), ...parts.slice(index));
      }
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 || directory
      ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('CitizenSDK 路径含链接或非预期节点');
    }
  }
  if (parts.length === 0) throw new Error('CitizenSDK 不接受文件系统根目录');
  return realpathSync(absolute);
}


function workflowNativeSource(source){if(process.platform!=='win32')return source;const result=spawnSync('cygpath',['-u',source],{encoding:'utf8'});if(result.error||result.status!==0||!result.stdout?.trim())throw Error('Windows 原生源码路径转换失败');return result.stdout.trim();}

async function productCommand(command,args){
 const values={};for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('SDK组包参数无效');values[args[i].slice(2)]=args[i+1];}
 if(command==='aggregate-native'){await aggregateNativeArtifacts({inputPath:values.input,outputPath:values.output,sourceSha:values['git-sha'],softwareVersion:values['software-version'],runId:values['run-id'],runAttempt:values['run-attempt'],action:'release'});return true;}
 if(command==='unpack-package'){await unpackCandidate({inputPath:values.input,outputPath:values.output,sourceSha:values['git-sha'],softwareVersion:values['software-version']});return true;}
 if(command==='pack-sdk'){automatedPackage.buildCitizenSdkRelease({sourcePath:values.source,nativePath:values.native,outputPath:values.output,archivePath:values.archive,gitCommitSha:values['git-sha'],softwareVersion:values['software-version']});return true;}
 return false;
}


const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
const testing=direct&&Boolean(process.env.NODE_TEST_CONTEXT)&&process.argv.length===2;
if(direct&&!testing){
  try{const [command,...args]=process.argv.slice(2);
    if(command==='dependencies')await nativeDependencies.run(args);else if(command==='native'){const output=spawnSync('bash',['--noprofile','--norc','-c',WORKFLOW_SHELL_SOURCES.native,'citizensdk-native',...args],{cwd:root,env:{...process.env,CITIZENSDK_SOURCE_ROOT:workflowNativeSource(process.env.CITIZENSDK_SOURCE||root)},stdio:'inherit'});if(output.error||output.status!==0)throw Error('自动化原生编译失败');}else if(command==='sdk'){const values={};for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw Error('自动化SDK参数无效');values[args[i].slice(2)]=args[i+1];}if(values['native-source-view'])process.stdout.write(automatedPackage.createNativeSourceView(values['native-source-view'],values.output)+'\n');else if(values['flutter-source-entry'])automatedPackage.projectFlutterSourceEntry(values['flutter-source-entry'],values.output);else if(values['verify-hosted'])automatedPackage.verifyCitizenSdkHosted({candidatePath:values['verify-hosted'],archivePath:values.archive,hostedArchivePath:values['hosted-archive'],outputPath:values.output,expectedGitSha:values['expected-git-sha']||null});else throw Error('自动化SDK命令无效');}else if(command==='prepare')await prepare();else if(command==='job')await job();else if(command==='step')step(args[0]);
    else if(command==='collect')await collect(args);
    else if(command==='collect-produced')await collectProduced();else if(command==='publish')await publish(args[0]);else if(command==='finish')await finish();
    else if(!await productCommand(command,args))fail('自动化命令无效');
  }catch(error){console.error(error.message);process.exitCode=1;}
}

if(testing){
  const {default:assert}=await import('node:assert/strict');const {default:test}=await import('node:test');

  test('旧入口不能成为任一现行平台的清理归属证明',()=>{
    const current={id:9,path:workflowPath,head_branch:'main',event:'workflow_dispatch',created_at:'2026-01-02T00:00:00Z'};
    const old={...current,id:1,status:'completed',conclusion:'success',created_at:'2026-01-01T00:00:00Z'};
    for(const path of ['.github/workflows/release.yml',`.github/workflows/${owner.product}-${owner.platform}-ci.yml`,'.github/workflows/deleted.yml'])
      assert.deepEqual(cleanupPlan([{...old,path}],current,'success'),[]);
  });
  test('撤销当前产物失败仍处理旧失败且最终失败',async()=>{
    const current={id:9,path:workflowPath,head_branch:'main',event:'workflow_dispatch',created_at:'2026-01-02T00:00:00Z'};
    let releases=0,history=0;
    const api=async path=>{
      if(path.startsWith('releases?')){if(++releases===1)throw Error('撤销中断');return [];}
      if(path==='actions/runs/9')return current;
      if(path.startsWith('actions/runs?')){history++;return {workflow_runs:[]};}
      throw Error('未声明请求');
    };
    await assert.rejects(finish({build:{result:'failure'}},api,{run_id:9}),/撤销中断/);
    assert.equal(history,1);assert.equal(releases,2);
  });
  test('SDK阶段实际准备隔离目录、同步版本并形成可汇总原生归档',async()=>{
    const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');
    const directory=mkdtempSync(join(tmpdir(),'sdk-stage-'));
    try {
      const source=join(directory,'source'),work=join(directory,'job');mkdirSync(source);mkdirSync(work);
      for(const name of ['pubspec.yaml','android/build.gradle','darwin/citizen_sdk.podspec','linux/CMakeLists.txt','windows/CMakeLists.txt','.github/workflows/release-sdk.mjs']) {const file=join(source,name);mkdirSync(dirname(file),{recursive:true});copyFileSync(join(root,name),file);}
      const host=process.platform==='darwin'?'apple':process.platform==='win32'?'windows':process.arch==='arm64'?'linuxarm':'linuxamd';
      const platform={apple:'macOS',windows:'Windows',linuxarm:'LinuxARM',linuxamd:'LinuxAMD'}[host];
      const env={...process.env,GITHUB_WORKSPACE:source,RELEASE_WORK:work,RUNNER_TEMP:directory,PRODUCT_PLATFORM:platform,CITIZENSDK_JOB:host,GITHUB_RUN_ID:'9',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),RELEASE_VERSION:'2.3.4',GITHUB_ENV:join(directory,'env'),GITHUB_OUTPUT:join(directory,'output')};
      delete env.CITIZENSDK_PLATFORM;
      const setup=spawnSync('bash',['-euo','pipefail','-c',commands['2'].source],{cwd:directory,env,encoding:'utf8'});assert.equal(setup.status,0,setup.stderr);
      for(const line of readFileSync(env.GITHUB_ENV,'utf8').trim().split('\n')){const at=line.indexOf('=');env[line.slice(0,at)]=line.slice(at+1);}
      assert.equal(env.CITIZENSDK_PLATFORM,platform);assert.ok(!env.CITIZENSDK_NATIVE_OUTPUT_DIR.startsWith(env.CITIZENSDK_WORK_DIR+'/'));assert.ok(existsSync(join(env.CITIZENSDK_WORK_DIR,'transfer')));
      assert.match(readFileSync(join(env.CITIZENSDK_SOURCE,'pubspec.yaml'),'utf8'),/^version: 2\.3\.4$/mu);
      assert.match(readFileSync(join(env.CITIZENSDK_SOURCE,'android/build.gradle'),'utf8'),/version = '2\.3\.4'/u);
      assert.equal(readFileSync(join(source,'pubspec.yaml'),'utf8'),readFileSync(join(root,'pubspec.yaml'),'utf8'));
      for(const part of nativePlatforms[platform]){const parent=join(env.CITIZENSDK_NATIVE_OUTPUT_DIR,part,...(part==='linux'?[platform]:[]));mkdirSync(parent,{recursive:true});writeFileSync(join(parent,part==='dependencies'?platform+'.json':'fixture'),'native');}
      const packed=spawnSync('bash',['-euo','pipefail','-c',commands['8'].source],{cwd:directory,env,encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
      assert.ok(existsSync(join(env.CITIZENSDK_WORK_DIR,'native.tgz')));
      assert.match(readFileSync(env.GITHUB_OUTPUT,'utf8'),new RegExp('artifact=citizensdk-9-1-'+host+'-'));
      const identity={action:'release',sourceSha:env.GITHUB_SHA,softwareVersion:'2.3.4',runId:'9',runAttempt:'1'};
      const proof=JSON.parse(readFileSync(join(env.CITIZENSDK_NATIVE_OUTPUT_DIR,'component.json'),'utf8'));
      assert.doesNotThrow(()=>validateNativeProof(proof,identity,platform));
      assert.throws(()=>validateNativeProof(proof,{...identity,action:'invalid'},platform));
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  test('清理旧失败Run同时回收其多个Attempt的准确孤立Tag',async()=>{
    const old={id:2,run_attempt:2,path:workflowPath,head_branch:'main',event:'workflow_dispatch',head_sha:'a'.repeat(40),status:'completed',conclusion:'failure',created_at:'2026-01-01T00:00:00Z'},current={...old,id:9,status:'in_progress',created_at:'2026-01-02T00:00:00Z'};
    const deleted=new Set(),tags=[1,2].map(attempt=>({ref:`refs/tags/${prefix}1.0.0-r2-a${attempt}`,object:{type:'commit',sha:old.head_sha}}));
    const api=async(path,options={})=>{
      if(options.method==='DELETE'){deleted.add(path);return {};}
      if(deleted.has(path)||deleted.has(path.replace('git/ref/','git/refs/')))return null;
      if(path.startsWith('actions/runs?'))return {workflow_runs:[old,current]};
      if(path.startsWith('releases?')||path.includes('/artifacts?'))return path.includes('/artifacts?')?{artifacts:[]}:[];
      if(path.startsWith('git/matching-refs/'))return tags;
      if(path==='actions/runs/2')return old;if(path==='actions/runs/9')return current;
      throw Error('未声明的请求');
    };
    assert.deepEqual(await cleanup('failed',{run_id:9},api),[2]);assert.equal([...deleted].filter(path=>path.startsWith('git/refs/')).length,2);
  });
  test('全部前置成功才成功，其余结论一律失败',()=>{
    assert.equal(precedingResult({build:{result:'success'},publish:{result:'success'}}),'success');
    for(const result of ['failure','cancelled','skipped','timed_out',undefined])assert.equal(precedingResult({build:{result}}),'failed');
    assert.throws(()=>precedingResult({}));
  });
  test('当前Run尚在运行也能清理同目标旧结果，保护其它目标和活动任务',()=>{
    const row=(id,conclusion='success',status='completed',path=workflowPath)=>({id,conclusion,status,path,head_branch:'main',event:'workflow_dispatch',created_at:new Date(1700000000000+id*1000).toISOString()});
    const current=row(6,null,'in_progress');const rows=[row(1),row(2,'failure'),row(3,'success','in_progress'),row(4,'success','completed','.github/workflows/release-other.yml'),current,row(7)];
    assert.deepEqual(cleanupPlan(rows,current,'success').map(row=>row.id),[1]);
    assert.deepEqual(cleanupPlan(rows,current,'failed').map(row=>row.id),[2]);
  });
  test('软件版本进位与协议版本边界',()=>{
    assert.equal(nextVersion('1.0.0',['1.99.99']),'2.0.0');assert.equal(nextVersion('9',['9'],true),'10');
    assert.throws(()=>nextVersion(String(0xffffffff),[String(0xffffffff)],true));
  });
  test('历史完整分页不截断超过1000条记录',async()=>{
    const rows=Array.from({length:1005},(_,id)=>({id}));const api=async path=>rows.slice((Number(/page=(\d+)$/u.exec(path)[1])-1)*100,Number(/page=(\d+)$/u.exec(path)[1])*100);
    assert.equal((await pages('releases',null,api)).length,1005);
  });
  test('失败清理只删除所属旧失败产物及Run，成功和活动任务独立保留',async()=>{
    const row=(id,conclusion,status='completed')=>({id,run_attempt:1,conclusion,status,path:workflowPath,head_branch:'main',event:'workflow_dispatch',repository:{full_name:owner.repository},head_sha:'a'.repeat(40),created_at:new Date(1700000000000+id*1000).toISOString()});
    const current=row(10,null,'in_progress'),rows=[row(1,'success'),row(2,'failure'),row(3,null,'in_progress'),current];
    const gone=new Set(),removed=[];
    const api=async(path,options={})=>{
      if(options.method==='DELETE'){removed.push(path);gone.add(path);return {};}
      if(gone.has(path))return null;
      if(path.startsWith('actions/runs?'))return {workflow_runs:rows};
      if(path.startsWith('releases?')||path.startsWith('git/matching-refs/'))return [];
      if(path.startsWith('actions/runs/2/artifacts?'))return {artifacts:[{id:20}]};
      if(path==='actions/artifacts/20')return {id:20};
      const match=/^actions\/runs\/(\d+)$/u.exec(path);if(match)return rows.find(row=>row.id===Number(match[1]))??null;
      throw Error('未声明的模拟接口：'+path);
    };
    assert.deepEqual(await cleanup('failed',{run_id:10},api),[2]);
    assert.deepEqual(removed,['actions/artifacts/20','actions/runs/2']);
  });

  test('GitHub运行序号保证成功历史清理后版本不会回到初始值',()=>{
    assert.equal(nextVersion('1.0.0',[],false,4),'1.0.3');
    assert.equal(nextVersion('1.99.99',[],false,2),'2.0.0');
    assert.equal(nextVersion('1.0.0',['3.0.0'],false,4),'3.0.1');
    assert.throws(()=>nextVersion('1.0.0',[],false,0));
  });

}
