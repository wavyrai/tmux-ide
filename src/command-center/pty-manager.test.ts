import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  _setPtySpawner,
  spawnWidget,
  connectClient,
  resizeWidget,
  killWidget,
  killAll,
  getSession,
  listSessions,
  type PtySession,
} from "./pty-manager.ts";

// --- Mock PTY ---

interface MockPty {
  written: string[];
  resizes: { cols: number; rows: number }[];
  killed: boolean;
  pid: number;
  _emitter: EventEmitter;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  // Test helpers
  simulateData: (data: string) => void;
  simulateExit: (code: number) => void;
}

function createMockPty(): MockPty {
  const emitter = new EventEmitter();
  return {
    written: [],
    resizes: [],
    killed: false,
    pid: 12345,
    _emitter: emitter,
    onData(cb: (data: string) => void) {
      emitter.on("data", cb);
    },
    onExit(cb: (e: { exitCode: number }) => void) {
      emitter.on("exit", cb);
    },
    write(data: string) {
      this.written.push(data);
    },
    resize(cols: number, rows: number) {
      this.resizes.push({ cols, rows });
    },
    kill() {
      this.killed = true;
      emitter.emit("exit", { exitCode: 0 });
    },
    simulateData(data: string) {
      emitter.emit("data", data);
    },
    simulateExit(code: number) {
      emitter.emit("exit", { exitCode: code });
    },
  };
}

// --- Mock WebSocket ---

interface MockWs {
  readyState: number;
  sent: string[];
  closed: boolean;
  _emitter: EventEmitter;
  send: (data: string) => void;
  close: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

function createMockWs(): MockWs {
  const emitter = new EventEmitter();
  return {
    readyState: 1, // OPEN
    sent: [],
    closed: false,
    _emitter: emitter,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
      this.readyState = 3; // CLOSED
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      emitter.on(event, cb);
    },
  };
}

let restorePty: () => void;
let lastMockPty: MockPty;
let spawnCalls: { file: string; args: string[]; cwd: string }[];

beforeEach(() => {
  spawnCalls = [];
  restorePty = _setPtySpawner((file, args, options) => {
    spawnCalls.push({ file, args, cwd: options.cwd });
    lastMockPty = createMockPty();
    return lastMockPty;
  });
});

afterEach(() => {
  killAll();
  restorePty();
});

describe("spawnWidget", () => {
  it("spawns a PTY for a valid widget type", async () => {
    const sess = await spawnWidget("tasks", "test-session", "/tmp/project", 80, 24);
    assert.ok(sess);
    assert.strictEqual(sess.widgetType, "tasks");
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0]!.file, "bun");
    assert.ok(spawnCalls[0]!.args[0]!.includes("tasks/index.tsx"));
    assert.ok(spawnCalls[0]!.args.some((a) => a.includes("--session=test-session")));
    assert.ok(spawnCalls[0]!.args.some((a) => a.includes("--dir=/tmp/project")));
  });

  it("rejects invalid widget types", async () => {
    await assert.rejects(
      () => spawnWidget("invalid", "s", "/tmp", 80, 24),
      /Invalid widget type/,
    );
  });

  it("returns existing session for already-spawned widget", async () => {
    const first = await spawnWidget("explorer", "s", "/tmp", 80, 24);
    const second = await spawnWidget("explorer", "s", "/tmp", 80, 24);
    assert.strictEqual(first, second);
    assert.strictEqual(spawnCalls.length, 1); // only spawned once
  });

  it("is tracked in sessions map", async () => {
    await spawnWidget("warroom", "s", "/tmp", 80, 24);
    assert.ok(getSession("warroom"));
    assert.strictEqual(listSessions().size, 1);
  });
});

