import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, readdirSync,
  symlinkSync, rmSync, readlinkSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = message => { throw new Error('本仓工具交付：' + message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const definitions = Object.freeze({
  git: ['PRODUCT_GIT_BIN', /^git version 2\.54\.0\s*$/u],
  bash: ['PRODUCT_BASH_BIN', /^GNU bash, version 5\.3\.20\([1-9][0-9]*\)-release(?:\s|$)/u],
  grep: ['PRODUCT_GREP_BIN', /^grep \(GNU grep\) 3\.12\s*$/u],
  sed: ['PRODUCT_SED_BIN', /^sed \(GNU sed\) 4\.10\s*$/u],
});
const versions = Object.freeze({ git: '2.54.0', bash: '5.3.20', grep: '3.12', sed: '4.10' });
const sourceVersions = Object.freeze({...versions, actionlint:'1.7.12'});
const curlVersion = '8.5.0-2ubuntu10.15';
const curlDepends = 'libbrotli1 (>= 0.6.0), libc6 (>= 2.34), libgssapi-krb5-2 (>= 1.17), libidn2-0 (>= 2.0.0), libldap2 (>= 2.6.2), libnghttp2-14 (>= 1.50.0), libpsl5t64 (>= 0.16.0), librtmp1 (>= 2.3), libssh-4 (>= 0.9.0), libssl3t64 (>= 3.0.0), libzstd1 (>= 1.5.5), zlib1g (>= 1:1.1.4)';
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...names].sort().join('\0');

// 四个公开输入在使用前一起验证；相对路径、任何链接祖先与版本漂移都不能进入子进程。
export function exactExecutable(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path
    || /[\x00-\x1f]/u.test(path)) fail(label + '缺少规范绝对路径');
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || !(info.mode & 0o111)
    || realpathSync(path) !== path) fail(label + '必须是准确普通可执行文件');
  return path;
}

