import { contextBridge, ipcRenderer } from "electron";
import {
  DAEMON_RESOURCE_RESULT_SCHEMAS,
  DESKTOP_HOST_API_VERSION,
  DaemonResourceRequestSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonEventWireEnvelopeSchemaZ,
  DesktopDaemonRequestIdSchemaZ,
  DesktopDaemonSubscriptionRequestIdSchemaZ,
  DesktopDaemonSubscribeWireResultSchemaZ,
  DesktopHostBootstrapSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopUpdateStatusSchemaZ,
  DesktopWindowStateSchemaZ,
  WorkspaceOpenHostResultSchemaZ,
  WorkspaceOpenPreparedHostResultSchemaZ,
  WorkspaceOpenCommittedHostResultSchemaZ,
  WorkspaceOpenCancelledHostResultSchemaZ,
  WorkspaceOpenDecisionArgumentsSchemaZ,
  createDaemonResourceMethods,
  isCancellableDaemonResourceKind,
  type DaemonResourceRequest,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopThemeState,
  type DesktopUpdateStatus,
  type DesktopWindowState,
  type HostCapabilities,
  type WorkspaceOpenDecisionArguments,
} from "@tmux-ide/contracts";

import { HOST_IPC } from "./ipc-channels.ts";

const daemonListeners = new Map<string, (event: DesktopDaemonEvent) => void>();
type PendingDaemonSubscription = {
  readonly events: DesktopDaemonEvent[];
  subscriptionId: string | null;
};
const pendingDaemonSubscriptions = new Map<string, PendingDaemonSubscription>();

function deliverDaemonEvent(
  listener: (event: DesktopDaemonEvent) => void,
  event: DesktopDaemonEvent,
): void {
  try {
    listener(event);
  } catch {
    // One application listener cannot break the preload event bridge.
  }
}

ipcRenderer.on(HOST_IPC.daemonEvent, (_event, value: unknown) => {
  const envelope = DesktopDaemonEventWireEnvelopeSchemaZ.parse(value);
  const listener = daemonListeners.get(envelope.subscriptionId);
  if (listener) {
    deliverDaemonEvent(listener, envelope.event);
    return;
  }
  // Main names the exact invoke attempt that owns an early event. Unknown or
  // retired attempts are dropped, so failed churn cannot consume handoff
  // capacity belonging to a concurrent successful subscription.
  const pending = pendingDaemonSubscriptions.get(envelope.subscriptionRequestId);
  if (!pending) return;
  if (pending.subscriptionId !== null && pending.subscriptionId !== envelope.subscriptionId) return;
  pending.subscriptionId = envelope.subscriptionId;
  if (pending.events.length < 8) pending.events.push(envelope.event);
});

