# NR09 owned browser CPU profile

One separate instrumented quiet A/B/A run; this is not a latency comparison or native rendering measurement. The fixed bundled payload comes from source 873ef58e24b449ec040f0f653b0c221a6623c5e0, not the harness checkout HEAD. Exact payload, runtime, helper, producer, original baseline harness and profile harness hashes are in quiet.json. No product source was edited.

## Reproduce

From the worktree root, with retained local runtime/payload dependencies present:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr09-browser-cpu-profile/run.mjs quiet "$PWD/.tasks/native-reliability-mission/nr09-browser-cpu-profile/quiet.json"
python3 .tasks/native-reliability-mission/nr09-browser-cpu-profile/analyze.py
```

The harness refuses existing output; use a new filename for another run. Only the owned browser child receives --cpu-prof, --cpu-prof-interval=1000 and a private profile directory. No NODE_OPTIONS or system/process-wide instrumentation. Existing fixture deadline and cleanup remain; the retained raw profile must be <=16MiB. No production sessions or daemon are accessed. Raw V8 profile includes code/function URLs with local paths, not heap captures or terminal text.

## Result and limits

The run passed three exact-target switches, inert retained-publication checks, fresh semantic input, original source identity/PID survival, exact owned-process cleanup and unchanged protected CLI/payload hashes. Browser exited normally (code 0), producing a 593454-byte profile with 2283 samples. Runtime session 46749 exited 0. quiet.log and quiet.json retain the receipt.

Profile duration and summed sample deltas both equal 3330000 microseconds; all deltas are nonnegative and cumulative sample timestamps remain inside the profile interval. However, V8 startTime/endTime and harness hrtime microseconds have different origins: clockValidated=false. Consequently there is **no switch-window filtering or switch-specific CPU conclusion**. No offset is guessed to align clocks. All analysis covers browser startup, warmup, measured switches, fresh-input check and shutdown together.

Exclusive sampled weight aggregated by function/source location: idle 2442419us (73.35%), publish at bundled line38373 235626us (7.08%), GC43916us (1.32%), live-child stdout framing/JSON decode/validation callback at line38782 41957us (1.26%). These are V8 sample weights, not OS CPU utilization. Inlined serialization cannot be isolated from publish from this profile alone. Idle attribution does not prove which external operation caused waiting. The helper, daemon, native renderer and display were not profiled; browser sampling cannot attribute history observation in the live helper.

The useful next investigation is narrower instrumentation or sampling around the browser publication assembly/serialization owner, with reliable same-clock stage marks, separately from the frozen uninstrumented baseline. This run supports investigating that owner; it does not establish a bottleneck, speedup, regression, native parity, or predicted optimization benefit. No product change follows from these percentages alone.

analyze.py reproduces analysis.json from the raw profile and receipt. Its exclusive node totals are also aggregated by function/URL/line because the same function appears in multiple call stacks. Sample weights are timeDelta assigned to the corresponding sampled node; no interpolation beyond that is performed.
