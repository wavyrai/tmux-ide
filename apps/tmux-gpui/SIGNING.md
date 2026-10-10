# Native preview signing and qualification

The preview is not yet a signed public release. The local app, source build receipts,
and passing bridge tests do not establish Developer ID, notarization or clean-machine
installation acceptance.

## Prerequisites

Use a macOS ARM64 release host with an existing Developer ID Application identity
and a working `notarytool` keychain profile. Keep credentials in Keychain or the
release environment; do not put private keys or passwords in repository files.
The signing command must not import credentials, change the keychain search list,
or publish a release. Supply independently trusted Apple team, bundle identity,
architecture and minimum OS policy matching the installer.

Assemble a new app with explicit release metadata first. Run the source/package
checks before signing, while the native-build and assembly hashes still describe
the exact binaries. Use a separate output directory for distribution work; never
sign the user's running demo or overwrite the source app.

## Signing command

After the prerequisites and entitlement review are complete:

```sh
node apps/tmux-gpui/scripts/sign-preview-app.mjs \
  --app /absolute/UnsignedPreview.app \
  --identity 'Developer ID Application: YOUR ORGANIZATION (TEAMID)' \
  --notary-profile YOUR_EXISTING_PROFILE \
  --policy /absolute/trusted-apple-policy.json \
  --node-entitlements /absolute/reviewed-node-entitlements.plist \
  --output /absolute/new-signing-output
```

The output parent must already exist and the output directory must not exist.
The trusted policy contains exactly `teamId`, `bundleId`, `architecture` (`arm64`)
and `minimumMacOS`. The source app must be an explicit-metadata assembly, with
its historical native build receipt and assembly manifest intact. Success produces
`TmuxIDE.app`, an installer-compatible versioned archive and an external
`signing-receipt.json`. Success describes the completed signing pipeline; it does
not publish, install, launch, or prove clean-machine behavior. The command uploads
the staged ZIP to Apple's notarization service using the existing profile.

The producer has not yet completed a positive Developer ID run. Its deterministic
tests inject tools, and must not be cited as notarization or Gatekeeper acceptance.

## Entitlements and signature boundaries

Sign the bundled Node executable explicitly, separately from the native executable
and the outer app. `Resources/node` is outside the conventional nested-code locations;
the installer verifies its Developer ID team explicitly. Do not use `codesign --deep`
for signing or apply Herdr's audio-input entitlement to every executable.

Supply a reviewed Node entitlement plist explicitly. Apple's
[allow-jit entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit)
permits JIT compilation under the hardened runtime. That documentation alone does
not qualify a particular Node build or prove a minimal entitlement set sufficient.
Do not blindly preserve the broad debug, dyld or library-validation exceptions in
a downloaded Node signature. Positive signed execution of the bundled bridge,
including terminal input and recovery, is a release gate.

Apple describes separate signing of nested code and entitlement boundaries in
[Creating distribution-signed code for macOS](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/).
The local signing sequence follows the pinned Herdr `scripts/release/sign-macos.sh`
pattern: copy, sign inner code, sign bundle, submit, require Accepted, staple,
validate, assess, then archive. Herdr's original source and Apache notices remain
under `upstream`; its identities, endpoints, audio entitlement and universal DMG
policy are not this project's release configuration.

## Provenance after signing

Signing changes Mach-O bytes. Preserve the original native build receipt and
assembly manifest as historical **pre-signing** evidence. Never rewrite the native
build receipt to claim that the signed executable came directly from Cargo.
An external transformation receipt must connect input/output hashes, metadata,
source receipt identity, entitlement policy and notarization result. Such a receipt
is local evidence, not a separately authenticated update manifest or trust root.

The signing producer requires the staged app to pass the real macOS verifier,
then requires the strict update archive to survive the installer’s production
extractor, match the signed file inventory and pass that verifier again. An
ephemeral in-memory key authenticates this local extraction check only; it is never
persisted or offered as publisher trust. The public update manifest still needs
the independently provisioned release key. On failure, the producer removes its creation-owned attempt and leaves a redacted
`failure.json` stage record; the original input app remains intact. If cleanup
cannot establish ownership, it reports cleanup failure rather than deleting an
unverified path. Failed attempts are not publishable artifacts.

## Release acceptance still required

- Developer ID signing and notarization Accepted, stapler validation and Gatekeeper.
- Explicit bundle/version/team/architecture/deployment checks on the final app.
- Actual signed launcher, bundled Node and terminal operations on the supported Mac.
- Final archive extraction with unchanged signatures and byte-bound provenance.
- Trusted update manifest, public endpoint, checksums and release notes.
- Clean-machine install, repeat install, upgrade, interruption/recovery, rollback
  and removal preserving existing CLI/TUI configuration and tmux sessions.

Tests with an injected tool runner verify command ordering and failure handling.
Ad-hoc signing can check local signature layout and archive preservation, but does
not satisfy Developer ID, notarization, Gatekeeper or signed-install acceptance.
