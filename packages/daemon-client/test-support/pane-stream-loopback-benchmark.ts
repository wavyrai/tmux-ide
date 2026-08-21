import NodeWebSocket from "ws";

const mode = process.argv[2];
if (mode !== "native" && mode !== "ws") throw new Error("expected native or ws mode");
const sampleCount = 120;
const worker = new Worker(new URL("./pane-stream-loopback-worker.ts", import.meta.url).href);
const port = await new Promise<number>((resolve) => {
  worker.onmessage = ({ data }: MessageEvent<{ port: number }>) => resolve(data.port);
});
const url = `ws://127.0.0.1:${port}`;
const socket =
  mode === "native"
    ? new globalThis.WebSocket(url)
    : new NodeWebSocket(url, { perMessageDeflate: false });
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("loopback socket failed")), {
    once: true,
  });
});
if (mode === "ws") {
  const transport = (
    socket as NodeWebSocket & { _socket?: { setNoDelay?: (value: boolean) => void } }
  )._socket;
  transport?.setNoDelay?.(true);
}

const durations: number[] = [];
const blockedIngress: Array<{ sequence: number; blockMs: number; ingressMs: number }> = [];
const bufferedAfter: number[] = [];
for (let sequence = 1; sequence <= sampleCount; sequence += 1) {
  const sentAtEpochMicros = (performance.timeOrigin + performance.now()) * 1_000;
  const reply = new Promise<{
    sequence: number;
    sentAtEpochMicros: number;
    callbackAtEpochMicros: number;
  }>((resolve, reject) => {
    const onMessage = (event: MessageEvent | { data: unknown }) => {
      try {
        socket.removeEventListener("message", onMessage as never);
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    };
    socket.addEventListener("message", onMessage as never);
  });
  socket.send(
    JSON.stringify({
      type: "input",
      kind: "key",
      key: "x",
      pane: "pane.benchmark",
      sequence,
      sentAtEpochMicros,
      padding: "p".repeat(256),
    }),
  );
  bufferedAfter.push(Number(socket.bufferedAmount ?? 0));
  const blockMs = sequence === 5 ? 40 : sequence === 30 ? 70 : 0;
  if (blockMs > 0) {
    const busyUntil = performance.now() + blockMs;
    while (performance.now() < busyUntil) {
      // Model renderer work beginning synchronously after socket admission.
    }
  }
  const ack = await reply;
  if (ack.sequence !== sequence) throw new Error("loopback FIFO mismatch");
  const ingressMs = (ack.callbackAtEpochMicros - ack.sentAtEpochMicros) / 1_000;
  durations.push(ingressMs);
  if (blockMs > 0) blockedIngress.push({ sequence, blockMs, ingressMs });
  if (sequence % 12 === 0) {
    const busyUntil = performance.now() + 0.25;
    while (performance.now() < busyUntil) {
      // Bounded light contention on the same event loop as the production Bun host.
    }
  }
}
await new Promise((resolve) => setTimeout(resolve, 0));
const finalBufferedAmount = Number(socket.bufferedAmount ?? 0);
socket.close();
worker.terminate();
const sorted = [...durations].sort((left, right) => left - right);
const percentile = (value: number) => sorted[Math.ceil((value / 100) * sorted.length) - 1]!;
console.log(
  JSON.stringify({
    mode,
    sampleCount,
    fifo: true,
    maxBufferedAmount: Math.max(...bufferedAfter),
    finalBufferedAmount,
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    maxMs: sorted.at(-1),
    blockedIngress,
  }),
);
