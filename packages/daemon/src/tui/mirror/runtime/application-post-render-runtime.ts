import type { createCliRenderer } from "@opentui/core";

import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import { createPaneSurfaceHostFocusTransitionOwner } from "../pane-surface.tsx";
import { currentTuiPerformanceEventSink, detailedWindowFrame } from "../performance-events.ts";
import {
  closeTuiPerfMarks,
  tuiPerfDiagnostics,
  tuiPerfMark,
  tuiPerfStream,
} from "./application-performance-log.ts";
import { observeTuiRootFailure } from "./application-bootstrap.ts";
import { createApplicationHostFocusPresentation } from "./application-host-focus-presentation.ts";
import type { resolveApplicationHostFocusControlCapability } from "./application-host-focus-control-capability.ts";
import type { createApplicationHostFocusControlBindingObserver } from "./application-host-focus-control-binding.ts";
import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import type { createApplicationTerminalFrameReadinessOwner } from "./application-terminal-frame-readiness-owner.ts";
import type { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import type { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";
import type { HostFocusRendererSource } from "./application-host-focus-presentation.ts";

type Renderer = Awaited<ReturnType<typeof createCliRenderer>>;

export function installApplicationPostRenderRuntime(options: {
  readonly renderer: Renderer;
  readonly root: Parameters<typeof observeTuiRootFailure>[0];
  readonly rejectReady: (error: unknown) => void;
  readonly shutdown: () => Promise<void>;
  readonly terminalFrameReadiness: ReturnType<
    typeof createApplicationTerminalFrameReadinessOwner
  > | null;
  readonly interaction: ApplicationTerminalInteractionController;
  readonly hostFocusTransitionOwner: ReturnType<
    typeof createPaneSurfaceHostFocusTransitionOwner
  > | null;
  readonly frameDiagnosticSink: ReturnType<typeof currentTuiPerformanceEventSink>;
  readonly terminalHostFocus: OpenTuiTerminalHostFocus;
  readonly focusedPane: () => string | null;
  readonly rendererFocused: () => boolean;
  readonly setRendererFocused: (focused: boolean) => void;
  readonly rendererSource: () => HostFocusRendererSource | null;
  readonly hostFocusControlCapability: ReturnType<
    typeof resolveApplicationHostFocusControlCapability
  >;
  readonly hostFocusBindingObserver: ReturnType<
    typeof createApplicationHostFocusControlBindingObserver
  >;
  readonly sessionOwner: () => OpenTuiSessionOwner | null;
  readonly presentation: ReturnType<typeof createOpenTuiRuntimeLayoutPresentation>;
  readonly retireDiagnosticHandoff: () => void;
}): { readonly close: () => Promise<void> } {
  observeTuiRootFailure(options.root, {
    rejectReadiness: options.rejectReady,
    shutdown: options.shutdown,
  });
  const observeTerminalFrame = () => options.terminalFrameReadiness?.observeFrame();
  if (options.terminalFrameReadiness) options.renderer.on("frame", observeTerminalFrame);
  let firstFrameMarked = false;
  const observeFirstFrame = () => {
    if (firstFrameMarked) return;
    firstFrameMarked = true;
    tuiPerfMark("first-frame");
  };
  if (tuiPerfStream) options.renderer.on("frame", observeFirstFrame);
  const diagnosticFrameSink = currentTuiPerformanceEventSink();
  let previousObservedFrameAt = diagnosticFrameSink ? performance.now() : 0;
  const observeDiagnosticFrame = diagnosticFrameSink
    ? () => {
        const now = performance.now();
        diagnosticFrameSink.frame(
          now - previousObservedFrameAt,
          detailedWindowFrame(
            diagnosticFrameSink,
            options.interaction.observeDiagnosticWindowFrame,
          ),
        );
        previousObservedFrameAt = now;
      }
    : null;
  if (observeDiagnosticFrame) options.renderer.on("frame", observeDiagnosticFrame);
  const observeWindowSwitchFrame = () => options.interaction.settleWindowSwitchFrame();
  const observeResizeGuideFrame = () => options.interaction.settleResizeGuideFrame();
  if (tuiPerfStream) {
    options.renderer.on("frame", observeWindowSwitchFrame);
    options.renderer.on("frame", observeResizeGuideFrame);
  }
  const hostFocusPresentation = createApplicationHostFocusPresentation({
    renderer: options.renderer,
    owner: options.hostFocusTransitionOwner,
    sink: options.frameDiagnosticSink,
    hostFocus: options.terminalHostFocus,
    focusedPane: options.focusedPane,
    rendererFocused: options.rendererFocused,
    setRendererFocused: options.setRendererFocused,
    rendererSource: options.rendererSource,
  });
  const hostFocusControl = options.hostFocusControlCapability.enabled
    ? import("./application-host-focus-test-control.ts").then(async (module) => {
        const control = module.createApplicationHostFocusTestControl({
          path: options.hostFocusControlCapability.path!,
          runtimeRoot: options.hostFocusControlCapability.runtimeRoot!,
          key: options.hostFocusControlCapability.key!,
          driveFocusState: hostFocusPresentation.driveFocusState,
          currentBinding: () => {
            const observed = options.hostFocusBindingObserver.current();
            const pane = options.focusedPane();
            if (!observed || !pane || !Number.isSafeInteger(observed.clientGeneration)) return null;
            return Object.freeze({
              generation: observed.authorityGeneration,
              runtimeSession: observed.runtimeSession,
              workspaceName: observed.workspaceName,
              semanticPaneId: pane,
              clientId: observed.clientId,
              rendererEpoch: observed.rendererEpoch,
              clientGeneration: observed.clientGeneration,
              bindingEpoch: observed.bindingEpoch,
              processId: `opentui:${process.pid}`,
              rendererFocused: options.rendererFocused(),
            });
          },
        });
        await control.ready;
        return control;
      })
    : null;
  void hostFocusControl?.catch(() => undefined);
  return {
    close: async () => {
      if (hostFocusControl) await (await hostFocusControl).close();
      options.hostFocusBindingObserver.dispose();
      hostFocusPresentation.dispose();
      options.hostFocusTransitionOwner?.dispose();
      tuiPerfMark("resource-snapshot", {
        boundary: "pre-close",
        resources: runtimeResourceSnapshot(),
      });
      if (options.terminalFrameReadiness) options.renderer.off("frame", observeTerminalFrame);
      options.terminalFrameReadiness?.dispose();
      if (tuiPerfStream) {
        options.renderer.off("frame", observeFirstFrame);
        options.renderer.off("frame", observeWindowSwitchFrame);
        options.renderer.off("frame", observeResizeGuideFrame);
      }
      if (observeDiagnosticFrame) options.renderer.off("frame", observeDiagnosticFrame);
      options.terminalHostFocus.dispose();
      await options.sessionOwner()?.dispose();
      options.presentation.dispose();
      tuiPerfMark("resource-snapshot", {
        boundary: "post-close",
        resources: runtimeResourceSnapshot(),
        diagnostics: tuiPerfDiagnostics(),
      });
      if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG)
        await (
          await import("../reference-performance-trace.ts")
        ).closeReferencePerformanceTraceCollector();
      options.retireDiagnosticHandoff();
      await closeTuiPerfMarks();
    },
  };
}
