import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  type SessionRuntimeControllerLease,
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
}

interface SharedClient {
  readonly consumer: SessionRuntimeConsumer;
  refs: number;
  interactiveRefs: number;
  lease: SessionRuntimeControllerLease | null;
  readonly grantRefs: Map<string, number>;
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

const clientsByRegistry = new WeakMap<object, Map<string, SharedClient>>();

export class SessionRuntimeTransportBinding {
  readonly #binder: SessionRuntimeTransportBinder;
  readonly #shared: SharedClient;
  readonly #allowedSourcePaneIds: ReadonlySet<string>;
  readonly #contributedSourcePaneIds: ReadonlySet<string>;
  readonly #interactive: boolean;
  #baseHandle: SessionRuntimeExecutionHandle | null;
  #closed = false;

  constructor(
    binder: SessionRuntimeTransportBinder,
    shared: SharedClient,
    allowedSourcePaneIds: readonly string[],
    contributedSourcePaneIds: readonly string[],
    interactive: boolean,
  ) {
    this.#binder = binder;
    this.#shared = shared;
    this.#allowedSourcePaneIds = new Set(allowedSourcePaneIds);
    this.#contributedSourcePaneIds = new Set(contributedSourcePaneIds);
    this.#interactive = interactive;
    if (interactive && shared.lease === null) shared.lease = shared.consumer.acquireController();
    const lease = shared.lease;
    this.#baseHandle =
      interactive && lease
        ? binder.registry.createExecutionHandle(
            shared.consumer,
            lease,
            allowedSourcePaneIds,
            (semanticPaneId) => assertLiveScope(shared, lease, semanticPaneId),
          )
        : null;
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

  assertController(semanticPaneId?: string): void {
    this.#assertOpen();
    if (!this.#interactive || !this.#baseHandle)
      throw new Error("Passive transport has no input authority");
    this.#binder.registry.assertExecutionHandle(this.#baseHandle, semanticPaneId);
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
    target.#baseHandle = target.#binder.registry.createExecutionHandle(
      target.#shared.consumer,
      handedOff,
      [...target.#allowedSourcePaneIds],
      (semanticPaneId) => assertLiveScope(target.#shared, handedOff, semanticPaneId),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
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
}

export class SessionRuntimeTransportBinder {
  readonly registry: Pick<
    SessionRuntimeRegistry,
    | "connect"
    | "generation"
    | "createExecutionHandle"
    | "bindExecutionSource"
    | "assertExecutionHandle"
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
      (semanticPaneId) => assertLiveScope(shared, lease, semanticPaneId),
    );
    return sourceSemanticPaneId === undefined
      ? base
      : this.registry.bindExecutionSource(base, sourceSemanticPaneId);
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
      if (shared.interactiveRefs === 0 && shared.lease) {
        // Passive visibility may keep the shared consumer alive, but never its
        // controller lease or any execution handle derived from that lease.
        const retired = shared.lease;
        shared.lease = null;
        shared.consumer.releaseController(retired);
      }
    }
    shared.refs -= 1;
    if (shared.refs > 0) return;
    for (const [key, candidate] of this.#clients) {
      if (candidate === shared) this.#clients.delete(key);
    }
    await shared.consumer.close();
  }
}