describe("connectClient", () => {
  it("adds client to session and forwards PTY output", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    const connected = connectClient("tasks", ws as unknown as import("ws").WebSocket);
    assert.strictEqual(connected, true);

    // PTY output → WS client
    lastMockPty.simulateData("hello from pty");
    assert.strictEqual(ws.sent.length, 1);
    assert.strictEqual(ws.sent[0], "hello from pty");
  });

  it("forwards WS input to PTY", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    connectClient("tasks", ws as unknown as import("ws").WebSocket);

    // Simulate keyboard input from browser
    ws._emitter.emit("message", Buffer.from("keypress"));
    assert.strictEqual(lastMockPty.written.length, 1);
    assert.strictEqual(lastMockPty.written[0], "keypress");
  });

  it("handles resize JSON messages", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    connectClient("tasks", ws as unknown as import("ws").WebSocket);

    // Simulate resize message from browser
    ws._emitter.emit("message", Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })));

    assert.strictEqual(lastMockPty.written.length, 0); // not forwarded as input
    assert.strictEqual(lastMockPty.resizes.length, 1);
    assert.deepStrictEqual(lastMockPty.resizes[0], { cols: 120, rows: 40 });
  });

  it("removes client on WS close", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    connectClient("tasks", ws as unknown as import("ws").WebSocket);

    const sess = getSession("tasks")!;
    assert.strictEqual(sess.clients.size, 1);

    ws._emitter.emit("close");
    assert.strictEqual(sess.clients.size, 0);
  });

  it("returns false and closes WS for non-existent widget", () => {
    const ws = createMockWs();
    const connected = connectClient("nonexistent", ws as unknown as import("ws").WebSocket);
    assert.strictEqual(connected, false);
    assert.strictEqual(ws.closed, true);
  });

  it("broadcasts PTY output to multiple clients", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    connectClient("tasks", ws1 as unknown as import("ws").WebSocket);
    connectClient("tasks", ws2 as unknown as import("ws").WebSocket);

    lastMockPty.simulateData("broadcast");
    assert.strictEqual(ws1.sent.length, 1);
    assert.strictEqual(ws2.sent.length, 1);
  });

  it("skips closed clients during broadcast", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    ws2.readyState = 3; // CLOSED
    connectClient("tasks", ws1 as unknown as import("ws").WebSocket);
    connectClient("tasks", ws2 as unknown as import("ws").WebSocket);

    lastMockPty.simulateData("data");
    assert.strictEqual(ws1.sent.length, 1);
    assert.strictEqual(ws2.sent.length, 0); // skipped
  });
});

describe("resizeWidget", () => {
  it("resizes the PTY", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    resizeWidget("tasks", 120, 40);
    assert.deepStrictEqual(lastMockPty.resizes[0], { cols: 120, rows: 40 });
  });

  it("does nothing for non-existent widget", () => {
    // Should not throw
    resizeWidget("nonexistent", 80, 24);
  });
});

describe("killWidget", () => {
  it("kills a specific widget PTY", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    assert.ok(getSession("tasks"));

    killWidget("tasks");
    assert.strictEqual(getSession("tasks"), undefined);
    assert.strictEqual(lastMockPty.killed, true);
  });

  it("does nothing for non-existent widget", () => {
    killWidget("nonexistent"); // should not throw
  });
});

describe("killAll", () => {
  it("kills all PTY sessions", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const tasksPty = lastMockPty;
    await spawnWidget("explorer", "s", "/tmp", 80, 24);
    const explorerPty = lastMockPty;

    assert.strictEqual(listSessions().size, 2);

    killAll();
    assert.strictEqual(listSessions().size, 0);
    assert.strictEqual(tasksPty.killed, true);
    assert.strictEqual(explorerPty.killed, true);
  });
});

describe("PTY exit cleanup", () => {
  it("removes session and closes clients when PTY exits", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    connectClient("tasks", ws as unknown as import("ws").WebSocket);

    assert.ok(getSession("tasks"));

    lastMockPty.simulateExit(0);

    assert.strictEqual(getSession("tasks"), undefined);
    assert.strictEqual(ws.closed, true);
  });
});
