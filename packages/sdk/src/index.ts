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
  WorkspacePaneSendArgumentsSchemaZ,
  WorkspacePaneSendResultSchemaZ,
  createDaemonResourceMethods,
  type DaemonResourceKind,
  type DaemonResourceMethods,
  type DaemonResourceRequestFor,
  type DaemonResourceResult,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopDaemonHostSubscriptionResult,
  type HostCapabilities,
  type WorkspacePaneSendArguments,
  type WorkspacePaneSendResult,
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
 * The smallest host boundary accepted by the daemon-only SDK. TUI, browser,
 * Electron, and test drivers can all implement this without inventing desktop
 * window/theme capabilities that do not exist in their runtime.
 */
export interface TmuxIdeDaemonHost extends DaemonResourceMethods {
  subscribe: HostCapabilities["daemon"]["subscribe"];
}

/**
 * The same narrow surface consumed by the UI, augmented with an exhaustive
 * typed daemon request method. It remains structurally usable anywhere a
 * HostCapabilities value is expected.
 */
export interface TmuxIdeSdk extends Omit<HostCapabilities, "daemon"> {
  readonly daemon: TmuxIdeDaemonSdk;
}

export interface TmuxIdeOwnerSdkOptions {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface TmuxIdeOwnerSdk {
  /**
   * Privacy-safe semantic delivery; raw input is never returned or broadcast.
   * Supplying `sourceSemanticPaneId` creates a pane relationship only after
   * daemon authority verifies that source in the destination workspace.
   */
  sendPane(
    intent: Omit<WorkspacePaneSendArguments, "origin">,
    options?: { readonly operationId?: string },
  ): Promise<WorkspacePaneSendResult>;
}

function ownerOperationId(value?: string): string {
  if (value) return value;
  const randomUUID = globalThis.crypto?.randomUUID;
  if (!randomUUID) throw new Error("A crypto.randomUUID implementation is required");
  return randomUUID.call(globalThis.crypto);
}

/**
 * Build the explicit owner/automation SDK. Unlike renderer capability hosts,
 * this client may perform reviewed semantic mutations and therefore requires
 * the daemon's owner token. Retries retain one operation id so terminal input
 * can never be applied twice after a lost response.
 */
export function createTmuxIdeOwnerSdk(options: TmuxIdeOwnerSdkOptions): TmuxIdeOwnerSdk {
  const request = options.fetch ?? fetch;
  const baseUrl = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 2_000;
  return {
    async sendPane(intent, sendOptions = {}) {
      const input = WorkspacePaneSendArgumentsSchemaZ.parse({ ...intent, origin: "sdk" });
      const operationId = ownerOperationId(sendOptions.operationId);
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await request(new URL("api/v2/action/workspace.pane.send", baseUrl), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.ownerToken}`,
              "X-Tmux-Ide-Operation-Id": operationId,
            },
            body: JSON.stringify(input),
            signal: controller.signal,
          });
          const body = (await response.json()) as unknown;
          if (body && typeof body === "object" && "ok" in body) {
            if (body.ok === true && "result" in body) {
              return WorkspacePaneSendResultSchemaZ.parse(body.result);
            }
            if (body.ok === false && "error" in body) {
              const error = body.error as { code?: unknown; message?: unknown };
              throw new Error(
                `${typeof error.code === "string" ? `${error.code}: ` : ""}${
                  typeof error.message === "string" ? error.message : "Owner action failed"
                }`,
              );
            }
          }
          lastError = new Error("Daemon returned an invalid owner action response");
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(`Pane delivery ${operationId} was not confirmed`);
    },
  };
}

function assertDaemonHost(value: unknown): asserts value is TmuxIdeDaemonHost {
  if (!value || typeof value !== "object") {
    throw new TypeError("tmux-ide daemon capabilities must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const compatible =
    typeof candidate.subscribe === "function" &&
    DAEMON_RESOURCE_KINDS.every((resource) => typeof candidate[resource] === "function");

  if (!compatible) {
    throw new TypeError("tmux-ide daemon capabilities are incomplete");
  }
}

function assertHostCapabilities(value: unknown): asserts value is HostCapabilities {
  if (!value || typeof value !== "object") {
    throw new TypeError("tmux-ide host capabilities must be an object");
  }

  const candidate = value as Partial<HostCapabilities>;
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
    typeof candidate.update?.onStatusChanged === "function";

  if (!compatible) {
    throw new TypeError(
      `tmux-ide host capabilities are incompatible with API ${DESKTOP_HOST_API_VERSION}`,
    );
  }
  assertDaemonHost(candidate.daemon);
}

/**
 * Build the portable daemon SDK over any reviewed host adapter. This is the
 * canonical boundary for non-desktop consumers such as OpenTUI and automation.
 */
export function createTmuxIdeDaemonSdk(candidate: unknown): TmuxIdeDaemonSdk {
  assertDaemonHost(candidate);
  const host = candidate;

  const invokeHost = async (input: unknown): Promise<unknown> => {
    const request = DaemonResourceRequestSchemaZ.parse(input);
    const method = host[request.resource] as (request?: unknown) => Promise<unknown>;
    return "request" in request ? method.call(host, request.request) : method.call(host);
  };

  const dispatch = async (input: unknown): Promise<unknown> => {
    const request = DaemonResourceRequestSchemaZ.parse(input);
    const raw = await invokeHost(request);
    return DAEMON_RESOURCE_RESULT_SCHEMAS[request.resource].parse(raw);
  };

  const namedMethods = createDaemonResourceMethods(invokeHost);
  return {
    ...namedMethods,
    resources: DAEMON_RESOURCE_KINDS,
    request: async <K extends DaemonResourceKind>(request: DaemonResourceRequestFor<K>) =>
      (await dispatch(request)) as DaemonResourceResult<K>,
    subscribe: async (request, listener) => {
      const parsedRequest = DesktopDaemonEventSubscriptionRequestSchemaZ.parse(request);
      const result = await host.subscribe(parsedRequest, (event) => {
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
}

/** Build the validated public SDK over an Electron, browser-dev, or test host. */
export function createTmuxIdeSdk(candidate: unknown): TmuxIdeSdk {
  assertHostCapabilities(candidate);
  const host = candidate;
  const daemon = createTmuxIdeDaemonSdk(host.daemon);

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
