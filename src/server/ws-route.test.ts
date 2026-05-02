import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { handlePtyWebSocket } from "./ws-route.ts";
import { PtyBridge, type PtyBridgeOptions, type PtySpawnOptions } from "./pty-bridge.ts";

class MockWebSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{ data: string | Buffer; options?: { binary?: boolean } }> = [];
  closeCount = 0;

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({ data, options });
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closeCount += 1;
    this.emit("close");
  }

  receive(data: string | Buffer, isBinary = false): void {
    this.emit("message", data, isBinary);
  }

  clientClose(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

class FakeBridge extends EventEmitter {
  cols: number | null = null;
  rows: number | null = null;
  spawnOptions: PtySpawnOptions | null = null;
  running = false;
  writes: Buffer[] = [];
  killed: NodeJS.Signals[] = [];
  pauseCount = 0;
  resumeCount = 0;
  paused = false;
  pendingOutput: Buffer[] = [];

  spawn(cols: number, rows: number, options?: PtySpawnOptions): void {
    this.cols = cols;
    this.rows = rows;
    this.spawnOptions = options ?? null;
    this.running = true;
  }

  write(bytes: Buffer): void {
    this.writes.push(bytes);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    this.running = false;
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  resume(): void {
    this.resumeCount += 1;
    this.paused = false;
    if (this.pendingOutput.length === 0) return;
    const pending = Buffer.concat(this.pendingOutput);
    this.pendingOutput = [];
    this.emit("output", pending);
  }

  emitOutput(bytes: Buffer): void {
    if (this.paused) {
      this.pendingOutput.push(bytes);
      return;
    }
    this.emit("output", bytes);
  }
}

const bridges: PtyBridge[] = [];

function makeBridge(options: PtyBridgeOptions = {}): PtyBridge {
  const bridge = new PtyBridge({
    shell: "/bin/sh",
    args: ["-i"],
    cwd: process.cwd(),
    coalesceMs: 0,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TERM: "xterm-256color",
    },
    ...options,
  });
  bridges.push(bridge);
  return bridge;
}

function textFrames(ws: MockWebSocket): string[] {
  return ws.sent.filter((frame) => typeof frame.data === "string").map((frame) => frame.data);
}

function jsonFrames(ws: MockWebSocket): Array<Record<string, unknown>> {
  return textFrames(ws)
    .filter((frame) => frame.startsWith("{"))
    .map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) {
    bridge.kill("SIGKILL");
  }
  delete process.env.TMUX_IDE_PTY_BACKPRESSURE_BYTES;
});

