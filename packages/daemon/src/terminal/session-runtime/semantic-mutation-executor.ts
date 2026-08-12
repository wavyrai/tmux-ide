import {
  InteractionReceiptSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
  type AuthoredInteractionOrigin,
  type InteractionReceipt,
  type SessionRuntimeSemanticIntent,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import { z } from "zod";
import {
  sessionRuntimeInteractionFacts,
  sessionRuntimeIntentNeedsTmuxObservation,
  sessionRuntimeObservedProof,
} from "./interaction-receipt-facts.ts";
import {
  SYSTEM_SESSION_RUNTIME_SCHEDULER,
  type SessionRuntimeScheduler,
  type SessionRuntimeTimer,
} from "./runtime-scheduler.ts";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  type SessionRuntimeObservability,
} from "./runtime-observability.ts";

export type SessionRuntimeIntentResult = WorkspaceMultiplexerMutationResult | void;
export type ExecutableSessionRuntimeIntent = SessionRuntimeSemanticIntent;

export interface SessionRuntimeTmuxObservation {
  readonly operationId: string;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
}

export interface SessionRuntimeSubmissionAuthority {
  /** Trusted submitting surface, established outside caller-authored intent JSON. */
  readonly origin: AuthoredInteractionOrigin;
  readonly authenticatedSourceSemanticPaneId?: string | null;
  readonly authorizeBeforeEffect?: () => void;
}

export type SessionRuntimeReceiptInput = Omit<InteractionReceipt, "type" | "sequence">;

export interface SessionSemanticMutationExecutorOptions {
  readonly resolveSession: (workspaceName: string) => string | null;
  readonly execute: (
    operationId: string,
    intent: ExecutableSessionRuntimeIntent,
  ) => SessionRuntimeIntentResult;
  /** Publishes through the daemon's existing replayable interaction journal. */
  readonly publishReceipt: (receipt: SessionRuntimeReceiptInput) => InteractionReceipt;
  readonly observationTimeoutMs?: number;
  readonly now?: () => Date;
  readonly scheduler?: SessionRuntimeScheduler;
  readonly observability?: SessionRuntimeObservability;
}

export interface SessionSemanticMutationMetrics {
  readonly accepted: number;
  readonly observed: number;
  readonly rejected: number;
  readonly timedOut: number;
  readonly pendingObservations: number;
  readonly activeSessionLanes: number;
  readonly ledgerEntries: number;
}

export class SessionRuntimeIntentError extends Error {
  constructor(
    readonly outcome: "rejected" | "timed-out",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionRuntimeIntentError";
  }
}

interface PendingObservation {
  readonly expected: SessionRuntimeTmuxObservation;
  resolve(): void;
  reject(error: Error): void;
}

interface OperationRecord {
  readonly fingerprint: string;
  readonly promise: Promise<SessionRuntimeIntentResult>;
  status: "active" | "settled";
}

/** Allows hook repair and a loaded tmux server to settle without false failure. */
export const SESSION_RUNTIME_OBSERVATION_TIMEOUT_MS = 10_000;
/** Bounded replay/conflict horizon; active work is never evicted. */
export const SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY = 256;
const MISSING_SESSION_LEDGER = Symbol("missing-session-ledger");
type SessionLedgerKey = string | typeof MISSING_SESSION_LEDGER;

function replayedResult(result: SessionRuntimeIntentResult): SessionRuntimeIntentResult {
  return result === undefined ? undefined : { ...result, outcome: "replayed" };
}

/**
 * The single semantic mutation lane for a daemon generation.
 *
 * FIFO is scoped to the resolved tmux session: work for one session cannot
 * overtake itself, while a stalled observation in another session does not
 * hold it hostage. Receipt publication is synchronous into the existing
 * journal; consumer callbacks are always detached from execution.
 */
