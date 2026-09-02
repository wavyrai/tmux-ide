#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)-$(uname -m)" != "Linux-aarch64" ]]; then
  echo "the provenance-qualified native host recipe is pinned to Linux arm64" >&2
  exit 65
fi

cc_path=$(realpath "$(command -v cc)")
strip_path=$(realpath "$(command -v strip)")
printf '%s  %s\n%s  %s\n' \
  dc53dbc5a583d03ae8ed6272ca9afc0f58873f9f9b86dd7d448b17fb3f88a8d0 "$cc_path" \
  09ea31b5f54325e60310f43ee17fa532b4f816a177a13f4b59f72767d26932bf "$strip_path" |
  shasum -a 256 -c -
