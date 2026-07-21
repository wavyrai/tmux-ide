/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { RGBA } from "@opentui/core";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { ActionChip, EmptyState, InputShell, SelectableRow } from "./recipes.tsx";
import { recipePalette } from "./recipes.ts";
import {
  filesHitTest,
  type FilesProjectedRow,
  type FilesSurfaceProjection,
} from "./files-surface.ts";
import { clipTerminal } from "./missions-workspace.ts";

export interface FilesSurfaceTheme {
  gutterBg: RGBA;
  gutterFg: RGBA;
  cursorBg: RGBA;
  modifiedFg: RGBA;
  statusLetterFg: Record<string, RGBA>;
}

export interface FilesSurfaceProps {
  theme: SemanticThemeSnapshot;
  colors: FilesSurfaceTheme;
  projection: FilesSurfaceProjection;
}

export function FilesSurface(props: FilesSurfaceProps) {
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      backgroundColor={props.theme.roles.surfaces.canvas}
      overflow="hidden"
    >
      <FilesHeader theme={props.theme} projection={props.projection} />
      <box
        position="absolute"
        left={0}
        top={props.projection.banner.y}
        width={props.projection.banner.width}
        height={props.projection.banner.height}
        paddingLeft={1}
      >
        <text
          fg={
            props.projection.state === "error"
              ? props.theme.roles.statusTone.danger
              : props.projection.state === "success"
                ? props.theme.roles.statusTone.success
                : props.theme.roles.text.muted
          }
        >
          {props.projection.stateMessage}
        </text>
      </box>
      <box
        position="absolute"
        left={props.projection.list.x}
        top={props.projection.list.y}
        width={props.projection.list.width}
        height={props.projection.list.height}
        flexDirection="column"
        backgroundColor={props.colors.gutterBg}
        overflow="hidden"
      >
        <Show
          when={props.projection.rows.length > 0}
          fallback={
            <EmptyState
              theme={props.theme}
              title={props.projection.state === "loading" ? "Loading files" : "No files"}
              detail={props.projection.stateMessage}
              width={props.projection.list.width}
            />
          }
        >
          <For each={props.projection.rows}>
            {(row) => (
              <FileRow
                theme={props.theme}
                colors={props.colors}
                row={row}
                width={props.projection.list.width}
              />
            )}
          </For>
        </Show>
      </box>
      <Show when={props.projection.previewVisible}>
        <box
          position="absolute"
          left={props.projection.editor.x}
          top={props.projection.editor.y}
          width={props.projection.editor.width}
          height={props.projection.editor.height}
          flexDirection="column"
          overflow="hidden"
        >
          <Show
            when={props.projection.editorLines.length > 0}
            fallback={
              <EmptyState
                theme={props.theme}
                title="No file open"
                detail="Select a file from the list."
                width={props.projection.editor.width}
              />
            }
          >
            <For each={props.projection.editorLines}>
              {(line) => (
                <box height={1} flexDirection="row" overflow="hidden">
                  <text bg={props.colors.gutterBg} fg={props.colors.gutterFg}>
                    {line.gutter}
                  </text>
                  <Show
                    when={line.cursorCol !== null}
                    fallback={<text fg={props.theme.roles.text.primary}>{line.text}</text>}
                  >
                    <text fg={props.theme.roles.text.primary}>
                      {line.text.slice(0, line.cursorCol!)}
                    </text>
                    <text fg={props.theme.roles.surfaces.canvas} bg={props.colors.cursorBg}>
                      {line.text[line.cursorCol!] ?? " "}
                    </text>
                    <text fg={props.theme.roles.text.primary}>
                      {line.text.slice(line.cursorCol! + 1)}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </Show>
        </box>
      </Show>
      <box
        position="absolute"
        left={0}
        top={props.projection.footer.y}
        width={props.projection.footer.width}
        height={props.projection.footer.height}
        paddingLeft={1}
        overflow="hidden"
      >
        <text fg={props.theme.roles.text.muted}>{props.projection.footerHint}</text>
      </box>
    </box>
  );
}

function FilesHeader(props: { theme: SemanticThemeSnapshot; projection: FilesSurfaceProjection }) {
  const leftWidth = () => Math.max(0, props.projection.actions[0]?.start ?? props.projection.width);
  return (
    <box
      position="absolute"
      left={0}
      top={props.projection.header.y}
      width={props.projection.header.width}
      height={props.projection.header.height}
      overflow="hidden"
    >
      <box
        height={1}
        width={leftWidth()}
        paddingLeft={1}
        flexDirection="row"
        gap={1}
        overflow="hidden"
      >
        <text fg={props.theme.roles.text.link} attributes={1}>
          {props.projection.title}
        </text>
        <For each={props.projection.headerMeta}>
          {(meta) => <text fg={props.theme.roles.text.muted}>{meta}</text>}
        </For>
        <Show when={props.projection.filter.active}>
          <InputShell
            theme={props.theme}
            value={props.projection.filter.query}
            placeholder="filter files"
            width={Math.min(30, Math.max(12, leftWidth() - 32))}
            focused
          />
        </Show>
      </box>
      <For each={props.projection.actions}>
        {(action) => (
          <box position="absolute" left={action.start} top={0} width={action.width} height={1}>
            <ActionChip
              theme={props.theme}
              label={action.label}
              width={action.width}
              disabled={action.disabled}
              hovered={action.hovered}
            />
          </box>
        )}
      </For>
    </box>
  );
}

function FileRow(props: {
  theme: SemanticThemeSnapshot;
  colors: FilesSurfaceTheme;
  row: FilesProjectedRow;
  width: number;
}) {
  const palette = () =>
    recipePalette(props.theme, {
      selected: props.row.selected,
      hovered: props.row.hovered,
      disabled: props.row.disabled,
      status: props.row.status ? "working" : undefined,
    });
  const tone = () => (props.row.role === "directory" ? "accent" : "neutral");
  return (
    <box height={1} backgroundColor={palette().background} flexDirection="row" overflow="hidden">
      <SelectableRow
        theme={props.theme}
        label={props.row.label}
        meta=""
        width={Math.max(1, props.width - (props.row.status ? 2 : 0))}
        selected={props.row.selected}
        hovered={props.row.hovered}
        disabled={props.row.disabled}
        tone={tone()}
      />
      <Show when={props.row.status}>
        {(status) => (
          <text fg={props.colors.statusLetterFg[status()] ?? props.theme.roles.text.primary}>
            {` ${status()}`}
          </text>
        )}
      </Show>
    </box>
  );
}

export { filesHitTest };
