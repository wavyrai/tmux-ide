# Release Packaging

Run with Bash; packaging scripts never build or execute the GUI, bundle a daemon,
or publish artifacts. Output directories must already exist. Existing
artifacts are refused. Versions are calendar versions `YYYYMMDD.COUNTER`: an
eight-digit UTC date and a same-day counter starting at 1, without `v`,
prerelease/build suffixes, or leading zeros.

## Build Identity

Packaging and `just bundle` require Python 3 and read a versioned identity record
embedded in the supplied executable, never the packaging checkout's Git state.
Linked-worktree binaries select `assets/icons/herdr-square-worktree-1024.png` or
`assets/icons/Herdr-worktree.icns` and `Herdr-worktree.car`; other builds use the
standard assets. On
Linux a release installs `herdr-icon-square-clean.svg` as the hicolor `scalable`
icon, because icon themes list no size above 512x512; the worktree PNG goes to
`share/pixmaps`, the lookup fallback. Distribution packages are built only from
the release layout. The
installed icon keeps its standard filename. No binary is executed, so foreign
Linux architectures and both macOS slices work on the packaging host. macOS
inputs must have identical identities (branch and PR included). Missing, malformed,
or conflicting records fail closed; older binaries must be rebuilt.

`herdr-gpui --build-info` prints three newline-terminated `key=value` lines:
`worktree=0|1`, `branch=...`, and `pr=...`, before any GUI or daemon startup.
The same record is retained in optimized binaries for packaging. This metadata is
an identity hint, not a signature or proof of provenance; supply trusted binaries.

At build time, Git is anchored at the crate manifest. Only differing canonical
Git/common directories mark a linked worktree, not branch names, `--dev`, or an
ordinary checkout with a separate Git directory. Stable builds have an empty
branch; linked builds use the branch or detached short SHA. Printable Unicode,
including trailing Unicode whitespace, is preserved; branch names containing
control characters use the short SHA instead. Missing Git/source archives degrade
to stable. Cargo watches existing HEAD, current ref, packed refs, and checkout
pointer files, not the entire ordinary `.git` directory. When a loose ref is
missing, its nearest existing refs directory is watched for creation. Source
archives do not automatically detect later Git initialization.

`HERDR_BUILD_PR_NUMBER=123 cargo build ...` overrides PR lookup; an explicitly
empty value disables it. Values must be empty or positive ASCII decimal digits.
Otherwise attached linked branches get a best-effort
`gh pr list --head BRANCH --state open --limit 1 --json number --jq '.[0].number'`
lookup in the manifest repository, with prompts disabled and a two-second timeout.
Only open PRs are considered; numeric and `#numeric` branches are treated as branch
names, never PR numbers. Missing gh/auth/network/open PR never prevents a build.
There is no runtime lookup.
Cargo does not poll remote PR changes: force a rebuild or change the override
when PR metadata changes without a local HEAD/ref change. Set an explicit override
for reproducible builds and matching cross-architecture PR metadata.

## Packaging Commands

```sh
cargo install cargo-about --version 0.9.2 --locked --features cli
python3 scripts/release/generate-notices.py OUTPUT_DIR/THIRD-PARTY-NOTICES.txt
bash scripts/release/package-macos.sh VERSION ARM64_BINARY X86_64_BINARY OUTPUT_DIR OUTPUT_DIR/THIRD-PARTY-NOTICES.txt
bash scripts/release/sign-macos.sh VERSION OUTPUT_DIR/Herdr.app OUTPUT_DIR
bash scripts/release/package-linux.sh VERSION TARGET BINARY OUTPUT_DIR OUTPUT_DIR/THIRD-PARTY-NOTICES.txt
bash scripts/release/render-cask.sh VERSION SHA256 > /path/to/rendered/herdr-gpui.rb
```

macOS assembly requires Apple command-line tools. It produces unsigned
`Herdr.app`, containing the universal GUI, plist, icon, root `LICENSE` and `NOTICE`,
protocol license/attribution, Octicons license, and third-party notices.
Both plist versions are set to the supplied version.
The package floor is macOS 14.2 (`LSMinimumSystemVersion`; Homebrew can only
express `:sonoma`). The binary strongly links CoreAudio's process-tap functions,
introduced in 14.2, through rodio's cpal backend, so dyld refuses to launch it
on 14.0 and 14.1. GPUI checks for macOS 15 at runtime before using its newer
window behavior. The `macos-14` CI job runs the workspace tests on that floor;
release builds still run on `macos-15` runners. Build release inputs with
`MACOSX_DEPLOYMENT_TARGET=14.2` to match the plist; do not supply binaries
targeting a newer OS.

