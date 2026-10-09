// 本产品测试使用固定根；资源夹具的内部目录不成为另一套工作根。
import fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
const scripts=import.meta.dirname;
import {fixedWork,checkFixedWork,clearFixedWork,finishFixedWork} from './target.mjs';
export function fixtureWork(){const work=checkFixedWork(fixedWork('build'),{create:true});finishFixedWork(work);return work;}
export function removeFixture(path,options={}){if(path===fixedWork('build')||path===fixedWork('test')){if(fs.existsSync(path))clearFixedWork(path);return;}fs.rmSync(path,options);}

export function writeFixture(path,data,options){
 fs.writeFileSync(path,data,options);
 if(String(path).endsWith('/scripts/build.mjs')&&String(data).includes("from './target.mjs'")){
  for(const name of ['target.mjs','target-fixtures.mjs'])fs.copyFileSync(join(scripts,name),join(dirname(path),name));
 }
}

export function copyFixture(source,destination,...options){
 fs.copyFileSync(source,destination,...options);
 if(String(destination).endsWith('/scripts/build.mjs'))for(const name of ['target.mjs','target-fixtures.mjs'])fs.copyFileSync(join(scripts,name),join(dirname(destination),name));
}
