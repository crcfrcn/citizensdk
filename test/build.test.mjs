// 最简入口仍必须保持SDK完整性、Cargo真实布局、原锁、缓存与版本边界。
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,readlinkSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {root,claimCache,createFlutterSourceView,verifyComplete,setVersion,appleLibraries,verifyImageSymbols,flutterChecks,waitGroup} from '../scripts/build.mjs';
import {nextVersion,retainedRuns,sdkName,cleanupRuns,cleanupCaches,automate,publicationSource,verifyPublication,cleanupPublications,consume} from '../scripts/build.mjs';
import {describeAction,tools,nativeSources} from '../scripts/config.mjs';
function fixture(t){const base=join(root,'target/test');mkdirSync(base,{recursive:true});const work=mkdtempSync(join(base,'regression-'));t.after(()=>rmSync(work,{recursive:true,force:true}));return work;}

test('Unix收尾只读取准确进程组，无成员或已退出Z状态不被其他任务阻塞',async()=>{
 const env={LANG:'C'};
 for(const stdout of ['1 Ss\n14567 R+\n','4567 Z\n',' 4567 Z+\r\n 4567 Zs\r\n 8 Ss\r\n']){
  let reads=0;await waitGroup(4567,{env,inspect:(command,args,options)=>{
   reads++;assert.equal(command,'ps');assert.deepEqual(args,['-A','-o','pgid=','-o','stat=']);assert.deepEqual(options,{env,encoding:'utf8',maxBuffer:16*1024**2});return {status:0,stdout};
  },pause:async()=>assert.fail('已退出不能继续等待')});assert.equal(reads,1);
 }
});
test('Unix活动后代必须按原间隔等待至消失，不能将其他进程组当作本轮成员',async()=>{
 const snapshots=['4567 S+\n14567 R\n','4567 R\n','14567 R\n'],pauses=[];let reads=0;
 await waitGroup(4567,{attempts:2,inspect:()=>({status:0,stdout:snapshots[reads++]}),pause:async ms=>pauses.push(ms)});
 assert.equal(reads,3);assert.deepEqual(pauses,[100,100]);
});
test('Unix读取权限、解析或等待失败均保留现场，不把未知状态当退出',async()=>{
 const denied=Object.assign(new Error('synthetic read denial'),{code:'EPERM'});
 const cases=[
  ()=>{throw denied;},()=>({error:denied,status:null,stdout:''}),()=>({status:1,stdout:'1 Ss\n'}),
  ()=>({status:0,signal:'SIGTERM',stdout:'1 Ss\n'}),()=>({status:0,stdout:''}),
  ()=>({status:0,stdout:'invalid'}),()=>({status:0,stdout:'4567 S extra\n'}),
  ()=>({status:0,stdout:'9007199254740992 S\n'}),()=>({status:0,stdout:null}),
 ];
 for(const inspect of cases)await assert.rejects(waitGroup(4567,{inspect,pause:async()=>assert.fail('读取失败不能重试')}),error=>error.keepWork===true);
 await assert.rejects(waitGroup(4567,{inspect:()=>{throw denied;}}),error=>error.keepWork===true&&error.cause===denied);
 const interrupted=new Error('synthetic wait interruption');
 await assert.rejects(waitGroup(4567,{inspect:()=>({status:0,stdout:'4567 S\n'}),pause:async()=>{throw interrupted;}}),error=>error.keepWork===true&&error.cause===interrupted);
 for(const pid of [0,1,-1,NaN,2147483648])await assert.rejects(waitGroup(pid,{inspect:()=>assert.fail('非法组身份不能读取进程表')}),error=>error.keepWork===true);
});
test('Unix活动或未知成员超时仍失败，取消核对不增加原等待期限',async()=>{
 for(const state of ['S','R+','?','Zunknown'])for(const attempts of [0,2]){
  let reads=0;const pauses=[];await assert.rejects(waitGroup(4567,{attempts,inspect:()=>{reads++;return {status:0,stdout:'4567 '+state+'\n'};},pause:async ms=>pauses.push(ms)}),error=>error.keepWork===true);
  assert.equal(reads,attempts+1);assert.deepEqual(pauses,Array(attempts).fill(100));
 }
});
test('SDK唯一平台与版本，失败不递增，只留最新成功和失败并保护活动任务',()=>{
 const row=(id,version,conclusion,status='completed')=>({id,run_number:id,display_title:'公民SDK·SDK·v'+version,conclusion,status});
 const rows=[row(2,'1.2.9','success'),row(3,'1.2.10','failure'),row(4,'1.2.10',null,'queued')];assert.equal(sdkName('1.2.10'),'公民SDK·SDK·v1.2.10');assert.equal(nextVersion(rows),'1.2.10');assert.deepEqual([...retainedRuns([row(1,'1.2.8','success'),...rows])].sort(),[2,3,4]);for(const value of ['1.0','01.0.0','1.0.0\n','1.0.0-beta'])assert.throws(()=>sdkName(value));
});
test('隔离副本直接使用标准Cargo源码，原锁和正式源码不被版本写入污染',t=>{
 const work=fixture(t),output=createFlutterSourceView(root,join(work,'project'),{flutter:false});
 for(const name of ['types','store','core','ffi','sign','net','qr'])for(const file of ['Cargo.toml','src/lib.rs'])assert.ok(readFileSync(join(root,name,file)).equals(readFileSync(join(output,name,file))));
 assert.ok(readFileSync(join(root,'Cargo.lock')).equals(readFileSync(join(output,'Cargo.lock'))));setVersion(output,'1.2.3');assert.match(readFileSync(join(output,'pubspec.yaml'),'utf8'),/^version: 1\.2\.3$/mu);assert.doesNotMatch(readFileSync(join(root,'pubspec.yaml'),'utf8'),/^version: 1\.2\.3$/mu);assert.throws(()=>createFlutterSourceView(root,output));
});
test('自有源码最多三层，上游与工具生成物沿用标准结构',()=>{
 const excluded=new Set(['.git','target','build','.dart_tool','.gradle','node_modules','Pods']);
 function visit(at,depth){for(const entry of readdirSync(at,{withFileTypes:true})){if(excluded.has(entry.name)||depth===0&&entry.name==='smoldot')continue;assert.ok(depth+1<=3,join(at,entry.name));if(entry.isDirectory())visit(join(at,entry.name),depth+1);}}
 visit(root,0);
});
test('Flutter交付入口使用官方目录且同一包内只有一个插件类源文件',t=>{
 const work=fixture(t),output=createFlutterSourceView(root,join(work,'package'));
 assert.equal(existsSync(join(output,'android/flutter/CitizenSdkPlugin.kt')),false);
 assert.ok(readFileSync(join(root,'android/flutter/CitizenSdkPlugin.kt')).equals(readFileSync(join(output,'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt'))));
});

