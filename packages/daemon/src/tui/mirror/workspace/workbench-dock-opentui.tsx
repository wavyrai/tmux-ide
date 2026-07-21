/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import {
  WorkbenchDockPresenter,
  type WorkbenchDockHostLeaves,
  type WorkbenchDockHostTab,
} from "../../../ui/workbench-dock/presenter.tsx";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { WorkbenchShellProjection } from "./workbench-shell.ts";

export interface OpenTuiWorkbenchDockProps {
  theme: SemanticThemeSnapshot;
  projection: WorkbenchShellProjection;
  body: JSX.Element;
}

/** OpenTUI leaves for the shared dock presenter; the root app still owns input. */
export function OpenTuiWorkbenchDock(props: OpenTuiWorkbenchDockProps) {
  const host = createOpenTuiWorkbenchDockHost(() => props.theme);
  return <WorkbenchDockPresenter host={host} projection={props.projection} body={props.body} />;
}

export function createOpenTuiWorkbenchDockHost(
  theme: () => SemanticThemeSnapshot,
): WorkbenchDockHostLeaves {
  return {
    Root(props) {
      return <>{props.children}</>;
    },
    TabBar(props) {
      return (
        <box
          width={props.projection.dockTabs.width}
          height={props.projection.dockTabs.height}
          position="relative"
          backgroundColor={theme().colors.surfaceRaised}
          overflow="hidden"
        >
          {props.children}
        </box>
      );
    },
    TabList(props) {
      return <>{props.children}</>;
    },
    Tab(props) {
      const palette = () => tabPalette(theme(), props.tab);
      return (
        <box
          position="absolute"
          left={props.tab.x}
          top={0}
          width={props.tab.width}
          height={1}
          backgroundColor={palette().background}
          overflow="hidden"
          onMouseDown={props.onActivate ? () => props.onActivate?.() : undefined}
        >
          <text fg={palette().foreground} attributes={props.tab.focused ? 1 : 0}>
            {props.tab.label}
          </text>
        </box>
      );
    },
    ActionList(props) {
      return <>{props.children}</>;
    },
    Action(props) {
      const palette = () =>
        props.action.active
          ? {
              foreground: theme().colors.selectionForeground,
              background: theme().colors.selection,
            }
          : {
              foreground: theme().colors.foreground,
              background: theme().colors.surface,
            };
      return (
        <box
          position="absolute"
          left={props.action.x}
          top={0}
          width={props.action.width}
          height={1}
          backgroundColor={palette().background}
          overflow="hidden"
          onMouseDown={props.onActivate ? () => props.onActivate?.() : undefined}
        >
          <text fg={palette().foreground}>{props.action.label}</text>
        </box>
      );
    },
    Body(props) {
      return (
        <box
          width={props.projection.dockBody.width}
          height={props.projection.dockBody.height}
          flexDirection="row"
          backgroundColor={theme().colors.surface}
          overflow="hidden"
        >
          <DockFocusRail
            theme={theme()}
            width={props.projection.dockBodyRail.width}
            height={props.projection.dockBodyRail.height}
            focused={props.focused}
          />
          <box
            width={props.projection.dockBodyContent.width}
            height={props.projection.dockBodyContent.height}
            flexDirection="column"
            overflow="hidden"
          >
            {props.children}
          </box>
        </box>
      );
    },
  };
}

function tabPalette(theme: SemanticThemeSnapshot, tab: WorkbenchDockHostTab) {
  if (tab.disabled) {
    return {
      foreground: theme.colors.mutedForeground,
      background: theme.colors.surface,
    };
  }
  if (tab.selected) {
    return {
      foreground: theme.colors.selectionForeground,
      background: theme.colors.selection,
    };
  }
  if (tab.attention) {
    return {
      foreground: theme.colors.foreground,
      background: theme.colors.attention,
    };
  }
  if (tab.hovered) {
    return {
      foreground: theme.colors.foreground,
      background: theme.colors.hover,
    };
  }
  return {
    foreground: theme.colors.foreground,
    background: theme.colors.surface,
  };
}

function DockFocusRail(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  height: number;
  focused: boolean;
}) {
  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <text fg={props.focused ? props.theme.colors.focus : props.theme.colors.border}>
        {props.focused ? "▌" : "│"}
      </text>
    </box>
  );
}
