import type {
  LocalPerformanceDistributionV1,
  LocalPerformanceSnapshotV1,
} from "@tmux-ide/contracts";
import { createSignal, onCleanup, onMount } from "solid-js";

import type { GuiPerformanceTelemetry } from "./gui-performance-telemetry.ts";

function metric(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(value >= 100 ? 0 : 1)}${suffix}`;
}

function p95(value: LocalPerformanceDistributionV1): string {
  return metric(value.p95, " ms");
}

export function GuiPerformanceHud(props: {
  readonly telemetry: GuiPerformanceTelemetry;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const [snapshot, setSnapshot] = createSignal<LocalPerformanceSnapshotV1 | null>(null);
  let unsubscribe: (() => void) | null = null;
  onMount(() => {
    unsubscribe = props.telemetry.subscribe(setSnapshot);
  });
  onCleanup(() => unsubscribe?.());

  return (
    <aside
      class="gui-performance-hud"
      aria-label="Performance HUD"
      aria-hidden={!props.open}
      data-open={props.open}
      data-source={snapshot()?.source}
    >
      <header>
        <span>
          <i aria-hidden="true" /> Performance
        </span>
        <button type="button" aria-label="Close performance HUD" onClick={props.onClose}>
          ×
        </button>
      </header>
      <div class="gui-performance-hud__metrics">
        <dl>
          <dt>Active FPS</dt>
          <dd>{metric(snapshot()?.activeFps ?? null)}</dd>
        </dl>
        <dl>
          <dt>Paint p95</dt>
          <dd>{snapshot() ? p95(snapshot()!.paintMs) : "—"}</dd>
        </dl>
        <dl>
          <dt>Parse p95</dt>
          <dd>{snapshot() ? p95(snapshot()!.parseMs) : "—"}</dd>
        </dl>
        <dl>
          <dt>Dirty rows p95</dt>
          <dd>{metric(snapshot()?.dirtyRows.p95 ?? null)}</dd>
        </dl>
        <dl>
          <dt>Queue</dt>
          <dd>
            {snapshot()?.queueDepth.current ?? "—"} / {snapshot()?.queueDepth.peak ?? "—"}
          </dd>
        </dl>
        <dl>
          <dt>Revision lag</dt>
          <dd>{snapshot()?.revisionLag.current ?? "—"}</dd>
        </dl>
        <dl>
          <dt>Reseeds</dt>
          <dd>{snapshot()?.reseeds ?? "—"}</dd>
        </dl>
      </div>
      <footer>{snapshot()?.authority.workspaceName ?? "Local renderer"} · F12</footer>
    </aside>
  );
}
