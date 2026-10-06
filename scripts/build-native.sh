#!/usr/bin/env bash
# CitizenSDK 原生核心唯一构建入口。源码目录只读，Cargo 与平台产物必须写入显式的外部目录。
set -euo pipefail

# CocoaPods和Flutter缓存工程会以符号链接呈现产品脚本。源码身份必须从脚本
# 最终指向的真实文件推导，不能从缓存视图中的$0目录推导。
script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
  link_target="$(readlink "$script_path")"
  [[ "$link_target" == /* ]] || link_target="$(cd "$(dirname "$script_path")" && pwd -P)/$link_target"
  script_path="$link_target"
done
script_dir="$(cd "$(dirname "$script_path")" && pwd -P)"
sdk_dir="$(dirname "$script_dir")"
# Cargo清单由源码外工程准备完成后赋值，禁止直接编译仓库存放布局。
ffi_manifest=''
product_ffi_manifest=''
product_header="$sdk_dir/include/citizensdk.h"
product_types_header="$sdk_dir/include/citizensdk_types.h"
qr_image_source_root="$sdk_dir/native/qr-image"
qr_image_header="$qr_image_source_root/citizensdk_qr_image.h"
darwin_source_root="$sdk_dir/darwin/Sources/CitizenSDK"
darwin_flutter_source_root="$sdk_dir/darwin/Sources/CitizenSDKFlutter"
linux_source_root="$sdk_dir/linux"
windows_source_root="$sdk_dir/windows"
apple_asset_root="$sdk_dir/chain"
target_name="${1:-all}"
# 六个显式参数表示消费最终包；没有参数的原生构建仍由各平台原入口负责。
hosted_consumer=false
if [[ "$#" -gt 1 ]]; then hosted_consumer=true; fi
standalone_root="${TMPDIR:-/tmp}"
standalone_root="${standalone_root%/}/citizensdk-${UID:-0}"
: "${CITIZENSDK_WORK_DIR:=$standalone_root/work}"
: "${CITIZENSDK_NATIVE_OUTPUT_DIR:=$standalone_root/output}"
export CITIZENSDK_WORK_DIR CITIZENSDK_NATIVE_OUTPUT_DIR
ios_deployment_target=16.0
macos_deployment_target=13.0
android_ndk_version=28.2.13676358
linux_glibc_baseline=2.31

fail() {
  echo "CitizenSDK 原生构建失败：$1" >&2
  exit 1
}

# Windows 原生工具使用 drive 路径，Bash 安全目录函数使用 Git Bash POSIX 路径。
# 必须在 canonical_directory 第一次 mkdir 前检查二者指向同一非源码目录。
windows_path_preflight() {
  case "$(uname -s)" in MINGW*|MSYS*) ;; *) fail "Windows 只允许在 Windows MSVC runner 构建" ;; esac
  command -v cygpath >/dev/null 2>&1 || fail "Windows 缺少官方 Git Bash 路径转换工具"
  command -v node >/dev/null 2>&1 || fail "Windows 缺少既有构建合同使用的 Node"
  local path converted
  for path in "${CITIZENSDK_WORK_DIR:-}" "${CITIZENSDK_NATIVE_OUTPUT_DIR:-}"; do
    [[ "$path" == /* && "$path" != / ]] || fail "Windows 工作目录须使用 Git Bash 绝对路径"
    converted="$(cygpath -m "$path")"
    CITIZENSDK_PATH_CHECK="$converted" CITIZENSDK_SOURCE_CHECK="$(cygpath -m "$sdk_dir")" node -e '
      const fs=require("fs"), p=require("path").win32;
      const value=process.env.CITIZENSDK_PATH_CHECK, source=process.env.CITIZENSDK_SOURCE_CHECK;
      if (!/^[A-Za-z]:\//.test(value) || /[<>"|?*\x00-\x1f]/.test(value)) throw Error("invalid Windows drive path");
      const pieces=value.slice(3).split("/");
      if (pieces.some(x=>!x || x==="." || x===".." || /[ .:]$/.test(x) || x.includes(":") || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(x))) throw Error("unsafe Windows path component");
      const normalized=p.resolve(value).toLowerCase(), root=p.resolve(source).toLowerCase();
      if (normalized===root || normalized.startsWith(root+p.sep)) throw Error("Windows output is inside source");
      let current=value.slice(0,3);
      for (const part of pieces) {
        current=p.join(current,part);
        try { const st=fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink() || p.resolve(fs.realpathSync(current)).toLowerCase()!==p.resolve(current).toLowerCase()) throw Error("Windows path reparse or alias"); }
        catch(e) { if (e.code==="ENOENT") break; throw e; }
      }
    ' || fail "Windows 目录首次写入前预检失败"
  done
}

assert_safe_directory_path() {
  local path="$1" label="$2" component current=''
  local -a components
  [[ -n "$path" && "$path" == /* && "$path" != */ && "$path" != *//* ]] \
    || fail "$label 必须使用不含重复分隔符的绝对规范路径：${path:-<empty>}"
  IFS='/' read -r -a components <<<"$path"
  # 先验证完整词法路径，再检查既存祖先。不能在第一个不存在的目录处停止词法检查，
  # 否则 `missing/../target` 会绕过零写预检，直到平台工具检查才失败。
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    [[ "$component" != . && "$component" != .. ]] \
      || fail "$label 禁止包含 . 或 .. 路径段：$path"
  done
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="$current/$component"
    [[ ! -L "$current" ]] || fail "$label 的既存路径祖先禁止使用符号链接：$current"
    if [[ -e "$current" && ! -d "$current" ]]; then
      fail "$label 的既存路径不是目录：$current"
    fi
    [[ -e "$current" ]] || break
  done
}

canonical_directory() {
  local path="$1" label="$2"
  [[ -n "$path" ]] || fail "缺少 $label"
  assert_safe_directory_path "$path" "$label"
  mkdir -p "$path"
  (cd "$path" && pwd -P)
}

# 两个输出必须在任何 mkdir 前一起通过；这样第二个参数无效时，第一个参数也不会留下目录。
output_paths_preflight() {
  local work="${CITIZENSDK_WORK_DIR:-}" output="${CITIZENSDK_NATIVE_OUTPUT_DIR:-}" path
  for path in "$work" "$output"; do
    [[ -n "$path" ]] || fail "缺少 CitizenSDK 工作或产物目录"
    assert_safe_directory_path "$path" "CitizenSDK 输出目录"
    case "$path/" in "$sdk_dir/"*) fail "工作目录或产物目录位于 CitizenSDK 源码树：$path" ;; esac
  done
  [[ "$work" != "$output" ]] || fail "工作目录与产物目录不能相同"
  case "$work/" in "$output/"*) fail "工作目录不能位于产物目录内" ;; esac
  case "$output/" in "$work/"*) fail "产物目录不能位于工作目录内" ;; esac
}

local_build_path_is_allowed() {
  local path="$1"
  # 产品入口只禁止写入自身源码；调用方可以选择任意其它绝对输出目录，
  # 不要求安装或使用任何外部控制程序。
  case "$path/" in "$sdk_dir/"*) return 1 ;; esac
  [[ "$path" == /* && "$path" != / ]]
}

if [[ "$target_name" == Windows ]]; then windows_path_preflight; fi
output_paths_preflight

# 本机调用只要求输出位于产品源码树之外；产品入口不依赖特定调用程序。
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  for path in "${CITIZENSDK_WORK_DIR:-}" "${CITIZENSDK_NATIVE_OUTPUT_DIR:-}"; do
    assert_safe_directory_path "$path" 本机构建目录
    local_build_path_is_allowed "$path" \
      || fail "本机构建目录必须位于 CitizenSDK 源码树之外：${path:-<empty>}"
  done
fi

if [[ "$target_name" == macOS || "$hosted_consumer" == true ]]; then
  # Hosted 输入互斥检查必须早于首次写入；只接受调用方已准备的本机/Runner 受控容器。
  work_dir="${CITIZENSDK_WORK_DIR:-}"
  output_dir="${CITIZENSDK_NATIVE_OUTPUT_DIR:-}"
  for path in "$work_dir" "$output_dir"; do
    assert_safe_directory_path "$path" "macOS Hosted 受控容器"
    [[ -d "$path" && ! -L "$path" && "$(cd "$path" && pwd -P)" == "$path" ]] \
      || fail "macOS Hosted 受控容器必须已存在且没有路径别名"
  done
else
  work_dir="$(canonical_directory "${CITIZENSDK_WORK_DIR:-}" CITIZENSDK_WORK_DIR)"
  output_dir="$(canonical_directory "${CITIZENSDK_NATIVE_OUTPUT_DIR:-}" CITIZENSDK_NATIVE_OUTPUT_DIR)"
fi

# 无论本机还是CI runner，都禁止把Cargo、二进制或符号清单
# 回写到SDK源码树；除此之外，产品入口不要求调用方使用特定外部目录。
for directory in "$work_dir" "$output_dir"; do
  case "$directory/" in
    "$sdk_dir/"*) fail "工作目录或产物目录位于 CitizenSDK 源码树：$directory" ;;
  esac
  if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
    local_build_path_is_allowed "$directory" \
      || fail "本机构建真实路径必须位于 CitizenSDK 源码树之外：$directory"
  fi
done

require_rust_target() {
  local target="$1"
  local compiler="${RUSTC:-rustc}" sysroot libdir library
  # 检查实际编译器的标准库，不查询另一份rustup，更不能由产品任务下载组件。
  sysroot="$("$compiler" --print sysroot)" || fail '无法读取Rust sysroot'
  libdir="$("$compiler" --print target-libdir --target "$target")" || fail "Rust目标无效：$target"
  # Windows官方路径使用反斜线；统一分隔符后仍检查同一个真实sysroot。
  sysroot="${sysroot//\\//}"; libdir="${libdir//\\//}"
  [[ "$libdir" == "$sysroot/lib/rustlib/$target/lib" && -d "$libdir" && ! -L "$libdir" ]] \
    || fail "Rust 目标未预装：$target"
  for library in "$libdir"/libstd-*.rlib; do [[ -s "$library" && ! -L "$library" ]] && return 0; done
  fail "Rust 目标标准库缺失：$target"
}

assert_new_file() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail "目标文件已存在或是符号链接，拒绝覆盖：$1"
}

assert_descendant_path() {
  local root="$1" path="$2" label="$3"
  [[ "$path" != "$root" ]] || fail "$label 不能等于受控根目录：$path"
  case "$path/" in
    "$root/"*) ;;
    *) fail "$label 越出受控根目录 $root：$path" ;;
  esac
}

prepare_safe_directory() {
  local root="$1" path="$2" label="$3" real_path
  assert_descendant_path "$root" "$path" "$label"
  assert_safe_directory_path "$path" "$label"
  mkdir -p "$path"
  # mkdir 后必须重新逐级 lstat；这样预置的 live/dangling symlink 或非目录
  # 祖先都不能被后续 Cargo、cp、lipo 或重定向跟随到受控根之外。
  assert_safe_directory_path "$path" "$label"
  [[ -d "$path" && ! -L "$path" ]] || fail "$label 不是普通目录：$path"
  real_path="$(cd "$path" && pwd -P)"
  case "$real_path/" in
    "$root/"*) ;;
    *) fail "$label 的真实路径越出受控根目录 ${root}：$real_path" ;;
  esac
  [[ "$real_path" == "$path" ]] || fail "$label 的真实路径发生漂移：$path -> $real_path"
}

# GRADLE_USER_HOME 是调用产品提供的包管理器缓存，不是 CitizenSDK 编译物。
# 它可以位于 SDK 工作根之外，但必须是源码树之外的安全真实目录；SDK 自有
# Gradle 工程、项目缓存、Kotlin 状态和原生产物仍只能写入 work_dir。
prepare_external_cache_directory() {
  local path="$1" label="$2" real_path
  assert_safe_directory_path "$path" "$label"
  mkdir -p "$path"
  assert_safe_directory_path "$path" "$label"
  [[ -d "$path" && ! -L "$path" ]] || fail "$label 不是普通目录：$path"
  real_path="$(cd "$path" && pwd -P)"
  [[ "$real_path" == "$path" ]] || fail "$label 的真实路径发生漂移：$path -> $real_path"
  local_build_path_is_allowed "$real_path" \
    || fail "$label 必须位于 CitizenSDK 源码树之外：$real_path"
}

prepare_safe_output_file() {
  local root="$1" path="$2" label="$3" parent
  assert_descendant_path "$root" "$path" "$label"
  [[ "${path##*/}" != . && "${path##*/}" != .. ]] \
    || fail "$label 文件名无效：$path"
  assert_new_file "$path"
  parent="$(dirname "$path")"
  prepare_safe_directory "$root" "$parent" "$label 父目录"
  # 父目录创建后再 lstat 最终项，特别拒绝 `-e` 看不到的 dangling symlink。
  assert_new_file "$path"
}

assert_readonly_dependency_directory() {
  local path="$1" label="$2" real_path
  [[ -n "$path" ]] || fail "缺少 $label"
  assert_safe_directory_path "$path" "$label"
  [[ -d "$path" && ! -L "$path" ]] \
    || fail "$label 必须是既存普通目录：$path"
  real_path="$(cd "$path" && pwd -P)"
  [[ "$real_path" == "$path" ]] \
    || fail "$label 的真实路径发生漂移：$path -> $real_path"
}

assert_readonly_static_archive() {
  local path="$1" label="$2" parent real_parent
  [[ -n "$path" && "$path" == /* && "$path" == *.a ]] \
    || fail "$label 必须是绝对 .a 路径：${path:-<empty>}"
  parent="$(dirname "$path")"
  assert_safe_directory_path "$parent" "$label 父目录"
  [[ -f "$path" && ! -L "$path" ]] \
    || fail "$label 必须是既存普通静态归档：$path"
  real_parent="$(cd "$parent" && pwd -P)"
  [[ "$real_parent" == "$parent" ]] \
    || fail "$label 父目录的真实路径发生漂移：$parent -> $real_parent"
}

cargo_target_dir="$work_dir/cargo"
if [[ "$target_name" != macOS && "$hosted_consumer" != true ]]; then
  prepare_safe_directory "$work_dir" "$cargo_target_dir" "Cargo target 目录"
fi
export CARGO_TARGET_DIR="$cargo_target_dir"

symbol_list_android() {
  local library="$1" nm_bin="$2"
  {
    "$nm_bin" -D --defined-only "$library" 2>/dev/null \
      | awk '{ print $NF }' \
      | grep -E '^(smoldot_|citizen_[a-z0-9_]+|account_crypto_)' \
      | sort -u
  } || true
}

symbol_list_ios() {
  local library="$1" nm_bin="$2"
  {
    ("$nm_bin" -g --defined-only "$library" 2>/dev/null || true) \
      | awk '$2 == "T" { print $3 }' \
      | grep -E '^_(smoldot_|citizen_[a-z0-9_]+|account_crypto_)' \
      | sort -u
  } || true
}

verify_symbol_contract() {
  local symbols="$1" prefix="$2" label="$3" normalized signer_count smoldot_count
  normalized="$(printf '%s\n' "$symbols" | sed "s/^${prefix}//")"
  smoldot_count="$(printf '%s\n' "$normalized" | grep -c '^smoldot_' || true)"
  signer_count="$(printf '%s\n' "$normalized" | grep -c '^citizen_sr25519_' || true)"
  [[ "$smoldot_count" -gt 0 ]] || fail "$label 缺少 smoldot_* 轻节点符号"
  [[ "$signer_count" -eq 4 ]] || fail "$label 的 citizen_sr25519_* 符号必须正好为 4 个"
  for symbol in \
    citizen_sr25519_derive_hard \
    citizen_sr25519_public_key \
    citizen_sr25519_sign \
    citizen_sr25519_verify; do
    printf '%s\n' "$normalized" | grep -Fxq "$symbol" || fail "$label 缺少 $symbol"
  done
  if printf '%s\n' "$normalized" | grep -Eq '^(citizen_chat_mls_|account_crypto_)'; then
    fail "$label 混入聊天或产品账户密码学符号"
  fi
}

product_header_symbols() {
  perl -0777 -ne 'while (/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g) { print "$1\n" }' \
    "$product_header" | sort -u
}

# 公开144符号精确封闭，旧窗口私有符号已清零；内部模块只复用公开声明。
product_internal_symbols() {
  node --input-type=module - "$script_dir/release.mjs" <<'NODE'
import {pathToFileURL} from 'node:url';
const {CITIZENSDK_INTERNAL_SYMBOLS} = await import(pathToFileURL(process.argv[2]));
if (CITIZENSDK_INTERNAL_SYMBOLS.length) process.stdout.write(CITIZENSDK_INTERNAL_SYMBOLS.join('\n') + '\n');
NODE
}

product_linked_symbols() {
  { product_header_symbols; product_internal_symbols; } | LC_ALL=C sort -u
}

prepare_internal_header() {
  local directory="$work_dir/private-include"
  prepare_safe_directory "$work_dir" "$directory" "SDK私有声明目录"
  node --input-type=module - "$script_dir/release.mjs" "$directory" "$qr_image_header" <<'NODE'
import {pathToFileURL} from 'node:url';
import {writeFileSync, readFileSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
const {citizenSdkInternalHeader} = await import(pathToFileURL(process.argv[2]));
const qrImageHeader = readFileSync(process.argv[4], 'utf8');
// 同轮Apple各slice复用唯一声明；只接受完全相同的普通独占文件，绝不覆盖漂移。
for (const [name, text] of [
  ['citizensdk_internal.h', citizenSdkInternalHeader()],
  ['citizensdk_qr_image.h', qrImageHeader],
  ['module.modulemap', 'module CitizenSDKInternal {\n  header "citizensdk_internal.h"\n  header "citizensdk_qr_image.h"\n  export *\n}\n'],
]) {
  const path = join(process.argv[3], name);
  const info = lstatSync(path, {throwIfNoEntry: false});
  if (info) {
    if (!info.isFile() || info.nlink !== 1 || readFileSync(path, 'utf8') !== text) {
      throw Error('SDK私有构建声明漂移：' + name);
    }
  } else writeFileSync(path, text, {flag: 'wx', mode: 0o600});
}
NODE
}

product_library_symbols() {
  local library="$1" nm_bin="$2" prefix="$3"
  local raw_symbols
  if [[ -n "$prefix" ]]; then
    raw_symbols="$("$nm_bin" -g --defined-only "$library" 2>/dev/null)" \
      || fail "无法读取 CitizenSDK 产品 ABI 的 Mach-O 外部已定义符号"
  else
    raw_symbols="$("$nm_bin" -D -g --defined-only "$library" 2>/dev/null)" \
      || fail "无法读取 CitizenSDK 产品 ABI 的 ELF 动态导出符号"
  fi
  # 必须先取得完整外部已定义/动态导出集合，再统一去掉 Mach-O 的单个前导
  # 下划线。禁止先按已知前缀 grep，否则 foreign_probe 等额外全局符号会消失。
  printf '%s\n' "$raw_symbols" \
    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \
    | sed "s/^${prefix}//" \
    | LC_ALL=C sort -u
}

verify_product_abi_symbols() {
  local library="$1" nm_bin="$2" prefix="$3" label="$4"
  local actual expected forbidden
  actual="$(product_library_symbols "$library" "$nm_bin" "$prefix")"
  expected="$(product_linked_symbols)"
  # Android 证书初始化只在 Android Core 中导出；其它平台的144个公开函数不变。
  if [[ "$label" == 'Android libcitizensdk.so' ]]; then
    expected="$(printf '%s\n%s\n' "$expected" citizensdk_android_init_tls | LC_ALL=C sort -u)"
  fi
  forbidden="$(printf '%s\n' "$actual" \
    | grep -E '^(smoldot_|citizen_sr25519_|account_crypto_)' || true)"
  [[ -z "$forbidden" ]] \
    || fail "$label 泄露低层或密码学符号：$(printf '%s' "$forbidden" | tr '\n' ' ')"
  [[ "$actual" == "$expected" ]] || {
    local missing extra
    missing="$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
    extra="$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
    fail "$label 与产品头及既定内部符号闭集不一致；缺失=${missing:-无}；额外=${extra:-无}"
  }
}

jni_library_symbols() {
  local library="$1" nm_bin="$2"
  "$nm_bin" -D -g --defined-only "$library" 2>/dev/null \
    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \
    | LC_ALL=C sort -u
}

verify_jni_symbols() {
  local library="$1" nm_bin="$2" symbols
  symbols="$(jni_library_symbols "$library" "$nm_bin")" \
    || fail "无法读取 CitizenSDK Android JNI 动态导出"
  [[ "$symbols" == 'JNI_OnLoad@@CITIZENSDK_JNI_1.0' ]] \
    || fail "Android JNI 全局导出必须精确为版本化 JNI_OnLoad；实际=${symbols:-无}"
}

android_elf_dynamic_values() {
  local library="$1" readelf_bin="$2" tag="$3"
  "$readelf_bin" -d "$library" 2>/dev/null \
    | sed -n "s/.*(${tag}).*\[\([^]]*\)\].*/\1/p"
}

verify_android_elf_identity() {
  local core_library="$1" jni_library="$2" readelf_bin="$3"
  local core_soname jni_soname core_needed jni_needed core_dependency_count
  [[ -x "$readelf_bin" ]] || fail "Android NDK llvm-readelf 不可执行：$readelf_bin"
  core_soname="$(android_elf_dynamic_values "$core_library" "$readelf_bin" SONAME)"
  jni_soname="$(android_elf_dynamic_values "$jni_library" "$readelf_bin" SONAME)"
  core_needed="$(android_elf_dynamic_values "$core_library" "$readelf_bin" NEEDED)"
  jni_needed="$(android_elf_dynamic_values "$jni_library" "$readelf_bin" NEEDED)"
  [[ "$core_soname" == libcitizensdk.so ]] \
    || fail "Android Core SONAME 必须精确为 libcitizensdk.so；实际=${core_soname:-无}"
  [[ "$jni_soname" == libcitizensdk_jni.so ]] \
    || fail "Android JNI SONAME 必须精确为 libcitizensdk_jni.so；实际=${jni_soname:-无}"
  if printf '%s\n%s\n' "$core_needed" "$jni_needed" | grep -q '/'; then
    fail "Android ELF DT_NEEDED 禁止包含构建机路径"
  fi
  core_dependency_count="$(printf '%s\n' "$jni_needed" \
    | grep -Fxc libcitizensdk.so || true)"
  [[ "$core_dependency_count" == 1 ]] \
    || fail "Android JNI 必须精确依赖一次 libcitizensdk.so；实际=${core_dependency_count}"
}

linux_host_header_symbols() {
  local header="$linux_source_root/citizen_sdk/citizensdk_host.h"
  [[ -f "$header" && ! -L "$header" ]] \
    || fail "Linux Host 公共头缺失或不是普通文件：$header"
  perl -0777 -ne \
    'while (/\b(citizensdk_host_[a-z0-9_]+)\s*\(/g) { print "$1\n" }' \
    "$header" | LC_ALL=C sort -u
}

linux_elf_dynamic_values() {
  local library="$1" readelf_bin="$2" tag="$3"
  "$readelf_bin" -d "$library" 2>/dev/null \
    | sed -n "s/.*(${tag}).*\[\([^]]*\)\].*/\1/p"
}

version_is_greater() {
  local value="$1" maximum="$2"
  [[ "$value" != "$maximum" \
    && "$(printf '%s\n%s\n' "$value" "$maximum" | sort -V | tail -n 1)" == "$value" ]]
}

verify_linux_glibc_contract() {
  local library="$1" readelf_bin="$2" label="$3" versions version version_info
  local allow_cpp_runtime="${4:-false}"
  # 工具失败不能当成“没有版本需求”；先取得完整输出，再解析允许的数字版本。
  version_info="$("$readelf_bin" --version-info "$library" 2>/dev/null)" \
    || fail "无法读取 $label 的 ELF version-info"
  if printf '%s\n' "$version_info" | grep -Eq 'GLIBC_[A-Za-z]'; then
    fail "$label 包含不能按 GLIBC_$linux_glibc_baseline 验证的版本需求"
  fi
  versions="$(printf '%s\n' "$version_info" \
    | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)*' \
    | sed 's/^GLIBC_//' | sort -Vu || true)"
  while IFS= read -r version; do
    [[ -n "$version" ]] || continue
    ! version_is_greater "$version" "$linux_glibc_baseline" \
      || fail "$label 要求 GLIBC_${version}，超过固定基线 GLIBC_$linux_glibc_baseline"
  done <<<"$versions"
  if [[ "$allow_cpp_runtime" != true ]] \
      && printf '%s\n' "$version_info" | grep -Eq 'GLIBCXX_|CXXABI_'; then
    fail "$label 禁止依赖宿主 libstdc++/CXX ABI；C++ runtime 必须静态装配"
  fi
}

linux_install_files() {
  local platform="$1"
  case "$platform" in LinuxARM|LinuxAMD) ;; *) fail "未登记的 Linux 平台：$platform" ;; esac
  printf '%s\n' \
    include/citizensdk.h include/citizensdk_types.h include/citizensdk_qr_image.h \
    include/citizen_sdk/citizen_sdk.hpp \
    include/citizen_sdk/citizen_sdk_config.hpp \
    include/citizen_sdk/citizen_sdk_error.hpp \
    include/citizen_sdk/citizen_sdk_events.hpp \
    include/citizen_sdk/citizen_sdk_models.hpp \
    include/citizen_sdk/citizensdk_host.h \
    "lib/$platform/libcitizensdk.so" "lib/$platform/libcitizensdk_host.so" \
    "lib/$platform/cmake/CitizenSDK/CitizenSDKConfig.cmake" \
    "lib/$platform/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake" \
    "lib/$platform/cmake/CitizenSDK/CitizenSDKDependencies.cmake" \
    "lib/$platform/cmake/CitizenSDK/CitizenSDKTargets.cmake" \
    "lib/$platform/cmake/CitizenSDK/CitizenSDKTargets-release.cmake" \
    share/citizensdk/chain/manifest.json \
    share/citizensdk/chain/chainspec.json \
    share/citizensdk/chain/light_sync_state.json \
    | LC_ALL=C sort
}

verify_linux_install() {
  local prefix="$1" platform="$2" software_version="$3" source_core="$4"
  local readelf_bin="$5" nm_bin="$6" expected actual directories path parent package_dir
  local expected_directories='' version declarations core_symbols host_symbols
  assert_safe_directory_path "$prefix" "$platform 安装前缀"
  [[ -d "$prefix" && ! -L "$prefix" ]] || fail "$platform 安装前缀不是普通目录"
  [[ -z "$(find "$prefix" -mindepth 1 ! -type f ! -type d -print -quit)" ]] \
    || fail "$platform 安装投影禁止符号链接和特殊节点"
  expected="$(linux_install_files "$platform")"
  [[ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" == 19 ]] \
    || fail "$platform 安装文件合同必须精确为 19 项"
  actual="$(cd "$prefix" && find . -type f -print | sed 's|^./||' | LC_ALL=C sort)"
  [[ "$actual" == "$expected" ]] || fail "$platform 安装文件闭集不一致"
  while IFS= read -r path; do
    parent="$(dirname "$path")"
    while [[ "$parent" != . ]]; do
      expected_directories+="$parent"$'\n'
      parent="$(dirname "$parent")"
    done
  done <<<"$expected"
  directories="$(cd "$prefix" && find . -mindepth 1 -type d -print \
    | sed 's|^./||' | LC_ALL=C sort)"
  expected_directories="$(printf '%s' "$expected_directories" | LC_ALL=C sort -u)"
  [[ "$directories" == "$expected_directories" ]] || fail "$platform 安装目录闭集不一致"
  for path in citizensdk.h citizensdk_types.h; do
    cmp -s "$sdk_dir/include/$path" "$prefix/include/$path" \
      || fail "$platform 安装 Core 头字节漂移：$path"
  done
  cmp -s "$qr_image_header" "$prefix/include/citizensdk_qr_image.h" \
    || fail "$platform 安装统一 QR 图像头字节漂移"
  for path in citizen_sdk.hpp citizen_sdk_config.hpp citizen_sdk_error.hpp \
      citizen_sdk_events.hpp citizen_sdk_models.hpp citizensdk_host.h; do
    cmp -s "$linux_source_root/citizen_sdk/$path" "$prefix/include/citizen_sdk/$path" \
      || fail "$platform 安装 Host 头字节漂移：$path"
  done
  for path in manifest.json chainspec.json light_sync_state.json; do
    cmp -s "$apple_asset_root/$path" "$prefix/share/citizensdk/chain/$path" \
      || fail "$platform 安装链资产字节漂移：$path"
  done
  cmp -s "$source_core" "$prefix/lib/$platform/libcitizensdk.so" \
    || fail "$platform 安装 Core 字节漂移"
  package_dir="$prefix/lib/$platform/cmake/CitizenSDK"
  cmp -s "$linux_source_root/cmake/CitizenSDKDependencies.cmake" \
    "$package_dir/CitizenSDKDependencies.cmake" || fail "$platform 安装依赖合同漂移"
  version="$(sed -n 's/^set(PACKAGE_VERSION "\([^"]*\)")$/\1/p' \
    "$package_dir/CitizenSDKConfigVersion.cmake")"
  [[ "$version" == "$software_version" ]] || fail "$platform 安装版本不一致"
  declarations="$(sed -n 's/^set(_CITIZENSDK_PACKAGE_PLATFORM "\([^"]*\)")$/\1/p' \
    "$package_dir/CitizenSDKConfig.cmake")"
  [[ "$declarations" == "$platform" ]] || fail "$platform 安装平台不一致"
  # 已安装 package 必须可搬动，不能靠源码或这次构建目录找到头和运行库。
  if grep -F -e "$sdk_dir" -e "$work_dir" "$package_dir"/*.cmake >/dev/null; then
    fail "$platform 安装配置泄漏源码或构建绝对路径"
  fi
  core_symbols="$(product_header_symbols)"
  host_symbols="$(linux_host_header_symbols)"
  [[ "$(printf '%s\n' "$core_symbols" | wc -l | tr -d ' ')" == 144 \
    && "$(printf '%s\n' "$host_symbols" | wc -l | tr -d ' ')" == 19 ]] \
    || fail "$platform 公开 ABI 必须精确为 144 Core / 19 Host"
  verify_linux_elf_identity "$platform" "$prefix/lib/$platform/libcitizensdk.so" \
    "$prefix/lib/$platform/libcitizensdk_host.so" "$readelf_bin" "$nm_bin"
}

copy_linux_install() {
  local source_prefix="$1" destination_prefix="$2" platform="$3" destination_root="$4"
  local paths path source destination
  assert_safe_directory_path "$source_prefix" "$platform 安装投影来源"
  [[ -d "$source_prefix" && ! -L "$source_prefix" ]] \
    || fail "$platform 安装投影来源必须是普通目录"
  paths="$(linux_install_files "$platform")"
  assert_descendant_path "$destination_root" "$destination_prefix" "$platform 安装投影目标"
  assert_safe_directory_path "$destination_prefix" "$platform 安装投影目标"
  # 唯一19项名单同时用于外部native输入和Flutter包内投影。源码已有的
  # 七个 Host 公开头只做字节比较，绝不覆盖不同版本或复制整个未受控目录。
  # 全量预检完成后才写入，缺项或重叠漂移不会留下半份安装投影。
  while IFS= read -r path; do
    source="$source_prefix/$path"
    destination="$destination_prefix/$path"
    assert_safe_directory_path "$(dirname "$source")" "$platform 安装文件来源父目录"
    assert_safe_directory_path "$(dirname "$destination")" "$platform 安装文件目标父目录"
    [[ -f "$source" && ! -L "$source" ]] \
      || fail "$platform 安装投影缺少普通文件：$path"
    if [[ -e "$destination" || -L "$destination" ]]; then
      [[ -f "$destination" && ! -L "$destination" ]] \
        || fail "$platform 重叠安装文件类型无效：$path"
      cmp -s "$source" "$destination" \
        || fail "$platform 重叠安装文件字节漂移：$path"
    fi
  done <<<"$paths"
  prepare_safe_directory "$destination_root" "$destination_prefix" "$platform 安装投影目标"
  while IFS= read -r path; do
    source="$source_prefix/$path"
    destination="$destination_prefix/$path"
    if [[ ! -e "$destination" && ! -L "$destination" ]]; then
      prepare_safe_output_file "$destination_root" "$destination" "$platform 安装投影文件"
      cp "$source" "$destination"
    fi
  done <<<"$paths"
}

verify_linux_machine() {
  local library="$1" readelf_bin="$2" expected_machine="$3" label="$4"
  local header machine
  header="$(LC_ALL=C "$readelf_bin" -h "$library" 2>/dev/null)" \
    || fail "无法读取 $label 的 ELF header"
  printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF64' \
    || fail "$label 必须是 ELF64"
  printf '%s\n' "$header" \
    | grep -Eq 'Data:[[:space:]]+2.s complement, little endian' \
    || fail "$label 必须是 little-endian ELF"
  printf '%s\n' "$header" | grep -Eq 'Type:[[:space:]]+DYN' \
    || fail "$label 必须是 ET_DYN shared object"
  machine="$(printf '%s\n' "$header" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')"
  [[ "$machine" == "$expected_machine" ]] \
    || fail "$label 机器类型漂移：预期=${expected_machine}；实际=${machine:-无}"
}

verify_linux_host_symbols() {
  local library="$1" nm_bin="$2" label="$3" actual expected forbidden
  actual="$(product_library_symbols "$library" "$nm_bin" '')"
  expected="$({ linux_host_header_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u)"
  forbidden="$(printf '%s\n' "$actual" \
    | grep -E '^(citizensdk_|smoldot_|citizen_sr25519_|account_crypto_)' \
    | grep -Ev '^citizensdk_(host_|qr_image_)' \
    || true)"
  [[ -z "$forbidden" ]] \
    || fail "$label 重复导出 Core 或低层符号：$(printf '%s' "$forbidden" | tr '\n' ' ')"
  [[ "$actual" == "$expected" ]] || {
    local missing extra
    missing="$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
    extra="$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
    fail "$label 与 citizensdk_host.h 不一致；缺失=${missing:-无}；额外=${extra:-无}"
  }
}

verify_linux_elf_identity() {
  local platform="$1" core_library="$2" host_library="$3" readelf_bin="$4" nm_bin="$5"
  local expected_machine core_soname host_soname core_needed host_needed
  local core_rpath core_runpath host_rpath host_runpath core_dependency_count
  case "$platform" in
    LinuxARM) expected_machine=AArch64 ;;
    LinuxAMD) expected_machine='Advanced Micro Devices X86-64' ;;
    *) fail "未登记的 Linux 平台：$platform" ;;
  esac
  [[ -x "$readelf_bin" && -x "$nm_bin" ]] \
    || fail "$platform 缺少可执行 readelf/nm"
  for library in "$core_library" "$host_library"; do
    [[ -f "$library" && ! -L "$library" ]] \
      || fail "$platform 运行件必须是普通文件：$library"
  done
  verify_linux_machine "$core_library" "$readelf_bin" "$expected_machine" \
    "$platform Core"
  verify_linux_machine "$host_library" "$readelf_bin" "$expected_machine" \
    "$platform Host"
  core_soname="$(linux_elf_dynamic_values "$core_library" "$readelf_bin" SONAME)"
  host_soname="$(linux_elf_dynamic_values "$host_library" "$readelf_bin" SONAME)"
  core_needed="$(linux_elf_dynamic_values "$core_library" "$readelf_bin" NEEDED)"
  host_needed="$(linux_elf_dynamic_values "$host_library" "$readelf_bin" NEEDED)"
  core_rpath="$(linux_elf_dynamic_values "$core_library" "$readelf_bin" RPATH)"
  core_runpath="$(linux_elf_dynamic_values "$core_library" "$readelf_bin" RUNPATH)"
  host_rpath="$(linux_elf_dynamic_values "$host_library" "$readelf_bin" RPATH)"
  host_runpath="$(linux_elf_dynamic_values "$host_library" "$readelf_bin" RUNPATH)"
  [[ "$core_soname" == libcitizensdk.so ]] \
    || fail "$platform Core SONAME 漂移：${core_soname:-无}"
  [[ "$host_soname" == libcitizensdk_host.so ]] \
    || fail "$platform Host SONAME 漂移：${host_soname:-无}"
  [[ -z "$core_rpath" && -z "$core_runpath" ]] \
    || fail "$platform Core 禁止 RPATH/RUNPATH"
  [[ -z "$host_rpath" && "$host_runpath" == '$ORIGIN' ]] \
    || fail "$platform Host RUNPATH 必须精确为字面量 \$ORIGIN"
  if printf '%s\n%s\n' "$core_needed" "$host_needed" | grep -q '/'; then
    fail "$platform DT_NEEDED 禁止包含构建机路径"
  fi
  if printf '%s\n%s\n' "$core_needed" "$host_needed" \
      | grep -Eq '(^|/)(libsmoldot|libstdc\+\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)'; then
    fail "$platform 运行件泄漏禁止的动态依赖"
  fi
  core_dependency_count="$(printf '%s\n' "$host_needed" \
    | grep -Fxc libcitizensdk.so || true)"
  [[ "$core_dependency_count" == 1 ]] \
    || fail "$platform Host 必须精确依赖一次 libcitizensdk.so"
  verify_product_abi_symbols "$core_library" "$nm_bin" '' "$platform Core"
  verify_linux_host_symbols "$host_library" "$nm_bin" "$platform Host"
  verify_linux_glibc_contract "$core_library" "$readelf_bin" "$platform Core"
  verify_linux_glibc_contract "$host_library" "$readelf_bin" "$platform Host"
}

resolve_gradle() {
  local executable="${CITIZENSDK_GRADLE:-}" link_target
  if [[ -z "$executable" ]]; then
    executable="$(command -v gradle || true)"
  fi
  [[ -n "$executable" ]] \
    || fail "缺少 Gradle；请用 CITIZENSDK_GRADLE 指向受控 gradle/gradlew 绝对路径"
  [[ "$executable" == /* ]] || fail "CITIZENSDK_GRADLE 必须解析为绝对路径"
  while [[ -L "$executable" ]]; do
    link_target="$(readlink "$executable")"
    [[ "$link_target" == /* ]] || link_target="$(cd "$(dirname "$executable")" && pwd -P)/$link_target"
    executable="$link_target"
  done
  executable="$(cd "$(dirname "$executable")" && pwd -P)/$(basename "$executable")"
  [[ -f "$executable" && -x "$executable" ]] \
    || fail "Gradle必须解析到可执行普通文件：$executable"
  printf '%s\n' "$executable"
}

# Android标准assets容器与源码chain分开校验；仅允许精确三文件，逐个回读源码字节。
verify_android_chain_assets() {
  local aar="$1" entries asset actual expected
  entries="$(unzip -Z1 "$aar")" || fail "无法读取 Android AAR 链资产"
  actual="$(printf '%s\n' "$entries" | grep '^assets/' | grep -v '/$' | LC_ALL=C sort || true)"
  expected=$'assets/chain/chainspec.json\nassets/chain/light_sync_state.json\nassets/chain/manifest.json'
  [[ "$actual" == "$expected" ]] || fail "Android AAR 链资产闭集漂移"
  for asset in \
    chain/chainspec.json \
    chain/light_sync_state.json \
    chain/manifest.json; do
    printf '%s\n' "$entries" | grep -Fxq "assets/$asset" \
      || fail "Android AAR 缺少已验证链资产：$asset"
    cmp -s <(unzip -p "$aar" "assets/$asset") "$sdk_dir/$asset" \
      || fail "Android AAR 链资产与源码信任锚字节不一致：$asset"
  done
}

verify_android_aar() {
  local aar="$1" core_library="$2" jni_library="$3" nm_bin="$4"
  local entries native_entries expected_native verify_dir aar_core aar_jni classes
  local class_entries classes_payload
  command -v unzip >/dev/null 2>&1 || fail "Android AAR 核验需要 unzip"
  [[ -f "$aar" && -f "$core_library" && -f "$jni_library" ]] \
    || fail "Android AAR 或双原生库不完整"
  entries="$(unzip -Z1 "$aar")" || fail "无法读取 Android AAR 文件闭集"
  native_entries="$(printf '%s\n' "$entries" \
    | grep -E '^jni/' \
    | grep -v '/$' \
    | LC_ALL=C sort || true)"
  expected_native=$'jni/arm64-v8a/libcitizensdk.so\njni/arm64-v8a/libcitizensdk_jni.so'
  [[ "$native_entries" == "$expected_native" ]] \
    || fail "Android AAR 原生库必须精确为 arm64-v8a 双库；实际=${native_entries:-无}"
  printf '%s\n' "$entries" | grep -Fxq AndroidManifest.xml \
    || fail "Android AAR 缺少 AndroidManifest.xml"
  printf '%s\n' "$entries" | grep -Fxq classes.jar \
    || fail "Android AAR 缺少 classes.jar"
  verify_android_chain_assets "$aar"
  if printf '%s\n' "$entries" | grep -Eq '(^|/)(libsmoldot|libc\+\+_shared)\.so$|\.aar$'; then
    fail "Android AAR 混入 legacy/C++ 共享运行库或嵌套 AAR"
  fi

  verify_dir="$(mktemp -d "$work_dir/android-aar-verify.XXXXXX")" \
    || fail "无法创建 Android AAR 核验目录"
  assert_safe_directory_path "$verify_dir" "Android AAR 核验目录"
  aar_core="$verify_dir/libcitizensdk.so"
  aar_jni="$verify_dir/libcitizensdk_jni.so"
  classes="$verify_dir/classes.jar"
  classes_payload="$verify_dir/classes.payload"
  unzip -p "$aar" jni/arm64-v8a/libcitizensdk.so >"$aar_core" \
    || fail "无法提取 AAR Core 库"
  unzip -p "$aar" jni/arm64-v8a/libcitizensdk_jni.so >"$aar_jni" \
    || fail "无法提取 AAR JNI 库"
  unzip -p "$aar" classes.jar >"$classes" || fail "无法提取 AAR classes.jar"
  cmp -s "$core_library" "$aar_core" || fail "AAR 与外部 libcitizensdk.so 字节不一致"
  cmp -s "$jni_library" "$aar_jni" || fail "AAR 与外部 libcitizensdk_jni.so 字节不一致"
  verify_jni_symbols "$jni_library" "$nm_bin"
  verify_android_elf_identity \
    "$core_library" "$jni_library" "${nm_bin%/*}/llvm-readelf"
  class_entries="$(unzip -Z1 "$classes")" || fail "无法读取 AAR classes.jar 闭集"
  if printf '%s\n' "$class_entries" | grep -Eq '^io/flutter/'; then
    fail "原生 AAR classes.jar 混入 Flutter 类"
  fi
  for required_class in \
    org/citizen/sdk/CitizenSdk.class org/citizen/sdk/CitizenSigning.class org/citizen/sdk/CitizenSdkModules.class \
    org/citizen/sdk/CitizenSdkOperation.class \
    org/citizen/sdk/internal/CitizenSdkNative.class \
    org/citizen/sdk/internal/CitizenSdkHardwareVault.class; do
    printf '%s\n' "$class_entries" | grep -Fxq "$required_class" \
      || fail "原生 AAR classes.jar 缺少必需实现：$required_class"
  done
  unzip -p "$classes" >"$classes_payload" || fail "无法读取 AAR classes.jar 内容"
  if LC_ALL=C grep -a -q 'io/flutter/' "$classes_payload"; then
    fail "原生 AAR classes.jar 引用了 Flutter API"
  fi
}

android_toolchain() {
  local ndk_home="${ANDROID_NDK_HOME:-}" sdk_home host_tag expected_ndk
  if [[ -n "${ANDROID_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" \
    && "$ANDROID_HOME" != "$ANDROID_SDK_ROOT" ]]; then
    fail "ANDROID_HOME 与 ANDROID_SDK_ROOT 指向不同目录"
  fi
  sdk_home="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  if [[ -z "$ndk_home" ]]; then
    if [[ -z "$sdk_home" ]]; then
      [[ -n "${HOME:-}" ]] || fail "缺少 Android SDK 环境与 HOME"
      case "$(uname -s)" in
        Darwin) sdk_home="$HOME/Library/Android/sdk" ;;
        Linux) sdk_home="$HOME/Android/Sdk" ;;
        *) fail "当前宿主没有登记 Android SDK 标准目录：$(uname -s)" ;;
      esac
    fi
    assert_safe_directory_path "$sdk_home" "Android SDK"
    [[ -d "$sdk_home" ]] || fail "Android SDK 不存在：$sdk_home"
    sdk_home="$(cd "$sdk_home" && pwd -P)"
    ndk_home="$sdk_home/ndk/$android_ndk_version"
  else
    assert_safe_directory_path "$ndk_home" "ANDROID_NDK_HOME"
    [[ -d "$ndk_home" ]] || fail "Android NDK 不存在：$ndk_home"
    ndk_home="$(cd "$ndk_home" && pwd -P)"
    [[ "${ndk_home##*/}" == "$android_ndk_version" ]] \
      || fail "ANDROID_NDK_HOME 必须使用统一版本 $android_ndk_version"
    if [[ -n "$sdk_home" ]]; then
      assert_safe_directory_path "$sdk_home" "Android SDK"
      [[ -d "$sdk_home" ]] || fail "Android SDK 不存在：$sdk_home"
      sdk_home="$(cd "$sdk_home" && pwd -P)"
      expected_ndk="$sdk_home/ndk/$android_ndk_version"
      [[ "$ndk_home" == "$expected_ndk" ]] \
        || fail "ANDROID_NDK_HOME 不属于统一 Android SDK 与 NDK 版本"
    fi
  fi
  [[ -d "$ndk_home" ]] || fail "Android NDK 不存在：$ndk_home"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)
      host_tag=darwin-aarch64
      [[ -d "$ndk_home/toolchains/llvm/prebuilt/$host_tag" ]] || host_tag=darwin-x86_64
      ;;
    Darwin-x86_64)
      host_tag=darwin-x86_64
      [[ -d "$ndk_home/toolchains/llvm/prebuilt/$host_tag" ]] || host_tag=darwin-aarch64
      ;;
    Linux-x86_64) host_tag=linux-x86_64 ;;
    *) fail "不支持的 Android 构建宿主：$(uname -s)-$(uname -m)" ;;
  esac
  local toolchain="$ndk_home/toolchains/llvm/prebuilt/$host_tag"
  [[ -d "$toolchain" ]] || fail "Android NDK toolchain 不存在：$toolchain"
  printf '%s\n' "$toolchain"
}

