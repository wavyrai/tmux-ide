# NR07 authentic stopped owner and stale record recovery

Read-only source investigation followed by a private runtime harness; no product changes. `first.json` passes; `acknowledged.json` strengthens explicit Home/Refresh request acknowledgement and adds artifact hashes. Both preserved.

Derived from apps/tmux-gpui/bridge/local-setup-empty-smoke.mjs. Current source browser + genuine installed 2.9.7 CLI/dependencies copied verbatim into an external SSD private managed HOME. Qualified Node24 and stock tmux3.8 are explicit. No build, signing or production discovery. No physical native GUI acceptance.

The harness first performs explicit setup/create/open/input, verifies the real daemon identity through its identity endpoint, then SIGKILLs only that PID. Its authentic canonical record remains unchanged. Original fixture tmux server and pane processes survive. Home and Refresh return unavailable with setup available; after acknowledged Refresh and a bounded 750ms observation no owner starts and no input/creation authority exists. Explicit setup starts a new verified owner, the original session/window/pane and PIDs survive, and reopened live terminal accepts a fresh marker. This is an observation window, not proof against all arbitrarily delayed startup.

Cleanup checks both old/replacement daemon PIDs, source tmux/shell PIDs and browser process exit, exact private named server absence, and protected checkout CLI equality. All passed. Credentials/terminal text are not written to receipts; identity IDs/PIDs and bounded UI status traces are retained.

## Command
Run from the gpui-main-release worktree (absolute inputs supplied through $PWD):

```sh
env PATH="$PWD/.tasks/tmux38-compat/tmux-3.8:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
 TMUX_GPUI_TEST_CREATE=1 \
 TMUX_GPUI_TEST_PACKAGE="$PWD/.tasks/native-reliability-mission/installer-lifecycle/private-w5f4o2hz/installed/lib/node_modules/tmux-ide" \
 TMUX_GPUI_TEST_OUTPUT="$PWD/.tasks/native-reliability-mission/nr07-recovery/acknowledged" \
 .tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node \
 .tasks/native-reliability-mission/nr07-recovery/run.mjs
```

Fixture package/HOME lives at /Volumes/Samsung_T5/tmi-recovery-* and is removed after verified cleanup. Unique named tmux socket remains short under /private/tmp. Do not run concurrently with another owner of these evidence paths. Existing retained package and tool artifacts are prerequisites; this script does not rebuild them. Internal source imports are absolute to this worktree; prepare.py records initial derivation, while final run.mjs additionally includes explicit request acknowledgements and provenance hashes.

No failure reproduced. This qualifies current-source bridge recovery with the recorded installed CLI; it does not qualify a signed native app, public installer transaction, second Mac or SSH recovery.
