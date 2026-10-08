import { knownTabFrame, readDeliveredFrame } from "./native-physical-cell-oracle.ts";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { expect, vi } from "vitest";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamServerFrameSchemaZ,
  STOCK_CAPTURE_TAB_UNAVAILABLE,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  TerminalDeliveryAssembler,
  decodeSemanticTerminalUpdate,
  applyTerminalReplicaPatch,
} from "@tmux-ide/core";
import { SessionRuntimeRegistry } from "../../session-runtime/registry.ts";
import { createPaneStreamRuntime } from "../../pane-stream/runtime.ts";
import { attachPaneStreamWebSocket } from "../../../server/pane-stream-upgrade.ts";
import { MirrorControlChannel } from "../control-channel.ts";

/** Actual registry → delivery hub → HTTP upgrade → one WebSocket, on the caller's private server. */
export async function qualifyStockTabWire(options: {
  binary: string;
  socket: string;
  native: boolean;
  nativeText: () => string;
  record: (evidence: unknown) => void;
  paintLate: () => Promise<void>;
  resizeLate: () => void;
}) {
  const generation = randomUUID();
  const registry = new SessionRuntimeRegistry({
    generation,
    mirror: {
      executable: options.binary,
      socketName: options.socket,
      configFile: "/dev/null",
      createIo: (session, handlers) =>
        new MirrorControlChannel({
          executable: options.binary,
          socketName: options.socket,
          configFile: "/dev/null",
          session,
          handlers,
        }),
    },
  });
  const server = createServer();
  let runtime: ReturnType<typeof createPaneStreamRuntime> | undefined;
  let boundary: ReturnType<typeof attachPaneStreamWebSocket> | undefined;
  let ws: WebSocket | undefined;
  const frames: ReturnType<typeof PaneStreamServerFrameSchemaZ.parse>[] = [];
  const received = new Map<string, TerminalReplicaSnapshot>();
  const assemblers = new Map<string, TerminalDeliveryAssembler>();
  const errors: string[] = [];
  const trace: unknown[] = [];
  let cleanupError: unknown;
  let failure: unknown;
  const evidence = {
    frames,
    trace,
    errors,
    cleanup: { completed: false, error: null as string | null },
  };
  options.record(evidence);
  const bounded = async (promise: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("wire cleanup timed out")), 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const authority = await registry.describeSessionAuthority("tabs");
    const bad = authority.description.panes.find((p) => p.windowName === "bad")!.semanticPaneId;
    const late = authority.description.panes.find((p) => p.windowName === "late")!.semanticPaneId;
    const good = authority.description.panes.find((p) => p.windowName === "good")!.semanticPaneId;
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const a = server.address();
        if (!a || typeof a === "string") reject(Error("missing port"));
        else resolve(a.port);
      });
    });
    const url = `ws://127.0.0.1:${port}${PANE_STREAM_REDEEM_PATH}`;
    runtime = createPaneStreamRuntime({
      daemonInstanceId: generation,
      webSocketUrl: url,
      sessionRuntimeRegistry: registry,
    });
    boundary = attachPaneStreamWebSocket(server, runtime.coordinator);
    const requestId = randomUUID();
    const origin = "tmux-ide://app";
    const descriptor = await runtime.coordinator.issue(
      {
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: "tabs",
        panes: [bad, good, late],
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-v1"],
          richPlacements: false,
        },
      },
      {
        requestId,
        projectIdentity: "tabs",
        sessionName: "tabs",
        rendererOrigin: origin,
        hostClientId: `stock-tab:${requestId}`,
      },
    );
    ws = new WebSocket(url, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], { origin });
    const send = (frame: unknown) => ws!.send(JSON.stringify(frame));
    ws.on("message", (data) => {
      try {
        const frame = PaneStreamServerFrameSchemaZ.parse(JSON.parse(String(data)));
        frames.push(frame);
        if (frame.type === "terminal-delivery-envelope")
          assemblers.set(frame.pane, new TerminalDeliveryAssembler(frame.envelope));
        if (frame.type === "terminal-delivery-chunk") {
          const assembler = assemblers.get(frame.pane);
          if (!assembler) throw Error("chunk without envelope");
          assembler.write({
            type: "terminal.delivery.chunk",
            transactionId: frame.transactionId,
            index: frame.index,
            bytes: Buffer.from(frame.data, "base64"),
          });
          const e = assembler.envelope;
          if (frame.index + 1 === e.chunkCount) {
            const update = decodeSemanticTerminalUpdate(assembler.complete());
            if (update.frame === "seed") received.set(frame.pane, update.snapshot);
            else if (update.frame === "patch")
              received.set(
                frame.pane,
                applyTerminalReplicaPatch(received.get(frame.pane)!, update.patch),
              );
            else received.delete(frame.pane);
            trace.push({ pane: frame.pane, frame: update.frame, revision: update.revision });
            send({
              type: "terminal-delivery-ack",
              ack: {
                type: "terminal.delivery.ack",
                workspaceName: e.workspaceName,
                semanticPaneId: e.semanticPaneId,
                generation: e.generation,
                incarnation: e.incarnation,
                deliveryNonce: e.deliveryNonce,
                transactionId: e.transactionId,
                canonicalRevision: e.canonicalRevision,
                canonicalStateHash: e.canonicalStateHash,
                representationHash: e.representationHash,
              },
            });
            assemblers.delete(frame.pane);
          }
        }
      } catch (error) {
        errors.push(String(error));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    send({
      type: "redeem",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      ticket: descriptor.redemptionTicket,
      requestId,
      daemonInstanceId: generation,
    });
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(frames.filter((f) => f.type === "terminal-delivery-ready")).toHaveLength(3);
        expect(received.has(good)).toBe(true);
        expect(received.has(late)).toBe(true);
        if (options.native) expect(received.has(bad)).toBe(true);
        else
          expect(
            frames.filter((f) => f.type === "terminal-delivery-fault" && f.pane === bad),
          ).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    if (!options.native) {
      const fault = frames.find((f) => f.type === "terminal-delivery-fault" && f.pane === bad)!;
      expect(fault.type === "terminal-delivery-fault" && fault.fault.message).toBe(
        STOCK_CAPTURE_TAB_UNAVAILABLE,
      );
      const negotiation = frames.find(
        (f) => f.type === "terminal-delivery-ready" && f.pane === bad,
      )!;
      if (
        negotiation.type !== "terminal-delivery-ready" ||
        !negotiation.negotiation.accepted ||
        fault.type !== "terminal-delivery-fault"
      )
        throw Error("missing negotiation");
      expect(fault.fault.deliveryNonce).toBe(negotiation.negotiation.negotiated.deliveryNonce);
      expect(frames.indexOf(negotiation)).toBeLessThan(frames.indexOf(fault));
      expect(received.has(bad)).toBe(false);
      expect(
        frames.filter((f) => f.type === "terminal-delivery-envelope" && f.pane === bad),
      ).toHaveLength(0);
    }
    send({ type: "presence", generation, state: "foreground" });
    const authorityRequestId = randomUUID();
    send({
      type: "authority-request",
      generation,
      requestId: authorityRequestId,
      authority: "input",
    });
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(
          frames.filter(
            (frame) => frame.type === "authority-receipt" && frame.requestId === authorityRequestId,
          ),
        ).toEqual([expect.objectContaining({ authority: "input", status: "granted" })]);
      },
      { timeout: 3000 },
    );
    const marker = "wire-" + randomUUID().slice(0, 8);
    send({ type: "input", kind: "text", pane: good, seq: 1, data: marker });
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(
          frames
            .filter((f) => f.type === "input-ack" && f.pane === good)
            .map((f) => f.type === "input-ack" && f.seq),
        ).toEqual([1]);
        expect(options.nativeText()).toContain("ACK:" + marker);
        expect(
          received
            .get(good)
            ?.grid.map((r) => r.cells.map((c) => c.grapheme).join(""))
            .join("\n"),
        ).toContain("ACK:" + marker);
        expect(ws!.readyState).toBe(WebSocket.OPEN);
      },
      { timeout: 5000 },
    );
    expect(frames.filter((f) => f.type === "terminal-delivery-fault")).toHaveLength(
      options.native ? 0 : 1,
    );
    // Live HT is valid: source provenance, not the mere presence of HT in output,
    // controls rejection. Wait for its canonical update before native resize.
    await options.paintLate();
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(received.get(late)?.grid[0]?.cells[0]?.grapheme).toBe("A");
        expect(received.get(late)?.grid[0]?.cells[7]?.grapheme).toBe("B");
        expect(
          frames.filter((f) => f.type === "terminal-delivery-fault" && f.pane === late),
        ).toHaveLength(0);
      },
      { timeout: 4000 },
    );
    trace.push({ phase: "live-tab-before-recapture", late, snapshot: received.get(late) });
    options.resizeLate();
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        if (options.native) {
          const snapshot = received.get(late)!;
          expect(snapshot.rows).toBe(5);
          expect(snapshot.cols).toBe(8);
          expect(readDeliveredFrame(snapshot).cells[0]).toEqual(knownTabFrame("initial").cells[0]);
        } else
          expect(
            frames.filter((f) => f.type === "terminal-delivery-fault" && f.pane === late),
          ).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    if (!options.native) {
      const fault = frames.find((f) => f.type === "terminal-delivery-fault" && f.pane === late)!;
      const ready = frames.find((f) => f.type === "terminal-delivery-ready" && f.pane === late)!;
      if (
        fault.type !== "terminal-delivery-fault" ||
        ready.type !== "terminal-delivery-ready" ||
        !ready.negotiation.accepted
      )
        throw Error("missing late delivery identity");
      expect(fault.fault.message).toBe(STOCK_CAPTURE_TAB_UNAVAILABLE);
      expect(fault.fault.deliveryNonce).toBe(ready.negotiation.negotiated.deliveryNonce);
      expect(
        frames
          .slice(frames.indexOf(fault) + 1)
          .filter((f) => f.type === "terminal-delivery-envelope" && f.pane === late),
      ).toHaveLength(0);
    }
    const secondMarker = "after-" + randomUUID().slice(0, 8);
    send({ type: "input", kind: "text", pane: good, seq: 2, data: secondMarker });
    await vi.waitFor(
      () => {
        expect(errors).toEqual([]);
        expect(
          frames
            .filter((f) => f.type === "input-ack" && f.pane === good)
            .map((f) => f.type === "input-ack" && f.seq),
        ).toEqual([1, 2]);
        expect(options.nativeText()).toContain("ACK:" + secondMarker);
        expect(
          received
            .get(good)
            ?.grid.map((r) => r.cells.map((c) => c.grapheme).join(""))
            .join("\n"),
        ).toContain("ACK:" + secondMarker);
        expect(ws!.readyState).toBe(WebSocket.OPEN);
        expect(frames.filter((f) => f.type === "terminal-delivery-fault")).toHaveLength(
          options.native ? 0 : 2,
        );
      },
      { timeout: 5000 },
    );
    if (!options.native) {
      const faultIndex = frames.findIndex(
        (f) => f.type === "terminal-delivery-fault" && f.pane === late,
      );
      expect(faultIndex).toBeGreaterThan(-1);
      expect(
        frames
          .slice(faultIndex + 1)
          .filter((f) => f.type === "terminal-delivery-envelope" && f.pane === late),
      ).toHaveLength(0);
    }
    trace.push({ marker, secondMarker, good, bad, late, port, phase: "after-late-recapture" });
  } catch (error) {
    failure = error;
    errors.push(String(error));
  } finally {
    ws?.terminate();
    for (const dispose of [
      () => runtime?.dispose(),
      () => boundary?.close(),
      () => registry.dispose(),
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    ]) {
      try {
        const promise = dispose();
        if (promise) await bounded(promise);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    evidence.cleanup.completed = !cleanupError;
    evidence.cleanup.error = cleanupError ? String(cleanupError) : null;
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
  return evidence;
}
