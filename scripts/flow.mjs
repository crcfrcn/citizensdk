#!/usr/bin/env node
import {withFixedWork,fixedWork,workEnvironment,claimFixedWork,releaseFixedWork} from './target.mjs';
// 本产品完整CI/Release入口；独立执行和宿主调用使用同一候选、派发、验真与清理实现。
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,readFileSync,realpathSync,mkdtempSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {bootstrapNode} from './resources.mjs';
import {runBuildProcess,temporaryRoot} from './build.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const productID="citizensdk";
const repositoryName="crcfrcn/citizensdk";
const operation=new AsyncLocalStorage();
function sourceFile(relative) {
 if(typeof relative!=='string'||relative.startsWith('/')||relative.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('产品流程源码路径无效');
 const path=join(root,relative),stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||realpathSync(path)!==path||stat.size>1024*1024)throw Error('产品流程源码必须为有界规范普通文件');
 return readFileSync(path);
}
function currentDeclaration() {
 const value=JSON.parse(sourceFile('scripts/flows.json'));
 if(value.schema!==1||value.product_id!==productID||value.flow_entry!=='scripts/flow.mjs'
  ||!Array.isArray(value.remote_routes)||value.remote_routes.length>128||!value.platforms)throw Error('产品远端流程声明无效');
 return value;
}
export function remoteContract(flow,platform) {
 if(!['ci','release'].includes(flow)||typeof platform!=='string')throw Error('产品远端流程身份无效');
 const value=currentDeclaration(),identity=productID+'.'+platform+'.'+flow;
 const rows=value.remote_routes.filter(row=>row.canonicalID===identity),row=rows[0];
 if(rows.length!==1||row.repository!==productID||row.productID!==productID||row.flow!==flow||row.platform!==platform
  ||typeof row.expectedTitle!=='string'||row.expectedTitle.length>256||/[\x00-\x1f\x7f]/u.test(row.expectedTitle)
  ||typeof row.recordsFormalRelease!=='boolean')throw Error('产品当前远端路由不唯一或越界');
 workflowDisplayTitle(row.expectedTitle,flow);
 const entry=value.platforms[platform]?.[flow]?.entry;
 if(typeof entry!=='string'||!/^\.github\/workflows\/[a-z][a-z0-9-]*\.yml$/u.test(entry))throw Error('产品Workflow入口无效');
 sourceFile(entry);
 if(flow==='ci') {
  if(row.tagPrefix!==null||row.recordsFormalRelease)throw Error('CI路由不得声明正式版本');
  return {repository:repositoryName,workflow:identity,title:row.expectedTitle};
 }
 const ci=remoteContract('ci',platform),version=value.platforms[platform].release.version_source;
 if(!version||Object.keys(version).sort().join(',')!=='kind,path')throw Error('正式版本真源声明无效');
 return checkedContract({repository:repositoryName,workflow:identity,title:row.expectedTitle,
  ciWorkflow:ci.workflow,ciTitle:ci.title,productId:productID,platform,
  tagPrefix:row.tagPrefix,sourceKind:version.kind,sourcePath:version.path});
}
function workflowFile(identity) {
 const match=/^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\.(ci|release)$/u.exec(identity);
 if(!match||match[1]!==productID)throw Error('产品Workflow身份越界');
 const value=currentDeclaration(),entry=value.platforms[match[2]]?.[match[3]]?.entry;
 if(typeof entry!=='string'||!/^\.github\/workflows\/[a-z][a-z0-9-]*\.yml$/u.test(entry))throw Error('产品Workflow当前入口无效');
 return entry.slice('.github/workflows/'.length);
}
function workflowDisplayTitle(title,flow=null) {
 const parts=String(title).split(' · '),mode={CI:'ci',Release:'release'}[parts[1]];
 if(parts.length!==3||parts.some(x=>!x||x.trim()!==x)||!mode||flow!==null&&flow!==mode)throw Error('产品Workflow标题无效');
 return `${parts[0]} · ${parts[2]} · ${parts[1]}`;
}
async function boundedBody(response,maximum=16*1024*1024) {
 if(!response.body)return '';
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;
  if(bytes>maximum){await reader.cancel();throw Error('产品远端响应超限');}chunks.push(item.value);}
 return Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)),bytes).toString('utf8');
}
// 令牌仅进入当前仓GitHub HTTPS请求头；重定向、越仓和任何诊断响应均不进入日志。
async function apiRequest(endpoint,{token,method='GET',input='',raw=false,missing=false}={}) {
 const context=operation.getStore()||{};context.signal?.throwIfAborted();
 context.verifySource?.();
 if(typeof endpoint!=='string'||!endpoint.startsWith('repos/'+repositoryName+'/')||/[\x00-\x20\x7f]/u.test(endpoint)
  ||endpoint.includes('..')||!['GET','POST','DELETE'].includes(method))throw Error('产品GitHub请求越界');
 token=token||context.token;
 if(typeof token!=='string'||!token.startsWith('ghs_')||token.length<=4||token.length>2048||/[\s\x00-\x1f\x7f]/u.test(token))throw Error('产品GitHub临时令牌无效');
 const signal=AbortSignal.any([AbortSignal.timeout(30000),...(context.signal?[context.signal]:[])]);
 try {
  const response=await (context.fetchImpl||fetch)('https://api.github.com/'+endpoint,{method,redirect:'manual',signal,
   headers:{Authorization:'Bearer '+token,Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json',
    'Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},...(input?{body:input}:{})});
  if(response.status===404&&missing){await response.body?.cancel();return null;}
  if(!response.ok){await response.body?.cancel();throw Error('产品GitHub请求失败');}
  return await boundedBody(response);
 } catch { context.signal?.throwIfAborted();throw Error('产品GitHub临时权限操作失败'); }
}
async function githubRequest({token,arguments_:args,input=''}) {
 if(args[0]!=='api')throw Error('产品GitHub操作类型无效');
 let endpoint,method='GET',raw=false;
 for(let i=1;i<args.length;i++){
  if(args[i]==='--method'){method=args[++i];continue;}
  if(args[i]==='-H'){raw||=String(args[++i]).includes('raw+json');continue;}
  if(args[i]==='--input'){if(args[++i]!=='-')throw Error('产品GitHub输入无效');continue;}
  if(endpoint)throw Error('产品GitHub接口参数无效');endpoint=args[i];
 }
 return apiRequest(endpoint,{token,method,input,raw});
}
async function retentionRequest(endpoint,method='GET') {
 const source=await apiRequest(endpoint,{method,missing:true});
 return source===null?null:source?JSON.parse(source):{};
}
async function createWorkflowRun({token,repository,workflow,title,flow,inputs={}}) {
 const contract=remoteContract(flow,workflow.split('.')[1]),context=operation.getStore();
 if(repository!==repositoryName||contract.workflow!==workflow||contract.title!==title)throw Error('产品Workflow与当前声明不一致');
 context?.verifySource?.();
 if(!inputs||Array.isArray(inputs)||Object.hasOwn(inputs,'pipeline')||Object.hasOwn(inputs,'run_title'))throw Error('产品Workflow输入无效');
 const fields={pipeline:workflow,run_title:workflowDisplayTitle(title,flow),...inputs};
 if(Object.keys(fields).length>25||Object.entries(fields).some(([key,value])=>! /^[a-z][a-z0-9_]*$/u.test(key)
  ||typeof value!=='string'||value.length>4096||/[\x00\r\n]/u.test(value)))throw Error('产品Workflow输入越界');
 const text=await apiRequest(`repos/${repository}/actions/workflows/${workflowFile(workflow)}/dispatches`,
  {token,method:'POST',input:JSON.stringify({ref:'main',inputs:fields})});
 let value;try{value=JSON.parse(text);}catch{throw Error('GitHub没有返回有效Run响应');}
 const runId=value.workflow_run_id,url=value.html_url;
 if(!Number.isSafeInteger(runId)||runId<=0||value.run_url!==`https://api.github.com/repos/${repository}/actions/runs/${runId}`
  ||url!==`https://github.com/${repository}/actions/runs/${runId}`)throw Error('GitHub没有返回准确Run ID');
 const remote={repository,workflow,runId,url};if(context)context.remote=remote;return remote;
}
function workflowRunReceipt(remote) {
 return Buffer.from(JSON.stringify({repository:remote.repository,workflow:remote.workflow,run_id:remote.runId,url:remote.url})).toString('base64');
}
// 可选宿主只确认当前Run和候选。没有宿主时仍由本产品自行轮询、验真和清理。
export function createControl(environment=process.env) {
 const value=environment.PRODUCT_CONTROL_FD;
 if(value===undefined)return {hosted:false,closed:false};
 if(value!=='3')throw Error('产品远端控制通道无效');
 const control={hosted:true,closed:false,frames:[],buffer:Buffer.alloc(0),pending:null,error:null};
 const stream=createReadStream(null,{fd:3,autoClose:true});control.stream=stream;
 const reject=message=>{control.error=Error(message);control.pending?.reject(control.error);control.pending=null;};
 stream.on('data',chunk=>{
  control.buffer=Buffer.concat([control.buffer,chunk]);
  for(;;){const newline=control.buffer.indexOf(10);if(newline<0)break;
   if(newline>65536){reject('产品远端控制帧超限');stream.destroy();return;}
   let frame=control.buffer.subarray(0,newline);control.buffer=control.buffer.subarray(newline+1);
   if(frame.at(-1)===13)frame=frame.subarray(0,-1);
   const text=frame.toString('utf8');if(!text||text.includes('\0')||Buffer.byteLength(text)!==frame.length){reject('产品远端控制帧无效');stream.destroy();return;}
   if(control.pending){control.pending.resolve(text);control.pending=null;}else control.frames.push(text);
   if(control.frames.length>8){reject('产品远端控制帧过多');stream.destroy();return;}
  }
  if(control.buffer.length>65536){reject('产品远端控制帧超限');stream.destroy();}
 });
 stream.on('error',()=>reject('产品远端控制管道失败'));
 stream.on('end',()=>{control.eof=true;if(control.pending)reject('产品远端控制管道已关闭');});
 const signal=operation.getStore()?.signal;
 control.abort=()=>{reject('产品任务已取消');stream.destroy();};
 signal?.addEventListener('abort',control.abort,{once:true});control.signal=signal;
 if(signal?.aborted)control.abort();
 return control;
}
function nextControl(control) {
 if(control.error)return Promise.reject(control.error);
 if(control.frames.length)return Promise.resolve(control.frames.shift());
 if(control.closed||control.eof||control.pending)return Promise.reject(Error('产品远端控制状态无效'));
 return new Promise((resolve,reject)=>{control.pending={resolve,reject};});
}
export function closeControl(control) {
 if(control.closed)return;control.closed=true;
 control.signal?.removeEventListener('abort',control.abort);
 control.pending?.reject(Error('产品远端控制管道已关闭'));control.pending=null;control.stream?.destroy();
}
async function waitRemote(remote) {
 const context=operation.getStore()||{};let failures=0;
 for(let n=0;n<4320;n++){
  context.signal?.throwIfAborted();let row;
  try{row=JSON.parse(await apiRequest(`repos/${remote.repository}/actions/runs/${remote.runId}`));failures=0;}
  catch(error){if(context.signal?.aborted||++failures>=3)throw error;await delay(5000,undefined,{signal:context.signal});continue;}
  const contract=remoteContract(remote.workflow.split('.').at(-1),remote.workflow.split('.')[1]);
  if(row.id!==remote.runId||row.html_url!==remote.url||row.head_branch!=='main'||row.event!=='workflow_dispatch'
   ||row.display_title!==workflowDisplayTitle(contract.title)||!String(row.path||'').endsWith('.github/workflows/'+workflowFile(remote.workflow)))throw Error('产品远端Run身份不一致');
  if(row.status==='completed')return row.conclusion==='success'?'success':'failed';
  await delay(5000,undefined,{signal:context.signal});
 }
 throw Error('产品远端任务超时');
}
export async function runCI(contract,environment=process.env,output=process.stdout) {
 const control=createControl(environment);
 try {
  const remote=await createWorkflowRun({...contract,flow:'ci',token:environment.GH_TOKEN});
  output.write('PRODUCT_REMOTE_RUN:'+workflowRunReceipt(remote)+'\n');
  if(control.hosted&&await nextControl(control)!=='PRODUCT_REMOTE_RUN_ACCEPTED:'+remote.runId)throw Error('宿主未确认CI Run绑定');
  const terminal=control.hosted?await nextControl(control):'PRODUCT_REMOTE_RESULT:'+remote.runId+':'+await waitRemote(remote);
  const success=terminal==='PRODUCT_REMOTE_RESULT:'+remote.runId+':success';
  if(!success&&terminal!=='PRODUCT_REMOTE_RESULT:'+remote.runId+':failed')throw Error('产品CI终态无效');
  await pruneGitHubRuns({repository:contract.repository,canonicalId:contract.workflow,currentRunId:remote.runId,result:success?'success':'failed'});
  if(!success)throw Error('CI失败');return remote;
 } finally { closeControl(control); }
}
const semanticPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d{0,1})\.(0|[1-9]\d{0,1})$/u;
const shaPattern = /^[0-9a-f]{40}$/u;

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseJSON(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label}返回了无效JSON`); }
}

function parseSemantic(value) {
  const match = semanticPattern.exec(String(value || ''));
  if (!match) throw new Error('Release软件版本无效');
  return match.slice(1).map(Number);
}

function nextSemantic(seed, versions) {
  const values = [seed, ...versions];
  values.forEach(parseSemantic);
  const selected = [...new Set(versions)].sort((left, right) => {
    const a = parseSemantic(left), b = parseSemantic(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }).at(-1);
  if (!selected) return seed;
  let [major, minor, patch] = parseSemantic(selected);
  patch += 1;
  if (patch > 99) { patch = 0; minor += 1; }
  if (minor > 99) { minor = 0; major += 1; }
  return `${major}.${minor}.${patch}`;
}

function checkedContract(value) {
  const keys = [
    'repository', 'workflow', 'title', 'ciWorkflow', 'ciTitle', 'productId',
    'platform', 'tagPrefix', 'sourceKind', 'sourcePath',
  ];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository)
    || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.release$/u.test(value.workflow)
    || value.ciWorkflow !== value.workflow.replace(/\.release$/u, '.ci')
    || !/^[a-z][a-z0-9-]*$/u.test(value.productId)
    || !/^[a-z][a-z0-9-]*$/u.test(value.platform)
    || !/^[a-z0-9-]+-v$/u.test(value.tagPrefix)
    || !['json', 'pubspec', 'pubspec-package', 'cargo-workspace', 'literal', 'spec'].includes(value.sourceKind)
    || typeof value.sourcePath !== 'string' || value.sourcePath.startsWith('/')
    || value.sourcePath.includes('..') || /[\u0000\r\n]/u.test(value.sourcePath)
    || typeof value.title !== 'string' || typeof value.ciTitle !== 'string'
    || value.title.length < 2 || value.ciTitle.length < 2) {
    throw new Error('Release产品端合同无效');
  }
  if (value.sourceKind === 'literal') parseSemantic(value.sourcePath);
  if (value.sourceKind !== 'literal' && (!value.sourcePath || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value.sourcePath))) {
    throw new Error('Release版本真源路径无效');
  }
  return Object.freeze({ ...value });
}

async function requestJSON(token, argumentsList, label) {
  return parseJSON(await githubRequest({ token, arguments_: argumentsList }), label);
}

async function repositoryFile(contract, sourceSHA, token) {
  return githubRequest({
    token,
    arguments_: [
      'api', '-H', 'Accept: application/vnd.github.raw+json',
      `repos/${contract.repository}/contents/${contract.sourcePath}?ref=${sourceSHA}`,
    ],
  });
}

function sourceVersion(kind, source) {
  if (kind === 'json') {
    const version = parseJSON(source, '版本文件')?.version;
    parseSemantic(version);
    return version;
  }
  if (kind === 'pubspec' || kind === 'pubspec-package') {
    const expression = kind === 'pubspec'
      ? /^version:\s*([^+\s]+)(?:\+\d+)?\s*$/gmu
      : /^version:\s*([^\s]+)\s*$/gmu;
    const matches = [...source.matchAll(expression)];
    if (matches.length !== 1) throw new Error('Release版本真源不唯一');
    parseSemantic(matches[0][1]);
    return matches[0][1];
  }
  if (kind === 'cargo-workspace') {
    // 中文注释：先定位唯一准确表头，再截到下一表头；行末不能充当当前段的结束条件。
    const headers = [...source.matchAll(/^\[workspace\.package\][ \t]*\r?$/gmu)];
    if (headers.length !== 1) throw new Error('Cargo workspace版本真源不唯一');
    const following = source.slice(headers[0].index + headers[0][0].length);
    const nextHeader = following.search(/^\[[^\r\n]+\][ \t]*\r?$/mu);
    const section = nextHeader < 0 ? following : following.slice(0, nextHeader);
    const matches = [...section.matchAll(/^[ \t]*version[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*\r?$/gmu)];
    if (matches.length !== 1) throw new Error('Cargo workspace版本真源不唯一');
    parseSemantic(matches[0][1]);
    return matches[0][1];
  }
  throw new Error('Release版本真源类型无效');
}

async function releaseVersions(contract, token) {
  const versions = [];
  for (let page = 1; page <= 100; page += 1) {
    const rows = await requestJSON(token, [
      'api', `repos/${contract.repository}/releases?per_page=100&page=${page}`,
    ], 'GitHub Release列表');
    if (!Array.isArray(rows)) throw new Error('GitHub Release列表格式无效');
    for (const release of rows) {
      if (release?.draft === true || release?.prerelease === true) continue;
      const tag = String(release?.tag_name || '');
      if (!tag.startsWith(contract.tagPrefix)) continue;
      const version = tag.slice(contract.tagPrefix.length);
      parseSemantic(version);
      versions.push(version);
    }
    if (rows.length < 100) return versions;
  }
  throw new Error('GitHub Release列表超过安全分页上限');
}

export async function latestSuccessfulCI(contract, token, {
  request = requestJSON, prune = pruneGitHubRuns,
} = {}) {
  const matches = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await request(token, [
      'api', `repos/${contract.repository}/actions/workflows/${workflowFile(contract.ciWorkflow)}/runs?event=workflow_dispatch&branch=main&status=completed&per_page=100&page=${page}`,
    ], 'GitHub CI列表');
    const rows = response?.workflow_runs;
    if (!Array.isArray(rows) || !Number.isSafeInteger(response.total_count)) {
      throw new Error('GitHub CI列表格式无效');
    }
    for (const row of rows) {
      if (row?.status === 'completed' && row?.conclusion === 'success'
        && row?.event === 'workflow_dispatch' && row?.head_branch === 'main'
        && row?.display_title === workflowDisplayTitle(contract.ciTitle, 'ci')
        && Number.isSafeInteger(row.id) && row.id > 0 && shaPattern.test(String(row.head_sha || ''))
        && String(row.path || '').endsWith(`.github/workflows/${workflowFile(contract.ciWorkflow)}`)) {
        matches.push(row);
      }
    }
    if (rows.length < 100) break;
    if(page===100) throw Error('GitHub成功CI列表超过安全分页上限');
  }
  matches.sort((left, right) => right.id - left.id);
  const row = matches[0];
  if (!row) throw new Error('GitHub上没有该产品端成功CI，禁止启动Release');
  await prune({ repository: contract.repository, canonicalId: contract.ciWorkflow,
    currentRunId: row.id, result: 'success' });
  return Object.freeze({ runId: row.id, sourceSHA: row.head_sha });
}

async function verifyCI(contract, candidate, token) {
  const row = await requestJSON(token, [
    'api', `repos/${contract.repository}/actions/runs/${candidate.ci_run_id}`,
  ], 'GitHub CI');
  if (row?.status !== 'completed' || row?.conclusion !== 'success'
    || row?.event !== 'workflow_dispatch' || row?.head_branch !== 'main'
    || row?.head_sha !== candidate.source_sha
    || row?.display_title !== workflowDisplayTitle(contract.ciTitle, 'ci')
    || !String(row?.path || '').endsWith(`.github/workflows/${workflowFile(contract.ciWorkflow)}`)) {
    throw new Error('Release来源不是同产品端成功CI');
  }
}

function decodeRetry(contract, environment) {
  const encoded = String(environment.PRODUCT_RELEASE_RETRY_CONTEXT || '');
  if (!encoded) return null;
  let value;
  try { value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
  catch { throw new Error('Release重试候选编码无效'); }
  const runtime = contract.sourceKind === 'spec';
  if (!value || value.product_id !== contract.productId || value.workflow !== contract.workflow
    || value.software_flow !== 'release'
    || (!runtime && value.platform !== contract.platform)
    || (runtime && Object.hasOwn(value, 'platform'))
    || !shaPattern.test(String(value.source_sha || ''))
    || !Number.isSafeInteger(value.ci_run_id) || value.ci_run_id <= 0
    || !(value.run_id === null || Number.isSafeInteger(value.run_id) && value.run_id > 0)
    || value.version_tag !== contract.tagPrefix
      + (runtime ? value.spec_version : value.software_version)) {
    throw new Error('Release重试候选与当前产品端不一致');
  }
  return value;
}

async function freshCandidate(contract, environment, ci) {
  if (contract.sourceKind === 'spec') {
    const current = Number(environment.PRODUCT_RELEASE_BASE_SPEC_VERSION);
    const specVersion = Number(environment.PRODUCT_RELEASE_SPEC_VERSION);
    if (!Number.isSafeInteger(current) || current < 0 || current >= 0xffff_ffff
      || !Number.isSafeInteger(specVersion) || specVersion !== current + 1) {
      throw new Error('Release规格版本上下文无效');
    }
    const source = await repositoryFile(contract, ci.sourceSHA, environment.GH_TOKEN);
    const versions = [...source.matchAll(/^\s*spec_version:\s*([0-9]+)\s*,\s*$/gmu)];
    if (versions.length !== 1 || ![current, current + 1].includes(Number(versions[0][1]))) {
      throw new Error('成功CI源码Runtime与finalized链版本差值不是0或1');
    }
    return {
      product_id: contract.productId, software_flow: 'release',
      software_version: null, source_sha: ci.sourceSHA, spec_version: specVersion,
      workflow: contract.workflow, ci_run_id: ci.runId, run_id: null,
      version_tag: contract.tagPrefix + specVersion,
    };
  }
  const seed = contract.sourceKind === 'literal'
    ? contract.sourcePath
    : sourceVersion(contract.sourceKind,
      await repositoryFile(contract, ci.sourceSHA, environment.GH_TOKEN));
  const version = nextSemantic(seed, await releaseVersions(contract, environment.GH_TOKEN));
  return {
    product_id: contract.productId, software_flow: 'release',
    software_version: version, source_sha: ci.sourceSHA, spec_version: null,
    workflow: contract.workflow, platform: contract.platform,
    ci_run_id: ci.runId, run_id: null, version_tag: contract.tagPrefix + version,
  };
}

// 每次新启动都先选择同仓库、同产品、同平台的最新成功 CI；持久候选只有
// 与该 CI 的 Run ID 和源码同时一致时才可用于同源重试。
export async function selectReleaseCandidate(contract, environment, {
  findCI = latestSuccessfulCI, createFresh = freshCandidate,
} = {}) {
  const previous = decodeRetry(contract, environment);
  const ci = await findCI(contract, environment.GH_TOKEN);
  if (previous?.ci_run_id === ci.runId && previous.source_sha === ci.sourceSHA) {
    return previous;
  }
  return createFresh(contract, environment, ci);
}

function releaseControlLines(environment) { return createControl(environment); }
function closeReleaseControl(control) { closeControl(control); }
export async function readReleaseControlFrame(control) { return nextControl(control); }

async function persistCandidate(candidate, control, output) {
  const encoded = Buffer.from(JSON.stringify(candidate), 'utf8').toString('base64');
  output.write(`PRODUCT_RELEASE_CANDIDATE:${encoded}\n`);
  if (control.hosted && await readReleaseControlFrame(control, 'Release候选')
    !== 'PRODUCT_RELEASE_CANDIDATE_ACCEPTED') {
    throw new Error('宿主未确认Release候选');
  }
}

async function remoteRun(contract, runId, token) {
  const row = await requestJSON(token, [
    'api', `repos/${contract.repository}/actions/runs/${runId}`,
  ], 'GitHub Release Run');
  if (row?.id !== runId || row?.event !== 'workflow_dispatch'
    || row?.head_branch !== 'main'
    || row?.html_url !== `https://github.com/${contract.repository}/actions/runs/${runId}`
    || row?.display_title !== workflowDisplayTitle(contract.title,'release')
    || !String(row?.path||'').endsWith('.github/workflows/'+workflowFile(contract.workflow))) {
    throw new Error('Release重试Run身份无效');
  }
  return row;
}

