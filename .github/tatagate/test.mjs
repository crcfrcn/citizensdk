import {gateResourcePlan} from '../../scripts/resources.mjs';
import { toolEnvironment, exactExecutable, validateToolSources, prepareRunnerTools, resolveBootstrapPackages,
  validateCurlArtifacts, validateCurlControl, validateCurlTar, fetchOriginal } from './tools.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { gateContract, validateWorkflowSource, validateVectorGroup, validatePalletRegistry, readPublicChain } from './index.mjs';

// 本仓登记必须准确闭合；路径、重复和未知工具版本不得被默默接受。
test('本仓门禁登记拒绝漂移和重复', () => {
  const contract = structuredClone(gateContract());
  assert.equal(gateContract(contract), contract);
  for (const change of [
    value => { value.schema = 2; },
    value => { value.node_tests.push(value.node_tests[0]); },
    value => { value.node_tests = ['../outside.test.mjs']; },
    value => { value.tools.node = '0.0.0'; },
    value => { value.checks.push('undeclared'); },
    value => { value.workflows.push('other.ios.ci'); },
  ]) {
    const value = structuredClone(contract); change(value);
    assert.throws(() => gateContract(value));
  }
});
test('产品CI与Release仍只接受自己的三维手动入口', () => {
  const { repository } = gateContract();
  const id = repository + '.macos.ci';
  const workflow = 'name: ' + id + '\non:\n  workflow_dispatch:\nconcurrency:\n  group: ' + id
    + '\njobs:\n  flow:\n    steps:\n      - run: allowed=new Set(["' + id + '"])\n';
  assert.equal(validateWorkflowSource(workflow,repository+'-macos-ci.yml'),id);
  for (const invalid of [workflow.replace(repository+'.','other.'),workflow.replace('workflow_dispatch','push'),
    workflow.replace('group: '+id,'group: other'),workflow.replace('  flow:','  other:')]) {
    assert.throws(()=>validateWorkflowSource(invalid,repository+'-macos-ci.yml'));
  }
});
const group={ keys:['name'],values:['hex'],top:['domain'],complete:true };
const vectors={domain:'GMB',vectors:[{name:'a',hex:'AB'},{name:'b',hex:'CD'}]};
test('金标按语义键归一比较并阻断重复、缺项和漂移', () => {
  assert.equal(validateVectorGroup(vectors,{...vectors,vectors:[{name:'b',hex:'cd'},{name:'a',hex:'ab'}]},group),2);
  for (const mirror of [
    {...vectors,domain:'other'}, {...vectors,vectors:[vectors.vectors[0]]},
    {...vectors,vectors:[vectors.vectors[0],vectors.vectors[0]]},
    {...vectors,vectors:[{name:'a',hex:'EE'},vectors.vectors[1]]},
    {...vectors,vectors:[{name:'a'},vectors.vectors[1]]},
    {...vectors,vectors:[]},
  ]) assert.throws(()=>validateVectorGroup(vectors,mirror,group));
  assert.equal(validateVectorGroup(vectors,{...vectors,vectors:[vectors.vectors[0]]},{...group,complete:false}),1);
});
test('Pallet不得错指、为空或重复',()=>{
  const chain='#[runtime::pallet_index(1)]\n pub type Balances = PalletBalances;\n';
  assert.equal(validatePalletRegistry(chain,'static const int balancesPallet = 1;'),1);
  for (const dart of ['', 'static const int balancesPallet = 2;', 'static const int otherPallet = 1;',
    'static const int balancesPallet = 1;\nstatic const int balancesPallet = 1;']) {
    assert.throws(()=>validatePalletRegistry(chain,dart));
  }
  assert.throws(()=>validatePalletRegistry(chain+chain));
});
test('公开链真源只读准确SHA，拒绝main、网络、重定向、超限及伪造坐标',async()=>{
 const sha='a'.repeat(40),path='runtime/src/lib.rs';
 assert.equal(await readPublicChain(path,sha,async(url,options)=>{
  assert.equal(url,'https://raw.githubusercontent.com/crcfrcn/citizenchain/'+sha+'/'+path);
  assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);
  return new Response('source');
 }),'source');
 for(const [path,sha]of [[null,null],['../private','a'.repeat(40)],['runtime/src/lib.rs','main'],['runtime/src/lib.rs','a'.repeat(39)]]){
  await assert.rejects(readPublicChain(path,sha,()=>assert.fail('非法坐标禁止联网')));
 }
 for(const request of [async()=>{throw Error('synthetic network failure');},async()=>new Response('',{status:302}),async()=>new Response('',{status:404}),async()=>new Response(Buffer.alloc(2*1024**2+1)),async()=>new Response(new Uint8Array([255]))])await assert.rejects(readPublicChain(path,sha,request),/准确提交真源读取失败/u);
});

