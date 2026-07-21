import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellProjectionInputV1SchemaZ,
  applyApplicationShellInvocationV1,
  applicationShellCommandInvocation,
  commandsToOpenSurface,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionV1,
  type CommandSource,
  type DesktopDaemonHostState,
  type DesktopWindowState,
  type FocusZone,
  type HostCapabilities,
  type ProductSurfaceId,
  type SemanticFocusTarget,
  resolvePaneAppearance,
} from "@tmux-ide/contracts";
import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { WebWorkbenchDock } from "../../../../packages/daemon/src/ui/workbench-dock/web-host.tsx";
import { WebPaneFrame } from "../../../../packages/daemon/src/ui/pane-frame/web-host.tsx";
import type {
  PaneFrameActionIntent,
  PaneFrameActivationSource,
  PaneFrameGripIntent,
  PaneFrameModel,
} from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import type {
  WorkbenchDockHostActionId,
  WorkbenchDockHostMode,
  WorkbenchDockHostTabId,
} from "../../../../packages/daemon/src/ui/workbench-dock/presenter.tsx";
import { CommandPalette } from "./command-palette.tsx";
import { DomIcon } from "./dom-icon.tsx";
import {
  createDefaultDomShellInput,
  createDefaultDomPaneFrames,
  createDomPaletteEntries,
  createDomShellReplayState,
  dockToolIcon,
  invocationFromSurfaceCommand,
  projectDomApplicationShell,
  projectDomWorkbenchDock,
  reconcileDomShellReplayState,
  type DomPaletteEntry,
  type DomViewport,
} from "./dom-shell.ts";

const PALETTE_OVERLAY_ID = "overlay.palette.trace";

