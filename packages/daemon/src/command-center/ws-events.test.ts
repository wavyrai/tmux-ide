import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTasksDir, saveMission, saveTask, taskStore } from "../lib/task-store.ts";
import { appendEvent, eventLogEmitter } from "../lib/event-log.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import { handleWsEventsConnection, _stopSessionsPollerForTests } from "./ws-events.ts";
import { makePane, makeTask } from "../__tests__/support.ts";
import type { ServerFrame } from "../schemas/ws-events.ts";
import { createServer } from "node:http";
import { attachWsEvents, createApp } from "./server.ts";
import { getRequestListener } from "@hono/node-server";
import WebSocket from "ws";

class MockWebSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }

  receive(text: string): void {
    this.emit("message", text, false);
  }

  clientClose(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function frames(ws: MockWebSocket): ServerFrame[] {
  return ws.sent.map((s) => JSON.parse(s) as ServerFrame);
}

function framesByType<T extends ServerFrame["type"]>(
  ws: MockWebSocket,
  type: T,
): Extract<ServerFrame, { type: T }>[] {
  return frames(ws).filter((f): f is Extract<ServerFrame, { type: T }> => f.type === type);
}

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let tmpDir: string;
let tmpDirOther: string;
let restorePane: () => void;
let restoreTmux: () => void;
let mockPanes: PaneInfo[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-ws-events-"));
  tmpDirOther = mkdtempSync(join(tmpdir(), "tmux-ide-ws-events-other-"));
  ensureTasksDir(tmpDir);
  ensureTasksDir(tmpDirOther);
  mockPanes = [makePane({ id: "%1", index: 0, title: "Shell", active: true })];

  restorePane = _setExecutor((_cmd: string, args: string[]) => {
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}\t${p.role ?? ""}\t${p.name ?? ""}\t${p.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });

  restoreTmux = _setTmuxRunner((args: string[]) => {
    if (args[0] === "list-sessions") return "alpha\nbeta";
    if (args[0] === "display-message") {
      const idx = args.indexOf("-t");
      const session = idx >= 0 ? args[idx + 1] : undefined;
      if (session === "alpha") return tmpDir;
      if (session === "beta") return tmpDirOther;
    }
    return "";
  });
});

afterEach(() => {
  restorePane();
  restoreTmux();
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(tmpDirOther, { recursive: true, force: true });
  _stopSessionsPollerForTests();
});

describe("handleWsEventsConnection — basic protocol", () => {
  it("sends hello on connect", () => {
    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    const hellos = framesByType(ws, "hello");
    expect(hellos.length).toBe(1);
    expect(Array.isArray(hellos[0]!.sessions)).toBe(true);
    expect(hellos[0]!.sessions.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    ws.clientClose();
  });

  it("replies pong to ping", () => {
    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.sent.length = 0;
    ws.receive(JSON.stringify({ type: "ping" }));
    const pongs = framesByType(ws, "pong");
    expect(pongs.length).toBe(1);
    ws.clientClose();
  });

  it("ignores malformed frames without crashing", () => {
    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.sent.length = 0;
    ws.receive("not json");
    ws.receive(JSON.stringify({ type: "garbage" }));
    expect(ws.sent.length).toBe(0);
    ws.clientClose();
  });
});

describe("handleWsEventsConnection — subscriptions", () => {
  it("pushes initial snapshot on subscribe", () => {
    saveMission(tmpDir, {
      title: "Mission Alpha",
      description: "",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    saveTask(tmpDir, makeTask({ id: "001", status: "todo" }));

    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.sent.length = 0;
    ws.receive(JSON.stringify({ type: "subscribe", sessions: ["alpha"] }));

    const snapshots = framesByType(ws, "snapshot");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!.sessionName).toBe("alpha");
    ws.clientClose();
  });

  it("emits task.changed only to subscribed sessions", async () => {
    saveTask(tmpDir, makeTask({ id: "001" }));

    const wsA = new MockWebSocket();
    handleWsEventsConnection(wsA);
    wsA.receive(JSON.stringify({ type: "subscribe", sessions: ["alpha"] }));
    const before = framesByType(wsA, "task.changed").length;

    // Mutating a task in tmpDir should fire taskStore "change" with a path
    // inside tmpDir.
    saveTask(tmpDir, makeTask({ id: "001", status: "in-progress" }));
    await tick();

    const after = framesByType(wsA, "task.changed").length;
    expect(after).toBeGreaterThan(before);

    // A second client subscribed only to beta must NOT receive the alpha
    // task change.
    const wsB = new MockWebSocket();
    handleWsEventsConnection(wsB);
    wsB.receive(JSON.stringify({ type: "subscribe", sessions: ["beta"] }));
    const beforeB = framesByType(wsB, "task.changed").length;

    saveTask(tmpDir, makeTask({ id: "001", status: "done" }));
    await tick();

    const afterB = framesByType(wsB, "task.changed").length;
    expect(afterB).toBe(beforeB);

    wsA.clientClose();
    wsB.clientClose();
  });

  it("emits event.appended only for subscribed session", async () => {
    const wsA = new MockWebSocket();
    handleWsEventsConnection(wsA);
    wsA.receive(JSON.stringify({ type: "subscribe", sessions: ["alpha"] }));
    wsA.sent.length = 0;

    appendEvent(tmpDirOther, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: "001",
      agent: "Agent 1",
      message: "dispatched",
    });
    await tick();
    expect(framesByType(wsA, "event.appended").length).toBe(0);

    appendEvent(tmpDir, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: "002",
      agent: "Agent 2",
      message: "dispatched",
    });
    await tick();

    const events = framesByType(wsA, "event.appended");
    expect(events.length).toBe(1);
    expect(events[0]!.sessionName).toBe("alpha");
    expect(events[0]!.event.type).toBe("dispatch");

    wsA.clientClose();
  });

  it("stops emitting after unsubscribe", async () => {
    saveTask(tmpDir, makeTask({ id: "001" }));
    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.receive(JSON.stringify({ type: "subscribe", sessions: ["alpha"] }));

    saveTask(tmpDir, makeTask({ id: "001", status: "in-progress" }));
    await tick();
    const before = framesByType(ws, "task.changed").length;
    expect(before).toBeGreaterThan(0);

    ws.receive(JSON.stringify({ type: "unsubscribe", sessions: ["alpha"] }));
    saveTask(tmpDir, makeTask({ id: "001", status: "done" }));
    await tick();

    const after = framesByType(ws, "task.changed").length;
    expect(after).toBe(before);

    ws.clientClose();
  });
});

