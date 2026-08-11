import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { encodeTerminalAttachmentInputFrame } from "@tmux-ide/contracts/terminal-attachment-stream";

import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { defaultNodePtyAdapter } from "../NodePtyAdapter.ts";
import type { PtyProcess } from "../PtyAdapter.ts";
import {
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL,
  type DirectTerminalSocket,
} from "../attachments/direct-websocket.ts";
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

  /** A control (text) frame from the renderer. */
  frame(data: string): void {
    this.emit("message", data, false);
  }

  /** A binary input frame from the renderer. */
  binary(data: Uint8Array): void {
    this.emit("message", Buffer.from(data), true);
  }

  controlFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry) => typeof entry.data === "string")
      .map((entry) => JSON.parse(entry.data as string) as Record<string, unknown>);
  }
}

/**
 * m41 attach-2 live acceptance. A real 9-pane window and a real 2-pane window,
 * each in its own isolated session with a held interactive client that owns the
 * window's size, are attached through the real daemon runtime
 * (issue -> redeem -> execute). The card's invariants are asserted against
 * ground truth: the render grid (`sourceGrid`) equals the whole window's client
 * size (not a single pane, not the small view client), the origin session is
 * byte-identical before/after including under a view-client resize attempt
 * (proving `ignore-size` holds), and typed input lands in the active pane.
 */
