# context/ audit — adoptable ideas from sibling projects

Audit of the 8 reference projects in `context/` (besides t3code which is the architectural reference) — what each does and what tmux-ide can learn from. Same pattern as `docs/fold-audit.md` and `docs/unify-audit.md`.

> **House rules** (per memory):
>
> - `feedback_architecture_preferences.md`: RSC shell + siloed framework blocks, **no worktrees**, engineering rigor first.
> - `feedback_design_reference.md`: t3 is the design reference; Solid silos used aggressively; TUI is legacy.
> - Anything that brings in worktrees is **out of scope** regardless of how useful it looks.

---

## 1. dmux — tmux + worktrees, parallel agents

**Stack:** TypeScript, npm-installable CLI (`npm i -g dmux`).

**What it does:** Same shape as tmux-ide today (pane per task), but worktree-based isolation. UX gem: press `m` in any pane to open a menu — Merge / Create GitHub PR / etc.

**Top features:**

- AI naming for branches and commit messages
- Multi-select agents per prompt (Claude Code / Codex / OpenCode / Gemini / Amp / Crush / Copilot / etc.)
- Smart merge: auto-commit, merge, cleanup in one step
- "Press `n` to create a new pane, type a prompt, pick one or more agents."

**Adoptable:**

- ✅ **Pane menu UX** — single-key (`m`) opens a contextual action menu in any pane (Merge / Send to / Dispatch task / etc.). Maps to a tmux-ide command palette overlay.
- ✅ **Multi-select agent launch** — picking N providers from one prompt creates N panes that all work on the same task.
- ✅ **AI-named branches** — when a task spawns a branch, name it via the active LLM from the task title.

**Skip:** worktree-per-pane (explicit user veto).

---

## 2. emdash — YC W26 ADE, 24 CLI agents, remote dev

**Stack:** Electron + Vite + React. Cross-platform desktop app.

**What it does:** "Agentic Development Environment." Run multiple agents in parallel, locally OR over SSH on remote machines. Linear / GitHub / Jira ticket integration. Diff review, PR creation, **CI/CD checks**, merge — all in-app.

**Top features:**

- 24 CLI agents supported (Claude Code, Codex, OpenCode, Gemini, Amp, ...)
- Ticket pass-through: Linear / GitHub / Jira → agent
- SSH/SFTP remote development (SSH agent + keychain credential storage)
- CI/CD check display inline
- Diff review + PR file
- Desktop installers for mac (arm/x64), Windows, Linux

**Adoptable:**

- 🎯 **Ticket integration** — `/v2/tasks` and chat composer accept Linear / GitHub / Jira URLs, dereference to ticket title + body, auto-create a tmux-ide task from the ticket. Adds an "Open ticket" button per task.
- 🎯 **CI/CD checks in diff view** — when on a branch with an open PR, fetch GitHub Actions check status and render inline in the Diffs Solid widget. Click to expand check output.
- 🎯 **SSH remote workspaces** — `tmux-ide attach user@remote:/path/to/repo` mounts a remote workspace. Daemon spawns on the remote, dashboard tunnels through SSH. Credentials in macOS Keychain (already a path via `app-electron`).
- ✅ **Multi-agent UI patterns** — emdash's view of N parallel agents may inform our `MissionControl` Solid widget's agent strip.

**Skip:** worktree isolation (same veto).

---

## 3. opencode — CLI agent platform

**Stack:** TypeScript / bun. Many installers (npm, scoop, choco, brew, pacman, mise, nix). Has BETA desktop builds.

**What it does:** AI-powered development tool — appears to be a CLI-first agent runner (already a provider tmux-ide supports via the ACP layer).

**Top features:**

- Broad install matrix (8+ package managers)
- Desktop builds in BETA
- Provider for our `provider-registry` already

**Adoptable:**

- ✅ **Install matrix breadth** — tmux-ide is npm-only today. Adopt opencode's pattern: brew formula, scoop, paru AUR, nix flake.
- ✅ Continue treating opencode as a tier-1 ACP provider (already done).

**Skip:** their desktop chrome (we have our own + Electron via app-electron).

---

## 4. pierre — already absorbed

**Stack:** Empty README; this is the `@pierre/diffs` library referenced by goal-06 ("Fold @pierre/diffs in"). Already folded into the codebase.

**Adoptable:** nothing new.

---

## 5. smfs — Supermemory filesystem mount

**Stack:** TypeScript + `bash/` virtual tool. Curl-based installer.

**What it does:** Exposes a Supermemory container as a real filesystem directory. Mount once, then `ls`, `cat`, and `grep` your memory like any folder.

**Top features:**

