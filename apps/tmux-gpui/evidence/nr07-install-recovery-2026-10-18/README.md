# Interrupted install recovery: staged source, not published (18 October 2026)

Both current public entry scripts reject `--recover` before network or mutation.
`before.json` records that exact parser reproduction in a private HOME, with an
unchanged sentinel and verified cleanup. The canonical installer backend already
has a journal-verified `recover --disposition keep-current` operation; the missing
entry was the shell parser/delegation, not the recovery owner.

The unreleased candidate is `scripts/install-native-alpha-maintenance.sh`.
It accepts explicit recovery, requires an existing managed Node24, fetches only
the existing checksum-pinned backend, passes the trusted Apple policy and
`keep-current`, then reconciles only the exact owned Applications link. It does
not fetch an app archive, bootstrap a CLI, automatically downgrade, delete a lock,
or start/stop production processes. **Network is still required for the backend.**
First-install recovery with no current app reports that outcome honestly and
removes an owned dangling link. A foreign link remains a refusal.

The public scripts and immutable v3 pin are byte-identical to their pre-change
state (see hashes.txt). Initially editing the public source made the deliberate
pin-equality gate fail: `integrated-parent.log` retains 55 passes and that one
failure. The resolution was to stage a separate next-asset candidate, not weaken
the checksum gate or repin an unpublished artifact. Promotion prerequisites are
in `scripts/install-native-alpha-maintenance.md`. No public curl recovery command
is supported or advertised by this increment.

## Checks and failure history

- `shell-before.log`: two new explicit-recovery tests fail on the original parser.
- `shell-after.log`: 16 shell tests pass after the initial direct-source change.
- `integrated.log` and `integrated-canonical.log`: fixture failures due to macOS's
  symlinked temporary directory and missing canonical parent respectively. The
  fixture was corrected to a realpath root and explicitly created parent. These
  are not product recovery failures.
- `final.log`: **56/56** shell, canonical recovery-owner and unchanged public
  dispatcher tests pass after moving the candidate out of the public surface.
- `alias-verification.log`: **3/3** real interrupted cases pass after strengthening
  the no-current assertion to `lstat` ENOENT (which detects dangling symlinks).
- `staged-dispatch-final.log`: **25/25** private future-dispatcher tests pass,
  including exact recovery args, missing-runtime refusal, no CLI bootstrap,
  preserved child failure and cleanup. This fixture adds only action parsing and
  maintenance classification to a private copy; it does not prove a deployed
  asset or change the published dispatcher. The first pin-gate failure remains
  in `staged-dispatch.log`.
- ESLint, Prettier and `sh -n` pass. Protected generated CLI hash is unchanged.

The three integrated tests execute the actual shell candidate and canonical
`install-cli.main` / `recoverApp`, with **synthetic app files and an injected test
verifier**. A child installing version2 is held at a real transaction boundary;
recovery while it is alive refuses and retains the lock. The fixture then kills
only that created child, awaits its SIGKILL exit, and recovers. Before activation
it retains version1; after activation it retains version2; interrupted first
install returns null. Current symlink/payload, exact Applications target, null
link absence and private settings sentinel are asserted. Canonical owner tests
also retain tamper/verifier-denial/uncertain-owner coverage. No Apple-signature,
notarization, physical GUI or second-Mac acceptance is implied.

## Reproduction (repository root)

Use the qualified Node24 binary, or an equivalent supported Node24 installation:

```sh
NODE=.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node
"$NODE" --test scripts/install-native-alpha.test.mjs apps/tmux-gpui/scripts/install-recovery.test.mjs scripts/install-native-dispatch.test.mjs
"$NODE" --test apps/tmux-gpui/evidence/nr07-install-recovery-2026-10-18/staged-dispatch.test.mjs
"$NODE" apps/tmux-gpui/evidence/nr07-install-recovery-2026-10-18/repro.mjs
sh -n scripts/install-native-alpha-maintenance.sh
```

The public-parser reproduction remains expected to fail safely until coordinated
publication. The staged-dispatch fixture reads current public source and substitutes
only its private future parser/maintenance policy and inert backend hash; it never
executes a real CLI install. All private test roots register recursive cleanup.

Committed failure-log copies trim trailing whitespace only; original task logs remain unchanged.
