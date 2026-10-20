# NR04 evidence and parity gap ledger — 2026-10-18

## Current bounded results through link adapter verification

NR04 remains open. Matched local stock tmux 3.8 comparisons now exist for the workflows below. These compare canonical outcomes through plain tmux, actual TUI and the GPUI bridge; they do not qualify current native GPUI rendering, all supported platforms, owned SSH, or performance.

| Workflow | Current result | Evidence commit |
| --- | --- | --- |
| Quiet window resize | Matching geometry, identities, markers and fresh input | `f75b10ea` |
| Quiet horizontal divider | Matching widths; GPUI movement before release | `5b92f4f4` |
| Divider during finite output | Source output advances around actions; final marker and input survive | `e5b85427` |
| Split-right, zoom, restore, close-new | Matching lifecycle outcomes; survivor process remains alive | `aa7c0d4f` |
| Unicode paste with bracketed mode on/off | Original TUI failure retained; corrected source and compiled TUI pass exact bytes | `c513c772`, `e0f813bd`, `bb1216ff` |
| DEC1049 alternate-screen round trip | Main screen and source cursor restored; fresh input survives | `652b7b99` |
| Application mouse | Exact click/release reference plus GPUI semantic implementation; matched SGR drag/hover and disabled negatives | `1c635596`, `58845aa8`; mouse-motion evidence below |
| HTTP(S) links | Historical compiled TUI exact opener arguments and refusals; real canonical publication decoded by native headless adapter, including stale/admission negatives | `bbf64fdd`, `cda11e40` |

The detailed additions below retain artifact identities, adapter differences and limitations. Application mouse now has bounded matched byte-level evidence; links have distinct TUI and native headless adapter evidence, not one matched physical run. History/copy-mode, broader switching/recovery, vertical/nested resizing and source-mutation cases still need broader qualification. Physical native mouse/link checks, OSC8 metadata transport, bundled/SSH/platform lanes and complete parity remain open. Historical evidence is useful only within its recorded scope.

## Initial inventory (historical)

The following inventory was written at HEAD `0fbaef5b4aff0207b9304296278a9456bb617466`, before the matched runs above. At that time GPUI changes were uncommitted and no workloads/builds/GUI were run for the inventory itself. Statements that a matched workflow is untested describe that initial state; the dated additions and current summary supersede them only for their explicit bounded cases.

Paths are repository-relative. `E` = `apps/tmux-gpui/evidence/`; `G` = `apps/tmux-gpui/upstream/crates/herdr-gpui/src/tmux_snapshot/`; `B` = `apps/tmux-gpui/bridge/`; `T` = `packages/daemon/src/tui/mirror/`. “Verified” below always means the specific receipt/artifact/platform, not current global parity. Source/test presence describes implementation or coverage intent, not a newly passed test.

## Comparison contract

Plain tmux is the reference for session/window/pane identities, process continuity, geometry, cursor, terminal modes and canonical content. TUI/GPUI add application navigation, retained tabs, clipboard and recovery policies; compare their effects, not literal UI pixels or keybindings. Closing a retained application tab must not be compared to tmux kill-session. GPUI local selection/history is not automatically identical to tmux copy-mode.

Pin separate lanes: bundled patched tmux3.7c (`native/tmux/provenance.json`, commit `e476c1230b958df0cb12977517d24b3dc931375b`, extension `tmux-ide-native-grid-v2`) and stock tmux3.8. Use equal content geometry, locale, workload and initial state; local and owned-SSH are distinct lanes. Record CLI/daemon/bridge/native hashes and exact adapter. Existing tests using different artifacts cannot be combined into a single parity pass.

## Workflow ledger

