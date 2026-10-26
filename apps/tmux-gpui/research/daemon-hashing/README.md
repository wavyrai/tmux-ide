# Sparse grid hash follow-up

The [Sfora efficiency report](https://www.sfora.ai/org/wavyr/posts/nh72adj59aw972k2gdtvma9wr18gmkaz)
identified repeated full-row hashing. Row hashes were already cached, but a grid
patch still discarded the array digest and folded every row's hash again.

For a cached, immutable grid of unchanged dimensions, sparse patches now subtract
the old changed-row contributions and add their replacements to the same 64-bit
polynomial. The wire digest is unchanged. Cold or mutable input and geometry
changes retain the full-fold path. Dense patches (more than one quarter of rows)
also use the full fold: the first experiment found that per-row exponentiation
made dense updates slower, so that candidate was rejected.

## Measurement scope

Recorded on the local Apple Silicon host with Node 24.22.0, comparing the source
at baseline `b4857bb374b344d77517ef21afca23ee39bc973c` against the patched source. Five interleaved samples alternate
which variant runs first. Each sample runs 500 patch-plus-snapshot-hash operations
after 128 warmups. Inputs are 250 columns wide, using 32 reusable immutable row
variants and a warm hash cache. Both variants must produce identical final hashes.
Raw accepted samples are in `2026-10-24-samples.json`.

| Grid / changed rows | Before median | After median |
| ------------------- | ------------: | -----------: |
| 70 / 1              |      79.51 ms |     56.55 ms |
| 1000 / 1            |     128.52 ms |     57.59 ms |
| 70 / 70             |    2774.46 ms |   2770.17 ms |

These are total times for 500 reducer/hash operations, not frame times. Reusing
immutable row variants favors a warm cache. This experiment excludes daemon IO,
tmux capture, SSH, native rendering, input-to-paint latency and resident memory.
It supports removing this particular sparse-grid fold; it does not establish a
user-visible speedup, memory reduction, or TUI parity. Dense samples are effectively
unchanged at this resolution.

Correctness tests compare incremental hashes with independent cold full folds,
including repeated sparse and dense updates, mutable external rows, geometry
changes, cursor-only updates, and a spy that detects hashing retained grid rows.

To reproduce from the repository root, extract the baseline beside its original
imports, then run the harness with Node 24 and the installed workspace dependencies:

```sh
git show b4857bb374b344d77517ef21afca23ee39bc973c:packages/core/src/terminal-replica.ts > packages/core/src/.terminal-replica-baseline.ts
node --import tsx apps/tmux-gpui/research/daemon-hashing/benchmark.mjs \
  packages/core/src/.terminal-replica-baseline.ts /tmp/grid-hash-samples.json
rm packages/core/src/.terminal-replica-baseline.ts
```

The temporary baseline file is not part of the change. Keep the raw five samples;
do not compare one warm sample with a cold run or extrapolate this workload to SSH.
