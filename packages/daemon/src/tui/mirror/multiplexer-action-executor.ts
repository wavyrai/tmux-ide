import { randomUUID } from "node:crypto";

import {
  type ActionInput,
  type ActionName,
  type ActionResult,
  type CanonicalDaemonInfo,
} from "@tmux-ide/contracts";
import {
  DaemonActionInvocationError,
  dispatchOwnerAction,
} from "@tmux-ide/daemon-client/owner-action-client";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import type { SessionPaneDescriptor } from "../../terminal/protocol/session-descriptor-discovery.ts";
import {
  fetchCanonicalWorkspaceCatalog,
  workspaceNameForSession,
} from "./canonical-workspace-routing.ts";

export type TuiMultiplexerAction =
  | { kind: "rename-session"; name: string }
  | { kind: "kill-session" }
  | { kind: "new-window" }
  | { kind: "rename-window"; name: string }
  | { kind: "kill-window" }
  | { kind: "zoom-pane" }
  | { kind: "swap-pane" }
  | { kind: "split-pane-right" }
  | { kind: "split-pane-down" }
  | { kind: "resize-pane"; axis: "cols" | "rows"; cells: number }
  | { kind: "kill-pane" };

export interface TuiMultiplexerContext {
  readonly sessionName: string;
  readonly focusedRuntimePaneId: string | null;
  readonly paneDescriptors: readonly SessionPaneDescriptor[];
  readonly viewportSize?: { readonly cols: number; readonly rows: number } | null;
}

