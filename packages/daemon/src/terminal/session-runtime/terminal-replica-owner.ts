import type { CanonicalTerminalReplicaUpdate, SessionRuntimeGeneration } from "@tmux-ide/contracts";
import type { MirrorLayoutEvent, MirrorPaneEvent } from "../mirror/events.ts";
import type { MirrorService, MirrorSubscription } from "../mirror/mirror-service.ts";
import {
  TerminalReplicaInterpreter,
  type TerminalReplicaInterpreterStats,
} from "./terminal-replica-interpreter.ts";
import {
  SYSTEM_SESSION_RUNTIME_SCHEDULER,
  type SessionRuntimeScheduler,
} from "./runtime-scheduler.ts";
import type {
  SessionRuntimeObservability,
  SessionRuntimeTraceContext,
} from "./runtime-observability.ts";

export interface TerminalReplicaSubscription {
  readonly generation: SessionRuntimeGeneration;
  readonly semanticPaneId: string;
  close(): Promise<void>;
}

export type TerminalReplicaSourceSubscription = TerminalReplicaSubscription;
export interface TerminalReplicaCommittedRaw {
  readonly baseRevision: number;
  readonly revision: number;
  readonly bytes: Uint8Array;
  readonly contiguous: boolean;
}

export interface TerminalReplicaQualificationSnapshot {
  readonly incarnation: string | null;
  readonly revision: number | null;
  readonly stateHash: string | null;
  readonly stats: TerminalReplicaInterpreterStats;
}

/** One parser/replica owner for one semantic pane inside one SessionRuntime. */
export class SessionRuntimeTerminalReplicaOwner {
  readonly #interpreter: TerminalReplicaInterpreter;
  readonly #listeners = new Set<
    (update: CanonicalTerminalReplicaUpdate, trace: SessionRuntimeTraceContext | null) => void
  >();
  readonly #rawListeners = new Set<(record: TerminalReplicaCommittedRaw) => void>();
  readonly #onClosed: (() => void) | undefined;
  readonly #onFault: ((error: unknown) => void) | undefined;
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #takeOutputTrace: (() => SessionRuntimeTraceContext | null) | undefined;
  readonly #start: Promise<void>;
  #upstream: MirrorSubscription | null = null;
  #disposed = false;
  #cols = 80;
  #rows = 24;
  #reseed: { cols: number; rows: number; chunks: Uint8Array[] } | null = null;
  #bootstrapped = false;

