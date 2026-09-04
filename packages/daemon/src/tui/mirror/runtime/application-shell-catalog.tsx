/* @jsxImportSource @opentui/solid */
import type { Accessor, JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";

import { shellChromeLayout, type ShellChromeView } from "../shell-chrome.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, friendlySessionLabel } from "../terminal-text.ts";
import { Button } from "../ui/button.tsx";
import { NavigationRow } from "../ui/navigation-row.tsx";
import type { OverlayLayer } from "../ui/overlay-host.tsx";
import { StatusBar, StatusBarAction, StatusBarGroup, StatusBarSegment } from "../ui/status-bar.tsx";
import { Surface } from "../ui/surface.tsx";
import { ApplicationCatalogTabBar } from "../workspace/application-shell-view.tsx";
import {
  applicationPaletteCommands,
  type ApplicationPaletteCommand,
} from "./application-palette-input.ts";
import { ApplicationHomeSurface } from "./application-shell-home.tsx";
import type { ApplicationHomeAgentPresentation } from "./application-home-agents-owner.ts";
import { MinimalPalette } from "./application-shell-overlays.tsx";
import { ApplicationShellOverlayStack } from "./application-shell-overlay-stack.tsx";

export type ApplicationCatalogSurface = "home" | "terminals";
export type ApplicationCatalogInputSource = "keyboard" | "mouse";
export interface ApplicationCatalogShellProps {
  readonly homeAgents?: ApplicationHomeAgentPresentation;
  readonly dimensions: Accessor<{ readonly width: number; readonly height: number }>;
  readonly surface: Accessor<ApplicationCatalogSurface>;
  readonly sessions: readonly string[] | Accessor<readonly string[]>;
  readonly selectedSession: Accessor<number>;
  readonly bootstrapNote: Accessor<string | null>;
  readonly catalogPhase?: Accessor<"loading" | "live" | "unavailable">;
  readonly catalogNote?: Accessor<string | null>;
  readonly paletteOpen: Accessor<boolean>;
  readonly paletteSelection?: Accessor<number>;
  readonly paletteQuery?: Accessor<string>;
  readonly paletteDisabledReason?: (command: ApplicationPaletteCommand) => string | null;
  readonly onPaletteSelect?: (index: number) => void;
  readonly paletteCommands?: Accessor<readonly ApplicationPaletteCommand[]>;
  readonly paletteCloseArmed?: Accessor<boolean>;
  readonly theme: SemanticThemeSnapshot;
  readonly onOpenSurface: (
    surface: ApplicationCatalogSurface,
    source: ApplicationCatalogInputSource,
  ) => void;
  readonly onOpenSession: (sessionName: string, source: ApplicationCatalogInputSource) => void;
  readonly onSetPaletteOpen: (open: boolean, source: ApplicationCatalogInputSource) => void;
  readonly onPaletteActivate?: (
    command: ApplicationPaletteCommand,
    source: ApplicationCatalogInputSource,
    confirmed?: boolean,
  ) => void;
  readonly onCreateSession?: () => void;
  readonly onCycleTheme?: () => void;
}

const CATALOG_VIEWS: readonly ShellChromeView[] = [
  { id: "home", title: "Home", glyph: "⌂", shortcut: { key: "f1", label: "F1" } },
  {
    id: "terminals",
    title: "Terminals",
    glyph: "●",
    shortcut: { key: "f2", label: "F2" },
  },
] as const;

function CatalogTerminalSurface(props: {
  readonly phase: "loading" | "live" | "unavailable";
  readonly sessionCount: number;
  readonly note: string | null;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
  readonly onCreateSession?: () => void;
}): JSX.Element {
  const title = () => {
    if (props.phase === "loading") return "Finding tmux sessions…";
    if (props.phase === "unavailable") return "Reconnecting to tmux-ide…";
    if (props.sessionCount === 0) return "No tmux sessions are running";
    return `${props.sessionCount} tmux ${props.sessionCount === 1 ? "session" : "sessions"} available`;
  };
  const detail = () => {
    if (props.note && !props.note.startsWith("Discovering live tmux sessions")) return props.note;
    if (props.phase === "live" && props.sessionCount === 0)
      return "Start a local workspace here, or open tmux in another terminal.";
    if (props.sessionCount > 0) return "Choose a session from the sidebar to open it.";
    return null;
  };
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={1}
      overflow="hidden"
    >
      <text fg={props.theme.roles.text.primary}>
        <strong>Terminals</strong>
      </text>
      <text fg={props.theme.roles.text.secondary}>{clipTerminal(title(), props.width - 4)}</text>
      <For each={detail() ? [detail()!] : []}>
        {(message) => (
          <text fg={props.theme.roles.text.muted}>{clipTerminal(message, props.width - 4)}</text>
        )}
      </For>
      <For
        each={
          props.phase === "live" && props.sessionCount === 0 && props.onCreateSession
            ? [props.onCreateSession]
            : []
        }
      >
        {(onCreateSession) => (
          <Button
            theme={props.theme}
            label="New local session"
            shortcut="N"
            variant="primary"
            onPress={onCreateSession}
          />
        )}
      </For>
    </box>
  );
}

