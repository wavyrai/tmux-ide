import { describe, expect, it, vi } from "vitest";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamServerFrameSchemaZ,
} from "@tmux-ide/contracts";
import type { MirrorPaneEvent, MirrorSessionDescription } from "../mirror/events.ts";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import type { DirectTerminalSocket } from "../attachments/direct-websocket.ts";
import { PaneStreamLeaseManager } from "./lease-manager.ts";
import {
  PaneStreamAdmissionCoordinator,
  type PaneStreamMirror,
} from "./pane-stream-websocket.ts";

const INSTANCE = "daemon-instance-1";
const ORIGIN = "tmux-ide://app";
const WS_URL = `ws://127.0.0.1:6070${PANE_STREAM_REDEEM_PATH}`;
const SESSION = "alpha";

let requestCounter = 0;
function freshRequestId(): string {
  requestCounter += 1;
  return `00000000-0000-4000-8000-${String(requestCounter).padStart(12, "0")}`;
}

class FakeSocket implements DirectTerminalSocket {
  readyState = 1;
  sentBytes = 0;
  drainedBytes = 0;
  readonly frames: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>();

  get bufferedAmount(): number {
    return this.sentBytes - this.drainedBytes;
  }

  send(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    this.sentBytes += Buffer.byteLength(text, "utf8");
    this.frames.push(JSON.parse(text));
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      (listener as (...inner: unknown[]) => void)(...args);
    }
  }

  message(frame: unknown, isBinary = false): void {
    const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
    this.emit("message", Buffer.from(payload, "utf8"), isBinary);
  }

  drainAll(): void {
    this.drainedBytes = this.sentBytes;
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames.filter(
      (frame): frame is Record<string, unknown> =>
        typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === type,
    );
  }
}

class FakeSub implements MirrorSubscription {
  readonly session: string;
  readonly semanticPaneId: string;
  readonly onEvent: (event: MirrorPaneEvent) => void;
  freezes = 0;
  thaws = 0;
  texts: string[] = [];
  keys: string[] = [];
  closedCount = 0;

  constructor(request: MirrorSubscribeRequest) {
    this.session = request.session;
    this.semanticPaneId = request.semanticPaneId;
    this.onEvent = request.onEvent;
  }

  freeze(): void {
    this.freezes += 1;
  }

  thaw(): void {
    this.thaws += 1;
  }

  sendText(text: string): void {
    this.texts.push(text);
  }

  sendKey(key: string): void {
    this.keys.push(key);
  }

  async close(): Promise<void> {
    this.closedCount += 1;
  }
}

class FakeMirror implements PaneStreamMirror {
  panes: string[];
  readonly subs: FakeSub[] = [];
  layoutHandlers: Array<(event: never) => void> = [];
  describeGate: Promise<void> | null = null;
  describeFailure = false;

  constructor(panes: string[]) {
    this.panes = panes;
  }

  async describeSession(session: string): Promise<MirrorSessionDescription> {
    await this.describeGate;
    if (this.describeFailure) throw new Error("describe failed");
    return {
      session,
      panes: this.panes.map((semanticPaneId) => ({
        semanticPaneId,
        semanticWindowId: "window.mirror.w1",
        role: null,
        paneType: null,
        currentCommand: "sh",
        cwd: null,
        title: semanticPaneId,
        windowName: "main",
        active: false,
      })),
      diagnostics: [],
      degraded: false,
    };
  }

  async subscribe(request: MirrorSubscribeRequest): Promise<MirrorSubscription> {
    if (!this.panes.includes(request.semanticPaneId)) {
      throw new Error(`unknown semantic pane ${request.semanticPaneId}`);
    }
    const sub = new FakeSub(request);
    this.subs.push(sub);
    if (request.onLayout) this.layoutHandlers.push(request.onLayout as (event: never) => void);
    return sub;
  }

  subFor(pane: string, index = 0): FakeSub {
    const matches = this.subs.filter((sub) => sub.semanticPaneId === pane);
    const sub = matches[index];
    if (!sub) throw new Error(`no subscription ${index} for ${pane}`);
    return sub;
  }
}

interface Timer {
  callback: () => void;
  delay: number;
  cancelled: boolean;
}

