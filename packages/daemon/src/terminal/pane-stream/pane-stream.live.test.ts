/**
 * Pane-stream wire LIVE verification (m43 card 2) against a real tmux server
 * on an isolated `-L` socket (zz- prefixed, PID-scoped, killed in afterAll),
 * a real HTTP server carrying the real upgrade boundary, and real `ws`
 * clients.
 *
 * The card's acceptance: 3-pane session, one pane flooding — the quiet
 * panes' frames keep arriving to a healthy client while a stalled client's
 * delivery pauses alone; departure force-returns its tickets; the wire
 * transcript is audited for runtime ids.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamServerFrameSchemaZ,
} from "@tmux-ide/contracts";
import { MirrorService } from "../mirror/mirror-service.ts";
import { attachPaneStreamWebSocket } from "../../server/pane-stream-upgrade.ts";
import { PaneStreamLeaseManager } from "./lease-manager.ts";
import { PaneStreamAdmissionCoordinator } from "./pane-stream-websocket.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-m43-psw-${process.pid}-${randomUUID().slice(0, 8)}`;
const session = "zz-psw-src";
const INSTANCE = randomUUID();
const ORIGIN = "tmux-ide://app";

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
    timeout: 5_000,
  }).trimEnd();
}

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: Promise<void>;
}

function openClient(url: string): Promise<Client> {
  const ws = new WebSocket(url, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], { origin: ORIGIN });
  const frames: Array<Record<string, unknown>> = [];
  const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
  ws.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, frames, closed }));
    ws.on("error", reject);
  });
}

function framesOf(client: Client, type: string, pane?: string): Array<Record<string, unknown>> {
  return client.frames.filter(
    (frame) => frame.type === type && (pane === undefined || frame.pane === pane),
  );
}

function textOf(client: Client, pane: string): string {
  return client.frames
    .filter((frame) => frame.pane === pane)
    .map((frame) => {
      if (frame.type === "output") return Buffer.from(frame.data as string, "base64").toString();
      if (frame.type === "seed-batch") {
        const held = (frame.held as string[]).map((chunk) =>
          Buffer.from(chunk, "base64").toString(),
        );
        return Buffer.from(frame.seed as string, "base64").toString() + held.join("");
      }
      return "";
    })
    .join("");
}

describe.skipIf(!hasTmux)("pane-stream wire live", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], {
      stdio: "ignore",
      env: { ...process.env, TMUX: "" },
      timeout: 5_000,
    });
    try {
      rmSync(
        join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socketName),
      );
    } catch {
      // best effort
    }
  });

  it("streams three panes to real clients, isolates a stalled client, and force-returns its tickets", async () => {
    // ── Source session: three titled sh panes with on-screen markers ───────
    runTmux(["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "sh"]);
    runTmux(["split-window", "-d", "-t", session, "sh"]);
    runTmux(["split-window", "-d", "-t", session, "sh"]);
    runTmux(["select-layout", "-t", session, "tiled"]);
    const runtimePanes = runTmux(["list-panes", "-t", session, "-F", "#{pane_id}"]).split("\n");
    expect(runtimePanes).toHaveLength(3);
    const titles = ["psw-flood", "psw-quiet-b", "psw-quiet-c"] as const;
    runtimePanes.forEach((pane, index) => {
      runTmux(["select-pane", "-t", pane, "-T", titles[index]!]);
    });
    runTmux(["send-keys", "-t", runtimePanes[0]!, "echo SEED_F_$((21*2))", "Enter"]);
    runTmux(["send-keys", "-t", runtimePanes[1]!, "echo SEED_B_$((21*2))", "Enter"]);
    runTmux(["send-keys", "-t", runtimePanes[2]!, "echo SEED_C_$((21*2))", "Enter"]);
    await vi.waitFor(
      () => {
        for (const [index, marker] of ["SEED_F_42", "SEED_B_42", "SEED_C_42"].entries()) {
          expect(runTmux(["capture-pane", "-p", "-t", runtimePanes[index]!])).toContain(marker);
        }
      },
      { timeout: 15_000 },
    );

    // ── Real daemon-side stack: mirror, leases, coordinator, HTTP upgrade ──
    const mirror = new MirrorService({ socketName, configFile: "/dev/null" });
    const described = await mirror.describeSession(session);
    const idByTitle = new Map(described.panes.map((pane) => [pane.title, pane.semanticPaneId]));
    const floodPane = idByTitle.get(titles[0])!;
    const quietB = idByTitle.get(titles[1])!;
    const quietC = idByTitle.get(titles[2])!;
    expect(floodPane && quietB && quietC).toBeTruthy();

    const leaseManager = new PaneStreamLeaseManager({ daemonInstanceId: INSTANCE });
    const server: Server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    const wsUrl = `ws://127.0.0.1:${port}${PANE_STREAM_REDEEM_PATH}`;
    const coordinator = new PaneStreamAdmissionCoordinator({
      daemonInstanceId: INSTANCE,
      webSocketUrl: wsUrl,
      leaseManager,
      mirror,
      bindSessionRuntime: (descriptor) => {
        if (!descriptor.hostClientId) throw new Error("test host identity is required");
        return {
          generation: INSTANCE,
          session: descriptor.sessionName,
          clientId: descriptor.hostClientId,
          assertController: (pane?: string) => {
            if (pane && !descriptor.panes.includes(pane)) throw new Error("pane outside grant");
          },
          close: async () => undefined,
        };
      },
      // Small budgets so the stall trips fast under the flood.
      flowBudgets: {
        "ws-send-buffer": { maxOutstanding: 256 << 10, resumeAt: 64 << 10 },
        "renderer-backlog": { maxOutstanding: 512, resumeAt: 128 },
      },
    });
    const boundary = attachPaneStreamWebSocket(server, coordinator);

    const issue = (panes: string[], viewerMode: "interactive" | "read-only") => {
      const requestId = randomUUID();
      return coordinator
        .issue(
          {
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            workspaceName: "workspace.zz",
            panes,
            viewerMode,
          },
          {
            requestId,
            projectIdentity: "workspace.zz",
            sessionName: session,
            rendererOrigin: ORIGIN,
            hostClientId: `test-host:pane-stream:${requestId}`,
          },
        )
        .then((descriptor) => ({ descriptor, requestId }));
    };

    // Stalled client S watches the flood pane + one quiet pane (read-only);
    // healthy client H watches all three, interactively.
    const issuedS = await issue([floodPane, quietB], "read-only");
    const clientS = await openClient(wsUrl);
    clientS.ws.send(
      JSON.stringify({
        type: "redeem",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        ticket: issuedS.descriptor.redemptionTicket,
        requestId: issuedS.requestId,
        daemonInstanceId: INSTANCE,
      }),
    );
    const issuedH = await issue([floodPane, quietB, quietC], "interactive");
    const clientH = await openClient(wsUrl);
    clientH.ws.send(
      JSON.stringify({
        type: "redeem",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        ticket: issuedH.descriptor.redemptionTicket,
        requestId: issuedH.requestId,
        daemonInstanceId: INSTANCE,
      }),
    );
    await vi.waitFor(
      () => {
        expect(framesOf(clientS, "ready")).toHaveLength(1);
        expect(framesOf(clientH, "ready")).toHaveLength(1);
        expect(framesOf(clientS, "seed-batch")).toHaveLength(2);
        expect(framesOf(clientH, "seed-batch")).toHaveLength(3);
      },
      { timeout: 20_000 },
    );
    expect(textOf(clientS, floodPane)).toContain("SEED_F_42");
    expect(textOf(clientH, quietC)).toContain("SEED_C_42");

    // ── Stall S, then flood ────────────────────────────────────────────────
    clientS.ws.pause();
    // Keep the producer finite. An effectively unbounded `seq` can enqueue an
    // arbitrarily large PTY backlog before the test observes pause under host
    // load, making the later resume assertion measure drain time rather than
    // per-client flow isolation. This is still comfortably above the 256 KiB
    // admission budget while keeping recovery bounded.
    runTmux(["send-keys", "-t", runtimePanes[0]!, "seq 1 250000", "Enter"]);
    // The daemon parks ONLY S's flood-pane delivery: its ws-send-buffer
    // tickets stay outstanding past the budget.
    await vi.waitFor(
      () => {
        const snapshot = coordinator.flowSnapshot();
        const stalled = Object.values(snapshot).some(
          (panes) => (panes[floodPane]?.["ws-send-buffer"] ?? 0) > 256 << 10,
        );
        expect(stalled).toBe(true);
      },
      { timeout: 30_000 },
    );

    // The healthy client keeps receiving the flood AND the quiet panes.
    const floodBytesBefore = textOf(clientH, floodPane).length;
    runTmux(["send-keys", "-t", runtimePanes[1]!, "echo DURING_STALL_$((21*2))", "Enter"]);
    await vi.waitFor(
      () => {
        expect(textOf(clientH, quietB)).toContain("DURING_STALL_42");
        expect(textOf(clientH, floodPane).length).toBeGreaterThan(floodBytesBefore);
      },
      { timeout: 20_000 },
    );

    // ── Resume S: its own flow events + a fresh atomic seed batch arrive ──
    clientS.ws.resume();
    runTmux(["send-keys", "-t", runtimePanes[0]!, "C-c", ""]);
    await vi.waitFor(
      () => {
        const flow = framesOf(clientS, "flow", floodPane);
        const pausedIndex = flow.findIndex((frame) => frame.state === "paused");
        expect(pausedIndex).toBeGreaterThanOrEqual(0);
        expect(flow.slice(pausedIndex).some((frame) => frame.state === "resumed")).toBe(true);
        // The reseed lands strictly after the resume.
        expect(framesOf(clientS, "seed-batch", floodPane).length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 40_000 },
    );
    // S's quiet pane was never parked; its stall-era bytes arrive on resume.
    await vi.waitFor(
      () => {
        expect(textOf(clientS, quietB)).toContain("DURING_STALL_42");
      },
      { timeout: 20_000 },
    );

    // ── Live interactive input through the wire ────────────────────────────
    clientH.ws.send(
      JSON.stringify({
        type: "input",
        kind: "text",
        pane: quietC,
        seq: 1,
        data: "echo LIVE_INPUT_$((6*7))",
      }),
    );
    clientH.ws.send(
      JSON.stringify({ type: "input", kind: "key", pane: quietC, seq: 2, data: "Enter" }),
    );
    await vi.waitFor(
      () => {
        expect(framesOf(clientH, "input-ack", quietC).map((frame) => frame.seq)).toEqual([1, 2]);
        expect(textOf(clientH, quietC)).toContain("LIVE_INPUT_42");
      },
      { timeout: 20_000 },
    );

    // ── Departure force-returns S's tickets within a tick ─────────────────
    clientS.ws.close();
    await clientS.closed;
    await vi.waitFor(
      () => {
        const snapshot = coordinator.flowSnapshot();
        expect(Object.values(snapshot).some((panes) => Object.keys(panes).length > 2)).toBe(false);
        expect(Object.keys(snapshot).length).toBeLessThanOrEqual(1);
      },
      { timeout: 10_000 },
    );

    // ── Wire transcript audit: every frame parses; no runtime ids ─────────
    for (const client of [clientS, clientH]) {
      expect(client.frames.length).toBeGreaterThan(0);
      for (const frame of client.frames) {
        const parsed = PaneStreamServerFrameSchemaZ.parse(frame);
        const structural = { ...(parsed as Record<string, unknown>) };
        delete structural.seed;
        delete structural.held;
        delete structural.data;
        expect(JSON.stringify(structural)).not.toMatch(/[%@$][0-9]/u);
      }
    }

    // ── Teardown hygiene: no clients left, server not wedged ──────────────
    clientH.ws.close();
    await clientH.closed;
    await boundary.close();
    await mirror.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vi.waitFor(
      () => {
        expect(runTmux(["list-clients", "-t", session])).toBe("");
      },
      { timeout: 10_000 },
    );
    expect(runTmux(["list-sessions", "-F", "#{session_name}"])).toContain(session);
  });
});
