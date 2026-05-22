import { describe, it, expect, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { NgrokService, _setSpawnForTesting } from "./ngrok.ts";

function makeChild(hooks: {
  onReady?: (stdout: EventEmitter, stderr: EventEmitter, proc: EventEmitter) => void;
}): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  proc.stdout = stdout as NodeJS.ReadableStream;
  proc.stderr = stderr as NodeJS.ReadableStream;
  proc.pid = 9001;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    queueMicrotask(() => proc.emit("close", 0));
    return true;
  };
  queueMicrotask(() => hooks.onReady?.(stdout, stderr, proc));
  return proc as ChildProcess;
}

describe("NgrokService", () => {
  let restore: () => void = () => {};

  afterEach(() => {
    restore();
    restore = () => {};
  });

  it("parses public URL from JSON log line on stdout", async () => {
    const mockSpawn = (_cmd: string, args: string[]) => {
      if (args[0] === "version") {
        return makeChild({
          onReady: (_out, _err, proc) => proc.emit("close", 0),
        });
      }
      if (args[0] === "http") {
        return makeChild({
          onReady: (stdout) => {
            const line = `${JSON.stringify({
              msg: "started tunnel",
              url: "https://abc-123.ngrok-free.app",
            })}\n`;
            stdout.emit("data", Buffer.from(line, "utf8"));
          },
        });
      }
      return makeChild({ onReady: (_o, _e, proc) => proc.emit("close", 0) });
    };
    restore = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new NgrokService({ port: 5555, startupTimeoutMs: 5000 });
    const tunnel = await svc.start();
    expect(tunnel.publicUrl).toBe("https://abc-123.ngrok-free.app");
    await svc.stop();
  });

  it("rejects when ngrok binary is not found", async () => {
    const mockSpawn = (_cmd: string, args: string[]) => {
      if (args[0] === "version") {
        return makeChild({
          onReady: (_o, _e, proc) => proc.emit("close", 1),
        });
      }
      return makeChild({ onReady: (_o, _e, proc) => proc.emit("close", 0) });
    };
    restore = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new NgrokService({ port: 5555 });
    await expect(svc.start()).rejects.toThrow(/ngrok binary not found/);
  });

  it("rejects on startup timeout when no tunnel URL appears", async () => {
    const mockSpawn = (cmd: string, args: string[]) => {
      if (args[0] === "version") {
        return makeChild({
          onReady: (_o, _e, proc) => proc.emit("close", 0),
        });
      }
      return makeChild({
        onReady: () => {
          /* no stdout */
        },
      });
    };
    restore = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new NgrokService({ port: 5555, startupTimeoutMs: 40 });
    await expect(svc.start()).rejects.toThrow(/Ngrok startup timeout/);
  });
});