export function toolEnvironment(environment = process.env, execute = execFileSync) {
  const paths = Object.fromEntries(Object.entries(definitions).map(([id, [field]]) =>
    [field, exactExecutable(environment[field], id)]));
  const env = {
    HOME: environment.HOME, LANG: 'C', LC_ALL: 'C',
    ...paths, PATH: [...new Set([dirname(process.execPath), ...Object.values(paths).map(dirname)])].join(':'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  };
  for (const [id, [field, expected]] of Object.entries(definitions)) {
    const result = execute(paths[field], ['--version'], { env, encoding: 'utf8',
      timeout: 20_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const first = String(result).split(/\r?\n/u)[0];
    if (!expected.test(id === 'sed' && first.startsWith(paths[field] + ' (GNU sed)')
      ? 'sed' + first.slice(paths[field].length) : first)) fail(id + '版本与本仓唯一登记不符');
  }
  return Object.freeze(env);
}

export function validateToolSources(value) {
  if (!keys(value, ['sources', 'bootstrap']) || !keys(value.sources, Object.keys(sourceVersions))) fail('来源字段闭集无效');
  for (const [id, version] of Object.entries(sourceVersions)) {
    const record = value.sources[id];
    sourceMirrors(record);
    if (!keys(record, ['version', 'url', 'sha256', 'root', 'executable', 'upstream_patches', ...(['bash','grep','sed'].includes(id) ? ['mirrors'] : [])])
      || record.version !== version || !/^[a-f0-9]{64}$/u.test(record.sha256)
      || record.executable !== (id==='actionlint'?'actionlint':'bin/'+id)) fail('来源坐标无效：' + id);
    const expected = id === 'actionlint'
      ? ['https://github.com/rhysd/actionlint/releases/download/v'+version+'/actionlint_'+version+'_linux_amd64.tar.gz','.']
      : id === 'git'
      ? ['https://www.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz', 'git-2.54.0']
      : ['https://ftp.gnu.org/gnu/' + id + '/' + id + '-' + (id === 'bash' ? '5.3' : version)
        + (id === 'bash' ? '.tar.gz' : '.tar.xz'), id + '-' + (id === 'bash' ? '5.3' : version)];
    if (JSON.stringify([record.url, record.root]) !== JSON.stringify(expected)
      || !Array.isArray(record.upstream_patches)) fail('必须是准确官方来源：' + id);
    if (id !== 'bash' && record.upstream_patches.length !== 0 || id === 'bash' && record.upstream_patches.length !== 20) fail('官方补丁闭包不完整');
    for (const [i, patch] of record.upstream_patches.entries()) {
      if (!keys(patch, ['url', 'sha256', 'mirrors']) || !/^[a-f0-9]{64}$/u.test(patch.sha256)
        || patch.url !== 'https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-' + String(i + 1).padStart(3, '0')) fail('补丁顺序或官方坐标不符');
      sourceMirrors(patch);
    }
  }
  const bootstrap = value.bootstrap;
  if (!keys(bootstrap, ['platform', 'architecture', 'os', 'commands', 'packages', 'artifacts'])
    || bootstrap.platform !== 'linux' || bootstrap.architecture !== 'x64' || bootstrap.os !== '24.04'
    || !Array.isArray(bootstrap.commands) || !Array.isArray(bootstrap.packages)
    || !bootstrap.commands.length || !bootstrap.packages.length) fail('Ubuntu首次构建登记缺失');
  for (const record of bootstrap.commands) {
    if (!keys(record, ['name', 'path', 'package']) || !/^[a-z0-9_+.-]+$/u.test(record.name)
      || !/^\/usr\/(?:bin|lib\/llvm-18\/bin)\/[a-z0-9_+.-]+$/u.test(record.path)
      || !bootstrap.packages.some(p => p.name === record.package)) fail('首次构建命令没有准确官方包归属');
  }
  for (const record of bootstrap.packages) {
    if (!keys(record, ['name', 'version', 'source']) || !/^[a-z0-9+.-]+(?::amd64)?$/u.test(record.name)
      || !record.version || record.source !== 'https://packages.ubuntu.com/noble/' + record.name.split(':')[0]) fail('首次构建包登记无效');
  }
  if (new Set(bootstrap.commands.map(p => p.name)).size !== bootstrap.commands.length
    || new Set(bootstrap.packages.map(p => p.name)).size !== bootstrap.packages.length) fail('首次构建输入重复');
  validateCurlArtifacts(bootstrap.artifacts);
  return value;
}

// 官方Debian原件只负责本对象的curl开发输入；控制字段、来源和摘要闭集禁止漂移。
export function validateCurlArtifacts(records) {
  const expected = [
    ['libcurl4-openssl-dev', 446114, 'c63393dd39d8bc49580e3e23be3eda63ce62ae4823d95f692c7547b25ade8a31', 'libcurl4t64 (= ' + curlVersion + ')'],
    ['libcurl4t64', 343472, '02f8f39727a43d5a7057cba35cda866be00d929b91ea67ed02dd9d6402fa551c', curlDepends],
  ];
  if (!Array.isArray(records) || records.length !== expected.length) fail('curl官方原件闭包不完整');
  for (const [i, [name, size, digest, depends]] of expected.entries()) {
    const record = records[i];
    if (!keys(record, ['name', 'version', 'architecture', 'url', 'sha256', 'size', 'depends'])
      || record.name !== name || record.version !== curlVersion || record.architecture !== 'amd64'
      || record.size !== size || record.sha256 !== digest || record.depends !== depends
      || record.url !== 'https://archive.ubuntu.com/ubuntu/pool/main/c/curl/' + name + '_' + curlVersion + '_amd64.deb') fail('curl官方原件坐标不符');
  }
  return records;
}

export function validateCurlControl(record, source) {
  const fields = String(source).replace(/\r?\n$/u, '').split('\t');
  if (fields.length !== 5 || JSON.stringify(fields) !== JSON.stringify([
    record.name, record.version, record.architecture, record.depends, '',
  ])) fail('curl原件控制字段不符：' + record.name);
  return Object.freeze({ name: record.name, version: record.version, architecture: record.architecture,
    depends: record.depends, preDepends: '', origin: 'staged' });
}

function directory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path
    || !lstatSync(path).isDirectory()) fail('工作目录须为规范真实目录');
}

// 固定根包的现成内部依赖按dpkg声明闭包核验；不解析下载、不安装或升级软件包。
export function resolveBootstrapPackages(records, roots, compare, staged = []) {
  const installed=new Map(records.map(record=>[record.name,{...record,origin:'installed'}]));
  if(installed.size!==records.length)fail('Ubuntu包身份重复');
  if (new Set(staged.map(record=>record.name)).size !== staged.length) fail('curl原件身份重复');
  for (const record of staged) {
    if (record.origin !== 'staged' || Object.hasOwn(record, 'status')) fail('原件不得伪报系统安装状态');
    installed.set(record.name, record);
  }
  const ready = record => record && (record.origin === 'staged' || record.status === 'install ok installed');
  const selected=new Map(), queue=roots.map(root=>root.name);
  for(const root of roots) {
    const record=installed.get(root.name);
    if (!record) fail('官方Ubuntu根包缺失：' + root.name + '；预期=' + root.version + '；实际=缺失；状态=缺失');
    if (!ready(record)) fail('官方Ubuntu根包安装状态错误：' + root.name + '；预期=' + root.version + '；实际=' + record.version + '；状态=' + record.status);
    if (record.version !== root.version) fail('官方Ubuntu根包版本漂移：' + root.name + '；预期=' + root.version + '；实际=' + record.version + '；状态=' + (record.status || record.origin));
  }
  while(queue.length) {
    const name=queue.shift();if(selected.has(name))continue;
    const record=installed.get(name);
    if(!ready(record))fail('Ubuntu内部依赖没有完整交付：'+name);
    selected.set(name,record);
    for(const clause of [record.depends,record.preDepends].filter(Boolean).join(',').split(',').map(s=>s.trim()).filter(Boolean)) {
      let found;
      for(const alternative of clause.split('|')) {
        const match=/^([a-z0-9+.-]+)(?::(?:any|native|amd64))?(?:\s*\((<<|<=|=|>=|>>)\s*([^()\s]+)\))?$/u.exec(alternative.trim());
        if(!match)fail('Ubuntu内部依赖语法未支持');
        const candidate=installed.get(match[1]);
        if(ready(candidate)&&(!match[2]||compare(candidate.version,match[2],match[3]))) {
          found=match[1];break;
        }
      }
      if(!found)fail('Ubuntu内部依赖闭包缺失：'+clause);
      queue.push(found);
    }
  }
  return [...selected.values()].map(({name,version,origin})=>({name,version,origin})).sort((a,b)=>a.name.localeCompare(b.name));
}

// 仅独占的官方Ubuntu推送作业可首次构建；这是显式入口，不是正常门禁的系统回退。
export function verifyBootstrap(plan, environment = process.env, execute = execFileSync, staged = []) {
  if (process.platform !== plan.platform || process.arch !== plan.architecture
    || environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REPOSITORY !== 'crcfrcn/citizensdk'
    || environment.GITHUB_EVENT_NAME !== 'push' || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_JOB !== 'gate' || environment.GITHUB_WORKFLOW !== 'tatagate'
    || !/^ID=ubuntu$/mu.test(readFileSync('/etc/os-release', 'utf8'))
    || !/^VERSION_ID="24\.04"$/mu.test(readFileSync('/etc/os-release', 'utf8'))) fail('首次构建Runner身份不符');
  const query = exactExecutable('/usr/bin/dpkg-query', 'Ubuntu包身份入口');
  const dpkg = exactExecutable('/usr/bin/dpkg', 'Ubuntu包文件验真入口');
  const env = { PATH: '', HOME: environment.HOME, LANG: 'C', LC_ALL: 'C' };
  const run = (command, args) => String(execute(command, args, { env, encoding: 'utf8',
    timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const files = [];
  const installed=run(query,['-W','-f=${Package}\t${Architecture}\t${Status}\t${Version}\t${Depends}\t${Pre-Depends}\n'])
    .split('\n').filter(Boolean).map(line=>line.split('\t')).filter(row=>['amd64','all'].includes(row[1]))
    .map(([name,architecture,status,version,depends,preDepends])=>({name,status,version,depends,preDepends}));
  const packages=resolveBootstrapPackages(installed,[...plan.packages,...staged.map(({name,version})=>({name,version}))],(actual,op,expected)=>{
    try {execute(dpkg,['--compare-versions',actual,op,expected],{env,encoding:'utf8',timeout:20_000,stdio:['ignore','pipe','pipe']});return true;}
    catch(error){if(error.status===1)return false;throw error;}
  }, staged);
  for(const record of packages) if(record.origin === 'installed' && run(dpkg,['--verify',record.name])!=='')fail('Ubuntu包内部原件漂移：'+record.name);
  for (const record of plan.commands) {
    const path = exactExecutable(record.path, record.name);
    const owner = run(query, ['-S', path]);
    if (!owner.split('\n').some(line => line === record.package + ': ' + path
      || line === record.package + ':amd64: ' + path)) fail('命令不属于登记Ubuntu包：' + record.name);
    files.push({ ...record, sha256: sha256(readFileSync(path)) });
  }
  for (const path of ['/usr/include/expat.h', '/usr/include/zlib.h']) {
    const info = lstatSync(path); if (!info.isFile() || realpathSync(path) !== path) fail('登记Git开发输入缺失');
  }
  const clang = files.find(f => f.name === 'clang');
  if (!clang || !/^Ubuntu clang version 18\.1\.3(?:\s|$)/u.test(run(clang.path, ['--version']))) fail('编译器版本不符');
  return Object.freeze({commands:Object.freeze(files),packages:Object.freeze(packages)});
}

export async function fetchOriginal(record, destination, request = fetch) {
  let response;
  if (sourceMirrors(record).length === 3) {
    ({response} = await requestGNUOriginal(record, request));
  } else {
    const origin = new URL(record.url), allowed = new Set([origin.hostname]);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port) fail('官方原件来源必须是规范HTTPS');
    if (origin.hostname === 'github.com') for (const name of ['release-assets.githubusercontent.com','objects.githubusercontent.com']) allowed.add(name);
    if (origin.hostname === 'www.kernel.org') allowed.add('cdn.kernel.org');
    let url = origin;
    for (let i = 0; i < 4; i++) {
      response = await request(url.href, {redirect:'manual', credentials:'omit', signal:AbortSignal.timeout(120000)});
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) fail('官方原件重定向缺少目标');
        const target = new URL(location, url);
        if (target.protocol !== 'https:' || target.username || target.password || target.port || !allowed.has(target.hostname)) fail('官方原件重定向越界');
        url = target; response = null; continue;
      }
      if (!response.ok || response.url && response.url !== url.href) fail('官方原件读取失败');
      break;
    }
    if (!response) fail('官方原件重定向次数超限');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 128 * 1024 ** 2) fail('官方原件超限'); chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!size || record.size && size !== record.size || sha256(bytes) !== record.sha256) fail('官方原件摘要或大小不符');
  writeFileSync(destination, bytes, {flag:'wx', mode:0o444});
}


