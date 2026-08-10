/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { ShellMiniSidebar, ShellStatusStrip, ShellTabBar } from "../shell-chrome.tsx";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { ApplicationShellProjection } from "./application-shell.ts";

export interface ApplicationShellProps {
  theme: SemanticThemeSnapshot;
  projection: ApplicationShellProjection;
  help: string;
  interactionMode?: string | null;
  focusLabel?: string | null;
  note?: string | null;
  sidebar?: JSX.Element;
  rightChips?: readonly {
    id: string;
    label: string;
    hovered?: boolean;
    context?: boolean;
    attention?: boolean;
  }[];
  children: JSX.Element;
}

/**
 * Presentational application frame. It deliberately owns no keyboard hooks,
 * renderer lifecycle, tmux connection, filesystem access, or mutable store.
 */
export function ApplicationShell(props: ApplicationShellProps) {
  return (
    <box
      width={props.projection.layout.width}
      height={props.projection.layout.height}
      flexDirection="column"
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <ShellTabBar
        theme={props.theme}
        width={props.projection.layout.width}
        variant={props.projection.layout.variant}
        views={props.projection.views}
        activeViewId={props.projection.activeViewId}
        hoveredIndex={props.projection.tabs.findIndex((tab) => tab.hovered)}
        attentionViewIds={
          new Set(props.projection.tabs.filter((tab) => tab.attention).map((tab) => tab.id))
        }
        note={props.note}
        rightChips={props.rightChips}
        navigationFocused={props.projection.navigation.focused}
      />
      <box
        width={props.projection.layout.width}
        height={props.projection.layout.sidebar.height}
        flexDirection="row"
        overflow="hidden"
      >
        {props.sidebar ?? (
          <ShellMiniSidebar
            theme={props.theme}
            width={props.projection.layout.sidebar.width}
            variant={props.projection.layout.variant}
            sessions={props.projection.sessions}
            active={props.projection.activeSession}
            hint={props.projection.sidebarHint}
          />
        )}
        <box
          width={props.projection.layout.main.width}
          height={props.projection.layout.main.height}
          flexDirection="column"
          overflow="hidden"
        >
          <box
            width={props.projection.content.width}
            height={props.projection.content.height}
            flexDirection="column"
            overflow="hidden"
          >
            {props.children}
          </box>
          <ShellStatusStrip
            theme={props.theme}
            layout={props.projection.layout}
            project={props.projection.semantic.project.name}
            mode={
              props.projection.semantic.primaryNavigation.items.find(
                (item) => item.id === props.projection.semantic.workspaceCanvas.activeMode,
              )?.label ?? props.projection.semantic.workspaceCanvas.activeMode
            }
            inputMode={props.interactionMode}
            tool={
              props.projection.semantic.bottomDock.tools.find(
                (item) => item.id === props.projection.semantic.bottomDock.activeTool,
              )?.label ?? props.projection.semantic.bottomDock.activeTool
            }
            dockMode={props.projection.semantic.bottomDock.mode}
            focus={props.focusLabel ?? applicationShellFocusLabel(props.projection)}
            notification={props.projection.semantic.statusStrip.message}
            help={props.help}
          />
        </box>
      </box>
    </box>
  );
}

function applicationShellFocusLabel(projection: ApplicationShellProjection): string {
  const zone = projection.semantic.focus.zone;
  if (projection.semantic.focus.overlays.length > 0) return "palette";
  if (zone === "terminal") return "terminal";
  if (zone === "dock-tabs") return "tool tabs";
  if (zone === "dock-body") {
    return (
      projection.semantic.bottomDock.tools
        .find((item) => item.id === projection.semantic.bottomDock.activeTool)
        ?.label.toLowerCase() ?? "tool"
    );
  }
  if (zone === "primary-navigation") return "workspace tabs";
  return zone.replaceAll("-", " ");
}
