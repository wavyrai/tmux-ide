/* @jsxImportSource @opentui/solid */
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useKeyboard, usePaste } from "@opentui/solid";
import { publishTuiInputReady } from "../../readiness.ts";
import { prepareOpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import {
  createPaneSurfaceHostFocusTransitionOwner,
  registerPaneSurface,
} from "../pane-surface.tsx";
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
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
import { createApplicationHomeCatalogOwner } from "./application-home-catalog-owner.ts";
import { createApplicationHomeNavigationOwner } from "./application-home-agents-owner.ts";
import { ApplicationShellView, applicationShellKeyAction } from "./application-shell-view.tsx";
import { createApplicationGenerationStarter } from "./application-generation-starter.ts";
import { createApplicationInputReadiness } from "./application-input-readiness.ts";
import { applyApplicationAppearanceToRenderer } from "./application-theme-repaint.ts";
import {
  applicationPaletteKeyboardDisposition,
  applicationPaletteOwnsInput,
} from "./application-palette-input.ts";
import { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import {
  createApplicationHostFocusRecovery,
  type HostFocusRendererSource,
} from "./application-host-focus-presentation.ts";
import { resolveApplicationHostFocusControlCapability } from "./application-host-focus-control-capability.ts";
import { createApplicationHostFocusControlBindingObserver } from "./application-host-focus-control-binding.ts";
import {
  markTerminalHostFocusBinding,
  markTerminalHostFocusControlGate,
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
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { createApplicationTerminalHostFocus } from "./application-terminal-host-focus-owner.ts";
import { createApplicationTerminalFrameReadinessOwner } from "./application-terminal-frame-readiness-owner.ts";
import {
  createApplicationSessionFocusOwner,
  type ApplicationSessionFocusOwner,
} from "./application-session-focus-owner.ts";
import { createApplicationTerminalInputIngress } from "./application-terminal-input-ingress.ts";
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
import { createAppearanceOwner } from "./application-appearance-owner.ts";
import { createApplicationTerminalPaletteOwner } from "./application-terminal-palette-owner.ts";
import {
  createApplicationRootReadiness,
  createApplicationRootRenderer,
} from "./application-root-renderer.ts";
import { createKeyboardRouteOwner, KeyboardRouteProvider } from "../ui/keyboard-router.tsx";
export type { StartApplicationRootOptions } from "./application-root-configuration.ts";
export async function startApplicationRoot(options: StartApplicationRootOptions = {}) {
  options.initialPreparation?.diagnosticHandoff?.attach(tuiPerfMark);
  let renderer!: Awaited<ReturnType<typeof createApplicationRootRenderer>>;
  let lifecycle!: TuiApplicationLifecycle;
  const { ready, resolveReady, rejectReady } = createApplicationRootReadiness();
  await startTuiApplication({
    argv: process.argv.slice(2),
    parseArgs: parseApplicationArgs,
    loadConfig: loadApplicationConfig,
    async createRenderer({ config }) {
      renderer = await createApplicationRootRenderer(config.app.app.kittyKeys);
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
      const inputReadiness = createApplicationInputReadiness(
        clipboardReady,
        Boolean(config.target),
        resolveReady,
        rejectReady,
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
      let interaction!: ReturnType<typeof createApplicationTerminalInteractionController>;
      let sessionFocusOwner: ApplicationSessionFocusOwner | null = null;
      let setRendererFocused: ((focused: boolean) => void) | null = null;
      let getRendererFocused: (() => boolean) | null = null;
      let getFocusedPane: (() => string | null) | null = null;
      let noteHostInteraction = () => undefined;
      const recoverHostFocus = createApplicationHostFocusRecovery(() => noteHostInteraction());
      let observedFocusGenerationKey: string | null = null;
      const hostFocusControlCapability = resolveApplicationHostFocusControlCapability(process.env);
      markTerminalHostFocusControlGate(hostFocusControlCapability.observation);
      const hostFocusBindingObserver = createApplicationHostFocusControlBindingObserver({
        enabled: hostFocusControlCapability.enabled,
        currentHost: () => sessionOwner?.snapshot() ?? null,
        publish: markTerminalHostFocusBinding,
      });
      let getTerminalRendererSource: (() => HostFocusRendererSource | null) | null = null;
      const terminalHostFocus = createApplicationTerminalHostFocus(() => sessionOwner);
      const root = renderWithTerminalDimensions(renderer)((dimensions) => {
        tuiPerfMark("solid-root-evaluate");
        registerPaneSurface();
        const componentKeyboardRoutes = createKeyboardRouteOwner();
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
            inputReadiness.adopt(snapshot);
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
        let appearance!: ReturnType<typeof createAppearanceOwner>;
        const terminalPaletteOwner = createApplicationTerminalPaletteOwner(renderer, {
          isThemeModeUnlocked: () => appearance.theme().setting === "system",
        });
        appearance = createAppearanceOwner(config.app, renderer, terminalPaletteOwner);
        const { theme, palette, setTransientNote, cycleTheme } = appearance;
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
        const generationStarter = createApplicationGenerationStarter({
          binding: shellBinding,
          sessionOwner: () => sessionOwner!,
          focusOwner: () => sessionFocusOwner,
          setNote: appearance.setNote,
          setSurface,
        });
        const terminalInputIngress = createApplicationTerminalInputIngress(
          interaction,
          generation,
          () => sessionOwner,
          focusedPane,
          appearance.setNote,
        );
        const startGeneration = terminalInputIngress.wrapStarter(generationStarter);
        const homeCatalog = createApplicationHomeCatalogOwner({
          lifecycle,
          automaticOpen: config.target === null,
          startGeneration,
          setNote: appearance.setNote,
        });
        onCleanup(() => {
          terminalInputIngress.dispose();
          semanticViewportResize.dispose();
          stopLayout();
          stopShell();
          appearance.dispose();
          shellBinding.dispose();
          componentKeyboardRoutes.dispose();
          sessionFocusOwner?.dispose();
        });
        const { homeAgents, paneRename, paletteCommands, paletteCommandList, openAgent } =
          createApplicationHomeNavigationOwner({
            catalog: homeCatalog,
            activeSurface,
            shell,
            binding: shellBinding,
            sessionOwner: () => sessionOwner,
            generationStarter,
            startGeneration,
            interaction,
            rendererFocused,
            setSurface,
            setNote: setTransientNote,
          });
        let paintedAppearanceGeneration: number | null = null;
        createEffect(() => {
          const nextAppearance = appearance.appearance();
          paintedAppearanceGeneration = applyApplicationAppearanceToRenderer(
            renderer,
            nextAppearance.theme,
            nextAppearance.generation,
            paintedAppearanceGeneration,
          );
        });
        createEffect(() => {
          const currentShell = shell();
          semanticViewportResize.adopt(dimensions(), currentShell.semantic, generation());
          focusedPane();
          terminalInputIngress.adopt();
        });
        useKeyboard((event) => {
          noteHostInteraction();
          const name = event.name.toLowerCase();
          if (paneRename.handleKey(event)) return;
          if (selectionOwner.handleKey(name, event)) return;
          if (event.ctrl && name === "q") {
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
          // Exact-agent admission must settle before any keys reach a PTY.
          if (homeAgents?.opening()) return;
          if (
            activeSurface() === "terminals" &&
            shell().semantic === null &&
            homeCatalog.handleKey(name)
          )
            return;
          if (
            (activeSurface() === "home" || activeSurface() === "terminals") &&
            name === "n" &&
            homeCatalog.phase() === "live" &&
            homeCatalog.sessionNames().length === 0
          ) {
            void homeCatalog.createLocalSession();
            return;
          }
          if (componentKeyboardRoutes.route(event)) return;
          if (activeSurface() === "terminals" && interaction.routeWorkspaceKey(event)) return;
          if (
            activeSurface() === "terminals" &&
            event.ctrl &&
            event.name.toLowerCase() === "c" &&
            selectionOwner.copyCurrent()
          )
            return;
          if (activeSurface() !== "terminals") return;
          terminalInputIngress.routeKey(event);
        });
        usePaste((event) => {
          noteHostInteraction();
          if (paneRename.handlePaste(event.bytes)) return;
          if (selectionOwner.blocksInput()) return;
          if (
            applicationPaletteOwnsInput(
              Boolean(shell().semantic?.focus.palette.open || shell().localPaletteOpen),
            )
          )
            return;
          if (activeSurface() !== "terminals") return;
          if (homeAgents?.opening()) return;
          terminalInputIngress.routePaste(event.bytes);
        });
        onMount(() => {
          tuiPerfMark("solid-mounted");
          homeCatalog.start();
          if (config.target) void startGeneration(config.target);
        });
        const resizeIngress = tuiPerfStream ? interaction.beginResizePointerIngress : undefined;
        const applicationMouseIngress = applicationMousePointerIngressCapability(
          tuiPerfStream,
          selectionOwner.beginPointerIngress,
        );
        const focusedApplicationMouseIngress = recoverHostFocus.optional(applicationMouseIngress);
        return (
          <KeyboardRouteProvider owner={componentKeyboardRoutes}>
            <ApplicationShellView
              homeAgents={homeAgents.presentation}
              dimensions={dimensions}
              surface={activeSurface}
              semantic={() => shell().semantic}
              generationStatus={() => shell().status}
              sessions={homeCatalog.sessionNames}
              selectedSession={homeCatalog.selectedSessionIndex}
              bootstrapNote={appearance.note}
              catalogPhase={homeCatalog.phase}
              catalogNote={homeCatalog.note}
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
              theme={theme()}
              palette={palette()}
              onOpenSurface={recoverHostFocus(paletteCommands.openSurface)}
              onOpenSession={recoverHostFocus((sessionName, source) => {
                homeAgents?.cancel();
                void startGeneration(sessionName, false, source);
              })}
              onOpenAgent={recoverHostFocus((sessionName, paneId, source) => {
                homeAgents?.cancel();
                void openAgent(sessionName, paneId, source);
              })}
              onSetPaletteOpen={recoverHostFocus(paletteCommands.setOpen)}
              onPaletteActivate={recoverHostFocus(paletteCommands.activate)}
              onCreateWindow={recoverHostFocus(() =>
                paletteCommands.activate("new-window", "mouse"),
              )}
              onCreateSession={recoverHostFocus(() => void homeCatalog.createLocalSession())}
              onCycleTheme={recoverHostFocus(cycleTheme)}
              onBeginPaneRename={recoverHostFocus(paneRename.begin)}
              onCancelPaneRename={recoverHostFocus(paneRename.cancel)}
              onDismissNotification={recoverHostFocus(() => setTransientNote(null))}
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
          </KeyboardRouteProvider>
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
