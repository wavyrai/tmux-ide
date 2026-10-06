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

1. Commit the release changes and merge the reviewed branch to `main` after its required checks pass.
2. Push the matching `vX.Y.Z` tag at that commit. The release workflows build and qualify all four bundled tmux/TUI platforms.
3. Let the Release workflow publish npm through its trusted-publishing environment. It verifies matching runtime assets and provenance before publishing; do not publish a second copy manually.
4. Stable versions use npm `latest`; prereleases use `beta`. Verify the matching GitHub release notes and assets.

For installer or native packaging changes, first run `release.yml` with
`qualification_only=true`. Test `docs/public/install.sh` in an isolated HOME and
prefix, including an upgrade and failed-download recovery. `pnpm test:installer`
covers staged activation and failure preservation without touching real daemons.

The native matrix also runs `node scripts/qualify-daemon-service.mjs <receipt.json>`
against a packed candidate. It requires an available non-root launchd GUI or
systemd user manager, installs into a temporary HOME, and verifies service
installation, restart, removal, and preservation of an existing private tmux pane.
It also atomically switches a stable launcher to a second copy of the packed
candidate, verifies the restarted daemon's actual entry path, interrupts a restart
after an intentionally failing launcher runs, and restores the working launcher
to verify recovery. Activation alone must leave the current daemon running;
cancellation and startup failure must retain service ownership and the pane PID.
The receipt records before/after source identity, tracked and untracked changes,
artifact hashes, recovery results, and cleanup; source drift, missing manager
access, or unverified cleanup fails qualification. Run `pnpm build:cli` and build
the current platform's bundled tmux first. This check covers service launcher
activation, not the installer's download/verification transaction or compatibility
between different product versions. CI enables lingering only for its disposable
Linux runner.

Qualification-only dispatches additionally run
`node scripts/qualify-installer-service.mjs <new-evidence-directory>` on all four
platforms. This uses the reviewed installer to download published
`2.9.0-beta.50` and `2.9.2` into an isolated HOME and a prefix containing spaces,
with only `/usr/bin:/bin` on the installer's PATH. The packed candidate controls
the private service through its public CLI. The journey covers first install,
upgrade without implicit daemon replacement, required installed doctor checks,
failed-version preservation, explicit manager restart, rollback, roll-forward,
service removal and uninstall while preserving the original tmux pane. Receipts
distinguish the candidate controller from downloaded published runtimes and
record source, artifact, process and cleanup identities. This proves a real
cross-version transaction; it does not substitute for installing the unpublished
candidate or running its TUI. It requires network access and an existing user
manager, and never changes production services or login lingering.

## Post-release

1. Install from npm in an empty user environment.
2. Run `tmux-ide doctor --json` and `tmux-ide app`.
3. Verify the npm page, GitHub assets, docs site, and retry path:
   `tmux-ide update --tui-binary`.
