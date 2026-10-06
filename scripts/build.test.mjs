// 公开入口的独立运行、只读需求与路径/资源失败关闭合同。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {contract,requirements,resourceEnvironment,checkWork,createView} from './build.mjs';

const sandbox=()=>mkdtempSync(join(tmpdir(),contract.product_id+'-build-contract-'));
test('所有声明平台均能在无私有环境时只读提出需求',()=>{
 const work=sandbox();
 try{for(const platform of Object.keys(contract.platforms)){
  const before=readdirSync(work);const result=requirements(platform,work);
  assert.equal(result.product_id,contract.product_id);assert.equal(result.platform,platform);
  assert.equal(result.schema,1);assert.deepEqual(readdirSync(work),before);
  assert.ok(result.tools.every(value=>value.id&&value.version));
  assert.ok(result.locks.every(value=>['cargo','pub','npm'].includes(value.ecosystem)));
 }}finally{rmSync(work,{recursive:true});}
});
test('平台、源码内工作根和链接工作根均在任何写入前拒绝',()=>{
 const work=sandbox();try{
  assert.throws(()=>requirements('unknown',work),/平台/);
  assert.throws(()=>checkWork(resolve(import.meta.dirname,'..')),/源码外/);
  mkdirSync(join(work,'actual'));symlinkSync(join(work,'actual'),join(work,'linked'));
  assert.throws(()=>checkWork(join(work,'linked')),/链接/);
 }finally{rmSync(work,{recursive:true});}
});
test('资源回执绑定产品、平台和准确工作根，缺少资源不能开始编译',()=>{
 const work=sandbox(),platform=Object.keys(contract.platforms)[0];
 const receipt={schema:1,product_id:contract.product_id,platform,work,offline:true,tools:{},dependencies:{},archives:{},environment:{}};
 try{
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,product_id:'another'}),/身份/);
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,offline:false}),/身份/);
  assert.throws(()=>resourceEnvironment(platform,work,receipt),/工具/);
  assert.throws(()=>resourceEnvironment(platform,work,{...receipt,environment:{NODE_OPTIONS:'--inspect'}}),/注入/);
  assert.deepEqual(readdirSync(work),[]);
 }finally{rmSync(work,{recursive:true});}
});
test('工程视图的可写声明与源码分离，拒绝旧工程和越界链接',()=>{
 const work=sandbox();try{
  const source=join(work,'input'),output=join(work,'view');mkdirSync(source);
  const manifest=join(source,'package.json');writeFileSync(manifest,'{"name":"input"}');
  createView(source,output);writeFileSync(join(output,'package.json'),'{"name":"generated"}');
  assert.equal(readFileSync(manifest,'utf8'),'{"name":"input"}');
  assert.throws(()=>createView(source,output),/已存在/);
  symlinkSync('/etc/passwd',join(source,'outside'));
  assert.throws(()=>createView(source,join(work,'bad-view')),/越界/);
 }finally{rmSync(work,{recursive:true});}
});
