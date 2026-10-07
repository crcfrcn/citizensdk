// 使用真实文件事务与受控HTTPS数据，禁止测试下载或安装真实工具。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,readFile,writeFile,readdir,rm,symlink,chmod,lstat,rename} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import { testRoot as tmpdir } from './build.mjs';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {acquireArchive,extractArchive,resourceDeclarations,normalizeCargoManifest,runResourceProcess,buildSourceTool,posixNames,podSourceCoordinate,readDependencySupply,materializeMavenCache,materializePodSupply,mavenSupplyInit} from './resources.mjs';
import {contract} from './build.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function sandbox(t){const root=await realpath(await mkdtemp(join(tmpdir(),contract.product_id+'-resources-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const archive=(body,url='https://example.invalid/locked.tgz')=>({url,sha256:hash(body)});
function tar(entries){const records=[];for(const {name,body='',type='0',target=''}of entries){const b=Buffer.from(body),h=Buffer.alloc(512);h.write(name,0,100);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write(target,157,100);h.write('ustar\0',257);h.write('00',263);h.write([...h].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);records.push(h,b,Buffer.alloc((512-b.length%512)%512));}return gzipSync(Buffer.concat([...records,Buffer.alloc(1024)]));}
test('首次按锁取得；再次复用不联网，损坏原件不覆盖',async t=>{
 const root=await sandbox(t),body=Buffer.from('locked-source'),entry=archive(body);let requests=0;
 const options={store:root,fetcher:async()=>{requests++;return new Response(body);}};
 const file=await acquireArchive(entry,options);assert.equal(await readFile(file,'utf8'),'locked-source');
 assert.equal(await acquireArchive(entry,{...options,offline:true,fetcher:()=>assert.fail('离线联网')}),file);assert.equal(requests,1);
 await chmod(file,0o600);await writeFile(file,'corrupt');await assert.rejects(acquireArchive(entry,options),/摘要/);assert.equal(requests,1);assert.equal(await readFile(file,'utf8'),'corrupt');
});
test('错摘要、错来源、离线缺失、来源越权均失败关闭且无正式原件',async t=>{
 const root=await sandbox(t),body=Buffer.from('source'),entry=archive(body);let requests=0;
 await assert.rejects(acquireArchive(entry,{store:root,offline:true,fetcher:()=>assert.fail('离线联网')}),/离线/);
 await assert.rejects(acquireArchive(entry,{store:root,fetcher:async()=>{requests++;return new Response('wrong');}}),/摘要/);
 await assert.rejects(acquireArchive({...entry,url:'http://example.invalid/source'},{store:root}),/HTTPS/);
 const file=await acquireArchive(entry,{store:root,fetcher:async()=>new Response(body)});
 await assert.rejects(acquireArchive({...entry,url:'https://example.invalid/other'},{store:root,offline:true}),/离线/);
 assert.equal(await readFile(file,'utf8'),'source');assert.equal(requests,1);assert.equal((await readdir(root)).filter(x=>x.endsWith('.pending')||x.endsWith('.lock')).length,0);
});
test('可选供给按准确内容摘要验真，独立运行不需要供给目录',async t=>{
 const root=await sandbox(t),store=join(root,'store'),optional=join(root,'objects'),body=Buffer.from('shared-source'),entry=archive(body),source=join(optional,entry.sha256+'.blob');await mkdir(dirname(source),{recursive:true});await writeFile(source,body);
 const file=await acquireArchive(entry,{store,optional,offline:true,fetcher:()=>assert.fail('供给命中联网')});assert.equal(await readFile(file,'utf8'),'shared-source');await writeFile(source,'altered');assert.equal(await readFile(file,'utf8'),'shared-source');
 await assert.rejects(acquireArchive(entry,{store:join(root,'other'),optional,offline:true}),/摘要/);
});
test('取消下载清理本次候选；短锁只在提交阶段取得',async t=>{
 const root=await sandbox(t),entry=archive(Buffer.from('ab')),abort=new AbortController();
 const fetcher=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('a'));abort.abort();controller.close();}}));
 await assert.rejects(acquireArchive(entry,{store:root,fetcher,signal:abort.signal}));assert.deepEqual(await readdir(root),[]);
 let state;const file=await acquireArchive(entry,{store:root,fetcher:async()=>{state=await readdir(root);return new Response('ab');}});assert.deepEqual(state,[]);assert.equal(await readFile(file,'utf8'),'ab');
});
test('同对象并发提交只保留一份验真原件，不留全局下载锁',async t=>{
 const root=await sandbox(t),body=Buffer.from('concurrent'),entry=archive(body);let calls=0;const options={store:root,fetcher:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return new Response(body);}};
 const paths=await Promise.all(Array.from({length:8},()=>acquireArchive(entry,options)));assert.equal(new Set(paths).size,1);assert.equal(await readFile(paths[0],'utf8'),'concurrent');assert.equal(calls,8);assert.deepEqual(await readdir(root),[paths[0].slice(root.length+1)]);
});
test('归档安全解包并隔离不同任务，拒绝路径和链接越界',async t=>{
 const root=await sandbox(t),source=join(root,'source.tgz'),data=tar([{name:'package/a',body:'source'},{name:'package/b',type:'2',target:'a'}]);await writeFile(source,data);
 const first=join(root,'first'),second=join(root,'second');await extractArchive(source,first,{prefix:'package'});await extractArchive(source,second,{prefix:'package'});assert.equal(await realpath(join(first,'b')),join(first,'a'));await writeFile(join(first,'a'),'task1');assert.equal(await readFile(join(second,'a'),'utf8'),'source');
 for(const [name,entries]of [['path',[{name:'../outside',body:'x'}]],['link',[{name:'package/a',body:'x'},{name:'package/b',type:'2',target:'../../outside'}]],['parent',[{name:'package/a',type:'2',target:'b'},{name:'package/a/child',body:'x'},{name:'package/b',body:'x'}]]]){const file=join(root,name+'.tgz');await writeFile(file,tar(entries));await assert.rejects(extractArchive(file,join(root,name),{prefix:name==='path'?'':'package'}),/越界|父目录/);assert.equal((await readdir(root)).includes(name),false);}
});
test('链接原件目录、重复成员与解包取消拒绝且不写第三方目录',async t=>{
 const root=await sandbox(t),external=join(root,'external'),link=join(root,'link');await mkdir(external);await symlink(external,link);await assert.rejects(acquireArchive(archive(Buffer.from('source')),{store:link,offline:true}),/链接/);assert.deepEqual(await readdir(external),[]);
 const input=join(root,'input.tgz');await writeFile(input,tar([{name:'a',body:'x'},{name:'a',body:'y'}]));await assert.rejects(extractArchive(input,join(root,'duplicate')),/重复/);
 const signal=AbortSignal.abort();await assert.rejects(extractArchive(input,join(root,'cancelled'),{signal}));assert.equal((await readdir(root)).includes('cancelled'),false);
});
test('产品配方覆盖自身需求和递归工具，模块只使用内置依赖，独立CLI拒绝错误输入',async t=>{
 const root=await sandbox(t),declarations=resourceDeclarations(),tools=new Map(declarations.tools.map(x=>[x.id,x]));for(const platform of Object.values(contract.platforms))for(const tool of platform.tools){assert.equal(tools.get(tool.id)?.version,tool.version);}
 for(const tool of tools.values())for(const id of tool.requires||[])assert.ok(tools.has(id),'缺少递归工具 '+id);
 for(const name of ['node','posix','bash','grep','sed'])assert.ok(tools.has(name));const source=await readFile(new URL('./resources.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/import\(['"]\.\.\//u);assert.ok([...source.matchAll(/^import .*? from ['"]([^'"]+)['"]/gmu)].every(m=>m[1].startsWith('node:')));
 const result=spawnSync(process.execPath,[join(import.meta.dirname,'resources.mjs'),'unknown','--work',root,'--offline'],{env:{HOME:root,LANG:'C',PATH:''},encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/平台/);assert.deepEqual(await readdir(root),[]);
});

test('Git Cargo工作区继承按当前产品锁展开，不留下跨包路径',()=>{
 const input={package:{name:'one',version:{workspace:true}},dependencies:{two:{workspace:true},third:{path:'../third'}}};const workspace={workspace:{package:{version:'1.0.0'},dependencies:{two:{path:'two',version:'2.0.0',features:['a']}}}};const lock=[{name:'third',version:'3.0.0'}];
 const result=normalizeCargoManifest(input,workspace,lock);assert.equal(result.package.version,'1.0.0');assert.equal(result.dependencies.two.path,undefined);assert.equal(result.dependencies.third.version,'=3.0.0');assert.deepEqual(input.package.version,{workspace:true});assert.throws(()=>normalizeCargoManifest(input,workspace,[]),/唯一锁定版本/);
});
test('资源子进程可取消，不能继续输出成功回执',async()=>{
 const signal=AbortSignal.timeout(150);await assert.rejects(runResourceProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal,env:{PATH:''}}),/abort|timeout|取消/iu);
});

// 使用产品真实源码工具生产器；编译/Apple能力边界受控，文件事务和输出验真实际执行。
const registry=resourceDeclarations();
async function sourceFixture(t, behavior = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-tool-')));
  const owner = await lstat(root);
  t.after(async () => {
    const current = await lstat(root);
    assert.equal(current.dev, owner.dev); assert.equal(current.ino, owner.ino);
    await rm(root, { recursive: true, force: true });
  });
  const library = { root: join(root, 'tools'), work:join(root,'work'), tools: registry.tools };await mkdir(library.work);
  const tool = structuredClone(registry.tools.find(tool => tool.id === 'perl'));
  const bytes = Buffer.from('official-fixture-archive');
  tool.archive.sha256 = createHash('sha256').update(bytes).digest('hex');
  const pending = join(library.root, 'shared', tool.archive.sha256 + '.pending');
  const payload = join(pending, 'payload'), source = join(pending, 'unpack', tool.archive.root);
  const finalPayload = join(library.root, 'shared', tool.archive.sha256, 'payload');library.pending=pending;library.finalPayload=finalPayload;
  const developerDirectory = join(root, 'Xcode.app/Contents/Developer');
  const sdk = join(developerDirectory, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk');
  await mkdir(source, { recursive: true }); await mkdir(sdk, { recursive: true });
  await writeFile(join(pending, 'archive'), bytes);
  await writeFile(join(source, 'Artistic'), 'fixture upstream legal text');
  // 本夹具只声明实际Configure安装路径和受控入口，不复制任何真实工具原件。
  await writeFile(join(source,'config.sh'),
    "installprivlib='"+finalPayload+"/lib/5.42.3'\ninstallarchlib='"+finalPayload+"/lib/5.42.3/aarch64-darwin'\n");
  const posix=join(root,'verified/posix/bin');await mkdir(posix,{recursive:true});
  for(const name of posixNames)await writeFile(join(posix,name),'fixture executable '+name,{mode:0o755});
  // 完整基础工具交付属于夹具输入；不会复制或安装真实工具原件。
  for(const id of ['bash','grep','sed']) {
    const bin=join(root,'verified',id,'bin');await mkdir(bin,{recursive:true});
    await writeFile(join(bin,id),'fixture executable '+id,{mode:0o755});
  }
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command.endsWith('/xcrun')) return { stdout: sdk + '\n' };
    if (args.includes('-MJSON::PP')) return { stdout: behavior.coreFails ? '' : 'controlled-perl-ok\n' };
    if (behavior.compilerFails && args.includes('-j8')) throw new Error('compiler failed');
    if (args.includes('install')) {
      const destination = args.find(value => value.startsWith('DESTDIR=')).slice(8);
      const staged = join(destination, finalPayload.slice(1));
      await mkdir(join(staged, 'bin'), { recursive: true });
      if (behavior.linkOutput) await symlink(join(pending, 'archive'), join(staged, 'bin/perl'));
      else if (!behavior.missingOutput) {
        const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4);
        await writeFile(join(staged, 'bin/perl'), macho, { mode: 0o755 });
        await mkdir(join(staged, 'lib/5.42.3/aarch64-darwin'), { recursive: true });
        await writeFile(join(staged, 'lib/5.42.3/aarch64-darwin/Config.pm'), 'fixture core module');
      }
    }
    return { stdout: '' };
  };
  const input = { library, tool, pending, payload, source, archive: join(pending, 'archive'), finalPayload,
    environment: { PATH: '/untrusted/bin', RUBYOPT: '-rmalicious', PYTHONPATH: '/untrusted',
      DYLD_INSERT_LIBRARIES: '/untrusted', LD_PRELOAD: '/untrusted', ARCHFLAGS: '-arch x86_64', CFLAGS: 'malicious', PERL5OPT: '-Mmalicious' },
    exec, verify: async (_, tool) => behavior.missingTool === tool.id ? null
      : { path: join(root, 'verified', tool.id, 'bin', tool.command), version: tool.version },
    apple: async () => ({ developerDirectory, version: '27.0',
      tools: Object.fromEntries(['clang', 'clang++', 'ar', 'make', 'ld', 'as', 'nm', 'ranlib', 'strip', 'xcrun', 'otool', 'install_name_tool', 'codesign'].map(name => [name, join(developerDirectory, 'usr/bin', name)])) }),
    prepare: async () => { await mkdir(join(pending, 'originals')); return new Map(); } };
  return { input, calls, bytes };
}
test('源码工具使用准确Apple编译入口并只在候选中收集输出、原件和编译输入', async t => {
  const { input, calls, bytes } = await sourceFixture(t);
  await buildSourceTool(input);
  assert.deepEqual(await readFile(join(input.payload, 'source.archive')), bytes);
  assert.equal(JSON.parse(await readFile(join(input.payload, 'build.json'))).tool.id, 'perl');
  const configure = calls.find(call => call.args.includes('-des'));
  assert.ok(configure.args.includes('-Dinstallusrbinperl=n'));
  for (const key of ['RUBYOPT', 'PYTHONPATH', 'DYLD_INSERT_LIBRARIES', 'PERL5OPT', 'LD_PRELOAD']) assert.equal(configure.options.env[key], undefined);
  assert.equal(configure.options.env.CFLAGS,'-O2');
  assert.equal(configure.options.env.MACOSX_DEPLOYMENT_TARGET,registry.tools.find(t=>t.id==='posix').version);
  assert.ok(configure.options.env.SDKROOT.startsWith(configure.options.env.DEVELOPER_DIR+'/'));
  assert.equal(configure.options.env.CPP,configure.options.env.CC+' -E');
  assert.ok(!configure.options.env.PATH.split(':').some(p=>['/usr/bin','/bin','/opt/homebrew/bin'].includes(p)));
  const record=JSON.parse(await readFile(join(input.payload,'build.json'),'utf8'));
  assert.equal(record.posix_sha256,registry.tools.find(t=>t.id==='posix').archive.sha256);
  assert.equal(record.recipe,createHash('sha256').update(await readFile(join(input.payload,'recipe.source'))).digest('hex'));
  assert.equal(configure.options.env.ARCHFLAGS, '-arch arm64');
  assert.ok(configure.options.env.CC.startsWith(input.pending.split('/tools/')[0] + '/Xcode.app/'));
  assert.ok(!configure.options.env.PATH.includes('/untrusted/'));
  assert.ok(calls.some(call => call.args.includes('-MJSON::PP') && call.options.env.PERL5LIB.startsWith(input.payload + '/lib/')));
  assert.equal(await readFile(join(input.payload, 'licenses/Artistic'), 'utf8'), 'fixture upstream legal text');
});
for (const behavior of [{ compilerFails: true }, { missingOutput: true }, { linkOutput: true }, { missingTool: 'node' }, { coreFails: true }]) {
  test('源码工具失败边界保留失败且不写入最终工具对象：' + JSON.stringify(behavior), async t => {
    const { input } = await sourceFixture(t, behavior);
    await assert.rejects(buildSourceTool(input));
    await assert.rejects(readFile(join(input.finalPayload, 'bin/perl')), { code: 'ENOENT' });
  });
}
test('官方完整归档被替换时在任何编译前失败', async t => {
  const { input, calls } = await sourceFixture(t);
  await writeFile(input.archive, 'changed');
  await assert.rejects(buildSourceTool(input), /归档摘要/);
  assert.equal(calls.length, 0);
});
test('候选路径不属于当前工具摘要时在任何编译前失败', async t => {
  const { input, calls } = await sourceFixture(t);
  input.finalPayload += '-other';
  await assert.rejects(buildSourceTool(input), /候选对象身份/);
  assert.equal(calls.length, 0);
});

