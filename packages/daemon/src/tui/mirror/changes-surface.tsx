/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { RGBA } from "@opentui/core";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { ActionChip, EmptyState, InputShell, SectionHeader, SelectableRow } from "./recipes.tsx";
import { recipePalette } from "./recipes.ts";
import type { ChangesProjectedFileRow, ChangesSurfaceProjection } from "./changes-surface.ts";
import { changesHitTest } from "./changes-surface.ts";
import type { DiffLineKind } from "./diff-model.ts";

export interface ChangesSurfaceColors {
  gutterBg: RGBA;
  gutterFg: RGBA;
  statusLetterFg: Record<string, RGBA>;
  diffFg: Record<DiffLineKind, RGBA>;
  diffLineBg: Partial<Record<DiffLineKind, RGBA>>;
}

export interface ChangesSurfaceProps {
  theme: SemanticThemeSnapshot;
  projection: ChangesSurfaceProjection;
  colors: ChangesSurfaceColors;
}

export function ChangesSurface(props: ChangesSurfaceProps) {
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      backgroundColor={props.theme.roles.surfaces.canvas}
      overflow="hidden"
    >
      <ChangesHeader theme={props.theme} projection={props.projection} />
      <box
        position="absolute"
        left={0}
        top={props.projection.banner.y}
        width={props.projection.banner.width}
        height={props.projection.banner.height}
        paddingLeft={1}
        overflow="hidden"
      >
        <text
          fg={
            props.projection.state === "error"
              ? props.theme.roles.statusTone.danger
              : props.theme.roles.text.muted
          }
        >
          {props.projection.message}
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
          when={props.projection.listRows.length > 0}
          fallback={
            <EmptyState
              theme={props.theme}
              title={props.projection.state === "empty" ? "No changes" : "Loading changes"}
              detail={props.projection.message}
              width={props.projection.list.width}
            />
          }
        >
          <For each={props.projection.listRows}>
            {(row) =>
              row.kind === "header" ? (
                <box height={1} paddingLeft={1} overflow="hidden">
                  <SectionHeader theme={props.theme} title={row.label} width={row.width} />
                </box>
              ) : (
                <ChangesFileRow theme={props.theme} colors={props.colors} row={row} />
              )
            }
          </For>
        </Show>
      </box>
      <Show when={props.projection.diff.width > 0}>
        <box
          position="absolute"
          left={props.projection.diff.x}
          top={props.projection.diff.y}
          width={props.projection.diff.width}
          height={props.projection.diff.height}
          flexDirection="column"
          overflow="hidden"
        >
          <Show
            when={props.projection.diffLines.length > 0}
            fallback={
              <EmptyState
                theme={props.theme}
                title="No diff"
                detail={props.projection.message}
                width={props.projection.diff.width}
              />
            }
          >
            <For each={props.projection.diffLines}>
              {(line) => (
                <box
                  height={1}
                  backgroundColor={
                    props.colors.diffLineBg[line.kind] ?? props.theme.roles.surfaces.canvas
                  }
                  overflow="hidden"
                >
                  <text fg={props.colors.diffFg[line.kind]}>{line.text}</text>
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
        overflow="hidden"
      >
        <text fg={props.theme.roles.text.muted}>{` ${props.projection.footerHint}`}</text>
        <For each={props.projection.footerActions}>
          {(action) => (
            <box position="absolute" left={action.start} top={0} width={action.width} height={1}>
              <ActionChip
                theme={props.theme}
                label={action.label}
                width={action.width}
                hovered={action.hovered}
                disabled={action.disabled}
              />
            </box>
          )}
        </For>
      </box>
    </box>
  );
}

function ChangesHeader(props: {
  theme: SemanticThemeSnapshot;
  projection: ChangesSurfaceProjection;
}) {
  const leftWidth = () =>
    Math.max(0, props.projection.headerActions[0]?.start ?? props.projection.width);
  return (
    <box
      position="absolute"
      left={props.projection.header.x}
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
        <text fg={props.theme.roles.text.muted}>{props.projection.totals}</text>
        <Show when={props.projection.filter.active}>
          <InputShell
            theme={props.theme}
            value={props.projection.filter.query}
            placeholder="filter changes"
            width={Math.min(28, Math.max(12, leftWidth() - 32))}
            focused
          />
        </Show>
      </box>
      <For each={props.projection.headerActions}>
        {(action) => (
          <box position="absolute" left={action.start} top={0} width={action.width} height={1}>
            <ActionChip
              theme={props.theme}
              label={action.label}
              width={action.width}
              hovered={action.hovered}
              disabled={action.disabled}
            />
          </box>
        )}
      </For>
    </box>
  );
}

function ChangesFileRow(props: {
  theme: SemanticThemeSnapshot;
  colors: ChangesSurfaceColors;
  row: ChangesProjectedFileRow;
}) {
  const palette = () =>
    recipePalette(props.theme, {
      selected: props.row.selected,
      hovered: props.row.hovered,
      status:
        props.row.entry.group === "staged"
          ? "done"
          : props.row.entry.group === "unstaged"
            ? "working"
            : "unknown",
    });
  const countWidth = () => (props.row.countText ? props.row.countText.length + 1 : 0);
  const rowWidth = () =>
    Math.max(1, props.row.width - countWidth() - (props.row.action?.width ?? 0));
  return (
    <box height={1} flexDirection="row" backgroundColor={palette().background} overflow="hidden">
      <text fg={props.colors.statusLetterFg[props.row.status] ?? props.theme.roles.text.primary}>
        {props.row.status}
      </text>
      <SelectableRow
        theme={props.theme}
        label={` ${props.row.path}`}
        width={rowWidth()}
        selected={props.row.selected}
        hovered={props.row.hovered}
        tone="neutral"
      />
      <Show when={props.row.countText}>
        {(count) => <text fg={props.theme.roles.text.muted}>{` ${count()}`}</text>}
      </Show>
      <Show when={props.row.action}>
        {(action) => (
          <box position="absolute" left={action().start} top={0} width={action().width} height={1}>
            <ActionChip
              theme={props.theme}
              label={action().label}
              width={action().width}
              hovered={action().hovered}
            />
          </box>
        )}
      </Show>
    </box>
  );
}

export { changesHitTest };
