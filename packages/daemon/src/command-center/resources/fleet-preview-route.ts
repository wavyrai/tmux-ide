import type { Hono } from "hono";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { stripVTControlCharacters } from "node:util";
import { ownerAuthorityGate } from "../owner-authority.ts";
import { discoverLiveSessionSummaries } from "../discovery.ts";

export function createFleetPreviewCapture(
  run: (args: string[], signal?: AbortSignal) => string | Promise<string>,
) {
  return async (liveSessionId: string, signal?: AbortSignal): Promise<string | null> => {
    const readSessions = async () => {
      const raw = await run(
        ["list-panes", "-a", "-F", "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}"],
        signal,
      );
      return discoverLiveSessionSummaries(() => raw);
    };
    const session = (await readSessions()).find((s) => s.liveSessionId === liveSessionId);
    if (!session) return null;
    const panes = await run(
      [
        "list-panes",
        "-s",
        "-t",
        `=${session.sessionName}`,
        "-F",
        "#{pane_id}\t#{window_active}\t#{pane_active}",
      ],
      signal,
    );
    const rows = panes
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const pane = rows.find((row) => row[1] === "1" && row[2] === "1")?.[0] ?? rows[0]?.[0];
    if (!pane || !/^%\d+$/u.test(pane)) return null;
    // Read-only capture: no attach, select, resize, input or ownership acquisition.
    const captured = await run(["capture-pane", "-p", "-t", pane, "-S", "-24"], signal);
    if (!(await readSessions()).some((s) => s.liveSessionId === liveSessionId)) return null;
    return stripVTControlCharacters(captured)
      .replace(/[^\P{Cc}\n\t]/gu, "")
      .split("\n")
      .slice(-24)
      .map((line) => line.slice(0, 180))
      .join("\n")
      .slice(0, 8192);
  };
}
const requestSchema = z.strictObject({
  expectedInstanceId: z.uuid(),
  liveSessionId: z.string().regex(/^live-session\.[a-f0-9]{20}$/u),
});
export function mountFleetPreviewRoute(
  app: Hono,
  options: {
    daemon: DaemonInstanceIdentity;
    ownerToken: string | null;
    capture?: (
      liveSessionId: string,
      signal?: AbortSignal,
    ) => string | null | Promise<string | null>;
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
      const text = await options.capture(
        input.data.liveSessionId,
        AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(1500)]),
      );
      return text === null
        ? c.json({ error: "Session changed" }, 409)
        : c.json({ daemon: options.daemon, liveSessionId: input.data.liveSessionId, text });
    } catch {
      return c.json({ error: "Preview unavailable" }, 503);
    } finally {
      pending = false;
    }
  });
}
