# Owned GUI/TUI visible-response qualification

## Current qualification status — 2026-10-23

This table supersedes older checkpoint statements below; the dated entries remain
as evidence and record of failed cases. The requested link feature is **GUI links
like the TUI**, per the user's explicit clarification.

| Requirement                                        | Current evidence                                                                                                                           | Remaining qualification                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct Rust terminal delivery and changed rows     | Live controller smoke passes normal delivery and projected alternate-screen commits; subsequent updates touch row 0 only                   | Matched end-user latency, not just protocol correctness                                                                                    |
| Local image transport                              | File leases avoid base64 and intermediate Node copies; HD GUI rendering/reuse/deletion exercised                                           | Do not call decoding or GPU upload zero-copy                                                                                               |
| Daemon ingest, hashing, seeds and idle publication | Coalescing/hash/projection paths implemented; live alternate-screen history deferral verified; redundant native catalog notices eliminated | Comparative performance on matched workloads                                                                                               |
| Memory retention                                   | HD live workload, deletion, idle observations and diagnostic GC isolate collectible buffer memory                                          | No evidence supports forcing GC or changing cache limits; no leak-freedom claim                                                            |
| Initial selection and typing                       | Foreground tab reopen works; viewport transition buffering and command-queue pressure fixes have regressions                               | Back to live now has a bounded handoff and regression coverage; repeat physical SSH activation and Back to live typing on the latest build |
| GUI clickable links                                | Earlier native browser-opening verification recorded                                                                                       | Preserve terminal selection/input behavior through final GUI pass                                                                          |
| Two-phase resize                                   | Native row/column resize, routing and image clipping exercised                                                                             | Continuous nested-divider gesture observation                                                                                              |
| GUI/TUI comparison                                 | GUI input, scroll and output receipts exist; pane-switch correctness fixture exists                                                        | Five interleaved pairs per workload/route; pane-switch renderer-completion instrumentation; user-operated TUI runs                         |
| Build configurations                               | Earlier checkpoints passed default/all-feature tests, strict Clippy and the optimized macOS build                                          | Post-crash final-source rerun in progress; separate Linux/Windows evidence                                                                 |

The crash removed temporary `/tmp` receipts and the staged app. Historical entries
below record earlier observations; they are not retained proof for the final source.
Integration checks now write logs outside temporary storage.

The physical TUI comparison is user-operated. Do not replace it with another
input-posting mechanism after Computer Use rejected Terminal automation. A locked
Mac blocks physical GUI verification, but does not convert an automated test into
that verification.

This opt-in harness observes the exact fixture marker text (Vision OCR) **and**
its unique color in screenshots of one owned application window. It never calls
helper JSON arrival, an input ACK, or a tmux capture a visible response. Screenshot
capture gives an observation interval, not a display-vsync timestamp: report the
lower/upper bound and uncertainty, not a fabricated sub-frame point estimate.

It creates its own HOME, tmux socket, daemon, three panes, GUI launcher and a new
Ghostty application instance. It only targets recorded child PIDs and their
windows. Personal Terminal/Ghostty/TmuxIDE windows and sessions are not used.
SSH mode creates its own localhost sshd, ephemeral keys, and SSH forwards; this
is SSH transport coverage, **not** a remote-host/network-latency claim. TUI uses
its public `app SESSION --server ID --ssh ALIAS` entry and production SSH relay;
GUI uses the supported host config over its private SSH forward. Record that
transport implementation difference when interpreting results.

## Prepare, without running samples

Use Node24 and put the desired bundled tmux on PATH. Use an already-built CLI,
matching compiled TUI and matching native app; explicitly declare `--profile debug`
or `--profile release` (recorded as caller-declared, not inferred). There are no implicit builds or
downloads. Compile the small macOS probe outside the repository:

```sh
swiftc apps/tmux-gpui/bridge/performance/window-probe.swift -o /tmp/tmux-gui-window-probe
/tmp/tmux-gui-window-probe preflight
node --test apps/tmux-gpui/bridge/performance/measurement.test.mjs
```

The probe checks Screen Recording and event-posting access without prompting.
Output-trigger mode requires capture; physical-input mode requires both. When a
required permission is unavailable, the harness stops before launching fixtures. It does
not silently substitute a renderer/helper endpoint. Preflight in this session
reported capture available and input posting unavailable. Enabling posting is
an OS permission action; do not assume successful capture grants it.

## Run only after builds are quiet

```sh
node --import tsx apps/tmux-gpui/bridge/performance/visible-response.mjs \
  --cli /absolute/matching/bin/cli.js \
  --tui /absolute/matching/tmux-ide-tui \
  --app /absolute/matching/TmuxIDE.app \
  --probe /tmp/tmux-gui-window-probe \
  --output /absolute/new/evidence-directory \
  --route local --trigger output --profile release --run yes
```

