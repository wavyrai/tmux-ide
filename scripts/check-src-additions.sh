#!/usr/bin/env bash
# Block new files under repo-root src/.
#
# Why: src/ is frozen — every consumer migrated to packages/* (T039–T041,
# T056). Adding new code there resurrects the divergent-tree problem the
# T060 work ended.  See ARCHITECTURE.md for the full rule and the canonical
# decision tree.
#
# Usage:
#   - Pre-commit hook: invoked with no args; checks the staged-add set.
#   - CI: pass a base ref as $1 (e.g. origin/main) to check the diff range.
#   - Manual: `bash scripts/check-src-additions.sh origin/main` for a dry run.
#
# Allow-list: any path listed in .src-allowlist (one path per line, blank
# lines and `#`-comments ignored) is permitted. Keep the list small and
# shrinking — every line is a deletion target.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST="$REPO_ROOT/.src-allowlist"

# Resolve the file set to inspect.
if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  # CI / manual: diff vs the supplied base ref.
  base="$1"
  added="$(git -C "$REPO_ROOT" diff --diff-filter=A --name-only "$base"...HEAD -- 'src/**' 2>/dev/null || true)"
else
  # Pre-commit: only the staged-add set.
  added="$(git -C "$REPO_ROOT" diff --diff-filter=A --cached --name-only -- 'src/**' 2>/dev/null || true)"
fi

# Filter against allow-list.
filtered=""
if [ -n "$added" ]; then
  if [ -f "$ALLOWLIST" ]; then
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      # Skip lines whose first non-whitespace char is `#`.
      case "$path" in
        \#*|" "*"#"*) continue ;;
      esac
      if ! grep -Fxq "$path" "$ALLOWLIST"; then
        filtered+="$path"$'\n'
      fi
    done <<< "$added"
  else
    filtered="$added"$'\n'
  fi
fi

# Trim trailing newline + any blank lines.
filtered="$(printf '%s' "$filtered" | sed '/^$/d')"

if [ -n "$filtered" ]; then
  cat >&2 <<EOF
ERROR: new files added under repo-root src/ are not allowed.

src/ is frozen — every canonical home for new code lives under packages/*.
See ARCHITECTURE.md ("Decision tree: where does new code go?") for the right
package, and ARCHITECTURE.md ("How guardrails enforce this") for context on
this check (T060).

Offending files:
$filtered

If a single path genuinely needs to be carved out (rare — usually a transient
shim during a migration), add it to .src-allowlist with a one-line comment
explaining why and link the follow-up issue/task that will delete it.
EOF
  exit 1
fi

exit 0
