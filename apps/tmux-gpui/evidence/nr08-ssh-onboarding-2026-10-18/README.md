# NR08 owned SSH authentication repair — 2026-10-18

`auth-repair-distinct.json` passes on Node24.21.0 and private CLI SHA79d42e21896287a3055c99200bfec697adebda3466fd703fcafcb09c4427ef7d, using source browser and stock tmux3.8.

Proven: actual browser Add machine command persists through local daemon registry owner; real private OpenSSH rejects the fixture key and publishes needs-attention/ssh-authentication with no snapshot/input authority; only owned authorized_keys repaired; explicit fresh Retry reaches same saved machine, ready/no-failure diagnostic, real remote session and exact selected pane; unique shell marker executed. Owned browser, two daemon children, sshd/tunnels/credentials and scratch tmux servers cleaned up. stderr empty.

Limits: no native GUI, no remote installed CLI discovery/preflight qualification. SSH discovery descriptor is synthetic but describes the actual private remote daemon reached through the real tunnel. No production SSH, personal credentials or production sessions used. That initial run does not prove denied-input replay, sleep/wake, host-key repair, remote installation, second-Mac or Spark acceptance.

Failures retained: `auth-repair-first.*` and `auth-repair-diagnostic.*` passed Add+denial but timed out after Retry, cleanup passed. The original topology used the same daemon for local registry owner and remote SSH. Final diagnostic showed the saved route group disappeared; machine-catalog.ts groups same environment routes under primaryRouteId. The distinct-owner fixture removes that route-coalescing ambiguity without changing product code or weakening identity checks. This is a fixture correction, not a product fix.

Harness: apps/tmux-gpui/bridge/ssh-onboarding-smoke.mjs. Required env: explicit absolute TMUX_GPUI_TEST_CLI and TMUX_GPUI_TEST_OUTPUT prefix; run with Node24 and stock3.8 PATH. It never builds tracked bin/cli.js. Private failures retain metadata receipts; cleanup refusal retains private roots for exact recovery.

## Actual source CLI discovery mode

`auth-repair-public-cli.json` passes the same full Add → denied authentication → owned credential repair → explicit Retry → selected-pane input journey, with `TMUX_GPUI_TEST_PUBLIC_DISCOVERY=1`. The existing owned fixture invokes the explicit private source CLI's actual `remote-daemon-info --json` over SSH. Synthetic handshake request count is **zero**. stderr empty and all owned cleanup passed.

The fixture mirrors the actual private daemon record into its owned SSH `state/daemon.json`, after checking the spawned PID, live loopback identity and unchanged original record. Both directory and file are tracked by the fixture cleanup owner. This is deliberately a namespace mirror, not evidence that a remote installed package bootstrapped the daemon. CLI hash remains79d42e21896287a3055c99200bfec697adebda3466fd703fcafcb09c4427ef7d; source dependencies and synthetic namespace construction remain qualification limits. No shared fixture or product behavior changed.

## Installed 2.9.7 CLI input

`auth-repair-installed-cli.json` passes with genuine installed package `.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js`, SHA7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c. `TMUX_GPUI_TEST_INSTALLED_CLI=1` validates package name, version2.9.7 and canonical bin mapping before fixture allocation. Actual saved Add, typed denied authentication/no authority, owned key repair, Retry, same saved machine, selected-pane input and cleanup pass. Synthetic handshake requests remain zero; stderr empty.

This advances the CLI artifact from source bundle to installed package input. `installedPackageQualified:false` remains deliberate: the browser is source, the remote record namespace is mirrored, and no GUI or complete fresh remote installation/shell-PATH onboarding was tested. The harness reports `cliArtifact.kind:installed-package-input` separately from full product qualification.

## Denied-input negative

`auth-repair-installed-negative-promoted.json` passes with the same installed2.9.7 input, zero synthetic requests and cleanup. While SSH authentication is denied and the browser has no input authority, the harness sends unique text+Enter input targeting the real semantic pane identity. After repair/Retry, it asserts the recovered preferred pane is that same identity, fresh marker input executes, and the denied marker is absent from actual pane contents.

First attempt `auth-repair-installed-negative.json` intentionally failed closed because an unpromoted ordinary tmux pane had no semantic stamp yet; no target identity was guessed and cleanup passed. The corrected fixture uses the supported catalog open/inventory APIs against its independently verified private daemon to promote metadata before capturing `#{pane_id}` and `#{@tmux_ide_pane_id}` from the exact original tmux pane. This setup sends no terminal input and does not repair SSH credentials. Its metadata promotion is a fixture precondition, not evidence that remote discovery worked while authentication was denied. Existing successful and failed receipts remain unchanged.
