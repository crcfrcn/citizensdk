#!/usr/bin/env node
// 本仓测试、编译及自动化入口；Workflow交付正式版本，原Run终态后实际清理历史。
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmdirSync,readFileSync,writeFileSync,copyFileSync,cpSync,rmSync,renameSync,symlinkSync,existsSync,realpathSync,lstatSync,readdirSync,utimesSync,readlinkSync} from 'node:fs';
import {join,dirname,resolve,basename,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest as configuration,tools,nativePaths,repository} from './config.mjs';
export function sdkName(version){if(typeof version!=='string'||version.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version))throw Error('SDK版本无效');return '公民SDK·SDK·v'+version;}
export function nextVersion(runs){const latest=[...runs].filter(run=>run.status==='completed'&&run.conclusion==='success').sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at)||b.id-a.id)[0];if(!latest){const version=/^version: (\S+)$/mu.exec(readFileSync(new URL('../pubspec.yaml',import.meta.url),'utf8'))?.[1];sdkName(version);return version;}const prefix='公民SDK·SDK·v',version=latest.display_title?.startsWith(prefix)?latest.display_title.slice(prefix.length):'';sdkName(version);const parts=version.split('.');parts[2]=String(BigInt(parts[2])+1n);const next=parts.join('.');sdkName(next);return next;}
export function retainedRuns(rows){const keep=new Set(),states=new Set();for(const run of [...rows].sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at)||b.id-a.id)){if(run.status!=='completed'){keep.add(run.id);continue;}const state=run.conclusion==='success'?'success':'failed';if(!states.has(state)){states.add(state);keep.add(run.id);}}return keep;}

// 产品自己拥有派发、观察和终态清理；公开输出只传递GitHub状态和固定说明。
function reportEvent(value){
 if(!process.stdout.listenerCount('error'))process.stdout.on('error',()=>{});
 try{process.stdout.write(JSON.stringify(value)+'\n',()=>{});}catch{}
}
function emit(report,value){try{report(value);}catch{}}
function line(report,text){emit(report,{event:'output',stream:'stdout',data:Buffer.from(text+'\n').toString('base64')});}
async function request(token,path,{method='GET',body,fetchImpl=fetch}={}){
 const response=await fetchImpl('https://api.github.com/repos/'+repository+'/'+path,{method,redirect:'error',
  headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'CitizenSDK'},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(method==='DELETE'&&response.status===404)return null;
 if(!response.ok)throw Error('GitHub HTTP '+response.status);
 return response.status===204?null:response.json();
}
async function workflowRuns(read){
 const rows=[];
 for(let page=1;;page++){
  const data=await read('actions/workflows/sdk.yml/runs?branch=main&event=workflow_dispatch&per_page=100&page='+page);
  rows.push(...data.workflow_runs);if(data.workflow_runs.length<100)return rows;
 }
}
// 原Run结束后实际删除旧同类记录；Release/Tag先按本仓已有生产回执确认归属。
export async function cleanupRuns({token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl}),remove=id=>request(token,'actions/runs/'+id,{method:'DELETE',fetchImpl}),completedRun,report=reportEvent}={}){
 const rows=await workflowRuns(read);
 if(completedRun){const index=rows.findIndex(row=>row.id===completedRun.id);if(index<0)rows.push(completedRun);else rows[index]=completedRun;}
 const keep=retainedRuns(rows),stale=rows.filter(row=>row.status==='completed'&&!keep.has(row.id)),deleted=[],errors=[];
 const absent=async path=>{try{await read(path);return false;}catch(error){if(error.message==='GitHub HTTP 404')return true;throw error;}};
 // 删除旧成功之前，新成功必须已有完整SDK Artifact及正式Release/Tag；失败清理独立进行。
 let releases=[];
 try{for(let page=1;;page++){const values=await read('releases?per_page=100&page='+page);releases.push(...values);if(values.length<100)break;}}
 catch(error){errors.push('Release列表读取失败：'+error.message);}
 const owned=releases.flatMap(release=>{let proof;try{proof=JSON.parse(release.body);}catch{return [];}
  if(proof.product_id!==configuration.product_id||proof.platform!=='sdk'||!Number.isSafeInteger(proof.producer_run_id)||proof.producer_run_id<=0)return [];
  if(release.tag_name!==sdkName(proof.software_version)||release.target_commitish!==proof.git_commit_sha)return [];
  return [{release,proof}];});
 let successReady=true;
 if(stale.some(row=>row.conclusion==='success')){
  try{
   const success=rows.filter(row=>row.status==='completed'&&row.conclusion==='success'&&keep.has(row.id))[0];
   const release=owned.find(value=>value.proof.producer_run_id===success.id)?.release;
   if(!release||release.draft||release.prerelease||release.assets?.length!==3)throw Error('新正式Release或附件不完整');
   const artifacts=await read('actions/runs/'+success.id+'/artifacts?per_page=100');
   if(artifacts.artifacts?.filter(value=>value.name===success.display_title&&!value.expired&&value.size_in_bytes>0).length!==1)throw Error('新完整SDK Artifact缺失');
   const tag=await read('git/ref/tags/'+encodeURIComponent(release.tag_name));
   if(tag.object?.type!=='commit'||tag.object.sha!==success.head_sha)throw Error('新正式Tag未确认');
  }catch(error){successReady=false;errors.push('旧成功清理未执行：'+error.message);}
 }
 // 先归还旧发布资产再删Run；某项失败仍清理其它旧失败，不用重跑业务来重试删除。
 for(const {release,proof}of owned){
  if(keep.has(proof.producer_run_id))continue;
  const row=rows.find(value=>value.id===proof.producer_run_id);
  if(row&&row.status!=='completed'||(!row||row.conclusion==='success')&&!successReady)continue;
  try{const current=await read('actions/runs/'+proof.producer_run_id);if(current.status!=='completed')continue;}catch(error){if(error.message!=='GitHub HTTP 404'){errors.push('旧版本Run读取失败：'+error.message);continue;}}
  try{
   const tagPath='git/ref/tags/'+encodeURIComponent(release.tag_name);
   if(!await absent(tagPath)){const currentTag=await read(tagPath);if(currentTag.object?.type!=='commit'||currentTag.object.sha!==proof.git_commit_sha)throw Error('旧Tag归属已变化');}
   await request(token,'releases/'+release.id,{method:'DELETE',fetchImpl});
   const tag='git/refs/tags/'+encodeURIComponent(release.tag_name);
   if(!await absent('git/ref/tags/'+encodeURIComponent(release.tag_name)))await request(token,tag,{method:'DELETE',fetchImpl});
   if(!await absent('releases/'+release.id)||!await absent('git/ref/tags/'+encodeURIComponent(release.tag_name)))throw Error('旧Release或Tag删除尚未确认');
  }catch(error){errors.push('旧发布资产删除失败：'+error.message);}
 }
 for(const row of stale){
  if(row.conclusion==='success'&&!successReady)continue;
  try{const current=await read('actions/runs/'+row.id);if(current.status!=='completed')continue;await remove(row.id);if(!await absent('actions/runs/'+row.id))throw Error('旧Run删除尚未确认');deleted.push(row.id);}
  catch(error){if(error.message!=='GitHub HTTP 404')errors.push('旧Run删除失败：'+error.message);}
 }
 const remaining=await workflowRuns(read),expected=retainedRuns(remaining);
 if(remaining.some(row=>row.status==='completed'&&!expected.has(row.id)))errors.push('SDK旧Run删除尚未确认');
 if(errors.length)throw Error(errors.join('；'));
 line(report,'SDK记录清理完成：最新成功、最新失败各最多一条；旧Run、日志和对应Artifact实际删除 '+deleted.length+' 条');
 return {completed:true,deleted,kept:[...expected]};
}
export async function automate({token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl}),dispatch=spec=>request(token,'actions/workflows/'+spec.workflow+'/dispatches',{method:'POST',body:{ref:spec.ref,inputs:spec.inputs},fetchImpl}),remove,report=reportEvent,interval=3000}={}){
 const rows=await workflowRuns(read),receipt=await dispatch({workflow:'sdk.yml',ref:'main',inputs:{version:nextVersion(rows)}}),runID=receipt.workflow_run_id;
 emit(report,{event:'started',repository,runID});
 let run;
 for(;;){
  try{run=await read('actions/runs/'+runID);}
  catch(error){
   // 只重试同一Run的瞬时读取；认证、权限及其他错误仍沿原失败路径退出。
   if(!(error instanceof TypeError&&error.message==='fetch failed')&&!/^GitHub HTTP (408|429|500|502|503|504)$/u.test(error.message))throw error;
   line(report,'GitHub Run瞬时读取失败；继续观察原Run，不重复派发');
   await new Promise(resolve=>setTimeout(resolve,interval));continue;
  }
  emit(report,{event:'run',run});
  try{emit(report,{event:'jobs',jobs:await read('actions/runs/'+runID+'/jobs?per_page=100&page=1')});}
  catch(error){if(!(error instanceof TypeError&&error.message==='fetch failed')&&!/^GitHub HTTP (408|429|500|502|503|504)$/u.test(error.message))throw error;line(report,'GitHub Job瞬时读取失败；继续读取原Run的真实状态');}
  if(run.status==='completed')break;
  await new Promise(resolve=>setTimeout(resolve,interval));
 }
 try{await cleanupRuns({token,fetchImpl,read,remove,completedRun:run,report});}
 catch(error){throw Error('SDK记录清理失败：'+error.message);}
 return {runID};
}