describe("handleWsEventsConnection — listener cleanup", () => {
  it("removes taskStore + eventLogEmitter listeners on disconnect", () => {
    const beforeTask = taskStore.listenerCount("change");
    const beforeEvent = eventLogEmitter.listenerCount("event");

    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.receive(JSON.stringify({ type: "subscribe", sessions: ["alpha", "beta"] }));

    expect(taskStore.listenerCount("change")).toBe(beforeTask + 2);
    expect(eventLogEmitter.listenerCount("event")).toBe(beforeEvent + 2);

    ws.clientClose();

    expect(taskStore.listenerCount("change")).toBe(beforeTask);
    expect(eventLogEmitter.listenerCount("event")).toBe(beforeEvent);
  });

  it("removes listeners even if client never subscribed", () => {
    const beforeTask = taskStore.listenerCount("change");
    const beforeEvent = eventLogEmitter.listenerCount("event");

    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.clientClose();

    expect(taskStore.listenerCount("change")).toBe(beforeTask);
    expect(eventLogEmitter.listenerCount("event")).toBe(beforeEvent);
  });

  it("decrements listener count on unsubscribe", () => {
    const beforeTask = taskStore.listenerCount("change");

    const ws = new MockWebSocket();
    handleWsEventsConnection(ws);
    ws.receive(JSON.stringify({ type: "subscribe", sessions: ["alpha"] }));
    expect(taskStore.listenerCount("change")).toBe(beforeTask + 1);

    ws.receive(JSON.stringify({ type: "unsubscribe", sessions: ["alpha"] }));
    expect(taskStore.listenerCount("change")).toBe(beforeTask);

    ws.clientClose();
  });
});

describe("attachWsEvents — real HTTP upgrade", () => {
  it("accepts a WebSocket on /ws/events and delivers hello + snapshot", async () => {
    saveMission(tmpDir, {
      title: "Mission Alpha",
      description: "",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const server = createServer(getRequestListener(app.fetch));
    const handle = attachWsEvents(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected AddressInfo");

    const url = `ws://127.0.0.1:${addr.port}/ws/events`;
    const client = new WebSocket(url);
    const received: ServerFrame[] = [];

    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });

    client.on("message", (data: Buffer) => {
      received.push(JSON.parse(data.toString("utf-8")) as ServerFrame);
    });

    client.send(JSON.stringify({ type: "subscribe", sessions: ["alpha"] }));

    // Wait until both hello + snapshot land.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const hasHello = received.some((f) => f.type === "hello");
      const hasSnap = received.some((f) => f.type === "snapshot");
      if (hasHello && hasSnap) break;
      await tick(20);
    }

    expect(received.some((f) => f.type === "hello")).toBe(true);
    expect(received.some((f) => f.type === "snapshot")).toBe(true);

    client.close();
    handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
