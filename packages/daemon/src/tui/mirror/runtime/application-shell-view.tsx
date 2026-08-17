/* @jsxImportSource @opentui/solid */
import type { Accessor, ComponentProps, JSX } from "solid-js";
import { For, Show } from "solid-js";

import { ApplicationTerminalWorkspace } from "./application-terminal-workspace.tsx";

type TerminalWorkspaceProps = ComponentProps<typeof ApplicationTerminalWorkspace>;

export interface ApplicationShellViewProps {
  readonly dimensions: Accessor<{ readonly width: number; readonly height: number }>;
  readonly surface: Accessor<"home" | "terminals">;
  readonly workspaceName: Accessor<string>;
  readonly generationStatus: Accessor<string>;
  readonly sessions: readonly string[];
  readonly selectedSession: Accessor<number>;
  readonly bootstrapNote: Accessor<string | null>;
  readonly terminalRendererSource: Accessor<{
    readonly adapter: TerminalWorkspaceProps["adapter"];
    readonly rendererEpoch: TerminalWorkspaceProps["rendererEpoch"];
  } | null>;
  readonly layout: Accessor<TerminalWorkspaceProps["layout"]>;
  readonly viewport: Accessor<{ readonly width: number; readonly height: number }>;
  readonly focusedPane: Accessor<string | null>;
  readonly theme: TerminalWorkspaceProps["theme"];
  readonly palette: TerminalWorkspaceProps["palette"];
  readonly onSelectPane: TerminalWorkspaceProps["onSelectPane"];
  readonly onResizePreview: TerminalWorkspaceProps["onResizePreview"];
  readonly onResizePane: TerminalWorkspaceProps["onResizePane"];
}

/** Pure Solid composition for the always-present command bar and two root surfaces. */
export function ApplicationShellView(props: ApplicationShellViewProps): JSX.Element {
  return (
    <box
      width={props.dimensions().width}
      height={props.dimensions().height}
      overflow="hidden"
      backgroundColor={props.theme.roles.surfaces.canvas}
    >
      <box
        position="absolute"
        left={0}
        top={0}
        width={props.dimensions().width}
        height={1}
        backgroundColor={props.theme.roles.surfaces.command}
        flexDirection="row"
      >
        <text fg={props.theme.roles.text.link} attributes={1}>
          {" "}
          tmux-ide{" "}
        </text>
        <text
          fg={
            props.surface() === "home"
              ? props.theme.roles.selection.selectionText
              : props.theme.roles.text.muted
          }
        >
          {" "}
          F1 Home{" "}
        </text>
        <text
          fg={
            props.surface() === "terminals"
              ? props.theme.roles.selection.selectionText
              : props.theme.roles.text.muted
          }
        >
          {" "}
          F2 Terminals{" "}
        </text>
        <text fg={props.theme.roles.text.muted}>
          {" "}
          {props.workspaceName()} ·{props.generationStatus()}{" "}
        </text>
      </box>
      <Show when={props.surface() === "home"}>
        <box position="absolute" left={2} top={3} flexDirection="column">
          <text fg={props.theme.roles.text.primary} attributes={1}>
            tmux-ide
          </text>
          <text fg={props.theme.roles.text.secondary}>
            A fast visual client for the tmux sessions you already own.
          </text>
          <text fg={props.theme.roles.text.muted}>Start with: tmux-ide app &lt;session&gt;</text>
          <Show when={props.sessions.length > 0}>
            <text fg={props.theme.roles.text.secondary}>Live tmux sessions</text>
            <For each={props.sessions}>
              {(sessionName, index) => (
                <text
                  fg={
                    props.selectedSession() === index()
                      ? props.theme.roles.text.link
                      : props.theme.roles.text.secondary
                  }
                >
                  {`${props.selectedSession() === index() ? "›" : " "} ${sessionName}`}
                </text>
              )}
            </For>
            <text fg={props.theme.roles.text.muted}>↑↓ choose · Enter open</text>
          </Show>
          <Show when={props.bootstrapNote()}>
            {(note) => <text fg={props.theme.roles.text.muted}>{note()}</text>}
          </Show>
        </box>
      </Show>
      <Show when={props.surface() === "terminals"}>
        <Show when={props.terminalRendererSource()} keyed>
          {(source) => (
            <ApplicationTerminalWorkspace
              layout={props.layout()}
              adapter={source.adapter}
              rendererEpoch={source.rendererEpoch}
              width={props.viewport().width}
              height={props.viewport().height}
              focusedPane={props.focusedPane()}
              theme={props.theme}
              palette={props.palette}
              onSelectPane={props.onSelectPane}
              onResizePreview={props.onResizePreview}
              onResizePane={props.onResizePane}
            />
          )}
        </Show>
      </Show>
    </box>
  );
}
