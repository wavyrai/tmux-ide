import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  SavedMachineRegistrySchema,
  type SavedMachineRegistry,
  type DaemonInstanceIdentity,
} from "@tmux-ide/contracts";
import { loadSavedMachines, watchSavedMachines } from "../../lib/saved-machines.ts";
import { ownerAuthorityGate } from "../owner-authority.ts";

export const SAVED_MACHINE_WATCH_WAIT_MS = 20_000;
const MAX_WATCHERS = 32;
const Query = z.strictObject({
  expectedInstanceId: z.uuid(),
  after: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
type Snapshot = { revision: string; registry: SavedMachineRegistry };
type Result =
  | { status: 200; revision: string; registry: SavedMachineRegistry | null }
  | { status: 408 | 503 };
function snapshot(value: SavedMachineRegistry): Snapshot {
  const registry = SavedMachineRegistrySchema.parse(value);
  return {
    registry,
    revision: createHash("sha256").update(JSON.stringify(registry)).digest("hex"),
  };
}

/** One bounded notification request. A new request always observes the latest registry. */
export function mountSavedMachineWatch(
  app: Hono,
  options: {
    daemon: DaemonInstanceIdentity;
    ownerToken: string | null;
    read?: typeof loadSavedMachines;
    watch?: typeof watchSavedMachines;
  },
) {
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Machine registry unavailable",
    mismatchMessage: "Machine registry requires owner authority",
  });
  const read = options.read ?? loadSavedMachines;
  const watch = options.watch ?? watchSavedMachines;
  let active = 0;
  app.get("/api/resources/saved-machines/watch", async (c) => {
    const gate = authorize(c);
    if (gate) return gate;
    c.header("Cache-Control", "no-store");
    const query = Query.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid registry watch request" }, 400);
    if (query.data.expectedInstanceId !== options.daemon.instanceId)
      return c.json({ error: "Daemon generation changed" }, 409);
    if (active >= MAX_WATCHERS) return c.json({ error: "Registry watch capacity reached" }, 429);
    active++;
    try {
      const initial = snapshot(read());
      if (query.data.after !== initial.revision)
        return c.json({ daemon: options.daemon, ...initial });
      const signal = c.req.raw.signal;
      const result = await new Promise<Result>((resolve) => {
        let settled = false;
        let stop = () => {};
        const finish = (result: Result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", aborted);
          try {
            stop();
          } finally {
            resolve(result);
          }
        };
        const aborted = () => finish({ status: 408 });
        const timer = setTimeout(
          () => finish({ status: 200, revision: initial.revision, registry: null }),
          SAVED_MACHINE_WATCH_WAIT_MS,
        );
        timer.unref();
        const changed = (value: SavedMachineRegistry) => {
          if (settled) return;
          try {
            const next = snapshot(value);
            if (next.revision !== initial.revision) finish({ status: 200, ...next });
          } catch {
            finish({ status: 503 });
          }
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) {
          aborted();
          return;
        }
        try {
          stop = watch(changed, () => finish({ status: 503 }));
          // Watch implementations may synchronously report an initial error/change.
          if (settled) {
            stop();
            return;
          }
          // Close the read-before-subscribe race independently of watcher behavior.
          changed(read());
        } catch {
          finish({ status: 503 });
        }
      });
      if (result.status !== 200)
        return c.json(
          {
            error:
              result.status === 408 ? "Registry watch cancelled" : "Machine registry unavailable",
          },
          result.status,
        );
      return c.json({
        daemon: options.daemon,
        revision: result.revision,
        registry: result.registry,
      });
    } catch {
      return c.json({ error: "Machine registry unavailable" }, 503);
    } finally {
      active--;
    }
  });
}
