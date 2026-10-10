#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: bash scripts/verify-release.sh --version vYYYYMMDD.COUNTER [--directory DIR] [--sha SHA]
       [--gpg-key PUBLIC_KEY_FILE --gpg-fingerprint FULL_SIGNING_FINGERPRINT]

Without --directory, download the release into a temporary directory.
Verify the exact asset set, both checksums, Sigstore, and GitHub provenance.
--sha additionally pins the expected release source commit (recommended).
Optional supplemental .asc files must be in DIR/gpg/; GPG uses an isolated keyring
and requires the full fingerprint of the actual signing key, including subkeys.
Requires Python 3.11+, gh, and cosign 2.x; optional GPG verification requires gpg.
EOF
}

version='' directory='' sha='' gpg_key='' fingerprint=''
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version|--directory|--sha|--gpg-key|--gpg-fingerprint)
            [[ $# -ge 2 && -n $2 ]] || { usage >&2; exit 1; }
            case "$1" in
                --version) version=${2#v} ;;
                --directory) directory=$2 ;;
                --sha) sha=$2 ;;
                --gpg-key) gpg_key=$2 ;;
                --gpg-fingerprint) fingerprint=$2 ;;
            esac
            shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; exit 1 ;;
    esac
done
[[ $version =~ ^[1-9][0-9]{7}\.[1-9][0-9]*$ ]] || { usage >&2; exit 1; }
[[ -z $sha || $sha =~ ^[0-9a-f]{40}$ ]] || exit 1
if [[ -n $gpg_key || -n $fingerprint ]]; then
    [[ -f $gpg_key && $fingerprint =~ ^([0-9A-F]{40}|[0-9A-F]{64})$ ]] || exit 1
fi
scripts=$(cd -- "$(dirname -- "$0")" && pwd)
repo=penso/herdr-gpui
identity="https://github.com/$repo/.github/workflows/release.yml@refs/heads/main"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
if [[ -z $directory ]]; then
    directory=$tmp/assets
    gh release download "v$version" --repo "$repo" --dir "$directory"
fi
# Supplemental signatures live outside the immutable asset set.
mkdir "$tmp/assets-to-check"
while IFS= read -r name; do
    [[ -f $directory/$name && ! -L $directory/$name ]] || exit 1
    cp "$directory/$name" "$tmp/assets-to-check/$name"
done < <(python3 "$scripts/release/artifact-manifest.py" names "$version" "$directory")
shopt -s dotglob nullglob
for path in "$directory"/*; do
    [[ $path == "$directory/gpg" && -d $path && ! -L $path ]] && continue
    [[ -f $tmp/assets-to-check/${path##*/} && ! -L $path ]] || exit 1
done
python3 "$scripts/release/artifact-manifest.py" verify "$version" "$tmp/assets-to-check"
tag_sha=$(gh api "repos/$repo/git/ref/tags/v$version" --jq '.object | select(.type == "commit") | .sha')
[[ $tag_sha =~ ^[0-9a-f]{40}$ && ( -z $sha || $sha == "$tag_sha" ) ]] || exit 1
sha=$tag_sha
if [[ -n $gpg_key ]]; then
    mkdir -m 700 "$tmp/keyring"
    gpg --homedir "$tmp/keyring" --batch --import "$gpg_key"
fi
while IFS= read -r name; do
    file=$tmp/assets-to-check/$name
    cosign verify-blob --signature "$file.sig" --certificate "$file.crt" \
        --certificate-identity "$identity" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        --certificate-github-workflow-repository "$repo" \
        --certificate-github-workflow-ref refs/heads/main \
        --certificate-github-workflow-sha "$sha" "$file"
    gh attestation verify "$file" --repo "$repo" \
        --cert-identity "$identity" \
        --cert-oidc-issuer https://token.actions.githubusercontent.com \
        --source-ref refs/heads/main --source-digest "$sha" --signer-digest "$sha" \
        --deny-self-hosted-runners
    if [[ -n $gpg_key ]]; then
        gpg --homedir "$tmp/keyring" --batch --status-fd 1 \
            --verify "$directory/gpg/$name.asc" "$file" > "$tmp/gpg-status"
        # VALIDSIG field 3 is the actual signing fingerprint, not a short key ID
        # or the primary fingerprint that can authorize multiple signing subkeys.
        awk -v expected="$fingerprint" '
            $1 == "[GNUPG:]" && $2 == "VALIDSIG" { count++; if ($3 == expected) valid++ }
            END { exit !(count == 1 && valid == 1) }
        ' "$tmp/gpg-status"
    fi
done < <(python3 "$scripts/release/artifact-manifest.py" base-names "$version" "$directory")
echo "Verified v$version at $sha (checksums, Sigstore, provenance)."
