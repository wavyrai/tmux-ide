/* @jsxImportSource @opentui/solid */
import type { LocalPerformanceDistributionV1 } from "@tmux-ide/contracts";

import type { SemanticThemeSnapshot } from "../../theme.ts";
import type { PerformanceHudSession } from "./contract.ts";

export interface PerformanceHudSurfaceProps {
  readonly session: PerformanceHudSession;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
}

export interface PerformanceHudGeometry {
  readonly mode: "full" | "medium" | "compact";
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function performanceHudGeometry(width: number, height: number): PerformanceHudGeometry {
  const mode = width >= 96 ? "full" : width >= 60 ? "medium" : "compact";
  const hudWidth = Math.min(width, mode === "full" ? 88 : mode === "medium" ? 54 : width);
  const hudHeight = Math.min(height, mode === "full" ? 4 : mode === "medium" ? 6 : 8);
  return Object.freeze({
    mode,
    left: Math.max(0, width - hudWidth),
    top: Math.max(0, height - hudHeight - 1),
    width: hudWidth,
    height: hudHeight,
  });
}

const metric = (value: number | null, suffix = "") =>
  value === null ? "—" : `${value < 10 ? value.toFixed(1) : Math.round(value)}${suffix}`;
const distribution = (value: LocalPerformanceDistributionV1, suffix = "") =>
  value.p95 === null ? "—" : `${metric(value.p50, suffix)} / ${metric(value.p95, suffix)}`;

export function PerformanceHudSurface(props: PerformanceHudSurfaceProps) {
  const geometry = () => performanceHudGeometry(props.width, props.height);
  const snapshot = () => props.session.snapshot();
  const queue = () => {
    const value = snapshot()?.queueDepth;
    if (!value) return "—";
    return value.capacity.current === null
      ? `${value.current} · peak ${value.peak}`
      : `${value.current}/${value.capacity.current} · peak ${value.peak}`;
  };
  const lag = () => {
    const value = snapshot()?.revisionLag;
    return value?.current === null || value?.current === undefined
      ? "—"
      : `${value.current} · peak ${value.peak}`;
  };
  return (
    <box
      id="performance-hud"
      position="absolute"
      left={geometry().left}
      top={geometry().top}
      width={geometry().width}
      height={geometry().height}
      flexDirection="column"
      border
      borderColor={props.theme.roles.borders.focused}
      backgroundColor={props.theme.roles.surfaces.command}
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexDirection="row">
        <text
          fg={props.theme.roles.text.link}
          attributes={1}
        >{`PERFORMANCE · ${geometry().mode}`}</text>
        <box flexGrow={1} />
        <text fg={props.theme.roles.text.muted}>F12 close</text>
      </box>
      {geometry().mode === "full" ? (
        <box flexDirection="row" gap={2}>
          <text
            fg={props.theme.roles.text.primary}
          >{`FPS ${metric(snapshot()?.activeFps ?? null)}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`dirty p50/p95 ${distribution(snapshot()?.dirtyRows ?? EMPTY)}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`parse ${distribution(snapshot()?.parseMs ?? EMPTY, "ms")}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`paint ${distribution(snapshot()?.paintMs ?? EMPTY, "ms")}`}</text>
          <text fg={props.theme.roles.text.secondary}>{`queue ${queue()}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`lag ${lag()} · reseed ${snapshot()?.reseeds ?? 0}`}</text>
        </box>
      ) : geometry().mode === "medium" ? (
        <>
          <text
            fg={props.theme.roles.text.primary}
          >{`FPS ${metric(snapshot()?.activeFps ?? null)} · dirty ${distribution(snapshot()?.dirtyRows ?? EMPTY)}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`parse ${distribution(snapshot()?.parseMs ?? EMPTY, "ms")} · paint ${distribution(snapshot()?.paintMs ?? EMPTY, "ms")}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`queue ${queue()} · lag ${lag()} · reseed ${snapshot()?.reseeds ?? 0}`}</text>
        </>
      ) : (
        <>
          <text
            fg={props.theme.roles.text.primary}
          >{`fps ${metric(snapshot()?.activeFps ?? null)} · dirty ${metric(snapshot()?.dirtyRows.latest ?? null)}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`parse ${metric(snapshot()?.parseMs.p95 ?? null, "ms")}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`paint ${metric(snapshot()?.paintMs.p95 ?? null, "ms")}`}</text>
          <text fg={props.theme.roles.text.secondary}>{`queue ${queue()}`}</text>
          <text
            fg={props.theme.roles.text.secondary}
          >{`lag ${lag()} · seed ${snapshot()?.reseeds ?? 0}`}</text>
        </>
      )}
    </box>
  );
}

const EMPTY: LocalPerformanceDistributionV1 = Object.freeze({
  count: 0,
  latest: null,
  p50: null,
  p95: null,
  max: null,
});