// 真实缓存解析与命令接续只替换进程执行，不启动合成工具或另建工具来源。
test('Flutter两端接续工程记录的CMake和CTest，保留参数与各自环境',async t=>{
 const work=fixture(t),tools=join(work,'Flutter tools'),cmake=join(tools,'cmake'),ctest=join(tools,'ctest');mkdirSync(tools);writeFileSync(cmake,'synthetic');writeFileSync(ctest,'synthetic');
 writeFileSync(join(work,'CMakeCache.txt'),'# Flutter generated\r\nCMAKE_COMMAND:INTERNAL='+cmake+'\r\nCMAKE_CTEST_COMMAND:INTERNAL='+ctest+'\r\n');
 const env={CITIZENSDK_TEST_WORK_DIR:work},testEnv={...env,LD_LIBRARY_PATH:work};
 for(const label of ['LinuxFlutter','WindowsFlutter']){
  const calls=[];await flutterChecks(work,label,{env,testEnv,runImpl:async(command,args,options)=>{calls.push({command,args,options});}});
  assert.deepEqual(calls,[{command:cmake,args:['--build',work,'--config','Release','--target','citizensdk_flutter_checks','--parallel'],options:{env}},{command:ctest,args:['--test-dir',work,'-C','Release','-L',label,'--no-tests=error','--output-on-failure'],options:{env:testEnv}}]);
 }
});
test('Flutter工程工具记录缺失、重复或路径无效时，在任何工具启动前失败',async t=>{
 const work=fixture(t),cmake=join(work,'cmake'),ctest=join(work,'ctest'),cache=join(work,'CMakeCache.txt');writeFileSync(cmake,'synthetic');writeFileSync(ctest,'synthetic');
 const valid='CMAKE_COMMAND:INTERNAL='+cmake+'\nCMAKE_CTEST_COMMAND:INTERNAL='+ctest+'\n';let calls=0;
 const runImpl=async()=>{calls++;};
 await assert.rejects(flutterChecks(work,'WindowsFlutter',{runImpl}),{code:'ENOENT'});
 for(const text of ['',valid.replace(/^CMAKE_COMMAND[^\n]*\n/u,''),valid.replace(/CMAKE_CTEST_COMMAND[^\n]*\n/u,''),valid+'CMAKE_COMMAND:INTERNAL='+cmake+'\n',valid+'CMAKE_CTEST_COMMAND:FILEPATH='+ctest+'\n',valid.replace('CMAKE_COMMAND:INTERNAL=','CMAKE_COMMAND:FILEPATH='),valid.replace(cmake,''),valid.replace(cmake,'relative/cmake'),valid.replace(ctest,join(work,'missing')),valid.replace(ctest,work)]){
  writeFileSync(cache,text);await assert.rejects(flutterChecks(work,'WindowsFlutter',{runImpl}),/Flutter工程工具/u);
 }
 assert.equal(calls,0);
});
test('Flutter构建或CTest真实失败直接传播，不重试或换回PATH工具',async t=>{
 const work=fixture(t),cmake=join(work,'cmake'),ctest=join(work,'ctest');writeFileSync(cmake,'synthetic');writeFileSync(ctest,'synthetic');writeFileSync(join(work,'CMakeCache.txt'),'CMAKE_COMMAND:INTERNAL='+cmake+'\nCMAKE_CTEST_COMMAND:INTERNAL='+ctest+'\n');
 for(const stage of [cmake,ctest]){
  const calls=[],failure=Error('synthetic process failure');await assert.rejects(flutterChecks(work,'WindowsFlutter',{runImpl:async command=>{calls.push(command);if(command===stage)throw failure;}}),error=>error===failure);
  assert.deepEqual(calls,stage===cmake?[cmake]:[cmake,ctest]);
 }
});
test('缺少任一真实宿主不得冒充完整SDK',t=>{assert.throws(()=>verifyComplete(fixture(t)));});
test('缓存被占用时立即回到本轮目录，不等待或删除其他任务的锁',t=>{const work=fixture(t),first=claimCache(work),second=claimCache(work);try{assert.equal(second.cargo,join(work,'rust'));second.release();}finally{first.release();}});

test('发布SDK保留Apple标准内部链接，外部源码链接必须拒绝',t=>{
 const work=fixture(t),source=join(work,'source'),frame='darwin/CitizenSDK.xcframework/macos-arm64/CitizenSDK.framework';mkdirSync(join(source,frame,'Versions/A/Headers'),{recursive:true});writeFileSync(join(source,frame,'Versions/A/Headers/citizensdk.h'),'public');symlinkSync('A',join(source,frame,'Versions/Current'));symlinkSync('Versions/Current/Headers',join(source,frame,'Headers'));
 const output=createFlutterSourceView(source,join(work,'project'));assert.equal(readlinkSync(join(output,frame,'Headers')),'Versions/Current/Headers');assert.equal(readFileSync(join(output,frame,'Headers/citizensdk.h'),'utf8'),'public');
 writeFileSync(join(work,'outside'),'outside');symlinkSync('../outside',join(source,'escaped'));assert.throws(()=>createFlutterSourceView(source,join(work,'rejected')),/链接越界/u);
});

// 模拟Cargo同时保留正式库和deps同名副本；真实链接输入只允许来自所属工具的最终输出。
test('Apple静态链接只消费正式输出，同名缓存副本不构成冲突或替代来源',t=>{
 const work=fixture(t),core=join(work,'release'),qr=join(work,'qr');
 const primary=[join(core,'libcitizensdk.a'),join(qr,'libcitizensdk_qr_image.a'),join(qr,'zxing/core/libZXing.a')];
 for(const [index,file]of primary.entries()){mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'final-'+index);}
 for(const [index,file]of [join(core,'deps/libcitizensdk.a'),join(qr,'other/libZXing.a')].entries()){mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'internal-'+index);}
 assert.deepEqual(appleLibraries(core,qr).map(file=>readFileSync(file,'utf8')),['final-0','final-1','final-2']);
 rmSync(primary[0]);assert.throws(()=>appleLibraries(core,qr),{code:'ENOENT'});
 writeFileSync(primary[0],'');assert.throws(()=>appleLibraries(core,qr),/缺失或为空/u);
});

