/**
 * Persisted app state for the unified IDE (M18.4) — the one small JSON that
 * makes the app remember where you were: the last surface TAB, the workspace
 * CONTEXT session, and the file that was open in the editor / selected in the
 * diff panel.
 *
 * PURE parse/serialize live here so they unit-test as tables (like
 * {@link ./editor-buffer.ts} / {@link ./diff-model.ts}); the io wrappers
 * ({@link loadAppState}/{@link saveAppState}) are thin. The file lives at
 * `~/.tmux-ide/app-state.json`, overridable via `TMUX_IDE_HOME` (tests /
 * per-run isolation point the whole home elsewhere).
 *
 * {@link parseAppState} is TOLERANT: a missing file, malformed JSON, or a
 * mistyped field each falls back to its default and it never throws — the same
 * discipline as {@link ../../lib/app-config.ts}. Restoring stale state must
 * never crash the launch.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isSpawnWhere, type LastSpawn } from "./agent-lifecycle.ts";

/** The four top-level surfaces. `terminal` is the SessionMirror, `files` the
 *  editor + file list, `diff` the git panel, `home` the fleet cockpit. */
export type Tab = "home" | "terminal" | "files" | "diff";

const TABS: readonly Tab[] = ["home", "terminal", "files", "diff"];

/** PURE — is `x` one of the four tab keys? */
export function isTab(x: unknown): x is Tab {
  return typeof x === "string" && (TABS as readonly string[]).includes(x);
}

/** Sidebar-width bounds (M19.3). The user drags the sidebar/main boundary; the
 *  resulting width is clamped to this range and persisted. `DEFAULT` is the
 *  historical fixed width. */
export const SIDEBAR_W_MIN = 16;
export const SIDEBAR_W_MAX = 48;
export const SIDEBAR_W_DEFAULT = 24;

/** PURE — clamp a candidate sidebar width to `[SIDEBAR_W_MIN, SIDEBAR_W_MAX]`,
 *  falling back to the default for a non-finite value. */
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_W_DEFAULT;
  return Math.max(SIDEBAR_W_MIN, Math.min(SIDEBAR_W_MAX, Math.round(w)));
}

/** How many recently-opened folders home remembers (M22.5). Oldest fall off. */
export const RECENTS_CAP = 8;

/** How many per-context "again" spawn memories persist (M24.1). Oldest fall off. */
export const SPAWN_MEMORY_CAP = 20;

/** How many custom spawn commands the recents list keeps (M24.1, global). */
export const CUSTOM_COMMANDS_CAP = 5;

/** How many palette actions the usage history remembers (M24.4). LRU by
 *  last use — the map is insertion-ordered oldest-first, like lastSpawns. */
export const PALETTE_USAGE_CAP = 50;

/** One palette action's usage record (M24.4): how often it ran and when last.
 *  Keyed by the STABLE action key ({@link ./palette.ts}'s paletteActionKey) so
 *  a relabeled action keeps its history. */
export interface PaletteUsageEntry {
  count: number;
  /** Epoch seconds of the most recent run. */
  lastUsed: number;
}

/** The persisted shape. `null` means "nothing remembered" for that slot. */
export interface AppState {
  /** The tab the app was showing when it last saved. */
  lastTab: Tab;
  /** The workspace-context session name (drives terminal target + files/diff dir). */
  contextSession: string | null;
  /** Absolute path of the file open in the editor. */
  openFile: string | null;
  /** Repo-relative path of the file selected in the diff panel. */
  diffFile: string | null;
  /** The sidebar column width (M19.3), clamped to the bounds above. */
  sidebarW: number;
  /** Recently-opened folder paths (M22.5), most-recent first, deduped and
   *  capped at {@link RECENTS_CAP}. Home renders these under a "recent" header. */
  recentFolders: string[];
  /** The "again" memory (M24.1): spawn-context key (a project/session dir, or
   *  `session:<name>` when no dir is known) → the last spawn there. Insertion-
   *  ordered LRU capped at {@link SPAWN_MEMORY_CAP}. */
  lastSpawns: Record<string, LastSpawn>;
  /** Recent CUSTOM spawn commands (M24.1), most-recent first, deduped, global
   *  (not per-project), capped at {@link CUSTOM_COMMANDS_CAP}. */
  customCommands: string[];
  /** Palette usage history (M24.4): stable action key → {count, lastUsed}.
   *  Insertion-ordered LRU (oldest first) capped at {@link PALETTE_USAGE_CAP};
   *  drives the empty-query "recent" group and the ranking tie-break. */
  paletteUsage: Record<string, PaletteUsageEntry>;
}