export class SessionSemanticMutationExecutor {
  readonly #options: SessionSemanticMutationExecutorOptions;
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #observability: SessionRuntimeObservability;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, Map<string, PendingObservation>>();
  readonly #operations = new Map<SessionLedgerKey, Map<string, OperationRecord>>();
  readonly #listeners = new Set<(receipt: InteractionReceipt) => void>();
  #disposed = false;
  #accepted = 0;
  #observed = 0;
  #rejected = 0;
  #timedOut = 0;

  constructor(options: SessionSemanticMutationExecutorOptions) {
    this.#options = options;
    this.#scheduler = options.scheduler ?? SYSTEM_SESSION_RUNTIME_SCHEDULER;
    this.#observability = options.observability ?? DISABLED_SESSION_RUNTIME_OBSERVABILITY;
  }

  metrics(): SessionSemanticMutationMetrics {
    return Object.freeze({
      accepted: this.#accepted,
      observed: this.#observed,
      rejected: this.#rejected,
      timedOut: this.#timedOut,
      pendingObservations: [...this.#pending.values()].reduce(
        (sum, pending) => sum + pending.size,
        0,
      ),
      activeSessionLanes: this.#tails.size,
      ledgerEntries: [...this.#operations.values()].reduce((sum, ledger) => sum + ledger.size, 0),
    });
  }

  submit(
    rawOperationId: string,
    rawIntent: SessionRuntimeSemanticIntent,
    authority: SessionRuntimeSubmissionAuthority,
  ): Promise<SessionRuntimeIntentResult> {
    if (this.#disposed) {
      return Promise.reject(
        new SessionRuntimeIntentError("rejected", "Session semantic mutation executor is disposed"),
      );
    }
    const operationId = z.uuid().parse(rawOperationId);
    let intent = SessionRuntimeSemanticIntentSchemaZ.parse(rawIntent);
    // Caller JSON never decides attribution. Normalize authored send/read
    // intent before fingerprinting and before the sole synchronous effect.
    if (intent.verb === "workspace.pane.send" || intent.verb === "workspace.pane.read") {
      intent = { ...intent, origin: authority.origin };
    }
    const authenticatedSourceSemanticPaneId = authority.authenticatedSourceSemanticPaneId ?? null;
    const session = this.#options.resolveSession(intent.workspaceName);
    // All unresolved workspace names share one bounded refusal bucket. Never
    // retain an attacker-controlled workspace-name alias as a ledger key.
    const ledger = this.#ledger(session ?? MISSING_SESSION_LEDGER);
    const origin = authority.origin;
    const fingerprint = JSON.stringify([intent, authenticatedSourceSemanticPaneId, origin]);
    const existing = ledger.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new SessionRuntimeIntentError(
            "rejected",
            "Operation id was already used for a different semantic interaction",
          ),
        );
      }
      return existing.status === "active"
        ? existing.promise
        : existing.promise.then(replayedResult);
    }
    if (!this.#makeOperationRoom(ledger)) {
      return Promise.reject(
        new SessionRuntimeIntentError(
          "rejected",
          "All session semantic mutation ledger slots are active",
        ),
      );
    }
    this.#publish(operationId, intent, "accepted", null, undefined, origin);
    if (session === null) {
      const error = new SessionRuntimeIntentError(
        "rejected",
        `Workspace ${intent.workspaceName} has no live tmux session`,
      );
      this.#publish(operationId, intent, "rejected", null, undefined, origin);
      const rejected = Promise.reject<SessionRuntimeIntentResult>(error);
      this.#remember(ledger, operationId, fingerprint, rejected);
      return rejected;
    }

    const previous = this.#tails.get(session) ?? Promise.resolve();
    const result = previous.then(
      () =>
        this.#run(
          session,
          operationId,
          intent,
          authenticatedSourceSemanticPaneId,
          authority.authorizeBeforeEffect,
          origin,
        ),
      () =>
        this.#run(
          session,
          operationId,
          intent,
          authenticatedSourceSemanticPaneId,
          authority.authorizeBeforeEffect,
          origin,
        ),
    );
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(session, tail);
    this.#remember(ledger, operationId, fingerprint, result);
    void tail.finally(() => {
      if (this.#tails.get(session) === tail) this.#tails.delete(session);
    });
    return result;
  }

  observe(observation: SessionRuntimeTmuxObservation): boolean {
    const session = this.#options.resolveSession(observation.workspaceName);
    if (session === null) return false;
    const pending = this.#pending.get(session)?.get(observation.operationId);
    if (!pending) return false;
    const expected = pending.expected;
    if (
      expected.workspaceName !== observation.workspaceName ||
      expected.semanticPaneId !== observation.semanticPaneId ||
      expected.operationKind !== observation.operationKind
    ) {
      return false;
    }
    pending.resolve();
    return true;
  }

  onReceipt(listener: (receipt: InteractionReceipt) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new SessionRuntimeIntentError(
      "rejected",
      "Session semantic mutation executor shut down",
    );
    for (const sessionPending of this.#pending.values()) {
      for (const pending of sessionPending.values()) pending.reject(error);
    }
    await Promise.allSettled(this.#tails.values());
    this.#pending.clear();
    this.#tails.clear();
    this.#listeners.clear();
    this.#operations.clear();
  }

  #ledger(key: SessionLedgerKey): Map<string, OperationRecord> {
    const existing = this.#operations.get(key);
    if (existing) return existing;
    const ledger = new Map<string, OperationRecord>();
    this.#operations.set(key, ledger);
    return ledger;
  }

  #remember(
    ledger: Map<string, OperationRecord>,
    operationId: string,
    fingerprint: string,
    promise: Promise<SessionRuntimeIntentResult>,
  ) {
    const record: OperationRecord = { fingerprint, promise, status: "active" };
    ledger.set(operationId, record);
    void promise.then(
      () => {
        record.status = "settled";
      },
      () => {
        record.status = "settled";
      },
    );
  }

  /**
   * Keep exact replay/conflict protection inside the bounded settled ledger
   * horizon. A new unique operation may retire the oldest settled record, but
   * pending work is never evicted or duplicated. This matches the daemon's
   * bounded replay journal rather than imposing a lifetime mutation ceiling.
   */
  #makeOperationRoom(ledger: Map<string, OperationRecord>): boolean {
    if (ledger.size < SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY) return true;
    for (const [operationId, record] of ledger) {
      if (record.status !== "settled") continue;
      ledger.delete(operationId);
      return true;
    }
    return false;
  }

  async #run(
    session: string,
    operationId: string,
    intent: ExecutableSessionRuntimeIntent,
    authenticatedSourceSemanticPaneId: string | null,
    authorizeBeforeEffect?: () => void,
    origin: AuthoredInteractionOrigin = "sdk",
  ): Promise<SessionRuntimeIntentResult> {
    if (this.#disposed) {
      const error = new SessionRuntimeIntentError(
        "rejected",
        "Session semantic mutation executor shut down before execution",
      );
      this.#publish(operationId, intent, "rejected", null, undefined, origin);
      throw error;
    }

    const needsTmuxObservation = sessionRuntimeIntentNeedsTmuxObservation(intent);
    let observed: Promise<void> | null = null;
    if (needsTmuxObservation) {
      let settleObservation!: () => void;
      let rejectObservation!: (error: Error) => void;
      observed = new Promise<void>((resolve, reject) => {
        settleObservation = resolve;
        rejectObservation = reject;
      });
      let sessionPending = this.#pending.get(session);
      if (!sessionPending) {
        sessionPending = new Map();
        this.#pending.set(session, sessionPending);
      }
      sessionPending.set(operationId, {
        expected: {
          operationId,
          workspaceName: intent.workspaceName,
          semanticPaneId: intent.semanticPaneId,
          operationKind: intent.verb,
        },
        resolve: settleObservation,
        reject: rejectObservation,
      });
    }

    let result: SessionRuntimeIntentResult;
    const tmuxStarted = this.#observability.enabled ? this.#observability.nowMicros() : 0;
    try {
      // Admission can wait behind prior work. Revalidate the opaque principal
      // at the last synchronous boundary before tmux receives any effect.
      authorizeBeforeEffect?.();
      result = this.#options.execute(operationId, intent);
    } catch (cause) {
      if (needsTmuxObservation) this.#deletePending(session, operationId);
      const error = new SessionRuntimeIntentError(
        "rejected",
        "tmux rejected the semantic interaction",
        { cause },
      );
      this.#publish(operationId, intent, "rejected", null, undefined, origin);
      throw error;
    } finally {
      if (this.#observability.enabled)
        this.#observability.recordSpan(
          "tmux",
          "semantic-mutation-effect",
          tmuxStarted,
          this.#observability.nowMicros(),
        );
    }

    try {
      // A successful command is not completion proof. Validate the bounded,
      // verb-matched result before waiting for a hook or publishing observed.
      sessionRuntimeObservedProof(intent, result);
    } catch (cause) {
      if (needsTmuxObservation) this.#deletePending(session, operationId);
      const error = new SessionRuntimeIntentError(
        "rejected",
        "tmux returned invalid semantic mutation proof",
        { cause },
      );
      this.#publish(operationId, intent, "rejected", null, undefined, origin);
      throw error;
    }

    if (needsTmuxObservation) {
      const timeoutMs =
        this.#options.observationTimeoutMs ?? SESSION_RUNTIME_OBSERVATION_TIMEOUT_MS;
      let timeout: SessionRuntimeTimer | undefined;
      try {
        await Promise.race([
          observed!,
          new Promise<never>((_, reject) => {
            timeout = this.#scheduler.timer(
              () =>
                reject(
                  new SessionRuntimeIntentError(
                    "timed-out",
                    "tmux did not expose the interaction through its observation hook in time",
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } catch (cause) {
        const error =
          cause instanceof SessionRuntimeIntentError
            ? cause
            : new SessionRuntimeIntentError("rejected", "Interaction observation was cancelled", {
                cause,
              });
        this.#publish(operationId, intent, error.outcome, null, undefined, origin);
        throw error;
      } finally {
        timeout?.cancel();
        this.#deletePending(session, operationId);
      }
    }

    this.#publish(
      operationId,
      intent,
      "observed",
      authenticatedSourceSemanticPaneId,
      result,
      origin,
    );
    return result;
  }

  #deletePending(session: string, operationId: string): void {
    const pending = this.#pending.get(session);
    pending?.delete(operationId);
    if (pending?.size === 0) this.#pending.delete(session);
  }

  #publish(
    operationId: string,
    intent: ExecutableSessionRuntimeIntent,
    phase: "accepted" | "observed" | "rejected" | "timed-out",
    authenticatedSourceSemanticPaneId: string | null = null,
    result?: SessionRuntimeIntentResult,
    authenticatedOrigin?: AuthoredInteractionOrigin,
  ): void {
    const facts = sessionRuntimeInteractionFacts(intent);
    const origin = authenticatedOrigin ?? ("origin" in intent ? intent.origin : "sdk");
    const receipt = InteractionReceiptSchemaZ.parse(
      this.#options.publishReceipt({
        operationId,
        origin,
        workspaceName: intent.workspaceName,
        sourceSemanticPaneId: phase === "observed" ? authenticatedSourceSemanticPaneId : null,
        target: facts.target,
        operationKind: intent.verb,
        phase,
        summary: facts.summary,
        proof: phase === "observed" ? sessionRuntimeObservedProof(intent, result) : null,
        at: (this.#options.now ?? (() => new Date()))().toISOString(),
        resourceRevision: null,
      }),
    );
    if (phase === "accepted") this.#accepted += 1;
    else if (phase === "observed") this.#observed += 1;
    else if (phase === "rejected") this.#rejected += 1;
    else this.#timedOut += 1;
    for (const listener of this.#listeners) {
      this.#scheduler.microtask(() => {
        try {
          listener(receipt);
        } catch {
          // A renderer callback is never mutation backpressure.
        }
      });
    }
  }
}