Signing requires macOS, Apple tools, `openssl`, `jq`, network access to Apple's
notary service, and these environment variables:

- `MACOS_CERTIFICATE_P12_BASE64`: base64-encoded Developer ID Application P12.
- `MACOS_CERTIFICATE_PASSWORD`: nonempty P12 password.
- `MACOS_SIGNING_IDENTITY`: full `Developer ID Application: ...` identity.
- `APPLE_API_PRIVATE_KEY`: literal multiline App Store Connect API `.p8` contents,
  not a filename or base64 value.
- `APPLE_API_KEY_ID`: API key ID.
- `APPLE_API_ISSUER_ID`: team API issuer UUID.

Test P12 import with Apple's `security` tool, not only an OpenSSL roundtrip.
Some modern OpenSSL exports are rejected by Apple's importer with a misleading
MAC/password error. The provisioned pair uses password-protected PBE-SHA1-3DES for
key/certificate encryption and SHA-1 for the P12 MAC; both local and CI exports
were validated in a temporary keychain. This archive compatibility setting does
not change the executable's code-signing algorithm.

Use a trusted disposable signing runner and trusted binaries. Do not use shell
tracing around secret setup. The script uses a private temporary directory and
explicit temporary keychain and never changes the default keychain. It snapshots
the user search list, restores it after keychain creation (which may alter it),
and restores it again during cleanup. It traps exit/INT/TERM to delete credentials
and the keychain. Do not run concurrent keychain-changing jobs on that user account.
As with any trap,
SIGKILL/power loss cannot be cleaned up. Apple security tools receive passwords
as arguments, so the runner must not have untrusted local users. No GUI executable
is run, including for version probing. Signing works on a copy of the input app.

Both executable and bundle are explicitly signed with hardened runtime and secure
timestamps. The zipped app must receive JSON status `Accepted`, then the app is
stapled and validated. The DMG contains `Herdr.app` and an `/Applications` symlink;
it is signed, separately notarized, stapled, and checked with codesign and
Gatekeeper before publishing the local output filename:
`Herdr-VERSION-universal-apple-darwin.dmg`. Any failed operation aborts.
The signer also emits `herdr-gpui-VERSION-macos-universal.app.tar.gz` using the
updater's bounded USTAR packager. It archives the complete **signed, stapled copy**
used for the DMG, including signature, ticket, resources and notices, before the
temporary directory is removed. The caller's unsigned app is never repackaged
as an update. Existing DMG or updater outputs are refused before loading credentials.

Linux targets are `x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu`.
The release workflow builds both natively on Ubuntu 24.04 architecture runners,
using the same `scripts/install-linux-deps.sh` library setup as CI. Both archives
are mandatory in the single immutable asset manifest; signing, provenance and
consumer verification cover both. The SBOM unions both Linux, both macOS, and
the Windows target graphs. No separate per-platform manifest or publication job is used.
The caller must supply the matching release binary; packaging does not cross-build
or resolve shared libraries. Output is `Herdr-VERSION-TARGET.tar.gz`, with a
same-named root containing `bin/herdr-gpui`, a scalable SVG icon, desktop entry, license and
notice under `share/`. Install that tree into a chosen prefix with its `bin` on
PATH. Archives are not promised to be bit-for-bit reproducible.

