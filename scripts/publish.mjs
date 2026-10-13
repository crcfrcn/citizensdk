#!/usr/bin/env node
// 渠道发布只消费已经成功的正式 GitHub Release；分发目的地尚未登记时只提供只读验真。
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const repository='crcfrcn/citizensdk';
const api='https://api.github.com/repos/'+repository+'/';
const fail=message=>{throw Error('公民 SDK 渠道发布：'+message);};
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);

async function get(url,{send,token,raw=false}={}){
 const address=new URL(url);
 if(address.protocol!=='https:'||address.username||address.password||address.hash)fail('读取地址无效');
 const headers={Accept:raw?'application/octet-stream':'application/vnd.github+json'};
 if(token&&address.hostname==='api.github.com')headers.Authorization='Bearer '+token;
 const response=await send(address.href,{method:'GET',headers,redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(raw&&[301,302,303,307,308].includes(response.status)){
  const next=response.headers.get('location');await response.body?.cancel();
  if(!next)fail('资产重定向无效');
  return get(new URL(next,address).href,{send,raw:true});
 }
 if(!response.ok||!response.body)fail('GitHub 正式资产读取失败');
 return raw?response:response.json();
}

export async function inspectRelease(tag,{send=fetch,token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN}={}){
 const match=/^citizensdk-sdk-v([0-9]+\.[0-9]+\.[0-9]+)-r([1-9][0-9]*)-a([1-9][0-9]*)$/u.exec(tag||'');
 if(!match)fail('正式 Tag 与 SDK 身份不符');
 const runID=Number(match[2]),attempt=Number(match[3]);
 if(!Number.isSafeInteger(runID)||!Number.isSafeInteger(attempt))fail('运行编号越界');
 const [release,ref,run]=await Promise.all([
  get(api+'releases/tags/'+encodeURIComponent(tag),{send,token}),
  get(api+'git/ref/tags/'+encodeURIComponent(tag),{send,token}),
  get(api+'actions/runs/'+runID,{send,token}),
 ]);
 const sha=run?.head_sha;
 if(!/^[a-f0-9]{40}$/u.test(sha||'')||run.id!==runID||run.run_attempt!==attempt
  ||run.event!=='workflow_dispatch'||run.status!=='completed'||run.conclusion!=='success'
  ||run.head_branch!=='main'||String(run.path||'').split('@')[0]!=='.github/workflows/sdk.yml'
  ||release.tag_name!==tag||release.draft||release.prerelease||release.target_commitish!==sha
  ||ref.ref!=='refs/tags/'+tag||ref.object?.type!=='commit'||ref.object.sha!==sha)
  fail('正式 Release、Tag 与成功自动化身份不一致');
 const assets=release.assets;
 if(!Array.isArray(assets)||assets.length!==1||assets[0].name!=='citizensdk.tgz')fail('正式 SDK 必须只有一个包');
 const asset=assets[0];
 if(!Number.isSafeInteger(asset.id)||asset.id<1||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>8*1024**3
  ||asset.state!=='uploaded'||!/^sha256:[a-f0-9]{64}$/u.test(asset.digest||'')
  ||asset.url!==api+'releases/assets/'+asset.id)fail('正式包证明无效');
 const response=await get(asset.url,{send,token,raw:true}),hash=createHash('sha256');let size=0;
 for await(const part of response.body){size+=part.length;if(size>asset.size)fail('正式包超过声明大小');hash.update(part);}
 if(size!==asset.size||hash.digest('hex')!==asset.digest.slice(7))fail('正式包字节与 Release 摘要不符');
 return {product_id:'citizensdk',version:match[1],tag,source_sha:sha,run_id:runID,
  asset:{name:asset.name,size,sha256:asset.digest.slice(7)}};
}

if(direct&&!process.env.NODE_TEST_CONTEXT){
 try{
  if(process.argv.length!==4||process.argv[2]!=='inspect')fail('只读入口用法：publish.mjs inspect <正式Tag>');
  process.stdout.write(JSON.stringify(await inspectRelease(process.argv[3]))+'\n');
 }catch(error){console.error(error.message);process.exitCode=1;}
}

if(direct&&process.env.NODE_TEST_CONTEXT){
 const {default:test}=await import('node:test'),{default:assert}=await import('node:assert/strict');
 const {Readable}=await import('node:stream');
 test('渠道发布只读取成功自动化的唯一正式包并核对字节',async()=>{
  const tag='citizensdk-sdk-v1.2.3-r42-a1',sha='a'.repeat(40),body=Buffer.from('sdk');
  const release={tag_name:tag,draft:false,prerelease:false,target_commitish:sha,
   assets:[{id:9,name:'citizensdk.tgz',size:body.length,state:'uploaded',
    digest:'sha256:'+createHash('sha256').update(body).digest('hex'),url:api+'releases/assets/9'}]};
  const rows=new Map([[api+'releases/tags/'+tag,release],[api+'git/ref/tags/'+tag,
   {ref:'refs/tags/'+tag,object:{type:'commit',sha}}],[api+'actions/runs/42',
   {id:42,run_attempt:1,event:'workflow_dispatch',status:'completed',conclusion:'success',
    head_branch:'main',head_sha:sha,path:'.github/workflows/sdk.yml'}]]);
  const send=async url=>rows.has(url)?{ok:true,body:Readable.from([Buffer.from('{}')]),json:async()=>rows.get(url)}
   :url===api+'releases/assets/9'?{ok:true,body:Readable.from([body])}:assert.fail('未登记的读取地址');
  assert.equal((await inspectRelease(tag,{send})).asset.size,body.length);
  rows.get(api+'actions/runs/42').conclusion='failure';
  await assert.rejects(inspectRelease(tag,{send}),/身份不一致/u);
 });
}
