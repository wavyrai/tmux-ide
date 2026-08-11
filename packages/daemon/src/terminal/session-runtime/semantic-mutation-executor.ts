import {
  InteractionReceiptSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
  type InteractionReceipt,
  type SessionRuntimeSemanticIntent,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import { z } from "zod";

export type SessionRuntimeIntentResult = WorkspaceMultiplexerMutationResult | void;
export type ExecutableSessionRuntimeIntent = Extract<
  SessionRuntimeSemanticIntent,
  { verb: "workspace.pane.send" | "workspace.pane.read" }
>;

export interface SessionRuntimeTmuxObservation {
  readonly operationId: string;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
}

export type SessionRuntimeReceiptInput = Omit<InteractionReceipt, "type" | "sequence">;

export interface SessionSemanticMutationExecutorOptions {
  readonly resolveSession: (workspaceName: string) => string | null;
  readonly execute: (
    operationId: string,
    intent: ExecutableSessionRuntimeIntent,
  ) => Promise<SessionRuntimeIntentResult>;
  /** Publishes through the daemon's existing replayable interaction journal. */
  readonly publishReceipt: (receipt: SessionRuntimeReceiptInput) => InteractionReceipt;
  readonly observationTimeoutMs?: number;
  readonly now?: () => Date;
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

function isExecutableIntent(
  intent: SessionRuntimeSemanticIntent,
): intent is ExecutableSessionRuntimeIntent {
  return intent.verb === "workspace.pane.send" || intent.verb === "workspace.pane.read";
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
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, PendingObservation>();
  readonly #operations = new Map<string, OperationRecord>();
  readonly #listeners = new Set<(receipt: InteractionReceipt) => void>();
  #disposed = false;

  constructor(options: SessionSemanticMutationExecutorOptions) {
    this.#options = options;
  }

  submit(
    rawOperationId: string,
    rawIntent: SessionRuntimeSemanticIntent,
    authenticatedSourceSemanticPaneId: string | null = null,
    authorizeBeforeEffect?: () => void,
  ): Promise<SessionRuntimeIntentResult> {
    if (this.#disposed) {
      return Promise.reject(
        new SessionRuntimeIntentError("rejected", "Session semantic mutation executor is disposed"),
      );
    }
    const operationId = z.uuid().parse(rawOperationId);
    const intent = SessionRuntimeSemanticIntentSchemaZ.parse(rawIntent);
    const fingerprint = JSON.stringify([intent, authenticatedSourceSemanticPaneId]);
    const existing = this.#operations.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new SessionRuntimeIntentError(
            "rejected",
            "Operation id was already used for a different semantic interaction",
          ),
        );
      }
      return existing.promise;
    }
    if (!isExecutableIntent(intent)) {
      return Promise.reject(
        new SessionRuntimeIntentError(
          "rejected",
          `Semantic verb ${intent.verb} is not routed through the session executor yet`,
        ),
      );
    }
    if (!this.#makeOperationRoom()) {
      return Promise.reject(
        new SessionRuntimeIntentError(
          "rejected",
          "All session semantic mutation ledger slots are active",
        ),
      );
    }

    const session = this.#options.resolveSession(intent.workspaceName);
    this.#publish(operationId, intent, "accepted");
    if (session === null) {
      const error = new SessionRuntimeIntentError(
        "rejected",
        `Workspace ${intent.workspaceName} has no live tmux session`,
      );
      this.#publish(operationId, intent, "rejected");
      const rejected = Promise.reject<SessionRuntimeIntentResult>(error);
      this.#remember(operationId, fingerprint, rejected);
      return rejected;
    }

    const previous = this.#tails.get(session) ?? Promise.resolve();
    const result = previous.then(
      () =>
        this.#run(operationId, intent, authenticatedSourceSemanticPaneId, authorizeBeforeEffect),
      () =>
        this.#run(operationId, intent, authenticatedSourceSemanticPaneId, authorizeBeforeEffect),
    );
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(session, tail);
    this.#remember(operationId, fingerprint, result);
    void tail.finally(() => {
      if (this.#tails.get(session) === tail) this.#tails.delete(session);
    });
    return result;
  }

  observe(observation: SessionRuntimeTmuxObservation): boolean {
    const pending = this.#pending.get(observation.operationId);
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
    for (const pending of this.#pending.values()) pending.reject(error);
    await Promise.allSettled(this.#tails.values());
    this.#pending.clear();
    this.#tails.clear();
    this.#listeners.clear();
    this.#operations.clear();
  }

  #remember(
    operationId: string,
    fingerprint: string,
    promise: Promise<SessionRuntimeIntentResult>,
  ) {
    const record: OperationRecord = { fingerprint, promise, status: "active" };
    this.#operations.set(operationId, record);
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
  #makeOperationRoom(): boolean {
    if (this.#operations.size < SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY) return true;
    for (const [operationId, record] of this.#operations) {
      if (record.status !== "settled") continue;
      this.#operations.delete(operationId);
      return true;
    }
    return false;
  }

  async #run(
    operationId: string,
    intent: ExecutableSessionRuntimeIntent,
    authenticatedSourceSemanticPaneId: string | null,
    authorizeBeforeEffect?: () => void,
  ): Promise<SessionRuntimeIntentResult> {
    if (this.#disposed) {
      const error = new SessionRuntimeIntentError(
        "rejected",
        "Session semantic mutation executor shut down before execution",
      );
      this.#publish(operationId, intent, "rejected");
      throw error;
    }

    let settleObservation!: () => void;
    let rejectObservation!: (error: Error) => void;
    const observed = new Promise<void>((resolve, reject) => {
      settleObservation = resolve;
      rejectObservation = reject;
    });
    this.#pending.set(operationId, {
      expected: {
        operationId,
        workspaceName: intent.workspaceName,
        semanticPaneId: intent.semanticPaneId,
        operationKind: intent.verb,
      },
      resolve: settleObservation,
      reject: rejectObservation,
    });

    let result: SessionRuntimeIntentResult;
    try {
      // Admission can wait behind prior work. Revalidate the opaque principal
      // at the last synchronous boundary before tmux receives any effect.
      authorizeBeforeEffect?.();
      result = await this.#options.execute(operationId, intent);
    } catch (cause) {
      this.#pending.delete(operationId);
      const error = new SessionRuntimeIntentError(
        "rejected",
        "tmux rejected the semantic interaction",
        { cause },
      );
      this.#publish(operationId, intent, "rejected");
      throw error;
    }

    const timeoutMs = this.#options.observationTimeoutMs ?? SESSION_RUNTIME_OBSERVATION_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        observed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new SessionRuntimeIntentError(
                  "timed-out",
                  "tmux did not expose the interaction through its observation hook in time",
                ),
              ),
            timeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } catch (cause) {
      const error =
        cause instanceof SessionRuntimeIntentError
          ? cause
          : new SessionRuntimeIntentError("rejected", "Interaction observation was cancelled", {
              cause,
            });
      this.#publish(operationId, intent, error.outcome);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      this.#pending.delete(operationId);
    }

    this.#publish(operationId, intent, "observed", authenticatedSourceSemanticPaneId);
    return result;
  }

  #publish(
    operationId: string,
    intent: ExecutableSessionRuntimeIntent,
    phase: "accepted" | "observed" | "rejected" | "timed-out",
    authenticatedSourceSemanticPaneId: string | null = null,
  ): void {
    const summary =
      intent.verb === "workspace.pane.read"
        ? ({ observedOnly: true } as const)
        : {
            characterCount: Array.from(intent.text).length,
            byteCount: Buffer.byteLength(intent.text, "utf8"),
            submitted: intent.submit,
          };
    const receipt = InteractionReceiptSchemaZ.parse(
      this.#options.publishReceipt({
        operationId,
        origin: intent.origin,
        workspaceName: intent.workspaceName,
        sourceSemanticPaneId: phase === "observed" ? authenticatedSourceSemanticPaneId : null,
        semanticPaneId: intent.semanticPaneId,
        operationKind: intent.verb,
        phase,
        summary,
        at: (this.#options.now ?? (() => new Date()))().toISOString(),
        resourceRevision: null,
      }),
    );
    for (const listener of this.#listeners) {
      queueMicrotask(() => {
        try {
          listener(receipt);
        } catch {
          // A renderer callback is never mutation backpressure.
        }
      });
    }
  }
}