# Gradle 9 要求每个 projectDir 可写。这里只生成当前任务的入口配置，
# 三个脚本及全部业务源码仍从 SDK 原目录只读加载，不复制源码工程。
prepare_android_gradle_project() {
  local android_gradle_project="$work_dir/gradle-project" relative
  prepare_safe_directory "$work_dir" "$android_gradle_project/native" "Android Gradle 任务工程"
  for relative in settings.gradle build.gradle native/build.gradle; do
    prepare_safe_output_file "$work_dir" "$android_gradle_project/$relative" "Android Gradle 任务配置"
  done
  cat >"$android_gradle_project/settings.gradle" <<'GRADLE'
apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/settings.gradle')
GRADLE
  cat >"$android_gradle_project/build.gradle" <<'GRADLE'
apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/build.gradle')
GRADLE
  cat >"$android_gradle_project/native/build.gradle" <<'GRADLE'
apply from: new File(System.getenv('CITIZENSDK_SOURCE_DIR'), 'android/native/build.gradle')
GRADLE
}

build_android() {
  prepare_internal_header
  require_rust_target aarch64-linux-android
  local toolchain gradle_bin android_build_dir gradle_project_cache gradle_user_home
  local kotlin_persistent_dir gradle_network_arg='' verifier_maven_dir verifier_link
  local android_gradle_project="$work_dir/gradle-project"
  local core_stage core_destination jni_destination aar_destination source_library
  local built_aar aar_jni nm_bin strip_bin
  toolchain="$(android_toolchain)"
  gradle_bin="$(resolve_gradle)"
  case "${CITIZENSDK_OFFLINE:-false}" in
    true) gradle_network_arg='--offline' ;;
    false) ;;
    *) fail "CITIZENSDK_OFFLINE只接受true或false" ;;
  esac
  android_build_dir="$work_dir/gradle-native"
  gradle_project_cache="$work_dir/gradle-project-cache"
  # 调用产品可以提供位于自身任务缓存中的统一 GRADLE_USER_HOME，使已下载依赖
  # 自动归入调用方依赖缓存；它不是SDK编译物，因此不要求位于SDK子工作根。
  gradle_user_home="${GRADLE_USER_HOME:-$work_dir/gradle-home}"
  kotlin_persistent_dir="$work_dir/kotlin-project-persistent"
  core_stage="$work_dir/android-core/arm64-v8a"
  core_destination="$output_dir/android/arm64-v8a/libcitizensdk.so"
  jni_destination="$output_dir/android/arm64-v8a/libcitizensdk_jni.so"
  aar_destination="$output_dir/android/citizensdk.aar"
  for directory in \
    "$android_build_dir" "$gradle_project_cache" "$kotlin_persistent_dir" "$core_stage"; do
    prepare_safe_directory "$work_dir" "$directory" "Android 外部构建目录"
  done
  if [[ -n "${GRADLE_USER_HOME:-}" ]]; then
    prepare_external_cache_directory "$gradle_user_home" "Android Gradle 依赖缓存"
  else
    prepare_safe_directory "$work_dir" "$gradle_user_home" "Android Gradle 依赖缓存"
  fi
  prepare_android_gradle_project
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$toolchain/bin/aarch64-linux-android24-clang"
  export CC_aarch64_linux_android="$toolchain/bin/aarch64-linux-android24-clang"
  export AR_aarch64_linux_android="$toolchain/bin/llvm-ar"
  CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS='-C link-arg=-Wl,-soname,libcitizensdk.so' \
    cargo build --manifest-path "$product_ffi_manifest" --release --locked \
      --target aarch64-linux-android
  source_library="$CARGO_TARGET_DIR/aarch64-linux-android/release/libcitizensdk.so"
  [[ -f "$source_library" ]] || fail "Android CitizenSDK Core 库未生成"
  prepare_safe_output_file "$work_dir" "$core_stage/libcitizensdk.so" \
    "Android Gradle Core staging"
  cp "$source_library" "$core_stage/libcitizensdk.so"
  nm_bin="$toolchain/bin/llvm-nm"
  strip_bin="$toolchain/bin/llvm-strip"
  [[ -x "$strip_bin" ]] || fail "Android NDK llvm-strip 不可执行：$strip_bin"
  # AGP 会对 Release AAR 中的 JNI 库执行 --strip-unneeded。先在受控 staging
  # 对 Core 做同一次确定性处理，再把这一个字节版本同时投影到独立双库和 AAR；
  # 否则外部 SO 与 AAR 会在打包后悄然变成两个不同产物。
  "$strip_bin" --strip-unneeded "$core_stage/libcitizensdk.so"
  verify_product_abi_symbols "$core_stage/libcitizensdk.so" "$nm_bin" "" \
    "Android libcitizensdk.so"
  prepare_safe_output_file "$output_dir" "$core_destination" "Android CitizenSDK Core 库"
  cp "$core_stage/libcitizensdk.so" "$core_destination"

  # 仅链接本轮 Cargo 锁定包自带的 Maven 目录，不复制或重打包依赖原件。
  verifier_maven_dir="$(cargo metadata --manifest-path "$product_ffi_manifest" \
    --format-version 1 --locked --offline | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const matched = JSON.parse(input).packages.filter(packageInfo =>
          packageInfo.name === "rustls-platform-verifier-android" && packageInfo.version === "0.1.1");
        if (matched.length !== 1) process.exit(1);
        process.stdout.write(require("path").join(require("path").dirname(matched[0].manifest_path), "maven"));
      });
    ')" || fail "无法定位 Cargo.lock 中的 Android 官方证书组件"
  [[ -f "$verifier_maven_dir/rustls/rustls-platform-verifier/0.1.1/rustls-platform-verifier-0.1.1.aar" ]] \
    || fail "锁定的 Android 官方证书组件 AAR 缺失"
  verifier_link="$gradle_user_home/citizensdk-verifier-maven"
  if [[ -e "$verifier_link" || -L "$verifier_link" ]]; then
    [[ -L "$verifier_link" && "$(readlink "$verifier_link")" == "$verifier_maven_dir" ]] \
      || fail "Android 证书组件 Maven 视图已被其它内容占用"
  else
    ln -s "$verifier_maven_dir" "$verifier_link"
  fi

  # Gradle 的 HTML 问题报告会写入源码；关闭该报告，中央日志仍保留完整错误栈。
  # 环境变量必须连续传给同一子进程，续行中插入注释会使变量失去导出效果。
  CITIZENSDK_ANDROID_BUILD_DIR="$android_build_dir" \
  CITIZENSDK_SOURCE_DIR="$sdk_dir" \
  CITIZENSDK_ANDROID_CORE_DIR="$core_stage" \
  CITIZENSDK_INTERNAL_INCLUDE_DIR="$work_dir/private-include" \
  CITIZENSDK_ZXING_SOURCE_DIR="$CITIZENSDK_ZXING_SOURCE_DIR" \
  GRADLE_USER_HOME="$gradle_user_home" \
    "$gradle_bin" ${gradle_network_arg:+"$gradle_network_arg"} --no-daemon --stacktrace --no-problems-report \
      --project-cache-dir "$gradle_project_cache" \
      -Pkotlin.project.persistent.dir="$kotlin_persistent_dir" \
      -p "$android_gradle_project" :native:assembleRelease
  built_aar="$android_build_dir/native/outputs/aar/native-release.aar"
  [[ -f "$built_aar" ]] || fail "Android CitizenSDK AAR 未生成：$built_aar"

  prepare_safe_output_file "$output_dir" "$jni_destination" "Android CitizenSDK JNI 库"
  unzip -p "$built_aar" jni/arm64-v8a/libcitizensdk_jni.so >"$jni_destination" \
    || fail "无法从 AAR 提取 libcitizensdk_jni.so"
  prepare_safe_output_file "$output_dir" "$aar_destination" "Android CitizenSDK AAR"
  cp "$built_aar" "$aar_destination"
  verify_android_aar \
    "$aar_destination" "$core_destination" "$jni_destination" "$nm_bin"
  echo "CitizenSDK Android Core/JNI/AAR 完成：$aar_destination"
}

apple_product_symbols() {
  local library="$1" nm_bin="$2"
  "$nm_bin" -gU "$library" 2>/dev/null \
    | awk 'NF > 0 && $NF !~ /:$/ { print $NF }' \
    | sed 's/^_//' \
    | LC_ALL=C sort -u
}

qr_image_header_symbols() {
  perl -0777 -ne 'while (/\b(citizensdk_qr_image_[a-z0-9_]+)\s*\(/g) { print "$1\n" }' \
    "$qr_image_header" | LC_ALL=C sort -u
}

apple_public_symbols() {
  { product_header_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u
}

apple_linked_symbols() {
  { product_linked_symbols; qr_image_header_symbols; } | LC_ALL=C sort -u
}

verify_apple_product_abi_symbols() {
  local library="$1" nm_bin="$2" label="$3"
  local all_symbols actual expected forbidden foreign swift_symbols expected_count
  all_symbols="$(apple_product_symbols "$library" "$nm_bin")" \
    || fail "无法读取 $label 的 Mach-O 外部已定义符号"
  actual="$(printf '%s\n' "$all_symbols" | grep '^citizensdk_' || true)"
  expected="$(apple_public_symbols)"
  expected_count="$(printf '%s\n' "$expected" | grep -c '^citizensdk_' || true)"
  [[ "$expected_count" == 148 ]] \
    || fail "Apple 产品头必须精确声明 144 个 Core 与 4 个图像函数"
  forbidden="$(printf '%s\n' "$all_symbols" \
    | grep -E '^(smoldot_|citizen_sr25519_|account_crypto_)' || true)"
  [[ -z "$forbidden" ]] \
    || fail "$label 泄露 legacy 低层符号：$(printf '%s' "$forbidden" | tr '\n' ' ')"
  [[ "$actual" == "$expected" ]] || {
    local missing extra
    missing="$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
    extra="$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
    fail "$label 的 citizensdk_* 与 144 Core + 4 图像函数产品头不一致；缺失=${missing:-无}；额外=${extra:-无}"
  }
  # 动态 framework 同时提供 Swift API 和 C ABI。Swift public/ABI-support 符号
  # 只能属于本模块 mangling；除这组 Swift 符号外，全部外部已定义符号必须正好
  # 是产品头中的 144 个 Core + 4 个图像 C ABI，Rust staticlib 及其依赖不得穿透边界。
  swift_symbols="$(printf '%s\n' "$all_symbols" | grep '^\$s10CitizenSDK' || true)"
  [[ -n "$swift_symbols" ]] || fail "$label 未导出 CitizenSDK Swift 模块符号"
  foreign="$(printf '%s\n' "$all_symbols" \
    | grep -Ev '^(citizensdk_|\$s10CitizenSDK)' || true)"
  [[ -z "$foreign" ]] \
    || fail "$label 泄露非 CitizenSDK 产品符号：$(printf '%s' "$foreign" | tr '\n' ' ')"
}

write_apple_exported_symbols() {
  local probe="$1" nm_bin="$2" destination="$3" label="$4"
  local all_symbols actual expected swift_symbols
  all_symbols="$(apple_product_symbols "$probe" "$nm_bin")" \
    || fail "无法读取 $label 的未过滤 Mach-O 符号"
  actual="$(printf '%s\n' "$all_symbols" | grep '^citizensdk_' || true)"
  expected="$(apple_linked_symbols)"
  [[ "$actual" == "$expected" ]] \
    || fail "$label 未过滤链接不等于产品头与既定内部符号闭集"
  swift_symbols="$(printf '%s\n' "$all_symbols" | grep '^\$s10CitizenSDK' || true)"
  [[ -n "$swift_symbols" ]] || fail "$label 未过滤链接没有 CitizenSDK Swift 导出"
  prepare_safe_output_file "$work_dir" "$destination" "$label 导出允许集"
  {
    apple_public_symbols
    printf '%s\n' "$swift_symbols"
  } | sed 's/^/_/' | LC_ALL=C sort -u >"$destination"
  [[ "$(grep -c '^_citizensdk_' "$destination" || true)" == 148 ]] \
    || fail "$label 导出允许集没有精确 144 个 Core + 4 个图像 C ABI"
}

write_framework_plist() {
  local path="$1" supported_platform="$2" platform_name="$3"
  local minimum_key="$4" minimum_version="$5" software_version="$6"
  /usr/bin/plutil -create xml1 "$path"
  /usr/libexec/PlistBuddy \
    -c "Add :CFBundleDevelopmentRegion string en" \
    -c "Add :CFBundleExecutable string CitizenSDK" \
    -c "Add :CFBundleIdentifier string org.citizen.sdk" \
    -c "Add :CFBundleInfoDictionaryVersion string 6.0" \
    -c "Add :CFBundleName string CitizenSDK" \
    -c "Add :CFBundlePackageType string FMWK" \
    -c "Add :CFBundleShortVersionString string $software_version" \
    -c "Add :CFBundleVersion string $software_version" \
    -c "Add :CFBundleSupportedPlatforms array" \
    -c "Add :CFBundleSupportedPlatforms:0 string $supported_platform" \
    -c "Add :DTPlatformName string $platform_name" \
    -c "Add :$minimum_key string $minimum_version" \
    "$path" >/dev/null
}

write_framework_module_map() {
  local path="$1"
  printf '%s\n' \
    'framework module CitizenSDK {' \
    '  umbrella header "citizensdk.h"' \
    '  module QRImage {' \
    '    header "citizensdk_qr_image.h"' \
    '    export *' \
    '  }' \
    '  export *' \
    '  module * { export * }' \
    '}' >"$path"
}

resolve_flutter_sdk_root() {
  local flutter_bin flutter_root
  flutter_bin="$(command -v flutter || true)"
  [[ -n "$flutter_bin" && "$flutter_bin" == /* && -f "$flutter_bin" \
    && ! -L "$flutter_bin" && -x "$flutter_bin" ]] \
    || fail "Apple Flutter adapter 编译需要绝对路径的普通 Flutter 可执行文件"
  flutter_root="$(cd "$(dirname "$flutter_bin")/.." && pwd -P)"
  [[ -d "$flutter_root/bin/cache/artifacts/engine" ]] \
    || fail "Flutter SDK 缺少已缓存 Apple engine artifacts：$flutter_root"
  printf '%s\n' "$flutter_root"
}

resolve_flutter_macos_xcframework() {
  local flutter_root="$1" candidate
  local -a candidates=()
  while IFS= read -r candidate; do
    candidates+=("$candidate")
  done < <(find "$flutter_root/bin/cache/artifacts/engine" \
    -mindepth 2 -maxdepth 2 -type d -name FlutterMacOS.xcframework \
    -path '*/darwin-*-release/FlutterMacOS.xcframework' -print | LC_ALL=C sort)
  [[ "${#candidates[@]}" == 1 ]] \
    || fail "Flutter SDK 必须精确提供一个 macOS Release XCFramework；实际=${#candidates[@]}"
  printf '%s\n' "${candidates[0]}"
}

resolve_xcframework_framework_slice() {
  local xcframework="$1" module="$2" platform="$3" expected_variant="$4"
  local index=0 identifier library_path actual_platform actual_variant architectures
  local framework found='' count=0
  [[ -d "$xcframework" && ! -L "$xcframework" \
    && -f "$xcframework/Info.plist" && ! -L "$xcframework/Info.plist" ]] \
    || fail "$module XCFramework 缺失或不是普通目录"
  while identifier="$(/usr/libexec/PlistBuddy \
    -c "Print :AvailableLibraries:$index:LibraryIdentifier" \
    "$xcframework/Info.plist" 2>/dev/null)"; do
    actual_platform="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:SupportedPlatform" \
      "$xcframework/Info.plist")"
    actual_variant="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:SupportedPlatformVariant" \
      "$xcframework/Info.plist" 2>/dev/null || true)"
    if [[ "$actual_platform" == "$platform" && "$actual_variant" == "$expected_variant" ]]; then
      architectures="$(/usr/libexec/PlistBuddy \
        -c "Print :AvailableLibraries:$index:SupportedArchitectures" \
        "$xcframework/Info.plist")"
      printf '%s\n' "$architectures" | grep -Eq '(^|[[:space:]])arm64([[:space:]]|$)' \
        || fail "$module 的 $platform/${expected_variant:-device} slice 不支持 arm64"
      library_path="$(/usr/libexec/PlistBuddy \
        -c "Print :AvailableLibraries:$index:LibraryPath" \
        "$xcframework/Info.plist")"
      framework="$xcframework/$identifier/$library_path"
      [[ -d "$framework" && "$(basename "$framework")" == "$module.framework" ]] \
        || fail "$module 的 $platform/${expected_variant:-device} framework 路径无效"
      found="$framework"
      count=$((count + 1))
    fi
    index=$((index + 1))
  done
  [[ "$count" == 1 ]] \
    || fail "$module 必须精确提供一个 $platform/${expected_variant:-device} arm64 slice；实际=$count"
  printf '%s\n' "$found"
}

# Hosted消费只接受调用方提供的本轮候选、官方归档及已隔离工具，不运行工具探测版本。
# 预检保持只读；真正解包仍由唯一 release.mjs 再次逐项验真，目录名不是证明。
macos_hosted_root() {
  local root checkout path
  assert_readonly_dependency_directory "$sdk_dir" "CitizenSDK 源码"
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    # 只使用 GitHub 官方环境变量；缺失时立即失败，不接受本机根或任意临时目录。
    assert_readonly_dependency_directory "${RUNNER_TEMP:-}" RUNNER_TEMP
    assert_readonly_dependency_directory "${GITHUB_WORKSPACE:-}" GITHUB_WORKSPACE
    root="$RUNNER_TEMP/citizensdk"
    checkout="$GITHUB_WORKSPACE"
    [[ "$sdk_dir" == "$checkout" ]] || fail "CitizenSDK源码必须是当前独立checkout根"
  else
    root="${CITIZENSDK_HOSTED_ROOT:-$work_dir}"
    checkout="$sdk_dir"
  fi
  assert_readonly_dependency_directory "$root" "macOS Hosted 受控根"
  # 同时拒绝源码位于工作根中、工作根位于源码中；必须在首次 mkdir 前检查。
  for path in "$checkout" "$sdk_dir"; do
    case "$root/" in "$path/"*) fail "macOS Hosted 受控根与源码交叠" ;; esac
    case "$path/" in "$root/"*) fail "macOS Hosted 源码与受控根交叠" ;; esac
  done
  # APFS 可能以不同大小写接受同一目录；仅比较 Bash 路径文本不足以隔离源码。
  node - "$root" "$checkout" "$sdk_dir" <<'NODE' || fail "macOS Hosted 源码真实路径预检失败"
  const fs = require('node:fs'), path = require('node:path');
  const [root, ...sources] = process.argv.slice(2).map((value) => fs.realpathSync.native(value));
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (sources.some((source) => inside(root, source) || inside(source, root))) {
    throw new Error('macOS Hosted 受控根与源码真实路径交叠');
  }
NODE
  printf '%s\n' "$root"
}

