import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _setExecutor } from "@tmux-ide/tmux-bridge";
import {
  PINNED_SYNC_TMUX_TIMEOUT_MS,
  createPinnedWorkspaceTmuxRunner,
} from "./workspace-pane-creation.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** A private socket and a fake tmux; nothing here contacts a tmux server. */
async function authority(script: string) {
  const root = mkdtempSync("/tmp/tmux-ide-test-sync-");
  roots.push(root);
  const socket = join(root, "t.sock");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const executablePath = join(root, "fake-tmux");
  writeFileSync(executablePath, script);
  chmodSync(executablePath, 0o755);
  return { executablePath, socketSelector: { kind: "path" as const, path: socket } };
}

// Bug sweep, section A: one hung synchronous tmux call froze the whole daemon.
describe("synchronous pinned tmux calls are always bounded", () => {
  it("gives every call the default timeout when the caller names none, and kills for real", async () => {
    const seen: { timeout?: number; killSignal?: unknown }[] = [];
    const restore = _setExecutor(((_executable: string, _args: string[], options: object) => {
      seen.push(options as { timeout?: number; killSignal?: unknown });
      return "ok\n";
    }) as Parameters<typeof _setExecutor>[0]);
    try {
      const pinned = await authority("#!/bin/sh\nexit 0\n");
      expect(createPinnedWorkspaceTmuxRunner(pinned)(["display-message", "-p", "x"])).toBe("ok");
      createPinnedWorkspaceTmuxRunner(pinned, { timeoutMs: 250 })(["list-sessions"]);
    } finally {
      restore();
    }
    expect(PINNED_SYNC_TMUX_TIMEOUT_MS).toBe(5_000);
    expect(seen).toEqual([
      expect.objectContaining({ timeout: PINNED_SYNC_TMUX_TIMEOUT_MS, killSignal: "SIGKILL" }),
      expect.objectContaining({ timeout: 250, killSignal: "SIGKILL" }),
    ]);
  });

  it("returns control from a tmux client that never answers and ignores TERM", async () => {
    const pinned = await authority("#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n");
    const run = createPinnedWorkspaceTmuxRunner(pinned, { timeoutMs: 300 });
    const started = performance.now();
    expect(() => run(["display-message", "-p", "x"])).toThrow();
    // The daemon's thread is back well before a human would notice a freeze.
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 10_000);
});
