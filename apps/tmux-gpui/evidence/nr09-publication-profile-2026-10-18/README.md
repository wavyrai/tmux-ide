# Private publication receiver profile

Completed after the five quiet/busy pairs finished and independent approval; see Result below.

`run.mjs` copies the baseline runner without editing it. It accepts quiet only and executes the same warmed A/B/A sequence against the pinned nr01-current-payload. CLI/browser/live hashes must match its receipt and all original before/after artifact, marker, authority, identity, geometry, fresh-input and observed-process cleanup assertions remain.

Each measured switch records at most 256 envelopes through first input-ready. The profile contains byte counts, snapshot SHA-256, changed top-level key names, request/readiness and classifications. It stores no terminal cells, labels or status values. Sequence is excluded from comparison; other changing fields remain meaningful. Snapshot digest equality is distinct from complete-envelope equality. A frame can change both snapshot and authority; `authorityChanged` preserves that fact even when classified as snapshot-change. The first envelope is initial, not a duplicate. Counts describe received publications, not native frames or writes attempted upstream.

Repeated snapshot hashing intentionally adds receiver work. All times are profiled observations, NOT benchmark results or comparable latency measurements. This identifies content repetition only, not the producing callback or causal bottleneck. No product instrumentation, source changes or builds.

After readiness/review, from the worktree root:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr09-publication-profile/run.mjs quiet "$PWD/.tasks/native-reliability-mission/nr09-publication-profile/quiet-profile.json" > .tasks/native-reliability-mission/nr09-publication-profile/quiet-profile.log 2>&1
```

Output must not exist; failures are preserved rather than overwritten. Static syntax check passed before review. Baseline imports resolve from this original ignored path; a retained copy elsewhere is not directly runnable.

Review caveat: authority classification uses a selected field list, not an exhaustive semantic capability model. For example sessionTabs and sessionHistory contain actionable metadata. A metadata-change classification does not imply that envelope can be dropped safely.


## Result

One run completed, owned session45282 exit0. Correctness assertions, fixed artifact hashes and cleanup of14 observed owned PIDs passed. No active jobs remain. quiet-profile.json retains bounded per-envelope metadata; summary.json omits profiled timings.

A/B/A yielded15/20/15 received envelopes (13/18/13 retained-preview envelopes), carrying8,661,855 /11,549,282 /8,661,876 bytes. Each switch had exactly ONE distinct snapshot digest, including its fresh snapshot. Snapshot JSON alone accounted for8,550,090 /11,400,120 /8,550,090 bytes. The snapshot-change category denotes the retained→fresh envelope-kind transition here, not changed cell content.

Only one envelope across all three switches was identical except sequence. Most other repetitions carried changed metadata: workspaceAgents alone changed5/6/5 times; fleet/createSession, workspaceFleetAgents, tabs, catalog completion and input admission also changed. Therefore repeated snapshot payload is established; wholesale duplicate-envelope dropping would preserve little of these bytes. This does not establish why agent metadata changes, whether those changes can be coalesced, or that serialization causes measured latency. Follow-up attribution must remain separate from the untouched baseline timing data.

Retained evidence: `python3 summarize.py` checks and prints the saved summary from this directory without starting any fixtures. Independent final review approved these receipts and recomputed totals. `run.mjs` remains a byte-identical archival copy: run only from its original ignored path documented above, with the original pinned payload prerequisites.
