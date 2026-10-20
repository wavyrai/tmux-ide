# NR09 current-source retained serialization qualification

Baseline is exact6b7cff16 source; candidate is that source plus the reviewed three runtime-file serializer/cache/browser diff (tests separately). build.mjs overrides only baseline browser/cache from git, verifies every other local bundled input against6b7cff16, pins all dependency inputs, verifies candidate's only added graph input is browser-publication.ts, and requires byte-identical live helper. Build87886 passed. Esbuild version/build-script hash and exclusive source-freeze statement are in build-receipt.json. No checkout/generatedCLI mutation or release assembly.

Both variants reuse prior frozen private CLI d4252e328292012da246bc086833c3720b0e55365e50e5da86826a4f2c31b1f5. It is byte-identical to nr01 payload; git source delta873ef58e→6b7cff16 is empty for bin/packages/CLI build scripts. This is not a newly built current CLI. Both use same Node24.21, stocktmux3.8 and exact source fixture/harness dependencies.

## Correctness

Existing session-tab-continuity-smoke candidate qualification3878 passed expiry, Home cancellation, appearance invalidation, rapid navigation, target disappearance and same-name recreation rejection.122 snapshot fingerprints matched target content; survivor source births preserved. One target intentionally killed/recreated means sourceBirthsPreserved=false is expected, not all-source survival. The private app-shaped symlink fixture selects candidate bridge/Node only: raw receipt's packagedBrowser=true is NOT assembled-app qualification. No native GUI exercised. Fresh input and all-source survival are independently verified by each timed harness run.

Four focused serializer/cache tests and22 related tests plus TypeScript/lint/format passed earlier (nr09-retained-source evidence). Independent source review found no blockers. No live-frame cache, cadence change, capability reuse or guessed serialization sentinel.

## Pilots and adverse observation

Baseline pilot28005 and candidate56818 passed correctness. Candidate pilot readiness549–846ms was materially worse than baseline388–393ms. It is preserved unchanged, not called noise or explained away. Reviewer approved the already-planned five independent interleaved pairs to assess repeatability. No tuning/retry occurred. Those later measurements did not reproduce that slow range; its cause remains unknown and limits generalization.

## Five paired runs

Runtime99982 exited0; all10 fresh-process runs pass. Order B/C,C/B,B/C,C/B,B/C; three correlated A/B/A switches/run, five run medians/variant. Pilots excluded by design, separately retained. All30 switches have zeroempty publications, exact target/authority/fresh-input checks, original source identity/PID survival, owned-process cleanup and unchanged hashes. No competing owned Cargo/runtime jobs. Host load retained per run (one-minute values about2.3–2.8 on10 CPUs).

Median of5 run medians [min–max], milliseconds:

| Endpoint | Baseline | Candidate |
|---|---:|---:|
| First retained publication |8.939 [8.807–9.718]|5.739 [5.496–8.939]|
| First fresh publication |366.074 [358.037–373.947]|350.922 [341.733–369.249]|
| First input-ready publication |378.966 [371.571–387.282]|363.401 [356.348–373.930]|

Paired candidate-minus-baseline median differences: -3.311ms retained, -8.660ms fresh, -13.352ms ready. All5 paired candidate run-median ready times were lower; one retained-publication pair was slower, and ranges overlap; earlier adverse pilot remains unresolved. This supports a bounded quiet-workload observation, not broad release/native/busy speedup or causal attribution solely to parse removal. Do not hide the pilot in a generalized claim.

Median counts14 envelopes/12 retained snapshot publications in both; paired median bytes differ+67. These are metadata envelopes, not unique images/renders, and event timing can change counts/work. Endpoint is command write to parsed bridge publication callback, not native paint/display. No profiling during measurements. Full per-run medians, individual samples, paired deltas and spread are reproducible with summarize.py.

## Reproduce

From root with retained qualified local dependencies, exact git baseline and reviewed candidate source:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node .tasks/native-reliability-mission/nr09-current-source/build.mjs
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr09-current-source/run.mjs quiet "$PWD/.tasks/native-reliability-mission/nr09-current-source/new-pilot-baseline.json" baseline
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr09-current-source/run.mjs quiet "$PWD/.tasks/native-reliability-mission/nr09-current-source/new-pilot-candidate.json" candidate
python3 .tasks/native-reliability-mission/nr09-current-source/run-pairs.py
python3 .tasks/native-reliability-mission/nr09-current-source/summarize.py
```

Use the qualified Node path from receipts, unique paths under the required output namespace, and fresh output directories; existing outputs are refused. Candidate-source.patch preserves the exact source experiment. Current source performance evidence does not establish native GUI acceptance. No commit by measurement author.
