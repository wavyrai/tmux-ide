#!/usr/bin/env bash
# Install the pinned nfpm release into DESTINATION after checking its SHA-256.
# The digests are copied from nfpm's checksums.txt for this exact version, whose
# Sigstore bundle was verified when the pin was chosen; bump them together.
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 1 ]] || fail 'Usage: bash install-nfpm.sh DESTINATION_DIR'
version=2.47.0
case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) asset=Linux_x86_64 sha=0660ca602b2d2d2ae4781a06c692b3eeb9d437ffea05b831d76e41f4a3188783 ;;
    Linux-aarch64) asset=Linux_arm64 sha=1c0f5f2999b9a974bfb04fdb0cc3306096de530ac5dbb25d739cc5f5219c919c ;;
    Darwin-arm64) asset=Darwin_arm64 sha=e8c9d1d9ac218eeed479375143dc46b8d51a2b8dbba8e2f9f15ecc8faa2e404b ;;
    Darwin-x86_64) asset=Darwin_x86_64 sha=2b04108f8757313dde92ed729560845aadfb7782887eb6988a5dd96f9c146861 ;;
    *) fail "No pinned nfpm build for $(uname -s)-$(uname -m)" ;;
esac
mkdir -p -- "$1"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/nfpm.tar.gz" \
    "https://github.com/goreleaser/nfpm/releases/download/v$version/nfpm_${version}_$asset.tar.gz"
actual=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$tmp/nfpm.tar.gz")
[[ $actual == "$sha" ]] || fail "nfpm archive digest mismatch: $actual"
tar -xzf "$tmp/nfpm.tar.gz" -C "$tmp" nfpm
install -m 0755 "$tmp/nfpm" "$1/nfpm"
"$1/nfpm" --version | grep -q "$version" || fail 'Installed nfpm reports an unexpected version'
printf '%s\n' "$1/nfpm"
