import { randomUUID } from "node:crypto";
import type {
  TerminalSurfaceAvailable,
  TerminalSurfaceFallback,
  TerminalSurfaceOffer,
  TerminalSurfacePeer,
  TerminalSurfaceReceiver,
  TerminalSurfaceRetired,
} from "@tmux-ide/contracts";
import type {
  NativeSurfaceProviderRegistry,
  NativeSurfaceSession,
} from "./native-surface-provider.ts";

type Output =
  | TerminalSurfaceAvailable
  | TerminalSurfaceFallback
  | TerminalSurfaceOffer
  | TerminalSurfacePeer;
type Entry = { receiver: TerminalSurfaceReceiver; session: NativeSurfaceSession };
const MAX_RETAINED = 8;

/** One terminal socket owns every negotiation and its remaining GPU retirements. */
export class NativeSurfaceViewer {
  #stop: (() => void) | null = null;
  #closed = false;
  #revision = -1;
  #nonce: string | null = null;
  #used = false;
  #active: Entry | null = null;
  #retained = new Map<string, Entry>();
  constructor(
    readonly registry: NativeSurfaceProviderRegistry,
    readonly panes: readonly string[],
    readonly send: (frame: Output) => boolean,
    readonly deliveryNonce: (pane: string, generation: string) => string | null,
  ) {}
  start(): void {
    if (this.#closed || this.#stop) return;
    try {
      this.#stop = this.registry.watchAvailability((available) => {
        if (this.#closed || this.#revision === this.registry.revision) return;
        this.#revision = this.registry.revision;
        this.#active?.session.fallback("unsupported");
        this.#active = null;
        this.#prune();
        this.#nonce = available ? randomUUID() : null;
        this.#used = false;
        this.#send({
          type: "terminal-surface-available",
          version: 1,
          generation: this.registry.generation,
          connectionNonce: this.#nonce,
        });
      });
    } catch {
      this.#send({
        type: "terminal-surface-available",
        version: 1,
        generation: this.registry.generation,
        connectionNonce: null,
      });
      this.close();
    }
  }
  receive(frame: TerminalSurfaceReceiver): boolean {
    if (
      this.#closed ||
      frame.generation !== this.registry.generation ||
      frame.connectionNonce !== this.#nonce
    )
      return false;
    const previous = this.#retained.get(frame.connectionNonce);
    if (previous) return JSON.stringify(previous.receiver) === JSON.stringify(frame);
    if (this.#used) return false;
    this.#used = true;
    this.#prune();
    if (this.#retained.size >= MAX_RETAINED) {
      this.#fallback(frame, "budget");
      return true;
    }
    const session = this.registry.open(
      frame,
      this.panes,
      (control) => this.#send(control),
      this.deliveryNonce,
    );
    if (!session) {
      this.#fallback(frame, "unsupported");
      return true;
    }
    if (this.#closed) {
      session.close();
      return true;
    }
    const entry = { receiver: frame, session };
    this.#retained.set(frame.connectionNonce, entry);
    this.#active = entry;
    return true;
  }
  retire(frame: TerminalSurfaceRetired): boolean {
    if (this.#closed || frame.generation !== this.registry.generation) return false;
    const entry = this.#retained.get(frame.connectionNonce);
    if (!entry?.session.retire(frame.sequence)) return false;
    this.#prune();
    return true;
  }
  fallback(frame: TerminalSurfaceFallback): boolean {
    if (this.#closed || frame.generation !== this.registry.generation) return false;
    const entry = this.#retained.get(frame.connectionNonce);
    if (!entry) return this.#used && frame.connectionNonce === this.#nonce;
    entry.session.fallback(frame.reason);
    if (this.#active === entry) this.#active = null;
    this.#prune();
    return true;
  }
  #fallback(receiver: TerminalSurfaceReceiver, reason: TerminalSurfaceFallback["reason"]): void {
    this.#send({
      type: "terminal-surface-fallback",
      version: 1,
      generation: receiver.generation,
      connectionNonce: receiver.connectionNonce,
      reason,
    });
  }
  #prune(): void {
    for (const [nonce, entry] of this.#retained) {
      if (entry !== this.#active && entry.session.outstanding === 0) {
        entry.session.close();
        this.#retained.delete(nonce);
      }
    }
  }
  #send(frame: Output): boolean {
    if (this.#closed) return false;
    try {
      if (this.send(frame)) return !this.#closed;
    } catch {
      /* Revoke a failed sink. */
    }
    this.close();
    return false;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop?.();
    this.#stop = null;
    for (const entry of this.#retained.values()) entry.session.close();
    this.#retained.clear();
    this.#active = null;
    this.#nonce = null;
  }
}
