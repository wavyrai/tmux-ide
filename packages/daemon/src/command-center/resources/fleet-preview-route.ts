import type { Hono } from "hono";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { stripVTControlCharacters } from "node:util";
import { ownerAuthorityGate } from "../owner-authority.ts";
import { discoverLiveSessionSummaries } from "../discovery.ts";

import type { FleetPreviewWindow, FleetPreviewSnapshot } from "../../lib/fleet-preview-model.ts";
type Capture = ((
  liveSessionId: string,
  signal?: AbortSignal,
) => string | null | Promise<string | null>) & {
  snapshot?: (
    liveSessionId: string,
    signal?: AbortSignal,
    windowId?: string,
  ) => Promise<FleetPreviewSnapshot | null>;
};
const cleanText = (value: string) => stripVTControlCharacters(value).replace(/[^\P{Cc}\n\t]/gu, "");

export function createFleetPreviewCapture(
  run: (args: string[], signal?: AbortSignal) => string | Promise<string>,
) {
  const snapshot = async (
    liveSessionId: string,
    signal?: AbortSignal,
    windowId?: string,
  ): Promise<FleetPreviewSnapshot | null> => {
    const readSessions = async () => {
      const raw = await run(
        ["list-panes", "-a", "-F", "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}"],
        signal,
      );
      return discoverLiveSessionSummaries(() => raw);
    };
    const session = (await readSessions()).find((s) => s.liveSessionId === liveSessionId);
    if (!session) return null;
    const readPanes = async () =>
      (
        await run(
          [
            "list-panes",
            "-s",
            "-t",
            `=${session.sessionName}`,
            "-F",
            "#{pane_id}\t#{window_active}\t#{pane_active}\t#{window_id}\t#{window_index}",
          ],
          signal,
        )
      )
        .trim()
        .split("\n")
        .map((line) => line.split("\t"));
    // Names are untrusted display text. Keep them out of the pane membership
    // format so embedded newlines cannot manufacture a capture target.
    const names = new Map<string, string>();
    // Independent metadata reads share one capture's deadline and run in two
    // bounded lanes. Incarnation checks still surround the actual capture.
    const [rows, windowNames] = await Promise.all([
      readPanes(),
      run(
        ["list-windows", "-t", `=${session.sessionName}`, "-F", "#{window_id}\t#{window_name}"],
        signal,
      ),
    ]);
    for (const line of windowNames.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0)
        names.set(
          line.slice(0, tab),
          cleanText(line.slice(tab + 1))
            .replace(/[\n\t]/gu, " ")
            .slice(0, 80),
        );
    }
    const windowRows = rows.filter((row) => /^@\d+$/u.test(row[3] ?? ""));
    const selectedWindowId =
      windowId ?? windowRows.find((row) => row[1] === "1")?.[3] ?? windowRows[0]?.[3] ?? null;
    if (windowId && !windowRows.some((row) => row[3] === windowId)) return null;
    const toWindow = (row: string[]): FleetPreviewWindow => ({
      id: row[3]!,
      index: Math.max(0, Number.parseInt(row[4] ?? "0", 10) || 0),
      name: names.get(row[3]!) ?? `Window ${row[4]}`,
      active: row[1] === "1",
    });
    const windows: FleetPreviewWindow[] = [];
    for (const row of windowRows) {
      if (windows.some((w) => w.id === row[3])) continue;
      if (windows.length >= 64) break;
      windows.push(toWindow(row));
    }
    // Preserve the actual active/requested target even on unusually large sessions.
    if (selectedWindowId && !windows.some((w) => w.id === selectedWindowId)) {
      const selectedRow = windowRows.find((row) => row[3] === selectedWindowId);
      if (selectedRow) windows.splice(63, 1, toWindow(selectedRow));
    }
    let paneBudget = 256;
    // The selected window gets the membership budget first; omitted membership
    // remains explicitly unknown instead of reporting incomplete activity counts.
    for (const window of [...windows].sort(
      (a, b) => Number(b.id === selectedWindowId) - Number(a.id === selectedWindowId),
    )) {
      const ids = [
        ...new Set(
          windowRows
            .filter((row) => row[3] === window.id && /^%\d+$/u.test(row[0] ?? ""))
            .map((row) => row[0]!),
        ),
      ];
      if (ids.length <= paneBudget) {
        window.paneIds = ids;
        paneBudget -= ids.length;
      }
    }
    windows.sort((a, b) => a.index - b.index);
    const candidates = selectedWindowId ? rows.filter((r) => r[3] === selectedWindowId) : rows;
    const pane = candidates.find((r) => r[2] === "1")?.[0] ?? candidates[0]?.[0];
    if (!pane || !/^%\d+$/u.test(pane)) return null;
    // Passive capture never changes active windows, size, input or terminal ownership.
    const captured = await run(["capture-pane", "-p", "-t", pane, "-S", "-24"], signal);
    const [currentSessions, currentPanes] = await Promise.all([readSessions(), readPanes()]);
    if (!currentSessions.some((s) => s.liveSessionId === liveSessionId)) return null;
    if (selectedWindowId && !currentPanes.some((r) => r[3] === selectedWindowId && r[0] === pane))
      return null;
    return {
      windows,
      selectedWindowId,
      text: cleanText(captured)
        .split("\n")
        .slice(-24)
        .map((line) => line.slice(0, 180))
        .join("\n")
        .slice(0, 8192),
    };
  };
  const capture = async (liveSessionId: string, signal?: AbortSignal) =>
    (await snapshot(liveSessionId, signal))?.text ?? null;
  return Object.assign(capture, { snapshot });
}
const requestSchema = z.strictObject({
  expectedInstanceId: z.uuid(),
  windowId: z
    .string()
    .regex(/^@\d+$/u)
    .optional(),
  liveSessionId: z.string().regex(/^live-session\.[a-f0-9]{20}$/u),
});
export function mountFleetPreviewRoute(
  app: Hono,
  options: {
    daemon: DaemonInstanceIdentity;
    ownerToken: string | null;
    capture?: Capture;
    now?: () => number;
  },
) {
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Preview unavailable",
    mismatchMessage: "Preview requires owner authority",
  });
  app.get("/api/resources/fleet-preview", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    return c.json({ daemon: options.daemon, available: !!options.capture });
  });
  let next = 0;
  let pending = false;
  app.post("/api/resources/fleet-preview", bodyLimit({ maxSize: 1024 }), async (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    let input;
    try {
      input = requestSchema.safeParse(await c.req.json());
    } catch {
      return c.json({ error: "Invalid preview request" }, 400);
    }
    if (!input.success) return c.json({ error: "Invalid preview request" }, 400);
    if (input.data.expectedInstanceId !== options.daemon.instanceId)
      return c.json({ error: "Daemon changed" }, 409);
    if (!options.capture) return c.json({ error: "Preview unavailable" }, 503);
    const now = (options.now ?? Date.now)();
    if (pending || now < next) return c.json({ error: "Preview rate limited" }, 429);
    next = now + 250;
    pending = true;
    try {
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(1500)]);
      if (input.data.windowId && !options.capture.snapshot)
        return c.json({ error: "Window preview unavailable" }, 503);
      const snapshot = options.capture.snapshot
        ? await options.capture.snapshot(input.data.liveSessionId, signal, input.data.windowId)
        : null;
      // Older capture providers remain valid for the original text-only contract.
      const legacy = !options.capture.snapshot
        ? await options.capture(input.data.liveSessionId, signal)
        : null;
      const text = snapshot?.text ?? legacy;
      return text === null
        ? c.json({ error: "Session changed" }, 409)
        : c.json({
            daemon: options.daemon,
            liveSessionId: input.data.liveSessionId,
            text,
            ...(snapshot
              ? { windows: snapshot.windows, selectedWindowId: snapshot.selectedWindowId }
              : {}),
          });
    } catch {
      return c.json({ error: "Preview unavailable" }, 503);
    } finally {
      pending = false;
    }
  });
}
