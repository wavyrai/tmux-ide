import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { FleetCatalogResourceV1SchemaZ, type DaemonInstanceIdentity } from "@tmux-ide/contracts";
import { mountFleetResourceRoute } from "./fleet-resource-route.ts";
import { _setTmuxRunner, readAdoptedFleet } from "../discovery.ts";

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "3f1c9a2e-6d4b-4a1c-8e2f-0a1b2c3d4e5f",
  startedAt: "2026-07-22T00:00:00.000Z",
};
const OWNER = "owner-secret-token";

// Mirror discovery.ts's private wire format so the injected runner speaks the
// exact batched `list-panes` shape the enumerator parses.
const SEP = "|tmux-ide-fleet-field-v1|";
const SENTINEL = "tmux-ide-fleet-v1";
function paneLine(
  sessionName: string,
  paneId: string,
  active: boolean,
  command: string,
  path: string,
  state: string,
  statusText: string,
  displayName: string,
  hint = "",
): string {
  return [
    sessionName,
    paneId,
    `pane.test.${paneId.slice(1)}`,
    "1700000000",
    active ? "1" : "0",
    command,
    path,
    state,
    statusText,
    displayName,
    hint,
    SENTINEL,
  ].join(SEP);
}

const NOW = Math.floor(Date.now() / 1000);

/** A runner over canned tmux output; `sessions`/`panes` are the raw stdout bodies. */
function pinRunner(sessions: string, panes: string): () => void {
  return _setTmuxRunner((args) => {
    if (args[0] === "list-sessions") return sessions;
    if (args[0] === "list-panes" && args[1] === "-a") return panes;
    return "";
  });
}

function appWith(options: {
  ownerToken: string | null;
  registry?: { list(): { sessionName: string }[] };
  readFleet?: () => ReturnType<typeof readAdoptedFleet>;
}): Hono {
  const app = new Hono();
  mountFleetResourceRoute(app, {
    daemon: DAEMON,
    ownerToken: options.ownerToken,
    registry: options.registry ?? { list: () => [] },
    readFleet: options.readFleet,
  });
  return app;
}

