import { createHostedPublicationBounds } from "./hosted-publication.ts";
import type { HostedLiveEvent } from "./hosted-live-types.ts";
/** A next-turn boundary replaces child-pipe delivery without serializing terminal cells.
 * Latest state coalesces; image/control entries stay ordered before dependent state.
 */
export function createHostedPublicationMailbox(options: {
  deliver(event: HostedLiveEvent): void;
  failed(): void;
  maxOrderedBytes?: number;
  maxOrderedEntries?: number;
}) {
  const checkBounds = createHostedPublicationBounds();
  let handoffAdmitted = false;
  const maxBytes = options.maxOrderedBytes ?? 64 * 1024 * 1024,
    maxEntries = options.maxOrderedEntries ?? 1024;
  let pending: HostedLiveEvent | undefined,
    orderedBytes = 0,
    closed = false;
  const ordered: { event: HostedLiveEvent; bytes: number }[] = [];
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let waiter: { resolve(): void; reject(error: unknown): void; cleanup(): void } | undefined;
  function finish(error?: unknown) {
    const current = waiter;
    waiter = undefined;
    current?.cleanup();
    if (error) current?.reject(error);
    else current?.resolve();
  }
  function close() {
    closed = true;
    clearImmediate(scheduled);
    scheduled = undefined;
    pending = undefined;
    ordered.length = 0;
    orderedBytes = 0;
    finish(Error("Hosted publication mailbox closed"));
  }
  function flush() {
    scheduled = undefined;
    if (closed) return;
    try {
      while (ordered.length && !closed) {
        const next = ordered.shift()!;
        orderedBytes -= next.bytes;
        options.deliver(next.event);
      }
      if (!closed && pending) {
        const next = pending;
        pending = undefined;
        options.deliver(next);
      }
      if (!ordered.length && !pending) finish();
    } catch {
      close();
      options.failed();
    }
  }
  function schedule() {
    scheduled ??= setImmediate(flush);
  }
  return {
    emit(event: HostedLiveEvent): boolean {
      if (closed) return false;
      if ("connection" in event) {
        checkBounds(event);
        pending = event;
        schedule();
        return true;
      }
      const bytes = "rawKittyImage" in event ? event.rawKittyImage.bytes.byteLength : 1024;
      if (bytes + orderedBytes > maxBytes || ordered.length >= maxEntries) return false;
      if ("kind" in event) {
        if (handoffAdmitted) return false;
        handoffAdmitted = true;
      }
      // Handoff receipts follow their preceding publication; final unavailable may follow.
      if ("kind" in event && pending) {
        if (ordered.length + 2 > maxEntries) return false;
        ordered.push({ event: pending, bytes: 0 });
        pending = undefined;
      }
      ordered.push({ event, bytes });
      orderedBytes += bytes;
      schedule();
      return true;
    },
    drain(signal: AbortSignal) {
      if (closed) return Promise.reject(Error("Hosted publication mailbox closed"));
      if (waiter) return Promise.reject(Error("Concurrent hosted publication drain"));
      if (!scheduled && !pending && !ordered.length) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          finish(Error("Hosted publication drain aborted"));
          close();
        };
        waiter = { resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    close,
  };
}
