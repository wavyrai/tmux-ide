/* @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core";
import type { CommandSource } from "@tmux-ide/contracts";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { publishTuiInputReady } from "../../readiness.ts";
import { prepareOpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import {
  createPaneSurfaceHostFocusTransitionOwner,
  registerPaneSurface,
} from "../pane-surface.tsx";
import { currentTuiPerformanceEventSink, detailedWindowFrame } from "../performance-events.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { startTuiApplication, observeTuiRootFailure } from "./application-bootstrap.ts";
import {
  applicationShellBindingRenderSignature,
  createApplicationShellBinding,
} from "./application-shell-binding.ts";
import { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import {
  loadApplicationConfig,
  parseApplicationArgs,
  type StartApplicationRootOptions,
} from "./application-root-configuration.ts";
import { ApplicationShellView, applicationShellKeyAction } from "./application-shell-view.tsx";
import {
  createApplicationTerminalInteractionController,
  type ApplicationTerminalInteractionController,
} from "./application-terminal-interaction-controller.ts";
import {
  createApplicationHostFocusPresentation,
  type HostFocusRendererSource,
} from "./application-host-focus-presentation.ts";
import {
  closeTuiPerfMarks,
  tuiPerfCriticalMark,
  tuiPerfDiagnostics,
  tuiPerfMark,
  tuiPerfStream,
} from "./application-performance-log.ts";
import { createOpenTuiHostLocalTmuxAdapter } from "./host-local-tmux-adapter.ts";
import {
  createOpenTuiGenerationHost,
  openTuiGenerationRenderEqual,
} from "./open-tui-generation-host.ts";
import { createOpenTuiSessionOwner, type OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";
import { createApplicationTerminalFrameReadinessOwner } from "./application-terminal-frame-readiness-owner.ts";
import {
  applicationMousePointerIngressCapability,
  createApplicationTerminalSelectionOwner,
  applicationClipboardReadiness,
  routeApplicationTerminalPointerInput,
} from "./application-terminal-selection-owner.ts";
import { createApplicationTerminalRendererSources } from "./application-terminal-renderer-sources.ts";
import { createSemanticShellViewportResizeOwner } from "./semantic-shell-viewport-resize.ts";
import {
  sendApplicationTerminalKey,
  sendApplicationTerminalPaste,
} from "./application-terminal-paste.ts";
export type { StartApplicationRootOptions } from "./application-root-configuration.ts";
export async function startApplicationRoot(options: StartApplicationRootOptions = {}) {
  options.initialPreparation?.diagnosticHandoff?.attach(tuiPerfMark);
  let renderer!: Awaited<ReturnType<typeof createCliRenderer>>;
  let lifecycle!: TuiApplicationLifecycle;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  await startTuiApplication({
    argv: process.argv.slice(2),
    parseArgs: parseApplicationArgs,
    loadConfig: loadApplicationConfig,
    async createRenderer({ config }) {
      tuiPerfMark("renderer-create-start");
      renderer = await createCliRenderer({
        exitOnCtrlC: false,
        autoFocus: false,
        ...TUI_RENDERER_CADENCE,
        useKittyKeyboard: config.app.app.kittyKeys ? {} : null,
        consoleMode: process.env.TMUX_IDE_MIRROR_DEBUG ? "console-overlay" : "disabled",
        openConsoleOnError: Boolean(process.env.TMUX_IDE_MIRROR_DEBUG),
      });
      tuiPerfMark("renderer-create-end");
      return renderer;
    },
    createLifecycle() {
      lifecycle = new TuiApplicationLifecycle({ destroyRenderer: () => renderer.destroy() });
      return lifecycle;
    },
    mountRoot({ config }) {
      const hostLocal = createOpenTuiHostLocalTmuxAdapter();
      const clipboardReady = applicationClipboardReadiness(
        hostLocal.configureClipboard,
        Boolean(process.env.TMUX),
      );
      const presentation = createOpenTuiRuntimeLayoutPresentation();
      let initialPreparation = options.initialPreparation ?? null;
      let sessionOwner: OpenTuiSessionOwner | null = null;
      const frameDiagnosticSink = currentTuiPerformanceEventSink();
      const hostFocusTransitionOwner =
        frameDiagnosticSink?.terminalFocusPaint && frameDiagnosticSink.terminalFocusFence
          ? createPaneSurfaceHostFocusTransitionOwner(() => renderer.requestRender())
          : null;
      const terminalFrameReadiness = createApplicationTerminalFrameReadinessOwner({
        enabled: tuiPerfStream,
        sink: frameDiagnosticSink,
        requestRender: () => renderer.requestRender(),
      });
      let interaction!: ApplicationTerminalInteractionController;
      let setRendererFocused: ((focused: boolean) => void) | null = null;
      let getRendererFocused: (() => boolean) | null = null;
      let getFocusedPane: (() => string | null) | null = null;
      let observedFocusGenerationKey: string | null = null;
      let getTerminalRendererSource: (() => HostFocusRendererSource | null) | null = null;
      const terminalHostFocus = new OpenTuiTerminalHostFocus(
        true,
        tuiPerfStream
          ? (phase, details) => {
              const rendererEpoch = sessionOwner?.snapshot()?.rendererEpoch ?? null;
              const enriched = { ...details, rendererEpoch };
              const epoch = details.diagnosticEpoch;
              const key = `terminal-host-focus:${String(epoch)}:${String(details.outcomeId ?? "")}:${phase}`;
              tuiPerfCriticalMark(key, `terminal-host-${phase}`, enriched);
              if (phase === "focus-authority-settled" || phase === "blur-authority-settled") {
                const health = tuiPerfDiagnostics();
                tuiPerfCriticalMark(`${key}:fence`, "terminal-host-focus-fence", {
                  diagnosticEpoch: epoch,
                  rendererEpoch,
                  daemonGeneration: details.daemonInstanceId,
                  workspaceName: details.workspaceName,
                  clientGeneration: details.clientGeneration,
                  settledPhase: phase,
                  writerHealth: health,
                });
              }
            }
          : null,
      );
      const root = render(() => {
        tuiPerfMark("solid-root-evaluate");
        registerPaneSurface();
        const dimensions = useTerminalDimensions();
        const theme = createSemanticThemeSnapshot(config.app.theme, renderer.themeMode);
        const palette = createTerminalPaletteProjection(theme);
        const [surface, setSurface] = createSignal<"home" | "terminals">(
          config.target ? "terminals" : "home",
        );
        const [generation, setGeneration] = createSignal<ReturnType<
          ReturnType<typeof createOpenTuiGenerationHost>["getSnapshot"]
        > | null>(null, { equals: openTuiGenerationRenderEqual });
        const shellBinding = createApplicationShellBinding({ onDiagnostic: tuiPerfMark });
        const [shell, setShell] = createSignal(shellBinding.getSnapshot());
        const stopShell = shellBinding.subscribe(setShell);
        sessionOwner = createOpenTuiSessionOwner({
          prepareConnection: (sessionName) => {
            if (initialPreparation?.sessionName !== sessionName)
              return tuiPerfStream
                ? prepareOpenTuiApplicationShellConnection(sessionName, {
                    onDiagnostic: tuiPerfMark,
                  })
                : prepareOpenTuiApplicationShellConnection(sessionName);
            const prepared = initialPreparation.preparedConnection;
            initialPreparation = null;
            return prepared;
          },
          createHost: (sessionName, initialConnection) =>
            createOpenTuiGenerationHost(sessionName, presentation, {
              initialConnection,
              ...(tuiPerfStream
                ? {
                    onDiagnostic: (phase, details) => tuiPerfMark(`generation-${phase}`, details),
                  }
                : {}),
            }),
          onSnapshot: (snapshot) => {
            let clientGeneration: number | null = null;
            try {
              const value = snapshot?.client?.getSnapshot().generation;
              clientGeneration = Number.isSafeInteger(value) ? value! : null;
            } catch {
              clientGeneration = null;
            }
            const focusGenerationKey =
              snapshot?.status === "live" && snapshot.daemonGeneration && clientGeneration !== null
                ? `${snapshot.daemonGeneration}:${clientGeneration}:${snapshot.rendererEpoch}`
                : null;
            if (
              observedFocusGenerationKey !== null &&
              focusGenerationKey !== observedFocusGenerationKey
            )
              hostFocusTransitionOwner?.cancel();
            observedFocusGenerationKey = focusGenerationKey;
            terminalFrameReadiness?.adopt(snapshot);
            interaction?.adoptGeneration(snapshot);
            setGeneration(snapshot);
            shellBinding.adoptGeneration(snapshot);
            terminalHostFocus.adopt(snapshot?.status === "live" ? snapshot.authorityClient : null);
            if (snapshot)
              tuiPerfMark("generation-status", {
                status: snapshot.status,
                daemonGeneration: snapshot.daemonGeneration,
              });
          },
        });
        const [layoutSnapshot, setLayoutSnapshot] = createSignal(presentation.getWindowSnapshot());
        const [focusedPane, setFocusedPane] = createSignal<string | null>(null);
        const selectionOwner = createApplicationTerminalSelectionOwner({
          copyText: hostLocal.copyText,
          diagnosticsEnabled: tuiPerfStream,
          generation,
        });
        getFocusedPane = focusedPane;
        const [rendererFocused, setRendererFocusedSignal] = createSignal(true);
        getRendererFocused = rendererFocused;
        setRendererFocused = setRendererFocusedSignal;
        const [selectedSession, setSelectedSession] = createSignal(0);
        const [bootstrapNote, setBootstrapNote] = createSignal<string | null>(null);
        const semanticViewportResize = createSemanticShellViewportResizeOwner();
        const activeSurface = createMemo<"home" | "terminals">(
          () => shell().semantic?.workspaceCanvas.activeMode ?? surface(),
        );
        const { terminalRendererSource, terminalGestureRuntime, focusRendererSource } =
          createApplicationTerminalRendererSources(generation);
        getTerminalRendererSource = focusRendererSource;
        interaction = createApplicationTerminalInteractionController({
          generation,
          layout: layoutSnapshot,
          focusedPane,
          rendererFocused,
          shellPresentation: () => applicationShellBindingRenderSignature(shell()),
          setFocusedPane,
          diagnosticsEnabled: Boolean(tuiPerfStream),
          detailedWindowSwitchTiming:
            currentTuiPerformanceEventSink()?.detailedWindowPresentationFrames === true,
          diagnose: tuiPerfMark,
          diagnoseCritical: tuiPerfCriticalMark,
          diagnosticHealth: tuiPerfDiagnostics,
          requestRender: () => renderer.requestRender(),
        });
        interaction.adoptGeneration(sessionOwner?.snapshot() ?? null);
        const stopLayout = presentation.subscribeWindows((snapshot) => {
          batch(() => {
            interaction.adoptLayout(snapshot);
            setLayoutSnapshot(snapshot);
          });
          tuiPerfMark("layout-publication", {
            windows: snapshot.windows.length,
            panes: snapshot.current?.panes.length ?? 0,
          });
        });
        const startGeneration = async (
          sessionName: string,
          workspacePrepared = false,
          source: "keyboard" | "mouse" = "keyboard",
        ): Promise<void> => {
          setBootstrapNote(`opening ${sessionName}`);
          const result = await shellBinding.openSession(
            sessionName,
            commandSource(source, "application-bar"),
            (name) => sessionOwner!.open(name, workspacePrepared),
          );
          const snapshot = sessionOwner!.snapshot();
          if (result.opened && snapshot) {
            if (!result.activated) setSurface("terminals");
            setBootstrapNote(null);
          } else {
            setBootstrapNote(`${sessionName} could not attach`);
          }
        };
        onCleanup(() => {
          semanticViewportResize.dispose();
          stopLayout();
          stopShell();
          shellBinding.dispose();
        });
        const commandSource = (
          source: "keyboard" | "mouse",
          surfaceName: "application-bar" | "command-palette",
        ): CommandSource => ({ kind: source, surface: surfaceName });
        const openSurface = (next: "home" | "terminals", source: "keyboard" | "mouse"): void => {
          void shellBinding
            .openSurface(next, commandSource(source, "application-bar"))
            .then((dispatched) => {
              if (!dispatched) setSurface(next);
            });
        };
        const setCommandPaletteOpen = (open: boolean, source: "keyboard" | "mouse"): void => {
          void shellBinding.setPaletteOpen(open, commandSource(source, "command-palette"));
        };
        createEffect(() => {
          renderer.setBackgroundColor(theme.roles.surfaces.canvas);
          const currentShell = shell();
          semanticViewportResize.adopt(dimensions(), currentShell.semantic, generation());
        });
        useKeyboard((event) => {
          const name = event.name.toLowerCase();
          if (selectionOwner.handleKey(name)) return;
          if (event.ctrl && name === "q") {
            void hostLocal.putAway().finally(() => lifecycle.shutdown("keyboard"));
            return;
          }
          const chromeAction = applicationShellKeyAction(
            event,
            Boolean(shell().semantic?.focus.palette.open || shell().localPaletteOpen),
          );
          if (chromeAction) {
            if (chromeAction === "home" || chromeAction === "terminals")
              openSurface(chromeAction, "keyboard");
            else setCommandPaletteOpen(chromeAction === "palette-open", "keyboard");
            return;
          }
          if (activeSurface() === "home" && config.sessions.length > 0) {
            if (name === "up") {
              setSelectedSession(
                (index) => (index - 1 + config.sessions.length) % config.sessions.length,
              );
              return;
            }
            if (name === "down") {
              setSelectedSession((index) => (index + 1) % config.sessions.length);
              return;
            }
            if (name === "return" || name === "enter") {
              const sessionName = config.sessions[selectedSession()];
              if (sessionName) void startGeneration(sessionName);
              return;
            }
          }
          if (activeSurface() === "terminals" && interaction.routeWorkspaceKey(event)) return;
          if (
            activeSurface() === "terminals" &&
            event.ctrl &&
            event.name.toLowerCase() === "c" &&
            selectionOwner.copyCurrent()
          )
            return;
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (activeSurface() !== "terminals" || !lane || !focusedPane()) return;
          sendApplicationTerminalKey(
            interaction,
            event,
            Boolean(currentTuiPerformanceEventSink()?.terminalInputOrigin),
          );
        });
        usePaste((event) => {
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (activeSurface() !== "terminals" || !lane || !focusedPane()) return;
          sendApplicationTerminalPaste(
            interaction,
            event.bytes,
            Boolean(currentTuiPerformanceEventSink()?.terminalInputOrigin),
          );
        });
        onMount(() => {
          tuiPerfMark("solid-mounted");
          if (config.target) void startGeneration(config.target);
          void clipboardReady.then(resolveReady, rejectReady);
        });
        const resizeIngress = tuiPerfStream ? interaction.beginResizePointerIngress : undefined;
        const applicationMouseIngress = applicationMousePointerIngressCapability(
          tuiPerfStream,
          selectionOwner.beginPointerIngress,
        );
        return (
          <ApplicationShellView
            dimensions={dimensions}
            surface={activeSurface}
            semantic={() => shell().semantic}
            generationStatus={() => shell().status}
            sessions={config.sessions}
            selectedSession={selectedSession}
            bootstrapNote={bootstrapNote}
            paletteOpen={() => shell().semantic?.focus.palette.open ?? shell().localPaletteOpen}
            terminalRendererSource={terminalRendererSource}
            terminalGestureRuntime={terminalGestureRuntime}
            onApplicationMousePointerIngress={applicationMouseIngress}
            layout={layoutSnapshot}
            focusedPane={() => (rendererFocused() ? focusedPane() : null)}
            rendererFocused={rendererFocused}
            hostFocusTransitionOwner={hostFocusTransitionOwner ?? undefined}
            theme={theme}
            palette={palette}
            onOpenSurface={openSurface}
            onOpenSession={(sessionName) => void startGeneration(sessionName, false, "mouse")}
            onSetPaletteOpen={setCommandPaletteOpen}
            onSelectPane={interaction.selectPane}
            onResizePreview={interaction.previewPaneResize}
            onResizePane={interaction.resizePane}
            onResizePointerIngress={resizeIngress}
            onTerminalInput={(paneId, input) =>
              routeApplicationTerminalPointerInput(interaction, paneId, input)
            }
            onCopyText={selectionOwner.copy}
            onSelectionCopyOwner={selectionOwner.registerCopy}
            onSelectionKeyOwner={selectionOwner.registerKey}
            onWindowPresented={tuiPerfStream ? interaction.observeWindowPresentation : undefined}
          />
        );
      }, renderer);
      observeTuiRootFailure(root, {
        rejectReadiness: rejectReady,
        shutdown: () => lifecycle.shutdown("bootstrap-error"),
      });
      const observeTerminalFrame = () => terminalFrameReadiness?.observeFrame();
      if (terminalFrameReadiness) renderer.on("frame", observeTerminalFrame);
      let firstFrameMarked = false;
      const observeFirstFrame = () => {
        if (firstFrameMarked) return;
        firstFrameMarked = true;
        tuiPerfMark("first-frame");
      };
      if (tuiPerfStream) renderer.on("frame", observeFirstFrame);
      const diagnosticFrameSink = currentTuiPerformanceEventSink();
      let previousObservedFrameAt = diagnosticFrameSink ? performance.now() : 0;
      const observeDiagnosticFrame = diagnosticFrameSink
        ? () => {
            const now = performance.now();
            diagnosticFrameSink.frame(
              now - previousObservedFrameAt,
              detailedWindowFrame(diagnosticFrameSink, interaction.observeDiagnosticWindowFrame),
            );
            previousObservedFrameAt = now;
          }
        : null;
      if (observeDiagnosticFrame) renderer.on("frame", observeDiagnosticFrame);
      const observeWindowSwitchFrame = () => interaction.settleWindowSwitchFrame();
      if (tuiPerfStream) renderer.on("frame", observeWindowSwitchFrame);
      const observeResizeGuideFrame = () => interaction.settleResizeGuideFrame();
      if (tuiPerfStream) renderer.on("frame", observeResizeGuideFrame);
      const hostFocusPresentation = createApplicationHostFocusPresentation({
        renderer,
        owner: hostFocusTransitionOwner,
        sink: frameDiagnosticSink,
        hostFocus: terminalHostFocus,
        focusedPane: () => getFocusedPane?.() ?? null,
        rendererFocused: () => getRendererFocused?.() ?? true,
        setRendererFocused: (focused) => setRendererFocused?.(focused),
        rendererSource: () => getTerminalRendererSource?.() ?? null,
      });
      return {
        root,
        ready,
        close: async () => {
          hostFocusPresentation.dispose();
          hostFocusTransitionOwner?.dispose();
          tuiPerfMark("resource-snapshot", {
            boundary: "pre-close",
            resources: runtimeResourceSnapshot(),
          });
          if (terminalFrameReadiness) renderer.off("frame", observeTerminalFrame);
          terminalFrameReadiness?.dispose();
          if (tuiPerfStream) renderer.off("frame", observeFirstFrame);
          if (observeDiagnosticFrame) renderer.off("frame", observeDiagnosticFrame);
          if (tuiPerfStream) renderer.off("frame", observeWindowSwitchFrame);
          if (tuiPerfStream) renderer.off("frame", observeResizeGuideFrame);
          terminalHostFocus.dispose();
          await sessionOwner?.dispose();
          presentation.dispose();
          tuiPerfMark("resource-snapshot", {
            boundary: "post-close",
            resources: runtimeResourceSnapshot(),
            diagnostics: tuiPerfDiagnostics(),
          });
          if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG)
            await (
              await import("../reference-performance-trace.ts")
            ).closeReferencePerformanceTraceCollector();
          options.initialPreparation?.diagnosticHandoff?.retire();
          await closeTuiPerfMarks();
        },
      };
    },
    publishReady() {
      publishTuiInputReady("app");
    },
  });
}
