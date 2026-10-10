#!/usr/bin/env node

// 本产品独立拥有资源需求、工程准备与编译；公开回执仅提供验真资源，不提供执行命令。
import {spawn,spawnSync} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {rmSync,chmodSync,closeSync,openSync,readlinkSync,unlinkSync,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const buildTarget=await(async()=>{
const fs=await import('node:fs');
const {dirname,join,resolve,parse,relative,sep}=await import('node:path');
const {fileURLToPath,pathToFileURL}=await import('node:url');
const {randomUUID}=await import('node:crypto');
const {AsyncLocalStorage}=await import('node:async_hooks');
// 本产品的固定工作根与占用生命周期；不访问邻仓或调用方临时目录。
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const product='citizensdk';
const sessions=new AsyncLocalStorage();
const scopes=new Set(['build','test']);
const fail=message=>{throw Error(product+' target：'+message);};
function fixedWork(scope){
 if(scope==='build'||scope==='test')return join(root,'target',scope);
 if(typeof scope==='string'&&scope.startsWith('build/')){
  const platform=scope.slice(6);if(Object.hasOwn(contract.platforms,platform))return join(root,'target/build',platform);
 }
 fail('工作根用途无效');
}
function isBuildWork(work){return typeof work==='string'&&Object.keys(contract.platforms).some(platform=>work===fixedWork('build/'+platform));}
function validWork(work){return work===fixedWork('test')||isBuildWork(work);}
function directory(path,create=false){
 let at=parse(path).root;
 for(const part of relative(at,path).split(sep)){
  at=join(at,part);
  if(create&&!fs.existsSync(at))try{fs.mkdirSync(at,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const value=fs.lstatSync(at);if(!value.isDirectory()||value.isSymbolicLink()||fs.realpathSync(at)!==at)fail('工作目录经过链接或非目录');
 }
 return fs.lstatSync(path);
}
function checkFixedWork(work,{create=false}={}){
 if(typeof work!=='string'||!validWork(work))fail('工作根只允许本产品target/build或target/test固定目录');
 directory(work,create);return work;
}
function checkScratchPath(path){
 if(typeof path!=='string'||resolve(path)!==path||![fixedWork('test'),...Object.keys(contract.platforms).map(platform=>fixedWork('build/'+platform))].some(work=>path===work||path.startsWith(work+sep)))fail('内部物化目录越出本产品固定工作根');
 directory(path);return path;
}
function fixedScratch(prefix){
 const path=resolve(prefix.replace(/-$/,''));checkScratchPath(dirname(path));
 fs.mkdirSync(path,{mode:0o700});return directory(path)&&path;
}
function assertTargetTopology(){
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
// 清场由本产品确认资源供给与配方后代已经退出。
function assertSupplyExited(work){
 for(const name of ['.supply-active.json','.resource-active.json']){
  const file=join(work,name);if(!fs.existsSync(file))continue;regular(file);const record=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Number.isSafeInteger(record.pid)||record.pid<2||!Array.isArray(record.groups)||record.groups.some(pid=>!Number.isSafeInteger(pid)||pid<2))fail('资源退出记录无效');
  if((record.pid!==process.pid&&alive(record.pid))||record.groups.some(pid=>alive(pid,true)))fail('资源工具退出未确认');
 }
}
function empty(work,keep=[]){
 assertSupplyExited(work);
 const before=directory(work);
 for(const name of fs.readdirSync(work)){if(keep.includes(name))continue;const path=join(work,name);removeTree(path);}
 const after=directory(work);if(before.dev!==after.dev||before.ino!==after.ino||fs.readdirSync(work).some(name=>!keep.includes(name)))fail('固定工作目录未完全清空或被替换');
}
function short(work,action){const path=isBuildWork(work)?join(fixedWork('build'),'.claim-'+relative(fixedWork('build'),work)):join(work,'.claim.lock');try{fs.mkdirSync(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;
 const record=join(path,'owner.json');let holder=null;
 if(fs.existsSync(record)){regular(record);try{holder=JSON.parse(fs.readFileSync(record,'utf8'));}catch{fail('领取锁损坏');}}
 const active=readOwner(work);
 if(holder?(holder.work!==work||!Number.isSafeInteger(holder.pid)||alive(holder.pid)):(Date.now()-fs.lstatSync(path).mtimeMs<30000))fail('固定工作目录正在领取或收尾');
 if(active&&(alive(active.pid)||active.groups.some(pid=>alive(pid,true))))fail('固定工作目录仍有活跃进程');
 writable(path);fs.rmSync(path,{recursive:true});fs.mkdirSync(path,{mode:0o700});}
 fs.writeFileSync(join(path,'owner.json'),JSON.stringify({pid:process.pid,work})+'\n',{flag:'wx',mode:0o600});
 const before=directory(path);try{return action();}finally{const after=directory(path);if(before.dev!==after.dev||before.ino!==after.ino)fail('领取锁漂移');fs.unlinkSync(join(path,'owner.json'));fs.rmdirSync(path);}}
function clearFixedWork(work){
 checkFixedWork(work);const session=sessions.getStore(),owner=readOwner(work);
 if(owner&&!(owner.state==='retained'&&owner.pid===process.pid)&&(!session||session.owner.work!==work||session.owner.nonce!==owner.nonce))fail('固定工作目录属于其他活跃任务');
 if(owner&&owner.groups.some(pid=>alive(pid,true)))fail('工具后代退出未确认，禁止清场');
 if(fs.existsSync(join(work,'.product-build.lock')))fail('产品编译进程仍持有守卫，禁止清场');
 const value=short(work,()=>{empty(work,owner&&!(owner.state==='retained'&&owner.pid===process.pid)?['.active.json','.claim.lock']:['.claim.lock']);if(isBuildWork(work)&&fs.readdirSync(work).length===0)fs.rmdirSync(work);});return value;
}
function remoteIdentity(env){return env.GITHUB_ACTIONS==='true'&&env.GITHUB_REPOSITORY?.split('/')[1]===product&&env.GITHUB_RUN_ID&&env.GITHUB_RUN_ATTEMPT?env.GITHUB_RUN_ID+':'+env.GITHUB_RUN_ATTEMPT+':'+env.GITHUB_JOB:null;}
function claimFixedWork(scope,{environment=process.env,retain=false,run_id}={}){
 const work=checkFixedWork(fixedWork(scope),{create:true}),remote=remoteIdentity(environment),current=sessions.getStore();
 if(current?.owner.work===work){if(run_id){const owner=readOwner(work);if(owner?.nonce!==current.owner.nonce||owner.run_id&&owner.run_id!==run_id)fail('编译任务编号不一致');owner.run_id=run_id;writeOwner(owner);current.owner=owner;}return {...current,nested:true};}
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
  const owner={schema:1,product_id:product,work,pid:process.pid,nonce:randomUUID(),groups:[],state:'running',remote,...(run_id?{run_id}:{})};
  fs.writeFileSync(join(work,'.active.json'),JSON.stringify(owner)+'\n',{flag:'wx',mode:0o600});return {owner,retain};
 });
}
function trackFixedProcess(work,pid){
 if(!pid||!validWork(work))return;
 const owner=readOwner(work);if(!owner)return;
 if(owner.pid!==process.pid&&!(alive(owner.pid)&&process.env.PRODUCT_WORK_LEASE===owner.nonce))fail('工具进程不能写入其他任务');
 if(!owner.groups.includes(pid)){owner.groups.push(pid);writeOwner(owner);}
}
function trackWorkProcess(pid){
 const session=sessions.getStore();if(!session||!pid)return;
 const owner=readOwner(session.owner.work);if(owner?.nonce!==session.owner.nonce)fail('任务所有权漂移');
 if(!owner.groups.includes(pid)){owner.groups.push(pid);writeOwner(owner);}
}
function workEnvironment(environment=process.env){
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
function retainWork(){const session=sessions.getStore();if(!session)fail('缺少当前任务');session.retain=true;}
function releaseFixedWork(session,{unsafe=false}={}){
 if(session.nested)return;
 const work=session.owner.work;
 const value=short(work,()=>{
  const owner=readOwner(work);if(owner?.nonce!==session.owner.nonce)fail('任务所有权漂移');
  const groups=owner.groups.filter(pid=>alive(pid,true));
  if(unsafe||groups.length){writeOwner({...owner,groups,state:'unsafe'});fail('工具后代退出未确认，保留守卫并禁止任务完成');}
  if(session.retain){writeOwner({...owner,groups:[],state:owner.remote?'remote':'retained'});return;}
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品编译守卫未释放，禁止完成');
  empty(work,['.claim.lock']);if(isBuildWork(work))fs.rmdirSync(work);
 });return value;
}
function withFixedWorkSync(scope,action,options={}){
 const session=claimFixedWork(scope,options);let unsafe=false;
 try{return sessions.run(session,()=>action(session.owner.work,session));}
 catch(error){unsafe=String(error?.message).includes('退出未确认');throw error;}
 finally{releaseFixedWork(session,{unsafe});}
}
async function withFixedWork(scope,action,options={}){
 const session=claimFixedWork(scope,options);let unsafe=false;
 try{return await sessions.run(session,()=>action(session.owner.work,session));}
 catch(error){unsafe=String(error?.message).includes('退出未确认');throw error;}
 finally{releaseFixedWork(session,{unsafe});}
}
// 调用方在消费结果且产品进程退出后，只能收尾这个产品的准确固定目录。
function finishFixedWork(work,{run_id,forceRemote=false}={}){
 if(run_id&&validWork(work)&&!fs.existsSync(work))return;
 checkFixedWork(work);
 const value=short(work,()=>{
  const owner=readOwner(work);if(run_id&&!owner)return;if(run_id&&!owner.remote&&owner.run_id!==run_id)fail('编译收尾任务编号不一致');if(owner){
   if((alive(owner.pid)&&!(owner.pid===process.pid&&owner.state==='retained'))||owner.groups.some(pid=>alive(pid,true)))fail('产品进程退出未确认');
   if(owner.remote&&!forceRemote&&owner.remote!==remoteIdentity(process.env))fail('远端任务身份不符');
  }
  if(fs.existsSync(join(work,'.product-build.lock')))fail('产品守卫尚未释放');
  if(run_id&&fs.existsSync(join(work,'build-result.json'))){regular(join(work,'build-result.json'));if(JSON.parse(fs.readFileSync(join(work,'build-result.json'),'utf8')).run_id!==run_id)fail('结果任务编号不符');}
  empty(work,['.claim.lock']);if(isBuildWork(work))fs.rmdirSync(work);
 });return value;
}
function taskScope(work){checkFixedWork(work);return work===fixedWork('test')?'test':'build/'+relative(fixedWork('build'),work);}


return {fixedWork,checkFixedWork,checkScratchPath,fixedScratch,assertTargetTopology,clearFixedWork,claimFixedWork,trackFixedProcess,trackWorkProcess,workEnvironment,retainWork,releaseFixedWork,withFixedWorkSync,withFixedWork,finishFixedWork,taskScope};
})();
const buildDependencyLock=Object.freeze({"schema":1,"environment":{"zxing-cpp":{"version":"3.1.1","url":"https://github.com/zxing-cpp/zxing-cpp/releases/download/v3.1.1/zxing-cpp-3.1.1.tar.gz","size":1628322,"sha256":"c3c02c29c0b519de7bd4e25b376e606e87f0761befd1282815642a2246613d14","archive_root":"zxing-cpp-3.1.1"}},"android_tools":{"agp":"9.0.1","kotlin":"2.2.20","gradle":"9.1.0","cmake":"3.31.6","ndk":"28.2.13676358"},"native":{"schema":1,"sources":{"sqlite":{"version":"3.53.4","url":"https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip","size":2946650,"sha256":"1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d","sha3_256":"628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e","archive_root":"sqlite-amalgamation-3530400"},"openssl":{"version":"3.5.8","url":"https://github.com/openssl/openssl/releases/download/openssl-3.5.8/openssl-3.5.8.tar.gz","size":53213818,"sha256":"a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2","archive_root":"openssl-3.5.8","license":"LICENSE.txt","license_sha256":"7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a"},"tpm2-tss":{"version":"4.2.0","url":"https://github.com/tpm2-software/tpm2-tss/releases/download/4.2.0/tpm2-tss-4.2.0.tar.gz","size":2023505,"sha256":"b53f0c5c8c4ce17f05701a410ca9688f725ca380c9bc4640eacd0eadb1fea124","archive_root":"tpm2-tss-4.2.0","license":"LICENSE","license_sha256":"18c1bf4b1ba1fb2c4ffa7398c234d83c0d55475298e470ae1e5e3a8a8bd2e448"}},"sqlite_defines":["SQLITE_THREADSAFE=1"],"openssl_options":["no-shared","no-module","no-dso","no-tests","-fPIC"],"tss2_options":["--enable-option-checking=fatal","--disable-shared","--enable-static","--with-pic","--with-crypto=ossl","--disable-fapi","--disable-policy","--enable-esys","--enable-util-io","--enable-tcti-device","--disable-tcti-mssim","--disable-tcti-swtpm","--disable-tcti-pcap","--disable-tcti-null","--disable-tcti-libtpms","--disable-tcti-cmd","--disable-tcti-spi-helper","--disable-tcti-spi-ltt2go","--disable-tcti-spidev","--disable-tcti-spi-ftdi","--disable-tcti-i2c-helper","--disable-tcti-i2c-ftdi","--disable-tcti-fuzzing","--enable-nodl","--disable-unit","--disable-integration","--disable-log-file","--with-maxloglevel=none","--with-sysusersdir=no","--with-tmpfilesdir=no","--disable-doxygen-doc","--disable-doxygen-man","--disable-doxygen-html"],"platforms":{"LinuxARM":{"target":"aarch64-unknown-linux-gnu","machine":183,"openssl_target":"linux-aarch64","glibc":"2.31"},"LinuxAMD":{"target":"x86_64-unknown-linux-gnu","machine":62,"openssl_target":"linux-x86_64","glibc":"2.31"},"Windows":{"target":"x86_64-pc-windows-msvc","machine":34404,"msvc_runtime":"/MD"}}},"headers":{"openssl":["aes.h","asn1.h","asn1err.h","asn1t.h","async.h","asyncerr.h","bio.h","bioerr.h","blowfish.h","bn.h","bnerr.h","buffer.h","buffererr.h","byteorder.h","camellia.h","cast.h","cmac.h","cmp.h","cmp_util.h","cmperr.h","cms.h","cmserr.h","comp.h","comperr.h","conf.h","conf_api.h","conferr.h","configuration.h","conftypes.h","core.h","core_dispatch.h","core_names.h","core_object.h","crmf.h","crmferr.h","crypto.h","cryptoerr.h","cryptoerr_legacy.h","ct.h","cterr.h","decoder.h","decodererr.h","des.h","dh.h","dherr.h","dsa.h","dsaerr.h","dtls1.h","e_os2.h","e_ostime.h","ebcdic.h","ec.h","ecdh.h","ecdsa.h","ecerr.h","encoder.h","encodererr.h","engine.h","engineerr.h","err.h","ess.h","esserr.h","evp.h","evperr.h","fips_names.h","fipskey.h","hmac.h","hpke.h","http.h","httperr.h","idea.h","indicator.h","kdf.h","kdferr.h","lhash.h","macros.h","md2.h","md4.h","md5.h","mdc2.h","ml_kem.h","modes.h","obj_mac.h","objects.h","objectserr.h","ocsp.h","ocsperr.h","opensslconf.h","opensslv.h","ossl_typ.h","param_build.h","params.h","pem.h","pem2.h","pemerr.h","pkcs12.h","pkcs12err.h","pkcs7.h","pkcs7err.h","prov_ssl.h","proverr.h","provider.h","quic.h","rand.h","randerr.h","rc2.h","rc4.h","rc5.h","ripemd.h","rsa.h","rsaerr.h","safestack.h","seed.h","self_test.h","sha.h","srp.h","srtp.h","ssl.h","ssl2.h","ssl3.h","sslerr.h","sslerr_legacy.h","stack.h","store.h","storeerr.h","symhacks.h","thread.h","tls1.h","trace.h","ts.h","tserr.h","txt_db.h","types.h","ui.h","uierr.h","whrlpool.h","x509.h","x509_acert.h","x509_vfy.h","x509err.h","x509v3.h","x509v3err.h"],"tss2":["common","esys","mu","rc","sys","tcti","tcti_device","tpm2_types"]}});
const {checkFixedWork,clearFixedWork,fixedWork,withFixedWork,taskScope,trackWorkProcess,workEnvironment,finishFixedWork}=buildTarget;
export {finishFixedWork as finishBuild};
export const contract=Object.freeze({"schema":1,"product_id":"citizensdk","entry":"scripts/build.mjs","platforms":{"sdk":{"tools":[{"id":"cmake","version":"3.31.6"},{"id":"git","version":"2.54.0"},{"id":"node","version":"25.2.1"},{"id":"bash","version":"5.3.20"},{"id":"grep","version":"3.12"},{"id":"sed","version":"4.10"},{"id":"rust","version":"1.97.1"},{"id":"flutter","version":"3.47.2"},{"id":"java","version":"17.0.20.1"},{"id":"gradle","version":"9.1.0"},{"id":"android","version":"37.0.1"},{"id":"android-sdk","version":"22.0"},{"id":"android-ndk","version":"28.2.13676358"},{"id":"cocoapods","version":"1.17.0"},{"id":"xcode","version":"27.0"},{"id":"posix","version":"27.0"}],"locks":[{"ecosystem":"pub","path":"pubspec.lock"},{"ecosystem":"cargo","path":"Cargo.lock"}],"completion":"compile-only","files":[]}},"resource_entry":"scripts/build.mjs"});
const product=contract.product_id, prefix=product.toUpperCase();
const inside=(base,path)=>{const r=relative(base,path);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
const fail=message=>{throw Error(product+' Build：'+message);};
export function checkWork(work) { return checkFixedWork(work); }

// 产品自己拥有target工作边界；测试与独立入口也不借用调用方的全局缓存。
export function productTarget(platform) {
 platformContract(platform);
 return join(root,'target');
}
export function temporaryRoot(platform=Object.keys(contract.platforms)[0],scope='test',suppliedInput) {
 if(!['test','tmp','build'].includes(scope))fail('临时目录职责无效');
 platformContract(platform);const expected=fixedWork(scope==='test'?'test':'build/'+platform);
 if(suppliedInput!=null&&suppliedInput!==expected)fail('临时工作根必须是本产品固定目录');
 return checkFixedWork(expected,{create:true});
}
// 展开来源根由本产品指定，调用者不识别任何产品来源名称。
export function resourceSourceRoot(name,work){checkWork(work);if(!/^[a-z][a-z0-9_]*$/u.test(name))fail('来源名称无效');return join(work,'git-sources',name);}
// 清理只针对当前执行拥有的工作根；工具全部退出后删除并回读，固定根本身保留。
export function clearWork(work) { return clearFixedWork(work); }

export function platformContract(platform) {
 if(!Object.hasOwn(contract.platforms,platform))fail('平台未声明');
 return contract.platforms[platform];
}
const sourceRoot=()=>root;
const nativePlatform=platform=>platform.endsWith('android')?'Android':platform.includes('linux-arm')?'LinuxARM':platform.includes('linux-amd')?'LinuxAMD':platform.endsWith('windows')?'Windows':'macOS';
const osPlatform=platform=>platform.includes('linux-')?'linux':platform.replace(/^(?:host|client)-/u,'');

// 只读声明与原始锁；每个第一方Git来源必须同时匹配固定URL、40位提交和resolved-ref。
export function lockedSources() {
 const source=sourceRoot(),path=join(source,'pubspec.yaml');if(!existsSync(path))return [];
 const manifest=readFileSync(path,'utf8'),lock=readFileSync(join(source,'pubspec.lock'),'utf8'),result=[];
 for(const name of ['citizen_sdk','tatachat_sdk']) {
  const block=text=>[...text.matchAll(new RegExp('^  '+name+':\\r?\\n(?: {4,}[^\\n]*\\n|[ \\t]*\\n)+','gm'))];
  const a=block(manifest),b=block(lock);if(!a.length)continue;
  if(a.length!==1||b.length!==1)fail('Git来源记录不唯一');
  const value=(text,key)=>{const m=[...text.matchAll(new RegExp('^ +'+key+':\\s*([^\\n]+)$','gm'))];if(m.length!==1)fail('Git来源字段不唯一');return m[0][1].trim().replace(/^["']|["']$/gu,'');};
  const url=value(a[0][0],'url'),ref=value(a[0][0],'ref');
  if(!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+\.git$/u.test(url)||!/^[a-f0-9]{40}$/u.test(ref)
   ||value(a[0][0],'path')!=='.'||value(b[0][0],'url')!==url||value(b[0][0],'resolved-ref')!==ref||value(b[0][0],'ref')!==ref)fail('Git声明和锁不一致');
  result.push({name,url,ref});
 }return result;
}
export function requirements(platform,work) {
 checkWork(work);const declared=platformContract(platform);
 const locks=declared.locks.map(value=>({...value})),sources=lockedSources(),archives=[];
 for(const source of sources) {
  const packageRoot=join(work,'git-sources',source.name);
  if(existsSync(packageRoot)) {
   const path=source.name==='citizen_sdk'?'Cargo.lock':'native/Cargo.lock';
   locks.push({ecosystem:'cargo',path,source_package:source.name});
   if(source.name==='citizen_sdk') {
    const lock=buildDependencyLock;
    const p=nativePlatform(platform);
    const entries=[['zxing-cpp',lock.environment['zxing-cpp']],...((p==='LinuxARM'||p==='LinuxAMD')?Object.entries(lock.native.sources):p==='Windows'?[['sqlite',lock.native.sources.sqlite]]:[])];
    for(const [name,value]of entries)archives.push({ecosystem:'native',name,...value,group:'sdk-native'});
   }
  }
 }
 // 原生源归档坐标归本产品已有声明；准备后才提出展开源码的Cargo锁。

  const lock=buildDependencyLock;
  archives.push({ecosystem:'native',name:'zxing-cpp',...lock.environment['zxing-cpp'],group:'sdk-native'});
 for(const lock of declared.locks){const file=join(root,lock.path);if(!existsSync(file)||!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())fail('原始锁缺失或带链接：'+lock.path);}
 return {schema:1,product_id:product,platform,tools:declared.tools,locks,sources,archives};
}

export function resourceEnvironment(platform,work,receipt,base={}) {
 checkWork(work);const declared=platformContract(platform);
 if(!receipt||receipt.schema!==1||receipt.product_id!==product||receipt.platform!==platform||receipt.work!==work||receipt.offline!==true
  ||!receipt.tools||!receipt.dependencies||!receipt.archives)fail('资源回执身份无效');
 const env={HOME:base.HOME,USER:base.USER,LOGNAME:base.LOGNAME,LANG:'zh_CN.UTF-8',LC_ALL:'C',
  ...receipt.environment,TMPDIR:join(work,'tmp')+sep,TMP:join(work,'tmp'),TEMP:join(work,'tmp'),XDG_CACHE_HOME:join(work,'cache'),XDG_CONFIG_HOME:join(work,'config'),
  CARGO_TARGET_DIR:join(work,'work/cargo-target'),CARGO_NET_OFFLINE:'true',CARGO_INCREMENTAL:'1',
  npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false'};
 const allowedEnvironment=new Set([prefix+'_RESOURCE_MODE','PRODUCT_WORK_DIR','PRODUCT_BASH_BIN','PRODUCT_RSYNC_BIN','PATH','DEVELOPER_DIR','SDKROOT','DART_EXECUTABLE','XCODEBUILD','CODESIGN','SECURITY','XCRUN','XCODE_SELECT','CC','CXX','SWIFT','OTOOL','INSTALL_NAME_TOOL','LIPO','MAKE','AR','RANLIB','NM','STRIP','LLVM_NM','LD','LDCXX','CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_HOME','ANDROID_USER_HOME','ANDROID_EMULATOR_HOME','GRADLE_INIT_SCRIPT','GRADLE_USER_HOME']);
 if(Object.keys(receipt.environment||{}).some(key=>!allowedEnvironment.has(key)))fail('资源回执包含未声明环境或注入变量');
 for(const tool of declared.tools) {
  const value=receipt.tools[tool.id];
  if(!value||value.version!==tool.version||typeof value.path!=='string'||!isAbsolute(value.path)||resolve(value.path)!==value.path)fail('缺少准确版本的工具：'+tool.id);
  const s=lstatSync(value.path);if(!s.isFile()||s.isSymbolicLink()||!(s.mode&0o111)||realpathSync(value.path)!==value.path)fail('工具入口必须是普通执行器：'+tool.id);
 }
 const aliases={node:'NODE',git:'GIT',flutter:'FLUTTER',rust:'RUSTC',python:'PYTHON',java:'JAVA',gradle:'GRADLE',
  cmake:'CMAKE',cocoapods:'POD',protoc:'PROTOC',zig:'ZIG','worker-build':'WORKER_BUILD','wasm-bindgen':'WASM_BINDGEN_BIN','wasm-opt':'WASM_OPT_BIN',esbuild:'ESBUILD_BIN',
  perl:'PERL',m4:'M4',bison:'BISON',flex:'FLEX',tcl:'TCLSH',gettext:'GETTEXT',openssl:'OPENSSL'};
 for(const [id,name]of Object.entries(aliases))if(receipt.tools[id])env[name]=receipt.tools[id].path;
 // POSIX旧Shell不进入正式PATH；基础工具只通过产品已验真的GNU投影交付。
 const paths=Object.entries(receipt.tools).filter(([id])=>id!=='posix').map(([,value])=>dirname(value.path));
 env.PATH=[...new Set([...paths,...(env.PATH||'').split(':')].filter(Boolean))].join(':');
 if(env.GIT)env.PRODUCT_GIT_BIN=env.GIT;
 if(env.RUSTC)env.CARGO=join(dirname(env.RUSTC),'cargo');
 if(env.FLUTTER){env.FLUTTER_ROOT=dirname(dirname(env.FLUTTER));env.DART_EXECUTABLE=join(env.FLUTTER_ROOT,'bin/cache/dart-sdk/bin/dart');}
 if(env.PYTHON)env.PYTHONHOME=dirname(dirname(env.PYTHON));
 if(env.JAVA)env.JAVA_HOME=dirname(dirname(env.JAVA));
 if(env.OPENSSL)env.TUYU_OPENSSL_PREFIX=dirname(dirname(env.OPENSSL));
 const own=receipt.dependencies.own||{};
 // 原始锁要求的目录必须显式交付，不能落入用户默认缓存。
 for(const lock of declared.locks){const key={npm:'npmCache',pub:'pubCache',cargo:'cargoHome'}[lock.ecosystem];if(key&&!own[key])fail('缺少原始锁依赖回执：'+lock.ecosystem);}
 for(const [key,name]of [['npmCache','npm_config_cache'],['pubCache','PUB_CACHE'],['cargoHome','CARGO_HOME']])if(own[key]){
  checkDependency(work,own[key]);env[name]=own[key];
 }
 env[prefix+'_WORK_DIR']=work;env[prefix+'_BUILD_WORK_DIR']=join(work,'work');env[prefix+'_DEPENDENCY_DIR']=join(work,'dependencies');
 env[prefix+'_BUILD_DIR']=join(work,'work/flutter');env[prefix+'_ARTIFACT_DIR']=work;env[prefix+'_OFFLINE']='true';
 env.BUILD_DIR=join(work,'work/flutter');env[prefix+'_NODE_BIN']=env.NODE;
 env[prefix+'_PROJECT_ROOT']=join(work,'source-view',sourceRoot().replace(/^\/+/u,''));
 env.PRODUCT_SOURCE_DIR=env[prefix+'_PROJECT_ROOT'];
 if(env.GRADLE)env[prefix+'_GRADLE_BIN']=env.GRADLE;
 env.GRADLE_USER_HOME=join(work,'dependencies/gradle');env.CP_HOME_DIR=join(work,'dependencies/cocoapods');
 env[prefix+'_PUB_OFFLINE']='true';env.GRADLE_OPTS='-Dorg.gradle.project.android.builder.sdkDownload=false';
 if(receipt.archives.native)env.CHATSERVER_NATIVE_ARCHIVE=receipt.archives.native[0].path;
 if(receipt.archives.protocol)env.CHATSERVER_PROTOCOL_ARCHIVE=receipt.archives.protocol[0].path;
 if(product==='citizensdk'){env.CITIZENSDK_WORK_DIR=join(work,'work/native');env.CITIZENSDK_NATIVE_OUTPUT_DIR=join(work,'work/output');}
 if(base.PRODUCT_RESOURCE_FD==='4')env["CITIZENSDK_RESOURCE_MODE"]='provided';else env["CITIZENSDK_RESOURCE_MODE"]??='independent';
 if(env["CITIZENSDK_RESOURCE_MODE"]==='provided'){env.PIP_NO_INDEX='1';env.COMPOSER_DISABLE_NETWORK='1';env.YARN_ENABLE_NETWORK='0';}
 const execution=executions.getStore();if(execution)execution.buildEnvironment=env;
 return env;
}
function checkDependency(work,path){if(!isAbsolute(path)||resolve(path)!==path||!inside(work,path)||path===work||!lstatSync(path).isDirectory()||realpathSync(path)!==path)fail('依赖回执越界或无效');}
// 工程输入复制到本轮真实目录，保证包解析与写入均不进入正式源码；内部链接映射到同轮副本。
export function createView(source,destination) {
 if(realpathSync(source)!==source||!lstatSync(source).isDirectory()||!isAbsolute(destination)||resolve(destination)!==destination||inside(source,destination)||inside(destination,source))fail('工程输入与输出边界无效');
 let parent=dirname(destination);while(!existsSync(parent))parent=dirname(parent);
 if(!lstatSync(parent).isDirectory()||realpathSync(parent)!==parent)fail('工程输出经过链接');
 if(lstatSync(destination,{throwIfNoEntry:false}))fail('本轮工程已存在');mkdirSync(destination,{recursive:true,mode:0o700});
 const generated=new Set(['.git','.dart_tool','.gradle','.symlinks','Pods','build','target','node_modules','ephemeral','.cache','.DS_Store','swiftpm','dist','tsconfig.tsbuildinfo']);
 function visit(from,to){for(const name of readdirSync(from).sort()){if(generated.has(name))continue;const a=join(from,name),b=join(to,name),s=lstatSync(a);
  if(s.isDirectory()){mkdirSync(b);visit(a,b);}else if(s.isFile()){copyFileSync(a,b);}
  else if(s.isSymbolicLink()){const target=realpathSync(a);if(!inside(source,target)||!lstatSync(target).isFile())fail('源码链接越界');symlinkSync(join(destination,relative(source,target)),b);}else fail('源码文件类型无效');
 }}visit(source,destination);return destination;
}
// 归档坐标只接受本产品当前锁；完整性在build前核验，prepare允许稍后展开的锁。
export async function checkArchives(platform,work,receipt,complete=false) {
 const requested=(await requirements(platform,work)).archives;
 const expected=new Map(requested.map(value=>[value.group+'@'+value.name,value]));const seen=new Set();
 for(const [group,items]of Object.entries(receipt.archives)){
  if(!Array.isArray(items))fail('归档回执类型无效');
  for(const item of items){const key=group+'@'+item.name,wanted=expected.get(key);
   if(!wanted||seen.has(key)||['url','version','sha256'].some(key=>item[key]!==wanted[key])||typeof item.path!=='string'||!isAbsolute(item.path)||resolve(item.path)!==item.path||!inside(work,item.path))fail('归档回执与产品锁不一致');
   seen.add(key);const info=lstatSync(item.path);if(!info.isFile()||info.isSymbolicLink()||realpathSync(item.path)!==item.path||!info.size||createHash('sha256').update(readFileSync(item.path)).digest('hex')!==wanted.sha256)fail('锁定归档原件无效');
  }
 }
 if(complete&&seen.size!==expected.size)fail('缺少产品锁定归档回执');
}
async function stageArchives(work,receipt) {
 // 归档都来自回执；先按本产品锁回读摘要，再交给现有原生准备器，缺失时禁止下载。
 for(const item of receipt.archives['sdk-native']||[]) {
  if(createHash('sha256').update(readFileSync(item.path)).digest('hex')!==item.sha256)fail('原生归档摘要漂移');
  const directory=join(work,'sdk-native/sources/archives');mkdirSync(directory,{recursive:true});
  const suffix=new URL(item.url).pathname.endsWith('.zip')?'.zip':'.tar.gz';
  const target=join(directory,item.sha256+suffix);if(!existsSync(target))copyFileSync(item.path,target);
 }
}
export async function prepare(platform,work,receipt,base) {
 const env=resourceEnvironment(platform,work,receipt,base),source=sourceRoot();
 for(const name of ['work','tmp','cache','config','dependencies','stage'])mkdirSync(join(work,name),{recursive:true,mode:0o700});
 await checkArchives(platform,work,receipt);await stageArchives(work,receipt);

 return {schema:1,product_id:product,platform,work};
}
export async function build(platform,work,receipt,base) {
 const env=resourceEnvironment(platform,work,receipt,base),declared=platformContract(platform);
 await checkArchives(platform,work,receipt,true);await stageArchives(work,receipt);
 const shell=receipt.tools.bash?.path;
 if(!shell)fail('缺少显式Shell资源');
 const project=env[prefix+'_PROJECT_ROOT'];


  env.CITIZENSDK_WORK_DIR=join(work,'work/native');env.CITIZENSDK_NATIVE_OUTPUT_DIR=join(work,'work/output');
  env.CITIZENSDK_ZXING_SOURCE_DIR=join(work,'sdk-native/sources',buildDependencyLock.environment['zxing-cpp'].archive_root);
  await buildResources.prepareEnvironment({scope:'citizensdk',platform:'macOS',work:join(work,'sdk-native/sources')});
  for(const path of ['work/native','work/output'])mkdirSync(join(work,path),{recursive:true});
  await runOwnedShell('native',['host'],{environment:{...env,PRODUCT_BASH_BIN:shell}});

 return completeBuild(platform,work,receipt,env);
}

// 每次调用拥有自己的取消和进程集合，导入API并发也不能共享执行状态。
const executions=new AsyncLocalStorage();
export async function runBuildProcess(file,args,env,cwd=root,{capture=false,input,accepted=[0],timeout=7200000,signal=executions.getStore()?.signal,passHost=false,streamError=false}={}) {
 signal?.throwIfAborted();
 return new Promise((ok,reject)=>{
  const child=spawn(file,args,{cwd,env:workEnvironment(env),detached:true,stdio:['pipe','pipe','pipe',...(passHost?[3]:[])]});
  trackWorkProcess(child.pid);
  let stdout=[],stderr=[],bytes=0,reason,settled=false;
  const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')reason='无法取消产品工具进程组';}};
  let killer;
  const terminate=()=>{stop();clearTimeout(killer);killer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500);};
  const forced=setTimeout(()=>{reason='产品工具超时';terminate();},timeout);forced.unref();
  const abort=()=>{reason='产品任务已取消';terminate();};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const consume=(chunk,out)=>{bytes+=chunk.length;if(bytes>16*1024*1024){reason='产品工具输出超限';terminate();return;}out.push(chunk);if(!capture)process.stderr.write(chunk);};
  child.stdout.on('data',chunk=>consume(chunk,stdout));child.stderr.on('data',chunk=>{if(capture&&streamError)process.stderr.write(chunk);else consume(chunk,stderr);});
  child.stdin.on('error',()=>{reason='产品工具输入失败';stop();});
  child.once('error',()=>{reason='产品工具无法启动';});
  child.once('close',async(code,termination)=>{
   clearTimeout(forced);clearTimeout(killer);
   // 主进程close不代表后代退出；未退出的同组工具必须停止并确认，之后才能清理材料。
   const alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
   if(alive()){reason??='产品工具退出后仍有后代';stop();for(let n=0;n<15&&alive();n++)await new Promise(r=>setTimeout(r,100));if(alive())try{process.kill(-child.pid,'SIGKILL');}catch{};for(let n=0;n<15&&alive();n++)await new Promise(r=>setTimeout(r,100));}
   if(alive()){reason='产品工具后代退出未确认，保留工作目录';const state=executions.getStore();if(state)state.unconfirmed=true;}
   signal?.removeEventListener('abort',abort);clearTimeout(killer);
   if(signal?.aborted)reason='产品任务已取消';
   if(settled)return;settled=true;
   if(reason||termination||!accepted.includes(code))reject(Error(reason||'产品工具执行失败'));
   else ok({stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),code});
  });
  child.stdin.end(input);
 });
}
const run=async(file,args,env,cwd=root,capture=false)=>(await runBuildProcess(file,args,env,cwd,{capture})).stdout;

export function outputDigest(path) {
 const hash=createHash('sha256');const base=path;
 function visit(file){const info=lstatSync(file);const name=relative(base,file);
  if(info.isSymbolicLink()){const real=realpathSync(file);if(!inside(base,real))fail('输出链接越界');hash.update(JSON.stringify([name,'link',readlinkSync(file)])+'\n');}
  else if(info.isDirectory()){hash.update(JSON.stringify([name,'directory'])+'\n');for(const child of readdirSync(file).sort())visit(join(file,child));}
  else if(info.isFile()&&info.nlink===1){hash.update(JSON.stringify([name,'file',Boolean(info.mode&0o111),info.size])+'\n');hash.update(readFileSync(file));}
  else fail('输出包含特殊文件或硬链接');
 }visit(path);return hash.digest('hex');
}

// 宿主完整Build先由调用方消费回执、安装并收尾；独立执行由本产品清空现场。
export async function execute(platform,work,request={},options={}) {
 checkFixedWork(work,{create:true});
 return withFixedWork(taskScope(work),()=>executeTask(platform,work,request,options),{run_id:request.run_id,environment:options.environment||process.env,retain:(options.environment||process.env).PRODUCT_RESOURCE_FD==='4'||(options.environment||process.env).PRODUCT_HOST_FD==='3'});
}
async function executeTask(platform,work,request={},options={}) {
 checkWork(work);platformContract(platform);
 if(!inside(productTarget(platform),work)||work===productTarget(platform))fail('执行工作根与当前产品平台不一致');
 options.signal?.throwIfAborted();
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['run_id','program_digest'].includes(k))
  ||request.run_id!==undefined&&!/^[1-9][0-9]{8}$/u.test(request.run_id)||request.program_digest!==undefined&&!/^[a-f0-9]{64}$/u.test(request.program_digest)
  )fail('本仓Build只接受任务编号、程序输入记录及显式供给方式');
 chmodSync(work,0o700);
 const lock=join(work,'.product-build.lock'),resultFile=join(work,'build-result.json');
 if(existsSync(resultFile))fail('本轮完整Build已有结果，禁止复用旧终态');
 const handle=openSync(lock,'wx',0o600);closeSync(handle);
 const cancellation=new AbortController(),abort=()=>cancellation.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 const state={signal:cancellation.signal,cancellation,host:options.host,unconfirmed:false,finished:false};
 try{return await executions.run(state,async()=>{
  const stages=options.stages||{requirements,resources,prepare,build};
  const resourcesOptions={signal:state.signal,offline:Boolean(options.offline),environment:options.environment||process.env};

  if((options.environment||process.env).PRODUCT_RESOURCE_FD==='4'){
   state.resourceClient=options.resourceClient||createResourceSupplyClient(new Socket({fd:4,readable:true,writable:true}),state.signal);
   resourcesOptions.supply=previous=>state.resourceClient({previous});
  }
  await stages.requirements(platform,work);state.signal.throwIfAborted();
  let receipt=await stages.resources(platform,work,request,resourcesOptions);state.signal.throwIfAborted();
  await stages.prepare(platform,work,receipt,resourcesOptions.environment);state.signal.throwIfAborted();
  await stages.requirements(platform,work);
  receipt=await stages.resources(platform,work,receipt,resourcesOptions);state.signal.throwIfAborted();
  const result=await stages.build(platform,work,receipt,resourcesOptions.environment);state.signal.throwIfAborted();
  checkBuildResult(result,platform,work,request.run_id);
  writeFileSync(resultFile,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});return result;
 });}catch(error){if(String(error?.message).includes('退出未确认'))state.unconfirmed=true;throw error;}finally{state.finished=true;state.socket?.destroy();state.resourceClient?.close?.();options.signal?.removeEventListener('abort',abort);if(!state.unconfirmed){unlinkSync(lock);if((options.environment||process.env).PRODUCT_RESOURCE_FD!=='4'&&(options.environment||process.env).PRODUCT_HOST_FD!=='3')clearWork(work);}}
}
export function checkBuildResult(value,platform,work,runId) {
 // SDK本机入口只完成多平台源码编译；完整SDK包由本仓正式自动化产生。
 if(platform!=='sdk'||platformContract('sdk').completion!=='compile-only'||contract.platforms.sdk.files.length)
  fail('公民SDK本机接口不能交付正式SDK归档');
 if(value?.schema!==1||value.product_id!==product||value.platform!=='sdk'||value.work!==work
  ||value.completion!=='compile-only'||value.run_id!==runId)fail('公民SDK编译终态不属于当前请求');
 if(!Array.isArray(value.files)||value.files.length!==0)fail('公民SDK源码编译不提供分发包或设备安装结果');
 const expected=['completion','files','platform','product_id','schema','work'];if(runId)expected.push('run_id');
 if(Object.keys(value).length!==expected.length||expected.some(key=>!Object.hasOwn(value,key)))fail('公民SDK源码编译回执不完整');
 return value;
}
async function completeBuild(platform,work,receipt,env) {
 const declared=platformContract(platform);
 if(declared.completion==='device-install')fail('本产品未声明设备安装实现');
 if(declared.completion==='macos-artifact')for(const name of declared.files)await run(env.CODESIGN,['--verify','--deep','--strict',join(work,name)],env);
 const result={schema:1,product_id:product,platform,work,completion:declared.completion,
  files:declared.files.map(name=>{const path=join(work,name);if(!inside(work,path)||realpathSync(path)!==path)fail('Build候选越界');return {path,sha256:outputDigest(path)};})};
 if(receipt.run_id)result.run_id=receipt.run_id;return checkBuildResult(result,platform,work,receipt.run_id);
}

// 模块先完成初始化，资源模块才能反向导入本文件的唯一校验；异步CLI在独立Promise中执行。

// 本产品在独立编译与调度编译中均清理自己的生成物。
export function cleanBuildPath(path,options={},environment=executions.getStore()?.buildEnvironment||process.env){
 const work=environment.PRODUCT_WORK_DIR||[...Object.keys(contract.platforms).map(platform=>fixedWork('build/'+platform)),fixedWork('test')].find(work=>path?.startsWith(work+sep));if(typeof work!=='string'||typeof path!=='string'||resolve(path)!==path||!path.startsWith(work+sep))fail('编译清理路径越界');
 checkFixedWork(work);let parent=dirname(path);while(!existsSync(parent))parent=dirname(parent);if(realpathSync(parent)!==parent)fail('编译清理父目录经过链接');
 rmSync(path,options);
}
export function cleanShellPaths(args,environment=process.env){
 const paths=args.filter(value=>!value.startsWith('-')),options={recursive:args.some(value=>/^-[^-]*[rR]/u.test(value)),force:args.some(value=>/^-[^-]*f/u.test(value))};if(!paths.length)fail('清理路径缺失');for(const path of paths)cleanBuildPath(resolve(path),options,environment);
}


async function runCLI(){
 const [operation,platform,flag,work]=process.argv.slice(2);
 if(operation==='execute'&&process.env.PRODUCT_RESOURCE_FD!=='4'){if(flag!=='--work'||work!==fixedWork('build/'+platform))fail('平台编译现场不符');return withFixedWork('build/'+platform,()=>runCommand(),{environment:process.env,retain:process.env.PRODUCT_HOST_FD==='3'});}
 if(operation==='execute')return runCommand();
 if(['resources','prepare','build'].includes(operation)&&flag==='--work'){
  checkWork(work);
  return withFixedWork(taskScope(work),()=>runCommand(),{environment:process.env,retain:process.env.PRODUCT_HOST_FD==='3'||process.env.PRODUCT_RESOURCE_FD==='4'});
 }
 return runCommand();
}
async function runCommand(){
 if(process.argv[2]==='describe'){if(process.argv.length!==3)fail('编译声明参数无效');process.stdout.write(JSON.stringify(contract)+'\n');return;}
 if (process.argv[2]==="native") { process.exitCode=await runOwnedShell(process.argv[2],process.argv.slice(3)); return; }
 if (process.argv[2]==="analysis-options") { if(process.argv.length!==4)fail("分析选项参数无效");writeAnalysisOptions(process.argv[3]);return; }
 if(process.argv[2]==='projection'){const values={};for(let i=3;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!key?.startsWith('--')||!value)fail('编译投影参数无效');values[key.slice(2)]=value;}if(values['native-source-view'])process.stdout.write(compileProjection.createNativeSourceView(values['native-source-view'],values.output)+'\n');else if(values['flutter-source-entry'])compileProjection.projectFlutterSourceEntry(values['flutter-source-entry'],values.output);else fail('编译投影命令无效');return;}
 if(['plan','prepare-environment','prepare-native'].includes(process.argv[2]))return runDependencyCLI(process.argv.slice(2));
 if(process.argv[2]==='rsync')return buildResources.copyFlutterArtifact(process.argv.slice(3));
 const [command,platform,option,work,...extra]=process.argv.slice(2);
 if(command==='clean'){cleanShellPaths(process.argv.slice(3));return;}

 if(command==='temporary-root') {
  if(work!==undefined||extra.length)fail('临时入口参数无效');
  const host=process.platform==='darwin'?'macos':process.platform==='win32'?'windows':process.platform==='linux'?(process.arch==='arm64'?'linux-arm':process.arch==='x64'?'linux-amd':undefined):undefined;
  const fallback=option?.endsWith('macos')?option.slice(0,-5)+host:option;
  const chosen=Object.hasOwn(contract.platforms,platform)?platform
   :platform&&option?.endsWith('-'+platform)&&Object.hasOwn(contract.platforms,option)?option
   :Object.hasOwn(contract.platforms,'host-'+platform)?'host-'+platform:!platform?(Object.hasOwn(contract.platforms,fallback)?fallback:option):platform;
  platformContract(chosen);process.stdout.write(temporaryRoot(chosen,'tmp')+'\n');
 } else {

 if(!['requirements','resources','prepare','build','execute'].includes(command)||option!=='--work'||extra.some(x=>x!=='--offline')||extra.length>1||extra.length&&!['resources','execute'].includes(command))fail('固定入口参数无效');
 if(command==='execute'){platformContract(platform);if(work!==fixedWork('build/'+platform))fail('平台编译现场不符');}else checkWork(work);
 if(command==='requirements')process.stdout.write(JSON.stringify(requirements(platform,work))+'\n');
 else{
  const cancellation=new AbortController();for(const name of ['SIGTERM','SIGINT'])process.once(name,()=>cancellation.abort());
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>2*1024*1024)fail('公开输入超限');}
  const request=input?JSON.parse(input):{},options={environment:process.env,signal:cancellation.signal,offline:extra.includes('--offline')};
  let result;
  if(command==='execute'&&process.env.PRODUCT_RESOURCE_FD==='4'){
   if(process.env.PRODUCT_RESOURCE_FD!=='4')fail('编译资源供给通道缺失');
   result=await execute(platform,work,request,options);
  }else if(command==='execute'){
   const node=await bootstrapNode(work,options);
   if(createHash('sha256').update(readFileSync(process.execPath)).digest('hex')!==createHash('sha256').update(readFileSync(node.path)).digest('hex')){
    const environment=Object.fromEntries(['HOME','USER','LOGNAME','LANG','LC_ALL','PRODUCT_TOOL_ROOT','PRODUCT_DEPENDENCY_ROOT','PRODUCT_HOST_FD','PRODUCT_WORK_LEASE'].filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
    result=JSON.parse((await runBuildProcess(node.path,[fileURLToPath(import.meta.url),command,platform,option,work,...extra],workEnvironment(environment),root,{capture:true,streamError:true,input:JSON.stringify(request),signal:cancellation.signal,passHost:environment.PRODUCT_HOST_FD==='3'})).stdout);
   }else result=await execute(platform,work,request,options);
  }else if(command==='resources')result=await resources(platform,work,request,options);
  else result=await executions.run({signal:cancellation.signal},()=>command==='prepare'?prepare(platform,work,request,process.env):build(platform,work,request,process.env));
  process.stdout.write(JSON.stringify(result)+'\n');
 }
}
}


// Shell正文和分析选项唯一归本模块所有；公开脚本仅转交参数。
export const BUILD_SHELL_SOURCES = Object.freeze({"native": "#!/usr/bin/env bash\n# CitizenSDK 本机原生编译正文。源码目录只读，Cargo 与平台产物必须写入显式的外部目录。\nset -euo pipefail\n\n# 源码身份由当前入口交付的准确产品源码根决定，不能从调用方缓存视图推导。\nsdk_dir=\"${CITIZENSDK_SOURCE_ROOT:?缺少SDK源码根}\"\nscript_dir=\"$sdk_dir/scripts\"\n# Cargo清单由源码外工程准备完成后赋值，禁止直接编译仓库存放布局。\nffi_manifest=''\nproduct_ffi_manifest=''\nproduct_header=\"$sdk_dir/include/citizensdk.h\"\nproduct_types_header=\"$sdk_dir/include/citizensdk_types.h\"\nqr_image_source_root=\"$sdk_dir/native/image\"\nqr_image_header=\"$qr_image_source_root/citizensdk_qr_image.h\"\ndarwin_source_root=\"$sdk_dir/darwin/source/core\"\ndarwin_flutter_source_root=\"$sdk_dir/darwin/source/flutter\"\nlinux_source_root=\"$sdk_dir/linux\"\nwindows_source_root=\"$sdk_dir/windows\"\napple_asset_root=\"$sdk_dir/chain\"\ntarget_name=\"${1:-all}\"\nstandalone_root=\"$sdk_dir/target/build/sdk\"\n: \"${CITIZENSDK_WORK_DIR:=$standalone_root/work}\"\n: \"${CITIZENSDK_NATIVE_OUTPUT_DIR:=$standalone_root/output}\"\nexport CITIZENSDK_WORK_DIR CITIZENSDK_NATIVE_OUTPUT_DIR\nios_deployment_target=16.0\nmacos_deployment_target=13.0\nandroid_ndk_version=28.2.13676358\nlinux_glibc_baseline=2.31\n\nfail() {\n  echo \"CitizenSDK 原生构建失败：$1\" >&2\n  exit 1\n}\n\n# Windows 原生工具使用 drive 路径，Bash 安全目录函数使用 Git Bash POSIX 路径。\n# 必须在 canonical_directory 第一次 mkdir 前检查二者指向同一非源码目录。\nwindows_path_preflight() {\n  case \"$(uname -s)\" in MINGW*|MSYS*) ;; *) fail \"Windows 只允许在 Windows MSVC runner 构建\" ;; esac\n  command -v cygpath >/dev/null 2>&1 || fail \"Windows 缺少官方 Git Bash 路径转换工具\"\n  command -v node >/dev/null 2>&1 || fail \"Windows 缺少既有构建合同使用的 Node\"\n  local path converted\n  for path in \"${CITIZENSDK_WORK_DIR:-}\" \"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\"; do\n    [[ \"$path\" == /* && \"$path\" != / ]] || fail \"Windows 工作目录须使用 Git Bash 绝对路径\"\n    converted=\"$(cygpath -m \"$path\")\"\n    CITIZENSDK_PATH_CHECK=\"$converted\" CITIZENSDK_SOURCE_CHECK=\"$(cygpath -m \"$sdk_dir\")\" node -e '\n      const fs=require(\"fs\"), p=require(\"path\").win32;\n      const value=process.env.CITIZENSDK_PATH_CHECK, source=process.env.CITIZENSDK_SOURCE_CHECK;\n      if (!/^[A-Za-z]:\\//.test(value) || /[<>\"|?*\\x00-\\x1f]/.test(value)) throw Error(\"invalid Windows drive path\");\n      const pieces=value.slice(3).split(\"/\");\n      if (pieces.some(x=>!x || x===\".\" || x===\"..\" || /[ .:]$/.test(x) || x.includes(\":\") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)/i.test(x))) throw Error(\"unsafe Windows path component\");\n      const normalized=p.resolve(value).toLowerCase(), root=p.resolve(source).toLowerCase();\n      if (normalized===root || normalized.startsWith(root+p.sep) && !normalized.startsWith(p.join(root,\"target\")+p.sep)) throw Error(\"Windows output is inside source\");\n      let current=value.slice(0,3);\n      for (const part of pieces) {\n        current=p.join(current,part);\n        try { const st=fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink() || p.resolve(fs.realpathSync(current)).toLowerCase()!==p.resolve(current).toLowerCase()) throw Error(\"Windows path reparse or alias\"); }\n        catch(e) { if (e.code===\"ENOENT\") break; throw e; }\n      }\n    ' || fail \"Windows 目录首次写入前预检失败\"\n  done\n}\n\nassert_safe_directory_path() {\n  local path=\"$1\" label=\"$2\" component current=''\n  local -a components\n  [[ -n \"$path\" && \"$path\" == /* && \"$path\" != */ && \"$path\" != *//* ]] \\\n    || fail \"$label 必须使用不含重复分隔符的绝对规范路径：${path:-<empty>}\"\n  IFS='/' read -r -a components <<<\"$path\"\n  # 先验证完整词法路径，再检查既存祖先。不能在第一个不存在的目录处停止词法检查，\n  # 否则 `missing/../target` 会绕过零写预检，直到平台工具检查才失败。\n  for component in \"${components[@]}\"; do\n    [[ -n \"$component\" ]] || continue\n    [[ \"$component\" != . && \"$component\" != .. ]] \\\n      || fail \"$label 禁止包含 . 或 .. 路径段：$path\"\n  done\n  for component in \"${components[@]}\"; do\n    [[ -n \"$component\" ]] || continue\n    current=\"$current/$component\"\n    [[ ! -L \"$current\" ]] || fail \"$label 的既存路径祖先禁止使用符号链接：$current\"\n    if [[ -e \"$current\" && ! -d \"$current\" ]]; then\n      fail \"$label 的既存路径不是目录：$current\"\n    fi\n    [[ -e \"$current\" ]] || break\n  done\n}\n\ncanonical_directory() {\n  local path=\"$1\" label=\"$2\"\n  [[ -n \"$path\" ]] || fail \"缺少 $label\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  mkdir -p \"$path\"\n  (cd \"$path\" && pwd -P)\n}\n\n# 两个输出必须在任何 mkdir 前一起通过；这样第二个参数无效时，第一个参数也不会留下目录。\noutput_paths_preflight() {\n  local work=\"${CITIZENSDK_WORK_DIR:-}\" output=\"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\" path\n  for path in \"$work\" \"$output\"; do\n    [[ -n \"$path\" ]] || fail \"缺少 CitizenSDK 工作或产物目录\"\n    assert_safe_directory_path \"$path\" \"CitizenSDK 输出目录\"\n    case \"$path/\" in \"$sdk_dir/target/\"*) ;; \"$sdk_dir/\"*) fail \"工作目录或产物目录位于 CitizenSDK 源码树：$path\" ;; esac\n  done\n  [[ \"$work\" != \"$output\" ]] || fail \"工作目录与产物目录不能相同\"\n  case \"$work/\" in \"$output/\"*) fail \"工作目录不能位于产物目录内\" ;; esac\n  case \"$output/\" in \"$work/\"*) fail \"产物目录不能位于工作目录内\" ;; esac\n}\n\nlocal_build_path_is_allowed() {\n  local path=\"$1\"\n  # 产品入口只禁止写入自身源码；调用方可以选择任意其它绝对输出目录，\n  # 不要求安装或使用任何外部控制程序。\n  case \"$path/\" in \"$sdk_dir/target/\"*) ;; \"$sdk_dir/\"*) return 1 ;; esac\n  [[ \"$path\" == /* && \"$path\" != / ]]\n}\n\nif [[ \"$target_name\" == Windows ]]; then windows_path_preflight; fi\noutput_paths_preflight\n\n# 本机调用只要求输出位于产品源码树之外；产品入口不依赖特定调用程序。\nfor path in \"${CITIZENSDK_WORK_DIR:-}\" \"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\"; do\n  assert_safe_directory_path \"$path\" 本机构建目录\n  local_build_path_is_allowed \"$path\" \\\n    || fail \"本机构建目录必须位于 CitizenSDK 源码树之外：${path:-<empty>}\"\ndone\n\nwork_dir=\"$(canonical_directory \"${CITIZENSDK_WORK_DIR:-}\" CITIZENSDK_WORK_DIR)\"\noutput_dir=\"$(canonical_directory \"${CITIZENSDK_NATIVE_OUTPUT_DIR:-}\" CITIZENSDK_NATIVE_OUTPUT_DIR)\"\n\n# 无论本机还是CI runner，都禁止把Cargo、二进制或符号清单\n# 回写到SDK源码树；除此之外，产品入口不要求调用方使用特定外部目录。\nfor directory in \"$work_dir\" \"$output_dir\"; do\n  case \"$directory/\" in\n    \"$sdk_dir/target/\"*) ;;\n    \"$sdk_dir/\"*) fail \"工作目录或产物目录位于 CitizenSDK 源码树：$directory\" ;;\n  esac\n  local_build_path_is_allowed \"$directory\" \\\n    || fail \"本机构建真实路径必须位于 CitizenSDK 源码树之外：$directory\"\ndone\n\nrequire_rust_target() {\n  local target=\"$1\"\n  local compiler=\"${RUSTC:-rustc}\" sysroot libdir library\n  # 检查实际编译器的标准库，不查询另一份rustup，更不能由产品任务下载组件。\n  sysroot=\"$(\"$compiler\" --print sysroot)\" || fail '无法读取Rust sysroot'\n  libdir=\"$(\"$compiler\" --print target-libdir --target \"$target\")\" || fail \"Rust目标无效：$target\"\n  # Windows官方路径使用反斜线；统一分隔符后仍检查同一个真实sysroot。\n  sysroot=\"${sysroot//\\\\//}\"; libdir=\"${libdir//\\\\//}\"\n  [[ \"$libdir\" == \"$sysroot/lib/rustlib/$target/lib\" && -d \"$libdir\" && ! -L \"$libdir\" ]] \\\n    || fail \"Rust 目标未预装：$target\"\n  for library in \"$libdir\"/libstd-*.rlib; do [[ -s \"$library\" && ! -L \"$library\" ]] && return 0; done\n  fail \"Rust 目标标准库缺失：$target\"\n}\n\nassert_new_file() {\n  [[ ! -e \"$1\" && ! -L \"$1\" ]] || fail \"目标文件已存在或是符号链接，拒绝覆盖：$1\"\n}\n\nassert_descendant_path() {\n  local root=\"$1\" path=\"$2\" label=\"$3\"\n  [[ \"$path\" != \"$root\" ]] || fail \"$label 不能等于受控根目录：$path\"\n  case \"$path/\" in\n    \"$root/\"*) ;;\n    *) fail \"$label 越出受控根目录 $root：$path\" ;;\n  esac\n}\n\nprepare_safe_directory() {\n  local root=\"$1\" path=\"$2\" label=\"$3\" real_path\n  assert_descendant_path \"$root\" \"$path\" \"$label\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  mkdir -p \"$path\"\n  # mkdir 后必须重新逐级 lstat；这样预置的 live/dangling symlink 或非目录\n  # 祖先都不能被后续 Cargo、cp、lipo 或重定向跟随到受控根之外。\n  assert_safe_directory_path \"$path\" \"$label\"\n  [[ -d \"$path\" && ! -L \"$path\" ]] || fail \"$label 不是普通目录：$path\"\n  real_path=\"$(cd \"$path\" && pwd -P)\"\n  case \"$real_path/\" in\n    \"$root/\"*) ;;\n    *) fail \"$label 的真实路径越出受控根目录 ${root}：$real_path\" ;;\n  esac\n  [[ \"$real_path\" == \"$path\" ]] || fail \"$label 的真实路径发生漂移：$path -> $real_path\"\n}\n\n# GRADLE_USER_HOME 是调用产品提供的包管理器缓存，不是 CitizenSDK 编译物。\n# 它可以位于 SDK 工作根之外，但必须是源码树之外的安全真实目录；SDK 自有\n# Gradle 工程、项目缓存、Kotlin 状态和原生产物仍只能写入 work_dir。\nprepare_external_cache_directory() {\n  local path=\"$1\" label=\"$2\" real_path\n  assert_safe_directory_path \"$path\" \"$label\"\n  mkdir -p \"$path\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  [[ -d \"$path\" && ! -L \"$path\" ]] || fail \"$label 不是普通目录：$path\"\n  real_path=\"$(cd \"$path\" && pwd -P)\"\n  [[ \"$real_path\" == \"$path\" ]] || fail \"$label 的真实路径发生漂移：$path -> $real_path\"\n  local_build_path_is_allowed \"$real_path\" \\\n    || fail \"$label 必须位于 CitizenSDK 源码树之外：$real_path\"\n}\n\nprepare_safe_output_file() {\n  local root=\"$1\" path=\"$2\" label=\"$3\" parent\n  assert_descendant_path \"$root\" \"$path\" \"$label\"\n  [[ \"${path##*/}\" != . && \"${path##*/}\" != .. ]] \\\n    || fail \"$label 文件名无效：$path\"\n  assert_new_file \"$path\"\n  parent=\"$(dirname \"$path\")\"\n  prepare_safe_directory \"$root\" \"$parent\" \"$label 父目录\"\n  # 父目录创建后再 lstat 最终项，特别拒绝 `-e` 看不到的 dangling symlink。\n  assert_new_file \"$path\"\n}\n\nassert_readonly_dependency_directory() {\n  local path=\"$1\" label=\"$2\" real_path\n  [[ -n \"$path\" ]] || fail \"缺少 $label\"\n  assert_safe_directory_path \"$path\" \"$label\"\n  [[ -d \"$path\" && ! -L \"$path\" ]] \\\n    || fail \"$label 必须是既存普通目录：$path\"\n  real_path=\"$(cd \"$path\" && pwd -P)\"\n  [[ \"$real_path\" == \"$path\" ]] \\\n    || fail \"$label 的真实路径发生漂移：$path -> $real_path\"\n}\n\nassert_readonly_static_archive() {\n  local path=\"$1\" label=\"$2\" parent real_parent\n  [[ -n \"$path\" && \"$path\" == /* && \"$path\" == *.a ]] \\\n    || fail \"$label 必须是绝对 .a 路径：${path:-<empty>}\"\n  parent=\"$(dirname \"$path\")\"\n  assert_safe_directory_path \"$parent\" \"$label 父目录\"\n  [[ -f \"$path\" && ! -L \"$path\" ]] \\\n    || fail \"$label 必须是既存普通静态归档：$path\"\n  real_parent=\"$(cd \"$parent\" && pwd -P)\"\n  [[ \"$real_parent\" == \"$parent\" ]] \\\n    || fail \"$label 父目录的真实路径发生漂移：$parent -> $real_parent\"\n}\n\ncargo_target_dir=\"$work_dir/cargo\"\nprepare_safe_directory \"$work_dir\" \"$cargo_target_dir\" \"Cargo target 目录\"\nexport CARGO_TARGET_DIR=\"$cargo_target_dir\"\n\nsymbol_list_android() {\n  local library=\"$1\" nm_bin=\"$2\"\n  {\n    \"$nm_bin\" -D --defined-only \"$library\" 2>/dev/null \\\n      | awk '{ print $NF }' \\\n      | grep -E '^(smoldot_|citizen_[a-z0-9_]+|account_crypto_)' \\\n      | sort -u\n  } || true\n}\n\nsymbol_list_ios() {\n  local library=\"$1\" nm_bin=\"$2\"\n  {\n    (\"$nm_bin\" -g --defined-only \"$library\" 2>/dev/null || true) \\\n      | awk '$2 == \"T\" { print $3 }' \\\n      | grep -E '^_(smoldot_|citizen_[a-z0-9_]+|account_crypto_)' \\\n      | sort -u\n  } || true\n}\n\nverify_symbol_contract() {\n  local symbols=\"$1\" prefix=\"$2\" label=\"$3\" normalized signer_count smoldot_count\n  normalized=\"$(printf '%s\\n' \"$symbols\" | sed \"s/^${prefix}//\")\"\n  smoldot_count=\"$(printf '%s\\n' \"$normalized\" | grep -c '^smoldot_' || true)\"\n  signer_count=\"$(printf '%s\\n' \"$normalized\" | grep -c '^citizen_sr25519_' || true)\"\n  [[ \"$smoldot_count\" -gt 0 ]] || fail \"$label 缺少 smoldot_* 轻节点符号\"\n  [[ \"$signer_count\" -eq 4 ]] || fail \"$label 的 citizen_sr25519_* 符号必须正好为 4 个\"\n  for symbol in \\\n    citizen_sr25519_derive_hard \\\n    citizen_sr25519_public_key \\\n    citizen_sr25519_sign \\\n    citizen_sr25519_verify; do\n    printf '%s\\n' \"$normalized\" | grep -Fxq \"$symbol\" || fail \"$label 缺少 $symbol\"\n  done\n  if printf '%s\\n' \"$normalized\" | grep -Eq '^(citizen_chat_mls_|account_crypto_)'; then\n    fail \"$label 混入聊天或产品账户密码学符号\"\n  fi\n}\n\nproduct_header_symbols() {\n  perl -0777 -ne 'while (/\\b(citizensdk_[a-z0-9_]+)\\s*\\((?!\\s*\\*)/g) { print \"$1\\n\" }' \\\n    \"$product_header\" | sort -u\n}\n\n# 公开144符号精确封闭，旧窗口私有符号已清零；内部模块只复用公开声明。\nproduct_internal_symbols() {\n  node --input-type=module - \"$script_dir/build.mjs\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nconst {CITIZENSDK_INTERNAL_SYMBOLS} = await import(pathToFileURL(process.argv[2]));\nif (CITIZENSDK_INTERNAL_SYMBOLS.length) process.stdout.write(CITIZENSDK_INTERNAL_SYMBOLS.join('\\n') + '\\n');\nNODE\n}\n\nproduct_linked_symbols() {\n  { product_header_symbols; product_internal_symbols; } | LC_ALL=C sort -u\n}\n\nprepare_internal_header() {\n  local directory=\"$work_dir/private-include\"\n  prepare_safe_directory \"$work_dir\" \"$directory\" \"SDK私有声明目录\"\n  node --input-type=module - \"$script_dir/build.mjs\" \"$directory\" \"$qr_image_header\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {writeFileSync, readFileSync, lstatSync} from 'node:fs';\nimport {join} from 'node:path';\nconst {citizenSdkInternalHeader} = await import(pathToFileURL(process.argv[2]));\nconst qrImageHeader = readFileSync(process.argv[4], 'utf8');\n// 同轮Apple各slice复用唯一声明；只接受完全相同的普通独占文件，绝不覆盖漂移。\nfor (const [name, text] of [\n  ['citizensdk_internal.h', citizenSdkInternalHeader()],\n  ['citizensdk_qr_image.h', qrImageHeader],\n  ['module.modulemap', 'module CitizenSDKInternal {\\n  header \"citizensdk_internal.h\"\\n  header \"citizensdk_qr_image.h\"\\n  export *\\n}\\n'],\n]) {\n  const path = join(process.argv[3], name);\n  const info = lstatSync(path, {throwIfNoEntry: false});\n  if (info) {\n    if (!info.isFile() || info.nlink !== 1 || readFileSync(path, 'utf8') !== text) {\n      throw Error('SDK私有构建声明漂移：' + name);\n    }\n  } else fs.writeFileSync(path, text, {flag: 'wx', mode: 0o600});\n}\nNODE\n}\n\nproduct_library_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" prefix=\"$3\"\n  local raw_symbols\n  if [[ -n \"$prefix\" ]]; then\n    raw_symbols=\"$(\"$nm_bin\" -g --defined-only \"$library\" 2>/dev/null)\" \\\n      || fail \"无法读取 CitizenSDK 产品 ABI 的 Mach-O 外部已定义符号\"\n  else\n    raw_symbols=\"$(\"$nm_bin\" -D -g --defined-only \"$library\" 2>/dev/null)\" \\\n      || fail \"无法读取 CitizenSDK 产品 ABI 的 ELF 动态导出符号\"\n  fi\n  # 必须先取得完整外部已定义/动态导出集合，再统一去掉 Mach-O 的单个前导\n  # 下划线。禁止先按已知前缀 grep，否则 foreign_probe 等额外全局符号会消失。\n  printf '%s\\n' \"$raw_symbols\" \\\n    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \\\n    | sed \"s/^${prefix}//\" \\\n    | LC_ALL=C sort -u\n}\n\nverify_product_abi_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" prefix=\"$3\" label=\"$4\"\n  local actual expected forbidden\n  actual=\"$(product_library_symbols \"$library\" \"$nm_bin\" \"$prefix\")\"\n  expected=\"$(product_linked_symbols)\"\n  # Android 证书初始化只在 Android Core 中导出；其它平台的144个公开函数不变。\n  if [[ \"$label\" == 'Android libcitizensdk.so' ]]; then\n    expected=\"$(printf '%s\\n%s\\n' \"$expected\" citizensdk_android_init_tls | LC_ALL=C sort -u)\"\n  fi\n  forbidden=\"$(printf '%s\\n' \"$actual\" \\\n    | grep -E '^(smoldot_|citizen_sr25519_|account_crypto_)' || true)\"\n  [[ -z \"$forbidden\" ]] \\\n    || fail \"$label 泄露低层或密码学符号：$(printf '%s' \"$forbidden\" | tr '\\n' ' ')\"\n  [[ \"$actual\" == \"$expected\" ]] || {\n    local missing extra\n    missing=\"$(comm -23 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    extra=\"$(comm -13 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    fail \"$label 与产品头及既定内部符号闭集不一致；缺失=${missing:-无}；额外=${extra:-无}\"\n  }\n}\n\njni_library_symbols() {\n  local library=\"$1\" nm_bin=\"$2\"\n  \"$nm_bin\" -D -g --defined-only \"$library\" 2>/dev/null \\\n    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \\\n    | LC_ALL=C sort -u\n}\n\nverify_jni_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" symbols\n  symbols=\"$(jni_library_symbols \"$library\" \"$nm_bin\")\" \\\n    || fail \"无法读取 CitizenSDK Android JNI 动态导出\"\n  [[ \"$symbols\" == 'JNI_OnLoad@@CITIZENSDK_JNI_1.0' ]] \\\n    || fail \"Android JNI 全局导出必须精确为版本化 JNI_OnLoad；实际=${symbols:-无}\"\n}\n\nandroid_elf_dynamic_values() {\n  local library=\"$1\" readelf_bin=\"$2\" tag=\"$3\"\n  \"$readelf_bin\" -d \"$library\" 2>/dev/null \\\n    | sed -n \"s/.*(${tag}).*\\[\\([^]]*\\)\\].*/\\1/p\"\n}\n\nverify_android_elf_identity() {\n  local core_library=\"$1\" jni_library=\"$2\" readelf_bin=\"$3\"\n  local core_soname jni_soname core_needed jni_needed core_dependency_count\n  [[ -x \"$readelf_bin\" ]] || fail \"Android NDK llvm-readelf 不可执行：$readelf_bin\"\n  core_soname=\"$(android_elf_dynamic_values \"$core_library\" \"$readelf_bin\" SONAME)\"\n  jni_soname=\"$(android_elf_dynamic_values \"$jni_library\" \"$readelf_bin\" SONAME)\"\n  core_needed=\"$(android_elf_dynamic_values \"$core_library\" \"$readelf_bin\" NEEDED)\"\n  jni_needed=\"$(android_elf_dynamic_values \"$jni_library\" \"$readelf_bin\" NEEDED)\"\n  [[ \"$core_soname\" == libcitizensdk.so ]] \\\n    || fail \"Android Core SONAME 必须精确为 libcitizensdk.so；实际=${core_soname:-无}\"\n  [[ \"$jni_soname\" == libcitizensdk_jni.so ]] \\\n    || fail \"Android JNI SONAME 必须精确为 libcitizensdk_jni.so；实际=${jni_soname:-无}\"\n  if printf '%s\\n%s\\n' \"$core_needed\" \"$jni_needed\" | grep -q '/'; then\n    fail \"Android ELF DT_NEEDED 禁止包含构建机路径\"\n  fi\n  core_dependency_count=\"$(printf '%s\\n' \"$jni_needed\" \\\n    | grep -Fxc libcitizensdk.so || true)\"\n  [[ \"$core_dependency_count\" == 1 ]] \\\n    || fail \"Android JNI 必须精确依赖一次 libcitizensdk.so；实际=${core_dependency_count}\"\n}\n\nlinux_host_header_symbols() {\n  local header=\"$linux_source_root/headers/citizensdk_host.h\"\n  [[ -f \"$header\" && ! -L \"$header\" ]] \\\n    || fail \"Linux Host 公共头缺失或不是普通文件：$header\"\n  perl -0777 -ne \\\n    'while (/\\b(citizensdk_host_[a-z0-9_]+)\\s*\\(/g) { print \"$1\\n\" }' \\\n    \"$header\" | LC_ALL=C sort -u\n}\n\nlinux_elf_dynamic_values() {\n  local library=\"$1\" readelf_bin=\"$2\" tag=\"$3\"\n  \"$readelf_bin\" -d \"$library\" 2>/dev/null \\\n    | sed -n \"s/.*(${tag}).*\\[\\([^]]*\\)\\].*/\\1/p\"\n}\n\nversion_is_greater() {\n  local value=\"$1\" maximum=\"$2\"\n  [[ \"$value\" != \"$maximum\" \\\n    && \"$(printf '%s\\n%s\\n' \"$value\" \"$maximum\" | sort -V | tail -n 1)\" == \"$value\" ]]\n}\n\nverify_linux_glibc_contract() {\n  local library=\"$1\" readelf_bin=\"$2\" label=\"$3\" versions version version_info\n  local allow_cpp_runtime=\"${4:-false}\"\n  # 工具失败不能当成“没有版本需求”；先取得完整输出，再解析允许的数字版本。\n  version_info=\"$(\"$readelf_bin\" --version-info \"$library\" 2>/dev/null)\" \\\n    || fail \"无法读取 $label 的 ELF version-info\"\n  if printf '%s\\n' \"$version_info\" | grep -Eq 'GLIBC_[A-Za-z]'; then\n    fail \"$label 包含不能按 GLIBC_$linux_glibc_baseline 验证的版本需求\"\n  fi\n  versions=\"$(printf '%s\\n' \"$version_info\" \\\n    | grep -oE 'GLIBC_[0-9]+(\\.[0-9]+)*' \\\n    | sed 's/^GLIBC_//' | sort -Vu || true)\"\n  while IFS= read -r version; do\n    [[ -n \"$version\" ]] || continue\n    ! version_is_greater \"$version\" \"$linux_glibc_baseline\" \\\n      || fail \"$label 要求 GLIBC_${version}，超过固定基线 GLIBC_$linux_glibc_baseline\"\n  done <<<\"$versions\"\n  if [[ \"$allow_cpp_runtime\" != true ]] \\\n      && printf '%s\\n' \"$version_info\" | grep -Eq 'GLIBCXX_|CXXABI_'; then\n    fail \"$label 禁止依赖宿主 libstdc++/CXX ABI；C++ runtime 必须静态装配\"\n  fi\n}\n\nlinux_install_files() {\n  local platform=\"$1\"\n  case \"$platform\" in LinuxARM|LinuxAMD) ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  printf '%s\\n' \\\n    include/citizensdk.h include/citizensdk_types.h include/citizensdk_qr_image.h \\\n    include/citizen_sdk/citizen_sdk.hpp \\\n    include/citizen_sdk/citizen_sdk_config.hpp \\\n    include/citizen_sdk/citizen_sdk_error.hpp \\\n    include/citizen_sdk/citizen_sdk_events.hpp \\\n    include/citizen_sdk/citizen_sdk_models.hpp \\\n    include/citizen_sdk/citizensdk_host.h \\\n    \"lib/$platform/libcitizensdk.so\" \"lib/$platform/libcitizensdk_host.so\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKConfig.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKDependencies.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKTargets.cmake\" \\\n    \"lib/$platform/cmake/CitizenSDK/CitizenSDKTargets-release.cmake\" \\\n    share/citizensdk/chain/manifest.json \\\n    share/citizensdk/chain/chainspec.json \\\n    share/citizensdk/chain/light_sync_state.json \\\n    | LC_ALL=C sort\n}\n\nverify_linux_install() {\n  local prefix=\"$1\" platform=\"$2\" software_version=\"$3\" source_core=\"$4\"\n  local readelf_bin=\"$5\" nm_bin=\"$6\" expected actual directories path parent package_dir\n  local expected_directories='' version declarations core_symbols host_symbols\n  assert_safe_directory_path \"$prefix\" \"$platform 安装前缀\"\n  [[ -d \"$prefix\" && ! -L \"$prefix\" ]] || fail \"$platform 安装前缀不是普通目录\"\n  [[ -z \"$(find \"$prefix\" -mindepth 1 ! -type f ! -type d -print -quit)\" ]] \\\n    || fail \"$platform 安装投影禁止符号链接和特殊节点\"\n  expected=\"$(linux_install_files \"$platform\")\"\n  [[ \"$(printf '%s\\n' \"$expected\" | wc -l | tr -d ' ')\" == 19 ]] \\\n    || fail \"$platform 安装文件合同必须精确为 19 项\"\n  actual=\"$(cd \"$prefix\" && find . -type f -print | sed 's|^./||' | LC_ALL=C sort)\"\n  [[ \"$actual\" == \"$expected\" ]] || fail \"$platform 安装文件闭集不一致\"\n  while IFS= read -r path; do\n    parent=\"$(dirname \"$path\")\"\n    while [[ \"$parent\" != . ]]; do\n      expected_directories+=\"$parent\"$'\\n'\n      parent=\"$(dirname \"$parent\")\"\n    done\n  done <<<\"$expected\"\n  directories=\"$(cd \"$prefix\" && find . -mindepth 1 -type d -print \\\n    | sed 's|^./||' | LC_ALL=C sort)\"\n  expected_directories=\"$(printf '%s' \"$expected_directories\" | LC_ALL=C sort -u)\"\n  [[ \"$directories\" == \"$expected_directories\" ]] || fail \"$platform 安装目录闭集不一致\"\n  for path in citizensdk.h citizensdk_types.h; do\n    cmp -s \"$sdk_dir/include/$path\" \"$prefix/include/$path\" \\\n      || fail \"$platform 安装 Core 头字节漂移：$path\"\n  done\n  cmp -s \"$qr_image_header\" \"$prefix/include/citizensdk_qr_image.h\" \\\n    || fail \"$platform 安装统一 QR 图像头字节漂移\"\n  for path in citizen_sdk.hpp citizen_sdk_config.hpp citizen_sdk_error.hpp \\\n      citizen_sdk_events.hpp citizen_sdk_models.hpp citizensdk_host.h; do\n    local source_header=\"$linux_source_root/headers/$path\"\n    case \"$path\" in citizen_sdk_error.hpp|citizen_sdk_events.hpp|citizen_sdk_models.hpp) source_header=\"$sdk_dir/include/$path\" ;; esac\n    cmp -s \"$source_header\" \"$prefix/include/citizen_sdk/$path\" \\\n      || fail \"$platform 安装 Host 头字节漂移：$path\"\n  done\n  for path in manifest.json chainspec.json light_sync_state.json; do\n    cmp -s \"$apple_asset_root/$path\" \"$prefix/share/citizensdk/chain/$path\" \\\n      || fail \"$platform 安装链资产字节漂移：$path\"\n  done\n  cmp -s \"$source_core\" \"$prefix/lib/$platform/libcitizensdk.so\" \\\n    || fail \"$platform 安装 Core 字节漂移\"\n  package_dir=\"$prefix/lib/$platform/cmake/CitizenSDK\"\n  cmp -s \"$linux_source_root/cmake/CitizenSDKDependencies.cmake\" \\\n    \"$package_dir/CitizenSDKDependencies.cmake\" || fail \"$platform 安装依赖合同漂移\"\n  version=\"$(sed -n 's/^set(PACKAGE_VERSION \"\\([^\"]*\\)\")$/\\1/p' \\\n    \"$package_dir/CitizenSDKConfigVersion.cmake\")\"\n  [[ \"$version\" == \"$software_version\" ]] || fail \"$platform 安装版本不一致\"\n  declarations=\"$(sed -n 's/^set(_CITIZENSDK_PACKAGE_PLATFORM \"\\([^\"]*\\)\")$/\\1/p' \\\n    \"$package_dir/CitizenSDKConfig.cmake\")\"\n  [[ \"$declarations\" == \"$platform\" ]] || fail \"$platform 安装平台不一致\"\n  # 已安装 package 必须可搬动，不能靠源码或这次构建目录找到头和运行库。\n  if grep -F -e \"$sdk_dir\" -e \"$work_dir\" \"$package_dir\"/*.cmake >/dev/null; then\n    fail \"$platform 安装配置泄漏源码或构建绝对路径\"\n  fi\n  core_symbols=\"$(product_header_symbols)\"\n  host_symbols=\"$(linux_host_header_symbols)\"\n  [[ \"$(printf '%s\\n' \"$core_symbols\" | wc -l | tr -d ' ')\" == 144 \\\n    && \"$(printf '%s\\n' \"$host_symbols\" | wc -l | tr -d ' ')\" == 19 ]] \\\n    || fail \"$platform 公开 ABI 必须精确为 144 Core / 19 Host\"\n  verify_linux_elf_identity \"$platform\" \"$prefix/lib/$platform/libcitizensdk.so\" \\\n    \"$prefix/lib/$platform/libcitizensdk_host.so\" \"$readelf_bin\" \"$nm_bin\"\n}\n\ncopy_linux_install() {\n  local source_prefix=\"$1\" destination_prefix=\"$2\" platform=\"$3\" destination_root=\"$4\"\n  local paths path source destination\n  assert_safe_directory_path \"$source_prefix\" \"$platform 安装投影来源\"\n  [[ -d \"$source_prefix\" && ! -L \"$source_prefix\" ]] \\\n    || fail \"$platform 安装投影来源必须是普通目录\"\n  paths=\"$(linux_install_files \"$platform\")\"\n  assert_descendant_path \"$destination_root\" \"$destination_prefix\" \"$platform 安装投影目标\"\n  assert_safe_directory_path \"$destination_prefix\" \"$platform 安装投影目标\"\n  # 唯一19项名单同时用于外部native输入和Flutter包内投影。源码已有的\n  # 七个 Host 公开头只做字节比较，绝不覆盖不同版本或复制整个未受控目录。\n  # 全量预检完成后才写入，缺项或重叠漂移不会留下半份安装投影。\n  while IFS= read -r path; do\n    source=\"$source_prefix/$path\"\n    destination=\"$destination_prefix/$path\"\n    assert_safe_directory_path \"$(dirname \"$source\")\" \"$platform 安装文件来源父目录\"\n    assert_safe_directory_path \"$(dirname \"$destination\")\" \"$platform 安装文件目标父目录\"\n    [[ -f \"$source\" && ! -L \"$source\" ]] \\\n      || fail \"$platform 安装投影缺少普通文件：$path\"\n    if [[ -e \"$destination\" || -L \"$destination\" ]]; then\n      [[ -f \"$destination\" && ! -L \"$destination\" ]] \\\n        || fail \"$platform 重叠安装文件类型无效：$path\"\n      cmp -s \"$source\" \"$destination\" \\\n        || fail \"$platform 重叠安装文件字节漂移：$path\"\n    fi\n  done <<<\"$paths\"\n  prepare_safe_directory \"$destination_root\" \"$destination_prefix\" \"$platform 安装投影目标\"\n  while IFS= read -r path; do\n    source=\"$source_prefix/$path\"\n    destination=\"$destination_prefix/$path\"\n    if [[ ! -e \"$destination\" && ! -L \"$destination\" ]]; then\n      prepare_safe_output_file \"$destination_root\" \"$destination\" \"$platform 安装投影文件\"\n      cp \"$source\" \"$destination\"\n    fi\n  done <<<\"$paths\"\n}\n\nverify_linux_machine() {\n  local library=\"$1\" readelf_bin=\"$2\" expected_machine=\"$3\" label=\"$4\"\n  local header machine\n  header=\"$(LC_ALL=C \"$readelf_bin\" -h \"$library\" 2>/dev/null)\" \\\n    || fail \"无法读取 $label 的 ELF header\"\n  printf '%s\\n' \"$header\" | grep -Eq 'Class:[[:space:]]+ELF64' \\\n    || fail \"$label 必须是 ELF64\"\n  printf '%s\\n' \"$header\" \\\n    | grep -Eq 'Data:[[:space:]]+2.s complement, little endian' \\\n    || fail \"$label 必须是 little-endian ELF\"\n  printf '%s\\n' \"$header\" | grep -Eq 'Type:[[:space:]]+DYN' \\\n    || fail \"$label 必须是 ET_DYN shared object\"\n  machine=\"$(printf '%s\\n' \"$header\" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')\"\n  [[ \"$machine\" == \"$expected_machine\" ]] \\\n    || fail \"$label 机器类型漂移：预期=${expected_machine}；实际=${machine:-无}\"\n}\n\nverify_linux_host_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" label=\"$3\" actual expected forbidden\n  actual=\"$(product_library_symbols \"$library\" \"$nm_bin\" '')\"\n  expected=\"$({ linux_host_header_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u)\"\n  forbidden=\"$(printf '%s\\n' \"$actual\" \\\n    | grep -E '^(citizensdk_|smoldot_|citizen_sr25519_|account_crypto_)' \\\n    | grep -Ev '^citizensdk_(host_|qr_image_)' \\\n    || true)\"\n  [[ -z \"$forbidden\" ]] \\\n    || fail \"$label 重复导出 Core 或低层符号：$(printf '%s' \"$forbidden\" | tr '\\n' ' ')\"\n  [[ \"$actual\" == \"$expected\" ]] || {\n    local missing extra\n    missing=\"$(comm -23 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    extra=\"$(comm -13 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    fail \"$label 与 citizensdk_host.h 不一致；缺失=${missing:-无}；额外=${extra:-无}\"\n  }\n}\n\nverify_linux_elf_identity() {\n  local platform=\"$1\" core_library=\"$2\" host_library=\"$3\" readelf_bin=\"$4\" nm_bin=\"$5\"\n  local expected_machine core_soname host_soname core_needed host_needed\n  local core_rpath core_runpath host_rpath host_runpath core_dependency_count\n  case \"$platform\" in\n    LinuxARM) expected_machine=AArch64 ;;\n    LinuxAMD) expected_machine='Advanced Micro Devices X86-64' ;;\n    *) fail \"未登记的 Linux 平台：$platform\" ;;\n  esac\n  [[ -x \"$readelf_bin\" && -x \"$nm_bin\" ]] \\\n    || fail \"$platform 缺少可执行 readelf/nm\"\n  for library in \"$core_library\" \"$host_library\"; do\n    [[ -f \"$library\" && ! -L \"$library\" ]] \\\n      || fail \"$platform 运行件必须是普通文件：$library\"\n  done\n  verify_linux_machine \"$core_library\" \"$readelf_bin\" \"$expected_machine\" \\\n    \"$platform Core\"\n  verify_linux_machine \"$host_library\" \"$readelf_bin\" \"$expected_machine\" \\\n    \"$platform Host\"\n  core_soname=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" SONAME)\"\n  host_soname=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" SONAME)\"\n  core_needed=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" NEEDED)\"\n  host_needed=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" NEEDED)\"\n  core_rpath=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" RPATH)\"\n  core_runpath=\"$(linux_elf_dynamic_values \"$core_library\" \"$readelf_bin\" RUNPATH)\"\n  host_rpath=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" RPATH)\"\n  host_runpath=\"$(linux_elf_dynamic_values \"$host_library\" \"$readelf_bin\" RUNPATH)\"\n  [[ \"$core_soname\" == libcitizensdk.so ]] \\\n    || fail \"$platform Core SONAME 漂移：${core_soname:-无}\"\n  [[ \"$host_soname\" == libcitizensdk_host.so ]] \\\n    || fail \"$platform Host SONAME 漂移：${host_soname:-无}\"\n  [[ -z \"$core_rpath\" && -z \"$core_runpath\" ]] \\\n    || fail \"$platform Core 禁止 RPATH/RUNPATH\"\n  [[ -z \"$host_rpath\" && \"$host_runpath\" == '$ORIGIN' ]] \\\n    || fail \"$platform Host RUNPATH 必须精确为字面量 \\$ORIGIN\"\n  if printf '%s\\n%s\\n' \"$core_needed\" \"$host_needed\" | grep -q '/'; then\n    fail \"$platform DT_NEEDED 禁止包含构建机路径\"\n  fi\n  if printf '%s\\n%s\\n' \"$core_needed\" \"$host_needed\" \\\n      | grep -Eq '(^|/)(libsmoldot|libstdc\\+\\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)'; then\n    fail \"$platform 运行件泄漏禁止的动态依赖\"\n  fi\n  core_dependency_count=\"$(printf '%s\\n' \"$host_needed\" \\\n    | grep -Fxc libcitizensdk.so || true)\"\n  [[ \"$core_dependency_count\" == 1 ]] \\\n    || fail \"$platform Host 必须精确依赖一次 libcitizensdk.so\"\n  verify_product_abi_symbols \"$core_library\" \"$nm_bin\" '' \"$platform Core\"\n  verify_linux_host_symbols \"$host_library\" \"$nm_bin\" \"$platform Host\"\n  verify_linux_glibc_contract \"$core_library\" \"$readelf_bin\" \"$platform Core\"\n  verify_linux_glibc_contract \"$host_library\" \"$readelf_bin\" \"$platform Host\"\n}\n\nresolve_gradle() {\n  local executable=\"${CITIZENSDK_GRADLE:-}\" link_target\n  if [[ -z \"$executable\" ]]; then\n    executable=\"$(command -v gradle || true)\"\n  fi\n  [[ -n \"$executable\" ]] \\\n    || fail \"缺少 Gradle；请用 CITIZENSDK_GRADLE 指向受控 gradle/gradlew 绝对路径\"\n  [[ \"$executable\" == /* ]] || fail \"CITIZENSDK_GRADLE 必须解析为绝对路径\"\n  while [[ -L \"$executable\" ]]; do\n    link_target=\"$(readlink \"$executable\")\"\n    [[ \"$link_target\" == /* ]] || link_target=\"$(cd \"$(dirname \"$executable\")\" && pwd -P)/$link_target\"\n    executable=\"$link_target\"\n  done\n  executable=\"$(cd \"$(dirname \"$executable\")\" && pwd -P)/$(basename \"$executable\")\"\n  [[ -f \"$executable\" && -x \"$executable\" ]] \\\n    || fail \"Gradle必须解析到可执行普通文件：$executable\"\n  printf '%s\\n' \"$executable\"\n}\n\n# Android标准assets容器与源码chain分开校验；仅允许精确三文件，逐个回读源码字节。\nverify_android_chain_assets() {\n  local aar=\"$1\" entries asset actual expected\n  entries=\"$(unzip -Z1 \"$aar\")\" || fail \"无法读取 Android AAR 链资产\"\n  actual=\"$(printf '%s\\n' \"$entries\" | grep '^assets/' | grep -v '/$' | LC_ALL=C sort || true)\"\n  expected=$'assets/chain/chainspec.json\\nassets/chain/light_sync_state.json\\nassets/chain/manifest.json'\n  [[ \"$actual\" == \"$expected\" ]] || fail \"Android AAR 链资产闭集漂移\"\n  for asset in \\\n    chain/chainspec.json \\\n    chain/light_sync_state.json \\\n    chain/manifest.json; do\n    printf '%s\\n' \"$entries\" | grep -Fxq \"assets/$asset\" \\\n      || fail \"Android AAR 缺少已验证链资产：$asset\"\n    cmp -s <(unzip -p \"$aar\" \"assets/$asset\") \"$sdk_dir/$asset\" \\\n      || fail \"Android AAR 链资产与源码信任锚字节不一致：$asset\"\n  done\n}\n\nverify_android_aar() {\n  local aar=\"$1\" core_library=\"$2\" jni_library=\"$3\" nm_bin=\"$4\"\n  local entries native_entries expected_native verify_dir aar_core aar_jni classes\n  local class_entries classes_payload\n  command -v unzip >/dev/null 2>&1 || fail \"Android AAR 核验需要 unzip\"\n  [[ -f \"$aar\" && -f \"$core_library\" && -f \"$jni_library\" ]] \\\n    || fail \"Android AAR 或双原生库不完整\"\n  entries=\"$(unzip -Z1 \"$aar\")\" || fail \"无法读取 Android AAR 文件闭集\"\n  native_entries=\"$(printf '%s\\n' \"$entries\" \\\n    | grep -E '^jni/' \\\n    | grep -v '/$' \\\n    | LC_ALL=C sort || true)\"\n  expected_native=$'jni/arm64-v8a/libcitizensdk.so\\njni/arm64-v8a/libcitizensdk_jni.so'\n  [[ \"$native_entries\" == \"$expected_native\" ]] \\\n    || fail \"Android AAR 原生库必须精确为 arm64-v8a 双库；实际=${native_entries:-无}\"\n  printf '%s\\n' \"$entries\" | grep -Fxq AndroidManifest.xml \\\n    || fail \"Android AAR 缺少 AndroidManifest.xml\"\n  printf '%s\\n' \"$entries\" | grep -Fxq classes.jar \\\n    || fail \"Android AAR 缺少 classes.jar\"\n  verify_android_chain_assets \"$aar\"\n  if printf '%s\\n' \"$entries\" | grep -Eq '(^|/)(libsmoldot|libc\\+\\+_shared)\\.so$|\\.aar$'; then\n    fail \"Android AAR 混入 legacy/C++ 共享运行库或嵌套 AAR\"\n  fi\n\n  verify_dir=\"$(mktemp -d \"$work_dir/android-aar-verify.XXXXXX\")\" \\\n    || fail \"无法创建 Android AAR 核验目录\"\n  assert_safe_directory_path \"$verify_dir\" \"Android AAR 核验目录\"\n  aar_core=\"$verify_dir/libcitizensdk.so\"\n  aar_jni=\"$verify_dir/libcitizensdk_jni.so\"\n  classes=\"$verify_dir/classes.jar\"\n  classes_payload=\"$verify_dir/classes.payload\"\n  unzip -p \"$aar\" jni/arm64-v8a/libcitizensdk.so >\"$aar_core\" \\\n    || fail \"无法提取 AAR Core 库\"\n  unzip -p \"$aar\" jni/arm64-v8a/libcitizensdk_jni.so >\"$aar_jni\" \\\n    || fail \"无法提取 AAR JNI 库\"\n  unzip -p \"$aar\" classes.jar >\"$classes\" || fail \"无法提取 AAR classes.jar\"\n  cmp -s \"$core_library\" \"$aar_core\" || fail \"AAR 与外部 libcitizensdk.so 字节不一致\"\n  cmp -s \"$jni_library\" \"$aar_jni\" || fail \"AAR 与外部 libcitizensdk_jni.so 字节不一致\"\n  verify_jni_symbols \"$jni_library\" \"$nm_bin\"\n  verify_android_elf_identity \\\n    \"$core_library\" \"$jni_library\" \"${nm_bin%/*}/llvm-readelf\"\n  class_entries=\"$(unzip -Z1 \"$classes\")\" || fail \"无法读取 AAR classes.jar 闭集\"\n  if printf '%s\\n' \"$class_entries\" | grep -Eq '^io/flutter/'; then\n    fail \"原生 AAR classes.jar 混入 Flutter 类\"\n  fi\n  for required_class in \\\n    org/citizen/sdk/CitizenSdk.class org/citizen/sdk/CitizenSigning.class org/citizen/sdk/CitizenSdkModules.class \\\n    org/citizen/sdk/CitizenSdkOperation.class \\\n    org/citizen/sdk/internal/CitizenSdkNative.class \\\n    org/citizen/sdk/internal/CitizenSdkHardwareVault.class; do\n    printf '%s\\n' \"$class_entries\" | grep -Fxq \"$required_class\" \\\n      || fail \"原生 AAR classes.jar 缺少必需实现：$required_class\"\n  done\n  unzip -p \"$classes\" >\"$classes_payload\" || fail \"无法读取 AAR classes.jar 内容\"\n  if LC_ALL=C grep -a -q 'io/flutter/' \"$classes_payload\"; then\n    fail \"原生 AAR classes.jar 引用了 Flutter API\"\n  fi\n}\n\nandroid_toolchain() {\n  local ndk_home=\"${ANDROID_NDK_HOME:-}\" sdk_home host_tag expected_ndk\n  if [[ -n \"${ANDROID_HOME:-}\" && -n \"${ANDROID_SDK_ROOT:-}\" \\\n    && \"$ANDROID_HOME\" != \"$ANDROID_SDK_ROOT\" ]]; then\n    fail \"ANDROID_HOME 与 ANDROID_SDK_ROOT 指向不同目录\"\n  fi\n  sdk_home=\"${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}\"\n  if [[ -z \"$ndk_home\" ]]; then\n    if [[ -z \"$sdk_home\" ]]; then\n      [[ -n \"${HOME:-}\" ]] || fail \"缺少 Android SDK 环境与 HOME\"\n      case \"$(uname -s)\" in\n        Darwin) sdk_home=\"$HOME/Library/Android/sdk\" ;;\n        Linux) sdk_home=\"$HOME/Android/Sdk\" ;;\n        *) fail \"当前宿主没有登记 Android SDK 标准目录：$(uname -s)\" ;;\n      esac\n    fi\n    assert_safe_directory_path \"$sdk_home\" \"Android SDK\"\n    [[ -d \"$sdk_home\" ]] || fail \"Android SDK 不存在：$sdk_home\"\n    sdk_home=\"$(cd \"$sdk_home\" && pwd -P)\"\n    ndk_home=\"$sdk_home/ndk/$android_ndk_version\"\n  else\n    assert_safe_directory_path \"$ndk_home\" \"ANDROID_NDK_HOME\"\n    [[ -d \"$ndk_home\" ]] || fail \"Android NDK 不存在：$ndk_home\"\n    ndk_home=\"$(cd \"$ndk_home\" && pwd -P)\"\n    [[ \"${ndk_home##*/}\" == \"$android_ndk_version\" ]] \\\n      || fail \"ANDROID_NDK_HOME 必须使用统一版本 $android_ndk_version\"\n    if [[ -n \"$sdk_home\" ]]; then\n      assert_safe_directory_path \"$sdk_home\" \"Android SDK\"\n      [[ -d \"$sdk_home\" ]] || fail \"Android SDK 不存在：$sdk_home\"\n      sdk_home=\"$(cd \"$sdk_home\" && pwd -P)\"\n      expected_ndk=\"$sdk_home/ndk/$android_ndk_version\"\n      [[ \"$ndk_home\" == \"$expected_ndk\" ]] \\\n        || fail \"ANDROID_NDK_HOME 不属于统一 Android SDK 与 NDK 版本\"\n    fi\n  fi\n  [[ -d \"$ndk_home\" ]] || fail \"Android NDK 不存在：$ndk_home\"\n  case \"$(uname -s)-$(uname -m)\" in\n    Darwin-arm64)\n      host_tag=darwin-aarch64\n      [[ -d \"$ndk_home/toolchains/llvm/prebuilt/$host_tag\" ]] || host_tag=darwin-x86_64\n      ;;\n    Darwin-x86_64)\n      host_tag=darwin-x86_64\n      [[ -d \"$ndk_home/toolchains/llvm/prebuilt/$host_tag\" ]] || host_tag=darwin-aarch64\n      ;;\n    Linux-x86_64) host_tag=linux-x86_64 ;;\n    *) fail \"不支持的 Android 构建宿主：$(uname -s)-$(uname -m)\" ;;\n  esac\n  local toolchain=\"$ndk_home/toolchains/llvm/prebuilt/$host_tag\"\n  [[ -d \"$toolchain\" ]] || fail \"Android NDK toolchain 不存在：$toolchain\"\n  printf '%s\\n' \"$toolchain\"\n}\n\n# Gradle 9 要求每个 projectDir 可写。这里只生成当前任务的入口配置，\n# 三个脚本及全部业务源码仍从 SDK 原目录只读加载，不复制源码工程。\nprepare_android_gradle_project() {\n  local android_gradle_project=\"$work_dir/gradle-project\" relative\n  prepare_safe_directory \"$work_dir\" \"$android_gradle_project/native\" \"Android Gradle 任务工程\"\n  for relative in settings.gradle build.gradle native/build.gradle; do\n    prepare_safe_output_file \"$work_dir\" \"$android_gradle_project/$relative\" \"Android Gradle 任务配置\"\n  done\n  cat >\"$android_gradle_project/settings.gradle\" <<'GRADLE'\napply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/settings.gradle')\nGRADLE\n  cat >\"$android_gradle_project/build.gradle\" <<'GRADLE'\napply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/build.gradle')\nGRADLE\n  cat >\"$android_gradle_project/native/build.gradle\" <<'GRADLE'\napply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/native/build.gradle')\nGRADLE\n}\n\nbuild_android() {\n  prepare_internal_header\n  require_rust_target aarch64-linux-android\n  local toolchain gradle_bin android_build_dir gradle_project_cache gradle_user_home\n  local kotlin_persistent_dir gradle_network_arg='' verifier_maven_dir verifier_link\n  local android_gradle_project=\"$work_dir/gradle-project\"\n  local core_stage core_destination jni_destination aar_destination source_library\n  local built_aar aar_jni nm_bin strip_bin\n  toolchain=\"$(android_toolchain)\"\n  gradle_bin=\"$(resolve_gradle)\"\n  case \"${CITIZENSDK_OFFLINE:-false}\" in\n    true) gradle_network_arg='--offline' ;;\n    false) ;;\n    *) fail \"CITIZENSDK_OFFLINE只接受true或false\" ;;\n  esac\n  android_build_dir=\"$work_dir/gradle-native\"\n  gradle_project_cache=\"$work_dir/gradle-project-cache\"\n  # 调用产品可以提供位于自身任务缓存中的统一 GRADLE_USER_HOME，使已下载依赖\n  # 自动归入调用方依赖缓存；它不是SDK编译物，因此不要求位于SDK子工作根。\n  gradle_user_home=\"${GRADLE_USER_HOME:-$work_dir/gradle-home}\"\n  kotlin_persistent_dir=\"$work_dir/kotlin-project-persistent\"\n  core_stage=\"$work_dir/android-core/arm64-v8a\"\n  core_destination=\"$output_dir/android/arm64-v8a/libcitizensdk.so\"\n  jni_destination=\"$output_dir/android/arm64-v8a/libcitizensdk_jni.so\"\n  aar_destination=\"$output_dir/android/citizensdk.aar\"\n  for directory in \\\n    \"$android_build_dir\" \"$gradle_project_cache\" \"$kotlin_persistent_dir\" \"$core_stage\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Android 外部构建目录\"\n  done\n  if [[ -n \"${GRADLE_USER_HOME:-}\" ]]; then\n    prepare_external_cache_directory \"$gradle_user_home\" \"Android Gradle 依赖缓存\"\n  else\n    prepare_safe_directory \"$work_dir\" \"$gradle_user_home\" \"Android Gradle 依赖缓存\"\n  fi\n  prepare_android_gradle_project\n  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=\"$toolchain/bin/aarch64-linux-android24-clang\"\n  export CC_aarch64_linux_android=\"$toolchain/bin/aarch64-linux-android24-clang\"\n  export AR_aarch64_linux_android=\"$toolchain/bin/llvm-ar\"\n  CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS='-C link-arg=-Wl,-soname,libcitizensdk.so' \\\n    cargo build --manifest-path \"$product_ffi_manifest\" --release --locked \\\n      --target aarch64-linux-android\n  source_library=\"$CARGO_TARGET_DIR/aarch64-linux-android/release/libcitizensdk.so\"\n  [[ -f \"$source_library\" ]] || fail \"Android CitizenSDK Core 库未生成\"\n  prepare_safe_output_file \"$work_dir\" \"$core_stage/libcitizensdk.so\" \\\n    \"Android Gradle Core staging\"\n  cp \"$source_library\" \"$core_stage/libcitizensdk.so\"\n  nm_bin=\"$toolchain/bin/llvm-nm\"\n  strip_bin=\"$toolchain/bin/llvm-strip\"\n  [[ -x \"$strip_bin\" ]] || fail \"Android NDK llvm-strip 不可执行：$strip_bin\"\n  # AGP 会对 Release AAR 中的 JNI 库执行 --strip-unneeded。先在受控 staging\n  # 对 Core 做同一次确定性处理，再把这一个字节版本同时投影到独立双库和 AAR；\n  # 否则外部 SO 与 AAR 会在打包后悄然变成两个不同产物。\n  \"$strip_bin\" --strip-unneeded \"$core_stage/libcitizensdk.so\"\n  verify_product_abi_symbols \"$core_stage/libcitizensdk.so\" \"$nm_bin\" \"\" \\\n    \"Android libcitizensdk.so\"\n  prepare_safe_output_file \"$output_dir\" \"$core_destination\" \"Android CitizenSDK Core 库\"\n  cp \"$core_stage/libcitizensdk.so\" \"$core_destination\"\n\n  # 默认按锁联网定位；只有调用方显式离线时才限制元数据解析使用已有缓存。\n  # 仅链接本轮 Cargo 锁定包自带的 Maven 目录，不复制或重打包依赖原件。\n  verifier_maven_dir=\"$(cargo metadata --manifest-path \"$product_ffi_manifest\" \\\n    --format-version 1 --locked ${gradle_network_arg:+\"$gradle_network_arg\"} | node -e '\n      let input = \"\";\n      process.stdin.on(\"data\", chunk => input += chunk);\n      process.stdin.on(\"end\", () => {\n        const matched = JSON.parse(input).packages.filter(packageInfo =>\n          packageInfo.name === \"rustls-platform-verifier-android\" && packageInfo.version === \"0.1.1\");\n        if (matched.length !== 1) process.exit(1);\n        process.stdout.write(require(\"path\").join(require(\"path\").dirname(matched[0].manifest_path), \"maven\"));\n      });\n    ')\" || fail \"无法定位 Cargo.lock 中的 Android 官方证书组件\"\n  [[ -f \"$verifier_maven_dir/rustls/rustls-platform-verifier/0.1.1/rustls-platform-verifier-0.1.1.aar\" ]] \\\n    || fail \"锁定的 Android 官方证书组件 AAR 缺失\"\n  verifier_link=\"$gradle_user_home/citizensdk-verifier-maven\"\n  if [[ -e \"$verifier_link\" || -L \"$verifier_link\" ]]; then\n    [[ -L \"$verifier_link\" && \"$(readlink \"$verifier_link\")\" == \"$verifier_maven_dir\" ]] \\\n      || fail \"Android 证书组件 Maven 视图已被其它内容占用\"\n  else\n    ln -s \"$verifier_maven_dir\" \"$verifier_link\"\n  fi\n\n  # Gradle 的 HTML 问题报告会写入源码；关闭该报告，中央日志仍保留完整错误栈。\n  # 环境变量必须连续传给同一子进程，续行中插入注释会使变量失去导出效果。\n  CITIZENSDK_ANDROID_BUILD_DIR=\"$android_build_dir\" \\\n  CITIZENSDK_SOURCE_DIR=\"$sdk_dir\" \\\n  CITIZENSDK_ANDROID_CORE_DIR=\"$core_stage\" \\\n  CITIZENSDK_INTERNAL_INCLUDE_DIR=\"$work_dir/private-include\" \\\n  CITIZENSDK_ZXING_SOURCE_DIR=\"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n  GRADLE_USER_HOME=\"$gradle_user_home\" \\\n    \"$gradle_bin\" ${gradle_network_arg:+\"$gradle_network_arg\"} --no-daemon --stacktrace --no-problems-report \\\n      --project-cache-dir \"$gradle_project_cache\" \\\n      -Pkotlin.project.persistent.dir=\"$kotlin_persistent_dir\" \\\n      -p \"$android_gradle_project\" :native:assembleRelease\n  built_aar=\"$android_build_dir/native/outputs/aar/native-release.aar\"\n  [[ -f \"$built_aar\" ]] || fail \"Android CitizenSDK AAR 未生成：$built_aar\"\n\n  prepare_safe_output_file \"$output_dir\" \"$jni_destination\" \"Android CitizenSDK JNI 库\"\n  unzip -p \"$built_aar\" jni/arm64-v8a/libcitizensdk_jni.so >\"$jni_destination\" \\\n    || fail \"无法从 AAR 提取 libcitizensdk_jni.so\"\n  prepare_safe_output_file \"$output_dir\" \"$aar_destination\" \"Android CitizenSDK AAR\"\n  cp \"$built_aar\" \"$aar_destination\"\n  verify_android_aar \\\n    \"$aar_destination\" \"$core_destination\" \"$jni_destination\" \"$nm_bin\"\n  echo \"CitizenSDK Android Core/JNI/AAR 完成：$aar_destination\"\n}\n\napple_product_symbols() {\n  local library=\"$1\" nm_bin=\"$2\"\n  \"$nm_bin\" -gU \"$library\" 2>/dev/null \\\n    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \\\n    | sed 's/^_//' \\\n    | LC_ALL=C sort -u\n}\n\nqr_image_header_symbols() {\n  perl -0777 -ne 'while (/\\b(citizensdk_qr_image_[a-z0-9_]+)\\s*\\(/g) { print \"$1\\n\" }' \\\n    \"$qr_image_header\" | LC_ALL=C sort -u\n}\n\napple_public_symbols() {\n  { product_header_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u\n}\n\napple_linked_symbols() {\n  { product_linked_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u\n}\n\nverify_apple_product_abi_symbols() {\n  local library=\"$1\" nm_bin=\"$2\" label=\"$3\"\n  local all_symbols actual expected forbidden foreign swift_symbols expected_count\n  all_symbols=\"$(apple_product_symbols \"$library\" \"$nm_bin\")\" \\\n    || fail \"无法读取 $label 的 Mach-O 外部已定义符号\"\n  actual=\"$(printf '%s\\n' \"$all_symbols\" | grep '^citizensdk_' || true)\"\n  expected=\"$(apple_public_symbols)\"\n  expected_count=\"$(printf '%s\\n' \"$expected\" | grep -c '^citizensdk_' || true)\"\n  [[ \"$expected_count\" == 148 ]] \\\n    || fail \"Apple 产品头必须精确声明 144 个 Core 与 4 个图像函数\"\n  forbidden=\"$(printf '%s\\n' \"$all_symbols\" \\\n    | grep -E '^(smoldot_|citizen_sr25519_|account_crypto_)' || true)\"\n  [[ -z \"$forbidden\" ]] \\\n    || fail \"$label 泄露 legacy 低层符号：$(printf '%s' \"$forbidden\" | tr '\\n' ' ')\"\n  [[ \"$actual\" == \"$expected\" ]] || {\n    local missing extra\n    missing=\"$(comm -23 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    extra=\"$(comm -13 <(printf '%s\\n' \"$expected\") <(printf '%s\\n' \"$actual\"))\"\n    fail \"$label 的 citizensdk_* 与 144 Core + 4 图像函数产品头不一致；缺失=${missing:-无}；额外=${extra:-无}\"\n  }\n  # 动态 framework 同时提供 Swift API 和 C ABI。Swift public/ABI-support 符号\n  # 只能属于本模块 mangling；除这组 Swift 符号外，全部外部已定义符号必须正好\n  # 是产品头中的 144 个 Core + 4 个图像 C ABI，Rust staticlib 及其依赖不得穿透边界。\n  swift_symbols=\"$(printf '%s\\n' \"$all_symbols\" | grep '^\\$s10CitizenSDK' || true)\"\n  [[ -n \"$swift_symbols\" ]] || fail \"$label 未导出 CitizenSDK Swift 模块符号\"\n  foreign=\"$(printf '%s\\n' \"$all_symbols\" \\\n    | grep -Ev '^(citizensdk_|\\$s10CitizenSDK)' || true)\"\n  [[ -z \"$foreign\" ]] \\\n    || fail \"$label 泄露非 CitizenSDK 产品符号：$(printf '%s' \"$foreign\" | tr '\\n' ' ')\"\n}\n\nwrite_apple_exported_symbols() {\n  local probe=\"$1\" nm_bin=\"$2\" destination=\"$3\" label=\"$4\"\n  local all_symbols actual expected swift_symbols\n  all_symbols=\"$(apple_product_symbols \"$probe\" \"$nm_bin\")\" \\\n    || fail \"无法读取 $label 的未过滤 Mach-O 符号\"\n  actual=\"$(printf '%s\\n' \"$all_symbols\" | grep '^citizensdk_' || true)\"\n  expected=\"$(apple_linked_symbols)\"\n  [[ \"$actual\" == \"$expected\" ]] \\\n    || fail \"$label 未过滤链接不等于产品头与既定内部符号闭集\"\n  swift_symbols=\"$(printf '%s\\n' \"$all_symbols\" | grep '^\\$s10CitizenSDK' || true)\"\n  [[ -n \"$swift_symbols\" ]] || fail \"$label 未过滤链接没有 CitizenSDK Swift 导出\"\n  prepare_safe_output_file \"$work_dir\" \"$destination\" \"$label 导出允许集\"\n  {\n    apple_public_symbols\n    printf '%s\\n' \"$swift_symbols\"\n  } | sed 's/^/_/' | LC_ALL=C sort -u >\"$destination\"\n  [[ \"$(grep -c '^_citizensdk_' \"$destination\" || true)\" == 148 ]] \\\n    || fail \"$label 导出允许集没有精确 144 个 Core + 4 个图像 C ABI\"\n}\n\nwrite_framework_plist() {\n  local path=\"$1\" supported_platform=\"$2\" platform_name=\"$3\"\n  local minimum_key=\"$4\" minimum_version=\"$5\" software_version=\"$6\"\n  /usr/bin/plutil -create xml1 \"$path\"\n  /usr/libexec/PlistBuddy \\\n    -c \"Add :CFBundleDevelopmentRegion string en\" \\\n    -c \"Add :CFBundleExecutable string CitizenSDK\" \\\n    -c \"Add :CFBundleIdentifier string org.citizen.sdk\" \\\n    -c \"Add :CFBundleInfoDictionaryVersion string 6.0\" \\\n    -c \"Add :CFBundleName string CitizenSDK\" \\\n    -c \"Add :CFBundlePackageType string FMWK\" \\\n    -c \"Add :CFBundleShortVersionString string $software_version\" \\\n    -c \"Add :CFBundleVersion string $software_version\" \\\n    -c \"Add :CFBundleSupportedPlatforms array\" \\\n    -c \"Add :CFBundleSupportedPlatforms:0 string $supported_platform\" \\\n    -c \"Add :DTPlatformName string $platform_name\" \\\n    -c \"Add :$minimum_key string $minimum_version\" \\\n    \"$path\" >/dev/null\n}\n\nwrite_framework_module_map() {\n  local path=\"$1\"\n  printf '%s\\n' \\\n    'framework module CitizenSDK {' \\\n    '  umbrella header \"citizensdk.h\"' \\\n    '  module QRImage {' \\\n    '    header \"citizensdk_qr_image.h\"' \\\n    '    export *' \\\n    '  }' \\\n    '  export *' \\\n    '  module * { export * }' \\\n    '}' >\"$path\"\n}\n\nresolve_flutter_sdk_root() {\n  local flutter_bin flutter_root\n  flutter_bin=\"$(command -v flutter || true)\"\n  [[ -n \"$flutter_bin\" && \"$flutter_bin\" == /* && -f \"$flutter_bin\" \\\n    && ! -L \"$flutter_bin\" && -x \"$flutter_bin\" ]] \\\n    || fail \"Apple Flutter adapter 编译需要绝对路径的普通 Flutter 可执行文件\"\n  flutter_root=\"$(cd \"$(dirname \"$flutter_bin\")/..\" && pwd -P)\"\n  [[ -d \"$flutter_root/bin/cache/artifacts/engine\" ]] \\\n    || fail \"Flutter SDK 缺少已缓存 Apple engine artifacts：$flutter_root\"\n  printf '%s\\n' \"$flutter_root\"\n}\n\nresolve_flutter_macos_xcframework() {\n  local flutter_root=\"$1\" candidate\n  local -a candidates=()\n  while IFS= read -r candidate; do\n    candidates+=(\"$candidate\")\n  done < <(find \"$flutter_root/bin/cache/artifacts/engine\" \\\n    -mindepth 2 -maxdepth 2 -type d -name FlutterMacOS.xcframework \\\n    -path '*/darwin-*-release/FlutterMacOS.xcframework' -print | LC_ALL=C sort)\n  [[ \"${#candidates[@]}\" == 1 ]] \\\n    || fail \"Flutter SDK 必须精确提供一个 macOS Release XCFramework；实际=${#candidates[@]}\"\n  printf '%s\\n' \"${candidates[0]}\"\n}\n\nresolve_xcframework_framework_slice() {\n  local xcframework=\"$1\" module=\"$2\" platform=\"$3\" expected_variant=\"$4\"\n  local index=0 identifier library_path actual_platform actual_variant architectures\n  local framework found='' count=0\n  [[ -d \"$xcframework\" && ! -L \"$xcframework\" \\\n    && -f \"$xcframework/Info.plist\" && ! -L \"$xcframework/Info.plist\" ]] \\\n    || fail \"$module XCFramework 缺失或不是普通目录\"\n  while identifier=\"$(/usr/libexec/PlistBuddy \\\n    -c \"Print :AvailableLibraries:$index:LibraryIdentifier\" \\\n    \"$xcframework/Info.plist\" 2>/dev/null)\"; do\n    actual_platform=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatform\" \\\n      \"$xcframework/Info.plist\")\"\n    actual_variant=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatformVariant\" \\\n      \"$xcframework/Info.plist\" 2>/dev/null || true)\"\n    if [[ \"$actual_platform\" == \"$platform\" && \"$actual_variant\" == \"$expected_variant\" ]]; then\n      architectures=\"$(/usr/libexec/PlistBuddy \\\n        -c \"Print :AvailableLibraries:$index:SupportedArchitectures\" \\\n        \"$xcframework/Info.plist\")\"\n      printf '%s\\n' \"$architectures\" | grep -Eq '(^|[[:space:]])arm64([[:space:]]|$)' \\\n        || fail \"$module 的 $platform/${expected_variant:-device} slice 不支持 arm64\"\n      library_path=\"$(/usr/libexec/PlistBuddy \\\n        -c \"Print :AvailableLibraries:$index:LibraryPath\" \\\n        \"$xcframework/Info.plist\")\"\n      framework=\"$xcframework/$identifier/$library_path\"\n      [[ -d \"$framework\" && \"$(basename \"$framework\")\" == \"$module.framework\" ]] \\\n        || fail \"$module 的 $platform/${expected_variant:-device} framework 路径无效\"\n      found=\"$framework\"\n      count=$((count + 1))\n    fi\n    index=$((index + 1))\n  done\n  [[ \"$count\" == 1 ]] \\\n    || fail \"$module 必须精确提供一个 $platform/${expected_variant:-device} arm64 slice；实际=$count\"\n  printf '%s\\n' \"$found\"\n}\n\ncompile_apple_flutter_adapter() {\n  local apple_sdk=\"$1\" swift_target=\"$2\" slice_name=\"$3\" platform=\"$4\"\n  local variant=\"$5\" flutter_module=\"$6\" flutter_xcframework=\"$7\"\n  local citizen_slice_root=\"$8\" flutter_framework flutter_framework_root\n  local sdk_path swiftc compile_root module_cache source object_count\n  local -a swift_sources swift_arguments\n\n  [[ -d \"$citizen_slice_root/CitizenSDK.framework\" \\\n    && ! -L \"$citizen_slice_root/CitizenSDK.framework\" ]] \\\n    || fail \"$slice_name Flutter adapter 必须从最终 XCFramework slice 导入 CitizenSDK\"\n  [[ -d \"$darwin_flutter_source_root\" && ! -L \"$darwin_flutter_source_root\" ]] \\\n    || fail \"CitizenSDKFlutter 生产源码目录缺失\"\n  swift_sources=()\n  while IFS= read -r source; do\n    swift_sources+=(\"$source\")\n  done < <(find \"$darwin_flutter_source_root\" -maxdepth 1 -type f \\\n    -name '*.swift' -print | LC_ALL=C sort)\n  [[ \"${#swift_sources[@]}\" -gt 0 ]] || fail \"CitizenSDKFlutter 生产源码为空\"\n\n  flutter_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$flutter_xcframework\" \"$flutter_module\" \"$platform\" \"$variant\")\"\n  flutter_framework_root=\"$(dirname \"$flutter_framework\")\"\n  sdk_path=\"$(xcrun --sdk \"$apple_sdk\" --show-sdk-path)\"\n  swiftc=\"$(xcrun --sdk \"$apple_sdk\" --find swiftc)\"\n  [[ -d \"$sdk_path\" && -x \"$swiftc\" ]] \\\n    || fail \"$slice_name Flutter adapter 缺少受控 Apple SDK 或 swiftc\"\n\n  compile_root=\"$work_dir/apple-flutter-compile/$slice_name\"\n  module_cache=\"$compile_root/module-cache\"\n  [[ ! -e \"$compile_root\" && ! -L \"$compile_root\" ]] \\\n    || fail \"$slice_name Flutter adapter 编译目录必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$compile_root\" \\\n    \"$slice_name Flutter adapter 编译目录\"\n  prepare_safe_directory \"$work_dir\" \"$module_cache\" \\\n    \"$slice_name Flutter adapter module cache\"\n  swift_arguments=(\"${swift_sources[@]}\"\n    -parse-as-library\n    -swift-version 5\n    -warnings-as-errors\n    -strict-concurrency=complete\n    -module-name CitizenSDKFlutter\n    -module-cache-path \"$module_cache\"\n    -sdk \"$sdk_path\"\n    -target \"$swift_target\"\n    -F \"$citizen_slice_root\"\n    -F \"$flutter_framework_root\")\n\n  # 第一遍是严格类型检查；第二遍真实生成每个 Swift 源文件的目标文件。\n  # 两遍都从最终 XCFramework slice 导入 @_spi(CitizenSDKFlutter)，不能从\n  # 同次 Swift 源码或构建前 framework 旁路产品边界。\n  \"$swiftc\" \"${swift_arguments[@]}\" -typecheck\n  (\n    cd \"$compile_root\"\n    \"$swiftc\" \"${swift_arguments[@]}\" -c\n  )\n  object_count=\"$(find \"$compile_root\" -mindepth 1 -maxdepth 1 \\\n    -type f -name '*.o' -print | wc -l | tr -d '[:space:]')\"\n  [[ \"$object_count\" == \"${#swift_sources[@]}\" ]] \\\n    || fail \"$slice_name Flutter adapter 编译目标闭集漂移：$object_count/${#swift_sources[@]}\"\n}\n\nwrite_apple_test_package() {\n  local harness=\"$1\" static_library=\"$2\" flutter_module=\"$3\"\n  local qr_library=\"$4\" zxing_library=\"$5\" product_swift_target=\"$6\"\n  local source destination\n  for directory in \\\n    \"$harness/Sources/CitizenSDK\" \\\n    \"$harness/Sources/CitizenSDKC/include\" \\\n    \"$harness/Sources/CitizenSDKFlutter\" \\\n    \"$harness/Tests/CitizenSDKTests\" \\\n    \"$harness/Tests/CitizenSDKFlutterTests\" \\\n    \"$harness/Libraries\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Apple XCTest 临时 harness\"\n  done\n  cp \"$product_header\" \"$harness/Sources/CitizenSDKC/include/citizensdk.h\"\n  cp \"$product_types_header\" \"$harness/Sources/CitizenSDKC/include/citizensdk_types.h\"\n  cp \"$qr_image_header\" \"$harness/Sources/CitizenSDKC/include/citizensdk_qr_image.h\"\n  cp \"$static_library\" \"$harness/Libraries/libcitizensdk.a\"\n  cp \"$qr_library\" \"$harness/Libraries/libcitizensdk_qr_image.a\"\n  cp \"$zxing_library\" \"$harness/Libraries/libZXing.a\"\n  printf '%s\\n' \\\n    '#include \"citizensdk.h\"' \\\n    'int citizensdk_test_harness_anchor(void) { return 0; }' \\\n    >\"$harness/Sources/CitizenSDKC/harness.c\"\n  while IFS= read -r source; do\n    destination=\"$harness/Sources/CitizenSDK/$(basename \"$source\")\"\n    {\n      printf '%s\\n' 'import CitizenSDKC'\n      cat \"$source\"\n    } >\"$destination\"\n  done < <(find \"$darwin_source_root\" -maxdepth 1 -type f -name '*.swift' \\\n    -print | LC_ALL=C sort)\n  printf '%s\\n' '@_exported import CitizenSDKC' \\\n    >\"$harness/Sources/CitizenSDK/CitizenSDKCExports.swift\"\n  cp \"$darwin_flutter_source_root\"/*.swift \"$harness/Sources/CitizenSDKFlutter/\"\n  cp \"$sdk_dir/darwin/tests/core\"/*.swift \\\n    \"$harness/Tests/CitizenSDKTests/\"\n  cp \"$sdk_dir/darwin/tests/flutter\"/*.swift \\\n    \"$harness/Tests/CitizenSDKFlutterTests/\"\n\n  cat >\"$harness/Package.swift\" <<PACKAGE\n// swift-tools-version: 5.9\nimport PackageDescription\n\nlet strict: [SwiftSetting] = [\n    .unsafeFlags([\"-warnings-as-errors\", \"-strict-concurrency=complete\",\n        \"-I\", \"$work_dir/private-include\", \"-Xcc\", \"-I$harness/Sources/CitizenSDKC/include\"]),\n]\n\n// Release-mode cross compilation does not make package modules testable by\n// default. The harness needs internal access for the canonical @testable XCTest\n// suites, so only its two generated implementation targets receive this flag.\nlet testable: [SwiftSetting] = strict + [\n    // SDK源码继续按正式最低版本编译；只有XCTest目标使用较高运行库版本。\n    // SwiftPM/Xcode会重建driver目标，必须把生产目标直接传给编译前端。\n    .unsafeFlags([\"-enable-testing\", \"-Xfrontend\", \"-target\", \"-Xfrontend\", \"$product_swift_target\"]),\n]\n\nlet package = Package(\n    name: \"CitizenSDKAppleTests\",\n    // 仅测试包对齐XCTest运行库最低版本；交付框架仍支持iOS16/macOS13。\n    platforms: [.iOS(.v17), .macOS(.v14)],\n    targets: [\n        .binaryTarget(name: \"$flutter_module\", path: \"Artifacts/$flutter_module.xcframework\"),\n        .target(\n            name: \"CitizenSDKC\",\n            path: \"Sources/CitizenSDKC\",\n            publicHeadersPath: \"include\"\n        ),\n        .target(\n            name: \"CitizenSDK\",\n            dependencies: [\"CitizenSDKC\"],\n            path: \"Sources/CitizenSDK\",\n            swiftSettings: testable,\n            linkerSettings: [\n                .unsafeFlags([\"-Xlinker\", \"-force_load\", \"-Xlinker\", \"$harness/Libraries/libcitizensdk.a\"]),\n                .unsafeFlags([\"-Xlinker\", \"-force_load\", \"-Xlinker\", \"$harness/Libraries/libcitizensdk_qr_image.a\"]),\n                .unsafeFlags([\"-Xlinker\", \"-force_load\", \"-Xlinker\", \"$harness/Libraries/libZXing.a\"]),\n                .linkedFramework(\"Security\"),\n                .linkedFramework(\"LocalAuthentication\"),\n                .linkedLibrary(\"c++\"),\n                .linkedLibrary(\"sqlite3\"),\n            ]\n        ),\n        .target(\n            name: \"CitizenSDKFlutter\",\n            dependencies: [\"CitizenSDK\", \"$flutter_module\"],\n            path: \"Sources/CitizenSDKFlutter\",\n            swiftSettings: testable\n        ),\n        .testTarget(\n            name: \"CitizenSDKTests\",\n            dependencies: [\"CitizenSDK\"],\n            path: \"Tests/CitizenSDKTests\",\n            swiftSettings: strict\n        ),\n        .testTarget(\n            name: \"CitizenSDKFlutterTests\",\n            dependencies: [\"CitizenSDK\", \"CitizenSDKFlutter\"],\n            path: \"Tests/CitizenSDKFlutterTests\",\n            swiftSettings: strict\n        ),\n    ],\n    swiftLanguageVersions: [.v5]\n)\nPACKAGE\n}\n\nrun_apple_test_harness() {\n  local rust_target=\"$1\" apple_sdk=\"$2\" swift_target=\"$3\" slice_name=\"$4\"\n  local flutter_module=\"$5\" flutter_xcframework=\"$6\" mode=\"$7\"\n  local static_library qr_library zxing_library harness scratch artifact sdk_path runtime_framework_root=''\n  local flutter_test_bundle framework_destination test_product_root test_bundle_names\n  local test_bundle_name resource_destination asset_name product_swift_target\n  local -a swiftpm_paths swiftpm_target\n  # 生产源码的可用性诊断必须与交付目标一致，不能被XCTest运行库的最低版本抬高。\n  case \"$apple_sdk\" in\n    iphoneos) product_swift_target=\"arm64-apple-ios$ios_deployment_target\" ;;\n    iphonesimulator) product_swift_target=\"arm64-apple-ios$ios_deployment_target-simulator\" ;;\n    macosx) product_swift_target=\"arm64-apple-macosx$macos_deployment_target\" ;;\n    *) fail \"Apple XCTest SDK未登记：$apple_sdk\" ;;\n  esac\n  static_library=\"$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.a\"\n  [[ -f \"$static_library\" && ! -L \"$static_library\" ]] \\\n    || fail \"$slice_name XCTest 缺少已构建 native/ffi 静态 Core\"\n  qr_library=\"$work_dir/apple-build/$slice_name/qr-image/libcitizensdk_qr_image.a\"\n  zxing_library=\"$(find \"$work_dir/apple-build/$slice_name/qr-image\" \\\n    -type f -name 'libZXing.a' -print)\"\n  [[ -f \"$qr_library\" && ! -L \"$qr_library\" \\\n    && -n \"$zxing_library\" && \"$zxing_library\" != *$'\\n'* \\\n    && -f \"$zxing_library\" && ! -L \"$zxing_library\" ]] \\\n    || fail \"$slice_name XCTest 缺少对应的 QR/ZXing 静态库\"\n  harness=\"$work_dir/apple-test-harness/$slice_name\"\n  scratch=\"$work_dir/apple-test-scratch/$slice_name\"\n  [[ ! -e \"$harness\" && ! -L \"$harness\" && ! -e \"$scratch\" && ! -L \"$scratch\" ]] \\\n    || fail \"$slice_name XCTest harness/scratch 必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$harness\" \"$slice_name XCTest harness\"\n  prepare_safe_directory \"$work_dir\" \"$scratch\" \"$slice_name XCTest scratch\"\n  write_apple_test_package \\\n    \"$harness\" \"$static_library\" \"$flutter_module\" \"$qr_library\" \"$zxing_library\" \"$product_swift_target\"\n  prepare_safe_directory \"$work_dir\" \"$harness/Artifacts\" \"$slice_name XCTest artifacts\"\n  artifact=\"$harness/Artifacts/$flutter_module.xcframework\"\n  [[ ! -e \"$artifact\" && ! -L \"$artifact\" ]] \\\n    || fail \"$slice_name Flutter 测试 artifact 目标必须全新\"\n  cp -R \"$flutter_xcframework\" \"$artifact\"\n  sdk_path=\"$(xcrun --sdk \"$apple_sdk\" --show-sdk-path)\"\n  swiftpm_paths=(\n    # 当前 macOS 执行环境禁止 SwiftPM 调用系统 sandbox-exec；这里只是构建测试\n    # harness，不连接真实设备，运行时 smoke 仍由下方独立沙箱合同保护。\n    --disable-sandbox\n    --package-path \"$harness\"\n    --cache-path \"$scratch/cache\"\n    --config-path \"$scratch/config\"\n    --security-path \"$scratch/security\"\n    --scratch-path \"$scratch/build\"\n    --manifest-cache local\n    --disable-dependency-cache\n    --configuration release\n    --triple \"$swift_target\"\n    --sdk \"$sdk_path\"\n  )\n  prepare_safe_directory \"$work_dir\" \"$scratch/tmp\" \"$slice_name XCTest TMPDIR\"\n  prepare_safe_directory \"$work_dir\" \"$scratch/foundation-home\" \"$slice_name XCTest Foundation 沙箱\"\n  case \"$mode\" in\n    run|compile) swiftpm_target=(build --build-tests) ;;\n    *) fail \"Apple XCTest mode 未登记：$mode\" ;;\n  esac\n  if [[ \"$mode\" == run ]]; then\n    runtime_framework_root=\"$(dirname \"$(resolve_xcframework_framework_slice \\\n      \"$artifact\" \"$flutter_module\" macos '')\")\"\n  fi\n  TMPDIR=\"$scratch/tmp\" CFFIXED_USER_HOME=\"$scratch/foundation-home\" \\\n  CLANG_MODULE_CACHE_PATH=\"$scratch/clang-module-cache\" \\\n  SWIFTPM_MODULECACHE_OVERRIDE=\"$scratch/swift-module-cache\" \\\n    swift \"${swiftpm_target[@]}\" \"${swiftpm_paths[@]}\"\n  if [[ \"$mode\" == run ]]; then\n    # SwiftPM does not embed a binary-target framework in a macOS XCTest\n    # bundle. Embed the exact resolved Flutter framework after build, then run\n    # with --skip-build so dyld resolves only the bundle-owned copy.\n    test_product_root=\"$scratch/build/out/Products/Release\"\n    test_bundle_names=\"$(find \"$test_product_root\" -mindepth 1 -maxdepth 1 \\\n      -type d -name '*.xctest' -exec basename {} \\; | LC_ALL=C sort)\"\n    [[ \"$test_bundle_names\" == $'CitizenSDKFlutterTests.xctest\\nCitizenSDKTests.xctest' ]] \\\n      || fail \"macOS XCTest 产品闭集漂移：${test_bundle_names:-无}\"\n    flutter_test_bundle=\"$test_product_root/CitizenSDKFlutterTests.xctest\"\n    framework_destination=\"$flutter_test_bundle/Contents/Frameworks/$flutter_module.framework\"\n    prepare_safe_directory \"$work_dir\" \"$(dirname \"$framework_destination\")\" \\\n      \"macOS Flutter XCTest framework 目录\"\n    [[ ! -e \"$framework_destination\" && ! -L \"$framework_destination\" ]] \\\n      || fail \"macOS Flutter XCTest framework 目标必须全新\"\n    cp -R \"$runtime_framework_root/$flutter_module.framework\" \"$framework_destination\"\n    # SwiftPM把SDK静态链接进测试bundle；正式加载器仍从所属bundle读取同一链资产。\n    # 仅投影冻结资源，不改生产Bundle查找路径、不构造替身链身份。\n    for test_bundle_name in CitizenSDKTests.xctest CitizenSDKFlutterTests.xctest; do\n      resource_destination=\"$test_product_root/$test_bundle_name/Contents/Resources/chain\"\n      prepare_safe_directory \"$work_dir\" \"$resource_destination\" \"XCTest正式链资源\"\n      for asset_name in manifest.json chainspec.json light_sync_state.json; do\n        prepare_safe_output_file \"$work_dir\" \"$resource_destination/$asset_name\" \"XCTest链资产\"\n        cp \"$apple_asset_root/$asset_name\" \"$resource_destination/$asset_name\"\n        cmp -s \"$apple_asset_root/$asset_name\" \"$resource_destination/$asset_name\" \\\n          || fail \"XCTest链资产投影字节漂移\"\n      done\n    done\n    TMPDIR=\"$scratch/tmp\" CFFIXED_USER_HOME=\"$scratch/foundation-home\" \\\n    CLANG_MODULE_CACHE_PATH=\"$scratch/clang-module-cache\" \\\n    SWIFTPM_MODULECACHE_OVERRIDE=\"$scratch/swift-module-cache\" \\\n      swift test --skip-build \"${swiftpm_paths[@]}\"\n  fi\n}\n\nrun_final_apple_consumer_smoke() {\n  local xcframework=\"$output_dir/apple/CitizenSDK.xcframework\"\n  local framework framework_root\n  local smoke_root=\"$work_dir/apple-consumer-smoke\"\n  local source=\"$smoke_root/CitizenSDKConsumerSmoke.swift\"\n  local bundle_plist=\"$smoke_root/Info.plist\"\n  local executable=\"$smoke_root/CitizenSDKConsumerSmoke\"\n  local sdk_path swiftc architectures linked citizen_links\n  local expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'\n  framework=\"$(resolve_xcframework_framework_slice \\\n    \"$xcframework\" CitizenSDK macos '')\"\n  framework_root=\"$(dirname \"$framework\")\"\n  [[ -d \"$framework\" && ! -L \"$framework\" ]] \\\n    || fail \"最终 XCFramework macOS slice 缺失，拒绝消费者 smoke\"\n  [[ ! -e \"$smoke_root\" && ! -L \"$smoke_root\" ]] \\\n    || fail \"最终 XCFramework 消费者 smoke 目录必须全新\"\n  prepare_safe_directory \"$work_dir\" \"$smoke_root\" \"Apple 消费者 smoke\"\n  for directory in \\\n    \"$smoke_root/home-normal\" \"$smoke_root/home-supervisor\" \\\n    \"$smoke_root/tmp-normal\" \"$smoke_root/tmp-supervisor\" \\\n    \"$smoke_root/module-cache\" \"$smoke_root/logs\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Apple 消费者 smoke 状态目录\"\n  done\n  cat >\"$source\" <<'SWIFT'\nimport CitizenSDK\nimport Darwin\nimport Foundation\n\nprivate enum SmokeFailure: Error, CustomStringConvertible {\n    case failed(String)\n    var description: String {\n        switch self { case let .failed(message): return message }\n    }\n}\n\nprivate func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {\n    guard condition() else { throw SmokeFailure.failed(message) }\n}\n\nprivate func verifyCapabilities(_ sdk: CitizenSdk) throws {\n    let capabilities = try sdk.capabilities()\n    let actual = capabilities.statuses.map(\\.name.rawValue).sorted()\n    let expected = CitizenCapabilityName.allCases.map(\\.rawValue).sorted()\n    try require(capabilities.revision >= 1, \"capability revision must be at least one\")\n    try require(capabilities.statuses.count == 10, \"capability status count must be exactly ten\")\n    try require(actual == expected, \"capability names must be the exact ten-value public enum\")\n}\n\nprivate let publicSQLiteSuffix = \"/citizensdk/v1/public/public-state-v1.sqlite3\"\nprivate let secureSQLiteSuffix = \"/citizensdk/v1/secure/secure-state-v1.sqlite3\"\n\nprivate func citizenSDKSQLiteFileDescriptors() -> Set<String> {\n    var paths = Set<String>()\n    let descriptorLimit = max(0, Int(getdtablesize()))\n    for descriptor in 0..<descriptorLimit {\n        var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))\n        if fcntl(Int32(descriptor), F_GETPATH, &bytes) == 0 {\n            let path = String(cString: bytes)\n            if path.hasSuffix(publicSQLiteSuffix) || path.hasSuffix(secureSQLiteSuffix) {\n                paths.insert(path)\n            }\n        }\n    }\n    return paths\n}\n\nprivate func closeEventually(_ sdk: CitizenSdk) async throws {\n    for _ in 0..<500 {\n        do { try sdk.close(); return }\n        catch let error as CitizenSDKError where error.code == .busy {\n            try await Task.sleep(nanoseconds: 10_000_000)\n        }\n    }\n    try sdk.close()\n}\n\nprivate func normalCloseSmoke() async throws {\n    let sdk = try CitizenSdk.open()\n    try require(sdk.lifecycle == .created, \"open must produce created lifecycle\")\n    try verifyCapabilities(sdk)\n    // Opening installs asynchronous state delivery. Public consumers honor the\n    // documented BUSY drain boundary instead of racing that callback.\n    try await closeEventually(sdk)\n    try require(sdk.lifecycle == .disposed, \"close must commit disposed lifecycle\")\n    try sdk.close()\n    try require(sdk.lifecycle == .disposed, \"idempotent close must remain disposed\")\n}\n\nprivate func supervisorSmoke() async throws {\n    var abandoned: CitizenSdk? = try CitizenSdk.open()\n    try verifyCapabilities(abandoned!)\n    // 模块化后存储按实际回调延迟打开；读取能力快照不等待后台探测。\n    // 等待公开刷新请求真实完成，再要求两个 SQLite FD 已打开，避免调度时序假失败。\n    try await abandoned!.refreshCapabilities()\n    let initiallyOpen = citizenSDKSQLiteFileDescriptors()\n    try require(initiallyOpen.contains(where: { $0.hasSuffix(publicSQLiteSuffix) }),\n                \"public SQLite descriptor must be open before abandonment\")\n    try require(initiallyOpen.contains(where: { $0.hasSuffix(secureSQLiteSuffix) }),\n                \"secure SQLite descriptor must be open before abandonment\")\n    abandoned = nil\n\n    let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000\n    while !citizenSDKSQLiteFileDescriptors().isEmpty\n            && DispatchTime.now().uptimeNanoseconds < deadline {\n        try await Task.sleep(nanoseconds: 50_000_000)\n    }\n    try require(citizenSDKSQLiteFileDescriptors().isEmpty,\n                \"supervisor must close public and secure SQLite descriptors\")\n\n    let reopened = try CitizenSdk.open()\n    try verifyCapabilities(reopened)\n    try await closeEventually(reopened)\n    try require(reopened.lifecycle == .disposed,\n                \"reopen after supervised cleanup must close successfully\")\n}\n\n@main\nprivate enum CitizenSDKConsumerSmoke {\n    static func main() async throws {\n        guard CommandLine.arguments.count == 2 else {\n            throw SmokeFailure.failed(\"expected exactly one smoke mode\")\n        }\n        switch CommandLine.arguments[1] {\n        case \"normal\": try await normalCloseSmoke()\n        case \"supervisor\": try await supervisorSmoke()\n        default: throw SmokeFailure.failed(\"unknown smoke mode\")\n        }\n    }\n}\nSWIFT\n  prepare_safe_output_file \"$work_dir\" \"$bundle_plist\" \"Apple 消费者 smoke Bundle 元数据\"\n  cat >\"$bundle_plist\" <<'PLIST'\n<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>org.citizen.sdk.consumer-smoke</string>\n</dict>\n</plist>\nPLIST\n  sdk_path=\"$(xcrun --sdk macosx --show-sdk-path)\"\n  swiftc=\"$(xcrun --sdk macosx --find swiftc)\"\n  prepare_safe_output_file \"$work_dir\" \"$executable\" \"Apple 消费者 smoke 可执行文件\"\n  \"$swiftc\" \"$source\" \\\n    -parse-as-library \\\n    -swift-version 5 \\\n    -warnings-as-errors \\\n    -strict-concurrency=complete \\\n    -module-cache-path \"$smoke_root/module-cache\" \\\n    -sdk \"$sdk_path\" \\\n    -target arm64-apple-macosx13.0 \\\n    -F \"$framework_root\" \\\n    -framework CitizenSDK \\\n    -Xlinker -sectcreate \\\n    -Xlinker __TEXT \\\n    -Xlinker __info_plist \\\n    -Xlinker \"$bundle_plist\" \\\n    -Xlinker -rpath \\\n    -Xlinker \"$framework_root\" \\\n    -o \"$executable\"\n  architectures=\"$(xcrun lipo -archs \"$executable\")\"\n  [[ \"$architectures\" == arm64 ]] \\\n    || fail \"Apple 消费者 smoke 必须精确编译为 arm64\"\n  linked=\"$(xcrun otool -L \"$executable\")\"\n  citizen_links=\"$(printf '%s\\n' \"$linked\" \\\n    | awk '$1 ~ /CitizenSDK\\.framework\\// { print $1 }' \\\n    | LC_ALL=C sort -u)\"\n  [[ \"$citizen_links\" == \"$expected_install_name\" ]] \\\n    || fail \"Apple 消费者 smoke 的 CitizenSDK 链接闭集漂移：${citizen_links:-无}\"\n  CFFIXED_USER_HOME=\"$smoke_root/home-normal\" \\\n  TMPDIR=\"$smoke_root/tmp-normal\" \\\n  DYLD_FRAMEWORK_PATH=\"$framework_root\" \\\n    \"$executable\" normal >\"$smoke_root/logs/normal.log\" 2>&1 \\\n    || fail \"最终 XCFramework 普通 open/capabilities/close smoke 失败\"\n  CFFIXED_USER_HOME=\"$smoke_root/home-supervisor\" \\\n  TMPDIR=\"$smoke_root/tmp-supervisor\" \\\n  DYLD_FRAMEWORK_PATH=\"$framework_root\" \\\n    \"$executable\" supervisor >\"$smoke_root/logs/supervisor.log\" 2>&1 \\\n    || fail \"最终 XCFramework supervisor/SQLite FD smoke 失败\"\n}\n\nbuild_apple_tests() {\n  [[ \"$(uname -s)\" == Darwin && \"$(uname -m)\" == arm64 ]] \\\n    || fail \"macOS XCTest 只允许在 Apple Silicon runner 执行\"\n  local xcframework flutter_root flutter_ios_xcframework flutter_macos_xcframework\n  local test_header_root\n  xcframework=\"$output_dir/apple/CitizenSDK.xcframework\"\n  verify_apple_xcframework \"$xcframework\"\n  flutter_root=\"$(resolve_flutter_sdk_root)\"\n  flutter_ios_xcframework=\"$flutter_root/bin/cache/artifacts/engine/ios-release/Flutter.xcframework\"\n  flutter_macos_xcframework=\"$(resolve_flutter_macos_xcframework \"$flutter_root\")\"\n  # Source tests resolve include/ from their canonical repository-relative\n  # location. Recreate that shared layout above all per-platform harnesses.\n  test_header_root=\"$work_dir/apple-test-harness/include\"\n  prepare_safe_directory \"$work_dir\" \"$test_header_root\" \\\n    \"Apple XCTest 共享头文件目录\"\n  for header in citizensdk.h citizensdk_types.h; do\n    prepare_safe_output_file \"$work_dir\" \"$test_header_root/$header\" \\\n      \"Apple XCTest 共享头文件\"\n    cp \"$sdk_dir/include/$header\" \"$test_header_root/$header\"\n  done\n  prepare_safe_output_file \"$work_dir\" \"$test_header_root/citizensdk_qr_image.h\" \\\n    \"Apple XCTest 共享 QR 图像头文件\"\n  cp \"$qr_image_header\" \"$test_header_root/citizensdk_qr_image.h\"\n  # XCTest运行库要求iOS17/macOS14；这里只调整测试目标，正式slice及消费者目标不变。\n  run_apple_test_harness aarch64-apple-ios iphoneos arm64-apple-ios17.0 \\\n    aarch64-apple-ios Flutter \"$flutter_ios_xcframework\" compile\n  run_apple_test_harness aarch64-apple-ios-sim iphonesimulator \\\n    arm64-apple-ios17.0-simulator aarch64-apple-ios-sim Flutter \\\n    \"$flutter_ios_xcframework\" compile\n  run_apple_test_harness aarch64-apple-darwin macosx arm64-apple-macosx14.0 \\\n    aarch64-apple-darwin FlutterMacOS \"$flutter_macos_xcframework\" run\n  run_final_apple_consumer_smoke\n}\n\nbuild_apple_framework_slice() {\n  local rust_target=\"$1\" apple_sdk=\"$2\" swift_target=\"$3\" slice_name=\"$4\"\n  local module_identity=\"$5\" supported_platform=\"$6\" platform_name=\"$7\"\n  local minimum_key=\"$8\" minimum_version=\"$9\"\n  local slice_root framework framework_content_root framework_headers modules\n  local framework_resources framework_binary framework_plist framework_install_name\n  local module_map module_cache\n  local sdk_path swiftc static_library software_version privacy_file source nm_bin\n  local probe export_list qr_build qr_library zxing_library cmake_system\n  local -a swift_sources swift_command\n\n  require_rust_target \"$rust_target\"\n  prepare_internal_header\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9.]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  [[ \"$software_version\" =~ ^[0-9]+\\.[0-9]{1,2}\\.[0-9]{1,2}$ ]] \\\n    || fail \"pubspec.yaml 软件版本无效\"\n  privacy_file=\"$darwin_source_root/PrivacyInfo.xcprivacy\"\n  [[ -d \"$darwin_source_root\" && -f \"$privacy_file\" \\\n    && -f \"$product_header\" && -f \"$product_types_header\" ]] \\\n    || fail \"Apple Swift 源码、隐私清单或产品头不完整\"\n\n  swift_sources=()\n  while IFS= read -r source; do\n    swift_sources+=(\"$source\")\n  done < <(find \"$darwin_source_root\" -maxdepth 1 -type f -name '*.swift' -print | LC_ALL=C sort)\n  [[ \"${#swift_sources[@]}\" -gt 0 ]] || fail \"CitizenSDK Swift 产品源码为空\"\n\n  # Rust中的C依赖必须与后续Swift/CMake共用本slice的SDK，不能继承外层平台值。\n  sdk_path=\"$(xcrun --sdk \"$apple_sdk\" --show-sdk-path)\"\n  [[ -d \"$sdk_path\" ]] || fail \"$slice_name 缺少受控 Apple SDK\"\n  case \"$rust_target\" in\n    aarch64-apple-ios|aarch64-apple-ios-sim)\n      SDKROOT=\"$sdk_path\" IPHONEOS_DEPLOYMENT_TARGET=\"$ios_deployment_target\" \\\n        CARGO_PROFILE_RELEASE_STRIP=false \\\n        cargo build --manifest-path \"$product_ffi_manifest\" --release --locked \\\n          --target \"$rust_target\"\n      ;;\n    aarch64-apple-darwin)\n      SDKROOT=\"$sdk_path\" MACOSX_DEPLOYMENT_TARGET=\"$macos_deployment_target\" \\\n        CARGO_PROFILE_RELEASE_STRIP=false \\\n        cargo build --manifest-path \"$product_ffi_manifest\" --release --locked \\\n          --target \"$rust_target\"\n      ;;\n    *) fail \"Apple 产品禁止未登记 Rust target：$rust_target\" ;;\n  esac\n  static_library=\"$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.a\"\n  [[ -f \"$static_library\" && ! -L \"$static_library\" ]] \\\n    || fail \"$slice_name 的 native/ffi 静态 Core 未生成\"\n\n  slice_root=\"$work_dir/apple-build/$slice_name\"\n  [[ ! -e \"$slice_root\" && ! -L \"$slice_root\" ]] \\\n    || fail \"$slice_name Apple slice 构建目录必须全新\"\n  framework=\"$slice_root/CitizenSDK.framework\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    # macOS framework 必须采用 Apple 标准版本化目录。iOS 设备与\n    # simulator 技术变体均保持 Apple 要求的 shallow framework；三者\n    # 最终进入同一个 CitizenSDK.xcframework，公开平台名只是 iOS/macOS。\n    framework_content_root=\"$framework/Versions/A\"\n    framework_plist=\"$framework_content_root/Resources/Info.plist\"\n    framework_resources=\"$framework_content_root/Resources\"\n    framework_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'\n  else\n    framework_content_root=\"$framework\"\n    framework_plist=\"$framework/Info.plist\"\n    # iOS frameworks are shallow bundles. Keeping a macOS-style Resources\n    # directory makes installd reject the framework during package inspection.\n    framework_resources=\"$framework_content_root\"\n    framework_install_name='@rpath/CitizenSDK.framework/CitizenSDK'\n  fi\n  framework_headers=\"$framework_content_root/Headers\"\n  modules=\"$framework_content_root/Modules/CitizenSDK.swiftmodule\"\n  framework_binary=\"$framework_content_root/CitizenSDK\"\n  module_map=\"$framework_content_root/Modules/module.modulemap\"\n  module_cache=\"$work_dir/apple-module-cache/$slice_name\"\n  for directory in \\\n    \"$framework_headers\" \"$modules\" \"$framework_resources/chain\" \"$module_cache\"; do\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"$slice_name Apple 构建目录\"\n  done\n  cp \"$product_header\" \"$framework_headers/citizensdk.h\"\n  cp \"$product_types_header\" \"$framework_headers/citizensdk_types.h\"\n  cp \"$qr_image_header\" \"$framework_headers/citizensdk_qr_image.h\"\n  write_framework_module_map \"$module_map\"\n  for asset in chainspec.json light_sync_state.json manifest.json; do\n    [[ -f \"$apple_asset_root/$asset\" && ! -L \"$apple_asset_root/$asset\" ]] \\\n      || fail \"Apple 链资产缺失：$asset\"\n    cp \"$apple_asset_root/$asset\" \"$framework_resources/chain/$asset\"\n  done\n  cp \"$privacy_file\" \"$framework_resources/PrivacyInfo.xcprivacy\"\n  prepare_safe_output_file \"$work_dir\" \"$framework_plist\" \"$slice_name Info.plist\"\n  write_framework_plist \\\n    \"$framework_plist\" \"$supported_platform\" \"$platform_name\" \\\n    \"$minimum_key\" \"$minimum_version\" \"$software_version\"\n\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    # 只允许这四个已经存在目标的目录链接；最终二进制写入 Versions/A 后再建立\n    # 第五个链接，构建期间不会制造悬空入口，也不会让秘密或产物越出中央 workdir。\n    for link_spec in \\\n      'Versions/Current|A' \\\n      'Headers|Versions/Current/Headers' \\\n      'Modules|Versions/Current/Modules' \\\n      'Resources|Versions/Current/Resources'; do\n      local link_path=\"${link_spec%%|*}\" link_target=\"${link_spec#*|}\"\n      prepare_safe_output_file \"$work_dir\" \"$framework/$link_path\" \\\n        \"$slice_name framework 标准目录链接\"\n      ln -s \"$link_target\" \"$framework/$link_path\"\n      [[ -L \"$framework/$link_path\" && -e \"$framework/$link_path\" \\\n        && \"$(readlink \"$framework/$link_path\")\" == \"$link_target\" ]] \\\n        || fail \"$slice_name framework 标准目录链接创建失败：$link_path\"\n    done\n  fi\n\n  swiftc=\"$(xcrun --sdk \"$apple_sdk\" --find swiftc)\"\n  nm_bin=\"$(xcrun --find nm)\"\n  [[ -d \"$sdk_path\" && -x \"$swiftc\" && -x \"$nm_bin\" ]] \\\n    || fail \"$slice_name 缺少受控 Apple SDK、swiftc 或 nm\"\n  command -v cmake >/dev/null 2>&1 || fail \"$slice_name 缺少 CMake\"\n  [[ -n \"${CITIZENSDK_ZXING_SOURCE_DIR:-}\" \\\n    && \"$CITIZENSDK_ZXING_SOURCE_DIR\" == /* \\\n    && -d \"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n    && ! -L \"$CITIZENSDK_ZXING_SOURCE_DIR\" ]] \\\n    || fail \"$slice_name 必须显式提供官方 ZXing-C++ 3.1.1 完整源码目录\"\n  qr_build=\"$slice_root/qr-image\"\n  prepare_safe_directory \"$work_dir\" \"$qr_build\" \"$slice_name QR 图像构建目录\"\n  if [[ \"$apple_sdk\" == macosx ]]; then cmake_system=Darwin; else cmake_system=iOS; fi\n  cmake -S \"$qr_image_source_root\" -B \"$qr_build\" \\\n    -DCMAKE_BUILD_TYPE=Release \\\n    -DCMAKE_SYSTEM_NAME=\"$cmake_system\" \\\n    -DCMAKE_OSX_SYSROOT=\"$sdk_path\" \\\n    -DCMAKE_OSX_ARCHITECTURES=arm64 \\\n    -DCMAKE_OSX_DEPLOYMENT_TARGET=\"$minimum_version\" \\\n    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \\\n    -DCITIZENSDK_ZXING_SOURCE_DIR=\"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n    -DCITIZENSDK_QR_IMAGE_BUILD_TESTS=OFF\n  cmake --build \"$qr_build\" --config Release --target citizensdk_qr_image --parallel\n  qr_library=\"$(find \"$qr_build\" -type f -name 'libcitizensdk_qr_image.a' -print)\"\n  zxing_library=\"$(find \"$qr_build\" -type f -name 'libZXing.a' -print)\"\n  [[ -n \"$qr_library\" && \"$qr_library\" != *$'\\n'* && -f \"$qr_library\" && ! -L \"$qr_library\" \\\n    && -n \"$zxing_library\" && \"$zxing_library\" != *$'\\n'* \\\n    && -f \"$zxing_library\" && ! -L \"$zxing_library\" ]] \\\n    || fail \"$slice_name ZXing-C++ 静态链接闭包不完整或不唯一\"\n  swift_command=(\"$swiftc\" \"${swift_sources[@]}\"\n    -parse-as-library \\\n    -swift-version 5 \\\n    -warnings-as-errors \\\n    -strict-concurrency=complete \\\n    -O \\\n    -whole-module-optimization \\\n    -enable-library-evolution \\\n    -emit-library \\\n    -emit-module \\\n    -emit-module-path \"$modules/$module_identity.swiftmodule\" \\\n    -emit-module-interface-path \"$modules/$module_identity.swiftinterface\" \\\n    -emit-private-module-interface-path \"$modules/$module_identity.private.swiftinterface\" \\\n    -module-name CitizenSDK \\\n    -module-cache-path \"$module_cache\" \\\n    -sdk \"$sdk_path\" \\\n    -target \"$swift_target\" \\\n    -import-underlying-module \\\n    -F \"$slice_root\" \\\n    -I \"$work_dir/private-include\" \\\n    -Xcc \"-I$framework/Headers\" \\\n    -Xlinker -force_load \\\n    -Xlinker \"$static_library\" \\\n    -Xlinker -force_load \\\n    -Xlinker \"$qr_library\" \\\n    -Xlinker -force_load \\\n    -Xlinker \"$zxing_library\" \\\n    -Xlinker -install_name \\\n    -Xlinker \"$framework_install_name\" \\\n    -framework Security \\\n    -framework LocalAuthentication \\\n    -lc++ \\\n    -lsqlite3)\n  # 第一阶段只存在中央 workdir，用于从真实 Swift 编译结果提取本模块 mangled\n  # exports；第二阶段才用允许集生成候选 framework。允许集不写入源码或候选。\n  probe=\"$slice_root/CitizenSDK.unfiltered\"\n  export_list=\"$slice_root/CitizenSDK.exported-symbols\"\n  prepare_safe_output_file \"$work_dir\" \"$probe\" \"$slice_name 未过滤链接\"\n  \"${swift_command[@]}\" -o \"$probe\"\n  write_apple_exported_symbols \"$probe\" \"$nm_bin\" \"$export_list\" \"$slice_name\"\n  prepare_safe_output_file \"$work_dir\" \"$framework_binary\" \"$slice_name framework 二进制\"\n  \"${swift_command[@]}\" \\\n    -Xlinker -exported_symbols_list \\\n    -Xlinker \"$export_list\" \\\n    -o \"$framework_binary\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    prepare_safe_output_file \"$work_dir\" \"$framework/CitizenSDK\" \\\n      \"$slice_name framework 标准二进制链接\"\n    ln -s 'Versions/Current/CitizenSDK' \"$framework/CitizenSDK\"\n    [[ -L \"$framework/CitizenSDK\" && -e \"$framework/CitizenSDK\" \\\n      && \"$(readlink \"$framework/CitizenSDK\")\" == 'Versions/Current/CitizenSDK' ]] \\\n      || fail \"$slice_name framework 标准二进制链接创建失败\"\n  fi\n  # 对最终候选中的 textual interface 重新调用 Swift frontend。该 interface\n  # 必须通过同名 framework module 解析根 C 头；编译时不使用 bridging header，\n  # 从而维持一个 CitizenSDK 混合模块而非第二个 CitizenSDKC 产品。\n  prepare_safe_directory \"$work_dir\" \"$module_cache/interface\" \\\n    \"$slice_name Swift interface module cache\"\n  for source in \\\n    \"$modules/$module_identity.swiftinterface\" \\\n    \"$modules/$module_identity.private.swiftinterface\"; do\n    if grep -Eq 'CitizenSDKInternal|citizensdk_internal_' \"$source\"; then\n      fail \"$slice_name Swift交付接口泄漏构建期私有依赖\"\n    fi\n    \"$swiftc\" -frontend \\\n      -typecheck-module-from-interface \"$source\" \\\n      -module-name CitizenSDK \\\n      -swift-version 5 \\\n      -warnings-as-errors \\\n      -strict-concurrency=complete \\\n      -sdk \"$sdk_path\" \\\n      -target \"$swift_target\" \\\n      -import-underlying-module \\\n      -F \"$slice_root\" \\\n      -module-cache-path \"$module_cache/interface\"\n  done\n}\n\nrestore_swift_module_artifacts() {\n  local xcframework=\"$1\" build_key module_identity platform variant extension\n  local source source_root destination destination_framework destination_root\n  while IFS='|' read -r build_key module_identity platform variant; do\n    source_root=\"$work_dir/apple-build/$build_key/CitizenSDK.framework\"\n    destination_framework=\"$(resolve_xcframework_framework_slice \\\n      \"$xcframework\" CitizenSDK \"$platform\" \"$variant\")\"\n    destination_root=\"$destination_framework\"\n    if [[ \"$platform\" == macos ]]; then\n      source_root=\"$source_root/Versions/A\"\n      destination_root=\"$destination_root/Versions/A\"\n    fi\n    # `xcodebuild -create-xcframework` may rewrite or omit compiler-emitted\n    # module sidecars. Restore/compare the exact six-file Swift module closure\n    # from each already verified input slice, never only the executable module.\n    for extension in \\\n      abi.json private.swiftinterface swiftdoc swiftinterface swiftmodule swiftsourceinfo; do\n      source=\"$source_root/Modules/CitizenSDK.swiftmodule/$module_identity.$extension\"\n      destination=\"$destination_root/Modules/CitizenSDK.swiftmodule/$module_identity.$extension\"\n      [[ -f \"$source\" && ! -L \"$source\" ]] \\\n        || fail \"$platform/$variant 输入 framework 缺少 Swift module 产物：$extension\"\n      if [[ -e \"$destination\" || -L \"$destination\" ]]; then\n        [[ -f \"$destination\" && ! -L \"$destination\" ]] \\\n          || fail \"$platform/$variant XCFramework Swift module 产物不是普通文件：$extension\"\n        cmp -s \"$source\" \"$destination\" \\\n          || fail \"$platform/$variant XCFramework Swift module 产物字节漂移：$extension\"\n      else\n        prepare_safe_output_file \"$work_dir\" \"$destination\" \\\n          \"$platform/$variant Swift module 产物投影：$extension\"\n        cp \"$source\" \"$destination\"\n      fi\n    done\n  done <<'MODULES'\naarch64-apple-ios|arm64-apple-ios|ios|\naarch64-apple-ios-sim|arm64-apple-ios-simulator|ios|simulator\naarch64-apple-darwin|arm64-apple-macos|macos|\nMODULES\n}\n\nverify_apple_framework_slice() {\n  local framework=\"$1\" label=\"$2\" expected_platform=\"$3\" expected_minos=\"$4\"\n  local module_identity=\"$5\" framework_content_root framework_plist framework_resources binary nm_bin\n  local architectures install_name expected_install_name build_info links top_entries version_entries\n  local actual_platform actual_minos entries expected_entries swift_modules module_entries\n  local bundle_platform platform_name minimum_key software_version expected_plist\n  [[ -d \"$framework\" && ! -L \"$framework\" ]] || fail \"$label framework 缺失\"\n  entries=\"$(find \"$(dirname \"$framework\")\" -mindepth 1 -maxdepth 1 -print \\\n    | sed 's#^.*/##' | LC_ALL=C sort)\"\n  [[ \"$entries\" == CitizenSDK.framework ]] \\\n    || fail \"$label slice 目录闭集漂移：${entries:-无}\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    top_entries=\"$(find \"$framework\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$top_entries\" == $'CitizenSDK\\nHeaders\\nModules\\nResources\\nVersions' ]] \\\n      || fail \"$label 版本化 framework 顶层闭集漂移\"\n    version_entries=\"$(find \"$framework/Versions\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$version_entries\" == $'A\\nCurrent' ]] \\\n      || fail \"$label Versions 闭集漂移\"\n    links=\"$(find \"$framework\" -type l -print \\\n      | sed \"s#^$framework/##\" | LC_ALL=C sort)\"\n    [[ \"$links\" == $'CitizenSDK\\nHeaders\\nModules\\nResources\\nVersions/Current' ]] \\\n      || fail \"$label 标准内部符号链接闭集漂移：${links:-无}\"\n    while IFS='|' read -r link_path link_target; do\n      [[ -L \"$framework/$link_path\" \\\n        && \"$(readlink \"$framework/$link_path\")\" == \"$link_target\" \\\n        && -e \"$framework/$link_path\" ]] \\\n        || fail \"$label 标准内部符号链接漂移：$link_path\"\n    done <<'MACOS_FRAMEWORK_LINKS'\nCitizenSDK|Versions/Current/CitizenSDK\nHeaders|Versions/Current/Headers\nModules|Versions/Current/Modules\nResources|Versions/Current/Resources\nVersions/Current|A\nMACOS_FRAMEWORK_LINKS\n    framework_content_root=\"$framework/Versions/A\"\n    entries=\"$(find \"$framework_content_root\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$entries\" == $'CitizenSDK\\nHeaders\\nModules\\nResources' ]] \\\n      || fail \"$label Versions/A 内容闭集漂移\"\n    framework_plist=\"$framework_content_root/Resources/Info.plist\"\n    framework_resources=\"$framework_content_root/Resources\"\n  else\n    [[ -z \"$(find \"$framework\" -type l -print -quit)\" ]] \\\n      || fail \"$label shallow framework 禁止符号链接\"\n    top_entries=\"$(find \"$framework\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    [[ \"$top_entries\" == $'CitizenSDK\\nHeaders\\nInfo.plist\\nModules\\nPrivacyInfo.xcprivacy\\nchain' ]] \\\n      || fail \"$label shallow framework 顶层闭集漂移\"\n    framework_content_root=\"$framework\"\n    framework_plist=\"$framework/Info.plist\"\n    framework_resources=\"$framework_content_root\"\n  fi\n  binary=\"$framework_content_root/CitizenSDK\"\n  [[ -f \"$binary\" && ! -L \"$binary\" ]] || fail \"$label framework 二进制缺失\"\n  architectures=\"$(xcrun lipo -archs \"$binary\")\"\n  [[ \"$architectures\" == arm64 ]] || fail \"$label 内部架构必须精确为 arm64；实际=$architectures\"\n  install_name=\"$(xcrun otool -D \"$binary\" | tail -n +2 | sed '/^[[:space:]]*$/d')\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'\n  else\n    expected_install_name='@rpath/CitizenSDK.framework/CitizenSDK'\n  fi\n  [[ \"$install_name\" == \"$expected_install_name\" ]] \\\n    || fail \"$label install name 漂移：${install_name:-无}\"\n  build_info=\"$(xcrun vtool -show-build \"$binary\")\"\n  actual_platform=\"$(printf '%s\\n' \"$build_info\" | awk '$1 == \"platform\" { print $2 }')\"\n  actual_minos=\"$(printf '%s\\n' \"$build_info\" | awk '$1 == \"minos\" { print $2 }')\"\n  [[ \"$actual_platform\" == \"$expected_platform\" && \"$actual_minos\" == \"$expected_minos\" ]] \\\n    || fail \"$label 平台/最低版本漂移：$actual_platform/$actual_minos\"\n  nm_bin=\"$(xcrun --find nm)\"\n  verify_apple_product_abi_symbols \"$binary\" \"$nm_bin\" \"$label\"\n\n  [[ -d \"$framework_content_root/Headers\" \\\n    && ! -L \"$framework_content_root/Headers\" ]] \\\n    || fail \"$label Headers 不是普通目录\"\n  entries=\"$(find \"$framework_content_root/Headers\" -mindepth 1 -maxdepth 1 -print \\\n    | sed 's#^.*/##' | LC_ALL=C sort)\"\n  expected_entries=$'citizensdk.h\\ncitizensdk_qr_image.h\\ncitizensdk_types.h'\n  [[ \"$entries\" == \"$expected_entries\" ]] || fail \"$label 产品头闭集漂移\"\n  [[ -f \"$framework_content_root/Headers/citizensdk.h\" \\\n    && ! -L \"$framework_content_root/Headers/citizensdk.h\" \\\n    && -f \"$framework_content_root/Headers/citizensdk_types.h\" \\\n    && ! -L \"$framework_content_root/Headers/citizensdk_types.h\" \\\n    && -f \"$framework_content_root/Headers/citizensdk_qr_image.h\" \\\n    && ! -L \"$framework_content_root/Headers/citizensdk_qr_image.h\" ]] \\\n    || fail \"$label 产品头必须全部为普通文件\"\n  cmp -s \"$framework_content_root/Headers/citizensdk.h\" \"$product_header\" \\\n    || fail \"$label citizensdk.h 与根产品头不一致\"\n  cmp -s \"$framework_content_root/Headers/citizensdk_types.h\" \"$product_types_header\" \\\n    || fail \"$label citizensdk_types.h 与根产品头不一致\"\n  cmp -s \"$framework_content_root/Headers/citizensdk_qr_image.h\" \"$qr_image_header\" \\\n    || fail \"$label citizensdk_qr_image.h 与统一图像头不一致\"\n  [[ -d \"$framework_content_root/Modules\" \\\n    && ! -L \"$framework_content_root/Modules\" ]] \\\n    || fail \"$label Modules 不是普通目录\"\n  module_entries=\"$(find \"$framework_content_root/Modules\" \\\n    -mindepth 1 -maxdepth 1 -print | sed 's#^.*/##' | LC_ALL=C sort)\"\n  [[ \"$module_entries\" == $'CitizenSDK.swiftmodule\\nmodule.modulemap' \\\n    && -f \"$framework_content_root/Modules/module.modulemap\" \\\n    && ! -L \"$framework_content_root/Modules/module.modulemap\" \\\n    && -d \"$framework_content_root/Modules/CitizenSDK.swiftmodule\" \\\n    && ! -L \"$framework_content_root/Modules/CitizenSDK.swiftmodule\" ]] \\\n    || fail \"$label Modules 节点闭集或类型漂移\"\n  grep -Fq 'framework module CitizenSDK' \"$framework_content_root/Modules/module.modulemap\" \\\n    || fail \"$label 缺少 CitizenSDK Clang module\"\n  swift_modules=\"$(find \"$framework_content_root/Modules/CitizenSDK.swiftmodule\" \\\n    -mindepth 1 -maxdepth 1 -print | sed 's#^.*/##' | LC_ALL=C sort)\"\n  expected_entries=\"$(printf '%s\\n' \\\n    \"$module_identity.abi.json\" \\\n    \"$module_identity.private.swiftinterface\" \\\n    \"$module_identity.swiftdoc\" \\\n    \"$module_identity.swiftinterface\" \\\n    \"$module_identity.swiftmodule\" \\\n    \"$module_identity.swiftsourceinfo\" | LC_ALL=C sort)\"\n  [[ \"$swift_modules\" == \"$expected_entries\" ]] \\\n    || fail \"$label Swift module 六文件闭集漂移\"\n  for interface in \\\n    \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.swiftinterface\" \\\n    \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.private.swiftinterface\"; do\n    grep -Fxq '@_exported import CitizenSDK' \"$interface\" \\\n      || fail \"$label Swift interface 未固定同名 underlying Clang module\"\n  done\n  grep -Fq '@_spi(CitizenSDKFlutter)' \\\n    \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.private.swiftinterface\" \\\n    || fail \"$label private Swift interface 缺少 CitizenSDKFlutter SPI\"\n  while IFS= read -r module_file; do\n    [[ -f \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_file\" \\\n      && ! -L \"$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_file\" ]] \\\n      || fail \"$label Swift module 必须全部为普通文件：$module_file\"\n  done <<<\"$swift_modules\"\n  [[ -d \"$framework_resources/chain\" \\\n    && ! -L \"$framework_resources/chain\" ]] \\\n    || fail \"$label chain 不是普通目录\"\n  if [[ \"$module_identity\" == arm64-apple-macos ]]; then\n    [[ -d \"$framework_resources\" && ! -L \"$framework_resources\" ]] \\\n      || fail \"$label Resources 不是普通目录\"\n    entries=\"$(find \"$framework_resources\" -mindepth 1 -print \\\n      | sed \"s#^$framework_resources/##\" | LC_ALL=C sort)\"\n    expected_entries=$'Info.plist\\nPrivacyInfo.xcprivacy\\nchain\\nchain/chainspec.json\\nchain/light_sync_state.json\\nchain/manifest.json'\n  else\n    entries=\"$(find \"$framework_resources/chain\" -mindepth 1 -maxdepth 1 -print \\\n      | sed 's#^.*/##' | LC_ALL=C sort)\"\n    expected_entries=$'chainspec.json\\nlight_sync_state.json\\nmanifest.json'\n  fi\n  [[ \"$entries\" == \"$expected_entries\" ]] || fail \"$label 资源闭集漂移\"\n  for asset in chainspec.json light_sync_state.json manifest.json; do\n    [[ -f \"$framework_resources/chain/$asset\" \\\n      && ! -L \"$framework_resources/chain/$asset\" ]] \\\n      || fail \"$label 链资产不是普通文件：$asset\"\n    cmp -s \"$framework_resources/chain/$asset\" \"$apple_asset_root/$asset\" \\\n      || fail \"$label 链资产字节漂移：$asset\"\n  done\n  [[ -f \"$framework_resources/PrivacyInfo.xcprivacy\" \\\n    && ! -L \"$framework_resources/PrivacyInfo.xcprivacy\" \\\n    && -f \"$framework_plist\" && ! -L \"$framework_plist\" ]] \\\n    || fail \"$label 隐私清单或 Info.plist 不是普通文件\"\n  cmp -s \"$framework_resources/PrivacyInfo.xcprivacy\" \\\n    \"$darwin_source_root/PrivacyInfo.xcprivacy\" \\\n    || fail \"$label 隐私清单字节漂移\"\n  case \"$module_identity\" in\n    arm64-apple-ios)\n      bundle_platform=iPhoneOS; platform_name=iphoneos; minimum_key=MinimumOSVersion ;;\n    arm64-apple-ios-simulator)\n      bundle_platform=iPhoneSimulator; platform_name=iphonesimulator; minimum_key=MinimumOSVersion ;;\n    arm64-apple-macos)\n      bundle_platform=MacOSX; platform_name=macosx; minimum_key=LSMinimumSystemVersion ;;\n    *) fail \"$label Swift module identity 未登记：$module_identity\" ;;\n  esac\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9.]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  expected_plist=\"$work_dir/apple-plist-contract/$module_identity.plist\"\n  if [[ ! -e \"$expected_plist\" && ! -L \"$expected_plist\" ]]; then\n    prepare_safe_output_file \"$work_dir\" \"$expected_plist\" \"$label Info.plist 合同\"\n    write_framework_plist \"$expected_plist\" \"$bundle_platform\" \"$platform_name\" \\\n      \"$minimum_key\" \"$expected_minos\" \"$software_version\"\n  fi\n  cmp -s \\\n    <(/usr/bin/plutil -convert binary1 -o - \"$framework_plist\") \\\n    <(/usr/bin/plutil -convert binary1 -o - \"$expected_plist\") \\\n    || fail \"$label Info.plist 完整字段合同漂移\"\n}\n\nverify_apple_xcframework() {\n  local xcframework=\"$1\" entries expected_entries index identifier library_path\n  local binary_path expected_binary_path architecture extra_architecture platform variant\n  local metadata expected_metadata plist_keys library_keys expected_library_keys\n  local identifiers='' ios_device_identifier='' ios_simulator_identifier=''\n  local macos_identifier=''\n  [[ -d \"$xcframework\" && ! -L \"$xcframework\" ]] \\\n    || fail \"CitizenSDK.xcframework 缺失或不是普通目录\"\n  [[ -f \"$xcframework/Info.plist\" && ! -L \"$xcframework/Info.plist\" ]] \\\n    || fail \"CitizenSDK.xcframework 缺少普通 Info.plist\"\n  plist_keys=\"$(/usr/libexec/PlistBuddy -c Print \"$xcframework/Info.plist\" \\\n    | awk '/^    [^ ]/ && / = / { print $1 }' | LC_ALL=C sort)\"\n  [[ \"$plist_keys\" == $'AvailableLibraries\\nCFBundlePackageType\\nXCFrameworkFormatVersion' \\\n    && \"$(/usr/libexec/PlistBuddy -c 'Print :XCFrameworkFormatVersion' \\\n      \"$xcframework/Info.plist\")\" == 1.0 ]] \\\n    || fail \"XCFramework Info.plist 根字段闭集或格式版本漂移\"\n  metadata=''\n  for index in 0 1 2; do\n    identifier=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:LibraryIdentifier\" \\\n      \"$xcframework/Info.plist\")\"\n    library_path=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:LibraryPath\" \\\n      \"$xcframework/Info.plist\")\"\n    binary_path=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:BinaryPath\" \\\n      \"$xcframework/Info.plist\")\"\n    architecture=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedArchitectures:0\" \\\n      \"$xcframework/Info.plist\")\"\n    extra_architecture=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedArchitectures:1\" \\\n      \"$xcframework/Info.plist\" 2>/dev/null || true)\"\n    platform=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatform\" \\\n      \"$xcframework/Info.plist\")\"\n    variant=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index:SupportedPlatformVariant\" \\\n      \"$xcframework/Info.plist\" 2>/dev/null || true)\"\n    [[ \"$identifier\" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ \\\n      && -d \"$xcframework/$identifier\" && ! -L \"$xcframework/$identifier\" ]] \\\n      || fail \"XCFramework LibraryIdentifier 必须是 Xcode 生成的安全不透明目录标识：$identifier\"\n    if printf '%s\\n' \"$identifiers\" | grep -Fxq \"$identifier\"; then\n      fail \"XCFramework LibraryIdentifier 重复：$identifier\"\n    fi\n    identifiers+=\"$identifier\"$'\\n'\n    library_keys=\"$(/usr/libexec/PlistBuddy \\\n      -c \"Print :AvailableLibraries:$index\" \"$xcframework/Info.plist\" \\\n      | awk '/^    [^ ]/ && / = / { print $1 }' | LC_ALL=C sort)\"\n    if [[ -n \"$variant\" ]]; then\n      expected_library_keys=$'BinaryPath\\nLibraryIdentifier\\nLibraryPath\\nSupportedArchitectures\\nSupportedPlatform\\nSupportedPlatformVariant'\n    else\n      expected_library_keys=$'BinaryPath\\nLibraryIdentifier\\nLibraryPath\\nSupportedArchitectures\\nSupportedPlatform'\n    fi\n    [[ \"$library_keys\" == \"$expected_library_keys\" ]] \\\n      || fail \"XCFramework slice 字段闭集漂移：$identifier\"\n    case \"$platform/$variant\" in\n      ios/)\n        [[ -z \"$ios_device_identifier\" ]] \\\n          || fail \"XCFramework 重复声明 iOS 设备技术变体\"\n        ios_device_identifier=\"$identifier\"\n        expected_binary_path='CitizenSDK.framework/CitizenSDK'\n        ;;\n      ios/simulator)\n        [[ -z \"$ios_simulator_identifier\" ]] \\\n          || fail \"XCFramework 重复声明 iOS simulator 技术变体\"\n        ios_simulator_identifier=\"$identifier\"\n        expected_binary_path='CitizenSDK.framework/CitizenSDK'\n        ;;\n      macos/)\n        [[ -z \"$macos_identifier\" ]] \\\n          || fail \"XCFramework 重复声明 macOS\"\n        macos_identifier=\"$identifier\"\n        expected_binary_path='CitizenSDK.framework/Versions/A/CitizenSDK'\n        ;;\n      *) fail \"XCFramework 含未登记 Apple 技术变体：$platform/$variant\" ;;\n    esac\n    [[ \"$library_path\" == CitizenSDK.framework && \"$architecture\" == arm64 \\\n      && \"$binary_path\" == \"$expected_binary_path\" && -z \"$extra_architecture\" ]] \\\n      || fail \"XCFramework slice 必须精确为单一 arm64 framework：$identifier\"\n    metadata+=\"$platform|$variant\"$'\\n'\n  done\n  metadata=\"$(printf '%s' \"$metadata\" | LC_ALL=C sort)\"\n  expected_metadata=$'ios|\\nios|simulator\\nmacos|'\n  [[ \"$metadata\" == \"$expected_metadata\" ]] \\\n    || fail \"XCFramework Info.plist 三 slice 元数据漂移\"\n  [[ -n \"$ios_device_identifier\" && -n \"$ios_simulator_identifier\" \\\n    && -n \"$macos_identifier\" ]] \\\n    || fail \"XCFramework 必须覆盖 iOS 设备、iOS simulator 技术变体和 macOS\"\n  # LibraryIdentifier 是 xcodebuild 生成的不透明技术标识，不得改写为\n  # 产品平台名。目录闭集只从 Info.plist 反向发现。\n  entries=\"$(find \"$xcframework\" -mindepth 1 -maxdepth 1 -print \\\n    | sed 's#^.*/##' | LC_ALL=C sort)\"\n  expected_entries=\"$(printf '%s\\n' Info.plist \"$ios_device_identifier\" \\\n    \"$ios_simulator_identifier\" \"$macos_identifier\" | LC_ALL=C sort)\"\n  [[ \"$entries\" == \"$expected_entries\" ]] \\\n    || fail \"CitizenSDK.xcframework slice 闭集漂移：${entries:-无}\"\n  [[ -z \"$(find \"$xcframework/$ios_device_identifier\" \\\n    \"$xcframework/$ios_simulator_identifier\" -type l -print -quit)\" ]] \\\n    || fail \"CitizenSDK.xcframework 的 iOS 技术变体禁止符号链接\"\n  while IFS= read -r link; do\n    case \"$link\" in\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/CitizenSDK\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Headers\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Modules\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Resources\"|\\\n      \"$xcframework/$macos_identifier/CitizenSDK.framework/Versions/Current\") ;;\n      *) fail \"CitizenSDK.xcframework 含未登记符号链接：$link\" ;;\n    esac\n  done < <(find \"$xcframework\" -type l -print)\n  [[ \"$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' \\\n    \"$xcframework/Info.plist\")\" == XFWK ]] \\\n    || fail \"XCFramework Info.plist 产品类型必须是 XFWK\"\n  /usr/libexec/PlistBuddy -c 'Print :AvailableLibraries:3' \\\n    \"$xcframework/Info.plist\" >/dev/null 2>&1 \\\n    && fail \"XCFramework Info.plist 含额外 slice\" || true\n  verify_apple_framework_slice \\\n    \"$xcframework/$ios_device_identifier/CitizenSDK.framework\" \\\n    \"CitizenSDK iOS（设备技术变体）\" IOS 16.0 arm64-apple-ios\n  verify_apple_framework_slice \\\n    \"$xcframework/$ios_simulator_identifier/CitizenSDK.framework\" \\\n    \"CitizenSDK iOS（simulator 技术变体）\" IOSSIMULATOR 16.0 \\\n    arm64-apple-ios-simulator\n  verify_apple_framework_slice \\\n    \"$xcframework/$macos_identifier/CitizenSDK.framework\" \\\n    \"CitizenSDK macOS\" MACOS 13.0 arm64-apple-macos\n}\n\nbuild_apple() {\n  [[ \"$(uname -s)\" == Darwin ]] || fail \"Apple 产品只允许在 macOS runner 构建\"\n  local create_root created_xcframework destination flutter_root\n  local flutter_ios_xcframework flutter_macos_xcframework\n  local citizen_ios_framework citizen_ios_simulator_framework citizen_macos_framework\n  command -v xcodebuild >/dev/null 2>&1 || fail \"缺少 xcodebuild\"\n  build_apple_framework_slice \\\n    aarch64-apple-ios iphoneos arm64-apple-ios16.0 aarch64-apple-ios \\\n    arm64-apple-ios iPhoneOS iphoneos MinimumOSVersion \"$ios_deployment_target\"\n  build_apple_framework_slice \\\n    aarch64-apple-ios-sim iphonesimulator arm64-apple-ios16.0-simulator \\\n    aarch64-apple-ios-sim arm64-apple-ios-simulator iPhoneSimulator iphonesimulator \\\n    MinimumOSVersion \"$ios_deployment_target\"\n  build_apple_framework_slice \\\n    aarch64-apple-darwin macosx arm64-apple-macosx13.0 aarch64-apple-darwin \\\n    arm64-apple-macos MacOSX macosx LSMinimumSystemVersion \"$macos_deployment_target\"\n\n  create_root=\"$work_dir/apple-xcframework\"\n  prepare_safe_directory \"$work_dir\" \"$create_root\" \"Apple XCFramework 生成目录\"\n  created_xcframework=\"$create_root/CitizenSDK.xcframework\"\n  [[ ! -e \"$created_xcframework\" && ! -L \"$created_xcframework\" ]] \\\n    || fail \"Apple XCFramework 生成目标已存在\"\n  xcodebuild -create-xcframework \\\n    -framework \"$work_dir/apple-build/aarch64-apple-ios/CitizenSDK.framework\" \\\n    -framework \"$work_dir/apple-build/aarch64-apple-ios-sim/CitizenSDK.framework\" \\\n    -framework \"$work_dir/apple-build/aarch64-apple-darwin/CitizenSDK.framework\" \\\n    -output \"$created_xcframework\"\n  # Xcode 27 在存在 stable interface 时会从 create-xcframework 输出中移除\n  # 编译 `.swiftmodule`。从三个已经逐 slice 验证的输入 framework 原字节恢复，\n  # 让同编译器快速路径与跨编译器 textual interface 同时进入唯一产品。\n  restore_swift_module_artifacts \"$created_xcframework\"\n  verify_apple_xcframework \"$created_xcframework\"\n\n  flutter_root=\"$(resolve_flutter_sdk_root)\"\n  flutter_ios_xcframework=\"$flutter_root/bin/cache/artifacts/engine/ios-release/Flutter.xcframework\"\n  flutter_macos_xcframework=\"$(resolve_flutter_macos_xcframework \"$flutter_root\")\"\n  citizen_ios_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$created_xcframework\" CitizenSDK ios '')\"\n  citizen_ios_simulator_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$created_xcframework\" CitizenSDK ios simulator)\"\n  citizen_macos_framework=\"$(resolve_xcframework_framework_slice \\\n    \"$created_xcframework\" CitizenSDK macos '')\"\n  compile_apple_flutter_adapter iphoneos arm64-apple-ios16.0 aarch64-apple-ios \\\n    ios '' Flutter \"$flutter_ios_xcframework\" \"$(dirname \"$citizen_ios_framework\")\"\n  compile_apple_flutter_adapter iphonesimulator arm64-apple-ios16.0-simulator \\\n    aarch64-apple-ios-sim ios simulator Flutter \"$flutter_ios_xcframework\" \\\n    \"$(dirname \"$citizen_ios_simulator_framework\")\"\n  compile_apple_flutter_adapter macosx arm64-apple-macosx13.0 \\\n    aarch64-apple-darwin macos '' FlutterMacOS \"$flutter_macos_xcframework\" \\\n    \"$(dirname \"$citizen_macos_framework\")\"\n\n  destination=\"$output_dir/apple/CitizenSDK.xcframework\"\n  prepare_safe_directory \"$output_dir\" \"$(dirname \"$destination\")\" \\\n    \"Apple 产品父目录\"\n  [[ ! -e \"$destination\" && ! -L \"$destination\" ]] \\\n    || fail \"Apple 产品目标已存在：$destination\"\n  cp -R \"$created_xcframework\" \"$destination\"\n  verify_apple_xcframework \"$destination\"\n  echo \"CitizenSDK iOS/macOS XCFramework 完成：$destination\"\n}\n\nlinux_platform_contract() {\n  local platform=\"$1\" expected_arch rust_target\n  [[ \"$(uname -s)\" == Linux ]] \\\n    || fail \"$platform 只允许在匹配的原生 Linux runner 构建\"\n  case \"$platform\" in\n    LinuxARM)\n      expected_arch=aarch64\n      rust_target=aarch64-unknown-linux-gnu\n      ;;\n    LinuxAMD)\n      expected_arch=x86_64\n      rust_target=x86_64-unknown-linux-gnu\n      ;;\n    *) fail \"未登记的 Linux 平台：$platform\" ;;\n  esac\n  [[ \"$(uname -m)\" == \"$expected_arch\" ]] \\\n    || fail \"$platform 必须在 $expected_arch 原生 runner 构建；实际=$(uname -m)\"\n  printf '%s|%s\\n' \"$rust_target\" \"$expected_arch\"\n}\n\nverify_linux_ctest_inventory() {\n  local ctest_bin=\"$1\" directory=\"$2\" label=\"$3\" expected=\"$4\" inventory count\n  local variable names actual\n  case \"$label:$expected\" in\n    LinuxHost:12) variable=CITIZENSDK_LINUX_CONTRACT_TESTS ;;\n    LinuxFlutter:6) variable=CITIZENSDK_LINUX_FLUTTER_CONTRACT_TESTS ;;\n    LinuxConsumer:2) variable='' ;;\n    *) fail \"未登记的 Linux CTest 闭集：$label/$expected\" ;;\n  esac\n  if [[ -n \"$variable\" ]]; then\n    names=\"$(CITIZENSDK_CTEST_LIST=\"$variable\" perl -0777 -ne '\n      my $name = $ENV{CITIZENSDK_CTEST_LIST};\n      my @lists = /set\\(\\Q$name\\E\\s+([^)]*)\\)/g;\n      die \"CTest source list must be unique\\n\" unless @lists == 1;\n      my @names = grep { length } split /\\s+/, $lists[0];\n      for (@names) { die \"Invalid CTest source name\\n\" unless /^citizen_sdk_[a-z0-9_]+_test$/; }\n      print join(\"\\n\", map { \"CitizenSDK.Linux.$_\" } @names), \"\\n\";\n      exit;\n    ' \"$linux_source_root/tests/CMakeLists.txt\")\" \\\n      || fail \"无法读取 $label 唯一源码测试名单\"\n  else\n    names=$'CitizenSDK.Linux.CConsumer\\nCitizenSDK.Linux.CppConsumer'\n  fi\n  [[ \"$(printf '%s\\n' \"$names\" | wc -l | tr -d ' ')\" == \"$expected\" \\\n      && \"$(printf '%s\\n' \"$names\" | LC_ALL=C sort | uniq -d)\" == '' ]] \\\n    || fail \"$label 源码测试名单数量或唯一性漂移\"\n  inventory=\"$(\"$ctest_bin\" --test-dir \"$directory\" -N -L \"^$label$\" 2>&1)\" \\\n    || fail \"无法枚举 $label CTest 合同\"\n  count=\"$(printf '%s\\n' \"$inventory\" | sed -n 's/^Total Tests: \\([0-9][0-9]*\\)$/\\1/p')\"\n  [[ \"$count\" == \"$expected\" ]] \\\n    || fail \"$label CTest 数量必须为 ${expected}；实际=${count:-无}\"\n  actual=\"$(printf '%s\\n' \"$inventory\" \\\n    | sed -n 's/^[[:space:]]*Test[[:space:]]*#[0-9][0-9]*:[[:space:]]*//p' \\\n    | LC_ALL=C sort)\"\n  [[ \"$actual\" == \"$(printf '%s\\n' \"$names\" | LC_ALL=C sort)\" ]] \\\n    || fail \"$label CTest 名称闭集不一致；拒绝替换、重复或遗漏\"\n}\n\nverify_linux_runtime_resolution() {\n  local executable=\"$1\" runtime_dir=\"$2\" resolution library resolved\n  resolution=\"$(LC_ALL=C ldd \"$executable\" 2>&1)\" \\\n    || fail \"无法解析 Linux 消费者的真实动态运行依赖\"\n  ! printf '%s\\n' \"$resolution\" | grep -Fq 'not found' \\\n    || fail \"Linux 消费者存在未解析的动态依赖\"\n  for library in libcitizensdk.so libcitizensdk_host.so; do\n    resolved=\"$(printf '%s\\n' \"$resolution\" | awk -v name=\"$library\" '$1 == name && $2 == \"=>\" { print $3 }')\"\n    [[ \"$resolved\" == \"$runtime_dir/$library\" ]] \\\n      || fail \"Linux 消费者没有解析到本轮唯一的 $library\"\n  done\n}\n\nverify_linux_tool_tree() {\n  local root=\"$1\" label=\"$2\" entry target resolved\n  assert_readonly_dependency_directory \"$root\" \"$label\"\n  [[ -z \"$(find \"$root\" ! -type f ! -type d ! -type l -print -quit)\" ]] \\\n    || fail \"$label 禁止特殊文件\"\n  [[ -z \"$(find \"$root\" -type f -name .git -print -quit)\" ]] \\\n    || fail \"$label 禁止指向外部 worktree 的 .git 文件\"\n  while IFS= read -r -d '' entry; do\n    target=\"$(readlink \"$entry\")\" || fail \"$label 无法读取符号链接\"\n    [[ \"$target\" != /* ]] || fail \"$label 禁止绝对符号链接\"\n    resolved=\"$(realpath -e \"$entry\")\" || fail \"$label 禁止悬空符号链接\"\n    case \"$resolved/\" in \"$root/\"*) ;; *) fail \"$label 符号链接越界\" ;; esac\n  done < <(find \"$root\" -type l -print0)\n}\n\nverify_linux_flutter_cache() {\n  local root=\"$1\" platform=\"$2\" arch revision name expected path\n  case \"$platform\" in LinuxARM) arch=arm64 ;; LinuxAMD) arch=x64 ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  verify_linux_tool_tree \"$root\" \"$platform Flutter SDK\"\n  [[ -d \"$root/.git\" && ! -L \"$root/.git\" ]] || fail \"Flutter SDK 必须是预装的完整普通目录\"\n  for path in bin/cache/flutter_tools.snapshot bin/cache/flutter_tools.stamp \\\n      bin/cache/flutter.version.json bin/cache/engine.stamp bin/internal/engine.version \\\n      packages/flutter_tools/pubspec.yaml packages/flutter_tools/pubspec.lock \\\n      bin/cache/dart-sdk/bin/dart \\\n      bin/cache/pkg/sky_engine/pubspec.yaml bin/cache/pkg/flutter_gpu/pubspec.yaml \\\n      bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill \\\n      bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill \\\n      \"bin/cache/artifacts/engine/linux-$arch/font-subset\" \\\n      \"bin/cache/artifacts/engine/linux-$arch/icudtl.dat\" \\\n      \"bin/cache/artifacts/engine/linux-$arch-release/gen_snapshot\"; do\n    [[ -f \"$root/$path\" && ! -L \"$root/$path\" && -s \"$root/$path\" ]] \\\n      || fail \"$platform 缺少已缓存 Flutter 文件：${path}；禁止自动下载\"\n  done\n  revision=\"$(<\"$root/bin/cache/engine.stamp\")\"\n  [[ \"$revision\" =~ ^[0-9a-f]{40}$ ]] || fail \"Flutter engine.stamp 格式无效\"\n  [[ \"$(<\"$root/bin/internal/engine.version\")\" == \"$revision\" ]] \\\n    || fail \"$platform Flutter 源码 engine.version 与已有缓存不同；禁止自动升级\"\n  for name in flutter_sdk linux-sdk font-subset; do\n    [[ -f \"$root/bin/cache/$name.stamp\" && ! -L \"$root/bin/cache/$name.stamp\" \\\n        && \"$(<\"$root/bin/cache/$name.stamp\")\" == \"$revision\" ]] \\\n      || fail \"$platform Flutter $name 缓存版本不完整；禁止自动更新\"\n  done\n  for name in material_fonts gradle_wrapper; do\n    [[ -f \"$root/bin/internal/$name.version\" && -f \"$root/bin/cache/$name.stamp\" ]] \\\n      || fail \"$platform Flutter $name 缓存未预装\"\n    expected=\"$(<\"$root/bin/internal/$name.version\")\"\n    [[ \"$(<\"$root/bin/cache/$name.stamp\")\" == \"$expected\" \\\n        && -d \"$root/bin/cache/artifacts/$name\" ]] \\\n      || fail \"$platform Flutter $name 缓存版本不完整\"\n  done\n  # 官方 LinuxEngineArtifacts 会同时检查三个目录；即使这里只构建 Release，\n  # 也不能留缺项诱使 Flutter build 自动取得其它运行件。ICU 是无 mode 的\n  # 通用 host artifact（上面已核验），不要求 profile/release 各自含一份。\n  for name in \"linux-$arch\" \"linux-$arch-profile\" \"linux-$arch-release\"; do\n    for path in libflutter_linux_gtk.so flutter_linux/flutter_linux.h gen_snapshot; do\n      [[ -f \"$root/bin/cache/artifacts/engine/$name/$path\" \\\n          && ! -L \"$root/bin/cache/artifacts/engine/$name/$path\" ]] \\\n        || fail \"$platform Flutter $name/$path 缓存缺失\"\n    done\n  done\n  perl -MJSON::PP -e '\n    use strict; use warnings;\n    my ($root, $engine) = @ARGV;\n    open my $input, \"<\", \"$root/bin/cache/flutter.version.json\" or die \"Flutter version missing\\n\";\n    local $/; my $version = decode_json(<$input>);\n    die \"Flutter engine revision mismatch\\n\" unless $version->{engineRevision} eq $engine;\n    die \"Flutter framework revision invalid\\n\" unless $version->{frameworkRevision} =~ /^[0-9a-f]{40}$/;\n    open my $stamp, \"<\", \"$root/bin/cache/flutter_tools.stamp\" or die \"Flutter tools stamp missing\\n\";\n    my $value = <$stamp>; $value =~ s/\\s+\\z//;\n    die \"Flutter snapshot version mismatch\\n\" unless $value eq \"$version->{frameworkRevision}:\";\n  ' \"$root\" \"$revision\" || fail \"$platform Flutter snapshot/版本身份不一致\"\n}\n\nverify_linux_flutter_elf() {\n  local platform=\"$1\" bundle=\"$2\" prefix=\"$3\" readelf_bin=\"$4\" nm_bin=\"$5\"\n  local machine plugin needed symbols rpath runpath library\n  case \"$platform\" in LinuxARM) machine=AArch64 ;; LinuxAMD) machine='Advanced Micro Devices X86-64' ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  [[ -d \"$bundle\" && ! -L \"$bundle\" ]] || fail \"$platform Flutter bundle 缺失\"\n  [[ -z \"$(find \"$bundle\" ! -type d ! -type f -print -quit)\" ]] \\\n    || fail \"$platform Flutter bundle 禁止符号链接或特殊节点\"\n  for library in libcitizensdk.so libcitizensdk_host.so; do\n    cmp -s \"$prefix/lib/$platform/$library\" \"$bundle/lib/$library\" \\\n      || fail \"$platform Flutter bundle 的 $library 不是同版安装运行件\"\n  done\n  verify_linux_elf_identity \"$platform\" \"$bundle/lib/libcitizensdk.so\" \\\n    \"$bundle/lib/libcitizensdk_host.so\" \"$readelf_bin\" \"$nm_bin\"\n  plugin=\"$bundle/lib/libcitizen_sdk_plugin.so\"\n  for library in \"$bundle/citizensdk_consumer\" \"$plugin\" \"$bundle/lib/libflutter_linux_gtk.so\" \"$bundle/lib/libapp.so\"; do\n    [[ -f \"$library\" && ! -L \"$library\" ]] || fail \"$platform Flutter bundle 运行闭包不完整\"\n    verify_linux_machine \"$library\" \"$readelf_bin\" \"$machine\" \"$platform Flutter $(basename \"$library\")\"\n    # Flutter engine 是官方运行件，不能把它的 C++ ABI 误称 SDK 自身静态闭包。\n    if [[ \"$library\" == \"$bundle/lib/libflutter_linux_gtk.so\" ]]; then\n      verify_linux_glibc_contract \"$library\" \"$readelf_bin\" \"$platform Flutter engine\" true\n    else\n      verify_linux_glibc_contract \"$library\" \"$readelf_bin\" \"$platform Flutter $(basename \"$library\")\"\n    fi\n    needed=\"$(linux_elf_dynamic_values \"$library\" \"$readelf_bin\" NEEDED)\"\n    [[ \"$needed\" != */* ]] || fail \"$platform Flutter DT_NEEDED 禁止构建路径\"\n  done\n  symbols=\"$(product_library_symbols \"$plugin\" \"$nm_bin\" '')\"\n  [[ \"$symbols\" == citizen_sdk_plugin_register_with_registrar ]] \\\n    || fail \"$platform Flutter plugin 只能导出官方注册入口，不得复制 Core/Host\"\n  needed=\"$(linux_elf_dynamic_values \"$plugin\" \"$readelf_bin\" NEEDED)\"\n  for library in libcitizensdk.so libcitizensdk_host.so libflutter_linux_gtk.so; do\n    [[ \"$(printf '%s\\n' \"$needed\" | grep -Fxc \"$library\" || true)\" == 1 ]] \\\n      || fail \"$platform Flutter plugin 必须精确依赖一次 $library\"\n  done\n  if printf '%s\\n' \"$needed\" | grep -Eq '^(libsmoldot|libstdc\\+\\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)'; then\n    fail \"$platform Flutter plugin 泄漏禁止的动态依赖\"\n  fi\n  rpath=\"$(linux_elf_dynamic_values \"$plugin\" \"$readelf_bin\" RPATH)\"\n  runpath=\"$(linux_elf_dynamic_values \"$plugin\" \"$readelf_bin\" RUNPATH)\"\n  [[ -z \"$rpath\" && \"$runpath\" == '$ORIGIN' ]] || fail \"$platform Flutter plugin RUNPATH 必须精确为 \\$ORIGIN\"\n  rpath=\"$(linux_elf_dynamic_values \"$bundle/citizensdk_consumer\" \"$readelf_bin\" RPATH)\"\n  runpath=\"$(linux_elf_dynamic_values \"$bundle/citizensdk_consumer\" \"$readelf_bin\" RUNPATH)\"\n  [[ -z \"$rpath\" && \"$runpath\" == '$ORIGIN/lib' ]] || fail \"$platform Flutter runner RUNPATH 必须精确为 \\$ORIGIN/lib\"\n  for library in manifest.json chainspec.json light_sync_state.json; do\n    cmp -s \"$prefix/share/citizensdk/chain/$library\" \\\n      \"$bundle/data/flutter_assets/packages/citizen_sdk/chain/$library\" \\\n      || fail \"$platform Flutter bundle 链资产漂移：$library\"\n  done\n}\n\nbuild_linux_flutter_consumer() (\n  local platform=\"$1\" platform_work=\"$2\" prefix=\"$3\" cmake_bin=\"$4\" ctest_bin=\"$5\"\n  local readelf_bin=\"$6\" nm_bin=\"$7\" flutter_source=\"${CITIZENSDK_FLUTTER_ROOT:-}\"\n  local cache_source=\"${PUB_CACHE:-}\" root tool_root cache_root sdk_stage runner dart_bin\n  local arch flutter_build bundle path output status unshare_bin\n  local package=\"${8:-}\" candidate=\"${9:-$sdk_dir}\"\n  case \"$platform\" in LinuxARM) arch=arm64 ;; LinuxAMD) arch=x64 ;; *) fail \"未登记的 Linux 平台：$platform\" ;; esac\n  for path in ninja clang clang++ unshare timeout realpath perl; do\n    command -v \"$path\" >/dev/null 2>&1 || fail \"$platform Flutter 验收缺少已预装工具：$path\"\n  done\n  # Flutter/Dart 的部分设置与 telemetry 仍会直接访问现有 HOME，不遵循\n  # XDG。只接受调用环境已隔离好的 HOME；本脚本绝不设置 HOME、创建用户\n  # 或挂载文件系统。未满足时，在任何 Dart/Flutter 命令执行前失败关闭。\n  [[ -n \"${HOME:-}\" ]] || fail \"$platform 未提供获准的隔离 HOME 环境\"\n  assert_safe_directory_path \"$HOME\" \"$platform 已有工具 HOME\"\n  case \"$HOME/\" in \"$work_dir/\"*) ;; *) fail \"$platform 已有 HOME 必须位于本轮中央 work_dir；请提供获准隔离环境\" ;; esac\n  [[ -d \"$HOME\" && ! -L \"$HOME\" \\\n      && \"$(stat -c '%a' \"$HOME\")\" == 700 \\\n      && \"$(stat -c '%u' \"$HOME\")\" == \"$(id -u)\" ]] \\\n    || fail \"$platform 已有 HOME 必须是当前用户所有的普通 0700 目录\"\n  verify_linux_tool_tree \"$HOME\" \"$platform 已有工具 HOME\"\n  [[ ! -e \"$HOME/.flutter_settings\" && ! -L \"$HOME/.flutter_settings\" ]] \\\n    || fail \"$platform 隔离 HOME 不得带入旧 Flutter 设置或 build-dir 重定向\"\n  unshare_bin=\"$(command -v unshare)\"\n  # 无特权隔离只覆盖工具装配；不可用即失败，绝不 sudo、安装、改网络或创建 VM。\n  \"$unshare_bin\" --user --map-root-user --net true \\\n    || fail \"$platform 缺少获准的无特权 user/network namespace；禁止联网取得工具\"\n  verify_linux_flutter_cache \"$flutter_source\" \"$platform\"\n  verify_linux_tool_tree \"$cache_source\" \"$platform PUB_CACHE\"\n  [[ -n \"${DISPLAY:-}${WAYLAND_DISPLAY:-}\" ]] || fail \"$platform 真实 Flutter 消费者需要已获准的 GTK 显示会话\"\n  root=\"$platform_work/flutter\"\n  tool_root=\"$root/tools\"\n  cache_root=\"$root/pub-cache\"\n  sdk_stage=\"$root/citizen_sdk\"\n  runner=\"$root/consumer\"\n  for path in \"$flutter_source\" \"$cache_source\" \"$sdk_dir\"; do\n    case \"$root/\" in \"$path/\"*) fail \"$platform 工具或源码不能包含本轮副本目标\" ;; esac\n    case \"$path/\" in \"$root/\"*) fail \"$platform 工具或源码不能位于本轮副本目标内\" ;; esac\n  done\n  for path in \"$root\" \"$tool_root\" \"$cache_root\" \"$sdk_stage\" \"$runner\" \\\n      \"$root/tmp\" \"$root/config\" \"$root/cache\" \"$root/data\" \"$root/state\" \"$root/test-state\"; do\n    prepare_safe_directory \"$work_dir\" \"$path\" \"$platform Flutter 独占目录\"\n    chmod 0700 \"$path\"\n  done\n  # 仅复制调用方显式提供的工具/缓存，全部锁、package_config与构建记录留在本轮工作根。\n  cp -a \"$flutter_source/.\" \"$tool_root/\"\n  cp -a \"$cache_source/.\" \"$cache_root/\"\n  cp -a \"${package:-$sdk_dir}/.\" \"$sdk_stage/\"\n  if [[ -z \"$package\" ]]; then\n    node \"$sdk_dir/scripts/build.mjs\" projection \\\n      --flutter-source-entry \"$sdk_dir\" --output \"$sdk_stage\" >/dev/null\n  fi\n  chmod 0700 \"$tool_root\" \"$cache_root\" \"$sdk_stage\"\n  verify_linux_tool_tree \"$tool_root\" \"$platform Flutter 工具副本\"\n  verify_linux_tool_tree \"$cache_root\" \"$platform PUB_CACHE 副本\"\n  [[ -z \"$(find \"$sdk_stage\" -type l -print -quit)\" ]] || fail \"$platform SDK 验收副本禁止符号链接\"\n  # 候选消费者与发布包使用完全相同的 linux/ 安装前缀；本机构建只注入\n  # 当前平台，双平台共有文件的原子合并由唯一 release 打包器负责。\n  if [[ -z \"$package\" ]]; then\n    copy_linux_install \"$prefix\" \"$sdk_stage/linux\" \"$platform\" \"$work_dir\"\n  fi\n  export FLUTTER_ROOT=\"$tool_root\" PUB_CACHE=\"$cache_root\"\n  export XDG_CONFIG_HOME=\"$root/config\" XDG_CACHE_HOME=\"$root/cache\"\n  export XDG_DATA_HOME=\"$root/data\" XDG_STATE_HOME=\"$root/state\" TMPDIR=\"$root/tmp\"\n  export FLUTTER_SUPPRESS_ANALYTICS=true\n  # 不继承可把日志、引擎或 pub 路由到外部的工具覆盖项；缓存缺失只能失败。\n  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \\\n    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH\n  dart_bin=\"$tool_root/bin/cache/dart-sdk/bin/dart\"\n  # 外层直接消费已核验 snapshot。官方 CMake 后端仍会调用副本 bin/flutter\n  # 执行 assemble；不改写该官方链路，靠完整缓存预检与整个工具子进程禁网\n  # 拒绝缺项升级。--offline 仅用于官方确实支持的 pub/create 命令。\n  (cd \"$tool_root/packages/flutter_tools\" && \\\n    \"$unshare_bin\" --user --map-root-user --net \"$dart_bin\" pub get --offline)\n  local package_config=\"$tool_root/packages/flutter_tools/.dart_tool/package_config.json\"\n  if grep -F -e \"$flutter_source/\" -e \"$cache_source/\" \"$package_config\" >/dev/null; then\n    fail \"$platform Flutter 工具配置仍引用原工具或缓存\"\n  fi\n  local -a flutter=(\"$unshare_bin\" --user --map-root-user --net \"$dart_bin\"\n    \"--packages=$package_config\" \"$tool_root/bin/cache/flutter_tools.snapshot\"\n    --no-version-check --suppress-analytics)\n  \"${flutter[@]}\" create --offline --no-pub --platforms=linux \\\n    --project-name=citizensdk_consumer --org=org.citizen \"$runner\"\n  printf '%s\\n' 'name: citizensdk_consumer' 'publish_to: none' 'version: 1.0.0' \\\n    'environment:' '  sdk: \">=3.8.0 <4.0.0\"' 'dependencies:' '  flutter:' \\\n    '    sdk: flutter' '  citizen_sdk:' '    path: ../citizen_sdk' \\\n    'flutter:' '  uses-material-design: true' >\"$runner/pubspec.yaml\"\n  cp \"$candidate/pubspec.lock\" \"$runner/pubspec.lock\"\n  cp \"$candidate/linux/tests/citizen_sdk_flutter_consumer.dart\" \"$runner/lib/main.dart\"\n  # 只改生成的 runner CMake 装配。保留官方 generated registrant 和自动插件发现；\n  # 父级 enable_testing 让六个 adapter 合同能被顶层 CTest 实际枚举到。\n  for path in \"$root/test-state\"; do\n    case \"$path\" in *'\"'*|*';'*|*'$'*|*'\\'*|*$'\\n'*|*$'\\r'*) fail \"Flutter CMake 路径含不允许的语法字符\" ;; esac\n  done\n  CITIZENSDK_ADAPTER_TEST_ROOT=\"$root/test-state\" CITIZENSDK_HOSTED_PACKAGE=\"$package\" \\\n    perl -0777 -i -pe '\n      # 官方模板沿用 Dart project name 中的下划线，但 Host application_id\n      # 的既有安全合同只允许字母数字与分隔点；只修验证 runner 的公开身份。\n      s/^set\\(APPLICATION_ID \"org\\.citizen\\.citizensdk_consumer\"\\)$/set(APPLICATION_ID \"org.citizensdk.flutterconsumer\")/m == 1\n        or die \"Unexpected official runner application identity\\n\";\n      my $settings = length($ENV{CITIZENSDK_HOSTED_PACKAGE}) ? \"\" : \"set(CITIZENSDK_BUILD_TESTS ON)\\n\" .\n        \"set(CITIZENSDK_TEST_WORK_DIR \\\"$ENV{CITIZENSDK_ADAPTER_TEST_ROOT}\\\")\\n\" .\n        \"enable_testing()\\n\";\n      s/^include\\(flutter\\/generated_plugins.cmake\\)/$settings . $&/me == 1\n        or die \"Missing official generated plugins include\\n\";\n      $_ .= \"\\ntarget_link_options(\\${BINARY_NAME} PRIVATE -static-libstdc++ -static-libgcc)\\n\";\n    ' \"$runner/linux/CMakeLists.txt\"\n  (cd \"$runner\" && \"${flutter[@]}\" pub get --offline && \\\n    \"${flutter[@]}\" build linux --release --no-pub --target-platform=\"linux-$arch\")\n  flutter_build=\"$runner/build/linux/$arch/release\"\n  bundle=\"$flutter_build/bundle\"\n  # 内部适配层合同属于原生构建阶段；最终 Hosted 只消费公开插件与运行件，\n  # 绝不把审计测试补入发布包，也不重新构建 Host/Core。\n  if [[ -z \"$package\" ]]; then\n    verify_linux_ctest_inventory \"$ctest_bin\" \"$flutter_build\" LinuxFlutter 6\n    LD_LIBRARY_PATH=\"$sdk_stage/linux/lib/$platform:$runner/linux/flutter/ephemeral\" \\\n      \"$ctest_bin\" --test-dir \"$flutter_build\" --build-config Release \\\n        -L '^LinuxFlutter$' --no-tests=error --output-on-failure\n  fi\n  verify_linux_flutter_elf \"$platform\" \"$bundle\" \"$sdk_stage/linux\" \"$readelf_bin\" \"$nm_bin\"\n  verify_linux_runtime_resolution \"$bundle/citizensdk_consumer\" \"$bundle/lib\"\n  # 不使用 flutter run 的“已启动”退出状态代替消费者结果；只运行最终bundle。\n  output=\"$root/consumer.stdout\"\n  prepare_safe_output_file \"$work_dir\" \"$output\" \"$platform Flutter 消费者输出\"\n  prepare_safe_output_file \"$work_dir\" \"$root/consumer.stderr\" \"$platform Flutter 消费者错误输出\"\n  status=0\n  FLUTTER_LINUX_RENDERER=software timeout --signal=TERM --kill-after=10s 200s \\\n    \"$bundle/citizensdk_consumer\" >\"$output\" 2>\"$root/consumer.stderr\" || status=$?\n  [[ \"$status\" == 0 ]] || fail \"$platform Flutter 消费者失败或超时；退出码=$status\"\n  [[ \"$(grep -Fxc 'CitizenSDK Flutter consumer passed' \"$output\" || true)\" == 1 ]] \\\n    || fail \"$platform Flutter 消费者缺少唯一成功标记\"\n)\n\n\n# 唯一中央准备收据是这些静态环境输入的共同来源；不得逐个指向不同安装树。\nload_native_dependencies() {\n  local platform=\"$1\" receipt=\"${CITIZENSDK_DEPENDENCY_RECEIPT:-}\" source=\"$sdk_dir\"\n  local values key value supplied\n  [[ -n \"$receipt\" ]] || fail \"$platform 缺少 CITIZENSDK_DEPENDENCY_RECEIPT\"\n  if [[ \"$platform\" == Windows ]]; then\n    receipt=\"$(cygpath -m \"$receipt\")\"; source=\"$(cygpath -m \"$source\")\"\n  fi\n  values=\"$(MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$source\" \"$receipt\" \"$platform\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nimport {readFileSync} from 'node:fs';\nconst [source,receipt,platform]=process.argv.slice(2);\nconst {resolve}=await import('node:path');\n// Git Bash 的 C:/ 与 Node 的 C:\\\\ 是同一官方路径；进入严格路径验证前规范化一次。\nconst canonicalReceipt=resolve(receipt);\nconst api=await import(pathToFileURL(join(source,'scripts/build.mjs')));\nconst inputs=api.assertCitizenSdkDependencyInputs(canonicalReceipt,platform);\nif(inputs.source_sha!==process.env.CITIZENSDK_SOURCE_SHA) throw Error('dependency source SHA mismatch');\nif(!readFileSync(join(source,'pubspec.yaml'),'utf8').includes('\\nversion: '+inputs.software_version+'\\n'))\n  throw Error('dependency software version mismatch');\nfor(const [key,value] of Object.entries(api.citizenSdkDependencyEnvironment(canonicalReceipt,platform))) {\n  if(/[\\r\\n=]/.test(value)) throw Error('unsafe dependency path');\n  process.stdout.write(key+'='+value+'\\n');\n}\nNODE\n)\" || fail \"$platform 静态依赖收据验证失败\"\n  while IFS='=' read -r key value; do\n    [[ -n \"$key\" ]] || continue\n    if [[ \"$platform\" == Windows ]]; then value=\"$(cygpath -u \"$value\")\"; fi\n    supplied=\"${!key:-}\"\n    [[ -z \"$supplied\" || \"$supplied\" == \"$value\" ]] || fail \"$platform 禁止混用其他静态输入：$key\"\n    export \"$key=$value\"\n  done <<<\"$values\"\n}\n\nrecord_native_dependencies() {\n  local platform=\"$1\" receipt=\"$CITIZENSDK_DEPENDENCY_RECEIPT\" source=\"$sdk_dir\" native=\"$output_dir\"\n  if [[ \"$platform\" == Windows ]]; then\n    receipt=\"$(cygpath -m \"$receipt\")\"; source=\"$(cygpath -m \"$source\")\"; native=\"$(cygpath -m \"$native\")\"\n  fi\n  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$source\" \"$receipt\" \"$platform\" \"$native\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst [sourcePath,receiptPath,platform,nativePath]=process.argv.slice(2);\nconst {writeCitizenSdkDependencyEvidence}=await import(pathToFileURL(join(sourcePath,'scripts/build.mjs')));\nconst {resolve}=await import('node:path');\nwriteCitizenSdkDependencyEvidence({sourcePath:resolve(sourcePath),receiptPath:resolve(receiptPath),platform,\n  nativePath:resolve(nativePath),sourceSha:process.env.CITIZENSDK_SOURCE_SHA});\nNODE\n}\n\n\nbuild_linux() (\n  prepare_internal_header\n  local platform=\"$1\" contract rust_target expected_arch cmake_bin ctest_bin\n  local nm_bin readelf_bin strip_bin cmake_build runtime_stage source_core\n  local destination core_destination host_destination linux_platform_work\n  local linux_test_work install_prefix consumer_build software_version loader_variable\n  local sqlite_include openssl_include tss2_include\n  local sqlite_archive crypto_archive tss2_esys_archive tss2_mu_archive\n  local tss2_sys_archive tss2_rc_archive tss2_tcti_device_archive\n  contract=\"$(linux_platform_contract \"$platform\")\"\n  IFS='|' read -r rust_target expected_arch <<<\"$contract\"\n  # 只影响 Linux 子进程：新状态统一 0700，且动态加载器不能被调用方环境\n  # 指向另一套 Core/Host。Android/Apple 的既有流程和环境保持原样。\n  umask 077\n  for loader_variable in ${!LD_@}; do unset \"$loader_variable\"; done\n  require_rust_target \"$rust_target\"\n  [[ -d \"$linux_source_root\" && ! -L \"$linux_source_root\" ]] \\\n    || fail \"CitizenSDK 缺少普通 Linux 平台源码目录\"\n  for tool in cmake ctest ldd; do\n    command -v \"$tool\" >/dev/null 2>&1 || fail \"$platform 缺少 $tool\"\n  done\n  cmake_bin=\"$(command -v cmake)\"\n  ctest_bin=\"$(command -v ctest)\"\n  nm_bin=\"$(command -v llvm-nm || command -v nm || true)\"\n  readelf_bin=\"$(command -v llvm-readelf || command -v readelf || true)\"\n  strip_bin=\"$(command -v llvm-strip || command -v strip || true)\"\n  [[ -n \"$nm_bin\" && -n \"$readelf_bin\" && -n \"$strip_bin\" ]] \\\n    || fail \"$platform 缺少 llvm-nm/nm、llvm-readelf/readelf 或 llvm-strip/strip\"\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  [[ \"$software_version\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] \\\n    || fail \"$platform SDK 版本必须是唯一正式三段版本\"\n\n  # Linux Host 只能链接 CI/Release 预先锁定并放在源码树外的静态依赖。\n  load_native_dependencies \"$platform\"\n  # 禁止 CMake 从宿主动态库或源码目录临时下载另一份 SQLite、crypto 或 TPM2-TSS。\n  sqlite_include=\"${CITIZENSDK_HOST_SQLITE_INCLUDE_DIR:-}\"\n  openssl_include=\"${CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR:-}\"\n  tss2_include=\"${CITIZENSDK_HOST_TSS2_INCLUDE_DIR:-}\"\n  sqlite_archive=\"${CITIZENSDK_HOST_SQLITE_ARCHIVE:-}\"\n  crypto_archive=\"${CITIZENSDK_HOST_CRYPTO_ARCHIVE:-}\"\n  tss2_esys_archive=\"${CITIZENSDK_HOST_TSS2_ESYS_ARCHIVE:-}\"\n  tss2_mu_archive=\"${CITIZENSDK_HOST_TSS2_MU_ARCHIVE:-}\"\n  tss2_sys_archive=\"${CITIZENSDK_HOST_TSS2_SYS_ARCHIVE:-}\"\n  tss2_rc_archive=\"${CITIZENSDK_HOST_TSS2_RC_ARCHIVE:-}\"\n  tss2_tcti_device_archive=\"${CITIZENSDK_HOST_TSS2_TCTI_DEVICE_ARCHIVE:-}\"\n  assert_readonly_dependency_directory \"$sqlite_include\" \\\n    CITIZENSDK_HOST_SQLITE_INCLUDE_DIR\n  assert_readonly_dependency_directory \"$openssl_include\" \\\n    CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR\n  assert_readonly_dependency_directory \"$tss2_include\" \\\n    CITIZENSDK_HOST_TSS2_INCLUDE_DIR\n  assert_readonly_static_archive \"$sqlite_archive\" CITIZENSDK_HOST_SQLITE_ARCHIVE\n  assert_readonly_static_archive \"$crypto_archive\" CITIZENSDK_HOST_CRYPTO_ARCHIVE\n  assert_readonly_static_archive \"$tss2_esys_archive\" CITIZENSDK_HOST_TSS2_ESYS_ARCHIVE\n  assert_readonly_static_archive \"$tss2_mu_archive\" CITIZENSDK_HOST_TSS2_MU_ARCHIVE\n  assert_readonly_static_archive \"$tss2_sys_archive\" CITIZENSDK_HOST_TSS2_SYS_ARCHIVE\n  assert_readonly_static_archive \"$tss2_rc_archive\" CITIZENSDK_HOST_TSS2_RC_ARCHIVE\n  assert_readonly_static_archive \"$tss2_tcti_device_archive\" \\\n    CITIZENSDK_HOST_TSS2_TCTI_DEVICE_ARCHIVE\n\n  linux_platform_work=\"$work_dir/linux/$platform\"\n  [[ ! -e \"$linux_platform_work\" && ! -L \"$linux_platform_work\" ]] \\\n    || fail \"$platform 工作目录必须全新：$linux_platform_work\"\n  prepare_safe_directory \"$work_dir\" \"$linux_platform_work\" \"$platform 工作目录\"\n  cmake_build=\"$linux_platform_work/cmake\"\n  runtime_stage=\"$linux_platform_work/runtime\"\n  linux_test_work=\"$linux_platform_work/test-state\"\n  install_prefix=\"$linux_platform_work/install\"\n  consumer_build=\"$linux_platform_work/consumers\"\n  destination=\"$output_dir/linux/$platform\"\n  [[ ! -e \"$destination\" && ! -L \"$destination\" ]] \\\n    || fail \"$platform 原生安装输出必须全新：$destination\"\n  prepare_safe_directory \"$work_dir\" \"$cmake_build\" \"$platform CMake 目录\"\n  prepare_safe_directory \"$work_dir\" \"$runtime_stage\" \"$platform 运行件暂存目录\"\n  prepare_safe_directory \"$work_dir\" \"$linux_test_work\" \"$platform 测试状态目录\"\n  prepare_safe_directory \"$work_dir\" \"$install_prefix\" \"$platform 安装验证前缀\"\n  prepare_safe_directory \"$work_dir\" \"$consumer_build\" \"$platform 安装后消费者构建目录\"\n  # Linux Host测试只可在当前平台任务独占的工作目录落盘；0700是\n  # CITIZENSDK_TEST_WORK_DIR 的公开前置条件，不能依赖 runner 的 umask。\n  chmod 0700 \"$linux_test_work\"\n  [[ \"$(stat -c '%a' \"$linux_test_work\")\" == 700 ]] \\\n    || fail \"$platform 测试状态目录权限必须精确为 0700：$linux_test_work\"\n  core_destination=\"$runtime_stage/libcitizensdk.so\"\n  prepare_safe_output_file \"$work_dir\" \"$core_destination\" \"$platform Core 暂存\"\n\n  # 机器 target triple 是类型化工具链字段，不得提升为公开平台名或输出目录名。\n  CARGO_PROFILE_RELEASE_STRIP=false \\\n  RUSTFLAGS='-C link-arg=-Wl,-soname,libcitizensdk.so -C link-arg=-static-libgcc' \\\n    cargo build --manifest-path \"$product_ffi_manifest\" --release --locked --offline \\\n      --target \"$rust_target\"\n  source_core=\"$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.so\"\n  [[ -f \"$source_core\" && ! -L \"$source_core\" ]] \\\n    || fail \"$platform Rust Core 未生成普通 libcitizensdk.so\"\n  cp \"$source_core\" \"$core_destination\"\n  \"$strip_bin\" --strip-unneeded \"$core_destination\"\n\n  \"$cmake_bin\" -S \"$linux_source_root\" -B \"$cmake_build\" \\\n    -DCMAKE_BUILD_TYPE=Release \\\n    -DCMAKE_C_COMPILER=\"${CC:-cc}\" \\\n    -DCMAKE_CXX_COMPILER=\"${CXX:-c++}\" \\\n    -DCMAKE_INSTALL_PREFIX=\"$install_prefix\" \\\n    -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_INCLUDEDIR=include \\\n    -DCMAKE_INSTALL_DATADIR=share -DCMAKE_INSTALL_BINDIR=bin \\\n    -DCMAKE_LIBRARY_OUTPUT_DIRECTORY=\"$runtime_stage\" \\\n    -DCITIZENSDK_PLATFORM=\"$platform\" \\\n    -DCITIZENSDK_CORE_LIBRARY=\"$core_destination\" \\\n    -DCITIZENSDK_CORE_INCLUDE_DIR=\"$sdk_dir/include\" \\\n    -DCITIZENSDK_INTERNAL_INCLUDE_DIR=\"$work_dir/private-include\" \\\n    -DCITIZENSDK_ASSET_DIR=\"$apple_asset_root\" \\\n    -DCITIZENSDK_SQLITE_INCLUDE_DIR=\"$sqlite_include\" \\\n    -DCITIZENSDK_OPENSSL_INCLUDE_DIR=\"$openssl_include\" \\\n    -DCITIZENSDK_TSS2_INCLUDE_DIR=\"$tss2_include\" \\\n    -DCITIZENSDK_SQLITE_ARCHIVE=\"$sqlite_archive\" \\\n    -DCITIZENSDK_CRYPTO_ARCHIVE=\"$crypto_archive\" \\\n    -DCITIZENSDK_TSS2_ESYS_ARCHIVE=\"$tss2_esys_archive\" \\\n    -DCITIZENSDK_TSS2_MU_ARCHIVE=\"$tss2_mu_archive\" \\\n    -DCITIZENSDK_TSS2_SYS_ARCHIVE=\"$tss2_sys_archive\" \\\n    -DCITIZENSDK_TSS2_RC_ARCHIVE=\"$tss2_rc_archive\" \\\n    -DCITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE=\"$tss2_tcti_device_archive\" \\\n    -DCITIZENSDK_ZXING_SOURCE_DIR=\"$CITIZENSDK_ZXING_SOURCE_DIR\" \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$linux_test_work\" \\\n    -DCITIZENSDK_BUILD_TESTS=ON \\\n    -DCITIZENSDK_ENABLE_QR_CAPTURE=ON \\\n    -DCITIZENSDK_WARNINGS_AS_ERRORS=ON\n  \"$cmake_bin\" --build \"$cmake_build\" --config Release --parallel\n  verify_linux_ctest_inventory \"$ctest_bin\" \"$cmake_build\" LinuxHost 12\n  LD_LIBRARY_PATH=\"$runtime_stage\" \\\n    \"$ctest_bin\" --test-dir \"$cmake_build\" --build-config Release \\\n      -L '^LinuxHost$' --no-tests=error --output-on-failure\n  # CMake install 完成后才验 RUNPATH：build-tree 仍可含链接期路径，不能\n  # 用它冒充已安装运行件。19 项是本步技术投影，不宣称已完成分发许可证闭包。\n  \"$cmake_bin\" --install \"$cmake_build\" --config Release --prefix \"$install_prefix\"\n  host_destination=\"$install_prefix/lib/$platform/libcitizensdk_host.so\"\n  [[ -f \"$host_destination\" && ! -L \"$host_destination\" ]] \\\n    || fail \"$platform CMake 未安装普通 libcitizensdk_host.so\"\n  \"$strip_bin\" --strip-unneeded \"$host_destination\"\n  verify_linux_install \"$install_prefix\" \"$platform\" \"$software_version\" \\\n    \"$core_destination\" \"$readelf_bin\" \"$nm_bin\"\n\n  # 原生消费者只有安装前缀，没有源码 Core/Host target 或私有头入口。\n  \"$cmake_bin\" -S \"$linux_source_root/tests\" -B \"$consumer_build\" \\\n    -DCMAKE_BUILD_TYPE=Release \\\n    -DCMAKE_C_COMPILER=\"${CC:-cc}\" -DCMAKE_CXX_COMPILER=\"${CXX:-c++}\" \\\n    -DCITIZENSDK_CONSUMER_PREFIX=\"$install_prefix\" \\\n    -DCITIZENSDK_PLATFORM=\"$platform\" \\\n    -DCITIZENSDK_CONSUMER_VERSION=\"$software_version\" \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$linux_test_work\"\n  \"$cmake_bin\" --build \"$consumer_build\" --config Release --parallel \\\n    --target citizen_sdk_c_consumer citizen_sdk_cpp_consumer\n  verify_linux_runtime_resolution \"$consumer_build/citizen_sdk_c_consumer\" \"$install_prefix/lib/$platform\"\n  verify_linux_runtime_resolution \"$consumer_build/citizen_sdk_cpp_consumer\" \"$install_prefix/lib/$platform\"\n  verify_linux_ctest_inventory \"$ctest_bin\" \"$consumer_build\" LinuxConsumer 2\n  \"$ctest_bin\" --test-dir \"$consumer_build\" --build-config Release \\\n    -L '^LinuxConsumer$' --no-tests=error --output-on-failure\n  build_linux_flutter_consumer \"$platform\" \"$linux_platform_work\" \"$install_prefix\" \\\n    \"$cmake_bin\" \"$ctest_bin\" \"$readelf_bin\" \"$nm_bin\"\n  # 所有消费者通过后才导出完整安装前缀，不能把裸双库当作可用的 SDK 输入。\n  copy_linux_install \"$install_prefix\" \"$destination\" \"$platform\" \"$output_dir\"\n  verify_linux_install \"$destination\" \"$platform\" \"$software_version\" \\\n    \"$core_destination\" \"$readelf_bin\" \"$nm_bin\"\n  record_native_dependencies \"$platform\"\n  echo \"CitizenSDK $platform 安装、原生与 Flutter 消费者验证完成：$destination\"\n)\n\nbuild_host() {\n  [[ \"$(uname -s)\" == \"Darwin\" ]] || fail \"当前宿主测试库只允许在 macOS runner 构建\"\n  local destination arm_library nm_bin symbols architectures\n  require_rust_target aarch64-apple-darwin\n  destination=\"$output_dir/host/libsmoldot.dylib\"\n  # legacy Dart/smoldot 差分测试运行件只保留当前正式 macOS；其\n  # 内部 Mach-O 架构必须是工具链值 arm64，且它绝不进入\n  # CitizenSDK 候选，也不能借 Rosetta 再建立 x86_64/universal 第二条构建路径。\n  MACOSX_DEPLOYMENT_TARGET=\"$macos_deployment_target\" \\\n  CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path \"$ffi_manifest\" \\\n    --release --locked --target aarch64-apple-darwin\n  arm_library=\"$CARGO_TARGET_DIR/aarch64-apple-darwin/release/libsmoldot.dylib\"\n  [[ -f \"$arm_library\" ]] || fail \"macOS 宿主测试库未生成\"\n  prepare_safe_output_file \"$output_dir\" \"$destination\" \"macOS 宿主测试库\"\n  cp \"$arm_library\" \"$destination\"\n  architectures=\"$(xcrun lipo -archs \"$destination\")\"\n  [[ \"$architectures\" == arm64 ]] || fail \"macOS 宿主测试库内部架构必须精确为 arm64\"\n  nm_bin=\"$(xcrun --find llvm-nm)\"\n  symbols=\"$(symbol_list_ios \"$destination\" \"$nm_bin\")\"\n  verify_symbol_contract \"$symbols\" \"_\" \"macOS 宿主测试库\"\n  echo \"CitizenSDK macOS 宿主测试库完成：$destination\"\n}\n\nwindows_install_files() {\n  printf '%s\\n' \\\n    include/citizensdk.h include/citizensdk_types.h include/citizensdk_qr_image.h \\\n    include/citizen_sdk/citizen_sdk.hpp \\\n    include/citizen_sdk/citizen_sdk_config.hpp \\\n    include/citizen_sdk/citizen_sdk_error.hpp \\\n    include/citizen_sdk/citizen_sdk_events.hpp \\\n    include/citizen_sdk/citizen_sdk_models.hpp \\\n    include/citizen_sdk/citizensdk_host.h \\\n    bin/Windows/citizensdk.dll bin/Windows/citizensdk_host.dll \\\n    lib/Windows/citizensdk.dll.lib lib/Windows/citizensdk_host.lib \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKConfig.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKDependencies.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKTargets.cmake \\\n    lib/Windows/cmake/CitizenSDK/CitizenSDKTargets-release.cmake \\\n    share/citizensdk/chain/manifest.json \\\n    share/citizensdk/chain/chainspec.json \\\n    share/citizensdk/chain/light_sync_state.json | LC_ALL=C sort\n}\n\nverify_windows_install() {\n  local prefix=\"$1\" software_version=\"$2\" core_dir=\"$3\" cmake_build=\"$4\" expected\n  assert_safe_directory_path \"$prefix\" \"Windows 安装前缀\"\n  [[ -d \"$prefix\" && ! -L \"$prefix\" ]] || fail \"Windows 安装前缀不是普通目录\"\n  expected=\"$(windows_install_files)\"\n  # 安装清单不是信任来源：实际文件/目录反向闭集、当前源码和本轮构建原件\n  # 三者必须同时相符。验证不执行安装中的 CMake，随后独立消费者检查完整导入目标。\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"), p=require(\"path\");\n    const [prefix,version,core,build,sdk,windows,assets,listing]=process.argv.slice(1);\n    const expected=listing.split(\"\\n\");\n    if(expected.length!==21 || new Set(expected).size!==21) throw Error(\"Windows install set must contain 21 files\");\n    const identity=x=>process.platform===\"win32\"?p.resolve(x).toLowerCase():p.resolve(x);\n    function ordinary(path,directory) {\n      const root=p.parse(path).root;\n      if(!root || path.includes(\"\\0\")) throw Error(\"invalid installation source path\");\n      let current=root;\n      for(const part of p.relative(root,path).split(p.sep)) {\n        if(!part || part===\".\" || part===\"..\") throw Error(\"unsafe installation source component\");\n        current=p.join(current,part);\n        const st=fs.lstatSync(current);\n        if(st.isSymbolicLink() || identity(fs.realpathSync(current))!==identity(current)) throw Error(\"installation reparse or alias\");\n        if(identity(current)!==identity(path) && !st.isDirectory()) throw Error(\"installation ancestor is not a directory\");\n      }\n      const st=fs.lstatSync(path);\n      if(directory?!st.isDirectory():(!st.isFile() || st.size===0 || st.nlink!==1)) throw Error(\"invalid installation node\");\n    }\n    ordinary(prefix,true);\n    const actual=[], directories=[];\n    function walk(directory,relative=\"\") {\n      for(const name of fs.readdirSync(directory)) {\n        const path=p.join(directory,name), key=relative?relative+\"/\"+name:name;\n        const st=fs.lstatSync(path);\n        if(st.isSymbolicLink() || identity(fs.realpathSync(path))!==identity(path)) throw Error(\"installation reparse or alias\");\n        if(st.isDirectory()) { directories.push(key); walk(path,key); }\n        else if(st.isFile() && st.nlink===1 && st.size>0) actual.push(key);\n        else throw Error(\"installation contains a special, empty or linked file\");\n      }\n    }\n    walk(prefix);\n    const expectedDirectories=new Set();\n    for(const file of expected) {\n      const parts=file.split(\"/\");\n      while(parts.length>1) { parts.pop(); expectedDirectories.add(parts.join(\"/\")); }\n    }\n    const equal=(a,b)=>JSON.stringify(a.slice().sort())===JSON.stringify(b.slice().sort());\n    if(!equal(actual,expected) || !equal(directories,[...expectedDirectories])) throw Error(\"Windows installed file/directory closure drift\");\n    const manifestPath=p.join(build,\"install_manifest.txt\"); ordinary(manifestPath,false);\n    const manifest=fs.readFileSync(manifestPath,\"utf8\").replace(/\\r?\\n$/,\"\").split(/\\r?\\n/);\n    if(manifest.some(x=>!p.isAbsolute(x) || /(^|[\\\\/])\\.{1,2}([\\\\/]|$)/.test(x))) throw Error(\"invalid install_manifest path\");\n    const installed=expected.map(x=>identity(p.join(prefix,...x.split(\"/\"))));\n    if(!equal(manifest.map(identity),installed)) throw Error(\"install_manifest does not match complete Windows installation\");\n    function same(source,relative) {\n      const destination=p.join(prefix,...relative.split(\"/\"));\n      ordinary(source,false); ordinary(destination,false);\n      if(!fs.readFileSync(source).equals(fs.readFileSync(destination))) throw Error(\"Windows installed bytes differ: \"+relative);\n    }\n    for(const name of [\"citizensdk.h\",\"citizensdk_types.h\"]) same(p.join(sdk,\"include\",name),\"include/\"+name);\n    same(p.join(sdk,\"native\",\"image\",\"citizensdk_qr_image.h\"),\"include/citizensdk_qr_image.h\");\n    for(const name of [\"citizen_sdk.hpp\",\"citizen_sdk_config.hpp\",\"citizen_sdk_error.hpp\",\"citizen_sdk_events.hpp\",\"citizen_sdk_models.hpp\",\"citizensdk_host.h\"])\n      same([\"citizen_sdk_error.hpp\",\"citizen_sdk_events.hpp\",\"citizen_sdk_models.hpp\"].includes(name)?p.join(sdk,\"include\",name):p.join(windows,\"headers\",name),\"include/citizen_sdk/\"+name);\n    for(const name of [\"manifest.json\",\"chainspec.json\",\"light_sync_state.json\"])\n      same(p.join(assets,name),\"share/citizensdk/chain/\"+name);\n    same(p.join(core,\"citizensdk.dll\"),\"bin/Windows/citizensdk.dll\");\n    same(p.join(core,\"citizensdk.dll.lib\"),\"lib/Windows/citizensdk.dll.lib\");\n    same(p.join(build,\"Release\",\"citizensdk_host.dll\"),\"bin/Windows/citizensdk_host.dll\");\n    same(p.join(build,\"Release\",\"citizensdk_host.lib\"),\"lib/Windows/citizensdk_host.lib\");\n    const packageDir=\"lib/Windows/cmake/CitizenSDK/\";\n    for(const name of [\"CitizenSDKConfig.cmake\",\"CitizenSDKConfigVersion.cmake\"]) same(p.join(build,name),packageDir+name);\n    same(p.join(windows,\"cmake\",\"CitizenSDKDependencies.cmake\"),packageDir+\"CitizenSDKDependencies.cmake\");\n    const exportRoot=p.join(build,\"CMakeFiles\",\"Export\"), exports=[];\n    ordinary(exportRoot,true);\n    function collect(directory) {\n      for(const name of fs.readdirSync(directory)) {\n        const file=p.join(directory,name), st=fs.lstatSync(file);\n        if(st.isSymbolicLink()) throw Error(\"generated CMake export is linked\");\n        if(st.isDirectory()) collect(file);\n        else if(name===\"CitizenSDKTargets.cmake\" || name===\"CitizenSDKTargets-release.cmake\") exports.push(file);\n      }\n    }\n    collect(exportRoot);\n    for(const name of [\"CitizenSDKTargets.cmake\",\"CitizenSDKTargets-release.cmake\"]) {\n      const matches=exports.filter(x=>p.basename(x)===name);\n      if(matches.length!==1) throw Error(\"generated CMake export is missing or ambiguous\");\n      same(matches[0],packageDir+name);\n    }\n    if(!/^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(version)) throw Error(\"invalid SDK version\");\n    const pubspec=fs.readFileSync(p.join(sdk,\"pubspec.yaml\"),\"utf8\");\n    const versions=[...pubspec.matchAll(/^version: ([0-9]+\\.[0-9]+\\.[0-9]+)$/gm)].map(x=>x[1]);\n    const project=[...fs.readFileSync(p.join(windows,\"CMakeLists.txt\"),\"utf8\").matchAll(/^project\\(CitizenSDKHost VERSION ([0-9]+\\.[0-9]+\\.[0-9]+) LANGUAGES C CXX\\)$/gm)].map(x=>x[1]);\n    if(JSON.stringify(versions)!==JSON.stringify([version]) || JSON.stringify(project)!==JSON.stringify([version])) throw Error(\"SDK source version drift\");\n    const versionTemplate=fs.readFileSync(p.join(windows,\"cmake\",\"CitizenSDKConfigVersion.cmake.in\"),\"utf8\")\n      .replaceAll(\"@PROJECT_VERSION@\",version).replaceAll(\"@PROJECT_VERSION_MAJOR@\",version.split(\".\")[0]);\n    const installedVersion=fs.readFileSync(p.join(prefix,...(packageDir+\"CitizenSDKConfigVersion.cmake\").split(\"/\")),\"utf8\");\n    if(installedVersion!==versionTemplate) throw Error(\"installed CMake version template drift\");\n    for(const name of [\"CitizenSDKConfig.cmake\",\"CitizenSDKConfigVersion.cmake\",\"CitizenSDKDependencies.cmake\",\"CitizenSDKTargets.cmake\",\"CitizenSDKTargets-release.cmake\"]) {\n      const content=fs.readFileSync(p.join(prefix,...(packageDir+name).split(\"/\")),\"utf8\");\n      if([sdk,build,prefix,core].some(x=>content.includes(x) || content.includes(x.replaceAll(\"\\\\\",\"/\")))) throw Error(\"installed CMake leaks an absolute build path\");\n    }\n  ' \"$(cygpath -m \"$prefix\")\" \"$software_version\" \"$(cygpath -m \"$core_dir\")\" \\\n    \"$(cygpath -m \"$cmake_build\")\" \"$(cygpath -m \"$sdk_dir\")\" \\\n    \"$(cygpath -m \"$windows_source_root\")\" \"$(cygpath -m \"$apple_asset_root\")\" \"$expected\" \\\n    || fail \"Windows 安装闭集、清单、版本或来源字节验证失败\"\n  verify_windows_exports \"$prefix/bin/Windows/citizensdk.dll\" \"$product_header\" Core\n  verify_windows_exports \"$prefix/bin/Windows/citizensdk_host.dll\" \\\n    \"$windows_source_root/headers/citizensdk_host.h\" Host\n}\n\nverify_windows_consumer_inventory() {\n  local build=\"$1\" prefix=\"$2\" state=\"$3\" configuration=\"${4:-Release}\" inventory\n  inventory=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n    -C Release --show-only=json-v1)\" || fail \"Windows 消费者 CTest 清单读取失败\"\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"), p=require(\"path\");\n    const [text,build,prefix,state,configuration]=process.argv.slice(1), data=JSON.parse(text);\n    const expected=[\n      [\"CitizenSDK.Windows.CConsumer\",\"citizen_sdk_c_consumer.exe\"],\n      [\"CitizenSDK.Windows.CppConsumer\",\"citizen_sdk_cpp_consumer.exe\"]\n    ];\n    if(!Array.isArray(data.tests) || data.tests.length!==2) throw Error(\"Windows consumer test count drift\");\n    const names=data.tests.map(x=>x.name).sort();\n    if(JSON.stringify(names)!==JSON.stringify(expected.map(x=>x[0]))) throw Error(\"Windows consumer exact test set drift\");\n    const identity=x=>process.platform===\"win32\"?p.resolve(x).toLowerCase():p.resolve(x);\n    const runtime=p.join(build,configuration), assets=p.join(prefix,\"share\",\"citizensdk\",\"chain\");\n    function ordinaryFile(path) {\n      let current=p.parse(path).root;\n      for(const part of p.relative(current,path).split(p.sep)) {\n        current=p.join(current,part);\n        const st=fs.lstatSync(current);\n        if(st.isSymbolicLink() || identity(fs.realpathSync(current))!==identity(current)) throw Error(\"Windows consumer reparse or alias\");\n        if(identity(current)!==identity(path) && !st.isDirectory()) throw Error(\"Windows consumer ancestor is not a directory\");\n      }\n      const st=fs.lstatSync(path);\n      if(!st.isFile() || st.size===0 || st.nlink!==1) throw Error(\"Windows consumer file is unavailable\");\n    }\n    for(const [name,executable] of expected) {\n      const test=data.tests.find(x=>x.name===name), args=[p.join(runtime,executable),state,assets,runtime];\n      if(!Array.isArray(test.command) || test.command.length!==4 || test.command.some((x,i)=>typeof x!==\"string\" || identity(x)!==identity(args[i]))) throw Error(\"Windows consumer command drift\");\n      const props=test.properties||[];\n      if(new Set(props.map(x=>x.name)).size!==props.length) throw Error(\"duplicate CTest property\");\n      const property=name=>props.find(x=>x.name===name)?.value;\n      if(property(\"TIMEOUT\")!==180 || property(\"RUN_SERIAL\")!==true) throw Error(\"Windows consumer timeout or serialization drift\");\n      // PASS_REGULAR_EXPRESSION 会忽略非零退出码；不允许任何跳过/反转成功的属性。\n      if(props.some(x=>/^(PASS_REGULAR_EXPRESSION|SKIP_REGULAR_EXPRESSION|SKIP_RETURN_CODE|WILL_FAIL|DISABLED)$/.test(x.name))) throw Error(\"Windows consumer exit contract override\");\n      ordinaryFile(args[0]);\n    }\n    for(const name of [\"citizensdk.dll\",\"citizensdk_host.dll\"]) {\n      const actual=p.join(runtime,name), expected=p.join(prefix,\"bin\",\"Windows\",name);\n      ordinaryFile(actual); ordinaryFile(expected);\n      if(!fs.readFileSync(actual).equals(fs.readFileSync(expected))) throw Error(\"Windows consumer DLL bytes drift\");\n    }\n  ' \"$inventory\" \"$(cygpath -m \"$build\")\" \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$state\")\" \"$configuration\" \\\n    || fail \"Windows 消费者必须是准确两个真实程序及同版运行库\"\n}\n\nrun_windows_consumers() {\n  local build=\"$1\" prefix=\"$2\" state=\"$3\" configuration=\"${4:-Release}\" output\n  verify_windows_consumer_inventory \"$build\" \"$prefix\" \"$state\" \"$configuration\"\n  # 同时检查 CTest 真实退出码和两个程序各自唯一成功行，不能用标记掩盖失败。\n  output=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n    -C Release --no-tests=error --verbose 2>&1)\" || {\n      printf '%s\\n' \"$output\" >&2\n      fail \"Windows 已安装消费者运行失败\"\n    }\n  printf '%s\\n' \"$output\"\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const lines=process.argv[1].split(/\\r?\\n/);\n    for(const marker of [\"CitizenSDK C consumer passed\",\"CitizenSDK C++ consumer passed\"]) {\n      if(lines.filter(x=>/^\\d+: /.test(x) && x.replace(/^\\d+: /,\"\")===marker).length!==1) throw Error(\"Windows consumer success marker missing or repeated\");\n    }\n  ' \"$output\" || fail \"Windows 已安装消费者成功标记不完整\"\n}\n\nexport_windows_install() {\n  local prefix=\"$1\" destination=\"$2\"\n  assert_descendant_path \"$work_dir\" \"$prefix\" \"Windows 已验证安装来源\"\n  assert_descendant_path \"$output_dir\" \"$destination\" \"Windows 安装导出\"\n  assert_safe_directory_path \"$prefix\" \"Windows 已验证安装来源\"\n  assert_safe_directory_path \"$(dirname \"$destination\")\" \"Windows 安装导出父目录\"\n  [[ -d \"$prefix\" && ! -L \"$prefix\" ]] || fail \"Windows 已验证安装来源不是普通目录\"\n  [[ ! -e \"$destination\" && ! -L \"$destination\" ]] || fail \"Windows 安装导出目标已存在，保留已有产物\"\n  # 所有安装/消费者检查成功后才同卷重命名；跨卷失败，不退回复制半份目录，\n  # 不删除旧产物、不清理永久容器，也不覆盖已存在或被替换为 reparse point 的目标。\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"), p=require(\"path\");\n    const [source,target]=process.argv.slice(1);\n    const identity=x=>process.platform===\"win32\"?p.resolve(x).toLowerCase():p.resolve(x);\n    for(const directory of [source,p.dirname(target)]) {\n      const st=fs.lstatSync(directory);\n      if(!st.isDirectory() || st.isSymbolicLink() || identity(fs.realpathSync(directory))!==identity(directory)) throw Error(\"Windows export directory identity drift\");\n    }\n    try { fs.lstatSync(target); throw Error(\"Windows export already exists\"); }\n    catch(error) { if(error.code!==\"ENOENT\") throw error; }\n    fs.renameSync(source,target);\n  ' \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$destination\")\" \\\n    || fail \"Windows 已验证安装同卷导出失败，禁止覆盖或跨卷复制\"\n}\n\nverify_windows_flutter_cache() {\n  local root=\"$1\" cache=\"$2\"\n  assert_readonly_dependency_directory \"$root\" \"Windows Flutter SDK\"\n  assert_readonly_dependency_directory \"$cache\" \"Windows Pub cache\"\n  # 官方 WindowsEngineArtifacts 同时登记 debug/profile/release；缺项只能失败，\n  # 不能让后续 build 自动取得运行件。ICU 属于无 mode 的通用目录。\n  MSYS2_ARG_CONV_EXCL='*' node - \"$(cygpath -m \"$root\")\" \"$(cygpath -m \"$cache\")\" <<'NODE'\nconst fs = require('fs'), path = require('path');\nconst [root, cache] = process.argv.slice(2);\nfunction ordinaryTree(directory) {\n  const st = fs.lstatSync(directory);\n  if (!st.isDirectory() || st.isSymbolicLink()\n      || path.resolve(fs.realpathSync(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw Error('Windows tool directory is redirected');\n  for (const item of fs.readdirSync(directory, {withFileTypes:true})) {\n    const value = path.join(directory, item.name), state = fs.lstatSync(value);\n    if (state.isSymbolicLink() || (!state.isFile() && !state.isDirectory())) throw Error('Windows tool tree contains a link or special node');\n    if (state.isDirectory()) ordinaryTree(value);\n  }\n}\nordinaryTree(root);\nfor (const name of ['hosted', 'hosted-hashes']) ordinaryTree(path.join(cache, name));\nfunction file(name, read = false) {\n  const value = path.join(root, name), st = fs.lstatSync(value);\n  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) throw Error('Windows Flutter cache is incomplete: ' + name);\n  return read ? fs.readFileSync(value, 'utf8').trim() : undefined;\n}\nif (!fs.lstatSync(path.join(root, '.git')).isDirectory()\n    || fs.existsSync(path.join(root, '.git/commondir'))) throw Error('Windows Flutter SDK must be a complete ordinary installation');\nconst version = JSON.parse(file('bin/cache/flutter.version.json', true));\nconst revision = file('bin/cache/engine.stamp', true);\nif (!/^[0-9a-f]{40}$/.test(revision) || version.engineRevision !== revision\n    || !/^[0-9a-f]{40}$/.test(version.frameworkRevision)\n    || file('bin/internal/engine.version', true) !== revision\n    || file('bin/cache/flutter_tools.stamp', true) !== version.frameworkRevision + ':') throw Error('Windows Flutter cache identity mismatch');\nfor (const name of ['flutter_sdk', 'windows-sdk', 'font-subset']) {\n  if (file('bin/cache/' + name + '.stamp', true) !== revision) throw Error('Windows Flutter artifact revision mismatch');\n}\nfor (const name of ['material_fonts', 'gradle_wrapper']) {\n  if (file('bin/cache/' + name + '.stamp', true) !== file('bin/internal/' + name + '.version', true)\n      || !fs.lstatSync(path.join(root, 'bin/cache/artifacts', name)).isDirectory()) throw Error('Windows universal Flutter cache is incomplete');\n}\nfor (const name of [\n  'bin/cache/flutter_tools.snapshot', 'bin/cache/dart-sdk/bin/dart.exe',\n  'packages/flutter_tools/.dart_tool/package_config.json',\n  'bin/cache/pkg/sky_engine/pubspec.yaml', 'bin/cache/pkg/flutter_gpu/pubspec.yaml',\n  'bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill',\n  'bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill',\n  'bin/cache/artifacts/engine/windows-x64/icudtl.dat',\n  'bin/cache/artifacts/engine/windows-x64/font-subset.exe',\n  'bin/cache/artifacts/engine/windows-x64-release/gen_snapshot.exe',\n  'bin/cache/artifacts/engine/windows-x64/cpp_client_wrapper/include/flutter/plugin_registrar_windows.h',\n]) file(name);\nfor (const mode of ['', '-profile', '-release']) {\n  for (const name of ['flutter_windows.dll', 'flutter_windows.dll.exp', 'flutter_windows.dll.lib',\n    'flutter_windows.dll.pdb', 'flutter_export.h', 'flutter_messenger.h',\n    'flutter_plugin_registrar.h', 'flutter_texture_registrar.h', 'flutter_windows.h']) {\n    file('bin/cache/artifacts/engine/windows-x64' + mode + '/' + name);\n  }\n}\nNODE\n}\n\nverify_windows_flutter_inventory() {\n  local build=\"$1\" state=\"$2\" prefix=\"$3\" inventory\n  inventory=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n    -C Release --show-only=json-v1)\" || fail \"Windows Flutter CTest 清单读取失败\"\n  MSYS2_ARG_CONV_EXCL='*' node - \"$inventory\" \"$(cygpath -m \"$build\")\" \\\n    \"$(cygpath -m \"$state\")\" \"$(cygpath -m \"$prefix\")\" <<'NODE'\nconst fs=require('fs'), path=require('path');\nconst [raw, build, state, prefix]=process.argv.slice(2);\nconst tests=JSON.parse(raw).tests;\nconst names=['codec','environment','sessions','wallet_flow','plugin','secret_boundary']\n  .map(x=>'CitizenSDK.Windows.citizen_sdk_flutter_'+x+'_test').sort();\nif(!Array.isArray(tests) || JSON.stringify(tests.map(x=>x.name).sort())!==JSON.stringify(names)) throw Error('Windows Flutter CTest exact set drift');\nconst normalize=x=>path.resolve(x).toLowerCase();\nfunction ordinaryFile(file) {\n  let current=path.parse(path.resolve(file)).root;\n  for(const part of path.relative(current,path.resolve(file)).split(path.sep)) {\n    current=path.join(current,part); const st=fs.lstatSync(current);\n    if(st.isSymbolicLink() || normalize(fs.realpathSync(current))!==normalize(current)) throw Error('Windows Flutter CTest path is redirected');\n    if(normalize(current)===normalize(file)) {\n      if(!st.isFile() || !st.size || st.nlink!==1) throw Error('Windows Flutter CTest input is not an ordinary single-link file');\n    } else if(!st.isDirectory()) throw Error('Windows Flutter CTest ancestor is not a directory');\n  }\n}\nfor(const test of tests) {\n  const name=test.name.slice('CitizenSDK.Windows.'.length);\n  const expected=path.join(build,'plugins/citizen_sdk/test/Release',name+'.exe');\n  if(!Array.isArray(test.command) || test.command.length!==1 || normalize(test.command[0])!==normalize(expected)) throw Error('Windows Flutter CTest command drift');\n  const props=new Map();\n  for(const property of test.properties || []) {\n    if(props.has(property.name)) throw Error('Windows Flutter CTest duplicate property');\n    props.set(property.name,property.value);\n  }\n  if(props.get('TIMEOUT')!==60 || JSON.stringify(props.get('ENVIRONMENT'))!==JSON.stringify(['CITIZENSDK_TEST_WORK_DIR='+state])) throw Error('Windows Flutter CTest state/timeout drift');\n  if(!Array.isArray(props.get('LABELS')) || JSON.stringify([...props.get('LABELS')].sort())!==JSON.stringify(['CitizenSDK','Contract','WindowsFlutter'])) throw Error('Windows Flutter CTest labels drift');\n  for(const property of ['PASS_REGULAR_EXPRESSION','SKIP_REGULAR_EXPRESSION','SKIP_RETURN_CODE','WILL_FAIL','DISABLED']) {\n    if(props.has(property)) throw Error('Windows Flutter CTest cannot mask failure');\n  }\n  ordinaryFile(expected);\n  for(const name of ['citizensdk.dll','citizensdk_host.dll']) {\n    const actual=path.join(path.dirname(expected),name);\n    const source=path.join(prefix,'bin/Windows',name);\n    ordinaryFile(actual); ordinaryFile(source);\n    if(!fs.readFileSync(actual).equals(fs.readFileSync(source))) throw Error('Windows Flutter CTest runtime differs from its installation');\n  }\n}\nNODE\n}\n\nrun_windows_flutter_consumer() {\n  local bundle=\"$1\"\n  # .NET 用真实管道启动 GUI Release，并等待退出和输出排空，不使用\n  # Start-Process 的“已启动”状态。官方 AttachConsole 保留 STARTF_USESTDHANDLES\n  # 提供的重定向句柄；不改 runner main 或手动注册插件。\n  CITIZENSDK_FLUTTER_BUNDLE=\"$(cygpath -m \"$bundle\")\" \\\n    MSYS2_ARG_CONV_EXCL='*' pwsh -NoLogo -NoProfile -NonInteractive -Command - <<'POWERSHELL'\n$ErrorActionPreference = 'Stop'\ntry {\n  if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows -or\n      $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {\n    throw 'Windows Flutter execution requires the authorized isolated runner'\n  }\n  Add-Type -TypeDefinition @'\nusing System;\nusing System.Collections.Generic;\nusing System.Diagnostics;\nusing System.IO;\nusing System.Linq;\nusing System.Runtime.InteropServices;\nusing System.Security.AccessControl;\nusing System.Security.Principal;\nusing System.Text;\nusing System.Threading;\nusing Microsoft.Win32.SafeHandles;\n\npublic static class CitizenSdkFlutterConsumer {\n  [DllImport(\"shell32.dll\")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern uint GetFileAttributesW(string path);\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);\n  [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]\n  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);\n  [DllImport(\"advapi32.dll\", SetLastError=true)]\n  static extern uint GetSecurityInfo(SafeFileHandle handle, uint kind, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);\n  [DllImport(\"advapi32.dll\")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);\n  [DllImport(\"kernel32.dll\")] static extern IntPtr LocalFree(IntPtr value);\n  [DllImport(\"kernel32.dll\", SetLastError=true)]\n  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition value, uint size);\n  [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte Delete; }\n  [StructLayout(LayoutKind.Sequential)] struct Information {\n    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;\n    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;\n  }\n  static readonly SecurityIdentifier User = CurrentUser();\n  static SecurityIdentifier CurrentUser() {\n    using (var identity = WindowsIdentity.GetCurrent()) { return identity.User; }\n  }\n  const string Application = \"org.citizensdk.flutterconsumer\";\n  const string Marker = \"CitizenSDK Flutter consumer passed\";\n  static void Require(bool value) { if (!value) throw new InvalidOperationException(\"Windows Flutter consumer boundary failed\"); }\n  static string Full(string value) {\n    var path = Path.GetFullPath(value);\n    Require(path.Length > 3 && path[1] == ':' && !path.StartsWith(@\"\\\\\") && path.IndexOf('\\0') < 0);\n    return path.TrimEnd('\\\\');\n  }\n  static bool Missing(string path) {\n    if (GetFileAttributesW(path) != UInt32.MaxValue) return false;\n    var error = Marshal.GetLastWin32Error();\n    Require(error == 2 || error == 3);\n    return true;\n  }\n  static void Private(SafeFileHandle handle) {\n    IntPtr owner, group, dacl, sacl, descriptor;\n    Require(GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) == 0);\n    try {\n      var size = GetSecurityDescriptorLength(descriptor);\n      Require(size > 0 && size <= 65536);\n      var bytes = new byte[(int)size]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);\n      var security = new RawSecurityDescriptor(bytes, 0);\n      Require(User != null && User.Equals(security.Owner)\n        && (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0\n        && security.DiscretionaryAcl != null && security.DiscretionaryAcl.Count == 1);\n      var ace = security.DiscretionaryAcl[0] as CommonAce;\n      Require(ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && ace.AceFlags == AceFlags.None\n        && ace.AccessMask == 0x1f01ff && User.Equals(ace.SecurityIdentifier));\n    } finally { LocalFree(descriptor); }\n  }\n  static SafeFileHandle Open(string path, bool directory, bool remove, bool secure) {\n    // 不分享删除；每一层都保持句柄直到下层检查/清理结束，避免检查后换父目录。\n    var handle = CreateFileW(path, 0x20080u | (directory ? 1u : 0u) | (remove ? 0x10000u : 0u),\n      3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);\n    try {\n      Require(!handle.IsInvalid);\n      Information info; Require(GetFileInformationByHandle(handle, out info));\n      Require((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory\n        && (directory || info.Links == 1));\n      var name = new StringBuilder(32768);\n      var count = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);\n      Require(count > 0 && count < name.Capacity);\n      var final = name.ToString();\n      Require(final.StartsWith(@\"\\\\?\\\") && String.Equals(final.Substring(4).TrimEnd('\\\\'),\n        Path.GetFullPath(path).TrimEnd('\\\\'), StringComparison.OrdinalIgnoreCase));\n      if (secure) Private(handle);\n      return handle;\n    } catch { handle.Dispose(); throw; }\n  }\n  static string Identity(SafeFileHandle handle) {\n    Information value; Require(GetFileInformationByHandle(handle, out value));\n    return value.Volume.ToString(\"x8\") + value.IndexHigh.ToString(\"x8\") + value.IndexLow.ToString(\"x8\");\n  }\n  sealed class Node : IDisposable {\n    public SafeFileHandle Handle;\n    public List<Node> Children = new List<Node>();\n    public void Dispose() { foreach (var child in Children) child.Dispose(); if (Handle != null) Handle.Dispose(); }\n    public void Delete() {\n      foreach (var child in Children) child.Delete();\n      var value = new Disposition { Delete = 1 };\n      Require(SetFileInformationByHandle(Handle, 4, ref value, 1));\n      Handle.Dispose();\n    }\n  }\n  static Node Collect(string path, int depth, ref int count) {\n    Require(depth <= 16 && ++count <= 4096);\n    var attributes = GetFileAttributesW(path); Require(attributes != UInt32.MaxValue);\n    var directory = (attributes & 0x10) != 0;\n    var node = new Node { Handle = Open(path, directory, true, true) };\n    try {\n      if (directory) foreach (var child in Directory.EnumerateFileSystemEntries(path)) node.Children.Add(Collect(child, depth + 1, ref count));\n      return node;\n    } catch { node.Dispose(); throw; }\n  }\n  public static void Run(string suppliedBundle) {\n    var bundle = Full(suppliedBundle);\n    var folder = new Guid(\"F1B32785-6FBA-4FCF-9D55-7B8E7F157091\"); IntPtr pointer;\n    Require(SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out pointer) == 0);\n    string data; try { data = Full(Marshal.PtrToStringUni(pointer)); } finally { Marshal.FreeCoTaskMem(pointer); }\n    var target = Path.Combine(data, Application);\n    var ancestors = new List<SafeFileHandle>(); SafeFileHandle observed = null;\n    string identity = null; bool started = false, ended = false, succeeded = false;\n    var process = new Process();\n    try {\n      var current = Path.GetPathRoot(data);\n      ancestors.Add(Open(current, true, false, false));\n      foreach (var part in data.Substring(current.Length).Split('\\\\')) {\n        Require(part.Length != 0 && part != \".\" && part != \"..\");\n        current = Path.Combine(current, part); ancestors.Add(Open(current, true, false, false));\n      }\n      Require(Missing(target));  // 不认领、更改或删除任何原有用户状态。\n      process.StartInfo = new ProcessStartInfo(Path.Combine(bundle, \"citizensdk_consumer.exe\")) {\n        WorkingDirectory = bundle, UseShellExecute = false,\n        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,\n        CreateNoWindow = true\n      };\n      Require(process.Start()); started = true; process.StandardInput.Close();\n      var stdout = process.StandardOutput.ReadToEndAsync();\n      var stderr = process.StandardError.ReadToEndAsync();\n      var loaded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);\n      var libraries = new HashSet<string>(new [] { \"citizensdk.dll\", \"citizensdk_host.dll\", \"citizen_sdk_plugin.dll\", \"flutter_windows.dll\" }, StringComparer.OrdinalIgnoreCase);\n      var clock = Stopwatch.StartNew();\n      while (!process.WaitForExit(5)) {\n        Require(clock.ElapsedMilliseconds < 180000);\n        if (observed == null && !Missing(target)) { observed = Open(target, true, false, true); identity = Identity(observed); }\n        ProcessModuleCollection modules = null;\n        try { process.Refresh(); modules = process.Modules; }\n        catch (System.ComponentModel.Win32Exception error) {\n          // 仅允许启动/退出间的暂态枚举失败；未实际看到全部 DLL 始终不能通过。\n          Require(error.NativeErrorCode == 299 || process.HasExited);\n        } catch (InvalidOperationException) { if (!process.HasExited) throw; }\n        if (modules != null) foreach (ProcessModule module in modules) if (libraries.Contains(module.ModuleName)) {\n          Require(String.Equals(Full(module.FileName), Path.Combine(bundle, module.ModuleName), StringComparison.OrdinalIgnoreCase));\n          loaded.Add(module.ModuleName);\n        }\n      }\n      ended = true;\n      Require(stdout.Wait(5000) && stderr.Wait(5000));\n      Require(process.ExitCode == 0 && loaded.SetEquals(libraries));\n      Require(stdout.Result.Split(new [] { \"\\r\\n\", \"\\n\" }, StringSplitOptions.None).Count(line => line == Marker) == 1);\n      if (observed == null) { observed = Open(target, true, false, true); identity = Identity(observed); }\n      succeeded = true;\n    } finally {\n      try {\n        try {\n          if (started && !ended) {\n            if (!process.HasExited) process.Kill(true);\n            ended = process.WaitForExit(10000);\n          }\n        } finally {\n          // 终止/等待自身也可能失败；仍释放观察句柄，但不清理未确认退出的进程状态。\n          process.Dispose();\n          if (observed != null) observed.Dispose();\n        }\n        // 必须先确认进程退出、观察到本次私有目录身份，再整树验所有权后删除。\n        // 任意身份/ACL/reparse 不明时保留，不能把安全失败改成强制 Remove-Item。\n        if (started && ended && identity != null) {\n          int count = 0;\n          using (var owned = Collect(target, 0, ref count)) { Require(Identity(owned.Handle) == identity); owned.Delete(); }\n          Require(Missing(target));\n        } else if (started && !Missing(target)) { succeeded = false; throw new InvalidOperationException(\"Windows Flutter test state ownership is unproven; retained\"); }\n      } finally { foreach (var handle in ancestors) handle.Dispose(); }\n    }\n    Require(succeeded);\n    Console.WriteLine(Marker);\n  }\n}\n'@\n  [CitizenSdkFlutterConsumer]::Run($env:CITIZENSDK_FLUTTER_BUNDLE)\n  exit 0\n} catch {\n  [Console]::Error.WriteLine('Windows Flutter consumer failed; unproven state is retained')\n  exit 1\n}\nPOWERSHELL\n}\n\nbuild_windows_flutter_consumer() (\n  local build_root=\"$1\" prefix=\"$2\" software_version=\"$3\"\n  local package=\"${4:-}\" candidate=\"${5:-$sdk_dir}\"\n  local flutter_source=\"${CITIZENSDK_FLUTTER_ROOT:-}\" cache_source=\"${PUB_CACHE:-}\"\n  local root=\"$build_root/flutter\" tool_root cache_root sdk_stage runner dart_bin build bundle test_state\n  [[ \"${GITHUB_ACTIONS:-}\" == true && \"${RUNNER_ENVIRONMENT:-}\" == github-hosted ]] \\\n    || fail \"Windows Flutter 真实消费只允许已授权的一次性 GitHub Windows 用户环境\"\n  command -v pwsh >/dev/null 2>&1 || fail \"Windows Flutter 消费缺少预装 PowerShell 7\"\n  MSYS2_ARG_CONV_EXCL='*' node -e '\n    const fs=require(\"fs\"),path=require(\"path\");\n    if(!process.env.APPDATA || !path.isAbsolute(process.env.APPDATA)) throw Error(\"Windows Flutter tool profile is unavailable\");\n    try { fs.lstatSync(path.join(process.env.APPDATA,\".flutter_settings\")); throw Error(\"Windows Flutter settings must not redirect this build\"); }\n    catch(error) { if(error.code!==\"ENOENT\") throw error; }\n  ' || fail \"Windows Flutter 一次性用户环境带有不允许的工具配置\"\n  verify_windows_flutter_cache \"$flutter_source\" \"$cache_source\"\n  tool_root=\"$root/tools\"; cache_root=\"$root/pub-cache\"; sdk_stage=\"$root/citizen_sdk\"\n  runner=\"$root/consumer\"; test_state=\"$root/test-state\"\n  for directory in \"$flutter_source\" \"$cache_source\" \"$sdk_dir\"; do\n    case \"$root/\" in \"$directory/\"*) fail \"Windows Flutter 输入不能包含本轮副本目标\" ;; esac\n    case \"$directory/\" in \"$root/\"*) fail \"Windows Flutter 输入不能来自本轮副本目标\" ;; esac\n  done\n  for directory in \"$root\" \"$tool_root\" \"$cache_root\" \"$sdk_stage\" \"$root/tmp\"; do\n    [[ ! -e \"$directory\" && ! -L \"$directory\" ]] || fail \"Windows Flutter 工作目录已存在，拒绝混用\"\n    prepare_safe_directory \"$work_dir\" \"$directory\" \"Windows Flutter 独占目录\"\n  done\n  # 副本只含显式预装工具及 hosted 依赖；不复制 Pub 凭据、Git hooks/config。\n  # Flutter 官方 backend 仍执行其副本 assemble 链路；不改官方 registrant。\n  MSYS2_ARG_CONV_EXCL='*' node - \"$(cygpath -m \"$flutter_source\")\" \"$(cygpath -m \"$cache_source\")\" \\\n    \"$(cygpath -m \"$tool_root\")\" \"$(cygpath -m \"$cache_root\")\" \\\n    \"$(cygpath -m \"${package:-$sdk_dir}\")\" \"$(cygpath -m \"$sdk_stage\")\" <<'NODE'\nconst fs=require('fs'), path=require('path'), url=require('url');\nconst [source,cache,tool,copyCache,sdk,stage]=process.argv.slice(2);\nfor(const [from,to] of [[source,tool],[sdk,stage]]) {\n  fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false,filter:value=>{\n    const relative=path.relative(from,value).replaceAll('\\\\','/');\n    return !['.git/config','.git/hooks','.git/logs'].some(x=>relative===x || relative.startsWith(x+'/'));\n  }});\n}\nfor(const name of ['hosted','hosted-hashes']) fs.cpSync(path.join(cache,name),path.join(copyCache,name),{recursive:true,errorOnExist:true,force:false});\nconst original=path.join(source,'packages/flutter_tools/.dart_tool/package_config.json');\nconst config=JSON.parse(fs.readFileSync(original,'utf8'));\nfor(const item of config.packages) {\n  const root=url.fileURLToPath(new URL(item.rootUri,url.pathToFileURL(original)));\n  const maps=[[source,tool],[cache,copyCache]];\n  const mapping=maps.find(([from])=>root.toLowerCase().startsWith(path.resolve(from).toLowerCase()+path.sep));\n  if(!mapping) throw Error('Windows Flutter package config refers outside explicit tool/cache inputs');\n  item.rootUri=url.pathToFileURL(path.join(mapping[1],path.relative(mapping[0],root))+path.sep).href;\n}\nfs.writeFileSync(path.join(tool,'packages/flutter_tools/.dart_tool/package_config.json'),JSON.stringify(config));\nNODE\n  if [[ -z \"$package\" ]]; then\n  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$(cygpath -m \"$sdk_dir\")\" \\\n    \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$sdk_stage\")\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst [source,prefix,stage]=process.argv.slice(2);\nconst release=await import(pathToFileURL(join(source,'scripts/build.mjs')));\nrelease.projectFlutterSourceEntry(source,stage);\nrelease.copyWindowsNativeArtifact(source,prefix,stage);\nrelease.assertWindowsReleaseProjection(stage);\nrelease.assertHostedRuntimeWindowsProjection(stage,{allowInjectedWindowsArtifacts:true});\nNODE\n  fi\n  # 不设置 HOME、APPDATA、LOCALAPPDATA 或 KnownFolder。工具自身 profile 状态\n  # 只属于已授权的一次性 runner 用户；依赖、工具副本和 TEMP 始终留本轮 work。\n  export FLUTTER_ROOT=\"$(cygpath -m \"$tool_root\")\" PUB_CACHE=\"$(cygpath -m \"$cache_root\")\"\n  export TEMP=\"$(cygpath -m \"$root/tmp\")\" TMP=\"$TEMP\" TMPDIR=\"$root/tmp\"\n  export FLUTTER_SUPPRESS_ANALYTICS=true\n  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \\\n    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH\n  dart_bin=\"$tool_root/bin/cache/dart-sdk/bin/dart.exe\"\n  local -a flutter=(\"$dart_bin\" \"--packages=$(cygpath -m \"$tool_root/packages/flutter_tools/.dart_tool/package_config.json\")\"\n    \"$(cygpath -m \"$tool_root/bin/cache/flutter_tools.snapshot\")\" --no-version-check --suppress-analytics)\n  MSYS2_ARG_CONV_EXCL='*' \"${flutter[@]}\" create --offline --no-pub --platforms=windows \\\n    --project-name=citizensdk_consumer --org=org.citizen \"$(cygpath -m \"$runner\")\"\n  MSYS2_ARG_CONV_EXCL='*' node - \"$(cygpath -m \"$runner\")\" \"$(cygpath -m \"$test_state\")\" \\\n    \"$(cygpath -m \"$candidate\")\" \"$software_version\" \"$package\" <<'NODE'\nconst fs=require('fs'),path=require('path');\nconst [runner,state,source,version,hosted]=process.argv.slice(2);\nif(/[\";$\\\\\\r\\n]/.test(state)) throw Error('Windows CMake test path is unsafe');\nfs.writeFileSync(path.join(runner,'pubspec.yaml'),`name: citizensdk_consumer\\npublish_to: none\\nversion: ${version}\\nenvironment:\\n  sdk: \">=3.8.0 <4.0.0\"\\ndependencies:\\n  flutter:\\n    sdk: flutter\\n  citizen_sdk:\\n    path: ../citizen_sdk\\nflutter:\\n  uses-material-design: true\\n`);\nfs.copyFileSync(path.join(source,'pubspec.lock'),path.join(runner,'pubspec.lock'));\nfs.copyFileSync(path.join(source,'windows/tests/citizen_sdk_flutter_consumer.dart'),path.join(runner,'lib/main.dart'));\nconst cmake=path.join(runner,'windows/CMakeLists.txt');\nconst text=fs.readFileSync(cmake,'utf8'), target='include(flutter/generated_plugins.cmake)';\nif(text.split(target).length!==2) throw Error('Windows official generated plugin include is not unique');\nfs.writeFileSync(cmake,text.replace(target,\n  'set(CITIZENSDK_APPLICATION_ID \"org.citizensdk.flutterconsumer\")\\n'+\n  (hosted ? '' : `set(CITIZENSDK_BUILD_TESTS ON)\\nset(CITIZENSDK_TEST_WORK_DIR \"${state}\")\\nenable_testing()\\n`)+target));\nNODE\n  (cd \"$runner\" && MSYS2_ARG_CONV_EXCL='*' \"${flutter[@]}\" pub get --offline)\n  (cd \"$runner\" && MSYS2_ARG_CONV_EXCL='*' \"${flutter[@]}\" build windows --release --no-pub)\n  cmp -s \"$candidate/pubspec.yaml\" \"$sdk_stage/pubspec.yaml\" \\\n    || fail \"Windows Flutter 不允许改写 SDK pubspec 注册\"\n  build=\"$runner/build/windows/x64\"; bundle=\"$build/runner/Release\"\n  if [[ -z \"$package\" ]]; then\n    verify_windows_flutter_inventory \"$build\" \"$test_state\" \"$prefix\"\n    MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build\")\" \\\n      -C Release --no-tests=error --output-on-failure\n  fi\n  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \"$(cygpath -m \"$sdk_dir\")\" \\\n    \"$(cygpath -m \"$prefix\")\" \"$(cygpath -m \"$bundle\")\" <<'NODE'\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst [source,prefix,bundle]=process.argv.slice(2);\nconst {assertWindowsFlutterBundle}=await import(pathToFileURL(join(source,'scripts/build.mjs')));\nassertWindowsFlutterBundle(source,prefix,bundle);\nNODE\n  run_windows_flutter_consumer \"$bundle\"\n)\n\nbuild_windows() {\n  prepare_internal_header\n  local target=x86_64-pc-windows-msvc build_root prefix test_root core_dir\n  local software_version consumer_build consumer_state destination\n  windows_path_preflight\n  command -v cl >/dev/null 2>&1 || fail \"Windows 缺少预先初始化的 MSVC 编译环境\"\n  command -v dumpbin >/dev/null 2>&1 || fail \"Windows 缺少 MSVC dumpbin\"\n  command -v cmake >/dev/null 2>&1 || fail \"Windows 缺少 CMake\"\n  load_native_dependencies Windows\n  require_rust_target \"$target\"\n  [[ -n \"${CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR:-}\" && -n \"${CITIZENSDK_WINDOWS_SQLITE_ARCHIVE:-}\" ]] \\\n    || fail \"Windows 必须显式提供已固定的 SQLite 头和 MSVC 静态库\"\n  assert_readonly_dependency_directory \"$CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR\" \"Windows SQLite include\"\n  [[ \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" == /* && \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" == *.lib \\\n      && -f \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" && ! -L \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\" ]] \\\n    || fail \"Windows SQLite archive 必须是既存绝对 .lib 路径\"\n  assert_safe_directory_path \"$(dirname \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\")\" \"Windows SQLite archive 父目录\"\n  build_root=\"$work_dir/Windows\"\n  prefix=\"$build_root/install\"\n  destination=\"$output_dir/Windows\"\n  consumer_build=\"$build_root/consumer\"\n  consumer_state=\"$build_root/consumer-state\"\n  test_root=\"$build_root/test-state\"\n  prepare_safe_directory \"$work_dir\" \"$build_root\" \"Windows 构建目录\"\n  # 测试最终目录由实际生产 Directory 首次相对创建，直接附加受保护 SID DACL。\n  # Bash mkdir/chmod 不是 Windows 私有 ACL；这里仅检查路径，不能先造继承 ACL 目录。\n  assert_descendant_path \"$work_dir\" \"$test_root\" \"Windows 测试状态\"\n  assert_safe_directory_path \"$test_root\" \"Windows 测试状态\"\n  assert_descendant_path \"$work_dir\" \"$consumer_state\" \"Windows 消费者状态\"\n  assert_safe_directory_path \"$consumer_state\" \"Windows 消费者状态\"\n  assert_safe_directory_path \"$prefix\" \"Windows 原生安装目录\"\n  [[ ! -e \"$prefix\" && ! -L \"$prefix\" ]] || fail \"Windows 临时安装前缀已存在，拒绝混入旧安装件\"\n  prepare_safe_directory \"$work_dir\" \"$prefix\" \"Windows 临时原生安装目录\"\n  software_version=\"$(sed -n 's/^version: \\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\)$/\\1/p' \"$sdk_dir/pubspec.yaml\")\"\n  [[ -n \"$software_version\" ]] || fail \"Windows 缺少唯一 SDK 版本\"\n  # 不安装工具、不联网补依赖，Cargo 输出和 CMake/CTest 状态均留在中央工作区。\n  CARGO_TARGET_DIR=\"$(cygpath -m \"$cargo_target_dir\")\" MSYS2_ARG_CONV_EXCL='*' \\\n    cargo build --manifest-path \"$(cygpath -m \"$product_ffi_manifest\")\" \\\n      --target \"$target\" --release --locked --offline\n  core_dir=\"$cargo_target_dir/$target/release\"\n  [[ -f \"$core_dir/citizensdk.dll\" && -f \"$core_dir/citizensdk.dll.lib\" ]] \\\n    || fail \"Windows Core DLL/import library 不完整\"\n  MSYS2_ARG_CONV_EXCL='*' cmake -S \"$(cygpath -m \"$windows_source_root\")\" \\\n    -B \"$(cygpath -m \"$build_root/cmake\")\" -G 'Visual Studio 17 2022' -A x64 \\\n    -DCITIZENSDK_PLATFORM=Windows \\\n    -DCITIZENSDK_CORE_LIBRARY=\"$(cygpath -m \"$core_dir/citizensdk.dll\")\" \\\n    -DCITIZENSDK_CORE_IMPORT_LIBRARY=\"$(cygpath -m \"$core_dir/citizensdk.dll.lib\")\" \\\n    -DCITIZENSDK_INTERNAL_INCLUDE_DIR=\"$(cygpath -m \"$work_dir/private-include\")\" \\\n    -DCITIZENSDK_SQLITE_INCLUDE_DIR=\"$(cygpath -m \"$CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR\")\" \\\n    -DCITIZENSDK_SQLITE_ARCHIVE=\"$(cygpath -m \"$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE\")\" \\\n    -DCITIZENSDK_ZXING_SOURCE_DIR=\"$(cygpath -m \"$CITIZENSDK_ZXING_SOURCE_DIR\")\" \\\n    -DCITIZENSDK_BUILD_TESTS=ON \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$(cygpath -m \"$test_root\")\" \\\n    -DCMAKE_INSTALL_PREFIX=\"$(cygpath -m \"$prefix\")\"\n  MSYS2_ARG_CONV_EXCL='*' cmake --build \"$(cygpath -m \"$build_root/cmake\")\" --config Release\n  local test_inventory\n  test_inventory=\"$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build_root/cmake\")\" -C Release --show-only=json-v1)\" \\\n    || fail \"Windows CTest 清单读取失败\"\n  CITIZENSDK_WINDOWS_TEST_INVENTORY=\"$test_inventory\" node -e '\n    const expected=[\"api_contract\",\"assets\",\"host_operation\",\"lifecycle\",\"directory\",\"public_store\",\"record_key\",\"secure_store\",\"sensitive_buffer\",\"secret_vault\",\"secret_boundary\",\"cng\",\"user_auth\",\"wallet_flow\"].map(x=>\"CitizenSDK.Windows.citizen_sdk_\"+x+\"_test\").sort();\n    const actual=JSON.parse(process.env.CITIZENSDK_WINDOWS_TEST_INVENTORY).tests.map(x=>x.name).sort();\n    if(JSON.stringify(actual)!==JSON.stringify(expected)) throw Error(\"Windows CTest exact set drift\");\n  ' || fail \"Windows CTest 必须精确包含 14 个正式程序\"\n  MSYS2_ARG_CONV_EXCL='*' ctest --test-dir \"$(cygpath -m \"$build_root/cmake\")\" -C Release --no-tests=error --output-on-failure\n  MSYS2_ARG_CONV_EXCL='*' cmake --install \"$(cygpath -m \"$build_root/cmake\")\" --config Release\n  verify_windows_install \"$prefix\" \"$software_version\" \"$core_dir\" \"$build_root/cmake\"\n  prepare_safe_directory \"$work_dir\" \"$consumer_build\" \"Windows 独立消费者构建目录\"\n  MSYS2_ARG_CONV_EXCL='*' cmake -S \"$(cygpath -m \"$windows_source_root/tests\")\" \\\n    -B \"$(cygpath -m \"$consumer_build\")\" -G 'Visual Studio 17 2022' -A x64 \\\n    -DCITIZENSDK_CONSUMER_PREFIX=\"$(cygpath -m \"$prefix\")\" \\\n    -DCITIZENSDK_CONSUMER_VERSION=\"$software_version\" -DCITIZENSDK_PLATFORM=Windows \\\n    -DCITIZENSDK_TEST_WORK_DIR=\"$(cygpath -m \"$consumer_state\")\"\n  MSYS2_ARG_CONV_EXCL='*' cmake --build \"$(cygpath -m \"$consumer_build\")\" --config Release\n  run_windows_consumers \"$consumer_build\" \"$prefix\" \"$consumer_state\"\n  build_windows_flutter_consumer \"$build_root\" \"$prefix\" \"$software_version\"\n  # 消费者结束后再次核对安装件；改名后不再使用记录旧前缀的 install_manifest。\n  verify_windows_install \"$prefix\" \"$software_version\" \"$core_dir\" \"$build_root/cmake\"\n  export_windows_install \"$prefix\" \"$destination\"\n  record_native_dependencies Windows\n  echo \"CitizenSDK Windows 原生、C/C++、Flutter adapter 与 Release 消费者检查完成；未执行正式发布\"\n}\n\nverify_windows_exports() {\n  local library=\"$1\" header=\"$2\" label=\"$3\" exports internal_symbols=\"\"\n  # Core为147项公开闭集，无窗口私有符号；Host另导出自己的19项和4项统一图像接口。\n  if [[ \"$header\" == \"$product_header\" ]]; then\n    internal_symbols=\"$(product_internal_symbols)\"\n  else\n    internal_symbols=\"$(qr_image_header_symbols)\"\n  fi\n  # dumpbin 的完整导出表逐项比较，禁止先过滤 citizensdk 前缀掩盖额外导出。\n  exports=\"$(MSYS2_ARG_CONV_EXCL='*' dumpbin /NOLOGO /EXPORTS \"$(cygpath -m \"$library\")\")\" \\\n    || fail \"Windows $label 无法读取 PE 导出\"\n  CITIZENSDK_PE_EXPORTS=\"$exports\" CITIZENSDK_PE_LIBRARY=\"$(cygpath -m \"$library\")\" \\\n    CITIZENSDK_PE_HEADER=\"$(cygpath -m \"$header\")\" CITIZENSDK_PE_INTERNAL=\"$internal_symbols\" node -e '\n      const fs=require(\"fs\"); const b=fs.readFileSync(process.env.CITIZENSDK_PE_LIBRARY);\n      if(b.length<64 || b.readUInt16LE(0)!==0x5a4d) throw Error(\"not PE\");\n      const o=b.readUInt32LE(60);\n      if(o>b.length-26 || b.readUInt32LE(o)!==0x4550 || b.readUInt16LE(o+4)!==0x8664 || b.readUInt16LE(o+24)!==0x20b) throw Error(\"wrong Windows PE machine\");\n      const actual=[...process.env.CITIZENSDK_PE_EXPORTS.matchAll(/^\\s*\\d+\\s+[0-9A-Fa-f]+\\s+[0-9A-Fa-f]+\\s+(\\S+)(.*)$/gm)];\n      if(actual.some(x=>x[2].includes(\"=\"))) throw Error(\"forwarded export\");\n      const names=actual.map(x=>x[1]).sort();\n      const expected=[...new Set([...fs.readFileSync(process.env.CITIZENSDK_PE_HEADER,\"utf8\").matchAll(/\\b(citizensdk_[a-z0-9_]+)\\s*\\((?!\\s*\\*)/g)].map(x=>x[1]).concat(process.env.CITIZENSDK_PE_INTERNAL.split(\"\\n\").filter(Boolean)))].sort();\n      if(JSON.stringify(names)!==JSON.stringify(expected)) throw Error(\"Windows full export set drift\");\n    ' || fail \"Windows $label PE/COFF 或完整导出合同失败\"\n}\n\nbuild_abi_host() {\n  local destination source_library nm_bin extension prefix\n  case \"$(uname -s)\" in\n    Darwin)\n      extension=dylib\n      prefix=_\n      nm_bin=\"$(xcrun --find llvm-nm)\"\n      ;;\n    Linux)\n      extension=so\n      prefix=''\n      nm_bin=\"$(command -v llvm-nm || command -v nm || true)\"\n      [[ -n \"$nm_bin\" ]] || fail \"当前 Linux 宿主缺少 llvm-nm 或 nm\"\n      ;;\n    *) fail \"产品 ABI 宿主验证尚不支持：$(uname -s)\" ;;\n  esac\n  destination=\"$output_dir/abi-host/libcitizensdk.$extension\"\n  CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path \"$product_ffi_manifest\" \\\n    --release --locked\n  source_library=\"$CARGO_TARGET_DIR/release/libcitizensdk.$extension\"\n  [[ -f \"$source_library\" ]] || fail \"CitizenSDK 产品 ABI 宿主库未生成\"\n  prepare_safe_output_file \"$output_dir\" \"$destination\" \"CitizenSDK 产品 ABI 宿主库\"\n  cp \"$source_library\" \"$destination\"\n  verify_product_abi_symbols \"$destination\" \"$nm_bin\" \"$prefix\" \\\n    \"CitizenSDK 产品 ABI 宿主库\"\n  \"${CC:-cc}\" -std=c11 -fsyntax-only -I\"$sdk_dir/include\" \\\n    \"$sdk_dir/native/ffi/tests/c_header_c11.c\"\n  \"${CXX:-c++}\" -std=c++17 -fsyntax-only -I\"$sdk_dir/include\" \\\n    \"$sdk_dir/native/ffi/tests/c_header_cpp17.cc\"\n  echo \"CitizenSDK 产品 ABI 宿主验证完成：$destination\"\n}\n\nverify_outputs() {\n  local android_core=\"$output_dir/android/arm64-v8a/libcitizensdk.so\"\n  local android_jni=\"$output_dir/android/arm64-v8a/libcitizensdk_jni.so\"\n  local android_aar=\"$output_dir/android/citizensdk.aar\"\n  local apple_xcframework=\"$output_dir/apple/CitizenSDK.xcframework\"\n  local host_library=\"$output_dir/host/libsmoldot.dylib\"\n  [[ -f \"$android_core\" && -f \"$android_jni\" && -f \"$android_aar\" \\\n    && -d \"$apple_xcframework\" \\\n    && -f \"$host_library\" ]] \\\n    || fail \"Android/iOS/macOS 产品与 legacy macOS 宿主测试运行件集合不完整\"\n  local toolchain nm_bin\n  toolchain=\"$(android_toolchain)\"\n  verify_product_abi_symbols \"$android_core\" \"$toolchain/bin/llvm-nm\" \"\" \\\n    \"Android libcitizensdk.so\"\n  verify_android_aar \\\n    \"$android_aar\" \"$android_core\" \"$android_jni\" \"$toolchain/bin/llvm-nm\"\n  verify_apple_xcframework \"$apple_xcframework\"\n  nm_bin=\"$(xcrun --find llvm-nm)\"\n  local host_architectures\n  host_architectures=\"$(xcrun lipo -archs \"$host_library\")\"\n  [[ \"$host_architectures\" == arm64 ]] \\\n    || fail \"macOS 宿主测试库内部架构必须精确为 arm64\"\n  verify_symbol_contract \"$(symbol_list_ios \"$host_library\" \"$nm_bin\")\" \"_\" \\\n    \"macOS 宿主测试库\"\n  echo \"CitizenSDK Android AAR、iOS/macOS XCFramework 与 legacy macOS 宿主测试合同通过\"\n}\n\nrequire_zxing_source() {\n  local source=\"${CITIZENSDK_ZXING_SOURCE_DIR:-}\"\n  [[ -n \"$source\" && \"$source\" == /* && -d \"$source\" && ! -L \"$source\" \\\n    && -f \"$source/CMakeLists.txt\" && ! -L \"$source/CMakeLists.txt\" \\\n    && -f \"$source/core/src/ZXingC.h\" && ! -L \"$source/core/src/ZXingC.h\" ]] \\\n    || fail \"必须通过 CITIZENSDK_ZXING_SOURCE_DIR 提供完整官方 ZXing-C++ 3.1.1 源码\"\n  grep -Fq 'project (ZXing VERSION \"3.1.1\")' \"$source/core/CMakeLists.txt\" \\\n    || fail \"ZXing-C++ 源码版本必须精确为 3.1.1\"\n}\n\ncase \"$target_name\" in\n  android|apple|LinuxARM|LinuxAMD|Windows|all) require_zxing_source ;;\nesac\n\n# 每轮编译只使用SDK自身装配的普通文件工程；build.rs不能写回上游原件。\nprepare_native_source() {\n  local node_bin=\"${NODE:-$(command -v node || true)}\" source=\"$sdk_dir\" destination=\"$work_dir/native-source\"\n  [[ -n \"$node_bin\" && -x \"$node_bin\" ]] || fail \"原生输入装配缺少Node\"\n  if [[ \"$target_name\" == Windows ]]; then\n    source=\"$(cygpath -m \"$source\")\"\n    destination=\"$(cygpath -m \"$destination\")\"\n  fi\n  native_source_root=\"$(\"$node_bin\" \"$sdk_dir/scripts/build.mjs\" projection \\\n    --native-source-view \"$source\" --output \"$destination\")\" || fail \"原生输入装配失败\"\n  ffi_manifest=\"$native_source_root/native/legacy/Cargo.toml\"\n  product_ffi_manifest=\"$native_source_root/native/ffi/Cargo.toml\"\n}\n\ncase \"$target_name\" in\n  android|apple|LinuxARM|LinuxAMD|Windows|host|abi-host|all) prepare_native_source ;;\nesac\n\ncase \"$target_name\" in\n  android) build_android ;;\n  apple) build_apple ;;\n  LinuxARM|LinuxAMD) build_linux \"$target_name\" ;;\n  Windows) build_windows ;;\n  host) build_host ;;\n  abi-host) build_abi_host ;;\n  apple-tests) build_apple_tests ;;\n  all) build_android; build_apple; build_apple_tests; build_host; verify_outputs ;;\n  verify) verify_outputs ;;\n  *) fail \"用法：$0 android|apple|LinuxARM|LinuxAMD|Windows|apple-tests|host|abi-host|all|verify\" ;;\nesac\n", "analysis": "include: package:flutter_lints/flutter.yaml\n\nanalyzer:\n  language:\n    strict-casts: true\n    strict-inference: true\n    strict-raw-types: true\n  errors:\n    invalid_use_of_visible_for_testing_member: error\n    missing_required_param: error\n    missing_return: error\n\nlinter:\n  rules:\n    avoid_dynamic_calls: false\n    directives_ordering: true\n    discarded_futures: true\n    prefer_final_locals: true\n    unawaited_futures: true\n"});
export async function runOwnedShell(name,args,{environment=process.env,source=root}={}) {
 const targets=new Set(['android','apple','LinuxARM','LinuxAMD','Windows','host','abi-host','apple-tests','all','verify']);
 if(name!=='native'||!Array.isArray(args)||args.length!==1||!targets.has(args[0]))fail('原生编译目标或参数无效');
 const result=await runBuildProcess(environment.PRODUCT_BASH_BIN||'/bin/bash',
  ['--noprofile','--norc','-c',BUILD_SHELL_SOURCES.native,'citizensdk-native',args[0]],
  {...environment,CITIZENSDK_SOURCE_ROOT:source,PRODUCT_NODE_BIN:environment.NODE||process.execPath},source,
  {capture:true,streamError:true});
 process.stdout.write(result.stdout);return result.code;
}
export function writeAnalysisOptions(destination) {
 if (!isAbsolute(destination)||resolve(destination)!==destination||!inside(join(root,'target'),destination)) fail('分析选项必须生成在本产品target内');
 let current=dirname(destination);while(!existsSync(current))current=dirname(current);
 if(realpathSync(current)!==current||!lstatSync(current).isDirectory())fail('分析选项目录无效');
 mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,BUILD_SHELL_SOURCES.analysis,{flag:'wx',mode:0o600});return destination;
}

const buildResources=await(async()=>{

const {fixedScratch,trackWorkProcess,workEnvironment,checkScratchPath}=buildTarget;

// 产品资源阶段：声明、取得、验真和物化均属于本仓；可选原件目录不参与版本决策。
const {AsyncLocalStorage}=await import('node:async_hooks');
const {writeFileSync: writeGroupRecord}=await import('node:fs');
const supplyGroups=new Map();
const {createHash,randomUUID}=await import('node:crypto');
const {existsSync,readFileSync,constants}=await import('node:fs');
const {lstat,realpath,readdir,readlink,symlink,copyFile,readFile,writeFile,mkdir,mkdtemp,rename,rm: removeResourcePath,chmod,open}=await import('node:fs/promises');
const {dirname,join,resolve,relative,isAbsolute,sep,parse,win32,posix}=await import('node:path');
const {fileURLToPath,pathToFileURL}=await import('node:url');
const {homedir}=await import('node:os');
const {gunzipSync,inflateRawSync}=await import('node:zlib');
const {spawn}=await import('node:child_process');
const {createRequire}=await import('node:module');
const resourceSupplies=new AsyncLocalStorage();
const exec=runResourceProcess,execute=exec;
// 工具返回只在主进程和整组后代退出后完成；未确认的输入目录禁止后续清理或改权限。
const retainedResourceRoots=new Set();
function retainedResourcePath(path) {
 const value=resolve(String(path));
 return [...retainedResourceRoots].some(root=>value===root||value.startsWith(root+sep)||root.startsWith(value+sep));
}
async function rm(path,options) {
 if(retainedResourcePath(path))throw Error('资源工具退出未确认，保留工作目录');

 if(retainedResourcePath(path))throw Error('资源工具退出未确认，保留工作目录');
 return removeResourcePath(path,options);
}
function runResourceProcess(command,args,{signal,maxBuffer=8*1024**2,timeout=3600000,encoding='utf8',quietOutput=false,...options}={}) {
 const supplied=resourceSupplies.getStore();if(supplied&&!supplied.preparingTool){if(typeof supplied.runCommand!=='function')fail('供给未交付执行能力');return supplied.runCommand(command,args,{...options,maxBuffer,timeout,encoding,quietOutput,signal});}

 signal?.throwIfAborted();
 if(!Number.isSafeInteger(maxBuffer)||maxBuffer<=0||!Number.isSafeInteger(timeout)||timeout<=0)throw Error('资源进程边界参数无效');
 return new Promise((ok,reject)=>{
  const child=spawn(command,args,{...options,env:workEnvironment(options.env),detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  trackWorkProcess(child.pid);
  const supply=resourceSupplies.getStore(),groups=supply?.work?(supplyGroups.get(supply.work)||new Set()):null;
  const record=()=>{if(groups)writeGroupRecord(join(supply.work,'.resource-active.json'),JSON.stringify({pid:process.pid,groups:[...groups]})+'\n');};
  if(groups&&Number.isSafeInteger(child.pid)){supplyGroups.set(supply.work,groups);groups.add(child.pid);record();}
  const output=[],errors=[];let bytes=0,done=false,closed=false,failure=null,probe=null,force=null,limit=null;
  const groupExists=()=>{
   if(process.platform==='win32')return !closed;
   if(!child.pid)return false;
   try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}
  };
  const stop=hard=>{
   if(!child.pid)return;
   // 进程组已接收信号时立即返回，禁止同轮再次向组内主进程发送相同信号。
   if(process.platform!=='win32')try{process.kill(-child.pid,hard?'SIGKILL':'SIGTERM');return;}catch(error){if(error.code!=='ESRCH'){failure=Error('资源工具取消无法确认');return;}}
   if(!closed)try{child.kill(hard?'SIGKILL':'SIGTERM');}catch{failure=Error('资源工具取消无法确认');}
  };
  const finish=(error,result)=>{
   if(done)return;done=true;if(groups&&closed&&!groupExists()){groups.delete(child.pid);record();}clearTimeout(timer);clearTimeout(force);clearTimeout(limit);clearTimeout(probe);signal?.removeEventListener('abort',cancel);
   error?reject(error):ok(result);
  };
  const retain=()=>{
   for(const path of [options.cwd,options.env?.PRODUCT_WORK_DIR])if(typeof path==='string'&&isAbsolute(path))retainedResourceRoots.add(resolve(path));
   finish(Error('资源工具退出未确认，保留工作目录'));
  };
  const confirm=()=>{
   if(done)return;
   if(closed&&!groupExists()) {
    const stdout=Buffer.concat(output),stderr=Buffer.concat(errors);
    finish(failure,{stdout:encoding==='buffer'?stdout:stdout.toString(encoding),stderr:encoding==='buffer'?stderr:stderr.toString(encoding)});return;
   }
   probe=setTimeout(confirm,50);
  };
  const requestStop=error=>{
   if(done||force!==null)return;failure=error;stop(false);
   force=setTimeout(()=>stop(true),8000);limit=setTimeout(retain,12000);
   if(probe===null)confirm();
  };
  const cancel=()=>requestStop(signal.reason instanceof Error?signal.reason:Error('资源进程已取消'));
  const timer=setTimeout(()=>requestStop(Error('资源进程超时')),timeout);
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  for(const [stream,parts]of [[child.stdout,output],[child.stderr,errors]])stream.on('data',chunk=>{
   if(done)return;bytes+=chunk.length;
   if(bytes>maxBuffer){requestStop(Error('资源进程输出超限'));return;}
   parts.push(chunk);if(!quietOutput)process.stderr.write(chunk);
  });
  child.once('error',()=>{if(!child.pid){closed=true;finish(Error('资源工具无法启动'));}else requestStop(Error('资源工具进程错误'));});
  child.once('close',(code,termination)=>{
   closed=true;
   if(!failure&&(code!==0||termination))failure=Error('资源工具失败');
   if(groupExists())requestStop(failure||Error('资源工具后代未结束'));
   if(probe===null)confirm();
  });
 });
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error('产品资源：'+message);};
const safePath=value=>typeof value==='string'&&value.length>0&&!isAbsolute(value)&&!/[\\\x00-\x1f]/u.test(value)&&value.split('/').every(x=>x&&x!=='.'&&x!=='..');
const inside=(base,path)=>path.startsWith(base+sep);
const stat=async path=>lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
async function regular(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||await realpath(path)!==path)fail('非独占普通文件：'+path);return s;}
async function directory(path,create=false){if(!isAbsolute(path)||resolve(path)!==path||path===parse(path).root)fail('目录不是准确绝对路径');let at=parse(path).root;for(const name of relative(at,path).split(sep)){at=join(at,name);if(create&&!await stat(at))await mkdir(at,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(at);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(at)!==at)fail('目录经过链接或特殊项：'+at);}return path;}
// 普通资源清单保持独占文件要求；工具内部硬链接只由同一扫描器的私有验真现场核对。
async function inventory(base,path=base){return inventoryFiles(base,path);}
function inventoryStatMatches(before,after){
 return ['dev','ino','nlink','mode','uid','gid','size','mtimeMs','ctimeMs','birthtimeMs'].every(key=>before[key]===after[key]);
}
async function inventoryFiles(base,path,toolScan){
 if(toolScan){
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)fail('工具原件目录边界无效');
  toolScan.entries.push({path,info});
 }
 const files=[];
 for(const name of (await readdir(path)).sort()){
  const file=join(path,name),s=await lstat(file),key=relative(base,file),entry={path:file,info:s};
  if(s.isSymbolicLink()){
   const target=relative(base,await realpath(file));if(!safePath(target))fail('链接越界');
   entry.target=target;files.push({path:key,target});
  }else if(s.isDirectory())files.push({path:key,directory:true},...await inventoryFiles(base,file,toolScan));
  else if(s.isFile()){
   let bytes;
   if(toolScan){
    if(!safePath(key)||await realpath(file)!==file)fail('工具原件文件边界无效');
    const id=s.dev+':'+s.ino;let group=toolScan.hardlinks.get(id);
    if(!group)toolScan.hardlinks.set(id,group={nlink:s.nlink,paths:[]});
    if(group.nlink!==s.nlink)fail('工具清单读取期间硬链接计数变化');
    group.paths.push(file);
    // 不跟随末级链接；打开和读取后均核对同一文件身份，禁止替换或改权限后继续验真。
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
     if(!inventoryStatMatches(s,await handle.stat()))fail('工具清单读取期间文件变化');
     bytes=await handle.readFile();
     if(!inventoryStatMatches(s,await handle.stat()))fail('工具清单读取期间文件变化');
    }finally{await handle.close();}
   }else{
    if(s.nlink!==1)fail('共享硬链接');bytes=await readFile(file);
   }
   files.push({path:key,sha256:hash(bytes),executable:Boolean(s.mode&0o111)});
  }else fail('特殊文件');
  if(toolScan&&!s.isDirectory())toolScan.entries.push(entry);
 }
 return files;
}
async function permissions(path,writable){
 if(retainedResourcePath(path))throw Error('资源工具退出未确认，保留工作目录');const s=await lstat(path);if(s.isSymbolicLink())return;if(s.isDirectory()){if(writable)await chmod(path,0o700);for(const name of await readdir(path))await permissions(join(path,name),writable);if(!writable)await chmod(path,0o555);}else await chmod(path,writable?0o600:s.mode&0o111?0o555:0o444);}
function checkedURL(input){const url=new URL(input);if(url.protocol!=='https:'||url.username||url.password||url.hash)fail('来源必须是无凭据HTTPS');return url.href;}
function digestSpec(entry){if(entry.sha256&&/^[a-f0-9]{64}$/u.test(entry.sha256))return ['sha256',Buffer.from(entry.sha256,'hex')];const m=/^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(entry.integrity||'');if(!m)fail('来源缺少锁定摘要');const b=Buffer.from(m[2],'base64');if(b.toString('base64')!==m[2]||b.length!==({sha256:32,sha512:64}[m[1]]))fail('完整性不是规范摘要');return [m[1],b];}
function verifyBytes(bytes,entry){const [algorithm,digest]=digestSpec(entry);if(!createHash(algorithm).update(bytes).digest().equals(digest))fail('锁定来源摘要不符');return hash(bytes);}
// 不持下载锁。每个候选独占生成，提交使用同对象短锁与排他重命名，竞争者核验同一字节。
// 候选下载、解包和编译归本产品当前target现场；永久原件只在验真提交后接收。
async function resourceWork(work) {
 const path=work||temporaryRoot(undefined,'tmp');
 checkScratchPath(path);return directory(join(path,'resource-pending'),true);
}
async function acquireArchive(entry,{store,work,optional,offline=false,fetcher=fetch,signal,maxBytes=4*1024**3}={}){
 const supplied=resourceSupplies.getStore();if(supplied)return supplied.acquireOriginal(entry,{kind:store===join(supplied.toolRoot,'archives')?'tool':'dependency',offline,signal,maxBytes});
 const url=checkedURL(entry.url);digestSpec(entry);await directory(store,true);const coordinate=hash(JSON.stringify([url,entry.sha256||entry.integrity]));const target=join(store,coordinate+'.blob');
 const check=async path=>{await regular(path);const b=await readFile(path);if(!b.length||b.length>maxBytes)fail('原件大小超限');verifyBytes(b,entry);return path;};
 if(await stat(target))return check(target);
 // 可选目录只按准确内容摘要读取，绝不读取它的产品白名单或版本登记。
 if(optional&&await stat(optional)){await directory(optional);let digest=entry.sha256;if(!digest&&entry.integrity){const index=join(dirname(optional),'index.json');if(await stat(index)){await regular(index);if((await lstat(index)).size>32*1024**2)fail('可选原件索引超限');const data=await readDependencySupply(optional);digest=data.packages?.flatMap(x=>x.archives||[]).find(x=>x.url===entry.url&&x.integrity===entry.integrity)?.sha256;}}if(digest&&!/^[a-f0-9]{64}$/u.test(digest))fail('可选供给摘要无效');const supplied=digest?join(optional,digest+'.blob'):null;if(supplied&&await stat(supplied)){await check(supplied);const candidate=join(await resourceWork(work),'.'+coordinate+'.'+randomUUID()+'.pending');try{await copyFile(supplied,candidate,constants.COPYFILE_EXCL);await chmod(candidate,0o444);await commitCandidate(candidate,target,{signal,verify:check});return await check(target);}finally{await rm(candidate,{force:true});}}}
 if(offline)fail('离线缺少锁定资源：'+url);signal?.throwIfAborted();let response,current=url;
 for(let i=0;i<=5;i++){response=await fetcher(current,{redirect:'manual',signal});if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();if(i===5)fail('来源重定向超限');current=checkedURL(new URL(response.headers.get('location'),current).href);continue;}break;}
 if(!response?.ok||!response.body)fail('来源获取失败：'+url);const length=Number(response.headers.get('content-length'));if(length>maxBytes)fail('来源声明超限');
 const temporary=join(await resourceWork(work),'.'+coordinate+'.'+randomUUID()+'.pending'),h=await open(temporary,'wx',0o600);let bytes=0;const [algorithm,digest]=digestSpec(entry),checksum=createHash(algorithm);
 try{for await(const chunk of response.body){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>maxBytes)fail('来源数据超限');checksum.update(chunk);let offset=0;while(offset<chunk.length){const n=await h.write(chunk,offset,chunk.length-offset);if(!n.bytesWritten)fail('原件写入中断');offset+=n.bytesWritten;}}if(!bytes||!checksum.digest().equals(digest))fail('锁定来源摘要不符');if(length&&length!==bytes)fail('来源数据不完整');await h.sync();await h.close();signal?.throwIfAborted();await chmod(temporary,0o444);await commitCandidate(temporary,target,{signal,verify:check});return await check(target);}finally{await h.close().catch(()=>{});await rm(temporary,{force:true});await response.body?.cancel().catch(()=>{});}
}
async function downloadTool(entry,target,options){const archive=await acquireArchive(entry,{...options,store:options.store||dirname(target)});await copyFile(archive,target,constants.COPYFILE_EXCL);}
// 解包先解析全部成员并验证闭包，之后才写入；链接不得指向归档外部或成为文件父目录。
async function extractArchive(input,destination,{prefix='',signal,tar,maxBytes=8*1024**3}={}){
 await regular(input);if(await stat(destination))fail('解包目标已存在');let bytes=await readFile(input),entries=[];
 const add=(path,type,data,mode=0o644,target)=>{path=path.replace(/\/$/u,'').replace(/^\.\//u,'');if(path==='.'||!path)return;if(!safePath(path))fail('归档成员越界');if(entries.length>=400000||entries.some(x=>x.path===path))fail('归档成员重复或超限');entries.push({path,type,data,mode,target});};
 if(bytes[0]===0x50&&bytes[1]===0x4b){let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}if(end<0)fail('ZIP目录缺失');const count=bytes.readUInt16LE(end+10);let cursor=bytes.readUInt32LE(end+16),total=0;for(let n=0;n<count;n++){signal?.throwIfAborted();if(bytes.readUInt32LE(cursor)!==0x02014b50)fail('ZIP成员无效');const method=bytes.readUInt16LE(cursor+10),size=bytes.readUInt32LE(cursor+24),compressed=bytes.readUInt32LE(cursor+20),nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),mode=bytes.readUInt32LE(cursor+38)>>>16,offset=bytes.readUInt32LE(cursor+42),name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');if(bytes.readUInt16LE(cursor+8)&1||size===0xffffffff||offset===0xffffffff)fail('ZIP加密或Zip64未声明');total+=size;if(total>maxBytes)fail('ZIP解压超限');if(bytes.readUInt32LE(offset)!==0x04034b50)fail('ZIP本地记录无效');const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),data=bytes.subarray(start,start+compressed),output=method===0?data:method===8?inflateRawSync(data,{maxOutputLength:Math.max(1,size)}):fail('ZIP压缩方式未声明');if(output.length!==size)fail('ZIP长度不符');add(name,name.endsWith('/')?'directory':(mode&0o170000)===0o120000?'symlink':'file',output,mode||0o644,output.toString());cursor+=46+nameLength+extra+comment;}}
 else{if(bytes[0]===0x1f&&bytes[1]===0x8b)bytes=gunzipSync(bytes,{maxOutputLength:maxBytes});else if(bytes[0]===0xfd&&bytes[1]===0x37){if(!tar)fail('XZ需要已验真基础归档工具');fail('XZ应通过受控tar清单提取');}
  const number=b=>{const v=b.toString().replace(/\0.*$/su,'').trim();if(!/^[0-7]*$/u.test(v))fail('TAR数字无效');return parseInt(v||'0',8);};let pax={},global={};
  for(let cursor=0;cursor+512<=bytes.length;){signal?.throwIfAborted();const block=bytes.subarray(cursor,cursor+512);if(block.every(x=>x===0))break;let sum=0;for(let i=0;i<512;i++)sum+=(i>=148&&i<156)?32:block[i];if(sum!==number(block.subarray(148,156)))fail('TAR头摘要不符');const size=number(block.subarray(124,136)),type=String.fromCharCode(block[156]||48),str=(a,b)=>block.subarray(a,b).toString().replace(/\0.*$/su,''),data=bytes.subarray(cursor+512,cursor+512+size);if(data.length!==size||size>maxBytes)fail('TAR内容超限');cursor+=512+Math.ceil(size/512)*512;
   if(type==='x'||type==='g'){const values={};let at=0;while(at<data.length){const space=data.indexOf(32,at),length=Number(data.subarray(at,space).toString());if(!Number.isInteger(length)||length<=space-at+1||at+length>data.length)fail('PAX长度无效');const record=data.subarray(space+1,at+length-1).toString(),eq=record.indexOf('=');if(eq<1)fail('PAX字段无效');values[record.slice(0,eq)]=record.slice(eq+1);at+=length;}if(type==='g')global={...global,...values};else pax=values;continue;}
   if(type==='L'){pax.path=data.toString().replace(/\0.*$/su,'');continue;}if(type==='K'){pax.linkpath=data.toString().replace(/\0.*$/su,'');continue;}
   const attrs={...global,...pax};pax={};if(Object.keys(attrs).some(x=>x.startsWith('GNU.sparse')))fail('TAR稀疏文件未声明');const name=attrs.path||[str(345,500),str(0,100)].filter(Boolean).join('/'),target=attrs.linkpath||str(157,257);if(!['0','5','2','1'].includes(type))fail('TAR特殊成员未声明');add(name,{'0':'file','5':'directory','2':'symlink','1':'hardlink'}[type],data,number(block.subarray(100,108)),target);
  }
 }
 const selected=entries.filter(e=>!prefix||e.path===prefix||e.path.startsWith(prefix+'/')).map(e=>({...e,path:prefix?e.path.slice(prefix.length).replace(/^\//u,''):e.path})).filter(e=>e.path);if(!selected.length)fail('归档根缺失');const table=new Map(selected.map(e=>[e.path,e]));
 for(const entry of selected){let parent=dirname(entry.path);while(parent!=='.'){if(table.has(parent)&&table.get(parent).type!=='directory')fail('归档父目录不是目录');parent=dirname(parent);}if(['symlink','hardlink'].includes(entry.type)){const target=entry.type==='symlink'?posix.normalize(posix.join(posix.dirname(entry.path),entry.target)):prefix?entry.target.replace(new RegExp('^'+prefix+'/'),''):entry.target;if(!safePath(target)||!table.has(target))fail('归档链接越界或缺失');entry.resolved=target;}}
 await mkdir(destination,{mode:0o700});try{for(const entry of selected.filter(x=>['file','directory'].includes(x.type))){signal?.throwIfAborted();const file=join(destination,entry.path);await mkdir(dirname(file),{recursive:true,mode:0o700});if(entry.type==='directory')await mkdir(file,{recursive:true,mode:0o700});else await writeFile(file,entry.data,{flag:'wx',mode:entry.mode&0o111?0o755:0o644});}
 for(const entry of selected.filter(x=>['symlink','hardlink'].includes(x.type))){signal?.throwIfAborted();const file=join(destination,entry.path);await mkdir(dirname(file),{recursive:true});if(entry.type==='hardlink'){const source=table.get(entry.resolved);if(source.type!=='file')fail('硬链接目标不是普通文件');await copyFile(join(destination,entry.resolved),file,constants.COPYFILE_EXCL);}else await symlink(entry.target,file);}await inventory(destination);return destination;}catch(e){await permissions(destination,true);await rm(destination,{recursive:true});throw e;}
}
// XZ由验真POSIX tar处理；双遍清单、无链接父目录与候选物化后的清单一起保护边界。
async function unpack(input,target,{prefix='',signal,foundation}={}){const b=await readFile(input);if(!(b[0]===0xfd&&b[1]===0x37))return extractArchive(input,target,{prefix,signal});const tar=foundation?.tools.tar;if(!tar)fail('XZ缺少已验真tar');const list=await exec(tar,['-tvf',input],{signal,maxBuffer:32*1024**2});if(list.stdout.split('\n').filter(Boolean).some(x=>!/^[-d]/u.test(x)))fail('XZ成员含链接或特殊项');const names=(await exec(tar,['-tf',input],{signal,maxBuffer:32*1024**2})).stdout.split('\n').filter(Boolean);if(names.some(x=>!safePath(x.replace(/\/$/u,'').replace(/^\.\//u,''))))fail('XZ成员越界');await mkdir(target);await exec(tar,['-xkf',input,'--no-same-owner','-C',target],{signal,maxBuffer:2*1024**2});await inventory(target);if(prefix){const child=join(target,prefix),temporary=target+'.root';await directory(child);await rename(child,temporary);await permissions(target,true);await rm(target,{recursive:true});await rename(temporary,target);}return target;}
// 本仓准确工具配方；外部供给登记不能改变这些版本和来源。
const posixRecipe=(()=>{

// 只采集官方macOS发行件中的基础入口；不纳入Git/Python/Ruby等独立登记工具。
const posixNames = Object.freeze([
  'sh', 'bash', 'tar', 'awk', 'sed', 'grep', 'cat', 'chmod', 'cp', 'cut', 'dirname',
  'echo', 'env', 'expr', 'false', 'find', 'head', 'install', 'ln', 'ls', 'mkdir',
  'mktemp', 'mv', 'od', 'paste', 'pwd', 'readlink', 'rm', 'rmdir', 'sleep', 'sort',
  'tail', 'tee', 'test', 'touch', 'tr', 'true', 'uname', 'uniq', 'wc', 'xargs',
  'basename', 'printf', 'date', 'cmp', 'comm', 'dd', 'df', 'du', 'hostname',
  'whoami', 'file', 'stat', 'zip', 'unzip', 'plutil', 'ditto', 'rsync', 'patch',
  'sw_vers', 'chflags', 'cpio', 'gzip', 'gunzip', 'bzip2', 'egrep', 'fgrep',
  'open', 'pgrep', 'pkill', 'lsof', 'zsh', 'ps', 'kill', 'diff', 'yes', 'realpath',
  'which', 'sysctl',
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error('受控POSIX工具：' + message); };

function validatePosixTool(tool) {
  if (tool?.id !== 'posix' || tool.command !== 'bash' || !tool.managed
    || !/^\d+\.\d+(?:\.\d+)?$/u.test(tool.version)
    || tool.source !== 'https://opensource.apple.com/'
    || JSON.stringify(tool.requires) !== JSON.stringify(['node', 'xcode'])
    || tool.archive?.kind !== 'apple-posix'
    || tool.archive.url !== tool.source || tool.archive.root !== 'macos-posix-' + tool.version
    || tool.archive.executable !== 'bin/bash' || !/^[a-f0-9]{64}$/u.test(tool.archive.sha256)
    || tool.dependencies || tool.components || tool.archives) fail('官方发行件登记不完整');
}

// 本机基础工具从已声明的系统位置取得实际入口。
async function locatePosixSources({signal,platform=process.platform}={}){
 if(platform!=='darwin')fail('仅限已授权macOS自举');
 const files=[];
 for(const name of posixNames){signal?.throwIfAborted();const entry=['/bin/','/usr/bin/','/usr/sbin/'].map(prefix=>prefix+name).find(existsSync);if(!entry)fail('缺少官方基础入口：'+name);const path=await realpath(entry),info=await lstat(path);if(!info.isFile()||!(info.mode&0o111))fail('系统输入不是普通可执行文件');files.push({name,path});}
 return files;
}

// 采集不是常态回退：只有本次明确授权的bootstrap调用可建立候选，发布仍由工具事务完成。
async function buildPosixTool({ tool, payload, bootstrap = false, run, signal }) {
  validatePosixTool(tool);
  if (bootstrap !== true) fail('缺少本次首次自举授权');
  const files = await locatePosixSources({signal});
  await mkdir(payload); await mkdir(join(payload, 'bin'));
  for (const file of files) {
    const target = join(payload, 'bin', file.name);
    await copyFile(file.path, target);
    // 系统原签名带平台限制；候选建立本机运行签名。
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', target],
      { signal, timeout: 60000, env: { PATH: '', LANG: 'C' } });
  }
  // 发布前真实执行文件、归档及Flutter宿主探测；只接受同对象内的sysctl。
  const bin = join(payload, 'bin'), probe = join(payload, '.probe');
  await mkdir(probe);
  try {
    const result = await run(join(bin, 'bash'), ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
      'printf "controlled-posix-ok\\n" > input; cp input copy; cmp input copy; awk "{print}" copy | sed -n "1p"; tar -cf check.tar input; tar -tf check.tar; which sysctl; sysctl -n hw.optional.arm64; if which citizen-tool-not-installed > /dev/null 2>&1; then exit 1; fi'],
      { cwd: probe, signal, timeout: 60000, env: { PATH: bin, LANG: 'C' } });
    if (result.stdout !== 'controlled-posix-ok\ninput\n' + join(bin, 'sysctl') + '\n1\n') fail('基础工具真实执行回读不符');
  } finally { await rm(probe, {recursive:true,force:true}); }
}

// 调用方只取得同一只读对象内入口；缺失立即失败，绝不从系统或PATH补齐。
async function controlledPosixTools(library, verify) {
  const tool = library.tools.find(entry => entry.id === 'posix');
  if (!tool) fail('基础工具未登记');
  validatePosixTool(tool);
  const installed = await verify(library, tool);
  if (!installed) fail('请先安装已登记基础工具原件');
  const bin = dirname(installed.path), tools = {};
  for (const name of posixNames) {
    const path = join(bin, name), info = await lstat(path);
    if (!info.isFile() || !(info.mode & 0o111) || await realpath(path) !== path) fail('受控入口失效：' + name);
    tools[name] = path;
  }
  return { bin, tools };
}
return {posixNames,buildPosixTool,controlledPosixTools};})();
const sourceRecipe=(()=>{
const controlledPosixTools=(...args)=>productFoundation(...args);

const fail = message => { throw new Error('官方源码工具：' + message); };
const plain = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = Object.freeze({
  bash: version => { const base=version.split('.').slice(0,2).join('.');return ['https://ftp.gnu.org/gnu/bash/bash-'+base+'.tar.gz','bash-'+base,'bin/bash']; },
  grep: version => ['https://ftp.gnu.org/gnu/grep/grep-' + version + '.tar.xz', 'grep-' + version, 'bin/grep'],
  sed: version => ['https://ftp.gnu.org/gnu/sed/sed-' + version + '.tar.xz', 'sed-' + version, 'bin/sed'],
  m4: version => ['https://ftp.gnu.org/gnu/m4/m4-' + version + '.tar.xz', 'm4-' + version, 'bin/m4'],
  bison: version => ['https://ftp.gnu.org/gnu/bison/bison-' + version + '.tar.xz', 'bison-' + version, 'bin/bison'],
  flex: version => ['https://github.com/westes/flex/releases/download/v' + version + '/flex-' + version + '.tar.gz', 'flex-' + version, 'bin/flex'],
  gettext: version => ['https://ftp.gnu.org/gnu/gettext/gettext-' + version + '.tar.gz', 'gettext-' + version, 'bin/msgfmt'],
  tcl: version => ['https://github.com/tcltk/tcl/releases/download/core-' + version.replaceAll('.', '-') + '/tcl' + version + '-src.tar.gz', 'tcl' + version, 'bin/tclsh' + version.split('.').slice(0, 2).join('.')],
  git: version => ['https://www.kernel.org/pub/software/scm/git/git-' + version + '.tar.xz', 'git-' + version, 'bin/git'],
  python: version => ['https://www.python.org/ftp/python/' + version + '/Python-' + version + '.tar.xz', 'Python-' + version, 'bin/python' + version.split('.').slice(0, 2).join('.')],
  perl: version => ['https://www.cpan.org/src/5.0/perl-' + version + '.tar.xz', 'perl-' + version, 'bin/perl'],
  ruby: version => ['https://cache.ruby-lang.org/pub/ruby/' + version.split('.').slice(0, 2).join('.') + '/ruby-' + version + '.tar.gz', 'ruby-' + version, 'bin/ruby'],
  openssl: version => ['https://github.com/openssl/openssl/releases/download/openssl-' + version + '/openssl-' + version + '.tar.gz', 'openssl-' + version, 'bin/openssl'],
  cocoapods: version => ['https://rubygems.org/downloads/cocoapods-' + version + '.gem', '.', 'bin/pod'],
});
const requirements = Object.freeze({
  bash: ['node', 'xcode', 'posix'], grep: ['node', 'xcode', 'posix'], sed: ['node', 'xcode', 'posix'],
  git: ['node', 'xcode', 'perl', 'python', 'gettext'], python: ['node', 'xcode', 'openssl'],
  m4: ['node', 'xcode'], bison: ['node', 'xcode', 'm4'], flex: ['node', 'xcode', 'm4', 'bison'],
  gettext: ['node', 'xcode', 'perl', 'm4', 'bison', 'flex'], tcl: ['node', 'xcode'],
  perl: ['node', 'xcode'], openssl: ['node', 'xcode', 'perl'],
  ruby: ['node', 'xcode', 'openssl'], cocoapods: ['node', 'xcode', 'ruby', 'git'],
});

// 来源、归档根、执行入口和前置对象形成闭集；运行时绝不解析latest或系统同名命令。
function validateSourceTool(tool) {
  const expected = sources[tool?.id]?.(tool.version);
  if (!expected || !tool.managed || !/^\d+\.\d+(?:\.\d+)?$/u.test(tool.version)
    || JSON.stringify(tool.requires) !== JSON.stringify(requirements[tool.id])
    || tool.archive?.kind !== (tool.id === 'cocoapods' ? 'gem' : 'native-source')
    || JSON.stringify([tool.archive.url, tool.archive.root, tool.archive.executable]) !== JSON.stringify(expected)
    || !/^[a-f0-9]{64}$/u.test(tool.archive.sha256)) fail('官方固定归档或工具前置关系不符');
  const patches = tool.upstream_patches ?? [];
  if (!Array.isArray(patches) || tool.id === 'bash' && patches.length !== Number(tool.version.split('.')[2]||0)
    || tool.id !== 'bash' && patches.length) fail('官方源码补丁闭包不符');
  for (const [i, patch] of patches.entries()) {
    if (!plain(patch, ['url', 'sha256']) || !/^[a-f0-9]{64}$/u.test(patch.sha256)
      || patch.url !== 'https://ftp.gnu.org/gnu/bash/bash-'+tool.version.split('.').slice(0,2).join('.')+'-patches/bash'+tool.version.split('.').slice(0,2).join('')+'-' + String(i + 1).padStart(3, '0')) fail('官方Bash补丁顺序或坐标不符');
  }
  const dependencies = tool.dependencies ?? [];
  if (!Array.isArray(dependencies) || new Set(dependencies.map(entry => entry.name)).size !== dependencies.length) fail('依赖身份重复');
  for (const entry of dependencies) {
    if (tool.id === 'cocoapods') {
      if (!plain(entry, ['name', 'version', 'url', 'sha256']) || entry.name === 'cocoapods'
        || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(entry.name) || !/^\d+(?:\.\d+){1,3}$/u.test(entry.version)
        || entry.url !== 'https://rubygems.org/downloads/' + entry.name + '-' + entry.version + '.gem') fail('CocoaPods依赖必须是固定官方Gem');
    } else if (tool.id === 'ruby') {
      if (!plain(entry, ['name', 'version', 'url', 'sha256', 'root']) || entry.name !== 'libyaml'
        || entry.url !== 'https://pyyaml.org/download/libyaml/yaml-' + entry.version + '.tar.gz'
        || entry.root !== 'yaml-' + entry.version) fail('Ruby YAML依赖来源不符');
    } else if (tool.id === 'python') {
      if (!plain(entry, ['name', 'version', 'url', 'sha256', 'root']) || entry.name !== 'xz'
        || !/^\d+\.\d+\.\d+$/u.test(entry.version)
        || entry.url !== 'https://github.com/tukaani-project/xz/releases/download/v'+entry.version+'/xz-'+entry.version+'.tar.xz'
        || entry.root !== 'xz-'+entry.version) fail('Python LZMA依赖来源不符');
    } else fail('该工具没有独立外部源码依赖');
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) fail('源码依赖摘要缺失');
  }
  if (['ruby', 'python'].includes(tool.id) && dependencies.length !== 1
    || tool.id === 'cocoapods' && (!dependencies.length
      || !dependencies.some(entry => entry.name === 'cocoapods-core' && entry.version === tool.version))) {
    fail('工具运行依赖闭包不完整');
  }
  return true;
}

// Perl实际安装目录只来自本轮官方Configure输出，不猜版本目录或架构名称。
function perlRuntimeLibraries(config, finalPayload, payload) {
  const paths=['installprivlib','installarchlib'].map(name=>{
    const values=[...config.matchAll(new RegExp('^'+name+"='([^']*)'$",'gm'))];
    const value=values.length===1?values[0][1]:null;
    if(!value || !value.startsWith(finalPayload+'/') || value!==resolve(value)
      || /[\x00-\x1f]/u.test(value)) fail('Perl官方安装目录声明无效：'+name);
    return join(payload,relative(finalPayload,value));
  });
  if(new Set(paths).size!==2) fail('Perl普通与架构运行库必须准确隔离');
  return paths;
}

async function directory(path) {
  if (!isAbsolute(path) || path !== resolve(path) || await realpath(path) !== path
    || !(await lstat(path)).isDirectory()) fail('候选目录必须是规范真实目录');
}
async function regular(path, executable = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !info.size
    || await realpath(path) !== path || executable && !(info.mode & 0o111)) fail('输入或输出必须是准确普通文件');
}

// 只有此工具对象的候选目录可写；最终前缀固定到已登记摘要，DESTDIR收集后才原子发布。
async function buildSourceTool({ library, tool, source, archive, pending, payload,
  finalPayload, signal, fetcher, exec, verify, apple, bootstrap = false, environment = process.env,
  prepare = prepareSourceDependencies, download = downloadTool }) {
  validateSourceTool(tool);
  const expected = library.pending;
  if (pending !== expected || payload !== join(pending, 'payload')
    || finalPayload !== library.finalPayload
    || archive !== join(pending, 'archive')
    || source !== (tool.archive.kind === 'gem' ? archive : join(pending, 'unpack', tool.archive.root))) fail('候选对象身份不符');
  await directory(pending); await regular(archive);
  if (hash(await readFile(archive)) !== tool.archive.sha256) fail('完整官方归档摘要不符');
  if (tool.archive.kind !== 'gem') await directory(source);
  const installed = {};
  for (const id of tool.requires) {
    const registered = library.tools.find(entry => entry.id === id);
    const result = registered && await verify(library, registered);
    if (!result) fail('缺少已验真前置工具：' + id);
    installed[id] = result.path;
  }
  const foundation = await controlledPosixTools(library, verify, { bootstrap, id: tool.id });
  const selected = await apple(library, { names: ['clang', 'clang++', 'ar', 'make', 'ld', 'nm', 'ranlib', 'strip', 'xcrun', 'otool', 'install_name_tool', 'codesign'], signal });
  const sdkResult = await exec(selected.tools.xcrun, ['--sdk', 'macosx', '--show-sdk-path'], {
    env: { PATH: '', DEVELOPER_DIR: selected.developerDirectory }, signal, timeout: 60_000,
  });
  // xcrun返回包内官方SDK链接；固定到同一包内真实目标，不接纳包外SDK。
  const sdkInput = sdkResult.stdout.trim();
  if (!isAbsolute(sdkInput) || sdkInput !== resolve(sdkInput)) fail('SDK返回路径无效');
  const sdk = await realpath(sdkInput); await directory(sdk);
  if (!sdk.startsWith(selected.developerDirectory + '/')) fail('SDK不属于同一Xcode');
  const work = join(pending, 'probe'), stage = join(work, 'stage');
  await mkdir(work); await mkdir(stage);
  const env = { ...environment, HOME: work, TMPDIR: work, DEVELOPER_DIR: selected.developerDirectory,
    SDKROOT: sdk, MACOSX_DEPLOYMENT_TARGET: library.tools.find(entry=>entry.id==='posix').version,
    PATH: [...new Set([...Object.values(installed).map(dirname), foundation.path,
      dirname(selected.tools.clang), dirname(selected.tools.make)])].join(':'),
    // Clang自带汇编器，避免调用带系统解释器shebang的Xcode as脚本。
    CC: selected.tools.clang, CXX: selected.tools['clang++'], AR: selected.tools.ar,
    CPP: selected.tools.clang + ' -E', LD: selected.tools.ld, AS: selected.tools.clang,
    NM: selected.tools.nm, RANLIB: selected.tools.ranlib, STRIP: selected.tools.strip,
    MAKE: selected.tools.make, PERL: installed.perl ?? '', PYTHON: installed.python ?? '',
    RUBY: installed.ruby ?? '', MAKEINFO: 'true', HELP2MAN: 'true', M4: installed.m4 ?? 'false', BISON: installed.bison ?? 'false',
    YACC: installed.bison ? installed.bison + ' -y' : 'false', FLEX: installed.flex ?? 'false',
    // 官方AC_PROG_LEX用冒号表示未安装Lex，false会误入必须生成扫描器的探测。
    LEX: installed.flex ?? ':', COCOAPODS_DISABLE_STATS: 'true',
  };
  for (const key of Object.keys(env)) if (key.startsWith('DYLD_') || ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE',
    'PYTHONHOME', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB', 'GEM_HOME', 'GEM_PATH', 'PERL5OPT', 'PERL5LIB',
    'ARCHFLAGS', 'ARCH', 'CC_FOR_BUILD', 'CXX_FOR_BUILD', 'CROSS_COMPILE', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'CPATH', 'LIBRARY_PATH', 'PKG_CONFIG_PATH', 'CONFIG_SITE', 'GNUMAKEFLAGS', 'MAKEFLAGS', 'MFLAGS',
    'DESTDIR', 'LD_RUN_PATH', 'CMAKE_TOOLCHAIN_FILE', 'npm_execpath', 'npm_node_execpath', 'NVM_BIN', 'NVM_DIR'].includes(key)) delete env[key];
  // 已验真SDK通过SDKROOT传给Clang，避免Configure把嵌入引号当作路径字节。
  env.CFLAGS = '-O2';
  env.CXXFLAGS = env.CFLAGS;
  env.LDFLAGS = '-Wl,-headerpad_max_install_names';
  env.ARCHFLAGS = '-arch arm64';
  env.SHELL = foundation.tools.sh;
  env.CONFIG_SHELL = foundation.tools.sh;
  env.M4PATH = '';
  env.BISON_PKGDATADIR = installed.bison ? join(dirname(dirname(installed.bison)), 'share/bison') : '';
  env.PKG_CONFIG = 'false';
  env.PKG_CONFIG_LIBDIR = '';
  env.CONFIG_SITE = '';
  const run = (command, args, cwd = tool.id === 'tcl' ? join(source, 'unix') : source, extra = {}) => exec(command, args, {
    cwd, env: { ...env, ...extra }, signal, timeout: 3_600_000, maxBuffer: 8 * 1024 * 1024,
  });
  const originals = await prepare({ library, tool, pending, environment: env, signal, fetcher });
  const upstream = [];
  for (const [i, patch] of (tool.upstream_patches ?? []).entries()) {
    const file = join(pending, 'bash53-' + String(i + 1).padStart(3, '0'));

    await download(patch, file, { fetcher, signal });
    await regular(file);
    if (hash(await readFile(file)) !== patch.sha256) fail('Bash官方补丁原件摘要不符');
    await run(foundation.tools.patch, ['--batch', '--forward', '--fuzz=0', '-p0', '-i', file]);
    upstream.push(file);
  }
  if (tool.id === 'cocoapods') {
    await mkdir(payload); await mkdir(join(payload, 'bin'));
    const manifest = join(work, 'gems.json');
    await writeFile(manifest, JSON.stringify([{ name: 'cocoapods', version: tool.version, file: archive },
      ...tool.dependencies.map(entry => ({ name: entry.name, version: entry.version, file: originals.get(entry.name) }))]), { flag: 'wx' });
    // Ruby读取验真Gem内的真实spec并核对整个运行闭包；无在线解析、系统Gem或忽略版本要求。
    const code = [
      "require 'rubygems'; require 'rubygems/package'; require 'rubygems/installer'; require 'json'; require 'fileutils'",
      "entries = JSON.parse(File.read(ARGV.fetch(0))); home = ARGV.fetch(1)",
      "specs = entries.to_h { |e| s = Gem::Package.new(e.fetch('file')).spec; raise 'Gem identity' unless s.name == e.fetch('name') && s.version.to_s == e.fetch('version') && s.platform == Gem::Platform::RUBY; raise 'Ruby requirement' unless s.required_ruby_version.satisfied_by?(Gem::Version.new(RUBY_VERSION)); [s.name, s] }",
      "specs.each_value { |s| s.runtime_dependencies.each { |d| v = specs[d.name]; raise 'Gem closure' unless v && d.requirement.satisfied_by?(v.version) } }",
      "Gem.use_paths(home, [home]); RbConfig::CONFIG['CC'] = ENV.fetch('CC'); RbConfig::CONFIG['CXX'] = ENV.fetch('CXX'); RbConfig::CONFIG['AR'] = ENV.fetch('AR'); RbConfig::CONFIG['MAKE'] = ENV.fetch('MAKE')",
      "entries.each { |e| Gem::Installer.at(e.fetch('file'), install_dir: home, ignore_dependencies: true, wrappers: false, env_shebang: false, document: [], build_args: ['--disable-system-libffi']).install }",
      // 显式install_dir不更新本进程规格缓存；离线安装后刷新，再逐包回读准确版本。
      "Gem::Specification.reset",
      // 只保留Gem原始脚本与唯一pod包装入口，清除换位后会断开的自动命令链接。
      "specs.each_value { |s| raise 'Gem installed version' unless Gem::Specification.find_by_name(s.name, s.version).version == s.version }; FileUtils.rm_rf(File.join(home, 'cache')); FileUtils.rm_rf(File.join(home, 'bin'))",
    ].join('\n');
    await run(installed.ruby, ['--disable-gems', '-e', code, manifest, join(payload, 'gems')], work,
      { GEM_HOME: join(payload, 'gems'), GEM_PATH: join(payload, 'gems') });
    // 只开放当前CocoaPods与同一受控Ruby自带Gem；不继承外部或用户Gem路径。
    const program = "ENV['GEM_HOME'] = File.expand_path('../gems', File.dirname(ARGV.shift)); ENV['GEM_PATH'] = ENV['GEM_HOME']; ENV['COCOAPODS_DISABLE_STATS'] = 'true'; require 'rubygems'; ENV['GEM_PATH'] = [ENV['GEM_HOME'], Gem.default_dir].join(File::PATH_SEPARATOR); Gem.clear_paths; require 'logger'; load Gem.bin_path('cocoapods', 'pod', " + JSON.stringify(tool.version) + ")";
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    // 运行入口固定安装时已验真的工具路径，确保Git可用并排除调用方PATH。
    const wrapper = '#!' + foundation.tools.sh + '\nunset RUBYOPT RUBYLIB GEM_HOME GEM_PATH DYLD_LIBRARY_PATH DYLD_INSERT_LIBRARIES\n'
      + 'PATH=' + quote(env.PATH) + '\n'
      + 'exec ' + quote(installed.ruby) + ' --disable-gems -e ' + quote(program) + ' "$0" "$@"\n';
    await writeFile(join(payload, 'bin/pod'), wrapper, { flag: 'wx', mode: 0o555 });
  } else {
    let flags = ['--prefix=' + finalPayload];
    if (tool.id === 'ruby') {
      const yaml = join(work, 'yaml'); await mkdir(yaml);
      await run(foundation.tools.tar, ['-xkf', originals.get('libyaml'), '--no-same-owner', '-C', yaml], work);
      const root = join(yaml, tool.dependencies[0].root); await directory(root);
      const prefix = join(work, 'libyaml');
      await run(foundation.tools.sh, [join(root, 'configure'), '--prefix=' + prefix, '--disable-shared'], root);
      await run(selected.tools.make, ['-j8', 'SHELL=' + foundation.tools.sh], root);
      await run(selected.tools.make, ['install', 'SHELL=' + foundation.tools.sh], root);
      flags.push('--with-baseruby=no', '--with-libyaml-dir=' + prefix,
        '--with-openssl-dir=' + dirname(dirname(installed.openssl)), '--disable-install-doc');
    }
    if (tool.id === 'python') {
      // Xcode SDK不提供lzma头文件；仅编译已锁官方liblzma静态库，不借用户或系统缓存。
      const archiveDirectory = join(work, 'xz'); await mkdir(archiveDirectory);
      await run(foundation.tools.tar, ['-xkf', originals.get('xz'), '--no-same-owner', '-C', archiveDirectory], work);
      const root = join(archiveDirectory, tool.dependencies[0].root); await directory(root);
      const prefix = join(work, 'liblzma');
      await run(foundation.tools.sh, [join(root, 'configure'), '--prefix=' + prefix,
        '--disable-shared', '--enable-static', '--with-pic', '--disable-xz', '--disable-xzdec',
        '--disable-lzmadec', '--disable-lzmainfo', '--disable-scripts', '--disable-doc', '--disable-nls'], root);
      await run(selected.tools.make, ['-j8', 'SHELL=' + foundation.tools.sh], root);
      await run(selected.tools.make, ['install', 'SHELL=' + foundation.tools.sh], root);
      await regular(join(prefix, 'include/lzma.h')); await regular(join(prefix, 'lib/liblzma.a'));
      // Python官方configure支持这两个边界变量；静态链接不携带候选运行库路径。
      env.LIBLZMA_CFLAGS = '-I' + join(prefix, 'include');
      env.LIBLZMA_LIBS = join(prefix, 'lib/liblzma.a');
    }
    if (['bison', 'flex', 'bash', 'grep', 'sed'].includes(tool.id)) flags.push('--disable-nls');
    if (tool.id === 'bash') flags.push('--without-bash-malloc');
    if (tool.id === 'grep') flags.push('--disable-perl-regexp');
    // libfl的yylex由消费者扫描器提供；macOS交付静态库，避免共享库链接未定义符号。
    if (tool.id === 'flex') flags.push('--disable-shared');
    if (tool.id === 'gettext') flags.push('--disable-shared', '--disable-java', '--disable-csharp', '--without-emacs');
    if (tool.id === 'tcl') flags.push('--enable-threads', '--enable-shared');
    if (tool.id === 'python') flags.push('--with-openssl=' + dirname(dirname(installed.openssl)), '--with-openssl-rpath=auto');
    if (tool.id === 'perl') {
      await run(foundation.tools.sh, [join(source, 'Configure'), '-des', '-Dprefix=' + finalPayload,
        '-Dcc=' + selected.tools.clang, '-Dld=' + selected.tools.clang, '-Dar=' + selected.tools.ar,
        '-Duseshrplib', '-Dinstallusrbinperl=n', '-Dccflags=' + env.CFLAGS,
        '-Dldflags=' + env.LDFLAGS, '-Dman1dir=none', '-Dman3dir=none']);
    } else if (tool.id === 'openssl') {
      await run(installed.perl, [join(source, 'Configure'), 'darwin64-arm64-cc', '--prefix=' + finalPayload,
        '--openssldir=/private/etc/ssl', 'no-shared']);
    } else if (tool.id !== 'git') await run(foundation.tools.sh, [join(tool.id === 'tcl' ? join(source, 'unix') : source, 'configure'), ...flags]);
    let curlLibrary;
    if (tool.id === 'git') {
      // 官方Makefile允许显式交付CURL输入；固定同一Xcode SDK，不执行未登记curl-config。
      await regular(join(sdk, 'usr/include/curl/curl.h'));
      // Apple SDK的libcurl.tbd是官方链接；只接受同一SDK目录内的真实普通目标。
      curlLibrary = await realpath(join(sdk, 'usr/lib/libcurl.tbd'));
      if (!curlLibrary.startsWith(sdk + '/usr/lib/')) fail('CURL链接输入不属于同一SDK');
      await regular(curlLibrary);
    }
    const makeArgs = tool.id === 'git' ? ['prefix=' + finalPayload,
      'CURL_CFLAGS=-I' + join(sdk, 'usr/include'), 'CURL_LDFLAGS=' + curlLibrary,
      'NO_FINK=YesPlease', 'NO_DARWIN_PORTS=YesPlease', 'NO_HOMEBREW=YesPlease',
      'GETTEXT_PATH=' + join(dirname(installed.gettext), 'gettext'), 'CPPFLAGS=-I' + dirname(dirname(installed.gettext)) + '/include',
      'LDFLAGS=' + env.LDFLAGS + ' -L' + dirname(dirname(installed.gettext)) + '/lib', 'NO_TCLTK=YesPlease', 'PERL_PATH=' + installed.perl, 'PYTHON_PATH=' + installed.python,
      'CC=' + selected.tools.clang, 'AR=' + selected.tools.ar, 'SHELL_PATH=' + foundation.tools.sh, 'SHELL=' + foundation.tools.sh] : ['SHELL=' + foundation.tools.sh];
    await run(selected.tools.make, ['-j8', ...makeArgs]);
    await run(selected.tools.make, ['DESTDIR=' + stage, ...makeArgs,
      tool.id === 'openssl' ? 'install_sw' : 'install']);
    const staged = join(stage, finalPayload.slice(1)); await directory(staged);
    await rename(staged, payload);
  }
  await regular(join(payload, tool.archive.executable), true);
  if (tool.id === 'grep') for (const name of ['egrep', 'fgrep']) {
    const alias = join(payload, 'bin', name);
    const info = await lstat(alias).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
    if (info) {if (!info.isFile() || info.isSymbolicLink()) fail('上游grep别名不是普通脚本');await rm(alias);}
  }
  if (tool.id === 'bash') {
    // sh是同一个Bash产物的准确普通副本，版本与回执同属唯一工具对象。
    await writeFile(join(payload, 'bin/sh'), await readFile(join(payload, 'bin/bash')), { flag: 'wx', mode: 0o555 });
  }
  if (tool.archive.kind === 'native-source') {
    const walk = async path => {
      const result = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) result.push(...await walk(file));
        else if (entry.isFile()) result.push(file);
        else if (!entry.isSymbolicLink()) fail('工具输出包含特殊文件');
      }
      return result;
    };
    const binaries = [];
    for (const file of await walk(payload)) {
      const bytes = await readFile(file);
      if (bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf) {
        if (bytes.readUInt32LE(4) !== 0x0100000c) fail('源码工具Mach-O架构不是ARM64');
        binaries.push(file);
      }
    }
    if (!binaries.includes(join(payload, tool.archive.executable))) fail('编译没有生成ARM64工具入口');
    const relocated = new Set();
    for (const file of binaries) {
      const identity = await lstat(file), key = identity.dev + ':' + identity.ino;
      if (relocated.has(key)) continue;
      relocated.add(key);
      const listing = await run(selected.tools.otool, ['-L', file], work);
      let ownRuntime = false;
      for (const line of listing.stdout.split('\n').slice(1)) {
        const dependency = line.trim().split(' (')[0];
        if (!dependency) continue;
        if (dependency.startsWith(finalPayload + '/')) {
          ownRuntime = true;
          await run(selected.tools.install_name_tool, ['-change', dependency,
            '@rpath/' + relative(finalPayload, dependency), file], work);
        } else if (isAbsolute(dependency) && !dependency.startsWith('/usr/lib/')
          && !dependency.startsWith('/System/Library/')
          && !Object.values(installed).some(path => dependency.startsWith(dirname(dirname(path)) + '/'))) {
          fail('工具链接到未验真的外部库');
        }
      }
      // 相对工具对象根定位同一候选与最终对象，避免Perl共享库在原子发布前指向不存在的前缀。
      const loader = '@loader_path' + (relative(dirname(file), payload) ? '/' + relative(dirname(file), payload) : '');
      // 仅链接同对象运行库的入口需要新rpath；系统库模块不能平白扩大Mach-O加载命令。
      if (ownRuntime) await run(selected.tools.install_name_tool, ['-add_rpath', loader, file], work);
      if (file.endsWith('.dylib')) await run(selected.tools.install_name_tool, ['-id',
        '@rpath/' + relative(payload, file), file], work);
      await run(selected.tools.codesign, ['--force', '--sign', '-', '--timestamp=none', file], work);
    }
  }

  // 入口版本不能代替运行闭包验收；解释器必须在原子发布前真实加载所需核心与加密模块。
  const executable = join(payload, tool.archive.executable);
  const probe = async (args, extra = {}) => {
    const result = await run(executable, args, work, extra);
    if (result.stdout.trim() !== 'controlled-' + tool.id + '-ok') fail('解释器真实模块探测未返回准确结果');
  };
  if (tool.id === 'python') {
    await probe(['-I', '-c', 'import ssl,zlib,bz2,lzma,sqlite3,ctypes,json; '
      + 'assert ssl.create_default_context().verify_mode == ssl.CERT_REQUIRED; '
      + 'assert ssl.OPENSSL_VERSION.startswith('+JSON.stringify('OpenSSL '+library.tools.find(value=>value.id==='openssl').version+' ')+'); print("controlled-python-ok")'],
    { PYTHONHOME: payload });
  } else if (tool.id === 'perl') {
    const cores=perlRuntimeLibraries(await readFile(join(source,'config.sh'),'utf8'),finalPayload,payload);
    for(const path of cores) await directory(path);
    await regular(join(cores[1],'Config.pm'));
    await probe(['-MConfig', '-MJSON::PP', '-MEncode', '-MFile::Find', '-e',
      'die "Perl version" unless "$^V" eq '+JSON.stringify('v'+tool.version)+'; print "controlled-perl-ok\\n"'],
      {PERL5LIB:cores.join(':')});
  } else if (tool.id === 'ruby') {
    const versions=(await readdir(join(payload,'lib/ruby'))).filter(value=>/^\d+\.\d+\.\d+$/u.test(value));
    if(versions.length!==1)fail('Ruby核心模块版本目录缺失或不唯一');
    const base=join(payload,'lib/ruby',versions[0]); await directory(base);
    const cores=[base];
    for(const entry of await readdir(base,{withFileTypes:true})) {
      if(!entry.isDirectory()) continue;
      const marker=join(base,entry.name,'rbconfig.rb');
      try {await regular(marker);cores.push(join(base,entry.name));}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
    if(cores.length!==2) fail('Ruby ARM64核心模块目录缺失或不唯一');
    await probe(['--disable-gems', '-rrubygems', '-rpsych', '-ropenssl', '-rjson', '-e',
      'raise "Ruby version" unless RUBY_VERSION == '+JSON.stringify(tool.version)+'; '
      + 'raise "OpenSSL version" unless OpenSSL::OPENSSL_VERSION.start_with?('+JSON.stringify('OpenSSL '+library.tools.find(value=>value.id==='openssl').version+' ')+'); '
      + 'raise "libyaml missing" if Psych.libyaml_version.empty?; puts "controlled-ruby-ok"'],
      {RUBYLIB:cores.join(':'),GEM_HOME:join(payload,'lib/ruby/gems',versions[0]),GEM_PATH:join(payload,'lib/ruby/gems',versions[0])});
  }
  // 保留官方法律全文与原始源码归档；产品需要解释器运行库时可连同其原始许可一起打包。
  if (tool.archive.kind === 'native-source') {
    const legalNames = (await readdir(source)).filter(name => /^(?:COPYING|LICENSE|LICENCE|NOTICE|Artistic|COPYRIGHT|BSDL|GPL|LEGAL)(?:[._-].*)?$/iu.test(name));
    if (!legalNames.length) fail('官方工具源码缺少根许可全文');
    const directory = join(payload, 'licenses'); await mkdir(directory);
    for (const name of legalNames) {
      const file = join(source, name);
      if ((await lstat(file)).isFile()) await writeFile(join(directory, name), await readFile(file), { flag: 'wx', mode: 0o444 });
    }
    if (!(await readdir(directory)).length) fail('工具根许可必须包含真实法律文件');
  }

  if (tool.id === 'tcl') await writeFile(join(payload, 'version.tcl'), 'puts [info patchlevel]\n', { flag: 'wx', mode: 0o444 });
  // 原件与编译输入回执留在唯一工具对象；运行依赖原件仍归rely，不保留第二份Gem缓存。
  await writeFile(join(payload, tool.archive.kind === 'gem' ? 'source.gem' : 'source.archive'),
    await readFile(archive), { flag: 'wx', mode: 0o444 });
  if (upstream.length) {
    const directory = join(payload, 'upstream-patches'); await mkdir(directory);
    for (const [i, file] of upstream.entries()) await writeFile(join(directory, 'bash53-' + String(i + 1).padStart(3, '0')),
      await readFile(file), { flag: 'wx', mode: 0o444 });
    // 原件只保留在回执覆盖的payload内，清除同一安装事务产生的临时重复文件。
    for (const [i, file] of upstream.entries()) {
      await rm(file);
    }
  }
  }
return {buildSourceTool,validateSourceTool};})();
const flutterRecipe=(()=>{

const execute = exec;

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error('Flutter受控修订：' + message); };
const safePath = value => typeof value === 'string' && value.length > 0 && !isAbsolute(value)
  && !/[\\\x00-\x1f]/u.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

// 产品资源阶段先验真共享工具并取得任务目录；这里只生成该任务的配置，不改共享SDK。
async function prepareFlutterTaskTools(root, work, platform, { signal, environment = {} } = {}) {
  signal?.throwIfAborted();
  if (!['android', 'ios', 'macos', 'sdk'].includes(platform)) return {};
  if (await realpath(root) !== root || await realpath(work) !== work
    || work === root || work.startsWith(root + '/') || root.startsWith(work + '/')) fail('工具任务目录不安全');
  const directory = join(work, 'flutter-tools');
  const prepareJava = async () => {
    if (!environment.JAVA_HOME) return {};
    if (!isAbsolute(environment.JAVA_HOME) || /[\r\n\x00]/u.test(environment.JAVA_HOME)) fail('受控Java路径无效');
    // Flutter的jdk-dir优先于Android Studio；配置仅写入当前任务HOME，不影响用户设置。
    await writeFile(join(work, '.flutter_settings'), JSON.stringify({ 'jdk-dir': environment.JAVA_HOME }), { flag: 'wx', mode: 0o600 });
    return { HOME: work };
  };
  if (platform === 'sdk') return prepareJava();
  if (platform !== 'android') {
    signal?.throwIfAborted();
    await mkdir(directory);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    // 使用验真rsync，额外处理其未落实的副本权限；入口不覆盖或替换系统工具。
    await writeFile(join(directory, 'rsync'), '#!'+environment.PRODUCT_BASH_BIN+'\n'
      // 验真rsync的本机接收端会经PATH再次调用rsync；协议端必须继承原始stdio，不能进入Node缓冲执行。
      + 'if [ "${1:-}" = "--server" ]; then exec '+quote(environment.PRODUCT_RSYNC_BIN)+' "$@"; fi\n'
      + 'exec ' + quote(process.execPath) + ' '
      + quote(fileURLToPath(import.meta.url)) + ' rsync "$@"\n', { flag: 'wx', mode: 0o700 });
    signal?.throwIfAborted();
    return { ...await prepareJava(), PATH: directory };
  }
  const gradleHome = environment.GRADLE_HOME;
  if (!gradleHome || !isAbsolute(gradleHome) || /[\r\n\x00]/u.test(gradleHome)) fail('Android任务缺少产品资源阶段受控Gradle');
  if (!environment.JAVA_HOME || !isAbsolute(environment.JAVA_HOME) || /[\r\n\x00]/u.test(environment.JAVA_HOME)) fail('Android任务缺少产品资源阶段受控Java');
  // 先校验唯一配置再生成插件目录；链接、双配置与错误入口都不得留下半成品。
  const candidates = [];
  for (const name of ['settings.gradle.kts', 'settings.gradle']) {
    const path = join(work, 'android', name);
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info) candidates.push({ path, info });
  }
  if (candidates.length !== 1) fail('Android任务必须只有一份settings配置');
  const { path: settings, info } = candidates[0];
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || await realpath(settings) !== settings) fail('Android任务配置不是独占普通文件');
  const handle = await open(settings, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) fail('Android任务配置已被替换');
    const input = await handle.readFile('utf8');
    const pattern = /includeBuild\((["'])\$flutterSdkPath\/packages\/flutter_tools\/gradle\1\)/gu;
    if ([...input.matchAll(pattern)].length !== 1) fail('Android配置缺少唯一Flutter插件入口');
    signal?.throwIfAborted();
    const target = await prepareGradle(root, work, { signal });
    const current = await lstat(settings);
    if (await realpath(settings) !== settings || current.dev !== info.dev || current.ino !== info.ino
      || current.nlink !== 1 || await readFile(settings, 'utf8') !== input) fail('Android任务配置已被替换或修改');
    signal?.throwIfAborted();
    // 使用已核对的文件描述符写入，不能重新打开后来替换的路径。
    const content = Buffer.from(input.replace(pattern, 'includeBuild(' + JSON.stringify(target) + ')'));
    let offset = 0;
    while (offset < content.length) {
      const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
      if (!bytesWritten) fail('Android任务配置写入未完成');
      offset += bytesWritten;
    }
    await handle.truncate(content.length);
    signal?.throwIfAborted();
  } finally { await handle.close(); }
  // Flutter固定调用工程gradlew；仅替换本任务的入口链接，不触碰源工程或共享SDK。
  const wrapper = join(work, 'android/gradlew');
  const existing = await lstat(wrapper).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && !existing.isSymbolicLink() && (!existing.isFile() || existing.nlink !== 1)) fail('Gradle任务入口不是独占文件');
  signal?.throwIfAborted();
  if (existing) {
    const current = await lstat(wrapper);
    if (current.dev !== existing.dev || current.ino !== existing.ino) fail('Gradle任务入口已被替换');
    await rm(wrapper);
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(wrapper, '#!'+environment.PRODUCT_BASH_BIN+'\n# 只执行本产品验真的工具，不下载Wrapper分发。\nexport JAVA_HOME='
    + quote(environment.JAVA_HOME) + '\nexec '
    + quote(join(gradleHome, 'bin/gradle')) + ' "$@"\n', { flag: 'wx', mode: 0o700 });
  signal?.throwIfAborted();
  return prepareJava();
}

// 只修正受控SDK复制到本任务的framework/dSYM；不跟随链接chmod共享原件。
async function copyFlutterArtifact(args, environment = process.env, run = execute) {
  const root = environment.FLUTTER_ROOT, work = environment.PRODUCT_WORK_DIR;
  if (!root || !work || await realpath(root) !== root || await realpath(work) !== work
    || work === root || work.startsWith(root + '/') || root.startsWith(work + '/')) fail('引擎复制缺少安全任务目录');
  const source = args.at(-2), destination = args.at(-1);
  let copied;
  if (source && isAbsolute(source) && source.startsWith(root + '/')
    && /\.(?:framework|dSYM)\/?$/u.test(source)) {
    const output = resolve(destination || '.');
    if (!output.startsWith(work + '/') || await realpath(output) !== output) fail('引擎副本不属于当前任务');
    if (!safePath(relative(root, await realpath(source)))) fail('引擎原件越界');
    copied = source.endsWith('/') ? output : join(output, source.split('/').at(-1));
    const existing = await lstat(copied).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing?.isSymbolicLink()) fail('引擎目标不能是符号链接');
    // 复用目标可能含硬链接，必须在rsync写入前拒绝，不能等复制后才保护原件。
    const inspect = async path => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (await realpath(path) !== path || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) fail('引擎目标不是独占生成物');
      if (info.isDirectory()) for (const name of await readdir(path)) await inspect(join(path, name));
    };
    if (existing) await inspect(copied);
    if (args.some(value => ['--inplace', '--keep-dirlinks', '--copy-dirlinks', '--copy-links', '-K', '-k', '-L'].includes(value))) fail('引擎复制禁止跟随目标链接');
  }
  if(!environment.PRODUCT_RSYNC_BIN||!environment.PRODUCT_BASH_BIN)fail('缺少验真同步和Shell入口');
  const result = await run(environment.PRODUCT_RSYNC_BIN, args, { env: environment, maxBuffer: 8 * 1024 * 1024 });
  if (copied) {
    const writable = async path => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        if (path === copied) fail('引擎目标已被替换为链接');
        return;
      }
      if (await realpath(path) !== path || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) fail('引擎副本不是独占生成物');
      // 持有无跟随描述符并核对inode，chmod不重新打开可能已被替换的路径。
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (current.dev !== info.dev || current.ino !== info.ino || await realpath(path) !== path) fail('引擎副本路径已被替换');
        await handle.chmod((current.mode & 0o777) | 0o200);
      } finally { await handle.close(); }
      if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
    };
    await writable(copied);
  }
  return result;
}

function verifyFlutterVersion(actual, tool) {
  if (actual?.frameworkVersion !== tool.version || actual?.frameworkRevision !== tool.patch.source.split('/').at(-1)) fail('实际Flutter版本不符或官方提交不符');
}

// 调用方先验真SDK并占有本端工作目录；这里只生成Gradle配置，不复制SDK或业务源码。
async function prepareGradle(root, work, { signal } = {}) {
  signal?.throwIfAborted();
  if (!isAbsolute(root) || !isAbsolute(work) || await realpath(root) !== root || await realpath(work) !== work
    || work === root || work.startsWith(root + '/') || root.startsWith(work + '/')) fail('Gradle工作目录必须独立于SDK原件');
  const sdk = join(root, 'packages/flutter_tools/gradle');
  const source = join(sdk, 'src');
  if (await realpath(source) !== source || !(await lstat(source)).isDirectory()) fail('Gradle源码必须位于SDK原件内');
  const files = [];
  for (const name of ['settings.gradle.kts', 'build.gradle.kts']) {
    const path = join(sdk, name), info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024 || await realpath(path) !== path) fail('Gradle配置不是SDK内受限普通文件');
    files.push([name, await readFile(path)]);
  }
  files.push(['gradle.properties', Buffer.from('# Kotlin只在本任务Gradle进程编译，不创建用户目录守护进程状态。\n'
    + 'kotlin.compiler.execution.strategy=in-process\nkotlin.daemon.useFallbackStrategy=false\n')]);
  const directory = join(work, 'flutter-gradle');
  // mkdir排他创建，已有目录不属于本次准备，禁止接管或清理。
  signal?.throwIfAborted();
  await mkdir(directory, { mode: 0o700 });
  const identity = await lstat(directory);
  const assertDirectory = async () => {
    const current = await lstat(directory);
    if (await realpath(directory) !== directory || current.dev !== identity.dev || current.ino !== identity.ino) fail('Gradle配置目录已被替换，保留现场');
  };
  try {
    for (const [name, content] of files) {
      signal?.throwIfAborted();
      await assertDirectory();
      const handle = await open(join(directory, name), 'wx', 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
    await assertDirectory();
    signal?.throwIfAborted();
    await symlink(source, join(directory, 'src'), 'dir');
    signal?.throwIfAborted();
    return directory;
  } catch (error) {
    await assertDirectory();
    await rm(directory, { recursive: true });
    throw error;
  }
}

function flutterEnvironment(root, env) {
  const work = env.PRODUCT_WORK_DIR;
  const result = { ...env, HOME: work, USERPROFILE: work, TMPDIR: work,
    XDG_CONFIG_HOME: join(work, 'config'), XDG_CACHE_HOME: join(work, 'cache'),
    PUB_CACHE: join(root, 'bin/cache/pub'), BOT: 'true', FLUTTER_ROOT: root,
    // 官方开关在AI环境也返回NoOpAnalytics，防止首次提示混入机器JSON。
    FLUTTER_SUPPRESS_ANALYTICS: 'true' };
  for (const name of ['FLUTTER_ALREADY_LOCKED', 'FLUTTER_TOOL_ARGS', 'FLUTTER_HOST', 'PUB_HOSTED_URL', 'FLUTTER_STORAGE_BASE_URL']) delete result[name];
  return result;
}

// Windows直接执行SDK自带Dart与快照，避免Node把批处理文件当作原生可执行文件。
function flutterCommand(root, args, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  if (!['win32', 'darwin', 'linux'].includes(platform)) fail('不支持的Flutter宿主');
  return platform === 'win32'
    ? [path.join(root, 'bin/cache/dart-sdk/bin/dart.exe'),
      [path.join(root, 'bin/cache/flutter_tools.snapshot'), ...args]]
    : [path.join(root, 'bin/flutter'), args];
}

async function checkFlutter(root, tool, env, { signal, run = execute } = {}) {
  const work = env.PRODUCT_WORK_DIR;
  if (!work || await realpath(work) !== work || work === root || work.startsWith(root + sep)) fail('运行状态不能写入SDK原件');
  const environment = flutterEnvironment(root, env);
  const [command, args] = flutterCommand(root, ['--suppress-analytics', '--version', '--machine']);
  const result = await run(command, args, {
    cwd: work, env: environment, signal, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  const actual = JSON.parse(result.stdout);
  verifyFlutterVersion(actual, tool);
}

// 补丁只接受完整基线与结果摘要；行号、上下文任一不符都拒绝，不做模糊匹配。
function parsePatch(text) {
  if (!text) fail('补丁为空');
  if (typeof text !== 'string' || !text.endsWith('\n')) fail('补丁必须完整换行结束');
  const lines = text.split('\n');
  const files = []; let at = 0;
  while (at < lines.length && !lines[at].startsWith('diff --git ')) {
    if (lines[at] && !lines[at].startsWith('#')) fail('补丁头部存在未登记内容');
    at++;
  }
  while (at < lines.length - 1) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(lines[at++]);
    if (!header || header[1] !== header[2] || !safePath(header[1])) fail('补丁文件路径无效');
    const path = header[1];
    if (files.some(file => file.path === path)) fail('补丁文件重复');
    const hashes = /^index ([a-f0-9]{64})\.\.([a-f0-9]{64})$/u.exec(lines[at++]);
    if (!hashes || lines[at++] !== '--- a/' + path || lines[at++] !== '+++ b/' + path) fail('缺少完整文件摘要');
    const hunks = [];
    while (at < lines.length - 1 && !lines[at].startsWith('diff --git ')) {
      const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/u.exec(lines[at++]);
      if (!hunk) fail('补丁区块格式错误');
      const old = [], next = [];
      while (at < lines.length - 1 && /^[ +\-]/u.test(lines[at])) {
        const line = lines[at++];
        if (line[0] !== '+') old.push(line.slice(1));
        if (line[0] !== '-') next.push(line.slice(1));
      }
      if (old.length !== Number(hunk[2]) || next.length !== Number(hunk[4])) fail('补丁区块行数错误');
      hunks.push({ oldLine: Number(hunk[1]), nextLine: Number(hunk[3]), old, next });
    }
    if (!hunks.length) fail('补丁文件没有改动区块');
    files.push({ path, before: hashes[1], after: hashes[2], hunks });
  }
  if (!files.length) fail('补丁为空');
  return files;
}

function transformFile(input, file) {
  if (digest(input) !== file.before) fail('源码基线摘要不符：' + file.path);
  const lines = input.toString('utf8').split('\n');
  if (lines.pop() !== '') fail('源码必须使用末尾换行');
  const result = []; let cursor = 0;
  for (const hunk of file.hunks) {
    const offset = hunk.oldLine === 0 ? 0 : hunk.oldLine - 1;
    if (offset < cursor || offset > lines.length) fail('补丁区块重叠或越界');
    result.push(...lines.slice(cursor, offset));
    if ((hunk.nextLine === 0 ? 0 : hunk.nextLine - 1) !== result.length
      || JSON.stringify(lines.slice(offset, offset + hunk.old.length)) !== JSON.stringify(hunk.old)) fail('补丁上下文不符');
    result.push(...hunk.next); cursor = offset + hunk.old.length;
  }
  result.push(...lines.slice(cursor));
  const output = Buffer.from(result.join('\n') + '\n');
  if (digest(output) !== file.after) fail('修订结果摘要不符：' + file.path);
  return output;
}


// 只在受控安装器独占的候选对象中准备；应用阶段不允许产品重新生成SDK快照。
async function prepareFlutter(root, { tool, files, env, signal, run = execute }) {
  root = resolve(root);
  if (await realpath(root) !== root || !env?.PRODUCT_WORK_DIR) fail('准备环境不完整');
  const work = resolve(env.PRODUCT_WORK_DIR);
  if (await realpath(work) !== work || work === root || work.startsWith(root + sep)) fail('准备状态不能写入SDK原件');
  const cache = join(root, 'bin/cache');
  const version = JSON.parse(await readFile(join(cache, 'flutter.version.json'), 'utf8'));
  if (version.frameworkVersion !== tool.version || version.frameworkRevision !== tool.patch.source.split('/').at(-1)) fail('SDK版本或官方提交不符');
  await applyPatch(root, files);
  await prepareFlutterSnapshot(root, { tool, files, env, signal, run });
}

// 安装候选的所有源码必须达到唯一目标后才重建快照；已安装原件不得原位修订。
async function prepareFlutterSnapshot(root, { tool, files, env, signal, run = execute, offline = false }) {
  root = resolve(root);
  const work = env?.PRODUCT_WORK_DIR && resolve(env.PRODUCT_WORK_DIR);
  if (await realpath(root) !== root || !work || await realpath(work) !== work
    || work === root || work.startsWith(root + sep)) fail('准备状态不能写入SDK原件');
  const cache = join(root, 'bin/cache');
  const version = JSON.parse(await readFile(join(cache, 'flutter.version.json'), 'utf8'));
  if (version.frameworkVersion !== tool.version || version.frameworkRevision !== tool.patch.source.split('/').at(-1)) fail('SDK版本或官方提交不符');
  if (!Array.isArray(files) || !files.length) fail('快照缺少完整修订输入');
  for (const file of files) {
    const path = join(root, file.path);
    if (!safePath(file.path) || !(await lstat(path)).isFile() || await realpath(path) !== path
      || digest(await readFile(path)) !== file.after) fail('快照源码未达到修订结果：' + file.path);
  }
  const tools = join(root, 'packages/flutter_tools');
  const dart = join(cache, 'dart-sdk/bin', process.platform === 'win32' ? 'dart.exe' : 'dart');
  const lock = await readFile(join(tools, 'pubspec.lock'));
  const environment = flutterEnvironment(root, env);
  // 现有验真对象维护使用离线缓存；首次Runner准备仍由正式Pub按锁获取工具依赖。
  await run(dart, ['pub', 'get', '--enforce-lockfile', '--no-precompile', ...(offline ? ['--offline'] : [])], {
    cwd: tools, env: environment, signal, timeout: 600_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (!(await readFile(join(tools, 'pubspec.lock'))).equals(lock)) fail('工具依赖锁文件被改变');
  const configPath = join(tools, '.dart_tool/package_config.json');
  // Pub生成配置后再校验真实位置，不能沿着符号链接改写当前候选之外的文件。
  if (!(await lstat(configPath)).isFile() || await realpath(configPath) !== configPath) fail('Dart包配置不是候选内普通文件');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!Array.isArray(config.packages) || !config.packages.length) fail('Dart包配置不完整');
  // 候选对象最终会原位改名；包地址全部改为对象内部相对地址，不保留准备目录绝对路径。
  for (const item of config.packages) {
    const path = fileURLToPath(new URL(item.rootUri, pathToFileURL(configPath)));
    const canonical = await realpath(path);
    if (!canonical.startsWith(root + sep)) fail('工具依赖指向共享对象之外');
    item.rootUri = relative(dirname(configPath), canonical).split(sep).map(encodeURIComponent).join('/') + '/';
  }
  const handle = await open(configPath, 'w');
  try { await handle.writeFile(JSON.stringify(config)); } finally { await handle.close(); }
  const snapshot = join(cache, 'flutter_tools.snapshot');
  // 旧快照属于尚未发布的当前候选，必须删除后由修订源码重新产生，失败不保留可运行旧工具。
  await rm(snapshot, { force: true });
  await run(dart, ['--snapshot=' + snapshot, '--snapshot-kind=app-jit', '--packages=' + configPath,
    join(tools, 'bin/flutter_tools.dart'), '--version', '--machine'], {
    cwd: work, env: environment, signal, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (!(await lstat(snapshot)).isFile() || !(await lstat(snapshot)).size) fail('修订快照没有生成');
  await checkFlutter(root, tool, environment, { signal, run });
}

async function applyPatch(root, files) {
  root = resolve(root);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail('准备目录不安全');
  const lockPath = join(root, 'flutter.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const prepared = [];
    for (const file of files) {
      if (!safePath(file.path)) fail('源码路径越界');
      const path = join(root, file.path);
      if (!(await lstat(path)).isFile() || await realpath(path) !== path) fail('源码不是准备目录内的普通文件');
      prepared.push({ path, output: transformFile(await readFile(path), file) });
    }
    for (const { path, output } of prepared) {
      const temporary = path + '.pending'; let owned = false;
      try {
        const handle = await open(temporary, 'wx', 0o600); owned = true;
        try { await handle.writeFile(output); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path); owned = false;
      } finally { if (owned) await rm(temporary); }
    }
  } finally { await lock.close(); await rm(lockPath); }
}

return {prepareFlutterTaskTools,copyFlutterArtifact,parsePatch,prepareFlutter,checkFlutter};})();
const appleSystemTools = Object.freeze({
  codesign: '/usr/bin/codesign', security: '/usr/bin/security',
  xcrun: '/usr/bin/xcrun', 'xcode-select': '/usr/bin/xcode-select',
});
const appleBundleTools = new Set([
  'xcodebuild', 'make', 'clang', 'clang++', 'swift', 'swiftc', 'ar', 'ld', 'as', 'nm', 'ranlib', 'strip', 'lipo', 'libtool',
  'otool', 'install_name_tool', 'codesign_allocate', 'devicectl', 'xctrace', 'actool', 'ibtool', 'notarytool', 'llvm-nm',
]);
async function verifyAppleTools(library,{names=['xcodebuild'],signal,run=exec,environment=process.env}={}){
  const wanted=library.tools.find(tool=>tool.id==='xcode');if(!wanted||!Array.isArray(names)||names.some(name=>!appleBundleTools.has(name)&&!Object.hasOwn(appleSystemTools,name)))fail('Apple工具需求无效');
  const supplied=resourceSupplies.getStore();if(supplied)return supplied.acquireApple({...supplyRequirements().apple,names});
  const env=cleanEnvironment(environment),developerDirectory=(await run('/usr/bin/xcode-select',['-p'],{env,signal})).stdout.trim();await directory(developerDirectory);
  const tools={};for(const name of names){const path=appleSystemTools[name]||(name==='xcodebuild'?join(developerDirectory,'usr/bin/xcodebuild'):(await run('/usr/bin/xcrun',['--find',name],{env:{...env,DEVELOPER_DIR:developerDirectory},signal})).stdout.trim());await regular(path);tools[name]=await realpath(path);}
  return {developerDirectory,version:wanted.version,tools};
 }

const toolDefinitions=[{"id":"cmake","title":"CMake","version":"3.31.6","source":"https://cmake.org/download/","command":"cmake","archive":null,"archives":{"macos":{"url":"https://dl.google.com/android/repository/cmake-3.31.6-darwin.zip","sha256":"861a219b872cd0d9aee282b617fe3bd32f83925db3a0d28fd45d0553452e903a","root":"."},"linux-arm":{"url":"https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-linux-aarch64.tar.gz","sha256":"b4cc788d63112b2749b40627e719eb5d3b8ed8f00c36d77189f4019cfe64bc9e","root":"cmake-3.31.6-linux-aarch64"},"linux-amd":{"url":"https://dl.google.com/android/repository/cmake-3.31.6-linux.zip","sha256":"ce136bb4b02580b36e53d9ccfe5275069655e6ef7d46d6fe2fcf88cfdf8fb761","root":"."},"windows":{"url":"https://dl.google.com/android/repository/cmake-3.31.6-windows.zip","sha256":"dd54cc866afbd2cfc46189dd4864cdfb5bf8e2a34ec56e80188da0a138567b5e","root":"."}},"managed":false,"requires":[]},{"id":"git","title":"Git","version":"2.54.0","source":"https://git-scm.com/download/mac","command":"git","archive":{"url":"https://www.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz","sha256":"f689162364c10de79ef89aa8dbf48731eb057e34edbbd20aca510ce0154681a3","root":"git-2.54.0","executable":"bin/git","kind":"native-source"},"managed":true,"requires":["node","xcode","perl","python","gettext"]},{"id":"node","title":"Node.js","version":"25.2.1","source":"https://nodejs.org/dist/v25.2.1/SHASUMS256.txt","command":"node","archives":{"linux-arm":{"url":"https://nodejs.org/dist/v25.2.1/node-v25.2.1-linux-arm64.tar.xz","sha256":"75f910b5234d3ee324ceebcf41e2c3c221c4c2225463a02ecd685b884155e0f6","root":"node-v25.2.1-linux-arm64"},"linux-amd":{"url":"https://nodejs.org/dist/v25.2.1/node-v25.2.1-linux-x64.tar.xz","sha256":"b9f6a97e81c89a9df45526b4f86dafdccaf12b82295f7bf35bdb2b0f5e68744f","root":"node-v25.2.1-linux-x64"},"windows":{"url":"https://nodejs.org/dist/v25.2.1/node-v25.2.1-win-x64.zip","sha256":"f97ba75ead7720652f3925d9cf8661e083a28c6b98ea77acc83903d77a9dd688","root":"node-v25.2.1-win-x64"}},"archive":{"url":"https://nodejs.org/dist/v25.2.1/node-v25.2.1-darwin-arm64.tar.gz","sha256":"be87e21bd235a451fad02c89e5bf7cb17e206e4cd89dd5664f20d19e7dfde6f9","root":"node-v25.2.1-darwin-arm64","executable":"bin/node","kind":"extract"},"managed":true,"requires":[]},{"id":"python","title":"Python","version":"3.14.3","source":"https://www.python.org/downloads/macos/","command":"python3","archive":{"url":"https://www.python.org/ftp/python/3.14.3/Python-3.14.3.tar.xz","sha256":"a97d5549e9ad81fe17159ed02c68774ad5d266c72f8d9a0b5a9c371fe85d902b","root":"Python-3.14.3","executable":"bin/python3.14","kind":"native-source"},"managed":true,"requires":["node","xcode","openssl"],"dependencies":[{"name":"xz","version":"5.8.2","url":"https://github.com/tukaani-project/xz/releases/download/v5.8.2/xz-5.8.2.tar.xz","sha256":"890966ec3f5d5cc151077879e157c0593500a522f413ac50ba26d22a9a145214","root":"xz-5.8.2"}]},{"id":"rust","title":"Rust","version":"1.97.1","source":"https://static.rust-lang.org/dist/channel-rust-1.97.1.toml","command":"rustc","archive":{"url":"https://static.rust-lang.org/dist/2026-07-16/rust-1.97.1-aarch64-apple-darwin.tar.xz","sha256":"c9748cc86107734a2a024069908a895de7caa2d37062fb641eef9f756938ace2","root":"rust-1.97.1-aarch64-apple-darwin","executable":"bin/rustc","kind":"rust"},"components":[{"target":"aarch64-linux-android","url":"https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-aarch64-linux-android.tar.xz","sha256":"d664a49fb80d125d68f779112aa97d2a3f5def5f807a35540aa77fce0b350c4f","root":"rust-std-1.97.1-aarch64-linux-android"},{"target":"aarch64-apple-ios","url":"https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-aarch64-apple-ios.tar.xz","sha256":"1d58e856a295852a419f92445fe6b3db268049eb6222a672d52c52de52f36631","root":"rust-std-1.97.1-aarch64-apple-ios"},{"target":"aarch64-apple-ios-sim","url":"https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-aarch64-apple-ios-sim.tar.xz","sha256":"3deb094abb0f7382aad761b8e1e89cebd68bec0591d39e313330ef709b99f6e4","root":"rust-std-1.97.1-aarch64-apple-ios-sim"},{"target":"aarch64-unknown-linux-gnu","url":"https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-aarch64-unknown-linux-gnu.tar.xz","sha256":"46aed8e63186350004d8ec6afca798811e6530b514352e5a8a26f3dc4939b3be","root":"rust-std-1.97.1-aarch64-unknown-linux-gnu"},{"target":"wasm32-unknown-unknown","url":"https://static.rust-lang.org/dist/2026-07-16/rust-std-1.97.1-wasm32-unknown-unknown.tar.xz","sha256":"fa0edb6e9f34faae5735554d62d50875eded839dc707d0f1c01467a918d8453b","root":"rust-std-1.97.1-wasm32-unknown-unknown"}],"managed":true,"requires":[]},{"id":"flutter","title":"Flutter","version":"3.47.2","source":"https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json","command":"flutter","archive":{"url":"https://storage.googleapis.com/flutter_infra_release/releases/stable/macos/flutter_macos_arm64_3.47.2-stable.zip","sha256":"f456fd6733053d9301828a2e702d6cbec872923126809aa8c48eb0a696d6cc01","root":"flutter","executable":"bin/flutter","kind":"extract"},"patch":{"path":"flutter.patch","sha256":"76ef76ca73b2b00423009bd7ebca62f23026e2c9d411504324d2c8ff64da4657","source":"https://github.com/flutter/flutter/commit/d3b14c876900e553bc736ca19295fc09e3853e8e"},"managed":true,"requires":[]},{"id":"java","title":"Java (Temurin)","version":"17.0.20.1","source":"https://api.adoptium.net/v3/assets/feature_releases/17/ga?architecture=aarch64&image_type=jdk&os=mac","command":"java","archive":{"url":"https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz","sha256":"196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8","root":"jdk-17.0.20.1+1","executable":"Contents/Home/bin/java","kind":"extract"},"managed":true,"requires":[]},{"id":"gradle","title":"Gradle","version":"9.1.0","source":"https://services.gradle.org/distributions/gradle-9.1.0-bin.zip.sha256","command":"gradle","archive":{"url":"https://services.gradle.org/distributions/gradle-9.1.0-bin.zip","sha256":"a17ddd85a26b6a7f5ddb71ff8b05fc5104c0202c6e64782429790c933686c806","root":"gradle-9.1.0","executable":"bin/gradle","kind":"extract"},"managed":true,"requires":["java"]},{"id":"android","title":"Android SDK","version":"37.0.1","source":"https://developer.android.com/studio","command":"adb","archive":null,"managed":false,"requires":[]},{"id":"android-sdk","title":"Android SDK Manager","version":"22.0","source":"https://developer.android.com/tools/sdkmanager","command":"sdkmanager","archive":null,"managed":false,"requires":[]},{"id":"android-ndk","title":"Android NDK","version":"28.2.13676358","source":"https://developer.android.com/ndk/downloads","command":"ndk-build","archive":null,"managed":false,"requires":[]},{"id":"cocoapods","title":"CocoaPods","version":"1.17.0","source":"https://cocoapods.org","command":"pod","archive":{"url":"https://rubygems.org/downloads/cocoapods-1.17.0.gem","sha256":"dacf6f11ac3b00d60e6dd326485b616935230aacf95f385d145db27bfdf284af","root":".","executable":"bin/pod","kind":"gem"},"managed":true,"requires":["node","xcode","ruby","git"],"dependencies":[{"name":"CFPropertyList","version":"3.0.8","url":"https://rubygems.org/downloads/CFPropertyList-3.0.8.gem","sha256":"2c99d0d980536d3d7ab252f7bd59ac8be50fbdd1ff487c98c949bb66bb114261"},{"name":"activesupport","version":"6.1.7.10","url":"https://rubygems.org/downloads/activesupport-6.1.7.10.gem","sha256":"3f8e1f787a7bfbf765959ba509ef70af8293b35cb864078919365a12bf33d470"},{"name":"addressable","version":"2.9.0","url":"https://rubygems.org/downloads/addressable-2.9.0.gem","sha256":"7fdf6ac3660f7f4e867a0838be3f6cf722ace541dd97767fa42bc6cfa980c7af"},{"name":"algoliasearch","version":"1.27.5","url":"https://rubygems.org/downloads/algoliasearch-1.27.5.gem","sha256":"26c1cddf3c2ec4bd60c148389e42702c98fdac862881dc6b07a4c0b89ffec853"},{"name":"atomos","version":"0.1.3","url":"https://rubygems.org/downloads/atomos-0.1.3.gem","sha256":"7d43b22f2454a36bace5532d30785b06de3711399cb1c6bf932573eda536789f"},{"name":"base64","version":"0.3.0","url":"https://rubygems.org/downloads/base64-0.3.0.gem","sha256":"27337aeabad6ffae05c265c450490628ef3ebd4b67be58257393227588f5a97b"},{"name":"claide","version":"1.1.0","url":"https://rubygems.org/downloads/claide-1.1.0.gem","sha256":"6d3c5c089dde904d96aa30e73306d0d4bd444b1accb9b3125ce14a3c0183f82e"},{"name":"cocoapods-core","version":"1.17.0","url":"https://rubygems.org/downloads/cocoapods-core-1.17.0.gem","sha256":"a9e3d0dd36ab1b48935236d77a15cad9171217f13c6010c8e2ae3c0f455daf5b"},{"name":"cocoapods-deintegrate","version":"1.0.5","url":"https://rubygems.org/downloads/cocoapods-deintegrate-1.0.5.gem","sha256":"517c2a448ef563afe99b6e7668704c27f5de9e02715a88ee9de6974dc1b3f6a2"},{"name":"cocoapods-downloader","version":"2.1","url":"https://rubygems.org/downloads/cocoapods-downloader-2.1.gem","sha256":"bb6ebe1b3966dc4055de54f7a28b773485ac724fdf575d9bee2212d235e7b6d1"},{"name":"cocoapods-plugins","version":"1.0.0","url":"https://rubygems.org/downloads/cocoapods-plugins-1.0.0.gem","sha256":"725d17ce90b52f862e73476623fd91441b4430b742d8a071000831efb440ca9a"},{"name":"cocoapods-search","version":"1.0.1","url":"https://rubygems.org/downloads/cocoapods-search-1.0.1.gem","sha256":"1b133b0e6719ed439bd840e84a1828cca46425ab73a11eff5e096c3b2df05589"},{"name":"cocoapods-trunk","version":"1.6.0","url":"https://rubygems.org/downloads/cocoapods-trunk-1.6.0.gem","sha256":"5f5bda8c172afead48fa2d43a718cf534b1313c367ba1194cebdeb9bfee9ed31"},{"name":"cocoapods-try","version":"1.2.0","url":"https://rubygems.org/downloads/cocoapods-try-1.2.0.gem","sha256":"145b946c6e7747ed0301d975165157951153d27469e6b2763c83e25c84b9defe"},{"name":"colored2","version":"3.1.2","url":"https://rubygems.org/downloads/colored2-3.1.2.gem","sha256":"b13c2bd7eeae2cf7356a62501d398e72fde78780bd26aec6a979578293c28b4a"},{"name":"concurrent-ruby","version":"1.3.7","url":"https://rubygems.org/downloads/concurrent-ruby-1.3.7.gem","sha256":"4412caec3a5ea2e5fdc52076724c071a81f2c0593d83b2ac8cbb8ca63b3151b0"},{"name":"ethon","version":"0.18.0","url":"https://rubygems.org/downloads/ethon-0.18.0.gem","sha256":"b598afc9f30448cb068b850714b7d6948e941476095d04f90a4ac65b8d6efcb2"},{"name":"ffi","version":"1.17.4","url":"https://rubygems.org/downloads/ffi-1.17.4.gem","sha256":"bcd1642e06f0d16fc9e09ac6d49c3a7298b9789bcb58127302f934e437d60acf"},{"name":"fourflusher","version":"2.3.1","url":"https://rubygems.org/downloads/fourflusher-2.3.1.gem","sha256":"1b3de61c7c791b6a4e64f31e3719eb25203d151746bb519a0292bff1065ccaa9"},{"name":"fuzzy_match","version":"2.0.4","url":"https://rubygems.org/downloads/fuzzy_match-2.0.4.gem","sha256":"b5de4f95816589c5b5c3ad13770c0af539b75131c158135b3f3bbba75d0cfca5"},{"name":"gh_inspector","version":"1.1.3","url":"https://rubygems.org/downloads/gh_inspector-1.1.3.gem","sha256":"04cca7171b87164e053aa43147971d3b7f500fcb58177698886b48a9fc4a1939"},{"name":"httpclient","version":"2.9.0","url":"https://rubygems.org/downloads/httpclient-2.9.0.gem","sha256":"4b645958e494b2f86c2f8a2f304c959baa273a310e77a2931ddb986d83e498c8"},{"name":"i18n","version":"1.14.8","url":"https://rubygems.org/downloads/i18n-1.14.8.gem","sha256":"285778639134865c5e0f6269e0b818256017e8cde89993fdfcbfb64d088824a5"},{"name":"json","version":"2.20.0","url":"https://rubygems.org/downloads/json-2.20.0.gem","sha256":"9362bc6e55a952b056abf9167cf053358181c904cb70cd6eee0808ea830fc32b"},{"name":"logger","version":"1.7.0","url":"https://rubygems.org/downloads/logger-1.7.0.gem","sha256":"196edec7cc44b66cfb40f9755ce11b392f21f7967696af15d274dde7edff0203"},{"name":"minitest","version":"5.26.1","url":"https://rubygems.org/downloads/minitest-5.26.1.gem","sha256":"f16a63d4278e230bba342c3bda3006a69c5216d46461b77dd57f7c7c529b5a96"},{"name":"molinillo","version":"0.8.0","url":"https://rubygems.org/downloads/molinillo-0.8.0.gem","sha256":"efbff2716324e2a30bccd3eba1ff3a735f4d5d53ffddbc6a2f32c0ca9433045d"},{"name":"mutex_m","version":"0.3.0","url":"https://rubygems.org/downloads/mutex_m-0.3.0.gem","sha256":"cfcb04ac16b69c4813777022fdceda24e9f798e48092a2b817eb4c0a782b0751"},{"name":"nanaimo","version":"0.4.0","url":"https://rubygems.org/downloads/nanaimo-0.4.0.gem","sha256":"faf069551bab17f15169c1f74a1c73c220657e71b6e900919897a10d991d0723"},{"name":"nap","version":"1.1.0","url":"https://rubygems.org/downloads/nap-1.1.0.gem","sha256":"949691660f9d041d75be611bb2a8d2fd559c467537deac241f4097d9b5eea576"},{"name":"netrc","version":"0.11.0","url":"https://rubygems.org/downloads/netrc-0.11.0.gem","sha256":"de1ce33da8c99ab1d97871726cba75151113f117146becbe45aa85cb3dabee3f"},{"name":"nkf","version":"0.3.0","url":"https://rubygems.org/downloads/nkf-0.3.0.gem","sha256":"357a8dbeba38b727b75930f665146546076a394a1c243faf634ff176e3588895"},{"name":"public_suffix","version":"4.0.7","url":"https://rubygems.org/downloads/public_suffix-4.0.7.gem","sha256":"8be161e2421f8d45b0098c042c06486789731ea93dc3a896d30554ee38b573b8"},{"name":"rexml","version":"3.4.4","url":"https://rubygems.org/downloads/rexml-3.4.4.gem","sha256":"19e0a2c3425dfbf2d4fc1189747bdb2f849b6c5e74180401b15734bc97b5d142"},{"name":"ruby-macho","version":"4.1.0","url":"https://rubygems.org/downloads/ruby-macho-4.1.0.gem","sha256":"23dab37f7de0fe1e14f3bfa73bebc423ae8cd1d4fdb3e5585abc45a841eca920"},{"name":"typhoeus","version":"1.6.0","url":"https://rubygems.org/downloads/typhoeus-1.6.0.gem","sha256":"bacc41c23e379547e29801dc235cd1699b70b955a1ba3d32b2b877aa844c331d"},{"name":"tzinfo","version":"2.0.6","url":"https://rubygems.org/downloads/tzinfo-2.0.6.gem","sha256":"8daf828cc77bcf7d63b0e3bdb6caa47e2272dcfaf4fbfe46f8c3a9df087a829b"},{"name":"xcodeproj","version":"1.28.1","url":"https://rubygems.org/downloads/xcodeproj-1.28.1.gem","sha256":"6f12670f00739d9817ca27ac89d6ef01cc86050e22a0bc08a3131487e5b5cddc"},{"name":"zeitwerk","version":"2.6.18","url":"https://rubygems.org/downloads/zeitwerk-2.6.18.gem","sha256":"bd2d213996ff7b3b364cd342a585fbee9797dbc1c0c6d868dc4150cc75739781"}]},{"id":"xcode","title":"Xcode","version":"27.0","source":"https://developer.apple.com/xcode/","command":"xcodebuild","archive":null,"managed":false,"requires":[]},{"id":"perl","title":"Perl","version":"5.42.3","source":"https://www.cpan.org/src/5.0/","command":"perl","archive":{"url":"https://www.cpan.org/src/5.0/perl-5.42.3.tar.xz","sha256":"c9387e1473a1866935cb047ece7c2e0a80767a3acdecb79d4a375f8a95970ddc","root":"perl-5.42.3","executable":"bin/perl","kind":"native-source"},"managed":true,"requires":["node","xcode"]},{"id":"openssl","title":"OpenSSL","version":"3.6.3","source":"https://github.com/openssl/openssl/releases/download/openssl-3.6.3/","command":"openssl","archive":{"url":"https://github.com/openssl/openssl/releases/download/openssl-3.6.3/openssl-3.6.3.tar.gz","sha256":"243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1","root":"openssl-3.6.3","executable":"bin/openssl","kind":"native-source"},"managed":true,"requires":["node","xcode","perl"]},{"id":"ruby","title":"Ruby","version":"3.4.11","source":"https://cache.ruby-lang.org/pub/ruby/3.4/","command":"ruby","archive":{"url":"https://cache.ruby-lang.org/pub/ruby/3.4/ruby-3.4.11.tar.gz","sha256":"5c22be44524312b3d433d68739bcc530633b1da5ef8ba0afa0a37680da17d3de","root":"ruby-3.4.11","executable":"bin/ruby","kind":"native-source"},"managed":true,"requires":["node","xcode","openssl"],"dependencies":[{"name":"libyaml","version":"0.2.5","url":"https://pyyaml.org/download/libyaml/yaml-0.2.5.tar.gz","sha256":"c642ae9b75fee120b2d96c712538bd2cf283228d2337df2cf2988e3c02678ef4","root":"yaml-0.2.5"}]},{"id":"m4","title":"GNU M4","version":"1.4.21","source":"https://ftp.gnu.org/gnu/m4/","command":"m4","archive":{"url":"https://ftp.gnu.org/gnu/m4/m4-1.4.21.tar.xz","sha256":"f25c6ab51548a73a75558742fb031e0625d6485fe5f9155949d6486a2408ab66","root":"m4-1.4.21","executable":"bin/m4","kind":"native-source"},"managed":true,"requires":["node","xcode"]},{"id":"bison","title":"GNU Bison","version":"3.8.2","source":"https://ftp.gnu.org/gnu/bison/","command":"bison","archive":{"url":"https://ftp.gnu.org/gnu/bison/bison-3.8.2.tar.xz","sha256":"9bba0214ccf7f1079c5d59210045227bcf619519840ebfa80cd3849cff5a5bf2","root":"bison-3.8.2","executable":"bin/bison","kind":"native-source"},"managed":true,"requires":["node","xcode","m4"]},{"id":"flex","title":"Flex","version":"2.6.4","source":"https://github.com/westes/flex/releases/download/v2.6.4/","command":"flex","archive":{"url":"https://github.com/westes/flex/releases/download/v2.6.4/flex-2.6.4.tar.gz","sha256":"e87aae032bf07c26f85ac0ed3250998c37621d95f8bd748b31f15b33c45ee995","root":"flex-2.6.4","executable":"bin/flex","kind":"native-source"},"managed":true,"requires":["node","xcode","m4","bison"]},{"id":"gettext","title":"GNU Gettext","version":"1.0","source":"https://ftp.gnu.org/gnu/gettext/","command":"msgfmt","archive":{"url":"https://ftp.gnu.org/gnu/gettext/gettext-1.0.tar.gz","sha256":"85d99b79c981a404874c02e0342176cf75c7698e2b51fe41031cf6526d974f1a","root":"gettext-1.0","executable":"bin/msgfmt","kind":"native-source"},"managed":true,"requires":["node","xcode","perl","m4","bison","flex"]},{"id":"posix","title":"macOS POSIX 基础工具","version":"27.0","source":"https://opensource.apple.com/","command":"bash","archive":{"url":"https://opensource.apple.com/","sha256":"8ca7560842b9606bcbe9628248866cc52675775a956574199716515dadf020fe","root":"macos-posix-27.0","executable":"bin/bash","kind":"apple-posix"},"managed":true,"requires":["node","xcode"]},{"id":"bash","title":"GNU Bash","version":"5.3.20","source":"https://www.gnu.org/software/bash/","command":"bash","archive":{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3.tar.gz","sha256":"0d5cd86965f869a26cf64f4b71be7b96f90a3ba8b3d74e27e8e9d9d5550f31ba","root":"bash-5.3","executable":"bin/bash","kind":"native-source"},"upstream_patches":[{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-001","sha256":"1f608434364af86b9b45c8b0ea3fb3b165fb830d27697e6cdfc7ac17dee3287f"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-002","sha256":"e385548a00130765ec7938a56fbdca52447ab41fabc95a25f19ade527e282001"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-003","sha256":"f245d9c7dc3f5a20d84b53d249334747940936f09dc97e1dcb89fc3ab37d60ed"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-004","sha256":"9591d245045529f32f0812f94180b9d9ce9023f5a765c039b852e5dfc99747d0"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-005","sha256":"cca1ef52dbbf433bc98e33269b64b2c814028efe2538be1e2c9a377da90bc99d"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-006","sha256":"29119addefed8eff91ae37fd51822c31780ee30d4a28376e96002706c995ff10"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-007","sha256":"c0976bbfffa1453c7cfdd62058f206a318568ff2d690f5d4fa048793fa3eb299"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-008","sha256":"097cd723cbfb8907674ac32214063a3fd85282657ec5b4e544d2c0f719653fb4"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-009","sha256":"eee30fe78a4b0cb2fe20e010e00308899cfc613e0774ebb3c8557a1552f24f8c"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-010","sha256":"cf76f1cce2ea300c18bff9f002d21f280cc931acd17c28518110b93fe6e72569"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-011","sha256":"0298df8f5ea2a31d3be43ed7d269c5b3c7c342dd5b570bea7f64d66dcbbe7531"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-012","sha256":"d71379b39bebaedaf123414414e77fb458a0a43b9ad3116594c6df7ca6754573"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-013","sha256":"042f9cda967e24bf4211944697441e93d06ff42b4b998629a98a1b249279f200"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-014","sha256":"bd4360b401d38507e358783dcad8536a99c6789f0d3a5bd0cfb8c4a34144696c"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-015","sha256":"55b79ceee2fc27f6767eed697e939a7eb2fe2a28c01556bd75f18d581014f46e"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-016","sha256":"9ea29b266b7d24cb34d0ff3f1c4631e4d527bfe2d1ef15d17cdb924bf31ef767"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-017","sha256":"443b927b45c1558ca72052410f8b8f6e5152b617ed707061a2781d4375b0d1c3"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-018","sha256":"ae715d76c50341d7d7095e9a8d2eeed1ca9546152c2ac7289206f90cf30ac697"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-019","sha256":"a25c581e4d0057dea3833918438a930e2e86ee4c6dc17fe15267b7f04cbc4e3d"},{"url":"https://ftp.gnu.org/gnu/bash/bash-5.3-patches/bash53-020","sha256":"df217ed3a9122aa2286d9b67bbe348661b6a9db262b580c29150dae55d532896"}],"managed":true,"requires":["node","xcode","posix"]},{"id":"grep","title":"GNU grep","version":"3.12","source":"https://www.gnu.org/software/grep/","command":"grep","archive":{"url":"https://ftp.gnu.org/gnu/grep/grep-3.12.tar.xz","sha256":"2649b27c0e90e632eadcd757be06c6e9a4f48d941de51e7c0f83ff76408a07b9","root":"grep-3.12","executable":"bin/grep","kind":"native-source"},"managed":true,"requires":["node","xcode","posix"]},{"id":"sed","title":"GNU sed","version":"4.10","source":"https://www.gnu.org/software/sed/","command":"sed","archive":{"url":"https://ftp.gnu.org/gnu/sed/sed-4.10.tar.xz","sha256":"b8e72182b2ec96a3574e2998c47b7aaa64cc20ce000d8e9ac313cc07cecf28c7","root":"sed-4.10","executable":"bin/sed","kind":"native-source"},"managed":true,"requires":["node","xcode","posix"]}];
const androidPlatformDefinitions=[{"path":"platforms;android-35","version":"2","source":"https://dl.google.com/android/repository/platform-35_r02.zip","sha256":"14c793e5c50d69bd3a5b15e42bf763b39ea90d8d3fb3a4a690b5a7b05c299d6f"}];
const androidDefinitions=[{"path":"platforms;android-36","version":"2","url":"https://dl.google.com/android/repository/platform-36_r02.zip","sha256":"37607369a28c5b640b3a7998868d45898ebcb777565a0e85f9acf36f29631d2e","root":"android-36"},{"path":"build-tools;36.0.0","version":"36.0.0","url":"https://dl.google.com/android/repository/build-tools_r36_macosx.zip","sha256":"04e7f3a72044de4926fa038fa0e251a37bba1e1c3fb8beab6f8401bfd9eb4bf3","root":"android-16"},{"path":"platform-tools","version":"37.0.1","url":"https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip","sha256":"ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d","root":"platform-tools"},{"path":"cmdline-tools;22.0","version":"22.0","url":"https://dl.google.com/android/repository/commandlinetools-mac_arm64-15859902_latest.zip","sha256":"835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e","root":"cmdline-tools"},{"tool":"cmake"},{"path":"ndk;28.2.13676358","version":"28.2.13676358","url":"https://dl.google.com/android/repository/android-ndk-r28c-darwin.zip","sha256":"0d4599e8bbf1a1668a0d51a541729b2246360f350018a2081d0b302dbb594f2a","root":"android-ndk-r28c"}];
const flutterPatch="# Flutter Android new DSL — fixed source d3b14c876900e553bc736ca19295fc09e3853e8e\n# Copyright notices and the upstream BSD license are retained in the SDK.\ndiff --git a/packages/flutter_tools/gradle/build.gradle.kts b/packages/flutter_tools/gradle/build.gradle.kts\nindex 8bce67c561f7a91bb743b443242b8d804ddc4190dc5524278bdecf8797515008..7438ec7066f34d2b597426a58105e831d677a4278cd3ee415587a9768678d667\n--- a/packages/flutter_tools/gradle/build.gradle.kts\n+++ b/packages/flutter_tools/gradle/build.gradle.kts\n@@ -7,8 +7,13 @@\n plugins {\n     `java-gradle-plugin`\n     groovy\n+    kotlin(\"jvm\") version \"2.2.20\"\n+    kotlin(\"plugin.sam.with.receiver\") version \"2.2.20\"\n+}\n+\n+// 保留Gradle Action的官方隐式接收者语义，编译插件与Kotlin使用同一版本。\n+samWithReceiver {\n+    annotation(\"org.gradle.api.HasImplicitReceiver\")\n-    `kotlin-dsl`\n-    kotlin(\"jvm\") version \"2.2.20\"\n }\n \n group = \"dev.flutter.plugin\"\n@@ -50,12 +55,14 @@\n }\n \n dependencies {\n+    // 使用固定Kotlin编译插件，不应用绑定Gradle内嵌Kotlin版本的kotlin-dsl插件。\n+    implementation(gradleKotlinDsl())\n     // Versions available https://mvnrepository.com/artifact/androidx.annotation/annotation-jvm.\n     // Version release notes https://developer.android.com/jetpack/androidx/releases/annotation\n     compileOnly(\"androidx.annotation:annotation-jvm:1.9.1\")\n     // When bumping, also update:\n     //  * KGP error version in packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt\n+    implementation(\"org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.20\")\n-    implementation(\"org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.0\")\n     // Update to 1.8.0 when min kotlin is 2.1\n     // https://github.com/Kotlin/kotlinx.serialization/releases for kotlin version compatibility.\n     // All kotlinx implementation dependencies must work with the oldest kotlin supported versions.\n@@ -65,10 +72,10 @@\n     //  * AGP version constants in packages/flutter_tools/lib/src/android/gradle_utils.dart\n     //  * ndkVersion constant in packages/flutter_tools/lib/src/android/gradle_utils.dart\n     //  * ndkVersion in FlutterExtension in packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt\n+    compileOnly(\"com.android.tools.build:gradle:9.0.1\")\n-    compileOnly(\"com.android.tools.build:gradle:8.11.1\")\n \n     testImplementation(kotlin(\"test\"))\n+    testImplementation(\"com.android.tools.build:gradle:9.0.1\")\n-    testImplementation(\"com.android.tools.build:gradle:8.11.1\")\n     testImplementation(\"org.mockito:mockito-core:5.8.0\")\n     testImplementation(\"io.mockk:mockk:1.13.16\")\n }\ndiff --git a/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt b/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt\nindex a8ca02d55798c200d766e245dae9df20565cb9d638d4887b51bf617abac938a1..383540448a0810cb60e7b6197455fdcf3bd1771720e82a42ed10e5af7e8b43b9\n--- a/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt\n+++ b/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt\n@@ -45,4 +45,5 @@\n      * Specifies the relative directory to the Flutter project directory.\n      * In an app project, this is ../.. since the app's Gradle build file is under android/app.\n      */\n+    // 本机任务在插件应用时即需准确源码根；标准Flutter工程继续使用官方相对路径。\n+    var source: String? = System.getenv(\"PRODUCT_SOURCE_DIR\") ?: \"../..\"\n-    var source: String? = \"../..\"\ndiff --git a/packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt b/packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt\nindex aba6c2f7331ea613227fed69666f8edb3839c09413188ccab64989dabe4bcd6f..afc1c54599c2b8cacbf5d957a198b168106aa95b341a79243bc66e47e4201ed1\n--- a/packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt\n+++ b/packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt\n@@ -7,11 +7,20 @@\n import com.android.build.api.dsl.ApplicationExtension\n import com.android.build.api.dsl.BuildType\n import com.android.build.api.variant.AndroidComponentsExtension\n+import com.android.build.api.variant.ApplicationVariant\n+import com.android.build.api.variant.Variant\n+import com.android.build.api.variant.FilterConfiguration\n+import com.android.build.api.variant.BuiltArtifactsLoader\n+import com.android.build.api.artifact.SingleArtifact\n+import org.gradle.api.DefaultTask\n+import org.gradle.api.file.DirectoryProperty\n+import org.gradle.api.provider.Property\n+import org.gradle.api.tasks.Input\n+import org.gradle.api.tasks.InputDirectory\n+import org.gradle.api.tasks.OutputDirectory\n+import org.gradle.api.tasks.Internal\n+import org.gradle.api.tasks.TaskAction\n+import org.gradle.api.tasks.Sync\n-import com.android.build.gradle.AbstractAppExtension\n-import com.android.build.gradle.LibraryExtension\n-import com.android.build.gradle.api.ApkVariant\n-import com.android.build.gradle.tasks.PackageAndroidArtifact\n-import com.android.build.gradle.tasks.ProcessAndroidResources\n import com.flutter.gradle.FlutterPluginConstants.PLATFORM_ABI_LIST\n import com.flutter.gradle.FlutterPluginUtils.readPropertiesIfExist\n import com.flutter.gradle.plugins.PluginHandler\n@@ -246,12 +255,12 @@\n             }\n             localEngineHost = engineHostOut.name\n         }\n+        FlutterPluginUtils.getAndroidExtension(project).buildTypes.all {\n-        FlutterPluginUtils.getLegacyAndroidExtension(project).buildTypes.all {\n             addFlutterDependencies(this)\n         }\n     }\n \n+    private fun addFlutterDependencies(buildType: BuildType) {\n-    private fun addFlutterDependencies(buildType: com.android.builder.model.BuildType) {\n         FlutterPluginUtils.addFlutterDependencies(\n             project!!,\n             buildType,\n@@ -305,203 +314,15 @@\n             FlutterPluginUtils.addTasksForOutputsAppLinkSettings(projectToAddTasksTo)\n         }\n \n+        val targetPlatforms = FlutterPluginUtils.getTargetPlatforms(projectToAddTasksTo)\n-        val targetPlatforms: List<String> =\n-            FlutterPluginUtils.getTargetPlatforms(projectToAddTasksTo)\n-\n-        // The Android Gradle Plugin is always applied to Flutter Android projects, so its components\n-        // extension is expected to be present. Use getByType (not findByType) so a misconfiguration\n-        // fails loudly rather than silently skipping libapp.so registration.\n-        val androidComponents = projectToAddTasksTo.extensions.getByType(AndroidComponentsExtension::class.java)\n-        val targetPlatformsList = targetPlatforms\n-        androidComponents.onVariants { variant ->\n-            val capitalizeVariantName = FlutterPluginUtils.capitalize(variant.name)\n-            val compileTaskName = flutterCompileTaskName(variant.name)\n-            val copyJniLibsTaskProvider: TaskProvider<CopyFlutterJniLibsTask> =\n-                projectToAddTasksTo.tasks.register(\n-                    \"copyJniLibs${FLUTTER_BUILD_PREFIX}$capitalizeVariantName\",\n-                    CopyFlutterJniLibsTask::class.java\n-                ) {\n-                    // The Flutter compile task is registered later (in the legacy\n-                    // `applicationVariants` callback in addFlutterDeps) and only for variants that\n-                    // are actually built as a Flutter app. It is absent for e.g. an\n-                    // `assembleAndroidTest` build, where `shouldConfigureFlutterTask` returns false.\n-                    // Look it up tolerantly (findByName, not named) so this task degrades to a no-op\n-                    // with empty output instead of failing to be created when there is no Flutter\n-                    // build for the variant. See https://github.com/flutter/flutter/issues/188785.\n-                    dependsOn(projectToAddTasksTo.tasks.matching { it.name == compileTaskName })\n-                    intermediateDir.set(\n-                        projectToAddTasksTo.layout.dir(\n-                            projectToAddTasksTo.provider {\n-                                val compileTask = projectToAddTasksTo.tasks.findByName(compileTaskName) as? FlutterTask\n-                                compileTask?.outputDirectory\n-                            }\n-                        )\n-                    )\n-                    this.targetPlatforms.set(targetPlatformsList)\n-                }\n-            variant.sources.jniLibs?.addGeneratedSourceDirectory(\n-                copyJniLibsTaskProvider,\n-                CopyFlutterJniLibsTask::destinationDir\n-            )\n-        }\n-\n-        val flutterPlugin = this\n-\n         if (FlutterPluginUtils.isFlutterAppProject(projectToAddTasksTo)) {\n+            configureAbis(projectToAddTasksTo, FlutterPluginUtils.getAndroidApplicationExtension(projectToAddTasksTo))\n-            val appExtension = FlutterPluginUtils.getAndroidApplicationExtension(projectToAddTasksTo)\n-            configureAbis(projectToAddTasksTo, appExtension)\n-            val android: AbstractAppExtension =\n-                projectToAddTasksTo.extensions.findByName(\"android\") as AbstractAppExtension\n-            android.applicationVariants.configureEach {\n-                val variant = this\n-                val assembleTask = variant.assembleProvider.get()\n-                if (!FlutterPluginUtils.shouldConfigureFlutterTask(\n-                        projectToAddTasksTo,\n-                        assembleTask\n-                    )\n-                ) {\n-                    return@configureEach\n-                }\n-                val copyFlutterAssetsTask: Task =\n-                    addFlutterDeps(variant, flutterPlugin, targetPlatforms)\n-\n-                // TODO(gmackall): Migrate to AGPs variant api.\n-                //    https://github.com/flutter/flutter/issues/166550\n-                @Suppress(\"DEPRECATION\")\n-                val variantOutput: com.android.build.gradle.api.BaseVariantOutput = variant.outputs.first()\n-                val processResources: ProcessAndroidResources =\n-                    try {\n-                        variantOutput.processResourcesProvider.get()\n-                    } catch (e: UnknownTaskException) {\n-                        // TODO(gmackall): Migrate to AGPs variant api.\n-                        //    https://github.com/flutter/flutter/issues/166550\n-                        @Suppress(\"DEPRECATION\")\n-                        variantOutput.processResources\n-                    }\n-                processResources.dependsOn(copyFlutterAssetsTask)\n-\n-                // Copy the output APKs into a known location, so `flutter run` or `flutter build apk`\n-                // can discover them. By default, this is `<app-dir>/build/app/outputs/flutter-apk/<filename>.apk`.\n-                //\n-                // The filename consists of `app<-abi>?<-flavor-name>?-<build-mode>.apk`.\n-                // Where:\n-                //   * `abi` can be `armeabi-v7a|arm64-v8a|x86_64` only if the flag `split-per-abi` is set.\n-                //   * `flavor-name` is the flavor used to build the app in lower case if the assemble task is called.\n-                //   * `build-mode` can be `release|debug|profile`.\n-                variant.outputs.forEach { output ->\n-                    assembleTask.doLast {\n-                        // TODO(gmackall): Migrate to AGPs variant api.\n-                        //    https://github.com/flutter/flutter/issues/166550\n-                        @Suppress(\"DEPRECATION\")\n-                        output as com.android.build.gradle.api.ApkVariantOutput\n-                        val packageApplicationProvider: PackageAndroidArtifact =\n-                            variant.packageApplicationProvider.get()\n-                        val outputDirectory: Directory =\n-                            packageApplicationProvider.outputDirectory.get()\n-                        val outputDirectoryStr: String = outputDirectory.toString()\n-                        var filename = \"app\"\n-\n-                        // TODO(gmackall): Migrate to AGPs variant api.\n-                        //    https://github.com/flutter/flutter/issues/166550\n-                        @Suppress(\"DEPRECATION\")\n-                        val abi = output.getFilter(com.android.build.VariantOutput.FilterType.ABI)\n-                        if (abi != null && abi.isNotEmpty()) {\n-                            filename += \"-$abi\"\n-                        }\n-                        if (variant.flavorName != null && variant.flavorName.isNotEmpty()) {\n-                            filename += \"-${FlutterPluginUtils.lowercase(variant.flavorName)}\"\n-                        }\n-                        filename += \"-${FlutterPluginUtils.buildModeFor(variant.buildType)}\"\n-                        projectToAddTasksTo.copy {\n-                            from(File(\"$outputDirectoryStr/${output.outputFileName}\"))\n-                            into(projectToAddTasksTo.layout.buildDirectory.dir(\"outputs/flutter-apk\"))\n-                            rename { \"$filename.apk\" }\n-                        }\n-                    }\n-                }\n-            }\n-            getPluginHandler(projectToAddTasksTo).configurePlugins(engineVersion!!)\n-            FlutterPluginUtils.detectLowCompileSdkVersionOrNdkVersion(\n-                projectToAddTasksTo,\n-                getPluginHandler(projectToAddTasksTo).getPluginList()\n-            )\n-            FlutterPluginUtils.detectApplyingKotlinGradlePlugin(\n-                projectToAddTasksTo\n-            )\n-            return\n         }\n+        // 同一个公开变体回调同时注册编译、资源与JNI，避免跨回调按名称猜测任务。\n+        val components = projectToAddTasksTo.extensions.getByType(AndroidComponentsExtension::class.java)\n+        components.onVariants { variant ->\n+            addFlutterDeps(variant, this, targetPlatforms)\n-        // Flutter host module project (Add-to-app).\n-        val hostAppProjectName: String? =\n-            if (projectToAddTasksTo.rootProject.hasProperty(\"flutter.hostAppProjectName\")) {\n-                projectToAddTasksTo.rootProject.property(\n-                    \"flutter.hostAppProjectName\"\n-                ) as? String\n-            } else {\n-                \"app\"\n-            }\n-        val appProject: Project? =\n-            projectToAddTasksTo.rootProject.findProject(\":$hostAppProjectName\")\n-        check(appProject != null) {\n-            \"Project :$hostAppProjectName doesn't exist. To customize the host app project name, set `flutter.hostAppProjectName=<project-name>` in gradle.properties.\"\n         }\n-        // Wait for the host app project configuration.\n-        appProject.afterEvaluate {\n-            val androidLibraryExtension =\n-                projectToAddTasksTo.extensions.findByType(LibraryExtension::class.java)\n-            check(androidLibraryExtension != null)\n-            androidLibraryExtension.libraryVariants.all libraryVariantAll@{\n-                val libraryVariant = this\n-                var copyFlutterAssetsTask: Task? = null\n-                val androidAppExtension =\n-                    appProject.extensions.findByName(\"android\") as? AbstractAppExtension\n-                check(androidAppExtension != null)\n-                androidAppExtension.applicationVariants.all applicationVariantAll@{\n-                    val appProjectVariant = this\n-                    val appAssembleTask: Task = appProjectVariant.assembleProvider.get()\n-                    if (!FlutterPluginUtils.shouldConfigureFlutterTask(project, appAssembleTask)) {\n-                        return@applicationVariantAll\n-                    }\n-\n-                    // Find a compatible application variant in the host app.\n-                    //\n-                    // For example, consider a host app that defines the following variants:\n-                    // | ----------------- | ----------------------------- |\n-                    // |   Build Variant   |   Flutter Equivalent Variant  |\n-                    // | ----------------- | ----------------------------- |\n-                    // |   freeRelease     |   release                     |\n-                    // |   freeDebug       |   debug                       |\n-                    // |   freeDevelop     |   debug                       |\n-                    // |   profile         |   profile                     |\n-                    // | ----------------- | ----------------------------- |\n-                    //\n-                    // This mapping is based on the following rules:\n-                    // 1. If the host app build variant name is `profile` then the equivalent\n-                    //    Flutter variant is `profile`.\n-                    // 2. If the host app build variant is debuggable\n-                    //    (e.g. `buildType.debuggable = true`), then the equivalent Flutter\n-                    //    variant is `debug`.\n-                    // 3. Otherwise, the equivalent Flutter variant is `release`.\n-                    val variantBuildMode: String =\n-                        FlutterPluginUtils.buildModeFor(libraryVariant.buildType)\n-                    if (FlutterPluginUtils.buildModeFor(appProjectVariant.buildType) != variantBuildMode) {\n-                        return@applicationVariantAll\n-                    }\n-                    copyFlutterAssetsTask = copyFlutterAssetsTask ?: addFlutterDeps(\n-                        libraryVariant,\n-                        flutterPlugin,\n-                        targetPlatforms\n-                    )\n-                    // TODO(gmackall): Migrate to AGPs variant api.\n-                    //    https://github.com/flutter/flutter/issues/166550\n-                    val mergeAssets =\n-                        projectToAddTasksTo\n-                            .tasks\n-                            .findByPath(\":$hostAppProjectName:merge${FlutterPluginUtils.capitalize(appProjectVariant.name)}Assets\")\n-                    check(mergeAssets != null)\n-                    mergeAssets.dependsOn(copyFlutterAssetsTask)\n-                }\n-            }\n-        }\n         getPluginHandler(projectToAddTasksTo).configurePlugins(engineVersion!!)\n         FlutterPluginUtils.detectLowCompileSdkVersionOrNdkVersion(\n             projectToAddTasksTo,\n@@ -600,26 +421,12 @@\n             }\n         }\n \n+        // 只消费AGP公开变体，不读取内部打包任务或已删除的变体接口。\n-        /**\n-         * Finds a task by name, returning null if the task does not exist.\n-         */\n-        private fun findTaskOrNull(\n-            project: Project,\n-            taskName: String\n-        ): Task? =\n-            try {\n-                project.tasks.named(taskName).get()\n-            } catch (ignored: UnknownTaskException) {\n-                null\n-            }\n-\n-        // TODO(gmackall): Migrate to AGPs variant api.\n-        //    https://github.com/flutter/flutter/issues/166550\n         private fun addFlutterDeps(\n+            variant: Variant,\n-            @Suppress(\"DEPRECATION\") variant: com.android.build.gradle.api.BaseVariant,\n             flutterPlugin: FlutterPlugin,\n             targetPlatforms: List<String>\n+        ): Unit {\n-        ): Task {\n             // Shorthand\n             val project: Project = flutterPlugin.project!!\n \n@@ -654,51 +461,19 @@\n             val validateDeferredComponentsValue: Boolean =\n                 project.findProperty(\"validate-deferred-components\")?.toString()?.toBoolean() ?: true\n \n+            val buildType = FlutterPluginUtils.getAndroidExtension(project).buildTypes.getByName(requireNotNull(variant.buildType))\n+            val variantBuildMode = FlutterPluginUtils.buildModeFor(buildType)\n+            val flavorValue = variant.flavorName.orEmpty()\n+            if (!FlutterPluginUtils.supportsBuildMode(project, variantBuildMode)) return\n+            if (variant is ApplicationVariant && FlutterPluginUtils.shouldProjectSplitPerAbi(project)) {\n-            if (FlutterPluginUtils.shouldProjectSplitPerAbi(project)) {\n                 variant.outputs.forEach { output ->\n+                    val abi = output.filters.firstOrNull { it.filterType == FilterConfiguration.FilterType.ABI }?.identifier\n+                    val abiVersionCode = FlutterPluginConstants.ABI_VERSION[abi]\n-                    // need to force this as the API does not return the right thing for our use.\n-                    // TODO(gmackall): Migrate to AGPs variant api.\n-                    //    https://github.com/flutter/flutter/issues/166550\n-                    @Suppress(\"DEPRECATION\")\n-                    output as com.android.build.gradle.api.ApkVariantOutput\n-                    val versionCodeIfPresent: Int? = if (variant is ApkVariant) variant.versionCode else null\n-\n-                    // TODO(gmackall): Migrate to AGPs variant api.\n-                    //    https://github.com/flutter/flutter/issues/166550\n-                    @Suppress(\"DEPRECATION\")\n-                    val filterIdentifier: String? =\n-                        output.getFilter(com.android.build.VariantOutput.FilterType.ABI)\n-                    val abiVersionCode: Int? = FlutterPluginConstants.ABI_VERSION[filterIdentifier]\n                     if (abiVersionCode != null && !FlutterPluginUtils.shouldForceVersionCodeIgnoringAbi(project)) {\n+                        output.versionCode.set(output.versionCode.get() + abiVersionCode * 1000)\n-                        output.versionCodeOverride = abiVersionCode * 1000 + (\n-                            versionCodeIfPresent\n-                                ?: variant.mergedFlavor.versionCode as Int\n-                        )\n                     }\n                 }\n             }\n-\n-            // Build an AAR when this property is defined.\n-            val isBuildingAar: Boolean = project.hasProperty(\"is-plugin\")\n-            // In add to app scenarios, a Gradle project contains a `:flutter` and `:app` project.\n-            // `:flutter` is used as a subproject when these tasks exists and the build isn't building an AAR.\n-            // TODO(gmackall): I think this is just always null? Which is great news! Consider removing.\n-            val packageAssets: Task? =\n-                findTaskOrNull(\n-                    project,\n-                    \"package${FlutterPluginUtils.capitalize(variant.name)}Assets\"\n-                )\n-            val cleanPackageAssets: Task? =\n-                findTaskOrNull(\n-                    project,\n-                    \"cleanPackage${FlutterPluginUtils.capitalize(variant.name)}Assets\"\n-                )\n-\n-            val isUsedAsSubproject: Boolean =\n-                packageAssets != null && cleanPackageAssets != null && !isBuildingAar\n-\n-            val variantBuildMode: String = FlutterPluginUtils.buildModeFor(variant.buildType)\n-            val flavorValue: String = variant.flavorName\n             val taskName: String = flutterCompileTaskName(variant.name)\n             // The task provider below will shadow a lot of the variable names, so provide this reference\n             // to access them within that scope.\n@@ -714,7 +489,7 @@\n                     flutterRoot = flutterPlugin.flutterRoot\n                     flutterExecutable = flutterPlugin.flutterExecutable\n                     buildMode = variantBuildMode\n+                    minSdkVersion = variant.minSdk.apiLevel\n-                    minSdkVersion = variant.mergedFlavor.minSdkVersion!!.apiLevel\n                     localEngine = flutterPlugin.localEngine\n                     localEngineHost = flutterPlugin.localEngineHost\n                     localEngineSrcPath = flutterPlugin.localEngineSrcPath\n@@ -742,76 +517,42 @@\n                     validateDeferredComponents = validateDeferredComponentsValue\n                     flavor = flavorValue\n                 }\n+            // 生成目录经Sources API交给AGP，资源/JNI消费者自动获得准确任务依赖。\n+            val assets = project.tasks.register(\n+                \"copyFlutterAssets\" + FlutterPluginUtils.capitalize(variant.name),\n+                FlutterAssetsTask::class.java\n+            ) {\n+                dependsOn(compileTaskProvider)\n+                from(compileTaskProvider.map { File(requireNotNull(it.outputDirectory), \"flutter_assets\") }) { into(\"flutter_assets\") }\n+                destinationDirectory.set(project.layout.buildDirectory.dir(\"intermediates/flutter-assets/\" + variant.name))\n+                into(destinationDirectory)\n+            }\n+            variant.sources.assets?.addGeneratedSourceDirectory(assets, FlutterAssetsTask::destinationDirectory)\n+                ?: throw GradleException(\"Android variant has no assets sources: \" + variant.name)\n+            val jni = project.tasks.register(\n+                \"copyJniLibs\" + FLUTTER_BUILD_PREFIX + FlutterPluginUtils.capitalize(variant.name),\n+                CopyFlutterJniLibsTask::class.java\n+            ) {\n+                dependsOn(compileTaskProvider)\n+                intermediateDir.set(project.layout.dir(compileTaskProvider.map { requireNotNull(it.outputDirectory) }))\n+                this.targetPlatforms.set(targetPlatforms)\n+            }\n+            variant.sources.jniLibs?.addGeneratedSourceDirectory(jni, CopyFlutterJniLibsTask::destinationDir)\n+                ?: throw GradleException(\"Android variant has no JNI sources: \" + variant.name)\n+            if (variant is ApplicationVariant) {\n+                val copyApk = project.tasks.register(\n+                    \"copyFlutterApk\" + FlutterPluginUtils.capitalize(variant.name), FlutterApkTask::class.java\n-            val flutterCompileTask: FlutterTask = compileTaskProvider.get()\n-            val copyFlutterAssetsTaskProvider: TaskProvider<Copy> =\n-                project.tasks.register(\n-                    \"copyFlutterAssets${FlutterPluginUtils.capitalize(variant.name)}\",\n-                    Copy::class.java\n                 ) {\n+                    inputDirectory.set(variant.artifacts.get(SingleArtifact.APK))\n+                    destinationDirectory.set(project.layout.buildDirectory.dir(\"outputs/flutter-apk\"))\n+                    loader.set(variant.artifacts.getBuiltArtifactsLoader())\n+                    buildMode.set(variantBuildMode)\n+                    flavor.set(flavorValue)\n-                    dependsOn(flutterCompileTask)\n-                    with(flutterCompileTask.assets)\n-                    filePermissions {\n-                        user {\n-                            read = true\n-                            write = true\n-                        }\n-                    }\n-                    if (isUsedAsSubproject) {\n-                        // TODO(gmackall): above is always false, can delete\n-                        dependsOn(packageAssets)\n-                        dependsOn(cleanPackageAssets)\n-                        into(packageAssets!!.outputs)\n-                    }\n-                    val mergeAssets =\n-                        try {\n-                            variant.mergeAssetsProvider.get()\n-                        } catch (e: IllegalStateException) {\n-                            // TODO(gmackall): Migrate to AGPs variant api.\n-                            //    https://github.com/flutter/flutter/issues/166550\n-                            @Suppress(\"DEPRECATION\")\n-                            variant.mergeAssets\n-                        }\n-                    dependsOn(mergeAssets)\n-                    dependsOn(\"clean${FlutterPluginUtils.capitalize(mergeAssets.name)}\")\n-                    mergeAssets.mustRunAfter(\"clean${FlutterPluginUtils.capitalize(mergeAssets.name)}\")\n-                    into(mergeAssets.outputDir)\n                 }\n+                // assemble是公开生命周期入口；APK位置与文件清单由Artifacts API提供。\n+                project.tasks.matching { it.name == \"assemble\" + FlutterPluginUtils.capitalize(variant.name) }\n+                    .configureEach { dependsOn(copyApk) }\n-            val copyFlutterAssetsTask: Task = copyFlutterAssetsTaskProvider.get()\n-            if (!isUsedAsSubproject) {\n-                // TODO(gmackall): Migrate to AGPs variant api.\n-                //    https://github.com/flutter/flutter/issues/166550\n-                @Suppress(\"DEPRECATION\")\n-                val variantOutput: com.android.build.gradle.api.BaseVariantOutput = variant.outputs.first()\n-                val processResources =\n-                    try {\n-                        variantOutput.processResourcesProvider.get()\n-                    } catch (e: IllegalStateException) {\n-                        // TODO(gmackall): Migrate to AGPs variant api.\n-                        //    https://github.com/flutter/flutter/issues/166550\n-                        @Suppress(\"DEPRECATION\")\n-                        variantOutput.processResources\n-                    }\n-                processResources.dependsOn(copyFlutterAssetsTask)\n             }\n-            // The following tasks use the output of copyFlutterAssetsTask,\n-            // so it's necessary to declare it as an dependency since Gradle 8.\n-            // See https://docs.gradle.org/8.1/userguide/validation_problems.html#implicit_dependency.\n-            val tasksToCheck =\n-                listOf(\n-                    \"compress${FlutterPluginUtils.capitalize(variant.name)}Assets\",\n-                    \"bundle${FlutterPluginUtils.capitalize(variant.name)}Aar\",\n-                    \"bundle${FlutterPluginUtils.capitalize(variant.name)}LocalLintAar\"\n-                )\n-            tasksToCheck.forEach { taskTocheck ->\n-                try {\n-                    project.tasks.named(taskTocheck).configure {\n-                        dependsOn(copyFlutterAssetsTask)\n-                    }\n-                } catch (ignored: UnknownTaskException) {\n-                    // ignored\n-                }\n-            }\n-            return copyFlutterAssetsTask\n         }\n     }\n \n@@ -823,3 +564,35 @@\n      */\n     private fun isInvokedFromAndroidStudio(): Boolean = project?.hasProperty(\"android.injected.invoked.from.ide\") == true\n }\n+\n+/** 公开资源生成任务：每个变体独占输出，禁止直接写入AGP内部合并目录。 */\n+abstract class FlutterAssetsTask : Sync() {\n+    @get:OutputDirectory\n+    abstract val destinationDirectory: DirectoryProperty\n+}\n+\n+/** 从AGP正式输出清单发现APK，不按内部任务类或固定文件位置猜测。 */\n+abstract class FlutterApkTask : DefaultTask() {\n+    @get:InputDirectory\n+    abstract val inputDirectory: DirectoryProperty\n+    @get:OutputDirectory\n+    abstract val destinationDirectory: DirectoryProperty\n+    @get:Internal\n+    abstract val loader: Property<BuiltArtifactsLoader>\n+    @get:Input\n+    abstract val buildMode: Property<String>\n+    @get:Input\n+    abstract val flavor: Property<String>\n+\n+    @TaskAction\n+    fun copyApks() {\n+        val artifacts = requireNotNull(loader.get().load(inputDirectory.get())) { \"APK metadata is missing\" }\n+        val output = destinationDirectory.get().asFile\n+        output.mkdirs()\n+        artifacts.elements.forEach { artifact ->\n+            val abi = artifact.filters.firstOrNull { it.filterType == FilterConfiguration.FilterType.ABI }?.identifier\n+            val name = listOfNotNull(\"app\", abi, flavor.get().takeIf { it.isNotEmpty() }?.lowercase(), buildMode.get()).joinToString(\"-\")\n+            File(artifact.outputFile).copyTo(File(output, name + \".apk\"), overwrite = true)\n+        }\n+    }\n+}\ndiff --git a/packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt b/packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt\nindex 92f05b75bae280223c3cea04fceb8c7860c65a6b464399a5a51d71dfe90f0c05..8c22286256d2ee68c5b27f60854d74df56f07de9f1cb77423cd3193aa43c8f58\n--- a/packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt\n+++ b/packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt\n@@ -7,10 +7,11 @@\n import com.android.build.api.AndroidPluginVersion\n import com.android.build.api.artifact.SingleArtifact\n import com.android.build.api.dsl.ApplicationExtension\n+import com.android.build.api.dsl.ApplicationBuildType\n import com.android.build.api.dsl.LibraryExtension\n import com.android.build.api.variant.AndroidComponentsExtension\n+import com.android.build.api.dsl.CommonExtension\n+import com.android.build.api.dsl.BuildType\n-import com.android.build.gradle.BaseExtension\n-import com.android.builder.model.BuildType\n import com.flutter.gradle.plugins.PluginHandler\n import com.flutter.gradle.tasks.DeepLinkJsonFromManifestTask\n import com.flutter.gradle.tasks.PrintTask\n@@ -472,7 +473,7 @@\n     internal fun buildModeFor(buildType: BuildType): String {\n         if (buildType.name == \"profile\") {\n             return \"profile\"\n+        } else if ((buildType is ApplicationBuildType && buildType.isDebuggable) || buildType.name == \"debug\") {\n-        } else if (buildType.isDebuggable) {\n             return \"debug\"\n         }\n         return \"release\"\n@@ -498,48 +499,23 @@\n         return project.property(PROP_LOCAL_ENGINE_BUILD_MODE) == flutterBuildMode\n     }\n \n+    // AGP9公共DSL统一入口；没有Android扩展必须立即报错。\n+    internal fun getAndroidExtension(project: Project): CommonExtension =\n+        project.extensions.getByType(CommonExtension::class.java)\n-    /**\n-     * Returns BaseExtension for the project. Used for compatibility.\n-     *\n-     * From BaseExtension docs:\n-     * \"Don't use this extension directly Instead, use one of the following:\n-     *  ApplicationExtension, LibraryExtension, TestExtension, DynamicFeatureExtension\"\n-     *\n-     *  For ApplicationExtension use `getAndroidApplicationExtension`.\n-     *  For LibraryExtension use `getAndroidLibraryExtension`.\n-     */\n-    internal fun getLegacyAndroidExtension(project: Project): BaseExtension {\n-        // Common supertype of the android extension types.\n-        // But maybe this should be https://developer.android.com/reference/tools/gradle-api/8.7/com/android/build/api/dsl/TestedExtension.\n-        return project.extensions.findByType(BaseExtension::class.java)!!\n-    }\n \n-    internal fun getAndroidExtension(project: Project): AgpCommonExtensionWrapper {\n-        // Look up by name to completely avoid importing or resolving CommonExtension\n-        val androidExtension =\n-            project.extensions.findByName(\"android\")\n-                ?: throw IllegalStateException(\"The Android plugin must be applied before accessing the Android extension.\")\n-\n-        return AgpCommonExtensionWrapper(androidExtension)\n-    }\n-\n     internal fun getAndroidLibraryExtension(project: Project): LibraryExtension = project.extensions.getByType(LibraryExtension::class.java)\n \n     internal fun getAndroidApplicationExtension(project: Project): ApplicationExtension =\n         project.extensions.getByType(ApplicationExtension::class.java)\n \n+    internal fun getConfiguredNdkVersion(project: Project): String? = getAndroidExtension(project).ndkVersion\n-    internal fun getConfiguredNdkVersion(project: Project): String? =\n-        project.extensions.findByType(ApplicationExtension::class.java)?.ndkVersion\n-            ?: getLegacyAndroidExtension(project).ndkVersion\n \n-    /**\n-     * Expected format of getAndroidExtension(project).compileSdkVersion is a string of the form\n-     * `android-` followed by either the numeric version, e.g. `android-35`, or a preview version,\n-     * e.g. `android-UpsideDownCake`.\n-     */\n     @JvmStatic\n     @JvmName(\"getCompileSdkFromProject\")\n+    internal fun getCompileSdkFromProject(project: Project): String {\n+        val android = getAndroidExtension(project)\n+        return android.compileSdkPreview ?: requireNotNull(android.compileSdk).toString()\n+    }\n-    internal fun getCompileSdkFromProject(project: Project): String = getLegacyAndroidExtension(project).compileSdkVersion!!.substring(8)\n \n     /**\n      * Returns:\n@@ -794,7 +770,7 @@\n         }\n \n         // If the project is already configuring a native build, we don't need to do anything.\n+        val gradleProjectAndroidExtension = getAndroidExtension(gradleProject)\n-        val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)\n         val forcingNotRequired: Boolean =\n             gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null\n         if (forcingNotRequired) {\n@@ -920,7 +896,7 @@\n         gradleProject: Project,\n         flutterSdkRootPath: String\n     ) {\n+        val gradleProjectAndroidExtension = getAndroidExtension(gradleProject)\n-        val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)\n         gradleProjectAndroidExtension.externalNativeBuild.cmake.path(\n             \"$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\"\n         )\ndiff --git a/packages/flutter_tools/gradle/src/main/kotlin/VersionFetcher.kt b/packages/flutter_tools/gradle/src/main/kotlin/VersionFetcher.kt\nindex 46dc5b89b2ce5a7554c0b21c52f8ef25cbe0fed25958dd84f8328998b7df75e6..4d1f77d630b102da5155c716ab0959e1e2dbdc72a02d1b59f66cbcc27bc28c5a\n--- a/packages/flutter_tools/gradle/src/main/kotlin/VersionFetcher.kt\n+++ b/packages/flutter_tools/gradle/src/main/kotlin/VersionFetcher.kt\n@@ -6,10 +6,9 @@\n \n import com.android.build.api.AndroidPluginVersion\n import com.android.build.api.variant.AndroidComponentsExtension\n-import com.android.build.gradle.internal.utils.getKotlinAndroidPluginVersion\n import org.gradle.api.JavaVersion\n import org.gradle.api.Project\n+import org.jetbrains.kotlin.gradle.plugin.getKotlinPluginVersion\n-import org.jetbrains.kotlin.gradle.plugin.KotlinAndroidPluginWrapper\n \n internal object VersionFetcher {\n     /**\n@@ -45,43 +44,8 @@\n      * Returns the version of the Kotlin Gradle plugin.\n      */\n     internal fun getKGPVersion(project: Project): Version? {\n+        // 回读实际加载的KGP资源版本，不以声明版本或Gradle内嵌编译器冒充。\n+        return Version.fromString(project.getKotlinPluginVersion())\n-        // AGP and Kgp have methods for getting kotlin version.\n-        // AGP's method is internal, we try to use it anyway.\n-        // KGP's version in org.jetbrains.kotlin.gradle.plugin.DefaultKotlinBasePlugin is not\n-        // available when this method is called.\n-        // When testing call `setAgpKotlinVersionToNull(project)`.\n-        val agpDefinedKgpVersion = getKotlinAndroidPluginVersion(project)\n-        if (agpDefinedKgpVersion != null && agpDefinedKgpVersion != \"unknown\") {\n-            return Version.fromString(agpDefinedKgpVersion)\n-        }\n-\n-        val kotlinVersionProperty = \"kotlin_version\"\n-        val firstKotlinVersionFieldName = \"pluginVersion\"\n-        val secondKotlinVersionFieldName = \"kotlinPluginVersion\"\n-        // This property corresponds to application of the Kotlin Gradle plugin in the\n-        // top-level build.gradle file.\n-        if (project.hasProperty(kotlinVersionProperty)) {\n-            return Version.fromString(project.properties[kotlinVersionProperty] as String)\n-        }\n-        val kotlinPlugin =\n-            project.plugins\n-                .findPlugin(KotlinAndroidPluginWrapper::class.java)\n-        // Partial implementation of getKotlinPluginVersion from the comment above.\n-        var versionString: String? = kotlinPlugin?.pluginVersion\n-        if (!versionString.isNullOrEmpty()) {\n-            return Version.fromString(versionString)\n-        }\n-        // Fall back to reflection.\n-        val versionField =\n-            kotlinPlugin?.javaClass?.kotlin?.members?.firstOrNull {\n-                it.name == firstKotlinVersionFieldName || it.name == secondKotlinVersionFieldName\n-            }\n-        versionString = versionField?.call(kotlinPlugin) as String?\n-        return if (versionString == null) {\n-            null\n-        } else {\n-            Version.fromString(versionString)\n-        }\n     }\n }\n \ndiff --git a/packages/flutter_tools/gradle/src/main/kotlin/plugins/PluginHandler.kt b/packages/flutter_tools/gradle/src/main/kotlin/plugins/PluginHandler.kt\nindex 2e0aabbee4b6699ded8fb75fa38347d1fe6d1c719051a2177bfc6ea7595b4817..cbebdcdb654a74d32901f0f6faee04e635c4914ef5826b43308393e547e52cf8\n--- a/packages/flutter_tools/gradle/src/main/kotlin/plugins/PluginHandler.kt\n+++ b/packages/flutter_tools/gradle/src/main/kotlin/plugins/PluginHandler.kt\n@@ -4,13 +4,14 @@\n \n package com.flutter.gradle.plugins\n \n-import com.android.builder.model.BuildType\n+import com.android.build.api.dsl.BuildType\n+import com.android.build.api.dsl.ApplicationBuildType\n import com.flutter.gradle.FlutterExtension\n import com.flutter.gradle.FlutterPluginUtils\n import com.flutter.gradle.FlutterPluginUtils.addApiDependencies\n import com.flutter.gradle.FlutterPluginUtils.buildModeFor\n import com.flutter.gradle.FlutterPluginUtils.getCompileSdkFromProject\n-import com.flutter.gradle.FlutterPluginUtils.getLegacyAndroidExtension\n+import com.flutter.gradle.FlutterPluginUtils.getAndroidExtension\n import com.flutter.gradle.FlutterPluginUtils.isBuiltAsApp\n import com.flutter.gradle.FlutterPluginUtils.supportsBuildMode\n import com.flutter.gradle.NativePluginLoaderReflectionBridge\n@@ -18,7 +19,7 @@\n import org.gradle.api.Project\n import org.jetbrains.kotlin.gradle.plugin.extraProperties\n import java.io.File\n-import com.android.build.gradle.internal.dsl.BuildType as dslBuildType\n+import java.nio.file.Files\n \n /**\n  * Handles interactions with the flutter plugins (not Gradle plugins) used by the Flutter project,\n@@ -87,6 +88,30 @@\n          */\n         private const val WEBSITE_DEPLOYMENT_ANDROID_BUILD_CONFIG = \"https://flutter.dev/to/review-gradle-config\"\n \n+        private fun prepareBuiltInKotlinPluginScript(pluginProject: Project) {\n+            val pubCache = System.getenv(\"PUB_CACHE\") ?: return\n+            val buildFile = pluginProject.buildFile\n+            if (buildFile.extension !in setOf(\"kts\", \"gradle\") || !buildFile.isFile || Files.isSymbolicLink(buildFile.toPath())) return\n+            val hostedRoot = File(pubCache, \"hosted\").canonicalFile.toPath()\n+            val buildPath = buildFile.canonicalFile.toPath()\n+            if (!buildPath.startsWith(hostedRoot)) return\n+            val input = buildFile.readText()\n+            val kotlinPlugin =\n+                Regex(\"\"\"(?m)^\\s*(?:id\\(\\s*[\"'](?:kotlin-android|org\\.jetbrains\\.kotlin\\.android)[\"']\\s*\\)(?:\\s+version\\s+[\"'][^\"']+[\"'])?|id\\s+[\"'](?:kotlin-android|org\\.jetbrains\\.kotlin\\.android)[\"']|kotlin\\(\\s*[\"']android[\"']\\s*\\)(?:\\s+version\\s+[\"'][^\"']+[\"'])?|apply\\(\\s*plugin\\s*=\\s*[\"'](?:kotlin-android|org\\.jetbrains\\.kotlin\\.android)[\"']\\s*\\)|apply\\s+plugin:\\s*[\"'](?:kotlin-android|org\\.jetbrains\\.kotlin\\.android)[\"'])\\s*$\"\"\")\n+            val kotlinClasspath =\n+                Regex(\"\"\"(?m)^\\s*(?:classpath\\(\\s*[\"']org\\.jetbrains\\.kotlin:kotlin-gradle-plugin:[^\"']+[\"']\\s*\\)|classpath\\s+[\"']org\\.jetbrains\\.kotlin:kotlin-gradle-plugin:[^\"']+[\"'])\\s*$\"\"\")\n+            val agpClasspath =\n+                Regex(\"\"\"(?m)^(\\s*)(?:classpath\\(\\s*[\"']com\\.android\\.tools\\.build:gradle:[^\"']+[\"']\\s*\\)|classpath\\s+[\"']com\\.android\\.tools\\.build:gradle:[^\"']+[\"'])\\s*$\"\"\")\n+            if (!kotlinPlugin.containsMatchIn(input) && !kotlinClasspath.containsMatchIn(input) && !agpClasspath.containsMatchIn(input)) return\n+            // 只修改任务PUB_CACHE副本；插件模块统一使用AGP 9.0.1内置Kotlin，不再重复应用KGP。\n+            buildFile.writeText(\n+                input\n+                    .replace(kotlinPlugin, \"\")\n+                    .replace(kotlinClasspath, \"\")\n+                    .replace(agpClasspath, if (buildFile.extension == \"kts\") \"\\$1classpath(\\\"com.android.tools.build:gradle:9.0.1\\\")\" else \"\\$1classpath 'com.android.tools.build:gradle:9.0.1'\")\n+            )\n+        }\n+\n         /**\n          * Performs configuration related to the plugin's Gradle [Project], including\n          * 1. Adding the plugin itself as a dependency to the main project.\n@@ -104,16 +129,28 @@\n                 requireNotNull(pluginObject[\"name\"] as? String) { \"Plugin name must be a string for plugin object: $pluginObject\" }\n             val pluginProject: Project = project.rootProject.findProject(\":$pluginName\") ?: return\n \n+            // Kotlin DSL compiles each plugin script with that plugin's buildscript classpath.\n+            // Publish the extension type there before evaluation so generated accessors stay typed.\n+            prepareBuiltInKotlinPluginScript(pluginProject)\n+            val flutterPluginClasspath = FlutterExtension::class.java.protectionDomain.codeSource.location.toURI()\n+            pluginProject.buildscript.dependencies.add(\"classpath\", pluginProject.files(flutterPluginClasspath))\n+\n             // Apply the \"flutter\" Gradle extension to plugins so that they can use it's vended\n             // compile/target/min sdk values.\n-            pluginProject.extensions.create(\"flutter\", FlutterExtension::class.java)\n+            pluginProject.pluginManager.withPlugin(\"com.android.library\") {\n+                val pluginFlutterExtensionClass =\n+                    pluginProject.buildscript.classLoader.loadClass(FlutterExtension::class.java.name)\n+                pluginProject.extensions.create(\"flutter\", pluginFlutterExtensionClass)\n+            }\n \n             // Add plugin dependency to the app project. We only want to add dependency\n             // for dev dependencies in non-release builds.\n             project.afterEvaluate {\n-                getLegacyAndroidExtension(project).buildTypes.forEach { buildType ->\n+                getAndroidExtension(project).buildTypes.forEach { buildType ->\n                     if (!(pluginObject[\"dev_dependency\"] as Boolean) || buildType.name != \"release\") {\n-                        project.dependencies.add(\"${buildType.name}Api\", pluginProject)\n+                        // AGP 9应用模块必须进入运行时类路径；library模块保留API传递给宿主。\n+                        val dependencyScope = if (isBuiltAsApp(project)) \"Implementation\" else \"Api\"\n+                        project.dependencies.add(\"${buildType.name}$dependencyScope\", pluginProject)\n                     }\n                 }\n             }\n@@ -135,7 +172,7 @@\n                     )\n                 }\n \n-                getLegacyAndroidExtension(project).buildTypes.forEach { buildType ->\n+                getAndroidExtension(project).buildTypes.forEach { buildType ->\n                     addEmbeddingDependencyToPlugin(project, pluginProject, buildType, engineVersion)\n                 }\n             }\n@@ -164,23 +201,15 @@\n             // This allows to build apps with plugins and custom build types or flavors.\n             // However, only copy if the plugin is also an app project, since library projects\n             // cannot have applicationIdSuffix and other app-specific properties.\n-            if (isBuiltAsApp(pluginProject)) {\n-                (getLegacyAndroidExtension(pluginProject).buildTypes as NamedDomainObjectContainer<dslBuildType>)\n-                    .addAll(getLegacyAndroidExtension(project).buildTypes as NamedDomainObjectContainer<dslBuildType>)\n-            } else {\n-                // For library projects, create compatible build types without app-specific properties\n-                getLegacyAndroidExtension(project).buildTypes.forEach { appBuildType ->\n-                    if (getLegacyAndroidExtension(pluginProject).buildTypes.findByName(appBuildType.name) == null) {\n-                        getLegacyAndroidExtension(pluginProject).buildTypes.create(appBuildType.name) {\n-                            // Copy library-compatible properties only\n-                            isDebuggable = appBuildType.isDebuggable\n-                            isMinifyEnabled = appBuildType.isMinifyEnabled\n-                            // Note: applicationIdSuffix and other app-specific properties are intentionally not copied\n-                        }\n-                    }\n-                }\n-            }\n-\n+            // 库模块只复制公开的共同属性，不把应用专属属性写入库扩展。\n+            getAndroidExtension(project).buildTypes.forEach { appBuildType ->\n+                val target = getAndroidExtension(pluginProject).buildTypes.maybeCreate(appBuildType.name)\n+                if (target is ApplicationBuildType && appBuildType is ApplicationBuildType) {\n+                    target.isDebuggable = appBuildType.isDebuggable\n+                }\n+                // Library插件不能先被R8裁空；仅应用插件继承宿主的压缩设置。\n+                target.isMinifyEnabled = isBuiltAsApp(pluginProject) && appBuildType.isMinifyEnabled\n+            }\n             // The embedding is API dependency of the plugin, so the AGP is able to desugar\n             // default method implementations when the interface is implemented by a plugin.\n             //\n@@ -215,7 +244,7 @@\n                 }\n             val pluginProject: Project = project.rootProject.findProject(\":$pluginName\") ?: return\n \n-            getLegacyAndroidExtension(project).buildTypes.forEach { buildType ->\n+            getAndroidExtension(project).buildTypes.forEach { buildType ->\n                 val flutterBuildMode: String = buildModeFor(buildType)\n                 if (flutterBuildMode == \"release\" && (pluginObject[\"dev_dependency\"] as? Boolean == true)) {\n                     // This plugin is a dev dependency will not be included in the\ndiff --git a/packages/flutter_tools/lib/src/android/gradle.dart b/packages/flutter_tools/lib/src/android/gradle.dart\nindex 84ea6ed0fc6f6b86128a220ba9a8830ad2bcd562f8791b9a9c237c29ffa0694e..b0707a83e5359f37073536654f78b8a5d08b94faf18ff40df4a0f52c550e0d74\n--- a/packages/flutter_tools/lib/src/android/gradle.dart\n+++ b/packages/flutter_tools/lib/src/android/gradle.dart\n@@ -41,8 +41,6 @@\n import 'java.dart';\n import 'migrations/android_studio_java_gradle_conflict_migration.dart';\n import 'migrations/cmake_android_16k_pages_migration.dart';\n-import 'migrations/disable_built_in_kotlin_migration.dart';\n-import 'migrations/disable_new_dsl_migration.dart';\n import 'migrations/min_sdk_version_migration.dart';\n import 'migrations/multidex_removal_migration.dart';\n import 'migrations/top_level_gradle_build_file_migration.dart';\n@@ -517,8 +515,6 @@\n       MinSdkVersionMigration(project.android, _logger),\n       MultidexRemovalMigration(project.android, _logger),\n       CmakeAndroid16kPagesMigration(project.android, _logger),\n-      DisableBuiltInKotlinMigration(project.android, _logger),\n-      DisableNewDslMigration(project.android, _logger),\n     ];\n \n     final migration = ProjectMigration(migrators);\ndiff --git a/packages/flutter_tools/lib/src/android/gradle_errors.dart b/packages/flutter_tools/lib/src/android/gradle_errors.dart\nindex 7a3ba07b414a806e949dcde01beeaa8128c68d3d7d090bc1b26b5245b074cc8b..d79d05bbbf71f3c85e6bb2e044cbcf1755ba83e2aeb91cf5b729795cae8bcb15\n--- a/packages/flutter_tools/lib/src/android/gradle_errors.dart\n+++ b/packages/flutter_tools/lib/src/android/gradle_errors.dart\n@@ -689,10 +689,6 @@\n const String kMigrateToBuiltInKotlinDocsUrl =\n     'https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin';\n \n-/// The URL for documentation on opting out of the new AGP DSL.\n-const String kOptOutOfNewDslDocsUrl =\n-    'https://developer.android.com/build/releases/agp-9-0-0-release-notes';\n-\n /// Handler when applying the kotlin-android plugin results in a build failure. This failure occurs when\n /// using AGP 9+ because built-in Kotlin has become the default behavior.\n @visibleForTesting\n@@ -715,9 +711,7 @@\n   eventLabel: 'applying-kotlin-android-plugin-error',\n );\n \n+/// 插件应用失败时保留真实报错；不得建议关闭新DSL来绕过修订验收。\n-/// Handler when using the new AGP DSL interfaces. Starting AGP 9+, only the new\n-/// DSL interfaces are used. This results in a failure because we still depend\n-/// on old DSL types.\n @visibleForTesting\n final useNewAgpDslErrorHandler = GradleHandledError(\n   test: _lineMatcher(const <String>[\n@@ -731,8 +725,7 @@\n           '''\n ${globals.logger.terminal.warningMark} Starting AGP 9+, only the new DSL interface will be read.\n This results in a build failure when applying the Flutter Gradle plugin at ${appGradleFile.path}.\n+\\nVerify the registered Flutter tool revision and inspect the original plugin error.\n-\\nTo resolve this update flutter or opt out of `android.newDsl`.\n-For instructions on how to opt out, see: $kOptOutOfNewDslDocsUrl\n \\nIf you are not upgrading to AGP 9+, run `flutter analyze --suggestions` to check for incompatible dependencies.''',\n           title: _boxTitle,\n         );\ndiff --git a/packages/flutter_tools/templates/app/android.tmpl/gradle.properties.tmpl b/packages/flutter_tools/templates/app/android.tmpl/gradle.properties.tmpl\nindex 0f82b18017fba6bb5ce3aa4b2d1a00c9382fc8aae7b1d9326e44b18abd66d80b..ce93cd30017008fa20352b9b8debd2554ee946d0ba993329dd251be0207f8dd8\n--- a/packages/flutter_tools/templates/app/android.tmpl/gradle.properties.tmpl\n+++ b/packages/flutter_tools/templates/app/android.tmpl/gradle.properties.tmpl\n@@ -1,6 +1,5 @@\n org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError\n android.useAndroidX=true\n+# 受控工具仅使用新DSL和内置Kotlin。\n+android.newDsl=true\n+android.builtInKotlin=true\n-# This newDsl flag was added by the Flutter template\n-android.newDsl=false\n-# This builtInKotlin flag was added by the Flutter template\n-android.builtInKotlin=false\ndiff --git a/packages/flutter_tools/templates/module/android/gradle/gradle.properties.tmpl b/packages/flutter_tools/templates/module/android/gradle/gradle.properties.tmpl\nindex 0f82b18017fba6bb5ce3aa4b2d1a00c9382fc8aae7b1d9326e44b18abd66d80b..ce93cd30017008fa20352b9b8debd2554ee946d0ba993329dd251be0207f8dd8\n--- a/packages/flutter_tools/templates/module/android/gradle/gradle.properties.tmpl\n+++ b/packages/flutter_tools/templates/module/android/gradle/gradle.properties.tmpl\n@@ -1,6 +1,5 @@\n org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError\n android.useAndroidX=true\n+# 受控工具仅使用新DSL和内置Kotlin。\n+android.newDsl=true\n+android.builtInKotlin=true\n-# This newDsl flag was added by the Flutter template\n-android.newDsl=false\n-# This builtInKotlin flag was added by the Flutter template\n-android.builtInKotlin=false\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginTest.kt b/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginTest.kt\nindex d275246cdbb7f3ddd6dba8fbbd355067ffa167c7de9ded33707c2f30f877f5a5..ae08e2e418eed63882e86852059a8cc25d7d831454cb912b2ddc33071c13ce1b\n--- a/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginTest.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginTest.kt\n@@ -1,342 +1,63 @@\n+// Copyright 2014 The Flutter Authors. All rights reserved.\n+// Use of this source code is governed by a BSD-style license that can be\n+// found in the LICENSE file.\n+\n package com.flutter.gradle\n \n+import com.android.build.api.variant.BuiltArtifactsLoader\n+import com.android.build.api.variant.BuiltArtifacts\n+import com.android.build.api.variant.BuiltArtifact\n-import com.android.build.api.dsl.ApplicationBuildType\n-import com.android.build.api.dsl.ApplicationDefaultConfig\n-import com.android.build.api.dsl.ApplicationExtension\n-import com.android.build.api.dsl.CommonExtension\n-import com.android.build.api.dsl.LibraryExtension\n-import com.android.build.api.variant.AndroidComponentsExtension\n-import com.android.build.gradle.AbstractAppExtension\n-import com.android.build.gradle.BaseExtension\n-import com.android.build.gradle.api.AndroidSourceDirectorySet\n-import com.android.build.gradle.internal.core.InternalBaseVariant\n-import com.android.build.gradle.tasks.MergeSourceSetFolders\n-import com.android.build.gradle.tasks.ProcessAndroidResources\n-import com.flutter.gradle.tasks.FlutterTask\n-import com.flutter.gradle.tasks.PrintTask\n import io.mockk.every\n import io.mockk.mockk\n-import io.mockk.mockkObject\n-import io.mockk.slot\n-import io.mockk.verify\n-import org.gradle.api.Action\n-import org.gradle.api.Project\n-import org.gradle.api.Task\n import org.gradle.api.file.Directory\n+import org.gradle.testfixtures.ProjectBuilder\n-import org.gradle.api.tasks.Copy\n-import org.gradle.api.tasks.TaskContainer\n-import org.gradle.api.tasks.TaskProvider\n-import org.jetbrains.kotlin.gradle.plugin.extraProperties\n-import org.junit.jupiter.api.Assertions.fail\n import org.junit.jupiter.api.io.TempDir\n import java.nio.file.Path\n-import kotlin.io.path.writeText\n import kotlin.test.Test\n+import kotlin.test.assertEquals\n+import kotlin.test.assertFailsWith\n+import kotlin.test.assertTrue\n-import kotlin.test.assertContains\n \n class FlutterPluginTest {\n     @Test\n+    fun `APK任务从公开输出清单读取且缺失清单时失败`(@TempDir root: Path) {\n+        val project = ProjectBuilder.builder().withProjectDir(root.toFile()).build()\n+        val input = root.resolve(\"apk\").toFile().apply { mkdirs() }\n+        val apk = input.resolve(\"upstream-name.apk\").apply { writeText(\"verified fixture\") }\n+        val task = project.tasks.register(\"copyFlutterApkRelease\", FlutterApkTask::class.java).get()\n+        task.inputDirectory.set(input)\n+        task.destinationDirectory.set(root.resolve(\"output\").toFile())\n+        task.buildMode.set(\"release\")\n+        task.flavor.set(\"Shop\")\n+        val metadata = mockk<BuiltArtifacts>()\n+        val artifact = mockk<BuiltArtifact>()\n+        every { artifact.outputFile } returns apk.absolutePath\n+        every { artifact.filters } returns emptyList()\n+        every { metadata.elements } returns listOf(artifact)\n+        val loader = mockk<BuiltArtifactsLoader>()\n+        every { loader.load(any<Directory>()) } returns metadata\n+        task.loader.set(loader)\n+        task.copyApks()\n+        val result = root.resolve(\"output/app-shop-release.apk\").toFile()\n+        assertEquals(\"verified fixture\", result.readText())\n+        every { loader.load(any<Directory>()) } returns null\n+        assertFailsWith<IllegalArgumentException> { task.copyApks() }\n+        assertEquals(\"verified fixture\", result.readText())\n-    fun `FlutterPlugin apply() adds expected tasks`(\n-        @TempDir tempDir: Path\n-    ) {\n-        val projectDir = tempDir.resolve(\"project-dir\").resolve(\"android\").resolve(\"app\")\n-        projectDir.toFile().mkdirs()\n-        val settingsFile = projectDir.parent.resolve(\"settings.gradle\")\n-        settingsFile.writeText(\"empty for now\")\n-        val fakeFlutterSdkDir = tempDir.resolve(\"fake-flutter-sdk\")\n-        fakeFlutterSdkDir.toFile().mkdirs()\n-        val fakeCacheDir = fakeFlutterSdkDir.resolve(\"bin\").resolve(\"cache\")\n-        fakeCacheDir.toFile().mkdirs()\n-        val fakeEngineStampFile = fakeCacheDir.resolve(\"engine.stamp\")\n-        fakeEngineStampFile.writeText(FAKE_ENGINE_STAMP)\n-        val fakeEngineRealmFile = fakeCacheDir.resolve(\"engine.realm\")\n-        fakeEngineRealmFile.writeText(FAKE_ENGINE_REALM)\n-        val project = mockk<Project>(relaxed = true)\n-        val mockAbstractAppExtension =\n-            mockk<AbstractAppExtension>(\n-                moreInterfaces = arrayOf(ApplicationExtension::class),\n-                relaxed = true\n-            )\n-        val mockLibraryExtension = mockk<LibraryExtension>(relaxed = true)\n-        every { project.extensions.findByType(AbstractAppExtension::class.java) } returns mockAbstractAppExtension\n-        val mockAndroidComponentsExtension = mockk<AndroidComponentsExtension<*, *, *>>(relaxed = true)\n-        every { project.extensions.getByType(AndroidComponentsExtension::class.java) } returns mockAndroidComponentsExtension\n-        every { project.extensions.findByType(AndroidComponentsExtension::class.java) } returns mockAndroidComponentsExtension\n-        val mockSelector = mockk<com.android.build.api.variant.VariantSelector>(relaxed = true)\n-        every { mockAndroidComponentsExtension.selector() } returns mockSelector\n-        every { mockSelector.all() } returns mockSelector\n-        every { mockSelector.withName(any<String>()) } returns mockSelector\n-        every { project.extensions.getByType(AbstractAppExtension::class.java) } returns mockAbstractAppExtension\n-        every { project.extensions.getByType(LibraryExtension::class.java) } returns mockLibraryExtension\n-        every { project.extensions.findByName(\"android\") } returns mockAbstractAppExtension\n-        every { project.projectDir } returns projectDir.toFile()\n-        every { project.findProperty(\"flutter.sdk\") } returns fakeFlutterSdkDir.toString()\n-        every { project.file(fakeFlutterSdkDir.toString()) } returns fakeFlutterSdkDir.toFile()\n-        val flutterExtension = FlutterExtension()\n-        every { project.extensions.create(\"flutter\", any<Class<*>>()) } returns flutterExtension\n-        every { project.extensions.findByType(FlutterExtension::class.java) } returns flutterExtension\n-        val mockBaseExtension = mockk<BaseExtension>(relaxed = true)\n-        val mockCommonExtension = mockk<CommonExtension<*, *, *, *, *, *>>(relaxed = true)\n-        val mockDebugBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>(relaxed = true)\n-        val mockReleaseBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>(relaxed = true)\n-\n-        // Cast our multi-interface mock instead of creating a brand new one\n-        val mockApplicationExtension = mockAbstractAppExtension as ApplicationExtension\n-\n-        // Mock buildTypes on our new dual-purpose mock so AgpCommonExtensionWrapper can read them\n-        every { mockApplicationExtension.buildTypes.getByName(\"debug\") } returns mockDebugBuildType\n-        every { mockApplicationExtension.buildTypes.getByName(\"release\") } returns mockReleaseBuildType\n-\n-        // Keep the CommonExtension mocks just in case other parts of the plugin look for it\n-        every { mockCommonExtension.buildTypes.getByName(\"debug\") } returns mockDebugBuildType\n-        every { mockCommonExtension.buildTypes.getByName(\"release\") } returns mockReleaseBuildType\n-\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { project.extensions.findByType(CommonExtension::class.java) } returns mockCommonExtension\n-\n-        // Pass the dual-purpose mock for any ApplicationExtension lookups\n-        every { project.extensions.findByType(ApplicationExtension::class.java) } returns mockApplicationExtension\n-        every { project.extensions.getByType(ApplicationExtension::class.java) } returns mockApplicationExtension\n-\n-        val mockApplicationDefaultConfig =\n-            mockk<com.android.build.gradle.internal.dsl.DefaultConfig>(\n-                moreInterfaces = arrayOf(ApplicationDefaultConfig::class),\n-                relaxed = true\n-            )\n-        every { mockApplicationExtension.defaultConfig } returns mockApplicationDefaultConfig\n-        every { project.rootProject } returns project\n-        every { project.state.failure as Throwable? } returns null\n-        val mockDirectory = mockk<Directory>(relaxed = true)\n-        every { project.layout.buildDirectory.get() } returns mockDirectory\n-        val mockAndroidSourceSet = mockk<com.android.build.gradle.api.AndroidSourceSet>(relaxed = true)\n-        val mockAndroidSourceDirectorySet = mockk<AndroidSourceDirectorySet>(relaxed = true)\n-        every { mockAndroidSourceSet.jniLibs.srcDir(any()) } returns mockAndroidSourceDirectorySet\n-        every { mockAbstractAppExtension.sourceSets.getByName(\"main\") } returns mockAndroidSourceSet\n-        // mock return of NativePluginLoaderReflectionBridge.getPlugins\n-        mockkObject(NativePluginLoaderReflectionBridge)\n-        every { NativePluginLoaderReflectionBridge.getPlugins(any(), any()) } returns\n-            listOf()\n-        // mock method calls that are invoked by the args to NativePluginLoaderReflectionBridge\n-        every { project.extraProperties } returns mockk()\n-        every { project.file(flutterExtension.source!!) } returns mockk()\n-        val flutterPlugin = FlutterPlugin()\n-        flutterPlugin.apply(project)\n-\n-        verify { project.tasks.register(\"generateLockfiles\", any()) }\n-        val registeredPrintTasks = mutableListOf<String>()\n-        verify {\n-            project.tasks.register(capture(registeredPrintTasks), PrintTask::class.java, any())\n-        }\n-\n-        assertContains(registeredPrintTasks, \"javaVersion\")\n-        assertContains(registeredPrintTasks, \"kgpVersion\")\n-        assertContains(registeredPrintTasks, \"printBuildVariants\")\n-        assertContains(registeredPrintTasks, \"printNdkVersion\")\n     }\n \n     @Test\n+    fun `资源任务只写自己的生成目录并保存Flutter目录层级`(@TempDir root: Path) {\n+        val project = ProjectBuilder.builder().withProjectDir(root.toFile()).build()\n+        val input = root.resolve(\"input\").toFile().apply { mkdirs() }\n+        input.resolve(\"AssetManifest.bin\").writeText(\"asset fixture\")\n+        val other = root.resolve(\"other\").toFile().apply { mkdirs() }\n+        other.resolve(\"keep\").writeText(\"other task\")\n+        val task = project.tasks.register(\"copyFlutterAssetsRelease\", FlutterAssetsTask::class.java).get()\n+        task.destinationDirectory.set(root.resolve(\"output\").toFile())\n+        task.from(input) { into(\"flutter_assets\") }\n+        task.into(task.destinationDirectory)\n+        task.actions.forEach { it.execute(task) }\n+        assertTrue(root.resolve(\"output/flutter_assets/AssetManifest.bin\").toFile().isFile)\n+        assertEquals(\"other task\", other.resolve(\"keep\").readText())\n-    fun `copyFlutterAssets task sets filePermissions correctly`(\n-        @TempDir tempDir: Path\n-    ) {\n-        val projectDir = tempDir.resolve(\"project-dir\").resolve(\"android\").resolve(\"app\")\n-        projectDir.toFile().mkdirs()\n-        val settingsFile = projectDir.parent.resolve(\"settings.gradle\")\n-        settingsFile.writeText(\"empty for now\")\n-        val fakeFlutterSdkDir = tempDir.resolve(\"fake-flutter-sdk\")\n-        fakeFlutterSdkDir.toFile().mkdirs()\n-        val fakeCacheDir = fakeFlutterSdkDir.resolve(\"bin\").resolve(\"cache\")\n-        fakeCacheDir.toFile().mkdirs()\n-        val fakeEngineStampFile = fakeCacheDir.resolve(\"engine.stamp\")\n-        fakeEngineStampFile.writeText(FAKE_ENGINE_STAMP)\n-        val fakeEngineRealmFile = fakeCacheDir.resolve(\"engine.realm\")\n-        fakeEngineRealmFile.writeText(FAKE_ENGINE_REALM)\n-        val project = mockk<Project>(relaxed = true)\n-        val mockAbstractAppExtension =\n-            mockk<AbstractAppExtension>(\n-                moreInterfaces = arrayOf(ApplicationExtension::class),\n-                relaxed = true\n-            )\n-        every { project.extensions.findByType(AbstractAppExtension::class.java) } returns mockAbstractAppExtension\n-        every { project.extensions.getByType(AbstractAppExtension::class.java) } returns mockAbstractAppExtension\n-        every { project.extensions.findByName(\"android\") } returns mockAbstractAppExtension\n-        val mockAndroidComponentsExtension = mockk<AndroidComponentsExtension<*, *, *>>(relaxed = true)\n-        every { project.extensions.getByType(AndroidComponentsExtension::class.java) } returns mockAndroidComponentsExtension\n-        every { project.extensions.findByType(AndroidComponentsExtension::class.java) } returns mockAndroidComponentsExtension\n-        val mockSelector = mockk<com.android.build.api.variant.VariantSelector>(relaxed = true)\n-        every { mockAndroidComponentsExtension.selector() } returns mockSelector\n-        every { mockSelector.all() } returns mockSelector\n-        every { mockSelector.withName(any<String>()) } returns mockSelector\n-        every { project.projectDir } returns projectDir.toFile()\n-        every { project.findProperty(\"flutter.sdk\") } returns fakeFlutterSdkDir.toString()\n-        every { project.file(fakeFlutterSdkDir.toString()) } returns fakeFlutterSdkDir.toFile()\n-        val flutterExtension = FlutterExtension()\n-        every { project.extensions.create(\"flutter\", any<Class<*>>()) } returns flutterExtension\n-        every { project.extensions.findByType(FlutterExtension::class.java) } returns flutterExtension\n-        val mockBaseExtension = mockk<BaseExtension>(relaxed = true)\n-        val mockCommonExtension = mockk<CommonExtension<*, *, *, *, *, *>>(relaxed = true)\n-        val mockDebugBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>(relaxed = true)\n-        val mockReleaseBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>(relaxed = true)\n-\n-        // Cast our multi-interface mock instead of creating a brand new one\n-        val mockApplicationExtension = mockAbstractAppExtension as ApplicationExtension\n-\n-        // Mock buildTypes on our new dual-purpose mock so AgpCommonExtensionWrapper can read them\n-        every { mockApplicationExtension.buildTypes.getByName(\"debug\") } returns mockDebugBuildType\n-        every { mockApplicationExtension.buildTypes.getByName(\"release\") } returns mockReleaseBuildType\n-\n-        // Keep the CommonExtension mocks just in case other parts of the plugin look for it\n-        every { mockCommonExtension.buildTypes.getByName(\"debug\") } returns mockDebugBuildType\n-        every { mockCommonExtension.buildTypes.getByName(\"release\") } returns mockReleaseBuildType\n-\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { project.extensions.findByType(CommonExtension::class.java) } returns mockCommonExtension\n-\n-        // Pass the dual-purpose mock for any ApplicationExtension lookups\n-        every { project.extensions.findByType(ApplicationExtension::class.java) } returns mockApplicationExtension\n-        every { project.extensions.getByType(ApplicationExtension::class.java) } returns mockApplicationExtension\n-\n-        val mockApplicationDefaultConfig =\n-            mockk<com.android.build.gradle.internal.dsl.DefaultConfig>(\n-                moreInterfaces = arrayOf(ApplicationDefaultConfig::class),\n-                relaxed = true\n-            )\n-        every { mockApplicationExtension.defaultConfig } returns mockApplicationDefaultConfig\n-        every { project.rootProject } returns project\n-        every { project.state.failure as Throwable? } returns null\n-        val mockDirectory = mockk<Directory>(relaxed = true)\n-        every { project.layout.buildDirectory.get() } returns mockDirectory\n-        val mockAndroidSourceSet = mockk<com.android.build.gradle.api.AndroidSourceSet>(relaxed = true)\n-        val mockAndroidSourceDirectorySet = mockk<AndroidSourceDirectorySet>(relaxed = true)\n-        every { mockAndroidSourceSet.jniLibs.srcDir(any()) } returns mockAndroidSourceDirectorySet\n-        every { mockAbstractAppExtension.sourceSets.getByName(\"main\") } returns mockAndroidSourceSet\n-        // mock return of NativePluginLoaderReflectionBridge.getPlugins\n-        mockkObject(NativePluginLoaderReflectionBridge)\n-        every { NativePluginLoaderReflectionBridge.getPlugins(any(), any()) } returns\n-            listOf()\n-        // mock method calls that are invoked by the args to NativePluginLoaderReflectionBridge\n-        every { project.extraProperties } returns mockk()\n-        every { project.file(flutterExtension.source!!) } returns mockk()\n-        // Set up the task container and our task capture\n-        val taskContainer = mockk<TaskContainer>(relaxed = true)\n-        every { project.tasks } returns taskContainer\n-        val copyTaskActionCaptor = slot<Action<Copy>>()\n-        val copyTask = mockk<Copy>(relaxed = true)\n-        val mockVariant = mockk<com.android.build.gradle.api.ApplicationVariant>(relaxed = true)\n-        every { mockVariant.name } returns \"debug\"\n-        every { mockVariant.buildType.name } returns \"debug\"\n-        every { mockVariant.flavorName } returns \"\"\n-        val mergedFlavor = mockk<InternalBaseVariant.MergedFlavor>(relaxed = true)\n-        every { mockVariant.mergedFlavor } returns mergedFlavor\n-        val apiLevel = mockk<com.android.builder.model.ApiVersion>(relaxed = true)\n-        every { apiLevel.apiLevel } returns 21\n-        every { mergedFlavor.minSdkVersion } returns apiLevel\n-        val variantOutput = mockk<com.android.build.gradle.api.BaseVariantOutput>(relaxed = true)\n-        val outputsIterator = mockk<MutableIterator<com.android.build.gradle.api.BaseVariantOutput>>()\n-        every { outputsIterator.hasNext() } returns true andThen false\n-        every { outputsIterator.next() } returns variantOutput\n-        val variantOutputCollection = mockk<org.gradle.api.DomainObjectCollection<com.android.build.gradle.api.BaseVariantOutput>>()\n-        every { variantOutputCollection.iterator() } returns outputsIterator\n-        every { mockVariant.outputs } returns variantOutputCollection\n-        val processResourcesProvider = mockk<TaskProvider<ProcessAndroidResources>>(relaxed = true)\n-        every { processResourcesProvider.hint(ProcessAndroidResources::class).get() } returns mockk<ProcessAndroidResources>(relaxed = true)\n-        every { variantOutput.processResourcesProvider } returns processResourcesProvider\n-        val assembleTask = mockk<Task>(relaxed = true)\n-        val assembleTaskProvider = mockk<TaskProvider<Task>>(relaxed = true)\n-        every { assembleTaskProvider.get() } returns assembleTask\n-        every { mockVariant.assembleProvider } returns assembleTaskProvider\n-        val variants = listOf(mockVariant)\n-        val variantsIterator = mockk<MutableIterator<com.android.build.gradle.api.ApplicationVariant>>()\n-        every { variantsIterator.hasNext() } returns true andThen false\n-        every { variantsIterator.next() } returns mockVariant\n-        val variantCollection = mockk<org.gradle.api.DomainObjectSet<com.android.build.gradle.api.ApplicationVariant>>()\n-        every { mockAbstractAppExtension.applicationVariants } returns variantCollection\n-        every { variantCollection.iterator() } returns variantsIterator\n-        every {\n-            variantCollection.configureEach(any<Action<com.android.build.gradle.api.ApplicationVariant>>())\n-        } answers {\n-            variants.forEach { firstArg<Action<com.android.build.gradle.api.ApplicationVariant>>().execute(it) }\n-        }\n-        every { mockVariant.mergeAssetsProvider.hint(MergeSourceSetFolders::class).get() } returns\n-            mockk<MergeSourceSetFolders>(relaxed = true)\n-        val flutterTask = mockk<FlutterTask>(relaxed = true)\n-        val copySpec = mockk<org.gradle.api.file.CopySpec>(relaxed = true)\n-        every {\n-            (flutterTask).assets\n-        } returns copySpec\n-        val flutterTaskProvider = mockk<TaskProvider<FlutterTask>>(relaxed = true)\n-        every {\n-            flutterTaskProvider.hint(FlutterTask::class).get()\n-        } returns flutterTask\n-        every {\n-            taskContainer.register(\n-                match { it.contains(\"compileFlutterBuild\") },\n-                any<Class<FlutterTask>>(),\n-                any()\n-            )\n-        } answers {\n-            flutterTaskProvider\n-        }\n-        // Actual task that should be captured to test if permissions have been set\n-        val mockCopyTaskProvider = mockk<TaskProvider<Copy>>(relaxed = true)\n-        every { mockCopyTaskProvider.hint(Copy::class).get() } returns copyTask\n-        every {\n-            taskContainer.register(\n-                match { it.startsWith(\"copyFlutterAssets\") },\n-                eq(Copy::class.java),\n-                capture(copyTaskActionCaptor)\n-            )\n-        } answers {\n-            mockCopyTaskProvider\n-        }\n-        val mockJarTaskProvider = mockk<TaskProvider<org.gradle.api.tasks.bundling.Jar>>(relaxed = true)\n-        every { mockJarTaskProvider.hint(org.gradle.api.tasks.bundling.Jar::class).get() } returns\n-            mockk<org.gradle.api.tasks.bundling.Jar>(relaxed = true)\n-        every {\n-            taskContainer.register(\n-                match { it.contains(\"packJniLibs\") },\n-                eq(org.gradle.api.tasks.bundling.Jar::class.java),\n-                any()\n-            )\n-        } answers {\n-            mockJarTaskProvider\n-        }\n-        val mockTaskProvider = mockk<TaskProvider<Task>>(relaxed = true)\n-        every { mockTaskProvider.hint(Task::class).get() } returns mockk<Task>(relaxed = true)\n-        every {\n-            taskContainer.named(any<String>())\n-        } returns mockTaskProvider\n-        val flutterPlugin = FlutterPlugin()\n-        flutterPlugin.apply(project)\n-\n-        copyTaskActionCaptor.captured.execute(copyTask)\n-        val filePermissionsActionCaptor = slot<Action<org.gradle.api.file.ConfigurableFilePermissions>>()\n-        verify {\n-            copyTask.filePermissions(capture(filePermissionsActionCaptor))\n-        }\n-        if (filePermissionsActionCaptor.isCaptured) {\n-            val mockFilePermissionSet = mockk<org.gradle.api.file.ConfigurableFilePermissions>(relaxed = true)\n-            filePermissionsActionCaptor.captured.execute(mockFilePermissionSet)\n-            val userPermissionsActionCaptor = slot<Action<org.gradle.api.file.ConfigurableUserClassFilePermissions>>()\n-            verify {\n-                mockFilePermissionSet.user(capture(userPermissionsActionCaptor))\n-            }\n-            if (userPermissionsActionCaptor.isCaptured) {\n-                val mockUserPermission = mockk<org.gradle.api.file.ConfigurableUserClassFilePermissions>(relaxed = true)\n-                userPermissionsActionCaptor.captured.execute(mockUserPermission)\n-                verify {\n-                    mockUserPermission.read = true\n-                    mockUserPermission.write = true\n-                }\n-            } else {\n-                fail(\"User permissions configuration action was not captured\")\n-            }\n-        } else {\n-            fail(\"FilePermissions configuration action was not captured\")\n-        }\n     }\n-\n-    companion object {\n-        const val FAKE_ENGINE_STAMP = \"901b0f1afe77c3555abee7b86a26aaa37f131379\"\n-        const val FAKE_ENGINE_REALM = \"made_up_realm\"\n-    }\n }\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/VersionFetcherTest.kt b/packages/flutter_tools/gradle/src/test/kotlin/VersionFetcherTest.kt\nindex 47acb2223475b9b6aa230f524982c49b457cfa9d05aa74d57f597db9357adf60..6c80f5e445f94f211d5d86be4ac534c3d9d85bd2b2a71ed71d111dd3a80bc301\n--- a/packages/flutter_tools/gradle/src/test/kotlin/VersionFetcherTest.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/VersionFetcherTest.kt\n@@ -6,65 +6,42 @@\n \n import com.android.build.api.AndroidPluginVersion\n import com.android.build.api.variant.AndroidComponentsExtension\n-import com.flutter.gradle.testing.setAgpKotlinVersionToNull\n import io.mockk.every\n import io.mockk.mockk\n+import io.mockk.mockkStatic\n+import io.mockk.unmockkStatic\n import org.gradle.api.Project\n+import org.jetbrains.kotlin.gradle.plugin.getKotlinPluginVersion\n-import org.jetbrains.kotlin.gradle.plugin.KotlinAndroidPluginWrapper\n import kotlin.test.Test\n import kotlin.test.assertEquals\n+import kotlin.test.assertFailsWith\n \n class VersionFetcherTest {\n-    // getGradleVersion\n     @Test\n+    fun `Gradle版本从实际运行对象读取`() {\n-    fun `getGradleVersion returns version when gradleVersion is set`() {\n-        val gradleVersion = Version(1, 9, 20)\n         val project = mockk<Project>()\n+        every { project.gradle.gradleVersion } returns \"9.1.0\"\n+        assertEquals(Version(9, 1, 0), VersionFetcher.getGradleVersion(project))\n-        every { project.gradle.gradleVersion } returns gradleVersion.toString()\n-        assertEquals(VersionFetcher.getGradleVersion(project), gradleVersion)\n     }\n \n     @Test\n+    fun `AGP版本从公开组件扩展读取`() {\n-    fun `getGradleVersion returns version when gradleVersion has hyphen`() {\n         val project = mockk<Project>()\n+        val extension = mockk<AndroidComponentsExtension<*, *, *>>()\n+        every { project.extensions.findByType(AndroidComponentsExtension::class.java) } returns extension\n+        every { extension.pluginVersion } returns AndroidPluginVersion(9, 0, 1)\n+        assertEquals(AndroidPluginVersion(9, 0, 1), VersionFetcher.getAGPVersion(project))\n-        every { project.gradle.gradleVersion } returns \"2.1.20-2\"\n-        assertEquals(VersionFetcher.getGradleVersion(project), Version(2, 1, 20))\n     }\n \n-    // getAGPVersion\n     @Test\n+    fun `Kotlin版本仅从已加载插件的公开接口读取`() {\n-    fun `getAGPVersion returns version when agpVersion is set`() {\n-        val agpVersion = AndroidPluginVersion(8, 3, 0)\n         val project = mockk<Project>()\n+        mockkStatic(\"org.jetbrains.kotlin.gradle.plugin.KotlinPluginWrapperKt\")\n+        try {\n+            every { project.getKotlinPluginVersion() } returns \"2.2.20\"\n+            assertEquals(Version(2, 4, 10), VersionFetcher.getKGPVersion(project))\n+            every { project.getKotlinPluginVersion() } throws IllegalStateException(\"invalid plugin\")\n+            assertFailsWith<IllegalStateException> { VersionFetcher.getKGPVersion(project) }\n+        } finally { unmockkStatic(\"org.jetbrains.kotlin.gradle.plugin.KotlinPluginWrapperKt\") }\n-        val mockAndroidComponentsExtension = mockk<AndroidComponentsExtension<*, *, *>>()\n-        every { project.extensions.findByType(AndroidComponentsExtension::class.java) } returns mockAndroidComponentsExtension\n-        every { mockAndroidComponentsExtension.pluginVersion } returns agpVersion\n-        assertEquals(VersionFetcher.getAGPVersion(project).toString(), agpVersion.toString())\n     }\n-\n-    // getKGPVersion\n-    @Test\n-    fun `getKGPVersion returns version when kotlin_version is set`() {\n-        val kgpVersion = Version(1, 9, 20)\n-        val project = mockk<Project>()\n-        setAgpKotlinVersionToNull(project)\n-        every { project.hasProperty(eq(\"kotlin_version\")) } returns true\n-        every { project.properties[\"kotlin_version\"] } returns kgpVersion.toString()\n-        val result = VersionFetcher.getKGPVersion(project)\n-        assertEquals(kgpVersion, result!!)\n-    }\n-\n-    @Test\n-    fun `getKGPVersion returns version from KotlinAndroidPluginWrapper`() {\n-        val kgpVersion = Version(1, 9, 20)\n-        val project = mockk<Project>()\n-        setAgpKotlinVersionToNull(project)\n-        every { project.hasProperty(eq(\"kotlin_version\")) } returns false\n-        every { project.plugins.findPlugin(KotlinAndroidPluginWrapper::class.java) } returns\n-            mockk<KotlinAndroidPluginWrapper> {\n-                every { pluginVersion } returns kgpVersion.toString()\n-            }\n-        val result = VersionFetcher.getKGPVersion(project)\n-        assertEquals(kgpVersion, result!!)\n-    }\n }\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginUtilsTest.kt b/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginUtilsTest.kt\nindex d595101c31d071fd2f4cca3ddae33d59d7e13f4b3bf2c4c897d88a7db72cbbda..52d0d9d2eb6ca5de164b69a2916bd293d5bb16a2abc706ee5a9cb37884997021\n--- a/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginUtilsTest.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/FlutterPluginUtilsTest.kt\n@@ -9,10 +9,10 @@\n import com.android.build.api.variant.AndroidComponentsExtension\n import com.android.build.api.variant.Variant\n import com.android.build.api.variant.VariantBuilder\n+import com.android.build.api.dsl.CommonExtension\n+import com.android.build.api.dsl.Cmake\n+import com.android.build.api.dsl.DefaultConfig\n+import com.android.build.api.dsl.ApplicationBuildType\n-import com.android.build.gradle.BaseExtension\n-import com.android.build.gradle.internal.dsl.CmakeOptions\n-import com.android.build.gradle.internal.dsl.DefaultConfig\n-import com.android.builder.model.BuildType\n import com.flutter.gradle.FlutterPluginUtils.BUILT_IN_KOTLIN_DOCS\n import com.flutter.gradle.FlutterPluginUtils.BUILT_IN_KOTLIN_DOCS_FOR_APPS\n import com.flutter.gradle.FlutterPluginUtils.BUILT_IN_KOTLIN_DOCS_FOR_PLUGINS\n@@ -500,8 +500,8 @@\n \n     // buildModeFor\n     @Test\n+    fun `buildModeFor returns profile if the ApplicationBuildType has name profile`() {\n+        val buildType = mockk<ApplicationBuildType>()\n-    fun `buildModeFor returns profile if the BuildType has name profile`() {\n-        val buildType = mockk<BuildType>()\n         every { buildType.name } returns \"profile\"\n \n         val result = FlutterPluginUtils.buildModeFor(buildType)\n@@ -509,8 +509,8 @@\n     }\n \n     @Test\n+    fun `buildModeFor returns debug if the ApplicationBuildType is debuggable`() {\n+        val buildType = mockk<ApplicationBuildType>()\n-    fun `buildModeFor returns debug if the BuildType is debuggable`() {\n-        val buildType = mockk<BuildType>()\n         every { buildType.name } returns \"something random\"\n         every { buildType.isDebuggable } returns true\n \n@@ -519,8 +519,8 @@\n     }\n \n     @Test\n+    fun `buildModeFor returns release if the ApplicationBuildType is not debuggable and not named profile`() {\n+        val buildType = mockk<ApplicationBuildType>()\n-    fun `buildModeFor returns release if the BuildType is not debuggable and not named profile`() {\n-        val buildType = mockk<BuildType>()\n         every { buildType.isDebuggable } returns false\n         every { buildType.name } returns \"something random\"\n \n@@ -616,7 +616,8 @@\n     @Test\n     fun `getCompileSdkFromProject returns the compileSdk from the project`() {\n         val project = mockk<Project>()\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n         val result = FlutterPluginUtils.getCompileSdkFromProject(project)\n         assertEquals(\"35\", result)\n     }\n@@ -1874,24 +1875,24 @@\n         val fakeCmakeFile = tempDir.resolve(\"CMakeLists.txt\").toFile()\n         fakeCmakeFile.createNewFile()\n         val project = mockk<Project>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n         every { project.extensions.findByType(ApplicationExtension::class.java) } returns null\n         every {\n             project.extensions\n+                .getByType(CommonExtension::class.java)\n-                .findByType(BaseExtension::class.java)!!\n                 .externalNativeBuild.cmake\n+        } returns mockCmake\n+        every { project.extensions.getByType(CommonExtension::class.java).defaultConfig } returns mockDefaultConfig\n-        } returns mockCmakeOptions\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.defaultConfig } returns mockDefaultConfig\n \n+        every { mockCmake.path } returns fakeCmakeFile\n-        every { mockCmakeOptions.path } returns fakeCmakeFile\n \n         FlutterPluginUtils.forceNdkDownload(project, \"ignored\")\n \n         verify(exactly = 1) {\n+            mockCmake.path\n-            mockCmakeOptions.path\n         }\n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.setPath(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -1905,14 +1906,14 @@\n         val mockExecSpec = mockk<ExecSpec>()\n         val mockExecResult = mockk<ExecResult>()\n         val mockExecOperations = mockk<ExecOperations>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n-        val mockBaseExtension = mockk<BaseExtension>()\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns tempDir.toString()\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"\"\n@@ -1945,7 +1946,7 @@\n                 )\n             )\n         }\n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -1953,14 +1954,14 @@\n     fun `forceNdkDownload skips sdkmanager install when the requested ndk is already installed`() {\n         val project = mockk<Project>()\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n-        val mockBaseExtension = mockk<BaseExtension>()\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns \"/sdk/root\"\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"29.0.13846066\"\n@@ -1970,7 +1971,7 @@\n         FlutterPluginUtils.forceNdkDownload(project, \"/base/path\")\n         finalizeDslSlot.captured.invoke(Any())\n \n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -1980,20 +1981,20 @@\n     ) {\n         val project = mockk<Project>()\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n         val mockDirectoryProperty = mockk<DirectoryProperty>()\n         val mockDirectory = mockk<Directory>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         var cmakePath: File? = null\n         every { project.extensions.findByType(ApplicationExtension::class.java) } returns null\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } answers { cmakePath }\n+        every { mockCmake.path(any()) } returns Unit\n+        every { mockCmake.buildStagingDirectory(any()) } returns Unit\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } answers { cmakePath }\n-        every { mockCmakeOptions.path(any()) } returns Unit\n-        every { mockCmakeOptions.buildStagingDirectory(any()) } returns Unit\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns \"/sdk/root\"\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"\"\n@@ -2003,8 +2004,8 @@\n         every { mockDirectoryProperty.get() } returns mockDirectory\n         every { mockDirectory.asFile.path } returns \"/randomapp/build/app/\"\n \n+        val mockBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n+        every { mockCommonExtension.buildTypes.iterator() } returns mutableListOf(mockBuildType).iterator()\n-        val mockBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n-        every { mockBaseExtension.buildTypes.iterator() } returns mutableListOf(mockBuildType).iterator()\n         every { mockBuildType.name } returns \"Debug\"\n         every { mockBuildType.externalNativeBuild.cmake.arguments(any(), any(), any()) } returns Unit\n \n@@ -2013,11 +2014,11 @@\n         finalizeDslSlot.captured.invoke(Any())\n \n         verify(exactly = 0) {\n+            mockCmake.path(\n-            mockCmakeOptions.path(\n                 \"/base/path/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\"\n             )\n         }\n+        verify(exactly = 0) { mockCmake.buildStagingDirectory(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.buildStagingDirectory(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -2031,15 +2032,15 @@\n         val mockExecSpec = mockk<ExecSpec>()\n         val mockExecResult = mockk<ExecResult>()\n         val mockExecOperations = mockk<ExecOperations>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         var configuredNdkVersion = \"26.3.11579264\"\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } answers { configuredNdkVersion }\n+        every { mockCmake.path } returns null\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } answers { configuredNdkVersion }\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns tempDir.toString()\n         every {\n@@ -2075,7 +2076,7 @@\n                 )\n             )\n         }\n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -2089,24 +2090,20 @@\n         val mockExecSpec = mockk<ExecSpec>()\n         val mockExecResult = mockk<ExecResult>()\n         val mockExecOperations = mockk<ExecOperations>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         val mockApplicationExtension = mockk<ApplicationExtension>()\n         var configuredNdkVersion = \"26.3.11579264\"\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n         every {\n             project.extensions.findByType(ApplicationExtension::class.java)\n         } returns mockApplicationExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } answers { configuredNdkVersion }\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } answers {\n-            throw AssertionError(\n-                \"legacy ndkVersion should not be read when ApplicationExtension is available\"\n-            )\n-        }\n         every { mockApplicationExtension.ndkVersion } answers { configuredNdkVersion }\n+        every { mockCmake.path } returns null\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns tempDir.toString()\n         every {\n@@ -2141,7 +2138,7 @@\n                 )\n             )\n         }\n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -2149,15 +2146,15 @@\n     fun `forceNdkDownload skips fallback when sdkmanager is unavailable but the requested ndk is already installed`() {\n         val project = mockk<Project>()\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         every { project.extensions.findByType(ApplicationExtension::class.java) } returns null\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns \"/sdk/root\"\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"29.0.13846066\"\n@@ -2166,27 +2163,25 @@\n         FlutterPluginUtils.forceNdkDownload(project, \"/base/path\")\n         finalizeDslSlot.captured.invoke(Any())\n \n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n     @Test\n+    fun `forceNdkDownload读取公开扩展中的已安装NDK版本`() {\n-    fun `forceNdkDownload reads ndkVersion from ApplicationExtension when legacy extension does not expose it`() {\n         val project = mockk<Project>()\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         val mockApplicationExtension = mockk<ApplicationExtension>()\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n         every { project.extensions.findByType(ApplicationExtension::class.java) } returns mockApplicationExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } answers {\n-            throw AssertionError(\"legacy ndkVersion should not be read when ApplicationExtension is available\")\n-        }\n         every { mockApplicationExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns \"/sdk/root\"\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"29.0.13846066\"\n@@ -2195,7 +2190,7 @@\n         FlutterPluginUtils.forceNdkDownload(project, \"/base/path\")\n         finalizeDslSlot.captured.invoke(Any())\n \n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -2207,14 +2202,14 @@\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n         val mockExecResult = mockk<ExecResult>()\n         val mockExecOperations = mockk<ExecOperations>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n-        val mockBaseExtension = mockk<BaseExtension>()\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns tempDir.toString()\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"\"\n@@ -2231,7 +2226,7 @@\n             finalizeDslSlot.captured.invoke(Any())\n         }\n \n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -2238,13 +2233,13 @@\n     @Test\n     fun `forceNdkDownload skips when invoking the ndk metadata task`() {\n         val project = mockk<Project>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCmake.path } returns null\n-        val mockBaseExtension = mockk<BaseExtension>()\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockCmakeOptions.path } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns null\n@@ -2253,7 +2248,7 @@\n \n         FlutterPluginUtils.forceNdkDownload(project, \"/base/path\")\n \n+        verify(exactly = 0) { mockCmake.path(any()) }\n-        verify(exactly = 0) { mockCmakeOptions.path(any()) }\n         verify { mockDefaultConfig wasNot called }\n     }\n \n@@ -2261,19 +2256,19 @@\n     fun `forceNdkDownload falls back when tool properties are present but sdkmanager is unavailable`() {\n         val project = mockk<Project>()\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n         val mockDirectoryProperty = mockk<DirectoryProperty>()\n         val mockDirectory = mockk<Directory>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         every { project.extensions.findByType(ApplicationExtension::class.java) } returns null\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n+        every { mockCmake.path(any()) } returns Unit\n+        every { mockCmake.buildStagingDirectory(any()) } returns Unit\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } returns null\n-        every { mockCmakeOptions.path(any()) } returns Unit\n-        every { mockCmakeOptions.buildStagingDirectory(any()) } returns Unit\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns null\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns \"/sdk/root\"\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"\"\n@@ -2284,8 +2279,8 @@\n         every { mockDirectory.asFile.path } returns \"/randomapp/build/app/\"\n         val basePath = \"/base/path\"\n \n+        val mockBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n+        every { mockCommonExtension.buildTypes.iterator() } returns mutableListOf(mockBuildType).iterator()\n-        val mockBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n-        every { mockBaseExtension.buildTypes.iterator() } returns mutableListOf(mockBuildType).iterator()\n         every { mockBuildType.name } returns \"Debug\"\n         every { mockBuildType.externalNativeBuild.cmake.arguments(any(), any(), any()) } returns Unit\n \n@@ -2293,9 +2288,9 @@\n         finalizeDslSlot.captured.invoke(Any())\n \n         verify(exactly = 1) {\n+            mockCmake.path(\"$basePath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\")\n-            mockCmakeOptions.path(\"$basePath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\")\n         }\n+        verify(exactly = 1) { mockCmake.buildStagingDirectory(any()) }\n-        verify(exactly = 1) { mockCmakeOptions.buildStagingDirectory(any()) }\n         verify(exactly = 1) {\n             mockBuildType.externalNativeBuild.cmake.arguments(\n                 \"-Wno-dev\",\n@@ -2309,19 +2304,19 @@\n     fun `forceNdkDownload falls back when Gradle is offline`() {\n         val project = mockk<Project>()\n         val finalizeDslSlot = captureFinalizeDslAction(project)\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n         val mockDirectoryProperty = mockk<DirectoryProperty>()\n         val mockDirectory = mockk<Directory>()\n+        val mockCommonExtension = mockk<CommonExtension>()\n-        val mockBaseExtension = mockk<BaseExtension>()\n         every { project.extensions.findByType(ApplicationExtension::class.java) } returns null\n+        every { project.extensions.getByType(CommonExtension::class.java) } returns mockCommonExtension\n+        every { mockCommonExtension.externalNativeBuild.cmake } returns mockCmake\n+        every { mockCommonExtension.defaultConfig } returns mockDefaultConfig\n+        every { mockCommonExtension.ndkVersion } returns \"29.0.13846066\"\n+        every { mockCmake.path } returns null\n+        every { mockCmake.path(any()) } returns Unit\n+        every { mockCmake.buildStagingDirectory(any()) } returns Unit\n-        every { project.extensions.findByType(BaseExtension::class.java) } returns mockBaseExtension\n-        every { mockBaseExtension.externalNativeBuild.cmake } returns mockCmakeOptions\n-        every { mockBaseExtension.defaultConfig } returns mockDefaultConfig\n-        every { mockBaseExtension.ndkVersion } returns \"29.0.13846066\"\n-        every { mockCmakeOptions.path } returns null\n-        every { mockCmakeOptions.path(any()) } returns Unit\n-        every { mockCmakeOptions.buildStagingDirectory(any()) } returns Unit\n         every { project.findProperty(FlutterPluginUtils.PROP_SDK_MANAGER_PATH) } returns \"/sdkmanager\"\n         every { project.findProperty(FlutterPluginUtils.PROP_ANDROID_SDK_ROOT) } returns \"/sdk/root\"\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns \"\"\n@@ -2333,8 +2328,8 @@\n         every { mockDirectory.asFile.path } returns \"/randomapp/build/app/\"\n         val basePath = \"/base/path\"\n \n+        val mockBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n+        every { mockCommonExtension.buildTypes.iterator() } returns mutableListOf(mockBuildType).iterator()\n-        val mockBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n-        every { mockBaseExtension.buildTypes.iterator() } returns mutableListOf(mockBuildType).iterator()\n         every { mockBuildType.name } returns \"Debug\"\n         every { mockBuildType.externalNativeBuild.cmake.arguments(any(), any(), any()) } returns Unit\n \n@@ -2342,9 +2337,9 @@\n         finalizeDslSlot.captured.invoke(Any())\n \n         verify(exactly = 1) {\n+            mockCmake.path(\"$basePath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\")\n-            mockCmakeOptions.path(\"$basePath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\")\n         }\n+        verify(exactly = 1) { mockCmake.buildStagingDirectory(any()) }\n-        verify(exactly = 1) { mockCmakeOptions.buildStagingDirectory(any()) }\n         verify(exactly = 1) {\n             mockBuildType.externalNativeBuild.cmake.arguments(\n                 \"-Wno-dev\",\n@@ -2357,7 +2352,7 @@\n     @Test\n     fun `forceNdkDownload sets externalNativeBuild properties`() {\n         val project = mockk<Project>()\n+        val mockCmake = mockk<Cmake>()\n-        val mockCmakeOptions = mockk<CmakeOptions>()\n         val mockDefaultConfig = mockk<DefaultConfig>()\n         val mockDirectoryProperty = mockk<DirectoryProperty>()\n         val mockDirectory = mockk<Directory>()\n@@ -2367,25 +2362,25 @@\n         every { project.findProperty(FlutterPluginUtils.PROP_INSTALLED_NDK_VERSIONS) } returns null\n         every {\n             project.extensions\n+                .getByType(CommonExtension::class.java)\n-                .findByType(BaseExtension::class.java)!!\n                 .externalNativeBuild.cmake\n+        } returns mockCmake\n+        every { project.extensions.getByType(CommonExtension::class.java).defaultConfig } returns mockDefaultConfig\n-        } returns mockCmakeOptions\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.defaultConfig } returns mockDefaultConfig\n \n         val basePath = \"/base/path\"\n         val fakeBuildPath = \"/randomapp/build/app/\"\n+        every { mockCmake.path } returns null\n+        every { mockCmake.path(any()) } returns Unit\n+        every { mockCmake.buildStagingDirectory(any()) } returns Unit\n-        every { mockCmakeOptions.path } returns null\n-        every { mockCmakeOptions.path(any()) } returns Unit\n-        every { mockCmakeOptions.buildStagingDirectory(any()) } returns Unit\n         every { project.layout.buildDirectory } returns mockDirectoryProperty\n         every { mockDirectoryProperty.dir(any<String>()) } returns mockDirectoryProperty\n         every { mockDirectoryProperty.get() } returns mockDirectory\n         every { mockDirectory.asFile.path } returns fakeBuildPath\n \n+        val mockBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n-        val mockBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n         every {\n             project.extensions\n+                .getByType(CommonExtension::class.java)\n-                .findByType(BaseExtension::class.java)!!\n                 .buildTypes\n                 .iterator()\n         } returns mutableListOf(mockBuildType).iterator()\n@@ -2395,10 +2390,10 @@\n         FlutterPluginUtils.forceNdkDownload(project, basePath)\n \n         verify(exactly = 1) {\n+            mockCmake.path\n-            mockCmakeOptions.path\n         }\n+        verify(exactly = 1) { mockCmake.path(\"$basePath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\") }\n+        verify(exactly = 1) { mockCmake.buildStagingDirectory(any()) }\n-        verify(exactly = 1) { mockCmakeOptions.path(\"$basePath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt\") }\n-        verify(exactly = 1) { mockCmakeOptions.buildStagingDirectory(any()) }\n         verify(exactly = 1) {\n             mockBuildType.externalNativeBuild.cmake.arguments(\n                 \"-Wno-dev\",\n@@ -2440,7 +2435,7 @@\n         val pluginHandler = PluginHandler(project)\n         mockkObject(NativePluginLoaderReflectionBridge)\n         every { NativePluginLoaderReflectionBridge.getPlugins(any(), any()) } returns pluginListWithoutDevDependency\n+        val buildType: ApplicationBuildType = mockk<ApplicationBuildType>()\n-        val buildType: BuildType = mockk<BuildType>()\n         every { buildType.name } returns \"debug\"\n         every { buildType.isDebuggable } returns true\n         every { project.hasProperty(\"local-engine-repo\") } returns true\n@@ -2472,7 +2467,7 @@\n         val pluginHandler = PluginHandler(project)\n         mockkObject(NativePluginLoaderReflectionBridge)\n         every { NativePluginLoaderReflectionBridge.getPlugins(any(), any()) } returns pluginListWithoutDevDependency\n+        val buildType: ApplicationBuildType = mockk<ApplicationBuildType>()\n-        val buildType: BuildType = mockk<BuildType>()\n         val engineVersion = EXAMPLE_ENGINE_VERSION\n         every { buildType.name } returns \"debug\"\n         every { buildType.isDebuggable } returns true\n@@ -2510,7 +2505,7 @@\n         val pluginHandler = PluginHandler(project)\n         mockkObject(NativePluginLoaderReflectionBridge)\n         every { NativePluginLoaderReflectionBridge.getPlugins(any(), any()) } returns pluginListWithSingleDevDependency\n+        val buildType: ApplicationBuildType = mockk<ApplicationBuildType>()\n-        val buildType: BuildType = mockk<BuildType>()\n         val engineVersion = EXAMPLE_ENGINE_VERSION\n         every { buildType.name } returns \"release\"\n         every { buildType.isDebuggable } returns false\n@@ -2564,7 +2559,7 @@\n         val pluginHandler = PluginHandler(project)\n         mockkObject(NativePluginLoaderReflectionBridge)\n         every { NativePluginLoaderReflectionBridge.getPlugins(any(), any()) } returns pluginListWithSingleDevDependency\n+        val buildType: ApplicationBuildType = mockk<ApplicationBuildType>()\n-        val buildType: BuildType = mockk<BuildType>()\n         val engineVersion = EXAMPLE_ENGINE_VERSION\n         every { buildType.name } returns \"debug\"\n         every { buildType.isDebuggable } returns true\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/plugins/PluginHandlerTest.kt b/packages/flutter_tools/gradle/src/test/kotlin/plugins/PluginHandlerTest.kt\nindex 5a4b7b28f038d39e7c2322923e2abe191d5fc68822c59d73b27c86ffb708f7c5..d90e2dd7a0e21ef03c6a05722b4afa38f8c88da5b8f3a6afe0fb14f86d722311\n--- a/packages/flutter_tools/gradle/src/test/kotlin/plugins/PluginHandlerTest.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/plugins/PluginHandlerTest.kt\n@@ -4,7 +4,7 @@\n \n package com.flutter.gradle.plugins\n \n-import com.android.build.gradle.BaseExtension\n+import com.android.build.api.dsl.CommonExtension\n import com.flutter.gradle.FlutterExtension\n import com.flutter.gradle.FlutterPluginUtils\n import com.flutter.gradle.FlutterPluginUtilsTest.Companion.EXAMPLE_ENGINE_VERSION\n@@ -169,10 +169,13 @@\n         settingsGradle.createNewFile()\n         val mockLogger = mockk<Logger>()\n         every { project.logger } returns mockLogger\n+        val mockAppPluginContainer = mockk<org.gradle.api.plugins.PluginContainer>()\n+        every { project.plugins } returns mockAppPluginContainer\n+        every { mockAppPluginContainer.hasPlugin(\"com.android.application\") } returns true\n \n         val pluginProject = mockk<Project>()\n         val pluginDependencyProject = mockk<Project>()\n-        val mockBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n+        val mockBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n         every { pluginProject.hasProperty(\"local-engine-repo\") } returns false\n         every { pluginProject.hasProperty(\"android\") } returns true\n         val mockPluginContainer = mockk<org.gradle.api.plugins.PluginContainer>()\n@@ -189,18 +192,18 @@\n         every { pluginProject.afterEvaluate(any<Action<Project>>()) } returns Unit\n \n         val mockProjectBuildTypes =\n-            mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n+            mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n         val mockPluginProjectBuildTypes =\n-            mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockProjectBuildTypes\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockPluginProjectBuildTypes\n+            mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n+        every { project.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockProjectBuildTypes\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockPluginProjectBuildTypes\n         every { mockPluginProjectBuildTypes.addAll(any()) } returns true\n         every { pluginProject.configurations.named(any<String>()) } returns mockk()\n         every { pluginProject.dependencies.add(any(), any()) } returns mockk()\n \n         every {\n             project.extensions\n-                .findByType(BaseExtension::class.java)!!\n+                .getByType(CommonExtension::class.java)\n                 .buildTypes\n                 .iterator()\n         } returns\n@@ -214,8 +217,10 @@\n                 mockBuildType\n             ).iterator()\n         every { project.dependencies.add(any(), any()) } returns mockk()\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n \n         val pluginHandler = PluginHandler(project)\n         mockkObject(NativePluginLoaderReflectionBridge)\n@@ -248,7 +253,7 @@\n                 \"io.flutter:flutter_embedding_debug:$EXAMPLE_ENGINE_VERSION\"\n             )\n         }\n-        verify { project.dependencies.add(\"debugApi\", pluginProject) }\n+        verify { project.dependencies.add(\"debugImplementation\", pluginProject) }\n         verify { mockLogger wasNot called }\n         // For library projects, individual build types should be created, not addAll\n         verify(exactly = 0) { mockPluginProjectBuildTypes.addAll(any()) }\n@@ -272,7 +277,7 @@\n         every { project.logger } returns mockLogger\n \n         val pluginProject = mockk<Project>()\n-        val mockBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n+        val mockBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n         every { pluginProject.hasProperty(\"local-engine-repo\") } returns false\n         every { pluginProject.hasProperty(\"android\") } returns true\n         every { mockBuildType.name } returns \"debug\"\n@@ -285,18 +290,18 @@\n         every { pluginProject.afterEvaluate(any<Action<Project>>()) } returns Unit\n \n         val mockProjectBuildTypes =\n-            mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n+            mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n         val mockPluginProjectBuildTypes =\n-            mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockProjectBuildTypes\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockPluginProjectBuildTypes\n+            mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n+        every { project.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockProjectBuildTypes\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockPluginProjectBuildTypes\n         every { mockPluginProjectBuildTypes.addAll(any()) } returns true\n         every { pluginProject.configurations.named(any<String>()) } returns mockk()\n         every { pluginProject.dependencies.add(any(), any()) } returns mockk()\n \n         every {\n             project.extensions\n-                .findByType(BaseExtension::class.java)!!\n+                .getByType(CommonExtension::class.java)\n                 .buildTypes\n                 .iterator()\n         } returns\n@@ -310,8 +315,10 @@\n                 mockBuildType\n             ).iterator()\n         every { project.dependencies.add(any(), any()) } returns mockk()\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n \n         val pluginHandler = PluginHandler(project)\n         mockkObject(NativePluginLoaderReflectionBridge)\n@@ -347,19 +354,19 @@\n         mockkObject(FlutterPluginUtils)\n         every { FlutterPluginUtils.isBuiltAsApp(pluginProject) } returns true\n \n-        val mockProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n-        val mockPluginProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n-\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockProjectBuildTypes\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockPluginProjectBuildTypes\n+        val mockProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n+        val mockPluginProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n+\n+        every { project.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockProjectBuildTypes\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockPluginProjectBuildTypes\n         every { mockPluginProjectBuildTypes.addAll(any()) } returns true\n-        every { mockProjectBuildTypes.iterator() } returns mutableListOf<com.android.build.gradle.internal.dsl.BuildType>().iterator()\n+        every { mockProjectBuildTypes.iterator() } returns mutableListOf<com.android.build.api.dsl.ApplicationBuildType>().iterator()\n \n         // Mock FlutterPluginUtils calls that our logic depends on\n         mockkObject(FlutterPluginUtils)\n-        every { FlutterPluginUtils.getLegacyAndroidExtension(project) } returns project.extensions.findByType(BaseExtension::class.java)!!\n-        every { FlutterPluginUtils.getLegacyAndroidExtension(pluginProject) } returns\n-            pluginProject.extensions.findByType(BaseExtension::class.java)!!\n+        every { FlutterPluginUtils.getAndroidExtension(project) } returns project.extensions.getByType(CommonExtension::class.java)\n+        every { FlutterPluginUtils.getAndroidExtension(pluginProject) } returns\n+            pluginProject.extensions.getByType(CommonExtension::class.java)\n \n         // For app plugins, the old addAll behavior should be used\n         // This is tested implicitly by verifying the absence of individual create calls\n@@ -367,7 +374,7 @@\n         verify(exactly = 0) {\n             mockPluginProjectBuildTypes.create(\n                 any<String>(),\n-                any<Action<com.android.build.gradle.internal.dsl.BuildType>>()\n+                any<Action<com.android.build.api.dsl.ApplicationBuildType>>()\n             )\n         }\n     }\n@@ -387,22 +394,22 @@\n         mockkObject(FlutterPluginUtils)\n         every { FlutterPluginUtils.isBuiltAsApp(pluginProject) } returns false\n \n-        val mockProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n-        val mockPluginProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.gradle.internal.dsl.BuildType>>()\n-        val mockCreatedBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>(relaxed = true)\n-\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockProjectBuildTypes\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.buildTypes } returns mockPluginProjectBuildTypes\n+        val mockProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n+        val mockPluginProjectBuildTypes = mockk<NamedDomainObjectContainer<com.android.build.api.dsl.ApplicationBuildType>>()\n+        val mockCreatedBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>(relaxed = true)\n+\n+        every { project.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockProjectBuildTypes\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).buildTypes } returns mockPluginProjectBuildTypes\n         every { mockPluginProjectBuildTypes.findByName(\"debug\") } returns null\n         every {\n             mockPluginProjectBuildTypes.create(\n                 \"debug\",\n-                any<Action<com.android.build.gradle.internal.dsl.BuildType>>()\n+                any<Action<com.android.build.api.dsl.ApplicationBuildType>>()\n             )\n         } returns mockCreatedBuildType\n \n         // Mock the iterator for forEach\n-        val testBuildType = mockk<com.android.build.gradle.internal.dsl.BuildType>()\n+        val testBuildType = mockk<com.android.build.api.dsl.ApplicationBuildType>()\n         every { testBuildType.name } returns \"debug\"\n         every { testBuildType.isDebuggable } returns true\n         every { testBuildType.isMinifyEnabled } returns false\n@@ -410,9 +417,9 @@\n \n         // Mock FlutterPluginUtils calls that our logic depends on\n         mockkObject(FlutterPluginUtils)\n-        every { FlutterPluginUtils.getLegacyAndroidExtension(project) } returns project.extensions.findByType(BaseExtension::class.java)!!\n-        every { FlutterPluginUtils.getLegacyAndroidExtension(pluginProject) } returns\n-            pluginProject.extensions.findByType(BaseExtension::class.java)!!\n+        every { FlutterPluginUtils.getAndroidExtension(project) } returns project.extensions.getByType(CommonExtension::class.java)\n+        every { FlutterPluginUtils.getAndroidExtension(pluginProject) } returns\n+            pluginProject.extensions.getByType(CommonExtension::class.java)\n \n         // For library plugins, individual build type creation should happen\n         // This is tested by verifying that create is called for the build type\n@@ -423,7 +430,7 @@\n     private fun setupBasicMocks(\n         project: Project,\n         pluginProject: Project,\n-        mockBuildType: com.android.build.gradle.internal.dsl.BuildType,\n+        mockBuildType: com.android.build.api.dsl.ApplicationBuildType,\n         tempDir: Path\n     ) {\n         // Configuration for project directory\n@@ -452,8 +459,10 @@\n         every { pluginProject.configurations.named(any<String>()) } returns mockk()\n         every { pluginProject.dependencies.add(any(), any()) } returns mockk()\n         every { project.dependencies.add(any(), any()) } returns mockk()\n-        every { project.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n-        every { pluginProject.extensions.findByType(BaseExtension::class.java)!!.compileSdkVersion } returns \"android-35\"\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { project.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).compileSdk } returns 35\n+        every { pluginProject.extensions.getByType(CommonExtension::class.java).compileSdkPreview } returns null\n     }\n \n     private fun setupPluginMocks(project: Project) {\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/DeeplinkTest.kt b/packages/flutter_tools/gradle/src/test/kotlin/DeeplinkTest.kt\nindex 525fc434a271b6540e4665e6a3bb48c7250d751c4c060198ec7fdf7559abe648..ee5e509830ba5827d7db7dd7619d73abc56861c80df62d7bcf2cb827bce4e454\n--- a/packages/flutter_tools/gradle/src/test/kotlin/DeeplinkTest.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/DeeplinkTest.kt\n@@ -4,7 +4,7 @@\n \n package com.flutter.gradle\n \n+import kotlin.test.assertFailsWith\n-import org.gradle.internal.impldep.org.junit.Assert.assertThrows\n import kotlin.test.Test\n import kotlin.test.assertContains\n import kotlin.test.assertFalse\n@@ -41,7 +41,7 @@\n         val deeplink1 = Deeplink(\"scheme1\", \"host1\", \"path1\", IntentFilterCheck())\n         val deeplink2 = null\n \n+        assertFailsWith<NullPointerException> { deeplink1.equals(deeplink2) }\n-        assertThrows(NullPointerException::class.java) { deeplink1.equals(deeplink2) }\n     }\n \n     @Test\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/DependencyVersionCheckerTest.kt b/packages/flutter_tools/gradle/src/test/kotlin/DependencyVersionCheckerTest.kt\nindex 66ec59b37378f70f347075b2c05393d4ce09c8f577e252200590db8bfe3fd933..8085404b25222899179e52fa5f59ff66ed97175ac7f534e5c0d0cc00b2deac63\n--- a/packages/flutter_tools/gradle/src/test/kotlin/DependencyVersionCheckerTest.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/DependencyVersionCheckerTest.kt\n@@ -30,7 +30,7 @@\n import com.flutter.gradle.DependencyVersionChecker.warnGradleVersion\n import com.flutter.gradle.DependencyVersionChecker.warnKGPVersion\n import com.flutter.gradle.DependencyVersionChecker.warnMinSdkVersion\n+import com.flutter.gradle.testing.setKotlinVersion\n-import com.flutter.gradle.testing.setAgpKotlinVersionToNull\n import io.mockk.every\n import io.mockk.mockk\n import io.mockk.mockkStatic\n@@ -55,7 +55,7 @@\n private const val SUPPORTED_GRADLE_VERSION: String = \"9.1.0\"\n private val SUPPORTED_JAVA_VERSION: JavaVersion = JavaVersion.VERSION_17\n private val SUPPORTED_AGP_VERSION: AndroidPluginVersion = AndroidPluginVersion(9, 0, 1)\n+private const val SUPPORTED_KGP_VERSION: String = \"2.2.20\"\n-private const val SUPPORTED_KGP_VERSION: String = \"2.3.20\"\n private val SUPPORTED_SDK_VERSION: MinSdkVersion = MinSdkVersion(\"release\", 30)\n \n class DependencyVersionCheckerTest {\n@@ -439,8 +439,7 @@\n         every { mockAndroidComponentsExtension.pluginVersion } returns agpVersion\n \n         // KGP\n+        setKotlinVersion(mockProject, kgpVersion)\n-        every { mockProject.hasProperty(eq(\"kotlin_version\")) } returns true\n-        every { mockProject.properties[\"kotlin_version\"] } returns kgpVersion\n \n         // Logger\n         val mockLogger = mockk<Logger>()\n@@ -499,7 +498,6 @@\n             }\n             return@answers Unit\n         }\n-        setAgpKotlinVersionToNull(mockProject)\n \n         return mockProject\n     }\ndiff --git a/packages/flutter_tools/gradle/src/test/kotlin/testing/VersionFetcherTestHelper.kt b/packages/flutter_tools/gradle/src/test/kotlin/testing/VersionFetcherTestHelper.kt\nindex 44682af9e0455c4060855f502f4b35247b5adb29465669486cbf688daf519fc7..17ee0eb03af0751f7b4a02af0fca0b7fcd82b432a964502f169e7fed4b55f129\n--- a/packages/flutter_tools/gradle/src/test/kotlin/testing/VersionFetcherTestHelper.kt\n+++ b/packages/flutter_tools/gradle/src/test/kotlin/testing/VersionFetcherTestHelper.kt\n@@ -1,22 +1,12 @@\n package com.flutter.gradle.testing\n \n import io.mockk.every\n+import io.mockk.mockkStatic\n-import io.mockk.mockk\n import org.gradle.api.Project\n+import org.jetbrains.kotlin.gradle.plugin.getKotlinPluginVersion\n-import org.jetbrains.kotlin.gradle.plugin.KotlinBaseApiPlugin\n \n+/** 测试通过KGP公开接口注入版本，不复刻AGP内部实现。 */\n+internal fun setKotlinVersion(mockProject: Project, version: String) {\n+    mockkStatic(\"org.jetbrains.kotlin.gradle.plugin.KotlinPluginWrapperKt\")\n+    every { mockProject.getKotlinPluginVersion() } returns version\n-/**\n- * Prevent AGP's kotlin version checker from throwing `no answer found`\n- *\n- * Intended to be called by tests that call `VersionFetcher.getKGPVersion(project)`\n- * and who do not care about the internal implementation of\n- * `com.android.build.gradle.internal.utils.getKotlinAndroidPluginVersion`\n- */\n-internal fun setAgpKotlinVersionToNull(mockProject: Project) {\n-    // The internals of `getKotlinAndroidPluginVersion` depend on `getKotlinPluginVersionFromPlugin`\n-    // which relies on reflection to get the value. Instead make sure fetching the plugin has valid\n-    // response then rely on the default behavior in `getKotlinPluginVersionFromPlugin` to\n-    // return null.\n-    every { mockProject.plugins.findPlugin(any<Class<KotlinBaseApiPlugin>>()) } returns mockk()\n-    every { mockProject.plugins.findPlugin(\"kotlin-android\") } returns mockk()\n }\ndiff --git a/bin/internal/shared.sh b/bin/internal/shared.sh\nindex 7029bb28e9f60927807f2119d2afe388742db41d34c26f5e263bf15568911fa2..5c6e3bfa4647025cba26e3a6f6cc9fa0d2dcd670062870d6fda85f6764a27fe4\n--- a/bin/internal/shared.sh\n+++ b/bin/internal/shared.sh\n@@ -1,283 +1,35 @@\n-#!/usr/bin/env bash\n-# Copyright 2014 The Flutter Authors. All rights reserved.\n-# Use of this source code is governed by a BSD-style license that can be\n-# found in the LICENSE file.\n-\n-# ---------------------------------- NOTE ---------------------------------- #\n-#\n-# Please keep the logic in this file consistent with the logic in the\n-# `shared.bat` script in the same directory to ensure that Flutter & Dart continue\n-# to work across all platforms!\n-#\n-# -------------------------------------------------------------------------- #\n-\n-set -e\n-\n-# Needed because if it is set, cd may print the path it changed to.\n-unset CDPATH\n-\n-function pub_upgrade_with_retry {\n-  local total_tries=\"10\"\n-  local remaining_tries=$((total_tries - 1))\n-  while [[ \"$remaining_tries\" -gt 0 ]]; do\n-    (cd \"$FLUTTER_TOOLS_DIR\" && \"$DART\" pub upgrade --suppress-analytics >&2) && break\n-    >&2 echo \"Error: Unable to 'pub upgrade' flutter tool. Retrying in five seconds... ($remaining_tries tries left)\"\n-    remaining_tries=$((remaining_tries - 1))\n-    sleep 5\n-  done\n-\n-  if [[ \"$remaining_tries\" == 0 ]]; then\n-    >&2 echo \"Command 'pub upgrade' still failed after $total_tries tries, giving up.\"\n-    return 1\n-  fi\n-\n-  # Touch the pubspec.lock to ensure, even if this was a NOP, it is newer than pubspec.yaml.\n-  # See https://github.com/flutter/flutter/issues/171024.\n-  touch \"$FLUTTER_TOOLS_DIR/pubspec.lock\" >&2\n-\n-  return 0\n-}\n-\n-# Trap function for removing any remaining lock file at exit.\n-function _rmlock () {\n-  [ -n \"$FLUTTER_UPGRADE_LOCK\" ] && rm -rf -- \"$FLUTTER_UPGRADE_LOCK\"\n-}\n-\n-# Determines which lock method to use, based on what is available on the system.\n-# Returns a non-zero value if the lock was not acquired, zero if acquired.\n-function _lock () {\n-  if hash flock 2>/dev/null; then\n-    flock --nonblock --exclusive 7 2>/dev/null\n-  elif hash shlock 2>/dev/null; then\n-    shlock -f \"$1\" -p $$\n-  else\n-    mkdir \"$1\" 2>/dev/null\n-  fi\n-}\n-\n-# Waits for an update lock to be acquired.\n-#\n-# To ensure that we don't simultaneously update Dart in multiple parallel\n-# instances, we try to obtain an exclusive lock on this file descriptor (and\n-# thus this script's source file) while we are updating Dart and compiling the\n-# script. To do this, we try to use the command line program \"flock\", which is\n-# available on many Unix-like platforms, in particular on most Linux\n-# distributions. You give it a file descriptor, and it locks the corresponding\n-# file, having inherited the file descriptor from the shell.\n-#\n-# Complicating matters, there are two major scenarios where this will not\n-# work.\n-#\n-# The first is if the platform doesn't have \"flock\", for example on macOS. There\n-# is not a direct equivalent, so on platforms that don't have flock, we fall\n-# back to using trying to use the shlock command, and if that doesn't exist,\n-# then we use mkdir as an atomic operation to create a lock directory. If mkdir\n-# is able to create the directory, then the lock is acquired. To determine if we\n-# have \"flock\" or \"shlock\" available, we use the \"hash\" shell built-in.\n-#\n-# The second complication is on network file shares. On NFS, to obtain an\n-# exclusive lock you need a file descriptor that is open for writing. Thus, we\n-# ignore errors from flock by redirecting all output to /dev/null, since users\n-# will typically not care about errors from flock and are more likely to be\n-# confused by them than helped. The \"shlock\" method doesn't work for network\n-# shares, since it is PID-based. The \"mkdir\" method does work over NFS\n-# implementations that support atomic directory creation (which is most of\n-# them). The \"schlock\" and \"flock\" commands are more reliable than the mkdir\n-# method, however, or we would use mkdir in all cases.\n-#\n-# The upgrade_flutter function calling _wait_for_lock is executed in a subshell\n-# with a redirect that pipes the source of this script into file descriptor 7.\n-# A flock lock is released when this subshell exits and file descriptor 7 is\n-# closed. The mkdir lock is released via an exit trap from the subshell that\n-# deletes the lock directory.\n-function _wait_for_lock () {\n-  FLUTTER_UPGRADE_LOCK=\"$FLUTTER_ROOT/bin/cache/.upgrade_lock\"\n-  local waiting_message_displayed\n-  while ! _lock \"$FLUTTER_UPGRADE_LOCK\"; do\n-    if [[ -z $waiting_message_displayed ]]; then\n-      # Print with a return so that if the Dart code also prints this message\n-      # when it does its own lock, the message won't appear twice. Be sure that\n-      # the clearing printf below has the same number of space characters.\n-      printf \"Waiting for another flutter command to release the startup lock...\\r\" >&2;\n-      waiting_message_displayed=\"true\"\n-    fi\n-    sleep .1;\n-  done\n-  if [[ $waiting_message_displayed == \"true\" ]]; then\n-    # Clear the waiting message so it doesn't overlap any following text.\n-    printf \"                                                                  \\r\" >&2;\n-  fi\n-  unset waiting_message_displayed\n-  # If the lock file is acquired, make sure that it is removed on exit.\n-  trap _rmlock INT TERM EXIT\n-}\n-\n-# This function is always run in a subshell. Running the function in a subshell\n-# is required to make sure any lock directory is cleaned up by the exit trap in\n-# _wait_for_lock.\n-function upgrade_flutter () (\n-  mkdir -p \"$FLUTTER_ROOT/bin/cache\"\n-\n-  # Ensure the engine.version is populated\n-  \"$FLUTTER_ROOT/bin/internal/update_engine_version.sh\"\n-\n-  local revision=\"$(git -C \"$FLUTTER_ROOT\" rev-parse HEAD)\"\n-  local compilekey=\"$revision:$FLUTTER_TOOL_ARGS\"\n-\n-  # Invalidate cache if:\n-  #  * SNAPSHOT_PATH is not a file, or\n-  #  * STAMP_PATH is not a file, or\n-  #  * STAMP_PATH is an empty file, or\n-  #  * Contents of STAMP_PATH is not what we are going to compile, or\n-  #  * pubspec.yaml last modified after pubspec.lock\n-  if [[ ! -f \"$SNAPSHOT_PATH\" || \\\n-        ! -s \"$STAMP_PATH\" || \\\n-        \"$(< \"$STAMP_PATH\")\" != \"$compilekey\" || \\\n-        \"$FLUTTER_TOOLS_DIR/pubspec.yaml\" -nt \"$FLUTTER_TOOLS_DIR/pubspec.lock\" ]]; then\n-    # Waits for the update lock to be acquired. Placing this check inside the\n-    # conditional allows the majority of flutter/dart installations to bypass\n-    # the lock entirely, but as a result this required a second verification that\n-    # the SDK is up to date.\n-    _wait_for_lock\n-\n-    # A different shell process might have updated the tool/SDK.\n-    if [[ -f \"$SNAPSHOT_PATH\" && -s \"$STAMP_PATH\" && \"$(< \"$STAMP_PATH\")\" == \"$compilekey\" && \"$FLUTTER_TOOLS_DIR/pubspec.yaml\" -ot \"$FLUTTER_TOOLS_DIR/pubspec.lock\" ]]; then\n-      exit $?\n-    fi\n-\n-    # Fetch Dart...\n-    rm -f \"$FLUTTER_ROOT/version\"\n-    rm -f \"$FLUTTER_ROOT/bin/cache/flutter.version.json\"\n-    touch \"$FLUTTER_ROOT/bin/cache/.dartignore\"\n-    \"$FLUTTER_ROOT/bin/internal/update_dart_sdk.sh\"\n-\n-    if [[ \"$BIN_NAME\" == 'dart' || \"$BIN_NAME\" == 'flutter-dev' ]]; then\n-      # Don't try to build tool\n-      return\n-    fi\n-\n-    >&2 echo Building flutter tool...\n-\n-    # Prepare packages...\n-    if [[ \"$CI\" == \"true\" || \"$BOT\" == \"true\" || \"$CONTINUOUS_INTEGRATION\" == \"true\" || \"$CHROME_HEADLESS\" == \"1\" ]]; then\n-      PUB_ENVIRONMENT=\"$PUB_ENVIRONMENT:flutter_bot\"\n-    else\n-      export PUB_SUMMARY_ONLY=1\n-    fi\n-    export PUB_ENVIRONMENT=\"$PUB_ENVIRONMENT:flutter_install\"\n-    pub_upgrade_with_retry\n-\n-    # Move the old snapshot - we can't just overwrite it as the VM might currently have it\n-    # memory mapped (e.g. on flutter upgrade). For downloading a new dart sdk the folder is moved,\n-    # so we take the same approach of moving the file here.\n-    SNAPSHOT_PATH_OLD=\"$SNAPSHOT_PATH.old\"\n-    if [ -f \"$SNAPSHOT_PATH\" ]; then\n-      mv \"$SNAPSHOT_PATH\" \"$SNAPSHOT_PATH_OLD\"\n-    fi\n-\n-    # Compile...\n-    \"$DART\" --verbosity=error $FLUTTER_TOOL_ARGS --snapshot=\"$SNAPSHOT_PATH\" --snapshot-kind=\"app-jit\" --packages=\"$FLUTTER_TOOLS_DIR/.dart_tool/package_config.json\" --no-enable-mirrors \"$SCRIPT_PATH\" > /dev/null\n-    echo \"$compilekey\" > \"$STAMP_PATH\"\n-\n-    # Delete any temporary snapshot path.\n-    if [ -f \"$SNAPSHOT_PATH_OLD\" ]; then\n-      rm -f \"$SNAPSHOT_PATH_OLD\"\n-    fi\n-  fi\n-  # The exit here is extraneous since the function is run in a subshell, but\n-  # this serves as documentation that running the function in a subshell is\n-  # required to make sure any lock directory created by mkdir is cleaned up.\n-  exit $?\n-)\n-\n-# This function is intended to be executed by entrypoints (e.g. `//bin/flutter`\n-# and `//bin/dart`). PROG_NAME and BIN_DIR should already be set by those\n-# entrypoints.\n-function shared::execute() {\n-  export FLUTTER_ROOT=\"$(cd \"${BIN_DIR}/..\" ; pwd -P)\"\n-\n-  # If present, run the bootstrap script first\n-  BOOTSTRAP_PATH=\"$FLUTTER_ROOT/bin/internal/bootstrap.sh\"\n-  if [ -f \"$BOOTSTRAP_PATH\" ]; then\n-    source \"$BOOTSTRAP_PATH\"\n-  fi\n-\n-  FLUTTER_TOOLS_DIR=\"$FLUTTER_ROOT/packages/flutter_tools\"\n-  SNAPSHOT_PATH=\"$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot\"\n-  STAMP_PATH=\"$FLUTTER_ROOT/bin/cache/flutter_tools.stamp\"\n-  SCRIPT_PATH=\"$FLUTTER_TOOLS_DIR/bin/flutter_tools.dart\"\n-  DART_SDK_PATH=\"$FLUTTER_ROOT/bin/cache/dart-sdk\"\n-\n-  DART=\"$DART_SDK_PATH/bin/dart\"\n-\n-  # If running over git-bash, overrides the default UNIX executables with win32\n-  # executables\n-  case \"$(uname -s)\" in\n-    MINGW* | MSYS* )\n-      DART=\"$DART.exe\"\n-      ;;\n-  esac\n-\n-  # Test if running as superuser – but don't warn if running within Docker or CI.\n-  if [[ \"$EUID\" == \"0\" && ! -f /.dockerenv && \"$CI\" != \"true\" && \"$BOT\" != \"true\" && \"$CONTINUOUS_INTEGRATION\" != \"true\" ]]; then\n-    >&2 echo \"   Woah! You appear to be trying to run flutter as root.\"\n-    >&2 echo \"   We strongly recommend running the flutter tool without superuser privileges.\"\n-    >&2 echo \"  /\"\n-    >&2 echo \"📎\"\n-  fi\n-\n-  # Test if Git is available on the Host\n-  if ! hash git 2>/dev/null; then\n-    >&2 echo \"Error: Unable to find git in your PATH.\"\n-    exit 1\n-  fi\n-  # Test if the flutter directory is a git clone (otherwise git rev-parse HEAD\n-  # would fail)\n-  if [[ ! -e \"$FLUTTER_ROOT/.git\" ]]; then\n-    >&2 echo \"Error: The Flutter directory is not a clone of the GitHub project.\"\n-    >&2 echo \"       The flutter tool requires Git in order to operate properly;\"\n-    >&2 echo \"       to install Flutter, see the instructions at:\"\n-    >&2 echo \"       https://docs.flutter.dev/get-started\"\n-    exit 1\n-  fi\n-\n-  BIN_NAME=\"$(basename \"$PROG_NAME\")\"\n-\n-  # File descriptor 7 is prepared here so that we can use it with\n-  # flock(1) in _lock() (see above).\n-  #\n-  # We use number 7 because it's a luckier number than 3; luck is\n-  # important when making locks work reliably. Also because that way\n-  # if anyone is redirecting other file descriptors there's less\n-  # chance of a conflict.\n-  #\n-  # In any case, the file we redirect into this file descriptor is\n-  # this very source file you are reading right now, because that's\n-  # the only file we can truly guarantee exists, since we're running\n-  # it. We don't use PROG_NAME because otherwise if you run `dart` and\n-  # `flutter` simultaneously they'll end up using different lock files\n-  # and will corrupt each others' downloads.\n-  #\n-  # SHARED_NAME itself is prepared by the caller script.\n-  upgrade_flutter 7< \"$SHARED_NAME\"\n-\n-  case \"$BIN_NAME\" in\n-    flutter-dev)\n-      # FLUTTER_TOOL_ARGS aren't quoted below, because it is meant to be\n-      # considered as separate space-separated args.\n-      exec \"$DART\" run --resident --packages=\"$FLUTTER_TOOLS_DIR/.dart_tool/package_config.json\" $FLUTTER_TOOL_ARGS \"$SCRIPT_PATH\" \"$@\"\n-      ;;\n-    flutter*)\n-      # FLUTTER_TOOL_ARGS aren't quoted below, because it is meant to be\n-      # considered as separate space-separated args.\n-      exec \"$DART\" --packages=\"$FLUTTER_TOOLS_DIR/.dart_tool/package_config.json\" $FLUTTER_TOOL_ARGS \"$SNAPSHOT_PATH\" \"$@\"\n-      ;;\n-    dart*)\n-      exec \"$DART\" \"$@\"\n-      ;;\n-    *)\n-      >&2 echo \"Error! Executable name $BIN_NAME not recognized!\"\n-      exit 1\n-      ;;\n-  esac\n-}\n+#!/usr/bin/env bash\n+# Copyright 2014 The Flutter Authors. All rights reserved.\n+# Use of this source code is governed by a BSD-style license that can be\n+# found in the LICENSE file.\n+\n+set -e\n+unset CDPATH\n+\n+# SDK是可直接使用的工具，不要求产品必须由塔塔控制台启动。版本检查关闭只用于\n+# 避免编译命令隐式修改或更新SDK；产品自己的依赖和构建流程保持原样。\n+function shared::execute() {\n+  export FLUTTER_ROOT=\"$(cd \"${BIN_DIR}/..\" && pwd -P)\"\n+  local tools=\"$FLUTTER_ROOT/packages/flutter_tools\"\n+  local dart=\"$FLUTTER_ROOT/bin/cache/dart-sdk/bin/dart\"\n+  local snapshot=\"$FLUTTER_ROOT/bin/cache/flutter_tools.snapshot\"\n+  local config=\"$tools/.dart_tool/package_config.json\"\n+  local name=\"$(basename \"$PROG_NAME\")\"\n+  if [[ ! -x \"$dart\" || ! -s \"$snapshot\" || ! -s \"$config\" ||\n+        ! -s \"$FLUTTER_ROOT/bin/cache/flutter.version.json\" ]]; then\n+    >&2 echo \"Flutter SDK 不完整。\"\n+    return 1\n+  fi\n+  case \"$name\" in\n+    flutter)\n+      exec \"$dart\" --packages=\"$config\" \"$snapshot\" --no-version-check \"$@\"\n+      ;;\n+    dart)\n+      exec \"$dart\" \"$@\"\n+      ;;\n+    *)\n+      >&2 echo \"Flutter工具入口不支持：$name\"\n+      return 1\n+      ;;\n+  esac\n+}\ndiff --git a/packages/flutter_tools/lib/src/cache.dart b/packages/flutter_tools/lib/src/cache.dart\nindex 36c8addec9a603f8e5d89288059d7def5406b09de28ab78544e3129db76d83b8..dffe24408031cc33b047be33585dc1ec78e2f687f613d71fc42838c00585030a\n--- a/packages/flutter_tools/lib/src/cache.dart\n+++ b/packages/flutter_tools/lib/src/cache.dart\n@@ -1,1776 +1,1692 @@\n-// Copyright 2014 The Flutter Authors. All rights reserved.\n-// Use of this source code is governed by a BSD-style license that can be\n-// found in the LICENSE file.\n-\n-/// @docImport 'flutter_cache.dart';\n-/// @docImport 'runner/flutter_command.dart';\n-/// @docImport 'runner/flutter_command_runner.dart';\n-library;\n-\n-import 'dart:async';\n-import 'dart:ffi' show Abi;\n-import 'dart:math' show max;\n-\n-import 'package:crypto/crypto.dart';\n-import 'package:file/memory.dart';\n-import 'package:meta/meta.dart';\n-import 'package:process/process.dart';\n-\n-import 'artifacts.dart';\n-import 'base/common.dart';\n-import 'base/context.dart';\n-import 'base/error_handling_io.dart';\n-import 'base/file_system.dart';\n-import 'base/io.dart'\n-    show\n-        HttpClient,\n-        HttpClientRequest,\n-        HttpClientResponse,\n-        HttpHeaders,\n-        HttpStatus,\n-        SocketException,\n-        Stdio;\n-import 'base/logger.dart';\n-import 'base/net.dart';\n-import 'base/os.dart' show OperatingSystemUtils;\n-import 'base/platform.dart';\n-import 'base/terminal.dart';\n-import 'base/user_messages.dart';\n-import 'base/utils.dart' show getElapsedAsSeconds, getSizeAsPlatformMB;\n-import 'convert.dart';\n-import 'features.dart';\n-\n-const kFlutterRootEnvironmentVariableName =\n-    'FLUTTER_ROOT'; // should point to //flutter/ (root of flutter/flutter repo)\n-const kFlutterEngineEnvironmentVariableName =\n-    'FLUTTER_ENGINE'; // should point to //engine/src/ (root of flutter/engine repo)\n-const kSnapshotFileName = 'flutter_tools.snapshot'; // in //flutter/bin/cache/\n-const kFlutterToolsScriptFileName =\n-    'flutter_tools.dart'; // in //flutter/packages/flutter_tools/bin/\n-const kFlutterEnginePackageName = 'sky_engine';\n-\n-/// A tag for a set of development artifacts that need to be cached.\n-class DevelopmentArtifact {\n-  const DevelopmentArtifact._(this.name, {this.feature});\n-\n-  /// The name of the artifact.\n-  ///\n-  /// This should match the flag name in precache.dart.\n-  final String name;\n-\n-  /// A feature to control the visibility of this artifact.\n-  final Feature? feature;\n-\n-  /// Artifacts required for Android development.\n-  static const androidGenSnapshot = DevelopmentArtifact._(\n-    'android_gen_snapshot',\n-    feature: flutterAndroidFeature,\n-  );\n-  static const androidMaven = DevelopmentArtifact._(\n-    'android_maven',\n-    feature: flutterAndroidFeature,\n-  );\n-\n-  // Artifacts used for internal builds.\n-  static const androidInternalBuild = DevelopmentArtifact._(\n-    'android_internal_build',\n-    feature: flutterAndroidFeature,\n-  );\n-\n-  /// Artifacts required for iOS development.\n-  static const iOS = DevelopmentArtifact._('ios', feature: flutterIOSFeature);\n-\n-  /// Artifacts required for web development.\n-  static const web = DevelopmentArtifact._('web', feature: flutterWebFeature);\n-\n-  /// Artifacts required for desktop macOS.\n-  static const macOS = DevelopmentArtifact._('macos', feature: flutterMacOSDesktopFeature);\n-\n-  /// Artifacts required for desktop Windows.\n-  static const windows = DevelopmentArtifact._('windows', feature: flutterWindowsDesktopFeature);\n-\n-  /// Artifacts required for desktop Linux.\n-  static const linux = DevelopmentArtifact._('linux', feature: flutterLinuxDesktopFeature);\n-\n-  /// Artifacts required for Fuchsia.\n-  static const fuchsia = DevelopmentArtifact._('fuchsia', feature: flutterFuchsiaFeature);\n-\n-  /// Artifacts required for the Flutter Runner.\n-  static const flutterRunner = DevelopmentArtifact._(\n-    'flutter_runner',\n-    feature: flutterFuchsiaFeature,\n-  );\n-\n-  /// Artifacts required for any development platform.\n-  ///\n-  /// This does not need to be explicitly returned from requiredArtifacts as\n-  /// it will always be downloaded.\n-  static const universal = DevelopmentArtifact._('universal');\n-\n-  /// Artifacts which contain build information for the flutter tool.\n-  static const informative = DevelopmentArtifact._('informative');\n-\n-  /// The values of DevelopmentArtifacts.\n-  static final values = <DevelopmentArtifact>[\n-    androidGenSnapshot,\n-    androidMaven,\n-    androidInternalBuild,\n-    iOS,\n-    web,\n-    macOS,\n-    windows,\n-    linux,\n-    fuchsia,\n-    universal,\n-    flutterRunner,\n-    informative,\n-  ];\n-\n-  @override\n-  String toString() => 'Artifact($name)';\n-}\n-\n-/// A wrapper around the `bin/cache/` directory.\n-///\n-/// This does not provide any artifacts by default. See [FlutterCache] for the default\n-/// artifact set.\n-///\n-/// ## Artifact mirrors\n-///\n-/// Some environments cannot reach the Google Cloud Storage buckets and CIPD due\n-/// to regional or corporate policies.\n-///\n-/// To enable Flutter users in these environments, the Flutter tool supports\n-/// custom artifact mirrors that the administrators of such environments may\n-/// provide. To use an artifact mirror, the user defines the [kFlutterStorageBaseUrl]\n-/// (`FLUTTER_STORAGE_BASE_URL`) environment variable that points to the mirror.\n-/// Flutter tool reads this variable and uses it instead of the default URLs.\n-///\n-/// For more details on specific URLs used to download artifacts, see\n-/// [storageBaseUrl] and [cipdBaseUrl].\n-class Cache {\n-  /// [rootOverride] is configurable for testing.\n-  /// [artifacts] is configurable for testing.\n-  Cache({\n-    @protected Directory? rootOverride,\n-    @protected List<ArtifactSet>? artifacts,\n-    required Logger logger,\n-    required FileSystem fileSystem,\n-    required Platform platform,\n-    required OperatingSystemUtils osUtils,\n-    Stdio? stdio,\n-  }) : _rootOverride = rootOverride,\n-       _logger = logger,\n-       _fileSystem = fileSystem,\n-       _platform = platform,\n-       _osUtils = osUtils,\n-       _stdio = stdio,\n-       _net = Net(logger: logger, platform: platform),\n-       _fsUtils = FileSystemUtils(fileSystem: fileSystem, platform: platform),\n-       _artifacts = artifacts ?? <ArtifactSet>[];\n-\n-  /// Create a [Cache] for testing.\n-  ///\n-  /// Defaults to a memory file system, fake platform,\n-  /// buffer logger, and no accessible artifacts.\n-  /// By default, the root cache directory path is \"cache\".\n-  factory Cache.test({\n-    Directory? rootOverride,\n-    List<ArtifactSet>? artifacts,\n-    Logger? logger,\n-    FileSystem? fileSystem,\n-    Platform? platform,\n-    Stdio? stdio,\n-    required ProcessManager processManager,\n-    Abi? currentAbi,\n-  }) {\n-    if (rootOverride?.fileSystem != null &&\n-        fileSystem != null &&\n-        rootOverride!.fileSystem != fileSystem) {\n-      throw ArgumentError(\n-        'If rootOverride and fileSystem are both non-null, '\n-            'rootOverride.fileSystem must be the same as fileSystem.',\n-        'fileSystem',\n-      );\n-    }\n-    fileSystem ??= rootOverride?.fileSystem ?? MemoryFileSystem.test();\n-    platform ??= FakePlatform(environment: <String, String>{});\n-    logger ??= BufferLogger.test();\n-    return Cache(\n-      rootOverride: rootOverride ?? fileSystem.currentDirectory,\n-      artifacts: artifacts ?? <ArtifactSet>[],\n-      logger: logger,\n-      fileSystem: fileSystem,\n-      platform: platform,\n-      stdio: stdio,\n-      osUtils: OperatingSystemUtils(\n-        fileSystem: fileSystem,\n-        logger: logger,\n-        platform: platform,\n-        processManager: processManager,\n-        currentAbi: currentAbi,\n-      ),\n-    );\n-  }\n-\n-  final Logger _logger;\n-  final Platform _platform;\n-  final FileSystem _fileSystem;\n-  final OperatingSystemUtils _osUtils;\n-  final Directory? _rootOverride;\n-  final List<ArtifactSet> _artifacts;\n-  final Stdio? _stdio;\n-  final Net _net;\n-  final FileSystemUtils _fsUtils;\n-\n-  late final ArtifactUpdater _artifactUpdater = _createUpdater();\n-\n-  @visibleForTesting\n-  @protected\n-  void registerArtifact(ArtifactSet artifactSet) {\n-    _artifacts.add(artifactSet);\n-  }\n-\n-  /// This has to be lazy because it requires FLUTTER_ROOT to be initialized.\n-  ArtifactUpdater _createUpdater() {\n-    return ArtifactUpdater(\n-      operatingSystemUtils: _osUtils,\n-      logger: _logger,\n-      fileSystem: _fileSystem,\n-      tempStorage: getDownloadDir(),\n-      platform: _platform,\n-      httpClient: HttpClient(),\n-      allowedBaseUrls: <String>[storageBaseUrl, realmlessStorageBaseUrl, cipdBaseUrl],\n-      stdio: _stdio,\n-    );\n-  }\n-\n-  static const _hostsBlockedInChina = <String>[\n-    'storage.googleapis.com',\n-    'chrome-infra-packages.appspot.com',\n-  ];\n-\n-  // Initialized by FlutterCommandRunner on startup.\n-  // Explore making this field lazy to catch non-initialized access.\n-  static String? flutterRoot;\n-\n-  /// Determine the absolute and normalized path for the root of the current\n-  /// Flutter checkout.\n-  ///\n-  /// This method has a series of fallbacks for determining the repo location. The\n-  /// first success will immediately return the root without further checks.\n-  ///\n-  /// The order of these tests is:\n-  ///   1. FLUTTER_ROOT environment variable contains the path.\n-  ///   2. Platform script is a data URI scheme, returning `../..` to support\n-  ///      tests run from `packages/flutter_tools`.\n-  ///   3. Platform script is package URI scheme, returning the grandgrandparent\n-  ///      directory of the package config file location from\n-  ///      `packages/flutter_tools/.dart_tool/package_config.json`.\n-  ///   4. Platform script file path is the snapshot path generated by `bin/flutter`,\n-  ///      returning the grandparent directory from `bin/cache`.\n-  ///   5. Platform script file name is the entrypoint in `packages/flutter_tools/bin/flutter_tools.dart`,\n-  ///      returning the 4th parent directory.\n-  ///   6. The current directory\n-  ///\n-  /// If an exception is thrown during any of these checks, an error message is\n-  /// printed and `.` is returned by default (6).\n-  static String defaultFlutterRoot({\n-    required Platform platform,\n-    required FileSystem fileSystem,\n-    required UserMessages userMessages,\n-  }) {\n-    String normalize(String path) {\n-      return fileSystem.path.normalize(fileSystem.path.absolute(path));\n-    }\n-\n-    if (platform.environment.containsKey(kFlutterRootEnvironmentVariableName)) {\n-      return normalize(platform.environment[kFlutterRootEnvironmentVariableName]!);\n-    }\n-    try {\n-      if (platform.script.scheme == 'data') {\n-        return normalize('../..'); // The tool is running as a test.\n-      }\n-      final String Function(String) dirname = fileSystem.path.dirname;\n-\n-      if (platform.script.scheme == 'package') {\n-        final String packageConfigPath = Uri.parse(\n-          platform.packageConfig!,\n-        ).toFilePath(windows: platform.isWindows);\n-        return normalize(dirname(dirname(dirname(dirname(packageConfigPath)))));\n-      }\n-\n-      if (platform.script.scheme == 'file') {\n-        final String script = platform.script.toFilePath(windows: platform.isWindows);\n-        if (fileSystem.path.basename(script) == kSnapshotFileName) {\n-          return normalize(dirname(dirname(fileSystem.path.dirname(script))));\n-        }\n-        if (fileSystem.path.basename(script) == kFlutterToolsScriptFileName) {\n-          return normalize(dirname(dirname(dirname(dirname(script)))));\n-        }\n-      }\n-    } on Exception catch (error) {\n-      // There is currently no logger attached since this is computed at startup.\n-      // ignore: avoid_print\n-      print(userMessages.runnerNoRoot('$error'));\n-    }\n-    return normalize('.');\n-  }\n-\n-  // Whether to cache artifacts for all platforms. Defaults to only caching\n-  // artifacts for the current platform.\n-  bool includeAllPlatforms = false;\n-\n-  // Names of artifacts which should be cached even if they would normally\n-  // be filtered out for the current platform.\n-  Set<String>? platformOverrideArtifacts;\n-\n-  // Whether to cache the unsigned mac binaries. Defaults to caching the signed binaries.\n-  bool useUnsignedMacBinaries = false;\n-\n-  // Whether the warning printed when a custom artifact URL is used is fatal.\n-  bool fatalStorageWarning = true;\n-\n-  static RandomAccessFile? _lock;\n-  static var _lockEnabled = true;\n-\n-  /// Turn off the [lock]/[releaseLock] mechanism.\n-  ///\n-  /// This is used by the tests since they run simultaneously and all in one\n-  /// process and so it would be a mess if they had to use the lock.\n-  @visibleForTesting\n-  static void disableLocking() {\n-    _lockEnabled = false;\n-  }\n-\n-  /// Turn on the [lock]/[releaseLock] mechanism.\n-  ///\n-  /// This is used by the tests.\n-  @visibleForTesting\n-  static void enableLocking() {\n-    _lockEnabled = true;\n-  }\n-\n-  /// Check if lock acquired, skipping FLUTTER_ALREADY_LOCKED reentrant checks.\n-  ///\n-  /// This is used by the tests.\n-  @visibleForTesting\n-  static bool isLocked() {\n-    return _lock != null;\n-  }\n-\n-  /// Lock the cache directory.\n-  ///\n-  /// This happens while required artifacts are updated\n-  /// (see [FlutterCommandRunner.runCommand]).\n-  ///\n-  /// This uses normal POSIX flock semantics.\n-  Future<void> lock() async {\n-    if (!_lockEnabled) {\n-      return;\n-    }\n-    assert(_lock == null);\n-    final File lockFile = _fileSystem.file(\n-      _fileSystem.path.join(flutterRoot!, 'bin', 'cache', 'lockfile'),\n-    );\n-    try {\n-      _lock = lockFile.openSync(mode: FileMode.write);\n-    } on FileSystemException catch (e) {\n-      _logger.printError('Failed to open or create the artifact cache lockfile: \"$e\"');\n-      _logger.printError('Please ensure you have permissions to create or open ${lockFile.path}');\n-      throwToolExit('Failed to open or create the lockfile');\n-    }\n-    var locked = false;\n-    var printed = false;\n-    while (!locked) {\n-      try {\n-        _lock!.lockSync();\n-        locked = true;\n-      } on FileSystemException {\n-        if (!printed) {\n-          _logger.printTrace(\n-            'Waiting to be able to obtain lock of Flutter binary artifacts directory: ${_lock!.path}',\n-          );\n-          // This needs to go to stderr to avoid cluttering up stdout if a\n-          // parent process is collecting stdout (e.g. when calling \"flutter\n-          // version --machine\"). It's not really a \"warning\" though, so print it\n-          // in grey. Also, make sure that it isn't counted as a warning for\n-          // Logger.warningsAreFatal.\n-          _logger.printWarning(\n-            'Waiting for another flutter command to release the startup lock...',\n-            color: TerminalColor.grey,\n-            fatal: false,\n-          );\n-          printed = true;\n-        }\n-        await Future<void>.delayed(const Duration(milliseconds: 50));\n-      }\n-    }\n-  }\n-\n-  /// Releases the lock.\n-  ///\n-  /// This happens automatically on startup (see [FlutterCommand.verifyThenRunCommand])\n-  /// after the command's required artifacts are updated.\n-  void releaseLock() {\n-    if (!_lockEnabled || _lock == null) {\n-      return;\n-    }\n-    _lock!.closeSync();\n-    _lock = null;\n-  }\n-\n-  /// Checks if the current process owns the lock for the cache directory at\n-  /// this very moment; throws a [StateError] if it doesn't.\n-  void checkLockAcquired() {\n-    if (_lockEnabled &&\n-        _lock == null &&\n-        _platform.environment['FLUTTER_ALREADY_LOCKED'] != 'true') {\n-      throw StateError(\n-        'The current process does not own the lock for the cache directory. This is a bug in Flutter CLI tools.',\n-      );\n-    }\n-  }\n-\n-  String get devToolsVersion {\n-    if (_devToolsVersion == null) {\n-      const devToolsDirPath = 'dart-sdk/bin/resources/devtools';\n-      final Directory devToolsDir = getCacheDir(devToolsDirPath, shouldCreate: false);\n-      if (!devToolsDir.existsSync()) {\n-        throw Exception('Could not find directory at ${devToolsDir.path}');\n-      }\n-      final versionFilePath = '${devToolsDir.path}/version.json';\n-      final File versionFile = _fileSystem.file(versionFilePath);\n-      if (!versionFile.existsSync()) {\n-        throw Exception('Could not find file at $versionFilePath');\n-      }\n-      final dynamic data = jsonDecode(versionFile.readAsStringSync());\n-      if (data is! Map<String, Object?>) {\n-        throw Exception(\n-          \"Expected object of type 'Map<String, Object?>' but got one of type '${data.runtimeType}'\",\n-        );\n-      }\n-      final Object? version = data['version'];\n-      if (version == null) {\n-        throw Exception('Could not parse DevTools version from $version');\n-      }\n-      if (version is! String) {\n-        throw Exception(\n-          \"Could not parse DevTools version. Expected object of type 'String', but got one of type '${version.runtimeType}'\",\n-        );\n-      }\n-      return _devToolsVersion = version;\n-    }\n-    return _devToolsVersion!;\n-  }\n-\n-  String? _devToolsVersion;\n-\n-  /// The current version of Dart used to build Flutter and run the tool.\n-  String get dartSdkVersion {\n-    if (_dartSdkVersion == null) {\n-      // Make the version string more customer-friendly.\n-      // Changes '2.1.0-dev.8.0.flutter-4312ae32' to '2.1.0 (build 2.1.0-dev.8.0 4312ae32)'\n-      final String justVersion = _platform.version.split(' ')[0];\n-      _dartSdkVersion = justVersion.replaceFirstMapped(RegExp(r'(\\d+\\.\\d+\\.\\d+)(.+)'), (\n-        Match match,\n-      ) {\n-        final String noFlutter = match[2]!.replaceAll('.flutter-', ' ');\n-        return '${match[1]} (build ${match[1]}$noFlutter)';\n-      });\n-    }\n-    return _dartSdkVersion!;\n-  }\n-\n-  String? _dartSdkVersion;\n-\n-  /// The current version of Dart used to build Flutter and run the tool.\n-  String get dartSdkBuild {\n-    if (_dartSdkBuild == null) {\n-      // Make the version string more customer-friendly.\n-      // Changes '2.1.0-dev.8.0.flutter-4312ae32' to '2.1.0 (build 2.1.0-dev.8.0 4312ae32)'\n-      final String justVersion = _platform.version.split(' ')[0];\n-      _dartSdkBuild = justVersion.replaceFirstMapped(RegExp(r'(\\d+\\.\\d+\\.\\d+)(.+)'), (Match match) {\n-        final String noFlutter = match[2]!.replaceAll('.flutter-', ' ');\n-        return '${match[1]}$noFlutter';\n-      });\n-    }\n-    return _dartSdkBuild!;\n-  }\n-\n-  String? _dartSdkBuild;\n-\n-  /// The current version of the Flutter engine the flutter tool will download.\n-  String get engineRevision {\n-    _engineRevision ??= getStampFor('engine');\n-    if (_engineRevision == null) {\n-      throwToolExit('Could not determine engine revision.');\n-    }\n-    return _engineRevision!;\n-  }\n-\n-  String? _engineRevision;\n-\n-  /// The \"realm\" for the storage URL.\n-  ///\n-  /// For production artifacts from Engine post-submit and release builds,\n-  /// this string will be empty, and the `storageBaseUrl` will be unmodified.\n-  /// When non-empty, this string will be appended to the `storageBaseUrl` after\n-  /// a '/'. For artifacts generated by Engine presubmits, the realm should be\n-  /// \"flutter_archives_v2\".\n-  String get storageRealm {\n-    _storageRealm ??= getRealmFor('engine');\n-    if (_storageRealm == null) {\n-      throwToolExit('Could not determine engine realm.');\n-    }\n-    return _storageRealm!;\n-  }\n-\n-  String? _storageRealm;\n-\n-  /// The base for URLs that store Flutter engine artifacts that are fetched\n-  /// during the installation of the Flutter SDK.\n-  ///\n-  /// By default the base URL is https://storage.googleapis.com. However, if\n-  /// `FLUTTER_STORAGE_BASE_URL` environment variable ([kFlutterStorageBaseUrl])\n-  /// is provided, the environment variable value is returned instead.\n-  ///\n-  /// See also:\n-  ///\n-  ///  * [cipdBaseUrl], which determines how CIPD artifacts are fetched.\n-  ///  * [Cache] class-level dartdocs that explain how artifact mirrors work.\n-  String get storageBaseUrl {\n-    String? overrideUrl = _platform.environment[kFlutterStorageBaseUrl];\n-    if (overrideUrl == null) {\n-      return storageRealm.isEmpty\n-          ? 'https://storage.googleapis.com'\n-          : 'https://storage.googleapis.com/$storageRealm';\n-    }\n-    // verify that this is a valid URI.\n-    overrideUrl = storageRealm.isEmpty ? overrideUrl : '$overrideUrl/$storageRealm';\n-    try {\n-      Uri.parse(overrideUrl);\n-    } on FormatException catch (err) {\n-      throwToolExit('\"$kFlutterStorageBaseUrl\" contains an invalid URL:\\n$err');\n-    }\n-    _maybeWarnAboutStorageOverride(overrideUrl);\n-    return overrideUrl;\n-  }\n-\n-  String get realmlessStorageBaseUrl {\n-    return storageRealm.isEmpty ? storageBaseUrl : storageBaseUrl.replaceAll('/$storageRealm', '');\n-  }\n-\n-  /// The base for URLs that store Flutter engine artifacts in CIPD.\n-  ///\n-  /// For some platforms, such as Web and Fuchsia, CIPD artifacts are fetched\n-  /// during the installation of the Flutter SDK, in addition to those fetched\n-  /// from [storageBaseUrl].\n-  ///\n-  /// By default the base URL is https://chrome-infra-packages.appspot.com/dl.\n-  /// However, if `FLUTTER_STORAGE_BASE_URL` environment variable is provided\n-  /// ([kFlutterStorageBaseUrl]), then the following value is used:\n-  ///\n-  ///     FLUTTER_STORAGE_BASE_URL/flutter_infra_release/cipd\n-  ///\n-  /// See also:\n-  ///\n-  ///  * [storageBaseUrl], which determines how engine artifacts stored in the\n-  ///    Google Cloud Storage buckets are fetched.\n-  ///  * https://chromium.googlesource.com/infra/luci/luci-go/+/refs/heads/main/cipd,\n-  ///    which contains information about CIPD.\n-  ///  * [Cache] class-level dartdocs that explain how artifact mirrors work.\n-  String get cipdBaseUrl {\n-    final String? overrideUrl = _platform.environment[kFlutterStorageBaseUrl];\n-    if (overrideUrl == null) {\n-      return 'https://chrome-infra-packages.appspot.com/dl';\n-    }\n-\n-    final Uri original;\n-    try {\n-      original = Uri.parse(overrideUrl);\n-    } on FormatException catch (err) {\n-      throwToolExit('\"$kFlutterStorageBaseUrl\" contains an invalid URL:\\n$err');\n-    }\n-\n-    final cipdOverride = original\n-        .replace(pathSegments: <String>[...original.pathSegments, 'flutter_infra_release', 'cipd'])\n-        .toString();\n-    return cipdOverride;\n-  }\n-\n-  var _hasWarnedAboutStorageOverride = false;\n-\n-  void _maybeWarnAboutStorageOverride(String overrideUrl) {\n-    if (_hasWarnedAboutStorageOverride) {\n-      return;\n-    }\n-    _logger.printWarning(\n-      'Flutter assets will be downloaded from $overrideUrl. Make sure you trust this source!',\n-      emphasis: true,\n-      fatal: false,\n-    );\n-    _hasWarnedAboutStorageOverride = true;\n-  }\n-\n-  /// Return the top-level directory in the cache; this is `bin/cache`.\n-  Directory getRoot() {\n-    return _fileSystem.directory(\n-      _fileSystem.path.join(_rootOverride?.path ?? flutterRoot!, 'bin', 'cache'),\n-    );\n-  }\n-\n-  String getHostPlatformArchName() {\n-    return _osUtils.hostPlatform.platformName;\n-  }\n-\n-  /// Return a directory in the cache dir. For `pkg`, this will return `bin/cache/pkg`.\n-  ///\n-  /// When [shouldCreate] is true, the cache directory at [name] will be created\n-  /// if it does not already exist.\n-  Directory getCacheDir(String name, {bool shouldCreate = true}) {\n-    final Directory dir = _fileSystem.directory(_fileSystem.path.join(getRoot().path, name));\n-    if (!dir.existsSync() && shouldCreate) {\n-      dir.createSync(recursive: true);\n-      _osUtils.chmod(dir, '755');\n-    }\n-    return dir;\n-  }\n-\n-  /// Return the top-level directory for artifact downloads.\n-  Directory getDownloadDir() => getCacheDir('downloads');\n-\n-  /// Return the top-level mutable directory in the cache; this is `bin/cache/artifacts`.\n-  Directory getCacheArtifacts() => getCacheDir('artifacts');\n-\n-  /// Location of LICENSE file.\n-  File getLicenseFile() => _fileSystem.file(_fileSystem.path.join(flutterRoot!, 'LICENSE'));\n-\n-  /// Get a named directory from with the cache's artifact directory; for example,\n-  /// `material_fonts` would return `bin/cache/artifacts/material_fonts`.\n-  Directory getArtifactDirectory(String name) {\n-    return getCacheArtifacts().childDirectory(name);\n-  }\n-\n-  MapEntry<String, String> get dyLdLibEntry {\n-    if (_dyLdLibEntry != null) {\n-      return _dyLdLibEntry!;\n-    }\n-    final paths = <String>[];\n-    for (final ArtifactSet artifact in _artifacts) {\n-      final Map<String, String> env = artifact.environment;\n-      if (!env.containsKey('DYLD_LIBRARY_PATH')) {\n-        continue;\n-      }\n-      final String path = env['DYLD_LIBRARY_PATH']!;\n-      if (path.isEmpty) {\n-        continue;\n-      }\n-      paths.add(path);\n-    }\n-    _dyLdLibEntry = MapEntry<String, String>('DYLD_LIBRARY_PATH', paths.join(':'));\n-    return _dyLdLibEntry!;\n-  }\n-\n-  MapEntry<String, String>? _dyLdLibEntry;\n-\n-  /// The web sdk has to be co-located with the dart-sdk so that they can share source\n-  /// code.\n-  Directory getWebSdkDirectory() {\n-    return getRoot().childDirectory('flutter_web_sdk');\n-  }\n-\n-  String? getVersionFor(String artifactName) {\n-    final File versionFile = _fileSystem.file(\n-      _fileSystem.path.join(\n-        _rootOverride?.path ?? flutterRoot!,\n-        'bin',\n-        'internal',\n-        '$artifactName.version',\n-      ),\n-    );\n-    return versionFile.existsSync() ? versionFile.readAsStringSync().trim() : null;\n-  }\n-\n-  // TODO(matanlurey): Remove the ability to do \"generic\" realms, and special case for engine.\n-  // https://github.com/flutter/flutter/issues/164315\n-  String? getRealmFor(String artifactName) {\n-    final File realmFile = _fileSystem.file(\n-      _fileSystem.path.join(\n-        _rootOverride?.path ?? flutterRoot!,\n-        'bin',\n-        'cache',\n-        '$artifactName.realm',\n-      ),\n-    );\n-    return realmFile.existsSync() ? realmFile.readAsStringSync().trim() : '';\n-  }\n-\n-  /// Delete all stamp files maintained by the cache.\n-  void clearStampFiles() {\n-    try {\n-      getStampFileFor('flutter_tools').deleteSync();\n-      for (final ArtifactSet artifact in _artifacts) {\n-        final File file = getStampFileFor(artifact.stampName);\n-        ErrorHandlingFileSystem.deleteIfExists(file);\n-      }\n-    } on FileSystemException catch (err) {\n-      _logger.printWarning('Failed to delete some stamp files: $err');\n-    }\n-  }\n-\n-  /// Read the stamp for [artifactName].\n-  ///\n-  /// If the file is missing or cannot be parsed, returns `null`.\n-  String? getStampFor(String artifactName) {\n-    final File stampFile = getStampFileFor(artifactName);\n-    if (!stampFile.existsSync()) {\n-      return null;\n-    }\n-    try {\n-      return stampFile.readAsStringSync().trim();\n-    } on FileSystemException {\n-      return null;\n-    }\n-  }\n-\n-  void setStampFor(String artifactName, String version) {\n-    getStampFileFor(artifactName).writeAsStringSync(version);\n-  }\n-\n-  File getStampFileFor(String artifactName) {\n-    return _fileSystem.file(_fileSystem.path.join(getRoot().path, '$artifactName.stamp'));\n-  }\n-\n-  /// Returns `true` if either [entity] is older than the tools stamp or if\n-  /// [entity] doesn't exist.\n-  bool isOlderThanToolsStamp(FileSystemEntity entity) {\n-    final File flutterToolsStamp = getStampFileFor('flutter_tools');\n-    return _fsUtils.isOlderThanReference(entity: entity, referenceFile: flutterToolsStamp);\n-  }\n-\n-  Future<bool> isUpToDate() async {\n-    for (final ArtifactSet artifact in _artifacts) {\n-      if (!await artifact.isUpToDate(_fileSystem)) {\n-        return false;\n-      }\n-    }\n-    return true;\n-  }\n-\n-  /// Returns the list of artifacts that need updating from [requiredArtifacts].\n-  Future<List<ArtifactSet>> _collectArtifactsToUpdate(\n-    Set<DevelopmentArtifact> requiredArtifacts,\n-  ) async {\n-    final artifactsToUpdate = <ArtifactSet>[];\n-    final isLocalEngine = context.get<Artifacts>()?.localEngineInfo != null;\n-\n-    for (final ArtifactSet artifact in _artifacts) {\n-      if (!requiredArtifacts.contains(artifact.developmentArtifact)) {\n-        _logger.printTrace('Artifact $artifact is not required, skipping update.');\n-        continue;\n-      }\n-      if (isLocalEngine && (artifact is EngineCachedArtifact || artifact.name == 'engine_stamp')) {\n-        _logger.printTrace(\n-          'Artifact $artifact is an engine artifact or stamp and local engine is provided, skipping update.',\n-        );\n-        continue;\n-      }\n-      if (await artifact.isUpToDate(_fileSystem)) {\n-        continue;\n-      }\n-      artifactsToUpdate.add(artifact);\n-    }\n-    return artifactsToUpdate;\n-  }\n-\n-  /// Update the cache to contain all `requiredArtifacts`.\n-  Future<void> updateAll(Set<DevelopmentArtifact> requiredArtifacts, {bool offline = false}) async {\n-    if (!_lockEnabled) {\n-      return;\n-    }\n-\n-    final List<ArtifactSet> artifactsToUpdate = await _collectArtifactsToUpdate(requiredArtifacts);\n-\n-    if (artifactsToUpdate.isEmpty) {\n-      return;\n-    }\n-\n-    // Download artifacts and display progress\n-    final int total = artifactsToUpdate.length;\n-    for (var i = 0; i < artifactsToUpdate.length; i++) {\n-      final ArtifactSet artifact = artifactsToUpdate[i];\n-      final int current = i + 1;\n-\n-      // Set progress context for the artifact updater\n-      _artifactUpdater.setProgressContext(\n-        artifactIndex: current,\n-        artifactTotal: total,\n-        downloadTotal: artifact.downloadCount,\n-      );\n-\n-      // For artifacts containing multiple downloads, print the artifact name\n-      if (artifact.downloadCount > 1) {\n-        _logger.printStatus('[$current/$total] ${artifact.displayName}');\n-      }\n-\n-      try {\n-        await artifact.update(_artifactUpdater, _logger, _fileSystem, _osUtils, offline: offline);\n-      } on SocketException catch (e) {\n-        if (_hostsBlockedInChina.contains(e.address?.host)) {\n-          _logger.printError(\n-            'Failed to retrieve Flutter tool dependencies: ${e.message}.\\n'\n-            \"If you're in China, please see this page: \"\n-            'https://flutter.dev/to/china-setup',\n-            emphasis: true,\n-          );\n-        }\n-        rethrow;\n-      }\n-    }\n-    _artifactUpdater.resetProgressContext();\n-  }\n-\n-  Future<bool> areRemoteArtifactsAvailable({\n-    String? engineVersion,\n-    bool includeAllPlatforms = true,\n-  }) async {\n-    final bool includeAllPlatformsState = this.includeAllPlatforms;\n-    var allAvailable = true;\n-    this.includeAllPlatforms = includeAllPlatforms;\n-    for (final ArtifactSet cachedArtifact in _artifacts) {\n-      if (cachedArtifact is EngineCachedArtifact) {\n-        allAvailable &= await cachedArtifact.checkForArtifacts(engineVersion);\n-      }\n-    }\n-    this.includeAllPlatforms = includeAllPlatformsState;\n-    return allAvailable;\n-  }\n-\n-  Future<bool> doesRemoteExist(String message, Uri url) async {\n-    final Status status = _logger.startProgress(message);\n-    bool exists;\n-    try {\n-      exists = await _net.doesRemoteFileExist(url);\n-    } finally {\n-      status.stop();\n-    }\n-    return exists;\n-  }\n-}\n-\n-/// Representation of a set of artifacts used by the tool.\n-abstract class ArtifactSet {\n-  ArtifactSet(this.developmentArtifact);\n-\n-  /// The development artifact.\n-  final DevelopmentArtifact developmentArtifact;\n-\n-  /// Whether the artifact is up to date.\n-  Future<bool> isUpToDate(FileSystem fileSystem);\n-\n-  /// The environment variables (if any) required to consume the artifacts.\n-  Map<String, String> get environment {\n-    return const <String, String>{};\n-  }\n-\n-  /// Updates the artifact.\n-  Future<void> update(\n-    ArtifactUpdater artifactUpdater,\n-    Logger logger,\n-    FileSystem fileSystem,\n-    OperatingSystemUtils operatingSystemUtils, {\n-    bool offline = false,\n-  });\n-\n-  /// The canonical name of the artifact.\n-  String get name;\n-\n-  /// A prettier display name.\n-  ///\n-  /// Defaults to the canonical name.\n-  String get displayName => name;\n-\n-  /// The name of the stamp file.\n-  ///\n-  /// Defaults to the same as the artifact name.\n-  String get stampName => name;\n-\n-  /// The number of individual downloads this artifact will perform.\n-  ///\n-  /// Defaults to 1.\n-  int get downloadCount => 1;\n-}\n-\n-/// An artifact set managed by the cache.\n-abstract class CachedArtifact extends ArtifactSet {\n-  CachedArtifact(this.name, this.cache, DevelopmentArtifact developmentArtifact)\n-    : super(developmentArtifact);\n-\n-  final Cache cache;\n-\n-  @override\n-  final String name;\n-\n-  @override\n-  String get stampName => name;\n-\n-  Directory get location => cache.getArtifactDirectory(name);\n-\n-  String? get version => cache.getVersionFor(name);\n-\n-  // Whether or not to bypass normal platform filtering for this artifact.\n-  bool get ignorePlatformFiltering {\n-    return cache.includeAllPlatforms ||\n-        (cache.platformOverrideArtifacts != null &&\n-            cache.platformOverrideArtifacts!.contains(developmentArtifact.name));\n-  }\n-\n-  @override\n-  Future<bool> isUpToDate(FileSystem fileSystem) async {\n-    if (!location.existsSync()) {\n-      return false;\n-    }\n-    if (version != cache.getStampFor(stampName)) {\n-      return false;\n-    }\n-    return isUpToDateInner(fileSystem);\n-  }\n-\n-  @override\n-  Future<void> update(\n-    ArtifactUpdater artifactUpdater,\n-    Logger logger,\n-    FileSystem fileSystem,\n-    OperatingSystemUtils operatingSystemUtils, {\n-    bool offline = false,\n-  }) async {\n-    if (!location.existsSync()) {\n-      try {\n-        location.createSync(recursive: true);\n-      } on FileSystemException catch (err) {\n-        logger.printError(err.toString());\n-        throwToolExit(\n-          'Failed to create directory for flutter cache at ${location.path}. '\n-          'Flutter may be missing permissions in its cache directory.',\n-        );\n-      }\n-    }\n-    await updateInner(artifactUpdater, fileSystem, operatingSystemUtils);\n-    try {\n-      if (version == null) {\n-        logger.printWarning(\n-          'No known version for the artifact name \"$name\". '\n-          'Flutter can continue, but the artifact may be re-downloaded on '\n-          'subsequent invocations until the problem is resolved.',\n-        );\n-      } else {\n-        cache.setStampFor(stampName, version!);\n-      }\n-    } on FileSystemException catch (err) {\n-      logger.printWarning(\n-        'The new artifact \"$name\" was downloaded, but Flutter failed to update '\n-        'its stamp file, receiving the error \"$err\". '\n-        'Flutter can continue, but the artifact may be re-downloaded on '\n-        'subsequent invocations until the problem is resolved.',\n-      );\n-    }\n-    artifactUpdater.removeDownloadedFiles();\n-  }\n-\n-  /// Hook method for extra checks for being up-to-date.\n-  bool isUpToDateInner(FileSystem fileSystem) => true;\n-\n-  Future<void> updateInner(\n-    ArtifactUpdater artifactUpdater,\n-    FileSystem fileSystem,\n-    OperatingSystemUtils operatingSystemUtils,\n-  );\n-}\n-\n-abstract class EngineCachedArtifact extends CachedArtifact {\n-  EngineCachedArtifact(this.stampName, Cache cache, DevelopmentArtifact developmentArtifact)\n-    : super('engine', cache, developmentArtifact);\n-\n-  @override\n-  final String stampName;\n-\n-  @override\n-  String? get version => cache.engineRevision;\n-\n-  @override\n-  int get downloadCount => getPackageDirs().length + getBinaryDirs().length;\n-\n-  /// Return a list of (directory path, download URL path) tuples.\n-  List<List<String>> getBinaryDirs();\n-\n-  /// A list of cache directory paths to which the LICENSE file should be copied.\n-  List<String> getLicenseDirs();\n-\n-  /// A list of the dart package directories to download.\n-  List<String> getPackageDirs();\n-\n-  @override\n-  bool isUpToDateInner(FileSystem fileSystem) {\n-    final Directory pkgDir = cache.getCacheDir('pkg');\n-    for (final String pkgName in getPackageDirs()) {\n-      final String pkgPath = fileSystem.path.join(pkgDir.path, pkgName);\n-      if (!fileSystem.directory(pkgPath).existsSync()) {\n-        return false;\n-      }\n-    }\n-\n-    for (final List<String> toolsDir in getBinaryDirs()) {\n-      final Directory dir = fileSystem.directory(fileSystem.path.join(location.path, toolsDir[0]));\n-      if (!dir.existsSync()) {\n-        return false;\n-      }\n-    }\n-\n-    for (final String licenseDir in getLicenseDirs()) {\n-      final File file = fileSystem.file(fileSystem.path.join(location.path, licenseDir, 'LICENSE'));\n-      if (!file.existsSync()) {\n-        return false;\n-      }\n-    }\n-    return true;\n-  }\n-\n-  @override\n-  Future<void> updateInner(\n-    ArtifactUpdater artifactUpdater,\n-    FileSystem fileSystem,\n-    OperatingSystemUtils operatingSystemUtils,\n-  ) async {\n-    final url = '${cache.storageBaseUrl}/flutter_infra_release/flutter/$version/';\n-\n-    final Directory pkgDir = cache.getCacheDir('pkg');\n-    for (final String pkgName in getPackageDirs()) {\n-      await artifactUpdater.downloadZipArchive(pkgName, Uri.parse('$url$pkgName.zip'), pkgDir);\n-    }\n-\n-    for (final List<String> toolsDir in getBinaryDirs()) {\n-      final String cacheDir = toolsDir[0];\n-      final String urlPath = toolsDir[1];\n-      final Directory dir = fileSystem.directory(fileSystem.path.join(location.path, cacheDir));\n-\n-      final String friendlyName = urlPath.replaceAll('/artifacts.zip', '').replaceAll('.zip', '');\n-      await artifactUpdater.downloadZipArchive(friendlyName, Uri.parse(url + urlPath), dir);\n-\n-      _makeFilesExecutable(dir, operatingSystemUtils);\n-    }\n-\n-    final File licenseSource = cache.getLicenseFile();\n-    for (final String licenseDir in getLicenseDirs()) {\n-      final String licenseDestinationPath = fileSystem.path.join(\n-        location.path,\n-        licenseDir,\n-        'LICENSE',\n-      );\n-      await licenseSource.copy(licenseDestinationPath);\n-    }\n-  }\n-\n-  Future<bool> checkForArtifacts(String? engineVersion) async {\n-    engineVersion ??= version;\n-    final url = '${cache.storageBaseUrl}/flutter_infra_release/flutter/$engineVersion/';\n-\n-    var exists = false;\n-    for (final String pkgName in getPackageDirs()) {\n-      exists = await cache.doesRemoteExist(\n-        'Checking package $pkgName is available...',\n-        Uri.parse('$url$pkgName.zip'),\n-      );\n-      if (!exists) {\n-        return false;\n-      }\n-    }\n-\n-    for (final List<String> toolsDir in getBinaryDirs()) {\n-      final String cacheDir = toolsDir[0];\n-      final String urlPath = toolsDir[1];\n-      exists = await cache.doesRemoteExist(\n-        'Checking $cacheDir tools are available...',\n-        Uri.parse(url + urlPath),\n-      );\n-      if (!exists) {\n-        return false;\n-      }\n-    }\n-    return true;\n-  }\n-\n-  void _makeFilesExecutable(Directory dir, OperatingSystemUtils operatingSystemUtils) {\n-    operatingSystemUtils.chmod(dir, 'a+r,a+x');\n-    for (final File file in dir.listSync(recursive: true).whereType<File>()) {\n-      final FileStat stat = file.statSync();\n-      final isUserExecutable = ((stat.mode >> 6) & 0x1) == 1;\n-      if (file.basename == 'flutter_tester' || isUserExecutable) {\n-        // Make the file readable and executable by all users.\n-        operatingSystemUtils.chmod(file, 'a+r,a+x');\n-      }\n-    }\n-  }\n-}\n-\n-/// An API for downloading and un-archiving artifacts, such as engine binaries or\n-/// additional source code.\n-class ArtifactUpdater {\n-  ArtifactUpdater({\n-    required OperatingSystemUtils operatingSystemUtils,\n-    required Logger logger,\n-    required FileSystem fileSystem,\n-    required Directory tempStorage,\n-    required HttpClient httpClient,\n-    required Platform platform,\n-    required List<String> allowedBaseUrls,\n-    Stdio? stdio,\n-  }) : _operatingSystemUtils = operatingSystemUtils,\n-       _httpClient = httpClient,\n-       _logger = logger,\n-       _fileSystem = fileSystem,\n-       _tempStorage = tempStorage,\n-       _platform = platform,\n-       _allowedBaseUrls = allowedBaseUrls,\n-       _stdio = stdio;\n-\n-  /// The number of times the artifact updater will repeat the artifact download loop.\n-  static const _kRetryCount = 2;\n-\n-  final Logger _logger;\n-  final OperatingSystemUtils _operatingSystemUtils;\n-  final FileSystem _fileSystem;\n-  final Directory _tempStorage;\n-  final HttpClient _httpClient;\n-  final Platform _platform;\n-\n-  /// Artifacts should only be downloaded from URLs that use one of these\n-  /// prefixes.\n-  ///\n-  /// [ArtifactUpdater] will issue a warning if an attempt to download from a\n-  /// non-compliant URL is made.\n-  final List<String> _allowedBaseUrls;\n-\n-  final Stdio? _stdio;\n-\n-  /// Keep track of the files we've downloaded for this execution so we\n-  /// can delete them after completion. We don't delete them right after\n-  /// extraction in case [ArtifactSet.update] is interrupted, so we can\n-  /// restart without starting from scratch.\n-  @visibleForTesting\n-  final downloadedFiles = <File>[];\n-\n-  // Progress tracking state for download output formatting.\n-  int _artifactIndex = 0;\n-  int _artifactTotal = 0;\n-  int _downloadIndex = 0;\n-  int _downloadTotal = 0;\n-\n-  /// Sets the progress context for artifact downloads.\n-  ///\n-  /// This is called before each artifact update to enable progress output.\n-  /// The [downloadIndex] can be used to set the current download index\n-  /// within an artifact (1-based).\n-  void setProgressContext({\n-    required int artifactIndex,\n-    required int artifactTotal,\n-    required int downloadTotal,\n-    int downloadIndex = 0,\n-  }) {\n-    _artifactIndex = artifactIndex;\n-    _artifactTotal = artifactTotal;\n-    _downloadIndex = downloadIndex;\n-    _downloadTotal = downloadTotal;\n-  }\n-\n-  void resetProgressContext() {\n-    _artifactIndex = 0;\n-    _artifactTotal = 0;\n-    _downloadIndex = 0;\n-    _downloadTotal = 0;\n-  }\n-\n-  /// Creates the appropriate display for the current terminal capabilities.\n-  _DownloadDisplay _createDisplay(String statusMessage) {\n-    if (_stdio != null && _logger.supportsColor) {\n-      return _ProgressBarDisplay(stdio: _stdio, statusMessage: statusMessage);\n-    }\n-    return _SpinnerDisplay(logger: _logger, statusMessage: statusMessage);\n-  }\n-\n-  /// These filenames, should they exist after extracting an archive, should be deleted.\n-  static const _denylistedBasenames = <String>{\n-    'entitlements.txt',\n-    'without_entitlements.txt',\n-    'unsigned_binaries.txt',\n-  };\n-  void _removeDenylistedFiles(Directory directory) {\n-    for (final FileSystemEntity entity in directory.listSync(recursive: true)) {\n-      if (entity is! File) {\n-        continue;\n-      }\n-      if (_denylistedBasenames.contains(entity.basename)) {\n-        entity.deleteSync();\n-      }\n-    }\n-  }\n-\n-  /// Download a zip archive from the given [url] and unzip it to [location].\n-  Future<void> downloadZipArchive(String artifactName, Uri url, Directory location) {\n-    return _downloadArchive(artifactName, url, location, _operatingSystemUtils.unzip);\n-  }\n-\n-  /// Download a gzipped tarball from the given [url] and unpack it to [location].\n-  Future<void> downloadZippedTarball(String artifactName, Uri url, Directory location) {\n-    return _downloadArchive(artifactName, url, location, _operatingSystemUtils.unpack);\n-  }\n-\n-  /// Download a file from the given [url] and copy it to [location].\n-  Future<void> downloadFile(String artifactName, Uri url, Directory location) {\n-    return _downloadArchive(artifactName, url, location, (File file, Directory dir) {\n-      file.copySync(dir.childFile(file.basename).path);\n-    });\n-  }\n-\n-  /// Formats a download message with progress context.\n-  @visibleForTesting\n-  String formatProgressMessage(String artifactName) {\n-    final int displayIndex = _downloadIndex + 1;\n-    if (_downloadTotal == 1) {\n-      return '[$_artifactIndex/$_artifactTotal] $artifactName';\n-    } else {\n-      final prefix = displayIndex == _downloadTotal ? '└─' : '├─';\n-      return '  $prefix [$displayIndex/$_downloadTotal] $artifactName';\n-    }\n-  }\n-\n-  /// Download an archive from the given [url] and unzip it to [location].\n-  Future<void> _downloadArchive(\n-    String artifactName,\n-    Uri url,\n-    Directory location,\n-    void Function(File, Directory) extractor,\n-  ) async {\n-    final String downloadPath = flattenNameSubdirs(url, _fileSystem);\n-    final File tempFile = _createDownloadFile(downloadPath);\n-    int retries = _kRetryCount;\n-    final String formattedMessage = formatProgressMessage(artifactName);\n-    _downloadIndex++;\n-\n-    while (retries > 0) {\n-      final _DownloadDisplay display = _createDisplay(formattedMessage);\n-      display.start();\n-\n-      try {\n-        _ensureExists(tempFile.parent);\n-        if (tempFile.existsSync()) {\n-          tempFile.deleteSync();\n-        }\n-        await _download(url, tempFile, display);\n-\n-        if (!tempFile.existsSync()) {\n-          throw Exception('Did not find downloaded file ${tempFile.path}');\n-        }\n-        display.finish();\n-      } on Exception catch (err) {\n-        display.cancel();\n-        _logger.printTrace(err.toString());\n-        retries -= 1;\n-        if (retries == 0) {\n-          throwToolExit(\n-            'Failed to download $url. Ensure you have network connectivity and then try again.\\n$err',\n-          );\n-        }\n-        continue;\n-      } on ArgumentError catch (error) {\n-        display.cancel();\n-        final String? overrideUrl = _platform.environment[kFlutterStorageBaseUrl];\n-        if (overrideUrl != null && url.toString().contains(overrideUrl)) {\n-          _logger.printError(error.toString());\n-          throwToolExit(\n-            'The value of $kFlutterStorageBaseUrl ($overrideUrl) could not be '\n-            'parsed as a valid url. Please see https://flutter.dev/to/use-mirror-site '\n-            'for an example of how to use it.\\n'\n-            'Full URL: $url',\n-            exitCode: kNetworkProblemExitCode,\n-          );\n-        }\n-        // This error should not be hit if there was not a storage URL override, allow the\n-        // tool to crash.\n-        rethrow;\n-      }\n-\n-      /// Unzipping multiple file into a directory will not remove old files\n-      /// from previous versions that are not present in the new bundle.\n-      final Directory destination = location.childDirectory(\n-        tempFile.fileSystem.path.basenameWithoutExtension(tempFile.path),\n-      );\n-      try {\n-        ErrorHandlingFileSystem.deleteIfExists(destination, recursive: true);\n-      } on FileSystemException catch (error) {\n-        // Error that indicates another program has this file open and that it\n-        // cannot be deleted. For the cache, this is either the analyzer reading\n-        // the sky_engine package or a running flutter_tester device.\n-        const kSharingViolation = 32;\n-        if (_platform.isWindows && error.osError?.errorCode == kSharingViolation) {\n-          throwToolExit(\n-            'Failed to delete ${destination.path} because the local file/directory is in use '\n-            'by another process. Try closing any running IDEs or editors and trying '\n-            'again',\n-          );\n-        }\n-      }\n-      _ensureExists(location);\n-\n-      try {\n-        extractor(tempFile, location);\n-      } on Exception catch (err) {\n-        retries -= 1;\n-        if (retries == 0) {\n-          throwToolExit(\n-            'Flutter could not download and/or extract $url. Ensure you have '\n-            'network connectivity and all of the required dependencies listed at '\n-            'https://flutter.dev/setup.\\nThe original exception was: $err.',\n-          );\n-        }\n-        _deleteIgnoringErrors(tempFile);\n-        continue;\n-      }\n-      _removeDenylistedFiles(location);\n-      return;\n-    }\n-  }\n-\n-  /// Download bytes from [url], throwing non-200 responses as an exception.\n-  ///\n-  /// Validates that the md5 of the content bytes matches the provided\n-  /// `x-goog-hash` header, if present. This header should contain an md5 hash\n-  /// if the download source is Google cloud storage.\n-  ///\n-  /// See also:\n-  ///   * https://cloud.google.com/storage/docs/xml-api/reference-headers#xgooghash\n-  Future<void> _download(Uri url, File file, _DownloadDisplay display) async {\n-    final bool isAllowedUrl = _allowedBaseUrls.any(\n-      (String baseUrl) => url.toString().startsWith(baseUrl),\n-    );\n-\n-    // In tests make this a hard failure.\n-    assert(\n-      isAllowedUrl,\n-      'URL not allowed: $url\\n'\n-      'Allowed URLs must be based on one of: ${_allowedBaseUrls.join(', ')}',\n-    );\n-\n-    // In production, issue a warning but allow the download to proceed.\n-    if (!isAllowedUrl) {\n-      display.pause();\n-      _logger.printWarning(\n-        'Downloading an artifact that may not be reachable in some environments (e.g. firewalled environments): $url\\n'\n-        'This should not have happened. This is likely a Flutter SDK bug. Please file an issue at https://github.com/flutter/flutter/issues/new?template=01_activation.yml',\n-      );\n-      display.resume();\n-    }\n-\n-    final HttpClientRequest request = await _httpClient.getUrl(url);\n-    final HttpClientResponse response = await request.close();\n-    if (response.statusCode != HttpStatus.ok) {\n-      throw Exception(response.statusCode);\n-    }\n-\n-    final String? md5Hash = _expectedMd5(response.headers);\n-    ByteConversionSink? inputSink;\n-    late StreamController<Digest> digests;\n-    if (md5Hash != null) {\n-      _logger.printTrace('Content $url md5 hash: $md5Hash');\n-      digests = StreamController<Digest>();\n-      inputSink = md5.startChunkedConversion(digests);\n-    }\n-    final int contentLength = response.contentLength;\n-    final RandomAccessFile randomAccessFile = file.openSync(mode: FileMode.writeOnly);\n-    await response.forEach((List<int> chunk) {\n-      inputSink?.add(chunk);\n-      randomAccessFile.writeFromSync(chunk);\n-      display.onChunk(chunk.length, contentLength);\n-    });\n-    randomAccessFile.closeSync();\n-    if (inputSink != null) {\n-      inputSink.close();\n-      final Digest digest = await digests.stream.last;\n-      final String rawDigest = base64.encode(digest.bytes);\n-      if (rawDigest != md5Hash) {\n-        throw Exception(\n-          'Expected $url to have md5 checksum $md5Hash, but was $rawDigest. This '\n-          'may indicate a problem with your connection to the Flutter backend servers. '\n-          'Please re-try the download after confirming that your network connection is '\n-          'stable.',\n-        );\n-      }\n-    }\n-  }\n-\n-  String? _expectedMd5(HttpHeaders httpHeaders) {\n-    final List<String>? values = httpHeaders['x-goog-hash'];\n-    if (values == null) {\n-      return null;\n-    }\n-    String? rawMd5Hash;\n-    for (final String value in values) {\n-      if (value.startsWith('md5=')) {\n-        rawMd5Hash = value;\n-        break;\n-      }\n-    }\n-    if (rawMd5Hash == null) {\n-      return null;\n-    }\n-    final List<String> segments = rawMd5Hash.split('md5=');\n-    if (segments.length < 2) {\n-      return null;\n-    }\n-    final String md5Hash = segments[1];\n-    if (md5Hash.isEmpty) {\n-      return null;\n-    }\n-    return md5Hash;\n-  }\n-\n-  /// Create a temporary file and add it to the [downloadedFiles].\n-  File _createDownloadFile(String name) {\n-    final File tempFile = _fileSystem.file(_fileSystem.path.join(_tempStorage.path, name));\n-    downloadedFiles.add(tempFile);\n-    return tempFile;\n-  }\n-\n-  /// Create the given [directory] and parents, as necessary.\n-  void _ensureExists(Directory directory) {\n-    if (!directory.existsSync()) {\n-      directory.createSync(recursive: true);\n-    }\n-  }\n-\n-  /// Clear any zip/gzip files downloaded.\n-  void removeDownloadedFiles() {\n-    for (final File file in downloadedFiles) {\n-      if (!file.existsSync()) {\n-        continue;\n-      }\n-      try {\n-        file.deleteSync();\n-      } on FileSystemException catch (e) {\n-        _logger.printWarning('Failed to delete \"${file.path}\". Please delete manually. $e');\n-        continue;\n-      }\n-      for (\n-        Directory directory = file.parent;\n-        directory.absolute.path != _tempStorage.absolute.path;\n-        directory = directory.parent\n-      ) {\n-        // Handle race condition when the directory is deleted before this step\n-        if (!directory.existsSync()) {\n-          break;\n-        }\n-        if (directory.listSync().isNotEmpty) {\n-          break;\n-        }\n-        _deleteIgnoringErrors(directory);\n-      }\n-    }\n-  }\n-\n-  static void _deleteIgnoringErrors(FileSystemEntity entity) {\n-    if (!entity.existsSync()) {\n-      return;\n-    }\n-    try {\n-      entity.deleteSync();\n-    } on FileSystemException {\n-      // Ignore errors.\n-    }\n-  }\n-}\n-\n-@visibleForTesting\n-String flattenNameSubdirs(Uri url, FileSystem fileSystem) {\n-  final pieces = <String>[url.host, ...url.pathSegments];\n-  final Iterable<String> convertedPieces = pieces.map<String>(_flattenNameNoSubdirs);\n-  return fileSystem.path.joinAll(convertedPieces);\n-}\n-\n-/// Given a name containing slashes, colons, and backslashes, expand it into\n-/// something that doesn't.\n-String _flattenNameNoSubdirs(String fileName) {\n-  final replacedCodeUnits = <int>[\n-    for (final int codeUnit in fileName.codeUnits)\n-      ..._flattenNameSubstitutions[codeUnit] ?? <int>[codeUnit],\n-  ];\n-  return String.fromCharCodes(replacedCodeUnits);\n-}\n-\n-// Many characters are problematic in filenames, especially on Windows.\n-final _flattenNameSubstitutions = <int, List<int>>{\n-  r'@'.codeUnitAt(0): '@@'.codeUnits,\n-  r'/'.codeUnitAt(0): '@s@'.codeUnits,\n-  r'\\'.codeUnitAt(0): '@bs@'.codeUnits,\n-  r':'.codeUnitAt(0): '@c@'.codeUnits,\n-  r'%'.codeUnitAt(0): '@per@'.codeUnits,\n-  r'*'.codeUnitAt(0): '@ast@'.codeUnits,\n-  r'<'.codeUnitAt(0): '@lt@'.codeUnits,\n-  r'>'.codeUnitAt(0): '@gt@'.codeUnits,\n-  r'\"'.codeUnitAt(0): '@q@'.codeUnits,\n-  r'|'.codeUnitAt(0): '@pip@'.codeUnits,\n-  r'?'.codeUnitAt(0): '@ques@'.codeUnits,\n-};\n-\n-/// Abstraction for displaying download progress.\n-///\n-/// Two implementations exist:\n-/// - [_ProgressBarDisplay]: ANSI progress bar for terminals with color support.\n-/// - [_SpinnerDisplay]: Spinner-based display via [Logger.startProgress].\n-abstract class _DownloadDisplay {\n-  /// Called when the download begins.\n-  void start();\n-\n-  /// Called when a chunk of data is received.\n-  void onChunk(int chunkSize, int contentLength);\n-\n-  /// Called when the download completes successfully.\n-  void finish();\n-\n-  /// Called when the download is cancelled or fails.\n-  void cancel();\n-\n-  /// Pauses the display (e.g. when another status message needs the terminal).\n-  void pause();\n-\n-  /// Resumes the display after a pause.\n-  void resume();\n-}\n-\n-/// Displays an ANSI progress bar with speed, ETA, and percentage.\n-class _ProgressBarDisplay extends _DownloadDisplay {\n-  _ProgressBarDisplay({required Stdio stdio, required this.statusMessage}) : _stdio = stdio;\n-\n-  static const int _maxTerminalWidth = 80;\n-  static const int _progressUpdateIntervalMs = 100;\n-\n-  final Stdio _stdio;\n-  final String statusMessage;\n-  final DownloadProgress _progress = DownloadProgress();\n-  final Stopwatch _stopwatch = Stopwatch();\n-  int _lastUpdateMs = 0;\n-\n-  int get _terminalWidth =>\n-      (_stdio.terminalColumns ?? _maxTerminalWidth).clamp(0, _maxTerminalWidth);\n-\n-  @override\n-  void start() {\n-    _stopwatch.start();\n-    _stdio.stdoutWrite('$statusMessage\\n');\n-  }\n-\n-  @override\n-  void onChunk(int chunkSize, int contentLength) {\n-    if (_progress.totalBytes < 0) {\n-      _progress.totalBytes = contentLength;\n-    }\n-    _progress.addBytesReceived(chunkSize);\n-    final int currentMs = _stopwatch.elapsedMilliseconds;\n-    if (currentMs >= _lastUpdateMs + _progressUpdateIntervalMs) {\n-      _lastUpdateMs = currentMs;\n-      final String line = _progress.formatProgressLine(\n-        elapsed: _stopwatch.elapsed,\n-        terminalWidth: _terminalWidth,\n-      );\n-      _stdio.stdoutWrite('${AnsiTerminal.clearAndReturnCode}$line');\n-    }\n-  }\n-\n-  void _stopAndClear() {\n-    _stopwatch.stop();\n-    _stdio.stdoutWrite(\n-      '${AnsiTerminal.clearAndReturnCode}'\n-      '${AnsiTerminal.cursorUpLineCode}'\n-      '${AnsiTerminal.clearAndReturnCode}',\n-    );\n-  }\n-\n-  @override\n-  void finish() {\n-    _stopAndClear();\n-    final String summary = _progress.formatCompletionSummary(_stopwatch.elapsed);\n-    final int padding = _terminalWidth - statusMessage.length - summary.length;\n-    final line = '$statusMessage${' ' * max(1, padding)}$summary';\n-    _stdio.stdoutWrite('$line\\n');\n-  }\n-\n-  @override\n-  void cancel() {\n-    _stopAndClear();\n-  }\n-\n-  @override\n-  void pause() {}\n-\n-  @override\n-  void resume() {}\n-}\n-\n-/// Displays a spinner via [Logger.startProgress].\n-class _SpinnerDisplay extends _DownloadDisplay {\n-  _SpinnerDisplay({required Logger logger, required String statusMessage})\n-    : _logger = logger,\n-      _statusMessage = statusMessage;\n-\n-  final Logger _logger;\n-  final String _statusMessage;\n-  Status? _status;\n-\n-  @override\n-  void start() {\n-    _status = _logger.startProgress(_statusMessage);\n-  }\n-\n-  @override\n-  void onChunk(int chunkSize, int contentLength) {}\n-\n-  @override\n-  void finish() {\n-    _status?.stop();\n-  }\n-\n-  @override\n-  void cancel() {\n-    _status?.stop();\n-  }\n-\n-  @override\n-  void pause() {\n-    _status?.pause();\n-  }\n-\n-  @override\n-  void resume() {\n-    _status?.resume();\n-  }\n-}\n-\n-/// Tracks download progress and provides formatted display strings.\n-@visibleForTesting\n-class DownloadProgress {\n-  /// Total expected bytes, or -1 if unknown.\n-  int totalBytes = -1;\n-\n-  int _bytesReceived = 0;\n-  int get bytesReceived => _bytesReceived;\n-\n-  void addBytesReceived(int bytes) {\n-    _bytesReceived += bytes;\n-  }\n-\n-  bool get hasKnownSize => totalBytes > 0;\n-\n-  double get fractionReceived => hasKnownSize ? (_bytesReceived / totalBytes).clamp(0.0, 1.0) : 0.0;\n-\n-  int get percentReceived => (fractionReceived * 100).round();\n-\n-  /// Download speed in bytes per second.\n-  double speedBytesPerSecond(Duration elapsed) {\n-    if (elapsed.inMilliseconds == 0) {\n-      return 0;\n-    }\n-    return _bytesReceived * 1000 / elapsed.inMilliseconds;\n-  }\n-\n-  /// Estimated time remaining.\n-  Duration? timeRemaining(Duration elapsed) {\n-    final double speed = speedBytesPerSecond(elapsed);\n-    if (!hasKnownSize || speed == 0) {\n-      return null;\n-    }\n-    final int totalRemainingBytes = totalBytes - _bytesReceived;\n-    return Duration(milliseconds: (totalRemainingBytes * 1000 / speed).round());\n-  }\n-\n-  static const _subBlocks = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];\n-\n-  /// Renders a progress bar with sub-character precision.\n-  ///\n-  /// Uses 1/8-block characters for a smooth fill edge.\n-  String renderProgressBar(int width) {\n-    if (!hasKnownSize || width <= 0) {\n-      return '';\n-    }\n-    final int totalEighths = (fractionReceived * width * 8).round();\n-    final int fullBlocks = totalEighths ~/ 8;\n-    final int remainder = totalEighths % 8;\n-    final int emptyBlocks = width - fullBlocks - 1;\n-    final String filled = '█' * fullBlocks;\n-    final String partial = remainder > 0 ? _subBlocks[remainder - 1] : ' ';\n-    final String empty = ' ' * emptyBlocks;\n-    return '$filled$partial$empty';\n-  }\n-\n-  /// Formats download speed as a human-readable string.\n-  String formatSpeed(Duration elapsed) {\n-    return '${getSizeAsPlatformMB(speedBytesPerSecond(elapsed).round())}/s';\n-  }\n-\n-  /// Formats bytes received and total.\n-  String formatBytes() {\n-    if (hasKnownSize) {\n-      return '${getSizeAsPlatformMB(_bytesReceived)}'\n-          '/${getSizeAsPlatformMB(totalBytes)}';\n-    }\n-    return getSizeAsPlatformMB(_bytesReceived);\n-  }\n-\n-  /// Formats estimated time remaining.\n-  String formatRemaining(Duration elapsed) {\n-    final Duration? rem = timeRemaining(elapsed);\n-    if (rem == null) {\n-      return '';\n-    }\n-    return 'ETA ${getElapsedAsSeconds(rem)}';\n-  }\n-\n-  /// Formats the full progress line for terminal display.\n-  String formatProgressLine({required Duration elapsed, required int terminalWidth}) {\n-    final String indent = ' ' * 5;\n-    final percentReceivedStr = hasKnownSize ? '${percentReceived.toString().padLeft(3)}%' : '';\n-    final String bytesStr = formatBytes();\n-    final String speedStr = formatSpeed(elapsed);\n-    final String etaStr = formatRemaining(elapsed);\n-\n-    final parts = <String>[percentReceivedStr, bytesStr, speedStr, etaStr];\n-    final String info = parts.where((String s) => s.isNotEmpty).join('  ');\n-\n-    // The progress bar is 28 characters wide and terminated on either side by\n-    // thin vertical lines which take up another 2 characters. 28 characters was\n-    // chosen empirically to make the progress bar take up enough space to look\n-    // good while leaving enough space for the detailed info under \"normal\"\n-    // conditions (artifact size <1GB, download speed >1MB/s).\n-    const barInner = 28;\n-    const int barTotal = barInner + 2; // ▕ + bar + ▏\n-    final String line;\n-\n-    // Only show the progress bar if we have enough room to show it along with\n-    // the info, otherwise just show the info right-aligned.\n-    if (hasKnownSize && terminalWidth >= indent.length + barTotal + info.length) {\n-      final String bar = renderProgressBar(barInner);\n-      final int padding = terminalWidth - indent.length - barTotal - info.length;\n-      line = '$indent▕$bar▏${' ' * padding}$info';\n-    } else {\n-      final int padding = terminalWidth - indent.length - info.length;\n-      final unclipped = '$indent${' ' * max(0, padding)}$info';\n-      line = unclipped.length <= terminalWidth ? unclipped : unclipped.substring(0, terminalWidth);\n-    }\n-    return line;\n-  }\n-\n-  /// Formats the completion summary like `(21.1MB in 5.0s)`.\n-  String formatCompletionSummary(Duration elapsed) {\n-    final String size = getSizeAsPlatformMB(_bytesReceived);\n-    final String time = getElapsedAsSeconds(elapsed);\n-    return '($size in $time)';\n-  }\n-}\n+// Copyright 2014 The Flutter Authors. All rights reserved.\n+// Use of this source code is governed by a BSD-style license that can be\n+// found in the LICENSE file.\n+\n+/// @docImport 'flutter_cache.dart';\n+/// @docImport 'runner/flutter_command.dart';\n+/// @docImport 'runner/flutter_command_runner.dart';\n+library;\n+\n+import 'dart:async';\n+import 'dart:ffi' show Abi;\n+import 'dart:math' show max;\n+\n+import 'package:crypto/crypto.dart';\n+import 'package:file/memory.dart';\n+import 'package:meta/meta.dart';\n+import 'package:process/process.dart';\n+\n+import 'artifacts.dart';\n+import 'base/common.dart';\n+import 'base/context.dart';\n+import 'base/error_handling_io.dart';\n+import 'base/file_system.dart';\n+import 'base/io.dart'\n+    show\n+        HttpClient,\n+        HttpClientRequest,\n+        HttpClientResponse,\n+        HttpHeaders,\n+        HttpStatus,\n+        Stdio;\n+import 'base/logger.dart';\n+import 'base/net.dart';\n+import 'base/os.dart' show OperatingSystemUtils;\n+import 'base/platform.dart';\n+import 'base/terminal.dart';\n+import 'base/user_messages.dart';\n+import 'base/utils.dart' show getElapsedAsSeconds, getSizeAsPlatformMB;\n+import 'convert.dart';\n+import 'features.dart';\n+\n+const kFlutterRootEnvironmentVariableName =\n+    'FLUTTER_ROOT'; // should point to //flutter/ (root of flutter/flutter repo)\n+const kFlutterEngineEnvironmentVariableName =\n+    'FLUTTER_ENGINE'; // should point to //engine/src/ (root of flutter/engine repo)\n+const kSnapshotFileName = 'flutter_tools.snapshot'; // in //flutter/bin/cache/\n+const kFlutterToolsScriptFileName =\n+    'flutter_tools.dart'; // in //flutter/packages/flutter_tools/bin/\n+const kFlutterEnginePackageName = 'sky_engine';\n+\n+/// A tag for a set of development artifacts that need to be cached.\n+class DevelopmentArtifact {\n+  const DevelopmentArtifact._(this.name, {this.feature});\n+\n+  /// The name of the artifact.\n+  ///\n+  /// This should match the flag name in precache.dart.\n+  final String name;\n+\n+  /// A feature to control the visibility of this artifact.\n+  final Feature? feature;\n+\n+  /// Artifacts required for Android development.\n+  static const androidGenSnapshot = DevelopmentArtifact._(\n+    'android_gen_snapshot',\n+    feature: flutterAndroidFeature,\n+  );\n+  static const androidMaven = DevelopmentArtifact._(\n+    'android_maven',\n+    feature: flutterAndroidFeature,\n+  );\n+\n+  // Artifacts used for internal builds.\n+  static const androidInternalBuild = DevelopmentArtifact._(\n+    'android_internal_build',\n+    feature: flutterAndroidFeature,\n+  );\n+\n+  /// Artifacts required for iOS development.\n+  static const iOS = DevelopmentArtifact._('ios', feature: flutterIOSFeature);\n+\n+  /// Artifacts required for web development.\n+  static const web = DevelopmentArtifact._('web', feature: flutterWebFeature);\n+\n+  /// Artifacts required for desktop macOS.\n+  static const macOS = DevelopmentArtifact._('macos', feature: flutterMacOSDesktopFeature);\n+\n+  /// Artifacts required for desktop Windows.\n+  static const windows = DevelopmentArtifact._('windows', feature: flutterWindowsDesktopFeature);\n+\n+  /// Artifacts required for desktop Linux.\n+  static const linux = DevelopmentArtifact._('linux', feature: flutterLinuxDesktopFeature);\n+\n+  /// Artifacts required for Fuchsia.\n+  static const fuchsia = DevelopmentArtifact._('fuchsia', feature: flutterFuchsiaFeature);\n+\n+  /// Artifacts required for the Flutter Runner.\n+  static const flutterRunner = DevelopmentArtifact._(\n+    'flutter_runner',\n+    feature: flutterFuchsiaFeature,\n+  );\n+\n+  /// Artifacts required for any development platform.\n+  ///\n+  /// This does not need to be explicitly returned from requiredArtifacts as\n+  /// it will always be downloaded.\n+  static const universal = DevelopmentArtifact._('universal');\n+\n+  /// Artifacts which contain build information for the flutter tool.\n+  static const informative = DevelopmentArtifact._('informative');\n+\n+  /// The values of DevelopmentArtifacts.\n+  static final values = <DevelopmentArtifact>[\n+    androidGenSnapshot,\n+    androidMaven,\n+    androidInternalBuild,\n+    iOS,\n+    web,\n+    macOS,\n+    windows,\n+    linux,\n+    fuchsia,\n+    universal,\n+    flutterRunner,\n+    informative,\n+  ];\n+\n+  @override\n+  String toString() => 'Artifact($name)';\n+}\n+\n+/// A wrapper around the `bin/cache/` directory.\n+///\n+/// This does not provide any artifacts by default. See [FlutterCache] for the default\n+/// artifact set.\n+///\n+/// ## Artifact mirrors\n+///\n+/// Some environments cannot reach the Google Cloud Storage buckets and CIPD due\n+/// to regional or corporate policies.\n+///\n+/// To enable Flutter users in these environments, the Flutter tool supports\n+/// custom artifact mirrors that the administrators of such environments may\n+/// provide. To use an artifact mirror, the user defines the [kFlutterStorageBaseUrl]\n+/// (`FLUTTER_STORAGE_BASE_URL`) environment variable that points to the mirror.\n+/// Flutter tool reads this variable and uses it instead of the default URLs.\n+///\n+/// For more details on specific URLs used to download artifacts, see\n+/// [storageBaseUrl] and [cipdBaseUrl].\n+class Cache {\n+  /// [rootOverride] is configurable for testing.\n+  /// [artifacts] is configurable for testing.\n+  Cache({\n+    @protected Directory? rootOverride,\n+    @protected List<ArtifactSet>? artifacts,\n+    required Logger logger,\n+    required FileSystem fileSystem,\n+    required Platform platform,\n+    required OperatingSystemUtils osUtils,\n+    Stdio? stdio,\n+  }) : _rootOverride = rootOverride,\n+       _logger = logger,\n+       _fileSystem = fileSystem,\n+       _platform = platform,\n+       _osUtils = osUtils,\n+       _net = Net(logger: logger, platform: platform),\n+       _fsUtils = FileSystemUtils(fileSystem: fileSystem, platform: platform),\n+       _artifacts = artifacts ?? <ArtifactSet>[];\n+\n+  /// Create a [Cache] for testing.\n+  ///\n+  /// Defaults to a memory file system, fake platform,\n+  /// buffer logger, and no accessible artifacts.\n+  /// By default, the root cache directory path is \"cache\".\n+  factory Cache.test({\n+    Directory? rootOverride,\n+    List<ArtifactSet>? artifacts,\n+    Logger? logger,\n+    FileSystem? fileSystem,\n+    Platform? platform,\n+    Stdio? stdio,\n+    required ProcessManager processManager,\n+    Abi? currentAbi,\n+  }) {\n+    if (rootOverride?.fileSystem != null &&\n+        fileSystem != null &&\n+        rootOverride!.fileSystem != fileSystem) {\n+      throw ArgumentError(\n+        'If rootOverride and fileSystem are both non-null, '\n+            'rootOverride.fileSystem must be the same as fileSystem.',\n+        'fileSystem',\n+      );\n+    }\n+    fileSystem ??= rootOverride?.fileSystem ?? MemoryFileSystem.test();\n+    platform ??= FakePlatform(environment: <String, String>{});\n+    logger ??= BufferLogger.test();\n+    return Cache(\n+      rootOverride: rootOverride ?? fileSystem.currentDirectory,\n+      artifacts: artifacts ?? <ArtifactSet>[],\n+      logger: logger,\n+      fileSystem: fileSystem,\n+      platform: platform,\n+      stdio: stdio,\n+      osUtils: OperatingSystemUtils(\n+        fileSystem: fileSystem,\n+        logger: logger,\n+        platform: platform,\n+        processManager: processManager,\n+        currentAbi: currentAbi,\n+      ),\n+    );\n+  }\n+\n+  final Logger _logger;\n+  final Platform _platform;\n+  final FileSystem _fileSystem;\n+  final OperatingSystemUtils _osUtils;\n+  final Directory? _rootOverride;\n+  final List<ArtifactSet> _artifacts;\n+  final Net _net;\n+  final FileSystemUtils _fsUtils;\n+\n+  @visibleForTesting\n+  @protected\n+  void registerArtifact(ArtifactSet artifactSet) {\n+    _artifacts.add(artifactSet);\n+  }\n+\n+  // Initialized by FlutterCommandRunner on startup.\n+  // Explore making this field lazy to catch non-initialized access.\n+  static String? flutterRoot;\n+\n+  /// Determine the absolute and normalized path for the root of the current\n+  /// Flutter checkout.\n+  ///\n+  /// This method has a series of fallbacks for determining the repo location. The\n+  /// first success will immediately return the root without further checks.\n+  ///\n+  /// The order of these tests is:\n+  ///   1. FLUTTER_ROOT environment variable contains the path.\n+  ///   2. Platform script is a data URI scheme, returning `../..` to support\n+  ///      tests run from `packages/flutter_tools`.\n+  ///   3. Platform script is package URI scheme, returning the grandgrandparent\n+  ///      directory of the package config file location from\n+  ///      `packages/flutter_tools/.dart_tool/package_config.json`.\n+  ///   4. Platform script file path is the snapshot path generated by `bin/flutter`,\n+  ///      returning the grandparent directory from `bin/cache`.\n+  ///   5. Platform script file name is the entrypoint in `packages/flutter_tools/bin/flutter_tools.dart`,\n+  ///      returning the 4th parent directory.\n+  ///   6. The current directory\n+  ///\n+  /// If an exception is thrown during any of these checks, an error message is\n+  /// printed and `.` is returned by default (6).\n+  static String defaultFlutterRoot({\n+    required Platform platform,\n+    required FileSystem fileSystem,\n+    required UserMessages userMessages,\n+  }) {\n+    String normalize(String path) {\n+      return fileSystem.path.normalize(fileSystem.path.absolute(path));\n+    }\n+\n+    if (platform.environment.containsKey(kFlutterRootEnvironmentVariableName)) {\n+      return normalize(platform.environment[kFlutterRootEnvironmentVariableName]!);\n+    }\n+    try {\n+      if (platform.script.scheme == 'data') {\n+        return normalize('../..'); // The tool is running as a test.\n+      }\n+      final String Function(String) dirname = fileSystem.path.dirname;\n+\n+      if (platform.script.scheme == 'package') {\n+        final String packageConfigPath = Uri.parse(\n+          platform.packageConfig!,\n+        ).toFilePath(windows: platform.isWindows);\n+        return normalize(dirname(dirname(dirname(dirname(packageConfigPath)))));\n+      }\n+\n+      if (platform.script.scheme == 'file') {\n+        final String script = platform.script.toFilePath(windows: platform.isWindows);\n+        if (fileSystem.path.basename(script) == kSnapshotFileName) {\n+          return normalize(dirname(dirname(fileSystem.path.dirname(script))));\n+        }\n+        if (fileSystem.path.basename(script) == kFlutterToolsScriptFileName) {\n+          return normalize(dirname(dirname(dirname(dirname(script)))));\n+        }\n+      }\n+    } on Exception catch (error) {\n+      // There is currently no logger attached since this is computed at startup.\n+      // ignore: avoid_print\n+      print(userMessages.runnerNoRoot('$error'));\n+    }\n+    return normalize('.');\n+  }\n+\n+  // Whether to cache artifacts for all platforms. Defaults to only caching\n+  // artifacts for the current platform.\n+  bool includeAllPlatforms = false;\n+\n+  // Names of artifacts which should be cached even if they would normally\n+  // be filtered out for the current platform.\n+  Set<String>? platformOverrideArtifacts;\n+\n+  // Whether to cache the unsigned mac binaries. Defaults to caching the signed binaries.\n+  bool useUnsignedMacBinaries = false;\n+\n+  // Whether the warning printed when a custom artifact URL is used is fatal.\n+  bool fatalStorageWarning = true;\n+\n+  static RandomAccessFile? _lock;\n+  static var _lockEnabled = true;\n+\n+  /// Turn off the [lock]/[releaseLock] mechanism.\n+  ///\n+  /// This is used by the tests since they run simultaneously and all in one\n+  /// process and so it would be a mess if they had to use the lock.\n+  @visibleForTesting\n+  static void disableLocking() {\n+    _lockEnabled = false;\n+  }\n+\n+  /// Turn on the [lock]/[releaseLock] mechanism.\n+  ///\n+  /// This is used by the tests.\n+  @visibleForTesting\n+  static void enableLocking() {\n+    _lockEnabled = true;\n+  }\n+\n+  /// Check if lock acquired, skipping FLUTTER_ALREADY_LOCKED reentrant checks.\n+  ///\n+  /// This is used by the tests.\n+  @visibleForTesting\n+  static bool isLocked() {\n+    return _lock != null;\n+  }\n+\n+  /// Lock the cache directory.\n+  ///\n+  /// This happens while required artifacts are updated\n+  /// (see [FlutterCommandRunner.runCommand]).\n+  ///\n+  /// This uses normal POSIX flock semantics.\n+  Future<void> lock() async {\n+    if (!_lockEnabled) {\n+      return;\n+    }\n+    assert(_lock == null);\n+    final File lockFile = _fileSystem.file(\n+      _fileSystem.path.join(flutterRoot!, 'bin', 'cache', 'lockfile'),\n+    );\n+    try {\n+      _lock = lockFile.openSync(mode: FileMode.write);\n+    } on FileSystemException catch (e) {\n+      _logger.printError('Failed to open or create the artifact cache lockfile: \"$e\"');\n+      _logger.printError('Please ensure you have permissions to create or open ${lockFile.path}');\n+      throwToolExit('Failed to open or create the lockfile');\n+    }\n+    var locked = false;\n+    var printed = false;\n+    while (!locked) {\n+      try {\n+        _lock!.lockSync();\n+        locked = true;\n+      } on FileSystemException {\n+        if (!printed) {\n+          _logger.printTrace(\n+            'Waiting to be able to obtain lock of Flutter binary artifacts directory: ${_lock!.path}',\n+          );\n+          // This needs to go to stderr to avoid cluttering up stdout if a\n+          // parent process is collecting stdout (e.g. when calling \"flutter\n+          // version --machine\"). It's not really a \"warning\" though, so print it\n+          // in grey. Also, make sure that it isn't counted as a warning for\n+          // Logger.warningsAreFatal.\n+          _logger.printWarning(\n+            'Waiting for another flutter command to release the startup lock...',\n+            color: TerminalColor.grey,\n+            fatal: false,\n+          );\n+          printed = true;\n+        }\n+        await Future<void>.delayed(const Duration(milliseconds: 50));\n+      }\n+    }\n+  }\n+\n+  /// Releases the lock.\n+  ///\n+  /// This happens automatically on startup (see [FlutterCommand.verifyThenRunCommand])\n+  /// after the command's required artifacts are updated.\n+  void releaseLock() {\n+    if (!_lockEnabled || _lock == null) {\n+      return;\n+    }\n+    _lock!.closeSync();\n+    _lock = null;\n+  }\n+\n+  /// Checks if the current process owns the lock for the cache directory at\n+  /// this very moment; throws a [StateError] if it doesn't.\n+  void checkLockAcquired() {\n+    if (_lockEnabled &&\n+        _lock == null &&\n+        _platform.environment['FLUTTER_ALREADY_LOCKED'] != 'true') {\n+      throw StateError(\n+        'The current process does not own the lock for the cache directory. This is a bug in Flutter CLI tools.',\n+      );\n+    }\n+  }\n+\n+  String get devToolsVersion {\n+    if (_devToolsVersion == null) {\n+      const devToolsDirPath = 'dart-sdk/bin/resources/devtools';\n+      final Directory devToolsDir = getCacheDir(devToolsDirPath, shouldCreate: false);\n+      if (!devToolsDir.existsSync()) {\n+        throw Exception('Could not find directory at ${devToolsDir.path}');\n+      }\n+      final versionFilePath = '${devToolsDir.path}/version.json';\n+      final File versionFile = _fileSystem.file(versionFilePath);\n+      if (!versionFile.existsSync()) {\n+        throw Exception('Could not find file at $versionFilePath');\n+      }\n+      final dynamic data = jsonDecode(versionFile.readAsStringSync());\n+      if (data is! Map<String, Object?>) {\n+        throw Exception(\n+          \"Expected object of type 'Map<String, Object?>' but got one of type '${data.runtimeType}'\",\n+        );\n+      }\n+      final Object? version = data['version'];\n+      if (version == null) {\n+        throw Exception('Could not parse DevTools version from $version');\n+      }\n+      if (version is! String) {\n+        throw Exception(\n+          \"Could not parse DevTools version. Expected object of type 'String', but got one of type '${version.runtimeType}'\",\n+        );\n+      }\n+      return _devToolsVersion = version;\n+    }\n+    return _devToolsVersion!;\n+  }\n+\n+  String? _devToolsVersion;\n+\n+  /// The current version of Dart used to build Flutter and run the tool.\n+  String get dartSdkVersion {\n+    if (_dartSdkVersion == null) {\n+      // Make the version string more customer-friendly.\n+      // Changes '2.1.0-dev.8.0.flutter-4312ae32' to '2.1.0 (build 2.1.0-dev.8.0 4312ae32)'\n+      final String justVersion = _platform.version.split(' ')[0];\n+      _dartSdkVersion = justVersion.replaceFirstMapped(RegExp(r'(\\d+\\.\\d+\\.\\d+)(.+)'), (\n+        Match match,\n+      ) {\n+        final String noFlutter = match[2]!.replaceAll('.flutter-', ' ');\n+        return '${match[1]} (build ${match[1]}$noFlutter)';\n+      });\n+    }\n+    return _dartSdkVersion!;\n+  }\n+\n+  String? _dartSdkVersion;\n+\n+  /// The current version of Dart used to build Flutter and run the tool.\n+  String get dartSdkBuild {\n+    if (_dartSdkBuild == null) {\n+      // Make the version string more customer-friendly.\n+      // Changes '2.1.0-dev.8.0.flutter-4312ae32' to '2.1.0 (build 2.1.0-dev.8.0 4312ae32)'\n+      final String justVersion = _platform.version.split(' ')[0];\n+      _dartSdkBuild = justVersion.replaceFirstMapped(RegExp(r'(\\d+\\.\\d+\\.\\d+)(.+)'), (Match match) {\n+        final String noFlutter = match[2]!.replaceAll('.flutter-', ' ');\n+        return '${match[1]}$noFlutter';\n+      });\n+    }\n+    return _dartSdkBuild!;\n+  }\n+\n+  String? _dartSdkBuild;\n+\n+  /// The current version of the Flutter engine the flutter tool will download.\n+  String get engineRevision {\n+    _engineRevision ??= getStampFor('engine');\n+    if (_engineRevision == null) {\n+      throwToolExit('Could not determine engine revision.');\n+    }\n+    return _engineRevision!;\n+  }\n+\n+  String? _engineRevision;\n+\n+  /// The \"realm\" for the storage URL.\n+  ///\n+  /// For production artifacts from Engine post-submit and release builds,\n+  /// this string will be empty, and the `storageBaseUrl` will be unmodified.\n+  /// When non-empty, this string will be appended to the `storageBaseUrl` after\n+  /// a '/'. For artifacts generated by Engine presubmits, the realm should be\n+  /// \"flutter_archives_v2\".\n+  String get storageRealm {\n+    _storageRealm ??= getRealmFor('engine');\n+    if (_storageRealm == null) {\n+      throwToolExit('Could not determine engine realm.');\n+    }\n+    return _storageRealm!;\n+  }\n+\n+  String? _storageRealm;\n+\n+  /// The base for URLs that store Flutter engine artifacts that are fetched\n+  /// during the installation of the Flutter SDK.\n+  ///\n+  /// By default the base URL is https://storage.googleapis.com. However, if\n+  /// `FLUTTER_STORAGE_BASE_URL` environment variable ([kFlutterStorageBaseUrl])\n+  /// is provided, the environment variable value is returned instead.\n+  ///\n+  /// See also:\n+  ///\n+  ///  * [cipdBaseUrl], which determines how CIPD artifacts are fetched.\n+  ///  * [Cache] class-level dartdocs that explain how artifact mirrors work.\n+  String get storageBaseUrl {\n+    String? overrideUrl = _platform.environment[kFlutterStorageBaseUrl];\n+    if (overrideUrl == null) {\n+      return storageRealm.isEmpty\n+          ? 'https://storage.googleapis.com'\n+          : 'https://storage.googleapis.com/$storageRealm';\n+    }\n+    // verify that this is a valid URI.\n+    overrideUrl = storageRealm.isEmpty ? overrideUrl : '$overrideUrl/$storageRealm';\n+    try {\n+      Uri.parse(overrideUrl);\n+    } on FormatException catch (err) {\n+      throwToolExit('\"$kFlutterStorageBaseUrl\" contains an invalid URL:\\n$err');\n+    }\n+    _maybeWarnAboutStorageOverride(overrideUrl);\n+    return overrideUrl;\n+  }\n+\n+  String get realmlessStorageBaseUrl {\n+    return storageRealm.isEmpty ? storageBaseUrl : storageBaseUrl.replaceAll('/$storageRealm', '');\n+  }\n+\n+  /// The base for URLs that store Flutter engine artifacts in CIPD.\n+  ///\n+  /// For some platforms, such as Web and Fuchsia, CIPD artifacts are fetched\n+  /// during the installation of the Flutter SDK, in addition to those fetched\n+  /// from [storageBaseUrl].\n+  ///\n+  /// By default the base URL is https://chrome-infra-packages.appspot.com/dl.\n+  /// However, if `FLUTTER_STORAGE_BASE_URL` environment variable is provided\n+  /// ([kFlutterStorageBaseUrl]), then the following value is used:\n+  ///\n+  ///     FLUTTER_STORAGE_BASE_URL/flutter_infra_release/cipd\n+  ///\n+  /// See also:\n+  ///\n+  ///  * [storageBaseUrl], which determines how engine artifacts stored in the\n+  ///    Google Cloud Storage buckets are fetched.\n+  ///  * https://chromium.googlesource.com/infra/luci/luci-go/+/refs/heads/main/cipd,\n+  ///    which contains information about CIPD.\n+  ///  * [Cache] class-level dartdocs that explain how artifact mirrors work.\n+  String get cipdBaseUrl {\n+    final String? overrideUrl = _platform.environment[kFlutterStorageBaseUrl];\n+    if (overrideUrl == null) {\n+      return 'https://chrome-infra-packages.appspot.com/dl';\n+    }\n+\n+    final Uri original;\n+    try {\n+      original = Uri.parse(overrideUrl);\n+    } on FormatException catch (err) {\n+      throwToolExit('\"$kFlutterStorageBaseUrl\" contains an invalid URL:\\n$err');\n+    }\n+\n+    final cipdOverride = original\n+        .replace(pathSegments: <String>[...original.pathSegments, 'flutter_infra_release', 'cipd'])\n+        .toString();\n+    return cipdOverride;\n+  }\n+\n+  var _hasWarnedAboutStorageOverride = false;\n+\n+  void _maybeWarnAboutStorageOverride(String overrideUrl) {\n+    if (_hasWarnedAboutStorageOverride) {\n+      return;\n+    }\n+    _logger.printWarning(\n+      'Flutter assets will be downloaded from $overrideUrl. Make sure you trust this source!',\n+      emphasis: true,\n+      fatal: false,\n+    );\n+    _hasWarnedAboutStorageOverride = true;\n+  }\n+\n+  /// Return the top-level directory in the cache; this is `bin/cache`.\n+  Directory getRoot() {\n+    return _fileSystem.directory(\n+      _fileSystem.path.join(_rootOverride?.path ?? flutterRoot!, 'bin', 'cache'),\n+    );\n+  }\n+\n+  String getHostPlatformArchName() {\n+    return _osUtils.hostPlatform.platformName;\n+  }\n+\n+  /// Return a directory in the cache dir. For `pkg`, this will return `bin/cache/pkg`.\n+  ///\n+  /// When [shouldCreate] is true, the cache directory at [name] will be created\n+  /// if it does not already exist.\n+  Directory getCacheDir(String name, {bool shouldCreate = true}) {\n+    final Directory dir = _fileSystem.directory(_fileSystem.path.join(getRoot().path, name));\n+    if (!dir.existsSync() && shouldCreate) {\n+      throwToolExit('Flutter受控SDK缺少已准备目录：$name，请先完成工具库准备。');\n+    }\n+    return dir;\n+  }\n+\n+  /// Return the top-level directory for artifact downloads.\n+  Directory getDownloadDir() => getCacheDir('downloads');\n+\n+  /// Return the top-level mutable directory in the cache; this is `bin/cache/artifacts`.\n+  Directory getCacheArtifacts() => getCacheDir('artifacts');\n+\n+  /// Location of LICENSE file.\n+  File getLicenseFile() => _fileSystem.file(_fileSystem.path.join(flutterRoot!, 'LICENSE'));\n+\n+  /// Get a named directory from with the cache's artifact directory; for example,\n+  /// `material_fonts` would return `bin/cache/artifacts/material_fonts`.\n+  Directory getArtifactDirectory(String name) {\n+    return getCacheArtifacts().childDirectory(name);\n+  }\n+\n+  MapEntry<String, String> get dyLdLibEntry {\n+    if (_dyLdLibEntry != null) {\n+      return _dyLdLibEntry!;\n+    }\n+    final paths = <String>[];\n+    for (final ArtifactSet artifact in _artifacts) {\n+      final Map<String, String> env = artifact.environment;\n+      if (!env.containsKey('DYLD_LIBRARY_PATH')) {\n+        continue;\n+      }\n+      final String path = env['DYLD_LIBRARY_PATH']!;\n+      if (path.isEmpty) {\n+        continue;\n+      }\n+      paths.add(path);\n+    }\n+    _dyLdLibEntry = MapEntry<String, String>('DYLD_LIBRARY_PATH', paths.join(':'));\n+    return _dyLdLibEntry!;\n+  }\n+\n+  MapEntry<String, String>? _dyLdLibEntry;\n+\n+  /// The web sdk has to be co-located with the dart-sdk so that they can share source\n+  /// code.\n+  Directory getWebSdkDirectory() {\n+    return getRoot().childDirectory('flutter_web_sdk');\n+  }\n+\n+  String? getVersionFor(String artifactName) {\n+    final File versionFile = _fileSystem.file(\n+      _fileSystem.path.join(\n+        _rootOverride?.path ?? flutterRoot!,\n+        'bin',\n+        'internal',\n+        '$artifactName.version',\n+      ),\n+    );\n+    return versionFile.existsSync() ? versionFile.readAsStringSync().trim() : null;\n+  }\n+\n+  // TODO(matanlurey): Remove the ability to do \"generic\" realms, and special case for engine.\n+  // https://github.com/flutter/flutter/issues/164315\n+  String? getRealmFor(String artifactName) {\n+    final File realmFile = _fileSystem.file(\n+      _fileSystem.path.join(\n+        _rootOverride?.path ?? flutterRoot!,\n+        'bin',\n+        'cache',\n+        '$artifactName.realm',\n+      ),\n+    );\n+    return realmFile.existsSync() ? realmFile.readAsStringSync().trim() : '';\n+  }\n+\n+  /// Delete all stamp files maintained by the cache.\n+  void clearStampFiles() {\n+    try {\n+      getStampFileFor('flutter_tools').deleteSync();\n+      for (final ArtifactSet artifact in _artifacts) {\n+        final File file = getStampFileFor(artifact.stampName);\n+        ErrorHandlingFileSystem.deleteIfExists(file);\n+      }\n+    } on FileSystemException catch (err) {\n+      _logger.printWarning('Failed to delete some stamp files: $err');\n+    }\n+  }\n+\n+  /// Read the stamp for [artifactName].\n+  ///\n+  /// If the file is missing or cannot be parsed, returns `null`.\n+  String? getStampFor(String artifactName) {\n+    final File stampFile = getStampFileFor(artifactName);\n+    if (!stampFile.existsSync()) {\n+      return null;\n+    }\n+    try {\n+      return stampFile.readAsStringSync().trim();\n+    } on FileSystemException {\n+      return null;\n+    }\n+  }\n+\n+  void setStampFor(String artifactName, String version) {\n+    getStampFileFor(artifactName).writeAsStringSync(version);\n+  }\n+\n+  File getStampFileFor(String artifactName) {\n+    return _fileSystem.file(_fileSystem.path.join(getRoot().path, '$artifactName.stamp'));\n+  }\n+\n+  /// Returns `true` if either [entity] is older than the tools stamp or if\n+  /// [entity] doesn't exist.\n+  bool isOlderThanToolsStamp(FileSystemEntity entity) {\n+    final File flutterToolsStamp = getStampFileFor('flutter_tools');\n+    return _fsUtils.isOlderThanReference(entity: entity, referenceFile: flutterToolsStamp);\n+  }\n+\n+  Future<bool> isUpToDate() async {\n+    for (final ArtifactSet artifact in _artifacts) {\n+      if (!await artifact.isUpToDate(_fileSystem)) {\n+        return false;\n+      }\n+    }\n+    return true;\n+  }\n+\n+  /// Returns the list of artifacts that need updating from [requiredArtifacts].\n+  Future<List<ArtifactSet>> _collectArtifactsToUpdate(\n+    Set<DevelopmentArtifact> requiredArtifacts,\n+  ) async {\n+    final artifactsToUpdate = <ArtifactSet>[];\n+    final isLocalEngine = context.get<Artifacts>()?.localEngineInfo != null;\n+\n+    for (final ArtifactSet artifact in _artifacts) {\n+      if (!requiredArtifacts.contains(artifact.developmentArtifact)) {\n+        _logger.printTrace('Artifact $artifact is not required, skipping update.');\n+        continue;\n+      }\n+      if (isLocalEngine && (artifact is EngineCachedArtifact || artifact.name == 'engine_stamp')) {\n+        _logger.printTrace(\n+          'Artifact $artifact is an engine artifact or stamp and local engine is provided, skipping update.',\n+        );\n+        continue;\n+      }\n+      if (await artifact.isUpToDate(_fileSystem)) {\n+        continue;\n+      }\n+      artifactsToUpdate.add(artifact);\n+    }\n+    return artifactsToUpdate;\n+  }\n+\n+  /// Update the cache to contain all `requiredArtifacts`.\n+  Future<void> updateAll(Set<DevelopmentArtifact> requiredArtifacts, {bool offline = false}) async {\n+    if (!_lockEnabled) {\n+      return;\n+    }\n+\n+    final List<ArtifactSet> artifactsToUpdate = await _collectArtifactsToUpdate(requiredArtifacts);\n+\n+    if (artifactsToUpdate.isEmpty) {\n+      return;\n+    }\n+\n+    // 缺失资源明确失败；产品不得下载或更新其他任务正在读取的共享原件。\n+    throwToolExit(\n+      'Flutter受控SDK缺少已准备资源：${artifactsToUpdate.map((artifact) => artifact.name).join(', ')}。',\n+    );\n+  }\n+\n+  Future<bool> areRemoteArtifactsAvailable({\n+    String? engineVersion,\n+    bool includeAllPlatforms = true,\n+  }) async {\n+    final bool includeAllPlatformsState = this.includeAllPlatforms;\n+    var allAvailable = true;\n+    this.includeAllPlatforms = includeAllPlatforms;\n+    for (final ArtifactSet cachedArtifact in _artifacts) {\n+      if (cachedArtifact is EngineCachedArtifact) {\n+        allAvailable &= await cachedArtifact.checkForArtifacts(engineVersion);\n+      }\n+    }\n+    this.includeAllPlatforms = includeAllPlatformsState;\n+    return allAvailable;\n+  }\n+\n+  Future<bool> doesRemoteExist(String message, Uri url) async {\n+    final Status status = _logger.startProgress(message);\n+    bool exists;\n+    try {\n+      exists = await _net.doesRemoteFileExist(url);\n+    } finally {\n+      status.stop();\n+    }\n+    return exists;\n+  }\n+}\n+\n+/// Representation of a set of artifacts used by the tool.\n+abstract class ArtifactSet {\n+  ArtifactSet(this.developmentArtifact);\n+\n+  /// The development artifact.\n+  final DevelopmentArtifact developmentArtifact;\n+\n+  /// Whether the artifact is up to date.\n+  Future<bool> isUpToDate(FileSystem fileSystem);\n+\n+  /// The environment variables (if any) required to consume the artifacts.\n+  Map<String, String> get environment {\n+    return const <String, String>{};\n+  }\n+\n+  /// Updates the artifact.\n+  Future<void> update(\n+    ArtifactUpdater artifactUpdater,\n+    Logger logger,\n+    FileSystem fileSystem,\n+    OperatingSystemUtils operatingSystemUtils, {\n+    bool offline = false,\n+  });\n+\n+  /// The canonical name of the artifact.\n+  String get name;\n+\n+  /// A prettier display name.\n+  ///\n+  /// Defaults to the canonical name.\n+  String get displayName => name;\n+\n+  /// The name of the stamp file.\n+  ///\n+  /// Defaults to the same as the artifact name.\n+  String get stampName => name;\n+\n+  /// The number of individual downloads this artifact will perform.\n+  ///\n+  /// Defaults to 1.\n+  int get downloadCount => 1;\n+}\n+\n+/// An artifact set managed by the cache.\n+abstract class CachedArtifact extends ArtifactSet {\n+  CachedArtifact(this.name, this.cache, DevelopmentArtifact developmentArtifact)\n+    : super(developmentArtifact);\n+\n+  final Cache cache;\n+\n+  @override\n+  final String name;\n+\n+  @override\n+  String get stampName => name;\n+\n+  Directory get location => cache.getArtifactDirectory(name);\n+\n+  String? get version => cache.getVersionFor(name);\n+\n+  // Whether or not to bypass normal platform filtering for this artifact.\n+  bool get ignorePlatformFiltering {\n+    return cache.includeAllPlatforms ||\n+        (cache.platformOverrideArtifacts != null &&\n+            cache.platformOverrideArtifacts!.contains(developmentArtifact.name));\n+  }\n+\n+  @override\n+  Future<bool> isUpToDate(FileSystem fileSystem) async {\n+    if (!location.existsSync()) {\n+      return false;\n+    }\n+    if (version != cache.getStampFor(stampName)) {\n+      return false;\n+    }\n+    return isUpToDateInner(fileSystem);\n+  }\n+\n+  @override\n+  Future<void> update(\n+    ArtifactUpdater artifactUpdater,\n+    Logger logger,\n+    FileSystem fileSystem,\n+    OperatingSystemUtils operatingSystemUtils, {\n+    bool offline = false,\n+  }) async {\n+    throwToolExit('Flutter受控SDK资源只能在工具库准备阶段更新：$name。');\n+  }\n+\n+  /// Hook method for extra checks for being up-to-date.\n+  bool isUpToDateInner(FileSystem fileSystem) => true;\n+\n+  Future<void> updateInner(\n+    ArtifactUpdater artifactUpdater,\n+    FileSystem fileSystem,\n+    OperatingSystemUtils operatingSystemUtils,\n+  );\n+}\n+\n+abstract class EngineCachedArtifact extends CachedArtifact {\n+  EngineCachedArtifact(this.stampName, Cache cache, DevelopmentArtifact developmentArtifact)\n+    : super('engine', cache, developmentArtifact);\n+\n+  @override\n+  final String stampName;\n+\n+  @override\n+  String? get version => cache.engineRevision;\n+\n+  @override\n+  int get downloadCount => getPackageDirs().length + getBinaryDirs().length;\n+\n+  /// Return a list of (directory path, download URL path) tuples.\n+  List<List<String>> getBinaryDirs();\n+\n+  /// A list of cache directory paths to which the LICENSE file should be copied.\n+  List<String> getLicenseDirs();\n+\n+  /// A list of the dart package directories to download.\n+  List<String> getPackageDirs();\n+\n+  @override\n+  bool isUpToDateInner(FileSystem fileSystem) {\n+    final Directory pkgDir = cache.getCacheDir('pkg');\n+    for (final String pkgName in getPackageDirs()) {\n+      final String pkgPath = fileSystem.path.join(pkgDir.path, pkgName);\n+      if (!fileSystem.directory(pkgPath).existsSync()) {\n+        return false;\n+      }\n+    }\n+\n+    for (final List<String> toolsDir in getBinaryDirs()) {\n+      final Directory dir = fileSystem.directory(fileSystem.path.join(location.path, toolsDir[0]));\n+      if (!dir.existsSync()) {\n+        return false;\n+      }\n+    }\n+\n+    for (final String licenseDir in getLicenseDirs()) {\n+      final File file = fileSystem.file(fileSystem.path.join(location.path, licenseDir, 'LICENSE'));\n+      if (!file.existsSync()) {\n+        return false;\n+      }\n+    }\n+    return true;\n+  }\n+\n+  @override\n+  Future<void> updateInner(\n+    ArtifactUpdater artifactUpdater,\n+    FileSystem fileSystem,\n+    OperatingSystemUtils operatingSystemUtils,\n+  ) async {\n+    final url = '${cache.storageBaseUrl}/flutter_infra_release/flutter/$version/';\n+\n+    final Directory pkgDir = cache.getCacheDir('pkg');\n+    for (final String pkgName in getPackageDirs()) {\n+      await artifactUpdater.downloadZipArchive(pkgName, Uri.parse('$url$pkgName.zip'), pkgDir);\n+    }\n+\n+    for (final List<String> toolsDir in getBinaryDirs()) {\n+      final String cacheDir = toolsDir[0];\n+      final String urlPath = toolsDir[1];\n+      final Directory dir = fileSystem.directory(fileSystem.path.join(location.path, cacheDir));\n+\n+      final String friendlyName = urlPath.replaceAll('/artifacts.zip', '').replaceAll('.zip', '');\n+      await artifactUpdater.downloadZipArchive(friendlyName, Uri.parse(url + urlPath), dir);\n+\n+      _makeFilesExecutable(dir, operatingSystemUtils);\n+    }\n+\n+    final File licenseSource = cache.getLicenseFile();\n+    for (final String licenseDir in getLicenseDirs()) {\n+      final String licenseDestinationPath = fileSystem.path.join(\n+        location.path,\n+        licenseDir,\n+        'LICENSE',\n+      );\n+      await licenseSource.copy(licenseDestinationPath);\n+    }\n+  }\n+\n+  Future<bool> checkForArtifacts(String? engineVersion) async {\n+    engineVersion ??= version;\n+    final url = '${cache.storageBaseUrl}/flutter_infra_release/flutter/$engineVersion/';\n+\n+    var exists = false;\n+    for (final String pkgName in getPackageDirs()) {\n+      exists = await cache.doesRemoteExist(\n+        'Checking package $pkgName is available...',\n+        Uri.parse('$url$pkgName.zip'),\n+      );\n+      if (!exists) {\n+        return false;\n+      }\n+    }\n+\n+    for (final List<String> toolsDir in getBinaryDirs()) {\n+      final String cacheDir = toolsDir[0];\n+      final String urlPath = toolsDir[1];\n+      exists = await cache.doesRemoteExist(\n+        'Checking $cacheDir tools are available...',\n+        Uri.parse(url + urlPath),\n+      );\n+      if (!exists) {\n+        return false;\n+      }\n+    }\n+    return true;\n+  }\n+\n+  void _makeFilesExecutable(Directory dir, OperatingSystemUtils operatingSystemUtils) {\n+    operatingSystemUtils.chmod(dir, 'a+r,a+x');\n+    for (final File file in dir.listSync(recursive: true).whereType<File>()) {\n+      final FileStat stat = file.statSync();\n+      final isUserExecutable = ((stat.mode >> 6) & 0x1) == 1;\n+      if (file.basename == 'flutter_tester' || isUserExecutable) {\n+        // Make the file readable and executable by all users.\n+        operatingSystemUtils.chmod(file, 'a+r,a+x');\n+      }\n+    }\n+  }\n+}\n+\n+/// An API for downloading and un-archiving artifacts, such as engine binaries or\n+/// additional source code.\n+class ArtifactUpdater {\n+  ArtifactUpdater({\n+    required OperatingSystemUtils operatingSystemUtils,\n+    required Logger logger,\n+    required FileSystem fileSystem,\n+    required Directory tempStorage,\n+    required HttpClient httpClient,\n+    required Platform platform,\n+    required List<String> allowedBaseUrls,\n+    Stdio? stdio,\n+  }) : _operatingSystemUtils = operatingSystemUtils,\n+       _httpClient = httpClient,\n+       _logger = logger,\n+       _fileSystem = fileSystem,\n+       _tempStorage = tempStorage,\n+       _platform = platform,\n+       _allowedBaseUrls = allowedBaseUrls,\n+       _stdio = stdio;\n+\n+  /// The number of times the artifact updater will repeat the artifact download loop.\n+  static const _kRetryCount = 2;\n+\n+  final Logger _logger;\n+  final OperatingSystemUtils _operatingSystemUtils;\n+  final FileSystem _fileSystem;\n+  final Directory _tempStorage;\n+  final HttpClient _httpClient;\n+  final Platform _platform;\n+\n+  /// Artifacts should only be downloaded from URLs that use one of these\n+  /// prefixes.\n+  ///\n+  /// [ArtifactUpdater] will issue a warning if an attempt to download from a\n+  /// non-compliant URL is made.\n+  final List<String> _allowedBaseUrls;\n+\n+  final Stdio? _stdio;\n+\n+  /// Keep track of the files we've downloaded for this execution so we\n+  /// can delete them after completion. We don't delete them right after\n+  /// extraction in case [ArtifactSet.update] is interrupted, so we can\n+  /// restart without starting from scratch.\n+  @visibleForTesting\n+  final downloadedFiles = <File>[];\n+\n+  // Progress tracking state for download output formatting.\n+  int _artifactIndex = 0;\n+  int _artifactTotal = 0;\n+  int _downloadIndex = 0;\n+  int _downloadTotal = 0;\n+\n+  /// Sets the progress context for artifact downloads.\n+  ///\n+  /// This is called before each artifact update to enable progress output.\n+  /// The [downloadIndex] can be used to set the current download index\n+  /// within an artifact (1-based).\n+  void setProgressContext({\n+    required int artifactIndex,\n+    required int artifactTotal,\n+    required int downloadTotal,\n+    int downloadIndex = 0,\n+  }) {\n+    _artifactIndex = artifactIndex;\n+    _artifactTotal = artifactTotal;\n+    _downloadIndex = downloadIndex;\n+    _downloadTotal = downloadTotal;\n+  }\n+\n+  void resetProgressContext() {\n+    _artifactIndex = 0;\n+    _artifactTotal = 0;\n+    _downloadIndex = 0;\n+    _downloadTotal = 0;\n+  }\n+\n+  /// Creates the appropriate display for the current terminal capabilities.\n+  _DownloadDisplay _createDisplay(String statusMessage) {\n+    if (_stdio != null && _logger.supportsColor) {\n+      return _ProgressBarDisplay(stdio: _stdio, statusMessage: statusMessage);\n+    }\n+    return _SpinnerDisplay(logger: _logger, statusMessage: statusMessage);\n+  }\n+\n+  /// These filenames, should they exist after extracting an archive, should be deleted.\n+  static const _denylistedBasenames = <String>{\n+    'entitlements.txt',\n+    'without_entitlements.txt',\n+    'unsigned_binaries.txt',\n+  };\n+  void _removeDenylistedFiles(Directory directory) {\n+    for (final FileSystemEntity entity in directory.listSync(recursive: true)) {\n+      if (entity is! File) {\n+        continue;\n+      }\n+      if (_denylistedBasenames.contains(entity.basename)) {\n+        entity.deleteSync();\n+      }\n+    }\n+  }\n+\n+  /// Download a zip archive from the given [url] and unzip it to [location].\n+  Future<void> downloadZipArchive(String artifactName, Uri url, Directory location) {\n+    return _downloadArchive(artifactName, url, location, _operatingSystemUtils.unzip);\n+  }\n+\n+  /// Download a gzipped tarball from the given [url] and unpack it to [location].\n+  Future<void> downloadZippedTarball(String artifactName, Uri url, Directory location) {\n+    return _downloadArchive(artifactName, url, location, _operatingSystemUtils.unpack);\n+  }\n+\n+  /// Download a file from the given [url] and copy it to [location].\n+  Future<void> downloadFile(String artifactName, Uri url, Directory location) {\n+    return _downloadArchive(artifactName, url, location, (File file, Directory dir) {\n+      file.copySync(dir.childFile(file.basename).path);\n+    });\n+  }\n+\n+  /// Formats a download message with progress context.\n+  @visibleForTesting\n+  String formatProgressMessage(String artifactName) {\n+    final int displayIndex = _downloadIndex + 1;\n+    if (_downloadTotal == 1) {\n+      return '[$_artifactIndex/$_artifactTotal] $artifactName';\n+    } else {\n+      final prefix = displayIndex == _downloadTotal ? '└─' : '├─';\n+      return '  $prefix [$displayIndex/$_downloadTotal] $artifactName';\n+    }\n+  }\n+\n+  /// Download an archive from the given [url] and unzip it to [location].\n+  Future<void> _downloadArchive(\n+    String artifactName,\n+    Uri url,\n+    Directory location,\n+    void Function(File, Directory) extractor,\n+  ) async {\n+    final String downloadPath = flattenNameSubdirs(url, _fileSystem);\n+    final File tempFile = _createDownloadFile(downloadPath);\n+    int retries = _kRetryCount;\n+    final String formattedMessage = formatProgressMessage(artifactName);\n+    _downloadIndex++;\n+\n+    while (retries > 0) {\n+      final _DownloadDisplay display = _createDisplay(formattedMessage);\n+      display.start();\n+\n+      try {\n+        _ensureExists(tempFile.parent);\n+        if (tempFile.existsSync()) {\n+          tempFile.deleteSync();\n+        }\n+        await _download(url, tempFile, display);\n+\n+        if (!tempFile.existsSync()) {\n+          throw Exception('Did not find downloaded file ${tempFile.path}');\n+        }\n+        display.finish();\n+      } on Exception catch (err) {\n+        display.cancel();\n+        _logger.printTrace(err.toString());\n+        retries -= 1;\n+        if (retries == 0) {\n+          throwToolExit(\n+            'Failed to download $url. Ensure you have network connectivity and then try again.\\n$err',\n+          );\n+        }\n+        continue;\n+      } on ArgumentError catch (error) {\n+        display.cancel();\n+        final String? overrideUrl = _platform.environment[kFlutterStorageBaseUrl];\n+        if (overrideUrl != null && url.toString().contains(overrideUrl)) {\n+          _logger.printError(error.toString());\n+          throwToolExit(\n+            'The value of $kFlutterStorageBaseUrl ($overrideUrl) could not be '\n+            'parsed as a valid url. Please see https://flutter.dev/to/use-mirror-site '\n+            'for an example of how to use it.\\n'\n+            'Full URL: $url',\n+            exitCode: kNetworkProblemExitCode,\n+          );\n+        }\n+        // This error should not be hit if there was not a storage URL override, allow the\n+        // tool to crash.\n+        rethrow;\n+      }\n+\n+      /// Unzipping multiple file into a directory will not remove old files\n+      /// from previous versions that are not present in the new bundle.\n+      final Directory destination = location.childDirectory(\n+        tempFile.fileSystem.path.basenameWithoutExtension(tempFile.path),\n+      );\n+      try {\n+        ErrorHandlingFileSystem.deleteIfExists(destination, recursive: true);\n+      } on FileSystemException catch (error) {\n+        // Error that indicates another program has this file open and that it\n+        // cannot be deleted. For the cache, this is either the analyzer reading\n+        // the sky_engine package or a running flutter_tester device.\n+        const kSharingViolation = 32;\n+        if (_platform.isWindows && error.osError?.errorCode == kSharingViolation) {\n+          throwToolExit(\n+            'Failed to delete ${destination.path} because the local file/directory is in use '\n+            'by another process. Try closing any running IDEs or editors and trying '\n+            'again',\n+          );\n+        }\n+      }\n+      _ensureExists(location);\n+\n+      try {\n+        extractor(tempFile, location);\n+      } on Exception catch (err) {\n+        retries -= 1;\n+        if (retries == 0) {\n+          throwToolExit(\n+            'Flutter could not download and/or extract $url. Ensure you have '\n+            'network connectivity and all of the required dependencies listed at '\n+            'https://flutter.dev/setup.\\nThe original exception was: $err.',\n+          );\n+        }\n+        _deleteIgnoringErrors(tempFile);\n+        continue;\n+      }\n+      _removeDenylistedFiles(location);\n+      return;\n+    }\n+  }\n+\n+  /// Download bytes from [url], throwing non-200 responses as an exception.\n+  ///\n+  /// Validates that the md5 of the content bytes matches the provided\n+  /// `x-goog-hash` header, if present. This header should contain an md5 hash\n+  /// if the download source is Google cloud storage.\n+  ///\n+  /// See also:\n+  ///   * https://cloud.google.com/storage/docs/xml-api/reference-headers#xgooghash\n+  Future<void> _download(Uri url, File file, _DownloadDisplay display) async {\n+    final bool isAllowedUrl = _allowedBaseUrls.any(\n+      (String baseUrl) => url.toString().startsWith(baseUrl),\n+    );\n+\n+    // In tests make this a hard failure.\n+    assert(\n+      isAllowedUrl,\n+      'URL not allowed: $url\\n'\n+      'Allowed URLs must be based on one of: ${_allowedBaseUrls.join(', ')}',\n+    );\n+\n+    // In production, issue a warning but allow the download to proceed.\n+    if (!isAllowedUrl) {\n+      display.pause();\n+      _logger.printWarning(\n+        'Downloading an artifact that may not be reachable in some environments (e.g. firewalled environments): $url\\n'\n+        'This should not have happened. This is likely a Flutter SDK bug. Please file an issue at https://github.com/flutter/flutter/issues/new?template=01_activation.yml',\n+      );\n+      display.resume();\n+    }\n+\n+    final HttpClientRequest request = await _httpClient.getUrl(url);\n+    final HttpClientResponse response = await request.close();\n+    if (response.statusCode != HttpStatus.ok) {\n+      throw Exception(response.statusCode);\n+    }\n+\n+    final String? md5Hash = _expectedMd5(response.headers);\n+    ByteConversionSink? inputSink;\n+    late StreamController<Digest> digests;\n+    if (md5Hash != null) {\n+      _logger.printTrace('Content $url md5 hash: $md5Hash');\n+      digests = StreamController<Digest>();\n+      inputSink = md5.startChunkedConversion(digests);\n+    }\n+    final int contentLength = response.contentLength;\n+    final RandomAccessFile randomAccessFile = file.openSync(mode: FileMode.writeOnly);\n+    await response.forEach((List<int> chunk) {\n+      inputSink?.add(chunk);\n+      randomAccessFile.writeFromSync(chunk);\n+      display.onChunk(chunk.length, contentLength);\n+    });\n+    randomAccessFile.closeSync();\n+    if (inputSink != null) {\n+      inputSink.close();\n+      final Digest digest = await digests.stream.last;\n+      final String rawDigest = base64.encode(digest.bytes);\n+      if (rawDigest != md5Hash) {\n+        throw Exception(\n+          'Expected $url to have md5 checksum $md5Hash, but was $rawDigest. This '\n+          'may indicate a problem with your connection to the Flutter backend servers. '\n+          'Please re-try the download after confirming that your network connection is '\n+          'stable.',\n+        );\n+      }\n+    }\n+  }\n+\n+  String? _expectedMd5(HttpHeaders httpHeaders) {\n+    final List<String>? values = httpHeaders['x-goog-hash'];\n+    if (values == null) {\n+      return null;\n+    }\n+    String? rawMd5Hash;\n+    for (final String value in values) {\n+      if (value.startsWith('md5=')) {\n+        rawMd5Hash = value;\n+        break;\n+      }\n+    }\n+    if (rawMd5Hash == null) {\n+      return null;\n+    }\n+    final List<String> segments = rawMd5Hash.split('md5=');\n+    if (segments.length < 2) {\n+      return null;\n+    }\n+    final String md5Hash = segments[1];\n+    if (md5Hash.isEmpty) {\n+      return null;\n+    }\n+    return md5Hash;\n+  }\n+\n+  /// Create a temporary file and add it to the [downloadedFiles].\n+  File _createDownloadFile(String name) {\n+    final File tempFile = _fileSystem.file(_fileSystem.path.join(_tempStorage.path, name));\n+    downloadedFiles.add(tempFile);\n+    return tempFile;\n+  }\n+\n+  /// Create the given [directory] and parents, as necessary.\n+  void _ensureExists(Directory directory) {\n+    if (!directory.existsSync()) {\n+      directory.createSync(recursive: true);\n+    }\n+  }\n+\n+  /// Clear any zip/gzip files downloaded.\n+  void removeDownloadedFiles() {\n+    for (final File file in downloadedFiles) {\n+      if (!file.existsSync()) {\n+        continue;\n+      }\n+      try {\n+        file.deleteSync();\n+      } on FileSystemException catch (e) {\n+        _logger.printWarning('Failed to delete \"${file.path}\". Please delete manually. $e');\n+        continue;\n+      }\n+      for (\n+        Directory directory = file.parent;\n+        directory.absolute.path != _tempStorage.absolute.path;\n+        directory = directory.parent\n+      ) {\n+        // Handle race condition when the directory is deleted before this step\n+        if (!directory.existsSync()) {\n+          break;\n+        }\n+        if (directory.listSync().isNotEmpty) {\n+          break;\n+        }\n+        _deleteIgnoringErrors(directory);\n+      }\n+    }\n+  }\n+\n+  static void _deleteIgnoringErrors(FileSystemEntity entity) {\n+    if (!entity.existsSync()) {\n+      return;\n+    }\n+    try {\n+      entity.deleteSync();\n+    } on FileSystemException {\n+      // Ignore errors.\n+    }\n+  }\n+}\n+\n+@visibleForTesting\n+String flattenNameSubdirs(Uri url, FileSystem fileSystem) {\n+  final pieces = <String>[url.host, ...url.pathSegments];\n+  final Iterable<String> convertedPieces = pieces.map<String>(_flattenNameNoSubdirs);\n+  return fileSystem.path.joinAll(convertedPieces);\n+}\n+\n+/// Given a name containing slashes, colons, and backslashes, expand it into\n+/// something that doesn't.\n+String _flattenNameNoSubdirs(String fileName) {\n+  final replacedCodeUnits = <int>[\n+    for (final int codeUnit in fileName.codeUnits)\n+      ..._flattenNameSubstitutions[codeUnit] ?? <int>[codeUnit],\n+  ];\n+  return String.fromCharCodes(replacedCodeUnits);\n+}\n+\n+// Many characters are problematic in filenames, especially on Windows.\n+final _flattenNameSubstitutions = <int, List<int>>{\n+  r'@'.codeUnitAt(0): '@@'.codeUnits,\n+  r'/'.codeUnitAt(0): '@s@'.codeUnits,\n+  r'\\'.codeUnitAt(0): '@bs@'.codeUnits,\n+  r':'.codeUnitAt(0): '@c@'.codeUnits,\n+  r'%'.codeUnitAt(0): '@per@'.codeUnits,\n+  r'*'.codeUnitAt(0): '@ast@'.codeUnits,\n+  r'<'.codeUnitAt(0): '@lt@'.codeUnits,\n+  r'>'.codeUnitAt(0): '@gt@'.codeUnits,\n+  r'\"'.codeUnitAt(0): '@q@'.codeUnits,\n+  r'|'.codeUnitAt(0): '@pip@'.codeUnits,\n+  r'?'.codeUnitAt(0): '@ques@'.codeUnits,\n+};\n+\n+/// Abstraction for displaying download progress.\n+///\n+/// Two implementations exist:\n+/// - [_ProgressBarDisplay]: ANSI progress bar for terminals with color support.\n+/// - [_SpinnerDisplay]: Spinner-based display via [Logger.startProgress].\n+abstract class _DownloadDisplay {\n+  /// Called when the download begins.\n+  void start();\n+\n+  /// Called when a chunk of data is received.\n+  void onChunk(int chunkSize, int contentLength);\n+\n+  /// Called when the download completes successfully.\n+  void finish();\n+\n+  /// Called when the download is cancelled or fails.\n+  void cancel();\n+\n+  /// Pauses the display (e.g. when another status message needs the terminal).\n+  void pause();\n+\n+  /// Resumes the display after a pause.\n+  void resume();\n+}\n+\n+/// Displays an ANSI progress bar with speed, ETA, and percentage.\n+class _ProgressBarDisplay extends _DownloadDisplay {\n+  _ProgressBarDisplay({required Stdio stdio, required this.statusMessage}) : _stdio = stdio;\n+\n+  static const int _maxTerminalWidth = 80;\n+  static const int _progressUpdateIntervalMs = 100;\n+\n+  final Stdio _stdio;\n+  final String statusMessage;\n+  final DownloadProgress _progress = DownloadProgress();\n+  final Stopwatch _stopwatch = Stopwatch();\n+  int _lastUpdateMs = 0;\n+\n+  int get _terminalWidth =>\n+      (_stdio.terminalColumns ?? _maxTerminalWidth).clamp(0, _maxTerminalWidth);\n+\n+  @override\n+  void start() {\n+    _stopwatch.start();\n+    _stdio.stdoutWrite('$statusMessage\\n');\n+  }\n+\n+  @override\n+  void onChunk(int chunkSize, int contentLength) {\n+    if (_progress.totalBytes < 0) {\n+      _progress.totalBytes = contentLength;\n+    }\n+    _progress.addBytesReceived(chunkSize);\n+    final int currentMs = _stopwatch.elapsedMilliseconds;\n+    if (currentMs >= _lastUpdateMs + _progressUpdateIntervalMs) {\n+      _lastUpdateMs = currentMs;\n+      final String line = _progress.formatProgressLine(\n+        elapsed: _stopwatch.elapsed,\n+        terminalWidth: _terminalWidth,\n+      );\n+      _stdio.stdoutWrite('${AnsiTerminal.clearAndReturnCode}$line');\n+    }\n+  }\n+\n+  void _stopAndClear() {\n+    _stopwatch.stop();\n+    _stdio.stdoutWrite(\n+      '${AnsiTerminal.clearAndReturnCode}'\n+      '${AnsiTerminal.cursorUpLineCode}'\n+      '${AnsiTerminal.clearAndReturnCode}',\n+    );\n+  }\n+\n+  @override\n+  void finish() {\n+    _stopAndClear();\n+    final String summary = _progress.formatCompletionSummary(_stopwatch.elapsed);\n+    final int padding = _terminalWidth - statusMessage.length - summary.length;\n+    final line = '$statusMessage${' ' * max(1, padding)}$summary';\n+    _stdio.stdoutWrite('$line\\n');\n+  }\n+\n+  @override\n+  void cancel() {\n+    _stopAndClear();\n+  }\n+\n+  @override\n+  void pause() {}\n+\n+  @override\n+  void resume() {}\n+}\n+\n+/// Displays a spinner via [Logger.startProgress].\n+class _SpinnerDisplay extends _DownloadDisplay {\n+  _SpinnerDisplay({required Logger logger, required String statusMessage})\n+    : _logger = logger,\n+      _statusMessage = statusMessage;\n+\n+  final Logger _logger;\n+  final String _statusMessage;\n+  Status? _status;\n+\n+  @override\n+  void start() {\n+    _status = _logger.startProgress(_statusMessage);\n+  }\n+\n+  @override\n+  void onChunk(int chunkSize, int contentLength) {}\n+\n+  @override\n+  void finish() {\n+    _status?.stop();\n+  }\n+\n+  @override\n+  void cancel() {\n+    _status?.stop();\n+  }\n+\n+  @override\n+  void pause() {\n+    _status?.pause();\n+  }\n+\n+  @override\n+  void resume() {\n+    _status?.resume();\n+  }\n+}\n+\n+/// Tracks download progress and provides formatted display strings.\n+@visibleForTesting\n+class DownloadProgress {\n+  /// Total expected bytes, or -1 if unknown.\n+  int totalBytes = -1;\n+\n+  int _bytesReceived = 0;\n+  int get bytesReceived => _bytesReceived;\n+\n+  void addBytesReceived(int bytes) {\n+    _bytesReceived += bytes;\n+  }\n+\n+  bool get hasKnownSize => totalBytes > 0;\n+\n+  double get fractionReceived => hasKnownSize ? (_bytesReceived / totalBytes).clamp(0.0, 1.0) : 0.0;\n+\n+  int get percentReceived => (fractionReceived * 100).round();\n+\n+  /// Download speed in bytes per second.\n+  double speedBytesPerSecond(Duration elapsed) {\n+    if (elapsed.inMilliseconds == 0) {\n+      return 0;\n+    }\n+    return _bytesReceived * 1000 / elapsed.inMilliseconds;\n+  }\n+\n+  /// Estimated time remaining.\n+  Duration? timeRemaining(Duration elapsed) {\n+    final double speed = speedBytesPerSecond(elapsed);\n+    if (!hasKnownSize || speed == 0) {\n+      return null;\n+    }\n+    final int totalRemainingBytes = totalBytes - _bytesReceived;\n+    return Duration(milliseconds: (totalRemainingBytes * 1000 / speed).round());\n+  }\n+\n+  static const _subBlocks = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];\n+\n+  /// Renders a progress bar with sub-character precision.\n+  ///\n+  /// Uses 1/8-block characters for a smooth fill edge.\n+  String renderProgressBar(int width) {\n+    if (!hasKnownSize || width <= 0) {\n+      return '';\n+    }\n+    final int totalEighths = (fractionReceived * width * 8).round();\n+    final int fullBlocks = totalEighths ~/ 8;\n+    final int remainder = totalEighths % 8;\n+    final int emptyBlocks = width - fullBlocks - 1;\n+    final String filled = '█' * fullBlocks;\n+    final String partial = remainder > 0 ? _subBlocks[remainder - 1] : ' ';\n+    final String empty = ' ' * emptyBlocks;\n+    return '$filled$partial$empty';\n+  }\n+\n+  /// Formats download speed as a human-readable string.\n+  String formatSpeed(Duration elapsed) {\n+    return '${getSizeAsPlatformMB(speedBytesPerSecond(elapsed).round())}/s';\n+  }\n+\n+  /// Formats bytes received and total.\n+  String formatBytes() {\n+    if (hasKnownSize) {\n+      return '${getSizeAsPlatformMB(_bytesReceived)}'\n+          '/${getSizeAsPlatformMB(totalBytes)}';\n+    }\n+    return getSizeAsPlatformMB(_bytesReceived);\n+  }\n+\n+  /// Formats estimated time remaining.\n+  String formatRemaining(Duration elapsed) {\n+    final Duration? rem = timeRemaining(elapsed);\n+    if (rem == null) {\n+      return '';\n+    }\n+    return 'ETA ${getElapsedAsSeconds(rem)}';\n+  }\n+\n+  /// Formats the full progress line for terminal display.\n+  String formatProgressLine({required Duration elapsed, required int terminalWidth}) {\n+    final String indent = ' ' * 5;\n+    final percentReceivedStr = hasKnownSize ? '${percentReceived.toString().padLeft(3)}%' : '';\n+    final String bytesStr = formatBytes();\n+    final String speedStr = formatSpeed(elapsed);\n+    final String etaStr = formatRemaining(elapsed);\n+\n+    final parts = <String>[percentReceivedStr, bytesStr, speedStr, etaStr];\n+    final String info = parts.where((String s) => s.isNotEmpty).join('  ');\n+\n+    // The progress bar is 28 characters wide and terminated on either side by\n+    // thin vertical lines which take up another 2 characters. 28 characters was\n+    // chosen empirically to make the progress bar take up enough space to look\n+    // good while leaving enough space for the detailed info under \"normal\"\n+    // conditions (artifact size <1GB, download speed >1MB/s).\n+    const barInner = 28;\n+    const int barTotal = barInner + 2; // ▕ + bar + ▏\n+    final String line;\n+\n+    // Only show the progress bar if we have enough room to show it along with\n+    // the info, otherwise just show the info right-aligned.\n+    if (hasKnownSize && terminalWidth >= indent.length + barTotal + info.length) {\n+      final String bar = renderProgressBar(barInner);\n+      final int padding = terminalWidth - indent.length - barTotal - info.length;\n+      line = '$indent▕$bar▏${' ' * padding}$info';\n+    } else {\n+      final int padding = terminalWidth - indent.length - info.length;\n+      final unclipped = '$indent${' ' * max(0, padding)}$info';\n+      line = unclipped.length <= terminalWidth ? unclipped : unclipped.substring(0, terminalWidth);\n+    }\n+    return line;\n+  }\n+\n+  /// Formats the completion summary like `(21.1MB in 5.0s)`.\n+  String formatCompletionSummary(Duration elapsed) {\n+    final String size = getSizeAsPlatformMB(_bytesReceived);\n+    final String time = getElapsedAsSeconds(elapsed);\n+    return '($size in $time)';\n+  }\n+}\ndiff --git a/packages/flutter_tools/lib/src/windows/visual_studio.dart b/packages/flutter_tools/lib/src/windows/visual_studio.dart\nindex 2edeca77dc9bace3712d03acb6fde98d2d3c5473df1f9d1e8d2b86fc2fdabad1..8cb3c92a52b3d0ea2c5fc5a6f7fc2c92db5362ee8af211b51244f33e9fe8aa7c\n--- a/packages/flutter_tools/lib/src/windows/visual_studio.dart\n+++ b/packages/flutter_tools/lib/src/windows/visual_studio.dart\n@@ -159,21 +159,36 @@\n-  /// The path to CMake, or null if no Visual Studio installation has\n-  /// the components necessary to build.\n+  /// 受控准备器已验真固定归档；这里只接受准确入口并检查原VS生成器能力。\n   String? get cmakePath {\n     final VswhereDetails? details = _bestVisualStudioDetails;\n     if (details == null || !details.isUsable || details.installationPath == null) {\n       return null;\n     }\n-\n-    return _fileSystem.path.joinAll(<String>[\n-      details.installationPath!,\n-      'Common7',\n-      'IDE',\n-      'CommonExtensions',\n-      'Microsoft',\n-      'CMake',\n-      'CMake',\n-      'bin',\n-      'cmake.exe',\n-    ]);\n+    final String? command = _platform.environment['CMAKE_COMMAND'];\n+    if (command == null || !_fileSystem.path.isAbsolute(command) ||\n+        RegExp(r'[\\x00-\\x1f]').hasMatch(command) ||\n+        _fileSystem.path.basename(command) != 'cmake.exe' ||\n+        _fileSystem.typeSync(command, followLinks: false) != FileSystemEntityType.file ||\n+        _fileSystem.file(command).resolveSymbolicLinksSync() != command) {\n+      throwToolExit('Windows编译缺少验真的受控CMAKE_COMMAND绝对入口。');\n+    }\n+    // 不改变VS编译器或生成器；不支持的组合在产品编译前明确拒绝。\n+    final RunResult result = _processUtils.runSync(<String>[command, '-E', 'capabilities']);\n+    if (result.exitCode != 0) {\n+      throwToolExit('受控CMake能力读取失败。');\n+    }\n+    Object? capabilities;\n+    try {\n+      capabilities = json.decode(result.stdout);\n+    } on FormatException {\n+      throwToolExit('受控CMake能力输出无效。');\n+    }\n+    if (capabilities is! Map<String, dynamic> ||\n+        capabilities['generators'] is! List<dynamic> ||\n+        !(capabilities['generators'] as List<dynamic>).any(\n+          (dynamic generator) => generator is Map<String, dynamic> &&\n+              generator['name'] == cmakeGenerator,\n+        )) {\n+      throwToolExit('受控CMake不支持当前Visual Studio生成器：$cmakeGenerator。');\n+    }\n+    return command;\n   }\n-\n+\n@@ -312,2 +327,0 @@\n-      // CMake\n-      'Microsoft.VisualStudio.Component.VC.CMake.Project': 'C++ CMake tools for Windows',\ndiff --git a/packages/flutter_tools/lib/src/isolated/native_assets/macos/native_assets_host.dart b/packages/flutter_tools/lib/src/isolated/native_assets/macos/native_assets_host.dart\nindex a7e4310dc61574a1e03b6b25bc104a5bd55c0de824131255c779feeb66d36ee0..6f2ceb11402e01e33b030a0516f3865b817a2b9e44cc5009a1e76a1420e584dd\n--- a/packages/flutter_tools/lib/src/isolated/native_assets/macos/native_assets_host.dart\n+++ b/packages/flutter_tools/lib/src/isolated/native_assets/macos/native_assets_host.dart\n@@ -66,7 +66,8 @@\n /// ios device or macos arm64.\n Future<void> lipoDylibs(File target, List<File> sources) async {\n   final RunResult lipoResult = await globals.processUtils.run(<String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     'lipo',\n     '-create',\n     '-output',\n@@ -96,7 +97,8 @@\n   Map<String, String> oldToNewInstallNames,\n ) async {\n   final RunResult setInstallNamesResult = await globals.processUtils.run(<String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     'install_name_tool',\n     '-id',\n     newInstallName,\n@@ -119,7 +121,8 @@\n \n Future<Set<String>> getInstallNamesDylib(File dylibFile) async {\n   final RunResult installNameResult = await globals.processUtils.run(<String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     'otool',\n     '-D',\n     dylibFile.path,\n@@ -141,7 +144,8 @@\n /// Creates a dSYM bundle for a dylib.\n Future<void> dsymutilDylib(File dylibFile, String dsymPath) async {\n   final RunResult result = await globals.processUtils.run(<String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     'dsymutil',\n     dylibFile.path,\n     '-o',\n@@ -157,7 +161,8 @@\n /// This is useful for release builds to reduce binary size.\n Future<void> stripDylib(File dylibFile) async {\n   final RunResult result = await globals.processUtils.run(<String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     'strip',\n     '-x', // Remove local symbols.\n     '-S', // Remove debugging symbol table.\n@@ -179,7 +184,8 @@\n     codesignIdentity = '-';\n   }\n   final codesignCommand = <String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     'codesign',\n     '--force',\n     '--sign',\n@@ -221,7 +227,8 @@\n /// Invokes `xcrun --find` to find the full path to [binaryName].\n Future<Uri?> _findXcrunBinary(String binaryName, bool throwIfNotFound) async {\n   final RunResult xcrunResult = await globals.processUtils.run(<String>[\n-    'xcrun',\n+    // 固定Apple定位入口在每次交付前验真，不能从PATH选取副本。\n+    '/usr/bin/xcrun',\n     '--find',\n     binaryName,\n   ]);\n";
const parserDefinitions={"yaml":{"name":"yaml","version":"2.8.3","url":"https://registry.npmjs.org/yaml/-/yaml-2.8.3.tgz","integrity":"sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg=="},"toml":{"name":"smol-toml","version":"1.4.2","url":"https://registry.npmjs.org/smol-toml/-/smol-toml-1.4.2.tgz","integrity":"sha512-rInDH6lCNiEyn3+hH8KVGFdbjc099j47+OSgbMrfDYX1CmXLfdKd7qi6IfcWj2wFxvSVkuI46M+wPGYfEOEj6g=="}};
const cleanEnvironment=environment=>Object.fromEntries(['HOME','USER','LOGNAME','LANG','LC_ALL'].filter(k=>typeof environment[k]==='string').map(k=>[k,environment[k]]));
const objectRecipe=tool=>hash(JSON.stringify([tool,tool.id==='posix'?posixRecipe.buildPosixTool.toString():['native-source','gem'].includes(tool.archive?.kind)?sourceRecipe.buildSourceTool.toString():tool.id==='flutter'?flutterPatch:'locked-extract-v1']));
function toolArchive(tool){if(tool.archive)return tool.archive;if(tool.id==='cmake')return {...tool.archives.macos,kind:'extract',executable:'bin/cmake'};return null;}
async function verifyToolObject(directory,tool){
  if(!await stat(directory))return null;await directoryCheck(directory);const payload=join(directory,'payload'),archive=toolArchive(tool),path=join(payload,archive.executable);
  await directoryCheck(payload);const info=await regular(path);if(!(info.mode&0o111))fail('工具入口不可执行');return {path,version:tool.version};
 }
const directoryCheck=path=>directory(path);
// 基础工具的正式PATH投影排除发行件旧Shell/grep/sed；自举仅限本产品已声明GNU三工具。
async function productFoundation(library,verify,{bootstrap=false,id}={}){
 const base=await posixRecipe.controlledPosixTools(library,verify);if(bootstrap){if(!['bash','grep','sed'].includes(id))fail('自举仅限GNU三工具');return {...base,path:base.bin};}
 const tools={...base.tools},paths=[];for(const name of ['bash','grep','sed']){const tool=library.tools.find(x=>x.id===name),value=tool&&await verify(library,tool);if(!value)fail('GNU闭包缺失：'+name);tools[name]=value.path;paths.push(dirname(value.path));}tools.sh=tools.bash;delete tools.egrep;delete tools.fgrep;
 const view=join(library.work,'resource-tools');await directory(view,true);const shell=join(view,'sh');if(await stat(shell)){if(!((await lstat(shell)).isSymbolicLink())||await realpath(shell)!==tools.sh)fail('GNU sh交付漂移');}else await symlink(tools.sh,shell);for(const [name,path]of Object.entries(base.tools)){if(['sh','bash','grep','sed','egrep','fgrep'].includes(name))continue;const link=join(view,name);if(await stat(link)){if(!((await lstat(link)).isSymbolicLink())||await realpath(link)!==path)fail('基础交付漂移');}else await symlink(path,link);}return {tools,bin:view,path:[...paths,view].join(':')};
}
async function prepareSourceDependencies({library,tool,pending,signal,fetcher,options={}}){const result=new Map();for(const entry of tool.dependencies||[])result.set(entry.name,await acquireArchive(entry,{work:library.work,store:join(library.root,'archives'),optional:options.optionalDependencies,offline:options.offline,signal,fetcher}));return result;}
async function commitCandidate(pending,target,{signal,verify}={}){
 const supplied=resourceSupplies.getStore();if(supplied){if(typeof supplied.publishCandidate!=='function')fail('供给未交付提交能力');return supplied.publishCandidate(pending,target);}

 // 下载与编译已完成后才取得短锁；等待可取消，已有对象永不覆盖。
 const lock=target+'.lock';let handle;for(let n=0;n<500;n++){signal?.throwIfAborted();try{handle=await open(lock,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,20));}}if(!handle)fail('原件提交锁等待超限');
 try{signal?.throwIfAborted();if(await stat(target)){if(verify)await verify(target);}else await rename(pending,target);}finally{await handle.close();await rm(lock);}
}
async function installTool(library,tool,options,visiting=new Set()){
 const supplied=resourceSupplies.getStore();if(supplied&&!supplied.preparingTool){
  if(library.installed.has(tool.id))return library.installed.get(tool.id);
  const value=tool.id==='xcode'?await supplied.acquireApple({...supplyRequirements().apple,names:['xcodebuild']}).then(apple=>({path:apple.tools.xcodebuild,version:tool.version})):await supplied.acquireTool(supplyRequirements().tools.find(item=>item.id===tool.id));
  library.installed.set(tool.id,value);return value;
 }

 if(library.installed.has(tool.id))return library.installed.get(tool.id);if(visiting.has(tool.id))fail('工具声明循环：'+tool.id);visiting=new Set([...visiting,tool.id]);const archive=toolArchive(tool);
 if(tool.id==='xcode'){const apple=await verifyAppleTools(library,{environment:cleanEnvironment(options.environment),signal:options.signal});const value={path:apple.tools.xcodebuild,version:tool.version};library.installed.set(tool.id,value);return value;}
 if(!archive)fail('工具归档未声明：'+tool.id);const shared=join(library.root,'shared');await directory(shared,true);const target=join(shared,archive.sha256+'-'+objectRecipe(tool));const verify=p=>verifyToolObject(p,tool,{produced:true});let value=await verify(target);
 if(!value&&options.optionalTools&&await stat(options.optionalTools)){await directory(options.optionalTools);value=await verifyToolObject(join(options.optionalTools,'shared',archive.sha256),tool);}
 for(const id of tool.requires||[]){const entry=library.tools.find(x=>x.id===id);if(!entry)fail('前置工具未声明：'+id);await installTool(library,entry,options,visiting);}
 if(value){library.installed.set(tool.id,value);return value;}if(options.offline)fail('离线缺少工具：'+tool.id);
 // Node用内置解包形成最小宿主，POSIX用固定签名输入；其余工具只能使用完成GNU接管的基础工具。
 let foundation;if(!['node','posix'].includes(tool.id)){for(const id of ['posix',...(['bash','grep','sed'].includes(tool.id)?[]:['bash','grep','sed'])]){if(visiting.has(id))fail('工具自举循环');await installTool(library,library.tools.find(x=>x.id===id),options,visiting);}foundation=await productFoundation(library,async(_,t)=>library.installed.get(t.id),{bootstrap:['bash','grep','sed'].includes(tool.id),id:tool.id});}
 const pending=await fixedScratch(join(await resourceWork(library.work),'.'+archive.sha256+'-'));const canonical=join(pending,'library/shared',archive.sha256+'.pending'),payload=join(canonical,'payload');const localLibrary={...library,pending:canonical,finalPayload:options.finalPayload||join(target,'payload')};await directory(canonical,true);const original=join(canonical,'archive');
 try{
  let source;if(archive.kind==='apple-posix'){await verifyAppleTools(library,{names:['codesign'],environment:cleanEnvironment(options.environment),signal:options.signal});await posixRecipe.buildPosixTool({tool,payload,bootstrap:true,run:exec,signal:options.signal});source=payload;}
  else{const file=await acquireArchive(archive,{work:library.work,store:join(library.root,'archives'),optional:options.optionalDependencies,offline:options.offline,fetcher:options.fetcher,signal:options.signal});await copyFile(file,original);if(['gem','binary','phar'].includes(archive.kind))source=original;else {const unpacked=join(canonical,'unpack');await unpack(original,unpacked,{foundation,signal:options.signal});source=archive.root==='.'?unpacked:join(unpacked,archive.root);await directory(source);}}
  const environment={...cleanEnvironment(options.environment),HOME:canonical,TMPDIR:canonical,PATH:foundation?.path||'',PRODUCT_WORK_DIR:canonical};
  const verifyInstalled=async(_,t)=>library.installed.get(t.id)||null;
  if(['native-source','gem'].includes(archive.kind))await sourceRecipe.buildSourceTool({library:localLibrary,tool,source,archive:original,pending:canonical,payload,finalPayload:localLibrary.finalPayload,signal:options.signal,fetcher:options.fetcher,exec,verify:verifyInstalled,apple:verifyAppleTools,bootstrap:['bash','grep','sed'].includes(tool.id),environment,prepare:input=>prepareSourceDependencies({...input,options}),download:(entry,target,context)=>downloadTool(entry,target,{...context,...options,work:library.work,store:join(library.root,'archives'),optional:options.optionalDependencies})});
  else if(['binary','phar'].includes(archive.kind)){await mkdir(dirname(join(payload,archive.executable)),{recursive:true});await copyFile(original,join(payload,archive.executable));await chmod(join(payload,archive.executable),0o555);}
  else if(archive.kind==='rust'){
   await exec(foundation.tools.bash,[join(source,'install.sh'),'--prefix='+payload,'--disable-ldconfig','--components=rustc,cargo,rust-std-aarch64-apple-darwin,rust-src,rustfmt-preview,clippy-preview'],{signal:options.signal,env:environment,maxBuffer:2*1024**2,timeout:300000});
   for(const component of tool.components||[]){const file=await acquireArchive(component,{work:library.work,store:join(library.root,'archives'),offline:options.offline,fetcher:options.fetcher,signal:options.signal}),dir=join(canonical,component.target);await unpack(file,dir,{foundation,signal:options.signal});await exec(foundation.tools.bash,[join(dir,component.root,'install.sh'),'--prefix='+payload,'--disable-ldconfig'],{signal:options.signal,env:environment,maxBuffer:2*1024**2,timeout:300000});}
  }else if(archive.kind==='cargo-source'){
   await directory(payload,true);const rust=library.installed.get('rust').path,apple=await verifyAppleTools(library,{names:['clang','ar'],environment:cleanEnvironment(options.environment),signal:options.signal}),work=join(canonical,'cargo');await directory(work,true);
   const deps=await prepareCargo([join(source,'Cargo.lock')],work,{...options,library});await exec(join(dirname(rust),'cargo'),['build','--manifest-path',join(source,'Cargo.toml'),'--release','--locked','--offline','--bin',tool.command],{cwd:work,signal:options.signal,timeout:1800000,maxBuffer:8*1024**2,env:{...environment,PATH:dirname(rust)+':'+environment.PATH,RUSTC:rust,CC:apple.tools.clang,AR:apple.tools.ar,DEVELOPER_DIR:apple.developerDirectory,CARGO_HOME:deps.cargoHome,CARGO_TARGET_DIR:join(work,'target')}});await mkdir(join(payload,'bin'));await copyFile(join(work,'target/release',tool.command),join(payload,archive.executable));await copyFile(original,join(payload,'source.crate'));
  }else if(archive.kind!=='apple-posix')await rename(source,payload);
  if(tool.id==='pnpm')await symlink('pnpm.cjs',join(payload,'bin/pnpm'));
  if(tool.id==='flutter'){if(hash(Buffer.from(flutterPatch))!==tool.patch.sha256)fail('Flutter配方摘要不符');const dart=join(payload,'bin/cache/dart-sdk/bin/dart');await preparePub([join(payload,'packages/flutter_tools/pubspec.lock')],join(payload,'bin/cache/pub'),{...options,library,dart});environment.PATH=dirname(library.installed.get('node').path)+':'+foundation.path;await flutterRecipe.prepareFlutter(payload,{tool,files:flutterRecipe.parsePatch(flutterPatch),env:environment,signal:options.signal});}
  if(tool.id==='java')environment.JAVA_HOME=dirname(dirname(join(payload,archive.executable)));if(tool.id==='gradle')environment.JAVA_HOME=dirname(dirname(library.installed.get('java').path));if(tool.id==='python')environment.PYTHONHOME=payload;

  await permissions(payload,false);
  if(tool.id==='flutter'){await chmod(join(payload,'bin/cache/lockfile'),0o600);await chmod(join(payload,'packages/flutter_tools/gradle'),0o755);}
  options.signal?.throwIfAborted();await commitCandidate(canonical,target,{signal:options.signal,verify});value=await verify(target);library.installed.set(tool.id,value);return value;
 }finally{if(await stat(pending)){await permissions(pending,true);await rm(pending,{recursive:true});}}
}
async function parser(kind,options){
 const entry=parserDefinitions[kind],work=await resourceWork(options.library.work),parserRoot=join(work,'parsers',hash(JSON.stringify(entry))),payload=join(parserRoot,'payload');
 await directoryCheck(options.library.root);await directoryCheck(options.library.work);
 if(!await stat(payload)){
  if(await stat(parserRoot))fail('本轮解析器现场不完整');
  const file=await acquireArchive(entry,{work:options.library.work,store:join(options.library.root,'archives'),optional:options.optionalDependencies,offline:options.offline,fetcher:options.fetcher,signal:options.signal});
  await directory(parserRoot,true);
  try{await extractArchive(file,payload,{prefix:'package',signal:options.signal});}
  catch(error){await rm(parserRoot,{recursive:true,force:true});throw error;}
 }
 const mod=createRequire(import.meta.url)(payload);if(kind==='yaml')return text=>mod.parse(text,{uniqueKeys:true});const parse=text=>mod.parse(text);parse.stringify=mod.stringify;return parse;
}
async function checkedLock(path){await regular(path);const s=await lstat(path);if(s.size>32*1024**2)fail('锁文件超限');return readFile(path,'utf8');}
async function packageOriginal(entry,options){return acquireArchive(entry,{work:options.library.work,store:join(options.dependencyRoot||join(options.library.root,'..','rely'),'archives'),optional:options.optionalDependencies,offline:options.offline,fetcher:options.fetcher,signal:options.signal});}
async function prepareNpm(locks,work,options){const cache=join(work,'npm');await directory(cache,true);const node=options.library.installed.get('node').path,require=createRequire(join(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js')),cacache=require('cacache');for(const lock of locks){const document=JSON.parse(await checkedLock(lock));if(![2,3].includes(document.lockfileVersion)||!document.packages)fail('npm原始锁格式无效');for(const [path,entry]of Object.entries(document.packages)){if(!path||entry.link)continue;if(!entry.resolved||!entry.integrity||!entry.version)fail('npm包未锁定来源');const file=await packageOriginal({url:entry.resolved,integrity:entry.integrity},options);await cacache.put(join(cache,'_cacache'),'make-fetch-happen:request-cache:'+entry.resolved,await readFile(file),{integrity:entry.integrity,metadata:{time:Date.now(),url:entry.resolved,reqHeaders:{},resHeaders:{'content-type':'application/octet-stream'}}});}}return {npmCache:cache};}
async function preparePub(locks,cache,options){await directory(cache,true);const parse=await parser('yaml',options),files=[];for(const lock of locks){const d=parse(await checkedLock(lock));if(!d.packages)fail('Pub锁格式无效');for(const [name,entry]of Object.entries(d.packages)){if(['sdk','path'].includes(entry.source))continue;if(entry.source==='git'){const d=entry.description;if(!d||d.ref!==d['resolved-ref']||!options.sources?.some(x=>x.name===name&&x.url===d.url&&x.ref===d.ref))fail('Pub Git来源不属于产品固定闭包：'+name);continue;}if(entry.source!=='hosted'||entry.description?.name!==name||!['https://pub.dev','https://pub.dev/'].includes(entry.description.url)||!entry.description.sha256)fail('Pub来源未锁定');const coordinate={url:'https://pub.dev/api/archives/'+name+'-'+entry.version+'.tar.gz',sha256:entry.description.sha256};files.push({name:name+'-'+entry.version,sha256:coordinate.sha256,file:await packageOriginal(coordinate,options)});}}
 for(const entry of files){const target=join(cache,'hosted/pub.dev',entry.name),proof=join(cache,'hosted-hashes/pub.dev',entry.name+'.sha256');await directory(dirname(target),true);await directory(dirname(proof),true);if(await stat(target)){if(await readFile(proof,'utf8')!==entry.sha256+'\n')fail('Pub缓存摘要漂移');}else{await extractArchive(entry.file,target,{signal:options.signal});await writeFile(proof,entry.sha256+'\n',{flag:'wx'});}}
 await directory(join(cache,'_temp'),true);return {pubCache:cache};}
function gitCoordinate(source){const u=new URL(source.replace(/^git\+/u,''));const ref=u.searchParams.get('rev');if(u.protocol!=='https:'||u.hostname!=='github.com'||u.username||u.password||!u.pathname.endsWith('.git')||!/^[a-f0-9]{40}$/u.test(ref||'')||u.hash!=='#'+ref||[...u.searchParams.keys()].length!==1)fail('Git来源不是唯一锁定提交');return {url:u.origin+u.pathname,ref};}
async function gitCheckout(source,target,options){
 const git=options.library.installed.get('git')?.path;if(!git||!/^[a-f0-9]{40}$/u.test(source.ref||''))fail('Git未验真或来源没有固定提交');checkedURL(source.url);
 const environment={...cleanEnvironment(options.environment),PATH:(await productFoundation(options.library,async(_,t)=>options.library.installed.get(t.id))).path,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',HOME:options.library.work};
 const run=args=>exec(git,['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','protocol.file.allow=always',...args],{signal:options.signal,env:environment,maxBuffer:16*1024**2,timeout:600000});
 if(await stat(target)){await directory(target);await directory(join(target,'.git'));if((await run(['-C',target,'rev-parse','HEAD'])).stdout.trim()!==source.ref||(await run(['-C',target,'status','--porcelain=v1','--untracked-files=all'])).stdout||(await run(['-C',target,'remote','get-url','origin'])).stdout.trim()!==source.url)fail('Git检出身份漂移');return target;}
 // Git bundle只在当前任务使用，官方提交仍由固定ref和供给原件闭合。
 const bundle=join(await resourceWork(options.library.work),'git-bundles',hash(JSON.stringify(source))+'.bundle');await directory(dirname(bundle),true);
 if(!await stat(bundle)){const candidate=await fixedScratch(join(await resourceWork(options.library.work),'.git-'));try{const file=join(candidate,'source.bundle');let supplied;
   if(options.optionalDependencies){const index=join(dirname(options.optionalDependencies),'index.json');if(await stat(index)){await regular(index);if((await lstat(index)).size>32*1024**2)fail('Git可选索引超限');const d=await readDependencySupply(options.optionalDependencies),coordinate='git+'+source.url+'?rev='+source.ref+'#'+source.ref,entry=d.git_sources?.find(x=>x.source===coordinate);if(entry){if(!/^[a-f0-9]{64}$/u.test(entry.sha256||''))fail('Git供给摘要无效');const original=join(options.optionalDependencies,entry.sha256+'.blob');await regular(original);if(hash(await readFile(original))!==entry.sha256)fail('Git供给原件摘要不符');supplied=original;}}}
   if(supplied)await copyFile(supplied,file,constants.COPYFILE_EXCL);else{if(options.offline)fail('离线缺少Git提交');const checkout=join(candidate,'repository');await mkdir(checkout);await run(['init','--quiet',checkout]);await run(['-C',checkout,'fetch','--no-tags',source.url,source.ref]);if((await run(['-C',checkout,'rev-parse','FETCH_HEAD'])).stdout.trim()!==source.ref)fail('Git取得提交不符');await run(['-C',checkout,'update-ref','refs/heads/locked',source.ref]);await run(['-C',checkout,'bundle','create',file,'refs/heads/locked']);await rm(checkout,{recursive:true});}
   options.signal?.throwIfAborted();await rename(file,bundle);
  }finally{await rm(candidate,{recursive:true,force:true});}}
 await directory(dirname(target),true);const pending=await fixedScratch(join(dirname(target),'.checkout-'));try{const checkout=join(pending,'source');await run(['clone','--quiet','--no-checkout','--',bundle,checkout]);await run(['-C',checkout,'remote','set-url','origin',source.url]);await run(['-C',checkout,'checkout','--quiet','--detach',source.ref]);await run(['-C',checkout,'fsck','--full','--strict']);options.signal?.throwIfAborted();await rename(checkout,target);}finally{await rm(pending,{recursive:true});}return gitCheckout(source,target,options);
}
// Git工作区包转为目录源时展开workspace继承，并把相对path依赖固定到同一锁中的准确版本。
function normalizeCargoManifest(document,workspace,locked) {
 const d=structuredClone(document),w=workspace?.workspace||{};
 for(const [key,value]of Object.entries(d.package||{}))if(value&&typeof value==='object'&&value.workspace===true){if(w.package?.[key]===undefined)fail('Git包workspace字段缺失：'+key);d.package[key]=w.package[key];}
 const section=values=>{for(const [name,value]of Object.entries(values||{})){let dep=typeof value==='string'?{version:value}:{...value};if(dep.workspace){const inherited=w.dependencies?.[name];if(!inherited)fail('Git包workspace依赖缺失：'+name);const source=typeof inherited==='string'?{version:inherited}:inherited;dep={...source,...dep,features:[...(source.features||[]),...(dep.features||[])]};delete dep.workspace;}
  if(dep.path){delete dep.path;if(!dep.version){const matches=locked.filter(x=>x.name===(dep.package||name));if(matches.length!==1)fail('相对依赖没有唯一锁定版本：'+name);dep.version='='+matches[0].version;}}values[name]=dep;}};
 for(const key of ['dependencies','build-dependencies','dev-dependencies'])section(d[key]);for(const target of Object.values(d.target||{}))for(const key of ['dependencies','build-dependencies','dev-dependencies'])section(target[key]);if(d.lints?.workspace){if(!w.lints)fail('Git包workspace lints缺失');d.lints=w.lints;}delete d.workspace;return d;
}
async function prepareCargo(locks,work,options){await directory(work,true);const parse=await parser('toml',options),packages=new Map(),gitSources=new Map(),allPackages=[],vendor=join(work,'cargo-vendor');await directory(vendor,true);
 for(const lock of locks){const doc=parse(await checkedLock(lock));if(!Array.isArray(doc.package))fail('Cargo锁格式无效');allPackages.push(...doc.package);for(const pkg of doc.package){if(!pkg.source)continue;if(pkg.source==='registry+https://github.com/rust-lang/crates.io-index'){if(!/^[a-f0-9]{64}$/u.test(pkg.checksum||''))fail('Cargo包缺少摘要');const key=pkg.name+'-'+pkg.version;if(packages.has(key)&&packages.get(key)!==pkg.checksum)fail('Cargo包版本冲突');packages.set(key,pkg.checksum);const target=join(vendor,key),file=await packageOriginal({url:'https://static.crates.io/crates/'+pkg.name+'/'+key+'.crate',sha256:pkg.checksum},options);if(!await stat(target)){await extractArchive(file,target,{prefix:key,signal:options.signal});const files=Object.fromEntries((await inventory(target)).filter(x=>x.sha256).map(x=>[x.path,x.sha256]));await writeFile(join(target,'.cargo-checksum.json'),JSON.stringify({files,package:pkg.checksum}),{flag:'wx'});}else {const proof=JSON.parse(await readFile(join(target,'.cargo-checksum.json'),'utf8'));if(proof.package!==pkg.checksum)fail('Cargo目录源摘要漂移');for(const [name,digest]of Object.entries(proof.files)){if(!safePath(name)||hash(await readFile(join(target,name)))!==digest)fail('Cargo目录源被篡改');}}}
 else if(pkg.source.startsWith('git+')){const coordinate=gitCoordinate(pkg.source);if(!gitSources.has(pkg.source))gitSources.set(pkg.source,{coordinate,packages:[]});gitSources.get(pkg.source).packages.push(pkg);}else fail('Cargo来源未声明');}}
 let config='[net]\noffline = true\n[source.crates-io]\nreplace-with = "product-verified"\n[source.product-verified]\ndirectory = '+JSON.stringify(vendor)+'\n';
 for(const [source,entry]of gitSources){const checkout=await gitCheckout(entry.coordinate,join(work,'cargo-git',hash(source)),options);const manifests=[];async function walk(path){for(const name of await readdir(path)){if(['.git','target'].includes(name))continue;const file=join(path,name),s=await lstat(file);if(s.isDirectory())await walk(file);else if(name==='Cargo.toml'&&s.isFile())manifests.push(file);}}await walk(checkout);for(const pkg of entry.packages){let found;for(const manifest of manifests){const doc=parse(await readFile(manifest,'utf8'));if(doc.package?.name===pkg.name){let version=doc.package.version;if(typeof version==='object'&&version.workspace)version=parse(await readFile(join(checkout,'Cargo.toml'),'utf8')).workspace?.package?.version;if(version===pkg.version){if(found)fail('Git包路径不唯一');found=dirname(manifest);}}}if(!found)fail('Git包名称版本与锁不一致');const target=join(vendor,pkg.name+'-'+pkg.version+'-'+hash(source).slice(0,12));if(!await stat(target)){await copyTree(found,target);let workspace={};for(let at=found;inside(checkout,at)||at===checkout;at=dirname(at)){const file=join(at,'Cargo.toml');if(await stat(file)){const candidate=parse(await readFile(file,'utf8'));if(candidate.workspace){workspace=candidate;break;}}if(at===checkout)break;}const manifest=normalizeCargoManifest(parse(await readFile(join(found,'Cargo.toml'),'utf8')),workspace,allPackages);await writeFile(join(target,'Cargo.toml'),parse.stringify(manifest));const files=Object.fromEntries((await inventory(target)).filter(x=>x.sha256).map(x=>[x.path,x.sha256]));await writeFile(join(target,'.cargo-checksum.json'),JSON.stringify({files,package:null}));}}
 const key='product-git-'+hash(source).slice(0,12);config+='[source.'+key+']\ngit = '+JSON.stringify(entry.coordinate.url)+'\nrev = '+JSON.stringify(entry.coordinate.ref)+'\nreplace-with = "product-verified"\n';}
 const cargoHome=join(work,'cargo-home');await directory(cargoHome,true);await writeFile(join(cargoHome,'config.toml'),config);return {cargoHome};
}
async function copyTree(source,target){await directory(source);await mkdir(target);for(const name of await readdir(source)){if(['.git','target'].includes(name))continue;const a=join(source,name),b=join(target,name),s=await lstat(a);if(s.isDirectory())await copyTree(a,b);else if(s.isFile())await copyFile(a,b);else fail('目录源链接或特殊项未声明');}}
// 2026-10-06只读核对官方GitHub tag/Release资产元数据；未下载或安装这些原件。
const podSourceDefinitions=[];
// 官方tag仅用于核对声明；产品预先锁定其40位提交，运行时不解析浮动tag。
function podSourceCoordinate(spec, definitions = podSourceDefinitions) {
 const source=spec.source,entry=definitions.find(x=>x.name===spec.name&&x.version===spec.version);
 if(!source||typeof source!=='object')fail('Pod缺少官方来源');
 if(entry){if(source.git!==entry.url&&source.http!==entry.url||source.tag!==entry.tag&&entry.tag!==undefined)fail('Pod官方来源与产品固定坐标不一致');
  if(entry.ref){if(source.commit&&source.commit!==entry.ref)fail('Pod提交漂移');return {url:checkedURL(entry.url),ref:entry.ref};}
  if(source.sha256&&source.sha256!==entry.sha256)fail('Pod发行摘要漂移');return {url:checkedURL(entry.url),sha256:entry.sha256};}
 if(source.git&&/^[a-f0-9]{40}$/u.test(source.commit||''))return {url:checkedURL(source.git),ref:source.commit};
 if(source.http&&/^[a-f0-9]{64}$/u.test(source.sha256||''))return {url:checkedURL(source.http),sha256:source.sha256};
 fail('Pod来源没有产品锁定提交或SHA256：'+spec.name);
}
async function responseBytes(response,limit,signal){
 if(!response.ok||!response.body)fail('官方来源响应失败');if(Number(response.headers.get('content-length'))>limit)fail('官方响应声明超限');
 const chunks=[];let size=0;try{for await(const chunk of response.body){signal?.throwIfAborted();size+=chunk.length;if(size>limit)fail('官方响应数据超限');chunks.push(chunk);}if(!size)fail('官方响应为空');return Buffer.concat(chunks);}finally{await response.body.cancel().catch(()=>{});}
}
async function verifyPodSpec(file,name,version,checksum,options){
 await regular(file);if((await lstat(file)).size>2*1024**2)fail('Pod spec超限');const spec=JSON.parse(await readFile(file,'utf8'));
 if(spec.name!==name||String(spec.version)!==version)fail('Pod spec身份不符');
 const tool=options.library.installed.get('cocoapods'),ruby=options.library.installed.get('ruby')?.path;if(!tool||!ruby)fail('Pod验真缺少Ruby/CocoaPods');const gems=join(dirname(dirname(tool.path)),'gems');
 // 同一Ruby的自带Gem与产品交付Gem是唯一搜索路径；每次复用均回读规范spec锁摘要。
 const program="require 'rubygems'; ENV['GEM_PATH'] = [ENV.fetch('GEM_HOME'), Gem.default_dir].join(File::PATH_SEPARATOR); Gem.clear_paths; require 'logger'; require 'cocoapods'; print Pod::Specification.from_file(ARGV.fetch(0)).checksum";
 const result=await exec(ruby,['-e',program,file],{signal:options.signal,env:{...cleanEnvironment(options.environment),GEM_HOME:gems,GEM_PATH:gems},maxBuffer:1024**2});if(result.stdout!==checksum)fail('Pod spec与锁摘要不符');return spec;
}
async function copyPodSource(source,target,base=source){
 await directory(source);await directory(target,true);for(const name of await readdir(source)){if(name==='.git')continue;const input=join(source,name),output=join(target,name),s=await lstat(input);
  if(s.isDirectory())await copyPodSource(input,output,base);else if(s.isFile()){await regular(input);await copyFile(input,output,constants.COPYFILE_EXCL);await chmod(output,s.mode&0o111?0o755:0o644);}else if(s.isSymbolicLink()){const resolved=await realpath(input);if(!inside(base,resolved))fail('Pod源码链接越界');await symlink(await readlink(input),output);}else fail('Pod源码含特殊项');}
}
async function preparePods(lockfile,work,options){const parse=await parser('yaml',options),text=await checkedLock(lockfile),lock=parse(text),podHome=join(work,'cocoapods');await directory(podHome,true);
 // 可选供给按单个Pod坐标匹配，与整锁、宿主和其它Pod变化无关。
 let restored=false;const supplied=await readDependencySupply(options.optionalDependencies);

 const local=new Set();for(const [name,source]of Object.entries(lock['EXTERNAL SOURCES']||{})){if(typeof source[':path']!=='string'||Object.keys(source).some(x=>x!==':path'))fail('Pod外部来源必须另有产品固定锁：'+name);local.add(name);}
 const handled=new Set();for(const item of lock.PODS||[]){const record=typeof item==='string'?item:Object.keys(item)[0],m=/^([^/( ]+)(?:\/[^ (]+)? \(([^)]+)\)$/u.exec(record);if(!m)fail('Pod锁记录无效');const [,name,version]=m;if(local.has(name)||handled.has(name))continue;handled.add(name);
  const checksum=lock['SPEC CHECKSUMS']?.[name];if(!/^[a-f0-9]{40}$/u.test(checksum||''))fail('Pod缺少锁定spec摘要');const key=version+'-'+checksum.slice(0,5),specPath=join(podHome,'cache/Pods/Specs/Release',name,key+'.podspec.json'),release=join(podHome,'cache/Pods/Release',name,key);
  const candidates=(supplied?.pods||[]).filter(x=>x.name===name&&x.version===version&&x.checksum===checksum);if(candidates.length>1)fail('Pod供给坐标重复');if(candidates.length){await materializePodSupply(candidates[0],options.optionalDependencies,podHome,{signal:options.signal});restored=true;}
  // Pod spec与源码仅物化到当前任务的CocoaPods视图。
  if(!await stat(specPath)||!await stat(release)){const candidate=await fixedScratch(join(await resourceWork(options.library.work),'.pod-'));try{const payload=join(candidate,'payload');await mkdir(payload);const specFile=join(payload,'spec.json');
    if(await stat(specPath))await copyFile(specPath,specFile,constants.COPYFILE_EXCL);else{if(options.offline)fail('离线缺少Pod spec');const md5=createHash('md5').update(name).digest('hex'),url='https://cdn.cocoapods.org/Specs/'+md5[0]+'/'+md5[1]+'/'+md5[2]+'/'+name+'/'+version+'/'+name+'.podspec.json';await writeFile(specFile,await responseBytes(await options.fetcher(url,{signal:options.signal,redirect:'error'}),2*1024**2,options.signal),{flag:'wx'});}
    const spec=await verifyPodSpec(specFile,name,version,checksum,options),coordinate=podSourceCoordinate(spec),source=join(payload,'source');
    if(await stat(release)){await inventory(release);await copyPodSource(release,source);}else if(coordinate.ref){const checkout=join(candidate,'checkout');await gitCheckout(coordinate,checkout,options);await copyPodSource(checkout,source);await rm(checkout,{recursive:true});}else{const file=await packageOriginal(coordinate,options);await extractArchive(file,source,{signal:options.signal});}
    if(!await stat(release)&&spec.prepare_command){if(typeof spec.prepare_command!=='string')fail('Pod准备命令不是锁定文本');const foundation=await productFoundation(options.library,async(_,t)=>options.library.installed.get(t.id));await exec(foundation.tools.bash,['-ec',spec.prepare_command],{cwd:source,signal:options.signal,env:{...cleanEnvironment(options.environment),PATH:foundation.path,HOME:options.library.work,COCOAPODS_VERSION:options.library.tools.find(x=>x.id==='cocoapods').version}});}
    if(!await stat(specPath)){await directory(dirname(specPath),true);await copyFile(specFile,specPath,constants.COPYFILE_EXCL);}await verifyPodSpec(specPath,name,version,checksum,options);
    if(!await stat(release))await copyPodSource(source,release);if(JSON.stringify(await inventory(release))!==JSON.stringify(await inventory(source)))fail('Pod任务源码漂移');
   }finally{await rm(candidate,{recursive:true,force:true});}}
  await verifyPodSpec(specPath,name,version,checksum,options);
 }
  const version=options.library.tools.find(x=>x.id==='cocoapods')?.version,file=join(podHome,'cache/Pods/VERSION');await directory(dirname(file),true);if(await stat(file)){await regular(file);if((await readFile(file,'utf8')).trim()!==version)fail('Pod缓存工具版本漂移');}else await writeFile(file,version,{flag:'wx'});
 checkCocoaPodsResources(lockfile,podHome);return {restored};
}
async function platformTreeDigest(directory){const digest=createHash('sha256');async function visit(path=''){for(const name of (await readdir(join(directory,path))).sort()){if(name==='.DS_Store')continue;const relative=join(path,name),file=join(directory,relative),s=await lstat(file);if(s.isDirectory())await visit(relative);else{await regular(file);digest.update(JSON.stringify([relative,s.size])+'\n');digest.update(await readFile(file));}}}await visit();return digest.digest('hex');}
async function acquireOfficialPlatform(item,options){
 // 固定官方发行树先有界下载，再以产品登记的整树摘要验真；候选归入同一取消清理范围。
 if(options.offline)fail('离线缺少额外Android发行件');const data=await responseBytes(await options.fetcher(checkedURL(item.source),{signal:options.signal,redirect:'error'}),512*1024**2,options.signal);const file=join(options.library.work,'.platform-'+randomUUID()+'.zip');await writeFile(file,data,{flag:'wx'});return file;
}
async function installAndroidResources(options){const library=options.library,cmake=library.tools.find(x=>x.id==='cmake'),packages=androidDefinitions.map(x=>x.tool?{path:'cmake;'+cmake.version,version:cmake.version,...cmake.archives.macos}:x),wanted=library.requested.flatMap(x=>x.packages||[]);for(const item of wanted){const match=library.androidPlatforms?.find(x=>x.path===item.path&&x.version===item.version);if(!match)fail('SDK平台没有产品准确登记');if(!packages.some(x=>x.path===match.path))packages.push(match);}
 const sha256=hash(JSON.stringify(packages)),store=join(library.root,'shared');await directory(store,true);const target=join(store,'android-'+sha256);const verify=async directory=>{if(!await stat(directory))return null;await directoryCheck(directory);const payload=join(directory,'payload'),receipt=JSON.parse(await readFile(join(directory,'receipt.json'),'utf8'));if(receipt.sha256!==sha256||JSON.stringify(receipt.files)!==JSON.stringify(await inventory(payload)))fail('SDK原件回执不符');for(const item of packages){const text=await readFile(join(payload,...item.path.split(';'),'source.properties'),'utf8');if([...text.matchAll(/^Pkg\.Revision\s*=\s*(\S+)\s*$/gmu)].length!==1||!text.includes('Pkg.Revision='+item.version)&&!new RegExp('^Pkg\\.Revision\\s*=\\s*'+item.version.replaceAll('.','\\.')+'\\s*$','mu').test(text))fail('SDK组件版本不符：'+item.path);}return payload;};
 let payload=await verify(target);if(!payload){if(options.offline)fail('离线缺少SDK闭包');const pending=await fixedScratch(join(await resourceWork(options.library.work),'.android-'));try{payload=join(pending,'payload');await mkdir(payload);for(const item of packages){const at=join(payload,...item.path.split(';'));await directory(dirname(at),true);if(item.source){const file=await acquireOfficialPlatform(item,options),unpacked=join(pending,'unpack');try{await extractArchive(file,unpacked,{signal:options.signal});const names=await readdir(unpacked);if(names.length!==1)fail('额外平台归档根不唯一');await rename(join(unpacked,names[0]),at);await rm(unpacked,{recursive:true});if(await platformTreeDigest(at)!==item.sha256)fail('额外平台发行件树摘要不符');}finally{await rm(file,{force:true});}}else{const file=await packageOriginal(item,options),unpacked=join(pending,'unpack');await extractArchive(file,unpacked,{signal:options.signal});await rename(item.root==='.'?unpacked:join(unpacked,item.root),at);if(await stat(unpacked))await rm(unpacked,{recursive:true});}}await permissions(payload,false);await writeFile(join(pending,'receipt.json'),JSON.stringify({sha256,files:await inventory(payload)}),{flag:'wx',mode:0o444});await commitCandidate(pending,target,{signal:options.signal,verify});payload=await verify(target);}finally{if(await stat(pending)){await permissions(pending,true);await rm(pending,{recursive:true});}}}
 const versions=id=>library.tools.find(x=>x.id===id)?.version;for(const [id,file]of [['android','platform-tools/adb'],['android-sdk','cmdline-tools/'+versions('android-sdk')+'/bin/sdkmanager'],['android-ndk','ndk/'+versions('android-ndk')+'/ndk-build'],['cmake','cmake/'+versions('cmake')+'/bin/cmake']])if(library.requested.some(x=>x.id===id))library.installed.set(id,{path:join(payload,file),version:versions(id)});
 return {ANDROID_HOME:payload,ANDROID_SDK_ROOT:payload,ANDROID_NDK_HOME:join(payload,'ndk',versions('android-ndk')),ANDROID_USER_HOME:join(library.work,'android-user'),ANDROID_EMULATOR_HOME:join(library.work,'android-user')};
}
async function appleEnvironment(library,options){if(!library.installed.has('xcode'))return {};const mapping={xcodebuild:'XCODEBUILD',codesign:'CODESIGN',security:'SECURITY',xcrun:'XCRUN','xcode-select':'XCODE_SELECT',clang:'CC','clang++':'CXX',swift:'SWIFT',otool:'OTOOL',install_name_tool:'INSTALL_NAME_TOOL',lipo:'LIPO',make:'MAKE',ar:'AR',ranlib:'RANLIB',nm:'NM',strip:'STRIP','llvm-nm':'LLVM_NM'};const apple=await verifyAppleTools(library,{names:Object.keys(mapping),signal:options.signal,environment:cleanEnvironment(options.environment)}),environment={DEVELOPER_DIR:apple.developerDirectory};const bin=join(library.work,'apple-tools');await directory(bin,true);for(const [name,key]of Object.entries(mapping)){environment[key]=apple.tools[name];const target=join(bin,name);if(await stat(target)){if(!((await lstat(target)).isSymbolicLink())||await realpath(target)!==await realpath(apple.tools[name]))fail('Apple任务入口漂移');}else await symlink(apple.tools[name],target);}environment.PATH=bin;environment.LD=apple.tools.clang;environment.LDCXX=apple.tools['clang++'];environment.CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=apple.tools.clang;const sdk=(await exec(apple.tools.xcrun,['--sdk','macosx','--show-sdk-path'],{signal:options.signal,env:{PATH:'',DEVELOPER_DIR:apple.developerDirectory},timeout:60000})).stdout.trim();environment.SDKROOT=await realpath(sdk);if(!inside(apple.developerDirectory,environment.SDKROOT))fail('SDK越出Xcode');return environment;}
// 可选供给遵循唯一原件协议，产品独立解析本仓锁，拒绝旧快照和状态库回退。
async function readDependencySupply(objects) {
 if(!objects||!await stat(objects))return null;await directory(objects);const file=join(dirname(objects),'index.json');await regular(file);
 if((await lstat(file)).size>32*1024**2)fail('可选原件索引超限');const value=JSON.parse(await readFile(file,'utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['git_sources','packages','pods','schema_version'])||value.schema_version!==2||!Array.isArray(value.packages)||!Array.isArray(value.git_sources)||!Array.isArray(value.pods))fail('可选原件索引协议无效');return value;
}
async function supplyObject(objects,sha256,signal){signal?.throwIfAborted();if(!/^[a-f0-9]{64}$/u.test(sha256||''))fail('供给原件摘要无效');const file=join(objects,sha256+'.blob');await regular(file);const data=await readFile(file);if(hash(data)!==sha256)fail('供给原件摘要不符');return data;}
// 只恢复当前Pod坐标，完成所有文件后再核对内部链接，随后仍由产品校验spec及固定来源。
async function materializePodSupply(pod,objects,destination,{signal}={}) {
 signal?.throwIfAborted();if(!pod)return false;const keys=['checksum','files','name','source','spec','version'];if(JSON.stringify(Object.keys(pod).sort())!==JSON.stringify(keys)||!/^[A-Za-z0-9_.+-]+$/u.test(pod.name||'')||!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(pod.version||'')||!/^[a-f0-9]{40}$/u.test(pod.checksum||'')||!Array.isArray(pod.files)||!pod.files.length)fail('Pod供给坐标无效');
 const md5=createHash('md5').update(pod.name).digest('hex'),url='https://cdn.cocoapods.org/Specs/'+md5[0]+'/'+md5[1]+'/'+md5[2]+'/'+pod.name+'/'+pod.version+'/'+pod.name+'.podspec.json';if(JSON.stringify(Object.keys(pod.spec||{}).sort())!==JSON.stringify(['sha256','url'])||pod.spec.url!==url)fail('Pod spec来源无效');
 const spec=await supplyObject(objects,pod.spec.sha256,signal),value=JSON.parse(spec);if(value.name!==pod.name||value.version!==pod.version||JSON.stringify(value.source)!==JSON.stringify(pod.source))fail('Pod spec与发布坐标漂移');podSourceCoordinate(value);
 const key=pod.version+'-'+pod.checksum.slice(0,5),release=join(destination,'cache/Pods/Release',pod.name,key),specFile=join(destination,'cache/Pods/Specs/Release',pod.name,key+'.podspec.json'),paths=new Set();
 for(const entry of pod.files){if(!safePath(entry.path)||paths.has(entry.path))fail('Pod发布路径无效或重复');paths.add(entry.path);const target=join(release,entry.path);await directory(dirname(target),true);
  if(entry.type==='file'&&JSON.stringify(Object.keys(entry).sort())===JSON.stringify(['executable','path','sha256','type'])&&typeof entry.executable==='boolean'){const bytes=await supplyObject(objects,entry.sha256,signal);if(await stat(target)){await regular(target);if(hash(await readFile(target))!==entry.sha256)fail('Pod任务缓存漂移');}else await writeFile(target,bytes,{flag:'wx'});await chmod(target,entry.executable?0o755:0o644);}
  else if(!(entry.type==='link'&&JSON.stringify(Object.keys(entry).sort())===JSON.stringify(['path','target','type'])&&typeof entry.target==='string'&&entry.target&&!entry.target.startsWith('/')&&!entry.target.includes('\\')&&safePath(posix.normalize(posix.join(posix.dirname(entry.path),entry.target)))))fail('Pod发布条目或链接无效');
 }
 for(const entry of pod.files.filter(x=>x.type==='link')){signal?.throwIfAborted();const target=join(release,entry.path);if(await stat(target)){if(!(await lstat(target)).isSymbolicLink()||await readlink(target)!==entry.target)fail('Pod链接漂移');}else await symlink(entry.target,target);}
 const tree=await inventory(release),nodes=tree.filter(x=>!x.directory);if(nodes.length!==paths.size||nodes.some(x=>!paths.has(x.path))||tree.some(x=>x.directory&&![...paths].some(path=>path.startsWith(x.path+'/'))))fail('Pod发布树混入状态或未登记项');for(const entry of pod.files.filter(x=>x.type==='link')){const target=await realpath(join(release,entry.path));if(!inside(release,target))fail('Pod内部链接越界');}
 await directory(dirname(specFile),true);if(await stat(specFile)){await regular(specFile);if(hash(await readFile(specFile))!==pod.spec.sha256)fail('Pod任务spec漂移');}else await writeFile(specFile,spec,{flag:'wx'});return true;
}
// Maven只接纳登记中的具体上游文件；URL同时确定后缀、分类器及下载文件名。
function mavenOriginal(entry){
 if(entry.ecosystem!=='maven'||JSON.stringify(Object.keys(entry).sort())!==JSON.stringify(['archives','ecosystem','name','version'])||!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(entry.version||'')||/^(?:LATEST|RELEASE)$/u.test(entry.version)||entry.version.endsWith('-SNAPSHOT')||entry.archives?.length!==1)fail('Maven登记坐标无效');
 const [group,artifact,...extra]=entry.name.split(':');if(extra.length||!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(group||'')||!/^[A-Za-z0-9_.-]+$/u.test(artifact||''))fail('Maven登记名称无效');
 const archive=entry.archives[0];if(JSON.stringify(Object.keys(archive).sort())!==JSON.stringify(['integrity','sha256','url']))fail('Maven原件字段无效');const url=new URL(checkedURL(archive.url)),bases={'repo.maven.apache.org':'/maven2/','dl.google.com':'/dl/android/maven2/','plugins.gradle.org':'/m2/','storage.googleapis.com':'/download.flutter.io/','jitpack.io':'/'},base=bases[url.hostname],prefix=base+group.replaceAll('.','/')+'/'+artifact+'/'+entry.version+'/',leaf=url.pathname.slice(prefix.length),filename=artifact+'-'+entry.version;
 if(!base||url.href!==archive.url||url.search||url.hash||url.port||!url.pathname.startsWith(prefix)||!leaf.startsWith(filename+'.')&&!leaf.startsWith(filename+'-')||!/^[A-Za-z0-9_.+-]+\.(?:jar|aar|pom|module)$/u.test(leaf)||url.hostname==='jitpack.io'&&(group!=='com.github.davidliu'||artifact!=='audioswitch'||!/^[a-f0-9]{40}$/u.test(entry.version)))fail('Maven登记不是准确上游来源');
 return {archive,source:url.origin+base,path:url.pathname.slice(base.length)};
}
// 只复制不可变原件到本轮独占Maven仓库，按上游分区避免同坐标不同来源相互覆盖。
async function materializeMavenCache(objects,work,{signal}={}) {
 signal?.throwIfAborted();await directory(work);const index=await readDependencySupply(objects);if(!index)return [];const records=index.packages.filter(x=>x.ecosystem==='maven').map(mavenOriginal);if(!records.length)return [];
 const destination=join(work,'dependencies/maven');await directory(dirname(destination),true);const repos=[...new Set(records.map(x=>x.source))].sort().map(source=>({source,directory:join(destination,hash(source))}));
 const verify=async root=>{const paths=new Map();for(const record of records){signal?.throwIfAborted();const path=hash(record.source)+'/'+record.path,prior=paths.get(path);if(prior&&prior!==record.archive.sha256)fail('Maven同源文件内容冲突');paths.set(path,record.archive.sha256);const file=join(root,path);await regular(file);const bytes=await readFile(file);if(hash(bytes)!==record.archive.sha256||verifyBytes(bytes,{integrity:record.archive.integrity})!==record.archive.sha256)fail('Maven任务原件摘要不符');}const tree=await inventory(root),files=tree.filter(x=>!x.directory);if(files.length!==paths.size||files.some(x=>!x.sha256||!paths.has(x.path))||tree.some(x=>x.directory&&![...paths.keys()].some(path=>path.startsWith(x.path+'/'))))fail('Maven任务仓库混入状态或未登记项');};
 if(await stat(destination)){await directory(destination);await verify(destination);return repos;}
 const candidate=await fixedScratch(join(dirname(destination),'.maven-'));try{for(const record of records){signal?.throwIfAborted();const bytes=await supplyObject(objects,record.archive.sha256,signal);verifyBytes(bytes,{integrity:record.archive.integrity});const file=join(candidate,hash(record.source),record.path);await directory(dirname(file),true);if(await stat(file)){await regular(file);if(hash(await readFile(file))!==record.archive.sha256)fail('Maven同源文件冲突');}else await writeFile(file,bytes,{flag:'wx',mode:0o644});}await verify(candidate);signal?.throwIfAborted();await rename(candidate,destination);await verify(destination);return repos;}finally{await rm(candidate,{recursive:true,force:true});}
}
// 供给镜像仅插在产品已声明的同源仓库前，缺件仍按原仓库解析；顺序与版本由产品控制。
function mavenSupplyInit(repositories){
 const quote=value=>"'"+value.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'",data='['+repositories.map(x=>'[source:'+quote(x.source)+', directory:'+quote(x.directory)+']').join(',')+']';
 return `// 本轮产品资源视图，不读取共享Gradle状态。\nimport org.gradle.api.artifacts.repositories.MavenArtifactRepository\ndef supplied = ${data}\ndef attach = { repositories ->\n def seen = [] as Set\n repositories.all { original ->\n  if (original instanceof MavenArtifactRepository && !original.name.startsWith('productOriginal_')) {\n   def source = original.url.toString().replaceAll('/+$', '') + '/'\n   def record = supplied.find { it.source == source }\n   if (record != null && seen.add(original.name)) {\n    def local = repositories.maven { name = 'productOriginal_' + original.name; url = new File(record.directory).toURI(); artifactUrls(original.url); metadataSources { gradleMetadata(); mavenPom(); artifact() } }\n    repositories.remove(local)\n    repositories.add(repositories.indexOf(original), local)\n   }\n  }\n }\n}\ngradle.beforeSettings { settings -> attach(settings.pluginManagement.repositories); attach(settings.dependencyResolutionManagement.repositories) }\ngradle.beforeProject { project -> attach(project.buildscript.repositories); attach(project.repositories) }\n`;
}
// 远程Pod必须同时交付锁定spec与完整源码；本地路径Pod由本轮产品工程产生。
function checkCocoaPodsResources(lockfile,directory) {
 const text=readFileSync(lockfile,'utf8'),local=[...text.matchAll(/^  ([A-Za-z0-9_.+-]+):\n    :path: /gmu)].map(x=>x[1]);const checksums=new Map([...text.matchAll(/^  ([A-Za-z0-9_.+-]+): ([a-f0-9]{40})$/gmu)].map(x=>[x[1],x[2]]));
 for(const match of text.matchAll(/^  - "?([A-Za-z0-9_.+-]+)(?:\/[A-Za-z0-9_.+-]+)* \(([^()\s]+)\)"?/gmu)){const [,name,version]=match;if(local.includes(name))continue;const checksum=checksums.get(name);if(!checksum)fail('远程Pod缺少锁定spec摘要');const key=version+'-'+checksum.slice(0,5),spec=join(directory,'cache/Pods/Specs/Release',name,key+'.podspec.json'),release=join(directory,'cache/Pods/Release',name,key);if(!existsSync(spec)||!existsSync(release))fail('锁定CocoaPods原件尚未完整存在：'+name);}
 return {paths:local.map(name=>({name}))};
}
async function prepareGradleResources(work,options,environment){const gradle=options.library.installed.get('gradle');if(!gradle)return;const home=join(work,'dependencies/gradle');await directory(home,true);environment.GRADLE_USER_HOME=home;
 // Maven视图与初始化脚本仅属于本轮产品，缺少可选供给时按既有产品仓库独立解析。
 const mirrors=await materializeMavenCache(options.optionalDependencies,work,{signal:options.signal});if(mirrors.length){const initDirectory=join(home,'init.d'),initFile=join(initDirectory,'product-originals.gradle'),text=mavenSupplyInit(mirrors);await directory(initDirectory,true);if(await stat(initFile)){await regular(initFile);if(await readFile(initFile,'utf8')!==text)fail('Maven资源初始化漂移');}else await writeFile(initFile,text,{flag:'wx'});}

 const projects=[];async function find(path,depth=0){if(depth>12)return;for(const name of await readdir(path)){if(['dependencies','git-sources','.git','tmp','cache','config','apple-tools','resource-tools'].includes(name))continue;const file=join(path,name),s=await lstat(file);if(s.isDirectory())await find(file,depth+1);else if(name==='settings.gradle'||name==='settings.gradle.kts')projects.push(dirname(file));}}await find(work);
 for(const project of projects.filter(x=>x.endsWith('/android'))){const flutter=options.library.installed.get('flutter');if(flutter&&!await stat(join(dirname(project),'flutter-gradle')))await flutterRecipe.prepareFlutterTaskTools(dirname(dirname(flutter.path)),dirname(project),'android',{signal:options.signal,environment:{...environment,JAVA_HOME:dirname(dirname(options.library.installed.get('java').path)),GRADLE_HOME:dirname(dirname(gradle.path)),PRODUCT_BASH_BIN:options.library.installed.get('bash').path}});
  const init=join(work,'gradle-resource-init.gradle');if(!await stat(init))await writeFile(init,'// 仅解析产品现有配置，不编译、不扩展版本。\nallprojects { p -> p.tasks.register("productResolveResources") { doLast { p.configurations.findAll { it.canBeResolved }.each { it.resolve() } } } }\n');
  await exec(gradle.path,['--no-daemon','--console=plain','--init-script',init,...(options.offline?['--offline']:[]),'productResolveResources'],{cwd:project,signal:options.signal,timeout:1800000,maxBuffer:8*1024**2,env:{...cleanEnvironment(options.environment),...environment,JAVA_HOME:dirname(dirname(options.library.installed.get('java').path)),PATH:(await productFoundation(options.library,async(_,t)=>options.library.installed.get(t.id))).path}});
 }
}
const buildSourceTool=sourceRecipe.buildSourceTool;
const posixNames=posixRecipe.posixNames;

async function bootstrapNode(work,options={}) {
 checkWork(work);const environment=options.environment||process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64')fail('本机入口仅支持声明的macOS ARM宿主');
 const store=options.storeRoot||join(homedir(),'.local/share/product-resources');
 if(inside(root,store)||inside(store,root)||inside(work,store)||inside(store,work)||store===work)fail('启动原件库边界交叉');
 const library={root:join(store,'tools'),work,tools:toolDefinitions,installed:new Map()};await directory(library.root,true);
 const context={environment,offline:false,fetcher:fetch,...options,library,optionalTools:environment.PRODUCT_TOOL_ROOT,
  optionalDependencies:environment.PRODUCT_DEPENDENCY_ROOT?join(environment.PRODUCT_DEPENDENCY_ROOT,'objects'):undefined};
 return installTool(library,toolDefinitions.find(x=>x.id==='node'),context);
}

async function resources(platform,work,previous={},options={}){
 if(options.supply){const receipt=await options.supply(previous);if(receipt?.run_id!==previous.run_id)fail('资源供给任务身份不符');resourceEnvironment(platform,work,receipt,options.environment||{});return receipt;}
 return materializeResources(platform,work,previous,options);
}
async function prepareResourceSupply(platform,work,previous,options){
 if(!options||typeof options.acquireOriginal!=='function'||!options.toolRoot||!options.dependencyRoot)fail('供给准备缺少公开能力');
 const receipt=await resourceSupplies.run({...options,work},()=>materializeResources(platform,work,previous,options));
 receipt.environment??={};receipt.environment["CITIZENSDK_RESOURCE_MODE"]='provided';return receipt;
}
async function materializeResources(platform,work,previous={},options={}){
 checkWork(work);const request=()=>requirements(platform,work);const requirement=request(),environment=options.environment||process.env;
 if(previous.schema!==undefined&&(previous.schema!==1||previous.product_id!==requirement.product_id||previous.platform!==platform||previous.work!==work))fail('资源请求身份无效');options={environment,fetcher:fetch,offline:false,...options};options.signal?.throwIfAborted();
 const store=options.storeRoot||join(homedir(),'.local/share/product-resources'),optionalTools=options.toolRoot||environment.PRODUCT_TOOL_ROOT,optionalDependencies=options.dependencyRoot?join(options.dependencyRoot,'objects'):environment.PRODUCT_DEPENDENCY_ROOT?join(environment.PRODUCT_DEPENDENCY_ROOT,'objects'):undefined;
 await directory(store,true);if(inside(root,store)||inside(store,root)||inside(work,store)||inside(store,work)||store===work)fail('原件库与源码或工作区交叉');
 // tools承载工具发行件/编译输入，rely承载产品依赖原件；不把可写任务缓存混入任一原件库。
 const library={root:options.toolRoot||join(store,'tools'),work,tools:toolDefinitions,requested:requirement.tools,installed:new Map(),androidPlatforms:androidPlatformDefinitions};await directory(library.root,true);options={...options,platform,optionalTools,optionalDependencies,library,dependencyRoot:options.dependencyRoot||join(store,'rely'),sources:requirement.sources};
 for(const request of requirement.tools){const definition=toolDefinitions.find(x=>x.id===request.id);if(!definition||definition.version!==request.version)fail('需求与产品自己的工具配方不一致：'+request.id);}
 // Node与其它工具同样按本产品声明准备，只消费实际入口。
 const node=toolDefinitions.find(x=>x.id==='node');if(process.platform!=='darwin'||process.arch!=='arm64')fail('本机资源配方仅支持已声明macOS ARM宿主');await installTool(library,node,options);if(hash(await readFile(process.execPath))!==hash(await readFile(library.installed.get('node').path)))fail('运行Node不是产品声明的官方入口字节');
 const android=requirement.tools.some(x=>['android','android-sdk','android-ndk'].includes(x.id));for(const request of requirement.tools){if(android&&['android','android-sdk','android-ndk','cmake'].includes(request.id))continue;await installTool(library,toolDefinitions.find(x=>x.id===request.id),options);}
 const receipt={schema:1,product_id:requirement.product_id,platform,work,tools:Object.fromEntries(library.installed),dependencies:{},archives:{},environment:{},offline:true};for(const key of ['run_id','program_digest'])if(previous[key]!==undefined)receipt[key]=previous[key];
 for(const id of ['posix','bash','grep','sed'])await installTool(library,toolDefinitions.find(x=>x.id===id),options);receipt.tools=Object.fromEntries(library.installed);const foundation=await productFoundation(library,async(_,t)=>library.installed.get(t.id));receipt.environment=await appleEnvironment(library,options);receipt.environment.PATH=[receipt.environment.PATH,foundation.path,...[...library.installed].filter(([id])=>id!=='posix').map(([,x])=>dirname(x.path))].filter(Boolean).join(':');receipt.environment.PRODUCT_WORK_DIR=work;
 if(android)Object.assign(receipt.environment,await installAndroidResources(options));receipt.tools=Object.fromEntries(library.installed);
 for(const source of requirement.sources)await gitCheckout(source,join(work,'git-sources',source.name),options);
 // 归属扩展由本产品判断：prepare产生的原生源码根也只能在同一work中消费。
 const groups=new Map();for(const lock of requirement.locks){const name=lock.source_package||'own';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(lock);}for(const [name,locks]of groups){const base=name==='own'?root:owner.resourceSourceRoot(name,work);await directory(base);const files=kind=>locks.filter(x=>x.ecosystem===kind).map(x=>{if(!safePath(x.path))fail('锁路径越界');return join(base,x.path);}),target=join(work,'dependencies',name);await directory(target,true);let result={request:JSON.stringify(locks)};
  if(files('npm').length)Object.assign(result,await prepareNpm(files('npm'),target,options));if(files('cargo').length)Object.assign(result,await prepareCargo(files('cargo'),target,options));if(files('pub').length)Object.assign(result,await preparePub(files('pub'),join(target,'pub'),options));for(const file of files('cocoapods'))await preparePods(file,join(work,'dependencies'),options);receipt.dependencies[name]=result;
 }
 for(const item of requirement.archives){if(!safePath(item.group))fail('归档分组无效');const file=await packageOriginal(item,options),directory=join(work,'dependencies/archives',item.group);await directoryCheck(directory).catch(async e=>{if(e.code!=='ENOENT')throw e;await directoryCheck(work);await mkdir(directory,{recursive:true});});const path=join(directory,item.sha256+'.blob');if(!await stat(path))await copyFile(file,path,constants.COPYFILE_EXCL);await regular(path);if(hash(await readFile(path))!==item.sha256)fail('任务归档篡改');(receipt.archives[item.group]??=[]).push({...item,path});}
 const flutter=library.installed.get('flutter');if(flutter){const sdk=dirname(dirname(flutter.path));receipt.environment.DART_EXECUTABLE=join(sdk,'bin/cache/dart-sdk/bin/dart');const os=platform.endsWith('ios')?'ios':platform.endsWith('macos')?'macos':null;if(os&&!await stat(join(work,'flutter-tools'))){const delivery=await flutterRecipe.prepareFlutterTaskTools(sdk,work,os,{signal:options.signal,environment:{PRODUCT_BASH_BIN:library.installed.get('bash').path,PRODUCT_RSYNC_BIN:foundation.tools.rsync}});if(delivery.PATH)receipt.environment.PATH=delivery.PATH+':'+receipt.environment.PATH;}if(os)receipt.environment.PATH=join(work,'flutter-tools')+':'+receipt.environment.PATH;receipt.environment.PRODUCT_RSYNC_BIN=foundation.tools.rsync;receipt.environment.PRODUCT_BASH_BIN=library.installed.get('bash').path;}
 await prepareGradleResources(work,options,receipt.environment);options.signal?.throwIfAborted();if(JSON.stringify(request())!==JSON.stringify(requirement)){if((options.depth||0)>=8)fail('资源递归闭包超限');return materializeResources(platform,work,receipt,{...options,depth:(options.depth||0)+1});}owner.resourceEnvironment(platform,work,receipt,cleanEnvironment(environment));return receipt;
}

// 公开声明与候选配方；供给对象的领取、提交及删除只由调度方实现。
function supplyRequirements(){
 const wanted=toolDefinitions.filter(tool=>tool.id!=='xcode').map(tool=>{const archive=toolArchive(tool);return {...tool,archive,slots:[...new Set([archive?.executable,...(tool.slots||[])].filter(Boolean))]};});
 const xcode=toolDefinitions.find(tool=>tool.id==='xcode');
 return {tools:wanted,apple:{version:xcode.version,source:xcode.source,names:[...new Set([...Object.keys(appleSystemTools),...appleBundleTools])]}};
}
function assertWorkQuiescent(work){for(const pid of supplyGroups.get(work)||[])try{process.kill(-pid,0);fail('资源工具退出未确认');}catch(error){if(error.code!=='ESRCH')throw error;}if(retainedResourcePath(work))fail('资源工具退出未确认');}
async function prepareToolSupply(tool,{original,payload,work,signal,offline,acquireOriginal,acquireTool,acquireApple,publishCandidate,environment,finalPayload}){
 const at=await fixedScratch(join(work,'.tool-recipe-'+tool.id+'-'+randomUUID()));
 const library={root:at,work,tools:toolDefinitions,installed:new Map(),requested:[],androidPlatforms:typeof androidPlatformDefinitions==='undefined'?[]:androidPlatformDefinitions};
 const context={work,toolRoot:at,dependencyRoot:join(work,'dependencies'),acquireOriginal,acquireTool,acquireApple,publishCandidate,preparingTool:true};
 try{return await resourceSupplies.run(context,async()=>{
  const definition=toolDefinitions.find(entry=>entry.id===tool.id);if(!definition)fail('工具配方未声明');
  const ids=[...(definition.requires||[]),...(!['node','posix'].includes(tool.id)?['posix',...(['bash','grep','sed'].includes(tool.id)?[]:['bash','grep','sed'])]:[])];
  for(const id of new Set(ids)){if(id==='xcode'){const apple=await acquireApple({...supplyRequirements().apple,names:['xcodebuild']});library.installed.set(id,{path:apple.tools.xcodebuild,version:toolDefinitions.find(t=>t.id===id).version});}else{const entry=supplyRequirements().tools.find(t=>t.id===id);if(!entry)fail('工具前置未声明');library.installed.set(id,await acquireTool(entry));}}
  const value=await installTool(library,definition,{library,signal,offline,environment,finalPayload,dependencyRoot:context.dependencyRoot});
  const executable=toolArchive(definition).executable,built=value.path.slice(0,-executable.length-1);await chmod(built,0o700);await rm(payload,{recursive:true,force:true});await rename(built,payload);
  return {schema:1,id:tool.id,version:tool.version,payload,original};
 });}finally{assertWorkQuiescent(work);await rm(at,{recursive:true,force:true});}
}

// 原生依赖准备实现与资源交付共用唯一模块。
const nativeDependencies = await (async()=>{

// CitizenSDK原生依赖准备入口。依赖坐标只来自同目录锁文件；普通开发、CI和
// 任意可选调用程序都只能选择工作目录，不能改写版本、来源、摘要或构建选项。
const { createHash } = await import('node:crypto');
const { spawnSync } = await import('node:child_process');
const {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = await import('node:fs');
const { homedir, platform: hostPlatform } = await import('node:os');
const { dirname, isAbsolute, join, parse, relative, resolve, sep } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const sdkDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readLock = () => buildDependencyLock;
const lock = new Proxy({}, {get:(_target,key)=>readLock()[key]});
const platforms = new Set(['Android', 'macOS', 'LinuxARM', 'LinuxAMD', 'Windows']);

function fail(message) { throw new Error(`CitizenSDK依赖准备失败：${message}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sha256File(path) { return sha256(readFileSync(path)); }

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith('--') || index + 1 >= values.length) fail(`参数无效：${key}`);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) fail(`参数重复：${key}`);
    result[name] = values[index += 1];
  }
  return result;
}

function developerCache() { return join(sdkDirectory, 'target', 'build', 'dependencies'); }

function safeExternalDirectory(path, label, source = sdkDirectory) {
  const pathRoot = parse(path).root;
  if (!isAbsolute(path) || resolve(path) !== path || path === pathRoot) fail(`${label}必须是规范绝对路径`);
  const normalizedSource = resolve(source), target = join(normalizedSource, 'target');
  if ((path === normalizedSource || path.startsWith(normalizedSource + sep)) && !path.startsWith(target + sep)) fail(`${label}只能在源码树的target内生成`);
  let current = pathRoot;
  for (const part of path.slice(pathRoot.length).split(sep).filter(Boolean)) {
    if (part === '.' || part === '..') fail(`${label}包含非法路径段`);
    current = join(current, part);
    if (!existsSync(current)) break;
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label}祖先不是普通目录：${current}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path) fail(`${label}真实路径发生漂移`);
  return path;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    fail(`${command}执行失败${result.status === null ? '' : `(${result.status})`}${result.stderr ? `：${result.stderr.trim()}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function archiveName(source) {
  const suffix = new URL(source.url).pathname.endsWith('.zip') ? '.zip' : '.tar.gz';
  return `${source.sha256}${suffix}`;
}

async function download(source, destination) {
  const pending = `${destination}.pending-${process.pid}-${Date.now()}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    rmSync(pending, { force: true });
    try {
      const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!response.ok) fail(`下载HTTP状态${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== source.size || sha256(bytes) !== source.sha256) fail('下载字节长度或SHA256不符');
      writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(pending, destination);
      return;
    } catch (error) {
      rmSync(pending, { force: true });
      if (attempt === 3) fail(`${source.url}三次取得均失败：${error.message}`);
    }
  }
}

function validateArchiveEntries(entries, source) {
  const root = `${source.archive_root}/`;
  if (entries.length === 0) fail(`${source.archive_root}归档为空`);
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, '');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\\')
        || normalized.split('/').includes('..')
        || (normalized !== source.archive_root && !normalized.startsWith(root))) {
      fail(`${source.archive_root}归档路径越界：${entry}`);
    }
  }
}

function verifyExtractedTree(root, source) {
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    fail(`${source.archive_root}没有解出唯一普通根目录`);
  }
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        // 官方ZXing的语言包装只链接同包core；准确路径/原始目标/真实目标三者同时校验。
        // 不遍历链接以免重复或循环，不扩大为任意“包内链接”许可。
        const allowed = {
          'wrappers/python/core': '../../core',
          'wrappers/rust/core': '../../core/',
        };
        const key = relative(root, path).split(sep).join('/');
        if (source !== lock.environment['zxing-cpp'] || !Object.hasOwn(allowed, key)
            || readlinkSync(path) !== allowed[key]) {
          fail(`${source.archive_root}包含未许可链接`);
        }
        const core = join(root, 'core');
        if (!existsSync(core) || !lstatSync(core).isDirectory()
            || lstatSync(core).isSymbolicLink()
            || realpathSync(path) !== join(realpathSync(root), 'core')) {
          fail('ZXing链接目标必须是同包普通core目录');
        }
        continue;
      }
      if (!info.isDirectory() && !info.isFile()) fail(`${source.archive_root}包含非普通条目`);
      if (info.isDirectory()) visit(path);
    }
  };
  visit(root);
  if (source.license && sha256File(join(root, source.license)) !== source.license_sha256) {
    fail(`${source.archive_root}许可证摘要不符`);
  }
  if (source.archive_root.startsWith('zxing-cpp-')
      && (!existsSync(join(root, 'CMakeLists.txt')) || !existsSync(join(root, 'core/src/ZXingC.h')))) {
    fail('ZXing-C++源码闭包不完整');
  }
  if (source.archive_root.startsWith('sqlite-') && !existsSync(join(root, 'sqlite3.c'))) fail('SQLite源码闭包不完整');
  if (source.archive_root.startsWith('openssl-') && !existsSync(join(root, 'Configure'))) fail('OpenSSL源码闭包不完整');
  if (source.archive_root.startsWith('tpm2-tss-') && !existsSync(join(root, 'configure'))) fail('TPM2-TSS源码闭包不完整');
}

async function prepareSource(source, work) {
  const archives = safeExternalDirectory(join(work, 'archives'), '依赖归档目录');
  const archive = join(archives, archiveName(source));
  if (existsSync(archive)) {
    const info = lstatSync(archive);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== source.size || sha256File(archive) !== source.sha256) {
      fail(`${source.archive_root}既有归档无效`);
    }
  } else await download(source, archive);

  const destination = join(work, source.archive_root);
  if (existsSync(destination)) {
    verifyExtractedTree(destination, source);
    return destination;
  }
  const staging = join(work, `.extract-${source.sha256}-${process.pid}`);
  if (existsSync(staging)) fail(`${source.archive_root}暂存目录已存在`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const zip = archive.endsWith('.zip');
    const listing = run(zip ? 'unzip' : 'tar', zip ? ['-Z1', archive] : ['-tzf', archive], { capture: true });
    validateArchiveEntries(listing.split(/\r?\n/u).filter(Boolean), source);
    run(zip ? 'unzip' : 'tar', zip ? ['-q', archive, '-d', staging] : ['-xzf', archive, '-C', staging]);
    const extracted = join(staging, source.archive_root);
    verifyExtractedTree(extracted, source);
    renameSync(extracted, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}

function sourceEntriesFor(platform) {
  const result = [['zxing-cpp', lock.environment['zxing-cpp']]];
  if (platform === 'LinuxARM' || platform === 'LinuxAMD') {
    result.push(...Object.entries(lock.native.sources));
  } else if (platform === 'Windows') result.push(['sqlite', lock.native.sources.sqlite]);
  return result;
}

function sourcesFor(platform) {
  return sourceEntriesFor(platform).map(([, source]) => source);
}

// 只把产品锁中的不可变归档坐标投影给可选调用方；计划没有缓存路径、控制程序身份
// 或下载策略，CitizenSDK直接开发、CI和任意第三方构建仍使用同一份锁文件。
function dependencyPlan(args) {
  if (!platforms.has(args.platform)) fail(`平台无效：${args.platform || '<empty>'}`);
  const archives = sourceEntriesFor(args.platform).map(([name, source]) => ({
    name,
    version: source.version,
    url: source.url,
    size: source.size,
    sha256: source.sha256,
    archive_root: source.archive_root,
  })).sort((left, right) => left.name.localeCompare(right.name));
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, archives })}\n`);
}

async function prepareEnvironment(args) {
  if (args.scope && args.scope !== 'citizensdk') fail('scope只接受citizensdk');
  if (!platforms.has(args.platform)) fail(`平台无效：${args.platform || '<empty>'}`);
  const work = safeExternalDirectory(resolve(args.work || developerCache()), '依赖工作目录');
  for (const source of sourcesFor(args.platform)) await prepareSource(source, work);
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, work })}\n`);
}

function freshDirectory(path, label, source) {
  if (existsSync(path)) fail(`${label}已存在，拒绝混入旧产物`);
  return safeExternalDirectory(path, label, source);
}

function copySelectedFiles(source, destination, names) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const input = join(source, name);
    if (!existsSync(input) || !lstatSync(input).isFile() || lstatSync(input).isSymbolicLink()) fail(`缺少依赖文件：${input}`);
    copyFileSync(input, join(destination, name));
  }
}

function executable(name) {
  const path = run(hostPlatform() === 'win32' ? 'where' : 'sh', hostPlatform() === 'win32' ? [name] : ['-c', `command -v "$1"`, 'resolve-tool', name], { capture: true })
    .split(/\r?\n/u)[0];
  const real = realpathSync(path);
  if (!statSync(real).isFile()) fail(`工具不是普通文件：${name}`);
  return real;
}

function buildTools(platform) {
  const names = platform === 'Windows' ? ['cl', 'lib', 'tar'] : ['cc', 'ar', 'perl', 'make', 'sh', 'pkg-config', 'tar', 'unzip'];
  return names.map((name) => {
    const path = executable(name);
    const result = { name, sha256: sha256File(path) };
    if (name === 'cc') result.target = run(path, ['-dumpmachine'], { capture: true });
    return result;
  });
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail(`静态依赖前缀包含符号链接：${path}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && name !== 'native-dependencies.json') {
        files.push({ path: relative(root, path).split(sep).join('/'), sha256: sha256File(path) });
      } else if (!info.isFile()) fail(`静态依赖前缀包含非普通文件：${path}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function buildSqlite(source, build, prefix, windows) {
  const object = join(build, windows ? 'sqlite3.obj' : 'sqlite3.o');
  mkdirSync(join(prefix, 'include'), { recursive: true, mode: 0o700 });
  mkdirSync(join(prefix, 'lib'), { recursive: true, mode: 0o700 });
  copyFileSync(join(source, 'sqlite3.h'), join(prefix, 'include/sqlite3.h'));
  if (windows) {
    run('cl', ['/nologo', '/c', '/O2', '/MD', '/DSQLITE_THREADSAFE=1', join(source, 'sqlite3.c'), `/Fo${object}`]);
    run('lib', ['/nologo', `/OUT:${join(prefix, 'lib/sqlite3.lib')}`, object]);
  } else {
    run('cc', ['-O2', '-fPIC', '-DSQLITE_THREADSAFE=1', '-c', join(source, 'sqlite3.c'), '-o', object]);
    run('ar', ['rcs', join(prefix, 'lib/libsqlite3.a'), object]);
  }
}

function findArchive(root, name) {
  for (const directory of ['lib', 'lib64']) {
    const path = join(root, directory, name);
    if (existsSync(path)) return path;
  }
  fail(`依赖构建缺少${name}`);
}

function buildLinuxNative(sources, build, prefix, platform) {
  const contract = lock.native.platforms[platform];
  const sqlite = join(sources, lock.native.sources.sqlite.archive_root);
  const openssl = join(sources, lock.native.sources.openssl.archive_root);
  const tss = join(sources, lock.native.sources['tpm2-tss'].archive_root);
  buildSqlite(sqlite, freshDirectory(join(build, 'sqlite'), 'SQLite构建目录', sdkDirectory), prefix, false);

  const opensslBuild = freshDirectory(join(build, 'openssl'), 'OpenSSL构建目录', sdkDirectory);
  const opensslInstall = freshDirectory(join(build, 'openssl-install'), 'OpenSSL安装目录', sdkDirectory);
  cpSync(openssl, opensslBuild, { recursive: true, errorOnExist: true, force: false });
  run('perl', ['Configure', contract.openssl_target, ...lock.native.openssl_options,
    `--prefix=${opensslInstall}`, `--openssldir=${join(opensslInstall, 'ssl')}`], { cwd: opensslBuild });
  run('make', ['-j2'], { cwd: opensslBuild });
  run('make', ['install_sw'], { cwd: opensslBuild });
  copySelectedFiles(join(opensslInstall, 'include/openssl'), join(prefix, 'include/openssl'), lock.headers.openssl);
  copyFileSync(findArchive(opensslInstall, 'libcrypto.a'), join(prefix, 'lib/libcrypto.a'));

  const tssBuild = freshDirectory(join(build, 'tpm2-tss'), 'TPM2-TSS构建目录', sdkDirectory);
  const tssInstall = freshDirectory(join(build, 'tpm2-tss-install'), 'TPM2-TSS安装目录', sdkDirectory);
  const cryptoLibrary = dirname(findArchive(opensslInstall, 'libcrypto.a'));
  const environment = {
    ...process.env,
    CPPFLAGS: `-I${join(opensslInstall, 'include')}`,
    LDFLAGS: `-L${cryptoLibrary}`,
    PKG_CONFIG_PATH: join(cryptoLibrary, 'pkgconfig'),
  };
  run(join(tss, 'configure'), [`--prefix=${tssInstall}`, ...lock.native.tss2_options], { cwd: tssBuild, env: environment });
  run('make', ['-j2'], { cwd: tssBuild, env: environment });
  run('make', ['install'], { cwd: tssBuild, env: environment });
  copySelectedFiles(join(tssInstall, 'include/tss2'), join(prefix, 'include/tss2'),
    lock.headers.tss2.map((name) => `tss2_${name}.h`));
  for (const name of ['esys', 'mu', 'sys', 'rc', 'tcti-device']) {
    copyFileSync(findArchive(tssInstall, `libtss2-${name}.a`), join(prefix, `lib/libtss2-${name}.a`));
  }
}

function sourceSha(args, sdk) {
  const supplied = args['source-sha'];
  if (supplied) return supplied;
  return run('git', ['-C', sdk, 'rev-parse', 'HEAD'], { capture: true });
}

async function prepareNative(args) {
  if (args.scope && args.scope !== 'citizensdk') fail('scope只接受citizensdk');
  if (!['LinuxARM', 'LinuxAMD', 'Windows'].includes(args.platform)) fail('prepare-native只支持LinuxARM、LinuxAMD或Windows');
  if (!['ci', 'release'].includes(args.mode)) fail('mode只接受ci或release');
  const sdk = resolve(args.sdk || sdkDirectory);
  if (!existsSync(join(sdk, 'pubspec.yaml'))) fail('CitizenSDK源码目录无效');
  const work = safeExternalDirectory(resolve(args.work || developerCache()), '原生依赖工作目录', sdk);
  const sources = safeExternalDirectory(resolve(args.sources || join(work, 'sources')), '原生依赖源码目录', sdk);
  for (const source of sourcesFor(args.platform)) await prepareSource(source, sources);
  const build = freshDirectory(join(work, 'build'), '原生依赖构建根', sdk);
  const prefix = freshDirectory(join(work, 'prefix'), '原生依赖前缀', sdk);
  if (args.platform === 'Windows') {
    buildSqlite(join(sources, lock.native.sources.sqlite.archive_root), build, prefix, true);
  } else buildLinuxNative(sources, build, prefix, args.platform);

  const version = /^version: (\d+\.\d+\.\d+)$/mu.exec(readFileSync(join(sdk, 'pubspec.yaml'), 'utf8'))?.[1];
  if (!version || (args['software-version'] && args['software-version'] !== version)) fail('SDK软件版本与源码不一致');
  const commit = sourceSha(args, sdk);
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail('源码提交必须是40位小写Git SHA');
  const receipt = {
    schema: 1,
    platform: args.platform,
    source_sha: commit,
    software_version: version,
    build_mode: args.mode,
    native_dependencies: lock.native,
    build_tools: buildTools(args.platform),
    files: collectFiles(prefix),
  };
  const receiptPath = join(prefix, 'native-dependencies.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  assertCitizenSdkDependencyInputs(receiptPath,args.platform);
  process.stdout.write(`${JSON.stringify({ schema: 1, platform: args.platform, prefix, receipt: receiptPath })}\n`);
}


return {prepareEnvironment,prepareNative,run:async(values)=>{
const [command, ...rest] = values;
const args = parseArguments(rest);
try {
  if (command === 'plan') dependencyPlan(args);
  else if (command === 'prepare-environment') await prepareEnvironment(args);
  else if (command === 'prepare-native') await prepareNative(args);
  else fail('用法：build.mjs <plan|prepare-environment|prepare-native> [--name value ...]');
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
}

}};
})();
const runDependencyCLI = values => nativeDependencies.run(values);



// 使用真实本轮目录验证解析器取得、复用及失败清场，不触碰共享工具库。
if(process.env.NODE_TEST_CONTEXT&&process.argv.length===2&&process.argv[1]===import.meta.filename){
 const {test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
 const {mkdtemp,mkdir,writeFile,readdir,rm,lstat}=await import('node:fs/promises');
 const {gzipSync}=await import('node:zlib');
 const tar=entries=>{const blocks=[];for(const [name,body]of entries){const bytes=Buffer.from(body),header=Buffer.alloc(512);header.write(name,0,100);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);header.write('00',263);header.write([...header].reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')+'\0 ',148);blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));}return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));};
 test('解析器仅在本任务目录物化并复用，离线缺件失败',async t=>{
  await mkdir(fixedWork('test'),{recursive:true});const work=await mkdtemp(join(fixedWork('test'),'parser-task-'));t.after(()=>rm(work,{recursive:true,force:true}));
  const library={root:join(work,'library'),work,installed:new Map()};await mkdir(library.root);
  const input=join(work,'parser.tgz'),broken=join(work,'broken.tgz');
  await writeFile(input,tar([['package/package.json','{"main":"index.js"}'],['package/index.js','module.exports={parse(text){return {text}}};']]));
  await writeFile(broken,tar([['../escape','invalid']]));
  let acquired=0;const supply={toolRoot:library.root,acquireOriginal:async()=>{acquired++;return input;},publishCandidate:()=>assert.fail('解析器不得发布共享目录')};
  const options={library,offline:true};
  assert.deepEqual((await resourceSupplies.run(supply,()=>parser('yaml',options)))('first'),{text:'first'});
  assert.deepEqual((await resourceSupplies.run(supply,()=>parser('yaml',options)))('again'),{text:'again'});
  assert.equal(acquired,1);await assert.rejects(lstat(join(library.root,'parsers')),{code:'ENOENT'});
  const local=join(work,'resource-pending','parsers');assert.equal((await readdir(local)).length,1);await rm(local,{recursive:true});
  await assert.rejects(resourceSupplies.run({...supply,acquireOriginal:async()=>broken},()=>parser('yaml',options)),/越界|非法/);
  assert.deepEqual(await readdir(local),[]);
  await assert.rejects(resourceSupplies.run({...supply,acquireOriginal:async()=>{throw Error('离线缺原件');}},()=>parser('yaml',options)),/离线缺原件/);
 });

 test('锁定Git bundle仅在任务内检出，离线缺原件失败',async t=>{
  const {execFileSync}=await import('node:child_process'),{mkdtemp,mkdir,writeFile,readFile,readdir,rm}=await import('node:fs/promises');
  await mkdir(fixedWork('test'),{recursive:true});const work=await mkdtemp(join(fixedWork('test'),'git-task-'));t.after(()=>rm(work,{recursive:true,force:true}));
  const repository=join(work,'repository'),bundle=join(work,'source.bundle'),git='/usr/bin/git',run=(...args)=>execFileSync(git,args,{encoding:'utf8'}).trim();
  run('init','--quiet',repository);await writeFile(join(repository,'source.txt'),'locked');run('-C',repository,'add','source.txt');
  run('-C',repository,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture');
  const ref=run('-C',repository,'rev-parse','HEAD');run('-C',repository,'bundle','create',bundle,'HEAD');
  const bytes=await readFile(bundle),digest=hash(bytes),supply=join(work,'supply'),objects=join(supply,'objects');await mkdir(objects,{recursive:true});
  await writeFile(join(objects,digest+'.blob'),bytes);
  const source={url:'https://github.com/example/locked.git',ref},coordinate='git+'+source.url+'?rev='+ref+'#'+ref;
  await writeFile(join(supply,'index.json'),JSON.stringify({schema_version:2,packages:[],git_sources:[{source:coordinate,sha256:digest}],pods:[]}));
  const bin=join(work,'bin');await mkdir(bin);for(const name of posixRecipe.posixNames)await writeFile(join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const tools=toolDefinitions.filter(tool=>['posix','bash','grep','sed'].includes(tool.id));
  const installed=new Map([['git',{path:git}],...tools.map(tool=>[tool.id,{path:join(bin,tool.id==='posix'?'bash':tool.command)}])]);
  const library={root:join(work,'library'),work,tools,installed};await mkdir(library.root);
  const target=join(work,'checkout'),options={library,optionalDependencies:objects,offline:true,environment:{HOME:work}};
  await gitCheckout(source,target,options);assert.equal(await readFile(join(target,'source.txt'),'utf8'),'locked');
  assert.equal(run('-C',target,'rev-parse','HEAD'),ref);assert.equal(await stat(join(work,'rely/git')),null);
  assert.equal((await readdir(join(work,'resource-pending/git-bundles'))).length,1);
  await rm(target,{recursive:true});await rm(join(work,'resource-pending/git-bundles'),{recursive:true});
  await assert.rejects(gitCheckout(source,target,{...options,optionalDependencies:undefined}),/离线缺少Git提交/);
  assert.equal(await stat(target),null);
 });

 test('Pod spec与源码仅在任务内物化，离线复用与失败清场保持锁定',async t=>{
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
  const {spawnSync}=await import('node:child_process');
  await mkdir(fixedWork('test'),{recursive:true});const work=await mkdtemp(join(fixedWork('test'),'pod-task-'));t.after(()=>rm(work,{recursive:true,force:true}));
  const checksum='a'.repeat(40),sourceBytes=tar([['source.txt','locked-source']]),sourceUrl='https://example.invalid/Example.tgz';
  const spec={name:'Example',version:'1.0.0',source:{http:sourceUrl,sha256:hash(sourceBytes)}};
  const lock={PODS:['Example (1.0.0)'],'SPEC CHECKSUMS':{Example:checksum}};
  const parserArchive=join(work,'parser.tgz'),sourceArchive=join(work,'source.tgz'),lockfile=join(work,'Podfile.lock');
  await writeFile(parserArchive,tar([['package/package.json','{"main":"index.js"}'],['package/index.js','module.exports={parse(){return '+JSON.stringify(lock)+';}};']]));
  await writeFile(sourceArchive,sourceBytes);await writeFile(lockfile,'PODS:\n  - Example (1.0.0)\nSPEC CHECKSUMS:\n  Example: '+checksum+'\n');
  const ruby=join(work,'ruby'),pod=join(work,'cocoapods/bin/pod');await mkdir(dirname(pod),{recursive:true});await mkdir(join(work,'cocoapods/gems'));
  await writeFile(ruby,'#!'+process.execPath+'\nprocess.stdout.write('+JSON.stringify(checksum)+');\n',{mode:0o755});await writeFile(pod,'fixture',{mode:0o755});
  const library={root:join(work,'library'),work,installed:new Map([['ruby',{path:ruby}],['cocoapods',{path:pod}]]),tools:[{id:'cocoapods',version:'1.17.0'}]};await mkdir(library.root);
  let originals=0,requests=0;
  const supply={toolRoot:library.root,acquireOriginal:async entry=>{originals++;return entry.url===parserDefinitions.yaml.url?parserArchive:entry.url===sourceUrl?sourceArchive:assert.fail('未知原件');},publishCandidate:()=>assert.fail('Pod不得提交共享目录'),runCommand:async(command,args,options)=>{assert.equal(command,ruby);const result=spawnSync(command,args,{env:options.env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return {stdout:result.stdout,stderr:result.stderr};}};
  const fetcher=async url=>{requests++;assert.match(url,/^https:\/\/cdn\.cocoapods\.org\/Specs\//u);return Response.json(spec);};
  const podWork=join(work,'pod');await resourceSupplies.run(supply,()=>preparePods(lockfile,podWork,{library,fetcher,environment:{HOME:work}}));
  assert.equal(await readFile(join(podWork,'cocoapods/cache/Pods/Release/Example','1.0.0-'+checksum.slice(0,5),'source.txt'),'utf8'),'locked-source');
  assert.equal(await stat(join(library.root,'parsers')),null);assert.equal(await stat(join(work,'rely/pods')),null);
  await resourceSupplies.run(supply,()=>preparePods(lockfile,podWork,{library,offline:true,environment:{HOME:work},fetcher:()=>assert.fail('离线复用不得联网')}));
  assert.equal(originals,2);assert.equal(requests,1);
  await assert.rejects(resourceSupplies.run(supply,()=>preparePods(lockfile,join(work,'failed'),{library,environment:{HOME:work},fetcher:async()=>new Response(null,{status:503})})),/官方来源响应失败/);
  assert.equal(await stat(join(work,'failed/cocoapods/cache/Pods/Release/Example')),null);
 });
}

return {bootstrapNode,resources,runDependencyCLI,prepareResourceSupply,supplyRequirements,assertWorkQuiescent,prepareToolSupply,prepareEnvironment:nativeDependencies.prepareEnvironment,copyFlutterArtifact:flutterRecipe.copyFlutterArtifact};
})();
const {bootstrapNode,resources,runDependencyCLI,prepareResourceSupply,supplyRequirements,assertWorkQuiescent,prepareToolSupply}=buildResources;
export {prepareResourceSupply,supplyRequirements,assertWorkQuiescent,prepareToolSupply};

const compileProjection=await(async()=>{
const {createHash}=await import('node:crypto');
const {copyFileSync,constants,existsSync,lstatSync,mkdirSync,readFileSync,readlinkSync,realpathSync,readdirSync,rmSync,renameSync,symlinkSync,writeFileSync}=await import('node:fs');
const {dirname,isAbsolute,join,parse,relative,resolve,sep}=await import('node:path');
const ROOT_DIRECTORIES = [
  'android',
  'chain',
  'darwin',
  'include',
  'lib',
  'linux',
  'native',
  'scripts',
  'test',
  'windows',
];
const FORBIDDEN_DIRECTORIES = new Set([
  '.build', '.dart_tool', '.gradle', '.kotlin', '.swiftpm', 'CitizenSDK.xcframework',
  'DerivedData', 'Pods', 'build', 'target', 'xcuserdata',
]);
// Apple 三个 arm64 技术变体作为一个目录原子注入；源码树只保存 Swift/Flutter
// consumer，唯一 native/ffi Core 只存在于这一个 XCFramework 产物中。
function hostHeaderSource(platform,name) {
 return ['citizen_sdk_error.hpp','citizen_sdk_events.hpp','citizen_sdk_models.hpp'].includes(name)?`include/${name}`:`${platform}/headers/${name}`;
}
// 一个产品的两个机器变体：各自完整的 19 项安装前缀合并为 26 项。
// 安装头文件保持公开 include 命名空间，并逐字节对拍扁平源码头文件。
const WINDOWS_HOST_HEADERS = Object.freeze([
  'citizen_sdk.hpp', 'citizen_sdk_config.hpp', 'citizen_sdk_error.hpp',
  'citizen_sdk_events.hpp', 'citizen_sdk_models.hpp',
  'citizensdk_host.h',
]);
const WINDOWS_CMAKE_FILES = Object.freeze([
  'CitizenSDKConfig.cmake', 'CitizenSDKConfigVersion.cmake',
  'CitizenSDKDependencies.cmake', 'CitizenSDKTargets.cmake', 'CitizenSDKTargets-release.cmake',
]);
const WINDOWS_RELEASE_FILES = Object.freeze([
  'include/citizensdk.h', 'include/citizensdk_types.h', 'include/citizensdk_qr_image.h',
  ...WINDOWS_HOST_HEADERS.map((name) => `include/citizen_sdk/${name}`),
  'bin/Windows/citizensdk.dll', 'bin/Windows/citizensdk_host.dll',
  'lib/Windows/citizensdk.dll.lib', 'lib/Windows/citizensdk_host.lib',
  ...WINDOWS_CMAKE_FILES.map((name) => `lib/Windows/cmake/CitizenSDK/${name}`),
  ...['manifest.json', 'chainspec.json', 'light_sync_state.json']
    .map((name) => `share/citizensdk/chain/${name}`),
].sort());
const WINDOWS_INJECTED_FILES = new Set(WINDOWS_RELEASE_FILES);
const HOSTED_WINDOWS_PLUGIN_FILES = Object.freeze([
  'CMakeLists.txt', 'cmake/CitizenSDKFlutter.cmake',
  'headers/citizen_sdk_plugin.h', 'source/citizen_sdk_plugin.cc',
  ...['codec', 'sessions', 'environment'].flatMap(
    (name) => ['cc', 'hpp'].map((extension) => `source/citizen_sdk_flutter_${name}.${extension}`),
  ),
]);
function parentDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      directories.add(parent);
    }
  }
  return [...directories].sort();
}
// LibraryIdentifier 由 xcodebuild 生成，必须视为不透明技术标识。
// 下列合同只依赖 Apple 官方 SupportedPlatform/
// SupportedPlatformVariant 元数据，不使用产品名伪造目录标识。
// macOS framework 必须采用 Apple 标准版本化布局。只有这五个 bundle 内部
// 相对链接属于正式产物；iOS device/Simulator slice、XCFramework 其余位置和
// SDK 源码继续保持零符号链接。固定目标还能同时拒绝绝对路径、`..`、悬空链接
// 和指向 framework 外部的设备文件。
// 每个 Apple slice 必须携带 Swift 编译器生成的完整六文件模块闭包。
// 任何 sidecar 缺失都会破坏同编译器快速导入、ABI 审计或源码信息；允许额外
// 节点又会把未经审查的架构/模块混入单一 arm64 产物，因此这里使用精确集合。
// 两份运行时信任锚必须与 CitizenApp 已验证链资产逐字节一致；manifest 再把
// CitizenSDK 产品、CitizenChain 正式链身份、genesis 和两个摘要固定为一个闭集。
const CHAIN_ASSET_FILES = Object.freeze(Object.fromEntries([
  "chain/chainspec.json",
  "chain/light_sync_state.json",
  "chain/manifest.json"
].map(name=>[name,'file'])));
const CHAIN_ASSET_MANIFEST = Object.freeze({
  format_version: 1,
  product_id: 'citizensdk',
  chain_id: 'citizenchain',
  protocol_id: 'citizenchain',
  genesis_hash: '0x18847a5dfd263272f2e7727836fe6582f8c4463ff48609df7b96d5e4d9dd24dd',
  sdk_min_version: '1.0.0',
});
// 真实 Substrate v14 System.Events metadata 夹具及 CitizenChain Runtime 生产
// metadata/events对为正式解码测试输入，编译视图核对必要普通文件。
const SOURCE_FIXTURE_FILES = Object.freeze({
  "test/transaction/citizenchain-balance-fee-v1.json": "file",
  "test/transaction/citizenchain-revive-v15-metadata.hex": "file",
  "test/transaction/citizenchain-runtime-system-events.hex": "file",
  "test/transaction/citizenchain-runtime-v14-metadata.hex": "file",
  "test/transaction/citizenchain-transfer-build-v1.json": "file",
  "test/transaction/substrate-v14-system-events-metadata.hex": "file",
  "test/wallet/citizenchain-wallet-derivation-v1.json": "file",
  "test/wallet/citizenchain-wallet-password-v1.json": "file"
});
// 编译源码视图核对根级许可入口和两份权威许可证原文。
const LICENSE_SOURCE_FILES = Object.freeze({
  "LICENSE": "file",
  "LICENSE-GPL-3.0": "file",
  "LICENSE-MIT": "file"
});
// 根 include/ 是 CitizenSDK 唯一产品 ABI。两文件完整闭集既固定字节，也阻止
// 上游 smoldot/signer 符号、任意 RPC 和秘密导出接口绕过 citizensdk_* 边界。
const PUBLIC_ABI_FILES = Object.freeze({
  "include/citizensdk.h": "file",
  "include/citizensdk_types.h": "file"
});
// Android Kotlin/Java 源码直接位于各源集根；包名由文件声明而非目录层级决定。
// Dart（排除已有独立来源合同的 smoldot 快照）、Android root/native 与
// Apple darwin 生产输入构成一个反向闭集。平台测试、文档和注入的 AAR/
// XCFramework 分别由测试、文档与候选投影合同固定，不能在本表建立第二条来源。
// Linux C/C++ Host 与 Flutter adapter 都只是根产品 ABI 的宿主投影，不是
// 第二份 Core。测试和 README 分别由测试、文档闭集固定；其余 CMake、公共头
// 与实现逐字节进入独立来源闭集，不能悄然混入另一套协议或生成产物。
const WINDOWS_BINDING_SOURCE_FILES = Object.freeze({
  "windows/source/citizen_sdk_qr_camera.cc": "file",
  "windows/source/citizen_sdk_qr_camera.hpp": "file",
  "windows/cmake/CitizenSDKFlutter.cmake": "file",
  "windows/headers/citizen_sdk_plugin.h": "file",
  "windows/source/citizen_sdk_flutter_codec.cc": "file",
  "windows/source/citizen_sdk_flutter_codec.hpp": "file",
  "windows/source/citizen_sdk_flutter_environment.cc": "file",
  "windows/source/citizen_sdk_flutter_environment.hpp": "file",
  "windows/source/citizen_sdk_flutter_sessions.cc": "file",
  "windows/source/citizen_sdk_flutter_sessions.hpp": "file",
  "windows/source/citizen_sdk_plugin.cc": "file",
  "windows/CMakeLists.txt": "file",
  "windows/cmake/CitizenSDKConfig.cmake.in": "file",
  "windows/cmake/CitizenSDKConfigVersion.cmake.in": "file",
  "windows/cmake/CitizenSDKDependencies.cmake": "file",
  "windows/cmake/citizensdk_host.def": "file",
  "windows/headers/citizen_sdk.hpp": "file",
  "windows/headers/citizen_sdk_config.hpp": "file",
  "windows/headers/citizensdk_host.h": "file",
  "windows/source/citizen_sdk_assets.cc": "file",
  "windows/source/citizen_sdk_assets.hpp": "file",
  "windows/source/citizen_sdk_cng.cc": "file",
  "windows/source/citizen_sdk_cng.hpp": "file",
  "windows/source/citizen_sdk_directory.cc": "file",
  "windows/source/citizen_sdk_directory.hpp": "file",
  "windows/source/citizen_sdk_host_api.cc": "file",
  "windows/source/citizen_sdk_host_bridge.cc": "file",
  "windows/source/citizen_sdk_host_bridge.hpp": "file",
  "windows/source/citizen_sdk_host_record.cc": "file",
  "windows/source/citizen_sdk_host_record.hpp": "file",
  "windows/source/citizen_sdk_input_limits.cc": "file",
  "windows/source/citizen_sdk_input_limits.hpp": "file",
  "windows/source/citizen_sdk_lifecycle.cc": "file",
  "windows/source/citizen_sdk_lifecycle.hpp": "file",
  "windows/source/citizen_sdk_operation.cc": "file",
  "windows/source/citizen_sdk_operation.hpp": "file",
  "windows/source/citizen_sdk_public_store.cc": "file",
  "windows/source/citizen_sdk_public_store.hpp": "file",
  "windows/source/citizen_sdk_record_key.cc": "file",
  "windows/source/citizen_sdk_record_key.hpp": "file",
  "windows/source/citizen_sdk_secret_vault.cc": "file",
  "windows/source/citizen_sdk_secret_vault.hpp": "file",
  "windows/source/citizen_sdk_secure_store.cc": "file",
  "windows/source/citizen_sdk_secure_store.hpp": "file",
  "windows/source/citizen_sdk_sensitive_buffer.cc": "file",
  "windows/source/citizen_sdk_sensitive_buffer.hpp": "file",
  "windows/source/citizen_sdk_sqlite.cc": "file",
  "windows/source/citizen_sdk_sqlite.hpp": "file",
  "windows/source/citizen_sdk_user_auth.cc": "file",
  "windows/source/citizen_sdk_user_auth.hpp": "file",
  "windows/source/citizen_sdk_window.cc": "file",
  "windows/source/citizen_sdk_window.hpp": "file"
});
// 根README只作简明产品介绍；其准确字节随源码和正式包验真，不放行平台技术文档副本。
// 根 Flutter、Core Rust/FFI、smoldot provider、signer、Android、Apple、

// smoldot Dart 包边界已并入唯一 citizen_sdk 根包。三处迁移目录共同构成固定闭集：
// 生产绑定、来源测试与历史审计资料缺一不可，且不允许重新出现第二份 pubspec 包边界。
const SMOLDOT_DART_FILES = Object.freeze(Object.fromEntries([
  "lib/smoldot/bindings.dart",
  "lib/smoldot/chain.dart",
  "lib/smoldot/client.dart",
  "lib/smoldot/json_rpc.dart",
  "lib/smoldot/platform.dart",
  "lib/smoldot/smoldot.dart",
  "lib/smoldot/types.dart",
  "test/smoldot/chain_info_test.dart",
  "test/smoldot/client_basic_test.dart",
  "test/smoldot/ffi_basic_test.dart",
  "test/smoldot/fixtures/polkadot.json",
  "test/smoldot/fixtures/westend.json",
  "test/smoldot/json_rpc_test.dart",
  "test/smoldot/smoldot_test.dart",
  "test/smoldot/subscription_test.dart"
].map(name=>[name,'file'])));
// 两份锁文件属于收编的 smoldot 上游依赖，不是 SDK 自有锁。它们必须保留为
// 普通文件并通过 Cargo 结构、provider 闭包和 registry checksum 校验，但不能用
// SDK 自有源码哈希门禁拒绝上游例外。上游来源身份由受保护清单和 provider parity 合同约束。
// 根 signer workspace 与 Flutter 包的解析闭包同样属于正式来源输入；locked 模式
// 只能保证使用当前锁，必须再固定锁文件自身，才能阻止依赖身份随提交静默漂移。
// Dart 锁按获批中央 Flutter 测试最小闭包解析并验真；不修改 SDK 运行依赖声明或上游实现。
// Cargo.lock 会按 registry package 合并整个根 workspace 的 feature。Engine 为钱包
// 显式启用 BIP-39 NFKD 后，smoldot 闭包里的同一个 bip39 条目会多出这一项依赖；它不是
// PoW 来源依赖漂移。例外必须同时由准确 checksum 和一个本地 workspace owner 的直接依赖
// 证明。HTTPS 建议节点只允许沿固定 reqwest 路径解释额外 feature 依赖，不能放宽上游锁。
// 同一 registry package 也可能因为根 workspace 启用更多 feature 而拥有比 PoW 锁更多的
// 依赖边。这里逐 owner 固定全部、且仅有的额外边；未登记边、PoW 边缺失或解析到不同版本
// 都必须失败，避免“包集合相同但实际依赖图不同”绕过来源闭包证明。
// 上游 smoldot 锁与根 SDK 锁可能为同一 registry 包选择不同的兼容版本；
// 仅允许已审查的 package 名称发生这种版本联合，不能放宽任意依赖边。
// contracts、engine、产品 ffi、QR 协议与 QR 图像窄包装都是 CitizenSDK 自有可编译核心。
// 它们不能借用 smoldot 的来源清单：这里独立固定五个目录的 103 文件完整反向闭集，任何 build.rs、bin、
// 示例或未登记文件都会改变编译/发布语义并因此失败关闭。
const CORE_RUST_FILE_COUNT = 103;
const CORE_RUST_ROOTS = Object.freeze([
  'native/contracts',
  'native/engine',
  'native/ffi',
  'native/qr',
  'native/image',
]);
const CORE_RUST_FILES = Object.freeze({
  "native/engine/tests/baseline_resource_contract.rs": "file",
  "native/engine/source/qr_review_tests.rs": "file",
  "native/engine/source/qr_review.rs": "file",
  "native/engine/source/chain_monitor.rs": "file",
  "native/ffi/source/chain_monitor.rs": "file",
  "native/ffi/source/chain_monitor_tests.rs": "file",
  "native/engine/source/wallet_input.rs": "file",
  "native/engine/source/wallet_input_tests.rs": "file",
  "native/contracts/Cargo.toml": "file",
  "native/contracts/source/account.rs": "file",
  "native/contracts/source/capability.rs": "file",
  "native/contracts/source/chain.rs": "file",
  "native/contracts/source/chain_signer.rs": "file",
  "native/contracts/source/error.rs": "file",
  "native/contracts/source/lib.rs": "file",
  "native/contracts/source/transaction_prepare.rs": "file",
  "native/contracts/source/secret_vault.rs": "file",
  "native/contracts/source/store_chain_database.rs": "file",
  "native/contracts/source/store_encrypted_secret_blob.rs": "file",
  "native/contracts/source/store.rs": "file",
  "native/contracts/source/store_runtime_cache.rs": "file",
  "native/contracts/source/store_transaction_history.rs": "file",
  "native/contracts/source/store_wallet_profile.rs": "file",
  "native/contracts/source/transaction.rs": "file",
  "native/contracts/source/transaction_build.rs": "file",
  "native/contracts/source/wallet.rs": "file",
  "native/contracts/tests/account_contract.rs": "file",
  "native/contracts/tests/capability_contract.rs": "file",
  "native/contracts/tests/chain_contract.rs": "file",
  "native/contracts/tests/secret_contract.rs": "file",
  "native/contracts/tests/state_store_contract.rs": "file",
  "native/contracts/tests/transaction_history_contract.rs": "file",
  "native/contracts/tests/transaction_build_contract.rs": "file",
  "native/contracts/tests/transaction_prepare_contract.rs": "file",
  "native/engine/Cargo.toml": "file",
  "native/engine/source/account_state.rs": "file",
  "native/engine/source/capabilities.rs": "file",
  "native/engine/source/engine.rs": "file",
  "native/engine/source/error.rs": "file",
  "native/engine/source/finalized_history_runtime.rs": "file",
  "native/engine/source/lib.rs": "file",
  "native/engine/source/metadata.rs": "file",
  "native/engine/source/runtime_context.rs": "file",
  "native/engine/source/state_import.rs": "file",
  "native/engine/source/system_events.rs": "file",
  "native/engine/source/transaction_prepare.rs": "file",
  "native/engine/source/transaction_execution.rs": "file",
  "native/engine/source/transaction_history.rs": "file",
  "native/engine/source/transaction_outcome.rs": "file",
  "native/engine/source/wallet_derivation.rs": "file",
  "native/engine/source/wallet_derivation_tests.rs": "file",
  "native/engine/source/wallet_service.rs": "file",
  "native/engine/source/wallet_service_tests.rs": "file",
  "native/engine/tests/account_state.rs": "file",
  "native/engine/tests/capabilities.rs": "file",
  "native/engine/tests/chain_access.rs": "file",
  "native/engine/tests/engine_boundary.rs": "file",
  "native/engine/tests/runtime_context.rs": "file",
  "native/engine/tests/state_import.rs": "file",
  "native/engine/tests/transaction_outcome.rs": "file",
  "native/ffi/Cargo.toml": "file",
  "native/ffi/source/abi.rs": "file",
  "native/ffi/source/assets.rs": "file",
  "native/ffi/source/capabilities.rs": "file",
  "native/ffi/source/composition.rs": "file",
  "native/ffi/source/composition_tests.rs": "file",
  "native/ffi/source/error.rs": "file",
  "native/ffi/source/events.rs": "file",
  "native/ffi/source/handles.rs": "file",
  "native/ffi/source/host_codec.rs": "file",
  "native/ffi/source/host_codec_tests.rs": "file",
  "native/ffi/source/host_providers.rs": "file",
  "native/ffi/source/lib.rs": "file",
  "native/ffi/source/ownership.rs": "file",
  "native/ffi/source/qr_abi.rs": "file",
  "native/ffi/source/requests.rs": "file",
  "native/ffi/source/runtime.rs": "file",
  "native/ffi/source/transaction_abi.rs": "file",
  "native/ffi/source/wallet_abi.rs": "file",
  "native/ffi/source/wallet_abi_tests.rs": "file",
  "native/ffi/tests/abi_layout.rs": "file",
  "native/ffi/tests/asset_boundary.rs": "file",
  "native/ffi/tests/c_header_c11.c": "file",
  "native/ffi/tests/c_header_cpp17.cc": "file",
  "native/ffi/tests/capability_contract.rs": "file",
  "native/ffi/tests/error_contract.rs": "file",
  "native/ffi/tests/event_contract.rs": "file",
  "native/ffi/tests/handle_contract.rs": "file",
  "native/ffi/tests/host_provider_contract.rs": "file",
  "native/ffi/tests/ownership_contract.rs": "file",
  "native/ffi/tests/qr_abi_contract.rs": "file",
  "native/ffi/tests/request_contract.rs": "file",
  "native/ffi/tests/symbol_contract.rs": "file",
  "native/ffi/tests/wallet_abi_contract.rs": "file",
  "native/qr/Cargo.toml": "file",
  "native/contracts/source/signing.rs": "file",
  "native/qr/source/codec.rs": "file",
  "native/qr/source/lib.rs": "file",
  "native/qr/source/session.rs": "file",
  "native/image/CMakeLists.txt": "file",
  "native/image/citizensdk_qr_image.cc": "file",
  "native/image/citizensdk_qr_image.h": "file",
  "native/image/citizensdk_qr_image_test.cc": "file"
});
// native 根只能拥有这些已审核直接条目，防止出现第二个未审查的 Rust 产品边界。
const NATIVE_ROOT_ENTRIES = Object.freeze({
  'contracts': 'directory',
  'engine': 'directory',
  'ffi': 'directory',
  'image': 'directory',
  'legacy': 'directory',
  'provider': 'directory',
  'qr': 'directory',
  'signer': 'directory',
  'smoldot': 'directory',
});
// Core Rust 的 workspace 入口与解析闭包必须与源码闭集
// 组包要求根Cargo声明与锁文件存在；依赖解析使用原锁。
const CORE_RUST_BOUNDARY_FILES = Object.freeze({
  "Cargo.toml": "file",
  "Cargo.lock": "file"
});
// 这些文件位于各来源单元之外，但仍属于编译源码视图输入：许可证、来源记录、
// smoldot 原始 ABI 头文件；已删除的上游示例与链规范不再进入支持文件闭集。
// 原生上游闭集单独核对；迁出的自有单元和兼容头仍由同一来源合同逐项固定；
// Dart 绑定已迁出本原生目录并由 SMOLDOT_DART_FILES 独立固定。
const SMOLDOT_SUPPORT_FILES = Object.freeze(Object.fromEntries([
  "native/smoldot/LICENSE",
  "native/smoldot/LICENSE-APACHE-2.0",
  "native/smoldot/UPSTREAM.md",
  "include/smoldot.h"
].map(name=>[name,'file'])));
// signer 是可编译的 Rust crate，正式输入不能只固定 Cargo.toml 与 lib.rs；
// sr25519 单一实现、ChainSigner 适配和四份合同测试共同进入同一 8 文件闭集；
// 任何 build.rs、src/bin 或其他新增文件
// 都会改变 Cargo 行为，因此一律失败关闭。
const SIGNER_FILES = Object.freeze(Object.fromEntries([
  "native/signer/Cargo.toml",
  "native/signer/source/chain_signer.rs",
  "native/signer/source/lib.rs",
  "native/signer/source/sr25519.rs",
  "native/signer/tests/chain_signer_contract.rs",
  "native/signer/tests/ffi_contract.rs",
  "native/signer/tests/legacy_parity.rs",
  "native/signer/tests/substrate_vectors.rs"
].map(name=>[name,'file'])));

function fail(message) {
  throw new Error(message);
}




/**
 * Freeze the shared Flutter protocol without treating any binding as another
 * binding's source of truth. Named channel constants and the one authoritative
 * method table are parsed from Dart, Android, Darwin, Linux and Windows independently,
 * then matched against the standalone v1 gold list above.
 */
const SHARED_CPP_SOURCE_FILES = Object.freeze({
  "include/citizen_sdk_error.hpp": "file",
  "include/citizen_sdk_events.hpp": "file",
  "include/citizen_sdk_models.hpp": "file"
});


function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prettyStableJson(value) {
  return `${JSON.stringify(JSON.parse(stableJson(value)), null, 2)}\n`;
}

function assertOutsideSource(source, target, label) {
  const sourcePath = resolve(source);
  const resolvedSource = existsSync(sourcePath) ? realpathSync(sourcePath) : sourcePath;
  const sourcePrefix = `${resolvedSource}${sep}`;
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedSource || resolvedTarget.startsWith(sourcePrefix)&&!resolvedTarget.startsWith(join(resolvedSource,'target')+sep)) {
    fail(`${label} 禁止位于 CitizenSDK 源码树：${resolvedTarget}`);
  }
}

function assertSafeTargetPath(path, label) {
  if (typeof path !== 'string' || path.length === 0 || resolve(path) !== path) {
    fail(`${label} 必须使用不含 .、.. 或重复分隔符的绝对规范路径：${path || '<empty>'}`);
  }
  const resolved = resolve(path);
  let current = sep;
  const segments = resolved.split(sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) fail(`${label} 的既存路径祖先禁止使用符号链接：${current}`);
    if (index < segments.length - 1 && !info.isDirectory()) {
      fail(`${label} 的既存路径祖先不是目录：${current}`);
    }
  }
  return resolved;
}

function assertLocalTarget(path, label) {
  const target = assertSafeTargetPath(path, label);
  return target;
}

function ensureNewDirectory(path, source, label) {
  assertSafeTargetPath(path, label);
  assertOutsideSource(source, path, label);
  if (existsSync(path)) fail(`${label} 已存在，拒绝覆盖：${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

// 仓库存放路径只定义一次；编译工程恢复原始模块路径，绝不改写上游源码字节。
const NATIVE_COMPILE_PATHS = Object.freeze({
  "native/smoldot/lib/src/chain/chain_information_build.rs": "native/smoldot/lib/src/chain/chain_information/build.rs",
  "native/smoldot/lib/src/database/finalized_serialize_defs.rs": "native/smoldot/lib/src/database/finalized_serialize/defs.rs",
  "native/smoldot/lib/src/executor/trie_root_calculator_tests.rs": "native/smoldot/lib/src/executor/trie_root_calculator/tests.rs",
  "native/smoldot/lib/src/identity_ss58.rs": "native/smoldot/lib/src/identity/ss58.rs",
  "native/smoldot/lib/src/libp2p/connection/single_stream_handshake_tests.rs": "native/smoldot/lib/src/libp2p/connection/single_stream_handshake/tests.rs",
  "native/smoldot/lib/src/network/kademlia_kbuckets.rs": "native/smoldot/lib/src/network/kademlia/kbuckets.rs",
  "native/smoldot/lib/src/transactions/light_pool_tests.rs": "native/smoldot/lib/src/transactions/light_pool/tests.rs",
  "native/smoldot/lib/src/transactions/pool_tests.rs": "native/smoldot/lib/src/transactions/pool/tests.rs",
  "native/smoldot/lib/src/trie/branch_search_tests.rs": "native/smoldot/lib/src/trie/branch_search/tests.rs",
  "native/smoldot/lib/src/trie/trie_structure_tests.rs": "native/smoldot/lib/src/trie/trie_structure/tests.rs",
  "native/smoldot/light-base/src/json_rpc_service_background.rs": "native/smoldot/light-base/src/json_rpc_service/background.rs",
  "native/smoldot/light-base/src/network_service_tasks.rs": "native/smoldot/light-base/src/network_service/tasks.rs",
  "native/engine/source/transaction_outcome.rs": "native/engine/src/transaction_outcome.rs",
  "native/engine/source/wallet_input_tests.rs": "native/engine/src/wallet_input_tests.rs",
  "native/engine/source/wallet_service_tests.rs": "native/engine/src/wallet_service_tests.rs",
  "native/engine/source/runtime_context.rs": "native/engine/src/runtime_context.rs",
  "native/engine/source/error.rs": "native/engine/src/error.rs",
  "native/engine/source/finalized_history_runtime.rs": "native/engine/src/finalized_history_runtime.rs",
  "native/engine/source/wallet_input.rs": "native/engine/src/wallet_input.rs",
  "native/engine/source/metadata.rs": "native/engine/src/metadata.rs",
  "native/engine/source/chain_monitor.rs": "native/engine/src/chain_monitor.rs",
  "native/engine/source/lib.rs": "native/engine/src/lib.rs",
  "native/engine/source/account_state.rs": "native/engine/src/account_state.rs",
  "native/engine/source/wallet_service.rs": "native/engine/src/wallet_service.rs",
  "native/engine/source/transaction_execution.rs": "native/engine/src/transaction_execution.rs",
  "native/engine/source/transaction_prepare.rs": "native/engine/src/transaction_prepare.rs",
  "native/engine/source/qr_review.rs": "native/engine/src/qr_review.rs",
  "native/engine/source/wallet_derivation.rs": "native/engine/src/wallet_derivation.rs",
  "native/engine/source/transaction_history.rs": "native/engine/src/transaction_history.rs",
  "native/engine/source/system_events.rs": "native/engine/src/system_events.rs",
  "native/engine/source/wallet_derivation_tests.rs": "native/engine/src/wallet_derivation_tests.rs",
  "native/engine/source/qr_review_tests.rs": "native/engine/src/qr_review_tests.rs",
  "native/engine/source/capabilities.rs": "native/engine/src/capabilities.rs",
  "native/engine/source/engine.rs": "native/engine/src/engine.rs",
  "native/engine/source/state_import.rs": "native/engine/src/state_import.rs",
  "native/ffi/source/host_codec_tests.rs": "native/ffi/src/host_codec_tests.rs",
  "native/ffi/source/qr_abi.rs": "native/ffi/src/qr_abi.rs",
  "native/ffi/source/runtime.rs": "native/ffi/src/runtime.rs",
  "native/ffi/source/chain_monitor_tests.rs": "native/ffi/src/chain_monitor_tests.rs",
  "native/ffi/source/transaction_abi.rs": "native/ffi/src/transaction_abi.rs",
  "native/ffi/source/events.rs": "native/ffi/src/events.rs",
  "native/ffi/source/host_codec.rs": "native/ffi/src/host_codec.rs",
  "native/ffi/source/error.rs": "native/ffi/src/error.rs",
  "native/ffi/source/wallet_abi_tests.rs": "native/ffi/src/wallet_abi_tests.rs",
  "native/ffi/source/chain_monitor.rs": "native/ffi/src/chain_monitor.rs",
  "native/ffi/source/wallet_abi.rs": "native/ffi/src/wallet_abi.rs",
  "native/ffi/source/lib.rs": "native/ffi/src/lib.rs",
  "native/ffi/source/host_providers.rs": "native/ffi/src/host_providers.rs",
  "native/ffi/source/ownership.rs": "native/ffi/src/ownership.rs",
  "native/ffi/source/handles.rs": "native/ffi/src/handles.rs",
  "native/ffi/source/composition_tests.rs": "native/ffi/src/composition_tests.rs",
  "native/ffi/source/composition.rs": "native/ffi/src/composition.rs",
  "native/ffi/source/requests.rs": "native/ffi/src/requests.rs",
  "native/ffi/source/assets.rs": "native/ffi/src/assets.rs",
  "native/ffi/source/abi.rs": "native/ffi/src/abi.rs",
  "native/ffi/source/capabilities.rs": "native/ffi/src/capabilities.rs",
  "native/qr/source/session.rs": "native/qr/src/session.rs",
  "native/qr/source/lib.rs": "native/qr/src/lib.rs",
  "native/qr/source/codec.rs": "native/qr/src/codec.rs",
  "native/contracts/source/transaction.rs": "native/contracts/src/transaction.rs",
  "native/contracts/source/chain.rs": "native/contracts/src/chain.rs",
  "native/contracts/source/error.rs": "native/contracts/src/error.rs",
  "native/contracts/source/lib.rs": "native/contracts/src/lib.rs",
  "native/contracts/source/signing.rs": "native/contracts/src/signing.rs",
  "native/contracts/source/wallet.rs": "native/contracts/src/wallet.rs",
  "native/contracts/source/account.rs": "native/contracts/src/account.rs",
  "native/contracts/source/transaction_prepare.rs": "native/contracts/src/transaction_prepare.rs",
  "native/contracts/source/chain_signer.rs": "native/contracts/src/chain_signer.rs",
  "native/contracts/source/secret_vault.rs": "native/contracts/src/secret_vault.rs",
  "native/contracts/source/transaction_build.rs": "native/contracts/src/transaction_build.rs",
  "native/contracts/source/capability.rs": "native/contracts/src/capability.rs",
  "native/contracts/source/store_wallet_profile.rs": "native/contracts/src/store/wallet_profile.rs",
  "native/contracts/source/store_encrypted_secret_blob.rs": "native/contracts/src/store/encrypted_secret_blob.rs",
  "native/contracts/source/store_chain_database.rs": "native/contracts/src/store/chain_database.rs",
  "native/contracts/source/store.rs": "native/contracts/src/store/mod.rs",
  "native/contracts/source/store_runtime_cache.rs": "native/contracts/src/store/runtime_cache.rs",
  "native/contracts/source/store_transaction_history.rs": "native/contracts/src/store/transaction_history.rs",
  "native/legacy/source/error.rs": "native/legacy/src/error.rs",
  "native/legacy/source/lib.rs": "native/legacy/src/lib.rs",
  "native/legacy/source/ffi_types.rs": "native/legacy/src/ffi_types.rs",
  "native/provider/source/client.rs": "native/provider/src/client.rs",
  "native/provider/source/legacy.rs": "native/provider/src/legacy.rs",
  "native/provider/source/account_nonce.rs": "native/provider/src/account_nonce.rs",
  "native/provider/source/lib.rs": "native/provider/src/lib.rs",
  "native/provider/source/bootstrap.rs": "native/provider/src/bootstrap.rs",
  "native/provider/source/bootstrap_tests.rs": "native/provider/src/bootstrap_tests.rs",
  "native/provider/source/verified_chain_client.rs": "native/provider/src/verified_chain_client.rs",
  "native/provider/tests/source_manifest_contract.rs": "native/smoldot/light-base/tests/source_manifest_contract.rs",
  "native/provider/tests/capability_boundary.rs": "native/smoldot/light-base/tests/capability_boundary.rs",
  "native/provider/tests/light_client_boundary.rs": "native/smoldot/lib/tests/light_client_boundary.rs",
  "native/provider/tests/network_sync_source_manifest.rs": "native/smoldot/lib/tests/network_sync_source_manifest.rs",
  "native/provider/tests/state_runtime_source_manifest.rs": "native/smoldot/lib/tests/state_runtime_source_manifest.rs",
  "native/provider/tests/consensus_source_manifest.rs": "native/smoldot/lib/tests/consensus_source_manifest.rs",
  "native/provider/tests/network_sync_boundary.rs": "native/smoldot/lib/tests/network_sync_boundary.rs",
  "native/provider/tests/state_runtime_boundary.rs": "native/smoldot/lib/tests/state_runtime_boundary.rs",
  "native/signer/source/sr25519.rs": "native/signer/src/sr25519.rs",
  "native/signer/source/lib.rs": "native/signer/src/lib.rs",
  "native/signer/source/chain_signer.rs": "native/signer/src/chain_signer.rs"
});

// 中文注释：来源验真复用同一真实模块路径字典，仓库存放路径不冒充上游路径。

/** Cargo唯一源码外输入：普通副本隔离build.rs写入，锁文件、测试夹具与链资源同轮装配。 */
function createNativeSourceView(sourcePath, outputPath) {
  const source = resolve(sourcePath), output = resolve(outputPath);
  const within = (root, path) => {
    const part = relative(root, path);
    return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part));
  };
  const checkPath = (path, label) => {
    if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail(label + '必须是规范绝对路径');
    let current = parse(path).root;
    for (const part of path.slice(current.length).split(sep)) {
      current = join(current, part);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (!info) break;
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current) {
        fail(label + '禁止链接或非目录祖先');
      }
    }
  };
  checkPath(sourcePath, '原生来源'); checkPath(outputPath, '原生工程');
  if (within(output,source)||within(source,output)&&!output.startsWith(join(source,'target')+sep)) fail('原生工程与来源必须分离');
  assertCoreRustSource(source);
  assertSignerSource(source);

  assertSourceFixtures(source);
  const files = ['Cargo.toml', 'Cargo.lock'];
  for (const root of ['native', 'include', 'chain', 'test']) {
    for (const path of regularFiles(join(source, root))) files.push(root + '/' + path);
  }
  const entries = new Map();
  const destinations = new Set();
  for (const path of files.sort()) {
    const input = join(source, path);
    const info = lstatSync(input);
    if (!info.isFile() || info.isSymbolicLink()) fail('原生输入必须是普通文件：' + path);
    const target = NATIVE_COMPILE_PATHS[path] ?? path;
    const key = target.normalize('NFC').toLowerCase();
    if (destinations.has(key)) fail('原生编译路径冲突：' + target);
    destinations.add(key);
    entries.set(target, { data: readFileSync(input), mode: info.mode & 0o777 });
  }
  for (const [stored, compiled] of Object.entries(NATIVE_COMPILE_PATHS)) {
    if (!files.includes(stored) || files.includes(compiled)) fail('原生路径映射来源缺失或重复：' + stored);
  }
  const verify = () => {
    if (JSON.stringify(regularFiles(output)) !== JSON.stringify([...entries.keys()].sort())) {
      fail('原生工程文件闭集漂移');
    }
    for (const [path, { data }] of entries) {
      if (!readFileSync(join(output, path)).equals(data)) fail('原生工程字节漂移：' + path);
    }
  };
  // 同次构建的多个原生阶段只准复用完全一致的工程，禁止覆盖漂移内容或链接。
  if (lstatSync(output, { throwIfNoEntry: false })) { verify(); return output; }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  try {
    for (const [path, { data, mode }] of entries) {
      const target = join(output, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, data, { flag: 'wx', mode });
    }
    verify();
  } catch (error) {
    // 只清理本函数刚创建的独占工程；已有工程验证失败时保持原状。
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return output;
}

// 仓库保留扁平源码；Flutter消费位置由SDK唯一声明，包身份不随物理路径改变。
const FLUTTER_ENTRY_SOURCE = 'android/source/CitizenSdkPlugin.kt';
const FLUTTER_ENTRY_PACKAGE = 'android/src/main/kotlin/org/citizen/sdk/CitizenSdkPlugin.kt';

function flutterPackagePath(path) {
  return path === FLUTTER_ENTRY_SOURCE ? FLUTTER_ENTRY_PACKAGE : path;
}

function flutterEntryBytes(source) {
  const entry = join(source, FLUTTER_ENTRY_SOURCE);
  if (!lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) {
    fail('CitizenSDK Flutter入口来源必须是普通源文件');
  }
  if (lstatExists(join(source, FLUTTER_ENTRY_PACKAGE))) fail('CitizenSDK源码出现重复Flutter入口');
  const lock = join(source, 'pubspec.lock');
  if (!lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink()) fail('CitizenSDK消费来源缺少普通Pub锁文件');
  const bytes = readFileSync(entry);
  const text = bytes.toString('utf8');
  const manifest = readFileSync(join(source, 'pubspec.yaml'), 'utf8');
  if (!/^package org\.citizen\.sdk\r?$/m.test(text)
      || !/\bclass CitizenSdkPlugin\s*:/.test(text)
      || !text.includes('io.flutter.embedding.engine.plugins.FlutterPlugin')
      || !/^name: citizen_sdk\r?$/m.test(manifest)
      || !/      android:\r?\n        package: org\.citizen\.sdk\r?\n        pluginClass: CitizenSdkPlugin\r?\n/.test(manifest)) {
    fail('CitizenSDK Flutter入口身份与pubspec声明不一致');
  }
  return bytes;
}

/** 本轮本地消费视图：源文件只读链接，Pub元数据独立可写；输出根禁止复用。 */
function createFlutterSourceView(sourcePath, outputPath) {
  const source = assertSafeTargetPath(sourcePath, 'Flutter源码');
  const output = assertSafeTargetPath(outputPath, 'Flutter消费视图');
  assertOutsideSource(source, output, 'Flutter消费视图');
  assertOutsideSource(output, source, 'Flutter源码');
  flutterEntryBytes(source);
  const excluded = new Set(['.git', '.dart_tool', '.gradle', '.kotlin', '.pub-cache',
    '.symlinks', 'Pods', 'build', 'target', 'node_modules']);
  const entries = [];
  const collect = (path = '') => {
    for (const name of readdirSync(join(source, path)).sort()) {
      if (excluded.has(name)) continue;
      const relativePath = path ? `${path}/${name}` : name;
      const input = join(source, relativePath);
      const info = lstatSync(input);
      if (info.isSymbolicLink()) fail(`CitizenSDK消费来源禁止链接：${relativePath}`);
      if (info.isDirectory()) collect(relativePath);
      else if (info.isFile()) entries.push(relativePath);
      else fail(`CitizenSDK消费来源类型无效：${relativePath}`);
    }
  };
  // 完整检查来源后才创建输出，避免异常输入留下貌似有效的消费目录。
  collect();
  ensureNewDirectory(output, source, 'Flutter消费视图');
  for (const path of entries) {
    const destination = join(output, flutterPackagePath(path));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (path === 'pubspec.yaml' || path === 'pubspec.lock') {
      copyFileSync(join(source, path), destination, constants.COPYFILE_EXCL);
    } else symlinkSync(join(source, path), destination);
  }
  return output;
}

/** 复用只读视图前核对来源绑定；不接受普通副本或另一源码的入口链接。 */
function assertFlutterSourceView(sourcePath, outputPath) {
  const source = assertSafeTargetPath(sourcePath, 'Flutter源码');
  const output = assertSafeTargetPath(outputPath, 'Flutter消费视图');
  assertOutsideSource(source, output, 'Flutter消费视图');
  assertOutsideSource(output, source, 'Flutter源码');
  const expected = flutterEntryBytes(source);
  const entry = join(output, FLUTTER_ENTRY_PACKAGE);
  // 只准许最后的文件链接；目录骨架必须由当轮视图所有者创建。
  assertSafeTargetPath(dirname(entry), 'Flutter入口父目录');
  if (!lstatSync(entry).isSymbolicLink()
      || realpathSync(entry) !== join(source, FLUTTER_ENTRY_SOURCE)
      || !readFileSync(entry).equals(expected)
      || lstatExists(join(output, FLUTTER_ENTRY_SOURCE))) fail('CitizenSDK消费视图来源绑定无效');
  for (const name of ['pubspec.yaml', 'pubspec.lock']) {
    const metadata = join(output, name);
    if (!lstatSync(metadata).isFile() || lstatSync(metadata).isSymbolicLink()
        || !readFileSync(metadata).equals(readFileSync(join(source, name)))) {
      fail('CitizenSDK消费视图Pub声明或锁文件漂移');
    }
  }
  return output;
}

/** 既有原生消费者的普通文件副本仅重排入口；正式包不能再次调用源码布局转换。 */
function projectFlutterSourceEntry(sourcePath, packagePath) {
  const source = assertSafeTargetPath(sourcePath, 'Flutter入口源码');
  const output = assertSafeTargetPath(packagePath, 'Flutter消费包');
  assertOutsideSource(source, output, 'Flutter消费包');
  assertOutsideSource(output, source, 'Flutter入口源码');
  const original = assertSafeTargetPath(join(output, FLUTTER_ENTRY_SOURCE), '消费入口');
  const destination = assertSafeTargetPath(join(output, FLUTTER_ENTRY_PACKAGE), '消费入口目标');
  const expected = flutterEntryBytes(source);
  if (!lstatSync(original).isFile() || lstatSync(original).isSymbolicLink()
      || !readFileSync(original).equals(expected) || lstatExists(destination)) {
    fail('CitizenSDK消费入口缺失、重复或与源码不一致');
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  renameSync(original, destination);
  if (lstatExists(original) || !readFileSync(destination).equals(expected)) {
    fail('CitizenSDK消费入口投影回读失败');
  }
}

function copySourceTree(source, output, relativePath) {
  const sourcePath = join(source, ...relativePath.split('/'));
  const info = lstatSync(sourcePath);
  if (info.isSymbolicLink()) fail(`SDK 候选禁止符号链接：${relativePath}`);
  if (info.isDirectory()) {
    if (FORBIDDEN_DIRECTORIES.has(relativePath.split('/').at(-1))) {
      fail(`SDK 源码包含编译目录：${relativePath}`);
    }
    mkdirSync(join(output, ...relativePath.split('/')), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(sourcePath).sort()) {
      copySourceTree(source, output, `${relativePath}/${name}`);
    }
    return;
  }
  if (!info.isFile()) fail(`SDK 候选只允许普通文件和目录：${relativePath}`);
  if (/\.(?:a|aar|dylib|dll|exe|o|so)$/i.test(relativePath) || relativePath.endsWith('/exported_symbols.txt')) {
    fail(`SDK 源码树包含原生编译产物：${relativePath}`);
  }
  const destination = join(output, ...flutterPackagePath(relativePath).split('/'));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(sourcePath, destination);
}



// 中央阶段传输验真复用此唯一 Apple 链接合同，避免复制另一份 slice 规则。

/**
 * Enumerate a tree without following links and fail closed on every non-file
 * entry. A caller may admit a complete, exact link contract; every declared
 * link must exist, must keep its literal relative target, and must resolve
 * inside the enumerated root. This is intentionally not a generic
 * "allow symlinks" switch.
 */
function treeEntries(root, allowedSymlinks = Object.freeze({})) {
  const files = [];
  const symlinks = [];
  const seenSymlinks = new Set();
  const treeRoot = resolve(root);
  if (!existsSync(treeRoot) || lstatSync(treeRoot).isSymbolicLink()
      || !lstatSync(treeRoot).isDirectory()) {
    fail(`SDK 候选树根必须是普通目录：${treeRoot}`);
  }
  const realTreeRoot = realpathSync(treeRoot);
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = relative(treeRoot, path).split(sep).join('/');
      if (info.isSymbolicLink()) {
        const expectedTarget = allowedSymlinks[relativePath];
        if (expectedTarget === undefined) {
          fail(`SDK 候选禁止未声明符号链接：${relativePath}`);
        }
        const actualTarget = readlinkSync(path);
        if (actualTarget !== expectedTarget
            || actualTarget.startsWith('/')
            || actualTarget.split('/').includes('..')) {
          fail(`SDK 候选符号链接目标漂移：${relativePath}`);
        }
        let realTarget;
        try {
          realTarget = realpathSync(path);
        } catch (error) {
          if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
            fail(`SDK 候选符号链接悬空或成环：${relativePath}`);
          }
          throw error;
        }
        if (realTarget !== realTreeRoot && !realTarget.startsWith(`${realTreeRoot}${sep}`)) {
          fail(`SDK 候选符号链接越出受控根：${relativePath}`);
        }
        symlinks.push(relativePath);
        seenSymlinks.add(relativePath);
        continue;
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(relativePath);
      else fail(`SDK 候选只允许普通文件和目录：${relativePath}`);
    }
  };
  visit(treeRoot);
  const expectedSymlinks = Object.keys(allowedSymlinks).sort();
  const actualSymlinks = [...seenSymlinks].sort();
  if (JSON.stringify(actualSymlinks) !== JSON.stringify(expectedSymlinks)) {
    const actual = new Set(actualSymlinks);
    const missing = expectedSymlinks.filter((path) => !actual.has(path));
    fail(`SDK 候选缺少已声明符号链接：${missing.join(',') || '无'}`);
  }
  return { files: files.sort(), symlinks: actualSymlinks };
}

function regularFiles(root) {
  return treeEntries(root).files;
}

// File-only closures cannot detect a newly added empty/generated directory.
// Linux CMake state is especially prone to leaving such paths behind, so the
// platform source contract also closes the directory topology without ever
// following links.
function regularDirectories(root) {
  const treeRoot = resolve(root);
  if (!existsSync(treeRoot) || lstatSync(treeRoot).isSymbolicLink()
      || !lstatSync(treeRoot).isDirectory()) {
    fail(`SDK 候选树根必须是普通目录：${treeRoot}`);
  }
  const directories = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = relative(treeRoot, path).split(sep).join('/');
      if (info.isSymbolicLink()) {
        fail(`SDK 候选禁止未声明符号链接：${relativePath}`);
      }
      if (info.isDirectory()) {
        directories.push(relativePath);
        visit(path);
      } else if (!info.isFile()) {
        fail(`SDK 候选只允许普通文件和目录：${relativePath}`);
      }
    }
  };
  visit(treeRoot);
  return directories.sort();
}


/**
 * 核验本轮smoldot Dart来源与实际输入一致。
 *
 * The check is applied both before copying a source tree and while verifying a
 * finished candidate, so neither an omitted test nor a self-consistent but
 * modified release manifest can hide source drift.
 */









/**
 * Prove offline that every registry package recursively reachable through the
 * product provider's bundled `smoldot-light` edge has the exact
 * name/version/checksum already fixed by the bundled PoW smoldot lock. The only
 * permitted root-only item is an exact, checksum-pinned Cargo feature-union
 * dependency reached from its declared local workspace owner through an exact
 * pinned dependency path (empty means direct). Provider-only dependencies remain
 * pinned by the root-lock byte hash;
 * they are not falsely claimed to originate in the upstream PoW lock. No Cargo
 * invocation or network fallback is allowed here.
 */

/**
 * Verify the complete CitizenSDK-owned Rust core and its workspace boundary.
 *
 * This contract deliberately does not share smoldot's imported-source manifest:
 * contracts/engine/ffi are maintained by CitizenSDK and therefore have their own
 * reverse-enumerated closure. The native root is also closed so a new crate
 * cannot enter a release merely because ROOT_DIRECTORIES recursively copies it.
 */
function assertCoreRustSource(root) {
  const sourceRoot = resolve(root);
  const manifest = readFileSync(join(sourceRoot, 'Cargo.toml'), 'utf8');
  for (const field of ['repository', 'homepage']) {
    const declarations = manifest.match(new RegExp(`^${field}\\s*=.*$`, 'gm')) ?? [];
    if (declarations.length !== 1 || declarations[0] !== `${field} = "https://github.com/crcfrcn/citizensdk"`) {
      fail(`CitizenSDK Rust ${field} 必须为现行唯一仓库`);
    }
  }
  if (Object.keys(CORE_RUST_FILES).length !== CORE_RUST_FILE_COUNT) {
    fail(`CitizenSDK Core Rust 固定清单必须精确为 ${CORE_RUST_FILE_COUNT} 文件`);
  }
  const nativeRoot = join(sourceRoot, 'native');
  if (!existsSync(nativeRoot)
      || lstatSync(nativeRoot).isSymbolicLink()
      || !lstatSync(nativeRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通 native 根目录');
  }

  const actualNativeEntries = readdirSync(nativeRoot).sort();
  const expectedNativeEntries = Object.keys(NATIVE_ROOT_ENTRIES).sort();
  if (JSON.stringify(actualNativeEntries) !== JSON.stringify(expectedNativeEntries)) {
    const actual = new Set(actualNativeEntries);
    const expected = new Set(expectedNativeEntries);
    const missing = expectedNativeEntries.filter((path) => !actual.has(path));
    const extra = actualNativeEntries.filter((path) => !expected.has(path));
    fail(`CitizenSDK native 根闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const [name, expectedType] of Object.entries(NATIVE_ROOT_ENTRIES)) {
    const path = join(nativeRoot, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()
        || (expectedType === 'file' ? !info.isFile() : !info.isDirectory())) {
      fail(`CitizenSDK native 根条目类型漂移：${name}`);
    }
  }

  for (const relativeRoot of CORE_RUST_ROOTS) {
    const coreRoot = join(sourceRoot, ...relativeRoot.split('/'));
    if (!existsSync(coreRoot)
        || lstatSync(coreRoot).isSymbolicLink()
        || !lstatSync(coreRoot).isDirectory()) {
      fail(`CitizenSDK 缺少普通 Core Rust 来源目录：${relativeRoot}`);
    }
    const actualPaths = regularFiles(coreRoot)
      .map((path) => `${relativeRoot}/${path}`)
      .sort();
    const expectedPaths = Object.keys(CORE_RUST_FILES)
      .filter((path) => path.startsWith(`${relativeRoot}/`))
      .sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      const actual = new Set(actualPaths);
      const expected = new Set(expectedPaths);
      const missing = expectedPaths.filter((path) => !actual.has(path));
      const extra = actualPaths.filter((path) => !expected.has(path));
      fail(`CitizenSDK Core Rust 文件闭集漂移：${relativeRoot}；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
    }
  }
  assertDeclaredFiles(sourceRoot, CORE_RUST_FILES, 'Core Rust 来源');
  assertDeclaredFiles(sourceRoot, CORE_RUST_BOUNDARY_FILES, 'Core Rust 边界');
}

function assertDeclaredFiles(root, files, label) {
  const sourceRoot = resolve(root);
  for (const relativePath of Object.keys(files)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 缺少普通${label}文件：${relativePath}`);
    }
    if (lstatSync(path).size === 0) fail(`CitizenSDK ${label}文件为空：${relativePath}`);
  }
}

function stripCComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ');
}

/** Verify the root C/C++ header closure and its product-only safety boundary. */
function assertPublicAbiHeaders(root) {
  const sourceRoot = resolve(root);
  const includeRoot = join(sourceRoot, 'include');
  if (!existsSync(includeRoot)
      || lstatSync(includeRoot).isSymbolicLink()
      || !lstatSync(includeRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通根 include 目录');
  }
  const actualPaths = readdirSync(includeRoot).map((path) => `include/${path}`).sort();
  const expectedPaths = [...Object.keys(PUBLIC_ABI_FILES),...Object.keys(SHARED_CPP_SOURCE_FILES),'include/smoldot.h'].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 根 include 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  for (const relativePath of expectedPaths) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      fail(`CitizenSDK 根 include 条目必须是普通文件：${relativePath}`);
    }
  }

  const headers = Object.keys(PUBLIC_ABI_FILES)
    .filter((path) => path.endsWith('.h'))
    .map((path) => readFileSync(join(sourceRoot, ...path.split('/')), 'utf8'))
    .join('\n');
  const publicSource = stripCComments(headers);
  const forbiddenSymbol = publicSource.match(
    /\b(?:smoldot|citizen_sr25519|account_crypto)_[A-Za-z0-9_]*\b/,
  );
  if (forbiddenSymbol) {
    fail(`CitizenSDK 公共 ABI 泄漏非产品符号：${forbiddenSymbol[0]}`);
  }

  const withoutDirectives = publicSource.replace(/^[ \t]*#.*$/gm, ' ');
  const apparentFunctions = [
    ...withoutDirectives.matchAll(
      /^[ \t]*(?!typedef\b)((?:CITIZENSDK_API[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:[ \t*]+[A-Za-z_][A-Za-z0-9_]*)*[ \t*\r\n]+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*;)/gm,
    ),
  ];
  for (const prototype of apparentFunctions) {
    if (!prototype[1].trimStart().startsWith('CITIZENSDK_API ')) {
      fail(`CitizenSDK 公共 ABI 只允许带导出标记的 citizensdk_* 函数：${prototype[2]}`);
    }
  }

  const declarations = [
    ...publicSource.matchAll(/^[ \t]*CITIZENSDK_API\b([\s\S]*?);/gm),
  ];
  if (declarations.length === 0) fail('CitizenSDK 公共 ABI 没有导出函数');
  for (const declaration of declarations) {
    const normalized = declaration[1].replace(/\s+/g, ' ').trim();
    const functionName = normalized.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
    if (!functionName || !/^citizensdk_[a-z0-9_]+$/.test(functionName)) {
      fail(`CitizenSDK 公共 ABI 只允许 citizensdk_* 函数：${functionName ?? '<unparsed>'}`);
    }
    const hasMethodAndParams = /method/i.test(normalized) && /params/i.test(normalized);
    if (/(?:^|_)rpc(?:_|$)/i.test(functionName) || hasMethodAndParams) {
      fail(`CitizenSDK 公共 ABI 禁止任意 rpc(method, params)：${functionName}`);
    }
    const forbiddenPrivateMaterial = /(?:private_?key|mini_?secret|child_?secret|(?:^|_)seed(?:_|$))/i
      .test(normalized);
    const carriesGenericSecret = /(?:^|_)secret(?:_|\b)/i.test(normalized);
    const carriesMnemonic = /mnemonic/i.test(normalized);
    const mnemonicFunctions = new Set([
      'citizensdk_import_wallet',
      'citizensdk_add_wallet_accounts',
      'citizensdk_prepared_wallet_copy_mnemonic',
      'citizensdk_add_next_wallet_account',
    ]);
    // 敏感边界只允许已登记receiver、资源控制与只读存在性的准确签名；禁止同名新增裸秘密输出。
    const sensitiveFunctions = new Map([
      ['citizensdk_set_secret_presence_provider', 'citizensdk_error_code_t citizensdk_set_secret_presence_provider( citizensdk_handle_t handle, const citizensdk_host_secret_presence_v1_t *provider)'],
      ['citizensdk_encrypted_secret_record_has_secret', 'citizensdk_error_code_t citizensdk_encrypted_secret_record_has_secret( const citizensdk_account_id_t *account_id, uint64_t expected_revision, citizensdk_bytes_view_t record, uint8_t *out_present)'],
      ['citizensdk_private_key_open', 'citizensdk_error_code_t citizensdk_private_key_open( citizensdk_handle_t handle, const citizensdk_account_id_t *account_id, const citizensdk_private_key_receiver_v1_t *receiver, uint64_t *out_secret_id, citizensdk_request_id_t *out_request_id)'],
      ['citizensdk_private_key_reveal', 'citizensdk_error_code_t citizensdk_private_key_reveal( citizensdk_handle_t handle, uint64_t secret_id)'],
      ['citizensdk_private_key_cancel', 'citizensdk_error_code_t citizensdk_private_key_cancel( citizensdk_handle_t handle, uint64_t secret_id)'],
      ['citizensdk_private_key_finish', 'citizensdk_error_code_t citizensdk_private_key_finish( citizensdk_handle_t handle, uint64_t secret_id)'],
    ]);
    if (sensitiveFunctions.has(functionName)) {
      if (normalized !== sensitiveFunctions.get(functionName)) {
        fail('CitizenSDK 敏感边界 ABI 必须保持准确登记签名');
      }
    } else if (forbiddenPrivateMaterial || carriesGenericSecret
        || (carriesMnemonic && !mnemonicFunctions.has(functionName))) {
      fail(`CitizenSDK 公共 ABI 禁止助记词、私钥或秘密导出：${functionName}`);
    }
    if (functionName === 'citizensdk_prepared_wallet_copy_mnemonic'
        && (!/\bcitizensdk_handle_t\s+handle\b/.test(normalized)
          || !/\bcitizensdk_prepared_wallet_handle_t\s+prepared_wallet\b/.test(normalized)
          || /\bout_[A-Za-z0-9_]*mnemonic[A-Za-z0-9_]*\b/i.test(normalized))) {
      fail('CitizenSDK 助记词备份 ABI 必须绑定所属 instance/prepared handle，并只写调用方通用缓冲区');
    }
  }
  assertDeclaredFiles(sourceRoot, PUBLIC_ABI_FILES, '公共 ABI');
  assertDeclaredFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertDeclaredFiles(sourceRoot, {'include/smoldot.h':SMOLDOT_SUPPORT_FILES['include/smoldot.h']}, '兼容节点头');
}

function assertChainAssets(root) {
  const sourceRoot = resolve(root);
  // chain是唯一源码资产根；旧包装层即使字节相同也不接受。
  if (existsSync(join(sourceRoot, 'assets'))) fail('CitizenSDK 禁止旧资产包装目录');
  const assetsRoot = join(sourceRoot, 'chain');
  if (!existsSync(assetsRoot)
      || lstatSync(assetsRoot).isSymbolicLink()
      || !lstatSync(assetsRoot).isDirectory()) {
    fail('CitizenSDK 缺少普通链资产目录');
  }
  const actualPaths = regularFiles(assetsRoot).map((path) => `chain/${path}`);
  const expectedPaths = Object.keys(CHAIN_ASSET_FILES).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    fail(`CitizenSDK 链资产闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
  assertDeclaredFiles(sourceRoot, CHAIN_ASSET_FILES, '链资产');

  const manifestPath = join(assetsRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('CitizenSDK 链资产 manifest 不是有效 JSON');
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    fail('CitizenSDK 链资产 manifest 必须是 JSON 对象');
  }
  const actualManifestKeys = Object.keys(manifest).sort();
  const expectedManifest={...CHAIN_ASSET_MANIFEST,chainspec_sha256:sha256File(join(assetsRoot,'chainspec.json')),light_sync_state_sha256:sha256File(join(assetsRoot,'light_sync_state.json'))};
  const expectedManifestKeys = Object.keys(expectedManifest).sort();
  if (JSON.stringify(actualManifestKeys) !== JSON.stringify(expectedManifestKeys)) {
    fail('CitizenSDK 链资产 manifest 字段闭集漂移');
  }
  for (const [field, expected] of Object.entries(expectedManifest)) {
    if (manifest[field] !== expected) {
      fail(`CitizenSDK 链资产 manifest 字段漂移：${field}`);
    }
  }
}

function assertSourceFixtures(root) {
  assertDeclaredFiles(root, SOURCE_FIXTURE_FILES, '解码夹具');
}

function assertLicenseSources(root) {
  assertDeclaredFiles(root, LICENSE_SOURCE_FILES, '许可证原文');
}

function isDocumentationFile(relativePath) {
  const name = relativePath.split('/').at(-1);
  return /\.(?:adoc|md|rst|txt)$/i.test(name)
    || /^(?:CHANGELOG|LICENSE|README|UPSTREAM)(?:[-.].*)?$/i.test(name);
}




// 源码检查默认不允许 Darwin 树出现任何链接。只有最终候选的调用点可以显式
// 开启 Apple 产物投影；即使开启，也必须逐条匹配 macOS framework 的标准五
// 链接，iOS 设备/simulator 技术变体和 Darwin 其余路径仍保持零链接。

/** Verify every non-smoldot Dart, Android and Apple production input. */

/**
 * Windows 来源与同版安装件分别闭合；候选只允许固定安装闭集。
 * 文档与 test 各归准确闭集；目录反向枚举防止空 CMake 缓存绕过文件哈希。
 */
function assertWindowsBindingSource(root, { allowInjectedWindowsArtifacts = false } = {}) {
  const sourceRoot = resolve(root);
  const windowsRoot = join(sourceRoot, 'windows');
  if (!existsSync(windowsRoot) || lstatSync(windowsRoot).isSymbolicLink()
      || !lstatSync(windowsRoot).isDirectory()) fail('CitizenSDK 缺少普通 Windows Host 来源目录');
  if (Object.keys(WINDOWS_BINDING_SOURCE_FILES).length !== 52) {
    fail('CitizenSDK Windows Host/Flutter 固定生产清单必须精确为 52 文件');
  }
  const directories = regularDirectories(windowsRoot);
  const expectedDirectories = [...new Set(['cmake', 'headers', 'source', 'tests',
    ...(allowInjectedWindowsArtifacts ? parentDirectories(WINDOWS_RELEASE_FILES) : []),
  ])].sort();
  if (JSON.stringify(directories) !== JSON.stringify(expectedDirectories)) {
    fail('CitizenSDK Windows Host 目录闭集漂移');
  }
  const files = regularFiles(windowsRoot)
    .filter((path) => !allowInjectedWindowsArtifacts || !WINDOWS_INJECTED_FILES.has(path))
    .filter((path) => !path.startsWith('tests/'))
    .filter((path) => path === 'CMakeLists.txt' || !isDocumentationFile(path))
    .map((path) => `windows/${path}`).sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(WINDOWS_BINDING_SOURCE_FILES).sort())) {
    fail('CitizenSDK Windows Host 文件闭集漂移');
  }
  assertDeclaredFiles(sourceRoot, SHARED_CPP_SOURCE_FILES, '共享C++头');
  assertDeclaredFiles(sourceRoot, WINDOWS_BINDING_SOURCE_FILES, 'Windows Host 来源');
  const cmake = readFileSync(join(windowsRoot, 'CMakeLists.txt'), 'utf8');
  const versions = [...cmake.matchAll(/^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/gm)];
  if (versions.length !== 1) fail('CitizenSDK Windows Host 产品身份或版本字段不唯一');
  const pubspec = join(sourceRoot, 'pubspec.yaml');
  if (existsSync(pubspec) && readFileSync(pubspec, 'utf8').match(/^version: (.+)$/m)?.[1] !== versions[0][1]) {
    fail('CitizenSDK Windows Host 版本必须与唯一 SDK 版本一致');
  }
  const header = readFileSync(join(windowsRoot, 'headers/citizensdk_host.h'), 'utf8');
  const functions = [...new Set([...header.matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]))].sort();
  const exports = readFileSync(join(windowsRoot, 'cmake/citizensdk_host.def'), 'utf8')
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('LIBRARY ') && line !== 'EXPORTS').sort();
  const qrImageFunctions = [
    'citizensdk_qr_image_decode_luminance',
    'citizensdk_qr_image_decode_luminance_all',
    'citizensdk_qr_image_encode_text',
    'citizensdk_qr_image_zxing_version',
  ];
  const expectedExports = [...functions, ...qrImageFunctions].sort();
  if (functions.length !== 19 || JSON.stringify(expectedExports) !== JSON.stringify(exports)) {
    fail('CitizenSDK Windows Host 导出闭集漂移');
  }
  return versions[0][1];
}


/**
 * 校验唯一根README简明介绍及其普通文件边界，拒绝平台说明副本和额外docs目录。
 */

function compileRootedPubignoreRule(rawRule) {
  const negated = rawRule.startsWith('!');
  const rule = negated ? rawRule.slice(1) : rawRule;
  if (!rule.startsWith('/')) {
    fail(`CitizenSDK .pubignore 只允许可审计的根路径规则：${rawRule}`);
  }
  const directory = rule.endsWith('/');
  const pattern = directory ? rule.slice(1, -1) : rule.slice(1);
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // 官方 **/ 也匹配零层目录；末尾 /* 不可把父目录自身当作子项排除。
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += pattern[index - 1] === '/' && index === pattern.length - 1 ? '[^/]+' : '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return {
    ignored: !negated,
    pattern: new RegExp(`^${expression}${directory ? '(?:/.*)?' : '/?'}$`),
  };
}

function hostedPubignoreRules(sourceRoot) {
  const path = join(sourceRoot, '.pubignore');
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    fail('CitizenSDK 缺少普通 .pubignore');
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(compileRootedPubignoreRule);
}

function isHostedIgnored(relativePath, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.pattern.test(relativePath)) ignored = rule.ignored;
  }
  return ignored;
}

/** Verify the Dart files that the real pinned .pubignore exposes to Hosted consumers. */

/** Linux 运行包分别核验源码输入与原生安装件闭集。 */

/** Windows 运行包分别核验源码输入与原生安装件闭集。 */
function assertHostedRuntimeWindowsProjection(root, { allowInjectedWindowsArtifacts = false } = {}) {
  const sourceRoot = resolve(root);
  const rules = hostedPubignoreRules(sourceRoot);
  const expected = [...new Set([...HOSTED_WINDOWS_PLUGIN_FILES,
    ...WINDOWS_HOST_HEADERS.filter(name=>!['citizen_sdk_error.hpp','citizen_sdk_events.hpp','citizen_sdk_models.hpp'].includes(name)).map((name) => `headers/${name}`),
    ...(allowInjectedWindowsArtifacts ? WINDOWS_RELEASE_FILES : []),
  ])].map((path) => `windows/${path}`).sort();
  const actual = regularFiles(join(sourceRoot, 'windows')).map((path) => `windows/${path}`)
    .filter((path) => !isHostedIgnored(path, rules)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`CitizenSDK Hosted Windows 运行闭集漂移；缺失=${expected.filter((path) => !actual.includes(path)).join(',') || '无'}；额外=${actual.filter((path) => !expected.includes(path)).join(',') || '无'}`);
  }
}




function assertSignerSource(root) {
  const sourceRoot = resolve(root);
  for (const relativePath of Object.keys(SIGNER_FILES)) {
    const path = join(sourceRoot, ...relativePath.split('/'));
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail(`CitizenSDK 缺少普通 signer 源文件：${relativePath}`);
    }
  }
  const signerRoot = join(sourceRoot, 'native', 'signer');
  const actualClosure = regularFiles(signerRoot)
    .map((path) => `native/signer/${path}`)
    .sort();
  const expectedClosure = Object.keys(SIGNER_FILES).sort();
  if (JSON.stringify(actualClosure) !== JSON.stringify(expectedClosure)) {
    const actual = new Set(actualClosure);
    const expected = new Set(expectedClosure);
    const missing = expectedClosure.filter((path) => !actual.has(path));
    const extra = actualClosure.filter((path) => !expected.has(path));
    fail(`CitizenSDK signer 8 文件闭集漂移；缺失=${missing.join(',') || '无'}；额外=${extra.join(',') || '无'}`);
  }
}

function nativeArtifactSource(nativeRoot, sourcePath, expectedType = 'file') {
  const components = sourcePath.split('/');
  let current = nativeRoot;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') fail(`缺少原生产物：${sourcePath}`);
      throw error;
    }
    if (info.isSymbolicLink()) {
      fail(`原生产物路径禁止符号链接：${sourcePath}`);
    }
    const isFinal = index === components.length - 1;
    const finalTypeMatches = expectedType === 'file' ? info.isFile() : info.isDirectory();
    if ((!isFinal && !info.isDirectory()) || (isFinal && !finalTypeMatches)) {
      fail(`原生产物路径类型无效：${sourcePath}`);
    }
  }
  const realSource = realpathSync(current);
  if (!realSource.startsWith(`${nativeRoot}${sep}`)) {
    fail(`原生产物真实路径越出受控根：${sourcePath}`);
  }
  return current;
}

/**
 * Reject every native-input link except the five exact versioned-macOS
 * framework links. The XCFramework directory itself and all ancestors remain
 * ordinary directories, so an allowed internal link cannot redirect the
 * native source root.
 */
// Read ELF64 little-endian directly on any CI host. PT_DYNAMIC is the runtime
// authority: section tables must identify the same mapped bytes, not a decoy
// table appended to an unrelated library. This is structural validation, not
// evidence that Linux/GTK/TPM execution or dependency provenance has passed.

// Canonical instructions emitted by CMake; comments are not executable input.
// The export check is complete, so a second set_property/include cannot override
// a previously checked path. Unknown generator instructions fail closed.
const LINUX_CMAKE_PACKAGE_INIT = [
  "get_filename_component(PACKAGE_PREFIX_DIR \"${CMAKE_CURRENT_LIST_DIR}/../../../../\" ABSOLUTE)",
  "macro(set_and_check _var _file)",
  "  set(${_var} \"${_file}\")",
  "  if(NOT EXISTS \"${_file}\")",
  "    message(FATAL_ERROR \"File or directory ${_file} referenced by variable ${_var} does not exist !\")",
  "  endif()",
  "endmacro()",
  "macro(check_required_components _NAME)",
  "  foreach(comp ${${_NAME}_FIND_COMPONENTS})",
  "    if(NOT ${_NAME}_${comp}_FOUND)",
  "      if(${_NAME}_FIND_REQUIRED_${comp})",
  "        set(${_NAME}_FOUND FALSE)",
  "      endif()",
  "    endif()",
  "  endforeach()",
  "endmacro()",
].join('\n');
const LINUX_CMAKE_TARGETS = [
  "if(\"${CMAKE_MAJOR_VERSION}.${CMAKE_MINOR_VERSION}\" LESS 2.8)",
  "   message(FATAL_ERROR \"CMake >= 2.8.12 required\")",
  "endif()",
  "if(CMAKE_VERSION VERSION_LESS \"2.8.12\")",
  "   message(FATAL_ERROR \"CMake >= 2.8.12 required\")",
  "endif()",
  "cmake_policy(PUSH)",
  "cmake_policy(VERSION 2.8.12...4.0)",
  "set(CMAKE_IMPORT_FILE_VERSION 1)",
  "set(_cmake_targets_defined \"\")",
  "set(_cmake_targets_not_defined \"\")",
  "set(_cmake_expected_targets \"\")",
  "foreach(_cmake_expected_target IN ITEMS CitizenSDK::Host)",
  "  list(APPEND _cmake_expected_targets \"${_cmake_expected_target}\")",
  "  if(TARGET \"${_cmake_expected_target}\")",
  "    list(APPEND _cmake_targets_defined \"${_cmake_expected_target}\")",
  "  else()",
  "    list(APPEND _cmake_targets_not_defined \"${_cmake_expected_target}\")",
  "  endif()",
  "endforeach()",
  "unset(_cmake_expected_target)",
  "if(_cmake_targets_defined STREQUAL _cmake_expected_targets)",
  "  unset(_cmake_targets_defined)",
  "  unset(_cmake_targets_not_defined)",
  "  unset(_cmake_expected_targets)",
  "  unset(CMAKE_IMPORT_FILE_VERSION)",
  "  cmake_policy(POP)",
  "  return()",
  "endif()",
  "if(NOT _cmake_targets_defined STREQUAL \"\")",
  "  string(REPLACE \";\" \", \" _cmake_targets_defined_text \"${_cmake_targets_defined}\")",
  "  string(REPLACE \";\" \", \" _cmake_targets_not_defined_text \"${_cmake_targets_not_defined}\")",
  "  message(FATAL_ERROR \"Some (but not all) targets in this export set were already defined.\\nTargets Defined: ${_cmake_targets_defined_text}\\nTargets not yet defined: ${_cmake_targets_not_defined_text}\\n\")",
  "endif()",
  "unset(_cmake_targets_defined)",
  "unset(_cmake_targets_not_defined)",
  "unset(_cmake_expected_targets)",
  "get_filename_component(_IMPORT_PREFIX \"${CMAKE_CURRENT_LIST_FILE}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "get_filename_component(_IMPORT_PREFIX \"${_IMPORT_PREFIX}\" PATH)",
  "if(_IMPORT_PREFIX STREQUAL \"/\")",
  "  set(_IMPORT_PREFIX \"\")",
  "endif()",
  "add_library(CitizenSDK::Host SHARED IMPORTED)",
  "set_target_properties(CitizenSDK::Host PROPERTIES",
  "  INTERFACE_COMPILE_FEATURES \"cxx_std_17\"",
  "  INTERFACE_INCLUDE_DIRECTORIES \"${_IMPORT_PREFIX}/include\"",
  "  INTERFACE_LINK_LIBRARIES \"CitizenSDK::Core\"",
  ")",
  "file(GLOB _cmake_config_files \"${CMAKE_CURRENT_LIST_DIR}/CitizenSDKTargets-*.cmake\")",
  "foreach(_cmake_config_file IN LISTS _cmake_config_files)",
  "  include(\"${_cmake_config_file}\")",
  "endforeach()",
  "unset(_cmake_config_file)",
  "unset(_cmake_config_files)",
  "set(_IMPORT_PREFIX)",
  "foreach(_cmake_target IN LISTS _cmake_import_check_targets)",
  "  if(CMAKE_VERSION VERSION_LESS \"3.28\"",
  "      OR NOT DEFINED _cmake_import_check_xcframework_for_${_cmake_target}",
  "      OR NOT IS_DIRECTORY \"${_cmake_import_check_xcframework_for_${_cmake_target}}\")",
  "    foreach(_cmake_file IN LISTS \"_cmake_import_check_files_for_${_cmake_target}\")",
  "      if(NOT EXISTS \"${_cmake_file}\")",
  "        message(FATAL_ERROR \"The imported target \\\"${_cmake_target}\\\" references the file",
  "   \\\"${_cmake_file}\\\"",
  "but this file does not exist.  Possible reasons include:",
  "* The file was deleted, renamed, or moved to another location.",
  "* An install or uninstall procedure did not complete successfully.",
  "* The installation package was faulty and contained",
  "   \\\"${CMAKE_CURRENT_LIST_FILE}\\\"",
  "but not all the files it references.",
  "\")",
  "      endif()",
  "    endforeach()",
  "  endif()",
  "  unset(_cmake_file)",
  "  unset(\"_cmake_import_check_files_for_${_cmake_target}\")",
  "endforeach()",
  "unset(_cmake_target)",
  "unset(_cmake_import_check_targets)",
  "set(CMAKE_IMPORT_FILE_VERSION)",
  "cmake_policy(POP)",
].join('\n');


function cmakeInstructions(source) {
  let quoted = false;
  const lines = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    // No bracket-argument/comment syntax is emitted by these generators. Never
    // discard a bracket comment followed by executable code on the same line,
    // or a line that merely resembles a comment inside a quoted message.
    if (/\[=*\[/.test(line)) fail('CitizenSDK Linux CMake 出现未登记的 bracket 语法');
    if (!quoted && (!trimmed || trimmed.startsWith('#'))) continue;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '\\') index += 1;
      else if (line[index] === '"') quoted = !quoted;
    }
    lines.push(trimmed);
  }
  if (quoted) fail('CitizenSDK Linux CMake 字符串未终止');
  return lines.join('\n');
}

function linuxCmakeTargetVariants() {
  const current = cmakeInstructions(LINUX_CMAKE_TARGETS);
  const variants = new Set();
  // CMake's official 3.x/4.x exporters change policy ceilings, old-consumer
  // guards and the XCFramework existence guard. Admit those complete, safe
  // structures only; never delete arbitrary instructions from candidate input.
  // References: Kitware/CMake cmExport{File,CMakeConfig}Generator.cxx (3.24/3.31).
  for (const ceiling of ['3.22', '3.23', '3.26', '3.29', '4.0']) {
    for (const legacy of [false, true]) {
      let expected = current.replace('2.8.12...4.0', `2.8.12...${ceiling}`);
      if (legacy) {
        expected = expected
          .replace('message(FATAL_ERROR "CMake >= 2.8.12 required")', 'message(FATAL_ERROR "CMake >= 2.8.0 required")')
          .replace('if(CMAKE_VERSION VERSION_LESS "2.8.12")', 'if(CMAKE_VERSION VERSION_LESS "2.8.3")')
          .replace('message(FATAL_ERROR "CMake >= 2.8.12 required")', 'message(FATAL_ERROR "CMake >= 2.8.3 required")')
          .replace(`2.8.12...${ceiling}`, `2.8.3...${ceiling}`)
          .replace('file(GLOB _cmake_config_files', [
            'if(CMAKE_VERSION VERSION_LESS 2.8.12)',
            'message(FATAL_ERROR "This file relies on consumers using CMake 2.8.12 or greater.")',
            'endif()',
            'file(GLOB _cmake_config_files',
          ].join('\n'));
      }
      variants.add(expected);
      variants.add(expected.replace([
        'if(CMAKE_VERSION VERSION_LESS "3.28"',
        'OR NOT DEFINED _cmake_import_check_xcframework_for_${_cmake_target}',
        'OR NOT IS_DIRECTORY "${_cmake_import_check_xcframework_for_${_cmake_target}}")',
        '',
      ].join('\n'), '').replace('endforeach()\nendif()\nunset(_cmake_file)', 'endforeach()\nunset(_cmake_file)'));
    }
  }
  return variants;
}


/** Verify the merged 26-file installation and the unchanged source closure. */

// 按 Microsoft PE/COFF 格式读取真实目录表，不依赖 dumpbin 文本或文件扩展名。
// 系统加载、实际 CRT 部署及硬件行为仍须由 Windows 原生消费者验收。
function windowsPe(path, { headersOnly = false } = {}) {
  const bytes = readFileSync(path);
  const invalid = (message) => fail(`CitizenSDK Windows PE ${path}：${message}`);
  const range = (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0
        || length < 0 || offset > bytes.length - length) invalid('结构越界');
    return offset;
  };
  range(0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) invalid('缺少 DOS 标识');
  const pe = range(bytes.readUInt32LE(60), 24);
  const count = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664
      || count < 1 || count > 96 || optionalSize < 240) invalid('机器或 COFF 头漂移');
  const optional = range(pe + 24, optionalSize);
  if (bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 16) invalid('必须为 PE32+');
  const sections = [];
  for (let index = 0; index < count; index += 1) {
    const offset = range(optional + optionalSize + index * 40, 40);
    const section = { address: bytes.readUInt32LE(offset + 12), size: bytes.readUInt32LE(offset + 8),
      raw: bytes.readUInt32LE(offset + 20), rawSize: bytes.readUInt32LE(offset + 16),
      flags: bytes.readUInt32LE(offset + 36) };
    range(section.raw, section.rawSize);
    if (section.address === 0 || section.address + Math.max(section.size, section.rawSize) > 0x100000000
        || sections.some((previous) => section.address < previous.address + Math.max(previous.size, previous.rawSize)
          && previous.address < section.address + Math.max(section.size, section.rawSize))) invalid('节地址重叠或无效');
    sections.push(section);
  }
  if (headersOnly) return;
  const mapped = (address, length = 1) => {
    const found = sections.filter((section) => address >= section.address
      && address + length <= section.address + section.rawSize);
    if (found.length !== 1 || length < 1) invalid('RVA 不在唯一文件节中');
    return range(found[0].raw + address - found[0].address, length);
  };
  const string = (address) => {
    const start = mapped(address);
    const end = bytes.indexOf(0, start);
    if (end < start || end - start > 4096) invalid('字符串未终止');
    mapped(address, end - start + 1);
    const value = bytes.subarray(start, end);
    if (value.length === 0 || value.some((byte) => byte < 0x20 || byte > 0x7e)) invalid('字符串不是非空 ASCII');
    return value.toString('ascii');
  };
  const directory = (index) => {
    const offset = optional + 112 + index * 8;
    const address = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if ((address === 0) !== (size === 0)) invalid('目录地址与长度不一致');
    return { address, size, offset: address ? mapped(address, size) : 0 };
  };
  const exports = [];
  const exported = directory(0);
  let dllName = null;
  if (exported.address) {
    if (exported.size < 40) invalid('导出目录截断');
    const at = exported.offset;
    dllName = string(bytes.readUInt32LE(at + 12));
    const functions = bytes.readUInt32LE(at + 20), names = bytes.readUInt32LE(at + 24);
    if (!names || names > 65536 || functions !== names) invalid('导出数量或 ordinal-only 项无效');
    const addresses = mapped(bytes.readUInt32LE(at + 28), functions * 4);
    const pointers = mapped(bytes.readUInt32LE(at + 32), names * 4);
    const ordinals = mapped(bytes.readUInt32LE(at + 36), names * 2);
    const seen = new Set();
    for (let index = 0; index < names; index += 1) {
      const ordinal = bytes.readUInt16LE(ordinals + index * 2);
      if (ordinal >= functions || seen.has(ordinal)) invalid('导出 ordinal 重复或越界');
      seen.add(ordinal);
      const address = bytes.readUInt32LE(addresses + ordinal * 4);
      if (address >= exported.address && address < exported.address + exported.size) invalid('禁止转发导出');
      mapped(address);
      if (!sections.some((section) => address >= section.address && address < section.address + section.rawSize
          && (section.flags & 0x20000000))) invalid('导出地址不是可执行代码');
      exports.push(string(bytes.readUInt32LE(pointers + index * 4)));
    }
    if (new Set(exports).size !== exports.length || JSON.stringify(exports) !== JSON.stringify([...exports].sort())) {
      invalid('导出名称顺序或唯一性漂移');
    }
  }
  const imports = [];
  const thunks = (address) => {
    const names = [];
    for (let index = 0; index < 65536; index += 1) {
      const value = bytes.readBigUInt64LE(mapped(address + index * 8, 8));
      if (value === 0n) return names;
      if (value & (1n << 63n)) {
        if ((value & ~((1n << 63n) | 0xffffn)) !== 0n) invalid('import ordinal 位非法');
        names.push(null);
      } else {
        if (value > 0xffffffffn) invalid('import thunk RVA 越界');
        mapped(Number(value), 2);
        names.push(string(Number(value) + 2));
      }
    }
    invalid('import thunk 未终止');
  };
  for (const [index, width] of [[1, 20], [13, 32]]) {
    const table = directory(index);
    if (!table.address) continue;
    let terminated = false;
    for (let cursor = 0; cursor + width <= table.size; cursor += width) {
      const at = table.offset + cursor;
      if (bytes.subarray(at, at + width).every((byte) => byte === 0)) { terminated = true; break; }
      if (index === 13 && bytes.readUInt32LE(at) !== 1) invalid('delay import 必须使用 RVA');
      const name = string(bytes.readUInt32LE(at + (index === 1 ? 12 : 4))).toLowerCase();
      if (!/^[a-z0-9_-]+\.dll$/.test(name) || imports.some((entry) => entry.name === name)) invalid('导入 DLL 路径、名称或唯一性无效');
      const lookup = bytes.readUInt32LE(at + (index === 1 ? 0 : 16));
      const iat = bytes.readUInt32LE(at + (index === 1 ? 16 : 12));
      if (!iat) invalid('缺少 import address table');
      const names = thunks(lookup || iat);
      mapped(iat, (names.length + 1) * 8);
      if (!names.length) invalid('空 import descriptor');
      imports.push({ name, symbols: names });
    }
    if (!terminated) invalid('import descriptor 未终止');
  }
  return { exports, imports, dllName, dll: Boolean(bytes.readUInt16LE(pe + 22) & 0x2000) };
}

const WINDOWS_SYSTEM_IMPORTS = new Set([
  'mf.dll', 'mfplat.dll', 'mfreadwrite.dll', 'windowscodecs.dll',
  'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'cfgmgr32.dll', 'comctl32.dll',
  'crypt32.dll', 'cryptbase.dll', 'dbghelp.dll', 'dnsapi.dll', 'gdi32.dll', 'imm32.dll',
  'iphlpapi.dll', 'kernel32.dll', 'kernelbase.dll', 'ncrypt.dll', 'netapi32.dll',
  'normaliz.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'powrprof.dll', 'profapi.dll',
  'psapi.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll', 'shlwapi.dll',
  'synchronization.dll', 'tbs.dll', 'ucrtbase.dll', 'user32.dll', 'userenv.dll',
  'version.dll', 'winbio.dll', 'winhttp.dll', 'winmm.dll', 'wintrust.dll', 'ws2_32.dll', 'wtsapi32.dll',
  'msvcrt.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
]);
function assertWindowsImports(image, required, coreSymbols) {
  for (const entry of image.imports) {
    if (!required.includes(entry.name) && !WINDOWS_SYSTEM_IMPORTS.has(entry.name)
        && !/^(?:api|ext)-ms-win-[a-z0-9]+(?:-[a-z0-9]+)*-l\d+-\d+-\d+\.dll$/.test(entry.name)) {
      fail(`CitizenSDK Windows 未登记的 DLL 依赖：${entry.name}`);
    }
    if (entry.name === 'citizensdk.dll'
        && entry.symbols.some((symbol) => symbol === null || !coreSymbols.includes(symbol))) {
      fail('CitizenSDK Windows Host 导入了闭集外的 Core 符号');
    }
  }
  for (const name of required) {
    if (!image.imports.some((entry) => entry.name === name)) fail(`CitizenSDK Windows 缺少必要依赖：${name}`);
  }
}

function assertWindowsImportLibrary(path, dll, expectedSymbols) {
  const bytes = readFileSync(path), symbols = [], members = [];
  const invalid = () => fail(`CitizenSDK Windows import library 格式、机器或符号漂移：${path}`);
  const range = (data, at, size) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0
        || at > data.length || size > data.length - at) invalid();
  };
  const ascii = (data) => {
    if (data.some((value) => value < 32 || value > 127)) invalid();
    return data.toString('latin1');
  };
  const cstring = (data, at, limit = data.length) => {
    range(data, at, limit - at);
    const end = data.indexOf(0, at);
    if (end < at || end >= limit || end === at) invalid();
    return { text: ascii(data.subarray(at, end)), next: end + 1 };
  };
  const zero = (data) => data.every((value) => value === 0);
  // 官方 COFF archive 两个索引可在 payload 内补一个零字节至偶数边界；外部 padding 仍为 LF。
  const indexEnd = (data, at) => {
    if (at !== data.length && !(at % 2 === 1 && at + 1 === data.length && data[at] === 0)) invalid();
  };
  if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) invalid();
  let cursor = 8;
  while (cursor < bytes.length) {
    if (members.length >= 100000 || cursor + 60 > bytes.length
        || bytes[cursor + 58] !== 0x60 || bytes[cursor + 59] !== 10) invalid();
    const name = ascii(bytes.subarray(cursor, cursor + 16)).trimEnd();
    const sizeText = ascii(bytes.subarray(cursor + 48, cursor + 58)).trim();
    if (!/^\d+$/.test(sizeText)) invalid();
    const size = Number(sizeText), start = cursor + 60, end = start + size;
    range(bytes, start, size);
    members.push({ offset: cursor, name, data: bytes.subarray(start, end) });
    cursor = end + (size % 2);
    if (size % 2 && bytes[end] !== 10) invalid();
  }
  if (cursor !== bytes.length || members.length < 5 || members[0].name !== '/' || members[1].name !== '/') invalid();
  const longnames = new Map();
  let objectStart = 2;
  if (members[2].name === '//') {
    const data = members[2].data;
    let at = 0;
    while (at < data.length) {
      // LLVM 的 longnames 表允许将最终 LF 对齐字节计入 member size。
      if (at % 2 === 1 && at + 1 === data.length && data[at] === 10) { at += 1; break; }
      const entry = cstring(data, at);
      longnames.set(at, entry.text);
      at = entry.next;
    }
    objectStart = 3;
  }
  const objects = members.slice(objectStart);
  const definitions = new Map();
  const stem = dll.replace(/\.dll$/, '');
  const descriptor = `__IMPORT_DESCRIPTOR_${stem}`;
  const nullDescriptor = '__NULL_IMPORT_DESCRIPTOR';
  const nullThunk = `\x7f${stem}_NULL_THUNK_DATA`;
  const descriptors = new Set([descriptor, nullDescriptor, nullThunk]);
  const define = (name, offset) => {
    if (definitions.has(name)) invalid();
    definitions.set(name, offset);
  };
  for (const member of objects) {
    const resolved = /^\/\d+$/.test(member.name) ? longnames.get(Number(member.name.slice(1)))
      : member.name.endsWith('/') ? member.name.slice(0, -1) : undefined;
    // archive 文件名不是 DLL 身份；允许官方任意对象名称，但引用必须指向 longnames 串首。
    if (!resolved || /[\x00-\x1f\x7f]/.test(resolved) || member.name === '/' || member.name === '//') invalid();
    const object = member.data;
    range(object, 0, 20);
    if (object.readUInt16LE(0) === 0 && object.readUInt16LE(2) === 0xffff) {
      if (object.readUInt16LE(4) !== 0 || object.readUInt16LE(6) !== 0x8664
          || object.readUInt16LE(18) !== 4 || object.readUInt32LE(12) !== object.length - 20) invalid();
      const name = cstring(object, 20), library = cstring(object, name.next);
      if (library.next !== object.length || library.text.toLowerCase() !== dll || !expectedSymbols.includes(name.text)) invalid();
      symbols.push(name.text);
      define(name.text, member.offset);
      define(`__imp_${name.text}`, member.offset);
      continue;
    }
    // 只接纳官方导入描述符 COFF，而非携带 .text、.drectve 或额外外部定义的实现对象。
    const sectionCount = object.readUInt16LE(2), table = object.readUInt32LE(8), count = object.readUInt32LE(12);
    const headersEnd = 20 + sectionCount * 40, stringsAt = table + count * 18;
    if (object.readUInt16LE(0) !== 0x8664 || object.readUInt16LE(16) !== 0
        || sectionCount < 1 || sectionCount > 16 || table < headersEnd || count < 1) invalid();
    range(object, 20, sectionCount * 40);
    range(object, table, count * 18 + 4);
    const stringSize = object.readUInt32LE(stringsAt);
    if (stringSize < 4) invalid();
    range(object, stringsAt, stringSize);
    if (stringsAt + stringSize !== object.length) invalid();
    const sections = [], occupied = [[0, headersEnd], [table, object.length]];
    const occupy = (at, length) => {
      range(object, at, length);
      if (length === 0) return;
      if (occupied.some(([begin, end]) => at < end && begin < at + length)) invalid();
      occupied.push([at, at + length]);
    };
    for (let index = 0; index < sectionCount; index += 1) {
      const at = 20 + index * 40;
      const nameBytes = object.subarray(at, at + 8), nul = nameBytes.indexOf(0);
      const name = ascii(nul < 0 ? nameBytes : nameBytes.subarray(0, nul));
      if (nul >= 0 && !zero(nameBytes.subarray(nul))) invalid();
      const size = object.readUInt32LE(at + 16), raw = object.readUInt32LE(at + 20);
      const reloc = object.readUInt32LE(at + 24), relocCount = object.readUInt16LE(at + 32);
      const flags = object.readUInt32LE(at + 36);
      if ((!/^\.idata\$[234567]$/.test(name) && name !== '.debug$S')
          || sections.some((section) => section.name === name)
          || object.readUInt32LE(at + 8) !== 0 || object.readUInt32LE(at + 12) !== 0
          || object.readUInt32LE(at + 28) !== 0 || object.readUInt16LE(at + 34) !== 0
          || (flags & (0x20000000 | 0x01000000 | 0x00000800))) invalid();
      occupy(raw, size);
      occupy(reloc, relocCount * 10);
      sections.push({ name, data: object.subarray(raw, raw + size), reloc, relocCount });
    }
    const coffSymbols = new Map(), external = [], undefinedExternal = new Set();
    for (let index = 0; index < count;) {
      const at = table + index * 18;
      let name;
      if (object.readUInt32LE(at) === 0) {
        const offset = object.readUInt32LE(at + 4);
        if (offset < 4 || offset >= stringSize) invalid();
        name = cstring(object, stringsAt + offset, stringsAt + stringSize).text;
      } else {
        const field = object.subarray(at, at + 8), nul = field.indexOf(0);
        name = ascii(nul < 0 ? field : field.subarray(0, nul));
        if (!name || (nul >= 0 && !zero(field.subarray(nul)))) invalid();
      }
      const value = object.readUInt32LE(at + 8), section = object.readInt16LE(at + 12);
      const storage = object[at + 16], auxiliary = object[at + 17];
      if (section > sectionCount || section < -2 || index + auxiliary >= count || storage === 105) invalid();
      const symbol = { name, value, section, storage };
      coffSymbols.set(index, symbol);
      if (storage === 2) {
        if (!descriptors.has(name) || value !== 0 || object.readUInt16LE(at + 14) !== 0 || auxiliary !== 0) invalid();
        if (section > 0) { external.push(symbol); define(name, member.offset); }
        else if (section === 0) undefinedExternal.add(name);
        else invalid();
      }
      index += auxiliary + 1;
    }
    if (external.length !== 1) invalid();
    for (const section of sections) {
      section.relocations = [];
      for (let index = 0; index < section.relocCount; index += 1) {
        const at = section.reloc + index * 10;
        const offset = object.readUInt32LE(at), target = coffSymbols.get(object.readUInt32LE(at + 4));
        const type = object.readUInt16LE(at + 8);
        if (!target || offset >= section.data.length) invalid();
        section.relocations.push({ offset, target, type });
      }
    }
    const role = external[0].name;
    const dataSections = sections.filter((section) => section.name !== '.debug$S');
    const get = (name, length) => {
      const section = dataSections.find((entry) => entry.name === name);
      if (!section || section.data.length !== length) invalid();
      return section;
    };
    const empty = (section) => { if (!zero(section.data) || section.relocCount !== 0) invalid(); };
    if (role === descriptor) {
      const idata = get('.idata$2', 20), library = dataSections.find((entry) => entry.name === '.idata$6');
      if (dataSections.length !== 2 || !library || library.relocCount !== 0 || !zero(idata.data)
          || idata.relocCount !== 3 || sections[external[0].section - 1] !== idata
          || undefinedExternal.size !== 2 || !undefinedExternal.has(nullDescriptor) || !undefinedExternal.has(nullThunk)) invalid();
      const dllName = cstring(library.data, 0);
      if (dllName.text.toLowerCase() !== dll || library.data.length - dllName.next > 1
          || !zero(library.data.subarray(dllName.next))) invalid();
      const required = new Map([[0, '.idata$4'], [12, '.idata$6'], [16, '.idata$5']]);
      for (const { offset, target, type } of idata.relocations) {
        if (type !== 3 || required.get(offset) !== target.name || target.value !== 0
            || (target.storage !== 3 && target.storage !== 104)
            || (target.name === '.idata$6' ? sections[target.section - 1] !== library : target.section !== 0)) invalid();
        required.delete(offset);
      }
      if (required.size !== 0) invalid();
    } else if (role === nullDescriptor) {
      const idata = get('.idata$3', 20);
      if (dataSections.length !== 1 || undefinedExternal.size !== 0 || sections[external[0].section - 1] !== idata) invalid();
      empty(idata);
    } else {
      const ilt = get('.idata$4', 8), iat = get('.idata$5', 8);
      if (dataSections.length !== 2 || undefinedExternal.size !== 0
          || ![ilt, iat].includes(sections[external[0].section - 1])) invalid();
      empty(ilt); empty(iat);
    }
  }
  if (objects.length !== expectedSymbols.length + 3 || [...descriptors].some((name) => !definitions.has(name))
      || JSON.stringify(symbols.sort()) !== JSON.stringify(expectedSymbols)) invalid();
  // Microsoft PE/COFF 两份链接索引必须共同映射至真实 object header；只有公开名字相同不能证明可链接。
  // 格式依据：learn.microsoft.com/windows/win32/debug/pe-format；LLVM Object/{ArchiveWriter,COFFImportFile}.cpp。
  const first = members[0].data, second = members[1].data, expectedCount = definitions.size;
  range(first, 0, 4);
  if (first.readUInt32BE(0) !== expectedCount) invalid();
  range(first, 4, expectedCount * 4);
  let at = 4 + expectedCount * 4, previous = -1;
  const seenFirst = new Set();
  for (let index = 0; index < expectedCount; index += 1) {
    const offset = first.readUInt32BE(4 + index * 4), name = cstring(first, at);
    if (offset < previous || definitions.get(name.text) !== offset || seenFirst.has(name.text)) invalid();
    seenFirst.add(name.text); previous = offset; at = name.next;
  }
  indexEnd(first, at);
  range(second, 0, 4);
  if (second.readUInt32LE(0) !== objects.length || objects.length > 0xffff) invalid();
  range(second, 4, objects.length * 4 + 4);
  objects.forEach((member, index) => { if (second.readUInt32LE(4 + index * 4) !== member.offset) invalid(); });
  const countAt = 4 + objects.length * 4, indicesAt = countAt + 4;
  if (second.readUInt32LE(countAt) !== expectedCount) invalid();
  range(second, indicesAt, expectedCount * 2);
  at = indicesAt + expectedCount * 2;
  let previousName = '';
  for (let index = 0; index < expectedCount; index += 1) {
    const memberIndex = second.readUInt16LE(indicesAt + index * 2), name = cstring(second, at);
    if (memberIndex < 1 || memberIndex > objects.length || name.text <= previousName
        || definitions.get(name.text) !== objects[memberIndex - 1].offset) invalid();
    previousName = name.text; at = name.next;
  }
  indexEnd(second, at);
}

const WINDOWS_CMAKE_RELEASE = [
  'set(CMAKE_IMPORT_FILE_VERSION 1)',
  'set_property(TARGET CitizenSDK::Host APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)',
  'set_target_properties(CitizenSDK::Host PROPERTIES',
  '  IMPORTED_IMPLIB_RELEASE "${_IMPORT_PREFIX}/lib/Windows/citizensdk_host.lib"',
  '  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/bin/Windows/citizensdk_host.dll"',
  '  )',
  'list(APPEND _cmake_import_check_targets CitizenSDK::Host )',
  'list(APPEND _cmake_import_check_files_for_CitizenSDK::Host "${_IMPORT_PREFIX}/lib/Windows/citizensdk_host.lib" "${_IMPORT_PREFIX}/bin/Windows/citizensdk_host.dll" )',
  'set(CMAKE_IMPORT_FILE_VERSION)',
].join('\n');

function assertWindowsInstallClosure(prefix) {
  if (JSON.stringify(regularFiles(prefix)) !== JSON.stringify(WINDOWS_RELEASE_FILES)
      || JSON.stringify(regularDirectories(prefix)) !== JSON.stringify(parentDirectories(WINDOWS_RELEASE_FILES))) {
    fail('CitizenSDK Windows 安装投影必须精确为 22 个普通文件及其目录');
  }
  for (const path of WINDOWS_RELEASE_FILES) {
    const info = lstatSync(join(prefix, path));
    if (info.size === 0 || info.nlink !== 1) fail(`CitizenSDK Windows 安装件为空或硬链接：${path}`);
  }
}

function assertWindowsInstalledPlatform(sourceRoot, prefix) {
  const file = (path) => {
    const value = nativeArtifactSource(prefix, path), info = lstatSync(value);
    if (info.size === 0 || info.nlink !== 1) fail(`CitizenSDK Windows 安装件为空或硬链接：${path}`);
    return value;
  };
  const equal = (installed, source) => {
    if (!readFileSync(file(installed)).equals(readFileSync(join(sourceRoot, source)))) {
      fail(`CitizenSDK Windows 安装来源字节漂移：${installed}`);
    }
  };
  for (const name of ['citizensdk.h', 'citizensdk_types.h']) equal(`include/${name}`, `include/${name}`);
  equal('include/citizensdk_qr_image.h', 'native/image/citizensdk_qr_image.h');
  for (const name of WINDOWS_HOST_HEADERS) equal(`include/citizen_sdk/${name}`, hostHeaderSource('windows',name));
  for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
    equal(`share/citizensdk/chain/${name}`, `chain/${name}`);
  }
  const version = readFileSync(join(sourceRoot, 'pubspec.yaml'), 'utf8').match(/^version: (\d+\.\d{1,2}\.\d{1,2})$/m)?.[1];
  if (!version || readFileSync(join(sourceRoot, 'windows/CMakeLists.txt'), 'utf8')
    .match(/^project\(CitizenSDKHost VERSION (\d+\.\d{1,2}\.\d{1,2}) LANGUAGES C CXX\)$/m)?.[1] !== version) {
    fail('CitizenSDK Windows 源码版本不一致');
  }
  const template = (name) => readFileSync(join(sourceRoot, 'windows/cmake', name), 'utf8');
  const configs = Object.fromEntries(WINDOWS_CMAKE_FILES.map((name) => [name,
    readFileSync(file(`lib/Windows/cmake/CitizenSDK/${name}`), 'utf8')]));
  const body = template('CitizenSDKConfig.cmake.in').split('@PACKAGE_INIT@')[1]
    .replaceAll('@PACKAGE_CMAKE_INSTALL_LIBDIR@', '${PACKAGE_PREFIX_DIR}/lib')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_BINDIR@', '${PACKAGE_PREFIX_DIR}/bin')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_DATADIR@', '${PACKAGE_PREFIX_DIR}/share')
    .replaceAll('@PACKAGE_CMAKE_INSTALL_INCLUDEDIR@', '${PACKAGE_PREFIX_DIR}/include');
  if (configs['CitizenSDKConfigVersion.cmake'] !== template('CitizenSDKConfigVersion.cmake.in')
    .replaceAll('@PROJECT_VERSION@', version).replaceAll('@PROJECT_VERSION_MAJOR@', version.split('.')[0])
      || configs['CitizenSDKDependencies.cmake'] !== template('CitizenSDKDependencies.cmake')
      || cmakeInstructions(configs['CitizenSDKConfig.cmake']) !== cmakeInstructions(`${LINUX_CMAKE_PACKAGE_INIT}\n${body}`)
      || !linuxCmakeTargetVariants().has(cmakeInstructions(configs['CitizenSDKTargets.cmake']))
      || cmakeInstructions(configs['CitizenSDKTargets-release.cmake']) !== cmakeInstructions(WINDOWS_CMAKE_RELEASE)) {
    fail('CitizenSDK Windows CMake 版本、依赖、路径或导入目标合同漂移');
  }
  const coreSymbols = expectedCitizenSdkLinkedSymbols(sourceRoot);
  const hostSymbols = [...new Set([...readFileSync(join(sourceRoot, 'windows/headers/citizensdk_host.h'), 'utf8')
    .matchAll(/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]))].sort();
  const hostAndQrSymbols = [...hostSymbols, ...expectedQrImageSymbols(sourceRoot)].sort();
  if (coreSymbols.length !== 144 || hostSymbols.length !== 19 || hostAndQrSymbols.length !== 23) fail('CitizenSDK Windows 144公开Core及19Host+4图像导出闭集漂移');
  for (const [name, symbols, imports, library] of [
    ['citizensdk.dll', coreSymbols, [], 'citizensdk.dll.lib'],
    ['citizensdk_host.dll', hostAndQrSymbols, ['citizensdk.dll'], 'citizensdk_host.lib'],
  ]) {
    const image = windowsPe(file(`bin/Windows/${name}`));
    if (!image.dll || image.dllName?.toLowerCase() !== name
        || JSON.stringify(image.exports) !== JSON.stringify(symbols)) fail(`CitizenSDK Windows ${name} 完整导出漂移`);
    assertWindowsImports(image, imports, coreSymbols);
    assertWindowsImportLibrary(file(`lib/Windows/${library}`), name, symbols);
  }
  return version;
}

/** 唯一 Windows 安装验真入口；不要求其它平台产物存在。 */
function assertWindowsNativeArtifact(sourceRoot, prefix) {
  const source = resolve(sourceRoot), installed = assertSafeTargetPath(prefix, 'Windows 安装前缀');
  assertWindowsBindingSource(source);
  assertPublicAbiHeaders(source);
  assertChainAssets(source);
  assertWindowsInstallClosure(installed);
  return assertWindowsInstalledPlatform(source, installed);
}

/** destination 是完整 SDK 根；安装件与扁平源码头逐字节对拍后才写入公开安装目录。 */
function copyWindowsNativeArtifact(sourceRoot, prefix, destination) {
  const source = resolve(sourceRoot), installed = resolve(prefix);
  const output = assertSafeTargetPath(destination, 'Windows 候选根');
  assertLocalTarget(output, 'Windows 候选根');
  assertOutsideSource(installed, output, 'Windows 安装目标');
  assertOutsideSource(output, installed, 'Windows 安装来源');
  assertOutsideSource(source, output, 'Windows 候选根');
  assertOutsideSource(output, source, 'Windows SDK 来源');
  assertWindowsNativeArtifact(source, installed);
  const root = join(output, 'windows');
  // 目标的源码头仍须同源；安装目录扁平化不能绕过候选来源对拍。
  for (const name of WINDOWS_HOST_HEADERS) {
    const header=assertSafeTargetPath(join(output,hostHeaderSource('windows',name)), 'Windows 候选源头');
    if(!existsSync(header)||!lstatSync(header).isFile()||!readFileSync(header).equals(readFileSync(join(source,hostHeaderSource('windows',name)))))fail(`CitizenSDK Windows 重叠源码头漂移：${name}`);
  }
  const pending = [];
  for (const path of WINDOWS_RELEASE_FILES) {
    const target = assertSafeTargetPath(join(root, path), 'Windows 安装目标');
    const bytes = readFileSync(nativeArtifactSource(installed, path));
    if (existsSync(target)) {
      if (WINDOWS_INJECTED_FILES.has(path) || !lstatSync(target).isFile()
          || !bytes.equals(readFileSync(target))) fail(`CitizenSDK Windows 重叠安装件漂移或目标已存在：${path}`);
    } else pending.push({ target, bytes });
  }
  if (pending.length !== WINDOWS_INJECTED_FILES.size) fail('CitizenSDK Windows 候选安装目标必须全部为空');
  for (const { target, bytes } of pending) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
}

function assertWindowsReleaseProjection(root) {
  const source = resolve(root);
  assertWindowsBindingSource(source, { allowInjectedWindowsArtifacts: true });
  assertPublicAbiHeaders(source);
  assertChainAssets(source);
  return assertWindowsInstalledPlatform(source, join(source, 'windows'));
}

/** 构建器调用的同源 bundle 检查；app.so 是 Dart AOT ELF，不是 PE。 */
function assertWindowsFlutterBundle(sourceRoot, prefix, bundle) {
  const source = resolve(sourceRoot), installed = resolve(prefix);
  const root = assertSafeTargetPath(bundle, 'Windows Flutter bundle');
  assertWindowsNativeArtifact(source, installed);
  for (const name of ['citizensdk.dll', 'citizensdk_host.dll']) {
    if (!readFileSync(nativeArtifactSource(root, name)).equals(
      readFileSync(nativeArtifactSource(installed, `bin/Windows/${name}`)),
    )) fail(`CitizenSDK Windows Flutter bundle 运行库来源漂移：${name}`);
  }
  for (const name of ['manifest.json', 'chainspec.json', 'light_sync_state.json']) {
    const path = `data/flutter_assets/packages/citizen_sdk/chain/${name}`;
    if (!readFileSync(nativeArtifactSource(root, path)).equals(readFileSync(join(source, 'chain', name)))) {
      fail(`CitizenSDK Windows Flutter bundle 链资产漂移：${name}`);
    }
  }
  const plugin = windowsPe(nativeArtifactSource(root, 'citizen_sdk_plugin.dll'));
  if (!plugin.dll || JSON.stringify(plugin.exports) !== JSON.stringify(['CitizenSdkPluginRegisterWithRegistrar'])) {
    fail('CitizenSDK Windows Flutter 插件注册导出漂移');
  }
  assertWindowsImports(plugin, ['citizensdk.dll', 'citizensdk_host.dll', 'flutter_windows.dll'], expectedCitizenSdkSymbols(source));
  // Runner/Flutter engine 的功能导出不属于 SDK；只核机器身份，不伪造其符号闭集。
  windowsPe(nativeArtifactSource(root, 'citizensdk_consumer.exe'), { headersOnly: true });
  windowsPe(nativeArtifactSource(root, 'flutter_windows.dll'), { headersOnly: true });
  const aot = readFileSync(nativeArtifactSource(root, 'data/app.so'));
  if (aot.length < 64 || !aot.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || aot[4] !== 2 || aot[5] !== 1 || aot.readUInt16LE(18) !== 62) {
    fail('CitizenSDK Windows Dart AOT 必须为 x86_64 ELF64');
  }
}


// 本仓原生依赖只消费本仓原始锁；回执不建立第二份来源与版本真源。
const NATIVE_DEPENDENCY_PLATFORMS = ['LinuxARM', 'LinuxAMD', 'Windows'];
const TSS2_HEADERS = ['common', 'esys', 'mu', 'rc', 'sys', 'tcti', 'tcti_device', 'tpm2_types']
  .map((name) => 'include/tss2/tss2_' + name + '.h');
function dependencyCheck(ok, message) { if (!ok) fail('CitizenSDK 静态依赖：' + message); }

/** 逐成员读真实 ar；拒绝薄归档、动态库、COFF import object、bitcode 及另一平台对象。 */
function assertCitizenSdkStaticArchive(bytes, platform, nested = false) {
  dependencyCheck(NATIVE_DEPENDENCY_PLATFORMS.includes(platform), '未知平台');
  dependencyCheck(typeof nested === 'boolean', '静态归档嵌套状态无效');
  dependencyCheck(bytes.length >= 8 && bytes.subarray(0, 8).toString() === '!<arch>\n', '不是完整静态归档');
  let offset = 8, objects = 0, gnuNames = null;
  while (offset < bytes.length) {
    dependencyCheck(offset + 60 <= bytes.length, 'ar header 截断');
    const header = bytes.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString().trim();
    const sizeText = header.subarray(48, 58).toString().trim();
    dependencyCheck(header.subarray(58).toString() === '\x60\n' && /^\d+$/.test(sizeText), 'ar header 无效');
    const size = Number(sizeText), start = offset + 60;
    dependencyCheck(Number.isSafeInteger(size) && start + size <= bytes.length, 'ar member 截断');
    let object = bytes.subarray(start, start + size), actualName = name;
    if (name.startsWith('#1/')) {
      const length = Number(name.slice(3));
      dependencyCheck(Number.isSafeInteger(length) && length > 0 && length <= object.length, 'BSD ar 名称无效');
      actualName = object.subarray(0, length).toString().replace(/\0+$/, '');
      object = object.subarray(length);
    }
    if (name === '//') {
      dependencyCheck(gnuNames === null && object.length > 0, 'GNU ar 长名称表无效');
      gnuNames = object;
    } else if (/^\/\d+$/.test(name)) {
      const nameOffset = Number(name.slice(1));
      dependencyCheck(gnuNames && Number.isSafeInteger(nameOffset) && nameOffset >= 0
        && nameOffset < gnuNames.length
        && (nameOffset === 0 || (gnuNames[nameOffset - 2] === 47 && gnuNames[nameOffset - 1] === 10)),
      'GNU ar 长名称偏移无效');
      const end = gnuNames.indexOf(Buffer.from('/\n'), nameOffset);
      dependencyCheck(end > nameOffset, 'GNU ar 长名称未终止');
      actualName = gnuNames.subarray(nameOffset, end).toString();
      dependencyCheck(/^[A-Za-z0-9_.+@-]+$/.test(actualName), 'GNU ar 长名称字符无效');
    }
    if (!['/', '//', '/SYM64/', '__.SYMDEF', '__.SYMDEF SORTED'].includes(actualName)) {
      // 归档成员名只用于失败诊断；限制为短 ASCII，避免第三方归档把控制字符写入 CI 日志。
      const diagnosticName = /^[\x20-\x7e]{1,80}$/.test(actualName) ? actualName : '<invalid-name>';
      if (actualName === 'libcrypto.a/') {
        // OpenSSL 的正式静态输出可能用一个同名成员封装内部归档；只接受这一层精确名称，
        // 并递归验证其中每个 ELF 对象，不能把嵌套归档当作任意非对象成员跳过。
        dependencyCheck(platform !== 'Windows' && !nested, 'libcrypto 静态归档嵌套层级无效');
        dependencyCheck(object.length >= 8 && object.subarray(0, 8).toString() === '!<arch>\n',
          `libcrypto 静态归档成员不是完整归档：${diagnosticName}`);
        assertCitizenSdkStaticArchive(object, platform, true);
      } else if (platform === 'Windows') {
        dependencyCheck(object.length >= 20 && object.readUInt16LE(0) === 0x8664
          && object.readUInt16LE(2) > 0 && object.readUInt16LE(16) === 0, '非 Windows MSVC 静态对象');
        const count = object.readUInt16LE(2), tableEnd = 20 + count * 40;
        dependencyCheck(tableEnd <= object.length, 'COFF section table 截断');
        for (let section = 0; section < count; section += 1) {
          const at = 20 + section * 40, size = object.readUInt32LE(at + 16), pointer = object.readUInt32LE(at + 20);
          // 未初始化数据没有文件 payload；其余 section 必须完整位于成员内部。
          if (size && pointer) dependencyCheck(pointer >= tableEnd && pointer + size <= object.length, 'COFF section 越界');
          else dependencyCheck(!size || (object.readUInt32LE(at + 36) & 0x80) !== 0, 'COFF section 缺少内容');
        }
      } else {
        dependencyCheck(object.length >= 64 && object.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
          && object[4] === 2 && object[5] === 1 && object.readUInt16LE(16) === 1
          && object.readUInt16LE(18) === (platform === 'LinuxARM' ? 183 : 62),
        `非目标 Linux ELF relocatable 对象：${diagnosticName}`);
        const table = Number(object.readBigUInt64LE(40)), count = object.readUInt16LE(60);
        dependencyCheck(object.readUInt16LE(52) === 64 && object.readUInt16LE(58) === 64
          && Number.isSafeInteger(table) && table >= 64 && count > 0
          && table + count * 64 <= object.length, 'ELF section table 无效');
        for (let section = 0; section < count; section += 1) {
          const at = table + section * 64, type = object.readUInt32LE(at + 4);
          const pointer = Number(object.readBigUInt64LE(at + 24)), size = Number(object.readBigUInt64LE(at + 32));
          if (type !== 8) dependencyCheck(Number.isSafeInteger(pointer) && Number.isSafeInteger(size)
            && pointer + size <= object.length, 'ELF section 越界');
        }
      }
      objects += 1;
    }
    offset = start + size;
    if (offset % 2) {
      dependencyCheck(offset < bytes.length && bytes[offset] === 10, 'ar alignment 无效');
      offset += 1;
    }
  }
  dependencyCheck(objects > 0, '静态归档没有对象');
}

function dependencyArchives(platform) {
  return platform === 'Windows' ? ['lib/sqlite3.lib']
    : ['lib/libsqlite3.a', 'lib/libcrypto.a',
      ...['esys', 'mu', 'sys', 'rc', 'tcti-device'].map((name) => 'lib/libtss2-' + name + '.a')].sort();
}
function assertDependencyReceipt(receipt, platform) {
  dependencyCheck(receipt && stableJson(Object.keys(receipt).sort()) === stableJson(
    ['schema', 'platform', 'source_sha', 'software_version', 'build_mode', 'native_dependencies', 'build_tools', 'files'].sort()),
  '准备收据字段闭集无效');
  dependencyCheck(NATIVE_DEPENDENCY_PLATFORMS.includes(platform) && receipt.platform === platform
    && receipt.schema === 1 && /^[0-9a-f]{40}$/.test(receipt.source_sha)
    && /^\d+\.\d+\.\d+$/.test(receipt.software_version) && ['ci', 'release'].includes(receipt.build_mode),
  '收据平台/身份/模式无效');
  assertCitizenSdkNativeContract(receipt.native_dependencies);
  const tools = platform === 'Windows' ? ['cl', 'lib', 'tar'] : ['cc', 'ar', 'perl', 'make', 'sh', 'pkg-config', 'tar', 'unzip'];
  dependencyCheck(Array.isArray(receipt.build_tools)
    && stableJson(receipt.build_tools.map((tool) => tool.name).sort()) === stableJson(tools.sort()),
  '工具链闭集无效');
  for (const tool of receipt.build_tools) {
    dependencyCheck(/^[0-9a-f]{64}$/.test(tool.sha256)
      && stableJson(Object.keys(tool).sort()) === stableJson((tool.name === 'cc'
        ? ['name', 'sha256', 'target'] : ['name', 'sha256']).sort()), '工具身份无效');
    if (tool.name === 'cc') dependencyCheck(typeof tool.target === 'string'
      && tool.target.startsWith(platform === 'LinuxARM' ? 'aarch64-' : 'x86_64-')
      && tool.target.endsWith('linux-gnu'), '编译器目标无效');
  }
  dependencyCheck(Array.isArray(receipt.files) && receipt.files.length > 0 && receipt.files.length <= 256,
    '输入文件列表无效');
  const paths = receipt.files.map((entry) => {
    dependencyCheck(entry && Object.keys(entry).sort().join(',') === 'path,sha256'
      && typeof entry.path === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(entry.path)
      && !entry.path.split('/').includes('..') && !entry.path.startsWith('/')
      && /^[0-9a-f]{64}$/.test(entry.sha256), '输入条目无效');
    return entry.path;
  });
  const archives = dependencyArchives(platform);
  const expected = ['include/sqlite3.h', ...archives,
    ...(platform === 'Windows' ? [] : [...TSS2_HEADERS,
      ...OPENSSL_DEPENDENCY_HEADERS.map((name) => 'include/openssl/' + name)])].sort();
  dependencyCheck(stableJson(paths) === stableJson(expected), '输入头文件/静态库闭集不符');
  return receipt;
}

/** 收据不可单独代替静态库：每个实际头/库都重新哈希，并核对所有对象的机器身份。 */
function assertCitizenSdkDependencyInputs(receiptPath, platform) {
  const path = assertSafeTargetPath(receiptPath, '静态依赖证据');
  const prefix = dirname(path);
  const receipt = assertDependencyReceipt(JSON.parse(readFileSync(nativeArtifactSource(prefix, 'native-dependencies.json'), 'utf8')), platform);
  dependencyCheck(path === join(prefix, 'native-dependencies.json'), '收据文件名不符');
  const actual = treeEntries(prefix).files;
  dependencyCheck(stableJson(actual) === stableJson([...receipt.files.map((entry) => entry.path), 'native-dependencies.json'].sort()),
    '实际输入含未登记文件');
  for (const entry of receipt.files) {
    const input = nativeArtifactSource(prefix, entry.path);
    dependencyCheck(sha256File(input) === entry.sha256, '实际输入摘要不符：' + entry.path);
    if (dependencyArchives(platform).includes(entry.path)) assertCitizenSdkStaticArchive(readFileSync(input), platform);
  }
  return receipt;
}

/** 保持现有显式环境入口，仅从已经验证的同一前缀取得所有头/库，拒绝混用外部路径。 */
function citizenSdkDependencyEnvironment(receiptPath, platform) {
  assertCitizenSdkDependencyInputs(receiptPath, platform);
  const prefix = dirname(resolve(receiptPath)), at = (path) => join(prefix, path);
  if (platform === 'Windows') return {
    CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR: at('include'),
    CITIZENSDK_WINDOWS_SQLITE_ARCHIVE: at('lib/sqlite3.lib'),
  };
  return {
    CITIZENSDK_HOST_SQLITE_INCLUDE_DIR: at('include'),
    CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR: at('include'),
    CITIZENSDK_HOST_TSS2_INCLUDE_DIR: at('include'),
    CITIZENSDK_HOST_SQLITE_ARCHIVE: at('lib/libsqlite3.a'),
    CITIZENSDK_HOST_CRYPTO_ARCHIVE: at('lib/libcrypto.a'),
    ...Object.fromEntries(['esys', 'mu', 'sys', 'rc', 'tcti-device'].map((name) =>
      ['CITIZENSDK_HOST_TSS2_' + name.replaceAll('-', '_').toUpperCase() + '_ARCHIVE', at('lib/libtss2-' + name + '.a')])),
  };
}

function dependencyLinkedPaths(platform, layout) {
  const paths = platform === 'Windows'
    ? ['bin/Windows/citizensdk.dll', 'bin/Windows/citizensdk_host.dll']
    : ['lib/' + platform + '/libcitizensdk.so', 'lib/' + platform + '/libcitizensdk_host.so'];
  return paths.map((path) => layout === 'candidate' ? (platform === 'Windows' ? 'windows/' : 'linux/') + path
    : layout === 'native' ? (platform === 'Windows' ? 'Windows/' : 'linux/' + platform + '/') + path : path);
}

/** 只有原生门禁和消费者全部成功后，构建器才绑定该批输入与导出的最终运行库。 */
function writeCitizenSdkDependencyEvidence({ receiptPath, platform, nativePath, sourcePath, sourceSha }) {
  const receipt = assertCitizenSdkDependencyInputs(receiptPath, platform);
  dependencyCheck(receipt.source_sha === sourceSha, '构建提交与准备提交不同');
  const source = resolve(sourcePath), native = assertSafeTargetPath(nativePath, '原生产物目录');
  assertLicenseSources(source);
  dependencyCheck(readFileSync(join(source, 'pubspec.yaml'), 'utf8').includes('\nversion: ' + receipt.software_version + '\n'),
    '构建版本与准备版本不同');
  const paths = dependencyLinkedPaths(platform, 'native');
  const linked_artifacts = paths.map((path, index) => ({
    path: dependencyLinkedPaths(platform, 'candidate')[index],
    sha256: sha256File(nativeArtifactSource(native, path)),
  }));
  const evidence = { dependency_inputs: receipt, linked_artifacts,
    files: ['LICENSE'].map((path) => ({ path, sha256: sha256File(join(source, path)) })) };
  const directory = join(native, 'dependencies');
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  nativeArtifactSource(native, 'dependencies', 'directory');
  writeFileSync(join(directory, platform + '.json'), prettyStableJson(evidence), { flag: 'wx', mode: 0o600 });
  return evidence;
}



const OPENSSL_DEPENDENCY_HEADERS = [
  "aes.h",
  "asn1.h",
  "asn1err.h",
  "asn1t.h",
  "async.h",
  "asyncerr.h",
  "bio.h",
  "bioerr.h",
  "blowfish.h",
  "bn.h",
  "bnerr.h",
  "buffer.h",
  "buffererr.h",
  "byteorder.h",
  "camellia.h",
  "cast.h",
  "cmac.h",
  "cmp.h",
  "cmp_util.h",
  "cmperr.h",
  "cms.h",
  "cmserr.h",
  "comp.h",
  "comperr.h",
  "conf.h",
  "conf_api.h",
  "conferr.h",
  "configuration.h",
  "conftypes.h",
  "core.h",
  "core_dispatch.h",
  "core_names.h",
  "core_object.h",
  "crmf.h",
  "crmferr.h",
  "crypto.h",
  "cryptoerr.h",
  "cryptoerr_legacy.h",
  "ct.h",
  "cterr.h",
  "decoder.h",
  "decodererr.h",
  "des.h",
  "dh.h",
  "dherr.h",
  "dsa.h",
  "dsaerr.h",
  "dtls1.h",
  "e_os2.h",
  "e_ostime.h",
  "ebcdic.h",
  "ec.h",
  "ecdh.h",
  "ecdsa.h",
  "ecerr.h",
  "encoder.h",
  "encodererr.h",
  "engine.h",
  "engineerr.h",
  "err.h",
  "ess.h",
  "esserr.h",
  "evp.h",
  "evperr.h",
  "fips_names.h",
  "fipskey.h",
  "hmac.h",
  "hpke.h",
  "http.h",
  "httperr.h",
  "idea.h",
  "indicator.h",
  "kdf.h",
  "kdferr.h",
  "lhash.h",
  "macros.h",
  "md2.h",
  "md4.h",
  "md5.h",
  "mdc2.h",
  "ml_kem.h",
  "modes.h",
  "obj_mac.h",
  "objects.h",
  "objectserr.h",
  "ocsp.h",
  "ocsperr.h",
  "opensslconf.h",
  "opensslv.h",
  "ossl_typ.h",
  "param_build.h",
  "params.h",
  "pem.h",
  "pem2.h",
  "pemerr.h",
  "pkcs12.h",
  "pkcs12err.h",
  "pkcs7.h",
  "pkcs7err.h",
  "prov_ssl.h",
  "proverr.h",
  "provider.h",
  "quic.h",
  "rand.h",
  "randerr.h",
  "rc2.h",
  "rc4.h",
  "rc5.h",
  "ripemd.h",
  "rsa.h",
  "rsaerr.h",
  "safestack.h",
  "seed.h",
  "self_test.h",
  "sha.h",
  "srp.h",
  "srtp.h",
  "ssl.h",
  "ssl2.h",
  "ssl3.h",
  "sslerr.h",
  "sslerr_legacy.h",
  "stack.h",
  "store.h",
  "storeerr.h",
  "symhacks.h",
  "thread.h",
  "tls1.h",
  "trace.h",
  "ts.h",
  "tserr.h",
  "txt_db.h",
  "types.h",
  "ui.h",
  "uierr.h",
  "whrlpool.h",
  "x509.h",
  "x509_acert.h",
  "x509_vfy.h",
  "x509err.h",
  "x509v3.h",
  "x509v3err.h"
];





/** Verify the Android AAR and Flutter projection are the same two native bytes. */


/** Parse the small XML-plist subset emitted for framework metadata. */



/** Read the thin arm64 Mach-O identity and external defined symbol table. */

// 显式私钥receiver已归公开Core头；不再保留仅供SDK窗口的私有导出。
const CITIZENSDK_INTERNAL_SYMBOLS = Object.freeze([]);

/** 构建期内部模块仍复用公开Core头及独立二维码图像头，不复制公开类型声明。 */
function citizenSdkInternalHeader() {
  return `#ifndef CITIZENSDK_INTERNAL_H
#define CITIZENSDK_INTERNAL_H
#include "citizensdk.h"
#endif
`;
}

function expectedCitizenSdkSymbols(root) {
  const header = readFileSync(join(root, 'include', 'citizensdk.h'), 'utf8');
  const symbols = [...new Set(
    [...header.matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g)].map((match) => match[1]),
  )].sort();
  if (symbols.length !== 144) fail('CitizenSDK 产品头必须精确声明 144 个 citizensdk_* 函数');
  return symbols;
}

function expectedQrImageSymbols(root) {
  const header = readFileSync(join(root, 'native/image/citizensdk_qr_image.h'), 'utf8');
  const symbols = [...new Set(
    [...header.matchAll(/\b(citizensdk_qr_image_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]),
  )].sort();
  if (symbols.length !== 4) fail('CitizenSDK QR 图像头必须精确声明 4 个函数');
  return symbols;
}


function expectedCitizenSdkLinkedSymbols(root) {
  return [...expectedCitizenSdkSymbols(root), ...CITIZENSDK_INTERNAL_SYMBOLS].sort();
}


/** Verify one Apple product whose public platforms are exactly iOS and macOS. */






return {CITIZENSDK_INTERNAL_SYMBOLS,citizenSdkInternalHeader,createNativeSourceView,createFlutterSourceView,assertFlutterSourceView,projectFlutterSourceEntry,assertCitizenSdkDependencyInputs,citizenSdkDependencyEnvironment,writeCitizenSdkDependencyEvidence,copyWindowsNativeArtifact,assertWindowsReleaseProjection,assertWindowsFlutterBundle,assertHostedRuntimeWindowsProjection};
})();

export const {CITIZENSDK_INTERNAL_SYMBOLS,citizenSdkInternalHeader,createNativeSourceView,createFlutterSourceView,assertFlutterSourceView,projectFlutterSourceEntry,assertCitizenSdkDependencyInputs,citizenSdkDependencyEnvironment,writeCitizenSdkDependencyEvidence,copyWindowsNativeArtifact,assertWindowsReleaseProjection,assertWindowsFlutterBundle,assertHostedRuntimeWindowsProjection}=compileProjection;

if(process.env.NODE_TEST_CONTEXT&&process.argv.length===2&&process.argv[1]===import.meta.filename){
 const {test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
 test('SDK平台编译现场独立领取并在结束后删除',async()=>{
  const work=fixedWork('build/sdk');assert.throws(()=>checkWork(fixedWork('build')),/固定目录/);
  await withFixedWork('build/sdk',async owned=>{assert.equal(owned,work);writeFileSync(join(owned,'fixture'),'sdk');});
  assert.equal(existsSync(work),false);
 });
}

// CLI拒绝必须真实失败，不能留成未完成顶层await或输出成功回执。
if(!(process.env.NODE_TEST_CONTEXT&&process.argv.length===2)&&!process.execArgv.some(value=>/^(?:-e|--eval(?:=|$)|--input-type(?:=|$))/u.test(value)) && process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 void runCLI().catch(error=>{console.error(error);process.exitCode=1;});
}