// 合成GitHub服务只验证真实接口的行为边界，不派发、构建或发布真实SDK。
const SHA='a'.repeat(40),REPOSITORY='crcfrcn/citizensdk';
function runRow(id,conclusion='success',status='completed'){
 return {id,run_number:id,status,conclusion,head_sha:SHA,head_branch:'main',path:'.github/workflows/sdk.yml',event:'workflow_dispatch',repository:{full_name:REPOSITORY},head_repository:{full_name:REPOSITORY},run_attempt:1,display_title:sdkName('1.1.'+id),created_at:new Date(id*1000).toISOString()};
}
function recordsFixture(initial){
 let rows=[...initial];const deleted=[],writes=[],reads=[],publications=new Map(),tags=new Map(),artifacts=new Map(),caches=new Map(),logs=new Set(rows.map(row=>row.id));
 for(const row of rows)artifacts.set(row.id,[{id:row.id*10,name:row.display_title,expired:false,size_in_bytes:10,digest:'sha256:'+'0'.repeat(64),workflow_run:{id:row.id,head_sha:row.head_sha,head_branch:'main'}}]);
 const missing=()=>{throw Error('GitHub HTTP 404');};
 const page=(path,values)=>{const n=Number(new URL('https://example.test/'+path).searchParams.get('page')??1);return values.slice((n-1)*100,n*100);};
 const read=async path=>{
  reads.push(path);
  if(path==='git/ref/heads/main')return {object:{type:'commit',sha:SHA}};
  if(path.startsWith('releases?'))return page(path,[...publications.values()]);
  if(path.startsWith('releases/'))return publications.get(Number(path.split('/')[1]))??missing();
  if(path.startsWith('git/ref/tags/')){const value=tags.get(decodeURIComponent(path.slice('git/ref/tags/'.length)));return value?{object:{type:'commit',sha:value}}:missing();}
  if(path.startsWith('actions/caches?'))return {actions_caches:page(path,[...caches.values()])};
  if(path.includes('/artifacts?')){const values=artifacts.get(Number(path.split('/')[2]));return values?{artifacts:page(path,values)}:missing();}
  if(/^actions\/runs\/\d+\/logs$/u.test(path))return logs.has(Number(path.split('/')[2]))?{present:true}:missing();
  if(/^actions\/runs\/\d+$/u.test(path))return rows.find(row=>row.id===Number(path.split('/')[2]))??missing();
  assert.match(path,/^actions\/workflows\/sdk\.yml\/runs\?/u);return {workflow_runs:page(path,rows)};
 };
 const remove=async path=>{
  writes.push(path);
  if(path.startsWith('releases/'))publications.delete(Number(path.split('/')[1]));
  else if(path.startsWith('git/refs/tags/'))tags.delete(decodeURIComponent(path.slice('git/refs/tags/'.length)));
  else if(path.startsWith('actions/caches/'))caches.delete(Number(path.split('/')[2]));
  else if(/^actions\/runs\/\d+$/u.test(path)){const id=Number(path.split('/')[2]);deleted.push(id);rows=rows.filter(row=>row.id!==id);artifacts.delete(id);logs.delete(id);}
  else assert.fail('未知合成删除：'+path);
 };
 const fetchImpl=async(url,options)=>{
  assert.ok(url.startsWith('https://api.github.com/repos/'+REPOSITORY+'/'));const address=new URL(url),path=address.pathname.split('/').slice(4).join('/')+address.search;
  if(options.method==='DELETE'){await remove(path);return new Response(null,{status:204});}
  try{return Response.json(await read(path));}catch(error){if(error.message==='GitHub HTTP 404')return new Response(null,{status:404});throw error;}
 };
 const publication=(row,{draft=false}={})=>{
  const version=row.display_title.split('·v')[1],proof={product_id:'citizensdk',platform:'sdk',software_version:version,producer_run_id:row.id,producer_run_attempt:row.run_attempt,git_commit_sha:row.head_sha,assets:[{name:row.display_title+'.zip',sha256:'0'.repeat(64)}]};
  const value={id:row.id,tag_name:row.display_title,name:row.display_title,target_commitish:row.head_sha,body:JSON.stringify(proof),published_at:draft?null:row.created_at,draft,prerelease:false,assets:['zip','json','sha256'].map(extension=>({label:row.display_title+'.'+extension,state:'uploaded',size:10,digest:'sha256:'+'0'.repeat(64)}))};
  publications.set(row.id,value);tags.set(row.display_title,row.head_sha);return value;
 };
 return {deleted,writes,reads,read,remove,fetchImpl,publications,tags,artifacts,caches,logs,publication,setRows:values=>{rows=values;}};
}
function currentCleanup(api,current,result){return cleanupRuns({...api,currentRun:current.id,result,sourceSha:current.head_sha,attempt:current.run_attempt,report:()=>{}});}
function sourceOptions(api,current){return {...api,runID:current.id,attempt:current.run_attempt,sourceSha:current.head_sha,version:'1.1.'+current.id,artifactID:current.id*10};}
function cache(id,host,runID,attempt=1,ref='refs/heads/main'){return {id,key:'sdk-'+host+'-1.97.1-3.47.2-29.0-'+'a'.repeat(40)+'-'+runID+'-'+attempt,ref,created_at:new Date(id*1000).toISOString(),size_in_bytes:1024};}

test('本轮成功只替换旧成功，本轮失败或取消只替换旧失败，活动记录保持',async()=>{
 for(const result of ['success','failure','cancelled']){
  const previous=runRow(1),failed=runRow(2,'failure'),current=runRow(3,null,'in_progress'),active=runRow(4,null,'queued'),api=recordsFixture([previous,failed,current,active]);
  api.publication(previous);if(result==='success')api.publication(current);
  const receipt=await currentCleanup(api,current,result);
  assert.deepEqual(receipt.deleted,[result==='success'?1:2]);assert.deepEqual([...receipt.kept].sort(),result==='success'?[2,3,4]:[1,3,4]);
  assert.equal(current.status,'in_progress');assert.equal(current.conclusion,null);assert.equal(active.status,'queued');
  assert.deepEqual([...api.publications.keys()],[result==='success'?3:1]);
  assert.deepEqual([...api.tags.keys()],[result==='success'?current.display_title:previous.display_title]);
  assert.equal(api.logs.has(receipt.deleted[0]),false);assert.equal(api.artifacts.has(receipt.deleted[0]),false);
 }
});
test('积压失败历史按真实归属收口，旧失败标题不参与成功版本解析',async()=>{
 const rows=Array.from({length:14},(_,i)=>({...runRow(i+1,'failure'),display_title:'合成历史失败记录'})),api=recordsFixture(rows);
 const result=await cleanupRuns({token:'synthetic',fetchImpl:api.fetchImpl,report:()=>{}});assert.deepEqual(result.deleted,Array.from({length:13},(_,i)=>i+1));assert.deepEqual(result.kept,[14]);assert.equal(nextVersion(rows),'1.0.0');
});
test('分页覆盖全部失败历史，删除后回查Run、日志和附件',async()=>{
 const api=recordsFixture(Array.from({length:101},(_,i)=>runRow(i+1,'failure')));
 const result=await cleanupRuns({...api,report:()=>{}});assert.equal(result.deleted.length,100);assert.deepEqual(result.kept,[101]);
 assert.ok(api.reads.some(path=>path.includes('page=2')));assert.ok(api.reads.includes('actions/runs/1/logs'));assert.ok(api.reads.includes('actions/runs/1/artifacts?per_page=100&page=1'));
});
test('本轮输入及旧Run身份、终态变化禁止删除，不误删其它归属或活动记录',async()=>{
 const current=runRow(3,null,'in_progress');
 for(const invalid of [{head_branch:'other'},{repository:{full_name:'other/repo'}},{head_repository:{full_name:'other/repo'}},{path:'other.yml'},{event:'push'},{run_attempt:2},{head_sha:'b'.repeat(40)}]){
  const api=recordsFixture([runRow(1,'failure'),current]);
  await assert.rejects(currentCleanup({...api,read:path=>path==='actions/runs/3'?{...current,...invalid}:api.read(path)},current,'failure'));
  assert.deepEqual(api.writes,[]);
 }
 for(const changed of [{status:'in_progress',conclusion:null},{run_attempt:2},{head_sha:'b'.repeat(40)},{conclusion:'success'}]){
  const old=runRow(1,'failure'),api=recordsFixture([old,runRow(2,'failure')]);
  await assert.rejects(cleanupRuns({...api,read:path=>path==='actions/runs/1'?{...old,...changed}:api.read(path),report:()=>{}}),/身份或终态变化/u);assert.deepEqual(api.writes,[]);
 }
 const api=recordsFixture([current]);for(const invalid of [{currentRun:-1},{result:'unknown'},{attempt:0},{sourceSha:'bad'}])await assert.rejects(cleanupRuns({...api,currentRun:3,result:'failure',attempt:1,sourceSha:SHA,...invalid,report:()=>{}}));
});
test('删除权限或删除回查失败如实报错，不虚报记录清理完成',async()=>{
 for(const remove of [async()=>{throw Error('GitHub HTTP 403');},async()=>{}]){
  const api=recordsFixture([runRow(1,'failure'),runRow(2,'failure')]);
  await assert.rejects(cleanupRuns({...api,remove,report:()=>{}}),/403|删除尚未确认/u);assert.equal(api.logs.has(1),true);
 }
});
test('新成功正式资产或完整Artifact未确认时保留旧成功并按失败收尾',async()=>{
 for(const change of ['missing','expired','tag','digest']){
  const previous=runRow(1),current=runRow(3,null,'in_progress'),api=recordsFixture([previous,runRow(2,'failure'),current]);api.publication(previous);
  if(change!=='missing')api.publication(current);
  if(change==='expired')api.artifacts.get(3)[0].expired=true;
  if(change==='tag')api.tags.set(current.display_title,'b'.repeat(40));
  if(change==='digest')api.publications.get(3).assets[0].digest='sha256:'+'b'.repeat(64);
  await assert.rejects(currentCleanup(api,current,'success'),/SDK清理失败/u);assert.equal(api.deleted.includes(1),false);assert.equal(api.publications.has(1),true);assert.deepEqual(api.deleted,[2]);
 }
});

