/* @jsxImportSource @opentui/solid */
import { parseArgs } from "node:util";
import { appendFileSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { loadAppConfig, type AppConfig } from "../../../lib/app-config.ts";
import { publishTuiInputReady } from "../../readiness.ts";
import {
  discoverOpenTuiLiveSessions,
  ensureOpenTuiSessionWorkspace,
} from "../configless-session-bootstrap.ts";
import { registerPaneSurface } from "../pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import type { OpenTuiWorkspaceLayout } from "../open-tui-workspace-runtime-port.ts";
import { startTuiApplication, observeTuiRootFailure } from "./application-bootstrap.ts";
import { TuiApplicationLifecycle } from "./application-lifecycle.ts";
import { ApplicationTerminalWorkspace } from "./application-terminal-workspace.tsx";
import { createOpenTuiHostLocalTmuxAdapter } from "./host-local-tmux-adapter.ts";
import { createOpenTuiGenerationHost } from "./open-tui-generation-host.ts";
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
  const sessions = await discoverOpenTuiLiveSessions().catch(() => Object.freeze([]));
  const candidate = args.target ?? (sessions.length === 1 ? sessions[0]! : null);
  const target = candidate
    ? (await ensureOpenTuiSessionWorkspace(candidate).catch(() => false))
      ? candidate
      : null
    : null;
  return Object.freeze({
    app: loadAppConfig(),
    target,
    sessions,
  });
}

const TUI_PERF_LOG = process.env.TMUX_IDE_TUI_PERF_LOG;
const TUI_LAUNCH_EPOCH_MS = Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now());
function tuiPerfMark(phase: string, details?: Readonly<Record<string, unknown>>): void {
  if (!TUI_PERF_LOG) return;
  try {
    appendFileSync(
      TUI_PERF_LOG,
      `${JSON.stringify({
        phase,
        elapsedMs: Date.now() - TUI_LAUNCH_EPOCH_MS,
        at: new Date().toISOString(),
        ...details,
      })}\n`,
    );
  } catch {
    // Opt-in diagnostics never own renderer lifecycle.
  }
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
      renderer = await createCliRenderer({
        exitOnCtrlC: false,
        autoFocus: false,
        ...TUI_RENDERER_CADENCE,
        useKittyKeyboard: config.app.app.kittyKeys ? {} : null,
        consoleMode: process.env.TMUX_IDE_MIRROR_DEBUG ? "console-overlay" : "disabled",
        openConsoleOnError: Boolean(process.env.TMUX_IDE_MIRROR_DEBUG),
      });
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
      let generationHost: ReturnType<typeof createOpenTuiGenerationHost> | null = null;
      let stopGeneration: (() => void) | null = null;
      const terminalHostFocus = new OpenTuiTerminalHostFocus(true);

      const root = render(() => {
        registerPaneSurface();
        const dimensions = useTerminalDimensions();
        const theme = createSemanticThemeSnapshot(config.app.theme, renderer.themeMode);
        const palette = createTerminalPaletteProjection(theme);
        const [surface, setSurface] = createSignal<"home" | "terminals">(
          config.target ? "terminals" : "home",
        );
        const [generation, setGeneration] = createSignal(generationHost?.getSnapshot() ?? null);
        const [layoutSnapshot, setLayoutSnapshot] = createSignal(presentation.getWindowSnapshot());
        const [focusedPane, setFocusedPane] = createSignal<string | null>(null);
        const [selectedSession, setSelectedSession] = createSignal(0);
        const [bootstrapNote, setBootstrapNote] = createSignal<string | null>(null);
        const viewport = createMemo(() => ({
          width: Math.max(1, dimensions().width),
          height: Math.max(2, dimensions().height - 2),
        }));

        const liveSelectionTarget = (): LivePaneSelectionTarget | null => {
          const active = generation();
          if (active?.status !== "live" || !active.client || !active.connection) return null;
          return {
            status: "live",
            workspaceName: active.connection.workspaceName,
            client: active.client,
          };
        };
        const paneInput = new TerminalPaneInputRouter({
          select: async (paneId: string) => {
            const expected = liveSelectionTarget();
            return expected
              ? await selectTerminalPane(expected, liveSelectionTarget, paneId)
              : false;
          },
          send: async (paneId, input) => {
            const active = generation();
            if (active?.status !== "live" || !active.fastLane) return;
            await active.fastLane.lane.sendInput(paneId, input);
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
        });
        const startGeneration = async (
          sessionName: string,
          workspacePrepared = false,
        ): Promise<void> => {
          if (generationHost) return;
          setBootstrapNote(`opening ${sessionName}`);
          if (
            !workspacePrepared &&
            !(await ensureOpenTuiSessionWorkspace(sessionName).catch(() => false))
          ) {
            setBootstrapNote(`${sessionName} is not available`);
            return;
          }
          const host = createOpenTuiGenerationHost(sessionName, presentation, {
            onDiagnostic: (phase, details) => tuiPerfMark(`generation-${phase}`, details),
          });
          generationHost = host;
          stopGeneration = host.subscribe((snapshot) => {
            setGeneration(snapshot);
            terminalHostFocus.adopt(snapshot.client);
            tuiPerfMark("generation-status", {
              status: snapshot.status,
              daemonGeneration: snapshot.daemonGeneration,
            });
          });
          setSurface("terminals");
          const started = await host.start();
          if (!started) setBootstrapNote(`${sessionName} could not attach`);
        };
        onCleanup(() => {
          stopGeneration?.();
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
        const cycleWindow = (): void => {
          const windows = layoutSnapshot().windows;
          if (windows.length < 2) return;
          const current = windows.findIndex((window) => window.currentWindow);
          const next = windows[(current + 1 + windows.length) % windows.length];
          const pane = next ? paneForWindow(next) : null;
          if (pane) selectPane(pane);
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
          if (config.target) void startGeneration(config.target, true);
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
              <ApplicationTerminalWorkspace
                layout={layoutSnapshot()}
                adapter={generation()?.status === "live" ? (generation()?.adapter ?? null) : null}
                rendererEpoch={generation()?.rendererEpoch ?? 0}
                width={viewport().width}
                height={viewport().height}
                focusedPane={focusedPane()}
                theme={theme}
                palette={palette}
                onSelectPane={selectPane}
              />
            </Show>
          </box>
        );
      }, renderer);

      observeTuiRootFailure(root, {
        rejectReadiness: rejectReady,
        shutdown: () => lifecycle.shutdown("bootstrap-error"),
      });
      let firstTerminalFrameMarked = false;
      const observeTerminalFrame = () => {
        if (firstTerminalFrameMarked) return;
        if (!generationHost?.getSnapshot().adapter?.hasCanonicalSnapshot()) return;
        firstTerminalFrameMarked = true;
        tuiPerfMark("first-terminal-frame");
      };
      renderer.on("frame", observeTerminalFrame);
      const foregroundTerminalHost = () => terminalHostFocus.focus();
      const backgroundTerminalHost = () => terminalHostFocus.blur();
      renderer.on("focus", foregroundTerminalHost);
      renderer.on("blur", backgroundTerminalHost);
      return {
        root,
        ready,
        close: async () => {
          renderer.off("frame", observeTerminalFrame);
          renderer.off("focus", foregroundTerminalHost);
          renderer.off("blur", backgroundTerminalHost);
          terminalHostFocus.dispose();
          generationHost?.dispose();
          if (!generationHost) presentation.dispose();
        },
      };
    },
    publishReady() {
      publishTuiInputReady("app");
    },
  });
}
