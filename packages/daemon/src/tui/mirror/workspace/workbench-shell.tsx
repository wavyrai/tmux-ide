/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { OpenTuiWorkbenchDock } from "./workbench-dock-opentui.tsx";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { WorkbenchShellProjection } from "./workbench-shell.ts";

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

      <OpenTuiWorkbenchDock
        theme={props.theme}
        projection={props.projection}
        body={props.dockBody}
      />
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
