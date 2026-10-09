#!/usr/bin/env node
// CI_BUILD: incremental

// citizensdk.sdk.ci 的正式动作入口；SDK 打包逻辑只调用产品唯一真源，目录不重复包装 sdk。
import { mkdtempSync, realpathSync, lstatSync, rmSync, writeFileSync, readdirSync, readFileSync, mkdirSync, symlinkSync, existsSync, copyFileSync, constants } from 'node:fs';
import { temporaryRoot } from '../build.mjs';
const tmpdir=()=>temporaryRoot('sdk','ci');
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const implementations = Object.freeze({});

const nativePlatforms = Object.freeze({ Android: ['android'], macOS: ['abi-host', 'apple', 'host'],
  LinuxARM: ['dependencies', 'linux'], LinuxAMD: ['dependencies', 'linux'], Windows: ['Windows', 'dependencies'] });
const nativeJobs = Object.freeze({ Android: 'android', macOS: 'apple', LinuxARM: 'linuxarm', LinuxAMD: 'linuxamd', Windows: 'windows' });
const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object'
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const safeNativePath = (value) => typeof value === 'string' && value.length <= 4096
  && value.split('/').every((part) => /^[A-Za-z0-9_.+@-]+$/u.test(part)
    && part !== '.' && part !== '..' && !/[ .]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));

