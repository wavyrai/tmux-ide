#!/usr/bin/env bash
# Publish packaging/homebrew/Formula/tmux-ide.rb to the Homebrew tap repo
# (wavyrai/homebrew-tap), i.e. the one-time seeding the CI `bump_tap` job
# assumes. After this, every release keeps the tap current automatically
# (given the TAP_PUSH_TOKEN secret — see .github/workflows/release.yml).
#
# Usage:
#   scripts/publish-tap.sh [path-to-tap-checkout]
#
# With no argument, clones git@github.com:wavyrai/homebrew-tap.git into a
# temp dir. The tap repo must already exist on GitHub (create it empty —
# the name MUST be exactly `homebrew-tap` for `brew install
# wavyrai/tap/tmux-ide` to resolve).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
formula="$repo_root/packaging/homebrew/Formula/tmux-ide.rb"
[[ -f "$formula" ]] || {
  echo "formula not found: $formula" >&2
  exit 1
}

tap_dir="${1:-}"
cleanup=""
if [[ -z "$tap_dir" ]]; then
  tap_dir="$(mktemp -d)/homebrew-tap"
  cleanup="$(dirname "$tap_dir")"
  git clone git@github.com:wavyrai/homebrew-tap.git "$tap_dir"
fi
[[ -d "$tap_dir/.git" ]] || {
  echo "not a git checkout: $tap_dir" >&2
  exit 1
}

version="$(sed -nE 's#^  url ".*/tmux-ide-([0-9][^"]*)\.tgz"$#\1#p' "$formula")"
[[ -n "$version" ]] || {
  echo "could not read the version from the formula url" >&2
  exit 1
}

mkdir -p "$tap_dir/Formula"
cp "$formula" "$tap_dir/Formula/tmux-ide.rb"

cd "$tap_dir"
git add Formula/tmux-ide.rb
if git diff --cached --quiet; then
  echo "tap already has this formula version (v$version) — nothing to push."
else
  git commit -m "tmux-ide $version"
  git push origin HEAD
  echo "pushed tmux-ide v$version to $(git remote get-url origin)"
fi

[[ -n "$cleanup" ]] && rm -rf "$cleanup"
echo "install with: brew install wavyrai/tap/tmux-ide"
