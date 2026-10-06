import { toolEnvironment, exactExecutable, validateToolSources, prepareRunnerTools, resolveBootstrapPackages } from './tools.mjs';
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
test('公开链真源只读准确SHA，拒绝网络、重定向、超限及伪造坐标',async()=>{
  const sha='a'.repeat(40);
  const reference={ref:'refs/heads/main',object:{type:'commit',sha,url:'https://api.github.com/repos/crcfrcn/citizenchain/git/commits/'+sha}};
  assert.equal(await readPublicChain(null,null,async(url,options)=>{
    assert.equal(url,'https://api.github.com/repos/crcfrcn/citizenchain/git/ref/heads/main');
    assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
    assert.equal(options.headers.Authorization,undefined);
    return new Response(JSON.stringify(reference));
  }),sha);
  assert.equal(await readPublicChain('runtime/src/lib.rs',sha,async()=>new Response('source')),'source');
  for (const request of [
    async()=>{throw new Error('private response forbidden');},
    async()=>new Response('',{status:302}), async()=>new Response('',{status:404}),
    async()=>new Response(Buffer.alloc(2*1024*1024+1)),
    async()=>new Response(new Uint8Array([255])),
  ]) await assert.rejects(readPublicChain('runtime/src/lib.rs',sha,request),/准确提交真源读取失败/u);
  for (const value of [
    {...reference,ref:'refs/heads/other'}, {...reference,object:{...reference.object,sha:'main'}},
    {...reference,object:{...reference.object,type:'tag'}},
    {...reference,object:{...reference.object,url:'https://example.org/commit'}},
  ]) await assert.rejects(readPublicChain(null,null,async()=>new Response(JSON.stringify(value))));
  await assert.rejects(readPublicChain('../private',sha,()=>assert.fail('非法路径禁止联网')));
});

// 用隔离的合成Git提交验证门禁读取真实初始内容；不修改产品仓或调用仓库保存/推送。
test('保留源码不按每文件汉字数量判定，真实第一方临时注释仍拒绝', async () => {
  const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { join }, { tmpdir }, { execFileSync }, { validateQuality }] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:os'), import('node:child_process'), import('./index.mjs'),
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
  const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { join, dirname }, { tmpdir }, { execFileSync, spawnSync }, { checkGuardrails }] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:os'), import('node:child_process'), import('./index.mjs'),
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
      ['scripts/fixture.mjs', unfinished, true, '开发残留'],
      [testPath, 'test(() => {\n  ' + statement + '\n});\n', false],
      [testPath, 'test(() => {\n  ' + statement + '\n});\n' + protocol, true, '版本化标识'],
      [testPath, '`\n  ' + statement + '\n`\n', true, '版本化标识'],
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

// 推送只检查本仓提交合同；编译产物和平台服务测试仍由原产品流程实际调用。
test('编译及平台服务验收保持所属产品流程，仓库门禁不借用生成状态', async () => {
  const { readFileSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const read = path => readFileSync(new URL(path, root), 'utf8');
  const excluded = ["scripts/release.test.mjs"];
  for (const path of excluded) {
    assert.ok(read(path).length > 0);
    assert.ok(!gateContract().node_tests.includes(path));
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
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
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
  const original = structuredClone(gateContract().tool_sources);
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
    {name:'compiler',version:'18.1.3'},{name:'libc',version:'2.39'},{name:'runtime',version:'18.1.3'}]);
  assert.throws(()=>resolveBootstrapPackages(records.slice(0,2),roots,compare),/闭包缺失/u);
  assert.throws(()=>resolveBootstrapPackages(records,[{name:'compiler',version:'18.1.4'}],compare),/版本漂移/u);
  assert.throws(()=>resolveBootstrapPackages([...records,records[0]],roots,compare),/身份重复/u);
  const changed=structuredClone(records);changed[1].version='18.1.2';
  assert.throws(()=>resolveBootstrapPackages(changed,roots,compare),/闭包缺失/u);
});
