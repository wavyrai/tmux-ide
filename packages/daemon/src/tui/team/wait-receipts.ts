/**
 * Receipt-driven `wait agent-status` — the push twin of the polling loop in
 * `wait.ts`.
 *
 * When a canonical daemon is running, its agent-status watcher already
 * observes every `@agent_state` transition and emits a typed
 * `agent.turn-completed` receipt on the `/ws/events` bus. Waiting on that
 * receipt replaces the CLI's local poll (which re-scrapes the whole fleet
 * every 750 ms) with a single WebSocket that sits idle until the daemon
 * pushes the completion.
 *
 * Honest degrade: this path only answers for the receipt-covered targets
 * (`done` / `idle` — the "turn finished" statuses). Every other case — no
 * daemon record, dead daemon, connection failure, socket drop mid-wait, or a
 * non-receipt target status — returns `null` and the caller falls back to the
 * existing polling implementation. A timeout is a real answer, not a fallback.
 *
 * Deps are injected (daemon record reader, liveness probe, socket factory,
 * one-shot status read, clock) so the waiting logic unit-tests without a
 * daemon; the exported defaults wire the real io.
 */

import { WebSocket as WsWebSocket } from "ws";
import { DaemonEventServerFrameSchemaZ, type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import type { AgentStatus } from "../detect/classify.ts";
import { createStatusTracker } from "../detect/classify.ts";
import { findSessionStatus } from "./report.ts";
import { listTeamSessions } from "./sessions.ts";
import { WAIT_DEFAULT_TIMEOUT_MS, type WaitAgentStatusResult } from "./wait.ts";

/** How long to give the daemon socket to open before falling back to polling. */
export const RECEIPT_CONNECT_TIMEOUT_MS = 1_500;

/** The statuses a turn-completed receipt can settle; all others need the poll. */
export function isReceiptCoveredStatus(want: AgentStatus): want is "done" | "idle" {
  return want === "done" || want === "idle";
}

/** The minimal socket surface the wait needs — `ws` satisfies it directly. */
export interface ReceiptSocket {
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  close(): void;
}

export interface WaitReceiptsOpts {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Canonical daemon record reader (defaults to the real `daemon.json`). */
  readDaemonInfo?: () => CanonicalDaemonInfo | null;
  /** Daemon liveness probe (defaults to the pid check). */
  probeAlive?: (info: CanonicalDaemonInfo) => Promise<boolean>;
  /** Socket factory (defaults to `ws` against the daemon's `/ws/events`). */
  openSocket?: (url: string) => ReceiptSocket;
  /**
   * One-shot status read run AFTER the socket opens, so a turn that completed
   * before this process launched is answered immediately instead of waiting
   * for a receipt that already fired. Defaults to the same fleet read the
   * polling loop uses (a single iteration, not a loop).
   */
  currentStatus?: () => AgentStatus | null;
  now?: () => number;
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return String(data);
}

/**
 * Wait for `session` to reach `want` by listening for the daemon's
 * `agent.turn-completed` receipt. Returns `null` whenever this path cannot
 * answer (see module doc) so the caller falls back to polling; returns a
 * {@link WaitAgentStatusResult} — success or honest timeout — when it can.
 */
export async function waitForAgentStatusViaReceipts(
  session: string,
  want: AgentStatus,
  opts: WaitReceiptsOpts = {},
): Promise<WaitAgentStatusResult | null> {
  if (!isReceiptCoveredStatus(want)) return null;

  const readInfo = opts.readDaemonInfo ?? readCanonicalDaemonInfo;
  let info: CanonicalDaemonInfo | null;
  try {
    info = readInfo();
  } catch {
    return null;
  }
  if (!info) return null;
  const probeAlive = opts.probeAlive ?? isCanonicalDaemonAlive;
  if (!(await probeAlive(info))) return null;

  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? RECEIPT_CONNECT_TIMEOUT_MS;
  // A loopback-bound daemon admits same-machine upgrades without a token; a
  // remote-bound daemon enforces its token even locally, so present the one
  // the user-owned daemon.json already carries.
  const authToken = info.authToken;
  const openSocket =
    opts.openSocket ??
    ((url: string) =>
      new WsWebSocket(
        url,
        authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined,
      ) as unknown as ReceiptSocket);
  const currentStatus =
    opts.currentStatus ??
    (() => findSessionStatus(listTeamSessions(createStatusTracker()), session));

  const url = canonicalDaemonUrl("ws", info.bindHostname, info.port, "/ws/events");
  let socket: ReceiptSocket;
  try {
    socket = openSocket(url);
  } catch {
    return null;
  }

  return new Promise<WaitAgentStatusResult | null>((resolve) => {
    let settled = false;
    let lastStatus: AgentStatus | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: WaitAgentStatusResult | null): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      try {
        socket.close();
      } catch {
        // already gone — nothing to release
      }
      resolve(result);
    };

    connectTimer = setTimeout(() => settle(null), connectTimeoutMs);
    connectTimer.unref?.();

    socket.on("error", () => settle(null));
    socket.on("close", () => settle(null));

    socket.on("open", () => {
      if (settled) return;
      if (connectTimer !== null) clearTimeout(connectTimer);
      deadlineTimer = setTimeout(
        () => settle({ ok: false, session, want, status: lastStatus, timedOutAfterMs: timeoutMs }),
        timeoutMs,
      );
      deadlineTimer.unref?.();
      // The watcher baselines when the first client connects, so a receipt can
      // only describe a transition AFTER this socket exists. Answer the
      // already-finished case with one direct read.
      try {
        lastStatus = currentStatus();
      } catch {
        lastStatus = null;
      }
      if (lastStatus === want) {
        settle({ ok: true, session, want, status: want });
      }
    });

    socket.on("message", (data) => {
      if (settled) return;
      let raw: unknown;
      try {
        raw = JSON.parse(messageText(data));
      } catch {
        return; // not a protocol frame — ignore
      }
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.type !== "agent.turn-completed" || frame.sessionName !== session) return;
      lastStatus = frame.toStatus;
      if (frame.toStatus === want) {
        settle({ ok: true, session, want, status: want });
      }
    });
  });
}
