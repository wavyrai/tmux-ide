#!/bin/sh
# Explicit execution only; this preparation does not launch anything.
set -eu
repo=/Users/thijs/.codex/worktrees/gpui-main-release/tmux-ide
node=/private/tmp/tmux-ide-295-release-nkydyctm/bin/node
app=${1:?Pass the absolute path of an approved unique QA .app bundle}
case "$app" in
  "$repo"/.tasks/*.app) ;;
  *) echo 'Refusing an app outside this worktree .tasks directory' >&2; exit 2 ;;
esac
cd "$repo"
exec env -i \
  HOME="$HOME" TMPDIR=/tmp LANG=en_US.UTF-8 TERM=xterm-256color \
  PATH="$repo/packages/daemon/dist/native/tmux/darwin-arm64:/private/tmp/tmux-ide-295-release-nkydyctm/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  TMUX_GPUI_TEST_CLI="$repo/.tasks/neutral-chrome-cli.mjs" \
  TMUX_GPUI_TEST_APP="$app" \
  "$node" --import tsx "$repo/.tasks/native-two-pane-overnight-20261016/run.mjs"
