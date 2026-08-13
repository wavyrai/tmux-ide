export type TerminalSessionHandoffState =
  | {
      readonly phase: "idle";
      readonly presentedTarget: string | null;
    }
  | {
      readonly phase: "preparing" | "awaiting-frame";
      readonly generation: number;
      readonly target: string;
      readonly presentedTarget: string | null;
      readonly attachablePanes: number | null;
      readonly drawablePanes: number | null;
    }
  | {
      readonly phase: "ready";
      readonly generation: number;
      readonly target: string;
      readonly presentedTarget: string;
    }
  | {
      readonly phase: "faulted";
      readonly generation: number;
      readonly target: string;
      readonly presentedTarget: string | null;
      readonly reason: string;
    };

export interface TerminalSessionHandoffOptions {
  readonly onDrawable?: (
    state: Extract<TerminalSessionHandoffState, { phase: "awaiting-frame" }>,
  ) => void;
  readonly onReady?: (state: Extract<TerminalSessionHandoffState, { phase: "ready" }>) => void;
  readonly onState?: (state: TerminalSessionHandoffState) => void;
}

/**
 * Atomic renderer-local handoff gate.
 *
 * A connection being open is not presentation readiness. A candidate becomes
 * drawable only after authenticated inventory and a non-empty current-window
 * layout agree, and becomes committed only after OpenTUI reports the native
 * frame containing that projection. The previously presented target is kept in
 * every intermediate/fault state so the host can retain its last good frame.
 */
export class TerminalSessionHandoff {
  readonly #options: TerminalSessionHandoffOptions;
  #generation = 0;
  #state: TerminalSessionHandoffState = { phase: "idle", presentedTarget: null };

  constructor(options: TerminalSessionHandoffOptions = {}) {
    this.#options = options;
  }

  snapshot(): TerminalSessionHandoffState {
    return this.#state;
  }

  begin(target: string): number {
    const generation = ++this.#generation;
    this.#publish({
      phase: "preparing",
      generation,
      target,
      presentedTarget: this.#state.presentedTarget,
      attachablePanes: null,
      drawablePanes: null,
    });
    return generation;
  }

  observeInventory(generation: number, attachablePanes: number): boolean {
    const state = this.#candidate(generation);
    if (!state) return false;
    this.#updateCandidate({ ...state, attachablePanes: Math.max(0, attachablePanes) });
    return true;
  }

  observeCurrentLayout(generation: number, drawablePanes: number): boolean {
    const state = this.#candidate(generation);
    if (!state) return false;
    this.#updateCandidate({ ...state, drawablePanes: Math.max(0, drawablePanes) });
    return true;
  }

  observeFrameCommitted(generation: number): boolean {
    if (this.#state.phase !== "awaiting-frame" || this.#state.generation !== generation)
      return false;
    const ready: Extract<TerminalSessionHandoffState, { phase: "ready" }> = {
      phase: "ready",
      generation,
      target: this.#state.target,
      presentedTarget: this.#state.target,
    };
    this.#publish(ready);
    this.#options.onReady?.(ready);
    return true;
  }

  fault(generation: number, reason: string): boolean {
    if (!("generation" in this.#state) || this.#state.generation !== generation) return false;
    this.#publish({
      phase: "faulted",
      generation,
      target: this.#state.target,
      presentedTarget: this.#state.presentedTarget,
      reason,
    });
    return true;
  }

  #candidate(
    generation: number,
  ): Extract<TerminalSessionHandoffState, { phase: "preparing" | "awaiting-frame" }> | null {
    if (
      (this.#state.phase !== "preparing" && this.#state.phase !== "awaiting-frame") ||
      this.#state.generation !== generation
    )
      return null;
    return this.#state;
  }

  #updateCandidate(
    state: Extract<TerminalSessionHandoffState, { phase: "preparing" | "awaiting-frame" }>,
  ): void {
    const drawable = (state.attachablePanes ?? 0) > 0 && (state.drawablePanes ?? 0) > 0;
    const next = { ...state, phase: drawable ? "awaiting-frame" : "preparing" } as Extract<
      TerminalSessionHandoffState,
      { phase: "preparing" | "awaiting-frame" }
    >;
    const becameDrawable =
      this.#state.phase !== "awaiting-frame" && next.phase === "awaiting-frame";
    this.#publish(next);
    if (becameDrawable)
      this.#options.onDrawable?.(
        next as Extract<TerminalSessionHandoffState, { phase: "awaiting-frame" }>,
      );
  }

  #publish(state: TerminalSessionHandoffState): void {
    this.#state = state;
    this.#options.onState?.(state);
  }
}
