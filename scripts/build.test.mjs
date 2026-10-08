// 产品独立入口：真实只读需求、资源身份、路径隔离与锁定归档失败关闭。
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import { testRoot as tmpdir } from './build.mjs';
import {dirname,join,resolve} from 'node:path';
import {contract,requirements,resourceEnvironment,checkWork,productTarget,createView,checkArchives} from './build.mjs';

const sandbox=()=>realpathSync(mkdtempSync(join(tmpdir(),contract.product_id+'-build-contract-')));
const root=resolve(import.meta.dirname,'..'),base=existsSync(join(root,'app/pubspec.yaml'))?join(root,'app'):root;
const fixture=work=>{
 const platform=Object.keys(contract.platforms).find(value=>value.endsWith('android'))||Object.keys(contract.platforms)[0];
 const own={};for(const value of contract.platforms[platform].locks){const key={npm:'npmCache',pub:'pubCache',cargo:'cargoHome'}[value.ecosystem];if(key){own[key]=join(work,key);mkdirSync(own[key]);}}
 return {schema:1,product_id:contract.product_id,platform,work,offline:true,
 tools:Object.fromEntries(contract.platforms[platform].tools.map(tool=>[tool.id,{version:tool.version,path:process.execPath}])),
 dependencies:{own},archives:{},environment:{}};
};
test('每个平台从自身原始锁只读提出需求；缺失原始Pod锁按源码事实拒绝',async()=>{
 const work=sandbox();try{for(const platform of Object.keys(contract.platforms)){
  const before=readdirSync(work),apple=platform.endsWith('ios')?'ios':platform.endsWith('macos')?'macos':null;
  if(apple&&existsSync(join(base,apple,'Podfile'))&&!existsSync(join(base,apple,'Podfile.lock'))){
   await assert.rejects(async()=>requirements(platform,work),/CocoaPods原始锁缺失/);
  }else{
   const result=await requirements(platform,work);assert.equal(result.product_id,contract.product_id);
   assert.equal(result.platform,platform);assert.equal(result.schema,1);
   assert.ok(result.tools.every(value=>value.id&&value.version));
   assert.ok(result.locks.every(value=>['cargo','pub','npm','cocoapods'].includes(value.ecosystem)));
  }
  assert.deepEqual(readdirSync(work),before);
 }}finally{rmSync(work,{recursive:true});}
});
test('平台、源码内工作根和链接工作根在任何写入前拒绝',async()=>{
 const work=sandbox();try{
  await assert.rejects(async()=>requirements('unknown',work),/平台/);
  assert.throws(()=>checkWork(root),/本产品target/);
  mkdirSync(join(work,'actual'));symlinkSync(join(work,'actual'),join(work,'linked'));
  assert.throws(()=>checkWork(join(work,'linked')),/链接/);
 }finally{rmSync(work,{recursive:true});}
});
test('资源回执隔离产品、平台、工作根，准确工具版本且禁止注入',()=>{
 const work=sandbox();try{
  const receipt=fixture(work),platform=receipt.platform;
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,product_id:'another'}),/身份/);
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,offline:false}),/身份/);
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,tools:{}}),/工具/);
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,environment:{NODE_OPTIONS:'--inspect'}}),/注入/);
  const id=Object.keys(receipt.tools)[0];assert.throws(()=>resourceEnvironment(platform,work,{...receipt,tools:{...receipt.tools,[id]:{...receipt.tools[id],version:'wrong'}}}),/版本/);
  const env=resourceEnvironment(platform,work,receipt,{HOME:'/home',TOKEN:'private',INJECTED_CONTEXT:'/private'});
  assert.equal(env.TOKEN,undefined);assert.equal(env.INJECTED_CONTEXT,undefined);assert.equal(env.CARGO_NET_OFFLINE,'true');
  assert.equal(env.CITIZENSDK_WORK_DIR,join(work,'work/native'));
  assert.equal(env.CITIZENSDK_NATIVE_OUTPUT_DIR,join(work,'work/output'));
 }finally{rmSync(work,{recursive:true});}
});
test('原始锁需要的依赖必须显式交付，不能使用用户默认缓存',()=>{
 const work=sandbox();try{
  const receipt=fixture(work),own=receipt.dependencies.own;
  for(const key of Object.keys(own)){const missing={...own};delete missing[key];
   assert.throws(()=>resourceEnvironment(receipt.platform,work,{...receipt,dependencies:{own:missing}}),/依赖回执/);}
  const key=Object.keys(own)[0];if(key){
   const linked=join(work,'linked');symlinkSync(own[key],linked);
   assert.throws(()=>resourceEnvironment(receipt.platform,work,{...receipt,dependencies:{own:{...own,[key]:linked}}}),/依赖回执/);
  }
 }finally{rmSync(work,{recursive:true});}
});
test('工程复制在同轮解析包并隔离写入，内部链接重新指向副本',()=>{
 const work=sandbox();try{
  const source=join(work,'input'),output=join(work,'view');mkdirSync(source);
  writeFileSync(join(source,'package.json'),'{"name":"input"}');
  writeFileSync(join(source,'code.js'),'source');symlinkSync('code.js',join(source,'linked.js'));
  mkdirSync(join(source,'node_modules'));writeFileSync(join(source,'node_modules/old'),'generated');
  createView(source,output);writeFileSync(join(output,'package.json'),'{"name":"generated"}');
  assert.equal(readFileSync(join(source,'package.json'),'utf8'),'{"name":"input"}');
  assert.equal(realpathSync(join(output,'linked.js')),join(output,'code.js'));
  assert.equal(existsSync(join(output,'node_modules')),false);
  assert.throws(()=>createView(source,output),/已存在/);
 }finally{rmSync(work,{recursive:true});}
});
test('工程输出的父链接和输入外部链接均拒绝，不能写入第三方目录',()=>{
 const work=sandbox();try{
  const source=join(work,'source'),external=join(work,'external');mkdirSync(source);mkdirSync(external);
  writeFileSync(join(source,'code'),'source');symlinkSync(external,join(work,'linked'));
  assert.throws(()=>createView(source,join(work,'linked/view')),/链接/);assert.deepEqual(readdirSync(external),[]);
  symlinkSync('/etc/passwd',join(source,'outside'));
  assert.throws(()=>createView(source,join(work,'bad-view')),/越界/);
 }finally{rmSync(work,{recursive:true});}
});
test('未经本产品锁声明的归档回执不能用于编译',async()=>{
 const work=sandbox();try{
  const receipt=fixture(work);
  // 同一工具回执不能为归档注入增加来源；验证在任何暂存写入前结束。
  await assert.rejects(checkArchives(receipt.platform,work,{...receipt,archives:{injected:[{name:'unknown',version:'1.0.0',url:'https://example.invalid/archive',sha256:'a'.repeat(64),path:join(work,'missing')}]}}),/产品锁/);
 }finally{rmSync(work,{recursive:true});}
});