test('缓存按四宿主各保留本轮最新一份，保护其它ref和其它来源',async()=>{
 const api=recordsFixture([]),hosts=['Linux-X64','macOS-ARM64','Linux-ARM64','Windows-X64'];
 hosts.forEach((host,i)=>{api.caches.set(i+1,cache(i+1,host,10));api.caches.set(i+11,cache(i+11,host,20));});
 api.caches.set(30,cache(30,'Linux-X64',10,1,'refs/heads/other'));api.caches.set(31,{...cache(31,'Linux-X64',10),key:'foreign-cache'});
 const result=await cleanupCaches({...api,currentRun:20,attempt:1});assert.deepEqual(result.deleted,[1,2,3,4]);assert.deepEqual([...api.caches.keys()],[11,12,13,14,30,31]);
});
test('本轮缓存未保存或属于其它attempt时不淘汰原缓存',async()=>{
 const api=recordsFixture([]);for(const value of [cache(1,'macOS-ARM64',10),cache(2,'macOS-ARM64',11),cache(3,'Linux-X64',10),cache(4,'Linux-X64',20,2)])api.caches.set(value.id,value);
 assert.deepEqual((await cleanupCaches({...api,currentRun:20,attempt:1})).deleted,[]);assert.equal(api.caches.size,4);
});
test('旧缓存删除失败、回查仍在或归属变化均失败，新缓存保持',async()=>{
 for(const mode of ['permission','readback','identity']){
  const api=recordsFixture([]),old=cache(1,'Linux-ARM64',10),latest=cache(2,'Linux-ARM64',20);api.caches.set(1,old);api.caches.set(2,latest);let reads=0;
  const read=async path=>{if(mode==='identity'&&path.startsWith('actions/caches?')&&++reads===2)return {actions_caches:[{...old,key:'foreign-cache'},latest]};return api.read(path);};
  const remove=mode==='permission'?async()=>{throw Error('GitHub HTTP 403');}:mode==='readback'?async()=>{}:api.remove;
  await assert.rejects(cleanupCaches({...api,read,remove,currentRun:20,attempt:1}),/403|删除尚未确认|归属已变化/u);assert.equal(api.caches.has(2),true);assert.equal(api.caches.has(1),true);
 }
});
test('缓存分页清理旧份，并将缓存清理失败计入本轮失败而保护旧成功',async()=>{
 const api=recordsFixture([]);for(let i=1;i<=101;i++)api.caches.set(i,cache(i,'Windows-X64',i===101?20:10));
 assert.equal((await cleanupCaches({...api,currentRun:20,attempt:1})).deleted.length,100);assert.deepEqual([...api.caches.keys()],[101]);
 const previous=runRow(1),current=runRow(3,null,'in_progress'),broken=recordsFixture([previous,runRow(2,'failure'),current]);broken.publication(previous);broken.publication(current);
 broken.caches.set(1,cache(1,'Linux-X64',1));broken.caches.set(2,cache(2,'Linux-X64',3));
 await assert.rejects(currentCleanup({...broken,remove:path=>path.startsWith('actions/caches/')?Promise.reject(Error('GitHub HTTP 403')):broken.remove(path)},current,'success'),/403/u);
 assert.equal(broken.deleted.includes(1),false);assert.equal(broken.publications.has(1),true);assert.deepEqual(broken.deleted,[2]);
});