export interface DomApplicationShellProps {
  readonly host: HostCapabilities;
  readonly daemonState?: DesktopDaemonHostState;
  readonly runtime?: string;
  readonly platform?: string;
  readonly windowState?: DesktopWindowState | null;
  readonly input?: ApplicationShellProjectionInputV1;
  readonly dataMode?: "runtime" | "preview";
  readonly onCommand?: (invocation: ApplicationShellCommandInvocation) => void;
  readonly paneFrames?: readonly PaneFrameModel[];
  readonly onPaneAction?: (
    intent: PaneFrameActionIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly onPaneGrip?: (intent: PaneFrameGripIntent, source: PaneFrameActivationSource) => void;
}

export interface PrimaryNavigationProps {
  readonly items: ApplicationShellProjectionV1["primaryNavigation"]["items"];
  readonly onActivate: (surface: ProductSurfaceId, source: "keyboard" | "mouse") => void;
}

/** Stable, keyboard-complete DOM leaf for the canonical primary surfaces. */
export function PrimaryNavigation(props: PrimaryNavigationProps) {
  const tabStopId = createMemo(
    () =>
      props.items.find((item) => item.active && item.disabledReason === null)?.id ??
      props.items.find((item) => item.disabledReason === null)?.id,
  );
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')
        : [],
    );
    const current = event.target instanceof HTMLButtonElement ? tabs.indexOf(event.target) : -1;
    if (current < 0 || tabs.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  return (
    <nav
      class="primary-tabs"
      aria-label="Workspace modes"
      role="tablist"
      onKeyDown={handleKeyDown}
      data-focus-zone="primary-navigation"
    >
      <Index each={props.items}>
        {(item) => (
          <button
            id={`primary-tab-${item().id}`}
            type="button"
            role="tab"
            aria-selected={item().active}
            aria-disabled={item().disabledReason !== null}
            aria-label={
              item().disabledReason
                ? `${item().label}, unavailable: ${item().disabledReason}`
                : undefined
            }
            aria-controls={`workspace-panel-${item().id}`}
            disabled={item().disabledReason !== null}
            tabIndex={item().id === tabStopId() ? 0 : -1}
            title={item().disabledReason ?? `${item().label} (${item().shortcut})`}
            classList={{ "primary-tabs__tab--active": item().active }}
            onClick={(event) => {
              if (!item().disabledReason) {
                props.onActivate(item().id, event.detail === 0 ? "keyboard" : "mouse");
              }
            }}
          >
            <span>{item().shortcut}</span>
            <DomIcon id={item().icon} usage="tab" />
            {item().label}
          </button>
        )}
      </Index>
    </nav>
  );
}

function initialViewport(): DomViewport {
  return typeof window === "undefined"
    ? { width: 1_280, height: 820 }
    : { width: Math.max(720, window.innerWidth), height: Math.max(480, window.innerHeight) };
}

function semanticFocusTarget(element: Element | null): SemanticFocusTarget {
  const host = element?.closest<HTMLElement>("[data-focus-zone]");
  const zone = host?.dataset.focusZone as FocusZone | undefined;
  return { kind: "zone", zone: zone ?? "primary-navigation" };
}

function activityTone(activity: string): string {
  if (activity === "running") return "running";
  if (activity === "complete") return "complete";
  if (activity === "disconnected") return "recovery";
  return "waiting";
}

export function DomApplicationShell(props: DomApplicationShellProps) {
  const fallbackInput = createDefaultDomShellInput();
  const input = createMemo(() =>
    ApplicationShellProjectionInputV1SchemaZ.parse(props.input ?? fallbackInput),
  );
  const dataMode = createMemo<"runtime" | "preview">(() =>
    props.input === undefined ? "preview" : (props.dataMode ?? "runtime"),
  );
  const [state, setState] = createSignal(createDomShellReplayState(input()));
  const [viewport, setViewport] = createSignal(initialViewport());
  let previousInput = input();
  let previousDataMode = dataMode();
  let returnFocusElement: HTMLElement | null = null;
  let returnFocusId: string | null = null;

  const shell = createMemo(() => projectDomApplicationShell(input(), state()));
  const paneFrames = createMemo<readonly PaneFrameModel[]>(() => {
    if (props.paneFrames) return props.paneFrames;
    if (dataMode() === "preview") return createDefaultDomPaneFrames();
    return shell().sidebar.agents.flatMap((agent) => {
      if (!agent.paneId) return [];
      const domainStatus =
        agent.activity === "running"
          ? "running"
          : agent.activity === "complete"
            ? "done"
            : agent.activity === "disconnected"
              ? "disconnected"
              : "idle";
      const appearance = resolvePaneAppearance({
        structure: "docked",
        applicationFocus: {
          pane: shell().focus.appFocusedPaneId === agent.paneId,
          terminalInput: shell().focus.terminalInputPaneId === agent.paneId,
          windowActive: shell().focus.windowActivity === "active",
        },
        agentActivity: agent.activity,
        domainStatus,
        attention:
          agent.activity === "disconnected" ? "recovery" : agent.attention ? "requested" : "none",
        layoutInteraction: {
          editable: false,
          selected: shell().focus.layoutSelectedPaneId === agent.paneId,
          dragging: false,
          resizing: false,
          previewing: false,
        },
        controlInteraction: {
          hover: false,
          focusVisible: false,
          pressed: false,
          disabled: false,
          loading: false,
        },
      });
      return [
        {
          pane: { id: agent.paneId, kind: "terminal" },
          appearance,
          title: agent.name,
          subtitle: agent.harness,
          status: {
            id: `${agent.paneId}:status`,
            label: domainStatus,
            description: appearance.accessibility.description,
            tone: appearance.status.tone,
            busy: appearance.accessibility.busy,
          },
          chips: [],
          actions: [],
        },
      ];
    });
  });
  const dock = createMemo(() => projectDomWorkbenchDock(shell(), viewport()));
  const paletteEntries = createMemo(() => createDomPaletteEntries(shell()));
  const statusStrip = createMemo(() => {
    if (dataMode() !== "preview") return shell().statusStrip;
    if (props.daemonState?.status === "connected") {
      return {
        state: "connected" as const,
        message: `Daemon connected — ${props.daemonState.descriptor.productVersion}`,
        safeState: "Preview data remains illustrative",
        nextAction: "Live workspace loading is not enabled in this build",
      };
    }
    if (props.daemonState?.status === "degraded") {
      return {
        state: "recovering" as const,
        message: `Daemon verification degraded — ${props.daemonState.reason}`,
        safeState: "Illustrative data only",
        nextAction: "Repair the canonical daemon record and reopen the app",
      };
    }
    if (props.daemonState?.status === "unavailable") {
      return {
        state: "disconnected" as const,
        message: `Daemon unavailable — ${props.daemonState.reason}`,
        safeState: "Illustrative data only",
        nextAction: "Start tmux-ide --headless and reopen the app",
      };
    }
    return {
      state: "disconnected" as const,
      message: "Preview workspace — daemon state is still loading",
      safeState: "Illustrative data only",
      nextAction: "Wait for desktop host verification",
    };
  });

  createEffect(() => {
    const nextInput = input();
    const nextDataMode = dataMode();
    if (nextInput === previousInput && nextDataMode === previousDataMode) return;
    const currentInput = previousInput;
    const currentDataMode = previousDataMode;
    previousInput = nextInput;
    previousDataMode = nextDataMode;
    setState((current) =>
      currentDataMode === nextDataMode
        ? reconcileDomShellReplayState(currentInput, nextInput, current)
        : createDomShellReplayState(nextInput),
    );
  });

  const dispatch = (invocation: ApplicationShellCommandInvocation): void => {
    setState((current) => applyApplicationShellInvocationV1(current, invocation));
    props.onCommand?.(invocation);
  };

  const dispatchSurface = (surface: ProductSurfaceId, source: CommandSource): void => {
    for (const command of commandsToOpenSurface({ surface })) {
      dispatch(invocationFromSurfaceCommand(command, source));
    }
  };

  const setDockMode = (mode: WorkbenchDockHostMode, source: CommandSource): void => {
    dispatch(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode },
        source,
      ),
    );
  };

  const openPalette = (source: CommandSource): void => {
    if (shell().focus.palette.open) return;
    const activeElement = document.activeElement;
    returnFocusElement =
      activeElement && "focus" in activeElement ? (activeElement as HTMLElement) : null;
    returnFocusId = returnFocusElement?.id || null;
    const focusReturnTarget = semanticFocusTarget(returnFocusElement);
    dispatch(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.moveFocus,
        { target: focusReturnTarget },
        source,
      ),
    );
    dispatch(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.openPalette,
        { overlayId: PALETTE_OVERLAY_ID, focusReturnTarget },
        source,
      ),
    );
  };

  const closePalette = (sourceKind: "keyboard" | "mouse"): void => {
    const overlayId = shell().focus.palette.overlayId;
    if (!overlayId) return;
    dispatch(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.closePalette,
        { overlayId },
        { kind: sourceKind, surface: "command-palette" },
      ),
    );
  };

  const activatePaletteEntry = (entry: DomPaletteEntry, sourceKind: "keyboard" | "mouse"): void => {
    closePalette(sourceKind);
    const source = { kind: "palette", surface: "command-palette" } as const;
    for (const command of entry.commands) dispatch(invocationFromSurfaceCommand(command, source));
  };

  onMount(() => {
    const resize = () =>
      setViewport({
        width: Math.max(720, window.innerWidth),
        height: Math.max(480, window.innerHeight),
      });
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shell().focus.palette.open) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        openPalette({ kind: "keyboard", surface: "application-shell" });
        return;
      }
      const surface = [...shell().primaryNavigation.items, ...shell().bottomDock.tools].find(
        (item) => item.shortcut === event.key,
      );
      if (!surface || surface.disabledReason) return;
      event.preventDefault();
      dispatchSurface(surface.id, { kind: "keyboard", surface: "application-shell" });
    };
    window.addEventListener("resize", resize);
    document.addEventListener("keydown", keydown);
    onCleanup(() => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("keydown", keydown);
    });
  });

  const renderDockBody = () => {
    const tool = input().dock.tools.find(
      (candidate) => candidate.id === shell().bottomDock.activeTool,
    )!;
    return (
      <div class="dock-surface" data-surface={tool.id}>
        <div class="dock-surface__rail" aria-hidden="true">
          <DomIcon id={dockToolIcon(shell(), tool.id)} usage="rail" />
        </div>
        <div class="dock-surface__content">
          <header>
            <strong>{tool.label}</strong>
            <span>{tool.shortcut}</span>
          </header>
          <Switch>
            <Match when={tool.data.kind === "files" && tool.data}>
              {(data) => (
                <div class="surface-summary">
                  <span>{data().fileCount} indexed files</span>
                  <code>{data().selectedResourceId}</code>
                </div>
              )}
            </Match>
            <Match when={tool.data.kind === "changes" && tool.data}>
              {(data) => (
                <div class="surface-summary">
                  <span>{data().changeCount} working tree changes</span>
                  <code>{data().selectedResourceId}</code>
                </div>
              )}
            </Match>
            <Match when={tool.data.kind === "missions" && tool.data}>
              {(data) => (
                <div class="mission-summary">
                  <div>
                    <small>{data().status}</small>
                    <strong>{data().title}</strong>
                  </div>
                  <span>{data().goalCount} goals</span>
                  <span>{data().taskCount} cards</span>
                </div>
              )}
            </Match>
            <Match when={tool.data.kind === "activity" && tool.data}>
              {(data) => (
                <div class="surface-summary">
                  <span>{data().eventCount} recorded events</span>
                  <code>{data().latestEventLabel}</code>
                </div>
              )}
            </Match>
          </Switch>
        </div>
      </div>
    );
  };

  return (
    <>
      <header class="titlebar" data-focus-zone="application-bar">
        <div class="titlebar__brand">
          <DomIcon id="terminals" usage="tab" />
          <strong>tmux-ide</strong>
          <span>{shell().project.name}</span>
        </div>
        <Show when={dataMode() === "preview"}>
          <span class="titlebar__preview-badge">Preview data</span>
        </Show>
        <PrimaryNavigation
          items={shell().primaryNavigation.items}
          onActivate={(surface, kind) =>
            dispatchSurface(surface, { kind, surface: "primary-navigation" })
          }
        />
        <div class="titlebar__drag titlebar__spacer" />
        <button
          class="palette-trigger"
          type="button"
          aria-label="Open command palette"
          id="application-command-palette-trigger"
          title="Open command palette (Cmd/Ctrl-K)"
          onClick={(event) =>
            openPalette({
              kind: event.detail === 0 ? "keyboard" : "mouse",
              surface: "application-bar",
            })
          }
        >
          <DomIcon id="command" usage="action" />
          <kbd>{props.platform === "darwin" ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <Show when={props.runtime === "electron" && props.platform !== "darwin"}>
          <nav class="window-controls" aria-label="Window controls">
            <button
              type="button"
              aria-label="Minimize"
              onClick={() => void props.host.window.minimize()}
            >
              <DomIcon id="minimize" usage="nativeWindow" />
            </button>
            <button
              type="button"
              aria-label={props.windowState?.maximized ? "Restore" : "Maximize"}
              onClick={() => void props.host.window.toggleMaximized()}
            >
              <DomIcon
                id={props.windowState?.maximized ? "restore" : "maximize"}
                usage="nativeWindow"
              />
            </button>
            <button type="button" aria-label="Close" onClick={() => void props.host.window.close()}>
              <DomIcon id="close" usage="nativeWindow" />
            </button>
          </nav>
        </Show>
      </header>

      <div class="shell-workbench" data-shell-source={dataMode()}>
        <aside class="workspace-sidebar" aria-label="Workspace overview" data-focus-zone="sidebar">
          <div class="workspace-sidebar__project">
            <span class="project-monogram" aria-hidden="true">
              {shell().project.name.slice(0, 2)}
            </span>
            <span>
              <strong>{shell().project.name}</strong>
              <small>{shell().project.rootLabel}</small>
            </span>
          </div>
          <section aria-labelledby="sessions-heading">
            <h2 id="sessions-heading">Sessions</h2>
            <Index each={shell().sidebar.sessions}>
              {(session) => {
                const selected = () =>
                  (shell().sidebar.selectedResourceId ?? shell().sidebar.activeSessionId) ===
                  session().id;
                return (
                  <button
                    id={`sidebar-session-${session().id}`}
                    type="button"
                    class="sidebar-row"
                    classList={{ "sidebar-row--active": selected() }}
                    aria-label={`${session().label}, ${session().state}${selected() ? ", selected" : ""}`}
                    aria-pressed={selected()}
                    onClick={(event) =>
                      dispatch(
                        applicationShellCommandInvocation(
                          APPLICATION_SHELL_COMMAND_IDS.selectResource,
                          { surface: "terminals", resourceId: session().id },
                          {
                            kind: event.detail === 0 ? "keyboard" : "mouse",
                            surface: "sidebar",
                          },
                        ),
                      )
                    }
                  >
                    <i data-state={session().state} />
                    <span>{session().label}</span>
                  </button>
                );
              }}
            </Index>
          </section>
          <section aria-labelledby="agents-heading">
            <h2 id="agents-heading">
              Agents <span>{shell().sidebar.agents.length}</span>
            </h2>
            <Index each={shell().sidebar.agents}>
              {(agent) => (
                <button
                  id={`sidebar-agent-${agent().id}`}
                  type="button"
                  class="sidebar-row sidebar-row--agent"
                  classList={{
                    "sidebar-row--active": shell().sidebar.selectedResourceId === agent().id,
                  }}
                  aria-label={`${agent().name}, ${agent().activity}${agent().attention ? ", needs attention" : ""}`}
                  aria-pressed={shell().sidebar.selectedResourceId === agent().id}
                  onClick={(event) =>
                    dispatch(
                      applicationShellCommandInvocation(
                        APPLICATION_SHELL_COMMAND_IDS.selectResource,
                        { surface: "terminals", resourceId: agent().id },
                        {
                          kind: event.detail === 0 ? "keyboard" : "mouse",
                          surface: "sidebar",
                        },
                      ),
                    )
                  }
                >
                  <i data-state={activityTone(agent().activity)} />
                  <span>{agent().name}</span>
                  <Show when={agent().attention}>
                    <b aria-label="Needs attention" />
                  </Show>
                </button>
              )}
            </Index>
          </section>
        </aside>

        <main class="workspace-main" data-dock-mode={shell().bottomDock.mode}>
          <section
            id="workspace-panel-home"
            class="workspace-canvas home-canvas"
            role="tabpanel"
            aria-labelledby="primary-tab-home"
            hidden={shell().workspaceCanvas.activeMode !== "home"}
            data-focus-zone="canvas"
          >
            <div class="home-canvas__intro">
              <span class="eyebrow">Project workspace</span>
              <h1>{shell().project.name}</h1>
              <p>{shell().project.readiness.facts.join(" ")}</p>
              <button type="button" onClick={() => void props.host.dialog.selectProjectDirectory()}>
                Open another folder
              </button>
            </div>
            <section class="readiness-card" aria-labelledby="readiness-heading">
              <header>
                <h2 id="readiness-heading">Workspace readiness</h2>
                <span data-state={shell().project.readiness.state}>
                  {shell().project.readiness.state}
                </span>
              </header>
              <For each={shell().project.readiness.facts}>
                {(fact) => (
                  <p>
                    <i />
                    {fact}
                  </p>
                )}
              </For>
              <For each={shell().project.readiness.warnings}>
                {(warning) => (
                  <p class="warning">
                    <i />
                    {warning}
                  </p>
                )}
              </For>
            </section>
          </section>

          <section
            id="workspace-panel-terminals"
            class="workspace-canvas terminal-canvas"
            role="tabpanel"
            aria-labelledby="primary-tab-terminals"
            hidden={shell().workspaceCanvas.activeMode !== "terminals"}
            data-focus-zone="canvas"
          >
            <header class="canvas-toolbar">
              <span>
                <strong>{shell().workspace.name}</strong>{" "}
                <small>{dataMode() === "preview" ? "preview data" : "workspace snapshot"}</small>
              </span>
              <span>{shell().sidebar.agents.length} agents</span>
            </header>
            <div class="agent-grid">
              <Index each={paneFrames()}>
                {(paneFrame) => {
                  const agent = createMemo(() =>
                    shell().sidebar.agents.find((item) => item.paneId === paneFrame().pane.id),
                  );
                  return (
                    <WebPaneFrame
                      model={paneFrame()}
                      onActionActivate={props.onPaneAction}
                      onGripActivate={props.onPaneGrip}
                      renderPaneIcon={(_pane, icon) => <DomIcon id={icon} usage="pane" />}
                      renderActionIcon={(action) => <DomIcon id={action.icon} usage="action" />}
                      renderGripIcon={(icon) => <DomIcon id={icon} usage="action" />}
                    >
                      <div class="agent-pane__body" data-focus-zone="terminal">
                        <span class="agent-prompt">
                          {agent()?.harness ?? paneFrame().subtitle ?? paneFrame().pane.kind}
                        </span>
                        <p>Activity: {agent()?.activity ?? paneFrame().status?.label ?? "idle"}</p>
                        <small>{paneFrame().pane.id}</small>
                      </div>
                    </WebPaneFrame>
                  );
                }}
              </Index>
            </div>
          </section>

          <div class="workspace-dock" data-focus-zone="dock-tabs">
            <WebWorkbenchDock
              projection={dock()}
              onTabActivate={(tabId: WorkbenchDockHostTabId, source) =>
                dispatchSurface(tabId, { kind: source, surface: "bottom-dock" })
              }
              onActionActivate={(
                _actionId: WorkbenchDockHostActionId,
                nextMode: WorkbenchDockHostMode,
                source,
              ) => setDockMode(nextMode, { kind: source, surface: "bottom-dock" })}
              renderTabIcon={(tab) => <DomIcon id={dockToolIcon(shell(), tab.id)} usage="tab" />}
              renderActionIcon={(action) => (
                <DomIcon
                  id={
                    action.id === "toggle-collapse"
                      ? "dock"
                      : action.nextMode === "maximized"
                        ? "maximize"
                        : "restore"
                  }
                  usage="action"
                />
              )}
            >
              {renderDockBody()}
            </WebWorkbenchDock>
          </div>
        </main>
      </div>

      <footer
        class="status-strip"
        role="status"
        data-focus-zone="status-strip"
        data-shell-source={dataMode()}
      >
        <span
          class="status-strip__connection"
          data-state={statusStrip().state}
          title={statusStrip().message}
        >
          <i />
          <span>{statusStrip().message}</span>
        </span>
        <span class="status-strip__safe" title={statusStrip().safeState}>
          {statusStrip().safeState}
        </span>
        <span class="status-strip__guidance" title={statusStrip().nextAction}>
          {statusStrip().nextAction}
        </span>
      </footer>

      <CommandPalette
        open={shell().focus.palette.open}
        entries={paletteEntries()}
        onClose={closePalette}
        onClosed={() => {
          const currentTarget = returnFocusId ? document.getElementById(returnFocusId) : null;
          if (currentTarget && "focus" in currentTarget) currentTarget.focus();
          else returnFocusElement?.focus();
        }}
        onActivate={activatePaletteEntry}
      />
    </>
  );
}