Repeat with a fresh output directory and `--route ssh`. Each run is bounded to
five minutes including setup/arming and contains five GUI/TUI pairs in AB/BA
order. Do not run the two routes concurrently. The output directory must not
already exist and is created private. Its parent must exist.

The fixture launches clients, then waits for explicit arming. Read its
`ui-state.json` to identify only the owned windows. Select the named session and
first pane in the native GUI; TUI launches that session through the public CLI.
Resize the owned windows until each gives the same canonical tmux window and
all three pane grids. Use the fixture's exact socket from ui-state when reading
geometry. Do not resize production windows to calibrate this experiment.

Write `armed.json` in that evidence directory:

```json
{ "guiPid": 123, "guiWindow": 456, "tuiWindow": 789, "cols": 110, "rows": 32 }
```

IDs must come from this fixture's inventory. The harness verifies ownership
again on every capture/input. It activates only those instances, checks matched
window/pane grids before every trial, sends a unique marker followed by Enter,
and requires exactly those bytes once in the intended pane. In `--trigger output`
mode, private tmux sends the marker directly to the owned program; this bypasses
client input and measures the daemon/output/render path. `--trigger physical`
uses PID-targeted OS keyboard events and is currently blocked by event-posting
permission. No permission prompt is requested. A sample completes
only after both marker OCR and color are observed in the owned window screenshot.
Failures and timeouts stay in the receipt; incomplete work is not counted as fast.

`receipt.json` records exact build hashes, route, terminal version, tmux version,
CPU-load snapshots, configured Menlo14 font, per-window display refresh/scale
(where the OS reports them), marker witnesses, screenshots, per-sample intervals and
five-sample median/range of the conservative upper bounds. Native executable,
live/browser bundles, bridge manifest, embedded Node, launcher, CLI and TUI
hashes identify the exact artifacts. Unknown or differing display metadata is
marked explicitly and prevents a fully matched comparison claim. It also checks pane
PIDs survive closing both clients before disposing the private daemon/socket.
Input logs are synthetic fixture data, not user terminal contents. Intended-pane
and PID witnesses are persisted before marker setup so failures retain them.

## Limits and remaining instrumentation

This harness measures source-trigger→visible output, or (when explicitly selected
and permitted) physical key→visible echo through real GUI/TUI windows. These
endpoints are separately named in receipts and must not be pooled. Output-trigger
measurements do not establish client typing latency. The trigger timestamps
bracket private tmux command execution, so upper bounds conservatively include
that invocation overhead on both sides.
Pane-switch, divider and whole-window resize correctness already have separate
owned/native fixtures; they are not silently included in this timing claim.
Screen-capture command startup/OCR sampling limits precision. OCR runs after the
capture end timestamp and does not inflate that timestamp, but can increase the
gap before the next observation. Differences smaller than observed interval
uncertainty are inconclusive.

## Controlled renderer-completion trials

The fixture-only probes now time original client input admission to completed
renderer work. GUI completion is successful CPU paint submission of the exact
visible marker; TUI completion is the exact marker row blitted to its renderer
buffer. These endpoints differ and neither proves visible pixels or vsync.
Integration checks and physical trial qualification are still in progress.

`renderer-trial-cli.mjs prepare identity.json manifest.json` creates five
interleaved GUI/TUI pairs for each of input, scroll and output (30 trials total).
The identity file must
record `build`, `daemon`, `tmux`, `route`, `cols`, and `rows`; include exact GUI,
TUI and daemon hashes, release profiles, terminal version, font/display settings,
and load observations before making a comparison. Keep the generated manifest
and all receipts. Run one isolated single-pane fixture with the same geometry,
workload and transport for both clients; the GUI probe rejects multi-pane frames.

Start `renderer-fixture.mjs` only inside that owned fixture pane, with
`TMUX_IDE_RENDERER_FIXTURE=1`. For each client, set the same flag and:

- `TMUX_IDE_RENDERER_PROBE_TRIALS`: JSON array of that side's manifest trials,
  mapping each entry to exactly `{id, nonce, kind}` in manifest order.
- `TMUX_IDE_RENDERER_PROBE_LOG`: an absolute, new receipt file path for that
  client. Never reuse an existing evidence file.

