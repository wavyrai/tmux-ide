import { execFileSync } from "node:child_process";
import type { WebSocket } from "ws";

export interface MirrorSession {
  session: string;
  paneId: string;
  clients: Set<WebSocket>;
  interval: ReturnType<typeof setInterval> | null;
  lastContent: string;
}

const mirrors = new Map<string, MirrorSession>();

function mirrorKey(session: string, paneId: string): string {
  return `${session}:${paneId}`;
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function capturePaneContent(_session: string, paneId: string): string {
  // Use pane ID directly — tmux %N IDs are globally unique, no session prefix needed
  return tmux(["capture-pane", "-t", paneId, "-p", "-e"]);
}

export function startMirror(session: string, paneId: string, ws: WebSocket): MirrorSession {
  const key = mirrorKey(session, paneId);
  let mirror = mirrors.get(key);

  if (mirror) {
    mirror.clients.add(ws);
    ws.on("close", () => {
      mirror!.clients.delete(ws);
      if (mirror!.clients.size === 0) {
        stopMirror(session, paneId);
      }
    });

    // Send current content to the new client as raw terminal output
    if (mirror.lastContent) {
      ws.send("\x1b[2J\x1b[H" + mirror.lastContent);
    }
    return mirror;
  }

  const clients = new Set<WebSocket>([ws]);

  // Send pane dimensions so browser terminal matches tmux pane size
  let paneCols = 80;
  let paneRows = 24;
  try {
    const dims = tmux(["display-message", "-t", paneId, "-p", "#{pane_width} #{pane_height}"]);
    const [c, r] = dims.split(" ");
    paneCols = parseInt(c!, 10) || 80;
    paneRows = parseInt(r!, 10) || 24;
  } catch {
    /* use defaults */
  }
  // Send dimensions as JSON (the only JSON message — client detects by leading {)
  ws.send(JSON.stringify({ type: "dimensions", cols: paneCols, rows: paneRows }));

  // Send initial scrollback as raw terminal output
  try {
    const scrollback = tmux(["capture-pane", "-t", paneId, "-p", "-e", "-S", "-2000"]);
    ws.send(scrollback);
  } catch {
    // Pane may not exist yet
  }

  let lastContent = "";

  // Start polling interval (100ms)
  const interval = setInterval(() => {
    try {
      const content = capturePaneContent(session, paneId);
      if (content !== lastContent) {
        lastContent = content;
        mirror!.lastContent = content;
        // Send clear screen + new content as raw terminal output
        const msg = "\x1b[2J\x1b[H" + content;
        for (const client of clients) {
          if (client.readyState === 1 /* WebSocket.OPEN */) {
            client.send(msg);
          }
        }
      }
    } catch {
      // Pane may have been destroyed — stop mirroring
      stopMirror(session, paneId);
    }
  }, 100);

  mirror = { session, paneId, clients, interval, lastContent };
  mirrors.set(key, mirror);

  ws.on("close", () => {
    mirror!.clients.delete(ws);
    if (mirror!.clients.size === 0) {
      stopMirror(session, paneId);
    }
  });

  return mirror;
}

export function stopMirror(session: string, paneId: string): void {
  const key = mirrorKey(session, paneId);
  const mirror = mirrors.get(key);
  if (!mirror) return;

  if (mirror.interval) {
    clearInterval(mirror.interval);
    mirror.interval = null;
  }

  for (const ws of mirror.clients) {
    ws.close();
  }
  mirror.clients.clear();
  mirrors.delete(key);
}

export function handleInput(paneId: string, data: string): void {
  execFileSync("tmux", ["send-keys", "-t", paneId, "-l", "--", data], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

export function handleResize(paneId: string, cols: number, rows: number): void {
  execFileSync("tmux", ["resize-pane", "-t", paneId, "-x", String(cols), "-y", String(rows)], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

export function stopAll(): void {
  for (const [, mirror] of mirrors) {
    if (mirror.interval) {
      clearInterval(mirror.interval);
    }
    for (const ws of mirror.clients) {
      ws.close();
    }
    mirror.clients.clear();
  }
  mirrors.clear();
}

export function getMirror(session: string, paneId: string): MirrorSession | undefined {
  return mirrors.get(mirrorKey(session, paneId));
}

export function listMirrors(): Array<{ session: string; paneId: string; clientCount: number }> {
  return [...mirrors.entries()].map(([, m]) => ({
    session: m.session,
    paneId: m.paneId,
    clientCount: m.clients.size,
  }));
}
