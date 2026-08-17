import { randomUUID } from "node:crypto";
import type { Accessor, Setter } from "solid-js";
import type { SessionRuntimeTerminalInput } from "@tmux-ide/contracts";
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import {
  type OpenTuiWorkspaceLayout,
  type OpenTuiWorkspaceLayoutSnapshot,
} from "../open-tui-workspace-runtime-port.ts";
import type { ApplicationPaneResizePreview } from "./application-terminal-workspace.tsx";
import { prepareCausalCellFixtureV1 } from "./causal-cell-input-fixture.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import { selectTerminalPane, type LivePaneSelectionTarget } from "./select-terminal-pane.ts";
import { TerminalPaneInputRouter } from "./terminal-pane-input-router.ts";

type DiagnosticSink = (phase: string, details?: Readonly<Record<string, unknown>>) => void;

export interface ApplicationTerminalInteractionControllerOptions {
  readonly generation: Accessor<OpenTuiGenerationHostSnapshot | null>;
  readonly layout: Accessor<OpenTuiWorkspaceLayoutSnapshot>;
  readonly setFocusedPane: Setter<string | null>;
  readonly diagnosticsEnabled: boolean;
  readonly diagnose: DiagnosticSink;
  readonly createTraceId?: () => string;
  readonly nowMicros?: () => number;
  readonly causalCellFixtureEnabled?: () => boolean;
}

export interface ApplicationTerminalInteractionController {
  adoptLayout(snapshot: OpenTuiWorkspaceLayoutSnapshot): void;
  selectPane(paneId: string): void;
  sendInput(input: SessionRuntimeTerminalInput): Promise<void>;
  previewPaneResize(preview: ApplicationPaneResizePreview): void;
  resizePane(preview: ApplicationPaneResizePreview): void;
  cycleWindow(): void;
  settleWindowSwitchFrame(): void;
  settleResizeGuideFrame(): void;
}