macos_hosted_preflight() {
  [[ "$#" == 6 ]] || fail "macOS Hosted 消费需要 candidate、audit、hosted、flutter、pub-cache、tool-path 六个参数"
  local candidate="$1" audit="$2" hosted="$3" flutter="$4" cache="$5" tool_path="$6"
  local path component central
  [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] \
    || fail "macOS Hosted 消费只允许 macOS Apple Silicon"
  central="$(macos_hosted_root)"
  for path in "$work_dir" "$output_dir" "$candidate" "$flutter" "$cache"; do
    assert_readonly_dependency_directory "$path" "macOS Hosted 输入目录"
    assert_descendant_path "$central" "$path" "macOS Hosted 受控输入"
  done
  for path in "$audit" "$hosted"; do
    assert_descendant_path "$central" "$path" "macOS Hosted 归档"
    assert_readonly_dependency_directory "$(dirname "$path")" "macOS Hosted 归档父目录"
    [[ -f "$path" && ! -L "$path" ]] || fail "macOS Hosted 归档必须是普通文件"
  done
  # Flutter/Pub 会写其副本；只读候选和归档不能与这些目录或新消费根等值、互相包含。
  # 对归档按文件路径一起比较，防止可写 cache 的父目录吞入来源文件。
  local first second
  # 候选/归档只读，Flutter/Pub 与消费工作区可写；连预备输出容器也不能包住任何输入。
  local -a inputs=("$candidate" "$audit" "$hosted" "$flutter" "$cache" "$work_dir" "$output_dir")
  for ((first = 0; first < ${#inputs[@]}; first++)); do
    for ((second = first + 1; second < ${#inputs[@]}; second++)); do
      case "${inputs[first]}/" in "${inputs[second]}/"*) fail "macOS Hosted 输入和可写目录必须双向互斥" ;; esac
      case "${inputs[second]}/" in "${inputs[first]}/"*) fail "macOS Hosted 输入和可写目录必须双向互斥" ;; esac
    done
  done
  # 固定受控根的磁盘大小写由系统决定；其下任何输入别名都不能隐藏互相包含关系。
  node - "$central" "${inputs[@]}" <<'NODE' || fail "macOS Hosted 输入真实路径预检失败"
  const fs = require('node:fs'), path = require('node:path');
  const [root, ...inputs] = process.argv.slice(2);
  const realRoot = fs.realpathSync.native(root);
  for (const input of inputs) {
    if (fs.realpathSync.native(input) !== path.join(realRoot, path.relative(root, input))) {
      throw new Error('macOS Hosted 输入真实路径存在别名');
    }
  }
NODE
  for component in bin/cache/dart-sdk/bin/dart bin/cache/flutter_tools.snapshot \
      bin/cache/flutter.version.json packages/flutter_tools/.dart_tool/package_config.json; do
    path="$flutter/$component"
    assert_readonly_dependency_directory "$(dirname "$path")" "macOS Hosted 工具文件父目录"
    [[ -f "$path" && ! -L "$path" ]] || fail "macOS Hosted 缺少已隔离的 Flutter 工具：$component"
  done
  [[ -x "$flutter/bin/cache/dart-sdk/bin/dart" ]] || fail "macOS Hosted Dart 不可执行"
  [[ -n "$tool_path" && "$tool_path" != :* && "$tool_path" != *: && "$tool_path" != *::* ]] \
    || fail "macOS Hosted 工具 PATH 不得包含空项"
  local -a components
  IFS=: read -r -a components <<<"$tool_path"
  for path in "${components[@]}"; do
    assert_readonly_dependency_directory "$path" "macOS Hosted 工具 PATH"
    case "$work_dir/macOS/" in "$path/"*) fail "macOS Hosted 工具 PATH 不得包含消费输出" ;; esac
    case "$path/" in "$work_dir/macOS/"*) fail "macOS Hosted 工具 PATH 不得来自消费输出" ;; esac
  done
  [[ -x /usr/bin/sandbox-exec ]] || fail "macOS Hosted 缺少系统 sandbox-exec"
}

build_macos_flutter_consumer() (
  macos_hosted_preflight "$@"
  local candidate="$1" audit="$2" hosted="$3" flutter_root="$4" cache_root="$5" tool_path="$6"
  local root="$work_dir/macOS" package="$work_dir/macOS/package" runner="$work_dir/macOS/consumer"
  local dart_bin="$flutter_root/bin/cache/dart-sdk/bin/dart" node_bin path framework bundle executable
  local source_uuid installed_uuid
  node_bin="$(command -v node)"
  [[ -n "$node_bin" && "$node_bin" == /* && -x "$node_bin" ]] || fail "macOS Hosted 缺少既有 Node"
  [[ ! -e "$root" && ! -L "$root" ]] || fail "macOS Hosted 工作目录已存在，拒绝混入旧状态"
  umask 077
  for path in "$root" "$root/tmp" "$root/logs" "$root/config" "$root/cache" \
      "$root/pods" "$root/pods/cache" "$root/pods/repos" "$root/module-cache" \
      "$root/tool-state" "$root/runtime" "$root/runtime/tmp"; do
    prepare_safe_directory "$work_dir" "$path" "macOS Hosted 独占目录"
    chmod 0700 "$path"
  done

  # 监督器只把显式工具配置传给子进程，不传 HOME、发布令牌、Git 配置或 DYLD 注入。
  # 每个工具独立进程组；退出、超时和中断都等待整组消失，失败不删除工作目录。
  "$node_bin" - "$root" "$flutter_root" "$cache_root" "$tool_path" <<'NODE'
const fs = require('fs'), path = require('path'), url = require('url');
const [root, flutter, cache, tools] = process.argv.slice(2);
const packageConfig = path.join(flutter, 'packages/flutter_tools/.dart_tool/package_config.json');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
for (const entry of JSON.parse(fs.readFileSync(packageConfig, 'utf8')).packages) {
  const uri = new URL(entry.rootUri, url.pathToFileURL(packageConfig));
  if (uri.protocol !== 'file:') throw Error('Flutter tools package is not local');
  const actual = fs.realpathSync(url.fileURLToPath(uri));
  if (![flutter, cache].some((parent) => inside(parent, actual))) {
    throw Error('Flutter tools package config escapes isolated tool/cache inputs');
  }
}
const config = {
  PATH: tools, FLUTTER_ROOT: flutter, PUB_CACHE: cache,
  TMPDIR: path.join(root, 'tmp'), XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_CACHE_HOME: path.join(root, 'cache'), CP_HOME_DIR: path.join(root, 'pods'),
  CP_CACHE_DIR: path.join(root, 'pods/cache'), CP_REPOS_DIR: path.join(root, 'pods/repos'),
  CLANG_MODULE_CACHE_PATH: path.join(root, 'module-cache'),
  SWIFTPM_MODULECACHE_OVERRIDE: path.join(root, 'module-cache'),
  CFFIXED_USER_HOME: path.join(root, 'tool-state'),
  COCOAPODS_DISABLE_STATS: 'true', FLUTTER_SUPPRESS_ANALYTICS: 'true',
  DASH__SUPPRESS_ANALYTICS: 'true', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
};
// Xcode 工具选择不是凭据；只保留调用方显式选择的既有工具目录。
if (process.env.DEVELOPER_DIR) config.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
fs.writeFileSync(path.join(root, 'environment.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
// macOS 不允许重复安装 sandbox；每个工具由监督器单独隔离，消费者使用其更严格的运行策略。
// 离线构建工具只可写本轮宿主、Flutter 和 Pub 副本，Git 元数据始终只读。
const user = require('os').homedir();
const quote = (value) => JSON.stringify(value);
const policy = '(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n' +
  [root, flutter, cache].map((value) => `(allow file-write* (subpath ${quote(value)}))\n`).join('') +
  '(allow file-write* (literal "/dev/null"))\n' +
  `(deny file-write* (subpath ${quote(path.join(flutter, '.git'))}))\n` +
  ['Library/Application Support/citizensdk', 'Library/Keychains', 'Library/Application Support/dart',
   '.config/dart', '.pub-cache', '.gitconfig', '.git-credentials', '.config/git',
   'GMB/.git', 'TATA/.git', 'TUYU/.git', 'flutter/.git']
    .map((value) => `(deny file-read* (subpath ${quote(path.join(user, value))}))\n`).join('');
fs.writeFileSync(path.join(root, 'tool.sb'), policy, { flag: 'wx', mode: 0o600 });
NODE
  prepare_safe_output_file "$work_dir" "$root/run.mjs" "macOS Hosted 工具监督器"
  cat >"$root/run.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [root, label, seconds, cwd, command, ...args] = process.argv.slice(2);
if (!/^[a-z-]+$/.test(label) || !/^\d+$/.test(seconds)) throw Error('Invalid supervised command');
const env = JSON.parse(fs.readFileSync(path.join(root, 'environment.json'), 'utf8'));
if (label === 'consumer') {
  env.CFFIXED_USER_HOME = path.join(root, 'runtime');
  env.TMPDIR = path.join(root, 'runtime/tmp');
}
const stdout = fs.openSync(path.join(root, 'logs', `${label}.stdout`), 'wx', 0o600);
const stderr = fs.openSync(path.join(root, 'logs', `${label}.stderr`), 'wx', 0o600);
let failed = false, exited = false, child;
const alive = () => {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const signal = (value) => { if (alive()) process.kill(-child.pid, value); };
let killing;
const stop = () => {
  failed = true;
  signal('SIGTERM');
  killing ??= setTimeout(() => signal('SIGKILL'), 2000);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// consumer 参数已经指定 runtime.sb，不能再次嵌套；其它工具统一套用只写中央副本的策略。
const executable = label === 'consumer' ? command : '/usr/bin/sandbox-exec';
const argumentsList = label === 'consumer' ? args : ['-f', path.join(root, 'tool.sb'), command, ...args];
child = spawn(executable, argumentsList, { cwd, env, detached: true, stdio: ['ignore', stdout, stderr] });
const timeout = setTimeout(stop, Number(seconds) * 1000);
const result = await new Promise((resolve) => {
  child.once('error', () => { failed = true; resolve(1); });
  child.once('exit', (code, received) => { exited = true; resolve(received ? 1 : code ?? 1); });
});
clearTimeout(timeout);
if (alive()) stop();
const deadline = Date.now() + 12000;
while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
if (killing) clearTimeout(killing);
fs.closeSync(stdout); fs.closeSync(stderr);
if (alive() || !exited || failed || result !== 0) {
  process.stderr.write(`CitizenSDK macOS ${label} failed; logs and state retained\n`);
  process.exitCode = 1;
}
NODE
  macos_command() {
    "$node_bin" "$root/run.mjs" "$root" "$@"
  }
  macos_command verify 180 "$root" "$node_bin" "$script_dir/release.mjs" \
    --verify-hosted "$candidate" --archive "$audit" --hosted-archive "$hosted" --output "$package"
  [[ -d "$package" && ! -L "$package" ]] || fail "macOS Hosted 未得到验真运行包"
  # 重新验真的 Hosted 普通目录就是唯一安装输入；不得修复成原审计包五条链接。
  local -a flutter=("$dart_bin" "--packages=$flutter_root/packages/flutter_tools/.dart_tool/package_config.json"
    "$flutter_root/bin/cache/flutter_tools.snapshot" --no-version-check --suppress-analytics)
  macos_command create 180 "$root" "${flutter[@]}" create --offline --no-pub --platforms=macos \
    --project-name=citizensdk_consumer --org=org.citizen "$runner"
  "$node_bin" - "$runner" "$package" "$root" "$candidate" <<'NODE'
const fs = require('fs'), path = require('path');
const [runner, source, root, candidate] = process.argv.slice(2);
const pubspec = fs.readFileSync(path.join(source, 'pubspec.yaml'), 'utf8');
const version = /^version: ([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(pubspec)?.[1];
if (!version) throw Error('Hosted SDK version is not unique');
fs.writeFileSync(path.join(runner, 'pubspec.yaml'), `name: citizensdk_consumer\npublish_to: none\nversion: ${version}\nenvironment:\n  sdk: ">=3.8.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  citizen_sdk:\n    path: ../package\nflutter:\n  uses-material-design: true\n`);
// 测试夹具也来自已验真的审计候选，不能用当前工作区未验真的代码替换验收合同。
fs.copyFileSync(path.join(candidate, 'darwin/Tests/citizen_sdk_flutter_consumer.dart'), path.join(runner, 'lib/main.dart'));
// 只修改临时宿主最低系统与架构，不改变 SDK 或 Flutter 官方插件注册装配。
const project = path.join(runner, 'macos/Runner.xcodeproj/project.pbxproj');
let text = fs.readFileSync(project, 'utf8');
if (!text.includes('MACOSX_DEPLOYMENT_TARGET = ')) throw Error('Official macOS deployment setting is missing');
text = text.replace(/MACOSX_DEPLOYMENT_TARGET = [0-9.]+;/g, 'MACOSX_DEPLOYMENT_TARGET = 13.0;\n\t\t\t\tARCHS = arm64;');
fs.writeFileSync(project, text);
const window = path.join(runner, 'macos/Runner/MainFlutterWindow.swift');
text = fs.readFileSync(window, 'utf8');
const start = '  override func awakeFromNib() {';
if (text.split(start).length !== 2 || text.split('RegisterGeneratedPlugins(registry: flutterViewController)').length !== 2) {
  throw Error('Official macOS Flutter registration template changed');
}
const expected = path.join(root, 'runtime/Library/Application Support/citizensdk/v1');
const preflight = `
    // 先验证 Foundation 实际路径；此时尚未创建 Flutter engine 或注册 SDK。
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      fputs("CitizenSDK Foundation isolation failed\\n", stderr); exit(78)
    }
    let state = support.appendingPathComponent("citizensdk/v1", isDirectory: true).standardizedFileURL
    guard state.path == ${JSON.stringify(expected)}, state.resolvingSymlinksInPath().path == state.path else {
      fputs("CitizenSDK Foundation isolation failed\\n", stderr); exit(78)
    }
    // 动态加载来源只能是最终 app 内的同版框架，禁止 DYLD 外部注入。
    let expectedFramework = Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks/CitizenSDK.framework").resolvingSymlinksInPath().path + "/"
    var frameworkCount = 0
    for index in 0..<_dyld_image_count() {
      guard let name = _dyld_get_image_name(index) else { continue }
      let image = String(cString: name)
      if image.contains("CitizenSDK.framework/") {
        guard URL(fileURLWithPath: image).resolvingSymlinksInPath().path.hasPrefix(expectedFramework) else {
          fputs("CitizenSDK framework origin failed\\n", stderr); exit(79)
        }
        frameworkCount += 1
      }
    }
    guard frameworkCount == 1 else { fputs("CitizenSDK framework origin failed\\n", stderr); exit(79) }
    print("CitizenSDK Foundation isolation passed")
    fflush(stdout)
`;
fs.writeFileSync(window, text.replace('import Cocoa', 'import Cocoa\nimport MachO').replace(start, start + preflight));
// sandbox 是运行必须条件，不靠 CFFIXED_USER_HOME 名称推断隔离。它禁止任何工作区外写入，
// 并禁止用户 SDK/Keychain 状态读取。Foundation 仍需在 app 内独立完成精确路径检查。
const os = require('os');
const user = os.homedir();
const quote = (value) => JSON.stringify(value);
fs.writeFileSync(path.join(root, 'runtime.sb'), `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath ${quote(root)}))\n` +
  ['Library/Application Support/citizensdk', 'Library/Keychains', '.config/dart'].map((name) =>
    `(deny file-read* (subpath ${quote(path.join(user, name))}))\n`).join(''), { flag: 'wx', mode: 0o600 });
NODE
  macos_command pub 180 "$runner" "${flutter[@]}" pub get --offline
  "$node_bin" - "$runner" "$package" "$flutter_root" "$cache_root" <<'NODE'
const fs = require('fs'), path = require('path'), url = require('url');
const [runner, source, flutter, cache] = process.argv.slice(2);
const configPath = path.join(runner, '.dart_tool/package_config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
let sdkCount = 0;
for (const entry of config.packages) {
  const uri = new URL(entry.rootUri, url.pathToFileURL(configPath));
  if (uri.protocol !== 'file:') throw Error('Consumer package is not local');
  const actual = fs.realpathSync(url.fileURLToPath(uri));
  if (![runner, source, flutter, cache].some((parent) => inside(parent, actual))) {
    throw Error('Consumer package config escapes isolated installed inputs');
  }
  if (entry.name === 'citizen_sdk') {
    if (actual !== source) throw Error('Consumer does not depend on verified Hosted package');
    sdkCount += 1;
  }
}
if (sdkCount !== 1) throw Error('Consumer CitizenSDK package is not unique');
const plugins = JSON.parse(fs.readFileSync(path.join(runner, '.flutter-plugins-dependencies'), 'utf8'));
const entries = plugins.plugins?.macos?.filter((entry) => entry.name === 'citizen_sdk') ?? [];
// APFS可保留与调用方不同的路径大小写；同版来源按实际目录身份判断，不改产品目录命名。
const sameDirectory = (left, right) => {
  const actual = fs.statSync(left), expected = fs.statSync(right);
  return actual.isDirectory() && expected.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino;
};
if (entries.length !== 1 || !sameDirectory(entries[0].path, source)) {
  throw Error('Official macOS plugin discovery did not select the verified Hosted package');
}
const registrant = fs.readFileSync(path.join(runner, 'macos/Flutter/GeneratedPluginRegistrant.swift'), 'utf8');
if (registrant.split('import citizen_sdk').length !== 2 || registrant.split('CitizenSdkPlugin.register(').length !== 2) {
  throw Error('Official macOS CitizenSDK plugin registration is not unique');
}
NODE
  # 保持 Flutter 默认 SwiftPM/CocoaPods 选择；不切换全局设置、不重写 podspec。
  macos_command build 900 "$runner" "${flutter[@]}" build macos --release --no-pub
  bundle="$runner/build/macos/Build/Products/Release/citizensdk_consumer.app"
  executable="$bundle/Contents/MacOS/citizensdk_consumer"
  [[ -x "$executable" ]] || fail "macOS Hosted 缺少最终 Release app"
  framework="$(resolve_xcframework_framework_slice \
    "$package/darwin/CitizenSDK.xcframework" CitizenSDK macos '')"
  [[ -f "$framework/Versions/A/CitizenSDK" ]] || fail "macOS Hosted 缺少已验真的 macOS framework"
  # Apple 签名会更改文件尾部签名区；比较原生 UUID、架构和资产，不误用全文件摘要。
  macos_command source-uuid 30 "$root" /usr/bin/xcrun dwarfdump --uuid "$framework/Versions/A/CitizenSDK"
  macos_command installed-uuid 30 "$root" /usr/bin/xcrun dwarfdump --uuid "$bundle/Contents/Frameworks/CitizenSDK.framework/Versions/A/CitizenSDK"
  source_uuid="$(awk '{print $2, $3}' "$root/logs/source-uuid.stdout")"
  installed_uuid="$(awk '{print $2, $3}' "$root/logs/installed-uuid.stdout")"
  [[ "$source_uuid" == "$installed_uuid" && "$source_uuid" == *' (arm64)' && "$source_uuid" != *$'\n'* ]] \
    || fail "macOS Hosted 已安装 Core UUID 或架构漂移"
  for path in manifest.json chainspec.json light_sync_state.json; do
    cmp -s "$package/chain/$path" \
      "$bundle/Contents/Frameworks/App.framework/Resources/flutter_assets/packages/citizen_sdk/chain/$path" \
      || fail "macOS Hosted Flutter 安装链资产漂移：$path"
    cmp -s "$package/chain/$path" \
      "$bundle/Contents/Frameworks/CitizenSDK.framework/Resources/chain/$path" \
      || fail "macOS Hosted 原生安装链资产漂移：$path"
  done
  macos_command consumer 200 "$root" /usr/bin/sandbox-exec -f "$root/runtime.sb" "$executable"
  [[ "$(grep -Fxc 'CitizenSDK Foundation isolation passed' "$root/logs/consumer.stdout" || true)" == 1 ]] \
    || fail "macOS Hosted 缺少唯一 Foundation 隔离预检成功标记"
  [[ "$(grep -Fxc 'CitizenSDK Flutter consumer passed' "$root/logs/consumer.stdout" || true)" == 1 ]] \
    || fail "macOS Hosted 缺少唯一公开消费者成功标记"
  echo "CitizenSDK macOS Hosted 安装消费通过"
)

compile_apple_flutter_adapter() {
  local apple_sdk="$1" swift_target="$2" slice_name="$3" platform="$4"
  local variant="$5" flutter_module="$6" flutter_xcframework="$7"
  local citizen_slice_root="$8" flutter_framework flutter_framework_root
  local sdk_path swiftc compile_root module_cache source object_count
  local -a swift_sources swift_arguments

  [[ -d "$citizen_slice_root/CitizenSDK.framework" \
    && ! -L "$citizen_slice_root/CitizenSDK.framework" ]] \
    || fail "$slice_name Flutter adapter 必须从最终 XCFramework slice 导入 CitizenSDK"
  [[ -d "$darwin_flutter_source_root" && ! -L "$darwin_flutter_source_root" ]] \
    || fail "CitizenSDKFlutter 生产源码目录缺失"
  swift_sources=()
  while IFS= read -r source; do
    swift_sources+=("$source")
  done < <(find "$darwin_flutter_source_root" -maxdepth 1 -type f \
    -name '*.swift' -print | LC_ALL=C sort)
  [[ "${#swift_sources[@]}" -gt 0 ]] || fail "CitizenSDKFlutter 生产源码为空"

  flutter_framework="$(resolve_xcframework_framework_slice \
    "$flutter_xcframework" "$flutter_module" "$platform" "$variant")"
  flutter_framework_root="$(dirname "$flutter_framework")"
  sdk_path="$(xcrun --sdk "$apple_sdk" --show-sdk-path)"
  swiftc="$(xcrun --sdk "$apple_sdk" --find swiftc)"
  [[ -d "$sdk_path" && -x "$swiftc" ]] \
    || fail "$slice_name Flutter adapter 缺少受控 Apple SDK 或 swiftc"

  compile_root="$work_dir/apple-flutter-compile/$slice_name"
  module_cache="$compile_root/module-cache"
  [[ ! -e "$compile_root" && ! -L "$compile_root" ]] \
    || fail "$slice_name Flutter adapter 编译目录必须全新"
  prepare_safe_directory "$work_dir" "$compile_root" \
    "$slice_name Flutter adapter 编译目录"
  prepare_safe_directory "$work_dir" "$module_cache" \
    "$slice_name Flutter adapter module cache"
  swift_arguments=("${swift_sources[@]}"
    -parse-as-library
    -swift-version 5
    -warnings-as-errors
    -strict-concurrency=complete
    -module-name CitizenSDKFlutter
    -module-cache-path "$module_cache"
    -sdk "$sdk_path"
    -target "$swift_target"
    -F "$citizen_slice_root"
    -F "$flutter_framework_root")

  # 第一遍是严格类型检查；第二遍真实生成每个 Swift 源文件的目标文件。
  # 两遍都从最终 XCFramework slice 导入 @_spi(CitizenSDKFlutter)，不能从
  # 同次 Swift 源码或构建前 framework 旁路产品边界。
  "$swiftc" "${swift_arguments[@]}" -typecheck
  (
    cd "$compile_root"
    "$swiftc" "${swift_arguments[@]}" -c
  )
  object_count="$(find "$compile_root" -mindepth 1 -maxdepth 1 \
    -type f -name '*.o' -print | wc -l | tr -d '[:space:]')"
  [[ "$object_count" == "${#swift_sources[@]}" ]] \
    || fail "$slice_name Flutter adapter 编译目标闭集漂移：$object_count/${#swift_sources[@]}"
}

write_apple_test_package() {
  local harness="$1" static_library="$2" flutter_module="$3"
  local qr_library="$4" zxing_library="$5" product_swift_target="$6"
  local source destination
  for directory in \
    "$harness/Sources/CitizenSDK" \
    "$harness/Sources/CitizenSDKC/include" \
    "$harness/Sources/CitizenSDKFlutter" \
    "$harness/Tests/CitizenSDKTests" \
    "$harness/Tests/CitizenSDKFlutterTests" \
    "$harness/Libraries"; do
    prepare_safe_directory "$work_dir" "$directory" "Apple XCTest 临时 harness"
  done
  cp "$product_header" "$harness/Sources/CitizenSDKC/include/citizensdk.h"
  cp "$product_types_header" "$harness/Sources/CitizenSDKC/include/citizensdk_types.h"
  cp "$qr_image_header" "$harness/Sources/CitizenSDKC/include/citizensdk_qr_image.h"
  cp "$static_library" "$harness/Libraries/libcitizensdk.a"
  cp "$qr_library" "$harness/Libraries/libcitizensdk_qr_image.a"
  cp "$zxing_library" "$harness/Libraries/libZXing.a"
  printf '%s\n' \
    '#include "citizensdk.h"' \
    'int citizensdk_test_harness_anchor(void) { return 0; }' \
    >"$harness/Sources/CitizenSDKC/harness.c"
  while IFS= read -r source; do
    destination="$harness/Sources/CitizenSDK/$(basename "$source")"
    {
      printf '%s\n' 'import CitizenSDKC'
      cat "$source"
    } >"$destination"
  done < <(find "$darwin_source_root" -maxdepth 1 -type f -name '*.swift' \
    -print | LC_ALL=C sort)
  printf '%s\n' '@_exported import CitizenSDKC' \
    >"$harness/Sources/CitizenSDK/CitizenSDKCExports.swift"
  cp "$darwin_flutter_source_root"/*.swift "$harness/Sources/CitizenSDKFlutter/"
  cp "$sdk_dir/darwin/Tests/CitizenSDKTests"/*.swift \
    "$harness/Tests/CitizenSDKTests/"
  cp "$sdk_dir/darwin/Tests/CitizenSDKFlutterTests"/*.swift \
    "$harness/Tests/CitizenSDKFlutterTests/"

  cat >"$harness/Package.swift" <<PACKAGE
// swift-tools-version: 5.9
import PackageDescription

let strict: [SwiftSetting] = [
    .unsafeFlags(["-warnings-as-errors", "-strict-concurrency=complete",
        "-I", "$work_dir/private-include", "-Xcc", "-I$harness/Sources/CitizenSDKC/include"]),
]

// Release-mode cross compilation does not make package modules testable by
// default. The harness needs internal access for the canonical @testable XCTest
// suites, so only its two generated implementation targets receive this flag.
let testable: [SwiftSetting] = strict + [
    // SDK源码继续按正式最低版本编译；只有XCTest目标使用较高运行库版本。
    // SwiftPM/Xcode会重建driver目标，必须把生产目标直接传给编译前端。
    .unsafeFlags(["-enable-testing", "-Xfrontend", "-target", "-Xfrontend", "$product_swift_target"]),
]

let package = Package(
    name: "CitizenSDKAppleTests",
    // 仅测试包对齐XCTest运行库最低版本；交付框架仍支持iOS16/macOS13。
    platforms: [.iOS(.v17), .macOS(.v14)],
    targets: [
        .binaryTarget(name: "$flutter_module", path: "Artifacts/$flutter_module.xcframework"),
        .target(
            name: "CitizenSDKC",
            path: "Sources/CitizenSDKC",
            publicHeadersPath: "include"
        ),
        .target(
            name: "CitizenSDK",
            dependencies: ["CitizenSDKC"],
            path: "Sources/CitizenSDK",
            swiftSettings: testable,
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-force_load", "-Xlinker", "$harness/Libraries/libcitizensdk.a"]),
                .unsafeFlags(["-Xlinker", "-force_load", "-Xlinker", "$harness/Libraries/libcitizensdk_qr_image.a"]),
                .unsafeFlags(["-Xlinker", "-force_load", "-Xlinker", "$harness/Libraries/libZXing.a"]),
                .linkedFramework("Security"),
                .linkedFramework("LocalAuthentication"),
                .linkedLibrary("c++"),
                .linkedLibrary("sqlite3"),
            ]
        ),
        .target(
            name: "CitizenSDKFlutter",
            dependencies: ["CitizenSDK", "$flutter_module"],
            path: "Sources/CitizenSDKFlutter",
            swiftSettings: testable
        ),
        .testTarget(
            name: "CitizenSDKTests",
            dependencies: ["CitizenSDK"],
            path: "Tests/CitizenSDKTests",
            swiftSettings: strict
        ),
        .testTarget(
            name: "CitizenSDKFlutterTests",
            dependencies: ["CitizenSDK", "CitizenSDKFlutter"],
            path: "Tests/CitizenSDKFlutterTests",
            swiftSettings: strict
        ),
    ],
    swiftLanguageVersions: [.v5]
)
PACKAGE
}

run_apple_test_harness() {
  local rust_target="$1" apple_sdk="$2" swift_target="$3" slice_name="$4"
  local flutter_module="$5" flutter_xcframework="$6" mode="$7"
  local static_library qr_library zxing_library harness scratch artifact sdk_path runtime_framework_root=''
  local flutter_test_bundle framework_destination test_product_root test_bundle_names
  local test_bundle_name resource_destination asset_name product_swift_target
  local -a swiftpm_paths swiftpm_target
  # 生产源码的可用性诊断必须与交付目标一致，不能被XCTest运行库的最低版本抬高。
  case "$apple_sdk" in
    iphoneos) product_swift_target="arm64-apple-ios$ios_deployment_target" ;;
    iphonesimulator) product_swift_target="arm64-apple-ios$ios_deployment_target-simulator" ;;
    macosx) product_swift_target="arm64-apple-macosx$macos_deployment_target" ;;
    *) fail "Apple XCTest SDK未登记：$apple_sdk" ;;
  esac
  static_library="$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.a"
  [[ -f "$static_library" && ! -L "$static_library" ]] \
    || fail "$slice_name XCTest 缺少已构建 native/ffi 静态 Core"
  qr_library="$work_dir/apple-build/$slice_name/qr-image/libcitizensdk_qr_image.a"
  zxing_library="$(find "$work_dir/apple-build/$slice_name/qr-image" \
    -type f -name 'libZXing.a' -print)"
  [[ -f "$qr_library" && ! -L "$qr_library" \
    && -n "$zxing_library" && "$zxing_library" != *$'\n'* \
    && -f "$zxing_library" && ! -L "$zxing_library" ]] \
    || fail "$slice_name XCTest 缺少对应的 QR/ZXing 静态库"
  harness="$work_dir/apple-test-harness/$slice_name"
  scratch="$work_dir/apple-test-scratch/$slice_name"
  [[ ! -e "$harness" && ! -L "$harness" && ! -e "$scratch" && ! -L "$scratch" ]] \
    || fail "$slice_name XCTest harness/scratch 必须全新"
  prepare_safe_directory "$work_dir" "$harness" "$slice_name XCTest harness"
  prepare_safe_directory "$work_dir" "$scratch" "$slice_name XCTest scratch"
  write_apple_test_package \
    "$harness" "$static_library" "$flutter_module" "$qr_library" "$zxing_library" "$product_swift_target"
  prepare_safe_directory "$work_dir" "$harness/Artifacts" "$slice_name XCTest artifacts"
  artifact="$harness/Artifacts/$flutter_module.xcframework"
  [[ ! -e "$artifact" && ! -L "$artifact" ]] \
    || fail "$slice_name Flutter 测试 artifact 目标必须全新"
  cp -R "$flutter_xcframework" "$artifact"
  sdk_path="$(xcrun --sdk "$apple_sdk" --show-sdk-path)"
  swiftpm_paths=(
    # 当前 macOS 执行环境禁止 SwiftPM 调用系统 sandbox-exec；这里只是构建测试
    # harness，不连接真实设备，运行时 smoke 仍由下方独立沙箱合同保护。
    --disable-sandbox
    --package-path "$harness"
    --cache-path "$scratch/cache"
    --config-path "$scratch/config"
    --security-path "$scratch/security"
    --scratch-path "$scratch/build"
    --manifest-cache local
    --disable-dependency-cache
    --configuration release
    --triple "$swift_target"
    --sdk "$sdk_path"
  )
  prepare_safe_directory "$work_dir" "$scratch/tmp" "$slice_name XCTest TMPDIR"
  prepare_safe_directory "$work_dir" "$scratch/foundation-home" "$slice_name XCTest Foundation 沙箱"
  case "$mode" in
    run|compile) swiftpm_target=(build --build-tests) ;;
    *) fail "Apple XCTest mode 未登记：$mode" ;;
  esac
  if [[ "$mode" == run ]]; then
    runtime_framework_root="$(dirname "$(resolve_xcframework_framework_slice \
      "$artifact" "$flutter_module" macos '')")"
  fi
  TMPDIR="$scratch/tmp" CFFIXED_USER_HOME="$scratch/foundation-home" \
  CLANG_MODULE_CACHE_PATH="$scratch/clang-module-cache" \
  SWIFTPM_MODULECACHE_OVERRIDE="$scratch/swift-module-cache" \
    swift "${swiftpm_target[@]}" "${swiftpm_paths[@]}"
  if [[ "$mode" == run ]]; then
    # SwiftPM does not embed a binary-target framework in a macOS XCTest
    # bundle. Embed the exact resolved Flutter framework after build, then run
    # with --skip-build so dyld resolves only the bundle-owned copy.
    test_product_root="$scratch/build/out/Products/Release"
    test_bundle_names="$(find "$test_product_root" -mindepth 1 -maxdepth 1 \
      -type d -name '*.xctest' -exec basename {} \; | LC_ALL=C sort)"
    [[ "$test_bundle_names" == $'CitizenSDKFlutterTests.xctest\nCitizenSDKTests.xctest' ]] \
      || fail "macOS XCTest 产品闭集漂移：${test_bundle_names:-无}"
    flutter_test_bundle="$test_product_root/CitizenSDKFlutterTests.xctest"
    framework_destination="$flutter_test_bundle/Contents/Frameworks/$flutter_module.framework"
    prepare_safe_directory "$work_dir" "$(dirname "$framework_destination")" \
      "macOS Flutter XCTest framework 目录"
    [[ ! -e "$framework_destination" && ! -L "$framework_destination" ]] \
      || fail "macOS Flutter XCTest framework 目标必须全新"
    cp -R "$runtime_framework_root/$flutter_module.framework" "$framework_destination"
    # SwiftPM把SDK静态链接进测试bundle；正式加载器仍从所属bundle读取同一链资产。
    # 仅投影冻结资源，不改生产Bundle查找路径、不构造替身链身份。
    for test_bundle_name in CitizenSDKTests.xctest CitizenSDKFlutterTests.xctest; do
      resource_destination="$test_product_root/$test_bundle_name/Contents/Resources/chain"
      prepare_safe_directory "$work_dir" "$resource_destination" "XCTest正式链资源"
      for asset_name in manifest.json chainspec.json light_sync_state.json; do
        prepare_safe_output_file "$work_dir" "$resource_destination/$asset_name" "XCTest链资产"
        cp "$apple_asset_root/$asset_name" "$resource_destination/$asset_name"
        cmp -s "$apple_asset_root/$asset_name" "$resource_destination/$asset_name" \
          || fail "XCTest链资产投影字节漂移"
      done
    done
    TMPDIR="$scratch/tmp" CFFIXED_USER_HOME="$scratch/foundation-home" \
    CLANG_MODULE_CACHE_PATH="$scratch/clang-module-cache" \
    SWIFTPM_MODULECACHE_OVERRIDE="$scratch/swift-module-cache" \
      swift test --skip-build "${swiftpm_paths[@]}"
  fi
}

run_final_apple_consumer_smoke() {
  local xcframework="$output_dir/apple/CitizenSDK.xcframework"
  local framework framework_root
  local smoke_root="$work_dir/apple-consumer-smoke"
  local source="$smoke_root/CitizenSDKConsumerSmoke.swift"
  local bundle_plist="$smoke_root/Info.plist"
  local executable="$smoke_root/CitizenSDKConsumerSmoke"
  local sdk_path swiftc architectures linked citizen_links
  local expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'
  framework="$(resolve_xcframework_framework_slice \
    "$xcframework" CitizenSDK macos '')"
  framework_root="$(dirname "$framework")"
  [[ -d "$framework" && ! -L "$framework" ]] \
    || fail "最终 XCFramework macOS slice 缺失，拒绝消费者 smoke"
  [[ ! -e "$smoke_root" && ! -L "$smoke_root" ]] \
    || fail "最终 XCFramework 消费者 smoke 目录必须全新"
  prepare_safe_directory "$work_dir" "$smoke_root" "Apple 消费者 smoke"
  for directory in \
    "$smoke_root/home-normal" "$smoke_root/home-supervisor" \
    "$smoke_root/tmp-normal" "$smoke_root/tmp-supervisor" \
    "$smoke_root/module-cache" "$smoke_root/logs"; do
    prepare_safe_directory "$work_dir" "$directory" "Apple 消费者 smoke 状态目录"
  done
  cat >"$source" <<'SWIFT'
import CitizenSDK
import Darwin
import Foundation

private enum SmokeFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
        switch self { case let .failed(message): return message }
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw SmokeFailure.failed(message) }
}

private func verifyCapabilities(_ sdk: CitizenSdk) throws {
    let capabilities = try sdk.capabilities()
    let actual = capabilities.statuses.map(\.name.rawValue).sorted()
    let expected = CitizenCapabilityName.allCases.map(\.rawValue).sorted()
    try require(capabilities.revision >= 1, "capability revision must be at least one")
    try require(capabilities.statuses.count == 10, "capability status count must be exactly ten")
    try require(actual == expected, "capability names must be the exact ten-value public enum")
}

private let publicSQLiteSuffix = "/citizensdk/v1/public/public-state-v1.sqlite3"
private let secureSQLiteSuffix = "/citizensdk/v1/secure/secure-state-v1.sqlite3"

private func citizenSDKSQLiteFileDescriptors() -> Set<String> {
    var paths = Set<String>()
    let descriptorLimit = max(0, Int(getdtablesize()))
    for descriptor in 0..<descriptorLimit {
        var bytes = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        if fcntl(Int32(descriptor), F_GETPATH, &bytes) == 0 {
            let path = String(cString: bytes)
            if path.hasSuffix(publicSQLiteSuffix) || path.hasSuffix(secureSQLiteSuffix) {
                paths.insert(path)
            }
        }
    }
    return paths
}

private func closeEventually(_ sdk: CitizenSdk) async throws {
    for _ in 0..<500 {
        do { try sdk.close(); return }
        catch let error as CitizenSDKError where error.code == .busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
    try sdk.close()
}

private func normalCloseSmoke() async throws {
    let sdk = try CitizenSdk.open()
    try require(sdk.lifecycle == .created, "open must produce created lifecycle")
    try verifyCapabilities(sdk)
    // Opening installs asynchronous state delivery. Public consumers honor the
    // documented BUSY drain boundary instead of racing that callback.
    try await closeEventually(sdk)
    try require(sdk.lifecycle == .disposed, "close must commit disposed lifecycle")
    try sdk.close()
    try require(sdk.lifecycle == .disposed, "idempotent close must remain disposed")
}

private func supervisorSmoke() async throws {
    var abandoned: CitizenSdk? = try CitizenSdk.open()
    try verifyCapabilities(abandoned!)
    // 模块化后存储按实际回调延迟打开；读取能力快照不等待后台探测。
    // 等待公开刷新请求真实完成，再要求两个 SQLite FD 已打开，避免调度时序假失败。
    try await abandoned!.refreshCapabilities()
    let initiallyOpen = citizenSDKSQLiteFileDescriptors()
    try require(initiallyOpen.contains(where: { $0.hasSuffix(publicSQLiteSuffix) }),
                "public SQLite descriptor must be open before abandonment")
    try require(initiallyOpen.contains(where: { $0.hasSuffix(secureSQLiteSuffix) }),
                "secure SQLite descriptor must be open before abandonment")
    abandoned = nil

    let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000
    while !citizenSDKSQLiteFileDescriptors().isEmpty
            && DispatchTime.now().uptimeNanoseconds < deadline {
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    try require(citizenSDKSQLiteFileDescriptors().isEmpty,
                "supervisor must close public and secure SQLite descriptors")

    let reopened = try CitizenSdk.open()
    try verifyCapabilities(reopened)
    try await closeEventually(reopened)
    try require(reopened.lifecycle == .disposed,
                "reopen after supervised cleanup must close successfully")
}

@main
private enum CitizenSDKConsumerSmoke {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else {
            throw SmokeFailure.failed("expected exactly one smoke mode")
        }
        switch CommandLine.arguments[1] {
        case "normal": try await normalCloseSmoke()
        case "supervisor": try await supervisorSmoke()
        default: throw SmokeFailure.failed("unknown smoke mode")
        }
    }
}
SWIFT
  prepare_safe_output_file "$work_dir" "$bundle_plist" "Apple 消费者 smoke Bundle 元数据"
  cat >"$bundle_plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>org.citizen.sdk.consumer-smoke</string>
</dict>
</plist>
PLIST
  sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
  swiftc="$(xcrun --sdk macosx --find swiftc)"
  prepare_safe_output_file "$work_dir" "$executable" "Apple 消费者 smoke 可执行文件"
  "$swiftc" "$source" \
    -parse-as-library \
    -swift-version 5 \
    -warnings-as-errors \
    -strict-concurrency=complete \
    -module-cache-path "$smoke_root/module-cache" \
    -sdk "$sdk_path" \
    -target arm64-apple-macosx13.0 \
    -F "$framework_root" \
    -framework CitizenSDK \
    -Xlinker -sectcreate \
    -Xlinker __TEXT \
    -Xlinker __info_plist \
    -Xlinker "$bundle_plist" \
    -Xlinker -rpath \
    -Xlinker "$framework_root" \
    -o "$executable"
  architectures="$(xcrun lipo -archs "$executable")"
  [[ "$architectures" == arm64 ]] \
    || fail "Apple 消费者 smoke 必须精确编译为 arm64"
  linked="$(xcrun otool -L "$executable")"
  citizen_links="$(printf '%s\n' "$linked" \
    | awk '$1 ~ /CitizenSDK\.framework\// { print $1 }' \
    | LC_ALL=C sort -u)"
  [[ "$citizen_links" == "$expected_install_name" ]] \
    || fail "Apple 消费者 smoke 的 CitizenSDK 链接闭集漂移：${citizen_links:-无}"
  CFFIXED_USER_HOME="$smoke_root/home-normal" \
  TMPDIR="$smoke_root/tmp-normal" \
  DYLD_FRAMEWORK_PATH="$framework_root" \
    "$executable" normal >"$smoke_root/logs/normal.log" 2>&1 \
    || fail "最终 XCFramework 普通 open/capabilities/close smoke 失败"
  CFFIXED_USER_HOME="$smoke_root/home-supervisor" \
  TMPDIR="$smoke_root/tmp-supervisor" \
  DYLD_FRAMEWORK_PATH="$framework_root" \
    "$executable" supervisor >"$smoke_root/logs/supervisor.log" 2>&1 \
    || fail "最终 XCFramework supervisor/SQLite FD smoke 失败"
}

build_apple_tests() {
  [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] \
    || fail "macOS XCTest 只允许在 Apple Silicon runner 执行"
  local xcframework flutter_root flutter_ios_xcframework flutter_macos_xcframework
  local test_header_root
  xcframework="$output_dir/apple/CitizenSDK.xcframework"
  verify_apple_xcframework "$xcframework"
  flutter_root="$(resolve_flutter_sdk_root)"
  flutter_ios_xcframework="$flutter_root/bin/cache/artifacts/engine/ios-release/Flutter.xcframework"
  flutter_macos_xcframework="$(resolve_flutter_macos_xcframework "$flutter_root")"
  # Source tests resolve include/ from their canonical repository-relative
  # location. Recreate that shared layout above all per-platform harnesses.
  test_header_root="$work_dir/apple-test-harness/include"
  prepare_safe_directory "$work_dir" "$test_header_root" \
    "Apple XCTest 共享头文件目录"
  for header in citizensdk.h citizensdk_types.h; do
    prepare_safe_output_file "$work_dir" "$test_header_root/$header" \
      "Apple XCTest 共享头文件"
    cp "$sdk_dir/include/$header" "$test_header_root/$header"
  done
  prepare_safe_output_file "$work_dir" "$test_header_root/citizensdk_qr_image.h" \
    "Apple XCTest 共享 QR 图像头文件"
  cp "$qr_image_header" "$test_header_root/citizensdk_qr_image.h"
  # XCTest运行库要求iOS17/macOS14；这里只调整测试目标，正式slice及消费者目标不变。
  run_apple_test_harness aarch64-apple-ios iphoneos arm64-apple-ios17.0 \
    aarch64-apple-ios Flutter "$flutter_ios_xcframework" compile
  run_apple_test_harness aarch64-apple-ios-sim iphonesimulator \
    arm64-apple-ios17.0-simulator aarch64-apple-ios-sim Flutter \
    "$flutter_ios_xcframework" compile
  run_apple_test_harness aarch64-apple-darwin macosx arm64-apple-macosx14.0 \
    aarch64-apple-darwin FlutterMacOS "$flutter_macos_xcframework" run
  run_final_apple_consumer_smoke
}

build_apple_framework_slice() {
  local rust_target="$1" apple_sdk="$2" swift_target="$3" slice_name="$4"
  local module_identity="$5" supported_platform="$6" platform_name="$7"
  local minimum_key="$8" minimum_version="$9"
  local slice_root framework framework_content_root framework_headers modules
  local framework_resources framework_binary framework_plist framework_install_name
  local module_map module_cache
  local sdk_path swiftc static_library software_version privacy_file source nm_bin
  local probe export_list qr_build qr_library zxing_library cmake_system
  local -a swift_sources swift_command

  require_rust_target "$rust_target"
  prepare_internal_header
  software_version="$(sed -n 's/^version: \([0-9][0-9.]*\)$/\1/p' "$sdk_dir/pubspec.yaml")"
  [[ "$software_version" =~ ^[0-9]+\.[0-9]{1,2}\.[0-9]{1,2}$ ]] \
    || fail "pubspec.yaml 软件版本无效"
  privacy_file="$darwin_source_root/PrivacyInfo.xcprivacy"
  [[ -d "$darwin_source_root" && -f "$privacy_file" \
    && -f "$product_header" && -f "$product_types_header" ]] \
    || fail "Apple Swift 源码、隐私清单或产品头不完整"

  swift_sources=()
  while IFS= read -r source; do
    swift_sources+=("$source")
  done < <(find "$darwin_source_root" -maxdepth 1 -type f -name '*.swift' -print | LC_ALL=C sort)
  [[ "${#swift_sources[@]}" -gt 0 ]] || fail "CitizenSDK Swift 产品源码为空"

  # Rust中的C依赖必须与后续Swift/CMake共用本slice的SDK，不能继承外层平台值。
  sdk_path="$(xcrun --sdk "$apple_sdk" --show-sdk-path)"
  [[ -d "$sdk_path" ]] || fail "$slice_name 缺少受控 Apple SDK"
  case "$rust_target" in
    aarch64-apple-ios|aarch64-apple-ios-sim)
      SDKROOT="$sdk_path" IPHONEOS_DEPLOYMENT_TARGET="$ios_deployment_target" \
        CARGO_PROFILE_RELEASE_STRIP=false \
        cargo build --manifest-path "$product_ffi_manifest" --release --locked \
          --target "$rust_target"
      ;;
    aarch64-apple-darwin)
      SDKROOT="$sdk_path" MACOSX_DEPLOYMENT_TARGET="$macos_deployment_target" \
        CARGO_PROFILE_RELEASE_STRIP=false \
        cargo build --manifest-path "$product_ffi_manifest" --release --locked \
          --target "$rust_target"
      ;;
    *) fail "Apple 产品禁止未登记 Rust target：$rust_target" ;;
  esac
  static_library="$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.a"
  [[ -f "$static_library" && ! -L "$static_library" ]] \
    || fail "$slice_name 的 native/ffi 静态 Core 未生成"

  slice_root="$work_dir/apple-build/$slice_name"
  [[ ! -e "$slice_root" && ! -L "$slice_root" ]] \
    || fail "$slice_name Apple slice 构建目录必须全新"
  framework="$slice_root/CitizenSDK.framework"
  if [[ "$module_identity" == arm64-apple-macos ]]; then
    # macOS framework 必须采用 Apple 标准版本化目录。iOS 设备与
    # simulator 技术变体均保持 Apple 要求的 shallow framework；三者
    # 最终进入同一个 CitizenSDK.xcframework，公开平台名只是 iOS/macOS。
    framework_content_root="$framework/Versions/A"
    framework_plist="$framework_content_root/Resources/Info.plist"
    framework_resources="$framework_content_root/Resources"
    framework_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'
  else
    framework_content_root="$framework"
    framework_plist="$framework/Info.plist"
    # iOS frameworks are shallow bundles. Keeping a macOS-style Resources
    # directory makes installd reject the framework during package inspection.
    framework_resources="$framework_content_root"
    framework_install_name='@rpath/CitizenSDK.framework/CitizenSDK'
  fi
  framework_headers="$framework_content_root/Headers"
  modules="$framework_content_root/Modules/CitizenSDK.swiftmodule"
  framework_binary="$framework_content_root/CitizenSDK"
  module_map="$framework_content_root/Modules/module.modulemap"
  module_cache="$work_dir/apple-module-cache/$slice_name"
  for directory in \
    "$framework_headers" "$modules" "$framework_resources/chain" "$module_cache"; do
    prepare_safe_directory "$work_dir" "$directory" "$slice_name Apple 构建目录"
  done
  cp "$product_header" "$framework_headers/citizensdk.h"
  cp "$product_types_header" "$framework_headers/citizensdk_types.h"
  cp "$qr_image_header" "$framework_headers/citizensdk_qr_image.h"
  write_framework_module_map "$module_map"
  for asset in chainspec.json light_sync_state.json manifest.json; do
    [[ -f "$apple_asset_root/$asset" && ! -L "$apple_asset_root/$asset" ]] \
      || fail "Apple 链资产缺失：$asset"
    cp "$apple_asset_root/$asset" "$framework_resources/chain/$asset"
  done
  cp "$privacy_file" "$framework_resources/PrivacyInfo.xcprivacy"
  prepare_safe_output_file "$work_dir" "$framework_plist" "$slice_name Info.plist"
  write_framework_plist \
    "$framework_plist" "$supported_platform" "$platform_name" \
    "$minimum_key" "$minimum_version" "$software_version"

  if [[ "$module_identity" == arm64-apple-macos ]]; then
    # 只允许这四个已经存在目标的目录链接；最终二进制写入 Versions/A 后再建立
    # 第五个链接，构建期间不会制造悬空入口，也不会让秘密或产物越出中央 workdir。
    for link_spec in \
      'Versions/Current|A' \
      'Headers|Versions/Current/Headers' \
      'Modules|Versions/Current/Modules' \
      'Resources|Versions/Current/Resources'; do
      local link_path="${link_spec%%|*}" link_target="${link_spec#*|}"
      prepare_safe_output_file "$work_dir" "$framework/$link_path" \
        "$slice_name framework 标准目录链接"
      ln -s "$link_target" "$framework/$link_path"
      [[ -L "$framework/$link_path" && -e "$framework/$link_path" \
        && "$(readlink "$framework/$link_path")" == "$link_target" ]] \
        || fail "$slice_name framework 标准目录链接创建失败：$link_path"
    done
  fi

  swiftc="$(xcrun --sdk "$apple_sdk" --find swiftc)"
  nm_bin="$(xcrun --find nm)"
  [[ -d "$sdk_path" && -x "$swiftc" && -x "$nm_bin" ]] \
    || fail "$slice_name 缺少受控 Apple SDK、swiftc 或 nm"
  command -v cmake >/dev/null 2>&1 || fail "$slice_name 缺少 CMake"
  [[ -n "${CITIZENSDK_ZXING_SOURCE_DIR:-}" \
    && "$CITIZENSDK_ZXING_SOURCE_DIR" == /* \
    && -d "$CITIZENSDK_ZXING_SOURCE_DIR" \
    && ! -L "$CITIZENSDK_ZXING_SOURCE_DIR" ]] \
    || fail "$slice_name 必须显式提供官方 ZXing-C++ 3.1.1 完整源码目录"
  qr_build="$slice_root/qr-image"
  prepare_safe_directory "$work_dir" "$qr_build" "$slice_name QR 图像构建目录"
  if [[ "$apple_sdk" == macosx ]]; then cmake_system=Darwin; else cmake_system=iOS; fi
  cmake -S "$qr_image_source_root" -B "$qr_build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME="$cmake_system" \
    -DCMAKE_OSX_SYSROOT="$sdk_path" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$minimum_version" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCITIZENSDK_ZXING_SOURCE_DIR="$CITIZENSDK_ZXING_SOURCE_DIR" \
    -DCITIZENSDK_QR_IMAGE_BUILD_TESTS=OFF
  cmake --build "$qr_build" --config Release --target citizensdk_qr_image --parallel
  qr_library="$(find "$qr_build" -type f -name 'libcitizensdk_qr_image.a' -print)"
  zxing_library="$(find "$qr_build" -type f -name 'libZXing.a' -print)"
  [[ -n "$qr_library" && "$qr_library" != *$'\n'* && -f "$qr_library" && ! -L "$qr_library" \
    && -n "$zxing_library" && "$zxing_library" != *$'\n'* \
    && -f "$zxing_library" && ! -L "$zxing_library" ]] \
    || fail "$slice_name ZXing-C++ 静态链接闭包不完整或不唯一"
  swift_command=("$swiftc" "${swift_sources[@]}"
    -parse-as-library \
    -swift-version 5 \
    -warnings-as-errors \
    -strict-concurrency=complete \
    -O \
    -whole-module-optimization \
    -enable-library-evolution \
    -emit-library \
    -emit-module \
    -emit-module-path "$modules/$module_identity.swiftmodule" \
    -emit-module-interface-path "$modules/$module_identity.swiftinterface" \
    -emit-private-module-interface-path "$modules/$module_identity.private.swiftinterface" \
    -module-name CitizenSDK \
    -module-cache-path "$module_cache" \
    -sdk "$sdk_path" \
    -target "$swift_target" \
    -import-underlying-module \
    -F "$slice_root" \
    -I "$work_dir/private-include" \
    -Xcc "-I$framework/Headers" \
    -Xlinker -force_load \
    -Xlinker "$static_library" \
    -Xlinker -force_load \
    -Xlinker "$qr_library" \
    -Xlinker -force_load \
    -Xlinker "$zxing_library" \
    -Xlinker -install_name \
    -Xlinker "$framework_install_name" \
    -framework Security \
    -framework LocalAuthentication \
    -lc++ \
    -lsqlite3)
  # 第一阶段只存在中央 workdir，用于从真实 Swift 编译结果提取本模块 mangled
  # exports；第二阶段才用允许集生成候选 framework。允许集不写入源码或候选。
  probe="$slice_root/CitizenSDK.unfiltered"
  export_list="$slice_root/CitizenSDK.exported-symbols"
  prepare_safe_output_file "$work_dir" "$probe" "$slice_name 未过滤链接"
  "${swift_command[@]}" -o "$probe"
  write_apple_exported_symbols "$probe" "$nm_bin" "$export_list" "$slice_name"
  prepare_safe_output_file "$work_dir" "$framework_binary" "$slice_name framework 二进制"
  "${swift_command[@]}" \
    -Xlinker -exported_symbols_list \
    -Xlinker "$export_list" \
    -o "$framework_binary"
  if [[ "$module_identity" == arm64-apple-macos ]]; then
    prepare_safe_output_file "$work_dir" "$framework/CitizenSDK" \
      "$slice_name framework 标准二进制链接"
    ln -s 'Versions/Current/CitizenSDK' "$framework/CitizenSDK"
    [[ -L "$framework/CitizenSDK" && -e "$framework/CitizenSDK" \
      && "$(readlink "$framework/CitizenSDK")" == 'Versions/Current/CitizenSDK' ]] \
      || fail "$slice_name framework 标准二进制链接创建失败"
  fi
  # 对最终候选中的 textual interface 重新调用 Swift frontend。该 interface
  # 必须通过同名 framework module 解析根 C 头；编译时不使用 bridging header，
  # 从而维持一个 CitizenSDK 混合模块而非第二个 CitizenSDKC 产品。
  prepare_safe_directory "$work_dir" "$module_cache/interface" \
    "$slice_name Swift interface module cache"
  for source in \
    "$modules/$module_identity.swiftinterface" \
    "$modules/$module_identity.private.swiftinterface"; do
    if grep -Eq 'CitizenSDKInternal|citizensdk_internal_' "$source"; then
      fail "$slice_name Swift交付接口泄漏构建期私有依赖"
    fi
    "$swiftc" -frontend \
      -typecheck-module-from-interface "$source" \
      -module-name CitizenSDK \
      -swift-version 5 \
      -warnings-as-errors \
      -strict-concurrency=complete \
      -sdk "$sdk_path" \
      -target "$swift_target" \
      -import-underlying-module \
      -F "$slice_root" \
      -module-cache-path "$module_cache/interface"
  done
}

restore_swift_module_artifacts() {
  local xcframework="$1" build_key module_identity platform variant extension
  local source source_root destination destination_framework destination_root
  while IFS='|' read -r build_key module_identity platform variant; do
    source_root="$work_dir/apple-build/$build_key/CitizenSDK.framework"
    destination_framework="$(resolve_xcframework_framework_slice \
      "$xcframework" CitizenSDK "$platform" "$variant")"
    destination_root="$destination_framework"
    if [[ "$platform" == macos ]]; then
      source_root="$source_root/Versions/A"
      destination_root="$destination_root/Versions/A"
    fi
    # `xcodebuild -create-xcframework` may rewrite or omit compiler-emitted
    # module sidecars. Restore/compare the exact six-file Swift module closure
    # from each already verified input slice, never only the executable module.
    for extension in \
      abi.json private.swiftinterface swiftdoc swiftinterface swiftmodule swiftsourceinfo; do
      source="$source_root/Modules/CitizenSDK.swiftmodule/$module_identity.$extension"
      destination="$destination_root/Modules/CitizenSDK.swiftmodule/$module_identity.$extension"
      [[ -f "$source" && ! -L "$source" ]] \
        || fail "$platform/$variant 输入 framework 缺少 Swift module 产物：$extension"
      if [[ -e "$destination" || -L "$destination" ]]; then
        [[ -f "$destination" && ! -L "$destination" ]] \
          || fail "$platform/$variant XCFramework Swift module 产物不是普通文件：$extension"
        cmp -s "$source" "$destination" \
          || fail "$platform/$variant XCFramework Swift module 产物字节漂移：$extension"
      else
        prepare_safe_output_file "$work_dir" "$destination" \
          "$platform/$variant Swift module 产物投影：$extension"
        cp "$source" "$destination"
      fi
    done
  done <<'MODULES'
aarch64-apple-ios|arm64-apple-ios|ios|
aarch64-apple-ios-sim|arm64-apple-ios-simulator|ios|simulator
aarch64-apple-darwin|arm64-apple-macos|macos|
MODULES
}

verify_apple_framework_slice() {
  local framework="$1" label="$2" expected_platform="$3" expected_minos="$4"
  local module_identity="$5" framework_content_root framework_plist framework_resources binary nm_bin
  local architectures install_name expected_install_name build_info links top_entries version_entries
  local actual_platform actual_minos entries expected_entries swift_modules module_entries
  local bundle_platform platform_name minimum_key software_version expected_plist
  [[ -d "$framework" && ! -L "$framework" ]] || fail "$label framework 缺失"
  entries="$(find "$(dirname "$framework")" -mindepth 1 -maxdepth 1 -print \
    | sed 's#^.*/##' | LC_ALL=C sort)"
  [[ "$entries" == CitizenSDK.framework ]] \
    || fail "$label slice 目录闭集漂移：${entries:-无}"
  if [[ "$module_identity" == arm64-apple-macos ]]; then
    top_entries="$(find "$framework" -mindepth 1 -maxdepth 1 -print \
      | sed 's#^.*/##' | LC_ALL=C sort)"
    [[ "$top_entries" == $'CitizenSDK\nHeaders\nModules\nResources\nVersions' ]] \
      || fail "$label 版本化 framework 顶层闭集漂移"
    version_entries="$(find "$framework/Versions" -mindepth 1 -maxdepth 1 -print \
      | sed 's#^.*/##' | LC_ALL=C sort)"
    [[ "$version_entries" == $'A\nCurrent' ]] \
      || fail "$label Versions 闭集漂移"
    links="$(find "$framework" -type l -print \
      | sed "s#^$framework/##" | LC_ALL=C sort)"
    [[ "$links" == $'CitizenSDK\nHeaders\nModules\nResources\nVersions/Current' ]] \
      || fail "$label 标准内部符号链接闭集漂移：${links:-无}"
    while IFS='|' read -r link_path link_target; do
      [[ -L "$framework/$link_path" \
        && "$(readlink "$framework/$link_path")" == "$link_target" \
        && -e "$framework/$link_path" ]] \
        || fail "$label 标准内部符号链接漂移：$link_path"
    done <<'MACOS_FRAMEWORK_LINKS'
CitizenSDK|Versions/Current/CitizenSDK
Headers|Versions/Current/Headers
Modules|Versions/Current/Modules
Resources|Versions/Current/Resources
Versions/Current|A
MACOS_FRAMEWORK_LINKS
    framework_content_root="$framework/Versions/A"
    entries="$(find "$framework_content_root" -mindepth 1 -maxdepth 1 -print \
      | sed 's#^.*/##' | LC_ALL=C sort)"
    [[ "$entries" == $'CitizenSDK\nHeaders\nModules\nResources' ]] \
      || fail "$label Versions/A 内容闭集漂移"
    framework_plist="$framework_content_root/Resources/Info.plist"
    framework_resources="$framework_content_root/Resources"
  else
    [[ -z "$(find "$framework" -type l -print -quit)" ]] \
      || fail "$label shallow framework 禁止符号链接"
    top_entries="$(find "$framework" -mindepth 1 -maxdepth 1 -print \
      | sed 's#^.*/##' | LC_ALL=C sort)"
    [[ "$top_entries" == $'CitizenSDK\nHeaders\nInfo.plist\nModules\nPrivacyInfo.xcprivacy\nchain' ]] \
      || fail "$label shallow framework 顶层闭集漂移"
    framework_content_root="$framework"
    framework_plist="$framework/Info.plist"
    framework_resources="$framework_content_root"
  fi
  binary="$framework_content_root/CitizenSDK"
  [[ -f "$binary" && ! -L "$binary" ]] || fail "$label framework 二进制缺失"
  architectures="$(xcrun lipo -archs "$binary")"
  [[ "$architectures" == arm64 ]] || fail "$label 内部架构必须精确为 arm64；实际=$architectures"
  install_name="$(xcrun otool -D "$binary" | tail -n +2 | sed '/^[[:space:]]*$/d')"
  if [[ "$module_identity" == arm64-apple-macos ]]; then
    expected_install_name='@rpath/CitizenSDK.framework/Versions/A/CitizenSDK'
  else
    expected_install_name='@rpath/CitizenSDK.framework/CitizenSDK'
  fi
  [[ "$install_name" == "$expected_install_name" ]] \
    || fail "$label install name 漂移：${install_name:-无}"
  build_info="$(xcrun vtool -show-build "$binary")"
  actual_platform="$(printf '%s\n' "$build_info" | awk '$1 == "platform" { print $2 }')"
  actual_minos="$(printf '%s\n' "$build_info" | awk '$1 == "minos" { print $2 }')"
  [[ "$actual_platform" == "$expected_platform" && "$actual_minos" == "$expected_minos" ]] \
    || fail "$label 平台/最低版本漂移：$actual_platform/$actual_minos"
  nm_bin="$(xcrun --find nm)"
  verify_apple_product_abi_symbols "$binary" "$nm_bin" "$label"

  [[ -d "$framework_content_root/Headers" \
    && ! -L "$framework_content_root/Headers" ]] \
    || fail "$label Headers 不是普通目录"
  entries="$(find "$framework_content_root/Headers" -mindepth 1 -maxdepth 1 -print \
    | sed 's#^.*/##' | LC_ALL=C sort)"
  expected_entries=$'citizensdk.h\ncitizensdk_qr_image.h\ncitizensdk_types.h'
  [[ "$entries" == "$expected_entries" ]] || fail "$label 产品头闭集漂移"
  [[ -f "$framework_content_root/Headers/citizensdk.h" \
    && ! -L "$framework_content_root/Headers/citizensdk.h" \
    && -f "$framework_content_root/Headers/citizensdk_types.h" \
    && ! -L "$framework_content_root/Headers/citizensdk_types.h" \
    && -f "$framework_content_root/Headers/citizensdk_qr_image.h" \
    && ! -L "$framework_content_root/Headers/citizensdk_qr_image.h" ]] \
    || fail "$label 产品头必须全部为普通文件"
  cmp -s "$framework_content_root/Headers/citizensdk.h" "$product_header" \
    || fail "$label citizensdk.h 与根产品头不一致"
  cmp -s "$framework_content_root/Headers/citizensdk_types.h" "$product_types_header" \
    || fail "$label citizensdk_types.h 与根产品头不一致"
  cmp -s "$framework_content_root/Headers/citizensdk_qr_image.h" "$qr_image_header" \
    || fail "$label citizensdk_qr_image.h 与统一图像头不一致"
  [[ -d "$framework_content_root/Modules" \
    && ! -L "$framework_content_root/Modules" ]] \
    || fail "$label Modules 不是普通目录"
  module_entries="$(find "$framework_content_root/Modules" \
    -mindepth 1 -maxdepth 1 -print | sed 's#^.*/##' | LC_ALL=C sort)"
  [[ "$module_entries" == $'CitizenSDK.swiftmodule\nmodule.modulemap' \
    && -f "$framework_content_root/Modules/module.modulemap" \
    && ! -L "$framework_content_root/Modules/module.modulemap" \
    && -d "$framework_content_root/Modules/CitizenSDK.swiftmodule" \
    && ! -L "$framework_content_root/Modules/CitizenSDK.swiftmodule" ]] \
    || fail "$label Modules 节点闭集或类型漂移"
  grep -Fq 'framework module CitizenSDK' "$framework_content_root/Modules/module.modulemap" \
    || fail "$label 缺少 CitizenSDK Clang module"
  swift_modules="$(find "$framework_content_root/Modules/CitizenSDK.swiftmodule" \
    -mindepth 1 -maxdepth 1 -print | sed 's#^.*/##' | LC_ALL=C sort)"
  expected_entries="$(printf '%s\n' \
    "$module_identity.abi.json" \
    "$module_identity.private.swiftinterface" \
    "$module_identity.swiftdoc" \
    "$module_identity.swiftinterface" \
    "$module_identity.swiftmodule" \
    "$module_identity.swiftsourceinfo" | LC_ALL=C sort)"
  [[ "$swift_modules" == "$expected_entries" ]] \
    || fail "$label Swift module 六文件闭集漂移"
  for interface in \
    "$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.swiftinterface" \
    "$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.private.swiftinterface"; do
    grep -Fxq '@_exported import CitizenSDK' "$interface" \
      || fail "$label Swift interface 未固定同名 underlying Clang module"
  done
  grep -Fq '@_spi(CitizenSDKFlutter)' \
    "$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_identity.private.swiftinterface" \
    || fail "$label private Swift interface 缺少 CitizenSDKFlutter SPI"
  while IFS= read -r module_file; do
    [[ -f "$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_file" \
      && ! -L "$framework_content_root/Modules/CitizenSDK.swiftmodule/$module_file" ]] \
      || fail "$label Swift module 必须全部为普通文件：$module_file"
  done <<<"$swift_modules"
  [[ -d "$framework_resources/chain" \
    && ! -L "$framework_resources/chain" ]] \
    || fail "$label chain 不是普通目录"
  if [[ "$module_identity" == arm64-apple-macos ]]; then
    [[ -d "$framework_resources" && ! -L "$framework_resources" ]] \
      || fail "$label Resources 不是普通目录"
    entries="$(find "$framework_resources" -mindepth 1 -print \
      | sed "s#^$framework_resources/##" | LC_ALL=C sort)"
    expected_entries=$'Info.plist\nPrivacyInfo.xcprivacy\nchain\nchain/chainspec.json\nchain/light_sync_state.json\nchain/manifest.json'
  else
    entries="$(find "$framework_resources/chain" -mindepth 1 -maxdepth 1 -print \
      | sed 's#^.*/##' | LC_ALL=C sort)"
    expected_entries=$'chainspec.json\nlight_sync_state.json\nmanifest.json'
  fi
  [[ "$entries" == "$expected_entries" ]] || fail "$label 资源闭集漂移"
  for asset in chainspec.json light_sync_state.json manifest.json; do
    [[ -f "$framework_resources/chain/$asset" \
      && ! -L "$framework_resources/chain/$asset" ]] \
      || fail "$label 链资产不是普通文件：$asset"
    cmp -s "$framework_resources/chain/$asset" "$apple_asset_root/$asset" \
      || fail "$label 链资产字节漂移：$asset"
  done
  [[ -f "$framework_resources/PrivacyInfo.xcprivacy" \
    && ! -L "$framework_resources/PrivacyInfo.xcprivacy" \
    && -f "$framework_plist" && ! -L "$framework_plist" ]] \
    || fail "$label 隐私清单或 Info.plist 不是普通文件"
  cmp -s "$framework_resources/PrivacyInfo.xcprivacy" \
    "$darwin_source_root/PrivacyInfo.xcprivacy" \
    || fail "$label 隐私清单字节漂移"
  case "$module_identity" in
    arm64-apple-ios)
      bundle_platform=iPhoneOS; platform_name=iphoneos; minimum_key=MinimumOSVersion ;;
    arm64-apple-ios-simulator)
      bundle_platform=iPhoneSimulator; platform_name=iphonesimulator; minimum_key=MinimumOSVersion ;;
    arm64-apple-macos)
      bundle_platform=MacOSX; platform_name=macosx; minimum_key=LSMinimumSystemVersion ;;
    *) fail "$label Swift module identity 未登记：$module_identity" ;;
  esac
  software_version="$(sed -n 's/^version: \([0-9][0-9.]*\)$/\1/p' "$sdk_dir/pubspec.yaml")"
  expected_plist="$work_dir/apple-plist-contract/$module_identity.plist"
  if [[ ! -e "$expected_plist" && ! -L "$expected_plist" ]]; then
    prepare_safe_output_file "$work_dir" "$expected_plist" "$label Info.plist 合同"
    write_framework_plist "$expected_plist" "$bundle_platform" "$platform_name" \
      "$minimum_key" "$expected_minos" "$software_version"
  fi
  cmp -s \
    <(/usr/bin/plutil -convert binary1 -o - "$framework_plist") \
    <(/usr/bin/plutil -convert binary1 -o - "$expected_plist") \
    || fail "$label Info.plist 完整字段合同漂移"
}

