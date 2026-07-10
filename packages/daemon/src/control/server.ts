/**
 * The control-socket server — `tmux-ide serve` (M23.3).
 *
 * NDJSON frames over a local Unix socket (default `~/.tmux-ide/control.sock`,
 * mode 0600). Agent loops connect once and drive the fleet — request/response
 * verbs plus PUSHED agent-status events after `subscribe` — instead of
 * spawning a CLI process per call. Protocol schemas live in
 * `@tmux-ide/contracts` (control.ts); verb handlers in `./verbs.ts` call the
 * SAME data layer the CLI cases do.
 *
 * HOST DECISION (the tradeoff, considered before building):
 *   (a) `tmux-ide serve` — an EXPLICIT foreground process. Costs the user a
 *       deliberate start, dies with them, trivially restartable after a code
 *       change, and its lifetime states its purpose.
 *   (b) piggyback on the `_tmux-ide-chrome` updater tick — always running for
 *       adopted fleets, but chrome-lifecycle-coupled: unadopting the last
 *       session would kill the API mid-conversation, `adopt` would grow a
 *       network-ish responsibility, and the updater's contract ("never let a
 *       bad tick break the bars") is the wrong place for a protocol surface.
 *   (c) socket-activated per-connection handlers — zero resident cost, but
 *       every connection pays a full node boot (the latency the socket exists
 *       to remove) and no resident process means no push events and no
 *       persistent status tracker (the cross-tick `done` needs history).
 *   CHOSEN: (a), deliberately WITHOUT auto-start. The old command-center HTTP
 *   server is the cautionary tale: an implicitly-running daemon accretes
 *   scope. This surface stays minimal — session-control verbs only, no feed,
 *   no chat, no network listener — and the CLI only uses the socket
 *   OPPORTUNISTICALLY (`--socket` fast-paths fall back to polling when no
 *   server is up). An agent that wants the socket runs `tmux-ide serve`
 *   itself; the process it spawned is the process it owns.
 *
 * SECURITY: local user only. The socket is chmod 0600, there is no network
 * transport, no tokens (filesystem permissions ARE the auth). The #90 bridge
 * that exposes this to a native app layers a WS server ON TOP later — each
 * NDJSON frame maps 1:1 to a WS text message, so that bridge is mechanical
 * and this file never grows remote scope.
 *
 * EVENTS: while at least one connection is subscribed, a detection tick
 * (same cadence and diff as the chrome updater, one persistent tracker)
 * computes the fleet and pushes session-level status transitions. No
 * subscribers → no tick → an idle server does nothing. The tick does NOT
 * write events.jsonl — the chrome updater owns the log; this stream is
 * transport, not history.
 */
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { CONTROL_PROTOCOL_VERSION, type AgentStatusEvent } from "@tmux-ide/contracts";
import { IdeError } from "../lib/errors.ts";
import { tuiStateHome } from "../lib/tui-binary.ts";
import { createStatusTracker, type AgentStatus } from "../tui/detect/classify.ts";
import { diffFleet } from "../tui/chrome/events.ts";
import { fleetStatuses, TICK_MS } from "../tui/chrome/updater.ts";
import { listTeamProjects } from "../tui/team/projects.ts";
import { dispatchLine } from "./dispatch.ts";
import { createFanout } from "./fanout.ts";
import { createFrameSplitter, encodeFrame } from "./frames.ts";
import { createVerbHandlers } from "./verbs.ts";

/** The default socket path — under the state home so `TMUX_IDE_HOME` scopes
 *  tests away from the real user socket. */
export function defaultControlSocketPath(): string {
  return join(tuiStateHome(), "control.sock");
}

export interface ControlServerOptions {
  socketPath?: string;
  /** Diagnostics sink (the CLI passes stderr). Default: silent. */
  log?: (message: string) => void;
  /** Event-tick cadence override (tests); defaults to the updater's TICK_MS. */
  tickMs?: number;
}

