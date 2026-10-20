// 最简入口仍必须保持SDK完整性、Cargo真实布局、原锁、缓存与版本边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {root,claimCache,createNativeSourceView,createFlutterSourceView,verifyComplete,setVersion} from '../scripts/build.mjs';
import {nextVersion,retainedRuns,sdkName,nativePaths} from '../scripts/config.mjs';
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
