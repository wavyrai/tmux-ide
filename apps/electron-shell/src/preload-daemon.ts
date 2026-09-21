import {
  DAEMON_RESOURCE_RESULT_SCHEMAS,
  DaemonResourceRequestSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonEventWireEnvelopeSchemaZ,
  DesktopDaemonRequestIdSchemaZ,
  DesktopDaemonSubscriptionRequestIdSchemaZ,
  DesktopDaemonSubscribeWireResultSchemaZ,
  createDaemonResourceMethods,
  isCancellableDaemonResourceKind,
  type DaemonResourceRequest,
  type DesktopDaemonEvent,
  type DesktopDaemonEventSubscriptionRequest,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { HOST_IPC, scopedHostChannel } from "./ipc-channels.ts";

export interface PreloadDaemonIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}

/** contextBridge can copy AbortSignal as a plain object without its prototype.
 * Such a copy cannot carry subsequent abort events. Scope disposal still owns
 * cancellation; never invoke missing methods while retiring that scope. */
function usableSignal(signal?: AbortSignal): AbortSignal | undefined {
  if (!signal) return undefined;
  if (typeof (signal as unknown as { subscribeAbort?: unknown }).subscribeAbort === "function")
    return signal;
  if (
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function"
  )
    return signal;
  return signal.aborted === true ? AbortSignal.abort() : undefined;
}

function observeAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
  const subscribe = (
    signal as unknown as { subscribeAbort?: (callback: () => void) => () => void } | undefined
  )?.subscribeAbort;
  if (subscribe) {
    const cleanup = subscribe(callback);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        cleanup();
      } catch {
        /* A retired renderer proxy cannot block scope cleanup. */
      }
    };
  }
  signal?.addEventListener("abort", callback, { once: true });
  return () => signal?.removeEventListener("abort", callback);
}

/** Isolated maps for one main-minted authority-generation scope; null is local. */
export function createPreloadDaemonBridge(ipc: PreloadDaemonIpc, scope: string | null = null) {
  const channels = {
    daemonRequest: scopedHostChannel(scope, HOST_IPC.daemonRequest),
    daemonCancelRequest: scopedHostChannel(scope, HOST_IPC.daemonCancelRequest),
    daemonSubscribe: scopedHostChannel(scope, HOST_IPC.daemonSubscribe),
    daemonCancelSubscribe: scopedHostChannel(scope, HOST_IPC.daemonCancelSubscribe),
    daemonUnsubscribe: scopedHostChannel(scope, HOST_IPC.daemonUnsubscribe),
    daemonEvent: scopedHostChannel(scope, HOST_IPC.daemonEvent),
  };
  let disposed = false;
  const pendingCancels = new Set<() => void>();
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

  const receive = (_event: unknown, value: unknown) => {
    if (disposed) return;
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
    if (pending.subscriptionId !== null && pending.subscriptionId !== envelope.subscriptionId)
      return;
    pending.subscriptionId = envelope.subscriptionId;
    if (pending.events.length < 8) pending.events.push(envelope.event);
  };
  ipc.on(channels.daemonEvent, receive);

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
    signal = usableSignal(signal);
    const parsed = DaemonResourceRequestSchemaZ.parse(request);
    const cancellable = isCancellableDaemonResourceKind(parsed.resource);
    if (disposed || (cancellable && signal?.aborted))
      throw Object.assign(new Error("Daemon resource read was cancelled."), { name: "AbortError" });
    const requestId = DesktopDaemonRequestIdSchemaZ.parse(crypto.randomUUID());
    let cancelled = false;
    let stopAbort = () => {};
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      stopAbort();
      void ipc.invoke(channels.daemonCancelRequest, requestId).catch(() => undefined);
    };
    if (cancellable) {
      pendingCancels.add(cancel);
    }
    let result: unknown;
    try {
      if (cancellable) stopAbort = observeAbort(signal, cancel);
      result = await ipc.invoke(channels.daemonRequest, parsed, requestId);
    } finally {
      pendingCancels.delete(cancel);
      if (cancellable) stopAbort();
    }
    if (cancellable && (disposed || cancelled || signal?.aborted))
      throw Object.assign(new Error("Daemon resource read was cancelled."), { name: "AbortError" });
    return DAEMON_RESOURCE_RESULT_SCHEMAS[parsed.resource].parse(result);
  }

  const daemon: HostCapabilities["daemon"] = Object.freeze({
    ...createDaemonResourceMethods(requestDaemonResource),
    subscribe: async (
      request: DesktopDaemonEventSubscriptionRequest,
      listener: (event: DesktopDaemonEvent) => void,
      signal?: AbortSignal,
    ) => {
      signal = usableSignal(signal);
      const parsed = DesktopDaemonEventSubscriptionRequestSchemaZ.parse(request);
      if (disposed || signal?.aborted) {
        return {
          status: "error" as const,
          error: { code: "disposed" as const, reason: "The daemon subscription was cancelled." },
        };
      }
      const requestId = DesktopDaemonSubscriptionRequestIdSchemaZ.parse(crypto.randomUUID());
      const pending: PendingDaemonSubscription = { events: [], subscriptionId: null };
      pendingDaemonSubscriptions.set(requestId, pending);
      let cancelled = false;
      let stopAbort = () => {};
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        stopAbort();
        pendingDaemonSubscriptions.delete(requestId);
        void ipc.invoke(channels.daemonCancelSubscribe, requestId).catch(() => undefined);
      };
      pendingCancels.add(cancel);
      let result: ReturnType<typeof DesktopDaemonSubscribeWireResultSchemaZ.parse>;
      try {
        stopAbort = observeAbort(signal, cancel);
        result = DesktopDaemonSubscribeWireResultSchemaZ.parse(
          await ipc.invoke(channels.daemonSubscribe, parsed, requestId),
        );
      } catch (error) {
        pendingDaemonSubscriptions.delete(requestId);
        throw error;
      } finally {
        pendingCancels.delete(cancel);
        stopAbort();
      }
      if (result.status === "error") {
        pendingDaemonSubscriptions.delete(requestId);
        return result;
      }
      if (disposed || cancelled || signal?.aborted) {
        pendingDaemonSubscriptions.delete(requestId);
        void ipc.invoke(channels.daemonUnsubscribe, result.subscriptionId).catch(() => undefined);
        return {
          status: "error" as const,
          error: { code: "disposed" as const, reason: "The daemon subscription was cancelled." },
        };
      }
      if (pending.subscriptionId !== null && pending.subscriptionId !== result.subscriptionId) {
        pendingDaemonSubscriptions.delete(requestId);
        void ipc.invoke(channels.daemonUnsubscribe, result.subscriptionId).catch(() => undefined);
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
        if (disposed) break;
        deliverDaemonEvent(listener, event);
      }
      pendingDaemonSubscriptions.delete(requestId);
      let active = true;
      return {
        status: "subscribed" as const,
        unsubscribe: () => {
          if (!active || disposed) return;
          active = false;
          daemonListeners.delete(result.subscriptionId);
          void ipc.invoke(channels.daemonUnsubscribe, result.subscriptionId).catch(() => {
            // Main also clears subscriptions when the renderer/window is released.
          });
        },
      };
    },
  });
  return Object.freeze({
    daemon,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ipc.removeListener(channels.daemonEvent, receive);
      for (const cancel of pendingCancels) cancel();
      pendingCancels.clear();
      pendingDaemonSubscriptions.clear();
      for (const subscriptionId of daemonListeners.keys())
        void ipc.invoke(channels.daemonUnsubscribe, subscriptionId).catch(() => undefined);
      daemonListeners.clear();
    },
  });
}