| Workflow and comparison | What current evidence establishes | Status / bounded follow-up |
|---|---|---|
| Session/window/pane switching; selected identity and process continuity | `E/hosted-qualification-2026-10-15/result.json` plus `browser-history.json` record packaged headless journeys. `E/nr02-layout-recovery-2026-10-18/linux-runner-findings.md` records four Linux ARM64 bundled-bridge browser-smoke passes, including second-session input, foreground restoration and stale-input rejection. `T/runtime/select-terminal-pane.ts` and its test own TUI selection. | **Verified bounded headless behavior; matched three-surface and current native continuity untested.** NR03: quiet/busy rapid switch workload with final pane IDs/PIDs/content; do not infer seamless rendering from input-ready publications. |
| Retained application tabs: activate, close, reopen | `E/retained-session-tabs-2026-10-13/native-physical-pass.json` explicitly says syntheticOnly=true, realDaemon=false and acceptedPublicationVisuallyVerified=false. Later `E/recovery-alpha-2026-10-17/README.md` verifies retained available tab after native recovery. `G/session_tabs.rs`, `B/session-history-package.test.mjs` preserve capability ownership. | **Partial verified; not full tab visual parity.** NR03/NR04: two real sessions, close inactive/active tab, preserve original source PIDs, reopen exact target; source replacement must not bind same-name successor. |
| Split right/down, close pane/window, zoom | `E/tmux38-release-2026-10-18/README.md`: candidate0.1.3/2026101801 physical stock3.8 splits, coherent two/three-pane layout, original selection/PID survives, no input leakage and cleanup. Older packaged close/new-window receipts: `E/hosted-qualification-2026-10-15/{close-pane,close-window,new-window}.json`. `G/pane_actions.rs`; `T/runtime/application-pane-menu-owner.ts`. | **Splits reported physically verified on stated candidate; current all-actions GUI/matched TUI untested.** Physical images retained only in the original chat are weaker reproducible evidence than repository-contained screenshots; preserve new screenshots with the next receipt. NR04: bounded split→zoom/restore→close sequence, exact counts/IDs/receipts; duplicate and stale action must not mutate. Preserve close confirmation. |
| Resize window and divider, both axes, quiet/busy content | `E/nr02-layout-recovery-2026-10-18/README.md`: pre-fix20-resize burst retired replica; supersession-budget regression failed before,507 relevant tests and six stock3.8 bridge journeys passed after. Linux bundled bridge JavaScript on stock tmux 3.8 also passed (not bundled patched tmux 3.7c); source-mode stall later observed OOM. `E/recovery-alpha-2026-10-17/README.md`: native divider changed widths33/46. Shared TUI owner: `T/runtime/resize-terminal-pane.ts`; `G/divider.rs`, `B/split-gesture.test.ts`. | **Failure reproduced/fixed in source; bounded reruns verified, current physical resize untested.** NR02 owns same-path foreground/resize qualification. **Unsupported intentionally:** some deep nested outer divider handles; README lines781 onward documents ambiguous pane-size targeting. NR04 record exclusion, not silent parity. |
| Scrollback, copy-mode, mouse and alternate-screen | `B/history.test.ts`, `B/wheel.test.ts`, `B/browser-wheel-smoke.mjs`; `G/selection.rs`, `G/terminal_links.rs`; TUI `T/workspace/terminal-scrollback.ts`, `T/runtime/terminal-copy-selection.ts` and associated tests identify separate policies. Packaged history receipt is headless only. | **Implementation/selected tests exist; matched mode matrix untested.** NR04: history offset→live, native tmux copy-mode, alternate screen, mouse-reporting application on/off, Shift-wheel override, same final content/cursor/modes. Do not classify full tmux copy-mode UI compatibility as proven or unsupported without checking individual operations. |
| Unicode, clipboard, paste and links | `E/physical-copy-2026-10-11/README.md`: exact254 UTF-8 byte clipboard match against canonical oracle and tmux capture-J, combining/CJK/emoji/soft wraps/trailing blanks; explicit older binary hash. `E/native-paste-current-2026-10-10/README.md` is earlier physical paste proof. GPUI README documents64KiB limit and rejects NUL/Escape; interrupted paste can deliver prefix and is never replayed. TUI `T/runtime/application-terminal-paste.ts`, `T/runtime/terminal-links.ts`. | **Historical native copy/paste verified; current link/selection/resize-invalidation matrix untested.** NR04: same payload and clipboard bytes, link allow/refuse, selection mutation negative. NUL/Escape/oversize rejection is **intentional unsupported input**, not a defect. Pixel/font differences are separate from byte semantics. |
| Focus, first click, fullscreen and stale geometry | `E/fullscreen-input-2026-10-16/README.md`: previous-pane delivery observed; exact fullscreen cause unproven. Deterministic unpainted/missing-geometry click tests failed before narrow latch fix; full suites passed. Instrumented native run passed, first uninstrumented attempt incomplete due lost activation. `G/input_gate.rs`, `G/input_interruption_tests.rs`. | **Proven safety defect fixed with regression; original fullscreen mechanism unresolved; final native acceptance untested/incomplete.** NR02/NR04: fresh tagged frame, actual click coordinates, paint equality and input target; immediate-type vs matching-ready-then-type. Do not convert activation/control failure into product pass. |
| Local daemon replacement and owned SSH recovery | `E/recovery-alpha-2026-10-17/README.md`: signed candidate1702 packaged browser through private real OpenSSH restores exact pane/tab/input; outage input absent; Home cancels recovery; native local automatic recovery verified. Earlier `E/neutral-chrome-candidate-2026-10-15/native-recovery/result.json` proves explicit refresh only and must not be relabeled automatic. TUI `T/runtime/application-reconnect-owned-ssh-live.test.ts` and `application-ssh-terminal-reconnect-renderer.test.tsx` exist. | **Bounded packaged SSH and local GUI verified on1702; current matched TUI/GPUI recovery and remote GUI untested.** NR08: disconnect/daemon replacement while busy, same-name replacement refusal, in-flight catalog cancellation; genuine remote transport distinct from loopback OpenSSH. Spark read-only health check is not a mutation/recovery proof. |
| Version and optional capabilities | `E/tmux38-compat-2026-10-17/README.md`: stock3.8 capture-R emits G/L/C rather than extension JSON; unsupported extension falls back atomically, arbitrary malformed JSON still fails; typed topology change recoverable without replay. Both stock/bundled split/recovery controls passed. `B/compatibility-process.test.mjs`; `packages/daemon/src/lib/{background-native-capture,native-split-capability}.test.ts`; `packages/daemon/src/command-center/daemon-capabilities-auth.test.ts`. | **Specific compatibility fixes verified; broad version/platform matrix untested.** NR01/NR04: bundled and stock lanes, absent/older gesture capability (release-only fallback), malformed protocol and stale generation; unsupported requests must be disabled/refused. Do not equate native extension absence with unsupported tmux itself. |

