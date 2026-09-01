# OpenTUI 2.9 release checklist

## Scope

This release ships the OpenTUI Home and Terminals path. The deferred web and
native desktop clients are not release prerequisites and must not be included in
the universal npm package.

## Preflight

1. Confirm the intended version in `package.json` and the npm dist-tag.
2. Update `CHANGELOG.md` with only behavior that is in the release cut.
3. Confirm `git status --short` contains only intentional changes.
4. Confirm no retired OpenTUI root or parallel session authority is reachable.

## Canonical verification

```bash
pnpm release:opentui:check
pnpm docs:build
git diff --check
```

The focused gate must prove:

- lint, format, and daemon typecheck;
- Home and Terminals renderer behavior;
- one root-owned keyboard ingress;
- clean first run with no existing daemon or tmux server;
- session creation, pane input, split, resize, window switching, and agent
  navigation;
- quiet-pane retention, daemon replacement, and detachable reattachment;
- npm package contents and an isolated packed-install user journey.

## Manual test drive

From a clean checkout build:

```bash
pnpm build:cli
pnpm build:tui
./bin/cli.js app
```

Exercise a shell, a full-screen agent, a truecolor program, pane splitting,
resizing, light/dark switching, closing and reopening the viewer, and one daemon
replacement. Confirm that terminal content remains visible and tmux sessions
survive viewer shutdown.

## Publish

1. Commit the release changes.
2. Publish all supported per-platform runtime assets and their manifests.
3. Run `npm publish --tag beta` for a beta, or the approved stable tag for GM.
4. Push the branch and annotated version tag.
5. Create the matching GitHub release.

## Post-release

1. Install from npm in an empty user environment.
2. Run `tmux-ide doctor --json` and `tmux-ide app`.
3. Verify the npm page, GitHub assets, docs site, and retry path:
   `tmux-ide update --tui-binary`.
