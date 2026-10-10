#!/usr/bin/env bash
# Repeat the Linux test suite under CPU pressure, where scheduling races that a
# fast workstation hides actually reproduce. A half-core container reproduced the
# updater's lost-output race at 3 runs in 30 while the same tests passed 14 times
# in a row unthrottled, and on every CI runner but one.
#
# Reads the working tree, never writes to it. Toolchain and build outputs are
# cached outside the repository so repeated runs stay cheap.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

iterations=${1:-30}
cpus=${2:-0.5}
filter=${3:-}
[[ $iterations =~ ^[1-9][0-9]*$ ]] || fail 'ITERATIONS must be a positive integer'
[[ $cpus =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail 'CPUS must be a number, for example 0.5'
command -v docker >/dev/null || fail 'docker is required'
docker info >/dev/null 2>&1 || fail 'the docker daemon is not running'
command -v rsync >/dev/null || fail 'rsync is required'

root=$(git rev-parse --show-toplevel)
# Cache outside the repository: the container writes here as root, and the
# worktree must stay exactly as the developer left it.
cache=${HERDR_STRESS_CACHE:-${TMPDIR:-/tmp}/herdr-stress}
mkdir -p "$cache/tree"
rsync -a --delete --exclude target --exclude .git "$root/" "$cache/tree/"

cat > "$cache/run.sh" <<'INNER'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/cache/cargo/bin:$PATH"
export CARGO_HOME=/cache/cargo RUSTUP_HOME=/cache/rustup CARGO_TARGET_DIR=/cache/target
# System packages live in the container and are gone every run; the toolchain
# lives in the cache and survives. Installing both on the same condition left
# later runs without a linker, so they are decided separately.
# What the workspace links against comes from the script CI runs, so this
# container cannot drift from it: a hand-kept copy here went stale the moment
# the notification sounds added ALSA, and every run failed to build.
bash /tree/scripts/install-linux-deps.sh >/dev/null
# Only what fetching the toolchain into the cache needs.
apt-get install --no-install-recommends -y -qq curl ca-certificates git >/dev/null
if ! command -v cargo >/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain none >/dev/null 2>&1
fi
cd /tree
printf 'host: %s, iterations: %s, filter: %s\n' \
    "$(rustc -vV | sed -n 's/^host: //p')" "$ITERATIONS" "${FILTER:-<none>}"
# Build once so a compile does not count as an iteration or mask a failure.
# Report why a build failed: a harness that hides the reason is worse than none.
if ! build=$(cargo test --locked --workspace --all-features --no-run 2>&1); then
    printf 'FAILED to build the test binaries:\n%s\n' "$(printf '%s' "$build" | tail -25)"
    exit 1
fi
failures=0
for i in $(seq 1 "$ITERATIONS"); do
    output=$(cargo test --locked --workspace --all-features ${FILTER:+"$FILTER"} 2>&1) || true
    if printf '%s' "$output" | grep -q "FAILED\|error: test failed"; then
        failures=$((failures + 1))
        printf '  iteration %s FAILED\n' "$i"
        printf '%s\n' "$output" | grep -E "panicked at|assertion|^---- |^test .* FAILED" | head -6
    fi
done
printf '### %s failure(s) in %s iteration(s)\n' "$failures" "$ITERATIONS"
[[ $failures == 0 ]]
INNER

printf 'Stressing the Linux suite: %s iteration(s) at %s CPU(s). Cache: %s\n' \
    "$iterations" "$cpus" "$cache"
docker run --rm --cpus="$cpus" \
    -v "$cache/tree":/tree -v "$cache":/cache \
    -e ITERATIONS="$iterations" -e FILTER="$filter" \
    ubuntu:24.04 bash /cache/run.sh