function paneForWindow(layout: OpenTuiWorkspaceLayout): string | null {
  return (
    layout.panes.find((pane) => pane.active && pane.pane)?.pane ??
    layout.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

/** Owns terminal interaction state; the Solid root only binds its methods. */
export function createApplicationTerminalInteractionController(
  options: ApplicationTerminalInteractionControllerOptions,
): ApplicationTerminalInteractionController {
  const createTraceId = options.createTraceId ?? randomUUID;
  const nowMicros = options.nowMicros ?? (() => Math.floor(performance.now() * 1_000));
  const causalCellFixtureEnabled =
    options.causalCellFixtureEnabled ?? (() => process.env.TMUX_IDE_CAUSAL_CELL_FIXTURE === "1");
  let pendingWindowSwitch: {
    readonly traceId: string;
    readonly target: string;
    readonly startedAtMicros: number;
    layoutPublished: boolean;
  } | null = null;
  let pendingResizeGuide: { readonly traceId: string; readonly startedAtMicros: number } | null =
    null;

  const liveSelectionTarget = (): LivePaneSelectionTarget | null => {
    const active = options.generation();
    if (active?.status !== "live" || !active.client || !active.connection) return null;
    return {
      status: "live",
      workspaceName: active.connection.workspaceName,
      client: active.client,
    };
  };

  const paneInput = new TerminalPaneInputRouter<SessionRuntimeTerminalInput>({
    select: async (paneId) => {
      const expected = liveSelectionTarget();
      const selected = expected
        ? await selectTerminalPane(expected, liveSelectionTarget, paneId)
        : false;
      if (pendingWindowSwitch)
        options.diagnose("window-switch-receipt", {
          traceId: pendingWindowSwitch.traceId,
          target: pendingWindowSwitch.target,
          selected,
          durationMicros: nowMicros() - pendingWindowSwitch.startedAtMicros,
        });
      return selected;
    },
    send: async (paneId, input) => {
      const active = options.generation();
      if (active?.status !== "live" || !active.fastLane) return;
      const trace = currentTuiPerformanceEventSink()?.beginTerminalInput?.();
      const fixture =
        trace && causalCellFixtureEnabled()
          ? prepareCausalCellFixtureV1(active.fastLane.lane.paneState(paneId), input, trace.traceId)
          : null;
      if (fixture) {
        const armed = active.fastLane.causalCellLedger?.arm(fixture.probe, nowMicros());
        if (armed !== true) {
          trace?.cancel();
          return;
        }
      }
      const pending = active.fastLane.lane.sendInput(
        paneId,
        fixture?.input ?? input,
        trace?.traceId,
        fixture?.probe,
      );
      trace?.finish();
      const outcome = await pending;
      if (outcome.status !== "sent") {
        trace?.cancel();
        if (fixture)
          active.fastLane.causalCellLedger?.fail(fixture.probe.traceId, "authority-lost");
      }
    },
    onFocusedPane: options.setFocusedPane,
  });

  return {
    adoptLayout(snapshot) {
      paneInput.adoptCanonicalPane(snapshot.current ? paneForWindow(snapshot.current) : null);
      const currentWindow = snapshot.current?.semanticWindowId ?? snapshot.current?.windowName;
      if (pendingWindowSwitch && currentWindow === pendingWindowSwitch.target)
        pendingWindowSwitch.layoutPublished = true;
    },
    selectPane: (paneId) => paneInput.selectPane(paneId),
    sendInput: async (input) => {
      await paneInput.sendInput(input);
    },
    previewPaneResize() {
      if (!options.diagnosticsEnabled || pendingResizeGuide) return;
      pendingResizeGuide = { traceId: createTraceId(), startedAtMicros: nowMicros() };
    },
    resizePane(preview) {
      const expected = options.generation();
      if (expected?.status !== "live" || !expected.client || !expected.connection) return;
      const expectedGeneration = expected.daemonGeneration;
      const expectedClient = expected.client;
      void (async () => {
        const lease = await expectedClient.requestAuthority("geometry");
        const current = options.generation();
        if (
          !lease ||
          current?.status !== "live" ||
          current.daemonGeneration !== expectedGeneration ||
          current.client !== expectedClient
        )
          return;
        await expectedClient.dispatch({
          kind: "semantic-intent",
          operationId: createTraceId(),
          intent: {
            verb: "workspace.pane.resize",
            workspaceName: expected.connection!.workspaceName,
            semanticPaneId: preview.semanticPaneId,
            axis: preview.axis,
            cells: preview.cells,
          },
        });
      })().catch((error: unknown) => {
        options.diagnose("pane-resize-rejected", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },
    cycleWindow() {
      const windows = options.layout().windows;
      if (windows.length < 2) return;
      const current = windows.findIndex((window) => window.currentWindow);
      const next = windows[(current + 1 + windows.length) % windows.length];
      const pane = next ? paneForWindow(next) : null;
      const target = next?.semanticWindowId ?? next?.windowName;
      if (!pane || !target) return;
      if (options.diagnosticsEnabled) {
        pendingWindowSwitch = {
          traceId: createTraceId(),
          target,
          startedAtMicros: nowMicros(),
          layoutPublished: false,
        };
        options.diagnose("window-switch-start", {
          traceId: pendingWindowSwitch.traceId,
          target,
        });
      }
      paneInput.selectPane(pane);
    },
    settleWindowSwitchFrame() {
      if (!pendingWindowSwitch?.layoutPublished) return;
      const settled = pendingWindowSwitch;
      pendingWindowSwitch = null;
      options.diagnose("window-switch-settled", {
        traceId: settled.traceId,
        target: settled.target,
        durationMicros: nowMicros() - settled.startedAtMicros,
      });
    },
    settleResizeGuideFrame() {
      if (!pendingResizeGuide) return;
      const settled = pendingResizeGuide;
      pendingResizeGuide = null;
      options.diagnose("resize-guide-settled", {
        traceId: settled.traceId,
        durationMicros: nowMicros() - settled.startedAtMicros,
      });
    },
  };
}
