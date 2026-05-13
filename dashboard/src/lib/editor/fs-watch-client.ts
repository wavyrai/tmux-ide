/**
 * FS-watch WS client — opens `/ws/events`, subscribes to a session,
 * and routes the daemon's `file.changed` frames to
 * `reseedFromExternal` on any open buffer for the same path.
 *
 * The daemon's frame carries only `{ path, kind }`. On a `'modify'`
 * we refetch via `fetchFilePreview` to get the new content. On a
 * `'delete'` we reseed with an empty string so the host can decide
 * how to surface the gone-file case via the existing
 * external-change banner.
 *
 * The connection auto-reconnects with exponential backoff so a
 * daemon restart doesn't leave the editor flying blind.
 */

import { Effect } from "effect";
import { fetchFilePreview } from "@/lib/api";
import { withWsBase } from "@/lib/appProtocol";
import {
  bufferState,
  reseedFromExternal,
  type OpenBuffer,
} from "./buffer-store";

interface FileChangedFrame {
  type: "file.changed";
  sessionName: string;
  path: string;
  kind: "modify" | "delete";
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

function findOpenBuffer(sessionName: string, path: string): OpenBuffer | null {
  for (const buf of Object.values(bufferState.buffers)) {
    if (!buf) continue;
    if (buf.sessionName === sessionName && buf.filePath === path) return buf;
  }
  return null;
}

async function applyFrame(frame: FileChangedFrame): Promise<void> {
  const buf = findOpenBuffer(frame.sessionName, frame.path);
  if (!buf || buf.status !== "ready") return;
  if (frame.kind === "delete") {
    reseedFromExternal(buf.bufferUri, "");
    return;
  }
  try {
    const preview = await Effect.runPromise(fetchFilePreview(frame.sessionName, frame.path));
    if (!preview.exists) {
      reseedFromExternal(buf.bufferUri, "");
      return;
    }
    reseedFromExternal(buf.bufferUri, preview.content);
  } catch {
    // The watcher fired ahead of the daemon's preview cache — the
    // user's next save will still write through the unchanged
    // content; do nothing.
  }
}

/**
 * Start the FS-watch subscription for `sessionName`. Returns a
 * disposer that closes the WS + cancels the reconnect timer.
 */
export function startFsWatchClient(sessionName: string): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = MIN_BACKOFF_MS;

  function connect() {
    if (stopped) return;
    let url: string;
    try {
      url = withWsBase("/ws/events");
    } catch {
      return;
    }
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      backoff = MIN_BACKOFF_MS;
      socket?.send(JSON.stringify({ type: "subscribe", sessions: [sessionName] }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const frame = parsed as { type?: string; sessionName?: string };
      if (frame.type !== "file.changed") return;
      if (frame.sessionName !== sessionName) return;
      void applyFrame(parsed as FileChangedFrame);
    });
    socket.addEventListener("close", () => {
      socket = null;
      if (stopped) return;
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
    socket.addEventListener("error", () => {
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    });
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (socket) {
      try {
        socket.send(JSON.stringify({ type: "unsubscribe", sessions: [sessionName] }));
      } catch {
        /* socket may already be closed */
      }
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
  };
}
