# Glass-inspired pane polish — 2026-10-16

Research and implementation receipt; native visual acceptance remains pending.

## Public references and scope

- [Glass official site](https://glassapp.dev/), inspected 2026-10-16. The live deployment describes projects, notes and AI agents; the search index still exposed older browser/editor/terminal marketing. The deployed web bundle contains bounded, rounded popover styling with a subtle outline, padding and shadow. This is a design reference, not verification of exact Glass v2 native visuals.
- [Glass-HQ/gpui](https://github.com/Glass-HQ/gpui) is the public Rust UI framework, not the Glass v2 application source. `git ls-remote origin HEAD` returned `650aab59d54f4f6f85d42c965831935568ac1162`, matching the read-only local reference checkout. Commit date 2026-05-16.
- Its [popover example at that commit](https://github.com/Glass-HQ/gpui/blob/650aab59d54f4f6f85d42c965831935568ac1162/crates/gpui_examples/examples/popover.rs) illustrates deferred layers, anchoring, viewport margins and outside-click dismissal. No example bodies or website assets were copied. No dependency or framework changes were made.
- The [core GPUI manifest](https://github.com/Glass-HQ/gpui/blob/650aab59d54f4f6f85d42c965831935568ac1162/crates/gpui/Cargo.toml) declares Apache-2.0. The examples manifest has no explicit license declaration; this receipt does not assign a license to the entire repository or Glass product assets.

## Implemented design slice

Paths below are relative to `apps/tmux-gpui/upstream/crates/herdr-gpui/src/tmux_snapshot/`.

- `pane_chrome.rs`: mode and overflow controls use the selected header's neutral fill instead of contrasting rectangular surface patches; remove separate hover backgrounds; reuse the existing `icons/more.svg`. Header heights, cell coordinates, target capture and command guards are unchanged.
- `pane_actions.rs`: the existing action panel gains a 320px maximum width, panel radius, subtle full border, shadow and rounded action rows. Its existing 180px height cap, scrolling, callbacks and input isolation remain.
- `picker/render.rs`: pane-scoped picker height depends on visible row count plus heading/search/error allowance, capped at 240px and available viewport height. Global palette sizing and centered overlay placement remain unchanged. No anchored-menu relocation is claimed.
- `picker/tests/scoped_surface.rs`: focused regression checks that filtering pane actions to no results shrinks the popup without changing terminal geometry, clearing the interrupted-input latch or emitting terminal commands; Escape closes the picker.

This is an independently implemented adaptation using existing project primitives, icons and tokens. It is not a copy of proprietary Glass v2 source and does not claim pixel parity.

## Validation and remaining acceptance

At handoff, `git diff --check` passed. Parent-owned regression/build validation is in progress; no compile or test pass is asserted here.

Pending native checks on the built candidate:

- Light/dark pane headers and controls, selected/unselected, top and lower panes; verify complete glyphs and unchanged cell alignment.
- Pane-scoped menus with full, filtered and empty results; rename/error state; bounds at narrow/short viewport sizes and scrolling at the height cap.
- Overflow click, Escape and outside dismissal without terminal input leakage; stale target/capability rejection remains covered by the existing behavioral suite.
- Actual panel corner/shadow rendering and contrast; screenshots of the candidate, with fresh content markers where needed.

Fullscreen click/input misrouting is a separate investigated issue. This visual slice does not claim to fix it or qualify the candidate for signing/release. No new native UI interaction was performed for this receipt.

## Cohesive surface refinement

User feedback requested fewer competing fills, no vertical selection marker and consistent dividers. Pane headers, their controls, window-strip base and status footer now use the terminal background; selected pane titles retain foreground/semibold contrast. Sidebar rows use a rounded selected fill and stronger icon/text, with the vertical rail removed. The footer uses the shared neutral separator token. Safe unused split-boundary cells are drawn as neutral 1px lines for every pane, deduplicated by position and orientation; terminal content and input geometry remain untouched.

Independent source review found no correctness blocker. All-pane boundary collection adds bounded paint work (valid layouts cap at 24 panes); no performance-equivalence claim is made. The first surface-only slice passed 376 tmux_snapshot tests; the final divider addition is undergoing full-gate validation. Native light/dark, custom-theme contrast, narrow layouts and actual split dragging remain acceptance checks. Candidate build 2026101601 predates these changes and must not be published as the refined design. Next candidate identity is 2026101602.

Final cohesive-source gate exited 0: formatting, file size, Clippy all-features and no-default-features, default workspace and all-features workspace tests. GPUI suites: 2,791 passed / 7 ignored and 2,822 passed / 8 ignored. Native candidate acceptance remains pending. See cohesive-full-check.log.