- `smfs mount agent_memory` → ./agent_memory/ as a live FUSE-style mount
- Semantic search via `smfs` CLI
- Virtual `bash/` tool for runtimes without local FS (Workers, edge, browser)
- Memory generation path filtering (`--memory-paths "/notes/,/journal.md"`)

**Adoptable:**

- 🎯 **Memory-as-FS pattern for `.tmux-ide/library/`** — today the library/ dir is a static set of `.md` files injected into agent prompts. Adopt smfs's pattern: treat the library as a queryable surface (semantic search via supermemory backend) so agents can `grep` or `cat` knowledge in tool calls.
- ✅ **Path-scoped memory generation** — `tmux-ide skill` could grow a `--scope` flag matching smfs's path filters.

**Skip:** the FUSE mount itself (we don't need it locally; library/ files are already on disk).

---

## 6. supermemory — full memory engine

**Stack:** Full-stack. #1 on LongMemEval, LoCoMo, ConvoMem benchmarks.

**What it does:** "Memory and context layer for AI." Extracts facts from conversations, builds user profiles, handles knowledge updates and contradictions, automatic forgetting. Multi-modal (PDFs, images via OCR, videos via transcription, code via AST-aware chunking). Connectors for Drive/Gmail/Notion/OneDrive/GitHub.

**Top features:**

- Fact extraction with temporal awareness + contradiction handling
- User profiles (stable facts + recent activity, ~50ms lookup)
- Hybrid search (RAG + Memory in one query)
- Connectors with real-time webhooks
- Multi-modal extractors

**Adoptable:**

- 🎯 **Per-thread fact extraction** — after a chat turn settles, run a lightweight fact extractor over the messages and append to a `.tmux-ide/library/learnings.md` style file. Subsequent prompts include extracted facts.
- 🎯 **AST-aware code chunking** — for skill files that reference code, chunk by function/class rather than line count. Already a backlog idea for the skill-registry.
- ✅ Could integrate supermemory as a _service_ (their hosted API) if we want managed memory — but a local-only path keeps tmux-ide self-contained.

**Skip:** the full connector ecosystem (Gmail/Drive/etc are out of scope for a dev IDE).

---

## 7. wterm — DOM-rendered web terminal in Zig+WASM

**Stack:** Zig → WASM (~12 KB core), with `@wterm/react`, `@wterm/vue`, `@wterm/dom`, `@wterm/ghostty`, `@wterm/just-bash`, `@wterm/markdown` packages.

**What it does:** Terminal emulator that renders to **DOM** rather than canvas. Native text selection, copy/paste, browser find, screen reader support — all free because it's real DOM.

**Top features:**

- ~12 KB Zig WASM core
- DOM rendering (a11y + native selection wins)
- Dirty-row tracking via `requestAnimationFrame` (perf)
- Themes via CSS custom properties (matches our design token system)
- Alternate screen buffer (vim/less/htop work)
- 24-bit color, scrollback ring buffer, ResizeObserver auto-resize, WebSocket transport

**Adoptable:**

- 🎯 **Replace xterm with @wterm/react** — our `dashboard/components/Terminal.tsx` uses xterm. wterm gives:
  - Better accessibility (screen-reader compatible)
  - Native browser-find / selection (no xterm hacks)
  - CSS-custom-properties theming integrates directly with our design tokens (PR 1)
  - Smaller bundle (12 KB vs xterm's ~150 KB)
- 🎯 **`@wterm/markdown`** — render markdown directly in terminal panes. Could power a chat-in-terminal mode.
- ✅ **`@wterm/just-bash`** — in-browser bash for offline/sandbox demos.

**Skip:** ghostty backend if we want minimum bundle (12 KB core is enough for our use).

---

## 8. www-sacred (SRCL) — terminal-aesthetic React components

**Stack:** React component library. Live demo at sacred.computer.

**What it does:** Open-source React components with terminal aesthetics — precise monospace spacing, line heights, and copy-paste-ready primitives. Modular.

**Top features:**

- "Precise monospace character spacing and line heights" — matches our retired tui/\* intent in production-quality form
- Copy-paste implementations (no opinionated package boundary)
- CLI framework primitives (their `npm run script example` pattern)

**Adoptable:**

- 🎯 **SRCL component pull** — replace our retired `dashboard/components/tui/` with cherry-picked SRCL components: their monospace List, ListItem, Card, Drawer, ModalDialog, Form components. We already retired the tui/ dir; SRCL is the production-quality replacement that fits our design-token surface.
- ✅ **CLI framework primitives** — our `packages/daemon/src/widgets/` daemon-side TUI could potentially adopt SRCL's primitives if they have an SSR/Node-side rendering mode.

**Skip:** the demo site infra (Vercel hosting etc).

---

## Proposed adoption plan — 6 sub-tasks

Sub-tasks suitable for parallel agent dispatch. Each: title, files in scope, deps, test gate.

### C1 — emdash ticket integration

**Scope:** Linear/GitHub/Jira URL dereferencing in tasks + chat composer.
**Files:**

- New: `dashboard/lib/tickets/{linear,github,jira}.ts` (resolvers)
- New: `dashboard/lib/tickets/index.ts` (unified ticket type + paste handler)
- `dashboard/components/chat-v2/ComposerInput.tsx` (paste handler)
- `packages/v2-solid-widgets/src/widgets/TasksView.tsx` (ticket badge on task rows)
- `packages/daemon/src/command-center/server.ts` (cache + proxy for rate-limit safety)
  **Deps:** none.
  **Test gate:** `pnpm check`; paste a Linear URL into the composer → renders ticket title.

### C2 — emdash CI/CD checks in Diffs view

**Scope:** GitHub Actions check status surfaced inline in the Diffs Solid widget when on a branch with an open PR.
**Files:**

- New: `packages/daemon/src/command-center/github-checks.ts` (fetcher; uses `gh` CLI or GitHub API)
- New endpoint: `GET /api/project/:name/git/checks?branch=…`
- `packages/v2-solid-widgets/src/widgets/DiffsViewer.tsx` (top strip showing check status)
- `dashboard/components/diffs-viewer-bridge.tsx` (passes check data)
  **Deps:** none.
  **Test gate:** `pnpm check`; on a branch with a PR, Diffs view shows green/red check icons.

### C3 — wterm Terminal replacement

**Scope:** Swap xterm for `@wterm/react` in `dashboard/components/Terminal.tsx`.
**Files:**

- `dashboard/components/Terminal.tsx` (rewrite)
- `dashboard/package.json` (add `@wterm/react`, remove `xterm`)
- Possibly `packages/v2-solid-widgets/src/widgets/BottomPanel.tsx` (terminal tab consumer)
  **Deps:** none.
  **Test gate:** Terminal in bottom panel renders + handles input + browser-find works.

### C4 — SRCL component adoption (replace retired tui/\*)

**Scope:** Pull 3–5 polished SRCL components into a new `packages/v2-solid-widgets/src/srcl/` namespace.
**Files:**

- New: `packages/v2-solid-widgets/src/srcl/{List,Card,Drawer,ModalDialog,Form}.tsx`
- License attribution: `licenses/SRCL-NOTICE` (their license; likely MIT)
  **Deps:** none.
  **Test gate:** Each new component has ≥2 tests; visual parity with SRCL demo.

### C5 — dmux pane menu UX

**Scope:** Press `m` (or Cmd+Shift+M) in any tmux pane to open a contextual menu — Merge / Dispatch task / Send to lead / etc.
**Files:**

- New: `packages/daemon/src/widgets/pane-menu/` (TUI widget)
- `bin/cli.ts` or `packages/daemon/src/cli.ts` (subcommand binding)
- `ide.yml` schema for declaring per-pane menu actions
  **Deps:** none.
  **Test gate:** Pressing `m` in a tmux-ide session opens the menu; selecting an action fires.

### C6 — supermemory fact-extraction + smfs library

**Scope:** Per-thread fact extraction → `.tmux-ide/library/learnings.md`. Skill-registry adopts AST-aware chunking.
**Files:**

- New: `packages/daemon/src/chat/fact-extractor.ts`
- `packages/daemon/src/lib/skill-registry.ts` (AST-aware chunking)
- `packages/daemon/src/chat/reactors/reactor.ts` (subscribe to turn-completion events)
  **Deps:** Goal-14 reactor (T092/T094) — already shipped.
  **Test gate:** After 3 chat turns, `.tmux-ide/library/learnings.md` grows with extracted facts; skill-registry returns smaller, more-focused chunks for code skills.

---

## Priority recommendation

Rank by perceived user value × implementation cost:

1. **C3 wterm Terminal replacement** — biggest immediate UX win (real accessibility + selection), modest cost. The fact the current terminal still feels rough makes this the highest-leverage swap.
2. **C1 ticket integration** — pure workflow win, plays directly into the agent-team mission lifecycle.
3. **C4 SRCL components** — fills the gap we left when retiring `dashboard/components/tui/`. Improves visual polish quickly.
4. **C2 CI/CD checks in Diffs** — natural extension of the Diffs Solid widget; surfaces PR status without leaving the IDE.
5. **C6 fact extraction** — long-tail value (agents get smarter over time) but requires the most engineering scaffolding.
6. **C5 pane menu** — nice UX but less unique to what tmux-ide already offers via `tmux-ide` CLI.

**Suggested first dispatch:** C3 + C1 + C4 in parallel (Pane 1 / 2 / 3) — three independent surfaces. C2/C6/C5 follow in a second round.
