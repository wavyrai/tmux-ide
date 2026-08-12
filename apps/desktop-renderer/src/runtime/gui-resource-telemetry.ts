import type { PushResourceSessionMetrics } from "@tmux-ide/daemon-client/push-resource-session";

export const GUI_RESOURCE_TELEMETRY_QUERY = "tmuxIdeResourceTelemetry";
export const GUI_RESOURCE_TELEMETRY_GLOBAL = "__TMUX_IDE_GUI_RESOURCE_TELEMETRY__";

export interface GuiResourceTelemetrySnapshot {
  readonly idleWakeups: number;
  readonly storeInvalidations: number;
  readonly storePublications: number;
  /** Number of times the live application composition was mounted. */
  readonly compositionMounts: number;
  /** Coalesced frame opportunities requested by central-shell projection changes. */
  readonly centralShellFrameOpportunities: number;
  readonly activeSubscriptions: number;
  readonly fetchesStarted: number;
  readonly fetchesSettled: number;
  readonly fetchesAborted: number;
  /** GUI resource stores use IPC/HTTP only and structurally launch no subprocesses. */
  readonly rendererSubprocessLaunches: 0;
}

export interface GuiResourceTelemetrySource {
  getMetrics(): PushResourceSessionMetrics;
}

export interface GuiResourceTelemetry {
  snapshot(): GuiResourceTelemetrySnapshot;
  recordCompositionMount(): void;
  recordCentralShellFrameOpportunity(): void;
  exposeDebugAccessor(search?: string): () => void;
}

export function createGuiResourceTelemetry(
  sources: readonly GuiResourceTelemetrySource[],
): GuiResourceTelemetry {
  let compositionMounts = 0;
  let centralShellFrameOpportunities = 0;
  const snapshot = (): GuiResourceTelemetrySnapshot => {
    const metrics = sources.map((source) => source.getMetrics());
    return {
      idleWakeups: metrics.reduce((total, value) => total + value.idleWakeups, 0),
      storeInvalidations: metrics.reduce((total, value) => total + value.invalidationsObserved, 0),
      storePublications: metrics.reduce((total, value) => total + value.publications, 0),
      compositionMounts,
      centralShellFrameOpportunities,
      activeSubscriptions: metrics.reduce(
        (total, value) =>
          total + Math.max(0, value.subscriptionsOpened - value.subscriptionsClosed),
        0,
      ),
      fetchesStarted: metrics.reduce((total, value) => total + value.fetchesStarted, 0),
      fetchesSettled: metrics.reduce((total, value) => total + value.fetchesSettled, 0),
      fetchesAborted: metrics.reduce((total, value) => total + value.fetchesAborted, 0),
      rendererSubprocessLaunches: 0,
    };
  };
  const accessor = () => snapshot();
  return {
    snapshot,
    recordCompositionMount: () => {
      compositionMounts += 1;
    },
    recordCentralShellFrameOpportunity: () => {
      centralShellFrameOpportunities += 1;
    },
    exposeDebugAccessor(search = globalThis.location?.search ?? "") {
      if (new URLSearchParams(search).get(GUI_RESOURCE_TELEMETRY_QUERY) !== "1") {
        return () => undefined;
      }
      const host = globalThis as unknown as Record<string, unknown>;
      host[GUI_RESOURCE_TELEMETRY_GLOBAL] = accessor;
      return () => {
        if (host[GUI_RESOURCE_TELEMETRY_GLOBAL] === accessor) {
          delete host[GUI_RESOURCE_TELEMETRY_GLOBAL];
        }
      };
    },
  };
}
