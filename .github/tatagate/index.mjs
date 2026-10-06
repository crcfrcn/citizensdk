import { toolEnvironment, validateToolSources } from './tools.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';

const emptyTreeSHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const commitPattern = /^[0-9a-f]{40}$/u;
const implementationExtensions = new Set([
  '.c', '.cc', '.cpp', '.dart', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.kt',
  '.kts', '.mjs', '.pbxproj', '.proto', '.py', '.rs', '.sh', '.sql', '.swift', '.toml',
  '.ts', '.tsx', '.yaml', '.yml',
]);
const commentExtensions = new Set([
  '.c', '.cc', '.cpp', '.dart', '.go', '.h', '.hpp', '.java', '.js', '.jsx', '.kt',
  '.kts', '.mjs', '.py', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx',
]);

function fail(message) { throw new Error(message); }

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    fail(label + '字段闭集无效');
  }
}

function git(root, arguments_) {
  try {
    const env = toolEnvironment();
    return execFileSync(env.PRODUCT_GIT_BIN, ['-C', root, ...arguments_], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env,
    });
  } catch {
    fail('产品门禁读取Git提交失败');
  }
}

export function validateRange({ root, baseSHA, headSHA }) {
  if (!isAbsolute(root) || realpathSync(root) !== root) fail('产品门禁仓库根无效');
  if (!commitPattern.test(baseSHA) || !commitPattern.test(headSHA) || baseSHA === headSHA) {
    fail('产品门禁提交范围无效');
  }
  if (git(root, ['rev-parse', 'HEAD']).trim() !== headSHA) fail('产品门禁目标与当前检出不一致');
  if (baseSHA !== emptyTreeSHA) git(root, ['merge-base', '--is-ancestor', baseSHA, headSHA]);
  const range = baseSHA === emptyTreeSHA ? headSHA : `${baseSHA}..${headSHA}`;
  const commits = git(root, ['rev-list', '--reverse', '--topo-order', range]).trim().split(/\r?\n/u).filter(Boolean);
  if (commits.length === 0 || commits.some((commit) => !commitPattern.test(commit))) {
    fail('产品待推送提交范围无效');
  }
  return Object.freeze(commits);
}

// 历史清理只接受一个无父新根；带父提交的强制覆盖仍拒绝，并从空树执行完整门禁。
export function pushBaseSHA({ forced, before, headSHA, parents, commitCount }) {
  if (typeof forced !== 'boolean' || !commitPattern.test(before) || !commitPattern.test(headSHA)
    || /^0{40}$/u.test(headSHA)) fail('远端push提交坐标无效');
  if (!forced) return /^0{40}$/u.test(before) ? emptyTreeSHA : before;
  if (/^0{40}$/u.test(before) || parents !== headSHA || commitCount !== '1') {
    fail('历史清理必须是唯一无父提交，禁止强制覆盖普通历史');
  }
  return emptyTreeSHA;
}

function trackedFiles(root) {
  return git(root, ['ls-files', '-z', '--', '.']).split('\0').filter(Boolean).sort();
}

function isTestPath(path) {
  const segments = path.split('/').map((segment) => segment.toLowerCase());
  const name = basename(path).toLowerCase();
  return segments.some((segment) => ['test', 'tests', 'integration_test'].includes(segment))
    || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/u.test(name);
}

function isImplementationPath(path) {
  return implementationExtensions.has(extname(path).toLowerCase())
    || ['Dockerfile', 'Makefile'].includes(basename(path));
}