`scripts/release/package-linux-distro.py VERSION TARGET ARCHIVE OUTPUT_DIR
--nfpm NFPM` then repackages that manual archive as `Herdr-VERSION-TARGET.deb`,
`.rpm` and `.pkg.tar.zst`. It extracts only the expected regular files, installs
them under `/usr`, and builds all three formats before publishing any, so every
Linux format ships the tarball's exact bytes. nfpm is the only packaging tool;
`scripts/release/install-nfpm.sh` downloads its pinned release and checks a
SHA-256 copied from that release's Sigstore-verified `checksums.txt`. Package
dependencies are declared explicitly, not inferred: the binary requires
GLIBC_2.39 (it is built on Ubuntu 24.04), links ALSA, FreeType, Fontconfig, xcb and
xkbcommon, and dlopens the Vulkan loader and libwayland-client. RPM
requirements are sonames so they resolve on any RPM distribution. Entries are
stamped with the release date, and the release host name is kept out of the
RPM header, so repackaging one release produces identical bytes.
`scripts/release/smoke-linux-packages.sh VERSION TARGET DIST_DIR` then installs
each package into digest-pinned Ubuntu 24.04, Debian 13 and Fedora 42 containers,
plus Arch Linux on x86_64 (no official ARM64 image exists), runs `herdr-gpui --help`,
fails if `ldd` reports a missing library or a dlopened loader is absent, and removes
the package again. When packaged dependencies change, update `DEPENDS` in
`package-linux-distro.py` and rerun the smoke script.

The workflow separately packages `herdr-gpui-VERSION-TARGET-update.tar.gz` with
`scripts/update-manifest.py package-linux`. This bounded USTAR contains exactly
one regular executable named `herdr-gpui-VERSION-TARGET`, mode 0755; it does not
replace or alter the manual archive's desktop/icon/license tree. Both native
Linux builds and both macOS builds embed `HERDR_UPDATE_PUBLIC_KEY` and the
validated `HERDR_RELEASE_VERSION` before packaging.

The experimental Windows targets are `x86_64-pc-windows-msvc` and
`aarch64-pc-windows-msvc`, built natively on `windows-2025` and
`windows-11-arm` after clippy, the protocol/client suites and the CLI tests pass
there. `scripts/release/package-windows.py VERSION TARGET BINARY OUTPUT_DIR
THIRD_PARTY_NOTICES` (standard-library Python, since the runner has no zip tool)
writes one `Herdr-VERSION-TARGET.zip` per target with a same-named root containing
`herdr-gpui.exe` and `licenses/` holding the same license and notice files as
the Linux tree. Entries carry a fixed timestamp. Both zips are mandatory in the
asset manifest and receive checksums, Sigstore sidecars and provenance like
every other asset, but they are not Authenticode-signed and have no updater archive
or update-manifest entry: Windows installs update by manual download.

## Updater Signing

Configure `HERDR_UPDATE_PUBLIC_KEY` as a repository Actions variable (64 lowercase
hex characters). Store the Ed25519 PEM `HERDR_UPDATE_SIGNING_KEY` only in the
protected `release` environment, not in repository secrets. Only the manifest
signing step of `sign` receives it; builds, tests, metadata, OIDC and publication
never do. The public key is validated before builds and matched against the
private key before signing exact JSON bytes. See [updater setup](../../docs/updating.md).

The exact release base set is seventeen files: the DMG, two manual Linux archives,
their `.deb`, `.rpm` and Arch packages, two Windows zips, SBOM, three updater archives, `update-manifest.json`, and its
raw 64-byte Ed25519 `update-manifest.sig`. All seventeen receive checksum and Sigstore sidecars and GitHub
provenance in the separate protected OIDC job. The raw signature is not overwritten:
its Sigstore sidecar is `update-manifest.sig.sig`; the JSON's is
`update-manifest.json.sig`. `SHA256SUMS` covers all 85 base/sidecar files; the
immutable release has exactly 86 assets. Missing or additional files fail closed.
`artifact-manifest.py base-names VERSION DIRECTORY` lists the seventeen base names.
The publication job verifies downloaded draft bytes and the complete exact asset
set before making it public; Homebrew still verifies and uses only the final DMG.

## Homebrew

`homebrew/Casks/herdr-gpui.rb` is deliberately a template, not an installable
unverified release. Render with the final stapled DMG's SHA-256 (64 hex digits).
Rendering is deterministic, normalizes hexadecimal to lowercase, and writes only
stdout. Do not redirect onto the input template. The rendered cask belongs at
`Casks/herdr-gpui.rb` in `penso/homebrew-tap`; install as
`brew install penso/tap/herdr-gpui`. Downloads use repository
`penso/herdr-gpui`, tag `vVERSION`, and the exact DMG filename above.

