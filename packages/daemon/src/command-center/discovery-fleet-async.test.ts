import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import { mountFleetResourceRoute } from "./resources/fleet-resource-route.ts";
import { readAdoptedFleet, readAdoptedFleetAsync } from "./discovery.ts";

// #709: the catalog read ran tmux through spawnSync, so concurrent catalog
// requests queued behind each other (8 requests took 7-8x one request).

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "3f1c9a2e-6d4b-4a1c-8e2f-0a1b2c3d4e5f",
  startedAt: "2026-07-22T00:00:00.000Z",
};
const OWNER = "owner-secret-token";
const SEP = "|tmux-ide-fleet-field-v1|";
const SENTINEL = "tmux-ide-fleet-v1";

function paneLine(session: string, paneId: string, active: boolean): string {
  return [
    session,
    paneId,
    `pane.test.${paneId.slice(1)}`,
    "1700000000",
    active ? "1" : "0",
    "zsh",
    `/work/${session}`,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    SENTINEL,
  ].join(SEP);
}

const SESSIONS = "alpha\t1\nbeta\t1\n_hidden\t1\nplain\t\n";
const PANES = [
  paneLine("alpha", "%1", true),
  paneLine("alpha", "%2", false),
  paneLine("beta", "%3", true),
  paneLine("plain", "%4", true),
].join("\n");
const registry = { list: () => [{ sessionName: "alpha" }] };

function output(args: readonly string[], sessions = SESSIONS, panes = PANES): string {
  if (args[0] === "list-sessions") return sessions;
  if (args[0] === "list-panes" && args[1] === "-a") return panes;
  throw new Error(`unexpected tmux ${args.join(" ")}`);
}

const TMUX_MS = 25;
/** tmux answering in another process: the event loop stays free meanwhile. */
const asyncTmux = (args: string[]) =>
  new Promise<string>((resolve) => setTimeout(() => resolve(output(args)), TMUX_MS));
/** spawnSync: the event loop waits for tmux. */
const blockingTmux = (args: string[]) => {
  const until = performance.now() + TMUX_MS;
  while (performance.now() < until);
  return output(args);
};

function route(readFleet: () => unknown): Hono {
  const app = new Hono();
  mountFleetResourceRoute(app, {
    daemon: DAEMON,
    ownerToken: OWNER,
    registry,
    readFleet: readFleet as never,
  });
  return app;
}

async function timed(app: Hono, concurrent: number): Promise<number> {
  const started = performance.now();
  const responses = await Promise.all(
    Array.from({ length: concurrent }, () =>
      app.request("/api/resources/fleet-catalog", {
        headers: { Authorization: `Bearer ${OWNER}` },
      }),
    ),
  );
  for (const response of responses) expect(response.status).toBe(200);
  return performance.now() - started;
}

describe("asynchronous fleet catalog read (#709)", () => {
  it("returns exactly what the synchronous read returns", async () => {
    const cases: [string, string | Error, string | Error][] = [
      ["fleet", SESSIONS, PANES],
      ["no adopted session", "plain\t\n_hidden\t1\n", PANES],
      ["panes unreadable", SESSIONS, new Error("list-panes failed")],
      ["no server", new Error("no server running"), PANES],
    ];
    for (const [, sessions, panes] of cases) {
      const answer = (args: readonly string[]) => {
        const value = args[0] === "list-sessions" ? sessions : panes;
        if (value instanceof Error) throw value;
        return output(args, value, value);
      };
      const sync = readAdoptedFleet(registry, (args) => answer(args));
      const async = await readAdoptedFleetAsync(registry, async (args) => answer(args));
      expect(async).toEqual(sync);
    }
  });

  it("keeps the event loop free while tmux answers", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await readAdoptedFleetAsync(registry, asyncTmux);
    } finally {
      clearInterval(timer);
    }
    // Two reads of 25 ms each; a blocked loop would not tick at all.
    expect(ticks).toBeGreaterThan(5);
  });

  it("serves 8 concurrent catalog requests within 1.5x one request", async () => {
    const app = route(() => readAdoptedFleetAsync(registry, asyncTmux));
    await timed(app, 1);
    const single = await timed(app, 1);
    const eight = await timed(app, 8);
    expect(eight).toBeLessThan(single * 1.5);
  });

  it("is what a blocking read cannot do", async () => {
    // The pre-#709 wiring: the same route over a spawnSync-style read.
    const app = route(() => readAdoptedFleet(registry, blockingTmux));
    await timed(app, 1);
    const single = await timed(app, 1);
    const eight = await timed(app, 8);
    expect(eight).toBeGreaterThan(single * 4);
  });
});
