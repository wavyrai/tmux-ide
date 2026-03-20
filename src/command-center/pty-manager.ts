import { resolve } from "node:path";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import type { WebSocket } from "ws";

const VALID_WIDGETS = new Set([
  "changes", "costs", "explorer", "preview", "tasks", "warroom",
]);

export interface PtySession {
  tmuxSession: string;
  clients: Set<WebSocket>;
  widgetType: string;
  pollInterval: ReturnType<typeof setInterval> | null;
}

const sessions = new Map<string, PtySession>();

type TmuxRunner = (...args: string[]) => string;

let _runner: TmuxRunner = (...args) => {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
};

function tmux(...args: string[]): string {
  return _runner(...args);
}

/** @internal Replace the tmux runner for testing. Returns a restore function. */
export function _setTmuxRunner(fn: TmuxRunner): () => void {
  const prev = _runner;
  _runner = fn;
  return () => { _runner = prev; };
}

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

  const tmuxSessionName = `web-${widgetType}`;

  // Kill existing session if any
  try { tmux("kill-session", "-t", tmuxSessionName); } catch {}

  // Find bun
  let bunPath = "bun";
  try {
    bunPath = execFileSync("which", ["bun"], { encoding: "utf-8" }).trim() || "bun";
  } catch {}

  const widgetPath = resolve(dir, `src/widgets/${widgetType}/index.tsx`);
  const cmd = `cd ${dir} && ${bunPath} ${widgetPath} --session=${session} --dir=${dir}`;

  // Create a detached tmux session running the widget
  tmux("new-session", "-d", "-s", tmuxSessionName, "-x", String(cols), "-y", String(rows), cmd);

  const ptySess: PtySession = {
    tmuxSession: tmuxSessionName,
    clients: new Set(),
    widgetType,
    pollInterval: null,
  };

  // Poll tmux pane content and send to clients
  // Use tmux pipe-pane or capture-pane at high frequency
  let lastContent = "";
  ptySess.pollInterval = setInterval(() => {
    try {
      // Capture current pane content with escape sequences
      const content = tmux("capture-pane", "-t", tmuxSessionName, "-p", "-e");
      if (content !== lastContent) {
        lastContent = content;
        // Send full screen content with cursor positioning
        const data = "\x1b[H\x1b[2J" + content; // clear + home + content
        for (const client of ptySess.clients) {
          if (client.readyState === 1) {
            client.send(data);
          }
        }
      }
    } catch {
      // Session might have died
    }
  }, 100); // 10 FPS

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

  // Send initial content
  try {
    const content = tmux("capture-pane", "-t", sess.tmuxSession, "-p", "-e");
    ws.send("\x1b[H\x1b[2J" + content);
  } catch {}

  ws.on("message", (data: Buffer | string) => {
    const str = data.toString();
    // Handle resize
    try {
      const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
      if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
        resizeWidget(widgetType, msg.cols, msg.rows);
        return;
      }
    } catch {}
    // Forward keyboard input to the tmux pane
    tmux("send-keys", "-t", sess.tmuxSession, "-l", str);
  });

  ws.on("close", () => {
    sess.clients.delete(ws);
  });

  return true;
}

export function resizeWidget(widgetType: string, cols: number, rows: number): void {
  const sess = sessions.get(widgetType);
  if (sess) {
    tmux("resize-window", "-t", sess.tmuxSession, "-x", String(cols), "-y", String(rows));
  }
}

export function killWidget(widgetType: string): void {
  const sess = sessions.get(widgetType);
  if (sess) {
    if (sess.pollInterval) clearInterval(sess.pollInterval);
    try { tmux("kill-session", "-t", sess.tmuxSession); } catch {}
    sessions.delete(widgetType);
  }
}

export function killAll(): void {
  for (const [type] of sessions) {
    killWidget(type);
  }
  sessions.clear();
}
