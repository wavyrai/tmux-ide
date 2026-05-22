# `src/` ↔ `packages/daemon/src/` fold audit

**Date**: 2026-05-12
**Author**: Pty Agent (pane 1)
**Scope**: Read-only triage — no files are moved or deleted by this audit.

## Headline numbers

| Bucket                           |   Count |
| -------------------------------- | ------: |
| Files in `src/` (`.ts` + `.tsx`) | **211** |
| Files in `packages/daemon/src/`  | **359** |
| In both                          | **208** |
| ↳ Byte-identical                 | **162** |
| ↳ Diverged                       |  **46** |
| `src/`-only                      |   **3** |
| `packages/daemon/src/`-only      | **151** |

Failing daemon `bun test src` run: **38 failures** across 8 test files. Root cause confirmed in §5.

The canonical target is `packages/daemon/src/`. `bin/cli.ts` should eventually `import` from `@tmux-ide/daemon` instead of `../src/`. The fold doesn't require new code — it removes redundancy and finishes a relocation that was started but never closed.

---

## 1. Identical (162 files — safe to delete from `src/`)

These files are byte-identical on both sides. Deleting the `src/` copy is a no-op for behavior; the only risk is breaking importers inside `src/` that haven't switched to `@tmux-ide/daemon` yet. Group deletes by top-level directory so the importer-rewrite passes can run in parallel.

By top-level bucket:

| Bucket               | Count |
| -------------------- | ----: |
| `lib/`               |    71 |
| `widgets/`           |    40 |
| repo-root `src/*.ts` |    25 |
| `ui/`                |    12 |
| `command-center/`    |     7 |
| `schemas/`           |     4 |
| `server/`            |     2 |
| `__tests__/`         |     1 |

Full list (alphabetical):

