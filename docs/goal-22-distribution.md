# Goal-22 — Distribution + packaging audit for v2.5.0

> Audit only — produces the map. The lead dispatches G22-P1…P5 after this
> lands. Companion to (and partially supersedes) `docs/npm-distribution-audit.md`,
> which was written before the Solid/Vite cutover (Goal-16) and the
> Monaco editor work (Goal-17).

This audit covers the **packaging surface only**: how the user gets
`tmux-ide` onto their machine and how the bits land. It deliberately
does **not** review editor / Monaco internals (Goal-17 surface),
LSP-as-tool (G21), or view wiring on the dashboard side (pane 4
territory).

---

## §1 npm publish — what ships today

Two npm packages are published from this repo. They are coordinated by
`.github/workflows/release.yml` and tagged together (`vX.Y.Z`).

### `tmux-ide` (root) — v2.1.5

```jsonc
// package.json (excerpt)
{
  "name": "tmux-ide",
  "version": "2.1.5",
  "bin": { "tmux-ide": "bin/cli.js" },
  "files": ["bin", "src", "scripts", "skill", "templates", "dashboard/dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "prepublishOnly": "npm run build:cli && npm run build:dashboard",
    "postinstall": "node scripts/postinstall.js",
  },
}
```

What lands in the tarball:

| Path                     | Role                                                                                                      | Origin                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `bin/cli.js`             | **single-file bundled CLI** (esbuild output, ~MB-scale)                                                   | `scripts/build-cli.mjs`                                                                                                           |
| `bin/cli.ts`             | source                                                                                                    | tracked (esbuild bundles it; the `.ts` ships too via the `bin` files glob, but only `cli.js` is wired through `package.json#bin`) |
| `dashboard/dist/`        | **prebuilt Solid SPA** — `index.html` + `assets/*.{js,css}`                                               | Vite build (`pnpm --filter @tmux-ide/dashboard build`)                                                                            |
| `src/`                   | vestigial post-fold residue (`cli.test.ts`, `integration.test.ts`, `server/README.md`, `ui/web/base.css`) | manually retained for tests; ~30 KB of dead weight                                                                                |
| `scripts/postinstall.js` | Claude skill installer (global-only)                                                                      | tracked                                                                                                                           |
| `skill/SKILL.md`         | Claude Code skill body                                                                                    | tracked                                                                                                                           |
| `templates/`             | preset `ide.yml` files                                                                                    | tracked                                                                                                                           |

The bundle strategy (the load-bearing decision):

`scripts/build-cli.mjs` runs esbuild over `bin/cli.ts` with one
custom plugin (`external-non-workspace`). The plugin keeps every
bare-specifier import **external** _except_ `@tmux-ide/*` workspace
packages and relative `.ts` imports, which are **bundled in**. Output:
a single `bin/cli.js` with `#!/usr/bin/env node`, target `node20`,
ESM. Third-party deps (`ws`, `hono`, `js-yaml`, `node-pty`, …)
resolve from `node_modules/` at runtime exactly the way any other
published CLI would. The bundle is the only way to ship our own TS
code — `pnpm`-only `workspace:*` pointers would fail to resolve under
`npm install`, and the tarball has no `tsc` step on the install path.

### `@tmux-ide/daemon` (workspace package) — v0.0.1

Published as a separate, public package so external consumers (today:
`app-electron`; tomorrow: third-party MCP / editor integrations) can
embed the daemon without going through the CLI.

```jsonc
// packages/daemon/package.json (excerpt)
{
  "name": "@tmux-ide/daemon",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./contract": "./dist/command-center/actions/contract.js",
    "./errors": "./dist/command-center/actions/errors.js",
    "./codex": "./dist/codex/index.js",
  },
  "files": ["dist", "dist/dashboard/dist", "README.md"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/build-dashboard.mjs",
    "prepack": "pnpm run build",
  },
}
```

