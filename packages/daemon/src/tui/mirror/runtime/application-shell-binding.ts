import type {
  ApplicationShellProjectionV1,
  CommandSource,
  ProductSurfaceId,
} from "@tmux-ide/contracts";

import { OPEN_TUI_HOST_CLIENT_ID } from "../open-tui-workspace-runtime-port.ts";
import {
  applicationShellPaletteInvocation,
  applicationShellSurfaceInvocations,
} from "../workspace/application-shell-surface-commands.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";

type ShellClient = Pick<OpenTuiProductionWorkspaceClient, "dispatch" | "getSnapshot" | "subscribe">;

export interface ApplicationShellBindingGeneration {
  readonly status: "connecting" | "live" | "rebinding" | "empty" | "unavailable" | "disposed";
  readonly client: ShellClient | null;
}

export interface ApplicationShellBindingSnapshot {
  readonly semantic: ApplicationShellProjectionV1 | null;
  readonly status: string;
  readonly readOnly: boolean;
  readonly localPaletteOpen: boolean;
}

export interface ApplicationShellBinding {
  getSnapshot(): ApplicationShellBindingSnapshot;
  subscribe(listener: (snapshot: ApplicationShellBindingSnapshot) => void): () => void;
  adoptGeneration(generation: ApplicationShellBindingGeneration | null): void;
  openSurface(surface: ProductSurfaceId, source: CommandSource): Promise<boolean>;
  setPaletteOpen(open: boolean, source: CommandSource): Promise<boolean>;
  openSession(
    sessionName: string,
    source: CommandSource,
    open: (sessionName: string) => Promise<boolean>,
  ): Promise<{ readonly opened: boolean; readonly activated: boolean }>;
  dispose(): void;
}

export function createApplicationShellBinding(
  options: {
    readonly onDiagnostic?: (phase: string, details: Readonly<Record<string, unknown>>) => void;
  } = {},
): ApplicationShellBinding {
  let generation: ApplicationShellBindingGeneration | null = null;
  let client: ShellClient | null = null;
  let epoch = 0;
  let retainedSemantic: ApplicationShellProjectionV1 | null = null;
  let clientStatus: string | null = null;
  let readOnly = false;
  let localPaletteOpen = false;
  let stops: readonly (() => void)[] = [];
  const listeners = new Set<(snapshot: ApplicationShellBindingSnapshot) => void>();

  const status = (): string => {
    if (!generation) return "unavailable";
    if (generation.status === "rebinding") return "rebinding";
    const value = clientStatus ?? generation.status;
    return readOnly && value === "live" ? "read-only" : value;
  };
  const snapshot = (): ApplicationShellBindingSnapshot =>
    Object.freeze({ semantic: retainedSemantic, status: status(), readOnly, localPaletteOpen });
  const publish = (): void => {
    const value = snapshot();
    for (const listener of listeners) listener(value);
  };
  const unbind = (): void => {
    epoch += 1;
    for (const stop of stops) stop();
    stops = [];
    client = null;
    clientStatus = null;
    readOnly = false;
  };
  const bind = (next: ShellClient): void => {
    if (next === client) return;
    unbind();
    client = next;
    const fence = epoch;
    const current = next.getSnapshot();
    clientStatus = current.phase;
    // Runtime activation can publish the replacement terminal generation
    // before its deferred application-shell snapshot becomes live. Keep the
    // last coherent shell mounted until this client publishes its first
    // non-null semantic projection; unsafe terminal states clear it in
    // adoptGeneration instead.
    if (current.semantic !== null) retainedSemantic = current.semantic;
    const adoptAuthority = (authority: typeof current.authority): void => {
      if (fence !== epoch) return;
      readOnly =
        authority?.owners.input !== null &&
        authority?.owners.input !== undefined &&
        authority.owners.input !== OPEN_TUI_HOST_CLIENT_ID;
      publish();
    };
    adoptAuthority(current.authority);
    stops = [
      next.subscribe("semantic", (semantic) => {
        if (fence !== epoch || semantic === null) return;
        retainedSemantic = semantic;
        publish();
      }),
      next.subscribe("lifecycle", (lifecycle) => {
        if (fence !== epoch) return;
        const transport = lifecycle.shell.transport;
        clientStatus =
          transport && transport.phase !== "connected" && transport.phase !== "idle"
            ? transport.phase
            : lifecycle.phase;
        publish();
      }),
      next.subscribe("authority", adoptAuthority),
    ];
  };
  const dispatch = async (
    invocations: readonly Parameters<ShellClient["dispatch"]>[0][],
  ): Promise<boolean> => {
    const active = client;
    const fence = epoch;
    if (!active) return false;
    try {
      for (const command of invocations) {
        if (active !== client || fence !== epoch) return false;
        await active.dispatch(command);
      }
      return true;
    } catch (error) {
      try {
        options.onDiagnostic?.("application-shell-command-rejected", {
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Diagnostics are observational and cannot become a shell lifecycle failure.
      }
      return false;
    }
  };
  const openSurface = (surface: ProductSurfaceId, source: CommandSource): Promise<boolean> => {
    if (!retainedSemantic) return Promise.resolve(false);
    return dispatch(
      applicationShellSurfaceInvocations(retainedSemantic, surface, source).map((invocation) => ({
        kind: "application-shell" as const,
        invocation,
      })),
    );
  };

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    adoptGeneration(next) {
      generation = next;
      if (
        !next ||
        next.status === "empty" ||
        next.status === "unavailable" ||
        next.status === "disposed"
      ) {
        unbind();
        retainedSemantic = null;
      } else if (next.client) {
        bind(next.client);
      } else if (next.status !== "rebinding") {
        unbind();
        retainedSemantic = null;
      }
      publish();
    },
    openSurface,
    setPaletteOpen(open, source) {
      if (!retainedSemantic) {
        localPaletteOpen = open;
        publish();
        return Promise.resolve(false);
      }
      return dispatch([
        {
          kind: "application-shell",
          invocation: applicationShellPaletteInvocation(retainedSemantic, open, source),
        },
      ]);
    },
    async openSession(sessionName, source, open) {
      const opened = await open(sessionName);
      if (!opened) return { opened: false, activated: false };
      return { opened: true, activated: await openSurface("terminals", source) };
    },
    dispose() {
      unbind();
      retainedSemantic = null;
      listeners.clear();
    },
  };
}
