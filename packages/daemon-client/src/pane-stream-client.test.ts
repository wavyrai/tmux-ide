import { describe, expect, it, mock } from "bun:test";

import {
  classifyPaneStreamInputTransportDelay,
  openPaneStreamRuntimeClient,
  type PaneStreamClientSocket,
  type PaneStreamInputTransportStageEvent,
} from "./pane-stream-client.ts";
import { runtimeResourceSnapshot } from "./runtime-resource-ledger.ts";

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const TRANSACTION = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const TICKET = `ps1_${"a".repeat(43)}`;

class FakeSocket implements PaneStreamClientSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  closeCalls = 0;
  closed: { code?: number; reason?: string } | null = null;
  onSend: ((frame: Record<string, unknown>) => void) | null = null;

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    this.onSend?.(frame);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
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
        "X-Tmux-Ide-Request-Id": REQUEST,
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

function acceptInteractiveHandshake(socket: FakeSocket): void {
  socket.onSend = (frame) => {
    if (frame.type === "redeem") {
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
      return;
    }
    if (frame.type === "authority-request") {
      queueMicrotask(() =>
        socket.message({
          type: "authority-receipt",
          requestId: frame.requestId,
          authority: frame.authority,
          status: "granted",
          lease: {
            generation: INSTANCE,
            session: "alpha",
            clientId: "tui:one",
            authority: frame.authority,
            token: "55555555-5555-4555-8555-555555555555",
            revision: 1,
          },
          snapshot: {
            generation: INSTANCE,
            session: "alpha",
            revision: 1,
            nativeGeometryYieldUntilMs: 0,
            owners: { input: "tui:one", focus: null, geometry: null },
            clients: [],
          },
        }),
      );
      return;
    }
    if (frame.type === "input") {
      queueMicrotask(() => socket.message({ type: "input-ack", pane: frame.pane, seq: frame.seq }));
    }
  };
}