```
__tests__/support.ts
command-center/discovery.test.ts
command-center/filesystem.test.ts
command-center/index.ts
command-center/projects.test.ts
command-center/schemas.ts
command-center/static.test.ts
command-center/ws-events.test.ts
config-cli.test.ts
config.test.ts
detect.test.ts
detect.ts
dispatch.ts
doctor.test.ts
doctor.ts
init.test.ts
inspect.test.ts
js-yaml.d.ts
launch.test.ts
lib/auth/auth-service.test.ts
lib/auth/auth-service.ts
lib/auth/middleware.test.ts
lib/auth/middleware.ts
lib/authorship.test.ts
lib/authorship.ts
lib/cast/recorder.test.ts
lib/cast/recorder.ts
lib/dot-path.test.ts
lib/dot-path.ts
lib/event-log.test.ts
lib/filesystem-browser.test.ts
lib/filesystem-browser.ts
lib/github-pr.ts
lib/hq/client.test.ts
lib/hq/client.ts
lib/hq/mdns.test.ts
lib/hq/mdns.ts
lib/hq/registry.test.ts
lib/hq/registry.ts
lib/ipc/socket-protocol.test.ts
lib/ipc/socket-protocol.ts
lib/launch-plan.test.ts
lib/launch-plan.ts
lib/log.test.ts
lib/log.ts
lib/metrics.test.ts
lib/metrics.ts
lib/orchestrator.test.ts
lib/orchestrator.ts
lib/plan-store.test.ts
lib/plan-store.ts
lib/project-init-runner.test.ts
lib/project-init-runner.ts
lib/project-inspect.test.ts
lib/project-inspect.ts
lib/project-onboard.test.ts
lib/project-onboard.ts
lib/project-probe.test.ts
lib/project-probe.ts
lib/project-registry.test.ts
lib/project-registry.ts
lib/research.test.ts
lib/research.ts
lib/round-trip.test.ts
lib/session-monitor.test.ts
lib/session-monitor.ts
lib/session-options.test.ts
lib/session-options.ts
lib/shell.test.ts
lib/shell.ts
lib/sizes.test.ts
lib/sizes.ts
lib/skill-registry.test.ts
lib/slugify.test.ts
lib/slugify.ts
lib/task-store.test.ts
lib/token-tracker.test.ts
lib/token-tracker.ts
lib/tunnels/cloudflare.test.ts
lib/tunnels/manager.test.ts
lib/tunnels/manager.ts
lib/tunnels/ngrok.test.ts
lib/tunnels/tailscale.test.ts
lib/tunnels/tailscale.ts
lib/tunnels/types.ts
lib/validation.test.ts
lib/workflow-store.ts
lib/ws-v3/protocol.test.ts
lib/yaml-io.test.ts
lib/yaml-io.ts
ls.test.ts
ls.ts
metrics-cli.ts
plan.ts
postinstall.test.ts
remote.test.ts
remote.ts
schemas/filesystem.ts
schemas/index.ts
schemas/inspect.ts
schemas/registry.ts
send.test.ts
server/index.ts
server/standalone.ts
skill.test.ts
tunnel.test.ts
tunnel.ts
types.ts
ui/index.ts
ui/terminal/index.ts
ui/types.ts
ui/web/components/Box.tsx
ui/web/components/Input.tsx
ui/web/components/ScrollBox.tsx
ui/web/components/Text.tsx
ui/web/hooks.ts
ui/web/index.ts
ui/web/render.ts
ui/web/utils/color.test.ts
ui/web/utils/color.ts
validate.test.ts
validate.ts
widgets/changes/index.tsx
widgets/costs/index.tsx
widgets/explorer/breadcrumbs.tsx
widgets/explorer/footer.tsx
widgets/explorer/header.tsx
widgets/explorer/index.tsx
widgets/explorer/tree-model.test.ts
widgets/explorer/tree-model.ts
widgets/explorer/tree.tsx
widgets/lib/config-model.ts
widgets/lib/files.test.ts
widgets/lib/files.ts
widgets/lib/git.test.ts
widgets/lib/git.ts
widgets/lib/pane-comms.test.ts
widgets/lib/theme.ts
widgets/lib/watcher.ts
widgets/mission-control/activity-feed.tsx
widgets/mission-control/agent-panel.tsx
widgets/mission-control/command-bar.tsx
widgets/mission-control/index.tsx
widgets/mission-control/task-panel.tsx
widgets/preview/index.tsx
widgets/setup/agent-naming.tsx
widgets/setup/config-tree.tsx
widgets/setup/detect-panel.tsx
widgets/setup/field-editor.tsx
widgets/setup/footer.tsx
widgets/setup/index.tsx
widgets/setup/layout-picker.tsx
widgets/setup/orchestrator-panel.tsx
widgets/setup/review-panel.tsx
widgets/setup/setup-model.test.ts
widgets/setup/setup-model.ts
widgets/tasks/index.tsx
widgets/tasks/task-detail.tsx
widgets/tasks/task-form.tsx
widgets/tasks/task-list.tsx
widgets/tasks/task-model.test.ts
widgets/tasks/task-model.ts
```

---

## 2. Diverged (46 files — content differs, need a decision per file)

All 46 diverged files share **one of three** divergence patterns. Categorising by pattern instead of file-by-file makes the fix mechanical.

### 2A. Tiny CLI handlers — only the `tmux` import differs

The daemon side imports from `@tmux-ide/tmux-bridge` (the canonical helper package); the `src/` side still imports from `./lib/tmux.ts` (legacy local copy). Recommendation: **use packages/daemon**.

