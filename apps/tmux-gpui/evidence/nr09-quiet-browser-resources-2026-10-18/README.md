# NR09 quiet browser resources — adverse sampled RSS signal

Five unchanged, interleaved baseline/candidate pairs passed all target, source,
input, artifact-hash and cleanup checks. No failed runs or retries. The earlier
instrumentation pilot is retained separately and excluded from these results.
This is the **frozen reviewed serializer comparison**, not the latest complete
native app. Later source guidance changes are not exercised by this local lane.

**The candidate's whole observed lifecycle sampled RSS maximum is higher in all
five paired runs**, by 16,240–25,520 KiB (paired median +21,456 KiB). This adverse
signal must not be described as a memory improvement. It is a bounded observation
of one browser process with profiling overhead, not causal proof about cache
allocation, unique physical memory or whole-app memory. CPU changes remain
inconclusive; quiet-window RSS is higher in four pairs and lower in one.

| Browser-only metric                           | Baseline median [min,max] | Candidate median [min,max] | Paired candidate−baseline median [min,max] |
| --------------------------------------------- | ------------------------- | -------------------------- | ------------------------------------------ |
| Quiet-window CPU seconds                      | 0.66 [0.64,0.70]          | 0.71 [0.54,0.75]           | +0.03 [−0.12,+0.11]                        |
| Whole observed lifecycle CPU seconds          | 1.41 [1.37,1.44]          | 1.41 [1.21,1.51]           | −0.01 [−0.16,+0.09]                        |
| Whole observed lifecycle sampled RSS max, KiB | 403,712 [378,640,407,328] | 423,056 [402,208,432,848]  | +21,456 [+16,240,+25,520]                  |
| Quiet-window sampled RSS max, KiB             | 403,712 [378,640,407,328] | 423,056 [362,576,432,848]  | +16,464 [−16,064,+25,520]                  |

Ranges overlap. Paired medians are distinct from differences of medians. One
candidate's whole-lifecycle maximum occurred outside the quiet window, so the
whole/window metrics must remain separate. Independent units are five fresh
processes per variant; three switches and periodic samples are correlated.

## Workload and boundaries

After identical A/B warm-up at 132×41, take a start resource sample and then start
a monotonic 10-second clock. Perform the same A/B/A navigation inside that window,
wait until its deadline, mark the actual end and take an end resource sample.
No producer is copied or executed. Full source captures before and after remain
identical, observed only at those endpoints; this is not continuous repaint
monitoring. Fixed markers/prompt are the known fixture output. Fresh input is
verified after the end resource sample. This is quiet terminal output with
navigation, not a completely idle application.

Actual quiet clocks ranged 10,000.12–10,002.69 ms. The resource interval lower
bounds ranged 10,000.73–10,004.75 ms and upper bounds 10,007.31–10,017.24 ms.
Runs retained 123–126 samples; the largest ps call took 11.82 ms and the largest
intersample gap was 105.77 ms. Each receipt records these sampling limits. CPU deltas use
explicit boundary samples, with no interpolation to an exact 10 seconds. The
sampler is byte-identical to the independently reviewed busy lane; no quiet/busy
resource comparison is claimed. Artifact hashes, runtime/CLI provenance, machine
load, all observations and owned process cleanup are retained.

Only the owned browser ChildProcess PID is sampled. Its PID/parent/start tuple
and live handle stay consistent. The daemon, live helpers, tmux, pane processes,
native GPUI and WindowServer are excluded. `ps time` is cumulative user+system,
without `-S` or child CPU. Display precision is 0.01 seconds, not an accuracy promise;
deltas below twice endpoint quantum are inconclusive. RSS maxima are sampled
resident-set maxima, not actual peaks or unique memory. Profiling overhead and
startup buffering are included in this instrumented lifecycle; early pre-sample
work is not measured. Publication timings are diagnostic only and cannot be
pooled with uninstrumented latency benchmarks.

## Evidence and reproduction

`summary.json` contains all five paired values and spread. `summarize.py`
recomputes arithmetic and asserts shared immutable artifacts, successful work,
consistent process identity, monotonic CPU, nonoverlapping samples, event boundary
containment, quiet clock duration and unchanged endpoint captures. `PILOT.md` and
`pilot-*` document instrumentation validation, not comparative evidence.
`PLAN.md` preserves the pre-run plan. Run order was B/C,C/B,B/C,C/B,B/C.

The unchanged runtime imports expect the original ignored location:
`.tasks/native-reliability-mission/nr09-browser-resources-quiet/`. Restore run.mjs,
browser-resources.mjs and run-pairs.py there, preserve existing outputs, and use a
fresh output set. Frozen nr09-current-source bundles, qualified Node 24.21.0,
stock tmux 3.8 and the recorded CLI are prerequisites; no build was performed.
Run from repository root. `run-pairs.py` rejects existing outputs and stops on
failure. No physical native GUI, other Mac, memory-pressure or resource-soak
acceptance is established. No further resource experiment is included here.
