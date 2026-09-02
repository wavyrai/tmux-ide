import { describe, expect, it, mock } from "bun:test";
import type { TerminalDeliveryServerMessage } from "@tmux-ide/contracts";

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
  bufferedAmount: number | undefined;
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
  it("rejects a regressing full-layout topology epoch before publication", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    const layouts: unknown[] = [];
    const faults: Error[] = [];
    await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        onLayoutSnapshot: (frame: unknown) => layouts.push(frame),
        onFault: (error: Error) => faults.push(error),
      }),
    );
    const frame = {
      type: "layout-snapshot",
      topologyEpoch: 4,
      layouts: [
        {
          type: "layout",
          semanticWindowId: "window.one",
          windowName: "work",
          currentWindow: true,
          cols: 80,
          rows: 24,
          zoomed: false,
          paneBorderStatus: "off",
          panes: [
            {
              pane: "pane.editor",
              left: 0,
              top: 0,
              width: 80,
              height: 24,
              active: true,
            },
          ],
        },
      ],
    };
    socket.message(frame);
    expect(layouts).toHaveLength(1);
    socket.message(frame);
    expect(layouts).toHaveLength(1);
    expect(faults).toHaveLength(1);
    expect(socket.closed).toMatchObject({ code: 1008, reason: "protocol-error" });
  });

  it("calibrates five bounded clock probes before readiness and never exposes raw origins", async () => {
    const socket = new FakeSocket();
    const calibrations: unknown[] = [];
    const outcomes: unknown[] = [];
    let raw = 8_000_000_000_000;
    socket.onSend = (frame) => {
      if (frame.type === "redeem") {
        queueMicrotask(() =>
          socket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            connectionClientId: "tui:one",
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe") {
        const clientSendMicros = frame.clientSendMicros as number;
        queueMicrotask(() =>
          socket.message({
            type: "clock-probe-ack",
            requestId: REQUEST,
            daemonInstanceId: INSTANCE,
            probe: frame.probe,
            clientSendMicros,
            daemonReceiveMicros: clientSendMicros + 100,
            daemonSendMicros: clientSendMicros + 101,
          }),
        );
      }
    };
    await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["clock-bounds-v1"],
        diagnosticSharedNowMicros: () => (raw += 10),
        onClockCalibration: (value: unknown) => calibrations.push(value),
        onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
      }),
    );
    const probes = socket.sent.filter(
      (frame) => (frame as { type?: string }).type === "clock-probe",
    ) as Array<{ clientSendMicros: number }>;
    expect(probes).toHaveLength(5);
    expect(probes.every(({ clientSendMicros }) => clientSendMicros < 1_000)).toBe(true);
    expect(JSON.stringify(socket.sent)).not.toContain("8000000000000");
    expect(calibrations).toHaveLength(1);
    expect(calibrations[0]).toMatchObject({
      requestId: REQUEST,
      daemonInstanceId: INSTANCE,
      uncertaintyMicros: 9,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({
        reason: "calibrated",
        attemptedProbes: 5,
        receivedProbes: 5,
        validProbes: 5,
        selectedProbes: 1,
      }),
    ]);
    const finalProbe = socket.sent.findLast(
      (frame) => (frame as { type?: string }).type === "clock-probe",
    ) as { probe: number; clientSendMicros: number };
    socket.message({
      type: "clock-probe-ack",
      requestId: REQUEST,
      daemonInstanceId: INSTANCE,
      probe: finalProbe.probe,
      clientSendMicros: finalProbe.clientSendMicros,
      daemonReceiveMicros: finalProbe.clientSendMicros + 100,
      daemonSendMicros: finalProbe.clientSendMicros + 101,
    });
    expect(calibrations).toHaveLength(1);
  });

  it("does no clock work when the capability is absent", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    const shared = mock(() => {
      throw new Error("must not run");
    });
    await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        diagnosticClockProbeCount: 99,
        diagnosticSharedNowMicros: shared,
      }),
    );
    expect(shared).not.toHaveBeenCalled();
    expect(socket.sent.some((frame) => (frame as { type?: string }).type === "clock-probe")).toBe(
      false,
    );
  });

  it("settles a timed-out calibration once and ignores a late reply", async () => {
    const socket = new FakeSocket();
    const calibrations: unknown[] = [];
    const outcomes: unknown[] = [];
    let probe: { probe: number; clientSendMicros: number } | undefined;
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
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe") probe = frame as typeof probe;
    };
    await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["clock-bounds-v1"],
        diagnosticSharedNowMicros: (() => {
          let now = 1_000;
          return () => (now += 10);
        })(),
        onClockCalibration: (value: unknown) => calibrations.push(value),
        onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
      }),
    );
    expect(calibrations).toEqual([null]);
    expect(outcomes).toEqual([
      expect.objectContaining({
        reason: "timeout-no-sample",
        attemptedProbes: 1,
        receivedProbes: 0,
        validProbes: 0,
        selectedProbes: 0,
      }),
    ]);
    socket.message({
      type: "clock-probe-ack",
      requestId: REQUEST,
      daemonInstanceId: INSTANCE,
      probe: probe!.probe,
      clientSendMicros: probe!.clientSendMicros,
      daemonReceiveMicros: 100,
      daemonSendMicros: 101,
    });
    expect(calibrations).toEqual([null]);
    expect(outcomes).toHaveLength(1);
  });

  it("settles a retired pending calibration immediately and releases its timer", async () => {
    for (const retirement of ["socket-close", "protocol-failure"] as const) {
      const socket = new FakeSocket();
      const outcomes: unknown[] = [];
      let probe: Record<string, unknown> | null = null;
      const before = runtimeResourceSnapshot()["runtime-timer"].active;
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
              diagnosticCapabilities: ["clock-bounds-v1"],
            }),
          );
        } else if (frame.type === "clock-probe") {
          probe = frame;
          queueMicrotask(() => {
            if (retirement === "socket-close") socket.emit("close");
            else socket.message({ type: "not-a-pane-stream-frame" });
          });
        }
      };
      await expect(
        openPaneStreamRuntimeClient(
          options(socket, {
            requestInitialInputAuthority: false,
            diagnosticCapabilities: ["clock-bounds-v1"],
            diagnosticSharedNowMicros: (() => {
              let now = 1_000;
              return () => (now += 10);
            })(),
            onClockCalibration: () => undefined,
            onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
          }),
        ),
      ).rejects.toThrow();
      expect(outcomes).toEqual([
        expect.objectContaining({
          reason: "connection-closed",
          attemptedProbes: 1,
          receivedProbes: 0,
          validProbes: 0,
          selectedProbes: 0,
        }),
      ]);
      expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(before);
      socket.message({
        type: "clock-probe-ack",
        requestId: REQUEST,
        daemonInstanceId: INSTANCE,
        probe: probe!.probe,
        clientSendMicros: probe!.clientSendMicros,
        daemonReceiveMicros: 5,
        daemonSendMicros: 6,
      });
      expect(outcomes).toHaveLength(1);
    }
  });

  it("aborts a pending calibration immediately without adopting the provisional client", async () => {
    const socket = new FakeSocket();
    const controller = new AbortController();
    const outcomes: unknown[] = [];
    const onNegotiated = mock();
    const before = runtimeResourceSnapshot()["runtime-timer"].active;
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
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe") {
        queueMicrotask(() => controller.abort(new Error("retired generation")));
      }
    };
    await expect(
      openPaneStreamRuntimeClient(
        options(socket, {
          signal: controller.signal,
          onNegotiated,
          requestInitialInputAuthority: false,
          diagnosticCapabilities: ["clock-bounds-v1"],
          diagnosticSharedNowMicros: () => 1_000,
          onClockCalibration: () => undefined,
          onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
        }),
      ),
    ).rejects.toThrow("retired generation");
    expect(outcomes).toEqual([
      expect.objectContaining({
        reason: "connection-closed",
        attemptedProbes: 1,
        receivedProbes: 0,
        validProbes: 0,
        selectedProbes: 0,
      }),
    ]);
    expect(onNegotiated).not.toHaveBeenCalled();
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(before);
  });

  it("admits a 300ms cold first probe and calibrates before readiness", async () => {
    const socket = new FakeSocket();
    const outcomes: unknown[] = [];
    let now = 1_000;
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
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe") {
        const reply = () => {
          now += frame.probe === 1 ? 300_000 : 10;
          socket.message({
            type: "clock-probe-ack",
            requestId: REQUEST,
            daemonInstanceId: INSTANCE,
            probe: frame.probe,
            clientSendMicros: frame.clientSendMicros,
            daemonReceiveMicros: (frame.clientSendMicros as number) + 20,
            daemonSendMicros: (frame.clientSendMicros as number) + 21,
          });
        };
        if (frame.probe === 1) setTimeout(reply, 300);
        else queueMicrotask(reply);
      }
    };
    await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["clock-bounds-v1"],
        diagnosticSharedNowMicros: () => now,
        onClockCalibration: () => undefined,
        onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
      }),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ reason: "calibrated", attemptedProbes: 5, receivedProbes: 5 }),
    ]);
  });

  it("retains a valid sample when a later probe times out", async () => {
    const socket = new FakeSocket();
    const calibrations: unknown[] = [];
    const outcomes: unknown[] = [];
    let now = 1_000;
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
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe" && frame.probe === 1) {
        now += 20;
        queueMicrotask(() =>
          socket.message({
            type: "clock-probe-ack",
            requestId: REQUEST,
            daemonInstanceId: INSTANCE,
            probe: 1,
            clientSendMicros: frame.clientSendMicros,
            daemonReceiveMicros: (frame.clientSendMicros as number) + 5,
            daemonSendMicros: (frame.clientSendMicros as number) + 6,
          }),
        );
      }
    };
    await openPaneStreamRuntimeClient(
      options(socket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["clock-bounds-v1"],
        diagnosticSharedNowMicros: () => now,
        onClockCalibration: (value: unknown) => calibrations.push(value),
        onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
      }),
    );
    expect(calibrations[0]).toMatchObject({ probe: 1 });
    expect(outcomes).toEqual([
      expect.objectContaining({
        reason: "timeout-retained-sample",
        attemptedProbes: 2,
        receivedProbes: 1,
        validProbes: 1,
        selectedProbes: 1,
        selectedProbe: 1,
      }),
    ]);

    const failOpenSocket = new FakeSocket();
    let failOpenNow = 1_000;
    failOpenSocket.onSend = (frame) => {
      if (frame.type === "redeem") {
        queueMicrotask(() =>
          failOpenSocket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe") {
        failOpenNow += 10;
        queueMicrotask(() =>
          failOpenSocket.message({
            type: "clock-probe-ack",
            requestId: REQUEST,
            daemonInstanceId: INSTANCE,
            probe: frame.probe,
            clientSendMicros: frame.clientSendMicros,
            daemonReceiveMicros: (frame.clientSendMicros as number) + 2,
            daemonSendMicros: (frame.clientSendMicros as number) + 3,
          }),
        );
      }
    };
    await expect(
      openPaneStreamRuntimeClient(
        options(failOpenSocket, {
          requestInitialInputAuthority: false,
          diagnosticCapabilities: ["clock-bounds-v1"],
          diagnosticSharedNowMicros: () => failOpenNow,
          onClockCalibration: () => {
            throw new Error("calibration sink failed");
          },
          onClockCalibrationOutcome: () => {
            throw new Error("outcome sink failed");
          },
          onConnectionDiagnostic: (phase: string) => {
            if (phase === "clock-calibration") throw new Error("connection sink failed");
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("names malformed, duplicate, and unavailable calibration replies exactly once", async () => {
    const cases = [
      {
        reason: "ack-request-mismatch",
        mutate: (frame: Record<string, unknown>) => ({
          ...frame,
          requestId: "99999999-9999-4999-8999-999999999999",
        }),
      },
      {
        reason: "ack-generation-mismatch",
        mutate: (frame: Record<string, unknown>) => ({
          ...frame,
          daemonInstanceId: "99999999-9999-4999-8999-999999999999",
        }),
      },
      {
        reason: "ack-probe-mismatch",
        mutate: (frame: Record<string, unknown>) => ({ ...frame, probe: 2 }),
      },
      {
        reason: "ack-client-send-mismatch",
        mutate: (frame: Record<string, unknown>) => ({
          ...frame,
          clientSendMicros: (frame.clientSendMicros as number) + 1,
        }),
      },
    ] as const;
    for (const fixture of cases) {
      const socket = new FakeSocket();
      const outcomes: unknown[] = [];
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
              diagnosticCapabilities: ["clock-bounds-v1"],
            }),
          );
        } else if (frame.type === "clock-probe") {
          const ack = {
            type: "clock-probe-ack",
            requestId: REQUEST,
            daemonInstanceId: INSTANCE,
            probe: frame.probe,
            clientSendMicros: frame.clientSendMicros,
            daemonReceiveMicros: (frame.clientSendMicros as number) + 5,
            daemonSendMicros: (frame.clientSendMicros as number) + 6,
          };
          queueMicrotask(() => socket.message(fixture.mutate(ack)));
        }
      };
      await openPaneStreamRuntimeClient(
        options(socket, {
          requestInitialInputAuthority: false,
          diagnosticCapabilities: ["clock-bounds-v1"],
          diagnosticSharedNowMicros: () => 1_020,
          onClockCalibration: () => undefined,
          onClockCalibrationOutcome: (value: unknown) => outcomes.push(value),
        }),
      );
      expect(outcomes).toEqual([
        expect.objectContaining({
          reason: fixture.reason,
          attemptedProbes: 1,
          receivedProbes: 1,
          validProbes: 0,
          selectedProbes: 0,
        }),
      ]);
    }

    const duplicateSocket = new FakeSocket();
    const duplicateOutcomes: unknown[] = [];
    let firstAck: Record<string, unknown> | null = null;
    duplicateSocket.onSend = (frame) => {
      if (frame.type === "redeem") {
        queueMicrotask(() =>
          duplicateSocket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
      } else if (frame.type === "clock-probe" && frame.probe === 1) {
        firstAck = {
          type: "clock-probe-ack",
          requestId: REQUEST,
          daemonInstanceId: INSTANCE,
          probe: 1,
          clientSendMicros: frame.clientSendMicros,
          daemonReceiveMicros: (frame.clientSendMicros as number) + 5,
          daemonSendMicros: (frame.clientSendMicros as number) + 6,
        };
        queueMicrotask(() => duplicateSocket.message(firstAck));
      } else if (frame.type === "clock-probe" && frame.probe === 2) {
        queueMicrotask(() => duplicateSocket.message(firstAck));
      }
    };
    await openPaneStreamRuntimeClient(
      options(duplicateSocket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["clock-bounds-v1"],
        diagnosticSharedNowMicros: (() => {
          let now = 1_000;
          return () => (now += 10);
        })(),
        onClockCalibration: () => undefined,
        onClockCalibrationOutcome: (value: unknown) => duplicateOutcomes.push(value),
      }),
    );
    expect(duplicateOutcomes).toEqual([
      expect.objectContaining({
        reason: "ack-probe-mismatch",
        attemptedProbes: 2,
        receivedProbes: 2,
        validProbes: 1,
        selectedProbes: 0,
      }),
    ]);

    const clockSocket = new FakeSocket();
    const clockOutcomes: unknown[] = [];
    clockSocket.onSend = (frame) => {
      if (frame.type === "redeem")
        queueMicrotask(() =>
          clockSocket.message({
            type: "ready",
            protocolVersion: 1,
            daemonInstanceId: INSTANCE,
            requestId: REQUEST,
            panes: ["pane.editor"],
            effectiveViewerMode: "interactive",
            diagnosticCapabilities: ["clock-bounds-v1"],
          }),
        );
    };
    await openPaneStreamRuntimeClient(
      options(clockSocket, {
        requestInitialInputAuthority: false,
        diagnosticCapabilities: ["clock-bounds-v1"],
        diagnosticSharedNowMicros: () => {
          throw new Error("clock unavailable");
        },
        onClockCalibration: () => undefined,
        onClockCalibrationOutcome: (value: unknown) => clockOutcomes.push(value),
      }),
    );
    expect(clockOutcomes).toEqual([
      expect.objectContaining({
        reason: "clock-unavailable",
        attemptedProbes: 1,
        receivedProbes: 0,
        validProbes: 0,
        selectedProbes: 0,
      }),
    ]);
  });

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
      `${keyTrace}:pane-stream-observer-returned`,
      `${pasteTrace}:pane-stream-frame-enqueued`,
      `${pasteTrace}:pane-stream-socket-send-return`,
      `${pasteTrace}:pane-stream-next-event-loop-turn`,
      `${pasteTrace}:pane-stream-observer-returned`,
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
        "pane-stream-observer-returned",
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

  it("records bounded socket buffer admission and a next-turn drain watermark", async () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 0;
    acceptInteractiveHandshake(socket);
    const priorOnSend = socket.onSend;
    socket.onSend = (frame) => {
      priorOnSend?.(frame);
      if (frame.type === "input") socket.bufferedAmount = 384;
    };
    const turns: Array<() => void> = [];
    const stages: PaneStreamInputTransportStageEvent[] = [];
    const client = await openPaneStreamRuntimeClient(
      options(socket, {
        onInputTransportStage: (event: PaneStreamInputTransportStageEvent) => stages.push(event),
        diagnosticNowMicros: () => 1_000,
        diagnosticNextTurn: (callback: () => void) => {
          turns.push(callback);
          return () => undefined;
        },
      }),
    );
    const pending = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.editor" },
      { kind: "key", data: "x" },
      "00000000-0000-4000-8000-000000000099",
    );
    socket.bufferedAmount = 0;
    turns.forEach((turn) => turn());
    await pending;
    expect(
      stages
        .filter(({ operation }) => operation.includes("buffer"))
        .map(({ operation, bufferedAmount, drained }) => ({
          operation,
          bufferedAmount,
          drained,
        })),
    ).toEqual([
      {
        operation: "pane-stream-buffer-before-send",
        bufferedAmount: 0,
        drained: undefined,
      },
      {
        operation: "pane-stream-buffer-after-send",
        bufferedAmount: 384,
        drained: undefined,
      },
      {
        operation: "pane-stream-buffer-next-turn",
        bufferedAmount: 0,
        drained: undefined,
      },
      {
        operation: "pane-stream-buffer-drain-watermark",
        bufferedAmount: 0,
        drained: true,
      },
    ]);
    expect(classifyPaneStreamInputTransportDelay(stages, 10_000)).toBe("no-client-transport-stall");
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
    expect(stages.map(({ atMicros }) => atMicros)).toEqual([10, 20, 30, 300_040]);
    expect(stages.at(-1)?.operation).toBe("pane-stream-observer-returned");
    expect(classifyPaneStreamInputTransportDelay(stages, 1_000)).toBe("observer-callback-stall");
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
            connectionClientId: "tui:one",
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
    expect(client.connectionClientId).toBe("tui:one");
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

  it("serializes an immediate reclaim behind a delayed release acknowledgement", async () => {
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
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const initial = client.requestAuthority("focus");
    await Bun.sleep(0);
    const initialRequest = socket.sent.find((frame) => frame.type === "authority-request")!;
    socket.message({
      type: "authority-receipt",
      requestId: initialRequest.requestId,
      authority: "focus",
      status: "granted",
      lease: {
        generation: INSTANCE,
        session: "alpha",
        clientId: "tui:one",
        authority: "focus",
        token: "55555555-5555-4555-8555-555555555555",
        revision: 2,
      },
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 2,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: "tui:one", geometry: null },
        clients: [],
      },
    });
    await initial;

    const release = client.releaseAuthority("focus");
    expect(client.ownsConnectionAuthority("focus")).toBe(false);
    const reclaimOne = client.requestAuthority("focus");
    const reclaimTwo = client.requestAuthority("focus");
    await Bun.sleep(0);
    const releaseFrame = socket.sent.find((frame) => frame.type === "authority-release")!;
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(1);

    socket.message({
      type: "authority-receipt",
      requestId: releaseFrame.requestId,
      authority: "focus",
      status: "released",
      lease: null,
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    await release;
    await Bun.sleep(0);
    const requestFrames = socket.sent.filter((frame) => frame.type === "authority-request");
    expect(requestFrames).toHaveLength(2);
    expect(socket.sent.indexOf(releaseFrame)).toBeLessThan(socket.sent.indexOf(requestFrames[1]!));
    const reclaimRequest = requestFrames[1]!;
    socket.message({
      type: "authority-receipt",
      requestId: reclaimRequest.requestId,
      authority: "focus",
      status: "granted",
      lease: {
        generation: INSTANCE,
        session: "alpha",
        clientId: "tui:one",
        authority: "focus",
        token: "66666666-6666-4666-8666-666666666666",
        revision: 4,
      },
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 4,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: "tui:one", geometry: null },
        clients: [],
      },
    });
    const [one, two] = await Promise.all([reclaimOne, reclaimTwo]);
    expect(one).toEqual(two);
    expect(client.ownsConnectionAuthority("focus")).toBe(true);
    expect(client.connectionAuthorityClientId("focus")).toBe("tui:one");
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(2);
    client.close();
  });

  it("emits a queued release after the preceding authority request times out", async () => {
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
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const request = client.requestAuthority("input");
    void request.catch(() => undefined);
    const release = client.releaseAuthority("input");
    await Bun.sleep(2_050);
    await expect(request).rejects.toThrow("authority timed out");
    const requestFrame = socket.sent.find((frame) => frame.type === "authority-request")!;
    const releaseFrame = socket.sent.find((frame) => frame.type === "authority-release")!;
    expect(socket.sent.indexOf(requestFrame)).toBeLessThan(socket.sent.indexOf(releaseFrame));

    socket.message({
      type: "authority-receipt",
      requestId: requestFrame.requestId,
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
    });
    expect(client.ownsConnectionAuthority("input")).toBe(false);
    expect(client.connectionAuthorityClientId("input")).toBeNull();
    socket.message({
      type: "authority-receipt",
      requestId: releaseFrame.requestId,
      authority: "input",
      status: "released",
      lease: null,
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    await expect(release).resolves.toMatchObject({ owners: { input: null } });
    client.close();
  });

  it("coalesces a fresh reclaim after release timeout and ignores one exact late ACK", async () => {
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
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const release = client.releaseAuthority("geometry");
    void release.catch(() => undefined);
    const reclaimOne = client.requestAuthority("geometry");
    const reclaimTwo = client.requestAuthority("geometry");
    await Bun.sleep(2_050);
    await expect(release).rejects.toThrow("release timed out");
    const releaseFrame = socket.sent.find((frame) => frame.type === "authority-release")!;
    const requestFrames = socket.sent.filter((frame) => frame.type === "authority-request");
    expect(requestFrames).toHaveLength(1);
    const reclaimFrame = requestFrames[0]!;

    socket.message({
      type: "authority-receipt",
      requestId: releaseFrame.requestId,
      authority: "geometry",
      status: "released",
      lease: null,
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    expect(client.ownsConnectionAuthority("geometry")).toBe(false);
    socket.message({
      type: "authority-receipt",
      requestId: reclaimFrame.requestId,
      authority: "geometry",
      status: "granted",
      lease: {
        generation: INSTANCE,
        session: "alpha",
        clientId: "tui:one",
        authority: "geometry",
        token: "66666666-6666-4666-8666-666666666666",
        revision: 4,
      },
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 4,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: "tui:one" },
        clients: [],
      },
    });
    await Promise.all([reclaimOne, reclaimTwo]);
    expect(client.ownsConnectionAuthority("geometry")).toBe(true);
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(1);

    socket.message({
      type: "authority-receipt",
      requestId: releaseFrame.requestId,
      authority: "geometry",
      status: "released",
      lease: null,
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
  });

  it("rejects a serialized authority chain on close without emitting its queued operations", async () => {
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
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const initial = client.requestAuthority("input");
    const release = client.releaseAuthority("input");
    const reclaim = client.requestAuthority("input");
    client.close();

    expect(
      (await Promise.allSettled([initial, release, reclaim])).every(
        (result) => result.status === "rejected",
      ),
    ).toBe(true);
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(1);
    expect(socket.sent.filter((frame) => frame.type === "authority-release")).toHaveLength(0);
  });

  it("rejects every pending authority action status or lease inconsistency", async () => {
    const cases = [
      { action: "request", status: "released", lease: null },
      { action: "request", status: "granted", lease: null },
      { action: "request", status: "rejected", lease: "present" },
      { action: "release", status: "granted", lease: "present" },
      { action: "release", status: "rejected", lease: null },
      { action: "release", status: "released", lease: "present" },
    ] as const;
    for (const testCase of cases) {
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
      const client = await openPaneStreamRuntimeClient(
        options(socket, { requestInitialInputAuthority: false }),
      );
      const operation =
        testCase.action === "request"
          ? client.requestAuthority("input")
          : client.releaseAuthority("input");
      await Bun.sleep(0);
      const sent = socket.sent.find((frame) =>
        testCase.action === "request"
          ? frame.type === "authority-request"
          : frame.type === "authority-release",
      )!;
      const lease =
        testCase.lease === "present"
          ? {
              generation: INSTANCE,
              session: "alpha",
              clientId: "tui:one",
              authority: "input" as const,
              token: "55555555-5555-4555-8555-555555555555",
              revision: 2,
            }
          : null;
      socket.message({
        type: "authority-receipt",
        requestId: sent.requestId,
        authority: "input",
        status: testCase.status,
        lease,
        snapshot: {
          generation: INSTANCE,
          session: "alpha",
          revision: 2,
          nativeGeometryYieldUntilMs: 0,
          owners: {
            input: testCase.status === "granted" ? "tui:one" : null,
            focus: null,
            geometry: null,
          },
          clients: [],
        },
      });
      await expect(operation).rejects.toThrow("did not match a request");
      expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
    }
  });

  it("rejects an action-mismatched receipt for a retired authority request", async () => {
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
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const request = client.requestAuthority("focus");
    void request.catch(() => undefined);
    await Bun.sleep(2_050);
    await expect(request).rejects.toThrow("authority timed out");
    const requestFrame = socket.sent.find((frame) => frame.type === "authority-request")!;
    socket.message({
      type: "authority-receipt",
      requestId: requestFrame.requestId,
      authority: "focus",
      status: "released",
      lease: null,
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
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
            outcome: "ok",
            authorityLease: frame.authorityLease,
          }),
        );
      } else if (frame.type === "authority-request") {
        const authorityRevision = frame.authority === "geometry" ? 2 : 1;
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
              revision: authorityRevision,
            },
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision: authorityRevision,
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
    let consumedOwnedChunk: Uint8Array | null = null;
    let consumedOwnedChunkContents: number[] | null = null;
    const onTerminalDelivery = mock((_: string, message: TerminalDeliveryServerMessage) => {
      if (message.type !== "terminal.delivery.chunk") return;
      consumedOwnedChunk = message.bytes;
      consumedOwnedChunkContents = [...message.bytes];
      return { consumedOwnedChunk: true as const };
    });
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
      {
        type: "viewport",
        seq: 1,
        cols: 132,
        rows: 44,
        authorityLease: {
          generation: INSTANCE,
          session: "alpha",
          clientId: "tui:one",
          authority: "geometry",
          token: "55555555-5555-4555-8555-555555555555",
          revision: 2,
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
      expect.objectContaining({ transactionId: TRANSACTION, index: 0 }),
    );
    expect(consumedOwnedChunkContents).toEqual([104, 105]);
    expect(consumedOwnedChunk?.byteLength).toBe(0);
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

  it("requests a connection-local geometry grant when a fresh socket inherits global ownership", async () => {
    const socket = new FakeSocket();
    let grantRevision = 3;
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
      } else if (frame.type === "authority-request") {
        const revision = grantRevision;
        grantRevision += 2;
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: "geometry",
            status: "granted",
            lease: {
              generation: INSTANCE,
              session: "alpha",
              clientId: "tui:one",
              authority: "geometry",
              token: "55555555-5555-4555-8555-555555555555",
              revision,
            },
            snapshot: {
              generation: INSTANCE,
              session: "alpha",
              revision,
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
            outcome: "ok",
            authorityLease: frame.authorityLease,
          }),
        );
      }
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    expect(client.ownsConnectionAuthority("geometry")).toBe(false);
    await client.fitViewport(120, 40);
    expect(client.ownsConnectionAuthority("geometry")).toBe(true);
    await client.fitViewport(121, 41);
    expect(await client.requestAuthority("geometry")).not.toBeNull();
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(1);
    expect(socket.sent.findIndex((frame) => frame.type === "authority-request")).toBeLessThan(
      socket.sent.findIndex((frame) => frame.type === "viewport"),
    );
    expect(socket.sent.filter((frame) => frame.type === "viewport")).toHaveLength(2);
    socket.message({
      type: "authority-snapshot",
      snapshot: {
        generation: INSTANCE,
        session: "alpha",
        revision: 4,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    expect(client.ownsConnectionAuthority("geometry")).toBe(false);
    await client.fitViewport(122, 42);
    expect(socket.sent.filter((frame) => frame.type === "authority-request")).toHaveLength(2);
    client.close();
  });

  it("keeps semantic workspace and authenticated authority runtime session distinct", async () => {
    const socket = new FakeSocket();
    const runtimeSession = "tmux-runtime-a";
    let revision = 1;
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
              session: runtimeSession,
              revision,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: null, focus: null, geometry: null },
              clients: [],
            },
          }),
        );
      } else if (frame.type === "authority-request") {
        revision += 1;
        const granted = frame.authority === "geometry";
        const leaseRevision = revision;
        if (granted) revision += 1;
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: frame.authority,
            status: granted ? "granted" : "rejected",
            lease: granted
              ? {
                  generation: INSTANCE,
                  session: runtimeSession,
                  clientId: "tui:one",
                  authority: frame.authority,
                  token: "55555555-5555-4555-8555-555555555555",
                  revision: leaseRevision,
                }
              : null,
            snapshot: {
              generation: INSTANCE,
              session: runtimeSession,
              revision,
              nativeGeometryYieldUntilMs: 0,
              owners: {
                input: null,
                focus: null,
                geometry: granted ? "tui:one" : null,
              },
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
            outcome: "ok",
            authorityLease: frame.authorityLease,
          }),
        );
      } else if (frame.type === "authority-release") {
        revision += 1;
        queueMicrotask(() =>
          socket.message({
            type: "authority-receipt",
            requestId: frame.requestId,
            authority: frame.authority,
            status: "released",
            lease: null,
            snapshot: {
              generation: INSTANCE,
              session: runtimeSession,
              revision,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: null, focus: null, geometry: null },
              clients: [],
            },
          }),
        );
      }
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    await expect(client.requestAuthority("focus")).resolves.toBeNull();
    await expect(client.fitViewport(140, 46)).resolves.toBe("ok");
    const viewport = socket.sent.find((frame) => frame.type === "viewport");
    expect(viewport).toMatchObject({
      cols: 140,
      rows: 46,
      authorityLease: { session: runtimeSession, authority: "geometry", revision: 3 },
    });
    await expect(client.releaseAuthority("geometry")).resolves.toMatchObject({
      session: runtimeSession,
      owners: { geometry: null },
    });
    socket.message({
      type: "authority-snapshot",
      snapshot: {
        generation: INSTANCE,
        session: runtimeSession,
        revision: revision + 1,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    expect(socket.closed).toBeNull();
    socket.message({
      type: "authority-snapshot",
      snapshot: {
        generation: INSTANCE,
        session: "tmux-runtime-b",
        revision: revision + 2,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      },
    });
    expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
  });

  it("accepts only monotonic or exactly idempotent authority snapshot replay", async () => {
    const initial = {
      generation: INSTANCE,
      session: "tmux-runtime-a",
      revision: 3,
      nativeGeometryYieldUntilMs: 0,
      owners: { input: "tui:one", focus: null, geometry: null },
      clients: [
        {
          clientId: "tui:one",
          surface: "opentui" as const,
          state: "foreground" as const,
          connectedRevision: 1,
          activityRevision: 2,
        },
      ],
    };
    const open = async () => {
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
              authority: initial,
            }),
          );
        }
      };
      const client = await openPaneStreamRuntimeClient(
        options(socket, { requestInitialInputAuthority: false }),
      );
      return { client, socket };
    };

    const duplicate = await open();
    duplicate.socket.message({ type: "authority-snapshot", snapshot: initial });
    expect(duplicate.socket.closed).toBeNull();
    duplicate.client.close();

    const regressing = await open();
    regressing.socket.message({
      type: "authority-snapshot",
      snapshot: { ...initial, revision: 2 },
    });
    expect(regressing.socket.closed).toEqual({ code: 1008, reason: "protocol-error" });

    const conflicting = await open();
    conflicting.socket.message({
      type: "authority-snapshot",
      snapshot: { ...initial, owners: { ...initial.owners, focus: "tui:one" } },
    });
    expect(conflicting.socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
  });

  it.each([
    ["granted", "regressing"],
    ["granted", "same-revision-conflict"],
    ["rejected", "regressing"],
    ["rejected", "same-revision-conflict"],
    ["released", "regressing"],
    ["released", "same-revision-conflict"],
  ] as const)(
    "does not continue a %s authority receipt after a %s snapshot",
    async (status, staleKind) => {
      const socket = new FakeSocket();
      const initial = {
        generation: INSTANCE,
        session: "tmux-runtime-a",
        revision: 3,
        nativeGeometryYieldUntilMs: 0,
        owners: { input: null, focus: null, geometry: null },
        clients: [],
      };
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
            authority: initial,
          }),
        );
      };
      const client = await openPaneStreamRuntimeClient(
        options(socket, { requestInitialInputAuthority: false }),
      );
      const operation =
        status === "released" ? client.releaseAuthority("focus") : client.requestAuthority("focus");
      void operation.catch(() => undefined);
      await Promise.resolve();
      const request = socket.sent.find((frame) =>
        status === "released"
          ? frame.type === "authority-release"
          : frame.type === "authority-request",
      )!;
      const granted = status === "granted";
      const snapshot = {
        ...initial,
        revision: staleKind === "regressing" ? 2 : 3,
        nativeGeometryYieldUntilMs: staleKind === "same-revision-conflict" ? 1 : 0,
        owners: { ...initial.owners, focus: granted ? "tui:one" : null },
      };
      socket.message({
        type: "authority-receipt",
        requestId: request.requestId,
        authority: "focus",
        status,
        lease: granted
          ? {
              generation: INSTANCE,
              session: "tmux-runtime-a",
              clientId: "tui:one",
              authority: "focus",
              token: "55555555-5555-4555-8555-555555555555",
              revision: snapshot.revision,
            }
          : null,
        snapshot,
      });
      await expect(operation).rejects.toThrow();
      expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
      expect(client.ownsConnectionAuthority("focus")).toBe(false);
    },
  );

  it.each([
    ["geometry-authority-conflict", "55555555-5555-4555-8555-555555555555"],
    ["ok", "66666666-6666-4666-8666-666666666666"],
  ] as const)("binds viewport outcome %s to the exact granted lease", async (outcome, token) => {
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
            authority: "geometry",
            status: "granted",
            lease: {
              generation: INSTANCE,
              session: "tmux-runtime-a",
              clientId: "tui:one",
              authority: "geometry",
              token: "55555555-5555-4555-8555-555555555555",
              revision: 1,
            },
            snapshot: {
              generation: INSTANCE,
              session: "tmux-runtime-a",
              revision: 1,
              nativeGeometryYieldUntilMs: 0,
              owners: { input: null, focus: null, geometry: "tui:one" },
              clients: [],
            },
          }),
        );
      } else if (frame.type === "viewport") {
        queueMicrotask(() => {
          if (outcome === "geometry-authority-conflict") {
            socket.message({
              type: "authority-snapshot",
              snapshot: {
                generation: INSTANCE,
                session: "tmux-runtime-a",
                revision: 2,
                nativeGeometryYieldUntilMs: 0,
                owners: { input: null, focus: null, geometry: null },
                clients: [],
              },
            });
          }
          socket.message({
            type: "viewport-ack",
            seq: frame.seq,
            cols: frame.cols,
            rows: frame.rows,
            outcome,
            authorityLease: { ...frame.authorityLease, token },
          });
        });
      }
    };
    const client = await openPaneStreamRuntimeClient(
      options(socket, { requestInitialInputAuthority: false }),
    );
    const fitted = client.fitViewport(140, 46);
    if (outcome === "geometry-authority-conflict") {
      await expect(fitted).resolves.toBe("geometry-authority-conflict");
      expect(client.ownsConnectionAuthority("geometry")).toBe(false);
      expect(socket.closed).toBeNull();
    } else {
      await expect(fitted).rejects.toThrow();
      expect(socket.closed).toEqual({ code: 1008, reason: "protocol-error" });
    }
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

  it("rejects a daemon ready identity for another redeemed client", async () => {
    const socket = new FakeSocket();
    socket.onSend = (frame) => {
      if (frame.type !== "redeem") return;
      queueMicrotask(() =>
        socket.message({
          type: "ready",
          protocolVersion: 1,
          daemonInstanceId: INSTANCE,
          requestId: REQUEST,
          connectionClientId: "web:foreign",
          panes: ["pane.editor"],
          effectiveViewerMode: "interactive",
        }),
      );
    };
    await expect(openPaneStreamRuntimeClient(options(socket))).rejects.toThrow(
      "peer client identity did not match",
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

  it("preserves a retryable topology rejection as an exact typed runtime fault", async () => {
    const socket = new FakeSocket();
    acceptInteractiveHandshake(socket);
    const onFault = mock();
    await openPaneStreamRuntimeClient(options(socket, { onFault }));

    socket.message({
      type: "error",
      protocolVersion: 1,
      code: "topology-changed",
      retryable: true,
    });

    expect(onFault).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "PaneStreamOperationError",
        code: "topology-changed",
      }),
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
