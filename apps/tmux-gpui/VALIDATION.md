# Snapshot preview validation — 2026-10-09

Scope: snapshot and first live read-only adapter on macOS ARM64, Rust 1.96.1,
GPUI 0.3.6. This does not qualify full tmux parity.

## Completed

- `cargo test --locked --workspace`: 2,683 passed, 10 existing opt-in tests
  ignored. Includes all eight snapshot/stream adapter regressions.

- `cargo test --locked --workspace --all-features`: 2,717 passed, 17 existing
  opt-in tests ignored. No Linux or Windows execution is implied.
- Canonical TypeScript `TerminalReplicaSnapshotSchemaZ` accepts the synthetic fixture.
- `cargo test --locked --release -p herdr-gpui --test cli`: all 10 CLI smoke
  tests passed.
- `cargo build --locked --release -p herdr-gpui` passed; the optimized executable
  also validates the snapshot fixture successfully.
- Debug executable accepts the fixture through `--tmux-snapshot FILE --validate-only`.
- Executable rejects missing arguments, malformed JSON and files larger than 8 MiB.
- Native macOS window inspected: text, wide cell, combining accent, indexed/RGB
  color, underline, inverse and bar cursor paint. See
  [captured window](evidence/snapshot-preview-macos.png).
- All-feature and no-default-feature workspace Clippy pass with warnings denied.
- Original source hashes differ only for the documented `main.rs` entry point;
  new modules are listed in `UPSTREAM-CHANGES.md`. License and lockfile unchanged.
- Preview launcher shell syntax and root `git diff --check` pass.

## Qualification still required

Broader live coverage (multiple panes and sustained output), input, resize,
automatic reconnect, scrolling, graphics placements, blinking, full native UI,
release packaging and Linux/Windows remain unqualified. The offline fixture is
synthetic; the separate live smoke coverage is recorded below.

The native preview was run with a temporary HOME. The UI inspection tool reopened
its temporary bundle without arguments after quit; that upstream window was
immediately closed. A process check confirmed no Herdr process remained. Use the
explicit preview launcher, not the temporary test bundle or upstream default entry.

## Local development tools

For this session the Rust installation is isolated, without changing shell profiles:

```sh
export RUSTUP_HOME=/tmp/tmux-gpui-toolchain/rustup
export CARGO_HOME=/tmp/tmux-gpui-toolchain/cargo
export PATH="$CARGO_HOME/bin:$PATH"
```

Temporary Cargo output was moved to the external drive and linked from ignored
`upstream/target` after internal disk space ran low. No source or lockfile change
was needed. `just` is absent; equivalent Cargo commands are used for its gates.
The dependency `block 0.1.6` emits a future-Rust compatibility notice.

## Live read-only slice — 2026-10-09

The helper uses the existing scoped pane-stream client and canonical delivery
reducer. No changes were made to daemon authority, wire contracts or the painter.

- TypeScript bridge typecheck and four reducer tests pass (complete commit,
  replaced generation, corrupted canonical hash, late callback after retirement).
- Eight focused Rust snapshot/stream tests pass, including helper connection
  fencing and rejection after an unavailable publication.
- Real private daemon/tmux smoke test passes, including the native window:
  exact initial and newly produced marker lines received; native UI applies
  unavailable after daemon shutdown; starting a new daemon generation does not
  revive the retired reader. Owned children and scratch fleet were cleaned up.
- [Live native output](evidence/live-preview-macos.png) and
  [verified disconnected window](evidence/disconnect-verified-macos.png).
- The [early disconnect observation](evidence/disconnect-early-observation.png)
  still showed terminal content after the helper reported unavailable. That alone
  did not establish a persistent renderer defect. The repeated native path logged
  both stream retirement and UI application, then showed the cleared window.
  The smoke test now waits for native application before declaring success;
  no claim is made of fixing a proven underlying rendering bug.

This slice stops on protocol failure or disconnect. It does not automatically
reconnect, accept a replacement identity, send input, resize the source, or expose
history scrolling. The helper ACKs canonical replica commitment, not GPU paint.
The helper/native transport is bounded to one pending complete snapshot per side,
with an 8 MiB publication ceiling. This is not a performance or full parity result.

## GP02 first increment — explicit preview process ownership

Reproduced the shell-pipe lifecycle with isolated process stand-ins: the native
consumer exited while its idle producer remained alive. This is process-level
mechanism evidence, not a claim of a previously observed personal-daemon leak.

The live launcher now owns both child processes, forwards bounded pipe backpressure,
terminates/reaps the idle helper on viewer exit, and stops both on cancellation with
bounded SIGKILL escalation. Only exact owned children are signalled; daemon and tmux
remain untouched. Normal helper EOF can still clear the native view.

- Five process regressions pass: idle consumer close, cancellation including a
  SIGTERM-ignoring helper, helper failure/EOF, spawn failure and pre-cancelled launch.
- TypeScript bridge typecheck, shell syntax and diff whitespace checks pass.
- Real native/private-daemon smoke passes with launcher cancellation and a subsequent
  successful inventory request against the same daemon, alongside existing output,
  visible-disconnect and replacement-rejection assertions.

Evidence logs are under `.tasks/tmux-gpui-lifecycle/` in the development worktree.
Rust code and compiled binary were unchanged in this increment. Native cancellation
is exercised programmatically; an OS close-button interaction with the new launcher
has not been separately driven. GP02 remains open: dedicated product entry, full
protocol/version policy, dependency trimming and packaging remain outstanding.

## GP02 second increment — dedicated native executable

The package now builds `tmux-ide-gpui` as its default run target. Its entry calls
only the preview dispatcher. Original module composition moved into `src/lib.rs`;
the upstream `herdr-gpui` binary remains an explicit reference target. Development
launchers select the dedicated binary. No dependency, lockfile, painter or protocol
change is involved; this does not yet remove inherited build dependencies.

Three new executable tests cover product help/version, rejection of upstream and
malformed options, and canonical fixture validation with no state files created.
The dedicated debug executable also passed the real private-daemon/native live
smoke, including child cancellation, output changes, visible unavailable state
and replacement-generation rejection. A separate no-argument native launch stayed
open for two seconds with an empty private HOME and was explicitly terminated and
reaped. This was a process/startup check, not screenshot-based visual qualification.

Evidence logs: `/tmp/gpui-entry-*.log`. GP02 remains open for protocol/version policy,
dependency trimming and distribution. Session selection remains GP03; the default
window is a disconnected read-only preview. This increment is local and unreleased.

Final dedicated-entry gates: default workspace 2,686 passed / 10 ignored;
all-feature workspace 2,720 passed / 17 ignored. Both Clippy configurations
(all-feature and no-default-feature), formatting, source-size checks and optimized
binary build passed. Ignored checks remain unqualified.
Optimized CLI checks also passed: 10 upstream-reference tests and 3 dedicated-entry tests.

## GP03 catalog foundation

Extracted shared private host/connection configuration and added a scoped session
catalog plus a transitional interactive terminal picker. The native picker is not
implemented yet. Catalog selection uses live-session identity, revalidates it, then
opens the session and reads the semantic pane inventory through the existing client.
The picker writes a temporary 0600 connection file and removes it after launch exits.

The isolated live smoke now checks catalog session membership, exact selected
workspace/pane identity and rejection of a missing session before its existing native
stream journey. Evidence: `/tmp/gpui-catalog-live.log`. This does not claim that the
interactive terminal prompts or native selection UI have received physical QA.

## GP03 native picker — 9 October 2026

The `browse-preview.sh` launcher now opens a native session/pane sidebar using an
explicit private local-host configuration. The bounded duplex protocol carries
catalog, selected identity and complete snapshot state. Native selection clears the
frame immediately; request IDs reject old selection responses. The helper retires
and reaps the previous pane client before opening the next, reusing canonical
read-only delivery rather than duplicating the daemon protocol.

- Two-session real-daemon controller smoke passes: initial pane, rapid session
  changes, second pane, monotonic requests and unavailable state after shutdown.
- Native CUA clicks selected panes in both isolated sessions and displayed live
  terminal output. See [native picker](evidence/native-picker-macos.png). The
  fixture confirmed both selected sessions produced snapshots and cleaned up.
- Ten focused Rust adapter tests pass, including stale browser requests, replaced
  helper identities, duplicate choices and rejection of unselected frames.
- Six child-process tests pass, including duplex command/publication forwarding.
- A malformed private-config regression verifies that diagnostics do not leak JSON
  contents. TypeScript typecheck passes.
- Full Rust gates: default workspace 2,688 passed / 10 ignored; all-feature
  workspace 2,722 passed / 17 ignored; both Clippy configurations pass. Counts
  include inherited upstream tests and are not all newly authored tests.
- Original imported-file hashes still differ only for the documented entry/manifest;
  added modules are listed separately. Source-size, shell syntax and formatting
  checks pass.

Logs: `/tmp/gpui-browser-*.log`. The native fixture emitted a macOS sandbox-extension
warning for its temporary test bundle but continued to render and complete the
selection journey; this is not signed/notarized package qualification.

GP03 remains open for daemon discovery, pane close/recreate and duplicate-title
coverage, keyboard/accessibility navigation and broader layout QA. Long fixture
labels wrap visibly. Native pane labels currently expose semantic IDs. Input,
source resizing, automatic reconnect and release packaging remain separate work.
Changes are local/uncommitted/unreleased.
Optimized binaries and all 13 optimized CLI checks passed for this increment.

## Initial authenticated keyboard slice — 2026-10-09

Local, uncommitted GP04 increment on `codex/tmux-gpui-bootstrap` (base cleanup
commit `fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`). This does not complete GP04.
Browser mode now obtains an interactive pane capability and explicit input
lease. Each input requires current authority and targets the selected semantic
pane. Selection generations discard stale commands; failed or ambiguous sends
are not retried or replayed. The original live-only viewer stays read-only.