Follow the global manifest order across the two clients, rather than completing
all trials on one side first. For an input trial, type `!`: the opt-in client
replaces it with a nonce request and the fixture prints a different output marker.
This is a controlled request-response workload, not ordinary single-byte typing.
For a scroll trial, first type `!` to prepare history without timing it, then
scroll locally to expose a previously hidden nonce row. In the TUI use Shift-wheel.
For an output trial, type `!` once: the fixture writes exactly 2 MiB of fixed
ASCII lines in bounded, backpressure-aware chunks, then places the completion
marker at row zero. The endpoint includes request transport and processing the
burst through the final rendered marker; it does not require every intermediate
frame to paint. The output workload source hash is included in the run manifest.
A successful receipt requires the matching row to reach the renderer within five
seconds. Preserve timeouts, scope changes, rejected input and missing receipts;
do not replace failed trials with faster retries.

TUI interaction in this task is manual. Do not use the older OS event-posting
helper to circumvent a Computer Use restriction. The probes do not automate a
terminal window or grant input authority.

After both logs are flushed, combine their JSONL records and run:

```sh
node apps/tmux-gpui/bridge/performance/renderer-trial-cli.mjs \
  analyze manifest.json summary.json receipts.jsonl
```

The analyzer rejects duplicate, unknown, mismatched-renderer and mismatched-nonce
receipts. It retains failures and missing trials and reports per-cohort count,
median and range in milliseconds. Inspect the original scope, timestamps and
paint witnesses as well as the summary. Missing records, logger failures, unequal
geometry or unverified builds prevent a matched comparison. Run only after builds
are quiet. No renderer or visible-performance result has yet been established.

## Remaining research qualification

On 2026-10-23, the current macOS workspace passed default-feature tests
(`/tmp/native-final-workspace-tests.log`, including 3,012 GUI and 401 client
tests), formatting, and strict workspace Clippy with both all features and no
default features. The optimized CLI suite also passed all 10 checks
(`/tmp/native-final-release-cli-tests.log`). These are correctness/build checks,
not GUI latency measurements. All-feature workspace tests subsequently passed
(`/tmp/native-final-allfeatures-workspace-tests.log`, including 3,043 GUI and
401 client tests). Linux/Windows checks still need separate completion evidence;
macOS checks do not prove those platform-specific paths.

The research scope includes pane switching and sustained output, as well as
typing and scrolling. The source manifest and probes now include the bounded
output cohort, but the staged optimized GUI predates that instrumentation and
must be rebuilt before using the new manifest. Earlier workspace gate results
above predate this probe extension. Switching still needs a separate workload
and successful-render witness. No paired measurements are complete. The existing
GUI probe now also requires its stored pane identity and navigation request to
match the current selection before admitting or completing a trial. Otherwise a
retained frame from the preceding selection could falsely complete a sample.
Runtime regressions cover both mismatches; executing them remains part of the
pending disk-dependent test run.

Output-cohort focused checks: nine Node workload/ledger/analyzer tests, four
TUI probe tests, daemon typechecking and affected ESLint passed. A standalone
`rustc --test` harness compiled the actual Rust ledger module and passed all
13 ledger tests, including final-marker/unchanged-scope checks. This does not
compile or exercise the GPUI runtime adapter. A subsequent strict workspace
Clippy check (`--locked --workspace --all-targets --all-features -- -D warnings`)
passed with the output extension, including compilation of its runtime test
adapter (`/tmp/native-output-allfeatures-clippy.log`). This is compilation
coverage, not execution of the new output-routing regression. The all-feature
GUI test build failed before running tests with `No space left on device`
(`/tmp/native-output-allfeatures-gui-tests.log`). Its 15 incomplete object files
were individually verified and removed, recovering 484,569,808 bytes; the audit
is `/tmp/native-output-failed-objects-audit.json`. The test run and rebuilt native
app remain pending sufficient disk space. The first standalone compilation
attempt incorrectly treated the module as a crate root (`pub(super)` error);
the corrected harness imports it as a module without changing product code.

An isolated PTY run of the real `renderer-fixture.mjs` passed in
`/tmp/native-output-pty-qualification.json`: exactly 2,097,152 burst bytes,
16,384 lines and one final marker. Reading was initially withheld to exercise
stdout backpressure, then the complete output was compared byte-for-byte.
The owned child exited and cleanup passed. This verifies the workload process,
not either renderer or comparative latency.

The existing one- and fifteen-pane row-overwrite retention runs cover the daemon
and test client. They do not establish native GUI RSS or sustained multi-image
placement/scrolling retention. Those need an owned GUI workload and separate
process measurements. Local file leases avoid base64 transport and repeated
bridge copies; they do not establish zero-copy image decoding or GPU upload.

