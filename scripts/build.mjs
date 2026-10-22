#!/usr/bin/env node
// 本仓塔塔自动化、独立发布与清理入口；发布只复用成功自动化的原产物。
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,mkdirSync,mkdtempSync,rmdirSync,readFileSync,writeFileSync,copyFileSync,cpSync,rmSync,renameSync,symlinkSync,existsSync,realpathSync,lstatSync,readdirSync,utimesSync,readlinkSync} from 'node:fs';
import {join,dirname,resolve,basename,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest as configuration,tools,repository} from './config.mjs';
export function sdkName(version){if(typeof version!=='string'||version.length>64||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version))throw Error('SDK版本无效');return '公民SDK·SDK·v'+version;}
function versionOf(run){const prefix='公民SDK·SDK·v',version=run.display_title?.startsWith(prefix)?run.display_title.slice(prefix.length):'';sdkName(version);return version;}
function id(value){if(!['string','number'].includes(typeof value))throw Error('SDK Run或产物身份无效');if(typeof value==='string'&&!/^[1-9]\d*$/u.test(value))throw Error('SDK Run或产物身份无效');const result=Number(value);if(!Number.isSafeInteger(result)||result<=0)throw Error('SDK Run或产物身份无效');return result;}
function sha(value){if(typeof value!=='string'||!/^[0-9a-f]{40}$/u.test(value))throw Error('SDK源码身份无效');return value;}
function ownRun(run,expected=run?.id){if(!run||run.id!==id(expected)||run.path!=='.github/workflows/sdk.yml'||run.event!=='workflow_dispatch'||run.head_branch!=='main'||run.repository?.full_name!==repository||run.head_repository?.full_name!==repository)throw Error('SDK Run来源无效');sha(run.head_sha);id(run.run_attempt);versionOf(run);return run;}
function sorted(rows){return [...rows].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.id-a.id);}
export function nextVersion(runs){const latest=sorted(runs).find(run=>run.kind==='automation'&&run.status==='completed'&&run.conclusion==='success');if(!latest){const version=/^version: (\S+)$/mu.exec(readFileSync(new URL('../pubspec.yaml',import.meta.url),'utf8'))?.[1];sdkName(version);return version;}if(!latest.artifact)throw Error('成功自动化缺少完整SDK Artifact');const parts=versionOf(latest).split('.');parts[2]=String(BigInt(parts[2])+1n);const next=parts.join('.');sdkName(next);return next;}
export function retainedRuns(rows,protectedRuns=new Set()){
 const keep=new Set(protectedRuns),states=new Set(),activePublication=rows.some(run=>run.status!=='completed'&&run.kind!=='automation');
 for(const run of sorted(rows)){
  if(run.status!=='completed'||!run.kind){keep.add(run.id);continue;}
  const state=run.kind+'/'+(run.conclusion==='success'?'success':'failed');
  if(!states.has(state)){states.add(state);keep.add(run.id);}
  if(activePublication&&run.kind==='automation'&&run.conclusion==='success')keep.add(run.id);
 }
 return keep;
}
function reportEvent(value){if(!process.stdout.listenerCount('error'))process.stdout.on('error',()=>{});try{process.stdout.write(JSON.stringify(value)+'\n',()=>{});}catch{}}
function emit(report,value){try{report(value);}catch{}}
function line(report,text){emit(report,{event:'output',stream:'stdout',data:Buffer.from(text+'\n').toString('base64')});}
async function request(token,path,{method='GET',body,fetchImpl=fetch}={}){
 const response=await fetchImpl('https://api.github.com/repos/'+repository+'/'+path,{method,redirect:'error',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'CitizenSDK'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!response.ok)throw Error('GitHub HTTP '+response.status);return response.status===204?null:response.json();
}
async function pages(read,path,key){const rows=[];for(let page=1;;page++){const result=await read(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page),values=key?result?.[key]:result;if(!Array.isArray(values))throw Error('GitHub列表格式无效');rows.push(...values);if(values.length<100)return rows;}}
async function optional(read,path){try{return await read(path);}catch(error){if(error.message==='GitHub HTTP 404')return null;throw error;}}
async function artifacts(read,run){const rows=await pages(read,'actions/runs/'+run.id+'/artifacts','artifacts');const full=rows.filter(value=>value.name===run.display_title);if(full.length>1)throw Error('完整SDK Artifact不唯一');if(!full.length)return null;const value=full[0];id(value.id);if(value.workflow_run?.id!==run.id||value.workflow_run?.head_sha!==run.head_sha||value.workflow_run?.head_branch!=='main'||!Number.isSafeInteger(value.size_in_bytes)||value.size_in_bytes<=0)throw Error('SDK Artifact来源无效');return value;}
async function describeRun(read,row){const run=ownRun(row),artifact=await artifacts(read,run);const jobs=await pages(read,'actions/runs/'+run.id+'/attempts/'+run.run_attempt+'/jobs','jobs');const kinds=new Set(jobs.flatMap(job=>(job.steps??[]).filter(step=>step.status==='completed'&&step.conclusion==='success'&&['CitizenSDK: automation','CitizenSDK: publish'].includes(step.name)).map(step=>step.name.slice('CitizenSDK: '.length))));if(kinds.size>1||artifact&&kinds.has('publish'))throw Error('SDK Run流程身份冲突');return {...run,kind:artifact?'automation':([...kinds][0]??null),artifact};}
async function workflowRuns(read){const rows=await pages(read,'actions/workflows/sdk.yml/runs?branch=main&event=workflow_dispatch','workflow_runs');const described=[];for(const row of rows)described.push(await describeRun(read,row));return described;}
export async function automationVersion({token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl})}={}){return nextVersion(await workflowRuns(read));}
function publicationProof(release){
 if(!release?.tag_name?.startsWith('公民SDK·SDK·v'))return null;
 let proof;try{proof=JSON.parse(release.body);}catch{throw Error('SDK发布回执无效');}
 if(proof?.product_id!==configuration.product_id||proof.platform!=='sdk'||release.tag_name!==sdkName(proof.software_version)||release.target_commitish!==sha(proof.git_commit_sha))throw Error('SDK发布归属无效');
 id(proof.producer_run_id);id(proof.producer_run_attempt);if(proof.publication_run_id!==undefined){id(proof.publication_run_id);id(proof.publication_run_attempt);}return proof;
}
// 自动化与普通清理只删除本工作流Run；Release/Tag写操作只归独立发布流程。
export async function cleanupRuns({token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl}),remove=run=>request(token,'actions/runs/'+run,{method:'DELETE',fetchImpl}),report=reportEvent}={}){
 const rows=await workflowRuns(read),protectedRuns=new Set();
 for(const release of await pages(read,'releases')){const proof=publicationProof(release);if(proof){protectedRuns.add(id(proof.producer_run_id));if(proof.publication_run_id)protectedRuns.add(id(proof.publication_run_id));}}
 const keep=retainedRuns(rows,protectedRuns),deleted=[],errors=[];
 const latest=sorted(rows).find(run=>run.kind==='automation'&&run.status==='completed'&&run.conclusion==='success');
 const ready=latest?.artifact&&!latest.artifact.expired;
 for(const row of rows){if(row.status!=='completed'||keep.has(row.id))continue;
  if(row.kind==='automation'&&row.conclusion==='success'&&!ready){errors.push('新完整SDK Artifact不可用，保留旧成功');continue;}
  try{
   const current=await describeRun(read,await read('actions/runs/'+row.id));
   if(current.status!=='completed'||current.run_attempt!==row.run_attempt||current.head_sha!==row.head_sha||current.kind!==row.kind){keep.add(row.id);continue;}
   await remove(row.id);if(await optional(read,'actions/runs/'+row.id))throw Error('旧Run删除尚未确认');deleted.push(row.id);
  }catch(error){errors.push(error.message);}
 }
 if(errors.length)throw Error('SDK记录清理失败：'+errors.join('；'));
 line(report,'SDK记录清理完成；按流程保留最新成功/失败，保护活动和已发布来源，删除Run '+deleted.length+' 条');return {completed:true,deleted,kept:[...keep]};
}
export async function publicationSource({sourceRun,token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl}),current=true}={}){
 const run=await describeRun(read,await read('actions/runs/'+id(sourceRun)));
 if(run.id!==id(sourceRun)||run.kind!=='automation'||run.status!=='completed'||run.conclusion!=='success')throw Error('发布必须指定成功的SDK塔塔自动化');
 if(!run.artifact||run.artifact.expired||!/^sha256:[0-9a-f]{64}$/u.test(run.artifact.digest??''))throw Error('发布来源Artifact缺失、过期或完整性信息无效');
 if(current){const head=await read('git/ref/heads/main');if(head.object?.type!=='commit'||head.object.sha!==run.head_sha)throw Error('发布来源SHA不是当前main');}
 const again=ownRun(await read('actions/runs/'+run.id),run.id);if(again.status!=='completed'||again.conclusion!=='success'||again.run_attempt!==run.run_attempt||again.head_sha!==run.head_sha)throw Error('发布来源Run已变化');
 return {sourceRun:run.id,sourceAttempt:run.run_attempt,sourceSha:run.head_sha,artifactID:run.artifact.id,version:versionOf(run)};
}
function publicationInputs(source){return {action:'publish',version:source.version,sha:source.sourceSha,source_run:String(source.sourceRun),source_attempt:String(source.sourceAttempt),source_artifact:String(source.artifactID)};}
function sameSource(a,b){return ['sourceRun','sourceAttempt','sourceSha','artifactID','version'].every(key=>a[key]===b[key]);}
async function fileHash(file,signal){const hash=createHash('sha256');for await(const bytes of createReadStream(file,{signal}))hash.update(bytes);return hash.digest('hex');}
// 只核对准确成功Run的原始三件产物；校验不修改源产物，不重新构建SDK。
export async function verifyPublication(directory,source,signal){
 const expected=[sdkName(source.version)+'.zip',sdkName(source.version)+'.json',sdkName(source.version)+'.sha256'];
 if(realpathSync(directory)!==resolve(directory)||JSON.stringify(readdirSync(directory).sort())!==JSON.stringify([...expected].sort()))throw Error('SDK发布文件闭集无效');
 for(const file of expected){const info=lstatSync(join(directory,file));if(!info.isFile()||info.size===0)throw Error('SDK发布文件类型或长度无效');}
 if(lstatSync(join(directory,expected[1])).size>65536||lstatSync(join(directory,expected[2])).size>4096)throw Error('SDK发布回执超过边界');
 let proof;try{proof=JSON.parse(readFileSync(join(directory,expected[1]),'utf8'));}catch{throw Error('SDK发布回执格式无效');}
 if(proof?.product_id!==configuration.product_id||proof.platform!=='sdk'||proof.software_version!==source.version||proof.git_commit_sha!==source.sourceSha||proof.producer_run_id!==source.sourceRun||proof.producer_run_attempt!==source.sourceAttempt||!Array.isArray(proof.assets)||proof.assets.length!==1||proof.assets[0]?.name!==expected[0])throw Error('SDK发布回执与来源不一致');
 const zip=await fileHash(join(directory,expected[0]),signal),json=await fileHash(join(directory,expected[1]),signal);
 if(proof.assets[0].sha256!==zip||readFileSync(join(directory,expected[2]),'utf8')!==zip+'  '+expected[0]+'\n'+json+'  '+expected[1]+'\n')throw Error('SDK发布产物校验失败');
 return proof;
}
function compareVersions(a,b){const left=a.split('.').map(BigInt),right=b.split('.').map(BigInt);for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;}
// 只有已授权发布作业在新正式版读回成功后调用；自动化路径从不调用。
export async function cleanupPublications({releaseID,token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl})}={}){
 const current=await read('releases/'+id(releaseID)),proof=publicationProof(current);
 if(!proof||current.draft||current.prerelease||!current.published_at||current.assets?.length!==3||['zip','json','sha256'].some(extension=>current.assets.filter(asset=>asset.label===current.tag_name+'.'+extension&&asset.state==='uploaded').length!==1))throw Error('新正式SDK发布尚未确认');
 const source=await publicationSource({sourceRun:proof.producer_run_id,read,current:false});
 if(source.sourceSha!==proof.git_commit_sha||source.sourceAttempt!==proof.producer_run_attempt||source.version!==proof.software_version)throw Error('新正式SDK来源不一致');
 const tag=await read('git/ref/tags/'+encodeURIComponent(current.tag_name));if(tag.object?.type!=='commit'||tag.object.sha!==proof.git_commit_sha)throw Error('新正式SDK Tag不一致');
 const deleted=[];
 for(const release of await pages(read,'releases')){
  if(release.id===current.id)continue;const old=publicationProof(release);if(!old||compareVersions(old.software_version,proof.software_version)>=0)continue;
  let active=false;for(const runID of new Set([old.producer_run_id,old.publication_run_id].filter(Boolean))){const run=await optional(read,'actions/runs/'+runID);if(run&&run.status!=='completed')active=true;}if(active)continue;
  const path='git/ref/tags/'+encodeURIComponent(release.tag_name),before=await optional(read,path);
  if(before&&(before.object?.type!=='commit'||before.object.sha!==old.git_commit_sha))throw Error('旧Tag归属已变化');
  await request(token,'releases/'+release.id,{method:'DELETE',fetchImpl});
  const after=await optional(read,path);if(after){if(after.object?.type!=='commit'||after.object.sha!==old.git_commit_sha)throw Error('旧Tag归属已变化');await request(token,'git/refs/tags/'+encodeURIComponent(release.tag_name),{method:'DELETE',fetchImpl});}
  if(await optional(read,'releases/'+release.id)||await optional(read,path))throw Error('旧正式SDK删除尚未确认');deleted.push(release.id);
 }
 return {completed:true,deleted};
}
function transient(error){return error instanceof TypeError&&error.message==='fetch failed'||/^GitHub HTTP (408|429|500|502|503|504)$/u.test(error.message);}
async function follow({receipt,expectedSha,read,report,interval}){
 const runID=id(receipt?.workflow_run_id);emit(report,{event:'started',repository,runID});
 for(;;){let run;try{run=ownRun(await read('actions/runs/'+runID),runID);}catch(error){if(!transient(error))throw error;line(report,'SDK Run瞬时读取失败，继续观察同一Run');await new Promise(resolve=>setTimeout(resolve,interval));continue;}
  if(run.head_sha!==expectedSha)throw Error('SDK派发Run源码不一致');emit(report,{event:'run',run});
  try{emit(report,{event:'jobs',jobs:await read('actions/runs/'+runID+'/jobs?per_page=100&page=1')});}catch(error){if(!transient(error))throw error;line(report,'SDK Job瞬时读取失败，保留同一Run');}
  if(run.status==='completed')return {runID};await new Promise(resolve=>setTimeout(resolve,interval));
 }
}
export async function automate({token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl}),dispatch=spec=>request(token,'actions/workflows/'+spec.workflow+'/dispatches',{method:'POST',body:{ref:spec.ref,inputs:spec.inputs},fetchImpl}),remove,report=reportEvent,interval=3000}={}){
 const rows=await workflowRuns(read),head=await read('git/ref/heads/main');if(head.object?.type!=='commit')throw Error('SDK main身份无效');const expectedSha=sha(head.object.sha);
 const receipt=await dispatch({workflow:'sdk.yml',ref:'main',inputs:{action:'automation',version:nextVersion(rows),sha:expectedSha}});
 const result=await follow({receipt,expectedSha,read,report,interval});await cleanupRuns({token,fetchImpl,read,remove,report});return result;
}
export async function publish({sourceRun,token,fetchImpl=fetch,read=path=>request(token,path,{fetchImpl}),dispatch=spec=>request(token,'actions/workflows/'+spec.workflow+'/dispatches',{method:'POST',body:{ref:spec.ref,inputs:spec.inputs},fetchImpl}),remove,report=reportEvent,interval=3000}={}){
 const source=await publicationSource({sourceRun,read});const receipt=await dispatch({workflow:'sdk.yml',ref:'main',inputs:publicationInputs(source)});
 const result=await follow({receipt,expectedSha:source.sourceSha,read,report,interval});await cleanupRuns({token,fetchImpl,read,remove,report});return result;
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
 sdkName(source.version);if(sourceRun!==undefined&&id(sourceRun)!==source.sourceRun||sourceAttempt!==undefined&&id(sourceAttempt)!==source.sourceAttempt)throw Error('SDK交付Run或attempt不一致');await verifyPublication(directory,source,signal);signal.throwIfAborted();
 work=mkdtempSync(join(dirname(output),'sdk-'));
  const input=join(work,'input');mkdirSync(input);for(const extension of ['zip','json','sha256'])copyFileSync(join(directory,sdkName(source.version)+'.'+extension),join(input,sdkName(source.version)+'.'+extension));await verifyPublication(input,source,signal);
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
async function run(command,args,{cwd=root,env={},capture=false,signal:taskSignal=controller.signal,trim=true}={}){
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
   if(taskSignal.aborted&&process.platform!=='win32'){await new Promise(resolve=>setTimeout(resolve,2100));try{process.kill(-child.pid,0);const failure=Error('子进程退出尚未确认，保留现场');failure.keepWork=true;return fail(failure);}catch(value){if(value.code!=='ESRCH')return fail(value);}}
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
   error||code!==0||signal||taskSignal.aborted?fail(error||Error(basename(command)+'执行失败')):ok(trim?output.trim():output);
  });
 });
}
function put(path,bytes){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes,{flag:'wx'});}
function copy(source,output){mkdirSync(dirname(output),{recursive:true});cpSync(source,output,{recursive:true,verbatimSymlinks:true});}
export function createFlutterSourceView(source,output,{flutter=true}={}){
 if(realpathSync(source)!==source||resolve(output)!==output||source===output||output.startsWith(source+sep)&&!output.startsWith(join(source,'target')+sep)||existsSync(output))throw Error('SDK工程输入输出无效');
 mkdirSync(output,{recursive:true});
 const excluded=new Set(['.git','target','build','.dart_tool','.gradle','node_modules','Pods','.DS_Store']);
 function visit(at){for(const name of readdirSync(at)){if(excluded.has(name))continue;const from=join(at,name),entry=relative(source,from),to=join(output,entry),info=lstatSync(from);
  if(info.isDirectory()){mkdirSync(to,{recursive:true});visit(from);}else if(info.isFile()){copyFileSync(from,to);utimesSync(to,info.atime,info.mtime);}
  else if(info.isSymbolicLink()){
   // 发布SDK只允许Apple标准Framework的五个内部相对链接，禁止借包内路径访问外部文件。
   const frame=framework,path=entry.split(sep).join('/'),links=frameworkLinks;
   const target=realpathSync(from);if(!path.startsWith(frame)||links[path.slice(frame.length)]!==readlinkSync(from)||!target.startsWith(join(source,frame,'Versions/A')+sep)&&target!==join(source,frame,'Versions/A'))throw Error('SDK源码链接越界');symlinkSync(readlinkSync(from),to,lstatSync(target).isDirectory()?'dir':'file');
  }else throw Error('SDK源码输入禁止特殊文件');
 }}visit(source);
 // 仅Flutter交付包按官方工具的固定入口装配；普通构建副本保持仓库标准源码布局。
 const from=join(output,'android/flutter/CitizenSdkPlugin.kt'),to=join(output,'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt');
 if(flutter&&existsSync(from)){if(existsSync(to))throw Error('Flutter入口重复');mkdirSync(dirname(to),{recursive:true});renameSync(from,to);}
 return output;
}
export function assertFlutterSourceView(source,output){
 for(const name of ['pubspec.yaml','pubspec.lock','include/citizensdk.h'])if(!readFileSync(join(source,name)).equals(readFileSync(join(output,name))))throw Error('SDK原锁或公开头漂移');return output;
}
export function citizenSdkInternalHeader(){return "#ifndef CITIZENSDK_INTERNAL_H\n#define CITIZENSDK_INTERNAL_H\n#include \"citizensdk.h\"\n#ifdef __cplusplus\nextern \"C\" {\n#endif\n/* 同步硬件元数据接口，配置/输入只借用于本次调用。generation action:1 ensure,2 active,3 owner,4 retire,5 Linux物理对象存在性。 */\nint32_t citizensdk_store_generation(const citizensdk_store_v1_t*,uint32_t,const citizensdk_host_wallet_key_ref_v1_t*,const citizensdk_host_id128_t*,uint8_t*);\nint32_t citizensdk_store_generations(const citizensdk_store_v1_t*,citizensdk_host_wallet_key_ref_v1_t*,uint64_t,uint64_t*);\nint32_t citizensdk_store_has_secret(const citizensdk_store_v1_t*,const citizensdk_account_id_t*,uint8_t*);\n/* object action:1 load,2 store-owned,3 active,4 delete。五字段固定为key_name/public/private/name/salt；输出先全部验容量后再写，均为密封对象或公开身份。 */\nint32_t citizensdk_store_object(const citizensdk_store_v1_t*,uint32_t,const citizensdk_host_wallet_key_ref_v1_t*,const citizensdk_host_id128_t*,const citizensdk_bytes_view_t*,const citizensdk_mutable_bytes_view_t*,uint64_t*,uint8_t*);\n#ifdef __cplusplus\n}\n#endif\n#endif\n";}
function privateHeaders(project,work){
 const directory=join(work,'private');put(join(directory,'citizensdk_internal.h'),citizenSdkInternalHeader());copy(join(project,'image/citizensdk_qr_image.h'),join(directory,'citizensdk_qr_image.h'));
 put(join(directory,'module.modulemap'),'module CitizenSDKInternal { header "citizensdk_internal.h" header "citizensdk_qr_image.h" export * }\n');return directory;
}
function files(directory){return readdirSync(directory,{recursive:true}).map(name=>join(directory,name)).filter(path=>lstatSync(path).isFile());}
async function cargo(project,triple,env){
 await run('rustup',['target','add','--toolchain',tools.rust,triple],{env});
 // 正式目标只生成实际链接或交付的一种Core；测试沿原Cargo声明保留rlib。
 await run('cargo',['rustc','--locked','--release','-p','citizen-sdk-ffi','--lib','--crate-type',triple.includes('-apple-')?'staticlib':'cdylib','--target',triple],{cwd:project,env});return join(env.CARGO_TARGET_DIR,triple,'release');
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
async function android(project,work,env,headers){
 const ndk=process.env.ANDROID_NDK_HOME||process.env.ANDROID_NDK_ROOT;if(!ndk||!readFileSync(join(ndk,'source.properties'),'utf8').includes('Pkg.Revision = '+tools.ndk))throw Error('缺少锁定官方NDK');
 const bin=join(ndk,'toolchains/llvm/prebuilt',process.platform==='darwin'?'darwin-x86_64':'linux-x86_64','bin'),triple='aarch64-linux-android';
 const environment={...env,CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS:'-C link-arg=-Wl,-soname,libcitizensdk.so',CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:join(bin,'aarch64-linux-android24-clang'),CC_aarch64_linux_android:join(bin,'aarch64-linux-android24-clang'),AR_aarch64_linux_android:join(bin,'llvm-ar'),SDK_NM:join(bin,'llvm-nm')};
 const core=await cargo(project,triple,environment),stage=join(work,'core/arm64-v8a');copy(join(core,'libcitizensdk.so'),join(stage,'libcitizensdk.so'));
 await run(join(bin,'llvm-strip'),['--strip-unneeded',join(stage,'libcitizensdk.so')],{env:environment});await verifySymbols(join(stage,'libcitizensdk.so'),project,environment);
 const dynamic=await run(join(bin,'llvm-readelf'),['--dynamic-table',join(stage,'libcitizensdk.so')],{env:environment,capture:true});if(!/\(SONAME\).*\[libcitizensdk\.so\]/u.test(dynamic))throw Error('Android Core装载名称无效');
 const metadata=JSON.parse(await run('cargo',['metadata','--locked','--format-version','1'],{cwd:project,env:environment,capture:true}));
 const declaration=join(project,'android/build.gradle');if(!lstatSync(declaration).isFile()||lstatSync(declaration).size>65536)throw Error('SDK Android声明无效');
 const version=/implementation 'rustls:rustls-platform-verifier:([^']+)'/u.exec(readFileSync(join(project,'android/build.gradle'),'utf8'))?.[1];
 const verifier=metadata.packages.filter(value=>value.name==='rustls-platform-verifier-android'&&value.version===version);if(verifier.length!==1)throw Error('Android证书组件没有唯一原锁来源');
 const gradleHome=join(dirname(env.CARGO_TARGET_DIR),'gradle-home');mkdirSync(gradleHome,{recursive:true});const maven=join(dirname(verifier[0].manifest_path),'maven');copy(maven,join(project,'android/maven'));
 for(const name of ['settings.gradle','build.gradle','native/build.gradle'])put(join(work,'gradle-project',name),`apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/${name}')\n`);
 const androidEnv={...environment,CITIZENSDK_WORK_DIR:work,CITIZENSDK_SOURCE_DIR:project,CITIZENSDK_ANDROID_BUILD_DIR:join(work,'gradle-output'),CITIZENSDK_ANDROID_CORE_DIR:stage,CITIZENSDK_INTERNAL_INCLUDE_DIR:headers,CITIZENSDK_FLUTTER_ROOT:process.env.FLUTTER_ROOT,GRADLE_USER_HOME:gradleHome};
 await run('gradle',['--no-daemon','-Pandroid.onlyEnableUnitTestForTheTestedBuildType=false','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),':native:testReleaseUnitTest',':native:assembleRelease'],{env:androidEnv});
 const output=join(work,'output/android'),aar=join(work,'gradle-output/native/outputs/aar/native-release.aar');copy(maven,join(output,'maven'));copy(aar,join(output,'citizensdk.aar'));copy(join(stage,'libcitizensdk.so'),join(output,'src/main/jniLibs/arm64-v8a/libcitizensdk.so'));
 await run('unzip',['-o',aar,'jni/arm64-v8a/libcitizensdk_jni.so','-d',join(work,'aar')],{env:androidEnv});copy(join(work,'aar/jni/arm64-v8a/libcitizensdk_jni.so'),join(output,'src/main/jniLibs/arm64-v8a/libcitizensdk_jni.so'));
 copy(join(work,'aar/jni/arm64-v8a/libcitizensdk_jni.so'),join(stage,'libcitizensdk_jni.so'));verifyImageSymbols(await run(join(bin,'llvm-nm'),['-D','--defined-only',join(stage,'libcitizensdk_jni.so')],{env:environment,capture:true}),readFileSync(join(project,'image/citizensdk_qr_image.h'),'utf8')); const dependencies=await run(join(bin,'llvm-readelf'),['--dynamic-table',join(stage,'libcitizensdk_jni.so')],{env:environment,capture:true});if(!/\(NEEDED\).*\[libcitizensdk\.so\]/u.test(dependencies)||/\(NEEDED\).*\[[^\]]*[\\/]/u.test(dependencies))throw Error('Android JNI装载依赖无效');await run('gradle',['--no-daemon','-Pandroid.onlyEnableUnitTestForTheTestedBuildType=false','--no-problems-report','--project-cache-dir',join(work,'gradle-cache'),'-p',join(work,'gradle-project'),':testReleaseUnitTest'],{env:androidEnv});
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
 for(const [slice,triple,identity]of [['ios-arm64','aarch64-apple-ios','arm64-apple-ios'],['ios-arm64-simulator','aarch64-apple-ios-sim','arm64-apple-ios-simulator'],['macos-arm64','aarch64-apple-darwin','arm64-apple-macos']])for(const extension of ['swiftmodule','swiftdoc','swiftsourceinfo']){const from=join(work,triple,'CitizenSDK.framework/Modules/CitizenSDK.swiftmodule',identity+'.'+extension),to=join(output,slice,'CitizenSDK.framework/Modules/CitizenSDK.swiftmodule',identity+'.'+extension);if(existsSync(from)){if(existsSync(to)){if(!readFileSync(from).equals(readFileSync(to)))throw Error('XCFramework二进制模块漂移');}else copy(from,to);}}
 await appleTests(project,work,env,headers);
}
async function appleTests(project,work,env,headers){
 const harness=join(work,'apple-tests'),core=join(env.CARGO_TARGET_DIR,'aarch64-apple-darwin/release'),qr=join(work,'aarch64-apple-darwin/qr');
 for(const name of ['citizensdk.h','citizensdk_types.h'])copy(join(project,'include',name),join(harness,'Sources/CitizenSDKC/include',name));copy(join(project,'image/citizensdk_qr_image.h'),join(harness,'Sources/CitizenSDKC/include/citizensdk_qr_image.h'));put(join(harness,'Sources/CitizenSDKC/harness.c'),'#include "citizensdk.h"\nint citizensdk_test_anchor(void){return 0;}\n');
 for(const file of files(join(project,'darwin/src')).filter(path=>path.endsWith('.swift')))put(join(harness,'Sources/CitizenSDK',basename(file)),'import CitizenSDKC\n'+readFileSync(file,'utf8'));
 put(join(harness,'Sources/CitizenSDK/CitizenSDKCExports.swift'),'@_exported import CitizenSDKC\n');copy(join(project,'darwin/citizen_sdk'),join(harness,'Sources/CitizenSDKFlutter'));
 // 同一平面测试目录按所属模块装配SwiftPM目标，每个测试只编译一次。
 for(const name of readdirSync(join(project,'darwin/tests')).filter(name=>name.endsWith('.swift')))copy(join(project,'darwin/tests',name),join(harness,'Tests',name.startsWith('CitizenSDKFlutter')?'CitizenSDKFlutterTests':'CitizenSDKTests',name));
 const engine=join(process.env.FLUTTER_ROOT,'bin/cache/artifacts/engine'),artifacts=readdirSync(engine).filter(name=>/^darwin-.*-release$/u.test(name)).map(name=>join(engine,name,'FlutterMacOS.xcframework')).filter(existsSync);if(artifacts.length!==1)throw Error('官方Flutter macOS Release framework不唯一');copy(artifacts[0],join(harness,'Artifacts/FlutterMacOS.xcframework'));
 const libraries=appleLibraries(core,qr);
 const flutterSlice=readdirSync(artifacts[0]).map(name=>join(artifacts[0],name,'FlutterMacOS.framework')).find(existsSync);if(!flutterSlice)throw Error('Flutter macOS framework缺失');
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
 .testTarget(name: "CitizenSDKFlutterTests", dependencies: ["CitizenSDK", "CitizenSDKFlutter"], swiftSettings: flags, linkerSettings: [.unsafeFlags(${JSON.stringify(['-Xlinker','-rpath','-Xlinker',dirname(flutterSlice)])})])
], swiftLanguageVersions: [.v5])\n`);
 const scratch=join(harness,'build'),args=['--package-path',harness,'--configuration','release','--scratch-path',scratch];await run('swift',['build','--build-tests',...args],{env});
 const bundles=readdirSync(scratch,{recursive:true}).filter(name=>name.endsWith('.xctest')).map(name=>join(scratch,name));if(!bundles.length)throw Error('Apple XCTest未生成');
 // Flutter测试目标通过原官方框架目录的rpath加载binaryTarget，不再复制；这里只补齐chain资源。
 for(const bundle of bundles)copy(join(project,'chain'),join(bundle,'Contents/Resources/chain'));
 await run('swift',['test','--skip-build',...args],{env});
 // 同一正式Rust/图像静态库装配真实FFI测试库，不替代业务和结果投影。
 const fixture=join(work,'ffi.dylib');
 await run('xcrun',['clang++','-std=c++17','-dynamiclib','-fPIC','-Wall','-Wextra','-Wpedantic','-Wconversion','-Wsign-conversion','-Werror','-I'+join(project,'include'),'-I'+headers,join(project,'test/cpp.cc'),...libraries.map(path=>'-Wl,-force_load,'+path),'-framework','Security','-framework','SystemConfiguration','-framework','CoreFoundation','-lsqlite3','-lc++','-liconv','-lresolv','-o',fixture],{env});
 const flutter=join(process.env.FLUTTER_ROOT,'bin/flutter');
 await run(flutter,['pub','get','--enforce-lockfile'],{cwd:project,env});
 // ffigen只能修改构建副本；头文件与提交绑定不一致则失败，不能手修签名。
 const binding=join(project,'lib/platform/bind.dart'),expected=readFileSync(binding);
 await run(join(process.env.FLUTTER_ROOT,'bin/dart'),['run','ffigen'],{cwd:project,env});
 if(!readFileSync(binding).equals(expected))throw Error('C ABI生成绑定与源码不一致');
 await run(flutter,['test','--no-pub','--reporter=expanded','test/platform/ffi_test.dart'],{cwd:project,env:{...env,CITIZENSDK_TEST_LIBRARY:fixture,CITIZENSDK_TEST_WORK_DIR:work}});
}
async function desktop(project,work,env,headers,target){
 const windows=target==='Windows',triple=windows?'x86_64-pc-windows-msvc':'aarch64-unknown-linux-gnu',platform=windows?'windows':'linux',core=await cargo(project,triple,env);
 const output=join(work,'output',platform),cmake=join(work,'cmake'),definitions={CMAKE_BUILD_TYPE:'Release',CMAKE_INSTALL_PREFIX:output,CMAKE_INSTALL_LIBDIR:'lib',CMAKE_INSTALL_INCLUDEDIR:'include',CMAKE_INSTALL_DATADIR:'share',CMAKE_INSTALL_BINDIR:'bin',CITIZENSDK_PLATFORM:target,CITIZENSDK_CORE_LIBRARY:join(core,windows?'citizensdk.dll':'libcitizensdk.so'),CITIZENSDK_CORE_INCLUDE_DIR:join(project,'include'),CITIZENSDK_INTERNAL_INCLUDE_DIR:headers,CITIZENSDK_ASSET_DIR:join(project,'chain'),CITIZENSDK_ZXING_SOURCE_DIR:process.env.CITIZENSDK_ZXING_SOURCE_DIR,CITIZENSDK_DART_INCLUDE_DIR:join(process.env.FLUTTER_ROOT,'bin/cache/dart-sdk/include'),CITIZENSDK_BUILD_TESTS:'ON',CITIZENSDK_TEST_WORK_DIR:join(work,'test-state')};
 if(windows)definitions.CITIZENSDK_CORE_IMPORT_LIBRARY=join(core,'citizensdk.dll.lib');else definitions.CITIZENSDK_ENABLE_QR_CAPTURE='ON';
 for(const name of ['SQLITE_INCLUDE_DIR','SQLITE_ARCHIVE',...windows?[]:['OPENSSL_INCLUDE_DIR','TSS2_INCLUDE_DIR','CRYPTO_ARCHIVE','TSS2_ESYS_ARCHIVE','TSS2_MU_ARCHIVE','TSS2_SYS_ARCHIVE','TSS2_RC_ARCHIVE','TSS2_TCTI_DEVICE_ARCHIVE']]){const value=process.env['CITIZENSDK_'+name];if(!value)throw Error('缺少宿主依赖：'+name);definitions['CITIZENSDK_'+name]=value;}
 if(!windows)mkdirSync(join(work,'test-state'),{mode:0o700});
 await run('cmake',['-S',join(project,platform),'-B',cmake,...windows?['-G','Ninja']:[],...Object.entries(definitions).map(([key,value])=>'-D'+key+'='+value)],{env});await run('cmake',['--build',cmake,'--config','Release','--parallel'],{env});await run('ctest',['--test-dir',cmake,'-C','Release','--no-tests=error','--output-on-failure'],{env});await run('cmake',['--install',cmake,'--config','Release'],{env});
 if(!windows){mkdirSync(join(work,'consumer-state'),{mode:0o700});}
 const consumer=join(work,'consumer');await run('cmake',['-S',join(project,platform,'tests'),'-B',consumer,...windows?['-G','Ninja']:[],'-DCITIZENSDK_CONSUMER_PREFIX='+output,'-DCITIZENSDK_CONSUMER_VERSION='+/^version: (\S+)$/mu.exec(readFileSync(join(project,'pubspec.yaml'),'utf8'))[1],'-DCITIZENSDK_PLATFORM='+target,'-DCITIZENSDK_TEST_WORK_DIR='+join(work,'consumer-state')],{env});await run('cmake',['--build',consumer,'--config','Release','--parallel'],{env});await run('ctest',['--test-dir',consumer,'-C','Release','--no-tests=error','--output-on-failure'],{env});await desktopFlutter(project,work,env,target,output);
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
 copyFileSync(join(project,'pubspec.lock'),join(runner,'pubspec.lock'));copyFileSync(join(project,'test/consumers',platform+'.dart'),join(runner,'lib/main.dart'));
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
 sdkName(version);const pub=join(project,'pubspec.yaml');writeFileSync(pub,readFileSync(pub,'utf8').replace(/^version: .+$/mu,'version: '+version));
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
 const declaration=readFileSync(pub,'utf8'),version=/^version: (\S+)$/mu.exec(declaration)?.[1];sdkName(version);
 if(readFileSync(join(root,'pubspec.yaml'),'utf8').replace(/^version: .+$/mu,'version: '+version)!==declaration)throw Error('SDK包声明与锁定源码不符');
 for(const name of ['Cargo.lock','pubspec.lock','include/citizensdk.h','include/citizensdk_types.h','lib/platform/bind.dart'])if(lstatSync(join(root,name)).size!==lstatSync(join(project,name)).size||!readFileSync(join(root,name)).equals(readFileSync(join(project,name))))throw Error('SDK交付与锁定源码接口不一致');
 return project;
}
export async function build({target,test=false,version=process.env.SDK_VERSION||/^version: (\S+)$/mu.exec(readFileSync(join(root,'pubspec.yaml'),'utf8'))[1],native}={}){
 sdkName(version);if(process.versions.node!==tools.node)throw Error('Node版本与本产品声明不一致');
 if(!test&&!native&&!['Android','Apple','LinuxARM','Windows'].includes(target))throw Error('编译必须选择真实内部目标或汇总完整产物');
 const base=join(root,'target',test?'test':'build');mkdirSync(base,{recursive:true});if(realpathSync(base)!==base)throw Error('任务目录经过链接');const work=mkdtempSync(join(base,'sdk-')),cache=claimCache(work);let complete=false,safe=true;
 try{
  if(cache.project)rmSync(cache.project,{recursive:true,force:true});
  const project=createFlutterSourceView(root,cache.project||join(work,'project'),{flutter:false}),env={RUSTUP_TOOLCHAIN:tools.rust,CARGO_TARGET_DIR:cache.cargo,CARGO_INCREMENTAL:'1'},headers=privateHeaders(project,work);
  if(test){await run('cargo',['test','--workspace','--locked','--','--include-ignored','--test-threads=1'],{cwd:project,env});put(join(project,'analysis_options.yaml'),'include: package:flutter_lints/flutter.yaml\nanalyzer:\n  language:\n    strict-casts: true\n    strict-inference: true\n    strict-raw-types: true\n  errors:\n    invalid_use_of_visible_for_testing_member: error\n    missing_required_param: error\n    missing_return: error\nlinter:\n  rules:\n    avoid_dynamic_calls: false\n    directives_ordering: true\n    discarded_futures: true\n    prefer_final_locals: true\n    unawaited_futures: true\n');const flutter=join(process.env.FLUTTER_ROOT||join(root,'target/cache/flutter'),'bin',process.platform==='win32'?'flutter.bat':'flutter');await run(flutter,['pub','get','--enforce-lockfile'],{cwd:project,env});await run(flutter,['analyze','--fatal-infos'],{cwd:project,env});const tests=files(join(project,'test')).filter(path=>path.endsWith('_test.dart')&&relative(project,path).split(sep).join('/')!=='test/platform/ffi_test.dart').sort();if(!tests.length)throw Error('Dart测试缺失');await run(flutter,['test','--no-pub','--reporter=expanded',...tests],{cwd:project,env});return {tests:true};}
  if(native){const output=createFlutterSourceView(root,join(work,'output'));for(const name of ['android','darwin','linux','windows'])copy(join(native,name),join(output,name));setVersion(output,version);verifyComplete(output);}
  else{setVersion(project,version);if(target==='Android')await android(project,work,env,headers);else if(target==='Apple')await apple(project,work,env,headers,version);else await desktop(project,work,env,headers,target);}
  for(const name of readdirSync(work))if(name!=='output')rmSync(join(work,name),{recursive:true,force:true});complete=true;return {work,output:join(work,'output')};
 }catch(error){safe=!error.keepWork;throw error;}finally{if(safe){cache.release();if(!complete)rmSync(work,{recursive:true,force:true});}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&!process.env.NODE_TEST_CONTEXT){
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>controller.abort());
 try{
  const [command,arg]=process.argv.slice(2),token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  if(command==='automate')await automate({token});
  else if(command==='publish')await publish({token,sourceRun:arg});
  else if(command==='cleanup')console.log(JSON.stringify(await cleanupRuns({token})));
  else if(command==='version')console.log(await automationVersion({token}));
  else if(command==='verify')console.log(JSON.stringify({output:verifyConsumer(arg)}));
  else if(command==='consume'){const destination=process.argv[4];console.log(JSON.stringify(await consume({directory:process.env.CITIZENSDK_PACKAGE,sourceSha:arg,output:destination})));}
  else if(command==='source')console.log(JSON.stringify(await publicationSource({token,sourceRun:arg})));
  else if(command==='verify-publication'||command==='cleanup-publications'){
   if(process.env.GITHUB_ACTIONS!=='true'||process.env.SDK_ACTION!=='publish'||process.env.GITHUB_REPOSITORY!==repository||process.env.GITHUB_REF!=='refs/heads/main')throw Error('只允许独立SDK发布作业执行');
   const source=await publicationSource({token,sourceRun:process.env.SOURCE_RUN}),expected={sourceRun:id(process.env.SOURCE_RUN),sourceAttempt:id(process.env.SOURCE_ATTEMPT),sourceSha:sha(process.env.SOURCE_SHA),artifactID:id(process.env.SOURCE_ARTIFACT),version:process.env.SDK_VERSION};
   if(!sameSource(source,expected)||source.sourceSha!==process.env.GITHUB_SHA)throw Error('发布选择与准确来源不一致');
   if(command==='verify-publication'){const proof=await verifyPublication(arg,source);console.log(JSON.stringify({...proof,publication_run_id:id(process.env.GITHUB_RUN_ID),publication_run_attempt:id(process.env.GITHUB_RUN_ATTEMPT)}));}
   else console.log(JSON.stringify(await cleanupPublications({token,releaseID:arg})));
  }else if(command==='test')console.log(JSON.stringify(await build({test:true})));
  else if(command==='native')console.log(JSON.stringify(await build({target:arg})));
  else if(command==='package'&&arg)console.log(JSON.stringify(await build({native:resolve(arg)})));
  else throw Error('用法：node scripts/build.mjs automate | publish 来源Run | cleanup | consume 源码SHA 输出；test/native/package/version/source/verify-publication/cleanup-publications为流程内部命令');
 }
 catch(error){console.error(error.message);process.exitCode=1;}
}
