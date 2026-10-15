# Foreground resize qualification evidence

Hosted combined-head job 116372688582, run 38720230490, failed at `browser-smoke.mjs:334` on `85162e707e81c12a1e6c27477afb62d0d7f304ff`: `Error: Browser deadline`. This waits for 95×30 after returning from background presence. The preceding input-readiness and natural-grid restoration assertions passed. The failed CI log contained no status/geometry trace, so the mechanism is not established.

The diagnostic-only patch records up to 128 structural entries around this boundary, reports dropped entries, and stops after target success. It retains requests, presence revisions, readiness, allowlisted status categories and grid dimensions. It records no terminal content, credentials or host/session names. Workload, deadlines and predicates remain unchanged. This does not inspect internal geometry authority receipts and may still require deeper tracing if the failure recurs.

## Local evidence

- First run: Node 26.10.0, macOS arm64. Target resize succeeded, but the full smoke failed its healthy-stderr assertion due to the tsx module.register deprecation warning. This is not a passing qualification.
- Environment-corrected single run: Node 24.11.1, macOS arm64, `TMUX_GPUI_TEST_DISCOVERY=1 node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs`, with TEST_BINARY/TEST_BUNDLE/TEST_FOCUS_ONLY unset. Full smoke passed; target resize observed at 151 ms, command sent at 115 ms, zero trace entries dropped.
- CI uses Linux and Node 24.21.0. Local Node 24 is the same major, not the same patch/platform. CI failure remains unreproduced. No performance conclusion follows from trace timings.
- Private scratch fleet owns HOME, sockets, sessions and daemon cleanup. Production state was not selected.

`node24-pass.json` and `node26-resize-pass.json` retain structural traces. Full local logs remain in `.tasks/native-polish-np01-resume/`. The earlier zero presence revisions match the failing harness and are not changed here; their relation to the failure is unproven.