describe("semantic pane-stream runtime client", () => {
  it("preserves key/paste FIFO while diagnostic edges isolate a delayed next turn", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    let nowMicros = 1_000;
    const nextTurns: Array<{ run: () => void; cancelled: boolean }> = [];
    const stages: PaneStreamInputTransportStageEvent[] = [];
    const client = await openPaneStreamRuntimeClient(
      options(socket, {
        onInputTransportStage: (event: PaneStreamInputTransportStageEvent) => {
          expect(
            socket.sent.some(
              (frame) =>
                (frame as { type?: string; seq?: number }).type === "input" &&
                (frame as { seq?: number }).seq === event.sequence,
            ),
          ).toBe(true);
          stages.push(event);
        },
        diagnosticNowMicros: () => (nowMicros += 10),
        diagnosticNextTurn: (callback: () => void) => {
          const turn = { run: callback, cancelled: false };
          nextTurns.push(turn);
          return () => {
            turn.cancelled = true;
          };
        },
      }),
    );
    const keyTrace = "00000000-0000-4000-8000-000000000081";
    const pasteTrace = "00000000-0000-4000-8000-000000000082";
    const bracketedPaste = "\u001b[200~alpha\nbeta\u001b[201~";
    const key = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "Enter" },
      keyTrace,
    );
    const paste = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "text", data: bracketedPaste },
      pasteTrace,
    );

    expect(socket.sent.filter((frame) => (frame as { type?: string }).type === "input")).toEqual([
      {
        type: "input",
        kind: "key",
        pane: "pane.editor",
        seq: 1,
        data: "Enter",
        performanceTraceId: keyTrace,
      },
      {
        type: "input",
        kind: "text",
        pane: "pane.editor",
        seq: 2,
        data: bracketedPaste,
        performanceTraceId: pasteTrace,
      },
    ]);
    expect(stages).toEqual([]);

    nowMicros += 50_000;
    for (const turn of nextTurns) if (!turn.cancelled) turn.run();
    expect(stages.map(({ traceId, operation }) => `${traceId}:${operation}`)).toEqual([
      `${keyTrace}:pane-stream-frame-enqueued`,
      `${keyTrace}:pane-stream-socket-send-return`,
      `${keyTrace}:pane-stream-next-event-loop-turn`,
      `${pasteTrace}:pane-stream-frame-enqueued`,
      `${pasteTrace}:pane-stream-socket-send-return`,
      `${pasteTrace}:pane-stream-next-event-loop-turn`,
    ]);
    expect(
      stages.filter(({ operation }) => operation === "pane-stream-next-event-loop-turn"),
    ).toEqual([
      expect.objectContaining({ traceId: keyTrace, sequence: 1 }),
      expect.objectContaining({ traceId: pasteTrace, sequence: 2 }),
    ]);
    for (const traceId of [keyTrace, pasteTrace]) {
      const traceStages = stages.filter((stage) => stage.traceId === traceId);
      const sent = stages.find(
        (stage) =>
          stage.traceId === traceId && stage.operation === "pane-stream-socket-send-return",
      )!;
      const next = stages.find(
        (stage) =>
          stage.traceId === traceId && stage.operation === "pane-stream-next-event-loop-turn",
      )!;
      expect(next.atMicros - sent.atMicros).toBeGreaterThan(50_000);
      expect(classifyPaneStreamInputTransportDelay(traceStages, 10_000)).toBe(
        "client-event-loop-stall",
      );
      expect(traceStages.map(({ operation }) => operation)).toEqual([
        "pane-stream-frame-enqueued",
        "pane-stream-socket-send-return",
        "pane-stream-next-event-loop-turn",
      ]);
    }
    const keyStages = stages.filter((stage) => stage.traceId === keyTrace);
    expect(classifyPaneStreamInputTransportDelay([...keyStages, keyStages[2]!], 10_000)).toBe(
      "incomplete",
    );
    expect(
      classifyPaneStreamInputTransportDelay([keyStages[1]!, keyStages[0]!, keyStages[2]!], 10_000),
    ).toBe("incomplete");
    expect(
      classifyPaneStreamInputTransportDelay(
        [keyStages[0]!, keyStages[1]!, { ...keyStages[2]!, traceId: pasteTrace }],
        10_000,
      ),
    ).toBe("incomplete");
    await expect(Promise.all([key, paste])).resolves.toEqual(["ok", "ok"]);
    client.close();
  });

  it("commits FIFO identity before a reentrant transport observer can send", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    const turns: Array<() => void> = [];
    let reentrant: Promise<unknown> | null = null;
    let client!: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>>;
    client = await openPaneStreamRuntimeClient(
      options(socket, {
        onInputTransportStage: (event: PaneStreamInputTransportStageEvent) => {
          if (event.traceId.endsWith("088") && event.operation === "pane-stream-frame-enqueued") {
            reentrant = client.sendTerminalInput(
              { workspaceName: "alpha", semanticPaneId: "pane.editor" },
              { kind: "key", data: "Tab" },
              "00000000-0000-4000-8000-000000000089",
            );
          }
        },
        diagnosticNowMicros: (() => {
          let now = 0;
          return () => (now += 1);
        })(),
        diagnosticNextTurn: (callback: () => void) => {
          turns.push(callback);
          return () => undefined;
        },
      }),
    );
    const first = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "Enter" },
      "00000000-0000-4000-8000-000000000088",
    );
    for (let index = 0; index < turns.length; index += 1) turns[index]!();
    expect(
      socket.sent
        .filter((frame) => (frame as { type?: string }).type === "input")
        .map((frame) => (frame as { seq: number; data: string }).seq),
    ).toEqual([1, 2]);
    await expect(first).resolves.toBe("ok");
    await expect(reentrant).resolves.toBe("ok");
    client.close();
  });

  it("captures next-turn time before slow observer publication", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    let nowMicros = 0;
    let runTurn: (() => void) | null = null;
    const stages: PaneStreamInputTransportStageEvent[] = [];
    const client = await openPaneStreamRuntimeClient(
      options(socket, {
        diagnosticNowMicros: () => (nowMicros += 10),
        onInputTransportStage: (event: PaneStreamInputTransportStageEvent) => {
          stages.push(event);
          nowMicros += 100_000;
        },
        diagnosticNextTurn: (callback: () => void) => {
          runTurn = callback;
          return () => undefined;
        },
      }),
    );
    const input = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "Enter" },
      "00000000-0000-4000-8000-000000000090",
    );
    expect(stages).toEqual([]);
    runTurn!();
    expect(stages.map(({ atMicros }) => atMicros)).toEqual([10, 20, 30]);
    expect(classifyPaneStreamInputTransportDelay(stages, 1_000)).toBe("no-client-transport-stall");
    await expect(input).resolves.toBe("ok");
    client.close();
  });

  it("does no diagnostic clock or next-turn work without a transport observer", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    const diagnosticNowMicros = mock(() => 1);
    const diagnosticNextTurn = mock((_callback: () => void) => () => undefined);
    const client = await openPaneStreamRuntimeClient(
      options(socket, { diagnosticNowMicros, diagnosticNextTurn }),
    );
    await client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "Enter" },
      "00000000-0000-4000-8000-000000000083",
    );
    expect(diagnosticNowMicros).not.toHaveBeenCalled();
    expect(diagnosticNextTurn).not.toHaveBeenCalled();
    client.close();
  });

  it("keeps input live when diagnostic clocks, observers, or schedulers throw", async () => {
    for (const failure of ["clock", "observer", "scheduler"] as const) {
      const socket = new FakeSocket();
      acceptInteractiveHandshake(socket);
      const client = await openPaneStreamRuntimeClient(
        options(socket, {
          onInputTransportStage: () => {
            if (failure === "observer") throw new Error("observer failed");
          },
          diagnosticNowMicros: () => {
            if (failure === "clock") throw new Error("clock failed");
            return 1;
          },
          diagnosticNextTurn: (callback: () => void) => {
            if (failure === "scheduler") throw new Error("scheduler failed");
            callback();
            return () => undefined;
          },
        }),
      );
      await expect(
        client.sendTerminalInput(
          { workspaceName: "alpha", semanticPaneId: "pane.editor" },
          { kind: "key", data: "Enter" },
          `00000000-0000-4000-8000-00000000008${failure === "clock" ? 4 : failure === "observer" ? 5 : 6}`,
        ),
      ).resolves.toBe("ok");
      expect(
        socket.sent.filter((frame) => (frame as { type?: string }).type === "input"),
      ).toHaveLength(1);
      expect(socket.closed).toBeNull();
      client.close();
    }
  });

  it("cancels and releases a pending diagnostic next turn on close", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    const before = runtimeResourceSnapshot()["runtime-timer"].active;
    const stages: PaneStreamInputTransportStageEvent[] = [];
    const client = await openPaneStreamRuntimeClient(
      options(socket, { onInputTransportStage: (event) => stages.push(event) }),
    );
    const input = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "Enter" },
      "00000000-0000-4000-8000-000000000087",
    );
    client.close();
    await expect(input).rejects.toThrow("client closed");
    await Bun.sleep(0);
    expect(stages).toEqual([]);
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(before);
  });

  it("propagates AbortSignal through capability issuance", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    let observedSignal: AbortSignal | null = null;
    const fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        observedSignal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(observedSignal?.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    ) as typeof globalThis.fetch;
    const opening = openPaneStreamRuntimeClient(
      options(socket, { signal: controller.signal, fetch }),
    );
    await Bun.sleep(0);
    expect(observedSignal).toBe(controller.signal);
    controller.abort(new Error("retired issue"));
    await expect(opening).rejects.toThrow("retired issue");
    expect(socket.closeCalls).toBe(0);
  });

  it("rejects direct readiness when initial input authority is denied", async () => {
    const baseline = runtimeResourceSnapshot();
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
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
      } else if (frame.type === "authority-request") {
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: "input",
            status: "rejected",
            lease: null,
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: 1,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: "another-client", focus: null, geometry: null },
              clients: [],
            },
          }),
        );
      }
    };

    await expect(openPaneStreamRuntimeClient(options(socket))).rejects.toThrow(
      "input authority was denied",
    );
    expect(socket.closeCalls).toBe(1);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    const settled = runtimeResourceSnapshot();
    expect(settled["pane-stream-socket"].active).toBe(baseline["pane-stream-socket"].active);
    expect(settled["socket-listener"].active).toBe(baseline["socket-listener"].active);
    expect(settled["runtime-timer"].active).toBe(baseline["runtime-timer"].active);
  });

  it("exposes verified display readiness before lazily acquiring input authority", async () => {
    const baseline = runtimeResourceSnapshot();
    const socket = new FakeSocket();
    let authorityRequest: Record<string, unknown> | null = null;
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
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
      }
      if (frame.type === "authority-request") authorityRequest = frame;
    };
    const opening = openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    await Bun.sleep(0);
    const client = await opening;
    expect(authorityRequest).toBeNull();
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.editor" },
        { kind: "text", data: "blocked" },
      ),
    ).toBe("authority-lost");
    const authority = client.requestAuthority("input");
    await Bun.sleep(0);
    expect(authorityRequest).toMatchObject({ type: "authority-request", authority: "input" });
    socket.message({
      type: "authority-receipt",
      requestId: authorityRequest!.requestId,
      authority: "input",
      status: "granted",
      lease: {
        generation: INSTANCE,
        session: "alpha",
        clientId: "tui:one",
        authority: "input",
        token: "55555555-5555-4555-8555-555555555555",
        revision: 2,
      },
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 2,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: "tui:one", focus: null, geometry: null },
        clients: [
          {
            clientId: "tui:one",
            surface: "opentui",
            state: "foreground",
            connectedRevision: 1,
            activityRevision: 2,
          },
        ],
      },
    });
    await authority;
    expect(client.authoritySnapshot?.owners.input).toBe("tui:one");
    client.sendText("pane.editor", "immediate");
    expect(socket.sent.at(-1)).toMatchObject({ type: "input", data: "immediate" });
    client.close();
    client.close();
    expect(socket.closeCalls).toBe(1);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    const settled = runtimeResourceSnapshot();
    expect(settled["pane-stream-socket"].active).toBe(baseline["pane-stream-socket"].active);
    expect(settled["socket-listener"].active).toBe(baseline["socket-listener"].active);
    expect(settled["runtime-timer"].active).toBe(baseline["runtime-timer"].active);
  });

  it("returns the exact authority snapshot carried by a release receipt", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
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
      } else if (frame.type === "authority-release") {
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: frame.authority,
            status: "released",
            lease: null,
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: 17,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: null, focus: "web:one", geometry: null },
              clients: [],
            },
          }),
        );
      }
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );

    await expect(client.releaseAuthority("input")).resolves.toMatchObject({
      generation: INSTANCE,
      revision: 17,
      owners: { input: null, focus: "web:one", geometry: null },
    });
    client.close();
  });

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
      } else if (frame.type === "authority-request") {
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: frame.authority,
            status: "granted",
            lease: {
              generation: INSTANCE,
              session: "alpha",
              clientId: "tui:one",
              authority: frame.authority,
              token: "55555555-5555-4555-8555-555555555555",
              revision: 1,
            },
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: 1,
              nativeGeometryYieldUntilMs: 0,
              owners: {
                input: "tui:one",
                focus: null,
                geometry: frame.authority === "geometry" ? "tui:one" : null,
              },
              clients: [
                {
                  clientId: "tui:one",
                  surface: "opentui",
                  state: "foreground",
                  connectedRevision: 1,
                  activityRevision: 1,
                },
              ],
            },
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
      } else if (frame.type === "input") {
        queueMicrotask(() =>
          socket.message({ type: "input-ack", pane: frame.pane, seq: frame.seq }),
        );
      }
    };
    const onTerminalDelivery = mock();
    const onTerminalFrameArrival = mock();
    const client = await openPaneStreamRuntimeClient(
      options(socket, { onTerminalDelivery, onTerminalFrameArrival }),
    );
    socket.message({
      type: "terminal-delivery-envelope",
      pane: "pane.editor",
      envelope: {
        type: "terminal.delivery",
        workspaceName: "alpha",
        semanticPaneId: "pane.editor",
        generation: INSTANCE,
        incarnation: `${INSTANCE}:0`,
        deliveryNonce: "00000000-0000-4000-8000-000000000097",
        transactionId: TRANSACTION,
        performanceTraceId: "00000000-0000-4000-8000-000000000099",
        protocolVersion: 1,
        encoding: "semantic-v1",
        frame: "seed",
        baseRevision: null,
        canonicalRevision: 0,
        canonicalStateHash: "0000000000000000",
        representationHash: "0000000000000000",
        representationBytes: 0,
        chunkCount: 1,
        canonicalEquivalent: true,
        history: "complete",
        richPlacements: false,
      },
    });
    expect(onTerminalFrameArrival).toHaveBeenCalledTimes(1);
    expect(onTerminalFrameArrival.mock.calls[0]?.[0]).toMatchObject({
      pane: "pane.editor",
      traceId: "00000000-0000-4000-8000-000000000099",
    });
    expect(onTerminalFrameArrival.mock.calls[0]?.[0].atMicros).toBeGreaterThan(0);
    expect(await client.requestAuthority("input")).not.toBeNull();
    const textSent = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "text", data: "echo hi" },
      "00000000-0000-4000-8000-000000000099",
    );
    const keySent = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "Enter" },
    );
    const fitted = client.fitViewport(132, 44);
    const submitted = client.submitIntent(OPERATION, {
      verb: "workspace.pane.select",
      workspaceName: "alpha",
      semanticPaneId: "pane.editor",
    });
    await fitted;
    expect(await Promise.all([textSent, keySent])).toEqual(["ok", "ok"]);
    socket.message({ type: "input-ack", pane: "pane.editor", seq: 1 });
    expect(socket.closed).toBeNull();
    await expect(
      client.sendTerminalInput(
        { workspaceName: "another", semanticPaneId: "pane.editor" },
        { kind: "key", data: "Up" },
      ),
    ).rejects.toThrow("another workspace");
    expect(
      socket.sent
        .filter((frame) =>
          ["input", "viewport", "semantic-intent"].includes((frame as { type: string }).type),
        )
        .slice(-4),
    ).toEqual([
      {
        type: "input",
        kind: "text",
        pane: "pane.editor",
        seq: 1,
        data: "echo hi",
        performanceTraceId: "00000000-0000-4000-8000-000000000099",
      },
      { type: "input", kind: "key", pane: "pane.editor", seq: 2, data: "Enter" },
      {
        type: "semantic-intent",
        operationId: OPERATION,
        intent: {
          verb: "workspace.pane.select",
          workspaceName: "alpha",
          semanticPaneId: "pane.editor",
        },
      },
      { type: "viewport", seq: 1, cols: 132, rows: 44 },
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
    socket.message({
      type: "authority-snapshot",
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: "another-client", focus: null, geometry: null },
        clients: [],
      },
    });
    const inputFrameCount = socket.sent.filter(
      (frame) => (frame as { type?: string }).type === "input",
    ).length;
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.editor" },
        { kind: "key", data: "C-c" },
      ),
    ).toBe("authority-lost");
    expect(
      socket.sent.filter((frame) => (frame as { type?: string }).type === "input"),
    ).toHaveLength(inputFrameCount);
    expect(await submitted).toBeNull();
    client.close();
  });

  it("does not reacquire geometry when the caller already owns it", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
        queueMicrotask(() =>
          socket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
            authority: {
              generation: INSTANCE,
              session: "alpha",
              revision: 2,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: null, focus: null, geometry: "tui:one" },
              clients: [],
            },
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
      }
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    await client.fitViewport(120, 40);
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(0);
    expect(socket.sent.filter((frame) => frame.type === "viewport")).toHaveLength(1);
    client.close();
  });

  it("bounds unacknowledged input and retires every pending write exactly once", async () => {
    const baseline = runtimeResourceSnapshot();
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
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
      } else if (frame.type === "authority-request") {
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: "input",
            status: "granted",
            lease: {
              generation: INSTANCE,
              session: "alpha",
              clientId: "tui:one",
              authority: "input",
              token: "55555555-5555-4555-8555-555555555555",
              revision: 1,
            },
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: 1,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: "tui:one", focus: null, geometry: null },
              clients: [],
            },
          }),
        );
      }
    };
    const client = await openPaneStreamRuntimeClient(options(socket));
    expect(await client.requestAuthority("input")).not.toBeNull();
    const pending = Array.from({ length: 256 }, (_, index) =>
      client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.editor" },
        { kind: "text", data: `input-${index}` },
      ),
    );
    await expect(
      client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.editor" },
        { kind: "key", data: "Enter" },
      ),
    ).rejects.toThrow("queue is full");
    expect(
      socket.sent.filter((frame) => (frame as { type?: string }).type === "input"),
    ).toHaveLength(256);
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(
      baseline["runtime-timer"].active + 256,
    );

    client.close();
    const settled = await Promise.allSettled(pending);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    socket.message({ type: "input-ack", pane: "pane.editor", seq: 256 });
    expect(socket.closed).toEqual({ code: 1000, reason: "client-closed" });
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(
      baseline["runtime-timer"].active,
    );
  });

  it("ledgers and retires every pending operation timer", async () => {
    const baseline = runtimeResourceSnapshot();
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
          authority: {
            generation: INSTANCE,
            session: "alpha",
            revision: 1,
            nativeGeometryYieldUntilMs: 0,
            owners: { input: "tui:one", focus: null, geometry: "tui:one" },
            clients: [],
          },
        }),
      );
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const pending = [
      client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.editor" },
        { kind: "text", data: "pending" },
      ),
      client.fitViewport(120, 40),
      client.submitIntent(OPERATION, {
        verb: "workspace.pane.select",
        workspaceName: "alpha",
        semanticPaneId: "pane.editor",
      }),
      client.requestAuthority("focus"),
      client.releaseAuthority("input"),
    ];
    await Bun.sleep(0);
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(
      baseline["runtime-timer"].active + 5,
    );
    client.close();
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === "rejected"),
    ).toBe(true);
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(
      baseline["runtime-timer"].active,
    );
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
      if (frame.type === "redeem") {
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
      } else if (frame.type === "authority-request") {
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: "input",
            status: "granted",
            lease: {
              generation: INSTANCE,
              session: "alpha",
              clientId: "tui:one",
              authority: "input",
              token: "55555555-5555-4555-8555-555555555555",
              revision: 2,
            },
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: 2,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: "tui:one", focus: null, geometry: null },
              clients: [
                {
                  clientId: "tui:one",
                  surface: "opentui",
                  state: "foreground",
                  connectedRevision: 1,
                  activityRevision: 2,
                },
              ],
            },
          }),
        );
      }
    };
    const onFault = mock();
    await openPaneStreamRuntimeClient(options(socket, { onFault }));
    socket.message({ type: "output", pane: "pane.editor", seq: 1, data: "eA==" });
    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("legacy output") }),
    );
    expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
  });

  it("enriches a causal probe with exact authenticated transport facts", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
        queueMicrotask(() =>
          socket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
            diagnosticCapabilities: ["causal-cell-v1"],
          }),
        );
      } else if (frame.type === "authority-request") {
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: "input",
            status: "granted",
            lease: {
              generation: INSTANCE,
              session: "alpha",
              clientId: "tui:one",
              authority: "input",
              token: "55555555-5555-4555-8555-555555555555",
              revision: 2,
            },
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: 2,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: "tui:one", focus: null, geometry: null },
              clients: [],
            },
          }),
        );
      } else if (frame.type === "input") {
        queueMicrotask(() =>
          socket.message({ type: "input-ack", pane: "pane.editor", seq: frame.seq }),
        );
      }
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["causal-cell-v1"],
      }),
    );
    socket.message({
      type: "terminal-delivery-ready",
      pane: "pane.editor",
      negotiation: {
        accepted: true,
        negotiated: {
          protocolVersion: 1,
          encoding: "semantic-v1",
          richPlacements: false,
          generation: INSTANCE,
          deliveryNonce: "00000000-0000-4000-8000-000000000097",
        },
      },
    });
    await client.requestAuthority("input");
    const cell = {
      grapheme: " ",
      width: 1,
      foreground: { kind: "default" },
      background: { kind: "default" },
      attributes: 0,
    } as const;
    await client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "text", data: "probe" },
      "00000000-0000-4000-8000-000000000099",
      {
        version: 1,
        capability: "causal-cell-v1",
        traceId: "00000000-0000-4000-8000-000000000099",
        semanticPaneId: "pane.editor",
        generation: INSTANCE,
        incarnation: `${INSTANCE}:0`,
        baselineRevision: 7,
        baselineStateHash: "0000000000000000",
        geometry: { cols: 2, rows: 1, row: 0, column: 1 },
        before: cell,
        after: { ...cell, grapheme: "X" },
      },
    );
    expect(
      socket.sent.findLast((frame) => (frame as { type: string }).type === "input"),
    ).toMatchObject({
      seq: 1,
      pane: "pane.editor",
      causalProbe: {
        clientId: "tui:one",
        transportNonce: REQUEST,
        deliveryNonce: "00000000-0000-4000-8000-000000000097",
        inputSequence: 1,
        semanticPaneId: "pane.editor",
      },
    });
  });
});
