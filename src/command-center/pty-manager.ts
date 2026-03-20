import { resolve } from "node:path";
import type { WebSocket } from "ws";

// node-pty is a native module — use dynamic import so tests can mock it
type IPty = {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  pid: number;
};

type PtySpawner = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string | undefined>;
  },
) => IPty;

let _spawner: PtySpawner | null = null;

async function getSpawner(): Promise<PtySpawner> {
  if (_spawner) return _spawner;
  const pty = await import("node-pty");
  _spawner = pty.spawn as unknown as PtySpawner;
  return _spawner;
}

/** @internal Replace the PTY spawner for testing. Returns a restore function. */
export function _setPtySpawner(fn: PtySpawner): () => void {
  const prev = _spawner;
  _spawner = fn;
  return () => {
    _spawner = prev;
  };
}

const VALID_WIDGETS = new Set([
  "changes",
  "costs",
  "explorer",
  "preview",
  "tasks",
  "warroom",
]);

export interface PtySession {
  process: IPty;
  clients: Set<WebSocket>;
  widgetType: string;
}

const sessions = new Map<string, PtySession>();

export function getSession(widgetType: string): PtySession | undefined {
  return sessions.get(widgetType);
}

export function listSessions(): Map<string, PtySession> {
  return sessions;
}

export async function spawnWidget(
  widgetType: string,
  session: string,
  dir: string,
  cols: number,
  rows: number,
): Promise<PtySession> {
  if (!VALID_WIDGETS.has(widgetType)) {
    throw new Error(`Invalid widget type: ${widgetType}`);
  }

  const existing = sessions.get(widgetType);
  if (existing) return existing;

  const spawner = await getSpawner();

  // Widget source — bun runs the tsx directly
  const widgetPath = resolve(dir, `src/widgets/${widgetType}/index.tsx`);

  const args = [widgetPath, `--session=${session}`, `--dir=${dir}`];
  // For theme, pass it as JSON arg if needed
  const themeArg = `--theme={}`;
  args.push(themeArg);

  const proc = spawner("bun", args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: dir,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const ptySess: PtySession = {
    process: proc,
    clients: new Set(),
    widgetType,
  };

  proc.onData((data: string) => {
    for (const client of ptySess.clients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        client.send(data);
      }
    }
  });

  proc.onExit(() => {
    sessions.delete(widgetType);
    for (const client of ptySess.clients) {
      client.close();
    }
  });

  sessions.set(widgetType, ptySess);
  return ptySess;
}

export function connectClient(widgetType: string, ws: WebSocket): boolean {
  const sess = sessions.get(widgetType);
  if (!sess) {
    ws.close();
    return false;
  }

  sess.clients.add(ws);

  ws.on("message", (data: Buffer | string) => {
    const str = data.toString();
    // Handle resize JSON messages
    try {
      const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
      if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        resizeWidget(widgetType, msg.cols, msg.rows);
        return;
      }
    } catch {
      // Not JSON — forward as keyboard input
    }
    sess.process.write(str);
  });

  ws.on("close", () => {
    sess.clients.delete(ws);
  });

  return true;
}

export function resizeWidget(widgetType: string, cols: number, rows: number): void {
  const sess = sessions.get(widgetType);
  if (sess) {
    sess.process.resize(cols, rows);
  }
}

export function killWidget(widgetType: string): void {
  const sess = sessions.get(widgetType);
  if (sess) {
    sess.process.kill();
    sessions.delete(widgetType);
  }
}

export function killAll(): void {
  for (const [, sess] of sessions) {
    sess.process.kill();
  }
  sessions.clear();
}
