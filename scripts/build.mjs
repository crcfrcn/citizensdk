#!/usr/bin/env node
// 本产品独立拥有资源需求、工程准备与编译；公开回执仅提供验真资源，不提供执行命令。
import {spawn} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {chmodSync,closeSync,openSync,readlinkSync,unlinkSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const contract=JSON.parse(readFileSync(join(root,'scripts/flows.json'),'utf8'));
const product=contract.product_id, prefix=product.toUpperCase();
const inside=(base,path)=>{const r=relative(base,path);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
const fail=message=>{throw Error(product+' Build：'+message);};
export function checkWork(work) {
 if(typeof work!=='string'||!isAbsolute(work)||resolve(work)!==work||work===parse(work).root||!inside(join(root,'target'),work)||work===join(root,'target'))fail('工作根必须是本产品target内的规范目录');
 const parts=relative(join(root,'target'),work).split(sep);
 if(Object.keys(contract.platforms).length>1&&!Object.hasOwn(contract.platforms,parts[0]))fail('工作根平台未由本产品声明');
 const flow=parts[Object.keys(contract.platforms).length>1?1:0];
 if(!['build','ci','release','publish','test','tmp'].includes(flow))fail('工作根流程职责无效');
 let at=parse(work).root;for(const part of relative(at,work).split(sep)){at=join(at,part);const s=lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink())fail('工作根经过链接或非目录');}return work;
}
// 产品自己拥有target工作边界；测试与独立入口也不借用调用方的全局缓存。
export function productTarget(platform) {
 platformContract(platform);
 return join(root,'target',...(Object.keys(contract.platforms).length===1?[]:[platform]));
}
export function temporaryRoot(platform=Object.keys(contract.platforms)[0],scope='test',suppliedInput=process.env.TMPDIR) {
 if(!['test','tmp','build','ci','release','publish'].includes(scope))fail('临时目录职责无效');
 const endpoint=productTarget(platform),supplied=suppliedInput?resolve(suppliedInput):undefined;
 const directory=supplied&&supplied!==endpoint&&inside(endpoint,supplied)?supplied:join(endpoint,scope);
 let at=parse(directory).root;
 for(const part of relative(at,directory).split(sep)){
  at=join(at,part);if(!existsSync(at))mkdirSync(at,{mode:0o700});
  const info=lstatSync(at);if(!info.isDirectory()||info.isSymbolicLink())fail('工作目录经过链接或非目录');
 }
 checkWork(directory);return directory;
}
// 测试继承当前平台现场；独立执行没有任务身份时才选产品首个平台。
export const testRoot=platform=>{
 const workflow=String(process.env.GITHUB_WORKFLOW||'').split('.');
 const local=process.env.TMPDIR?relative(join(root,'target'),resolve(process.env.TMPDIR)).split(sep)[0]:undefined;
 const inherited=workflow[0]===product&&Object.hasOwn(contract.platforms,workflow[1])?workflow[1]
  :Object.hasOwn(contract.platforms,local)?local:undefined;
 return temporaryRoot(platform||inherited||Object.keys(contract.platforms)[0],'test');
};
// 远端Runner基础设施仍归GitHub；本产品步骤的可写临时目录归准确平台流程target。
export function remoteEnvironment(environment=process.env) {
 const [id,platform,flow,...extra]=String(environment.GITHUB_WORKFLOW||'').split('.');
 if(id!==product||extra.length||!Object.hasOwn(contract.platforms,platform)||!['ci','release'].includes(flow))fail('远端临时目录缺少准确产品平台流程身份');
 const temporary=temporaryRoot(platform,flow,null);
 return {...environment,RUNNER_TEMP:temporary,TMPDIR:temporary,TMP:temporary,TEMP:temporary};
}

// 展开来源根由本产品指定，调用者不识别任何产品来源名称。
export function resourceSourceRoot(name,work){checkWork(work);if(!/^[a-z][a-z0-9_]*$/u.test(name))fail('来源名称无效');return join(work,'git-sources',name);}
export function platformContract(platform) {
 if(!Object.hasOwn(contract.platforms,platform))fail('平台未声明');
 return contract.platforms[platform];
}
const sourceRoot=()=>existsSync(join(root,'app/pubspec.yaml'))?join(root,'app'):root;
const nativePlatform=platform=>platform.endsWith('android')?'Android':platform.includes('linux-arm')?'LinuxARM':platform.includes('linux-amd')?'LinuxAMD':platform.endsWith('windows')?'Windows':'macOS';
const osPlatform=platform=>platform.includes('linux-')?'linux':platform.replace(/^(?:host|client)-/u,'');

// 只读声明与原始锁；每个第一方Git来源必须同时匹配固定URL、40位提交和resolved-ref。
export function lockedSources() {
 const source=sourceRoot(),path=join(source,'pubspec.yaml');if(!existsSync(path))return [];
 const manifest=readFileSync(path,'utf8'),lock=readFileSync(join(source,'pubspec.lock'),'utf8'),result=[];
 for(const name of ['citizen_sdk','tatachat_sdk']) {
  const block=text=>[...text.matchAll(new RegExp('^  '+name+':\\r?\\n(?: {4,}[^\\n]*\\n|[ \\t]*\\n)+','gm'))];
  const a=block(manifest),b=block(lock);if(!a.length)continue;
  if(a.length!==1||b.length!==1)fail('Git来源记录不唯一');
  const value=(text,key)=>{const m=[...text.matchAll(new RegExp('^ +'+key+':\\s*([^\\n]+)$','gm'))];if(m.length!==1)fail('Git来源字段不唯一');return m[0][1].trim().replace(/^["']|["']$/gu,'');};
  const url=value(a[0][0],'url'),ref=value(a[0][0],'ref');
  if(!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+\.git$/u.test(url)||!/^[a-f0-9]{40}$/u.test(ref)
   ||value(a[0][0],'path')!=='.'||value(b[0][0],'url')!==url||value(b[0][0],'resolved-ref')!==ref||value(b[0][0],'ref')!==ref)fail('Git声明和锁不一致');
  result.push({name,url,ref});
 }return result;
}
export function requirements(platform,work) {
 checkWork(work);const declared=platformContract(platform);
 const locks=declared.locks.map(value=>({...value})),sources=lockedSources(),archives=[];
 for(const source of sources) {
  const packageRoot=join(work,'git-sources',source.name);
  if(existsSync(packageRoot)) {
   const path=source.name==='citizen_sdk'?'Cargo.lock':'native/Cargo.lock';
   locks.push({ecosystem:'cargo',path,source_package:source.name});
   if(source.name==='citizen_sdk') {
    const lock=JSON.parse(readFileSync(join(packageRoot,'scripts/dependencies.lock.json'),'utf8'));
    const p=nativePlatform(platform);
    const entries=[['zxing-cpp',lock.environment['zxing-cpp']],...((p==='LinuxARM'||p==='LinuxAMD')?Object.entries(lock.native.sources):p==='Windows'?[['sqlite',lock.native.sources.sqlite]]:[])];
    for(const [name,value]of entries)archives.push({ecosystem:'native',name,...value,group:'sdk-native'});
   }
  }
 }
 // 原生源归档坐标归本产品已有声明；准备后才提出展开源码的Cargo锁。

  const lock=JSON.parse(readFileSync(join(root,'scripts/dependencies.lock.json'),'utf8'));
  archives.push({ecosystem:'native',name:'zxing-cpp',...lock.environment['zxing-cpp'],group:'sdk-native'});
 for(const lock of declared.locks){const file=join(root,lock.path);if(!existsSync(file)||!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())fail('原始锁缺失或带链接：'+lock.path);}
 return {schema:1,product_id:product,platform,tools:declared.tools,locks,sources,archives};
}

export function resourceEnvironment(platform,work,receipt,base={}) {
 checkWork(work);const declared=platformContract(platform);
 if(!receipt||receipt.schema!==1||receipt.product_id!==product||receipt.platform!==platform||receipt.work!==work||receipt.offline!==true
  ||!receipt.tools||!receipt.dependencies||!receipt.archives)fail('资源回执身份无效');
 const env={HOME:base.HOME,USER:base.USER,LOGNAME:base.LOGNAME,LANG:'zh_CN.UTF-8',LC_ALL:'C',
  ...receipt.environment,TMPDIR:join(work,'tmp')+sep,TMP:join(work,'tmp'),TEMP:join(work,'tmp'),XDG_CACHE_HOME:join(work,'cache'),XDG_CONFIG_HOME:join(work,'config'),
  CARGO_TARGET_DIR:join(work,'work/cargo-target'),CARGO_NET_OFFLINE:'true',CARGO_INCREMENTAL:'1',
  npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false'};
 const allowedEnvironment=new Set(['PRODUCT_WORK_DIR','PRODUCT_BASH_BIN','PRODUCT_RSYNC_BIN','PATH','DEVELOPER_DIR','SDKROOT','DART_EXECUTABLE','XCODEBUILD','CODESIGN','SECURITY','XCRUN','XCODE_SELECT','CC','CXX','SWIFT','OTOOL','INSTALL_NAME_TOOL','LIPO','MAKE','AR','RANLIB','NM','STRIP','LLVM_NM','LD','LDCXX','CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_HOME','ANDROID_USER_HOME','ANDROID_EMULATOR_HOME','GRADLE_INIT_SCRIPT','GRADLE_USER_HOME']);
 if(Object.keys(receipt.environment||{}).some(key=>!allowedEnvironment.has(key)))fail('资源回执包含未声明环境或注入变量');
 for(const tool of declared.tools) {
  const value=receipt.tools[tool.id];
  if(!value||value.version!==tool.version||typeof value.path!=='string'||!isAbsolute(value.path)||resolve(value.path)!==value.path)fail('缺少准确版本的工具：'+tool.id);
  const s=lstatSync(value.path);if(!s.isFile()||s.isSymbolicLink()||!(s.mode&0o111)||realpathSync(value.path)!==value.path)fail('工具入口必须是普通执行器：'+tool.id);
 }
 const aliases={node:'NODE',git:'GIT',flutter:'FLUTTER',rust:'RUSTC',python:'PYTHON',java:'JAVA',gradle:'GRADLE',
  cmake:'CMAKE',cocoapods:'POD',protoc:'PROTOC',zig:'ZIG','worker-build':'WORKER_BUILD','wasm-bindgen':'WASM_BINDGEN_BIN','wasm-opt':'WASM_OPT_BIN',esbuild:'ESBUILD_BIN',
  perl:'PERL',m4:'M4',bison:'BISON',flex:'FLEX',tcl:'TCLSH',gettext:'GETTEXT',openssl:'OPENSSL'};
 for(const [id,name]of Object.entries(aliases))if(receipt.tools[id])env[name]=receipt.tools[id].path;
 // POSIX旧Shell不进入正式PATH；基础工具只通过产品已验真的GNU投影交付。
 const paths=Object.entries(receipt.tools).filter(([id])=>id!=='posix').map(([,value])=>dirname(value.path));
 env.PATH=[...new Set([...paths,...(env.PATH||'').split(':')].filter(Boolean))].join(':');
 if(env.GIT)env.PRODUCT_GIT_BIN=env.GIT;
 if(env.RUSTC)env.CARGO=join(dirname(env.RUSTC),'cargo');
 if(env.FLUTTER){env.FLUTTER_ROOT=dirname(dirname(env.FLUTTER));env.DART_EXECUTABLE=join(env.FLUTTER_ROOT,'bin/cache/dart-sdk/bin/dart');}
 if(env.PYTHON)env.PYTHONHOME=dirname(dirname(env.PYTHON));
 if(env.JAVA)env.JAVA_HOME=dirname(dirname(env.JAVA));
 if(env.OPENSSL)env.TUYU_OPENSSL_PREFIX=dirname(dirname(env.OPENSSL));
 const own=receipt.dependencies.own||{};
 // 原始锁要求的目录必须显式交付，不能落入用户默认缓存。
 for(const lock of declared.locks){const key={npm:'npmCache',pub:'pubCache',cargo:'cargoHome'}[lock.ecosystem];if(key&&!own[key])fail('缺少原始锁依赖回执：'+lock.ecosystem);}
 for(const [key,name]of [['npmCache','npm_config_cache'],['pubCache','PUB_CACHE'],['cargoHome','CARGO_HOME']])if(own[key]){
  checkDependency(work,own[key]);env[name]=own[key];
 }
 env[prefix+'_WORK_DIR']=work;env[prefix+'_BUILD_WORK_DIR']=join(work,'work');env[prefix+'_DEPENDENCY_DIR']=join(work,'dependencies');
 env[prefix+'_BUILD_DIR']=join(work,'work/flutter');env[prefix+'_ARTIFACT_DIR']=work;env[prefix+'_OFFLINE']='true';
 env.BUILD_DIR=join(work,'work/flutter');env[prefix+'_NODE_BIN']=env.NODE;
 env[prefix+'_PROJECT_ROOT']=join(work,'source-view',sourceRoot().replace(/^\/+/u,''));
 env.PRODUCT_SOURCE_DIR=env[prefix+'_PROJECT_ROOT'];
 if(env.GRADLE)env[prefix+'_GRADLE_BIN']=env.GRADLE;
 env.GRADLE_USER_HOME=join(work,'dependencies/gradle');env.CP_HOME_DIR=join(work,'dependencies/cocoapods');
 env[prefix+'_PUB_OFFLINE']='true';env.GRADLE_OPTS='-Dorg.gradle.project.android.builder.sdkDownload=false';
 if(receipt.archives.native)env.CHATSERVER_NATIVE_ARCHIVE=receipt.archives.native[0].path;
 if(receipt.archives.protocol)env.CHATSERVER_PROTOCOL_ARCHIVE=receipt.archives.protocol[0].path;
 if(product==='citizensdk'){env.CITIZENSDK_WORK_DIR=join(work,'work/native');env.CITIZENSDK_NATIVE_OUTPUT_DIR=join(work,'work/output');}
 return env;
}
function checkDependency(work,path){if(!isAbsolute(path)||resolve(path)!==path||!inside(work,path)||path===work||!lstatSync(path).isDirectory()||realpathSync(path)!==path)fail('依赖回执越界或无效');}
// 工程输入复制到本轮真实目录，保证包解析与写入均不进入正式源码；内部链接映射到同轮副本。
export function createView(source,destination) {
 if(realpathSync(source)!==source||!lstatSync(source).isDirectory()||!isAbsolute(destination)||resolve(destination)!==destination||inside(source,destination)||inside(destination,source))fail('工程输入与输出边界无效');
 let parent=dirname(destination);while(!existsSync(parent))parent=dirname(parent);
 if(!lstatSync(parent).isDirectory()||realpathSync(parent)!==parent)fail('工程输出经过链接');
 if(lstatSync(destination,{throwIfNoEntry:false}))fail('本轮工程已存在');mkdirSync(destination,{recursive:true,mode:0o700});
 const generated=new Set(['.git','.dart_tool','.gradle','.symlinks','Pods','build','target','node_modules','ephemeral','.cache','.DS_Store','swiftpm','dist','tsconfig.tsbuildinfo']);
 function visit(from,to){for(const name of readdirSync(from).sort()){if(generated.has(name))continue;const a=join(from,name),b=join(to,name),s=lstatSync(a);
  if(s.isDirectory()){mkdirSync(b);visit(a,b);}else if(s.isFile()){copyFileSync(a,b);}
  else if(s.isSymbolicLink()){const target=realpathSync(a);if(!inside(source,target)||!lstatSync(target).isFile())fail('源码链接越界');symlinkSync(join(destination,relative(source,target)),b);}else fail('源码文件类型无效');
 }}visit(source,destination);return destination;
}
// 归档坐标只接受本产品当前锁；完整性在build前核验，prepare允许稍后展开的锁。
export async function checkArchives(platform,work,receipt,complete=false) {
 const requested=(await requirements(platform,work)).archives;
 const expected=new Map(requested.map(value=>[value.group+'@'+value.name,value]));const seen=new Set();
 for(const [group,items]of Object.entries(receipt.archives)){
  if(!Array.isArray(items))fail('归档回执类型无效');
  for(const item of items){const key=group+'@'+item.name,wanted=expected.get(key);
   if(!wanted||seen.has(key)||['url','version','sha256'].some(key=>item[key]!==wanted[key])||typeof item.path!=='string'||!isAbsolute(item.path)||resolve(item.path)!==item.path||!inside(work,item.path))fail('归档回执与产品锁不一致');
   seen.add(key);const info=lstatSync(item.path);if(!info.isFile()||info.isSymbolicLink()||realpathSync(item.path)!==item.path||!info.size||createHash('sha256').update(readFileSync(item.path)).digest('hex')!==wanted.sha256)fail('锁定归档原件无效');
  }
 }
 if(complete&&seen.size!==expected.size)fail('缺少产品锁定归档回执');
}
async function stageArchives(work,receipt) {
 // 归档都来自回执；先按本产品锁回读摘要，再交给现有原生准备器，缺失时禁止下载。
 for(const item of receipt.archives['sdk-native']||[]) {
  if(createHash('sha256').update(readFileSync(item.path)).digest('hex')!==item.sha256)fail('原生归档摘要漂移');
  const directory=join(work,'sdk-native/sources/archives');mkdirSync(directory,{recursive:true});
  const suffix=new URL(item.url).pathname.endsWith('.zip')?'.zip':'.tar.gz';
  const target=join(directory,item.sha256+suffix);if(!existsSync(target))copyFileSync(item.path,target);
 }
}
export async function prepare(platform,work,receipt,base) {
 const env=resourceEnvironment(platform,work,receipt,base),source=sourceRoot();
 for(const name of ['work','tmp','cache','config','dependencies','stage'])mkdirSync(join(work,name),{recursive:true,mode:0o700});
 await checkArchives(platform,work,receipt);await stageArchives(work,receipt);

 return {schema:1,product_id:product,platform,work};
}
export async function build(platform,work,receipt,base) {
 const env=resourceEnvironment(platform,work,receipt,base),declared=platformContract(platform);
 await checkArchives(platform,work,receipt,true);await stageArchives(work,receipt);
 const shell=receipt.tools.bash?.path;
 if(!shell)fail('缺少显式Shell资源');
 const project=env[prefix+'_PROJECT_ROOT'];


  env.CITIZENSDK_WORK_DIR=join(work,'work/native');env.CITIZENSDK_NATIVE_OUTPUT_DIR=join(work,'work/output');
  env.CITIZENSDK_ZXING_SOURCE_DIR=join(work,'sdk-native/sources',JSON.parse(readFileSync(join(root,'scripts/dependencies.lock.json'),'utf8')).environment['zxing-cpp'].archive_root);
  await run(env.NODE,[join(root,'scripts/dependencies.mjs'),'prepare-environment','--scope','citizensdk','--platform','macOS','--work',join(work,'sdk-native/sources')],env);
  for(const path of ['work/native','work/output'])mkdirSync(join(work,path),{recursive:true});
  await run(shell,[join(root,'scripts/build-native.sh'),'host'],env);

 return completeBuild(platform,work,receipt,env);
}

// 每次调用拥有自己的取消和进程集合，导入API并发也不能共享执行状态。
const executions=new AsyncLocalStorage();
export async function runBuildProcess(file,args,env,cwd=root,{capture=false,input,accepted=[0],timeout=7200000,signal=executions.getStore()?.signal,passHost=false,streamError=false}={}) {
 signal?.throwIfAborted();
 return new Promise((ok,reject)=>{
  const child=spawn(file,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe',...(passHost?[3]:[])]});
  let stdout=[],stderr=[],bytes=0,reason,settled=false;
  const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')reason='无法取消产品工具进程组';}};
  let killer;
  const terminate=()=>{stop();clearTimeout(killer);killer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500);};
  const forced=setTimeout(()=>{reason='产品工具超时';terminate();},timeout);forced.unref();
  const abort=()=>{reason='产品任务已取消';terminate();};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const consume=(chunk,out)=>{bytes+=chunk.length;if(bytes>16*1024*1024){reason='产品工具输出超限';terminate();return;}out.push(chunk);if(!capture)process.stderr.write(chunk);};
  child.stdout.on('data',chunk=>consume(chunk,stdout));child.stderr.on('data',chunk=>{if(capture&&streamError)process.stderr.write(chunk);else consume(chunk,stderr);});
  child.stdin.on('error',()=>{reason='产品工具输入失败';stop();});
  child.once('error',()=>{reason='产品工具无法启动';});
  child.once('close',async(code,termination)=>{
   clearTimeout(forced);clearTimeout(killer);signal?.removeEventListener('abort',abort);
   // 主进程close不代表后代退出；未退出的同组工具必须停止并确认，之后才能清理材料。
   const alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
   if(alive()){reason??='产品工具退出后仍有后代';stop();for(let n=0;n<15&&alive();n++)await new Promise(r=>setTimeout(r,100));if(alive())try{process.kill(-child.pid,'SIGKILL');}catch{};for(let n=0;n<15&&alive();n++)await new Promise(r=>setTimeout(r,100));}
   if(alive()){reason='产品工具后代退出未确认，保留工作目录';const state=executions.getStore();if(state)state.unconfirmed=true;}
   if(settled)return;settled=true;
   if(reason||termination||!accepted.includes(code))reject(Error(reason||'产品工具执行失败'));
   else ok({stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),code});
  });
  child.stdin.end(input);
 });
}
const run=async(file,args,env,cwd=root,capture=false)=>(await runBuildProcess(file,args,env,cwd,{capture})).stdout;

export function outputDigest(path) {
 const hash=createHash('sha256');const base=path;
 function visit(file){const info=lstatSync(file);const name=relative(base,file);
  if(info.isSymbolicLink()){const real=realpathSync(file);if(!inside(base,real))fail('输出链接越界');hash.update(JSON.stringify([name,'link',readlinkSync(file)])+'\n');}
  else if(info.isDirectory()){hash.update(JSON.stringify([name,'directory'])+'\n');for(const child of readdirSync(file).sort())visit(join(file,child));}
  else if(info.isFile()&&info.nlink===1){hash.update(JSON.stringify([name,'file',Boolean(info.mode&0o111),info.size])+'\n');hash.update(readFileSync(file));}
  else fail('输出包含特殊文件或硬链接');
 }visit(path);return hash.digest('hex');
}
// 摘要只读执行源码；所属根技术文档及target等运行数据不改变编译身份。
function sourceDigest() {
 const hash=createHash('sha256'),rootData=new Set(['cache','target','rely','tools','tasks','TATA.md','MAP.md','CODEX.md','CLAUDE.md','README.md','CitizenSDK.md']);
 const generated=new Set(['.git','node_modules','.dart_tool','.gradle','.symlinks','Pods','build','target','ephemeral','.cache','.DS_Store']);
 function visit(path){for(const name of readdirSync(path).sort()){
  if(generated.has(name)||path===root&&rootData.has(name))continue;
  const file=join(path,name),info=lstatSync(file);hash.update(relative(root,file)+'\n');
  if(info.isDirectory())visit(file);else if(info.isFile()){hash.update(String(Boolean(info.mode&0o111)));hash.update(readFileSync(file));}
  else if(info.isSymbolicLink()){const real=realpathSync(file);if(!inside(root,real))fail('产品源码链接越界');hash.update(readlinkSync(file));}
  else fail('产品源码特殊输入未声明');
 }}visit(root);return hash.digest('hex');
}

export async function execute(platform,work,request={},options={}) {
 checkWork(work);platformContract(platform);
 if(!inside(productTarget(platform),work)||work===productTarget(platform))fail('执行工作根与当前产品平台不一致');
 options.signal?.throwIfAborted();
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['schema','product_id','platform','work','run_id','program_digest'].includes(k))
  ||request.schema!==undefined&&request.schema!==1||request.run_id!==undefined&&!/^[1-9][0-9]{8}$/u.test(request.run_id)||request.program_digest!==undefined&&!/^[a-f0-9]{64}$/u.test(request.program_digest)
  ||request.product_id!==undefined&&request.product_id!==product||request.platform!==undefined&&request.platform!==platform||request.work!==undefined&&request.work!==work)fail('公开Build请求身份或字段无效');
 chmodSync(work,0o700);
 const lock=join(work,'.product-build.lock'),resultFile=join(work,'build-result.json');
 if(existsSync(resultFile))fail('本轮完整Build已有结果，禁止复用旧终态');
 const handle=openSync(lock,'wx',0o600);closeSync(handle);
 const cancellation=new AbortController(),abort=()=>cancellation.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 const state={signal:cancellation.signal,cancellation,host:options.host,unconfirmed:false,finished:false};
 try{return await executions.run(state,async()=>{
  const initial=sourceDigest(),stages=options.stages||{requirements,resources:(...args)=>import('./resources.mjs').then(m=>m.resources(...args)),prepare,build};
  const unchanged=()=>{state.signal.throwIfAborted();if(sourceDigest()!==initial)fail('产品源码或锁在执行期间改变');};
  const resourcesOptions={signal:state.signal,offline:Boolean(options.offline),environment:options.environment||process.env};
  await stages.requirements(platform,work);unchanged();
  let receipt=await stages.resources(platform,work,request,resourcesOptions);unchanged();
  await stages.prepare(platform,work,receipt,resourcesOptions.environment);unchanged();
  await stages.requirements(platform,work);
  receipt=await stages.resources(platform,work,receipt,resourcesOptions);unchanged();
  const result=await stages.build(platform,work,receipt,resourcesOptions.environment);unchanged();
  checkBuildResult(result,platform,work,request.run_id);
  writeFileSync(resultFile,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});return result;
 });}finally{state.finished=true;state.socket?.destroy();options.signal?.removeEventListener('abort',abort);if(!state.unconfirmed)unlinkSync(lock);}
}
export function checkBuildResult(value,platform,work,runId) {
 const declared=platformContract(platform);
 if(!value||Object.keys(value).sort().join(',')!==(runId?'completion,files,platform,product_id,run_id,schema,work':'completion,files,platform,product_id,schema,work')
  ||value.schema!==1||value.product_id!==product||value.platform!==platform||value.work!==work||value.completion!==declared.completion
  ||runId&&value.run_id!==runId||!Array.isArray(value.files)||value.files.length!==declared.files.length)fail('完整Build结果身份或完成方式无效');
 for(let n=0;n<value.files.length;n++){const entry=value.files[n],file=join(work,declared.files[n]);
  if(Object.keys(entry).sort().join(',')!=='path,sha256'||entry.path!==file||!inside(work,file)||realpathSync(file)!==file||!/^[a-f0-9]{64}$/u.test(entry.sha256)||outputDigest(file)!==entry.sha256)fail('完整Build产物摘要或边界无效');}
 return value;
}
async function completeBuild(platform,work,receipt,env) {
 const declared=platformContract(platform);
 if(declared.completion==='device-install')fail('本产品未声明设备安装实现');
 if(declared.completion==='macos-artifact')for(const name of declared.files)await run(env.CODESIGN,['--verify','--deep','--strict',join(work,name)],env);
 const result={schema:1,product_id:product,platform,work,completion:declared.completion,
  files:declared.files.map(name=>{const path=join(work,name);if(!inside(work,path)||realpathSync(path)!==path)fail('Build候选越界');return {path,sha256:outputDigest(path)};})};
 if(receipt.run_id)result.run_id=receipt.run_id;return checkBuildResult(result,platform,work,receipt.run_id);
}

// 模块先完成初始化，资源模块才能反向导入本文件的唯一校验；异步CLI在独立Promise中执行。
async function runCLI(){
 const [command,platform,option,work,...extra]=process.argv.slice(2);
 if(command==='temporary-root') {
  if(work!==undefined||extra.length)fail('临时入口参数无效');
  const host=process.platform==='darwin'?'macos':process.platform==='win32'?'windows':process.platform==='linux'?(process.arch==='arm64'?'linux-arm':process.arch==='x64'?'linux-amd':undefined):undefined;
  const fallback=option?.endsWith('macos')?option.slice(0,-5)+host:option;
  const chosen=Object.hasOwn(contract.platforms,platform)?platform
   :platform&&option?.endsWith('-'+platform)&&Object.hasOwn(contract.platforms,option)?option
   :Object.hasOwn(contract.platforms,'host-'+platform)?'host-'+platform:!platform?(Object.hasOwn(contract.platforms,fallback)?fallback:option):platform;
  platformContract(chosen);process.stdout.write(temporaryRoot(chosen,'tmp')+'\n');
 } else {

 if(!['requirements','resources','prepare','build','execute'].includes(command)||option!=='--work'||extra.some(x=>x!=='--offline')||extra.length>1||extra.length&&!['resources','execute'].includes(command))fail('固定入口参数无效');
 if(command==='requirements')process.stdout.write(JSON.stringify(requirements(platform,work))+'\n');
 else{
  const cancellation=new AbortController();for(const name of ['SIGTERM','SIGINT'])process.once(name,()=>cancellation.abort());
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>2*1024*1024)fail('公开输入超限');}
  const request=input?JSON.parse(input):{},options={environment:process.env,signal:cancellation.signal,offline:extra.includes('--offline')};
  let result;
  if(command==='execute'){
   const {bootstrapNode}=await import('./resources.mjs');const node=await bootstrapNode(work,options);
   if(createHash('sha256').update(readFileSync(process.execPath)).digest('hex')!==createHash('sha256').update(readFileSync(node.path)).digest('hex')){
    const environment=Object.fromEntries(['HOME','USER','LOGNAME','LANG','LC_ALL','PRODUCT_TOOL_ROOT','PRODUCT_DEPENDENCY_ROOT','PRODUCT_HOST_FD'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
    result=JSON.parse((await runBuildProcess(node.path,[fileURLToPath(import.meta.url),command,platform,option,work,...extra],environment,root,{capture:true,streamError:true,input:JSON.stringify(request),signal:cancellation.signal,passHost:environment.PRODUCT_HOST_FD==='3'})).stdout);
   }else result=await execute(platform,work,request,options);
  }else if(command==='resources')result=await (await import('./resources.mjs')).resources(platform,work,request,options);
  else result=await executions.run({signal:cancellation.signal},()=>command==='prepare'?prepare(platform,work,request,process.env):build(platform,work,request,process.env));
  process.stdout.write(JSON.stringify(result)+'\n');
 }
}
}

// CLI拒绝必须真实失败，不能留成未完成顶层await或输出成功回执。
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 void runCLI().catch(error=>{console.error(error);process.exitCode=1;});
}
