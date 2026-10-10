#!/usr/bin/env bash
# Disable tracing before reading credentials, including when invoked with bash -x.
set +x
set -euo pipefail
# This script must never run under `set -x`, so a failure otherwise reports only
# a tool's message with no indication of which command produced it. Report the
# line number, which is safe: it reveals no credential material.
set -E
trap 'printf "sign-macos.sh: failed at line %d\n" "$LINENO" >&2' ERR
source "$(dirname -- "$0")/common.sh"
[[ $# == 3 ]] || fail 'Usage: bash sign-macos.sh VERSION UNSIGNED_APP OUTPUT_DIR'
version_check "$1"
[[ $(uname -s) == Darwin ]] || fail 'macOS required'
[[ -d $2 && -d $3 ]] || fail 'App and existing output directory required'
for name in MACOS_CERTIFICATE_P12_BASE64 MACOS_CERTIFICATE_PASSWORD APPLE_API_PRIVATE_KEY APPLE_API_KEY_ID APPLE_API_ISSUER_ID MACOS_SIGNING_IDENTITY; do
    [[ -n ${!name:-} ]] || fail "Required environment variable: $name"
done
[[ $MACOS_SIGNING_IDENTITY == 'Developer ID Application: '* ]] || fail 'A Developer ID Application identity is required'
command -v jq >/dev/null || fail 'jq required'
out=$(cd -- "$3" && pwd)/Herdr-$1-universal-apple-darwin.dmg
update=${out%/*}/herdr-gpui-$1-macos-universal.app.tar.gz
new_output "$out"
new_output "$update"
umask 077
tmp=$(mktemp -d "${out%/*}/.herdr-sign.XXXXXX")
keychain=$tmp/signing.keychain-db
search_list_touched=0
original_keychains=()
cleanup_keychain() {
    local failed=0
    if [[ $search_list_touched == 1 ]]; then
        security list-keychains -d user -s "${original_keychains[@]}" || failed=1
    fi
    if [[ -e $keychain ]]; then
        security delete-keychain "$keychain" >/dev/null 2>&1 || failed=1
    fi
    return "$failed"
}
cleanup() {
    status=$?
    trap - EXIT
    cleanup_keychain || status=1
    rm -rf -- "$tmp" || status=1
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Creation may add the keychain to the user search list on some macOS versions,
# and may not. Set the list explicitly below so the signing keychain is present
# exactly once; cleanup_keychain restores the original list.
search_list=$(security list-keychains -d user)
while IFS= read -r line; do
    [[ -z $line ]] && continue
    [[ $line =~ ^[[:space:]]*\"(.*)\"[[:space:]]*$ ]] || fail 'Cannot parse keychain search list'
    original_keychains+=("${BASH_REMATCH[1]}")
done <<< "$search_list"
password=$(openssl rand -hex 32)
printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 -D > "$tmp/certificate.p12"
printf '%s\n' "$APPLE_API_PRIVATE_KEY" > "$tmp/AuthKey.p8"
unset MACOS_CERTIFICATE_P12_BASE64 APPLE_API_PRIVATE_KEY
search_list_touched=1
security create-keychain -p "$password" "$keychain"
# codesign does not honour --keychain for identity lookup on macOS 15: it searches
# the user keychain search list, so the signing keychain must be in it. Verified on
# a macos-15 runner, where an identity that `security find-identity` reports as
# valid is otherwise rejected with "The specified item could not be found in the
# keychain". cleanup_keychain restores the original list.
security list-keychains -d user -s "${original_keychains[@]}" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$tmp/certificate.p12" -k "$keychain" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
unset MACOS_CERTIFICATE_PASSWORD
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
unset password
rm "$tmp/certificate.p12"
mkdir "$tmp/image"
app=$tmp/image/Herdr.app
ditto "$2" "$app"
[[ $(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist") == "$1" ]] || fail 'App version mismatch'
[[ $(plutil -extract CFBundleVersion raw "$app/Contents/Info.plist") == "$1" ]] || fail 'App build version mismatch'
[[ $(plutil -extract LSMinimumSystemVersion raw "$app/Contents/Info.plist") == 14.2 ]] || fail 'App minimum OS mismatch'
for arch in arm64 x86_64; do
    lipo "$app/Contents/MacOS/Herdr" -verify_arch "$arch"
done
codesign --force --sign "$MACOS_SIGNING_IDENTITY" --keychain "$keychain" --options runtime --entitlements "$release_root/assets/macos/Herdr.entitlements" --timestamp "$app/Contents/MacOS/Herdr"
codesign --force --sign "$MACOS_SIGNING_IDENTITY" --keychain "$keychain" --options runtime --entitlements "$release_root/assets/macos/Herdr.entitlements" --timestamp "$app"
codesign --verify --deep --strict --verbose=2 "$app"
notarize() {
    xcrun notarytool submit "$1" --key "$tmp/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait --output-format json > "$tmp/notary.json"
    jq -e -s 'length == 1 and (.[0] | type == "object" and .status == "Accepted")' "$tmp/notary.json" >/dev/null || fail 'Notarization did not return Accepted'
}
ditto -c -k --keepParent "$app" "$tmp/Herdr.zip"
notarize "$tmp/Herdr.zip"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app"
ln -s /Applications "$tmp/image/Applications"
hdiutil create -volname Herdr -srcfolder "$tmp/image" -format UDZO -ov "$tmp/Herdr.dmg"
codesign --force --sign "$MACOS_SIGNING_IDENTITY" --keychain "$keychain" --timestamp "$tmp/Herdr.dmg"
notarize "$tmp/Herdr.dmg"
xcrun stapler staple "$tmp/Herdr.dmg"
xcrun stapler validate "$tmp/Herdr.dmg"
codesign --verify --strict --verbose=2 "$tmp/Herdr.dmg"
spctl --assess --type open --context context:primary-signature --verbose=2 "$tmp/Herdr.dmg"
# Package the signed, stapled copy, never the caller's unsigned assembly.
python3 "$release_root/scripts/update-manifest.py" package-macos "$app" "$tmp/update.tar.gz"
chmod 644 "$tmp/Herdr.dmg"
chmod 644 "$tmp/update.tar.gz"
cleanup_keychain
search_list_touched=0
mv "$tmp/Herdr.dmg" "$out"
mv "$tmp/update.tar.gz" "$update"
printf '%s\n' "$out"