verify_apple_xcframework() {
  local xcframework="$1" entries expected_entries index identifier library_path
  local binary_path expected_binary_path architecture extra_architecture platform variant
  local metadata expected_metadata plist_keys library_keys expected_library_keys
  local identifiers='' ios_device_identifier='' ios_simulator_identifier=''
  local macos_identifier=''
  [[ -d "$xcframework" && ! -L "$xcframework" ]] \
    || fail "CitizenSDK.xcframework 缺失或不是普通目录"
  [[ -f "$xcframework/Info.plist" && ! -L "$xcframework/Info.plist" ]] \
    || fail "CitizenSDK.xcframework 缺少普通 Info.plist"
  plist_keys="$(/usr/libexec/PlistBuddy -c Print "$xcframework/Info.plist" \
    | awk '/^    [^ ]/ && / = / { print $1 }' | LC_ALL=C sort)"
  [[ "$plist_keys" == $'AvailableLibraries\nCFBundlePackageType\nXCFrameworkFormatVersion' \
    && "$(/usr/libexec/PlistBuddy -c 'Print :XCFrameworkFormatVersion' \
      "$xcframework/Info.plist")" == 1.0 ]] \
    || fail "XCFramework Info.plist 根字段闭集或格式版本漂移"
  metadata=''
  for index in 0 1 2; do
    identifier="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:LibraryIdentifier" \
      "$xcframework/Info.plist")"
    library_path="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:LibraryPath" \
      "$xcframework/Info.plist")"
    binary_path="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:BinaryPath" \
      "$xcframework/Info.plist")"
    architecture="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:SupportedArchitectures:0" \
      "$xcframework/Info.plist")"
    extra_architecture="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:SupportedArchitectures:1" \
      "$xcframework/Info.plist" 2>/dev/null || true)"
    platform="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:SupportedPlatform" \
      "$xcframework/Info.plist")"
    variant="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index:SupportedPlatformVariant" \
      "$xcframework/Info.plist" 2>/dev/null || true)"
    [[ "$identifier" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ \
      && -d "$xcframework/$identifier" && ! -L "$xcframework/$identifier" ]] \
      || fail "XCFramework LibraryIdentifier 必须是 Xcode 生成的安全不透明目录标识：$identifier"
    if printf '%s\n' "$identifiers" | grep -Fxq "$identifier"; then
      fail "XCFramework LibraryIdentifier 重复：$identifier"
    fi
    identifiers+="$identifier"$'\n'
    library_keys="$(/usr/libexec/PlistBuddy \
      -c "Print :AvailableLibraries:$index" "$xcframework/Info.plist" \
      | awk '/^    [^ ]/ && / = / { print $1 }' | LC_ALL=C sort)"
    if [[ -n "$variant" ]]; then
      expected_library_keys=$'BinaryPath\nLibraryIdentifier\nLibraryPath\nSupportedArchitectures\nSupportedPlatform\nSupportedPlatformVariant'
    else
      expected_library_keys=$'BinaryPath\nLibraryIdentifier\nLibraryPath\nSupportedArchitectures\nSupportedPlatform'
    fi
    [[ "$library_keys" == "$expected_library_keys" ]] \
      || fail "XCFramework slice 字段闭集漂移：$identifier"
    case "$platform/$variant" in
      ios/)
        [[ -z "$ios_device_identifier" ]] \
          || fail "XCFramework 重复声明 iOS 设备技术变体"
        ios_device_identifier="$identifier"
        expected_binary_path='CitizenSDK.framework/CitizenSDK'
        ;;
      ios/simulator)
        [[ -z "$ios_simulator_identifier" ]] \
          || fail "XCFramework 重复声明 iOS simulator 技术变体"
        ios_simulator_identifier="$identifier"
        expected_binary_path='CitizenSDK.framework/CitizenSDK'
        ;;
      macos/)
        [[ -z "$macos_identifier" ]] \
          || fail "XCFramework 重复声明 macOS"
        macos_identifier="$identifier"
        expected_binary_path='CitizenSDK.framework/Versions/A/CitizenSDK'
        ;;
      *) fail "XCFramework 含未登记 Apple 技术变体：$platform/$variant" ;;
    esac
    [[ "$library_path" == CitizenSDK.framework && "$architecture" == arm64 \
      && "$binary_path" == "$expected_binary_path" && -z "$extra_architecture" ]] \
      || fail "XCFramework slice 必须精确为单一 arm64 framework：$identifier"
    metadata+="$platform|$variant"$'\n'
  done
  metadata="$(printf '%s' "$metadata" | LC_ALL=C sort)"
  expected_metadata=$'ios|\nios|simulator\nmacos|'
  [[ "$metadata" == "$expected_metadata" ]] \
    || fail "XCFramework Info.plist 三 slice 元数据漂移"
  [[ -n "$ios_device_identifier" && -n "$ios_simulator_identifier" \
    && -n "$macos_identifier" ]] \
    || fail "XCFramework 必须覆盖 iOS 设备、iOS simulator 技术变体和 macOS"
  # LibraryIdentifier 是 xcodebuild 生成的不透明技术标识，不得改写为
  # 产品平台名。目录闭集只从 Info.plist 反向发现。
  entries="$(find "$xcframework" -mindepth 1 -maxdepth 1 -print \
    | sed 's#^.*/##' | LC_ALL=C sort)"
  expected_entries="$(printf '%s\n' Info.plist "$ios_device_identifier" \
    "$ios_simulator_identifier" "$macos_identifier" | LC_ALL=C sort)"
  [[ "$entries" == "$expected_entries" ]] \
    || fail "CitizenSDK.xcframework slice 闭集漂移：${entries:-无}"
  [[ -z "$(find "$xcframework/$ios_device_identifier" \
    "$xcframework/$ios_simulator_identifier" -type l -print -quit)" ]] \
    || fail "CitizenSDK.xcframework 的 iOS 技术变体禁止符号链接"
  while IFS= read -r link; do
    case "$link" in
      "$xcframework/$macos_identifier/CitizenSDK.framework/CitizenSDK"|\
      "$xcframework/$macos_identifier/CitizenSDK.framework/Headers"|\
      "$xcframework/$macos_identifier/CitizenSDK.framework/Modules"|\
      "$xcframework/$macos_identifier/CitizenSDK.framework/Resources"|\
      "$xcframework/$macos_identifier/CitizenSDK.framework/Versions/Current") ;;
      *) fail "CitizenSDK.xcframework 含未登记符号链接：$link" ;;
    esac
  done < <(find "$xcframework" -type l -print)
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' \
    "$xcframework/Info.plist")" == XFWK ]] \
    || fail "XCFramework Info.plist 产品类型必须是 XFWK"
  /usr/libexec/PlistBuddy -c 'Print :AvailableLibraries:3' \
    "$xcframework/Info.plist" >/dev/null 2>&1 \
    && fail "XCFramework Info.plist 含额外 slice" || true
  verify_apple_framework_slice \
    "$xcframework/$ios_device_identifier/CitizenSDK.framework" \
    "CitizenSDK iOS（设备技术变体）" IOS 16.0 arm64-apple-ios
  verify_apple_framework_slice \
    "$xcframework/$ios_simulator_identifier/CitizenSDK.framework" \
    "CitizenSDK iOS（simulator 技术变体）" IOSSIMULATOR 16.0 \
    arm64-apple-ios-simulator
  verify_apple_framework_slice \
    "$xcframework/$macos_identifier/CitizenSDK.framework" \
    "CitizenSDK macOS" MACOS 13.0 arm64-apple-macos
}

