# Dependency and native maintenance

The manifests and provenance files linked below are the source of truth. This
inventory explains why the patches exist and how to qualify changes; a listed
test is associated evidence, not a claim it passed on the current checkout.
Upstream acceptance/fix status and individual maintainers are not recorded here;
verify them before an upgrade rather than assuming a patch is still necessary.

## Production inputs

### OpenTUI JavaScript adapters — 0.5.1

[pnpm-workspace.yaml](../pnpm-workspace.yaml) applies two package patches:

- [Core](./@opentui__core@0.5.1.patch) makes demand updates reschedule the
  animation deadline without removing the frame-rate ceiling. It also defers
  composition/baseline advancement while the destination feed is backpressured;
  split-footer capture retains its separate ordered commit contract.
  Layout-resize callbacks mark buffers dirty for the current paint instead of
  requesting an identical subsequent frame. Text viewport updates retain Yoga
  invalidation and line-info notifications; property mutations from resize
  listeners still request their own follow-up frames. This relies on layout
  callbacks running before the current frame paints, and is covered by wrapped
  text shrink/grow, resize-listener mutation and production window-rename tests.
  Regression evidence:
  [demand cadence](../packages/daemon/src/tui/mirror/runtime/application-demand-cadence-renderer.test.tsx)
  and [backpressure](../packages/daemon/src/tui/mirror/runtime/application-backpressure-renderer.test.tsx).
- [Solid](./@opentui__solid@0.5.1.patch) skips an identical node/anchor insertion
  only when the node already belongs to the target parent. Solid can request
  `insertBefore(B, B)` during keyed reordering; this avoids an unnecessary Core
  warning covering terminal content while retaining invalid-insertion diagnostics.
  Regression evidence:
  [insertion stability](../packages/daemon/src/tui/mirror/workspace/opentui-insertion-stability-renderer.test.tsx).
  The shared JSX transform also prevents automatic memo wrappers in conditional prop getters:
  nested conditional component props otherwise allocate a new memo every time
  their getter is read, retaining observers for the owner's lifetime. Ordinary
  signal tracking, conditional child memoization and explicit memos remain active. Regression evidence:
  [conditional prop retention and reactivity](../scripts/solid-conditional-props.test.tsx).
  Validate the full TUI renderer suite when changing this compiler option.

Both patches cover Bun and Node package outputs. Remove a patch only after the
unpatched replacement passes the associated behavior tests. Upgrade Core and Solid
alongside the native ABI checks below; do not update only a version string.

### OpenTUI native renderer

[Release pins](../scripts/lib/native-scroll-release-manifest.mjs) specify source
`ad9a818d7a9d73f3386e92a445d0feb4b395c69e`, Core 0.5.1 and Zig 0.15.2.
[The native scroll patch](./opentui-native-scroll-ad9a818.patch) adds guarded
scroll-region support and its native tests. The
[builder](../scripts/native/build-opentui-scroll.mjs) accepts an explicit clean
checkout and Zig executable, supports `--preflight`, applies the patch in an
output checkout, runs the native test suite, and emits build provenance and a
host-qualified release manifest. Building a candidate alone does not install it.

[Release binaries](../.github/workflows/release-binaries.yml) consume qualified
native artifacts; validation checks source identity, patch/library hashes,
platform/libc and JavaScript ABI. Additional regression evidence:
[manifest validation](../scripts/lib/native-scroll-release-manifest.test.mjs) and
[runtime policy](../scripts/lib/native-scroll-runtime-policy.test.mjs).

Removal requires equivalent upstream scroll behavior, retained fallback behavior,
and a qualified replacement build on every advertised target. Do not substitute a
stock native library merely because the JavaScript package version matches.

### Bundled tmux — 3.7c with native-grid-v2 extension

[Provenance](../native/tmux/provenance.json) pins commit
`e476c1230b958df0cb12977517d24b3dc931375b` and the checksum of
[native-grid.patch](../native/tmux/native-grid.patch). This is the native grid
capability consumed by canonical terminal capture. The
[builder](../scripts/build-bundled-tmux.mjs) verifies the source and every ordered
patch identity. The second patch,
[interaction-journal-v1.patch](../native/tmux/interaction-journal-v1.patch), adds an
experimental bounded metadata journal (wire v2 with immutable server-scoped pane birth identities). It ships disabled and currently
advertises `command-outcome-v1` for send-keys, capture-pane, paste-buffer and
send-prefix. Command completion is not evidence of delivered input or application
consumption. Separate `pty-enqueue-v1` and `capture-produced-v1` coverage
measures command effects without claiming application consumption. Origin metadata is
immutable across hooks and native delayed commands. Unknown issuers remain zero.
It must not be treated as evidence of agent attribution. Its ISC notice is included
in native bundles. Run `node scripts/test-tmux-interaction-native.mjs --source
/path/to/pinned/tmux` for the ASan/UBSan ring and disposable-server lifecycle gate.
Production bundle qualification rejects test-only journal injection commands.
The journal adds in-process C code: observer overflow/disconnect is isolated from
input, but a native memory-safety failure cannot be isolated from the tmux server.