function CatalogStatusStrip(props: {
  readonly width: number;
  readonly surface: ApplicationCatalogSurface;
  readonly phase: "loading" | "live" | "unavailable";
  readonly sessionCount: number;
  readonly note: string | null;
  readonly theme: SemanticThemeSnapshot;
  readonly onOpenCommands: () => void;
  readonly onCreateSession?: () => void;
}): JSX.Element {
  const context = () => (props.surface === "home" ? "Home" : "Terminals");
  const message = () => {
    if (props.note && !props.note.startsWith("Discovering live tmux sessions")) return props.note;
    if (props.phase === "loading") return "Finding tmux sessions";
    if (props.phase === "unavailable") return "Reconnecting to daemon";
    return props.sessionCount === 0
      ? "No sessions running"
      : `${props.sessionCount} ${props.sessionCount === 1 ? "session" : "sessions"} live`;
  };
  const contextWidth = () => Math.min(14, Math.max(6, context().length + 2));
  const canCreate = () =>
    props.phase === "live" && props.sessionCount === 0 && Boolean(props.onCreateSession);
  const actionWidth = () => (canCreate() ? 34 : 15);
  return (
    <StatusBar theme={props.theme} width={props.width}>
      <StatusBarGroup width={contextWidth()}>
        <StatusBarSegment theme={props.theme} label={context()} width={contextWidth()} active />
      </StatusBarGroup>
      <StatusBarGroup grow>
        <StatusBarSegment
          theme={props.theme}
          label={message()}
          tone={props.phase === "unavailable" ? "blocked" : undefined}
        />
      </StatusBarGroup>
      <StatusBarGroup width={actionWidth()} align="end">
        <For each={canCreate() ? [true] : []}>
          {() => (
            <StatusBarAction
              theme={props.theme}
              label="New session"
              shortcut="N"
              width={19}
              onPress={props.onCreateSession!}
            />
          )}
        </For>
        <StatusBarAction
          theme={props.theme}
          label="Commands"
          shortcut="F5"
          width={15}
          primary
          onPress={props.onOpenCommands}
        />
      </StatusBarGroup>
    </StatusBar>
  );
}

