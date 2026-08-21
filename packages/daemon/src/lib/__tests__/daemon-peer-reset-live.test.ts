import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectCanonicalDaemonInfo } from "../canonical-daemon.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { WorkspaceRegistry, _setDefaultWorkspaceRegistryForTests } from "../workspace-registry.ts";

describe.sequential("embedded daemon peer reset containment", () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

  let stateDir: string;
  let handle: EmbeddedDaemonHandle | null;
  let previousEnvironment: Record<string, string | undefined>;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "tmux-ide-daemon-reset-"));
    previousEnvironment = Object.fromEntries(
      [
        "TMUX_IDE_DAEMON_INFO_DIR",
        "TMUX_IDE_REGISTRY_DIR",
        "TMUX_IDE_SETTINGS_DIR",
        "TMUX_IDE_HOME",
      ].map((name) => [name, process.env[name]]),
    );
    process.env.TMUX_IDE_DAEMON_INFO_DIR = stateDir;
    process.env.TMUX_IDE_REGISTRY_DIR = stateDir;
    process.env.TMUX_IDE_SETTINGS_DIR = stateDir;
    process.env.TMUX_IDE_HOME = stateDir;
    _setDefaultWorkspaceRegistryForTests(
      new WorkspaceRegistry({ dir: stateDir, listSessions: () => [] }),
    );
    handle = null;
  });

  afterEach(async () => {
    await handle?.stop({ gracefulMs: 50 }).catch(() => undefined);
    handle = null;
    _setDefaultWorkspaceRegistryForTests(null);
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("survives a reset after HTTP hands an unmatched upgrade socket to the daemon", async () => {
    handle = await startEmbeddedDaemon({ silent: true });
    expect(handle.compatibilityTerminalAttachmentRuntimeConstructed()).toBe(false);

    const peer = connect({ host: "127.0.0.1", port: handle.port });
    await once(peer, "connect");
    peer.write(
      "GET /unmatched-upgrade HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    peer.resetAndDestroy();

    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await fetch(`${handle.apiBaseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(handle.compatibilityTerminalAttachmentRuntimeConstructed()).toBe(false);
    expect(inspectCanonicalDaemonInfo()).toMatchObject({
      status: "valid",
      info: { instanceId: handle.instanceId },
    });
  });
});
