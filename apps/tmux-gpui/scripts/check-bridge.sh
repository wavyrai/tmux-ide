#!/usr/bin/env bash
# Headless gate; local-app tests require an explicit TMUX_GPUI_TEST_APP.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo_root"
node --import tsx apps/tmux-gpui/scripts/generate-native-appearance.ts --check
pnpm exec tsc -p apps/tmux-gpui/bridge/tsconfig.json
node --import tsx --test --test-concurrency=2 apps/tmux-gpui/bridge/*.test.ts apps/tmux-gpui/bridge/*.test.mjs apps/tmux-gpui/scripts/*.test.mjs apps/tmux-gpui/bridge/performance/*.test.mjs
