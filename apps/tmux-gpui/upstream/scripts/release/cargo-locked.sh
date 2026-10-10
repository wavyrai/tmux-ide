#!/usr/bin/env bash
set -euo pipefail
# cargo-cyclonedx 0.5.9 does not expose --locked; cargo_metadata honors CARGO.
if [[ ${1:-} == metadata ]]; then
    exec "$RELEASE_CARGO" "$@" --locked
fi
exec "$RELEASE_CARGO" "$@"
