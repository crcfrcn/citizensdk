import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { testRoot as tmpdir } from '../../build.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('citizensdk.sdk.ci的android远端Job物理独立', () => {
  const source = readFileSync(new URL('./execute.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('{"pipeline":"citizensdk.sdk.ci","job":"android"}'));
  assert.match(source, /function runExactWorkflowStep\(index\)/u);
  assert.match(source, /function requireExactRemoteJobEnvironment\(\)/u);
});

// 执行真实定位管道，覆盖冷缓存联网、显式离线和锁定包身份拒绝。
test('Android证书组件定位仅在显式离线时禁止补齐锁定依赖', () => {
  const source = readFileSync(new URL('../../build-native.sh', import.meta.url), 'utf8');
  const start = source.indexOf('  verifier_maven_dir="$(cargo metadata');
  const end = source.indexOf('\n  [[ -f "$verifier_maven_dir/', start);
  assert.ok(start > 0 && end > start);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-android-metadata-')));
  const manifest = join(root, 'Cargo.toml');
  const crate = join(root, 'registry/rustls-platform-verifier-android-0.1.1/Cargo.toml');
  try {
    writeFileSync(join(root, 'cargo'), `#!${process.execPath}
const assert=require('node:assert/strict');const args=process.argv.slice(2);
assert.deepEqual(args,['metadata','--manifest-path',process.env.MANIFEST,'--format-version','1','--locked',...(process.env.EXPECT_OFFLINE==='true'?['--offline']:[])]);
if(args.includes('--offline')&&process.env.COLD_CACHE==='true')process.exit(101);
const entry={name:'rustls-platform-verifier-android',version:'0.1.1',manifest_path:process.env.CRATE};
process.stdout.write(JSON.stringify({packages:process.env.DUPLICATE==='true'?[entry,entry]:[entry]}));
`, { mode: 0o755 });
    const shell = 'set -euo pipefail\nfail(){ printf "%s\\n" "$1" >&2; exit 1; }\n' +
      'gradle_network_arg=""\nif [[ "$EXPECT_OFFLINE" == true ]]; then gradle_network_arg=--offline; fi\n' +
      'product_ffi_manifest="$MANIFEST"\n' + source.slice(start, end) + '\nprintf "%s" "$verifier_maven_dir"\n';
    for (const offline of [false, true]) {
      for (const cold of [false, true]) {
        const r = spawnSync('/bin/bash', ['-c', shell], { encoding: 'utf8', env: {
          ...process.env, PATH: root + ':' + process.env.PATH, MANIFEST: manifest, CRATE: crate,
          EXPECT_OFFLINE: String(offline), COLD_CACHE: String(cold), DUPLICATE: 'false',
        } });
        assert.equal(r.status === 0, !(offline && cold), r.stderr);
        if (r.status === 0) assert.equal(r.stdout, join(root, 'registry/rustls-platform-verifier-android-0.1.1/maven'));
      }
    }
    const rejected = spawnSync('/bin/bash', ['-c', shell], { encoding: 'utf8', env: {
      ...process.env, PATH: root + ':' + process.env.PATH, MANIFEST: manifest, CRATE: crate,
      EXPECT_OFFLINE: 'false', COLD_CACHE: 'false', DUPLICATE: 'true',
    } });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /无法定位/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
