import { MirrorService } from "../mirror/mirror-service.ts";
import type { DaemonTmuxSocketSelector } from "../attachments/pty-tmux-attachment-launcher.ts";
import { PaneStreamLeaseManager } from "./lease-manager.ts";
import {
  PaneStreamAdmissionCoordinator,
  type PaneStreamAdmissionCoordinatorOptions,
} from "./pane-stream-websocket.ts";

export interface PaneStreamRuntimeOptions {
  readonly daemonInstanceId: string;
  readonly webSocketUrl: string;
  /** The daemon's pinned tmux authority; omit both for the default server. */
  readonly tmuxExecutablePath?: string;
  readonly tmuxSocketSelector?: DaemonTmuxSocketSelector;
  readonly admission?: Omit<
    PaneStreamAdmissionCoordinatorOptions,
    "daemonInstanceId" | "webSocketUrl" | "leaseManager" | "mirror"
  >;
}

/**
 * One daemon-generation owner for the pane-stream surface: the shared
 * MirrorService (one control client per session, refcounted), the lease
 * authority, and the WebSocket admission coordinator. The coordinator is the
 * issue backend the broker mutation route consumes.
 */
export class PaneStreamRuntime {
  readonly coordinator: PaneStreamAdmissionCoordinator;
  readonly mirror: MirrorService;
  #disposePromise: Promise<void> | null = null;

  constructor(options: PaneStreamRuntimeOptions) {
    const selector = options.tmuxSocketSelector;
    this.mirror = new MirrorService({
      executable: options.tmuxExecutablePath,
      ...(selector?.kind === "path" ? { socketPath: selector.path } : {}),
      ...(selector?.kind === "name" && selector.name !== "default"
        ? { socketName: selector.name }
        : {}),
    });
    const leaseManager = new PaneStreamLeaseManager({
      daemonInstanceId: options.daemonInstanceId,
    });
    this.coordinator = new PaneStreamAdmissionCoordinator({
      ...options.admission,
      daemonInstanceId: options.daemonInstanceId,
      webSocketUrl: options.webSocketUrl,
      leaseManager,
      mirror: this.mirror,
    });
  }

  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#disposePromise = (async () => {
        await this.coordinator.shutdown();
        await this.mirror.dispose();
      })();
    }
    return this.#disposePromise;
  }
}

export function createPaneStreamRuntime(options: PaneStreamRuntimeOptions): PaneStreamRuntime {
  return new PaneStreamRuntime(options);
}
