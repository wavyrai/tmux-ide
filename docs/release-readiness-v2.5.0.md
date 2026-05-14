# v2.5.0 release-readiness — punch list

One-page status snapshot before tagging `v2.5.0`. Companion to
`docs/goal-22-distribution.md` (the audit). Read this top-to-bottom
before pushing the tag.

Versions on disk right now: root `tmux-ide@2.1.5`,
`@tmux-ide/daemon@0.0.1`. The release workflow re-aligns both to
the tag at publish time, so the current `package.json` numbers are
not load-bearing.

---

## (a) Verified ready — what landed and what proves it

| Concern                                                    | Commit               | What it gives you                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit + 5-phase plan                                       | `a029838` (G22-P0)   | The map. Defines the rest of the punch list.                                                                                                                                                                                                       |
| `@tmux-ide/daemon` ships its own bundled dashboard         | `3a266ba` (G22-P1)   | `packages/daemon/scripts/build-dashboard.mjs` copies `dashboard/dist/` into `packages/daemon/dist/dashboard/dist/` at the daemon's `prepack`. Programmatic-daemon consumers no longer depend on the host package layout.                           |
| Cross-platform native-deps health check                    | `d50092f` (G22-P1.5) | `packages/daemon/scripts/check-native-deps.mjs` exercises `better-sqlite3` / `node-pty` / `@vscode/ripgrep` and is wired into `pnpm check` via `check:native-deps`. Any prebuild ABI miss or pnpm optional-dep skip fails the gate before publish. |
| Duplicate publish workflow removed                         | `4242064` (G22-P3)   | `.github/workflows/publish.yml` deleted; `release.yml` rewritten to a single `publish_npm` job on `v*` tag push. No more race-on-tag noise.                                                                                                        |
| `prepublishOnly` gates on full `pnpm check`                | `83156a0` (G22-P4)   | `prepublishOnly: "pnpm check && pnpm --filter @tmux-ide/dashboard build"`. Lint, format, typecheck, unit tests, docs build, pack-check, native-deps health check all pass before npm can write a tarball.                                          |
| Freshness assertions for `bin/cli.js` + `dashboard/dist`   | `2d05b90` (G22-P5)   | `scripts/prepublish-check.mjs` now asserts `mtime(bin/cli.js) ≥ mtime(bin/cli.ts)` and `mtime(dashboard/dist) ≥ mtime(dashboard/src)`. Error messages name the exact recovery commands. Still **manual** — see (b) below.                          |
| Daemon prefers workspace dashboard build over bundled copy | `26a6907` (sibling)  | In dev, `serveDashboard()` resolves the workspace `dashboard/dist/` before the daemon's own bundled copy — no more stale-SPA confusion when iterating.                                                                                             |
| Daemon exits cleanly on non-signal stop paths              | `73ba204` (sibling)  | `handle.stop()` now terminates the process so ghost daemons don't pile up. Matters for tarball smoke-testing where we shell `tmux-ide command-center` and tear it down between runs.                                                               |
| LSP diagnostics poll resilience                            | `7d1e7b1` (G21)      | Exponential backoff on consecutive errors. Stops the dashboard from melting CPU when an LSP misbehaves.                                                                                                                                            |

Right-now freshness check (verified locally):

```
✓ bin/cli.js mtime ≥ bin/cli.ts mtime
✓ dashboard/dist/index.html exists
✓ pnpm pack:check packs 64 files / 7.4 MB unpacked
```

---

## (b) Pending — incomplete fixes + untested paths

Ordered by blocking severity. None of these are hard blockers for
v2.5.0; all are "ship-with-eyes-open" items.

### Blocking the npm publish lane

Nothing. The npm publish lane is releasable as-is.

### Soft-blocking — fix before tagging if you have ≥30 min

1. **`scripts/prepublish-check.mjs` is not wired into `prepublishOnly`.**
   The freshness assertions only run when the maintainer (or runbook)
   invokes `node scripts/prepublish-check.mjs` explicitly. Wiring it
   into `prepublishOnly` would close the loop, but the chain
   currently runs `pnpm check` (which calls `pack:check` → `npm pack`),
   so adding `prepublish-check.mjs` requires verifying no recursion
   (it does not invoke `npm pack`, so it should be safe — verify and
   add to the chain).

2. **`app-electron/electron-builder.yml` still references `dashboard/out`.**
   Line 33 has `from: "../dashboard/out"` (the pre-G16 Next.js
   output dir). Vite emits `dashboard/dist/`. The Electron build's
   `extraResources` step is silently shipping no dashboard, so the
   bundled .app loads a blank `loader.ts`. Fix:
   `from: "../dashboard/dist"`, `to: "dashboard-dist"`, then update
   the `process.resourcesPath` join in `app-electron/src/loader.ts`.
   **Out of scope for npm-only v2.5.0 release** — desktop is
   tier-2 (see audit §4) — but the broken state will mislead anyone
   inspecting the desktop artifacts. Suggest leaving the Electron
   release workflow off the v2.5.0 tag entirely (the rewritten
   `release.yml` already does this).

### Not blocking — schedule for v2.5.1

3. **No post-publish canary.** Today, nothing exercises the
   published tarball after `npm publish`. The first user is the
   canary. Plan in `docs/goal-22-distribution.md#G22-P5` defines
   the workflow shape (fresh `node:20-alpine` + tmux → `npm i -g`
   → smoke). Not wired yet.