build_apple() {
  [[ "$(uname -s)" == Darwin ]] || fail "Apple 产品只允许在 macOS runner 构建"
  local create_root created_xcframework destination flutter_root
  local flutter_ios_xcframework flutter_macos_xcframework
  local citizen_ios_framework citizen_ios_simulator_framework citizen_macos_framework
  command -v xcodebuild >/dev/null 2>&1 || fail "缺少 xcodebuild"
  build_apple_framework_slice \
    aarch64-apple-ios iphoneos arm64-apple-ios16.0 aarch64-apple-ios \
    arm64-apple-ios iPhoneOS iphoneos MinimumOSVersion "$ios_deployment_target"
  build_apple_framework_slice \
    aarch64-apple-ios-sim iphonesimulator arm64-apple-ios16.0-simulator \
    aarch64-apple-ios-sim arm64-apple-ios-simulator iPhoneSimulator iphonesimulator \
    MinimumOSVersion "$ios_deployment_target"
  build_apple_framework_slice \
    aarch64-apple-darwin macosx arm64-apple-macosx13.0 aarch64-apple-darwin \
    arm64-apple-macos MacOSX macosx LSMinimumSystemVersion "$macos_deployment_target"

  create_root="$work_dir/apple-xcframework"
  prepare_safe_directory "$work_dir" "$create_root" "Apple XCFramework 生成目录"
  created_xcframework="$create_root/CitizenSDK.xcframework"
  [[ ! -e "$created_xcframework" && ! -L "$created_xcframework" ]] \
    || fail "Apple XCFramework 生成目标已存在"
  xcodebuild -create-xcframework \
    -framework "$work_dir/apple-build/aarch64-apple-ios/CitizenSDK.framework" \
    -framework "$work_dir/apple-build/aarch64-apple-ios-sim/CitizenSDK.framework" \
    -framework "$work_dir/apple-build/aarch64-apple-darwin/CitizenSDK.framework" \
    -output "$created_xcframework"
  # Xcode 27 在存在 stable interface 时会从 create-xcframework 输出中移除
  # 编译 `.swiftmodule`。从三个已经逐 slice 验证的输入 framework 原字节恢复，
  # 让同编译器快速路径与跨编译器 textual interface 同时进入唯一产品。
  restore_swift_module_artifacts "$created_xcframework"
  verify_apple_xcframework "$created_xcframework"

  flutter_root="$(resolve_flutter_sdk_root)"
  flutter_ios_xcframework="$flutter_root/bin/cache/artifacts/engine/ios-release/Flutter.xcframework"
  flutter_macos_xcframework="$(resolve_flutter_macos_xcframework "$flutter_root")"
  citizen_ios_framework="$(resolve_xcframework_framework_slice \
    "$created_xcframework" CitizenSDK ios '')"
  citizen_ios_simulator_framework="$(resolve_xcframework_framework_slice \
    "$created_xcframework" CitizenSDK ios simulator)"
  citizen_macos_framework="$(resolve_xcframework_framework_slice \
    "$created_xcframework" CitizenSDK macos '')"
  compile_apple_flutter_adapter iphoneos arm64-apple-ios16.0 aarch64-apple-ios \
    ios '' Flutter "$flutter_ios_xcframework" "$(dirname "$citizen_ios_framework")"
  compile_apple_flutter_adapter iphonesimulator arm64-apple-ios16.0-simulator \
    aarch64-apple-ios-sim ios simulator Flutter "$flutter_ios_xcframework" \
    "$(dirname "$citizen_ios_simulator_framework")"
  compile_apple_flutter_adapter macosx arm64-apple-macosx13.0 \
    aarch64-apple-darwin macos '' FlutterMacOS "$flutter_macos_xcframework" \
    "$(dirname "$citizen_macos_framework")"

  destination="$output_dir/apple/CitizenSDK.xcframework"
  prepare_safe_directory "$output_dir" "$(dirname "$destination")" \
    "Apple 产品父目录"
  [[ ! -e "$destination" && ! -L "$destination" ]] \
    || fail "Apple 产品目标已存在：$destination"
  cp -R "$created_xcframework" "$destination"
  verify_apple_xcframework "$destination"
  echo "CitizenSDK iOS/macOS XCFramework 完成：$destination"
}

linux_platform_contract() {
  local platform="$1" expected_arch rust_target
  [[ "$(uname -s)" == Linux ]] \
    || fail "$platform 只允许在匹配的原生 Linux runner 构建"
  case "$platform" in
    LinuxARM)
      expected_arch=aarch64
      rust_target=aarch64-unknown-linux-gnu
      ;;
    LinuxAMD)
      expected_arch=x86_64
      rust_target=x86_64-unknown-linux-gnu
      ;;
    *) fail "未登记的 Linux 平台：$platform" ;;
  esac
  [[ "$(uname -m)" == "$expected_arch" ]] \
    || fail "$platform 必须在 $expected_arch 原生 runner 构建；实际=$(uname -m)"
  printf '%s|%s\n' "$rust_target" "$expected_arch"
}

verify_linux_ctest_inventory() {
  local ctest_bin="$1" directory="$2" label="$3" expected="$4" inventory count
  local variable names actual
  case "$label:$expected" in
    LinuxHost:12) variable=CITIZENSDK_LINUX_CONTRACT_TESTS ;;
    LinuxFlutter:6) variable=CITIZENSDK_LINUX_FLUTTER_CONTRACT_TESTS ;;
    LinuxConsumer:2) variable='' ;;
    *) fail "未登记的 Linux CTest 闭集：$label/$expected" ;;
  esac
  if [[ -n "$variable" ]]; then
    names="$(CITIZENSDK_CTEST_LIST="$variable" perl -0777 -ne '
      my $name = $ENV{CITIZENSDK_CTEST_LIST};
      my @lists = /set\(\Q$name\E\s+([^)]*)\)/g;
      die "CTest source list must be unique\n" unless @lists == 1;
      my @names = grep { length } split /\s+/, $lists[0];
      for (@names) { die "Invalid CTest source name\n" unless /^citizen_sdk_[a-z0-9_]+_test$/; }
      print join("\n", map { "CitizenSDK.Linux.$_" } @names), "\n";
      exit;
    ' "$linux_source_root/test/CMakeLists.txt")" \
      || fail "无法读取 $label 唯一源码测试名单"
  else
    names=$'CitizenSDK.Linux.CConsumer\nCitizenSDK.Linux.CppConsumer'
  fi
  [[ "$(printf '%s\n' "$names" | wc -l | tr -d ' ')" == "$expected" \
      && "$(printf '%s\n' "$names" | LC_ALL=C sort | uniq -d)" == '' ]] \
    || fail "$label 源码测试名单数量或唯一性漂移"
  inventory="$("$ctest_bin" --test-dir "$directory" -N -L "^$label$" 2>&1)" \
    || fail "无法枚举 $label CTest 合同"
  count="$(printf '%s\n' "$inventory" | sed -n 's/^Total Tests: \([0-9][0-9]*\)$/\1/p')"
  [[ "$count" == "$expected" ]] \
    || fail "$label CTest 数量必须为 ${expected}；实际=${count:-无}"
  actual="$(printf '%s\n' "$inventory" \
    | sed -n 's/^[[:space:]]*Test[[:space:]]*#[0-9][0-9]*:[[:space:]]*//p' \
    | LC_ALL=C sort)"
  [[ "$actual" == "$(printf '%s\n' "$names" | LC_ALL=C sort)" ]] \
    || fail "$label CTest 名称闭集不一致；拒绝替换、重复或遗漏"
}

verify_linux_runtime_resolution() {
  local executable="$1" runtime_dir="$2" resolution library resolved
  resolution="$(LC_ALL=C ldd "$executable" 2>&1)" \
    || fail "无法解析 Linux 消费者的真实动态运行依赖"
  ! printf '%s\n' "$resolution" | grep -Fq 'not found' \
    || fail "Linux 消费者存在未解析的动态依赖"
  for library in libcitizensdk.so libcitizensdk_host.so; do
    resolved="$(printf '%s\n' "$resolution" | awk -v name="$library" '$1 == name && $2 == "=>" { print $3 }')"
    [[ "$resolved" == "$runtime_dir/$library" ]] \
      || fail "Linux 消费者没有解析到本轮唯一的 $library"
  done
}

verify_linux_tool_tree() {
  local root="$1" label="$2" entry target resolved
  assert_readonly_dependency_directory "$root" "$label"
  [[ -z "$(find "$root" ! -type f ! -type d ! -type l -print -quit)" ]] \
    || fail "$label 禁止特殊文件"
  [[ -z "$(find "$root" -type f -name .git -print -quit)" ]] \
    || fail "$label 禁止指向外部 worktree 的 .git 文件"
  while IFS= read -r -d '' entry; do
    target="$(readlink "$entry")" || fail "$label 无法读取符号链接"
    [[ "$target" != /* ]] || fail "$label 禁止绝对符号链接"
    resolved="$(realpath -e "$entry")" || fail "$label 禁止悬空符号链接"
    case "$resolved/" in "$root/"*) ;; *) fail "$label 符号链接越界" ;; esac
  done < <(find "$root" -type l -print0)
}

verify_linux_flutter_cache() {
  local root="$1" platform="$2" arch revision name expected path
  case "$platform" in LinuxARM) arch=arm64 ;; LinuxAMD) arch=x64 ;; *) fail "未登记的 Linux 平台：$platform" ;; esac
  verify_linux_tool_tree "$root" "$platform Flutter SDK"
  [[ -d "$root/.git" && ! -L "$root/.git" ]] || fail "Flutter SDK 必须是预装的完整普通目录"
  for path in bin/cache/flutter_tools.snapshot bin/cache/flutter_tools.stamp \
      bin/cache/flutter.version.json bin/cache/engine.stamp bin/internal/engine.version \
      packages/flutter_tools/pubspec.yaml packages/flutter_tools/pubspec.lock \
      bin/cache/dart-sdk/bin/dart \
      bin/cache/pkg/sky_engine/pubspec.yaml bin/cache/pkg/flutter_gpu/pubspec.yaml \
      bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill \
      bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill \
      "bin/cache/artifacts/engine/linux-$arch/font-subset" \
      "bin/cache/artifacts/engine/linux-$arch/icudtl.dat" \
      "bin/cache/artifacts/engine/linux-$arch-release/gen_snapshot"; do
    [[ -f "$root/$path" && ! -L "$root/$path" && -s "$root/$path" ]] \
      || fail "$platform 缺少已缓存 Flutter 文件：${path}；禁止自动下载"
  done
  revision="$(<"$root/bin/cache/engine.stamp")"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "Flutter engine.stamp 格式无效"
  [[ "$(<"$root/bin/internal/engine.version")" == "$revision" ]] \
    || fail "$platform Flutter 源码 engine.version 与已有缓存不同；禁止自动升级"
  for name in flutter_sdk linux-sdk font-subset; do
    [[ -f "$root/bin/cache/$name.stamp" && ! -L "$root/bin/cache/$name.stamp" \
        && "$(<"$root/bin/cache/$name.stamp")" == "$revision" ]] \
      || fail "$platform Flutter $name 缓存版本不完整；禁止自动更新"
  done
  for name in material_fonts gradle_wrapper; do
    [[ -f "$root/bin/internal/$name.version" && -f "$root/bin/cache/$name.stamp" ]] \
      || fail "$platform Flutter $name 缓存未预装"
    expected="$(<"$root/bin/internal/$name.version")"
    [[ "$(<"$root/bin/cache/$name.stamp")" == "$expected" \
        && -d "$root/bin/cache/artifacts/$name" ]] \
      || fail "$platform Flutter $name 缓存版本不完整"
  done
  # 官方 LinuxEngineArtifacts 会同时检查三个目录；即使这里只构建 Release，
  # 也不能留缺项诱使 Flutter build 自动取得其它运行件。ICU 是无 mode 的
  # 通用 host artifact（上面已核验），不要求 profile/release 各自含一份。
  for name in "linux-$arch" "linux-$arch-profile" "linux-$arch-release"; do
    for path in libflutter_linux_gtk.so flutter_linux/flutter_linux.h gen_snapshot; do
      [[ -f "$root/bin/cache/artifacts/engine/$name/$path" \
          && ! -L "$root/bin/cache/artifacts/engine/$name/$path" ]] \
        || fail "$platform Flutter $name/$path 缓存缺失"
    done
  done
  perl -MJSON::PP -e '
    use strict; use warnings;
    my ($root, $engine) = @ARGV;
    open my $input, "<", "$root/bin/cache/flutter.version.json" or die "Flutter version missing\n";
    local $/; my $version = decode_json(<$input>);
    die "Flutter engine revision mismatch\n" unless $version->{engineRevision} eq $engine;
    die "Flutter framework revision invalid\n" unless $version->{frameworkRevision} =~ /^[0-9a-f]{40}$/;
    open my $stamp, "<", "$root/bin/cache/flutter_tools.stamp" or die "Flutter tools stamp missing\n";
    my $value = <$stamp>; $value =~ s/\s+\z//;
    die "Flutter snapshot version mismatch\n" unless $value eq "$version->{frameworkRevision}:";
  ' "$root" "$revision" || fail "$platform Flutter snapshot/版本身份不一致"
}

verify_linux_flutter_elf() {
  local platform="$1" bundle="$2" prefix="$3" readelf_bin="$4" nm_bin="$5"
  local machine plugin needed symbols rpath runpath library
  case "$platform" in LinuxARM) machine=AArch64 ;; LinuxAMD) machine='Advanced Micro Devices X86-64' ;; *) fail "未登记的 Linux 平台：$platform" ;; esac
  [[ -d "$bundle" && ! -L "$bundle" ]] || fail "$platform Flutter bundle 缺失"
  [[ -z "$(find "$bundle" ! -type d ! -type f -print -quit)" ]] \
    || fail "$platform Flutter bundle 禁止符号链接或特殊节点"
  for library in libcitizensdk.so libcitizensdk_host.so; do
    cmp -s "$prefix/lib/$platform/$library" "$bundle/lib/$library" \
      || fail "$platform Flutter bundle 的 $library 不是同版安装运行件"
  done
  verify_linux_elf_identity "$platform" "$bundle/lib/libcitizensdk.so" \
    "$bundle/lib/libcitizensdk_host.so" "$readelf_bin" "$nm_bin"
  plugin="$bundle/lib/libcitizen_sdk_plugin.so"
  for library in "$bundle/citizensdk_consumer" "$plugin" "$bundle/lib/libflutter_linux_gtk.so" "$bundle/lib/libapp.so"; do
    [[ -f "$library" && ! -L "$library" ]] || fail "$platform Flutter bundle 运行闭包不完整"
    verify_linux_machine "$library" "$readelf_bin" "$machine" "$platform Flutter $(basename "$library")"
    # Flutter engine 是官方运行件，不能把它的 C++ ABI 误称 SDK 自身静态闭包。
    if [[ "$library" == "$bundle/lib/libflutter_linux_gtk.so" ]]; then
      verify_linux_glibc_contract "$library" "$readelf_bin" "$platform Flutter engine" true
    else
      verify_linux_glibc_contract "$library" "$readelf_bin" "$platform Flutter $(basename "$library")"
    fi
    needed="$(linux_elf_dynamic_values "$library" "$readelf_bin" NEEDED)"
    [[ "$needed" != */* ]] || fail "$platform Flutter DT_NEEDED 禁止构建路径"
  done
  symbols="$(product_library_symbols "$plugin" "$nm_bin" '')"
  [[ "$symbols" == citizen_sdk_plugin_register_with_registrar ]] \
    || fail "$platform Flutter plugin 只能导出官方注册入口，不得复制 Core/Host"
  needed="$(linux_elf_dynamic_values "$plugin" "$readelf_bin" NEEDED)"
  for library in libcitizensdk.so libcitizensdk_host.so libflutter_linux_gtk.so; do
    [[ "$(printf '%s\n' "$needed" | grep -Fxc "$library" || true)" == 1 ]] \
      || fail "$platform Flutter plugin 必须精确依赖一次 $library"
  done
  if printf '%s\n' "$needed" | grep -Eq '^(libsmoldot|libstdc\+\+|libgcc_s|libsqlite3|libtss2-|libcrypto|libssl)'; then
    fail "$platform Flutter plugin 泄漏禁止的动态依赖"
  fi
  rpath="$(linux_elf_dynamic_values "$plugin" "$readelf_bin" RPATH)"
  runpath="$(linux_elf_dynamic_values "$plugin" "$readelf_bin" RUNPATH)"
  [[ -z "$rpath" && "$runpath" == '$ORIGIN' ]] || fail "$platform Flutter plugin RUNPATH 必须精确为 \$ORIGIN"
  rpath="$(linux_elf_dynamic_values "$bundle/citizensdk_consumer" "$readelf_bin" RPATH)"
  runpath="$(linux_elf_dynamic_values "$bundle/citizensdk_consumer" "$readelf_bin" RUNPATH)"
  [[ -z "$rpath" && "$runpath" == '$ORIGIN/lib' ]] || fail "$platform Flutter runner RUNPATH 必须精确为 \$ORIGIN/lib"
  for library in manifest.json chainspec.json light_sync_state.json; do
    cmp -s "$prefix/share/citizensdk/chain/$library" \
      "$bundle/data/flutter_assets/packages/citizen_sdk/chain/$library" \
      || fail "$platform Flutter bundle 链资产漂移：$library"
  done
}

