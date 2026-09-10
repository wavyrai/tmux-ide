import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";

export type { FleetPreviewSnapshot, FleetPreviewWindow } from "../../../lib/fleet-preview-model.ts";
import type { FleetPreviewSnapshot, FleetPreviewWindow } from "../../../lib/fleet-preview-model.ts";
import { stripVTControlCharacters } from "node:util";
export type FleetPreviewResult =
  | { status: "ready"; snapshot: FleetPreviewSnapshot }
  | { status: "unavailable" | "rate-limited" };

/** One-shot snapshot pinned to this route's exact authority; never the selected-machine singleton. */
export async function readFleetWindowPreview(
  handle: ApplicationMachineAuthorityHandle,
  liveSessionId: string,
  signal: AbortSignal,
  windowId?: string,
): Promise<FleetPreviewResult> {
  const daemon = handle.read();
  const epoch = handle.endpoint().epoch;
  if (!daemon?.authToken || handle.endpoint().state !== "ready") return { status: "unavailable" };
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
        body: JSON.stringify({
          expectedInstanceId: daemon.instanceId,
          liveSessionId,
          ...(windowId ? { windowId } : {}),
        }),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { status: response.status === 429 ? "rate-limited" : "unavailable" };
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 65536) throw new Error();
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
      return { status: "unavailable" };
    const rawWindows: unknown = body.windows ?? [];
    const validWindow = (value: unknown): value is FleetPreviewWindow => {
      if (!value || typeof value !== "object") return false;
      const w = value as Record<string, unknown>;
      return (
        typeof w.id === "string" &&
        /^@\d+$/u.test(w.id) &&
        typeof w.index === "number" &&
        Number.isSafeInteger(w.index) &&
        w.index >= 0 &&
        typeof w.name === "string" &&
        w.name.length <= 80 &&
        typeof w.active === "boolean" &&
        (w.paneIds === undefined ||
          (Array.isArray(w.paneIds) &&
            w.paneIds.length <= 256 &&
            w.paneIds.every((id: unknown) => typeof id === "string" && /^%\d+$/u.test(id))))
      );
    };
    if (!Array.isArray(rawWindows) || rawWindows.length > 64 || !rawWindows.every(validWindow))
      return { status: "unavailable" };
    const windows: FleetPreviewWindow[] = rawWindows;
    if (new Set(windows.map((w) => w.id)).size !== windows.length) return { status: "unavailable" };
    if (windows.reduce((sum, w) => sum + (w.paneIds?.length ?? 0), 0) > 256)
      return { status: "unavailable" };
    const selectedWindowId = body.selectedWindowId ?? null;
    if (
      (selectedWindowId !== null && !windows.some((w) => w.id === selectedWindowId)) ||
      (windowId && selectedWindowId !== windowId)
    )
      return { status: "unavailable" };
    const clean = (text: string) => stripVTControlCharacters(text).replace(/[^\P{Cc}\n\t]/gu, "");
    return {
      status: "ready",
      snapshot: {
        text: clean(body.text),
        selectedWindowId,
        windows: windows.map((w) => ({
          id: w.id,
          index: w.index,
          name: clean(w.name).replace(/[\n\t]/gu, " "),
          active: w.active,
          ...(w.paneIds ? { paneIds: [...new Set(w.paneIds)] } : {}),
        })),
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Compatibility text reader used by the existing F6 switcher. */
export async function readFleetPreview(
  handle: ApplicationMachineAuthorityHandle,
  liveSessionId: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await readFleetWindowPreview(handle, liveSessionId, signal);
  return result.status === "ready" ? result.snapshot.text : "Preview unavailable";
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

export interface AdaptiveFleetPreviewState {
  status: "idle" | "loading" | "ready" | "unavailable";
  snapshot: FleetPreviewSnapshot | null;
  stale: boolean;
}
/** One selected request, scheduled after settlement; no hidden polling or terminal streams. */
export function createAdaptiveFleetPreviewOwner(
  publish: (state: AdaptiveFleetPreviewState) => void,
  options: { debounceMs?: number; refreshMs?: number; maxBackoffMs?: number } = {},
) {
  let key: string | undefined;
  let read: ((signal: AbortSignal) => Promise<FleetPreviewResult>) | undefined;
  let controller: AbortController | null = null;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: FleetPreviewSnapshot | null = null;
  let failures = 0;
  let lastPublished = "";
  const emit = (state: AdaptiveFleetPreviewState) => {
    const signature = JSON.stringify(state);
    if (signature === lastPublished) return;
    lastPublished = signature;
    publish(state);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  const interval = Math.max(250, options.refreshMs ?? 1000);
  const schedule = (delay: number, owned: AbortController) => {
    timer = setTimeout(() => {
      timer = null;
      void run(owned);
    }, delay);
  };
  const run = async (owned: AbortController) => {
    if (owned.signal.aborted || controller !== owned || !read) return;
    if (!snapshot) emit({ status: "loading", snapshot: null, stale: false });
    let result: FleetPreviewResult;
    inFlight = owned;
    try {
      result = await read(owned.signal);
    } catch {
      result = { status: "unavailable" };
    } finally {
      if (inFlight === owned) inFlight = null;
    }
    if (owned.signal.aborted || controller !== owned) return;
    if (result.status === "ready") {
      snapshot = result.snapshot;
      failures = 0;
      emit({ status: "ready", snapshot, stale: false });
    } else {
      failures = Math.min(failures + 1, 10);
      emit({ status: "unavailable", snapshot, stale: snapshot !== null });
    }
    schedule(
      Math.min(Math.max(interval, options.maxBackoffMs ?? 8000), interval * 2 ** failures),
      owned,
    );
  };
  return {
    select(nextRead?: (signal: AbortSignal) => Promise<FleetPreviewResult>, nextKey?: string) {
      if (nextRead && nextKey !== undefined && nextKey === key && read) return;
      clear();
      read = nextRead;
      key = nextRead ? nextKey : undefined;
      snapshot = null;
      failures = 0;
      emit({ status: "idle", snapshot: null, stale: false });
      if (!read) return;
      controller = new AbortController();
      schedule(Math.max(0, options.debounceMs ?? 180), controller);
    },
    refresh() {
      if (!read || inFlight === controller) return;
      clear();
      controller = new AbortController();
      schedule(0, controller);
    },
    dispose() {
      clear();
      read = undefined;
      key = undefined;
      snapshot = null;
    },
  };
}

/** Combine already-cached agent facts only for panes in this preview window. */
export function fleetPreviewActivity(
  paneIds: readonly string[] | undefined,
  agents: readonly { paneId: string; attention: boolean; activity: string }[] | undefined,
): string {
  if (!paneIds || !agents) return "? activity";
  const panes = new Set(paneIds);
  const known = new Map(
    agents.filter((agent) => panes.has(agent.paneId)).map((agent) => [agent.paneId, agent]),
  );
  const values = [...known.values()];
  const attention = values.filter(
    (a) => a.attention || a.activity === "waiting" || a.activity === "failed",
  ).length;
  const running = values.filter((a) => !a.attention && a.activity === "running").length;
  return attention || running ? `${attention} attention · ${running} running` : "○ idle";
}