Two-phase resize defers the daemon mutation until release. The content preview
clips and translates borrowed terminal rows and images into provisional pane
rectangles, moves labels, and retains that presentation while release is pending.
The committed framebuffer and input regions are unchanged; input, links, and
selection remain fenced until the gesture settles. Geometry, painter translation,
and pending-input regression tests cover this path. An optimized native run in `/tmp/tmux-gui-evidence-m4D9aR` verified vertical
divider resizing in both directions, final tmux geometry, and exact left/right
input routing after release. It did not capture continuous mid-drag frames or
qualify horizontal/nested dividers and image clipping in the actual window.
Those remain separate from the headless painter regression checks.

The subsequent native horizontal run `/tmp/native-horizontal-resize-20261023`
used `native-gui-fixture.mjs --split-axis rows` and the same optimized GUI
SHA256 `cbf336af6130d141362ea6ae2cb61979fe2aa5c53eb1f9d4bee2576bc3e6ac99`.
Dragging down changed pane heights from 12/12 to 16/8 rows; dragging up changed
them to 10/14, with the window remaining 89×26. Both panes received distinct
markers exactly once after each release, without geometry changes during those
selection switches. Actual text reflow was observed and all five cleanup steps
passed. Continuous mid-drag capture, nested dividers and native image clipping
remain unqualified. This binary predates the output-probe-only extension above.

### Native image resize observations

The owned run `/tmp/native-image-resize-20261023` used the same optimized
binary SHA256 recorded above. Images were emitted after GUI attachment through
the isolated raw echo fixture. Orange cursor-anchored placements spanning 60
columns clipped at both pane edges, then disappeared after divider release.
This is consistent with `KittyImageStore.dropCursorPlacements`: these placements
have no tmux grid representation and are discarded when the coordinate basis
changes. This observation does not prove cursor-image preservation on resize.

Cyan 24-by-3 Unicode-placeholder placements remained visible after the next
resize. The right image's rows separated along with surrounding text reflow;
placeholders had been written over existing lines, not into cleared rows.
Both panes subsequently received their own distinct typing marker exactly once.
The run exited successfully and all five cleanup steps passed. Evidence is in
`validation-result.json`, `geometry.jsonl`, and `cleanup.json` under that run.
This qualifies static edge clipping and a bounded post-release placeholder
reflow case; continuous mid-drag image clipping and nested dividers remain
unqualified. No timing or GUI/TUI comparison follows from this check.

### Native image-memory qualification fixture

`apps/tmux-gpui/scripts/native-memory-fixture.mjs` runs an isolated single-pane
workload and samples identity-checked native GUI, daemon, and broker RSS every two
seconds. It requires visible-pane arming; sending bytes alone is not proof that
images rendered. The bounded phases are 20 seconds baseline, 60 seconds image
updates/history, 20 seconds cached reuse, deletion, and 90 seconds idle. Idle
cache eviction is paint-driven, so elapsed idle time alone does not prove release.
The optional `--image-profile hd` uses three image IDs and two pixel variants at
1920×1080 RGBA: six distinct payloads total (49,766,400 bytes), with 60 updates
transmitting 497,664,000 raw pixel bytes before Kitty base64 framing. The default
`small` profile remains 64×64. Neither profile infers decode/paint completion from
stdout writes, and the shortened `--smoke 1` run never launches the GUI.

The fixture now also records `daemon-memory.jsonl` through the owned daemon's
diagnostics endpoint, checking process identity before and after each request
and the daemon instance ID in its response. Only fixed memory counters are
saved, in bytes; array-buffer memory is included in external memory. Failed or
invalidated samples fail qualification. This adds baseline and phase-aligned
heap/external samples for future runs. Seven focused harness tests passed, and
`/tmp/native-memory-diagnostics-smoke-20261023` verified four successful samples
and all five cleanup steps against a real isolated daemon. That smoke run had
no GUI and is not memory-retention or performance qualification.

The first native run, `/tmp/native-memory-live-20261023-a`, rendered images,
scrolled history and returned to live output, reused images, and visibly removed
them after deletion. It completed all phases and owned-process cleanup. Native
RSS stayed between 120544 and 120560 KiB during the 90-second idle interval.
This small single run excludes GPU/subprocess memory and is not evidence of leak
freedom or a reason to change memory limits. Two native-connection recovery
notices occurred: correctness qualification is incomplete pending diagnosis and
a clean repeat. Full measurements and limitations are in its `summary.json`.