The daemon's `dist/` is plain `tsc` output (preserves the workspace
silo boundary; no bundling). Its `prepack` runs
`scripts/build-dashboard.mjs`, which (a) shells out to
`pnpm --filter @tmux-ide/dashboard build`, then (b) **copies the
resulting `dashboard/dist/` tree into `packages/daemon/dist/dashboard/dist/`**
so the published daemon tarball is self-contained.

### Other workspace packages — not on npm

All five non-daemon workspaces are `private: true`:

| Package                      | Privacy         | Where it lives at install time                                                                                                              |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tmux-ide/contracts`        | `private: true` | inlined into `bin/cli.js` via esbuild; inlined into `@tmux-ide/daemon` via `tsc` (the daemon's `tsconfig` references the contracts' source) |
| `@tmux-ide/tmux-bridge`      | `private: true` | same — inlined                                                                                                                              |
| `@tmux-ide/daemon-client`    | `private: true` | same                                                                                                                                        |
| `@tmux-ide/chat-solid`       | `private: true` | bundled into `dashboard/dist` via Vite                                                                                                      |
| `@tmux-ide/v2-solid-widgets` | `private: true` | bundled into `dashboard/dist` via Vite                                                                                                      |

This is intentional — keeps versioning simple, no cross-package
SemVer dance. The trade-off is that downstream consumers cannot
import `@tmux-ide/contracts` independently; they must depend on
`@tmux-ide/daemon` and re-export through its `./contract` subpath
(which is exactly the affordance the daemon provides).

### Install hooks

`scripts/postinstall.js`:

- Gated on `process.env.npm_config_global === "true"` — does nothing
  on a project-local install.
- Copies `skill/SKILL.md` → `~/.claude/skills/tmux-ide/SKILL.md`.
- Patches `~/.claude/settings.json` to set
  `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- Degrades silently if `~/.claude` is absent or the settings file is
  not valid JSON.

No native rebuild step on the install path — the daemon's three
native deps (see §3) self-resolve via their own
`prebuild-install`-style postinstalls.

### CI release flow — `.github/workflows/release.yml`

Triggered by tag push (`v*.*.*`) or `workflow_dispatch`. Four jobs:

1. **`build`** — fan-out matrix (macOS arm64, macOS x64, Linux x64).
   - `pnpm install --frozen-lockfile`
   - `pnpm --filter @tmux-ide/dashboard build` ← writes `dashboard/dist/`
   - `pnpm --filter @tmux-ide/app-electron build` ← writes `app-electron/dist-electron/`
   - electron-builder → DMG / ZIP / AppImage in `app-electron/release/`
   - macOS signs + notarizes inline (`CSC_LINK`, `APPLE_API_*` secrets).
2. **`merge_manifests`** — merges per-arch `latest-mac.yml`.
3. **`publish_desktop`** — uploads `*.dmg`, `*.zip`, `*.AppImage`,
   `*.blockmap`, `*.yml` to a draft prerelease GitHub Release.
4. **`publish_npm`** (push event only) — re-installs, re-runs the
   dashboard build, then `pnpm --filter @tmux-ide/daemon publish` →
   `pnpm publish` (the root). Both `--access public --no-git-checks`.

`.github/workflows/publish.yml` is a **separate, older** publish
workflow that runs `pnpm run check` then `npm publish`. It overlaps
with the npm publish job inside `release.yml`. This is a footgun —
two workflows can race on the same tag push and one of them will
fail with "version already published". **Resolution pending in P1.**

---

## §2 Dashboard → daemon wire — does the daemon ship the prebuilt

dashboard or fetch at runtime?

**Ships.** No runtime fetch. Three resolution layers:

