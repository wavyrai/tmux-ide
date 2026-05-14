# Goal-20 — Multi-terminal port

> **Status:** Audit only. No code changes.
> **Source:** `context/emdash/src/shared/terminals.ts` (registry primitives) + `src/renderer/lib/pty/**` (renderer-side PTY layer, search overlay, sizing) + `src/renderer/tests/{terminal-search,terminalInputBuffer,terminalKeybindings}.test.ts`.
> **Motivation:** the current Solid surface ships a single-tab xterm via `/v2/terminal/[id]`. The daemon already supports multi-PTY via `PtyBridgeRegistry`, but the renderer can only address one bridge at a time. We need a tab strip + scoped session IDs + scrollback retention across tab switches + in-terminal search.

---

## §1 — Reference terminal architecture

Three layers, mostly mature.

### 1.1 — The registry primitive (`src/shared/terminals.ts`, 39 LOC)

A single helper — `createScriptTerminalId({ projectId, scopeId, taskId, type: 'setup' | 'run' | 'teardown', script })` — that hashes `${projectId}::${scopeId}::${type}::${script}` to a stable 32-char ID. Determinism is the whole point: re-opening the same project/scope/type/script gets the same bridge, so the user sees an already-running setup script instead of re-spawning it.

The accompanying types:

```ts
type Terminal = { id; projectId; taskId; ssh?; name };
type CreateTerminalParams = { id; projectId; taskId; name; initialSize?: { cols; rows } };
```

The test file pins three contracts: (a) same input → same ID; (b) different `scopeId` → different ID even when project+script match; (c) legacy `taskId` argument is interchangeable with `scopeId`. The "scope" abstraction is the load-bearing bit — it's what lets the same script terminal appear under a workspace OR a task without the rest of the app needing to know which.

### 1.2 — Renderer PTY layer (`src/renderer/lib/pty/`, ~2050 LOC)

The pieces, in dependency order:

**`xterm-host.ts` (20 LOC)** — singleton off-screen `<div data-terminal-host>` mounted at `(-10000px, 0)`, `visibility:hidden`. Every xterm Terminal instance lives in this host when not visible. `ensureXtermHost()` lazily creates it. **This is the load-bearing pattern** — it preserves scrollback + cursor state across React mount/unmount, because xterm itself never unmounts.

**`pty.ts` (202 LOC) — `FrontendPty`.** One instance per session-id. Owns the xterm Terminal for the full session lifetime (not per-component). Surface:

