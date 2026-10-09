import {lstatSync,realpathSync,readdirSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Ubuntu门禁只使用本模块所属SDK既有target/test内的独占目录；固定根由Workflow入口准备。
export function runnerWork(work, environment = process.env) {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const parent = join(source, 'target', 'test');
  const reject = () => { throw Error('本仓工具交付：门禁工具工作根必须属于本仓既有target/test且为空'); };
  if (typeof work !== 'string' || !isAbsolute(work) || resolve(work) !== work
    || environment.GITHUB_WORKSPACE !== undefined && environment.GITHUB_WORKSPACE !== source
    || !work.startsWith(parent + '/')) reject();
  for (const path of [source, join(source, 'target'), parent, work]) {
    const info = lstatSync(path, {throwIfNoEntry:false});
    if (!info?.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) reject();
  }
  if (readdirSync(work).length) reject();
  return work;
}

// 门禁工具接口由本产品唯一资源实现拥有。
import {gateToolInterfaces} from '../../scripts/resources.mjs';
export const exactExecutable=gateToolInterfaces.exactExecutable;
export const toolEnvironment=gateToolInterfaces.toolEnvironment;
export const validateToolSources=gateToolInterfaces.validateToolSources;
export const validateCurlArtifacts=gateToolInterfaces.validateCurlArtifacts;
export const validateCurlControl=gateToolInterfaces.validateCurlControl;
export const resolveBootstrapPackages=gateToolInterfaces.resolveBootstrapPackages;
export const verifyBootstrap=gateToolInterfaces.verifyBootstrap;
export const fetchOriginal=gateToolInterfaces.fetchOriginal;
export const validateCurlTar=gateToolInterfaces.validateCurlTar;
export const stageCurlArtifacts=gateToolInterfaces.stageCurlArtifacts;
export function prepareRunnerTools(options) {
  if (options?.bootstrap === true) runnerWork(options.work, options.environment || process.env);
  return gateToolInterfaces.prepareRunnerTools(options);
}
export const sourceMirrors=gateToolInterfaces.sourceMirrors;
export const requestGNUOriginal=gateToolInterfaces.requestGNUOriginal;
