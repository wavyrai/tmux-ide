/**
 * Agent-status watch — the daemon-side push half of ground-truth agent
 * detection.
 *
 * tmux has no push notification for pane-option changes, so this polls each
 * pane's `@agent_state` on a modest interval and emits two kinds of signal on
 * a transition:
 *
 *  - a session-scoped INVALIDATION (`agent-status.changed`) — clients that
 *    subscribed to that session re-fetch the application-shell resource, so
 *    the agent graph reflects the new status without a manual refresh;
 *  - a typed turn-completed RECEIPT for each pane whose state word left
 *    `working` for `done` or `idle` — the bounded completion event consumers
 *    wait on instead of polling (`tmux-ide wait agent-status`, the dock chip).
 *
 * The core is pure and injectable: {@link diffChangedSessions} decides which
 * sessions changed between two reads, {@link diffTurnCompletions} extracts the
 * completed turns, and {@link AgentStatusWatcher} owns the polling lifecycle
 * over injected read/emit/timer seams. The production wiring (real tmux read,
 * ws-events fan-out, start-on-first-client) lives in `ws-events.ts`.
 *
 * Storm control is structural: one read per tick collapses any number of panes
 * flipping between ticks into a single comparison, so a session emits at most
 * one invalidation frame per tick and a pane at most one receipt per tick, and
 * the poll interval is a hard floor between emissions — a pathological
 * flapping pane cannot emit faster than the cadence.
 */

import type { AgentPaneStateReading } from "./discovery.ts";

/** The default poll cadence — "a few seconds"; also the hard floor between emissions. */
export const AGENT_STATUS_POLL_MS = 2_000;

/**
 * The visible portion of a raw `@agent_state` stamp — the `<state>` word before
 * the `:<epoch>` suffix. Transition detection keys off this so a re-stamp that
 * only bumps the epoch (e.g. a working agent re-affirming "working") does not
 * churn a re-fetch, while a genuine state change (working → done) does.
 */
export function agentStateWord(raw: string): string {
  const separator = raw.indexOf(":");
  return separator < 0 ? raw : raw.slice(0, separator);
}

/** Per-session view of pane → agent-discovery reading, as read from tmux. */
export type AgentStateReading = ReadonlyMap<string, ReadonlyMap<string, AgentPaneStateReading>>;