async function verifyFormalRelease(contract, candidate, token) {
  const route=currentDeclaration().remote_routes.find(row=>row.canonicalID===contract.workflow);
  if(route?.recordsFormalRelease)return formalReleaseRecord(contract.platform,candidate.version_tag,{candidate});
  const release=await requestJSON(token,['api',`repos/${contract.repository}/releases/tags/${encodeURIComponent(candidate.version_tag)}`],'GitHub正式Release');
  if(release?.tag_name!==candidate.version_tag||release.draft!==false||release.prerelease!==false
    ||!Array.isArray(release.assets)||!release.assets.length||!release.published_at)throw Error('GitHub正式Release未形成完整终态');
  return null;
}

export async function runRelease(input, environment = process.env, output = process.stdout) {
  const contract = checkedContract(input);
  if (contract.repository !== repositoryName || contract.productId !== productID) throw Error('Release产品归属无效');
  const control = releaseControlLines(environment);
  try {
    let candidate = await selectReleaseCandidate(contract, environment);
    await verifyCI(contract, candidate, environment.GH_TOKEN);
    let remote = null;
    if (candidate.run_id !== null) {
      const existing = await remoteRun(contract, candidate.run_id, environment.GH_TOKEN);
      if (existing.status !== 'completed' || existing.conclusion === 'success') {
        remote = Object.freeze({
          repository: contract.repository, workflow: contract.workflow,
          runId: candidate.run_id,
          url: `https://github.com/${contract.repository}/actions/runs/${candidate.run_id}`,
        });
      } else {
        candidate = { ...candidate, run_id: null };
      }
    }
    await persistCandidate(candidate, control, output);
    if (!remote) {
      const inputs = {
        source_sha: candidate.source_sha,
        ci_run_id: String(candidate.ci_run_id),
        version_tag: candidate.version_tag,
      };
      if (candidate.software_version !== null) inputs.software_version = candidate.software_version;
      if (candidate.spec_version !== null) {
        inputs.spec_version = String(candidate.spec_version);
      }
      for (const [name, value] of Object.entries(environment)) {
        if (!name.startsWith('PRODUCT_RELEASE_INPUT_')) continue;
        const inputName = name.slice('PRODUCT_RELEASE_INPUT_'.length).toLowerCase();
        if (!/^[a-z][a-z0-9_]*$/u.test(inputName) || Object.hasOwn(inputs, inputName)
          || typeof value !== 'string' || value.length > 4096 || /[\u0000\r\n]/u.test(value)) {
          throw new Error('Release附加输入无效');
        }
        inputs[inputName] = value;
      }
      remote = await createWorkflowRun({
        token: environment.GH_TOKEN, repository: contract.repository,
        workflow: contract.workflow, title: contract.title, flow: 'release',
        inputs,
      });
      candidate = { ...candidate, run_id: remote.runId };
      await persistCandidate(candidate, control, output);
    }
    output.write(`PRODUCT_REMOTE_RUN:${workflowRunReceipt(remote)}\n`);
    if (control.hosted && await readReleaseControlFrame(control, 'Release Run绑定')
      !== `PRODUCT_REMOTE_RUN_ACCEPTED:${remote.runId}`) {
      throw new Error('宿主未确认Release Run绑定');
    }
    const terminal = control.hosted ? await readReleaseControlFrame(control, 'Release终态')
      : `PRODUCT_REMOTE_RESULT:${remote.runId}:${await waitRemote(remote)}`;
    const success = terminal === `PRODUCT_REMOTE_RESULT:${remote.runId}:success`;
    if (!success && terminal !== `PRODUCT_REMOTE_RESULT:${remote.runId}:failed`) {
      throw new Error('宿主返回了无效Release结果');
    }
    if (success) await verifyFormalRelease(contract, candidate, environment.GH_TOKEN);
    await pruneGitHubRuns({ repository: contract.repository, canonicalId: contract.workflow,
      currentRunId: remote.runId, result: success ? 'success' : 'failed' });
    if (!success) throw new Error('Release失败');
    return Object.freeze({ remote, candidate });
  } finally {
    // 中文注释：成功、失败和准备异常均关闭 fd3，让父任务收到子进程退出并保存终态。
    closeReleaseControl(control);
  }
}