Evidence:

- Two input boundary tests pass: no send without authority; exact pane target and
  one send only after an ambiguous acknowledgement.
- Eleven focused Rust adapter tests pass, including key translation and existing
  snapshot/browser guards.
- Isolated real-daemon browser test types commands in both panes, checks exact
  output rows, and confirms stale-selection input appeared in neither pane.
  Log: `/tmp/gpui-input-smoke.log`.
- Native macOS debug window: clicked both session/pane selections, clicked the
  terminal to focus, sent individual physical key events for `echo gpui` + Enter,
  and verified the exact returned `gpui` output in the native renderer and fixture
  observer. Shutdown retired the view. Screenshot:
  `evidence/native-keyboard-macos.png`; log `/tmp/gpui-input-native-recheck.log`.
  The earlier unattended fixture expired before interaction (not a passing run).
- Workspace tests: 2,689 passed / 10 ignored with default features; 2,723 passed /
  17 ignored with all features. These totals mostly cover inherited upstream
  behavior, not additional tmux integration scenarios.
- Clippy all-targets with all-features and no-default-features passed with warnings
  denied. Optimized binaries built; 13 release CLI checks passed before the final
  help-text correction. Logs `/tmp/gpui-input-{workspace,features,clippy,minimal,release,release-cli}.log`.

Not yet qualified: clipboard paste, IME, function keys/control punctuation,
complete focus/lease-loss behavior, TUI layout alignment, resize, reconnect,
scroll/copy or installed/signed packaging. The native sandbox-extension warning
was emitted again; signing/install behavior remains a separate release gate.

Final help text now advertises basic browser keyboard input while retaining the
paste/IME/resize/reconnect limitations. `cargo fmt --all -- --check`, bridge
TypeScript typecheck and both input boundary tests passed. Rebuilt optimized CLI
checks passed again (10 inherited + 3 dedicated) after that correction:
`/tmp/gpui-input-release-cli-final.log`. No pending checks from this slice remain.

## Clipboard paste slice — 2026-10-09

Cmd-V now reads native plain text while the terminal owns focus and the selected
pane has input authority. Admission is capped at 64 KiB UTF-8; empty, NUL and
Escape-containing text is rejected. The helper freezes the verified pane's
bracketed-paste mode once, adds markers when enabled, and sends bounded 1024-code-
unit chunks without splitting Unicode scalars. Acknowledgements are awaited in
order, and authority is checked before every chunk. An interruption can leave a
prefix delivered; there is no rollback or replay. No daemon contract change.

Verified so far:

- Four TypeScript input tests, including Unicode chunk boundaries, both bracket
  modes, rejection before sending and loss of authority mid-paste.
- Twelve focused Rust adapter tests, including clipboard admission.
- Real-daemon test passes a multiline paste larger than one input message and
  verifies exact CJK/emoji output. `/tmp/gpui-paste-utf8.log`.
- Native macOS Cmd-V pastes `printf 'nativepaste界🌍\\n'` plus newline and paints
  exact output. `evidence/native-paste-macos.png`, `/tmp/gpui-paste-native.log`.

The initial Unicode test failed in the fixture's locale-less macOS `sh`: input
stopped visibly at the first Unicode character. Setting `LC_ALL=en_US.UTF-8` and
restarting that same private shell made the same native paste succeed; the
fixture now explicitly sets that locale. Failure evidence:
`/tmp/gpui-paste-smoke-repro.log`; passing rerun `/tmp/gpui-paste-utf8.log`.
No personal shells or sessions were changed.

Full Rust gates for this slice are in progress in `/tmp/gpui-paste-*.log`.
GP04 remains open for IME, full key mapping/focus/lease-loss QA and native bracketed
paste in an application that enables that mode. This is local, uncommitted and
unreleased; GP01 review and the remaining mission release gates still apply.

Paste follow-up: both Clippy configurations and full workspace suites passed
(default 2,690 / 10 ignored; all features 2,724 / 17 ignored), plus 13 optimized
CLI checks. Logs `/tmp/gpui-paste-{clippy,minimal,workspace,features,release-cli}.log`.

## Native composition and key mapping slice — 2026-10-09

Added platform text input handling: marked text is local, commits send once,
selection changes blur terminal focus and discard platform composition. Candidate
bounds and composition painting share the terminal cursor geometry. macOS Option
is reserved for native text/dead keys (Escape-prefix remains available for Meta).
F1–F12 and control punctuation map through canonical named-key/byte input.

Fourteen focused Rust adapter tests passed, including a headless GPUI test proving
marked text sends nothing, UTF-16 selection over emoji is preserved, committed
text sends once to the selected request and input after retirement is rejected.
Native macOS test reran two-session selection, ordinary keyboard and Unicode
paste successfully. Option-E visibly painted a marked accent at the cursor; E
committed `é`, then Enter produced exact `é` shell output. Screenshots:
`evidence/native-composition-marked-macos.png` and
`evidence/native-composition-commit-macos.png`; log `/tmp/gpui-ime-native.log`.

Both Clippy configurations pass. Full suite/optimized CLI reruns are currently
running under `/tmp/gpui-ime-*`. CJK conversion/candidate windows and native
composition during pane switching/focus loss remain unqualified. GP04 stays open;
this remains local, uncommitted and unreleased.

Composition follow-up: full workspace suites passed (default 2,692 / 10 ignored;
all features 2,726 / 17 ignored), both Clippy configurations and 13 optimized CLI
checks passed. `/tmp/gpui-ime-{workspace,features,clippy,minimal,release-cli}.log`.

## Initial geometry-authority slice — 2026-10-09

The browser's drawable terminal area now requests a window viewport through the
existing daemon geometry lease. The helper derives an explicit semantic window
from verified layout messages containing the selected semantic pane, checks it
again after acquiring authority, and never falls back to an implicit active
window. A conflict/failure blocks further resize attempts for that helper lifetime
and displays a status; reselecting creates a fresh connection. Painting continues
to use source frames rather than assuming a requested size was applied.

Evidence so far: three TS authority/target/bounds tests; isolated real daemon
accepted 91×27 cells and then a burst ending at 111×47. Stale requests left the
other session unchanged. Fifteen focused Rust tests passed, including fractional
cell flooring, font-size changes and rejection of minimized/invalid areas.
Logs `/tmp/gpui-resize-{unit-final,smoke,rapid,rust}.log`.

This is an initial single-pane-view integration, not GP05 completion. Full TUI
multi-pane layout alignment, native DPI/resize, competing viewers, authority-loss
recovery, redraw and manual-size-lock release still require verification. Broad
checks and independent source review are in progress.

## Resize increment — 9 October 2026

Local implementation on `codex/tmux-gpui-bootstrap`, based on cleanup commit
`fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`; this increment remains uncommitted,
unmerged and unreleased. Native drawable cell dimensions now request an explicit
verified window through daemon geometry authority. A failed resize latches until
pane reselection; UI gives that retry instruction. Rendering uses source frames.

Verified: five TypeScript geometry/authority/topology tests; bridge typecheck;
isolated real-daemon resize to 91x27 then a rapid burst ending at 111x47, with
stale selection requests leaving the unrelated session unchanged; fifteen focused
Rust tests including fractional-cell/font/minimized geometry. Native macOS window
zoom changed source tmux dimensions, alongside selection, keyboard, Unicode paste
and Option-E composition. Evidence: `apps/tmux-gpui/evidence/native-resize-macos.png`,
`/tmp/gpui-resize-native.log`, `/tmp/gpui-resize-reviewed-smoke.log`.

Independent review found that removal of the selected pane from its former window
could leave a stale resize target. The layout owner now clears that mapping;
regression tests cover move/removal and late former-window messages. Follow-up
review passed. A null window identity is also tested. Both Rust Clippy modes pass;
full workspace and optimized CLI reruns are in progress.

GP05 stays open. Background focus/presence must release geometry authority;
competing viewers, native DPI changes, redraw and manual-size release require
qualification. The final layout must follow TUI Home/session/window/pane structure;
the single-pane prototype is temporary. GP04 also remains open for IME replacement
ranges and broader CJK/candidate-window checks. No release-readiness claim.

## Partial IME replacement fix — 9 October 2026

Local, uncommitted increment on `codex/tmux-gpui-bootstrap` (base
`fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`). A headless GPUI regression reproduced
partial replacement dropping surrounding marked text: replacing the emoji in
`a🌍c` yielded `界` instead of `a界c`. The composition owner now applies UTF-16
ranges to its local marked buffer, preserves prefix/suffix, offsets selected text,
and commits the complete result once through existing focus/authority guards.
Split surrogate, out-of-buffer, reversed, NUL and oversized replacements fail
closed without terminal input. It never edits already committed terminal history.

Same regression passes after the fix; 16 focused native-adapter tests pass.
Evidence `/tmp/gpui-ime-range-repro.log` (failed),
`/tmp/gpui-ime-range-final.log` (passed). Independent source review passed.
Full Rust gates are running under `/tmp/gpui-ime-range-*`; no new native CJK or
candidate-window qualification is claimed. GP04 remains open and nothing released.

Prior resize gates completed: default workspace 2,693 passed / 10 ignored;
all features 2,727 passed / 17 ignored; both Clippy modes and 13 optimized CLI
checks passed. Those totals include inherited upstream coverage.

## Presence bridge increment — 9 October 2026

Bridge support implemented locally on `codex/tmux-gpui-bootstrap`, uncommitted and
unreleased. Native window activation is NOT connected yet; this is the next slice.
Presence commands use daemon foreground/background semantics. Background disables
input and releases this connection's input/geometry claims even if grants have
already been revoked; foreground requests input only and permits a fresh viewport.
New helpers wait for a presence command before requesting input, so a background
selection does not eagerly acquire input. No terminal commands are replayed.