test('空可选供给不阻断产品取得，npm SRI原件按准确来源复用',async t=>{
 const root=await sandbox(t),body=Buffer.from('sri-original'),entry={url:'https://example.invalid/sri.tgz',integrity:'sha512-'+createHash('sha512').update(body).digest('base64')};
 const file=await acquireArchive(entry,{store:join(root,'first'),optional:join(root,'absent'),fetcher:async()=>new Response(body)});assert.equal(await readFile(file,'utf8'),'sri-original');
 const optional=join(root,'shared/objects'),digest=hash(body),original=join(optional,digest+'.blob');await mkdir(dirname(original),{recursive:true});await writeFile(original,body);await writeFile(join(root,'shared/index.json'),JSON.stringify({schema_version:2,packages:[{archives:[{...entry,sha256:digest}]}],git_sources:[],pods:[]}));
 const cached=await acquireArchive(entry,{store:join(root,'second'),optional,offline:true,fetcher:()=>assert.fail('SRI供给命中联网')});assert.equal(await readFile(cached,'utf8'),'sri-original');
});

test('Pod浮动tag必须由产品固定提交闭合，来源漂移或无摘要HTTP发行件失败',()=>{
 const url='https://github.com/example/project.git',ref='a'.repeat(40),spec={name:'Example',version:'1.0.0',source:{git:url,tag:'v1.0.0'}},definitions=[{name:'Example',version:'1.0.0',url,tag:'v1.0.0',ref}];
 assert.deepEqual(podSourceCoordinate(spec,definitions),{url,ref});assert.throws(()=>podSourceCoordinate(spec,[]),/锁定/);
 assert.throws(()=>podSourceCoordinate({...spec,source:{git:'https://github.com/example/other.git',tag:'v1.0.0'}},definitions),/来源/);
 assert.throws(()=>podSourceCoordinate({...spec,source:{git:url,tag:'v2.0.0'}},definitions),/来源/);
 assert.throws(()=>podSourceCoordinate({name:'HTTP',version:'1',source:{http:'https://example.invalid/archive.zip'}},[]),/锁定/);
 for(const entry of resourceDeclarations().pods){const source=entry.ref?{git:entry.url,tag:entry.tag}:{http:entry.url};const coordinate=podSourceCoordinate({name:entry.name,version:entry.version,source});assert.equal(coordinate.ref||coordinate.sha256,entry.ref||entry.sha256);}
});

