/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import { recipePalette } from "./recipes.ts";
import { SelectableRow } from "./recipes.tsx";
import type { SemanticThemeSnapshot } from "./theme.ts";
import type {
  ActivityProjectedRow,
  ActivitySurfaceProjection,
  ActivitySurfaceState,
} from "./activity-surface.ts";

export interface ActivitySurfaceProps {
  theme: SemanticThemeSnapshot;
  projection: ActivitySurfaceProjection;
}

/** Presentational dock-only aggregate. The application root owns every input and data adapter. */
export function ActivitySurface(props: ActivitySurfaceProps) {
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      backgroundColor={props.theme.colors.surface}
      overflow="hidden"
    >
      <Show when={props.projection.header.height > 0}>
        <ActivityHeader theme={props.theme} projection={props.projection} />
      </Show>

      <Show
        when={props.projection.state === "ready" && props.projection.rows.length > 0}
        fallback={
          <ActivityStateMessage
            theme={props.theme}
            state={props.projection.state}
            message={props.projection.message}
            projection={props.projection}
          />
        }
      >
        <For each={props.projection.rows}>
          {(row) => <ActivityRow theme={props.theme} row={row} />}
        </For>
        <For each={props.projection.scrollbar.glyphs}>
          {(glyph, index) => (
            <box
              position="absolute"
              left={props.projection.scrollbar.x}
              top={props.projection.scrollbar.y + index()}
              width={props.projection.scrollbar.width}
              height={1}
            >
              <text
                fg={glyph === "█" ? props.theme.colors.accent : props.theme.colors.mutedForeground}
              >
                {glyph}
              </text>
            </box>
          )}
        </For>
      </Show>

      <Show when={props.projection.footer.height > 0}>
        <box
          position="absolute"
          left={props.projection.footer.x}
          top={props.projection.footer.y}
          width={props.projection.footer.width}
          height={props.projection.footer.height}
          paddingLeft={1}
          backgroundColor={props.theme.colors.background}
          overflow="hidden"
        >
          <text fg={props.theme.colors.mutedForeground}>{props.projection.footerText}</text>
        </box>
      </Show>
    </box>
  );
}

function ActivityHeader(props: {
  theme: SemanticThemeSnapshot;
  projection: ActivitySurfaceProjection;
}) {
  return (
    <box
      position="absolute"
      left={props.projection.header.x}
      top={props.projection.header.y}
      width={props.projection.header.width}
      height={props.projection.header.height}
      paddingLeft={1}
      flexDirection="row"
      gap={1}
      backgroundColor={props.theme.colors.surfaceRaised}
      overflow="hidden"
    >
      <text fg={props.theme.colors.accent} attributes={1}>
        {props.projection.title}
      </text>
      <text fg={props.theme.colors.mutedForeground}>{`· ${props.projection.summary}`}</text>
    </box>
  );
}

function ActivityRow(props: { theme: SemanticThemeSnapshot; row: ActivityProjectedRow }) {
  return (
    <box
      position="absolute"
      left={props.row.x}
      top={props.row.y}
      width={props.row.width}
      height={props.row.height}
      overflow="hidden"
    >
      <SelectableRow
        theme={props.theme}
        label={props.row.label}
        meta={props.row.meta}
        width={props.row.width}
        selected={props.row.selected}
        attention={props.row.attention}
        status={props.row.status}
        tone={props.row.status}
      />
    </box>
  );
}

function ActivityStateMessage(props: {
  theme: SemanticThemeSnapshot;
  state: ActivitySurfaceState;
  message: string;
  projection: ActivitySurfaceProjection;
}) {
  const palette = () =>
    recipePalette(props.theme, {
      loading: props.state === "loading",
      empty: props.state === "empty",
      status: props.state === "error" ? "blocked" : undefined,
    });
  const title = () => {
    if (props.state === "loading") return "Loading activity";
    if (props.state === "error") return "Activity unavailable";
    return "No activity yet";
  };
  return (
    <Show when={props.projection.body.height > 0}>
      <box
        position="absolute"
        left={props.projection.body.x}
        top={props.projection.body.y}
        width={props.projection.body.width}
        height={props.projection.body.height}
        paddingLeft={1}
        flexDirection="column"
        backgroundColor={palette().background}
        overflow="hidden"
      >
        <box height={1} flexDirection="row" overflow="hidden">
          <text fg={palette().accent}>{palette().marker}</text>
          <text fg={palette().foreground}>{` ${title()}`}</text>
        </box>
        <Show when={props.projection.body.height > 1}>
          <text fg={props.theme.colors.mutedForeground}>{`  ${props.message}`}</text>
        </Show>
      </box>
    </Show>
  );
}
