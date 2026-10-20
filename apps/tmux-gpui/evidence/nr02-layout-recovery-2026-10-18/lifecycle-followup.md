# Broader local qualification

Source: 4c45fa9f plus the discovery-recovery-smoke harness correction in this increment.

macOS arm64 / Node 24.21.0 / stock tmux 3.8: the local lifecycle gate passed private CLI build, browser resize/presence journey, discovery recovery, pane split, pane replacement and browser history. Receipt: .tasks/local-preflight/results/1792312644425-lifecycle/receipt.json.

The prior gate failure was a stale assertion: controlled daemon closure emits one transport-closed diagnostic and an expected TMUX_GPUI_RECOVERY transport-closed line. The test required exactly one stderr line. Traces proved newer publication sequence, null snapshot, disabled input and exact shutdown status were already correct. The corrected allowlist admits at most one exact recovery line, still requires exactly one shutdown diagnostic and all state assertions, and ignores incomplete stream lines during polling. Final validation rejects extra or unknown lines. Independent review and changed-file ESLint/Prettier passed. Failed receipts1792312393866 and1792312575330 are retained.

## Linux remains unqualified

A local Docker ARM64 image was prepared from tracked source4c45fa9f, using existing dependency layers with identical lockfile SHA256, and freshly built stock tmux3.8. No host volumes, credentials or production sockets were mounted. Network was disabled during the test; limits were2CPUs,768MiB,256processes and120seconds.

The first run exposed an inherited development namespace environment setting from the base image; that setup failure is retained. With that variable removed, the browser reached its second selected session and input-ready snapshot but stalled after input. A tmux interaction wait-for process remained during cleanup. The outer timeout exited124 and the disposable container was removed. This is observed failure evidence, not a proven cause or a passing Linux result. Next investigation must distinguish runtime input/lease ownership from runner resource pressure.

Local Linux build recipe, image identity, logs and process snapshot: .tasks/nr02-linux/. No physical GUI, SSH, second-Mac or release claim follows from this gate.