// 真实命令行只读自身入口；清除私有环境与工具搜索路径，不能从控制台补齐执行条件。
test('独立命令行从自身声明输出JSON，未知平台失败且不写工作根',async()=>{
 const work=sandbox();try{
  for(const platform of Object.keys(contract.platforms)){
   const before=readdirSync(work),result=spawnSync(process.execPath,[join(root,'scripts/build.mjs'),'requirements',platform,'--work',work],{env:{HOME:work,LANG:'C',LC_ALL:'C'},encoding:'utf8'});
   const apple=platform.endsWith('ios')?'ios':platform.endsWith('macos')?'macos':null;
   if(apple&&existsSync(join(base,apple,'Podfile'))&&!existsSync(join(base,apple,'Podfile.lock'))){assert.notEqual(result.status,0);assert.match(result.stderr,/CocoaPods原始锁缺失/);}
   else{assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.product_id,contract.product_id);assert.equal(value.platform,platform);}
   assert.deepEqual(readdirSync(work),before);
  }
  const invalid=spawnSync(process.execPath,[join(root,'scripts/build.mjs'),'requirements','unknown','--work',work],{env:{HOME:work},encoding:'utf8'});
  assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/平台/);
 }finally{rmSync(work,{recursive:true});}
});

// 完整入口控制边界：替身只替换耗时阶段，不调用真实编译或用户安全存储。
test('产品独立execute完成全部自有阶段后才返回唯一结果',async()=>{
 const {execute,outputDigest}=await import('./build.mjs');const work=sandbox(),platform=Object.keys(contract.platforms)[0],declared=contract.platforms[platform],calls=[];
 try{
  const result={schema:1,product_id:contract.product_id,platform,work,completion:declared.completion,run_id:'123456789',files:[]};
  const stages={requirements:async()=>{calls.push('requirements');},resources:async()=>{calls.push('resources');return {};},prepare:async()=>{calls.push('prepare');},build:async()=>{
   calls.push('build');for(const name of declared.files){const path=join(work,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'isolated-candidate-fixture');result.files.push({path,sha256:outputDigest(path)});}return result;
  }};
  assert.deepEqual(await execute(platform,work,{run_id:'123456789'},{stages}),result);
  assert.deepEqual(calls,['requirements','resources','prepare','requirements','resources','build']);
  assert.deepEqual(JSON.parse(readFileSync(join(work,'build-result.json'),'utf8')),result);
  await assert.rejects(execute(platform,work,{}, {stages}),/已有结果/);
 }finally{rmSync(work,{recursive:true});}
});
test('失败、取消、并发和伪造终态不能复用工作根或留下成功回执',async()=>{
 const {execute}=await import('./build.mjs'),platform=Object.keys(contract.platforms)[0];
 for(const failure of ['resources','prepare','build','identity','cancel']){
  const work=sandbox(),abort=new AbortController(),calls=[];
  try{
   const stages={requirements:()=>{},resources:async()=>{calls.push('resources');if(failure==='resources')throw Error('fixture failure');return {};},prepare:async()=>{calls.push('prepare');if(failure==='prepare')throw Error('fixture failure');if(failure==='cancel')abort.abort();},build:async()=>{calls.push('build');if(failure==='build')throw Error('fixture failure');return {schema:1,product_id:'forged'};}};
   await assert.rejects(execute(platform,work,{}, {stages,signal:abort.signal}));
   assert.equal(existsSync(join(work,'build-result.json')),false);assert.equal(existsSync(join(work,'.product-build.lock')),false);
   if(['resources','prepare','cancel'].includes(failure))assert.equal(calls.includes('build'),false);
  }finally{rmSync(work,{recursive:true});}
 }
 const work=sandbox();try{writeFileSync(join(work,'.product-build.lock'),'owned');await assert.rejects(execute(platform,work,{}));assert.equal(readFileSync(join(work,'.product-build.lock'),'utf8'),'owned');}finally{rmSync(work,{recursive:true});}
});