export interface ControlServer {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * Claim `path`: refuse anything that exists and is not a socket (NEVER
 * unlink a foreign file), refuse a socket another live server answers on,
 * and unlink a stale socket left by a dead server.
 */
async function claimSocketPath(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (!statSync(path).isSocket()) {
    throw new IdeError(
      `${path} exists and is not a socket — refusing to remove it. ` +
        `Pass a different --socket path.`,
      { code: "USAGE", exitCode: 1 },
    );
  }
  const alive = await new Promise<boolean>((resolve) => {
    const probe: Socket = connect(path);
    const done = (result: boolean) => {
      probe.destroy();
      resolve(result);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(500, () => done(false));
  });
  if (alive) {
    throw new IdeError(`another server is already listening on ${path}`, {
      code: "USAGE",
      exitCode: 1,
    });
  }
  unlinkSync(path); // stale socket from a dead server — safe to rebind
}

/** Start the server. Resolves once the socket is listening (mode 0600). */
export async function startControlServer(opts: ControlServerOptions = {}): Promise<ControlServer> {
  const socketPath = opts.socketPath ?? defaultControlSocketPath();
  const log = opts.log ?? (() => {});
  const tickMs = opts.tickMs ?? TICK_MS;

  mkdirSync(dirname(socketPath), { recursive: true });
  await claimSocketPath(socketPath);

  // ONE tracker for the server's lifetime, shared by the verbs and the event
  // tick — cross-tick `done` (working→idle) is only observable with history.
  const tracker = createStatusTracker();
  const handlers = createVerbHandlers({ tracker });

  // The event tick: runs ONLY while subscribers exist (fanout edges), diffs
  // the fleet exactly like the chrome updater, pushes transitions.
  const prevState = new Map<string, AgentStatus>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    try {
      const { events, state } = diffFleet(prevState, fleetStatuses(listTeamProjects(tracker)));
      prevState.clear();
      for (const [name, status] of state) prevState.set(name, status);
      const ts = new Date().toISOString();
      for (const ev of events) fanout.emit({ ts, ...ev });
    } catch (err) {
      log(`event tick failed: ${(err as Error).message}`);
    }
  };
  const fanout = createFanout<AgentStatusEvent>({
    onFirst: () => {
      tick(); // seed immediately — the first events carry the current fleet (from: null)
      timer = setInterval(tick, tickMs);
    },
    onLast: () => {
      if (timer) clearInterval(timer);
      timer = null;
      prevState.clear();
    },
  });

  const connections = new Set<Socket>();
  const server: Server = createServer((conn) => {
    connections.add(conn);
    conn.setEncoding("utf8");
    const split = createFrameSplitter();
    let unsubscribe: (() => void) | null = null;

    const push = (ev: AgentStatusEvent): void => {
      // One write per frame — JSON.stringify never contains a raw newline,
      // so frames from concurrent requests can never interleave mid-message.
      conn.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, event: "agent-status", data: ev }));
    };
    const ctx = {
      subscribe: () => {
        unsubscribe ??= fanout.add(push);
      },
    };

    conn.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = split(chunk);
      } catch {
        conn.destroy(); // frame overflow — a broken client, not a slow one
        return;
      }
      for (const line of lines) {
        // Handled CONCURRENTLY: a long `wait` must not block this
        // connection's other requests (responses correlate by id).
        void dispatchLine(line, handlers, ctx).then((response) => {
          if (!conn.destroyed) conn.write(encodeFrame(response));
        });
      }
    });
    conn.on("close", () => {
      unsubscribe?.();
      connections.delete(conn);
    });
    conn.on("error", () => {
      // close follows; nothing to do — never let a client error kill serve
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // Unix sockets cap the path at ~104 bytes (macOS sun_path) — surfaced
      // as a bare EINVAL. Say what actually went wrong and how to fix it.
      if ((err.code === "EINVAL" || err.code === "ENAMETOOLONG") && socketPath.length > 100) {
        reject(
          new IdeError(
            `socket path is too long for a Unix socket (${socketPath.length} chars; the OS caps it around 104): ${socketPath}\n` +
              `Pass a shorter path: tmux-ide serve --socket /tmp/tmux-ide-control.sock`,
            { code: "USAGE", exitCode: 1 },
          ),
        );
        return;
      }
      reject(err);
    });
    server.listen(socketPath, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath}`);

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        if (timer) clearInterval(timer);
        timer = null;
        for (const conn of connections) conn.destroy(); // clients see EOF
        server.close(() => {
          try {
            unlinkSync(socketPath);
          } catch {
            // already gone
          }
          resolve();
        });
      }),
  };
}
