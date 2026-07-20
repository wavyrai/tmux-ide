/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { AgentTerminalCanvasProjection } from "./agent-terminal-canvas.ts";

export interface AgentTerminalCanvasProps {
  theme: SemanticThemeSnapshot;
  projection: AgentTerminalCanvasProjection;
  chrome: JSX.Element;
  framebuffer: JSX.Element;
  footer?: JSX.Element;
}

/** Presentational boundary; the application root remains the sole input owner. */
export function AgentTerminalCanvas(props: AgentTerminalCanvasProps) {
  return (
    <box
      position="relative"
      width={props.projection.width}
      height={props.projection.height}
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <box
        position="absolute"
        left={props.projection.chrome.x}
        top={props.projection.chrome.y}
        width={props.projection.chrome.width}
        height={props.projection.chrome.height}
        flexDirection="column"
        overflow="hidden"
      >
        {props.chrome}
      </box>
      <box
        position="absolute"
        left={props.projection.framebuffer.x}
        top={props.projection.framebuffer.y}
        width={props.projection.framebuffer.width}
        height={props.projection.framebuffer.height}
        backgroundColor={props.theme.colors.background}
        overflow="hidden"
      >
        {props.framebuffer}
      </box>
      <Show when={props.projection.footer.height > 0 && props.footer}>
        <box
          position="absolute"
          left={props.projection.footer.x}
          top={props.projection.footer.y}
          width={props.projection.footer.width}
          height={props.projection.footer.height}
          overflow="hidden"
        >
          {props.footer as JSX.Element}
        </box>
      </Show>
    </box>
  );
}
