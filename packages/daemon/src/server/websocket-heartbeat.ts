import {
  WEBSOCKET_HEARTBEAT_HEADER,
  WEBSOCKET_HEARTBEAT_INTERVAL_MS,
  WEBSOCKET_HEARTBEAT_MAX_INTERVAL_MS,
  WEBSOCKET_HEARTBEAT_MIN_INTERVAL_MS,
  WEBSOCKET_HEARTBEAT_MISSED_LIMIT,
  formatWebSocketHeartbeatHeader,
  type WebSocketHeartbeatPolicy,
} from "@tmux-ide/contracts";
import { logger } from "../lib/log.ts";

/** The part of a `ws` socket the heartbeat needs. */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong" | "close", listener: () => void): unknown;
  off(event: "pong" | "close", listener: () => void): unknown;
}

export interface WebSocketHeartbeat {
  readonly policy: WebSocketHeartbeatPolicy;
  /** Start pinging this socket; it leaves by itself when it closes. */
  watch(socket: HeartbeatSocket, label: string): void;
  /** `ws` "headers" listener: advertises the cadence on the upgrade response. */
  advertise(headers: string[]): void;
  readonly watched: number;
  /** True while the one shared timer exists, i.e. while anything is watched. */
  readonly ticking: boolean;
}

/**
 * One timer for every watched socket, and none while nothing is watched: an
 * idle daemon with no clients pays nothing. Each tick sends one ping frame
 * (2 bytes) per connection and reads back one pong (6 bytes); a socket that
 * answered none of `missedLimit` consecutive pings is terminated, which lets
 * the owning transport release its leases through its ordinary close path.
 */
export function createWebSocketHeartbeat(
  policy: WebSocketHeartbeatPolicy = {
    intervalMs: WEBSOCKET_HEARTBEAT_INTERVAL_MS,
    missedLimit: WEBSOCKET_HEARTBEAT_MISSED_LIMIT,
  },
): WebSocketHeartbeat {
  const sockets = new Map<HeartbeatSocket, { unanswered: number; label: string }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = (): void => {
    for (const [socket, state] of [...sockets]) {
      if (state.unanswered >= policy.missedLimit) {
        logger.warn("websocket-heartbeat", "peer answered no ping; connection dropped", {
          connection: state.label,
          unansweredPings: state.unanswered,
          intervalMs: policy.intervalMs,
        });
        forget(socket);
        try {
          socket.terminate();
        } catch {
          /* Already gone. */
        }
        continue;
      }
      state.unanswered += 1;
      try {
        socket.ping();
      } catch {
        /* A socket that cannot be pinged is closing; its close event removes it. */
      }
    }
  };
  const listeners = new Map<HeartbeatSocket, { pong: () => void; close: () => void }>();
  const forget = (socket: HeartbeatSocket): void => {
    const attached = listeners.get(socket);
    if (attached) {
      socket.off("pong", attached.pong);
      socket.off("close", attached.close);
      listeners.delete(socket);
    }
    sockets.delete(socket);
    if (sockets.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    policy,
    watch(socket, label) {
      if (sockets.has(socket)) return;
      const state = { unanswered: 0, label };
      sockets.set(socket, state);
      const attached = {
        pong: () => {
          state.unanswered = 0;
        },
        close: () => forget(socket),
      };
      listeners.set(socket, attached);
      socket.on("pong", attached.pong);
      socket.on("close", attached.close);
      if (!timer) {
        timer = setInterval(tick, policy.intervalMs);
        timer.unref?.();
      }
    },
    advertise(headers) {
      headers.push(`${WEBSOCKET_HEARTBEAT_HEADER}: ${formatWebSocketHeartbeatHeader(policy)}`);
    },
    get watched() {
      return sockets.size;
    },
    get ticking() {
      return timer !== null;
    },
  };
}

/** Soaks and tests may shorten the interval; anything out of range keeps the default. */
export function heartbeatPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WebSocketHeartbeatPolicy {
  const configured = Number(environment.TMUX_IDE_WS_HEARTBEAT_INTERVAL_MS);
  const intervalMs =
    Number.isSafeInteger(configured) &&
    configured >= WEBSOCKET_HEARTBEAT_MIN_INTERVAL_MS &&
    configured <= WEBSOCKET_HEARTBEAT_MAX_INTERVAL_MS
      ? configured
      : WEBSOCKET_HEARTBEAT_INTERVAL_MS;
  return { intervalMs, missedLimit: WEBSOCKET_HEARTBEAT_MISSED_LIMIT };
}

let shared: WebSocketHeartbeat | null = null;
/** The daemon process's single heartbeat: every route shares its one timer. */
export function daemonWebSocketHeartbeat(): WebSocketHeartbeat {
  shared ??= createWebSocketHeartbeat(heartbeatPolicyFromEnvironment());
  return shared;
}
