#!/usr/bin/env bash
# Headless gate; local-app tests require an explicit TMUX_GPUI_TEST_APP.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo_root"
pnpm exec tsc -p apps/tmux-gpui/bridge/tsconfig.json
node --import tsx --test apps/tmux-gpui/bridge/*.test.ts apps/tmux-gpui/bridge/*.test.mjs apps/tmux-gpui/scripts/*.test.mjs
