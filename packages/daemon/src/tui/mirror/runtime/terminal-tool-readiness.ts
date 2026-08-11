export type TerminalToolReadinessState =
  | { readonly phase: "waiting" }
  | { readonly phase: "ready" }
  | { readonly phase: "degraded"; readonly reason: string };

/**
 * Event-driven admission gate for terminal-adjacent resources.
 *
 * A rejected first viewport fit is diagnostic, not a permanent deadlock: the
 * first observed layout proves geometry, then the subsequent terminal render
 * admits tools while retaining the degraded fit status. A later successful
 * geometry settlement clears the degradation. No retry interval or polling
 * loop exists.
 */
export class TerminalToolReadinessGate {
  #state: TerminalToolReadinessState = { phase: "waiting" };
  #admitted = false;
  #geometryObserved = false;

  constructor(
    private readonly onAdmit: () => void,
    private readonly onState?: (state: TerminalToolReadinessState) => void,
  ) {}

  snapshot(): TerminalToolReadinessState {
    return this.#state;
  }

  observeGeometry(): void {
    this.#geometryObserved = true;
  }

  observeFitSuccess(): void {
    this.#geometryObserved = true;
    if (this.#admitted) this.#publish({ phase: "ready" });
    else if (this.#state.phase === "degraded") this.#publish({ phase: "waiting" });
  }

  observeFitFailure(reason: string): void {
    this.#publish({ phase: "degraded", reason });
  }

  /** A frame observed before geometry does not satisfy the ordering proof. */
  observeTerminalRender(): void {
    if (!this.#geometryObserved) return;
    this.#admit();
    if (this.#state.phase === "waiting") this.#publish({ phase: "ready" });
  }

  #admit(): void {
    if (this.#admitted) return;
    this.#admitted = true;
    this.onAdmit();
  }

  #publish(state: TerminalToolReadinessState): void {
    if (
      state.phase === this.#state.phase &&
      (state.phase !== "degraded" ||
        (this.#state.phase === "degraded" && state.reason === this.#state.reason))
    )
      return;
    this.#state = state;
    this.onState?.(state);
  }
}
