// 按官方的要求或推荐实现，工具依赖有就复用，没有就下载，用最简单的实现方式；编译构建脚本只允许放编译构建代码和注释，禁止增加无关内容，禁止增加复杂的校验阻断。
// config.mjs：只负责配置声明；build.mjs：只负责编译构建实现和必要注释；sdk.yml：负责塔塔自动化的版本、作业编排及完整Artifact交付。
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpus,loadavg,totalmem,freemem,release} from 'node:os';
import {createReadStream,mkdirSync,mkdtempSync,rmdirSync,readFileSync,writeFileSync,copyFileSync,cpSync,rmSync,renameSync,symlinkSync,existsSync,realpathSync,lstatSync,readdirSync,utimesSync,readlinkSync} from 'node:fs';
import {join,dirname,resolve,basename,relative,sep,isAbsolute,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest as configuration,tools} from './config.mjs';
export function sdkName(version){return '公民SDK·SDK·v'+version;}

function id(value){if(!['string','number'].includes(typeof value))throw Error('SDK Run或产物身份无效');if(typeof value==='string'&&!/^[1-9]\d*$/u.test(value))throw Error('SDK Run或产物身份无效');const result=Number(value);if(!Number.isSafeInteger(result)||result<=0)throw Error('SDK Run或产物身份无效');return result;}
function sha(value){if(typeof value!=='string'||!/^[0-9a-f]{40}$/u.test(value))throw Error('SDK源码身份无效');return value;}

async function fileHash(file,signal){const hash=createHash('sha256');for await(const bytes of createReadStream(file,{signal}))hash.update(bytes);return hash.digest('hex');}
// 原始ZIP、JSON和校验文件必须闭合；校验不修改产物或重新构建SDK。
export async function verifyPackage(directory,source,signal){
 // 本地交付输入先限制版本为文件名安全的SemVer，避免回执中的路径进入文件操作。
 if(typeof source.version!=='string'||source.version.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(source.version))throw Error('SDK产物版本无效');
 const expected=[sdkName(source.version)+'.zip',sdkName(source.version)+'.json',sdkName(source.version)+'.sha256'];
 if(realpathSync(directory)!==resolve(directory)||JSON.stringify(readdirSync(directory).sort())!==JSON.stringify([...expected].sort()))throw Error('SDK产物文件闭集无效');
 for(const file of expected){const info=lstatSync(join(directory,file));if(!info.isFile()||info.size===0)throw Error('SDK产物文件类型或长度无效');}
 if(lstatSync(join(directory,expected[1])).size>65536||lstatSync(join(directory,expected[2])).size>4096)throw Error('SDK产物回执超过边界');
 let proof;try{proof=JSON.parse(readFileSync(join(directory,expected[1]),'utf8'));}catch{throw Error('SDK产物回执格式无效');}
 if(proof?.product_id!==configuration.product_id||proof.platform!=='sdk'||proof.software_version!==source.version||proof.git_commit_sha!==source.sourceSha||proof.producer_run_id!==source.sourceRun||proof.producer_run_attempt!==source.sourceAttempt||!Array.isArray(proof.assets)||proof.assets.length!==1||proof.assets[0]?.name!==expected[0])throw Error('SDK产物回执与来源不一致');
 const zip=await fileHash(join(directory,expected[0]),signal),json=await fileHash(join(directory,expected[1]),signal);
 if(proof.assets[0].sha256!==zip||readFileSync(join(directory,expected[2]),'utf8')!==zip+'  '+expected[0]+'\n'+json+'  '+expected[1]+'\n')throw Error('SDK产物校验失败');
 return proof;
}

// 完整交付包使用同一五项Apple标准内部链接；不接受其它链接或越界路径。
const framework='darwin/CitizenSDK.xcframework/macos-arm64/CitizenSDK.framework/';
const frameworkLinks={'Versions/Current':'A',Headers:'Versions/Current/Headers',Modules:'Versions/Current/Modules',Resources:'Versions/Current/Resources',CitizenSDK:'Versions/Current/CitizenSDK'};
async function unpackPackage(archive,output,signal){
 const names=(await run('unzip',['-Z1',archive],{capture:true,signal})).split('\n');
 if(!names.length||names.length>65536||new Set(names).size!==names.length)throw Error('SDK归档条目无效');
 const lines=(await run('unzip',['-Z','-l',archive],{capture:true,signal})).split('\n').filter(value=>/^[dl-][rwxstST-]{9}\s/u.test(value));
 if(lines.length!==names.length)throw Error('SDK归档类型信息不完整');
 const links=[];let total=0;
 for(const name of names){
  const path=name.replace(/\/$/u,'').split('/');
  if(!['output','__MACOSX'].includes(path[0])||path.some(part=>!part||part==='.'||part==='..'||/[\s\\:\x00-\x1f<>|?*]/u.test(part)))throw Error('SDK归档路径无效');
  const rows=lines.filter(value=>value.endsWith(' '+name));if(rows.length!==1)throw Error('SDK归档条目不唯一');
  const row=rows[0],size=Number(row.trim().split(/\s+/u)[3]);if(!Number.isSafeInteger(size)||size<0||(total+=size)>8*1024**3)throw Error('SDK归档长度越界');
  if(row[0]==='l'){
   const prefix='output/'+framework,target=frameworkLinks[name.slice(prefix.length)];
   if(!name.startsWith(prefix)||!target||size>128||(await run('unzip',['-p',archive,name],{capture:true,signal,trim:false}))!==target)throw Error('SDK归档链接越界');
   links.push(name);
  }else if(row[0]==='d'&&!name.endsWith('/')||row[0]==='-'&&name.endsWith('/'))throw Error('SDK归档类型不符');
 }
 if(names.some(name=>links.some(link=>name.startsWith(link+'/'))))throw Error('SDK归档禁止经链接写入');
 await run('unzip',['-q',archive,'-d',output],{signal});
}
// 消费者提供SDK交付的原ZIP/JSON/sha256目录；这里只装配，不联网或编译。
export async function consume({directory,sourceSha,output,sourceRun,sourceAttempt,signal}={}){
 const owned=signal===undefined?new AbortController():null;signal??=owned.signal;let work,safe=true;
 const abort=()=>owned.abort();if(owned)for(const event of ['SIGINT','SIGTERM'])process.once(event,abort);
 try{
 signal.throwIfAborted();sha(sourceSha);
 if(typeof directory!=='string'||realpathSync(directory)!==resolve(directory)||typeof output!=='string'||resolve(output)!==output||existsSync(output)||realpathSync(dirname(output))!==dirname(output))throw Error('SDK消费输入或输出无效');
 if(output===directory||output.startsWith(directory+sep)||directory.startsWith(output+sep))throw Error('SDK消费目录交叠');
 const json=readdirSync(directory).filter(name=>name.endsWith('.json'));if(json.length!==1)throw Error('SDK完整交付回执不唯一');
 const receipt=join(directory,json[0]),info=lstatSync(receipt);if(!info.isFile()||info.size>65536)throw Error('SDK完整交付回执无效');
 let proof;try{proof=JSON.parse(readFileSync(receipt,'utf8'));}catch{throw Error('SDK完整交付回执格式无效');}
 const source={sourceRun:id(proof?.producer_run_id),sourceAttempt:id(proof?.producer_run_attempt),sourceSha,version:proof.software_version};
 sdkName(source.version);if(sourceRun!==undefined&&id(sourceRun)!==source.sourceRun||sourceAttempt!==undefined&&id(sourceAttempt)!==source.sourceAttempt)throw Error('SDK交付Run或attempt不一致');await verifyPackage(directory,source,signal);signal.throwIfAborted();
 work=mkdtempSync(join(dirname(output),'sdk-'));
  const input=join(work,'input');mkdirSync(input);for(const extension of ['zip','json','sha256'])copyFileSync(join(directory,sdkName(source.version)+'.'+extension),join(input,sdkName(source.version)+'.'+extension));await verifyPackage(input,source,signal);
  const stage=join(work,'package');mkdirSync(stage);await unpackPackage(join(input,sdkName(source.version)+'.zip'),stage,signal);
  const packageRoot=join(stage,'output');verifyComplete(packageRoot);
  const pub=join(packageRoot,'pubspec.yaml');if(!lstatSync(pub).isFile()||lstatSync(pub).size>65536)throw Error('SDK包声明长度无效');
  if(!new RegExp('^version: '+source.version.replaceAll('.','\\.')+'$','mu').test(readFileSync(join(packageRoot,'pubspec.yaml'),'utf8')))throw Error('SDK包版本与回执不一致');
  verifyConsumer(packageRoot);
  const view=createFlutterSourceView(packageRoot,join(work,'view'));verifyConsumer(view);
  signal.throwIfAborted();if(existsSync(output))throw Error('SDK消费输出已存在');renameSync(view,output);
  return {output,version:source.version,sourceSha,sourceRun:source.sourceRun,sourceAttempt:source.sourceAttempt};
 }catch(error){safe=!error?.keepWork;throw error;}finally{if(owned)for(const event of ['SIGINT','SIGTERM'])process.removeListener(event,abort);if(work&&safe)rmSync(work,{recursive:true,force:true});}
}

