import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type {
  PaneStreamIssueDescriptor,
  TerminalAttachmentIssueDescriptor,
} from "@tmux-ide/contracts";
import { startEnvironmentStreamRelay } from "./environment-stream-relay.ts";
const trustedOrigin = "tmux-ide://app";
const path = "/v1/terminal/pane-streams/redeem";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function upstream(label: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const messages: string[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (data, binary) => {
      messages.push(data.toString());
      socket.send(binary ? data : `${label}:${data}`, { binary });
    }),
  );
  const address = server.address();
  if (typeof address === "string" || !address) throw Error("listen");
  return { url: `ws://127.0.0.1:${address.port}${path}`, messages };
}
async function relay(options: Partial<Parameters<typeof startEnvironmentStreamRelay>[0]> = {}) {
  const result = await startEnvironmentStreamRelay({ trustedOrigin, ...options });
  cleanup.push(() => result.dispose());
  return result;
}
function descriptor(url: string, letter = "A"): PaneStreamIssueDescriptor {
  return {
    protocolVersion: 1,
    webSocketUrl: url,
    subprotocol: "tmux-ide-pane-stream.v1",
    redemptionTicket: `ps1_${letter.repeat(43)}`,
    daemonInstanceId: "10000000-0000-4000-8000-000000000002",
    requestId: randomUUID(),
    expiresAt: Date.now() + 15000,
    panes: ["pane.workspace.a1"],
    effectiveViewerMode: "read-only",
  };
}
function redeem(value: PaneStreamIssueDescriptor) {
  return JSON.stringify({
    type: "redeem",
    protocolVersion: 1,
    ticket: value.redemptionTicket,
    requestId: value.requestId,
    daemonInstanceId: value.daemonInstanceId,
    deliveryAcks: true,
  });
}
async function socket(
  value: PaneStreamIssueDescriptor | TerminalAttachmentIssueDescriptor,
  origin = trustedOrigin,
) {
  const ws = new WebSocket(value.webSocketUrl, value.subprotocol, { origin });
  ws.on("error", () => {});
  await once(ws, "open");
  cleanup.push(async () => {
    ws.terminate();
  });
  return ws;
}

it("routes two origins independently, preserves frames and consumes each ticket once", async () => {
  const a = await upstream("a");
  const b = await upstream("b");
  const proxy = await relay();
  const first = proxy.register(descriptor(a.url), {
    upstreamUrl: a.url,
    scope: "a",
    renderer: "r",
    isCurrent: () => true,
  });
  const second = proxy.register(descriptor(b.url, "B"), {
    upstreamUrl: b.url,
    scope: "b",
    renderer: "r",
    isCurrent: () => true,
  });
  const one = await socket(first);
  const two = await socket(second);
  const output = once(one, "message");
  one.send(redeem(first));
  expect((await output)[0].toString()).toBe(`a:${redeem(first)}`);
  const output2 = once(two, "message");
  two.send(redeem(second));
  expect((await output2)[0].toString()).toBe(`b:${redeem(second)}`);
  expect(a.messages).toEqual([redeem(first)]);
  expect(b.messages).toEqual([redeem(second)]);
  const replay = await socket(first);
  const closed = once(replay, "close");
  replay.send(redeem(first));
  await closed;
  const retired = once(one, "close");
  proxy.retireScope("a");
  await retired;
  expect(two.readyState).toBe(WebSocket.OPEN);
});
it("refuses wrong origins, unknown tickets and expired registration", async () => {
  const target = await upstream("a");
  const proxy = await relay();
  const value = descriptor(`${proxy.origin}${path}`);
  await expect(socket(value, "https://evil.test")).rejects.toThrow();
  const ws = await socket(value);
  const closed = once(ws, "close");
  ws.send(redeem(value));
  await closed;
  expect(() =>
    proxy.register(
      { ...value, expiresAt: Date.now() - 1 },
      { upstreamUrl: target.url, scope: "a", renderer: "r", isCurrent: () => true },
    ),
  ).toThrow();
  expect(target.messages).toEqual([]);
});
it("enforces ticket and socket ceilings plus first-message deadline", async () => {
  const target = await upstream("a");
  const proxy = await relay({ maxTickets: 1, maxSockets: 1, firstMessageTimeoutMs: 30 });
  const value = proxy.register(descriptor(target.url), {
    upstreamUrl: target.url,
    scope: "a",
    renderer: "r",
    isCurrent: () => true,
  });
  expect(() =>
    proxy.register(descriptor(target.url, "B"), {
      upstreamUrl: target.url,
      scope: "b",
      renderer: "r",
      isCurrent: () => true,
    }),
  ).toThrow();
  const ws = await socket(value);
  const closed = once(ws, "close");
  await expect(socket(value)).rejects.toThrow();
  await closed;
  expect(proxy.diagnostics().sockets).toBe(0);
});
it("fails closed when a frame exceeds the forwarding queue ceiling", async () => {
  const target = await upstream("a");
  const proxy = await relay({ maxQueuedBytes: 8 });
  const value = proxy.register(descriptor(target.url), {
    upstreamUrl: target.url,
    scope: "a",
    renderer: "r",
    isCurrent: () => true,
  });
  const ws = await socket(value);
  const closed = once(ws, "close");
  ws.send(redeem(value));
  await closed;
  expect(target.messages).toEqual([]);
});
it("releases renderer tickets and active streams", async () => {
  const target = await upstream("a");
  const proxy = await relay();
  const value = proxy.register(descriptor(target.url), {
    upstreamUrl: target.url,
    scope: "a",
    renderer: "r",
    isCurrent: () => true,
  });
  const ws = await socket(value);
  const ready = once(ws, "message");
  ws.send(redeem(value));
  await ready;
  const closed = once(ws, "close");
  proxy.releaseRenderer("r");
  await closed;
  expect(proxy.diagnostics()).toEqual({ tickets: 0, sockets: 0 });
});