export {
  checkedContract as validateReleaseContract,
  nextSemantic as nextReleaseVersion,
  sourceVersion as releaseSourceVersion,
};

function retentionRoute(repository,identity) {
 if(repository!==repositoryName)throw Error('产品记录保留越仓');
 const pieces=identity.split('.'),contract=remoteContract(pieces[2],pieces[1]);
 if(contract.workflow!==identity)throw Error('产品记录保留身份无效');
 return {canonicalId:identity,flow:pieces[2],title:contract.title};
}
function workflowRunIdentityMatches(value, route) {
  return typeof value === 'string'
    && value === (route.flow ? workflowDisplayTitle(route.title, route.flow) : route.title);
}

// 仅处理由已登记身份识别的终态；文件名不另分保留组，未知标题不猜测归属。
export function githubRetentionRecord(row, repository, canonicalId) {
  const route = retentionRoute(repository, canonicalId);
  if (!route.flow) return null;
  const events = ['workflow_dispatch'];
  const identityMatches = workflowRunIdentityMatches(row.display_title, route);
  if (!identityMatches || row.head_branch !== 'main'
      || !String(row.path || '').endsWith(`.github/workflows/${workflowFile(canonicalId)}`)
      || !events.includes(row.event)) return null;
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || !shaPattern.test(row.head_sha)
      || row.run_attempt !== undefined && (!Number.isSafeInteger(row.run_attempt) || row.run_attempt <= 0)
      || !Number.isFinite(Date.parse(row.created_at))
      || typeof row.status !== 'string' || !row.status) throw new Error('GitHub记录身份无效');
  if (row.status === 'completed' && (typeof row.conclusion !== 'string' || !row.conclusion)) {
    throw new Error('GitHub终态缺少结论');
  }
  return { canonicalId, attempt: row.run_attempt ?? 1, workflow: row.path, sha: row.head_sha, id: String(row.id).padStart(20, '0'), startedAt: new Date(row.created_at).toISOString(),
    active: row.status !== 'completed',
    result: row.status === 'completed' && row.conclusion === 'success' ? 'success' : 'failed' };
}

