import {
  SessionRuntimeAuthorityLeaseSchemaZ,
  SessionRuntimeAuthoritySnapshotSchemaZ,
  SessionRuntimeClientIdSchemaZ,
  SessionRuntimeGenerationSchemaZ,
  type SessionRuntimeActivityKind,
  type SessionRuntimeAuthorityKind,
  type SessionRuntimeAuthorityLease,
  type SessionRuntimeAuthoritySnapshot,
  type SessionRuntimeClientSurface,
  type SessionRuntimePresenceState,
} from "@tmux-ide/contracts";
import type { SessionRuntimeScheduler, SessionRuntimeTimer } from "./runtime-scheduler.ts";

interface ClientState {
  readonly clientId: string;
  readonly surface: SessionRuntimeClientSurface;
  readonly connectedRevision: number;
  state: SessionRuntimePresenceState;
  activityRevision: number;
  readonly claims: Set<SessionRuntimeAuthorityKind>;
}

interface OwnerState {
  clientId: string;
  token: string;
  revision: number;
}

const AUTHORITY_KINDS = ["input", "focus", "geometry"] as const;

function clientSurface(surface: string): SessionRuntimeClientSurface {
  if (surface.startsWith("web")) return "web";
  if (surface.startsWith("opentui")) return "opentui";
  if (surface.startsWith("cli")) return "cli";
  if (surface.startsWith("sdk")) return "sdk";
  if (surface.startsWith("native-tmux")) return "native-tmux";
  return "unknown";
}

/**
 * Pure daemon-side authority election for one session generation.
 *
 * Input, shared focus and geometry are separate claims. Foreground clients win
 * deterministically by daemon-observed activity, then connection order and
 * stable id. Geometry is deliberately sticky while its owner remains eligible;
 * this prevents pointer/heartbeat traffic from making a tmux window oscillate.
 * Native tmux activity yields geometry immediately for a bounded quiet period.
 */
export class SessionRuntimeAuthorityArbiter {
  readonly generation: string;
  readonly session: string;
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #nativeGeometryHysteresisMs: number;
  readonly #onGeometryAuthorityChanged: (clientId: string | null) => void;
  readonly #onNativeGeometryYieldExpired: () => void;
  readonly #clients = new Map<string, ClientState>();
  readonly #owners = new Map<SessionRuntimeAuthorityKind, OwnerState>();
  #revision = 0;
  #nativeGeometryYieldUntilMs = 0;
  #nativeYieldTimer: SessionRuntimeTimer | null = null;
  #nativeYieldEpoch = 0;
  #disposed = false;

  constructor(options: {
    readonly generation: string;
    readonly session: string;
    readonly scheduler: SessionRuntimeScheduler;
    readonly nativeGeometryHysteresisMs?: number;
    readonly onGeometryAuthorityChanged?: (clientId: string | null) => void;
    readonly onNativeGeometryYieldExpired?: () => void;
  }) {
    this.generation = SessionRuntimeGenerationSchemaZ.parse(options.generation);
    this.session = options.session;
    this.#scheduler = options.scheduler;
    this.#nativeGeometryHysteresisMs = options.nativeGeometryHysteresisMs ?? 180;
    this.#onGeometryAuthorityChanged = options.onGeometryAuthorityChanged ?? (() => {});
    this.#onNativeGeometryYieldExpired = options.onNativeGeometryYieldExpired ?? (() => {});
  }

