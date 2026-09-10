import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { SavedMachineRegistrySchema, type DaemonInstanceIdentity } from "@tmux-ide/contracts";
import { loadSavedMachines, mergeSavedMachines } from "../../lib/saved-machines.ts";
import { ownerAuthorityGate } from "../owner-authority.ts";

const Request = z.strictObject({
  expectedInstanceId: z.uuid(),
  registry: SavedMachineRegistrySchema,
});
export function mountSavedMachineRoute(
  app: Hono,
  options: {
    daemon: DaemonInstanceIdentity;
    ownerToken: string | null;
    read?: typeof loadSavedMachines;
    merge?: typeof mergeSavedMachines;
  },
) {
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Machine registry unavailable",
    mismatchMessage: "Machine registry requires owner authority",
  });
  app.get("/api/resources/saved-machines", (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    try {
      return c.json({ daemon: options.daemon, registry: (options.read ?? loadSavedMachines)() });
    } catch {
      return c.json({ error: "Machine registry unavailable" }, 503);
    }
  });
  app.post("/api/resources/saved-machines", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    try {
      const parsed = Request.safeParse(await c.req.json());
      if (!parsed.success) return c.json({ error: "Invalid machine registry request" }, 400);
      if (parsed.data.expectedInstanceId !== options.daemon.instanceId)
        return c.json({ error: "Daemon generation changed" }, 409);
      return c.json({
        daemon: options.daemon,
        registry: (options.merge ?? mergeSavedMachines)(parsed.data.registry),
      });
    } catch {
      return c.json(
        {
          error:
            "Import conflicts with existing machines or the registry is unavailable; nothing changed",
        },
        409,
      );
    }
  });
}
