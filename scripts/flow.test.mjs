// 本产品远端正常、失败、身份、候选与控制边界；全部远端数据用真实Response夹具注入。
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {remoteContract,executeRemote,nextReleaseVersion,releaseSourceVersion,latestSuccessfulCI,selectReleaseCandidate,githubRetentionRecord,recoverRemote,recordSourceContract,validateFormalRecordSource,querySoftwareRecords} from './flow.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const declaration=JSON.parse(readFileSync(join(root,'scripts/flows.json'),'utf8'));
const routes=declaration.remote_routes;
const token='ghs_'+ 'fixture'.repeat(6),sourceSHA='a'.repeat(40),runID=420;
const title=contract=>{const p=contract.title.split(' · ');return p[0]+' · '+p[2]+' · '+p[1];};
const row=contract=>({id:runID,status:'completed',conclusion:'success',event:'workflow_dispatch',head_branch:'main',
 head_sha:sourceSHA,display_title:title(contract),created_at:'2026-10-06T00:00:00Z',
 path:declaration.platforms[contract.workflow.split('.')[1]][contract.workflow.split('.')[2]].entry,
 html_url:`https://github.com/${contract.repository}/actions/runs/${runID}`});
const output=()=>{const chunks=[];return {chunks,write:value=>chunks.push(String(value))};};
test('全部当前路由属于本产品、平台及固定流程，缺失和错误身份拒绝',()=>{
 for(const route of routes){const contract=remoteContract(route.flow,route.platform);assert.equal(contract.workflow,route.canonicalID);assert.equal(contract.title,route.expectedTitle);}
 for(const args of [['publish',routes[0].platform],['ci','unregistered'],['release','../escape']])assert.throws(()=>remoteContract(...args));
});
test('版本递增与唯一源码格式保持原有规则',()=>{
 assert.equal(nextReleaseVersion('1.0.0',[]),'1.0.0');assert.equal(nextReleaseVersion('1.0.0',['1.0.99']),'1.1.0');
 assert.equal(nextReleaseVersion('1.0.0',['1.99.99']),'2.0.0');assert.throws(()=>nextReleaseVersion('bad',[]));
 assert.equal(releaseSourceVersion('json','{"version":"1.2.3"}'),'1.2.3');
 assert.equal(releaseSourceVersion('pubspec','version: 1.2.3+4\n'),'1.2.3');
 assert.equal(releaseSourceVersion('cargo-workspace','[workspace]\nversion="9.9.9"\n[workspace.package]\nversion = "1.2.3"\n'),'1.2.3');
 for(const source of ['[workspace]\nversion="1.0.0"\n','[workspace.package]\nversion = "1.0.0"\nversion = "1.0.1"\n'])assert.throws(()=>releaseSourceVersion('cargo-workspace',source));
});
for(const route of routes.filter(value=>value.flow==='ci'))test(route.canonicalID+'独立运行自行派发、跟踪和清理，不依赖宿主',async()=>{
 const contract=remoteContract('ci',route.platform),valid=row(contract),requests=[],log=output();
 await executeRemote('ci',route.platform,{environment:{GH_TOKEN:token},output:log,fetchImpl:async(url,options)=>{
  requests.push({url,options});assert.ok(url.startsWith('https://api.github.com/repos/'+contract.repository+'/'));
  assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+token);
  if(url.endsWith('/dispatches')){assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{pipeline:route.canonicalID,run_title:title(contract)}});
   return Response.json({workflow_run_id:runID,run_url:`https://api.github.com/repos/${contract.repository}/actions/runs/${runID}`,html_url:valid.html_url});}
  if(url.endsWith('/actions/runs/'+runID))return Response.json(valid);
  if(url.includes('/actions/runs?'))return Response.json({workflow_runs:[valid]});
  throw Error('夹具不接受其它接口');
 }});
 assert.equal(requests.filter(x=>x.url.endsWith('/dispatches')).length,1);assert.equal(requests.some(x=>x.options.method==='DELETE'),false);
 assert.match(log.chunks.join(''),/^PRODUCT_REMOTE_RUN:/u);assert.ok(!log.chunks.join('').includes(token));
});
test('派发失败、响应错仓及取消不能冒充成功',async()=>{
 const route=routes.find(x=>x.flow==='ci');
 for(const response of [new Response('denied',{status:403}),Response.json({workflow_run_id:1,run_url:'https://api.github.com/repos/other/product/actions/runs/1',html_url:'https://github.com/other/product/actions/runs/1'})]){
  const log=output();await assert.rejects(executeRemote('ci',route.platform,{environment:{GH_TOKEN:token},output:log,fetchImpl:async()=>response}));assert.equal(log.chunks.length,0);
 }
 const abort=new AbortController();abort.abort();let calls=0;
 await assert.rejects(executeRemote('ci',route.platform,{environment:{GH_TOKEN:token},signal:abort.signal,fetchImpl:async()=>{calls++;throw Error('不应请求');}}));assert.equal(calls,0);
});
test('成功CI选择保持同产品同平台，错标题、失败和错Workflow不能入选',async()=>{
 const route=routes.find(x=>x.flow==='release'),contract=remoteContract('release',route.platform),valid=row(remoteContract('ci',route.platform));let cleared;
 const selected=await latestSuccessfulCI(contract,token,{request:async()=>({total_count:4,workflow_runs:[valid,{...valid,id:runID+1,display_title:'其它产品 · Web · CI'},{...valid,id:runID+2,conclusion:'failure'},{...valid,id:runID+3,path:'.github/workflows/wrong.yml'}]}),prune:async value=>{cleared=value;}});
 assert.deepEqual(selected,{runId:runID,sourceSHA});assert.equal(cleared.canonicalId,contract.ciWorkflow);
 await assert.rejects(latestSuccessfulCI(contract,token,{request:async()=>({total_count:0,workflow_runs:[]}),prune:async()=>assert.fail('无成功CI不得清理')}));
});
test('重试只复用同成功CI源码与Run；新CI重新生成候选',async()=>{
 const route=routes.find(x=>x.flow==='release'),contract=remoteContract('release',route.platform),runtime=contract.sourceKind==='spec',version=runtime?2:'1.0.17';
 const previous={product_id:declaration.product_id,workflow:contract.workflow,software_flow:'release',ci_run_id:90,source_sha:sourceSHA,run_id:91,software_version:runtime?null:version,spec_version:runtime?version:null,version_tag:contract.tagPrefix+version,...runtime?{}:{platform:route.platform}};
 const environment={PRODUCT_RELEASE_RETRY_CONTEXT:Buffer.from(JSON.stringify(previous)).toString('base64')};let calls=0;
 const dependencies={findCI:async()=>({runId:90,sourceSHA}),createFresh:async(_contract,_environment,ci)=>{calls++;return {...previous,ci_run_id:ci.runId,run_id:null};}};
 assert.deepEqual(await selectReleaseCandidate(contract,environment,dependencies),previous);assert.equal(calls,0);
 assert.equal((await selectReleaseCandidate(contract,environment,{...dependencies,findCI:async()=>({runId:100,sourceSHA})})).run_id,null);assert.equal(calls,1);
 await assert.rejects(selectReleaseCandidate(contract,{PRODUCT_RELEASE_RETRY_CONTEXT:'!'},dependencies));
});
test('记录清理拒绝别仓并保护非同身份与活动Run',()=>{
 const route=routes.find(x=>x.flow==='ci'),contract=remoteContract('ci',route.platform),valid=row(contract);
 assert.equal(githubRetentionRecord({...valid,status:'in_progress',conclusion:null},contract.repository,contract.workflow).active,true);
 assert.equal(githubRetentionRecord({...valid,display_title:'其它产品 · Web · CI'},contract.repository,contract.workflow),null);
 assert.throws(()=>githubRetentionRecord(valid,'other/product',contract.workflow));
});
async function controlFrames(input,count=1){
 const moduleURL=new URL('./flow.mjs',import.meta.url).href;
 const source=`import {createControl,readReleaseControlFrame,closeControl} from ${JSON.stringify(moduleURL)};const control=createControl({PRODUCT_CONTROL_FD:'3'});try{const frames=[];for(let n=0;n<${count};n++)frames.push(await readReleaseControlFrame(control));process.stdout.write(JSON.stringify({frames}));}catch(error){process.stdout.write(JSON.stringify({error:error.message}));}finally{closeControl(control);}`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe','pipe']});let text='',error='';
 child.stdout.setEncoding('utf8').on('data',chunk=>text+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>error+=chunk);child.stdio[3].on('error',()=>{});
 const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(error)));});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{child.stdio[3].end(input);await finished;return JSON.parse(text);}finally{clearTimeout(timer);}
}
test('真实控制管道按序读取有界帧且异常关闭后进程退出',async()=>{
 assert.deepEqual(await controlFrames('accepted\nresult\n',2),{frames:['accepted','result']});
 for(const input of ['', '\n','invalid\0frame\n','a'.repeat(65537)+'\n'])assert.ok((await controlFrames(input)).error);
 assert.equal((await controlFrames('a'.repeat(65536)+'\n')).frames[0].length,65536);
});