describe("handlePtyWebSocket", () => {
  it("parses a valid init frame and spawns the PTY", async () => {
    const ws = new MockWebSocket();
    let bridge: PtyBridge | null = null;
    const connection = handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        bridge = makeBridge();
        return bridge;
      },
    });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));

    await waitFor(() => bridge?.running === true, "PTY spawn");
    expect(connection.getBridge()).toBe(bridge);
    expect(bridge?.cols).toBe(80);
    expect(bridge?.rows).toBe(24);
    expect(jsonFrames(ws).find((frame) => frame.type === "error")).toBeUndefined();
  });

  it("passes init cwd and cmd to the bridge", async () => {
    const ws = new MockWebSocket();
    let bridge: FakeBridge | null = null;
    handlePtyWebSocket(ws, "project-tab", {
      createBridge: () => {
        bridge = new FakeBridge();
        return bridge;
      },
    });

    ws.receive(
      JSON.stringify({
        type: "init",
        cols: 100,
        rows: 30,
        cwd: "/tmp/project-dir",
        cmd: ["tmux-ide"],
      }),
    );

    await waitFor(() => bridge?.running === true, "fake PTY spawn");
    expect(bridge?.cols).toBe(100);
    expect(bridge?.rows).toBe(30);
    expect(bridge?.spawnOptions).toEqual({ cwd: "/tmp/project-dir", cmd: ["tmux-ide"] });
  });

  it("rejects invalid JSON init frames", () => {
    const ws = new MockWebSocket();
    let created = false;
    handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        created = true;
        return makeBridge();
      },
    });

    ws.receive("{bad json");

    expect(created).toBe(false);
    expect(jsonFrames(ws)[0]?.type).toBe("error");
    expect(ws.closeCount).toBe(1);
  });

  it("rejects init frames with missing fields", () => {
    const ws = new MockWebSocket();
    handlePtyWebSocket(ws, "default");

    ws.receive(JSON.stringify({ type: "init", cols: 80 }));

    const [error] = jsonFrames(ws);
    expect(error?.type).toBe("error");
    expect(String(error?.message)).toContain("cols and rows");
    expect(ws.closeCount).toBe(1);
  });

  it("rejects init frames with invalid cwd", () => {
    const ws = new MockWebSocket();
    handlePtyWebSocket(ws, "default");

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24, cwd: 42 }));

    const [error] = jsonFrames(ws);
    expect(error?.type).toBe("error");
    expect(String(error?.message)).toContain("cwd must be a string");
    expect(ws.closeCount).toBe(1);
  });

  it("rejects init frames with invalid cmd", () => {
    const ws = new MockWebSocket();
    handlePtyWebSocket(ws, "default");

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24, cmd: [] }));

    const [error] = jsonFrames(ws);
    expect(error?.type).toBe("error");
    expect(String(error?.message)).toContain("cmd must be a non-empty string array");
    expect(ws.closeCount).toBe(1);
  });

  it("rejects input before init", () => {
    const ws = new MockWebSocket();
    handlePtyWebSocket(ws, "default");

    ws.receive("echo too-soon\n");

    const [error] = jsonFrames(ws);
    expect(error?.type).toBe("error");
    expect(String(error?.message)).toContain("init frame required");
    expect(ws.closeCount).toBe(1);
  });

  it("forwards resize controls to the PTY", async () => {
    const ws = new MockWebSocket();
    let bridge: FakeBridge | null = null;
    handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        bridge = new FakeBridge();
        return bridge;
      },
    });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    await waitFor(() => bridge?.cols === 80 && bridge?.rows === 24, "fake PTY spawn");
    ws.receive(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

    await waitFor(() => bridge?.cols === 120 && bridge?.rows === 40, "fake PTY resize");
  });

  it("sends an error for invalid resize frames", async () => {
    const ws = new MockWebSocket();
    let bridge: FakeBridge | null = null;
    handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        bridge = new FakeBridge();
        return bridge;
      },
    });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    await waitFor(() => bridge?.cols === 80 && bridge?.rows === 24, "fake PTY spawn");
    ws.receive(JSON.stringify({ type: "resize", cols: "wide", rows: 40 }));

    const error = jsonFrames(ws).find((frame) => frame.type === "error");
    expect(error?.message).toBe("resize requires positive integer cols and rows");
    expect(ws.closeCount).toBe(1);
  });

  it("forwards text and binary input frames to PTY stdin", async () => {
    const ws = new MockWebSocket();
    handlePtyWebSocket(ws, "default", { createBridge: () => makeBridge() });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    ws.receive("echo ws-text-input\r");
    ws.receive(Buffer.from("echo ws-binary-input\r"), true);

    await waitFor(() => {
      const output = Buffer.concat(
        ws.sent.filter((frame) => Buffer.isBuffer(frame.data)).map((frame) => frame.data as Buffer),
      ).toString("utf8");
      return output.includes("ws-text-input") && output.includes("ws-binary-input");
    }, "PTY output for text and binary input");
  });

  it("forwards PTY output as binary WebSocket frames", async () => {
    const ws = new MockWebSocket();
    handlePtyWebSocket(ws, "default", { createBridge: () => makeBridge() });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    ws.receive("echo ws-output\r");

    await waitFor(
      () =>
        ws.sent.some(
          (frame) =>
            Buffer.isBuffer(frame.data) && frame.data.toString("utf8").includes("ws-output"),
        ),
      "binary PTY output",
    );

    expect(ws.sent.some((frame) => Buffer.isBuffer(frame.data) && frame.options?.binary)).toBe(
      true,
    );
  });

  it("pauses bridge output on high WebSocket bufferedAmount and resumes after drain", async () => {
    process.env.TMUX_IDE_PTY_BACKPRESSURE_BYTES = "10";
    const ws = new MockWebSocket();
    let bridge: FakeBridge | null = null;
    handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        bridge = new FakeBridge();
        return bridge;
      },
    });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    await waitFor(() => bridge?.running === true, "fake PTY spawn");

    ws.bufferedAmount = 11;
    bridge?.emitOutput(Buffer.from("first"));
    bridge?.emitOutput(Buffer.from("second"));

    expect(bridge?.pauseCount).toBeGreaterThan(0);
    expect(
      ws.sent.filter((frame) => Buffer.isBuffer(frame.data)).map((frame) => frame.data),
    ).toEqual([Buffer.from("first")]);

    ws.bufferedAmount = 4;
    await waitFor(() => (bridge?.resumeCount ?? 0) > 0, "bridge resume after drain");

    expect(
      ws.sent.filter((frame) => Buffer.isBuffer(frame.data)).map((frame) => frame.data),
    ).toEqual([Buffer.from("first"), Buffer.from("second")]);
  });

  it("sends an exit frame and closes when the PTY exits", async () => {
    const ws = new MockWebSocket();
    let bridge: PtyBridge | null = null;
    const connection = handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        bridge = makeBridge({ shell: "/bin/sleep", args: ["60"] });
        return bridge;
      },
    });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    await waitFor(() => connection.getBridge() !== null && bridge?.running === true, "PTY bridge");
    connection.getBridge()?.kill("SIGTERM");

    await waitFor(() => jsonFrames(ws).some((frame) => frame.type === "exit"), "exit frame");
    const exit = jsonFrames(ws).find((frame) => frame.type === "exit");
    expect(exit?.code).toBeNumber();
    expect(exit?.signal).toBeNumber();
    expect(ws.closeCount).toBe(1);
  });

  it("sends SIGTERM to the PTY when the WebSocket closes", async () => {
    const ws = new MockWebSocket();
    let bridge: PtyBridge | null = null;
    handlePtyWebSocket(ws, "default", {
      createBridge: () => {
        bridge = makeBridge(["-c", "trap 'exit 42' TERM; while true; do sleep 1; done"]);
        return bridge;
      },
    });

    ws.receive(JSON.stringify({ type: "init", cols: 80, rows: 24 }));
    await waitFor(() => bridge?.running === true, "PTY spawn");
    ws.clientClose();

    await waitFor(() => bridge?.running === false, "PTY SIGTERM exit");
  });
});