function testScheduler() {
  const timers: Timer[] = [];
  const schedule = (callback: () => void, delay: number): (() => void) => {
    const timer: Timer = { callback, delay, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const runDue = (): void => {
    const due = timers.splice(0);
    for (const timer of due) {
      if (!timer.cancelled) timer.callback();
    }
  };
  return { schedule, runDue, timers };
}

function harness(options: {
  panes?: string[];
  budgets?: ConstructorParameters<typeof PaneStreamAdmissionCoordinator>[0]["flowBudgets"];
  ticketTtlMs?: number;
  now?: () => number;
} = {}) {
  const mirror = new FakeMirror(options.panes ?? ["pane.editor", "pane.shell"]);
  const now = options.now ?? Date.now;
  const leaseManager = new PaneStreamLeaseManager({
    daemonInstanceId: INSTANCE,
    now,
    ticketTtlMs: options.ticketTtlMs ?? 15_000,
  });
  const scheduler = testScheduler();
  const coordinator = new PaneStreamAdmissionCoordinator({
    daemonInstanceId: INSTANCE,
    webSocketUrl: WS_URL,
    leaseManager,
    mirror,
    flowBudgets: options.budgets,
    now,
    schedule: scheduler.schedule,
  });
  return { mirror, leaseManager, coordinator, scheduler };
}

async function connect(
  h: ReturnType<typeof harness>,
  options: {
    panes?: string[];
    viewerMode?: "interactive" | "read-only";
    deliveryAcks?: boolean;
  } = {},
): Promise<{ socket: FakeSocket; requestId: string }> {
  const requestId = freshRequestId();
  const descriptor = await h.coordinator.issue(
    {
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      workspaceName: "workspace.alpha",
      panes: options.panes ?? ["pane.editor", "pane.shell"],
      viewerMode: options.viewerMode ?? "read-only",
    },
    {
      requestId,
      projectIdentity: "workspace.alpha",
      sessionName: SESSION,
      rendererOrigin: ORIGIN,
    },
  );
  const decision = h.coordinator.reserveUpgrade({
    path: PANE_STREAM_REDEEM_PATH,
    protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
    origin: ORIGIN,
  });
  if (!decision.accepted) throw new Error(`upgrade rejected: ${decision.code}`);
  const socket = new FakeSocket();
  decision.admission.bind(socket);
  socket.message({
    type: "redeem",
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    ticket: descriptor.redemptionTicket,
    requestId,
    daemonInstanceId: INSTANCE,
    ...(options.deliveryAcks ? { deliveryAcks: true } : {}),
  });
  await vi.waitFor(() => {
    expect(socket.framesOfType("ready")).toHaveLength(1);
  });
  return { socket, requestId };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PaneStreamAdmissionCoordinator", () => {
  it("redeems a ticket and streams atomic seed batches plus live output for two panes", async () => {
    const h = harness();
    const { socket } = await connect(h);
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(2));

    const editor = h.mirror.subFor("pane.editor");
    const shell = h.mirror.subFor("pane.shell");
    // The atomic recipe: reset -> seed -> held delta -> cursor in one burst.
    editor.onEvent({ type: "reset", cols: 120, rows: 40 });
    editor.onEvent({ type: "seed", data: Buffer.from("EDITOR_SEED") });
    editor.onEvent({ type: "delta", data: Buffer.from("HELD") });
    editor.onEvent({ type: "cursor", x: 3, y: 1 });
    shell.onEvent({ type: "reset", cols: 80, rows: 24 });
    shell.onEvent({ type: "seed", data: Buffer.from("SHELL_SEED") });
    shell.onEvent({ type: "cursor", x: 0, y: 0 });

    const batches = socket.framesOfType("seed-batch");
    expect(batches).toHaveLength(2);
    const editorBatch = batches.find((frame) => frame.pane === "pane.editor")!;
    expect(editorBatch.reset).toEqual({ cols: 120, rows: 40 });
    expect(Buffer.from(editorBatch.seed as string, "base64").toString()).toBe("EDITOR_SEED");
    expect(
      (editorBatch.held as string[]).map((held) => Buffer.from(held, "base64").toString()),
    ).toEqual(["HELD"]);
    expect(editorBatch.cursor).toEqual({ x: 3, y: 1 });

    // Live deltas route to their own pane only.
    editor.onEvent({ type: "delta", data: Buffer.from("EDITOR_LIVE") });
    shell.onEvent({ type: "delta", data: Buffer.from("SHELL_LIVE") });
    const outputs = socket.framesOfType("output");
    expect(outputs).toHaveLength(2);
    expect(outputs.map((frame) => frame.pane)).toEqual(["pane.editor", "pane.shell"]);
    expect(Buffer.from(outputs[0]!.data as string, "base64").toString()).toBe("EDITOR_LIVE");

    // Every frame on the wire parses under the contract and carries no
    // runtime tmux address in structural fields.
    for (const frame of socket.frames) {
      const parsed = PaneStreamServerFrameSchemaZ.parse(frame);
      const structural = { ...(parsed as Record<string, unknown>) };
      delete structural.seed;
      delete structural.held;
      delete structural.data;
      expect(JSON.stringify(structural)).not.toMatch(/[%@$][0-9]/u);
    }
  });

  it("enumerates the pane set at issue and rejects unknown panes", async () => {
    const h = harness({ panes: ["pane.editor"] });
    await expect(
      h.coordinator.issue(
        {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "workspace.alpha",
          panes: ["pane.editor", "pane.ghost"],
          viewerMode: "read-only",
        },
        {
          requestId: freshRequestId(),
          projectIdentity: "workspace.alpha",
          sessionName: SESSION,
          rendererOrigin: ORIGIN,
        },
      ),
    ).rejects.toMatchObject({ code: "pane-not-found" });
  });

  it("stalls only the exhausted client's pane and thaws it after drain", async () => {
    const h = harness({
      budgets: {
        "ws-send-buffer": { maxOutstanding: 300, resumeAt: 0 },
        "renderer-backlog": { maxOutstanding: 512, resumeAt: 128 },
      },
    });
    const one = await connect(h);
    const two = await connect(h);
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(4));
    const editorOne = h.mirror.subFor("pane.editor", 0);
    const shellOne = h.mirror.subFor("pane.shell", 0);
    const editorTwo = h.mirror.subFor("pane.editor", 1);

    // Client one's socket never drains; flood its editor pane past budget.
    // Stall is judged on the drain tick, not synchronously at send.
    const flood = Buffer.alloc(200, 65);
    editorOne.onEvent({ type: "delta", data: flood });
    editorOne.onEvent({ type: "delta", data: flood });
    h.scheduler.runDue();
    expect(editorOne.freezes).toBe(1);
    // Its own quiet pane and the OTHER client's same pane are untouched.
    expect(shellOne.freezes).toBe(0);
    expect(editorTwo.freezes).toBe(0);

    // The healthy client keeps receiving that same pane's frames.
    editorTwo.onEvent({ type: "delta", data: Buffer.from("STILL_FLOWING") });
    expect(
      two.socket
        .framesOfType("output")
        .some((frame) => Buffer.from(frame.data as string, "base64").toString() === "STILL_FLOWING"),
    ).toBe(true);

    // Drain both sockets; the tick returns tickets and thaws the pane.
    one.socket.drainAll();
    two.socket.drainAll();
    h.scheduler.runDue();
    expect(editorOne.thaws).toBe(1);
    expect(h.coordinator.flowSnapshot()).toEqual({});
  });

  it("force-returns tickets and closes subscriptions on WS close within one tick", async () => {
    const h = harness({
      budgets: {
        "ws-send-buffer": { maxOutstanding: 10_000, resumeAt: 1_000 },
        "renderer-backlog": { maxOutstanding: 512, resumeAt: 128 },
      },
    });
    const { socket } = await connect(h);
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(2));
    h.mirror.subFor("pane.editor").onEvent({ type: "delta", data: Buffer.from("X") });
    expect(Object.keys(h.coordinator.flowSnapshot())).toHaveLength(1);

    socket.emit("close");
    // Synchronously after the close event: ledger empty, subs closed.
    expect(h.coordinator.flowSnapshot()).toEqual({});
    expect(h.mirror.subFor("pane.editor").closedCount).toBe(1);
    expect(h.mirror.subFor("pane.shell").closedCount).toBe(1);
    await settled();
    expect(h.leaseManager.snapshot().leases).toHaveLength(0);
  });

  it("enforces the per-pane interactive grant at issue", async () => {
    const h = harness();
    await connect(h, { viewerMode: "interactive", panes: ["pane.editor"] });
    await expect(
      h.coordinator.issue(
        {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "workspace.alpha",
          panes: ["pane.editor", "pane.shell"],
          viewerMode: "interactive",
        },
        {
          requestId: freshRequestId(),
          projectIdentity: "workspace.alpha",
          sessionName: SESSION,
          rendererOrigin: ORIGIN,
        },
      ),
    ).rejects.toMatchObject({ code: "interactive-viewer-conflict" });
    // Read-only over the same pane still streams.
    await expect(connect(h, { viewerMode: "read-only", panes: ["pane.editor"] })).resolves.toBeTruthy();
  });

  it("honors the delivery TTL for a redeem queued behind slow admission work", async () => {
    let now = 1_000;
    const h = harness({ ticketTtlMs: 1_000, now: () => now });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      { requestId, projectIdentity: "workspace.alpha", sessionName: SESSION, rendererOrigin: ORIGIN },
    );
    // Occupy the serialized admission queue with a gated issue.
    let releaseGate!: () => void;
    h.mirror.describeGate = new Promise((resolve) => {
      releaseGate = () => resolve();
    });
    const queued = h.coordinator
      .issue(
        {
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          workspaceName: "workspace.alpha",
          panes: ["pane.editor"],
          viewerMode: "read-only",
        },
        {
          requestId: freshRequestId(),
          projectIdentity: "workspace.alpha",
          sessionName: SESSION,
          rendererOrigin: ORIGIN,
        },
      )
      .catch(() => undefined);

    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error("upgrade rejected");
    const socket = new FakeSocket();
    decision.admission.bind(socket);
    // The frame is DELIVERED in time (now=1500 < 2000)...
    now = 1_500;
    socket.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await settled();
    // ...but only EXECUTES after the queue clears, past the ticket TTL.
    now = 5_000;
    h.mirror.describeGate = null;
    releaseGate();
    await queued;
    await vi.waitFor(() => {
      expect(socket.framesOfType("ready")).toHaveLength(1);
    });
  });

  it("rejects a redemption frame delivered after the ticket TTL", async () => {
    let now = 1_000;
    const h = harness({ ticketTtlMs: 1_000, now: () => now });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      { requestId, projectIdentity: "workspace.alpha", sessionName: SESSION, rendererOrigin: ORIGIN },
    );
    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error("upgrade rejected");
    const socket = new FakeSocket();
    decision.admission.bind(socket);
    now = 2_500;
    socket.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await vi.waitFor(() => {
      expect(socket.framesOfType("error")).toHaveLength(1);
    });
    expect(socket.framesOfType("error")[0]!.code).toBe("ticket-expired");
    expect(socket.closed).not.toBeNull();
  });

  it("accepts interactive input, acks it, and rejects it on read-only leases", async () => {
    const h = harness();
    const interactive = await connect(h, { viewerMode: "interactive" });
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(2));
    interactive.socket.message({ type: "input", kind: "text", pane: "pane.editor", seq: 1, data: "echo hi" });
    interactive.socket.message({ type: "input", kind: "key", pane: "pane.editor", seq: 2, data: "Enter" });
    expect(h.mirror.subFor("pane.editor").texts).toEqual(["echo hi"]);
    expect(h.mirror.subFor("pane.editor").keys).toEqual(["Enter"]);
    const acks = interactive.socket.framesOfType("input-ack");
    expect(acks.map((frame) => frame.seq)).toEqual([1, 2]);

    // Out-of-order input closes the connection.
    interactive.socket.message({ type: "input", kind: "text", pane: "pane.editor", seq: 9, data: "x" });
    expect(interactive.socket.framesOfType("error")[0]!.code).toBe("input-rejected");
    expect(interactive.socket.closed).not.toBeNull();

    const readOnly = await connect(h, { viewerMode: "read-only", panes: ["pane.shell"] });
    readOnly.socket.message({ type: "input", kind: "text", pane: "pane.shell", seq: 1, data: "x" });
    expect(readOnly.socket.framesOfType("error")[0]!.code).toBe("input-rejected");
    expect(readOnly.socket.closed).not.toBeNull();
  });

  it("meters renderer backlog for acking clients and thaws on consumed frames", async () => {
    const h = harness({
      budgets: {
        "ws-send-buffer": { maxOutstanding: 1 << 20, resumeAt: 256 << 10 },
        "renderer-backlog": { maxOutstanding: 2, resumeAt: 1 },
      },
    });
    const { socket } = await connect(h, { deliveryAcks: true, panes: ["pane.editor"] });
    await vi.waitFor(() => expect(h.mirror.subs).toHaveLength(1));
    const editor = h.mirror.subFor("pane.editor");
    editor.onEvent({ type: "delta", data: Buffer.from("1") });
    editor.onEvent({ type: "delta", data: Buffer.from("2") });
    socket.drainAll();
    h.scheduler.runDue();
    expect(editor.freezes).toBe(0);
    editor.onEvent({ type: "delta", data: Buffer.from("3") });
    socket.drainAll();
    h.scheduler.runDue();
    expect(editor.freezes).toBe(1);

    socket.message({ type: "consumed", pane: "pane.editor", seq: 3 });
    expect(editor.thaws).toBe(1);

    // A non-acking client sending consumed frames is a protocol error.
    const plain = await connect(h, { panes: ["pane.shell"] });
    plain.socket.message({ type: "consumed", pane: "pane.shell", seq: 1 });
    expect(plain.socket.framesOfType("error")[0]!.code).toBe("protocol-error");
  });

  it("sends closed for a pane that vanished between issue and redeem, and closes when all panes are gone", async () => {
    const h = harness({ panes: ["pane.editor", "pane.shell"] });
    const requestId = freshRequestId();
    const descriptor = await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor", "pane.shell"],
        viewerMode: "read-only",
      },
      { requestId, projectIdentity: "workspace.alpha", sessionName: SESSION, rendererOrigin: ORIGIN },
    );
    // Both panes vanish before redemption (a successful describe omitting
    // them IS absence — unlike a describe failure).
    h.mirror.panes = [];
    const decision = h.coordinator.reserveUpgrade({
      path: PANE_STREAM_REDEEM_PATH,
      protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
      origin: ORIGIN,
    });
    if (!decision.accepted) throw new Error("upgrade rejected");
    const socket = new FakeSocket();
    decision.admission.bind(socket);
    socket.message({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: INSTANCE,
    });
    await vi.waitFor(() => {
      expect(socket.framesOfType("closed")).toHaveLength(2);
    });
    expect(socket.closed?.reason).toBe("panes-closed");
  });

  it("gates the upgrade on path, subprotocol, and a pending origin", async () => {
    const h = harness();
    await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId: freshRequestId(),
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    expect(
      h.coordinator.reserveUpgrade({
        path: "/v1/terminal/attachments/redeem",
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: ORIGIN,
      }),
    ).toMatchObject({ accepted: false, code: "invalid-path" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: ["tmux-ide-terminal.v1"],
        origin: ORIGIN,
      }),
    ).toMatchObject({ accepted: false, code: "invalid-subprotocol" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: "http://evil.example",
      }),
    ).toMatchObject({ accepted: false, code: "origin-rejected" });
    expect(
      h.coordinator.reserveUpgrade({
        path: PANE_STREAM_REDEEM_PATH,
        protocols: [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
        origin: ORIGIN,
      }).accepted,
    ).toBe(true);
  });

  it("shuts down cleanly, retiring pendings and closing live connections", async () => {
    const h = harness();
    const { socket } = await connect(h);
    await h.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "read-only",
      },
      {
        requestId: freshRequestId(),
        projectIdentity: "workspace.alpha",
        sessionName: SESSION,
        rendererOrigin: ORIGIN,
      },
    );
    await h.coordinator.shutdown();
    expect(socket.closed).not.toBeNull();
    expect(h.coordinator.snapshot()).toMatchObject({
      pendingTickets: 0,
      liveConnections: 0,
      shuttingDown: true,
    });
    expect(h.leaseManager.snapshot().leases).toHaveLength(0);
  });
});
