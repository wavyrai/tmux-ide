/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { For, Show } from "solid-js";
import { ActionChip, Badge, StatusChip } from "../recipes.tsx";
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

function borderGlyphs(style: PaneFrameProjection["borderStyle"]) {
  if (style === "strong") return { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" };
  return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };
}

function Chip(props: { theme: SemanticThemeSnapshot; chip: PaneFrameChip }) {
  return (
    <Show
      when={props.chip.kind === "action" ? props.chip : null}
      fallback={
        <Show
          when={props.chip.kind === "status" ? props.chip : null}
          fallback={
            <Badge
              theme={props.theme}
              label={props.chip.label}
              width={props.chip.width}
              tone={props.chip.kind === "state" ? props.chip.tone : "neutral"}
              state={{
                selected: props.chip.kind === "state" && props.chip.id === "edit",
                focused: props.chip.kind === "state" && props.chip.id === "maximized",
              }}
            />
          }
        >
          {(status) => (
            <StatusChip
              theme={props.theme}
              label={status().label}
              width={status().width}
              tone={status().tone}
            />
          )}
        </Show>
      }
    >
      {(action) => (
        <ActionChip
          theme={props.theme}
          label={action().label}
          width={action().width}
          hovered={action().hovered}
          pressed={action().pressed}
          selected={action().active}
          disabled={action().disabled}
          attention={action().attention}
        />
      )}
    </Show>
  );
}

export function PaneFrameHeader(props: PaneFrameHeaderProps) {
  const palette = () => framePalette(props.theme, props.projection);
  return (
    <box
      position="absolute"
      left={props.projection.header.x}
      top={props.projection.header.y}
      width={props.projection.header.width}
      height={props.projection.header.height}
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <Show when={props.projection.grip}>
        {(grip) => (
          <box
            position="absolute"
            left={grip().x - props.projection.header.x}
            top={0}
            width={grip().width}
            height={1}
          >
            <text fg={palette().accent}>{grip().text}</text>
          </box>
        )}
      </Show>
      <box
        position="absolute"
        left={props.projection.titleSpan.x - props.projection.header.x}
        top={0}
        width={props.projection.titleSpan.width}
        height={1}
      >
        <text fg={palette().foreground} attributes={props.projection.focused ? 1 : 0}>
          {props.projection.titleSpan.text}
        </text>
      </box>
      <Show when={props.projection.subtitleSpan}>
        {(subtitle) => (
          <box
            position="absolute"
            left={subtitle().x - props.projection.header.x}
            top={0}
            width={subtitle().width}
            height={1}
          >
            <text fg={props.theme.colors.mutedForeground}>{subtitle().text}</text>
          </box>
        )}
      </Show>
      <For each={props.projection.chips}>
        {(chip) => (
          <box
            position="absolute"
            left={chip.start - props.projection.header.x}
            top={0}
            width={chip.width}
            height={1}
          >
            <Chip theme={props.theme} chip={chip} />
          </box>
        )}
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