## Application and input coverage still required

- **Home/fleet/F5 parity (NR05/NR07/NR08):** compare current TUI and GPUI machine add/edit/remove/retry/disconnect, filters, favorites, local session creation and cancellation. Include stale registry/selection refusal and pending/failed mutations. No matched pass is asserted by this inventory. These are application workflows, not features of plain tmux; use canonical daemon outcomes and TUI behavior as their reference.
- **Keyboard and text input (NR02/NR04):** compare IME composition, modifier/function keys, key repeat, focus/modal ownership and interrupted input. Assert the exact pane receiving bytes, no popup input leakage and no replay after recovery. Clipboard Unicode receipts do not qualify keyboard/IME behavior.

## Evidence cautions / next bounded cards

1. NR01: define one manifest/oracle/cleanup schema for the three adapters, same version and geometry. Existing installed-package journeys exercise real tmux but do not constitute a separate directly attached plain-tmux UI comparison. TUI source/test references above do not supply matched run receipts.
2. NR04 first slice: local stock3.8, two sessions/two panes, switch→split→zoom→resize→close; compare selected identity, PID survival, pane rectangles and exact synthetic content. Then repeat bundled3.7c. Preserve failing traces and cleanup; separately prove GUI rendering.
3. NR04 second slice: copy/history/mouse/alternate-screen/Unicode with fixed payload and mode transitions. No terminal output from production sources.
4. NR08: reuse existing owned-SSH fixture for the same lanes and cancellation/replacement negative cases. NR02/NR03 own active lifecycle/continuity fixes; do not create competing repairs from this ledger.
5. Documentation/evidence gap: README references `evidence/continuous-resize-2026-10-10/`, but that directory is absent in this checkout. Do not cite it as an inspected receipt. Newer resize evidence above is usable within its stated scope.
6. Linux update: `lifecycle-followup.md`'s “Linux remains unqualified” is qualified by later `linux-runner-findings.md` and `bundle-repeats.json`: four bundled ARM64 passes, source-mode memory-constrained failure retained. Neither qualifies Linuxx64, adequate-memory source CI or native GUI.

