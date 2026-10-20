# Native-app pipeline measurement (research)

Opt-in harnesses that measure the tmux → daemon → live helper → browser helper →
preview-launcher → GUI path against a scratch tmux socket, temp HOME and an owned
daemon. Nothing here runs in CI or touches a user's daemon or sessions.

```bash
node apps/tmux-gpui/scripts/build-bridge.mjs /tmp/bridge          # bundles, as shipped
node --import tsx performance/pipeline/pipeline-bench.mjs /tmp/bridge out.json
/usr/bin/python3 performance/pipeline/summarize.py out.json
```

| File | Purpose |
| --- | --- |
| `pipeline-bench.mjs` | Drives the bridge like the native app; workloads idle, keystroke, seq, buildlog, top, scroll, switch, divider, kitty. Env: `PIPELINE_GRID`, `PIPELINE_WORKLOADS`, `PIPELINE_SSH=1` (user-level sshd + `ssh -L`), `PIPELINE_PROBE_CLI` (alternate daemon bundle), `PIPELINE_RECORD` (publication jsonl). |
| `probe.mjs` | Preloaded into every Node process: bytes, lines, large JSON cost, CPU, RSS, GC, latency marks, delivery frame mix; `PIPELINE_PROBE_PROFILE=1` writes a CPU profile per sampling window. |
| `fake-gui.mjs` | Stands where the native binary runs under preview-launcher. |
| `workloads.py`, `kitty-frames.mjs` | Pane programs: full-screen redraw, editor-like scroll, build log, kitty image stream. |
| `encoding-sim.mjs` | Prices whole-frame vs changed-row and JSON vs run-length binary encodings on recorded publications. |
| `decode-bench/` | Rust decode cost of one publication: 2.9.7 path, single typed decode, binary prototype. |
| `profile-top.mjs` | Self/inclusive summary of a `.cpuprofile`. |