| File                     | s_lines | d_lines | Evidence                                                                                                                                                                                    |
| ------------------------ | ------: | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attach.ts`              |      20 |      20 | `< ./lib/tmux.ts` vs `> @tmux-ide/tmux-bridge`                                                                                                                                              |
| `notify.ts`              |      85 |      85 | same                                                                                                                                                                                        |
| `inspect.ts`             |     212 |     212 | same                                                                                                                                                                                        |
| `orchestrator-status.ts` |     228 |     228 | same                                                                                                                                                                                        |
| `restart.ts`             |      24 |      24 | same                                                                                                                                                                                        |
| `send.ts`                |     181 |     181 | same                                                                                                                                                                                        |
| `status.ts`              |      66 |      59 | same import swap + small refactor; daemon wins                                                                                                                                              |
| `stop.ts`                |      37 |      28 | same import swap; daemon wins                                                                                                                                                               |
| `stop.test.ts`           |     151 |     151 | same                                                                                                                                                                                        |
| `init.ts`                |     211 |     211 | identical except path-resolution: `__dirname, "..", "templates"` (src) vs `__dirname, "..", "..", "..", "templates"` (daemon). Daemon wins — the relative path matches its deeper location. |

### 2B. Schema / type re-export shims (daemon is a 2-line shim into `@tmux-ide/contracts`)

The daemon side is a thin re-export shim that points at the canonical `@tmux-ide/contracts` schemas. The `src/` side still carries the full schema source. The schemas have already moved — `src/` is the orphan. Recommendation: **use packages/daemon** (the shim) and rewrite any `src/`-side importers to depend on `@tmux-ide/contracts` directly so the shim itself can eventually retire too.

| File                    | s_lines | d_lines | Evidence                                                                                                                                                                                                  |
| ----------------------- | ------: | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/domain.ts`     |     430 |       2 | `// Schemas extracted to @tmux-ide/contracts (T056). Re-export shim.`                                                                                                                                     |
| `schemas/ide-config.ts` |     148 |       2 | same                                                                                                                                                                                                      |
| `lib/ws-v3/protocol.ts` |     160 |       2 | `// Protocol moved to @tmux-ide/contracts (T059). Re-export shim.`                                                                                                                                        |
| `lib/auth/types.ts`     |      13 |       2 | re-export of `AuthConfigSchema` from contracts                                                                                                                                                            |
| `lib/hq/types.ts`       |      44 |      19 | partial re-export; `RemoteMachine` stays daemon-side per its comment (carries `Date`/`Set` runtime state)                                                                                                 |
| `lib/daemon.ts`         |     469 |      42 | daemon is a 42-line stub: "Orphaned legacy daemon entrypoint. Prefer `tmux-ide --headless`." `src/` carries the legacy 469-line implementation; safe to delete after the launch path drops the reference. |
| `schemas/ws-events.ts`  |     150 |     258 | daemon side is the live schema and depends on chat types; src/ is older. **use packages/daemon.**                                                                                                         |

### 2C. Daemon-canonical (daemon is the newer / more complete implementation)

The daemon side is the canonical implementation; `src/` is a behind-by-one-or-many-features predecessor. Recommendation: **use packages/daemon**.