export async function pruneGitHubRuns({ repository, canonicalId, currentRunId = null,
  result = null, request = retentionRequest }) {
  const route = retentionRoute(repository, canonicalId);
  if (result !== null && !['success', 'failed'].includes(result)) throw new Error('清理结果无效');
  if (currentRunId !== null && (!Number.isSafeInteger(currentRunId) || currentRunId <= 0
      || !['success', 'failed'].includes(result))) throw new Error('当前任务清理身份无效');
  const prefix = `repos/${repository}/actions`;
  if (currentRunId !== null) {
    const current = await request(`${prefix}/runs/${currentRunId}`);
    const record = current && githubRetentionRecord(current, repository, canonicalId);
    if (!record || record.active || record.result !== result) throw new Error('当前GitHub任务未取得匹配终态');
  }
  const rows = [];
  for (let page = 1; ; page++) {
    // GitHub带branch/event等搜索条件只返回最多1000条；必须无筛选完整分页后本地验证身份。
    const response = await request(`${prefix}/runs?per_page=100&page=${page}`);
    if (!response || !Array.isArray(response.workflow_runs) || response.workflow_runs.length > 100) {
      throw new Error('GitHub记录分页无效');
    }
    for (const row of response.workflow_runs) {
      const record = githubRetentionRecord(row, repository, canonicalId);
      if (record && (route.repositoryPush || result === null || record.result === result)) rows.push(record);
    }
    if (response.workflow_runs.length < 100) break;
    if (page >= 1000) throw new Error('GitHub记录超出安全扫描范围，未删除任何记录');
  }
  if (currentRunId !== null && !rows.some(row => Number(row.id) === currentRunId)) {
    throw new Error('GitHub分页尚未包含当前终态，清理未完成');
  }
  const retained = retainedRecords(rows, { state: row => row.result, protected: row => row.active });
  const keep = new Set(retained.map(row => row.id));
  const removed = [];
  for (const row of rows.filter(row => !keep.has(row.id))) {
    const winner = retained.find(value => value.result === row.result && !value.active);
    const runId = Number(row.id), winnerId = Number(winner.id);
    // 每次删除前重新确认胜出记录存在且较新；被重跑的旧Run不是可删除终态。
    const verify = async () => {
      const newest = await request(`${prefix}/runs/${winnerId}`);
      const currentWinner = newest && githubRetentionRecord(newest, repository, canonicalId);
      if (!currentWinner || currentWinner.active || currentWinner.result !== row.result
          || currentWinner.startedAt !== winner.startedAt
          || currentWinner.attempt !== winner.attempt || currentWinner.workflow !== winner.workflow
          || currentWinner.sha !== winner.sha) {
        throw new Error('保留任务状态变化，停止清理');
      }
      const old = await request(`${prefix}/runs/${runId}`);
      if (old === null) return false;
      const checked = githubRetentionRecord(old, repository, canonicalId);
      if (!checked || checked.active || checked.result !== row.result || checked.startedAt !== row.startedAt
          || checked.attempt !== row.attempt || checked.workflow !== row.workflow || checked.sha !== row.sha) {
        throw new Error('旧任务状态变化，停止清理');
      }
      return true;
    };
    if (!await verify()) continue;
    for (;;) {
      const assets = await request(`${prefix}/runs/${runId}/artifacts?per_page=100`);
      if (assets === null) break;
      if (!Number.isSafeInteger(assets.total_count) || !Array.isArray(assets.artifacts)) {
        throw new Error('GitHub任务产物列表无效');
      }
      if (assets.total_count === 0) break;
      if (!assets.artifacts.length) throw new Error('GitHub任务产物分页未前进');
      for (const asset of assets.artifacts) {
        if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error('GitHub产物编号无效');
        if (!await verify()) break;
        await request(`${prefix}/artifacts/${asset.id}`, 'DELETE');
        if (await request(`${prefix}/artifacts/${asset.id}`) !== null) throw new Error('GitHub产物删除未确认');
      }
    }
    if (!await verify()) continue;
    await request(`${prefix}/runs/${runId}`, 'DELETE');
    if (await request(`${prefix}/runs/${runId}`) !== null) throw new Error('GitHub任务删除未确认');
    removed.push(runId);
  }
  return removed;
}

