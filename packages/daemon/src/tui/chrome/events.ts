/**
 * Agent-state TRANSITION event log — the fleet's history layer.
 *
 * The chrome {@link ./updater.ts updater} sees every session's status EACH
 * tick, but a status bar is a snapshot: it can't tell you that
 * `prototyper-platform` went `working → done` at 12:31. This module turns the
 * per-tick fleet into a stream of transition events and appends them to a
 * JSONL log that `tmux-ide events` tails.
 *
 * Split as usual: {@link diffFleet} + {@link formatEventLine} +
 * {@link shouldRotate} are PURE (unit-tested without a filesystem), while
 * {@link appendEvents} is the thin io wrapper that stamps `ts`, rotates the
 * file, and appends.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateHome } from "../../lib/state-home.ts";
import type { AgentStatus } from "../detect/classify.ts";

/** A single session-level status transition. `from` is null the first time a session is seen. */
export interface AgentEvent {
  ts: string;
  session: string;
  from: AgentStatus | null;
  to: AgentStatus;
}

/** A transition before it's been stamped with a timestamp (what {@link diffFleet} emits). */
export type AgentEventInit = Omit<AgentEvent, "ts">;

/** Rotate the log once it grows past this many bytes (crude one-generation rotation). */
export const EVENTS_MAX_BYTES = 1024 * 1024;

/**
 * PURE — diff the previous fleet state against the current one.
 *
 * For each session in `next` we emit a transition when its status changed, and
 * a first-sight event (`from: null`) the first time we see it. A session that
 * DISAPPEARS from `next` emits NOTHING — we don't synthesize an `idle`/gone
 * event, we just drop it from the returned `state` (keeps the log honest: an
 * absent session simply stops producing events until it returns).
 *
 * Returns both the new events and the fresh state map to thread into the next
 * tick. The caller stamps `ts` on the events (see {@link appendEvents}).
 */
export function diffFleet(
  prev: Map<string, AgentStatus>,
  next: Array<{ name: string; status: AgentStatus }>,
): { events: AgentEventInit[]; state: Map<string, AgentStatus> } {
  const state = new Map<string, AgentStatus>();
  const events: AgentEventInit[] = [];
  for (const { name, status } of next) {
    const before = prev.has(name) ? prev.get(name)! : null;
    state.set(name, status);
    if (before === null) {
      events.push({ session: name, from: null, to: status });
    } else if (before !== status) {
      events.push({ session: name, from: before, to: status });
    }
  }
  return { events, state };
}

/** PURE — whether a log of `sizeBytes` is due for rotation. */
export function shouldRotate(sizeBytes: number): boolean {
  return sizeBytes > EVENTS_MAX_BYTES;
}

/** Extract `HH:MM:SS` from an ISO-8601 timestamp (UTC); falls back to the raw string. */
function isoTime(ts: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : ts;
}

/**
 * PURE — render one event for the human-readable `tmux-ide events` view, e.g.
 * `12:31:07 prototyper-platform working → done`. First-sight events (from=null)
 * render the origin as `·`. `paint` colors a status token (defaults to
 * identity so tests get plain text); the CLI passes an ANSI painter.
 */
export function formatEventLine(
  ev: AgentEvent,
  paint: (status: AgentStatus | null, text: string) => string = (_s, t) => t,
): string {
  const from = ev.from === null ? "·" : paint(ev.from, ev.from);
  return `${isoTime(ev.ts)} ${ev.session} ${from} → ${paint(ev.to, ev.to)}`;
}

/** Absolute path to the fleet event log (under the `TMUX_IDE_HOME`-aware home). */
export function eventsPath(): string {
  return join(stateHome(), "events.jsonl");
}

/**
 * io — stamp each event with `now()` and append it to the log as JSONL.
 *
 * Before appending, rotates the log to `events.jsonl.1` (overwriting any prior
 * generation) when it's grown past {@link EVENTS_MAX_BYTES}. Best-effort: a
 * filesystem failure must never break the updater loop, so every step is
 * guarded. No-op when there are no events.
 */
export function appendEvents(
  events: AgentEventInit[],
  now: () => string = () => new Date().toISOString(),
): void {
  if (events.length === 0) return;
  const path = eventsPath();
  try {
    mkdirSync(stateHome(), { recursive: true });
    if (existsSync(path) && shouldRotate(statSync(path).size)) {
      renameSync(path, `${path}.1`);
    }
    const ts = now();
    const lines = events.map((e) => `${JSON.stringify({ ts, ...e })}\n`).join("");
    appendFileSync(path, lines);
  } catch {
    // Stale/failed log write just means a gap in history — never fatal.
  }
}
