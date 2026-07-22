import {
  projectApplicationShellV1,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityState,
  type DesktopPlatform,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { paneFrameModelsFromApplicationShellAgents } from "../../../../packages/daemon/src/ui/pane-frame/model.ts";
import type {
  PaneFrameActionIntent,
  PaneFrameActivationSource,
  PaneFrameGripIntent,
  PaneFrameModel,
} from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { DomApplicationShell } from "../experience/application-shell.tsx";
import { DomIcon } from "../experience/dom-icon.tsx";
import type { DesktopApplicationShellResourceState } from "./connection-state.ts";
import { createSolidDesktopApplicationShellResourceStore } from "./desktop-resource-store.ts";
import { createHostDaemonTransport } from "./host-daemon-transport.ts";
import {
  createSolidDesktopWorkspaceCatalogStore,
  type DesktopWorkspaceCatalogState,
} from "./workspace-catalog-store.ts";

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
  readonly workspaces?: readonly string[];
  readonly onSelectWorkspace?: (workspaceName: string) => void;
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
        aria-busy={props.state === "pending" || props.state === "loading"}
      >
        <section class="runtime-state-card" aria-labelledby="runtime-state-title">
          <div class="runtime-state-card__signal" aria-hidden="true">
            <i />
            <span>{props.state}</span>
          </div>
          <span class="eyebrow">{props.eyebrow}</span>
          <h1 id="runtime-state-title">{props.title}</h1>
          <p>{props.description}</p>

          <Show when={props.workspaces && props.workspaces.length > 0}>
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

          <Show when={props.onRetry}>
            <div class="runtime-state-card__actions">
              <button class="runtime-action" type="button" onClick={() => props.onRetry?.()}>
                Try again
              </button>
            </div>
          </Show>
        </section>
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

type LiveWorkspaceProjection =
  | {
      readonly status: "ready";
      readonly input: ApplicationShellProjectionInputV1;
      readonly paneFrames: readonly PaneFrameModel[];
    }
  | { readonly status: "rejected" };

function assertUniqueSemanticIds(label: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Live workspace ${label} identities are incoherent.`);
  }
}

/** Strict rendering boundary. Failures are intentionally sanitized by the caller. */
function projectLiveWorkspace(input: ApplicationShellProjectionInputV1): LiveWorkspaceProjection {
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
    const paneFrames = paneFrameModelsFromApplicationShellAgents(shell);
    return { status: "ready", input, paneFrames };
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
  const store = createSolidDesktopApplicationShellResourceStore({
    target: props.target,
    transport: createHostDaemonTransport(props.host),
  });
  createEffect(() => store.setTarget(props.target));

  const input = createMemo(() => resourceData(store.state()));
  const projection = createMemo<LiveWorkspaceProjection | null>(() => {
    const snapshot = input();
    return snapshot ? projectLiveWorkspace(snapshot) : null;
  });

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
    const reason = catalogReason(props.catalogState);
    return reason
      ? { tone: "stale" as const, label: "Workspace catalog is recovering", reason }
      : null;
  });

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
        onRetry={
          identityMismatch
            ? props.daemonRecovery === "refreshing"
              ? undefined
              : props.onRetryDaemonConnection
            : () => store.refresh()
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
            input={ready().input}
            dataMode="runtime"
            onCommand={props.onCommand}
            paneFrames={ready().paneFrames}
            onPaneAction={props.onPaneAction}
            onPaneGrip={props.onPaneGrip}
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
          title="No live workspaces yet"
          description="Start tmux-ide in a project to make its live workspace available here."
          guidance="Workspace opening is not available in this build yet"
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
        />
      );
    }
    const identityMismatch =
      state.status === "degraded" && state.code === "daemon-identity-mismatch";
    const recovery = recoveryPresentation(props.daemonRecovery ?? "idle");
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
        onRetry={
          state.status === "loading"
            ? undefined
            : identityMismatch
              ? props.daemonRecovery === "refreshing"
                ? undefined
                : props.onRetryDaemonConnection
              : () => catalog.refresh()
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
          onCommand={props.onCommand}
          onPaneAction={props.onPaneAction}
          onPaneGrip={props.onPaneGrip}
          onDaemonIdentityMismatch={props.onDaemonIdentityMismatch}
          daemonRecovery={props.daemonRecovery}
          onRetryDaemonConnection={props.onRetryDaemonConnection}
        />
      )}
    </Show>
  );
}
