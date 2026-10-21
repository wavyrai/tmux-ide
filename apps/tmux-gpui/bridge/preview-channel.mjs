import net from "node:net";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create two connected, paused socket endpoints for child stdio inheritance.
 * The launcher never reads/writes payload bytes. Closing its copies after spawn
 * leaves the children's duplicated descriptors connected, including EOF delivery.
 */
export async function createPreviewChannel({ signal, timeoutMs = 1500 } = {}) {
  if (signal?.aborted) throw new Error("Preview channel cancelled");
  const directory = await mkdtemp(join(tmpdir(), "tmux-gui-channel-"));
  const path = join(directory, "socket");
  const server = net.createServer({ pauseOnConnect: true });
  let client, peer, timer;
  let closed = false;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(timer);
    client?.destroy();
    peer?.destroy();
    closePromise = (async () => {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await rmdir(directory);
    })();
    return closePromise;
  };
  let abort;
  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(new Error("Preview channel setup failed"));
      abort = fail;
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(fail, timeoutMs);
      server.on("error", fail);
      server.on("connection", (socket) => {
        if (closed || peer) {
          socket.destroy();
          return;
        }
        peer = socket;
        peer.on("error", fail);
        peer.pause();
        if (client?.readyState === "open") resolve();
      });
      server.listen(path, () => {
        if (closed || signal?.aborted) {
          fail();
          return;
        }
        client = net.createConnection(path);
        client.pause();
        client.on("error", fail);
        client.once("connect", () => {
          if (peer) resolve();
        });
      });
    });
    if (signal?.aborted) throw new Error("Preview channel cancelled");
    return { viewer: client, helper: peer, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