Bridge typecheck and two presence unit tests pass. Isolated real-daemon browser
smoke passes background input/resize rejection, natural 80x24 size restoration,
foreground input recovery and fresh 95x30 resize, plus background pane reselection.
Logs `/tmp/gpui-presence-reviewed-smoke.log` and
`/tmp/gpui-presence-reselect-smoke.log`. Initial test expectation incorrectly
expected the old manual size to persist; source correctly restored its natural
size. That failed expectation is preserved in `/tmp/gpui-presence-smoke.log`.
Review identified a grant-revocation cleanup race and eager background input claim;
both have been corrected. Native activation, competing-viewer takeover and full
focus lifecycle still require qualification; GP05 remains open.

IME replacement follow-up gates completed: default workspace 2694 passed /10
ignored, all features2728 passed /17 ignored; both Clippy configurations passed.
Counts include inherited upstream tests. Logs `/tmp/gpui-ime-range-*`.

## Native activation connected — 9 October 2026

The native window activation subscription now feeds the presence bridge. Native
text, keyboard and resize paths are gated while inactive. A pending background
transition survives a full command queue and rapid reactivation; the existing
bounded UI poll retries it without blocking the UI or replaying terminal input.
Activation resets queued viewport deduplication so the current size is requested
after returning. Marked composition is discarded on activation changes.

Seventeen focused Rust tests pass (including queue-pressure transition ordering),
debug executable builds, and both Clippy configurations pass. Native macOS test
passes two-session selection, minimize -> authority release / natural 80x24 source
geometry -> restore -> input reacquisition and source resize. Exact fixture log:
`/tmp/gpui-native-presence-smoke.log`. Ordinary app-switch actions did not establish
an observable transition in that run; native proof is specifically minimize/restore.
Owned processes exited successfully. No production sessions were used.

Full workspace reruns and source review are still pending. Competing-viewer
qualification, normal app switching, TUI-aligned multi-pane layout and other GP05
acceptance remain open. Changes stay local/uncommitted/unreleased on
`codex/tmux-gpui-bootstrap`, based on `fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`.

## Explicit reconnect increment — 9 October 2026

Local/uncommitted on `codex/tmux-gpui-bootstrap`, base
`fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`. The same-process isolated daemon
replacement smoke reproduced Refresh retaining obsolete host credentials/scope
(`/tmp/gpui-reconnect-before.log`). Refresh now clears selection, retires its owned
pane helper, rereads the validated private host file, and replaces/disposes the
catalog client. It requires explicit selection from the fresh inventory before
opening a newly verified pane. Private connection file update is still an explicit
bootstrap step; automatic discovery is not claimed.

Same smoke passes after the fix: daemon replaced while browser remains running,
new catalog/selection, verified snapshot/input authority, new input delivered,
stale selection input rejected (`/tmp/gpui-reconnect-after.log`). Typecheck and
independent source review pass. GP06 stays open: physical restart evidence,
automatic/current discovery flow, pane recreation and further stale-frame scenarios
still require qualification. No release or merge.

Related activation review found that queued presence alone was insufficient to
invalidate stale readiness. Native commands now carry presence revisions; helper
publications echo them only after authority work completes, and native readiness
requires the matching acknowledgement. Focused17 tests and source review pass;
full Rust gates rerun under `/tmp/gpui-presence-revision-*`. Earlier native
minimize/restore passed before this revision refinement; no repeat physical proof
claimed yet.

## Window/pane presentation increment — 9 October 2026

Local/uncommitted on `codex/tmux-gpui-bootstrap` (base
`fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`). The verified layout stream now supplies
window headings and readable pane titles to the native picker. Layout metadata is
intersected with inventory pane IDs; names remain display hints and never control
selection. Null identity joins are ignored; labels remove control characters and
respect native UTF-8 byte limits without splitting Unicode scalars. Window order
is preserved on updates, and duplicate names do not merge identities.

Three topology tests, bridge typecheck,17 focused Rust tests, debug build and
independent source review pass. Real daemon smoke includes group metadata,
selection, background/reselection, daemon replacement and stale-input rejection
(`/tmp/gpui-topology-smoke-final.log`). Native selection displays a window header
and pane title; screenshot `apps/tmux-gpui/evidence/native-window-pane-labels-macos.png`.
The current revision also physically passes minimize -> natural geometry restore
-> reopen -> input/geometry reacquisition (`/tmp/gpui-topology-native.log`). Both
Clippy modes pass; full suites running under `/tmp/gpui-topology-*`.

GP03 remains open. Before initial stream layout arrives, IDs remain the fallback.
Metadata can be cached during same-session reselection/unavailability; new panes
require inventory refresh. Automatic discovery and the final TUI-aligned window
strip/multi-pane canvas remain unfinished. This is still a temporary single-pane
picker, not full layout parity or a release.

User approval to reuse upstream integrations, including GitHub/VS Code, is recorded
in INTEGRATION.md. Source reuse is authorized; those integrations are not yet wired
or qualified for tmux-ide.

## Multi-pane stream foundation — 9 October 2026

The helper accepts an explicit optional `visiblePaneIds` subscription (1–24 unique
IDs, containing the selected pane) and retains one canonical validated replica
per pane on the same connection. Input/paste and geometry stay bound to the
selected identity. Each pane has independent negotiation/assembly/ACK state;
invalid delivery retires the connection, and disconnect clears all surfaces.
Interactive publications add history-stripped surfaces. The 8 MiB publication
limit is preserved; it is not a claim about total canonical-history memory.

New isolated `bridge/multipane-smoke.mjs` splits one owned tmux window, observes
two distinct seeds, verifies one pane's update leaves its sibling unchanged, and
checks all surfaces clear on daemon stop. Passed `/tmp/gpui-multipane-smoke.log`.
Bridge typecheck, four replica regression tests, read-only single-pane live smoke
and browser lifecycle/restart smoke pass (`/tmp/gpui-multipane-*.log`). Independent
source review passed. Previous topology full Rust gates also completed.

This is transport groundwork: normal catalog subscriptions and native canvas
still select/render one pane. Next wire the window's pane set and render its
authoritative tmux layout; do not equate this with TUI layout parity. No card closed,
commit, merge or release. Work remains local on `codex/tmux-gpui-bootstrap`, base
`fc3b7869c3cd1699fe5c82fcdab09aae18f5141f`.

## Resize/input ordering and remaining startup issue — 9 October 2026

The original browser lost established input readiness during layout/surface resize
skew. The new actual-daemon regression failed before the fix, then passed after
atomic presentation retention and generation/incarnation invalidation were added.
The bridge gate passed 51 tests with two app-only skips. Both explicit packaged-app
tests subsequently passed. Pane replacement passed including stale-input rejection.
Independent review found no remaining scoped source blocker in that resize fix.

Evidence and exact bridge source hashes are preserved in
`evidence/resize-input-2026-10-09/`. These are uncommitted working-tree results on
`codex/tmux-gpui-bootstrap`, not a release receipt.

The updated native bundle passed window routing and quit/source preservation,
but its first input attempt during initial authority acquisition lost `echo `
and executed only `WINDOW_ONE_OK`. Repeating after Keyboard ready succeeded;
therefore the native harness success includes recovery, not lossless initial
input. Screenshot: `evidence/native-resize-fix-initial-authority-macos.png`.
Startup gesture admission remains open and requires its own failure-to-pass proof.
Signing still has zero valid local identities; installer/update and release remain
unqualified. GP04 and the broader mission stay open.

A focused independent asset audit found no concrete missing notice for the dedicated
terminal entry. The assembler additionally preserves `GITHUB-NOTICE.md`, referenced
by upstream's root NOTICE, even though the GitHub integration is not enabled here.
Fresh assembly and both packaged-artifact tests pass; logs are retained alongside
the resize evidence. This attribution check does not qualify signing, source
provenance or a release, and the notice-only app uses the prior native binary.

## Input interruption guard — 9 October 2026

Baseline actual SnapshotView regression admitted a command suffix after rejecting
its prefix during readiness acquisition. The native owner now requires a fresh
ready click after interrupted input (including saturated input queue failure).
No discarded bytes are replayed. Independent review approved; 34 focused tests,
both full Clippy/workspace-test modes, format/size checks, optimized build and three
release CLI tests pass. Existing opt-in upstream tests remain ignored.

A diagnostic fixture held native readiness publications from a real isolated
daemon, then released readiness while offering a suffix without a new click.
The old optimized binary executed `WINDOW_ONE_OK` as an unknown command and failed
the unchanged-source assertion. The new binary kept source unchanged, then accepted
exact full input after a ready click; Cmd-Q preserved source and reaped helpers.
Both runs' artifact hashes, actions, screenshots, logs and cleanup receipts are in
`evidence/input-interruption-2026-10-09/`. This proves native admission with a
test-only readiness override, not actual daemon handshake timing or app-launcher
qualification. The packaged-artifact tests also pass for the new bundle.

All work remains uncommitted/unmerged/unreleased. Broader IME, UI, signing and
installer qualification remain open; this does not close GP04 or the mission.

## Pane selection package verification — 2026-10-09

The selected-pane label and separator accents passed the complete Rust gate
(format, file size, both Clippy configurations, both workspace suites, release
build and three release executable checks). The fresh local package passed
both artifact checks. An actual native run verified distinct left/right command
targets, title changes, separator placement and source survival after Cmd-Q.
Screenshots, package hashes and logs are in `evidence/pane-selection-2026-10-09/`.

The first current-package run painted a frame but remained waiting for input
authority; it was intentionally closed before typing. The old package control
and unchanged new-package repeat passed. This is an unresolved intermittent
readiness observation, not a fixed bug or evidence that chrome caused it. A
payload-free diagnostic bundle is prepared outside the package for investigation.
Narrow/crowded layouts and full TUI alignment remain unqualified; GP03 stays open.
All changes remain uncommitted, unmerged and unreleased.