function inventory(root, at = root, directoryLinks = false) {
  const rows = [];
  for (const name of readdirSync(at).sort()) {
    const path = join(at, name), info = lstatSync(path), relative = path.slice(root.length + 1);
    if (info.isDirectory() && !info.isSymbolicLink()) rows.push(...inventory(root, path, directoryLinks));
    else if (info.isFile() && !info.isSymbolicLink()) rows.push({ path: relative, sha256: sha256(readFileSync(path)), mode: info.mode & 0o777 });
    else if(info.isSymbolicLink()) {
      const target=realpathSync(path);
      if(!target.startsWith(root+'/')||!(lstatSync(target).isFile() || directoryLinks && lstatSync(target).isDirectory()))fail('已交付工具包含越界链接');
      rows.push({path:relative,target:readlinkSync(path)});
    } else fail('已交付工具包含特殊文件');
  }
  return rows;
}

// 解包前读取tar真实头，拒绝绝对路径、父路径和链接逃逸；固定摘要不能替代路径边界检查。
export function validateCurlTar(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024 || bytes.length % 512) fail('curl原件tar长度无效');
  const names = new Set();
  for (let offset = 0; offset < bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      if (!bytes.subarray(offset).every(value => value === 0)) fail('curl原件tar尾部非法');
      return names;
    }
    const string = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
    const octal = (start, end) => {
      const value = string(start, end).trim();
      if (!/^[0-7]+$/u.test(value)) fail('curl原件tar数值无效');
      return Number.parseInt(value, 8);
    };
    const checksum = [...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (checksum !== octal(148, 156)) fail('curl原件tar头摘要无效');
    const prefix = string(257, 263) === 'ustar' ? string(345, 500) : '';
    const raw = (prefix ? prefix + '/' : '') + string(0, 100), type = string(156, 157) || '0';
    const name = raw === './' && type === '5' ? '.' : raw.replace(/^\.\//u, '').replace(/\/$/u, '');
    if (!['0','5','2','1'].includes(type) || name.startsWith('/') || /[\x00-\x1f]/u.test(name)
      || name.split('/').some(part => part === '..' || !part || part === '.') && !(name === '.' && type === '5')) fail('curl原件tar路径越界');
    if (type !== '5' && names.has(name)) fail('curl原件tar条目重复');
    names.add(name);
    if (type === '2' || type === '1') {
      const target = string(157, 257);
      const final = resolve('/payload', type === '2' ? dirname(name) : '.', target);
      if (!target || isAbsolute(target) || !final.startsWith('/payload/')) fail('curl原件tar链接越界');
    }
    const size = octal(124, 136);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > bytes.length) fail('curl原件tar正文缺失');
  }
  fail('curl原件tar缺少终结');
}