The diagnostic repeat `/tmp/native-memory-live-20261023-b` reproduced a native
graphics ordering mismatch. The daemon image-store revision can remain unchanged
when viewport-relative placements move; the client had required the whole state
to remain equal. A focused regression failed with that same error before the
client fix. The fix accepts changed placements at an unchanged revision while
retaining image-registry and capability consistency checks; all 401 client tests
pass (`/tmp/native-graphics-viewport-fixed.log`). The optimized GUI repeat
`/tmp/native-memory-live-20261023-c` completed the same workload with zero native
failures or recovery notices; scroll/return and image deletion were observed in
the actual app. Native RSS remained 108928 KiB throughout its 90-second idle
phase, including a scroll/return repaint after 74 seconds. All five cleanup
steps passed. This is one small workload, not leak-freedom or comparative
performance evidence. Temporary diagnostics were then removed. Strict client
Clippy and all 24 daemon graphics tests passed; a daemon assertion independently
confirms that viewport projection can change without an image-store revision.

The full-HD run `/tmp/native-memory-hd-live-20261023` used the optimized build
without temporary diagnostics. All 60 image updates were written (497,664,000
raw pixel bytes); actual GUI observations confirmed images, scroll/return, cached
reuse, and deletion. No broker recovery notices occurred, and all five cleanup
steps passed. Sampled daemon RSS peaked at 510352 KiB and ended at 304384 KiB;
native RSS peaked at 268224 KiB and stayed between 220480 and 220512 KiB during
idle. These are root-process RSS samples, not retained-object or GPU measurements.
The one late-idle daemon diagnostics sample reported 97,683,432 bytes heap used,
38,647,409 external bytes, and 26,073,806 array-buffer bytes (the latter is included
in external). No baseline heap sample was collected, so this cannot isolate
retention or justify changing cache limits. The run demonstrates a bounded
workload with partial RSS release; it does not establish leak freedom. Exact
phase statistics, build identity and limitations remain in its evidence folder.

The diagnostic full-HD repeat `/tmp/native-memory-hd-diagnostics-20261023`
completed all 60 writes, with zero invalid diagnostic samples and all five
cleanup steps passing. Native observations confirmed image rendering,
scroll/return, cached reuse, deletion, and another scroll/return during late
idle. No connection recovery notices were recorded. Baseline daemon heap-used
median was 94,655,140 bytes; idle median was 96,519,272 bytes. Array-buffer
medians were 676,265.5 and 26,070,690 bytes respectively. Native idle RSS was
236880–236912 KiB across 45 samples. The workload uses uppercase `d=I` without
a placement ID, which requests deletion of image data as well as placements.
The remaining buffer memory therefore warrants tracing retained references or
collector behavior; these counters alone do not establish a leak. No cache
limit was changed. Diagnostic requests themselves can allocate and affect GC
timing. This remains a single bounded run, not comparative performance evidence
or proof that every submitted image frame painted.

A source-only diagnostic at `/tmp/native-kitty-retention-20261023` replayed the
same 60 HD image commands through `KittyImageStore`, then uppercase deletion.
The store went from three images / 24,883,200 bytes to zero images / zero bytes.
After explicit GC across event-loop turns, none of the three weakly referenced
pixel buffers remained, and array-buffer memory returned from 49,912,327 to
145,927 bytes (baseline 145,911). RSS did not fall with collection. This rules
out those buffers being retained by the standalone image store in this replay;
it does not rule out references elsewhere in the live daemon. Forced GC was
diagnostic only, outside the product and outside reported performance trials.

The live-daemon follow-up `/tmp/native-memory-hd-gc-20261023` used a temporary
CLI wrapper to collect garbage after 65 seconds of idle. It ran the same 60 HD
updates with the native GUI attached and observed rendering, scroll/return and
deletion. The wrapper's PID matches the owned daemon manifest. Array-buffer
memory fell from 26,022,614 to 1,118,725 bytes, and external memory from
38,585,102 to 13,681,213 bytes; RSS remained about 321.4 MB. The excess was thus
collectible in this run, not permanently held by the live delivery path. All
diagnostic samples and five cleanup steps passed. This does not establish
general leak freedom or justify forcing collection in production. The wrapper
is outside the repository; no product GC or cache-limit change was made.

### Resumed builds after disk cleanup — 2026-10-23

The current source passed `cargo test --locked --workspace` (3,016 GUI and
401 client tests) and `cargo test --locked --workspace --all-features` (3,047
GUI and 401 client tests), with zero failures. Opt-in ignored tests remain
separate. Logs are `/tmp/native-resumed-default-tests.log` and
`/tmp/native-resumed-allfeatures-tests.log`. These runs execute the new output
runtime and stale-selection regressions that previously had compilation-only
evidence. Ten Node probe tests, four TUI probe tests, and daemon typechecking
also passed.