## Activation trace and clearer inactive status — 2026-10-09

A diagnostic copy reproduced a painted pane while waiting. The trace proved
background presence (revision 1, no input grant). Two macOS Cmd-Tab transitions
activated the same live helper: revision 2, grant accepted, input ready. Both
pane commands then passed and Cmd-Q preserved the sources. This is recovery
in the same running client, not a restart. The original uninstrumented attempt
has no equivalent trace and remains inconclusive. Diagnostic evidence is in
`evidence/pane-selection-2026-10-09/authority-physical-trace.log` and
`activation-actions.json`. No authority override or production sessions were used.

The bridge now says “Window inactive — activate tmux-ide to type” for this
background state. The same isolated browser journey failed before and passed
after the status-only patch; input admission is unchanged. Independent review
approved. Typecheck and deterministic bridge checks passed (56 passed, 2
artifact-dependent skips). Evidence: `evidence/activation-status-2026-10-09/`.
Native screenshot of the new wording remains pending; GP03 stays open.
Uncommitted, unmerged and unreleased.

Final non-diagnostic activation-status package proof: explicit inactive message was
visually verified, macOS activation restored readiness in the same app, both exact
pane targets passed, and Cmd-Q preserved sources. See
`evidence/activation-status-2026-10-09/native-package.log` and native screenshots.
An attempted corner drag did not resize the window; it does not qualify narrow layout.

## GP10 transaction foundation — 2026-10-09

Implemented internal install-transaction.mjs and ten isolated temporary-prefix
tests. The module requires a verifier callback to approve the copied candidate,
then atomically switches a relative current symlink while retaining prior versions.
Rollback re-verifies its target; uninstall detaches only, preserving stored versions
and unrelated configuration. Cooperative mutation locking and path/ownership checks
reject conflicting or uncertain operations. Independent review approved after fixes
to preserve both original/cleanup errors and reject replaced parent directories.

Expanded existing preview gate includes these tests: typecheck and 68 tests passed,
zero failures/skips, with explicit local app for artifact checks. Format and diff
checks passed. Evidence and exact source hashes: apps/tmux-gpui/evidence/
install-foundation-2026-10-09/receipt.json and checks.log. No commit exists; work
remains uncommitted/unmerged/unreleased.

This does NOT complete GP10. No signature trust policy, public download/entry flow,
architecture/macOS/daemon compatibility gate, signed install, crash/power-loss or
stale-lock recovery is qualified. Only ordinary-file bundles are supported; framework
symlinks are rejected. Injected errors are not abrupt-termination proof. No production
installation or process termination was performed. GP09 signing prerequisite remains:
security find-identity still reports zero valid signing identities on this host.

## Canonical daemon compatibility increment — 2026-10-09

Local discovery now applies the shared wire-protocol compatibility predicate after
its credential-free identity probe and before authenticated catalog access. The
old/future protocol regression failed before (two requests instead of one) and
passes after. A typed error exposes only validated protocol numbers and fixed
recovery guidance; arbitrary private configuration/parser errors remain redacted.
The browser stays open for Refresh. A real helper plus loopback boundary peer test
verifies credential-free rejection, safe status and same-process compatibility
rechecking; the synthetic compatible peer intentionally refuses catalog access.
It is not a historical-daemon or successful terminal-recovery claim.

Independent review approved. Full gate: typecheck and 68 passed/2 artifact skips
out of 70 tests. A separate real isolated daemon journey using --local discovery
also passed session selection, input, resize, foreground handling and stale-input
checks. Exact hashes/logs: apps/tmux-gpui/evidence/compatibility-2026-10-09/.

Explicit private-host compatibility and installer-level compatibility gates remain
open; the new message has not yet been physically verified in a rebuilt app.
No automatic daemon update/restart, merge, commit or release occurred. GP10 remains
open for the full signed install/update entry flow and other stated acceptance.

## Process-interruption qualification increment — 2026-10-09

Added install-interruption.test.mjs with real creation-owned child processes and
coordinated SIGKILL. Before activation: the old complete version remains selected,
the candidate/lock remain, and a subsequent install fails closed before verification.
After installApp completes: the new version remains complete, the prior version
remains available, and verified rollback succeeds. Both tests explicitly reap the
owned child before removing their private temporary prefixes. Independent review
approved; no transaction implementation change was needed.

Focused 2/2 pass; expanded gate typecheck and 72/72 tests pass with zero skips,
including artifact checks against the preceding Activation Status development app.
The latter is not a newly packaged compatibility-message qualification. Exact
hashes/logs/scope: apps/tmux-gpui/evidence/install-interruption-2026-10-09/.

This proves two declared process-interruption boundaries, not power loss or the
gap between candidate rename and pointer activation. Automatic stale-lock recovery
and the signed public installer remain unfinished. GP10 stays open. No production
install, commit, merge or release.

## Combined local preview — 2026-10-09

Assembled `/tmp/Tmux IDE Preview.app` with the latest compatibility guard,
inactive-window status and pane-selection native build. Typecheck and 72/72
checks passed with zero skips against this exact app. Its bundled browser passed
the real isolated canonical-daemon smoke (two sessions, switching, input/resize
and stale/background rejection). Hashes and logs are in
`evidence/combined-preview-2026-10-09/`.

The final native attempt is incomplete: the picker was visible, but CUA clicks
failed with `noWindowsAvailable`, including after rebinding. No input was sent.
The owned launcher was terminated and the fixture exited 1 through its cleanup.
This does not qualify native input on the combined package; prior native passes
remain evidence only for their recorded packages. No production launch, commit,
merge or release. Distribution/signing/install qualification remains open.

## macOS installer verification component — 2026-10-09

`scripts/mac-app-verifier.mjs` now composes with the transaction verifier callback,
including extensionless staged copies. It requires caller-supplied trusted Apple
team, bundle identity, architecture and minimum macOS policy. Bounded absolute
system tools check Developer ID Application signatures (including native and Node
explicitly), enabled Gatekeeper assessment, bundle metadata, architecture and
actual Mach-O deployment minima. It never executes candidate binaries. The
transaction still protects copied-payload integrity around the callback.

Independent review approved. Typecheck and 78/78 checks pass, zero skips, including
6 verifier tests with injected tool responses and real transaction composition.
The actual unsigned Preview.app is rejected by codesign. The initial requirement
syntax failure and final expected denial are both retained in
`evidence/mac-app-verifier-2026-10-09/`. Positive signed verification is unproven.

No release signing identity is present on this host. Public entry/download flow,
trusted publisher policy, signed candidate, notarization, clean-machine and other
GP09/GP10 acceptance remain open. This change does not install or launch an app,
change production, commit or release.

## Local staged-app installer CLI — 2026-10-09

Added scripts/install-cli.mjs: explicit-prefix install/update, rollback and
detach/uninstall, composing the transaction core with real macOS verification.
Trusted policy is bounded, validated and separate from candidate/install storage.
There are no signature-bypass CLI flags, production defaults, downloads, launches
or process stops. Detach explicitly retains versions. Parent path aliases resolve
while a symlinked managed root is rejected. Policy FIFOs are opened nonblocking
and rejected, so a malformed policy cannot hang waiting for a writer.

Typecheck and 85/85 full checks passed, zero skips. A subsequent test-only change
made alias coverage explicit; final focused suite passes 7/7 with unchanged runtime.
The real executable CLI rejected a copied unsigned Preview.app, leaving no current
pointer, candidate or lock. Successful lifecycle controls use synthetic apps and
a test-injected verifier; no signed positive install is claimed. Evidence and
source hashes: apps/tmux-gpui/evidence/install-cli-2026-10-09/.

GP10 remains open for the public download/bootstrap flow, trusted release policy,
signed-positive qualification, interruption recovery, owned-helper handling and
other acceptance. No production mutation, commit, merge or release.

## Native build receipt and fresh package — 2026-10-09

The native build wrapper now records before/after hashes of 1,266 declared Rust
workspace inputs (including assets), compiler identities, Git build identity and
the exact executable reported by Cargo. Missing/ambiguous artifacts and changed
sources/binaries are rejected. The assembler requires the receipt before running
the supplied native binary, validates the copied payload and rechecks after
assembly. README and artifact tests use the new required receipt argument.

Independent review found and fixed a stale-output-path hazard: Cargo configuration
can move its output, so guessing target/release could bind an old binary. The
wrapper selects the exact successful Cargo artifact. The first real build then
failed because child compilation resolved through a Rustup shim; binding the
actual compiler via RUSTC and toolchain PATH fixed the same build path. The failed
log is preserved; no receipt was produced by that failed run.

Fresh app: `/tmp/Tmux IDE Provenance Preview.app`. Native SHA256:
`d29373cbfbf65221207bc563c499868de9bad25deebb781f4b8a2cc965b1b1c6`.
Source snapshot SHA256:
`96e9a14835d2993f2eba9bcee9ff9a9f07974a5fa1593a23257b16a65780a95a`.

Validation: typecheck and 89 headless checks passed (3 packaged checks skipped
there); all 3 explicit packaged checks then passed against the fresh app, including
rejecting a mismatched executable before it runs. The bundled client passed the
real isolated canonical-daemon/two-session smoke. All 3 optimized native CLI tests
passed. Independent boundary_review approved the implementation. Exact code hashes,
receipts and logs: `apps/tmux-gpui/evidence/native-build-receipt-2026-10-09/`.

This establishes local cached-build/source consistency, not a hermetic build,
trusted commit attestation or signed provenance. Compiler dependency caches and
the SDK remain outside that claim; interrupted compiler descendant cleanup is not
qualified. Physical UI on this fresh package, signed/notarized/clean-machine
qualification, public install/update and release remain open. All work is still
uncommitted/unmerged/unreleased; GP09 stays open. Production was untouched.

## Native shell adaptation — 2026-10-09

