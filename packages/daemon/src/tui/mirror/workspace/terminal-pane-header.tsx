/* @jsxImportSource @opentui/solid */
import type { AgentActivity } from "@tmux-ide/contracts";

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
  readonly activity?: AgentActivity;
  readonly attention?: boolean;
  /** Renderer-global anchor used by the keyboard-operable overflow control. */
  readonly menuAnchor: Readonly<{ x: number; y: number }>;
  readonly menuFocused?: boolean;
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
    case "disconnected":
      return "unknown";
    default:
      return undefined;
  }
}

function badgeWidth(status: AgentBadgeStatus | undefined): number {
  return status ? Math.min(10, terminalDisplayWidth(status) + 4) : 0;
}

/**
 * One-row terminal pane chrome. The terminal framebuffer remains a sibling and
 * none of this component's hit targets extend into the pane body.
 */
export function PaneTitleBar(props: PaneTitleBarProps) {
  const safeWidth = () => Math.max(1, Math.floor(props.width));
  const status = () => agentStatus(props.activity);
  // Keep the state glyph out of the first two inline cells. OpenTUI can repaint
  // those cells from the clipped parent during nested workspace composition.
  const markerGutterWidth = () => Math.min(2, safeWidth());
  const markerWidth = () => Math.min(2, safeWidth());
  const actionWidth = () => (safeWidth() >= 6 && !props.menuDisabled ? 3 : 0);
  const showBadge = () =>
    Boolean(
      status() &&
      safeWidth() >= markerGutterWidth() + markerWidth() + actionWidth() + badgeWidth(status()) + 4,
    );
  const titleWidth = () =>
    Math.max(
      0,
      safeWidth() -
        markerGutterWidth() -
        markerWidth() -
        actionWidth() -
        (showBadge() ? badgeWidth(status()) : 0),
    );
  const palette = () =>
    componentPalette(props.theme, {
      selected: props.selected,
      focused: props.keyboardFocused || props.terminalFocused,
      hovered: props.hovered,
      attention: props.attention,
      status: status(),
    });
  // Hierarchy belongs to the title, not the status badge: an inactive pane is
  // quieter, while selection or either input focus keeps its name prominent.
  const titleEmphasized = () => props.selected || props.keyboardFocused || props.terminalFocused;
  const titleForeground = () =>
    titleEmphasized() || props.hovered || props.attention
      ? palette().foreground
      : props.theme.roles.text.secondary;
  const activateMenu = () => {
    if (!props.menuDisabled) props.onMenuIntent(props.menuAnchor);
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
      onMouseDown={(event) => {
        if (event.button === 2) {
          event.preventDefault();
          event.stopPropagation();
          props.onMenuIntent({ x: event.x, y: event.y });
          return;
        }
        if (event.button !== 0) return;
        event.stopPropagation();
        props.onSelectIntent();
      }}
    >
      <text
        width={markerGutterWidth()}
        height={1}
        flexShrink={0}
        bg={palette().background}
        onMouseDown={(event) => {
          if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            props.onMenuIntent({ x: event.x, y: event.y });
            return;
          }
          if (event.button !== 0) return;
          event.stopPropagation();
          props.onSelectIntent();
        }}
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
      {showBadge() ? (
        <AgentBadge
          theme={props.theme}
          label={status()!}
          status={status()!}
          width={badgeWidth(status())}
          selected={props.selected}
          focused={props.keyboardFocused || props.terminalFocused}
          hovered={props.hovered}
          attention={props.attention}
        />
      ) : null}
      {actionWidth() > 0 ? (
        <IconButton
          theme={props.theme}
          icon="⋯"
          label="Pane actions"
          variant="ghost"
          width={actionWidth()}
          focused={props.menuFocused}
          background={palette().background}
          onPress={activateMenu}
        />
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
