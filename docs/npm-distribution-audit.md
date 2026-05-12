# npm distribution audit — `tmux-ide`

> Audit only. The lead dispatches N1–N5 after this lands. Same pattern as
> the fold / unify / context audits.

## §1 Current state — what publishes today

Root `package.json` declares:

```json
{
  "name": "tmux-ide",
  "version": "2.1.5",
  "bin": { "tmux-ide": "bin/cli.ts" },
  "files": ["bin", "src", "scripts", "skill", "templates", "dashboard/out"],
  "engines": { "bun": ">=1.0" },
  "scripts": { "prepublishOnly": "npm run build:dashboard" }
}
```

`npm pack --dry-run` (run 2026-05-12) reports:

- **package size**: 5.9 MB packed / 28.2 MB unpacked / 700 files
- **top-level dirs in tarball**: `bin/ dashboard/ scripts/ skill/ src/ templates/` + `package.json README.md LICENSE`
- **`packages/` is excluded** — confirmed by inspecting each `npm notice` line.
- **`bin/cli.ts` (TypeScript, 19.2 kB)** AND **`bin/cli.js` (173 B shim)** both ship. Both have `#!/usr/bin/env bun`. `cli.js` does `import "./cli.ts"` — pure backward-compat alias, not a compiled entry point.
- **`src/`**: vestigial. After the canonical-tree fold (commits 15bba87, 022aafa, b6c1439, 20fc2c9, f1f1f5e) only `src/cli.test.ts`, `src/integration.test.ts`, `src/server/README.md`, `src/ui/web/base.css` remain — none are runtime.
- **`dashboard/out/`**: present but contains only `_next/` chunks + `fonts/`. **No `index.html`, no per-route HTML.** Build is stale (May 8 mtime) and incomplete; `prepublishOnly` rebuilds before publish but nothing gates the result.

The six workspace packages (`packages/{contracts,daemon,daemon-client,tmux-bridge,chat-solid,v2-solid-widgets}`):

- All are `private: true` **except** `@tmux-ide/daemon` (`publishConfig.access: "public"`).
- `chat-solid` and `v2-solid-widgets` have `dist/` outputs (vite); `contracts`, `daemon-client`, `tmux-bridge` ship from source (`"main": "src/index.ts"`) — fine inside the monorepo, **not consumable from npm**.
- `daemon` has a compiled `dist/`; `daemon-client` and `contracts` do not.
- Dashboard depends on `@tmux-ide/{chat-solid,contracts,v2-solid-widgets}` via `workspace:*` — those references break at publish time unless replaced.

Daemon → dashboard wiring (`packages/daemon/src/command-center/static.ts:32` `resolveDashboardOut()`): walks up looking for a sibling `dashboard/out`. Default port 6060 (`packages/daemon/src/command-center/index.ts:15`). `app.use("*", serveDashboard())` mounts the static export.

`scripts/postinstall.js`: gated on `npm_config_global === "true"`, writes `~/.claude/skills/tmux-ide/SKILL.md` + flips `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json`. Idempotent, no dev deps required. **Safe.**

`scripts/prepublish-check.mjs`: gates on `dashboard/out/index.html` and source-newer-than-output. **Not wired into `prepublishOnly`** — only invoked manually.

## §2 Gaps — concrete failure modes

A user runs `npm i -g tmux-ide && tmux-ide` today. Step-by-step:

| # | What happens | Why |
|---|---|---|
| 1 | `npm install` succeeds, `postinstall` writes `~/.claude` if `--global`. | OK. |
| 2 | `tmux-ide` invokes `bin/cli.ts`. | `#!/usr/bin/env bun` → on a node-only machine: **`env: 'bun': No such file or directory`**. |
| 3 | If user has bun: bun loads `bin/cli.ts`. | First import: `import { launch } from "../packages/daemon/src/launch.ts"`. Tarball has no `packages/` → **`Error: Cannot find module '<install-dir>/packages/daemon/src/launch.ts'`**. |
| 4 | Even if the daemon resolved, the daemon imports `@tmux-ide/contracts` + `@tmux-ide/tmux-bridge`. | Those packages are `private: true` and aren't on npm. Resolution fails inside `node_modules`. |
| 5 | If the daemon started, `serveDashboard()` would `resolveDashboardOut()`. | Walks up looking for `dashboard/out`. The tarball ships `dashboard/out/` but it has no `index.html` → root `/` returns 404. |

Five distinct failure modes, two of them blocking before the daemon can even start. The published artifact is currently **non-functional end-to-end**.

Secondary issues:

