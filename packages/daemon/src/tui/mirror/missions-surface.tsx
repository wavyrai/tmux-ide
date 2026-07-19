/* @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core";
import { For, Show } from "solid-js";
import type { MissionDashboardProjection } from "./missions-dashboard.ts";
import {
  ACCENT,
  BADGE_BG,
  BUTTON_HOVER_BG,
  DEFAULT_BG,
  DEFAULT_FG,
  HOVER_BG,
  MUTED,
} from "./theme.ts";
import {
  clipTerminal,
  missionWorkspaceLayout,
  type MissionDeepLinkKind,
  type MissionDeepLinkResolution,
  type MissionWorkspaceLayout,
  type MissionWorkspaceLoadState,
  type MissionWorkspaceModel,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";

export type MissionSurfaceHoverRegion =
  | "missionmode"
  | "missionbutton"
  | "missioncard"
  | "missionhistory";

export interface MissionSurfaceTheme {
  bannerFg: RGBA;
  buttonFg: RGBA;
  buttonBg: RGBA;
  buttonActiveBg: RGBA;
}

export interface MissionSurfaceProps {
  width: number;
  dashboard: MissionDashboardProjection;
  model: MissionWorkspaceModel;
  snapshot: MissionWorkspaceSnapshot | null;
  loadState: MissionWorkspaceLoadState;
  errorMessage: string;
  resolveDeepLink: (kind: MissionDeepLinkKind) => MissionDeepLinkResolution;
  isHovered: (region: MissionSurfaceHoverRegion, index: number) => boolean;
  theme: MissionSurfaceTheme;
}

interface MissionMainSurfaceProps {
  width: number;
  layout: MissionWorkspaceLayout;
  model: MissionWorkspaceModel;
  snapshot: MissionWorkspaceSnapshot | null;
  loadState: MissionWorkspaceLoadState;
  errorMessage: string;
  resolveDeepLink: (kind: MissionDeepLinkKind) => MissionDeepLinkResolution;
  isHovered: (region: MissionSurfaceHoverRegion, index: number) => boolean;
  theme: MissionSurfaceTheme;
}

export function missionSurfaceLayout(
  width: number,
  height: number,
  model: MissionWorkspaceModel,
  snapshot: MissionWorkspaceSnapshot | null,
  options: Parameters<typeof missionWorkspaceLayout>[4],
): MissionWorkspaceLayout {
  return missionWorkspaceLayout(width, height, model, snapshot, options);
}

export function MissionsSurface(props: MissionSurfaceProps) {
  return (
    <box width={props.width} height={props.dashboard.height} flexDirection="row" gap={1}>
      <box
        width={props.dashboard.main.width}
        height={props.dashboard.main.height}
        flexDirection="column"
        overflow="hidden"
      >
        <MissionMainSurface
          width={props.dashboard.main.width}
          layout={props.dashboard.main.layout}
          model={props.model}
          snapshot={props.snapshot}
          loadState={props.loadState}
          errorMessage={props.errorMessage}
          resolveDeepLink={props.resolveDeepLink}
          isHovered={props.isHovered}
          theme={props.theme}
        />
      </box>
      <Show when={props.dashboard.inspector}>
        {(inspector) => (
          <box
            width={inspector().width}
            height={inspector().height}
            flexDirection="column"
            border={inspector().width >= 2 && inspector().height >= 2}
            borderColor={MUTED}
            overflow="hidden"
            backgroundColor={DEFAULT_BG}
          >
            <Show when={inspector().titleRows > 0}>
              <text fg={ACCENT}>
                {clipTerminal(inspector().title, Math.max(0, inspector().width - 2))}
              </text>
            </Show>
            <For each={inspector().rows.slice(0, inspector().bodyRows)}>
              {(row) => (
                <box height={1} flexDirection="row" overflow="hidden">
                  <text fg={row.emphasis ? ACCENT : MUTED}>{row.label}</text>
                  <text fg={MUTED}>{": "}</text>
                  <text fg={row.emphasis ? DEFAULT_FG : MUTED}>{row.value}</text>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  );
}

function MissionMainSurface(props: MissionMainSurfaceProps) {
  const ready = () =>
    props.snapshot &&
    props.loadState.status !== "loading" &&
    !(props.loadState.status === "error" && !props.snapshot) &&
    props.loadState.status !== "empty";

  return (
    <>
      <box width={props.width} flexDirection="row" gap={1}>
        <For each={props.layout.header.rows[0] ?? []}>
          {(chip) => (
            <text
              fg={DEFAULT_FG}
              bg={
                chip.kind === "mode" && chip.mode === props.model.mode
                  ? props.theme.buttonActiveBg
                  : chip.kind === "mode" &&
                      props.isHovered("missionmode", chip.mode === "board" ? 0 : 1)
                    ? BUTTON_HOVER_BG
                    : chip.kind === "refresh" && props.isHovered("missionbutton", 0)
                      ? BUTTON_HOVER_BG
                      : chip.kind === "density" && props.isHovered("missionbutton", 1)
                        ? BUTTON_HOVER_BG
                        : chip.kind === "collapse" && props.isHovered("missionbutton", 4)
                          ? BUTTON_HOVER_BG
                          : chip.kind === "zoom" && props.isHovered("missionbutton", 5)
                            ? BUTTON_HOVER_BG
                            : props.theme.buttonBg
              }
            >
              {chip.label}
            </text>
          )}
        </For>
      </box>
      <box width={props.width} flexDirection="row">
        <text
          fg={props.theme.buttonFg}
          bg={props.isHovered("missionbutton", 2) ? BUTTON_HOVER_BG : props.theme.buttonBg}
        >
          {"<"}
        </text>
        <text fg={MUTED}>
          {clipTerminal(props.layout.header.labels[1].slice(1, -1), Math.max(0, props.width - 2))}
        </text>
        <Show when={props.width > 1}>
          <text
            fg={props.theme.buttonFg}
            bg={props.isHovered("missionbutton", 3) ? BUTTON_HOVER_BG : props.theme.buttonBg}
          >
            {">"}
          </text>
        </Show>
      </box>
      <Show when={props.loadState.status === "loading"}>
        <box flexDirection="column" flexGrow={1}>
          <box height={1} />
          <text fg={DEFAULT_FG}>Loading missions…</text>
          <text fg={MUTED}>Mission history is read from the active project runtime.</text>
        </box>
      </Show>
      <Show when={props.loadState.status === "error" && !props.snapshot}>
        <box flexDirection="column" flexGrow={1}>
          <box height={1} />
          <text fg={props.theme.bannerFg}>Mission data could not be loaded.</text>
          <text fg={MUTED}>{props.errorMessage}</text>
          <text fg={MUTED}>Press r to retry. Other workspace views remain available.</text>
        </box>
      </Show>
      <Show when={props.loadState.status === "empty"}>
        <box flexDirection="column" flexGrow={1}>
          <box height={1} />
          <text fg={DEFAULT_FG}>No missions yet.</text>
          <text fg={MUTED}>This read-only board will populate from durable mission history.</text>
        </box>
      </Show>
      <Show when={ready()}>
        <Show when={props.model.mode === "board"}>
          <box flexDirection="row" flexGrow={1} gap={1}>
            <For each={props.layout.board.columns}>
              {(column) => (
                <box
                  flexDirection="column"
                  width={column.width}
                  height={column.height}
                  border={column.width >= 2 && column.height >= 2}
                  borderColor={column.active ? ACCENT : MUTED}
                  backgroundColor={DEFAULT_BG}
                  overflow="hidden"
                >
                  <Show when={column.showTitle}>
                    <text fg={column.active ? ACCENT : MUTED}>
                      {clipTerminal(column.title, column.bodyWidth)}
                    </text>
                  </Show>
                  <For each={column.cards}>
                    {(cardLayout) => {
                      const selected = props.model.selectedMissionId === cardLayout.missionId;
                      return (
                        <box
                          flexDirection="column"
                          height={cardLayout.height}
                          backgroundColor={
                            selected
                              ? BADGE_BG
                              : props.isHovered("missioncard", cardLayout.hoverKey)
                                ? HOVER_BG
                                : DEFAULT_BG
                          }
                        >
                          <For each={cardLayout.lines}>
                            {(line, lineIndex) => (
                              <text
                                fg={
                                  selected && lineIndex() === 0
                                    ? ACCENT
                                    : lineIndex() === 0
                                      ? DEFAULT_FG
                                      : MUTED
                                }
                              >
                                {clipTerminal(line, cardLayout.width)}
                              </text>
                            )}
                          </For>
                        </box>
                      );
                    }}
                  </For>
                </box>
              )}
            </For>
          </box>
        </Show>
        <Show when={props.model.mode === "history"}>
          <box flexDirection="column" flexGrow={1}>
            <For each={props.layout.history.rows}>
              {(row) => {
                const selected = props.model.selectedMissionId === row.missionId;
                return (
                  <box
                    flexDirection="column"
                    height={row.height}
                    backgroundColor={
                      selected
                        ? BADGE_BG
                        : props.isHovered("missionhistory", row.hoverKey)
                          ? HOVER_BG
                          : DEFAULT_BG
                    }
                  >
                    <For each={row.lines}>
                      {(line, lineIndex) => (
                        <text fg={lineIndex() === 0 ? DEFAULT_FG : MUTED}>
                          {clipTerminal(line, row.width)}
                        </text>
                      )}
                    </For>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
        <Show when={props.model.mode === "detail"}>
          <box flexDirection="column" flexGrow={1}>
            <box width={props.width} flexDirection="row" gap={1}>
              <For each={props.layout.detail.sections}>
                {(chip) => (
                  <text
                    fg={DEFAULT_FG}
                    bg={
                      chip.section === props.model.detailSection ||
                      props.isHovered(
                        "missionbutton",
                        10 + props.layout.detail.sections.indexOf(chip),
                      )
                        ? props.theme.buttonActiveBg
                        : props.theme.buttonBg
                    }
                  >
                    {chip.label}
                  </text>
                )}
              </For>
              <box flexGrow={1} />
              <For each={props.layout.detail.links}>
                {(chip) => {
                  const resolved = chip.link ? props.resolveDeepLink(chip.link) : null;
                  return (
                    <text
                      fg={resolved?.available ? props.theme.buttonFg : MUTED}
                      bg={
                        chip.link &&
                        props.isHovered(
                          "missionbutton",
                          20 + props.layout.detail.links.indexOf(chip),
                        )
                          ? BUTTON_HOVER_BG
                          : props.theme.buttonBg
                      }
                    >
                      {chip.label}
                    </text>
                  );
                }}
              </For>
            </box>
            <Show
              when={props.snapshot?.detail}
              fallback={
                <box flexDirection="column" flexGrow={1}>
                  <text fg={DEFAULT_FG}>Loading mission detail…</text>
                  <text fg={MUTED}>Press r to refresh if this does not resolve.</text>
                </box>
              }
            >
              <box flexDirection="row" flexGrow={1} gap={1}>
                <Show when={props.layout.detail.wide}>
                  <box flexDirection="column" width={props.layout.detail.contextWidth}>
                    <For each={props.layout.detail.contextRows}>
                      {(row) => (
                        <For each={row.lines}>
                          {(line, lineIndex) => (
                            <text fg={lineIndex() === 0 ? ACCENT : MUTED}>{line}</text>
                          )}
                        </For>
                      )}
                    </For>
                  </box>
                </Show>
                <box flexDirection="column" width={props.layout.detail.sectionWidth}>
                  <For each={props.layout.detail.rows}>
                    {(row) => {
                      const selected =
                        row.kind === "tasks" && props.model.selectedTaskId === row.id;
                      return (
                        <box
                          flexDirection="column"
                          height={row.height}
                          backgroundColor={
                            selected
                              ? BADGE_BG
                              : props.isHovered("missionhistory", row.hoverKey)
                                ? HOVER_BG
                                : DEFAULT_BG
                          }
                        >
                          <For each={row.lines}>
                            {(line, lineIndex) => (
                              <text fg={lineIndex() === 0 ? DEFAULT_FG : MUTED}>{line}</text>
                            )}
                          </For>
                        </box>
                      );
                    }}
                  </For>
                </box>
              </box>
            </Show>
          </box>
        </Show>
      </Show>
      <text fg={MUTED}>{props.layout.footer.label}</text>
    </>
  );
}
