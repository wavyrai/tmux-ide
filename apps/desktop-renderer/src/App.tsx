import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
  ApplicationShellCommandInvocation,
  ApplicationShellProjectionInputV1,
  DesktopHostBootstrap,
  DesktopThemeState,
  DesktopWindowState,
  HostCapabilities,
} from "@tmux-ide/contracts";
import { DesktopDaemonRefreshConnectionResultSchemaZ } from "@tmux-ide/contracts";

import {
  parseThemeState,
  parseWindowState,
  readHostBootstrap,
  readInitialThemeState,
  resolveHostCapabilities,
} from "./host-capabilities.ts";
import { DomApplicationShell, createDomExperience } from "./experience/index.ts";
import {
  DesktopConnectionSurface,
  DesktopLiveApplication,
  type DesktopDaemonRecoveryPhase,
} from "./runtime/live-app-composition.tsx";
import type { NativeTerminalTransport } from "./terminal/native-terminal-transport.ts";
import type {
  PaneFrameActionIntent,
  PaneFrameActivationSource,
  PaneFrameGripIntent,
  PaneFrameModel,
} from "../../../packages/daemon/src/ui/pane-frame/presenter.tsx";

export interface AppProps {
  readonly host?: HostCapabilities;
  readonly initialTheme?: DesktopThemeState;
  readonly shellInput?: ApplicationShellProjectionInputV1;
  readonly onCommand?: (invocation: ApplicationShellCommandInvocation) => void;
  readonly paneFrames?: readonly PaneFrameModel[];
  readonly terminalTransport?: NativeTerminalTransport | null;
  readonly onPaneAction?: (
    intent: PaneFrameActionIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly onPaneGrip?: (intent: PaneFrameGripIntent, source: PaneFrameActivationSource) => void;
}

function daemonCapabilityReason(value: DesktopHostBootstrap["daemon"]): string {
  return value.status === "connected" ? "The daemon connection changed." : value.reason;
}

export function App(props: AppProps = {}) {
  const browserPreview =
    props.host === undefined && (typeof window === "undefined" || window.tmuxIdeHost === undefined);
  let host: HostCapabilities | null = null;
  let hostResolutionError = false;
  try {
    host = resolveHostCapabilities(props.host);
  } catch {
    hostResolutionError = true;
  }
  const initialTheme = props.initialTheme ?? readInitialThemeState();
  const [bootstrap, setBootstrap] = createSignal<DesktopHostBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = createSignal(false);
  const [daemonRecovery, setDaemonRecovery] = createSignal<DesktopDaemonRecoveryPhase>("idle");
  const [theme, setTheme] = createSignal<DesktopThemeState | null>(null);
  const [windowState, setWindowState] = createSignal<DesktopWindowState | null>(null);
  let bootstrapRequest = 0;
  let daemonRefreshFlight: Promise<void> | null = null;
  let disposed = false;

  const loadBootstrap = (): void => {
    if (!host || disposed) return;
    const request = ++bootstrapRequest;
    setBootstrapError(false);
    void readHostBootstrap(host)
      .then((next) => {
        if (disposed || request !== bootstrapRequest) return;
        setBootstrap(next);
      })
      .catch(() => {
        if (disposed || request !== bootstrapRequest) return;
        setBootstrap(null);
        setBootstrapError(true);
      });
  };

  const refreshDaemonConnection = (): void => {
    if (!host || disposed || !bootstrap() || daemonRefreshFlight) return;
    setDaemonRecovery("refreshing");
    const operation = host.daemon
      .refreshConnection()
      .then((rawResult) => DesktopDaemonRefreshConnectionResultSchemaZ.parse(rawResult))
      .then((result) => {
        if (disposed || daemonRefreshFlight !== operation) return;
        const previousDaemon = bootstrap()?.daemon ?? null;
        setBootstrap((current) => (current ? { ...current, daemon: result.daemon } : current));
        const identityChanged =
          previousDaemon?.status === "connected" &&
          result.daemon.status === "connected" &&
          (previousDaemon.identity.instanceId !== result.daemon.identity.instanceId ||
            previousDaemon.identity.startedAt !== result.daemon.identity.startedAt ||
            previousDaemon.identity.protocolVersion !== result.daemon.identity.protocolVersion ||
            previousDaemon.identity.productVersion !== result.daemon.identity.productVersion);
        if (
          result.outcome === "generation-replaced" ||
          result.outcome === "authority-retired" ||
          result.outcome === "state-changed" ||
          identityChanged ||
          result.daemon.status !== "connected"
        ) {
          setDaemonRecovery("idle");
          return;
        }
        setDaemonRecovery(result.outcome === "superseded" ? "superseded" : "unchanged");
      })
      .catch(() => {
        if (!disposed && daemonRefreshFlight === operation) setDaemonRecovery("failed");
      })
      .finally(() => {
        if (daemonRefreshFlight === operation) daemonRefreshFlight = null;
      });
    daemonRefreshFlight = operation;
  };

  onMount(() => {
    if (!host) return;
    loadBootstrap();
    const stopTheme = host.theme.onChanged((next) => setTheme(parseThemeState(next)));
    const stopWindow = host.window.onStateChanged((next) => setWindowState(parseWindowState(next)));
    onCleanup(() => {
      stopTheme();
      stopWindow();
      disposed = true;
      bootstrapRequest += 1;
      daemonRefreshFlight = null;
    });
  });

  const effectiveTheme = () => theme() ?? bootstrap()?.theme ?? initialTheme;
  const effectiveWindow = () => windowState() ?? bootstrap()?.window ?? null;
  const experience = createMemo(() => createDomExperience({ hostTheme: effectiveTheme() }));
  const terminalThemeKey = createMemo(() => {
    const current = effectiveTheme();
    return `${current?.mode ?? "system"}:${current?.highContrast ?? false}`;
  });

  return (
    <div
      class="app"
      data-theme={experience().appearance}
      data-platform={bootstrap()?.platform}
      data-reduced-motion={String(experience().accessibility.reducedMotion)}
      data-increased-contrast={String(experience().accessibility.increasedContrast)}
      data-accessibility-conflicts={experience().accessibility.conflicts.join(" ") || undefined}
      data-shell-source={
        hostResolutionError
          ? "hard-error"
          : props.shellInput !== undefined
            ? "injected"
            : browserPreview
              ? "preview"
              : "runtime"
      }
      style={experience().variables}
    >
      <Show
        when={!hostResolutionError && host}
        fallback={
          <DesktopConnectionSurface
            state="hard-error"
            eyebrow="Desktop host boundary"
            title="The desktop bridge is incompatible"
            description="tmux-ide stopped before loading preview or live workspace data."
            guidance="Update the desktop host and reopen tmux-ide"
            alert
          />
        }
      >
        {(activeHost) => (
          <Show
            when={props.shellInput}
            fallback={
              <Show
                when={!browserPreview}
                fallback={
                  <DomApplicationShell
                    host={activeHost()}
                    daemonState={bootstrap()?.daemon}
                    runtime={bootstrap()?.runtime}
                    platform={bootstrap()?.platform}
                    windowState={effectiveWindow()}
                    dataMode="preview"
                    terminalTransport={props.terminalTransport}
                    reducedMotion={experience().accessibility.reducedMotion}
                    terminalThemeKey={terminalThemeKey()}
                    onCommand={props.onCommand}
                    paneFrames={props.paneFrames}
                    onPaneAction={props.onPaneAction}
                    onPaneGrip={props.onPaneGrip}
                  />
                }
              >
                <Show
                  when={!bootstrapError()}
                  fallback={
                    <DesktopConnectionSurface
                      host={activeHost()}
                      runtime="electron"
                      windowState={effectiveWindow()}
                      state="hard-error"
                      eyebrow="Desktop host boundary"
                      title="The desktop host could not be verified"
                      description="tmux-ide rejected the host bootstrap response."
                      guidance="Reopen tmux-ide after updating the desktop host"
                      alert
                      onRetry={loadBootstrap}
                    />
                  }
                >
                  <Show
                    when={bootstrap()}
                    fallback={
                      <DesktopConnectionSurface
                        host={activeHost()}
                        state="pending"
                        eyebrow="Native tmux workspace"
                        title="Connecting to tmux-ide"
                        description="Verifying the desktop host and daemon generation."
                        guidance="No preview data is substituted"
                      />
                    }
                  >
                    {(ready) => (
                      <Show
                        when={ready().daemon.status === "connected"}
                        fallback={
                          <DesktopConnectionSurface
                            host={activeHost()}
                            runtime={ready().runtime}
                            platform={ready().platform}
                            windowState={effectiveWindow()}
                            state="degraded"
                            eyebrow="Native tmux workspace"
                            title="The daemon is unavailable"
                            description={daemonCapabilityReason(ready().daemon)}
                            guidance="Start tmux-ide and try again"
                            onRetry={refreshDaemonConnection}
                          />
                        }
                      >
                        <DesktopLiveApplication
                          host={activeHost()}
                          daemon={ready().daemon}
                          runtime={ready().runtime}
                          platform={ready().platform}
                          windowState={effectiveWindow()}
                          daemonRecovery={daemonRecovery()}
                          terminalTransport={props.terminalTransport}
                          reducedMotion={experience().accessibility.reducedMotion}
                          terminalThemeKey={terminalThemeKey()}
                          onRetryDaemonConnection={refreshDaemonConnection}
                          onDaemonIdentityMismatch={refreshDaemonConnection}
                          onCommand={props.onCommand}
                          onPaneAction={props.onPaneAction}
                          onPaneGrip={props.onPaneGrip}
                        />
                      </Show>
                    )}
                  </Show>
                </Show>
              </Show>
            }
          >
            {(injectedInput) => (
              <DomApplicationShell
                host={activeHost()}
                daemonState={bootstrap()?.daemon}
                runtime={bootstrap()?.runtime}
                platform={bootstrap()?.platform}
                windowState={effectiveWindow()}
                input={injectedInput()}
                dataMode="runtime"
                terminalTransport={props.terminalTransport}
                reducedMotion={experience().accessibility.reducedMotion}
                terminalThemeKey={terminalThemeKey()}
                onCommand={props.onCommand}
                paneFrames={props.paneFrames}
                onPaneAction={props.onPaneAction}
                onPaneGrip={props.onPaneGrip}
              />
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}