function commentText(path, source) {
  const extension = extname(path).toLowerCase();
  if (['.sh', '.py'].includes(extension)) return source.split(/\r?\n/u).filter((line) => /^(?!#!)\s*#/u.test(line)).join('\n');
  if (extension === '.sql') return source.split(/\r?\n/u).filter((line) => /^\s*--/u.test(line)).join('\n');
  return [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu)].map((match) => match[0]).join('\n');
}

function temporaryComments(path, source) {
  return commentText(path, source).split('\n').filter((line) => /(?:TODO|FIXME|HACK|XXX)\b/u.test(line));
}

// 上游说明只能逐字、按原有数量保留；复制同一句到新位置不能增加允许数量。

export function hasFirstPartyTemporaryComments(path, source, upstream = '') {
  const retained = new Map();
  for (const comment of temporaryComments(path, upstream)) retained.set(comment, (retained.get(comment) ?? 0) + 1);
  return temporaryComments(path, source).some((comment) => {
    const count = retained.get(comment) ?? 0;
    if (count === 0) return true;
    retained.set(comment, count - 1);
    return false;
  });
}

// 只消费产品来源清单的准确归属；provider、sdk_only和未登记文件仍按第一方检查。

export function smoldotUpstreamURL(path, manifest, record, resolveNativePath = value => value) {
  const prefix = 'native/smoldot/pow/';
  if (!path.startsWith(prefix)) return null;
  const owners = Object.values(manifest.units ?? {}).flatMap((unit) =>
    ['byte_identical', 'adapted', 'sdk_only'].flatMap((category) => (unit[category] ?? [])
      .filter((entry) => `${unit.root}/${entry.path}` === path)
      .map(() => category)));
  if (owners.length !== 1) fail('产品上游文件缺少唯一来源归属：' + path);
  if (owners[0] === 'sdk_only') return null;
  const commits = [...record.matchAll(/^- 收编基线提交：`([0-9a-f]{40})`$/gmu)];
  const upstreamRepositories = [...record.matchAll(/^- 上游仓库：`([^`]+)`$/gmu)];
  const relative = resolveNativePath(path).slice(prefix.length);
  if (commits.length !== 1 || upstreamRepositories.length !== 1 || upstreamRepositories[0][1] !== 'https://github.com/smol-dot/smoldot'
    || !/^(?:lib|light-base)\/[A-Za-z0-9_./-]+$/u.test(relative)
    || relative.split('/').some((part) => ['', '.', '..'].includes(part))) fail('产品上游基线或文件路径无效');
  return `https://raw.githubusercontent.com/smol-dot/smoldot/${commits[0][1]}/${relative}`;
}

// 公开固定基线只在内存读取，不携带GitHub App凭据，不落盘、不跟随重定向。

export async function readUpstreamSource(url, request = fetch) {
  const limit = 2 * 1024 * 1024;
  try {
    if (!/^https:\/\/raw\.githubusercontent\.com\/smol-dot\/smoldot\/[0-9a-f]{40}\/(?:lib|light-base)\/[A-Za-z0-9_./-]+$/u.test(url)
      || new URL(url).href !== url) throw new Error();
    const response = await request(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error();
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error();
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch { fail('产品上游固定基线读取失败，拒绝放行保留注释'); }
}

export function validateDependencyPlans(lock, plans, platforms) {
  if (lock?.schema !== 1 || !lock.environment || !lock.native?.sources) fail('产品依赖锁结构无效');
  const entries = [...Object.entries(lock.environment), ...Object.entries(lock.native.sources)];
  const sources = new Map(entries);
  if (!entries.length || sources.size !== entries.length) fail('产品依赖锁名称为空或重复');
  const keys = ['name', 'version', 'url', 'size', 'sha256', 'archive_root'];
  const coordinates = keys.slice(1);
  for (const [name, value] of sources) {
    if (!/^[A-Za-z0-9_.+-]+$/u.test(name) || !value || typeof value.version !== 'string'
      || !value.version.trim() || !Number.isSafeInteger(value.size) || value.size <= 0
      || !/^[0-9a-f]{64}$/u.test(value.sha256)
      || typeof value.archive_root !== 'string' || !/^[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/u.test(value.archive_root)) {
      fail('产品依赖锁归档坐标无效');
    }
    let url;
    try { url = new URL(value.url); } catch { fail('产品依赖锁来源无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('产品依赖锁来源无效');
  }
  if (!Array.isArray(plans) || !Array.isArray(platforms) || !platforms.length
    || new Set(platforms).size !== platforms.length || plans.length !== platforms.length) fail('产品依赖计划平台不完整');
  const covered = new Set();
  for (const [index, plan] of plans.entries()) {
    exactKeys(plan, ['schema', 'platform', 'archives'], '产品依赖计划');
    if (plan.schema !== 1 || plan.platform !== platforms[index]
      || !Array.isArray(plan.archives) || !plan.archives.length) fail('产品依赖计划身份或归档无效');
    const names = new Set();
    for (const archive of plan.archives) {
      exactKeys(archive, keys, '产品依赖计划归档');
      const expected = sources.get(archive.name);
      if (!expected || names.has(archive.name)
        || coordinates.some((key) => archive[key] !== expected[key])) fail('产品依赖计划与锁不一致');
      names.add(archive.name);
      covered.add(archive.name);
    }
  }
  if (covered.size !== sources.size) fail('产品依赖计划未覆盖全部锁定归档');
  return true;
}

// 准确中文注释属于开发逐项复核；仓库门禁不把保留源码逐文件出现汉字当作开发凭证。
export async function validateQuality(root, baseSHA, headSHA, repository) {
  const changed = git(root, ['diff', '--name-only', '-z', baseSHA, headSHA]).split('\0').filter(Boolean);
  const temporary = [];
  let smoldot;
  for (const path of changed.filter((item) => isImplementationPath(item) && !isTestPath(item) && !ignoredPrefixesFor(repository).some(prefix => item.startsWith(prefix)))) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !commentExtensions.has(extname(path).toLowerCase())) continue;
    const comments = commentText(path, readFileSync(absolute, 'utf8'));
    if (!/(?:TODO|FIXME|HACK|XXX)\b/u.test(comments)) continue;
    let upstream = '';
    if (repository === 'citizensdk' && path.startsWith('native/smoldot/pow/')) {
      if (!smoldot) {
        const sdk = root;
        const product = await import(pathToFileURL(resolve(sdk, 'scripts/release.mjs')).href);
        product.assertSmoldotRustSource(sdk);
        smoldot = {
          resolveNativePath: product.nativeCompilePath,
          manifest: JSON.parse(readFileSync(resolve(sdk, 'native/smoldot/SOURCE_SHA256.json'), 'utf8')),
          record: readFileSync(resolve(sdk, 'native/smoldot/UPSTREAM.md'), 'utf8'),
        };
      }
      const url = smoldotUpstreamURL(path, smoldot.manifest, smoldot.record, smoldot.resolveNativePath);
      if (url) upstream = await readUpstreamSource(url);
    }
    if (hasFirstPartyTemporaryComments(path, readFileSync(absolute, 'utf8'), upstream)) temporary.push(path);
  }
  if (temporary.length > 0) fail('产品实现代码保留临时注释：' + temporary.join('、'));
  const tests = git(root, ['ls-files', '-z']).split('\0').filter((path) => path && isTestPath(path)
    && !ignoredPrefixesFor(repository).some((prefix) => path.startsWith(prefix)));
  if (tests.length === 0) fail('产品没有受控测试代码');
  for (const path of tests) {
    const info = lstatSync(resolve(root, path), { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size === 0)) fail('产品测试代码无效：' + path);
  }
}

function validateSyntax(root, execute, environment, repository) {
  for (const path of trackedFiles(root)) {
    if (ignoredPrefixesFor(repository).some((prefix) => path.startsWith(prefix))) continue;
    const absolute = resolve(root, path);
    let result = null;
    if (path.endsWith('.mjs')) result = execute(process.execPath, ['--check', absolute], { cwd: root, env: environment, stdio: 'inherit' });
    else if (path.endsWith('.sh')) result = execute(environment.PRODUCT_BASH_BIN, ['-n', absolute], { cwd: root, env: environment, stdio: 'inherit' });
    else if (path.endsWith('.json')) {
      try { JSON.parse(readFileSync(absolute, 'utf8')); } catch { fail('JSON语法无效：' + path); }
    }
    if (result && (result.error || result.signal || result.status !== 0)) fail('源码语法无效：' + path);
  }
}

export default async function* reporter(events) {
  async function* checked() {
    for await (const event of events) {
      if (event.type === 'test:summary' && (!event.data.success || event.data.counts.skipped > 0
        || event.data.counts.todo > 0 || event.data.counts.cancelled > 0)) {
        process.exitCode = 1;
        yield { type: 'test:diagnostic', data: { nesting: 0, message: '产品门禁测试没有完整执行成功。' } };
      }
      yield event;
    }
  }
  yield* Readable.from(checked()).pipe(spec());
}



function ignoredPrefixesFor(repository) {
  if (repository === 'citizensdk') return ['docs/smoldot-dart/', 'lib/src/smoldot/', 'test/smoldot/'];
  if (repository === 'tuyubooking') return ['upstream/'];
  if (repository === 'tuyufactory') return ['imported/'];
  return [];
}
export function assertNoProductOutputDirectories(root, repository) {
  const ignored = new Set(['.git', 'node_modules', 'vendor', 'Pods', '.pub-cache', '.gradle']);
  const forbidden = new Set(['build', 'target', '.dart_tool', '.kotlin']);
  const violations = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name), relative = path.slice(root.length + 1);
      if (ignoredPrefixesFor(repository).some(prefix => (relative + '/').startsWith(prefix))) continue;
      if (forbidden.has(entry.name)) violations.push(relative);
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(path);
    }
  };
  visit(root);
  if (violations.length) fail('产品源码存在生成状态目录：' + violations.sort().join('、'));
}
export async function checkDependencies(root, { execute = spawnSync, report = console.log, env = {} } = {}) {
  const directory = resolve(root, 'scripts');
  const lock = JSON.parse(readFileSync(resolve(directory, 'dependencies.lock.json'), 'utf8'));
  const { assertCitizenSdkNativeContract } = await import(pathToFileURL(resolve(directory, 'release.mjs')).href);
  assertCitizenSdkNativeContract(lock.native);
  const platforms = ['Android', 'macOS', ...Object.keys(lock.native.platforms)];
  const plans = platforms.map(platform => {
    const result = execute(process.execPath, [resolve(directory, 'dependencies.mjs'), 'plan', '--platform', platform],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.signal || result.status !== 0) fail('产品依赖计划执行失败');
    try { return JSON.parse(result.stdout); } catch { fail('产品依赖计划回执无效'); }
  });
  validateDependencyPlans(lock, plans, platforms);
  report('产品依赖合同与全部锁定归档一致');
}


// 强特征扫描只返回路径；不将机密值带入回执或日志。
export function validateSecrets(root) {
  const pattern = 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}';
  const env = toolEnvironment();
  const result = spawnSync(env.PRODUCT_GIT_BIN, ['-C', root, 'grep','-l','-I','-E',pattern,'--','.',
    ':!test/release_manifest.test.ts', ':!test/release_manifest.test.mjs', ':!scripts/release/check/release_manifest.test.mjs'],
    { env, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  if (result.error || ![0,1].includes(result.status)) fail('门禁机密扫描执行失败');
  if (result.status === 0) fail('产品机密扫描未通过，仅报告路径：' + result.stdout.trim().split('\n').join('、'));
}

// 比较语义键及密码学值；描述和数组排列不构成协议差异。
export function validateVectorGroup(canonical, mirror, { keys, values, top, complete = false }) {
  const normalize = value => typeof value === 'string' ? value.toLowerCase() : value;
  function index(document) {
    if (!document || !Array.isArray(document.vectors) || document.vectors.length === 0) fail('金标缺少非空向量');
    const map = new Map();
    for (const vector of document.vectors) {
      if (!vector || keys.some(key => vector[key] === undefined) || values.some(key => vector[key] === undefined)) fail('金标向量字段缺失');
      const key = JSON.stringify(keys.map(field => normalize(vector[field])));
      if (map.has(key)) fail('金标存在重复语义键');
      map.set(key, vector);
    }
    return map;
  }
  const expected = index(canonical), actual = index(mirror);
  if (top.some(field => canonical[field] === undefined || normalize(canonical[field]) !== normalize(mirror[field]))) fail('金标顶层参数漂移');
  for (const [key, vector] of actual) {
    const source = expected.get(key);
    if (!source || values.some(field => normalize(source[field]) !== normalize(vector[field]))) fail('金标密码学值漂移');
  }
  if (complete && expected.size !== actual.size) fail('金标签名域必须完整覆盖');
  return actual.size;
}

// 上游链索引与本端Dart注册表必须具有真实内容，重复索引不能静默覆盖。
export function validatePalletRegistry(chain, dart = null) {
  const indices = new Map(), names = new Set();
  for (const match of chain.matchAll(/#\[runtime::pallet_index\((\d+)\)\]\s*\n\s*pub type (\w+)\s*=/gu)) {
    const index = Number(match[1]), name = match[2];
    if (indices.has(index) || names.has(name)) fail('金标链Pallet索引或名称重复');
    indices.set(index, name); names.add(name);
  }
  if (!indices.size) fail('金标链Pallet真源为空');
  if (dart === null) return indices.size;
  const constants = new Set();
  for (const match of dart.matchAll(/static const (?:int\s+)?(\w+Pallet)\s*=\s*(\d+);/gu)) {
    if (constants.has(match[1])) fail('金标DartPallet常量重复');
    constants.add(match[1]);
    const base = match[1].replace(/Pallet$/u, '');
    if (indices.get(Number(match[2])) !== base[0].toUpperCase() + base.slice(1)) fail('金标DartPallet索引漂移');
  }
  if (!constants.size) fail('金标DartPallet注册表为空');
  return constants.size;
}

// 公开消费者在一次门禁中先锁定链main的准确SHA，再只读该SHA的固定真源文件。
// 不访问控制台、私仓或本机其它产品，网络失败不得回退到缓存或猜测真源。
export async function readPublicChain(path, sha, request = fetch) {
  const allowed = new Set(['runtime/src/lib.rs', ...['signing_domain_vectors','binary_prefix_domain_vectors','account_derive_vectors']
    .map(name => 'runtime/primitives/tests/fixtures/' + name + '.json')]);
  const url = path === null ? 'https://api.github.com/repos/crcfrcn/citizenchain/git/ref/heads/main'
    : 'https://raw.githubusercontent.com/crcfrcn/citizenchain/' + sha + '/' + path;
  if (path !== null && (!allowed.has(path) || !commitPattern.test(sha))) fail('公开链真源坐标无效');
  try {
    const response = await request(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { Accept: path === null ? 'application/vnd.github+json' : 'text/plain' } });
    if (!response.ok || !response.body) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (path !== null) return text;
    const reference = JSON.parse(text);
    if (reference.ref !== 'refs/heads/main' || reference.object?.type !== 'commit'
      || !commitPattern.test(reference.object.sha)
      || reference.object.url !== 'https://api.github.com/repos/crcfrcn/citizenchain/git/commits/' + reference.object.sha) throw new Error();
    return reference.object.sha;
  } catch { fail('公开链准确提交真源读取失败'); }
}

export async function checkCrossPlatform(root, { request = fetch, report = console.log } = {}) {
  const own = contract.repository === 'citizenchain';
  if (!own && !['citizenapp','citizenwallet'].includes(contract.repository)) fail('金标检查没有本仓归属');
  const sha = own ? git(root, ['rev-parse','HEAD']).trim() : await readPublicChain(null, null, request);
  const read = async path => own ? readFileSync(resolve(root, path), 'utf8') : readPublicChain(path, sha, request);
  const groups = [
    { file: 'signing_domain_vectors.json', keys: ['op_tag','scale_payload_hex'], values: ['message_hex'], top: ['domain'], complete: true },
    { file: 'binary_prefix_domain_vectors.json', keys: ['name'], values: ['op_tag','prefix_hex','payload_hex','total_len'], top: ['domain'] },
    { file: 'account_derive_vectors.json', keys: ['cid_number','kind'], values: ['account_id'], top: ['domain','ss58_format'] },
  ];
  for (const group of groups) {
    const canonical = JSON.parse(await read('runtime/primitives/tests/fixtures/' + group.file));
    if (own) validateVectorGroup(canonical, canonical, group);
    else if (!(contract.repository === 'citizenwallet' && group.file === 'account_derive_vectors.json')) {
      const relative = group.file === 'account_derive_vectors.json' ? 'test/governance/shared/' : 'test/signer/fixtures/';
      const mirror = JSON.parse(readFileSync(resolve(root, relative, group.file), 'utf8'));
      validateVectorGroup(canonical, mirror, group);
    }
  }
  const chain = await read('runtime/src/lib.rs');
  const registry = contract.repository === 'citizenapp' ? 'lib/citizen/shared/pallet_registry.dart' : 'lib/signer/pallet_registry.dart';
  validatePalletRegistry(chain, own ? null : readFileSync(resolve(root, registry), 'utf8'));
  report('密码学金标与Pallet注册表完成真源校验：citizenchain@' + sha);
}



// 只识别本仓实际执行测试中的拒绝断言；字符串、模板及注释中的同文不构成豁免。
export function protocolAssertionLines(path, source) {
  if (!contract.node_tests.includes(path) || !isTestPath(path) || !path.endsWith('.mjs')) return [];
  const literal = String.raw`assert.doesNotMatch(source, /\/v1(?:\/|\b)/);`;
  const opaque = [...source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^\/\\\r\n])+\/[dgimsuvy]*/gu)]
    .map(match => [match.index, match.index + match[0].length]);
  const occurrences = new Map();
  let offset = 0;
  for (const line of source.split('\n')) {
    if (line.trim() === literal) {
      const position = offset + line.indexOf('assert');
      const executable = !opaque.some(([start, end]) => position >= start && position < end);
      occurrences.set(line, (occurrences.get(line) ?? true) && executable);
    }
    offset += line.length + 1;
  }
  return [...occurrences].filter(([, valid]) => valid).map(([line]) => line);
}

