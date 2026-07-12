/**
 * Persistence for the notification debounce map (M25.1) — `lastNotified`
 * survives updater restarts, so a respawned updater can't re-ping inside the
 * debounce window (the old in-memory map made every restart an amnesty).
 *
 * Same split and same home discipline as {@link ../../lib/update-check.ts}:
 * {@link serializeLastNotified} + {@link parseLastNotified} are PURE (and prune
 * entries older than the debounce window — a stamp that can no longer suppress
 * anything is dead weight); {@link loadLastNotified} / {@link saveLastNotified}
 * are the thin, never-throwing io wrappers over
 * `<TMUX_IDE_HOME>/notify-state.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "../../lib/state-home.ts";
import { NOTIFY_DEBOUNCE_MS } from "./notify.ts";

/** Absolute path to the persisted debounce map. */
export function notifyStatePath(): string {
  return join(stateHome(), "notify-state.json");
}

/** PURE — the JSON body for a debounce map, dropping entries whose timestamp
 *  is already outside the debounce window (they can't suppress anything). */
export function serializeLastNotified(map: ReadonlyMap<string, number>, nowMs: number): string {
  const lastNotified: Record<string, number> = {};
  for (const [key, ts] of map) {
    if (nowMs - ts < NOTIFY_DEBOUNCE_MS) lastNotified[key] = ts;
  }
  return JSON.stringify({ lastNotified });
}

/** PURE — parse a persisted body back into the map, pruning stale entries.
 *  Malformed input (or a FUTURE timestamp beyond the window — clock skew)
 *  yields an empty/partial map, never a throw. */
export function parseLastNotified(json: string, nowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const parsed = JSON.parse(json) as { lastNotified?: unknown };
    const raw = parsed?.lastNotified;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, ts] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ts !== "number") continue;
      if (nowMs - ts >= NOTIFY_DEBOUNCE_MS) continue; // expired
      if (ts - nowMs > NOTIFY_DEBOUNCE_MS) continue; // absurd future stamp
      out.set(key, ts);
    }
  } catch {
    // unreadable state just means a fresh debounce map
  }
  return out;
}

/** io — load the persisted map (empty when missing/unreadable). Never throws. */
export function loadLastNotified(nowMs: number = Date.now()): Map<string, number> {
  const path = notifyStatePath();
  if (!existsSync(path)) return new Map();
  try {
    return parseLastNotified(readFileSync(path, "utf-8"), nowMs);
  } catch {
    return new Map();
  }
}

/** io — persist the map (creating the home if needed). Best-effort. */
export function saveLastNotified(
  map: ReadonlyMap<string, number>,
  nowMs: number = Date.now(),
): void {
  try {
    mkdirSync(stateHome(), { recursive: true });
    writeFileSync(notifyStatePath(), serializeLastNotified(map, nowMs));
  } catch {
    // an unwritable map just means a restart re-arms the debounce — never fatal
  }
}
