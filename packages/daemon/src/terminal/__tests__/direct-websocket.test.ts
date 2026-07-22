import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { TerminalAttachRequest } from "@tmux-ide/contracts";
import {
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL,
  TerminalAttachmentAdmissionCoordinator,
  TerminalAttachmentAdmissionError,
  type DirectTerminalAttachmentLeaseManager,
  type DirectTerminalSocket,
  type TerminalAttachmentPreAuthAdmission,
} from "../attachments/direct-websocket.ts";
import type {
  AttachmentLeaseBinding,
  AttachmentLeaseDescriptor,
  ExecutedAttachmentViewOperation,
  IssuedAttachmentLease,
} from "../attachments/lease-manager.ts";
import type { ClaimedPtyTmuxAttachment } from "../attachments/pty-tmux-attachment-launcher.ts";
import { attachTerminalAttachmentWebSocket } from "../../server/terminal-attachment-upgrade.ts";

const INSTANCE_ID = "daemon-instance-1";
const ORIGIN = "tmux-ide://app";
const OTHER_ORIGIN = "http://127.0.0.1:4173";
const WS_URL = "ws://127.0.0.1:6070/v1/terminal/attachments/redeem";
const REQUEST_ID = "2a215cf2-547e-42a2-91c7-454df8e56121";
const LEASE_ID = "2ddc3f17-723b-4e16-a3d2-ad751fb01b2e";
const ATTEMPT_ID = "2de42a2f-aa99-4eb5-8e04-4e3d45207d68";
const TICKET = `ta1_${Buffer.alloc(32, 7).toString("base64url")}`;

function request(viewerMode: "interactive" | "read-only" = "interactive"): TerminalAttachRequest {
  return {
    protocolVersion: 1,
    target: { workspaceName: "workspace.alpha", semanticPaneId: "pane.codex" },
    viewerMode,
    viewport: { cols: 120, rows: 40 },
  };
}

function descriptor(status: "awaiting-redemption" | "active" = "awaiting-redemption") {
  return {
    leaseId: LEASE_ID,
    requestId: REQUEST_ID,
    target: request().target,
    viewerMode: "interactive" as const,
    status,
    issuedAt: 1_000,
    expiresAt: 16_000,
    graceExpiresAt: null,
    bindingGeneration: 1,
    viewGeneration: 0,
  } satisfies AttachmentLeaseDescriptor;
}

class FakeLeaseManager implements DirectTerminalAttachmentLeaseManager {
  readonly calls: string[] = [];
  readonly releases: Array<{ leaseId: string; binding: AttachmentLeaseBinding }> = [];
  redeemGate: Promise<void> | null = null;
  releaseGate: Promise<void> | null = null;
  renewGate: Promise<void> | null = null;
  renewFailure = false;
  renewViewGeneration = 0;
  issuedTicket = TICKET;
  nextLeaseId = LEASE_ID;
  currentLeaseId = LEASE_ID;
  currentRequestId = REQUEST_ID;
  active = false;
  consumed = false;

  async issue(
    _request: TerminalAttachRequest,
    context: { requestId: string; projectIdentity: string },
  ): Promise<IssuedAttachmentLease> {
    this.calls.push("issue");
    this.currentLeaseId = this.nextLeaseId;
    this.currentRequestId = context.requestId;
    const issued = { descriptor: this.leaseDescriptor() } as IssuedAttachmentLease;
    Object.defineProperty(issued, "redemptionTicket", { value: this.issuedTicket });
    return issued;
  }

  async redeem(ticket: string, _binding: AttachmentLeaseBinding) {
    this.calls.push("redeem");
    await this.redeemGate;
    if (this.consumed || ticket !== this.issuedTicket) throw new Error("invalid ticket");
    this.consumed = true;
    this.active = true;
    return { descriptor: this.leaseDescriptor("active") };
  }

  async executeViewOperation(
    _leaseId: string,
    _binding: AttachmentLeaseBinding,
    operation: "create" | "attach",
  ): Promise<ExecutedAttachmentViewOperation> {
    this.calls.push(operation);
    if (!this.active) throw new Error("inactive");
    return {
      descriptor: this.leaseDescriptor("active"),
      operation,
      ...(operation === "attach"
        ? {
            clientClaim: {
              attachmentId: this.currentLeaseId,
              generation: 0,
              attemptId: ATTEMPT_ID,
            },
          }
        : {}),
    };
  }

