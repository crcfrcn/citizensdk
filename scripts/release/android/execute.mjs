#!/usr/bin/env node
import { spawnSync as runExactProcess } from 'node:child_process';

function validateCandidate() {
  const value=process.env;
if(!/^[0-9a-f]{40}$/.test(value.SOURCE_SHA||'')||!/^[1-9][0-9]*$/.test(value.CI_RUN_ID||'')||!/^\d+\.\d{1,2}\.\d{1,2}$/.test(value.SOFTWARE_VERSION||'')||value.VERSION_TAG!=='citizensdk-sdk-v'+value.SOFTWARE_VERSION)throw Error('准确Release候选无效');
}

// 本文件只执行 citizensdk.sdk.release 的 android Job；阶段编号由本仓唯一 Workflow 固定，禁止接收其它身份。
export const EXACT_REMOTE_JOB_IDENTITY = Object.freeze({"pipeline":"citizensdk.sdk.release","job":"android"});

function requireExactRemoteJobEnvironment() {
  const expected = 'crcfrcn/citizensdk';
  if (!expected || process.env.GITHUB_REPOSITORY !== expected) {
    throw new Error('准确远端Job仓库身份无效');
  }
}
const workflowSteps = Object.freeze({
  "0": {
    "shell": "bash",
    "source": "test \"$(git rev-parse HEAD)\" = \"$CITIZENSDK_SOURCE_SHA\"\n"
  },
  "1": {
    "shell": "bash",
    "source": "node \"$GITHUB_WORKSPACE/scripts/release/index.mjs\" version-tag verify-release-source \\\n  --ci-run-id \"$CITIZENSDK_CI_RUN_ID\" --version-tag \"$CITIZENSDK_VERSION_TAG\" --source-sha \"$CITIZENSDK_SOURCE_SHA\" \\\n  --software-version \"$CITIZENSDK_SOFTWARE_VERSION\" --prefix citizensdk-sdk-v \\\n  --product-id citizensdk --target sdk --pipeline citizensdk.sdk.ci\n"
  },
  "2": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst e=process.env;\nconst match=/^citizensdk_(ci|release)_sdk__(android|apple|linuxarm|linuxamd|windows|aggregate|consume_(?:android|apple|linuxarm|linuxamd|windows)|finalize)$/.exec(e.CITIZENSDK_JOB);\nif(!match || (match[1]==='ci' && match[2]==='finalize')) throw Error('SDK job identity mismatch');\nconst action=match[1], stage=match[2];\nconst suffix=stage.replace(/^consume_/,'');\nconst jobs={android:['Android','linux','x64'],apple:['macOS','darwin','arm64'],\n  linuxarm:['LinuxARM','linux','arm64'],linuxamd:['LinuxAMD','linux','x64'],\n  windows:['Windows','win32','x64'],aggregate:['macOS','darwin','arm64'],finalize:['macOS','darwin','arm64']};\nconst spec=jobs[suffix];\nif(!spec || spec[0]!==e.CITIZENSDK_PLATFORM ||\n  spec[1]!==process.platform || spec[2]!==process.arch) throw Error('SDK runner/platform mismatch');\nif(!/^[0-9a-f]{40}$/.test(e.CITIZENSDK_SOURCE_SHA) ||\n  ![e.GITHUB_RUN_ID,e.GITHUB_RUN_ATTEMPT].every(x=>/^[1-9][0-9]*$/.test(x))) throw Error('SDK source/run identity missing');\nconst source=path.resolve('.');\nconst seed=fs.readFileSync(path.join(source,'pubspec.yaml'),'utf8').match(/^version: (\\d+\\.\\d+\\.\\d+)$/m)?.[1];\nconst version=action==='release'?e.CITIZENSDK_SOFTWARE_VERSION:seed;\nif(!/^\\d+\\.\\d{1,2}\\.\\d{1,2}$/.test(version||'')) throw Error('SDK version missing');\nif(version!==seed) throw Error('SDK Release version must equal frozen source');\nconst name='citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+e.CITIZENSDK_JOB+'-'+e.CITIZENSDK_SOURCE_SHA+'-'+version;\nconst parent=path.join(e.RUNNER_TEMP,'citizensdk');\nconst root=path.join(parent,name);\nif(fs.existsSync(root)) throw Error('SDK task directory already exists');\nif(action==='ci' && !e.CI_INCREMENTAL_ROOT) throw Error('SDK build state missing');\nconst buildRoot=action==='ci'?e.CI_INCREMENTAL_ROOT:path.join(root,'state');\nconst workRoot=stage.startsWith('consume_')?path.join(root,'cache'):path.join(buildRoot,'cache');\n// Windows 仍有部分工具受 MAX_PATH 约束；Flutter 原件必须放在 runner 临时目录的短路径中，\n// 同时保留 run、attempt 与平台身份，避免同一 runner 上不同作业复用或覆盖原件。\nconst flutterRoot=path.join(e.RUNNER_TEMP,'csf',e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+suffix);\nif(fs.existsSync(flutterRoot)) throw Error('SDK Flutter task directory already exists');\nfs.mkdirSync(parent,{recursive:true,mode:0o700});\nfs.mkdirSync(root,{mode:0o700});\nfs.cpSync(source,path.join(root,'source'),{recursive:true,errorOnExist:true,force:false,\n  filter:entry=>entry!==path.join(source,'.git')});\nfor(const part of ['native','tmp','transfer']) fs.mkdirSync(path.join(root,part),{mode:0o700});\nfs.mkdirSync(path.join(buildRoot,'cache'),{recursive:true,mode:0o700});\nfs.mkdirSync(workRoot,{recursive:true,mode:0o700});\nif(action==='ci') fs.mkdirSync(path.join(buildRoot,'cache','consumer'),{recursive:true,mode:0o700});\nconst values={CITIZENSDK_ACTION:action,CITIZENSDK_BUILD_ROOT:buildRoot,\n  CITIZENSDK_JOB_STAGE:stage.startsWith('consume_')?'consume':stage==='aggregate'?'aggregate':stage==='finalize'?'finalize':'native',\n  CARGO_INCREMENTAL:action==='ci'?'1':'0',CARGO_BUILD_JOBS:'2',\n  CARGO_HOME:path.join(buildRoot,'cargo-home'),\n  CARGO_TARGET_DIR:path.join(buildRoot,'cache','cargo'),CITIZENSDK_WORK_DIR:workRoot,\n  CITIZENSDK_WORK_DIR:root,CITIZENSDK_SOURCE:path.join(root,'source'),\n  CITIZENSDK_NATIVE_OUTPUT_DIR:path.join(root,'native'),CITIZENSDK_VERSION:version,\n  CITIZENSDK_PLATFORM:spec[0],CITIZENSDK_FLUTTER_ROOT:flutterRoot,\n  CITIZENSDK_ARTIFACT:name,\n  CITIZENSDK_CANDIDATE_ARTIFACT:'citizensdk-'+e.GITHUB_RUN_ID+'-'+e.GITHUB_RUN_ATTEMPT+'-'+action+'-candidate-'+e.CITIZENSDK_SOURCE_SHA+'-'+version,\n  TMPDIR:path.join(root,'tmp')};\nif(action==='ci') values.CITIZENSDK_INCREMENTAL_ROOT=path.join(buildRoot,'cache','consumer');\nfor(const [key,value] of Object.entries(values)) {\n  if(/[\\r\\n]/.test(value)) throw Error('SDK environment value is multiline');\n  fs.appendFileSync(e.GITHUB_ENV,key+'='+value+'\\n');\n}\nfs.appendFileSync(e.GITHUB_OUTPUT,'artifact='+name+'\\nroot='+root+'\\n');\nNODE\n"
  },
  "3": {
    "shell": "bash",
    "source": "node scripts/dependencies.mjs prepare-environment \\\n  --scope citizensdk --platform \"$CITIZENSDK_PLATFORM\" --work \"$CITIZENSDK_WORK_DIR/tools\"\nzxing_source=\"$CITIZENSDK_WORK_DIR/tools/zxing-cpp-3.1.1\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then zxing_source=\"$(cygpath -u \"$zxing_source\")\"; fi\ntest -d \"$zxing_source\" && test ! -L \"$zxing_source\"\nprintf 'CITIZENSDK_ZXING_SOURCE_DIR=%s\\n' \"$zxing_source\" >> \"$GITHUB_ENV\"\n"
  },
  "4": {
    "shell": "bash",
    "source": "sdkmanager \"ndk;28.2.13676358\" \"cmake;3.31.6\"\n# Runner安装入口、版本及后续逐文件验真只读受控工具真源。\ncmake_version=\"3.31.6\"\nndk_version=\"28.2.13676358\"\nnode --input-type=module - <<'NODE'\nimport {pathToFileURL} from 'node:url';\nconst {verifyCitizenSdkAndroidCmake}=await import(pathToFileURL(process.cwd()+'/citizensdk/scripts/dependencies.mjs'));\nverifyCitizenSdkAndroidCmake({tools:process.env.CITIZENSDK_WORK_DIR+'/tools',androidHome:process.env.ANDROID_HOME});\nNODE\n# 原生 Gradle 入口消费这个准确工具，不使用 runner 默认 Gradle。\ngradle_version=\"$(node -e 'const c=require(process.cwd()+\"/citizensdk/scripts/dependencies.json\");process.stdout.write(c.citizensdk.gradle.version)')\"\ntest -x \"$CITIZENSDK_WORK_DIR/tools/gradle-$gradle_version/bin/gradle\"\nprintf 'CITIZENSDK_GRADLE=%s/tools/gradle-%s/bin/gradle\\n' \"$CITIZENSDK_WORK_DIR\" \"$gradle_version\" >> \"$GITHUB_ENV\"\nprintf 'ANDROID_NDK_HOME=%s/ndk/%s\\n' \"$ANDROID_HOME\" \"$ndk_version\" >> \"$GITHUB_ENV\"\n"
  },
  "5": {
    "shell": "bash",
    "source": "# 全平台使用同一官方提交；LinuxARM 不误取仅有 LinuxAMD 的整包。\nflutter_revision=\"d3b14c876900e553bc736ca19295fc09e3853e8e\"\nflutter_version=\"3.47.2\"\nflutter_source=\"https://github.com/flutter/flutter.git\"\nflutter_root=\"$CITIZENSDK_FLUTTER_ROOT\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then flutter_root=\"$(cygpath -u \"$flutter_root\")\"; fi\ngit init \"$flutter_root\"\n# Windows Git 必须对当前独占 Flutter 原件启用长路径；不修改 runner 的系统或用户配置。\nif [[ \"$RUNNER_OS\" == Windows ]]; then git -C \"$flutter_root\" config core.longpaths true; fi\ngit -C \"$flutter_root\" fetch --depth=1 \"$flutter_source\" \\\n  \"refs/tags/$flutter_version:refs/tags/$flutter_version\"\ntest \"$(git -C \"$flutter_root\" rev-parse \"refs/tags/$flutter_version^{commit}\")\" = \"$flutter_revision\"\ngit -C \"$flutter_root\" checkout --detach \"$flutter_revision\"\nexport PATH=\"$flutter_root/bin:$PATH\"\nprintf '%s/bin\\n' \"$CITIZENSDK_FLUTTER_ROOT\" >> \"$GITHUB_PATH\"\n# Flutter 首次启动本身也会使用 Pub；在 Dart 引导之前隔离该缓存，\n# 不写 runner 用户默认缓存，也不把工具 bootstrap 混入锁包投影。\nexport PUB_CACHE=\"$CITIZENSDK_WORK_DIR/flutter-pub-cache\"\nmkdir \"$PUB_CACHE\"\n# Windows 官方 runner 的 NTFS/Git Bash 不支持可靠的 POSIX chmod 映射；\n# 目录仍位于本作业首次创建的独占根。Unix 平台继续收紧为 0700。\nif [[ \"$RUNNER_OS\" != Windows ]]; then chmod 700 \"$PUB_CACHE\"; fi\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) flutter precache --android ;;\n  macOS) flutter precache --ios --macos ;;\n  LinuxARM|LinuxAMD) flutter precache --linux ;;\n  Windows) flutter precache --windows ;;\n  *) exit 1 ;;\nesac\n# 固定 Flutter 先引导自己的 Dart；预加载不得依赖 runner PATH 中另一版 Dart。\ndart_executable=\"$flutter_root/bin/cache/dart-sdk/bin/dart\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$dart_executable.exe\"; fi\ntest -f \"$dart_executable\"\nif [[ \"$RUNNER_OS\" == Windows ]]; then dart_executable=\"$(cygpath -m \"$dart_executable\")\"; fi\nexport DART_EXECUTABLE=\"$dart_executable\"\nPUB_CACHE=\"$CITIZENSDK_WORK_DIR/dart-pub\"\nmkdir -p \"$PUB_CACHE\"\nexport PUB_CACHE\nprintf 'PUB_CACHE=%s\\n' \"$PUB_CACHE\" >> \"$GITHUB_ENV\"\n# 远端依赖由CitizenSDK自己的产品流程和锁文件决定；控制台不建立rely门禁。\n(cd \"$CITIZENSDK_SOURCE\" && flutter pub get --enforce-lockfile)\nif [[ \"$CITIZENSDK_JOB_STAGE\" == native ]]; then\n  cargo fetch --manifest-path \"$CITIZENSDK_SOURCE/Cargo.toml\" --locked\nfi\n"
  },
  "6": {
    "shell": "bash",
    "source": "# 保留上一步的独占检出与锁包准备；这里只接入同一受控修订。\nexport FLUTTER_ROOT=\"$CITIZENSDK_FLUTTER_ROOT\"\ncase \"$CITIZENSDK_PLATFORM\" in\n  Android) platform=android ;;\n  macOS) platform=sdk ;;\n  LinuxARM) platform=linux-arm ;;\n  LinuxAMD) platform=linux-amd ;;\n  Windows) platform=windows ;;\n  *) exit 1 ;;\nesac\nflutter --version >/dev/null\n"
  },
  "7": {
    "shell": "bash",
    "source": "bash \"$CITIZENSDK_SOURCE/scripts/build-native.sh\" android\nexport CITIZENSDK_ANDROID_CORE_DIR=\"$CITIZENSDK_NATIVE_OUTPUT_DIR/android/arm64-v8a\"\nexport CITIZENSDK_ANDROID_BUILD_DIR=\"$CITIZENSDK_WORK_DIR/gradle-native\"\nexport GRADLE_USER_HOME=\"$CITIZENSDK_WORK_DIR/gradle-home\"\n\"$CITIZENSDK_GRADLE\" --no-daemon -p \"$CITIZENSDK_SOURCE/android\" :native:testReleaseUnitTest\nhost=\"$CITIZENSDK_WORK_DIR/android-consumer\"\nflutter create --platforms=android --org org.citizensdk.verify --project-name citizensdk_verify \"$host\"\nflutter pub add --directory \"$host\" citizen_sdk --path \"$CITIZENSDK_SOURCE\"\nexport CITIZENSDK_ANDROID_BUILD_DIR=\"$CITIZENSDK_WORK_DIR/gradle-flutter\"\n# SDK 原生单元测试已由上面的独立 Android 工程执行；消费者工程负责验证真实 Flutter App 集成。\n(cd \"$host\" && flutter build apk --release --target-platform android-arm64 --no-pub)\n"
  },
  "8": {
    "shell": "bash",
    "source": "node --input-type=module - <<'NODE'\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nconst e=process.env, root=e.CITIZENSDK_NATIVE_OUTPUT_DIR;\nconst entries=[], expected={Android:['android'],macOS:['abi-host','apple','host'],\n  LinuxARM:['dependencies','linux'],LinuxAMD:['dependencies','linux'],Windows:['Windows','dependencies']}[e.CITIZENSDK_PLATFORM];\nif(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected.sort())) throw Error('SDK native platform set mismatch');\nfunction walk(dir) {\n  for(const name of fs.readdirSync(dir).sort()) {\n    const file=path.join(dir,name),info=fs.lstatSync(file),relative=path.relative(root,file).replaceAll('\\\\','/');\n    if(info.isDirectory()) walk(file);\n    else if(info.isFile()) entries.push({path:relative,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});\n    else if(info.isSymbolicLink() && e.CITIZENSDK_PLATFORM==='macOS') {\n      const target=fs.readlinkSync(file),resolved=path.resolve(path.dirname(file),target);\n      if(path.isAbsolute(target)||!resolved.startsWith(root+path.sep)) throw Error('SDK framework link escapes');\n      entries.push({path:relative,target});\n    } else throw Error('SDK native unsupported file');\n  }\n}\nwalk(root);\nconst proof={source_sha:e.CITIZENSDK_SOURCE_SHA,software_version:e.CITIZENSDK_VERSION,\n  run_id:e.GITHUB_RUN_ID,run_attempt:e.GITHUB_RUN_ATTEMPT,job:e.CITIZENSDK_JOB,\n  platforms:e.CITIZENSDK_PLATFORM==='macOS'?['iOS','macOS']:[e.CITIZENSDK_PLATFORM],files:entries};\nfs.writeFileSync(path.join(root,'phase0.json'),JSON.stringify(proof,null,2)+'\\n',{flag:'wx'});\nNODE\nCOPYFILE_DISABLE=1 tar --format=ustar -czf \"$CITIZENSDK_WORK_DIR/native.tgz\" -C \"$CITIZENSDK_WORK_DIR\" native\n"
  }
});
function runExactWorkflowStep(index) {
  requireExactRemoteJobEnvironment();
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(index || '')) || !Object.hasOwn(workflowSteps, String(index))) {
    throw new Error('准确远端Job阶段无效');
  }
  const step = workflowSteps[String(index)];
  const command = step.shell === 'pwsh' ? 'pwsh' : (process.platform === 'win32' ? 'bash' : '/bin/bash');
  const args = step.shell === 'pwsh'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', step.source]
    : ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.source];
  const result = runExactProcess(command, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  if (result.error) throw new Error('准确远端Job阶段无法启动');
  if (result.status !== 0) process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

requireExactRemoteJobEnvironment();
validateCandidate();
if (process.argv[2] !== 'workflow-step') throw new Error('准确Release Job只接受workflow-step');
runExactWorkflowStep(process.argv[3]);
