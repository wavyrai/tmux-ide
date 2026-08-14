import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
  type SessionRuntimeControllerLease,
  type SessionRuntimeActivityKind,
  type SessionRuntimeAuthorityKind,
  type SessionRuntimeAuthorityLease,
  type SessionRuntimeAuthoritySnapshot,
  type SessionRuntimePresenceState,
  type SessionRuntimeSemanticIntent,
  type SessionRuntimeTerminalInput,
  type TerminalDeliveryOffer,
  type TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import type {
  SessionRuntimeConsumer,
  SessionRuntimeExecutionHandle,
  SessionRuntimeRegistry,
} from "./registry.ts";
import { SessionRuntimeControllerLeaseError } from "./registry.ts";

const TransportSchemaZ = z.enum(["terminal-attachment", "pane-stream"]);
const LeaseIdSchemaZ = z.uuid();
const HostClientIdSchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !/[\0\r\n]/u.test(v));

export type SessionRuntimeTransport = z.infer<typeof TransportSchemaZ>;

export interface SessionRuntimeTransportBindingRequest {
  readonly transport: SessionRuntimeTransport;
  readonly transportLeaseId: string;
  readonly session: string;
  /** Minted by the trusted host generation, never accepted from renderer JSON. */
  readonly hostClientId: string;
  /** Exact daemon-resolved grant. */
  readonly allowedSourcePaneIds: readonly string[];
  readonly interactive: boolean;
  readonly ownsGeometry?: boolean;
  /** New authority protocol; skips implicit v1 controller acquisition. */
  readonly explicitAuthority?: boolean;
}

interface SharedClient {
  readonly consumer: SessionRuntimeConsumer;
  refs: number;
  interactiveRefs: number;
  lease: SessionRuntimeControllerLease | null;
  readonly grantRefs: Map<string, number>;
  /** Live geometry-capable transports in admission order; newest wins. */
  readonly geometryTransportLeaseIds: string[];
}

function assertLiveScope(
  shared: SharedClient,
  lease: SessionRuntimeControllerLease,
  semanticPaneId?: string,
): void {
  if (shared.interactiveRefs <= 0 || shared.lease !== lease) {
    throw new SessionRuntimeControllerLeaseError(
      "stale-controller-lease",
      "The transport no longer owns live interactive authority.",
    );
  }
  if (semanticPaneId !== undefined && (shared.grantRefs.get(semanticPaneId) ?? 0) <= 0) {
    throw new SessionRuntimeControllerLeaseError(
      "invalid-source-pane-binding",
      "The source pane is no longer in the host's live transport grant.",
    );
  }
}

function assertLiveControllerPrincipal(
  shared: SharedClient,
  lease: SessionRuntimeControllerLease,
): void {
  if (shared.lease !== lease) {
    throw new SessionRuntimeControllerLeaseError(
      "stale-controller-lease",
      "The host no longer owns session controller authority.",
    );
  }
}

const clientsByRegistry = new WeakMap<object, Map<string, SharedClient>>();

export class SessionRuntimeTransportBinding {
  readonly #binder: SessionRuntimeTransportBinder;
  readonly #shared: SharedClient;
  readonly #allowedSourcePaneIds: ReadonlySet<string>;
  readonly #contributedSourcePaneIds: ReadonlySet<string>;
  readonly #interactive: boolean;
  readonly #explicitAuthority: boolean;
  readonly #deliverySubscriberId: string;
  readonly #transportLeaseId: string;
  readonly #intentHandles = new Map<string, SessionRuntimeExecutionHandle>();
  #baseHandle: SessionRuntimeExecutionHandle | null;
  #baseHandleLease: SessionRuntimeControllerLease | null;
  #closed = false;

