/* @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { publishTuiInputReady } from "../../readiness.ts";
import { prepareOpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import { registerPaneSurface } from "../pane-surface.tsx";
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { startTuiApplication, observeTuiRootFailure } from "./application-bootstrap.ts";
import { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import {
  loadApplicationConfig,
  parseApplicationArgs,
  type StartApplicationRootOptions,
} from "./application-root-configuration.ts";
import { ApplicationShellView } from "./application-shell-view.tsx";
import {
  createApplicationTerminalInteractionController,
  type ApplicationTerminalInteractionController,
} from "./application-terminal-interaction-controller.ts";
import {
  closeTuiPerfMarks,
  tuiPerfDiagnostics,
  tuiPerfMark,
  tuiPerfStream,
} from "./application-performance-log.ts";
import { createOpenTuiHostLocalTmuxAdapter } from "./host-local-tmux-adapter.ts";
import { createOpenTuiGenerationHost } from "./open-tui-generation-host.ts";
import { createOpenTuiSessionOwner, type OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { terminalInputForOpenTuiKey, terminalInputsForPaste } from "./terminal-input-adapter.ts";
import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";

export type { StartApplicationRootOptions } from "./application-root-configuration.ts";

export async function startApplicationRoot(
  options: StartApplicationRootOptions = {},
): Promise<void> {
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
      hostLocal.configureClipboard();
      const presentation = createOpenTuiRuntimeLayoutPresentation();
      let initialPreparation = options.initialPreparation ?? null;
      let sessionOwner: OpenTuiSessionOwner | null = null;
      let interaction!: ApplicationTerminalInteractionController;
      const terminalHostFocus = new OpenTuiTerminalHostFocus(true);

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
        > | null>(null);
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
            setGeneration(snapshot);
            terminalHostFocus.adopt(snapshot?.client ?? null);
            if (snapshot) {
              tuiPerfMark("generation-status", {
                status: snapshot.status,
                daemonGeneration: snapshot.daemonGeneration,
              });
            }
          },
        });
        const [layoutSnapshot, setLayoutSnapshot] = createSignal(presentation.getWindowSnapshot());
        const [focusedPane, setFocusedPane] = createSignal<string | null>(null);
        const [selectedSession, setSelectedSession] = createSignal(0);
        const [bootstrapNote, setBootstrapNote] = createSignal<string | null>(null);
        const viewport = createMemo(() => ({
          width: Math.max(1, dimensions().width),
          height: Math.max(2, dimensions().height - 2),
        }));
        const terminalRendererSource = createMemo(() => {
          const active = generation();
          return active?.status === "live" && active.adapter
            ? Object.freeze({ adapter: active.adapter, rendererEpoch: active.rendererEpoch })
            : null;
        });

        interaction = createApplicationTerminalInteractionController({
          generation,
          layout: layoutSnapshot,
          setFocusedPane,
          diagnosticsEnabled: Boolean(tuiPerfStream),
          diagnose: tuiPerfMark,
        });
        const stopLayout = presentation.subscribeWindows((snapshot) => {
          setLayoutSnapshot(snapshot);
          tuiPerfMark("layout-publication", {
            windows: snapshot.windows.length,
            panes: snapshot.current?.panes.length ?? 0,
          });
          interaction.adoptLayout(snapshot);
        });
        const startGeneration = async (
          sessionName: string,
          workspacePrepared = false,
        ): Promise<void> => {
          setBootstrapNote(`opening ${sessionName}`);
          const started = await sessionOwner!.open(sessionName, workspacePrepared);
          const snapshot = sessionOwner!.snapshot();
          if (started && snapshot) {
            setSurface("terminals");
            setBootstrapNote(null);
          } else {
            setBootstrapNote(`${sessionName} could not attach`);
          }
        };
        onCleanup(() => {
          stopLayout();
        });

        createEffect(() => {
          renderer.setBackgroundColor(theme.roles.surfaces.canvas);
          const size = viewport();
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (lane) void lane.lane.resize({ cols: size.width, rows: size.height });
        });

        useKeyboard((event) => {
          const name = event.name.toLowerCase();
          if (event.ctrl && name === "q") {
            void hostLocal.putAway().finally(() => lifecycle.shutdown("keyboard"));
            return;
          }
          if (name === "f1") {
            setSurface("home");
            return;
          }
          if (name === "f2") {
            setSurface("terminals");
            return;
          }
          if (surface() === "home" && config.sessions.length > 0) {
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
          if (event.ctrl && name === "t") {
            interaction.cycleWindow();
            return;
          }
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (surface() !== "terminals" || !lane || !focusedPane()) return;
          const input = terminalInputForOpenTuiKey(event);
          if (input) void interaction.sendInput(input);
        });
        usePaste((event) => {
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (surface() !== "terminals" || !lane || !focusedPane()) return;
          const text = Buffer.from(event.bytes).toString("utf8");
          for (const input of terminalInputsForPaste(text)) {
            void interaction.sendInput(input);
          }
        });
        onMount(() => {
          tuiPerfMark("solid-mounted");
          if (config.target) void startGeneration(config.target);
          resolveReady();
        });

        return (
          <ApplicationShellView
            dimensions={dimensions}
            surface={surface}
            workspaceName={() => generation()?.connection?.workspaceName ?? "no active workspace"}
            generationStatus={() => generation()?.status ?? "unavailable"}
            sessions={config.sessions}
            selectedSession={selectedSession}
            bootstrapNote={bootstrapNote}
            terminalRendererSource={terminalRendererSource}
            layout={layoutSnapshot}
            viewport={viewport}
            focusedPane={focusedPane}
            theme={theme}
            palette={palette}
            onSelectPane={interaction.selectPane}
            onResizePreview={interaction.previewPaneResize}
            onResizePane={interaction.resizePane}
          />
        );
      }, renderer);

      observeTuiRootFailure(root, {
        rejectReadiness: rejectReady,
        shutdown: () => lifecycle.shutdown("bootstrap-error"),
      });
      const paintedTerminalGenerations = new Set<string>();
      const observeTerminalFrame = () => {
        const snapshot = sessionOwner?.snapshot();
        if (
          !snapshot ||
          snapshot.status !== "live" ||
          !snapshot.daemonGeneration ||
          !snapshot.adapter?.hasPaintedCanonicalSnapshot()
        )
          return;
        const paintKey = `${snapshot.daemonGeneration}:${snapshot.rendererEpoch}`;
        if (paintedTerminalGenerations.has(paintKey)) return;
        paintedTerminalGenerations.add(paintKey);
        tuiPerfMark("first-terminal-frame", {
          daemonGeneration: snapshot.daemonGeneration,
          rendererEpoch: snapshot.rendererEpoch,
        });
      };
      renderer.on("frame", observeTerminalFrame);
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
            diagnosticFrameSink.frame(now - previousObservedFrameAt);
            previousObservedFrameAt = now;
          }
        : null;
      if (observeDiagnosticFrame) renderer.on("frame", observeDiagnosticFrame);
      const observeWindowSwitchFrame = () => {
        interaction.settleWindowSwitchFrame();
      };
      if (tuiPerfStream) renderer.on("frame", observeWindowSwitchFrame);
      const observeResizeGuideFrame = () => {
        interaction.settleResizeGuideFrame();
      };
      if (tuiPerfStream) renderer.on("frame", observeResizeGuideFrame);
      const foregroundTerminalHost = () => terminalHostFocus.focus();
      const backgroundTerminalHost = () => terminalHostFocus.blur();
      renderer.on("focus", foregroundTerminalHost);
      renderer.on("blur", backgroundTerminalHost);
      return {
        root,
        ready,
        close: async () => {
          tuiPerfMark("resource-snapshot", {
            boundary: "pre-close",
            resources: runtimeResourceSnapshot(),
          });
          renderer.off("frame", observeTerminalFrame);
          if (tuiPerfStream) renderer.off("frame", observeFirstFrame);
          if (observeDiagnosticFrame) renderer.off("frame", observeDiagnosticFrame);
          if (tuiPerfStream) renderer.off("frame", observeWindowSwitchFrame);
          if (tuiPerfStream) renderer.off("frame", observeResizeGuideFrame);
          renderer.off("focus", foregroundTerminalHost);
          renderer.off("blur", backgroundTerminalHost);
          terminalHostFocus.dispose();
          await sessionOwner?.dispose();
          presentation.dispose();
          tuiPerfMark("resource-snapshot", {
            boundary: "post-close",
            resources: runtimeResourceSnapshot(),
            diagnostics: tuiPerfDiagnostics(),
          });
          if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG) {
            const { closeReferencePerformanceTraceCollector } =
              await import("../reference-performance-trace.ts");
            await closeReferencePerformanceTraceCollector();
          }
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