export const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export function claimCache(work){
 const base=join(root,'target/cache'),lock=join(base,'lock');let owned=false;
 try{mkdirSync(base,{recursive:true});if(realpathSync(base)!==base)throw Error('缓存经过链接');mkdirSync(lock);owned=true;const cargo=join(base,'rust');mkdirSync(cargo,{recursive:true});if(realpathSync(cargo)!==cargo)throw Error('缓存经过链接');return {cargo,project:join(base,'project'),release(){rmdirSync(lock);}};}
 catch{if(owned)rmdirSync(lock);return {cargo:join(work,'rust'),release(){}};}
}
const controller=new AbortController();
async function run(command,args,{cwd=root,env={},capture=false}={}){
 controller.signal.throwIfAborted();let batch=false;
 if(process.platform==='win32'&&/\.(?:bat|cmd)$/iu.test(command)){if([command,...args].some(value=>/["%!^&|<>\r\n]/u.test(value)))throw Error('Windows工具参数含Shell控制字符');args=['/d','/s','/c','\"'+[command,...args].map(value=>'\"'+value+'\"').join(' ')+'\"'];command=process.env.COMSPEC||'cmd.exe';batch=true;}
 const environment={...process.env,...env};delete environment.GH_TOKEN;delete environment.GITHUB_TOKEN;
 // Git Bash会把自己的link.exe放到PATH前端；本产品始终使用官方MSVC目录和链接器。
 if(process.platform==='win32')environment.MSBUILDDISABLENODEREUSE='1';
 if(process.platform==='win32'&&process.env.CITIZENSDK_MSVC_BIN){const path=Object.entries(environment).find(([key])=>key.toLowerCase()==='path')?.[1]||'';for(const key of Object.keys(environment))if(key.toLowerCase()==='path')delete environment[key];environment.PATH=process.env.CITIZENSDK_MSVC_BIN+';'+path;}

 return new Promise((ok,fail)=>{
  const child=spawn(command,args,{cwd,env:environment,windowsVerbatimArguments:batch,detached:process.platform!=='win32',stdio:['ignore',capture?'pipe':process.stderr,process.stderr]});let output='',error,timer,stopping;
  const kill=signal=>{try{if(process.platform==='win32'){stopping??=new Promise(resolve=>{const stop=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});stop.once('error',()=>resolve(false));stop.once('close',code=>resolve(code===0));});}else process.kill(-child.pid,signal);}catch{}};
  const stop=()=>{kill('SIGTERM');timer=setTimeout(()=>kill('SIGKILL'),2000);};controller.signal.addEventListener('abort',stop,{once:true});
  child.stdout?.on('data',bytes=>{output+=bytes;if(output.length>16*1024**2){error=Error('工具结果超限');stop();}});child.once('error',value=>{error=value;});
  child.once('close',async(code,signal)=>{controller.signal.removeEventListener('abort',stop);
   if(stopping&&!await stopping){clearTimeout(timer);const failure=Error('Windows进程树退出尚未确认，保留现场');failure.keepWork=true;return fail(failure);}
   if(controller.signal.aborted&&process.platform!=='win32'){await new Promise(resolve=>setTimeout(resolve,2100));try{process.kill(-child.pid,0);const failure=Error('子进程退出尚未确认，保留现场');failure.keepWork=true;return fail(failure);}catch(value){if(value.code!=='ESRCH')return fail(value);}}
   clearTimeout(timer);
   if(process.platform!=='win32'&&child.pid){
    // Flutter启动器可能先于短命后代返回；只等待本轮独立进程组，禁止抢先删除现场。
    for(let attempt=0;attempt<=50;attempt++){
     try{process.kill(-child.pid,0);}catch(value){if(value.code==='ESRCH')break;return fail(value);}
     if(process.platform==='linux'){
      // 容器PID1可能未回收已经退出的僵尸；Z状态不能再运行或写入，不作为活动工具。
      const result=spawnSync('ps',['--sid',String(child.pid),'-o','stat='],{env:environment,encoding:'utf8'});
      if(!result.error&&[0,1].includes(result.status)&&result.stdout.trim().split(/\s+/u).every(state=>!state||state.startsWith('Z')))break;
     }
     if(attempt===50){const failure=Error('工具后代尚未退出，保留现场');failure.keepWork=true;return fail(failure);}
     await new Promise(resolve=>setTimeout(resolve,100));
    }
   }
   error||code!==0||signal||controller.signal.aborted?fail(error||Error(basename(command)+'执行失败')):ok(output.trim());
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
   // 发布SDK只允许Apple标准Framework的五个内部相对链接，禁止借包内路径访问外部文件。
   const frame='darwin/CitizenSDK.xcframework/macos-arm64/CitizenSDK.framework/',path=entry.split(sep).join('/'),links={'Versions/Current':'A',Headers:'Versions/Current/Headers',Modules:'Versions/Current/Modules',Resources:'Versions/Current/Resources',CitizenSDK:'Versions/Current/CitizenSDK'};
   const target=realpathSync(from);if(!path.startsWith(frame)||links[path.slice(frame.length)]!==readlinkSync(from)||!target.startsWith(join(source,frame,'Versions/A')+sep)&&target!==join(source,frame,'Versions/A'))throw Error('SDK源码链接越界');symlinkSync(readlinkSync(from),to,lstatSync(target).isDirectory()?'dir':'file');
  }else throw Error('SDK源码输入禁止特殊文件');
 }}visit(source);
 // Flutter消费位置只装配一次，源码仍由本产品唯一入口所有。
 const from=join(output,'android/source/CitizenSdkPlugin.kt'),to=join(output,'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt');
 if(existsSync(from)){if(existsSync(to))throw Error('Flutter入口重复');mkdirSync(dirname(to),{recursive:true});renameSync(from,to);}
 return output;
}
export function createNativeSourceView(source,output){
 createFlutterSourceView(source,output);
 for(const [from,to]of Object.entries(nativePaths)){const destination=join(output,to);if(existsSync(destination))throw Error('Cargo路径重复');mkdirSync(dirname(destination),{recursive:true});renameSync(join(output,from),destination);}
 return output;
}
export function assertFlutterSourceView(source,output){
 for(const name of ['pubspec.yaml','pubspec.lock','include/citizensdk.h'])if(!readFileSync(join(source,name)).equals(readFileSync(join(output,name))))throw Error('SDK原锁或公开头漂移');return output;
}
export function citizenSdkInternalHeader(){return '#ifndef CITIZENSDK_INTERNAL_H\n#define CITIZENSDK_INTERNAL_H\n#include "citizensdk.h"\n#endif\n';}
function privateHeaders(project,work){
 const directory=join(work,'private');put(join(directory,'citizensdk_internal.h'),citizenSdkInternalHeader());copy(join(project,'native/image/citizensdk_qr_image.h'),join(directory,'citizensdk_qr_image.h'));
 put(join(directory,'module.modulemap'),'module CitizenSDKInternal { header "citizensdk_internal.h" header "citizensdk_qr_image.h" export * }\n');return directory;
}
function files(directory){return readdirSync(directory,{recursive:true}).map(name=>join(directory,name)).filter(path=>lstatSync(path).isFile());}
async function cargo(project,triple,env,test=false){
 await run('rustup',['target','add','--toolchain',tools.rust,triple],{env});
 await run('cargo',[test?'test':'build','--locked',...(test?['--workspace']:['--release','-p','citizen-sdk-ffi']),'--target',triple],{cwd:project,env});return join(env.CARGO_TARGET_DIR,triple,'release');
}
async function verifySymbols(file,project,env,apple=false){
 const header=readFileSync(join(project,'include/citizensdk.h'),'utf8'),expected=[...header.matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/gu)].map(value=>value[1]);
 const output=await run(apple?'xcrun':env.SDK_NM||'nm',apple?['nm','-gU',file]:['-D','--defined-only',file],{env,capture:true});
 for(const name of expected)if(!new RegExp('(?:^|\\s)_?'+name+'(?:\\s|$)','mu').test(output))throw Error('SDK公开ABI缺失：'+name);
 return output;
}
async function android(project,work,env,headers){
 const ndk=process.env.ANDROID_NDK_HOME||process.env.ANDROID_NDK_ROOT;if(!ndk||!readFileSync(join(ndk,'source.properties'),'utf8').includes('Pkg.Revision = '+tools.ndk))throw Error('缺少锁定官方NDK');
 const bin=join(ndk,'toolchains/llvm/prebuilt',process.platform==='darwin'?'darwin-x86_64':'linux-x86_64','bin'),triple='aarch64-linux-android';
 const environment={...env,CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:'-C link-arg=-Wl,-soname,libcitizensdk.so',CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:join(bin,'aarch64-linux-android24-clang'),CC_aarch64_linux_android:join(bin,'aarch64-linux-android24-clang'),AR_aarch64_linux_android:join(bin,'llvm-ar'),SDK_NM:join(bin,'llvm-nm')};
 const core=await cargo(project,triple,environment),stage=join(work,'core/arm64-v8a');copy(join(core,'libcitizensdk.so'),join(stage,'libcitizensdk.so'));
 await run(join(bin,'llvm-strip'),['--strip-unneeded',join(stage,'libcitizensdk.so')],{env:environment});await verifySymbols(join(stage,'libcitizensdk.so'),project,environment);
 const dynamic=await run(join(bin,'llvm-readelf'),['--dynamic-table',join(stage,'libcitizensdk.so')],{env:environment,capture:true});if(!/\(SONAME\).*\[libcitizensdk\.so\]/u.test(dynamic))throw Error('Android Core装载名称无效');
 const metadata=JSON.parse(await run('cargo',['metadata','--locked','--format-version','1'],{cwd:project,env:environment,capture:true}));
 const version=/implementation 'rustls:rustls-platform-verifier:([^']+)'/u.exec(readFileSync(join(project,'android/build.gradle'),'utf8'))?.[1];
 const verifier=metadata.packages.filter(value=>value.name==='rustls-platform-verifier-android'&&value.version===version);if(verifier.length!==1)throw Error('Android证书组件没有唯一原锁来源');
 const gradleHome=join(dirname(env.CARGO_TARGET_DIR),'gradle-home');mkdirSync(gradleHome,{recursive:true});const maven=join(dirname(verifier[0].manifest_path),'maven'),link=join(gradleHome,'citizensdk-verifier-maven');if(!existsSync(link))symlinkSync(maven,link);else if(realpathSync(link)!==realpathSync(maven))throw Error('Android证书组件缓存来源不符');
 for(const name of ['settings.gradle','build.gradle','native/build.gradle'])put(join(work,'gradle-project',name),`apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/${name}')\n`);
 const androidEnv={...environment,CITIZENSDK_WORK_DIR:work,CITIZENSDK_SOURCE_DIR:project,CITIZENSDK_ANDROID_BUILD_DIR:join(work,'gradle-output'),CITIZENSDK_ANDROID_CORE_DIR:stage,CITIZENSDK_INTERNAL_INCLUDE_DIR:headers,CITIZENSDK_FLUTTER_ROOT:process.env.FLUTTER_ROOT,GRADLE_USER_HOME:gradleHome};
 await run('gradle',['--no-daemon','-Pandroid.onlyEnableUnitTestForTheTestedBuildType=false','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),':native:testReleaseUnitTest',':native:assembleRelease'],{env:androidEnv});
 const output=join(work,'output/android'),aar=join(work,'gradle-output/native/outputs/aar/native-release.aar');copy(aar,join(output,'citizensdk.aar'));copy(join(stage,'libcitizensdk.so'),join(output,'src/main/jniLibs/arm64-v8a/libcitizensdk.so'));
 await run('unzip',['-o',aar,'jni/arm64-v8a/libcitizensdk_jni.so','-d',join(work,'aar')],{env:androidEnv});copy(join(work,'aar/jni/arm64-v8a/libcitizensdk_jni.so'),join(output,'src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so'));
 copy(join(work,'aar/jni/arm64-v8a/libcitizensdk_jni.so'),join(stage,'libcitizensdk_jni.so'));const dependencies=await run(join(bin,'llvm-readelf'),['--dynamic-table',join(stage,'libcitizensdk_jni.so')],{env:environment,capture:true});if(!/\(NEEDED\).*\[libcitizensdk\.so\]/u.test(dependencies)||/\(NEEDED\).*\[[^\]]*[\\/]/u.test(dependencies))throw Error('Android JNI装载依赖无效');await run('gradle',['--no-daemon','-Pandroid.onlyEnableUnitTestForTheTestedBuildType=false','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),':testReleaseUnitTest'],{env:androidEnv});
}
// Cargo与现有CMake各自拥有准确输出；内部依赖目录的同名库不参与最终链接选择。
export function appleLibraries(core,qr){
 const libraries=[join(core,'libcitizensdk.a'),join(qr,'libcitizensdk_qr_image.a'),join(qr,'zxing/core/libZXing.a')];
 for(const file of libraries){const info=lstatSync(file);if(!info.isFile()||!info.size)throw Error('Apple静态库缺失或为空：'+file);}
 return libraries;
}
async function apple(project,work,env,headers,version){
 const frameworks=[];
 for(const [triple,sdk,target,identity,platform,minimum]of [
  ['aarch64-apple-ios','iphoneos','arm64-apple-ios16.0','arm64-apple-ios','iPhoneOS','16.0'],
  ['aarch64-apple-ios-sim','iphonesimulator','arm64-apple-ios16.0-simulator','arm64-apple-ios-simulator','iPhoneSimulator','16.0'],
  ['aarch64-apple-darwin','macosx','arm64-apple-macosx13.0','arm64-apple-macos','MacOSX','13.0']]){
  const sdkPath=await run('xcrun',['--sdk',sdk,'--show-sdk-path'],{capture:true}),environment={...env,SDKROOT:sdkPath,IPHONEOS_DEPLOYMENT_TARGET:'16.0',MACOSX_DEPLOYMENT_TARGET:'13.0',CARGO_PROFILE_RELEASE_STRIP:'false'};
  const core=await cargo(project,triple,environment),slice=join(work,triple),framework=join(slice,'CitizenSDK.framework'),mac=sdk==='macosx',content=mac?join(framework,'Versions/A'):framework;
  const modules=join(content,'Modules/CitizenSDK.swiftmodule'),resources=mac?join(content,'Resources'):content;mkdirSync(modules,{recursive:true});
  for(const name of ['citizensdk.h','citizensdk_types.h'])copy(join(project,'include',name),join(content,'Headers',name));copy(join(project,'native/image/citizensdk_qr_image.h'),join(content,'Headers/citizensdk_qr_image.h'));
  put(join(content,'Modules/module.modulemap'),'framework module CitizenSDK { umbrella header "citizensdk.h" explicit module QrImage { header "citizensdk_qr_image.h" export * } export * module * { export * } }\n');copy(join(project,'chain'),join(resources,'chain'));copy(join(project,'darwin/source/core/PrivacyInfo.xcprivacy'),join(resources,'PrivacyInfo.xcprivacy'));
  const plist=join(resources,'Info.plist');put(plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>CitizenSDK</string><key>CFBundleIdentifier</key><string>org.citizen.sdk</string><key>CFBundleName</key><string>CitizenSDK</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleSupportedPlatforms</key><array><string>${platform}</string></array><key>${mac?'LSMinimumSystemVersion':'MinimumOSVersion'}</key><string>${minimum}</string></dict></plist>`);
  if(mac){for(const [name,to]of [['Versions/Current','A'],['Headers','Versions/Current/Headers'],['Modules','Versions/Current/Modules'],['Resources','Versions/Current/Resources']])symlinkSync(to,join(framework,name));}
  const qr=join(slice,'qr');await run('cmake',['-S',join(project,'native/image'),'-B',qr,'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_SYSTEM_NAME='+(mac?'Darwin':'iOS'),'-DCMAKE_OSX_SYSROOT='+sdkPath,'-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET='+minimum,'-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY','-DCITIZENSDK_ZXING_SOURCE_DIR='+process.env.CITIZENSDK_ZXING_SOURCE_DIR],{env:environment});await run('cmake',['--build',qr,'--config','Release','--parallel'],{env:environment});
  const libraries=appleLibraries(core,qr);
  const swift=readdirSync(join(project,'darwin/source/core')).filter(name=>name.endsWith('.swift')).sort().map(name=>join(project,'darwin/source/core',name));
  const args=[...swift,'-parse-as-library','-swift-version','5','-warnings-as-errors','-strict-concurrency=complete','-O','-whole-module-optimization','-enable-library-evolution','-emit-library','-emit-module','-emit-module-path',join(modules,identity+'.swiftmodule'),'-emit-module-interface-path',join(modules,identity+'.swiftinterface'),'-module-name','CitizenSDK','-module-cache-path',join(slice,'modules'),'-sdk',sdkPath,'-target',target,'-import-underlying-module','-F',slice,'-I',headers,'-Xcc','-I'+join(content,'Headers'),...libraries.flatMap(path=>['-Xlinker','-force_load','-Xlinker',path]),'-Xlinker','-install_name','-Xlinker',mac?'@rpath/CitizenSDK.framework/Versions/A/CitizenSDK':'@rpath/CitizenSDK.framework/CitizenSDK','-framework','Security','-framework','LocalAuthentication','-lc++','-lsqlite3'];
  const probe=join(slice,'probe');await run('xcrun',['swiftc',...args,'-o',probe],{env:environment});const symbols=await verifySymbols(probe,project,environment,true);
  const exports=symbols.split('\n').map(line=>line.trim().split(/\s+/u).at(-1)).filter(name=>/^_(?:citizensdk_|\$s10CitizenSDK)/u.test(name));put(join(slice,'exports'),[...new Set(exports)].sort().join('\n')+'\n');
  await run('xcrun',['swiftc',...args,'-Xlinker','-exported_symbols_list','-Xlinker',join(slice,'exports'),'-o',join(content,'CitizenSDK')],{env:environment});if(mac)symlinkSync('Versions/Current/CitizenSDK',join(framework,'CitizenSDK'));frameworks.push('-framework',framework);
 }
 const output=join(work,'output/darwin/CitizenSDK.xcframework');mkdirSync(dirname(output),{recursive:true});await run('xcodebuild',['-create-xcframework',...frameworks,'-output',output],{env});
 // Xcode会移除已有稳定接口对应的二进制Swift模块；恢复同轮编译器快速消费所需三件输出。
 for(const [slice,triple,identity]of [['ios-arm64','aarch64-apple-ios','arm64-apple-ios'],['ios-arm64-simulator','aarch64-apple-ios-sim','arm64-apple-ios-simulator'],['macos-arm64','aarch64-apple-darwin','arm64-apple-macos']])for(const extension of ['swiftmodule','swiftdoc','swiftsourceinfo']){const from=join(work,triple,'CitizenSDK.framework/Modules/CitizenSDK.swiftmodule',identity+'.'+extension),to=join(output,slice,'CitizenSDK.framework/Modules/CitizenSDK.swiftmodule',identity+'.'+extension);if(existsSync(from)){if(existsSync(to)){if(!readFileSync(from).equals(readFileSync(to)))throw Error('XCFramework二进制模块漂移');}else copy(from,to);}}
 await appleTests(project,work,env,headers);
}
async function appleTests(project,work,env,headers){
 const harness=join(work,'apple-tests'),core=join(env.CARGO_TARGET_DIR,'aarch64-apple-darwin/release'),qr=join(work,'aarch64-apple-darwin/qr');
 for(const name of ['citizensdk.h','citizensdk_types.h'])copy(join(project,'include',name),join(harness,'Sources/CitizenSDKC/include',name));copy(join(project,'native/image/citizensdk_qr_image.h'),join(harness,'Sources/CitizenSDKC/include/citizensdk_qr_image.h'));put(join(harness,'Sources/CitizenSDKC/harness.c'),'#include "citizensdk.h"\nint citizensdk_test_anchor(void){return 0;}\n');
 for(const file of files(join(project,'darwin/source/core')).filter(path=>path.endsWith('.swift')))put(join(harness,'Sources/CitizenSDK',basename(file)),'import CitizenSDKC\n'+readFileSync(file,'utf8'));
 put(join(harness,'Sources/CitizenSDK/CitizenSDKCExports.swift'),'@_exported import CitizenSDKC\n');copy(join(project,'darwin/source/flutter'),join(harness,'Sources/CitizenSDKFlutter'));copy(join(project,'darwin/tests/core'),join(harness,'Tests/CitizenSDKTests'));copy(join(project,'darwin/tests/flutter'),join(harness,'Tests/CitizenSDKFlutterTests'));
 const engine=join(process.env.FLUTTER_ROOT,'bin/cache/artifacts/engine'),artifacts=readdirSync(engine).filter(name=>/^darwin-.*-release$/u.test(name)).map(name=>join(engine,name,'FlutterMacOS.xcframework')).filter(existsSync);if(artifacts.length!==1)throw Error('官方Flutter macOS Release framework不唯一');copy(artifacts[0],join(harness,'Artifacts/FlutterMacOS.xcframework'));
 const libraries=appleLibraries(core,qr);
 const flags=['-enable-testing','-warnings-as-errors','-strict-concurrency=complete','-I',headers,'-Xcc','-I'+join(harness,'Sources/CitizenSDKC/include')],link=libraries.flatMap(path=>['-Xlinker','-force_load','-Xlinker',path]);
 put(join(harness,'Package.swift'),`// swift-tools-version: 5.9
import PackageDescription
let flags: [SwiftSetting] = [.unsafeFlags(${JSON.stringify(flags)})]
let package = Package(name: "CitizenSDKAppleTests", platforms: [.macOS(.v14)], targets: [
 .binaryTarget(name: "FlutterMacOS", path: "Artifacts/FlutterMacOS.xcframework"),
 .target(name: "CitizenSDKC", publicHeadersPath: "include"),
 .target(name: "CitizenSDK", dependencies: ["CitizenSDKC"], swiftSettings: flags, linkerSettings: [.unsafeFlags(${JSON.stringify(link)}), .linkedFramework("Security"), .linkedFramework("LocalAuthentication"), .linkedLibrary("c++"), .linkedLibrary("sqlite3")]),
 .target(name: "CitizenSDKFlutter", dependencies: ["CitizenSDK", "FlutterMacOS"], swiftSettings: flags),
 .testTarget(name: "CitizenSDKTests", dependencies: ["CitizenSDK"], swiftSettings: flags),
 .testTarget(name: "CitizenSDKFlutterTests", dependencies: ["CitizenSDK", "CitizenSDKFlutter"], swiftSettings: flags)
], swiftLanguageVersions: [.v5])\n`);
 const scratch=join(harness,'build'),args=['--package-path',harness,'--configuration','release','--scratch-path',scratch];await run('swift',['build','--build-tests',...args],{env});
 const bundles=readdirSync(scratch,{recursive:true}).filter(name=>name.endsWith('.xctest')).map(name=>join(scratch,name));if(!bundles.length)throw Error('Apple XCTest未生成');
 const flutterSlice=readdirSync(artifacts[0]).map(name=>join(artifacts[0],name,'FlutterMacOS.framework')).find(existsSync);if(!flutterSlice)throw Error('Flutter macOS framework缺失');
 for(const bundle of bundles){copy(flutterSlice,join(bundle,'Contents/Frameworks/FlutterMacOS.framework'));copy(join(project,'chain'),join(bundle,'Contents/Resources/chain'));}
 await run('swift',['test','--skip-build',...args],{env});
}
async function desktop(project,work,env,headers,target){
 const windows=target==='Windows',triple=windows?'x86_64-pc-windows-msvc':'aarch64-unknown-linux-gnu',platform=windows?'windows':'linux',core=await cargo(project,triple,env);
 const output=join(work,'output',platform),cmake=join(work,'cmake'),definitions={CMAKE_BUILD_TYPE:'Release',CMAKE_INSTALL_PREFIX:output,CMAKE_INSTALL_LIBDIR:'lib',CMAKE_INSTALL_INCLUDEDIR:'include',CMAKE_INSTALL_DATADIR:'share',CMAKE_INSTALL_BINDIR:'bin',CITIZENSDK_PLATFORM:target,CITIZENSDK_CORE_LIBRARY:join(core,windows?'citizensdk.dll':'libcitizensdk.so'),CITIZENSDK_CORE_INCLUDE_DIR:join(project,'include'),CITIZENSDK_INTERNAL_INCLUDE_DIR:headers,CITIZENSDK_ASSET_DIR:join(project,'chain'),CITIZENSDK_ZXING_SOURCE_DIR:process.env.CITIZENSDK_ZXING_SOURCE_DIR,CITIZENSDK_BUILD_TESTS:'ON',CITIZENSDK_TEST_WORK_DIR:join(work,'test-state')};
 if(windows)definitions.CITIZENSDK_CORE_IMPORT_LIBRARY=join(core,'citizensdk.dll.lib');else definitions.CITIZENSDK_ENABLE_QR_CAPTURE='ON';
 for(const name of ['SQLITE_INCLUDE_DIR','SQLITE_ARCHIVE',...windows?[]:['OPENSSL_INCLUDE_DIR','TSS2_INCLUDE_DIR','CRYPTO_ARCHIVE','TSS2_ESYS_ARCHIVE','TSS2_MU_ARCHIVE','TSS2_SYS_ARCHIVE','TSS2_RC_ARCHIVE','TSS2_TCTI_DEVICE_ARCHIVE']]){const value=process.env['CITIZENSDK_'+name];if(!value)throw Error('缺少宿主依赖：'+name);definitions['CITIZENSDK_'+name]=value;}
 if(!windows)mkdirSync(join(work,'test-state'),{mode:0o700});
 await run('cmake',['-S',join(project,platform),'-B',cmake,...windows?['-G','Ninja']:[],...Object.entries(definitions).map(([key,value])=>'-D'+key+'='+value)],{env});await run('cmake',['--build',cmake,'--config','Release','--parallel'],{env});await run('ctest',['--test-dir',cmake,'-C','Release','--no-tests=error','--output-on-failure'],{env});await run('cmake',['--install',cmake,'--config','Release'],{env});
 if(!windows){mkdirSync(join(work,'consumer-state'),{mode:0o700});}
 const consumer=join(work,'consumer');await run('cmake',['-S',join(project,platform,'tests'),'-B',consumer,...windows?['-G','Ninja']:[],'-DCITIZENSDK_CONSUMER_PREFIX='+output,'-DCITIZENSDK_CONSUMER_VERSION='+/^version: (\S+)$/mu.exec(readFileSync(join(project,'pubspec.yaml'),'utf8'))[1],'-DCITIZENSDK_PLATFORM='+target,'-DCITIZENSDK_TEST_WORK_DIR='+join(work,'consumer-state')],{env});await run('cmake',['--build',consumer,'--config','Release','--parallel'],{env});await run('ctest',['--test-dir',consumer,'-C','Release','--no-tests=error','--output-on-failure'],{env});await desktopFlutter(project,work,env,target,output);
}
async function desktopFlutter(project,work,env,target,installed){
 const windows=target==='Windows',platform=windows?'windows':'linux',sdk=createFlutterSourceView(project,join(work,'flutter-sdk'));copy(installed,join(sdk,platform));
 const runner=join(work,'flutter-consumer'),flutter=join(process.env.FLUTTER_ROOT,'bin',windows?'flutter.bat':'flutter');
 await run(flutter,['create','--platforms='+platform,'--project-name','citizensdk_consumer','--org','org.citizen',runner],{env});
 writeFileSync(join(runner,'pubspec.yaml'),`name: citizensdk_consumer\npublish_to: none\nversion: 1.0.0+1\nenvironment:\n  sdk: ^3.8.0\ndependencies:\n  flutter:\n    sdk: flutter\n  citizen_sdk:\n    path: ${JSON.stringify(sdk.replaceAll('\\','/'))}\nflutter:\n  uses-material-design: false\n`);
 copyFileSync(join(project,'pubspec.lock'),join(runner,'pubspec.lock'));copyFileSync(join(project,platform,'tests/citizen_sdk_flutter_consumer.dart'),join(runner,'lib/main.dart'));
 // 两平台均先创建本轮测试根，保留Windows夹具的owner/no-reparse检查。
 const state=join(work,'flutter-state');mkdirSync(state,{mode:0o700});
 const cmake=join(runner,platform,'CMakeLists.txt'),before=readFileSync(cmake,'utf8'),marker='include(flutter/generated_plugins.cmake)';if(!before.includes(marker))throw Error('Flutter官方插件登记入口缺失');
 const settings=`set(CITIZENSDK_BUILD_TESTS ON)\nset(CITIZENSDK_TEST_WORK_DIR "${state.replaceAll('\\','/')}")\n${windows?'set(CITIZENSDK_APPLICATION_ID "org.citizensdk.flutterconsumer")\n':''}enable_testing()\n`;
 writeFileSync(cmake,before.replace(marker,settings+marker).replace('set(APPLICATION_ID "org.citizen.citizensdk_consumer")','set(APPLICATION_ID "org.citizensdk.flutterconsumer")'));
 await run(flutter,['pub','get'],{cwd:runner,env});await run(flutter,['build',platform,'--release','--no-pub',...windows?[]:['--target-platform=linux-arm64']],{cwd:runner,env});
 const output=join(runner,'build',platform,windows?'x64':'arm64',windows?'':'release');await run('ctest',['--test-dir',output,'-C','Release','-L',windows?'WindowsFlutter':'LinuxFlutter','--no-tests=error','--output-on-failure'],{env:{...env,LD_LIBRARY_PATH:windows?undefined:join(sdk,'linux/lib/LinuxARM')+':'+join(runner,'linux/flutter/ephemeral')}});
}
export function setVersion(project,version){
 sdkName(version);const pub=join(project,'pubspec.yaml');writeFileSync(pub,readFileSync(pub,'utf8').replace(/^version: .+$/mu,'version: '+version));
 for(const platform of ['linux','windows']){const file=join(project,platform,'CMakeLists.txt');writeFileSync(file,readFileSync(file,'utf8').replace(/project\(CitizenSDKHost VERSION [0-9.]+/u,'project(CitizenSDKHost VERSION '+version));}
 for(const name of ['android/build.gradle','darwin/citizen_sdk.podspec']){const file=join(project,name);writeFileSync(file,readFileSync(file,'utf8').replace(/(version\s*=\s*)'[^']+'/u,"$1'"+version+"'"));}
}
export function verifyComplete(project){
 for(const name of ['pubspec.lock','Cargo.lock','include/citizensdk.h','chain/manifest.json','android/citizensdk.aar','android/src/main/jniLibs/arm64-v8a/libcitizensdk.so','android/src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so','darwin/CitizenSDK.xcframework/Info.plist','linux/lib/LinuxARM/libcitizensdk.so','linux/lib/LinuxARM/libcitizensdk_host.so','windows/bin/Windows/citizensdk.dll','windows/bin/Windows/citizensdk_host.dll','windows/lib/Windows/citizensdk.dll.lib'])if(!lstatSync(join(project,name)).isFile()||!readFileSync(join(project,name)).length)throw Error('完整SDK产物缺失：'+name);
}
export async function build({target,test=false,version=process.env.SDK_VERSION||/^version: (\S+)$/mu.exec(readFileSync(join(root,'pubspec.yaml'),'utf8'))[1],native}={}){
 sdkName(version);if(process.versions.node!==tools.node)throw Error('Node版本与本产品声明不一致');
 if(!test&&!native&&!['Android','Apple','LinuxARM','Windows'].includes(target))throw Error('编译必须选择真实内部目标或汇总完整产物');
 const base=join(root,'target',test?'test':'build');mkdirSync(base,{recursive:true});if(realpathSync(base)!==base)throw Error('任务目录经过链接');const work=mkdtempSync(join(base,'sdk-')),cache=claimCache(work);let complete=false,safe=true;
 try{
  if(cache.project)rmSync(cache.project,{recursive:true,force:true});
  const project=createNativeSourceView(root,cache.project||join(work,'project')),env={RUSTUP_TOOLCHAIN:tools.rust,CARGO_TARGET_DIR:cache.cargo,CARGO_INCREMENTAL:'1'},headers=privateHeaders(project,work);
  if(test){await run('cargo',['test','--workspace','--locked','--','--include-ignored','--test-threads=1'],{cwd:project,env});put(join(project,'analysis_options.yaml'),'include: package:flutter_lints/flutter.yaml\nanalyzer:\n  language:\n    strict-casts: true\n    strict-inference: true\n    strict-raw-types: true\n  errors:\n    invalid_use_of_visible_for_testing_member: error\n    missing_required_param: error\n    missing_return: error\nlinter:\n  rules:\n    avoid_dynamic_calls: false\n    directives_ordering: true\n    discarded_futures: true\n    prefer_final_locals: true\n    unawaited_futures: true\n');const flutter=join(process.env.FLUTTER_ROOT||join(root,'target/cache/flutter'),'bin',process.platform==='win32'?'flutter.bat':'flutter');await run(flutter,['pub','get','--enforce-lockfile'],{cwd:project,env});await run(flutter,['analyze','--fatal-infos'],{cwd:project,env});await run(flutter,['test','--reporter=expanded'],{cwd:project,env});return {tests:true};}
  if(native){const output=createFlutterSourceView(root,join(work,'output'));for(const name of ['android','darwin','linux','windows'])copy(join(native,name),join(output,name));setVersion(output,version);verifyComplete(output);}
  else{setVersion(project,version);if(target==='Android')await android(project,work,env,headers);else if(target==='Apple')await apple(project,work,env,headers,version);else await desktop(project,work,env,headers,target);}
  for(const name of readdirSync(work))if(name!=='output')rmSync(join(work,name),{recursive:true,force:true});complete=true;return {work,output:join(work,'output')};
 }catch(error){safe=!error.keepWork;throw error;}finally{if(safe){cache.release();if(!complete)rmSync(work,{recursive:true,force:true});}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&!process.env.NODE_TEST_CONTEXT){
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
 try{const [command,arg]=process.argv.slice(2);if(command==='automate')await automate({token:process.env.GH_TOKEN||process.env.GITHUB_TOKEN});else if(command==='cleanup')console.log(JSON.stringify(await cleanupRuns({token:process.env.GH_TOKEN||process.env.GITHUB_TOKEN})));else if(command==='test')console.log(JSON.stringify(await build({test:true})));else if(command==='native')console.log(JSON.stringify(await build({target:arg})));else if(command==='package'&&arg)console.log(JSON.stringify(await build({native:resolve(arg)})));else throw Error('用法：node scripts/build.mjs test | native Android/Apple/LinuxARM/Windows | package 完整原生目录 | automate | cleanup');}
 catch(error){console.error(error.message);process.exitCode=1;}
}