// 公民产品原有增量防护完整保留在自身门禁，字典私有资料不进入公开仓。
export function insecureTransportLines(path, source) {
  const allowed = [];
  if (/(?:_tests\.rs|\/tests\/[^/]+\.rs)$/u.test(path)) {
    const tokens = [];
    const scanner = /\/\/[^\n]*|\/\*|r(#+)?"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\.|[^'\\])'|[A-Za-z_][A-Za-z0-9_]*|\S/gu;
    let match, valid = true;
    while ((match = scanner.exec(source))) {
      const value = match[0];
      if (value.startsWith('//')) continue;
      if (value === '/*') {
        let depth = 1, end = scanner.lastIndex;
        while (depth && end < source.length) {
          if (source.startsWith('/*', end)) { depth++; end += 2; }
          else if (source.startsWith('*/', end)) { depth--; end += 2; }
          else end++;
        }
        if (depth) { valid = false; break; }
        scanner.lastIndex = end; continue;
      }
      if (/^r#*"$/u.test(value)) {
        const end = source.indexOf('"' + (match[1] || ''), scanner.lastIndex);
        if (end < 0) { valid = false; break; }
        scanner.lastIndex = end + 1 + (match[1] || '').length;
        tokens.push({ value: '<raw>', start: match.index, end: scanner.lastIndex }); continue;
      }
      tokens.push({ value, start: match.index, end: scanner.lastIndex });
    }
    const text = (start, end) => tokens.slice(start, end).map(token => token.value).join(' ');
    if (valid) for (let index = 0; index < tokens.length; index++) {
      if (text(index, index + 5) !== '# [ test ] fn') continue;
      if (!/^[A-Za-z_]\w*$/u.test(tokens[index + 5]?.value || '')
        || text(index + 6, index + 9) !== '( ) {') continue;
      const begin = index + 9;
      let end = begin, depth = 1;
      for (; end < tokens.length && depth; end++) {
        if (tokens[end].value === '{') depth++;
        if (tokens[end].value === '}') depth--;
      }
      if (depth) continue;
      for (let at = begin; at < end; at++) {
        if (tokens[at].value !== 'for') continue;
        const variable = tokens[at + 1]?.value;
        if (!/^[A-Za-z_]\w*$/u.test(variable || '') || text(at + 2, at + 4) !== 'in [') continue;
        let cursor = at + 4;
        const inputs = [];
        while (/^"(?:\\.|[^"\\])*"$/u.test(tokens[cursor]?.value || '')) {
          inputs.push(tokens[cursor++]);
          if (tokens[cursor]?.value !== ',') break;
          cursor++;
        }
        if (!inputs.length || text(cursor, cursor + 2) !== '] {') continue;
        cursor += 2;
        // 循环体必须仅执行一次拒绝断言；多余调用、成功断言或被替换的参数均不豁免。
        const assertion = `assert ! ( endpoint ( ${variable} ) . is_err ( )`;
        if (text(cursor, cursor + 11) !== assertion) continue;
        cursor += 11;
        if (tokens[cursor]?.value === ',') {
          if (tokens[cursor + 1]?.value !== `"{${variable}}"`) continue;
          cursor += 2;
        }
        if (text(cursor, cursor + 3) !== ') ; }' || cursor + 3 > end) continue;
        for (const input of inputs) {
          if (/^"(?:http|ws):\/\/[A-Za-z0-9.-]+\.invalid(?:[/?#][^"\\]*)?"$/u.test(input.value)) allowed.push(input);
        }
      }
    }
  }
  const unsafe = new Set();
  for (const match of source.matchAll(/(?:http|ws):\/\//gu)) {
    if (!allowed.some(({ start, end }) => match.index >= start && match.index < end)) {
      unsafe.add(source.slice(0, match.index).split('\n').length);
    }
  }
  return [...unsafe];
}
const guardrailsSource = "#!/usr/bin/env bash\nset -euo pipefail\n\nbase_ref=\"${BASE_REF:-origin/main}\"\n\n# 中文说明：产品门禁只读取自身提交；私有规则与全产品字典在控制台独立检查。\nflow_root=\"${TATAGATE_DIRECTORY:?缺少本仓门禁根}\"\nif [[ -e memory || -e TataConsole || -e AGENTS.md || -e CODEX.md || -e CLAUDE.md ]]; then\n  echo \"公民产品根目录检测到私人 AI 或 TataConsole 残留。\" >&2\n  exit 1\nfi\n\n# 中文注释：全仓禁止中国国旗字符；用 UTF-8 八进制构造，避免规则本身成为命中项。\nforbidden_cn_flag=\"$(printf '\\360\\237\\207\\250\\360\\237\\207\\263')\"\nflag_files=\"$(git grep --untracked -l -I -F \"$forbidden_cn_flag\" -- . || true)\"\nif [[ -n \"$flag_files\" ]]; then\n  echo \"检测到禁止使用的中国国旗字符（仅报告文件）：\" >&2\n  printf '  - %s\\n' \"$flag_files\" >&2\n  exit 1\nfi\n\n# 首次推送以空树比较全部已保存内容；已有main必须提供可验证祖先，不主动抓取或猜测分支。\ngit rev-parse --verify \"$base_ref\" >/dev/null 2>&1 || { echo '门禁基线不存在' >&2; exit 1; }\nif [[ \"$base_ref\" == '4b825dc642cb6eb9a060e54bf8d69288fbee4904' ]]; then\n  merge_base=\"$base_ref\"\nelse\n  merge_base=\"$(git merge-base HEAD \"$base_ref\")\"\nfi\n\ndeclare -a changed_files=()\nwhile IFS= read -r file; do\n  [[ -n \"$file\" ]] && changed_files+=(\"$file\")\ndone < <(git diff --name-only \"$merge_base\")\nwhile IFS= read -r file; do\n  [[ -n \"$file\" ]] && changed_files+=(\"$file\")\ndone < <(git ls-files --others --exclude-standard)\n\nif [[ \"${#changed_files[@]}\" -eq 0 ]]; then\n  echo \"未检测到变更文件，跳过公开仓库增量门禁。\"\n  exit 0\nfi\n\n# 中文注释：强特征机密扫描只报告路径，禁止把命中值写入 Actions 日志。\nsecret_files=\"$(git grep --untracked -l -I -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk_live_[A-Za-z0-9]{16,}' -- . ':!test/release_manifest.test.ts' ':!test/release_manifest.test.mjs' ':!scripts/release/check/release_manifest.test.mjs' || true)\"\nif [[ -n \"$secret_files\" ]]; then\n  echo \"公开仓库检测到疑似真实机密（仅报告文件）：\" >&2\n  printf '  - %s\\n' \"$secret_files\" >&2\n  exit 1\nfi\n\ntodo_word=\"TO\"\"DO\"\nfixme_word=\"FIX\"\"ME\"\nresidual_regex=\"(console\\\\.log\\\\(|debugger;|dbg!\\\\(|todo!\\\\(|unimplemented!\\\\(|\\\\b${todo_word}\\\\b|\\\\b${fixme_word}\\\\b)\"\nversion_regex='([A-Za-z0-9][._:-]v[0-9]+|/(api/)?v[0-9]+|[A-Za-z0-9]_V[0-9]+|schema_version|cache_version|protocol_version|tag[[:space:]]*=[[:space:]]*[\\\"]v[0-9]+)'\ndeclare -a residual_hits=()\ndeclare -a version_hits=()\ndeclare -a lint_hits=()\ndeclare -a insecure_transport_hits=()\n\nis_code_file() {\n  case \"$1\" in\n    *.rs|*.dart|*.ts|*.tsx|*.js|*.jsx|*.mjs|*.sh|*.py|*.sql|*.swift|*.kt|*.kts) return 0 ;;\n    *) return 1 ;;\n  esac\n}\n\nskip_generated_or_vendor() {\n  case \"$1\" in\n    native/smoldot/pow/*|docs/smoldot-dart/*|lib/src/smoldot/*|test/smoldot/*|assets/topup/walletconnect.bundle.js|scripts/worker-configuration.d.ts|*/dist/*|*/build/*|*/target/*|*/node_modules/*|*/GeneratedPluginRegistrant.*|*.g.dart|*.pb.dart|*.pbjson.dart|*.pbenum.dart|.github/scripts/repository/ci-repository.mjs) return 0 ;;\n    *) return 1 ;;\n  esac\n}\n\nhas_chinese_comment() {\n  # 中文注释：Unicode Script=Han 不依赖 runner 的本地排序规则，避免 grep 把汉字端点判为非法范围。\n  node -e 'const fs = require(\"node:fs\"); process.exit(/(?:\\/\\/|\\/\\*|\\*|#).*\\p{Script=Han}/u.test(fs.readFileSync(0, \"utf8\")) ? 0 : 1)'\n}\n\nsanitize_version_line() {\n  local line=\"$1\"\n  # 中文注释：Apple 官方 API/audience 与四条产品正式 Release Tag 是外部接口或软件版本身份，\n  # 不属于一方自定义协议标识；只精确移除这些已登记形态，继续阻断其它版本化协议。\n  # 中文注释：同一组准确字面量由 Node 一次批量处理，避免 Bash 长字符串的重复复制。\n  line=\"$(printf '%s\\n' \"$line\" | node --input-type=module -e 'import { readFileSync } from \"node:fs\"; let source=readFileSync(0,\"utf8\"); for(const token of [\"QR_V1\", \"QrProtocol.qrV1\", \"QrProtocols.qrV1\", \"citizen_sdk.smoldot.database.v1\", \"citizensdk.smoldot.database.v1\", \"citizensdk.wallet.state.v1\", \"APK v2/v3\", \"APK Signature Scheme v2/v3\"]) source=source.split(token).join(\"\"); process.stdout.write(source);')\"\n  # 中文注释：以下名称是已冻结的数据库文件、上游RPC/库API、ABI类型、测试描述或\n  # QR_V1负向断言，不是一方另建协议；只移除准确形态，未知版本化标识仍继续阻断。\n  line=\"$(printf '%s\\n' \"$line\" | sed -E \\\n    -e 's/(^|[^A-Za-z0-9_])(citizensdk_host_bool_completion_v1_t|citizensdk_host_bool_result_v1_t|citizensdk_host_bytes_completion_v1_t|citizensdk_host_bytes_result_v1_t|citizensdk_host_public_store_v1_t|citizensdk_host_record_completion_v1_t|citizensdk_host_record_result_v1_t|citizensdk_host_secret_presence_v1_t|citizensdk_host_secret_ref_v1_t|citizensdk_host_secret_vault_v1_t|citizensdk_host_secure_store_v1_t|citizensdk_host_services_v1_t|citizensdk_host_status_completion_v1_t|citizensdk_host_status_result_v1_t|citizensdk_host_vault_availability_completion_v1_t|citizensdk_host_vault_availability_result_v1_t|citizensdk_host_wallet_key_ref_v1_t|citizensdk_private_key_receiver_v1_t|citizensdk_wallet_diagnostic_info_v1_t|citizensdk_wallet_input_validation_v1_t)([^A-Za-z0-9_]|$)/\\1\\3/g' \\\n    -e 's/(^|[^A-Za-z0-9_])(sqlite3_open_v2|sqlite3_close_v2|sqlite3_prepare_v2|chainSpec_v1_genesisHash)([^A-Za-z0-9_]|$)/\\1\\3/g' \\\n    -e 's#citizensdk/v1|citizen/sdk/(core|events)/v2##g' \\\n    -e 's/(^|[^A-Za-z0-9_])(citizenchain-wallet-password-v1\\.json|citizenchain-balance-fee-v1\\.json|wallet_v3_preserves_invalid_mode_in_its_original_slot_without_creating_a_signable_account|wallet_v3_round_trips_hot_and_cold_diagnostics_with_strict_identity_boundaries|wallet_v3_round_trips_selection_and_rejects_old_versions_without_fallback|wallet_v3_round_trips_independent_hot_name_without_changing_account_label|host_v1_layout_and_constants_are_exact|host_v1_layout_matches_the_c_header_contract|validate_bool_result_v1|validate_bytes_result_v1|validate_public_store_v1|validate_record_result_v1|validate_secret_vault_v1|validate_secure_store_v1|validate_status_result_v1|validate_vault_availability_result_v1|json-v1)([^A-Za-z0-9_]|$)/\\1\\3/g' \\\n    -e 's/(^|[^A-Za-z0-9_])(citizenchain-wallet-password-v1\\.json|citizenchain-balance-fee-v1\\.json|wallet_v3_preserves_invalid_mode_in_its_original_slot_without_creating_a_signable_account|wallet_v3_round_trips_hot_and_cold_diagnostics_with_strict_identity_boundaries|wallet_v3_round_trips_selection_and_rejects_old_versions_without_fallback|wallet_v3_round_trips_independent_hot_name_without_changing_account_label|host_v1_layout_and_constants_are_exact|host_v1_layout_matches_the_c_header_contract|validate_bool_result_v1|validate_bytes_result_v1|validate_public_store_v1|validate_record_result_v1|validate_secret_vault_v1|validate_secure_store_v1|validate_status_result_v1|validate_vault_availability_result_v1|json-v1)([^A-Za-z0-9_]|$)/\\1\\3/g' \\\n    -e 's/public-state-v1\\.sqlite3//g' \\\n    -e 's/secure-state-v1\\.sqlite3//g' \\\n    -e 's/citizensdk_host_record_completion_v1_t//g' \\\n    -e 's/citizenchain-runtime-v[0-9]+-metadata\\.hex//g' \\\n    -e 's/create_v4_signed//g' \\\n    -e 's/wallet_v2_round_trips_cold_catalog_and_rejects_v1_without_fallback//g' \\\n    -e 's/citizenchain-transfer-build-v1\\.json//g' \\\n    -e 's/transactionWatch_v1[_A-Za-z]*//g' \\\n    -e 's/transaction_watch_uses_the_upstream_v1_surface_without_legacy_fallback//g' \\\n    -e 's/generic_qr_v1_signer\\.dart//g' \\\n    -e 's/citizenchain-wallet-derivation-v1\\.json//g' \\\n    -e 's/QR_V2//g' \\\n    -e 's/Uuid::new_v[45]//g' \\\n    -e 's/arm64-v8a//g' \\\n    -e 's/armeabi-v7a//g' \\\n    -e 's/libbarhopper_v[0-9]+//g' \\\n    -e 's/RSASSA-PKCS1-v1_5//g' \\\n    -e 's/sc-rpc-spec-v2//g' \\\n    -e 's#https://api\\.appstoreconnect\\.apple\\.com/v1##g' \\\n    -e 's/appstoreconnect-v1//g' \\\n    -e 's#/(upload/)?androidpublisher/v[0-9]+##g' \\\n    -e 's/citizen(app|wallet)-(ios|android)-v[0-9]+\\.[0-9]+\\.[0-9]+//g' \\\n    -e 's/citizen(serve-cloudflare|web)-v[0-9]+\\.[0-9]+\\.[0-9]+//g' \\\n    -e 's/citizensdk-sdk-v[0-9]+\\.[0-9]+\\.[0-9]+//g')\"\n  printf '%s\\n' \"$line\"\n}\n\nfor file in \"${changed_files[@]}\"; do\n  [[ -f \"$file\" ]] || continue\n  [[ \"$file\" == .github/tatagate/index.mjs || \"$file\" == .github/tatagate/contracts.json ]] && continue\n  is_code_file \"$file\" || continue\n  skip_generated_or_vendor \"$file\" && continue\n\n  added_lines=\"$(git diff --unified=0 \"$merge_base\" -- \"$file\" | grep -E '^\\+' | grep -vE '^\\+\\+\\+' || true)\"\n  # 中文注释：自包含动作把受合同约束的实现序列化为一条生成行；机械刷新该行时，\n  # 只排除生成载荷本身，动作脚本其余新增代码仍继续执行全部增量扫描。\n  if [[ \"$file\" == .github/scripts/*/*.mjs ]]; then\n    added_lines=\"$(printf '%s\\n' \"$added_lines\" | grep -vE '^\\+const implementations = Object\\.freeze\\(' || true)\"\n  fi\n  [[ -n \"$added_lines\" ]] || continue\n\n  # 中文注释：第一方新增网络地址只允许 HTTPS/WSS，禁止明文协议及任何降级入口。\n  if printf '%s\\n' \"$added_lines\" | grep -Eq '(http|ws)://'; then\n    # 读取准确源码上下文，只认可真实拒绝型测试，仍扫描同文件其余明文地址。\n    if ! node --input-type=module - \"$file\" \"$flow_root\" <<'TRANSPORT'\nimport { readFileSync } from 'node:fs';\nimport { pathToFileURL } from 'node:url';\nconst [path, flow] = process.argv.slice(2);\nconst { insecureTransportLines } = await import(pathToFileURL(flow + '/index.mjs'));\nprocess.exitCode = insecureTransportLines(path, readFileSync(path, 'utf8')).length ? 1 : 0;\nTRANSPORT\n    then insecure_transport_hits+=(\"${file}: 本次新增内容使用明文网络协议\"); fi\n  fi\n\n  # 中文注释：只拦本次新增残留；命令行工具的结果输出不是浏览器调试日志。\n  # scripts中的Node命令行结果输出不是浏览器调试；其它残留模式仍完整检查。\n  file_residual_regex=\"$residual_regex\"\n  if [[ \"$file\" == scripts/*.mjs || \"$file\" == .github/tatagate/test.mjs ]]; then\n    file_residual_regex=\"(debugger;|dbg!\\(|todo!\\(|unimplemented!\\(|\\b${todo_word}\\b|\\b${fixme_word}\\b)\"\n  fi\n  if [[ \"$file\" != .github/scripts/*/*.mjs && \"$file\" != .github/tatagate/index.mjs ]] && printf '%s\\n' \"$added_lines\" | grep -Eq \"$file_residual_regex\"; then\n    residual_hits+=(\"${file}: 本次新增内容含开发残留\")\n  fi\n\n  # 一次读取准确源文判定拒绝断言，再对整批新增行清理上游/既定标识，避免逐行启动外部进程。\n  # 通过stdin传入整批新增内容，不以超长argv或旁路文件承载源码。\n  protocol_lines=\"$(printf '%s\\n' \"$added_lines\" | node --input-type=module -e '\nimport { readFileSync } from \"node:fs\";\nimport { pathToFileURL } from \"node:url\";\nconst [path, flow] = process.argv.slice(1);\nconst { protocolAssertionLines } = await import(pathToFileURL(flow + \"/index.mjs\"));\nconst allowed = new Set(protocolAssertionLines(path, readFileSync(path, \"utf8\")));\nprocess.stdout.write(readFileSync(0, \"utf8\").split(\"\\n\")\n  .filter(line => !allowed.has(line.replace(/^\\+/u, \"\"))).join(\"\\n\"));\n' \"$file\" \"$flow_root\")\"\n  sanitized=\"$(sanitize_version_line \"$protocol_lines\")\" || { echo \"协议归属扫描执行失败\" >&2; exit 1; }\n  if printf '%s\\n' \"$sanitized\" | grep -Eq \"$version_regex\"; then\n    version_hits+=(\"${file}: 新增非 QR_V1 的一方版本化标识\")\n  fi\n\n  if [[ \"$file\" == *.rs ]] && printf '%s\\n' \"$added_lines\" | grep -Eq '#!?\\[allow\\((dead_code|unused)'; then\n    if ! printf '%s\\n' \"$added_lines\" | has_chinese_comment; then\n      lint_hits+=(\"${file}: 新增编译器抑制但没有中文理由\")\n    fi\n  fi\ndone\n\nif [[ \"${#insecure_transport_hits[@]}\" -gt 0 ]]; then\n  echo \"检测到禁止的明文网络协议：\" >&2\n  printf '  - %s\\n' \"${insecure_transport_hits[@]}\" >&2\n  exit 1\nfi\nif [[ \"${#residual_hits[@]}\" -gt 0 ]]; then\n  echo \"检测到开发残留：\" >&2\n  printf '  - %s\\n' \"${residual_hits[@]}\" >&2\n  exit 1\nfi\nif [[ \"${#version_hits[@]}\" -gt 0 ]]; then\n  echo \"检测到非 QR_V1 的一方版本化标识：\" >&2\n  printf '  - %s\\n' \"${version_hits[@]}\" >&2\n  exit 1\nfi\nif [[ \"${#lint_hits[@]}\" -gt 0 ]]; then\n  echo \"检测到缺少中文理由的编译器抑制：\" >&2\n  printf '  - %s\\n' \"${lint_hits[@]}\" >&2\n  exit 1\nfi\n\necho \"公民产品公开仓库门禁通过。\"\n";
export function checkGuardrails(root, env, execute) {
  const tools = toolEnvironment(env);
  const result = execute(tools.PRODUCT_BASH_BIN, ['--noprofile', '--norc', '-s'], { cwd: root,
    env: { ...env, ...tools, TATAGATE_DIRECTORY: gateDirectory },
    input: guardrailsSource, stdio: ['pipe','inherit','inherit'] });
  if (result.error || result.signal || result.status !== 0) fail('产品增量防护未通过');
}