for(const route of routes.filter(value=>value.flow==='release'))test(route.canonicalID+'独立Release候选、成功CI和正式版本都由产品验真',async()=>{
 const contract=remoteContract('release',route.platform);
 if(contract.sourceKind==='spec')return;
 const ci=remoteContract('ci',route.platform),validCI=row(ci),releaseRow={...row(contract),id:runID+1,html_url:`https://github.com/${contract.repository}/actions/runs/${runID+1}`};
 const log=output(),requests=[];let inputs;
 const source=contract.sourceKind==='pubspec'||contract.sourceKind==='pubspec-package'?'version: 1.0.0\n':contract.sourceKind==='cargo-workspace'?'[workspace.package]\nversion = "1.0.0"\n':'{"version":"1.0.0"}';
 await executeRemote('release',route.platform,{environment:{GH_TOKEN:token},output:log,fetchImpl:async(url,options)=>{
  requests.push({url,options});
  if(url.includes('/actions/workflows/')&&url.includes('/runs?'))return Response.json({total_count:1,workflow_runs:[validCI]});
  if(url.includes('/actions/runs?'))return Response.json({workflow_runs:inputs?[validCI,releaseRow]:[validCI]});
  if(url.endsWith('/actions/runs/'+runID))return Response.json(validCI);
  if(url.includes('/contents/'))return new Response(source);
  if(url.includes('/releases?'))return Response.json([]);
  if(url.endsWith('/dispatches')){
   inputs=JSON.parse(options.body).inputs;assert.equal(inputs.pipeline,route.canonicalID);assert.equal(inputs.source_sha,sourceSHA);assert.equal(inputs.ci_run_id,String(runID));assert.equal(inputs.version_tag,contract.tagPrefix+'1.0.0');
   return Response.json({workflow_run_id:runID+1,run_url:`https://api.github.com/repos/${contract.repository}/actions/runs/${runID+1}`,html_url:releaseRow.html_url});
  }
  if(url.endsWith('/actions/runs/'+(runID+1)))return Response.json(releaseRow);
  if(url.includes('/releases/tags/'))return Response.json(formalRecordFixture(route).release);
  if(url.includes('/git/ref/tags/'))return Response.json({ref:'refs/tags/'+inputs.version_tag,object:{type:'commit',sha:sourceSHA}});
  if(url.endsWith('/releases/assets/501'))return new Response(JSON.stringify(formalRecordFixture(route).metadata));
  throw Error('夹具拒绝其它接口');
 }});
 assert.equal(requests.filter(x=>x.url.endsWith('/dispatches')).length,1);
 const markers=log.chunks.filter(x=>x.startsWith('PRODUCT_RELEASE_CANDIDATE:'));assert.equal(markers.length,2);
 const final=JSON.parse(Buffer.from(markers[1].slice('PRODUCT_RELEASE_CANDIDATE:'.length).trim(),'base64').toString('utf8'));
 assert.equal(final.run_id,runID+1);assert.equal(final.ci_run_id,runID);assert.equal(final.source_sha,sourceSHA);
});


