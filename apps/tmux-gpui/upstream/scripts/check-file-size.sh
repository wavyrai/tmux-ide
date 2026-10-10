#!/usr/bin/env bash
# Fail when a tracked source file (Rust, Python, shell, Swift) exceeds MAX_LINES.
# There is no allowlist: split an oversized file by responsibility instead.

set -euo pipefail

MAX_LINES=1000

cd "$(git rev-parse --show-toplevel)"

failures=0
while IFS= read -r -d '' file; do
  # A path deleted in the working tree is still listed by git until staged.
  [[ -f "$file" ]] || continue
  lines=$(wc -l < "$file" | tr -d ' ')
  if ((lines > MAX_LINES)); then
    echo "FAIL: $file has $lines lines (limit $MAX_LINES)"
    failures=$((failures + 1))
  fi
done < <(git ls-files -z -- '*.rs' '*.py' '*.sh' '*.swift')

if ((failures > 0)); then
  echo
  echo "$failures file(s) over $MAX_LINES lines. Split them into modules by responsibility."
  exit 1
fi

echo "All source files are within $MAX_LINES lines."
