/* @jsxImportSource @opentui/solid */
import { createMemo, For, Show } from "solid-js";
import { terminalDisplayWidth } from "../panel-host.ts";
import { recipePalette } from "../recipes.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { workspaceIcon } from "./icons.ts";
import type {
  CommandPaletteCommandRow,
  CommandPaletteProjection,
  CommandPaletteRow,
  CommandPaletteStateRow,
} from "./command-palette-surface.ts";
import { clipWorkspaceText } from "./text.ts";

export interface CommandPaletteSurfaceProps {
  theme: SemanticThemeSnapshot;
  projection: CommandPaletteProjection;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function localX(projection: CommandPaletteProjection, x: number): number {
  return x - projection.overlay.x - (projection.bordered ? 1 : 0);
}

function localY(projection: CommandPaletteProjection, y: number): number {
  return y - projection.overlay.y - (projection.bordered ? 1 : 0);
}

function commandRowPalette(theme: SemanticThemeSnapshot, row: CommandPaletteCommandRow) {
  return recipePalette(theme, {
    disabled: row.disabled,
    selected: row.selected,
    focused: row.current,
  });
}

function CommandRow(props: {
  theme: SemanticThemeSnapshot;
  projection: CommandPaletteProjection;
  row: CommandPaletteCommandRow;
}) {
  const palette = () => commandRowPalette(props.theme, props.row);
  return (
    <box
      position="absolute"
      left={localX(props.projection, props.row.rect.x)}
      top={localY(props.projection, props.row.rect.y)}
      width={props.row.rect.width}
      height={props.row.rect.height}
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <box
        position="absolute"
        left={props.row.markerSpan.x - props.row.rect.x}
        top={0}
        width={props.row.markerSpan.width}
        height={1}
      >
        <text fg={palette().accent}>{props.row.markerSpan.text}</text>
      </box>
      <box
        position="absolute"
        left={props.row.iconSpan.x - props.row.rect.x}
        top={0}
        width={props.row.iconSpan.width}
        height={1}
      >
        <text
          fg={
            props.row.current && !props.row.disabled ? props.theme.colors.focus : palette().accent
          }
        >
          {props.row.iconSpan.text}
        </text>
      </box>
      <box
        position="absolute"
        left={props.row.labelSpan.x - props.row.rect.x}
        top={0}
        width={props.row.labelSpan.width}
        height={1}
      >
        <text fg={palette().foreground}>{props.row.labelSpan.text}</text>
      </box>
      <Show when={props.row.trailingSpan !== null}>
        <box
          position="absolute"
          left={props.row.trailingSpan!.x - props.row.rect.x}
          top={0}
          width={props.row.trailingSpan!.width}
          height={1}
        >
          <text
            fg={props.row.disabled ? props.theme.colors.mutedForeground : props.theme.colors.accent}
          >
            {props.row.trailingSpan!.text}
          </text>
        </box>
      </Show>
      <Show when={props.row.detailSpan !== null}>
        <box
          position="absolute"
          left={props.row.detailSpan!.x - props.row.rect.x}
          top={1}
          width={props.row.detailSpan!.width}
          height={1}
        >
          <text
            fg={
              props.row.disabled
                ? props.theme.colors.status.blocked
                : props.theme.colors.mutedForeground
            }
          >
            {props.row.detailSpan!.text}
          </text>
        </box>
      </Show>
    </box>
  );
}

function StateRow(props: {
  theme: SemanticThemeSnapshot;
  projection: CommandPaletteProjection;
  row: CommandPaletteStateRow;
}) {
  const palette = () =>
    recipePalette(props.theme, {
      loading: props.row.state === "loading",
      empty: props.row.state === "empty" || props.row.state === "no-match",
      attention: props.row.state === "error",
      selected: props.row.selected,
    });
  return (
    <box
      position="absolute"
      left={localX(props.projection, props.row.rect.x)}
      top={localY(props.projection, props.row.rect.y)}
      width={props.row.rect.width}
      height={props.row.rect.height}
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <box width={props.row.labelSpan.width} height={1}>
        <text
          fg={props.row.state === "error" ? props.theme.colors.status.blocked : palette().accent}
        >
          {props.row.labelSpan.text}
        </text>
      </box>
      <Show when={props.row.detailSpan !== null}>
        <box position="absolute" left={4} top={1} width={props.row.detailSpan!.width} height={1}>
          <text fg={props.theme.colors.mutedForeground}>{props.row.detailSpan!.text}</text>
        </box>
      </Show>
    </box>
  );
}

function Row(props: {
  theme: SemanticThemeSnapshot;
  projection: CommandPaletteProjection;
  row: CommandPaletteRow;
}) {
  return (
    <Show
      when={props.row.kind === "command"}
      fallback={
        <Show
          when={props.row.kind === "state"}
          fallback={
            <box
              position="absolute"
              left={localX(props.projection, props.row.rect.x)}
              top={localY(props.projection, props.row.rect.y)}
              width={props.row.rect.width}
              height={1}
              backgroundColor={props.theme.colors.surface}
              overflow="hidden"
            >
              <box
                position="absolute"
                left={props.row.labelSpan.x - props.row.rect.x}
                top={0}
                width={props.row.labelSpan.width}
                height={1}
              >
                <text fg={props.theme.colors.mutedForeground}>{props.row.labelSpan.text}</text>
              </box>
            </box>
          }
        >
          <StateRow
            theme={props.theme}
            projection={props.projection}
            row={props.row as CommandPaletteStateRow}
          />
        </Show>
      }
    >
      <CommandRow
        theme={props.theme}
        projection={props.projection}
        row={props.row as CommandPaletteCommandRow}
      />
    </Show>
  );
}

function queryText(projection: CommandPaletteProjection): string {
  const content = projection.queryText || projection.queryPlaceholder;
  const cursor = projection.queryText ? "▏" : "";
  return clipWorkspaceText(`${content}${cursor}`, Math.max(0, projection.query.width - 4));
}

function footerLeft(projection: CommandPaletteProjection): string {
  return projection.variant === "compact" ? "↑↓  ↵  esc" : "↑↓ navigate   ↵ run   esc close";
}

function footerRight(projection: CommandPaletteProjection): string {
  if (projection.commandCount === 0) return projection.phase;
  if (projection.hasMoreBefore || projection.hasMoreAfter) {
    return `${projection.visibleStart + 1}–${projection.visibleEnd} / ${projection.contentRowCount}`;
  }
  return `${projection.commandCount} command${projection.commandCount === 1 ? "" : "s"}`;
}

/**
 * Presentation-only palette surface. The root application owns query edits,
 * keyboard/mouse routing, command execution, retry, and overlay lifecycle.
 */
export function CommandPaletteSurface(props: CommandPaletteSurfaceProps) {
  const entries = createMemo(() => new Map(props.projection.rows.map((row) => [row.id, row])));
  const rowIds = createMemo(() => props.projection.rowIds, undefined, { equals: sameIds });
  const count = () => `${props.projection.commandCount}`;
  const countWidth = () => terminalDisplayWidth(count());
  const headerTitle = () =>
    clipWorkspaceText(
      ` ${workspaceIcon("command")} ${props.projection.title}`,
      Math.max(0, props.projection.header.width - countWidth() - 2),
    );
  const leftFooter = () =>
    clipWorkspaceText(footerLeft(props.projection), props.projection.footer.width);
  const rightFooter = () => {
    const leftWidth = terminalDisplayWidth(leftFooter());
    return clipWorkspaceText(
      footerRight(props.projection),
      Math.max(0, props.projection.footer.width - leftWidth - 1),
    );
  };
  const footerRightWidth = () => terminalDisplayWidth(rightFooter());

  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      overflow="hidden"
    >
      <box
        position="absolute"
        left={props.projection.overlay.x}
        top={props.projection.overlay.y}
        width={props.projection.overlay.width}
        height={props.projection.overlay.height}
        border={props.projection.bordered}
        borderStyle="rounded"
        borderColor={props.theme.colors.focusBorder}
        backgroundColor={props.theme.colors.surface}
        overflow="hidden"
      >
        <Show when={props.projection.header.height > 0}>
          <box
            position="absolute"
            left={localX(props.projection, props.projection.header.x)}
            top={localY(props.projection, props.projection.header.y)}
            width={props.projection.header.width}
            height={1}
            backgroundColor={props.theme.colors.surfaceRaised}
            overflow="hidden"
          >
            <text fg={props.theme.colors.foreground}>{headerTitle()}</text>
            <box position="absolute" right={0} top={0} width={countWidth()} height={1}>
              <text fg={props.theme.colors.mutedForeground}>{count()}</text>
            </box>
          </box>
        </Show>
        <Show when={props.projection.query.height > 0}>
          <box
            position="absolute"
            left={localX(props.projection, props.projection.query.x)}
            top={localY(props.projection, props.projection.query.y)}
            width={props.projection.query.width}
            height={1}
            backgroundColor={props.theme.colors.background}
            overflow="hidden"
            flexDirection="row"
          >
            <text fg={props.theme.colors.accent}>{` ${workspaceIcon("search")} `}</text>
            <text
              fg={
                props.projection.queryText
                  ? props.theme.colors.foreground
                  : props.theme.colors.mutedForeground
              }
            >
              {queryText(props.projection)}
            </text>
          </box>
        </Show>
        <Show when={props.projection.divider.height > 0}>
          <box
            position="absolute"
            left={localX(props.projection, props.projection.divider.x)}
            top={localY(props.projection, props.projection.divider.y)}
            width={props.projection.divider.width}
            height={1}
            overflow="hidden"
          >
            <text fg={props.theme.colors.border}>{"─".repeat(props.projection.divider.width)}</text>
          </box>
        </Show>
        <For each={rowIds()}>
          {(rowId) => (
            <Row theme={props.theme} projection={props.projection} row={entries().get(rowId)!} />
          )}
        </For>
        <Show when={props.projection.footer.height > 0}>
          <box
            position="absolute"
            left={localX(props.projection, props.projection.footer.x)}
            top={localY(props.projection, props.projection.footer.y)}
            width={props.projection.footer.width}
            height={1}
            backgroundColor={props.theme.colors.surfaceRaised}
            overflow="hidden"
          >
            <text fg={props.theme.colors.mutedForeground}>{leftFooter()}</text>
            <Show when={footerRightWidth() > 0}>
              <box position="absolute" right={0} top={0} width={footerRightWidth()} height={1}>
                <text fg={props.theme.colors.mutedForeground}>{rightFooter()}</text>
              </box>
            </Show>
          </box>
        </Show>
      </box>
    </box>
  );
}
