import { NativeSurfaceDemand } from "./native-surface-demand.ts";
import {
  SessionRuntimeGenerationSchemaZ,
  TerminalSurfaceAuditTokenSchemaZ,
  TerminalSurfaceOfferSchemaZ,
  TerminalSurfaceReceiverSchemaZ,
  TERMINAL_SURFACE_MAX_BYTES,
  TERMINAL_SURFACE_MAX_OUTSTANDING,
  TERMINAL_SURFACE_MAX_CONTROL_BYTES,
  type TerminalSurfaceReceiver,
  type TerminalSurfaceOffer,
  type TerminalSurfacePeer,
  type TerminalSurfaceFallback,
} from "@tmux-ide/contracts";

type Reason = TerminalSurfaceFallback["reason"];
type Control = TerminalSurfaceOffer | TerminalSurfacePeer | TerminalSurfaceFallback;
/** Native provider owns the actual kernel proof, immutable backing and GPU-safe
 * reuse policy. These callbacks must enqueue bounded work, never block Node. */
export interface NativeSurfaceProducerConnection {
  start(): void;
  retire(sequence: number): void;
  fallback(): void;
  close(): void;
}
export interface NativeSurfaceProvider {
  readonly auditToken: readonly number[];
  open(context: {
    readonly receiver: TerminalSurfaceReceiver;
    readonly panes: readonly string[];
    /** Reserve and send control before transferring a native right. False means
     * no transfer is allowed; retry/backpressure belongs to the native owner. */
    offer(value: unknown): boolean;
  }): NativeSurfaceProducerConnection;
}
export interface NativeSurfaceSession {
  retire(sequence: number): boolean;
  fallback(reason: Reason): void;
  close(): void;
  readonly outstanding: number;
}
interface Registration {
  readonly provider: NativeSurfaceProvider;
  readonly auditToken: number[];
  readonly sessions: Set<Session>;
}

/** Internal daemon registration only. Never construct a provider from terminal
 * content, request-supplied paths, a PID lookup or a loopback address. The native
 * owner must be authenticated before registration; kernel proof still follows. */
