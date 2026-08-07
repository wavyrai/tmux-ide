import {
  DAEMON_RESOURCE_KINDS,
  DAEMON_RESOURCE_RESULT_SCHEMAS,
  DESKTOP_HOST_API_VERSION,
  DaemonResourceRequestSchemaZ,
  DesktopDaemonCapabilityErrorSchemaZ,
  DesktopDaemonEventSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopHostBootstrapSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopUpdateStatusSchemaZ,
  DesktopWindowStateSchemaZ,
  WorkspaceOpenHostResultSchemaZ,
  createDaemonResourceMethods,
  type DaemonResourceKind,
  type DaemonResourceMethods,
  type DaemonResourceRequestFor,
  type DaemonResourceResult,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopDaemonHostSubscriptionResult,
  type HostCapabilities,
} from "@tmux-ide/contracts";

export type * from "@tmux-ide/contracts";

export interface TmuxIdeDaemonSdk extends DaemonResourceMethods {
  /** The complete closed capability vocabulary, useful for exhaustive test drivers. */
  readonly resources: readonly DaemonResourceKind[];

  /**
   * Invoke one reviewed daemon capability through a single typed entry point.
   * The request and response are validated against the shared contract.
   */
  request<K extends DaemonResourceKind>(
    request: DaemonResourceRequestFor<K>,
  ): Promise<DaemonResourceResult<K>>;

  subscribe(
    request: DesktopDaemonEventSubscriptionRequest,
    listener: (event: DesktopDaemonEvent) => void,
  ): Promise<DesktopDaemonHostSubscriptionResult>;
}

/**
 * The same narrow surface consumed by the UI, augmented with an exhaustive
 * typed daemon request method. It remains structurally usable anywhere a
 * HostCapabilities value is expected.
 */
export interface TmuxIdeSdk extends Omit<HostCapabilities, "daemon"> {
  readonly daemon: TmuxIdeDaemonSdk;
}

function assertHostCapabilities(value: unknown): asserts value is HostCapabilities {
  if (!value || typeof value !== "object") {
    throw new TypeError("tmux-ide host capabilities must be an object");
  }

  const candidate = value as Partial<HostCapabilities>;
  const daemon = candidate.daemon as Record<string, unknown> | undefined;
  const compatible =
    candidate.apiVersion === DESKTOP_HOST_API_VERSION &&
    typeof candidate.bootstrap === "function" &&
    typeof candidate.window?.minimize === "function" &&
    typeof candidate.window?.toggleMaximized === "function" &&
    typeof candidate.window?.close === "function" &&
    typeof candidate.window?.onStateChanged === "function" &&
    typeof candidate.workspace?.openProjectDirectory === "function" &&
    typeof candidate.onboarding?.acknowledgeIntro === "function" &&
    typeof candidate.theme?.onChanged === "function" &&
    typeof candidate.update?.getStatus === "function" &&
    typeof candidate.update?.onStatusChanged === "function" &&
    typeof candidate.daemon?.subscribe === "function" &&
    DAEMON_RESOURCE_KINDS.every((resource) => typeof daemon?.[resource] === "function");

  if (!compatible) {
    throw new TypeError(
      `tmux-ide host capabilities are incompatible with API ${DESKTOP_HOST_API_VERSION}`,
    );
  }
}

/** Build the validated public SDK over an Electron, browser-dev, or test host. */
export function createTmuxIdeSdk(candidate: unknown): TmuxIdeSdk {
  assertHostCapabilities(candidate);
  const host = candidate;

  const invokeHost = async (input: unknown): Promise<unknown> => {
    const request = DaemonResourceRequestSchemaZ.parse(input);
    const method = host.daemon[request.resource] as (request?: unknown) => Promise<unknown>;
    return "request" in request
      ? method.call(host.daemon, request.request)
      : method.call(host.daemon);
  };

  const dispatch = async (input: unknown): Promise<unknown> => {
    const request = DaemonResourceRequestSchemaZ.parse(input);
    const raw = await invokeHost(request);
    return DAEMON_RESOURCE_RESULT_SCHEMAS[request.resource].parse(raw);
  };

  // Named methods validate their request but intentionally leave semantic
  // response projection to the consuming surface. The GUI, for example, must
  // distinguish an incoherent workspace update from a transport failure. The
  // generic `request` method below is the strict request+response SDK path for
  // automation and integration tests.
  const namedMethods = createDaemonResourceMethods(invokeHost);
  const daemon: TmuxIdeDaemonSdk = {
    ...namedMethods,
    resources: DAEMON_RESOURCE_KINDS,
    request: async <K extends DaemonResourceKind>(request: DaemonResourceRequestFor<K>) =>
      (await dispatch(request)) as DaemonResourceResult<K>,
    subscribe: async (request, listener) => {
      const parsedRequest = DesktopDaemonEventSubscriptionRequestSchemaZ.parse(request);
      const result = await host.daemon.subscribe(parsedRequest, (event) => {
        listener(DesktopDaemonEventSchemaZ.parse(event));
      });
      if (result.status === "subscribed") {
        if (typeof result.unsubscribe !== "function") {
          throw new TypeError("tmux-ide subscription did not provide an unsubscribe function");
        }
        return result;
      }
      return {
        status: "error",
        error: DesktopDaemonCapabilityErrorSchemaZ.parse(result.error),
      };
    },
  };

  return {
    apiVersion: host.apiVersion,
    bootstrap: async () => DesktopHostBootstrapSchemaZ.parse(await host.bootstrap()),
    window: {
      minimize: async () => DesktopWindowStateSchemaZ.parse(await host.window.minimize()),
      toggleMaximized: async () =>
        DesktopWindowStateSchemaZ.parse(await host.window.toggleMaximized()),
      close: () => host.window.close(),
      onStateChanged: (listener) =>
        host.window.onStateChanged((state) => listener(DesktopWindowStateSchemaZ.parse(state))),
    },
    workspace: {
      openProjectDirectory: async () => {
        const result = await host.workspace.openProjectDirectory();
        return result === null ? null : WorkspaceOpenHostResultSchemaZ.parse(result);
      },
    },
    onboarding: {
      acknowledgeIntro: () => host.onboarding.acknowledgeIntro(),
    },
    theme: {
      onChanged: (listener) =>
        host.theme.onChanged((state) => listener(DesktopThemeStateSchemaZ.parse(state))),
    },
    update: {
      getStatus: async () => DesktopUpdateStatusSchemaZ.parse(await host.update.getStatus()),
      onStatusChanged: (listener) =>
        host.update.onStatusChanged((status) => listener(DesktopUpdateStatusSchemaZ.parse(status))),
    },
    daemon,
  };
}
