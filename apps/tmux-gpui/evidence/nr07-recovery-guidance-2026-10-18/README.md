# Recovery guidance presentation correction

Observed mechanism: nr07-daemon-recovery runtime trace publishes unavailable Home with typed localSetup available/running while raw status still says to check the daemon manually then Refresh. Native Home rendered this raw advice above its supported setup action and also rendered separate setup guidance lower down.

Owner: native Home presentation. Typed setup guidance now takes precedence while the bridge channel exists; raw state.status remains intact. Missing capability/disconnected state continues using sanitized raw status. Setup appears once above actions; redundant lower setup card/manual tmux-start hint is suppressed. A failed local command enqueue now uses the existing Failed setup phase so presentation retains a visible retry path without automatically submitting anything. Request/composition/presence/modal/duplicate admission is unchanged.

before.log is an invocation/toolchain cwd failure, not a product regression. before-actual.log is a test-fixture private-method compile failure; no production visibility was widened. before-regression.log is the genuine failing assertion: raw manual-daemon advice rather than the existing typed setup guidance. after.log is the final focused gate. Tests cover all published setup phase values, unchanged raw diagnostics, absent/disconnected fallback, full command queue and explicit retry. Existing strict parser and action fences are included by the local_setup filter.

No physical native GUI was exercised; the existing preview predates this source correction. No release/sign/push performed. Product files only home.rs and home/tests/local_setup.rs.

Final gates: local_setup filter5passed; Home filter56passed; cargo fmt --all -- --check passed; git diff --check clean. Independent source review approved. Home gate recompiled after concurrent evidence-only HEAD change (git-derived metadata), not due to another source modification. No active build remains.

Final gates: local_setup5passed, Home56passed, cargo format and product diff checks passed. Independent source review found no blockers. Native preview/build qualification from191928a5 predates this correction; no physical acceptance is implied.
