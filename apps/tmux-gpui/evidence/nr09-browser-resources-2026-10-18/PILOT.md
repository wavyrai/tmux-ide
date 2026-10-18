# NR09 browser-only resource pilot — historical checkpoint

This note predates the five-pair runset. See README.md for the final comparison.

One sequential baseline/candidate pair, separately instrumented from the frozen
busy latency measurements. Both pass identical target markers, finite busy
producer completion, three warm A/B/A switches, fresh input, source identity,
artifact hash and owned cleanup checks. No product change or build. This validates
the instrumentation; it does not establish a CPU or memory improvement.

Qualified Node 24.21.0, stock tmux 3.8, frozen reviewed baseline/candidate payloads
and original CLI provenance are recorded in each receipt. The sampler observes
only the browser ChildProcess PID. No daemon, live helper, tmux, pane, native app
or WindowServer resource usage is included.

| Pilot     | Samples | Browser CPU between before-producer/fresh-input samples | Whole observed lifecycle maximum RSS |
| --------- | ------: | ------------------------------------------------------: | -------------------: |
| Baseline  |     139 |                                                  5.88 s |          424,464 KiB |
| Candidate |     137 |                                                  5.81 s |          430,768 KiB |

These are single instrumented runs with different scheduling histories. Do not
infer a comparative benefit or regression. RSS is sampled resident set size, not
unique/physical total or lifetime peak. CPU is accumulated user+system for this
process, without exited-child CPU (`ps` omits `-S`). Both displayed CPU counters
have a 0.01 s quantum; that precision is not an accuracy guarantee. Endpoint deltas
below twice that quantum are inconclusive. The 0.12/0.15/0.12 s and 0.09/0.10/0.09 s
per-switch boundary deltas are correlated phases, not independent samples.

The maximum measured `ps` call durations were 8.45 ms and 14.38 ms. Maximum intersample
gaps were 107.27 ms and 115.15 ms. Profiling incurs subprocess/scheduling overhead;
publication latency fields are instrumented diagnostics only, never pooled with
frozen timing results. Samples bracket command/ready callbacks, rather than
interpolating CPU counters at event timestamps. Startup sampling begins after
spawn and before attaching stdout handlers, so early CPU/buffering effects are
not claimed as complete launch measurement.

`validate-pilot.py` reproduces the summary and asserts identical browser identity
within each run, monotonic CPU, no sample overlap, and boundary containment for
all three command/ready intervals. `PLAN.md` preserves the pre-run protocol.
The sampler/harness and frozen dependencies are hashed inside receipts. Both
variants passed; there were no failed pilot attempts or retries. At this pilot checkpoint, no five-pair
resource comparison had been run or authorized.