Regression evidence includes
[native-grid capture](../packages/daemon/src/terminal/mirror/native-grid-capture.test.ts),
[native-grid projection](../packages/daemon/src/terminal/mirror/native-grid-projection.test.ts),
[native content live](../packages/daemon/src/tui/mirror/runtime/terminal-native-content-live.test.ts)
and [native backing live](../packages/daemon/src/terminal/session-runtime/native-backing-owner-live.test.ts).
Qualify upgrades against the patched binary, not an arbitrary system tmux. Remove
the extension only when its required capabilities have an equivalent verified
provider and existing runtime/installed-package proofs still pass.

### Headless terminal parser

[Parser provenance](../packages/daemon/native/xterm/provenance.json) identifies
`@tmux-ide/xterm-headless` version `6.0.0-tmuxide.3-local.5`, fork commit
`8f6d707f7c09410ae4f89ace7b6d1bfed5542428`, esbuild 0.28.2 and
[one-column.patch](../packages/daemon/native/xterm/one-column.patch). Despite its
name, the patch covers both one-column geometry and tmux ED2 history semantics.
Use [the parser builder](../scripts/build-xterm-native-parser.mjs).

Regression evidence:
[fork behavior](../packages/daemon/src/terminal/session-runtime/xterm-headless-fork.test.ts)
and [native bootstrap](../packages/daemon/src/terminal/session-runtime/xterm-native-bootstrap.test.ts).
Remove/rebase the patch only after replacement behavior preserves canonical cells,
history and native reseeding, including narrow pane transitions.

### Other installed native dependencies

The root [package manifest](../package.json) declares `node-pty` 1.2.0-beta.12 and
`@parcel/watcher` ^2.5.6; the lockfile determines the resolved install versions.
Neither has a pnpm patch entry. Keep the Node executable/ABI consistent across
install, build and test. The
[native dependency smoke](../packages/daemon/scripts/check-native-deps.mjs) checks
node-pty loading only; it is not an exhaustive test of the watcher or the native
recipes above. Changes require relevant PTY/watcher behavior and installed-package
qualification on supported hosts; there is no local patch-removal condition.

## Separate experimental inputs

These recipes are not evidence that the terminal release uses Ghostty:

- [Native Ghostty embedding](../native/ghostty/provenance.json): commit
  `448062571c5edf010b7490d06869b88b5ebf8f80`, Zig 0.16.0,
  `aarch64-macos.13.0`, external-I/O ABI 1 and
  [external-io.patch](../native/ghostty/external-io.patch). Build with
  [build-library.mjs](../native/ghostty/build-library.mjs); the
  [experimental Electron smoke](../native/ghostty/experimental-electron/smoke.mjs)
  is scoped to that experiment. Promotion/removal requires that experiment's ABI
  and behavior to be requalified; no upstream replacement status is asserted.
- [Parser-only libghostty-vt prototype](../packages/daemon/native/ghostty-vt/README.md):
  a different Ghostty commit, `48ccec182a932c2ec04c344d45a5fc553861cb13`, with
  toolchain and three API patches pinned in
  [checksums.json](../packages/daemon/native/ghostty-vt/checksums.json).
  [Backend status](../packages/daemon/native/ghostty-vt-backend.json) records a
  failed performance qualification and no production import; xterm remains the
  default. Follow its documented conformance, lifecycle and performance promotion
  requirements. Passing a parser fixture alone is insufficient.

## Coordinated upgrade procedure

1. Identify the affected recipe, package and host targets. Preserve existing
   provenance and record why the change is needed.
2. Use a disposable checkout/output directory. Verify the upstream revision and
   toolchain; check patch applicability before building. Reassess each hunk against
   upstream behavior, and update provenance/checksums only for reviewed inputs.
3. Keep package manifests, lockfile, pnpm patch entries, native release pins and
   workflow checkout/toolchain pins aligned where affected. Keep Bun/Node adapter
   behavior aligned. Never mix JavaScript and native renderer ABIs.
4. Run the associated regression suites and recipe's native tests, then the
   relevant installed-package and platform proofs. Record command, source identity,
   target, result and limitations. Native import smoke alone does not qualify
   terminal fidelity or performance.
5. Follow [RELEASE.md](../RELEASE.md) for terminal qualification and artifact
   provenance. Record the broader contributor gate separately. Update this inventory
   when pins, patches, support scope or removal conditions change.

Development/native verification must use owned isolated resources. See the
[worktree guide](../docs/guides/development-worktrees.md); do not replace the user's
installed daemon or tmux server to test a dependency upgrade.
