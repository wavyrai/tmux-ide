# Canonical split bridge preparation — 10 October 2026

The layout reader aborts obsolete requests and never republishes a result from
an old link, geometry or pane lifetime. Content/label-only updates do not refetch.
Unsupported reads leave targets unavailable without a retry loop. The submission
adapter validates detached targets and geometry authorization, then verifies
exact receipt identity while allowing clamped results and asynchronous resource
refresh. A historical receipt never renews geometry ownership.

11 Node tests pass. Full bridge TypeScript, affected ESLint and Prettier pass.
Independent review approved after correcting the stale-acquisition test to
actually grant geometry before changing the layout. Exact hashes are recorded.

The live.ts development file now retains v2 window links and reads/publishes
selected canonical split metadata. That entire preexisting untracked helper is
not included in this commit; its hash records the checked working-tree state.
The four new reader/submission source and test files are included. Reader
geometry matching is against canonical layout rectangles, not proof that the
retained rendered canvas is current. Native actionable targets must still be
fenced against the composed canvas before enabling the new gesture path.

Continuous dragging still needs daemon-authorized split correspondence after
geometry changes: current resources replace both layoutId and splitId. Do not
infer a successor by matching its boundary or pane sizes. GPUI Rust divider
wiring, native provenance promotion and packaged/physical validation remain.
No live demo changes, merge, release or performance claim.
