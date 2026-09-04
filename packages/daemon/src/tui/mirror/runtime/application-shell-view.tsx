/* @jsxImportSource @opentui/solid */
import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";
import type { Accessor, ComponentProps, JSX } from "solid-js";
import { Show, createMemo } from "solid-js";

import { friendlySessionLabel } from "../terminal-text.ts";
import { ApplicationShell } from "../workspace/application-shell-view.tsx";
import {
  applicationShellHitTest,
  projectApplicationShell,
} from "../workspace/application-shell.ts";
import {
  ApplicationTerminalWorkspace,
  type ApplicationTerminalAgentIndicator,
} from "./application-terminal-workspace.tsx";
import {
  applicationPaletteCommands,
  type ApplicationPaletteCommand,
} from "./application-palette-input.ts";
import type { ApplicationPaneRenameDraft } from "./application-pane-rename-input.ts";
import { applicationShellViewport } from "./application-shell-viewport.ts";
import type { OverlayLayer } from "../ui/overlay-host.tsx";
import { ApplicationShellSidebar } from "./application-shell-sidebar.tsx";
import { ApplicationShellOverlayStack } from "./application-shell-overlay-stack.tsx";
import { ApplicationHomeSurface } from "./application-shell-home.tsx";
import type { ApplicationHomeAgentPresentation } from "./application-home-agents-owner.ts";
import {
  MinimalPalette,
  NotificationToast,
  PaneRenameDialog,
} from "./application-shell-overlays.tsx";
import { ApplicationCatalogShell } from "./application-shell-catalog.tsx";
export {
  applicationHomeBrandVariant,
  type ApplicationHomeBrandVariant,
} from "./application-shell-home.tsx";
export { applicationPaletteKeyAction } from "./application-palette-input.ts";
export { applicationShellViewport } from "./application-shell-viewport.ts";

type TerminalWorkspaceProps = ComponentProps<typeof ApplicationTerminalWorkspace>;
export type RootSurface = "home" | "terminals";
type InputSource = "keyboard" | "mouse";
export type ApplicationShellKeyAction = "home" | "terminals" | "palette-open" | "palette-close";

export function applicationShellKeyAction(
  key: { readonly name: string },
  paletteOpen: boolean,
): ApplicationShellKeyAction | null {
  const name = key.name.toLowerCase();
  if (name === "f1") return "home";
  if (name === "f2") return "terminals";
  if (name === "f5") return "palette-open";
  if (name === "escape" && paletteOpen) return "palette-close";
  return null;
}

export interface ApplicationShellViewProps {
  readonly homeAgents?: ApplicationHomeAgentPresentation;
  readonly dimensions: Accessor<{ readonly width: number; readonly height: number }>;
  readonly surface: Accessor<RootSurface>;
  readonly semantic: Accessor<ApplicationShellProjectionV1 | null>;
  readonly generationStatus: Accessor<string>;
  readonly sessions: readonly string[] | Accessor<readonly string[]>;
  readonly selectedSession: Accessor<number>;
  readonly bootstrapNote: Accessor<string | null>;
  readonly catalogPhase?: Accessor<"loading" | "live" | "unavailable">;
  readonly catalogNote?: Accessor<string | null>;
  readonly paletteOpen: Accessor<boolean>;
  readonly paneRenameDialog?: Accessor<ApplicationPaneRenameDraft | null>;
  readonly paletteSelection?: Accessor<number>;
  readonly paletteCommands?: Accessor<readonly ApplicationPaletteCommand[]>;
  readonly terminalRendererSource: Accessor<{
    readonly adapter: TerminalWorkspaceProps["adapter"];
    readonly rendererEpoch: TerminalWorkspaceProps["rendererEpoch"];
  } | null>;
  readonly layout: TerminalWorkspaceProps["layout"];
  readonly focusedPane: Accessor<string | null>;
  readonly rendererFocused?: Accessor<boolean>;
  readonly hostFocusTransitionOwner?: TerminalWorkspaceProps["hostFocusTransitionOwner"];
  readonly theme: TerminalWorkspaceProps["theme"];
  readonly palette: TerminalWorkspaceProps["palette"];
  readonly onOpenSurface: (surface: RootSurface, source: InputSource) => void;
  readonly onOpenSession: (sessionName: string, source: InputSource) => void;
  readonly onOpenAgent?: (sessionName: string, paneId: string, source: InputSource) => void;
  readonly onSetPaletteOpen: (open: boolean, source: InputSource) => void;
  readonly onPaletteActivate?: (
    command: ApplicationPaletteCommand,
    source: InputSource,
    confirmed?: boolean,
  ) => void;
  readonly onCreateWindow?: () => void;
  readonly onCreateSession?: () => void;
  readonly onCycleTheme?: () => void;
  readonly onBeginPaneRename?: (paneId: string, currentName: string) => void;
  readonly onCancelPaneRename?: () => void;
  readonly onDismissNotification?: () => void;
  readonly paletteCloseArmed?: Accessor<boolean>;
  readonly onSelectPane: TerminalWorkspaceProps["onSelectPane"];
  readonly onResizePreview: TerminalWorkspaceProps["onResizePreview"];
  readonly onResizePane: TerminalWorkspaceProps["onResizePane"];
  readonly onResizePointerIngress?: TerminalWorkspaceProps["onResizePointerIngress"];
  readonly onTerminalInput?: TerminalWorkspaceProps["onTerminalInput"];
  readonly terminalGestureRuntime?: TerminalWorkspaceProps["terminalGestureRuntime"];
  readonly onApplicationMousePointerIngress?: TerminalWorkspaceProps["onApplicationMousePointerIngress"];
  readonly onCopyText?: TerminalWorkspaceProps["onCopyText"];
  readonly onSelectionCopyOwner?: TerminalWorkspaceProps["onSelectionCopyOwner"];
  readonly onSelectionKeyOwner?: TerminalWorkspaceProps["onSelectionKeyOwner"];
  readonly onWindowPresented?: TerminalWorkspaceProps["onWindowPresented"];
  readonly onInteraction?: () => void;
}