  constructor(
    binder: SessionRuntimeTransportBinder,
    shared: SharedClient,
    allowedSourcePaneIds: readonly string[],
    contributedSourcePaneIds: readonly string[],
    interactive: boolean,
    transportLeaseId: string,
    ownsGeometry: boolean,
    explicitAuthority: boolean,
  ) {
    this.#binder = binder;
    this.#shared = shared;
    this.#allowedSourcePaneIds = new Set(allowedSourcePaneIds);
    this.#contributedSourcePaneIds = new Set(contributedSourcePaneIds);
    this.#interactive = interactive;
    this.#explicitAuthority = explicitAuthority;
    // Host identity is the stable controller principal. Delivery identity is a
    // transport lifecycle: overlapping reconnects need independent ACK,
    // visibility and close namespaces even when they share controller power.
    this.#deliverySubscriberId = `${shared.consumer.clientId}:${transportLeaseId}`;
    this.#transportLeaseId = transportLeaseId;
    if (interactive && ownsGeometry) shared.geometryTransportLeaseIds.push(transportLeaseId);
    if (interactive && !explicitAuthority && shared.lease === null)
      shared.lease = shared.consumer.acquireController();
    const lease = shared.lease;
    this.#baseHandle =
      interactive && lease
        ? binder.registry.createExecutionHandle(
            shared.consumer,
            lease,
            allowedSourcePaneIds,
            (semanticPaneId) => {
              this.#assertIntentScopeOpen();
              assertLiveScope(shared, lease, semanticPaneId);
              if (semanticPaneId !== undefined && !this.#allowedSourcePaneIds.has(semanticPaneId)) {
                throw new SessionRuntimeControllerLeaseError(
                  "invalid-source-pane-binding",
                  "The pane is outside this transport binding's live grant.",
                );
              }
            },
          )
        : null;
    this.#baseHandleLease = this.#baseHandle ? lease : null;
  }

  get generation(): string {
    return this.#shared.consumer.generation;
  }
  get session(): string {
    return this.#shared.consumer.session;
  }
  get clientId(): string {
    return this.#shared.consumer.clientId;
  }

  authoritySnapshot(): SessionRuntimeAuthoritySnapshot {
    this.#assertOpen();
    return this.#shared.consumer.authoritySnapshot();
  }