export const DEFAULT_APP_STATE: AppState = {
  lastTab: "home",
  contextSession: null,
  openFile: null,
  diffFile: null,
  sidebarW: SIDEBAR_W_DEFAULT,
  recentFolders: [],
  lastSpawns: {},
  customCommands: [],
  paletteUsage: {},
};

/** PURE — the "again" memory key for a spawn context: the concrete dir when
 *  known, else the session name (namespaced so a dirless session can't collide
 *  with a path), else null — nothing stable to remember under. */
export function spawnMemoryKey(dir: string | null, session?: string): string | null {
  if (dir && dir.length > 0) return dir;
  if (session && session.length > 0) return `session:${session}`;
  return null;
}

/**
 * PURE — the spawn-memory map after remembering `spawn` under `key`: the key
 * moves to newest (re-inserted last), and when the map outgrows `cap` the
 * OLDEST entries drop (JS objects preserve string-key insertion order — the
 * same order JSON round-trips, so the LRU survives restarts).
 */
export function rememberSpawn(
  map: Readonly<Record<string, LastSpawn>>,
  key: string,
  spawn: LastSpawn,
  cap: number = SPAWN_MEMORY_CAP,
): Record<string, LastSpawn> {
  const out: Record<string, LastSpawn> = {};
  for (const [k, v] of Object.entries(map)) if (k !== key) out[k] = v;
  out[key] = spawn;
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length - cap; i++) delete out[keys[i]!];
  return out;
}

/**
 * PURE — the palette-usage map after running the action keyed `key` at
 * `nowSec`: count bumps, lastUsed updates, and the key moves to newest
 * (re-inserted last — the rememberSpawn LRU idiom, so JSON round-trips keep the
 * eviction order). Past `cap`, the OLDEST-used entries drop. Blank keys no-op.
 */
export function recordPaletteUse(
  map: Readonly<Record<string, PaletteUsageEntry>>,
  key: string,
  nowSec: number,
  cap: number = PALETTE_USAGE_CAP,
): Record<string, PaletteUsageEntry> {
  if (key.length === 0) return { ...map };
  const out: Record<string, PaletteUsageEntry> = {};
  for (const [k, v] of Object.entries(map)) if (k !== key) out[k] = v;
  out[key] = { count: (map[key]?.count ?? 0) + 1, lastUsed: nowSec };
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length - cap; i++) delete out[keys[i]!];
  return out;
}

/** PURE — a persisted palette-usage value coerced clean: non-object → {},
 *  entries with a mistyped/non-finite count or lastUsed drop, order kept,
 *  capped from the OLD end (like sanitizeSpawns). */
function sanitizePaletteUsage(v: unknown): Record<string, PaletteUsageEntry> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, PaletteUsageEntry> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (key.length === 0) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.count !== "number" || !Number.isFinite(o.count) || o.count < 1) continue;
    if (typeof o.lastUsed !== "number" || !Number.isFinite(o.lastUsed)) continue;
    out[key] = { count: Math.floor(o.count), lastUsed: Math.floor(o.lastUsed) };
  }
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length - PALETTE_USAGE_CAP; i++) delete out[keys[i]!];
  return out;
}

/** PURE — the custom-command recents after running `command`: moved to the
 *  front, deduped, capped. Blank commands leave the list unchanged. */
export function addCustomCommand(
  list: readonly string[],
  command: string,
  cap: number = CUSTOM_COMMANDS_CAP,
): string[] {
  const cmd = command.trim();
  if (cmd.length === 0) return [...list];
  return [cmd, ...list.filter((c) => c !== cmd)].slice(0, cap);
}

/** PURE — one persisted spawn coerced to a clean {@link LastSpawn}, or null
 *  when any field is missing/mistyped (the whole entry drops). */
function sanitizeSpawn(v: unknown): LastSpawn | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string" || o.kind.length === 0) return null;
  if (typeof o.command !== "string" || o.command.length === 0) return null;
  if (!isSpawnWhere(o.placement)) return null;
  return { kind: o.kind, command: o.command, placement: o.placement };
}

/** PURE — a persisted spawn-memory value coerced clean: non-object → {},
 *  malformed entries drop, order kept, capped from the OLD end. */
