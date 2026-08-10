/* @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { Show, type JSX } from "solid-js";

import type { SemanticThemeSnapshot } from "./theme.ts";
import type { TuiWidgetSurface } from "./widget-surface-model.ts";

export interface TuiRichWidgetSurfaceProps {
  readonly surface: TuiWidgetSurface;
  readonly theme: SemanticThemeSnapshot;
  readonly syntaxStyle: SyntaxStyle;
  readonly width: number;
  readonly height: number;
}

/** Passive overlay: the terminal emulator remains mounted and owns input. */
export function TuiRichWidgetSurface(props: TuiRichWidgetSurfaceProps): JSX.Element {
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={props.width}
      height={props.height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.theme.roles.surfaces.terminal}
      overflow="hidden"
    >
      <box height={1} flexDirection="row">
        <text fg={props.theme.colors.accent} attributes={1}>
          {props.surface.title ?? props.surface.label}
        </text>
        <text fg={props.theme.roles.text.secondary}>{"  ·  Ctrl-C to return"}</text>
      </box>
      <box
        width={Math.max(1, props.width - 2)}
        height={Math.max(1, props.height - 2)}
        flexDirection="column"
        paddingTop={1}
        overflow="hidden"
      >
        <Show
          when={props.surface.kind === "markdown"}
          fallback={
            <text fg={props.theme.roles.text.secondary} wrapMode="word">
              {props.surface.text}
            </text>
          }
        >
          <markdown
            width={Math.max(1, props.width - 2)}
            height={Math.max(1, props.height - 3)}
            content={props.surface.text}
            syntaxStyle={props.syntaxStyle}
            conceal={true}
            concealCode={false}
            // Keep blocks independent. Besides making long documents cheaper to
            // update, this prevents inline HTML/badges near the top of a README
            // from disturbing the layout of the following Markdown blocks.
            internalBlockMode="top-level"
            tableOptions={{
              style: "columns",
              widthMode: "full",
              wrapMode: "word",
              borders: false,
            }}
            // This surface is swapped atomically rather than appended chunk by
            // chunk. Keeping OpenTUI's incremental path enabled avoids holding
            // the first frame behind its optional async syntax worker.
            streaming={true}
          />
        </Show>
      </box>
    </box>
  );
}
