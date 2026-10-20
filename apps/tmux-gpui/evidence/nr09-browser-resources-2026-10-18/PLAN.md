# NR09 browser-only resource profile — prepared, not executed

Basis: pstack-benchmark; separate profiling from comparative timing, successful
work and exact provenance mandatory. Reuses frozen busy run.mjs, same baseline /
candidate bundles and identical live helper, CLI, Node24, stock tmux3.8, geometry,
producer and semantic A/B/A/input/cleanup assertions. No build/product edits.

Only browser ChildProcess.pid is sampled. The daemon, live helpers, tmux, panes,
native GPUI and WindowServer are excluded; no aggregate application resource claim.
Existing processTree observes numeric parent relationships only for cleanup.
Resource sampling never queries other PIDs or command/env/content fields.

A single serialized sampler executes /bin/ps -p exactPID -o
pid=,ppid=,rss=,time=,lstart= under C locale/UTC. Child handle must remain live;
PID/PPID/start tuple must stay equal, with parent exactly the harness. Identity
mismatch or disappearing child invalidates the profile. 100ms delay after each
completed periodic sample avoids overlap, with <=1200 samples, <=120s duration,
1500ms per-command timeout and4096-byte output limit. Boundary and periodic samples
share one queue. Actual requested/start/end timestamps expose queue/sampling lag.

Explicit phase samples: browser started, warmed, before producer, before each
switch command, after each ready observation, producer DONE, fresh input verified.
Command write and ready publication callbacks retain independent event timestamps;
resource sample times bracket observations rather than pretending zero-latency
measurement. Start-up sampling begins after spawn; not full lifetime CPU.

macOS ps(1) defines RSS in1024-byte units and time as cumulative user+system CPU.
No -S, so exited children are not added. No %cpu: its decaying average is unsuitable.
Parse and retain raw CPU time and decimal precision; a displayed0.01s quantum is
not proof of0.01s accuracy. Deltas below twice endpoint display quantum are
inconclusive; never report smaller precise improvements. Counter decrease fails.
RSSmaximum means sampledmaximum, not actual peak or unique physical memory.

First proposal: one sequential baseline/candidate pilot pair, after reviewer
approval and root confirms frozen timing jobs terminal. Validate positive samples,
phase timestamps, CPU parser/quantization, identities and complete busy work before
any analysis. Both pilots stay excluded from future five-pair comparisons. No speedup,
resource saving or causal assumption follows from current latency results.
Later comparison, only if separately approved: five interleaved fresh process pairs,
per-run browser CPU deltas and sampled RSS spread; do not treat samples or three
correlated switches as independent runs. Keep load, hashes, all failures and cleanup.

From repository root (not executed yet):

```sh
NODE=.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node
"$NODE" --import tsx .tasks/native-reliability-mission/nr09-browser-resources/run.mjs busy .tasks/native-reliability-mission/nr09-browser-resources/pilot-baseline.json baseline
"$NODE" --import tsx .tasks/native-reliability-mission/nr09-browser-resources/run.mjs busy .tasks/native-reliability-mission/nr09-browser-resources/pilot-candidate.json candidate
```

Profiling overhead changes control-loop scheduling. Existing publication times
are retained as instrumented diagnostics only, never pooled with frozen timing.
