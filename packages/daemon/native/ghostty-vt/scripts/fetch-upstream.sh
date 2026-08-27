#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 CACHE_DIR" >&2
  exit 64
fi

cache_dir=$1
commit=48ccec182a932c2ec04c344d45a5fc553861cb13
ghostty_sha=7d794072fd52696f0d89ab346da230018ec97f75c77b056c70b20294986f35ec
dependency_manifest_sha=f166b0d0b201e01fa7d1bab76c21296004938c0b06c652b16f9def2f2db78b58
script_dir=$(cd "$(dirname "$0")" && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    zig_name=zig-aarch64-macos-0.15.2
    zig_sha=3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b
    ;;
  Darwin-x86_64)
    zig_name=zig-x86_64-macos-0.15.2
    zig_sha=375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f
    ;;
  Linux-aarch64)
    zig_name=zig-aarch64-linux-0.15.2
    zig_sha=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f
    ;;
  Linux-x86_64)
    zig_name=zig-x86_64-linux-0.15.2
    zig_sha=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239
    ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 65 ;;
esac

if [[ -e "$cache_dir" ]]; then
  echo "cache target already exists; refusing to merge into an unverified tree" >&2
  exit 66
fi
stage="${cache_dir}.tmp.$$"
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/downloads" "$stage/ghostty" "$stage/zig"
cache_dir=$stage
ghostty_archive="$cache_dir/downloads/ghostty-$commit.tar.gz"
zig_archive="$cache_dir/downloads/$zig_name.tar.xz"

curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/ghostty-org/ghostty/archive/$commit.tar.gz" \
  --output "$ghostty_archive"
printf '%s  %s\n' "$ghostty_sha" "$ghostty_archive" | shasum -a 256 -c -
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://ziglang.org/download/0.15.2/$zig_name.tar.xz" \
  --output "$zig_archive"
printf '%s  %s\n' "$zig_sha" "$zig_archive" | shasum -a 256 -c -

tar -xzf "$ghostty_archive" --strip-components=1 -C "$cache_dir/ghostty"
tar -xJf "$zig_archive" --strip-components=1 -C "$cache_dir/zig"
printf '%s\n' "$commit" > "$cache_dir/ghostty/.tmux-ide-pinned-commit"
"$script_dir/apply-patches.sh" "$cache_dir/ghostty"
"$cache_dir/zig/zig" version
mkdir -p "$cache_dir/zig-global-cache" "$cache_dir/zig-fetch-local-cache"
ZIG_GLOBAL_CACHE_DIR="$cache_dir/zig-global-cache" \
ZIG_LOCAL_CACHE_DIR="$cache_dir/zig-fetch-local-cache" \
  "$cache_dir/zig/zig" build \
    --build-file "$cache_dir/ghostty/build.zig" \
    --fetch=needed \
    -Demit-lib-vt=true \
    -Doptimize=ReleaseFast \
    -Dsimd=false \
    -Dstrip=true \
    -Dlib-version-string=0.1.0
printf '%s\n' "$commit" > "$cache_dir/zig-global-cache/.tmux-ide-dependencies-for"
(cd "$cache_dir/zig-global-cache" &&
  LC_ALL=C find p -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 > .tmux-ide-dependencies.sha256)
printf '%s  %s\n' "$dependency_manifest_sha" "$cache_dir/zig-global-cache/.tmux-ide-dependencies.sha256" |
  shasum -a 256 -c -
final_dir=${stage%.tmp.$$}
mv "$stage" "$final_dir"
trap - EXIT
