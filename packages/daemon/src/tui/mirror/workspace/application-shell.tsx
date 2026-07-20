/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { ShellMiniSidebar, ShellStatusStrip, ShellTabBar } from "../shell-chrome.tsx";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { ApplicationShellProjection } from "./application-shell.ts";

export interface ApplicationShellProps {
  theme: SemanticThemeSnapshot;
  projection: ApplicationShellProjection;
  project: string;
  mode: string;
  notification: string | null;
  help: string;
  note?: string | null;
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
      />
      <box
        width={props.projection.layout.width}
        height={props.projection.layout.sidebar.height}
        flexDirection="row"
        overflow="hidden"
      >
        <ShellMiniSidebar
          theme={props.theme}
          width={props.projection.layout.sidebar.width}
          variant={props.projection.layout.variant}
          sessions={props.projection.sessions}
          active={props.projection.activeSession}
          hint={props.projection.sidebarHint}
        />
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
            project={props.project}
            mode={props.mode}
            notification={props.notification}
            help={props.help}
          />
        </box>
      </box>
    </box>
  );
}
