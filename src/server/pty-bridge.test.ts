import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter, once } from "node:events";
import { PtyBridge, type PtyExit } from "./pty-bridge.ts";

const bridges: PtyBridge[] = [];

function makeBridge(args: string[] = ["-i"]): PtyBridge {
  const bridge = new PtyBridge({
    shell: "/bin/sh",
    args,
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TERM: "xterm-256color",
    },
  });
  bridges.push(bridge);
  return bridge;
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

  it("attaches to a tmux pane when the id is session:paneId", () => {
    const execCalls: string[][] = [];
    const spawnCalls: string[][] = [];
    const tail = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: (signal?: NodeJS.Signals) => boolean;
      killed?: NodeJS.Signals;
    };
    tail.stdout = new EventEmitter();
    tail.stderr = new EventEmitter();
    tail.pid = 12345;
    tail.kill = (signal = "SIGTERM") => {
      tail.killed = signal;
      return true;
    };

    const bridge = new PtyBridge({
      id: "tmux-ide:%12",
      shell: "/bin/sh",
      tmux: {
        execFileSync: (_cmd, args) => {
          execCalls.push(args);
          if (args[0] === "display-message") return "tmux-ide\t%12\n";
          if (args[0] === "capture-pane") return "captured pane";
          return "";
        },
        spawn: (_cmd, args) => {
          spawnCalls.push(args);
          return tail as never;
        },
        mkdtempSync: () => "/tmp/tmux-ide-pty-test",
        writeFileSync: () => undefined,
        rmSync: () => undefined,
        tmpdir: () => "/tmp",
      },
    });
    bridges.push(bridge);

    let output = "";
    bridge.on("output", (bytes) => {
      output += bytes.toString("utf8");
    });

    bridge.spawn(100, 30);
    tail.stdout.emit("data", Buffer.from("live output"));
    bridge.write(Buffer.from("hello\r"));
    bridge.resize(120, 40);
    bridge.kill("SIGTERM");

    expect(bridge.running).toBe(false);
    expect(bridge.pid).toBeNull();
    expect(output).toContain("captured pane");
    expect(output).toContain("live output");
    expect(spawnCalls).toEqual([["-n", "+1", "-F", "/tmp/tmux-ide-pty-test/pane.log"]]);
    expect(execCalls).toContainEqual(["has-session", "-t", "tmux-ide"]);
    expect(execCalls).toContainEqual([
      "pipe-pane",
      "-o",
      "-t",
      "%12",
      "cat >> '/tmp/tmux-ide-pty-test/pane.log'",
    ]);
    expect(execCalls).toContainEqual(["send-keys", "-t", "%12", "-l", "--", "hello"]);
    expect(execCalls).toContainEqual(["send-keys", "-t", "%12", "Enter"]);
    expect(execCalls).toContainEqual(["resize-pane", "-t", "%12", "-x", "120", "-y", "40"]);
    expect(execCalls.at(-1)).toEqual(["pipe-pane", "-t", "%12"]);
    expect(tail.killed).toBe("SIGTERM");
  });
});
