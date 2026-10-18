# Quiet browser-only resource lane — preparation, not execution

Use unchanged reviewed browser-resources.mjs (byte-identical to busy sampler),
frozen baseline/candidate bundles, identical CLI/Node24/stock tmux3.8 and132×41
source windows. Own new output namespace; no product change or build.

After A/B warm-up and geometry/identity proof, capture both quiet source panes in
memory and take quiet-window-start resource sample. Start a monotonic10,000ms
clock immediately after that sample, then perform the same three A/B/A switches.
All three must complete inside the clock window. Wait until the clock deadline
without commands/output, mark the actual end, and take quiet-window-end sample.
The timer may overshoot; record actual duration/overrun, reject>=1second overshoot.
Resource counters are deltas between explicit samples, not exact10s interpolation.
Command/ready event stamps remain separately bracketed by before/after samples.

No producer is started or copied. The only source text before the window is the
fixed setup markers/prompt. Both full source captures must be unchanged at window
end; retain only the boolean, not content. Fresh-input verification happens after
the end sample. This is quiet terminal output plus navigation, not idle app CPU.

The browser-only sampler retains the prior bounds, exact child identity checks,
100ms nonoverlap cadence and CPU display-quantization caveats. No daemon/helper/
tmux/native totals or quiet-versus-busy inference. Whole observed lifecycle RSS
and quiet-window RSS are distinct. Instrumented publication latencies are not
unprofiled benchmarks. Host load/correctness/hash/cleanup gates stay unchanged.

Proposed review then one baseline/candidate pilot pair to qualify changed workload
clock and quiet-source assertion. Five fresh-process interleaved pairs need pilot
review and parent authorization. Exclude pilots from comparative samples. No runs
yet. Root confirms no other measured/heavy jobs before execution.

Run from repository root using qualified Node24 with --import tsx, followed by
run.mjs quiet <fresh absolute-or-repo-relative output in this namespace> baseline
(or candidate). Preserve all failures; no retries for better performance.
