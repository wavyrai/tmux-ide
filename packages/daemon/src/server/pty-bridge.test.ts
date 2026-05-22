import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PtyBridge, TerminalCwdError, assertValidCwd, type PtyExit } from "./pty-bridge.ts";

const bridges: PtyBridge[] = [];

function makeBridge(args: string[] = ["-i"]): PtyBridge {
  const bridge = new PtyBridge({
    shell: "/bin/sh",
    args,
    cwd: process.cwd(),
    coalesceMs: 0,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TERM: "xterm-256color",
    },
  });
  bridges.push(bridge);
  return bridge;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakePty() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    cols: number;
    rows: number;
    write: (data: string | Buffer) => void;
    resize: (cols: number, rows: number) => void;
    kill: (signal?: NodeJS.Signals) => void;
    onData: (listener: (data: unknown) => void) => { dispose: () => void };
    onExit: (listener: (exit: { exitCode: number; signal?: number | null }) => void) => {
      dispose: () => void;
    };
  };
  child.pid = 12345;
  child.cols = 100;
  child.rows = 30;
  child.write = () => undefined;
  child.resize = (cols, rows) => {
    child.cols = cols;
    child.rows = rows;
  };
  child.kill = (signal = "SIGTERM") => {
    child.emit("exit", { exitCode: 0, signal: signal === "SIGTERM" ? 15 : 9 });
  };
  child.onData = (listener) => {
    child.on("data", listener);
    return { dispose: () => child.off("data", listener) };
  };
  child.onExit = (listener) => {
    child.on("exit", listener);
    return { dispose: () => child.off("exit", listener) };
  };
  return child;
}

async function waitForOutput(bridge: PtyBridge, needle: string, timeoutMs = 5000): Promise<string> {
  let collected = "";

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      bridge.off("output", onOutput);
      reject(new Error(`Timed out waiting for output: ${needle}\n${collected}`));
    }, timeoutMs);

    const onOutput = (bytes: Buffer) => {
      collected += bytes.toString("utf8");
      if (collected.includes(needle)) {
        clearTimeout(timeout);
        bridge.off("output", onOutput);
        resolve(collected);
      }
    };

    bridge.on("output", onOutput);
  });
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    bridge.kill("SIGKILL");
  }
});