test('产品取消等待工具进程组退出，不提前交付结果',async()=>{
 const {runBuildProcess}=await import('./build.mjs'),work=sandbox(),abort=new AbortController();let polling,deadline;
 try{
  const pidFile=join(work,'descendant.pid');
  const script="const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);";
  const execution=runBuildProcess(process.execPath,['-e',script,pidFile],process.env,work,{capture:true,signal:abort.signal,timeout:5000});
  polling=setInterval(()=>{if(existsSync(pidFile))abort.abort();},20);deadline=setTimeout(()=>abort.abort(),2000);
  await assert.rejects(execution,/取消/);assert.ok(existsSync(pidFile));const pid=Number(readFileSync(pidFile,'utf8'));
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
 }finally{clearInterval(polling);clearTimeout(deadline);rmSync(work,{recursive:true});}
});

// 覆盖独立入口、单/多平台物理边界和源码输入排除，统一测试阶段才执行。
test('本仓target由当前平台声明决定，外部或链接工作根不能越界',()=>{
 for(const platform of Object.keys(contract.platforms)){
  const expected=join(root,'target',...(Object.keys(contract.platforms).length===1?[]:[platform]));
  assert.equal(productTarget(platform),expected);
 }
 assert.throws(()=>productTarget('undeclared-platform'));
 assert.throws(()=>checkWork(join(root,'..','foreign-work')),/target/);
 assert.throws(()=>checkWork(join(root,'target')),/target/);
 const work=sandbox();try{assert.equal(checkWork(work),work);}finally{rmSync(work,{recursive:true,force:true});}
});


