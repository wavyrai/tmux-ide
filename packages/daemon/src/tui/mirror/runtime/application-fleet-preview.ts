import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";

/** One-shot snapshot pinned to this route's exact authority; never the selected-machine singleton. */
export async function readFleetPreview(
  handle: ApplicationMachineAuthorityHandle,
  liveSessionId: string,
  signal: AbortSignal,
): Promise<string> {
  const daemon = handle.read();
  const epoch = handle.endpoint().epoch;
  if (!daemon?.authToken || handle.endpoint().state !== "ready") return "Preview unavailable";
  try {
    const response = await fetch(
      canonicalDaemonUrl("http", daemon.bindHostname, daemon.port) + "/api/resources/fleet-preview",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        headers: {
          Authorization: `Bearer ${daemon.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedInstanceId: daemon.instanceId, liveSessionId }),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return "Preview unavailable on this daemon";
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 32768) throw new Error();
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      signal.aborted ||
      handle.endpoint().epoch !== epoch ||
      handle.read()?.instanceId !== daemon.instanceId ||
      body.daemon?.instanceId !== daemon.instanceId ||
      body.daemon?.startedAt !== daemon.startedAt ||
      body.liveSessionId !== liveSessionId ||
      typeof body.text !== "string" ||
      body.text.length > 8192
    )
      return "Preview unavailable";
    return body.text;
  } catch {
    return "Preview unavailable";
  }
}

/** Debounce and cancellation bound work to one selected row; late replies never publish. */
export function createFleetPreviewOwner(publish: (text: string | null) => void, delay = 180) {
  let selectedKey: string | undefined;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  return {
    select(read?: (signal: AbortSignal) => Promise<string>, key?: string) {
      if (read && key !== undefined && key === selectedKey) return;
      clear();
      selectedKey = read ? key : undefined;
      publish(null);
      if (!read) return;
      const owned = new AbortController();
      controller = owned;
      timer = setTimeout(() => {
        timer = null;
        publish("Loading preview…");
        void read(owned.signal).then(
          (text) => {
            if (!owned.signal.aborted && controller === owned) publish(text);
          },
          () => {
            if (!owned.signal.aborted && controller === owned) publish("Preview unavailable");
          },
        );
      }, delay);
    },
    dispose: clear,
  };
}
