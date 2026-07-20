/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import { rollupChips, type FleetRollup } from "../team/home.ts";
import { STATUS_GLYPH } from "./status-grammar.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { ActionChip, EmptyState, SectionHeader, SelectableRow } from "./recipes.tsx";
import {
  homeActionAtProjection,
  type HomeActionId,
  type HomeSurfaceProjection,
} from "./home-surface.ts";
import { actionChipWidth, recipePalette } from "./recipes.ts";
import { clipTerminal } from "./missions-workspace.ts";

export interface HomeSurfaceProps {
  theme: SemanticThemeSnapshot;
  projection: HomeSurfaceProjection;
  rollup: FleetRollup;
}

export function HomeSurface(props: HomeSurfaceProps) {
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <HomeHeader theme={props.theme} projection={props.projection} rollup={props.rollup} />
      <HomeWelcome theme={props.theme} projection={props.projection} />
      <For each={props.projection.rows}>
        {(row) => (
          <box position="absolute" left={0} top={row.y} width={row.width} height={1}>
            <Show
              when={row.role !== "section"}
              fallback={<SectionHeader theme={props.theme} title={row.label} width={row.width} />}
            >
              <HomeRow theme={props.theme} row={row} />
            </Show>
          </box>
        )}
      </For>
      <box
        position="absolute"
        left={0}
        top={props.projection.footer.y}
        width={props.projection.width}
        height={1}
        paddingLeft={1}
      >
        <Show
          when={props.projection.prompt}
          fallback={
            <Show
              when={props.projection.rows.length > 0 || props.projection.firstRun}
              fallback={
                <EmptyState
                  theme={props.theme}
                  title="No projects yet"
                  detail="Open a folder to start."
                  width={props.projection.width}
                />
              }
            >
              <text fg={props.theme.colors.accent}>{props.projection.detail}</text>
            </Show>
          }
        >
          {(prompt) => (
            <box flexDirection="row" overflow="hidden">
              <text fg={props.theme.colors.accent}>{`${prompt().label}: `}</text>
              <text fg={props.theme.colors.foreground}>{`${prompt().value}▏`}</text>
            </box>
          )}
        </Show>
      </box>
      <box
        position="absolute"
        left={0}
        top={props.projection.footerActionY}
        width={props.projection.width}
        height={1}
        overflow="hidden"
      >
        <text fg={props.theme.colors.mutedForeground}>
          {clipTerminal(` ${props.projection.footerHint}`, props.projection.width)}
        </text>
        <For each={props.projection.footerActionSpans}>
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
    </box>
  );
}

function HomeHeader(props: {
  theme: SemanticThemeSnapshot;
  projection: HomeSurfaceProjection;
  rollup: FleetRollup;
}) {
  return (
    <>
      <box
        position="absolute"
        left={0}
        top={0}
        width={props.projection.width}
        height={1}
        paddingLeft={1}
        flexDirection="row"
        gap={1}
        overflow="hidden"
      >
        <text fg={props.theme.colors.accent} attributes={1}>
          {props.projection.title}
        </text>
        <text fg={props.theme.colors.mutedForeground}>{`· ${props.projection.subtitle}`}</text>
        <For each={rollupChips(props.rollup)}>
          {(chip) => (
            <text fg={props.theme.colors.status[chip.status]}>
              {`${STATUS_GLYPH[chip.status]} ${chip.count}`}
            </text>
          )}
        </For>
      </box>
      <box
        position="absolute"
        left={0}
        top={1}
        width={props.projection.width}
        height={1}
        overflow="hidden"
      >
        <text fg={props.theme.colors.mutedForeground}>
          {"─".repeat(Math.max(0, props.projection.width))}
        </text>
      </box>
    </>
  );
}

function HomeWelcome(props: { theme: SemanticThemeSnapshot; projection: HomeSurfaceProjection }) {
  return (
    <Show when={props.projection.welcome}>
      {(welcome) => (
        <For each={welcome().rows}>
          {(row) => (
            <box position="absolute" left={row.x} top={row.y} height={1}>
              <Show
                when={row.role === "action"}
                fallback={
                  <text
                    fg={
                      row.role === "hint"
                        ? props.theme.colors.mutedForeground
                        : props.theme.colors.foreground
                    }
                  >
                    {row.text}
                  </text>
                }
              >
                <ActionChip
                  theme={props.theme}
                  label={row.text}
                  width={welcome().action.width}
                  hovered={welcome().action.hovered}
                />
              </Show>
            </box>
          )}
        </For>
      )}
    </Show>
  );
}

function HomeRow(props: {
  theme: SemanticThemeSnapshot;
  row: HomeSurfaceProjection["rows"][number];
}) {
  const tone = () =>
    props.row.status === "blocked"
      ? "blocked"
      : props.row.status === "working"
        ? "working"
        : props.row.status === "done"
          ? "done"
          : props.row.status === "idle"
            ? "idle"
            : props.row.status === "unknown"
              ? "unknown"
              : props.row.role === "session"
                ? "accent"
                : "neutral";
  const palette = () =>
    recipePalette(
      props.theme,
      {
        selected: props.row.selected,
        hovered: props.row.hovered,
        attention: props.row.attention,
        status: props.row.status,
      },
      tone(),
    );
  const labelWidth = () => Math.max(1, props.row.width - actionWidth(props.row));
  return (
    <box height={1} flexDirection="row" backgroundColor={palette().background} overflow="hidden">
      <SelectableRow
        theme={props.theme}
        label={props.row.label}
        meta={props.row.meta}
        width={labelWidth()}
        selected={props.row.selected}
        hovered={props.row.hovered}
        attention={props.row.attention}
        status={props.row.status}
        tone={tone()}
      />
      <For each={props.row.actionSpans}>
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

function actionWidth(row: HomeSurfaceProjection["rows"][number]): number {
  return row.actionSpans.reduce((sum, action) => sum + actionChipWidth(action.label), 0);
}

export { homeActionAtProjection };
export type { HomeActionId };
