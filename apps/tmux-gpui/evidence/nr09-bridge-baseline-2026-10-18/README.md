# NR09 bundled bridge warm A/B/A baseline

Five interleaved quiet/busy pairs passed: ten fresh-process samples, each containing three correlated A/B/A switches. This measures **semantic command write to parsed matching bridge publication callback**, not native GPUI paint, display presentation or human input latency. No CPU/RSS measurement, speedup or native-parity claim.

The fixed bundled CLI/browser/live payload was built from `873ef58e24b449ec040f0f653b0c221a6623c5e0`; it is not implicitly the current checkout product. Receipts separately record `harnessCheckoutHead`, all payload/runtime/tmux/producer/harness/helper hashes and unchanged-hash checks. Node 24, stock tmux 3.8, private HOME/state/socket/daemon, 132×41 source window, identical warm-up and target markers. No production discovery or protected CLI rebuild. Each sample records ambient load and 10 CPU count without stopping unrelated work.

## Results

Numbers below are the median of five independent **run medians**. Brackets give the minimum–maximum run median. Each run's three switches are correlated; this is not 15 independent samples per scenario. Times are milliseconds.

| Parsed publication endpoint | Quiet | Finite busy |
| --- | --- | --- |
| First retained target snapshot |9.38 [9.19–12.62]|10.04 [9.70–13.01]|
| First fresh target snapshot |379.35 [365.11–397.33]|376.26 [375.70–377.13]|
| First fresh input-ready target |392.39 [378.29–409.84]|389.95 [388.39–392.63]|

Observed variation overlaps; no meaningful latency difference between these load scenarios is established. These are scenarios of one fixed payload, not before/after optimization builds.

All 30 measured switches had zero empty publications, correct exact target-marker lines and all three endpoints. Median per-switch traffic was approximately 8.08MB(decimal); median 12 retained snapshot publications and 14 total publications. These counts are envelopes, **not unique images or native renders**. Counters stop at the first matching input-ready callback. Native-like pane continuation is sent directly from its first valid catalog callback, so polling does not delay that command or define the latency endpoint.

Busy samples run the same finite 200-tick/50ms producer from NR04 after warm-up. Ticks progress during the timed round trip and remain below 200; the producer finishes before the separate fresh-input check. Every sample verifies source pane identity/process/geometry unchanged, fresh semantic input, unchanged artifacts, and exit of all observed fixture-owned processes before removing its private directory. No failures in the measured ten runs.

## Review and retained pilot

The separate `pilot/` pair validated measurement endpoints and correctness before the five-pair runset. Independent review required exact marker lines (not echoed commands), separation of payload provenance from checkoutHEAD, per-sample load observations, and freezing counters at ready. Those changes preceded the passing pilot. The measured harness additionally includes its own and fixture-helper hashes; pilot results remain separate and are excluded from summary arithmetic. Source stayed frozen throughout all ten measured runs.

`summary.json` contains raw run medians, ranges and load observations. `summarize.py` reproduces arithmetic and asserts successful outcomes and matching hashes. `sha256.json` inventories the initial retained evidence files. No physical GUI evidence is implied; the Mac was locked.

## Reproduction

The retained harness has relative imports designed for its original path. From the repository root, copy `run.mjs` and `run-pairs.py` into a fresh `.tasks/native-reliability-mission/nr09-bridge-baseline/` directory. Do not run over existing sample filenames; the harness refuses an existing output. Supply the same local artifacts at the recorded paths and verify receipt hashes first:

- `.tasks/native-reliability-mission/nr01-current-payload/cli.mjs`, `receipt.json`, and `bridge/` bundle files.
- `.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node`.
- `.tasks/tmux38-compat/tmux-3.8/tmux`.
- `.tasks/native-reliability-mission/nr04-busy/producer.sh`.

The large private payload/runtime artifacts are not duplicated in this evidence directory. Missing or different artifacts require a separately labelled run; do not claim reproduction against another build.

```sh
python3 .tasks/native-reliability-mission/nr09-bridge-baseline/run-pairs.py
python3 apps/tmux-gpui/evidence/nr09-bridge-baseline-2026-10-18/summarize.py apps/tmux-gpui/evidence/nr09-bridge-baseline-2026-10-18
```

The runner alternates Q/B, B/Q, Q/B, B/Q, Q/B sequentially, invoking the pinned Node with `--import tsx`. The summary command can run independently against retained receipts and does not launch anything.

## Next step

Profile separately to distinguish serialization, transport, parsing and meaningful versus repeated envelope changes. Repeated large retained snapshot publications are an observation, not a demonstrated causal bottleneck. Native request-to-coherent-paint and actual display acceptance remain open, as do CPU/memory qualification and before/after improvement evidence. NR09 remains open.
