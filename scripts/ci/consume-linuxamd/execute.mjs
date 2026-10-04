#!/usr/bin/env node
import { spawnSync as runExactProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 缓存身份使用固定语义前缀，不把内部实现误当成版本化协议。
export const CI_CACHE_SCHEMA = 'ci';

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`缺少${label}`);
  return normalized;
}

function token(value, label) {
  const normalized = required(value, label).toLowerCase();
  // GitHub 作业名允许下划线；仍禁止路径分隔符、空白和越界长度。
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(`${label}不是安全缓存标识`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = required(value, label);
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${label}必须是正整数`);
  return normalized;
}

function repositoryIdentity(value) {
  const normalized = required(value, '仓库身份');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error('仓库身份必须使用owner/repository');
  }
  return {
    api: normalized,
    key: normalized.toLowerCase().replace('/', '.'),
  };
}

export function cacheIdentity(input) {
  const repository = repositoryIdentity(input.repository);
  const toolchain = required(input.toolchainFingerprint, '工具链指纹').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(toolchain)) throw new Error('工具链指纹必须是SHA-256');
  const identity = Object.freeze({
    repository: repository.api,
    repositoryKey: repository.key,
    product: token(input.product, '产品'),
    platform: token(input.platform, '平台'),
    architecture: token(input.architecture, '架构'),
    component: token(input.component, 'CI组件'),
    runnerOs: token(input.runnerOs, 'Runner系统'),
    runnerArch: token(input.runnerArch, 'Runner架构'),
    toolchainFingerprint: toolchain,
  });
  const logicalKey = [
    CI_CACHE_SCHEMA,
    identity.product,
    identity.platform,
    identity.architecture,
    identity.component,
    identity.runnerOs,
    identity.runnerArch,
  ].join('-');
  const baseKey = `${logicalKey}-${toolchain.slice(0, 16)}`;
  if (baseKey.length > 400) throw new Error('缓存身份超过安全长度');
  return Object.freeze({ ...identity, logicalKey, baseKey });
}

export function cacheKeys(identity, runId, attempt) {
  const run = positiveInteger(runId, 'GitHub Run ID');
  const runAttempt = positiveInteger(attempt, 'GitHub Run Attempt');
  return Object.freeze({
    successPrefix: `${identity.baseKey}-success-`,
    failurePrefix: `${identity.baseKey}-failure-`,
    successKey: `${identity.baseKey}-success-${run}-${runAttempt}`,
    failureKey: `${identity.baseKey}-failure-${run}-${runAttempt}`,
  });
}

export function parseCacheKey(identity, key) {
  const parsed = parseLogicalCacheKey(identity, key);
  return parsed?.toolchain === identity.toolchainFingerprint.slice(0, 16) ? parsed : null;
}

export function parseLogicalCacheKey(identity, key) {
  const prefix = `${identity.logicalKey}-`;
  if (!String(key).startsWith(prefix)) return null;
  const remainder = String(key).slice(prefix.length);
  const toolchain = remainder.slice(0, 16);
  if (!/^[0-9a-f]{16}$/.test(toolchain) || remainder[16] !== '-') return null;
  const stateAndRun = remainder.slice(17);
  for (const state of ['success', 'failure']) {
    const statePrefix = `${state}-`;
    if (!stateAndRun.startsWith(statePrefix)) continue;
    const match = stateAndRun.slice(statePrefix.length).match(/^([1-9][0-9]*)-([1-9][0-9]*)$/);
    if (!match) return null;
    return Object.freeze({ toolchain, state, runId: match[1], attempt: match[2] });
  }
  return null;
}

function compareCache(left, right) {
  for (const field of ['runId', 'attempt', 'id']) {
    const difference = BigInt(left[field]) - BigInt(right[field]);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return 0;
}

function recognizedCaches(identity, caches, ref, currentToolchainOnly = false) {
  const rows = [];
  for (const cache of caches) {
    if (ref && cache.ref !== ref) continue;
    const parsed = parseLogicalCacheKey(identity, cache.key);
    if (!parsed || !/^[1-9][0-9]*$/.test(String(cache.id ?? ''))) continue;
    if (currentToolchainOnly
        && parsed.toolchain !== identity.toolchainFingerprint.slice(0, 16)) continue;
    rows.push({ ...cache, ...parsed, id: String(cache.id) });
  }
  return rows;
}

export function selectLatestCache(identity, caches, state = 'success', ref = '') {
  if (!['success', 'failure'].includes(state)) throw new Error('缓存状态无效');
  const rows = recognizedCaches(identity, caches, ref, true)
    .filter((cache) => cache.state === state);
  rows.sort(compareCache);
  return rows.at(-1) ?? null;
}

export function planCachePrune(identity, caches, ref = '') {
  const rows = recognizedCaches(identity, caches, ref);
  const retained = new Set();
  for (const state of ['success', 'failure']) {
    const candidates = rows.filter((cache) => cache.state === state).sort(compareCache);
    const latest = candidates.at(-1);
    if (latest) retained.add(latest.id);
  }
  return Object.freeze({
    retain: rows.filter((cache) => retained.has(cache.id)),
    remove: rows.filter((cache) => !retained.has(cache.id)),
  });
}

function pathImplementation(runnerOs) {
  return runnerOs === 'windows' ? path.win32 : path.posix;
}

export function cachePathPlan(identity, runnerTemp, entries) {
  const pathApi = pathImplementation(identity.runnerOs);
  const temp = required(runnerTemp, 'Runner临时目录');
  if (!pathApi.isAbsolute(temp)) throw new Error('Runner临时目录必须是绝对路径');
  const names = String(entries ?? '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error('至少需要一个成功缓存路径');
  if (new Set(names).size !== names.length) throw new Error('成功缓存路径不能重复');
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(name)) {
      throw new Error(`缓存相对路径无效：${name}`);
    }
  }
  const digest = createHash('sha256').update(identity.baseKey).digest('hex').slice(0, 20);
  const rootName = `${identity.product}-${identity.platform}-${identity.component}-${digest}`;
  const root = pathApi.resolve(temp, 'ci-cache', rootName);
  const expectedParent = pathApi.resolve(temp, 'ci-cache');
  const relative = pathApi.relative(expectedParent, root);
  if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) {
    throw new Error('缓存根目录逃出Runner临时目录');
  }
  return Object.freeze({
    root,
    successPaths: names.map((name) => pathApi.join(root, ...name.split('/'))),
    failurePath: pathApi.join(root, 'failure-diagnostic'),
  });
}

function relativeEntries(value, label) {
  const entries = String(value ?? '').split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(entry)) {
      throw new Error(`${label}相对路径无效：${entry}`);
    }
  }
  return entries;
}

function resolvedChild(pathApi, parent, relative, label) {
  const target = pathApi.resolve(parent, ...relative.split('/'));
  const child = pathApi.relative(parent, target);
  if (!child || child.startsWith('..') || pathApi.isAbsolute(child)) {
    throw new Error(`${label}逃出允许根`);
  }
  return target;
}

export function wireCacheLinks(identity, runnerTemp, entries, workspace, links) {
  const pathApi = pathImplementation(identity.runnerOs);
  const plan = cachePathPlan(identity, runnerTemp, entries);
  const workspaceRoot = required(workspace, 'GitHub工作区');
  if (!pathApi.isAbsolute(workspaceRoot)) throw new Error('GitHub工作区必须是绝对路径');
  const rows = String(links ?? '').split(/\n/).map((entry) => entry.trim()).filter(Boolean);
  for (const row of rows) {
    const separator = row.indexOf('=');
    if (separator <= 0) throw new Error(`缓存目录链接无效：${row}`);
    const sourceRelative = row.slice(0, separator);
    const cacheRelative = row.slice(separator + 1);
    relativeEntries(sourceRelative, '工作区生成目录');
    relativeEntries(cacheRelative, '受控缓存目录');
    const source = resolvedChild(pathApi, workspaceRoot, sourceRelative, '工作区生成目录');
    const target = resolvedChild(pathApi, plan.root, cacheRelative, '受控缓存目录');
    mkdirSync(pathApi.dirname(source), { recursive: true });
    mkdirSync(target, { recursive: true });
    if (existsSync(source)) {
      const status = lstatSync(source);
      if (status.isSymbolicLink()) {
        const linked = pathApi.resolve(pathApi.dirname(source), readlinkSync(source));
        if (linked === target) continue;
      }
      throw new Error(`工作区生成目录已存在且不是准确缓存链接：${sourceRelative}`);
    }
    symlinkSync(target, source, identity.runnerOs === 'windows' ? 'junction' : 'dir');
  }
  return plan;
}

export function sanitizeCacheFinals(identity, runnerTemp, entries, finals) {
  const pathApi = pathImplementation(identity.runnerOs);
  const plan = cachePathPlan(identity, runnerTemp, entries);
  for (const relative of relativeEntries(finals, '最终候选')) {
    rmSync(resolvedChild(pathApi, plan.root, relative, '最终候选'), {
      recursive: true,
      force: true,
    });
  }
}

function identityFromEnvironment(environment) {
  return cacheIdentity({
    repository: environment.GITHUB_REPOSITORY,
    product: environment.CI_CACHE_PRODUCT,
    platform: environment.CI_CACHE_PLATFORM,
    architecture: environment.CI_CACHE_ARCHITECTURE,
    component: environment.CI_CACHE_COMPONENT,
    runnerOs: environment.RUNNER_OS,
    runnerArch: environment.RUNNER_ARCH,
    toolchainFingerprint: environment.CI_CACHE_TOOLCHAIN_FINGERPRINT,
  });
}

function githubHeaders(tokenValue) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${required(tokenValue, 'GitHub Actions令牌')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ci-cache',
  };
}

async function githubRequest(url, tokenValue, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...githubHeaders(tokenValue), ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`GitHub缓存API失败：${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

async function listRepositoryCaches(repository, tokenValue) {
  const caches = [];
  for (let page = 1; ; page += 1) {
    const endpoint = `https://api.github.com/repos/${repository}/actions/caches?per_page=100&page=${page}`;
    const result = await githubRequest(endpoint, tokenValue);
    const rows = Array.isArray(result?.actions_caches) ? result.actions_caches : [];
    caches.push(...rows);
    if (rows.length < 100) break;
  }
  return caches;
}

async function deleteRepositoryCache(repository, cacheId, tokenValue) {
  await githubRequest(
    `https://api.github.com/repos/${repository}/actions/caches/${cacheId}`,
    tokenValue,
    { method: 'DELETE' },
  );
}

function output(name, value, environment) {
  const target = environment.GITHUB_OUTPUT;
  if (!target) return;
  const text = String(value);
  if (text.includes('\n')) {
    const delimiter = `CI_CACHE_${name.toUpperCase()}_EOF`;
    if (text.includes(delimiter)) throw new Error('GitHub多行输出包含保留分隔符');
    appendFileSync(target, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
  } else {
    appendFileSync(target, `${name}=${text}\n`);
  }
}

function persistEnvironment(name, value, environment) {
  const target = environment.GITHUB_ENV;
  if (!target) return;
  const text = String(value ?? '');
  if (text.includes('\n')) {
    const delimiter = `CI_CACHE_ENV_${name}_EOF`;
    if (text.includes(delimiter)) throw new Error('GitHub环境变量包含保留分隔符');
    appendFileSync(target, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
  } else {
    appendFileSync(target, `${name}=${text}\n`);
  }
}

function commandContext(environment) {
  requireExactRemoteJobEnvironment();
  const identity = identityFromEnvironment(environment);
  const keys = cacheKeys(identity, environment.GITHUB_RUN_ID, environment.GITHUB_RUN_ATTEMPT);
  const paths = cachePathPlan(identity, environment.RUNNER_TEMP, environment.CI_CACHE_PATHS);
  const ref = required(environment.GITHUB_REF, 'GitHub Ref');
  const tokenValue = environment.GH_TOKEN || environment.GITHUB_TOKEN;
  return { identity, keys, paths, ref, tokenValue };
}

async function prepare(environment) {
  const context = commandContext(environment);
  const caches = await listRepositoryCaches(context.identity.repository, context.tokenValue);
  const latest = selectLatestCache(context.identity, caches, 'success', context.ref);
  for (const directory of [...context.paths.successPaths, context.paths.failurePath]) {
    mkdirSync(directory, { recursive: true });
  }
  const restoreKey = latest?.key ?? `${context.keys.successPrefix}none`;
  output('cache_root', context.paths.root, environment);
  output('success_paths', context.paths.successPaths.join('\n'), environment);
  output('failure_paths', context.paths.failurePath, environment);
  output('restore_key', restoreKey, environment);
  output('success_key', context.keys.successKey, environment);
  output('failure_key', context.keys.failureKey, environment);
  for (const name of [
    'CI_CACHE_PRODUCT', 'CI_CACHE_PLATFORM', 'CI_CACHE_ARCHITECTURE',
    'CI_CACHE_COMPONENT', 'CI_CACHE_TOOLCHAIN_FINGERPRINT', 'CI_CACHE_PATHS',
    'CI_CACHE_LINKS', 'CI_CACHE_FINALS', 'CI_CACHE_WORKFLOW', 'CI_CACHE_JOB',
  ]) persistEnvironment(name, environment[name] ?? '', environment);
  persistEnvironment('CI_INCREMENTAL_ROOT', context.paths.root, environment);
  const pathByName = new Map(
    relativeEntries(environment.CI_CACHE_PATHS, '成功缓存').map(
      (name, index) => [name, context.paths.successPaths[index]],
    ),
  );
  const environmentPaths = {
    'cargo-home': 'CARGO_HOME',
    'cargo-target': 'CARGO_TARGET_DIR',
    'dart-pub': 'PUB_CACHE',
    gradle: 'GRADLE_USER_HOME',
    cocoapods: 'CP_HOME_DIR',
    npm: 'npm_config_cache',
    xdg: 'XDG_CACHE_HOME',
  };
  for (const [cacheName, environmentName] of Object.entries(environmentPaths)) {
    if (pathByName.has(cacheName)) persistEnvironment(environmentName, pathByName.get(cacheName), environment);
  }
  if (pathByName.has('cargo-target')) persistEnvironment('CARGO_INCREMENTAL', '1', environment);
  if (pathByName.has('cargo-home') && environment.GITHUB_PATH) {
    appendFileSync(environment.GITHUB_PATH, `${path.join(pathByName.get('cargo-home'), 'bin')}\n`);
  }
  if (!environment.GITHUB_OUTPUT) {
    process.stdout.write(`${JSON.stringify({
      cacheRoot: context.paths.root,
      restoreKey,
      successKey: context.keys.successKey,
      failureKey: context.keys.failureKey,
    })}\n`);
  }
}

function wire(environment) {
  const context = commandContext(environment);
  wireCacheLinks(
    context.identity,
    environment.RUNNER_TEMP,
    environment.CI_CACHE_PATHS,
    environment.GITHUB_WORKSPACE,
    environment.CI_CACHE_LINKS,
  );
}

function sanitize(environment) {
  const context = commandContext(environment);
  sanitizeCacheFinals(
    context.identity,
    environment.RUNNER_TEMP,
    environment.CI_CACHE_PATHS,
    environment.CI_CACHE_FINALS,
  );
}

function writeTerminalRecord(environment) {
  const context = commandContext(environment);
  const state = token(environment.CI_CACHE_TERMINAL_STATE, '终态');
  if (!['success', 'failure'].includes(state)) throw new Error('终态只能是success或failure');
  const sourceSha = required(environment.GITHUB_SHA, 'GitHub源码SHA').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('GitHub源码SHA无效');
  const directory = state === 'success' ? context.paths.successPaths[0] : context.paths.failurePath;
  mkdirSync(directory, { recursive: true });
  const record = {
    schema: CI_CACHE_SCHEMA,
    state,
    repository: context.identity.repository,
    product: context.identity.product,
    platform: context.identity.platform,
    architecture: context.identity.architecture,
    component: context.identity.component,
    runner_os: context.identity.runnerOs,
    runner_arch: context.identity.runnerArch,
    source_sha: sourceSha,
    run_id: positiveInteger(environment.GITHUB_RUN_ID, 'GitHub Run ID'),
    run_attempt: positiveInteger(environment.GITHUB_RUN_ATTEMPT, 'GitHub Run Attempt'),
    workflow: token(environment.CI_CACHE_WORKFLOW, 'Workflow'),
    job: token(environment.CI_CACHE_JOB, 'Job'),
  };
  const receipt = path.join(directory, `${state}.json`);
  // 成功目录可能来自上一份成功缓存；新成功只替换旧成功回执，不累积代次文件。
  rmSync(receipt, { force: true });
  writeFileSync(
    receipt,
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: 'wx' },
  );
}

async function prune(environment) {
  const context = commandContext(environment);
  const state = token(environment.CI_CACHE_TERMINAL_STATE, '终态');
  if (!['success', 'failure'].includes(state)) throw new Error('终态只能是success或failure');
  const currentKey = state === 'success' ? context.keys.successKey : context.keys.failureKey;
  const caches = await listRepositoryCaches(context.identity.repository, context.tokenValue);
  const currentExists = caches.some(
    (cache) => cache.key === currentKey && cache.ref === context.ref,
  );
  if (!currentExists) throw new Error('新缓存槽尚未确认存在，拒绝删除历史缓存');
  const plan = planCachePrune(context.identity, caches, context.ref);
  for (const cache of plan.remove) {
    await deleteRepositoryCache(context.identity.repository, cache.id, context.tokenValue);
  }
  process.stdout.write(
    `CI缓存收口完成：保留${plan.retain.length}个，删除${plan.remove.length}个\n`,
  );
}


// 本文件只执行 citizensdk.sdk.ci 的 consume-linuxamd Job；阶段编号由本仓唯一 Workflow 固定，禁止接收其它身份。
export const EXACT_REMOTE_JOB_IDENTITY = Object.freeze({"pipeline":"citizensdk.sdk.ci","job":"consume-linuxamd"});

function requireExactRemoteJobEnvironment() {
  const expected = 'crcfrcn/citizensdk';
  if (!expected || process.env.GITHUB_REPOSITORY !== expected) {
    throw new Error('准确远端Job仓库身份无效');
  }
}
// 内嵌Node正文按JSON解码后的实际字节执行，控制字符转义必须保留。
const workflowSteps = Object.freeze({
  "0": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" prepare"
  },
  "1": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" wire\nprintf 'CARGO_TARGET_DIR=%s/cache/cargo\n' \"$CI_INCREMENTAL_ROOT\" >> \"$GITHUB_ENV\"\nprintf 'CITIZENSDK_WORK_DIR=%s/cache\n' \"$CI_INCREMENTAL_ROOT\" >> \"$GITHUB_ENV\"\nprintf 'CARGO_INCREMENTAL=1\nCARGO_BUILD_JOBS=2\n' >> \"$GITHUB_ENV\"\nnode \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" sanitize\n"
  },
  "2": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\"\n"
  },
  "3": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst e=process.env;\nconst match=/^citizensdk_(ci|release)_sdk__(android|apple|linuxarm|linuxamd|windows|aggregate|consume_(?:android|apple|linuxarm|linuxamd|windows)|finalize)$/.exec(e.CITIZENSDK_JOB);\nif(!match || (match[1]==='ci' && match[2]==='finalize')) throw Error('SDK job identity mismatch');\nconst action=match[1], stage=match[2];\nconst suffix=stage.replace(/^consume_/,'');\nconst jobs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],\n  linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],\n  windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=jobs[suffix];\nif(!spec || spec[0]!==e.CITIZENSDK_PLATFORM ||\n  spec[1]!==process.platform || spec[2]!==process.arch) throw Error('SDK runner/platform mismatch');\nif(!/^[0-9a-f]{40}$/.test(e.CITIZENSDK_SOURCE_SHA) ||\n  ![e.GITHUB_RUN_ID,e.GITHUB_RUN_ATTEMPT].every(x=>/^[1-9][0-9]*$/.test(x))) throw Error('SDK source/run identity missing');\nconst source=path.resolve('.');\nconst seed=fs.readFileSync(path.join(source,'pubspec.yaml'),'utf8').match(/^version: (d+.d+.d+)$/m)?.[1];\nconst version=action==='release'?e.CITIZENSDK_SOFTWARE_VERSION:seed;\nif(!/^d+.d{1,2}.d{1,2}$/.test(version||'')) throw Error('SDK version missing');\nif(version!==seed) throw Error('SDK Release version must equal frozen source');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+e.CITIZENSDK_JOB+'-'+e.CITIZENSDK_SOURCE_SHA+'-'+version;\nconst parent=path.join(e.RUNNER_TEMP,'citizensdk');\nconst root=path.join(parent,name);\nif(fs.existsSync(root)) throw Error('SDK task directory already exists');\nif(action==='ci' && !e.CI_INCREMENTAL_ROOT) throw Error('SDK build state missing');\nconst buildRoot=action==='ci'?e.CI_INCREMENTAL_ROOT:path.join(root,'state');\nconst workRoot=stage.startsWith('consume_')?path.join(root,'cache'):path.join(buildRoot,'cache');\n// Windows 仍有部分工具受 MAX_PATH 约束；Flutter 原件必须放在 runner 临时目录的短路径中，\n// 同时保留 run、attempt 与平台身份，避免同一 runner 上不同作业复用或覆盖原件。\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nif(fs.existsSync(flutterRoot)) throw Error('SDK Flutter task directory already exists');\nfs.mkdirSync(parent,{recursive:true,mode:0o700});\nfs.mkdirSync(root,{mode:0o700});\nfs.cpSync(source,path.join(root,'source'),{recursive:true,errorOnExist:true,force:false,\n  filter:entry=>entry!==path.join(source,'.git')});\nfor(const part of ['native','tmp','transfer']) fs.mkdirSync(path.join(root,part),{mode:0o700});\nfs.mkdirSync(path.join(buildRoot,'cache'),{recursive:true,mode:0o700});\nfs.mkdirSync(workRoot,{recursive:true,mode:0o700});\nif(action==='ci') fs.mkdirSync(path.join(buildRoot,'cache','consumer'),{recursive:true,mode:0o700});\nconst values={CITIZENSDK_ACTION:action,CITIZENSDK_BUILD_ROOT:buildRoot,\n  CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',\n  CARGO_INCREMENTAL:action==='ci'?'1':'0',CARGO_BUILD_JOBS:'2',\n  CARGO_HOME:path.join(buildRoot,'cargo-home'),\n  CARGO_TARGET_DIR:path.join(buildRoot,'cache','cargo'),\n  CITIZENSDK_WORK_DIR:root,CITIZENSDK_SOURCE:path.join(root,'source'),\n  CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:version,\n  CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,\n  CITIZENSDK_ARTIFACT:name,\n  CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+action+'-candidate-'+e.CITIZENSDK_SOURCE_SHA+'-'+version,\n  TMPDIR:path.join(root,'tmp')};\nif(action==='ci') values.CITIZENSDK_INCREMENTAL_ROOT=path.join(buildRoot,'cache','consumer');\nfor(const [key,value] of Object.entries(values)) {\n  if(/[\\r\\n]/.test(value)) throw Error('SDK environment value is multiline');\n  fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');\n}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+root+'\\n');\nNODE\n"
  },
  "4": {
    "shell": "bash",
    "source": "node scripts/dependencies.mjs prepare-environment \\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\n' \"$zxing_source\" >> \"$GITHUB_ENV\"\n"
  },
  "5": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  cargo fetch --manifest-path \"$CITIZENSDK_SOURCE/Cargo.toml\" --locked\nfi\n"
  },
  "6": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null\n"
  },
  "7": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\n# 临时镜像只用于本作业，不发布、缓存或替代 SDK 产品。\ndocker build --tag \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \"$tools\"\nsudo apparmor_parser -a -K \"$tools/citizensdk.apparmor\"\n"
  },
  "8": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/index.mjs\" unpack-candidate \\n  --input \"$CITIZENSDK_WORK_DIR/transfer\" --output \"$CITIZENSDK_WORK_DIR/candidate\" \\n  --git-sha \"$CITIZENSDK_SOURCE_SHA\" --software-version \"$CITIZENSDK_VERSION\"\nnode \"$GITHUB_WORKSPACE/scripts/ci/index.mjs\" citizensdk-release \\n  --verify-hosted \"$CITIZENSDK_WORK_DIR/candidate\" --archive \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\n  --hosted-archive \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\n  --output \"$CITIZENSDK_WORK_DIR/verified-hosted\" --expected-git-sha \"$CITIZENSDK_SOURCE_SHA\"\n"
  },
  "9": {
    "shell": "bash",
    "source": "tools=\"$CITIZENSDK_WORK_DIR/tools\"\nprofile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nnode_bin=\"$(dirname \"$(command -v node)\")\"\n# 消费阶段没有 Rust 挂载、prepare-native 或 Cargo；只能链接包内已验真 Core。\nmounts=(--mount \"type=bind,src=$CITIZENSDK_WORK_DIR,dst=$CITIZENSDK_WORK_DIR\"\n  --mount \"type=bind,src=$GITHUB_WORKSPACE/citizensdk,dst=$GITHUB_WORKSPACE/citizensdk,readonly\"\n  --mount \"type=bind,src=$node_bin,dst=$node_bin,readonly\")\nif [[ -n \"${CITIZENSDK_INCREMENTAL_ROOT:-}\" ]]; then\n  mounts+=(--mount \"type=bind,src=$CI_INCREMENTAL_ROOT,dst=$CI_INCREMENTAL_ROOT\")\nfi\nvariables=()\nfor name in GITHUB_ACTIONS RUNNER_ENVIRONMENT RUNNER_TEMP PUB_CACHE CITIZENSDK_WORK_DIR \\n  CITIZENSDK_SOURCE CITIZENSDK_NATIVE_OUTPUT_DIR CITIZENSDK_FLUTTER_ROOT \\n  CITIZENSDK_WORK_DIR GITHUB_WORKSPACE CITIZENSDK_SOURCE_SHA CITIZENSDK_VERSION CITIZENSDK_PLATFORM \\n  CITIZENSDK_INCREMENTAL_ROOT CI_INCREMENTAL_ROOT; do\n  variables+=(--env \"$name\")\ndone\ndocker run --name \"$profile\" --label \"org.citizensdk.run=$CITIZENSDK_ARTIFACT\" \\n  --network none --cap-drop ALL --security-opt no-new-privileges \\n  --security-opt \"apparmor=$profile\" --security-opt \"seccomp=$tools/citizensdk.seccomp.json\" \\n  --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --tmpfs /run:rw,nosuid,nodev,mode=755 \\n  --pids-limit 1024 \"${mounts[@]}\" \"${variables[@]}\" \\n  --env \"PATH=$node_bin:/opt/cmake/bin:$CITIZENSDK_FLUTTER_ROOT/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\" \\n  \"$profile\" /bin/bash -euc '\n    test \"$(getconf GNU_LIBC_VERSION)\" = \"glibc 2.31\"\n    xvfb-run -a dbus-run-session -- bash \"$GITHUB_WORKSPACE/scripts/build-native.sh\" \"$CITIZENSDK_PLATFORM\" \\n      \"$CITIZENSDK_WORK_DIR/candidate\" \"$CITIZENSDK_WORK_DIR/transfer/citizensdk.tgz\" \\n      \"$CITIZENSDK_WORK_DIR/transfer/citizen_sdk-$CITIZENSDK_VERSION.tar.gz\" \\n      \"$CITIZENSDK_FLUTTER_ROOT\" \"$PUB_CACHE\" \"$PATH\"\n  '\n"
  },
  "10": {
    "shell": "bash",
    "source": "profile=\"citizensdk-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-${CITIZENSDK_PLATFORM,,}\"\nif docker container inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker stop --time 20 \"$profile\"\n  docker rm \"$profile\"\nfi\nif test -f \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\" &&\n  sudo test -f /sys/kernel/security/apparmor/profiles &&\n  sudo grep -Fqx \"$profile (enforce)\" /sys/kernel/security/apparmor/profiles; then\n  sudo apparmor_parser -R -K \"$CITIZENSDK_WORK_DIR/tools/citizensdk.apparmor\"\nfi\nif docker image inspect \"$profile\" >/dev/null 2>&1; then\n  test \"$(docker image inspect --format '{{ index .Config.Labels \"org.citizensdk.run\" }}' \"$profile\")\" = \"$CITIZENSDK_ARTIFACT\"\n  docker image rm \"$profile\"\nfi\n"
  },
  "11": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" sanitize\nnode \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" record\n"
  },
  "12": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" prune"
  },
  "13": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" sanitize\nnode \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" record\n"
  },
  "14": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/ci/consume-linuxamd/execute.mjs\" prune"
  }
});

function runExactWorkflowStep(index) {
  requireExactRemoteJobEnvironment();
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(index || '')) || !Object.hasOwn(workflowSteps, String(index))) {
    throw new Error('准确远端Job阶段无效');
  }
  const step = workflowSteps[String(index)];
  const command = step.shell === 'pwsh' ? 'pwsh' : (process.platform === 'win32' ? 'bash' : '/bin/bash');
  const args = step.shell === 'pwsh'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', step.source]
    : ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.source];
  const result = runExactProcess(command, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (result.error) throw new Error('准确远端Job阶段无法启动');
  if (result.status !== 0) process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

async function main() {
  const command = process.argv[2];
  if (command === 'workflow-step') return runExactWorkflowStep(process.argv[3]);
  if (command === 'prepare') return prepare(process.env);
  if (command === 'wire') return wire(process.env);
  if (command === 'sanitize') return sanitize(process.env);
  if (command === 'record') return writeTerminalRecord(process.env);
  if (command === 'prune') return prune(process.env);
  throw new Error('用法：ci-cache.mjs <workflow-step|prepare|wire|sanitize|record|prune>');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
