/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { createMemo, For, Show } from "solid-js";
import { ActionChip, Badge, IconButton, StatusChip } from "../recipes.tsx";
import { recipePalette } from "../recipes.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { PaneFrameChip, PaneFrameProjection } from "./pane-frame.ts";

export interface PaneFrameHeaderProps {
  theme: SemanticThemeSnapshot;
  projection: PaneFrameProjection;
}

function framePalette(theme: SemanticThemeSnapshot, projection: PaneFrameProjection) {
  return recipePalette(theme, {
    selected: projection.windowEditSelected,
    focused: projection.focused || projection.terminalFocused,
    attention: projection.attention,
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function chipIdentity(chip: PaneFrameChip): string {
  if (chip.kind === "status") return "status";
  return `${chip.kind}:${chip.id}`;
}

function keyedChips(chips: readonly PaneFrameChip[]): readonly [string, PaneFrameChip][] {
  const seen = new Map<string, number>();
  return chips.map((chip) => {
    const base = chipIdentity(chip);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return [`${base}:${occurrence}`, chip] as const;
  });
}

function borderGlyphs(style: PaneFrameProjection["borderStyle"]) {
  if (style === "strong") return { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };
  return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
}

function Chip(props: { theme: SemanticThemeSnapshot; chip: PaneFrameChip }) {
  const action = () => (props.chip.kind === "action" ? props.chip : null);
  const status = () => (props.chip.kind === "status" ? props.chip : null);
  const badge = () =>
    props.chip.kind !== "action" && props.chip.kind !== "status" ? props.chip : null;
  return (
    <Show
      when={action() !== null}
      fallback={
        <Show
          when={status() !== null}
          fallback={
            <Badge
              theme={props.theme}
              label={badge()!.label}
              width={badge()!.width}
              tone={badge()!.tone}
              state={{
                selected: badge()!.id === "edit",
                focused: badge()!.id === "maximized",
              }}
            />
          }
        >
          <StatusChip
            theme={props.theme}
            label={status()!.label}
            width={status()!.width}
            tone={status()!.tone}
          />
        </Show>
      }
    >
      <Show
        when={action()!.appearance === "icon"}
        fallback={
          <ActionChip
            theme={props.theme}
            label={action()!.label}
            width={action()!.width}
            hovered={action()!.hovered}
            pressed={action()!.pressed}
            selected={action()!.active}
            disabled={action()!.disabled}
            attention={action()!.attention}
          />
        }
      >
        <IconButton
          theme={props.theme}
          icon={action()!.label}
          width={action()!.width}
          hovered={action()!.hovered}
          pressed={action()!.pressed}
          // Icon identity (□/▣) communicates toggle state. Keep the idle
          // control transparent like native window chrome.
          selected={false}
          disabled={action()!.disabled}
          attention={action()!.attention}
          hidden={action()!.hidden}
        />
      </Show>
    </Show>
  );
}

export function PaneFrameHeader(props: PaneFrameHeaderProps) {
  const palette = () => framePalette(props.theme, props.projection);
  const nativeFocused = () => props.projection.focused || props.projection.terminalFocused;
  const background = () =>
    nativeFocused() ? props.theme.colors.accentMuted : palette().background;
  const titleForeground = () =>
    nativeFocused() ? props.theme.colors.selectionForeground : props.theme.colors.mutedForeground;
  // PaneFrame projections are immutable, so chips are fresh value objects on
  // every state update. Preserve the renderable tree by semantic chip id and
  // resolve the current chip separately.
  const entries = createMemo(() => keyedChips(props.projection.chips));
  const chipIds = createMemo(() => entries().map(([id]) => id), undefined, { equals: sameIds });
  const chipsById = createMemo(() => new Map(entries()));
  return (
    <box
      position="absolute"
      left={props.projection.header.x}
      top={props.projection.header.y}
      width={props.projection.header.width}
      height={props.projection.header.height}
      backgroundColor={background()}
      overflow="hidden"
    >
      <Show when={props.projection.grip !== null}>
        <box
          position="absolute"
          left={props.projection.grip!.x - props.projection.header.x}
          top={0}
          width={props.projection.grip!.width}
          height={1}
        >
          <text fg={nativeFocused() ? props.theme.colors.focus : props.theme.colors.border}>
            {props.projection.grip!.text}
          </text>
        </box>
      </Show>
      <box
        position="absolute"
        left={props.projection.titleSpan.x - props.projection.header.x}
        top={0}
        width={props.projection.titleSpan.width}
        height={1}
      >
        <text fg={titleForeground()} attributes={nativeFocused() ? 1 : 0}>
          {props.projection.titleSpan.text}
        </text>
      </box>
      <Show when={props.projection.subtitleSpan !== null}>
        <box
          position="absolute"
          left={props.projection.subtitleSpan!.x - props.projection.header.x}
          top={0}
          width={props.projection.subtitleSpan!.width}
          height={1}
        >
          <text
            fg={
              nativeFocused() ? props.theme.colors.foreground : props.theme.colors.mutedForeground
            }
          >
            {props.projection.subtitleSpan!.text}
          </text>
        </box>
      </Show>
      <For each={chipIds()}>
        {(chipId) => {
          const chip = () => chipsById().get(chipId)!;
          return (
            <box
              position="absolute"
              left={chip().start - props.projection.header.x}
              top={0}
              width={chip().width}
              height={1}
            >
              <Chip theme={props.theme} chip={chip()} />
            </box>
          );
        }}
      </For>
    </box>
  );
}

export interface PaneFrameProps extends PaneFrameHeaderProps {
  children?: JSX.Element;
}

export function PaneFrame(props: PaneFrameProps) {
  const palette = () => framePalette(props.theme, props.projection);
  const glyphs = () => borderGlyphs(props.projection.borderStyle);
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <Show when={props.projection.borderStyle !== "none" && props.projection.width > 1}>
        <box position="absolute" left={0} top={0} width={props.projection.width} height={1}>
          <text fg={palette().border}>
            {`${glyphs().tl}${glyphs().h.repeat(Math.max(0, props.projection.width - 2))}${glyphs().tr}`}
          </text>
        </box>
        <box
          position="absolute"
          left={0}
          top={Math.max(0, props.projection.height - 1)}
          width={props.projection.width}
          height={1}
        >
          <text fg={palette().border}>
            {`${glyphs().bl}${glyphs().h.repeat(Math.max(0, props.projection.width - 2))}${glyphs().br}`}
          </text>
        </box>
        <Show when={props.projection.height > 2}>
          <box position="absolute" left={0} top={1} width={1} height={props.projection.height - 2}>
            <text fg={palette().border}>
              {Array(props.projection.height - 2)
                .fill(glyphs().v)
                .join("\n")}
            </text>
          </box>
          <box
            position="absolute"
            left={Math.max(0, props.projection.width - 1)}
            top={1}
            width={1}
            height={props.projection.height - 2}
          >
            <text fg={palette().border}>
              {Array(props.projection.height - 2)
                .fill(glyphs().v)
                .join("\n")}
            </text>
          </box>
        </Show>
      </Show>
      <PaneFrameHeader theme={props.theme} projection={props.projection} />
      <box
        position="absolute"
        left={props.projection.body.x}
        top={props.projection.body.y}
        width={props.projection.body.width}
        height={props.projection.body.height}
        flexDirection="column"
        backgroundColor={props.theme.colors.background}
        overflow="hidden"
      >
        {props.children}
      </box>
    </box>
  );
}