function platformContent(path,source) {
  if (path!=='.github/tatagate/contracts.json') return source;
  try { const value=JSON.parse(source);value.platform_forbidden_values=[];return JSON.stringify(value); }
  catch { return source; }
}

// 所属仓合同只登记本仓平台命名闭集；不得读取私仓全产品字典作为公开仓运行依赖。
export function validatePlatformNaming(root) {
  const values = contract.platform_forbidden_values;
  if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v)
    || new Set(values).size !== values.length) fail('门禁平台禁用值登记无效');
  for (const path of trackedFiles(root)) {
    if (ignoredPrefixesFor(contract.repository).some(prefix => path.startsWith(prefix))
) continue;
    if (values.slice(1).some(value => path.toLowerCase().includes(value.toLowerCase()))) fail('产品存在禁用平台目录：' + path);
    const text = platformContent(path, readFileSync(resolve(root,path),'utf8')).toLowerCase();
    if (values.some(value => text.includes(value.toLowerCase()))) fail('产品存在禁用平台命名：' + path);
  }
}

// 提交中的本仓合同是唯一门禁执行登记；工作目录仅承接当前门禁的中间物。
const gateDirectory = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(resolve(gateDirectory, 'contracts.json'), 'utf8'));
export function gateContract(value = contract) {
  const contract = value;
  exactKeys(contract, ['schema','repository','workflows','node_tests','checks','tools','tool_sources','platform_forbidden_values'], '本仓塔塔门禁');
  if (contract.schema !== 1 || !/^[a-z][a-z0-9]*$/u.test(contract.repository)
    || !Array.isArray(contract.workflows) || !Array.isArray(contract.node_tests)
    || !Array.isArray(contract.checks) || contract.node_tests.length === 0
    || new Set(contract.node_tests).size !== contract.node_tests.length
    || new Set(contract.workflows).size !== contract.workflows.length) fail('本仓塔塔门禁登记无效');
  for (const file of contract.node_tests) {
    if (!/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mjs$/u.test(file)
      || file.split('/').some(v => ['', '.', '..'].includes(v))) fail('门禁测试路径无效');
  }
  const allowed = ['repository-contracts','dependency-contracts','cross-platform-contracts','shared-contracts'];
  if (contract.checks.some(id => !allowed.includes(id)) || new Set(contract.checks).size !== contract.checks.length) fail('本仓门禁检查闭集无效');
    exactKeys(contract.tools, ['node','actionlint','rust','git','bash','grep','sed'], '门禁工具');
  validateToolSources(contract.tool_sources);
  if (contract.tools.git !== '2.54.0' || contract.tools.bash !== '5.3.20'
    || contract.tools.grep !== '3.12' || contract.tools.sed !== '4.10') fail('基础工具唯一版本无效');
  if (contract.tools.node !== '25.2.1' || contract.tools.actionlint !== '1.7.12'
    || contract.tools.rust !== (contract.repository === 'citizenchain' ? '1.97.1' : null)) fail('门禁工具版本无效');
  if (contract.workflows.some(id => !new RegExp('^' + contract.repository + '\\.[a-z][a-z0-9-]*\\.(?:ci|release)$', 'u').test(id))) fail('Workflow不属于本仓');
  if (!Array.isArray(contract.platform_forbidden_values) || !contract.platform_forbidden_values.length
    || contract.platform_forbidden_values.some(v => typeof v !== 'string' || !v)
    || new Set(contract.platform_forbidden_values).size !== contract.platform_forbidden_values.length) fail('门禁平台禁用值登记无效');
  const expectedChecks = ['repository-contracts',
    ...(contract.repository === 'citizensdk' ? ['dependency-contracts'] : []),
    ...(['citizenchain','citizenapp','citizenwallet'].includes(contract.repository) ? ['cross-platform-contracts'] : []),
    ...(contract.repository === 'citizenchain' ? ['shared-contracts'] : [])];
  if (contract.checks.join('\0') !== expectedChecks.join('\0')) fail('本仓实际检查合同缺失或扩大');
  return contract;
}