function formalRecordFixture(route) {
 const policy=recordSourceContract(route.platform),contract=remoteContract('release',route.platform),tag=contract.tagPrefix+'1.0.0';
 const metadata=policy.kind==='manifest'?{product_id:declaration.product_id,[policy.version_field]:'1.0.0',[policy.source_field]:sourceSHA}:null;
 const body=policy.marker_prefix?[policy.marker_prefix+'_RELEASE_CI_RUN_ID:41',policy.marker_prefix+'_RELEASE_RUN_ID:42',policy.marker_prefix+'_RELEASE_SOURCE_SHA:'+sourceSHA].join('\n'):'';
 const assets=policy.kind==='manifest'?[{id:501,name:policy.metadata_asset,size:Buffer.byteLength(JSON.stringify(metadata)),state:'uploaded'}]:policy.asset_names.map((name,i)=>({id:501+i,name,size:5,state:'uploaded'}));
 const release={id:401,name:contract.title,tag_name:tag,draft:false,prerelease:false,immutable:policy.immutable,assets,body,
  published_at:'2026-10-06T12:00:00Z',html_url:'https://github.com/'+contract.repository+'/releases/tag/'+tag};
 return {policy,release,metadata,tag,contract};
}
for(const route of routes.filter(row=>row.recordsFormalRelease))test(route.canonicalID+'正式记录验真归产品并拒绝错源/错资产/重复标记',()=>{
 const {policy,release,metadata}=formalRecordFixture(route);
 assert.equal(validateFormalRecordSource(route.platform,release,sourceSHA,metadata),sourceSHA);
 assert.throws(()=>validateFormalRecordSource(route.platform,{...release,draft:true},sourceSHA,metadata));
 assert.throws(()=>validateFormalRecordSource(route.platform,{...release,tag_name:'foreign-v1.0.0'},sourceSHA,metadata));
 assert.throws(()=>validateFormalRecordSource(route.platform,release,'bad',metadata));
 if(policy.kind==='manifest') {
  assert.throws(()=>validateFormalRecordSource(route.platform,release,sourceSHA,{...metadata,product_id:'foreign'}));
  assert.throws(()=>validateFormalRecordSource(route.platform,release,sourceSHA,{...metadata,[policy.version_field]:'1.0.1'}));
 }
 if(policy.kind==='body') {
  assert.throws(()=>validateFormalRecordSource(route.platform,{...release,assets:[]},sourceSHA));
  assert.throws(()=>validateFormalRecordSource(route.platform,{...release,body:release.body+'\n'+policy.marker_prefix+'_RELEASE_SOURCE_SHA:'+sourceSHA},sourceSHA));
  assert.throws(()=>validateFormalRecordSource(route.platform,{...release,body:release.body.replace(sourceSHA,'b'.repeat(40))},sourceSHA));
 }
 if(policy.immutable)assert.throws(()=>validateFormalRecordSource(route.platform,{...release,immutable:false},sourceSHA));
});
test('软件记录独立刷新保持同仓、固定公开回执与真实保留器，不删除正式资产',async()=>{
 const requested=[],repository=remoteContract(routes[0].flow,routes[0].platform).repository;
 const receipt=await querySoftwareRecords({environment:{GH_TOKEN:token},fetchImpl:async(url,options)=>{
  requested.push({url,options});assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.method,'GET');
  if(url.includes('/actions/runs?'))return Response.json({workflow_runs:[]});
  if(url.includes('/releases?'))return Response.json([]);
  throw Error('夹具不允许其它操作');
 }});
 assert.deepEqual(receipt,{records:[],removed_run_ids:[]});assert.ok(requested.every(row=>row.url.startsWith('https://api.github.com/repos/'+repository+'/')));
 assert.equal(JSON.stringify(receipt).includes(token),false);
});
test('软件记录读取最新版正式资产，元数据重定向不会转发仓库令牌',async()=>{
 const route=routes.find(row=>row.recordsFormalRelease);if(!route)return;
 const {policy,release,metadata,tag,contract}=formalRecordFixture(route);const requests=[];
 const receipt=await querySoftwareRecords({environment:{GH_TOKEN:token},fetchImpl:async(url,options)=>{
  requests.push({url,options});
  if(url.startsWith('https://release-assets.githubusercontent.com/')){assert.equal(options.headers,undefined);return new Response(JSON.stringify(metadata));}
  assert.ok(url.startsWith('https://api.github.com/repos/'+contract.repository+'/'));assert.equal(options.headers.Authorization,'Bearer '+token);
  if(url.includes('/actions/runs?'))return Response.json({workflow_runs:[]});
  if(url.includes('/releases?'))return Response.json([release]);
  if(url.includes('/releases/tags/'))return Response.json(release);
  if(url.includes('/git/ref/tags/'))return Response.json({ref:'refs/tags/'+tag,object:{type:'commit',sha:sourceSHA}});
  if(url.endsWith('/releases/assets/501'))return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture/manifest'}});
  throw Error('夹具不接受其它接口');
 }});
 assert.equal(receipt.records.length,1);assert.equal(receipt.records[0].source_sha,sourceSHA);assert.equal(receipt.records[0].tag_sha,sourceSHA);
 assert.equal(receipt.records[0].repository,contract.repository);assert.deepEqual(receipt.removed_run_ids,[]);
 assert.equal(requests.some(row=>row.url.includes('release-assets.githubusercontent.com')),policy.kind==='manifest');
});
test('软件记录错误接口、超限结果与取消失败，不泄露远端诊断或令牌',async()=>{
 for(const fetchImpl of [async()=>{throw Error(token);},async()=>Response.json({workflow_runs:Array(101).fill({})}),async()=>Response.json({workflow_runs:[]},{status:500})]) {
  await assert.rejects(querySoftwareRecords({environment:{GH_TOKEN:token},fetchImpl}),error=>!error.message.includes(token));
 }
 const cancellation=new AbortController();cancellation.abort(Error('准确任务取消'));
 await assert.rejects(querySoftwareRecords({environment:{GH_TOKEN:token},signal:cancellation.signal,fetchImpl:async()=>{throw Error('不能开始网络操作');}}),/准确任务取消/u);
});

