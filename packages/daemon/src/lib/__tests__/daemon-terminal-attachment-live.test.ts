import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TerminalAttachmentIssueResultSchemaZ,
  type TerminalAttachmentIssueDescriptor,
} from "@tmux-ide/contracts";

import { inspectCanonicalDaemonInfo } from "../canonical-daemon.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { _setDefaultWorkspaceRegistryForTests, WorkspaceRegistry } from "../workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe
  .skipIf(!hasTmux)
  .sequential("embedded daemon direct attachment isolated tmux integration", () => {
    // Keep the canonicalized -S path below the Unix-domain socket limit on macOS.
    const root = mkdtempSync(join("/tmp", "tmux-ide-a2-live-"));
    const socketPath = join(root, "tmux.sock");
    const sessionName = "daemon-attachment-source";
    const workspaceName = "workspace.live-daemon";
    const semanticPaneId = "pane.live-daemon";
    const ownerToken = `owner-${randomUUID()}`;
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const previousEnvironment: Record<string, string | undefined> = {};
    let handle: EmbeddedDaemonHandle | null = null;

    const run = (argv: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...argv], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).replace(/(?:\r?\n)+$/u, "");

    beforeAll(() => {
      for (const name of [
        "TMUX",
        "TMUX_IDE_DAEMON_INFO_DIR",
        "TMUX_IDE_REGISTRY_DIR",
        "TMUX_IDE_SETTINGS_DIR",
        "TMUX_IDE_HOME",
      ]) {
        previousEnvironment[name] = process.env[name];
      }
      process.env.TMUX_IDE_DAEMON_INFO_DIR = root;
      process.env.TMUX_IDE_REGISTRY_DIR = join(root, "registry");
      process.env.TMUX_IDE_SETTINGS_DIR = join(root, "settings");
      process.env.TMUX_IDE_HOME = root;

      run(["-f", "/dev/null", "new-session", "-d", "-s", sessionName, "exec sleep 300"]);
      run(["set-option", "-p", "-t", `=${sessionName}:0.0`, "@tmux_ide_pane_id", semanticPaneId]);
      process.env.TMUX = `${socketPath},${process.pid},0`;

      const registry = new WorkspaceRegistry({
        dir: join(root, "registry"),
        listSessions: () => [sessionName],
      });
      registry.add({ name: workspaceName, sessionName, projectDir: root });
      _setDefaultWorkspaceRegistryForTests(registry);
    });

    afterAll(async () => {
      await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
      handle = null;
      _setDefaultWorkspaceRegistryForTests(null);
      spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });

    it("issues over HTTP, redeems over the direct boundary, launches node-pty, and drains before canonical retirement", async () => {
      expect(
        execFileSync(
          executablePath,
          ["-S", socketPath, "list-sessions", "-F", "#{session_name}\t#{session_id}"],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { TERM: process.env.TERM ?? "xterm-256color" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      ).toContain(sessionName);
      handle = await startEmbeddedDaemon({
        authToken: "remote-token-is-not-owner",
        localBypassToken: ownerToken,
        silent: true,
      });
      const requestId = randomUUID();
      const response = await fetch(`${handle.apiBaseUrl}/api/v1/terminal/attachments/issue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
          Origin: "tmux-ide://app",
          "X-Tmux-Ide-Expected-Daemon-Instance-Id": handle.instanceId,
          "X-Tmux-Ide-Request-Id": requestId,
        },
        body: JSON.stringify({
          requestId,
          expectedDaemonInstanceId: handle.instanceId,
          attachment: {
            protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
            target: { workspaceName, semanticPaneId },
            viewerMode: "interactive",
            viewport: { cols: 100, rows: 30 },
          },
        }),
      });
      const result = TerminalAttachmentIssueResultSchemaZ.parse(await response.json());
      expect(result.status).toBe("issued");
      if (result.status !== "issued") throw new Error(result.error.code);
      const descriptor: TerminalAttachmentIssueDescriptor = result.descriptor;
      expect(descriptor).toMatchObject({
        daemonInstanceId: handle.instanceId,
        requestId,
        effectiveViewerMode: "interactive",
      });

      const socket = new WebSocket(descriptor.webSocketUrl, descriptor.subprotocol, {
        origin: "tmux-ide://app",
      });
      const ready = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("direct attachment did not become ready")),
          5_000,
        );
        socket.on("error", reject);
        socket.on("message", (data, isBinary) => {
          if (isBinary) return;
          const parsed = JSON.parse(data.toString()) as { type?: string };
          if (parsed.type !== "ready") return;
          clearTimeout(timeout);
          resolve(parsed);
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(
        JSON.stringify({
          type: "redeem",
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          ticket: descriptor.redemptionTicket,
          requestId,
          daemonInstanceId: handle.instanceId,
        }),
      );

      await expect(ready).resolves.toMatchObject({
        type: "ready",
        sourceGrid: { cols: expect.any(Number), rows: expect.any(Number) },
        clientViewport: { cols: expect.any(Number), rows: expect.any(Number) },
      });
      expect(run(["list-sessions", "-F", "#{session_name}"])).toContain(sessionName);

      const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      await handle.stop({ gracefulMs: 500 });
      await expect(socketClosed).resolves.toBeUndefined();
      handle = null;

      expect(inspectCanonicalDaemonInfo().status).toBe("missing");
      expect(run(["list-sessions", "-F", "#{session_name}"])).toBe(sessionName);
    }, 15_000);
  });
