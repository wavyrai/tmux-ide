// A TCP proxy on loopback that behaves like a slow link: every byte is held
// for a fixed one-way delay in each direction and, optionally, serialised at a
// link rate first. Order is kept per direction. Used by the remote-latency job
// to put a daemon's WebSocket behind 50-150 ms of round trip.
import net from "node:net";

const MTU_PAYLOAD = 1448;

/**
 * @param {{ targetPort: number, oneWayDelayMs: number, mbit?: number, host?: string }} options
 * @returns {Promise<{ port: number, bytes: { up: number, down: number }, close: () => Promise<void> }>}
 */
export async function startDelayProxy({ targetPort, oneWayDelayMs, mbit = 0, host = "127.0.0.1" }) {
  if (!Number.isInteger(targetPort) || targetPort <= 0) throw new Error("targetPort is required");
  if (!(oneWayDelayMs >= 0)) throw new Error("oneWayDelayMs must be zero or more");
  const bytesPerMs = mbit > 0 ? (mbit * 1e6) / 8 / 1000 : 0;
  const bytes = { up: 0, down: 0 };
  const sockets = new Set();

  // One direction of one connection: a FIFO of chunks with due times. Due
  // times never decrease (constant delay, monotonic link clock), so the head
  // of the queue is always the next to send.
  const pump = (src, dst, counter) => {
    const queue = [];
    let linkFreeAt = 0;
    let timer = null;
    let ended = false;
    const flush = () => {
      timer = null;
      const now = performance.now();
      while (queue.length && queue[0].due <= now) dst.write(queue.shift().data);
      if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].due - now));
      else if (ended) dst.end();
    };
    src.on("data", (data) => {
      bytes[counter] += data.length;
      const now = performance.now();
      if (bytesPerMs) {
        for (let offset = 0; offset < data.length; offset += MTU_PAYLOAD) {
          const piece = data.subarray(offset, offset + MTU_PAYLOAD);
          linkFreeAt = Math.max(linkFreeAt, now) + piece.length / bytesPerMs;
          queue.push({ due: linkFreeAt + oneWayDelayMs, data: piece });
        }
      } else {
        queue.push({ due: now + oneWayDelayMs, data });
      }
      if (!timer) timer = setTimeout(flush, Math.max(0, queue[0].due - now));
    });
    src.on("end", () => {
      ended = true;
      if (!timer) flush();
    });
  };

  const server = net.createServer((client) => {
    const upstream = net.connect({ host, port: targetPort });
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    pump(client, upstream, "up");
    pump(upstream, client, "down");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return {
    port: /** @type {net.AddressInfo} */ (server.address()).port,
    bytes,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