`bash scripts/release/update-homebrew.sh VERSION RENDERED_CASK` publishes that cask
to the resolved default branch of `penso/homebrew-tap`. Run only after the
published DMG checksum has been verified. It requires `git`, `ssh`, `curl`, `jq`,
and the literal private deploy key in `HOMEBREW_TAP_SSH_KEY`, supplied only to the
approved Homebrew workflow step. It uses HTTPS GitHub metadata for strict SSH host
verification, stages only the cask, and skips identical same-version content.
It rejects numeric version downgrades, changed same-version content (including
checksums), and malformed or missing versions in an existing cask without
evaluating Ruby. Leave newer tap releases intact; publish a new version for changed
assets, and manually review/repair malformed tap metadata before retrying.
The key and clone
are trap-cleaned on exit/INT/TERM (not SIGKILL or power loss). No personal SSH keys,
PAT, credential helper, or global author configuration is used. Keep tap Actions
disabled and the key scoped to this tap; see the root README's protection setup.

## Third-Party Notices

Python 3.9+, the pinned Rust toolchain, and **cargo-about 0.9.2** are required:

```sh
cargo install cargo-about --version 0.9.2 --locked --features cli
python3 scripts/release/generate-notices.py OUTPUT_DIR/THIRD-PARTY-NOTICES.txt
```

The Python wrapper checks that exact tool version, then runs `cargo about generate
--locked --all-features --workspace --fail --config scripts/release/about.toml
--format json`. It renders the tool's unique license texts and package associations
directly, preserving copyright in its evidence rather than inventing holders from
Cargo authors. No separate Handlebars template is needed. Cargo-about may download
package sources and retrieve upstream license evidence; when no matching text is
found, its pinned standard SPDX corpus supplies canonical text. Each report section
identifies collected evidence versus canonical text. Canonical text does not by
itself recover every upstream attribution. Network/cache differences may affect
retrieved evidence, so byte-identical reports across machines are not guaranteed.

`about.toml` filters to the union of `aarch64-apple-darwin`,
`x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, and
`x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, and
`aarch64-pc-windows-msvc`, matching the packaging
targets. All features and build/dev dependencies remain included, a
conservative superset of any one release binary, not its exact linked inventory.
The accepted-license list covers the current graph's reviewed choices; Apache is
preferred for dual licenses. `CDLA-Permissive-2.0` covers `webpki-roots` trust data
and requires its agreement text with redistribution. MPL is accepted only for
`cbindgen 0.28.0` (build tool), `option-ext 0.2.0`, `nucleo-matcher 0.3.1`, the
`symphonia` MP3 crates, and
`dwrote 0.11.5` (Windows only). The wrapper rejects version
changes to those exceptions until reviewed. The report gives version-specific
crate-source download links, including these unmodified MPL sources. Keep those
sources available and re-review obligations if dependencies are modified.

The UTF-8 report includes the lockfile SHA-256, package name/version, Cargo source,
declared license expression and cargo-about license texts. A supplemental scan
preserves available package-root LICENSE,
LICENCE, COPYING, COPYRIGHT and NOTICE files (including suffixes), all files
recursively in root `license`, `licenses`, `licence`, `licences`, `legal`
directories, and every explicit Cargo `license-file`. This preserves notices and
alternative license texts even when they were not selected by cargo-about.
Escaping paths, empty/unreadable discovered files, unresolved or unaccepted
licenses, failed tool invocations, missing package coverage, and a changed
lockfile fail generation. A missing source license file is not alone a failure
when cargo-about resolves a standard SPDX license. No report is written until
resolution and collection succeed; existing reports are refused to prevent stale
reuse. Neither Cargo.lock nor dependency versions are updated by this command.

All package interfaces require a nonempty report. macOS includes it in
`Contents/Resources/THIRD-PARTY-NOTICES.txt`; Linux includes it in
`share/licenses/herdr-gpui/THIRD-PARTY-NOTICES.txt`; Windows includes it in
`licenses/THIRD-PARTY-NOTICES.txt`. Secret-free build jobs generate
reports before packaging. Each macOS binary artifact carries its report; assembly
requires the two reports to match byte-for-byte before signing. Local DMG builds
also generate notices before sourcing signing configuration.

All bundles also preserve root `LICENSE`, `NOTICE`, protocol `LICENSE-APACHE`
and `NOTICE.md`, and `assets/icons/LICENSE-octicons` as separate files.