- Constructor synchronously creates the Terminal + container in the off-screen host. Loads `CanvasAddon` (better perf than DOM, no WebGL gotchas) + `WebLinksAddon`.
- `connect()` — calls `rpc.pty.subscribe(sessionId)` which returns a ring-buffer snapshot atomically with consumer registration (no missed bytes). Writes the historical buffer to xterm, then subscribes to `ptyDataChannel(sessionId)` for live events.
- `mount(target, targetDims?)` — appends `ownedContainer` into the visible mount target. Resizes BEFORE the appendChild when `targetDims` is provided (eliminates the flash from a post-mount resize). Forces a Canvas2D refresh in `requestAnimationFrame` after reparenting (necessary; Canvas2D doesn't auto-repaint after a DOM move).
- `unmount()` — moves the container back to the off-screen host. **Does NOT dispose the Terminal.**
- `dispose()` — unsubscribes from the IPC channel, disposes the Terminal, removes the container, removes self from `FrontendPty.all`. Only called when the session is permanently deleted (terminal closed, conversation forked, etc.).
- Static `FrontendPty.all: Set<FrontendPty>` + `applyThemeToAll(theme)` — used for app-wide theme switches without enumerating sessions externally.

100,000-line scrollback default. `scrollOnUserInput: false` so the user's typed scroll position is preserved.

**`pty-session.ts` (40 LOC) — `PtySession` (MobX store).** Wraps `FrontendPty` with reactive status (`'disconnected' | 'connecting' | 'ready'`). Uses `onBecomeObserved` as a "first reader connects" safety net — the primary path is eager `connect()` from whatever manager store loads the project, this catches edge cases. `dispose()` clears the pty + status. Per session-id.

**`pty-pane.tsx` (148 LOC) — `PtyPane`.** React component that wraps a `containerRef` div and calls `usePty(...)` to drive mount/unmount/focus/sendInput against a passed-in `FrontendPty`. Forwards a ref with `{ focus }`. Handles drag-and-drop of files into the terminal (escapes the paths into a shell-quoted string, sends them via `sendInput`; SSH path uses `rpc.pty.uploadFiles` first then forwards remote paths).

**`use-pty.ts` (602 LOC) — the hot path.** Listens to the cell-metrics + ResizeObserver, debounces resize at 120 ms, mounts the pty container into `containerRef.current` on mount, unmounts on dismount. Handles keybindings (mac vs. linux modifier detection, Shift-Enter → Ctrl-J optional mapping, Ctrl-U kill-line, copy/paste, interrupt). Reads `PaneSizingContext` if available so background sessions in the same pane receive the same resize as the visible one. Wires `onActivity`, `onExit`, `onFirstMessage`, `onEnterPress`, `onInterruptPress`. This is the file that earns its keep — every interaction with the terminal flows through here.

**`pane-sizing-context.tsx` (200 LOC) — `PaneSizingProvider` + module-level `paneRegistry`.** A `paneId` keys a registry that maps to the visible container element. The provider broadcasts the active terminal's cols/rows to _all_ registered session-ids (active + background) on a 60 ms debounce, so a background agent's PTY is always sized as if it were on-screen. Critical for chat/conversation flows where multiple agents are running but only one terminal is rendered. Also exposes `getPaneContainer(paneId)` so code outside React (e.g. sidebar hover handlers) can measure pane dimensions without mounting a terminal.

**`pty-pool-provider.tsx` (14 LOC) — `TerminalPoolProvider`.** Wraps the app: ensures the off-screen `xterm-host` is mounted, calls `disposeAllPtys()` on unmount (which clears `FrontendPty.all`).

**`pty-dimensions.ts` (42 LOC) — `measureDimensions(container, cellWidth, cellHeight)`.** Extracted from `FitAddon.proposeDimensions()` but decoupled from any specific terminal. Lets callers measure any element to find what cols/rows would fit, even without a mounted terminal inside (e.g. PaneSizingContext measures its own wrapper).

**`pty-input-buffer.ts` (301 LOC) — `TerminalInputBuffer` + `SubmittedInputBuffer`.** Sanitizes raw xterm input data to detect "real" task input — strips CSI/OSC/SS3 sequences, decodes line editing (Ctrl-U, backspace, arrows), splits at newlines, filters arrow-key-only "noise" inputs. Used by chat surfaces that want to record what the user actually typed at the terminal, not the raw key bytes. Pure (no IO); ~70% covered by `terminalInputBuffer.test.ts`.

**`pty-keybindings.ts` (99 LOC).** Eight pure predicates: `shouldMapShiftEnterToCtrlJ`, `shouldHandleInterruptFromTerminal`, `shouldCopySelectionFromTerminal`, `shouldKillLineFromTerminal`, `shouldPasteToTerminal`. Each takes a `KeyEventLike` + `isMacPlatform`. Mac vs. linux differences are encapsulated here — Cmd vs. Ctrl, the kill-line modifier, copy-only-when-selection-exists. Pure; 100% covered by `terminalKeybindings.test.ts`.

**`prompt-injection.ts` (27 LOC).** Wraps multiline payloads in bracketed-paste escapes (`\x1b[200~ … \x1b[201~`) except for Claude provider which has its own paste handling. Used to send chat prompts INTO an agent terminal cleanly.

### 1.3 — Terminal search overlay (`terminal-search*`, ~520 LOC)

**`terminal-search.ts` (163 LOC) — pure search engine.** Two exported functions:

- `collectTerminalSearchMatches(buffer, query): TerminalSearchMatch[]` — walks the xterm `buffer.active`, builds _logical lines_ (collapsing xterm's wrapped physical lines into one searchable string), case-insensitively `indexOf`s the query, maps every match back to a physical `{row, col, length}` triple via the segment table. Critical detail: wrapped lines are concatenated for search, then the resolved match position is translated back to the physical row + col so `terminal.select()` highlights the right spot.
- `getNextTerminalSearchIndex(matches, currentMatch, direction): number` — cycles next/prev. Handles "current match is no longer in the array because buffer mutated" by binary-search-ish nearest-position fallback.

`TerminalSearchBufferLike` is a structural duck-type so tests can pass synthetic buffers (the test file constructs 4 lines manually and asserts match positions).

**`use-terminal-search.tsx` (255 LOC) — the hook.** Composes the engine with the live xterm Terminal:

- `Ctrl-F` / `Cmd-F` opens search (only when focus is inside `containerRef` — doesn't hijack global Cmd-F).
- Open: rAF-focus + select-all on the input.
- Query change: re-runs search with `reset: true, direction: 'next'`, calls `terminal.select(col, row, length)` + `terminal.scrollToLine(row - rows/2)` to center the match.
- Step next/prev: re-runs with the existing match anchor.
- Close: clears xterm selection, returns focus to the terminal via `onCloseFocus()`.
- Cross-terminal cleanup: a separate ref tracks "which terminal we last searched" so switching tabs clears the previous terminal's selection.

**`terminal-search-overlay.tsx` (100 LOC) — the UI.** Floating panel anchored top-right of the pane (or full-width when `fullWidth`), with an Input, prev/next chevrons, "N/M" counter, and a Close X. Enter steps next; Shift+Enter steps prev; Escape closes.

### 1.4 — Tests worth noting

- **`terminal-search.test.ts`** — pins `collectTerminalSearchMatches` against a synthetic 4-line buffer with wrapped + non-wrapped lines. Asserts match positions after wrap-unwrap-rewrap.
- **`terminalInputBuffer.test.ts`** — pins CSI/OSC sanitization, line editing, "real input" detection. ~235 lines, 100% coverage of the sanitizer state machine.
- **`terminalKeybindings.test.ts`** — pins the eight predicates against synthetic key events, mac and non-mac modifier permutations. ~215 lines.

These three suites port verbatim — they exercise pure functions.

---

## §2 — Daemon-side needs

### What we already have

`packages/daemon/src/server/ws-route.ts` already ships exactly the right primitives:

- **`PtyBridgeRegistry`** (192–280 in ws-route.ts) — `acquire(id, createBridge, {idleMs})` returns `{bridge, reused, release}`. Reference-counts WS clients per ID; idles a bridge after the last client disconnects (default 30 s); kills the bridge on idle timeout. Already handles the case where two clients open the same `/ws/pty/<id>` and share one PTY.
- **`PtyBridge`** (`packages/daemon/src/server/pty-bridge.ts`) — owns one `node-pty` child via the `PtyAdapter` abstraction. Ring-buffer-backed replay (256 KB default, configurable via `TMUX_IDE_PTY_RING_BUFFER_BYTES`). Pause/resume on backpressure. Atomic snapshot-on-subscribe is the same guarantee the reference codebase's `rpc.pty.subscribe` makes.
- **`/ws/pty/:id`** — wired in `daemon-embed.ts` upgrade handler. Auth-gated by `isUpgradeAuthorized`. ID is `decodeURIComponent`'d so deterministic IDs from `createScriptTerminalId` round-trip safely.
- **`handlePtyWebSocket(ws, id, opts?)`** — full I/O loop: spawn-on-first-connect, replay buffer on connect, forward stdout → WS, forward WS input → PTY, resize on resize message, cleanup on close.

The daemon already supports N concurrent PTYs keyed on arbitrary IDs. **No daemon work is required for multi-terminal mux.**

### What we need to add daemon-side

Small, mostly cosmetic:

1. **`POST /api/v2/action/terminal.create`** — server-side companion to `createScriptTerminalId`. Input: `{ session, scopeId, type?: 'shell' | 'setup' | 'run' | 'teardown', name?, script? }`. Output: `{ terminalId, name }`. The action computes the deterministic ID via the shared helper and registers a `Terminal` record (project, scope, name, type) in a JSON file under `${session.dir}/.tmux-ide/terminals.json`. Optional — `/ws/pty/:id` works with any client-generated ID today. Worth adding so the tab strip can persist names across reloads.
2. **`POST /api/v2/action/terminal.rename`** — `{ session, terminalId, name }`. JSON write.
3. **`POST /api/v2/action/terminal.delete`** — `{ session, terminalId }`. Kills the bridge via `PtyBridgeRegistry.delete(id)` + removes the record. The registry's `delete` already exists.
4. **`GET /api/project/:name/terminals`** — list. Returns the `Terminal[]` from `terminals.json` PLUS live `{running, cols, rows}` from `registry.peek(id)` for each. Used by the tab strip on mount to restore tab labels.
5. **WS frame `terminal.list.changed`** — broadcast on the existing `/ws/events` channel after create / rename / delete. Other panels (e.g. command palette) can react.

Total daemon work: ~3–4 hours. No new dependencies, no schema changes (JSON file, not SQLite — the metadata is small and rebuildable).

### Critical sequencing note

**Scrollback retention on tab switch hinges on the off-screen `xterm-host` pattern** (§1.2). If the renderer disposes + recreates the `FrontendPty` on every tab switch, scrollback is gone. The host pattern + `mount()`/`unmount()` API are non-negotiable for the UX we want. Daemon-side this is already free — the ring buffer survives across client connects.

---

## §3 — Solid port targets

| Reference                                           | Port target                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/terminals.ts`                           | `packages/contracts/src/terminals.ts`                                        | Pure — port verbatim. `createScriptTerminalId` uses Web Crypto `SubtleCrypto.digest` for the hash (no Node deps).                                                                                                                                                                                                                                              |
| `src/renderer/lib/pty/xterm-host.ts`                | `dashboard/src/lib/pty/xterm-host.ts`                                        | 20-line copy. Solid-friendly already (no React).                                                                                                                                                                                                                                                                                                               |
| `src/renderer/lib/pty/pty.ts` (FrontendPty)         | `dashboard/src/lib/pty/FrontendPty.ts`                                       | Port the class verbatim. Replace `events.on(ptyDataChannel, …)` with the daemon's WS `/ws/pty/:id` data frames; replace `rpc.pty.subscribe` with the WS init handshake (replay buffer arrives on connect already). Add a `Set<FrontendPty>.all` static for app-wide theme broadcasts.                                                                          |
| `src/renderer/lib/pty/pty-session.ts`               | `dashboard/src/lib/pty/pty-session.ts`                                       | Replace MobX observable + `onBecomeObserved` with Solid `createSignal`. The "first reader auto-connects" pattern collapses to: components that need it call `session.connect()` in `onMount`.                                                                                                                                                                  |
| `src/renderer/lib/pty/pty-pane.tsx`                 | `dashboard/src/components/Terminal/PtyPane.tsx`                              | Solid component. Mount/unmount via `onMount`/`onCleanup`. The forwardRef `{focus}` pattern becomes `props.handleRef?.({focus, sendInput})`.                                                                                                                                                                                                                    |
| `src/renderer/lib/pty/use-pty.ts` (602 LOC)         | `dashboard/src/lib/pty/usePty.ts`                                            | The biggest port. React refs + `useEffect` deps map to Solid `createEffect` + signals. The cell-metrics + ResizeObserver loop stays. Keybinding dispatch tables (the eight predicates) stay pure.                                                                                                                                                              |
| `src/renderer/lib/pty/pane-sizing-context.tsx`      | `dashboard/src/lib/pty/PaneSizingContext.tsx`                                | Solid `createContext` keyed on `paneId`. Module-level `paneRegistry: Map<string, HTMLDivElement>` ports verbatim. Resize-broadcast loop unchanged.                                                                                                                                                                                                             |
| `src/renderer/lib/pty/pty-pool-provider.tsx`        | `dashboard/src/lib/pty/TerminalPoolProvider.tsx`                             | 14 LOC, trivial.                                                                                                                                                                                                                                                                                                                                               |
| `src/renderer/lib/pty/pty-dimensions.ts`            | `dashboard/src/lib/pty/dimensions.ts`                                        | Pure — copy.                                                                                                                                                                                                                                                                                                                                                   |
| `src/renderer/lib/pty/pty-input-buffer.ts`          | `dashboard/src/lib/pty/inputBuffer.ts`                                       | Pure state machine — copy + port the test verbatim.                                                                                                                                                                                                                                                                                                            |
| `src/renderer/lib/pty/pty-keybindings.ts`           | `dashboard/src/lib/pty/keybindings.ts`                                       | Pure — copy + port the test.                                                                                                                                                                                                                                                                                                                                   |
| `src/renderer/lib/pty/prompt-injection.ts`          | `dashboard/src/lib/pty/promptInjection.ts`                                   | Pure — copy. Useful for chat-solid's "send to terminal" affordance once it lands.                                                                                                                                                                                                                                                                              |
| `src/renderer/lib/pty/terminal-search.ts`           | `dashboard/src/lib/pty/terminalSearch.ts`                                    | Pure — copy + port the test.                                                                                                                                                                                                                                                                                                                                   |
| `src/renderer/lib/pty/use-terminal-search.tsx`      | `dashboard/src/lib/pty/useTerminalSearch.ts`                                 | Solid signal store: `isSearchOpen`, `searchQuery`, `searchStatus`. The rAF-focus + xterm `select()` + `scrollToLine()` calls stay the same.                                                                                                                                                                                                                    |
| `src/renderer/lib/pty/terminal-search-overlay.tsx`  | `dashboard/src/components/Terminal/SearchOverlay.tsx`                        | Solid component with the same UX (Enter → next, Shift+Enter → prev, Escape → close). Uses the existing Solid Input primitive in `dashboard/src/components/ui/`.                                                                                                                                                                                                |
| **Current `dashboard/src/components/Terminal.tsx`** | Refactor to render a `PtyPane` instead of being a single-monolith xterm host | The current 249-LOC Solid Terminal duplicates the FrontendPty role + opens its own WS. The port collapses it: one new `<TerminalSurface>` component owns the tab strip, mounts a `TerminalPoolProvider` once, renders one `<PtyPane sessionId={activeId} pty={ptyForId(activeId)} />` for the active tab, leaves the others living off-screen in `xterm-host`. |

**Solid context vs. MobX store.** The reference codebase uses MobX `observable.box` + `onBecomeObserved` for session lifecycle. Solid's `createSignal` is the direct equivalent for the reactive bit; the "first reader auto-connects" needs to become an explicit `onMount(() => session.connect())` at the component level. Slightly more verbose; eliminates one indirection.

---

## §4 — Phases

### G20-P1 — Registry + multi-PTY plumbing (~1.5 days)

Scope: port the registry primitive, FrontendPty class, PtySession, off-screen host, dimensions, input buffer, keybindings, prompt injection. **No UI yet** — just the platform.

Files:

- `packages/contracts/src/terminals.ts` — shared helper (`createScriptTerminalId`) + types.
- `dashboard/src/lib/pty/{xterm-host,FrontendPty,pty-session,dimensions,inputBuffer,keybindings,promptInjection}.ts`.
- `dashboard/src/lib/pty/TerminalPoolProvider.tsx`, `PaneSizingContext.tsx`.
- Daemon: `POST /api/v2/action/terminal.{create,rename,delete}` + `GET /api/project/:name/terminals` + the WS frame `terminal.list.changed`. ~3 hours.

Acceptance: can open two `FrontendPty(id)` instances against the same daemon (different IDs), each connects to `/ws/pty/:id`, scrollback survives a fake "switch active" toggle that calls `pty.unmount() / pty.mount(target)` without disposing the Terminal.

**Effort:** ~12 hours.

### G20-P2 — Search overlay (~0.5 day)

Scope: port the pure engine + the Solid hook + the overlay component.

Files: `terminalSearch.ts`, `useTerminalSearch.ts`, `Terminal/SearchOverlay.tsx`, the search test.

Acceptance: Cmd-F / Ctrl-F opens overlay; query lights matches in xterm via `terminal.select()`; Enter / Shift-Enter steps; counter shows "N/M"; Escape closes and returns focus to the terminal.

**Effort:** ~4 hours.

### G20-P3 — BottomPanel-style tabs 1→N (~1 day)

Scope: the user-facing tab strip + the multi-bridge UX.

Pieces:

- New `<TerminalSurface>` Solid component: tab strip on top, single `<PtyPane>` below.
- Tab strip state: per-session `{ id, name, isActive, hasUnreadOutput }`. Use the deterministic ID for the default "shell" tab (`createScriptTerminalId({ projectId, scopeId: dir, type: 'run', script: '$SHELL -l' })`) and call `terminal.create` for user-named tabs.
- Add tab: opens a new shell PTY.
- Close tab: confirms if still running (PTY exit > 0), then calls `terminal.delete`.
- Rename tab: double-click on the tab name, inline edit, debounced `terminal.rename`.
- "+" button: spawns a new shell with a default name.
- Keybinds: Cmd-T new tab, Cmd-W close, Cmd-Shift-T reopen, Cmd-1..9 jump.
- Persist active tab + tab order in `terminals.json` so reloads land on the same tab.

The off-screen `xterm-host` makes the tab switch feel instant. Mount cost is one DOM `appendChild` + a Canvas refresh — ~1 ms.

**Effort:** ~8 hours.

### Totals

| Phase     | Scope                           | Effort                     |
| --------- | ------------------------------- | -------------------------- |
| G20-P1    | Registry + multi-PTY plumbing   | ~12 h                      |
| G20-P2    | Search overlay                  | ~4 h                       |
| G20-P3    | Tab strip + BottomPanel surface | ~8 h                       |
| **Total** |                                 | **~24 h (~3 person-days)** |

---

## §5 — Open questions

1. **Per-tab xterm vs. shared with split panes.** Recommendation: **per-tab xterm, one tab = one PTY = one xterm.** The reference codebase's `PaneSizingProvider` is built for split-pane layouts (chat agent + sidebar terminal) — that pattern is overkill for a BottomPanel-style tab strip and adds resize-broadcast complexity. Land per-tab now; add split-pane later if a real product need shows up (e.g. "show two terminals side by side for diffing log output"). The off-screen host already makes the data model right: N FrontendPty instances, exactly one mounted at a time. Split-pane just changes how many can be mounted.
2. **Scrollback retention strategy.** Recommendation: **off-screen `xterm-host` only.** The Terminal lives for the session lifetime. 100k lines of scrollback × few hundred bytes per line ≈ 30 MB peak per terminal — fine for a dev tool. Don't persist scrollback to disk; close = lose. The daemon's ring buffer (256 KB by default) covers reconnects after a brief network blip.
3. **Deterministic ID for the default shell tab.** Recommendation: yes, use `createScriptTerminalId({ projectId: session.name, scopeId: session.dir, type: 'run', script: '$SHELL -l' })` for tab 0. Means reopening tmux-ide on the same session reuses the running shell instead of spawning a fresh one — preserves scrollback across browser reloads even if the user closed the tab. For user-named extra tabs, fall through to a UUID (renaming shouldn't change the ID — the name is metadata only).
4. **`PaneSizingContext` — port or skip?** If we go per-tab (no split panes), we don't need it for P1/P2/P3. The active tab's `<PtyPane>` resizes its own PTY; background tabs share dimensions because they all live in the same off-screen host with `width: 1px; height: 1px` (no need to resize them until they become active, at which point `mount(target, targetDims)` resizes BEFORE attaching). Recommend: defer until split-pane lands.
5. **Tab labels for background output.** Reference codebase tracks `onFirstMessage` / `onActivity` to flash a tab indicator when a background terminal produces output. Worth porting for P3 — the data is free (it's a `Terminal.onData` listener) and the UX win is real. ~30 min addition to the P3 budget.
6. **Cmd-T / Cmd-W global hotkeys vs. tab-strip-scoped.** The current dashboard already has a command-palette + keybind system. Recommend: register the four shortcuts (new / close / reopen / jump-N) as commands so they show up in the palette AND have hotkeys, instead of bare `addEventListener('keydown')`. Adds 30 min to P3.
7. **`pty-input-buffer.ts` (the sanitizer) — port it now or later?** The 301-LOC sanitizer is used by chat surfaces that want to record "what the user actually typed in the terminal" (e.g. for terminal-context attachments in chat-solid). It's not needed for the BottomPanel-style terminal UX itself. Recommend: port in P1 with the other pure modules (the file is pure, the test is comprehensive, porting later means rebuilding the test context) but don't wire it anywhere yet. Future chat-terminal-context feature picks it up for free.
8. **Web terminal vs. native shell on macOS.** Out of scope. Today's tmux-ide PTY is `node-pty` on the daemon side — the renderer is always xterm.js. No platform branching needed.
9. **Theme switching.** The reference codebase's `FrontendPty.applyThemeToAll(theme)` is a static method that iterates `FrontendPty.all`. Port the same pattern: the existing dashboard `applyTheme` should call `FrontendPty.applyThemeToAll(readXtermCssVars())` after CSS variables update. ~5 lines.
10. **WebGL vs. Canvas2D renderer.** The reference codebase uses `CanvasAddon`. The current Solid Terminal in `dashboard/src/components/Terminal.tsx` uses `WebglAddon`. WebGL is faster on dense output but has more "context-lost" failure modes (especially on Chromium with multiple GPU-using surfaces). Recommend: try Canvas2D in the port; switch to WebGL only if we measure a real perf gap on the agent-streaming case. The reference codebase's choice is informed by Electron experience — same tradeoff applies to a web-shell context.

---

## TL;DR

The daemon already ships exactly the right multi-terminal primitive: `PtyBridgeRegistry` keyed on string IDs, `/ws/pty/:id` upgrade routing, atomic snapshot-on-subscribe with a 256 KB ring-buffer replay. The gap is entirely renderer-side: the current `dashboard/src/components/Terminal.tsx` is a single-tab monolith that owns its own WS connection and gets disposed when it unmounts. **~3 person-days** total to land tabs + search + scrollback-across-switches, including the small daemon-side `terminal.*` actions to persist tab names.

**Top three hardest things to port:**

1. **`use-pty.ts` (602 LOC).** Resize debouncing across mount/unmount cycles, cell-metrics extraction from xterm internals, ResizeObserver lifecycle, mac-vs-linux keybind dispatch, drag-and-drop into the terminal, `onFirstMessage` / `onActivity` / `onExit` hooks. Easy to under-port; budget a day.
2. **The off-screen `xterm-host` pattern.** Conceptually small (20 LOC) but the way it interacts with FrontendPty.mount/unmount is the whole reason tab switches are instant + lossless. Getting the Canvas2D refresh-on-reparent right (the `requestAnimationFrame(() => t.refresh(0, t.rows-1))` after `appendChild`) is non-obvious and easy to drop.
3. **`PaneSizingContext` — if we end up needing it.** The 60ms-debounced broadcast to background sessions has subtle ordering ("newly-added session needs current dims even if no resize is pending", "no dedup because background PTYs may have missed the resize") that's easy to mis-port. Recommendation: defer until split-pane is a real product need.

The single biggest leverage point: **the daemon side is already done.** Existing `PtyBridgeRegistry` + `/ws/pty/:id` + `PtyBridge`'s ring buffer satisfy every requirement of the reference codebase's multi-terminal renderer. The only daemon work needed is ~3 hours of optional metadata endpoints to persist tab names across reloads. The Solid port is pure renderer work.
