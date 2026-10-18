# NR08 owned SSH authentication repair — 2026-10-18

`auth-repair-distinct.json` passes on Node24.21.0 and private CLI SHA79d42e21896287a3055c99200bfec697adebda3466fd703fcafcb09c4427ef7d, using source browser and stock tmux3.8.

Proven: actual browser Add machine command persists through local daemon registry owner; real private OpenSSH rejects the fixture key and publishes needs-attention/ssh-authentication with no snapshot/input authority; only owned authorized_keys repaired; explicit fresh Retry reaches same saved machine, ready/no-failure diagnostic, real remote session and exact selected pane; unique shell marker executed. Owned browser, two daemon children, sshd/tunnels/credentials and scratch tmux servers cleaned up. stderr empty.

Limits: no native GUI, no remote installed CLI discovery/preflight qualification. SSH discovery descriptor is synthetic but describes the actual private remote daemon reached through the real tunnel. No production SSH, personal credentials or production sessions used. Does not prove denied-input replay, sleep/wake, host-key repair, remote installation, second-Mac or Spark acceptance.

Failures retained: `auth-repair-first.*` and `auth-repair-diagnostic.*` passed Add+denial but timed out after Retry, cleanup passed. The original topology used the same daemon for local registry owner and remote SSH. Final diagnostic showed the saved route group disappeared; machine-catalog.ts groups same environment routes under primaryRouteId. The distinct-owner fixture removes that route-coalescing ambiguity without changing product code or weakening identity checks. This is a fixture correction, not a product fix.

Harness: apps/tmux-gpui/bridge/ssh-onboarding-smoke.mjs. Required env: explicit absolute TMUX_GPUI_TEST_CLI and TMUX_GPUI_TEST_OUTPUT prefix; run with Node24 and stock3.8 PATH. It never builds tracked bin/cli.js. Private failures retain metadata receipts; cleanup refusal retains private roots for exact recovery.
