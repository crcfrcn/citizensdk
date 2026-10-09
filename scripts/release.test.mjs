import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
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
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { gunzipSync, gzipSync } from 'node:zlib';
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  createNativeSourceView,
  createFlutterSourceView,
  assertFlutterSourceView,
  projectFlutterSourceEntry,
  CITIZENSDK_INTERNAL_SYMBOLS,
  citizenSdkInternalHeader,
  assertAndroidReleaseProjection,
  assertCitizenSdkNativeContract,
  assertCitizenSdkStaticArchive,
  assertCitizenSdkDependencyInputs,
  citizenSdkDependencyEnvironment,
  writeCitizenSdkDependencyEvidence,
  assertCitizenSdkDependencyEvidence,
  assertAppleReleaseProjection,
  assertChainAssets,
  assertCoreRustSource,
  assertDocumentationSource,
  assertFlutterBindingContract,
  assertHostedPackageSource,
  assertHostedRuntimeDartProjection,
  assertHostedRuntimeLinuxProjection,
  assertLicenseSources,
  assertLinuxBindingSource,
  assertWindowsBindingSource,
  assertWindowsNativeArtifact,
  assertWindowsReleaseProjection,
  assertWindowsFlutterBundle,
  assertHostedRuntimeWindowsProjection,
  copyWindowsNativeArtifact,
  assertLinuxReleaseProjection,
  assertMobileBindingSource,
  assertNativeArtifactSources,
  assertNoSecrets,
  assertProviderLockParity,
  assertPublicAbiHeaders,
  assertSdkRootLocks,
  assertSdkScriptSource,
  assertSdkTestContracts,
  assertSignerSource,
  assertSmoldotDartSource,
  assertSmoldotLocks,
  assertSmoldotRustSource,
  assertSourceFixtures,
  buildCitizenSdkRelease,
  buildCitizenSdkHosted,
  hostedPackageEntries,
  parseHostedArchive,
  verifyCitizenSdkHosted,
  verifyCitizenSdkRelease,
} from './release.mjs';

const workRoot = process.env.CITIZENSDK_RELEASE_TEST_WORK_DIR;
if (!workRoot) {
  throw new Error('CitizenSDK发布测试缺少CITIZENSDK_RELEASE_TEST_WORK_DIR');
}
mkdirSync(workRoot, { recursive: true });

const citizenSdkRoot = fileURLToPath(new URL('../', import.meta.url));

test('Android SDK 源码和测试源集没有单子目录包装层，包名与 JNI 身份保持', () => {
  // Kotlin/Java 的包身份由源码声明决定；目录只承载真实文件，不复制包名层级。
  for (const relativeRoot of ['android/native/src', 'android/src']) {
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
    ['android/native/src/main/kotlin/CitizenSdkHardwareVault.kt', 'org.citizen.sdk.internal'],
    ['android/native/src/main/kotlin/CitizenSdkNative.kt', 'org.citizen.sdk.internal'],
    ['android/native/src/androidTest/CitizenSdkHardwareVaultTest.kt', 'org.citizen.sdk'],
    ['android/src/main/kotlin/CitizenSdkPlugin.kt', 'org.citizen.sdk'],
  ]) {
    const contents = readFileSync(join(citizenSdkRoot, source), 'utf8');
    assert.ok(contents.split('\n').includes(`package ${declaredPackage}`), source);
  }
  for (const obsolete of [
    'android/native/src/main/kotlin/org',
    'android/native/src/test/kotlin/org',
    'android/native/src/test/java/org',
    'android/native/src/androidTest/kotlin',
    'android/src/main/kotlin/org',
    'android/src/test/kotlin',
  ]) assert.equal(existsSync(join(citizenSdkRoot, obsolete)), false, obsolete);
  const consumerRules = readFileSync(join(citizenSdkRoot, 'android/native/consumer-rules.pro'), 'utf8');
  assert.match(consumerRules, /org\.citizen\.sdk\.internal\.CitizenSdkNative/u);
});