  /** One-way first-use adapter for clients that predate authority frames. */
  activateLegacyAuthority(geometry: boolean): SessionRuntimeAuthoritySnapshot {
    this.#assertOpen();
    if (!this.#interactive) return this.#shared.consumer.authoritySnapshot();
    this.#binder.activateController(this.#shared);
    this.#shared.consumer.acquireAuthority("input");
    if (geometry) this.#shared.consumer.acquireAuthority("geometry");
    return this.#shared.consumer.authoritySnapshot();
  }

  onAuthoritySnapshot(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void {
    this.#assertOpen();
    return this.#shared.consumer.onAuthoritySnapshot(listener);
  }

  updatePresence(state: SessionRuntimePresenceState): SessionRuntimeAuthoritySnapshot {
    this.#assertOpen();
    this.#shared.consumer.updatePresence(state);
    return this.#shared.consumer.authoritySnapshot();
  }

  noteActivity(activity: SessionRuntimeActivityKind): SessionRuntimeAuthoritySnapshot {
    this.#assertOpen();
    this.#shared.consumer.noteActivity(activity);
    return this.#shared.consumer.authoritySnapshot();
  }

  requestAuthority(authority: SessionRuntimeAuthorityKind): SessionRuntimeAuthorityLease | null {
    this.#assertOpen();
    if (!this.#interactive && authority !== "focus") return null;
    if (authority === "input" && this.#explicitAuthority) {
      // Synchronize the historical execution controller first. Its internal
      // handoff updates the arbiter without publishing; the explicit claim
      // below then publishes one snapshot where UI owner and executor agree.
      this.#binder.activateController(this.#shared);
    }
    const lease = this.#shared.consumer.acquireAuthority(authority);
    return lease;
  }

  releaseAuthority(authority: SessionRuntimeAuthorityKind): SessionRuntimeAuthoritySnapshot {
    this.#assertOpen();
    if (authority === "input" && this.#explicitAuthority && this.#shared.lease) {
      const controller = this.#shared.lease;
      this.#shared.lease = null;
      this.#baseHandle = null;
      this.#baseHandleLease = null;
      this.#intentHandles.clear();
      this.#shared.consumer.releaseController(controller);
      // releaseController uses the compatibility adapter directly; publish
      // the now-empty input authority snapshot through the typed seam.
      this.#shared.consumer.releaseAuthority("input");
    } else {
      this.#shared.consumer.releaseAuthority(authority);
    }
    return this.#shared.consumer.authoritySnapshot();
  }

  assertController(semanticPaneId?: string): void {
    this.#assertOpen();
    if (!this.#interactive) throw new Error("Passive transport has no input authority");
    this.#ensureBaseHandle();
    if (!this.#baseHandle)
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The interactive transport does not own input authority.",
      );
    this.#binder.registry.assertExecutionHandle(this.#baseHandle, semanticPaneId);
  }

  openTerminalDelivery(
    semanticPaneId: string,
    offer: TerminalDeliveryOffer,
    onMessage: (message: TerminalDeliveryServerMessage) => void | Promise<void>,
  ) {
    this.#assertOpen();
    if (!this.#allowedSourcePaneIds.has(semanticPaneId)) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-source-pane-binding",
        "The pane is not in the transport's live grant.",
      );
    }
    return this.#shared.consumer.openTerminalDelivery(
      this.#deliverySubscriberId,
      semanticPaneId,
      offer,
      onMessage,
    );
  }

  submitIntent(operationId: string, intentInput: SessionRuntimeSemanticIntent) {
    this.#assertOpen();
    const intent = SessionRuntimeSemanticIntentSchemaZ.parse(intentInput);
    const paneId = "semanticPaneId" in intent ? intent.semanticPaneId : undefined;
    this.assertController(paneId);
    if (!this.#shared.lease) {
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The transport no longer owns controller authority.",
      );
    }
    const scopeKey = paneId ?? "session";
    let handle = this.#intentHandles.get(scopeKey);
    if (!handle) {
      const lease = this.#shared.lease;
      handle = this.#binder.registry.createExecutionHandle(
        this.#shared.consumer,
        lease,
        [...this.#allowedSourcePaneIds],
        () => {
          this.#assertIntentScopeOpen();
          assertLiveScope(this.#shared, lease, paneId);
          if (paneId !== undefined && !this.#allowedSourcePaneIds.has(paneId)) {
            throw new SessionRuntimeControllerLeaseError(
              "invalid-source-pane-binding",
              "The pane is outside this transport binding's live grant.",
            );
          }
        },
      );
      this.#intentHandles.set(scopeKey, handle);
    }
    return this.#binder.registry.submitAuthenticatedIntent(handle, operationId, intent);
  }

  sendInput(
    semanticPaneId: string,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
  ): void {
    this.assertController(semanticPaneId);
    const lease = this.#shared.lease;
    if (!lease) {
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "The transport no longer owns controller authority.",
      );
    }
    this.#shared.consumer.sendInput(lease, semanticPaneId, input, performanceTraceId);
  }

  fitViewport(cols: number, rows: number): void {
    this.assertController();
    if (this.#shared.geometryTransportLeaseIds.at(-1) !== this.#transportLeaseId) {
      throw new SessionRuntimeControllerLeaseError(
        "invalid-client-capability",
        "The transport does not own the live geometry lease.",
      );
    }
    const lease = this.#shared.lease;
    if (!lease)
      throw new SessionRuntimeControllerLeaseError(
        "stale-controller-lease",
        "Geometry authority retired.",
      );
    this.#shared.consumer.fitViewport(lease, cols, rows);
  }

  executionHandleForSource(semanticPaneId: string): SessionRuntimeExecutionHandle {
    this.assertController(semanticPaneId);
    return this.#binder.registry.bindExecutionSource(this.#baseHandle!, semanticPaneId);
  }

  handoffController(target: SessionRuntimeTransportBinding): void {
    this.#assertOpen();
    target.#assertOpen();
    // TODO(m56.1e-c): handoff needs an explicit transport-mode transition so
    // a passive descriptor can be reissued as interactive before receiving
    // controller power. Until that protocol exists, accepting this target
    // would lie about its effective viewer mode.
    if (!target.#interactive)
      throw new Error("Cannot hand controller authority to a passive transport");
    if (target.#shared === this.#shared) return;
    if (!this.#shared.lease) throw new Error("Transport is not the controller");
    const handedOff = this.#shared.consumer.handoffController(
      this.#shared.lease,
      target.#shared.consumer.clientId,
    );
    this.#shared.lease = null;
    target.#shared.lease = handedOff;
    this.#baseHandle = null;
    this.#baseHandleLease = null;
    this.#intentHandles.clear();
    target.#intentHandles.clear();
    target.#baseHandle = target.#binder.registry.createExecutionHandle(
      target.#shared.consumer,
      handedOff,
      [...target.#allowedSourcePaneIds],
      (semanticPaneId) => assertLiveScope(target.#shared, handedOff, semanticPaneId),
    );
    target.#baseHandleLease = handedOff;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const geometryIndex = this.#shared.geometryTransportLeaseIds.indexOf(this.#transportLeaseId);
    if (geometryIndex >= 0) this.#shared.geometryTransportLeaseIds.splice(geometryIndex, 1);
    this.#intentHandles.clear();
    await this.#binder.release(this.#shared, this.#contributedSourcePaneIds, this.#interactive);
  }

  toJSON(): { generation: string; session: string; clientId: string; interactive: boolean } {
    return {
      generation: this.generation,
      session: this.session,
      clientId: this.clientId,
      interactive: this.#interactive,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SessionRuntime transport binding is closed");
  }

  #ensureBaseHandle(): void {
    if (this.#baseHandle && this.#baseHandleLease === this.#shared.lease) return;
    if (this.#baseHandle) {
      this.#baseHandle = null;
      this.#baseHandleLease = null;
      this.#intentHandles.clear();
    }
    if (!this.#interactive || !this.#shared.lease) return;
    const lease = this.#shared.lease;
    this.#baseHandle = this.#binder.registry.createExecutionHandle(
      this.#shared.consumer,
      lease,
      [...this.#allowedSourcePaneIds],
      (semanticPaneId) => {
        this.#assertIntentScopeOpen();
        assertLiveScope(this.#shared, lease, semanticPaneId);
        if (semanticPaneId !== undefined && !this.#allowedSourcePaneIds.has(semanticPaneId)) {
          throw new SessionRuntimeControllerLeaseError(
            "invalid-source-pane-binding",
            "The pane is outside this transport binding's live grant.",
          );
        }
      },
    );
    this.#baseHandleLease = lease;
  }

  #assertIntentScopeOpen(): void {
    if (!this.#closed) return;
    throw new SessionRuntimeControllerLeaseError(
      "invalid-source-pane-binding",
      "The transport binding closed before the queued operation reached its effect.",
    );
  }
}

export class SessionRuntimeTransportBinder {
  readonly registry: Pick<
    SessionRuntimeRegistry,
    | "connect"
    | "generation"
    | "createExecutionHandle"
    | "bindExecutionSource"
    | "assertExecutionHandle"
    | "submitAuthenticatedIntent"
  >;
  readonly #clients: Map<string, SharedClient>;

  constructor(registry: SessionRuntimeTransportBinder["registry"]) {
    this.registry = registry;
    const registryKey = registry as object;
    const existing = clientsByRegistry.get(registryKey);
    this.#clients = existing ?? new Map<string, SharedClient>();
    if (!existing) clientsByRegistry.set(registryKey, this.#clients);
  }

  bind(request: SessionRuntimeTransportBindingRequest): SessionRuntimeTransportBinding {
    const transport = TransportSchemaZ.parse(request.transport);
    LeaseIdSchemaZ.parse(request.transportLeaseId); // connection association, never identity
    const hostClientId = HostClientIdSchemaZ.parse(request.hostClientId);
    const allowedSourcePaneIds = request.allowedSourcePaneIds.map((paneId) =>
      TerminalAttachmentSemanticPaneIdSchemaZ.parse(paneId),
    );
    // Read-only subscriptions are visibility, never authorship proof. A host
    // controlling A while passively observing B may attribute only A.
    const contributedSourcePaneIds = request.interactive ? allowedSourcePaneIds : [];
    const key = `${request.session}\0${hostClientId}`;
    let shared = this.#clients.get(key);
    if (!shared) {
      shared = {
        consumer: this.registry.connect(request.session, transport, hostClientId),
        refs: 0,
        interactiveRefs: 0,
        lease: null,
        grantRefs: new Map(),
        geometryTransportLeaseIds: [],
      };
      this.#clients.set(key, shared);
    }
    shared.refs += 1;
    if (request.interactive) shared.interactiveRefs += 1;
    for (const paneId of contributedSourcePaneIds) {
      shared.grantRefs.set(paneId, (shared.grantRefs.get(paneId) ?? 0) + 1);
    }
    try {
      return new SessionRuntimeTransportBinding(
        this,
        shared,
        allowedSourcePaneIds,
        contributedSourcePaneIds,
        request.interactive,
        request.transportLeaseId,
        request.ownsGeometry === true,
        request.explicitAuthority === true,
      );
    } catch (error) {
      void this.release(shared, new Set(contributedSourcePaneIds), request.interactive);
      throw error;
    }
  }

  resolveExecutionHandle(
    session: string,
    hostClientId: string,
    sourceSemanticPaneId?: string,
  ): SessionRuntimeExecutionHandle | undefined {
    const shared = this.#clients.get(`${session}\0${hostClientId}`);
    if (!shared?.lease) return undefined;
    if (
      sourceSemanticPaneId !== undefined &&
      (shared.grantRefs.get(sourceSemanticPaneId) ?? 0) === 0
    ) {
      return undefined;
    }
    const grants = sourceSemanticPaneId === undefined ? [] : [sourceSemanticPaneId];
    const lease = shared.lease;
    const base = this.registry.createExecutionHandle(
      shared.consumer,
      lease,
      grants,
      (semanticPaneId) => {
        if (semanticPaneId === undefined) assertLiveControllerPrincipal(shared, lease);
        else assertLiveScope(shared, lease, semanticPaneId);
      },
    );
    return sourceSemanticPaneId === undefined
      ? base
      : this.registry.bindExecutionSource(base, sourceSemanticPaneId);
  }

  activateController(target: SharedClient): void {
    if (target.lease) return;
    const current = [...this.#clients.values()].find(
      (candidate) =>
        candidate !== target &&
        candidate.consumer.session === target.consumer.session &&
        candidate.lease,
    );
    if (current?.lease) {
      const previous = current.lease;
      current.lease = null;
      target.lease = current.consumer.handoffController(previous, target.consumer.clientId);
      return;
    }
    target.lease = target.consumer.acquireController();
  }

  async release(
    shared: SharedClient,
    grants: ReadonlySet<string>,
    interactive: boolean,
  ): Promise<void> {
    if (shared.refs <= 0) return;
    for (const paneId of grants) {
      const next = (shared.grantRefs.get(paneId) ?? 0) - 1;
      if (next > 0) shared.grantRefs.set(paneId, next);
      else shared.grantRefs.delete(paneId);
    }
    if (interactive) {
      shared.interactiveRefs -= 1;
    }
    shared.refs -= 1;
    if (shared.refs > 0) return;
    if (shared.lease) {
      // A same-host passive session channel keeps the controller PRINCIPAL
      // continuous across interactive pane retargeting. It contributes no
      // source-pane grant and cannot type; the lease retires with the last
      // host/session ref, while a passive-only host never acquires one.
      const retired = shared.lease;
      shared.lease = null;
      shared.consumer.releaseController(retired);
    }
    for (const [key, candidate] of this.#clients) {
      if (candidate === shared) this.#clients.delete(key);
    }
    await shared.consumer.close();
  }
}
