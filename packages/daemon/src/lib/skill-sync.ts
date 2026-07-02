/**
 * Managed sync of the bundled Claude Code skill → `~/.claude/skills/tmux-ide`.
 *
 * `skill/SKILL.md` is the manual a coding agent loads to drive tmux-ide. It ships
 * IN the package, but the copy that agents actually read lives in the user's
 * `~/.claude/skills/` — so every install AND every update has to keep that copy
 * fresh, or agents drive an old CLI. This module is that refresh: it copies the
 * bundled SKILL.md into the tmux-ide skill dir with the version marker rewritten
 * to the installed package version, and reports whether that was an install, an
 * update, or a no-op.
 *
 * The dir is FULLY MANAGED: overwriting our own `~/.claude/skills/tmux-ide` is
 * correct, and this NEVER touches anything outside it (user-authored skills in
 * sibling dirs are safe). The version marker is line 2 of SKILL.md, an HTML
 * comment ({@link VERSION_MARKER_RE}); {@link parseSkillVersion} reads it and
 * {@link rewriteVersionMarker} substitutes it at copy time.
 *
 * The parse/render helpers are PURE and tested against fixtures; {@link syncSkill}
 * is the thin io wrapper (tested with tmp dirs). Wired from three places — the
 * npm `postinstall` (which re-implements the marker rewrite in plain JS since it
 * can't import TS — see scripts/postinstall.js), `tmux-ide skill-sync` / the dev
 * path of `tmux-ide update`, and `tmux-ide integration install claude`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentVersion } from "./update-check.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Claude Code's config dir: `TMUX_IDE_CLAUDE_DIR` when set (tests / per-run
 * overrides), else `~/.claude`. Mirrors the {@link ../tui/integrations/claude.ts}
 * settings override so both halves of the agent setup honor the same scratch dir.
 */
export function claudeDir(): string {
  return process.env.TMUX_IDE_CLAUDE_DIR ?? join(homedir(), ".claude");
}

/** The fully-managed tmux-ide skill dir: `<claudeDir>/skills/tmux-ide`. */
export function skillTargetDir(): string {
  return join(claudeDir(), "skills", "tmux-ide");
}

/** The installed SKILL.md path (inside {@link skillTargetDir}). */
export function skillTargetFile(): string {
  return join(skillTargetDir(), "SKILL.md");
}

/**
 * io — the bundled SKILL.md that ships in the package. Resolved relative to this
 * module, handling BOTH the esbuild-bundled CLI (this file inlines into
 * `bin/cli.js`, so `here` is `bin/` and the skill is one level up) AND the dev
 * source tree (`packages/daemon/src/lib/`, four levels below the repo root) — the
 * same dual-candidate trick as {@link getCurrentVersion}. Returns the first that
 * exists, else the bundled-layout guess.
 */
export function defaultSkillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../skill/SKILL.md"), // bundled bin/cli.js → repo root
    join(here, "../../../../skill/SKILL.md"), // dev src/lib → repo root
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

// ---------------------------------------------------------------------------
// Pure — version marker
// ---------------------------------------------------------------------------

/**
 * The version marker line (an HTML comment on line 2 of SKILL.md). The sync
 * machinery reads it to know which version an installed copy is, and rewrites it
 * to the installed package version at copy time.
 */
export const VERSION_MARKER_RE = /<!--\s*tmux-ide-skill-version:\s*([^\s]+)\s*-->/;

/** PURE — render the marker line for a given version. */
export function versionMarker(version: string): string {
  return `<!-- tmux-ide-skill-version: ${version} -->`;
}

/** PURE — the version in a SKILL.md body, or null when the marker is absent. */
export function parseSkillVersion(content: string): string | null {
  const match = content.match(VERSION_MARKER_RE);
  return match ? match[1]! : null;
}

/**
 * PURE — return `content` with its version marker rewritten to `version`. When no
 * marker is present the content is returned unchanged (the bundled SKILL.md
 * always carries one; this just never corrupts a hand-stripped file).
 */
export function rewriteVersionMarker(content: string, version: string): string {
  if (!VERSION_MARKER_RE.test(content)) return content;
  return content.replace(VERSION_MARKER_RE, versionMarker(version));
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

/** The version marker read off an installed SKILL.md, or null if absent/unreadable. */
export function installedSkillVersion(dir: string = skillTargetDir()): string | null {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    return parseSkillVersion(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** What a {@link syncSkill} did. */
export interface SyncResult {
  /** `installed` = target was absent; `updated` = content changed; `unchanged` = no-op. */
  action: "installed" | "updated" | "unchanged";
  /** The written SKILL.md path. */
  path: string;
  /** The installed version before an `updated` (the marker we replaced), if any. */
  from?: string | null;
  /** The version written into the copy's marker. */
  to: string;
}

/**
 * io — copy the bundled SKILL.md into the managed skill dir with its version
 * marker rewritten to `version`. Content-driven and idempotent: the RENDERED
 * source (marker substituted) is compared byte-for-byte against the installed
 * copy — identical → `unchanged` (no write), absent → `installed`, otherwise
 * `updated`. Only ever writes inside {@link skillTargetDir}; nothing outside it
 * is read or touched.
 */
export function syncSkill({
  source = defaultSkillSource(),
  version = getCurrentVersion(),
}: { source?: string; version?: string } = {}): SyncResult {
  const rendered = rewriteVersionMarker(readFileSync(source, "utf-8"), version);
  const dir = skillTargetDir();
  const target = join(dir, "SKILL.md");

  const existing = existsSync(target) ? readFileSync(target, "utf-8") : null;
  if (existing === rendered) {
    return { action: "unchanged", path: target, to: version };
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(target, rendered, "utf-8");

  if (existing === null) return { action: "installed", path: target, to: version };
  return { action: "updated", path: target, from: parseSkillVersion(existing), to: version };
}