test('客户端只派发一次并返回准确Run，不等待观察或执行清理',async()=>{
 const api=recordsFixture([runRow(1,'failure')]);let posts=0;
 const result=await automate({...api,dispatch:async spec=>{posts++;assert.deepEqual(spec,{workflow:'sdk.yml',ref:'main',inputs:{version:'1.0.0',sha:SHA}});return {workflow_run_id:2};}});
 assert.deepEqual(result,{runID:2});assert.equal(posts,1);assert.deepEqual(api.writes,[]);assert.equal(api.reads.some(path=>/^actions\/runs\//u.test(path)),false);
 for(const receipt of [null,{}, {workflow_run_id:true},{workflow_run_id:'02'}]){let count=0;await assert.rejects(automate({...api,dispatch:async()=>{count++;return receipt;}}),/身份无效/u);assert.equal(count,1);}
 for(const error of [Error('GitHub HTTP 403'),new TypeError('fetch failed')]){let count=0;await assert.rejects(automate({...api,dispatch:async()=>{count++;throw error;}}),value=>value===error);assert.equal(count,1);}
});
test('已有活动Run禁止派发，真实成功版本才递增',async()=>{
 let posts=0;const active=recordsFixture([runRow(2,null,'queued')]);await assert.rejects(automate({...active,dispatch:async()=>{posts++;}}),/活动Run/u);assert.equal(posts,0);
 const api=recordsFixture([runRow(1),runRow(2,'failure')]);await automate({...api,dispatch:async spec=>{assert.equal(spec.inputs.version,'1.1.2');return {workflow_run_id:3};}});
});
test('发布来源必须为本轮准确Run、attempt、当前main及唯一完整Artifact',async()=>{
 const current=runRow(3,null,'in_progress'),api=recordsFixture([current]);
 assert.deepEqual(await publicationSource(sourceOptions(api,current)),{sourceRun:3,sourceAttempt:1,sourceSha:SHA,version:'1.1.3',artifactID:30});
 const cases=[{row:{status:'completed',conclusion:'success'}},{row:{conclusion:'failure'}},{row:{path:'other.yml'}},{row:{repository:{full_name:'other/repo'}}},{row:{head_repository:{full_name:'other/repo'}}},{row:{head_branch:'other'}},{row:{head_sha:'b'.repeat(40)}},{row:{run_attempt:2}},{artifact:{expired:true}},{artifact:{digest:null}},{artifact:{workflow_run:{id:999,head_sha:SHA,head_branch:'main'}}},{empty:true},{duplicate:true}];
 for(const item of cases){const candidate={...current,...item.row},fixture=recordsFixture([candidate]);
  if(item.artifact)Object.assign(fixture.artifacts.get(3)[0],item.artifact);if(item.empty)fixture.artifacts.set(3,[]);if(item.duplicate)fixture.artifacts.get(3).push({...fixture.artifacts.get(3)[0],id:31});
  await assert.rejects(publicationSource(sourceOptions(fixture,current)));assert.deepEqual(fixture.writes,[]);
 }
 await assert.rejects(publicationSource({...sourceOptions(api,current),artifactID:31}),/Artifact不符/u);
 await assert.rejects(publicationSource({...sourceOptions(api,current),read:path=>path==='git/ref/heads/main'?{object:{type:'commit',sha:'b'.repeat(40)}}:api.read(path)}),/当前main/u);
 let reads=0;await assert.rejects(publicationSource({...sourceOptions(api,current),read:path=>path==='actions/runs/3'&&++reads===2?{...current,run_attempt:2}:api.read(path)}),/已变化/u);
});
function publicationFiles(t){
 const directory=fixture(t),source={sourceRun:1,sourceAttempt:1,sourceSha:SHA,artifactID:10,version:'1.1.1'},name=sdkName(source.version),zip=Buffer.from('仅用于完整性边界的合成字节，不是SDK产物');
 const digest=value=>createHash('sha256').update(value).digest('hex'),proof={product_id:'citizensdk',platform:'sdk',software_version:source.version,git_commit_sha:SHA,producer_run_id:1,producer_run_attempt:1,assets:[{name:name+'.zip',sha256:digest(zip)}]},json=JSON.stringify(proof);
 writeFileSync(join(directory,name+'.zip'),zip);writeFileSync(join(directory,name+'.json'),json);writeFileSync(join(directory,name+'.sha256'),digest(zip)+'  '+name+'.zip\n'+digest(json)+'  '+name+'.json\n');return {directory,source,name,proof};
}
test('三件原始文件完整且来源相符才允许发布；篡改、额外文件、链接、错误来源拒绝',async t=>{
 const valid=publicationFiles(t);assert.deepEqual(await verifyPublication(valid.directory,valid.source),valid.proof);
 for(const change of ['bytes','extra','link','source','json']){const value=publicationFiles(t);
  if(change==='bytes')writeFileSync(join(value.directory,value.name+'.zip'),'changed');
  if(change==='extra')writeFileSync(join(value.directory,'extra'),'extra');
  if(change==='link'){rmSync(join(value.directory,value.name+'.zip'));symlinkSync(value.name+'.json',join(value.directory,value.name+'.zip'));}
  if(change==='source')value.source.sourceAttempt=2;if(change==='json')writeFileSync(join(value.directory,value.name+'.json'),'null');
  await assert.rejects(verifyPublication(value.directory,value.source));
 }
});
test('新正式版核验后按Tag、Release顺序删除旧版，保护其它产品',async()=>{
 const previous=runRow(1),current=runRow(2,null,'in_progress'),api=recordsFixture([previous,current]);api.publication(previous);api.publication(current);api.publications.set(9,{id:9,tag_name:'foreign',body:'foreign'});
 assert.deepEqual((await cleanupPublications({...api,releaseID:2,runID:2})).deleted,[1]);
 assert.deepEqual(api.writes,['git/refs/tags/'+encodeURIComponent(previous.display_title),'releases/1']);assert.equal(api.publications.has(2),true);assert.equal(api.publications.has(9),true);
 for(const condition of ['draft','tag','active','immutable']){
  const fixture=recordsFixture([previous,current]);fixture.publication(previous);fixture.publication(current);
  if(condition==='draft')fixture.publications.get(2).draft=true;if(condition==='tag')fixture.tags.set(previous.display_title,'b'.repeat(40));
  if(condition==='active')fixture.setRows([{...previous,status:'in_progress',conclusion:null},current]);if(condition==='immutable')fixture.publications.get(1).immutable=true;
  await assert.rejects(cleanupPublications({...fixture,releaseID:2,runID:2}));assert.deepEqual(fixture.writes,[]);
 }
});
test('旧Tag删除后Release删除失败，仍可按原回执复核重试且不触碰新正式版',async()=>{
 const previous=runRow(1),current=runRow(2,null,'in_progress'),api=recordsFixture([previous,current]);api.publication(previous);api.publication(current);
 await assert.rejects(cleanupPublications({...api,releaseID:2,runID:2,remove:path=>path==='releases/1'?Promise.reject(Error('GitHub HTTP 503')):api.remove(path)}),/503/u);
 assert.equal(api.tags.has(previous.display_title),false);assert.equal(api.publications.has(1),true);assert.equal(api.publications.has(2),true);
 assert.deepEqual((await cleanupPublications({...api,releaseID:2,runID:2})).deleted,[1]);
});
test('失败只撤销归属准确的本轮草稿；可见正式版不自动回滚，旧成功保持',async()=>{
 for(const draft of [true,false]){
  const previous=runRow(1),current=runRow(3,null,'in_progress'),api=recordsFixture([previous,runRow(2,'failure'),current]);api.publication(previous);api.publication(current,{draft});
  if(draft){await currentCleanup(api,current,'failure');assert.equal(api.publications.has(3),false);assert.equal(api.tags.has(current.display_title),false);}
  else{await assert.rejects(currentCleanup(api,current,'failure'),/已可见/u);assert.equal(api.publications.has(3),true);}
  assert.equal(api.publications.has(1),true);assert.equal(api.deleted.includes(1),false);assert.deepEqual(api.deleted,[2]);
 }
});
test('失败候选Tag或草稿来源不符时保留原件并报告，不影响原成功',async()=>{
 for(const change of ['tag','proof']){
  const previous=runRow(1),current=runRow(3,null,'in_progress'),api=recordsFixture([previous,runRow(2,'failure'),current]);api.publication(previous);const draft=api.publication(current,{draft:true});
  if(change==='tag')api.tags.set(current.display_title,'b'.repeat(40));
  else{const proof=JSON.parse(draft.body);proof.producer_run_id=99;draft.body=JSON.stringify(proof);}
  await assert.rejects(currentCleanup(api,current,'failure'),/归属不符/u);assert.equal(api.publications.has(3),true);assert.equal(api.tags.has(current.display_title),true);assert.equal(api.publications.has(1),true);assert.deepEqual(api.deleted,[2]);
 }
});
test('删除Run后日志或附件仍可见必须报告失败',async()=>{
 for(const retained of ['logs','artifacts']){
  const current=runRow(2,'failure'),api=recordsFixture([runRow(1,'failure'),current]);
  const remove=async path=>{assert.equal(path,'actions/runs/1');api.setRows([current]);if(retained==='artifacts')api.logs.delete(1);};
  await assert.rejects(cleanupRuns({...api,remove,report:()=>{}}),new RegExp(retained==='logs'?'日志删除尚未确认':'附件删除尚未确认'));
 }
});
test('工作流使用同Run完整Artifact并将写权限限定于发布和收尾',()=>{
 assert.equal(describeAction({flow:'release',platform:'sdk'}).launch,automate);assert.equal(describeAction({flow:'cleanup',platform:'sdk'}).launch,cleanupRuns);
 assert.throws(()=>describeAction({flow:'release',platform:'ios'}));assert.throws(()=>describeAction({flow:'other',platform:'sdk'}));
 const workflow=readFileSync(join(root,'.github/workflows/sdk.yml'),'utf8'),input=workflow.slice(workflow.indexOf('    inputs:'),workflow.indexOf('\nconcurrency:'));
 assert.deepEqual([...input.matchAll(/^      ([a-z_]+):$/gmu)].map(match=>match[1]),['sha','version']);
 const body=workflow.slice(workflow.indexOf('\njobs:')),entries=[...body.matchAll(/^  ([a-z]+):$/gmu)];
 const jobs=Object.fromEntries(entries.map((match,index)=>[match[1],body.slice(match.index,entries[index+1]?.index??body.length)]));
 for(const name of ['select','android','apple','linux','windows','complete'])assert.doesNotMatch(jobs[name],/contents: write|actions: write/u);
 assert.match(jobs.complete,/artifact: \$\{\{ steps\.artifact\.outputs\.artifact-id \}\}/u);
 assert.match(jobs.publish,/needs: complete/u);assert.match(jobs.publish,/artifact-ids: \$\{\{ needs\.complete\.outputs\.artifact \}\}/u);
 assert.match(jobs.publish,/merge-multiple: true/u);assert.match(jobs.publish,/contents: write/u);assert.match(jobs.publish,/actions: read/u);assert.match(jobs.cleanup,/actions: write/u);
 assert.match(jobs.cleanup,/needs: \[select, android, apple, linux, windows, complete, publish\]/u);assert.match(jobs.cleanup,/always\(\)/u);
});
// 执行工作流原片段；工具请求用本轮合成代理记录，禁止访问真实网络或安装工具。
function workflowEntry(anchor){
 const text=readFileSync(join(root,'.github/workflows/sdk.yml'),'utf8'),start=text.indexOf('      - '+(anchor.startsWith('name: ')?anchor:'&'+anchor)+'\n');assert.ok(start>=0,anchor);
 const next=text.indexOf('\n      - ',start+1);return text.slice(start,next<0?text.length:next);
}
function workflowRun(anchor){
 const block=workflowEntry(anchor),match=/        run: \|\n((?:          [^\n]*\n?)+)/u.exec(block);assert.ok(match,anchor);
 return match[1].split('\n').map(line=>line.slice(10)).join('\n');
}
function workflowToolFixture(t,{installed=false}={}){
 const work=fixture(t),bin=join(work,'bin'),cargo=join(work,'cargo'),rust=join(work,'rustup'),temporary=join(work,'temp'),calls=join(work,'calls');
 for(const path of [bin,join(cargo,'bin'),rust,temporary,join(work,'scripts'),join(work,'target/cache/rust'),join(work,'target/cache/native/lib'),join(work,'target/cache/native/include')])mkdirSync(path,{recursive:true});
 for(const name of ['config.mjs','build.mjs'])writeFileSync(join(work,'scripts',name),readFileSync(join(root,'scripts',name)));
 for(const value of Object.values(nativeSources))mkdirSync(join(work,'target/cache/sources',value.archive_root),{recursive:true});
 writeFileSync(calls,'');writeFileSync(join(work,'target/cache/rust/keep'),'compiled');writeFileSync(join(work,'target/cache/native/lib/keep'),'native');writeFileSync(join(work,'target/cache/native/include/keep'),'headers');
 // 子进程只看到本轮代理和绝对系统命令，不能误用宿主已安装的Rust或真实curl。
 for(const name of ['sed','mkdir','cp','basename','tar','sh','tr','chmod','gzip']){
  const command=['/usr/bin/'+name,'/bin/'+name].find(existsSync);assert.ok(command,name);
  writeFileSync(join(bin,name),'#!/bin/sh\nexec "'+command+'" "$@"\n',{mode:0o700});
 }
 writeFileSync(join(bin,'node'),'#!/bin/sh\nexec "$SDK_NODE" "$@"\n',{mode:0o700});
 const manager="#!/bin/sh\nprintf 'rustup %s\\n' \"$*\" >> \"$SDK_TOOL_CALLS\"\nif [ \"${SDK_RUST_EXIT:-0}\" != 0 ]; then exit \"$SDK_RUST_EXIT\"; fi\nchain=\"$RUSTUP_HOME/toolchains/$PRODUCT_RUST-fixture\"\nmkdir -p \"$chain/lib/rustlib/fixture/lib\"\nif [ ! -f \"$chain/keep\" ]; then printf 'fixture\\n' > \"$chain/keep\"; fi\n",installer=join(work,'installer.sh'),template=join(work,'manager.sh');
 writeFileSync(template,manager,{mode:0o700});writeFileSync(installer,"#!/bin/sh\nprintf 'install-manager\\n' >> \"$SDK_TOOL_CALLS\"\nmkdir -p \"$CARGO_HOME/bin\"\nfor name in rustup cargo rustc rustdoc; do\n  cp \"$SDK_MANAGER_TEMPLATE\" \"$CARGO_HOME/bin/$name\"\n  chmod 700 \"$CARGO_HOME/bin/$name\"\ndone\n",{mode:0o700});writeFileSync(join(bin,'curl'),"#!/bin/sh\nout=''\nurl=''\nwhile [ \"$#\" -gt 0 ]; do\n  case \"$1\" in\n    -o) out=\"$2\"; shift 2 ;;\n    https://*) url=\"$1\"; shift ;;\n    *) shift ;;\n  esac\ndone\nprintf 'curl %s\\n' \"$url\" >> \"$SDK_TOOL_CALLS\"\ncase \"$url\" in\n  https://sh.rustup.rs) cp \"$SDK_INSTALLER\" \"$out\" ;;\n  *) cp \"$SDK_SOURCE_ARCHIVE\" \"$out\" ;;\nesac\n",{mode:0o700});
 if(installed){
  for(const name of ['rustup','cargo','rustc','rustdoc'])writeFileSync(join(cargo,'bin',name),manager,{mode:0o700});
  mkdirSync(join(rust,'toolchains',tools.rust+'-fixture','lib'),{recursive:true});writeFileSync(join(rust,'toolchains',tools.rust+'-fixture','keep'),'installed');
 }
 const env={PATH:bin,SDK_NODE:process.execPath,CARGO_HOME:cargo,RUSTUP_HOME:rust,RUNNER_OS:'Linux',RUNNER_ARCH:'ARM64',GITHUB_WORKSPACE:work,RUNNER_TEMP:temporary,GITHUB_ENV:join(work,'environment'),GITHUB_PATH:join(work,'path'),GITHUB_OUTPUT:join(work,'output'),PRODUCT_RUST:tools.rust,SDK_TOOL_CALLS:calls,SDK_MANAGER_TEMPLATE:template,SDK_INSTALLER:installer};
 const execute=anchor=>spawnSync('/bin/bash',['-euo','pipefail','-c',workflowRun(anchor)],{cwd:work,env,encoding:'utf8'});
 return {work,cargo,rust,env,calls,execute};
}
test('声明读取不启动工具探测，流程正文变更不改变工具版本和缓存匹配输入',t=>{
 const value=workflowToolFixture(t),read=()=>{
  writeFileSync(value.env.GITHUB_OUTPUT,'');const result=value.execute('tools');assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  return Object.fromEntries(readFileSync(value.env.GITHUB_OUTPUT,'utf8').trim().split('\n').map(line=>line.split('=')));
 };
 const before=read();for(const [name,version]of Object.entries(tools))assert.equal(before[name],version);
 for(const [name,entry]of Object.entries(nativeSources))assert.equal(before[name.replaceAll('-','_')],entry.version);
 writeFileSync(join(value.work,'scripts/config.mjs'),readFileSync(join(value.work,'scripts/config.mjs'),'utf8')+'\n// 合成流程说明变化，不改变声明。\n');
 assert.deepEqual(read(),before);assert.equal(readFileSync(value.calls,'utf8'),'');
 const restore=workflowEntry('cache'),save=workflowEntry('save'),paths=block=>/          path: \|\n((?:            [^\n]+\n)+)/u.exec(block)[1];
 assert.equal(paths(restore),paths(save));assert.match(paths(restore),/target\/cache\/rust/u);assert.match(paths(restore),/target\/cache\/native/u);
 const key=block=>/          key: ([^\n]+)/u.exec(block)[1];assert.equal(key(restore),key(save));assert.doesNotMatch(key(restore),/config\.mjs/u);
 assert.match(restore,/timeout-minutes: 10/u);assert.doesNotMatch(restore,/continue-on-error/u);
 assert.match(workflowEntry('node'),/check-latest: false/u);
});
test('已安装Rust与目标原件进入原缓存范围，复用时不调用下载器或改动编译缓存',t=>{
 const value=workflowToolFixture(t,{installed:true}),result=value.execute('rust');assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 const cached=join(value.work,'target/cache/native/tools/rustup/toolchains',tools.rust+'-fixture','keep');
 assert.equal(readFileSync(cached,'utf8'),'installed');assert.equal(readFileSync(join(value.rust,'toolchains',tools.rust+'-fixture','keep'),'utf8'),'installed');
 assert.equal(readFileSync(join(value.work,'target/cache/rust/keep'),'utf8'),'compiled');assert.equal(readFileSync(join(value.work,'target/cache/native/lib/keep'),'utf8'),'native');
 assert.deepEqual(readFileSync(value.calls,'utf8').trim().split('\n'),['rustup toolchain install '+tools.rust+' --profile minimal --no-self-update']);
 for(const path of ['target/cache/native/tools/rustup','target/cache/rust','target/cache/gradle-home'])assert.ok(readFileSync(value.env.GITHUB_ENV,'utf8').includes(path));
});
test('管理器缺少才准备，后续仅恢复已缓存工具，不重新调用下载器',t=>{
 const value=workflowToolFixture(t),first=value.execute('rust');assert.ifError(first.error);assert.equal(first.status,0,first.stderr);
 const initial=readFileSync(value.calls,'utf8');assert.equal(initial.split('curl https://sh.rustup.rs').length-1,1);assert.equal(initial.split('install-manager').length-1,1);
 rmSync(join(value.cargo,'bin'),{recursive:true});const second=value.execute('rust');assert.ifError(second.error);assert.equal(second.status,0,second.stderr);
 const repeated=readFileSync(value.calls,'utf8');assert.equal(repeated.split('curl https://sh.rustup.rs').length-1,1);assert.equal(repeated.split('install-manager').length-1,1);
 const third=value.execute('rust');assert.ifError(third.error);assert.equal(third.status,0,third.stderr);
 assert.equal(readFileSync(value.calls,'utf8').split('curl https://sh.rustup.rs').length-1,1);
 assert.equal(readFileSync(value.calls,'utf8').split('rustup toolchain install ').length-1,3);assert.equal(readFileSync(join(value.work,'target/cache/rust/keep'),'utf8'),'compiled');
});
test('官方Rust命令失败原样返回，不尝试其它安装或清理编译缓存',t=>{
 const value=workflowToolFixture(t,{installed:true});value.env.SDK_RUST_EXIT='23';const result=value.execute('rust');assert.ifError(result.error);assert.equal(result.status,23,result.stderr);
 assert.equal(readFileSync(value.calls,'utf8').trim(),'rustup toolchain install '+tools.rust+' --profile minimal --no-self-update');assert.equal(readFileSync(join(value.work,'target/cache/rust/keep'),'utf8'),'compiled');
});
test('Android仅恢复没有安装的缓存组件，官方SDK命令及保存沿用同一组组件',t=>{
 const value=workflowToolFixture(t),sdk=join(value.work,'android'),cache=join(value.work,'target/cache/native/tools/android'),manager=join(sdk,'cmdline-tools/latest/bin');
 mkdirSync(manager,{recursive:true});writeFileSync(join(manager,'sdkmanager'),"#!/bin/sh\nprintf 'sdkmanager %s\\n' \"$*\" >> \"$SDK_TOOL_CALLS\"\nfor package in \"$@\"; do\n  component=\"$(printf '%s' \"$package\" | tr ';' '/')\"\n  mkdir -p \"$ANDROID_HOME/$component\"\n  if [ ! -f \"$ANDROID_HOME/$component/keep\" ]; then printf 'prepared' > \"$ANDROID_HOME/$component/keep\"; fi\ndone\n",{mode:0o700});
 for(const component of ['ndk/'+tools.ndk,'cmake/'+tools.cmake]){mkdirSync(join(cache,component),{recursive:true});writeFileSync(join(cache,component,'keep'),'cached');}
 for(const component of ['cmake/'+tools.cmake,'platforms/android-36']){mkdirSync(join(sdk,component),{recursive:true});writeFileSync(join(sdk,component,'keep'),'installed');}
 mkdirSync(join(value.work,'target/cache/gradle/gradle-'+tools.gradle),{recursive:true});
 Object.assign(value.env,{ANDROID_HOME:sdk,PRODUCT_NDK:tools.ndk,PRODUCT_CMAKE:tools.cmake,PRODUCT_GRADLE:tools.gradle});
 const result=value.execute('name: 准备官方Android和Gradle');assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 assert.equal(readFileSync(join(sdk,'ndk',tools.ndk,'keep'),'utf8'),'cached');assert.equal(readFileSync(join(sdk,'cmake',tools.cmake,'keep'),'utf8'),'installed');
 const saved=value.execute('name: 保存已安装Android组件');assert.ifError(saved.error);assert.equal(saved.status,0,saved.stderr);
 assert.equal(readFileSync(join(cache,'cmake',tools.cmake,'keep'),'utf8'),'installed');assert.equal(readFileSync(value.calls,'utf8').trim(),'sdkmanager ndk;'+tools.ndk+' cmake;'+tools.cmake+' platforms;android-36');
});
test('原生源码缺少时只刷新原生依赖，工具与Cargo缓存继续保留',t=>{
 const value=workflowToolFixture(t,{installed:true}),entry=nativeSources.openssl,input=join(value.work,'archive',entry.archive_root),archive=join(value.work,'source.tgz');
 mkdirSync(input,{recursive:true});writeFileSync(join(input,'fixture'),'source');const pack=spawnSync('tar',['-czf',archive,'-C',join(value.work,'archive'),entry.archive_root],{encoding:'utf8'});assert.ifError(pack.error);assert.equal(pack.status,0,pack.stderr);
 rmSync(join(value.work,'target/cache/sources',entry.archive_root),{recursive:true});mkdirSync(join(value.work,'target/cache/sources/openssl-0.0.1'));
 value.env.SDK_SOURCE_ARCHIVE=archive;const result=value.execute('rust');assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 assert.equal(existsSync(join(value.work,'target/cache/native/lib')),false);assert.equal(existsSync(join(value.work,'target/cache/native/include')),false);assert.equal(existsSync(join(value.work,'target/cache/sources/openssl-0.0.1')),false);
 assert.equal(readFileSync(join(value.work,'target/cache/rust/keep'),'utf8'),'compiled');assert.ok(existsSync(join(value.work,'target/cache/native/tools/bin/rustup')));
 assert.equal(readFileSync(join(value.work,'target/cache/sources',entry.archive_root,'fixture'),'utf8'),'source');
 assert.equal(readFileSync(value.calls,'utf8').split('curl '+entry.url).length-1,1);
});

test('汇总执行真实工作流解包片段，四宿主中文归档路径闭合，缺件和错版本必须失败',t=>{
 const work=fixture(t),version='1.2.3',targets=['Android','Apple','LinuxARM','Windows'],workflow=readFileSync(join(root,'.github/workflows/sdk.yml'),'utf8');
 const match=/- name: 解包累计真实原生件\n        run: \|\n((?:          [^\n]+\n)+)/u.exec(workflow);assert.ok(match);
 const fragment=match[1].split('\n').map(line=>line.slice(10)).join('\n'),archives=[];
 for(const target of targets){
  const folder=join(work,'previous','公民SDK·SDK·v'+version+'·'+target),input=join(work,target);mkdirSync(folder,{recursive:true});mkdirSync(input);
  writeFileSync(join(input,target+'.txt'),target);const archive=join(folder,'公民SDK·SDK·v'+version+'.tgz');archives.push(archive);
  const created=spawnSync('tar',['-czf',archive,'-C',input,target+'.txt'],{encoding:'utf8'});assert.ifError(created.error);assert.equal(created.status,0,created.stderr);
 }
 const execute=value=>spawnSync('bash',['-euo','pipefail','-c',fragment],{env:{...process.env,RUNNER_TEMP:work,SDK_VERSION:value},encoding:'utf8'});
 const normal=execute(version);assert.ifError(normal.error);assert.equal(normal.status,0,normal.stderr);
 assert.deepEqual(readdirSync(join(work,'native')).sort(),targets.map(target=>target+'.txt').sort());for(const target of targets)assert.equal(readFileSync(join(work,'native',target+'.txt'),'utf8'),target);
 rmSync(join(work,'native'),{recursive:true});assert.notEqual(execute('1.2.4').status,0);
 rmSync(join(work,'native'),{recursive:true});rmSync(archives[3]);assert.notEqual(execute(version).status,0);assert.equal(existsSync(join(work,'native','Windows.txt')),false);
});

// Android版本脚本会给名称附加版本；真实Dart查找仍须得到全部公开包装函数。
test('图像与Dart辅助导出准确且拒绝隐藏、缺件和额外入口',()=>{
 const header=readFileSync(join(root,'image/citizensdk_qr_image.h'),'utf8');
 const names=['citizensdk_qr_image_decode_luminance','citizensdk_qr_image_decode_luminance_all','citizensdk_qr_image_encode_text','citizensdk_qr_image_zxing_version','citizensdk_dart_api_major','citizensdk_dart_emit'];
 const table=names.map(name=>'00000000 T '+name+'@@CITIZENSDK_JNI_1.0').join('\n');
 verifyImageSymbols(table,header);verifyImageSymbols(names.map(name=>'00000000 T _'+name).join('\n'),header);
 assert.throws(()=>verifyImageSymbols('00000000 T JNI_OnLoad',header));
 assert.throws(()=>verifyImageSymbols(table.split('\n').slice(0,-1).join('\n'),header));
 assert.throws(()=>verifyImageSymbols(table+'\n00000000 T citizensdk_dart_unreviewed',header));
});

// 配置入口是实际生成命令的一部分，不能另读同名开发配置。
test('绑定生成只读取Pub内的ffigen节点',()=>{
 const pub=readFileSync(join(root,'pubspec.yaml'),'utf8'),build=readFileSync(join(root,'scripts/build.mjs'),'utf8');
 assert.match(pub,/^ffigen:\n  name: Bindings$/mu);
 for(const header of ['include/citizensdk.h','image/citizensdk_qr_image.h'])assert.ok(pub.includes('      - '+header));
 assert.match(build,/\['run','ffigen'\]/u);assert.doesNotMatch(build,/'ffigen','--config'/u);
});
test('完整SDK消费拒绝错误来源、覆盖输出及已取消任务，拒绝前不生成视图',async t=>{
 const value=publicationFiles(t),output=join(fixture(t),'sdk');
 await assert.rejects(consume({directory:value.directory,sourceSha:'b'.repeat(40),output}),/来源不一致/u);assert.equal(existsSync(output),false);
 const existing=fixture(t);await assert.rejects(consume({directory:value.directory,sourceSha:SHA,output:existing}),/输入或输出无效/u);assert.ok(existsSync(existing));
 const canceled=new AbortController();canceled.abort();await assert.rejects(consume({directory:value.directory,sourceSha:SHA,output,signal:canceled.signal}));assert.equal(existsSync(output),false);
 await assert.rejects(consume({sourceSha:SHA,output}),/输入或输出无效/u);assert.equal(existsSync(output),false);
});