The browser now reuses Herdr's native titlebar/frame and pure theme/font defaults,
with compact rounded navigation and truncated labels. Terminal rendering,
selection IDs and input handlers retain their existing authority boundaries.
The minimum browser window is 640×400; the header sits outside canvas bounds.

Focused checks: 43/43 pass, including two new shell tests. Independent source
review found no scoped macOS blocker. The layout fixture is synthetic: it does
not qualify actual long labels, wrapped recovery status, physical titlebar drag,
close or the native appearance. Full gates passed: format, file size, both Clippy configurations, and workspace
default/all-feature tests. This evidence binds the recorded first-slice hashes.
Evidence: `evidence/native-shell-2026-10-09/`. No full Herdr or Liquid Glass
parity, commit, merge or release is claimed.

### Actual browser narrow-layout regression

The real SnapshotView fixture exposed a failure missed by the synthetic shell
test. At 640×400, a long selected title left the interrupted-input status 148px
wide. It wrapped to 370.5px tall and reduced the canvas to 416×0 at y=464, below
the visible body. Numeric bounds and the failing test are retained.

The title now has its own compact row; the full-width status retains all text
in a maximum-96px scroll viewport with recovery guidance first. The same narrow
fixture (plus long recovery and wide controls) passes, including original canvas
containment and a five-row usability floor. All 44 focused checks pass, and
independent review found no source blocker. Final full gates and the receipt-bound optimized build pass;
physical scrolling and appearance remain unverified. Evidence and final hashes:
`evidence/native-shell-2026-10-09/narrow-layout-receipt.json`.

### Native shell package check

Fresh `/tmp/Tmux IDE Native Shell.app` passes three artifact checks and three
optimized CLI checks. For automation isolation only, its Info.plist bundle ID
was changed after assembly to `com.tmux-ide.gpui.shell-verification-20261009`;
the original/current plist and binary receipt are retained. The physical
fixture passed distinct left/right command routing, selected labels and native
close-button source preservation. Screenshots show the actual new chrome.

First session-open failed, then Refresh and the same selection succeeded; this
intermittent failure is unexplained and remains open. Corner dragging did not
resize the window, so narrow physical behavior is still unqualified. After close,
a CUA state read unexpectedly relaunched the temporary app outside the fixture;
its exact new launcher was terminated and all three observed processes exited.
No typing/session mutation was performed in that instance; older apps were left
untouched. Do not make post-close CUA observations.

Evidence: `evidence/native-shell-2026-10-09/native-receipt.json`, native screenshots
and logs. This does not qualify full Herdr parity, status scrolling, signing or
release. All implementation remains uncommitted/unmerged/unreleased.

## Catalog failure diagnostics — 2026-10-09

Session listing/revalidation, opening, inventory and connection validation now
report fixed stage/reason labels and validated numeric HTTP status. Raw messages,
response data and causes do not cross into the UI. No retry, readiness or
authority behavior changed; the intermittent initial-open cause remains unknown.

Eleven focused checks, typecheck and format pass. Full bridge gate: 93 pass,
3 package-dependent skips. Real isolated two-session source-browser journey
passes. Independent review found no source blocker. The initial new fixture
failed because its pane IDs were unsorted; only that fixture was corrected,
without loosening inventory validation. Exact hashes/logs and limits:
`evidence/catalog-diagnostics-2026-10-09/`. Running test app is unchanged and
does not include these new diagnostics. Uncommitted/unmerged/unreleased.

The fresh `/tmp/Tmux IDE Catalog Preview.app` now contains the safe diagnostics.
Assembly, all three explicit artifact checks and real bundled two-session
discovery/switching checks pass. The existing real-daemon pane-replacement
fixture also passes current source: removal retires the old identity, stale
input is rejected even with a current request, and the same browser recovers
with fresh selection. No duplicate fixture was added. Logs and package hashes:
`evidence/catalog-diagnostics-2026-10-09/package-receipt.json`.
Native interaction with this package and physical pane-recreation remain open;
the human's previous test app was left untouched.

## Remaining preview gates — 2026-10-10 checkpoint

Source checkpoint: `4876fa44`. CI run `38080028723` has passed Linux;
macOS remains in progress at this checkpoint. Earlier entries below and above
retain their original chronological scope.

| Gate                        | Current evidence                                                                                                                                                                                                                                                   | Still required                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native shell and pane input | Native routing/close, active-window opening, right/down splits and sidebar counts; physical bracketed Unicode paste (`session-open-active-2026-10-10`, `split-session-count-2026-10-10`, `native-paste-current-2026-10-10`)                                        | Broader IME composition/focus attribution, crowded/narrow status-scroll acceptance; corrected Unicode/soft-wrap native clipboard proof remains unqualified (`copy-wrap-2026-10-10`)                                                                                                                                                          |
| Geometry                    | Source and exact-packaged helper controller handoff and background/close geometry restoration; canonical continuous-divider source journey (`competing-viewers-2026-10-10`, `canonical-continuous-drag-2026-10-10`)                                                | Physical continuous-divider completion (`physical-continuous-resize-2026-10-10` records an inactive-window attempt, not a pass), simultaneous geometry-claim denial, native-client competition and display scales                                                                                                                            |
| Recovery                    | Physical pane-recreation recovery, repaired ordered stale-input packaged check, deterministic stale mailbox/EOF checks and source/packaged daemon replacement (`native-pane-recovery-2026-10-10`, `native-mailbox-2026-10-10`, `discovery-replacement-2026-10-10`) | Long-label Home admission HTTP 503 fixed and API verified (`session-name-whitespace-2026-10-10`); native opens the session but automatic pane selection remains unqualified. Revised pane-replacement negative fixture physical rerun; delayed IME attribution across selection/focus transitions. Automatic reconnect is not a prerequisite |
| Rendering                   | Current native Unicode/style/wrap/cursor specimen observed at one size/theme/scale (`native-visual-current-2026-10-10`)                                                                                                                                            | Remaining display scales and representative TUI/GPUI normal/narrow comparison; no complete visual matrix claim                                                                                                                                                                                                                               |
| CI                          | Hosted Linux success for run `38080028723`; macOS in progress; local Rust/bridge/package gates recorded                                                                                                                                                            | Complete hosted macOS packaging result and reviewed release-source CI; earlier offline-metadata failure is not a packaging pass                                                                                                                                                                                                              |
| Distribution                | Receipt-bound development app, artifact checks, authenticated download/extraction and install/update/rollback/recovery components                                                                                                                                  | Trusted Apple signing identity, signed/notarized artifact, clean-machine install/update/rollback and public download verification                                                                                                                                                                                                            |
| Release                     | Reviewed source checkpoints and scoped evidence are committed through `4876fa44`                                                                                                                                                                                   | Current-main integration check, impacted terminal release gates and published preview receipt; no public-release claim                                                                                                                                                                                                                       |

Evidence directory names above are relative to `evidence/`. These scoped passes
do not establish full TUI parity or close all GP01–GP11 acceptance requirements.

The human's Selection Trace app remains open for testing. Its fixture watchdog
is stopped; see `evidence/selection-trace-2026-10-09/receipt.json` for exact
owned-process cleanup. Do not treat that session as an automated completion.

## Repeatable visual specimen — 2026-10-09

Reviewed synthetic screen covers Unicode, palette/RGB, styled blank cells,
right-margin wrapping and a visible cursor. The isolated real-tmux preparation
passes exact source rows, wrapping and cursor checks, including a run with bogus
inherited socket selectors. Fixture routing scrubs ambient tmux selectors.
Full bridge gate: 95 pass, 0 failures, 3 explicit-artifact skips.
Evidence: `evidence/native-visual-fixture-2026-10-09/`.

Run preparation with a new absolute evidence directory:

```bash
TMUX_GPUI_VISUAL_DIR=/tmp/gpui-visual-new \
  node --import tsx apps/tmux-gpui/bridge/native-visual-smoke.mjs --prepare-only
```

For native inspection, omit `--prepare-only` and set `TMUX_GPUI_TEST_APP` to
an explicit qualified app. Select the synthetic pane, request source capture
with `capture.request` in the evidence directory, record a screenshot separately,
and close within the fixture's three-minute deadline. Use an isolated desktop
testing window; do not share this timed fixture with a human test session.

No GUI was launched for this checkpoint. This is one specimen (minimum64×20
terminal cells), not full GP08 acceptance; native fonts/pixels, display scales
and narrower geometry remain unqualified. Work is uncommitted/unreleased.

## Absolute installer destination — 2026-10-09

Reproduced a mismatch with the documented explicit absolute destination: a relative
`--prefix` could detach an existing disposable installation. The shared CLI parser
now rejects it before filesystem access. The regression failed before the fix
(7 pass/1 fail); afterward all8 installer tests pass, including preserved current
on refusal and successful explicit absolute detach. Bridge gate96pass,0fail,
3explicit-artifact skips; independent review approved. Evidence and exact hashes:
`apps/tmux-gpui/evidence/install-absolute-prefix-2026-10-09/`.

Uncommitted/unmerged/unreleased on codex/tmux-gpui-bootstrap, base
fc3b7869c3cd1699fe5c82fcdab09aae18f5141f. This does not qualify signed installs or
the public bootstrap; GP10 remains open. No user installation or GUI was changed.

## Packaged history journey — 9 October 2026

Existing history fixture now optionally runs the explicit app's bundled Node and
live helper under private cwd/minimal PATH, scrubbing ambient tmux selectors and
Node hooks before private fixture setup. Both source mode and current Catalog
Preview packaged mode pass: independent pane updates, anchored history during
new output, blocked historical input, and cleared surfaces after disconnect.
Independent review approved; exact hashes/logs in
`apps/tmux-gpui/evidence/packaged-history-2026-10-09/`.