// 传输证明绑定当前运行的五个作业；不是第二份 SDK 发布清单或归档格式。
export function validateNativeProof(proof, identity, platform) {
  if (!Object.hasOwn(nativePlatforms, platform)
      || !['ci', 'release'].includes(identity.action)
      || !/^[0-9a-f]{40}$/u.test(identity.sourceSha)
      || !/^\d+\.\d{1,2}\.\d{1,2}$/u.test(identity.softwareVersion)
      || typeof identity.runId !== 'string' || typeof identity.runAttempt !== 'string'
      || !/^[1-9]\d*$/u.test(identity.runId) || !/^[1-9]\d*$/u.test(identity.runAttempt)
      || !exactKeys(proof, ['source_sha', 'software_version', 'run_id', 'run_attempt', 'job', 'platforms', 'files'])
      || proof.source_sha !== identity.sourceSha || proof.software_version !== identity.softwareVersion
      || proof.run_id !== identity.runId || proof.run_attempt !== identity.runAttempt
      || proof.job !== `citizensdk_${identity.action}_sdk__${nativeJobs[platform]}`
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

export async function aggregateNativeArtifacts(options, environment = process.env) {
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
    const inspected = inspectNativeArchive(archive, 'native/phase0.json');
    const proof = JSON.parse(inspected.metadata);
    const expected = validateNativeProof(proof, identity, platform);
    const actual = inspected.files.filter((entry) => entry.path !== 'native/phase0.json').map(({ path, size, ...entry }) => ({ path: path.slice(7), ...entry }));
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
  const sdk = await import(pathToFileURL(checkedPath(join(repositoryRoot, 'scripts/release.mjs'), false)));
  mkdirSync(output, { mode: 0o700 });
  try {
    for (const { archive, inspected } of archives) {
      const extracted = inspectNativeArchive(archive, 'native/phase0.json', output);
      if (JSON.stringify(extracted) !== JSON.stringify(inspected)) throw new Error('CitizenSDK 原生归档在汇总期间发生变化');
    }
    const root = join(output, 'native');
    // 源码发布器负责完整依赖收据验真；本层额外绑定本次 CI/Release 动作，
    // 防止三份彼此一致的 CI 收据被整体冒充为全量 Release 输入。
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

export async function unpackCandidate({ inputPath, outputPath, sourceSha, softwareVersion }, environment = process.env) {
  const repositoryRoot = checkedPath(environment.GITHUB_WORKSPACE || process.cwd(), true);
  const input = checkedPath(inputPath, true), output = freshOutput(outputPath, repositoryRoot, input);
  if (!/^[0-9a-f]{40}$/u.test(sourceSha) || environment.CITIZENSDK_SOURCE_SHA !== sourceSha
      || !/^\d+\.\d{1,2}\.\d{1,2}$/u.test(softwareVersion)) throw new Error('CitizenSDK 最终候选身份无效');
  const names = ['citizensdk.tgz', 'citizensdk-release.json', 'SHA256SUMS', `citizen_sdk-${softwareVersion}.tar.gz`];
  if (JSON.stringify(readdirSync(input).sort()) !== JSON.stringify(names.sort())) throw new Error('CitizenSDK 候选 artifact 四文件闭集不一致');
  for (const name of names) checkedPath(join(input, name), false);
  const archive = join(input, 'citizensdk.tgz');
  const inspected = inspectNativeArchive(archive, 'citizensdk-release.json');
  if (inspected.metadata !== readFileSync(join(input, 'citizensdk-release.json'), 'utf8')) throw new Error('CitizenSDK 候选内外清单不一致');
  const manifest = JSON.parse(inspected.metadata);
  if (manifest.git_commit_sha !== sourceSha || manifest.software_version !== softwareVersion) throw new Error('CitizenSDK 候选版本或冻结 SHA 不一致');
  const sdk = await import(pathToFileURL(checkedPath(join(repositoryRoot, 'scripts/release.mjs'), false)));
  mkdirSync(output, { mode: 0o700 });
  try {
    const extracted = inspectNativeArchive(archive, null, output);
    if (JSON.stringify({ ...extracted, metadata: inspected.metadata }) !== JSON.stringify(inspected)) throw new Error('CitizenSDK 候选归档在解包期间发生变化');
    reconstructLinks(output, inspected.files, sdk.appleXcframeworkSymlinkContract(join(output, 'darwin/CitizenSDK.xcframework'), 'darwin/CitizenSDK.xcframework'));
    copyFileSync(join(input, 'SHA256SUMS'), join(output, 'SHA256SUMS'), constants.COPYFILE_EXCL);
    sdk.verifyCitizenSdkRelease(output, archive, sourceSha);
    return output;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

// 两个动作都只负责调用；SDK 候选算法只存在于冻结 checkout 中，不物化第二份源码。
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

export function sdkCommand(argumentsList, environment = process.env, cwd = process.cwd()) {
  const repositoryRoot = checkedPath(environment.GITHUB_WORKSPACE || cwd, true);
  const sourceRoot = checkedPath(repositoryRoot, true);
  const script = checkedPath(join(sourceRoot, 'scripts', 'release.mjs'), false);
  const values = new Map();
  if (argumentsList.length === 0 || argumentsList.length % 2 !== 0) {
    throw new Error('CitizenSDK 参数必须是完整键值对');
  }
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index], value = argumentsList[index + 1];
    if (typeof key !== 'string' || !/^--[a-z-]+$/u.test(key)
        || typeof value !== 'string' || !value || value.startsWith('--')
        || values.has(key)) throw new Error('CitizenSDK 参数为空、重复或格式无效');
    values.set(key, value);
  }
  // Hosted 仍由同一源码发布器执行；这里只验证准确参数和来源，不物化另一份打包器。
  const hosted = values.has('--hosted'), verifyHosted = values.has('--verify-hosted');
  const verify = values.has('--verify');
  const required = hosted ? ['--hosted', '--archive', '--output', '--dart', '--flutter', '--pub-cache']
    : verifyHosted ? ['--verify-hosted', '--archive', '--hosted-archive', '--output']
    : verify ? ['--verify', '--archive']
    : ['--source', '--native', '--output', '--archive', '--git-sha', '--software-version'];
  const allowed = new Set([...required, ...(verify || hosted || verifyHosted ? ['--expected-git-sha'] : [])]);
  if (required.some((key) => !values.has(key))
      || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error('CitizenSDK 动作参数不在生成/验真/Hosted 闭集');
  }
  if (hosted || verifyHosted) {
    for (const key of required) {
      const input = checkedPath(values.get(key), ['--hosted', '--verify-hosted', '--flutter', '--pub-cache', '--output'].includes(key), key === '--output');
      // 所有 Hosted 输入和输出均不得等于、包含或位于 checkout 的 SDK 源树。
      for (const [parent, child] of [[sourceRoot, input], [input, sourceRoot]]) {
        const path = relative(parent, child);
        if (path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path))) {
          throw new Error('CitizenSDK Hosted 路径与 checkout 源码交叠');
        }
      }
    }
  } else if (!verify) {
    const source = values.get('--source');
    if (source !== '.' && source.split(/[\\/]/u).some((part) => part === '.' || part === '..')
        || checkedPath(resolve(repositoryRoot, source), true) !== sourceRoot) {
      throw new Error('CitizenSDK --source 必须是当前 SDK checkout 根');
    }
  }
  const sha = values.get(verify || hosted || verifyHosted ? '--expected-git-sha' : '--git-sha');
  const frozen = environment.CITIZENSDK_SOURCE_SHA;
  if ((sha !== undefined && !/^[0-9a-f]{40}$/u.test(sha))
      || (frozen !== undefined && (!/^[0-9a-f]{40}$/u.test(frozen) || sha !== frozen))
      || (environment.GITHUB_ACTIONS === 'true' && !frozen)) {
    throw new Error('CitizenSDK Git SHA 必须对应当前冻结 checkout');
  }
  return { script, argumentsList: [...argumentsList], repositoryRoot };
}

export function runSdkCommand(command) {
  return new Promise((resolveResult, reject) => {
    const hosted = command.argumentsList.includes('--hosted');
    if (hosted && process.platform === 'win32') {
      reject(new Error('CitizenSDK Hosted 归档需要 POSIX 进程组监督'));
      return;
    }
    const environment = { ...process.env, CITIZENSDK_REPOSITORY_ROOT: command.repositoryRoot };
    // 不把 Node 预加载/搜索路径带入唯一源码脚本；不经过 shell 拼接参数。
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    const child = spawn(process.execPath, [command.script, ...command.argumentsList], {
      cwd: command.repositoryRoot, env: environment, stdio: hosted ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false, detached: process.platform !== 'win32',
    });
    let terminalCode = null;
    let escalation;
    let settled = false;
    let deadline;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', stop);
    };
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (hosted && error) {
        // 监督失败不删目录、不猜测内部 Dart PID；允许保留现场后有界返回。
        error.preserveHostedOutput = true;
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
      if (error) reject(error);
      else resolveResult(code);
    };
    const signal = (name) => {
      if (!child.pid) return;
      if (process.platform === 'win32') child.kill(name);
      else {
        try { process.kill(-child.pid, name); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const terminate = (name, code) => {
      if (settled || terminalCode !== null) return;
      terminalCode = code;
      if (hosted) {
        // 只通知发布器；由它停止独立 Dart/Pub 组并确认退出，不能五秒后强杀发布器。
        try { child.kill('SIGTERM'); }
        catch (error) { finish(error); return; }
        escalation = setTimeout(() => finish(new Error('CitizenSDK Hosted 监督器未确认退出，保留其工作目录')), 30000);
        return;
      }
      // OS 拒绝终止必须作为监督失败返回，不能从信号/定时器回调抛出未捕获异常。
      try { signal(name); }
      catch (error) { finish(error); return; }
      if (name !== 'SIGKILL') escalation = setTimeout(() => {
        try { signal('SIGKILL'); } catch (error) { finish(error); }
      }, 5000);
    };
    const interrupt = () => terminate('SIGTERM', 130);
    const stop = () => terminate('SIGTERM', 143);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', stop);
    deadline = setTimeout(() => {
      process.stderr.write('CitizenSDK 源码动作超时\n');
      terminate('SIGKILL', 124);
    }, 10 * 60 * 1000);
    if (hosted) {
      child.stdout.on('data', (chunk) => process.stdout.write(chunk));
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.stdout.on('error', () => terminate('SIGTERM', 1));
      child.stderr.on('error', () => terminate('SIGTERM', 1));
    }
    child.once('error', (error) => finish(error));
    child.once('close', async (code, childSignal) => {
      if (settled) return;
      clearTimeout(deadline);
      clearTimeout(escalation);
      try {
        // Hosted 的内部进程组只由发布器负责；本层只能核验自己的组，不替它宣称收尾。
        if (process.platform !== 'win32' && child.pid) {
          if (!hosted) signal('SIGKILL');
          const until = Date.now() + 5000;
          for (;;) {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              if (error.code === 'ESRCH') break;
              throw error;
            }
            if (Date.now() >= until) throw new Error('CitizenSDK 子进程组未确认退出');
            await new Promise((resume) => setTimeout(resume, 25));
          }
        }
        finish(null, terminalCode ?? code
          ?? ({ SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[childSignal] ?? 1));
      } catch (error) { finish(error); }
    });
  });
}

async function main() {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (command === 'aggregate-native' || command === 'unpack-candidate') {
    const names = command === 'aggregate-native'
      ? ['--input', '--output', '--git-sha', '--software-version', '--run-id', '--run-attempt', '--action']
      : ['--input', '--output', '--git-sha', '--software-version'];
    const values = new Map();
    for (let index = 0; index < argumentsList.length; index += 2) {
      const key = argumentsList[index], value = argumentsList[index + 1];
      if (!names.includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('CitizenSDK 传输参数无效');
      values.set(key, value);
    }
    if (values.size !== names.length) throw new Error('CitizenSDK 传输参数缺项');
    const options = { inputPath: values.get('--input'), outputPath: values.get('--output'),
      sourceSha: values.get('--git-sha'), softwareVersion: values.get('--software-version') };
    if (command === 'aggregate-native') await aggregateNativeArtifacts({ ...options,
      runId: values.get('--run-id'), runAttempt: values.get('--run-attempt'), action: values.get('--action') });
    else await unpackCandidate(options);
    return;
  }
  if (command === 'citizensdk-release') {
    process.exitCode = await runSdkCommand(sdkCommand(argumentsList));
    return;
  }
  if (!command || !Object.hasOwn(implementations, command)) {
    console.error('未登记动作子命令；允许值：citizensdk-release、' + Object.keys(implementations).join('、'));
    process.exitCode = 2;
    return;
  }
  // 原有版本/正式动作保持原实现，依赖包装只定位受控真实文件；不在此重建另一套合同。
  const repositoryRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'gmb-action-'));
  const implementationPath = join(temporaryDirectory, 'implementation.mjs');
  try {
    writeFileSync(implementationPath, implementations[command], { mode: 0o700 });
    const result = spawnSync(process.execPath, [realpathSync(implementationPath), ...argumentsList], {
      cwd: repositoryRoot,
      env: { ...process.env, CITIZENSDK_REPOSITORY_ROOT: repositoryRoot },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (!(process.env.NODE_TEST_CONTEXT && process.argv.length === 2) && !process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// CI 缓存身份、链接、恢复与收口只有这一份实现。
const ciCache = await (async()=>{
const { remoteEnvironment: productRemoteEnvironment } = await import('../build.mjs');
const { spawnSync: runExactProcess } = await import('node:child_process');
const { createHash } = await import('node:crypto');
const {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = await import('node:fs');
const {default: path} = await import('node:path');
const { pathToFileURL } = await import('node:url');

// 缓存身份使用固定语义前缀，不把内部实现误当成版本化协议。
const CI_CACHE_SCHEMA = 'ci';

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

function cacheIdentity(input) {
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

function cacheKeys(identity, runId, attempt) {
  const run = positiveInteger(runId, 'GitHub Run ID');
  const runAttempt = positiveInteger(attempt, 'GitHub Run Attempt');
  return Object.freeze({
    successPrefix: `${identity.baseKey}-success-`,
    failurePrefix: `${identity.baseKey}-failure-`,
    successKey: `${identity.baseKey}-success-${run}-${runAttempt}`,
    failureKey: `${identity.baseKey}-failure-${run}-${runAttempt}`,
  });
}

function parseCacheKey(identity, key) {
  const parsed = parseLogicalCacheKey(identity, key);
  return parsed?.toolchain === identity.toolchainFingerprint.slice(0, 16) ? parsed : null;
}

function parseLogicalCacheKey(identity, key) {
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

function selectLatestCache(identity, caches, state = 'success', ref = '') {
  if (!['success', 'failure'].includes(state)) throw new Error('缓存状态无效');
  const rows = recognizedCaches(identity, caches, ref, true)
    .filter((cache) => cache.state === state);
  rows.sort(compareCache);
  return rows.at(-1) ?? null;
}

function planCachePrune(identity, caches, ref = '') {
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

function cachePathPlan(identity, runnerTemp, entries) {
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

function wireCacheLinks(identity, runnerTemp, entries, workspace, links) {
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

function sanitizeCacheFinals(identity, runnerTemp, entries, finals) {
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
  environment = productRemoteEnvironment(environment);
  requireExactRemoteJobEnvironment();
  const identity = identityFromEnvironment(environment);
  const keys = cacheKeys(identity, environment.GITHUB_RUN_ID, environment.GITHUB_RUN_ATTEMPT);
  const paths = cachePathPlan(identity, environment.RUNNER_TEMP, environment.CI_CACHE_PATHS);
  const ref = required(environment.GITHUB_REF, 'GitHub Ref');
  const tokenValue = environment.GH_TOKEN || environment.GITHUB_TOKEN;
  return { identity, keys, paths, ref, tokenValue };
}

async function prepare(environment) {
  environment = productRemoteEnvironment(environment);
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
  environment = productRemoteEnvironment(environment);
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



function requireExactRemoteJobEnvironment(){if(process.env.GITHUB_REPOSITORY!=="crcfrcn/citizensdk")throw Error("准确远端Job仓库身份无效");}
return {CI_CACHE_SCHEMA,cacheIdentity,cacheKeys,parseCacheKey,parseLogicalCacheKey,selectLatestCache,planCachePrune,cachePathPlan,wireCacheLinks,sanitizeCacheFinals,prepare,wire,sanitize,writeTerminalRecord,prune};
})();
export const CI_CACHE_SCHEMA = ciCache.CI_CACHE_SCHEMA;
export const cacheIdentity = ciCache.cacheIdentity;
export const cacheKeys = ciCache.cacheKeys;
export const parseCacheKey = ciCache.parseCacheKey;
export const parseLogicalCacheKey = ciCache.parseLogicalCacheKey;
export const selectLatestCache = ciCache.selectLatestCache;
export const planCachePrune = ciCache.planCachePrune;
export const cachePathPlan = ciCache.cachePathPlan;
export const wireCacheLinks = ciCache.wireCacheLinks;
export const sanitizeCacheFinals = ciCache.sanitizeCacheFinals;
export async function runCacheCommand(command,environment=process.env){
 const actions={prepare:ciCache.prepare,wire:ciCache.wire,sanitize:ciCache.sanitize,record:ciCache.writeTerminalRecord,prune:ciCache.prune};
 if(!Object.hasOwn(actions,command))throw Error('CI缓存动作无效');return actions[command](environment);
}

// 正式实现结束；仅直接使用 node --test 执行本文件时注册以下回归。
if (process.env.NODE_TEST_CONTEXT && process.argv.length === 2 && !process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const {default:test}=await import('node:test');
const {default:assert}=await import('node:assert/strict');
test('CI缓存拒绝跨平台身份与不规范工作路径',()=>{
 const input={repository:'crcfrcn/citizensdk',product:'citizensdk',platform:'Android',architecture:'arm64',component:'native',runnerOs:'linux',runnerArch:'arm64',toolchainFingerprint:'a'.repeat(64)};
 const identity=cacheIdentity(input);assert.equal(parseCacheKey(identity,cacheKeys(identity,'1','1').successKey).state,'success');
 assert.equal(parseCacheKey(cacheIdentity({...input,platform:'macos'}),cacheKeys(identity,'1','1').successKey),null);
 assert.throws(()=>cachePathPlan(identity,'relative',[]));assert.throws(()=>cacheIdentity({...input,platform:'../android'}));
});
test('SDK调用入口在任何执行前拒绝未知动作和越界目录',()=>{
 assert.throws(()=>sdkCommand(['unknown']));
 assert.throws(()=>sdkCommand(['native','--source','relative']));
});

}
