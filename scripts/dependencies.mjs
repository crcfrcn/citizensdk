#!/usr/bin/env node

// CitizenSDK原生依赖准备入口。依赖坐标只来自同目录锁文件；普通开发、CI和
// 任意可选调用程序都只能选择工作目录，不能改写版本、来源、摘要或构建选项。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
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
} from 'node:fs';
import { homedir, platform as hostPlatform } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sdkDirectory = resolve(scriptDirectory, '..');
const lockPath = join(scriptDirectory, 'dependencies.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
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

function developerCache() {
  if (process.env.CITIZENSDK_DEPENDENCY_CACHE_DIR) {
    return resolve(process.env.CITIZENSDK_DEPENDENCY_CACHE_DIR);
  }
  if (hostPlatform() === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return resolve(local, 'CitizenSDK', 'dependencies');
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return resolve(xdg || join(homedir(), '.cache'), 'citizensdk', 'dependencies');
}

function safeExternalDirectory(path, label, source = sdkDirectory) {
  const pathRoot = parse(path).root;
  if (!isAbsolute(path) || resolve(path) !== path || path === pathRoot) fail(`${label}必须是规范绝对路径`);
  const normalizedSource = resolve(source);
  if (path === normalizedSource || path.startsWith(`${normalizedSource}${sep}`)) {
    fail(`${label}禁止位于CitizenSDK源码树`);
  }
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
  const api = await import(new URL('./release.mjs', import.meta.url));
  api.assertCitizenSdkDependencyInputs(receiptPath, args.platform);
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, prefix, receipt: receiptPath })}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArguments(rest);
try {
  if (command === 'plan') dependencyPlan(args);
  else if (command === 'prepare-environment') await prepareEnvironment(args);
  else if (command === 'prepare-native') await prepareNative(args);
  else fail('用法：dependencies.mjs <plan|prepare-environment|prepare-native> [--name value ...]');
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}