No GUI launched. This qualifies the packaged helper history path, not native
clipboard/mouse/rendering or launcher behavior. GP07 remains open for remaining
physical checks. Uncommitted/unmerged/unreleased, base
fc3b7869c3cd1699fe5c82fcdab09aae18f5141f on codex/tmux-gpui-bootstrap.

## Preview release authentication — 9 October 2026

Adapted Herdr's exact-byte Ed25519 authentication pattern into the tmux-owned
`preview-release-manifest.mjs` component. It creates bounded manifest bytes and
verifies a detached signature using an independently supplied raw public key
before parsing JSON, then checks the expected version and exact arm64 asset
name, size and digest schema. No Herdr endpoint or key is inherited.
Five focused checks cover valid signatures, tampering, wrong keys, malformed
authenticated data and bounds. Full bridge gate:101pass,0fail,3artifact skips.
Exact source hashes/logs: `apps/tmux-gpui/evidence/release-manifest-2026-10-09/`.

This component has no network or installer side effects. It does not establish
publisher trust or version ordering. Download/hash enforcement, bounded archive
extraction, authenticated-version-to-bundle binding, verifier/transaction wiring
and public bootstrap remain unimplemented. Host signing inspection again found
zero valid identities. Test keys are ephemeral and are not release credentials.
GP10 remains open. Work is uncommitted/unmerged/unreleased on
codex/tmux-gpui-bootstrap, base fc3b7869c3cd1699fe5c82fcdab09aae18f5141f.

## Authenticated archive staging — 9 October 2026

`preview-release-download.mjs` authenticates the manifest before network/filesystem
operations, enforces HTTPS and explicitly trusted redirect origins (including
signed redirect queries), and streams into an owned private temporary directory.
Signed byte count and SHA256 must match exactly. Caller abort and a120-second
network deadline bound headers/body; failures remove only owned partial staging
and preserve unrelated files. Successful staging cleanup belongs to the caller.

Seven focused tests pass, including a real owned loopback transfer through an
injected test transport, malformed/truncated/oversized data, redirect policy,
stalled transfers and cancellation. Full bridge gate108pass,0fail,3explicit-app
skips; independent reviewer approved frozen files. Evidence and exact hashes:
`apps/tmux-gpui/evidence/release-download-2026-10-09/`.

No public HTTPS/TLS or publisher-key qualification is claimed. Extraction,
app-version binding, Apple verification/transaction wiring and public bootstrap
remain incomplete. No app/daemon launched or user installation changed. GP10
remains open; uncommitted/unmerged/unreleased on codex/tmux-gpui-bootstrap, base
fc3b7869c3cd1699fe5c82fcdab09aae18f5141f.

## Authenticated strict archive extraction — 9 October 2026

`preview-release-extract.mjs` verifies the manifest and complete compressed
size/SHA256 before creating an extraction tree, then rechecks the stream and
file identity. Strict USTAR header/checksum/path/type checks accept explicit
TmuxIDE.app directories and regular files only. Limits cover total expanded
bytes, entries and streaming time; failed/cancelled extraction removes only its
owned staging tree. Successful staging cleanup belongs to the caller.

Five focused tests use real system-tar archives and cover malformed headers,
links, paths, aliases, truncation and cancellation after partial file writes.
Real44,861,047-byte archive from Catalog Preview.app round-trips all21 files
with identical bytes/executable flags. Full bridge gate113pass,0fail,3artifact
skips. Exact hashes, logs and actual-bundle control:
`apps/tmux-gpui/evidence/release-extract-2026-10-09/`.

Format restrictions are deliberate: printable-ASCII case-unambiguous internal
paths, explicit parent directories, no links or GNU/PAX extensions. This does
not restrict terminal text/Unicode. Packaging must use this tested USTAR subset.
The actual bundle was unsigned and authenticated with an ephemeral test key only.
Nothing was executed or installed. Apple verification, bundle-release binding,
transaction wiring and public entry remain incomplete; GP10 stays open. Work is
uncommitted/unmerged/unreleased on codex/tmux-gpui-bootstrap, base
fc3b7869c3cd1699fe5c82fcdab09aae18f5141f.

## Composed release installation — 9 October 2026

`preview-release-install.mjs` now connects authenticated download, strict archive
extraction and the existing atomic installation transaction. Production defaults
use the real macOS verifier on the transaction's copied app. Its optional
expectedVersion check binds CFBundleShortVersionString after signature verification.
Caller policy/bytes/paths are captured before asynchronous work; cancellation is
checked before/after verification and before activation. Owned staging is cleaned
on success/failure, and cleanup failure after activation explicitly reports that
the new version is active, without claiming rollback.

Thirteen focused tests pass (synthetic successful verifier, copy/version checks,
clean/repeat/upgrade, denial/current preservation, cancellation, caller mutation,
and combined cleanup failures). Real44,861,047-byte unsigned app traversed the
composed path with the DEFAULT macOS verifier: codesign rejected it, prior
synthetic installation remained active, staging was empty. No candidate was run.
Full bridge gate120pass,0fail,3explicit-app skips. Independent review approved
frozen files. Exact hashes/logs/control:
`apps/tmux-gpui/evidence/release-install-2026-10-09/`.

Successful signed installation remains unqualified; positive tests inject the
verifier, and the real negative uses ephemeral manifest trust/fake Apple policy.
No public HTTPS endpoint, publisher key provisioning or user-facing installer
entry is supplied here. GP10 remains open. Work is uncommitted/unmerged/unreleased
on codex/tmux-gpui-bootstrap, base fc3b7869c3cd1699fe5c82fcdab09aae18f5141f.

## One installer command: authenticated release mode — 9 October 2026

Existing install-cli now supports install/update without --app, using explicit
--version, --prefix and a trusted release-policy JSON. Existing local-app and
rollback policies remain supported. Release policy adds releasePublicKey,
releaseBaseUrl and redirectOrigins to the four Apple fields. Bounded HTTPS
metadata fetch authenticates the exact version before creating installation
staging or accepting an archive. There are no CLI verification-bypass flags.

Release-mode SIGINT/SIGTERM aborts the operation and awaits owned cleanup;
structured errors preserve confirmed/unknown activation state and never imply
rollback after completed activation. Unknown leftover staging is retained.
Sixteen focused checks pass; full bridge128pass,0fail,3explicit-app skips.
Independent review approved. The actual CLI (no dependency injection) fetched
the real44.9MB unsigned app through an owned HTTPS endpoint with a CA trusted
only by its child process: default verification denied it and the old synthetic
installation remained active. Actual SIGINT during stalled metadata produced
cancelled JSON/exit1 and clean staging. No GUI/native candidate was launched.
Evidence: `apps/tmux-gpui/evidence/release-cli-2026-10-09/`.

This command is not published and has no default publisher key or live endpoint.
It uses an explicit pinned version, not automatic latest/version ordering.
Successful Apple-signed installation, a stable installed .app entry and physical
launch remain unqualified. Audit confirmed only an extensionless internal app
and current symlink presently exist; INTEGRATION.md records the next launch-entry
work. GP10 remains open. Uncommitted/unmerged/unreleased on
codex/tmux-gpui-bootstrap, base fc3b7869c3cd1699fe5c82fcdab09aae18f5141f.

## Stable installed application entry — 9 October 2026

New versions retain TmuxIDE.app; the stable prefix/TmuxIDE.app alias points through
atomically switched current. Legacy extensionless records remain readable.
Install, repeat, update and rollback return launchPath; detach preserves versions
and configuration. Foreign entries are refused. Review caught a repeat-install
preactivation guard bypass, now fixed with a same-path refusal regression and
post-hook identity/owner/digest checks. Independent review approved frozen source
66682a1adfbd97bcecb95a77d1f7dd53c1b5e9b9b4bb7145e1f5447e9784fd5d.

41 focused tests pass. Initial broad gate caught the stale extensionless-path
verifier assertion (preserved failed evidence); corrected final gate132pass,
0fail,3explicit-app skips. Foundation recognizes the actual development bundle
through stable and versioned paths after install/update/rollback (loaded:false).
Detach removes both launch links while retaining versions. This positive
filesystem check injects a development verifier; it is not signed qualification.
Actual CLI HTTPS unsigned rejection and SIGINT cleanup pass again with the new
layout, preserving prior synthetic installation; no GUI/candidate was launched.

Evidence: apps/tmux-gpui/evidence/stable-launch-2026-10-09/ (exact hashes, failed
and passing gate logs, focused log, Foundation control/receipts, actual CLI TLS
control/receipt). Physical Finder/LaunchServices launch, signed positive install,
publisher key/endpoint provisioning and clean-machine acceptance remain pending.
GP10 stays open. Uncommitted/unmerged/unreleased on codex/tmux-gpui-bootstrap,
base fc3b7869c3cd1699fe5c82fcdab09aae18f5141f. User testing window untouched.

## Deterministic release archive producer — 9 October 2026

Added preview-release-package.py and its consumer-roundtrip tests, adapting
penso/herdr-gpui scripts/update-manifest.py at
302700e1486977092e4a9165bc083ecdc9236227 (Apache-2.0; upstream/LICENSE and NOTICE).
Sorted USTAR entries and fixed gzip metadata match our stricter regular-file/
directory-only extractor: named TmuxIDE.app root, explicit parents, printable
ASCII paths, no case aliases/links/special modes, bounded entries and compressed/
expanded bytes including headers. Output is exclusive and outside the input;
failed cleanup only removes its owned inode. Source must remain quiescent.

Independent review approved exact source
27bb80ca9f0faa60bd8e7f3c1dc290e740441ec483561dc594d9f9584c7e0d06.
Four focused tests pass; full headless gate136pass,0fail,3explicit-app skips.
The real development app packaged twice to identical44,676,021-byte archives,
SHA256723a1d1e92992bb5bbb9c101e5f61736cbab7c40d3d91e9e641a5c650431652c.
Authenticated extraction with an ephemeral key restored all21 files' contents
and executable flags; source unchanged.26 total entries. No app launched or
installed. Cross-runtime compressed-byte reproducibility not qualified.
Evidence: apps/tmux-gpui/evidence/release-package-2026-10-09/ (source hashes,
focused/full logs, real control and receipt).

