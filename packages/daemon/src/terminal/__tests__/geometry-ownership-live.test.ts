import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

  frame(data: string): void {
    this.emit("message", data, false);
  }

  controlFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry) => typeof entry.data === "string")
      .map((entry) => JSON.parse(entry.data as string) as Record<string, unknown>);
  }
}

/**
 * m50.2 gap 1, against real tmux.
 *
 * The claim under test cannot be made by a unit test, because it is a claim
 * about what tmux does: an attachment issued with `geometryOwnership: "owner"`
 * is spawned WITHOUT `-f ignore-size`, so its client counts in tmux's window
 * size calculation, and a resize sent down that attachment resizes the ORIGIN
 * window — the same window object the durable session holds, reached through a
 * linked window rather than a copy.
 *
 * Two proofs, because either alone is weak. The origin window's own
 * `#{window_width}x#{window_height}` must change (tmux's own answer, read by a
 * separate tmux invocation, not the daemon's report of itself), and a SECOND
 * real client attached to the durable session must see the same size — which is
 * what makes this a fact about the window rather than about one client's view.
 *
 * The passive half is asserted in `native-runtime-multipane-live.test.ts`, whose
 * whole premise is that the origin stays byte-identical. This file only ever
 * touches its own session, so the two cannot interfere.
 */