The optimized GUI build succeeded (`/tmp/native-resumed-release-build.log`).
Its source binary SHA256 is
`4c94053cd42650b3792fa1c8166db8133b7bca43b9d327278a8bb666e50e23ee`.
The locally ad-hoc-signed validation app has SHA256
`6e6a69d39b3e7e6e39617b9f8ac83298a32a11c5f9d950ddacabe5904ff91152`;
identity and paths are recorded in `/tmp/native-resumed-release-identity.json`.
This replaces the staged probe-incomplete binary for subsequent validation;
earlier native observations retain their original binary identity. No paired
performance conclusion follows from these build/test results.

### Native probe completion after scroll admission fix — 2026-10-23

The first native repeat (`/tmp/native-resumed-gui-probe`) exposed a probe-only
admission bug: returning from history consumed the next scroll trial before its
nonce-specific content was prepared. The GUI probe now arms only from live
viewport offset zero with the next trial's exact row marker. A regression covers
returning live, unprepared content and a different trial's nonce. Normal GUI
scroll behavior is unchanged.

The updated all-features suite passed 3,048 GUI and 401 client tests
(`/tmp/native-scroll-admission-tests-retry.log`). The preceding run retained in
`/tmp/native-scroll-admission-tests.log` failed one POSIX upload timeout test;
the complete retry passed. Strict all-target/all-feature Clippy and the optimized
build passed (`/tmp/native-scroll-admission-clippy.log` and
`/tmp/native-scroll-admission-release.log`). Ten release CLI tests had passed
before this probe-only fix (`/tmp/native-resumed-release-cli-tests.log`).

The rebuilt source binary SHA256 is
`01173db7e405578bfde0f8e8b7de081bcf005c6334e4aed0524ed84569f45a8d`;
the locally ad-hoc-signed app is
`9fb2b4cf0ca1389a4add33b8b90248d4dfb90c56bda9e692053f88e077c1ef9a`.
Identity is recorded in `/tmp/native-scroll-admission-identity.json`.

The live repeat `/tmp/native-scroll-admission-gui` completed five input, five
scroll and five 2 MiB output probes with zero GUI failures. The final output
marker was also visible in the app. The owned app exited normally and all six
fixture cleanup entries passed. This was GUI-only validation: all fifteen TUI
samples remain missing and `summary.json` correctly reports `complete: false`.
It does not establish matched performance, SSH latency, visible-pixel timing,
or pane-switch latency. Those qualifications remain outstanding.

### SSH GUI follow-up — 2026-10-23

`/tmp/native-resumed-ssh-gui` used the same optimized app through the owned
loopback SSH fixture. Five input, five scroll, and five 2 MiB output probes
completed with no GUI failures; all six cleanup entries passed. This checks SSH
transport behavior, not remote network latency. TUI samples remain missing, so
there is no paired performance conclusion.

`/tmp/native-resumed-ssh-switch` exercised ten alternating pane selections with
immediate unique typing. Both panes received exactly their five intended markers,
without duplication or cross-pane input. All 365 geometry samples after settling
retained the same dimensions (left 45x25, right 43x25, window 89x26). All five
cleanup entries passed. Sampling is every 250 ms and does not prove absence of a
shorter intermediate resize or establish selection-to-paint latency.

The follow-up `/tmp/native-ssh-catalog-audit` added layout digests to fixture-only
observations. It found repeated identical layout bodies within the same request,
including after pane selections. Rust's catalog notice key previously included
the topology epoch, even when exported layouts had not changed. The new notice
tracker retains the epoch fast path but compares layouts on epoch advances;
request, presence, pane or actual layout changes still force publication.

The catalog change passed three focused Rust regressions and three fixture
observation tests. Full workspace default and all-features runs passed 3,020 and
3,051 GUI tests respectively, plus 401 client tests each
(`/tmp/native-catalog-default.log`, `/tmp/native-catalog-allfeatures.log`).
Strict Clippy initially rejected a nested conditional; the equivalent collapsed
conditional passed (`/tmp/native-catalog-clippy-fixed.log`). Independent read-only
review found no actionable correctness issue; `/tmp/native-catalog-review.json`
records the invariants checked. These are correctness/build checks, not latency
or parity evidence.

The optimized rebuild passed (`/tmp/native-catalog-release.log`). Source SHA256:
`81b842cc3b95eaf3826c4c61dda51cc55c2f919d3166ec6e9b224c38e3d42ced`;
ad-hoc-signed validation app SHA256:
`374618d1cd1ee7ed7377463730a2293d075d9bccd0b0359155b12f3e607f7f1d`.
The repeat `/tmp/native-ssh-catalog-fixed` recorded zero consecutive identical
layout notices within the same request and observed presence revision, versus
11 in `/tmp/native-ssh-catalog-audit`. Both exercised six alternating selections
with exact L0/L1/L2 and R0/R1/R2 routing. These diagnostic runs were not matched
latency trials; their total durations and later actions differ.

