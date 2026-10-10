#!/usr/bin/env bash
# Transitional interactive session/pane picker for the native read-only preview.
set -euo pipefail
if (( $# != 1 )); then
  echo 'Usage: select-preview.sh /absolute/path/private-host.json' >&2
  exit 2
fi
host=$1
case "$host" in /*) ;; *) host="$PWD/$host" ;; esac
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir/upstream"
cargo build --locked -p herdr-gpui --bin tmux-ide-gpui
exec node --import tsx "$project_dir/bridge/select-preview.ts" "$project_dir/upstream/target/debug/tmux-ide-gpui" "$host"
