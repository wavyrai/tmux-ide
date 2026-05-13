# tmux-ide ROADMAP

Single source of truth for where we are, what's in flight, and what's next on the path to a full agent-based IDE. Updated as we go.

> **Reading order:** §1 (state of the world) → §2 (in flight) → §3 (staged plan) → §4 (reference matrix) → §5 (audit index) → §6 (goal index).

---

## §1 — Where we are (current state)

**~65% of "full agent-based IDE."** Agent orchestration is rich; developer-tooling side is thin.

### Shipped + working

| Layer | What | Status |
|---|---|---|
| Agent orchestration | tmux-pane teams, orchestrator daemon, mission/goal/task system, validation contracts | ✅ |
| Provider abstraction | ProviderCapabilities + ProviderApprovalPolicy + multi-provider (claude-code, codex) | ✅ Goal-14 P3 |
| Persistence | Sqlite event store + projections + reactor + Effect runtime (daemon-side) | ✅ Goal-14 P1+P2 |
| Chat surface | Flat transcript, real-time streaming, @-mentions, draft persistence, provider switcher, markdown links, image preview, plan apply/reject, permission dialog | ✅ ~60% t3 parity |
| Diffs viewer | Solid widget with hunk navigation | ✅ |
| Tasks / Plans / Mission Control / Costs / Activity / Explorer / Skills / Kanban / CommandPalette / Inspector / BottomPanel | 12 Solid widgets | ✅ |
| File explorer + preview | Solid split-pane with click-to-preview | ✅ |
| IDE shell | V2ActivityBar + sidebar + splittable editor + Inspector + BottomPanel + StatusBar | ✅ |
| Chrome toggles | Cmd+B / Cmd+J / Cmd+Alt+B / Cmd+I + StatusBar toggle buttons | ✅ |
| Settings route | /v2/settings — themes, terminal prefs, keybinds, providers | ✅ WN4 |
| Skills CRUD | Create / edit / delete via UI + daemon endpoints | ✅ WN6 |
| Output channels | BottomPanel live SSE log streams | ✅ WN1 |
| URL sync | `?view=` persisted across reloads | ✅ WN2 |
| Widget gallery | `/v2/widgets` tile grid + filters + session-aware TUI links | ✅ |
| Wire-coverage tests | Pattern + helper applied across all bridges | ✅ T1 |
| CI dev-server smoke | `.github/workflows/smoke.yml` runs Playwright on every push | ✅ T3 |
| E2e suite | Triaged: 14 deleted, 1 kept | ✅ T2 |

### Architecture in motion

| | Status |
|---|---|
| Goal-16 (rip out Next, Solid + Effect everywhere) | 🔄 P0 ✅ + P1 ✅ (dashboard-solid scaffolded + /v2/widgets ported) — **P2 in flight: port /v2/project/[name] IDE shell** |

---

## §2 — In flight right now

| Pane | Task | Stage |
|---|---|---|
| 1 (Agent 5) | **G16-P2**: port `/v2/project/[name]` IDE shell to Solid | The big one |
| 2 | **W7**: terminal-context chip retire-or-migrate | Small wire |
| 3 | **W8**: chat.thread.delete wire end-to-end | Small wire |

When this round commits:
- Chat W: 8/8 closed
- App WN: 8/11 closed (WN8 + WN10 + WN11 remain)
- Goal-16: P0 + P1 + P2 done (50%)
- T4 (coverage thresholds) still queued as small follow-on

---

## §3 — Staged plan to 100%

### Stage A — Finish Goal-16 (Solid migration) — ~3 days

| Phase | What | Days |
|---|---|---|
| G16-P2 | Port `/v2/project/[name]` IDE shell | 🔄 in flight |
| G16-P3 | Port remaining routes: `/v2/setup`, `/v2/settings`, `/v2/terminal/[id]`, `/v2/widget/[name]` | 1 |
| G16-P4 | Cutover — delete `dashboard/`, rename `dashboard-solid/` → `dashboard/`, update CI + daemon's `serveDashboard()` + `package.json` `files` field | 0.5 |
| Closing wires | WN8 (branch switcher), WN10 (Activity right-rail), WN11 (centralize view registry), W7+W8 leftovers | 1 |
| T4 coverage thresholds | enable v8 coverage in vitest + CI gate | 0.5 |

**→ State: pure Solid + Effect codebase. No React. No bridges. No Turbopack. ~70%.**

### Stage B — Code editor (Goal-17) — ~5-7 days

Adopt **emdash's Monaco integration** (the only mature reference in `context/`).

