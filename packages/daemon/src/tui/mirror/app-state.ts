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

/** The four top-level surfaces. `terminal` is the SessionMirror, `files` the
 *  editor + file list, `diff` the git panel, `home` the fleet cockpit. */
export type Tab = "home" | "terminal" | "files" | "diff";

const TABS: readonly Tab[] = ["home", "terminal", "files", "diff"];

/** PURE — is `x` one of the four tab keys? */
export function isTab(x: unknown): x is Tab {
  return typeof x === "string" && (TABS as readonly string[]).includes(x);
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
}

export const DEFAULT_APP_STATE: AppState = {
  lastTab: "home",
  contextSession: null,
  openFile: null,
  diffFile: null,
};

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
  };
}

/** PURE — serialize an {@link AppState} to the exact four-key JSON we persist
 *  (extra runtime keys are dropped; stable key order for tidy diffs). */
export function serializeAppState(state: AppState): string {
  const clean: AppState = {
    lastTab: isTab(state.lastTab) ? state.lastTab : "home",
    contextSession: optString(state.contextSession),
    openFile: optString(state.openFile),
    diffFile: optString(state.diffFile),
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