export function validateWorkflowSource(source, filename, repository = contract.repository) {
  const canonical = /^name: ([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.(?:ci|release))$/mu.exec(source)?.[1];
  const [product, platform, flow] = String(canonical || '').split('.');
  const jobs = source.split(/^jobs:\s*\n/mu)[1];
  if (!canonical || product !== repository || filename !== product + '-' + platform + '-' + flow + '.yml'
    || !/^\s*workflow_dispatch:\s*$/mu.test(source) || /^\s*push:\s*$/mu.test(source)
    || !jobs || [...jobs.matchAll(/^  flow:$/gmu)].length !== 1
    || !source.includes('allowed=new Set(["' + canonical + '"])')
    || !source.includes('  group: ' + canonical + '\n')) fail('产品Workflow三维身份无效');
  return canonical;
}

export function validateWorkflow(root) {
  const directory = resolve(root, '.github/workflows');
  const expected = ['tatagate.yml', ...contract.workflows.map(id => id.replaceAll('.', '-') + '.yml')].sort();
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || lstatSync(resolve(directory, entry.name)).isSymbolicLink())
    || entries.map(entry => entry.name).sort().join('\0') !== expected.join('\0')) fail('本仓Workflow文件集合不符');
  for (const entry of entries) {
    const source = readFileSync(resolve(directory, entry.name), 'utf8');
    if (entry.name === 'tatagate.yml') {
      if (!/^name: tatagate$/mu.test(source) || !/^\s*push:\s*$/mu.test(source)
        || !source.includes('branches: [main]') || /^\s*(?:pull_request|workflow_dispatch|workflow_run):/mu.test(source)
        || !source.includes("['.github/tatagate/index.mjs', 'remote']")
        || !source.includes("['.github/tatagate/tools.mjs', 'prepare-runner', '--bootstrap', work]")) fail('GitHub塔塔门禁入口无效');
    } else if (!contract.workflows.includes(validateWorkflowSource(source, entry.name))) fail('产品Workflow不属于本仓登记');
  }
  return entries.map(entry => '.github/workflows/' + entry.name);
}