| Phase | What | Days |
|---|---|---|
| G17-P0 | Audit doc — map every emdash Monaco file to its Solid port | 0.5 |
| G17-P1 | Port `monaco-pool.ts` + `monaco-config.ts` + `monaco-themes.ts` + `monaco-model-registry.ts` + `use-monaco-lease.ts` → `dashboard-solid/src/lib/monaco/` | 2 |
| G17-P2 | Per-filetype renderers (binary / image / markdown / svg / too-large) — adopt emdash's dispatch table | 1 |
| G17-P3 | `sticky-diff-editor.tsx` → Solid diff editor with hunk-by-hunk accept/reject | 1.5 |
| G17-P4 | Wire into Files view: click file → open in editor (Monaco) instead of preview-only | 1 |
| G17-P5 | Multi-file tabs + dirty state + save | 1 |

**→ State: actually edit files in the dashboard. ~80%.**

### Stage C — Git ops UI (Goal-18) — ~3-4 days

Adopt **emdash's git + PR layer**.

| Phase | What | Days |
|---|---|---|
| G18-P0 | Audit doc | 0.5 |
| G18-P1 | Port `git-utils.ts` + `git.ts` + branch picker UI (from emdash `use-branch-selection`) | 1 |
| G18-P2 | Port `github.ts` + `github-repository.ts` + `pull-requests.ts` → commit + push + create PR flows | 1.5 |
| G18-P3 | Port `check-runs.ts` + `checks-list.tsx` → CI/CD status inline in Diffs widget | 1 |

**→ State: full git workflow from inside the IDE. ~85%.**

### Stage D — Search across repo (Goal-19) — ~2 days

| Phase | What | Days |
|---|---|---|
| G19-P0 | Daemon: ripgrep-backed search endpoint (`/api/project/:name/search?q=&include=&exclude=`) | 0.5 |
| G19-P1 | Cmd+Shift+F surface in dashboard-solid — global search panel | 1 |
| G19-P2 | Replace flow (replace-in-file + replace-across-files w/ confirmation) | 0.5 |

**→ ~88%.**

### Stage E — Multi-terminal (Goal-20) — ~2 days

Adopt **emdash's terminal registry**.

| Phase | What | Days |
|---|---|---|
| G20-P1 | Port `shared/terminals.ts` registry pattern to daemon + Solid | 1 |
| G20-P2 | Port `terminal-search-overlay.tsx` + `use-terminal-search.tsx` | 0.5 |
| G20-P3 | BottomPanel multi-terminal tabs (1 → N) | 0.5 |

**→ ~92%.**

### Stage F — LSP-as-tool (Goal-21) — ~7-10 days

Adopt **opencode's LSP-as-tool pattern**.

