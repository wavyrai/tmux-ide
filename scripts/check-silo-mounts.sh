#!/usr/bin/env bash
# G14-T01 Rule 4: no raw `mount(...)` calls outside silo bridge files.
#
# Silo packages expose a `mount(el, props)` entry point that returns a handle.
# That call belongs in ONE place per silo: a bridge file. Anywhere else means
# someone copy-pasted the snippet and is now spawning silo lifetimes from
# arbitrary components. See ADR-0001 §1.4 Rule 4.
#
# Convention: bridge files match `*Bridge.tsx`, `*-bridge.tsx`, or
# `*Island.tsx`. The
# `.silo-mount-allowlist` file at the repo root holds pre-existing exceptions
# (paths to refactor in a follow-up); new violations are blocked.
#
# Usage:
#   pnpm check:silo-mounts
#
# Exits 0 if clean, non-zero on violation.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST="${ROOT_DIR}/.silo-mount-allowlist"

is_allowed() {
  local rel="$1"
  [[ -f "$ALLOWLIST" ]] || return 1
  # Match exact line, ignoring blanks and comments via grep filters.
  grep -v '^[[:space:]]*$' "$ALLOWLIST" | grep -v '^[[:space:]]*#' | grep -Fxq "$rel"
}

# Look for the canonical bridge pattern: `mod.mount(`, `mod.mountX(`,
# `<silo>.mount(`, or `import("@tmux-ide/<silo>").mount(`. Match any
# identifier that follows `.mount` so silos with custom names like
# `mountExplorer` are still caught.
PATTERN='\.mount[A-Za-z]*\('

fail=0

# Restrict the search to dashboard/ and app-electron/ (the bridge hosts).
SEARCH_DIRS=()
[[ -d "$ROOT_DIR/dashboard" ]] && SEARCH_DIRS+=("$ROOT_DIR/dashboard")
[[ -d "$ROOT_DIR/app-electron" ]] && SEARCH_DIRS+=("$ROOT_DIR/app-electron")

if [[ ${#SEARCH_DIRS[@]} -eq 0 ]]; then
  exit 0
fi

# grep returns 1 when no matches; that's fine here.
matches="$(grep -RIln \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist \
  --exclude-dir=__tests__ --exclude-dir=out \
  -E "$PATTERN" "${SEARCH_DIRS[@]}" || true)"

if [[ -z "$matches" ]]; then
  exit 0
fi

while IFS= read -r abs_path; do
  [[ -z "$abs_path" ]] && continue
  rel_path="${abs_path#"$ROOT_DIR/"}"
  base="$(basename "$abs_path")"

  # Files that match the bridge convention are allowed.
  if [[ "$base" == *Bridge.tsx || "$base" == *Bridge.ts ||
        "$base" == *-bridge.tsx || "$base" == *-bridge.ts ||
        "$base" == *Island.tsx || "$base" == *Island.ts ]]; then
    continue
  fi

  # Explicit pre-existing allowances (rename or refactor tracked separately).
  if is_allowed "$rel_path"; then
    continue
  fi

  # Ignore lines that look like test/debug uses of unrelated `.mount(`
  # (rare; keeps signal high). Check that at least one matching line
  # references either "@tmux-ide/" or a bare `mod.mount(` pattern in the
  # immediate vicinity.
  if ! grep -qE "(@tmux-ide/|mod\.mount|import\s*\(\s*[\"']@tmux-ide/)" "$abs_path"; then
    continue
  fi

  echo "ERROR: silo mount() called outside a Bridge/Island file: $rel_path"
  echo "       Either rename the file to *Bridge.tsx / *-bridge.tsx / *Island.tsx, or"
  echo "       add it to .silo-mount-allowlist with a tracking note."
  fail=1
done <<< "$matches"

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "G14-T01 Rule 4 violated. See docs/adr/0001-rsc-shell-and-siloed-blocks.md §1.4."
  exit 1
fi

exit 0