// 路径、源码与测试只消费自身提交；临时目录不能在源码里，也不能复用别仓或别次任务。
function environment(root, work) {
  // 只传真实执行所需的基础环境与Runner身份；其它产品根、私有状态与任何凭据均不继承。
  const names=['HOME','USER','LOGNAME','LANG','LC_ALL','PATH','RUSTUP_HOME','RUSTUP_TOOLCHAIN',
    'GITHUB_ACTIONS','GITHUB_WORKSPACE','GITHUB_SHA','GITHUB_EVENT_NAME','GITHUB_REF',
    'GITHUB_WORKFLOW','GITHUB_JOB','GITHUB_REPOSITORY','RUNNER_TOOL_CACHE','RUNNER_TEMP',
    'GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'];
  const result={...Object.fromEntries(names.filter(name=>typeof process.env[name]==='string').map(name=>[name,process.env[name]])),
    ...toolEnvironment()};
  Object.assign(result,{ TMPDIR:resolve(work,'tmp'),CARGO_HOME:resolve(work,'cargo-home'),
    CARGO_TARGET_DIR:resolve(work,'cargo'),CARGO_INCREMENTAL:'0' });
  result[contract.repository.toUpperCase()+'_ROOT']=root;
  mkdirSync(result.TMPDIR,{recursive:true});
  return result;
}
export async function executeGate({ root, baseSHA, headSHA, work, actionlint, cargo }, { execute = spawnSync, report = console.log } = {}) {
  gateContract();
  if (process.version !== 'v' + contract.tools.node) fail('塔塔门禁必须使用本仓登记的唯一Node版本');
  validateRange({ root, baseSHA, headSHA });
  if (!isAbsolute(work) || realpathSync(work) !== work || !lstatSync(work).isDirectory()
    || lstatSync(work).isSymbolicLink() || work === root || work.startsWith(root + '/')
    || root.startsWith(work + '/') || readdirSync(work).length !== 0) fail('门禁独占临时目录边界无效');
  const before = git(root, ['status','--porcelain=v1','--untracked-files=all']);
  if (before.trim()) fail('本仓门禁只接受干净的已保存提交');
  const env = environment(root, work);
  env.BASE_SHA = baseSHA; env.BASE_REF = baseSHA;
  env.TATAGATE_WORK_DIR = work;
  env.TATAGATE_REPOSITORY_ROOT = root;

  const run = (command, args, label) => {
    const result = execute(command, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) fail('本仓塔塔门禁失败：' + label);
  };
  assertNoProductOutputDirectories(root, contract.repository);
  validateSecrets(root);
  validatePlatformNaming(root);
  checkGuardrails(root, env, execute);
  await validateQuality(root, baseSHA, headSHA, contract.repository);
  const workflowFiles = validateWorkflow(root);
  if (!isAbsolute(String(actionlint || '')) || !lstatSync(actionlint).isFile()
    || lstatSync(actionlint).isSymbolicLink()) fail('Workflow检查器必须是已验真的准确执行器');
  const version = execute(actionlint, ['-version'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  if (version.error || version.signal || version.status !== 0
    || !new RegExp('(?:^|\\s)v?' + contract.tools.actionlint.replaceAll('.', '\\.') + '(?:\\s|$)', 'u').test(version.stdout)) fail('Workflow检查器版本不符');
  // 不调用PATH中的可选外部分析器；Shell与JSON/MJS仍由下面的真实语法检查逐文件验真。
  run(actionlint, ['-shellcheck=', '-pyflakes=', ...workflowFiles], 'Workflow语法');
  validateSyntax(root, execute, env, contract.repository);
  for (const relative of contract.node_tests) {
    const path = resolve(root, relative), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) fail('本仓真实测试文件缺失');
  }
  report(contract.repository + ' · 本机/GitHub共用塔塔门禁');
  run(process.execPath, ['--test', '--test-reporter=' + resolve(gateDirectory, 'index.mjs'),
    resolve(gateDirectory, 'test.mjs'), ...contract.node_tests.map(path => resolve(root, path))], '所属仓真实合同测试');
  if (contract.checks.includes('dependency-contracts')) await checkDependencies(root, { execute, report, env });
  if (contract.checks.includes('cross-platform-contracts')) await checkCrossPlatform(root, { report });
  if (contract.checks.includes('shared-contracts')) {
    if (!isAbsolute(String(cargo || '')) || !lstatSync(cargo).isFile()) fail('链门禁缺少登记的准确Cargo');
    const cargoVersion = execute(cargo, ['--version'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    if (cargoVersion.error || cargoVersion.signal || cargoVersion.status !== 0
      || !/^cargo 1\.97\.1(?:\s|$)/u.test(cargoVersion.stdout)) fail('链门禁Cargo版本不符');
    env.PATH = dirname(cargo) + ':' + env.PATH;
    run(cargo, ['fmt','--all','--','--check'], 'Rust格式');
    run(cargo, ['clippy','--workspace','--all-targets','--locked','--','-D','warnings'], 'RustClippy');
    run(cargo, ['test','--workspace','--all-targets','--locked'], 'Rust工作区测试');
  }

  assertNoProductOutputDirectories(root, contract.repository);
  if (git(root, ['status','--porcelain=v1','--untracked-files=all']) !== before) fail('门禁执行改动了所属提交源码');
  return Object.freeze({ repository: contract.repository, base_sha: baseSHA, head_sha: headSHA });
}

export async function repositoryGateMain(args) {
  const [mode, root, baseSHA, headSHA, work] = args;
  if (mode === 'physical' && args.length === 2) {
    if (realpathSync(root) !== root) fail('本仓物理根必须真实');
    assertNoProductOutputDirectories(root, contract.repository);
    return;
  }
  if (mode === 'local' && args.length === 5) return executeGate({
    root, baseSHA, headSHA, work, actionlint: process.env.TATAGATE_ACTIONLINT,
    cargo: process.env.TATAGATE_CARGO,
  });
  if (mode === 'remote' && args.length === 1 && process.env.GITHUB_ACTIONS === 'true') {
    const root = process.env.GITHUB_WORKSPACE, headSHA = process.env.GITHUB_SHA;
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main'
      || process.env.GITHUB_WORKFLOW !== 'tatagate' || process.env.GITHUB_JOB !== 'gate'
      || event.ref !== 'refs/heads/main' || event.after !== headSHA
      || event.repository?.name !== contract.repository || event.deleted) fail('远端push门禁身份无效');
    const baseSHA = pushBaseSHA({ forced: event.forced, before: event.before, headSHA,
      parents: event.forced === true ? git(root, ['rev-list', '--parents', '-n', '1', headSHA]).trim() : undefined,
      commitCount: event.forced === true ? git(root, ['rev-list', '--count', headSHA]).trim() : undefined });
    if (baseSHA === emptyTreeSHA) git(root, ['hash-object','-w','-t','tree','/dev/null']);
    const work = resolve(process.env.RUNNER_TEMP, 'tatagate-' + contract.repository + '-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT);
    mkdirSync(work);
    try { return await executeGate({ root, baseSHA, headSHA, work,
      actionlint: process.env.TATAGATE_ACTIONLINT, cargo: process.env.TATAGATE_CARGO }); }
    finally { rmSync(work, { recursive: true }); }
  }
  fail('本仓塔塔门禁参数或身份无效');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await repositoryGateMain(process.argv.slice(2)); }
  catch (error) {
    // 仅输出门禁固定诊断或本地受控路径；不得透传网络响应、子进程异常或凭据。
    console.error(error?.message?.startsWith('本仓') || error?.message?.startsWith('产品')
      || error?.message?.startsWith('门禁') || error?.message?.startsWith('公开')
      || error?.message?.startsWith('金标') || error?.message?.startsWith('链门禁')
      ? error.message : '所属仓塔塔门禁失败，请检查以上准确检查项，未放行推送。');
    process.exitCode = 1;
  }
}
