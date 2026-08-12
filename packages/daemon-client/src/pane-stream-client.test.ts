import { describe, expect, it, mock } from "bun:test";

import { openPaneStreamRuntimeClient, type PaneStreamClientSocket } from "./pane-stream-client.ts";

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const TRANSACTION = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const TICKET = `ps1_${"a".repeat(43)}`;

class FakeSocket implements PaneStreamClientSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  closed: { code?: number; reason?: string } | null = null;
  onSend: ((frame: Record<string, unknown>) => void) | null = null;

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    this.onSend?.(frame);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  message(frame: unknown): void {
    this.emit("message", JSON.stringify(frame));
  }
}

function descriptor(viewerMode: "interactive" | "read-only" = "interactive") {
  return {
    protocolVersion: 1,
    webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem",
    subprotocol: "tmux-ide-pane-stream.v1",
    redemptionTicket: TICKET,
    daemonInstanceId: INSTANCE,
    requestId: REQUEST,
    expiresAt: Date.now() + 5_000,
    panes: ["pane.editor"],
    effectiveViewerMode: viewerMode,
  } as const;
}

function options(socket: FakeSocket, overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://127.0.0.1:6060",
    ownerToken: "owner-secret",
    daemonInstanceId: INSTANCE,
    origin: "http://127.0.0.1:5173",
    hostClientId: "tui:one",
    requestId: REQUEST,
    stream: {
      protocolVersion: 1 as const,
      workspaceName: "alpha",
      panes: ["pane.editor"],
      viewerMode: "interactive" as const,
      terminalDelivery: {
        protocolVersions: [1],
        encodings: ["semantic-v1" as const],
        richPlacements: false,
      },
    },
    createSocket: mock((_issued, headers) => {
      expect(headers).toEqual({
        Origin: "http://127.0.0.1:5173",
        "X-Tmux-Ide-Host-Client-Id": "tui:one",
      });
      queueMicrotask(() => socket.emit("open"));
      return socket;
    }),
    fetch: mock(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer owner-secret",
        Origin: "http://127.0.0.1:5173",
        "X-Tmux-Ide-Request-Id": REQUEST,
        "X-Tmux-Ide-Expected-Daemon-Instance-Id": INSTANCE,
        "X-Tmux-Ide-Host-Client-Id": "tui:one",
      });
      return Response.json({ status: "issued", descriptor: descriptor() });
    }) as typeof fetch,
    onNegotiated: mock(),
    onTerminalDelivery: mock(),
    onFault: mock(),
    ...overrides,
  };
}

describe("semantic pane-stream runtime client", () => {
  it("resolves only after verified ready and decodes delivery chunks", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
        expect(JSON.stringify(frame)).not.toContain("owner-secret");
        queueMicrotask(() =>
          socket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
          }),
        );
      } else if (frame.type === "viewport") {
        queueMicrotask(() =>
          socket.message({
            type: "viewport-ack",
            seq: frame.seq,
            cols: frame.cols,
            rows: frame.rows,
          }),
        );
      } else if (frame.type === "semantic-intent") {
        queueMicrotask(() =>
          socket.message({
            type: "semantic-intent-ack",
            operationId: frame.operationId,
            outcome: { status: "applied", result: null },
          }),
        );
      }
    };
    const onTerminalDelivery = mock();
    const client = await openPaneStreamRuntimeClient(options(socket, { onTerminalDelivery }));
    client.sendText("pane.editor", "echo hi", "00000000-0000-4000-8000-000000000099");
    client.sendKey("pane.editor", "Enter");
    const fitted = client.fitViewport(132, 44);
    const submitted = client.submitIntent(OPERATION, {
      verb: "workspace.pane.select",
      workspaceName: "alpha",
      semanticPaneId: "pane.editor",
    });
    expect(socket.sent.slice(-4)).toEqual([
      {
        type: "input",
        kind: "text",
        pane: "pane.editor",
        seq: 1,
        data: "echo hi",
        performanceTraceId: "00000000-0000-4000-8000-000000000099",
      },
      { type: "input", kind: "key", pane: "pane.editor", seq: 2, data: "Enter" },
      { type: "viewport", seq: 1, cols: 132, rows: 44 },
      {
        type: "semantic-intent",
        operationId: OPERATION,
        intent: {
          verb: "workspace.pane.select",
          workspaceName: "alpha",
          semanticPaneId: "pane.editor",
        },
      },
    ]);
    socket.message({
      type: "terminal-delivery-chunk",
      pane: "pane.editor",
      transactionId: TRANSACTION,
      index: 0,
      data: "aGk=",
    });
    expect(onTerminalDelivery).toHaveBeenCalledWith(
      "pane.editor",
      expect.objectContaining({ bytes: new Uint8Array([104, 105]) }),
    );
    await fitted;
    expect(await submitted).toBeNull();
    client.close();
  });

  it("rejects a ready frame from another generation or mode", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type !== "redeem") return;
      queueMicrotask(() =>
        socket.message({
          type: "ready",
          protocolVersion: 1,
          daemonInstanceId: INSTANCE,
          requestId: REQUEST,
          panes: ["pane.editor"],
          effectiveViewerMode: "read-only",
        }),
      );
    };
    await expect(openPaneStreamRuntimeClient(options(socket))).rejects.toThrow(
      "peer identity did not match",
    );
    expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
  });

  it("fails closed when legacy raw-v1 output appears on a semantic lane", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type !== "redeem") return;
      queueMicrotask(() =>
        socket.message({
          type: "ready",
          protocolVersion: 1,
          daemonInstanceId: INSTANCE,
          requestId: REQUEST,
          panes: ["pane.editor"],
          effectiveViewerMode: "interactive",
        }),
      );
    };
    const onFault = mock();
    await openPaneStreamRuntimeClient(options(socket, { onFault }));
    socket.message({ type: "output", pane: "pane.editor", seq: 1, data: "eA==" });
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("legacy output") }),
    );
    expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
  });
});