The fixed run also propagated a real divider resize from 45/43 columns to 31/57
columns, preserving the 89x26 window. A new layout digest was published. Presence
changes still legitimately republish an unchanged layout. All five cleanup
entries passed in both runs. Immediate typing after a focus return was fenced
with the existing visible input-interruption message; after an explicit click
rearm, AFTER-REARM arrived once in the right pane. The rejected AFTER-RESIZE marker
was not replayed. This is not evidence of seamless focus-return typing.

Linux and Windows checks remain unrun. Docker is available, but the internal
volume had only 327 MiB free at the platform preflight; the external Rust target
volume had 73 GiB. No Docker build was started, and no unrelated data was removed.

### Focus diagnostic qualification — 2026-10-23

`/tmp/native-focus-repro` used a temporary, content-free diagnostic build after
the catalog fix. It distinguishes a real activation transition from Computer Use
sending events to an inactive app. One confirmed background revision 3 to
foreground revision 4 cycle delivered RETURN-ONE exactly once after the same
31/57-column resize. Three later Finder Raise attempts did not change presence,
so their successful typing is excluded as focus-cycle evidence.

A minimize/restore attempt produced background revision 5 but no foreground
transition. The tool still delivered click/key callbacks: diagnostics showed
`active=false`, `presence_ready=false`, `queued=None`, and a matching painted
pane. RESTORE-ONE was correctly rejected. This demonstrates a test limitation,
not a justified reason to bypass the foreground input fence. The earlier
AFTER-RESIZE rejection remains insufficiently diagnosed; seamless focus recovery
is not claimed. Temporary diagnostics were removed; no production focus change
was made. All five fixture cleanup entries passed, and the Finder window opened
for the test was closed. The diagnostic binary identity remains in its evidence
folder, separate from the clean validation build.

### Live alternate-screen projection — 2026-10-23

The isolated `manual/direct-terminal-smoke.mjs` projection fixture writes 350 history
lines, enters the alternate screen, and updates a visible counter. The Rust
probe now uses `Controller::spawn(handoff)`, matching the GUI capability path.
Its previous bare `NativeSession::spawn` discarded the offered projection and
binary capabilities and correctly failed negotiation; that was a probe defect.

`/tmp/native-projection-live.log` passed three commits: the initial 23-row seed
retained 327 deferred history rows; each subsequent update changed only row 0.
`/tmp/native-direct-controller-live.log` also passed three ordinary terminal
commits with complete history. Both isolated runners exited successfully after
cleanup. The optimized probe build, strict example Clippy, and diff whitespace
check passed. This verifies real daemon-to-Rust projection and changed-row
application, not GUI paint latency or GUI/TUI performance parity.

### Native projection, row resize and activation — 2026-10-23

`/tmp/native-projection-gui-final` exercised the clean optimized validation app
(SHA-256 `374618d1cd1ee7ed7377463730a2293d075d9bccd0b0359155b12f3e607f7f1d`)
with two stacked alternate-screen panes and 250 ms cursor-mode updates. Native
screenshots show the projected contents, a row-divider resize, alternate-screen
exit restoring normal history, and history scrolling to lines 246–254. Subsequent
top/bottom resize markers arrived exactly once. Closing the workspace tab and
reopening while foreground selected a pane automatically; REOPEN-DIRECT arrived
without another terminal click. All five cleanup entries passed.

This run also exposed an unresolved activation input interruption: ROW-TOP-0
arrived only as ROW. Presence became active at 1792762222825, the accepted prefix
arrived at 2869–2870 within that second, and the first native layout digest change
followed at 2873. Initial geometry is a hypothesis, not a proven cause. Earlier
AX session actions occurred while native presence was inactive and are excluded
from foreground initial-selection evidence. Typing immediately after Back to live
also did not arrive; an explicit content click rearmed input and LIVE-REARM arrived
once. These observations prevent claiming seamless activation/history-return
input. The fixture result records exact bytes, screenshots, and cleanup; it is a
correctness run, not a matched latency comparison.

### Viewport resize typing interruption — reproduced and fixed 2026-10-23

A temporary content-free diagnostic build reproduced dropped typing by toggling
F10 and immediately typing in the selected pane. In
`/tmp/native-activation-trace-long`, SIDEBAR-RESIZE followed by the alphabet and
digits stopped after P. The input gate recorded `presence=true`,
`authority=false`, `retained=false`, no divider gesture, no rejected target, and
a retained frame. The viewport changed while layout and terminal rows converged,
so the GUI's readiness gate latched interruption halfway through typing. A shorter
activation repeat (`/tmp/native-activation-trace`) delivered all nine characters;
the original initial-activation failure remains timing dependent.

