import {
  AgentGraphOverlaySchemaZ,
  AppWindowMutationHostResultSchemaZ,
  ApplicationShellProjectionInputV3SchemaZ,
  WorkspacePaneCreateHostResultSchemaZ,
  projectApplicationShellV1,
  projectDesktopStartupReadiness,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityState,
  type DesktopPlatform,
  type DesktopWindowState,
  type HostCapabilities,
  type StartupReadinessLadder,
  type WorkspaceChangeResourceId,
  type WorkspaceFileResourceId,
  type WorkspacePaneCreateInvocation,
} from "@tmux-ide/contracts";
import {
  initialInteractionFeedState,
  reduceInteractionReceipt,
  type InteractionFeedState,
} from "@tmux-ide/core";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import {
  paneFrameTerminalsFromApplicationShellInventory,
  type ApplicationShellTerminalPaneFrame,
} from "../../../../packages/daemon/src/ui/pane-frame/model.ts";
import type {
  PaneFrameActionIntent,
  PaneFrameActivationSource,
  PaneFrameGripIntent,
} from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { DomApplicationShell } from "../experience/application-shell.tsx";
import type { AppWindowCanvasCommandInvocation } from "../experience/app-window-canvas-presenter.ts";
import type { CreatePaneFlowCatalogs } from "../experience/create-pane-flow-presenter.ts";
import { DomIcon } from "../experience/dom-icon.tsx";
import { FirstRunIntro } from "../experience/first-run-intro.tsx";
import type { ChangesSurfaceProps } from "../experience/workspace-changes-surface.tsx";
import type { FilesSurfaceProps } from "../experience/workspace-files-surface.tsx";
import {
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";

import { Button, Icon } from "../ui-system/index.ts";

/**
 * The runtime state as a glyph, in the same three shapes the status strip uses
 * so a degraded workspace looks the same wherever it is reported.
 */
function runtimeStateGlyph(state: string) {
  if (state === "onboarding" || state === "chooser") return CheckmarkCircle02Icon;
  if (state === "degraded" || state === "error" || state === "hard-error") return Alert02Icon;
  return Loading03Icon;
}
import { deriveConnectionHealth } from "./connection-health.ts";
import {
  reasonIndicatesMissingTmux,
  recoveryForWorkspaceOpenError,
  startupReadinessDiagnostics,
  tmuxInstallCommand,
} from "./connection-recovery.ts";
import type { DesktopApplicationShellResourceState } from "./connection-state.ts";
import { createSolidDesktopApplicationShellResourceStore } from "./desktop-resource-store.ts";
import { createHostDaemonTransport } from "./host-daemon-transport.ts";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import {
  createSolidDesktopWorkspaceCatalogStore,
  type DesktopWorkspaceCatalogState,
} from "./workspace-catalog-store.ts";
import {
  createSolidWorkspaceChangeDiffStore,
  createSolidWorkspaceChangesCatalogStore,
} from "./workspace-changes-store.ts";
import {
  createSolidWorkspaceFilePreviewStore,
  createSolidWorkspaceFilesCatalogStore,
} from "./workspace-files-store.ts";
import { createSolidWorkspaceMissionsStore } from "./workspace-missions-store.ts";
import { createGuiResourceTelemetry } from "./gui-resource-telemetry.ts";
import {
  changeDiffSurfaceModel,
  changeEntriesById,
  changesSurfaceModel,
  collectFileCatalogs,
  filePreviewSurfaceModel,
  filesSurfaceModel,
} from "./workspace-surface-model.ts";

export type DesktopDaemonRecoveryPhase =
  | "idle"
  | "refreshing"
  | "unchanged"
  | "superseded"
  | "failed";

export interface DesktopLiveApplicationProps {
  readonly host: HostCapabilities;
  readonly daemon: DesktopDaemonCapabilityState;
  readonly runtime?: string;
  readonly platform?: DesktopPlatform;
  readonly windowState?: DesktopWindowState | null;
  readonly onDaemonIdentityMismatch?: () => void;
  readonly daemonRecovery?: DesktopDaemonRecoveryPhase;
  readonly onRetryDaemonConnection?: () => void;
  readonly onCommand?: (invocation: ApplicationShellCommandInvocation) => void;
  readonly onPaneAction?: (
    intent: PaneFrameActionIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly onPaneGrip?: (intent: PaneFrameGripIntent, source: PaneFrameActivationSource) => void;
  readonly onAppWindowCommand?: (
    invocation: AppWindowCanvasCommandInvocation,
  ) => void | Promise<void>;
  readonly terminalTransport?: NativeTerminalTransport | null;
  readonly reducedMotion?: boolean;
  readonly terminalThemeKey?: string;
  /** Show the first-run intro layer over the first live workspace. */
  readonly introPending?: boolean;
  readonly onAcknowledgeIntro?: () => void;
}

interface DesktopConnectionSurfaceProps {
  readonly host?: HostCapabilities;
  readonly runtime?: string;
  readonly platform?: DesktopPlatform;
  readonly windowState?: DesktopWindowState | null;
  readonly state:
    | "pending"
    | "loading"
    | "onboarding"
    | "chooser"
    | "degraded"
    | "error"
    | "hard-error";
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly guidance: string;
  readonly alert?: boolean;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly onRestartConnection?: () => void;
  readonly diagnostics?: readonly string[];
  readonly workspaces?: readonly string[];
  readonly onSelectWorkspace?: (workspaceName: string) => void;
  readonly onOpenProject?: () => void;
  readonly openProjectPhase?: "idle" | "selecting" | "opening" | "waiting" | "error";
  readonly openProjectError?: string | null;
  /** A copyable shell command shown when a concrete step resolves this state. */
  readonly command?: string | null;
}

/** Selectable command block with a best-effort copy button (no host clipboard needed). */
function RecoveryCommand(props: { readonly command: string }) {
  const [copied, setCopied] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (resetTimer) clearTimeout(resetTimer);
  });
  const copy = (): void => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    void clipboard?.writeText(props.command).then(
      () => {
        setCopied(true);
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => setCopied(false), 2_000);
      },
      () => undefined,
    );
  };
  return (
    <div class="runtime-state-card__command">
      <code>{props.command}</code>
      <Button
        size="small"
        variant="secondary"
        aria-label={copied() ? "Command copied" : "Copy command"}
        onClick={copy}
      >
        {copied() ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function WindowControls(props: {
  readonly host?: HostCapabilities;
  readonly runtime?: string;
  readonly platform?: DesktopPlatform;
  readonly windowState?: DesktopWindowState | null;
}) {
  return (
    <Show when={props.host && props.runtime === "electron" && props.platform !== "darwin"}>
      <nav class="window-controls" aria-label="Window controls">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => void props.host?.window.minimize()}
        >
          <DomIcon id="minimize" usage="nativeWindow" />
        </button>
        <button
          type="button"
          aria-label={props.windowState?.maximized ? "Restore" : "Maximize"}
          onClick={() => void props.host?.window.toggleMaximized()}
        >
          <DomIcon
            id={props.windowState?.maximized ? "restore" : "maximize"}
            usage="nativeWindow"
          />
        </button>
        <button type="button" aria-label="Close" onClick={() => void props.host?.window.close()}>
          <DomIcon id="close" usage="nativeWindow" />
        </button>
      </nav>
    </Show>
  );
}

function focusWorkspaceOption(
  container: HTMLElement,
  current: HTMLElement,
  direction: "previous" | "next" | "first" | "last",
): void {
  const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
  if (options.length === 0) return;
  const currentIndex = Math.max(0, options.indexOf(current));
  const nextIndex =
    direction === "first"
      ? 0
      : direction === "last"
        ? options.length - 1
        : direction === "next"
          ? (currentIndex + 1) % options.length
          : (currentIndex - 1 + options.length) % options.length;
  options[nextIndex]?.focus();
}

/** Product-native non-workspace state. It never displays host paths or runtime ids. */
export function DesktopConnectionSurface(props: DesktopConnectionSurfaceProps) {
  const [activeWorkspace, setActiveWorkspace] = createSignal<string | null>(
    props.workspaces?.[0] ?? null,
  );
  createEffect(() => {
    const workspaces = props.workspaces ?? [];
    if (workspaces.length === 0) {
      setActiveWorkspace(null);
      return;
    }
    if (!activeWorkspace() || !workspaces.includes(activeWorkspace()!)) {
      setActiveWorkspace(workspaces[0]!);
    }
  });

  const handleChooserKeyDown = (event: KeyboardEvent): void => {
    if (!(event.currentTarget instanceof HTMLElement) || !(event.target instanceof HTMLElement)) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusWorkspaceOption(
        event.currentTarget,
        event.target,
        event.key === "ArrowDown" ? "next" : "previous",
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusWorkspaceOption(
        event.currentTarget,
        event.target,
        event.key === "Home" ? "first" : "last",
      );
    }
  };

  const openingProject = () =>
    props.openProjectPhase === "selecting" ||
    props.openProjectPhase === "opening" ||
    props.openProjectPhase === "waiting";
  const openProjectLabel = () => {
    if (props.openProjectPhase === "selecting") return "Opening project…";
    if (props.openProjectPhase === "opening") return "Opening workspace…";
    if (props.openProjectPhase === "waiting") return "Preparing workspace…";
    return props.state === "chooser" ? "Open another folder" : "Open Folder";
  };

  return (
    <>
      <header class="titlebar runtime-titlebar" data-focus-zone="application-bar">
        <div class="titlebar__brand">
          <DomIcon id="terminals" usage="tab" />
          <strong>tmux-ide</strong>
          <span>workspace</span>
        </div>
        <div class="titlebar__drag titlebar__spacer" />
        <WindowControls
          host={props.host}
          runtime={props.runtime}
          platform={props.platform}
          windowState={props.windowState}
        />
      </header>

      <main
        class="runtime-state-surface"
        data-state={props.state}
        role={props.alert ? "alert" : undefined}
        aria-live={props.alert ? "assertive" : "polite"}
        aria-busy={props.state === "pending" || props.state === "loading" || openingProject()}
      >
        <Switch>
          <Match when={props.state === "pending"}>
            <section class="runtime-launch" aria-labelledby="runtime-state-title">
              <div class="runtime-launch__brand" aria-hidden="true">
                <span>
                  <DomIcon id="terminals" usage="pane" />
                </span>
                <strong>tmux-ide</strong>
              </div>
              <div class="runtime-launch__copy">
                <span class="eyebrow">{props.eyebrow}</span>
                <h1 id="runtime-state-title">{props.title}</h1>
                <p>{props.description}</p>
              </div>
              <div class="runtime-launch__skeleton" aria-hidden="true">
                <i />
                <span />
                <span />
                <span />
              </div>
            </section>
          </Match>
          <Match when={true}>
            <section class="runtime-state-card" aria-labelledby="runtime-state-title">
              <div class="runtime-state-card__main">
                <div class="runtime-state-card__signal" aria-hidden="true">
                  <Icon icon={runtimeStateGlyph(props.state)} size="dense" />
                  <span>{props.state}</span>
                </div>
                <span class="eyebrow">{props.eyebrow}</span>
                <h1 id="runtime-state-title">{props.title}</h1>
                <p>{props.description}</p>

                <Show when={props.workspaces && props.workspaces.length > 0}>
                  <div class="workspace-chooser__heading">
                    <span>Available now</span>
                    <small>{props.workspaces?.length} workspaces</small>
                  </div>
                  <div
                    class="workspace-chooser"
                    role="listbox"
                    aria-label="Available workspaces"
                    onKeyDown={handleChooserKeyDown}
                  >
                    <For each={props.workspaces}>
                      {(workspaceName) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={workspaceName === activeWorkspace()}
                          tabIndex={workspaceName === activeWorkspace() ? 0 : -1}
                          onFocus={() => setActiveWorkspace(workspaceName)}
                          onClick={() => props.onSelectWorkspace?.(workspaceName)}
                        >
                          <span class="workspace-chooser__mark" aria-hidden="true">
                            {workspaceName.slice(0, 2)}
                          </span>
                          <span>
                            <strong>{workspaceName}</strong>
                            <small>Live tmux workspace</small>
                          </span>
                          <DomIcon id="terminals" usage="action" />
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={props.openProjectError}>
                  <div class="runtime-state-card__inline-error" role="alert">
                    <DomIcon id="refresh" usage="action" />
                    <span>{props.openProjectError}</span>
                  </div>
                </Show>

                <Show when={props.command}>
                  {(command) => <RecoveryCommand command={command()} />}
                </Show>

                <Show when={props.onOpenProject || props.onRetry || props.onRestartConnection}>
                  <div class="runtime-state-card__actions">
                    <Show when={props.onOpenProject}>
                      <Button
                        variant="primary"
                        loading={openingProject()}
                        onClick={() => props.onOpenProject?.()}
                      >
                        {openProjectLabel()}
                      </Button>
                    </Show>
                    <Show when={props.onRetry}>
                      <Button
                        variant={props.onOpenProject ? "secondary" : "primary"}
                        onClick={() => props.onRetry?.()}
                      >
                        {props.retryLabel ?? "Try again"}
                      </Button>
                    </Show>
                    <Show when={props.onRestartConnection}>
                      <Button variant="secondary" onClick={() => props.onRestartConnection?.()}>
                        Restart connection
                      </Button>
                    </Show>
                  </div>
                </Show>

                <Show when={props.diagnostics && props.diagnostics.length > 0}>
                  <details class="runtime-diagnostics">
                    <summary>
                      <Icon icon={ArrowRight01Icon} size="dense" />
                      Connection details
                    </summary>
                    <ul>
                      <For each={props.diagnostics}>{(item) => <li>{item}</li>}</For>
                    </ul>
                  </details>
                </Show>
              </div>

              <Show when={props.state === "onboarding"}>
                <aside class="runtime-onboarding-notes" aria-label="Config-free workspace setup">
                  <span class="runtime-onboarding-notes__icon">
                    <DomIcon id="native" usage="pane" />
                  </span>
                  <strong>Start from the folder you already have</strong>
                  <p>
                    tmux-ide opens a native tmux workspace, detects the project context, and keeps
                    agent terminals attached to the real session.
                  </p>
                  {/*
                   * Each bullet's copy is ONE grid item. The list is a two-column
                   * grid (dot, text); an inline <code> in the middle of a bare text
                   * run split this bullet into three items, so "ide.yml" was placed
                   * into the 8px dot column and "required" onto the next row — the
                   * line painted on top of itself.
                   */}
                  <ul>
                    <li>
                      <Icon icon={CheckmarkCircle02Icon} size="dense" />
                      <span>
                        No <code>ide.yml</code> required
                      </span>
                    </li>
                    <li>
                      <Icon icon={CheckmarkCircle02Icon} size="dense" />
                      <span>Available harnesses are discovered after opening</span>
                    </li>
                    <li>
                      <Icon icon={CheckmarkCircle02Icon} size="dense" />
                      <span>Your tmux session stays the source of truth</span>
                    </li>
                  </ul>
                  <details>
                    <summary>
                      <Icon icon={ArrowRight01Icon} size="dense" />
                      Advanced configuration
                    </summary>
                    <p>
                      Add <code>.tmux-ide/workspace.yml</code> later only when you want a saved
                      layout, custom commands, or project theme overrides.
                    </p>
                  </details>
                </aside>
              </Show>
            </section>
          </Match>
        </Switch>
      </main>

      <footer class="status-strip runtime-status-strip" role="status">
        <span class="status-strip__connection" data-state={props.state}>
          <i />
          <span>{props.description}</span>
        </span>
        <span class="status-strip__guidance">{props.guidance}</span>
      </footer>
    </>
  );
}

function catalogReason(state: DesktopWorkspaceCatalogState): string | null {
  if (state.status === "stale" || state.status === "degraded" || state.status === "error") {
    return state.reason;
  }
  return null;
}

function daemonCapabilityKey(state: DesktopDaemonCapabilityState): string {
  if (state.status !== "connected")
    return `${state.status}\u0000${state.code}\u0000${state.reason}`;
  const identity = state.identity;
  return [
    state.status,
    identity.protocolVersion,
    identity.productVersion,
    identity.instanceId,
    identity.startedAt,
  ].join("\u0000");
}

function ResourceNotice(props: {
  readonly tone: "stale" | "degraded";
  readonly label: string;
  readonly reason: string;
}) {
  return (
    <div class="runtime-resource-notice" data-tone={props.tone} role="status" aria-live="polite">
      <i aria-hidden="true" />
      <strong>{props.label}</strong>
      <span>{props.reason}</span>
    </div>
  );
}

interface LiveWorkspaceProps extends Omit<DesktopLiveApplicationProps, "daemon"> {
  readonly target: {
    readonly daemon: DaemonInstanceIdentity;
    readonly workspaceName: string;
  };
  readonly catalogState: DesktopWorkspaceCatalogState;
}

export type LiveWorkspaceProjection =
  | {
      readonly status: "ready";
      readonly input: ApplicationShellProjectionInputV1;
      readonly terminalPanes: readonly ApplicationShellTerminalPaneFrame[];
    }
  | { readonly status: "rejected" };

function assertUniqueSemanticIds(label: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Live workspace ${label} identities are incoherent.`);
  }
}

/**
 * The agent-graph overlay is a NON-durable, additive projection. A malformed
 * overlay must never blank the whole workspace, so it is validated in isolation
 * at the read boundary: if it fails, only the overlay is dropped and the shell
 * read continues. A valid or absent overlay is returned untouched.
 */
export function sanitizeAgentGraphOverlay(
  input: ApplicationShellProjectionInputV1,
): ApplicationShellProjectionInputV1 {
  if (!("agentGraphOverlay" in input)) return input;
  const candidate = (input as { readonly agentGraphOverlay?: unknown }).agentGraphOverlay;
  if (candidate === undefined || AgentGraphOverlaySchemaZ.safeParse(candidate).success) {
    return input;
  }
  const rest: Record<string, unknown> = { ...input };
  delete rest.agentGraphOverlay;
  return rest as unknown as ApplicationShellProjectionInputV1;
}

/** Strict rendering boundary. Failures are intentionally sanitized by the caller. */
export function projectLiveWorkspace(
  input: ApplicationShellProjectionInputV1,
): LiveWorkspaceProjection {
  try {
    const shell = projectApplicationShellV1(input);
    const sessionIds = shell.sidebar.sessions.map(({ id }) => id);
    const agentIds = shell.sidebar.agents.map(({ id }) => id);
    assertUniqueSemanticIds("session", sessionIds);
    assertUniqueSemanticIds("agent", agentIds);
    assertUniqueSemanticIds("sidebar resource", [...sessionIds, ...agentIds]);
    if (!sessionIds.includes(shell.sidebar.activeSessionId)) {
      throw new Error("Live workspace active session identity is incoherent.");
    }
    const terminalPanes = paneFrameTerminalsFromApplicationShellInventory(shell);
    assertUniqueSemanticIds(
      "terminal resource",
      terminalPanes.map(({ model }) => model.pane.id),
    );
    return { status: "ready", input: sanitizeAgentGraphOverlay(input), terminalPanes };
  } catch {
    return { status: "rejected" };
  }
}

function resourceData(state: DesktopApplicationShellResourceState) {
  return "data" in state ? state.data : null;
}

function resourceReason(state: DesktopApplicationShellResourceState): string {
  return "reason" in state ? state.reason : "Reading the live semantic workspace from tmux-ide.";
}

function recoveryPresentation(phase: DesktopDaemonRecoveryPhase): {
  readonly title: string;
  readonly description: string;
  readonly guidance: string;
} {
  if (phase === "refreshing") {
    return {
      title: "Revalidating the daemon",
      description: "The desktop host is checking the canonical daemon authority.",
      guidance: "The current workspace generation is retired",
    };
  }
  if (phase === "unchanged") {
    return {
      title: "The daemon generation is unchanged",
      description: "The workspace stream could not be re-established against this generation.",
      guidance: "Restart tmux-ide or verify the daemon, then try again",
    };
  }
  if (phase === "superseded") {
    return {
      title: "Daemon recovery was superseded",
      description: "A newer desktop authority operation replaced this recovery attempt.",
      guidance: "Try again to read the current daemon authority",
    };
  }
  if (phase === "failed") {
    return {
      title: "Daemon verification failed",
      description: "The desktop host could not complete canonical daemon verification.",
      guidance: "Check tmux-ide, then try the verified connection again",
    };
  }
  return {
    title: "The workspace generation changed",
    description: "The live resource no longer matches the verified daemon authority.",
    guidance: "Start verified daemon recovery",
  };
}

function LiveWorkspace(props: LiveWorkspaceProps) {
  const [acknowledgedOperationIds, setAcknowledgedOperationIds] = createSignal<readonly string[]>(
    [],
  );
  const [interactionFeed, setInteractionFeed] = createSignal<InteractionFeedState>(
    initialInteractionFeedState(),
    { equals: false },
  );
  const store = createSolidDesktopApplicationShellResourceStore({
    target: props.target,
    transport: createHostDaemonTransport(props.host),
    onOperationAcknowledged: ({ operationId }) => {
      setAcknowledgedOperationIds((current) =>
        current.includes(operationId) ? current : [...current.slice(-63), operationId],
      );
    },
    onInteractionReceipt: (receipt) => {
      setInteractionFeed((current) => reduceInteractionReceipt(current, receipt));
    },
  });
  createEffect(() => store.setTarget(props.target));

  // Live Files and Changes read stores, pinned to the same daemon generation as
  // the shell resource. Expansion and selection are renderer-owned; each store
  // parses responses at the boundary and drops stale-generation reads.
  const filesCatalog = createSolidWorkspaceFilesCatalogStore({
    host: props.host,
    target: props.target,
    active: false,
  });
  const filePreview = createSolidWorkspaceFilePreviewStore({
    host: props.host,
    target: props.target,
    active: false,
  });
  const changesCatalog = createSolidWorkspaceChangesCatalogStore({
    host: props.host,
    target: props.target,
    active: false,
  });
  const changeDiff = createSolidWorkspaceChangeDiffStore({
    host: props.host,
    target: props.target,
    active: false,
  });
  const missions = createSolidWorkspaceMissionsStore({
    host: props.host,
    target: props.target,
    active: false,
  });
  const resourceTelemetry = createGuiResourceTelemetry([
    store,
    filesCatalog,
    filePreview,
    changesCatalog,
    changeDiff,
    missions,
  ]);
  resourceTelemetry.recordCompositionMount();
  let pendingRenderFrame: number | null = null;
  createEffect(() => {
    // The primary projection is the GUI's render authority. Coalesce any
    // synchronous publication burst into one browser render opportunity; no
    // timer or animation frame exists while the projection is idle.
    store.state();
    if (pendingRenderFrame !== null || typeof requestAnimationFrame !== "function") return;
    pendingRenderFrame = requestAnimationFrame(() => {
      pendingRenderFrame = null;
      resourceTelemetry.recordRenderPass();
    });
  });
  onCleanup(() => {
    if (pendingRenderFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingRenderFrame);
    }
    pendingRenderFrame = null;
  });
  onCleanup(resourceTelemetry.exposeDebugAccessor());
  const activateDockResource = (demand: {
    readonly tool: string;
    readonly active: boolean;
  }): void => {
    const filesActive = demand.active && demand.tool === "files";
    const changesActive = demand.active && demand.tool === "changes";
    const missionsActive =
      demand.active && (demand.tool === "missions" || demand.tool === "activity");
    filesCatalog.setActive(filesActive);
    filePreview.setActive(filesActive);
    changesCatalog.setActive(changesActive);
    changeDiff.setActive(changesActive);
    missions.setActive(missionsActive);
  };
  const inputWithLazyMissions = (input: ApplicationShellProjectionInputV1) => {
    const missionState = missions.state();
    if (missionState.status !== "loaded" || !("appWindows" in input)) return input;
    return {
      ...input,
      missionWorkspace: missionState.resource.missionWorkspace,
      ...(missionState.resource.agentGraphOverlay
        ? { agentGraphOverlay: missionState.resource.agentGraphOverlay }
        : {}),
    };
  };
  const [filesExpandedIds, setFilesExpandedIds] = createSignal<
    ReadonlySet<WorkspaceFileResourceId>
  >(new Set<WorkspaceFileResourceId>());
  const [filesSelectedId, setFilesSelectedId] = createSignal<WorkspaceFileResourceId | null>(null);
  const [changesSelectedId, setChangesSelectedId] = createSignal<WorkspaceChangeResourceId | null>(
    null,
  );
  let workspaceSurfaceKey = "";
  createEffect(() => {
    const target = props.target;
    filesCatalog.setTarget(target);
    filePreview.setTarget(target);
    changesCatalog.setTarget(target);
    changeDiff.setTarget(target);
    missions.setTarget(target);
    const key = [target.daemon.instanceId, target.daemon.startedAt, target.workspaceName].join(
      "\u0000",
    );
    if (key === workspaceSurfaceKey) return;
    setInteractionFeed(initialInteractionFeedState());
    // A new workspace generation retires renderer-owned expansion and selection.
    workspaceSurfaceKey = key;
    setFilesExpandedIds(new Set<WorkspaceFileResourceId>());
    setFilesSelectedId(null);
    setChangesSelectedId(null);
  });

  const fileEntriesById = createMemo(() => collectFileCatalogs(filesCatalog.state()).entriesById);

  // A directory whose incremental load failed must not spin forever: drop it and
  // collapse it so the row returns to an openable, honest collapsed state.
  createEffect(() => {
    const directories = filesCatalog.state().directories;
    const expanded = filesExpandedIds();
    const failed: WorkspaceFileResourceId[] = [];
    for (const [id, slot] of directories) {
      if (!expanded.has(id)) continue;
      if (
        slot.status === "error" ||
        (slot.status === "loaded" && slot.resource.status !== "ready")
      ) {
        failed.push(id);
      }
    }
    if (failed.length === 0) return;
    const next = new Set(expanded);
    for (const id of failed) {
      next.delete(id);
      filesCatalog.dropDirectory(id);
    }
    setFilesExpandedIds(next);
  });

  const filesSurface = createMemo<FilesSurfaceProps>(() => ({
    model: filesSurfaceModel(
      filesCatalog.state(),
      props.target.workspaceName,
      filesExpandedIds(),
      filesSelectedId(),
    ),
    preview: filePreviewSurfaceModel(filePreview.state(), fileEntriesById()),
    onSelectFile: (id) => {
      setFilesSelectedId(id);
      if (fileEntriesById().get(id)?.kind === "file") filePreview.load(id);
    },
    onToggleDirectory: (id, next) => {
      const current = new Set(filesExpandedIds());
      if (next) {
        current.add(id);
        filesCatalog.loadDirectory(id);
      } else {
        current.delete(id);
        filesCatalog.dropDirectory(id);
      }
      setFilesExpandedIds(current);
    },
    onRetry: () => filesCatalog.refresh(),
    onRetryPreview: () => {
      const id = filesSelectedId();
      if (id && fileEntriesById().get(id)?.kind === "file") filePreview.load(id);
    },
  }));

  const changesSurface = createMemo<ChangesSurfaceProps>(() => ({
    model: changesSurfaceModel(changesCatalog.state(), changesSelectedId()),
    diff: changeDiffSurfaceModel(changeDiff.state(), changeEntriesById(changesCatalog.state())),
    onSelectChange: (id) => {
      setChangesSelectedId(id);
      changeDiff.load(id);
    },
    onRetry: () => changesCatalog.refresh(),
    onRetryDiff: () => {
      const id = changesSelectedId();
      if (id) changeDiff.load(id);
    },
  }));

  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [appWindowMutationAvailable, setAppWindowMutationAvailable] = createSignal(false);
  const [appWindowMutationUnavailableReason, setAppWindowMutationUnavailableReason] = createSignal(
    "Checking durable window controls…",
  );
  let mutationTail: Promise<void> = Promise.resolve();
  let capabilityGeneration = 0;
  let disposed = false;
  createEffect(() => {
    const daemon = { ...props.target.daemon };
    const generation = ++capabilityGeneration;
    setAppWindowMutationAvailable(false);
    setAppWindowMutationUnavailableReason("Checking durable window controls…");
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await props.host.daemon.capabilities();
          if (disposed || generation !== capabilityGeneration) return;
          if (
            result.status === "ok" &&
            result.daemon.protocolVersion === daemon.protocolVersion &&
            result.daemon.productVersion === daemon.productVersion &&
            result.daemon.instanceId === daemon.instanceId &&
            result.daemon.startedAt === daemon.startedAt
          ) {
            setAppWindowMutationAvailable(result.capabilities.appWindowMutation.available);
            setAppWindowMutationUnavailableReason(
              result.capabilities.appWindowMutation.available
                ? ""
                : result.capabilities.appWindowMutation.reason,
            );
            return;
          }
        } catch {
          // One bounded retry covers a transient IPC/broker handoff.
        }
      }
      if (!disposed && generation === capabilityGeneration) {
        setAppWindowMutationUnavailableReason(
          "Durable window controls are unavailable. Reopen the workspace to recheck.",
        );
      }
    })();
  });

  const createPaneCatalogs = createMemo<CreatePaneFlowCatalogs>(() => {
    const snapshot = props.catalogState.snapshot;
    return {
      workspaces: snapshot
        ? {
            status: "ready",
            items: snapshot.workspaces.map(({ workspaceName }) => ({
              name: workspaceName,
              label: workspaceName,
              available: workspaceName === props.target.workspaceName,
            })),
          }
        : props.catalogState.status === "loading"
          ? { status: "loading" }
          : { status: "unavailable" },
      // These catalogs do not yet exist as reviewed host resources. Keep the
      // agent affordance visible but honestly unavailable until that card lands.
      harnessProfiles: { status: "unavailable" },
      missions: { status: "unavailable" },
    };
  });

  let pendingRefresh: {
    readonly semanticPaneId: string;
    readonly daemonInstanceId: string;
    readonly workspaceName: string;
    readonly initialState: DesktopApplicationShellResourceState;
    readonly resolve: () => void;
    readonly reject: () => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const settlePendingRefresh = (outcome: "resolve" | "reject"): void => {
    const pending = pendingRefresh;
    if (!pending) return;
    pendingRefresh = null;
    clearTimeout(pending.timer);
    pending[outcome]();
  };

  createEffect(() => {
    const state = store.state();
    const pending = pendingRefresh;
    if (!pending || state === pending.initialState) return;
    if (
      props.target.daemon.instanceId !== pending.daemonInstanceId ||
      props.target.workspaceName !== pending.workspaceName
    ) {
      settlePendingRefresh("reject");
      return;
    }
    const data = resourceData(state);
    if (data?.terminalInventory?.resources.some(({ id }) => id === pending.semanticPaneId)) {
      settlePendingRefresh("resolve");
      return;
    }
    if (state.status === "error" || state.status === "degraded") {
      settlePendingRefresh("reject");
    }
  });

  onCleanup(() => {
    disposed = true;
    settlePendingRefresh("reject");
  });

  const createWorkspacePane = async (invocation: WorkspacePaneCreateInvocation): Promise<void> => {
    if (
      disposed ||
      pendingRefresh ||
      invocation.args.workspaceName !== props.target.workspaceName
    ) {
      throw new Error("The selected workspace is not available for terminal creation.");
    }
    const result = WorkspacePaneCreateHostResultSchemaZ.parse(
      await props.host.daemon.createWorkspacePane(invocation),
    );
    if (disposed) throw new Error("The active workspace changed during terminal creation.");
    if (result.status === "error") {
      if (result.error.code === "daemon-identity-mismatch") props.onDaemonIdentityMismatch?.();
      throw new Error(result.error.reason);
    }
    if (
      result.result.daemonInstanceId !== props.target.daemon.instanceId ||
      result.result.resource.workspaceName !== props.target.workspaceName ||
      result.result.resource.kind !== invocation.args.kind
    ) {
      props.onDaemonIdentityMismatch?.();
      throw new Error("The created terminal does not belong to the active workspace generation.");
    }

    await new Promise<void>((resolve, reject) => {
      pendingRefresh = {
        semanticPaneId: result.result.resource.semanticPaneId,
        daemonInstanceId: props.target.daemon.instanceId,
        workspaceName: props.target.workspaceName,
        initialState: store.state(),
        resolve,
        reject: () => reject(new Error("The authoritative terminal inventory did not refresh.")),
        timer: setTimeout(() => settlePendingRefresh("reject"), 8_000),
      };
      // Force a read in addition to the daemon event invalidation; the dialog
      // closes only after that authoritative inventory contains the new pane.
      store.refresh();
    });
  };

  const input = createMemo(() => resourceData(store.state()));
  const projection = createMemo<LiveWorkspaceProjection | null>(() => {
    const snapshot = input();
    return snapshot ? projectLiveWorkspace(snapshot) : null;
  });

  const waitForAppWindowRevision = async (revision: number): Promise<void> => {
    const deadline = Date.now() + 8_000;
    while (!disposed && Date.now() < deadline) {
      const parsed = ApplicationShellProjectionInputV3SchemaZ.safeParse(input());
      if (parsed.success && parsed.data.appWindows.revision >= revision) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The authoritative window layout did not refresh.");
  };

  const mutateAppWindow = (invocation: AppWindowCanvasCommandInvocation): Promise<void> => {
    const operation = mutationTail.then(async () => {
      if (disposed) throw new Error("The active workspace changed during window mutation.");
      let current = ApplicationShellProjectionInputV3SchemaZ.safeParse(input());
      if (!current.success) throw new Error("The live window layout is unavailable.");
      let attemptedRevision = current.data.appWindows.revision;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          attemptedRevision = current.data.appWindows.revision;
          const result = AppWindowMutationHostResultSchemaZ.parse(
            await props.host.daemon.mutateAppWindow({
              workspaceName: props.target.workspaceName,
              expectedDocumentRevision: attemptedRevision,
              command: invocation.command,
            }),
          );
          if (result.status === "error") {
            if (result.error.code === "daemon-identity-mismatch") {
              props.onDaemonIdentityMismatch?.();
            }
            if (result.error.code !== "resource-changed" || attempt > 0) {
              throw new Error(result.error.reason);
            }
            store.refresh();
            await waitForAppWindowRevision(attemptedRevision + 1);
            current = ApplicationShellProjectionInputV3SchemaZ.safeParse(input());
            if (!current.success) throw new Error("The refreshed window layout is unavailable.");
            continue;
          }
          if (
            result.result.daemonInstanceId !== props.target.daemon.instanceId ||
            result.result.workspaceName !== props.target.workspaceName
          ) {
            props.onDaemonIdentityMismatch?.();
            throw new Error("The window layout belongs to a different workspace generation.");
          }
          store.refresh();
          await waitForAppWindowRevision(result.result.documentRevision);
          setMutationError(null);
          return;
        }
      } catch (error) {
        // A conflict means our V3 revision is stale. Refresh before releasing
        // the serialized mutation queue so the next gesture can retry once.
        store.refresh();
        const deadline = Date.now() + 2_000;
        while (!disposed && Date.now() < deadline) {
          const refreshed = ApplicationShellProjectionInputV3SchemaZ.safeParse(input());
          if (refreshed.success && refreshed.data.appWindows.revision !== attemptedRevision) {
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        throw error;
      }
    });
    mutationTail = operation.catch((error: unknown) => {
      setMutationError(error instanceof Error ? error.message : "Window mutation failed.");
    });
    return operation;
  };

  let mismatchGeneration = -1;
  createEffect(() => {
    const state = store.state();
    if (
      state.status === "degraded" &&
      state.code === "daemon-identity-mismatch" &&
      state.generation !== mismatchGeneration
    ) {
      mismatchGeneration = state.generation;
      props.onDaemonIdentityMismatch?.();
    }
  });
  // The one derived compound connection shape: transport health from the
  // main-process supervisor (pushed through the store) crossed with the last
  // sync result. A failed read on a healthy socket reads "connected, sync
  // degraded"; a supervisor retry shows its real attempt position.
  const connectionHealth = createMemo(() => {
    const resource = store.state();
    const transport = resource.transport ?? null;
    const syncHealthy = resource.status === "live" || resource.status === "loading";
    return deriveConnectionHealth(
      transport,
      syncHealthy ? { ok: true } : { ok: false, reason: resourceReason(resource) },
    );
  });

  /**
   * The daemon's own readiness ladder, read while the daemon is CONNECTED and
   * this workspace is not.
   *
   * The ladder already reaches the disconnected screens: it rides on the
   * capability state the host composes when it cannot reach a daemon at all.
   * This is the other half. A connected daemon that cannot serve a workspace is
   * exactly the case where the two rungs only the daemon can answer —
   * `credential-held` and `attachment-issuable` — are the whole diagnosis, and
   * until now this surface said only that the workspace was unavailable.
   *
   * Diagnostics: an unreadable ladder simply adds no lines.
   */
  const [daemonLadder, setDaemonLadder] = createSignal<StartupReadinessLadder | null>(null);
  let ladderRead = 0;
  createEffect(() => {
    const status = store.state().status;
    if (status !== "degraded" && status !== "error") return;
    const read = ++ladderRead;
    void props.host.daemon
      .startupReadiness()
      .then((result) => {
        if (read !== ladderRead) return;
        setDaemonLadder(result.status === "ok" ? result.ladder : null);
      })
      .catch(() => {
        if (read === ladderRead) setDaemonLadder(null);
      });
  });

  const notice = createMemo(() => {
    const resource = store.state();
    if (resource.status === "stale") {
      return {
        tone: "stale" as const,
        label: "Showing last live workspace",
        reason: resource.reason,
      };
    }
    if (resource.status === "degraded" && resource.data !== null) {
      return {
        tone: "degraded" as const,
        label: "Workspace connection degraded",
        reason: resource.reason,
      };
    }
    if (mutationError()) {
      return {
        tone: "degraded" as const,
        label: "Window layout was not saved",
        reason: mutationError() ?? "Try the window action again.",
      };
    }
    const reason = catalogReason(props.catalogState);
    return reason
      ? { tone: "stale" as const, label: "Workspace catalog is recovering", reason }
      : null;
  });

  /** The stuck rung the daemon itself reports, or nothing when none was read. */
  const startupReadinessLines = (): readonly string[] => {
    const ladder = daemonLadder();
    if (!ladder) return [];
    return startupReadinessDiagnostics(
      projectDesktopStartupReadiness({
        daemon: { status: "connected", identity: props.target.daemon },
        ladder,
        observedAt: new Date().toISOString(),
      }),
    );
  };

  const renderFallback = () => {
    const projected = projection();
    if (projected?.status === "rejected") {
      return (
        <DesktopConnectionSurface
          host={props.host}
          runtime={props.runtime}
          platform={props.platform}
          windowState={props.windowState}
          state="degraded"
          eyebrow="Native tmux workspace"
          title="Workspace data could not be displayed"
          description="tmux-ide rejected an incoherent semantic workspace update."
          guidance="No preview or partial workspace data is shown"
          onRetry={() => store.refresh()}
          retryLabel="Reload workspace"
          onRestartConnection={props.onRetryDaemonConnection}
          diagnostics={[
            "The V3 workspace resource failed semantic projection.",
            "The previous workspace was not mounted as a fallback.",
          ]}
        />
      );
    }
    const resource = store.state();
    const identityMismatch =
      resource.status === "degraded" && resource.code === "daemon-identity-mismatch";
    const recovery = recoveryPresentation(props.daemonRecovery ?? "idle");
    return (
      <DesktopConnectionSurface
        host={props.host}
        runtime={props.runtime}
        platform={props.platform}
        windowState={props.windowState}
        state={
          resource.status === "loading"
            ? "loading"
            : resource.status === "error"
              ? "error"
              : "degraded"
        }
        eyebrow="Native tmux workspace"
        title={
          resource.status === "loading"
            ? "Loading the workspace"
            : identityMismatch
              ? recovery.title
              : "The workspace is unavailable"
        }
        description={identityMismatch ? recovery.description : resourceReason(resource)}
        guidance={identityMismatch ? recovery.guidance : "tmux remains the source of truth"}
        alert={resource.status === "error"}
        diagnostics={[
          identityMismatch ? recovery.description : resourceReason(resource),
          `Resource state: ${resource.status}`,
          ...startupReadinessLines(),
          "The desktop shell remains gated until a valid V3 resource is available.",
        ]}
        onRetry={
          identityMismatch
            ? props.daemonRecovery === "refreshing"
              ? undefined
              : props.onRetryDaemonConnection
            : () => store.refresh()
        }
        retryLabel={identityMismatch ? "Recheck daemon" : "Reload workspace"}
        onRestartConnection={
          !identityMismatch && resource.status === "error"
            ? props.onRetryDaemonConnection
            : undefined
        }
      />
    );
  };

  const readyProjection = createMemo(() => {
    const projected = projection();
    return projected?.status === "ready" ? projected : null;
  });

  return (
    <Show when={readyProjection()} fallback={renderFallback()}>
      {(ready) => (
        <>
          <DomApplicationShell
            host={props.host}
            daemonState={{ status: "connected", identity: props.target.daemon }}
            runtime={props.runtime}
            platform={props.platform}
            windowState={props.windowState}
            input={inputWithLazyMissions(ready().input)}
            dataMode="runtime"
            terminalWorkspaceName={props.target.workspaceName}
            terminalTransport={props.terminalTransport}
            reducedMotion={props.reducedMotion}
            terminalThemeKey={props.terminalThemeKey}
            onCommand={props.onCommand}
            acknowledgedOperationIds={acknowledgedOperationIds()}
            interactionFeed={interactionFeed()}
            terminalPanes={ready().terminalPanes}
            createPaneFlow={{
              catalogs: createPaneCatalogs(),
              initialWorkspaceName: props.target.workspaceName,
              initialSemanticPaneId: ready().input.focus.appFocusedPaneId,
              initialPaneLabel:
                ready().terminalPanes.find(
                  (pane) =>
                    pane.terminalTarget?.semanticPaneId === ready().input.focus.appFocusedPaneId,
                )?.model.title ?? "Beside active pane",
              onCommand: createWorkspacePane,
            }}
            onPaneAction={props.onPaneAction}
            onPaneGrip={props.onPaneGrip}
            onAppWindowCommand={
              props.onAppWindowCommand ??
              (appWindowMutationAvailable() ? mutateAppWindow : undefined)
            }
            appWindowMutationUnavailableReason={appWindowMutationUnavailableReason()}
            connectionHealth={connectionHealth()}
            onRefreshResource={() =>
              missions.state().status === "inactive" ? store.refresh() : missions.refresh()
            }
            filesSurface={filesSurface()}
            changesSurface={changesSurface()}
            onActiveDockToolChange={activateDockResource}
          />
          <Show when={notice()}>
            {(current) => (
              <ResourceNotice
                tone={current().tone}
                label={current().label}
                reason={current().reason}
              />
            )}
          </Show>
          <Show when={props.introPending}>
            <FirstRunIntro
              platform={props.platform}
              onDismiss={() => props.onAcknowledgeIntro?.()}
            />
          </Show>
        </>
      )}
    </Show>
  );
}

/**
 * Electron-only semantic composition. All daemon I/O stays behind the injected
 * host facade; this component owns neither URLs, sockets, terminal bytes nor tmux ids.
 */
export function DesktopLiveApplication(props: DesktopLiveApplicationProps) {
  const catalog = createSolidDesktopWorkspaceCatalogStore({
    host: props.host,
    daemon: props.daemon,
  });
  const [openProjectPhase, setOpenProjectPhase] = createSignal<
    "idle" | "selecting" | "opening" | "waiting" | "error"
  >("idle");
  const [openProjectError, setOpenProjectError] = createSignal<string | null>(null);
  const [openProjectCommand, setOpenProjectCommand] = createSignal<string | null>(null);
  const [pendingWorkspaceName, setPendingWorkspaceName] = createSignal<string | null>(null);
  let openProjectRequest = 0;
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDiscoveryTimer = (): void => {
    if (discoveryTimer !== null) clearTimeout(discoveryTimer);
    discoveryTimer = null;
  };

  const waitForOpenedWorkspace = (workspaceName: string): void => {
    clearDiscoveryTimer();
    setPendingWorkspaceName(workspaceName);
    setOpenProjectPhase("waiting");
    catalog.refresh();
    discoveryTimer = setTimeout(() => {
      if (pendingWorkspaceName() !== workspaceName) return;
      setOpenProjectError(
        "The workspace opened, but discovery is still catching up. Retry discovery without reopening the folder.",
      );
      setOpenProjectPhase("error");
    }, 8_000);
  };

  const openProject = async (): Promise<void> => {
    if (openProjectPhase() === "selecting" || openProjectPhase() === "opening") return;
    const request = ++openProjectRequest;
    clearDiscoveryTimer();
    setOpenProjectError(null);
    setOpenProjectCommand(null);
    setOpenProjectPhase("selecting");
    try {
      const result = await props.host.workspace.openProjectDirectory();
      if (request !== openProjectRequest) return;
      if (!result) {
        setOpenProjectPhase("idle");
        return;
      }
      if (result.status === "error") {
        const recovery = recoveryForWorkspaceOpenError(result.error, props.platform);
        setOpenProjectError(recovery.description);
        setOpenProjectCommand(recovery.command);
        setOpenProjectPhase("error");
        return;
      }
      waitForOpenedWorkspace(result.result.resource.workspaceName);
    } catch {
      if (request !== openProjectRequest) return;
      setOpenProjectError("tmux-ide could not open that folder through the verified daemon.");
      setOpenProjectPhase("error");
    }
  };

  const retryDiscovery = (): void => {
    const workspaceName = pendingWorkspaceName();
    if (!workspaceName) return;
    setOpenProjectError(null);
    setOpenProjectCommand(null);
    waitForOpenedWorkspace(workspaceName);
  };

  onCleanup(() => {
    openProjectRequest += 1;
    clearDiscoveryTimer();
  });
  // The constructor already owns the initial daemon. Only a genuinely new
  // capability generation should retire catalog work and start another read.
  let activeDaemonKey = daemonCapabilityKey(props.daemon);
  createEffect(() => {
    const nextDaemon = props.daemon;
    const nextKey = daemonCapabilityKey(nextDaemon);
    if (nextKey === activeDaemonKey) return;
    activeDaemonKey = nextKey;
    catalog.setDaemon(nextDaemon);
  });

  let mismatchGeneration = -1;
  createEffect(() => {
    const state = catalog.state();
    if (
      state.status === "degraded" &&
      state.code === "daemon-identity-mismatch" &&
      state.generation !== mismatchGeneration
    ) {
      mismatchGeneration = state.generation;
      props.onDaemonIdentityMismatch?.();
    }
  });

  const selectedTarget = createMemo(() => {
    const state = catalog.state();
    const selection = state.snapshot?.selection;
    if (!state.daemon || selection?.view !== "workspace") return null;
    return { daemon: state.daemon, workspaceName: selection.workspaceName };
  });

  createEffect(() => {
    const workspaceName = pendingWorkspaceName();
    const snapshot = catalog.state().snapshot;
    if (
      !workspaceName ||
      !snapshot?.workspaces.some((workspace) => workspace.workspaceName === workspaceName)
    ) {
      return;
    }
    if (!catalog.select(workspaceName)) return;
    clearDiscoveryTimer();
    setPendingWorkspaceName(null);
    setOpenProjectError(null);
    setOpenProjectCommand(null);
    setOpenProjectPhase("idle");
  });

  const fallback = () => {
    const state = catalog.state();
    const selection = state.snapshot?.selection;
    if (selection?.view === "onboarding") {
      return (
        <DesktopConnectionSurface
          host={props.host}
          runtime={props.runtime}
          platform={props.platform}
          windowState={props.windowState}
          state="onboarding"
          eyebrow="Workspace discovery"
          title="Open a project to begin"
          description="Choose any project folder. tmux-ide will create or reopen its config-free native workspace."
          guidance="No ide.yml required"
          onOpenProject={() => void openProject()}
          openProjectPhase={openProjectPhase()}
          openProjectError={openProjectError()}
          command={openProjectCommand()}
          onRetry={pendingWorkspaceName() ? retryDiscovery : undefined}
          retryLabel="Retry discovery"
        />
      );
    }
    if (selection?.view === "chooser" && state.snapshot) {
      return (
        <DesktopConnectionSurface
          host={props.host}
          runtime={props.runtime}
          platform={props.platform}
          windowState={props.windowState}
          state="chooser"
          eyebrow="Live tmux workspaces"
          title="Choose a workspace"
          description="Multiple workspaces are available. tmux-ide never picks one arbitrarily."
          guidance="Arrow keys move · Enter opens"
          workspaces={state.snapshot.workspaces.map(({ workspaceName }) => workspaceName)}
          onSelectWorkspace={(workspaceName) => catalog.select(workspaceName)}
          onOpenProject={() => void openProject()}
          openProjectPhase={openProjectPhase()}
          openProjectError={openProjectError()}
          command={openProjectCommand()}
          onRetry={pendingWorkspaceName() ? retryDiscovery : undefined}
          retryLabel="Retry discovery"
        />
      );
    }
    const identityMismatch =
      state.status === "degraded" && state.code === "daemon-identity-mismatch";
    const recovery = recoveryPresentation(props.daemonRecovery ?? "idle");
    const catalogReasonText = "reason" in state ? state.reason : null;
    const missingTmuxCommand =
      !identityMismatch && catalogReasonText && reasonIndicatesMissingTmux(catalogReasonText)
        ? tmuxInstallCommand(props.platform)
        : null;
    const surfaceState =
      state.status === "loading"
        ? "loading"
        : state.status === "error" || state.status === "disposed"
          ? "error"
          : "degraded";
    return (
      <DesktopConnectionSurface
        host={props.host}
        runtime={props.runtime}
        platform={props.platform}
        windowState={props.windowState}
        state={surfaceState}
        command={missingTmuxCommand}
        eyebrow="Native tmux workspace"
        title={
          state.status === "loading"
            ? "Finding your workspaces"
            : identityMismatch
              ? recovery.title
              : "Workspace connection needs attention"
        }
        description={
          identityMismatch
            ? recovery.description
            : "reason" in state
              ? state.reason
              : "Reading the live workspace catalog from tmux-ide."
        }
        guidance={identityMismatch ? recovery.guidance : "tmux remains the source of truth"}
        alert={state.status === "error"}
        diagnostics={[
          identityMismatch
            ? recovery.description
            : "reason" in state
              ? state.reason
              : "Catalog unavailable.",
          `Recovery phase: ${props.daemonRecovery ?? "idle"}`,
          "The renderer has not received a usable V3 workspace resource.",
        ]}
        onRetry={
          state.status === "loading"
            ? undefined
            : identityMismatch
              ? props.daemonRecovery === "refreshing"
                ? undefined
                : props.onRetryDaemonConnection
              : () => catalog.refresh()
        }
        retryLabel="Retry workspace"
        onRestartConnection={
          props.daemonRecovery === "refreshing" ? undefined : props.onRetryDaemonConnection
        }
      />
    );
  };

  return (
    <Show when={selectedTarget()} fallback={fallback()}>
      {(target) => (
        <LiveWorkspace
          host={props.host}
          target={target()}
          catalogState={catalog.state()}
          runtime={props.runtime}
          platform={props.platform}
          windowState={props.windowState}
          terminalTransport={props.terminalTransport}
          reducedMotion={props.reducedMotion}
          terminalThemeKey={props.terminalThemeKey}
          onCommand={props.onCommand}
          onPaneAction={props.onPaneAction}
          onPaneGrip={props.onPaneGrip}
          onAppWindowCommand={props.onAppWindowCommand}
          onDaemonIdentityMismatch={props.onDaemonIdentityMismatch}
          daemonRecovery={props.daemonRecovery}
          onRetryDaemonConnection={props.onRetryDaemonConnection}
          introPending={props.introPending}
          onAcknowledgeIntro={props.onAcknowledgeIntro}
        />
      )}
    </Show>
  );
}