export class NativeSurfaceProviderRegistry {
  readonly demand = new NativeSurfaceDemand();
  readonly generation: string;
  #registration: Registration | null = null;
  #sessions = new Set<Session>();
  #bytes = 0;
  #frames = 0;
  #revision = 0;
  #closed = false;
  #watchers = new Set<(available: boolean) => void>();
  #notificationQueued = false;
  constructor(generation: string) {
    this.generation = SessionRuntimeGenerationSchemaZ.parse(generation);
  }
  get revision(): number {
    return this.#revision;
  }
  get available(): boolean {
    return this.#registration !== null;
  }
  watchAvailability(listener: (available: boolean) => void): () => void {
    if (this.#closed || this.#watchers.size >= 256)
      throw new Error("Native surface availability subscription unavailable");
    this.#watchers.add(listener);
    this.#notifyAvailability();
    return () => this.#watchers.delete(listener);
  }
  #notifyAvailability(): void {
    if (this.#notificationQueued) return;
    this.#notificationQueued = true;
    // Provider registration must finish before a viewer can open its channel.
    queueMicrotask(() => {
      this.#notificationQueued = false;
      for (const listener of [...this.#watchers]) {
        if (!this.#watchers.has(listener)) continue;
        try {
          listener(this.available);
        } catch {
          this.#watchers.delete(listener);
        }
      }
      if (this.#closed) this.#watchers.clear();
    });
  }
  register(provider: NativeSurfaceProvider): () => void {
    if (this.#closed) throw new Error("Native surface registry closed");
    if (this.#registration) throw new Error("Native surface provider already registered");
    const registration: Registration = {
      provider,
      auditToken: TerminalSurfaceAuditTokenSchemaZ.parse(provider.auditToken),
      sessions: new Set(),
    };
    this.#registration = registration;
    this.#revision++;
    this.#notifyAvailability();
    return () => {
      if (this.#registration !== registration) return;
      this.#registration = null;
      this.#revision++;
      // Existing original sockets may still ACK retained GPU storage. Replacing
      // a provider never redirects those ACKs to the replacement process.
      for (const session of registration.sessions) session.fallback("unsupported");
      this.#notifyAvailability();
    };
  }
  open(
    receiver: TerminalSurfaceReceiver,
    panes: readonly string[],
    send: (frame: Control) => boolean,
    deliveryNonce?: (pane: string, generation: string) => string | null,
  ): NativeSurfaceSession | null {
    receiver = TerminalSurfaceReceiverSchemaZ.parse(receiver);
    const registration = this.#registration;
    if (!registration || receiver.generation !== this.generation || this.#sessions.size >= 32)
      return null;
    const session = new Session(
      receiver,
      panes,
      registration,
      send,
      deliveryNonce,
      (bytes) => {
        if (this.#frames >= 32 || this.#bytes + bytes > 256 * 1024 * 1024) return false;
        this.#frames++;
        this.#bytes += bytes;
        return true;
      },
      (bytes) => {
        this.#frames--;
        this.#bytes -= bytes;
      },
      () => {
        registration.sessions.delete(session);
        this.#sessions.delete(session);
      },
    );
    registration.sessions.add(session);
    this.#sessions.add(session);
    session.start();
    return session;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.demand.close();
    this.#registration = null;
    this.#revision++;
    for (const session of [...this.#sessions]) session.close();
    this.#notifyAvailability();
  }
}

class Session implements NativeSurfaceSession {
  #producer: NativeSurfaceProducerConnection | null = null;
  #outstanding = new Map<number, number>();
  #bytes = 0;
  #lastSequence = 0;
  #stopped = false;
  #closed = false;
  readonly #panes: ReadonlySet<string>;
  constructor(
    readonly receiver: TerminalSurfaceReceiver,
    panes: readonly string[],
    readonly registration: Registration,
    readonly send: (frame: Control) => boolean,
    readonly deliveryNonce: ((pane: string, generation: string) => string | null) | undefined,
    readonly reserve: (bytes: number) => boolean,
    readonly release: (bytes: number) => void,
    readonly disposed: () => void,
  ) {
    this.#panes = new Set(panes);
  }
  get outstanding(): number {
    return this.#outstanding.size;
  }
  start(): void {
    try {
      const producer = this.registration.provider.open({
        receiver: structuredClone(this.receiver),
        panes: [...this.#panes],
        offer: (value) => this.#offer(value),
      });
      if (this.#stopped || this.#closed) {
        try {
          producer.close();
        } catch {
          /* Registration already revoked this connection. */
        }
        this.close();
        return;
      }
      this.#producer = producer;
      if (
        !this.#send({
          type: "terminal-surface-peer",
          version: 1,
          generation: this.receiver.generation,
          connectionNonce: this.receiver.connectionNonce,
          auditToken: [...this.registration.auditToken],
        })
      ) {
        this.close();
        return;
      }
      if (!this.#stopped && !this.#closed) this.#producer?.start();
    } catch {
      this.fallback("storage");
    }
  }
  #offer(value: unknown): boolean {
    if (this.#closed || this.#stopped || !this.#producer) return false;
    const parsed = TerminalSurfaceOfferSchemaZ.safeParse(value);
    if (!parsed.success) return false;
    let offer = parsed.data;
    // A producer's own read-only subscription has a different delivery nonce.
    // Only the daemon owning the target viewer may bind that nonce. Preserve
    // canonical revision/hash/incarnation exactly; the receiver verifies them.
    if (this.deliveryNonce) {
      const nonce = this.deliveryNonce(offer.pane, offer.generation);
      if (!nonce) return false;
      const rebound = TerminalSurfaceOfferSchemaZ.safeParse({ ...offer, deliveryNonce: nonce });
      if (!rebound.success) return false;
      offer = rebound.data;
    }
    if (
      offer.generation !== this.receiver.generation ||
      !this.#panes.has(offer.pane) ||
      offer.sequence <= this.#lastSequence ||
      this.#outstanding.size >= TERMINAL_SURFACE_MAX_OUTSTANDING ||
      this.#bytes + offer.allocationBytes > TERMINAL_SURFACE_MAX_BYTES ||
      Buffer.byteLength(JSON.stringify(offer)) > TERMINAL_SURFACE_MAX_CONTROL_BYTES ||
      !this.reserve(offer.allocationBytes)
    )
      return false;
    this.#lastSequence = offer.sequence;
    this.#outstanding.set(offer.sequence, offer.allocationBytes);
    this.#bytes += offer.allocationBytes;
    if (this.#send(offer)) return !this.#closed && !this.#stopped;
    this.close();
    return false;
  }
  retire(sequence: number): boolean {
    const bytes = this.#outstanding.get(sequence);
    if (this.#closed || bytes === undefined) return false;
    this.#outstanding.delete(sequence);
    this.#bytes -= bytes;
    this.release(bytes);
    try {
      this.#producer?.retire(sequence);
    } catch {
      this.fallback("storage");
    }
    return true;
  }
  fallback(reason: Reason): void {
    if (this.#closed || this.#stopped) return;
    this.#stopped = true;
    try {
      this.#producer?.fallback();
    } catch {
      /* Native owner cannot authorize new transfers. */
    }
    if (
      !this.#send({
        type: "terminal-surface-fallback",
        version: 1,
        generation: this.receiver.generation,
        connectionNonce: this.receiver.connectionNonce,
        reason,
      })
    )
      this.close();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Closing releases accounting/reference ownership, never grants buffer reuse.
    // Native receivers retain their own backing/GPU leases after this connection.
    for (const bytes of this.#outstanding.values()) this.release(bytes);
    this.#outstanding.clear();
    this.#bytes = 0;
    try {
      this.#producer?.close();
    } catch {
      /* All daemon-side admissions remain revoked. */
    } finally {
      this.#producer = null;
      this.disposed();
    }
  }
  #send(frame: Control): boolean {
    try {
      return this.send(frame);
    } catch {
      return false;
    }
  }
}
