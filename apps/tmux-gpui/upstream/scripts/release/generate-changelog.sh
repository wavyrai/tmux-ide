#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 2 ]] || fail 'Usage: bash generate-changelog.sh VERSION OUTPUT_DIR'
version_check "$1"
[[ -d $2 ]] || fail 'Existing output directory required'
command -v git-cliff >/dev/null || fail 'git-cliff is required: cargo install --locked git-cliff'
out=$(cd -- "$2" && pwd)
new_output "$out/CHANGELOG.md"
new_output "$out/RELEASE_NOTES.md"

# The tag is created only when the release publishes, so the commits being cut
# are still "unreleased" here and `--tag` names the version they belong to.
tag=v$1
# git-cliff resolves the repository from the working directory; `--workdir`
# misses the commits of a linked worktree, which release rehearsals run from.
cd -- "$release_root"
source_sha=$(git rev-parse HEAD)

git-cliff --config cliff.toml --tag "$tag" --output "$out/CHANGELOG.md"

# The release body keeps the platform and daemon facts every release states,
# then lists what actually changed since the previous tag.
cat > "$out/RELEASE_NOTES.md" <<NOTES
GUI-only release. macOS 14.2+ universal signed/notarized DMG; experimental x86_64 and ARM64 Linux .deb, .rpm, Arch packages and tarballs (glibc 2.39+); experimental, unsigned Windows x86_64 and ARM64 zips without auto-update. Requires an existing Herdr daemon. Source: $source_sha.

NOTES
git-cliff --config cliff.toml --tag "$tag" --unreleased --strip header >> "$out/RELEASE_NOTES.md"

[[ -s $out/CHANGELOG.md && -s $out/RELEASE_NOTES.md ]] || fail 'Generated changelog is empty'
