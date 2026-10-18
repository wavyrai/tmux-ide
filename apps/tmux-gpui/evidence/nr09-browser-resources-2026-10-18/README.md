# NR09 browser-only resource profile — inconclusive difference

Five fresh-process pairs were interleaved B/C, C/B, B/C, C/B, B/C using the frozen
reviewed serializer baseline/candidate and identical busy workload. All ten runs
passed exact targets, finite producer completion, fresh input, original source
identity, immutable artifact hashes and owned cleanup. No retry or failed run.
The earlier one-pair instrumentation pilot is retained separately and excluded
from these comparisons (`PILOT.md`, `pilot-*`).

The data do **not establish a CPU or RSS reduction**: ranges overlap and paired
changes include both directions. No product optimization, native resource or
whole-application claim follows from this measurement.

| Browser-only metric                           | Baseline median [min, max] | Candidate median [min, max] | Paired candidate−baseline median [min, max] |
| --------------------------------------------- | -------------------------- | --------------------------- | ------------------------------------------- |
| Busy-start to fresh-input CPU seconds         | 5.85 [5.72,6.07]           | 5.79 [5.68,5.97]            | −0.04 [−0.33,+0.19]                         |
| Whole observed lifecycle CPU seconds          | 6.58 [6.44,6.78]           | 6.52 [6.37,6.98]            | −0.07 [−0.36,+0.48]                         |
| Whole observed lifecycle sampled RSS max, KiB | 438,736 [430,400,452,928]  | 434,384 [410,656,451,568]   | −4,288 [−19,744,+12,832]                    |
| Busy-window sampled RSS max, KiB              | 438,736 [430,400,452,928]  | 434,384 [410,656,451,568]   | −4,288 [−19,744,+12,832]                    |

RSS maxima happened inside the busy window in all ten runs; the definitions remain
separate. Per-run values and correlated switch CPU intervals are in `summary.json`.
Five processes per variant are the independent units, not 137–148 samples per run
or three switches. Paired median changes differ from differences between medians.

## Measurement boundary

Only `browserChild.pid` is sampled. Each `/bin/ps` call asks that exact PID for
PID/PPID/start time, RSS and accumulated CPU `time`; no arguments, environment or
process content is read. The live child handle plus exact PID/parent/start tuple
must stay consistent. No `-S`, so CPU excludes exited children. Daemon, live helper,
tmux, pane processes, native GPUI and WindowServer are excluded. This is not an
application resource total or unique physical memory.

The sampler serializes periodic and explicit boundary requests, waits 100 ms after
a completed periodic call, and caps time/count/output. Samples include requested,
start and end timestamps. CPU is read at actual phase boundaries; callbacks are
not interpolated. In all ten runs, command and ready events fall between their
corresponding samples. Actual CPU display quantum was 0.01 s; displayed precision
is not accuracy, and deltas below twice endpoint quantum are inconclusive.

RSS maxima are **sampled maxima**, not actual peaks. Sampling gaps reached 116.76 ms;
`ps` calls reached 37.00 ms. Profiling changes scheduling and adds work. Publication
latency values remain instrumented diagnostics and must not be pooled with the
separate frozen timing baseline. Sampling begins just after browser spawn, before
stdout handlers attach; the observed lifecycle excludes any earlier work and may
include buffering overhead. Whole-observed CPU ends at the last sample before
cleanup, while busy CPU uses explicit before-producer/fresh-input boundaries.

Node 24.21.0, stock tmux 3.8, 132×41 geometry, the unchanged 200-tick/50 ms producer,
source CLI and both bridge bundle hashes are pinned in each receipt. Source
provenance remains the frozen reviewed serializer comparison, not a latest signed
app. No builds occurred. Machine load was recorded without stopping unrelated
work; one-minute load ranged 1.68–2.49. No other agent-owned heavy jobs ran.

## Retention and reproduction

`PLAN.md` is the pre-run plan; `runset.json` pins unchanged harness+sampler bytes.
`validate-pilot.py` verifies pilot instrumentation; `summarize.py` recomputes all
final arithmetic and checks successful work, identical artifacts, stable browser
identity, monotonic CPU, nonoverlapping sample calls and event containment.
Independent review validates the retained results before commit.

The frozen runtime script's relative imports require its original location:
`.tasks/native-reliability-mission/nr09-browser-resources/`. Restore `run.mjs`,
`browser-resources.mjs` and `run-pairs.py` there to reproduce, preserving existing
receipts and choosing a fresh output set rather than overwriting this evidence.
Run from repository root with the qualified Node 24 and retained nr09-current-source
bundle/CLI prerequisites. `run-pairs.py` refuses existing pair outputs. No bundled
app, physical GUI, other Mac, memory-pressure scenario or resource soak is qualified.
