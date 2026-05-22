#!/usr/bin/env bash
# verify-endpoints.sh — smoke-tests the command-center HTTP API.
# Curls every parameterless endpoint defined in
# packages/daemon/src/command-center/server.ts and asserts a 2xx (or an
# expected redirect/no-content) response. Project-scoped endpoints are
# only hit when PROJECT=<name> is set.
#
# Usage:
#   ./scripts/verify-endpoints.sh                        # static endpoints only
#   PROJECT=my-app ./scripts/verify-endpoints.sh         # also exercise /api/project/$PROJECT/*
#   BASE=http://localhost:6060 ./scripts/verify-endpoints.sh
#
# Exit code: number of endpoints that did NOT return 2xx (0 = all green).

set -uo pipefail

BASE="${BASE:-http://localhost:6060}"
PROJECT="${PROJECT:-}"
fails=0
total=0

# Endpoints that should always 2xx with no setup.
STATIC_GET=(
  "/health"
  "/api/sessions"
  "/api/projects"
  "/api/projects/templates"
  "/api/daemon/metrics"
  "/api/hq/machines"
  "/api/tunnel"
)

# Endpoints that need a project name (skipped unless PROJECT is set).
PROJECT_GET=(
  "/api/project/{p}"
  "/api/project/{p}/panes"
  "/api/project/{p}/plans"
  "/api/project/{p}/checkpoints"
  "/api/project/{p}/reviews"
  "/api/project/{p}/files"
  "/api/project/{p}/diff"
  "/api/project/{p}/milestones"
  "/api/project/{p}/validation"
  "/api/project/{p}/validation/coverage"
  "/api/project/{p}/research"
  "/api/project/{p}/skills"
  "/api/project/{p}/mission"
  "/api/project/{p}/metrics"
  "/api/project/{p}/metrics/agents"
  "/api/project/{p}/metrics/timeline"
  "/api/project/{p}/metrics/history"
  "/api/project/{p}/orchestrator/health"
  "/api/project/{p}/config"
)

probe() {
  local path="$1"
  local url="${BASE}${path}"
  total=$((total + 1))
  # -L follow redirects, -s silent, -o discard body, -w "%{http_code}".
  local code
  code=$(curl -L -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" || echo "000")
  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    printf "  [\e[32m%s\e[0m] %s\n" "$code" "$path"
  else
    printf "  [\e[31m%s\e[0m] %s\n" "$code" "$path"
    fails=$((fails + 1))
  fi
}

echo "Probing $BASE …"
echo "Static endpoints:"
for p in "${STATIC_GET[@]}"; do
  probe "$p"
done

if [[ -n "$PROJECT" ]]; then
  echo
  echo "Project endpoints (project=$PROJECT):"
  for p in "${PROJECT_GET[@]}"; do
    probe "${p//\{p\}/$PROJECT}"
  done
else
  echo
  echo "(set PROJECT=<name> to also exercise project-scoped endpoints)"
fi

echo
echo "Result: $((total - fails)) / $total OK"
exit "$fails"
