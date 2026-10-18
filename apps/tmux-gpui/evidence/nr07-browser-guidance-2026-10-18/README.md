# Agent refusal and explicit shell recovery

This private source-browser journey uses an explicit current daemon CLI outfile, stock tmux3.8, private HOME/state/socket and a restricted /usr/bin:/bin PATH. It confirms codex is absent from that PATH before the final run. It opens a real pane, submits new-agent twice, observes the exact safe readiness guidance, and proves native pane inventory unchanged. It then explicitly reselects the pane, opens a new shell with fresh capability, and verifies a unique output line in only the new pane.

The guidance states that reselecting is required to retry or open a shell, matching the existing action-failure latch. No authority or retry policy changes.

The original refusal-only pass is retained. The final receipt and source hash comparison qualify the frozen source-browser path only; no native GUI, signed bundle, second Mac or full installation journey claim. Cleanup uses existing owned fixture child/socket disposal, not an independent full PID inventory. Private CLI was built with scripts/build-cli.mjs --outfile; protected bin/cli.js remained unchanged.

Reproduce retained run.mjs from the worktree root with Node24 --import tsx, explicit absolute TMUX_GPUI_TEST_CLI, TMUX_GPUI_TEST_AGENT=codex and stock3.8 on PATH. The harness preserves absolute source imports from the original local checkout. CLI binary is not committed; build log/hash identify the exact tested artifact.
