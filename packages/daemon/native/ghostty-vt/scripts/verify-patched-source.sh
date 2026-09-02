#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 GHOSTTY_SOURCE" >&2
  exit 64
fi

source_dir=$1
expected_patch=6468c232df41867773d217459d35404d3c716d6d0560b6be1226b3a46e3f481a
expected_source_manifest=e6384d48450768b319b930b3083272cb0bf7bf36bb3028713fe9b35a021a2c48
marker="$source_dir/.tmux-ide-ghostty-patches"
source_manifest="$source_dir/.tmux-ide-source.sha256"
actual_manifest=$(mktemp "${TMPDIR:-/tmp}/tmux-ide-ghostty-source.XXXXXX")
trap 'rm -f -- "$actual_manifest"' EXIT
if [[ ! -f "$marker" ]] || [[ "$(tr -d '\n' < "$marker")" != "$expected_patch" ]]; then
  echo "verified tmux-ide Ghostty patch set is required" >&2
  exit 65
fi

if [[ -f "$source_manifest" ]]; then
  (cd "$source_dir" &&
    LC_ALL=C find . -type f ! -path './.git/*' ! -name '.tmux-ide-*' -print0 |
      LC_ALL=C sort -z | xargs -0 shasum -a 256 > "$actual_manifest")
fi
if [[ ! -f "$source_manifest" ]] ||
   [[ "$(shasum -a 256 "$source_manifest" | awk '{print $1}')" != "$expected_source_manifest" ]] ||
   ! cmp -s "$source_manifest" "$actual_manifest"; then
  echo "complete patched Ghostty source-tree verification failed" >&2
  exit 66
fi
