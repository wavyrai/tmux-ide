/* @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core";
import type { CommandSource } from "@tmux-ide/contracts";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useKeyboard, usePaste } from "@opentui/solid";
import { publishTuiInputReady } from "../../readiness.ts";
import { prepareOpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import {
  createPaneSurfaceHostFocusTransitionOwner,
  registerPaneSurface,
} from "../pane-surface.tsx";
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { startTuiApplication } from "./application-bootstrap.ts";
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
  createApplicationAgentNavigator,
  createApplicationGenerationStarter,
} from "./application-generation-starter.ts";
import {
  applicationPaletteCommands,
  applicationPaletteKeyboardDisposition,
  applicationPaletteOwnsInput,
} from "./application-palette-input.ts";
import { createApplicationPaletteCommandOwner } from "./application-palette-command-owner.ts";
import { createApplicationPaneRenameOwner } from "./application-pane-rename-owner.ts";
import {
  createApplicationTerminalInteractionController,
  type ApplicationTerminalInteractionController,
} from "./application-terminal-interaction-controller.ts";
import {
  createApplicationHostFocusRecovery,
  type HostFocusRendererSource,
} from "./application-host-focus-presentation.ts";
import { resolveApplicationHostFocusControlCapability } from "./application-host-focus-control-capability.ts";
import { createApplicationHostFocusControlBindingObserver } from "./application-host-focus-control-binding.ts";
import {
  tuiPerfCriticalMark,
  tuiPerfDiagnostics,
  tuiPerfMark,
  tuiPerfStream,
} from "./application-performance-log.ts";
import { installApplicationPostRenderRuntime } from "./application-post-render-runtime.ts";
import { createOpenTuiHostLocalTmuxAdapter } from "./host-local-tmux-adapter.ts";
import {
  createOpenTuiGenerationHost,
  openTuiGenerationRenderEqual,
} from "./open-tui-generation-host.ts";
import { createOpenTuiSessionOwner, type OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { createApplicationTerminalHostFocus } from "./application-terminal-host-focus-owner.ts";
import { createApplicationTerminalFrameReadinessOwner } from "./application-terminal-frame-readiness-owner.ts";
import { createApplicationSessionFocusOwner } from "./application-session-focus-owner.ts";
import type { ApplicationSessionFocusOwner } from "./application-session-focus-owner.ts";
import {
  applicationMousePointerIngressCapability,
  createApplicationTerminalSelectionOwner,
  applicationClipboardReadiness,
  routeApplicationTerminalPointerInput,
} from "./application-terminal-selection-owner.ts";
import { createApplicationTerminalRendererSources } from "./application-terminal-renderer-sources.ts";
import { createSemanticShellViewportResizeOwner } from "./semantic-shell-viewport-resize.ts";
import { installHostedRuntimeOwnership } from "./hosted-tty-size-bridge.ts";
import { renderWithTerminalDimensions } from "./terminal-dimensions-owner.ts";
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
      installHostedRuntimeOwnership({ lifecycle, hosted: hostLocal.hosted, renderer });
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
      let sessionFocusOwner: ApplicationSessionFocusOwner | null = null;
      let setRendererFocused: ((focused: boolean) => void) | null = null;
      let getRendererFocused: (() => boolean) | null = null;
      let getFocusedPane: (() => string | null) | null = null;
      let noteHostInteraction = () => undefined;
      const recoverHostFocus = createApplicationHostFocusRecovery(() => noteHostInteraction());
      let observedFocusGenerationKey: string | null = null;
      const hostFocusControlCapability = resolveApplicationHostFocusControlCapability(process.env);
      tuiPerfCriticalMark(
        "terminal-host-focus-control-gate",
        "terminal-host-focus-control-gate-ready",
        hostFocusControlCapability.observation,
      );
      const hostFocusBindingObserver = createApplicationHostFocusControlBindingObserver({
        enabled: hostFocusControlCapability.enabled,
        currentHost: () => sessionOwner?.snapshot() ?? null,
        publish: (identity) =>
          tuiPerfCriticalMark(
            `terminal-host-focus-binding:${identity.bindingEpoch}`,
            "terminal-host-focus-control-binding-ready",
            identity,
          ),
      });
      let getTerminalRendererSource: (() => HostFocusRendererSource | null) | null = null;
      const terminalHostFocus = createApplicationTerminalHostFocus(() => sessionOwner);
      const root = renderWithTerminalDimensions(renderer)((dimensions) => {
        tuiPerfMark("solid-root-evaluate");
        registerPaneSurface();
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
            sessionFocusOwner?.adopt();
            const nextAuthorityClient =
              snapshot?.status === "live" ? snapshot.authorityClient : null;
            terminalHostFocus.adopt(nextAuthorityClient);
            hostFocusBindingObserver.adopt(snapshot);
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
        sessionFocusOwner = createApplicationSessionFocusOwner({
          generation,
          layout: layoutSnapshot,
          focusTerminalPane: shellBinding.focusTerminalPane,
        });
        shellBinding.subscribe(sessionFocusOwner.adopt);
        const stopLayout = presentation.subscribeWindows((snapshot) => {
          batch(() => {
            interaction.adoptLayout(snapshot);
            setLayoutSnapshot(snapshot);
          });
          sessionFocusOwner?.adopt();
          tuiPerfMark("layout-publication", {
            windows: snapshot.windows.length,
            panes: snapshot.current?.panes.length ?? 0,
          });
        });
        const startGeneration = createApplicationGenerationStarter({
          binding: shellBinding,
          sessionOwner: () => sessionOwner!,
          focusOwner: () => sessionFocusOwner,
          setNote: setBootstrapNote,
          setSurface,
        });
        const openAgent = createApplicationAgentNavigator({
          startGeneration,
          sessionOwner: () => sessionOwner!,
          selectPane: interaction.selectPane,
        });
        const paletteCommandList = createMemo(() => applicationPaletteCommands(shell().semantic));
        onCleanup(() => {
          semanticViewportResize.dispose();
          stopLayout();
          stopShell();
          shellBinding.dispose();
          sessionFocusOwner?.dispose();
        });
        const commandSource = (
          source: "keyboard" | "mouse",
          surfaceName: "application-bar" | "command-palette",
        ): CommandSource => ({ kind: source, surface: surfaceName });
        const paletteCommands = createApplicationPaletteCommandOwner({
          activeSurface,
          binding: shellBinding,
          commandSource: (source, surfaceName) => commandSource(source, surfaceName),
          setSurface,
          setNote: setBootstrapNote,
          newWindow: interaction.newWindow,
          splitPane: interaction.splitPane,
          closePane: interaction.closePane,
          openAgent,
        });
        const paneRename = createApplicationPaneRenameOwner(
          interaction.renamePane,
          setBootstrapNote,
        );
        createEffect(() => {
          renderer.setBackgroundColor(theme.roles.surfaces.canvas);
          const currentShell = shell();
          semanticViewportResize.adopt(dimensions(), currentShell.semantic, generation());
        });
        useKeyboard((event) => {
          noteHostInteraction();
          const name = event.name.toLowerCase();
          if (paneRename.handleKey(event)) return;
          if (selectionOwner.handleKey(name)) return;
          if (event.ctrl && name === "q") {
            // tmux owns real hosted Ctrl-Q with exact client context. A direct
            // pane injection has no identity, so consume it fail-closed.
            if (!hostLocal.hosted) void lifecycle.shutdown("keyboard");
            return;
          }
          const isPaletteOpen = applicationPaletteOwnsInput(
            Boolean(shell().semantic?.focus.palette.open || shell().localPaletteOpen),
          );
          const paletteAction = applicationPaletteKeyboardDisposition(
            event,
            isPaletteOpen,
            paletteCommands.selection(),
            paletteCommandList(),
          );
          if (paletteAction) {
            if (paletteAction.kind === "select") {
              paletteCommands.select(paletteAction.index);
            } else if (paletteAction.kind === "activate")
              paletteCommands.activate(paletteAction.command, "keyboard");
            else if (paletteAction.kind === "close") paletteCommands.setOpen(false, "keyboard");
            return;
          }
          const chromeAction = applicationShellKeyAction(event, false);
          if (chromeAction) {
            if (chromeAction === "home" || chromeAction === "terminals")
              paletteCommands.openSurface(chromeAction, "keyboard");
            else paletteCommands.setOpen(chromeAction === "palette-open", "keyboard");
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
          noteHostInteraction();
          if (paneRename.handlePaste(event.bytes)) return;
          if (
            applicationPaletteOwnsInput(
              Boolean(shell().semantic?.focus.palette.open || shell().localPaletteOpen),
            )
          )
            return;
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
        const focusedApplicationMouseIngress = recoverHostFocus.optional(applicationMouseIngress);
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
            paneRenameDialog={paneRename.draft}
            paletteSelection={paletteCommands.selection}
            paletteCloseArmed={paletteCommands.closeArmed}
            paletteCommands={paletteCommandList}
            terminalRendererSource={terminalRendererSource}
            terminalGestureRuntime={terminalGestureRuntime}
            onApplicationMousePointerIngress={focusedApplicationMouseIngress}
            layout={layoutSnapshot}
            focusedPane={() => (rendererFocused() ? focusedPane() : null)}
            rendererFocused={rendererFocused}
            hostFocusTransitionOwner={hostFocusTransitionOwner ?? undefined}
            theme={theme}
            palette={palette}
            onOpenSurface={recoverHostFocus(paletteCommands.openSurface)}
            onOpenSession={recoverHostFocus(
              (sessionName) => void startGeneration(sessionName, false, "mouse"),
            )}
            onOpenAgent={recoverHostFocus((sessionName, paneId) => {
              void openAgent(sessionName, paneId);
            })}
            onSetPaletteOpen={recoverHostFocus(paletteCommands.setOpen)}
            onPaletteActivate={recoverHostFocus(paletteCommands.activate)}
            onCreateWindow={recoverHostFocus(() => paletteCommands.activate("new-window", "mouse"))}
            onBeginPaneRename={recoverHostFocus(paneRename.begin)}
            onCancelPaneRename={recoverHostFocus(paneRename.cancel)}
            onSelectPane={recoverHostFocus(interaction.selectPane)}
            onResizePreview={recoverHostFocus(interaction.previewPaneResize)}
            onResizePane={recoverHostFocus(interaction.resizePane)}
            onResizePointerIngress={recoverHostFocus.optional(resizeIngress)}
            onTerminalInput={recoverHostFocus((paneId, input) =>
              routeApplicationTerminalPointerInput(interaction, paneId, input),
            )}
            onCopyText={selectionOwner.copy}
            onSelectionCopyOwner={selectionOwner.registerCopy}
            onSelectionKeyOwner={selectionOwner.registerKey}
            onWindowPresented={tuiPerfStream ? interaction.observeWindowPresentation : undefined}
            onInteraction={() => noteHostInteraction()}
          />
        );
      });
      const postRender = installApplicationPostRenderRuntime({
        renderer,
        root,
        rejectReady,
        shutdown: () => lifecycle.shutdown("bootstrap-error"),
        terminalFrameReadiness,
        interaction,
        hostFocusTransitionOwner,
        frameDiagnosticSink,
        terminalHostFocus,
        focusedPane: () => getFocusedPane?.() ?? null,
        rendererFocused: () => getRendererFocused?.() ?? true,
        setRendererFocused: (focused) => setRendererFocused?.(focused),
        rendererSource: () => getTerminalRendererSource?.() ?? null,
        hostFocusControlCapability,
        hostFocusBindingObserver,
        sessionOwner: () => sessionOwner,
        presentation,
        retireDiagnosticHandoff: () => options.initialPreparation?.diagnosticHandoff?.retire(),
      });
      noteHostInteraction = postRender.noteInteraction;
      return { root, ready, close: postRender.close };
    },
    publishReady() {
      publishTuiInputReady("app");
    },
  });
}
