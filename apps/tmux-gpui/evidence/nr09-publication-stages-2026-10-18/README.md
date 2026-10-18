# NR09 separate publication-stage attribution

One reviewed, private instrumented quiet A/B/A run; no product edits or optimization. The original fixed payload source is873ef58e24b449ec040f0f653b0c221a6623c5e0. prepare.py copies browser/live bundles and applies the exact retained bundle.patch. provenance.json and quiet.json pin original/instrumented bytes, harness, dependencies and protected CLI. The original payload remains unchanged.

Run from worktree root after original fixed payload/runtime dependencies exist:

```sh
python3 .tasks/native-reliability-mission/nr09-publication-stages/prepare.py
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr09-publication-stages/run.mjs quiet "$PWD/.tasks/native-reliability-mission/nr09-publication-stages/quiet.json"
python3 .tasks/native-reliability-mission/nr09-publication-stages/analyze.py
```

Existing output is refused; use a new filename for additional runs. prepare.py does not build source. Browser instrumentation records at most2048 numeric records and reports overflow; no text/paths/IDs in stage records. Private exit artifact is mode0600/exclusive create. The helper and daemon are unchanged. Fixture timeout/owned cleanup remain. Runtime55330 exited0, all three switches, inert-preview authority, fresh input, source identity/PID survival and cleanup checks passed; artifact hashes unchanged.

## Observed stage attribution

Across the whole lifecycle including setup/warmup,215 publication attempts assembled81904606bytes;88 attempts queued instead of directly writing. These are attempted envelopes, not received publications or rendered frames: pending envelopes can be overwritten by later state under existing backpressure logic.36 deferred drain writes were separately recorded and cannot be attributed to request IDs.

Synchronous elapsed stage totals: prelude176803us, envelope construction20450us, JSON.stringify plus newline258525us, byteLength/size check48781us, direct write-or-queue24131us. Deferred drain write calls total19770us. Stages exclude instrumentation record insertion/file flushing. These are wall-clock elapsed durations including possible scheduling/GC, not OS CPU, flush completion, causal switch latency or display time. Do not pool with uninstrumented baseline.

93 retained-preview attempts spent168276us in stringify (median1682us);48 live-snapshot attempts88797us (median1753.5us);74 empty attempts1452us (median18us). This is evidence that snapshot-bearing envelope serialization merits a narrowly scoped experiment. It does not establish a speedup or prove serialization dominates command-to-ready delay. byMeasuredRequest aggregates only the initial tab-activation request; automatic pane-continuation requests are distinct, so it is not a complete per-switch cost.

No rawJSON/cache optimization was made. Any later immutable snapshot serialization reuse must first prove ownership/alias immutability, preserve every metadata envelope and current capabilities, retain byte bounds/backpressure and qualify same-path correctness. JSON.rawJSON availability and semantics should be validated against qualified Node24 before use. Native rendering, live-helper history cost and daemon cost remain unmeasured.

analyze.py regenerates analysis.json from quiet.json and quiet.json.stages.json. The raw private instrumented bundle is reproducible from exact original hash and patch; it need not be treated as a distributable artifact.
