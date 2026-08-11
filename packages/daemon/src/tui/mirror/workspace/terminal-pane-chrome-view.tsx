/* @jsxImportSource @opentui/solid */
import { createMemo, For } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { PaneFrame } from "./pane-frame.tsx";
import type {
  TerminalPaneCommunicationRole,
  TerminalPaneChromeLayout,
  TerminalPaneChromeProjection,
} from "./terminal-pane-chrome.ts";

export interface SharedTerminalPaneChromeLayerProps {
  theme: SemanticThemeSnapshot;
  layout: TerminalPaneChromeLayout;
  layer: "native" | "framebuffer";
}

function communicationColor(theme: SemanticThemeSnapshot, role: TerminalPaneCommunicationRole) {
  return role.startsWith("read") ? theme.roles.statusTone.info : theme.roles.statusTone.success;
}

function communicationGlyph(
  role: TerminalPaneCommunicationRole,
  orientation: "horizontal" | "vertical",
) {
  if (role.startsWith("read")) {
    // Observation is deliberately lighter than focus or input transfer: a
    // dotted rail says "this pane was inspected" without looking activated.
    if (orientation === "horizontal") return role === "read-target" ? "┈" : "·";
    return role === "read-target" ? "┊" : "·";
  }
  const target = role.endsWith("target");
  if (orientation === "horizontal") return target ? "━" : "┄";
  return target ? "┃" : "┊";
}

export function TerminalPaneCommunicationLayer(props: {
  theme: SemanticThemeSnapshot;
  layout: TerminalPaneChromeLayout;
}) {
  const segments = () => props.layout.communication;
  const segmentIds = createMemo(() => segments().map(communicationSegmentIdentity), undefined, {
    equals: sameIds,
  });
  const segmentsById = createMemo(
    () => new Map(segments().map((segment) => [communicationSegmentIdentity(segment), segment])),
  );
  return (
    <For each={segmentIds()}>
      {(segmentId) => {
        const segment = () => segmentsById().get(segmentId)!;
        return (
          <box
            id={`terminal-pane-communication:${segmentId}`}
            position="absolute"
            left={segment().rect.x}
            top={segment().rect.y}
            width={segment().rect.width}
            height={segment().rect.height}
            overflow="hidden"
          >
            <text fg={communicationColor(props.theme, segment().role)}>
              {segment().orientation === "horizontal"
                ? communicationGlyph(segment().role, "horizontal").repeat(segment().rect.width)
                : Array(segment().rect.height)
                    .fill(communicationGlyph(segment().role, "vertical"))
                    .join("\n")}
            </text>
          </box>
        );
      }}
    </For>
  );
}

function communicationSegmentIdentity(
  segment: TerminalPaneChromeLayout["communication"][number],
): string {
  return `${segment.paneId}:${segment.orientation}:${segment.rect.x}:${segment.rect.y}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Passive projection surface; the application root remains the only input owner. */
export function SharedTerminalPaneChromeLayer(props: SharedTerminalPaneChromeLayerProps) {
  const projections = (): readonly TerminalPaneChromeProjection[] =>
    props.layer === "native" ? props.layout.native : props.layout.framebuffer;
  // projectTerminalPaneChrome intentionally returns immutable value objects.
  // Keying Solid's <For> by those short-lived objects would tear down and
  // reinsert every header on visual-state ticks. Resolve fresh values through
  // pane ids so resident renderables survive focus/status/action changes.
  const projectionIds = createMemo(
    () =>
      projections()
        .filter((projection) => projection.frame !== null)
        .map((projection) => projection.paneId),
    undefined,
    { equals: sameIds },
  );
  const projectionsById = createMemo(
    () => new Map(projections().map((projection) => [projection.paneId, projection])),
  );
  return (
    <For each={projectionIds()}>
      {(paneId) => {
        const pane = () => projectionsById().get(paneId)!;
        const frame = () => pane().frame!;
        return (
          <box
            id={`shared-terminal-pane-chrome:${props.layer}:${paneId}`}
            position="absolute"
            left={pane().layerRect.x}
            top={pane().layerRect.y}
            width={pane().layerRect.width}
            height={pane().layerRect.height}
            overflow="hidden"
          >
            <PaneFrame theme={props.theme} projection={frame()} />
          </box>
        );
      }}
    </For>
  );
}