| Phase | What | Days |
|---|---|---|
| G21-P0 | Audit doc (opencode's `packages/opencode/src/lsp/` + `src/tool/lsp.ts`) | 0.5 |
| G21-P1 | Daemon LSP service — language detection per workspace + LSP server lifecycle | 2 |
| G21-P2 | LSP-as-tool exposure: `lsp.hover`, `lsp.references`, `lsp.definition`, `lsp.completion`, `lsp.diagnostics` | 2 |
| G21-P3 | Wire LSP completion into Monaco editor (G17 dependency) | 2 |
| G21-P4 | Wire LSP into chat composer @-mention autocomplete (better than current string-match) | 1 |
| G21-P5 | Diagnostics in BottomPanel Problems tab | 1 |

**→ ~97% (real-IDE-grade).**

### Stage G — Distribution + polish (Goal-22) — ~2-3 days

Adopt remaining items from **`docs/npm-distribution-audit.md`** (N2-N5).

| Phase | What | Days |
|---|---|---|
| G22-P0 | N2: bundle-and-publish strategy — include `packages/` in published tarball | 0.5 |
| G22-P1 | N3-N4: trim src/ remnants, dashboard HTML export gate | 1 |
| G22-P2 | N5: smoke-test the published tarball end-to-end in CI | 0.5 |
| G22-P3 | Docs: README + installation guide + getting-started for end users | 0.5 |

**→ 100% — shippable, full agent-based IDE.**

---

## §4 — Reference matrix (which sibling project for which feature)

| Area | Primary reference | Why |
|---|---|---|
| Chat surface | `context/t3code` | best-in-class chat depth; Solid+Effect aligned |
| Architectural patterns (RSC orchestrator + siloed blocks, Effect runtime, sqlite event sourcing) | `context/t3code` | Goal-14 already aligned us here |
| Code editor (Monaco) | `context/emdash` | only mature Monaco integration in `context/` |
| Git ops UI (branch / commit / PR / CI checks) | `context/emdash` | full stack |
| Multi-terminal | `context/emdash` | registry + search overlay |
| Workspaces (lifecycle, registry) | `context/emdash` | most-mature model |
| LSP-as-tool | `context/opencode` | clean pattern of exposing LSP to agents |
| Terminal-aesthetic React components (legacy) | `context/www-sacred` (SRCL) | retired post-G16, no longer relevant |
| Memory / fact extraction | `context/supermemory` + `context/smfs` | future enhancement to `.tmux-ide/library/` |

**Vetoes:** worktree-per-task (`context/dmux`, `context/emdash`) — explicit user opposition. `t3code`'s `ThreadEnvMode = "worktree"` skipped.

---

## §5 — Audit index

All audits live in `docs/`:

| File | Mission | Status |
|---|---|---|
| `docs/fold-audit.md` | src/ ↔ packages/daemon canonical tree | ✅ executed (F1-F5) |
| `docs/unify-audit.md` | Legacy `(shell)/` + chat v1 + craft attribution + tui/ retirement | ✅ executed (U1-U6) |
| `docs/context-audit.md` | Adoptable patterns from sibling projects | ✅ doc (C1-C6 proposed; some now folded into staged plan) |
| `docs/widget-index.md` | Catalog of 24 widgets | ✅ + gallery shipped |
| `docs/chat-wiring-audit.md` | UI → bridge → daemon wires for chat-solid | ✅ executed (W1-W6, W8 done; W7 in flight) |
| `docs/app-wiring-audit.md` | UI → bridge → daemon wires for non-chat surfaces | ✅ executed (WN1-WN7 + WN9 done; WN8, WN10, WN11 remain) |
| `docs/npm-distribution-audit.md` | Publish architecture | ✅ doc (N1 done; N2-N5 deferred to Goal-22) |
| `docs/design-mapping-t3-to-tmux-ide.md` | Design token + spacing port | ✅ doc + 5 PRs landed |
| `docs/goal-14-architecture-parity.md` | t3 architectural patterns (RSC + siloed + Effect + sqlite + reactors + projections + ProviderApprovalPolicy + ProviderCapabilities) | ✅ 13 tasks shipped |
| `docs/goal-16-rip-out-next.md` | Next + React + bridges → Solid + Effect | 🔄 in flight (P0 ✅, P1 ✅, P2 in flight) |

---

## §6 — Goal index

| Goal | Title | Status |
|---|---|---|
| 1-12 | Earlier shell parity / migration goals | ✅ (per pre-session history) |
| **13** | Full t3 chat parity with tmux-as-tool | ✅ (5000+ LOC shipped) |
| **14** | t3 architecture parity (RSC + Effect + sqlite + projections + reactors + ProviderApprovalPolicy + ProviderCapabilities) | ✅ Phase 1+2+3 |
| 15 | Adopt Effect on the client (typed DI) | ❌ superseded by Goal-16 |
| **16** | Rip out Next, go Solid + Effect everywhere | 🔄 P0+P1 ✅, P2 in flight |
| 17 | Code editor — adopt emdash's Monaco | 📋 staged |
| 18 | Git ops UI — adopt emdash's git+PR layer | 📋 staged |
| 19 | Repo search (ripgrep + Cmd+Shift+F) | 📋 staged |
| 20 | Multi-terminal — adopt emdash's registry | 📋 staged |
| 21 | LSP-as-tool — adopt opencode's pattern | 📋 staged |
| 22 | Distribution + polish (N2-N5 + docs) | 📋 staged |

---

## §7 — Sequencing notes

**Why this order:**
- Goal-16 first because: every later stage is easier in the unified Solid+Effect codebase. Porting Monaco/git-ops/LSP into a mixed React+Solid app means doing it twice.
- Goal-17 (editor) before Goal-18 (git ops) because: diff editing requires editor; git UI uses diff editor.
- Goal-19 (search) and Goal-20 (multi-terminal) are independent parallel tracks once G17+G18 land.
- Goal-21 (LSP) waits for Goal-17 (Monaco) — LSP completion provider needs the editor surface.
- Goal-22 (distribution) is last — locks in the shippable v1.0 once everything works.

**Estimated total: ~25-30 days of focused agent work to 100%.**

---

## §8 — Open architectural calls

- **Editor library**: Monaco (emdash uses it) vs CodeMirror 6 (smaller, more Solid-native ecosystem). G17-P0 audit will decide.
- **LSP transport**: WebSocket vs Node-IPC for daemon ↔ LSP server. G21-P0 audit decides.
- **Settings storage**: still localStorage; consider moving to daemon-side (per-workspace `.tmux-ide/settings.json`) for portability between machines.

---

This roadmap is the source of truth. Audits + per-goal docs live alongside in `docs/`. Task tracker tracks fine-grained execution; this doc tracks strategic milestones.
