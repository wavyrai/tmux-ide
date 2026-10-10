#!/usr/bin/env bash
# Opt-in read-only native client; never discovers or starts a personal daemon.
set -euo pipefail
if (( $# != 1 )); then
  echo 'Usage: live-preview.sh /absolute/path/private-connection.json' >&2
  exit 2
fi
connection=$1
case "$connection" in /*) ;; *) connection="$PWD/$connection" ;; esac
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir/upstream"
cargo build --locked -p herdr-gpui --bin tmux-ide-gpui
exec node "$project_dir/bridge/preview-launcher.mjs" "$project_dir/upstream/target/debug/tmux-ide-gpui" "$connection"
