import { execFile } from "node:child_process";

import {
  diffChangedSessions,
  diffTurnCompletions,
  type AgentStateReading,
  type AgentTurnCompletion,
} from "./agent-status-watch.ts";
import { isVisibleFleetSession, type AgentPaneStateReading } from "./discovery.ts";

export type FleetFactsDemand = "sessions" | "adopted" | "agents";

export interface SessionCompositionFacts {
  readonly sessions: readonly string[];
  readonly adopted: readonly string[];
  /** Agent-free topology/stamp proof used by terminal-runtime invalidation. */
  readonly terminalTopology?: readonly string[];
}

export interface DaemonFleetFactsObserverOptions {
  readonly readSessions: () => Promise<SessionCompositionFacts | null>;
  readonly readAgents: () => Promise<AgentStateReading | null>;
  readonly onSessionsChanged: () => void;
  readonly onTerminalTopologyChanged?: () => void;
  readonly onAdoptedChanged: () => void;
  readonly onAgentSessionsChanged: (sessions: readonly string[]) => void;
  readonly onAgentTurnCompleted: (completion: AgentTurnCompletion) => void;
  readonly intervalMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface ReadyWaiter {
  readonly demands: ReadonlySet<FleetFactsDemand>;
  readonly resolve: () => void;
}

/** One demand-unioned, async and non-overlapping tmux fleet observer. */
export class DaemonFleetFactsObserver {
  readonly #options: DaemonFleetFactsObserverOptions;
  readonly #intervalMs: number;
  readonly #setTimer: NonNullable<DaemonFleetFactsObserverOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<DaemonFleetFactsObserverOptions["clearTimer"]>;
  readonly #refs = new Map<FleetFactsDemand, number>();
  readonly #demandEpochs = new Map<FleetFactsDemand, number>();
  readonly #baselined = new Set<FleetFactsDemand>();
  readonly #waiters = new Set<ReadyWaiter>();
  #sessionNames: readonly string[] | null = null;
  #adoptedNames: readonly string[] | null = null;
  #terminalTopology: readonly string[] | null = null;
  #agentFacts: AgentStateReading | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #startQueued = false;
  #generation = 0;
  #demandVersion = 0;

  constructor(options: DaemonFleetFactsObserverOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? 2_000;
    this.#setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  acquire(demands: readonly FleetFactsDemand[]): { ready: Promise<void>; release: () => void } {
    const unique = new Set(demands);
    for (const demand of unique) {
      const previous = this.#refs.get(demand) ?? 0;
      this.#refs.set(demand, previous + 1);
      if (previous === 0) {
        this.#bumpDemandEpoch(demand);
        this.#demandVersion += 1;
      }
    }
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const waiter = { demands: unique, resolve: resolveReady };
    this.#waiters.add(waiter);
    this.#settleWaiters();
    this.#queueStart();
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.#waiters.delete(waiter);
        waiter.resolve();
        for (const demand of unique) {
          const next = Math.max(0, (this.#refs.get(demand) ?? 0) - 1);
          if (next === 0) {
            this.#refs.delete(demand);
            this.#bumpDemandEpoch(demand);
            this.#baselined.delete(demand);
            if (demand === "sessions") this.#sessionNames = null;
            else if (demand === "adopted") this.#adoptedNames = null;
            else this.#agentFacts = null;
          } else this.#refs.set(demand, next);
        }
        if (this.#refs.size === 0) this.stop();
      },
    };
  }

  runOnce(): Promise<void> {
    return this.#runOnce(false);
  }

  #runOnce(onlyUnbaselined: boolean): Promise<void> {
    this.#startQueued = false;
    if (this.#running) return this.#running;
    if (this.#timer) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    if (this.#refs.size === 0) return Promise.resolve();
    const generation = this.#generation;
    const demandVersion = this.#demandVersion;
    const wantsSessions =
      (this.#refs.has("sessions") && (!onlyUnbaselined || !this.#baselined.has("sessions"))) ||
      (this.#refs.has("adopted") && (!onlyUnbaselined || !this.#baselined.has("adopted")));
    const wantsAgents =
      this.#refs.has("agents") && (!onlyUnbaselined || !this.#baselined.has("agents"));
    const demandEpochs = new Map(this.#demandEpochs);
    this.#running = this.#cycle(generation, demandEpochs, wantsSessions, wantsAgents).finally(
      () => {
        this.#running = null;
        if (this.#refs.size === 0) return;
        // A connection can release the final demand and a replacement can
        // acquire the same observer while the retired tmux read is still in
        // flight. `stop()` generation-fences that read; once it settles, the
        // replacement must get its own baseline cycle instead of inheriting a
        // permanently pending readiness Promise.
        if (generation !== this.#generation) {
          this.#queueStart();
          return;
        }
        if (demandVersion !== this.#demandVersion && this.#hasUnbaselinedDemand()) {
          void this.#runOnce(true);
          return;
        }
        this.#timer = this.#setTimer(() => {
          this.#timer = null;
          void this.runOnce();
        }, this.#intervalMs);
      },
    );
    return this.#running;
  }

  #queueStart(): void {
    if (this.#running || this.#startQueued) return;
    this.#startQueued = true;
    queueMicrotask(() => {
      if (!this.#startQueued) return;
      this.#startQueued = false;
      void this.runOnce();
    });
  }

  stop(): void {
    this.#generation += 1;
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#startQueued = false;
    this.#refs.clear();
    this.#baselined.clear();
    this.#sessionNames = null;
    this.#adoptedNames = null;
    this.#terminalTopology = null;
    this.#agentFacts = null;
    for (const waiter of this.#waiters) waiter.resolve();
    this.#waiters.clear();
  }

  demandSnapshot(): Readonly<Record<FleetFactsDemand, number>> {
    return {
      sessions: this.#refs.get("sessions") ?? 0,
      adopted: this.#refs.get("adopted") ?? 0,
      agents: this.#refs.get("agents") ?? 0,
    };
  }

  async #cycle(
    generation: number,
    demandEpochs: ReadonlyMap<FleetFactsDemand, number>,
    wantsSessions: boolean,
    wantsAgents: boolean,
  ): Promise<void> {
    const [sessions, agents] = await Promise.all([
      wantsSessions ? this.#options.readSessions() : Promise.resolve(null),
      wantsAgents ? this.#options.readAgents() : Promise.resolve(null),
    ]);
    if (generation !== this.#generation) return;
    if (wantsSessions && sessions) {
      const acceptSessions = this.#sameDemandEpoch("sessions", demandEpochs);
      const acceptAdopted = this.#sameDemandEpoch("adopted", demandEpochs);
      if (acceptSessions) this.#baselined.add("sessions");
      if (acceptAdopted) this.#baselined.add("adopted");
      this.#acceptSessions(sessions, acceptSessions, acceptAdopted);
    }
    if (wantsAgents && agents && this.#sameDemandEpoch("agents", demandEpochs)) {
      this.#baselined.add("agents");
      this.#acceptAgents(agents);
    }
    this.#settleWaiters();
  }

  #acceptSessions(
    next: SessionCompositionFacts,
    acceptSessions: boolean,
    acceptAdopted: boolean,
  ): void {
    if (acceptSessions) {
      const previous = this.#sessionNames;
      const previousTopology = this.#terminalTopology;
      this.#sessionNames = next.sessions;
      this.#terminalTopology = next.terminalTopology ?? next.sessions;
      if (previous && JSON.stringify(previous) !== JSON.stringify(next.sessions))
        this.#options.onSessionsChanged();
      if (
        previousTopology &&
        JSON.stringify(previousTopology) !== JSON.stringify(this.#terminalTopology)
      ) {
        this.#options.onTerminalTopologyChanged?.();
      }
    }
    if (acceptAdopted) {
      const previous = this.#adoptedNames;
      this.#adoptedNames = next.adopted;
      if (previous && JSON.stringify(previous) !== JSON.stringify(next.adopted))
        this.#options.onAdoptedChanged();
    }
  }

  #acceptAgents(next: AgentStateReading): void {
    const previous = this.#agentFacts;
    this.#agentFacts = next;
    if (!previous) return;
    const changed = diffChangedSessions(previous, next);
    if (changed.length > 0) this.#options.onAgentSessionsChanged(changed);
    for (const completion of diffTurnCompletions(previous, next))
      this.#options.onAgentTurnCompleted(completion);
  }

  #settleWaiters(): void {
    for (const waiter of this.#waiters) {
      if (![...waiter.demands].every((demand) => this.#baselined.has(demand))) continue;
      this.#waiters.delete(waiter);
      waiter.resolve();
    }
  }

  #hasUnbaselinedDemand(): boolean {
    for (const demand of this.#refs.keys()) {
      if (!this.#baselined.has(demand)) return true;
    }
    return false;
  }

  #bumpDemandEpoch(demand: FleetFactsDemand): void {
    this.#demandEpochs.set(demand, (this.#demandEpochs.get(demand) ?? 0) + 1);
  }

  #sameDemandEpoch(
    demand: FleetFactsDemand,
    captured: ReadonlyMap<FleetFactsDemand, number>,
  ): boolean {
    return (
      this.#refs.has(demand) &&
      (captured.get(demand) ?? 0) === (this.#demandEpochs.get(demand) ?? 0)
    );
  }
}

export function parseSessionCompositionFacts(raw: string): SessionCompositionFacts {
  const sessions = new Set<string>();
  const adopted = new Set<string>();
  const terminalTopology: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [name = "", adoptedFlag = ""] = line.split("\t");
    if (!name) continue;
    sessions.add(name);
    if (adoptedFlag === "1" && isVisibleFleetSession(name)) adopted.add(name);
    terminalTopology.push(line);
  }
  return {
    sessions: [...sessions].sort(),
    adopted: [...adopted].sort(),
    terminalTopology: terminalTopology.sort(),
  };
}

export function parseAgentStateFacts(raw: string): AgentStateReading {
  const result = new Map<string, Map<string, AgentPaneStateReading>>();
  for (const line of raw.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 4 || !fields[0] || !/^%[0-9]+$/u.test(fields[1] ?? "")) continue;
    let panes = result.get(fields[0]);
    if (!panes) {
      panes = new Map();
      result.set(fields[0], panes);
    }
    panes.set(fields[1]!, { paneStamp: fields[2] || null, state: fields[3] ?? "" });
  }
  return result;
}

function execTmux(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("tmux", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
}

export const SESSION_COMPOSITION_TMUX_ARGS = [
  "list-panes",
  "-a",
  "-F",
  [
    "#{session_name}",
    "#{@tmux_ide_adopted}",
    "#{session_id}",
    "#{window_id}",
    "#{pane_id}",
    "#{window_panes}",
    "#{session_windows}",
    "#{@tmux_ide_pane_id}",
    "#{@tmux_ide_window_id}",
  ].join("\t"),
] as const;

export async function readSessionCompositionFacts(): Promise<SessionCompositionFacts | null> {
  const raw = await execTmux(SESSION_COMPOSITION_TMUX_ARGS);
  return raw === null ? null : parseSessionCompositionFacts(raw);
}

export async function readAgentStateFacts(): Promise<AgentStateReading | null> {
  const raw = await execTmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{@agent_state}",
  ]);
  return raw === null ? null : parseAgentStateFacts(raw);
}