The view now captures a bounded keyboard FIFO when it successfully requests a
viewport dimension change. Old-size ready frames cannot flush it. Input waits
for matching dimensions, readiness, and the exact captured terminal lifetime;
blur, navigation, rejection, history, expiry, or a replacement token discards it.
It uses the existing one-second, 64-input, 64-KiB bounds. Ordinary unowned readiness
gaps still interrupt input. No authority or stale-geometry gate is bypassed.

`/tmp/native-viewport-input-fixed` repeated five F10 toggles with immediate typing,
alternating the actual viewport between 89 and 115 columns at 26 rows. All 212
bytes arrived exactly once, and diagnostics recorded no interruption. Both runs
passed all five fixture cleanup entries. The fixed diagnostic app hash was
`fc9c5c836778718b225accc5806466ef6b8ec942e2f6189e8a482b5f5193deef`.
Temporary instrumentation has been removed from source. Focused tests passed
six cases; the default GUI library suite passed 3022 tests with eight existing
ignored tests. This establishes the resize-typing fix, not matched SSH latency
or all initial-activation timing cases.

The clean optimized rebuild and strict all-target/all-feature workspace Clippy
also passed. The clean staged app hash is `5aab7481e71a5df41fa7440959a5c3019a9e59d056a092ab6019a018e8213839`;
identity and log paths are recorded in `/tmp/native-viewport-clean-identity.json`.

The subsequent clean SSH repeat (`/tmp/native-viewport-ssh-clean`) delivered all
five sidebar-resize markers but truncated the initial activation marker at exactly
32 input events. The buffered-input flush treated a full 32-slot command channel
as a disconnect, discarding its unsent suffix. A reduced-capacity regression
reproduced the same mechanism: `abcde` arrived as `ab` before the fix
(`/tmp/native-buffer-pressure-before.log`). The flush now retains only unsent
items and retries on the existing 16-ms update tick; accepted items are never
replayed. The original scope, authority, deadline and buffer bounds remain in
force. An empty pending queue adds no geometry validation to idle ticks.

For the queue-pressure change, the final default GUI library suite passed 3023
tests with eight existing ignored cases (`/tmp/native-buffer-suite-final.log`).
The regression now verifies exact FIFO delivery with repeated queue draining;
the selection test distinguishes temporary fullness from disconnection and
verifies no replay after reconnect. The optimized build passed
(`/tmp/native-buffer-build.log`). The staged app SHA-256 is
`3bcc18f4f1869f63cd2c570f61e421702d23d2a32bec9c6321832aeab957b182`.
The fresh native SSH repeat at `/tmp/native-buffer-ssh-fixed` was prepared, but
Computer Use reported a locked Mac before interaction. Its physical result is
pending; passing unit tests alone does not establish the original GUI journey.

The queue-pressure fix also passes the all-feature workspace suite
(`/tmp/native-buffer-allfeatures.log`), including 3054 GUI tests (nine ignored)
and 401 client tests. Current source inspection narrows the Back to live follow-up:
`pane_chrome.rs` sends `Input::Scroll(0)` from its header callback, without an
explicit terminal focus/rearm operation. This is a hypothesis for the earlier
native failure, not a diagnosis; reproduce the foreground header click, immediate
typing, and live publication with input-latch/focus observations before changing
that behavior. Preserve rejection of typing directed at historical content.

Strict no-default-feature workspace Clippy passed as well
(`/tmp/native-buffer-nodefault.log`). These macOS gates do not qualify Linux or
Windows builds or substitute for native interaction evidence.

### Explicit Back to live input handoff — 2026-10-23

A GPUI test now clicks the actual `pane-mode:pane-a` header control while viewing
history, immediately types `new`, then supplies the live publication. Before the
change it failed with the input-interruption latch still set
(`/tmp/native-back-live-before.log`); after the change it delivers exactly `new`
only after the live publication (`/tmp/native-back-live-after.log`). This narrows
the earlier native observation to a reproducible header/input-gate path; it is
not yet a rerun of that physical native journey.

The explicit header activation now captures the coherent native terminal lifetime,
requests live rows, focuses the terminal and starts a bounded new input gesture.
It discards old composition and never replays earlier rejected input. Historical
lifetime proof is separate from authority: the native adapter still exposes no
input targets and cannot resolve input while viewing history. Dispatch requires
the matching live target. The existing one-second, 64-item and 64-KiB limits apply;
changed lifetime, foreground presence, navigation or history offset cancels held
text. Ordinary scrolling/history selection does not opt into this handoff.