function sessionStateWordsChanged(
  previous: ReadonlyMap<string, AgentPaneStateReading>,
  next: ReadonlyMap<string, AgentPaneStateReading>,
): boolean {
  if (previous.size !== next.size) return true;
  for (const [paneId, reading] of next) {
    const prior = previous.get(paneId);
    if (
      prior === undefined ||
      agentStateWord(prior.state) !== agentStateWord(reading.state) ||
      prior.paneStamp !== reading.paneStamp ||
      (prior.command ?? "") !== (reading.command ?? "")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Session names whose agent-status changed between two readings — a pane
 * appeared or disappeared, or an existing pane's state word transitioned.
 * Coalescing is inherent: any number of pane flips within one session collapse
 * to a single entry. Sorted for deterministic emission order.
 */
export function diffChangedSessions(
  previous: AgentStateReading,
  next: AgentStateReading,
): string[] {
  const changed = new Set<string>();
  for (const [sessionName, panes] of next) {
    const before = previous.get(sessionName);
    if (!before || sessionStateWordsChanged(before, panes)) changed.add(sessionName);
  }
  for (const sessionName of previous.keys()) {
    if (!next.has(sessionName)) changed.add(sessionName);
  }
  return [...changed].sort();
}

/** The state words a completed turn can settle into. */
export type AgentTurnCompletedToStatus = "done" | "idle";

/**
 * One completed agent turn observed between two readings. `paneStamp` is the
 * pane's durable `@tmux_ide_pane_id` value (never a runtime `%id`); the wire
 * layer mints the wire-safe agent id from it, or carries `null` when the pane
 * is unstamped.
 */
export interface AgentTurnCompletion {
  readonly sessionName: string;
  readonly paneStamp: string | null;
  readonly fromStatus: "working";
  readonly toStatus: AgentTurnCompletedToStatus;
}

/**
 * Completed turns between two readings: panes present in BOTH whose state word
 * left `working` for `done` or `idle`. A pane that vanished mid-turn completed
 * nothing; a pane that appeared already-done transitioned nothing we observed.
 * Sorted (session, then pane key) for deterministic emission order.
 */
export function diffTurnCompletions(
  previous: AgentStateReading,
  next: AgentStateReading,
): AgentTurnCompletion[] {
  const completions: AgentTurnCompletion[] = [];
  for (const sessionName of [...next.keys()].sort()) {
    const before = previous.get(sessionName);
    if (!before) continue;
    const panes = next.get(sessionName)!;
    for (const paneId of [...panes.keys()].sort()) {
      const prior = before.get(paneId);
      if (prior === undefined || agentStateWord(prior.state) !== "working") continue;
      const word = agentStateWord(panes.get(paneId)!.state);
      if (word !== "done" && word !== "idle") continue;
      completions.push({
        sessionName,
        paneStamp: panes.get(paneId)!.paneStamp,
        fromStatus: "working",
        toStatus: word,
      });
    }
  }
  return completions;
}

export interface AgentStatusWatcherDeps {
  /**
   * Read every pane's agent-authority options grouped by session, or `null`
   * when the underlying tmux call failed. A `null` read is treated as "no new
   * information" — the baseline is left intact and nothing is emitted — so a
   * transient hiccup never looks like every pane vanishing.
   */
  readonly read: () => AgentStateReading | null;
  /** Emit one session-scoped invalidation. */
  readonly emit: (sessionName: string) => void;
  /** Emit one turn-completed receipt. Optional: invalidation-only consumers stay valid. */
  readonly emitTurnCompleted?: (completion: AgentTurnCompletion) => void;
  /** Timer seam (defaults to global setInterval/clearInterval, unref'd). */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
  readonly intervalMs?: number;
}

/**
 * Poll-driven agent-status watcher. `start()` establishes a baseline on its
 * first successful read (emitting nothing) and thereafter emits one
 * invalidation frame per changed session per tick plus one receipt per
 * completed turn; `stop()` clears the timer and the baseline so a later
 * restart re-baselines cleanly. Idempotent start/stop.
 */
export class AgentStatusWatcher {
  readonly #read: () => AgentStateReading | null;
  readonly #emit: (sessionName: string) => void;
  readonly #emitTurnCompleted: ((completion: AgentTurnCompletion) => void) | null;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly #clearTimer: (handle: ReturnType<typeof setInterval>) => void;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #previous: AgentStateReading | null = null;

  constructor(deps: AgentStatusWatcherDeps) {
    this.#read = deps.read;
    this.#emit = deps.emit;
    this.#emitTurnCompleted = deps.emitTurnCompleted ?? null;
    this.#setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const handle = setInterval(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.#clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle));
    this.#intervalMs = deps.intervalMs ?? AGENT_STATUS_POLL_MS;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer !== null) return;
    // Prime the baseline synchronously so the first change after start is a
    // real transition, not the whole current fleet reported as "new".
    this.tick();
    this.#timer = this.#setTimer(() => this.tick(), this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#previous = null;
  }

  /** One poll cycle. Exposed for deterministic unit tests. */
  tick(): void {
    const next = this.#read();
    if (next === null) return; // transient read failure — hold the baseline.
    if (this.#previous === null) {
      this.#previous = next;
      return;
    }
    for (const sessionName of diffChangedSessions(this.#previous, next)) {
      this.#emit(sessionName);
    }
    if (this.#emitTurnCompleted) {
      for (const completion of diffTurnCompletions(this.#previous, next)) {
        this.#emitTurnCompleted(completion);
      }
    }
    this.#previous = next;
  }
}
