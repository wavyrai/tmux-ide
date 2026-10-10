# GPUI source checkpoint — 2026-10-10

The checkpoint includes vendored source/attribution, native adapters, bridge,
packaging scripts, fixture, CI lane and required shared palette/resize/roster
dependencies. Generated target/dist trees, machine configuration, arbitrary
historical evidence, and regenerated bin/cli.js are excluded. Original upstream
hashes are preserved: 1,328 unchanged originals, 4 modified originals, 69 additions,
none missing. The derivative hashes are in upstream-provenance.json. Independent
source/import/npm boundary and credential scans found no release-sensitive data;
pattern hits were unchanged upstream unit-test literals and an example placeholder.

A fresh export of the staged Git tree (clean-source.json) installed with frozen
pnpm lockfile and offline cache, then passed bridge typechecking and 228 tests.
Four exact-packaged-app tests are explicitly skipped without TMUX_GPUI_TEST_APP;
this is not package qualification. Shared palette (2), resize (13), roster (6) tests pass.
The first clean tree also passed the real no-flag source bridge journey using
the maintained tmux bundle: input reached the selected pane on the same viewer,
resize moved before release, final boundary 49, identities stable, cleanup true.
The final tree differs only in a test harness correction.

The first bridge run failed one 5s startup timeout; the reason for the delayed
publication was not established. The direct supported browser-entry test now
has sanitized early-exit diagnostics, isolated environment, bounded output and
cleanup, and an explicit 15s startup budget (EOF remains 5s). The original failure
is retained; the final clean export passes with an additional early-exit test.

The npm dry-run disables lifecycle scripts: 980 files, zero GPUI paths; all three
new shared sources are included. It is not the full terminal release gate.

Two whole-import diff whitespace warnings (augment.svg and protocol NOTICE.md
EOF) are byte-identical original upstream content and intentionally preserved.
Diff checking outside the vendor import passes. Physical GUI/IME qualification,
clean native packaging, signed install/update, other native platforms and public
release remain separate. This source checkpoint does not claim full Herdr parity.

Rust checks on the matching worktree source with the existing target cache passed:
formatting, file-size guard, Clippy for all features and no default features
(with warnings denied), default workspace tests (2,802 passed, 10 ignored),
and all-feature workspace tests (2,836 passed, 17 ignored). Exact commands,
exit codes and raw-log hashes are in rust-results.json. This is not a fresh
clean-checkout native build.

Independent final review approved browser-config.test.mjs at SHA-256
`eca910282d9501cb114e43bbae5151933eb99c1fdc0548d162f7b9e9828a77aa`,
including private environments and bounded cleanup for both tests.
