import { randomUUID } from "node:crypto";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";

export interface HistoryAnchorProof {
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
}
export type HistoryAnchorIdentity = Pick<
  HistoryAnchorProof,
  "workspaceName" | "semanticPaneId" | "generation" | "incarnation"
>;
type Failure = { readonly status: "unavailable" | "stale" | "lost" };
const MAX_TOKENS = 32;
const TTL_MS = 5 * 60_000;

/** Owner-private row ordinals. Never changes terminal v1 payloads or hashes. */
export class HistoryAnchorOwner {
  #current: (HistoryAnchorProof & { cols: number; rows: number; alternate: boolean }) | null = null;
  #first = 0;
  #length = 0;
  #proofs = new Map<string, { first: number; length: number; expires: number }>();
  #tokens = new Map<string, { ordinal: number; expires: number }>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  invalidate(): void {
    this.#current = null;
    this.#first = 0;
    this.#length = 0;
    this.#tokens.clear();
    this.#proofs.clear();
  }

  observe(update: CanonicalTerminalReplicaUpdate): void {
    if (update.type === "terminal.tombstone") {
      this.invalidate();
      return;
    }
    if (update.type === "terminal.seed") {
      this.invalidate();
      this.#length = update.snapshot.history.length;
      this.#current = {
        workspaceName: update.workspaceName,
        semanticPaneId: update.semanticPaneId,
        generation: update.generation,
        incarnation: update.incarnation,
        revision: update.revision,
        stateHash: update.stateHash,
        cols: update.cols,
        rows: update.rows,
        alternate: update.snapshot.modes.alternateScreen,
      };
      this.#remember();
      return;
    }
    const old = this.#current;
    if (
      !old ||
      old.workspaceName !== update.workspaceName ||
      old.semanticPaneId !== update.semanticPaneId ||
      old.generation !== update.generation ||
      old.incarnation !== update.incarnation ||
      old.revision !== update.baseRevision
    ) {
      this.invalidate();
      return;
    }
    const delta = update.patch.historyDelta;
    const alternate = update.patch.modes?.alternateScreen ?? old.alternate;
    if (
      delta &&
      (!Number.isSafeInteger(delta.trim) || delta.trim < 0 || delta.trim > this.#length)
    ) {
      this.invalidate();
      return;
    }
    const length =
      update.patch.history?.length ??
      this.#length - (delta?.trim ?? 0) + (delta?.append.length ?? 0);
    const reset =
      update.patch.history !== undefined ||
      update.cols !== old.cols ||
      update.rows !== old.rows ||
      alternate !== old.alternate;
    if (reset) {
      this.#tokens.clear();
      this.#proofs.clear();
      this.#first = 0;
    } else this.#first += delta?.trim ?? 0;
    if (!Number.isSafeInteger(this.#first + length)) {
      this.invalidate();
      return;
    }
    this.#length = length;
    this.#current = {
      workspaceName: update.workspaceName,
      semanticPaneId: update.semanticPaneId,
      generation: update.generation,
      incarnation: update.incarnation,
      revision: update.revision,
      stateHash: update.stateHash,
      cols: update.cols,
      rows: update.rows,
      alternate,
    };
    this.#prune();
    this.#remember();
  }

  capture(
    proof: HistoryAnchorProof,
    historyIndex: number,
  ): Failure | { status: "captured"; token: string } {
    const failure = this.#admitIdentity(proof);
    if (failure) return failure;
    this.#prune();
    const known =
      this.#current && this.#key(proof) === this.#key(this.#current)
        ? { first: this.#first, length: this.#length }
        : this.#proofs.get(this.#key(proof));
    if (!known) return { status: "stale" };
    if (!Number.isSafeInteger(historyIndex) || historyIndex < 0 || historyIndex >= known.length)
      return { status: "lost" };
    const ordinal = known.first + historyIndex;
    if (ordinal < this.#first || ordinal >= this.#first + this.#length) return { status: "lost" };
    while (this.#tokens.size >= MAX_TOKENS) this.#tokens.delete(this.#tokens.keys().next().value!);
    const token = randomUUID();
    this.#tokens.set(token, { ordinal, expires: this.now() + TTL_MS });
    return { status: "captured", token };
  }

  resolve(
    proof: HistoryAnchorIdentity,
    token: string,
  ): Failure | { status: "resolved"; proof: HistoryAnchorProof; historyIndex: number } {
    const failure = this.#admitIdentity(proof);
    if (failure) return failure;
    this.#prune();
    const entry = this.#tokens.get(token);
    if (!entry) return { status: "lost" };
    const { workspaceName, semanticPaneId, generation, incarnation, revision, stateHash } =
      this.#current!;
    return {
      status: "resolved",
      proof: { workspaceName, semanticPaneId, generation, incarnation, revision, stateHash },
      historyIndex: entry.ordinal - this.#first,
    };
  }

  #admitIdentity(proof: HistoryAnchorIdentity): Failure | null {
    const current = this.#current;
    if (!current || current.alternate) return { status: "unavailable" };
    return current.workspaceName === proof.workspaceName &&
      current.semanticPaneId === proof.semanticPaneId &&
      current.generation === proof.generation &&
      current.incarnation === proof.incarnation
      ? null
      : { status: "stale" };
  }
  #key(proof: HistoryAnchorProof): string {
    return JSON.stringify([
      proof.workspaceName,
      proof.semanticPaneId,
      proof.generation,
      proof.incarnation,
      proof.revision,
      proof.stateHash,
    ]);
  }
  #remember(): void {
    if (!this.#current || this.#current.alternate) return;
    while (this.#proofs.size >= 64) this.#proofs.delete(this.#proofs.keys().next().value!);
    this.#proofs.set(this.#key(this.#current), {
      first: this.#first,
      length: this.#length,
      expires: this.now() + TTL_MS,
    });
  }
  #prune(): void {
    const now = this.now();
    for (const [key, value] of this.#proofs) if (value.expires <= now) this.#proofs.delete(key);
    for (const [token, entry] of this.#tokens)
      if (
        entry.expires <= now ||
        entry.ordinal < this.#first ||
        entry.ordinal >= this.#first + this.#length
      )
        this.#tokens.delete(token);
  }
}
