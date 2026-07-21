/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";
import {
  WorkbenchDockPresenter,
  type WorkbenchDockHostActionId,
  type WorkbenchDockHostActivationSource,
  type WorkbenchDockHostLeaves,
  type WorkbenchDockHostMode,
  type WorkbenchDockHostTab,
  type WorkbenchDockHostTabId,
} from "../../../ui/workbench-dock/presenter.tsx";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { WorkbenchShellProjection } from "./workbench-shell.ts";

export interface OpenTuiWorkbenchDockProps {
  theme: SemanticThemeSnapshot;
  projection: WorkbenchShellProjection;
  body: JSX.Element;
  onTabActivate?: (
    tabId: WorkbenchDockHostTabId,
    source: WorkbenchDockHostActivationSource,
  ) => void;
  onActionActivate?: (
    actionId: WorkbenchDockHostActionId,
    nextMode: WorkbenchDockHostMode,
    source: WorkbenchDockHostActivationSource,
  ) => void;
}

/** OpenTUI leaves for the shared dock presenter; the root app still owns input. */
export function OpenTuiWorkbenchDock(props: OpenTuiWorkbenchDockProps) {
  const host = createOpenTuiWorkbenchDockHost(() => props.theme);
  return (
    <WorkbenchDockPresenter
      host={host}
      projection={props.projection}
      body={props.body}
      onTabActivate={props.onTabActivate}
      onActionActivate={props.onActionActivate}
    />
  );
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
          backgroundColor={theme().roles.surfaces.panelRaised}
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
          onMouseDown={
            props.onActivate
              ? (event) => {
                  event.stopPropagation();
                  props.onActivate?.("mouse");
                }
              : undefined
          }
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
              foreground: theme().roles.selection.selectionText,
              background: theme().roles.selection.selection,
            }
          : {
              foreground: theme().roles.text.primary,
              background: theme().roles.surfaces.panel,
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
          onMouseDown={
            props.onActivate
              ? (event) => {
                  event.stopPropagation();
                  props.onActivate?.("mouse");
                }
              : undefined
          }
        >
          <text fg={palette().foreground}>{props.action.label}</text>
        </box>
      );
    },
    Body(props) {
      return (
        <Show when={props.active && props.visible}>
          <box
            width={props.projection.dockBody.width}
            height={props.projection.dockBody.height}
            flexDirection="row"
            backgroundColor={theme().roles.surfaces.panel}
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
        </Show>
      );
    },
  };
}

function tabPalette(theme: SemanticThemeSnapshot, tab: WorkbenchDockHostTab) {
  if (tab.disabled) {
    return {
      foreground: theme.roles.text.muted,
      background: theme.roles.selection.disabled,
    };
  }
  if (tab.selected) {
    return {
      foreground: theme.roles.selection.selectionText,
      background: theme.roles.selection.selection,
    };
  }
  if (tab.attention) {
    return {
      foreground: theme.roles.text.primary,
      background: theme.derived.attentionSurface,
    };
  }
  if (tab.hovered) {
    return {
      foreground: theme.roles.text.primary,
      background: theme.roles.selection.hover,
    };
  }
  return {
    foreground: theme.roles.text.primary,
    background: theme.roles.surfaces.panel,
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
      backgroundColor={props.theme.roles.surfaces.canvas}
      overflow="hidden"
    >
      <text
        fg={props.focused ? props.theme.roles.borders.focused : props.theme.roles.borders.subtle}
      >
        {props.focused ? "▌" : "│"}
      </text>
    </box>
  );
}