- **`engines.bun >= 1.0`** is declarative; npm prints a warning but doesn't fail. Sends the wrong signal — we want node-only at the user surface.
- **`src/` ship list** leaks four test/asset files that have no runtime role post-fold — wastes 30 kB and confuses anyone reading the tarball.
- **`pack:check` passes** because npm only validates that the tarball can be created. It doesn't run the CLI. CI is green while the artifact is broken.

## §3 Proposed fixes — five sub-tasks

### N1 — Compile `bin/cli` to JS + drop bun from the user surface

- Replace `bin/cli.ts` with a compiled `bin/cli.js` produced at `prepublishOnly`. Shebang `#!/usr/bin/env node`.
- Update `bin: { "tmux-ide": "bin/cli.js" }`.
- Replace `engines.bun >= 1.0` with `engines.node >= 20` (the existing daemon dist targets node).
- Move bun-only scripts (`dev`, `test`, `test:unit`, `test:integration`, `test:stress`) under a `scripts.dev:bun:*` namespace so user-facing scripts don't reference bun. CI scripts (`pnpm run check`) can keep their existing bun runtime — bun is a dev dependency only.
- **Files in scope**: `package.json`, `bin/cli.ts` → `bin/cli.js`, `scripts/build-cli.mjs` (new), `bin/cli.js` shim deleted.
- **Test gate**: `node bin/cli.js --version` must succeed in CI with bun uninstalled (use a docker stage that drops bun from PATH).

### N2 — Ship `packages/` (or bundle the daemon into the tarball)

Two designs, pick one:

- **N2a (recommended) — bundle**: at `prepublishOnly`, run a build step that emits `dist/daemon/` at the **root** of the tarball, with all workspace deps inlined (esbuild / tsup / rollup). Then `bin/cli.js` imports from `./dist/daemon/index.js`. The published `tmux-ide` package is self-contained — no separate `@tmux-ide/*` resolution at runtime.
- **N2b — multi-publish**: flip `private: false` on `contracts`, `daemon-client`, `tmux-bridge`, `chat-solid`, `v2-solid-widgets`. Add a release script that bumps + publishes each. Replace `workspace:*` with version specifiers at publish time (`pnpm publish --filter` does this automatically). The root `tmux-ide` keeps depending on `@tmux-ide/daemon` and friends as normal deps.
- **Files in scope (N2a)**: `package.json` (add `dependencies: {}` for runtime native deps only — node-pty, better-sqlite3, ws), `scripts/bundle-daemon.mjs` (new), `bin/cli.js`, `.npmignore` (new — keep `src/`, `packages/`, `dashboard/` source out of the tarball; ship `dist/` + `dashboard/out/` only).
- **Test gate (N2a)**: `npm pack && tar -xzf tmux-ide-*.tgz -C /tmp/pkg && cd /tmp/pkg/package && node bin/cli.js --help`. Must print help without throwing module-resolution errors.

### N3 — Make `dashboard/out` self-contained