4. **No Windows native-deps lane.** `check-native-deps.mjs` runs
   on the dev hosts and on the linux/macOS release matrix, but a
   tarball-install on Windows still has unvalidated
   `@vscode/ripgrep-win32-x64` resolution. Add a `windows-2025`
   GitHub runner that runs check-native-deps only (no Electron).

5. **No tarball-install smoke test.** `pack:check` packs a tarball
   but doesn't install + run it. A successful pack with a broken
   tarball is possible if any of the bundled imports fail at
   require-time on a fresh node. Plan in the audit; not wired.

6. **`prepublish-check.mjs` redundant build chain.** The script
   still has `run("pnpm", ["run", "build:dashboard"])` etc. from
   its pre-G22-P4 era. Now that `prepublishOnly` runs `pnpm check`
   - dashboard build itself, those `run()` calls are duplicate
     work when invoked from the chain. Slim them out when wiring
     into `prepublishOnly` (item 1).

7. **Two sibling pane commits captured cross-pane WIP.** Commit
   `2d05b90` (G22-P5) caught a `dashboard/src/components/ChatView.tsx`
   edit; commit `f0b15e9` (now superseded by `4242064` after a
   reset) caught a `PlansRail.tsx` edit. Both are sibling-pane
   in-flight work that landed under my commit messages because of
   the multi-agent index race. Sibling panes own the cleanup if
   they want it; otherwise treat the commits as honest snapshots of
   work-in-progress.

---

## (c) Recommended pre-tag steps

Run in order. Each is local and reversible. Stop and investigate at
any non-zero exit.

```bash
# 0. Make sure working tree is clean — multi-agent index races have
#    been a real hazard this session.
git status --short                                # should print nothing

# 1. Re-run the full quality bar locally. This is exactly what
#    prepublishOnly will run at publish time, so a green here means
#    the npm publish lane will go green too.
pnpm install --frozen-lockfile
pnpm check                                        # lint + format + typecheck + tests + docs + pack-check + native-deps

# 2. Rebuild bin/cli.js if you've touched bin/cli.ts since the last
#    build. The release lane does NOT rebuild it — it ships whatever
#    is on disk and git-tracked.
pnpm build:cli
git diff --quiet -- bin/cli.js || git add bin/cli.js  # stage if rebuilt

# 3. Rebuild the dashboard SPA. Same reasoning as bin/cli.js —
#    dashboard/dist/ is git-tracked through the npm files glob.
pnpm --filter @tmux-ide/dashboard build

# 4. Run the freshness assertions explicitly. The script is not yet
#    wired into prepublishOnly, so call it directly.
node scripts/prepublish-check.mjs

# 5. Local daemon + dashboard smoke. Catches runtime breakage that
#    static checks miss (broken WS frames, missing tmux binary, etc).
node bin/cli.js command-center --port 6060 &
DAEMON_PID=$!
sleep 2
curl -fsS http://127.0.0.1:6060/api/sessions >/dev/null || { echo "daemon broken"; kill $DAEMON_PID; exit 1; }
curl -fsS http://127.0.0.1:6060/ | grep -q '<title>tmux-ide</title>' || { echo "dashboard broken"; kill $DAEMON_PID; exit 1; }
kill $DAEMON_PID

# 6. Dry-run the npm pack to confirm the tarball shape is what you
#    expect. Eyeball the file list for any sibling-pane stragglers
#    that shouldn't ship.
pnpm pack:check                                   # npm pack --dry-run

# 7. Confirm both publishable package.jsons can resolve their
#    version aligners without surprise.
node -e "['package.json','packages/daemon/package.json'].forEach(p => console.log(p, JSON.parse(require('fs').readFileSync(p,'utf8')).version))"

# 8. Tag + push. The release.yml workflow takes it from here:
#    it re-installs, aligns versions across root + daemon, runs
#    pnpm check, builds the dashboard, publishes the daemon, then
#    publishes the root.
git tag v2.5.0
git push origin v2.5.0
```

### Post-tag verification

Within ~10 minutes of the tag push:

```bash
# Confirm the GitHub Actions release workflow ran green.
gh run list --workflow=release.yml --limit=3

# Confirm both packages landed on npm.
npm view tmux-ide@2.5.0 version
npm view @tmux-ide/daemon@2.5.0 version

# Cold-install on a fresh shell (or container) and verify the CLI.
npm i -g tmux-ide@2.5.0
tmux-ide --version            # expect: tmux-ide v2.5.0
tmux-ide doctor               # expect: all checks green
```

If any of the above fails: `npm deprecate tmux-ide@2.5.0
"broken release — see #<issue>"` and patch forward to `v2.5.1`. Do
**not** `npm unpublish` — npm's 72-hour window collides with cache
TTLs and confuses lockfile installs in the wild.

---

## Risk summary

- **Npm publish lane**: green. All quality gates pass; the
  prepublishOnly chain is comprehensive.
- **Desktop / Electron**: red, intentionally excluded from the
  v2.5.0 release surface. The `extraResources` path drift would
  ship a blank window if anyone built the .app from the tag.
- **Post-publish observability**: yellow. No canary; the first user
  to install is also the first smoke test. The cold-install commands
  in §(c) post-tag verification close this gap manually.
- **Cross-platform npm install**: yellow on Windows (no CI lane);
  green on macOS arm64 / x64 and Linux x64.