describe.skipIf(!hasTmux)("m41 attach-2 multi-pane live acceptance", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join(tmpdir(), "tmux-ide-m41-accept-"));
  const socketName = `tmux-ide-m41-${process.pid}-${randomUUID().slice(0, 8)}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const heldClients: PtyProcess[] = [];

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-L", socketName, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  /** Exact ground-truth snapshot of a whole session's window+pane geometry. */
  const originSnapshot = (sessionName: string): string =>
    [
      run([
        "list-windows",
        "-t",
        `=${sessionName}`,
        "-F",
        "#{window_id}\t#{window_index}\t#{window_panes}\t#{window_width}x#{window_height}\t#{window_layout}\t#{@tmux_ide_window_id}",
      ]),
      run([
        "list-panes",
        "-s",
        "-t",
        `=${sessionName}`,
        "-F",
        "#{window_id}\t#{pane_id}\t#{pane_width}x#{pane_height}@#{pane_left},#{pane_top}\t#{@tmux_ide_pane_id}",
      ]),
    ].join("\n----\n");

  const windowGrid = (sessionName: string): { cols: number; rows: number } => {
    const [width, height] = run([
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:0`,
      "#{window_width}\t#{window_height}",
    ]).split("\t");
    return { cols: Number(width), rows: Number(height) };
  };

  async function setupSession(
    sessionName: string,
    paneCount: number,
    stampPrefix: string,
    windowStamp: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
      "exec sleep 300",
    ]);
    for (let index = 1; index < paneCount; index += 1) {
      run(["split-window", "-t", `${sessionName}:0`, "-d", "exec sleep 300"]);
      run(["select-layout", "-t", `${sessionName}:0`, "tiled"]);
    }
    const paneIds = run(["list-panes", "-t", `${sessionName}:0`, "-F", "#{pane_id}"]).split("\n");
    paneIds.forEach((paneId, index) => {
      run(["set-option", "-p", "-t", paneId, "@tmux_ide_pane_id", `${stampPrefix}.${index}`]);
    });
    run(["set-option", "-w", "-t", `${sessionName}:0`, "@tmux_ide_window_id", windowStamp]);
    // The interactive size owner. Without a non-ignore-size client viewing the
    // window, a sole ignore-size view client would still drive its size; with it
    // present, ignore-size fully excludes the view client from the calculation.
    heldClients.push(
      defaultNodePtyAdapter.spawnSync(
        {
          shell: executablePath,
          args: ["-L", socketName, "attach", "-t", `=${sessionName}`],
          cwd: root,
          cols,
          rows,
          env: { ...process.env, TERM: "xterm-256color" },
          name: "xterm-256color",
          encoding: null,
        },
        { onData: () => undefined, onExit: () => undefined },
      ),
    );
    // The client attaches asynchronously and reduces the window by the status
    // line; wait until it is attached and the window size is settled.
    await vi.waitFor(
      () => {
        expect(
          run(["list-clients", "-t", `=${sessionName}`, "-F", "#{client_width}x#{client_height}"]),
        ).toContain(`${cols}x${rows}`);
        expect(windowGrid(sessionName)).toEqual({ cols, rows: rows - 1 });
      },
      { timeout: 20_000, interval: 100 },
    );
  }

  beforeAll(async () => {
    await setupSession("accept-nine", 9, "pane.nine", "window.nine", 220, 55);
    await setupSession("accept-two", 2, "pane.two", "window.two", 200, 50);
  });

  afterAll(() => {
    for (const client of heldClients) {
      try {
        client.kill("SIGKILL");
      } catch {
        // The server kill below reaps every client either way.
      }
    }
    spawnSync(executablePath, ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  async function driveAttach(
    workspaceName: string,
    sessionName: string,
    semanticPaneId: string,
    geometryOwnership: "passive" | "owner" = "passive",
  ) {
    const registry = new WorkspaceRegistry({
      dir: join(root, `registry-${randomUUID().slice(0, 6)}`),
      listSessions: () => [],
    });
    registry.add({ name: workspaceName, sessionName, projectDir: root });
    const daemonInstanceId = "daemon-m41-accept";
    const requestId = randomUUID();
    const runtime = createNativeTerminalAttachmentRuntime({
      daemonInstanceId,
      webSocketUrl: "ws://127.0.0.1:6070/v1/terminal/attachments/redeem",
      registry,
      admission: {
        bindSessionRuntime: () => ({
          generation: daemonInstanceId,
          session: sessionName,
          clientId: `test-host:multipane:${requestId}`,
          assertController: () => undefined,
          close: async () => undefined,
        }),
      },
      tmuxAuthority: {
        executablePath,
        socketSelector: { kind: "name", name: socketName },
        trustedCwd: root,
      },
    });
    await runtime.whenReady();
    const issued = await runtime.admission.issue(
      {
        protocolVersion: 1,
        target: { workspaceName, semanticPaneId },
        viewerMode: "interactive",
        geometryOwnership,
        viewport: { cols: 100, rows: 30 },
      },
      {
        requestId,
        projectIdentity: "project-accept",
        rendererOrigin: "tmux-ide://app",
        hostClientId: `test-host:multipane:${requestId}`,
      },
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
    const ready = await vi.waitFor(
      () => {
        const readyFrame = socket.controlFrames().find((frame) => frame.type === "ready");
        expect({ readyFrame, closes: socket.closes }).toMatchObject({
          readyFrame: {
            type: "ready",
            sourceGrid: { cols: expect.any(Number), rows: expect.any(Number) },
            clientViewport: { cols: expect.any(Number), rows: expect.any(Number) },
          },
          closes: [],
        });
        return readyFrame as {
          sourceGrid: { cols: number; rows: number };
          clientViewport: { cols: number; rows: number };
        };
      },
      { timeout: 25_000 },
    );
    return { runtime, socket, ready };
  }

  it("attaches a real 9-pane window: window-sized grid, origin byte-identical, input lands", async () => {
    const sessionName = "accept-nine";
    const before = originSnapshot(sessionName);
    const expectedGrid = windowGrid(sessionName);

    const { runtime, socket, ready } = await driveAttach(
      "workspace.nine",
      sessionName,
      "pane.nine.0",
    );
    try {
      // (a) The render grid is the whole 9-pane window's client size, not one
      // pane and not the small (100x30) size-passive view client.
      expect(ready.sourceGrid).toEqual(expectedGrid);
      expect(ready.clientViewport).toEqual({ cols: 100, rows: 30 });
      const activePane = run(["display-message", "-p", "-t", `=${sessionName}:0`, "#{pane_id}"]);
      const paneWidth = Number(run(["display-message", "-p", "-t", activePane, "#{pane_width}"]));
      expect(paneWidth).toBeLessThan(ready.sourceGrid.cols);

      // (b) The origin session is byte-identical after attach.
      expect(originSnapshot(sessionName)).toBe(before);

      // (b) ...and stays byte-identical under a view-client resize attempt.
      socket.frame(
        JSON.stringify({
          type: "resize",
          protocolVersion: 1,
          generation: 0,
          viewport: { cols: 50, rows: 18 },
        }),
      );
      await vi.waitFor(
        () => {
          expect(socket.controlFrames().some((frame) => frame.type === "geometry")).toBe(true);
        },
        { timeout: 15_000 },
      );
      expect(originSnapshot(sessionName)).toBe(before);
      expect(windowGrid(sessionName)).toEqual(expectedGrid);

      // (c) Input typed through the attachment lands in the window's active pane.
      const marker = "ZZM41_INPUT_LANDED";
      socket.binary(encodeTerminalAttachmentInputFrame(1, Buffer.from(marker)));
      await vi.waitFor(
        () => {
          expect(run(["capture-pane", "-p", "-t", activePane])).toContain(marker);
        },
        { timeout: 15_000 },
      );
    } finally {
      await runtime.dispose();
    }

    // Disposal removed the daemon view and the origin is still intact.
    expect(originSnapshot(sessionName)).toBe(before);
    expect(run(["list-sessions", "-F", "#{session_name}"]).split("\n").sort()).toEqual([
      "accept-nine",
      "accept-two",
    ]);
  });

  it("attaches a real 2-pane window with the window as the render grid", async () => {
    const sessionName = "accept-two";
    const before = originSnapshot(sessionName);
    const expectedGrid = windowGrid(sessionName);

    const { runtime, ready } = await driveAttach("workspace.two", sessionName, "pane.two.0");
    try {
      expect(ready.sourceGrid).toEqual(expectedGrid);
      expect(ready.clientViewport).toEqual({ cols: 100, rows: 30 });
      expect(originSnapshot(sessionName)).toBe(before);
    } finally {
      await runtime.dispose();
    }
    expect(originSnapshot(sessionName)).toBe(before);
  });

  it("INVERTS for an owner: the same window resizes, and returns when it releases", async () => {
    /*
     * The owner-mode twin of the assertion above, on the same session and the
     * same 2-pane window (m50.2, gap 1).
     *
     * The passive test's whole claim is `originSnapshot` byte-identical before
     * and after. That claim is exactly what geometry ownership is FOR inverting,
     * so it is asserted here in the negative rather than deleted — keeping both
     * on one window is what proves the difference is the ownership flag and not
     * something about the session, the pane count or the order of the suite.
     *
     * It runs last and restores the window, so the passive assertions above
     * still see the session they were written against.
     */
    const sessionName = "accept-two";
    const before = originSnapshot(sessionName);
    const beforeGrid = windowGrid(sessionName);

    const { runtime } = await driveAttach("workspace.two", sessionName, "pane.two.0", "owner");
    try {
      /*
       * Bug this catches: `-f ignore-size` survives into an owning attach, so
       * the app's measured 100x30 is discarded and the window stays at the held
       * client's size — gap 1 silently absent, with the contract still claiming
       * ownership was granted.
       */
      await vi.waitFor(
        () => {
          expect(windowGrid(sessionName)).toEqual({ cols: 100, rows: 30 });
        },
        { timeout: 20_000, interval: 100 },
      );
      expect(originSnapshot(sessionName)).not.toBe(before);
    } finally {
      await runtime.dispose();
    }

    /*
     * Releasing gives the window back to the held client, byte for byte.
     *
     * Bug this catches: a disposed attachment leaves the session pinned to the
     * size of an app that is no longer running — which a user would meet as a
     * permanently shrunken tmux session with nothing left to blame.
     */
    await vi.waitFor(
      () => {
        expect(windowGrid(sessionName)).toEqual(beforeGrid);
        expect(originSnapshot(sessionName)).toBe(before);
      },
      { timeout: 20_000, interval: 100 },
    );
  });
});