  constructor(
    readonly generation: SessionRuntimeGeneration,
    readonly session: string,
    readonly semanticPaneId: string,
    mirror: MirrorService,
    options: {
      readonly incarnation: string;
      readonly initialRevision: number;
      readonly onRevision?: (revision: number) => void;
      readonly onClosed?: () => void;
      readonly onFault?: (error: unknown) => void;
      readonly scheduler?: SessionRuntimeScheduler;
      readonly observability?: SessionRuntimeObservability;
      readonly takeOutputTrace?: () => SessionRuntimeTraceContext | null;
    },
  ) {
    this.#onClosed = options.onClosed;
    this.#onFault = options.onFault;
    this.#scheduler = options.scheduler ?? SYSTEM_SESSION_RUNTIME_SCHEDULER;
    this.#takeOutputTrace = options.takeOutputTrace;
    this.#interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: session,
      semanticPaneId,
      incarnation: options.incarnation,
      initialRevision: options.initialRevision,
      cols: this.#cols,
      rows: this.#rows,
      scheduler: options.scheduler,
      observability: options.observability,
      onUpdate: (update, trace) => {
        if (update.type === "terminal.seed") this.#bootstrapped = true;
        options.onRevision?.(update.revision);
        for (const listener of this.#listeners) {
          try {
            listener(update, trace);
          } catch {
            // A client projection cannot block sibling subscribers.
          }
        }
      },
      onRawCommit: (record) => {
        // Schedule observers outside the parser stack. Registration happens
        // before the matching canonical callback schedules delivery.
        this.#scheduler.microtask(() => {
          const size = record.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of record.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          for (const listener of this.#rawListeners) {
            try {
              listener({
                baseRevision: record.baseRevision,
                revision: record.revision,
                bytes,
                contiguous: record.contiguous,
              });
            } catch {
              // Compatibility observers are isolated from parser ownership.
            }
          }
        });
      },
    });
    this.#start = mirror
      .subscribe({
        session,
        semanticPaneId,
        onEvent: (event) => this.#observePane(event),
        onLayout: (event) => this.#observeLayout(event),
      })
      .then((subscription) => {
        if (this.#disposed) return subscription.close();
        this.#upstream = subscription;
      });
  }

  qualificationSnapshot(): TerminalReplicaQualificationSnapshot {
    const seed = this.#interpreter.currentSeed();
    return Object.freeze({
      incarnation: seed?.incarnation ?? null,
      revision: seed?.revision ?? null,
      stateHash: seed?.stateHash ?? null,
      stats: this.#interpreter.stats(),
    });
  }

  async subscribe(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
  ): Promise<TerminalReplicaSubscription> {
    if (this.#disposed) throw new Error("Terminal replica owner is disposed");
    try {
      await this.#start;
      await this.#interpreter.whenSeeded();
      this.#listeners.add(listener);
      const seed = this.#interpreter.currentSeed();
      if (!seed) throw new Error("Terminal replica bootstrap did not produce a seed");
      try {
        listener(seed, null);
      } catch {
        // Bootstrap delivery has the same client-isolation rule as live frames.
      }
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    let closed = false;
    return {
      generation: this.generation,
      semanticPaneId: this.semanticPaneId,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#listeners.delete(listener);
      },
    };
  }

  async subscribeSource(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
    onRaw: (record: TerminalReplicaCommittedRaw) => void,
  ): Promise<TerminalReplicaSourceSubscription> {
    const canonical = await this.subscribe(listener);
    this.#rawListeners.add(onRaw);
    let closed = false;
    return {
      ...canonical,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#rawListeners.delete(onRaw);
        await canonical.close();
      },
    };
  }

  async dispose(
    reason: "pane-closed" | "session-restarted" | "runtime-disposed" = "runtime-disposed",
  ): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#interpreter.enqueue({ type: "close", reason });
    await this.#start.catch(() => undefined);
    await this.#upstream?.close();
    this.#upstream = null;
    this.#listeners.clear();
    this.#rawListeners.clear();
  }

  #observePane(event: MirrorPaneEvent): void {
    if (event.type === "reset") {
      this.#cols = event.cols;
      this.#rows = event.rows;
      this.#reseed = { cols: event.cols, rows: event.rows, chunks: [] };
    } else if (event.type === "seed" || event.type === "delta") {
      if (this.#reseed) this.#reseed.chunks.push(event.data.slice());
      else
        this.#supervise(
          this.#interpreter.enqueue({
            type: "write",
            data: event.data,
            trace: this.#takeOutputTrace?.() ?? null,
          }),
        );
    } else if (event.type === "cursor") {
      const reseed = this.#reseed;
      this.#reseed = null;
      this.#supervise(
        reseed
          ? this.#interpreter.enqueue({
              type: "reseed",
              ...reseed,
              cursor: { x: event.x, y: event.y },
              bootstrap: "painted-capture",
            })
          : this.#interpreter.enqueue({ type: "cursor", x: event.x, y: event.y }),
      );
    } else if (event.type === "closed") {
      const closed = this.#interpreter.enqueue({ type: "close", reason: "pane-closed" });
      this.#supervise(closed);
      void closed.then(
        async () => {
          await this.dispose("pane-closed");
          this.#onClosed?.();
        },
        () => undefined,
      );
    }
  }

  #observeLayout(event: MirrorLayoutEvent): void {
    const pane = event.panes.find((candidate) => candidate.semanticPaneId === this.semanticPaneId);
    if (!pane || (pane.width === this.#cols && pane.height === this.#rows)) return;
    this.#cols = pane.width;
    this.#rows = pane.height;
    if (this.#reseed) {
      this.#reseed.cols = pane.width;
      this.#reseed.rows = pane.height;
      return;
    }
    if (!this.#bootstrapped) {
      return;
    }
    this.#supervise(
      this.#interpreter.enqueue({ type: "resize", cols: pane.width, rows: pane.height }),
    );
  }

  #supervise(operation: Promise<void>): void {
    void operation.catch((error) => {
      this.#interpreter.abort(error);
      this.#onFault?.(error);
    });
  }
}
