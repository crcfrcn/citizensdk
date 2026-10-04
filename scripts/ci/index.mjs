#!/usr/bin/env node
// CI_BUILD: incremental

// citizensdk.sdk.ci 的正式动作入口；SDK 打包逻辑只调用产品唯一真源，目录不重复包装 sdk。
import { mkdtempSync, realpathSync, lstatSync, rmSync, writeFileSync, readdirSync, readFileSync, mkdirSync, symlinkSync, existsSync, copyFileSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
