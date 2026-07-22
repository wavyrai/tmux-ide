/**
 * Agent-status watch — the daemon-side push half of ground-truth agent
 * detection.
 *
 * tmux has no push notification for pane-option changes, so this polls each
 * pane's `@agent_state` on a modest interval and emits a session-scoped
 * invalidation whenever a pane's status transitions. Clients that subscribed
 * to that session re-fetch the application-shell resource, so the agent graph
 * reflects the new status without a manual refresh.
 *
 * The core is pure and injectable: {@link diffChangedSessions} decides which
 * sessions changed between two reads, and {@link AgentStatusWatcher} owns the
 * polling lifecycle over injected read/emit/timer seams. The production wiring
 * (real tmux read, ws-events fan-out, start-on-first-client) lives in
 * `ws-events.ts`.
 *
 * Storm control is structural: one read per tick collapses any number of panes
 * flipping between ticks into a single comparison, so a session emits at most
 * one frame per tick, and the poll interval is a hard floor between emissions —
 * a pathological flapping pane cannot emit faster than the cadence.
 */

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

/** Per-session view of pane → raw `@agent_state`, as read from tmux. */
export type AgentStateReading = ReadonlyMap<string, ReadonlyMap<string, string>>;

function sessionStateWordsChanged(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): boolean {
  if (previous.size !== next.size) return true;
  for (const [paneId, raw] of next) {
    const prior = previous.get(paneId);
    if (prior === undefined || agentStateWord(prior) !== agentStateWord(raw)) return true;
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

export interface AgentStatusWatcherDeps {
  /**
   * Read every pane's `@agent_state` grouped by session, or `null` when the
   * underlying tmux call failed. A `null` read is treated as "no new
   * information" — the baseline is left intact and nothing is emitted — so a
   * transient hiccup never looks like every pane vanishing.
   */
  readonly read: () => AgentStateReading | null;
  /** Emit one session-scoped invalidation. */
  readonly emit: (sessionName: string) => void;
  /** Timer seam (defaults to global setInterval/clearInterval, unref'd). */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
  readonly intervalMs?: number;
}

/**
 * Poll-driven agent-status watcher. `start()` establishes a baseline on its
 * first successful read (emitting nothing) and thereafter emits one frame per
 * changed session per tick; `stop()` clears the timer and the baseline so a
 * later restart re-baselines cleanly. Idempotent start/stop.
 */
export class AgentStatusWatcher {
  readonly #read: () => AgentStateReading | null;
  readonly #emit: (sessionName: string) => void;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly #clearTimer: (handle: ReturnType<typeof setInterval>) => void;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #previous: AgentStateReading | null = null;

  constructor(deps: AgentStatusWatcherDeps) {
    this.#read = deps.read;
    this.#emit = deps.emit;
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
    this.#previous = next;
  }
}