All proposed follow-ups map to existing NR01/02/03/04/08 cards in `.tasks/native-reliability-mission/index.md`; no cards posted or status changed. Release, signing, merge and installer completion remain separate from this ledger. Historical signed1702 and later unsigned1801 evidence are distinct artifacts; current dirty source is neither.

Independent evidence review checked selected cited receipts and required the above stock-tmux clarification and application/input coverage. This ledger is a test plan and scoped evidence inventory, not a completed parity matrix.

## Later bounded resize calibration

`../nr04-resize-calibration-2026-10-18/README.md` records a matched local stock3.8 quiet two-pane window round-trip across plain tmux, actual source OpenTUI, and source GPUI bridge. Final receipts independently match pane geometry at132×41→152×45→132×41, preserve original per-lane identities/processes and fresh input, and verify observed owned processes exit. Plain explicitly matches the daemon clients’ top-header policy. This updates the window-resize row only; full matched workflows, native GPUI rendering, divider drag, busy workloads, bundled/SSH comparisons and performance remain unqualified.

## Later quiet divider calibration

`../nr04-divider-calibration-2026-10-18/README.md` adds matched stock3.8 horizontal two-pane divider geometry66→69→75→66 across direct plain-tmux commands, actual source TUI mouse drags and the GPUI bridge’s advertised token-based resize gesture. GPUI movement reaches width69 before release; all lanes retain identities, marker content, fresh input and observed-process cleanup. Canonical split handles are absent on stock3.8 but continuous token gestures remain supported. Native pointer/paint, busy output, vertical/nested geometry, bundled/SSH and performance are still unqualified.

## Later finite active-output divider check

`../nr04-busy-divider-2026-10-18/README.md` extends the three stock3.8 divider lanes with the same finite left-pane row-repaint producer. All lanes preserve matched geometry and identities while source ticks advance around each action; final200/DONE, fresh input and observed-process cleanup pass. This qualifies one active-output case only, not throughput, every intermediate frame, two busy panes, native GUI or performance.

## Later matched pane lifecycle

`../nr04-pane-actions-2026-10-18/README.md` records matched stock3.8 split-right→zoom original→restore→close new→fresh input across direct tmux, actual source TUI and GPUI bridge. Five geometry stages, survivor IDs/PIDs and closed-new-PID exit match. Actual TUI two-step confirmation is exercised; native GPUI confirmation is not. Earlier disabled-action and harness assumptions are retained with proven owner explanations. Transient “Open a live session first” wording during reconciliation remains an NR05 follow-up. Wider layouts/races/native/SSH/version and performance acceptance remain open.

## Matched Unicode and bracketed-paste check

`../nr04-unicode-paste-2026-10-18/README.md` records the same 2,138-byte Unicode payload across stock3.8 plain tmux, actual source TUI and GPUI bridge with DEC2004 on/off. Mode-on passes all three paths, including a supplementary-code-point chunk boundary. Mode-off plain tmux and GPUI deliver exact raw bytes; TUI incorrectly adds 12 framing bytes. This is a reproduced failure, tracked by follow-up card kn71bd5tenv59w3mshy8g6j0m58ggdec, not complete parity. All private processes cleaned up. Exact byte fidelity and final text markers do not establish native clipboard, font/cell-width, SSH or platform acceptance.

## Paste mode correction

`../nr04-paste-mode-fix-2026-10-18/README.md` preserves the same six-lane workload after the canonical TUI paste-mode correction. All six pass: the TUI now matches plain tmux/GPUI with mode off (2,138 raw bytes) and on (2,150 framed bytes). Tests cover queued admission, missing mode and ownership cancellation; input guards remain intact. Original failing evidence remains in the preceding directory. This updates bounded source-TUI paste parity only; installed-package, native clipboard, SSH and wider platform acceptance remain separate.

## Compiled TUI paste qualification

`../nr04-compiled-paste-2026-10-18/README.md` extends paste-mode verification to a standalone baseline TUI compiled from archived e0f813bd and the genuinely npm-installed current CLI/daemon. Both mode-on/off exact-byte and rendered-marker checks pass with source identities, geometry and cleanup intact. npm excludes the TUI binary, so this is an explicit separate runtime + installed daemon fixture, not public-install qualification. Initial package-recipe assumption failure and npm11 blocked lifecycle scripts are retained; private allowlisted lifecycle rebuild and dependency-load checks are recorded. Native GPUI, qualified release renderer, signing, platform and customer journey gates remain open.