describe("PtyBridge", () => {
  it("spawns a real shell with requested dimensions", () => {
    const bridge = makeBridge();
    bridge.spawn(80, 24);

    expect(bridge.running).toBe(true);
    expect(bridge.pid).toBeGreaterThan(0);
    expect(bridge.cols).toBe(80);
    expect(bridge.rows).toBe(24);
  });

  it("writes input bytes and emits shell output", async () => {
    const bridge = makeBridge();
    bridge.spawn(80, 24);

    bridge.write(Buffer.from("echo tmux-ide-pty\r"));

    const output = await waitForOutput(bridge, "tmux-ide-pty");
    expect(output).toContain("tmux-ide-pty");
  });

  it("resizes the PTY", () => {
    const bridge = makeBridge();
    bridge.spawn(80, 24);

    bridge.resize(120, 40);

    expect(bridge.cols).toBe(120);
    expect(bridge.rows).toBe(40);
  });

  it("emits exit when the process terminates", async () => {
    const bridge = new PtyBridge({ shell: "/bin/sleep", args: ["60"], cwd: process.cwd() });
    bridges.push(bridge);
    const exitPromise = once(bridge, "exit") as Promise<[PtyExit]>;
    bridge.spawn(80, 24);
    bridge.kill("SIGTERM");

    const [exit] = await exitPromise;
    expect(exit.code).toBeNumber();
    expect(exit.signal).toBeNumber();
    expect(bridge.running).toBe(false);
  });

  it("terminates a running process with SIGTERM", async () => {
    const bridge = makeBridge(["-c", "trap 'exit 42' TERM; while true; do sleep 1; done"]);
    bridge.spawn(80, 24);

    const exitPromise = once(bridge, "exit") as Promise<[PtyExit]>;
    bridge.kill("SIGTERM");

    const [exit] = await exitPromise;
    expect(exit.code === 42 || exit.signal !== null).toBe(true);
    expect(bridge.running).toBe(false);
  });

  it("spawns the requested command in the requested cwd", () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> =
      [];
    const child = fakePty();

    const bridge = new PtyBridge({
      env: { PATH: process.env.PATH, TERM: "xterm-256color" },
      coalesceMs: 0,
      pty: {
        spawn: (command, args, options) => {
          spawnCalls.push({ command, args, options: options as Record<string, unknown> });
          return child as never;
        },
      },
      statCwd: () => ({ isDirectory: () => true }) as fs.Stats,
    });
    bridges.push(bridge);

    bridge.spawn(100, 30, { cwd: "/tmp/project-dir", cmd: ["tmux-ide", "--flag"] });
    bridge.resize(120, 40);

    expect(bridge.running).toBe(true);
    expect(bridge.pid).toBe(12345);
    expect(bridge.cols).toBe(120);
    expect(bridge.rows).toBe(40);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe("tmux-ide");
    expect(spawnCalls[0]?.args).toEqual(["--flag"]);
    expect(spawnCalls[0]?.options.cwd).toBe("/tmp/project-dir");
    expect(spawnCalls[0]?.options.cols).toBe(100);
    expect(spawnCalls[0]?.options.rows).toBe(30);
  });

  it("coalesces many output chunks into one batch", async () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 20,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);
    const outputs: string[] = [];
    bridge.on("output", (bytes) => outputs.push(bytes.toString("utf8")));

    bridge.spawn(80, 24);
    child.emit("data", Buffer.from("a"));
    child.emit("data", Buffer.from("b"));
    child.emit("data", Buffer.from("c"));

    expect(outputs).toEqual([]);
    await sleep(35);
    expect(outputs).toEqual(["abc"]);
  });

  it("disables coalescing when coalesceMs is zero", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);
    const outputs: string[] = [];
    bridge.on("output", (bytes) => outputs.push(bytes.toString("utf8")));

    bridge.spawn(80, 24);
    child.emit("data", Buffer.from("a"));
    child.emit("data", Buffer.from("b"));

    expect(outputs).toEqual(["a", "b"]);
  });

  it("pause holds output and resume flushes it in order", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);
    const outputs: string[] = [];
    bridge.on("output", (bytes) => outputs.push(bytes.toString("utf8")));

    bridge.spawn(80, 24);
    bridge.pause();
    child.emit("data", Buffer.from("a"));
    child.emit("data", Buffer.from("b"));
    expect(outputs).toEqual([]);

    bridge.resume();
    expect(outputs).toEqual(["ab"]);
  });

  it("keeps replay output in FIFO order within the ring capacity", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      ringBufferBytes: 5,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);

    bridge.spawn(80, 24);
    child.emit("data", Buffer.from("abc"));
    child.emit("data", Buffer.from("def"));

    expect(bridge.getReplayBuffer().toString("utf8")).toBe("bcdef");
  });

  it("returns a contiguous replay buffer and clears it on explicit flush", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      ringBufferBytes: 64,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);

    bridge.spawn(80, 24);
    child.emit("data", Buffer.from("one"));
    child.emit("data", Buffer.from("two"));

    expect(bridge.getReplayBuffer()).toEqual(Buffer.from("onetwo"));
    bridge.flushReplayBuffer();
    expect(bridge.getReplayBuffer().byteLength).toBe(0);
  });

  it("clears replay output when the PTY exits", async () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);

    bridge.spawn(80, 24);
    child.emit("data", Buffer.from("before-exit"));
    expect(bridge.getReplayBuffer().byteLength).toBeGreaterThan(0);
    child.emit("exit", { exitCode: 0, signal: null });

    await waitForOutputOnce();
    expect(bridge.getReplayBuffer().byteLength).toBe(0);
  });
});

async function waitForOutputOnce(): Promise<void> {
  await sleep(0);
}

