#!/usr/bin/env node
import {readFileSync as tataGateRead, realpathSync as tataGateReal} from 'node:fs';
import {execFileSync as tataGateExec} from 'node:child_process';
export const tataGateOwner = "crcfrcn/citizensdk";
// 塔塔门禁仅只读核对所属仓提交、目录和源码边界；不准备资源或执行产品流程。
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,extname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const gateRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const contract=JSON.parse(readFileSync(join(gateRoot,'.github/tatagate/tatagate.json'),'utf8'));
const fail=message=>{throw Error('公民SDK门禁：'+message);};
const readGit=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024}).trim();
const ordinary=path=>{if(!existsSync(path))fail('缺少文件：'+path);const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())fail('非普通文件：'+path);return path;};
const names=(root,folder)=>readdirSync(join(root,folder)).sort();
const same=(a,b)=>JSON.stringify(a.sort())===JSON.stringify(b.sort());
const trackedFiles=root=>readGit(root,['ls-files','--cached','--others','--exclude-standard','-z'])
 .split('\0').filter(path=>path&&existsSync(join(root,path)));
export function gateContract(){
 if(contract.schema!==1||contract.repository!=='citizensdk'||contract.github_repository!=='crcfrcn/citizensdk')fail('仓库声明无效');
 if(!same(Object.keys(contract),['schema','repository','workflows','checks','platform_forbidden_values','github_repository','functions','sources']))fail('门禁登记字段不符');
 if(!same(contract.workflows,['release-sdk.yml'])||!same(contract.sources,['scripts/build.mjs','scripts/publish.mjs','.github/workflows/release-sdk.mjs']))fail('流程登记无效');
 if(!Array.isArray(contract.functions)||!same(contract.checks,['repository-contracts','dependency-contracts']))fail('静态检查登记无效');
 return contract;
}
export function validatePlatformNaming(root=gateRoot){
 const forbidden=contract.platform_forbidden_values;
 if(!Array.isArray(forbidden)||forbidden.length===0||new Set(forbidden).size!==forbidden.length||forbidden.some(name=>typeof name!=='string'||!name))fail('禁用平台名称登记无效');
 const extensions=new Set(['.mjs','.js','.dart','.rs','.c','.cc','.cpp','.h','.hpp','.java','.kt','.swift','.sh','.yml','.yaml','.toml','.json','.md']);
 for(const path of trackedFiles(root)){
  if(path.startsWith('.github/tatagate/')||!extensions.has(extname(path)))continue;
  const file=ordinary(join(root,path));let source=readFileSync(file,'utf8');
  if(path==='scripts/build.mjs')source=source.replace(/https:\/\/storage\.googleapis\.com\/flutter_infra_release\/releases\/stable\/macos\/flutter_macos_arm64_\d+\.\d+\.\d+-stable\.zip/gu,'');
  if(forbidden.some(value=>source.includes(value)))fail('产品源码含禁用平台名称：'+path);
 }
 return true;
}
export function validateRepositoryIdentity(root,{remote=false}={}){
 if(typeof root!=='string'||!isAbsolute(root)||realpathSync(root)!==root||root!==gateRoot)fail('仓库根不是正式检出');
 if(readGit(root,['rev-parse','--show-toplevel'])!==root||!tataGateBranch(root))fail('正式 main 检出身份无效');
 if(!['https://github.com/crcfrcn/citizensdk','https://github.com/crcfrcn/citizensdk.git'].includes(readGit(root,['remote','get-url','origin'])))fail('HTTPS origin 不符');
 if(remote&&process.env.GITHUB_REPOSITORY!=='crcfrcn/citizensdk')fail('GitHub 仓库身份不符');
 return true;
}
export function validateRange({root,baseSHA,headSHA}){
 if(!/^[a-f0-9]{40}$/u.test(headSHA)||!/^[a-f0-9]{40}$/u.test(baseSHA)||baseSHA===headSHA)fail('提交范围无效');
 if(readGit(root,['rev-parse','HEAD'])!==headSHA)fail('门禁目标不是当前提交');
 if(baseSHA!=='4b825dc642cb6eb9a060e54bf8d69288fbee4904')readGit(root,['merge-base','--is-ancestor',baseSHA,headSHA]);
 return true;
}
export function validateWorkflow(root=gateRoot){
  tataGateValidateWorkflow(tataGateRead(root+'/.github/workflows/tatagate.yml','utf8'));
 if(!same(names(root,'.github/workflows'),['release-sdk.yml','release-sdk.mjs','tatagate.yml']))fail('自动化文件集合无效');
 const text=readFileSync(ordinary(join(root,'.github/workflows/release-sdk.yml')),'utf8');
 if(!text.includes('name: citizensdk.sdk')||!text.includes('release-sdk.mjs'))fail('自动化入口无效');
 const jobs=[...text.matchAll(/^  ([a-z][a-z0-9_]*):\s*$/gmu)].map(match=>match[1]);
 if(!same(jobs,['prepare',...Array.from({length:11},(_,i)=>'stage_'+(i+1)),'flow','publish','cleanup']))fail('自动化任务闭集无效');
 return true;
}
export function validateBoundaries(root=gateRoot){
 gateContract();
 if(!same(names(root,'scripts'),['build.mjs','publish.mjs']))fail('scripts 必须恰好保留两个入口');
 if(!same(names(root,'.github/tatagate'),['tatagate.json','tatagate.mjs']))fail('门禁文件集合无效');
 validateWorkflow(root);
 for(const relative of ['pubspec.lock','Cargo.lock','native/legacy/Cargo.lock','native/smoldot/Cargo.lock']){
  const file=ordinary(join(root,relative)),source=readFileSync(file,'utf8');
  if(!source.trim()||relative==='pubspec.lock'&&!/^packages:\s*$/mu.test(source)
   ||relative.endsWith('Cargo.lock')&&(!/^version = 4$/mu.test(source)||!/^\[\[package\]\]$/mu.test(source)))fail('依赖锁结构无效：'+relative);
 }
 const entries={build:'scripts/build.mjs',publish:'scripts/publish.mjs',workflow:'.github/workflows/release-sdk.mjs'};
 const forbidden={build:['scripts/publish.mjs','.github/workflows/release-sdk.mjs','.github/tatagate/tatagate.mjs'],publish:['scripts/build.mjs','.github/workflows/release-sdk.mjs','.github/tatagate/tatagate.mjs'],workflow:['scripts/build.mjs','scripts/publish.mjs','.github/tatagate/tatagate.mjs']};
 const lockNames={build:'buildDependencyLock',publish:'publicationDependencyLock',workflow:'automationDependencyLock'};
 let lockedNative=null;
 for(const [kind,path] of Object.entries(entries)){
  const source=readFileSync(ordinary(join(root,path)),'utf8');
  for(const reference of forbidden[kind])if(source.includes(reference))fail(kind+' 直接依赖 '+reference);
  if(kind==='publish'){
   if(!['export function assertSmoldotLocks(', 'export function verifyCitizenSdkRelease(', 'export function buildCitizenSdkRelease(', 'Cargo.lock', 'pubspec.lock', 'native/legacy/Cargo.lock', 'native/smoldot/Cargo.lock'].every(value=>source.includes(value)))fail('发布入口缺少当前确定性来源与锁验真');
   continue;
  }
  const match=new RegExp('const '+lockNames[kind]+'=Object\\.freeze\\((\\{[^\\n]*\\})\\);','u').exec(source);
  if(!match)fail(kind+' 缺少本仓原生依赖登记');
  const locked=JSON.parse(match[1]);
  if(locked?.schema!==1||!locked.native||!locked.environment)fail(kind+' 原生依赖登记无效');
  const value=JSON.stringify(locked);
  if(lockedNative!==null&&lockedNative!==value)fail('各流程原生依赖登记不一致');
  lockedNative=value;
 }
 const cases=new Set();for(const item of contract.functions){
  if(!['cargo','flutter'].includes(item.runner)||typeof item.path!=='string'||item.path.includes('..'))fail('功能清单无效');
  const source=readFileSync(ordinary(join(root,item.path)),'utf8');
  if(item.runner==='flutter'&&!/\btest(?:Widgets)?\s*\(/u.test(source))fail('Flutter测试文件缺少用例：'+item.path);
  if(item.runner==='cargo'&&(!Array.isArray(item.cases)||item.cases.length===0))fail('Cargo测试登记无效：'+item.path);
  for(const name of item.cases||[]){const key=item.path+'\0'+name;if(typeof name!=='string'||!name||cases.has(key)||!source.includes(name))fail('功能用例源码不符：'+item.path);cases.add(key);}
 }
 validatePlatformNaming(root);
 return true;
}
export async function executeGate({root=gateRoot,baseSHA,headSHA}={}){
 validateRepositoryIdentity(root,{remote:process.env.GITHUB_ACTIONS==='true'});
 if(baseSHA||headSHA)validateRange({root,baseSHA,headSHA});
 if(readGit(root,['status','--porcelain=v1','--untracked-files=all']))fail('门禁只检查已保存的干净提交');
 validateBoundaries(root);
 return Object.freeze({repository:'citizensdk',base_sha:baseSHA,head_sha:headSHA});
}
export async function repositoryGateMain(args){
 const [mode,root,baseSHA,headSHA,work]=args;
 if(mode==='physical'&&args.length===2){validateRepositoryIdentity(root);validateBoundaries(root);return;}
 if(mode==='local'&&args.length===5){if(!isAbsolute(work)||!work.startsWith(join(root,'target/test')+sep))fail('门禁现场路径无效');return executeGate({root,baseSHA,headSHA});}
 fail('门禁参数无效');
}
if(!['github','cleanup'].includes(process.argv[2]) && !(process.env.NODE_TEST_CONTEXT && process.argv.length===2) && process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await repositoryGateMain(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
}

// GitHub入口和清理只处理本仓tatagate.yml；产品检查仍由本仓原有实现执行。
export function tataGateBranch(repositoryRoot) {
  if (process.env.GITHUB_ACTIONS === 'true') { tataGateContext(repositoryRoot); return true; }
  return tataGateExec(process.env.PRODUCT_GIT_BIN || '/usr/bin/git', ['-C',repositoryRoot,'branch','--show-current'], {encoding:'utf8'}).trim() === 'main';
}
export function tataGateContext(repositoryRoot, input=process.env, event=JSON.parse(tataGateRead(input.GITHUB_EVENT_PATH,'utf8'))) {
  if (input.GITHUB_ACTIONS !== 'true' || input.GITHUB_EVENT_NAME !== 'push'
    || input.GITHUB_REPOSITORY !== tataGateOwner || input.GITHUB_REF !== 'refs/heads/main'
    || input.GITHUB_WORKSPACE !== repositoryRoot || tataGateReal(repositoryRoot) !== repositoryRoot
    || event.repository?.full_name !== tataGateOwner || event.ref !== input.GITHUB_REF
    || event.deleted === true || event.after !== input.GITHUB_SHA
    || !/^[a-f0-9]{40}$/u.test(event.after || '') || !/^[a-f0-9]{40}$/u.test(event.before || '')
    || event.before === event.after || input.GITHUB_WORKFLOW_REF!==tataGateOwner+'/.github/workflows/tatagate.yml@refs/heads/main') {
    throw Error('本仓塔塔门禁GitHub事件身份无效');
  }
  const git=input.PRODUCT_GIT_BIN || '/usr/bin/git';
  const read=args=>tataGateExec(git,['-c','core.hooksPath=/dev/null','-C',repositoryRoot,...args],{encoding:'utf8'}).trim();
  if (read(['rev-parse','HEAD']) !== event.after || read(['rev-parse','--show-toplevel']) !== repositoryRoot
    || !['https://github.com/'+tataGateOwner,'https://github.com/'+tataGateOwner+'.git'].includes(read(['remote','get-url','--all','origin']))) {
    throw Error('本仓塔塔门禁GitHub提交或来源无效');
  }
  if(read(['status','--porcelain=v1','--untracked-files=all']))throw Error('本仓塔塔门禁GitHub检出存在未提交改动');
  if(input.GITHUB_JOB==='gate'&&event.before!=='0'.repeat(40)){
    try{tataGateExec(git,['-C',repositoryRoot,'merge-base','--is-ancestor',event.before,event.after],{encoding:'utf8',stdio:'pipe'});}catch{throw Error('本仓塔塔门禁GitHub提交范围不是快进祖先');}
  }
  return {...event,before:event.before === '0'.repeat(40) ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : event.before};
}
export function tataGateValidateWorkflow(source) {
  const jobs=source?.slice(source.indexOf('\njobs:\n')).match(/^  [a-z][a-z0-9_]*:$/gmu);
  const entry=new URL(import.meta.url).pathname.split('/').at(-1);
  const gate=source?.split('  gate:\n')[1]?.split('\n  cleanup:')[0];
  if(!gate||/^    continue-on-error:/mu.test(gate)||!source.includes('permissions:\n  contents: read\n'))throw Error('本仓塔塔门禁检查权限或结果处理无效');
  if(JSON.stringify(jobs)!==JSON.stringify(['  gate:','  cleanup:'])||!source.includes('run: node .github/tatagate/'+entry+' github\n')||!source.includes('run: node .github/tatagate/'+entry+' cleanup\n'))throw Error('本仓塔塔门禁Job或执行入口无效');
  if (typeof source !== 'string' || !source.startsWith('name: '+tataGateOwner.split('/')[1]+'.tatagate\n')
    || !/^  push:\n    branches: \[main\]$/mu.test(source)
    || /^\s*(?:workflow_run|workflow_dispatch|schedule|pull_request):/mu.test(source)
    || !source.includes('group: "${{ github.repository }}-tatagate"')
    || !/^  cancel-in-progress: false$/mu.test(source) || !/^  queue: max$/mu.test(source)
    || !/^  gate:$/mu.test(source) || !/^  cleanup:$/mu.test(source)
    || !/^    needs: \[gate\]$/mu.test(source) || !source.includes('if: ${{ always() }}')
    || !/^    continue-on-error: true$/mu.test(source)
    || !source.includes('TATAGATE_RESULT: "${{ needs.gate.result }}"')
    || !source.includes('persist-credentials: false')
    || !source.includes(' github\n') || !source.includes(' cleanup\n')) throw Error('本仓塔塔门禁Workflow合同无效');
  return true;
}
function tataGateWorkflowRun(run) {
  return Number.isSafeInteger(run?.id) && run.id>0 && Number.isSafeInteger(run.run_number) && run.run_number>0
    && Number.isSafeInteger(run.run_attempt) && run.run_attempt>0
    && run.path === '.github/workflows/tatagate.yml' && run.event === 'push' && run.head_branch === 'main'
    && run.repository?.full_name === tataGateOwner && /^[a-f0-9]{40}$/u.test(run.head_sha || '')
    && Number.isFinite(Date.parse(run.created_at));
}
export function tataGateCleanupPlan(rows,current,result) {
  if (!['success','failed'].includes(result) || !tataGateWorkflowRun(current) || !Array.isArray(rows)) throw Error('本仓塔塔门禁清理身份无效');
  return rows.filter(run=>tataGateWorkflowRun(run) && run.status==='completed' && typeof run.conclusion==='string'
    && run.id!==current.id && run.run_number<current.run_number
    && (run.conclusion==='success'?'success':'failed')===result).sort((a,b)=>a.run_number-b.run_number);
}
async function tataGateAPI(path,{method='GET',fetchImpl=fetch,token=process.env.GH_TOKEN}={}) {
  if (typeof token!=='string' || !token || typeof path!=='string' || path.includes('..') || path.startsWith('/') || /[\r\n]/u.test(path)) throw Error('本仓塔塔门禁API参数无效');
  let response;
  try {response=await fetchImpl('https://api.github.com/repos/'+tataGateOwner+'/'+path,{method,redirect:'error',
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'TataGate'},
    signal:AbortSignal.timeout(30000)});}catch{throw Error('本仓塔塔门禁API连接未确认');}
  if(response.status===404 && method==='GET')return null;
  if(!response.ok)throw Error('本仓塔塔门禁API失败：HTTP '+response.status);
  if(response.status===204)return null;
  let size=0;const parts=[];
  if(!response.body)throw Error('本仓塔塔门禁API回执缺失');
  for await(const chunk of response.body){size+=chunk.length;if(size>8*1024**2)throw Error('本仓塔塔门禁API回执超限');parts.push(chunk);}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw Error('本仓塔塔门禁API回执无效');}
}
async function tataGateHistory(current,api) {
  const read=async(start,end)=>{
    const query='actions/workflows/tatagate.yml/runs?event=push&branch=main&status=completed&created='+encodeURIComponent(new Date(start).toISOString().slice(0,19)+'Z..'+new Date(end).toISOString().slice(0,19)+'Z');
    const first=await api(query+'&per_page=100&page=1');
    if(!Number.isSafeInteger(first?.total_count)||!Array.isArray(first.workflow_runs))throw Error('本仓塔塔门禁历史清单无效');
    if(first.total_count>1000){const middle=Math.floor((start+end)/2000)*1000;if(middle<=start||middle>=end)throw Error('本仓塔塔门禁历史超过同秒上限');return [...await read(start,middle),...await read(middle+1000,end)];}
    const rows=[...first.workflow_runs];
    for(let page=2;rows.length<first.total_count;page++){const value=await api(query+'&per_page=100&page='+page);if(!Array.isArray(value?.workflow_runs)||!value.workflow_runs.length)throw Error('本仓塔塔门禁历史分页不完整');rows.push(...value.workflow_runs);}
    return rows;
  };
  const rows=await read(Date.UTC(2008,0,1),Math.floor(Date.parse(current.created_at)/1000)*1000);
  return [...new Map(rows.map(run=>[run.id,run])).values()];
}
export async function tataGateCleanup(result,identity,api=tataGateAPI) {
  const current=await api('actions/runs/'+identity.id);
  if(identity.attempt!==undefined&&current?.run_attempt!==identity.attempt)throw Error('本仓塔塔门禁当前Attempt不符');
  if(!tataGateWorkflowRun(current)||current.id!==identity.id||current.head_sha!==identity.sha)throw Error('本仓塔塔门禁当前Run回读无效');
  const plan=tataGateCleanupPlan(await tataGateHistory(current,api),current,result),removed=[];
  for(const candidate of plan){
    const path='actions/runs/'+candidate.id;
    const latest=await api('actions/runs/'+current.id);
    if(!latest||latest.head_sha!==current.head_sha||latest.run_attempt!==current.run_attempt)throw Error('本仓塔塔门禁当前Run已变化');
    const again=await api(path);
    if(again===null){removed.push(candidate.id);continue;}
    if(again.run_attempt!==candidate.run_attempt||again.conclusion!==candidate.conclusion
      ||tataGateCleanupPlan([again],current,result).length!==1)throw Error('本仓塔塔门禁旧Run已变化，停止清理');
    try{await api(path,{method:'DELETE'});}catch(error){if(await api(path)!==null)throw error;}
    if(await api(path)!==null)throw Error('本仓塔塔门禁旧Run删除回查失败');
    removed.push(candidate.id);
  }
  return removed;
}
export async function tataGateCommand(mode) {
  const {fileURLToPath}=await import('node:url'),{resolve}=await import('node:path');
  const repositoryRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
  const event=tataGateContext(repositoryRoot);
  tataGateValidateWorkflow(tataGateRead(repositoryRoot+'/.github/workflows/tatagate.yml','utf8'));
  if(mode==='github'){if(process.env.GITHUB_JOB!=='gate')throw Error('本仓塔塔门禁Job身份无效');const receipt=await tataGateRunOwn(repositoryRoot,event);console.log(JSON.stringify({repository:tataGateOwner,source_sha:event.after,receipt}));return receipt;}
  if(process.env.GITHUB_JOB!=='cleanup')throw Error('本仓塔塔门禁清理Job身份无效');
  const result=process.env.TATAGATE_RESULT;
  if(!['success','failure','cancelled','skipped'].includes(result))throw Error('本仓塔塔门禁前置结果无效');
  const id=Number(process.env.GITHUB_RUN_ID);
  if(!Number.isSafeInteger(id)||id<=0)throw Error('本仓塔塔门禁Run编号无效');
  const jobs=await tataGateAPI('actions/runs/'+id+'/jobs?filter=latest&per_page=100');
  const gate=jobs?.jobs?.find(job=>job.name==='gate');
  if(gate?.status!=='completed'||typeof gate.conclusion!=='string'||(gate.conclusion==='success')!==(result==='success'))throw Error('本仓塔塔门禁前置结果与GitHub不一致');
  const removed=await tataGateCleanup(result==='success'?'success':'failed',{id,sha:event.after,attempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
  const summary='塔塔门禁'+(result==='success'?'成功':'失败')+'；同类旧Run已清理：'+(removed.join('、')||'无')+'。\n';
  if(process.env.GITHUB_STEP_SUMMARY){const {appendFileSync}=await import('node:fs');appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);}
  console.log(summary.trim());
}
if(process.argv[1] && ['github','cleanup'].includes(process.argv[2]) && process.argv.length===3
  && new URL('file:'+process.argv[1]).href===import.meta.url){
  try{await tataGateCommand(process.argv[2]);}catch(error){console.error(error.message?.startsWith('本仓')?error.message:'本仓塔塔门禁执行失败');process.exitCode=1;}
}

async function tataGateRunOwn(repositoryRoot,event) {
  const receipt=await executeGate({root:repositoryRoot,baseSHA:event.before,headSHA:event.after});
  const {spawnSync}=await import('node:child_process');
  const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',import.meta.filename],{cwd:repositoryRoot,env:environment,encoding:'utf8',maxBuffer:8*1024**2});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
  if(result.error||result.signal||result.status!==0||!/^# tests [1-9][0-9]*$/mu.test(result.stdout||'')||!['fail','cancelled','skipped','todo'].every(name=>new RegExp('^# '+name+' 0$','mu').test(result.stdout||'')))throw Error('本仓塔塔门禁回归没有完整通过');
  return receipt;
}

// BEGIN INLINE TESTS
if(process.env.NODE_TEST_CONTEXT && process.argv.length===2 && process.argv[1]===import.meta.filename){
  const {test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
  test('塔塔门禁Workflow只允许本仓push，门禁和清理同处唯一文件',()=>{
    const source=tataGateRead(new URL('../workflows/tatagate.yml',import.meta.url),'utf8');
    assert.equal(tataGateValidateWorkflow(source),true);
    for(const invalid of [source.replace('branches: [main]','branches: [other]'),source.replace('needs: [gate]','needs: [other]'),source.replace('continue-on-error: true','continue-on-error: false')])assert.throws(()=>tataGateValidateWorkflow(invalid));
  });
  test('塔塔门禁成功清旧成功、失败清旧失败，活动、未来和其它流程均保留',()=>{
    const row=(id,conclusion='success',status='completed')=>({id,run_number:id,run_attempt:1,path:'.github/workflows/tatagate.yml',event:'push',head_branch:'main',head_sha:'a'.repeat(40),repository:{full_name:tataGateOwner},created_at:'2026-01-01T00:00:00Z',status,conclusion});
    const current=row(9,null,'in_progress'),rows=[row(1),row(2,'failure'),row(3,null,'in_progress'),row(10),{...row(4),path:'.github/workflows/release-sdk.yml'},{...row(5),repository:{full_name:'example/other'}}];
    assert.deepEqual(tataGateCleanupPlan(rows,current,'success').map(x=>x.id),[1]);
    assert.deepEqual(tataGateCleanupPlan(rows,current,'failed').map(x=>x.id),[2]);
  });
  test('塔塔门禁删除逐项回查，清理失败和重跑变化均不能伪报完成',async()=>{
    const current={id:9,run_number:9,run_attempt:1,path:'.github/workflows/tatagate.yml',event:'push',head_branch:'main',head_sha:'a'.repeat(40),repository:{full_name:tataGateOwner},created_at:'2026-01-02T00:00:00Z',status:'in_progress',conclusion:null};
    const old={...current,id:1,run_number:1,status:'completed',conclusion:'success',created_at:'2026-01-01T00:00:00Z'};
    for(const mode of ['success','readback','rerun']){
      let deleted=false;const api=async(path,options={})=>{
        if(path==='actions/runs/9')return current;
        if(path.startsWith('actions/workflows/'))return {total_count:1,workflow_runs:[old]};
        if(options.method==='DELETE'){deleted=true;return null;}
        if(path==='actions/runs/1')return mode==='rerun'?{...old,run_attempt:2}:deleted&&mode==='success'?null:old;
        throw Error('错误清理路径');
      };
      if(mode==='success')assert.deepEqual(await tataGateCleanup('success',{id:9,sha:current.head_sha},api),[1]);
      else await assert.rejects(tataGateCleanup('success',{id:9,sha:current.head_sha},api),/回查失败|已变化/u);
      if(mode==='rerun')assert.equal(deleted,false);
    }
  });
  test('GitHub门禁接受准确提交的detached检出，错仓、错SHA和错误Workflow拒绝',async()=>{
    const {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync}=await import('node:fs');
    const {tmpdir}=await import('node:os'),{join}=await import('node:path');
    const directory=mkdtempSync(join(realpathSync(tmpdir()),'tata-gate-context-'));
    try{
      const git=process.env.PRODUCT_GIT_BIN||'/usr/bin/git';
      const invoke=args=>tataGateExec(git,['-c','core.hooksPath=/dev/null','-c','user.name=Tata Gate Fixture','-c','user.email=fixture@example.invalid','-C',directory,...args],{encoding:'utf8'}).trim();
      invoke(['init','--quiet','--initial-branch=main']);invoke(['remote','add','origin','https://github.com/'+tataGateOwner+'.git']);
      writeFileSync(join(directory,'file'),'first');invoke(['add','file']);invoke(['commit','--quiet','-m','first']);const before=invoke(['rev-parse','HEAD']);
      writeFileSync(join(directory,'file'),'second');invoke(['add','file']);invoke(['commit','--quiet','-m','second']);const after=invoke(['rev-parse','HEAD']);
      invoke(['checkout','--quiet','--detach',after]);
      const input={GITHUB_ACTIONS:'true',GITHUB_JOB:'gate',GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:tataGateOwner,GITHUB_REF:'refs/heads/main',GITHUB_WORKSPACE:directory,GITHUB_SHA:after,
        GITHUB_WORKFLOW_REF:tataGateOwner+'/.github/workflows/tatagate.yml@refs/heads/main',PRODUCT_GIT_BIN:git};
      const event={repository:{full_name:tataGateOwner},ref:'refs/heads/main',before,after};
      assert.equal(tataGateContext(directory,input,event).after,after);
      invoke(['remote','set-url','origin','https://github.com/'+tataGateOwner]);assert.equal(tataGateContext(directory,input,event).after,after);
      invoke(['remote','set-url','origin','https://github.com/'+tataGateOwner+'.git']);
      assert.throws(()=>tataGateContext(directory,input,{...event,before:'a'.repeat(40)}),/祖先/u);
      writeFileSync(join(directory,'late'),'new change');assert.throws(()=>tataGateContext(directory,input,event),/未提交改动/u);rmSync(join(directory,'late'));
      for(const changed of [{...input,GITHUB_SHA:before},{...input,GITHUB_REPOSITORY:'example/other'},{...input,GITHUB_WORKFLOW_REF:tataGateOwner+'/.github/workflows/release-sdk.yml@refs/heads/main'}])assert.throws(()=>tataGateContext(directory,changed,event));
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

}
// END INLINE TESTS
