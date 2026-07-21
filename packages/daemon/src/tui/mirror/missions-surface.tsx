/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { MissionDashboardProjection } from "./missions-dashboard.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
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

export interface MissionSurfaceProps {
  width: number;
  dashboard: MissionDashboardProjection;
  model: MissionWorkspaceModel;
  snapshot: MissionWorkspaceSnapshot | null;
  loadState: MissionWorkspaceLoadState;
  errorMessage: string;
  resolveDeepLink: (kind: MissionDeepLinkKind) => MissionDeepLinkResolution;
  isHovered: (region: MissionSurfaceHoverRegion, index: number) => boolean;
  theme: SemanticThemeSnapshot;
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
  theme: SemanticThemeSnapshot;
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
  const semantic = () => props.theme;
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
            borderColor={semantic().roles.borders.default}
            overflow="hidden"
            backgroundColor={semantic().roles.surfaces.canvas}
          >
            <Show when={inspector().titleRows > 0}>
              <text fg={semantic().roles.text.link}>
                {clipTerminal(inspector().title, Math.max(0, inspector().width - 2))}
              </text>
            </Show>
            <For each={inspector().rows.slice(0, inspector().bodyRows)}>
              {(row) => (
                <box height={1} flexDirection="row" overflow="hidden">
                  <text
                    fg={row.emphasis ? semantic().roles.text.link : semantic().roles.text.muted}
                  >
                    {row.label}
                  </text>
                  <text fg={semantic().roles.text.muted}>{": "}</text>
                  <text
                    fg={row.emphasis ? semantic().roles.text.primary : semantic().roles.text.muted}
                  >
                    {row.value}
                  </text>
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
  const semantic = () => props.theme;
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
              fg={semantic().roles.text.primary}
              bg={
                chip.kind === "mode" && chip.mode === props.model.mode
                  ? semantic().roles.selection.selection
                  : chip.kind === "mode" &&
                      props.isHovered("missionmode", chip.mode === "board" ? 0 : 1)
                    ? semantic().roles.selection.hover
                    : chip.kind === "refresh" && props.isHovered("missionbutton", 0)
                      ? semantic().roles.selection.hover
                      : chip.kind === "density" && props.isHovered("missionbutton", 1)
                        ? semantic().roles.selection.hover
                        : chip.kind === "collapse" && props.isHovered("missionbutton", 4)
                          ? semantic().roles.selection.hover
                          : chip.kind === "zoom" && props.isHovered("missionbutton", 5)
                            ? semantic().roles.selection.hover
                            : semantic().roles.surfaces.header
              }
            >
              {chip.label}
            </text>
          )}
        </For>
      </box>
      <box width={props.width} flexDirection="row">
        <text
          fg={semantic().roles.text.secondary}
          bg={
            props.isHovered("missionbutton", 2)
              ? semantic().roles.selection.hover
              : semantic().roles.surfaces.header
          }
        >
          {"<"}
        </text>
        <text fg={semantic().roles.text.muted}>
          {clipTerminal(props.layout.header.labels[1].slice(1, -1), Math.max(0, props.width - 2))}
        </text>
        <Show when={props.width > 1}>
          <text
            fg={semantic().roles.text.secondary}
            bg={
              props.isHovered("missionbutton", 3)
                ? semantic().roles.selection.hover
                : semantic().roles.surfaces.header
            }
          >
            {">"}
          </text>
        </Show>
      </box>
      <Show when={props.loadState.status === "loading"}>
        <box flexDirection="column" flexGrow={1}>
          <box height={1} />
          <text fg={semantic().roles.text.primary}>Loading missions…</text>
          <text fg={semantic().roles.text.muted}>
            Mission history is read from the active project runtime.
          </text>
        </box>
      </Show>
      <Show when={props.loadState.status === "error" && !props.snapshot}>
        <box flexDirection="column" flexGrow={1}>
          <box height={1} />
          <text fg={semantic().roles.statusTone.danger}>Mission data could not be loaded.</text>
          <text fg={semantic().roles.text.muted}>{props.errorMessage}</text>
          <text fg={semantic().roles.text.muted}>
            Press r to retry. Other workspace views remain available.
          </text>
        </box>
      </Show>
      <Show when={props.loadState.status === "empty"}>
        <box flexDirection="column" flexGrow={1}>
          <box height={1} />
          <text fg={semantic().roles.text.primary}>No missions yet.</text>
          <text fg={semantic().roles.text.muted}>
            This read-only board will populate from durable mission history.
          </text>
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
                  borderColor={
                    column.active
                      ? semantic().roles.borders.focused
                      : semantic().roles.borders.default
                  }
                  backgroundColor={semantic().roles.surfaces.canvas}
                  overflow="hidden"
                >
                  <Show when={column.showTitle}>
                    <text
                      fg={column.active ? semantic().roles.text.link : semantic().roles.text.muted}
                    >
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
                              ? semantic().roles.selection.selection
                              : props.isHovered("missioncard", cardLayout.hoverKey)
                                ? semantic().roles.selection.hover
                                : semantic().roles.surfaces.canvas
                          }
                        >
                          <For each={cardLayout.lines}>
                            {(line, lineIndex) => (
                              <text
                                fg={
                                  selected && lineIndex() === 0
                                    ? semantic().roles.text.link
                                    : lineIndex() === 0
                                      ? semantic().roles.text.primary
                                      : semantic().roles.text.muted
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
                        ? semantic().roles.selection.selection
                        : props.isHovered("missionhistory", row.hoverKey)
                          ? semantic().roles.selection.hover
                          : semantic().roles.surfaces.canvas
                    }
                  >
                    <For each={row.lines}>
                      {(line, lineIndex) => (
                        <text
                          fg={
                            lineIndex() === 0
                              ? semantic().roles.text.primary
                              : semantic().roles.text.muted
                          }
                        >
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
                    fg={semantic().roles.text.primary}
                    bg={
                      chip.section === props.model.detailSection ||
                      props.isHovered(
                        "missionbutton",
                        10 + props.layout.detail.sections.indexOf(chip),
                      )
                        ? semantic().roles.selection.selection
                        : semantic().roles.surfaces.header
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
                      fg={
                        resolved?.available
                          ? semantic().roles.text.secondary
                          : semantic().roles.text.muted
                      }
                      bg={
                        chip.link &&
                        props.isHovered(
                          "missionbutton",
                          20 + props.layout.detail.links.indexOf(chip),
                        )
                          ? semantic().roles.selection.hover
                          : semantic().roles.surfaces.header
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
                  <text fg={semantic().roles.text.primary}>Loading mission detail…</text>
                  <text fg={semantic().roles.text.muted}>
                    Press r to refresh if this does not resolve.
                  </text>
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
                            <text
                              fg={
                                lineIndex() === 0
                                  ? semantic().roles.text.link
                                  : semantic().roles.text.muted
                              }
                            >
                              {line}
                            </text>
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
                              ? semantic().roles.selection.selection
                              : props.isHovered("missionhistory", row.hoverKey)
                                ? semantic().roles.selection.hover
                                : semantic().roles.surfaces.canvas
                          }
                        >
                          <For each={row.lines}>
                            {(line, lineIndex) => (
                              <text
                                fg={
                                  lineIndex() === 0
                                    ? semantic().roles.text.primary
                                    : semantic().roles.text.muted
                                }
                              >
                                {line}
                              </text>
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
      <text fg={semantic().roles.text.muted}>{props.layout.footer.label}</text>
    </>
  );
}