export async function stageCurlArtifacts({ work, artifacts, paths, run, request = fetch }) {
  validateCurlArtifacts(artifacts);
  const object = join(work, 'tools', 'curl'), payload = join(object, 'payload');
  mkdirSync(object); mkdirSync(payload);
  const staged = [], archives = [];
  for (const record of artifacts) {
    const archive = join(object, record.name + '.deb');
    await fetchOriginal(record, archive, request);
    const control = run(paths['dpkg-deb'], ['--show', '--showformat=${Package}\t${Version}\t${Architecture}\t${Depends}\t${Pre-Depends}\n', archive], object);
    staged.push(validateCurlControl(record, control));
    const tar = run(paths['dpkg-deb'], ['--fsys-tarfile', archive], object, { encoding: null });
    validateCurlTar(tar);
    // dpkg-deb只解包，不执行preinst/postinst或改写系统包数据库。
    run(paths['dpkg-deb'], ['--extract', archive, payload], object);
    archives.push({ path: archive, sha256: record.sha256 });
  }
  directory(payload);
  const include = join(payload, 'usr', 'include', 'x86_64-linux-gnu');
  const library = join(payload, 'usr', 'lib', 'x86_64-linux-gnu');
  for (const path of [join(include, 'curl', 'curl.h'), join(library, 'libcurl.so.4.8.0')]) {
    if (realpathSync(path) !== path || !lstatSync(path).isFile()) fail('curl原件开发输入缺失');
  }
  const protect = at => {
    for (const name of readdirSync(at)) {
      const path = join(at, name), info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) protect(path);
      else if (info.isFile() && !info.isSymbolicLink()) chmodSync(path, info.mode & 0o555);
    }
    chmodSync(at, 0o555);
  };
  inventory(payload, payload, true); protect(payload);
  const receipt = { artifacts, staged, files: inventory(payload, payload, true) };
  const receiptPath = join(object, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  chmodSync(object, 0o555);
  const verify = () => {
    directory(object); directory(payload);
    for (const archive of archives) if (sha256(readFileSync(archive.path)) !== archive.sha256) fail('curl原件归档漂移');
    if (JSON.stringify(inventory(payload, payload, true)) !== JSON.stringify(receipt.files)
      || readFileSync(receiptPath, 'utf8') !== JSON.stringify(receipt, null, 2) + '\n') fail('curl原件对象漂移');
  };
  verify();
  return Object.freeze({ staged, verify,
    flags: ['CURL_CFLAGS=-I' + include,
      'CURL_LDFLAGS=-L' + library + ' -Wl,-rpath,' + library + ' -lcurl',
      'CURL_CONFIG=' + paths.false] });
}

