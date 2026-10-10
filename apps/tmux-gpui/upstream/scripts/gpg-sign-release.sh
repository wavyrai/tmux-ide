#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: bash scripts/gpg-sign-release.sh vYYYYMMDD.COUNTER OUTPUT_DIR FULL_SIGNING_FINGERPRINT

Download and verify immutable release assets, then create supplemental detached
GPG signatures in OUTPUT_DIR/gpg/. OUTPUT_DIR must not exist. Nothing is uploaded
or replaced on GitHub. Requires gh, cosign 2.x, Python 3.11+, and a local GPG key.
Use the complete signing subkey fingerprint, not a short key ID.
EOF
}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
[[ $# == 3 ]] || { usage >&2; exit 1; }
version=${1#v} output=$2 fingerprint=$3
[[ $version =~ ^[1-9][0-9]{7}\.[1-9][0-9]*$ ]] || exit 1
[[ $fingerprint =~ ^([0-9A-F]{40}|[0-9A-F]{64})$ ]] || exit 1
[[ ! -e $output && ! -L $output ]] || { echo 'Output already exists' >&2; exit 1; }
scripts=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -m 700 -- "$output"
gh release download "v$version" --repo penso/herdr-gpui --dir "$output"
bash "$scripts/verify-release.sh" --version "$version" --directory "$output"
mkdir -m 700 "$output/gpg"
while IFS= read -r name; do
    gpg --batch --local-user "$fingerprint!" --armor --detach-sign \
        --output "$output/gpg/$name.asc" "$output/$name"
done < <(python3 "$scripts/release/artifact-manifest.py" base-names "$version" "$output")
echo "Supplemental signatures saved in $output/gpg; no remote changes made."
