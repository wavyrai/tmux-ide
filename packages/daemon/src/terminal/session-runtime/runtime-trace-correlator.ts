import type { SessionRuntimeScheduler, SessionRuntimeTimer } from "./runtime-scheduler.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";

/**
 * Bounded, one-shot correlation for explicitly traced controller input.
 * One pane owns at most one probe; a newer probe supersedes the older one.
 * This is a controlled next-output probe, not general causality. External tmux
 * output cannot create an entry, but unrelated output arriving first may
 * consume an armed probe; qualification callers must use an isolated pane.
 */
export class RuntimeTraceCorrelator {
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #timeoutMs: number;
  readonly #pending = new Map<
    string,
    { readonly trace: SessionRuntimeTraceContext; readonly expiry: SessionRuntimeTimer }
  >();

  constructor(scheduler: SessionRuntimeScheduler, timeoutMs = 5_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError("Trace correlation timeout must be positive");
    this.#scheduler = scheduler;
    this.#timeoutMs = timeoutMs;
  }

  arm(semanticPaneId: string, trace: SessionRuntimeTraceContext): void {
    this.#pending.get(semanticPaneId)?.expiry.cancel();
    const pending = {
      trace,
      expiry: this.#scheduler.timer(() => {
        if (this.#pending.get(semanticPaneId) === pending) this.#pending.delete(semanticPaneId);
      }, this.#timeoutMs),
    };
    this.#pending.set(semanticPaneId, pending);
  }

  take(semanticPaneId: string): SessionRuntimeTraceContext | null {
    const pending = this.#pending.get(semanticPaneId) ?? null;
    this.#pending.delete(semanticPaneId);
    pending?.expiry.cancel();
    return pending?.trace ?? null;
  }

  clearPane(semanticPaneId: string): void {
    const pending = this.#pending.get(semanticPaneId);
    this.#pending.delete(semanticPaneId);
    pending?.expiry.cancel();
  }

  clear(): void {
    for (const pending of this.#pending.values()) pending.expiry.cancel();
    this.#pending.clear();
  }

  get size(): number {
    return this.#pending.size;
  }
}
