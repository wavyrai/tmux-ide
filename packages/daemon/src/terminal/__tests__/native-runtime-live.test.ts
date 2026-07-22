import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import {
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL,
  type DirectTerminalSocket,
} from "../attachments/direct-websocket.ts";
import {
  groupedTmuxViewSessionName,
  planGroupedTmuxAttachment,
} from "../attachments/grouped-tmux.ts";
import { createNativeTerminalAttachmentRuntime } from "../attachments/native-runtime.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

class LiveSocket extends EventEmitter implements DirectTerminalSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<{ data: string | Buffer; binary: boolean }> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({
      data: Buffer.isBuffer(data) ? Buffer.from(data) : data,
      binary: !!options?.binary,
    });
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }

  frame(data: string): void {
    this.emit("message", data, false);
  }
}

describe.skipIf(!hasTmux)("native attachment runtime isolated tmux integration", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-native-runtime-live-"));
  const socketName = `tmux-ide-a1-${process.pid}-${randomUUID().slice(0, 8)}`;
  const sessionName = "native-runtime-source";
  const workspaceName = "workspace.live-native";
  const semanticPaneId = "pane.live-agent";
  const daemonInstanceId = "daemon-native-live";
  const requestId = "cf59df74-d1fd-456b-afdf-b16f15b7b8ca";
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-L", socketName, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
    run(["-f", "/dev/null", "new-session", "-d", "-s", sessionName, "exec sleep 300"]);
    run(["set-option", "-p", "-t", `=${sessionName}:0.0`, "@tmux_ide_pane_id", semanticPaneId]);
  });

  afterAll(() => {
    spawnSync(executablePath, ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers, attaches, correlates geometry, and disposes on its isolated socket", async () => {
    const audits: Array<{ type: string; reason?: string }> = [];
    const registry = new WorkspaceRegistry({ dir: join(root, "registry"), listSessions: () => [] });
    registry.add({ name: workspaceName, sessionName, projectDir: root });
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId,
      webSocketUrl: "ws://127.0.0.1:6070/v1/terminal/attachments/redeem",
      registry,
      tmuxAuthority: {
        executablePath,
        socketSelector: { kind: "name", name: socketName },
        trustedCwd: root,
      },
      lease: { onAudit: (event) => audits.push({ type: event.type, reason: event.reason }) },
    });
    const issued = await runtime.admission.issue(
      {
        protocolVersion: 1,
        target: { workspaceName, semanticPaneId },
        viewerMode: "interactive",
        viewport: { cols: 100, rows: 30 },
      },
      { requestId, projectIdentity: "project-live", rendererOrigin: "tmux-ide://app" },
    );
    const upgrade = runtime.admission.reserveUpgrade({
      path: TERMINAL_ATTACHMENT_REDEEM_PATH,
      protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
      origin: "tmux-ide://app",
    });
    if (!upgrade.accepted) throw new Error(upgrade.code);
    const socket = new LiveSocket();
    upgrade.admission.bind(socket);
    socket.frame(
      JSON.stringify({
        type: "redeem",
        protocolVersion: 1,
        ticket: issued.redemptionTicket,
        requestId,
        daemonInstanceId,
      }),
    );

    try {
      await vi.waitFor(
        () => {
          const ready = socket.sent
            .filter((entry) => typeof entry.data === "string")
            .map((entry) => JSON.parse(entry.data as string) as { type?: string })
            .find((entry) => entry.type === "ready");
          expect({ ready, closes: socket.closes, audits }).toMatchObject({
            ready: {
              type: "ready",
              inputCapability: {
                mode: "bounded",
                limits: {
                  maxFrameBytes: 16 * 1024,
                  maxAcceptedBytes: 256 * 1024,
                  maxAcceptedFrames: 8_192,
                },
              },
              sourceGrid: { cols: expect.any(Number), rows: expect.any(Number) },
              clientViewport: { cols: expect.any(Number), rows: expect.any(Number) },
            },
            closes: [],
            audits: expect.arrayContaining([
              expect.objectContaining({ type: "issued" }),
              expect.objectContaining({ type: "redeemed" }),
            ]),
          });
        },
        { timeout: 3_000 },
      );
      expect(runtime.snapshot().liveConnections).toBe(1);
    } finally {
      await runtime.dispose();
    }
    expect(runtime.snapshot()).toMatchObject({ liveConnections: 0, shuttingDown: true });
    expect(run(["list-sessions", "-F", "#{session_name}"])).toBe(sessionName);
  }, 10_000);

  it("removes a strictly marked view left by a simulated crash before restart readiness", async () => {
    const orphanAttachmentId = randomUUID();
    const [sourceSessionId, sourceWindowId, sourcePaneId, sourcePaneCount] = run([
      "list-panes",
      "-t",
      `=${sessionName}:0.0`,
      "-F",
      "#{session_id}\t#{window_id}\t#{pane_id}\t#{window_panes}",
    ]).split("\t");
    if (!sourceSessionId || !sourceWindowId || !sourcePaneId || sourcePaneCount !== "1") {
      throw new Error("isolated source pane discovery failed");
    }
    const orphanPlan = planGroupedTmuxAttachment({
      attachmentId: orphanAttachmentId,
      generation: 0,
      target: { workspaceName, semanticPaneId },
      viewerMode: "interactive",
      viewport: { cols: 100, rows: 30 },
      source: {
        sessionId: sourceSessionId,
        windowId: sourceWindowId,
        runtimePaneId: sourcePaneId,
        paneCount: 1,
      },
    });
    // This is the durable tmux state a daemon process crash leaves behind:
    // the prior in-memory lease/admission owner is gone, but its strictly
    // named and marked one-window view remains on the shared tmux socket.
    run(orphanPlan.create.command.argv);
    const orphanViewName = groupedTmuxViewSessionName(orphanAttachmentId, 0);
    const viewExists = (): boolean =>
      spawnSync(executablePath, ["-L", socketName, "has-session", "-t", `=${orphanViewName}`], {
        cwd: root,
        stdio: "ignore",
      }).status === 0;
    expect(viewExists()).toBe(true);

    const registry = new WorkspaceRegistry({
      dir: join(root, "restart-registry"),
      listSessions: () => [],
    });
    registry.add({ name: workspaceName, sessionName, projectDir: root });
    const restarted = createNativeTerminalAttachmentRuntime({
      daemonInstanceId: `${daemonInstanceId}-restart`,
      webSocketUrl: "ws://127.0.0.1:6070/v1/terminal/attachments/redeem",
      registry,
      tmuxAuthority: {
        executablePath,
        socketSelector: { kind: "name", name: socketName },
        trustedCwd: root,
      },
    });

    // Construction starts reconciliation, but readiness is the publication
    // barrier. The orphan is still observable until that barrier completes.
    expect(viewExists()).toBe(true);
    await expect(restarted.whenReady()).resolves.toBeUndefined();
    expect(viewExists()).toBe(false);
    await expect(
      restarted.admission.issue(
        {
          protocolVersion: 1,
          target: { workspaceName, semanticPaneId },
          viewerMode: "interactive",
          viewport: { cols: 100, rows: 30 },
        },
        {
          requestId: randomUUID(),
          projectIdentity: "project-live-restarted",
          rendererOrigin: "tmux-ide://app",
        },
      ),
    ).resolves.toMatchObject({ daemonInstanceId: `${daemonInstanceId}-restart` });
    await restarted.dispose();
  }, 10_000);
});
