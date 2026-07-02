import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Workspace-package links — MUST run before the Claude gate below.
//
// The TUI sources (packages/daemon/src/**, run via bun) import the workspace
// packages @tmux-ide/tmux-bridge and @tmux-ide/contracts. In a dev checkout
// pnpm symlinks them into node_modules; an npm install has no such links, so
// recreate them (their package.json mains point at shipped src/index.ts,
// which bun runs directly). Best-effort: never fail an install.
// ---------------------------------------------------------------------------
try {
  const pkgRoot = dirname(import.meta.dirname);
  const scopeDir = resolve(pkgRoot, "node_modules", "@tmux-ide");
  for (const name of ["tmux-bridge", "contracts"]) {
    const target = resolve(pkgRoot, "packages", name);
    const link = resolve(scopeDir, name);
    if (!existsSync(target) || existsSync(link)) continue;
    mkdirSync(scopeDir, { recursive: true });
    // "junction" keeps Windows working without admin; ignored elsewhere.
    symlinkSync(relative(scopeDir, target), link, "junction");
  }
} catch {
  // linking is best-effort; the CLI's TUI fallback message covers the gap
}

const claudeDir = resolve(homedir(), ".claude");
if (!shouldInstallClaudeIntegration() || !existsSync(claudeDir)) {
  process.exit(0);
}

// Sync the bundled Claude Code skill into ~/.claude/skills/tmux-ide, rewriting
// its version marker to the installed package version. This is the JS twin of
// packages/daemon/src/lib/skill-sync.ts (syncSkill) — postinstall runs under
// stock node before any build, so it can't import the TS module; keep the marker
// regex in sync with VERSION_MARKER_RE there. Best-effort: never fail an install.
try {
  const pkgRoot = dirname(import.meta.dirname);
  const src = resolve(pkgRoot, "skill", "SKILL.md");
  if (existsSync(src)) {
    const skillDir = resolve(claudeDir, "skills", "tmux-ide");
    mkdirSync(skillDir, { recursive: true });
    let content = readFileSync(src, "utf-8");
    try {
      const { version } = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8"));
      if (typeof version === "string" && version.length > 0) {
        content = content.replace(
          /<!--\s*tmux-ide-skill-version:\s*[^\s]+\s*-->/,
          `<!-- tmux-ide-skill-version: ${version} -->`,
        );
      }
    } catch {
      // couldn't read the version — copy the skill verbatim
    }
    writeFileSync(resolve(skillDir, "SKILL.md"), content);
  }
} catch {
  // skill sync is best-effort; a failure must not break the install
}

const settingsPath = resolve(claudeDir, "settings.json");
let settings = {};

if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (error) {
    console.warn(
      `[tmux-ide] Skipping Claude settings update: could not parse ${settingsPath}: ${error.message}`,
    );
    process.exit(0);
  }
}

if (settings == null || typeof settings !== "object" || Array.isArray(settings)) {
  console.warn(
    `[tmux-ide] Skipping Claude settings update: ${settingsPath} does not contain a JSON object.`,
  );
  process.exit(0);
}

const nextSettings = {
  ...settings,
  env: {
    ...(settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? settings.env
      : {}),
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  },
};

writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);

function shouldInstallClaudeIntegration() {
  return process.env.npm_config_global === "true";
}
