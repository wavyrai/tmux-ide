# NR09 private retained snapshot serialization experiment

No product edit. Baseline is fixed bundled source873ef58e24b449ec040f0f653b0c221a6623c5e0; candidate applies only bundle.patch to that same browser, with unchanged live bundle/CLI/Node24.21/stocktmux3.8. Node24 JSON.rawJSON rejects objects/arrays, documented by raw-json-probe.log, so that route was not used.

The private candidate returns the cache-owned immutable JSON string rather than JSON.parse, evaluates the existing complete envelope as fixed prefix/suffix objects, and inserts that JSON at retainedPreview.snapshot. Both metadata portions are stringified freshly. No generic key enumeration, string sentinel, publication suppression or mutable live-frame cache. No-preview still serializes the complete object but now constructs/spreads prefix/suffix; this overhead is part of the experiment. Existing MAX_FRAME, authority, expiry, route-proof, LRU/bounds, pending and drain behavior remain. This is a fixed nonempty envelope schema, not a general JSON serializer.

prepare.py reproduces candidate and provenance from retained original bytes. equivalence.test.mjs tests complete wire bytes (all fields, undefined/null, Unicode/control/escaping, metadata/authority changes), cache isolation/invalidation/LRU and byte bounds. All3 pass. First extracted-cache test failed because bundled Buffer2 alias was absent from test fixture; equivalence-fixture-failure.log retains it. Test extraction now supplies exact Buffer alias; not a product regression.

## Measurement

Reviewer approved pilot-baseline/candidate (both pass), then five new interleaved pairs. Pilots excluded. run-pairs.py pins harness hash, starts one fresh private fixture/process set per run, alternates B/C,C/B,B/C,C/B,B/C, aborts on failure. Runtime64378 completed exit0; all10 pass. Each run has3 correlated A/B/A switches; five independent run medians per variant, not15 independent trials. Host uptime/load/CPU count, exact artifacts and source provenance retained per receipt. Endpoint is command write to parsed publication callback, not native paint/display. No concurrent owned heavy jobs during measurement. All30 switches zeroempty, inert-preview authority, exact target markers, fresh input, original source identity/PID survival, observed process cleanup and protectedCLI/hash equality pass.

Median of5 run medians [minimum–maximum], milliseconds:

| Endpoint | Baseline | Candidate |
|---|---:|---:|
| First retained publication |11.765 [9.671–12.991]|6.419 [5.538–9.100]|
| First fresh publication |370.598 [360.075–374.318]|360.226 [348.458–365.337]|
| First input-ready publication |385.237 [372.754–388.114]|367.363 [362.178–369.211]|

Paired candidate-minus-baseline median differences: -3.863ms retained, -9.736ms fresh, -19.273ms ready. Median publication count14 and retained snapshot publications12 in both; per-run counts vary14–15/12–13 and bytes are not identical (paired median +81 bytes). These are metadata envelopes, not unique images or native renders. summary.json retains all per-run values and spread; summarize.py reproduces arithmetic.

This bounded experiment observed lower bridge endpoint times on this quiet workload. It does not establish native performance, busy-pane improvement, broad release speedup, or attribution solely to parse removal. All variants use a historical frozen payload, not current checkout product. Integrating a maintained serializer requires separate source review and current-source correctness qualification; this experiment does not authorize changes to live-frame caching or metadata publication cadence.

## Reproduction

From worktree root with retained local dependencies:

```sh
python3 .tasks/native-reliability-mission/nr09-retained-serialization/prepare.py
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --test .tasks/native-reliability-mission/nr09-retained-serialization/equivalence.test.mjs
python3 .tasks/native-reliability-mission/nr09-retained-serialization/run-pairs.py
python3 .tasks/native-reliability-mission/nr09-retained-serialization/summarize.py
```

Existing outputs are refused. Preserve prior receipts and use a new run output namespace for reruns. Raw candidate bundle need not be committed: preparation script, patch, exact original hash and resulting hash reproduce it. RawJSON probe is qualified local runtime behavior, not a web assumption.
