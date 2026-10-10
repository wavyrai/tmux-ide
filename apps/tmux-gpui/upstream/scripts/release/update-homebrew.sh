#!/usr/bin/env bash
set +x
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 2 ]] || fail 'Usage: bash update-homebrew.sh VERSION RENDERED_CASK'
version_check "$1"
[[ -f $2 && ! -L $2 && -s $2 ]] || fail 'Rendered cask must be a nonempty regular file'
grep -Fxq "  version \"$1\"" "$2" || fail 'Rendered cask version does not match'
[[ -n ${HOMEBREW_TAP_SSH_KEY:-} ]] || fail 'HOMEBREW_TAP_SSH_KEY is required'

umask 077
temp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/herdr-tap.XXXXXXXX")
trap 'rm -rf -- "$temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$HOMEBREW_TAP_SSH_KEY" > "$temp/key"
unset HOMEBREW_TAP_SSH_KEY
chmod 600 "$temp/key"
# Bootstrap trust over verified HTTPS, never from an unauthenticated ssh-keyscan.
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 60 https://api.github.com/meta > "$temp/meta.json"
jq -er '.ssh_keys | select(type == "array" and length > 0) | .[] | "github.com " + .' \
    "$temp/meta.json" > "$temp/known_hosts"
export GIT_SSH_COMMAND="ssh -F /dev/null -i '$temp/key' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$temp/known_hosts' -o GlobalKnownHostsFile=/dev/null"
export GIT_TERMINAL_PROMPT=0
git -c core.hooksPath=/dev/null clone --depth=1 --single-branch \
    git@github.com:penso/homebrew-tap.git "$temp/tap"
branch=$(git -C "$temp/tap" symbolic-ref --short HEAD)
git check-ref-format "refs/heads/$branch"
[[ ! -L $temp/tap/Casks && ! -L $temp/tap/Casks/herdr-gpui.rb ]] || fail 'Refusing symlink cask path'
[[ ! -e $temp/tap/Casks/herdr-gpui.rb || -f $temp/tap/Casks/herdr-gpui.rb ]] || fail 'Cask path is not a regular file'
if [[ -f $temp/tap/Casks/herdr-gpui.rb ]]; then
    # Parse only a single literal version declaration; never evaluate tap Ruby.
    declaration=$(grep -E '^[[:blank:]]*version([[:blank:]]|$)' "$temp/tap/Casks/herdr-gpui.rb") || fail 'Missing existing cask version'
    [[ $declaration =~ ^[[:blank:]]*version[[:blank:]]+\"([0-9.]+)\"[[:blank:]]*$ ]] || fail 'Malformed existing cask version'
    current_version=${BASH_REMATCH[1]}
    if [[ $current_version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
        # One-time migration: the tap may still hold the pre-calendar X.Y.Z cask,
        # which every calendar version supersedes, so there is no order to enforce.
        printf '%s\n' "Replacing pre-calendar cask version $current_version"
    else
        version_check "$current_version"
        IFS=. read -r -a current_parts <<< "$current_version"
        IFS=. read -r -a next_parts <<< "$1"
        for i in 0 1; do
            current=${current_parts[$i]}
            next=${next_parts[$i]}
            # Length then lexical comparison avoids integer overflow for large components.
            if [[ ${#next} -lt ${#current} || ( ${#next} -eq ${#current} && $next < $current ) ]]; then
                fail "Refusing Homebrew downgrade from $current_version to $1"
            fi
            [[ $next == "$current" ]] || break
        done
        if [[ $1 == "$current_version" ]]; then
            cmp -s -- "$2" "$temp/tap/Casks/herdr-gpui.rb" || fail 'Same cask version has different content; publish a new version'
            printf '%s\n' 'Homebrew cask is already up to date'
            exit 0
        fi
    fi
fi
mkdir -p "$temp/tap/Casks"
cp -- "$2" "$temp/tap/Casks/herdr-gpui.rb"
git -C "$temp/tap" add -- Casks/herdr-gpui.rb
if git -C "$temp/tap" diff --cached --quiet --exit-code; then
    printf '%s\n' 'Homebrew cask is already up to date'
    exit 0
else
    status=$?
    [[ $status == 1 ]] || exit "$status"
fi
export GIT_AUTHOR_NAME='Herdr GPUI release'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git -C "$temp/tap" -c core.hooksPath=/dev/null -c commit.gpgSign=false \
    commit -m "chore: release herdr-gpui $1"
git -C "$temp/tap" -c core.hooksPath=/dev/null push origin "HEAD:refs/heads/$branch"
