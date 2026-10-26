#!/usr/bin/env bash
# Clippy for Linux from any host with Docker, in the same Ubuntu 24.04 the CI
# runners use. A cfg gate that is wrong only on Linux is invisible from macOS,
# and `just lint-windows` only covers Windows; this is the third corner.
#
# The container runs the host's architecture by default. Pass a platform, for
# example linux/amd64 on Apple Silicon, to check the other one under emulation.
#
# Reads the working tree, never writes to it. Toolchain and build outputs are
# cached outside the repository so repeated runs stay cheap.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

platform=${1:-}
[[ $platform =~ ^(linux/[a-z0-9/]+)?$ ]] || fail 'PLATFORM must look like linux/amd64'
command -v docker >/dev/null || fail 'docker is required'
docker info >/dev/null 2>&1 || fail 'the docker daemon is not running'
command -v rsync >/dev/null || fail 'rsync is required'

# This client may be vendored inside a larger repository. Copy its workspace,
# not the outer Git checkout (which can contain unrelated dependency caches).
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Cache outside the repository: the container writes here as root, and the
# worktree must stay exactly as the developer left it. Keyed by platform so an
# emulated build cannot reuse the native architecture's target directory.
name=${platform:-native}
temp=${TMPDIR:-/tmp}
cache=${HERDR_LINT_CACHE:-${temp%/}/herdr-lint-linux}/${name//\//-}
mkdir -p "$cache/tree"
rsync -a --delete --exclude target --exclude .git "$root/" "$cache/tree/"
# tmux-ide patches the Apple backend beside this vendored workspace. Cargo still
# resolves target-specific patch manifests on Linux, even though it never builds
# the macOS implementation. Preserve that exact relative layout in the snapshot.
mkdir -p "$cache/vendor"
if [[ -d "$root/../vendor/bezel-gpui-apple" ]]; then
    mkdir -p "$cache/vendor/bezel-gpui-apple"
    rsync -a --delete --exclude target --exclude .git \
        "$root/../vendor/bezel-gpui-apple/" "$cache/vendor/bezel-gpui-apple/"
fi

# The tmux-ide qualification tests include these sibling data files at compile
# time. Copy only fixture inputs, not the outer application's runtime or caches.
mkdir -p "$cache/fixtures" "$cache/bridge" "$cache/evidence/home-fleet-2026-10-15"
if [[ -d "$root/../fixtures" ]]; then
    rsync -a --delete "$root/../fixtures/" "$cache/fixtures/"
fi
for fixture in bridge/binary-vectors.json evidence/home-fleet-2026-10-15/fleet.json; do
    if [[ -f "$root/../$fixture" ]]; then
        cp "$root/../$fixture" "$cache/$fixture"
    fi
done

cat > "$cache/run.sh" <<'INNER'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/cache/cargo/bin:$PATH"
export CARGO_HOME=/cache/cargo RUSTUP_HOME=/cache/rustup CARGO_TARGET_DIR=/cache/target

# Reuse CI's dependency list rather than a second copy that can drift. It calls
# sudo, which a root container has no reason to install.
printf '#!/bin/sh\nexec "$@"\n' > /usr/local/bin/sudo
chmod +x /usr/local/bin/sudo
cd /tree

dependencies() {
    apt-get update -qq
    apt-get install --no-install-recommends -y -qq curl ca-certificates git
    bash scripts/install-linux-deps.sh
}
# System packages live in the container and are gone every run; the toolchain
# lives in the cache and survives. A mirror can change between the index fetch
# and the download, so retry rather than fail a lint run on a transient hash
# mismatch. Report the reason on the last attempt: a harness that hides why it
# failed is worse than none.
for attempt in 1 2 3; do
    if output=$(dependencies 2>&1); then
        break
    fi
    if [ "$attempt" = 3 ]; then
        printf 'FAILED to install build dependencies:\n%s\n' "$(printf '%s' "$output" | tail -15)"
        exit 1
    fi
    sleep 5
done

if ! command -v cargo >/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain none >/dev/null 2>&1
fi
# Installs the pinned toolchain and its clippy component from rust-toolchain.toml.
rustup show >/dev/null
# One rustc per 2 GiB. A cold build of this graph at full parallelism exhausts a
# default Docker VM, and the container is then OOM-killed with exit code 137.
jobs=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / (2 * 1024 * 1024) ))
if [ "$jobs" -lt 1 ]; then jobs=1; fi
if [ "$jobs" -gt "$(nproc)" ]; then jobs=$(nproc); fi
export CARGO_BUILD_JOBS=$jobs
# Persist compiled dependencies, but do not retain rustc's incremental query graph
# for this large all-targets check inside a memory-limited Docker VM.
export CARGO_INCREMENTAL=0

printf 'host: %s, jobs: %s\n' "$(rustc -vV | sed -n 's/^host: //p')" "$jobs"
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo clippy --locked --workspace --all-targets --no-default-features -- -D warnings
INNER

# An explicit branch, not `[[ ... ]] && run+=(...)`: under `set -e` a false test
# as the last statement of a list is a well-known way to exit a script early.
run=(docker run --rm)
if [[ -n $platform ]]; then
    run+=(--platform "$platform")
fi
run+=(-v "$cache/tree":/tree:ro -v "$cache/vendor":/vendor:ro -v "$cache/fixtures":/fixtures:ro
    -v "$cache/bridge":/bridge:ro -v "$cache/evidence":/evidence:ro -v "$cache":/cache ubuntu:24.04 bash /cache/run.sh)

printf 'Linting for Linux%s. Cache: %s\n' "${platform:+ ($platform)}" "$cache"
status=0
"${run[@]}" || status=$?
if [[ $status == 137 ]]; then
    fail 'the container was killed; give Docker more memory and run again'
fi
exit "$status"