function sanitizeSpawns(v: unknown): Record<string, LastSpawn> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, LastSpawn> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (key.length === 0) continue;
    const spawn = sanitizeSpawn(raw);
    if (spawn) out[key] = spawn;
  }
  const keys = Object.keys(out);
  for (let i = 0; i < keys.length - SPAWN_MEMORY_CAP; i++) delete out[keys[i]!];
  return out;
}

/** PURE — a persisted string list coerced clean: non-empty, deduped (first
 *  wins), capped at `cap`. Anything not a string[] yields []. */
function sanitizeStringList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.length > 0 && !out.includes(item)) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** PURE — the recents list after opening `dir`: it moves to the front,
 *  any earlier occurrence is removed (dedupe), and the tail past `cap` drops.
 *  Blank paths are ignored (return the list unchanged). */
export function addRecentFolder(
  list: readonly string[],
  dir: string,
  cap: number = RECENTS_CAP,
): string[] {
  if (dir.length === 0) return [...list];
  return [dir, ...list.filter((d) => d !== dir)].slice(0, cap);
}

/** PURE — a persisted recents value coerced to clean strings: non-empty,
 *  deduped (first wins), capped. Anything not a string[] yields []. */
function sanitizeRecents(v: unknown): string[] {
  return sanitizeStringList(v, RECENTS_CAP);
}

/** The tmux-ide home dir: `TMUX_IDE_HOME` when set, else `~/.tmux-ide`. */
export function appStateHome(): string {
  return process.env.TMUX_IDE_HOME ?? join(homedir(), ".tmux-ide");
}

/** Absolute path to `app-state.json` under {@link appStateHome}. */
export function appStatePath(): string {
  return join(appStateHome(), "app-state.json");
}

/** A string field that must be non-empty, else `null`. */
function optString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * PURE — parse a raw JSON string into a fully-populated {@link AppState}. Any
 * missing/mistyped field falls back to its default; invalid JSON yields the
 * defaults. Never throws.
 */
export function parseAppState(raw: string): AppState {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_APP_STATE };
    obj = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_APP_STATE };
  }
  return {
    lastTab: isTab(obj.lastTab) ? obj.lastTab : DEFAULT_APP_STATE.lastTab,
    contextSession: optString(obj.contextSession),
    openFile: optString(obj.openFile),
    diffFile: optString(obj.diffFile),
    sidebarW:
      typeof obj.sidebarW === "number"
        ? clampSidebarWidth(obj.sidebarW)
        : DEFAULT_APP_STATE.sidebarW,
    recentFolders: sanitizeRecents(obj.recentFolders),
    lastSpawns: sanitizeSpawns(obj.lastSpawns),
    customCommands: sanitizeStringList(obj.customCommands, CUSTOM_COMMANDS_CAP),
    paletteUsage: sanitizePaletteUsage(obj.paletteUsage),
  };
}

/** PURE — serialize an {@link AppState} to the exact JSON shape we persist
 *  (extra runtime keys are dropped; stable key order for tidy diffs). */
export function serializeAppState(state: AppState): string {
  const clean: AppState = {
    lastTab: isTab(state.lastTab) ? state.lastTab : "home",
    contextSession: optString(state.contextSession),
    openFile: optString(state.openFile),
    diffFile: optString(state.diffFile),
    sidebarW: clampSidebarWidth(state.sidebarW),
    recentFolders: sanitizeRecents(state.recentFolders),
    lastSpawns: sanitizeSpawns(state.lastSpawns),
    customCommands: sanitizeStringList(state.customCommands, CUSTOM_COMMANDS_CAP),
    paletteUsage: sanitizePaletteUsage(state.paletteUsage),
  };
  return JSON.stringify(clean, null, 2);
}

/** Read the persisted state (one-shot at launch — NOT on the render loop).
 *  Missing/unreadable file → defaults. */
export function loadAppState(): AppState {
  const path = appStatePath();
  if (!existsSync(path)) return { ...DEFAULT_APP_STATE };
  try {
    return parseAppState(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULT_APP_STATE };
  }
}

/** Write the state asynchronously (debounced by the caller), creating the home
 *  dir if needed. Swallows io errors — persistence is best-effort. */
export async function saveAppState(state: AppState): Promise<void> {
  const path = appStatePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, serializeAppState(state));
  } catch {
    // best-effort: a failed save must never disturb the running app
  }
}
