import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { toolEnvironment } from '../../../.github/tatagate/tools.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

test('citizensdk.sdk.ci的aggregate远端Job物理独立', () => {
  const source = readFileSync(new URL('./execute.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('{"pipeline":"citizensdk.sdk.ci","job":"aggregate"}'));
  assert.match(source, /function runExactWorkflowStep\(index\)/u);
  assert.match(source, /function requireExactRemoteJobEnvironment\(\)/u);
});

// 中文说明：在不启动产品构建的合成命令函数中复核真实Bash分词；四个动作必须保持键值对和独立仓根。
test('SDK汇总命令在独立checkout根保持四个完整动作', () => {
  const source = readFileSync(new URL('./execute.mjs', import.meta.url), 'utf8');
  const marker = 'const workflowSteps = Object.freeze(';
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf(');' + String.fromCharCode(10), start);
  const steps = JSON.parse(source.slice(start, end));
  const shell = `set -euo pipefail
node() {
  [[ "$1" == "$GITHUB_WORKSPACE/scripts/ci/index.mjs" ]] || return 2
  local action="$2"; shift 2
  local count="$#"
  [[ $(( count % 2 )) == 0 ]] || return 3
  while (( $# )); do
    [[ "$1" == --* && -n "$2" ]] || return 4
    if [[ "$1" == --source ]]; then [[ "$2" == . ]] || return 5; fi
    shift 2
  done
  printf '%s:%s' "$action" "$count"
  printf '%s' '|'
}
cp() { :; }
` + steps['7'].source;
  // 执行真实汇总Shell片段，沿用门禁已验真的公开工具交付；不继承系统PATH。
  const tools = toolEnvironment();
  const output = execFileSync(tools.PRODUCT_BASH_BIN, ['--noprofile', '--norc', '-c', shell], {
    encoding: 'utf8', env: { ...tools, GITHUB_WORKSPACE: '/SDK checkout',
      CITIZENSDK_WORK_DIR: '/outside task', CITIZENSDK_SOURCE_SHA: 'a'.repeat(40),
      CITIZENSDK_VERSION: '1.2.3', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1',
      CITIZENSDK_ACTION: 'ci', CITIZENSDK_FLUTTER_ROOT: '/official flutter', PUB_CACHE: '/pub cache' },
  });
  assert.equal(output, 'aggregate-native:14|citizensdk-release:12|citizensdk-release:6|citizensdk-release:14|');
});

// 对真实JSON解码后的Node正文逐段检查，不执行编译、联网或生成原生资产。
test('SDK CI全部实际阶段的内嵌Node正文可解析且环境输出只有一份工作目录', () => {
  for (const stage of ['aggregate','android','apple','consume-android','consume-apple','consume-linuxamd','consume-linuxarm','consume-windows','linuxamd','linuxarm','windows']) {
    const source = readFileSync(new URL('../' + stage + '/execute.mjs', import.meta.url), 'utf8');
    const marker = 'const workflowSteps = Object.freeze(';
    const start = source.indexOf(marker) + marker.length;
    const end = source.indexOf('\n});', start) + 2;
    const steps = JSON.parse(source.slice(start, end));
    for (const step of Object.values(steps)) {
      const pattern = /(?:^|\n)[^\n]*\bnode\b[^\n]*<<\s*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?[^\n]*\n/gu;
      for (const match of step.source.matchAll(pattern)) {
        const begin = match.index + match[0].length;
        const ending = new RegExp('^' + match[1] + '\\s*$', 'mu').exec(step.source.slice(begin));
        assert.ok(ending, stage + ' heredoc缺少结束标记');
        const code = step.source.slice(begin, begin + ending.index);
        const result = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: code, encoding: 'utf8' });
        assert.equal(result.status, 0, stage + ': ' + result.stderr);
        assert.ok((code.match(/\bCITIZENSDK_WORK_DIR\s*:/gu) || []).length <= 1, stage + '工作目录重复');
      }
    }
  }
});