// 用隔离的合成Git提交验证门禁读取真实初始内容；不修改产品仓或调用仓库保存/推送。
test('保留源码不按每文件汉字数量判定，真实第一方临时注释仍拒绝', async () => {
  const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { join }, { testRoot: tmpdir }, { execFileSync }, { validateQuality }] = await Promise.all([
    import('node:fs'), import('node:path'), import('../../scripts/build.mjs'), import('node:child_process'), import('./index.mjs'),
  ]);
  const root = mkdtempSync(join(tmpdir(), 'tatagate-quality-'));
  const env = { ...toolEnvironment(), HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync(env.PRODUCT_GIT_BIN, ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--quiet', '--initial-branch=main');
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'test', 'example.test.mjs'), 'export const fixture = true;\n');
    const base = git('hash-object', '-w', '-t', 'tree', '/dev/null');
    for (const [source, rejected] of [
      ['export const value = 1;\n', false],
      ['// Retained implementation explanation.\nexport const value = 1;\n', false],
      ['// Generated file; do not edit.\nexport const value = 1;\n', false],
      ['// HACK: unfinished first-party implementation.\nexport const value = 1;\n', true],
    ]) {
      writeFileSync(join(root, 'source.mjs'), source);
      git('add', '--all');
      const head = git('commit-tree', git('write-tree'), '-m', 'synthetic quality input');
      git('update-ref', 'refs/heads/main', head);
      const run = () => validateQuality(root, base, head, gateContract().repository);
      if (rejected) await assert.rejects(run(), /第一方|产品实现代码保留临时注释/u);
      else await assert.doesNotReject(run());
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 候选文只作为合成测试数据；准确负向断言可识别，同文伪装和运行地址继续被阻断。
test('协议拒绝断言只归属本仓登记测试中的真实代码', async () => {
  const { protocolAssertionLines } = await import('./index.mjs');
  const path = gateContract().node_tests.find(value => /(?:test|tests)[./_-]/u.test(value) && value.endsWith('.mjs'));
  assert.ok(path);
  const statement = ['assert.doesNotMatch(source, /\\/', 'v', '1(?:\\/|\\b)/);'].join('');
  const line = '  ' + statement;
  assert.deepEqual(protocolAssertionLines(path, 'test(() => {\n' + line + '\n});\n'), [line]);
  assert.deepEqual(protocolAssertionLines(path, 'const matcher = /[\"\']+/u;\n' + line + '\n'), [line]);
  for (const source of [
    '/*\n' + line + '\n*/', '`\n' + line + '\n`', JSON.stringify(statement),
    '/*\n' + line + '\n*/\ntest(() => {\n' + line + '\n});',
    statement.replace('doesNotMatch', 'match'), statement.replace('source', 'other'),
    'const endpoint = "https://example.invalid/' + 'v' + '9";',
  ]) assert.deepEqual(protocolAssertionLines(path, source), []);
  assert.deepEqual(protocolAssertionLines('source.mjs', line), []);
  assert.deepEqual(protocolAssertionLines('unregistered.test.mjs', line), []);
});

// 执行本仓真实Shell增量防护，检查CLI/浏览器边界、拒绝断言、真实残留和大输入通道。
test('增量防护执行真实归属判断并支持超过argv单项限制的输入', async () => {
  const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { join, dirname }, { testRoot: tmpdir }, { execFileSync, spawnSync }, { checkGuardrails }] = await Promise.all([
    import('node:fs'), import('node:path'), import('../../scripts/build.mjs'), import('node:child_process'), import('./index.mjs'),
  ]);
  const root = mkdtempSync(join(tmpdir(), 'tatagate-guard-'));
  const env = { ...toolEnvironment(), HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync(env.PRODUCT_GIT_BIN, ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let output;
  const execute = (command, args, options) => {
    output = spawnSync(command, args, { ...options, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 20_000 });
    return output;
  };
  try {
    git('init', '--quiet', '--initial-branch=main');
    const base = git('hash-object', '-w', '-t', 'tree', '/dev/null');
    const testPath = gateContract().node_tests.find(value => /(?:test|tests)[./_-]/u.test(value) && value.endsWith('.mjs'));
    assert.ok(testPath);
    const statement = ['assert.doesNotMatch(source, /\\/', 'v', '1(?:\\/|\\b)/);'].join('');
    const log = ['console', '.log("result");\n'].join('');
    const unfinished = '// ' + ['TO', 'DO'].join('') + ': unfinished\n';
    const protocol = 'const endpoint = "https://example.invalid/' + 'v' + '9";\n';
    for (const [path, source, rejected, message] of [
      ['scripts/fixture.mjs', log, false],
      ['scripts/fixture.mjs', log + 'const known = "' + ['QR', '_V1'].join('').repeat(64000) + '";\n', false],
      ['scripts/fixture.mjs', log + 'const large = "' + 'x'.repeat(256 * 1024) + '";\n', false],
      ['scripts/fixture.mjs', 'const symbols = \"sqlite3_open_' + 'v' + '2 citizensdk_host_services_' + 'v' + '1_t chainSpec_' + 'v' + '1_genesisHash citizen/sdk/core/' + 'v' + '2\";\n', false],
      ['scripts/fixture.mjs', 'const symbol = \"citizensdk_host_services_' + 'v' + '2_t\";\n', true, '版本化标识'],
      ['scripts/fixture.mjs', 'const identities = '+ JSON.stringify(['citizenchain-wallet-password-'+'v'+'1.json', 'host_'+'v'+'1_layout_and_constants_are_exact', 'validate_public_store_'+'v'+'1', 'json-'+'v'+'1'].join(' '))+';\n', false],
      ['scripts/fixture.mjs', 'const unknown = \"validate_public_store_'+'v'+'2\";\n', true, '版本化标识'],
      ['lib/browser.js', log, true, '开发残留'],
      ['scripts/fixture.mjs', ['debug', 'ger;\n'].join(''), true, '开发残留'],
      ['scripts/fixture.mjs', 'const patch="// TODO upstream\\n/* FIXME text */";\nconst literal=/\\/\\/ XXX/;\n', false],
      ['scripts/fixture.mjs', 'const value=`// TODO text 1`;\n', false],
      ['scripts/fixture.mjs', 'const patch="// TODO text";\n'+unfinished, true, '开发残留'],
      ['scripts/fixture.mjs', unfinished, true, '开发残留'],
      [testPath, 'test(() => {\n  ' + statement + '\n});\n', false],
      [testPath, 'test(() => {\n  ' + statement + '\n});\n' + protocol, true, '版本化标识'],
      [testPath, '`\n  ' + statement + '\n`\n', true, '版本化标识'],
      ['scripts/resources.test.mjs', 'const index={'+['schema','version'].join('_')+':2,packages,git_sources:[],pods};\n', false],
      ['scripts/resources.test.mjs', 'const index={'+['schema','version'].join('_')+':2,packages,git_sources:[],pods};\n'+protocol, true, '版本化标识'],
      ['scripts/resources.test.mjs', 'const index={'+['schema','version'].join('_')+':3,packages,git_sources:[],pods};\n', true, '版本化标识'],
      ['scripts/fixture.mjs', 'const index={'+['schema','version'].join('_')+':2,packages,git_sources:[],pods};\n', true, '版本化标识'],
      ['unregistered.test.mjs', '  ' + statement + '\n', true, '版本化标识'],
    ]) {
      for (const entry of ['scripts', 'lib', 'test', 'unregistered.test.mjs']) rmSync(join(root, entry), { recursive: true, force: true });
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
      git('add', '--all');
      const head = git('commit-tree', git('write-tree'), '-m', 'synthetic guard input');
      git('update-ref', 'refs/heads/main', head);
      const run = () => checkGuardrails(root, { ...env, BASE_REF: base }, execute);
      if (rejected) {
        assert.throws(run, /增量防护未通过/u, path + ": " + source.slice(0, 180));
        assert.ok((output.stdout + output.stderr).includes(message));
      } else assert.doesNotThrow(run);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 门禁完整执行本仓真实测试；需要产物的用例由所属入口准备，不读取其它轮次生成状态。
test('编译及平台服务回归进入本仓门禁，原产品流程入口保持', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const read = path => readFileSync(new URL(path, root), 'utf8');
  const required = ["scripts/release.test.mjs"];
  for (const path of required) {
    assert.ok(read(path).length > 0);
    assert.ok(gateContract().node_tests.includes(path));
  }
  assert.match(read('scripts/ci/apple/execute.mjs'), /node --test.*scripts\/release[.]test[.]mjs/u);
  assert.match(read('scripts/release/apple/execute.mjs'), /node --test.*scripts\/release[.]test[.]mjs/u);
});

// 中文注释：固定基线恢复原始路径，只消费唯一编译映射，不改上游源码字节。
test('上游固定来源复用真实模块映射', async () => {
  const { smoldotUpstreamURL } = await import('./index.mjs');
  const { nativeCompilePath } = await import('../../scripts/release.mjs');
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../../native/smoldot/SOURCE_SHA256.json', import.meta.url), 'utf8'));
  const record = readFileSync(new URL('../../native/smoldot/UPSTREAM.md', import.meta.url), 'utf8');
  const path = 'native/smoldot/pow/lib/src/chain/chain_information_build.rs';
  assert.equal(nativeCompilePath(path), 'native/smoldot/pow/lib/src/chain/chain_information/build.rs');
  assert.match(smoldotUpstreamURL(path, manifest, record, nativeCompilePath), /\/lib\/src\/chain\/chain_information\/build[.]rs$/u);
  assert.throws(() => smoldotUpstreamURL(path + '.unknown', manifest, record, nativeCompilePath));
});

// 准确坐标、首次提交、唯一无父根和带父覆盖分别验证，防止历史清理扩大强推范围。
test('历史清理仅接受唯一无父新根并完整检查全部内容', async () => {
  const { pushBaseSHA } = await import('./index.mjs');
  const headSHA = 'a'.repeat(40), before = 'b'.repeat(40), empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const reset = { forced: true, before, headSHA, parents: headSHA, commitCount: '1' };
  assert.equal(pushBaseSHA({ forced: false, before, headSHA }), before);
  assert.equal(pushBaseSHA({ forced: false, before: '0'.repeat(40), headSHA }), empty);
  assert.equal(pushBaseSHA(reset), empty);
  for (const invalid of [
    { ...reset, parents: headSHA + ' ' + before }, { ...reset, commitCount: '2' },
    { ...reset, parents: '' }, { ...reset, forced: 'true' },
    { ...reset, before: 'main' }, { ...reset, headSHA: 'main' },
    { ...reset, headSHA: '0'.repeat(40) }, { ...reset, before: '0'.repeat(40) },
  ]) assert.throws(() => pushBaseSHA(invalid));
});

// 正常与拒绝边界共用公开交付函数；真实版本探测不继承用户预加载和系统PATH。
test('公开基础工具同时交付并拒绝缺失相对链接及错版本', async () => {
  const { mkdtempSync, symlinkSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { testRoot: tmpdir } = await import('../../scripts/build.mjs');
  const current = toolEnvironment();
  assert.equal(current.PRODUCT_GIT_BIN, process.env.PRODUCT_GIT_BIN);
  assert.ok(!current.PATH.split(':').some(path => ['/bin','/usr/bin','/usr/sbin','/sbin'].includes(path)));
  assert.equal(current.NODE_OPTIONS, undefined);
  const root = mkdtempSync(join(tmpdir(), 'tatagate-tool-'));
  try {
    const link = join(root,'git'); symlinkSync(current.PRODUCT_GIT_BIN,link);
    for (const path of [undefined, 'git', '/tmp/../git', link]) {
      assert.throws(() => toolEnvironment({...process.env,PRODUCT_GIT_BIN:path}), /本仓工具交付/u);
    }
    for (const field of ['PRODUCT_GIT_BIN','PRODUCT_BASH_BIN','PRODUCT_GREP_BIN','PRODUCT_SED_BIN']) {
      assert.throws(() => toolEnvironment({...process.env,[field]:process.execPath}), /版本/u);
    }
    assert.throws(() => exactExecutable(root,'directory'), /普通/u);
  } finally { rmSync(root,{recursive:true}); }
});
test('公开源码闭包拒绝补丁缺项错序及非官方来源，未授权不准备Runner', async () => {
  const original = structuredClone(gateResourcePlan());
  assert.equal(validateToolSources(original),original);
  for (const mutate of [
    value => value.sources.bash.upstream_patches.pop(),
    value => value.sources.bash.upstream_patches.reverse(),
    value => {value.sources.grep.url='https://example.invalid/grep.tar.xz';},
    value => {value.sources.sed.version='0.0';},
    value => {value.sources.git.sha256='broken';},
    value => {value.sources.actionlint.url='https://example.invalid/actionlint';},
    value => {value.sources.actionlint.executable='bin/actionlint';},
    value => {value.bootstrap.commands.push(value.bootstrap.commands[0]);},
  ]) {const value=structuredClone(original);mutate(value);assert.throws(()=>validateToolSources(value));}
  await assert.rejects(prepareRunnerTools(), /首次构建许可/u);
});

test('Ubuntu根包与内部依赖完整核验，缺项和漂移在构建前拒绝',()=>{
  const records=[
    {name:'compiler',version:'18.1.3',status:'install ok installed',depends:'runtime (= 18.1.3)',preDepends:''},
    {name:'runtime',version:'18.1.3',status:'install ok installed',depends:'libc (>= 2.39)',preDepends:''},
    {name:'libc',version:'2.39',status:'install ok installed',depends:'',preDepends:''},
    {name:'other',version:'1',status:'install ok installed',depends:'',preDepends:''},
  ], roots=[{name:'compiler',version:'18.1.3'}], compare=(a,op,b)=>op==='='?a===b:Number(a)>=Number(b);
  assert.deepEqual(resolveBootstrapPackages(records,roots,compare),[
    {name:'compiler',version:'18.1.3',origin:'installed'},{name:'libc',version:'2.39',origin:'installed'},{name:'runtime',version:'18.1.3',origin:'installed'}]);
  assert.throws(()=>resolveBootstrapPackages(records.slice(0,2),roots,compare),/闭包缺失/u);
  assert.throws(()=>resolveBootstrapPackages(records,[{name:'compiler',version:'18.1.4'}],compare),/版本漂移/u);
  assert.throws(()=>resolveBootstrapPackages([...records,records[0]],roots,compare),/身份重复/u);
  const changed=structuredClone(records);changed[1].version='18.1.2';
  assert.throws(()=>resolveBootstrapPackages(changed,roots,compare),/闭包缺失/u);
  assert.throws(()=>resolveBootstrapPackages([],roots,compare),/根包缺失.*compiler.*预期=18\.1\.3.*实际=缺失/u);
  assert.throws(()=>resolveBootstrapPackages([{...records[0],status:'deinstall ok config-files'}],roots,compare),/安装状态错误.*状态=deinstall/u);
  assert.throws(()=>resolveBootstrapPackages(records,[{name:'compiler',version:'18.1.4'}],compare),/预期=18\.1\.4.*实际=18\.1\.3/u);
});

// 两份固定Debian包不能伪报系统安装；开发包与runtime及现成内部依赖一起形成唯一来源闭包。
test('curl原件来源控制字段与staged依赖闭包准确拒绝漂移', () => {
  const artifacts = structuredClone(gateResourcePlan().bootstrap.artifacts);
  assert.equal(validateCurlArtifacts(artifacts), artifacts);
  for (const mutate of [
    value=>value.pop(), value=>value.reverse(), value=>value.push(value[0]),
    value=>{value[0].architecture='arm64';}, value=>{value[0].version='8.5.0';},
    value=>{value[0].sha256='0'.repeat(64);}, value=>{value[0].size++;},
    value=>{value[0].url='https://example.invalid/curl.deb';},
    value=>{value[0].depends='';}, value=>{value[0].extra=true;},
  ]) { const value=structuredClone(artifacts);mutate(value);assert.throws(()=>validateCurlArtifacts(value)); }
  const controls=artifacts.map(record=>[record.name,record.version,record.architecture,record.depends,''].join('\t')+'\n');
  const staged=artifacts.map((record,i)=>validateCurlControl(record,controls[i]));
  assert.equal(staged[0].origin,'staged');assert.equal(staged[0].status,undefined);
  for (const control of [controls[0].replace('amd64','arm64'),controls[0].replace(artifacts[0].version,'0'),controls[0]+'extra',controls[0].replace(/\t\n$/u,'\tother\n')]) {
    assert.throws(()=>validateCurlControl(artifacts[0],control),/控制字段/u);
  }
  const installed=artifacts[1].depends.split(',').map(clause=>({name:clause.trim().split(' ')[0],version:'99.0',status:'install ok installed',depends:'',preDepends:''}));
  const compare=(actual,op,expected)=>op==='='?actual===expected:actual==='99.0';
  const closure=resolveBootstrapPackages(installed,artifacts,compare,staged);
  assert.deepEqual(closure.filter(x=>x.origin==='staged').map(x=>x.name),['libcurl4-openssl-dev','libcurl4t64']);
  assert.equal(closure.filter(x=>x.origin==='installed').length,installed.length);
  assert.throws(()=>resolveBootstrapPackages(installed.slice(1),artifacts,compare,staged),/闭包缺失/u);
  assert.throws(()=>resolveBootstrapPackages(installed,artifacts,compare,[{...staged[0],status:'install ok installed'},staged[1]]),/伪报/u);
  assert.throws(()=>resolveBootstrapPackages(installed,artifacts,compare,[...staged,staged[0]]),/身份重复/u);
});

// 构造真实tar头与校验和，仅在内存验证路径和链接，不创建归档外文件或调用系统解包器。
test('curl原件tar在解包前拒绝越界链接非法头及截断', () => {
  const entry=(name,type='0',target='',body=Buffer.from('data'))=>{
    const header=Buffer.alloc(512);
    header.write(name,0,100);header.write('0000644\0',100,8);
    header.write(body.length.toString(8).padStart(11,'0')+'\0',124,12);
    header.fill(32,148,156);header.write(type,156,1);header.write(target,157,100);
    header.write('ustar\0',257,6);const sum=[...header].reduce((a,b)=>a+b,0);
    header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    return Buffer.concat([header,body,Buffer.alloc((512-body.length%512)%512)]);
  };
  const tar=(...entries)=>Buffer.concat([...entries,Buffer.alloc(1024)]);
  const root=entry('./','5','',Buffer.alloc(0));
  assert.ok(validateCurlTar(tar(root,entry('./usr/include/curl.h'))).has('usr/include/curl.h'));
  assert.ok(validateCurlTar(tar(entry('./usr/lib/libcurl.so','2','libcurl.so.4',Buffer.alloc(0)))).has('usr/lib/libcurl.so'));
  for(const value of [tar(entry('../outside')),tar(entry('/outside')),tar(entry('./usr/lib/link','2','../../../outside',Buffer.alloc(0))),
    tar(entry('./usr/lib/link','2','/outside',Buffer.alloc(0))),tar(entry('./a','x')),tar(entry('./a'),entry('./a')),
    Buffer.alloc(512),tar(entry('./a')).subarray(0,600)])assert.throws(()=>validateCurlTar(value));
  const corrupt=tar(entry('./a'));corrupt[0]^=1;assert.throws(()=>validateCurlTar(corrupt),/摘要/u);
});

test('固定原件读取保留摘要大小HTTPS重定向及失败约束', async () => {
  const {createHash}=await import('node:crypto');const {mkdtempSync,rmSync,readFileSync}=await import('node:fs');
  const {join}=await import('node:path');const {testRoot:tmpdir}=await import('../../scripts/build.mjs');
  const root=mkdtempSync(join(tmpdir(),'curl-original-')),bytes=Buffer.from('official fixture');
  const record={url:'https://archive.ubuntu.com/ubuntu/fixture',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  try {
    const destination=join(root,'original');await fetchOriginal(record,destination,async(_url,options)=>{assert.equal(options.redirect,'manual');return new Response(bytes);});
    assert.deepEqual(readFileSync(destination),bytes);
    await assert.rejects(fetchOriginal({...record,url:'http://archive.ubuntu.com/original'},join(root,'rejected'),async()=>assert.fail('非法来源不能联网')));
    for(const response of [new Response('wrong'),new Response('',{status:404}),new Response('',{status:302,headers:{location:'https://example.invalid/original'}}),
      new Response('',{status:302,headers:{location:'http://archive.ubuntu.com/original'}})]) {
      await assert.rejects(fetchOriginal(record,join(root,'rejected'),async()=>response));
    }
  } finally {rmSync(root,{recursive:true});}
});

// 两个镜像必须保持同一原件身份；只模拟响应，真实获取仍由正常入口完整验真。
test('GNU固定镜像的连接恢复摘要失败与来源闭集', async () => {
  const {sourceMirrors, requestGNUOriginal} = await import("./tools.mjs");
  const {fetchOriginal:readOriginal} = await import('./tools.mjs');
  const {mkdtempSync, readFileSync, existsSync, rmSync} = await import('node:fs');
  const {join} = await import('node:path'); const {testRoot:tmpdir} = await import('../../scripts/build.mjs');
  const {createHash} = await import('node:crypto');
  const bytes = Buffer.from('same locked GNU fixture'), file = 'bash/bash-5.3.tar.gz';
  const record = {url:'https://ftp.gnu.org/gnu/' + file,
    sha256:createHash('sha256').update(bytes).digest('hex'),
    mirrors:['https://mirrors.ocf.berkeley.edu/gnu/','https://mirror.csclub.uwaterloo.ca/gnu/'].map(base => base + file)};
  const addresses = sourceMirrors(record);
  assert.equal(addresses.length, 3);
  for (const mirrors of [undefined, [], record.mirrors.slice(0,1), [...record.mirrors].reverse(),
    [record.mirrors[0],record.mirrors[0]], record.mirrors.map(url => url.replace('https:', 'ht'+'tp:')),
    record.mirrors.map(url => url + '?unregistered=1'), ['https://other.invalid/' + file,record.mirrors[1]]]) {
    assert.throws(() => sourceMirrors({...record,mirrors}));
  }
  const calls = [];
  const connected = await requestGNUOriginal(record, async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual');
    if (calls.length === 1) throw Object.assign(new TypeError('fixture connection timeout'), {cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
    return new Response(bytes);
  });
  assert.deepEqual(calls, addresses.slice(0,2)); assert.deepEqual(Buffer.from(await connected.response.arrayBuffer()), bytes);
  const unavailable = [];
  await requestGNUOriginal(record, async url => {
    unavailable.push(url); return unavailable.length < 3 ? new Response(null,{status:503}) : new Response(bytes);
  });
  assert.deepEqual(unavailable, addresses);
  let tlsCalls = 0;
  await assert.rejects(requestGNUOriginal(record, async () => {tlsCalls++; throw Object.assign(Error('fixture invalid TLS'),{cause:{code:'CERT_HAS_EXPIRED'}});}));
  assert.equal(tlsCalls,1);
  let redirectCalls = 0;
  await assert.rejects(requestGNUOriginal(record, async () => {redirectCalls++; return new Response(null,{status:302,headers:{location:'https://other.invalid/original'}});}));
  assert.equal(redirectCalls,1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestGNUOriginal(record, () => assert.fail('取消不得联网'), {signal:controller.signal}));
  const root = mkdtempSync(join(tmpdir(),'gnu-mirror-'));
  try {
    const path = join(root,'original'); let attempts = 0;
    await readOriginal(record, path, async () => ++attempts === 1 ? new Response(null,{status:503}) : new Response(bytes));
    assert.equal(attempts,2); assert.deepEqual(readFileSync(path),bytes);
    let corrupted = 0; const rejected = join(root,'rejected');
    await assert.rejects(readOriginal({...record,sha256:'0'.repeat(64)}, rejected, async () => {corrupted++; return new Response(bytes);}));
    assert.equal(corrupted,1); assert.equal(existsSync(rejected),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

// awk等虚拟依赖必须由已安装真实包提供，闭包继续核验提供包自身的依赖与版本。
test('Ubuntu虚拟包按Provides核验，拒绝缺失、未安装与错误虚拟版本',()=>{
  const status='install ok installed',roots=[{name:'compiler',version:'1'}];
  const records=[{name:'compiler',version:'1',status,depends:'awk'},
    {name:'mawk',version:'99',status,provides:'awk',depends:'libc (>= 2)'},
    {name:'libc',version:'2',status}];
  const compare=(a,op,b)=>op==='='?a===b:op==='>='&&Number(a)>=Number(b);
  const names=rows=>resolveBootstrapPackages(rows,roots,compare).map(record=>record.name);
  assert.deepEqual(names(records),['compiler','libc','mawk']);
  assert.deepEqual(names([{...records[0],depends:'missing | awk:any'},...records.slice(1)]),['compiler','libc','mawk']);
  for(const rows of [records.slice(0,1),records.slice(0,2),
    [records[0],{...records[1],provides:''},records[2]],
    [records[0],{...records[1],status:'deinstall ok config-files'},records[2]],
    [records[0],{...records[1],provides:'awk (>= 2)'},records[2]],
    [records[0],{...records[1],provides:'awk, awk'},records[2]]])assert.throws(()=>names(rows));
  const versioned=[{...records[0],depends:'awk (>= 2)'},{...records[1],version:'1',provides:'awk (= 2)'},records[2]];
  assert.deepEqual(names(versioned),['compiler','libc','mawk']);
  assert.deepEqual(names([...versioned,{name:'awk',version:'1',status}]),['compiler','libc','mawk']);
  for(const provides of ['awk','awk (= 1)'])assert.throws(()=>names([versioned[0],{...records[1],provides},records[2]]));
  assert.throws(()=>resolveBootstrapPackages(records,[{name:'awk',version:'99'}],compare));
});

// 增量检查通过eval导入自身时argv仍指向文件；只有真实主入口才校验准备命令。
test('工具转发模块导入无副作用，真实门禁入口仍拒绝缺少准确参数',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const entry=fileURLToPath(new URL('./tools.mjs',import.meta.url));
  const source='await import((await import("node:url")).pathToFileURL(process.argv[1]).href);';
  const options={encoding:'utf8',timeout:10000,env:{PATH:'',NODE_OPTIONS:'',NODE_PATH:''}};
  for(const args of [['--input-type=module','-e',source,entry],['--input-type=module','--eval',source,entry],
    ['--input-type=module','--eval='+source,entry]]){
    const result=spawnSync(process.execPath,args,options);
    assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  }
  const direct=spawnSync(process.execPath,[fileURLToPath(new URL('./index.mjs',import.meta.url))],options);
  assert.equal(direct.error,undefined);assert.equal(direct.signal,null);assert.equal(direct.status,1);
  assert.match(direct.stderr,/本仓塔塔门禁参数或身份无效/u);
});

// Ubuntu官方dpkg-dev与debhelper可为同一虚拟名提供不同版本；每个版本须独立满足约束。
test('Ubuntu同名不同版本Provides保留，完全重复声明仍拒绝',()=>{
  const status='install ok installed',roots=[{name:'compiler',version:'1'}];
  const records=[{name:'compiler',version:'1',status,depends:'dpkg-build-api (= 1), debhelper-compat (= 13)'},
    {name:'dpkg-dev',version:'99',status,provides:'dpkg-build-api (= 0), dpkg-build-api (= 1)'},
    {name:'debhelper',version:'99',status,provides:'debhelper-compat (= 9), debhelper-compat (= 10), debhelper-compat (= 11), debhelper-compat (= 12), debhelper-compat (= 13)'}];
  const compare=(a,op,b)=>op==='='&&a===b;
  const names=rows=>resolveBootstrapPackages(rows,roots,compare).map(record=>record.name);
  for(const api of ['0','1'])for(const compat of ['9','10','11','12','13']){
    assert.deepEqual(names([{...records[0],depends:'dpkg-build-api (= '+api+'), debhelper-compat (= '+compat+')'},...records.slice(1)]),
      ['compiler','debhelper','dpkg-dev']);
  }
  for(const depends of ['dpkg-build-api (= 2)','debhelper-compat (= 14)'])assert.throws(()=>names([{...records[0],depends},...records.slice(1)]));
  for(const provides of ['dpkg-build-api (= 0), dpkg-build-api (= 0)',
    'dpkg-build-api (=0), dpkg-build-api (= 0)','dpkg-build-api, dpkg-build-api']){
    assert.throws(()=>names([records[0],{...records[1],provides},records[2]]));
  }
});

// 本仓target是唯一源码内生成边界；嵌套或链接旁路仍必须拒绝。
test('产品门禁允许自有根target并拒绝嵌套与链接输出', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { testRoot } = await import('../../scripts/build.mjs');
  const { assertNoProductOutputDirectories, gateContract } = await import('./index.mjs');
  const fixture = mkdtempSync(join(testRoot(), 'target-boundary-'));
  const root = join(fixture, 'source'), target = join(root, 'target');
  mkdirSync(root);
  try {
    mkdirSync(join(target, 'test', 'build'), { recursive: true });
    writeFileSync(join(target, 'test', 'build', 'generated.txt'), 'generated fixture');
    assert.doesNotThrow(() => assertNoProductOutputDirectories(root, gateContract().repository));
    const nested = join(root, 'source', 'target');
    mkdirSync(nested, { recursive: true });
    assert.throws(() => assertNoProductOutputDirectories(root, gateContract().repository), /生成状态目录/u);
    rmSync(join(root, 'source'), { recursive: true });
    rmSync(target, { recursive: true });
    const outside = join(fixture, 'outside'); mkdirSync(outside);
    symlinkSync(outside, target, 'dir');
    assert.throws(() => assertNoProductOutputDirectories(root, gateContract().repository), /生成状态目录/u);
    // 仅移除夹具链接自身，保留指向的普通目录，避免误清理目标。
    unlinkSync(target);
    writeFileSync(target, 'ordinary file');
    assert.throws(() => assertNoProductOutputDirectories(root, gateContract().repository), /生成状态目录/u);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

// 所属根文档验收只读本仓，负向夹具在本产品target内，不借其它仓库资料。
test('所属根技术文档拒绝缺失、空文件、链接、副本与错误文件类型', async () => {
  const { validateProductDocuments } = await import('./index.mjs');
  const { mkdtempSync, writeFileSync, unlinkSync, symlinkSync, mkdirSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { testRoot } = await import('../../scripts/build.mjs');
  const root = mkdtempSync(join(testRoot(), 'product-documents-'));
  const names = ["CitizenSDK.md"];
  try {
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    for (const name of names) writeFileSync(join(root, name), '产品技术文档\n');
    writeFileSync(join(root, 'README.md'), '产品简介\n');
    assert.equal(validateProductDocuments(root), true);
    const file = join(root, names[0]);
    writeFileSync(file, '');
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    unlinkSync(file); symlinkSync(join(root, 'README.md'), file);
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    unlinkSync(file); mkdirSync(file);
    assert.throws(() => validateProductDocuments(root), /根技术文档/u);
    rmSync(file, { recursive: true }); writeFileSync(file, '产品技术文档\n');
    writeFileSync(join(root, 'Extra.md'), '第二技术文档\n');
    assert.throws(() => validateProductDocuments(root), /额外技术文档/u);
    unlinkSync(join(root, 'Extra.md'));
    const readme = join(root, 'README.md'); unlinkSync(readme); symlinkSync(file, readme);
    assert.throws(() => validateProductDocuments(root), /非空普通原件/u);
    unlinkSync(readme); writeFileSync(readme, '产品简介\n');
    assert.equal(validateProductDocuments(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 文档迁出后保留同等资料扫描，测试只使用合成材料。
test('根技术文档机密扫描保留正文、令牌和转义快照拒绝', async () => {
  const { hasSecretMaterial } = await import('./index.mjs');
  const header = type => '-----BEGIN ' + type + 'PRIVATE KEY-----';
  const footer = type => '-----END ' + type + 'PRIVATE KEY-----';
  for (const type of ['', 'RSA ', 'EC ', 'OPENSSH ']) {
    const begin = header(type), end = footer(type);
    assert.equal(hasSecretMaterial('识别格式 ' + JSON.stringify(begin)), false);
    assert.equal(hasSecretMaterial(begin + '\\n\\(fixtureData.base64EncodedString())\\n' + end), false);
    const shaped = begin + '\n' + 'A'.repeat(96) + '\n' + end;
    assert.equal(hasSecretMaterial(shaped), true);
    assert.equal(hasSecretMaterial(shaped.replaceAll('\n', '\\n')), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ original: shaped })), true);
    const escaped = JSON.stringify({ original: shaped }).replace('BEGIN', '\\u0042EGIN');
    assert.equal(hasSecretMaterial(escaped), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ original: JSON.stringify(shaped).replace('BEGIN', '\\u0042EGIN') })), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ [shaped]: '合成键名' }).replace('BEGIN', '\\u0042EGIN')), true);
    const snapshot = '<!-- PATCH_DATA\n' + escaped + '\nPATCH_DATA -->';
    assert.equal(hasSecretMaterial(snapshot), true);
    assert.equal(hasSecretMaterial(begin + '\n' + 'A'.repeat(32)), true);
  }
  for (const [prefix, length] of [['AKIA', 16], ['github_pat_', 20], ['ghp_', 30], ['sk_live_', 16]]) {
    assert.equal(hasSecretMaterial(prefix + 'A'.repeat(length)), true);
    assert.equal(hasSecretMaterial(JSON.stringify({ example: prefix + 'A'.repeat(length) })), true);
  }
  assert.equal(hasSecretMaterial('格式说明，没有凭据正文'), false);
  assert.equal(hasSecretMaterial(header('') + '\nfixture-only\n' + footer('')), false);
  assert.throws(() => hasSecretMaterial('<!-- PATCH_DATA\n{}'), /快照结构/u);
  assert.throws(() => hasSecretMaterial('<!-- PATCH_DATA\ninvalid\nPATCH_DATA -->'), /快照结构/u);
  assert.throws(() => hasSecretMaterial(null), /输入必须/u);
});

// 真实资源只免除唯一官方归档字段；负向输入仍经完整Git跟踪文件扫描，现场归本产品。
test('官方Flutter归档字段不冒充旧平台标识，其它残留和伪造声明仍拒绝', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { testRoot } = await import('../../scripts/build.mjs');
  const { validatePlatformNaming } = await import('./index.mjs');
  const root = mkdtempSync(join(testRoot(), 'tatagate-platform-'));
  const gitBin = toolEnvironment().PRODUCT_GIT_BIN;
  const env = { ...toolEnvironment(), HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args) => execFileSync(gitBin, ['-C', root, ...args], { env, stdio: ['ignore','pipe','pipe'] });
  const source = readFileSync(new URL('../../scripts/resources.mjs', import.meta.url), 'utf8');
  const literal = source.match(/^const toolDefinitions=(\[.*\]);$/mu)[1];
  const tool = JSON.parse(literal).find(value => value.id === 'flutter');
  const legacy = ['macos','arm64'].join('_');
  const declaration = tools => 'const toolDefinitions=' + JSON.stringify(tools) + ';\n';
  try {
    git('init', '--quiet', '--initial-branch=main');
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, '.github', 'tatagate'), { recursive: true });
    const file = join(root, 'scripts', 'resources.mjs');
    writeFileSync(join(root, '.github', 'tatagate', 'contracts.json'), JSON.stringify(gateContract()));
    writeFileSync(file, source); git('add', '--all');
    assert.doesNotThrow(() => validatePlatformNaming(root));
    // 使用本仓真实补丁；即使伪造登记摘要，原上下文以外的旧平台文字仍须拒绝。
    const { createHash } = await import('node:crypto');
    const patch = JSON.parse(source.match(/^const flutterPatch=(".*");$/mu)[1]);
    const withPatch = (value, body=patch) => declaration([value]) + 'const flutterPatch=' + JSON.stringify(body) + ';\n';
    const altered = (change, metadata=()=>{}, refresh=false) => {
      const value=structuredClone(tool), body=change(patch);
      if (refresh) value.patch.sha256=createHash('sha256').update(body).digest('hex');
      metadata(value.patch);
      return withPatch(value,body);
    };
    writeFileSync(file, withPatch(tool));
    assert.doesNotThrow(() => validatePlatformNaming(root));
    const marker=['macos','arm64'].join(' ');
    const original=' /// ios device or '+marker+'.';
    for (const invalid of [
      altered(body=>body, value=>{value.source='https://example.invalid/commit/'+'a'.repeat(40);}),
      altered(body=>body, value=>{value.source=value.source.replace('https:','http:');}),
      altered(body=>body, value=>{value.source='https://github.com/flutter/flutter/commit/'+'0'.repeat(40);}),
      altered(body=>body, value=>{value.sha256='0'.repeat(64);}),
      altered(body=>body, value=>{value.path='other.patch';}),
      altered(body=>body, value=>{value.extra='unexpected';}),
      altered(body=>body+'\n'),
      altered(body=>body.replace('Future<void> lipoDylibs','Future<void> changed'),()=>{},true),
      altered(body=>body.replaceAll('native_assets_host.dart','other.dart'),()=>{},true),
      altered(body=>body.replace(original,'+/// ios device or '+marker+'.'),()=>{},true),
      altered(body=>body+'\n+// '+marker+'\n',()=>{},true),
      altered(body=>body+'\n'+body,()=>{},true),
      withPatch(tool)+'const flutterPatch='+JSON.stringify(patch)+';\n',
      withPatch(tool).replace('fixed source','fixed\\u0020source'),
      declaration([tool])+'const flutterPatch='+JSON.stringify(patch).slice(0,-1)+';\n',
      withPatch(tool)+'// '+marker+'\n',
    ]) {
      writeFileSync(file,invalid);
      assert.throws(() => validatePlatformNaming(root), /禁用平台命名/u);
    }
    writeFileSync(file, declaration([tool]));
    assert.doesNotThrow(() => validatePlatformNaming(root));
    const changed = change => { const value = structuredClone(tool); change(value); return declaration([value]); };
    for (const invalid of [
      changed(value => { value.archive.url = value.archive.url.replace('storage.googleapis.com','example.invalid'); }),
      changed(value => { value.archive.url = value.archive.url.replace('https:','http:'); }),
      changed(value => { value.version = '0.0.0'; }),
      changed(value => { value.archive.url = value.archive.url.replace('-stable.zip','-other.zip'); }),
      changed(value => { value.source = 'https://example.invalid/releases.json'; }),
      changed(value => { value.archive.root = 'other'; }),
      changed(value => { value.archive.executable = 'other'; }),
      changed(value => { value.title = legacy; }),
      changed(value => { value.archive.extra = legacy; }),
      declaration([tool, tool]),
      declaration([tool]) + declaration([tool]),
      declaration([tool]).replace('"version":', '"id":"other","version":'),
      declaration([tool]).replace('"flutter"', '"flutt\\u0065r"'),
      'const toolDefinitions=[invalid];\n// ' + legacy,
      declaration([tool]) + '// ' + legacy,
    ]) {
      writeFileSync(file, invalid);
      assert.throws(() => validatePlatformNaming(root), /禁用平台命名/u);
    }
    writeFileSync(file, declaration([tool]));
    const other = join(root, 'other.mjs');
    writeFileSync(other, declaration([tool])); git('add', '--all');
    assert.throws(() => validatePlatformNaming(root), /禁用平台命名/u);
    rmSync(other); git('add', '--all');
    for (const alias of gateContract().platform_forbidden_values) {
      writeFileSync(file, declaration([tool]) + '// ' + alias);
      assert.throws(() => validatePlatformNaming(root), /禁用平台命名/u);
    }
    writeFileSync(file, declaration([tool]));
    mkdirSync(join(root, legacy)); writeFileSync(join(root, legacy, 'source.mjs'), 'export const fixture=true;\n');
    git('add', '--all');
    assert.throws(() => validatePlatformNaming(root), /禁用平台目录/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// 用真实门禁函数检查登记与执行回执；这些用例在整项实现后统一运行。
test('本仓Git测试集合不得漏项、增项、重复或混入门禁自身', async () => {
  const { validateNodeInventory } = await import('./index.mjs');
  const paths = ['scripts/build.mjs', 'scripts/build.test.mjs', 'test/api.spec.mjs', '.github/tatagate/test.mjs'];
  const registered = ['scripts/build.test.mjs', 'test/api.spec.mjs'];
  assert.deepEqual(validateNodeInventory(paths, registered), registered);
  for (const listed of [registered.slice(1), [...registered, 'missing.test.mjs'], [...registered, registered[0]], []]) {
    assert.throws(() => validateNodeInventory(paths, listed));
  }
  assert.throws(() => validateNodeInventory([...paths, 'scripts/new.test.mjs'], registered));
  assert.throws(() => validateNodeInventory([...paths, paths[0]], registered));
});
test('成功退出但零用例、失败、取消或跳过不能作为完整测试回执', async () => {
  const { successfulTestSummary } = await import('./index.mjs');
  const counts = { tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
  assert.equal(successfulTestSummary({ success: true, counts }), true);
  for (const change of [{ tests: 0 }, { passed: 0 }, { failed: 1 }, { skipped: 1 }, { todo: 1 }, { cancelled: 1 }]) {
    assert.equal(Boolean(successfulTestSummary({ success: true, counts: { ...counts, ...change } })), false);
  }
  assert.equal(Boolean(successfulTestSummary({ success: false, counts })), false);
  assert.equal(Boolean(successfulTestSummary({ success: true })), false);
});
test('资源中的注释文本与正则字面量不是第一方代码注释', async () => {
  const { commentText, hasFirstPartyTemporaryComments } = await import('./index.mjs');
  const source = 'const patch = "// TODO upstream\\n/* FIXME original */";\nconst literal = /\\/\\/ XXX/;\n// 正常中文实现说明\n';
  assert.equal(hasFirstPartyTemporaryComments('scripts/resources.mjs', source), false);
  assert.match(commentText('module.mjs', source), /正常中文实现说明/u);
  assert.equal(hasFirstPartyTemporaryComments('module.mjs', source + '// TODO first party\n'), true);
  assert.equal(hasFirstPartyTemporaryComments('module.rs', 'let raw = r##"// TODO raw"##;\n// 中文说明\n'), false);
  assert.equal(hasFirstPartyTemporaryComments('module.rs', "fn bind<'a>() {} // FIXME actual\n"), true);
});

// 真实词法和消费者闭合，模板表达式中的真实注释仍参与检查。
test('注释检查区分模板正文、模板表达式、Python文串和真实行尾注释',async()=>{
 const {hasFirstPartyTemporaryComments}=await import('./index.mjs');
 assert.equal(hasFirstPartyTemporaryComments('module.mjs','const value=`// TODO text ${1}`;'),false);
 assert.equal(hasFirstPartyTemporaryComments('module.mjs','const value=`text ${(()=>{ // FIXME actual\n return 1; })()}`;'),true);
 assert.equal(hasFirstPartyTemporaryComments('module.py','value="""# TODO text"""\nvalue=1 # FIXME actual\n'),true);
 assert.equal(hasFirstPartyTemporaryComments('module.py','value="""# TODO text"""\n'),false);
});
// 使用真实Node运行器和实际门禁Reporter；不以伪造汇总对象代替最终执行回执。
test('实际NodeReporter拒绝漏文件、零用例、跳过和失败',async()=>{
 const [{mkdtempSync,writeFileSync,rmSync},{join},{testRoot},{spawnSync},{fileURLToPath}]=await Promise.all([import('node:fs'),import('node:path'),import('../../scripts/build.mjs'),import('node:child_process'),import('node:url')]);
 const work=mkdtempSync(join(testRoot(),'gate-reporter-')),file=join(work,'case.test.mjs'),reporter=fileURLToPath(new URL('./index.mjs',import.meta.url));
 try{
  for(const [body,extra,success]of [
   ['import test from "node:test";test("正常夹具",()=>{});',[],true],
   ['export const noTests=true;',[],false],
   ['import test from "node:test";test.skip("跳过夹具",()=>{});',[],false],
   ['import test from "node:test";test("失败夹具",()=>{throw Error("synthetic failure")});',[],false],
   ['import test from "node:test";test("漏项夹具",()=>{});',[join(work,'missing.test.mjs')],false],
  ]){
   // 子Node必须是独立运行器；保留产品工具输入，只移除父运行器的内部测试上下文。
   const childEnvironment={...process.env,TATAGATE_NODE_TESTS:JSON.stringify([file,...extra])};delete childEnvironment.NODE_TEST_CONTEXT;
   writeFileSync(file,body);const result=spawnSync(process.execPath,['--test','--test-reporter='+reporter,file],{env:childEnvironment,encoding:'utf8',timeout:30000,maxBuffer:2*1024**2});
   assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status===0,success,result.stdout+result.stderr);
  }
 }finally{rmSync(work,{recursive:true,force:true});}
});

test('实际语言回执拒绝零用例、跳过、失败及不完整终态',async()=>{
 const {validateLanguageResult}=await import('./index.mjs');
 const vitest={success:true,numTotalTests:2,numPassedTests:2,numFailedTests:0,numPendingTests:0,numTodoTests:0};assert.equal(validateLanguageResult('vitest',JSON.stringify(vitest)),true);
 for(const change of [{numTotalTests:0,numPassedTests:0},{numPassedTests:1},{numPendingTests:1},{success:false}])assert.throws(()=>validateLanguageResult('vitest',JSON.stringify({...vitest,...change})));
 const flutter=JSON.stringify({type:'testDone',result:'success',skipped:false,hidden:false})+'\n'+JSON.stringify({type:'done',success:true});assert.equal(validateLanguageResult('flutter',flutter),true);
 for(const invalid of ['',JSON.stringify({type:'done',success:true}),flutter.replace('"skipped":false','"skipped":true'),flutter.replace('"success":true','"success":false')])assert.throws(()=>validateLanguageResult('flutter',invalid));
 assert.equal(validateLanguageResult('cargo','test result: ok. 2 passed; 0 failed; 0 ignored;'),true);
 for(const invalid of ['', 'test result: ok. 0 passed; 0 failed; 0 ignored;', 'test result: ok. 2 passed; 0 failed; 1 ignored;'])assert.throws(()=>validateLanguageResult('cargo',invalid));
});

test('代码变化必须同步所属文档与非空回归差异',async()=>{
 const {validateChangeEvidence}=await import('./index.mjs');
 assert.equal(validateChangeEvidence(['src/main.mjs','Owned.md','scripts/main.test.mjs'],['Owned.md']),true);
 assert.equal(validateChangeEvidence(['Owned.md'],['Owned.md']),true);
 for(const paths of [['src/main.mjs'],['src/main.mjs','Owned.md'],['src/main.mjs','Foreign.md','scripts/main.test.mjs']])assert.throws(()=>validateChangeEvidence(paths,['Owned.md']));
 assert.throws(()=>validateChangeEvidence(['src/main.mjs','Owned.md','scripts/main.test.mjs'],['Owned.md'],{changed:path=>path!=='Owned.md'}));
});

// 调用真实结果核验接口；合成协议事件仅验证核验器，不能作为产品功能通过证据。
test('功能映射必须闭合，拒绝遗漏类型、重复来源和路径越界',async()=>{
 const {validateFunctionalContract,gateContract}=await import('./index.mjs');const list=structuredClone(gateContract().functions);
 assert.equal(validateFunctionalContract(list),true);
 for(const invalid of [[],[...list,list[0]],list.map((item,index)=>index?item:{...item,path:'../foreign.test.mjs'}),list.map((item,index)=>index?item:{...item,target:'/foreign/Cargo.toml'}),list.map((item,index)=>index?item:{...item,runner:'skip'}),list.map((item,index)=>index?item:{...item,unknown:true})])assert.throws(()=>validateFunctionalContract(invalid));
 const value=structuredClone(gateContract());value.functions=value.functions.filter(item=>item.path!==value.node_tests[0]);assert.throws(()=>gateContract(value));
});
test('Vitest必须逐一完成本仓具名文件，错路径、漏跑和重复结果均拒绝',async()=>{
 const {functionalFiles}=await import('./index.mjs');const root='/owned/source',paths=['test/one.test.ts','test/two.test.ts'];
 const suite=name=>({name:root+'/'+name,assertionResults:[{status:'passed'}]}),value={success:true,numTotalTests:2,numPassedTests:2,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:paths.map(suite)};
 assert.deepEqual(functionalFiles('vitest',JSON.stringify(value),paths,[root]),paths.map(path=>({path,tests:1})));
 for(const change of [{testResults:[suite(paths[0])]},{testResults:[suite(paths[0]),suite(paths[0])]},{testResults:[suite(paths[0]),{...suite(paths[1]),name:'/foreign/'+paths[1]}]},{testResults:[suite(paths[0]),{...suite(paths[1]),assertionResults:[]}]},{testResults:[suite(paths[0]),{...suite(paths[1]),assertionResults:[{status:'skipped'}]}]}])assert.throws(()=>functionalFiles('vitest',JSON.stringify({...value,...change}),paths,[root]));
});
test('Flutter加载事件不能代替实际用例，每个本仓套件均需成功',async()=>{
 const {functionalFiles}=await import('./index.mjs');const path='test/feature_test.dart',events=[{type:'suite',suite:{id:1,path:'/owned/source/'+path}},{type:'testStart',test:{id:1,suiteID:1,name:'真实协议夹具',hidden:false}},{type:'testDone',testID:1,hidden:false,result:'success',skipped:false},{type:'done',success:true}];
 const text=value=>value.map(row=>JSON.stringify(row)).join('\n');
 assert.deepEqual(functionalFiles('flutter',text(events),[path],['/owned/source']),[{path,tests:1}]);
 for(const value of [events.filter(item=>item.type!=='testDone'),events.map(item=>item.type==='testDone'?{...item,skipped:true}:item),events.map(item=>item.type==='suite'?{...item,suite:{...item.suite,path:'/foreign/'+path}}:item),[events[0],events[1],events[2],events[2],events[3]]])assert.throws(()=>functionalFiles('flutter',text(value),[path],['/owned/source']));
 assert.throws(()=>functionalFiles('flutter',text(events),[path,'test/missing_test.dart'],['/owned/source']));
});
test('Rust功能结果必须属于准确包，完整摘要不等于具名用例执行',async()=>{
 const {functionalRustCases}=await import('./index.mjs'),items=[{path:'src/auth.rs',package:'owned-package',cases:['reject_expired']},{path:'tests/boundary.rs',package:'owned-package',cases:['reject_foreign']}];
 const value='test auth::reject_expired ... ok\ntest reject_foreign ... ok\ntest result: ok. 2 passed; 0 failed; 0 ignored;';
 assert.deepEqual(functionalRustCases(value,items),items.map(item=>({path:item.path,cases:item.cases})));
 for(const invalid of [value.replace('test reject_foreign ... ok\n',''),value.replace('0 ignored','1 ignored'),value.replace('2 passed','0 passed')])assert.throws(()=>functionalRustCases(invalid,items));
 assert.throws(()=>functionalRustCases(value,[items[0],{...items[1],package:'foreign-package'}]));
 assert.throws(()=>functionalRustCases(value,[items[0],{...items[1],cases:['reject_expired']} ]));
});

// 固定协调参数不承载产品产物；目录身份及空状态必须真实验证。
test('门禁请求协调目录拒绝相对、源码和无效目录',async()=>{
 const {validateGateRequestWork}=await import('./index.mjs');
 assert.throws(()=>validateGateRequestWork('/owned/source','relative/work'));
 assert.throws(()=>validateGateRequestWork('/owned/source','/nonexistent/owned/gate-work'));
});

// 回读本仓实际已跟踪测试来源；完整映射不可空跑、漏登记或混入不存在的入口。
test('本仓真实功能源码清单与登记准确闭合',async()=>{
 const [{validateFunctionalInventory},{fileURLToPath}]=await Promise.all([import('./index.mjs'),import('node:url')]);
 const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/u,'');
 assert.equal(validateFunctionalInventory(root).length,gateContract().functions.length);
 assert.throws(()=>validateFunctionalInventory(root,gateContract().functions.slice(1)),/本仓功能测试存在遗漏/u);
 assert.throws(()=>validateFunctionalInventory(root,[...gateContract().functions,{function:'不存在的入口',path:'missing.test.mjs',runner:'node',target:'.'}]),/本仓功能测试存在遗漏/u);
});

// 精确供给字段例外不能扩展为任意协议、源文件或字符串豁免。
test('依赖供给索引只识别固定夹具的真实字段且保留其它版本标识', async () => {
 const {dependencySupplySchemaLines}=await import('./index.mjs');
 const field=['schema','version'].join('_'), path='scripts/resources.test.mjs';
 const fragments=[
  'JSON.stringify({'+field+':2,packages:[{archives:[{...entry,sha256:digest}]}],git_sources:[],pods:[]})',
  'const index={'+field+':2,packages,git_sources:[],pods};',
  '{'+field+':1,packages:[],git_sources:[],snapshots:[]}',
 ];
 for(const fragment of fragments){
  const source='const fixture = '+fragment+'\n';
  assert.deepEqual(dependencySupplySchemaLines(path,source),[[source.trimEnd(),source.trimEnd().replace(field,'supply_schema')]]);
  for(const text of ['// '+source,'/* '+source+' */',JSON.stringify(source),'`'+source+'`'])assert.deepEqual(dependencySupplySchemaLines(path,text),[]);
  for(const other of ['source.mjs','unregistered.test.mjs','.github/tatagate/test.mjs'])assert.deepEqual(dependencySupplySchemaLines(other,source),[]);
  assert.deepEqual(dependencySupplySchemaLines(path,source.replace(field+':2',field+':3').replace(field+':1',field+':3')),[]);
 }
 const unknown='const protocol = "example-'+'v'+'9";';
 assert.ok(dependencySupplySchemaLines(path,fragments[1]+unknown)[0][1].endsWith(unknown));
});

// 正常所有者与越界、别名、链接、错误工作区、非空目录都使用真实路径验证；不编译或下载工具。
test('Ubuntu工具工作根绑定真实SDK及既有target/test，不依赖Runner临时根',async()=>{
 const {runnerWork}=await import('./tools.mjs');
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,unlinkSync,lstatSync}=await import('node:fs');
 const {join,resolve}=await import('node:path');
 const root=resolve(import.meta.dirname,'../..'),target=join(root,'target');
 const inode=lstatSync(target).ino,parent=join(target,'test');mkdirSync(parent,{recursive:true});
 const work=mkdtempSync(join(parent,'runner-owner-')),outside=mkdtempSync(join(target,'runner-outside-'));
 try{
  assert.equal(runnerWork(work,{GITHUB_WORKSPACE:root,RUNNER_TEMP:outside}),work);
  assert.equal(runnerWork(work,{}),work);
  for(const path of [outside,parent,root,'relative',work+'/../'+work.split('/').at(-1)])assert.throws(()=>runnerWork(path,{GITHUB_WORKSPACE:root}),/工作根/u);
  assert.throws(()=>runnerWork(work,{GITHUB_WORKSPACE:outside}),/工作根/u);
  const link=join(parent,work.split('/').at(-1)+'-link');symlinkSync(work,link);
  try{assert.throws(()=>runnerWork(link,{GITHUB_WORKSPACE:root}),/工作根/u);}finally{unlinkSync(link);}
  writeFileSync(join(work,'marker'),'retained');assert.throws(()=>runnerWork(work,{GITHUB_WORKSPACE:root}),/工作根/u);
  assert.equal(lstatSync(target).ino,inode);
 }finally{rmSync(work,{recursive:true});rmSync(outside,{recursive:true});}
});
