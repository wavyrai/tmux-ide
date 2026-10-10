#!/usr/bin/env bash
# Build and launch only the isolated tmux snapshot entry point.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if (( $# > 1 )); then
  echo 'Usage: preview.sh [snapshot.json]' >&2
  exit 2
fi
snapshot=${1:-"$project_dir/fixtures/snapshot.json"}
case "$snapshot" in /*) ;; *) snapshot="$PWD/$snapshot" ;; esac
cd "$project_dir/upstream"
exec cargo run --locked -p herdr-gpui --bin tmux-ide-gpui -- --tmux-snapshot "$snapshot"
