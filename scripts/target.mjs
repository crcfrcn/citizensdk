// 本产品的固定工作根与占用生命周期；不访问邻仓或调用方临时目录。
import fs from 'node:fs';
import {dirname,join,resolve,parse,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const product=JSON.parse(fs.readFileSync(join(root,'scripts/flows.json'),'utf8')).product_id;
const sessions=new AsyncLocalStorage();
const scopes=new Set(['build','test']);
const fail=message=>{throw Error(product+' target：'+message);};
export function fixedWork(scope){if(!scopes.has(scope))fail('工作根用途无效');return join(root,'target',scope);}
function directory(path,create=false){
 let at=parse(path).root;
 for(const part of relative(at,path).split(sep)){
  at=join(at,part);
  if(create&&!fs.existsSync(at))try{fs.mkdirSync(at,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const value=fs.lstatSync(at);if(!value.isDirectory()||value.isSymbolicLink()||fs.realpathSync(at)!==at)fail('工作目录经过链接或非目录');
 }
 return fs.lstatSync(path);
}
export function checkFixedWork(work,{create=false}={}){
 if(typeof work!=='string'||![fixedWork('build'),fixedWork('test')].includes(work))fail('工作根只允许本产品target/build或target/test固定目录');
 directory(work,create);return work;
}
export function checkScratchPath(path){
 if(typeof path!=='string'||resolve(path)!==path||![fixedWork('build'),fixedWork('test')].some(work=>path===work||path.startsWith(work+sep)))fail('内部物化目录越出本产品固定工作根');
 directory(path);return path;
}
export function fixedScratch(prefix){
 const path=resolve(prefix.replace(/-$/,''));checkScratchPath(dirname(path));
 fs.mkdirSync(path,{mode:0o700});return directory(path)&&path;
}
export function assertTargetTopology(){
 const target=join(root,'target');if(!fs.existsSync(target))return;
 directory(target);
 for(const name of fs.readdirSync(target))if(!scopes.has(name))fail('target含非固定目录或根部生成文件：'+name);
 for(const name of fs.readdirSync(target))directory(join(target,name));
}
function regular(path){const value=fs.lstatSync(path);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1||value.size>65536)fail('任务标记不是准确普通文件');return value;}
function readOwner(work){const path=join(work,'.active.json');if(!fs.existsSync(path))return null;regular(path);let value;try{value=JSON.parse(fs.readFileSync(path,'utf8'));}catch{fail('任务标记损坏，禁止清场');}
 if(value.schema!==1||value.product_id!==product||value.work!==work||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.nonce!=='string'||!Array.isArray(value.groups)||!value.groups.every(pid=>Number.isSafeInteger(pid)&&pid>1))fail('任务标记身份无效');return value;
}
function alive(pid,group=false){try{process.kill(group&&process.platform!=='win32'?-pid:pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}}
function writeOwner(owner){regular(join(owner.work,'.active.json'));fs.writeFileSync(join(owner.work,'.active.json'),JSON.stringify(owner)+'\n',{mode:0o600});}
function writable(path){const value=fs.lstatSync(path);if(value.isDirectory()&&!value.isSymbolicLink()){if(fs.realpathSync(path)!==path)fail('清理路径漂移');fs.chmodSync(path,value.mode|0o700);for(const name of fs.readdirSync(path))writable(join(path,name));}}
function removeTree(path){
 const state=fs.lstatSync(path);
 if(state.isSymbolicLink()){fs.unlinkSync(path);return;}
 if(state.isDirectory()){if(fs.realpathSync(path)!==path)fail('清理目录漂移');fs.chmodSync(path,state.mode|0o700);for(const name of fs.readdirSync(path))removeTree(join(path,name));fs.rmdirSync(path);return;}
 fs.unlinkSync(path);
}
function empty(work,keep=[]){
 const before=directory(work);
 for(const name of fs.readdirSync(work)){if(keep.includes(name))continue;const path=join(work,name);removeTree(path);}
 const after=directory(work);if(before.dev!==after.dev||before.ino!==after.ino||fs.readdirSync(work).some(name=>!keep.includes(name)))fail('固定工作目录未完全清空或被替换');
}
function short(work,action){const path=join(work,'.claim.lock');try{fs.mkdirSync(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;
 const record=join(path,'owner.json');let holder=null;
 if(fs.existsSync(record)){regular(record);try{holder=JSON.parse(fs.readFileSync(record,'utf8'));}catch{fail('领取锁损坏');}}
 const active=readOwner(work);
 if(holder?(holder.work!==work||!Number.isSafeInteger(holder.pid)||alive(holder.pid)):(Date.now()-fs.lstatSync(path).mtimeMs<30000))fail('固定工作目录正在领取或收尾');
 if(active&&(alive(active.pid)||active.groups.some(pid=>alive(pid,true))))fail('固定工作目录仍有活跃进程');
 writable(path);fs.rmSync(path,{recursive:true});fs.mkdirSync(path,{mode:0o700});}
 fs.writeFileSync(join(path,'owner.json'),JSON.stringify({pid:process.pid,work})+'\n',{flag:'wx',mode:0o600});
 const before=directory(path);try{return action();}finally{const after=directory(path);if(before.dev!==after.dev||before.ino!==after.ino)fail('领取锁漂移');fs.unlinkSync(join(path,'owner.json'));fs.rmdirSync(path);}}
export function clearFixedWork(work){
 checkFixedWork(work);const session=sessions.getStore(),owner=readOwner(work);
 if(owner&&!(owner.state==='retained'&&owner.pid===process.pid)&&(!session||session.owner.work!==work||session.owner.nonce!==owner.nonce))fail('固定工作目录属于其他活跃任务');
 if(owner&&owner.groups.some(pid=>alive(pid,true)))fail('工具后代退出未确认，禁止清场');
 if(fs.existsSync(join(work,'.product-build.lock')))fail('产品编译进程仍持有守卫，禁止清场');
 short(work,()=>empty(work,owner&&!(owner.state==='retained'&&owner.pid===process.pid)?['.active.json','.claim.lock']:['.claim.lock']));
}
function remoteIdentity(env){return env.GITHUB_ACTIONS==='true'&&env.GITHUB_REPOSITORY?.split('/')[1]===product&&env.GITHUB_RUN_ID&&env.GITHUB_RUN_ATTEMPT?env.GITHUB_RUN_ID+':'+env.GITHUB_RUN_ATTEMPT+':'+env.GITHUB_JOB:null;}
export function claimFixedWork(scope,{environment=process.env,retain=false}={}){
 const work=checkFixedWork(fixedWork(scope),{create:true}),remote=remoteIdentity(environment),current=sessions.getStore();
 if(current?.owner.work===work)return {...current,nested:true};
 const token=environment.PRODUCT_WORK_LEASE;
 return short(work,()=>{
  const previous=readOwner(work);
  if(previous){
   if(token===previous.nonce&&alive(previous.pid))return {owner:previous,nested:true,retain};
   if(previous.groups.some(pid=>alive(pid,true)))fail('上轮工具进程仍运行，禁止领取');
   if(previous.state==='retained')fail('结果尚未由调用方消费，禁止覆盖');
   if(remote&&previous.remote===remote&&!alive(previous.pid)){
    const owner={...previous,pid:process.pid,state:'running',groups:[],nonce:randomUUID()};writeOwner(owner);return {owner,retain:true};
   }
   if(alive(previous.pid))fail('固定工作目录已有活跃任务');
  }
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品守卫尚未释放，禁止覆盖');
  empty(work,['.claim.lock']);
  const owner={schema:1,product_id:product,work,pid:process.pid,nonce:randomUUID(),groups:[],state:'running',remote};
  fs.writeFileSync(join(work,'.active.json'),JSON.stringify(owner)+'\n',{flag:'wx',mode:0o600});return {owner,retain};
 });
}
export function trackFixedProcess(work,pid){
 if(!pid||![fixedWork('build'),fixedWork('test')].includes(work))return;
 const owner=readOwner(work);if(!owner)return;
 if(owner.pid!==process.pid&&!(alive(owner.pid)&&process.env.PRODUCT_WORK_LEASE===owner.nonce))fail('工具进程不能写入其他任务');
 if(!owner.groups.includes(pid)){owner.groups.push(pid);writeOwner(owner);}
}
export function trackWorkProcess(pid){
 const session=sessions.getStore();if(!session||!pid)return;
 const owner=readOwner(session.owner.work);if(owner?.nonce!==session.owner.nonce)fail('任务所有权漂移');
 if(!owner.groups.includes(pid)){owner.groups.push(pid);writeOwner(owner);}
}
export function workEnvironment(environment=process.env){
 const session=sessions.getStore();if(!session)return environment;
 const work=session.owner.work,result={...environment,PRODUCT_WORK_LEASE:session.owner.nonce};
 for(const [key,name]of Object.entries({TMPDIR:'tmp',TMP:'tmp',TEMP:'tmp',CARGO_TARGET_DIR:'cargo',CARGO_HOME:'dependencies/cargo-home',npm_config_cache:'dependencies/npm',PUB_CACHE:'dependencies/pub',GRADLE_USER_HOME:'dependencies/gradle',XDG_CACHE_HOME:'cache',XDG_CONFIG_HOME:'config',CLANG_MODULE_CACHE_PATH:'cache/clang',SWIFT_MODULECACHE_PATH:'cache/swift'})){
  const supplied=result[key];
  if(supplied!==undefined&&typeof supplied!=='string')fail('可写环境目录无效：'+key);
  const local=supplied&&(resolve(supplied)===work||resolve(supplied).startsWith(work+sep));
  result[key]=local?supplied:join(work,name);directory(resolve(result[key]),true);
 }
 return result;
}
export function prepareSourceView(){
 const session=sessions.getStore();if(!session)fail('工程视图缺少固定任务');
 const project=join(session.owner.work,'source');
 if(fs.existsSync(project)){directory(project);return project;}
 const omitted=new Set(['target','node_modules','build','dist','.dart_tool','.gradle','.symlinks','Pods','ephemeral','.cache','cache','tasks','tsconfig.tsbuildinfo']);
 fs.cpSync(root,project,{recursive:true,verbatimSymlinks:true,filter:path=>path===root||(!omitted.has(path.slice(path.lastIndexOf(sep)+1))&&!['tools/shared','tools/archives','rely/objects'].some(prefix=>relative(root,path).split(sep).join('/')===prefix))});
 return directory(project)&&project;
}
export function remoteStep(source,environment=process.env,shell='bash'){
 const session=sessions.getStore();if(!session)fail('远端步骤缺少固定任务');
 const project=prepareSourceView(),work=session.owner.work,prefix=product.toUpperCase();
 const env=workEnvironment({...environment,GITHUB_WORKSPACE:project,PRODUCT_PROJECT_ROOT:project,PRODUCT_SOURCE_ROOT:root,[prefix+'_SOURCE_ROOT']:root,[prefix+'_WORK_DIR']:work,[prefix+'_PROJECT_ROOT']:project});
 const quote=value=>shell==='pwsh'?"'"+value.replaceAll("'","''")+"'":"'"+value.replaceAll("'","'\\''")+"'";
 // 包安装和前端生成在本产品工程视图进行，Rust读取原始源码并显式使用固定输出。
 let code=source.replace(/npm --prefix ([a-zA-Z0-9_./-]+)/g,(_,path)=>'npm --prefix '+quote(join(project,path)));
 code=code.replace(/node (frontend\/node_modules\/[^ \n]+)/g,(_,path)=>'node '+quote(join(project,'node',path)));
 code=code.replace(/node scripts\/([^ \n]+)/g,(_,path)=>'node '+quote(join(root,'scripts',path)));
 code=code.replaceAll('$GITHUB_WORKSPACE/scripts/','$PRODUCT_SOURCE_ROOT/scripts/').replaceAll('$env:GITHUB_WORKSPACE/scripts/','$env:PRODUCT_SOURCE_ROOT/scripts/');
 let cwd=project;
 if(/(?:^|\n)\s*(?:npm (?:ci|run|install)|flutter |dart )/.test(code))cwd=project;
 if(code.includes('fs.writeFileSync')||code.includes('.write_text(')||code.includes('.write_bytes('))cwd=project;
 for(const relative of ['node/frontend','onchina/frontend']){
  const file=join(project,relative,'package.json');if(!fs.existsSync(file))continue;
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(value.scripts?.['generate:docs']){value.scripts['generate:docs']=JSON.stringify(process.execPath)+' '+JSON.stringify(join(root,'scripts/docs.mjs'));fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
 }
 return {source:code,env,cwd};
}
export function retainWork(){const session=sessions.getStore();if(!session)fail('缺少当前任务');session.retain=true;}
export function releaseFixedWork(session,{unsafe=false}={}){
 if(session.nested)return;
 const work=session.owner.work;
 return short(work,()=>{
  const owner=readOwner(work);if(owner?.nonce!==session.owner.nonce)fail('任务所有权漂移');
  const groups=owner.groups.filter(pid=>alive(pid,true));
  if(unsafe||groups.length){writeOwner({...owner,groups,state:'unsafe'});fail('工具后代退出未确认，保留守卫并禁止任务完成');}
  if(session.retain){writeOwner({...owner,groups:[],state:owner.remote?'remote':'retained'});return;}
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品编译守卫未释放，禁止完成');
  empty(work,['.claim.lock']);
 });
}
export function withFixedWorkSync(scope,action,options={}){
 const session=claimFixedWork(scope,options);let unsafe=false;
 try{return sessions.run(session,()=>action(session.owner.work,session));}
 catch(error){unsafe=String(error?.message).includes('退出未确认');throw error;}
 finally{releaseFixedWork(session,{unsafe});}
}
export async function withFixedWork(scope,action,options={}){
 const session=claimFixedWork(scope,options);let unsafe=false;
 try{return await sessions.run(session,()=>action(session.owner.work,session));}
 catch(error){unsafe=String(error?.message).includes('退出未确认');throw error;}
 finally{releaseFixedWork(session,{unsafe});}
}
// 调用方在消费结果且产品进程退出后，只能收尾这个产品的准确固定目录。
export function finishFixedWork(work,{run_id,forceRemote=false}={}){
 checkFixedWork(work);
 return short(work,()=>{
  const owner=readOwner(work);if(owner){
   if((alive(owner.pid)&&!(owner.pid===process.pid&&owner.state==='retained'))||owner.groups.some(pid=>alive(pid,true)))fail('产品进程退出未确认');
   if(owner.remote&&!forceRemote&&owner.remote!==remoteIdentity(process.env))fail('远端任务身份不符');
  }
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品守卫尚未释放');
  if(run_id&&fs.existsSync(join(work,'build-result.json'))){regular(join(work,'build-result.json'));if(JSON.parse(fs.readFileSync(join(work,'build-result.json'),'utf8')).run_id!==run_id)fail('结果任务编号不符');}
  empty(work,['.claim.lock']);
 });
}
export function taskScope(work){checkFixedWork(work);return work===fixedWork('test')?'test':'build';}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [command,scope,run_id,...extra]=process.argv.slice(2);
 try{if(command!=='finish'||extra.length)fail('固定收尾入口参数无效');finishFixedWork(fixedWork(scope),{run_id});}
 catch(error){console.error(error.message);process.exitCode=1;}
}