it("rejects tickets which expire or lose authority after registration", async () => {
  const target = await upstream("a");
  let time = Date.now();
  const proxy = await relay({ now: () => time });
  const value = proxy.register(descriptor(target.url), {
    upstreamUrl: target.url,
    scope: "a",
    renderer: "r",
    isCurrent: () => true,
  });
  time += 20000;
  const ws = await socket(value);
  const closed = once(ws, "close");
  ws.send(redeem(value));
  await closed;
  expect(target.messages).toEqual([]);
});

it("forwards the actual terminal-attachment redeem and binary lane", async () => {
  const target = await upstream("attachment");
  const proxy = await relay();
  const url = target.url.replace("pane-streams", "attachments");
  const value = proxy.register<TerminalAttachmentIssueDescriptor>(
    {
      protocolVersion: 1,
      webSocketUrl: url,
      subprotocol: "tmux-ide-terminal.v1",
      redemptionTicket: `ta1_${"C".repeat(43)}`,
      daemonInstanceId: "10000000-0000-4000-8000-000000000002",
      requestId: randomUUID(),
      expiresAt: Date.now() + 15000,
      effectiveViewerMode: "read-only",
      effectiveGeometryOwnership: "passive",
    },
    { upstreamUrl: url, scope: "a", renderer: "r", isCurrent: () => true },
  );
  const ws = await socket(value);
  const frame = JSON.stringify({
    type: "redeem",
    protocolVersion: 1,
    ticket: value.redemptionTicket,
    requestId: value.requestId,
    daemonInstanceId: value.daemonInstanceId,
  });
  const ready = once(ws, "message");
  ws.send(frame);
  expect((await ready)[0].toString()).toBe(`attachment:${frame}`);
  const binary = once(ws, "message");
  const bytes = Buffer.from([0, 255, 27, 91, 65]);
  ws.send(bytes);
  const [received, isBinary] = await binary;
  expect(isBinary).toBe(true);
  expect(received).toEqual(bytes);
});

it("fails closed when current-authority checks throw during redemption or forwarding", async () => {
  const target = await upstream("a");
  const proxy = await relay();
  let throws = false;
  const current = () => {
    if (throws) throw Error("retired authority");
    return true;
  };
  const value = proxy.register(descriptor(target.url), {
    upstreamUrl: target.url,
    scope: "a",
    renderer: "r",
    isCurrent: current,
  });
  const ws = await socket(value);
  const ready = once(ws, "message");
  ws.send(redeem(value));
  await ready;
  throws = true;
  const closed = once(ws, "close");
  ws.send("next");
  await closed;
  throws = false;
  const next = proxy.register(descriptor(target.url, "B"), {
    upstreamUrl: target.url,
    scope: "b",
    renderer: "r",
    isCurrent: current,
  });
  throws = true;
  const pending = await socket(next);
  const ended = once(pending, "close");
  pending.send(redeem(next));
  await ended;
  expect(proxy.diagnostics()).toEqual({ tickets: 0, sockets: 0 });
});

it.each(["{malformed", "x".repeat(4097)])(
  "closes malformed or oversized initial data without leaking sockets",
  async (frame) => {
    const proxy = await relay();
    const value = descriptor(`${proxy.origin}${path}`);
    const ws = await socket(value);
    const closed = once(ws, "close");
    ws.send(frame);
    await closed;
    expect(proxy.diagnostics().sockets).toBe(0);
  },
);
