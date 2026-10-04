#!/usr/bin/env bash
# CitizenSDK唯一本地测试入口；源码只读，所有测试生成物写入产品外部工作目录。
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
  link_target="$(readlink "$script_path")"
  [[ "$link_target" == /* ]] || link_target="$(cd "$(dirname "$script_path")" && pwd -P)/$link_target"
  script_path="$link_target"
done
script_dir="$(cd "$(dirname "$script_path")" && pwd -P)"
sdk_dir="$(dirname "$script_dir")"
test_root="${CITIZENSDK_TEST_WORK_DIR:-${TMPDIR:-/tmp}/citizensdk/test}"
test_smoldot_library="${CITIZENSDK_TEST_SMOLDOT_LIBRARY:-}"

flutter_bin="${FLUTTER:-$(command -v flutter || true)}"
cargo_bin="${CARGO:-$(command -v cargo || true)}"
node_bin="${NODE:-$(command -v node || true)}"
[[ -n "$node_bin" && -x "$node_bin" ]] \
  || { echo 'CitizenSDK 测试缺少 Node' >&2; exit 1; }

# 首次写入前按真实祖先解析路径；拒绝源码、源码祖先及内部输出符号链接。
# 只校验调用方给定目录，不识别目录来源，也不清理其它任务或依赖原件。
test_root="$("$node_bin" - "$sdk_dir" "$test_root" <<'CHECK_OUTPUTS'
const fs = require('node:fs');
const path = require('node:path');
const [sourceInput, input] = process.argv.slice(2);
const source = fs.realpathSync(sourceInput);
if (!path.isAbsolute(input) || input.split(path.sep).some(part => part === '.' || part === '..')) {
  throw new Error('CitizenSDK测试缓存必须是无相对片段的绝对目录');
}
let ancestor = path.resolve(input);
const suffix = [];
while (!fs.existsSync(ancestor)) {
  if (fs.lstatSync(ancestor, { throwIfNoEntry: false })) throw new Error('测试目录存在悬空链接');
  suffix.unshift(path.basename(ancestor));
  ancestor = path.dirname(ancestor);
}
if (!fs.statSync(ancestor).isDirectory()) throw new Error('测试目录祖先不是目录');
const target = path.join(fs.realpathSync(ancestor), ...suffix);
if (target === path.parse(target).root || target === source ||
    target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
  throw new Error('CitizenSDK测试缓存禁止位于产品源码或其祖先');
}
for (const name of ['cargo', 'flutter', 'flutter-config', 'release-tmp', 'release-work']) {
  const child = path.join(target, name);
  const stat = fs.lstatSync(child, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('测试输出必须是独立普通目录');
}
process.stdout.write(target);
CHECK_OUTPUTS
)" || exit 1

assert_read_only_source() {
  local name
  for name in .dart_tool build target android/.kotlin; do
    [[ ! -e "$sdk_dir/$name" && ! -L "$sdk_dir/$name" ]] \
      || { echo "CitizenSDK 源码树已存在禁止的生成条目：$name" >&2; return 1; }
  done
}
assert_read_only_source || exit 1
mkdir -p "$test_root/cargo" "$test_root/flutter" "$test_root/flutter-config" "$test_root/release-tmp"
export CARGO_TARGET_DIR="$test_root/cargo"
export XDG_CONFIG_HOME="$test_root/flutter-config"

configure_flutter_output() {
  [[ -n "$flutter_bin" && -x "$flutter_bin" ]] \
    || { echo 'CitizenSDK 测试缺少 Flutter' >&2; return 1; }
  "$flutter_bin" config \
    --build-dir=build \
    --no-enable-native-assets \
    --no-enable-dart-data-assets >/dev/null
}

refresh_flutter_packages() {
  local project_root="$1" flutter_sdk_root dart_bin
  [[ -n "$flutter_bin" && -x "$flutter_bin" ]] \
    || { echo 'CitizenSDK 测试缺少 Flutter' >&2; return 1; }
  flutter_sdk_root="$(cd "$(dirname "$flutter_bin")/.." && pwd -P)"
  dart_bin="$flutter_sdk_root/bin/dart"
  [[ -x "$dart_bin" ]] \
    || { echo 'CitizenSDK 测试缺少 Flutter 同版 Dart' >&2; return 1; }
  local -a pub_get_args=(--enforce-lockfile)
  case "${CITIZENSDK_OFFLINE:-false}" in
    true) pub_get_args+=(--offline) ;;
    false) ;;
    *) echo 'CitizenSDK测试的CITIZENSDK_OFFLINE只接受true或false' >&2; return 1 ;;
  esac
  (cd "$project_root" && FLUTTER_ROOT="$flutter_sdk_root" \
    "$dart_bin" pub get "${pub_get_args[@]}")
}

prepare_flutter_project() {
  local project_root="$1"
  [[ -d "$project_root" && ! -L "$project_root" ]] \
    || { echo 'CitizenSDK Flutter 隔离测试根无效' >&2; return 1; }
  # mktemp只分配独占名称；视图接口要求目标不存在，避免复用旧状态。
  rmdir -- "$project_root" || return 1
  "$node_bin" "$sdk_dir/scripts/release.mjs" \
    --flutter-source-view "$sdk_dir" --output "$project_root" >/dev/null || return 1
  if [[ -n "$test_smoldot_library" ]]; then
    [[ "$test_smoldot_library" == /* && -f "$test_smoldot_library" && ! -L "$test_smoldot_library" ]] \
      || { echo 'CitizenSDK Flutter 测试 smoldot 宿主库必须是绝对普通文件' >&2; return 1; }
    case "$test_smoldot_library" in
      "$sdk_dir"/*) echo 'CitizenSDK Flutter 测试 smoldot 宿主库禁止位于源码树' >&2; return 1 ;;
    esac
    case "$(uname -s)" in
      Darwin) ln -s "$test_smoldot_library" "$project_root/libsmoldot.dylib" || return 1 ;;
      Linux) ln -s "$test_smoldot_library" "$project_root/libsmoldot.so" || return 1 ;;
      *) echo 'CitizenSDK Flutter 测试 smoldot 宿主库仅支持 macOS/Linux' >&2; return 1 ;;
    esac
  fi
  # Pub随后在此工程创建唯一.dart_tool；不读取或复制产品根的工具状态。
  [[ -f "$project_root/pubspec.yaml" && -f "$project_root/pubspec.lock" ]] \
    || { echo 'CitizenSDK测试视图缺少产品依赖声明或锁文件' >&2; return 1; }
}

cleanup_flutter_project() {
  local project_root="$1"
  case "$project_root/" in
    "$test_root/"flutter-project.*'/') ;;
    *) echo 'CitizenSDK Flutter 隔离测试根越界，拒绝清理' >&2; return 1 ;;
  esac
  [[ -d "$project_root" && ! -L "$project_root" ]] \
    || { echo 'CitizenSDK Flutter 隔离测试根不是普通目录' >&2; return 1; }
  rm -rf -- "$project_root"
}

run_flutter() {
  for argument in "$@"; do
    case "$argument" in
      --test-assets|--test-assets=*)
        echo 'CitizenSDK Flutter 测试禁止启用会写入源码 build 的 test assets' >&2
        return 2
        ;;
    esac
  done
  assert_read_only_source || return 1
  local project_root status=0
  project_root="$(mktemp -d "$test_root/flutter-project.XXXXXX")" || return 1
  prepare_flutter_project "$project_root" || status=$?
  if [[ "$status" == 0 ]]; then refresh_flutter_packages "$project_root" || status=$?; fi
  if [[ "$status" == 0 ]]; then configure_flutter_output || status=$?; fi
  if [[ "$status" == 0 ]]; then
    (cd "$project_root" && "$flutter_bin" test --no-pub --no-test-assets \
      --packages="$project_root/.dart_tool/package_config.json" "$@") || status=$?
  fi
  assert_read_only_source || status=1
  cleanup_flutter_project "$project_root" || return 1
  return "$status"
}

run_cargo() {
  [[ -n "$cargo_bin" && -x "$cargo_bin" ]] \
    || { echo 'CitizenSDK 测试缺少 Cargo' >&2; exit 1; }
  local project_root="$test_root/native-source"
  "$node_bin" "$sdk_dir/scripts/release.mjs" \
    --native-source-view "$sdk_dir" --output "$project_root" >/dev/null || return 1
  (cd "$project_root" && "$cargo_bin" test "$@")
}

run_release() {
  [[ -n "$node_bin" && -x "$node_bin" ]] \
    || { echo 'CitizenSDK 测试缺少 Node' >&2; exit 1; }
  (cd "$sdk_dir" && TMPDIR="$test_root/release-tmp" \
    CITIZENSDK_RELEASE_TEST_WORK_DIR="$test_root/release-work" \
    "$node_bin" --test scripts/release.test.mjs "$@")
}

case "${1:-all}" in
  cargo)
    shift
    run_cargo "$@"
    ;;
  flutter)
    shift
    run_flutter "$@"
    ;;
  release)
    shift
    run_release "$@"
    ;;
  all)
    [[ "$#" -le 1 ]] || { echo 'all 模式不接受额外参数' >&2; exit 2; }
    run_cargo --workspace --all-targets --locked
    run_flutter --timeout=2m
    run_release
    ;;
  *)
    echo '用法：scripts/test.sh [all|cargo <cargo-test参数...>|flutter <flutter-test参数...>|release <node-test参数...>]' >&2
    exit 2
    ;;
esac