| File                            | s_lines | d_lines | Notes                                                                                                                                                                                                                                               |
| ------------------------------- | ------: | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command-center/server.ts`      |    2395 |    2973 | daemon has 578 lines of newer middleware/types                                                                                                                                                                                                      |
| `command-center/server.test.ts` |     988 |    1061 | daemon larger; covers newer endpoints                                                                                                                                                                                                               |
| `command-center/discovery.ts`   |     296 |     306 | daemon depends on `workspace-registry` + `PaneInfo` from contracts                                                                                                                                                                                  |
| `command-center/ws-events.ts`   |     390 |     463 | daemon broadcasts chat + workspace events                                                                                                                                                                                                           |
| `command-center/static.ts`      |     122 |     140 | daemon larger; bundled-asset handling                                                                                                                                                                                                               |
| `config.ts`                     |     313 |     556 | daemon adds 240 lines of `tryDispatchAction` + `mutateConfig`                                                                                                                                                                                       |
| `task.ts`                       |    1155 |    1283 | daemon has additional helpers (`areGoalTasksDone`, etc)                                                                                                                                                                                             |
| `task.test.ts`                  |    1466 |    1467 | trivial diff; daemon wins                                                                                                                                                                                                                           |
| `skill.ts`                      |     138 |     225 | daemon adds skill registry plumbing                                                                                                                                                                                                                 |
| `lib/skill-registry.ts`         |      86 |     135 | daemon larger; canonical                                                                                                                                                                                                                            |
| `lib/event-log.ts`              |     316 |     376 | daemon has the sqlite-backend branch                                                                                                                                                                                                                |
| `lib/errors.ts`                 |      44 |      71 | daemon larger taxonomy                                                                                                                                                                                                                              |
| `lib/task-store.ts`             |    1269 |    1281 | trivial diff                                                                                                                                                                                                                                        |
| `lib/validation.ts`             |     123 |     170 | daemon larger                                                                                                                                                                                                                                       |
| `lib/webhook.ts`                |      51 |     122 | daemon larger; HMAC + retry path                                                                                                                                                                                                                    |
| `lib/output.ts`                 |      76 |      76 | trivial diff                                                                                                                                                                                                                                        |
| `lib/tunnels/cloudflare.ts`     |     254 |     256 | trivial diff                                                                                                                                                                                                                                        |
| `lib/tunnels/ngrok.ts`          |     261 |     264 | trivial diff                                                                                                                                                                                                                                        |
| `lib/daemon-watchdog.ts`        |     106 |     111 | both call `tsx` per T087; daemon side has slightly newer comments                                                                                                                                                                                   |
| `server/pty-bridge.ts`          |     334 |     539 | **CRITICAL** — daemon is the T087 PtyAdapter-consuming version; `src/` still imports `node-pty` directly. Use daemon.                                                                                                                               |
| `server/pty-bridge.test.ts`     |     289 |     480 | daemon has 21 adapter tests                                                                                                                                                                                                                         |
| `server/ws-route.ts`            |     387 |     483 | daemon larger; canonical                                                                                                                                                                                                                            |
| `server/ws-route.test.ts`       |     507 |     663 | daemon larger; canonical                                                                                                                                                                                                                            |
| `widgets/resolve.ts`            |      40 |      64 | daemon adds 24 lines of widget command resolution                                                                                                                                                                                                   |
| `widgets/lib/pane-comms.ts`     |     219 |     209 | trivial diff; daemon importing `PaneInfo` from contracts                                                                                                                                                                                            |
| `widgets/config/index.tsx`      |     440 |     440 | trivial diff                                                                                                                                                                                                                                        |
| `launch.ts`                     |     583 |     493 | **EXCEPTION** — `src/` is BIGGER. Reason: `src/launch.ts` still owns `startSessionMonitor` + `DEFAULT_COMMAND_CENTER_PORT` (90 lines); daemon moved both to `@tmux-ide/tmux-bridge`. Daemon is canonical; the `src/` lines are migration leftovers. |

### 2D. Test fixtures that resolve `bin/cli.js` relative to their own dir

Tests that were copied from `src/X.test.ts` into `packages/daemon/src/X.test.ts` without updating path resolution. Every one of them does:

```ts
const cli = join(__dirname, "..", "bin", "cli.js");
```

…which resolves to `packages/daemon/bin/cli.js` (doesn't exist) instead of the repo-root `bin/cli.js`. **This causes the 38 failing `bun test` runs in §5.**

| File                  | s_lines | d_lines | Fix                                                                                                    |
| --------------------- | ------: | ------: | ------------------------------------------------------------------------------------------------------ |
| `cli.test.ts`         |     314 |     176 | Repoint to `../../../bin/cli.js` OR delete the daemon copy and keep these in `src/` as CLI-edge tests. |
| `integration.test.ts` |     276 |     274 | same                                                                                                   |

---

## 3. `src/`-only (3 files — keep or move with care)

| File               | Status                                                                                                                                                        | Recommendation                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.ts`          | CLI entry. Imports `getDefaultThreadStore` etc. from `../packages/daemon/src/chat/defaults.ts`. Includes the new `chat events <thread>` subcommand from T095. | **Stays under `src/`** while `bin/cli.ts` still does relative imports. When `bin/cli.ts` flips to `@tmux-ide/daemon`, move this file under `packages/daemon/src/cli/chat.ts` and re-export via the package `cli` entry point. Add to `.src-allowlist` until then. |
| `lib/tmux.ts`      | Legacy local copy of the tmux helper; daemon side uses `@tmux-ide/tmux-bridge`.                                                                               | **Delete after** the few remaining `src/` files that still import `./lib/tmux.ts` (caught by the §2A diverged list) are switched to `@tmux-ide/tmux-bridge`. Keep the test file alongside until then.                                                             |
| `lib/tmux.test.ts` | Mirrors the canonical `packages/tmux-bridge/src/runner.test.ts` (T087 already aligned both).                                                                  | **Delete with** `lib/tmux.ts` once the helper migration is complete.                                                                                                                                                                                              |