// 本产品远端记录共用同一选择器；只按完整流程身份保留成功、失败与活动Run。
// 以任务开始顺序而非完成通知顺序选最新，防止旧任务迟到覆盖新任务。
export function retainedRecords(records, {
  key = row => row.canonicalId,
  id = row => String(row.id),
  state = row => row.result,
  order = row => row.startedAt,
  protected: isProtected = row => row.active === true || row.protected === true,
} = {}) {
  const rows = Array.from(records);
  const seen = new Set(), latest = new Map(), keep = new Set();
  for (const row of rows) {
    const identity = key(row), identifier = id(row), result = state(row);
    // 活动任务尚无结论时继续保护，不能因另一任务完成而删除或使其收尾失败。
    const pending = row.active === true && result === null;
    if (typeof identity !== 'string' || !identity || typeof identifier !== 'string'
        || !identifier || (!pending && (typeof result !== 'string' || !result))) {
      throw new Error('记录保留身份或状态无效');
    }
    const unique = JSON.stringify([identity, identifier]);
    if (seen.has(unique)) throw new Error('记录保留输入含重复任务');
    seen.add(unique);
    if (pending || isProtected(row) || !['success', 'failed'].includes(result)) {
      keep.add(row);
      continue;
    }
    const started = order(row);
    if (typeof started !== 'string' || !started) throw new Error('记录缺少稳定任务顺序');
    const group = JSON.stringify([identity, result]);
    const previous = latest.get(group);
    const newerID = previous && (/^\d+$/.test(identifier) && /^\d+$/.test(previous.identifier)
      ? BigInt(identifier) > BigInt(previous.identifier) : identifier > previous.identifier);
    if (!previous || started > previous.started
        || (started === previous.started && newerID)) {
      latest.set(group, { row, started, identifier });
    }
  }
  for (const { row } of latest.values()) keep.add(row);
  return rows.filter(row => keep.has(row));
}



