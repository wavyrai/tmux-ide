/**
 * Uses `_setSpawnForTesting` only — `tailscale.ts` does not call `execFileSync` (no stub needed).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  TailscaleServeServiceImpl,
  _setSpawnForTesting,
  _setTestSkipTailscaleFsPaths,
} from "./tailscale.ts";

function makeChild(emitOnSpawn: (c: EventEmitter & Partial<ChildProcess>) => void): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  proc.stdout = stdout as NodeJS.ReadableStream;
  proc.stderr = stderr as NodeJS.ReadableStream;
  proc.pid = 4242;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    queueMicrotask(() => proc.emit("exit", 0, null));
    return true;
  };
  queueMicrotask(() => emitOnSpawn(proc));
  return proc as ChildProcess;
}

describe("TailscaleServeServiceImpl", () => {
  let restoreSpawn: () => void;

  beforeEach(() => {
    _setTestSkipTailscaleFsPaths(true);
  });

  afterEach(() => {
    _setTestSkipTailscaleFsPaths(false);
    restoreSpawn?.();
    restoreSpawn = () => {};
  });

  it("rejects when Tailscale is not installed (which exits non-zero)", async () => {
    const mockSpawn = mock((_cmd: string, args: string[]) => {
      return makeChild((proc) => {
        if (_cmd === "which" && args[0] === "tailscale") {
          proc.emit("exit", 1, null);
        } else {
          proc.emit("exit", 0, null);
        }
      });
    });
    restoreSpawn = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new TailscaleServeServiceImpl();
    await expect(svc.start(4020, false)).rejects.toThrow(/Tailscale command not found/);
  });

  it("start completes when serve --bg exits 0 and stop resets serve", async () => {
    const mockSpawn = mock((cmd: string, args: string[]) => {
      return makeChild((proc) => {
        if (cmd === "which") {
          proc.emit("exit", 0, null);
          return;
        }
        if (args[0] === "serve" && args[1] === "reset") {
          proc.emit("exit", 0, null);
          return;
        }
        if (args[0] === "serve" && args[1] === "--bg") {
          proc.emit("exit", 0, null);
          return;
        }
        proc.emit("exit", 0, null);
      });
    });
    restoreSpawn = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new TailscaleServeServiceImpl();
    await svc.start(4020, false);
    // With `serve --bg`, the CLI exits after configuring; `cleanup()` clears `currentPort` (VibeTunnel behavior).
    await svc.stop();
    const serveResets = mockSpawn.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1][0] === "serve" && c[1][1] === "reset",
    );
    expect(serveResets.length).toBeGreaterThanOrEqual(1);
  });

  it("status() returns a TunnelStatus-shaped object", async () => {
    const mockSpawn = mock(() =>
      makeChild((proc) => {
        proc.emit("exit", 0, null);
      }),
    );
    restoreSpawn = _setSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);

    const svc = new TailscaleServeServiceImpl();
    await svc.start(4020, false);
    const st = await svc.status();
    expect(typeof st.running).toBe("boolean");
    expect(st).toHaveProperty("meta");
  });
});