  async renew(_leaseId: string, _binding: AttachmentLeaseBinding) {
    this.calls.push("renew");
    await this.renewGate;
    if (this.renewFailure) throw new Error("renewal failed");
    return {
      descriptor: {
        ...this.leaseDescriptor("active"),
        expiresAt: 31_000,
        bindingGeneration: 2,
        viewGeneration: this.renewViewGeneration,
      },
    };
  }

  async release(leaseId: string, binding: AttachmentLeaseBinding) {
    this.calls.push("release");
    await this.releaseGate;
    this.releases.push({ leaseId, binding: { ...binding } });
    this.active = false;
    return { released: true, cleanup: "cleaned" };
  }

  private leaseDescriptor(
    status: "awaiting-redemption" | "active" = "awaiting-redemption",
  ): AttachmentLeaseDescriptor {
    return {
      ...descriptor(status),
      leaseId: this.currentLeaseId,
      requestId: this.currentRequestId,
    };
  }
}

class FakeClient implements ClaimedPtyTmuxAttachment {
  readonly attemptId = ATTEMPT_ID;
  readonly attachmentId = LEASE_ID;
  readonly generation = 0;
  readonly pid = 1234;
  readonly resizes: Array<[number, number]> = [];
  readonly dataListeners = new Set<(data: Buffer) => void>();
  readonly exitListeners = new Set<
    (event: { readonly exitCode: number; readonly signal: number | null }) => void
  >();
  disposed = 0;

  write(): never {
    throw new Error("input unavailable");
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  onData(callback: (data: Buffer) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(
    callback: (event: { readonly exitCode: number; readonly signal: number | null }) => void,
  ): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  dispose(): void {
    this.disposed += 1;
  }

  output(bytes: Buffer): void {
    for (const listener of this.dataListeners) listener(bytes);
  }

  exit(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null });
  }
}

class FakeSocket extends EventEmitter implements DirectTerminalSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<{ data: string | Buffer; binary: boolean }> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string | Buffer, options?: { binary?: boolean }): void {
    this.sent.push({
      data: Buffer.isBuffer(data) ? Buffer.from(data) : data,
      binary: !!options?.binary,
    });
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }

  frame(data: string | Buffer, isBinary = false): void {
    this.emit("message", data, isBinary);
  }
}

function redemption(ticket = TICKET, requestId = REQUEST_ID): string {
  return JSON.stringify({
    type: "redeem",
    protocolVersion: 1,
    ticket,
    requestId,
    daemonInstanceId: INSTANCE_ID,
  });
}

function admission(
  coordinator: TerminalAttachmentAdmissionCoordinator,
  origin = ORIGIN,
): TerminalAttachmentPreAuthAdmission {
  const decision = coordinator.reserveUpgrade({
    path: TERMINAL_ATTACHMENT_REDEEM_PATH,
    protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
    origin,
  });
  if (!decision.accepted) throw new Error(decision.code);
  return decision.admission;
}

function rig(
  overrides: {
    maxPendingTickets?: number;
    maxPreAuthSockets?: number;
    maxLiveConnections?: number;
    redemptionTimeoutMs?: number;
    maxBufferedOutputBytes?: number;
    maxOutputFrameBytes?: number;
    maxLiveControlFrames?: number;
    schedule?: (callback: () => void, delayMs: number) => () => void;
    now?: () => number;
  } = {},
) {
  const manager = new FakeLeaseManager();
  const client = new FakeClient();
  const claim = vi.fn(() => client);
  const resolveGeometry = vi.fn(async () => ({
    sourceGrid: { cols: 120, rows: 40 },
    clientViewport: { cols: 118, rows: 38 },
  }));
  const coordinator = new TerminalAttachmentAdmissionCoordinator({
    daemonInstanceId: INSTANCE_ID,
    webSocketUrl: WS_URL,
    leaseManager: manager,
    launcher: { claim },
    resolveGeometry,
    now: overrides.now ?? (() => 1_000),
    ...overrides,
  });
  return { coordinator, manager, client, claim, resolveGeometry };
}

