// 最简入口仍必须保持SDK完整性、Cargo真实布局、原锁、缓存与版本边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {root,claimCache,createNativeSourceView,createFlutterSourceView,verifyComplete,setVersion,appleLibraries} from '../scripts/build.mjs';
import {nextVersion,retainedRuns,sdkName,cleanupRuns,automate} from '../scripts/build.mjs';
import {nativePaths,describeAction} from '../scripts/config.mjs';
function fixture(t){const base=join(root,'target/test');mkdirSync(base,{recursive:true});const work=mkdtempSync(join(base,'regression-'));t.after(()=>rmSync(work,{recursive:true,force:true}));return work;}
test('SDK唯一平台与版本，失败不递增，只留最新成功和失败并保护活动任务',()=>{
 const row=(id,version,conclusion,status='completed')=>({id,display_title:'公民SDK·SDK·v'+version,conclusion,status,updated_at:new Date(id*1000).toISOString()});
 const rows=[row(1,'1.2.9','success'),row(2,'1.2.10','failure'),row(3,'1.2.10',null,'queued')];assert.equal(sdkName('1.2.10'),'公民SDK·SDK·v1.2.10');assert.equal(nextVersion(rows),'1.2.10');assert.deepEqual([...retainedRuns([row(0,'1.2.8','success'),...rows])].sort(),[1,2,3]);for(const value of ['1.0','01.0.0','1.0.0\n','1.0.0-beta'])assert.throws(()=>sdkName(value));
});
test('真实Cargo路径映射完整且不改变源码与原锁，软件版本只写入任务副本',t=>{
 const work=fixture(t),output=createNativeSourceView(root,join(work,'project'));for(const [from,to]of Object.entries(nativePaths)){assert.ok(readFileSync(join(root,from)).equals(readFileSync(join(output,to))),to);assert.equal(existsSync(join(output,from)),false,from);}
 assert.ok(readFileSync(join(root,'Cargo.lock')).equals(readFileSync(join(output,'Cargo.lock'))));setVersion(output,'1.2.3');assert.match(readFileSync(join(output,'pubspec.yaml'),'utf8'),/^version: 1\.2\.3$/mu);assert.doesNotMatch(readFileSync(join(root,'pubspec.yaml'),'utf8'),/^version: 1\.2\.3$/mu);assert.throws(()=>createNativeSourceView(root,output));
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

// HTTP夹具实际消费产品删除入口；原Run、日志、Artifact及发布资产共用同一合成服务。
function runRow(id,conclusion,status='completed'){return {id,status,conclusion,head_sha:'a'.repeat(40),display_title:sdkName('1.1.'+id),updated_at:new Date(id*1000).toISOString()};}
function recordsFixture(initial){
 let rows=[...initial];const deleted=[],publications=new Map(),tags=new Map(),artifacts=new Map(),logs=new Set(rows.map(row=>row.id));
 const product=sdkName('0.0.0').startsWith('公民')?'citizensdk':'tatachatsdk';
 for(const row of rows){
  artifacts.set(row.id,[{id:row.id,name:row.display_title,expired:false,size_in_bytes:10}]);
  if(row.status==='completed'&&row.conclusion==='success'){
   const version=row.display_title.split('·v')[1],proof={product_id:product,platform:'sdk',software_version:version,producer_run_id:row.id,git_commit_sha:row.head_sha};
   publications.set(row.id,{id:row.id,tag_name:row.display_title,name:row.display_title,target_commitish:row.head_sha,body:JSON.stringify(proof),draft:false,prerelease:false,assets:[{},{},{}]});tags.set(row.display_title,row.head_sha);
  }
 }
 const missing=()=>{throw Error('GitHub HTTP 404');};
 const read=async path=>{
  if(path.startsWith('releases?')){const page=Number(new URL('https://example.test/'+path).searchParams.get('page'));return [...publications.values()].slice((page-1)*100,page*100);}
  if(path.startsWith('releases/'))return publications.get(Number(path.split('/')[1]))??missing();
  if(path.startsWith('git/ref/tags/')){const sha=tags.get(decodeURIComponent(path.slice('git/ref/tags/'.length)));return sha?{object:{type:'commit',sha}}:missing();}
  if(path.includes('/artifacts?'))return {artifacts:artifacts.get(Number(path.split('/')[2]))??[]};
  if(/^actions\/runs\/\d+$/u.test(path))return rows.find(row=>row.id===Number(path.split('/')[2]))??missing();
  assert.match(path,/^actions\/workflows\/sdk\.yml\/runs\?/);
  const page=Number(new URL('https://example.test/'+path).searchParams.get('page'));return {workflow_runs:rows.slice((page-1)*100,page*100)};
 };
 const remove=async id=>{deleted.push(id);rows=rows.filter(row=>row.id!==id);artifacts.delete(id);logs.delete(id);};
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname.split('/').slice(4).join('/')+new URL(url).search;
  if(options.method==='DELETE'){
   if(path.startsWith('releases/'))publications.delete(Number(path.split('/')[1]));
   else if(path.startsWith('git/refs/tags/'))tags.delete(decodeURIComponent(path.slice('git/refs/tags/'.length)));
   else if(/^actions\/runs\/\d+$/u.test(path))await remove(Number(path.split('/')[2]));
   else throw Error('未知合成删除');
   return new Response(null,{status:204});
  }
  try{return Response.json(await read(path));}catch(error){if(error.message==='GitHub HTTP 404')return new Response(null,{status:404});throw error;}
 };
 return {deleted,read,remove,fetchImpl,publications,tags,artifacts,logs,setRows:values=>{rows=values;}};
}
test('产品真实执行旧Run删除，保留最新成功失败和全部活动任务，单独清理不派发',async()=>{
 let rows=[runRow(1,'success'),runRow(2,'failure'),runRow(3,'success'),runRow(4,'failure'),runRow(5,null,'in_progress')];const deleted=[],api=recordsFixture(rows);
 const fetchImpl=async(url,options)=>{
  if(!url.includes('/actions/runs/')&&!url.includes('/actions/workflows/'))return api.fetchImpl(url,options);
  if(options.method==='DELETE'){const id=Number(url.split('/').at(-1));assert.ok(url.startsWith('https://api.github.com/repos/crcfrcn/citizensdk/actions/runs/'));deleted.push(id);rows=rows.filter(row=>row.id!==id);await api.remove(id);return new Response(null,{status:204});}
  if(!url.includes('/workflows/'))return api.fetchImpl(url,options);
  assert.equal(options.method,'GET');assert.ok(url.includes('/actions/workflows/sdk.yml/runs?branch=main&event=workflow_dispatch&per_page=100&page='));return Response.json({workflow_runs:rows});
 };
 const declaration=await describeAction({flow:'cleanup',platform:'sdk'});
 const result=await declaration.launch({token:'synthetic',fetchImpl,report:()=>{}});
 assert.deepEqual(result.deleted,[1,2]);assert.deepEqual(result.kept.sort(),[3,4,5]);assert.deepEqual(deleted,[1,2]);
 assert.equal(result.completed,true);assert.equal(api.publications.has(1),false);assert.equal(api.tags.has(sdkName('1.1.1')),false);
 for(const id of [1,2]){assert.equal(api.artifacts.has(id),false);assert.equal(api.logs.has(id),false);}
});
test('新失败保留原成功；删除失败或回读仍存在旧记录均明确失败',async()=>{
 const api=recordsFixture([runRow(1,'success'),runRow(2,'failure'),runRow(3,'failure')]);
 assert.deepEqual((await cleanupRuns({...api,report:()=>{}})).kept.sort(),[1,3]);
 const fixture=recordsFixture([runRow(1,'success'),runRow(2,'success')]),read=fixture.read;
 await assert.rejects(cleanupRuns({...fixture,read,remove:async()=>{throw Error('GitHub HTTP 403');},report:()=>{}}),/403/);
 await assert.rejects(cleanupRuns({...fixture,read,remove:async()=>{},report:()=>{}}),/删除尚未确认/);
});
test('产品等原Run真实结束后才删除旧记录，状态先于完成返回且显示异常不影响流程',async()=>{
 let state=0,posts=0;const events=[],old=runRow(1,'success'),current=runRow(2,'success');let rows=[old];const api=recordsFixture([old,current]);
 const read=async path=>{
  if(path.startsWith('releases')||path.startsWith('git/')||path.includes('/artifacts?')||path==='actions/runs/1')return api.read(path);
  if(path.includes('/workflows/'))return {workflow_runs:rows};
  if(path.includes('/jobs?'))return {jobs:[]};
  assert.equal(path,'actions/runs/2');state++;return state===1?{...current,status:'in_progress',conclusion:null}:current;
 };
 const remove=async id=>{assert.equal(state,2);assert.equal(id,1);rows=[current];await api.remove(id);};
 const result=await automate({read,remove,fetchImpl:api.fetchImpl,interval:0,dispatch:async spec=>{posts++;assert.equal(spec.inputs.version,'1.1.2');rows=[old,{...current,status:'in_progress',conclusion:null}];return {workflow_run_id:2};},report:event=>{events.push(event);if(event.event==='jobs')throw Error('合成显示断开');}});
 assert.equal(result.runID,2);assert.equal(posts,1);assert.equal(events[0].event,'started');assert.equal(events[1].run.status,'in_progress');assert.ok(events.some(event=>event.event==='run'&&event.run.status==='completed'));
});
test('列表分页完整读取，不把第一页当全部历史记录',async()=>{
 const rows=[...Array.from({length:100},(_,index)=>runRow(index+2,'success')),runRow(1,'failure')],deleted=[],pages=[],api=recordsFixture(rows);
 const read=async path=>{if(!path.includes('/workflows/'))return api.read(path);const page=Number(new URL('https://example.test/'+path).searchParams.get('page'));pages.push(page);return {workflow_runs:rows.filter(row=>!deleted.includes(row.id)).slice((page-1)*100,page*100)};};
 const result=await cleanupRuns({read,fetchImpl:api.fetchImpl,remove:async id=>{deleted.push(id);await api.remove(id);},report:()=>{}});
 assert.equal(deleted.length,99);assert.deepEqual(result.kept.sort((a,b)=>a-b),[1,101]);assert.ok(pages.includes(2));
});
test('清理发布资产失败不阻塞旧失败Run删除，缺完整成功产物时保留旧成功',async()=>{
 const rows=[runRow(1,'success'),runRow(2,'success'),runRow(3,'failure'),runRow(4,'failure')],api=recordsFixture(rows);
 await assert.rejects(cleanupRuns({...api,fetchImpl:async(url,options)=>options.method==='DELETE'&&url.includes('/releases/')?new Response(null,{status:403}):api.fetchImpl(url,options),report:()=>{}}),/403/);
 assert.deepEqual(api.deleted,[1,3]);assert.equal(api.publications.has(1),true);
 // Run已删但Release尚在时，同一入口必须继续清理，不能让孤立资产永久漏掉。
 await cleanupRuns({...api,report:()=>{}});assert.equal(api.publications.has(1),false);
 const missing=recordsFixture(rows);missing.artifacts.delete(2);
 await assert.rejects(cleanupRuns({...missing,report:()=>{}}),/Artifact缺失/);
 assert.equal(missing.deleted.includes(1),false);assert.equal(missing.deleted.includes(3),true);
});
test('配置只保留声明，执行入口引用同一本仓脚本',async()=>{
 const text=readFileSync(new URL('../scripts/config.mjs',import.meta.url),'utf8');
 for(const name of ['nextVersion','retainedRuns','fetch(','workflowRuns','cleanupRuns({'])assert.equal(text.includes(name),false,name);
 const declared=await describeAction({flow:'release',platform:'sdk'});assert.equal(declared.launch,automate);
 assert.throws(()=>describeAction({flow:'release',platform:'ios'}));
});

test('删除前保护重新运行的任务及已改变归属的Tag',async()=>{
 const first=runRow(1,'failure'),latest=runRow(2,'failure'),api=recordsFixture([first,latest]);
 const read=async path=>{if(path==='actions/runs/1'){const active={...first,status:'in_progress',conclusion:null};api.setRows([active,latest]);return active;}return api.read(path);};
 const kept=await cleanupRuns({...api,read,report:()=>{}});assert.deepEqual(api.deleted,[]);assert.deepEqual(kept.kept.sort(),[1,2]);
 const moved=recordsFixture([runRow(1,'success'),runRow(2,'success')]);moved.tags.set(sdkName('1.1.1'),'b'.repeat(40));
 await assert.rejects(cleanupRuns({...moved,report:()=>{}}),/Tag归属已变化/);
 assert.equal(moved.tags.get(sdkName('1.1.1')),'b'.repeat(40));assert.equal(moved.publications.has(1),true);
});

test('自动化终态后的删除失败明确返回清理错误，不重新派发业务',async()=>{
 const latest=runRow(2,'failure'),api=recordsFixture([runRow(1,'failure'),latest]);let posts=0;const events=[];
 const read=async path=>path.includes('/jobs?')?{jobs:[]}:api.read(path);
 await assert.rejects(automate({...api,read,dispatch:async()=>{posts++;return {workflow_run_id:2};},remove:async()=>{throw Error('GitHub HTTP 403');},report:event=>events.push(event),interval:0}),/SDK记录清理失败.*403/);
 assert.equal(posts,1);assert.ok(events.some(event=>event.event==='run'&&event.run.conclusion==='failure'));
});
