// 最简入口仍必须保持SDK完整性、Cargo真实布局、原锁、缓存与版本边界。
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,readlinkSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {root,claimCache,createFlutterSourceView,verifyComplete,setVersion,appleLibraries,verifyImageSymbols,flutterChecks,waitGroup,testOptions,testReport,run,build,instrumentationReport,xctestReport,sqliteLinkEnv} from '../../scripts/build.mjs';
import {sdkName,verifyPackage,consume} from '../../scripts/build.mjs';
import {describeAction,tools,nativeSources} from '../../scripts/config.mjs';
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
test('SDK只声明唯一Workflow和原样输入，不包含执行回调',()=>{
 const inputs=Object.freeze({arbitrary:'unchanged'});
 assert.deepEqual(describeAction({flow:'release',platform:'sdk',inputs}),{repository:'crcfrcn/citizensdk',workflow:'sdk.yml',ref:'main',inputs});
 for(const args of [{flow:'cleanup',platform:'sdk'},{flow:'release',platform:'ios'}])assert.throws(()=>describeAction(args));
});
test('隔离副本直接使用标准Cargo源码，原锁和正式源码不被版本写入污染',t=>{
 const work=fixture(t),output=createFlutterSourceView(root,join(work,'project'),{flutter:false});
 for(const name of ['types','store','core','ffi','sign','qr'])for(const file of ['Cargo.toml','src/lib.rs'])assert.ok(readFileSync(join(root,name,file)).equals(readFileSync(join(output,name,file))));
 assert.equal(existsSync(join(output,'net')),false);
 assert.match(readFileSync(join(output,'ffi/Cargo.toml'),'utf8'),/smoldot-light\s*=\s*\{\s*path\s*=\s*"\.\.\/smoldot\/light-base"/u);
 assert.ok(readFileSync(join(root,'Cargo.lock')).equals(readFileSync(join(output,'Cargo.lock'))));setVersion(output,'1.2.3');assert.match(readFileSync(join(output,'pubspec.yaml'),'utf8'),/^version: 1\.2\.3$/mu);assert.doesNotMatch(readFileSync(join(root,'pubspec.yaml'),'utf8'),/^version: 1\.2\.3$/mu);assert.throws(()=>createFlutterSourceView(root,output));
});
test('自有源码目录最多三级，文件名不计入目录层级，上游与工具生成物沿用标准结构',()=>{
 const excluded=new Set(['.git','target','build','.dart_tool','.gradle','node_modules','Pods']);
 function visit(at,depth){for(const entry of readdirSync(at,{withFileTypes:true})){if(excluded.has(entry.name)||depth===0&&entry.name==='smoldot')continue;if(entry.isDirectory()){assert.ok(depth+1<=3,join(at,entry.name));visit(join(at,entry.name),depth+1);}}}
 assert.equal(existsSync(join(root,'test')),false);assert.equal(existsSync(join(root,'tests')),false);assert.ok(existsSync(join(root,'lib/test/api')));assert.ok(existsSync(join(root,'lib/test/models')));assert.ok(existsSync(join(root,'lib/test/platform')));assert.ok(existsSync(join(root,'lib/test/consumers')));
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

const SHA='a'.repeat(40);

function publicationFiles(t){
 const directory=fixture(t),source={sourceRun:1,sourceAttempt:1,sourceSha:SHA,artifactID:10,version:'1.1.1'},name=sdkName(source.version),zip=Buffer.from('仅用于完整性边界的合成字节，不是SDK产物');
 const digest=value=>createHash('sha256').update(value).digest('hex'),proof={product_id:'citizensdk',platform:'sdk',software_version:source.version,git_commit_sha:SHA,producer_run_id:1,producer_run_attempt:1,assets:[{name:name+'.zip',sha256:digest(zip)}]},json=JSON.stringify(proof);
 writeFileSync(join(directory,name+'.zip'),zip);writeFileSync(join(directory,name+'.json'),json);writeFileSync(join(directory,name+'.sha256'),digest(zip)+'  '+name+'.zip\n'+digest(json)+'  '+name+'.json\n');return {directory,source,name,proof};
}
test('本地产物完整且来源相符才允许装配；篡改、额外文件、链接、错误来源拒绝',async t=>{
 const valid=publicationFiles(t);assert.deepEqual(await verifyPackage(valid.directory,valid.source),valid.proof);
 for(const version of [undefined,'../1.0.0','01.0.0','1.0.0\n','1'.repeat(65)])await assert.rejects(verifyPackage(valid.directory,{...valid.source,version}),/产物版本无效/u);
 for(const change of ['bytes','extra','link','source','json']){const value=publicationFiles(t);
  if(change==='bytes')writeFileSync(join(value.directory,value.name+'.zip'),'changed');
  if(change==='extra')writeFileSync(join(value.directory,'extra'),'extra');
  if(change==='link'){rmSync(join(value.directory,value.name+'.zip'));symlinkSync(value.name+'.json',join(value.directory,value.name+'.zip'));}
  if(change==='source')value.source.sourceAttempt=2;if(change==='json')writeFileSync(join(value.directory,value.name+'.json'),'null');
  await assert.rejects(verifyPackage(value.directory,value.source));
 }
});

test('工作流同Run传递完整Artifact，版本与发布只归YAML',()=>{
 const workflow=readFileSync(join(root,'.github/workflows/sdk.yml'),'utf8');
 assert.match(workflow,/run-name:.*github\.run_number/u);
 assert.match(workflow,/artifact-ids: \$\{\{ needs\.complete\.outputs\.artifact \}\}/u);
 assert.match(workflow,/ref: \$\{\{ github\.sha \}\}/u);
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
 // 子进程只看到本轮代理和绝对系统命令（含原生缓存清理所需rm），不能误用宿主Rust、真实curl或启动文件。
 for(const name of ['sed','mkdir','cp','basename','tar','sh','tr','chmod','gzip','rm']){
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
 const execute=anchor=>spawnSync('/bin/bash',['--noprofile','--norc','-euo','pipefail','-c',workflowRun(anchor)],{cwd:work,env,encoding:'utf8'});
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

// 调度参数和工具报告是测试入口的失败边界，不能用默认平台或退出0掩盖。
test('测试选择要求准确设备，拒绝错平台、未知和重复参数',()=>{
 assert.deepEqual(testOptions([]),{test:true,target:undefined});
 assert.deepEqual(testOptions(['Android','--device','fixture:5555','--performance']),{test:true,target:'Android',testDevice:'fixture:5555',performance:true});
 assert.equal(testOptions(['iOS','--simulator','ABCD-1234']).simulator,'ABCD-1234');
 for(const args of [['Apple'],['Android'],['iOS'],['macOS','--device','id'],['Android','--simulator','id'],['--device','id'],['--performance','--performance'],['iOS','--simulator','--performance'],['Windows','extra'],['Android','--device','a','--device','b']])assert.throws(()=>testOptions(args));
});
test('原生报告区分通过、失败、跳过；缺失、截断、零执行和数量不符均失败',()=>{
 const xml='<testsuite tests="2"><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite>';
 assert.deepEqual(testReport([xml]),{passed:1,failed:0,skipped:1});
 for(const report of [[],[''],['<testsuite tests="0"></testsuite>'],[xml.replace('tests="2"','tests="3"')],[xml.replace('<skipped/>','<failure message="failed"/>')],[xml.replace('<testcase name="a"/>','<testcase name="a"><skipped/></testcase>')],[xml.slice(0,-12)]])assert.throws(()=>testReport(report));
});

// 真子进程边界验证取消；子孙与主工具同组，取消后不得继续写本轮现场。
test('工具失败非零；取消终止完整子进程组并等待退出后才回收现场',async t=>{
 const work=fixture(t),marker=join(work,'late');
 await assert.rejects(run(process.execPath,['-e','process.exit(7)']));
 const controller=new AbortController();
 const childCode="setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),1500);setInterval(()=>{},1000)";
 const parentCode="require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'inherit'});setInterval(()=>{},1000)";
 const timer=setTimeout(()=>controller.abort(),200);
 try { await assert.rejects(run(process.execPath,['-e',parentCode,childCode,marker],{signal:controller.signal})); }
 finally { clearTimeout(timer); }
 assert.equal(existsSync(marker),false);
});

test('嵌套JUnit不重复累加外层与内层数量，未运行状态不能记通过',()=>{
 const xml='<testsuites><testsuite tests="1"><testcase name="a"/></testsuite><testsuite tests="1"><testcase name="b" status="notrun"/></testsuite></testsuites>';
 assert.deepEqual(testReport([xml]),{passed:1,failed:0,skipped:1});
});
test('错宿主平台在构建前失败，不创建任务现场或触发工具准备',async()=>{
 for(const target of ['Windows','LinuxARM','macOS'].filter(value=>value==='Windows'?process.platform!=='win32':value==='LinuxARM'?process.platform!=='linux'||process.arch!=='arm64':process.platform!=='darwin'))await assert.rejects(build({test:true,target}),/当前宿主/u);
});

test('ADB原始报告按用例终态计数，失败、崩溃、截断、缺件与零运行不能成功',()=>{
 const report=codes=>codes.map(code=>'INSTRUMENTATION_STATUS: numtests='+codes.length+'\nINSTRUMENTATION_STATUS_CODE: '+code).join('\n')+'\nINSTRUMENTATION_CODE: -1\n';
 assert.deepEqual(instrumentationReport(report([0,0,-3,-4])),{passed:2,failed:0,skipped:2});
 for(const output of ['',report([]),report([-3]),report([0,-2]),report([0,-1]),report([0,2]),report([0]).replace('numtests=1','numtests=2'),report([0]).replace('INSTRUMENTATION_CODE: -1','INSTRUMENTATION_CODE: 0'),report([0])+'INSTRUMENTATION_RESULT: shortMsg=Process crashed'])assert.throws(()=>instrumentationReport(output));
});

test('XCTest逐项结果区分跳过，缺总数、重复、失败和零运行均失败',()=>{
 const report="Test Case 'fixture.a' passed (0.001 seconds).\nTest Case 'fixture.b' skipped (0.001 seconds).\nTest Suite 'All tests' passed at fixture\nExecuted 2 tests, with 1 test skipped and 0 failures\n";
 assert.deepEqual(xctestReport(report),{passed:1,failed:0,skipped:1});
 for(const output of ['',report.replace('Executed 2','Executed 3'),report.replace('fixture.b','fixture.a'),report.replace("'fixture.a' passed","'fixture.a' failed"),report.replace("'fixture.a' passed","'fixture.a' skipped"),report.slice(0,report.indexOf('Test Suite'))])assert.throws(()=>xctestReport(output));
});

// 原生构建被工作流作为单个JSON读取，平台报告不能进入stdout。
test('构建过程保留单个JSON标准输出，真实子工具日志归stderr',async()=>{
 const source=readFileSync(join(root,'scripts/build.mjs'),'utf8');
 const body=source.slice(0,source.indexOf("if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)"));
 assert.doesNotMatch(body,/console\.log\s*\(/u);
 const code=`import {run} from './scripts/build.mjs';await run(process.execPath,['-e','console.log("tool-log")']);console.log(JSON.stringify({work:'sdk-work',output:'sdk-output'}));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{work:'sdk-work',output:'sdk-output'});assert.match(child.stderr,/tool-log/u);
});
test('JUnit逐层验证结构及套件汇总，拒绝声明失败和错误标签',()=>{
 for(const xml of [
  '<testsuite tests="1" failures="1"><testcase name="a"/></testsuite>',
  '<testsuite tests="1"><failure message="suite failed"/><testcase name="a"/></testsuite>',
  '<testsuite tests="1" errors="1"><testcase name="a"/></testsuite>',
  '<testsuite tests="1"><testcase name="a"/></testsuites>',
  '<testsuites><testsuite tests="2"><testcase name="a"/></testsuite></testsuites>',
  '<testsuite tests="1" skipped="1"><testcase name="a"/></testsuite>',
  '<testsuite tests="1" tests="1"><testcase name="a"/></testsuite>',
  '<!DOCTYPE testsuite><testsuite tests="1"><testcase name="a"/></testsuite>',
  '<testsuite tests="1"><testcase name="a"/></testsuite><testsuite/>',
  '<testsuite tests="1"><testcase name="a"/></testsuite>trailing',
 ])assert.throws(()=>testReport([xml]),xml);
 const xml='<?xml version="1.0"?><testsuites tests="2" failures="0" errors="0"><testsuite tests="2" skipped="1"><testcase name="a"/><testcase name="b"><skipped/></testcase><system-out><![CDATA[<failure>ordinary output</failure>]]></system-out></testsuite></testsuites>';
 assert.deepEqual(testReport([xml]),{passed:1,failed:0,skipped:1});
 assert.throws(()=>testReport([xml,'<testsuite tests="0"/>']));
});
test('XCTest失败的套件总结不能被逐项通过覆盖，缺失败计数也拒绝',()=>{
 const passed="Test Case 'fixture.a' passed (0.001 seconds).\nTest Suite 'All tests' passed at fixture\nExecuted 1 tests, with 0 failures (0 unexpected)\n";
 assert.deepEqual(xctestReport(passed),{passed:1,failed:0,skipped:0});
 for(const report of [passed.replace("'All tests' passed","'All tests' failed"),passed.replace('0 failures','1 failure'),passed.replace(', with 0 failures (0 unexpected)',''),passed.replace('with 0 failures','with 1 test skipped and 0 failures')])assert.throws(()=>xctestReport(report));
});

test('Windows性能测试沿用声明SQLite归档目录，保留MSVC原LIB且不猜全局安装',()=>{
 const env={LIB:'C:\\MSVC\\lib;C:\\SDK\\lib',OTHER:'preserved'},archive='C:\\Build Cache\\sqlite3.lib';
 assert.deepEqual(sqliteLinkEnv(env,archive,'win32'),{...env,LIB:'C:\\Build Cache;'+env.LIB});
 assert.equal(sqliteLinkEnv(env,undefined,'darwin'),env);
 for(const value of [undefined,'relative/sqlite3.lib','C:\\native\\other.lib'])assert.throws(()=>sqliteLinkEnv(env,value,'win32'));
 assert.equal(env.LIB,'C:\\MSVC\\lib;C:\\SDK\\lib');
});