GP09 remains open: assembler still has explicit development identity/version
0.0.0/build0, so release metadata must be assembled before signing. Packaging an
arbitrary version label does not satisfy expectedVersion verification. Fresh
security find-identity reports0 valid signing identities. Publisher trust policy,
endpoint, signing/notarization, clean-machine/native launch and public release
remain required. Work uncommitted/unmerged/unreleased on codex/tmux-gpui-bootstrap,
basefc3b7869c3cd1699fe5c82fcdab09aae18f5141f. Human test window untouched.

## Explicit pre-signing bundle metadata — 9 October 2026

Assembler now accepts optional trailing --metadata JSON_FILE with exact bounded
bundleId/version/buildNumber strings. It validates before supplied binaries run
or output creation. Explicit mode writes the requested plist metadata and an
assembly-manifest.json with distribution:false/signing:not-qualified; default
development identity/plist/manifest remain unchanged. No signing bypass or
post-signing bundle rewrite. Independent review approved frozen files.

Three focused tests pass. Fresh /tmp/Tmux IDE Presigning Metadata.app assembly
passed with TEST identity com.tmux-ide.gpui.preview/version0.1.0/build1 (not an
announced release). All3 explicit artifact tests pass, including actual plist
fields, source/binary receipts, notices and overwrite refusal. All3 default
artifact tests also pass on the existing Catalog Preview bundle. Full headless
gate139pass,0fail,3explicit-app skips. Foundation reads the test identity/version
with loaded:false. No GUI opened; user's Selection Trace remains untouched.
Evidence: apps/tmux-gpui/evidence/bundle-metadata-2026-10-09/ (exact source hashes,
focused/artifact/full logs, local test metadata and Foundation receipt).

Actual publisher identity/version choice, signing/notarization, trust policy,
endpoint, clean-machine/physical qualification and public release remain open.
This only prepares metadata before signing. GP09 remains open; uncommitted,
unmerged, unreleased on codex/tmux-gpui-bootstrap, base
fc3b7869c3cd1699fe5c82fcdab09aae18f5141f.

## Herdr-based native switcher — 9 October 2026

Implemented Switch… / Cmd+K using the existing Herdr SearchInput entity and
nucleo fuzzy matching for current daemon session and pane IDs.32 bounded results
scroll in the existing navigation area; input has an opt-in1024 UTF-8-byte limit.
Default SearchInput users remain unchanged. Enter/Escape/CmdK respect composition;
selection revalidates IDs/request against current catalog. Picker text/paste and
stale terminal callbacks cannot send terminal input; delayed terminal AppKit
composition discard rechecks picker ownership before touching the OS context.
Interruption latch is preserved. Catalog retirement/disconnect invalidates picker.
No inherited Herdr RPC, direct tmux commands or new backend API.

Independent review approved final11file hashes in
apps/tmux-gpui/evidence/native-switcher-2026-10-09/gpui-picker-source-freeze-clippy.sha256.
47 focused tests and11 SearchInput-filtered tests passed (overlap, not additive).
Both Clippy configurations, formatting and file-size checks pass. Final default
workspace2727passed/0failed/10ignored; all-features2761passed/0failed/17ignored.
These suites overlap. Failed initial compile/lint evidence retained alongside
passing results. Existing dependency block0.1.6 future-incompatibility notice
remains, not a new warning suppression.

Physical native UI, AppKit IME and result scrolling are NOT qualified. Existing
bundles predate switcher source; fresh native receipt/build/assembly is next.
User's running Selection Trace and its stopped fixture watchdog remain untouched.
Cross-platform lint cannot be claimed: Docker daemon unavailable and only macOS
Rust target installed/no MinGW compiler found. No new platform gate added, but
macOS composition handling changed and other-platform CI remains required.
GP03 stays open. Source work uncommitted/unmerged/unreleased on
codex/tmux-gpui-bootstrap at basefc3b7869c3cd1699fe5c82fcdab09aae18f5141f.
This is a reusable native navigation component, not full Herdr parity.

# Native switcher physical check — partial, 9 October 2026

Built native74cc44b79c22bf5c4f97d92961e202388cccd462ac53686a171ab859081fbb40
with source receipt758e12df70a88baff1aa82bf511624266c4bf57473d578ba591982945334a78e.
Assembled separate Switcher Preview and uniquely identified Switcher QA bundles.
QA identity com.tmux-ide.gpui.switcher-qa/version0.1.0 is test metadata, unsigned.
All3 explicit QA artifact tests pass; notices and native receipt verified.

Actual visible QA app used its own scratch fleet/socket/daemon. Observed via CUA:

- Switch button opened reused native search input.
- Typed PICKER_SHOULD_NOT_REACH_TERMINAL visibly filtered to no results.
- Replaced query with switcher, Enter opened the isolated session.
- Searched rapid, Enter selected the left pane.
- After a terminal click, CmdK opened picker; marker typed only in query.
- Escape restored focus; echo GPUI_LEFT_OK reached left pane and produced marker.
- Fixture capture verified left marker and no picker marker in either source pane.

Initial CmdK before any click had no visible effect. Cause unproven: investigating
initial focus routing versus automation activation. Do not claim this fixed.

CUA reported user interaction conflict while attempting CmdK + paste eager + Enter.
Refreshed screenshot showed picker open with unchanged empty query. Stopped UI
input, asked whether user is using QA app, and SIGSTOP'd exact fixture PID97537
to prevent its deadline cleanup while awaiting answer. QA native97698 remains;
original human Selection Trace native47090 and stopped watchdog46936 untouched.
The full physical fixture has NOT completed: right-pane marker/close/survival,
actual IME, narrow/crowded scrolling and final cleanup remain unverified. Logs are
partial evidence; screenshots are in the conversation, not exported files here.

Uncommitted/unmerged/unreleased. No production sessions changed. GP03 remains open.

## Initial switcher shortcut defect reproduced — 9 October 2026

Physical initial CmdK did nothing while button entry worked; CmdK worked after a
terminal click. Headless actual SnapshotView with no focused control reproduced
missing dispatch (0pass/1fail in gpui-picker-initial-focus-before.log). Browser
key handler had no initial focused route; selection also explicitly blurs.
Added browser focus fallback only when no control is focused and picker absent;
existing input readiness/presence/latch remain unchanged. The same regression,
including selection-blur reopening and unready-input refusal, now passes with
all48 focused tests. Source hashes and before/after logs:
apps/tmux-gpui/evidence/native-switcher-focus-2026-10-09/.

Broader workspace checks are currently running; physical initial-screen rerun
still pending user-interaction conflict clarification. Existing Switcher QA and
Switcher Preview binaries predate this fix. Do not claim physical recovery or
release completion. GP03 remains open; no commit/merge/publication.

## Focus fix packaged and workspace-qualified — 9 October 2026

Independent final review approved focus guard + same-path regression. Exact new
workspace gate finished0: default2728passed/0failed/10ignored; all-features
2762passed/0failed/17ignored (overlapping suites). Both Clippy configurations,
formatting and file-size checks passed. Source/readiness scope remains localMac.

Fresh optimized native build succeeded: SHA256
0d068bde2e42e4fdf2366dbcf8fe4e847b95315fc6d6ab4c1744c5fd11e60761,
source receipt984d13ad7728b3effbe3f5f1a093fb4ca3bd6f53967e8a73d3b4018acb92a5bc.
Assembled /tmp/Tmux IDE Switcher Focus Preview.app; all3 explicit artifact checks
pass, including copied binary/source receipts and retained notices. Build receipt,
assembly/artifact logs and complete gates copied to native-switcher-focus evidence.
This new app has not been launched. Release-profile CLI test job is still running;
its success is not claimed. Existing test windows/watchdogs remain protected while
awaiting the QA interaction clarification. Physical initial-CmdK recovery still
requires rerun. GP03 remains open; signing/publication remain unqualified.

Fresh git fetch origin main succeeded: origin/main
c78ff90b6d47a5f94e9996da01153f799b7f98b9 is already contained in branch HEAD
fc3b7869c3cd1699fe5c82fcdab09aae18f5141f. All new work remains uncommitted,
unmerged and unreleased.

## Optimized CLI and npm boundary verified — 9 October 2026

The existing release-profile job completed with exit 0: `cargo test --locked
--release -p herdr-gpui --test tmux_cli` passed all 3 tests (product identity,
argument rejection and offline snapshot validation). The prior running-job
statement above is superseded by this result. This is executable CLI evidence,
not a physical GUI acceptance result.

`node scripts/pack-tui-check.mjs` also completed with exit 0 using Node 24.21.0:
the npm dry-run inventory contained 3,878 files / 4,300,595 bytes and no native
preview files. This verifies the package boundary, not the full terminal release
gate. Both logs are retained in this evidence directory.

Both protected QA windows remain live and their fixture watchdogs remain stopped.
No UI automation, session cleanup, commit, merge or publication was performed.
Physical initial-CmdK recovery and signed distribution remain unverified.

## Nested native session hierarchy — 9 October 2026

The selected session now contains its window headings and pane rows. Groups are
formed by window identity, so interleaved entries cannot duplicate headings and
duplicate labels do not merge distinct windows. Missing window metadata appears
under Other panes. Indentation preserves the 224px sidebar and highlights the
selected session, containing window and pane. Herdr's existing sidebar label
renderer and clipping probes are reused; full HerdrWindow row machinery and RPC
actions are not imported. Search and terminal authority remain unchanged.