/** Pure Solid composition over the WorkspaceClient semantic projection. */
export function ApplicationShellView(props: ApplicationShellViewProps): JSX.Element {
  const projection = createMemo(() => {
    const semantic = props.semantic();
    if (!semantic) return null;
    return projectApplicationShell({
      width: props.dimensions().width,
      height: props.dimensions().height,
      preferredSidebarWidth: 28,
      shell: semantic,
      hoveredTabIndex: null,
      quitHint: "^q quit",
    });
  });
  // Generation snapshots and semantic projections are immutable publications,
  // so both wrappers are freshly allocated for ordinary authority/presence
  // progress. Preserve the terminal owner unless the actual renderer changes.
  const terminalRendererSource = createMemo(() => props.terminalRendererSource(), undefined, {
    equals: (previous, next) =>
      previous?.adapter === next?.adapter && previous?.rendererEpoch === next?.rendererEpoch,
  });
  // This stable reactive facade keeps Solid/OpenTUI ownership anchored while
  // exposing every property from the latest immutable semantic projection.
  let lastProjection: NonNullable<ReturnType<typeof projection>> | null = null;
  const retainedProjection = new Proxy({} as NonNullable<ReturnType<typeof projection>>, {
    get: (_target, property) => {
      const current = projection();
      if (current) lastProjection = current;
      // Component-local keyboard handlers can finish an admitted event while
      // the semantic owner is being replaced or disposed. Preserve the last
      // immutable publication for that bounded tail instead of dereferencing
      // a projection that has already become unavailable.
      const readable = current ?? lastProjection;
      return readable ? Reflect.get(readable, property) : undefined;
    },
  });
  // OpenTUI retains native renderables aggressively. Key the visual shell by
  // the immutable appearance snapshot so a live theme switch cannot leave
  // previously painted box/framebuffer backgrounds behind. The daemon,
  // terminal parser, and renderer adapter stay resident; only presentation is
  // rebuilt for this rare user action.
  const projectionOwner = createMemo(
    () =>
      projection()
        ? { shell: retainedProjection, theme: props.theme, palette: props.palette }
        : null,
    undefined,
    {
      equals: (previous, next) =>
        previous === next ||
        (previous !== null &&
          next !== null &&
          previous.theme === next.theme &&
          previous.palette === next.palette),
    },
  );
  const agentIndicators = createMemo<ReadonlyMap<string, ApplicationTerminalAgentIndicator>>(
    () =>
      new Map(
        (props.semantic()?.sidebar.agents ?? []).flatMap((agent) =>
          agent.paneId
            ? [
                [
                  agent.paneId,
                  {
                    name: agent.name,
                    activity: agent.activity,
                    attention: agent.attention,
                  },
                ] as const,
              ]
            : [],
        ),
      ),
  );
  const routeChromePointer = (x: number, y: number): void => {
    const shell = projection();
    if (!shell) return;
    const hit = applicationShellHitTest(shell, x, y);
    if (hit?.kind === "view") props.onOpenSurface(hit.viewId, "mouse");
    else if (hit?.kind === "session") props.onOpenSession(hit.session, "mouse");
    else if (hit?.kind === "palette") props.onSetPaletteOpen(true, "mouse");
  };

  return (
    <Show
      when={projectionOwner()}
      keyed
      fallback={
        <ApplicationCatalogShell
          homeAgents={props.homeAgents}
          dimensions={props.dimensions}
          surface={props.surface}
          sessions={props.sessions}
          selectedSession={props.selectedSession}
          bootstrapNote={props.bootstrapNote}
          catalogPhase={props.catalogPhase}
          catalogNote={props.catalogNote}
          paletteOpen={props.paletteOpen}
          paletteSelection={props.paletteSelection}
          paletteCommands={props.paletteCommands}
          paletteCloseArmed={props.paletteCloseArmed}
          theme={props.theme}
          onOpenSurface={props.onOpenSurface}
          onOpenSession={props.onOpenSession}
          onSetPaletteOpen={props.onSetPaletteOpen}
          onPaletteActivate={props.onPaletteActivate}
          onCreateSession={props.onCreateSession}
          onCycleTheme={props.onCycleTheme}
        />
      }
    >
      {(appearance) => {
        const shell = appearance.shell;
        const overlayLayers = (): readonly OverlayLayer[] => {
          const layers: OverlayLayer[] = [];
          const note = props.bootstrapNote();
          if (note)
            layers.push({
              id: "notification",
              modal: false,
              dismissOnEscape: false,
              render: ({ active, zIndex }) => (
                <NotificationToast
                  note={note}
                  width={props.dimensions().width}
                  height={props.dimensions().height}
                  theme={appearance.theme}
                  active={active}
                  zIndex={zIndex}
                  onDismiss={props.onDismissNotification}
                />
              ),
            });
          if (props.paletteOpen())
            layers.push({
              id: "palette",
              render: ({ active, zIndex }) => (
                <MinimalPalette
                  width={props.dimensions().width}
                  height={props.dimensions().height}
                  selected={props.paletteSelection?.() ?? 0}
                  closeArmed={props.paletteCloseArmed?.() ?? false}
                  commands={
                    props.paletteCommands?.() ?? applicationPaletteCommands(props.semantic())
                  }
                  theme={appearance.theme}
                  active={active}
                  zIndex={zIndex}
                  onActivate={(command) => {
                    if (props.onPaletteActivate) props.onPaletteActivate(command, "mouse");
                    else if (command === "home" || command === "terminals")
                      props.onOpenSurface(command, "mouse");
                  }}
                  onClose={() => props.onSetPaletteOpen(false, "mouse")}
                />
              ),
            });
          const draft = props.paneRenameDialog?.();
          if (draft)
            layers.push({
              id: "pane-rename",
              render: ({ active, zIndex }) => (
                <PaneRenameDialog
                  draft={draft}
                  width={props.dimensions().width}
                  height={props.dimensions().height}
                  theme={appearance.theme}
                  active={active}
                  zIndex={zIndex}
                  onCancel={() => props.onCancelPaneRename?.()}
                />
              ),
            });
          return layers;
        };
        return (
          <box
            width={props.dimensions().width}
            height={props.dimensions().height}
            position="relative"
            overflow="hidden"
            onMouseDown={(event) => {
              props.onInteraction?.();
              routeChromePointer(event.x, event.y);
            }}
          >
            <ApplicationShell
              theme={appearance.theme}
              projection={shell}
              help="F5 commands"
              onHelp={() => props.onSetPaletteOpen(true, "mouse")}
              note={props.bootstrapNote() ?? props.generationStatus()}
              showToolStatus={false}
              showSidebar={props.surface() === "terminals"}
              sidebar={
                <ApplicationShellSidebar
                  shell={shell}
                  liveSessions={
                    typeof props.sessions === "function" ? props.sessions() : props.sessions
                  }
                  theme={appearance.theme}
                  onIntent={(intent) => {
                    if (intent.type === "session.open")
                      props.onOpenSession(intent.sessionName, intent.source);
                    else props.onOpenAgent?.(intent.sessionName, intent.paneId, intent.source);
                  }}
                />
              }
            >
              <Show
                when={props.surface() === "terminals"}
                fallback={
                  <ApplicationHomeSurface
                    {...props.homeAgents}
                    project={shell.semantic.project.name}
                    status={props.generationStatus()}
                    note={props.bootstrapNote()}
                    width={shell.layout.width}
                    height={shell.content.height}
                    sessionCount={shell.semantic.sidebar.sessions.length}
                    session={friendlySessionLabel(shell.activeSession)}
                    agents={[...agentIndicators().values()]}
                    branded={true}
                    theme={appearance.theme}
                    onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                    onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                    onCycleTheme={props.onCycleTheme}
                  />
                }
              >
                <box
                  position="relative"
                  width={shell.content.width}
                  height={shell.content.height}
                  overflow="hidden"
                >
                  <Show
                    when={terminalRendererSource()}
                    keyed
                    fallback={
                      <ApplicationHomeSurface
                        project="Terminal workspace"
                        status={props.generationStatus()}
                        note={props.bootstrapNote() ?? "Waiting for a coherent terminal frame."}
                        width={shell.content.width}
                        height={shell.content.height}
                        sessionCount={shell.semantic.sidebar.sessions.length}
                        session={shell.activeSession}
                        branded={false}
                        theme={appearance.theme}
                        onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                        onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                      />
                    }
                  >
                    {(source) => (
                      <ApplicationTerminalWorkspace
                        layout={props.layout}
                        adapter={source.adapter}
                        rendererEpoch={source.rendererEpoch}
                        width={shell.content.width}
                        height={Math.max(2, shell.content.height - 1)}
                        topOffset={1}
                        originX={shell.content.x}
                        originY={shell.content.y}
                        focusedPane={props.focusedPane()}
                        rendererFocused={props.rendererFocused?.() ?? props.focusedPane() !== null}
                        hostFocusTransitionOwner={props.hostFocusTransitionOwner}
                        theme={appearance.theme}
                        palette={appearance.palette}
                        agentIndicators={agentIndicators}
                        onSelectPane={props.onSelectPane}
                        onCreateWindow={props.onCreateWindow}
                        onPaneContextAction={(paneId, action, currentName) => {
                          if (action === "rename-pane")
                            props.onBeginPaneRename?.(paneId, currentName);
                          else props.onPaletteActivate?.(action, "mouse", true);
                        }}
                        onResizePreview={props.onResizePreview}
                        onResizePane={props.onResizePane}
                        onResizePointerIngress={props.onResizePointerIngress}
                        onTerminalInput={props.onTerminalInput}
                        terminalGestureRuntime={props.terminalGestureRuntime}
                        onApplicationMousePointerIngress={props.onApplicationMousePointerIngress}
                        onCopyText={props.onCopyText}
                        onSelectionCopyOwner={props.onSelectionCopyOwner}
                        onSelectionKeyOwner={props.onSelectionKeyOwner}
                        onWindowPresented={props.onWindowPresented}
                      />
                    )}
                  </Show>
                </box>
              </Show>
            </ApplicationShell>
            <ApplicationShellOverlayStack
              width={props.dimensions().width}
              height={props.dimensions().height}
              layers={overlayLayers()}
              focusedOwner={
                props.focusedPane() ? `pane:${props.focusedPane()!}` : `surface:${props.surface()}`
              }
              isFocusMounted={(id) =>
                !id.startsWith("pane:") ||
                props.layout.current?.panes.some(({ pane }) => `pane:${pane}` === id) === true
              }
              restoreFocus={(id) => {
                if (id.startsWith("pane:")) props.onSelectPane(id.slice("pane:".length));
              }}
              onIntent={({ id }) => {
                if (id === "pane-rename") props.onCancelPaneRename?.();
                else if (id === "palette") props.onSetPaletteOpen(false, "keyboard");
                else if (id === "notification") props.onDismissNotification?.();
              }}
            />
          </box>
        );
      }}
    </Show>
  );
}
