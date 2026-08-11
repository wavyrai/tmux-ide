import { contextBridge, ipcRenderer } from "electron";
import {
  DAEMON_RESOURCE_RESULT_SCHEMAS,
  DESKTOP_HOST_API_VERSION,
  DaemonResourceRequestSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonEventWireEnvelopeSchemaZ,
  DesktopDaemonSubscriptionRequestIdSchemaZ,
  DesktopDaemonSubscribeWireResultSchemaZ,
  DesktopHostBootstrapSchemaZ,
  DesktopThemeStateSchemaZ,
  DesktopUpdateStatusSchemaZ,
  DesktopWindowStateSchemaZ,
  WorkspaceOpenHostResultSchemaZ,
  createDaemonResourceMethods,
  type DaemonResourceRequest,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type DesktopThemeState,
  type DesktopUpdateStatus,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { HOST_IPC } from "./ipc-channels.ts";

const daemonListeners = new Map<string, (event: DesktopDaemonEvent) => void>();
const earlyDaemonEvents = new Map<string, DesktopDaemonEvent[]>();

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
  // The socket can open while the subscribe invoke response is in flight.
  // Keep only a tiny bounded handoff buffer for that single IPC race.
  if (earlyDaemonEvents.size >= 64 && !earlyDaemonEvents.has(envelope.subscriptionId)) return;
  const queued = earlyDaemonEvents.get(envelope.subscriptionId) ?? [];
  if (queued.length < 8) queued.push(envelope.event);
  earlyDaemonEvents.set(envelope.subscriptionId, queued);
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
async function requestDaemonResource(request: DaemonResourceRequest): Promise<unknown> {
  const parsed = DaemonResourceRequestSchemaZ.parse(request);
  const result = await ipcRenderer.invoke(HOST_IPC.daemonRequest, parsed);
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
      const cancel = () => {
        void ipcRenderer.invoke(HOST_IPC.daemonCancelSubscribe, requestId).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let result: ReturnType<typeof DesktopDaemonSubscribeWireResultSchemaZ.parse>;
      try {
        result = DesktopDaemonSubscribeWireResultSchemaZ.parse(
          await ipcRenderer.invoke(HOST_IPC.daemonSubscribe, parsed, requestId),
        );
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      if (result.status === "error") return result;
      if (signal?.aborted) {
        void ipcRenderer
          .invoke(HOST_IPC.daemonUnsubscribe, result.subscriptionId)
          .catch(() => undefined);
        return {
          status: "error" as const,
          error: { code: "disposed" as const, reason: "The daemon subscription was cancelled." },
        };
      }
      daemonListeners.set(result.subscriptionId, listener);
      for (const event of earlyDaemonEvents.get(result.subscriptionId) ?? []) {
        deliverDaemonEvent(listener, event);
      }
      earlyDaemonEvents.delete(result.subscriptionId);
      let active = true;
      return {
        status: "subscribed" as const,
        unsubscribe: () => {
          if (!active) return;
          active = false;
          daemonListeners.delete(result.subscriptionId);
          earlyDaemonEvents.delete(result.subscriptionId);
          void ipcRenderer.invoke(HOST_IPC.daemonUnsubscribe, result.subscriptionId).catch(() => {
            // Main also clears subscriptions when the renderer/window is released.
          });
        },
      };
    },
  }),
});

contextBridge.exposeInMainWorld("tmuxIdeHost", capabilities);