export type TuiMultiplexerExecutionResult =
  | { readonly status: "daemon"; readonly message: string }
  | { readonly status: "local"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

interface TuiMultiplexerExecutorDeps {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly isCanonicalDaemonAlive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetch: typeof fetch;
  readonly dispatchAction: <Name extends ActionName>(
    daemon: CanonicalDaemonInfo,
    name: Name,
    input: ActionInput<Name>,
    options: { operationId: string; autostart: false },
  ) => Promise<ActionResult<Name> | null>;
  readonly operationId: () => string;
}

const DEFAULT_DEPS: TuiMultiplexerExecutorDeps = {
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  fetch,
  dispatchAction: (daemon, name, input, options) =>
    dispatchOwnerAction({
      baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
      ownerToken: daemon.authToken ?? "",
      name,
      input,
      operationId: options.operationId,
    }),
  operationId: randomUUID,
};

function tmuxQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function localCommand(action: TuiMultiplexerAction, context: TuiMultiplexerContext): string | null {
  const pane = context.focusedRuntimePaneId;
  switch (action.kind) {
    case "rename-session":
      return `rename-session -t ${context.sessionName} ${tmuxQuote(action.name)}`;
    case "kill-session":
      return `kill-session -t ${context.sessionName}`;
    case "new-window": {
      // tmux 3.5a can crash or retire a control-mode client when `new-window`
      // runs on that channel. Tmuxy's production-proven equivalent is a split
      // immediately broken into its own window. Geometry belongs to the
      // SessionRuntime viewport lease and is never embedded in this command.
      return `split-window -t ${tmuxQuote(context.sessionName)} ; break-pane`;
    }
    case "rename-window":
      return pane ? `rename-window -t ${pane} ${tmuxQuote(action.name)}` : null;
    case "kill-window":
      return pane ? `kill-window -t ${pane}` : null;
    case "zoom-pane":
      return pane ? `resize-pane -Z -t ${pane}` : null;
    case "swap-pane":
      return pane ? `swap-pane -D -t ${pane}` : null;
    case "split-pane-right":
      return pane ? `split-window -h -t ${pane} -c "#{pane_current_path}"` : null;
    case "split-pane-down":
      return pane ? `split-window -v -t ${pane} -c "#{pane_current_path}"` : null;
    case "resize-pane":
      return pane
        ? `resize-pane -t ${pane} ${action.axis === "cols" ? "-x" : "-y"} ${action.cells}`
        : null;
    case "kill-pane":
      return pane ? `kill-pane -t ${pane}` : null;
  }
}

function successMessage(action: TuiMultiplexerAction, result?: unknown): string {
  switch (action.kind) {
    case "rename-session":
      return `renamed session → ${action.name}`;
    case "kill-session":
      return "closed session";
    case "new-window":
      return "new window";
    case "rename-window":
      return `renamed window → ${action.name}`;
    case "kill-window":
      return "closed window";
    case "zoom-pane": {
      const zoomed =
        typeof result === "object" && result !== null && "zoomed" in result
          ? Boolean(result.zoomed)
          : null;
      return zoomed === null ? "toggled pane zoom" : zoomed ? "zoomed pane" : "unzoomed pane";
    }
    case "swap-pane":
      return "swapped pane";
    case "split-pane-right":
      return "split pane right";
    case "split-pane-down":
      return "split pane down";
    case "resize-pane":
      return `resized pane to ${action.cells} ${action.axis}`;
    case "kill-pane":
      return "closed pane";
  }
}

function focusedDescriptor(context: TuiMultiplexerContext): SessionPaneDescriptor | null {
  if (!context.focusedRuntimePaneId) return null;
  return (
    context.paneDescriptors.find(
      (descriptor) => descriptor.runtimePaneId === context.focusedRuntimePaneId,
    ) ?? null
  );
}

function semanticPane(
  context: TuiMultiplexerContext,
): { descriptor: SessionPaneDescriptor; semanticPaneId: string } | null {
  const descriptor = focusedDescriptor(context);
  return descriptor?.semanticPaneId
    ? { descriptor, semanticPaneId: descriptor.semanticPaneId }
    : null;
}

function swapTarget(context: TuiMultiplexerContext, source: SessionPaneDescriptor): string | null {
  const peers = context.paneDescriptors.filter(
    (descriptor) => descriptor.windowId === source.windowId && descriptor.semanticPaneId !== null,
  );
  if (peers.length < 2) return null;
  const sourceIndex = peers.findIndex(
    (descriptor) => descriptor.runtimePaneId === source.runtimePaneId,
  );
  if (sourceIndex < 0) return null;
  return peers[(sourceIndex + 1) % peers.length]?.semanticPaneId ?? null;
}

async function dispatch(
  action: TuiMultiplexerAction,
  context: TuiMultiplexerContext,
  daemon: CanonicalDaemonInfo,
  workspaceName: string,
  operationId: string,
  deps: TuiMultiplexerExecutorDeps,
): Promise<unknown> {
  const pane = semanticPane(context);
  if (
    action.kind !== "new-window" &&
    action.kind !== "rename-session" &&
    action.kind !== "kill-session" &&
    !pane
  ) {
    throw new Error("the active pane does not have a durable semantic identity yet");
  }
  const options = { operationId, autostart: false } as const;
  switch (action.kind) {
    case "rename-session":
      return deps.dispatchAction(
        daemon,
        "workspace.rename",
        { workspaceName, scope: "session", name: action.name },
        options,
      );
    case "kill-session":
      return deps.dispatchAction(daemon, "workspace.session.kill", { workspaceName }, options);
    case "new-window":
      return deps.dispatchAction(
        daemon,
        "workspace.pane.create",
        { kind: "terminal", workspaceName },
        options,
      );
    case "rename-window":
      return deps.dispatchAction(
        daemon,
        "workspace.rename",
        {
          workspaceName,
          scope: "window",
          target: { by: "pane", semanticPaneId: pane!.semanticPaneId },
          name: action.name,
        },
        options,
      );
    case "kill-window":
      return deps.dispatchAction(
        daemon,
        "workspace.window.kill",
        {
          workspaceName,
          target: { by: "pane", semanticPaneId: pane!.semanticPaneId },
        },
        options,
      );
    case "zoom-pane":
      return deps.dispatchAction(
        daemon,
        "workspace.pane.zoom.toggle",
        { workspaceName, semanticPaneId: pane!.semanticPaneId, desired: "toggle" },
        options,
      );
    case "swap-pane": {
      const targetSemanticPaneId = swapTarget(context, pane!.descriptor);
      if (!targetSemanticPaneId) throw new Error("this window has no other semantic pane to swap");
      return deps.dispatchAction(
        daemon,
        "workspace.pane.swap",
        {
          workspaceName,
          sourceSemanticPaneId: pane!.semanticPaneId,
          targetSemanticPaneId,
        },
        options,
      );
    }
    case "split-pane-right":
    case "split-pane-down":
      return deps.dispatchAction(
        daemon,
        "workspace.window.split",
        {
          workspaceName,
          semanticPaneId: pane!.semanticPaneId,
          direction: action.kind === "split-pane-right" ? "right" : "down",
        },
        options,
      );
    case "resize-pane":
      return deps.dispatchAction(
        daemon,
        "workspace.pane.resize",
        {
          workspaceName,
          semanticPaneId: pane!.semanticPaneId,
          axis: action.axis,
          cells: action.cells,
        },
        options,
      );
    case "kill-pane":
      return deps.dispatchAction(
        daemon,
        "workspace.pane.kill",
        { workspaceName, semanticPaneId: pane!.semanticPaneId },
        options,
      );
  }
}

/**
 * Execute one TUI multiplexer verb through the canonical daemon when present.
 *
 * Raw control-mode tmux is a deliberately narrow standalone fallback. Once a
 * live daemon exists, catalog, semantic-identity, authorization, and mutation
 * failures fail closed so the TUI cannot bypass the same authority the web GUI
 * is required to use.
 */
export async function executeTuiMultiplexerAction(
  action: TuiMultiplexerAction,
  context: TuiMultiplexerContext,
  runLocal: (command: string) => Promise<unknown>,
  overrides: Partial<TuiMultiplexerExecutorDeps> = {},
): Promise<TuiMultiplexerExecutionResult> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const command = localCommand(action, context);
  const canonical = deps.readCanonicalDaemonInfo();
  if (!canonical || !(await deps.isCanonicalDaemonAlive(canonical))) {
    if (!command) return { status: "error", message: "no active tmux pane" };
    try {
      await runLocal(command);
      return { status: "local", message: successMessage(action) };
    } catch (error) {
      return {
        status: "error",
        message: `tmux action failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!canonical.authToken) {
    return { status: "error", message: "the live daemon has no local owner credential" };
  }

  try {
    const catalog = await fetchCanonicalWorkspaceCatalog(canonical, deps.fetch);
    const workspaceName = workspaceNameForSession(catalog, context.sessionName);
    if (!workspaceName) {
      return {
        status: "error",
        message: `the live daemon does not own session ${context.sessionName}`,
      };
    }
    const result = await dispatch(
      action,
      context,
      canonical,
      workspaceName,
      deps.operationId(),
      deps,
    );
    if (result === null) {
      return {
        status: "error",
        message: "the daemon did not confirm the tmux action; nothing was retried locally",
      };
    }
    return { status: "daemon", message: successMessage(action, result) };
  } catch (error) {
    const message =
      error instanceof DaemonActionInvocationError
        ? error.message
        : `tmux action unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return { status: "error", message };
  }
}
