// 最简入口仍必须保持SDK完整性、Cargo真实布局、原锁、缓存与版本边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,readlinkSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {root,claimCache,createFlutterSourceView,verifyComplete,setVersion,appleLibraries,verifyImageSymbols} from '../scripts/build.mjs';
import {nextVersion,retainedRuns,sdkName,cleanupRuns,automate,publish,publicationSource,verifyPublication,cleanupPublications,consume} from '../scripts/build.mjs';
import {describeAction} from '../scripts/config.mjs';
function fixture(t){const base=join(root,'target/test');mkdirSync(base,{recursive:true});const work=mkdtempSync(join(base,'regression-'));t.after(()=>rmSync(work,{recursive:true,force:true}));return work;}
test('SDK唯一平台与版本，失败不递增，只留最新成功和失败并保护活动任务',()=>{
 const row=(id,version,conclusion,status='completed')=>({id,display_title:'公民SDK·SDK·v'+version,conclusion,status,created_at:new Date(id*1000).toISOString(),kind:'automation',artifact:{}});
 const rows=[row(1,'1.2.9','success'),row(2,'1.2.10','failure'),row(3,'1.2.10',null,'queued')];assert.equal(sdkName('1.2.10'),'公民SDK·SDK·v1.2.10');assert.equal(nextVersion(rows),'1.2.10');assert.deepEqual([...retainedRuns([row(0,'1.2.8','success'),...rows])].sort(),[1,2,3]);for(const value of ['1.0','01.0.0','1.0.0\n','1.0.0-beta'])assert.throws(()=>sdkName(value));
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

// 合成GitHub服务只验证流程合同；不派发、不构建、不发布真实SDK。
const SHA='a'.repeat(40),REPOSITORY='crcfrcn/citizensdk';
function runRow(id,conclusion='success',status='completed',kind='automation'){
 return {id,status,conclusion,head_sha:SHA,head_branch:'main',path:'.github/workflows/sdk.yml',event:'workflow_dispatch',repository:{full_name:REPOSITORY},head_repository:{full_name:REPOSITORY},run_attempt:1,display_title:sdkName('1.1.'+id),created_at:new Date(id*1000).toISOString(),kind};
}
function recordsFixture(initial){
 let rows=[...initial];const deleted=[],writes=[],publications=new Map(),tags=new Map(),artifacts=new Map(),logs=new Set(rows.map(row=>row.id));
 for(const row of rows)artifacts.set(row.id,row.kind==='automation'&&row.conclusion==='success'?[{id:row.id*10,name:row.display_title,expired:false,size_in_bytes:10,digest:'sha256:'+'0'.repeat(64),workflow_run:{id:row.id,head_sha:row.head_sha,head_branch:'main'}}]:[]);
 const missing=()=>{throw Error('GitHub HTTP 404');};
 const page=(path,values)=>{const n=Number(new URL('https://example.test/'+path).searchParams.get('page'));return values.slice((n-1)*100,n*100);};
 const read=async path=>{
  if(path==='git/ref/heads/main')return {object:{type:'commit',sha:SHA}};
  if(path.startsWith('releases?'))return page(path,[...publications.values()]);
  if(path.startsWith('releases/'))return publications.get(Number(path.split('/')[1]))??missing();
  if(path.startsWith('git/ref/tags/')){const value=tags.get(decodeURIComponent(path.slice('git/ref/tags/'.length)));return value?{object:{type:'commit',sha:value}}:missing();}
  if(path.includes('/artifacts?'))return {artifacts:page(path,artifacts.get(Number(path.split('/')[2]))??[])};
  if(path.includes('/jobs?')){const row=rows.find(row=>row.id===Number(path.split('/')[2]));return {jobs:page(path,row?.kind?[{steps:[{name:'CitizenSDK: '+row.kind,status:'completed',conclusion:'success'}]}]:[])};}
  if(/^actions\/runs\/\d+$/u.test(path))return rows.find(row=>row.id===Number(path.split('/')[2]))??missing();
  assert.match(path,/^actions\/workflows\/sdk\.yml\/runs\?/u);return {workflow_runs:page(path,rows)};
 };
 const remove=async id=>{deleted.push(id);rows=rows.filter(row=>row.id!==id);artifacts.delete(id);logs.delete(id);};
 const fetchImpl=async(url,options)=>{
  assert.ok(url.startsWith('https://api.github.com/repos/'+REPOSITORY+'/'));const path=new URL(url).pathname.split('/').slice(4).join('/')+new URL(url).search;
  if(options.method==='DELETE'){
   writes.push(path);
   if(path.startsWith('releases/'))publications.delete(Number(path.split('/')[1]));
   else if(path.startsWith('git/refs/tags/'))tags.delete(decodeURIComponent(path.slice('git/refs/tags/'.length)));
   else if(/^actions\/runs\/\d+$/u.test(path))await remove(Number(path.split('/')[2]));else throw Error('未知合成删除');
   return new Response(null,{status:204});
  }
  try{return Response.json(await read(path));}catch(error){if(error.message==='GitHub HTTP 404')return new Response(null,{status:404});throw error;}
 };
 const publication=row=>{
  const version=row.display_title.split('·v')[1],proof={product_id:'citizensdk',platform:'sdk',software_version:version,producer_run_id:row.id,producer_run_attempt:row.run_attempt,git_commit_sha:row.head_sha,assets:[{name:row.display_title+'.zip',sha256:'0'.repeat(64)}]};
  const value={id:row.id,tag_name:row.display_title,name:row.display_title,target_commitish:row.head_sha,body:JSON.stringify(proof),published_at:row.created_at,draft:false,prerelease:false,assets:['zip','json','sha256'].map(extension=>({label:row.display_title+'.'+extension,state:'uploaded'}))};
  publications.set(row.id,value);tags.set(row.display_title,row.head_sha);return value;
 };
 return {deleted,writes,read,remove,fetchImpl,publications,tags,artifacts,logs,publication,setRows:values=>{rows=values;}};
}
test('自动化和普通清理只删除旧Run，不改动任何Release或Tag',async()=>{
 const rows=[runRow(1),runRow(2,'failure'),runRow(3),runRow(4,'failure'),runRow(5,null,'in_progress')],api=recordsFixture(rows);
 const release=api.publication(rows[0]);const result=await describeAction({flow:'cleanup',platform:'sdk'}).launch({token:'synthetic',fetchImpl:api.fetchImpl,report:()=>{}});
 assert.deepEqual(result.deleted,[2]);assert.deepEqual(result.kept.sort(),[1,3,4,5]);assert.equal(api.publications.get(1),release);assert.equal(api.tags.get(rows[0].display_title),SHA);
 assert.deepEqual(api.writes,['actions/runs/2']);assert.equal(api.artifacts.has(2),false);assert.equal(api.logs.has(2),false);
});
test('按流程保留成功失败，保护已发布来源和活动发布所需自动化',async()=>{
 const a=runRow(1),b=runRow(2),c=runRow(3,'success','completed','publish'),d=runRow(4,null,'queued','publish'),api=recordsFixture([a,b,c,d]);
 assert.deepEqual((await cleanupRuns({...api,report:()=>{}})).deleted,[]);
 const unknown=runRow(5,'failure','completed',null);assert.ok(retainedRuns([a,b,unknown]).has(5));
 const failed=runRow(6,'failure','completed','publish');assert.equal(nextVersion([{...a,artifact:{}},c,failed]),'1.1.2');
});
test('新失败不删原成功，过期完整产物阻止清理旧成功，删除错误如实失败',async()=>{
 const api=recordsFixture([runRow(1),runRow(2,'failure'),runRow(3,'failure')]);assert.deepEqual((await cleanupRuns({...api,report:()=>{}})).deleted,[2]);
 const missing=recordsFixture([runRow(1),runRow(2),runRow(3,'failure'),runRow(4,'failure')]);missing.artifacts.get(2)[0].expired=true;
 await assert.rejects(cleanupRuns({...missing,report:()=>{}}),/新完整SDK Artifact不可用/u);assert.deepEqual(missing.deleted,[3]);
 for(const remove of [async()=>{throw Error('GitHub HTTP 403');},async()=>{}]){
  const fixture=recordsFixture([runRow(1,'failure'),runRow(2,'failure')]);await assert.rejects(cleanupRuns({...fixture,remove,report:()=>{}}),/403|删除尚未确认/u);
 }
});
test('分页完整读取，删除前重新确认attempt、归属和活动状态',async()=>{
 const rows=Array.from({length:101},(_,i)=>runRow(i+1,'failure')),api=recordsFixture(rows),pages=[];
 const result=await cleanupRuns({...api,read:async path=>{if(path.includes('/workflows/'))pages.push(path);return api.read(path);},report:()=>{}});assert.equal(result.deleted.length,100);assert.equal(pages.length,2);
 for(const changed of [{status:'in_progress',conclusion:null},{run_attempt:2}]){
  const first=runRow(1,'failure'),fixture=recordsFixture([first,runRow(2,'failure')]);
  await cleanupRuns({...fixture,read:async path=>path==='actions/runs/1'?{...first,...changed}:fixture.read(path),report:()=>{}});assert.deepEqual(fixture.deleted,[]);
 }
});
test('自动化一次派发，观察同一Run终态后清理，不执行发布',async()=>{
 const old=runRow(1),latest=runRow(2),api=recordsFixture([old]);let posts=0,reads=0;const events=[];
 const read=async path=>path==='actions/runs/2'&&++reads===1?{...latest,status:'in_progress',conclusion:null}:api.read(path);
 const result=await automate({...api,read,interval:0,dispatch:async spec=>{posts++;assert.deepEqual(spec,{workflow:'sdk.yml',ref:'main',inputs:{action:'automation',version:'1.1.2',sha:SHA}});api.setRows([old,latest]);api.artifacts.set(2,[{...api.artifacts.get(1)[0],id:20,name:latest.display_title,workflow_run:{id:2,head_sha:SHA,head_branch:'main'}}]);return {workflow_run_id:2};},report:event=>{events.push(event);if(event.event==='jobs')throw Error('合成显示断开');}});
 assert.equal(result.runID,2);assert.equal(posts,1);assert.equal(events[0].event,'started');assert.ok(events.some(event=>event.event==='run'&&event.run.status==='completed'));assert.deepEqual(api.deleted,[1]);assert.deepEqual(api.writes,[]);
});
test('瞬时读取错误只观察原Run；权限错误和无效派发回执不重派',async()=>{
 const latest=runRow(2,'failure'),api=recordsFixture([latest]);let posts=0,reads=0,jobs=0;
 const errors=[new TypeError('fetch failed'),...['408','429','500','502','503','504'].map(status=>Error('GitHub HTTP '+status))];
 const read=async path=>{if(path==='actions/runs/2'&&reads++<errors.length)throw errors[reads-1];if(path==='actions/runs/2'&&reads===errors.length+1)return {...latest,status:'in_progress',conclusion:null};if(path== 'actions/runs/2/jobs?per_page=100&page=1'&&++jobs===1)throw new TypeError('fetch failed');return api.read(path);};
 await automate({...api,read,dispatch:async()=>{posts++;return {workflow_run_id:2};},report:()=>{},interval:0});assert.equal(posts,1);
 for(const stage of ['run','jobs'])for(const status of [401,403,404]){
  let count=0;const fixture=recordsFixture([latest]);
  await assert.rejects(automate({...fixture,read:async path=>{if(path===(stage==='run'?'actions/runs/2':'actions/runs/2/jobs?per_page=100&page=1'))throw Error('GitHub HTTP '+status);return fixture.read(path);},dispatch:async()=>{count++;return {workflow_run_id:2};},report:()=>{},interval:0}),new RegExp(String(status)));assert.equal(count,1);assert.deepEqual(fixture.deleted,[]);
 }
 for(const receipt of [null,{}, {workflow_run_id:true},{workflow_run_id:'02'}]){let count=0;await assert.rejects(automate({...api,dispatch:async()=>{count++;return receipt;},report:()=>{},interval:0}),/身份无效/u);assert.equal(count,1);}
});
test('原Run终态清理失败如实失败，绝不重新派发',async()=>{
 const api=recordsFixture([runRow(1,'failure'),runRow(2,'failure')]);let posts=0;
 await assert.rejects(automate({...api,dispatch:async()=>{posts++;return {workflow_run_id:2};},remove:async()=>{throw Error('GitHub HTTP 403');},report:()=>{},interval:0}),/SDK记录清理失败.*403/u);assert.equal(posts,1);
});
test('发布准确复用成功自动化版本、SHA、attempt与Artifact，不加版本或重编',async()=>{
 const source=runRow(1),publisher={...runRow(2,'success','completed','publish'),display_title:source.display_title},api=recordsFixture([source]);let posts=0;
 const result=await describeAction({flow:'publish',platform:'sdk',inputs:{sourceRun:1}}).launch({...api,dispatch:async spec=>{posts++;assert.deepEqual(spec.inputs,{action:'publish',version:'1.1.1',sha:SHA,source_run:'1',source_attempt:'1',source_artifact:'10'});api.setRows([source,publisher]);return {workflow_run_id:2};},interval:0,report:()=>{}});
 assert.equal(result.runID,2);assert.equal(posts,1);assert.deepEqual(api.writes,[]);assert.deepEqual(api.deleted,[]);
});
test('未完成、失败、发布Run、错误仓库或SHA、无效或重复Artifact必须拒绝发布',async()=>{
 const cases=[{row:{status:'in_progress',conclusion:null}},{row:{conclusion:'failure'}},{row:{kind:'publish'}},{row:{path:'other.yml'}},{row:{repository:{full_name:'other/repo'}}},{row:{head_repository:{full_name:'other/repo'}}},{row:{head_branch:'other'}},{row:{head_sha:'bad'}},{row:{head_sha:'b'.repeat(40)}},{artifact:{expired:true}},{artifact:{digest:null}},{artifact:{workflow_run:{id:999,head_sha:SHA,head_branch:'main'}}},{empty:true},{duplicate:true}];
 for(const item of cases){const row={...runRow(1),...item.row},api=recordsFixture([row]);let dispatched=false;
  if(item.artifact)Object.assign(api.artifacts.get(1)[0],item.artifact);if(item.empty)api.artifacts.set(1,[]);if(item.duplicate)api.artifacts.get(1).push({...api.artifacts.get(1)[0],id:11});
  await assert.rejects(publish({...api,sourceRun:1,dispatch:async()=>{dispatched=true;},report:()=>{},interval:0}));assert.equal(dispatched,false);assert.deepEqual(api.writes,[]);
 }
 const api=recordsFixture([runRow(1)]);let reads=0;await assert.rejects(publicationSource({...api,sourceRun:1,read:async path=>path==='actions/runs/1'&&++reads===2?{...runRow(1),run_attempt:2}:api.read(path)}),/已变化/u);
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
test('独立发布清理只删除较旧且归属准确的Release/Tag，保留较新和活动来源',async()=>{
 const rows=[runRow(1),runRow(2),runRow(3)],api=recordsFixture(rows);rows.forEach(api.publication);api.publications.set(9,{id:9,tag_name:'other',body:'other'});
 const result=await cleanupPublications({...api,releaseID:2,token:'synthetic'});assert.deepEqual(result.deleted,[1]);assert.equal(api.publications.has(2),true);assert.equal(api.publications.has(3),true);assert.equal(api.publications.has(9),true);assert.deepEqual(api.writes,['releases/1','git/refs/tags/'+encodeURIComponent(rows[0].display_title)]);
 for(const condition of ['draft','tag','active']){const fixture=recordsFixture(rows.slice(0,2));rows.slice(0,2).forEach(fixture.publication);
  if(condition==='draft')fixture.publications.get(2).draft=true;if(condition==='tag')fixture.tags.set(rows[0].display_title,'b'.repeat(40));if(condition==='active')fixture.setRows([{...rows[0],status:'in_progress'},rows[1]]);
  if(condition==='active'){await cleanupPublications({...fixture,releaseID:2});assert.deepEqual(fixture.writes,[]);}else{await assert.rejects(cleanupPublications({...fixture,releaseID:2}));assert.deepEqual(fixture.writes,[]);}
 }
});
test('配置只声明现有调度合同，单一工作流按流程隔离写权限与构建发布',()=>{
 const text=readFileSync(join(root,'scripts/config.mjs'),'utf8');for(const value of ['nextVersion','fetch(','workflowRuns','cleanupRuns({'])assert.equal(text.includes(value),false);
 assert.equal(describeAction({flow:'release',platform:'sdk'}).launch,automate);assert.throws(()=>describeAction({flow:'release',platform:'ios'}));assert.throws(()=>describeAction({flow:'other',platform:'sdk'}));
 const workflow=readFileSync(join(root,'.github/workflows/sdk.yml'),'utf8'),automation=workflow.slice(0,workflow.indexOf('\n  publish:'));
 assert.match(workflow,/options: \[automation, publish\]/u);assert.doesNotMatch(automation,/contents: write|gh release|git\/refs|cleanup-publications/u);
 assert.match(workflow,/artifact-ids: \$\{\{ inputs.source_artifact \}\}/u);assert.match(workflow,/run-id: \$\{\{ inputs.source_run \}\}/u);assert.match(workflow,/node scripts\/build.mjs verify-publication/u);
 assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  publish:')),/build\.mjs (?:native|package|test)|contents: read/u);
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