function sourceIdentity(platform,flow) {
 const value=currentDeclaration(),files=['scripts/flows.json','scripts/flow.mjs','scripts/build.mjs','scripts/resources.mjs',value.platforms[platform]?.[flow]?.entry];
 if(flow==='release')files.push(value.platforms[platform]?.ci?.entry);
 return files.map(file=>[file,createHash('sha256').update(sourceFile(file)).digest('hex')]);
}
export async function executeRemote(flow,platform,{environment=process.env,signal,fetchImpl,output=process.stdout}={}) {
 const before=JSON.stringify(sourceIdentity(platform,flow)),contract=remoteContract(flow,platform);
 const context={signal,token:environment.GH_TOKEN,fetchImpl,verifySource:()=>{
  if(JSON.stringify(sourceIdentity(platform,flow))!==before)throw Error('产品流程源码在执行期间改变');
 }};
 return operation.run(context,async()=>{
  const actual={...environment};
  
  try {
   const result=flow==='ci'?await runCI(contract,actual,output):await runRelease(contract,actual,output);
   context.verifySource();return result;
  } catch(error) {
   // 独立调用取消后只取消本轮已绑定Run；宿主调用的取消由原任务继续负责。
   if(signal?.aborted&&context.remote&&environment.PRODUCT_CONTROL_FD===undefined) {
    await operation.run({...context,signal:undefined},async()=>{
     await apiRequest(`repos/${repositoryName}/actions/runs/${context.remote.runId}/cancel`,{method:'POST'});
     for(let n=0;n<6;n++){
      const row=JSON.parse(await apiRequest(`repos/${repositoryName}/actions/runs/${context.remote.runId}`));
      if(row.id!==context.remote.runId||row.html_url!==context.remote.url)throw Error('产品取消Run回读身份无效');
      if(row.status==='completed')return;
      await delay(5000);
     }
     throw Error('产品取消Run退出未确认');
    });
   }
   throw error;
  }
 });
}

export async function recoverRemote(flow,platform,runId,result,{environment=process.env,signal,fetchImpl}={}) {
 if(!Number.isSafeInteger(runId)||runId<=0||!['success','failed'].includes(result))throw Error('产品恢复任务身份无效');
 const contract=remoteContract(flow,platform),before=JSON.stringify(sourceIdentity(platform,flow));
 const verifySource=()=>{if(JSON.stringify(sourceIdentity(platform,flow))!==before)throw Error('产品恢复期间源码变化');};
 return operation.run({signal,fetchImpl,token:environment.GH_TOKEN,verifySource},async()=>{
  let formal=null;
  if(flow==='release'){
   const candidate=decodeRetry(contract,environment);
   if(!candidate||candidate.run_id!==runId)throw Error('产品恢复Run与正式候选不一致');
   const remote=await remoteRun(contract,runId,environment.GH_TOKEN);
   if(remote.status!=='completed'||(remote.conclusion==='success'?'success':'failed')!==result)throw Error('产品恢复Run终态不一致');
   await verifyCI(contract,candidate,environment.GH_TOKEN);
   if(result==='success'){
    formal=await verifyFormalRelease(contract,candidate,environment.GH_TOKEN);
    if(formal){if(!Number.isSafeInteger(remote.run_number)||remote.run_number<=0)throw Error('产品恢复Run序号无效');formal.run_number=remote.run_number;}
   }
  }
  const removed=await pruneGitHubRuns({repository:contract.repository,canonicalId:contract.workflow,currentRunId:runId,result});
  verifySource();return {removed_run_ids:removed,formal_release:formal};
 });
}

