#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 GHOSTTY_SOURCE ZIG_EXECUTABLE ZIG_GLOBAL_CACHE OUTPUT_DIR" >&2
  exit 64
fi
if [[ "$(uname -s)-$(uname -m)" != "Linux-aarch64" ]]; then
  echo "this pinned cross-build recipe requires a Linux arm64 builder" >&2
  exit 65
fi

source_dir=$1
zig=$2
dependency_cache=$3
output_dir=$4
expected_commit=48ccec182a932c2ec04c344d45a5fc553861cb13
expected_dependency_manifest=f166b0d0b201e01fa7d1bab76c21296004938c0b06c652b16f9def2f2db78b58
script_dir=$(cd "$(dirname "$0")" && pwd)
proof_dir=$(cd "$script_dir/.." && pwd)
"$script_dir/verify-recipe.sh" "$proof_dir" "$zig"
if [[ -d "$source_dir/.git" ]]; then
  actual_commit=$(git -C "$source_dir" rev-parse HEAD)
elif [[ -f "$source_dir/.tmux-ide-pinned-commit" ]]; then
  actual_commit=$(tr -d '\n' < "$source_dir/.tmux-ide-pinned-commit")
else
  echo "Ghostty source has no verifiable commit marker" >&2
  exit 67
fi
if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "Ghostty commit mismatch: expected $expected_commit, got $actual_commit" >&2
  exit 68
fi
"$script_dir/verify-patched-source.sh" "$source_dir"
if [[ ! -f "$dependency_cache/.tmux-ide-dependencies-for" ]] ||
   [[ "$(tr -d '\n' < "$dependency_cache/.tmux-ide-dependencies-for")" != "$expected_commit" ]]; then
  echo "verified prefetched Zig dependency cache is required" >&2
  exit 69
fi
if [[ ! -f "$dependency_cache/.tmux-ide-dependencies.sha256" ]] ||
   [[ "$(shasum -a 256 "$dependency_cache/.tmux-ide-dependencies.sha256" | awk '{print $1}')" != "$expected_dependency_manifest" ]] ||
   ! (cd "$dependency_cache" && shasum -a 256 -c .tmux-ide-dependencies.sha256 >/dev/null); then
  echo "immutable Zig dependency package cache verification failed" >&2
  exit 72
fi

node_include=${NODE_INCLUDE_DIR:-}
if [[ -z "$node_include" ]]; then
  for candidate in /usr/include/node /usr/local/include/node; do
    if [[ -f "$candidate/node_api.h" ]]; then node_include=$candidate; break; fi
  done
fi
if [[ -z "$node_include" || ! -f "$node_include/node_api.h" ]]; then
  echo "set NODE_INCLUDE_DIR to a directory containing node_api.h" >&2
  exit 70
fi
"$script_dir/verify-node-headers.sh" "$node_include"

if [[ -e "$output_dir" ]]; then
  echo "output target already exists; refusing a non-atomic overwrite" >&2
  exit 73
fi
stage="${output_dir}.tmp.$$"
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/install" "$stage/zig-cache-global" "$stage/zig-cache-local"
ZIG_GLOBAL_CACHE_DIR="$stage/zig-cache-global" \
ZIG_LOCAL_CACHE_DIR="$stage/zig-cache-local" \
SOURCE_DATE_EPOCH=0 \
  "$zig" build \
    --build-file "$source_dir/build.zig" \
    --system "$dependency_cache/p" \
    -Demit-lib-vt=true \
    -Dtarget=aarch64-macos.15.0 \
    -Doptimize=ReleaseFast \
    -Dsimd=false \
    -Dstrip=true \
    -Dlib-version-string=0.1.0 \
    -p "$stage/install"

SOURCE_DATE_EPOCH=0 "$zig" cc \
  -target aarch64-macos.15.0 \
  -std=c11 -O3 -Wall -Wextra -Werror \
  -DNAPI_VERSION=9 -DNODE_GYP_MODULE_NAME=ghostty_vt_proof \
  -dynamiclib -undefined dynamic_lookup \
  -I"$node_include" -I"$stage/install/include" \
  "$proof_dir/src/addon.c" "$stage/install/lib/libghostty-vt.a" \
  -o "$stage/ghostty_vt_proof.node"

shasum -a 256 "$stage/ghostty_vt_proof.node"
mv "$stage" "$output_dir"
trap - EXIT