## Matched alternate-screen round trip

`../nr04-alternate-screen-2026-10-18/README.md` verifies local stock3.8 DEC1049 enter/exit across plain tmux, compiled TUI and GPUI bridge. Exact receiver input, source flag/cursor, saved/main captured text, history size and identity/geometry restore; TUI rendered markers and GPUI published mode/cursor pass separately. All processes cleaned up. Initial resize-before-initialization fixture failure is retained and explained. This does not qualify trailing whitespace/styles, physical GUI cursor rendering, mouse/copy-mode, SSH or all alternate-screen variants.

## Application mouse reporting gap

`../nr04-mouse-reporting-2026-10-18/README.md` verifies exact DEC1000/1006 left press/release bytes through a real attached stock3.8 client and the compiled TUI, followed by reporting-disabled no-leak and fresh-input checks. Both preserve identity/geometry and clean up all owned processes. Current GPUI native handlers and bridge schema lack semantic application press/drag/release routing; this is source-audited missing support, not a physical GUI failure. Sending raw SGR bytes would bypass the missing owner and is not counted as parity. Follow-up Sfora card `kn7fmhcev6tp9mstepy7hb9m1n8gh9tt` requires canonical mode encoding, gesture ownership/cancellation and native verification.

## Semantic GPUI application mouse implementation

`../nr04-native-mouse-2026-10-18/README.md` adds strict semantic press/drag/move/release/cancel routing at the native view and bridge. The bridge independently checks canonical modes, content dimensions and input authority, uses the shared encoder, and rejects stale or cancelled gestures. Final stock3.8 installed-daemon bridge runs match exact reference bytes and preserve disabled no-leak, fresh input and complete cleanup. Native content coordinates use validated copyRegion rather than the header-inclusive pane rectangle. Independent source review covers repaint continuity and divider-button isolation. This updates the earlier missing-route inventory; it does not establish physical GPUI mouse parity. Follow-up #620 stays open for current native pointer, protocol/workload, SSH/bundled and platform acceptance.

## Matched application drag and hover

`../nr04-mouse-motion-2026-10-18/README.md` adds a matched local stock3.8 DEC1002 left drag→DEC1003 buttonless hover→reporting-off workload. Plain attached tmux, compiled TUI and current GPUI semantic bridge deliver identical45bytes, suppress unsupported/disabled hover, preserve original identities/geometry, accept fresh input and clean owned processes. Independent review verifies raw bytes and synchronized mode transitions. This does not qualify native pointer events, all encodings/buttons/modifiers, SSH/bundled/platform behavior or performance.

## Link activation and native admission additions

`../nr04-links-2026-10-18/README.md` (commit `bbf64fdd`) records plain stock tmux 3.8 content and historical compiled TUI e0f813bd with installed CLI 2.9.7. Three exact HTTP(S) opener arguments, including soft wrapping, and a final positive barrier pass through an owned recorder; unsafe schemes, OSC8 friendly label and an adjacent incomplete URL produce no additional opens. No external URL is opened. Original identities/PIDs and attached geometry survive, with zero application input and verified cleanup. The initial post-detach geometry assertion failure is retained; final geometry is checked while attached. This is not current-source TUI, physical OS opening or OSC8 metadata fidelity.

`../nr04-links-native-2026-10-18/README.md` (commit `cda11e40`) adds an actual bridge publication, decoded through native Reader/apply-state and terminal-click handlers in TestAppContext. Three exact targets and unsafe/adjacent/stale/inactive/unpainted/overlay/composition refusals pass. Each negative begins with a positive ready-target proof. Three focused tests and 439 tmux_snapshot tests passed (one ignored). Pixel geometry and paint completion are simulated; native pointer delivery and OS browser opening remain unverified. Capture and compile failures are retained with their limits.

These additions supersede the initial inventory's missing-link and missing-mouse statements only for the explicitly described source/adapter scopes. They do not establish one current installed build's full plain-tmux/TUI/GPUI parity. The current unsigned native candidate remains a separate artifact; no release or card completion follows from this ledger update.
