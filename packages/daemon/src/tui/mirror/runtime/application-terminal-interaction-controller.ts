import { randomUUID } from "node:crypto";
import type { Accessor, Setter } from "solid-js";
import type { SessionRuntimeTerminalInput } from "@tmux-ide/contracts";
import {
  currentTuiPerformanceEventSink,
  type TuiTerminalInputOrigin,
  type TuiTerminalInputTrace,
} from "../performance-events.ts";
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
  sendInput(
    input: SessionRuntimeTerminalInput,
    parserOrigin?: Pick<TuiTerminalInputOrigin, "origin" | "payload">,
  ): Promise<void>;
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

  const paneInput = new TerminalPaneInputRouter<{
    readonly input: SessionRuntimeTerminalInput;
    readonly parserOrigin?: Pick<TuiTerminalInputOrigin, "origin" | "payload">;
  }>({
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
    send: async (paneId, routed) => {
      const { input, parserOrigin } = routed;
      const active = options.generation();
      if (active?.status !== "live" || !active.fastLane) return;
      let fixtureEnabled: boolean;
      let canonical: ReturnType<typeof active.fastLane.lane.paneState> = null;
      let trace: TuiTerminalInputTrace | undefined;
      try {
        const performanceSink = currentTuiPerformanceEventSink();
        fixtureEnabled = Boolean(performanceSink?.beginTerminalInput && causalCellFixtureEnabled());
        if (performanceSink?.beginTerminalInput && (parserOrigin || fixtureEnabled))
          canonical = active.fastLane.lane.paneState(paneId);
        trace = performanceSink?.beginTerminalInput?.(
          parserOrigin && canonical && active.daemonGeneration
            ? {
                ...parserOrigin,
                semanticPaneId: paneId,
                generation: active.daemonGeneration,
                incarnation: canonical.incarnation,
                revision: canonical.revision,
                stateHash: canonical.hash,
              }
            : undefined,
        );
      } catch {
        // Diagnostics are opt-in and must never block the product input path.
        fixtureEnabled = false;
        canonical = null;
        trace = undefined;
      }
      let fixture =
        trace && fixtureEnabled
          ? prepareCausalCellFixtureV1(canonical, input, trace.traceId)
          : null;
      if (fixture) {
        let armed: boolean | undefined;
        try {
          armed = active.fastLane.causalCellLedger?.arm(fixture.probe, nowMicros());
        } catch {
          fixture = null;
          armed = true;
        }
        if (armed !== true) {
          try {
            trace?.cancel();
          } catch {
            // Diagnostics fail open while declining this diagnostic probe.
          }
          trace = undefined;
          fixture = null;
        }
      }
      const pending = active.fastLane.lane.sendInput(
        paneId,
        fixture?.input ?? input,
        trace?.traceId,
        fixture?.probe,
      );
      try {
        trace?.finish();
      } catch {
        // The real input has already been dispatched; diagnostics fail open.
      }
      const outcome = await pending;
      if (outcome.status !== "sent") {
        try {
          trace?.cancel();
        } catch {
          // Diagnostics fail open after the product transport outcome.
        }
        if (fixture)
          try {
            active.fastLane.causalCellLedger?.fail(fixture.probe.traceId, "authority-lost");
          } catch {
            // Diagnostics fail open after the product transport outcome.
          }
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
    sendInput: async (input, parserOrigin) => {
      await paneInput.sendInput({ input, parserOrigin });
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
