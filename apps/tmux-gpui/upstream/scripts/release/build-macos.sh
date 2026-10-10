#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 1 ]] || fail 'Usage: bash build-macos.sh VERSION'
version_check "$1"
version=$1
[[ $(uname -s) == Darwin ]] || fail 'macOS required'
cd -- "$release_root"
[[ -f .envrc ]] || fail 'Missing local .envrc: configure herdr_sign VERSION APP OUT; see scripts/release/README.md'
out="$release_root/target/distribution/$version"
[[ ! -e $out && ! -L $out ]] || fail "Output already exists: $out"

# Cargo and dependency build scripts must not inherit signing credentials.
build_env=(env
    -u MACOS_CERTIFICATE_P12_BASE64 -u MACOS_CERTIFICATE_PASSWORD
    -u MACOS_SIGNING_IDENTITY -u APPLE_API_PRIVATE_KEY
    -u APPLE_API_KEY_ID -u APPLE_API_ISSUER_ID
    -u HERDR_UPDATE_SIGNING_KEY
    HERDR_RELEASE_VERSION="$version"
    MACOSX_DEPLOYMENT_TARGET=14.2
    # Apple strip can misalign host proc-macro dylibs during cross-compilation.
    CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=none)
# Public configuration must be supplied before loading any local signing helper.
"${build_env[@]}" python3 scripts/update-manifest.py validate-public-key
for target in aarch64-apple-darwin x86_64-apple-darwin; do
    "${build_env[@]}" cargo build --locked --release --target-dir target -p herdr-gpui --target "$target"
done

# Publish only a complete assembly; failures leave the version available for retry.
mkdir -p target/distribution
stage=$(mktemp -d "$release_root/target/distribution/.herdr-build.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${build_env[@]}" python3 scripts/release/generate-notices.py "$stage/THIRD-PARTY-NOTICES.txt"
bash scripts/release/package-macos.sh "$version" \
    target/aarch64-apple-darwin/release/herdr-gpui \
    target/x86_64-apple-darwin/release/herdr-gpui "$stage" "$stage/THIRD-PARTY-NOTICES.txt" >&2
set +x
(
    source ./.envrc
    declare -F herdr_sign >/dev/null || fail 'Local .envrc must define herdr_sign VERSION APP OUT'
    herdr_sign "$version" "$stage/Herdr.app" "$stage"
) >&2
dmg="Herdr-$version-universal-apple-darwin.dmg"
[[ -f $stage/$dmg && -s $stage/$dmg ]] || fail 'Signing did not produce a nonempty DMG'
new_output "$out"
mv -n "$stage" "$out"
[[ ! -d $stage ]] || fail "Could not promote output: $out"
printf '%s\n' "$out/$dmg"
