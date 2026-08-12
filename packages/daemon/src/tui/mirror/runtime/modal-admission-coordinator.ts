export type ModalAdmissionPhase = "idle" | "queued" | "loading" | "ready" | "error" | "disposed";

export interface ModalAdmissionToken<Kind extends string = string> {
  readonly authority: symbol;
  readonly generation: number;
  readonly kind: Kind;
}

export type ModalAdmissionSnapshot<Kind extends string = string> =
  | {
      readonly phase: "idle" | "disposed";
      readonly generation: number;
      readonly reserved: false;
    }
  | {
      readonly phase: "queued" | "loading" | "ready";
      readonly generation: number;
      readonly reserved: true;
      readonly kind: Kind;
    }
  | {
      readonly phase: "error";
      readonly generation: number;
      readonly reserved: true;
      readonly kind: Kind;
      readonly message: string;
    };

/**
 * Exclusive, timer-free modal admission authority.
 *
 * The shell reserves input before a lazy feature is evaluated. Every async
 * continuation carries its token, so an older palette/dialog/settings load
 * cannot reopen or overwrite a newer intent. Error is deliberately still a
 * reservation: retry/close UI owns input and terminal bytes cannot leak.
 */
export class ModalAdmissionCoordinator<Kind extends string> {
  readonly #authority = Symbol("modal-admission");
  readonly #listeners = new Set<(snapshot: ModalAdmissionSnapshot<Kind>) => void>();
  #generation = 0;
  #snapshot: ModalAdmissionSnapshot<Kind> = {
    phase: "idle",
    generation: 0,
    reserved: false,
  };

  snapshot(): ModalAdmissionSnapshot<Kind> {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: ModalAdmissionSnapshot<Kind>) => void): () => void {
    if (this.#snapshot.phase === "disposed") return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reserve(kind: Kind): ModalAdmissionToken<Kind> | null {
    if (this.#snapshot.phase === "disposed") return null;
    const token: ModalAdmissionToken<Kind> = Object.freeze({
      authority: this.#authority,
      generation: ++this.#generation,
      kind,
    });
    this.#publish({
      phase: "queued",
      generation: token.generation,
      reserved: true,
      kind,
    });
    return token;
  }

  markLoading(token: ModalAdmissionToken<Kind>): boolean {
    if (!this.#isCurrent(token) || this.#snapshot.phase !== "queued") return false;
    this.#publish({
      phase: "loading",
      generation: token.generation,
      reserved: true,
      kind: token.kind,
    });
    return true;
  }

  markReady(token: ModalAdmissionToken<Kind>): boolean {
    if (
      !this.#isCurrent(token) ||
      (this.#snapshot.phase !== "queued" && this.#snapshot.phase !== "loading")
    )
      return false;
    this.#publish({
      phase: "ready",
      generation: token.generation,
      reserved: true,
      kind: token.kind,
    });
    return true;
  }

  markError(token: ModalAdmissionToken<Kind>, error: unknown): boolean {
    if (
      !this.#isCurrent(token) ||
      (this.#snapshot.phase !== "queued" && this.#snapshot.phase !== "loading")
    )
      return false;
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    this.#publish({
      phase: "error",
      generation: token.generation,
      reserved: true,
      kind: token.kind,
      message: message || "The modal feature is unavailable.",
    });
    return true;
  }

  retry(): ModalAdmissionToken<Kind> | null {
    return this.#snapshot.phase === "error" ? this.reserve(this.#snapshot.kind) : null;
  }

  isCurrent(token: ModalAdmissionToken<Kind>): boolean {
    return this.#isCurrent(token);
  }

  release(token: ModalAdmissionToken<Kind>): boolean {
    if (!this.#isCurrent(token)) return false;
    this.#generation += 1;
    this.#publish({ phase: "idle", generation: this.#generation, reserved: false });
    return true;
  }

  releaseCurrent(): boolean {
    if (!this.#snapshot.reserved) return false;
    this.#generation += 1;
    this.#publish({ phase: "idle", generation: this.#generation, reserved: false });
    return true;
  }

  dispose(): void {
    if (this.#snapshot.phase === "disposed") return;
    this.#generation += 1;
    this.#publish({ phase: "disposed", generation: this.#generation, reserved: false });
    this.#listeners.clear();
  }

  #isCurrent(token: ModalAdmissionToken<Kind>): boolean {
    return (
      token.authority === this.#authority &&
      this.#snapshot.reserved &&
      token.generation === this.#snapshot.generation &&
      token.kind === this.#snapshot.kind
    );
  }

  #publish(snapshot: ModalAdmissionSnapshot<Kind>): void {
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}
