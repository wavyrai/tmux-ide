import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  _setTmuxRunner,
  spawnWidget,
  connectClient,
  resizeWidget,
  killWidget,
  killAll,
  getSession,
  listSessions,
} from "./pty-manager.ts";

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
      this.readyState = 3;
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      emitter.on(event, cb);
    },
  };
}

let restoreTmux: () => void;
let tmuxCalls: string[][];

beforeEach(() => {
  tmuxCalls = [];
  restoreTmux = _setTmuxRunner((...args: string[]) => {
    tmuxCalls.push(args);
    if (args[0] === "capture-pane") return "widget output";
    return "";
  });
});

afterEach(() => {
  killAll();
  restoreTmux();
});

describe("spawnWidget", () => {
  it("spawns a tmux session for a valid widget type", async () => {
    const sess = await spawnWidget("tasks", "test-session", "/tmp/project", 80, 24);
    assert.ok(sess);
    assert.strictEqual(sess.widgetType, "tasks");
    assert.strictEqual(sess.tmuxSession, "web-tasks");

    // Should have called new-session
    const newSessionCall = tmuxCalls.find((c) => c[0] === "new-session");
    assert.ok(newSessionCall);
    assert.ok(newSessionCall!.includes("web-tasks"));
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
  });

  it("is tracked in sessions map", async () => {
    await spawnWidget("warroom", "s", "/tmp", 80, 24);
    assert.ok(getSession("warroom"));
    assert.strictEqual(listSessions().size, 1);
  });
});

describe("connectClient", () => {
  it("adds client to session and sends initial content", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    const connected = connectClient("tasks", ws as unknown as import("ws").WebSocket);
    assert.strictEqual(connected, true);

    // Should have sent initial capture-pane content
    assert.ok(ws.sent.length > 0);
    assert.ok(ws.sent[0]!.includes("widget output"));
  });

  it("forwards WS input to tmux send-keys", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    connectClient("tasks", ws as unknown as import("ws").WebSocket);

    // Clear tmux calls from spawn/connect
    tmuxCalls.length = 0;

    // Simulate keyboard input from browser
    ws._emitter.emit("message", Buffer.from("keypress"));

    const sendKeysCall = tmuxCalls.find((c) => c[0] === "send-keys");
    assert.ok(sendKeysCall);
    assert.ok(sendKeysCall!.includes("keypress"));
  });

  it("handles resize JSON messages via tmux resize-window", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    const ws = createMockWs();
    connectClient("tasks", ws as unknown as import("ws").WebSocket);

    tmuxCalls.length = 0;

    ws._emitter.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 })),
    );

    const resizeCall = tmuxCalls.find((c) => c[0] === "resize-window");
    assert.ok(resizeCall);
    assert.ok(resizeCall!.includes("120"));
    assert.ok(resizeCall!.includes("40"));

    // Should NOT have forwarded as send-keys
    const sendKeysCall = tmuxCalls.find((c) => c[0] === "send-keys");
    assert.strictEqual(sendKeysCall, undefined);
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
});

describe("resizeWidget", () => {
  it("calls tmux resize-window", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    tmuxCalls.length = 0;

    resizeWidget("tasks", 120, 40);

    const resizeCall = tmuxCalls.find((c) => c[0] === "resize-window");
    assert.ok(resizeCall);
  });

  it("does nothing for non-existent widget", () => {
    resizeWidget("nonexistent", 80, 24); // should not throw
  });
});

describe("killWidget", () => {
  it("kills a specific widget session", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    assert.ok(getSession("tasks"));

    tmuxCalls.length = 0;
    killWidget("tasks");
    assert.strictEqual(getSession("tasks"), undefined);

    const killCall = tmuxCalls.find((c) => c[0] === "kill-session");
    assert.ok(killCall);
  });

  it("does nothing for non-existent widget", () => {
    killWidget("nonexistent"); // should not throw
  });
});

describe("killAll", () => {
  it("kills all widget sessions", async () => {
    await spawnWidget("tasks", "s", "/tmp", 80, 24);
    await spawnWidget("explorer", "s", "/tmp", 80, 24);
    assert.strictEqual(listSessions().size, 2);

    killAll();
    assert.strictEqual(listSessions().size, 0);
  });
});