// 软件记录刷新与流程收尾共用本产品保留器；宿主只消费公开记录，不解释产品正式资产。
export function recordSourceContract(platform) {
 const value=currentDeclaration(),route=value.remote_routes.find(row=>row.canonicalID===productID+'.'+platform+'.release');
 remoteContract('release',platform);
 if(!route?.recordsFormalRelease)throw Error('产品平台不提供正式版本记录');
 const policy=value.platforms[platform].release.record_source;
 if(!policy||Object.keys(policy).sort().join(',')!=='asset_names,immutable,kind,marker_prefix,metadata_asset,source_field,version_field'
  ||!['tag','body','manifest'].includes(policy.kind)||typeof policy.immutable!=='boolean'
  ||!Array.isArray(policy.asset_names)||policy.asset_names.length>16||new Set(policy.asset_names).size!==policy.asset_names.length
  ||policy.asset_names.some(name=>typeof name!=='string'||! /^[A-Za-z0-9._-]{1,128}$/u.test(name))
  ||policy.marker_prefix!==null&&! /^[A-Z][A-Z0-9_]{0,31}$/u.test(policy.marker_prefix)
  ||policy.kind==='manifest'&&(! /^[A-Za-z0-9._-]{1,128}$/u.test(policy.metadata_asset)
   ||! /^[a-z][a-z0-9_]{0,63}$/u.test(policy.source_field)||! /^[a-z][a-z0-9_]{0,63}$/u.test(policy.version_field))
  ||policy.kind!=='manifest'&&[policy.metadata_asset,policy.source_field,policy.version_field].some(value=>value!==null)
  ||policy.kind==='body'&&(!policy.marker_prefix||!policy.asset_names.length))throw Error('产品正式记录来源合同无效');
 return policy;
}
function formalMarker(body,name,pattern,{line=false,required=true}={}) {
 if(typeof body!=='string'||Buffer.byteLength(body)>128*1024)throw Error('正式版本正文超限');
 if(!required&&!body.includes(name+':'))return null;
 const matches=[...body.matchAll(new RegExp(name+':('+pattern+')(?=\\s|$)','gu'))];
 if(matches.length!==1||line&&(body.split(/\r?\n/u).filter(value=>value.includes(name+':')).length!==1
  ||!body.split(/\r?\n/u).includes(name+':'+matches[0][1])))throw Error('正式版本正文身份标记无效');
 return matches[0][1];
}
export function validateFormalRecordSource(platform,release,tagSHA,metadata=null) {
 const policy=recordSourceContract(platform),contract=remoteContract('release',platform);
 const tag=release?.tag_name,version=typeof tag==='string'&&tag.startsWith(contract.tagPrefix)?tag.slice(contract.tagPrefix.length):'';
 if(! /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)||!shaPattern.test(tagSHA)
  ||release.draft!==false||release.prerelease!==false||policy.immutable&&release.immutable!==true)throw Error('正式版本记录身份无效');
 if(policy.kind==='tag')return tagSHA;
 if(release.name!==contract.title||!Array.isArray(release.assets))throw Error('正式版本记录标题或资产无效');
 if(policy.asset_names.length&&(release.assets.length!==policy.asset_names.length
  ||release.assets.map(asset=>asset.name).sort().join(',')!==[...policy.asset_names].sort().join(',')
  ||release.assets.some(asset=>!Number.isSafeInteger(asset.id)||asset.id<=0||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.state!=='uploaded')))throw Error('正式版本记录资产闭集无效');
 const body=release.body??'';
 if(policy.kind==='body') {
  if(! /^[0-9]+\.[0-9]{1,2}\.[0-9]{1,2}$/u.test(version))throw Error('正式版本记录版本超界');
  for(const suffix of ['CI_RUN_ID','RUN_ID'])formalMarker(body,policy.marker_prefix+'_RELEASE_'+suffix,'[1-9][0-9]*',{line:policy.immutable});
  if(formalMarker(body,policy.marker_prefix+'_RELEASE_SOURCE_SHA','[0-9a-f]{40}',{line:policy.immutable})!==tagSHA)throw Error('正式版本正文与Tag源码不一致');
  return tagSHA;
 }
 if(!metadata||metadata.product_id!==productID||metadata[policy.version_field]!==version
  ||!shaPattern.test(metadata[policy.source_field]))throw Error('正式版本元数据产品、版本或源码无效');
 const source=metadata[policy.source_field];
 if(policy.marker_prefix&&formalMarker(body,policy.marker_prefix+'_RELEASE_SOURCE_SHA','[0-9a-f]{40}',{required:false})!==null
  &&formalMarker(body,policy.marker_prefix+'_RELEASE_SOURCE_SHA','[0-9a-f]{40}')!==source)throw Error('正式版本正文与元数据源码不一致');
 return source;
}
async function formalTagSHA(tag) {
 if(typeof tag!=='string'||! /^[a-z0-9-]+-v[0-9]+\.[0-9]+\.[0-9]+$/u.test(tag))throw Error('正式版本Tag无效');
 const value=JSON.parse(await apiRequest(`repos/${repositoryName}/git/ref/tags/${encodeURIComponent(tag)}`));
 if(value.ref!==`refs/tags/${tag}`)throw Error('正式版本Tag引用不一致');
 let object=value.object;
 if(object?.type==='tag') {
  if(!shaPattern.test(object.sha))throw Error('正式版本注解Tag无效');
  object=JSON.parse(await apiRequest(`repos/${repositoryName}/git/tags/${object.sha}`)).object;
 }
 if(object?.type!=='commit'||!shaPattern.test(object.sha))throw Error('正式版本Tag未绑定准确提交');
 return object.sha;
}
async function formalMetadata(asset) {
 try {
 if(!Number.isSafeInteger(asset?.id)||asset.id<=0||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>128*1024||asset.state!=='uploaded')throw Error('正式版本元数据资产无效');
 const context=operation.getStore()||{},signal=AbortSignal.any([AbortSignal.timeout(30000),...(context.signal?[context.signal]:[])]);
 context.verifySource?.();context.signal?.throwIfAborted();
 const fetchImpl=context.fetchImpl||fetch;
 let response=await fetchImpl(`https://api.github.com/repos/${repositoryName}/releases/assets/${asset.id}`,{
  redirect:'manual',signal,headers:{Authorization:'Bearer '+context.token,Accept:'application/octet-stream','X-GitHub-Api-Version':'2026-03-10'}});
 // GitHub仅把准确资产重定向到官方HTTPS原件地址；跨主机绝不继续发送仓库令牌。
 if([302,303].includes(response.status)) {
  const target=new URL(response.headers.get('location'));
  if(target.protocol!=='https:'||target.hostname!=='release-assets.githubusercontent.com'||target.port||target.username||target.password||target.hash)throw Error('正式版本资产跳转越界');
  await response.body?.cancel();response=await fetchImpl(target.href,{redirect:'manual',signal});
 }
 if(!response.ok){await response.body?.cancel();throw Error('正式版本元数据读取失败');}
 const bytes=await boundedBody(response,128*1024);
 if(Buffer.byteLength(bytes)!==asset.size||asset.digest&&asset.digest!=='sha256:'+createHash('sha256').update(bytes).digest('hex'))throw Error('正式版本元数据尺寸或摘要不一致');
 try{return JSON.parse(bytes);}catch{throw Error('正式版本元数据格式无效');}
 }catch{operation.getStore()?.signal?.throwIfAborted();throw Error('正式版本元数据安全读取失败');}
}
export async function formalReleaseRecord(platform,tag,{candidate=null,runNumber=null}={}) {
 const value=currentDeclaration(),route=value.remote_routes.find(row=>row.canonicalID===productID+'.'+platform+'.release'),policy=recordSourceContract(platform);
 const release=JSON.parse(await apiRequest(`repos/${repositoryName}/releases/tags/${encodeURIComponent(tag)}`));
 if(!Number.isSafeInteger(release?.id)||release.id<=0||release.tag_name!==tag||Number.isNaN(Date.parse(release.published_at))
  ||release.html_url!==`https://github.com/${repositoryName}/releases/tag/${tag}`)throw Error('正式版本记录回读身份无效');
 const tagSHA=await formalTagSHA(tag);let metadata=null;
 if(policy.kind==='manifest') {
  const assets=release.assets?.filter(asset=>asset.name===policy.metadata_asset);
  if(!assets||assets.length!==1)throw Error('正式版本元数据资产不唯一');metadata=await formalMetadata(assets[0]);
 }
 const source=validateFormalRecordSource(platform,release,tagSHA,metadata);
 if(candidate&&(candidate.source_sha!==source||candidate.version_tag!==tag||candidate.product_id!==productID||candidate.platform!==platform))throw Error('恢复正式版本与原候选不一致');
 return {record_type:'github-release',repository:repositoryName,run_id:candidate?.run_id??release.id,run_number:runNumber??release.id,
  product_id:productID,product_title:route.productTitle,software_flow:'release',platform,tag,source_sha:source,tag_sha:tagSHA,
  updated_at:release.published_at,state:'success',url:release.html_url};
}
export async function querySoftwareRecords({environment=process.env,signal,fetchImpl}={}) {
 const value=currentDeclaration(),snapshot=JSON.stringify(value),before=sourceFile('scripts/flow.mjs');
 const verifySource=()=>{if(JSON.stringify(currentDeclaration())!==snapshot||!sourceFile('scripts/flow.mjs').equals(before))throw Error('软件记录读取期间产品来源改变');};
 return operation.run({signal,fetchImpl,token:environment.GH_TOKEN,verifySource},async()=>{
  const removed=[],records=[];
  for(const route of value.remote_routes){remoteContract(route.flow,route.platform);removed.push(...await pruneGitHubRuns({repository:repositoryName,canonicalId:route.canonicalID}));}
  const rows=[];
  for(let page=1;;page++) {
   const response=JSON.parse(await apiRequest(`repos/${repositoryName}/actions/runs?per_page=100&page=${page}`));
   if(!Array.isArray(response.workflow_runs)||response.workflow_runs.length>100)throw Error('软件记录Run分页无效');rows.push(...response.workflow_runs);
   if(response.workflow_runs.length<100)break;if(page>=1000)throw Error('软件记录Run超过有界扫描范围');
  }
  for(const route of value.remote_routes)for(const row of rows) {
   const bound=githubRetentionRecord(row,repositoryName,route.canonicalID);if(!bound||bound.active)continue;
   if(!Number.isSafeInteger(row.run_number)||row.run_number<=0||Number.isNaN(Date.parse(row.updated_at))||!shaPattern.test(row.head_sha))throw Error('软件记录Run字段无效');
   records.push({record_type:'workflow',repository:repositoryName,run_id:row.id,run_number:row.run_number,product_id:productID,
    product_title:route.productTitle,software_flow:route.flow,platform:route.platform,tag:row.display_title.match(/[a-z0-9-]+-v[0-9]+\.[0-9]+\.[0-9]+/u)?.[0]??null,
    updated_at:row.updated_at,source_sha:row.head_sha,state:bound.result,url:row.html_url});
  }
  // 不删除正式资产或Tag；选择各平台最新候选后按本仓合同完整回读。
  const releases=[];
  for(let page=1;;page++) {
   const rows=JSON.parse(await apiRequest(`repos/${repositoryName}/releases?per_page=100&page=${page}`));
   if(!Array.isArray(rows)||rows.length>100)throw Error('软件记录Release分页无效');releases.push(...rows);
   if(rows.length<100)break;if(page>=1000)throw Error('软件记录Release超过有界扫描范围');
  }
  const candidates=[];
  for(const release of releases) {
   if(release.draft!==false||release.prerelease!==false)continue;
   const route=value.remote_routes.find(row=>row.recordsFormalRelease&&typeof release.tag_name==='string'&&release.tag_name.startsWith(row.tagPrefix)
    &&/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(release.tag_name.slice(row.tagPrefix.length)));
   if(!route)continue;if(!Number.isSafeInteger(release.id)||release.id<=0||Number.isNaN(Date.parse(release.published_at)))throw Error('正式版本候选字段无效');
   candidates.push({canonicalId:route.canonicalID,id:String(release.id),active:false,result:'success',startedAt:release.published_at,platform:route.platform,tag:release.tag_name});
  }
  for(const candidate of retainedRecords(candidates))records.push(await formalReleaseRecord(candidate.platform,candidate.tag));
  for(const route of value.remote_routes){const matching=rows.map(row=>githubRetentionRecord(row,repositoryName,route.canonicalID)).filter(Boolean);
   if(retainedRecords(matching).length!==matching.length)throw Error('软件记录远端保留未形成唯一回读');}
  verifySource();records.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  if(new Set(removed).size!==removed.length||removed.some(id=>records.some(record=>record.record_type==='workflow'&&record.run_id===id)))throw Error('软件记录清理回执不一致');
  const result={records,removed_run_ids:removed};if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw Error('软件记录结果超过公开回执限制');return result;
 });
}
if(!(process.env.NODE_TEST_CONTEXT && process.argv.length === 2)&&!process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [command,flow,platform,...extra]=process.argv.slice(2);
 const recovering=command==='recover',records=command==='records';
 if(records?(flow!==undefined||platform!==undefined||extra.length):command!=='run'&&!recovering||!recovering&&extra.length||recovering&&(extra.length!==4||extra[0]!=='--run-id'||extra[2]!=='--result'||! /^[1-9][0-9]*$/u.test(extra[1])||!['success','failed'].includes(extra[3])))throw Error('产品远端固定入口参数无效');
 if(records)currentDeclaration();else remoteContract(flow,platform);
 const session=claimFixedWork('build'),work=session.owner.work,cancellation=new AbortController();let unconfirmed=false;
 for(const event of ['SIGTERM','SIGINT'])process.once(event,()=>cancellation.abort());
 try {
  const names=['HOME','USER','LOGNAME','LANG','LC_ALL','PRODUCT_TOOL_ROOT','PRODUCT_DEPENDENCY_ROOT','PRODUCT_CONTROL_FD','PRODUCT_RELEASE_RETRY_CONTEXT','GH_TOKEN',
   'PRODUCT_CHAIN_URL','PRODUCT_CHAIN_ACCESS_CLIENT_ID','PRODUCT_CHAIN_ACCESS_CLIENT_SECRET','PRODUCT_CHAIN_GENESIS_HASH'];
  const environment=Object.fromEntries(names.filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
  if(records)delete environment.PRODUCT_CONTROL_FD;
  const options={signal:cancellation.signal,environment:{...environment,PRODUCT_WORK_LEASE:session.owner.nonce}};const node=await bootstrapNode(work,options);
  const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  if(digest(node.path)!==digest(process.execPath)) {
   const args=records?[command]:[command,flow,platform,...extra];
   const response=await runBuildProcess(node.path,[fileURLToPath(import.meta.url),...args],environment,root,
    {signal:cancellation.signal,passHost:environment.PRODUCT_CONTROL_FD==='3',capture:recovering||records,streamError:recovering||records,timeout:21600000});
   if(recovering||records)process.stdout.write(response.stdout);
  }else if(records)process.stdout.write(JSON.stringify(await querySoftwareRecords({environment,signal:cancellation.signal}))+'\n');
  else if(recovering)process.stdout.write(JSON.stringify(await recoverRemote(flow,platform,Number(extra[1]),extra[3],{environment,signal:cancellation.signal})));
  else await executeRemote(flow,platform,{environment,signal:cancellation.signal});
 }catch(error){unconfirmed=String(error.message).includes('退出未确认');process.stderr.write(String(error.message)+'\n');process.exitCode=1;}
 finally{releaseFixedWork(session,{unsafe:unconfirmed});}
}

// 正式实现结束；仅直接使用 node --test 执行本文件时注册以下回归。
if (process.env.NODE_TEST_CONTEXT && process.argv.length === 2 && !process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const {BUILD_SHELL_SOURCES} = await import('./build.mjs');
// 本产品远端正常、失败、身份、候选与控制边界；全部远端数据用真实Response夹具注入。
const nextReleaseVersion=nextSemantic,releaseSourceVersion=sourceVersion;
const {default: assert} = await import('node:assert/strict');
const {default: test} = await import('node:test');
const {readFileSync,readdirSync} = await import('node:fs');
const {dirname,resolve,join} = await import('node:path');
const {fileURLToPath} = await import('node:url');
const {spawn} = await import('node:child_process');

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
 // 错误标签只需表达不同产品身份，不引入额外协议版本名称。
 assert.throws(()=>validateFormalRecordSource(route.platform,{...release,tag_name:'foreign-release'},sourceSHA,metadata));
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

// 公开Workflow和Job的真实文件只由所属产品本仓检查，不依赖其它仓检出。
test('本仓声明、实际Workflow与准确主Job写权限闭合', async () => {
 const { readdirSync, lstatSync } = await import('node:fs');
 const expected=['tatagate.yml',...routes.map(route=>route.canonicalID.replaceAll('.','-')+'.yml')].sort();
 assert.deepEqual(readdirSync(join(root,'.github/workflows')).sort(),expected);
 assert.equal(declaration.product_id,"citizensdk");
 assert.equal(declaration.entry,'scripts/build.mjs');
 for(const route of routes){
  const entry=declaration.platforms[route.platform]?.[route.flow]?.entry;
  assert.equal(entry,'.github/workflows/'+route.canonicalID.replaceAll('.','-')+'.yml');
  const file=join(root,entry),info=lstatSync(file);assert.ok(info.isFile()&&!info.isSymbolicLink());
  const source=readFileSync(file,'utf8');
  assert.ok(Buffer.byteLength(source)<500000,route.canonicalID);
  assert.ok(source.includes('name: '+route.canonicalID));
  assert.ok(source.includes('allowed=new Set(["'+route.canonicalID+'"])'));
  assert.match(source,/^  flow:$/mu);
  if(route.flow==='release'){
   const main=source.match(/^  flow:\n([\s\S]*?)(?=^  [A-Za-z_][\w-]*:|$(?![\s\S]))/mu);
   assert.ok(main,route.canonicalID);assert.match(main[1],/^      contents: write$/mu,route.canonicalID);
  }
 }
});
test('本仓远端作业在唯一模块内维护实现与回归',()=>{
 for(const group of ['ci','release']){
  const directory=join(root,'scripts',group);
  assert.deepEqual(readdirSync(directory).sort(),['index.mjs','sdk.mjs']);
  for(const file of ['index.mjs','sdk.mjs']){
   const source=readFileSync(join(directory,file),'utf8');assert.match(source,/NODE_TEST_CONTEXT/u);assert.match(source,/\btest\(/u);
  }
 }
});

test('本SDK独立入口声明自己的Rust工具和Cargo锁',()=>{
 assert.equal(declaration.entry,'scripts/build.mjs');
 assert.ok(declaration.platforms.sdk.tools.some(tool=>tool.id==='rust'));
 assert.ok(declaration.platforms.sdk.locks.some(lock=>lock.ecosystem==='cargo'));
});

}
