#!/bin/zsh
# Freeze/typing live check (#702, #706). Headless: no window, no focus.
# Builds nothing. Usage, from the repository root:
#   apps/tmux-gpui/bridge/manual/freeze-typing-live.sh TEST_BINARY [RUNS] [SESSION] [FREEZE_SECS]
# TEST_BINARY: the tmux-ide-gpui lib test executable (`cargo test --release -p tmux-ide-gpui --lib --no-run`).
# Each run: private tmux server (sessions p1, p3, p8, p12), a private daemon from this tree's bin/cli.js
# (run `node scripts/build-cli.mjs` first), then the ignored test: open SESSION, stream output in every
# pane, SIGSTOP the daemon FREEZE_SECS (> pause-after=2), SIGCONT, type `echo MARK`, require it in tmux
# and in the app's frame. Never touches ~/.tmux-ide, the default tmux server or a launchd daemon.
set -u
BIN=${1:?test binary}; RUNS=${2:-6}; SESSION=${3:-p8}; SECS=${4:-10}
TREE=${0:a:h:h:h:h:h}; ROOT=$(mktemp -d /tmp/tmi-freeze-XXXX)
export HOME=$ROOT/home XDG_CONFIG_HOME=$ROOT/home/.config TMUX_IDE_RUNTIME_MODE=performance \
  TMUX_IDE_HOME=$ROOT/state TMUX_IDE_REGISTRY_DIR=$ROOT/registry TMUX_IDE_DAEMON_INFO_DIR=$ROOT/daemon \
  TMUX_IDE_SETTINGS_DIR=$ROOT/settings TMUX_IDE_CONFIG=$ROOT/state/config.json \
  TMUX_IDE_TMUX_SOCKET_PATH=$ROOT/t.sock TMUX_IDE_CLEANUP_TOKEN=freezelive01 TMUX_IDE_TMUX_BIN=$(command -v tmux)
unset TMUX TMUX_PANE TMUX_TMPDIR NODE_OPTIONS
T() { tmux -S $ROOT/t.sock -f /dev/null "$@"; }
mk() { T new-session -d -s $1 -c $ROOT -x 200 -y 50 "exec zsh -f -i"; for i in $(seq 2 $2); do T split-window -t $1: -c $ROOT "exec zsh -f -i"; T select-layout -t $1: tiled; done; T set-option -t $1 @tmux_ide_adopted 1; }
pass=0
for run in $(seq 1 $RUNS); do
  mkdir -p $ROOT/home $ROOT/state $ROOT/registry $ROOT/daemon $ROOT/settings; chmod 700 $ROOT/*
  mk p1 1; mk p3 3; mk p8 8; mk p12 12; sleep 1
  rm -f $ROOT/daemon/daemon.json
  ( cd $TREE; TMUX_IDE_SESSION_RUNTIME_TRACE_LOG=$ROOT/trace-$run.jsonl exec node bin/cli.js --headless > $ROOT/daemon-$run.log 2>&1 ) & D=$!
  for i in $(seq 1 60); do [ -f $ROOT/daemon/daemon.json ] && break; sleep 0.5; done
  TMUX_IDE_TEST_DAEMON_RECORD=$ROOT/daemon/daemon.json TMUX_IDE_TEST_TMUX_SOCKET=$ROOT/t.sock \
  TMUX_IDE_TEST_FREEZE_SESSION=$SESSION TMUX_IDE_TEST_FREEZE_SECS=$SECS \
    $BIN --ignored --exact tmux_snapshot::browser::native_transport::local::freeze_live_tests::typing_lands_after_a_daemon_freeze_with_output_flowing --nocapture > $ROOT/test-$run.log 2>&1 \
    && pass=$((pass+1))
  echo "run $run: $(grep -o 'shown=[a-z]* tmux_received=[a-z]*' $ROOT/test-$run.log) faults=$(grep -c 'fault sent to client' $ROOT/daemon-$run.log) nonconverged=$(grep -c 'flow-nonconverged' $ROOT/trace-$run.jsonl)"
  kill -CONT $D 2>/dev/null; kill $D; sleep 1; T kill-server 2>/dev/null; sleep 1; rm -f $ROOT/t.sock
done
echo "passed $pass/$RUNS; logs in $ROOT"