**Public release review is required:** generation is an inventory, not legal
approval or proof that every embedded third-party component was found. Review
license expressions (including unknown/custom and dual-license choices), text
coverage, copyright and NOTICE obligations, nested vendored code, native libraries,
and non-Cargo assets before approving the release environment. Do not treat the
presence of a report or a configured allowlist as legal approval. Where review
finds missing upstream notices, add version-bound evidence with provenance rather
than fabricated fallback text or a broad license exception.

## Local DMG

`just dmg VERSION` (or `bash scripts/release/build-macos.sh VERSION`) builds both
architectures locally, assembles the app, and signs/notarizes it without publishing.
Use macOS with Xcode command-line tools, the pinned Rust toolchain, `jq`,
`cargo-about 0.9.2` installed as above, and the
signing prerequisites above. Install both targets explicitly first:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
# Public key only, obtained from the reviewed repository Actions variable:
export HERDR_UPDATE_PUBLIC_KEY=YOUR_64_LOWERCASE_HEX_PUBLIC_KEY
just dmg 20260920.1
```

Any valid `YYYYMMDD.COUNTER` version works locally; only the release workflow
derives and publishes versions. Builds use `--locked`, `--target-dir target`, and
`MACOSX_DEPLOYMENT_TARGET=14.2` and `HERDR_RELEASE_VERSION=VERSION` on both targets.
The caller must supply a valid `HERDR_UPDATE_PUBLIC_KEY` before building. All six
Apple signing variables listed above and `HERDR_UPDATE_SIGNING_KEY` are removed
from Cargo's environment, including metadata queries. No local `.envrc` is sourced
until both builds and unsigned assembly succeed.
Host build dependencies use `CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=none`:
Apple stripping produced unloadable, misaligned proc-macro dylibs during local
Intel cross-compilation. The setting does not disable optimization or change
stripping policy for the distributed executable.

A missing root `.envrc` fails before building. This ignored file contains **no
credentials** and defines `herdr_sign VERSION APP OUT`, calling the ignored
`.envrc.sign.rb` helper. The helper and its credential storage are machine-specific:
cloning this repository does not replicate or provision them. Provision them
separately on a trusted signing machine; do not commit either file or credentials,
and do not export signing secrets globally through direnv.

Alternatively, define `herdr_sign` in your ignored `.envrc` to invoke
`bash scripts/release/sign-macos.sh "$@"` with the six variables supplied directly
to that command's environment by your credential manager (`env NAME=value ...
bash scripts/release/sign-macos.sh "$@"`). Retrieve them only inside the function,
not when sourcing `.envrc`; never put literal credentials in shell history or the
file. This direct environment interface does not require the machine-local Ruby
helper.

Output is an unsigned assembly at `target/distribution/VERSION/Herdr.app` and the
signed, notarized
`Herdr-VERSION-universal-apple-darwin.dmg` and
`herdr-gpui-VERSION-macos-universal.app.tar.gz` in the same directory when using
`sign-macos.sh`. Local packaging does not sign an Ed25519 update manifest or
publish anything. An existing version
directory (including a symlink) is refused before building and checked again before
promotion. Notices, assembly, and signing use a temporary directory under
`target/distribution`, cleaned on failure so the command can be retried directly.
Only after signing succeeds and produces a nonempty DMG is the directory promoted
to `VERSION`. Helper diagnostics remain visible on stderr; the final DMG path is
printed on stdout after promotion. Existing version artifacts are never overwritten.

## Local Validation

```sh
for script in scripts/release/*.sh; do bash -n "$script" || exit; done
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/release/tests -v
PYTHONDONTWRITEBYTECODE=1 python3 scripts/release/test-release-security.py
OPENSSL="$(brew --prefix openssl@3)/bin/openssl" \
  python3 -m unittest discover -s scripts -p 'test_update_manifest.py' -v
actionlint .github/workflows/release.yml
zizmor --offline .github/workflows/release.yml
```

Tests run on macOS and Linux with Python 3, Git and `jq`. They use dummy credentials
and mocked Apple tools/OS detection, check rejection and cleanup paths (including
macOS-only production guards), and inspect both Linux target tarballs.
Tap tests mock HTTPS/SSH transport and push only to disposable local repositories;
they cover default-branch resolution, cask-only commits, no-op updates and failures.
They do not perform real signing, notarization, Gatekeeper assessment or native
launch testing. Real release validation still needs the trusted signing runner.