build_linux_flutter_consumer() (
  local platform="$1" platform_work="$2" prefix="$3" cmake_bin="$4" ctest_bin="$5"
  local readelf_bin="$6" nm_bin="$7" flutter_source="${CITIZENSDK_FLUTTER_ROOT:-}"
  local cache_source="${PUB_CACHE:-}" root tool_root cache_root sdk_stage runner dart_bin
  local arch flutter_build bundle path output status unshare_bin
  local package="${8:-}" candidate="${9:-$sdk_dir}"
  case "$platform" in LinuxARM) arch=arm64 ;; LinuxAMD) arch=x64 ;; *) fail "未登记的 Linux 平台：$platform" ;; esac
  for path in ninja clang clang++ unshare timeout realpath perl; do
    command -v "$path" >/dev/null 2>&1 || fail "$platform Flutter 验收缺少已预装工具：$path"
  done
  # Flutter/Dart 的部分设置与 telemetry 仍会直接访问现有 HOME，不遵循
  # XDG。只接受调用环境已隔离好的 HOME；本脚本绝不设置 HOME、创建用户
  # 或挂载文件系统。未满足时，在任何 Dart/Flutter 命令执行前失败关闭。
  [[ -n "${HOME:-}" ]] || fail "$platform 未提供获准的隔离 HOME 环境"
  assert_safe_directory_path "$HOME" "$platform 已有工具 HOME"
  case "$HOME/" in "$work_dir/"*) ;; *) fail "$platform 已有 HOME 必须位于本轮中央 work_dir；请提供获准隔离环境" ;; esac
  [[ -d "$HOME" && ! -L "$HOME" \
      && "$(stat -c '%a' "$HOME")" == 700 \
      && "$(stat -c '%u' "$HOME")" == "$(id -u)" ]] \
    || fail "$platform 已有 HOME 必须是当前用户所有的普通 0700 目录"
  verify_linux_tool_tree "$HOME" "$platform 已有工具 HOME"
  [[ ! -e "$HOME/.flutter_settings" && ! -L "$HOME/.flutter_settings" ]] \
    || fail "$platform 隔离 HOME 不得带入旧 Flutter 设置或 build-dir 重定向"
  unshare_bin="$(command -v unshare)"
  # 无特权隔离只覆盖工具装配；不可用即失败，绝不 sudo、安装、改网络或创建 VM。
  "$unshare_bin" --user --map-root-user --net true \
    || fail "$platform 缺少获准的无特权 user/network namespace；禁止联网取得工具"
  verify_linux_flutter_cache "$flutter_source" "$platform"
  verify_linux_tool_tree "$cache_source" "$platform PUB_CACHE"
  [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || fail "$platform 真实 Flutter 消费者需要已获准的 GTK 显示会话"
  root="$platform_work/flutter"
  tool_root="$root/tools"
  cache_root="$root/pub-cache"
  sdk_stage="$root/citizen_sdk"
  runner="$root/consumer"
  for path in "$flutter_source" "$cache_source" "$sdk_dir"; do
    case "$root/" in "$path/"*) fail "$platform 工具或源码不能包含本轮副本目标" ;; esac
    case "$path/" in "$root/"*) fail "$platform 工具或源码不能位于本轮副本目标内" ;; esac
  done
  for path in "$root" "$tool_root" "$cache_root" "$sdk_stage" "$runner" \
      "$root/tmp" "$root/config" "$root/cache" "$root/data" "$root/state" "$root/test-state"; do
    prepare_safe_directory "$work_dir" "$path" "$platform Flutter 独占目录"
    chmod 0700 "$path"
  done
  # 仅复制调用方显式提供的工具/缓存，全部锁、package_config与构建记录留在本轮工作根。
  cp -a "$flutter_source/." "$tool_root/"
  cp -a "$cache_source/." "$cache_root/"
  cp -a "${package:-$sdk_dir}/." "$sdk_stage/"
  if [[ -z "$package" ]]; then
    node "$sdk_dir/scripts/release.mjs" \
      --flutter-source-entry "$sdk_dir" --output "$sdk_stage" >/dev/null
  fi
  chmod 0700 "$tool_root" "$cache_root" "$sdk_stage"
  verify_linux_tool_tree "$tool_root" "$platform Flutter 工具副本"
  verify_linux_tool_tree "$cache_root" "$platform PUB_CACHE 副本"
  [[ -z "$(find "$sdk_stage" -type l -print -quit)" ]] || fail "$platform SDK 验收副本禁止符号链接"
  # 候选消费者与发布包使用完全相同的 linux/ 安装前缀；本机构建只注入
  # 当前平台，双平台共有文件的原子合并由唯一 release 打包器负责。
  if [[ -z "$package" ]]; then
    copy_linux_install "$prefix" "$sdk_stage/linux" "$platform" "$work_dir"
  fi
  export FLUTTER_ROOT="$tool_root" PUB_CACHE="$cache_root"
  export XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache"
  export XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/state" TMPDIR="$root/tmp"
  export FLUTTER_SUPPRESS_ANALYTICS=true
  # 不继承可把日志、引擎或 pub 路由到外部的工具覆盖项；缓存缺失只能失败。
  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \
    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH
  dart_bin="$tool_root/bin/cache/dart-sdk/bin/dart"
  # 外层直接消费已核验 snapshot。官方 CMake 后端仍会调用副本 bin/flutter
  # 执行 assemble；不改写该官方链路，靠完整缓存预检与整个工具子进程禁网
  # 拒绝缺项升级。--offline 仅用于官方确实支持的 pub/create 命令。
  (cd "$tool_root/packages/flutter_tools" && \
    "$unshare_bin" --user --map-root-user --net "$dart_bin" pub get --offline)
  local package_config="$tool_root/packages/flutter_tools/.dart_tool/package_config.json"
  if grep -F -e "$flutter_source/" -e "$cache_source/" "$package_config" >/dev/null; then
    fail "$platform Flutter 工具配置仍引用原工具或缓存"
  fi
  local -a flutter=("$unshare_bin" --user --map-root-user --net "$dart_bin"
    "--packages=$package_config" "$tool_root/bin/cache/flutter_tools.snapshot"
    --no-version-check --suppress-analytics)
  "${flutter[@]}" create --offline --no-pub --platforms=linux \
    --project-name=citizensdk_consumer --org=org.citizen "$runner"
  printf '%s\n' 'name: citizensdk_consumer' 'publish_to: none' 'version: 1.0.0' \
    'environment:' '  sdk: ">=3.8.0 <4.0.0"' 'dependencies:' '  flutter:' \
    '    sdk: flutter' '  citizen_sdk:' '    path: ../citizen_sdk' \
    'flutter:' '  uses-material-design: true' >"$runner/pubspec.yaml"
  cp "$candidate/pubspec.lock" "$runner/pubspec.lock"
  cp "$candidate/linux/test/citizen_sdk_flutter_consumer.dart" "$runner/lib/main.dart"
  # 只改生成的 runner CMake 装配。保留官方 generated registrant 和自动插件发现；
  # 父级 enable_testing 让六个 adapter 合同能被顶层 CTest 实际枚举到。
  for path in "$root/test-state"; do
    case "$path" in *'"'*|*';'*|*'$'*|*'\'*|*$'\n'*|*$'\r'*) fail "Flutter CMake 路径含不允许的语法字符" ;; esac
  done
  CITIZENSDK_ADAPTER_TEST_ROOT="$root/test-state" CITIZENSDK_HOSTED_PACKAGE="$package" \
    perl -0777 -i -pe '
      # 官方模板沿用 Dart project name 中的下划线，但 Host application_id
      # 的既有安全合同只允许字母数字与分隔点；只修验证 runner 的公开身份。
      s/^set\(APPLICATION_ID "org\.citizen\.citizensdk_consumer"\)$/set(APPLICATION_ID "org.citizensdk.flutterconsumer")/m == 1
        or die "Unexpected official runner application identity\n";
      my $settings = length($ENV{CITIZENSDK_HOSTED_PACKAGE}) ? "" : "set(CITIZENSDK_BUILD_TESTS ON)\n" .
        "set(CITIZENSDK_TEST_WORK_DIR \"$ENV{CITIZENSDK_ADAPTER_TEST_ROOT}\")\n" .
        "enable_testing()\n";
      s/^include\(flutter\/generated_plugins.cmake\)/$settings . $&/me == 1
        or die "Missing official generated plugins include\n";
      $_ .= "\ntarget_link_options(\${BINARY_NAME} PRIVATE -static-libstdc++ -static-libgcc)\n";
    ' "$runner/linux/CMakeLists.txt"
  (cd "$runner" && "${flutter[@]}" pub get --offline && \
    "${flutter[@]}" build linux --release --no-pub --target-platform="linux-$arch")
  flutter_build="$runner/build/linux/$arch/release"
  bundle="$flutter_build/bundle"
  # 内部适配层合同属于原生构建阶段；最终 Hosted 只消费公开插件与运行件，
  # 绝不把审计测试补入发布包，也不重新构建 Host/Core。
  if [[ -z "$package" ]]; then
    verify_linux_ctest_inventory "$ctest_bin" "$flutter_build" LinuxFlutter 6
    LD_LIBRARY_PATH="$sdk_stage/linux/lib/$platform:$runner/linux/flutter/ephemeral" \
      "$ctest_bin" --test-dir "$flutter_build" --build-config Release \
        -L '^LinuxFlutter$' --no-tests=error --output-on-failure
  fi
  verify_linux_flutter_elf "$platform" "$bundle" "$sdk_stage/linux" "$readelf_bin" "$nm_bin"
  verify_linux_runtime_resolution "$bundle/citizensdk_consumer" "$bundle/lib"
  # 不使用 flutter run 的“已启动”退出状态代替消费者结果；只运行最终bundle。
  output="$root/consumer.stdout"
  prepare_safe_output_file "$work_dir" "$output" "$platform Flutter 消费者输出"
  prepare_safe_output_file "$work_dir" "$root/consumer.stderr" "$platform Flutter 消费者错误输出"
  status=0
  FLUTTER_LINUX_RENDERER=software timeout --signal=TERM --kill-after=10s 200s \
    "$bundle/citizensdk_consumer" >"$output" 2>"$root/consumer.stderr" || status=$?
  [[ "$status" == 0 ]] || fail "$platform Flutter 消费者失败或超时；退出码=$status"
  [[ "$(grep -Fxc 'CitizenSDK Flutter consumer passed' "$output" || true)" == 1 ]] \
    || fail "$platform Flutter 消费者缺少唯一成功标记"
)


# 唯一中央准备收据是这些静态环境输入的共同来源；不得逐个指向不同安装树。
load_native_dependencies() {
  local platform="$1" receipt="${CITIZENSDK_DEPENDENCY_RECEIPT:-}" source="$sdk_dir"
  local values key value supplied
  [[ -n "$receipt" ]] || fail "$platform 缺少 CITIZENSDK_DEPENDENCY_RECEIPT"
  if [[ "$platform" == Windows ]]; then
    receipt="$(cygpath -m "$receipt")"; source="$(cygpath -m "$source")"
  fi
  values="$(MSYS2_ARG_CONV_EXCL='*' node --input-type=module - "$source" "$receipt" "$platform" <<'NODE'
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
const [source,receipt,platform]=process.argv.slice(2);
const {resolve}=await import('node:path');
// Git Bash 的 C:/ 与 Node 的 C:\\ 是同一官方路径；进入严格路径验证前规范化一次。
const canonicalReceipt=resolve(receipt);
const api=await import(pathToFileURL(join(source,'scripts/release.mjs')));
const inputs=api.assertCitizenSdkDependencyInputs(canonicalReceipt,platform);
if(inputs.source_sha!==process.env.CITIZENSDK_SOURCE_SHA) throw Error('dependency source SHA mismatch');
if(!readFileSync(join(source,'pubspec.yaml'),'utf8').includes('\nversion: '+inputs.software_version+'\n'))
  throw Error('dependency software version mismatch');
for(const [key,value] of Object.entries(api.citizenSdkDependencyEnvironment(canonicalReceipt,platform))) {
  if(/[\r\n=]/.test(value)) throw Error('unsafe dependency path');
  process.stdout.write(key+'='+value+'\n');
}
NODE
)" || fail "$platform 静态依赖收据验证失败"
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    if [[ "$platform" == Windows ]]; then value="$(cygpath -u "$value")"; fi
    supplied="${!key:-}"
    [[ -z "$supplied" || "$supplied" == "$value" ]] || fail "$platform 禁止混用其他静态输入：$key"
    export "$key=$value"
  done <<<"$values"
}

record_native_dependencies() {
  local platform="$1" receipt="$CITIZENSDK_DEPENDENCY_RECEIPT" source="$sdk_dir" native="$output_dir"
  if [[ "$platform" == Windows ]]; then
    receipt="$(cygpath -m "$receipt")"; source="$(cygpath -m "$source")"; native="$(cygpath -m "$native")"
  fi
  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - "$source" "$receipt" "$platform" "$native" <<'NODE'
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const [sourcePath,receiptPath,platform,nativePath]=process.argv.slice(2);
const {writeCitizenSdkDependencyEvidence}=await import(pathToFileURL(join(sourcePath,'scripts/release.mjs')));
const {resolve}=await import('node:path');
writeCitizenSdkDependencyEvidence({sourcePath:resolve(sourcePath),receiptPath:resolve(receiptPath),platform,
  nativePath:resolve(nativePath),sourceSha:process.env.CITIZENSDK_SOURCE_SHA});
NODE
}


