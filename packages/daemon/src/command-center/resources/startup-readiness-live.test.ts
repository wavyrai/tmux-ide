/**
 * Live proof of the startup readiness ladder against a REAL tmux fleet on an
 * isolated socket, through the real attachment runtime and the real HTTP route.
 *
 * Two halves, both of which the honesty story depends on:
 *  - the green walk: a stamped, adopted scratch session drives every rung to
 *    satisfied and reports the fleet it actually found;
 *  - the stuck case: the tmux server the daemon was pointed at is killed, and
 *    the endpoint keeps serving — reporting the catalog rung stuck with a typed
 *    reason instead of failing the request. Readiness must never take down the
 *    thing it reports on.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { StartupReadinessResourceSchemaZ } from "@tmux-ide/contracts";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import {
  createNativeTerminalAttachmentRuntime,
  type NativeTerminalAttachmentRuntime,
} from "../../terminal/attachments/native-runtime.ts";
import { mountStartupReadinessRoute } from "./startup-readiness-route.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const executablePath = hasTmux
  ? realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim())
  : "/usr/bin/false";

// PID-scoped socket name and a `zz-` scratch session: nothing here can touch a
// real tmux server or a session the user cares about.
const socketName = `tmux-ide-readiness-${process.pid}-${randomUUID().slice(0, 8)}`;
const sessionName = `zz-readiness-${process.pid}`;
const workspaceName = "workspace.readiness-live";
const sleepCommand = "exec sleep 2147483647";
const daemonInstanceId = randomUUID();
const OWNER_TOKEN = "owner-token-live";

const DAEMON = {
  protocolVersion: 1,
  productVersion: "2.7.0",
  instanceId: daemonInstanceId,
  startedAt: "2026-08-04T11:59:00.000Z",
} as const;

// Short temp root: an isolated tmux socket path must stay inside the 104-byte
// sun_path limit, so the socket lives under the tmux -L name, not this dir.
const root = mkdtempSync(join(tmpdir(), "tmux-ide-readiness-"));

function runTmux(args: readonly string[]): string {
  return execFileSync(executablePath, ["-L", socketName, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe.skipIf(!hasTmux)("startup readiness against a live fleet", () => {
  // Real subprocess spawns starve under parallel load; widen the budget without
  // touching the assertions.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  let registry!: WorkspaceRegistry;
  let runtime!: NativeTerminalAttachmentRuntime;
  let app!: Hono;

  const request = async (): Promise<Response> =>
    app.request("/api/resources/startup-readiness", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });

  beforeAll(async () => {
    runTmux(["new-session", "-d", "-s", sessionName, "-n", "agent", sleepCommand]);
    const pane = runTmux(["display-message", "-p", "-t", `=${sessionName}:agent`, "#{pane_id}"]);
    runTmux(["set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.readiness-live"]);

    registry = new WorkspaceRegistry({
      dir: join(root, "registry"),
      listSessions: () => [sessionName],
    });
    registry.add({ name: workspaceName, sessionName, projectDir: root });

    runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId,
      webSocketUrl: "ws://127.0.0.1:6070/v1/terminal/attachments/redeem",
      registry,
      tmuxAuthority: {
        executablePath,
        socketSelector: { kind: "name", name: socketName },
        trustedCwd: root,
      },
    });
    await runtime.whenReady();

    app = new Hono();
    mountStartupReadinessRoute(app, {
      daemon: DAEMON,
      ownerToken: OWNER_TOKEN,
      registry,
      attachmentRuntime: runtime,
      // The canonical record is machine-global state; this suite proves the
      // catalog rungs, so identity is pinned to this generation.
      inspectCanonical: () =>
        ({
          status: "valid",
          info: { instanceId: daemonInstanceId },
          observation: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        }) as never,
    });
  });

  afterAll(async () => {
    await runtime?.dispose().catch(() => undefined);
    spawnSync(executablePath, ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("walks every rung against the real fleet it found", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const body = StartupReadinessResourceSchemaZ.parse(await response.json());

    expect(body.ladder.blockedAt).toBeNull();
    expect(body.ladder.rungs.map((rung) => rung.status)).toEqual([
      "satisfied",
      "satisfied",
      "satisfied",
      "satisfied",
      "satisfied",
    ]);
    const catalog = body.ladder.rungs[3]!;
    expect(catalog.status === "satisfied" ? catalog.population : null).toEqual({
      fleet: "populated",
      workspaceCount: 1,
      attachablePaneCount: 1,
    });
  });

  it("keeps serving, and names the stuck rung, when its tmux server dies", async () => {
    // Kill ONLY this suite's isolated socket. The daemon now points at a tmux
    // server that no longer exists — the exact shape of the silent startup that
    // m44.3 exists to make legible.
    spawnSync(executablePath, ["-L", socketName, "kill-server"], { stdio: "ignore" });

    const response = await request();
    expect(response.status).toBe(200);
    const body = StartupReadinessResourceSchemaZ.parse(await response.json());

    expect(body.ladder.blockedAt).toBe("catalog-populated");
    const catalog = body.ladder.rungs[3]!;
    expect(catalog.status).toBe("stuck");
    // A dead socket fails the discovery pass itself — the pinned runner cannot
    // enumerate at all — which is a different, more precise fact than
    // "the sessions are gone" and reports as such. Neither is an empty fleet.
    expect(catalog.status === "stuck" ? catalog.reason : null).toEqual({
      vocabulary: "startup-readiness",
      code: "catalog-discovery-failed",
    });
    // The rung above stays honestly pending rather than claiming readiness.
    expect(body.ladder.rungs[4]!.status).toBe("pending");
    // And the rungs below it are still proven.
    expect(body.ladder.rungs.slice(0, 3).every((rung) => rung.status === "satisfied")).toBe(true);
  });
});
