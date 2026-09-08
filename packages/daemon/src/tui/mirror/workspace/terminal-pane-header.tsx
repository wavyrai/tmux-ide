/* @jsxImportSource @opentui/solid */
import { paneInteractionPresence, type PaneInteractionProjection } from "@tmux-ide/core";
import { Badge } from "../ui/badge.tsx";
import type { AgentActivity } from "@tmux-ide/contracts";
import { createSignal, Show } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { AgentBadge, IconButton, componentPalette, type AgentBadgeStatus } from "../ui/index.ts";

type PaneHeaderPointerEvent = {
  readonly button?: number;
  readonly x: number;
  readonly y: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

export interface PaneTitleBarProps {
  readonly theme: SemanticThemeSnapshot;
  readonly paneId: string;
  readonly title: string;
  readonly width: number;
  readonly selected: boolean;
  readonly terminalFocused: boolean;
  readonly keyboardFocused: boolean;
  readonly hovered?: boolean;
  readonly zoomed?: boolean;
  readonly onRestoreIntent?: () => void;
  readonly activity?: AgentActivity;
  readonly interaction?: PaneInteractionProjection;
  readonly attention?: boolean;
  /** Renderer-global anchor used by the keyboard-operable overflow control. */
  readonly menuAnchor: Readonly<{ x: number; y: number }>;
  readonly menuFocused?: boolean;
  /** Keeps contextual actions visible while their menu owns input. */
  readonly menuOpen?: boolean;
  readonly menuDisabled?: boolean;
  readonly onSelectIntent: () => void;
  readonly onMenuIntent: (anchor: Readonly<{ x: number; y: number }>) => void;
}

/** Compatibility props retained while callers migrate to `PaneTitleBar`. */
export interface TerminalPaneHeaderProps {
  theme: SemanticThemeSnapshot;
  paneId: string;
  title: string;
  width: number;
  focused: boolean;
  terminalFocused: boolean;
  activity?: AgentActivity;
  attention?: boolean;
  menuAnchor?: Readonly<{ x: number; y: number }>;
  onSelect: () => void;
  onOpenMenu: (event: PaneHeaderPointerEvent) => void;
}

function agentStatus(activity: AgentActivity | undefined): AgentBadgeStatus | undefined {
  switch (activity) {
    case "running":
      return "working";
    case "waiting":
      return "blocked";
    case "complete":
      return "done";
    case "idle":
      return "idle";
    case "failed":
      return "blocked";
    case "disconnected":
      return "unknown";
    default:
      return undefined;
  }
}

function badgeWidth(status: string | undefined): number {
  return status ? terminalDisplayWidth(status) + 4 : 0;
}

/**
 * One-row terminal pane chrome. The terminal framebuffer remains a sibling and
 * none of this component's hit targets extend into the pane body.
 */
export function PaneTitleBar(props: PaneTitleBarProps) {
  const [pointerInside, setPointerInside] = createSignal(false);
  const hovered = () => props.hovered ?? pointerInside();
  const safeWidth = () => Math.max(1, Math.floor(props.width));
  const status = () => agentStatus(props.activity);
  const statusLabel = () =>
    props.activity === "failed"
      ? "failed"
      : props.activity === "disconnected"
        ? "disconnected"
        : status();
  const presence = () => (props.interaction ? paneInteractionPresence(props.interaction) : null);
  const activityLabel = () =>
    presence()
      ? `${presence()!.badge}${props.interaction?.origin === "external" ? " · External tmux" : ""}`
      : "";
  const activityWidth = () => {
    const available =
      safeWidth() - markerGutterWidth() - markerWidth() - actionWidth() - zoomWidth() - 4;
    if (!presence() || available < presence()!.badge.length + 2) return 0;
    return Math.min(available, terminalDisplayWidth(activityLabel()) + 2);
  };
  // Capture one non-null presence for each badge lifetime. A retiring child's
  // queued style effect must not dereference the parent's now-expired receipt.
  const activityBadge = () => {
    const current = presence();
    const width = activityWidth();
    return current && width > 0 ? { presence: current, width, label: activityLabel() } : null;
  };
  // Keep the state glyph out of the first two inline cells. OpenTUI can repaint
  // those cells from the clipped parent during nested workspace composition.
  const markerGutterWidth = () => Math.min(2, safeWidth());
  const markerWidth = () => Math.min(2, safeWidth());
  // Reserve these cells even when the control is quiet or unavailable. Hover
  // and menu lifetime must never change title clipping or terminal geometry.
  const actionWidth = () => (safeWidth() >= 7 ? 3 : 0);
  const actionsVisible = () =>
    props.selected ||
    props.keyboardFocused ||
    props.terminalFocused ||
    hovered() ||
    props.menuFocused ||
    props.menuOpen;
  const zoomLabel = () =>
    !props.zoomed
      ? ""
      : safeWidth() >= 32
        ? " Zoomed · Restore "
        : safeWidth() >= 16
          ? " Zoomed "
          : " Z ";
  const zoomWidth = () =>
    Math.min(
      terminalDisplayWidth(zoomLabel()),
      Math.max(0, safeWidth() - markerGutterWidth() - markerWidth() - actionWidth()),
    );
  const showBadge = () =>
    Boolean(
      status() &&
      safeWidth() >=
        markerGutterWidth() +
          markerWidth() +
          actionWidth() +
          zoomWidth() +
          activityWidth() +
          badgeWidth(statusLabel()) +
          4,
    );
  const titleWidth = () =>
    Math.max(
      0,
      safeWidth() -
        markerGutterWidth() -
        markerWidth() -
        actionWidth() -
        zoomWidth() -
        activityWidth() -
        (showBadge() ? badgeWidth(statusLabel()) : 0),
    );
  const palette = () =>
    componentPalette(props.theme, {
      selected: props.selected,
      focused: props.keyboardFocused || props.terminalFocused,
      hovered: hovered(),
      attention: props.attention,
      status: status(),
    });
  // Hierarchy belongs to the title, not the status badge: an inactive pane is
  // quieter, while selection or either input focus keeps its name prominent.
  const titleEmphasized = () => props.selected || props.keyboardFocused || props.terminalFocused;
  const titleForeground = () =>
    titleEmphasized() || hovered() || props.attention
      ? palette().foreground
      : props.theme.roles.text.secondary;
  const activateMenu = (anchor = props.menuAnchor) => {
    if (!props.menuDisabled) props.onMenuIntent(anchor);
  };
  const selectOrOpenMenu = (event: PaneHeaderPointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    if (event.button === 2) activateMenu({ x: event.x, y: event.y });
    else props.onSelectIntent();
  };

  return (
    <box
      id={`pane-title-bar:${props.paneId}`}
      position="absolute"
      left={0}
      top={0}
      width={safeWidth()}
      height={1}
      zIndex={2}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={palette().background}
      onMouseOver={() => setPointerInside(true)}
      onMouseOut={() => setPointerInside(false)}
      onMouseDown={selectOrOpenMenu}
    >
      <text
        width={markerGutterWidth()}
        height={1}
        flexShrink={0}
        bg={palette().background}
        onMouseDown={selectOrOpenMenu}
      >
        {" ".repeat(markerGutterWidth())}
      </text>
      <text
        width={markerWidth()}
        height={1}
        flexShrink={0}
        overflow="hidden"
        fg={palette().accent}
        bg={palette().background}
      >
        {clipTerminal(`${palette().marker} `, markerWidth())}
      </text>
      {titleWidth() > 0 ? (
        <text
          width={titleWidth()}
          height={1}
          overflow="hidden"
          fg={titleForeground()}
          bg={palette().background}
        >
          {titleEmphasized() ? (
            <strong>{clipTerminal(props.title, titleWidth())}</strong>
          ) : (
            clipTerminal(props.title, titleWidth())
          )}
        </text>
      ) : null}
      {zoomWidth() > 0 ? (
        <text
          width={zoomWidth()}
          height={1}
          flexShrink={0}
          fg={palette().accent}
          bg={palette().background}
          onMouseDown={(event: PaneHeaderPointerEvent) => {
            if (event.button !== 0) return;
            event.preventDefault?.();
            event.stopPropagation?.();
            props.onRestoreIntent?.();
          }}
        >
          {clipTerminal(zoomLabel(), zoomWidth())}
        </text>
      ) : null}
      <Show when={activityBadge()} keyed>
        {(activity) => (
          <Badge
            theme={props.theme}
            label={activity.label}
            width={activity.width}
            tone={
              activity.presence.tone === "danger"
                ? "destructive"
                : activity.presence.tone === "info"
                  ? "accent"
                  : "done"
            }
            selected={props.selected}
            focused={props.keyboardFocused || props.terminalFocused}
          />
        )}
      </Show>
      {showBadge() ? (
        <AgentBadge
          theme={props.theme}
          label={statusLabel()!}
          status={status()!}
          width={badgeWidth(statusLabel())}
          selected={props.selected}
          focused={props.keyboardFocused || props.terminalFocused}
          hovered={hovered()}
          attention={props.attention}
        />
      ) : null}
      {actionWidth() > 0 ? (
        <box width={actionWidth()} height={1} flexShrink={0}>
          <IconButton
            theme={props.theme}
            icon={actionsVisible() ? "⋯" : " "}
            label="Pane actions"
            variant="ghost"
            width={actionWidth()}
            focused={props.menuFocused}
            selected={props.menuOpen}
            disabled={props.menuDisabled}
            background={palette().background}
            onPress={() => activateMenu()}
          />
        </box>
      ) : null}
    </box>
  );
}

/** @deprecated Production callers should use `PaneTitleBar`. */
export function TerminalPaneHeader(props: TerminalPaneHeaderProps) {
  const fallbackAnchor = () => props.menuAnchor ?? { x: Math.max(0, props.width - 1), y: 0 };
  return (
    <PaneTitleBar
      theme={props.theme}
      paneId={props.paneId}
      title={props.title}
      width={props.width}
      selected={props.focused}
      terminalFocused={props.terminalFocused}
      keyboardFocused={props.focused}
      activity={props.activity}
      attention={props.attention}
      menuAnchor={fallbackAnchor()}
      onSelectIntent={props.onSelect}
      onMenuIntent={(anchor) => props.onOpenMenu({ button: 0, ...anchor })}
    />
  );
}
