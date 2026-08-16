/* @jsxImportSource @opentui/solid */
import { parseArgs } from "node:util";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { createCliRenderer } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { loadAppConfig, type AppConfig } from "../../../lib/app-config.ts";
import { publishTuiInputReady } from "../../readiness.ts";
import {
  discoverOpenTuiLiveSessions,
  ensureOpenTuiSessionWorkspace,
} from "../configless-session-bootstrap.ts";
import { registerPaneSurface } from "../pane-surface.tsx";
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import {
  OPEN_TUI_HOST_CLIENT_ID,
  type OpenTuiWorkspaceLayout,
} from "../open-tui-workspace-runtime-port.ts";
import { startTuiApplication, observeTuiRootFailure } from "./application-bootstrap.ts";
import { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import {
  ApplicationTerminalWorkspace,
  type ApplicationPaneResizePreview,
} from "./application-terminal-workspace.tsx";
import { createOpenTuiHostLocalTmuxAdapter } from "./host-local-tmux-adapter.ts";
import { createOpenTuiGenerationHost } from "./open-tui-generation-host.ts";
import { createOpenTuiSessionOwner, type OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { terminalInputForOpenTuiKey, terminalInputsForPaste } from "./terminal-input-adapter.ts";
import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";
import { selectTerminalPane, type LivePaneSelectionTarget } from "./select-terminal-pane.ts";
import { TerminalPaneInputRouter } from "./terminal-pane-input-router.ts";

interface ApplicationArgs {
  readonly target: string | null;
}

interface ApplicationConfig {
  readonly app: AppConfig;
  readonly target: string | null;
  readonly sessions: readonly string[];
}

const parseApplicationArgs = (argv: readonly string[]): ApplicationArgs => {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: { target: { type: "string" } },
  });
  const positional = parsed.positionals.find((value) => value !== "app") ?? null;
  const target = typeof parsed.values.target === "string" ? parsed.values.target : positional;
  return Object.freeze({ target: target && target !== "home" ? target : null });
};

async function loadApplicationConfig(args: ApplicationArgs): Promise<ApplicationConfig> {
  tuiPerfMark("config-load-start", { requestedTarget: args.target });
  tuiPerfMark("session-discovery-start");
  const sessions = await discoverOpenTuiLiveSessions().catch(() => Object.freeze([]));
  tuiPerfMark("session-discovery-end", { sessions: sessions.length });
  const candidate = args.target ?? (sessions.length === 1 ? sessions[0]! : null);
  // Availability/promotion is generation work, not renderer bootstrap work.
  // Mount chrome first, then let startGeneration perform the single guarded
  // ensure before it creates the generation-bound client.
  tuiPerfMark("config-load-end", { target: candidate, sessions: sessions.length });
  return Object.freeze({
    app: loadAppConfig(),
    target: candidate,
    sessions,
  });
}

const TUI_PERF_LOG = process.env.TMUX_IDE_TUI_PERF_LOG;
const tuiPerfStream = TUI_PERF_LOG
  ? createWriteStream(TUI_PERF_LOG, { flags: "a", highWaterMark: 64 * 1_024 })
  : null;
const TUI_LAUNCH_EPOCH_MS = tuiPerfStream
  ? Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now())
  : 0;
let tuiPerfStreamFailed = false;
let tuiPerfStreamSaturated = false;
let tuiPerfDroppedRecords = 0;
const failTuiPerfStream = () => {
  tuiPerfStreamFailed = true;
};
const drainTuiPerfStream = () => {
  tuiPerfStreamSaturated = false;
};
tuiPerfStream?.on("error", failTuiPerfStream);
tuiPerfStream?.on("drain", drainTuiPerfStream);
function tuiPerfMark(phase: string, details?: Readonly<Record<string, unknown>>): void {
  if (!tuiPerfStream || tuiPerfStreamFailed) return;
  if (tuiPerfStreamSaturated) {
    tuiPerfDroppedRecords += 1;
    return;
  }
  try {
    tuiPerfStreamSaturated = !tuiPerfStream.write(
      `${JSON.stringify({
        phase,
        elapsedMs: Date.now() - TUI_LAUNCH_EPOCH_MS,
        at: new Date().toISOString(),
        ...details,
        monotonicMicros: Math.floor(performance.now() * 1_000),
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
      })}\n`,
    );
  } catch {
    // Opt-in diagnostics never own renderer lifecycle.
  }
}

async function flushTuiPerfMarks(): Promise<void> {
  if (!tuiPerfStream || tuiPerfStreamFailed) return;
  await new Promise<void>((resolveFlush) => {
    try {
      tuiPerfStream.write("", () => resolveFlush());
    } catch {
      resolveFlush();
    }
  });
}

async function closeTuiPerfMarks(): Promise<void> {
  if (!tuiPerfStream) return;
  await flushTuiPerfMarks();
  await new Promise<void>((resolveClose) => tuiPerfStream.end(resolveClose));
  tuiPerfStream.off("error", failTuiPerfStream);
  tuiPerfStream.off("drain", drainTuiPerfStream);
}