export const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export function claimCache(work){
 const base=join(root,'target/cache'),lock=join(base,'lock');let owned=false;
 try{mkdirSync(base,{recursive:true});if(realpathSync(base)!==base)throw Error('缓存经过链接');mkdirSync(lock);owned=true;const cargo=join(base,'rust');mkdirSync(cargo,{recursive:true});if(realpathSync(cargo)!==cargo)throw Error('缓存经过链接');return {cargo,project:join(base,'project'),release(){rmdirSync(lock);}};}
 catch{if(owned)rmdirSync(lock);return {cargo:join(work,'rust'),release(){}};}
}
const controller=new AbortController();
// 只读核对本轮独立进程组；signal 0也受权限检查，不能用EPERM推断已经退出。
export async function waitGroup(pid,{env={},attempts=50,inspect=spawnSync,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 const unresolved=(reason,cause)=>Object.assign(new Error('工具后代退出尚未确认，保留现场：'+reason,{cause}),{keepWork:true});
 if(!Number.isSafeInteger(pid)||pid<=1||pid>2147483647||!Number.isSafeInteger(attempts)||attempts<0||attempts>50)throw unresolved('进程组身份或等待边界无效');
 for(let attempt=0;attempt<=attempts;attempt++){
  let result;try{result=inspect('ps',['-A','-o','pgid=','-o','stat='],{env,encoding:'utf8',maxBuffer:16*1024**2});}catch(error){throw unresolved('进程表读取失败',error);}
  if(result?.error||result?.status!==0||result?.signal||typeof result?.stdout!=='string'||result.stdout.length>16*1024**2)throw unresolved('进程表读取失败',result?.error);
  const rows=result.stdout.trim().split(/\r?\n/u);let active=false;
  if(!rows[0])throw unresolved('进程表为空');
  for(const row of rows){
   const match=/^\s*(\d+)\s+([A-Za-z?][A-Za-z0-9<>+_-]*)\s*$/u.exec(row),group=match?Number(match[1]):NaN;
   if(!match||!Number.isSafeInteger(group)||group>2147483647)throw unresolved('进程表格式无效');
   // Z已不能运行或写入；未知修饰符仍按活动成员处理，不能抢先清场。
   if(group===pid&&!/^Z[<NLsl+]*$/u.test(match[2]))active=true;
  }
  if(!active)return;
  if(attempt===attempts)throw unresolved('仍有活动或未知状态成员');
  try{await pause(100);}catch(error){throw unresolved('等待被中断',error);}
 }
}
export async function run(command,args,{cwd=root,env={},capture=false,signal:taskSignal=controller.signal,trim=true}={}){
 taskSignal.throwIfAborted();let batch=false;
 if(process.platform==='win32'&&/\.(?:bat|cmd)$/iu.test(command)){if([command,...args].some(value=>/["%!^&|<>\r\n]/u.test(value)))throw Error('Windows工具参数含Shell控制字符');args=['/d','/s','/c','\"'+[command,...args].map(value=>'\"'+value+'\"').join(' ')+'\"'];command=process.env.COMSPEC||'cmd.exe';batch=true;}
 const environment={...process.env,...env};delete environment.GH_TOKEN;delete environment.GITHUB_TOKEN;
 // Git Bash会把自己的link.exe放到PATH前端；本产品始终使用官方MSVC目录和链接器。
 if(process.platform==='win32')environment.MSBUILDDISABLENODEREUSE='1';
 if(process.platform==='win32'&&process.env.CITIZENSDK_MSVC_BIN){const path=Object.entries(environment).find(([key])=>key.toLowerCase()==='path')?.[1]||'';for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];environment.PATH=process.env.CITIZENSDK_MSVC_BIN+';'+path;}

 return new Promise((ok,fail)=>{
  const child=spawn(command,args,{cwd,env:environment,windowsVerbatimArguments:batch,detached:process.platform!=='win32',stdio:['ignore',capture?'pipe':process.stderr,process.stderr]});let output='',error,timer,stopping;
  const kill=signal=>{try{if(process.platform==='win32'){stopping??=new Promise(resolve=>{const stop=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});stop.once('error',()=>resolve(false));stop.once('close',code=>resolve(code===0));});}else process.kill(-child.pid,signal);}catch{}};
  const stop=()=>{kill('SIGTERM');timer=setTimeout(()=>kill('SIGKILL'),2000);};taskSignal.addEventListener('abort',stop,{once:true});
  child.stdout?.on('data',bytes=>{output+=bytes;if(output.length>16*1024**2){error=Error('工具结果超限');stop();}});child.once('error',value=>{error=value;});
  child.once('close',async(code,signal)=>{taskSignal.removeEventListener('abort',stop);
   if(stopping&&!await stopping){clearTimeout(timer);const failure=Error('Windows进程树退出尚未确认，保留现场');failure.keepWork=true;return fail(failure);}
   if(taskSignal.aborted&&process.platform!=='win32')await new Promise(resolve=>setTimeout(resolve,2100));
   clearTimeout(timer);
   if(process.platform!=='win32'&&child.pid){
    // 正常收尾仍最多等50次100ms；取消保留原2100ms后只核对一次的上限。
    try{await waitGroup(child.pid,{env:environment,attempts:taskSignal.aborted?0:50});}catch(value){return fail(value);}
   }
   error||code!==0||signal||taskSignal.aborted?fail(error||Error(basename(command)+'执行失败')):ok(trim?output.trim():output);
  });
 });
}
function put(path,bytes){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes,{flag:'wx'});}
function copy(source,output){mkdirSync(dirname(output),{recursive:true});cpSync(source,output,{recursive:true,verbatimSymlinks:true});}
export function createFlutterSourceView(source,output){
 if(realpathSync(source)!==source||resolve(output)!==output||source===output||output.startsWith(source+sep)&&!output.startsWith(join(source,'target')+sep)||existsSync(output))throw Error('SDK工程输入输出无效');
 mkdirSync(output,{recursive:true});
 const excluded=new Set(['.git','target','build','.dart_tool','.gradle','node_modules','Pods','.DS_Store']);
 function visit(at){for(const name of readdirSync(at)){if(excluded.has(name))continue;const from=join(at,name),entry=relative(source,from),to=join(output,entry),info=lstatSync(from);
  if(info.isDirectory()){mkdirSync(to,{recursive:true});visit(from);}else if(info.isFile()){copyFileSync(from,to);utimesSync(to,info.atime,info.mtime);}
  else if(info.isSymbolicLink()){
   // SDK组包只允许Apple标准Framework的五个内部相对链接，禁止借包内路径访问外部文件。
   const frame=framework,path=entry.split(sep).join('/'),links=frameworkLinks;
   const target=realpathSync(from);if(!path.startsWith(frame)||links[path.slice(frame.length)]!==readlinkSync(from)||!target.startsWith(join(source,frame,'Versions/A')+sep)&&target!==join(source,frame,'Versions/A'))throw Error('SDK源码链接越界');symlinkSync(readlinkSync(from),to,lstatSync(target).isDirectory()?'dir':'file');
  }else throw Error('SDK源码输入禁止特殊文件');
 }}visit(source);
 return output;
}
export function assertFlutterSourceView(source,output){
 for(const name of ['pubspec.yaml','pubspec.lock','include/citizensdk.h'])if(!readFileSync(join(source,name)).equals(readFileSync(join(output,name))))throw Error('SDK原锁或公开头漂移');return output;
}
export function citizenSdkInternalHeader(){return "#ifndef CITIZENSDK_INTERNAL_H\n#define CITIZENSDK_INTERNAL_H\n#include \"citizensdk.h\"\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n/* 同步硬件元数据接口，配置/输入只借用于本次调用。generation action:1 ensure,2 active,3 owner,4 retire,5 Linux物理对象存在性。 */\nint32_t citizensdk_store_generation(const citizensdk_store_v1_t*,uint32_t,const citizensdk_host_wallet_key_ref_v1_t*,const citizensdk_host_id128_t*,uint8_t*);\nint32_t citizensdk_store_generations(const citizensdk_store_v1_t*,citizensdk_host_wallet_key_ref_v1_t*,uint64_t,uint64_t*);\n/* object action:1 load,2 store-owned,3 active,4 delete。五字段固定为key_name/public/private/name/salt；输出先全部验容量后再写，均为密封对象或公开身份。 */\nint32_t citizensdk_store_object(const citizensdk_store_v1_t*,uint32_t,const citizensdk_host_wallet_key_ref_v1_t*,const citizensdk_host_id128_t*,const citizensdk_bytes_view_t*,const citizensdk_mutable_bytes_view_t*,uint64_t*,uint8_t*);\n#ifdef __cplusplus\n}\n#endif\n#endif\n";}
function privateHeaders(project,work){
 const directory=join(work,'private');put(join(directory,'citizensdk_internal.h'),citizenSdkInternalHeader());copy(join(project,'image/citizensdk_qr_image.h'),join(directory,'citizensdk_qr_image.h'));
 put(join(directory,'module.modulemap'),'module CitizenSDKInternal { header "citizensdk_internal.h" header "citizensdk_qr_image.h" export * }\n');return directory;
}
function files(directory){return readdirSync(directory,{recursive:true}).map(name=>join(directory,name)).filter(path=>lstatSync(path).isFile());}
async function cargo(project,triple,env){
 await run('rustup',['target','add','--toolchain',tools.rust,triple],{env});
 // 正式目标只生成实际链接或交付的一种Core；测试沿原Cargo声明保留rlib。
 await run('cargo',['rustc','--locked','--release','-p','citizensdk','--lib','--crate-type',triple.includes('-apple-')?'staticlib':'cdylib','--target',triple],{cwd:project,env});return join(env.CARGO_TARGET_DIR,triple,'release');
}
export function verifyImageSymbols(output,header){
 const expected=new Set([...header.matchAll(/\b(citizensdk_(?:qr_image_|dart_)[a-z0-9_]+)\s*\(/gu)].map(m=>m[1]));
 const actual=new Set(output.trim().split('\n').map(line=>line.trim().split(/\s+/u).at(-1)?.replace(/^_/u,'').split('@')[0]).filter(name=>/^citizensdk_(?:qr_image_|dart_)/u.test(name||'')));
 if(expected.size!==6||actual.size!==expected.size||[...expected].some(name=>!actual.has(name)))throw Error('图像/Dart辅助导出与公开头不一致');
}
async function verifySymbols(file,project,env,apple=false){
 const header=readFileSync(join(project,'include/citizensdk.h'),'utf8'),expected=[...header.matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/gu)].map(value=>value[1]);
 const output=await run(apple?'xcrun':env.SDK_NM||'nm',apple?['nm','-gU',file]:['-D','--defined-only',file],{env,capture:true});
 if(apple)verifyImageSymbols(output,readFileSync(join(project,'image/citizensdk_qr_image.h'),'utf8'));
 for(const name of expected)if(!new RegExp('(?:^|\\s)_?'+name+'(?:\\s|$)','mu').test(output))throw Error('SDK公开ABI缺失：'+name);
 return output;
}
async function android(project,work,env,headers,device=false,testing={}){
 const ndk=process.env.ANDROID_NDK_HOME||process.env.ANDROID_NDK_ROOT;
 const bin=join(ndk,'toolchains/llvm/prebuilt',process.platform==='darwin'?'darwin-x86_64':'linux-x86_64','bin'),triple='aarch64-linux-android';
 const environment={...env,CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:'-C link-arg=-Wl,-soname,libcitizensdk.so',CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:join(bin,'aarch64-linux-android24-clang'),CC_aarch64_linux_android:join(bin,'aarch64-linux-android24-clang'),AR_aarch64_linux_android:join(bin,'llvm-ar'),SDK_NM:join(bin,'llvm-nm')};
 const core=await cargo(project,triple,environment),stage=join(work,'core/arm64-v8a');copy(join(core,'libcitizensdk.so'),join(stage,'libcitizensdk.so'));
 await run(join(bin,'llvm-strip'),['--strip-unneeded',join(stage,'libcitizensdk.so')],{env:environment});await verifySymbols(join(stage,'libcitizensdk.so'),project,environment);
 const dynamic=await run(join(bin,'llvm-readelf'),['--dynamic-table',join(stage,'libcitizensdk.so')],{env:environment,capture:true});if(!/\(SONAME\).*\[libcitizensdk\.so\]/u.test(dynamic))throw Error('Android Core装载名称无效');
 const metadata=JSON.parse(await run('cargo',['metadata','--locked','--format-version','1'],{cwd:project,env:environment,capture:true}));
 const declaration=join(project,'android/build.gradle');if(!lstatSync(declaration).isFile()||lstatSync(declaration).size>65536)throw Error('SDK Android声明无效');
 const version=/implementation 'rustls:rustls-platform-verifier:([^']+)'/u.exec(readFileSync(join(project,'android/build.gradle'),'utf8'))?.[1];
 const verifier=metadata.packages.filter(value=>value.name==='rustls-platform-verifier-android'&&value.version===version);if(verifier.length!==1)throw Error('Android证书组件没有唯一原锁来源');
 const gradleHome=process.env.GRADLE_USER_HOME||join(dirname(env.CARGO_TARGET_DIR),'gradle-home');mkdirSync(gradleHome,{recursive:true});const maven=join(dirname(verifier[0].manifest_path),'maven');copy(maven,join(project,'android/maven'));
 for(const name of ['settings.gradle','build.gradle','native/build.gradle'])put(join(work,'gradle-project',name),`apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/${name}')\n`);
 const androidEnv={...environment,CITIZENSDK_WORK_DIR:work,CITIZENSDK_SOURCE_DIR:project,CITIZENSDK_ANDROID_BUILD_DIR:join(work,'gradle-output'),CITIZENSDK_ANDROID_CORE_DIR:stage,CITIZENSDK_INTERNAL_INCLUDE_DIR:headers,CITIZENSDK_FLUTTER_ROOT:process.env.FLUTTER_ROOT,GRADLE_USER_HOME:gradleHome};
 // 真机安装只构建原生组件；SDK正式交付仍执行原测试。
 await run('gradle',[...testing.testDevice?['--offline']:[],'--no-daemon','-Pandroid.onlyEnableUnitTestForTheTestedBuildType=false','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),...device?[]:[':native:testReleaseUnitTest'],':native:assembleRelease'],{env:androidEnv});
 const output=join(work,'output/android'),aar=join(work,'gradle-output/native/outputs/aar/native-release.aar');copy(maven,join(output,'maven'));copy(aar,join(output,'citizensdk.aar'));copy(join(stage,'libcitizensdk.so'),join(output,'src/main/jniLibs/arm64-v8a/libcitizensdk.so'));
 await run('unzip',['-o',aar,'jni/arm64-v8a/libcitizensdk_jni.so','-d',join(work,'aar')],{env:androidEnv});copy(join(work,'aar/jni/arm64-v8a/libcitizensdk_jni.so'),join(output,'src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so'));
 copy(join(work,'aar/jni/arm64-v8a/libcitizensdk_jni.so'),join(stage,'libcitizensdk_jni.so'));verifyImageSymbols(await run(join(bin,'llvm-nm'),['-D','--defined-only',join(stage,'libcitizensdk_jni.so')],{env:environment,capture:true}),readFileSync(join(project,'image/citizensdk_qr_image.h'),'utf8')); const dependencies=await run(join(bin,'llvm-readelf'),['--dynamic-table',join(stage,'libcitizensdk_jni.so')],{env:environment,capture:true});if(!/\(NEEDED\).*\[libcitizensdk\.so\]/u.test(dependencies)||/\(NEEDED\).*\[[^\]]*[\\/]/u.test(dependencies))throw Error('Android JNI装载依赖无效');if(!device)await run('gradle',[...testing.testDevice?['--offline']:[],'--no-daemon','-Pandroid.onlyEnableUnitTestForTheTestedBuildType=false','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),':testReleaseUnitTest'],{env:androidEnv});
 if(testing.testDevice){
  // Flutter JVM已消费Release JNI；instrumentation JNI必须只来自当前CMake，不再作为jniLibs输入。
  rmSync(join(stage,'libcitizensdk_jni.so'));
  console.error(JSON.stringify({target:'AndroidJVM',native:junit(join(work,'gradle-output/native/test-results/testReleaseUnitTest')),flutter:junit(join(work,'gradle-output/flutter/test-results/testReleaseUnitTest'))}));return androidTests(work,androidEnv,testing.testDevice,testing.performance);}
}
// Cargo与现有CMake各自拥有准确输出；内部依赖目录的同名库不参与最终链接选择。
export function appleLibraries(core,qr){
 const libraries=[join(core,'libcitizensdk.a'),join(qr,'libcitizensdk_qr_image.a'),join(qr,'zxing/core/libZXing.a')];
 for(const file of libraries){const info=lstatSync(file);if(!info.isFile()||!info.size)throw Error('Apple静态库缺失或为空：'+file);}
 return libraries;
}
async function apple(project,work,env,headers,version,device=false,testing={}){
 const frameworks=[];
 for(const [triple,sdk,target,identity,platform,minimum]of [
  ['aarch64-apple-ios','iphoneos','arm64-apple-ios16.0','arm64-apple-ios','iPhoneOS','16.0'],
  ['aarch64-apple-ios-sim','iphonesimulator','arm64-apple-ios16.0-simulator','arm64-apple-ios-simulator','iPhoneSimulator','16.0'],
  ['aarch64-apple-darwin','macosx','arm64-apple-macosx13.0','arm64-apple-macos','MacOSX','13.0']].filter((_,index)=>testing.target==='iOS'?index===1:testing.target==='macOS'?index===2:!device||index===0)){
  const sdkPath=await run('xcrun',['--sdk',sdk,'--show-sdk-path'],{capture:true}),environment={...env,SDKROOT:sdkPath,IPHONEOS_DEPLOYMENT_TARGET:'16.0',MACOSX_DEPLOYMENT_TARGET:'13.0',CARGO_PROFILE_RELEASE_STRIP:'false'};
  const core=await cargo(project,triple,environment),slice=join(work,triple),framework=join(slice,'CitizenSDK.framework'),mac=sdk==='macosx',content=mac?join(framework,'Versions/A'):framework;
  const modules=join(content,'Modules/CitizenSDK.swiftmodule'),resources=mac?join(content,'Resources'):content;mkdirSync(modules,{recursive:true});
  for(const name of ['citizensdk.h','citizensdk_types.h'])copy(join(project,'include',name),join(content,'Headers',name));copy(join(project,'image/citizensdk_qr_image.h'),join(content,'Headers/citizensdk_qr_image.h'));
  put(join(content,'Modules/module.modulemap'),'framework module CitizenSDK { umbrella header "citizensdk.h" explicit module QrImage { header "citizensdk_qr_image.h" export * } export * module * { export * } }\n');copy(join(project,'chain'),join(resources,'chain'));copy(join(project,'darwin/src/PrivacyInfo.xcprivacy'),join(resources,'PrivacyInfo.xcprivacy'));
  const plist=join(resources,'Info.plist');put(plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>CitizenSDK</string><key>CFBundleIdentifier</key><string>org.citizen.sdk</string><key>CFBundleName</key><string>CitizenSDK</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleSupportedPlatforms</key><array><string>${platform}</string></array><key>${mac?'LSMinimumSystemVersion':'MinimumOSVersion'}</key><string>${minimum}</string></dict></plist>`);
  if(mac){for(const [name,to]of [['Versions/Current','A'],['Headers','Versions/Current/Headers'],['Modules','Versions/Current/Modules'],['Resources','Versions/Current/Resources']])symlinkSync(to,join(framework,name));}
  const qr=join(slice,'qr');await run('cmake',['-S',join(project,'image'),'-B',qr,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_SYSTEM_NAME='+(mac?'Darwin':'iOS'),'-DCMAKE_OSX_SYSROOT='+sdkPath,'-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET='+minimum,'-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY','-DCITIZENSDK_ZXING_SOURCE_DIR='+process.env.CITIZENSDK_ZXING_SOURCE_DIR,'-DCITIZENSDK_DART_INCLUDE_DIR='+join(process.env.FLUTTER_ROOT,'bin/cache/dart-sdk/include')],{env:environment});await run('cmake',['--build',qr,'--config','Release','--parallel'],{env:environment});
  const libraries=appleLibraries(core,qr);
  const swift=readdirSync(join(project,'darwin/src')).filter(name=>name.endsWith('.swift')).sort().map(name=>join(project,'darwin/src',name));
  // 每个切片只编译一次Swift源码；探测和正式链接复用同一目标文件及原导出规则。
  const object=join(slice,'CitizenSDK.o');
  await run('xcrun',['swiftc',...swift,'-parse-as-library','-swift-version','5','-warnings-as-errors','-strict-concurrency=complete','-O','-whole-module-optimization','-enable-library-evolution','-emit-object','-emit-module','-emit-module-path',join(modules,identity+'.swiftmodule'),'-emit-module-interface-path',join(modules,identity+'.swiftinterface'),'-module-name','CitizenSDK','-module-cache-path',join(slice,'modules'),'-sdk',sdkPath,'-target',target,'-import-underlying-module','-F',slice,'-I',headers,'-Xcc','-I'+join(content,'Headers'),'-o',object],{env:environment});
  const args=[object,'-emit-library','-module-name','CitizenSDK','-sdk',sdkPath,'-target',target,...libraries.flatMap(path=>['-Xlinker','-force_load','-Xlinker',path]),'-Xlinker','-install_name','-Xlinker',mac?'@rpath/CitizenSDK.framework/Versions/A/CitizenSDK':'@rpath/CitizenSDK.framework/CitizenSDK','-framework','Security','-framework','LocalAuthentication','-lc++','-lsqlite3'];
  const probe=join(slice,'probe');await run('xcrun',['swiftc',...args,'-o',probe],{env:environment});const symbols=await verifySymbols(probe,project,environment,true);
  const exports=symbols.split('\n').map(line=>line.trim().split(/\s+/u).at(-1)).filter(name=>/^_(?:citizensdk_|\$s10CitizenSDK)/u.test(name));put(join(slice,'exports'),[...new Set(exports)].sort().join('\n')+'\n');
  await run('xcrun',['swiftc',...args,'-Xlinker','-exported_symbols_list','-Xlinker',join(slice,'exports'),'-o',join(content,'CitizenSDK')],{env:environment});if(mac)symlinkSync('Versions/Current/CitizenSDK',join(framework,'CitizenSDK'));frameworks.push('-framework',framework);
 }
 const output=join(work,'output/darwin/CitizenSDK.xcframework');mkdirSync(dirname(output),{recursive:true});await run('xcodebuild',['-create-xcframework',...frameworks,'-output',output],{env});
 // Xcode会移除已有稳定接口对应的二进制Swift模块；恢复同轮编译器快速消费所需三件输出。
 for(const [slice,triple,identity]of [['ios-arm64','aarch64-apple-ios','arm64-apple-ios'],['ios-arm64-simulator','aarch64-apple-ios-sim','arm64-apple-ios-simulator'],['macos-arm64','aarch64-apple-darwin','arm64-apple-macos']].filter((_,index)=>testing.target==='iOS'?index===1:testing.target==='macOS'?index===2:!device||index===0))for(const extension of ['swiftmodule','swiftdoc','swiftsourceinfo']){const from=join(work,triple,'CitizenSDK.framework/Modules/CitizenSDK.swiftmodule',identity+'.'+extension),to=join(output,slice,'CitizenSDK.framework/Modules/CitizenSDK.swiftmodule',identity+'.'+extension);if(existsSync(from)){if(existsSync(to)){if(!readFileSync(from).equals(readFileSync(to)))throw Error('XCFramework二进制模块漂移');}else copy(from,to);}}
 // 真机安装不编译模拟器、macOS或SDK测试现场。
 if(!device)await appleTests(project,work,env,headers,testing);
}
async function appleTests(project,work,env,headers,{simulator,performance=false}={}){
 const triple=simulator?'aarch64-apple-ios-sim':'aarch64-apple-darwin',flutterName=simulator?'Flutter':'FlutterMacOS';
 const harness=join(work,'apple-tests'),core=join(env.CARGO_TARGET_DIR,triple,'release'),qr=join(work,triple,'qr');
 for(const name of ['citizensdk.h','citizensdk_types.h'])copy(join(project,'include',name),join(harness,'Sources/CitizenSDKC/include',name));copy(join(project,'image/citizensdk_qr_image.h'),join(harness,'Sources/CitizenSDKC/include/citizensdk_qr_image.h'));put(join(harness,'Sources/CitizenSDKC/harness.c'),'#include "citizensdk.h"\nint citizensdk_test_anchor(void){return 0;}\n');
 for(const file of files(join(project,'darwin/src')).filter(path=>path.endsWith('.swift')))put(join(harness,'Sources/CitizenSDK',basename(file)),'import CitizenSDKC\n'+readFileSync(file,'utf8'));
 put(join(harness,'Sources/CitizenSDK/CitizenSDKCExports.swift'),'@_exported import CitizenSDKC\n');copy(join(project,'darwin/flutter'),join(harness,'Sources/CitizenSDKFlutter'));
 // 同一平面测试目录按所属模块装配SwiftPM目标，每个测试只编译一次。
 for(const name of readdirSync(join(project,'darwin/tests')).filter(name=>name.endsWith('.swift')))copy(join(project,'darwin/tests',name),join(harness,'Tests',name.startsWith('CitizenSDKFlutter')?'CitizenSDKFlutterTests':'CitizenSDKTests',name));
 const engine=join(process.env.FLUTTER_ROOT,'bin/cache/artifacts/engine'),artifacts=simulator?[join(engine,'ios-release/Flutter.xcframework')].filter(existsSync):readdirSync(engine).filter(name=>/^darwin-.*-release$/u.test(name)).map(name=>join(engine,name,'FlutterMacOS.xcframework')).filter(existsSync);if(artifacts.length!==1)throw Error('官方Flutter Release framework不唯一');copy(artifacts[0],join(harness,'Artifacts',flutterName+'.xcframework'));
 const libraries=appleLibraries(core,qr);
 const flutterSlice=readdirSync(artifacts[0]).filter(name=>!simulator||name.includes('simulator')).map(name=>join(artifacts[0],name,flutterName+'.framework')).find(existsSync);if(!flutterSlice)throw Error('Flutter目标framework缺失');
 const flags=['-enable-testing','-warnings-as-errors','-strict-concurrency=complete','-I',headers,'-Xcc','-I'+join(harness,'Sources/CitizenSDKC/include')],link=libraries.flatMap(path=>['-Xlinker','-force_load','-Xlinker',path]);
 put(join(harness,'Package.swift'),`// swift-tools-version: 5.9
import PackageDescription
let flags: [SwiftSetting] = [.unsafeFlags(${JSON.stringify(flags)})]
let package = Package(name: "CitizenSDKAppleTests", platforms: [.macOS(.v14), .iOS(.v16)], products: [.library(name: "CitizenSDKAppleTests", targets: ["CitizenSDK", "CitizenSDKFlutter"])], targets: [
 .binaryTarget(name: "${flutterName}", path: "Artifacts/${flutterName}.xcframework"),
 .target(name: "CitizenSDKC", publicHeadersPath: "include"),
 .target(name: "CitizenSDK", dependencies: ["CitizenSDKC"], swiftSettings: flags, linkerSettings: [.unsafeFlags(${JSON.stringify(link)}), .linkedFramework("Security"), .linkedFramework("LocalAuthentication"), .linkedLibrary("c++"), .linkedLibrary("sqlite3")]),
 .target(name: "CitizenSDKFlutter", dependencies: ["CitizenSDK", "${flutterName}"], swiftSettings: flags),
 .testTarget(name: "CitizenSDKTests", dependencies: ["CitizenSDK"], swiftSettings: flags),
 .testTarget(name: "CitizenSDKFlutterTests", dependencies: ["CitizenSDK", "CitizenSDKFlutter"], swiftSettings: flags, linkerSettings: [.unsafeFlags(${JSON.stringify(['-Xlinker','-rpath','-Xlinker',dirname(flutterSlice)])})])
], swiftLanguageVersions: [.v5])\n`);
 if(simulator){
  const state=JSON.parse(await run('xcrun',['simctl','list','devices','available','-j'],{env,capture:true}));
  const device=Object.values(state.devices).flat().find(value=>value.udid===simulator);
  if(!device)throw Error('指定iOS模拟器不存在');
  const application='org.citizen.sdk.test.'+basename(work).replaceAll('-','').toLowerCase();let booted=false;
  const boot=device.state==='Shutdown';if(!boot&&device.state!=='Booted')throw Error('iOS模拟器状态不可执行');

  try{
   if(boot){await run('xcrun',['simctl','boot',simulator],{env});booted=true;}
   await run('xcrun',['simctl','bootstatus',simulator,'-b'],{env});
   const listing=JSON.parse(await run('xcodebuild',['-list','-json'],{cwd:harness,env,capture:true})),schemes=listing.workspace?.schemes||listing.project?.schemes||[];
   const scheme='CitizenSDKAppleTests';
   if(!schemes.includes(scheme))throw Error('Swift Package聚合测试scheme缺失：'+schemes.join(','));
   const derived=join(work,'xcode'),result=join(work,'simulator.xcresult'),args=['-scheme',scheme,'-configuration','Release','-destination','platform=iOS Simulator,id='+simulator,'-derivedDataPath',derived,'-parallel-testing-enabled','NO','CODE_SIGNING_ALLOWED=NO','PRODUCT_BUNDLE_IDENTIFIER='+application];
   await run('xcodebuild',['build-for-testing',...args],{cwd:harness,env});
   const bundles=readdirSync(join(derived,'Build/Products'),{recursive:true}).filter(name=>name.endsWith('.xctest')).map(name=>join(derived,'Build/Products',name));
   if(!bundles.length)throw Error('iOS XCTest未生成');for(const bundle of bundles){copy(join(project,'chain'),join(bundle,'chain'));copy(join(project,'include/citizensdk.h'),join(bundle,'citizensdk.h'));}
   // Swift Package逻辑测试直接使用Xcode官方xctest代理，没有自建.app；按真实运行描述核对。
   const plans=files(join(derived,'Build/Products')).filter(name=>name.endsWith('.xctestrun'));
   if(plans.length!==1)throw Error('iOS XCTest运行描述不唯一');
   const plan=JSON.parse(await run('plutil',['-convert','json','-o','-',plans[0]],{env,capture:true}));
   const targets=plan.TestConfigurations?.flatMap(value=>value.TestTargets)||[];
   if(!targets.length)throw Error('iOS XCTest目标缺失');
   for(const target of targets){if(!target.TestHostPath?.endsWith('/Developer/Library/Xcode/Agents/xctest'))throw Error('iOS逻辑测试代理未识别：'+JSON.stringify(target));}
   await run('xcodebuild',['test-without-building',...args,'-resultBundlePath',result],{cwd:harness,env:{...env,TEST_RUNNER_CITIZENSDK_PERFORMANCE:String(performance)}});
   const summary=JSON.parse(await run('xcrun',['xcresulttool','get','test-results','summary','--path',result,'--compact'],{env,capture:true}));
   const passed=summary.passedTests,failed=summary.failedTests,skipped=summary.skippedTests;
   if(!Number.isSafeInteger(passed)||passed<=0||failed!==0||!Number.isSafeInteger(skipped))throw Error('iOS测试报告未通过：'+JSON.stringify(summary));
   console.error(JSON.stringify({target:'iOS',passed,failed,skipped,notRun:['Secure Enclave真机授权','相机物理采集']}));
  }finally{
   if(booted)await run('xcrun',['simctl','shutdown',simulator],{env,signal:new AbortController().signal});
  }
  return;
 }
 const scratch=join(harness,'build'),args=['--package-path',harness,'--configuration','release','--scratch-path',scratch];await run('swift',['build','--build-tests',...args],{env});
 const bundles=readdirSync(scratch,{recursive:true}).filter(name=>name.endsWith('.xctest')).map(name=>join(scratch,name));if(!bundles.length)throw Error('Apple XCTest未生成');
 // Flutter测试目标通过原官方框架目录的rpath加载binaryTarget，不再复制；这里只补齐chain资源。
 for(const bundle of bundles){copy(join(project,'chain'),join(bundle,'Contents/Resources/chain'));copy(join(project,'include/citizensdk.h'),join(bundle,'Contents/Resources/citizensdk.h'));}
 const output=await run('swift',['test','--skip-build',...args],{env:{...env,CITIZENSDK_PERFORMANCE:String(performance)},capture:true});console.error(output);console.error(JSON.stringify({target:'macOS',...xctestReport(output),notRun:['Secure Enclave真机授权','相机物理采集']}));
 // 同一正式Rust/图像静态库装配真实FFI测试库，不替代业务和结果投影。
 const fixture=join(work,'ffi.dylib');
 await run('xcrun',['clang++','-std=c++17','-dynamiclib','-fPIC','-Wall','-Wextra','-Wpedantic','-Wconversion','-Wsign-conversion','-Werror','-I'+join(project,'include'),'-I'+join(project,'core/cpp'),'-I'+headers,join(project,'lib/test/cpp.cc'),...libraries.map(path=>'-Wl,-force_load,'+path),'-framework','Security','-framework','SystemConfiguration','-framework','CoreFoundation','-lsqlite3','-lc++','-liconv','-lresolv','-o',fixture],{env});
 const flutter=join(process.env.FLUTTER_ROOT,'bin/flutter');
 await run(flutter,['pub','get','--enforce-lockfile'],{cwd:project,env});
 // ffigen只能修改构建副本；头文件与提交绑定不一致则失败，不能手修签名。
 const binding=join(project,'lib/platform/bind.dart'),expected=readFileSync(binding);
 await run(join(process.env.FLUTTER_ROOT,'bin/dart'),['run','ffigen'],{cwd:project,env});
 if(!readFileSync(binding).equals(expected))throw Error('C ABI生成绑定与源码不一致');
 // 官方Flutter工具快照直接由同版Dart启动，保留实际进程符号预载，不经系统shell丢弃DYLD变量。
 await run(join(process.env.FLUTTER_ROOT,'bin/cache/dart-sdk/bin/dart'),[join(process.env.FLUTTER_ROOT,'bin/cache/flutter_tools.snapshot'),'test','--no-pub','--reporter=expanded','lib/test/platform/ffi_test.dart'],{cwd:project,env:{...env,DYLD_INSERT_LIBRARIES:fixture,CITIZENSDK_TEST_LIBRARY:fixture,CITIZENSDK_TEST_WORK_DIR:work}});
 const contract=join(work,'core-cpp-contract');await run('xcrun',['clang++','-std=c++17','-UNDEBUG','-Wall','-Wextra','-Werror','-I'+join(project,'include'),join(project,'core/tests/cpp/contracts.cc'),fixture,'-o',contract],{env});await run(contract,[],{env});
}
async function desktop(project,work,env,headers,target){
 const windows=target==='Windows',triple=windows?'x86_64-pc-windows-msvc':'aarch64-unknown-linux-gnu',platform=windows?'windows':'linux',core=await cargo(project,triple,env);
 const output=join(work,'output',platform),cmake=join(work,'cmake'),definitions={CMAKE_BUILD_TYPE:'Release',CMAKE_INSTALL_PREFIX:output,CMAKE_INSTALL_LIBDIR:'lib',CMAKE_INSTALL_INCLUDEDIR:'include',CMAKE_INSTALL_DATADIR:'share',CMAKE_INSTALL_BINDIR:'bin',CITIZENSDK_PLATFORM:target,CITIZENSDK_CORE_LIBRARY:join(core,windows?'citizensdk.dll':'libcitizensdk.so'),CITIZENSDK_CORE_INCLUDE_DIR:join(project,'include'),CITIZENSDK_INTERNAL_INCLUDE_DIR:headers,CITIZENSDK_ASSET_DIR:join(project,'chain'),CITIZENSDK_ZXING_SOURCE_DIR:process.env.CITIZENSDK_ZXING_SOURCE_DIR,CITIZENSDK_DART_INCLUDE_DIR:join(process.env.FLUTTER_ROOT,'bin/cache/dart-sdk/include'),CITIZENSDK_BUILD_TESTS:'ON',CITIZENSDK_TEST_WORK_DIR:join(work,'test-state')};
 if(windows)definitions.CITIZENSDK_CORE_IMPORT_LIBRARY=join(core,'citizensdk.dll.lib');else definitions.CITIZENSDK_ENABLE_QR_CAPTURE='ON';
 for(const name of ['SQLITE_INCLUDE_DIR','SQLITE_ARCHIVE',...windows?[]:['OPENSSL_INCLUDE_DIR','TSS2_INCLUDE_DIR','CRYPTO_ARCHIVE','TSS2_ESYS_ARCHIVE','TSS2_MU_ARCHIVE','TSS2_SYS_ARCHIVE','TSS2_RC_ARCHIVE','TSS2_TCTI_DEVICE_ARCHIVE']]){const value=process.env['CITIZENSDK_'+name];if(!value)throw Error('缺少宿主依赖：'+name);definitions['CITIZENSDK_'+name]=value;}
 if(!windows)mkdirSync(join(work,'test-state'),{mode:0o700});
 await run('cmake',['-S',join(project,platform),'-B',cmake,...windows?['-G','Ninja']:[],...Object.entries(definitions).map(([key,value])=>'-D'+key+'='+value)],{env});await run('cmake',['--build',cmake,'--config','Release','--parallel'],{env});await run('ctest',['--test-dir',cmake,'-C','Release','--no-tests=error','--output-on-failure','--output-junit',join(work,'desktop.xml')],{env});testReport([readFileSync(join(work,'desktop.xml'),'utf8')]);await run('cmake',['--install',cmake,'--config','Release'],{env});
 if(!windows){mkdirSync(join(work,'consumer-state'),{mode:0o700});}
 const consumer=join(work,'consumer');await run('cmake',['-S',join(project,platform,'tests'),'-B',consumer,...windows?['-G','Ninja']:[],'-DCITIZENSDK_CONSUMER_PREFIX='+output,'-DCITIZENSDK_CONSUMER_VERSION='+/^version: (\S+)$/mu.exec(readFileSync(join(project,'pubspec.yaml'),'utf8'))[1],'-DCITIZENSDK_PLATFORM='+target,'-DCITIZENSDK_TEST_WORK_DIR='+join(work,'consumer-state')],{env});await run('cmake',['--build',consumer,'--config','Release','--parallel'],{env});await run('ctest',['--test-dir',consumer,'-C','Release','--no-tests=error','--output-on-failure','--output-junit',join(work,'consumer.xml')],{env});console.error(JSON.stringify({target,...testReport([readFileSync(join(work,'desktop.xml'),'utf8'),readFileSync(join(work,'consumer.xml'),'utf8')]),notRun:windows?['相机物理采集']:['TPM正向授权','相机物理采集']}));await desktopFlutter(project,work,env,target,output);
}
// 同一Flutter工程沿用其官方配置工具；两条路径完整校验后才启动，禁止回退PATH。
export async function flutterChecks(output,label,{env={},testEnv=env,runImpl=run}={}){
 const cache=readFileSync(join(output,'CMakeCache.txt'),'utf8').split(/\r?\n/u);
 const [cmake,ctest]=['CMAKE_COMMAND','CMAKE_CTEST_COMMAND'].map(name=>{
  const rows=cache.filter(line=>line.startsWith(name+':')),prefix=name+':INTERNAL=';
  if(rows.length!==1||!rows[0].startsWith(prefix))throw Error('Flutter工程工具记录无效：'+name);
  const file=rows[0].slice(prefix.length);
  if(!isAbsolute(file)||!existsSync(file)||!lstatSync(file).isFile())throw Error('Flutter工程工具路径无效：'+name);
  return file;
 });
 await runImpl(cmake,['--build',output,'--config','Release','--target','citizensdk_flutter_checks','--parallel'],{env});
 await runImpl(ctest,['--test-dir',output,'-C','Release','-L',label,'--no-tests=error','--output-on-failure'],{env:testEnv});
}
async function desktopFlutter(project,work,env,target,installed){
 const windows=target==='Windows',platform=windows?'windows':'linux',sdk=createFlutterSourceView(project,join(work,'flutter-sdk'));copy(installed,join(sdk,platform));
 const runner=join(work,'flutter-consumer'),flutter=join(process.env.FLUTTER_ROOT,'bin',windows?'flutter.bat':'flutter');
 await run(flutter,['create','--platforms='+platform,'--project-name','citizensdk_consumer','--org','org.citizen',runner],{env});
 writeFileSync(join(runner,'pubspec.yaml'),`name: citizensdk_consumer\npublish_to: none\nversion: 1.0.0+1\nenvironment:\n  sdk: ^3.8.0\ndependencies:\n  flutter:\n    sdk: flutter\n  citizen_sdk:\n    path: ${JSON.stringify(sdk.replaceAll('\\','/'))}\nflutter:\n  uses-material-design: false\n`);
 copyFileSync(join(project,'pubspec.lock'),join(runner,'pubspec.lock'));
 // 两平台均先创建本轮测试根，保留Windows夹具的owner/no-reparse检查。
 const state=join(work,'flutter-state');mkdirSync(state,{mode:0o700});
 const cmake=join(runner,platform,'CMakeLists.txt'),before=readFileSync(cmake,'utf8'),marker='include(flutter/generated_plugins.cmake)';if(!before.includes(marker))throw Error('Flutter官方插件登记入口缺失');
 const settings=`set(CITIZENSDK_BUILD_TESTS ON)\nset(CITIZENSDK_TEST_WORK_DIR "${state.replaceAll('\\','/')}")\n${windows?'set(CITIZENSDK_APPLICATION_ID "org.citizensdk.flutterconsumer")\n':''}enable_testing()\n`;
 writeFileSync(cmake,before.replace(marker,settings+marker).replace('set(APPLICATION_ID "org.citizen.citizensdk_consumer")','set(APPLICATION_ID "org.citizensdk.flutterconsumer")'));
 await run(flutter,['pub','get'],{cwd:runner,env});await run(flutter,['build',platform,'--release','--no-pub','--config-only',...windows?[]:['--target-platform=linux-arm64']],{cwd:runner,env});
 // 复用Flutter官方配置和assemble依赖，只构建正式插件及原合同测试，不编译消费App主程序。
 const output=join(runner,'build',platform,windows?'x64':'arm64',windows?'':'release');await flutterChecks(output,windows?'WindowsFlutter':'LinuxFlutter',{env,testEnv:{...env,LD_LIBRARY_PATH:windows?undefined:join(sdk,'linux/lib/LinuxARM')+':'+join(runner,'linux/flutter/ephemeral')}});
}
export function setVersion(project,version){
 const pub=join(project,'pubspec.yaml');writeFileSync(pub,readFileSync(pub,'utf8').replace(/^version: .+$/mu,'version: '+version));
 for(const platform of ['linux','windows']){const file=join(project,platform,'CMakeLists.txt');writeFileSync(file,readFileSync(file,'utf8').replace(/project\(CitizenSDKHost VERSION [0-9.]+/u,'project(CitizenSDKHost VERSION '+version));}
 for(const name of ['android/build.gradle','darwin/citizen_sdk.podspec']){const file=join(project,name);writeFileSync(file,readFileSync(file,'utf8').replace(/(version\s*=\s*)'[^']+'/u,"$1'"+version+"'"));}
}
export function verifyComplete(project){
 const declaration=join(project,'android/build.gradle');if(!lstatSync(declaration).isFile()||lstatSync(declaration).size>65536)throw Error('SDK Android声明无效');
 const version=/implementation 'rustls:rustls-platform-verifier:([^']+)'/u.exec(readFileSync(join(project,'android/build.gradle'),'utf8'))?.[1];if(!version||!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version))throw Error('Android证书组件声明无效');
 for(const extension of ['aar','pom']){const file=join(project,'android/maven/rustls/rustls-platform-verifier',version,'rustls-platform-verifier-'+version+'.'+extension);if(!lstatSync(file).isFile()||!lstatSync(file).size)throw Error('Android证书组件交付缺失');}
 for(const slice of ['ios-arm64','ios-arm64-simulator','macos-arm64']){
  const base=join(project,'darwin/CitizenSDK.xcframework',slice,'CitizenSDK.framework',...(slice==='macos-arm64'?['Versions/A']:[]));
  for(const name of ['CitizenSDK','Headers/citizensdk.h','Headers/citizensdk_types.h']){const file=join(base,name);if(!lstatSync(file).isFile()||!lstatSync(file).size)throw Error('Apple切片交付缺失');}
 }
 for(const [platform,target]of [['linux','LinuxARM'],['windows','Windows']])for(const name of ['CitizenSDKConfig.cmake','CitizenSDKConfigVersion.cmake','CitizenSDKTargets.cmake']){const file=join(project,platform,'lib',target,'cmake/CitizenSDK',name);if(!lstatSync(file).isFile()||!lstatSync(file).size)throw Error('桌面SDK消费配置缺失');}
 for(const name of ['pubspec.lock','Cargo.lock','include/citizensdk.h','chain/manifest.json','android/citizensdk.aar','android/src/main/jniLibs/arm64-v8a/libcitizensdk.so','android/src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so','darwin/CitizenSDK.xcframework/Info.plist','linux/lib/LinuxARM/libcitizensdk.so','linux/lib/LinuxARM/libcitizensdk_host.so','windows/bin/Windows/citizensdk.dll','windows/bin/Windows/citizensdk_host.dll','windows/lib/Windows/citizensdk.dll.lib'])if(!lstatSync(join(project,name)).isFile()||!lstatSync(join(project,name)).size)throw Error('完整SDK产物缺失：'+name);
}
// 消费阶段只检查同版布局和锁定接口；原ZIP完整性由consume统一核对。
export function verifyConsumer(project){
 if(typeof project!=='string'||realpathSync(project)!==resolve(project))throw Error('SDK消费根无效');verifyComplete(project);
 const pub=join(project,'pubspec.yaml');if(!lstatSync(pub).isFile()||lstatSync(pub).size>65536)throw Error('SDK包声明无效');
 const declaration=readFileSync(pub,'utf8'),version=/^version: (\S+)$/mu.exec(declaration)?.[1];
 if(readFileSync(join(root,'pubspec.yaml'),'utf8').replace(/^version: .+$/mu,'version: '+version)!==declaration)throw Error('SDK包声明与锁定源码不符');
 for(const name of ['Cargo.lock','pubspec.lock','include/citizensdk.h','include/citizensdk_types.h','lib/platform/bind.dart'])if(lstatSync(join(root,name)).size!==lstatSync(join(project,name)).size||!readFileSync(join(root,name)).equals(readFileSync(join(project,name))))throw Error('SDK交付与锁定源码接口不一致');
 return project;
}
// Rust的SQLite测试沿用声明的同一MSVC静态库，不依赖全局sqlite安装或隐式LIB目录。
export function sqliteLinkEnv(env,archive,platform=process.platform){
 if(platform!=='win32')return env;
 if(typeof archive!=='string'||!win32.isAbsolute(archive)||win32.basename(archive).toLowerCase()!=='sqlite3.lib')throw Error('Windows测试缺少声明的SQLite静态库');
 return {...env,LIB:win32.dirname(archive)+';'+(env.LIB??process.env.LIB??'')};
}
// 性能仅描述同一真实实现；带替身的Engine样本明确标注为本机调度/缓存，不冒充实网。
async function performanceTests(project,work,env){
 console.error(JSON.stringify({performance:{platform:process.platform,arch:process.arch,os:release(),cpu:cpus()[0]?.model,cores:cpus().length,load:loadavg(),totalMemory:totalmem(),freeMemory:freemem(),rust:tools.rust,flutter:tools.flutter,threshold:'descriptive'}}));
 for(const [packageName,target,filter]of [['citizensdk',['--lib'],'baseline_lifecycle_contract'],['citizensdk',['--test','baseline_resource_contract'],''],['citizensdk',['--test','store_public'],'baseline']]){
  const build=await run('cargo',['test','--release','--locked','-p',packageName,...target,'--no-run','--message-format=json'],{cwd:project,env,capture:true});
  const artifacts=build.split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line)).filter(value=>value.reason==='compiler-artifact'&&value.profile.test&&value.executable);
  if(artifacts.length!==1)throw Error('性能测试可执行文件不唯一');
  const args=[artifacts[0].executable,...filter?[filter]:[],'--nocapture','--test-threads=1'];
  // 编译结束后再采RSS：time记录单个测试进程树中最大的进程高水位，不算总内存峰值。
  if(process.platform==='darwin')await run('/usr/bin/time',['-l',...args],{cwd:project,env});
  else if(process.platform==='linux'&&existsSync('/usr/bin/time'))await run('/usr/bin/time',['-v',...args],{cwd:project,env});
  else{console.error('性能峰值RSS未测量：当前宿主没有系统time入口');await run(args[0],args.slice(1),{cwd:project,env});}
 }
 const image=join(work,'image-tests');await run('cmake',['-S',join(project,'image'),'-B',image,'-DCMAKE_BUILD_TYPE=Release','-DCITIZENSDK_QR_IMAGE_BUILD_TESTS=ON','-DCITIZENSDK_ZXING_SOURCE_DIR='+process.env.CITIZENSDK_ZXING_SOURCE_DIR],{env});
 await run('cmake',['--build',image,'--config','Release','--parallel'],{env});
 await run('ctest',['--test-dir',image,'-C','Release','--no-tests=error','--output-on-failure','--verbose','--output-junit',join(work,'image.xml')],{env:{...env,CITIZENSDK_PERFORMANCE:'true'}});testReport([readFileSync(join(work,'image.xml'),'utf8')]);
}
// 测试选择只决定现有入口的调度；设备标识不能被忽略或混入native构建开关。
export function testOptions(args){
 const values=[...args],target=values[0]&&!values[0].startsWith('--')?values.shift():undefined;
 if(target&&!['Android','iOS','macOS','LinuxARM','Windows'].includes(target))throw Error('未知测试平台');
 const options={test:true,target};
 while(values.length){const flag=values.shift();if(flag==='--performance'&&!options.performance)options.performance=true;
  else if(['--device','--simulator'].includes(flag)){
   const key=flag==='--device'?'testDevice':'simulator',value=values.shift();
   if(options[key]||!value||value.startsWith('-')||!/^[-A-Za-z0-9.:_]+$/u.test(value))throw Error('测试设备标识无效');options[key]=value;
  }else throw Error('未知或重复测试参数：'+flag);
 }
 if(target==='Android'?!options.testDevice||options.simulator:options.testDevice)throw Error('Android测试必须显式选择--device');
 if(target==='iOS'?!options.simulator||options.testDevice:options.simulator)throw Error('iOS测试必须显式选择--simulator');
 return options;
}
// 读取工具原生JUnit报告；进程退出0、空报告和全部跳过均不能替代真正执行。
export function testReport(documents){
 if(!documents.length)throw Error('测试报告缺失');const result={passed:0,failed:0,skipped:0};
 for(const xml of documents){
  if(typeof xml!=='string')throw Error('测试报告不完整');
  // 只读JUnit的元素结构与计数；拒绝DTD、重复属性及残缺XML，不执行实体或外部引用。
  const stack=[];let offset=0,roots=0;
  const count=(counts,kind)=>{counts[kind]++;counts.tests++;};
  const tokens=/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][^<>]*>|[^<]+/gu;
  for(const token of xml.matchAll(tokens)){
   if(token.index!==offset)throw Error('测试报告XML不完整');offset+=token[0].length;const text=token[0];
   if(text.startsWith('<?')||text.startsWith('<!--'))continue;
   if(text.startsWith('<![CDATA[')){if(!stack.length)throw Error('测试报告XML结构无效');continue;}
   if(!text.startsWith('<')){if(!stack.length&&text.trim())throw Error('测试报告XML结构无效');continue;}
   const close=/^<\/([A-Za-z_][\w:.-]*)\s*>$/u.exec(text);
   if(close){const node=stack.pop();if(!node||node.name!==close[1])throw Error('测试报告XML标签不匹配');finish(node);continue;}
   const tag=/^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/u.exec(text);if(!tag)throw Error('测试报告XML标签无效');
   const attrs={};let tail=tag[2];while(tail.trim()){
    const attribute=/^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u.exec(tail);
    if(!attribute||Object.hasOwn(attrs,attribute[1]))throw Error('测试报告XML属性无效');attrs[attribute[1]]=attribute[2]??attribute[3];tail=tail.slice(attribute[0].length);
   }
   const name=tag[1],parent=stack.at(-1),suite=name==='testsuite'||name==='testsuites';
   if(!parent){if(!suite||++roots!==1)throw Error('测试报告根元素无效');}
   if(suite&&parent&&!parent.suite||name==='testcase'&&!parent?.suite)throw Error('测试报告用例归属无效');
   const node={name,attrs,suite,counts:{tests:0,passed:0,failed:0,skipped:0,failures:0,errors:0},failure:false,error:false,skip:false};
   const entry=[...stack].reverse().find(value=>value.name==='testcase');
   if(['failure','error','skipped'].includes(name)&&!entry)throw Error('测试报告错误节点无用例归属');
   if(entry){if(name==='failure')entry.failure=true;if(name==='error')entry.error=true;if(name==='skipped')entry.skip=true;}
   if(tag[3])finish(node);else stack.push(node);
  }
  if(offset!==xml.length||stack.length||roots!==1)throw Error('测试报告XML不完整');
  function finish(node){
   if(node.name==='testcase'){
    const kind=node.failure||node.error?'failed':node.skip||['notrun','disabled'].includes(node.attrs.status)?'skipped':'passed';result[kind]++;
    for(const suite of stack.filter(value=>value.suite)){count(suite.counts,kind);if(node.failure)suite.counts.failures++;if(node.error)suite.counts.errors++;}
   }
   if(node.suite&&!stack.length&&!node.counts.tests)throw Error('测试报告没有用例');
   if(node.suite)for(const key of ['tests','failures','errors','skipped'])if(Object.hasOwn(node.attrs,key)&&(!/^\d+$/u.test(node.attrs[key])||Number(node.attrs[key])!==node.counts[key]))throw Error('测试报告套件计数不符：'+key);
  }
 }
 if(result.failed||!result.passed)throw Error('测试未通过：'+JSON.stringify(result));return result;
}
function junit(directory){return testReport(existsSync(directory)?files(directory).filter(name=>name.endsWith('.xml')).map(name=>readFileSync(name,'utf8')):[]);}
// XCTest原生逐项输出及All tests总数，避免SwiftPM缺失XML或把XCTSkip写成通过。
export function xctestReport(output){
 const cases=[...output.matchAll(/^Test Case '([^'\n]+)' (passed|failed|skipped) \([^\n]*\)\.\s*$/gmu)];
 const totals=[...output.matchAll(/Test Suite 'All tests' (passed|failed) at[^\n]*\n\s*Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?\b/gu)];
 const result={passed:0,failed:0,skipped:0};
 for(const entry of cases)result[entry[2]]++;
 if(!totals.length||cases.length!==totals.reduce((sum,value)=>sum+Number(value[2]),0)||totals.some(value=>value[1]!=='passed'||Number(value[4])!==0)||result.skipped!==totals.reduce((sum,value)=>sum+Number(value[3]||0),0)||new Set(cases.map(value=>value[1])).size!==cases.length||!result.passed||result.failed)throw Error('XCTest数量或结果不符：'+JSON.stringify(result));return result;
}
// AndroidJUnitRunner官方raw结果：adb退出0本身不代表测试成功。
export function instrumentationReport(output){
 if(!/^INSTRUMENTATION_CODE: -1\s*$/mu.test(output)||/INSTRUMENTATION_(?:FAILED|ABORTED):|INSTRUMENTATION_RESULT: shortMsg=/u.test(output))throw Error('Android instrumentation未正常结束');
 const totals=[...output.matchAll(/^INSTRUMENTATION_STATUS: numtests=(\d+)\s*$/gmu)].map(value=>Number(value[1])),codes=[...output.matchAll(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)\s*$/gmu)].map(value=>Number(value[1]));
 const result={passed:0,failed:0,skipped:0};
 for(const code of codes)if(code===0)result.passed++;else if(code===-1||code===-2)result.failed++;else if(code===-3||code===-4)result.skipped++;else if(code!==1)throw Error('未知Android instrumentation状态');
 if(!totals.length||totals.some(value=>value!==totals[0])||totals[0]!==result.passed+result.failed+result.skipped||!result.passed||result.failed)throw Error('Android测试数量或结果不符：'+JSON.stringify(result));
 return result;
}
async function androidTests(work,env,serial,performance){
 const adb=join(process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
 const devices=await run(adb,['devices'],{env,capture:true});
 if(!devices.split(/\r?\n/u).some(line=>line===serial+'\tdevice'))throw Error('指定Android设备未在线');
 const application='org.citizen.sdk.test.'+basename(work).replaceAll('-','').toLowerCase();
 const environment={...env,ANDROID_SERIAL:serial,CITIZENSDK_TEST_APPLICATION:application};
 let pending,owned=false;
 try{
  await run('gradle',['--offline','--no-daemon','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),':native:assembleReleaseAndroidTest'],{env:environment});
  const directory=join(work,'gradle-output/native/outputs/apk/androidTest/release'),metadata=JSON.parse(readFileSync(join(directory,'output-metadata.json'),'utf8'));
  if(metadata.applicationId!==application||metadata.elements?.length!==1||basename(metadata.elements[0].outputFile)!==metadata.elements[0].outputFile)throw Error('Android测试APK身份或数量不符');
  const installed=await run(adb,['-s',serial,'shell','cmd','package','list','packages',application],{env,capture:true});
  if(installed.split(/\r?\n/u).includes('package:'+application))throw Error('Android测试宿主已存在，禁止覆盖');
  await run(adb,['-s',serial,'install','-t',join(directory,metadata.elements[0].outputFile)],{env});owned=true;
  const output=await run(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','performance',String(Boolean(performance)),'-e','baseline',application,application+'/androidx.test.runner.AndroidJUnitRunner'],{env,capture:true});
  console.error(output);const report=instrumentationReport(output);
  if(performance){const logs=await run(adb,['-s',serial,'logcat','-d','-v','brief','-s','CitizenSDKBaseline:I'],{env,capture:true});const metrics=logs.split(/\r?\n/u).filter(line=>line.includes('application='+application+' '));if(metrics.length!==4)throw Error('Android性能报告缺失');for(const line of metrics)console.error(line.slice(line.indexOf('sdk-baseline')));}

  console.error(JSON.stringify({target:'Android',...report,notRun:['生物识别交互及硬件密钥正向授权','相机物理采集']}));return report;
 }catch(error){pending=error;throw error;}
 finally{
  // 直接instrumentation结束、异常或取消后，只回收本轮已取得所有权的测试包。
  if(owned&&!pending?.keepWork){const cleanup=new AbortController();try{
   const installed=await run(adb,['-s',serial,'shell','cmd','package','list','packages',application],{env,capture:true,signal:cleanup.signal});
   if(installed.split(/\r?\n/u).includes('package:'+application)){await run(adb,['-s',serial,'shell','am','force-stop',application],{env,signal:cleanup.signal});await run(adb,['-s',serial,'uninstall',application],{env,signal:cleanup.signal});}
  }catch(error){if(pending)console.error('测试宿主清理失败：'+error.message);else throw error;}}
 }
}
// 独立C11/C++17声明、大小与偏移金标必须由真实编译器执行；不生成源码或兼容头。
export async function headerChecks(project,{env={},runImpl=run,platform=process.platform}={}){
 const include=join(project,'include');
 for(const [standard,file]of [['c11','c_header_c11.c'],['c++17','c_header_cpp17.cc']]){
  const source=join(project,'core/tests/abi',file);
  if(platform==='win32')await runImpl('cl',['/nologo','/Zs','/W4','/WX',standard==='c11'?'/std:c11':'/std:c++17','/I'+include,source],{cwd:project,env});
  else await runImpl(standard==='c11'?'cc':'c++',['-std='+standard,'-fsyntax-only','-Wall','-Wextra','-Werror','-I'+include,source],{cwd:project,env});
 }
}

export async function build({target,test=false,testDevice,simulator,performance=false,version=process.env.SDK_VERSION||/^version: (\S+)$/mu.exec(readFileSync(join(root,'pubspec.yaml'),'utf8'))[1],native,device=false}={}){

 if(test&&target){testOptions([target,...testDevice?['--device',testDevice]:[],...simulator?['--simulator',simulator]:[]]);const host={Android:['darwin','linux'],iOS:['darwin'],macOS:['darwin'],LinuxARM:['linux'],Windows:['win32']}[target];if(!host?.includes(process.platform)||target==='LinuxARM'&&process.arch!=='arm64')throw Error('当前宿主不能执行所选平台测试：'+target);}
 if(!test&&!native&&!['Android','Apple','LinuxARM','Windows'].includes(target))throw Error('编译必须选择真实内部目标或汇总完整产物');
 const base=join(root,'target',test?'test':'build');mkdirSync(base,{recursive:true});if(realpathSync(base)!==base)throw Error('任务目录经过链接');const work=mkdtempSync(join(base,'sdk-')),cache=claimCache(work);let complete=false,safe=true;
 try{
  if(cache.project)rmSync(cache.project,{recursive:true,force:true});
  const project=createFlutterSourceView(root,cache.project||join(work,'project')),env={RUSTUP_TOOLCHAIN:tools.rust,CARGO_TARGET_DIR:process.env.CARGO_TARGET_DIR||cache.cargo,CARGO_INCREMENTAL:'1'},headers=privateHeaders(project,work);
  if(test)Object.assign(env,sqliteLinkEnv(env,process.env.CITIZENSDK_SQLITE_ARCHIVE));
  await headerChecks(project,{env});
  if(test&&!target){
   await run(process.execPath,['--test','lib/test/build.test.mjs'],{cwd:project,env});
   // 上游扩展有独立workspace/原锁，定向执行真实块接纳与清理回归，不启用Wasmtime。
   await run('cargo',['test','--manifest-path','smoldot/Cargo.toml','-p','smoldot-light','--lib','--no-default-features','--features','std','--locked','runtime_query_tests','--','--test-threads=1'],{cwd:project,env});
   await run('cargo',['test','--workspace','--locked','--','--include-ignored','--test-threads=1'],{cwd:project,env});put(join(project,'analysis_options.yaml'),'include: package:flutter_lints/flutter.yaml\nanalyzer:\n  language:\n    strict-casts: true\n    strict-inference: true\n    strict-raw-types: true\n  errors:\n    invalid_use_of_visible_for_testing_member: error\n    missing_required_param: error\n    missing_return: error\nlinter:\n  rules:\n    avoid_dynamic_calls: false\n    directives_ordering: true\n    discarded_futures: true\n    prefer_final_locals: true\n    unawaited_futures: true\n');const flutter=join(process.env.FLUTTER_ROOT||join(root,'target/cache/flutter'),'bin',process.platform==='win32'?'flutter.bat':'flutter');await run(flutter,['pub','get','--enforce-lockfile'],{cwd:project,env});await run(flutter,['analyze','--fatal-infos'],{cwd:project,env});const tests=files(join(project,'lib/test')).filter(path=>path.endsWith('_test.dart')&&relative(project,path).split(sep).join('/')!=='lib/test/platform/ffi_test.dart').sort();if(!tests.length)throw Error('Dart测试缺失');await run(flutter,['test','--no-pub','--reporter=expanded',...tests],{cwd:project,env});if(performance)await performanceTests(project,work,env);return {tests:true};}
  if(native){const output=createFlutterSourceView(root,join(work,'output'));for(const name of ['android','darwin','linux','windows'])copy(join(native,name),join(output,name));setVersion(output,version);verifyComplete(output);}
  else{setVersion(project,version);if(target==='Android')await android(project,work,env,headers,device,{testDevice,performance});else if(['Apple','iOS','macOS'].includes(target))await apple(project,work,env,headers,version,device,test?{target,simulator,performance}:{});else await desktop(project,work,env,headers,target);}
  if(test){if(target==='macOS'){for(const name of readdirSync(work))if(name!=='ffi.dylib')rmSync(join(work,name),{recursive:true,force:true});complete=true;return {tests:true,target,work,testLibrary:join(work,'ffi.dylib')};}if(performance&&['LinuxARM','Windows'].includes(target)){console.error(JSON.stringify({target,notRun:['平台桥接耗时采样']}));await performanceTests(project,work,env);}return {tests:true,target};}
  for(const name of readdirSync(work))if(name!=='output')rmSync(join(work,name),{recursive:true,force:true});complete=true;return {work,output:join(work,'output')};
 }catch(error){safe=!error.keepWork;throw error;}finally{if(safe){cache.release();if(!complete)rmSync(work,{recursive:true,force:true});}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&!process.env.NODE_TEST_CONTEXT){
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
 try{
  const [command,arg]=process.argv.slice(2);
  if(command==='verify')console.log(JSON.stringify({output:verifyConsumer(arg)}));
  else if(command==='consume')console.log(JSON.stringify(await consume({directory:process.env.CITIZENSDK_PACKAGE,sourceSha:arg,output:process.argv[4]})));
  else if(command==='test')console.log(JSON.stringify(await build(testOptions(process.argv.slice(3)))));
  else if(command==='native')console.log(JSON.stringify(await build({target:arg,device:process.argv.includes('--device')})));
  else if(command==='package'&&arg)console.log(JSON.stringify(await build({native:resolve(arg)})));
  else throw Error('用法：node scripts/build.mjs native 目标 | package 原生件目录 | consume 源码SHA 输出 | verify 目录 | test [Android --device ID | iOS --simulator UDID | macOS | LinuxARM | Windows] [--performance]');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
