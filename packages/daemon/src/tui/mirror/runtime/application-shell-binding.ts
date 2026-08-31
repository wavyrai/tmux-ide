import type {
  ApplicationShellProjectionV1,
  CommandSource,
  ProductSurfaceId,
} from "@tmux-ide/contracts";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  applicationShellCommandInvocation,
} from "@tmux-ide/contracts";

import { OPEN_TUI_HOST_CLIENT_ID } from "../open-tui-workspace-runtime-port.ts";
import {
  applicationShellPaletteInvocation,
  applicationShellSurfaceInvocations,
} from "../workspace/application-shell-surface-commands.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";

type ShellClient = Pick<OpenTuiProductionWorkspaceClient, "dispatch" | "getSnapshot" | "subscribe">;

export type ApplicationShellRenderSignature = readonly (string | number | boolean | null)[];

export function applicationShellRenderSignature(
  semantic: ApplicationShellProjectionV1 | null,
): ApplicationShellRenderSignature | null {
  if (!semantic) return null;
  return Object.freeze([
    "project",
    semantic.project.name,
    "sidebar",
    semantic.sidebar.activeSessionId,
    "sessions",
    semantic.sidebar.sessions.length,
    ...semantic.sidebar.sessions.flatMap((session) => [
      session.id,
      session.label,
      session.state,
      session.active,
    ]),
    "agents",
    semantic.sidebar.agents.length,
    ...semantic.sidebar.agents.flatMap((agent) => [
      agent.id,
      agent.name,
      agent.harness,
      agent.activity,
      agent.paneId,
      agent.attention,
    ]),
    "primary-navigation",
    semantic.primaryNavigation.activeMode,
    semantic.primaryNavigation.items.length,
    ...semantic.primaryNavigation.items.flatMap((item) => [
      item.id,
      item.icon,
      item.label,
      item.shortcut,
      item.active,
      item.attention,
      item.disabledReason,
    ]),
    "workspace-canvas",
    semantic.workspaceCanvas.activeMode,
    "bottom-dock",
    semantic.bottomDock.mode,
    semantic.bottomDock.activeTool,
    semantic.bottomDock.tools.length,
    ...semantic.bottomDock.tools.flatMap((item) => [
      item.id,
      item.icon,
      item.label,
      item.shortcut,
      item.active,
      item.attention,
      item.disabledReason,
    ]),
    "status-strip",
    semantic.statusStrip.message,
    "focus",
    semantic.focus.zone,
    "overlays",
    semantic.focus.overlays.length,
    semantic.focus.overlays.length > 0,
    semantic.focus.palette.open,
  ]);
}

function sameSignature(
  left: ApplicationShellRenderSignature | null,
  right: ApplicationShellRenderSignature | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.length === right.length &&
      left.every((value, index) => Object.is(value, right[index])))
  );
}

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

export function applicationShellBindingRenderSignature(
  snapshot: ApplicationShellBindingSnapshot,
): ApplicationShellRenderSignature {
  const semantic = applicationShellRenderSignature(snapshot.semantic);
  return Object.freeze([
    "semantic",
    semantic?.length ?? 0,
    ...(semantic ?? []),
    "binding",
    snapshot.status,
    snapshot.readOnly,
    snapshot.localPaletteOpen,
  ]);
}

export interface ApplicationShellBinding {
  getSnapshot(): ApplicationShellBindingSnapshot;
  subscribe(listener: (snapshot: ApplicationShellBindingSnapshot) => void): () => void;
  adoptGeneration(generation: ApplicationShellBindingGeneration | null): void;
  openSurface(surface: ProductSurfaceId, source: CommandSource): Promise<boolean>;
  setPaletteOpen(open: boolean, source: CommandSource): Promise<boolean>;
  activatePaletteSurface(surface: ProductSurfaceId, source: CommandSource): Promise<boolean>;
  focusTerminalPane(paneId: string, source: CommandSource): Promise<boolean>;
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
  let publishedSignature: ApplicationShellRenderSignature | null = null;
  let stops: readonly (() => void)[] = [];
  const semanticWaiters = new Set<(ready: boolean) => void>();
  const listeners = new Set<(snapshot: ApplicationShellBindingSnapshot) => void>();

  const settleSemanticWaiters = (ready: boolean): void => {
    for (const resolve of semanticWaiters) resolve(ready);
    semanticWaiters.clear();
  };
  const waitForSemantic = (): Promise<boolean> => {
    if (retainedSemantic) return Promise.resolve(true);
    if (!client) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => semanticWaiters.add(resolve));
  };

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
    const signature = applicationShellBindingRenderSignature(value);
    if (sameSignature(signature, publishedSignature)) return;
    publishedSignature = signature;
    for (const listener of listeners) listener(value);
  };
  const unbind = (): void => {
    epoch += 1;
    settleSemanticWaiters(false);
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
    if (current.semantic !== null) {
      retainedSemantic = current.semantic;
      localPaletteOpen = false;
      settleSemanticWaiters(true);
    }
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
        localPaletteOpen = false;
        settleSemanticWaiters(true);
        publish();
      }),
      next.subscribe("lifecycle", (lifecycle) => {
        if (fence !== epoch) return;
        const transport = lifecycle.shell.transport;
        clientStatus =
          transport && transport.phase !== "connected" && transport.phase !== "idle"
            ? transport.phase
            : lifecycle.phase;
        if (
          !retainedSemantic &&
          (lifecycle.phase === "degraded" ||
            lifecycle.phase === "unavailable" ||
            lifecycle.phase === "error" ||
            lifecycle.phase === "disposed")
        )
          settleSemanticWaiters(false);
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
        localPaletteOpen = false;
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
      localPaletteOpen = false;
      return dispatch([
        {
          kind: "application-shell",
          invocation: applicationShellPaletteInvocation(retainedSemantic, open, source),
        },
      ]);
    },
    activatePaletteSurface(surface, source) {
      if (!retainedSemantic) {
        localPaletteOpen = false;
        publish();
        return Promise.resolve(false);
      }
      localPaletteOpen = false;
      return dispatch([
        ...applicationShellSurfaceInvocations(retainedSemantic, surface, source).map(
          (invocation) => ({ kind: "application-shell" as const, invocation }),
        ),
        {
          kind: "application-shell",
          invocation: applicationShellPaletteInvocation(retainedSemantic, false, source),
        },
      ]);
    },
    focusTerminalPane(paneId: string, source: CommandSource) {
      if (!retainedSemantic) return Promise.resolve(false);
      return dispatch([
        {
          kind: "application-shell",
          invocation: applicationShellCommandInvocation(
            APPLICATION_SHELL_COMMAND_IDS.moveFocus,
            { target: { kind: "pane", paneId, input: "terminal" } },
            source,
          ),
        },
      ]);
    },
    async openSession(sessionName, source, open) {
      const opened = await open(sessionName);
      if (!opened) return { opened: false, activated: false };
      if (!retainedSemantic && !(await waitForSemantic()))
        return { opened: true, activated: false };
      return { opened: true, activated: await openSurface("terminals", source) };
    },
    dispose() {
      unbind();
      retainedSemantic = null;
      localPaletteOpen = false;
      listeners.clear();
    },
  };
}
