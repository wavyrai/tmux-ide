import { applicationMachineAuthorityManager } from "./application-machine-authority.ts";
import { createApplicationMachineAgentNavigator } from "./application-machine-agent-navigation.ts";
import { createApplicationMachineNavigation } from "./application-machine-navigation.ts";
import { ApplicationAddMachineDialog } from "./application-add-machine-dialog.tsx";
import { disposeApplicationDaemonAuthority } from "./application-daemon-authority.ts";
import { createTerminalLinkOpener } from "./terminal-link-opener.ts";
import { createApplicationPaneActivityOwner } from "./application-pane-activity-owner.ts";
import { createApplicationConnectionFeedback } from "../workspace/connection-feedback.ts";
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
import { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import {
  createApplicationHostFocusRecovery,
  type HostFocusRendererSource,
} from "./application-host-focus-presentation.ts";
import { resolveApplicationHostFocusControlCapability } from "./application-host-focus-control-capability.ts";
import { createApplicationHostFocusControlBindingObserver } from "./application-host-focus-control-binding.ts";
import {
  markGenerationStatus,
  markTerminalHostFocusBinding,
  markTerminalHostFocusControlGate,
  tuiPerfCriticalMark,
  tuiPerfDiagnostics,
  tuiPerfMark,
  tuiPerfStream,
  tuiLifecycleStream,
  tuiPerfWheelObservation,
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
  createApplicationRootRenderer as createRootRenderer,
} from "./application-root-renderer.ts";
import { createKeyboardRouteOwner, KeyboardRouteProvider } from "../ui/keyboard-router.tsx";
export type { StartApplicationRootOptions } from "./application-root-configuration.ts";
export async function startApplicationRoot(options: StartApplicationRootOptions = {}) {
  options.initialPreparation?.diagnosticHandoff?.attach(tuiPerfMark);
  let renderer!: Awaited<ReturnType<typeof createRootRenderer>>;
  let lifecycle!: TuiApplicationLifecycle;
  const { ready, resolveReady, rejectReady } = createApplicationRootReadiness();
  await startTuiApplication({
    argv: process.argv.slice(2),
    parseArgs: parseApplicationArgs,
    loadConfig: loadApplicationConfig,
    async createRenderer({ config }) {
      renderer = await createRootRenderer(
        config.app.app.kittyKeys,
        () => lifecycle?.shutdown(),
        () => lifecycle?.shutdown("host"),
      );
      return renderer;
    },
    createLifecycle() {
      lifecycle = new TuiApplicationLifecycle({ destroyRenderer: () => renderer.destroy() });
      lifecycle.signal.addEventListener("abort", disposeApplicationDaemonAuthority, { once: true });
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
        const connectionProgress = createApplicationConnectionFeedback();
        const connectionFeedback = connectionProgress.snapshot;
        const shellBinding = createApplicationShellBinding({ onDiagnostic: tuiPerfMark });
        const [shell, setShell] = createSignal(shellBinding.getSnapshot());
        const stopShell = shellBinding.subscribe(setShell);
        let sessionOwnerEpoch = 0;
        const [generationMachineId, setGenerationMachineId] = createSignal<string | null>(null);
        const makeSessionOwner = (
          machineId = applicationMachineAuthorityManager.snapshot().selectedMachineId,
        ) => {
          const ownedEpoch = ++sessionOwnerEpoch;
          return createOpenTuiSessionOwner({
            prepareConnection: (sessionName) => {
              if (initialPreparation?.sessionName !== sessionName)
                return tuiLifecycleStream
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
                ...connectionProgress.hostOptions(sessionName, tuiLifecycleStream, tuiPerfMark),
                performanceDiagnostics: Boolean(tuiPerfStream),
              }),
            onSnapshot: (snapshot) => {
              if (ownedEpoch !== sessionOwnerEpoch) return;
              setGenerationMachineId(snapshot ? machineId : null);
              let clientGeneration: number | null = null;
              try {
                const value = snapshot?.client?.getSnapshot().generation;
                clientGeneration = Number.isSafeInteger(value) ? value! : null;
              } catch {
                clientGeneration = null;
              }
              const focusGenerationKey =
                snapshot?.status === "live" &&
                snapshot.daemonGeneration &&
                clientGeneration !== null
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
              markGenerationStatus(snapshot);
              inputReadiness.adopt(snapshot);
            },
          });
        };
        sessionOwner = makeSessionOwner();
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
        const { theme, palette, setTransientNote } = appearance;
        const semanticViewportResize = createSemanticShellViewportResizeOwner(layoutSnapshot);
        const activeSurface = createMemo<"home" | "terminals">(
          () => shell().semantic?.workspaceCanvas.activeMode ?? surface(),
        );
        const { terminalRendererSource, terminalGestureRuntime, focusRendererSource } =
          createApplicationTerminalRendererSources(generation);
        const paneInteractions = createApplicationPaneActivityOwner(generation);
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
          setNote: (note) => {
            connectionProgress.note(note);
            appearance.setNote(note);
          },
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
        let machineAgentNavigator:
          | ReturnType<typeof createApplicationMachineAgentNavigator>
          | undefined;
        const machines = createApplicationMachineNavigation({
          resetWorkspace(machineId) {
            if (initialPreparation) {
              void initialPreparation.preparedConnection
                .then(
                  (connection) => connection?.dispose(),
                  () => undefined,
                )
                .catch(() => undefined);
              initialPreparation = null;
            }
            void sessionOwner?.dispose().catch(() => undefined);
            sessionOwner = makeSessionOwner(machineId);
          },
          cancelOpen: () => {
            machineAgentNavigator?.cancel();
            startGeneration.cancel();
          },
          openAgent: (row, source) => machineAgentNavigator?.open(row.machineId, row, source),
          openSession: (name, source) => startGeneration(name, false, source),
          activePaneId: () =>
            generationMachineId() ===
            applicationMachineAuthorityManager.snapshot().selectedMachineId
              ? focusedPane()
              : null,
          sessionName: () => {
            generation();
            return sessionOwner?.sessionName() ?? null;
          },
          setSurface,
          setNote: appearance.setNote,
        });
        machineAgentNavigator = createApplicationMachineAgentNavigator({
          isCurrentTarget: (machineId, row) => machines.agents.isCurrentTarget(machineId, row),
          selectedMachineId: machines.selectedMachineId,
          generationMachineId,
          generation,
          sessionName: () => sessionOwner?.sessionName() ?? null,
          startGeneration,
          selectPane: (paneId, source) => interaction.selectPane(paneId, source),
          showTerminals: () => setSurface("terminals"),
          setNote: setTransientNote,
        });
        onCleanup(() => machineAgentNavigator?.dispose());
        const homeCatalog = createApplicationHomeCatalogOwner({
          lifecycle,
          automaticOpen: config.target === null && machines.automaticOpen,
          automaticOpenAllowed: machines.automaticOpenAllowed,
          catalog: machines.catalog.selectedCatalog,
          startGeneration,
          setNote: appearance.setNote,
        });
        onCleanup(() => {
          connectionProgress.dispose();
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
            focusedPane,
            catalog: homeCatalog,
            activeSurface,
            shell,
            binding: shellBinding,
            sessionOwner: () => sessionOwner,
            generationStarter,
            startGeneration,
            interaction,
            openAppearance: appearance.openPicker,
            appearanceOpen: appearance.pickerOpen,
            zoomPane: interaction.zoomPane,
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
          if (machines.adding()) {
            if (name === "escape") machines.cancelAdd();
            return;
          }
          if (appearance.handlePickerKey(event)) return;
          if (paneRename.handleKey(event)) return;
          if (paletteCommands.handleKey(event)) return;
          if (event.ctrl && name === "g") {
            machines.focus();
            return;
          }
          if (machines.focused() && !(event.ctrl && name === "q")) {
            componentKeyboardRoutes.route(event);
            return;
          }
          if (selectionOwner.handleKey(name, event)) return;
          if (event.ctrl && name === "q") {
            if (!hostLocal.hosted) void lifecycle.shutdown("keyboard");
            return;
          }
          if (connectionFeedback() && name === "escape") {
            machineAgentNavigator?.cancel();
            startGeneration.cancel();
            setSurface("home");
            return;
          }
          const chromeAction = applicationShellKeyAction(event, false);
          if (chromeAction) {
            machineAgentNavigator?.cancel();
            if (chromeAction === "home") startGeneration.cancel();
            if (chromeAction === "home" || chromeAction === "terminals")
              paletteCommands.openSurface(chromeAction, "keyboard");
            else paletteCommands.setOpen(chromeAction === "palette-open", "keyboard");
            return;
          }
          if (homeAgents?.opening() || machineAgentNavigator?.opening()) return;
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
          selectionOwner.prepareInput();
          terminalInputIngress.routeKey(event);
        });
        usePaste((event) => {
          noteHostInteraction();
          if (appearance.pickerOpen() || machines.adding()) return;
          if (paneRename.handlePaste(event.bytes)) return;
          if (selectionOwner.blocksInput()) return;
          if (paletteCommands.handlePaste(event.bytes)) return;
          if (machines.focused()) return;
          if (
            activeSurface() !== "terminals" ||
            homeAgents?.opening() ||
            machineAgentNavigator?.opening()
          )
            return;
          selectionOwner.prepareInput();
          terminalInputIngress.routePaste(event.bytes);
        });
        onMount(() => {
          tuiPerfMark("solid-mounted");
          machines.start(config.target);
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
              machineLabel={machines.isLocal() ? null : machines.label()}
              machineSidebar={machines.sidebar}
              appearanceOwner={appearance}
              homeAgents={homeAgents.presentation}
              dimensions={dimensions}
              surface={activeSurface}
              semantic={() => shell().semantic}
              generationStatus={() => shell().status}
              sessions={homeCatalog.sessionNames}
              selectedSession={homeCatalog.selectedSessionIndex}
              bootstrapNote={() => connectionProgress.text() ?? appearance.note()}
              connectionFeedback={connectionFeedback}
              onCancelOpen={() => {
                machineAgentNavigator?.cancel();
                startGeneration.cancel();
                setSurface("home");
              }}
              onCopyConnectionDetails={() => connectionProgress.copy(hostLocal.copyText)}
              catalogPhase={homeCatalog.phase}
              catalogNote={homeCatalog.note}
              paletteOpen={() => shell().semantic?.focus.palette.open ?? shell().localPaletteOpen}
              paneRenameDialog={paneRename.draft}
              paletteSelection={paletteCommands.selection}
              paletteQuery={paletteCommands.query}
              paletteDisabledReason={paletteCommands.disabledReason}
              onPaletteSelect={paletteCommands.select}
              paletteCloseArmed={paletteCommands.closeArmed}
              paletteCommands={paletteCommandList}
              paneInteractions={paneInteractions}
              recentPaneActivity={paneInteractions.activity}
              terminalRendererSource={terminalRendererSource}
              terminalGestureRuntime={terminalGestureRuntime}
              onApplicationMousePointerIngress={focusedApplicationMouseIngress}
              layout={layoutSnapshot}
              focusedPane={() => (rendererFocused() ? focusedPane() : null)}
              rendererFocused={rendererFocused}
              hostFocusTransitionOwner={hostFocusTransitionOwner ?? undefined}
              theme={theme()}
              palette={palette()}
              onOpenSurface={recoverHostFocus((surface, source) => {
                machineAgentNavigator?.cancel();
                if (surface === "home") startGeneration.cancel();
                paletteCommands.openSurface(surface, source);
              })}
              onOpenSession={recoverHostFocus((sessionName, source) => {
                machineAgentNavigator?.cancel();
                homeAgents?.cancel();
                void startGeneration(sessionName, false, source);
              })}
              onOpenAgent={recoverHostFocus((sessionName, paneId, source) => {
                machineAgentNavigator?.cancel();
                homeAgents?.cancel();
                void openAgent(sessionName, paneId, source);
              })}
              onSetPaletteOpen={recoverHostFocus(paletteCommands.setOpen)}
              onPaletteActivate={recoverHostFocus(paletteCommands.activate)}
              onZoomPane={recoverHostFocus((paneId) => {
                void interaction.zoomPane(paneId).then(setTransientNote);
              })}
              onCreateWindow={recoverHostFocus(() =>
                paletteCommands.activate("new-window", "mouse"),
              )}
              onCreateSession={
                machines.isLocal()
                  ? recoverHostFocus(() => void homeCatalog.createLocalSession())
                  : undefined
              }
              onCycleTheme={recoverHostFocus(appearance.openPicker)}
              onBeginPaneRename={recoverHostFocus(paneRename.begin)}
              onCancelPaneRename={recoverHostFocus(paneRename.cancel)}
              onSubmitPaneRename={recoverHostFocus(paneRename.submit)}
              onDismissNotification={recoverHostFocus(() => setTransientNote(null))}
              onSelectPane={recoverHostFocus((paneId, source) => {
                machineAgentNavigator?.cancel();
                interaction.selectPane(paneId, source);
              })}
              onResizePreview={recoverHostFocus(interaction.previewPaneResize)}
              onResizePane={recoverHostFocus(interaction.resizePane)}
              onResizePointerIngress={recoverHostFocus.optional(resizeIngress)}
              onWheelObservation={tuiPerfWheelObservation}
              onTerminalInput={recoverHostFocus((paneId, input) =>
                routeApplicationTerminalPointerInput(interaction, paneId, input),
              )}
              onOpenLink={recoverHostFocus(createTerminalLinkOpener(setTransientNote))}
              copyFeedback={selectionOwner.feedback()}
              onCopyText={selectionOwner.copy}
              onSelectionCopyOwner={selectionOwner.registerCopy}
              onSelectionKeyOwner={selectionOwner.registerKey}
              onWindowPresented={tuiPerfStream ? interaction.observeWindowPresentation : undefined}
              onInteraction={() => noteHostInteraction()}
            />
            <ApplicationAddMachineDialog
              open={machines.adding()}
              alias={machines.alias()}
              onAliasChange={machines.setAlias}
              onSubmit={machines.add}
              onCancel={machines.cancelAdd}
              error={machines.error()}
              width={dimensions().width}
              height={dimensions().height}
              theme={appearance.theme()}
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