```
dashboard/  (Solid SPA source, Vite + Tailwind + @solidjs/router)
  └─ vite build  →  dashboard/dist/
                    ├─ index.html
                    └─ assets/index-<hash>.{js,css}

packages/daemon/scripts/build-dashboard.mjs  (runs at daemon prepack)
  └─ copies dashboard/dist/  →  packages/daemon/dist/dashboard/dist/

packages/daemon/src/command-center/static.ts#serveDashboard()
  └─ Hono middleware:
        – resolves out-dir by walking up from import.meta.url looking
          for a sibling `dashboard/dist`
        – exact-match → SPA-fallback (always returns index.html for
          unmatched non-API paths)
        – caches reads, sets long-lived Cache-Control on hashed assets,
          no-cache on HTML
        – env override TMUX_IDE_DASHBOARD_OUT=<abs path>
```

The walk-up resolution handles three layouts cleanly:

| Layout                                  | Where `import.meta.url` is                                                                                                                                                                                                                                                       | First match for `<here>/../**/dashboard/dist`                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Workspace dev                           | `packages/daemon/src/command-center/static.ts`                                                                                                                                                                                                                                   | repo-root `dashboard/dist/`                                                          |
| `npm i -g tmux-ide` (root CLI)          | inlined into `bin/cli.js`, but `serveDashboard()` is only reached when the daemon module's resolver runs; in this layout the daemon source is bundled into `cli.js`, so the runtime equivalent of `here` is the package root → `tmux-ide/dashboard/dist/` ships via root `files` |
| `npm i @tmux-ide/daemon` (programmatic) | `node_modules/@tmux-ide/daemon/dist/command-center/static.js`                                                                                                                                                                                                                    | `node_modules/@tmux-ide/daemon/dist/dashboard/dist/` (the daemon's own bundled copy) |

The walk is bounded (10 levels) and silently no-ops with a
pass-through middleware if no `dashboard/dist` is found — the API
keeps working with no UI. Useful for SSR / headless deploys.

### One quiet drift to flag

The root `tmux-ide` package's `files` array lists `dashboard/dist`
(post-G16 Vite output). The Electron `extraResources` in
`app-electron/electron-builder.yml` still references the **old
Next.js path**:

```yaml
extraResources:
  - from: "../dashboard/out" # ← Next.js name; Vite emits dashboard/dist
    to: "dashboard-out"
```

`dashboard/out` does not exist post-Goal-16 — the cutover renamed
the output directory. **The Electron release is currently building
without a dashboard.** Confirmed by inspecting the workflow: the
electron-builder step runs after `pnpm --filter @tmux-ide/dashboard build`
(which writes `dashboard/dist/`), so `from: "../dashboard/out"`
either silently no-ops (extraResources tolerates missing `from`
gracefully in some electron-builder versions) or hard-fails. **Test
gate needed in P3.**

---

## §3 Cross-platform native deps — install-time concerns

Three modules in `@tmux-ide/daemon` load native code. Each is a
distinct failure mode at install time.

| Module                     | Load shape                                                                                                         | Failure surface                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3@^12.4.1`   | N-API binding, `build/Release/better_sqlite3.node`                                                                 | Prebuilds via `prebuild-install`; falls back to `node-gyp rebuild`. Needs Python toolchain on the host if the prebuild for the running Node ABI isn't available.                                                                                                          |
| `node-pty@1.2.0-beta.12`   | `build/Release/pty.node`                                                                                           | Same — prebuild-install + node-gyp fallback. The `-beta.12` pin is known to ship prebuilds for Node 20 + 22 on macOS/Linux/Windows. Node 24 (which the release workflow runs on) is recently supported; **regression risk if `node-pty` ever falls behind a Node major**. |
| `@vscode/ripgrep@^1.15.11` | per-platform optional sub-packages (`@vscode/ripgrep-linux-x64`, `…-darwin-arm64`, etc.) resolved through `rgPath` | `pnpm`'s strict resolver can skip optional deps when `optional: false` is set globally or when an arch/os filter rejects the matching sub-package. End state: `rgPath` points at a missing binary.                                                                        |

`packages/daemon/scripts/check-native-deps.mjs` exercises each one in
a tiny smoke shape (open an in-memory SQLite DB; verify `spawn`
export on `node-pty`; stat `rgPath` for ripgrep). It is wired into
`pnpm check` locally and **runs as part of CI's `check` step**, but
the release workflow's `pnpm install --frozen-lockfile` lane does
**not** run it before publishing. A cleanly-published tarball can
therefore still fail at runtime on a target host whose Node ABI
doesn't match the prebuild.

Specific risks for v2.5.0:

- **`node-pty@1.2.0-beta.12` is a beta pin.** If a security or
  stability fix in 1.2.x lands, we'd want to take it; but the prebuild
  contract resets with each beta. Document the upgrade gate (must run
  `check-native-deps.mjs` on all three release-matrix hosts before
  bumping).
- **`@vscode/ripgrep` optional sub-packages on Windows.** The release
  matrix today is `macos-15` (arm64+x64) + `ubuntu-24.04` (x64). No
  Windows lane. Users on Windows installing via `npm` rely on
  pnpm-or-npm's resolver including `@vscode/ripgrep-win32-x64`. Add a
  Windows native-deps lane in P2 even if we don't build an Electron
  installer for it.
- **Node version drift.** Root `engines.node >=20`, but the release
  workflow uses `node-version: 24` to install + build. Tarball
  consumers can land anywhere ≥20. The `node-pty` prebuilds need to
  cover that range. (They currently do on macOS/Linux.)

---

## §4 Electron app status — `app-electron/` and `app/`

`app/` does not exist in the repo. The earlier Swift native app
mentioned in `CLAUDE.md` is **not present** — only `app-electron/`.

`app-electron/` is a working Electron shell:

- `app-electron/src/main.ts` boots the daemon in-process via the
  `@tmux-ide/daemon` workspace dep.
- `app-electron/src/loader.ts` is the BrowserWindow entry; loads the
  dashboard from `process.resourcesPath/dashboard-out` in packaged
  mode (which is the **broken `dashboard/out` path** — see §2 drift).
- `app-electron/src/preload.ts` exposes IPC handles for terminal
  bridging.
- `electron-builder.yml` is fully configured: macOS notarization
  (`hardenedRuntime: true`, `notarize: true`, entitlements), Linux
  AppImage, Windows NSIS, GitHub Releases publish provider
  (`releaseType: prerelease`), per-arch `latest-mac.yml` merge.
- `node-pty` is the only `asarUnpack` entry — the native `.node`
  binding cannot live inside the asar archive.

What's broken right now:

1. **`extraResources.from: "../dashboard/out"` points at nothing.**
   The dashboard rename in Goal-16 was not propagated here. End
   state: the Electron app boots, but the BrowserWindow gets a
   blank page or a "file not found" overlay (depending on whether
   `loader.ts` falls back gracefully — needs verification).
2. **Three-platform matrix, untested.** The release workflow has
   built (signed + notarized) macOS arm64 + macOS x64 + Linux x64 in
   the most recent green run, but no one has cold-installed the
   resulting DMG / AppImage end-to-end on a clean machine.
3. **Workspace silo entanglement.** The Electron app pulls in
   `@tmux-ide/daemon` via `workspace:*`. tsdown bundles the main /
   preload / loader, so the runtime impact is contained, but the
   `files` glob deliberately excludes
   `node_modules/.pnpm/@tmux-ide+**` from the asar to avoid duplicate
   sibling-package noise. The asar still contains a transitive
   copy via `tsdown`'s bundle output, which is the intended path.

### Recommendation — ship or kill?

**Ship, but as a tier-2 deliverable for v2.5.0.** The blocking
prerequisites are small:

- Fix `extraResources.from` to `../dashboard/dist` (and rename `to:`
  to `dashboard-dist` so `loader.ts`'s `process.resourcesPath` join
  matches). One-line PR, but a behavioural change for `loader.ts` —
  guard with a smoke test that boots the packaged DMG headlessly and
  asserts the BrowserWindow's `did-finish-load` event fires within 5s.
- Decide whether v2.5.0 desktop bundles are **promoted to public
  Release** or stay as draft prereleases on GH. The workflow already
  publishes as `draft: true, prerelease: true`; flip to `draft: false`
  only after the smoke test lands.

Killing the Electron path is **not** the right call right now: the
machinery is built, the CI lane exists, and the npm CLI surface
alone is hard to demo. Keep it, but treat it as tier-2 — npm CLI is
the v2.5.0 hero artifact.

---

## §5 Recommended 5-phase plan for v2.5.0 release

Each phase is a single discrete deliverable, sized for one G22-Px
dispatch. They're ordered by blocking risk — earlier phases gate
later ones.

### G22-P1 — Reconcile the two npm publish workflows

**Problem.** `.github/workflows/release.yml` and `.github/workflows/publish.yml`
both react to tag pushes. The first publishes `@tmux-ide/daemon` +
`tmux-ide`; the second publishes only `tmux-ide`. A tagged push races
both; the second one fails with "version already exists" — a noisy
CI failure for what should be a green release.

**Deliverable.**

- Delete `.github/workflows/publish.yml`. Its `npm publish` happens
  inside `release.yml#publish_npm`.
- Confirm the `release.yml` daemon publish step runs _before_ the
  root publish step (it does today — daemon is line 249, root is
  line 254).
- Add a `version mismatch` guard: read `package.json#version` and
  `packages/daemon/package.json#version` after the "Align" step,
  assert they match the resolved tag.
- **Test gate**: a manual `workflow_dispatch` with a synthetic version
  bump succeeds end-to-end against the npm test registry (Verdaccio
  in CI).

### G22-P2 — Native-deps smoke gate in the release workflow

**Problem.** `scripts/check-native-deps.mjs` runs locally + in
`pnpm check` but not in the release lane. A native-binding regression
between `pnpm check` (CI on PR) and the release tag push (different
runner image, different Node ABI cache) can silently ship a broken
tarball.

**Deliverable.**

- Run `node packages/daemon/scripts/check-native-deps.mjs` immediately
  after `pnpm install --frozen-lockfile` in `release.yml#build` and
  `release.yml#publish_npm`. Hard-fail the job on any failure.
- Add a `windows-2025` runner to the matrix that runs the
  check-native-deps script only (no Electron build). This covers the
  `@vscode/ripgrep-win32-x64` resolution risk without committing to
  publishing a Windows Electron build for v2.5.0.
- **Test gate**: matrix green on macos-15 + ubuntu-24.04 + windows-2025
  with check-native-deps passing.

### G22-P3 — Electron `extraResources` path fix + headless smoke

**Problem.** `app-electron/electron-builder.yml` references
`../dashboard/out`; Vite emits `dashboard/dist`. The desktop builds
ship without a usable dashboard.

**Deliverable.**

- Edit `electron-builder.yml`: `from: "../dashboard/dist"`,
  `to: "dashboard-dist"`. Update `app-electron/src/loader.ts` (or
  whatever currently joins `process.resourcesPath`) accordingly.
- Add `app-electron/scripts/smoke-packaged.mjs` that spawns the
  packaged binary in `--headless` mode (Electron has `--no-sandbox`
  - a hidden BrowserWindow trick), waits for `did-finish-load` on
    the dashboard URL, asserts the response contains
    `<title>tmux-ide</title>`, exits non-zero on timeout (>10s) or
    missing title.
- Wire the smoke script into `release.yml#build` after the
  electron-builder step (`runs-on: macos-15` only — Linux GH runners
  lack X server without xvfb wrapping, defer that complexity).
- **Test gate**: the macOS arm64 lane's smoke step prints
  `[smoke-packaged] dashboard loaded OK` and exits 0.

### G22-P4 — Self-contained dashboard build gate

**Problem.** `prepublishOnly` runs `build:cli && build:dashboard`,
but nothing asserts the dashboard build actually produced an
`index.html`. If Vite fails mid-build (or a sibling silo's build
crash bubbles up as a warning the script swallows), the tarball
publishes with a half-baked `dashboard/dist`.

**Deliverable.**

- Extend `scripts/prepublish-check.mjs` (which already exists per
  the older audit) to:
  - assert `dashboard/dist/index.html` exists and is newer than the
    most-recently-changed file under `dashboard/src/`,
  - assert at least one `dashboard/dist/assets/index-*.js` exists,
  - assert `bin/cli.js` starts with `#!/usr/bin/env node`,
  - assert `packages/daemon/dist/dashboard/dist/index.html` exists
    (the daemon's bundled copy from `build-dashboard.mjs`).
- Wire `prepublish-check.mjs` into `package.json#prepublishOnly`
  (currently it's listed in the older audit but not wired in).
- **Test gate**: `pnpm pack:check` on a clean checkout passes; a
  deliberate `rm dashboard/dist/index.html` makes `pnpm pack:check`
  exit non-zero with a structured error.

### G22-P5 — Post-publish canary

**Problem.** After `npm publish` lands, nothing exercises the
published artifact. The first user to `npm i -g tmux-ide` is the
canary.

**Deliverable.**

- New workflow `.github/workflows/canary.yml`. Triggers:
  `workflow_run` after `release.yml#publish_npm` succeeds, plus a
  daily cron (`0 6 * * *`) to catch transitive-dep rot.
- Steps (each on a fresh `node:20-alpine` + `tmux` container):
  1. `npm i -g tmux-ide@latest`.
  2. `tmux-ide --version` (asserts the just-published version
     string).
  3. `tmux-ide doctor --json` (asserts `ok: true`).
  4. Start the daemon via `tmux-ide command-center --port 6060 &`,
     `curl http://127.0.0.1:6060/health`, assert HTTP 200.
  5. `curl http://127.0.0.1:6060/` (root), assert
     `<title>tmux-ide</title>` in the body.
- On failure: open a GitHub Issue tagged `canary` with the run URL.
- **Test gate**: the workflow's first run (manual `workflow_dispatch`
  on the current `tmux-ide@2.1.5`) prints all five steps green.
  (Confirmation that v2.1.5 actually works today — answers a question
  the audit can't.)

---

## §6 Phase ordering + risk summary

```
P1 (delete dup workflow) ──┐
P2 (native-deps gate) ─────┤── unblocks tagging v2.5.0 with confidence
P3 (electron dashboard) ───┤
P4 (prepublish guard) ─────┘
                           │
P5 (post-publish canary)  ─┘── orthogonal; keeps shipping honest
```

`P1` is a 30-minute change but blocks every other release; do it
first. `P2`–`P4` can run in parallel once `P1` lands. `P5` is the
"trust but verify" loop and can land after the v2.5.0 tag if
needed — its absence doesn't block v2.5.0, only v2.5.1's confidence.

### Open questions (route to lead before P1 starts)

1. **Windows Electron build for v2.5.0 — yes/no?** The
   electron-builder config has a `win → nsis` target but the release
   matrix doesn't include a Windows runner. Adding it costs CI minutes
   - Windows code-signing cert ($).
2. **Promote desktop bundles from prerelease to release?** Today
   they're `draft: true, prerelease: true` (release.yml line 201–202).
   Flipping requires the P3 smoke test to be green for at least one
   tagged release first.
3. **Deprecate `app-electron/` in favor of a tier-3 web-only path?**
   If the answer is "yes, eventually," P3 becomes "verify the existing
   build is non-broken so the next release tag doesn't ship a black
   window" — strictly smaller scope.