- `dashboard/next.config.mjs` already sets `output: "export"` in production. Confirm the export emits **per-route HTML** (it currently doesn't — `dashboard/out/` has 663 files but zero `.html`).
- Add `index.html` + `__fallback/index.html` (Next static-export entries) to a `prepublish-check.mjs` allow-list and **wire that script into `prepublishOnly`**, not just CI manual.
- Verify `serveDashboard()` correctly resolves the tarball-relative path. After N2a the layout is `<install>/dashboard/out/` — `resolveDashboardOut()` already walks up from `<install>/dist/daemon/command-center/static.js`, so the walk distance changes; cap at 5 levels.
- **Files in scope**: `dashboard/next.config.mjs`, `scripts/prepublish-check.mjs`, root `package.json` (`prepublishOnly`), `packages/daemon/src/command-center/static.ts`.
- **Test gate**: `dashboard/out/index.html` must exist post-build; `curl http://localhost:6060/` against a tarball-installed daemon must return the page shell with `<title>tmux-ide</title>`.

### N4 — Trim the `files` list to what actually runs

- After N1 + N2a, the runtime tarball is: `bin/cli.js dist/ dashboard/out/ scripts/postinstall.js skill/ templates/ package.json README.md LICENSE`.
- Drop `src/` from `files`. Move its remaining four files (cli/integration tests, server README, web base.css) to dev-only locations or delete (the tests are pre-fold artifacts; check what still references them with `grep -r src/integration.test.ts`).
- Confirm `scripts/` is trimmed to runtime-only: `postinstall.js` is the only one the published package needs. Stress-test, prepublish-check, pack-check, etc. are dev-only.
- **Files in scope**: root `package.json` (`files` array), `src/` removal, `.npmignore` (alternative to `files` — allow-list is safer).
- **Test gate**: `npm pack --dry-run | grep -c "^npm notice " ≤ 100` (current: 700). Spot-check the listing for absence of `*.test.ts`, `*.test.tsx`, `*.test.js`.

### N5 — Pack-and-install smoke test in CI

- Today's `pack:check` only runs `npm pack --dry-run`. Add a stage that **actually installs** the packed tarball into a clean dir and runs the CLI.
- Stages:
  1. `npm pack` → produces `tmux-ide-X.Y.Z.tgz`.
  2. Spawn an ephemeral Docker container with node + tmux installed, npm-install the tarball globally, run `tmux-ide --version`, `tmux-ide doctor`, and (with TMUX_TMPDIR set) `tmux-ide --help`.
  3. Curl `http://localhost:6060/health` after launching the daemon in headless mode (`tmux-ide command-center --port 6060 &`) and assert 200 + dashboard `<title>` in the body.
- Gate the existing `check` script on this stage so we catch broken tarballs before tagging a release.
- **Files in scope**: `.github/workflows/release.yml`, `scripts/smoke-tarball.mjs` (new), root `package.json` (`pack:check` upgraded or `pack:smoke` added).
- **Test gate**: the new workflow must pass on a stock node:20-alpine + tmux image.

## §4 End-state user flow (target after N1–N5 land)

```
$ npm i -g tmux-ide
+ tmux-ide@2.2.0

$ cd ~/projects/my-app
$ tmux-ide init           # writes ide.yml, detects pnpm + next
$ tmux-ide                # launches tmux session + spawns daemon in background
[daemon] command-center listening on http://localhost:6060
[daemon] dashboard ready  → http://localhost:6060

$ open http://localhost:6060
# Dashboard loads, picks up the running session, kanban + chat + plans all work
```

Invariants:

- `node bin/cli.js --version` works on any machine with `node >= 20` and `tmux >= 3.0` installed. No bun, no tsx, no ts-node.
- `dist/daemon/` is the only daemon source on disk after install — `packages/` does not exist in the tarball.
- `dashboard/out/index.html` exists; the daemon serves it from any working directory because `resolveDashboardOut()` finds it relative to the install root.
- Post-install hook degrades gracefully when `~/.claude` is absent.

## §5 Versioning + workspace publish strategy

**Recommendation: bundle-and-publish single `tmux-ide` (N2a) for v2.x; revisit multi-publish for v3.**

| Lever | N2a — bundle (one tarball) | N2b — multi-publish |
|---|---|---|
| User surface | `npm i -g tmux-ide` — one package | `npm i -g tmux-ide` — six transitive |
| Release cadence | Single version, single git tag | Per-package SemVer, coordinated bumps |
| Dependency hell | Inlined → none | `@tmux-ide/contracts^x.y.z` cross-resolution |
| Code reuse outside this repo | None (private bundle) | `@tmux-ide/daemon` already publishConfig=public — re-usable |
| Maintenance burden | Bundle config in one place | Six per-package version + publish flows |
| Time to first working publish | ~1 day | ~3–5 days (bumps, scripts, docs, tests) |

Engineering rigor argues for N2a now (the project ships a single user-facing binary; multi-package publish solves a problem we don't yet have), with a clean escape hatch: `@tmux-ide/daemon` keeps its `publishConfig` so when a downstream consumer needs it (the electron app, or third-party integrations) we flip the switch without re-architecting.

**Versioning under N2a**: the root `tmux-ide` package is the single source of truth (`2.1.5` → `2.2.0` on N1+N2 land). Internal workspace packages stay at `0.0.x` / `0.0.1` and remain `private: true`. A release tags `v2.2.0`, `prepublishOnly` runs build + bundle + dashboard-export, `npm publish` ships exactly one tarball.

**Versioning under N2b (deferred)**: changesets-style coordinated bumps. Defer until we have the second consumer.

---

## Sub-task index

| ID | Title | Blocks |
|----|---|---|
| **N1** | Compile `bin/cli` to JS + drop bun from user surface | N2 |
| **N2** | Bundle daemon + workspace deps into `dist/`, ship `packages/`-free tarball | N3, N4 |
| **N3** | Make `dashboard/out` self-contained (HTML pages + prepublish gate) | N5 |
| **N4** | Trim `files` to runtime-only; drop vestigial `src/` | N5 |
| **N5** | Smoke-test the published tarball end-to-end in CI | — |

N2a is the load-bearing decision in §5; everything else is mechanical once it lands.
