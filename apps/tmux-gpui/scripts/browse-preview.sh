#!/usr/bin/env bash
# Native session/pane picker using an explicitly selected local daemon.
set -euo pipefail
if (( $# > 1 )); then
  echo 'Usage: browse-preview.sh [/absolute/path/private-host.json]' >&2
  exit 2
fi
host=${1:---local}
case "$host" in --local|/*) ;; *) host="$PWD/$host" ;; esac
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir/upstream"
cargo build --locked -p herdr-gpui --bin tmux-ide-gpui
exec node "$project_dir/bridge/preview-launcher.mjs" "$project_dir/upstream/target/debug/tmux-ide-gpui" "$host" --browse
