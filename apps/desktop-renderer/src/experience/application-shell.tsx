import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellProjectionInputV1SchemaZ,
  ApplicationShellProjectionInputV3SchemaZ,
  applyApplicationShellInvocationV1,
  applicationShellCommandInvocation,
  commandsToOpenSurface,
  type AgentGraphOverlay,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionInputV3,
  type ApplicationShellProjectionV1,
  type AppWindowDocumentV1,
  type CommandSource,
  type DesktopDaemonCapabilityState,
  type DesktopWindowState,
  type FocusZone,
  type HostCapabilities,
  type PaneAppearance,
  type ProductSurfaceId,
  type SemanticFocusTarget,
  type WorkspacePaneCreateInvocation,
  resolvePaneAppearance,
} from "@tmux-ide/contracts";
import {
  For,
  Index,
  Match,
  Show,
  Switch,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { WebWorkbenchDock } from "../../../../packages/daemon/src/ui/workbench-dock/web-host-unstyled.tsx";
import { WebPaneFrame } from "../../../../packages/daemon/src/ui/pane-frame/web-host-unstyled.tsx";
import {
  APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS,
  type ApplicationShellTerminalPaneFrame,
} from "../../../../packages/daemon/src/ui/pane-frame/model.ts";
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
import { CreatePaneFlow } from "./create-pane-flow.tsx";
import { FleetSidebarSection, type FleetPromoteOutcome } from "./fleet-sidebar.tsx";
import { mergeFleetGraphOverlay } from "./fleet-graph-merge.ts";
import {
  createSolidDesktopFleetCatalogStore,
  type DesktopFleetCatalogState,
} from "../runtime/fleet-catalog-store.ts";
import {
  statusStripFromConnectionHealth,
  type DesktopConnectionHealth,
} from "../runtime/connection-health.ts";
import { UpdateChip } from "./update-chip.tsx";
import { MissionActivitySurface } from "./mission-activity-surface.tsx";
import { WorkspaceFilesSurface, type FilesSurfaceProps } from "./workspace-files-surface.tsx";
import { WorkspaceChangesSurface, type ChangesSurfaceProps } from "./workspace-changes-surface.tsx";
import type { CreatePaneFlowCatalogs } from "./create-pane-flow-presenter.ts";
import { DomIcon } from "./dom-icon.tsx";
import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import {
  PaneMirrorController,
  type PaneMirrorControllerState,
} from "../terminal/pane-mirror-controller.ts";
import type { PaneStreamTransport } from "../terminal/pane-stream-transport.ts";
import { createHostPaneStreamTransport } from "../runtime/host-pane-stream-transport.ts";
import { deriveConnectionHealth } from "../runtime/connection-health.ts";
import { terminalIssueFaultLabel } from "../runtime/connection-recovery.ts";
import { PANE_STREAM_MAX_PANES } from "@tmux-ide/contracts";
import {
  AppWindowCanvas,
  type AppWindowCanvasMirrorProps,
  type AppWindowMirrorNodeModel,
} from "./app-window-canvas.tsx";
import {
  Button,
  ContextMenu,
  Icon,
  IconButton,
  ResizeHandle,
  WorkspaceIdentity,
  type ContextMenuSection,
} from "../ui-system/index.ts";
import { useVerbTable, type MultiplexerVerbTarget } from "./multiplexer-verb-access.ts";
import { canvasMenuSections, windowCardMenuSections } from "./multiplexer-verb-menu.ts";
import type { AppWindowCanvasVerbSurface } from "./app-window-canvas.tsx";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  Loading03Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import type { AppWindowCanvasCommandInvocation } from "./app-window-canvas-presenter.ts";
import {
  createDefaultDomShellInput,
  createDefaultDomPaneFrames,
  DOM_SHELL_GEOMETRY,
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
import { experimentalSurfacesEnabled, hiddenDockTools } from "./experimental-surfaces.ts";
import { WorkspaceTiledSurface } from "./workspace-tiled-surface.tsx";
import { statusStripWithAttachment } from "./terminal-attachment-status.ts";

const PALETTE_OVERLAY_ID = "overlay.palette.trace";

/**
 * The connection state as a glyph. The strip already carried the state in
 * color; shape says it a second way, which is the difference between a status
 * a reader recognises and one they have to have learned — and it survives a
 * viewer who cannot separate the palette.
 */
function connectionGlyph(state: string) {
  if (state === "connected" || state === "complete") return CheckmarkCircle02Icon;
  if (state === "warning" || state === "disconnected" || state === "blocked") return Alert02Icon;
  return Loading03Icon;
}

export interface DomApplicationShellProps {
  readonly host: HostCapabilities;
  readonly daemonState?: DesktopDaemonCapabilityState;
  readonly runtime?: string;
  readonly platform?: string;
  readonly windowState?: DesktopWindowState | null;
  readonly input?: ApplicationShellProjectionInputV1 | ApplicationShellProjectionInputV3;
  readonly dataMode?: "runtime" | "preview";
  readonly terminalWorkspaceName?: string;
  readonly terminalTransport?: NativeTerminalTransport | null;
  readonly reducedMotion?: boolean;
  readonly terminalThemeKey?: string;
  readonly onCommand?: (invocation: ApplicationShellCommandInvocation) => void;
  readonly paneFrames?: readonly PaneFrameModel[];
  readonly terminalPanes?: readonly ApplicationShellTerminalPaneFrame[];
  readonly createPaneFlow?: {
    readonly catalogs: CreatePaneFlowCatalogs;
    readonly initialWorkspaceName: string;
    readonly onCommand: (invocation: WorkspacePaneCreateInvocation) => void | Promise<void>;
  };
  readonly onPaneAction?: (
    intent: PaneFrameActionIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly onPaneGrip?: (intent: PaneFrameGripIntent, source: PaneFrameActivationSource) => void;
  readonly onAppWindowCommand?: (
    invocation: AppWindowCanvasCommandInvocation,
  ) => void | Promise<void>;
  readonly appWindowMutationUnavailableReason?: string;
  /**
   * Fixture/test override of the pane-stream transport behind the mirror-panes
   * affordance. Undefined = derive the production transport from the host when
   * the daemon is connected; null = the affordance is unavailable.
   */
  readonly paneStreamTransport?: PaneStreamTransport | null;
  readonly onRefreshResource?: () => void;
  /**
   * Supervisor-derived compound connection health. When present and not
   * healthy, the runtime status strip renders this derived state instead of
   * the projection's own connection segment, so transport retries show their
   * real attempt position and a sync failure on a healthy socket never
   * masquerades as a reconnect.
   */
  readonly connectionHealth?: DesktopConnectionHealth;
  readonly filesSurface?: FilesSurfaceProps;
  readonly changesSurface?: ChangesSurfaceProps;
  /** Fixture/preview override of the live fleet-catalog store state. */
  readonly fleetState?: DesktopFleetCatalogState;
  /** Fixture/preview override of the promote action (defaults to the host mutation). */
  readonly onPromoteSession?: (sessionId: string) => Promise<FleetPromoteOutcome>;
  /**
   * Override the GUI-first scope flag (see `experimental-surfaces.ts`). Read
   * once at construction — it is a startup setting, not a live control — so
   * fixtures state it as a constant rather than toggling it under a mounted
   * shell.
   */
  readonly experimentalSurfaces?: boolean;
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
  const input = createMemo<ApplicationShellProjectionInputV1 | ApplicationShellProjectionInputV3>(
    () => {
      const value = props.input ?? fallbackInput;
      return "appWindows" in value
        ? ApplicationShellProjectionInputV3SchemaZ.parse(value)
        : ApplicationShellProjectionInputV1SchemaZ.parse(value);
    },
  );
  const dataMode = createMemo<"runtime" | "preview">(() =>
    props.input === undefined ? "preview" : (props.dataMode ?? "runtime"),
  );
  const experimentalSurfaces = props.experimentalSurfaces ?? experimentalSurfacesEnabled();
  const hiddenTools = hiddenDockTools(experimentalSurfaces);
  const [state, setState] = createSignal(createDomShellReplayState(input(), hiddenTools));
  const [viewport, setViewport] = createSignal(initialViewport());
  const [createPaneOpen, setCreatePaneOpen] = createSignal(false);
  const [sidebarWidth, setSidebarWidth] = createSignal<number>(DOM_SHELL_GEOMETRY.sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [paletteTransitionSource, setPaletteTransitionSource] = createSignal<"keyboard" | "mouse">(
    "keyboard",
  );
  let titlebarStyle: RuntimeStyleBinding | null = null;
  let workbenchStyle: RuntimeStyleBinding | null = null;
  let previousInput = input();
  let previousDataMode = dataMode();
  let returnFocusElement: HTMLElement | null = null;
  let returnFocusId: string | null = null;

  const shell = createMemo(() => projectDomApplicationShell(input(), state(), hiddenTools));
  const missionWorkspace = createMemo(() => {
    const value = input();
    return "appWindows" in value ? value.missionWorkspace : undefined;
  });
  // The live fleet-catalog store — every adopted session, not just the open
  // workspace. Fixtures/preview inject `fleetState` instead of a live store.
  const fleetStore = props.fleetState
    ? null
    : createSolidDesktopFleetCatalogStore({ host: props.host, daemon: props.daemonState });
  if (fleetStore) {
    createEffect(() => fleetStore.setDaemon(props.daemonState));
  }
  const fleetState = createMemo<DesktopFleetCatalogState>(
    () => props.fleetState ?? fleetStore!.state(),
  );
  const fleetSnapshot = createMemo(() => {
    const state = fleetState();
    return "snapshot" in state ? state.snapshot : null;
  });
  const promoteSession = async (sessionId: string): Promise<FleetPromoteOutcome> => {
    if (props.onPromoteSession) return props.onPromoteSession(sessionId);
    const result = await props.host.daemon.promoteWorkspace({ sessionId });
    // On success the daemon emits workspace.added, which refreshes the workspace
    // catalog automatically; the new workspace then appears for selection.
    return result.status === "ok" ? { ok: true } : { ok: false, error: result.error };
  };

  // The open workspace's own fleet session id, when the daemon supplied it (V3+).
  // It is the correlation key that lets the sidebar mark this session open and
  // keeps the renderer-side graph merge from drawing it twice.
  const openFleetSessionId = createMemo<string | null>(() => {
    const value = input();
    return "appWindows" in value ? (value.fleetSessionId ?? null) : null;
  });
  const excludeSessionIds = createMemo<ReadonlySet<string> | undefined>(() => {
    const id = openFleetSessionId();
    return id ? new Set([id]) : undefined;
  });
  // The agent-graph overlay is a non-durable, additive V3 projection. It follows
  // the same generation as the rest of the input, so reading it here keeps it
  // reconciled with the mutation/refresh queue exactly like missionWorkspace.
  // When a live fleet snapshot is present it is composed in renderer-side so the
  // canvas shows the whole fleet, not just the open workspace — excluding the
  // open session so it is not drawn once as the real overlay and again as a
  // display-only fleet group.
  const fleetGraphMerge = createMemo(() => {
    const value = input();
    const base = "appWindows" in value ? value.agentGraphOverlay : undefined;
    if (!base) return null;
    const snapshot = fleetSnapshot();
    if (!snapshot) return null;
    return mergeFleetGraphOverlay({
      openOverlay: base,
      fleet: snapshot.catalog,
      excludeSessionIds: excludeSessionIds(),
    });
  });
  const agentGraphOverlay = createMemo<AgentGraphOverlay | undefined>(() => {
    const value = input();
    const base = "appWindows" in value ? value.agentGraphOverlay : undefined;
    if (!base) return base;
    return fleetGraphMerge()?.overlay ?? base;
  });
  // Quiet canvas indicator when the fleet could not be fully composed (an
  // over-cap fleet is dropped wholesale rather than half-rendered).
  const fleetGraphTruncated = createMemo<boolean>(() => fleetGraphMerge()?.truncated ?? false);
  const effectiveSidebarWidth = createMemo(() =>
    sidebarCollapsed() ? DOM_SHELL_GEOMETRY.sidebarCollapsedWidth : sidebarWidth(),
  );
  createComputed(() => {
    const properties = { "--desktop-sidebar-width": `${effectiveSidebarWidth()}px` };
    titlebarStyle?.update(properties);
    workbenchStyle?.update(properties);
  });
  onCleanup(() => {
    titlebarStyle?.dispose();
    workbenchStyle?.dispose();
  });
  const appWindowDocument = createMemo(() => {
    const value = input();
    return "appWindows" in value ? value.appWindows : null;
  });
  const [localFocusedWindowId, setLocalFocusedWindowId] = createSignal<string | null>(null);
  let appWindowWorkspaceId = input().workspace.id;
  createEffect(() => {
    const localId = localFocusedWindowId();
    if (localId && appWindowDocument()?.focusedWindowId === localId) {
      setLocalFocusedWindowId(null);
    }
  });
  const focusedAppWindowDocument = createMemo<AppWindowDocumentV1 | null>(() => {
    const document = appWindowDocument();
    if (!document) return null;
    const localId = localFocusedWindowId();
    const windowId = localId && Object.hasOwn(document.windows, localId) ? localId : null;
    if (!windowId || document.focusedWindowId === windowId) return document;
    const window = document.windows[windowId]!;
    return {
      ...document,
      focusedWindowId: windowId,
      floatingOrder:
        window.placement.mode === "floating"
          ? [...document.floatingOrder.filter((candidate) => candidate !== windowId), windowId]
          : document.floatingOrder,
    };
  });
  const paneFrames = createMemo<readonly PaneFrameModel[]>(() => {
    if (props.terminalPanes) return props.terminalPanes.map(({ model }) => model);
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
  const appearanceWithSemanticFocus = (
    appearance: PaneAppearance,
    focused: boolean,
  ): PaneAppearance =>
    resolvePaneAppearance({
      structure: appearance.structure,
      applicationFocus: {
        pane: focused,
        terminalInput: focused,
        windowActive: appearance.header.windowActive,
      },
      agentActivity: appearance.header.agentActivity,
      domainStatus: appearance.status.domainStatus,
      attention: appearance.status.attention,
      layoutInteraction: {
        editable: true,
        selected: appearance.accessibility.layoutSelected,
        dragging: false,
        resizing: false,
        previewing: false,
      },
      controlInteraction: {
        hover: appearance.action.hover,
        focusVisible: appearance.action.focusVisible,
        pressed: appearance.action.pressed,
        disabled: appearance.action.disabled,
        loading: appearance.action.loading,
      },
    });
  const renderedPaneFrames = createMemo<readonly PaneFrameModel[]>(() => {
    const localTerminalFocus = shell().focus.terminalInputPaneId;
    if (!localTerminalFocus) return paneFrames();
    return paneFrames().map((model) => ({
      ...model,
      appearance: appearanceWithSemanticFocus(
        model.appearance,
        localTerminalFocus === model.pane.id,
      ),
    }));
  });
  const hasMaximizedPane = createMemo(() =>
    renderedPaneFrames().some(({ appearance }) => appearance.structure === "maximized"),
  );

  // ── Multiplexer verbs (m49.2) ─────────────────────────────────────────────
  // The shell owns the workspace name, the daemon connection and the create
  // flows; the canvas and the sidebar own the pointer. This is the seam.
  const verbAccess = useVerbTable(props.host);
  const verbWorkspaceName = () => props.terminalWorkspaceName ?? input().workspace.id;
  const workspaceConnected = () =>
    dataMode() === "runtime" && props.daemonState?.status === "connected";
  /**
   * Windows in the session, counted the only way the renderer can: attachable
   * resources sharing a `windowResourceId` are one tmux window, and a resource
   * without one is its own. It is what the "last window" refusal is checked
   * against, so it errs toward offering the verb and letting the daemon refuse.
   */
  const sessionWindowCount = createMemo(() => {
    const inventory = shell().terminalInventory;
    if (!inventory) return 1;
    const grouped = new Set<string>();
    let ungrouped = 0;
    for (const resource of inventory.resources) {
      if (resource.windowResourceId) grouped.add(resource.windowResourceId);
      else ungrouped += 1;
    }
    return Math.max(1, grouped.size + ungrouped);
  });
  const semanticPaneIdFor = (resourceId: string): string | null => {
    const inventory = shell().terminalInventory;
    if (!inventory) return null;
    const resource = inventory.resources.find(({ id }) => id === resourceId);
    return resource?.attachability.status === "available"
      ? resource.attachability.semanticPaneId
      : null;
  };
  const openProjectDirectory = (): void => {
    void props.host.workspace.openProjectDirectory();
  };
  const canvasVerbSurface = createMemo<AppWindowCanvasVerbSurface>(() => ({
    workspaceConnected: workspaceConnected(),
    sessionWindowCount: sessionWindowCount(),
    invoke: (verbId, target, args) => verbAccess.invoke(verbId, target, args),
    onCreateWindow: props.createPaneFlow ? () => setCreatePaneOpen(true) : undefined,
    onCreateSession: openProjectDirectory,
  }));

  /** A pointer-anchored menu owned by the shell rather than by the canvas. */
  const [terminalAttached, setTerminalAttached] = createSignal(false);
  /** The window being renamed in the tab strip, named by a pane inside it. */
  const [renamingPane, setRenamingPane] = createSignal<string | null>(null);
  const [shellMenu, setShellMenu] = createSignal<{
    readonly kind: "workspace" | "pane";
    readonly paneId: string | null;
    readonly pointer: { readonly x: number; readonly y: number };
    readonly openSource: "contextmenu" | "click";
  } | null>(null);
  const shellMenuSections = createMemo<readonly ContextMenuSection[]>(() => {
    const menu = shellMenu();
    if (!menu) return [];
    const refusals = new Map<string, string>([
      ["session.detach", "Detaching from the app is not available yet"],
      ["session.rename", "Rename a session from the fleet sidebar"],
    ]);
    if (!props.createPaneFlow) {
      refusals.set("window.new", "Creating terminals is unavailable in this host");
    }
    if (menu.kind === "workspace") {
      return canvasMenuSections({
        facts: {
          workspaceConnected: workspaceConnected(),
          sessionWindowCount: sessionWindowCount(),
        },
        refusals,
      });
    }
    const targetFrame = (mirrorState()?.layouts ?? []).find((layout) =>
      layout.panes.some((pane) => pane.pane === menu.paneId),
    );
    return windowCardMenuSections({
      facts: {
        workspaceConnected: workspaceConnected(),
        sessionWindowCount: sessionWindowCount(),
        // Real counts now that the layout frame is on hand: the zoom and resize
        // verbs are refused for a one-pane window, and a hardcoded 1 refused
        // them for every window.
        windowPaneCount: windowPaneCountFor(menu.paneId),
        windowZoomed: targetFrame?.zoomed ?? false,
        targetIsActivePane: shell().focus.terminalInputPaneId === menu.paneId,
        targetIsDockedStackMember: false,
      },
      placement: "docked",
      maximized: false,
      // This pane lives in the grid layout, which has no float, dock or stack.
      appLayoutAvailable: false,
      appLayoutUnavailableReason: "This pane is in the grid layout, not on the canvas",
      dockTargets: [],
      refusals,
    });
  });
  const activateShellMenuItem = (itemId: string): void => {
    const menu = shellMenu();
    if (!menu) return;
    if (itemId === "window.new") {
      setCreatePaneOpen(true);
      return;
    }
    if (itemId === "session.new") {
      openProjectDirectory();
      return;
    }
    if (itemId === "session.kill") {
      void verbAccess.invoke("session.kill", { workspaceName: verbWorkspaceName() });
      return;
    }
    if (!menu.paneId) return;
    const semanticPaneId = semanticPaneIdFor(menu.paneId);
    if (!semanticPaneId) return;
    const target: MultiplexerVerbTarget = {
      workspaceName: verbWorkspaceName(),
      semanticPaneId,
    };
    if (itemId === "pane.split.right" || itemId === "pane.split.down") {
      void verbAccess.invoke(itemId, target);
      return;
    }
    if (itemId === "pane.select" || itemId === "pane.kill" || itemId === "window.kill") {
      void verbAccess.invoke(itemId, target);
      return;
    }
    if (itemId === "window.rename") {
      setRenamingPane(semanticPaneId);
      return;
    }
    if (itemId === "window.zoom.toggle") void verbAccess.invoke(itemId, target);
  };
  const openShellMenu = (
    kind: "workspace" | "pane",
    paneId: string | null,
    anchor: Element,
    openSource: "contextmenu" | "click",
    pointer?: { readonly x: number; readonly y: number },
  ): void => {
    const bounds = anchor.getBoundingClientRect();
    setShellMenu({
      kind,
      paneId,
      openSource,
      pointer: pointer ?? { x: bounds.left, y: bounds.bottom },
    });
  };

  // ── The pane-stream lease (m43 card 3, widened in m50) ────────────────────
  // One session-scoped lease. The controller owns connect/reconnect; this shell
  // owns WHEN a lease exists and WHICH panes it enumerates.
  /**
   * The layout lease.
   *
   * The tiled view is a pure function of the pane-stream layout frames, and
   * those frames ride on a lease — so one exists whenever the workspace is
   * open, not only while the mirror toggle is on. It costs one pane's stream:
   * the frames are SESSION-scoped (tmux reports every window's geometry on the
   * one control channel), so a single-pane lease already carries the whole
   * picture. Turning the mirror on widens the same lease to every pane rather
   * than opening a second one.
   */
  const [mirrorEnabled, setMirrorEnabled] = createSignal(false);
  const [mirrorState, setMirrorState] = createSignal<PaneMirrorControllerState | null>(null);
  const [mirrorController, setMirrorController] = createSignal<PaneMirrorController | null>(null);
  const mirrorPaneIds = createMemo<readonly string[]>(() => {
    const inventory = shell().terminalInventory;
    if (!inventory) return [];
    return inventory.resources
      .flatMap((resource) =>
        resource.attachability.status === "available"
          ? [resource.attachability.semanticPaneId]
          : [],
      )
      .slice(0, PANE_STREAM_MAX_PANES);
  });
  const mirrorTransport = createMemo<PaneStreamTransport | null>(() => {
    if (props.paneStreamTransport !== undefined) return props.paneStreamTransport;
    if (dataMode() !== "runtime" || props.daemonState?.status !== "connected") return null;
    return createHostPaneStreamTransport(props.host, props.daemonState.identity);
  });
  let activeMirrorKey = "";
  createEffect(() => {
    const transport = mirrorTransport();
    const panes = mirrorPaneIds();
    const workspaceName = props.terminalWorkspaceName ?? input().workspace.id;
    const leased = mirrorEnabled() ? panes : panes.slice(0, 1);
    const enabled = transport !== null && leased.length > 0;
    const key = enabled ? [workspaceName, ...leased].join("\u0000") : "";
    if (!enabled) {
      activeMirrorKey = "";
      mirrorController()?.dispose();
      setMirrorController(null);
      setMirrorState(null);
      return;
    }
    const current = mirrorController();
    if (current && activeMirrorKey === key) return;
    if (current && activeMirrorKey.startsWith(`${workspaceName}\u0000`)) {
      // Same lease scope, new pane set: re-issue through the same controller.
      activeMirrorKey = key;
      current.setPanes(leased);
      return;
    }
    current?.dispose();
    activeMirrorKey = key;
    const controller = new PaneMirrorController({
      transport,
      workspaceName,
      panes: leased,
      onStateChanged: (state) => setMirrorState(state),
    });
    setMirrorController(controller);
    setMirrorState(controller.state());
    controller.start();
  });
  onCleanup(() => {
    mirrorController()?.dispose();
  });
  // A mirror node registers its sink ONCE per lease, so the registrar it is
  // handed must not change identity on every tick — only when the controller
  // behind it is genuinely replaced (a new lease needs a re-registration).
  let mirrorRegistrars = new Map<string, AppWindowMirrorNodeModel["registerSink"]>();
  let mirrorRegistrarOwner: PaneMirrorController | null = null;
  const mirrorRegistrar = (
    controller: PaneMirrorController,
    pane: string,
  ): AppWindowMirrorNodeModel["registerSink"] => {
    if (mirrorRegistrarOwner !== controller) {
      mirrorRegistrarOwner = controller;
      mirrorRegistrars = new Map();
    }
    const existing = mirrorRegistrars.get(pane);
    if (existing) return existing;
    const registrar: AppWindowMirrorNodeModel["registerSink"] = (sink) =>
      controller.registerPaneSink(pane, sink);
    mirrorRegistrars.set(pane, registrar);
    return registrar;
  };
  const mirrorCanvasProps = createMemo<AppWindowCanvasMirrorProps | undefined>(() => {
    if (mirrorTransport() === null || mirrorPaneIds().length === 0) return undefined;
    const controller = mirrorController();
    const state = mirrorState();
    const enabled = mirrorEnabled() && controller !== null && state !== null;
    const framesById = new Map(renderedPaneFrames().map((frame) => [frame.pane.id, frame]));
    return {
      enabled,
      onToggle: setMirrorEnabled,
      nodes:
        enabled && controller && state
          ? mirrorPaneIds().map((pane) => ({
              pane,
              title: framesById.get(pane)?.title ?? pane,
              frame: framesById.get(pane) ?? null,
              state: state.panes.get(pane) ?? { kind: "connecting" as const },
              registerSink: mirrorRegistrar(controller, pane),
            }))
          : [],
      connection: deriveConnectionHealth(state?.transport ?? null, { ok: true }),
      // The stream fault keeps its own code (the merged issue vocabulary), so a
      // refused pane or a degraded engine reads as itself instead of as the
      // generic transport error the connection health is typed in.
      faultLabel: state?.fault ? terminalIssueFaultLabel(state.fault.code) : null,
      onRetry: () => mirrorController()?.retry(),
    };
  });
  /**
   * The panes the daemon still reports as attachable, which is what prunes a
   * killed window's last layout frame out of the tab strip.
   */
  const livePaneIds = createMemo<ReadonlySet<string>>(() => {
    const inventory = shell().terminalInventory;
    if (!inventory) return new Set<string>();
    return new Set(
      inventory.resources.flatMap((resource) =>
        resource.attachability.status === "available"
          ? [resource.attachability.semanticPaneId]
          : [],
      ),
    );
  });
  /**
   * The tiled view IS the runtime terminals surface; the pane grid below it is
   * the preview/fixture path only.
   *
   * The condition is whether a pane-stream transport EXISTS, never whether its
   * frames have arrived yet. Attachment ownership
   * is window-keyed with a grace period, so a grid that attaches for the second
   * before the first layout frame lands leaves a lease still releasing when the
   * tiled view attaches — and the user is shown "this terminal's previous
   * session is still releasing" for a window nothing else is using. The tiled
   * surface states its own waiting-for-geometry case instead.
   */
  const tiledViewAvailable = createMemo<boolean>(
    () => dataMode() === "runtime" && mirrorTransport() !== null,
  );
  /**
   * The session's windows as the inventory groups them: panes sharing a
   * `windowResourceId` are one tmux window, and a pane without one is its own.
   * It is the tab strip's source until layout frames arrive.
   */
  const inventoryWindows = createMemo(() => {
    const inventory = shell().terminalInventory;
    const groups = new Map<
      string,
      { key: string; label: string; panes: string[]; active: boolean }
    >();
    for (const resource of inventory?.resources ?? []) {
      if (resource.attachability.status !== "available") continue;
      const key = resource.windowResourceId ?? resource.id;
      const group = groups.get(key) ?? { key, label: resource.title, panes: [], active: false };
      group.panes.push(resource.attachability.semanticPaneId);
      if (resource.active) group.active = true;
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  /** Every attachable pane's title, as the daemon's inventory records it. */
  const paneTitles = createMemo<ReadonlyMap<string, string>>(() => {
    const inventory = shell().terminalInventory;
    const titles = new Map<string, string>();
    for (const resource of inventory?.resources ?? []) {
      if (resource.attachability.status === "available") {
        titles.set(resource.attachability.semanticPaneId, resource.title);
      }
    }
    return titles;
  });
  /**
   * The inventory's own active pane — what the tiled view shows before (or
   * without) any layout frame, so late geometry never costs the user a terminal.
   */
  const activeSemanticPaneId = createMemo<string | null>(() => {
    const inventory = shell().terminalInventory;
    if (!inventory) return null;
    const attachable = inventory.resources.filter(
      (resource) => resource.attachability.status === "available",
    );
    const active = attachable.find((resource) => resource.active) ?? attachable[0];
    return active?.attachability.status === "available"
      ? active.attachability.semanticPaneId
      : null;
  });
  /** Panes in the window the shell menu's target belongs to, per tmux. */
  const windowPaneCountFor = (semanticPaneId: string | null): number => {
    if (!semanticPaneId) return 1;
    const frame = (mirrorState()?.layouts ?? []).find((layout) =>
      layout.panes.some((pane) => pane.pane === semanticPaneId),
    );
    return frame?.panes.length ?? 1;
  };

  const dock = createMemo(() =>
    projectDomWorkbenchDock(shell(), viewport(), { sidebarWidth: effectiveSidebarWidth() }),
  );
  const paletteEntries = createMemo(() => createDomPaletteEntries(shell()));
  const statusStrip = createMemo(() => {
    if (dataMode() !== "preview") {
      const derived = props.connectionHealth
        ? statusStripFromConnectionHealth(props.connectionHealth)
        : null;
      return statusStripWithAttachment(derived ?? shell().statusStrip, terminalAttached());
    }
    if (props.daemonState?.status === "connected") {
      return {
        state: "connected" as const,
        message: `Daemon connected — ${props.daemonState.identity.productVersion}`,
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
    if (nextInput.workspace.id !== appWindowWorkspaceId) {
      appWindowWorkspaceId = nextInput.workspace.id;
      setLocalFocusedWindowId(null);
    }
    if (nextInput === previousInput && nextDataMode === previousDataMode) return;
    const currentInput = previousInput;
    const currentDataMode = previousDataMode;
    previousInput = nextInput;
    previousDataMode = nextDataMode;
    setState((current) =>
      currentDataMode === nextDataMode
        ? reconcileDomShellReplayState(currentInput, nextInput, current, hiddenTools)
        : createDomShellReplayState(nextInput, hiddenTools),
    );
  });

  const dispatch = (invocation: ApplicationShellCommandInvocation): void => {
    setState((current) => applyApplicationShellInvocationV1(current, invocation));
    props.onCommand?.(invocation);
  };

  const dispatchAppWindow = (
    invocation: AppWindowCanvasCommandInvocation,
  ): void | Promise<void> => {
    if (invocation.command.type !== "window.focus" || invocation.command.windowId === null) {
      return props.onAppWindowCommand?.(invocation);
    }
    const document = appWindowDocument();
    const window = document?.windows[invocation.command.windowId];
    if (!window || window.source.kind !== "terminal") return;
    setLocalFocusedWindowId(window.id);
    dispatch(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.moveFocus,
        {
          target: {
            kind: "pane",
            paneId: window.source.terminalSourceId,
            input: "terminal",
          },
        },
        {
          kind: invocation.source === "programmatic" ? "keyboard" : invocation.source,
          surface: "application-shell",
        },
      ),
    );
    return props.onAppWindowCommand?.(invocation);
  };

  const dispatchSurface = (surface: ProductSurfaceId, source: CommandSource): void => {
    for (const command of commandsToOpenSurface({ surface })) {
      dispatch(invocationFromSurfaceCommand(command, source));
    }
  };

  const selectResource = (surface: ProductSurfaceId, resourceId: string): void => {
    dispatch(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.selectResource,
        { surface, resourceId },
        { kind: "mouse", surface: "mission-activity-surface" },
      ),
    );
  };

  const openMissionActivity = (missionId: string): void => {
    selectResource("missions", missionId);
    const resource = missionWorkspace();
    const event =
      resource?.status === "ready"
        ? resource.activity.find((candidate) => candidate.missionId === missionId)
        : undefined;
    if (event) selectResource("activity", event.id);
    dispatchSurface("activity", { kind: "mouse", surface: "mission-activity-surface" });
  };

  const openMissionFromActivity = (missionId: string): void => {
    selectResource("missions", missionId);
    dispatchSurface("missions", { kind: "mouse", surface: "mission-activity-surface" });
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

  const returnToTerminals = (): void => {
    setDockMode("collapsed", { kind: "mouse", surface: "mission-activity-surface" });
    dispatchSurface("terminals", { kind: "mouse", surface: "mission-activity-surface" });
  };

  const openPalette = (source: CommandSource): void => {
    if (shell().focus.palette.open) return;
    setPaletteTransitionSource(source.kind === "mouse" ? "mouse" : "keyboard");
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
    setPaletteTransitionSource(sourceKind);
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
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "b" &&
        !(event.target instanceof HTMLElement && event.target.matches("input, textarea, select"))
      ) {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
        return;
      }
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
    // Belt to the projection's braces: a withheld tool has no tab to reach it
    // by, and no body either, even if a hand-built input names it active.
    if (hiddenTools.has(tool.id)) return null;
    return (
      <div class="dock-surface" data-surface={tool.id}>
        <div class="dock-surface__rail" aria-hidden="true">
          <DomIcon id={dockToolIcon(shell(), tool.id)} usage="rail" />
        </div>
        <div
          class="dock-surface__content"
          classList={{
            "dock-surface__content--journey":
              ("appWindows" in input() && (tool.id === "missions" || tool.id === "activity")) ||
              tool.id === "files" ||
              tool.id === "changes",
          }}
        >
          <header>
            <strong>{tool.label}</strong>
            <span>{tool.shortcut}</span>
          </header>
          <Switch>
            <Match
              when={
                "appWindows" in input() &&
                (tool.data.kind === "missions" || tool.data.kind === "activity")
              }
            >
              <MissionActivitySurface
                mode={tool.id === "activity" ? "activity" : "missions"}
                resource={missionWorkspace()}
                selectedMissionId={
                  state().selectedResources.find(({ surface }) => surface === "missions")
                    ?.resourceId ?? null
                }
                selectedActivityId={
                  state().selectedResources.find(({ surface }) => surface === "activity")
                    ?.resourceId ?? null
                }
                onSelectMission={(missionId) => selectResource("missions", missionId)}
                onSelectActivity={(activityId) => selectResource("activity", activityId)}
                onOpenMissions={openMissionFromActivity}
                onOpenActivity={openMissionActivity}
                onOpenTerminals={returnToTerminals}
                onRefresh={props.onRefreshResource}
              />
            </Match>
            <Match when={tool.data.kind === "files"}>
              <WorkspaceFilesSurface
                model={props.filesSurface?.model}
                preview={props.filesSurface?.preview}
                onSelectFile={props.filesSurface?.onSelectFile}
                onToggleDirectory={props.filesSurface?.onToggleDirectory}
                onRetry={props.filesSurface?.onRetry}
                onRetryPreview={props.filesSurface?.onRetryPreview}
              />
            </Match>
            <Match when={tool.data.kind === "changes"}>
              <WorkspaceChangesSurface
                model={props.changesSurface?.model}
                diff={props.changesSurface?.diff}
                onSelectChange={props.changesSurface?.onSelectChange}
                onRetry={props.changesSurface?.onRetry}
                onRetryDiff={props.changesSurface?.onRetryDiff}
              />
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
      <header
        ref={(element) => {
          titlebarStyle = createRuntimeStyleBinding(element);
          titlebarStyle.update({ "--desktop-sidebar-width": `${effectiveSidebarWidth()}px` });
        }}
        class="titlebar"
        data-focus-zone="application-bar"
        data-sidebar-collapsed={sidebarCollapsed()}
      >
        <div class="titlebar__brand">
          <span class="titlebar__product-mark" aria-hidden="true">
            <DomIcon id="terminals" usage="tab" />
          </span>
          <span class="titlebar__product-copy">
            <strong>tmux-ide</strong>
            <small>{shell().project.name}</small>
          </span>
          <IconButton
            class="titlebar__sidebar-toggle"
            size="small"
            label={sidebarCollapsed() ? "Expand sidebar" : "Collapse sidebar"}
            tooltip={`${sidebarCollapsed() ? "Expand" : "Collapse"} sidebar (${props.platform === "darwin" ? "⌘B" : "Ctrl B"})`}
            pressed={!sidebarCollapsed()}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <DomIcon id="dock" usage="action" />
          </IconButton>
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
        <UpdateChip host={props.host} />
        <Show when={props.createPaneFlow}>
          {(flow) => (
            <CreatePaneFlow
              open={createPaneOpen()}
              catalogs={flow().catalogs}
              initialWorkspaceName={flow().initialWorkspaceName}
              onOpenChange={setCreatePaneOpen}
              onCommand={flow().onCommand}
            />
          )}
        </Show>
        <Button
          class="palette-trigger"
          size="small"
          variant="ghost"
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
        </Button>
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

      <div
        ref={(element) => {
          workbenchStyle = createRuntimeStyleBinding(element);
          workbenchStyle.update({ "--desktop-sidebar-width": `${effectiveSidebarWidth()}px` });
        }}
        class="shell-workbench"
        data-shell-source={dataMode()}
        data-sidebar-collapsed={sidebarCollapsed()}
      >
        <aside class="workspace-sidebar" aria-label="Workspace overview" data-focus-zone="sidebar">
          <div class="workspace-sidebar__project">
            {/*
              The workspace glyph. Nothing in the shell projection carries a
              chosen emoji or color yet, so this resolves to the folder
              fallback — which is the point of the component: the tile is
              correct today and becomes richer the moment the model can say
              more, without this call site changing. The two initials it
              replaces were redundant with the name printed beside them.
            */}
            <span class="project-monogram" aria-hidden="true">
              <WorkspaceIdentity size="surface" />
            </span>
            <span>
              <strong>{shell().project.name}</strong>
              <small>{shell().project.rootLabel}</small>
            </span>
            {/*
              The overflow glyph beside the workspace name is exactly where a
              user hunts for rename and close. It had a label, a tooltip and no
              handler; it now opens the session's own verb menu.
            */}
            <IconButton
              class="workspace-sidebar__more"
              size="small"
              label="Workspace actions"
              tooltip="Workspace actions"
              onClick={(event) => openShellMenu("workspace", null, event.currentTarget, "click")}
            >
              <DomIcon id="more" usage="action" />
            </IconButton>
          </div>
          <section aria-labelledby="sessions-heading">
            <h2 id="sessions-heading">
              <Icon icon={ComputerTerminal01Icon} size="dense" />
              Sessions
            </h2>
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
                    <span class="sidebar-row__identity">
                      <span>{session().label}</span>
                      <small>{session().state}</small>
                    </span>
                  </button>
                );
              }}
            </Index>
          </section>
          <section aria-labelledby="agents-heading">
            <h2 id="agents-heading">
              <Icon icon={UserGroupIcon} size="dense" />
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
                  <span class="sidebar-row__identity">
                    <span>{agent().name}</span>
                    <small>
                      {agent().harness} · {agent().activity}
                    </small>
                  </span>
                  <Show when={agent().attention}>
                    <b aria-label="Needs attention" />
                  </Show>
                </button>
              )}
            </Index>
          </section>
          <FleetSidebarSection
            state={fleetState()}
            openSessionId={openFleetSessionId()}
            onPromote={promoteSession}
            workspaceConnected={workspaceConnected()}
            onSessionVerb={(verbId, _session, args) => {
              // Only the open workspace's row can carry a verb: a session the
              // app has not opened has no workspace name to address, which is
              // why the row's other items arrive here already refused.
              if (verbId === "session.kill") {
                void verbAccess.invoke("session.kill", { workspaceName: verbWorkspaceName() });
                return;
              }
              if (verbId === "session.rename" && args?.name) {
                void verbAccess.invoke(
                  "session.rename",
                  { workspaceName: verbWorkspaceName() },
                  { name: args.name },
                );
              }
            }}
          />
        </aside>

        <ResizeHandle
          class="workspace-sidebar__resize"
          value={sidebarWidth()}
          min={DOM_SHELL_GEOMETRY.sidebarMinimumWidth}
          max={DOM_SHELL_GEOMETRY.sidebarMaximumWidth}
          label="Resize workspace sidebar"
          disabled={sidebarCollapsed()}
          onValueChange={(width) => {
            setSidebarWidth(width);
            setSidebarCollapsed(false);
          }}
        />

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
              <small class="home-canvas__workspace-guidance">
                Additional workspaces appear after tmux-ide is started in their project.
              </small>
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
            <Show
              when={experimentalSurfaces && focusedAppWindowDocument()}
              fallback={
                <Show
                  when={tiledViewAvailable()}
                  fallback={
                    <div class="agent-grid" data-has-maximized={hasMaximizedPane()}>
                      <Index each={renderedPaneFrames()}>
                        {(paneFrame) => {
                          const agent = createMemo(() =>
                            shell().sidebar.agents.find(
                              (item) => item.paneId === paneFrame().pane.id,
                            ),
                          );
                          const terminalTarget = createMemo(() => {
                            const inventory = shell().terminalInventory;
                            if (inventory !== undefined) {
                              const resource = inventory.resources.find(
                                ({ id }) => id === paneFrame().pane.id,
                              );
                              return resource?.attachability.status === "available"
                                ? resource.attachability.semanticPaneId
                                : null;
                            }
                            const projected = props.terminalPanes?.find(
                              ({ model }) => model.pane.id === paneFrame().pane.id,
                            );
                            if (projected) return projected.terminalTarget?.semanticPaneId ?? null;
                            return paneFrame().pane.id;
                          });
                          return (
                            <WebPaneFrame
                              model={paneFrame()}
                              onActionActivate={(intent, source) => {
                                // The pane-actions overflow produced a command no
                                // surface consumed. It opens the verb menu now; every
                                // other action keeps its existing host handler.
                                if (
                                  intent.actionId ===
                                  APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS.menu
                                ) {
                                  const anchor = document.querySelector(
                                    `[data-pane-id="${CSS.escape(intent.paneId)}"] [data-action-id="${CSS.escape(intent.actionId)}"]`,
                                  );
                                  if (anchor) openShellMenu("pane", intent.paneId, anchor, "click");
                                  return;
                                }
                                props.onPaneAction?.(intent, source);
                              }}
                              onGripActivate={props.onPaneGrip}
                              renderPaneIcon={(_pane, icon) => <DomIcon id={icon} usage="pane" />}
                              renderActionIcon={(action) => (
                                <DomIcon id={action.icon} usage="action" />
                              )}
                              renderGripIcon={(icon) => <DomIcon id={icon} usage="action" />}
                            >
                              <div class="agent-pane__body" data-focus-zone="terminal">
                                <Show
                                  when={terminalTarget()}
                                  fallback={
                                    <div
                                      class="terminal-surface terminal-surface--unavailable"
                                      role="status"
                                    >
                                      <strong>Terminal unavailable</strong>
                                      <span>
                                        {paneFrame().status?.description ??
                                          "This terminal cannot be attached safely."}
                                      </span>
                                    </div>
                                  }
                                >
                                  {(semanticPaneId) => (
                                    <TerminalSurface
                                      target={{
                                        workspaceName:
                                          props.terminalWorkspaceName ?? input().workspace.id,
                                        semanticPaneId: semanticPaneId(),
                                      }}
                                      title={paneFrame().title}
                                      transport={props.terminalTransport}
                                      focused={
                                        paneFrame().appearance.accessibility.terminalInputOwner
                                      }
                                      reducedMotion={props.reducedMotion}
                                      themeKey={props.terminalThemeKey}
                                      onFocus={(source) =>
                                        dispatch(
                                          applicationShellCommandInvocation(
                                            APPLICATION_SHELL_COMMAND_IDS.moveFocus,
                                            {
                                              target: {
                                                kind: "pane",
                                                paneId: paneFrame().pane.id,
                                                input: "terminal",
                                              },
                                            },
                                            { kind: source, surface: "application-shell" },
                                          ),
                                        )
                                      }
                                    />
                                  )}
                                </Show>
                                <span class="sr-only">
                                  {agent()?.harness ??
                                    paneFrame().subtitle ??
                                    paneFrame().pane.kind}{" "}
                                  · Activity:{" "}
                                  {agent()?.activity ?? paneFrame().status?.label ?? "idle"}
                                </span>
                              </div>
                            </WebPaneFrame>
                          );
                        }}
                      </Index>
                    </div>
                  }
                >
                  <WorkspaceTiledSurface
                    layouts={mirrorState()?.layouts ?? []}
                    workspaceName={verbWorkspaceName()}
                    transport={props.terminalTransport}
                    paneFrames={renderedPaneFrames()}
                    livePanes={livePaneIds()}
                    fallbackPane={activeSemanticPaneId()}
                    paneTitles={paneTitles()}
                    fallbackWindows={inventoryWindows()}
                    reducedMotion={props.reducedMotion}
                    terminalThemeKey={props.terminalThemeKey}
                    mirror={mirrorCanvasProps()}
                    onAttachmentChanged={setTerminalAttached}
                    renamingPane={renamingPane()}
                    onRenameCancel={() => setRenamingPane(null)}
                    onRenameCommit={(semanticPaneId, name) => {
                      setRenamingPane(null);
                      void verbAccess.invoke(
                        "window.rename",
                        { workspaceName: verbWorkspaceName(), semanticPaneId },
                        { name },
                      );
                    }}
                    verbs={{
                      workspaceConnected: workspaceConnected(),
                      onCreateWindow: props.createPaneFlow
                        ? () => setCreatePaneOpen(true)
                        : undefined,
                      invoke: (verbId, semanticPaneId, args) => {
                        void verbAccess.invoke(
                          verbId,
                          { workspaceName: verbWorkspaceName(), semanticPaneId },
                          args,
                        );
                      },
                    }}
                    onOpenPaneMenu={(semanticPaneId, pointer) =>
                      setShellMenu({
                        kind: "pane",
                        paneId: semanticPaneId,
                        pointer,
                        openSource: "contextmenu",
                      })
                    }
                    onOpenWindowMenu={(semanticPaneId, pointer) =>
                      setShellMenu({
                        kind: "pane",
                        paneId: semanticPaneId,
                        pointer,
                        openSource: "contextmenu",
                      })
                    }
                    onFocusPane={(semanticPaneId, source) =>
                      dispatch(
                        applicationShellCommandInvocation(
                          APPLICATION_SHELL_COMMAND_IDS.moveFocus,
                          {
                            target: {
                              kind: "pane",
                              paneId: semanticPaneId,
                              input: "terminal",
                            },
                          },
                          { kind: source, surface: "application-shell" },
                        ),
                      )
                    }
                  />
                </Show>
              }
            >
              {(document) => (
                <AppWindowCanvas
                  document={document()}
                  paneFrames={renderedPaneFrames()}
                  terminalInventory={shell().terminalInventory}
                  overlay={agentGraphOverlay()}
                  overlayTruncated={fleetGraphTruncated()}
                  workspaceName={props.terminalWorkspaceName ?? input().workspace.id}
                  transport={props.terminalTransport}
                  reducedMotion={props.reducedMotion}
                  terminalThemeKey={props.terminalThemeKey}
                  onCommand={dispatchAppWindow}
                  mutationsAvailable={props.onAppWindowCommand !== undefined}
                  mutationUnavailableReason={props.appWindowMutationUnavailableReason}
                  mirror={mirrorCanvasProps()}
                  verbs={canvasVerbSurface()}
                />
              )}
            </Show>
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
          <Icon icon={connectionGlyph(statusStrip().state)} size="dense" />
          <span>{statusStrip().message}</span>
        </span>
        <span class="status-strip__safe" title={statusStrip().safeState}>
          {statusStrip().safeState}
        </span>
        <span class="status-strip__guidance" title={statusStrip().nextAction}>
          {statusStrip().nextAction}
        </span>
      </footer>

      <Show when={shellMenu()}>
        {(menu) => (
          <ContextMenu
            open
            pointer={menu().pointer}
            label={menu().kind === "workspace" ? "Workspace actions" : "Pane actions"}
            sections={shellMenuSections()}
            openSource={menu().openSource}
            onClose={() => setShellMenu(null)}
            onActivate={(itemId) => activateShellMenuItem(itemId)}
          />
        )}
      </Show>

      <CommandPalette
        open={shell().focus.palette.open}
        entries={paletteEntries()}
        transitionSource={paletteTransitionSource()}
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
