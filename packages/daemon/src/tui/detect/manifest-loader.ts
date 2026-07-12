/**
 * Manifest loading with user overrides.
 *
 * The bundled manifests (`manifests.ts`) cover the agents we ship tuning for.
 * Users can add or replace tuning WITHOUT a code change by dropping JSON files
 * in `~/.tmux-ide/agent-detection/` — one {@link AgentManifest} per file:
 *
 *   ~/.tmux-ide/agent-detection/my-agent.json
 *   {
 *     "id": "my-agent",
 *     "commands": ["my-agent", "my-agent-cli"],
 *     "states": {
 *       "working": { "any": [{ "contains": "esc to interrupt", "caseInsensitive": true }] },
 *       "blocked": { "any": [{ "contains": "(y/n)", "caseInsensitive": true }] }
 *     }
 *   }
 *
 * An override whose `id` matches a bundled manifest REPLACES it (so you can
 * re-tune claude/codex); a new `id` is APPENDED. Invalid files are skipped with
 * a one-time stderr warning — a typo in one override never breaks detection.
 *
 * Related: a per-pane `@agent_hint` tmux option (e.g.
 * `tmux set-option -p @agent_hint claude`) forces a specific manifest for a
 * pane, bypassing process-tree resolution — see `resolveAgentCommand`. That is
 * the escape hatch for sandboxes/wrappers where the process tree is opaque.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentManifest, Rule, StateRules } from "./manifest.ts";
import { BUNDLED_MANIFESTS } from "./manifests.ts";

/** Directory scanned for user override manifests. Honors `TMUX_IDE_HOME` (the
 *  state-home override every other `~/.tmux-ide` consumer respects) so tests
 *  never read a real user's overrides. */
export function overrideDir(): string {
  const home = process.env.TMUX_IDE_HOME ?? join(homedir(), ".tmux-ide");
  return join(home, "agent-detection");
}

/** The fetched manifest-pack file (`tmux-ide update --manifests` installs it;
 *  see `lib/manifest-pack.ts` for the format + publish contract). Lives in a
 *  SUBDIRECTORY so {@link readOverrideManifests}'s top-level `*.json` scan
 *  never sees it — that is what keeps user files ABOVE the pack. */
export function packFile(dir = overrideDir()): string {
  return join(dir, "pack", "manifest-pack.json");
}

/**
 * Light structural validator — enough to reject a malformed override without a
 * full schema. Requires a non-empty `id`, a non-empty `commands: string[]`, and
 * a `states` object whose present state rules are shaped `{ all?: [], any?: [] }`
 * with matcher-like entries. PURE — never throws.
 */
export function validateManifestShape(value: unknown): value is AgentManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;

  if (typeof m.id !== "string" || m.id.trim().length === 0) return false;

  if (!Array.isArray(m.commands) || m.commands.length === 0) return false;
  if (!m.commands.every((c) => typeof c === "string" && c.length > 0)) return false;

  if (typeof m.states !== "object" || m.states === null) return false;
  const states = m.states as Record<string, unknown>;
  for (const key of ["blocked", "working", "done"] as const) {
    if (!(key in states)) continue;
    if (!isRuleShape(states[key])) return false;
  }
  return true;
}

/** A rule is `{ all?: Matcher[]; any?: Matcher[] }` with matcher-shaped entries. */
function isRuleShape(value: unknown): value is Rule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  for (const key of ["all", "any"] as const) {
    if (!(key in r)) continue;
    const arr = r[key];
    if (!Array.isArray(arr) || !arr.every(isMatcherShape)) return false;
  }
  return true;
}

/** A matcher must carry a string `contains` or `regex` (the two probe forms). */
function isMatcherShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.contains === "string" || typeof m.regex === "string";
}

/**
 * Merge bundled manifests with user overrides. PURE.
 *
 * - An override whose `id` matches a bundled manifest REPLACES that entry
 *   in-place (position preserved, so pickManifest/tree priority is stable).
 * - A later override with a not-yet-seen `id` is APPENDED (in encounter order).
 * - Among overrides sharing an `id`, the LAST one wins.
 */