// 复制本产品真实入口到自有测试现场；只替换资源供给边界，反向导入和CLI子进程真实执行。
test('CLI异步资源可反向导入唯一校验，正常参数和离线失败均准确收口',()=>{
 const area=sandbox();
 try{
  const source=join(area,'source'),scripts=join(source,'scripts'),file=join(scripts,'build.mjs');
  const platform=Object.keys(contract.platforms)[0];
  const work=join(source,'target',...(Object.keys(contract.platforms).length>1?[platform]:[]),'build');
  mkdirSync(scripts,{recursive:true});mkdirSync(work,{recursive:true});
  writeFileSync(file,readFileSync(join(root,'scripts/build.mjs')));
  writeFileSync(join(scripts,'flows.json'),JSON.stringify(contract));
  const provider=[
   "import {writeFileSync} from 'node:fs';",
   "import {join} from 'node:path';",
   "const refuse = false;",
   "export async function bootstrapNode(work,options){",
   " const owner=await import('./build.mjs');owner.checkWork(work);",
   " writeFileSync(join(work,'bootstrap.json'),JSON.stringify({offline:options.offline,work}));",
   " if(refuse&&options.offline)throw Error('合成离线缺少锁定资源');",
   " return {path:process.execPath};",
   "}",
   "export async function resources(platform,work,request,options){",
   " const owner=await import('./build.mjs');owner.checkWork(work);owner.platformContract(platform);",
   " if(refuse&&options.offline)throw Error('合成离线缺少锁定资源');",
   " return {schema:1,product_id:owner.contract.product_id,platform,work,offline:options.offline,request};",
   "}",
  ].join('\n');
  writeFileSync(join(scripts,'resources.mjs'),provider);
  const env={HOME:area,LANG:'C',PATH:''},marker=join(work,'bootstrap.json');
  const options={cwd:source,env,input:'{}',encoding:'utf8',timeout:5000,maxBuffer:1024*1024};
  const check=(result,status)=>{
   assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,status);
   assert.doesNotMatch(result.stderr,/unsettled top-level await/u);
  };
  // 普通模块导入不启动CLI；结果来自当前入口完整正文，不截取/重写其控制结构。
  const imported=spawnSync(process.execPath,['--input-type=module','--eval',
   "import {pathToFileURL} from 'node:url';await import(pathToFileURL("+JSON.stringify(file)+"));process.stdout.write('module-ready\\n');"],options);
  check(imported,0);assert.equal(imported.stdout,'module-ready\n');assert.deepEqual(readdirSync(work),[]);
  const input=JSON.stringify({schema:1,product_id:contract.product_id,platform,work});
  for(const offline of [false,true]){
   const result=spawnSync(process.execPath,[file,'resources',platform,'--work',work,...(offline?['--offline']:[])],{...options,input});
   check(result,0);
   assert.deepEqual(JSON.parse(result.stdout),{schema:1,product_id:contract.product_id,platform,work,offline,request:JSON.parse(input)});
  }
  // execute先真实完成反向导入和Node选择，再由原请求校验拒绝，不能以假Build成功代替。
  const invalid=spawnSync(process.execPath,[file,'execute',platform,'--work',work,'--offline'],{...options,input:'{"schema":99}'});
  check(invalid,1);assert.equal(invalid.stdout,'');assert.match(invalid.stderr,/公开Build请求身份或字段无效/u);
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{offline:true,work});
  rmSync(marker);
  for(const extra of [['--offline','--offline'],['--unknown']]){
   const result=spawnSync(process.execPath,[file,'execute',platform,'--work',work,...extra],options);
   check(result,1);assert.equal(result.stdout,'');assert.match(result.stderr,/固定入口参数无效/u);assert.equal(existsSync(marker),false);
  }
  const malformed=spawnSync(process.execPath,[file,'resources',platform,'--work',work],{...options,input:'{'});
  check(malformed,1);assert.equal(malformed.stdout,'');assert.match(malformed.stderr,/SyntaxError/u);
  const unknown=spawnSync(process.execPath,[file,'resources','unknown','--work',work],options);
  check(unknown,1);assert.match(unknown.stderr,/平台未声明/u);
  writeFileSync(join(scripts,'resources.mjs'),provider.replace('const refuse = false;','const refuse = true;'));
  for(const command of ['execute','resources']){
   const result=spawnSync(process.execPath,[file,command,platform,'--work',work,'--offline'],options);
   check(result,1);assert.equal(result.stdout,'');assert.match(result.stderr,/合成离线缺少锁定资源/u);
  }
  assert.equal(existsSync(join(work,'.product-build.lock')),false);
  assert.equal(existsSync(join(work,'build-result.json')),false);
 }finally{rmSync(area,{recursive:true,force:true});}
});

// 原生任务根脚本先加载唯一校验器；三个实际输出入口不得自行放宽GitHub边界。
test('Android插件输出、JNI暂存和独立AAR绑定同一生产路径校验',()=>{
 const plugin=readFileSync(join(root,'android/build.gradle'),'utf8');
 const native=readFileSync(join(root,'android/native/build.gradle'),'utf8');
 const builder=readFileSync(join(root,'scripts/build-native.sh'),'utf8');
 assert.equal((plugin.match(/rootProject[.]ext[.]verifyCitizenSdkAndroidOutput =/g)||[]).length,1);
 assert.equal((plugin.match(/rootProject[.]ext[.]verifyCitizenSdkAndroidOutput\(/g)||[]).length,2);
 assert.equal((native.match(/rootProject[.]ext[.]verifyCitizenSdkAndroidOutput\(/g)||[]).length,1);
 assert.match(plugin,/verifyCitizenSdkAndroidOutput\(androidBuildValue, 'Android output'\)/);
 assert.match(plugin,/verifyCitizenSdkAndroidOutput\(stagedAndroidAbiValue, 'Android native staging'\)/);
 assert.match(native,/verifyCitizenSdkAndroidOutput\(configuredBuildDir, 'Android output'\)/);
 assert.doesNotMatch(plugin+native,/must (?:remain )?(?:in|out)side the GitHub source checkout/);
 const prepare=builder.slice(builder.indexOf('prepare_android_gradle_project()'),builder.indexOf('build_android()'));
 assert.match(prepare,/apply from: new File\(System[.]getenv\('CITIZENSDK_SOURCE_DIR'\), 'android\/build[.]gradle'\)/);
 assert.match(prepare,/apply from: new File\(System[.]getenv\('CITIZENSDK_SOURCE_DIR'\), 'android\/native\/build[.]gradle'\)/);
});