test('各端启停直接调用原生且Android不再增加能力刷新前置屏障', () => {
  const android = readFileSync(join(citizenSdkRoot, 'android/native/src/main/kotlin/CitizenSdk.kt'), 'utf8');
  const apple = readFileSync(join(citizenSdkRoot, 'darwin/Sources/CitizenSDK/CitizenSDK.swift'), 'utf8');
  const sessions = readFileSync(join(citizenSdkRoot, 'android/src/main/kotlin/CitizenSdkFlutterSessions.kt'), 'utf8');
  const desktops = ['linux', 'windows'].map(platform => readFileSync(join(citizenSdkRoot, platform, 'src/citizen_sdk_flutter_sessions.cc'), 'utf8'));
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
  const core = read('native/ffi/src/runtime.rs');
  assert.match(core, /fn accept_request_sequence\(&self, sequence: u64\)/u);
  assert.match(core, /sequence != state\.next_request_sequence/u);
  assert.match(core, /state\.next_request_sequence \+= 1/u);
  assert.match(read('include/citizensdk.h'), /citizensdk_accept_request_sequence/u);
  for (const [plugin, envelope, accept, decode] of [
    ['android/src/main/kotlin/CitizenSdkPlugin.kt', 'CitizenSdkFlutterCodec.envelope(', 'envelope?.let(registry::acceptRequestSequence)', 'registry.dispatch(CitizenSdkFlutterCodec.decode('],
    ['darwin/Sources/CitizenSDKFlutter/CitizenSdkPlugin.swift', 'CitizenSdkFlutterCodec.envelope(', 'sessions.acceptRequestSequence(envelope)', 'sessions.dispatch(try CitizenSdkFlutterCodec.decode('],
    ['linux/src/citizen_sdk_plugin.cc', 'decode_request_envelope(', 'state->sessions->accept_request_sequence(*envelope)', 'const DecodedRequest request = decode_request('],
    ['windows/src/citizen_sdk_plugin.cc', 'decode_request_envelope(', 'sessions->accept_request_sequence(*envelope)', 'const auto request = decode_request('],
  ]) {
    const source = read(plugin);
    const positions = [envelope, accept, decode].map(value => source.indexOf(value));
    assert.ok(positions[0] >= 0 && positions[1] > positions[0] && positions[2] > positions[1], plugin);
  }
  for (const file of [
    'android/src/main/kotlin/CitizenSdkFlutterSessions.kt',
    'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterSessions.swift',
    'linux/src/citizen_sdk_flutter_sessions.cc', 'windows/src/citizen_sdk_flutter_sessions.cc',
  ]) {
    assert.doesNotMatch(read(file), /CitizenSdkFlutterSequenceGate|nextRequest|next_request\s*\{|request\.sequence != session->next_request/u, file);
  }
  const apple = read('darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterCodec.swift');
  assert.match(apple, /rawTuple\.map \{ \$0 is NSNull \? nil : \$0 \}/u);
  const android = read('android/src/main/kotlin/CitizenSdkFlutterSessions.kt');
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
  const source = readFileSync(join(citizenSdkRoot, 'scripts', 'build-native.sh'), 'utf8');
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
      reference = join(citizenSdkRoot, 'windows', relative.replace(/^include\//u, ''));
    } else if (relative.startsWith('include/')) {
      reference = relative === 'include/citizensdk_qr_image.h'
        ? join(citizenSdkRoot, 'native/qr-image/citizensdk_qr_image.h')
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
        ? 'windows/citizen_sdk/citizensdk_host.h' : 'include/citizensdk.h');
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
    join(citizenSdkRoot, 'linux/citizen_sdk/citizensdk_host.h'),
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
  const qrImageHeader = join(root, 'native/qr-image/citizensdk_qr_image.h');
  mkdirSync(dirname(qrImageHeader), { recursive: true });
  copyFileSync(
    join(citizenSdkRoot, 'native/qr-image/citizensdk_qr_image.h'),
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
      bytes = readFileSync(join(citizenSdkRoot, 'linux', relative.replace(/^include\//u, '')));
    } else if (relative.startsWith('include/')) {
      bytes = readFileSync(relative === 'include/citizensdk_qr_image.h'
        ? join(citizenSdkRoot, 'native/qr-image/citizensdk_qr_image.h')
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
  const qrImageHeader = join(root, 'native/qr-image/citizensdk_qr_image.h');
  mkdirSync(dirname(qrImageHeader), { recursive: true });
  copyFileSync(
    join(citizenSdkRoot, 'native/qr-image/citizensdk_qr_image.h'),
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
  const header = readFileSync(join(citizenSdkRoot, 'native/qr-image/citizensdk_qr_image.h'), 'utf8');
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
        ? join(citizenSdkRoot, 'native', 'qr-image', header)
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
      join(citizenSdkRoot, 'darwin', 'Sources', 'CitizenSDK', 'PrivacyInfo.xcprivacy'),
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
    'native/qr-image/citizensdk_qr_image.h',
    'chain/chainspec.json',
    'chain/light_sync_state.json',
    'chain/manifest.json',
    'darwin/Sources/CitizenSDK/PrivacyInfo.xcprivacy',
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
  const preparer = readFileSync(join(citizenSdkRoot, 'scripts/dependencies.mjs'), 'utf8');
  assert.match(preparer, /command === 'plan'/u);
  assert.match(preparer, /command === 'prepare-environment'/u);
  assert.match(preparer, /command === 'prepare-native'/u);
  assert.match(preparer, /attempt <= 3/u);
  assert.match(preparer, /CITIZENSDK_DEPENDENCY_CACHE_DIR/u);
  // 仅官方包装的两个准确相对目标有意包含父级段；其它源码外回指仍拒绝。
  assert.doesNotMatch(preparer.replace(/'\.\.\/\.\.\/core\/?'/gu, "''"), /\.\.\/\.\.\/|\/Users\//u);
});

test('ZXing准备只接受两条准确包内链接并在拒绝时清理本轮暂存', async () => {
  const root = mkdtempSync(join(workRoot, 'release-source-links-'));
  const source = readFileSync(join(citizenSdkRoot, 'scripts/dependencies.mjs'), 'utf8');
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
    const source = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
  const source = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
  for (const directory of ['contracts', 'engine', 'ffi', 'qr', 'qr-image']) {
    cpSync(
      join(citizenSdkRoot, 'native', directory),
      join(native, directory),
      { recursive: true },
    );
  }
  for (const directory of ['signer', 'smoldot']) {
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
  assert.match(appleTestPackage, /darwin\/Tests\/CitizenSDKTests/);
  assert.match(appleTestPackage, /darwin\/Tests\/CitizenSDKFlutterTests/);
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
    assert.match(native, /new File\(nativeSourceRoot, 'src\/main\/cpp\/CMakeLists\.txt'\)/u);
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
      join(root, 'darwin', 'Sources', 'CitizenSDK', 'CitizenSDK.swift'),
      'utf8',
    );
    assert.match(swiftFacade, /public final class CitizenSdk:/u);
    assert.doesNotMatch(swiftFacade, /public (?:final class|typealias) CitizenSDK\b/u);

    // 删除旧实现后不得靠过滤规则隐藏第二套源码，恢复任一旧文件均须拒绝。
    for (const relative of [
      'lib/src/node/light_client.dart',
      'lib/src/wallet/wallet_service.dart',
      'lib/src/transaction/chain_rpc.dart',
      'lib/src/crypto/native_sr25519.dart',
      'lib/src/platform/preferences_wallet_repository.dart',
    ]) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '// Forbidden duplicate implementation.\n');
      assert.throws(() => assertMobileBindingSource(root), /移动绑定文件闭集漂移/);
      rmSync(path);
    }

    const darwinSourceLink = join(
      root,
      'darwin',
      'Sources',
      'CitizenSDK',
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
      join(root, 'android', 'src', 'main', 'kotlin', 'Unexpected.kt'),
      'package org.citizen.sdk\n',
    );
    assert.throws(
      () => assertMobileBindingSource(root),
      /移动绑定文件闭集漂移.*Unexpected\.kt/,
    );

    rmSync(join(root, 'android', 'src', 'main', 'kotlin', 'Unexpected.kt'));
    writeFileSync(
      join(root, 'darwin', 'Sources', 'CitizenSDK', 'Unexpected.swift'),
      'enum Unexpected {}\n',
    );
    assert.throws(
      () => assertMobileBindingSource(root),
      /移动绑定文件闭集漂移.*Unexpected\.swift/,
    );
    rmSync(join(root, 'darwin', 'Sources', 'CitizenSDK', 'Unexpected.swift'));

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
    const source = join(root, 'windows/src/citizen_sdk_assets.cc');
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
    const linked = join(root, 'windows/src/linked.cc');
    symlinkSync('citizen_sdk_assets.cc', linked);
    assert.throws(() => assertWindowsBindingSource(root), /禁止未声明符号链接/u);
    rmSync(linked);
    const generated = join(root, 'windows/CMakeFiles');
    mkdirSync(generated);
    assert.throws(() => assertWindowsBindingSource(root), /Windows Host 目录闭集漂移/u);
    rmSync(generated, { recursive: true });
    const missing = join(root, 'windows/src/citizen_sdk_lifecycle.hpp');
    rmSync(missing);
    assert.throws(() => assertWindowsBindingSource(root), /Windows Host 文件闭集漂移/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows 薄 Host 与正式 Flutter 适配保持唯一 Core 和官方注册', () => {
  const header = readFileSync(join(citizenSdkRoot, 'windows/citizen_sdk/citizensdk_host.h'), 'utf8');
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
  const contractCmake = readFileSync(join(citizenSdkRoot, 'windows/test/CMakeLists.txt'), 'utf8');
  const adapterTests = contractCmake.match(/set\(CITIZENSDK_WINDOWS_FLUTTER_CONTRACT_TESTS([\s\S]*?)\)/u)?.[1].trim().split(/\s+/u);
  assert.deepEqual(adapterTests, [
    'citizen_sdk_flutter_codec_test', 'citizen_sdk_flutter_environment_test',
    'citizen_sdk_flutter_sessions_test', 'citizen_sdk_flutter_wallet_flow_test',
    'citizen_sdk_flutter_plugin_test', 'citizen_sdk_flutter_secret_boundary_test',
  ]);
  assert.match(contractCmake, /target_compile_options\(\$\{test_name\} PRIVATE \/UNDEBUG\)/u);
  assert.match(contractCmake, /target_link_libraries\(citizensdk_windows_flutter_test_support PUBLIC advapi32\)/u);
  assert.ok(contractCmake.indexOf('return()') < contractCmake.indexOf('set(_host_sources)'));
  const plugin = readFileSync(join(citizenSdkRoot, 'windows/src/citizen_sdk_plugin.cc'), 'utf8');
  assert.equal([...plugin.matchAll(/decode_method_call\(message, size\)/gu)].length, 2);
  assert.doesNotMatch(plugin, /DecodeMethodCall\(/u);
  const codec = readFileSync(join(citizenSdkRoot, 'windows/src/citizen_sdk_flutter_codec.cc'), 'utf8');
  assert.match(codec, /WirePreflight\(message, size\)\.check\(\);\s+auto result = ::flutter::StandardMethodCodec::GetInstance\(\)\.DecodeMethodCall\(message, size\)/u);
  const build = nativeShellFunctions(['build_windows', 'verify_windows_exports', 'windows_path_preflight']);
  assert.match(build, /x86_64-pc-windows-msvc/u);
  assert.match(build, /--release --locked --offline/u);
  assert.match(build, /ctest --test-dir/u);
  assert.match(build, /0x8664/u);
  assert.match(build, /Windows output is inside source/u);
  const script = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
      'qr_image_header="$sdk_dir/native/qr-image/citizensdk_qr_image.h"',
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
    symlinkSync(join(citizenSdkRoot, 'windows/citizen_sdk'), include, 'dir');
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
      '    -S) if [[ "$2" == "$windows_source_root/test" ]]; then',
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
    const cmake = source('windows/test/CitizenSDKConsumer.cmake');
    assert.match(cmake, /find_package\(CitizenSDK \$\{CITIZENSDK_CONSUMER_VERSION\} EXACT CONFIG REQUIRED/u);
    assert.match(cmake, /NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH/u);
    assert.match(cmake, /get_target_property\(_imported CitizenSDK::\$\{_kind\} IMPORTED\)/u);
    assert.match(cmake, /MAP_IMPORTED_CONFIG_\$\{_upper\}/u);
    assert.equal([...cmake.matchAll(/-E compare_files/gu)].length, 2);
    assert.match(cmake, /\/UNDEBUG \/W4 \/WX/u);
    assert.doesNotMatch(cmake, /add_subdirectory\(|FetchContent|ExternalProject/u);
    assert.doesNotMatch(cmake, /PROPERTIES[^\n]*(?:PASS_REGULAR_EXPRESSION|SKIP_RETURN_CODE|WILL_FAIL)/u);
    for (const file of ['windows/test/citizen_sdk_c_consumer.c', 'windows/test/citizen_sdk_cpp_consumer.cc']) {
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
    assert.match(source('windows/test/citizen_sdk_c_consumer.c'), /citizensdk_result_release\(result\) == CITIZENSDK_OK/u);
    assert.doesNotMatch(source('windows/test/citizen_sdk_cpp_consumer.cc'), /citizensdk_result_release\s*\(/u);
    assert.match(source('windows/test/citizen_sdk_cpp_consumer.cc'), /host\.set_event_observer\(\{\}\)/u);
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
      ...[...readFileSync(join(citizenSdkRoot, 'windows/citizen_sdk/citizensdk_host.h'), 'utf8')
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
      '/windows/lib/Windows/citizensdk_host.lib', '/windows/src/citizen_sdk_flutter_codec.cc',
      '!/windows/src/citizen_sdk_secret_vault.cc', '!/windows/test/citizen_sdk_c_consumer.c']) {
      writeFileSync(ignore, `${original}\n${rule}\n`);
      assert.throws(() => assertHostedRuntimeWindowsProjection(projected, { allowInjectedWindowsArtifacts: true }), /Hosted Windows/u);
    }
    writeFileSync(ignore, original);
    const rejected = join(root, 'rejected');
    cpSync(join(citizenSdkRoot, 'windows'), join(rejected, 'windows'), { recursive: true });
    const header = join(rejected, 'windows/citizen_sdk/citizen_sdk.hpp');
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
    const source = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
    const consumer = readFileSync(join(citizenSdkRoot, 'windows/test/citizen_sdk_flutter_consumer.dart'), 'utf8');
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

    const source = join(root, 'linux', 'src', 'citizen_sdk_assets.cc');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`);
    assert.throws(
      () => assertLinuxBindingSource(root),
      /Linux Host 来源文件哈希漂移：linux\/src\/citizen_sdk_assets\.cc/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'linux', 'src', 'citizen_sdk_assets.cc'),
      source,
    );

    const unexpected = join(root, 'linux', 'src', 'unexpected_host.cc');
    writeFileSync(unexpected, 'int unexpected_host = 0;\n');
    assert.throws(
      () => assertLinuxBindingSource(root),
      /Linux Host 文件闭集漂移.*unexpected_host\.cc/,
    );
    rmSync(unexpected);

    const sourceLink = join(root, 'linux', 'src', 'citizen_sdk_source_link.cc');
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
      '/linux/src/citizen_sdk_plugin.cc',
      '/linux/citizen_sdk/citizen_sdk_plugin.h',
      '/linux/include/citizensdk.h',
      '/linux/citizen_sdk/citizensdk_host.h',
      '/linux/lib/LinuxARM/libcitizensdk.so',
      '/linux/lib/LinuxAMD/libcitizensdk_host.so',
      '/linux/share/citizensdk/chain/manifest.json',
      '!/linux/src/citizen_sdk_host_api.cc',
      '!/linux/cmake/CitizenSDKConfig.cmake.in',
      '!/linux/test/citizen_sdk_c_consumer.c',
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
  const api = source('lib/src/api/citizen_sdk.dart');
  assert.match(api, /open\(\{\s*int modules = CitizenSdkModules\.full,\s*Future<Uint8List\?> Function\(CitizenCredentialChallenge challenge\)\?\s+credentialProvider,/u);
  assert.match(api, /final CitizenSigning signing;/u);
  assert.match(api, /static Future<bool> verify\(/u);
  assert.doesNotMatch(api.split('final class _CitizenSigning')[1].split('final class _CitizenTransactions')[0], /Future<bool> verify/u);
  const codec = source('lib/src/platform/citizen_sdk_flutter_codec.dart');
  assert.match(codec, /method == 'verifySignature' \|\|/u);
  assert.match(codec, /return <Object\?>\[protocolVersion, \.\.\.fields\];/u);
  assert.match(codec, /_tuple\(raw, 2, '验签响应'\)/u);
  assert.match(api, /final CitizenHistory history;/u);
  assert.doesNotMatch(source('lib/src/api/citizen_sdk_wallet.dart'), /Future<CitizenWalletSignature> sign/u);
  const transactions = source('lib/src/api/citizen_transactions.dart');
  assert.doesNotMatch(transactions.split('abstract interface class CitizenHistory')[0], /initializeFinalizedHistory|syncFinalizedHistory/u);
  assert.match(source('lib/src/platform/citizen_sdk_flutter_codec.dart'), /return <Object\?>\[protocolVersion, modules, hasCredentialProvider\];/u);
  const header = source('include/citizensdk.h');
  for (const symbol of ['citizensdk_validate_modules', 'citizensdk_create_with_modules', 'citizensdk_verify_signature']) {
    assert.equal([...header.matchAll(new RegExp('\\b' + symbol + '\\s*\\(', 'gu'))].length, 1);
  }
  for (const platform of ['linux', 'windows']) {
    const host = source(`${platform}/src/citizen_sdk_host_api.cc`);
    assert.match(host, /citizensdk_validate_modules\(modules\)/u);
    assert.match(source(`${platform}/src/citizen_sdk_flutter_sessions.cc`), /citizensdk_verify_signature\(/u);
    assert.match(source(`${platform}/citizen_sdk/citizensdk_host.h`), /citizensdk_host_create_with_modules\(/u);
  }
});

test('QR_V1固定五类码型并由Core唯一给出扫码用途', () => {
  const productionRoots = [
    'native/qr/src', 'native/engine/src', 'native/ffi/src', 'include', 'lib',
    'android/native/src/main', 'android/src/main', 'darwin/Sources',
    'linux/src', 'linux/citizen_sdk', 'windows/src', 'windows/citizen_sdk',
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
  const dart = readFileSync(join(citizenSdkRoot, 'lib/src/api/citizen_qr.dart'), 'utf8');
  const kind = dart.match(/enum CitizenQrKind \{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(kind);
  assert.deepEqual([...kind.matchAll(/\b([a-zA-Z]+)\(([1-5])\)/gu)].map(match => [match[1], Number(match[2])]), [
    ['signRequest', 1], ['signResponse', 2], ['userContact', 3],
    ['userTransfer', 4], ['accountId', 5],
  ]);
  const core = readFileSync(join(citizenSdkRoot, 'native/qr/src/codec.rs'), 'utf8');
  assert.match(core, /pub const fn scan_purpose_mask\(&self\)/u);
  assert.match(core, /self\.scan_purpose_mask\(\) & purpose\.bit\(\) != 0/u);
  assert.match(core, /Self::AccountId\(_\) => \{\s*ColdAccountImport\.bit\(\)\s*\| TransferRecipient\.bit\(\)\s*\| GeneralScan\.bit\(\)\s*\| AccountTarget\.bit\(\)\s*\}/u);
  assert.match(readFileSync(join(citizenSdkRoot, 'native/qr/src/codec.rs'), 'utf8'),
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
    'lib/src/platform/citizen_sdk_flutter_codec.dart',
    'lib/src/platform/flutter_citizen_sdk_platform.dart',
    'android/src/main/kotlin/CitizenSdkFlutterCodec.kt',
    'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterCodec.swift',
    'linux/src/citizen_sdk_flutter_codec.cc',
    'linux/src/citizen_sdk_flutter_codec.hpp',
    'windows/src/citizen_sdk_flutter_codec.cc',
    'windows/src/citizen_sdk_flutter_codec.hpp',
  ];
  try {
    for (const relativePath of sources) {
      const destination = join(root, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(citizenSdkRoot, ...relativePath.split('/')), destination);
    }
    assert.doesNotThrow(() => assertFlutterBindingContract(root));

    const linuxMethods = join(root, 'linux', 'src', 'citizen_sdk_flutter_codec.cc');
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

    const linuxChannels = join(root, 'linux', 'src', 'citizen_sdk_flutter_codec.hpp');
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
    const windowsMethods = join(root, 'windows/src/citizen_sdk_flutter_codec.cc');
    const windowsMethodSource = readFileSync(windowsMethods, 'utf8');
    for (const replacement of ['"syncTransactionHistorY",', '']) {
      writeFileSync(windowsMethods, windowsMethodSource.replace('"syncTransactionHistory",', replacement));
      assert.throws(() => assertFlutterBindingContract(root), /Windows Flutter 方法合同漂移/u);
    }
    writeFileSync(windowsMethods, windowsMethodSource);
    const windowsChannels = join(root, 'windows/src/citizen_sdk_flutter_codec.hpp');
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
    join(citizenSdkRoot, 'lib/src/platform/citizen_sdk_flutter_codec.dart'),
    'utf8',
  );
  assert.match(dart, /_tuple\(error\.details, 7, '错误 details'\)/u);
  assert.match(dart, /expectedMethod != null && method != expectedMethod/u);

  const android = readFileSync(
    join(citizenSdkRoot, 'android/src/main/kotlin/CitizenSdkFlutterCodec.kt'),
    'utf8',
  );
  assert.match(android, /code\.value,\s*stage\.value,\s*method,\s*message,/u);

  const swift = readFileSync(
    join(citizenSdkRoot, 'darwin/Sources/CitizenSDKFlutter/CitizenSdkFlutterCodec.swift'),
    'utf8',
  );
  assert.match(swift, /\[version, session, sequence, Int64\(code\.rawValue\),\s*Int64\(failureStage\.rawValue\), method, message\]/u);

  for (const platform of ['linux', 'windows']) {
    const codec = readFileSync(
      join(citizenSdkRoot, platform, 'src/citizen_sdk_flutter_codec.cc'),
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
    const powDirectory = join(root, 'native', 'smoldot', 'pow');
    mkdirSync(powDirectory, { recursive: true });
    copyFileSync(
      join(citizenSdkRoot, 'native', 'smoldot', 'pow', 'Cargo.lock'),
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

test('根 include 固定三文件闭集并只开放安全 citizensdk_* ABI', () => {
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
    copyFileSync(join(citizenSdkRoot, 'scripts/test.sh'), join(source, 'scripts/test.sh'));
    copyFileSync(join(citizenSdkRoot, 'scripts/release.mjs'), join(source, 'scripts/release.mjs'));
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
      const output = join(root, 'output-' + (failure || 'success'));
      writeFileSync(trace, '');
      const result = spawnSync('bash', [join(source, 'scripts/test.sh'), 'flutter', '--timeout=2m'], {
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
    const invoke = output => spawnSync('bash', [join(source, 'scripts/test.sh'), 'flutter'], {
      encoding: 'utf8', env: { ...process.env, NODE: process.execPath,
        FLUTTER: join(tools, 'bin/flutter'), CITIZENSDK_TEST_WORK_DIR: output,
        CITIZENSDK_TEST_SMOLDOT_LIBRARY: '', CITIZENSDK_OFFLINE: 'true', SYNTHETIC_TRACE: trace },
    });
    // 必须把原始相对片段交给生产入口；path.join会先消掉该反例。
    for (const output of [join(source, 'forbidden'), root, root + '/absent/../escape']) {
      const result = invoke(output);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /源码或其祖先|无相对片段/u);
    }
    assert.equal(existsSync(join(source, 'forbidden')), false);
    assert.equal(existsSync(join(root, 'absent')), false);
    const linked = join(root, 'linked-output');
    mkdirSync(linked); symlinkSync(source, join(linked, 'cargo'), 'dir');
    assert.match(invoke(linked).stderr, /独立普通目录/u);
    assert.deepEqual(readdirSync(linked), ['cargo']);
    mkdirSync(join(source, '.dart_tool')); writeFileSync(join(source, '.dart_tool/sentinel'), 'keep');
    assert.match(invoke(join(root, 'blocked-output')).stderr, /禁止的生成条目/u);
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
    const testEntry = join(scripts, 'test.sh');
    const testEntrySource = readFileSync(testEntry, 'utf8');
    assert.match(testEntrySource, /script_path="\$\{BASH_SOURCE\[0\]\}"/u);
    assert.match(testEntrySource, /CARGO_TARGET_DIR="\$test_root\/cargo"/u);
    assert.match(testEntrySource, /--build-dir=build/u);
    assert.match(testEntrySource, /--no-enable-native-assets/u);
    assert.match(testEntrySource, /--no-enable-dart-data-assets/u);
    assert.match(testEntrySource, /pub_get_args=\(--enforce-lockfile\)/u);
    assert.match(testEntrySource, /CITIZENSDK_OFFLINE:-false/u);
    assert.match(testEntrySource, /true\) pub_get_args\+=\(--offline\)/u);
    assert.match(testEntrySource, /FLUTTER_ROOT="\$flutter_sdk_root"/u);
    assert.match(testEntrySource, /mktemp -d "\$test_root\/flutter-project\.XXXXXX"/u);
    assert.match(testEntrySource, /--flutter-source-view "\$sdk_dir" --output "\$project_root"/u);
    assert.match(testEntrySource, /refresh_flutter_packages "\$project_root"/u);
    assert.match(testEntrySource, /cd "\$project_root" && FLUTTER_ROOT=/u);
    assert.match(readFileSync(join(scripts, 'release.mjs'), 'utf8'), /COPYFILE_EXCL/u);
    assert.doesNotMatch(testEntrySource, /\$sdk_dir\/\.dart_tool/u);
    assert.match(testEntrySource, /flutter_bin" test --no-pub --no-test-assets/u);
    assert.match(testEntrySource, /--packages="\$project_root\/\.dart_tool\/package_config\.json"/u);
    assert.match(testEntrySource, /源码树已存在禁止的生成条目/u);
    writeFileSync(testEntry, `${testEntrySource}\n`);
    assert.throws(
      () => assertSdkScriptSource(root),
      /固定脚本文件哈希漂移：scripts\/test\.sh/,
    );

    copyFileSync(join(citizenSdkRoot, 'scripts', 'test.sh'), testEntry);
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

    const source = join(root, 'native', 'engine', 'src', 'lib.rs');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 来源文件哈希漂移：native\/engine\/src\/lib\.rs/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'native', 'engine', 'src', 'lib.rs'),
      source,
    );
    const ffiSource = join(root, 'native', 'ffi', 'src', 'lib.rs');
    writeFileSync(ffiSource, `${readFileSync(ffiSource, 'utf8')}\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 来源文件哈希漂移：native\/ffi\/src\/lib\.rs/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'native', 'ffi', 'src', 'lib.rs'),
      ffiSource,
    );
    const walletAbi = join(root, 'native', 'ffi', 'src', 'wallet_abi.rs');
    writeFileSync(walletAbi, `${readFileSync(walletAbi, 'utf8')}\n`);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 来源文件哈希漂移：native\/ffi\/src\/wallet_abi\.rs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('监控实现及回归测试全部进入正式 Core 来源闭集', () => {
  const root = mkdtempSync(join(workRoot, 'release-chain-monitor-source-test-'));
  try {
    writeCoreRustFixture(root);
    for (const file of ['native/engine/src/chain_monitor.rs',
      'native/ffi/src/chain_monitor.rs', 'native/ffi/src/chain_monitor_tests.rs']) {
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
    const hostProviders = join(root, 'native', 'ffi', 'src', 'host_providers.rs');
    rmSync(hostProviders);
    assert.throws(
      () => assertCoreRustSource(root),
      /Core Rust 文件闭集漂移：native\/ffi.*缺失=native\/ffi\/src\/host_providers\.rs/,
    );
    copyFileSync(
      join(citizenSdkRoot, 'native', 'ffi', 'src', 'host_providers.rs'),
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
      'native/contracts/src/store/transaction_history.rs',
      'native/engine/src/transaction_execution.rs',
      'native/engine/src/transaction_history.rs',
      'native/ffi/src/events.rs',
      'native/ffi/src/host_codec.rs',
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
    const ffiCargo = join(root, 'native', 'smoldot', 'ffi', 'Cargo.toml');
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
      'native',
      'smoldot',
      'provider',
      'src',
      'verified_chain_client.rs',
    );
    writeFileSync(providerSource, `${readFileSync(providerSource, 'utf8')}\n`);
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot Rust 文件哈希漂移：provider\/src\/verified_chain_client\.rs/,
    );
    copyFileSync(
      join(
        citizenSdkRoot,
        'native',
        'smoldot',
        'provider',
        'src',
        'verified_chain_client.rs',
      ),
      providerSource,
    );
    const exactSource = join(
      root,
      'native',
      'smoldot',
      'pow',
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

    const upstreamHeader = join(copy, 'smoldot.h');
    writeFileSync(upstreamHeader, `${readFileSync(upstreamHeader, 'utf8')}\n`);
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot 支持文件哈希漂移：native\/smoldot\/smoldot\.h/,
    );

    copyFileSync(join(source, 'smoldot.h'), upstreamHeader);
    writeFileSync(join(copy, 'citizensdk.h'), '/* duplicate product ABI */\n');
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot 文件闭集漂移.*额外=native\/smoldot\/citizensdk\.h/,
    );
    rmSync(join(copy, 'citizensdk.h'));
    writeFileSync(join(copy, 'unexpected-release-input.txt'), 'extra\n');
    assert.throws(
      () => assertSmoldotRustSource(root),
      /smoldot 文件闭集漂移.*额外=native\/smoldot\/unexpected-release-input\.txt/,
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
    for (const relativeRoot of ['android', 'darwin', 'lib/src', 'linux', 'windows']) {
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
  const chain = readFileSync(join(citizenSdkRoot, 'native/contracts/src/chain.rs'), 'utf8');
  assert.match(chain, /MAX_RUNTIME_METADATA_BYTES: usize = 64 \* 1024 \* 1024/u);

  const runtimeContract = readFileSync(
    join(citizenSdkRoot, 'native/contracts/src/store/runtime_cache.rs'),
    'utf8',
  );
  assert.match(runtimeContract, /MAX_PERSISTED_RUNTIME_CONTEXTS: usize = 64/u);
  assert.match(runtimeContract, /MAX_PERSISTED_RUNTIME_METADATA_BYTES: usize = \(8 \* 1024 \* 1024\) - 56 - 55/u);

  const engine = readFileSync(join(citizenSdkRoot, 'native/engine/src/engine.rs'), 'utf8');
  assert.match(engine, /contexts\.get\(block\)\.cloned\(\)/u);
  assert.match(engine, /context\.metadata\(\)\.len\(\) <= MAX_PERSISTED_RUNTIME_METADATA_BYTES/u);
  assert.match(engine, /preflight_execution_before_signing/u);

  const history = readFileSync(
    join(citizenSdkRoot, 'native/contracts/src/store/transaction_history.rs'),
    'utf8',
  );
  assert.match(history, /MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES: usize = 31 \* 1024 \* 1024/u);
  assert.match(history, /durable_weight_bytes > MAX_TRANSACTION_HISTORY_DURABLE_WEIGHT_BYTES/u);
  const historyEngine = readFileSync(
    join(citizenSdkRoot, 'native/engine/src/transaction_history.rs'),
    'utf8',
  );
  assert.match(historyEngine, /preflight_execution_before_signing/u);
  assert.match(historyEngine, /TransactionHistoryQueryKind::OldestRetentionTerminal/u);
  assert.doesNotMatch(historyEngine, /TransactionHistoryState/u);

  for (const relativePath of [
    'android/native/src/main/kotlin/CitizenSdkPublicStore.kt',
    'darwin/Sources/CitizenSDK/CitizenSDKPublicStore.swift',
    'linux/src/citizen_sdk_public_store.cc',
    'windows/src/citizen_sdk_public_store.cc',
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
    join(citizenSdkRoot, 'native/contracts/src/store/transaction_history.rs'), 'utf8');
  for (const marker of [
    'TransactionHistoryIndex', 'TransactionHistoryCursor', 'TransactionHistoryMutation',
    'load_record', 'load_page', 'compare_and_swap',
  ]) assert.match(contract, new RegExp(marker, 'u'));
  assert.doesNotMatch(contract, /TransactionHistoryState/u);

  const codec = readFileSync(join(citizenSdkRoot, 'native/ffi/src/host_codec.rs'), 'utf8');
  for (const marker of ['THQ1', 'THB1', 'THM1', 'TXR1']) assert.match(codec, new RegExp(marker, 'u'));
  const header = readFileSync(join(citizenSdkRoot, 'include/citizensdk_types.h'), 'utf8');
  assert.match(header, /transaction_history_query/u);
  assert.match(header, /transaction_history_mutate/u);
  assert.doesNotMatch(header, /transaction_history_load|transaction_history_compare_and_swap/u);

  for (const relativePath of [
    'android/native/src/main/kotlin/CitizenSdkPublicStore.kt',
    'darwin/Sources/CitizenSDK/CitizenSDKPublicStore.swift',
    'linux/src/citizen_sdk_public_store.cc',
    'windows/src/citizen_sdk_public_store.cc',
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
  const monitor = readFileSync(join(citizenSdkRoot, 'native/ffi/src/chain_monitor.rs'), 'utf8');
  assert.match(monitor, /Duration::from_secs\(30\)/u);
  assert.match(monitor, /Some\(Some\(Err\(_\)\)\) \| Some\(None\)/u);

  // Apple C ABI 边界必须先安全转换可空字节视图，再校验固定查询长度；
  // citizenSDKData 是抛错边界，遗漏 try 会让正式 Apple 源码无法编译。
  const appleHostBridge = readFileSync(
    join(citizenSdkRoot, 'darwin/Sources/CitizenSDK/CitizenSDKHostBridge.swift'), 'utf8');
  assert.match(appleHostBridge, /let bytes = try citizenSDKData\(query\)/u);
  assert.match(appleHostBridge, /guard bytes\.count == 58/u);
  const androidNative = readFileSync(join(citizenSdkRoot,
    'android/native/src/main/kotlin/CitizenSdkNative.kt'), 'utf8');
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

    const facadePath = join(root, 'lib', 'src', 'api', 'citizen_sdk.dart');
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

    const requiredRuntime = join(root, 'lib', 'src', 'api', 'citizen_chain.dart');
    rmSync(requiredRuntime);
    assert.throws(
      () => assertHostedRuntimeDartProjection(root),
      /Hosted Dart 运行闭集漂移.*缺失=lib\/src\/api\/citizen_chain\.dart/,
    );
    copyFileSync(join(citizenSdkRoot, 'lib', 'src', 'api', 'citizen_chain.dart'), requiredRuntime);

    const unexpectedRuntime = join(root, 'lib', 'src', 'hosted_private_key_probe.dart');
    writeFileSync(unexpectedRuntime, 'const probe = true;\n');
    assert.throws(
      () => assertHostedRuntimeDartProjection(root),
      /Hosted Dart 运行闭集漂移.*额外=lib\/src\/hosted_private_key_probe\.dart/,
    );
    rmSync(unexpectedRuntime);

    const pubignorePath = join(root, '.pubignore');
    const pubignore = readFileSync(pubignorePath, 'utf8');
    for (const forbiddenRule of [
      '/lib/src/smoldot/',
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
      'native/smoldot/provider/tests',
      'android/native/src/test',
      'android/native/src/androidTest',
      'android/src/test',
      'darwin/Tests',
      'linux/test',
      'windows/test',
    ]) {
      const destination = join(root, ...relativeRoot.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(citizenSdkRoot, ...relativeRoot.split('/')), destination, {
        recursive: true,
      });
    }
    for (const relativePath of [
      'native/engine/src/qr_review_tests.rs',
      'native/ffi/src/chain_monitor_tests.rs',
      'native/engine/src/wallet_derivation_tests.rs',
      'native/engine/src/wallet_input_tests.rs',
      'native/engine/src/wallet_service_tests.rs',
      'native/ffi/src/composition_tests.rs',
      'native/ffi/src/host_codec_tests.rs',
      'native/ffi/src/wallet_abi_tests.rs',
      'native/smoldot/provider/src/bootstrap_tests.rs',
    ]) {
      const destination = join(root, ...relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(citizenSdkRoot, ...relativePath.split('/')), destination);
    }
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const name of ['release.test.mjs', 'build.test.mjs']) {
      copyFileSync(join(citizenSdkRoot, 'scripts', name), join(root, 'scripts', name));
    }
    assert.doesNotThrow(() => assertSdkTestContracts(root));

    const golden = join(root, 'native', 'engine', 'src', 'wallet_derivation_tests.rs');
    writeFileSync(golden, `${readFileSync(golden, 'utf8')}\n`);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试合同文件哈希漂移：native\/engine\/src\/wallet_derivation_tests\.rs/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'native', 'engine', 'src', 'wallet_derivation_tests.rs'),
      golden,
    );
    const bootstrap = join(root, 'native/smoldot/provider/src/bootstrap_tests.rs');
    rmSync(bootstrap);
    assert.throws(() => assertSdkTestContracts(root), /内嵌测试文件闭集漂移.*bootstrap_tests\.rs/);
    copyFileSync(join(citizenSdkRoot, 'native/smoldot/provider/src/bootstrap_tests.rs'), bootstrap);
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
      'native',
      'smoldot',
      'provider',
      'tests',
      'verified_chain_client_contract.rs',
    );
    writeFileSync(providerTest, `${readFileSync(providerTest, 'utf8')}\n`);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试合同文件哈希漂移：native\/smoldot\/provider\/tests\/verified_chain_client_contract\.rs/,
    );
    copyFileSync(
      join(
        citizenSdkRoot,
        'native',
        'smoldot',
        'provider',
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
      'src',
      'test',
      'CitizenSdkFlutterCodecTest.kt',
    );
    const oldAndroidTest = join(
      root,
      'android',
      'src',
      'test',
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
      /测试文件闭集漂移：android\/src\/test.*缺失=android\/src\/test\/CitizenSdkFlutterCodecTest\.kt.*额外=android\/src\/test\/kotlin\/org\/citizen\/sdk\/CitizenSdkFlutterCodecTest\.kt/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'android', 'src', 'test', 'CitizenSdkFlutterCodecTest.kt'),
      officialAndroidTest,
    );
    rmSync(oldAndroidTest);
    const nativeAndroidTest = join(
      root,
      'android',
      'native',
      'src',
      'test',
      'kotlin',
      'CitizenSdkApiContractTest.kt',
    );
    rmSync(nativeAndroidTest);
    assert.throws(
      () => assertSdkTestContracts(root),
      /测试文件闭集漂移：android\/native\/src\/test.*缺失=android\/native\/src\/test\/kotlin\/CitizenSdkApiContractTest\.kt/,
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
    writeFileSync(join(signer, 'src', 'lib.rs'), 'drift\n');
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
    for (const area of ['ffi', 'pow']) {
      const directory = join(root, 'native', 'smoldot', area);
      mkdirSync(directory, { recursive: true });
      copyFileSync(
        join(citizenSdkRoot, 'native', 'smoldot', area, 'Cargo.lock'),
        join(directory, 'Cargo.lock'),
      );
    }
    assert.doesNotThrow(() => assertSmoldotLocks(root));
    const ffiLock = join(root, 'native', 'smoldot', 'ffi', 'Cargo.lock');
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
      'lib/src/smoldot',
      'test/smoldot',
    ]) {
      const source = join(citizenSdkRoot, ...relativeRoot.split('/'));
      const copy = join(root, ...relativeRoot.split('/'));
      mkdirSync(dirname(copy), { recursive: true });
      cpSync(source, copy, { recursive: true });
    }
    const bindings = join(root, 'lib', 'src', 'smoldot', 'bindings.dart');
    writeFileSync(bindings, 'drift\n');
    assert.throws(
      () => assertSmoldotDartSource(root),
      /smoldot Dart 文件哈希漂移：lib\/src\/smoldot\/bindings\.dart/,
    );

    copyFileSync(
      join(citizenSdkRoot, 'lib', 'src', 'smoldot', 'bindings.dart'),
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
  const release = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const native = readFileSync(new URL('./build-native.sh', import.meta.url), 'utf8');
  assert.match(release, /function assertLocalTarget\(path, label\)[\s\S]*?return target;/u);
  assert.doesNotMatch(release, /固定本机目录|\/Users\/|外部控制程序/u);
  assert.match(native, /local_build_path_is_allowed\(\) \{[\s\S]*?"\$sdk_dir\/"\*\) return 1/u);
  assert.match(native, /工作目录或产物目录位于 CitizenSDK 源码树/u);
  for (const relative of ['android/build.gradle', 'android/native/build.gradle']) {
    const gradle = readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
    assert.doesNotMatch(gradle, /\/Users\/|共享工作根|中央工作目录/u);
    assert.match(gradle, /outside the source tree/u);
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
    const nativeBuildScript = readFileSync(
      join(citizenSdkRoot, 'scripts', 'build-native.sh'),
      'utf8',
    );
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
      assert.match(gradle, /outside the source tree/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Android Core 在 AAR 与独立双库投影前只执行一次固定 NDK strip', () => {
  const nativeBuildScript = readFileSync(
    join(citizenSdkRoot, 'scripts', 'build-native.sh'),
    'utf8',
  );
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
      if (relative.startsWith('include/citizen_sdk/')) source = join(citizenSdkRoot, 'linux', relative.replace(/^include\//u, ''));
      else if (relative === 'include/citizensdk_qr_image.h') {
        source = join(citizenSdkRoot, 'native/qr-image/citizensdk_qr_image.h');
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
      ['host', join(citizenSdkRoot, 'linux', 'citizen_sdk', 'citizensdk_host.h')],
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
      'qr_image_header="$sdk_dir/native/qr-image/citizensdk_qr_image.h"',
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
  const cmake = source('linux/test/CitizenSDKConsumer.cmake');
  assert.match(cmake, /find_package\(CitizenSDK \$\{CITIZENSDK_CONSUMER_VERSION\} EXACT CONFIG REQUIRED/u);
  assert.match(cmake, /NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH/u);
  assert.match(cmake, /get_target_property\(_imported CitizenSDK::\$\{_kind\} IMPORTED\)/u);
  assert.match(cmake, /-UNDEBUG/u);
  assert.doesNotMatch(cmake, /add_subdirectory\(|FetchContent|ExternalProject/u);
  for (const path of ['linux/test/citizen_sdk_c_consumer.c', 'linux/test/citizen_sdk_cpp_consumer.cc']) {
    const consumer = source(path);
    assert.doesNotMatch(consumer, /^#include\s*[<"][^>"\n]*(?:src\/|test_support|_bridge|_secret_vault)/mu);
    assert.match(consumer, /#ifdef NDEBUG/u);
    assert.match(consumer, /CITIZENSDK_ERROR_BUSY/u);
    assert.match(consumer, /CITIZENSDK_ERROR_INVALID_HANDLE/u);
  }
  const flutter = source('linux/test/citizen_sdk_flutter_consumer.dart');
  assert.match(flutter, /CitizenSdk\.open\(\)/u);
  assert.doesNotMatch(flutter, /package:citizen_sdk\/src\/|FlutterCitizenSdkPlatform|MethodChannelCitizenSdkPlatform/u);
  assert.doesNotMatch(flutter, /\bassert\s*\(|setMockMethodCallHandler|MockClient/u);
  assert.match(flutter, /await subscription\.cancel\(\);[\s\S]*?_require\(!eventFailed\)/u);
  assert.match(flutter, /await stdout\.flush\(\);[\s\S]*?exit\(0\)/u);
  assert.match(flutter, /CitizenSDK Flutter consumer passed/u);
  assert.match(flutter, /CitizenSDK Flutter consumer failed/u);
  const build = source('scripts/build-native.sh');
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
  const build = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
  assert.match(build, /\[\[ "\$expected_count" == 148 \]\]/u);
  assert.match(build, /grep -c '\^_citizensdk_' "\$destination" \|\| true\)" == 148/u);
  assert.match(build, /未过滤链接不等于产品头与既定内部符号闭集/u);
  assert.doesNotMatch(build, /117公开|expected_count" == 120|destination" \|\| true\)" == 120/u);
});

test('Android原生构建只在调用方显式选择时使用Gradle离线模式', () => {
  const build = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
  assert.equal(readme.test('lib/src/api/README.md'), true);
  assert.equal(readme.test('lib/src/api/citizen_sdk.dart'), false);
  const cmake = compile('/linux/cmake/*').pattern;
  assert.equal(cmake.test('linux/cmake/'), false);
  assert.equal(cmake.test('linux/cmake'), false);
  assert.equal(cmake.test('linux/cmake/CitizenSDKFlutter.cmake'), true);
});

test('最终 Hosted 六平台消费统一验真且不重编 Core、不把测试注入包', () => {
  const source = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
  assert.match(consume, /-S "\$sdk_dir\/linux\/test"/u);
  assert.match(consume, /\$sdk_dir\/windows\/test/u);
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
    const source = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
  const source = readFileSync(join(citizenSdkRoot, 'darwin/Tests/citizen_sdk_flutter_consumer.dart'), 'utf8');
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
  const source = readFileSync(join(citizenSdkRoot, 'scripts/build-native.sh'), 'utf8');
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
  assert.match(build, /fs\.copyFileSync\(path\.join\(candidate, 'darwin\/Tests\/citizen_sdk_flutter_consumer\.dart'\)/u);
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
      'linux/cmake/CitizenSDKFlutter.cmake', 'linux/src/citizen_sdk_plugin.cc',
      'windows/bin/Windows/citizensdk.dll', 'windows/cmake/CitizenSDKFlutter.cmake',
      'windows/src/citizen_sdk_plugin.cc',
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
  const input = 'android/src/main/kotlin/CitizenSdkPlugin.kt';
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
};
  try {
    assert.equal(createNativeSourceView(source, output), output);
    for (const [stored, compiled] of Object.entries(paths)) {
      assert.deepEqual(readFileSync(join(output, compiled)), readFileSync(join(source, stored)));
      assert.equal(lstatSync(join(output, compiled)).isSymbolicLink(), false);
      assert.equal(existsSync(join(output, stored)), false);
      assert.equal(existsSync(join(source, compiled)), false);
    }
    for (const path of ['Cargo.toml', 'Cargo.lock', 'native/smoldot/pow/Cargo.toml',
      'native/smoldot/pow/Cargo.lock', 'chain/chainspec.json',
      'test/transaction/citizenchain-runtime-v14-metadata.hex', 'include/citizensdk.h']) {
      assert.deepEqual(readFileSync(join(output, path)), readFileSync(join(source, path)));
      assert.equal(lstatSync(join(output, path)).isSymbolicLink(), false);
    }
    assert.equal(createNativeSourceView(source, output), output);
    const header = 'native/smoldot/include/smoldot.h';
    const original = readFileSync(join(source, 'native/smoldot/smoldot.h'));
    writeFileSync(join(output, header), 'simulated build.rs write');
    assert.deepEqual(readFileSync(join(source, 'native/smoldot/smoldot.h')), original);
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
 const source=readFileSync(join(citizenSdkRoot,'scripts/test.sh'),'utf8');
 const guard=source.match(/<<'CHECK_SMOLDOT_INPUT' \|\| return 1\n([\s\S]*?)\nCHECK_SMOLDOT_INPUT/u)?.[1];assert.ok(guard);
 const root=mkdtempSync(join(workRoot,'smoldot-boundary-'));const work=join(root,'current');mkdirSync(work);
 try{
  const library=join(work,'library.dylib');writeFileSync(library,'resource protocol fixture');
  const check=file=>runInNewContext(guard,{require:specifier=>{if(specifier==='node:fs')return {realpathSync,lstatSync};if(specifier==='node:path')return {isAbsolute,resolve,sep};throw Error('未知依赖');},process:{argv:['node','-',work,file]},Error});
  check(library);
  for(const file of [join(citizenSdkRoot,'scripts/test.sh'),join(root,'other.dylib'),join(work,'..','current','library.dylib')])assert.throws(()=>check(file));
  const alias=join(work,'alias');symlinkSync(library,alias);assert.throws(()=>check(alias));
  writeFileSync(library,'');assert.throws(()=>check(library));
 }finally{rmSync(root,{recursive:true,force:true});}
});