function bearer(token = OWNER): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${token}` } };
}

let restoreRunner: (() => void) | null = null;
afterEach(() => {
  restoreRunner?.();
  restoreRunner = null;
});

describe("GET /api/resources/fleet-catalog", () => {
  it("enumerates adopted sessions, filters internal/scratch, and stamps agent status", async () => {
    restoreRunner = pinRunner(
      ["alpha\t1", "beta\t1", "zz-scratch\t1", "_internal\t1", "gamma\t"].join("\n"),
      [
        paneLine(
          "alpha",
          "%1",
          true,
          "node",
          "/home/dev/alpha",
          `working:${NOW}`,
          "",
          "Backend agent",
        ),
        paneLine("beta", "%2", true, "claude", "/home/dev/beta", "", "", ""),
        paneLine("beta", "%3", false, "zsh", "/home/dev/beta", "", "", ""),
        paneLine("zz-scratch", "%4", true, "claude", "/tmp/zz", `working:${NOW}`, "", ""),
        paneLine("gamma", "%5", true, "claude", "/home/dev/gamma", `working:${NOW}`, "", ""),
      ].join("\n"),
    );
    const app = appWith({
      ownerToken: OWNER,
      registry: { list: () => [{ sessionName: "alpha" }] },
    });

    const res = await app.request("/api/resources/fleet-catalog", bearer());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    const parsed = FleetCatalogResourceV1SchemaZ.parse(body);

    expect(parsed.sessions.map((s) => s.label).sort()).toEqual(["alpha", "beta"]);

    const alpha = parsed.sessions.find((s) => s.label === "alpha")!;
    expect(alpha.appCreated).toBe(true);
    expect(alpha.projectLabel).toBe("alpha");
    expect(alpha.agents).toHaveLength(1);
    expect(alpha.agents[0]!.activity).toBe("running");
    expect(alpha.agents[0]!.statusSource).toBe("authority");
    expect(alpha.agents[0]!.name).toBe("Backend agent");
    expect(alpha.agents[0]!.harness).toBe("custom");

    const beta = parsed.sessions.find((s) => s.label === "beta")!;
    expect(beta.appCreated).toBe(false);
    expect(beta.paneCount).toBe(2);
    expect(beta.agents).toHaveLength(1);
    expect(beta.agents[0]!.activity).toBe("disconnected");
    expect(beta.agents[0]!.statusSource).toBe("unknown");

    // No pane id or absolute path ever crosses the wire.
    const wire = JSON.stringify(parsed);
    expect(wire).not.toContain("%1");
    expect(wire).not.toContain("/home/dev");
  });

  it("rejects a request with no bearer", async () => {
    restoreRunner = pinRunner("", "");
    const app = appWith({ ownerToken: OWNER });
    const res = await app.request("/api/resources/fleet-catalog");
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong bearer", async () => {
    restoreRunner = pinRunner("", "");
    const app = appWith({ ownerToken: OWNER });
    const res = await app.request("/api/resources/fleet-catalog", bearer("not-the-token"));
    expect(res.status).toBe(401);
  });

  it("reports 503 when no owner capability is configured", async () => {
    restoreRunner = pinRunner("", "");
    const app = appWith({ ownerToken: null });
    const res = await app.request("/api/resources/fleet-catalog", bearer());
    expect(res.status).toBe(503);
  });

  it("degrades a tmux failure to a valid empty catalog", async () => {
    restoreRunner = _setTmuxRunner(() => {
      throw new Error("no server running");
    });
    const app = appWith({ ownerToken: OWNER });
    const res = await app.request("/api/resources/fleet-catalog", bearer());
    expect(res.status).toBe(200);
    const parsed = FleetCatalogResourceV1SchemaZ.parse(await res.json());
    expect(parsed.sessions).toEqual([]);
    expect(parsed.daemon).toEqual(DAEMON);
  });

  it("reads the daemon-generation-pinned private socket and excludes the ambient server", async (context) => {
    if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
      context.skip();
      return;
    }
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tmux-ide-fleet-route-"));
    const pinnedSocket = join(fixtureRoot, "pinned.sock");
    const ambientSocket = join(fixtureRoot, "ambient.sock");
    const runnerFor =
      (socketPath: string) =>
      (args: string[]): string =>
        execFileSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" }).trim();
    try {
      for (const [socketPath, sessionName] of [
        [pinnedSocket, "isolated"],
        [ambientSocket, "unrelated"],
      ] as const) {
        execFileSync("tmux", ["-S", socketPath, "new-session", "-d", "-s", sessionName]);
        execFileSync("tmux", [
          "-S",
          socketPath,
          "set-option",
          "-t",
          sessionName,
          "@tmux_ide_adopted",
          "1",
        ]);
      }
      restoreRunner = _setTmuxRunner(runnerFor(ambientSocket));
      const registry = { list: () => [] };
      const app = appWith({
        ownerToken: OWNER,
        registry,
        readFleet: () => readAdoptedFleet(registry, runnerFor(pinnedSocket)),
      });
      const response = await app.request("/api/resources/fleet-catalog", bearer());
      expect(response.status).toBe(200);
      const parsed = FleetCatalogResourceV1SchemaZ.parse(await response.json());
      expect(parsed.sessions.map(({ label }) => label)).toEqual(["isolated"]);
      expect(parsed.sessions.some(({ label }) => label === "unrelated")).toBe(false);
    } finally {
      restoreRunner?.();
      restoreRunner = null;
      for (const socketPath of [pinnedSocket, ambientSocket])
        spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("sanitizes a hostile self-reported display name", async () => {
    restoreRunner = pinRunner(
      "alpha\t1",
      paneLine(
        "alpha",
        "%1",
        true,
        "claude",
        "/home/dev/alpha",
        `working:${NOW}`,
        "",
        "evil\u001b[2Jname",
      ),
    );
    const app = appWith({ ownerToken: OWNER });
    const res = await app.request("/api/resources/fleet-catalog", bearer());
    const parsed = FleetCatalogResourceV1SchemaZ.parse(await res.json());
    const name = parsed.sessions[0]!.agents[0]!.name;
    expect([...name].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)).toBe(true);
  });
});