build_linux() (
  prepare_internal_header
  local platform="$1" contract rust_target expected_arch cmake_bin ctest_bin
  local nm_bin readelf_bin strip_bin cmake_build runtime_stage source_core
  local destination core_destination host_destination linux_platform_work
  local linux_test_work install_prefix consumer_build software_version loader_variable
  local sqlite_include openssl_include tss2_include
  local sqlite_archive crypto_archive tss2_esys_archive tss2_mu_archive
  local tss2_sys_archive tss2_rc_archive tss2_tcti_device_archive
  contract="$(linux_platform_contract "$platform")"
  IFS='|' read -r rust_target expected_arch <<<"$contract"
  # 只影响 Linux 子进程：新状态统一 0700，且动态加载器不能被调用方环境
  # 指向另一套 Core/Host。Android/Apple 的既有流程和环境保持原样。
  umask 077
  for loader_variable in ${!LD_@}; do unset "$loader_variable"; done
  require_rust_target "$rust_target"
  [[ -d "$linux_source_root" && ! -L "$linux_source_root" ]] \
    || fail "CitizenSDK 缺少普通 Linux 平台源码目录"
  for tool in cmake ctest ldd; do
    command -v "$tool" >/dev/null 2>&1 || fail "$platform 缺少 $tool"
  done
  cmake_bin="$(command -v cmake)"
  ctest_bin="$(command -v ctest)"
  nm_bin="$(command -v llvm-nm || command -v nm || true)"
  readelf_bin="$(command -v llvm-readelf || command -v readelf || true)"
  strip_bin="$(command -v llvm-strip || command -v strip || true)"
  [[ -n "$nm_bin" && -n "$readelf_bin" && -n "$strip_bin" ]] \
    || fail "$platform 缺少 llvm-nm/nm、llvm-readelf/readelf 或 llvm-strip/strip"
  software_version="$(sed -n 's/^version: \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' "$sdk_dir/pubspec.yaml")"
  [[ "$software_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "$platform SDK 版本必须是唯一正式三段版本"

  # Linux Host 只能链接 CI/Release 预先锁定并放在源码树外的静态依赖。
  load_native_dependencies "$platform"
  # 禁止 CMake 从宿主动态库或源码目录临时下载另一份 SQLite、crypto 或 TPM2-TSS。
  sqlite_include="${CITIZENSDK_HOST_SQLITE_INCLUDE_DIR:-}"
  openssl_include="${CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR:-}"
  tss2_include="${CITIZENSDK_HOST_TSS2_INCLUDE_DIR:-}"
  sqlite_archive="${CITIZENSDK_HOST_SQLITE_ARCHIVE:-}"
  crypto_archive="${CITIZENSDK_HOST_CRYPTO_ARCHIVE:-}"
  tss2_esys_archive="${CITIZENSDK_HOST_TSS2_ESYS_ARCHIVE:-}"
  tss2_mu_archive="${CITIZENSDK_HOST_TSS2_MU_ARCHIVE:-}"
  tss2_sys_archive="${CITIZENSDK_HOST_TSS2_SYS_ARCHIVE:-}"
  tss2_rc_archive="${CITIZENSDK_HOST_TSS2_RC_ARCHIVE:-}"
  tss2_tcti_device_archive="${CITIZENSDK_HOST_TSS2_TCTI_DEVICE_ARCHIVE:-}"
  assert_readonly_dependency_directory "$sqlite_include" \
    CITIZENSDK_HOST_SQLITE_INCLUDE_DIR
  assert_readonly_dependency_directory "$openssl_include" \
    CITIZENSDK_HOST_OPENSSL_INCLUDE_DIR
  assert_readonly_dependency_directory "$tss2_include" \
    CITIZENSDK_HOST_TSS2_INCLUDE_DIR
  assert_readonly_static_archive "$sqlite_archive" CITIZENSDK_HOST_SQLITE_ARCHIVE
  assert_readonly_static_archive "$crypto_archive" CITIZENSDK_HOST_CRYPTO_ARCHIVE
  assert_readonly_static_archive "$tss2_esys_archive" CITIZENSDK_HOST_TSS2_ESYS_ARCHIVE
  assert_readonly_static_archive "$tss2_mu_archive" CITIZENSDK_HOST_TSS2_MU_ARCHIVE
  assert_readonly_static_archive "$tss2_sys_archive" CITIZENSDK_HOST_TSS2_SYS_ARCHIVE
  assert_readonly_static_archive "$tss2_rc_archive" CITIZENSDK_HOST_TSS2_RC_ARCHIVE
  assert_readonly_static_archive "$tss2_tcti_device_archive" \
    CITIZENSDK_HOST_TSS2_TCTI_DEVICE_ARCHIVE

  linux_platform_work="$work_dir/linux/$platform"
  [[ ! -e "$linux_platform_work" && ! -L "$linux_platform_work" ]] \
    || fail "$platform 工作目录必须全新：$linux_platform_work"
  prepare_safe_directory "$work_dir" "$linux_platform_work" "$platform 工作目录"
  cmake_build="$linux_platform_work/cmake"
  runtime_stage="$linux_platform_work/runtime"
  linux_test_work="$linux_platform_work/test-state"
  install_prefix="$linux_platform_work/install"
  consumer_build="$linux_platform_work/consumers"
  destination="$output_dir/linux/$platform"
  [[ ! -e "$destination" && ! -L "$destination" ]] \
    || fail "$platform 原生安装输出必须全新：$destination"
  prepare_safe_directory "$work_dir" "$cmake_build" "$platform CMake 目录"
  prepare_safe_directory "$work_dir" "$runtime_stage" "$platform 运行件暂存目录"
  prepare_safe_directory "$work_dir" "$linux_test_work" "$platform 测试状态目录"
  prepare_safe_directory "$work_dir" "$install_prefix" "$platform 安装验证前缀"
  prepare_safe_directory "$work_dir" "$consumer_build" "$platform 安装后消费者构建目录"
  # Linux Host测试只可在当前平台任务独占的工作目录落盘；0700是
  # CITIZENSDK_TEST_WORK_DIR 的公开前置条件，不能依赖 runner 的 umask。
  chmod 0700 "$linux_test_work"
  [[ "$(stat -c '%a' "$linux_test_work")" == 700 ]] \
    || fail "$platform 测试状态目录权限必须精确为 0700：$linux_test_work"
  core_destination="$runtime_stage/libcitizensdk.so"
  prepare_safe_output_file "$work_dir" "$core_destination" "$platform Core 暂存"

  # 机器 target triple 是类型化工具链字段，不得提升为公开平台名或输出目录名。
  CARGO_PROFILE_RELEASE_STRIP=false \
  RUSTFLAGS='-C link-arg=-Wl,-soname,libcitizensdk.so -C link-arg=-static-libgcc' \
    cargo build --manifest-path "$product_ffi_manifest" --release --locked --offline \
      --target "$rust_target"
  source_core="$CARGO_TARGET_DIR/$rust_target/release/libcitizensdk.so"
  [[ -f "$source_core" && ! -L "$source_core" ]] \
    || fail "$platform Rust Core 未生成普通 libcitizensdk.so"
  cp "$source_core" "$core_destination"
  "$strip_bin" --strip-unneeded "$core_destination"

  "$cmake_bin" -S "$linux_source_root" -B "$cmake_build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="${CC:-cc}" \
    -DCMAKE_CXX_COMPILER="${CXX:-c++}" \
    -DCMAKE_INSTALL_PREFIX="$install_prefix" \
    -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_INCLUDEDIR=include \
    -DCMAKE_INSTALL_DATADIR=share -DCMAKE_INSTALL_BINDIR=bin \
    -DCMAKE_LIBRARY_OUTPUT_DIRECTORY="$runtime_stage" \
    -DCITIZENSDK_PLATFORM="$platform" \
    -DCITIZENSDK_CORE_LIBRARY="$core_destination" \
    -DCITIZENSDK_CORE_INCLUDE_DIR="$sdk_dir/include" \
    -DCITIZENSDK_INTERNAL_INCLUDE_DIR="$work_dir/private-include" \
    -DCITIZENSDK_ASSET_DIR="$apple_asset_root" \
    -DCITIZENSDK_SQLITE_INCLUDE_DIR="$sqlite_include" \
    -DCITIZENSDK_OPENSSL_INCLUDE_DIR="$openssl_include" \
    -DCITIZENSDK_TSS2_INCLUDE_DIR="$tss2_include" \
    -DCITIZENSDK_SQLITE_ARCHIVE="$sqlite_archive" \
    -DCITIZENSDK_CRYPTO_ARCHIVE="$crypto_archive" \
    -DCITIZENSDK_TSS2_ESYS_ARCHIVE="$tss2_esys_archive" \
    -DCITIZENSDK_TSS2_MU_ARCHIVE="$tss2_mu_archive" \
    -DCITIZENSDK_TSS2_SYS_ARCHIVE="$tss2_sys_archive" \
    -DCITIZENSDK_TSS2_RC_ARCHIVE="$tss2_rc_archive" \
    -DCITIZENSDK_TSS2_TCTI_DEVICE_ARCHIVE="$tss2_tcti_device_archive" \
    -DCITIZENSDK_ZXING_SOURCE_DIR="$CITIZENSDK_ZXING_SOURCE_DIR" \
    -DCITIZENSDK_TEST_WORK_DIR="$linux_test_work" \
    -DCITIZENSDK_BUILD_TESTS=ON \
    -DCITIZENSDK_ENABLE_QR_CAPTURE=ON \
    -DCITIZENSDK_WARNINGS_AS_ERRORS=ON
  "$cmake_bin" --build "$cmake_build" --config Release --parallel
  verify_linux_ctest_inventory "$ctest_bin" "$cmake_build" LinuxHost 12
  LD_LIBRARY_PATH="$runtime_stage" \
    "$ctest_bin" --test-dir "$cmake_build" --build-config Release \
      -L '^LinuxHost$' --no-tests=error --output-on-failure
  # CMake install 完成后才验 RUNPATH：build-tree 仍可含链接期路径，不能
  # 用它冒充已安装运行件。19 项是本步技术投影，不宣称已完成分发许可证闭包。
  "$cmake_bin" --install "$cmake_build" --config Release --prefix "$install_prefix"
  host_destination="$install_prefix/lib/$platform/libcitizensdk_host.so"
  [[ -f "$host_destination" && ! -L "$host_destination" ]] \
    || fail "$platform CMake 未安装普通 libcitizensdk_host.so"
  "$strip_bin" --strip-unneeded "$host_destination"
  verify_linux_install "$install_prefix" "$platform" "$software_version" \
    "$core_destination" "$readelf_bin" "$nm_bin"

  # 原生消费者只有安装前缀，没有源码 Core/Host target 或私有头入口。
  "$cmake_bin" -S "$linux_source_root/test" -B "$consumer_build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="${CC:-cc}" -DCMAKE_CXX_COMPILER="${CXX:-c++}" \
    -DCITIZENSDK_CONSUMER_PREFIX="$install_prefix" \
    -DCITIZENSDK_PLATFORM="$platform" \
    -DCITIZENSDK_CONSUMER_VERSION="$software_version" \
    -DCITIZENSDK_TEST_WORK_DIR="$linux_test_work"
  "$cmake_bin" --build "$consumer_build" --config Release --parallel \
    --target citizen_sdk_c_consumer citizen_sdk_cpp_consumer
  verify_linux_runtime_resolution "$consumer_build/citizen_sdk_c_consumer" "$install_prefix/lib/$platform"
  verify_linux_runtime_resolution "$consumer_build/citizen_sdk_cpp_consumer" "$install_prefix/lib/$platform"
  verify_linux_ctest_inventory "$ctest_bin" "$consumer_build" LinuxConsumer 2
  "$ctest_bin" --test-dir "$consumer_build" --build-config Release \
    -L '^LinuxConsumer$' --no-tests=error --output-on-failure
  build_linux_flutter_consumer "$platform" "$linux_platform_work" "$install_prefix" \
    "$cmake_bin" "$ctest_bin" "$readelf_bin" "$nm_bin"
  # 所有消费者通过后才导出完整安装前缀，不能把裸双库当作可用的 SDK 输入。
  copy_linux_install "$install_prefix" "$destination" "$platform" "$output_dir"
  verify_linux_install "$destination" "$platform" "$software_version" \
    "$core_destination" "$readelf_bin" "$nm_bin"
  record_native_dependencies "$platform"
  echo "CitizenSDK $platform 安装、原生与 Flutter 消费者验证完成：$destination"
)

build_host() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "当前宿主测试库只允许在 macOS runner 构建"
  local destination arm_library nm_bin symbols architectures
  require_rust_target aarch64-apple-darwin
  destination="$output_dir/host/libsmoldot.dylib"
  # legacy Dart/smoldot 差分测试运行件只保留当前正式 macOS；其
  # 内部 Mach-O 架构必须是工具链值 arm64，且它绝不进入
  # CitizenSDK 候选，也不能借 Rosetta 再建立 x86_64/universal 第二条构建路径。
  MACOSX_DEPLOYMENT_TARGET="$macos_deployment_target" \
  CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path "$ffi_manifest" \
    --release --locked --target aarch64-apple-darwin
  arm_library="$CARGO_TARGET_DIR/aarch64-apple-darwin/release/libsmoldot.dylib"
  [[ -f "$arm_library" ]] || fail "macOS 宿主测试库未生成"
  prepare_safe_output_file "$output_dir" "$destination" "macOS 宿主测试库"
  cp "$arm_library" "$destination"
  architectures="$(xcrun lipo -archs "$destination")"
  [[ "$architectures" == arm64 ]] || fail "macOS 宿主测试库内部架构必须精确为 arm64"
  nm_bin="$(xcrun --find llvm-nm)"
  symbols="$(symbol_list_ios "$destination" "$nm_bin")"
  verify_symbol_contract "$symbols" "_" "macOS 宿主测试库"
  echo "CitizenSDK macOS 宿主测试库完成：$destination"
}

windows_install_files() {
  printf '%s\n' \
    include/citizensdk.h include/citizensdk_types.h include/citizensdk_qr_image.h \
    include/citizen_sdk/citizen_sdk.hpp \
    include/citizen_sdk/citizen_sdk_config.hpp \
    include/citizen_sdk/citizen_sdk_error.hpp \
    include/citizen_sdk/citizen_sdk_events.hpp \
    include/citizen_sdk/citizen_sdk_models.hpp \
    include/citizen_sdk/citizensdk_host.h \
    bin/Windows/citizensdk.dll bin/Windows/citizensdk_host.dll \
    lib/Windows/citizensdk.dll.lib lib/Windows/citizensdk_host.lib \
    lib/Windows/cmake/CitizenSDK/CitizenSDKConfig.cmake \
    lib/Windows/cmake/CitizenSDK/CitizenSDKConfigVersion.cmake \
    lib/Windows/cmake/CitizenSDK/CitizenSDKDependencies.cmake \
    lib/Windows/cmake/CitizenSDK/CitizenSDKTargets.cmake \
    lib/Windows/cmake/CitizenSDK/CitizenSDKTargets-release.cmake \
    share/citizensdk/chain/manifest.json \
    share/citizensdk/chain/chainspec.json \
    share/citizensdk/chain/light_sync_state.json | LC_ALL=C sort
}

verify_windows_install() {
  local prefix="$1" software_version="$2" core_dir="$3" cmake_build="$4" expected
  assert_safe_directory_path "$prefix" "Windows 安装前缀"
  [[ -d "$prefix" && ! -L "$prefix" ]] || fail "Windows 安装前缀不是普通目录"
  expected="$(windows_install_files)"
  # 安装清单不是信任来源：实际文件/目录反向闭集、当前源码和本轮构建原件
  # 三者必须同时相符。验证不执行安装中的 CMake，随后独立消费者检查完整导入目标。
  MSYS2_ARG_CONV_EXCL='*' node -e '
    const fs=require("fs"), p=require("path");
    const [prefix,version,core,build,sdk,windows,assets,listing]=process.argv.slice(1);
    const expected=listing.split("\n");
    if(expected.length!==21 || new Set(expected).size!==21) throw Error("Windows install set must contain 21 files");
    const identity=x=>process.platform==="win32"?p.resolve(x).toLowerCase():p.resolve(x);
    function ordinary(path,directory) {
      const root=p.parse(path).root;
      if(!root || path.includes("\0")) throw Error("invalid installation source path");
      let current=root;
      for(const part of p.relative(root,path).split(p.sep)) {
        if(!part || part==="." || part==="..") throw Error("unsafe installation source component");
        current=p.join(current,part);
        const st=fs.lstatSync(current);
        if(st.isSymbolicLink() || identity(fs.realpathSync(current))!==identity(current)) throw Error("installation reparse or alias");
        if(identity(current)!==identity(path) && !st.isDirectory()) throw Error("installation ancestor is not a directory");
      }
      const st=fs.lstatSync(path);
      if(directory?!st.isDirectory():(!st.isFile() || st.size===0 || st.nlink!==1)) throw Error("invalid installation node");
    }
    ordinary(prefix,true);
    const actual=[], directories=[];
    function walk(directory,relative="") {
      for(const name of fs.readdirSync(directory)) {
        const path=p.join(directory,name), key=relative?relative+"/"+name:name;
        const st=fs.lstatSync(path);
        if(st.isSymbolicLink() || identity(fs.realpathSync(path))!==identity(path)) throw Error("installation reparse or alias");
        if(st.isDirectory()) { directories.push(key); walk(path,key); }
        else if(st.isFile() && st.nlink===1 && st.size>0) actual.push(key);
        else throw Error("installation contains a special, empty or linked file");
      }
    }
    walk(prefix);
    const expectedDirectories=new Set();
    for(const file of expected) {
      const parts=file.split("/");
      while(parts.length>1) { parts.pop(); expectedDirectories.add(parts.join("/")); }
    }
    const equal=(a,b)=>JSON.stringify(a.slice().sort())===JSON.stringify(b.slice().sort());
    if(!equal(actual,expected) || !equal(directories,[...expectedDirectories])) throw Error("Windows installed file/directory closure drift");
    const manifestPath=p.join(build,"install_manifest.txt"); ordinary(manifestPath,false);
    const manifest=fs.readFileSync(manifestPath,"utf8").replace(/\r?\n$/,"").split(/\r?\n/);
    if(manifest.some(x=>!p.isAbsolute(x) || /(^|[\\/])\.{1,2}([\\/]|$)/.test(x))) throw Error("invalid install_manifest path");
    const installed=expected.map(x=>identity(p.join(prefix,...x.split("/"))));
    if(!equal(manifest.map(identity),installed)) throw Error("install_manifest does not match complete Windows installation");
    function same(source,relative) {
      const destination=p.join(prefix,...relative.split("/"));
      ordinary(source,false); ordinary(destination,false);
      if(!fs.readFileSync(source).equals(fs.readFileSync(destination))) throw Error("Windows installed bytes differ: "+relative);
    }
    for(const name of ["citizensdk.h","citizensdk_types.h"]) same(p.join(sdk,"include",name),"include/"+name);
    same(p.join(sdk,"native","qr-image","citizensdk_qr_image.h"),"include/citizensdk_qr_image.h");
    for(const name of ["citizen_sdk.hpp","citizen_sdk_config.hpp","citizen_sdk_error.hpp","citizen_sdk_events.hpp","citizen_sdk_models.hpp","citizensdk_host.h"])
      same(p.join(windows,"citizen_sdk",name),"include/citizen_sdk/"+name);
    for(const name of ["manifest.json","chainspec.json","light_sync_state.json"])
      same(p.join(assets,name),"share/citizensdk/chain/"+name);
    same(p.join(core,"citizensdk.dll"),"bin/Windows/citizensdk.dll");
    same(p.join(core,"citizensdk.dll.lib"),"lib/Windows/citizensdk.dll.lib");
    same(p.join(build,"Release","citizensdk_host.dll"),"bin/Windows/citizensdk_host.dll");
    same(p.join(build,"Release","citizensdk_host.lib"),"lib/Windows/citizensdk_host.lib");
    const packageDir="lib/Windows/cmake/CitizenSDK/";
    for(const name of ["CitizenSDKConfig.cmake","CitizenSDKConfigVersion.cmake"]) same(p.join(build,name),packageDir+name);
    same(p.join(windows,"cmake","CitizenSDKDependencies.cmake"),packageDir+"CitizenSDKDependencies.cmake");
    const exportRoot=p.join(build,"CMakeFiles","Export"), exports=[];
    ordinary(exportRoot,true);
    function collect(directory) {
      for(const name of fs.readdirSync(directory)) {
        const file=p.join(directory,name), st=fs.lstatSync(file);
        if(st.isSymbolicLink()) throw Error("generated CMake export is linked");
        if(st.isDirectory()) collect(file);
        else if(name==="CitizenSDKTargets.cmake" || name==="CitizenSDKTargets-release.cmake") exports.push(file);
      }
    }
    collect(exportRoot);
    for(const name of ["CitizenSDKTargets.cmake","CitizenSDKTargets-release.cmake"]) {
      const matches=exports.filter(x=>p.basename(x)===name);
      if(matches.length!==1) throw Error("generated CMake export is missing or ambiguous");
      same(matches[0],packageDir+name);
    }
    if(!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw Error("invalid SDK version");
    const pubspec=fs.readFileSync(p.join(sdk,"pubspec.yaml"),"utf8");
    const versions=[...pubspec.matchAll(/^version: ([0-9]+\.[0-9]+\.[0-9]+)$/gm)].map(x=>x[1]);
    const project=[...fs.readFileSync(p.join(windows,"CMakeLists.txt"),"utf8").matchAll(/^project\(CitizenSDKHost VERSION ([0-9]+\.[0-9]+\.[0-9]+) LANGUAGES C CXX\)$/gm)].map(x=>x[1]);
    if(JSON.stringify(versions)!==JSON.stringify([version]) || JSON.stringify(project)!==JSON.stringify([version])) throw Error("SDK source version drift");
    const versionTemplate=fs.readFileSync(p.join(windows,"cmake","CitizenSDKConfigVersion.cmake.in"),"utf8")
      .replaceAll("@PROJECT_VERSION@",version).replaceAll("@PROJECT_VERSION_MAJOR@",version.split(".")[0]);
    const installedVersion=fs.readFileSync(p.join(prefix,...(packageDir+"CitizenSDKConfigVersion.cmake").split("/")),"utf8");
    if(installedVersion!==versionTemplate) throw Error("installed CMake version template drift");
    for(const name of ["CitizenSDKConfig.cmake","CitizenSDKConfigVersion.cmake","CitizenSDKDependencies.cmake","CitizenSDKTargets.cmake","CitizenSDKTargets-release.cmake"]) {
      const content=fs.readFileSync(p.join(prefix,...(packageDir+name).split("/")),"utf8");
      if([sdk,build,prefix,core].some(x=>content.includes(x) || content.includes(x.replaceAll("\\","/")))) throw Error("installed CMake leaks an absolute build path");
    }
  ' "$(cygpath -m "$prefix")" "$software_version" "$(cygpath -m "$core_dir")" \
    "$(cygpath -m "$cmake_build")" "$(cygpath -m "$sdk_dir")" \
    "$(cygpath -m "$windows_source_root")" "$(cygpath -m "$apple_asset_root")" "$expected" \
    || fail "Windows 安装闭集、清单、版本或来源字节验证失败"
  verify_windows_exports "$prefix/bin/Windows/citizensdk.dll" "$product_header" Core
  verify_windows_exports "$prefix/bin/Windows/citizensdk_host.dll" \
    "$windows_source_root/citizen_sdk/citizensdk_host.h" Host
}

verify_windows_consumer_inventory() {
  local build="$1" prefix="$2" state="$3" configuration="${4:-Release}" inventory
  inventory="$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir "$(cygpath -m "$build")" \
    -C Release --show-only=json-v1)" || fail "Windows 消费者 CTest 清单读取失败"
  MSYS2_ARG_CONV_EXCL='*' node -e '
    const fs=require("fs"), p=require("path");
    const [text,build,prefix,state,configuration]=process.argv.slice(1), data=JSON.parse(text);
    const expected=[
      ["CitizenSDK.Windows.CConsumer","citizen_sdk_c_consumer.exe"],
      ["CitizenSDK.Windows.CppConsumer","citizen_sdk_cpp_consumer.exe"]
    ];
    if(!Array.isArray(data.tests) || data.tests.length!==2) throw Error("Windows consumer test count drift");
    const names=data.tests.map(x=>x.name).sort();
    if(JSON.stringify(names)!==JSON.stringify(expected.map(x=>x[0]))) throw Error("Windows consumer exact test set drift");
    const identity=x=>process.platform==="win32"?p.resolve(x).toLowerCase():p.resolve(x);
    const runtime=p.join(build,configuration), assets=p.join(prefix,"share","citizensdk","chain");
    function ordinaryFile(path) {
      let current=p.parse(path).root;
      for(const part of p.relative(current,path).split(p.sep)) {
        current=p.join(current,part);
        const st=fs.lstatSync(current);
        if(st.isSymbolicLink() || identity(fs.realpathSync(current))!==identity(current)) throw Error("Windows consumer reparse or alias");
        if(identity(current)!==identity(path) && !st.isDirectory()) throw Error("Windows consumer ancestor is not a directory");
      }
      const st=fs.lstatSync(path);
      if(!st.isFile() || st.size===0 || st.nlink!==1) throw Error("Windows consumer file is unavailable");
    }
    for(const [name,executable] of expected) {
      const test=data.tests.find(x=>x.name===name), args=[p.join(runtime,executable),state,assets,runtime];
      if(!Array.isArray(test.command) || test.command.length!==4 || test.command.some((x,i)=>typeof x!=="string" || identity(x)!==identity(args[i]))) throw Error("Windows consumer command drift");
      const props=test.properties||[];
      if(new Set(props.map(x=>x.name)).size!==props.length) throw Error("duplicate CTest property");
      const property=name=>props.find(x=>x.name===name)?.value;
      if(property("TIMEOUT")!==180 || property("RUN_SERIAL")!==true) throw Error("Windows consumer timeout or serialization drift");
      // PASS_REGULAR_EXPRESSION 会忽略非零退出码；不允许任何跳过/反转成功的属性。
      if(props.some(x=>/^(PASS_REGULAR_EXPRESSION|SKIP_REGULAR_EXPRESSION|SKIP_RETURN_CODE|WILL_FAIL|DISABLED)$/.test(x.name))) throw Error("Windows consumer exit contract override");
      ordinaryFile(args[0]);
    }
    for(const name of ["citizensdk.dll","citizensdk_host.dll"]) {
      const actual=p.join(runtime,name), expected=p.join(prefix,"bin","Windows",name);
      ordinaryFile(actual); ordinaryFile(expected);
      if(!fs.readFileSync(actual).equals(fs.readFileSync(expected))) throw Error("Windows consumer DLL bytes drift");
    }
  ' "$inventory" "$(cygpath -m "$build")" "$(cygpath -m "$prefix")" "$(cygpath -m "$state")" "$configuration" \
    || fail "Windows 消费者必须是准确两个真实程序及同版运行库"
}

run_windows_consumers() {
  local build="$1" prefix="$2" state="$3" configuration="${4:-Release}" output
  verify_windows_consumer_inventory "$build" "$prefix" "$state" "$configuration"
  # 同时检查 CTest 真实退出码和两个程序各自唯一成功行，不能用标记掩盖失败。
  output="$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir "$(cygpath -m "$build")" \
    -C Release --no-tests=error --verbose 2>&1)" || {
      printf '%s\n' "$output" >&2
      fail "Windows 已安装消费者运行失败"
    }
  printf '%s\n' "$output"
  MSYS2_ARG_CONV_EXCL='*' node -e '
    const lines=process.argv[1].split(/\r?\n/);
    for(const marker of ["CitizenSDK C consumer passed","CitizenSDK C++ consumer passed"]) {
      if(lines.filter(x=>/^\d+: /.test(x) && x.replace(/^\d+: /,"")===marker).length!==1) throw Error("Windows consumer success marker missing or repeated");
    }
  ' "$output" || fail "Windows 已安装消费者成功标记不完整"
}

export_windows_install() {
  local prefix="$1" destination="$2"
  assert_descendant_path "$work_dir" "$prefix" "Windows 已验证安装来源"
  assert_descendant_path "$output_dir" "$destination" "Windows 安装导出"
  assert_safe_directory_path "$prefix" "Windows 已验证安装来源"
  assert_safe_directory_path "$(dirname "$destination")" "Windows 安装导出父目录"
  [[ -d "$prefix" && ! -L "$prefix" ]] || fail "Windows 已验证安装来源不是普通目录"
  [[ ! -e "$destination" && ! -L "$destination" ]] || fail "Windows 安装导出目标已存在，保留已有产物"
  # 所有安装/消费者检查成功后才同卷重命名；跨卷失败，不退回复制半份目录，
  # 不删除旧产物、不清理永久容器，也不覆盖已存在或被替换为 reparse point 的目标。
  MSYS2_ARG_CONV_EXCL='*' node -e '
    const fs=require("fs"), p=require("path");
    const [source,target]=process.argv.slice(1);
    const identity=x=>process.platform==="win32"?p.resolve(x).toLowerCase():p.resolve(x);
    for(const directory of [source,p.dirname(target)]) {
      const st=fs.lstatSync(directory);
      if(!st.isDirectory() || st.isSymbolicLink() || identity(fs.realpathSync(directory))!==identity(directory)) throw Error("Windows export directory identity drift");
    }
    try { fs.lstatSync(target); throw Error("Windows export already exists"); }
    catch(error) { if(error.code!=="ENOENT") throw error; }
    fs.renameSync(source,target);
  ' "$(cygpath -m "$prefix")" "$(cygpath -m "$destination")" \
    || fail "Windows 已验证安装同卷导出失败，禁止覆盖或跨卷复制"
}

verify_windows_flutter_cache() {
  local root="$1" cache="$2"
  assert_readonly_dependency_directory "$root" "Windows Flutter SDK"
  assert_readonly_dependency_directory "$cache" "Windows Pub cache"
  # 官方 WindowsEngineArtifacts 同时登记 debug/profile/release；缺项只能失败，
  # 不能让后续 build 自动取得运行件。ICU 属于无 mode 的通用目录。
  MSYS2_ARG_CONV_EXCL='*' node - "$(cygpath -m "$root")" "$(cygpath -m "$cache")" <<'NODE'
const fs = require('fs'), path = require('path');
const [root, cache] = process.argv.slice(2);
function ordinaryTree(directory) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()
      || path.resolve(fs.realpathSync(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) throw Error('Windows tool directory is redirected');
  for (const item of fs.readdirSync(directory, {withFileTypes:true})) {
    const value = path.join(directory, item.name), state = fs.lstatSync(value);
    if (state.isSymbolicLink() || (!state.isFile() && !state.isDirectory())) throw Error('Windows tool tree contains a link or special node');
    if (state.isDirectory()) ordinaryTree(value);
  }
}
ordinaryTree(root);
for (const name of ['hosted', 'hosted-hashes']) ordinaryTree(path.join(cache, name));
function file(name, read = false) {
  const value = path.join(root, name), st = fs.lstatSync(value);
  if (!st.isFile() || st.isSymbolicLink() || st.size === 0) throw Error('Windows Flutter cache is incomplete: ' + name);
  return read ? fs.readFileSync(value, 'utf8').trim() : undefined;
}
if (!fs.lstatSync(path.join(root, '.git')).isDirectory()
    || fs.existsSync(path.join(root, '.git/commondir'))) throw Error('Windows Flutter SDK must be a complete ordinary installation');
const version = JSON.parse(file('bin/cache/flutter.version.json', true));
const revision = file('bin/cache/engine.stamp', true);
if (!/^[0-9a-f]{40}$/.test(revision) || version.engineRevision !== revision
    || !/^[0-9a-f]{40}$/.test(version.frameworkRevision)
    || file('bin/internal/engine.version', true) !== revision
    || file('bin/cache/flutter_tools.stamp', true) !== version.frameworkRevision + ':') throw Error('Windows Flutter cache identity mismatch');
for (const name of ['flutter_sdk', 'windows-sdk', 'font-subset']) {
  if (file('bin/cache/' + name + '.stamp', true) !== revision) throw Error('Windows Flutter artifact revision mismatch');
}
for (const name of ['material_fonts', 'gradle_wrapper']) {
  if (file('bin/cache/' + name + '.stamp', true) !== file('bin/internal/' + name + '.version', true)
      || !fs.lstatSync(path.join(root, 'bin/cache/artifacts', name)).isDirectory()) throw Error('Windows universal Flutter cache is incomplete');
}
for (const name of [
  'bin/cache/flutter_tools.snapshot', 'bin/cache/dart-sdk/bin/dart.exe',
  'packages/flutter_tools/.dart_tool/package_config.json',
  'bin/cache/pkg/sky_engine/pubspec.yaml', 'bin/cache/pkg/flutter_gpu/pubspec.yaml',
  'bin/cache/artifacts/engine/common/flutter_patched_sdk/platform_strong.dill',
  'bin/cache/artifacts/engine/common/flutter_patched_sdk_product/platform_strong.dill',
  'bin/cache/artifacts/engine/windows-x64/icudtl.dat',
  'bin/cache/artifacts/engine/windows-x64/font-subset.exe',
  'bin/cache/artifacts/engine/windows-x64-release/gen_snapshot.exe',
  'bin/cache/artifacts/engine/windows-x64/cpp_client_wrapper/include/flutter/plugin_registrar_windows.h',
]) file(name);
for (const mode of ['', '-profile', '-release']) {
  for (const name of ['flutter_windows.dll', 'flutter_windows.dll.exp', 'flutter_windows.dll.lib',
    'flutter_windows.dll.pdb', 'flutter_export.h', 'flutter_messenger.h',
    'flutter_plugin_registrar.h', 'flutter_texture_registrar.h', 'flutter_windows.h']) {
    file('bin/cache/artifacts/engine/windows-x64' + mode + '/' + name);
  }
}
NODE
}

verify_windows_flutter_inventory() {
  local build="$1" state="$2" prefix="$3" inventory
  inventory="$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir "$(cygpath -m "$build")" \
    -C Release --show-only=json-v1)" || fail "Windows Flutter CTest 清单读取失败"
  MSYS2_ARG_CONV_EXCL='*' node - "$inventory" "$(cygpath -m "$build")" \
    "$(cygpath -m "$state")" "$(cygpath -m "$prefix")" <<'NODE'
const fs=require('fs'), path=require('path');
const [raw, build, state, prefix]=process.argv.slice(2);
const tests=JSON.parse(raw).tests;
const names=['codec','environment','sessions','wallet_flow','plugin','secret_boundary']
  .map(x=>'CitizenSDK.Windows.citizen_sdk_flutter_'+x+'_test').sort();
if(!Array.isArray(tests) || JSON.stringify(tests.map(x=>x.name).sort())!==JSON.stringify(names)) throw Error('Windows Flutter CTest exact set drift');
const normalize=x=>path.resolve(x).toLowerCase();
function ordinaryFile(file) {
  let current=path.parse(path.resolve(file)).root;
  for(const part of path.relative(current,path.resolve(file)).split(path.sep)) {
    current=path.join(current,part); const st=fs.lstatSync(current);
    if(st.isSymbolicLink() || normalize(fs.realpathSync(current))!==normalize(current)) throw Error('Windows Flutter CTest path is redirected');
    if(normalize(current)===normalize(file)) {
      if(!st.isFile() || !st.size || st.nlink!==1) throw Error('Windows Flutter CTest input is not an ordinary single-link file');
    } else if(!st.isDirectory()) throw Error('Windows Flutter CTest ancestor is not a directory');
  }
}
for(const test of tests) {
  const name=test.name.slice('CitizenSDK.Windows.'.length);
  const expected=path.join(build,'plugins/citizen_sdk/test/Release',name+'.exe');
  if(!Array.isArray(test.command) || test.command.length!==1 || normalize(test.command[0])!==normalize(expected)) throw Error('Windows Flutter CTest command drift');
  const props=new Map();
  for(const property of test.properties || []) {
    if(props.has(property.name)) throw Error('Windows Flutter CTest duplicate property');
    props.set(property.name,property.value);
  }
  if(props.get('TIMEOUT')!==60 || JSON.stringify(props.get('ENVIRONMENT'))!==JSON.stringify(['CITIZENSDK_TEST_WORK_DIR='+state])) throw Error('Windows Flutter CTest state/timeout drift');
  if(!Array.isArray(props.get('LABELS')) || JSON.stringify([...props.get('LABELS')].sort())!==JSON.stringify(['CitizenSDK','Contract','WindowsFlutter'])) throw Error('Windows Flutter CTest labels drift');
  for(const property of ['PASS_REGULAR_EXPRESSION','SKIP_REGULAR_EXPRESSION','SKIP_RETURN_CODE','WILL_FAIL','DISABLED']) {
    if(props.has(property)) throw Error('Windows Flutter CTest cannot mask failure');
  }
  ordinaryFile(expected);
  for(const name of ['citizensdk.dll','citizensdk_host.dll']) {
    const actual=path.join(path.dirname(expected),name);
    const source=path.join(prefix,'bin/Windows',name);
    ordinaryFile(actual); ordinaryFile(source);
    if(!fs.readFileSync(actual).equals(fs.readFileSync(source))) throw Error('Windows Flutter CTest runtime differs from its installation');
  }
}
NODE
}

run_windows_flutter_consumer() {
  local bundle="$1"
  # .NET 用真实管道启动 GUI Release，并等待退出和输出排空，不使用
  # Start-Process 的“已启动”状态。官方 AttachConsole 保留 STARTF_USESTDHANDLES
  # 提供的重定向句柄；不改 runner main 或手动注册插件。
  CITIZENSDK_FLUTTER_BUNDLE="$(cygpath -m "$bundle")" \
    MSYS2_ARG_CONV_EXCL='*' pwsh -NoLogo -NoProfile -NonInteractive -Command - <<'POWERSHELL'
$ErrorActionPreference = 'Stop'
try {
  if ($PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows -or
      $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Windows Flutter execution requires the authorized isolated runner'
  }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class CitizenSdkFlutterConsumer {
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Information information);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern uint GetSecurityInfo(SafeFileHandle handle, uint kind, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition value, uint size);
  [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte Delete; }
  [StructLayout(LayoutKind.Sequential)] struct Information {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  static readonly SecurityIdentifier User = CurrentUser();
  static SecurityIdentifier CurrentUser() {
    using (var identity = WindowsIdentity.GetCurrent()) { return identity.User; }
  }
  const string Application = "org.citizensdk.flutterconsumer";
  const string Marker = "CitizenSDK Flutter consumer passed";
  static void Require(bool value) { if (!value) throw new InvalidOperationException("Windows Flutter consumer boundary failed"); }
  static string Full(string value) {
    var path = Path.GetFullPath(value);
    Require(path.Length > 3 && path[1] == ':' && !path.StartsWith(@"\\") && path.IndexOf('\0') < 0);
    return path.TrimEnd('\\');
  }
  static bool Missing(string path) {
    if (GetFileAttributesW(path) != UInt32.MaxValue) return false;
    var error = Marshal.GetLastWin32Error();
    Require(error == 2 || error == 3);
    return true;
  }
  static void Private(SafeFileHandle handle) {
    IntPtr owner, group, dacl, sacl, descriptor;
    Require(GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor) == 0);
    try {
      var size = GetSecurityDescriptorLength(descriptor);
      Require(size > 0 && size <= 65536);
      var bytes = new byte[(int)size]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var security = new RawSecurityDescriptor(bytes, 0);
      Require(User != null && User.Equals(security.Owner)
        && (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0
        && security.DiscretionaryAcl != null && security.DiscretionaryAcl.Count == 1);
      var ace = security.DiscretionaryAcl[0] as CommonAce;
      Require(ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && ace.AceFlags == AceFlags.None
        && ace.AccessMask == 0x1f01ff && User.Equals(ace.SecurityIdentifier));
    } finally { LocalFree(descriptor); }
  }
  static SafeFileHandle Open(string path, bool directory, bool remove, bool secure) {
    // 不分享删除；每一层都保持句柄直到下层检查/清理结束，避免检查后换父目录。
    var handle = CreateFileW(path, 0x20080u | (directory ? 1u : 0u) | (remove ? 0x10000u : 0u),
      3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try {
      Require(!handle.IsInvalid);
      Information info; Require(GetFileInformationByHandle(handle, out info));
      Require((info.Attributes & 0x400) == 0 && ((info.Attributes & 0x10) != 0) == directory
        && (directory || info.Links == 1));
      var name = new StringBuilder(32768);
      var count = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);
      Require(count > 0 && count < name.Capacity);
      var final = name.ToString();
      Require(final.StartsWith(@"\\?\") && String.Equals(final.Substring(4).TrimEnd('\\'),
        Path.GetFullPath(path).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase));
      if (secure) Private(handle);
      return handle;
    } catch { handle.Dispose(); throw; }
  }
  static string Identity(SafeFileHandle handle) {
    Information value; Require(GetFileInformationByHandle(handle, out value));
    return value.Volume.ToString("x8") + value.IndexHigh.ToString("x8") + value.IndexLow.ToString("x8");
  }
  sealed class Node : IDisposable {
    public SafeFileHandle Handle;
    public List<Node> Children = new List<Node>();
    public void Dispose() { foreach (var child in Children) child.Dispose(); if (Handle != null) Handle.Dispose(); }
    public void Delete() {
      foreach (var child in Children) child.Delete();
      var value = new Disposition { Delete = 1 };
      Require(SetFileInformationByHandle(Handle, 4, ref value, 1));
      Handle.Dispose();
    }
  }
  static Node Collect(string path, int depth, ref int count) {
    Require(depth <= 16 && ++count <= 4096);
    var attributes = GetFileAttributesW(path); Require(attributes != UInt32.MaxValue);
    var directory = (attributes & 0x10) != 0;
    var node = new Node { Handle = Open(path, directory, true, true) };
    try {
      if (directory) foreach (var child in Directory.EnumerateFileSystemEntries(path)) node.Children.Add(Collect(child, depth + 1, ref count));
      return node;
    } catch { node.Dispose(); throw; }
  }
  public static void Run(string suppliedBundle) {
    var bundle = Full(suppliedBundle);
    var folder = new Guid("F1B32785-6FBA-4FCF-9D55-7B8E7F157091"); IntPtr pointer;
    Require(SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out pointer) == 0);
    string data; try { data = Full(Marshal.PtrToStringUni(pointer)); } finally { Marshal.FreeCoTaskMem(pointer); }
    var target = Path.Combine(data, Application);
    var ancestors = new List<SafeFileHandle>(); SafeFileHandle observed = null;
    string identity = null; bool started = false, ended = false, succeeded = false;
    var process = new Process();
    try {
      var current = Path.GetPathRoot(data);
      ancestors.Add(Open(current, true, false, false));
      foreach (var part in data.Substring(current.Length).Split('\\')) {
        Require(part.Length != 0 && part != "." && part != "..");
        current = Path.Combine(current, part); ancestors.Add(Open(current, true, false, false));
      }
      Require(Missing(target));  // 不认领、更改或删除任何原有用户状态。
      process.StartInfo = new ProcessStartInfo(Path.Combine(bundle, "citizensdk_consumer.exe")) {
        WorkingDirectory = bundle, UseShellExecute = false,
        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
        CreateNoWindow = true
      };
      Require(process.Start()); started = true; process.StandardInput.Close();
      var stdout = process.StandardOutput.ReadToEndAsync();
      var stderr = process.StandardError.ReadToEndAsync();
      var loaded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var libraries = new HashSet<string>(new [] { "citizensdk.dll", "citizensdk_host.dll", "citizen_sdk_plugin.dll", "flutter_windows.dll" }, StringComparer.OrdinalIgnoreCase);
      var clock = Stopwatch.StartNew();
      while (!process.WaitForExit(5)) {
        Require(clock.ElapsedMilliseconds < 180000);
        if (observed == null && !Missing(target)) { observed = Open(target, true, false, true); identity = Identity(observed); }
        ProcessModuleCollection modules = null;
        try { process.Refresh(); modules = process.Modules; }
        catch (System.ComponentModel.Win32Exception error) {
          // 仅允许启动/退出间的暂态枚举失败；未实际看到全部 DLL 始终不能通过。
          Require(error.NativeErrorCode == 299 || process.HasExited);
        } catch (InvalidOperationException) { if (!process.HasExited) throw; }
        if (modules != null) foreach (ProcessModule module in modules) if (libraries.Contains(module.ModuleName)) {
          Require(String.Equals(Full(module.FileName), Path.Combine(bundle, module.ModuleName), StringComparison.OrdinalIgnoreCase));
          loaded.Add(module.ModuleName);
        }
      }
      ended = true;
      Require(stdout.Wait(5000) && stderr.Wait(5000));
      Require(process.ExitCode == 0 && loaded.SetEquals(libraries));
      Require(stdout.Result.Split(new [] { "\r\n", "\n" }, StringSplitOptions.None).Count(line => line == Marker) == 1);
      if (observed == null) { observed = Open(target, true, false, true); identity = Identity(observed); }
      succeeded = true;
    } finally {
      try {
        try {
          if (started && !ended) {
            if (!process.HasExited) process.Kill(true);
            ended = process.WaitForExit(10000);
          }
        } finally {
          // 终止/等待自身也可能失败；仍释放观察句柄，但不清理未确认退出的进程状态。
          process.Dispose();
          if (observed != null) observed.Dispose();
        }
        // 必须先确认进程退出、观察到本次私有目录身份，再整树验所有权后删除。
        // 任意身份/ACL/reparse 不明时保留，不能把安全失败改成强制 Remove-Item。
        if (started && ended && identity != null) {
          int count = 0;
          using (var owned = Collect(target, 0, ref count)) { Require(Identity(owned.Handle) == identity); owned.Delete(); }
          Require(Missing(target));
        } else if (started && !Missing(target)) { succeeded = false; throw new InvalidOperationException("Windows Flutter test state ownership is unproven; retained"); }
      } finally { foreach (var handle in ancestors) handle.Dispose(); }
    }
    Require(succeeded);
    Console.WriteLine(Marker);
  }
}
'@
  [CitizenSdkFlutterConsumer]::Run($env:CITIZENSDK_FLUTTER_BUNDLE)
  exit 0
} catch {
  [Console]::Error.WriteLine('Windows Flutter consumer failed; unproven state is retained')
  exit 1
}
POWERSHELL
}

build_windows_flutter_consumer() (
  local build_root="$1" prefix="$2" software_version="$3"
  local package="${4:-}" candidate="${5:-$sdk_dir}"
  local flutter_source="${CITIZENSDK_FLUTTER_ROOT:-}" cache_source="${PUB_CACHE:-}"
  local root="$build_root/flutter" tool_root cache_root sdk_stage runner dart_bin build bundle test_state
  [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
    || fail "Windows Flutter 真实消费只允许已授权的一次性 GitHub Windows 用户环境"
  command -v pwsh >/dev/null 2>&1 || fail "Windows Flutter 消费缺少预装 PowerShell 7"
  MSYS2_ARG_CONV_EXCL='*' node -e '
    const fs=require("fs"),path=require("path");
    if(!process.env.APPDATA || !path.isAbsolute(process.env.APPDATA)) throw Error("Windows Flutter tool profile is unavailable");
    try { fs.lstatSync(path.join(process.env.APPDATA,".flutter_settings")); throw Error("Windows Flutter settings must not redirect this build"); }
    catch(error) { if(error.code!=="ENOENT") throw error; }
  ' || fail "Windows Flutter 一次性用户环境带有不允许的工具配置"
  verify_windows_flutter_cache "$flutter_source" "$cache_source"
  tool_root="$root/tools"; cache_root="$root/pub-cache"; sdk_stage="$root/citizen_sdk"
  runner="$root/consumer"; test_state="$root/test-state"
  for directory in "$flutter_source" "$cache_source" "$sdk_dir"; do
    case "$root/" in "$directory/"*) fail "Windows Flutter 输入不能包含本轮副本目标" ;; esac
    case "$directory/" in "$root/"*) fail "Windows Flutter 输入不能来自本轮副本目标" ;; esac
  done
  for directory in "$root" "$tool_root" "$cache_root" "$sdk_stage" "$root/tmp"; do
    [[ ! -e "$directory" && ! -L "$directory" ]] || fail "Windows Flutter 工作目录已存在，拒绝混用"
    prepare_safe_directory "$work_dir" "$directory" "Windows Flutter 独占目录"
  done
  # 副本只含显式预装工具及 hosted 依赖；不复制 Pub 凭据、Git hooks/config。
  # Flutter 官方 backend 仍执行其副本 assemble 链路；不改官方 registrant。
  MSYS2_ARG_CONV_EXCL='*' node - "$(cygpath -m "$flutter_source")" "$(cygpath -m "$cache_source")" \
    "$(cygpath -m "$tool_root")" "$(cygpath -m "$cache_root")" \
    "$(cygpath -m "${package:-$sdk_dir}")" "$(cygpath -m "$sdk_stage")" <<'NODE'
const fs=require('fs'), path=require('path'), url=require('url');
const [source,cache,tool,copyCache,sdk,stage]=process.argv.slice(2);
for(const [from,to] of [[source,tool],[sdk,stage]]) {
  fs.cpSync(from,to,{recursive:true,errorOnExist:true,force:false,filter:value=>{
    const relative=path.relative(from,value).replaceAll('\\','/');
    return !['.git/config','.git/hooks','.git/logs'].some(x=>relative===x || relative.startsWith(x+'/'));
  }});
}
for(const name of ['hosted','hosted-hashes']) fs.cpSync(path.join(cache,name),path.join(copyCache,name),{recursive:true,errorOnExist:true,force:false});
const original=path.join(source,'packages/flutter_tools/.dart_tool/package_config.json');
const config=JSON.parse(fs.readFileSync(original,'utf8'));
for(const item of config.packages) {
  const root=url.fileURLToPath(new URL(item.rootUri,url.pathToFileURL(original)));
  const maps=[[source,tool],[cache,copyCache]];
  const mapping=maps.find(([from])=>root.toLowerCase().startsWith(path.resolve(from).toLowerCase()+path.sep));
  if(!mapping) throw Error('Windows Flutter package config refers outside explicit tool/cache inputs');
  item.rootUri=url.pathToFileURL(path.join(mapping[1],path.relative(mapping[0],root))+path.sep).href;
}
fs.writeFileSync(path.join(tool,'packages/flutter_tools/.dart_tool/package_config.json'),JSON.stringify(config));
NODE
  if [[ -z "$package" ]]; then
  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - "$(cygpath -m "$sdk_dir")" \
    "$(cygpath -m "$prefix")" "$(cygpath -m "$sdk_stage")" <<'NODE'
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const [source,prefix,stage]=process.argv.slice(2);
const release=await import(pathToFileURL(join(source,'scripts/release.mjs')));
release.projectFlutterSourceEntry(source,stage);
release.copyWindowsNativeArtifact(source,prefix,stage);
release.assertWindowsReleaseProjection(stage);
release.assertHostedRuntimeWindowsProjection(stage,{allowInjectedWindowsArtifacts:true});
NODE
  fi
  # 不设置 HOME、APPDATA、LOCALAPPDATA 或 KnownFolder。工具自身 profile 状态
  # 只属于已授权的一次性 runner 用户；依赖、工具副本和 TEMP 始终留本轮 work。
  export FLUTTER_ROOT="$(cygpath -m "$tool_root")" PUB_CACHE="$(cygpath -m "$cache_root")"
  export TEMP="$(cygpath -m "$root/tmp")" TMP="$TEMP" TMPDIR="$root/tmp"
  export FLUTTER_SUPPRESS_ANALYTICS=true
  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \
    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH
  dart_bin="$tool_root/bin/cache/dart-sdk/bin/dart.exe"
  local -a flutter=("$dart_bin" "--packages=$(cygpath -m "$tool_root/packages/flutter_tools/.dart_tool/package_config.json")"
    "$(cygpath -m "$tool_root/bin/cache/flutter_tools.snapshot")" --no-version-check --suppress-analytics)
  MSYS2_ARG_CONV_EXCL='*' "${flutter[@]}" create --offline --no-pub --platforms=windows \
    --project-name=citizensdk_consumer --org=org.citizen "$(cygpath -m "$runner")"
  MSYS2_ARG_CONV_EXCL='*' node - "$(cygpath -m "$runner")" "$(cygpath -m "$test_state")" \
    "$(cygpath -m "$candidate")" "$software_version" "$package" <<'NODE'
const fs=require('fs'),path=require('path');
const [runner,state,source,version,hosted]=process.argv.slice(2);
if(/[";$\\\r\n]/.test(state)) throw Error('Windows CMake test path is unsafe');
fs.writeFileSync(path.join(runner,'pubspec.yaml'),`name: citizensdk_consumer\npublish_to: none\nversion: ${version}\nenvironment:\n  sdk: ">=3.8.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  citizen_sdk:\n    path: ../citizen_sdk\nflutter:\n  uses-material-design: true\n`);
fs.copyFileSync(path.join(source,'pubspec.lock'),path.join(runner,'pubspec.lock'));
fs.copyFileSync(path.join(source,'windows/test/citizen_sdk_flutter_consumer.dart'),path.join(runner,'lib/main.dart'));
const cmake=path.join(runner,'windows/CMakeLists.txt');
const text=fs.readFileSync(cmake,'utf8'), target='include(flutter/generated_plugins.cmake)';
if(text.split(target).length!==2) throw Error('Windows official generated plugin include is not unique');
fs.writeFileSync(cmake,text.replace(target,
  'set(CITIZENSDK_APPLICATION_ID "org.citizensdk.flutterconsumer")\n'+
  (hosted ? '' : `set(CITIZENSDK_BUILD_TESTS ON)\nset(CITIZENSDK_TEST_WORK_DIR "${state}")\nenable_testing()\n`)+target));
NODE
  (cd "$runner" && MSYS2_ARG_CONV_EXCL='*' "${flutter[@]}" pub get --offline)
  (cd "$runner" && MSYS2_ARG_CONV_EXCL='*' "${flutter[@]}" build windows --release --no-pub)
  cmp -s "$candidate/pubspec.yaml" "$sdk_stage/pubspec.yaml" \
    || fail "Windows Flutter 不允许改写 SDK pubspec 注册"
  build="$runner/build/windows/x64"; bundle="$build/runner/Release"
  if [[ -z "$package" ]]; then
    verify_windows_flutter_inventory "$build" "$test_state" "$prefix"
    MSYS2_ARG_CONV_EXCL='*' ctest --test-dir "$(cygpath -m "$build")" \
      -C Release --no-tests=error --output-on-failure
  fi
  MSYS2_ARG_CONV_EXCL='*' node --input-type=module - "$(cygpath -m "$sdk_dir")" \
    "$(cygpath -m "$prefix")" "$(cygpath -m "$bundle")" <<'NODE'
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const [source,prefix,bundle]=process.argv.slice(2);
const {assertWindowsFlutterBundle}=await import(pathToFileURL(join(source,'scripts/release.mjs')));
assertWindowsFlutterBundle(source,prefix,bundle);
NODE
  run_windows_flutter_consumer "$bundle"
)

build_windows() {
  prepare_internal_header
  local target=x86_64-pc-windows-msvc build_root prefix test_root core_dir
  local software_version consumer_build consumer_state destination
  windows_path_preflight
  command -v cl >/dev/null 2>&1 || fail "Windows 缺少预先初始化的 MSVC 编译环境"
  command -v dumpbin >/dev/null 2>&1 || fail "Windows 缺少 MSVC dumpbin"
  command -v cmake >/dev/null 2>&1 || fail "Windows 缺少 CMake"
  load_native_dependencies Windows
  require_rust_target "$target"
  [[ -n "${CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR:-}" && -n "${CITIZENSDK_WINDOWS_SQLITE_ARCHIVE:-}" ]] \
    || fail "Windows 必须显式提供已固定的 SQLite 头和 MSVC 静态库"
  assert_readonly_dependency_directory "$CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR" "Windows SQLite include"
  [[ "$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE" == /* && "$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE" == *.lib \
      && -f "$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE" && ! -L "$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE" ]] \
    || fail "Windows SQLite archive 必须是既存绝对 .lib 路径"
  assert_safe_directory_path "$(dirname "$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE")" "Windows SQLite archive 父目录"
  build_root="$work_dir/Windows"
  prefix="$build_root/install"
  destination="$output_dir/Windows"
  consumer_build="$build_root/consumer"
  consumer_state="$build_root/consumer-state"
  test_root="$build_root/test-state"
  prepare_safe_directory "$work_dir" "$build_root" "Windows 构建目录"
  # 测试最终目录由实际生产 Directory 首次相对创建，直接附加受保护 SID DACL。
  # Bash mkdir/chmod 不是 Windows 私有 ACL；这里仅检查路径，不能先造继承 ACL 目录。
  assert_descendant_path "$work_dir" "$test_root" "Windows 测试状态"
  assert_safe_directory_path "$test_root" "Windows 测试状态"
  assert_descendant_path "$work_dir" "$consumer_state" "Windows 消费者状态"
  assert_safe_directory_path "$consumer_state" "Windows 消费者状态"
  assert_safe_directory_path "$prefix" "Windows 原生安装目录"
  [[ ! -e "$prefix" && ! -L "$prefix" ]] || fail "Windows 临时安装前缀已存在，拒绝混入旧安装件"
  prepare_safe_directory "$work_dir" "$prefix" "Windows 临时原生安装目录"
  software_version="$(sed -n 's/^version: \([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' "$sdk_dir/pubspec.yaml")"
  [[ -n "$software_version" ]] || fail "Windows 缺少唯一 SDK 版本"
  # 不安装工具、不联网补依赖，Cargo 输出和 CMake/CTest 状态均留在中央工作区。
  CARGO_TARGET_DIR="$(cygpath -m "$cargo_target_dir")" MSYS2_ARG_CONV_EXCL='*' \
    cargo build --manifest-path "$(cygpath -m "$product_ffi_manifest")" \
      --target "$target" --release --locked --offline
  core_dir="$cargo_target_dir/$target/release"
  [[ -f "$core_dir/citizensdk.dll" && -f "$core_dir/citizensdk.dll.lib" ]] \
    || fail "Windows Core DLL/import library 不完整"
  MSYS2_ARG_CONV_EXCL='*' cmake -S "$(cygpath -m "$windows_source_root")" \
    -B "$(cygpath -m "$build_root/cmake")" -G 'Visual Studio 17 2022' -A x64 \
    -DCITIZENSDK_PLATFORM=Windows \
    -DCITIZENSDK_CORE_LIBRARY="$(cygpath -m "$core_dir/citizensdk.dll")" \
    -DCITIZENSDK_CORE_IMPORT_LIBRARY="$(cygpath -m "$core_dir/citizensdk.dll.lib")" \
    -DCITIZENSDK_INTERNAL_INCLUDE_DIR="$(cygpath -m "$work_dir/private-include")" \
    -DCITIZENSDK_SQLITE_INCLUDE_DIR="$(cygpath -m "$CITIZENSDK_WINDOWS_SQLITE_INCLUDE_DIR")" \
    -DCITIZENSDK_SQLITE_ARCHIVE="$(cygpath -m "$CITIZENSDK_WINDOWS_SQLITE_ARCHIVE")" \
    -DCITIZENSDK_ZXING_SOURCE_DIR="$(cygpath -m "$CITIZENSDK_ZXING_SOURCE_DIR")" \
    -DCITIZENSDK_BUILD_TESTS=ON \
    -DCITIZENSDK_TEST_WORK_DIR="$(cygpath -m "$test_root")" \
    -DCMAKE_INSTALL_PREFIX="$(cygpath -m "$prefix")"
  MSYS2_ARG_CONV_EXCL='*' cmake --build "$(cygpath -m "$build_root/cmake")" --config Release
  local test_inventory
  test_inventory="$(MSYS2_ARG_CONV_EXCL='*' ctest --test-dir "$(cygpath -m "$build_root/cmake")" -C Release --show-only=json-v1)" \
    || fail "Windows CTest 清单读取失败"
  CITIZENSDK_WINDOWS_TEST_INVENTORY="$test_inventory" node -e '
    const expected=["api_contract","assets","host_operation","lifecycle","directory","public_store","record_key","secure_store","sensitive_buffer","secret_vault","secret_boundary","cng","user_auth","wallet_flow"].map(x=>"CitizenSDK.Windows.citizen_sdk_"+x+"_test").sort();
    const actual=JSON.parse(process.env.CITIZENSDK_WINDOWS_TEST_INVENTORY).tests.map(x=>x.name).sort();
    if(JSON.stringify(actual)!==JSON.stringify(expected)) throw Error("Windows CTest exact set drift");
  ' || fail "Windows CTest 必须精确包含 14 个正式程序"
  MSYS2_ARG_CONV_EXCL='*' ctest --test-dir "$(cygpath -m "$build_root/cmake")" -C Release --no-tests=error --output-on-failure
  MSYS2_ARG_CONV_EXCL='*' cmake --install "$(cygpath -m "$build_root/cmake")" --config Release
  verify_windows_install "$prefix" "$software_version" "$core_dir" "$build_root/cmake"
  prepare_safe_directory "$work_dir" "$consumer_build" "Windows 独立消费者构建目录"
  MSYS2_ARG_CONV_EXCL='*' cmake -S "$(cygpath -m "$windows_source_root/test")" \
    -B "$(cygpath -m "$consumer_build")" -G 'Visual Studio 17 2022' -A x64 \
    -DCITIZENSDK_CONSUMER_PREFIX="$(cygpath -m "$prefix")" \
    -DCITIZENSDK_CONSUMER_VERSION="$software_version" -DCITIZENSDK_PLATFORM=Windows \
    -DCITIZENSDK_TEST_WORK_DIR="$(cygpath -m "$consumer_state")"
  MSYS2_ARG_CONV_EXCL='*' cmake --build "$(cygpath -m "$consumer_build")" --config Release
  run_windows_consumers "$consumer_build" "$prefix" "$consumer_state"
  build_windows_flutter_consumer "$build_root" "$prefix" "$software_version"
  # 消费者结束后再次核对安装件；改名后不再使用记录旧前缀的 install_manifest。
  verify_windows_install "$prefix" "$software_version" "$core_dir" "$build_root/cmake"
  export_windows_install "$prefix" "$destination"
  record_native_dependencies Windows
  echo "CitizenSDK Windows 原生、C/C++、Flutter adapter 与 Release 消费者检查完成；未执行正式发布"
}

verify_windows_exports() {
  local library="$1" header="$2" label="$3" exports internal_symbols=""
  # Core为147项公开闭集，无窗口私有符号；Host另导出自己的19项和4项统一图像接口。
  if [[ "$header" == "$product_header" ]]; then
    internal_symbols="$(product_internal_symbols)"
  else
    internal_symbols="$(qr_image_header_symbols)"
  fi
  # dumpbin 的完整导出表逐项比较，禁止先过滤 citizensdk 前缀掩盖额外导出。
  exports="$(MSYS2_ARG_CONV_EXCL='*' dumpbin /NOLOGO /EXPORTS "$(cygpath -m "$library")")" \
    || fail "Windows $label 无法读取 PE 导出"
  CITIZENSDK_PE_EXPORTS="$exports" CITIZENSDK_PE_LIBRARY="$(cygpath -m "$library")" \
    CITIZENSDK_PE_HEADER="$(cygpath -m "$header")" CITIZENSDK_PE_INTERNAL="$internal_symbols" node -e '
      const fs=require("fs"); const b=fs.readFileSync(process.env.CITIZENSDK_PE_LIBRARY);
      if(b.length<64 || b.readUInt16LE(0)!==0x5a4d) throw Error("not PE");
      const o=b.readUInt32LE(60);
      if(o>b.length-26 || b.readUInt32LE(o)!==0x4550 || b.readUInt16LE(o+4)!==0x8664 || b.readUInt16LE(o+24)!==0x20b) throw Error("wrong Windows PE machine");
      const actual=[...process.env.CITIZENSDK_PE_EXPORTS.matchAll(/^\s*\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)(.*)$/gm)];
      if(actual.some(x=>x[2].includes("="))) throw Error("forwarded export");
      const names=actual.map(x=>x[1]).sort();
      const expected=[...new Set([...fs.readFileSync(process.env.CITIZENSDK_PE_HEADER,"utf8").matchAll(/\b(citizensdk_[a-z0-9_]+)\s*\((?!\s*\*)/g)].map(x=>x[1]).concat(process.env.CITIZENSDK_PE_INTERNAL.split("\n").filter(Boolean)))].sort();
      if(JSON.stringify(names)!==JSON.stringify(expected)) throw Error("Windows full export set drift");
    ' || fail "Windows $label PE/COFF 或完整导出合同失败"
}

build_abi_host() {
  local destination source_library nm_bin extension prefix
  case "$(uname -s)" in
    Darwin)
      extension=dylib
      prefix=_
      nm_bin="$(xcrun --find llvm-nm)"
      ;;
    Linux)
      extension=so
      prefix=''
      nm_bin="$(command -v llvm-nm || command -v nm || true)"
      [[ -n "$nm_bin" ]] || fail "当前 Linux 宿主缺少 llvm-nm 或 nm"
      ;;
    *) fail "产品 ABI 宿主验证尚不支持：$(uname -s)" ;;
  esac
  destination="$output_dir/abi-host/libcitizensdk.$extension"
  CARGO_PROFILE_RELEASE_STRIP=false cargo build --manifest-path "$product_ffi_manifest" \
    --release --locked
  source_library="$CARGO_TARGET_DIR/release/libcitizensdk.$extension"
  [[ -f "$source_library" ]] || fail "CitizenSDK 产品 ABI 宿主库未生成"
  prepare_safe_output_file "$output_dir" "$destination" "CitizenSDK 产品 ABI 宿主库"
  cp "$source_library" "$destination"
  verify_product_abi_symbols "$destination" "$nm_bin" "$prefix" \
    "CitizenSDK 产品 ABI 宿主库"
  "${CC:-cc}" -std=c11 -fsyntax-only -I"$sdk_dir/include" \
    "$sdk_dir/native/ffi/tests/c_header_c11.c"
  "${CXX:-c++}" -std=c++17 -fsyntax-only -I"$sdk_dir/include" \
    "$sdk_dir/native/ffi/tests/c_header_cpp17.cc"
  echo "CitizenSDK 产品 ABI 宿主验证完成：$destination"
}

verify_outputs() {
  local android_core="$output_dir/android/arm64-v8a/libcitizensdk.so"
  local android_jni="$output_dir/android/arm64-v8a/libcitizensdk_jni.so"
  local android_aar="$output_dir/android/citizensdk.aar"
  local apple_xcframework="$output_dir/apple/CitizenSDK.xcframework"
  local host_library="$output_dir/host/libsmoldot.dylib"
  [[ -f "$android_core" && -f "$android_jni" && -f "$android_aar" \
    && -d "$apple_xcframework" \
    && -f "$host_library" ]] \
    || fail "Android/iOS/macOS 产品与 legacy macOS 宿主测试运行件集合不完整"
  local toolchain nm_bin
  toolchain="$(android_toolchain)"
  verify_product_abi_symbols "$android_core" "$toolchain/bin/llvm-nm" "" \
    "Android libcitizensdk.so"
  verify_android_aar \
    "$android_aar" "$android_core" "$android_jni" "$toolchain/bin/llvm-nm"
  verify_apple_xcframework "$apple_xcframework"
  nm_bin="$(xcrun --find llvm-nm)"
  local host_architectures
  host_architectures="$(xcrun lipo -archs "$host_library")"
  [[ "$host_architectures" == arm64 ]] \
    || fail "macOS 宿主测试库内部架构必须精确为 arm64"
  verify_symbol_contract "$(symbol_list_ios "$host_library" "$nm_bin")" "_" \
    "macOS 宿主测试库"
  echo "CitizenSDK Android AAR、iOS/macOS XCFramework 与 legacy macOS 宿主测试合同通过"
}

hosted_preflight() {
  [[ "$#" == 7 ]] || fail "Hosted 消费需要平台和 candidate、audit、hosted、flutter、pub-cache、tool-path"
  local platform="$1" candidate="$2" audit="$3" hosted="$4" flutter="$5" cache="$6" tool_path="$7"
  local path central="${RUNNER_TEMP:-}/citizensdk" first second
  [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
    || fail "跨平台最终包消费只允许一次性 GitHub Hosted Runner"
  case "$platform:$(uname -s):$(uname -m)" in
    Android:Linux:*|Android:Darwin:arm64|iOS:Darwin:arm64|LinuxARM:Linux:aarch64|LinuxAMD:Linux:x86_64|Windows:MINGW*:x86_64|Windows:MSYS*:x86_64) ;;
    *) fail "Hosted 消费宿主与平台不一致" ;;
  esac
  [[ "${CITIZENSDK_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "Hosted 消费缺少准确源码提交"
  if [[ "$platform" == Windows ]]; then central="$(cygpath -u "$RUNNER_TEMP")/citizensdk"; fi
  assert_readonly_dependency_directory "$central" "Hosted Runner 根"
  assert_readonly_dependency_directory "$sdk_dir" "Hosted 校验器源码"
  case "$central/" in "$sdk_dir/"*) fail "Hosted 工作根位于源码内" ;; esac
  case "$sdk_dir/" in "$central/"*) fail "Hosted 源码位于工作根内" ;; esac
  for path in "$candidate" "$flutter" "$cache" "$work_dir" "$output_dir"; do
    assert_readonly_dependency_directory "$path" "Hosted 输入目录"
    assert_descendant_path "$central" "$path" "Hosted 输入目录"
  done
  for path in "$audit" "$hosted"; do
    assert_descendant_path "$central" "$path" "Hosted 输入归档"
    assert_readonly_dependency_directory "$(dirname "$path")" "Hosted 输入父目录"
    [[ -f "$path" && ! -L "$path" ]] || fail "Hosted 输入归档不是普通文件"
  done
  local -a inputs=("$candidate" "$audit" "$hosted" "$flutter" "$cache" "$work_dir" "$output_dir")
  for ((first=0; first<${#inputs[@]}; first++)); do
    for ((second=first+1; second<${#inputs[@]}; second++)); do
      case "${inputs[first]}/" in "${inputs[second]}/"*) fail "Hosted 输入互相交叠" ;; esac
      case "${inputs[second]}/" in "${inputs[first]}/"*) fail "Hosted 输入互相交叠" ;; esac
    done
  done
  # Windows/APFS 的路径别名必须按真实路径再次拒绝，不能只比较 Shell 文本。
  local check_root="$central" item
  local -a check_inputs=("${inputs[@]}")
  if [[ "$platform" == Windows ]]; then
    check_root="$(cygpath -m "$central")"
    for ((first=0; first<${#check_inputs[@]}; first++)); do check_inputs[first]="$(cygpath -m "${check_inputs[first]}")"; done
  fi
  MSYS2_ARG_CONV_EXCL='*' node - "$check_root" "${check_inputs[@]}" <<'NODE' || fail "Hosted 输入真实路径漂移"
const fs=require('fs'),path=require('path');
const [root,...inputs]=process.argv.slice(2).map(value=>path.resolve(value));
const real=fs.realpathSync.native(root);
for(const input of inputs) {
  if(fs.realpathSync.native(input)!==path.join(real,path.relative(root,input))) throw Error('Hosted input path alias');
}
NODE
  [[ -n "$tool_path" && "$tool_path" != :* && "$tool_path" != *: && "$tool_path" != *::* ]] \
    || fail "Hosted 工具 PATH 含空项"
  local -a paths
  IFS=: read -r -a paths <<<"$tool_path"
  for path in "${paths[@]}"; do
    assert_readonly_dependency_directory "$path" "Hosted 工具 PATH"
    case "$work_dir/" in "$path/"*) fail "Hosted 工具 PATH 包含输出" ;; esac
    case "$path/" in "$work_dir/"*) fail "Hosted 工具 PATH 来自输出" ;; esac
  done
}

# 只由唯一发布器验真和展开同一 Hosted 字节；本阶段不调用 Cargo、安装件注入器
# 或源码 Host 构建。测试来源保留在已验真的审计候选，发布包自身不可补入测试。
build_hosted_consumer() (
  hosted_preflight "$@"
  local platform="$1" candidate="$2" audit="$3" hosted="$4" flutter="$5" cache="$6" tool_path="$7"
  local root="$work_dir/$platform" package="$work_dir/$platform/package" version incremental_root
  local source="$sdk_dir" candidate_native="$candidate" audit_native="$audit" hosted_native="$hosted" package_native="$package"
  [[ ! -e "$root" && ! -L "$root" ]] || fail "Hosted 消费目录必须全新"
  prepare_safe_directory "$work_dir" "$root" "Hosted 消费目录"
  incremental_root="${CITIZENSDK_INCREMENTAL_ROOT:-$root/incremental}"
  if [[ -n "${CITIZENSDK_INCREMENTAL_ROOT:-}" ]]; then
    assert_safe_directory_path "${CI_INCREMENTAL_ROOT:-}" "Hosted CI 缓存根"
    assert_safe_directory_path "$incremental_root" "Hosted CI 增量目录"
    assert_descendant_path "$CI_INCREMENTAL_ROOT" "$incremental_root" "Hosted CI 增量目录"
    [[ -d "$incremental_root" && ! -L "$incremental_root" ]] \
      || fail "Hosted CI 增量目录必须由中央缓存准备"
  else
    prepare_safe_directory "$root" "$incremental_root" "Hosted Release 全量目录"
  fi
  if [[ "$platform" == Windows ]]; then
    source="$(cygpath -m "$source")"; candidate_native="$(cygpath -m "$candidate")"
    audit_native="$(cygpath -m "$audit")"; hosted_native="$(cygpath -m "$hosted")"; package_native="$(cygpath -m "$package")"
  fi
  version="$(MSYS2_ARG_CONV_EXCL='*' node --input-type=module - "$source" "$candidate_native" \
    "$audit_native" "$hosted_native" "$package_native" <<'NODE'
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
const [source,candidate,audit,hosted,output]=process.argv.slice(2).map(value=>resolve(value));
const {verifyCitizenSdkHosted}=await import(pathToFileURL(join(source,'scripts/release.mjs')));
const manifest=verifyCitizenSdkHosted({candidatePath:candidate,archivePath:audit,
  hostedArchivePath:hosted,outputPath:output,expectedGitSha:process.env.CITIZENSDK_SOURCE_SHA});
process.stdout.write(manifest.software_version);
NODE
)" || fail "Hosted 唯一候选、审计归档或包字节验证失败"
  export CITIZENSDK_FLUTTER_ROOT="$flutter" PUB_CACHE="$cache" PATH="$tool_path"
  case "$platform" in
    LinuxARM|LinuxAMD)
      local prefix="$package/linux" build="$incremental_root/${platform,,}/cmake" state="$root/test-state"
      prepare_safe_directory "$work_dir" "$state" "Hosted 原生测试状态"
      prepare_safe_directory "$incremental_root" "$build" "Hosted CMake 增量目录"
      chmod 0700 "$state"
      # 候选已经逐字节验真。固定 checkout 测试源码使 CMake 能跨 CI run
      # 复用对象；动态安装前缀仍只指向本轮唯一候选。Release 根始终全新。
      cmake -S "$sdk_dir/linux/test" -B "$build" -DCMAKE_BUILD_TYPE=Release \
        -DCITIZENSDK_CONSUMER_PREFIX="$prefix" -DCITIZENSDK_PLATFORM="$platform" \
        -DCITIZENSDK_CONSUMER_VERSION="$version" -DCITIZENSDK_TEST_WORK_DIR="$state"
      cmake --build "$build" --config Release --parallel --target citizen_sdk_c_consumer citizen_sdk_cpp_consumer
      verify_linux_runtime_resolution "$build/citizen_sdk_c_consumer" "$prefix/lib/$platform"
      verify_linux_runtime_resolution "$build/citizen_sdk_cpp_consumer" "$prefix/lib/$platform"
      verify_linux_ctest_inventory "$(command -v ctest)" "$build" LinuxConsumer 2
      ctest --test-dir "$build" --build-config Release -L '^LinuxConsumer$' --no-tests=error --output-on-failure
      build_linux_flutter_consumer "$platform" "$root" "$prefix" "$(command -v cmake)" \
        "$(command -v ctest)" "$(command -v readelf)" "$(command -v nm)" "$package" "$candidate"
      ;;
    Windows)
      local prefix="$package/windows" build="$incremental_root/windows/cmake" state="$root/consumer-state"
      prepare_safe_directory "$incremental_root" "$build" "Hosted CMake 增量目录"
      MSYS2_ARG_CONV_EXCL='*' cmake -S "$(cygpath -m "$sdk_dir/windows/test")" \
        -B "$(cygpath -m "$build")" -G 'Visual Studio 17 2022' -A x64 \
        -DCITIZENSDK_CONSUMER_PREFIX="$(cygpath -m "$prefix")" -DCITIZENSDK_PLATFORM=Windows \
        -DCITIZENSDK_CONSUMER_VERSION="$version" -DCITIZENSDK_TEST_WORK_DIR="$(cygpath -m "$state")" \
        -DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE="$(cygpath -m "$build/release")" \
        -DCMAKE_LIBRARY_OUTPUT_DIRECTORY_RELEASE="$(cygpath -m "$build/release")" \
        -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY_RELEASE="$(cygpath -m "$build/release")"
      MSYS2_ARG_CONV_EXCL='*' cmake --build "$(cygpath -m "$build")" --config Release
      run_windows_consumers "$build" "$prefix" "$state" release
      build_windows_flutter_consumer "$root" "$prefix" "$version" "$package" "$candidate"
      ;;
    Android|iOS) build_mobile_hosted_consumer "$platform" "$root" "$package" "$candidate" "$version" ;;
  esac
  echo "CitizenSDK $platform 最终 Hosted 包消费通过"
)

build_mobile_hosted_consumer() (
  local platform="$1" root="$2" package="$3" candidate="$4" version="$5"
  local runner="$root/consumer" flutter_root="$CITIZENSDK_FLUTTER_ROOT" dart_bin native_platform incremental_root
  local -a flutter
  dart_bin="$flutter_root/bin/cache/dart-sdk/bin/dart"
  [[ -x "$dart_bin" ]] || fail "移动 Hosted 缺少已预装 Dart"
  node - "$flutter_root" "$PUB_CACHE" <<'NODE' || fail "移动 Hosted Flutter 工具配置越出显式输入"
const fs=require('fs'),path=require('path'),url=require('url');
const [flutter,cache]=process.argv.slice(2);
const config=path.join(flutter,'packages/flutter_tools/.dart_tool/package_config.json');
for(const file of [config,path.join(flutter,'bin/cache/flutter_tools.snapshot'),path.join(flutter,'bin/cache/dart-sdk/bin/dart')]) {
  if(!fs.lstatSync(file).isFile() || fs.realpathSync.native(file)!==file) throw Error('Mobile Hosted tool path alias');
}
const value=JSON.parse(fs.readFileSync(config,'utf8'));
if(value.configVersion!==2 || !Array.isArray(value.packages) || value.packages.length===0) throw Error('Mobile Hosted tool configuration missing');
for(const item of value.packages) {
  const root=url.fileURLToPath(new URL(item.rootUri,url.pathToFileURL(config)));
  const resolved=path.resolve(root);
  if(![flutter,cache].some(parent=>resolved.startsWith(parent+path.sep)) || fs.realpathSync.native(resolved)!==resolved) {
    throw Error('Mobile Hosted tool dependency outside explicit Flutter/Pub inputs');
  }
}
NODE
  flutter=("$dart_bin" "--packages=$flutter_root/packages/flutter_tools/.dart_tool/package_config.json"
    "$flutter_root/bin/cache/flutter_tools.snapshot" --no-version-check --suppress-analytics)
  case "$platform" in Android) native_platform=android ;; iOS) native_platform=ios ;; *) fail "未登记的移动 Hosted 平台" ;; esac
  export FLUTTER_SUPPRESS_ANALYTICS=true
  incremental_root="${CITIZENSDK_INCREMENTAL_ROOT:-$root/incremental}"
  prepare_safe_directory "$incremental_root" "$incremental_root/$platform" "移动 Hosted 增量目录"
  unset FLUTTER_TOOL_ARGS FLUTTER_ANALYTICS_LOG_FILE FLUTTER_STORAGE_BASE_URL \
    PUB_HOSTED_URL DART_VM_OPTIONS DART_VM_FLAGS FLUTTER_ENGINE FLUTTER_ENGINE_SRC_PATH \
    CITIZENSDK_ANDROID_CORE_DIR
  "${flutter[@]}" create --offline --no-pub --platforms="$native_platform" \
    --project-name=citizensdk_consumer --org=org.citizen "$runner"
  node - "$runner" "$candidate" "$version" <<'NODE'
const fs=require('fs'),path=require('path');
const [runner,candidate,version]=process.argv.slice(2);
fs.writeFileSync(path.join(runner,'pubspec.yaml'),`name: citizensdk_consumer\npublish_to: none\nversion: ${version}\nenvironment:\n  sdk: ">=3.8.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  citizen_sdk:\n    path: ../package\nflutter:\n  uses-material-design: true\n`);
fs.copyFileSync(path.join(candidate,'pubspec.lock'),path.join(runner,'pubspec.lock'));
// 编译入口只引用正式公开 API，不引入产品业务或私有实现；没有设备运行就不宣称运行验收。
fs.writeFileSync(path.join(runner,'lib/main.dart'),`import 'package:flutter/widgets.dart';\nimport 'package:citizen_sdk/citizen_sdk.dart';\nFuture<void> main() async { WidgetsFlutterBinding.ensureInitialized(); final sdk = await CitizenSdk.open(); await sdk.close(); }\n`);
const project=path.join(runner,'ios/Runner.xcodeproj/project.pbxproj');
if(fs.existsSync(project)) {
  const text=fs.readFileSync(project,'utf8');
  if(!text.includes('IPHONEOS_DEPLOYMENT_TARGET = ')) throw Error('iOS deployment setting missing');
  fs.writeFileSync(project,text.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g,'IPHONEOS_DEPLOYMENT_TARGET = 16.0;'));
  const podfile=path.join(runner,'ios/Podfile');
  if(fs.existsSync(podfile)) {
    const pods=fs.readFileSync(podfile,'utf8');
    if(!/^#?\s*platform :ios, '[0-9.]+'/m.test(pods)) throw Error('Official iOS Podfile platform setting missing');
    fs.writeFileSync(podfile,pods.replace(/^#?\s*platform :ios, '[0-9.]+'/m,"platform :ios, '16.0'"));
  }
}
const gradle=path.join(runner,'android/app/build.gradle.kts');
if(fs.existsSync(gradle)) {
  const text=fs.readFileSync(gradle,'utf8');
  if(!text.includes('minSdk = flutter.minSdkVersion')) throw Error('Official Android minimum SDK setting missing');
  // SDK 运行件已经由唯一构建器 strip；消费宿主不得再改写同包二进制。
  fs.writeFileSync(gradle,text.replace('minSdk = flutter.minSdkVersion','minSdk = 24')+
    '\nandroid { packaging { jniLibs { keepDebugSymbols += setOf("**/libcitizensdk.so", "**/libcitizensdk_jni.so") } } }\n');
}
NODE
  (cd "$runner" && "${flutter[@]}" pub get --offline)
  if [[ "$platform" == Android ]]; then
    export CITIZENSDK_ANDROID_BUILD_DIR="$root/android-build"
    export GRADLE_USER_HOME="$incremental_root/android/gradle-home"
    mkdir -p "$GRADLE_USER_HOME"
    (cd "$runner" && "${flutter[@]}" build apk --release --no-pub --target-platform=android-arm64)
    local apk="$runner/build/app/outputs/flutter-apk/app-release.apk" library
    [[ -f "$apk" && ! -L "$apk" ]] || fail "Android Hosted Release APK 缺失"
    for library in libcitizensdk.so libcitizensdk_jni.so; do
      cmp -s <(unzip -p "$apk" "lib/arm64-v8a/$library") "$package/android/src/main/jniLibs/arm64-v8a/$library" \
        || fail "Android 最终 APK 的 SDK 库字节不是同一 Hosted 包"
    done
  else
    (cd "$runner" && "${flutter[@]}" build ios --release --no-pub --no-codesign)
    # iOS Simulator 不以 Debug Flutter 模式代替 Release。直接编译、链接公开 Swift
    # 绑定与包内 Simulator slice；没有启动模拟器，因此这里只记录链接验收。
    local framework simulator_sdk swift_source="$root/consumer.swift"
    framework="$(resolve_xcframework_framework_slice "$package/darwin/CitizenSDK.xcframework" CitizenSDK ios simulator)"
    simulator_sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
    printf '%s\n' 'import CitizenSDK' 'public func citizenSdkConsumer() throws { let sdk = try CitizenSdk.open(); try sdk.close() }' >"$swift_source"
    xcrun --sdk iphonesimulator swiftc "$swift_source" -emit-library -O -warnings-as-errors \
      -sdk "$simulator_sdk" -target arm64-apple-ios16.0-simulator \
      -module-cache-path "$incremental_root/ios/module-cache" \
      -F "$(dirname "$framework")" -framework CitizenSDK -o "$root/consumer.dylib"
    [[ "$(xcrun lipo -archs "$root/consumer.dylib")" == arm64 ]] || fail "iOS Simulator 消费者架构漂移"
    xcrun otool -L "$root/consumer.dylib" | grep -Fq '@rpath/CitizenSDK.framework/CitizenSDK' \
      || fail "iOS Simulator 未链接最终包的 CitizenSDK"
  fi
  echo "CitizenSDK $platform 最终包宿主编译链接通过；未进行真机运行"
)

require_zxing_source() {
  local source="${CITIZENSDK_ZXING_SOURCE_DIR:-}"
  [[ -n "$source" && "$source" == /* && -d "$source" && ! -L "$source" \
    && -f "$source/CMakeLists.txt" && ! -L "$source/CMakeLists.txt" \
    && -f "$source/core/src/ZXingC.h" && ! -L "$source/core/src/ZXingC.h" ]] \
    || fail "必须通过 CITIZENSDK_ZXING_SOURCE_DIR 提供完整官方 ZXing-C++ 3.1.1 源码"
  grep -Fq 'project (ZXing VERSION "3.1.1")' "$source/core/CMakeLists.txt" \
    || fail "ZXing-C++ 源码版本必须精确为 3.1.1"
}

case "$target_name" in
  android|apple|LinuxARM|LinuxAMD|Windows|all)
    if [[ "$hosted_consumer" != true ]]; then require_zxing_source; fi ;;
esac

# 每轮编译只使用SDK自身装配的普通文件工程；build.rs不能写回上游原件。
prepare_native_source() {
  local node_bin="${NODE:-$(command -v node || true)}" source="$sdk_dir" destination="$work_dir/native-source"
  [[ -n "$node_bin" && -x "$node_bin" ]] || fail "原生输入装配缺少Node"
  if [[ "$target_name" == Windows ]]; then
    source="$(cygpath -m "$source")"
    destination="$(cygpath -m "$destination")"
  fi
  native_source_root="$("$node_bin" "$sdk_dir/scripts/release.mjs" \
    --native-source-view "$source" --output "$destination")" || fail "原生输入装配失败"
  ffi_manifest="$native_source_root/native/smoldot/ffi/Cargo.toml"
  product_ffi_manifest="$native_source_root/native/ffi/Cargo.toml"
}

case "$target_name" in
  android|apple|LinuxARM|LinuxAMD|Windows|host|abi-host|all)
    if [[ "$hosted_consumer" != true ]]; then prepare_native_source; fi ;;
esac

case "$target_name" in
  android) build_android ;;
  apple) build_apple ;;
  macOS) shift; build_macos_flutter_consumer "$@" ;;
  Android|iOS) build_hosted_consumer "$@" ;;
  LinuxARM|LinuxAMD)
    if [[ "$hosted_consumer" == true ]]; then build_hosted_consumer "$@"; else build_linux "$target_name"; fi ;;
  Windows)
    if [[ "$hosted_consumer" == true ]]; then build_hosted_consumer "$@"; else build_windows; fi ;;
  host) build_host ;;
  abi-host) build_abi_host ;;
  apple-tests) build_apple_tests ;;
  all) build_android; build_apple; build_apple_tests; build_host; verify_outputs ;;
  verify) verify_outputs ;;
  __test-android-toolchain)
    [[ "${CITIZENSDK_BUILD_TEST:-}" == 1 ]] || fail "Android toolchain 测试入口未授权"
    android_toolchain
    ;;
  __test-product-abi-symbols)
    [[ "${CITIZENSDK_BUILD_TEST:-}" == 1 ]] || fail "产品 ABI 符号测试入口未授权"
    [[ -n "${CITIZENSDK_TEST_LIBRARY:-}" && -n "${CITIZENSDK_TEST_NM_BIN:-}" ]] \
      || fail "产品 ABI 符号测试缺少伪库或 nm"
    verify_product_abi_symbols \
      "$CITIZENSDK_TEST_LIBRARY" \
      "$CITIZENSDK_TEST_NM_BIN" \
      "${CITIZENSDK_TEST_SYMBOL_PREFIX:-}" \
      "CitizenSDK 产品 ABI 测试库"
    ;;
  __test-jni-symbols)
    [[ "${CITIZENSDK_BUILD_TEST:-}" == 1 ]] || fail "JNI 符号测试入口未授权"
    [[ -n "${CITIZENSDK_TEST_LIBRARY:-}" && -n "${CITIZENSDK_TEST_NM_BIN:-}" ]] \
      || fail "JNI 符号测试缺少伪库或 nm"
    verify_jni_symbols "$CITIZENSDK_TEST_LIBRARY" "$CITIZENSDK_TEST_NM_BIN"
    ;;
  __test-android-elf-identity)
    [[ "${CITIZENSDK_BUILD_TEST:-}" == 1 ]] || fail "Android ELF 测试入口未授权"
    [[ -n "${CITIZENSDK_TEST_CORE_LIBRARY:-}" \
      && -n "${CITIZENSDK_TEST_JNI_LIBRARY:-}" \
      && -n "${CITIZENSDK_TEST_READELF_BIN:-}" ]] \
      || fail "Android ELF 测试缺少伪库或 readelf"
    verify_android_elf_identity \
      "$CITIZENSDK_TEST_CORE_LIBRARY" \
      "$CITIZENSDK_TEST_JNI_LIBRARY" \
      "$CITIZENSDK_TEST_READELF_BIN"
    ;;
  __test-safe-output-file)
    [[ "${CITIZENSDK_BUILD_TEST:-}" == 1 ]] || fail "安全写路径测试入口未授权"
    [[ -n "${CITIZENSDK_TEST_OUTPUT_RELATIVE:-}" \
      && "${CITIZENSDK_TEST_OUTPUT_RELATIVE}" != /* ]] \
      || fail "安全写路径测试缺少相对目标"
    prepare_safe_output_file \
      "$output_dir" \
      "$output_dir/$CITIZENSDK_TEST_OUTPUT_RELATIVE" \
      "CitizenSDK 安全写路径测试目标"
    ;;
  *) fail "用法：$0 android|apple|LinuxARM|LinuxAMD|Windows|apple-tests|host|abi-host|all|verify；最终包消费：$0 Android|iOS|macOS|LinuxARM|LinuxAMD|Windows candidate audit hosted flutter pub-cache tool-path" ;;
esac