async function issue(coordinator: TerminalAttachmentAdmissionCoordinator, origin = ORIGIN) {
  return coordinator.issue(request(), {
    requestId: REQUEST_ID,
    projectIdentity: "project-alpha",
    rendererOrigin: origin,
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function rawUpgradeStatus(port: number, headers: readonly string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
      const match = response.match(/^HTTP\/1\.1 ([0-9]{3})/u);
      if (match) {
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${TERMINAL_ATTACHMENT_REDEEM_PATH} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
          "",
          "",
        ].join("\r\n"),
      );
    });
  });
}

describe("TerminalAttachmentAdmissionCoordinator", () => {
  it("issues one renderer descriptor while retaining only bounded redacted state", async () => {
    const { coordinator, manager } = rig();
    const issued = await issue(coordinator);
    expect(issued).toEqual({
      protocolVersion: 1,
      webSocketUrl: WS_URL,
      redemptionTicket: TICKET,
      daemonInstanceId: INSTANCE_ID,
      requestId: REQUEST_ID,
      expiresAt: 16_000,
      effectiveViewerMode: "interactive",
    });
    expect(coordinator.toJSON()).toEqual({
      pendingTickets: 1,
      preAuthSockets: 0,
      liveConnections: 0,
      shuttingDown: false,
    });
    expect(JSON.stringify(coordinator)).not.toContain(TICKET);
    expect(JSON.stringify(coordinator)).not.toContain(LEASE_ID);
    expect(manager.calls).toEqual(["issue"]);
    await coordinator.shutdown();
  });

  it("rejects read-only before lease issue and atomically bounds pending issue", async () => {
    const { coordinator, manager } = rig({ maxPendingTickets: 1 });
    await expect(
      coordinator.issue(request("read-only"), {
        requestId: REQUEST_ID,
        projectIdentity: "project-alpha",
        rendererOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "read_only_unavailable" });
    await issue(coordinator);
    await expect(
      coordinator.issue(request(), {
        requestId: "fa8e7197-2236-4a62-bc01-5b64dd18c267",
        projectIdentity: "project-alpha",
        rendererOrigin: ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "pending-capacity-exhausted" });
    expect(manager.calls.filter((call) => call === "issue")).toHaveLength(1);
    await coordinator.shutdown();
  });

  it("rejects path, protocol, missing/null/wrong Origin and pre-auth saturation before bind", async () => {
    const { coordinator } = rig({ maxPreAuthSockets: 1 });
    await issue(coordinator);
    const attempts = [
      coordinator.reserveUpgrade({
        path: `${TERMINAL_ATTACHMENT_REDEEM_PATH}?ticket=forbidden`,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
        origin: ORIGIN,
      }),
      coordinator.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [],
        origin: ORIGIN,
      }),
      coordinator.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL, "duplicate"],
        origin: ORIGIN,
      }),
      coordinator.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
        origin: null,
      }),
      coordinator.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
        origin: "null",
      }),
      coordinator.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
        origin: OTHER_ORIGIN,
      }),
    ];
    expect(attempts.map((entry) => (entry.accepted ? "accepted" : entry.code))).toEqual([
      "invalid-path",
      "invalid-subprotocol",
      "invalid-subprotocol",
      "invalid-origin",
      "invalid-origin",
      "origin-rejected",
    ]);
    const first = admission(coordinator);
    expect(coordinator.snapshot().preAuthSockets).toBe(1);
    expect(
      coordinator.reserveUpgrade({
        path: TERMINAL_ATTACHMENT_REDEEM_PATH,
        protocols: [TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL],
        origin: ORIGIN,
      }),
    ).toEqual({ accepted: false, code: "preauth-capacity-exhausted", httpStatus: 503 });
    first.cancelBeforeBind();
    expect(coordinator.snapshot().preAuthSockets).toBe(0);
    await coordinator.shutdown();
  });

  it("enforces one text redemption frame, 4 KiB, and the deadline with exact reclamation", async () => {
    const scheduled: Array<{ callback: () => void; cancelled: boolean; delay: number }> = [];
    const schedule = (callback: () => void, delay: number) => {
      const entry = { callback, cancelled: false, delay };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const { coordinator, manager } = rig({ schedule, redemptionTimeoutMs: 50 });
    await issue(coordinator);

    const binaryAdmission = admission(coordinator);
    const binarySocket = new FakeSocket();
    binaryAdmission.bind(binarySocket);
    binarySocket.frame(Buffer.from(redemption()), true);
    expect(binarySocket.closes.at(-1)?.code).toBe(1009);

    const oversizedAdmission = admission(coordinator);
    const oversizedSocket = new FakeSocket();
    oversizedAdmission.bind(oversizedSocket);
    oversizedSocket.frame("x".repeat(4_097));
    expect(oversizedSocket.closes.at(-1)?.code).toBe(1009);

    const timeoutAdmission = admission(coordinator);
    const timeoutSocket = new FakeSocket();
    timeoutAdmission.bind(timeoutSocket);
    const deadline = scheduled.findLast((entry) => entry.delay === 50 && !entry.cancelled);
    expect(deadline).toBeDefined();
    deadline!.callback();
    expect(timeoutSocket.closes.at(-1)).toEqual({ code: 1008, reason: "redemption-timeout" });
    expect(coordinator.snapshot().preAuthSockets).toBe(0);
    expect(coordinator.snapshot().pendingTickets).toBe(1);
    const pendingExpiry = scheduled.find((entry) => entry.delay === 15_000 && !entry.cancelled);
    expect(pendingExpiry).toBeDefined();
    pendingExpiry!.callback();
    await flush();
    expect(coordinator.snapshot().pendingTickets).toBe(0);
    expect(manager.releases).toHaveLength(1);
    await coordinator.shutdown();
  });

  it("consumes pending into exactly one live slot, claims once, and streams output directly", async () => {
    const { coordinator, manager, client, claim } = rig();
    await issue(coordinator);
    const pending = admission(coordinator);
    const socket = new FakeSocket();
    pending.bind(socket);
    socket.frame(redemption());
    await flush();
    await flush();

    expect(manager.calls.slice(0, 4)).toEqual(["issue", "redeem", "create", "attach"]);
    expect(claim).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toEqual({
      pendingTickets: 0,
      preAuthSockets: 0,
      liveConnections: 1,
      shuttingDown: false,
    });
    expect(JSON.parse(socket.sent[0]!.data as string)).toMatchObject({
      type: "ready",
      effectiveViewerMode: "interactive",
      inputCapability: "unavailable",
      sourceGrid: { cols: 120, rows: 40 },
      clientViewport: { cols: 118, rows: 38 },
    });
    client.output(Buffer.from([0, 255, 13, 10]));
    expect(socket.sent.at(-1)).toEqual({ data: Buffer.from([0, 255, 13, 10]), binary: true });

    socket.frame(Buffer.from("typed input"), true);
    expect(JSON.parse(socket.sent.at(-1)!.data as string)).toMatchObject({
      type: "mutation-error",
      code: "input-backpressure-unavailable",
    });
    await flush();
    expect(client.disposed).toBe(1);
    expect(coordinator.snapshot().liveConnections).toBe(0);
    expect(manager.releases).toHaveLength(1);
    await coordinator.shutdown();
  });

  it("bounds live control frames and awaits lease release during shutdown", async () => {
    const { coordinator, manager, client } = rig({ maxLiveControlFrames: 2 });
    await issue(coordinator);
    const socket = new FakeSocket();
    admission(coordinator).bind(socket);
    socket.frame(redemption());
    await flush();
    await flush();
    const resize = JSON.stringify({
      type: "resize",
      protocolVersion: 1,
      generation: 0,
      viewport: { cols: 100, rows: 30 },
    });
    socket.frame(resize);
    socket.frame(resize);
    socket.frame(resize);
    expect(socket.closes.at(-1)?.reason).toBe("control-frame-limit");
    expect(client.disposed).toBe(1);

    manager.consumed = false;
    manager.issuedTicket = `ta1_${Buffer.alloc(32, 9).toString("base64url")}`;
    manager.nextLeaseId = "96064a6b-478a-4d07-ab83-b1ffdbd6358f";
    await coordinator.issue(request(), {
      requestId: "fa8e7197-2236-4a62-bc01-5b64dd18c267",
      projectIdentity: "project-alpha",
      rendererOrigin: ORIGIN,
    });
    const liveSocket = new FakeSocket();
    admission(coordinator).bind(liveSocket);
    liveSocket.frame(redemption(manager.issuedTicket, "fa8e7197-2236-4a62-bc01-5b64dd18c267"));
    await flush();
    await flush();
    expect(coordinator.snapshot().liveConnections).toBe(1);
    let releaseCleanup!: () => void;
    manager.releaseGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let shutdownSettled = false;
    const shutdown = coordinator.shutdown().then(() => {
      shutdownSettled = true;
    });
    await flush();
    expect(shutdownSettled).toBe(false);
    releaseCleanup();
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  it("renews a stable live lease before expiry and retires on renewal failure", async () => {
    let now = 1_000;
    const scheduled: Array<{ callback: () => void; cancelled: boolean; delay: number }> = [];
    const schedule = (callback: () => void, delay: number) => {
      const entry = { callback, cancelled: false, delay };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const { coordinator, manager, resolveGeometry } = rig({
      now: () => now,
      schedule,
    });
    await issue(coordinator);
    const socket = new FakeSocket();
    admission(coordinator).bind(socket);
    socket.frame(redemption());
    await flush();
    await flush();
    const firstRenewal = scheduled.find((entry) => entry.delay === 10_000 && !entry.cancelled);
    expect(firstRenewal).toBeDefined();
    now = 11_000;
    firstRenewal!.callback();
    await flush();
    await flush();
    expect(manager.calls.filter((call) => call === "renew")).toHaveLength(1);
    expect(resolveGeometry).toHaveBeenCalledTimes(2);
    expect(JSON.parse(socket.sent.at(-1)!.data as string)).toMatchObject({
      type: "geometry",
      generation: 0,
    });
    expect(scheduled.some((entry) => entry.delay === 20_000 && !entry.cancelled)).toBe(true);

    manager.renewFailure = true;
    const nextRenewal = scheduled.find((entry) => entry.delay === 13_333 && !entry.cancelled);
    expect(nextRenewal).toBeDefined();
    nextRenewal!.callback();
    await flush();
    await flush();
    expect(socket.closes.at(-1)).toEqual({ code: 1012, reason: "attachment-renewal-failed" });
    expect(coordinator.snapshot().liveConnections).toBe(0);
    await coordinator.shutdown();
  });

  it("expires a live connection at the hard lease deadline while renewal is stalled", async () => {
    let now = 1_000;
    const scheduled: Array<{ callback: () => void; cancelled: boolean; delay: number }> = [];
    const schedule = (callback: () => void, delay: number) => {
      const entry = { callback, cancelled: false, delay };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    const { coordinator, manager, client } = rig({ now: () => now, schedule });
    let finishRenewal!: () => void;
    manager.renewGate = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    await issue(coordinator);
    const socket = new FakeSocket();
    admission(coordinator).bind(socket);
    socket.frame(redemption());
    await flush();
    await flush();
    const renewal = scheduled.find((entry) => entry.delay === 10_000 && !entry.cancelled);
    const expiry = scheduled.find((entry) => entry.delay === 15_000 && !entry.cancelled);
    expect(renewal).toBeDefined();
    expect(expiry).toBeDefined();
    now = 11_000;
    renewal!.callback();
    await flush();
    now = 16_000;
    expiry!.callback();
    expect(socket.closes.at(-1)).toEqual({ code: 1008, reason: "attachment-expired" });
    expect(client.disposed).toBe(1);
    finishRenewal();
    await flush();
    await coordinator.shutdown();
  });

  it("coalesces resize and reports authoritative geometry without accepting retired generations", async () => {
    const { coordinator, client, resolveGeometry } = rig();
    await issue(coordinator);
    const pending = admission(coordinator);
    const socket = new FakeSocket();
    pending.bind(socket);
    socket.frame(redemption());
    await flush();
    await flush();
    socket.frame(
      JSON.stringify({
        type: "resize",
        protocolVersion: 1,
        generation: 0,
        viewport: { cols: 100, rows: 30 },
      }),
    );
    socket.frame(
      JSON.stringify({
        type: "resize",
        protocolVersion: 1,
        generation: 0,
        viewport: { cols: 90, rows: 25 },
      }),
    );
    await flush();
    expect(client.resizes.at(-1)).toEqual([90, 25]);
    expect(resolveGeometry.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(socket.sent.at(-1)!.data as string).type).toBe("geometry");

    socket.frame(
      JSON.stringify({
        type: "resize",
        protocolVersion: 1,
        generation: 1,
        viewport: { cols: 80, rows: 24 },
      }),
    );
    expect(socket.closes.at(-1)?.reason).toBe("retired-generation");
    await coordinator.shutdown();
  });

  it("allows only one of two sockets racing the same ticket and reclaims both pre-auth slots", async () => {
    const { coordinator, claim } = rig({ maxPreAuthSockets: 2 });
    await issue(coordinator);
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    admission(coordinator).bind(firstSocket);
    admission(coordinator).bind(secondSocket);
    firstSocket.frame(redemption());
    secondSocket.frame(redemption());
    await flush();
    await flush();
    await flush();
    expect(claim).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      pendingTickets: 0,
      preAuthSockets: 0,
      liveConnections: 1,
    });
    expect([firstSocket, secondSocket].filter((socket) => socket.closes.length > 0)).toHaveLength(
      1,
    );
    await coordinator.shutdown();
  });

  it("retires a socket that sends a second frame while redemption is still pending", async () => {
    const { coordinator, manager, claim } = rig();
    let releaseRedeem!: () => void;
    manager.redeemGate = new Promise<void>((resolve) => {
      releaseRedeem = resolve;
    });
    await issue(coordinator);
    const socket = new FakeSocket();
    admission(coordinator).bind(socket);
    socket.frame(redemption());
    socket.frame(redemption());
    expect(socket.closes.at(-1)?.reason).toBe("redemption-frame-rejected");
    releaseRedeem();
    await flush();
    await flush();
    expect(claim).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({
      pendingTickets: 0,
      preAuthSockets: 0,
      liveConnections: 0,
    });
    expect(manager.releases).toHaveLength(1);
    await coordinator.shutdown();
  });

  it("retires a ticket without spawning when live capacity is saturated", async () => {
    const { coordinator, manager, claim } = rig({ maxLiveConnections: 1 });
    await issue(coordinator);
    const firstSocket = new FakeSocket();
    admission(coordinator).bind(firstSocket);
    firstSocket.frame(redemption());
    await flush();
    await flush();
    expect(coordinator.snapshot().liveConnections).toBe(1);

    manager.consumed = false;
    manager.issuedTicket = `ta1_${Buffer.alloc(32, 8).toString("base64url")}`;
    manager.nextLeaseId = "96064a6b-478a-4d07-ab83-b1ffdbd6358f";
    await coordinator.issue(request(), {
      requestId: "fa8e7197-2236-4a62-bc01-5b64dd18c267",
      projectIdentity: "project-alpha",
      rendererOrigin: ORIGIN,
    });
    const secondSocket = new FakeSocket();
    admission(coordinator).bind(secondSocket);
    secondSocket.frame(redemption(manager.issuedTicket, "fa8e7197-2236-4a62-bc01-5b64dd18c267"));
    await flush();
    await flush();
    expect(secondSocket.closes.at(-1)?.code).toBe(1013);
    expect(coordinator.snapshot()).toMatchObject({ pendingTickets: 0, liveConnections: 1 });
    expect(claim).toHaveBeenCalledOnce();
    expect(manager.releases.some((entry) => entry.leaseId === manager.nextLeaseId)).toBe(true);
    await coordinator.shutdown();
  });

  it("closes at output HWM and releases every live resource idempotently", async () => {
    const { coordinator, manager, client } = rig({
      maxBufferedOutputBytes: 128,
      maxOutputFrameBytes: 64,
    });
    await issue(coordinator);
    const socket = new FakeSocket();
    admission(coordinator).bind(socket);
    socket.frame(redemption());
    await flush();
    await flush();
    socket.bufferedAmount = 100;
    client.output(Buffer.alloc(40));
    await flush();
    expect(socket.closes.at(-1)).toEqual({ code: 1013, reason: "output-backpressure" });
    expect(client.disposed).toBe(1);
    socket.emit("close");
    expect(client.disposed).toBe(1);
    expect(manager.releases).toHaveLength(1);
    expect(coordinator.snapshot().liveConnections).toBe(0);
    await coordinator.shutdown();
  });

  it("never includes bearer material in typed errors", () => {
    const error = new TerminalAttachmentAdmissionError(
      "redemption-rejected",
      "Terminal attachment redemption was rejected.",
    );
    expect(JSON.stringify(error)).not.toContain(TICKET);
    expect(error.message).not.toContain(TICKET);
  });

  it("rejects invalid upgrade metadata before 101 and carries live bytes without Electron", async () => {
    const { coordinator, client } = rig({ maxPreAuthSockets: 1 });
    await issue(coordinator);
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const boundary = attachTerminalAttachmentWebSocket(server, coordinator);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const url = `ws://127.0.0.1:${address.port}${TERMINAL_ATTACHMENT_REDEEM_PATH}`;

    expect(
      await rawUpgradeStatus(address.port, [
        `Origin: ${ORIGIN}`,
        `Origin: ${ORIGIN}`,
        `Sec-WebSocket-Protocol: ${TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL}`,
      ]),
    ).toBe(403);
    expect(
      await rawUpgradeStatus(address.port, [
        `Origin: ${ORIGIN}`,
        `Sec-WebSocket-Protocol: ${TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL}`,
        `Sec-WebSocket-Protocol: ${TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL}`,
      ]),
    ).toBe(426);

    const rejectedStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL, {
        origin: OTHER_ORIGIN,
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      socket.once("open", () => reject(new Error("wrong Origin reached 101")));
      socket.once("error", () => undefined);
    });
    expect(rejectedStatus).toBe(403);

    const stalled = new WebSocket(url, TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL, { origin: ORIGIN });
    await new Promise<void>((resolve, reject) => {
      stalled.once("open", resolve);
      stalled.once("error", reject);
    });
    const saturatedStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL, {
        origin: ORIGIN,
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      socket.once("open", () => reject(new Error("saturated pre-auth cap reached 101")));
      socket.once("error", () => undefined);
    });
    expect(saturatedStatus).toBe(503);
    stalled.close();
    await new Promise<void>((resolve) => stalled.once("close", resolve));

    const live = new WebSocket(url, TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL, { origin: ORIGIN });
    const frames: Array<{ data: Buffer; binary: boolean }> = [];
    live.on("message", (data, binary) =>
      frames.push({ data: Buffer.from(data as Buffer), binary }),
    );
    await new Promise<void>((resolve, reject) => {
      live.once("open", resolve);
      live.once("error", reject);
    });
    live.send(redemption());
    await vi.waitFor(() => {
      expect(
        frames.some((frame) => !frame.binary && frame.data.toString().includes('"ready"')),
      ).toBe(true);
    });
    client.output(Buffer.from([1, 0, 255, 2]));
    await vi.waitFor(() => {
      expect(
        frames.some((frame) => frame.binary && frame.data.equals(Buffer.from([1, 0, 255, 2]))),
      ).toBe(true);
    });
    live.close();
    await new Promise<void>((resolve) => live.once("close", resolve));
    await boundary.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("refuses non-loopback descriptor endpoints", () => {
    const { coordinator, ...dependencies } = rig();
    void coordinator.shutdown();
    expect(
      () =>
        new TerminalAttachmentAdmissionCoordinator({
          daemonInstanceId: INSTANCE_ID,
          webSocketUrl: `ws://192.0.2.10:6070${TERMINAL_ATTACHMENT_REDEEM_PATH}`,
          leaseManager: dependencies.manager,
          launcher: { claim: dependencies.claim },
          resolveGeometry: dependencies.resolveGeometry,
        }),
    ).toThrow("WebSocket URL is invalid");
  });
});