Row callbacks check the captured request, live command sender and current
session/pane membership before using the existing Selection path. Independent
review approved the exact three-file hashes in source.sha256. Focused native
module tests: 50 passed. Full workspace: default 2,730 passed / 0 failed /
10 ignored; all features 2,764 passed / 0 failed / 17 ignored. Suites overlap.
Both Clippy configurations, formatting and source-size checks passed; broad
gate completed with exit 0. Existing block0.1.6 future-compatibility notice remains.

Headless checks cover interleaved IDs, duplicate names, selected parent, missing
metadata, Unicode label bounds/masks at 640px width, and an actual pane-row mouse
click issuing the exact semantic pane command. Stale captured request rejection
uses the same dispatch method called by the real row listener. An earlier test
attempt incorrectly assumed simulate_click did not redraw between press/release;
that failed result and initial compile failures are preserved. No physical stale
click or glyph-pixel result is claimed.

Evidence: apps/tmux-gpui/evidence/native-sidebar-hierarchy-2026-10-09/.
This source is newer than the Switcher Focus Preview app; no new package or
physical UI validation is claimed. Both human QA windows remain untouched.
GP03 stays open for actual normal/narrow appearance and remaining acceptance.
Base HEAD fc3b7869c3cd1699fe5c82fcdab09aae18f5141f, branch
codex/tmux-gpui-bootstrap; new work remains uncommitted, unmerged and unreleased.

## Sidebar preview packaged — 9 October 2026

Built and assembled `/tmp/Tmux IDE Sidebar Preview.app` with the reviewed sidebar
and preceding switcher focus fix. Native SHA256:
1578bf20f32a63164e795ec6baa5a566924536756c9cac5060d33ab10608683d.
Source snapshot receipt SHA256:
da78ce128105e7bfbc828aed786449601bddeb23a5a00e715b7cde2e2bbe97b0.
The local cached, nonhermetic build and final assembly both exited 0. Initial
assembly failed because the invocation omitted Cargo from PATH; the corrected
toolchain environment completed required notice generation without bypasses.
Failure and passing logs are preserved.

All 3 explicit artifact tests pass: copied binary/source receipt and notices,
launcher PATH handling, and rejection of a mismatched binary before execution.
The new app has not been launched. Physical sidebar and shortcut verification
remain pending; existing human QA windows and their stopped watchdogs remain
untouched. No signing, notarization, commit, merge or publication claim. GP03
stays open. Evidence: apps/tmux-gpui/evidence/native-sidebar-hierarchy-2026-10-09/.

## Exact bundled helper lifecycle check — 9 October 2026

The Sidebar Preview's bundled Node and browser.bundle.mjs passed the existing
isolated two-session browser-smoke with local discovery enabled and native UI
explicitly disabled (TMUX_GPUI_TEST_BINARY unset). Exit 0; verified session
switching, request ordering, authenticated text/Unicode paste, resize and
presence release/reacquisition, rejected stale input, unavailable clearing,
and explicit refresh/reselection after replacement of the isolated daemon in
the same browser process. This does not claim automatic reconnect or native
keyboard/paste/resize gestures. The fixture cleans up its private processes
and tmux socket; protected human QA windows were not involved.

Log: evidence/native-sidebar-hierarchy-2026-10-09/gpui-sidebar-packaged-browser.log.
No source changes after the reviewed build. Physical UI testing awaits the
user's clarification about the two open QA windows; signing/notarization and
public distribution remain unqualified. GP03 remains open.

# Shared native themes — 9 October 2026

User requested the existing tmux-ide themes in GPUI. Source now implements all22
named presets plus Dark, Light and System using the contracts catalog, with a
native Theme… SearchInput picker. Shared AppConfig mode/preset persistence keeps
unrelated settings and only reports applied selection after successful save.
System follows macOS light/dark, not an external terminal's RGB palette.

The pure terminal palette projection now lives in contracts. Core reexports its
canonical xterm arrays without duplication, and the existing TUI calls the same
projection. Before/after tests independently reconstruct the original palette
formula for22presets and both base appearances. Named-theme defaults and ANSI0–15
are mapped at paint time; xterm16–255 and explicit applicationRGB remain source
faithful. Native snapshot cell tags are unchanged. Shared appearance also colors
shell/sidebar/search/pane accents. Custom/projectJSON, legacy per-color overrides
and TUI automatic-contrast controls are not implemented by this picker.

Validation:84 affected contracts/core/TUI tests; contracts/core/daemon typechecks;
scoped extraction lint/format pass.54focused native tests pass; full Rust default
2734passed/0failed/10ignored and all-features2768passed/0failed/17ignored; both
Clippy modes, format and size checks pass. Counts overlap/inherit upstream tests.
Bridge typecheck and143tests pass with3artifact-dependent skips. Real source and
bundled-helper isolated two-session journeys pass theme persistence, unchanged
request/pane/input readiness, native-system messages and invalid-theme refusal,
in addition to switching/input/paste/resize/recovery. Separate actual fresh-helper
process test restores Nord from an isolated config and preserves unrelated fields.

Independent review approved extraction, bridge and native integration with hashes.
Gloomberb palette notice is marked as a legal comment so esbuild retains it; the
bundle test checks the retained attribution. Two native style lint errors were
fixed without allowances; failure log retained. A broader ad-hoc ESLint attempt
on pre-existing bridge scripts hit unconfigured Nodeglobals and the existing
redacted catch's preserve-caught-error rule; this is not a passing whole-bridge
ESLint claim. New appearance-module lint passes. No catch was weakened to leak
raw private configuration errors.

The real daemon smoke rebuilt tracked generated bin/cli.js through the supported
builder after the shared palette extraction; source was edited, not generatedJS.
The dedicated generated debug incremental cache was removed only after Cargo
finished to free disk; source, binaries, fixtures and logs were preserved.

Optimized app rebuild is underway. The prior Sidebar Preview does not include
these themes. Physical palette appearance, picker behavior and native System
transitions still need current-package QA. Protected user test windows remain
untouched. No signing, notarization, commit, merge or publication; GP03 staysopen.

## Theme-enabled local artifact verified — 9 October 2026

Built `/tmp/Tmux IDE Themes Preview.app`. Native SHA256
57a9a7e9699043332ff69ca8659836960300a148ce430b21ac958505f6861769;
source receipt ea79e97fb5b643d4ea2cc6be3e83df58b2fea93cf2ea2e3455c976627a27f709.
Optimized local cached build, assembly and all3artifact checks exited0. The exact
app's bundled Node/browser helper also passed the isolated two-session lifecycle
journey with persisted theme changes, native-system notification and rejected
unknown theme while preserving selected pane/request/input readiness. New app
has not been launched. Physical theme colors/picker/System transitions remain
required; protected QA windows are unchanged. No signed-release claim.

## Home creation and demo — 10 October 2026

Name-only Home creation now uses the supported authenticated daemon API. Native
controls retain composition isolation and latch each queued mutation until a
higher browser creation-state revision acknowledges it. Private live-tmux proof
correlates the creation receipt with exactly one new catalog entry, preserves
the original source, and leaves Home without terminal input authority.

Evidence: `evidence/new-session-2026-10-10/`. Five focused native tests pass;
bridge gate164passed0failed3explicit-app skips; full Rust default2775passed
0failed10ignored, allfeatures2809passed0failed17ignored; format/size/bothClippy
pass. Optimized assembly and all three explicit-app tests pass. Native SHA256
4e570ed1f6cd9e383ff01831ee44969b0b0375b30e1ca45a24c72dafdfceb4e8.

The user-requested `/tmp/Tmux IDE New Session Preview.app` was opened and its
Home visibly discovered the local session. Left open for user testing. Physical
dialog submission and clipboard verification are still outstanding. The new
live source smoke is now included in the proposed GPUI CI lane; hosted Linux CI
has not run. Local, uncommitted, unmerged and unreleased.

## Native pane titles — 10 October 2026

Top titles occupy an app-owned row outside terminal geometry. Lower titles are
native decorative labels over verified safe separator spans, protecting every
outer pane/status rectangle; they compact or disappear rather than overlap
content. Divider handles remain above these labels. Top clicks retain exact
request/frame/region and input-presence/modal fences.

Evidence: `evidence/pane-headers-2026-10-10/`. 100 focused snapshot tests pass,
including actual headless divider mouse dispatch through a lower label and
canvas-derived Resize excluding the top row. Format, size and both Clippy
configurations pass. Workspace default2780passed0failed10ignored;
allfeatures2814passed0failed17ignored. Independent source review clear.
Failures and fixes are retained. Physical macOS title appearance/click/drag
remains unqualified. The open New Session Preview predates this source change.
No commit, merge or release.

## Active window reveal — 10 October 2026

A real headless-rendered overflow regression failed before the fix: selected
window11 remained at x2432..2632 outside a strip at x224..640. The tracked native
strip now reveals semantic selection/order/width changes and preserves manual
scroll on unchanged redraws. Unmeasurable layout schedules one follow-up per
stable key, then waits for actual measurement. No navigation/input is emitted.

Evidence: `evidence/window-tab-reveal-2026-10-10/`. 102snapshot tests pass;
format/size/bothClippy pass; workspace default2782passed0failed10ignored,
allfeatures2816passed0failed17ignored. Independent review clear. Original failed
and repaired passing paths retained. The local Navigation Preview build and
assembly exited 0; all three packaged-app checks passed without skips. It was
not opened. Physical horizontal-scroll testing remains pending; see the evidence
README and native-build receipt for exact binary/source hashes.

## First-launch discovery guidance — 10 October 2026

Fixed local discovery categories now survive the private-error boundary. Full
bridge gate:166passed,0failed,3explicit-app skips; three explicit checks on First
Launch Preview pass. Both source and exact bundled Node/browser recover from
missing daemon to live Home in the same process after explicit private daemon
startup and Refresh. No terminal input authority or automatic bootstrap added.
Independent review approved. Evidence: `evidence/first-launch-guidance-2026-10-10/`.
Physical native recovery and signed clean-machine installation remain open.