// 真实进程退出顺序：取消回执必须晚于子工具完成清理，不能用发送信号代替退出确认。
test('资源取消等待真实工具清理并确认退出后才返回失败',{timeout:20000},async t=>{
 const directory=await sandbox(t),ready=join(directory,'ready'),closed=join(directory,'closed');
 const code=`import {writeFileSync} from 'node:fs';process.once('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(closed)},'closed');process.exit(0);},600));writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
 const controller=new AbortController();const running=runResourceProcess(process.execPath,['--input-type=module','-e',code],{cwd:directory,env:{PRODUCT_WORK_DIR:directory},signal:controller.signal});
 for(let n=0;n<200;n++){try{await readFile(ready);break;}catch{await new Promise(ok=>setTimeout(ok,10));}}
 assert.equal(await readFile(ready,'utf8'),'ready');const start=Date.now();controller.abort(Error('资源进程取消'));
 await assert.rejects(running,/取消/u);assert.equal(await readFile(closed,'utf8'),'closed');assert.ok(Date.now()-start>=500);
});
test('资源超时等待退出，错误入口和输出超限不产生成功回执',{timeout:20000},async t=>{
 const directory=await sandbox(t),closed=join(directory,'timeout-closed');
 const code=`import {writeFileSync} from 'node:fs';process.once('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(closed)},'closed');process.exit(0);},400));setInterval(()=>{},1000);`;
 await assert.rejects(runResourceProcess(process.execPath,['--input-type=module','-e',code],{cwd:directory,timeout:500}),/超时/u);
 assert.equal(await readFile(closed,'utf8'),'closed');
 await assert.rejects(runResourceProcess(join(directory,'missing'),[],{cwd:directory}),/无法启动/u);
 await assert.rejects(runResourceProcess(process.execPath,['-e','process.stdout.write("x".repeat(4096))'],{cwd:directory,maxBuffer:64}),/输出超限/u);
});

// 依赖供给夹具只写真实独占文件，覆盖唯一协议及任务视图隔离，不下载和安装工具。
async function dependencySupplyFixture(t,packages=[],pods=[]){const root=await sandbox(t),objects=join(root,'supply/objects'),work=join(root,'work');await mkdir(objects,{recursive:true});await mkdir(work);const index={schema_version:2,packages,git_sources:[],pods};await writeFile(join(dirname(objects),'index.json'),JSON.stringify(index));return {root,objects,work,index};}
const suppliedMaven=(bytes,source='https://repo.maven.apache.org/maven2/',suffix='pom')=>({ecosystem:'maven',name:'example:library',version:'1.0.0',archives:[{url:source+'example/library/1.0.0/library-1.0.0.'+suffix,integrity:'sha256-'+createHash('sha256').update(bytes).digest('base64'),sha256:hash(bytes)}]});
test('无可选依赖供给保持独立，旧schema与Pod整锁快照被拒绝',async t=>{
 const f=await dependencySupplyFixture(t);assert.equal(await readDependencySupply(join(f.root,'absent')),null);assert.deepEqual(await materializeMavenCache(undefined,f.work),[]);
 for(const value of [null,[],{schema_version:1,packages:[],git_sources:[],snapshots:[]},{...f.index,snapshots:[]}]){await writeFile(join(dirname(f.objects),'index.json'),JSON.stringify(value));await assert.rejects(readDependencySupply(f.objects),/协议/);}
});
test('Maven按上游分区重建，JAR分类器及module文件名保留，共享原件不承接写入',async t=>{
 const a=Buffer.from('central-pom'),b=Buffer.from('portal-pom'),c=Buffer.from('classifier-original'),d=Buffer.from('{"formatVersion":"1.1"}');const entries=[suppliedMaven(a),suppliedMaven(b,'https://plugins.gradle.org/m2/'),suppliedMaven(c,undefined,'jar'),suppliedMaven(d,undefined,'module')];entries[2].archives[0].url=entries[2].archives[0].url.replace('.jar','-sources.jar');const f=await dependencySupplyFixture(t,entries);
 for(const bytes of[a,b,c,d])await writeFile(join(f.objects,hash(bytes)+'.blob'),bytes);
 const repos=await materializeMavenCache(f.objects,f.work);assert.equal(repos.length,2);const central=repos.find(x=>x.source.includes('repo.maven.apache.org')),portal=repos.find(x=>x.source.includes('plugins.gradle.org'));assert.equal(await readFile(join(central.directory,'example/library/1.0.0/library-1.0.0.pom'),'utf8'),'central-pom');assert.equal(await readFile(join(portal.directory,'example/library/1.0.0/library-1.0.0.pom'),'utf8'),'portal-pom');assert.equal(await readFile(join(central.directory,'example/library/1.0.0/library-1.0.0-sources.jar'),'utf8'),'classifier-original');
 assert.deepEqual(await materializeMavenCache(f.objects,f.work),repos);const script=mavenSupplyInit(repos);assert.match(script,/beforeSettings/);assert.match(script,/beforeProject/);assert.match(script,/artifactUrls\(original.url\)/);assert.doesNotMatch(script,/modules-2|rely\/maven/);
 await writeFile(join(central.directory,'example/library/1.0.0/library-1.0.0.pom'),'task-changed');assert.equal(await readFile(join(f.objects,hash(a)+'.blob'),'utf8'),'central-pom');await assert.rejects(materializeMavenCache(f.objects,f.work),/摘要/);
});
for(const change of ['sha','sri','source','version','duplicate','state','link','cancel'])test('Maven拒绝错误原件或状态并保留失败：'+change,async t=>{
 const bytes=Buffer.from('maven-original'),entry=suppliedMaven(bytes),f=await dependencySupplyFixture(t,[entry]);await writeFile(join(f.objects,hash(bytes)+'.blob'),bytes);
 if(change==='sha')await writeFile(join(f.objects,hash(bytes)+'.blob'),'changed');if(change==='sri')entry.archives[0].integrity='sha256-'+Buffer.alloc(32).toString('base64');if(change==='source')entry.archives[0].url='https://other.invalid/maven2/example/library/1.0.0/library-1.0.0.pom';if(change==='version')entry.version='LATEST';if(change==='duplicate')f.index.packages.push({...entry,archives:[{...entry.archives[0],sha256:'a'.repeat(64)}]});
 await writeFile(join(dirname(f.objects),'index.json'),JSON.stringify(f.index));if(change==='state'){const [repo]=await materializeMavenCache(f.objects,f.work);await writeFile(join(repo.directory,'gc.properties'),'generated');}if(change==='link'){await mkdir(join(f.root,'outside'));await symlink(join(f.root,'outside'),join(f.work,'dependencies'));}
 const signal=change==='cancel'?AbortSignal.abort(Error('取消')):undefined;await assert.rejects(materializeMavenCache(f.objects,f.work,{signal}));assert.equal(await readFile(join(f.objects,hash(bytes)+'.blob'),'utf8'),change==='sha'?'changed':'maven-original');assert.equal((await readdir(join(f.work,'dependencies')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).some(x=>x.startsWith('.maven-')),false);
});
async function podSupplyFixture(t){
 // 合成Pod自带固定提交，不读取真实产品的Pod清单作为测试输入。
 const name='PodFixture',version='1.0.0',source={git:'https://github.com/example/PodFixture.git',commit:'1'.repeat(40)},bytes=Buffer.from(JSON.stringify({name,version,source})),file=Buffer.from('pod-source'),md5=createHash('md5').update(name).digest('hex');
 const pod={name,version,checksum:'a'.repeat(40),spec:{url:'https://cdn.cocoapods.org/Specs/'+md5[0]+'/'+md5[1]+'/'+md5[2]+'/'+name+'/'+version+'/'+name+'.podspec.json',sha256:hash(bytes)},source,files:[{type:'file',path:'Example.framework/Versions/A/Headers/source.h',sha256:hash(file),executable:false},{type:'link',path:'Example.framework/Versions/Current',target:'A'},{type:'link',path:'Example.framework/Headers',target:'Versions/Current/Headers'}]};const f=await dependencySupplyFixture(t,[],[pod]);for(const value of[bytes,file])await writeFile(join(f.objects,hash(value)+'.blob'),value);return {...f,pod,bytes,file};
}
test('Pod单坐标供给不依赖整锁与宿主，Framework多级链接仅在本轮物化',async t=>{
 const f=await podSupplyFixture(t);assert.equal(await materializePodSupply(undefined,f.objects,f.work),false);assert.equal(await materializePodSupply(f.pod,f.objects,f.work),true);assert.equal(await materializePodSupply(f.pod,f.objects,f.work),true);const release=join(f.work,'cache/Pods/Release',f.pod.name,f.pod.version+'-aaaaa');assert.equal(await readFile(join(release,'Example.framework/Headers/source.h'),'utf8'),'pod-source');await writeFile(join(release,'Example.framework/Headers/source.h'),'task-write');assert.equal(await readFile(join(f.objects,hash(f.file)+'.blob'),'utf8'),'pod-source');await assert.rejects(materializePodSupply(f.pod,f.objects,f.work),/漂移/);
});
for(const change of ['sha','spec','source','escape','duplicate','cycle','state','cancel'])test('Pod错来源、摘要和不安全链接失败关闭：'+change,async t=>{
 const f=await podSupplyFixture(t);if(change==='state'){await materializePodSupply(f.pod,f.objects,f.work);await writeFile(join(f.work,'cache/Pods/Release',f.pod.name,f.pod.version+'-aaaaa/generated.bin'),'state');}if(change==='sha')await writeFile(join(f.objects,hash(f.file)+'.blob'),'changed');if(change==='spec')f.pod.spec.url+='?other=1';if(change==='source')f.pod.source={git:'https://github.com/example/other.git',tag:'v1'};if(change==='escape')f.pod.files[1].target='../../../../outside';if(change==='duplicate')f.pod.files.push({...f.pod.files[0]});if(change==='cycle')f.pod.files[1].target='Current';const signal=change==='cancel'?AbortSignal.abort(Error('取消')):undefined;await assert.rejects(materializePodSupply(f.pod,f.objects,f.work,{signal}));assert.equal(await readFile(join(f.objects,hash(f.bytes)+'.blob'),'utf8'),f.bytes.toString());
});

// 真实文件事务验证下载候选的归属，不执行真实工具安装或编译。
test('资源下载候选只属于当前产品target现场，永久库不接收半包',async t=>{
 const root=await sandbox(t),work=join(root,'work'),store=join(root,'originals');await mkdir(work);await mkdir(store);
 const body=Buffer.from('owned-pending'),entry=archive(body);let inspected=false;
 const fetcher=async()=>({ok:true,headers:new Headers(),body:{async *[Symbol.asyncIterator](){
  const candidates=await readdir(join(work,'resource-pending'));
  assert.equal(candidates.filter(name=>name.endsWith('.pending')).length,1);
  assert.deepEqual(await readdir(store),[]);inspected=true;yield body;
 },cancel:async()=>{}}});
 const file=await acquireArchive(entry,{store,work,fetcher});assert.equal(inspected,true);
 assert.equal(await readFile(file,'utf8'),body.toString());assert.deepEqual(await readdir(join(work,'resource-pending')),[]);
 await assert.rejects(acquireArchive(archive(Buffer.from('other')),{store,work:dirname(resolve(import.meta.dirname,'..')),fetcher}),/target/);
});


// 夹具复制本仓完整资源实现，只替换文件IO边界并暴露已有私有验真函数，生产接口不新增出口。
test('工具内部硬链接完整闭合，默认独占、跨原件名称、回执漂移和读取变化仍拒绝',async t=>{
 const area=await sandbox(t),source=join(area,'source'),entry=join(source,'resources.mjs');
 const {link,unlink}=await import('node:fs/promises'),{pathToFileURL}=await import('node:url');
 await mkdir(source);
 const current=await readFile(new URL('./resources.mjs',import.meta.url),'utf8');
 const fsImport="from 'node:fs/promises';";
 assert.ok(current.includes(fsImport));
 const copied=current.replace(fsImport,"from './filesystem.mjs';");
 assert.equal(copied.replace("from './filesystem.mjs';",fsImport),current);
 await writeFile(entry,copied+'\nexport {toolInventory,verifyToolObject};\n');
 await writeFile(join(source,'filesystem.mjs'),[
  "export * from 'node:fs/promises';",
  "import {open as actualOpen} from 'node:fs/promises';",
  "let mutation=null;",
  "export function armMutation(value){mutation=value;}",
  "export async function open(...args){",
  " const handle=await actualOpen(...args),read=handle.readFile.bind(handle);",
  " handle.readFile=async(...options)=>{",
  "  const bytes=await read(...options);",
  "  if(mutation&&await mutation(args[0])!==false)mutation=null;",
  "  return bytes;",
  " };",
  " return handle;",
  "}",
 ].join('\n'));
 const owner=await import(pathToFileURL(entry).href),io=await import(pathToFileURL(join(source,'filesystem.mjs')).href);
 const tool={id:'unit-fixture',version:'1.0.0',archive:{sha256:'a'.repeat(64),kind:'extract',executable:'bin/tool'}};
 const object=async name=>{
  const directory=join(area,name),payload=join(directory,'payload');
  await mkdir(join(payload,'bin'),{recursive:true});
  await writeFile(join(payload,'bin/tool'),'synthetic-tool');await chmod(join(payload,'bin/tool'),0o700);
  await writeFile(join(payload,'helper'),'synthetic-helper');await link(join(payload,'helper'),join(payload,'alias'));
  return {directory,payload};
 };
 const valid=await object('closed');
 const before=(await lstat(join(valid.payload,'helper'))).nlink;assert.equal(before,2);
 const files=await owner.toolInventory(valid.payload,tool);
 assert.deepEqual(files,[
  {path:'alias',sha256:hash('synthetic-helper'),executable:false},
  {path:'bin',directory:true},
  {path:'bin/tool',sha256:hash('synthetic-tool'),executable:true},
  {path:'helper',sha256:hash('synthetic-helper'),executable:false},
 ]);
 assert.equal((await lstat(join(valid.payload,'helper'))).nlink,before);
 await assert.rejects(owner.inventory(valid.payload),/共享硬链接/u);
 const receipt={id:tool.id,version:tool.version,sha256:tool.archive.sha256,files};
 await writeFile(join(valid.directory,'receipt.json'),JSON.stringify(receipt));
 assert.deepEqual(await owner.verifyToolObject(valid.directory,tool),{path:join(valid.payload,'bin/tool'),version:tool.version});
 await writeFile(join(valid.payload,'helper'),'changed-helper');
 await assert.rejects(owner.verifyToolObject(valid.directory,tool),/工具回执或字节不符/u);
 const shared=await object('external');
 await link(join(shared.payload,'helper'),join(shared.directory,'outside-name'));
 await assert.rejects(owner.toolInventory(shared.payload,tool),/硬链接跨原件边界/u);
 const independent=join(area,'ordinary');await mkdir(independent);await writeFile(join(independent,'single'),'single');
 assert.deepEqual(await owner.inventory(independent),[{path:'single',sha256:hash('single'),executable:false}]);
 const links=await object('links'),outside=join(links.directory,'outside');await writeFile(outside,'outside');
 await symlink('helper',join(links.payload,'internal'));
 assert.ok((await owner.toolInventory(links.payload,tool)).some(value=>value.path==='internal'&&value.target==='helper'));
 await symlink(outside,join(links.payload,'escape'));
 await assert.rejects(owner.toolInventory(links.payload,tool),/链接越界/u);
 const linked=join(area,'linked');await symlink(valid.payload,linked,'dir');
 await assert.rejects(owner.toolInventory(linked,tool),/链接/u);
 const parent=join(area,'parent');await symlink(valid.directory,parent,'dir');
 await assert.rejects(owner.toolInventory(join(parent,'payload'),tool),/链接/u);
 // 读取后在真实文件系统变更；同一生产扫描器必须拒绝计数、inode、权限、字节和路径漂移。
 const races=[
  ['count',async (value,file)=>{await link(file,join(value.directory,'outside-name'));}],
  ['inode',async (value,file)=>{await unlink(file);await writeFile(file,'replacement');}],
  ['mode',async (value,file)=>{await chmod(file,0o700);}],
  ['bytes',async (value,file)=>{await writeFile(file,'different-size-and-bytes');}],
  ['directory',async (value,file)=>{
   if(file!==join(value.payload,'helper'))return false;
   await rename(value.payload,join(value.directory,'moved'));await mkdir(value.payload);
  }],
  ['symlink',async (value,file)=>{
   if(file!==join(value.payload,'last'))return false;
   await unlink(join(value.payload,'internal'));await symlink(join(value.directory,'outside'),join(value.payload,'internal'));
  }],
 ];
 for(const [name,mutate]of races){
  const value=await object('race-'+name);
  if(name==='symlink'){
   await writeFile(join(value.directory,'outside'),'outside');await symlink('helper',join(value.payload,'internal'));
   await writeFile(join(value.payload,'last'),'last');
  }
  io.armMutation(file=>mutate(value,file));
  try{await assert.rejects(owner.toolInventory(value.payload,tool),/读取期间/u);}
  finally{io.armMutation(null);}
 }
});


// 全文复制本仓模块，合成回执逐次重算文件清单；只在测试副本暴露已有私有入口，不执行工具。
test('源码工具只分离两处有效镜像运输字段，真实编译输入与物理证明仍严格验真',async t=>{
 const area=await sandbox(t),entry=join(area,'resources-proof.mjs'),directory=join(area,'object'),payload=join(directory,'payload');
 const {pathToFileURL}=await import('node:url');
 const original=await readFile(new URL('./resources.mjs',import.meta.url),'utf8');
 await writeFile(entry,original+'\nexport {compilationToolInput,toolInventory,verifyToolObject};\n');
 const owner=await import(pathToFileURL(entry).href),definitions=owner.resourceDeclarations().tools;
 const source='synthetic-source-archive',recipe='synthetic-recipe';
 const tool={id:'unit-fixture',version:'1.0.0',source:'https://example.invalid/releases.json',requires:['node'],dependencies:[],
  archive:{url:'https://example.invalid/source.tgz',sha256:hash(source),root:'source',executable:'bin/tool',kind:'native-source'},
  upstream_patches:[{url:'https://example.invalid/patch-1',sha256:'b'.repeat(64)},{url:'https://example.invalid/patch-2',sha256:'c'.repeat(64)}]};
 const proof={xcode:definitions.find(x=>x.id==='xcode').version,posix_sha256:definitions.find(x=>x.id==='posix').archive.sha256,
  tool:structuredClone(tool),recipe:hash(recipe)};
 await mkdir(join(payload,'bin'),{recursive:true});await writeFile(join(payload,'bin/tool'),'synthetic-tool');await chmod(join(payload,'bin/tool'),0o700);
 const check=async (value,declared=tool,bytes={source,recipe})=>{
  await writeFile(join(payload,'build.json'),JSON.stringify(value));
  await writeFile(join(payload,'recipe.source'),bytes.recipe);await writeFile(join(payload,'source.archive'),bytes.source);
  await writeFile(join(directory,'receipt.json'),JSON.stringify({id:declared.id,version:declared.version,sha256:declared.archive.sha256,
   files:await owner.toolInventory(payload,declared)}));
  return owner.verifyToolObject(directory,declared);
 };
 const expected={path:join(payload,'bin/tool'),version:tool.version};
 assert.deepEqual(await check(proof),expected);
 const mirrored=structuredClone(proof);mirrored.tool.archive.mirrors=['https://mirror.example.invalid/source.tgz'];
 mirrored.tool.upstream_patches[0].mirrors=['https://mirror.example.invalid/patch-1'];
 mirrored.tool.upstream_patches[1].mirrors=['https://mirror.example.invalid/patch-2'];
 const before=JSON.stringify(mirrored);
 assert.deepEqual(owner.compilationToolInput(mirrored.tool),tool);assert.equal(JSON.stringify(mirrored),before);
 assert.deepEqual(await check(mirrored),expected);
 const declared=structuredClone(tool);declared.archive.mirrors=['https://other.example.invalid/source.tgz'];
 declared.upstream_patches[0].mirrors=['https://other.example.invalid/patch-1'];
 const declarationBefore=JSON.stringify(declared);
 assert.deepEqual(await check(mirrored,declared),expected);assert.equal(JSON.stringify(declared),declarationBefore);
 assert.deepEqual(await check(proof,declared),expected);
 const drift=[
  ['version',value=>{value.tool.version='2.0.0';}],
  ['source',value=>{value.tool.source='https://other.example.invalid/releases.json';}],
  ['archive-url',value=>{value.tool.archive.url='https://other.example.invalid/source.tgz';}],
  ['archive-digest',value=>{value.tool.archive.sha256='d'.repeat(64);}],
  ['archive-kind',value=>{value.tool.archive.kind='gem';}],
  ['archive-root',value=>{value.tool.archive.root='changed';}],
  ['archive-executable',value=>{value.tool.archive.executable='bin/other';}],
  ['patch-url',value=>{value.tool.upstream_patches[0].url='https://other.example.invalid/patch-1';}],
  ['patch-digest',value=>{value.tool.upstream_patches[0].sha256='d'.repeat(64);}],
  ['patch-order',value=>{value.tool.upstream_patches.reverse();}],
  ['requires',value=>{value.tool.requires.push('perl');}],
  ['dependencies',value=>{value.tool.dependencies.push({name:'extra'});}],
  ['unknown',value=>{value.tool.extra='unapproved';}],
  ['other-mirrors',value=>{value.tool.mirrors=['https://mirror.example.invalid/source.tgz'];}],
  ['nested-mirrors',value=>{value.tool.dependencies=[{name:'extra',mirrors:['https://mirror.example.invalid/source.tgz']}];}],
  ['xcode',value=>{value.xcode='0.0';}],
  ['posix',value=>{value.posix_sha256='d'.repeat(64);}],
  ['recipe',value=>{value.recipe='d'.repeat(64);}],
 ];
 for(const [name,mutate]of drift){
  const value=structuredClone(mirrored);mutate(value);
  await assert.rejects(check(value),/源码编译输入不符/u,name);
 }
 await assert.rejects(check(mirrored,tool,{source:'changed-archive',recipe}),/源码编译输入不符/u);
 await assert.rejects(check(mirrored,tool,{source,recipe:'changed-recipe'}),/源码编译输入不符/u);
 const invalid=[
  [],'',null,[''],['http://mirror.example.invalid/source.tgz'],
  ['https://mirror.example.invalid/source.tgz','https://mirror.example.invalid/source.tgz'],
  ['https://mirror.example.invalid/with space'],['https://mirror.example.invalid/source.tgz\u0000'],
  ['https://user:password@mirror.example.invalid/source.tgz'],['https://mirror.example.invalid/source.tgz#fragment'],
  ['https://mirror.example.invalid'],[42],
 ];
 for(const mirrors of invalid)for(const location of ['archive','patch'])for(const side of ['proof','declaration']){
  const value=structuredClone(proof),requested=structuredClone(tool),target=side==='proof'?value.tool:requested;
  (location==='archive'?target.archive:target.upstream_patches[0]).mirrors=mirrors;
  await assert.rejects(check(value,requested),/镜像运输地址无效/u,side+' '+location);
 }
 for(const side of ['proof','declaration']){
  const value=structuredClone(proof),requested=structuredClone(tool),target=side==='proof'?value.tool:requested;
  target.upstream_patches={};
  await assert.rejects(check(value,requested),/源码补丁输入证明无效/u);
 }
});
