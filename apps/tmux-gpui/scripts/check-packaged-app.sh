#!/usr/bin/env bash
# Headless macOS ARM64 packaging gate. No signing, launch or publication.
set -euo pipefail
if [[ $# -ne 3 || "$1" != /* || "$2" != /* || "$3" != /* ]]; then
  echo 'Usage: check-packaged-app.sh NODE24_BINARY NODE_LICENSE NEW_ABSOLUTE_OUTPUT' >&2
  exit 2
fi
node_binary=$1
node_license=$2
output=$3
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo_root"
test -r "$node_license"
mkdir "$output"
"$node_binary" apps/tmux-gpui/scripts/build-native-release.mjs "$output/native-build.json" 2> "$output/build-errors.log" | tee "$output/build.log"
native_binary=$("$node_binary" --input-type=module - "$output/build.log" "$output/native-build.json" <<'JS'
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
const records = readFileSync(process.argv[2], 'utf8').split('\n').flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
}).filter(record => record?.receipt === resolve(process.argv[3]));
if (records.length !== 1 || typeof records[0].native !== 'string' || !isAbsolute(records[0].native)) {
  throw new Error('Missing unique native artifact from the build wrapper');
}
console.log(records[0].native);
JS
)
app="$output/Tmux IDE CI.app"
"$node_binary" apps/tmux-gpui/scripts/assemble-local-app.mjs \
  "$native_binary" "$node_binary" "$node_license" "$output/native-build.json" "$app" \
  2>&1 | tee "$output/assembly.log"
TMUX_GPUI_TEST_APP="$app" "$node_binary" --import tsx --test \
  apps/tmux-gpui/bridge/local-app.test.mjs apps/tmux-gpui/bridge/compatibility-process.test.mjs \
  2>&1 | tee "$output/package-tests.log"