  connect(clientIdInput: string, surface: string): void {
    this.#assertOpen();
    const clientId = SessionRuntimeClientIdSchemaZ.parse(clientIdInput);
    if (this.#clients.has(clientId))
      throw new TypeError(`Authority client ${clientId} is connected`);
    const revision = this.#advance();
    this.#clients.set(clientId, {
      clientId,
      surface: clientSurface(surface),
      connectedRevision: revision,
      state: "background",
      activityRevision: 0,
      claims: new Set(),
    });
  }

  updatePresence(clientId: string, state: SessionRuntimePresenceState): void {
    const client = this.#client(clientId);
    if (client.state === state) return;
    client.state = state;
    client.activityRevision = this.#advance();
    // Input is an execution capability, not ambient UI focus. It changes only
    // through an explicit claim/release/handoff so the legacy execution lease
    // can be synchronized atomically by SessionRuntimeTransportBinder.
    for (const authority of AUTHORITY_KINDS) {
      if (authority !== "input") this.#elect(authority);
    }
  }

  noteActivity(clientId: string, activity: SessionRuntimeActivityKind): void {
    const client = this.#client(clientId);
    client.activityRevision = this.#advance();
    const authority = activity === "heartbeat" || activity === "input" ? null : activity;
    if (authority && client.claims.has(authority)) this.#elect(authority, clientId);
  }

  claim(
    clientId: string,
    authority: SessionRuntimeAuthorityKind,
  ): SessionRuntimeAuthorityLease | null {
    const client = this.#client(clientId);
    client.claims.add(authority);
    client.activityRevision = this.#advance();
    this.#elect(authority, clientId);
    return this.leaseFor(clientId, authority);
  }

  release(clientId: string, authority: SessionRuntimeAuthorityKind): void {
    const client = this.#client(clientId);
    if (!client.claims.delete(authority)) return;
    this.#advance();
    if (authority === "input") {
      if (this.#owners.get("input")?.clientId === clientId) this.#setOwner("input", null);
    } else {
      this.#elect(authority);
    }
  }

  disconnect(clientId: string): void {
    const ownedInput = this.#owners.get("input")?.clientId === clientId;
    if (!this.#clients.delete(clientId)) return;
    this.#advance();
    if (ownedInput) this.#setOwner("input", null);
    for (const authority of AUTHORITY_KINDS) {
      if (authority !== "input") this.#elect(authority);
    }
  }

  /** Native terminal activity always wins by making tmux-ide size-passive. */
  noteNativeGeometryActivity(): void {
    this.#assertOpen();
    const now = this.#scheduler.nowMs();
    this.#nativeGeometryYieldUntilMs = Math.max(
      this.#nativeGeometryYieldUntilMs,
      now + this.#nativeGeometryHysteresisMs,
    );
    this.#nativeYieldEpoch += 1;
    const epoch = this.#nativeYieldEpoch;
    this.#nativeYieldTimer?.cancel();
    this.#setOwner("geometry", null);
    this.#nativeYieldTimer = this.#scheduler.timer(() => {
      if (this.#disposed || epoch !== this.#nativeYieldEpoch) return;
      this.#nativeYieldTimer = null;
      if (this.#scheduler.nowMs() < this.#nativeGeometryYieldUntilMs) return;
      this.#elect("geometry");
      this.#onNativeGeometryYieldExpired();
    }, this.#nativeGeometryHysteresisMs);
  }

  leaseFor(
    clientId: string,
    authority: SessionRuntimeAuthorityKind,
  ): SessionRuntimeAuthorityLease | null {
    const owner = this.#owners.get(authority);
    if (!owner || owner.clientId !== clientId) return null;
    return SessionRuntimeAuthorityLeaseSchemaZ.parse({
      generation: this.generation,
      session: this.session,
      clientId,
      authority,
      token: owner.token,
      revision: owner.revision,
    });
  }

  assertLease(leaseInput: SessionRuntimeAuthorityLease): SessionRuntimeAuthorityLease {
    const lease = SessionRuntimeAuthorityLeaseSchemaZ.parse(leaseInput);
    const owner = this.#owners.get(lease.authority);
    if (
      lease.generation !== this.generation ||
      lease.session !== this.session ||
      !owner ||
      owner.clientId !== lease.clientId ||
      owner.token !== lease.token ||
      owner.revision !== lease.revision
    ) {
      throw new Error(`Stale ${lease.authority} authority lease`);
    }
    return lease;
  }

  snapshot(): SessionRuntimeAuthoritySnapshot {
    const owner = (authority: SessionRuntimeAuthorityKind): string | null =>
      this.#owners.get(authority)?.clientId ?? null;
    return SessionRuntimeAuthoritySnapshotSchemaZ.parse({
      generation: this.generation,
      session: this.session,
      revision: this.#revision,
      owners: {
        input: owner("input"),
        focus: owner("focus"),
        geometry: owner("geometry"),
      },
      nativeGeometryYieldUntilMs: this.#nativeGeometryYieldUntilMs,
      clients: [...this.#clients.values()]
        .sort(
          (a, b) =>
            a.connectedRevision - b.connectedRevision || a.clientId.localeCompare(b.clientId),
        )
        .map(({ clientId, surface, state, connectedRevision, activityRevision }) => ({
          clientId,
          surface,
          state,
          connectedRevision,
          activityRevision,
        })),
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#nativeYieldEpoch += 1;
    this.#nativeYieldTimer?.cancel();
    this.#nativeYieldTimer = null;
    this.#clients.clear();
    this.#owners.clear();
    this.#advance();
  }

  #elect(authority: SessionRuntimeAuthorityKind, activeClientId?: string): void {
    if (authority === "geometry" && this.#scheduler.nowMs() < this.#nativeGeometryYieldUntilMs) {
      this.#setOwner(authority, null);
      return;
    }
    const current = this.#owners.get(authority);
    const currentClient = current ? this.#clients.get(current.clientId) : null;
    const eligible = (client: ClientState): boolean =>
      client.claims.has(authority) && (authority === "input" || client.state === "foreground");

    // Geometry remains stable until its owner backgrounds, disconnects or
    // releases. Native activity uses the yield window above instead of racing.
    if (authority === "geometry" && currentClient && eligible(currentClient)) return;

    const candidates = [...this.#clients.values()].filter(eligible);
    candidates.sort((a, b) => {
      const aActive = a.clientId === activeClientId ? 1 : 0;
      const bActive = b.clientId === activeClientId ? 1 : 0;
      return (
        bActive - aActive ||
        Number(b.state === "foreground") - Number(a.state === "foreground") ||
        b.activityRevision - a.activityRevision ||
        b.connectedRevision - a.connectedRevision ||
        a.clientId.localeCompare(b.clientId)
      );
    });
    this.#setOwner(authority, candidates[0]?.clientId ?? null);
  }

  #setOwner(authority: SessionRuntimeAuthorityKind, clientId: string | null): void {
    const current = this.#owners.get(authority);
    if (current?.clientId === clientId || (!current && clientId === null)) return;
    const revision = this.#advance();
    if (clientId === null) this.#owners.delete(authority);
    else {
      this.#owners.set(authority, {
        clientId,
        token: this.#scheduler.createId(),
        revision,
      });
    }
    if (authority === "geometry") this.#onGeometryAuthorityChanged(clientId);
  }

  #client(clientIdInput: string): ClientState {
    this.#assertOpen();
    const clientId = SessionRuntimeClientIdSchemaZ.parse(clientIdInput);
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Authority client ${clientId} is not connected`);
    return client;
  }

  #advance(): number {
    this.#revision += 1;
    return this.#revision;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error(`Authority arbiter for ${this.session} is disposed`);
  }
}