export async function prepareRunnerTools({ work, environment = process.env, request = fetch,
  execute = execFileSync, bootstrap = false } = {}) {
  if (bootstrap !== true) fail('缺少本次准确Ubuntu首次构建许可');
  const contract = JSON.parse(readFileSync(new URL('contracts.json', import.meta.url), 'utf8'));
  const plan = validateToolSources(contract.tool_sources);
  directory(work); directory(environment.RUNNER_TEMP);
  if (!work.startsWith(environment.RUNNER_TEMP + '/') || readdirSync(work).length) fail('工具必须使用Runner临时根下的独占空目录');
  const owned = lstatSync(work); let inputs = verifyBootstrap(plan.bootstrap, environment, execute);
  const paths = Object.fromEntries(inputs.commands.map(record => [record.name, record.path]));
  mkdirSync(join(work,'tools'));
  const bin = join(work, 'bootstrap-bin'); mkdirSync(bin);
  // 只把刚验真的登记命令交付给源码构建，不把系统目录加入PATH。
  for (const record of inputs.commands) symlinkSync(record.path, join(bin, record.name));
  symlinkSync(paths.bash, join(bin, 'sh'));
  const env = { HOME: work, TMPDIR: work, PATH: bin, LANG: 'C', LC_ALL: 'C',
    SHELL: paths.bash, CONFIG_SHELL: paths.bash, CC: paths.clang + ' --gcc-install-dir=/usr/lib/gcc/x86_64-linux-gnu/13', CXX: paths.clang + ' --driver-mode=g++ --gcc-install-dir=/usr/lib/gcc/x86_64-linux-gnu/13',
    AR: paths.ar, AS: paths.as, LD: paths.ld, NM: paths.nm, RANLIB: paths.ranlib,
    STRIP: paths.strip, MAKE: paths.make, CFLAGS: '-O2', CXXFLAGS: '-O2',
    PKG_CONFIG: 'false', PKG_CONFIG_LIBDIR: '', CONFIG_SITE: '', MAKEINFO: 'true', HELP2MAN: 'true' };
  const run = (command, args, cwd, options = {}) => execute(command, args, { cwd, env,
    encoding: 'utf8', timeout: 3_600_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const result = {};
  try {
    const curl = await stageCurlArtifacts({ work, artifacts: plan.bootstrap.artifacts, paths, run, request });
    inputs = verifyBootstrap(plan.bootstrap, environment, execute, curl.staged);
    for (const id of ['bash', 'grep', 'sed', 'git']) {
      const source = plan.sources[id], object = join(work, 'tools', id); mkdirSync(object);
      const archive = join(object, 'source.archive'); await fetchOriginal(source, archive, request);
      const unpack = join(object, 'unpack'); mkdirSync(unpack);
      const names = String(run(paths.tar, ['-tf', archive], object)).split('\n').filter(Boolean);
      if (!names.length || names.some(name => name.startsWith('/') || name.split('/').some(p => p === '..')
        || !(name === source.root || name.startsWith(source.root + '/')))) fail('源码归档根或路径越界');
      run(paths.tar, ['-xkf', archive, '--no-same-owner', '--no-same-permissions', '-C', unpack], object);
      const root = join(unpack, source.root); directory(root);
      // GNU发行件里的源码链接只允许留在此归档根中；不得写到工作根以外。
      const inspect = at => { for (const name of readdirSync(at)) {
        const path = join(at, name), info = lstatSync(path);
        if (info.isSymbolicLink()) { if (!realpathSync(path).startsWith(root + '/')) fail('源码链接越界'); }
        else if (info.isDirectory()) inspect(path);
        else if (!info.isFile()) fail('源码含特殊文件');
      } }; inspect(root);
      for (const [i, patch] of source.upstream_patches.entries()) {
        const file = join(object, 'bash53-' + String(i + 1).padStart(3, '0'));
        await fetchOriginal(patch, file, request);
        run(paths.patch, ['--batch', '--forward', '--fuzz=0', '-p0', '-i', file], root);
      }
      const payload = join(object, 'payload');
      if (id === 'git') {
        run(paths.make, ['-j2', 'CC=' + env.CC, 'AR=' + paths.ar,
          'NO_GETTEXT=YesPlease', 'NO_TCLTK=YesPlease', 'NO_PERL=YesPlease', 'NO_PYTHON=YesPlease',
          'NO_INSTALL_HARDLINKS=YesPlease', 'SHELL_PATH=' + result.PRODUCT_BASH_BIN,
          'SHELL=' + result.PRODUCT_BASH_BIN, ...curl.flags, 'prefix=' + payload, 'install'], root);
      } else {
        const flags = ['--prefix=' + payload, '--disable-nls'];
        if (id === 'bash') flags.push('--without-bash-malloc');
        if (id === 'grep') flags.push('--disable-perl-regexp');
        run(env.CONFIG_SHELL, [join(root, 'configure'), ...flags], root);
        run(paths.make, ['-j2', 'SHELL=' + env.CONFIG_SHELL], root);
        run(paths.make, ['install', 'SHELL=' + env.CONFIG_SHELL], root);
      }
      if (id === 'grep') for (const name of ['egrep', 'fgrep']) {
        const alias = join(payload, 'bin', name);
        const info = lstatSync(alias, {throwIfNoEntry:false});
        if (info) {if (!info.isFile() || info.isSymbolicLink()) fail('上游grep别名不是普通脚本');rmSync(alias);}
      }
      result[definitions[id][0]] = exactExecutable(join(payload, source.executable), id);
      if (id === 'bash') {
        env.CONFIG_SHELL = result.PRODUCT_BASH_BIN; env.SHELL = result.PRODUCT_BASH_BIN;
        env.PATH = dirname(result.PRODUCT_BASH_BIN) + ':' + bin;
      }
      // 源码、许可、上游补丁和产物一起留在当前作业的正式工具对象，回执覆盖全部文件。
      writeFileSync(join(object, 'receipt.json'), JSON.stringify({ source, bootstrap: inputs,
        files: inventory(payload) }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    }
    // Actionlint也只在当前验真输入仍有效的首次准备阶段解包，不再单独调用系统tar。
    const actionSource=plan.sources.actionlint, actionObject=join(work,'tools','actionlint');
    mkdirSync(actionObject);const actionArchive=join(actionObject,'source.archive');
    await fetchOriginal(actionSource,actionArchive,request);
    const names=String(run(paths.tar,['-tf',actionArchive],work)).trim().split('\n');
    if(names.filter(name=>name==='actionlint').length!==1)fail('官方检查器入口不是唯一归档条目');
    run(paths.tar,['-xkf',actionArchive,'--no-same-owner','--no-same-permissions','-C',actionObject,'actionlint'],work);
    const actionlint=exactExecutable(join(actionObject,'actionlint'),'Actionlint');
    const actionVersion=String(run(actionlint,['-version'],work)).split(/\r?\n/u)[0];
    if(actionVersion!=='1.7.12')fail('官方检查器版本不符');
    writeFileSync(join(actionObject,'receipt.json'),JSON.stringify({source:actionSource,
      bootstrap:inputs,files:inventory(actionObject)},null,2)+'\n',{flag:'wx',mode:0o444});
    // 同一精确包版本、开发输入和全部命令在整个编译阶段结束后再验一次。
    curl.verify();
    if(JSON.stringify(verifyBootstrap(plan.bootstrap,environment,execute,curl.staged))!==JSON.stringify(inputs))fail('首次构建输入在编译期间变化');
    const delivered = toolEnvironment({ ...environment, ...result }, execute);
    // 正常门禁只取得四个正式产物和Node；首次构建的系统入口不进入子进程PATH。
    rmSync(bin, { recursive: true });
    return Object.freeze({...delivered,TATAGATE_ACTIONLINT:actionlint});
  } catch (error) {
    const now = lstatSync(work);
    if (now.dev !== owned.dev || now.ino !== owned.ino) fail('工作根已被替换，保留现场');
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== 'prepare-runner' || process.argv[3] !== '--bootstrap') fail('命令须准确声明Runner首次构建');
    if (process.version !== 'v25.2.1') fail('Node版本不符');
    const env = await prepareRunnerTools({ work: process.argv[4], bootstrap: true });
    const output = exactExecutable(process.execPath, 'Node');
    directory(dirname(process.env.GITHUB_ENV));
    const info = lstatSync(process.env.GITHUB_ENV);
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(process.env.GITHUB_ENV) !== process.env.GITHUB_ENV) fail('Runner环境文件无效');
    const fields = [...Object.keys(definitions).map(id => definitions[id][0]),'TATAGATE_ACTIONLINT'];
    const contents = fields.map(field => field + '=' + env[field]).join('\n') + '\nPRODUCT_NODE_BIN=' + output + '\n';
    const { appendFileSync } = await import('node:fs'); appendFileSync(process.env.GITHUB_ENV, contents);
    process.stdout.write('本仓正式工具来源、版本及输入验真完成\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

// GNU原件仅使用规范来源与两份固定镜像；相同文件路径、顺序和摘要不得漂移。
export function sourceMirrors(record) {
  const selected = /^https:\/\/ftp\.gnu\.org\/gnu\/(?:bash\/bash-5\.3\.tar\.gz|grep\/grep-3\.12\.tar\.xz|sed\/sed-4\.10\.tar\.xz|bash\/bash-5\.3-patches\/bash53-(?:00[1-9]|01[0-9]|020))$/u.test(record?.url);
  if (!selected) {
    if (Object.hasOwn(record ?? {}, 'mirrors')) fail('未登记原件不能增加镜像');
    return [record.url];
  }
  const suffix = record.url.slice('https://ftp.gnu.org/gnu/'.length);
  const expected = ['https://mirrors.ocf.berkeley.edu/gnu/', 'https://mirror.csclub.uwaterloo.ca/gnu/'].map(base => base + suffix);
  if (!Array.isArray(record.mirrors) || JSON.stringify(record.mirrors) !== JSON.stringify(expected)
    || !/^[a-f0-9]{64}$/u.test(record.sha256)) fail('GNU镜像坐标、顺序或摘要无效');
  return [record.url, ...record.mirrors];
}

// 只在连接暂时失败或明确可重试的HTTP状态时换站；证书、越界和摘要失败仍立即终止。
export async function requestGNUOriginal(record, request = fetch, {signal, headers} = {}) {
  const addresses = sourceMirrors(record), allowed = new Set(addresses);
  if (addresses.length !== 3) fail('GNU获取缺少固定镜像闭集');
  const retryCodes = new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET',
    'ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN']);
  for (const [index, address] of addresses.entries()) {
    let url = address;
    for (let count = 0; count < 4; count++) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('GNU响应头等待超时', 'TimeoutError')), 12000);
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
      let response;
      try {
        response = await request(url, {redirect:'manual', credentials:'omit', signal:combined, ...(headers ? {headers} : {})});
      } catch (error) {
        signal?.throwIfAborted();
        if (index < addresses.length - 1 && (controller.signal.aborted || retryCodes.has(error?.cause?.code ?? error?.code))) break;
        throw error;
      } finally { clearTimeout(timer); }
      if (response.url && response.url !== url) fail('GNU响应来源漂移');
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) fail('GNU跳转缺少目标');
        const target = new URL(location, url).href;
        if (!allowed.has(target)) fail('GNU跳转越出登记坐标');
        if (count === 3) fail('GNU跳转次数超限');
        url = target; continue;
      }
      if ([404,408,429].includes(response.status) || response.status >= 500 && response.status <= 599) {
        await response.body?.cancel();
        if (index < addresses.length - 1) break;
        fail('GNU所有固定入口均不可用');
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); fail('GNU原件响应失败'); }
      return {response, url};
    }
  }
  fail('GNU原件获取失败');
}
