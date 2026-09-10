import type { Hono } from "hono";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import { FleetClientStateRequestSchema } from "@tmux-ide/contracts/fleet-client-state";
import { loadFleetClientState, updateFleetClientState } from "../../lib/fleet-client-state.ts";
import { ownerAuthorityGate } from "../owner-authority.ts";

export function mountFleetClientStateRoute(
  app: Hono,
  options: {
    daemon: DaemonInstanceIdentity;
    ownerToken: string | null;
    read?: typeof loadFleetClientState;
    update?: typeof updateFleetClientState;
  },
) {
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Fleet preferences unavailable",
    mismatchMessage: "Fleet preferences require owner authority",
  });
  app.get("/api/resources/fleet-client-state", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    try {
      return c.json({ daemon: options.daemon, state: (options.read ?? loadFleetClientState)() });
    } catch {
      return c.json({ error: "Fleet preferences unavailable; existing state preserved" }, 503);
    }
  });
  app.post("/api/resources/fleet-client-state", async (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    // Bound streaming request bodies even when Content-Length is absent or forged.
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: "Invalid fleet preference request" }, 400);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 256 * 1024) return c.json({ error: "Fleet preference request too large" }, 413);
        chunks.push(chunk.value);
      }
      const parsed = FleetClientStateRequestSchema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!parsed.success) return c.json({ error: "Invalid fleet preference request" }, 400);
      if (parsed.data.expectedInstanceId !== options.daemon.instanceId)
        return c.json({ error: "Daemon generation changed" }, 409);
      return c.json({
        daemon: options.daemon,
        state: (options.update ?? updateFleetClientState)(parsed.data.change),
      });
    } catch {
      return c.json(
        { error: "Fleet preferences could not be saved; existing state preserved" },
        400,
      );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
}