---

## 4. `packages/daemon/src/`-only (151 files — confirm they belong)

These are the genuinely-new pieces of the canonical tree. Bucketed by top-level dir for review:

| Bucket                                       | Count | Spot-check                                                                                                                                                                                                                                       |
| -------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat/`                                      |    46 | `chat-integration.test.ts` (2228 lines), `thread-manager.ts`, `reactors/reactor.ts` (T092), `defaults.ts`, `permission-coordinator.ts` — all production chat. Belongs.                                                                           |
| `command-center/` (esp. `actions/handlers/`) |    37 | Action-handler architecture (G14-T03 split). Belongs.                                                                                                                                                                                            |
| `lib/`                                       |    18 | `sqlite-adapter.ts`, `event-log-sqlite.ts`, `workspace-registry.ts`, `cli-action-bridge.ts`, `canonical-daemon.ts` — daemon-only infra. Belongs.                                                                                                 |
| repo-root `*.ts`                             |    12 | `bin.ts`, `cli.ts` (daemon CLI entry), `app-cli.ts`, `embed.ts`, `active-projects.ts`, `auth-token.ts`, `canonical.ts`, `app-settings.ts`, `checkpoint.ts`, `ui.ts`, `index.ts`, `cli-action-wrappers.test.ts`. Daemon-package surface. Belongs. |
| `codex/`                                     |    10 | Codex provider client (T070-era). Belongs.                                                                                                                                                                                                       |
| `acp/`                                       |     9 | Agent Client Protocol stack. Belongs.                                                                                                                                                                                                            |
| `terminal/`                                  |     7 | PtyAdapter + NodePtyAdapter + MockPtyAdapter + 4 tests. T087. Belongs.                                                                                                                                                                           |
| `runtime/`                                   |     6 | Effect runtime services + layers + pipeline (T093). Belongs.                                                                                                                                                                                     |
| `persistence/`                               |     6 | chat-event-store + turn-projection + types (T090/T091/T095). Belongs.                                                                                                                                                                            |

No daemon-only file looks orphaned. No further action needed for this bucket beyond confirming the inventory in code review.

---

## 5. Why are 38 daemon tests failing?

`pnpm --filter @tmux-ide/daemon` runs only a curated 11-file `bun test` allowlist. The wider invocation (`bun test src` from inside `packages/daemon/`) finds **128 files** and produces:

```
1543 pass
  38 fail