describe.skipIf(!hasTmux)("m50.2 geometry ownership, live", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join(tmpdir(), "tmux-ide-m50-owner-"));
  const socketName = `tmux-ide-m50-${process.pid}-${randomUUID().slice(0, 8)}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const heldClients: PtyProcess[] = [];
  const SESSION = "owner-origin";
  const HELD_COLS = 200;
  const HELD_ROWS = 50;

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-L", socketName, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  /** tmux's own answer for the origin window's size, asked from outside the daemon. */
  const windowGrid = (): { cols: number; rows: number } => {
    const [width, height] = run([
      "display-message",
      "-p",
      "-t",
      `=${SESSION}:0`,
      "#{window_width}\t#{window_height}",
    ]).split("\t");
    return { cols: Number(width), rows: Number(height) };
  };

  /** Every client of the durable session, as tmux reports them. */
  const clientSizes = (): string[] =>
    run(["list-clients", "-t", `=${SESSION}`, "-F", "#{client_width}x#{client_height}"])
      .split("\n")
      .filter((line) => line.length > 0);

  beforeAll(async () => {
    run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      String(HELD_COLS),
      "-y",
      String(HELD_ROWS),
      "exec sleep 300",
    ]);
    run(["split-window", "-t", `${SESSION}:0`, "-d", "exec sleep 300"]);
    run(["select-layout", "-t", `${SESSION}:0`, "tiled"]);
    const paneIds = run(["list-panes", "-t", `${SESSION}:0`, "-F", "#{pane_id}"]).split("\n");
    paneIds.forEach((paneId, index) => {
      run(["set-option", "-p", "-t", paneId, "@tmux_ide_pane_id", `pane.owner.${index}`]);
    });
    run(["set-option", "-w", "-t", `${SESSION}:0`, "@tmux_ide_window_id", "window.owner"]);

    /*
     * A second REAL client on the durable session.
     *
     * It is the observer the second proof needs — a stand-in for the ssh session
     * or the terminal the user also has this session open in. It is deliberately
     * a plain `tmux attach`, with none of the daemon's flags.
     */
    heldClients.push(
      defaultNodePtyAdapter.spawnSync(
        {
          shell: executablePath,
          args: ["-L", socketName, "attach", "-t", `=${SESSION}`],
          cwd: root,
          cols: HELD_COLS,
          rows: HELD_ROWS,
          env: { ...process.env, TERM: "xterm-256color" },
          name: "xterm-256color",
          encoding: null,
        },
        { onData: () => undefined, onExit: () => undefined },
      ),
    );
    await vi.waitFor(
      () => {
        expect(clientSizes()).toContain(`${HELD_COLS}x${HELD_ROWS}`);
        // The status line costs the window one row against the client height.
        expect(windowGrid()).toEqual({ cols: HELD_COLS, rows: HELD_ROWS - 1 });
      },
      { timeout: 20_000, interval: 100 },
    );
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

  async function driveOwningAttach(viewport: { cols: number; rows: number }) {
    const registry = new WorkspaceRegistry({
      dir: join(root, `registry-${randomUUID().slice(0, 6)}`),
      listSessions: () => [],
    });
    registry.add({ name: "workspace.owner", sessionName: SESSION, projectDir: root });
    const daemonInstanceId = "daemon-m50-owner";
    const requestId = randomUUID();
    const runtime = createNativeTerminalAttachmentRuntime({
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
    const issued = await runtime.admission.issue(
      {
        protocolVersion: 1,
        target: { workspaceName: "workspace.owner", semanticPaneId: "pane.owner.0" },
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport,
      },
      { requestId, projectIdentity: "project-owner", rendererOrigin: "tmux-ide://app" },
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
    await vi.waitFor(
      () => {
        expect({
          ready: socket.controlFrames().some((frame) => frame.type === "ready"),
          closes: socket.closes,
        }).toEqual({ ready: true, closes: [] });
      },
      { timeout: 25_000 },
    );
    return { runtime, socket, issued };
  }

  it("resizes the ORIGIN window, is seen by a second client, and releases on dispose", async () => {
    const before = windowGrid();
    expect(before).toEqual({ cols: HELD_COLS, rows: HELD_ROWS - 1 });

    const OWNED = { cols: 96, rows: 28 };
    const { runtime, socket, issued } = await driveOwningAttach(OWNED);
    try {
      // The daemon says what it granted, and it is what was asked for.
      expect(issued.effectiveGeometryOwnership).toBe("owner");

      /*
       * PROOF ONE: tmux's own answer for the origin window changed.
       *
       * Bug this catches: the attach still carries `-f ignore-size`, so tmux
       * excludes the view client and the window stays at the other client's
       * 200 columns — the app renders a 96-column card around a 200-column
       * window and letterboxes the difference, which is the entire defect gap 1
       * exists to remove.
       *
       * The view session sets `status off`, so its client spends no row on a
       * status line and the window height is the client height exactly.
       */
      await vi.waitFor(
        () => {
          expect(windowGrid()).toEqual(OWNED);
        },
        { timeout: 20_000, interval: 100 },
      );

      /*
       * PROOF TWO: the second real client sees it too.
       *
       * This is what makes it a fact about the WINDOW. A client reporting its
       * own requested size proves nothing; the observer never asked for 96x28
       * and is not the daemon's, so its agreement is tmux's.
       */
      expect(
        run(["display-message", "-p", "-t", `=${SESSION}:0`, "#{window_width}x#{window_height}"]),
      ).toBe(`${OWNED.cols}x${OWNED.rows}`);
      expect(clientSizes()).toContain(`${HELD_COLS}x${HELD_ROWS}`);

      /*
       * A resize down the attachment moves the origin again — the loop the
       * renderer closes on every window drag, not just at attach time.
       */
      const RESIZED = { cols: 132, rows: 34 };
      socket.frame(
        JSON.stringify({
          type: "resize",
          protocolVersion: 1,
          generation: 0,
          viewport: RESIZED,
        }),
      );
      await vi.waitFor(
        () => {
          expect(windowGrid()).toEqual(RESIZED);
        },
        { timeout: 20_000, interval: 100 },
      );
    } finally {
      await runtime.dispose();
    }

    /*
     * RELEASING the attachment releases ownership.
     *
     * The remaining client is the plain 200x50 one, so tmux returns the window
     * to its size. Bug this catches: a disposed attachment leaves the window
     * pinned to the size of an app that is no longer running, which the user
     * would only discover as a permanently shrunken session.
     */
    await vi.waitFor(
      () => {
        expect(windowGrid()).toEqual({ cols: HELD_COLS, rows: HELD_ROWS - 1 });
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(run(["list-sessions", "-F", "#{session_name}"]).split("\n")).toEqual([SESSION]);
  });
});
