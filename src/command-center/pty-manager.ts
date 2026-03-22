import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WIDGET_ENTRY_POINTS: Record<string, string> = {
  explorer: "explorer/index.tsx",
  changes: "changes/index.tsx",
  preview: "preview/index.tsx",
  tasks: "tasks/index.tsx",
  warroom: "warroom/index.tsx",
  costs: "costs/index.tsx",
  setup: "setup/index.tsx",
};

export interface PtySession {
  process: IPty;
  clients: Set<WebSocket>;
  widgetType: string;
}

const sessions = new Map<string, PtySession>();

function resolveWidgetsDir(): string {
  let dir = __dirname;
  // When running from dist/, resolve back to src/widgets/
  if (dir.includes("/dist/")) {
    dir = dir.replace("/dist/command-center", "/src/widgets");
  } else {
    dir = resolve(dir, "../widgets");
  }
  return dir;
}

/** Resolve the tmux-ide project root (where bunfig.toml lives) */
function resolveProjectRoot(): string {
  let dir = __dirname;
  if (dir.includes("/dist/")) {
    return dir.replace("/dist/command-center", "");
  }
  return resolve(dir, "../..");
}

export function spawnWidget(
  widgetType: string,
  session: string,
  dir: string,
  cols: number,
  rows: number,
): PtySession {
  // Kill existing session for this widget type if any
  const existing = sessions.get(widgetType);
  if (existing) {
    existing.process.kill();
    for (const ws of existing.clients) {
      ws.close();
    }
    sessions.delete(widgetType);
  }

  const entry = WIDGET_ENTRY_POINTS[widgetType];
  if (!entry) throw new Error(`Unknown widget type: ${widgetType}`);

  const scriptPath = resolve(resolveWidgetsDir(), entry);
  const args = [
    scriptPath,
    `--session=${session}`,
    `--dir=${dir}`,
  ];

  // Resolve full bun path — PTY may not inherit shell PATH
  const bunPath = process.env.BUN_INSTALL
    ? resolve(process.env.BUN_INSTALL, "bin/bun")
    : "bun";

  // Use tmux-ide project root as cwd so Bun picks up bunfig.toml
  // (which configures the @opentui/solid preload for JSX)
  const projectRoot = resolveProjectRoot();

  const proc = pty.spawn(bunPath, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: projectRoot,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const clients = new Set<WebSocket>();

  const ptySession: PtySession = {
    process: proc,
    clients,
    widgetType,
  };

  // Broadcast PTY output to all connected WebSocket clients
  proc.onData((data: string) => {
    for (const ws of clients) {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(data);
      }
    }
  });

  // Clean up on PTY exit
  proc.onExit(() => {
    for (const ws of clients) {
      ws.close();
    }
    clients.clear();
    sessions.delete(widgetType);
  });

  sessions.set(widgetType, ptySession);
  return ptySession;
}

export function connectClient(widgetType: string, ws: WebSocket): boolean {
  const session = sessions.get(widgetType);
  if (!session) return false;

  session.clients.add(ws);

  // Forward client messages (keyboard/mouse input) to PTY
  ws.on("message", (data: Buffer | string) => {
    const str = typeof data === "string" ? data : data.toString("utf-8");
    session.process.write(str);
  });

  // Remove client on close
  ws.on("close", () => {
    session.clients.delete(ws);
  });

  return true;
}

export function resizeWidget(widgetType: string, cols: number, rows: number): boolean {
  const session = sessions.get(widgetType);
  if (!session) return false;
  session.process.resize(cols, rows);
  return true;
}

export function killAll(): void {
  for (const [, session] of sessions) {
    session.process.kill();
    for (const ws of session.clients) {
      ws.close();
    }
    session.clients.clear();
  }
  sessions.clear();
}

export function getSession(widgetType: string): PtySession | undefined {
  return sessions.get(widgetType);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}
