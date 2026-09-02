#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 GHOSTTY_SOURCE" >&2
  exit 64
fi

source_dir=$1
script_dir=$(cd "$(dirname "$0")" && pwd)
proof_dir=$(cd "$script_dir/.." && pwd)
patch_one="$proof_dir/patches/0001-add-absolute-viewport-cursor-api.patch"
patch_one_sha=878ca0245dc6c35791eeb06c599d01808b680798c6510ffc22bf76bb0bbba8d6
patch_two="$proof_dir/patches/0002-add-logical-history-generation.patch"
patch_two_sha=2abc14c6f0522892352490b78195862694c5d375211417971eb0430054576be0
patch_three="$proof_dir/patches/0003-add-atomic-dirty-ack.patch"
patch_three_sha=141771357a3cc07c17c696d0d94daad0f0c2e2a0caf6c47e54bb3baacf847592
patch_set_sha=6468c232df41867773d217459d35404d3c716d6d0560b6be1226b3a46e3f481a
marker="$source_dir/.tmux-ide-ghostty-patches"
source_manifest="$source_dir/.tmux-ide-source.sha256"

printf '%s  %s\n%s  %s\n%s  %s\n' \
  "$patch_one_sha" "$patch_one" "$patch_two_sha" "$patch_two" "$patch_three_sha" "$patch_three" |
  shasum -a 256 -c -
if [[ -f "$marker" ]] && [[ "$(tr -d '\n' < "$marker")" == "$patch_set_sha" ]]; then
  "$script_dir/verify-patched-source.sh" "$source_dir"
  exit 0
fi

patch --batch --forward -d "$source_dir" -p1 < "$patch_one"
patch --batch --forward -d "$source_dir" -p1 < "$patch_two"
patch --batch --forward -d "$source_dir" -p1 < "$patch_three"
printf '%s\n' "$patch_set_sha" > "$marker"
(cd "$source_dir" &&
  LC_ALL=C find . -type f ! -path './.git/*' ! -name '.tmux-ide-*' -print0 |
    LC_ALL=C sort -z | xargs -0 shasum -a 256 > "$source_manifest")
"$script_dir/verify-patched-source.sh" "$source_dir"