3384 expect() calls
Ran 1581 tests across 128 files.
```

Failures, attributed by test file:

| Count | File                                                            | Failure mode                                                                                                                            |
| ----: | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
|    15 | `packages/daemon/src/integration.test.ts`                       | `spawnSync("node", [cli, …])` exits status 1 — `cli = __dirname/../bin/cli.js` resolves to `packages/daemon/bin/cli.js`, doesn't exist. |
|     8 | `packages/daemon/src/cli.test.ts`                               | same                                                                                                                                    |
|     4 | `packages/daemon/src/ls.test.ts`                                | same                                                                                                                                    |
|     4 | `packages/daemon/src/config-cli.test.ts`                        | same                                                                                                                                    |
|     3 | `packages/daemon/src/postinstall.test.ts`                       | path-relative fs assertions broken by the deeper file location                                                                          |
|     2 | `packages/daemon/src/inspect.test.ts`                           | same `cli` path issue                                                                                                                   |
|     1 | `packages/daemon/src/command-center/projects.test.ts`           | bundled-templates path resolution; same root cause                                                                                      |
|     1 | `packages/daemon/src/terminal/__tests__/NodePtyAdapter.test.ts` | unrelated — real PTY integration flake, T087 territory. Not a fold issue.                                                               |

**37 of 38 failures are direct symptoms of the duplication.** Every CLI-edge test was copied from `src/` to `packages/daemon/src/` without updating the relative path to `bin/cli.js`. Two fixes are equivalent:

1. **Delete the daemon copies, keep CLI tests in `src/`** (where the paths already resolve correctly). Simpler.
2. **Repoint the daemon copies to `../../../bin/cli.js`** and delete the `src/` copies. Aligns with "canonical = packages/daemon".

The fold plan picks option 2 because the §2D diverged copies are the newer version and option 1 would lose those edits.

---

## 6. Proposed fold plan — 5 parallel-safe sub-tasks

Bucketed so three agents can run two of these concurrently without colliding on the same files. Every sub-task lands as a single commit so revert is one git operation.

### F1 — Delete identical files from `src/`, rewrite cross-`src/` importers

**Files in scope** — every path in §1 (162 files).
**Action** — `git rm src/<path>` for each. For any remaining `src/*.ts` that does `import "./lib/foo"` or `import "../schemas/bar"` where `foo`/`bar` was just deleted, rewrite the import to point at `@tmux-ide/daemon/src/lib/foo` (preferred long-term: `@tmux-ide/daemon`).
**Dependencies** — none; this is the safest sub-task and unblocks everything else.
**Test gate** — `pnpm lint && pnpm --filter @tmux-ide/daemon test:vitest && pnpm test` all green.
**Estimated effort** — M; mostly mechanical.

### F2 — Pick daemon-canonical for §2A + §2B + §2C diverged files

**Files in scope** — the 38 entries in §2A, §2B, §2C combined (everything diverged except the 2 test files in §2D and `launch.ts` exception). For each: delete the `src/` copy and rewrite any `src/`-side importer.
**Action** — delete `src/X.ts`; grep `src/` for `from ['"].*X['"]` and `from ['"]\\./X['"]`; rewrite each to point at the canonical daemon path.
**Dependencies** — F1 (the identical-file imports get cleaned up first, reducing churn here).
**Test gate** — `pnpm lint && pnpm --filter @tmux-ide/daemon test:vitest && pnpm test`; the lint zone rules (already enforced in `eslint.config.js` §T059) will catch most importer drift.
**Estimated effort** — L; ~38 files × small importer sweeps. Highest blast radius — give this to the most senior agent.

### F3 — Resolve the test-fixture path duplication (§2D) — fixes the 38 failures

**Files in scope** — `cli.test.ts`, `integration.test.ts` on both sides. Plus the 7 daemon test files whose path resolution is broken: `ls.test.ts`, `config-cli.test.ts`, `inspect.test.ts`, `postinstall.test.ts`, `command-center/projects.test.ts`, and any other `daemon/src/*.test.ts` that `spawnSync(node, [cli, ...])`.
**Action** — pick one of:

- (a) delete `packages/daemon/src/cli.test.ts` + `integration.test.ts` + the 5 CLI-edge tests; keep the `src/` copies. Simplest. Lose any newer assertions in the daemon copies (§2D notes `daemon-cli.test.ts` is _smaller_ — 176 vs 314 — so this is probably safe).
- (b) update the daemon copies' `cli` const to `join(__dirname, "..", "..", "..", "bin", "cli.js")` and delete the `src/` copies. Aligns with "canonical = packages/daemon" but requires test edits.
  Recommend **(a)** — simpler revert path; CLI-edge tests genuinely belong next to `bin/cli.ts`.
  **Dependencies** — F2 (avoids importer collisions with the diverged code being chosen here).
  **Test gate** — `cd packages/daemon && bun test src` shows 0 failures (down from 38). Plus `pnpm test`.
  **Estimated effort** — S.

### F4 — Move `chat.ts` + retire `lib/tmux.ts` (the §3 `src/`-only files)

**Files in scope** — `src/chat.ts`, `src/lib/tmux.ts`, `src/lib/tmux.test.ts`.
**Action**:

- `chat.ts` — relocate to `packages/daemon/src/cli/chat.ts` (or similar). Update `bin/cli.ts`'s `import { chatCommand } from "../src/chat.ts"` to point at the new location. Until `bin/cli.ts` itself moves to `@tmux-ide/daemon`, keep a 1-line shim or add to `.src-allowlist`.
- `lib/tmux.ts` + `lib/tmux.test.ts` — delete. The canonical lives in `packages/tmux-bridge/src/`. Any `src/` importers were already cleaned up in F2 (§2A swaps `./lib/tmux.ts` → `@tmux-ide/tmux-bridge`).
  **Dependencies** — F2 (must have switched all §2A handlers off `./lib/tmux.ts`).
  **Test gate** — `pnpm lint && pnpm test && pnpm --filter @tmux-ide/tmux-bridge test`.
  **Estimated effort** — S.

### F5 — Flip `bin/cli.ts` to import from `@tmux-ide/daemon`

**Files in scope** — `bin/cli.ts`, `bin/cli.js`. Optional: every other `bin/*` script.
**Action** — replace `from "../src/<X>.ts"` with `from "@tmux-ide/daemon"` (or sub-paths the daemon package exports). Confirm the daemon package's `exports` field lists every needed symbol; add to `packages/daemon/package.json` if not. After this, repo-root `src/` should contain **at most** the three files in §3 (and only until F4 retires the tmux ones); `.src-allowlist` documents anything that remains.
**Dependencies** — F1, F2, F3, F4 (must land first; this is the final cut-over).
**Test gate** — Full release gate: `pnpm check` (= lint + format + typecheck + unit + docs + pack).
**Estimated effort** — M. Touches the entry-point so requires extra smoke testing (manual `tmux-ide ls --json`, `tmux-ide status --json`, `tmux-ide chat events $thread`).

### Parallel dispatch suggestion

```
agent-A: F1                       (no deps)
agent-B: F3                       (no hard deps on F1's churn; tests-only)
agent-C: --- waits for F1 ---

After F1 lands:
agent-A: F2                       (largest; senior agent)
agent-B: F4                       (waits on F2 for tmux imports)
agent-C: --- holds for F2/F4 ---

After F2 + F4 land:
agent-A or C: F5                  (final flip; gate on pnpm check)
```

Total estimated landing: ~1–2 days with three agents; single-day for a single agent moving carefully.

---

## 7. Open questions / risks

1. **Will F2's importer rewrites trip the zone-boundary lint rules in `eslint.config.js`?** Probably not — the rules already permit daemon→contracts and forbid back-edges; F2 is a no-op in import-direction terms. Verify before landing F2.
2. **`bin/cli.ts` is a Bun shebang (`#!/usr/bin/env bun`).** F5 may need to confirm that importing from `@tmux-ide/daemon` (which ships compiled JS from `tsc`) is bun-import-clean. If not, keep `bin/cli.js` (compiled JS) as the canonical executable and have it `require()` the package.
3. **`.src-allowlist` is empty today** with the comment "currently empty — repo-root src/ is fully retired as of T041." That comment is aspirational, not accurate. F5 should re-write the comment or add the F4 leftover (if any) before merging.
4. **Postinstall test failures (3)** are not pure path issues — they assert against Claude config files. Verify in F3 that they pass under the chosen `cli` path fix, otherwise hand them to a follow-up.
5. **One `NodePtyAdapter.test.ts` failure** is real PTY flake — unrelated to the fold. Track separately under T087 follow-up.
