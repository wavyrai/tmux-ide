import { describe, it, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { CloudflareService, _setSpawnForTesting } from "./cloudflare.ts";

function makeChild(hooks: {
  onReady?: (stdout: EventEmitter, stderr: EventEmitter, proc: EventEmitter) => void;
}): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  proc.stdout = stdout as NodeJS.ReadableStream;
  proc.stderr = stderr as NodeJS.ReadableStream;
  proc.pid = 9002;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    queueMicrotask(() => proc.emit("close", 0));
    return true;
  };
  queueMicrotask(() => hooks.onReady?.(stdout, stderr, proc));
  return proc as ChildProcess;
}

describe("CloudflareService", () => {
  let restore: () => void = () => {};

  afterEach(() => {
    restore();
    restore = () => {};
  });

  it("parses trycloudflare.com URL from stdout", async () => {
    const mockSpawn = (_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        return makeChild({
          onReady: (_o, _e, proc) => proc.emit("close", 0),
        });
      }
      if (args[0] === "tunnel") {
        return makeChild({
          onReady: (stdout) => {
            const msg =
              "Your quick Tunnel has been created! Visit https://random-words-abc123.trycloudflare.com\n";
            stdout.emit("data", Buffer.from(msg, "utf8"));
          },
        });
      }
      return makeChild({ onReady: (_o, _e, proc) => proc.emit("close", 0) });
    };
    restore = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new CloudflareService(7777, { startupTimeoutMs: 5000 });
    const tunnel = await svc.start();
    expect(tunnel.publicUrl).toBe("https://random-words-abc123.trycloudflare.com");
    await svc.stop();
  });

  it("rejects when cloudflared is not installed", async () => {
    const mockSpawn = (_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        return makeChild({
          onReady: (_o, _e, proc) => proc.emit("close", 1),
        });
      }
      return makeChild({ onReady: (_o, _e, proc) => proc.emit("close", 0) });
    };
    restore = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new CloudflareService(7777);
    await expect(svc.start()).rejects.toThrow(/cloudflared binary not found/);
  });
});
