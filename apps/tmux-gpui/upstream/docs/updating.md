# Shared Rust Updater Releases

The updater authenticates a small JSON manifest using an Ed25519 public key
embedded in the executable. macOS updates replace `Herdr.app`; the Linux archive
contract replaces a standalone executable. Installation requires explicit user
approval. Updating the GUI must not stop or upgrade the daemon or its terminals.

The protected release pipeline builds macOS on Apple Silicon and Intel, combining
both executables into a universal app, and Linux on native Ubuntu 24.04 x86_64 and
ARM64 runners. Linux remains experimental. Package-managed installs are updated
through their package manager, never by overwriting managed files: a macOS
Homebrew cask is upgraded by running Homebrew (see [Homebrew Casks](#homebrew-casks)),
and Linux AppImage, Snap, and Flatpak containers are refused outright. An
executable under `/usr` (other than `/usr/local`) or in `/nix/store` is reported
as package-managed too, which covers the `.deb`, `.rpm` and Arch packages; the
Nix flake also embeds no update key, so it never offers an update.

## Repository Configuration

| Setting | Kind | Contents |
| --- | --- | --- |
| `HERDR_UPDATE_PUBLIC_KEY` | Repository Actions variable | Exactly 64 lowercase hex characters encoding the 32-byte Ed25519 public key |
| `HERDR_UPDATE_SIGNING_KEY` | Protected `release` environment secret | Unencrypted Ed25519 private key PEM, including header/footer and line breaks |

Both macOS architecture builds and both Linux builds receive
`HERDR_UPDATE_PUBLIC_KEY` and `HERDR_RELEASE_VERSION` as compile-time environment
variables. The version is the derived calendar version `YYYYMMDD.COUNTER`, without
`v`; builds without it report `dev` and never run the updater.
The public key is required and format-validated before builds. The private key is
loaded only in the manifest-signing step of the protected `sign` job, never in
compilation, tests, metadata, OIDC attestation, or publication. Signing rejects a missing key,
a non-Ed25519 key, or a key whose DER public-key encoding does not exactly match
the configured public key.

Apple signing/notarization separately requires `MACOS_CERTIFICATE_P12_BASE64`,
`MACOS_CERTIFICATE_PASSWORD`, and `APPLE_API_PRIVATE_KEY` as protected `release`
environment secrets, plus `MACOS_SIGNING_IDENTITY`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER_ID` as environment variables. Sigstore uses GitHub OIDC in a
separate protected job. Configure the owner approval, main-only environment
policies, protected main/tags, and immutable releases described in
[Release Operations](../README.md#release-operations) before dispatch. Do not put
private signing keys in repository-wide secrets.

### Initial Key Setup

Run deliberately on a trusted administrator machine, not in ordinary builds.
Use Homebrew's explicit OpenSSL 3 path on macOS; `/usr/bin/openssl` may be LibreSSL
and may not support Ed25519. Linux can use `/usr/bin/openssl` version 3.

```sh
set -euo pipefail
set +x
OPENSSL="$(brew --prefix openssl@3)/bin/openssl"
"$OPENSSL" version
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"$OPENSSL" genpkey -algorithm ED25519 -out "$work/private.pem"
"$OPENSSL" pkey -in "$work/private.pem" -pubout -outform DER -out "$work/public.der"
public="$(python3 - "$work/public.der" <<'PY'
from pathlib import Path
import sys
der = Path(sys.argv[1]).read_bytes()
assert len(der) == 44 and der[:12].hex() == "302a300506032b6570032100"
print(der[12:].hex())
PY
)"
gh variable set HERDR_UPDATE_PUBLIC_KEY --repo penso/herdr-gpui --body "$public"
gh secret set HERDR_UPDATE_SIGNING_KEY --repo penso/herdr-gpui --env release < "$work/private.pem"
# Securely back up the private key in encrypted storage before leaving this shell.
```

Never commit the key, log it, put it in command-line arguments, or enable shell
tracing while handling it. Release signing writes it to a private temporary
directory with a 0600 file, unsets the environment variable before invoking tools,
and removes the directory with an exit trap. Only the public key and signatures
are distributed. The workflow selects the runner's `openssl@3` formula explicitly
and checks major version 3; the Homebrew patch version follows the runner image,
not a separately checksum-pinned binary.

Keep an encrypted backup independent of CI. Existing installs trust their embedded
key; changing the repository variable is not a key-rotation protocol. Key loss or
compromise requires a reviewed recovery plan or manual reinstall, not disabling
verification.

## Authentication Contract

The source of truth is `crates/herdr-gpui/src/updater/release.rs`. Release assets
include `update-manifest.json` and `update-manifest.sig`. Example JSON, formatted
here only for readability:

```json
{
  "schema": 1,
  "version": "20260920.1",
  "assets": [
    {
      "target": "universal-apple-darwin",
      "name": "herdr-gpui-20260920.1-macos-universal.app.tar.gz",
      "size": 123456,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

- Versions are calendar versions `YYYYMMDD.COUNTER`: an eight-digit UTC date and a
  same-day counter starting at 1, without `v`, leading zeros, prerelease or build
  suffixes. Both components compare numerically, so publication order is version
  order. GitHub release tags are `vYYYYMMDD.COUNTER`.
- JSON has exactly these fields, schema 1, at most 65536 bytes, and one to three
  unique supported targets. The release generator always requires the current
  version's macOS archive and includes either Linux archive when present. Release
  CI uses `--require-all-targets`, requiring all three archives before signing.
- Supported targets are `universal-apple-darwin`, `x86_64-unknown-linux-gnu`, and
  `aarch64-unknown-linux-gnu`. Linux updater names are
  `herdr-gpui-VERSION-TARGET-update.tar.gz`, distinct from the manual-install
  `Herdr-VERSION-TARGET.tar.gz` trees containing desktop files, icons, licenses,
  and third-party notices. The manual archives require the external
  [Linux desktop/runtime dependencies](../README.md#linux-builds).
- Each compressed archive is 1 through 268435456 bytes, with its exact byte length
  and lowercase 64-character SHA-256 digest in the manifest.
- `update-manifest.sig` is a **raw 64-byte Ed25519 signature**, not hex, base64,
  PEM, or a Sigstore signature. OpenSSL signs the exact JSON bytes using
  `pkeyutl -sign -rawin`. Any whitespace change requires regenerating the signature.

The client discovers the latest stable release through
`https://api.github.com/repos/penso/herdr-gpui/releases/latest`. Manifest, signature,
and archive downloads use version-specific GitHub release URLs. The authenticated
version must match the release tag after removing its `v` prefix; archive names and sizes must also match the
release metadata. SHA-256 and length are checked before extraction.

The JSON signature is named `update-manifest.sig`. Sigstore sidecars remain
separate: `update-manifest.json.sig` signs the JSON through Sigstore, while
`update-manifest.sig.sig` signs the raw Ed25519 signature through Sigstore. The
updater's trust anchor is the embedded Ed25519 key, not these Sigstore sidecars.
See [release verification](../SECURITY.md#verifying-a-release) for the separate
Sigstore/provenance trust policy and exact published asset checks.

## Packaging API

Python 3.9 or newer is required. All output paths must be new and have existing
parent directories; commands refuse to overwrite existing outputs.

```sh
python3 scripts/update-manifest.py package-macos dist/Herdr.app \
  dist/herdr-gpui-20260920.1-macos-universal.app.tar.gz
python3 scripts/update-manifest.py package-linux path/to/herdr-gpui \
  x86_64-unknown-linux-gnu 20260920.1 \
  dist/herdr-gpui-20260920.1-x86_64-unknown-linux-gnu-update.tar.gz
# Package the aarch64 Linux archive too before requiring all release targets:
python3 scripts/update-manifest.py create dist 20260920.1 --require-all-targets
HERDR_UPDATE_PUBLIC_KEY="$public" python3 scripts/update-manifest.py validate-public-key
HERDR_UPDATE_PUBLIC_KEY="$public" python3 scripts/update-manifest.py check-key \
  "$OPENSSL" path/to/private.pem
```

`package-macos APP ARCHIVE` requires an actual directory named `Herdr.app`, and
stores all entries beneath that single root. `package-linux BINARY TARGET VERSION
DESTINATION` stores exactly one regular file named `herdr-gpui-VERSION-TARGET`,
mode 0755. It rejects symlink inputs.

Both commands use Python `tarfile` USTAR format inside gzip, with no PAX or GNU
extensions, hardlink records, devices, or FIFOs. macOS modes and relative symlinks
are preserved, but links escaping the bundle and special permission bits are
rejected. Ownership names are empty, uid/gid and timestamps are zero; gzip has no
source filename or timestamp. Unsupported USTAR paths fail rather than generating
extended headers. Packaging limits are 10000 entries, 1 GiB expanded including
headers and padding, and 256 MiB compressed. These are packaging guards as well as extractor
constraints; they do not replace the client's independent validation.

`create DIRECTORY VERSION` writes compact, stable JSON without a trailing newline
to `DIRECTORY/update-manifest.json`. It considers only the three exact supported
archive names for that version. ZIPs, macOS standalone tarballs, other versions,
unknown targets, checksums, and signatures are ignored. Selected archives must be
regular, non-symlink files in bounds. The command hashes their bytes but does not
authenticate arbitrary input archives or inspect their contents; use the package
commands on trusted build outputs first.

## Release Pipeline

1. Audit the workflow, validate owner/main/SHA/workspace version and public key,
   then test and build both macOS and Linux architectures without private keys.
   Every shipped binary embeds the same version and public key. Linux builders
   package both the unchanged manual tree and a single-binary updater USTAR.
2. After protected environment approval, assemble the universal app including all
   notices, then sign its temporary copy with Developer ID and hardened runtime.
   Notarize a temporary ZIP, staple and validate the app, and check Gatekeeper.
3. Build the manual DMG from that final app, sign/notarize/staple the DMG, and
   validate it. Package the **same final signed, stapled app copy** as updater
   USTAR before signing-script cleanup. The input `dist/Herdr.app` is still
   unsigned and must never be used for the updater. No ZIP is published.
4. Download both current-run Linux artifacts without executing their contents.
   Require all three updater archives, check the PEM/public-key match, sign the
   exact JSON, verify the signature, and require 64 raw bytes. Upload the DMG,
   macOS updater archive, JSON and raw signature for the attestation job.
5. In the separate protected OIDC job, combine these with both Linux artifact
   sets (manual tarball, `.deb`, `.rpm`, Arch package and updater archive), both Windows zips (manual download only, never in the update manifest),
   and the locked six-target SBOM. Require the exact seventeen-file base set, then
   checksum, Sigstore-sign and attest all seventeen files. Each has four sidecars
   (`.sha256`, `.sha512`, `.sig`, `.crt`); `SHA256SUMS` covers all 85 files.
6. The protected publication job refuses existing tags/releases, creates a
   `vVERSION` tag at the validated SHA and a draft, uploads all 86 assets, then
   re-downloads and verifies the exact set and hashes before publication. The
   separately approved Homebrew job uses only the verified published DMG.

Apple code signing and notarization are independent of the Ed25519 manifest
signature and remain required. Manual Linux archives preserve desktop/icon/license
installation; updater archives only replace the existing executable. Their matching
manual archive supplies release-specific attribution and notices.

### Migrating From `X.Y.Z`

`v0.1.0` was published under the previous numeric SemVer scheme. Its tag is
ignored when the next version is derived, and the first calendar release replaces
the pre-calendar Homebrew cask without an ordering check, since every
`YYYYMMDD.COUNTER` version supersedes it.

Clients already running `0.1.0` cannot update themselves to a calendar release:
their embedded parser accepts only three numeric components, so they reject the
newer release as unstable and keep reporting no update. Those installations must
be replaced manually, through Homebrew or a fresh download. Calendar releases
update each other normally.

### Publication Security

Versions increase by construction: the workflow derives `YYYYMMDD.COUNTER` from
the run's UTC date and the highest same-day counter already tagged, and refuses to
publish when a tag is dated after that run. The manual-only workflow is restricted
to `penso` dispatching/rerunning from main, serializes all releases and never
cancels an active signer. It refuses existing tags/releases and verifies all
draft assets before immutable publication. Coordinate dispatches: concurrency
alone does not enforce numeric release ordering, and a valid old signature does
not prove freshness. HTTPS and GitHub account security remain important.

## Local Verification

There is no release workflow dry-run input. Use the credential-free script tests
and workflow audits below. `just dmg VERSION` builds both macOS targets locally
and signs without publishing; it requires the public key in the caller's
environment, strips private signing keys from Cargo's environment, and embeds
`VERSION` in both native and cross-compiled executables. Its updater tar has no
Ed25519 release manifest until the protected workflow runs.

Run the standalone contract tests locally:

```sh
OPENSSL="$(brew --prefix openssl@3)/bin/openssl" \
  python3 -m unittest discover -s scripts -p 'test_update_manifest.py' -v
actionlint .github/workflows/release.yml .github/workflows/updater.yml
zizmor --offline .github/workflows/release.yml .github/workflows/updater.yml
git diff --check
```

On Linux use `OPENSSL=/usr/bin/openssl`. `.github/workflows/updater.yml` runs these
Python tests and the updater-only Rust harness on Linux and macOS without secrets
or a desktop:

```sh
python3 scripts/test-updater.py
# Use already cached dependencies without network access:
python3 scripts/test-updater.py --offline
```

The harness uses the real updater sources and the pinned toolchain/dependencies,
without GPUI's desktop build dependencies. On Linux it also exercises a signed
helper handoff, actual standalone replacement/relaunch, tampering refusal,
cancellation, and rollback in private temporary installations under a test HOME.
It does not build or test the complete Linux GUI or prove macOS Gatekeeper acceptance.
The helper and updater use typed `UpdateError` variants; active unit tests check
source preservation, diagnostic redaction, and compound recovery failures. These
tests are included in the standalone harness, not disabled integration fixtures.

## Runtime And Recovery

Release builds check on startup, every hour while idle, and on request.
Local builds without a valid release version and embedded key never check.
Checking/downloading/extraction and subprocess waits run off the UI thread.
The panel shows download progress when the archive size is known, and an animated
activity bar while checking, verifying, installing, or running Homebrew. A full
bar means the update is ready to install or Homebrew has finished installing it;
Homebrew's output is shown without inventing a completion percentage.
Cancel is acknowledged after the current operation releases its staging resources;
a stalled HTTP read can delay cancellation until its request deadline (up to ten
minutes for an archive). No cancelled download is installed.

Linux installation requires an ordinary user-owned executable under `HOME`, such
as `~/.local/bin/herdr-gpui`, with safe ancestor permissions. Root, system locations,
symlinked paths, hard-linked binaries, and known package-container environments
are refused. Supported archive targets are x86_64 GNU and aarch64 GNU Linux.
On macOS the app must be user-owned and its parent writable without elevation;
the usual root/admin-owned `/Applications` parent is allowed. The installed and
candidate bundles must have matching Developer ID teams, Herdr's bundle identifier,
and the exact expected versions.

Installation re-extracts the authenticated archive after the GUI releases the
restart barrier. Original OS-string arguments and working directory are preserved.
The daemon is never signalled or stopped. A previous installation is retained in
an adjacent `.herdr-update-*` directory; post-commit failure details are recorded
in its `install-result.txt`. Rename or relaunch-spawn failures attempt restoration.
There is no post-launch health acknowledgement or automatic rollback if the new
process starts successfully and later crashes. Retain recovery copies until the
new version is confirmed working; cleanup is manual.

## Homebrew Casks

A macOS installation is treated as Homebrew-managed only when Homebrew's own
records point at the running bundle: `<prefix>/Caskroom/herdr-gpui/<version>/Herdr.app`
must be a symlink to it. `HOMEBREW_PREFIX`, then `/opt/homebrew`, then `/usr/local`
are consulted; `PATH` is not, so a writable directory earlier in it cannot decide
what the app executes. The prefix and `brew` itself must be owned by this user or
root and writable by no one else.

Such an installation replaces download-and-install with `brew upgrade --cask
herdr-gpui`, run with a minimal environment (`HOME`, a `PATH` rooted at the
detected prefix, no inherited variables) and no terminal, so anything that wants
an answer fails instead of hanging. Homebrew keeps its receipts correct and
verifies the cask's own SHA-256; this path therefore does not perform the signed
manifest and designated-requirement checks used by standalone installs, and trust
moves to Homebrew and the tap. Release detection still uses the signed manifest.

Auto-update stays enabled on the first attempt. The installed version is then
re-read: if it is not newer than the running app or is below the offered release,
the updater automatically runs `brew update` and retries the cask upgrade once.
The retry skips redundant auto-update. Command failures are not retried. The tap
is published after the GitHub release, so it can briefly lag even after a refresh;
that is reported with the installed and expected versions, not as a completed
update. Homebrew is never cancelled mid-upgrade, because killing it mid-move can
leave no installed app at all. The sequence shares one 30-minute command budget,
plus bounded output-draining time.

Homebrew trashes the running bundle as it upgrades, so bundle resources can be
gone until restart. Restart is offered as soon as the upgrade lands. When
restart is requested, the upgraded bundle is checked for a runnable executable
before this instance quits. A detached helper waits until this instance has
quit, then runs `open` on the upgraded bundle
with no `-n`, so macOS reuses the pinned Dock tile instead of placing a second
icon in Recents. If another Herdr instance is still running, the helper uses
`open -n` so the upgraded build starts instead of activating that instance.
The daemon and its terminals are untouched.

The helper outlives the app, so it cannot report through the update panel. It
retries `open` up to three times and shows a macOS alert when the relaunch
fails, or when this instance has not quit within 30 seconds. It records each
outcome in the system log:

```sh
log show --last 1h --predicate 'process == "logger" AND eventMessage BEGINSWITH "relaunch:"'
```

For an explicitly approved real upgrade, use
`just test-brew-upgrade /absolute/path/to/Herdr.app YYYYMMDD.COUNTER`, supplying
the release version the cask should install. This changes the installed app;
the ordinary test suite uses fake Homebrew processes instead.

## Native QA

`just run` enables the QA menu automatically. With Cargo, enable it with
`cargo run --locked --release -p herdr-gpui --features qa-menu`.
Default Cargo builds and published releases omit this menu.

The GPUI **QA > Show app update available** action presents safe synthetic
update state for version `9999.0.0`, without network requests, installing files,
or changing real update preferences. Verify modal focus, keyboard isolation, dismissal, long labels, and
narrow-window clipping. Preview actions must not initiate a real update. No
external framework or signing credentials should be needed for synthetic QA.
Use **QA > Show update download progress (50%)** to inspect a half-filled bar,
or **QA > Show Homebrew update progress** for the animated activity bar. These
previews stay visible until dismissed with Close or Escape; neither starts an
updater operation.

Before declaring installation production-ready, exercise two distinct signed,
notarized versions on both macOS architectures with an active desktop. Use an
isolated test channel/key or deliberately coordinate production releases; do not
edit a signed bundle to fake an older version.

1. Install A and confirm its identity and Gatekeeper acceptance.
2. Publish B's final archives and signed manifest. Confirm checks offer B but do
   not install without approval; cancellation must leave A usable.
3. Approve installation, then verify authentication, replacement, relaunch, version
   display, and a subsequent no-update result. Existing daemon sessions must survive.
4. In the isolated harness, test changed JSON/archive bytes, wrong keys, truncated
   signatures, invalid paths, oversized inputs, offline/404 responses, read-only
   destinations, translocation, cancellation, and interrupted replacement. Failures
   must leave a usable installation and an actionable message.
5. Separately test supported Linux standalone installation
   locations, executable mode, replacement/relaunch, and failure recovery on both
   supported architectures. Do not infer Linux success from macOS or Python tests.

Record OS, architecture, versions, observed UI, and outcomes. Headless tests are
not a substitute for these native two-version checks.
Native two-version updater installation/restart QA remains pending on macOS and
Linux; the existing build, headless, helper, and packaging checks do not establish it.
