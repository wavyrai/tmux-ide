/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { createContext, createMemo, For, Show, useContext } from "solid-js";
import {
  PaneFramePresenter,
  type PaneFrameActionLeafProps,
  type PaneFrameActionListLeafProps,
  type PaneFrameBodyLeafProps,
  type PaneFrameGripLeafProps,
  type PaneFrameHeaderLeafProps,
  type PaneFrameHostLeaves,
  type PaneFrameRootLeafProps,
  type PaneFrameStatusLeafProps,
  type PaneFrameTitleLeafProps,
} from "../../../ui/pane-frame/presenter.tsx";
import { ActionChip, Badge, IconButton, StatusChip } from "../recipes.tsx";
import { recipePalette } from "../recipes.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { PaneFrameChip, PaneFrameProjection } from "./pane-frame.ts";

export interface PaneFrameHeaderProps {
  theme: SemanticThemeSnapshot;
  projection: PaneFrameProjection;
}

interface OpenTuiPaneFrameHostContext {
  theme: () => SemanticThemeSnapshot;
  projection: () => PaneFrameProjection;
  inputOwner: () => boolean;
}

const OpenTuiPaneFrameContext = createContext<OpenTuiPaneFrameHostContext>();

function useOpenTuiPaneFrameHost(): OpenTuiPaneFrameHostContext {
  const context = useContext(OpenTuiPaneFrameContext);
  if (!context) throw new Error("OpenTUI PaneFrame host leaves require their host context");
  return context;
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
            focused={action()!.focused}
            disabled={action()!.disabled}
            attention={action()!.attention}
            loading={action()!.loading}
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
          focused={action()!.focused}
          disabled={action()!.disabled}
          attention={action()!.attention}
          loading={action()!.loading}
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
    nativeFocused() ? props.theme.roles.surfaces.headerActive : palette().background;
  const titleForeground = () =>
    nativeFocused() ? props.theme.roles.text.primary : props.theme.roles.text.muted;
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
          <text
            fg={
              nativeFocused()
                ? props.theme.roles.borders.focused
                : props.theme.roles.borders.default
            }
          >
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
            fg={nativeFocused() ? props.theme.roles.text.primary : props.theme.roles.text.muted}
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

function semanticBorderColor(
  theme: SemanticThemeSnapshot,
  appearance: PaneFrameRootLeafProps["appearance"],
) {
  const role = appearance.outerOutline.visible
    ? (appearance.outerOutline.role ?? appearance.border.role)
    : appearance.border.role;
  return theme.roles.borders[role];
}

function OpenTuiRoot(props: PaneFrameRootLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const projection = host.projection;
  const glyphs = () => borderGlyphs(projection().borderStyle);
  const border = () => semanticBorderColor(host.theme(), props.appearance);
  return (
    <box
      id={`pane-frame:${props.pane.id}:root`}
      width={projection().width}
      height={projection().height}
      position="relative"
      backgroundColor={host.theme().roles.surfaces.canvas}
      overflow="hidden"
    >
      <Show when={projection().borderStyle !== "none" && projection().width > 1}>
        <box position="absolute" left={0} top={0} width={projection().width} height={1}>
          <text fg={border()}>
            {`${glyphs().tl}${glyphs().h.repeat(Math.max(0, projection().width - 2))}${glyphs().tr}`}
          </text>
        </box>
        <box
          position="absolute"
          left={0}
          top={Math.max(0, projection().height - 1)}
          width={projection().width}
          height={1}
        >
          <text fg={border()}>
            {`${glyphs().bl}${glyphs().h.repeat(Math.max(0, projection().width - 2))}${glyphs().br}`}
          </text>
        </box>
        <Show when={projection().height > 2}>
          <box position="absolute" left={0} top={1} width={1} height={projection().height - 2}>
            <text fg={border()}>
              {Array(projection().height - 2)
                .fill(glyphs().v)
                .join("\n")}
            </text>
          </box>
          <box
            position="absolute"
            left={Math.max(0, projection().width - 1)}
            top={1}
            width={1}
            height={projection().height - 2}
          >
            <text fg={border()}>
              {Array(projection().height - 2)
                .fill(glyphs().v)
                .join("\n")}
            </text>
          </box>
        </Show>
      </Show>
      {props.children}
    </box>
  );
}

function OpenTuiHeader(props: PaneFrameHeaderLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const projection = host.projection;
  return (
    <box
      id={`pane-frame:${props.pane.id}:header`}
      position="absolute"
      left={projection().header.x}
      top={projection().header.y}
      width={projection().header.width}
      height={projection().header.height}
      backgroundColor={host.theme().roles.surfaces[props.appearance.header.surface]}
      overflow="hidden"
    >
      {props.children}
    </box>
  );
}

function OpenTuiGrip(props: PaneFrameGripLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const projection = host.projection;
  return (
    <Show when={projection().grip !== null}>
      <box
        id={`pane-frame:${props.pane.id}:grip`}
        position="absolute"
        left={projection().grip!.x - projection().header.x}
        top={0}
        width={projection().grip!.width}
        height={1}
        onMouseDown={host.inputOwner() ? props.onActivate : undefined}
      >
        <text fg={semanticBorderColor(host.theme(), props.appearance)}>
          {projection().grip!.text}
        </text>
      </box>
    </Show>
  );
}

function OpenTuiTitle(props: PaneFrameTitleLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const projection = host.projection;
  const titleColor = () => host.theme().roles.text[props.appearance.header.text];
  return (
    <>
      <box
        id={`pane-frame:${props.pane.id}:title`}
        position="absolute"
        left={projection().titleSpan.x - projection().header.x}
        top={0}
        width={projection().titleSpan.width}
        height={1}
      >
        <text fg={titleColor()} attributes={props.appearance.header.focused ? 1 : 0}>
          {projection().titleSpan.text}
        </text>
      </box>
      <Show when={projection().subtitleSpan !== null}>
        <box
          id={`pane-frame:${props.pane.id}:subtitle`}
          position="absolute"
          left={projection().subtitleSpan!.x - projection().header.x}
          top={0}
          width={projection().subtitleSpan!.width}
          height={1}
        >
          <text fg={host.theme().roles.text.muted}>{projection().subtitleSpan!.text}</text>
        </box>
      </Show>
    </>
  );
}

function projectedStatusChip(
  projection: PaneFrameProjection,
  props: PaneFrameStatusLeafProps,
): PaneFrameChip | null {
  return (
    projection.chips.find((chip) => {
      if (props.item.kind === "status") return chip.kind === "status" && chip.id === props.item.id;
      return chip.kind === "state" && chip.id === props.item.id;
    }) ?? null
  );
}

function OpenTuiStatus(props: PaneFrameStatusLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const chip = () => projectedStatusChip(host.projection(), props);
  return (
    <Show when={chip() !== null}>
      <box
        id={`pane-frame:${props.pane.id}:${props.item.kind}:${props.item.id}`}
        position="absolute"
        left={chip()!.start - host.projection().header.x}
        top={0}
        width={chip()!.width}
        height={1}
      >
        <Chip theme={host.theme()} chip={chip()!} />
      </box>
    </Show>
  );
}

function OpenTuiActionList(props: PaneFrameActionListLeafProps) {
  return props.children;
}

function OpenTuiAction(props: PaneFrameActionLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const chip = () =>
    host.projection().actions.find((action) => action.id === props.action.id) ?? null;
  return (
    <Show when={chip() !== null}>
      <box
        id={`pane-frame:${props.pane.id}:action:${props.action.id}`}
        position="absolute"
        left={chip()!.start - host.projection().header.x}
        top={0}
        width={chip()!.width}
        height={1}
        onMouseDown={
          host.inputOwner() && props.interactive && chip()!.interactive
            ? props.onActivate
            : undefined
        }
      >
        <Chip theme={host.theme()} chip={chip()!} />
      </box>
    </Show>
  );
}

function OpenTuiBody(props: PaneFrameBodyLeafProps) {
  const host = useOpenTuiPaneFrameHost();
  const projection = host.projection;
  return (
    <box
      id={`pane-frame:${props.pane.id}:body`}
      position="absolute"
      left={projection().body.x}
      top={projection().body.y}
      width={projection().body.width}
      height={projection().body.height}
      flexDirection="column"
      backgroundColor={host.theme().roles.surfaces.terminal}
      overflow="hidden"
    >
      {props.children}
    </box>
  );
}

export const OPEN_TUI_PANE_FRAME_HOST = Object.freeze({
  Root: OpenTuiRoot,
  Header: OpenTuiHeader,
  Grip: OpenTuiGrip,
  Title: OpenTuiTitle,
  Status: OpenTuiStatus,
  ActionList: OpenTuiActionList,
  Action: OpenTuiAction,
  Body: OpenTuiBody,
}) satisfies PaneFrameHostLeaves;

export interface PaneFrameProps extends PaneFrameHeaderProps {
  children?: JSX.Element;
  /** Standalone fixture/test ownership only. Production terminal chrome stays passive. */
  inputOwner?: boolean;
  onActionActivate?: Parameters<typeof PaneFramePresenter>[0]["onActionActivate"];
  onGripActivate?: Parameters<typeof PaneFramePresenter>[0]["onGripActivate"];
}

export function PaneFrame(props: PaneFrameProps) {
  const context: OpenTuiPaneFrameHostContext = {
    theme: () => props.theme,
    projection: () => props.projection,
    inputOwner: () => props.inputOwner === true,
  };
  return (
    <OpenTuiPaneFrameContext.Provider value={context}>
      <PaneFramePresenter
        model={props.projection.model}
        host={OPEN_TUI_PANE_FRAME_HOST}
        body={props.children}
        onActionActivate={props.onActionActivate}
        onGripActivate={props.onGripActivate}
      />
    </OpenTuiPaneFrameContext.Provider>
  );
}
