#!/usr/bin/env node
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
 if(readGit(root,['rev-parse','--show-toplevel'])!==root||readGit(root,['branch','--show-current'])!=='main')fail('正式 main 检出身份无效');
 if(readGit(root,['remote','get-url','origin'])!=='https://github.com/crcfrcn/citizensdk.git')fail('HTTPS origin 不符');
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
 if(!same(names(root,'.github/workflows'),['release-sdk.yml','release-sdk.mjs']))fail('自动化文件集合无效');
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
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await repositoryGateMain(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
}
