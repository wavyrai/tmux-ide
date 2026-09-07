# Command discovery and dialog increment

Implemented on `codex/pane-workspace-polish`, after `e1b65113`. This is an
unreleased working-tree increment, not a new beta or completion of the broader
component-convergence roadmap.

Sfora: [mission and cards #322–#325](https://www.sfora.ai/org/wavyr/posts/nh75x3n3wbj2azaw9rey3rqbn58dretf).

## Scope

F5 → type or paste a query → choose by arrows, wheel or pointer → activate or
cancel → return to the resident terminal. Search covers existing actions,
catalog sessions and agents in the current semantic session. It does not imply
a new cross-session agent registry or expose unimplemented settings commands.

## Composition and ownership

| Layer                                          | Responsibility                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace/application-command-description.ts` | Pure labels, exact tuple IDs and multi-term filtering; pane labels come from `PANE_ACTION_MENU_ITEMS`.                                                                   |
| `runtime/application-palette-search-owner.ts`  | Bounded query, stable-ID selection, keyboard/paste admission. No physical listeners or PTY subscriptions.                                                                |
| `runtime/application-palette-command-owner.ts` | Existing command dispatch, availability guard, target-scoped confirmation, in-flight deduplication and failure reporting.                                                |
| `runtime/application-home-agents-owner.ts`     | Connect catalog/semantic commands and current live-pane availability to existing runtime owners.                                                                         |
| `runtime/application-shell-overlays.tsx`       | Production palette and rename presentation using existing Dialog, OverlayFrame, OverlayListRow and TuiButton.                                                            |
| `runtime/application-shell-overlay-stack.tsx`  | Resident focus coordinator: data updates do not dispose the stack; the final modal close restores a still-valid target. Explicit pane navigation supersedes restoration. |
| `runtime/application-root-v2.tsx`              | Still the only physical keyboard and paste ingress. Delegates modal input before terminal forwarding.                                                                    |

## Interaction contract

- Case-insensitive search matches every query term across label and description.
  Session and agent selection use exact IDs, not list indices or display labels.
- Text entry supports Unicode, space, backspace and Ctrl+U; sanitized paste and
  query/rename text are bounded to 80 code points. Long input keeps its caret in
  view using grapheme-safe terminal-cell clipping. This is append-only entry,
  not a full cursor-editing widget.
- With no matches, Enter is inert and Escape still closes. All modal keys and
  paste remain outside the PTY. Modified/repeated Enter cannot confirm a close.
- Unavailable pane commands remain visible with a reason. Both pointer and
  keyboard execution are guarded at the owner boundary.
- Close confirmation is invalidated by query, selection, or pane/generation
  target changes. A running mutation cannot dispatch twice. Late completion
  does not close a newly opened palette.
- Rename has mouse Save/Cancel as well as Enter/Escape, empty-name guidance and
  caught failure reporting through the existing notification surface.
- Palette selection scrolls only when it leaves the visible window. At 20×7,
  query plus one clipped selected result fits; other results remain reachable.
  Standard sizes retain count/context and shortcut guidance.
- No new pane-management backend, component framework, polling loop, config
  storage, settings screen or package dependency was added.

## Verification

- 37 focused unit/architecture tests passed, including command identities,
  matching, query/paste ownership, unavailable actions, confirmation invalidation,
  failure/retry, duplicate dispatch, late completion, text clipping and existing
  pane-menu/selection ownership.
- Full OpenTUI renderer suite: 244 tests, 74 snapshots passed. New production
  fixtures cover dark/light search, mouse activation, no-results cancellation,
  focus restoration across notification updates, tiny scrolling and rename.
- Daemon typechecks and root lint passed. CLI and compiled TUI rebuilt locally.
- Isolated compiled test drive: search `split` + mouse click produced exactly
  one new pane; pasted `COMMAND_SEARCH_MUST_NOT_REACH_SHELL` appeared only in
  the palette; Escape followed by `echo COMMAND_INPUT_RESTORED` reached the
  original shell. Close confirmation + Escape left all three panes intact.
  The disposable app, daemon and target session were cleaned up; user sessions
  were not changed.
- These checks are not the full packed-release qualification or `pnpm check`.

## Design mirror

In the [tmux-ide Prototyper workspace](https://www.prototyper.co/home/workspace/39180698-d267-4863-af57-87889851b0e4),
`current-11-palette` contains eight real OpenTUI component captures: discovery,
agent search, no matches, close confirmation, unavailable action, rename,
empty name and tiny terminal. `current-00-index` identifies this increment.

The generated document is classified as a document, uses Berkeley Mono and
8×18 CSS-pixel cells, and has a source digest and structured capture alongside
it. Browser verification checked all captured text and cell widths exactly.
These are deterministic fixtures, not recordings of real agents. Terminal
fonts remain user-owned. Other artboards retain their historical revisions.

Temporary verification artifacts for this run:
`/tmp/tmux-ide-command-polish.ltu955/` (capture generator, HTML, structured
frames, browser verification, images and live terminal proof). The production
regression coverage lives in the repository tests; temporary files are not a
release dependency.
