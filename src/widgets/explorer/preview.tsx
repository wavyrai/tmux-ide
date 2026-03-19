import { Show, For } from "solid-js";
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface FilePreviewProps {
  content: string | null;
  filePath: string | null;
  theme: WidgetTheme;
  focused: boolean;
}

export function FilePreview(props: FilePreviewProps) {
  let scroll: ScrollBoxRenderable | undefined;

  return (
    <box flexGrow={1} flexShrink={1}>
      {/* Separator line */}
      <box flexShrink={0} height={1}>
        <Show
          when={props.filePath}
          fallback={<text fg={toRGBA(props.theme.border)}>{"─".repeat(80)}</text>}
        >
          <text fg={toRGBA(props.theme.accent)} wrapMode="none">
            {"─ "}
            {props.filePath} {"─".repeat(40)}
          </text>
        </Show>
      </box>

      {/* File content */}
      <Show
        when={props.content}
        fallback={
          <box paddingLeft={1} paddingTop={1}>
            <text fg={toRGBA(props.theme.fgMuted)}>Select a file to preview</text>
          </box>
        }
      >
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: toRGBA(props.theme.bg),
              foregroundColor: toRGBA(props.theme.border),
            },
          }}
        >
          <For each={props.content!.split("\n")}>
            {(line, lineNum) => (
              <box flexDirection="row" gap={1}>
                <text
                  fg={toRGBA(props.theme.diffLineNumber)}
                  flexShrink={0}
                  width={4}
                  wrapMode="none"
                >
                  {String(lineNum() + 1).padStart(3)}
                </text>
                <text fg={toRGBA(props.theme.fg)} wrapMode="none">
                  {line || " "}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}