export function mergeManifests(
  bundled: AgentManifest[],
  overrides: AgentManifest[],
): AgentManifest[] {
  const byId = new Map<string, AgentManifest>();
  for (const o of overrides) byId.set(o.id, o);

  const result: AgentManifest[] = [];
  const consumed = new Set<string>();

  for (const b of bundled) {
    const override = byId.get(b.id);
    if (override) {
      result.push(override);
      consumed.add(b.id);
    } else {
      result.push(b);
    }
  }
  // Append new ids in the order first encountered — but use the last-wins entry
  // from `byId`, so a duplicate id still resolves to the final override.
  for (const o of overrides) {
    if (!consumed.has(o.id)) {
      result.push(byId.get(o.id)!);
      consumed.add(o.id);
    }
  }
  return result;
}

/** Paths we have already warned about, so a bad override warns only once. */
const warned = new Set<string>();

/**
 * Read and validate override manifests from `dir`. Thin io wrapper — a missing
 * directory yields `[]`, and each invalid/malformed file is skipped with a
 * one-time stderr warning. Never throws.
 */
export function readOverrideManifests(dir = overrideDir()): AgentManifest[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    // Missing directory (the common case) → no overrides.
    return [];
  }

  const overrides: AgentManifest[] = [];
  for (const file of files.sort()) {
    const path = join(dir, file);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (validateManifestShape(parsed)) {
        overrides.push(normalizeStates(parsed));
      } else {
        warnOnce(path, "not a valid AgentManifest (need id, commands[], states)");
      }
    } catch (err) {
      warnOnce(path, err instanceof Error ? err.message : String(err));
    }
  }
  return overrides;
}

/** Drop unknown state keys — keep only blocked/working/done. */
function normalizeStates(m: AgentManifest): AgentManifest {
  const states: StateRules = {};
  if (m.states.blocked) states.blocked = m.states.blocked;
  if (m.states.working) states.working = m.states.working;
  if (m.states.done) states.done = m.states.done;
  const confidence = m.confidence === "tuned" ? "tuned" : "conservative";
  return { id: m.id, commands: m.commands, states, confidence };
}

function warnOnce(path: string, reason: string): void {
  if (warned.has(path)) return;
  warned.add(path);
  process.stderr.write(`tmux-ide: skipping agent-detection override ${path}: ${reason}\n`);
}

/**
 * Read the installed manifest PACK (fetched by `tmux-ide update --manifests`),
 * or `[]` when none is installed. Thin io — a malformed pack file is skipped
 * with a one-time stderr warning, never a throw (the pack was schema-validated
 * at install time; this guards a hand-edited/corrupted file). Each entry gets
 * the same structural validation + normalization as a user override file.
 */
export function readPackManifests(dir = overrideDir()): AgentManifest[] {
  const path = packFile(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No pack installed (the common case).
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const manifests = (parsed as { manifests?: unknown })?.manifests;
    if (!Array.isArray(manifests)) {
      warnOnce(path, "not a manifest pack (missing manifests[])");
      return [];
    }
    const valid: AgentManifest[] = [];
    for (const entry of manifests) {
      if (validateManifestShape(entry)) valid.push(normalizeStates(entry));
      else warnOnce(path, "pack entry is not a valid AgentManifest — entry skipped");
    }
    return valid;
  } catch (err) {
    warnOnce(path, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Load the full manifest set: bundled + pack + user overrides, merged in that
 * PRECEDENCE order — a fetched pack refines the bundled set, and a user's own
 * `agent-detection/*.json` file always beats both (it is merged LAST). Does io
 * on every call — prefer {@link getManifests} for hot paths.
 */
export function loadManifests(): AgentManifest[] {
  const withPack = mergeManifests(BUNDLED_MANIFESTS, readPackManifests());
  return mergeManifests(withPack, readOverrideManifests());
}

/** Process-lifetime cache for the merged manifest set. */
let cache: AgentManifest[] | undefined;

/**
 * Cached {@link loadManifests}. The override directory is read once per
 * process; call {@link _resetForTests} to force a re-read.
 */
export function getManifests(): AgentManifest[] {
  if (!cache) cache = loadManifests();
  return cache;
}

/** Test hook: clear the cache and the one-time-warning ledger. */
export function _resetForTests(): void {
  cache = undefined;
  warned.clear();
}
