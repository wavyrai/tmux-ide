/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { For, Show } from "solid-js";
import { recipePalette } from "../recipes.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type {
  WorkbenchDockActionProjection,
  WorkbenchDockTabProjection,
  WorkbenchShellProjection,
} from "./workbench-shell.ts";

export interface WorkbenchShellProps {
  theme: SemanticThemeSnapshot;
  projection: WorkbenchShellProjection;
  canvas: JSX.Element;
  dockBody: JSX.Element;
}

/**
 * Presentational agent canvas and bottom dock. The application root owns all
 * keyboard, pointer, persistence, runtime, and renderer lifecycle behavior.
 */
export function WorkbenchShell(props: WorkbenchShellProps) {
  const canvasFocused = () => props.projection.focusZone === "canvas";
  const dockBodyFocused = () => props.projection.focusZone === "dock-body";
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      flexDirection="column"
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <box
        width={props.projection.canvas.width}
        height={props.projection.canvas.height}
        flexDirection="row"
        backgroundColor={props.theme.colors.background}
        overflow="hidden"
      >
        <FocusRail
          theme={props.theme}
          width={props.projection.canvasRail.width}
          height={props.projection.canvasRail.height}
          focused={canvasFocused()}
        />
        <box
          width={props.projection.canvasBody.width}
          height={props.projection.canvasBody.height}
          flexDirection="column"
          overflow="hidden"
        >
          {props.canvas}
        </box>
      </box>

      <DockTabBar theme={props.theme} projection={props.projection} />

      <Show when={props.projection.dockBody.height > 0}>
        <box
          width={props.projection.dockBody.width}
          height={props.projection.dockBody.height}
          flexDirection="row"
          backgroundColor={props.theme.colors.surface}
          overflow="hidden"
        >
          <FocusRail
            theme={props.theme}
            width={props.projection.dockBodyRail.width}
            height={props.projection.dockBodyRail.height}
            focused={dockBodyFocused()}
          />
          <box
            width={props.projection.dockBodyContent.width}
            height={props.projection.dockBodyContent.height}
            flexDirection="column"
            overflow="hidden"
          >
            {props.dockBody}
          </box>
        </box>
      </Show>
    </box>
  );
}

function DockTabBar(props: { theme: SemanticThemeSnapshot; projection: WorkbenchShellProjection }) {
  return (
    <box
      width={props.projection.dockTabs.width}
      height={props.projection.dockTabs.height}
      position="relative"
      backgroundColor={props.theme.colors.surfaceRaised}
      overflow="hidden"
    >
      <For each={props.projection.tabs}>{(tab) => <DockTab theme={props.theme} tab={tab} />}</For>
      <For each={props.projection.actions}>
        {(action) => <DockAction theme={props.theme} action={action} />}
      </For>
    </box>
  );
}

function DockTab(props: { theme: SemanticThemeSnapshot; tab: WorkbenchDockTabProjection }) {
  const palette = () =>
    recipePalette(props.theme, {
      selected: props.tab.selected,
      focused: props.tab.focused,
      hovered: props.tab.hovered,
      attention: props.tab.attention,
      disabled: props.tab.disabled,
    });
  return (
    <box
      position="absolute"
      left={props.tab.x}
      top={0}
      width={props.tab.width}
      height={1}
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <text fg={palette().foreground} attributes={props.tab.focused ? 1 : 0}>
        {props.tab.label}
      </text>
    </box>
  );
}

function DockAction(props: {
  theme: SemanticThemeSnapshot;
  action: WorkbenchDockActionProjection;
}) {
  const palette = () => recipePalette(props.theme, { selected: props.action.active });
  return (
    <box
      position="absolute"
      left={props.action.x}
      top={0}
      width={props.action.width}
      height={1}
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <text fg={palette().foreground}>{props.action.label}</text>
    </box>
  );
}

function FocusRail(props: {
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