describe("assertValidCwd", () => {
  it("accepts an existing directory", () => {
    expect(() => assertValidCwd(process.cwd())).not.toThrow();
  });

  it("throws TerminalCwdError(notFound) when the path does not exist", () => {
    const missing = path.join(os.tmpdir(), `tmux-ide-missing-${Date.now()}-${Math.random()}`);
    let caught: unknown;
    try {
      assertValidCwd(missing);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TerminalCwdError);
    const cwdErr = caught as TerminalCwdError;
    expect(cwdErr.reason).toBe("notFound");
    expect(cwdErr.cwd).toBe(missing);
  });

  it("throws TerminalCwdError(notDirectory) when the path is a file", () => {
    const tmpFile = path.join(os.tmpdir(), `tmux-ide-file-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(tmpFile, "");
    try {
      let caught: unknown;
      try {
        assertValidCwd(tmpFile);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TerminalCwdError);
      const cwdErr = caught as TerminalCwdError;
      expect(cwdErr.reason).toBe("notDirectory");
      expect(cwdErr.cwd).toBe(tmpFile);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it("throws TerminalCwdError(statFailed) when stat fails for non-ENOENT reasons", () => {
    const target = "/forbidden";
    const stub = (() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }) as unknown as (cwd: string) => fs.Stats;
    let caught: unknown;
    try {
      assertValidCwd(target, stub);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TerminalCwdError);
    const cwdErr = caught as TerminalCwdError;
    expect(cwdErr.reason).toBe("statFailed");
    expect(cwdErr.cwd).toBe(target);
    expect((cwdErr.cause as NodeJS.ErrnoException | undefined)?.code).toBe("EACCES");
  });
});

describe("PtyBridge cwd validation", () => {
  it("spawn refuses a non-existent cwd with TerminalCwdError", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);

    const missing = path.join(os.tmpdir(), `tmux-ide-missing-spawn-${Date.now()}`);
    let caught: unknown;
    try {
      bridge.spawn(80, 24, { cwd: missing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TerminalCwdError);
    expect((caught as TerminalCwdError).reason).toBe("notFound");
    expect(bridge.running).toBe(false);
    expect(bridge.getCwd()).toBeNull();
  });

  it("spawn records the cwd via getCwd on success", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);

    bridge.spawn(80, 24, { cwd: process.cwd() });
    expect(bridge.getCwd()).toBe(process.cwd());
  });
});

describe("PtyBridge restartWith", () => {
  it("stops the running process and spawns again with the new cwd", () => {
    const spawnCalls: Array<{ command: string; options: Record<string, unknown> }> = [];
    let killed = false;
    const makeChild = () => {
      const c = fakePty();
      const baseKill = c.kill.bind(c);
      c.kill = (signal) => {
        killed = true;
        baseKill(signal);
      };
      return c;
    };

    let nextChild = makeChild();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: {
        spawn: (command, _args, options) => {
          spawnCalls.push({ command, options: options as Record<string, unknown> });
          const c = nextChild;
          nextChild = makeChild();
          return c as never;
        },
      },
    });
    bridges.push(bridge);

    const cwdA = process.cwd();
    const cwdB = os.tmpdir();
    bridge.spawn(80, 24, { cwd: cwdA, cmd: ["/bin/sh", "-i"] });
    expect(bridge.getCwd()).toBe(cwdA);

    bridge.restartWith(120, 40, { cwd: cwdB, cmd: ["/bin/sh", "-i"] });

    expect(killed).toBe(true);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.options.cwd).toBe(cwdA);
    expect(spawnCalls[1]?.options.cwd).toBe(cwdB);
    expect(spawnCalls[1]?.options.cols).toBe(120);
    expect(spawnCalls[1]?.options.rows).toBe(40);
    expect(bridge.getCwd()).toBe(cwdB);
    expect(bridge.running).toBe(true);
  });

  it("clears replay buffer across a restart", () => {
    const child1 = fakePty();
    const child2 = fakePty();
    let nth = 0;
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: {
        spawn: () => {
          nth += 1;
          return (nth === 1 ? child1 : child2) as never;
        },
      },
    });
    bridges.push(bridge);

    bridge.spawn(80, 24, { cwd: process.cwd() });
    child1.emit("data", Buffer.from("old-output"));
    expect(bridge.getReplayBuffer().byteLength).toBeGreaterThan(0);

    bridge.restartWith(80, 24, { cwd: os.tmpdir() });
    expect(bridge.getReplayBuffer().byteLength).toBe(0);
  });

  it("restartWith propagates TerminalCwdError when the new cwd is invalid", () => {
    const child = fakePty();
    const bridge = new PtyBridge({
      coalesceMs: 0,
      pty: { spawn: () => child as never },
    });
    bridges.push(bridge);

    bridge.spawn(80, 24, { cwd: process.cwd() });
    const missing = path.join(os.tmpdir(), `tmux-ide-restart-missing-${Date.now()}`);
    let caught: unknown;
    try {
      bridge.restartWith(80, 24, { cwd: missing });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TerminalCwdError);
    expect((caught as TerminalCwdError).reason).toBe("notFound");
    // Old process was already stopped. The bridge is now in a "no
    // running PTY" state; the caller (ws-route) decides whether to
    // close the socket.
    expect(bridge.running).toBe(false);
  });
});
