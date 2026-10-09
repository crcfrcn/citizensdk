#!/usr/bin/env bash
# 现有消费者入口；正文及回归唯一位于 build.mjs。
set -euo pipefail
script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
  link_target="$(readlink "$script_path")"
  [[ "$link_target" == /* ]] || link_target="$(cd "$(dirname "$script_path")" && pwd -P)/$link_target"
  script_path="$link_target"
done
script_dir="$(cd "$(dirname "$script_path")" && pwd -P)"
exec "${NODE:-node}" "$script_dir/build.mjs" native "$@"
