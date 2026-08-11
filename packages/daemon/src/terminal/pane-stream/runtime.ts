import type { SemanticPaneCatalog } from "../attachments/semantic-pane-catalog.ts";
import type { SessionRuntimeRegistry } from "../session-runtime/registry.ts";
import { SessionRuntimeTransportBinder } from "../session-runtime/transport-binding.ts";
import { PaneStreamLeaseManager } from "./lease-manager.ts";
import {
  PaneStreamAdmissionCoordinator,
  type PaneStreamAdmissionCoordinatorOptions,
} from "./pane-stream-websocket.ts";

export interface PaneStreamRuntimeOptions {
  readonly daemonInstanceId: string;
  readonly webSocketUrl: string;
  /** Canonical daemon-generation session/control owner. */
  readonly sessionRuntimeRegistry: SessionRuntimeRegistry;
  /** Shared production authority and trusted semantic resolver. */
  readonly semanticPaneCatalog?: SemanticPaneCatalog;
  readonly admission?: Omit<
    PaneStreamAdmissionCoordinatorOptions,
    "daemonInstanceId" | "webSocketUrl" | "leaseManager" | "mirror"
  >;
}

/**
 * One daemon-generation owner for the pane-stream transport: lease authority
 * and WebSocket admission. Session/control lifecycle belongs exclusively to
 * the injected SessionRuntimeRegistry.
 */
export class PaneStreamRuntime {
  readonly coordinator: PaneStreamAdmissionCoordinator;
  #disposePromise: Promise<void> | null = null;

  constructor(options: PaneStreamRuntimeOptions) {
    const leaseManager = new PaneStreamLeaseManager({
      daemonInstanceId: options.daemonInstanceId,
    });
    const transportBinder = new SessionRuntimeTransportBinder(options.sessionRuntimeRegistry);
    this.coordinator = new PaneStreamAdmissionCoordinator({
      ...options.admission,
      daemonInstanceId: options.daemonInstanceId,
      webSocketUrl: options.webSocketUrl,
      leaseManager,
      mirror: options.sessionRuntimeRegistry,
      bindSessionRuntime: (descriptor) => {
        if (!descriptor.hostClientId) {
          throw new Error("Pane stream lacks trusted host identity");
        }
        return transportBinder.bind({
          transport: "pane-stream",
          transportLeaseId: descriptor.leaseId,
          session: descriptor.sessionName,
          hostClientId: descriptor.hostClientId,
          allowedSourcePaneIds: descriptor.panes,
          interactive: descriptor.viewerMode === "interactive",
          ownsGeometry:
            descriptor.viewerMode === "interactive" && descriptor.terminalDelivery !== null,
        });
      },
    });
  }

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#disposePromise = (async () => {
        await this.coordinator.shutdown();
      })();
    }
    return this.#disposePromise;
  }
}

export function createPaneStreamRuntime(options: PaneStreamRuntimeOptions): PaneStreamRuntime {
  return new PaneStreamRuntime(options);
}
