import { execFile } from "node:child_process";

import {
  computeAgentStates,
  computePortPanes,
  parseListeningPids,
  parseProcessTree,
} from "./session-monitor.ts";

export interface DaemonMonitorPane {
  readonly id: string;
  readonly pid: string;
  readonly cmd?: string;
  readonly title?: string;
  readonly role?: string;
  readonly type?: string;
  readonly name?: string;
}

export type DaemonMonitoredSessionState = "yes" | "no" | "unknown";

export interface DaemonSessionMonitorBackend {
  inspectSession(sessionName: string, signal: AbortSignal): Promise<DaemonMonitoredSessionState>;
  listCredentialSessions(): readonly string[];
  reconcileCredentials(sessionName: string, signal: AbortSignal): Promise<void>;
  hasClients(signal: AbortSignal): Promise<boolean | null>;
  listPanes(sessionName: string, signal: AbortSignal): Promise<readonly DaemonMonitorPane[] | null>;
  readPortProcessFacts(signal: AbortSignal): Promise<{
    readonly listeners: Set<string>;
    readonly tree: Map<string, string>;
  } | null>;
  setPaneOption(paneId: string, option: string, value: string, signal: AbortSignal): Promise<void>;
  setPaneTitle(paneId: string, title: string, signal: AbortSignal): Promise<void>;
  refreshClients(signal: AbortSignal): Promise<void>;
  onSessionGone(): void;
}

export interface DaemonSessionMonitorOptions {
  readonly sessionName: string;
  readonly backend: DaemonSessionMonitorBackend;
  readonly intervalMs?: number;
  readonly operationConcurrency?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type PaneMutation = (signal: AbortSignal) => Promise<void>;

/** Async, non-overlapping reconciliation for one daemon-owned tmux session. */
export class DaemonSessionMonitor {
  readonly #options: DaemonSessionMonitorOptions;
  readonly #intervalMs: number;
  readonly #operationConcurrency: number;
  readonly #setTimer: NonNullable<DaemonSessionMonitorOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<DaemonSessionMonitorOptions["clearTimer"]>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  #stopped = false;
  #lastState = "";

  constructor(options: DaemonSessionMonitorOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? 1_000;
    this.#operationConcurrency = Math.max(1, options.operationConcurrency ?? 4);
    this.#setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  start(): void {
    if (this.#stopped || this.#timer || this.#running) return;
    this.#schedule();
  }

  runOnce(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#timer) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    if (this.#running) return this.#running;
    const controller = new AbortController();
    this.#abortController = controller;
    this.#running = this.#cycle(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          // A transient monitor failure holds the last accepted state. The
          // recursive scheduler retries without overlapping this cycle.
          void error;
        }
      })
      .finally(() => {
        this.#abortController = null;
        this.#running = null;
        if (!this.#stopped) this.#schedule();
      });
    return this.#running;
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#running;
      return;
    }
    this.#stopped = true;
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#abortController?.abort();
    await this.#running;
  }

  #schedule(): void {
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.runOnce();
    }, this.#intervalMs);
  }

  async #cycle(signal: AbortSignal): Promise<void> {
    const backend = this.#options.backend;
    const session = await backend.inspectSession(this.#options.sessionName, signal);
    if (signal.aborted) return;
    if (session === "no") {
      backend.onSessionGone();
      return;
    }
    if (session === "unknown") return;

    await mapBounded(
      backend.listCredentialSessions(),
      this.#operationConcurrency,
      (workspaceSession) => backend.reconcileCredentials(workspaceSession, signal),
    );
    if (signal.aborted) return;

    const clients = await backend.hasClients(signal);
    if (clients !== true || signal.aborted) return;
    const panes = await backend.listPanes(this.#options.sessionName, signal);
    if (!panes || panes.length === 0 || signal.aborted) return;

    const portFacts = await backend.readPortProcessFacts(signal);
    if (!portFacts || signal.aborted) return;
    const mutablePanes = [...panes];
    const portPanes = computePortPanes(mutablePanes, portFacts);
    const agentStates = computeAgentStates(mutablePanes);
    const stateKey = panes
      .map((pane) => {
        const portState = portPanes.has(pane.id) ? "1" : "0";
        const agent = agentStates.get(pane.id) ?? "-";
        const titleDrift = pane.name && pane.title !== pane.name ? "d" : "ok";
        return `${pane.id}:${portState}:${agent}:${titleDrift}`;
      })
      .join("|");
    if (stateKey === this.#lastState) return;

    const mutations: PaneMutation[] = [];
    for (const pane of panes) {
      const agent = agentStates.get(pane.id);
      mutations.push(
        (activeSignal) =>
          backend.setPaneOption(
            pane.id,
            "@has_port",
            portPanes.has(pane.id) ? "1" : "0",
            activeSignal,
          ),
        (activeSignal) =>
          backend.setPaneOption(pane.id, "@agent_busy", agent === "busy" ? "1" : "0", activeSignal),
        (activeSignal) =>
          backend.setPaneOption(pane.id, "@agent_idle", agent === "idle" ? "1" : "0", activeSignal),
      );
      if (pane.name && pane.title !== pane.name) {
        mutations.push((activeSignal) => backend.setPaneTitle(pane.id, pane.name!, activeSignal));
      }
    }
    await mapBounded(mutations, this.#operationConcurrency, (mutation) => mutation(signal));
    if (signal.aborted) return;
    await backend.refreshClients(signal);
    if (!signal.aborted) this.#lastState = stateKey;
  }
}

export function parseDaemonMonitorPanes(raw: string): DaemonMonitorPane[] {
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [id, pid, cmd, title, role, type, name] = line.split("\t");
    return {
      id: id!,
      pid: pid!,
      cmd,
      title,
      role: role || undefined,
      type: type || undefined,
      name: name || undefined,
    };
  });
}

export function execTmuxAsync(args: readonly string[], signal?: AbortSignal): Promise<string> {
  return execMonitorCommandAsync("tmux", args, signal);
}

function execMonitorCommandAsync(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", maxBuffer: 1024 * 1024, signal },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      },
    );
  });
}

export async function readPortProcessFactsAsync(signal?: AbortSignal): Promise<{
  readonly listeners: Set<string>;
  readonly tree: Map<string, string>;
}> {
  const [listeners, processes] = await Promise.all([
    execMonitorCommandAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], signal),
    execMonitorCommandAsync("ps", ["-axo", "pid=,ppid="], signal),
  ]);
  return { listeners: parseListeningPids(listeners), tree: parseProcessTree(processes) };
}

export function classifySessionInspectionError(error: unknown): DaemonMonitoredSessionState {
  const candidate = error as NodeJS.ErrnoException;
  const message = candidate.message ?? "";
  if (
    candidate.code === "EBADF" ||
    candidate.code === "EAGAIN" ||
    candidate.code === "EMFILE" ||
    candidate.code === "ENFILE" ||
    message.includes("EBADF") ||
    message.includes("EAGAIN")
  ) {
    return "unknown";
  }
  return "no";
}

async function mapBounded<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index]!);
    }
  });
  await Promise.all(workers);
}
