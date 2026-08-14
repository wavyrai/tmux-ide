/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";

import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import type {
  SemanticThemeSnapshot,
  TerminalPaletteProjection,
} from "../theme.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { PaneScopedTerminalSurface } from "./pane-scoped-terminal-surface.tsx";
import { projectOpenTuiPaneFrames } from "./terminal-layout-projection.ts";

export interface ApplicationTerminalWorkspaceProps {
  readonly layout: OpenTuiWorkspaceLayoutSnapshot;
  readonly adapter: PaneScopedTerminalAdapter | null;
  readonly rendererEpoch: number;
  readonly width: number;
  readonly height: number;
  readonly focusedPane: string | null;
  readonly theme: SemanticThemeSnapshot;
  readonly palette: TerminalPaletteProjection;
  readonly onSelectPane: (paneId: string) => void;
}

function titleOf(layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number]): string {
  return layout.windowName ?? layout.semanticWindowId ?? "window";
}

function paneForWindow(
  layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
): string | null {
  return (
    layout.panes.find((pane) => pane.active && pane.pane)?.pane ??
    layout.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

/**
 * Renderer-only terminal composition. Canonical layout and terminal cells are
 * supplied by the generation host; this component owns no daemon lifecycle,
 * replica reduction, authority queue, or optional tool surface.
 */
export function ApplicationTerminalWorkspace(props: ApplicationTerminalWorkspaceProps) {
  return (
    <>
      <box
        position="absolute"
        left={0}
        top={1}
        width={props.width}
        height={1}
        backgroundColor={props.theme.roles.surfaces.panel}
        flexDirection="row"
      >
        <Show
          when={props.layout.windows.length > 0}
          fallback={<text fg={props.theme.roles.text.muted}> no terminal windows </text>}
        >
          <For each={props.layout.windows}>
            {(window) => (
              <text
                fg={
                  window.currentWindow
                    ? props.theme.roles.text.link
                    : props.theme.roles.text.secondary
                }
                attributes={window.currentWindow ? 1 : 0}
                onMouseDown={() => {
                  const pane = paneForWindow(window);
                  if (pane) props.onSelectPane(pane);
                }}
              >
                {` ${titleOf(window)} `}
              </text>
            )}
          </For>
        </Show>
      </box>
      <Show when={props.adapter}>
        {(adapter) => (
          <For
            each={projectOpenTuiPaneFrames(props.layout.current, {
              width: props.width,
              height: props.height,
            })}
          >
            {(frame) => (
              <box
                position="absolute"
                left={frame.left}
                top={frame.top + 2}
                width={frame.width}
                height={frame.height}
                backgroundColor={props.theme.roles.surfaces.canvas}
                onMouseDown={() => props.onSelectPane(frame.paneId)}
              >
                <box
                  position="absolute"
                  left={0}
                  top={0}
                  width={frame.width}
                  height={1}
                  backgroundColor={props.theme.roles.surfaces.command}
                >
                  <text
                    fg={
                      props.focusedPane === frame.paneId
                        ? props.theme.roles.text.link
                        : props.theme.roles.text.secondary
                    }
                  >
                    {`${props.focusedPane === frame.paneId ? "●" : "○"} ${frame.paneId}`.slice(
                      0,
                      frame.width,
                    )}
                  </text>
                </box>
                <box
                  position="absolute"
                  left={0}
                  top={1}
                  width={frame.width}
                  height={frame.contentHeight}
                >
                  <PaneScopedTerminalSurface
                    adapter={adapter()}
                    paneId={frame.paneId}
                    width={frame.width}
                    height={frame.contentHeight}
                    defaultFg={props.palette.foreground}
                    defaultBg={props.palette.background}
                    terminalPalette={props.palette}
                    searchHl={props.palette.searchHighlight}
                    searchCur={props.palette.searchCurrent}
                    scrollOffset={0}
                    paneFocused={props.focusedPane === frame.paneId}
                    sourceEpoch={props.rendererEpoch}
                    selRange={null}
                    search={null}
                  />
                </box>
              </box>
            )}
          </For>
        )}
      </Show>
    </>
  );
}
