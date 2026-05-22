#!/usr/bin/env node
// Install the local pre-commit hook that blocks new files under
// repo-root src/. Idempotent — safe to run on every pnpm install.
//
// Skips silently when:
//   - run from a published package (not a git checkout) — no .git dir
//   - INSTALL_GIT_HOOKS=0 in the environment

import { mkdirSync, writeFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

if (process.env.INSTALL_GIT_HOOKS === "0") process.exit(0);

const repoRoot = resolve(dirname(import.meta.dirname));
const gitDir = resolve(repoRoot, ".git");

let isGitCheckout = false;
try {
  isGitCheckout = statSync(gitDir).isDirectory();
} catch {
  /* not a git checkout */
}
if (!isGitCheckout) process.exit(0);

const hooksDir = resolve(gitDir, "hooks");
mkdirSync(hooksDir, { recursive: true });

const hookPath = resolve(hooksDir, "pre-commit");
const hookBody = [
  "#!/usr/bin/env bash",
  "# Managed by scripts/install-git-hooks.js — edits here will be overwritten.",
  "# Edit scripts/check-src-additions.sh for the actual check logic.",
  "",
  "set -e",
  `"${repoRoot}/scripts/check-src-additions.sh"`,
  "",
].join("\n");

let existing = null;
try {
  existing = readFileSync(hookPath, "utf8");
} catch {
  /* no existing hook */
}

if (existing === hookBody) {
  // Already up-to-date.
  process.exit(0);
}

writeFileSync(hookPath, hookBody);
chmodSync(hookPath, 0o755);
console.log("[tmux-ide] installed .git/hooks/pre-commit (blocks new files in src/)");