for(const route of routes.filter(row=>row.flow==='release'&&row.recordsFormalRelease))test(route.canonicalID+'恢复同一Run并返回产品完整验真回执，不重新派发',async()=>{
 const {release,metadata,tag,contract}=formalRecordFixture(route),ci=remoteContract('ci',route.platform);
 const candidate={product_id:declaration.product_id,platform:route.platform,software_flow:'release',software_version:'1.0.0',
  source_sha:sourceSHA,spec_version:null,workflow:contract.workflow,ci_run_id:runID,run_id:runID+1,version_tag:tag};
 const releaseRun={...row(contract),id:runID+1,run_number:12,html_url:'https://github.com/'+contract.repository+'/actions/runs/'+(runID+1)};
 const requests=[];
 const fetchImpl=async(url,options)=>{
  requests.push({url,options});assert.equal(options.method??'GET','GET');
  if(url.endsWith('/actions/runs/'+(runID+1)))return Response.json(releaseRun);
  if(url.endsWith('/actions/runs/'+runID))return Response.json(row(ci));
  if(url.includes('/actions/runs?'))return Response.json({workflow_runs:[row(ci),releaseRun]});
  if(url.includes('/releases/tags/'))return Response.json(release);
  if(url.includes('/git/ref/tags/'))return Response.json({ref:'refs/tags/'+tag,object:{type:'commit',sha:sourceSHA}});
  if(url.endsWith('/releases/assets/501'))return new Response(JSON.stringify(metadata));
  throw Error('恢复夹具不能派发或执行其它操作');
 };
 const environment={GH_TOKEN:token,PRODUCT_RELEASE_RETRY_CONTEXT:Buffer.from(JSON.stringify(candidate)).toString('base64')};
 const receipt=await recoverRemote('release',route.platform,runID+1,'success',{environment,fetchImpl});
 assert.deepEqual(receipt.removed_run_ids,[]);assert.equal(receipt.formal_release.run_id,runID+1);assert.equal(receipt.formal_release.run_number,12);
 assert.equal(receipt.formal_release.source_sha,sourceSHA);assert.equal(receipt.formal_release.tag,tag);
 releaseRun.conclusion='failure';await assert.rejects(recoverRemote('release',route.platform,runID+1,'success',{environment,fetchImpl}),/终态不一致/u);
 releaseRun.conclusion='success';candidate.source_sha='b'.repeat(40);environment.PRODUCT_RELEASE_RETRY_CONTEXT=Buffer.from(JSON.stringify(candidate)).toString('base64');
 await assert.rejects(recoverRemote('release',route.platform,runID+1,'success',{environment,fetchImpl}),/成功CI/u);
});