/** Catalog-backed pre-connection shell. It never pretends to be daemon authority. */
export function ApplicationCatalogShell(props: ApplicationCatalogShellProps): JSX.Element {
  const sessions = (): readonly string[] =>
    typeof props.sessions === "function" ? props.sessions() : props.sessions;
  const chrome = createMemo(() =>
    shellChromeLayout(props.dimensions().width, props.dimensions().height, 28),
  );
  // Catalog navigation is the first-run wayfinding surface. Keep its two
  // labels visible at compact widths; the icon-only terminal chrome is useful
  // once a workspace needs every column, but is cryptic before one exists.
  const catalogChromeVariant = () =>
    chrome().variant === "compact" ? ("standard" as const) : chrome().variant;
  const phase = (): "loading" | "live" | "unavailable" =>
    props.catalogPhase?.() ?? (sessions().length > 0 ? "live" : "loading");
  const note = () => props.bootstrapNote() ?? props.catalogNote?.() ?? null;
  const homeStatus = () => {
    if (phase() === "loading") return "finding sessions";
    if (phase() === "unavailable") return "reconnecting";
    return sessions().length === 0 ? "ready" : `${sessions().length} available`;
  };
  const topStatus = () => {
    if (phase() === "loading") return " ○ finding sessions ";
    if (phase() === "unavailable") return " ! reconnecting ";
    return sessions().length === 0 ? " ○ no sessions " : ` ● ${sessions().length} live `;
  };
  const showCatalogSidebar = () => props.surface() === "terminals";
  const catalogContentWidth = () =>
    showCatalogSidebar() ? chrome().main.width : props.dimensions().width;
  const overlayLayers = (): readonly OverlayLayer[] =>
    props.paletteOpen()
      ? [
          {
            id: "palette",
            render: ({ active, zIndex }) => (
              <MinimalPalette
                width={props.dimensions().width}
                height={props.dimensions().height}
                selected={props.paletteSelection?.() ?? 0}
                query={props.paletteQuery?.() ?? ""}
                disabledReason={props.paletteDisabledReason}
                onSelect={props.onPaletteSelect}
                closeArmed={props.paletteCloseArmed?.() ?? false}
                commands={props.paletteCommands?.() ?? applicationPaletteCommands(null)}
                theme={props.theme}
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
          },
        ]
      : [];
  return (
    <Surface
      theme={props.theme}
      variant="canvas"
      width={props.dimensions().width}
      height={props.dimensions().height}
      flexDirection="column"
      overflow="hidden"
    >
      <ApplicationCatalogTabBar
        theme={props.theme}
        width={props.dimensions().width}
        variant={catalogChromeVariant()}
        views={CATALOG_VIEWS}
        activeViewId={props.surface()}
        hoveredIndex={null}
        rightChips={[
          {
            id: "catalog-status",
            label: topStatus(),
            attention: phase() === "unavailable",
            context: phase() === "loading",
          },
        ]}
        onSelectView={(viewId) => {
          if (viewId === "home" || viewId === "terminals") props.onOpenSurface(viewId, "mouse");
        }}
      />
      <box height={chrome().sidebar.height} flexDirection="row" overflow="hidden">
        <For each={showCatalogSidebar() ? [true] : []}>
          {() => (
            <Surface
              theme={props.theme}
              variant="panel"
              width={chrome().sidebar.width}
              height={chrome().sidebar.height}
              flexDirection="column"
              paddingLeft={1}
            >
              <text fg={props.theme.roles.text.secondary} bg={props.theme.roles.surfaces.panel}>
                Sessions
              </text>
              <For each={sessions()}>
                {(session, index) => (
                  <NavigationRow
                    theme={props.theme}
                    id={`catalog-session:${session}`}
                    label={friendlySessionLabel(session)}
                    width={Math.max(1, chrome().sidebar.width - 1)}
                    marker={props.selectedSession() === index() ? "›" : "○"}
                    selected={props.selectedSession() === index()}
                    onActivate={(source) => props.onOpenSession(session, source)}
                  />
                )}
              </For>
              <For each={sessions().length === 0 ? [true] : []}>
                {() => (
                  <text fg={props.theme.roles.text.muted} bg={props.theme.roles.surfaces.panel}>
                    {" No sessions yet"}
                  </text>
                )}
              </For>
              <box flexGrow={1} />
            </Surface>
          )}
        </For>
        <box
          width={catalogContentWidth()}
          height={chrome().main.height}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexGrow={1} overflow="hidden">
            <Show
              when={props.surface() === "home"}
              fallback={
                <CatalogTerminalSurface
                  phase={phase()}
                  sessionCount={sessions().length}
                  note={note()}
                  width={catalogContentWidth()}
                  height={Math.max(1, chrome().main.height - chrome().status.height)}
                  theme={props.theme}
                  onCreateSession={props.onCreateSession}
                />
              }
            >
              <ApplicationHomeSurface
                {...props.homeAgents}
                project="tmux-ide"
                status={homeStatus()}
                note={note()}
                width={catalogContentWidth()}
                height={Math.max(1, chrome().main.height - chrome().status.height)}
                sessionCount={sessions().length}
                session={
                  sessions()[props.selectedSession()]
                    ? friendlySessionLabel(sessions()[props.selectedSession()]!)
                    : null
                }
                branded={true}
                theme={props.theme}
                onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                onCycleTheme={props.onCycleTheme}
              />
            </Show>
          </box>
          <Show when={chrome().status.height > 0}>
            <CatalogStatusStrip
              width={catalogContentWidth()}
              surface={props.surface()}
              phase={phase()}
              sessionCount={sessions().length}
              note={note()}
              theme={props.theme}
              onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
              onCreateSession={props.onCreateSession}
            />
          </Show>
        </box>
      </box>
      <ApplicationShellOverlayStack
        width={props.dimensions().width}
        height={props.dimensions().height}
        layers={overlayLayers()}
        focusedOwner={`surface:${props.surface()}`}
        isFocusMounted={() => true}
        restoreFocus={() => undefined}
        onIntent={({ id }) => {
          if (id === "palette") props.onSetPaletteOpen(false, "keyboard");
        }}
      />
    </Surface>
  );
}