function onValidatedEvent<T>(
  channel: string,
  parse: (value: unknown) => T,
  listener: (value: T) => void,
): () => void {
  const receive = (_event: Electron.IpcRendererEvent, value: unknown) => listener(parse(value));
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

/**
 * The single daemon hop. Both directions are validated here — the request
 * against the union before it leaves the renderer process, the answer against
 * the schema its own variant declares — so a malformed request never reaches
 * main and a malformed answer never reaches application code.
 */
async function requestDaemonResource(
  request: DaemonResourceRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const parsed = DaemonResourceRequestSchemaZ.parse(request);
  const cancellable = isCancellableDaemonResourceKind(parsed.resource);
  if (cancellable && signal?.aborted)
    throw Object.assign(new Error("Daemon resource read was cancelled."), { name: "AbortError" });
  const requestId = DesktopDaemonRequestIdSchemaZ.parse(crypto.randomUUID());
  const cancel = () => {
    void ipcRenderer.invoke(HOST_IPC.daemonCancelRequest, requestId).catch(() => undefined);
  };
  if (cancellable) signal?.addEventListener("abort", cancel, { once: true });
  let result: unknown;
  try {
    result = await ipcRenderer.invoke(HOST_IPC.daemonRequest, parsed, requestId);
  } finally {
    if (cancellable) signal?.removeEventListener("abort", cancel);
  }
  if (cancellable && signal?.aborted)
    throw Object.assign(new Error("Daemon resource read was cancelled."), { name: "AbortError" });
  return DAEMON_RESOURCE_RESULT_SCHEMAS[parsed.resource].parse(result);
}

const capabilities: HostCapabilities = Object.freeze({
  apiVersion: DESKTOP_HOST_API_VERSION,
  bootstrap: async () =>
    DesktopHostBootstrapSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.bootstrap)),
  window: Object.freeze({
    minimize: async () =>
      DesktopWindowStateSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.windowMinimize)),
    toggleMaximized: async () =>
      DesktopWindowStateSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.windowToggleMaximized)),
    close: async () => {
      await ipcRenderer.invoke(HOST_IPC.windowClose);
    },
    onStateChanged: (listener: (state: DesktopWindowState) => void) =>
      onValidatedEvent(
        HOST_IPC.windowStateChanged,
        (value) => DesktopWindowStateSchemaZ.parse(value),
        listener,
      ),
  }),
  workspace: Object.freeze({
    openProjectDirectory: async () =>
      WorkspaceOpenHostResultSchemaZ.nullable().parse(
        await ipcRenderer.invoke(HOST_IPC.workspaceOpenProjectDirectory),
      ),
    prepareProjectDirectory: async (previousWorkspaceName?: string | null) =>
      WorkspaceOpenPreparedHostResultSchemaZ.nullable().parse(
        await ipcRenderer.invoke(
          HOST_IPC.workspacePrepareProjectDirectory,
          previousWorkspaceName ?? null,
        ),
      ),
    commitPreparedOpen: async (decision: WorkspaceOpenDecisionArguments) =>
      WorkspaceOpenCommittedHostResultSchemaZ.parse(
        await ipcRenderer.invoke(
          HOST_IPC.workspaceCommitPreparedOpen,
          WorkspaceOpenDecisionArgumentsSchemaZ.parse(decision),
        ),
      ),
    cancelPreparedOpen: async (decision: WorkspaceOpenDecisionArguments) =>
      WorkspaceOpenCancelledHostResultSchemaZ.parse(
        await ipcRenderer.invoke(
          HOST_IPC.workspaceCancelPreparedOpen,
          WorkspaceOpenDecisionArgumentsSchemaZ.parse(decision),
        ),
      ),
  }),
  onboarding: Object.freeze({
    acknowledgeIntro: async () => {
      await ipcRenderer.invoke(HOST_IPC.onboardingAcknowledgeIntro);
    },
  }),
  theme: Object.freeze({
    onChanged: (listener: (state: DesktopThemeState) => void) =>
      onValidatedEvent(
        HOST_IPC.themeChanged,
        (value) => DesktopThemeStateSchemaZ.parse(value),
        listener,
      ),
  }),
  update: Object.freeze({
    getStatus: async () =>
      DesktopUpdateStatusSchemaZ.parse(await ipcRenderer.invoke(HOST_IPC.updateGetStatus)),
    onStatusChanged: (listener: (status: DesktopUpdateStatus) => void) =>
      onValidatedEvent(
        HOST_IPC.updateStatusChanged,
        (value) => DesktopUpdateStatusSchemaZ.parse(value),
        listener,
      ),
  }),
  daemon: Object.freeze({
    ...createDaemonResourceMethods(requestDaemonResource),
    subscribe: async (
      request: DesktopDaemonEventSubscriptionRequest,
      listener: (event: DesktopDaemonEvent) => void,
      signal?: AbortSignal,
    ) => {
      const parsed = DesktopDaemonEventSubscriptionRequestSchemaZ.parse(request);
      if (signal?.aborted) {
        return {
          status: "error" as const,
          error: { code: "disposed" as const, reason: "The daemon subscription was cancelled." },
        };
      }
      const requestId = DesktopDaemonSubscriptionRequestIdSchemaZ.parse(crypto.randomUUID());
      const pending: PendingDaemonSubscription = { events: [], subscriptionId: null };
      pendingDaemonSubscriptions.set(requestId, pending);
      const cancel = () => {
        pendingDaemonSubscriptions.delete(requestId);
        void ipcRenderer.invoke(HOST_IPC.daemonCancelSubscribe, requestId).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let result: ReturnType<typeof DesktopDaemonSubscribeWireResultSchemaZ.parse>;
      try {
        result = DesktopDaemonSubscribeWireResultSchemaZ.parse(
          await ipcRenderer.invoke(HOST_IPC.daemonSubscribe, parsed, requestId),
        );
      } catch (error) {
        pendingDaemonSubscriptions.delete(requestId);
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      if (result.status === "error") {
        pendingDaemonSubscriptions.delete(requestId);
        return result;
      }
      if (signal?.aborted) {
        pendingDaemonSubscriptions.delete(requestId);
        void ipcRenderer
          .invoke(HOST_IPC.daemonUnsubscribe, result.subscriptionId)
          .catch(() => undefined);
        return {
          status: "error" as const,
          error: { code: "disposed" as const, reason: "The daemon subscription was cancelled." },
        };
      }
      if (pending.subscriptionId !== null && pending.subscriptionId !== result.subscriptionId) {
        pendingDaemonSubscriptions.delete(requestId);
        void ipcRenderer
          .invoke(HOST_IPC.daemonUnsubscribe, result.subscriptionId)
          .catch(() => undefined);
        return {
          status: "error" as const,
          error: {
            code: "event-unavailable" as const,
            reason: "The daemon subscription handoff did not match its invoke attempt.",
          },
        };
      }
      daemonListeners.set(result.subscriptionId, listener);
      for (const event of pending.events) {
        deliverDaemonEvent(listener, event);
      }
      pendingDaemonSubscriptions.delete(requestId);
      let active = true;
      return {
        status: "subscribed" as const,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          daemonListeners.delete(result.subscriptionId);
          void ipcRenderer.invoke(HOST_IPC.daemonUnsubscribe, result.subscriptionId).catch(() => {
            // Main also clears subscriptions when the renderer/window is released.
          });
        },
      };
    },
  }),
});

contextBridge.exposeInMainWorld("tmuxIdeHost", capabilities);
