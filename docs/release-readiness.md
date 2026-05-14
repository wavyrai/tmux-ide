# Release readiness — current snapshot

The detailed v2.5.0 audit + punch list lives at
[`release-readiness-v2.5.0.md`](./release-readiness-v2.5.0.md). This
file is the short, dated signal that says "the last full `pnpm check`
on the release branch was green".

## Latest signal

- **Status**: 🟢 **Ready** — `pnpm check` passes end-to-end on
  `feat/v2.5.0` at commit `a83d686` (style sweep) sitting on top of
  `0264f3d` (check-chain fix).
- **Verified on**: 2026-05-14, darwin/arm64, Node 25.x, pnpm 10.21.0.
- **Chain that ran**:
  1. `pnpm run lint:workspace` — turbo per-package lint + silo-mounts.
  2. `pnpm run format:check` — prettier across the tree.
  3. `pnpm run typecheck:workspace` — turbo per-package `tsc --noEmit`.
  4. `pnpm run dev:bun:test:unit` — `bun test src/cli.test.ts` (the
     remaining root-level unit suite post-F1 fold).
  5. `pnpm run docs:build` — fumadocs build of the docs site.
  6. `pnpm run pack:check` — `npm pack --dry-run` smoke.
  7. `pnpm run check:native-deps` — imports `better-sqlite3`,
     `node-pty`, `@vscode/ripgrep` and exercises a sanity path each.
- **Outstanding warnings** (do not block the tag):
  - 4 prettier-eligible `eslint-disable-next-line solid/no-innerhtml`
    / `solid/reactivity` "unused directive" warnings in
    `packages/v2-solid-widgets/src/widgets/{PlansPanel,SkillsView}.tsx`
    and `packages/chat-solid/src/components/ProviderModelPicker.tsx`.
    The plugin is registered but not enforcing the rule; the disables
    are kept as forward-compat documentation. Safe to drop in a
    follow-up.
  - 1 `app-electron/src/loader.ts` unused-disable warning that's
    pre-existing and tracked.
  - 1 `packages/daemon/src/persistence/chat-event-store.ts` unused
    `no-console` disable — pre-existing.

## What "ready" means for v2.5.0

- Every quality gate in the npm-publish chain (`prepublishOnly`)
  exits 0.
- The bundled SPA at `packages/daemon/dist/dashboard/dist/` is fresh
  per the workspace-preference resolver fix (`26a6907`).
- Native deps load cleanly on the local platform; the same gate is
  positioned to run in CI on the other two platforms as soon as the
  matrix lane is added.

## Follow-ups (non-blocking)

See `release-readiness-v2.5.0.md` §7 for the full follow-up list.
The shortest summary:

- Add Linux + Windows CI lanes for `pnpm check:native-deps`.
- Drop the four `solid/*` unused-disable directives or replace them
  with the real rule once the plugin's recommended ruleset is
  adopted.
- Rename `dashboard/src/components/v2/widgetHost.tsx` →
  `WidgetHostBridge.tsx` so the silo-mount allowlist entry can drop.
- Re-home or repair `src/integration.test.ts` so the unit-test
  glob can widen back to `src/` from the pinned `src/cli.test.ts`.
