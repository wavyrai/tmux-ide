/** Trusted-main-only, read-only bridge from the canonical daemon to libghostty. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocket } from "ws";
import { CanonicalDaemonInfoSchema } from "@tmux-ide/contracts";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
} from "../../../packages/daemon/src/canonical.ts";
import { createCanonicalDaemonPreflight } from "../../../apps/electron-shell/src/daemon-preflight.ts";
import { DaemonResourceBroker } from "../../../apps/electron-shell/src/daemon-resource-broker.ts";
import {
  createPaneStreamTransport,
  PaneStreamIssueFailure,
  type PaneStreamWebSocket,
  type PaneStreamSocketListener,
} from "../../../apps/desktop-renderer/src/terminal/pane-stream-transport.ts";

export interface NativePaneOptions {
  daemonInfoPath: string;
  workspaceName: string;
  paneId: string;
  /** Apply a complete reset/repaint synchronously (or resolve after application). */
  onSeed: (bytes: Uint8Array) => void | Promise<void>;
  onOutput: (bytes: Uint8Array) => void | Promise<void>;
  /** Observed pane dimensions only; never requests daemon geometry authority. */
  onGeometry: (geometry: { cols: number; rows: number }) => void;
  onError: (error: Error) => void;
}

const rendererOrigin = "tmux-ide://app";

function readRecord(path: string) {
  const parent = lstatSync(dirname(path));
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (before.mode & 0o077) !== 0 ||
    (uid !== undefined && (parent.uid !== uid || before.uid !== uid)) ||
    before.size > 64 * 1024
  )
    throw new Error("Daemon record must be an owner-only regular file in an owner-only directory.");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size ||
      stat.mtimeMs !== before.mtimeMs
    )
      throw new Error("Daemon record changed while opening.");
    const parsed = CanonicalDaemonInfoSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!parsed.success || !parsed.data.authToken)
      throw new Error("Invalid canonical daemon record.");
    return {
      status: "valid" as const,
      info: parsed.data,
      observation: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  } finally {
    closeSync(fd);
  }
}

/** `ws` with browser-shaped events, including close evidence and text decoding. */
function createSocket(url: string, protocol: string): PaneStreamWebSocket {
  const socket = new WebSocket(url, protocol, { origin: rendererOrigin });
  type SocketEvent = { data?: unknown; code?: number; reason?: string };
  const listeners = new Map<string, Map<PaneStreamSocketListener, (event: unknown) => void>>();
  return {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get protocol() {
      return socket.protocol;
    },
    get binaryType() {
      return socket.binaryType as BinaryType;
    },
    set binaryType(value) {
      socket.binaryType = value === "blob" ? "arraybuffer" : value;
    },
    addEventListener(type, listener) {
      const wrapped = (raw: unknown) => {
        const event = raw as SocketEvent;
        listener({
          ...(type === "message"
            ? { data: typeof event.data === "string" ? event.data : String(event.data) }
            : {}),
          ...(type === "close" ? { code: event.code, reason: event.reason } : {}),
        });
      };
      const group = listeners.get(type) ?? new Map();
      group.set(listener, wrapped);
      listeners.set(type, group);
      socket.addEventListener(type, wrapped);
    },
    removeEventListener(type, listener) {
      const wrapped = listeners.get(type)?.get(listener);
      if (wrapped) socket.removeEventListener(type, wrapped);
      listeners.get(type)?.delete(listener);
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

/** No PTY, shell, input, focus, or resize authority; dispose retires the lease. */
export async function connectNativePane(
  options: NativePaneOptions,
): Promise<{ dispose: () => void }> {
  const record = readRecord(options.daemonInfoPath);
  const daemon = await createCanonicalDaemonPreflight({
    inspect: () => record,
    isAlive: isCanonicalDaemonAlive,
    probeIdentity: probeCanonicalDaemonIdentity,
    probeHealth: probeCanonicalDaemonHealth,
    httpOrigin: (info) => canonicalDaemonUrl("http", info.bindHostname, info.port),
  }).probe(AbortSignal.timeout(10_000));
  if (daemon.status !== "connected") throw new Error(`${daemon.code}: ${daemon.reason}`);
  const broker = new DaemonResourceBroker({ daemon, ownerToken: record.info.authToken });
  let disposed = false;
  const transport = createPaneStreamTransport({
    createWebSocket: createSocket,
    issuePaneStream: async (stream) => {
      const result = await broker.issuePaneStream(
        {
          requestId: randomUUID(),
          expectedDaemonInstanceId: daemon.descriptor.instanceId,
          stream,
        },
        rendererOrigin,
      );
      if (result.status !== "issued") {
        throw new PaneStreamIssueFailure(
          result.error.code,
          result.error.reason,
          result.error.retryable,
        );
      }
      return result.descriptor;
    },
  });
  try {
    const connection = await transport.connect(
      {
        workspaceName: options.workspaceName,
        panes: [options.paneId],
        viewerMode: "read-only",
      },
      {
        onPaneEvent: async (pane, event) => {
          if (disposed || pane !== options.paneId) return;
          if (event.type === "seed-batch") {
            const geometry = event.batch.reset ?? event.canonical;
            if (geometry) options.onGeometry({ cols: geometry.cols, rows: geometry.rows });
            // One callback preserves the canonical seed + held-output application boundary.
            const cursor = event.batch.cursor;
            await options.onSeed(
              Buffer.concat([
                Buffer.from("\u001bc"),
                event.batch.seed,
                ...event.batch.held,
                ...(cursor ? [Buffer.from(`\u001b[${cursor.y + 1};${cursor.x + 1}H`)] : []),
              ]),
            );
          } else if (event.type === "output") {
            if (event.canonical)
              options.onGeometry({ cols: event.canonical.cols, rows: event.canonical.rows });
            await options.onOutput(event.bytes);
          } else if (event.type === "cursor") {
            await options.onOutput(Buffer.from(`\u001b[${event.y + 1};${event.x + 1}H`));
          } else if (event.type === "closed") {
            options.onError(new Error("The daemon pane was closed."));
          }
        },
        onLayout: (layout) => {
          const pane = layout.panes.find((pane) => pane.pane === options.paneId);
          if (!disposed && pane) options.onGeometry({ cols: pane.width, rows: pane.height });
        },
        onEnd: (error) => {
          if (!disposed)
            options.onError(
              new Error(error ? `${error.code}: ${error.reason}` : "Daemon pane stream ended."),
            );
        },
      },
    );
    if (connection.status !== "connected")
      throw new Error(`${connection.error.code}: ${connection.error.reason}`);
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        connection.session.dispose();
        broker.dispose();
      },
    };
  } catch (error) {
    disposed = true;
    broker.dispose();
    throw error;
  }
}