function paneForWindow(layout: OpenTuiWorkspaceLayout): string | null {
  return (
    layout.panes.find((pane) => pane.active && pane.pane)?.pane ??
    layout.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

export async function startApplicationRoot(): Promise<void> {
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
      let sessionOwner: OpenTuiSessionOwner | null = null;
      let pendingWindowSwitch: {
        readonly traceId: string;
        readonly target: string;
        readonly startedAtMicros: number;
        layoutPublished: boolean;
      } | null = null;
      let pendingResizeGuide: {
        readonly traceId: string;
        readonly startedAtMicros: number;
      } | null = null;
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
          ensureWorkspace: ensureOpenTuiSessionWorkspace,
          createHost: (sessionName) =>
            createOpenTuiGenerationHost(sessionName, presentation, {
              onDiagnostic: (phase, details) => tuiPerfMark(`generation-${phase}`, details),
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

        const liveSelectionTarget = (): LivePaneSelectionTarget | null => {
          const active = generation();
          if (active?.status !== "live" || !active.client || !active.connection) return null;
          return {
            status: "live",
            workspaceName: active.connection.workspaceName,
            ownsInputAuthority: () => {
              const snapshot = active.client!.getSnapshot();
              return (
                snapshot.target?.daemon.instanceId === active.daemonGeneration &&
                snapshot.authority?.generation === active.daemonGeneration &&
                snapshot.authority.owners.input === OPEN_TUI_HOST_CLIENT_ID
              );
            },
            client: active.client,
          };
        };
        const paneInput = new TerminalPaneInputRouter({
          select: async (paneId: string) => {
            const expected = liveSelectionTarget();
            const selected = expected
              ? await selectTerminalPane(expected, liveSelectionTarget, paneId)
              : false;
            const pending = pendingWindowSwitch;
            if (pending)
              tuiPerfMark("window-switch-receipt", {
                traceId: pending.traceId,
                target: pending.target,
                selected,
                durationMicros: Math.floor(performance.now() * 1_000) - pending.startedAtMicros,
              });
            return selected;
          },
          send: async (paneId, input) => {
            const active = generation();
            if (active?.status !== "live" || !active.fastLane) return;
            const trace = currentTuiPerformanceEventSink()?.beginTerminalInput?.();
            const pending = active.fastLane.lane.sendInput(paneId, input, trace?.traceId);
            trace?.finish();
            const outcome = await pending;
            if (outcome.status !== "sent") trace?.cancel();
          },
          onFocusedPane: setFocusedPane,
        });
        const stopLayout = presentation.subscribeWindows((snapshot) => {
          setLayoutSnapshot(snapshot);
          tuiPerfMark("layout-publication", {
            windows: snapshot.windows.length,
            panes: snapshot.current?.panes.length ?? 0,
          });
          const active = snapshot.current ? paneForWindow(snapshot.current) : null;
          paneInput.adoptCanonicalPane(active);
          const currentWindow = snapshot.current?.semanticWindowId ?? snapshot.current?.windowName;
          if (pendingWindowSwitch && currentWindow === pendingWindowSwitch.target)
            pendingWindowSwitch.layoutPublished = true;
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

        const selectPane = (paneId: string): void => {
          paneInput.selectPane(paneId);
        };
        const previewPaneResize = (_preview: ApplicationPaneResizePreview): void => {
          if (!tuiPerfStream) return;
          // Preserve the earliest pointer tick waiting for this frame. Later
          // drag ticks coalesce into the same guide paint and must not replace
          // it with an artificially shorter latency sample.
          if (pendingResizeGuide) return;
          pendingResizeGuide = {
            traceId: randomUUID(),
            startedAtMicros: Math.floor(performance.now() * 1_000),
          };
        };
        const resizePane = (preview: ApplicationPaneResizePreview): void => {
          const expected = generation();
          if (expected?.status !== "live" || !expected.client || !expected.connection) return;
          const expectedGeneration = expected.daemonGeneration;
          const expectedClient = expected.client;
          void (async () => {
            const lease = await expectedClient.requestAuthority("geometry");
            const current = generation();
            if (
              !lease ||
              current?.status !== "live" ||
              current.daemonGeneration !== expectedGeneration ||
              current.client !== expectedClient
            )
              return;
            await expectedClient.dispatch({
              kind: "semantic-intent",
              operationId: randomUUID(),
              intent: {
                verb: "workspace.pane.resize",
                workspaceName: expected.connection!.workspaceName,
                semanticPaneId: preview.semanticPaneId,
                axis: preview.axis,
                cells: preview.cells,
              },
            });
          })().catch((error: unknown) => {
            tuiPerfMark("pane-resize-rejected", {
              message: error instanceof Error ? error.message : String(error),
            });
          });
        };
        const cycleWindow = (): void => {
          const windows = layoutSnapshot().windows;
          if (windows.length < 2) return;
          const current = windows.findIndex((window) => window.currentWindow);
          const next = windows[(current + 1 + windows.length) % windows.length];
          const pane = next ? paneForWindow(next) : null;
          const target = next?.semanticWindowId ?? next?.windowName;
          if (pane && target) {
            if (tuiPerfStream) {
              pendingWindowSwitch = {
                traceId: randomUUID(),
                target,
                startedAtMicros: Math.floor(performance.now() * 1_000),
                layoutPublished: false,
              };
              tuiPerfMark("window-switch-start", {
                traceId: pendingWindowSwitch.traceId,
                target,
              });
            }
            selectPane(pane);
          }
        };

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
            cycleWindow();
            return;
          }
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (surface() !== "terminals" || !lane || !focusedPane()) return;
          const input = terminalInputForOpenTuiKey(event);
          if (input) void paneInput.sendInput(input);
        });
        usePaste((event) => {
          const active = generation();
          const lane = active?.status === "live" ? active.fastLane : null;
          if (surface() !== "terminals" || !lane || !focusedPane()) return;
          const text = Buffer.from(event.bytes).toString("utf8");
          for (const input of terminalInputsForPaste(text)) {
            void paneInput.sendInput(input);
          }
        });
        onMount(() => {
          tuiPerfMark("solid-mounted");
          if (config.target) void startGeneration(config.target);
          resolveReady();
        });

        return (
          <box
            width={dimensions().width}
            height={dimensions().height}
            overflow="hidden"
            backgroundColor={theme.roles.surfaces.canvas}
          >
            <box
              position="absolute"
              left={0}
              top={0}
              width={dimensions().width}
              height={1}
              backgroundColor={theme.roles.surfaces.command}
              flexDirection="row"
            >
              <text fg={theme.roles.text.link} attributes={1}>
                {" "}
                tmux-ide{" "}
              </text>
              <text
                fg={
                  surface() === "home"
                    ? theme.roles.selection.selectionText
                    : theme.roles.text.muted
                }
              >
                {" "}
                F1 Home{" "}
              </text>
              <text
                fg={
                  surface() === "terminals"
                    ? theme.roles.selection.selectionText
                    : theme.roles.text.muted
                }
              >
                {" "}
                F2 Terminals{" "}
              </text>
              <text fg={theme.roles.text.muted}>
                {" "}
                {generation()?.connection?.workspaceName ?? "no active workspace"} ·
                {generation()?.status ?? "unavailable"}{" "}
              </text>
            </box>
            <Show when={surface() === "home"}>
              <box position="absolute" left={2} top={3} flexDirection="column">
                <text fg={theme.roles.text.primary} attributes={1}>
                  tmux-ide
                </text>
                <text fg={theme.roles.text.secondary}>
                  A fast visual client for the tmux sessions you already own.
                </text>
                <text fg={theme.roles.text.muted}>Start with: tmux-ide app &lt;session&gt;</text>
                <Show when={config.sessions.length > 0}>
                  <text fg={theme.roles.text.secondary}>Live tmux sessions</text>
                  <For each={config.sessions}>
                    {(sessionName, index) => (
                      <text
                        fg={
                          selectedSession() === index()
                            ? theme.roles.text.link
                            : theme.roles.text.secondary
                        }
                      >
                        {`${selectedSession() === index() ? "›" : " "} ${sessionName}`}
                      </text>
                    )}
                  </For>
                  <text fg={theme.roles.text.muted}>↑↓ choose · Enter open</text>
                </Show>
                <Show when={bootstrapNote()}>
                  {(note) => <text fg={theme.roles.text.muted}>{note()}</text>}
                </Show>
              </box>
            </Show>
            <Show when={surface() === "terminals"}>
              <Show when={terminalRendererSource()} keyed>
                {(source) => (
                  <ApplicationTerminalWorkspace
                    layout={layoutSnapshot()}
                    adapter={source.adapter}
                    rendererEpoch={source.rendererEpoch}
                    width={viewport().width}
                    height={viewport().height}
                    focusedPane={focusedPane()}
                    theme={theme}
                    palette={palette}
                    onSelectPane={selectPane}
                    onResizePreview={previewPaneResize}
                    onResizePane={resizePane}
                  />
                )}
              </Show>
            </Show>
          </box>
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
        const pending = pendingWindowSwitch;
        if (!pending?.layoutPublished) return;
        pendingWindowSwitch = null;
        tuiPerfMark("window-switch-settled", {
          traceId: pending.traceId,
          target: pending.target,
          durationMicros: Math.floor(performance.now() * 1_000) - pending.startedAtMicros,
        });
      };
      if (tuiPerfStream) renderer.on("frame", observeWindowSwitchFrame);
      const observeResizeGuideFrame = () => {
        const pending = pendingResizeGuide;
        if (!pending) return;
        pendingResizeGuide = null;
        tuiPerfMark("resize-guide-settled", {
          traceId: pending.traceId,
          durationMicros: Math.floor(performance.now() * 1_000) - pending.startedAtMicros,
        });
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
            diagnostics: {
              droppedRecords: tuiPerfDroppedRecords,
              failed: tuiPerfStreamFailed,
            },
          });
          if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG) {
            const { closeReferencePerformanceTraceCollector } =
              await import("../reference-performance-trace.ts");
            await closeReferencePerformanceTraceCollector();
          }
          await closeTuiPerfMarks();
        },
      };
    },
    publishReady() {
      publishTuiInputReady("app");
    },
  });
}
