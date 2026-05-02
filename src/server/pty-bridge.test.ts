import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter, once } from "node:events";
import { PtyBridge, type PtyExit } from "./pty-bridge.ts";

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
});
