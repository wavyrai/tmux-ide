/**
 * Receipt-driven `wait agent-status` — the push twin of the polling loop in
 * `wait.ts`.
 *
 * Daemon completion receipts and session invalidations are wake-up hints, not
 * proof that the whole session reached a status. Re-read the same aggregate
 * session status as the polling path: another agent may still be working or
 * blocked. Neither transport proves success of a submitted task. Bursts of
 * hints share one read, with a persistent classification tracker.
 *
 * Honest degrade: this path only answers for the receipt-covered targets
 * (`done` / `idle` — the "turn finished" statuses). Every other case — no
 * daemon record, dead daemon, connection failure, socket drop mid-wait, or a
 * non-receipt target status — returns `null` and the caller falls back to the
 * existing polling implementation. A timeout is a real answer, not a fallback.
 *
 * Deps are injected (daemon record reader, liveness probe, socket factory,
 * aggregate status read, clock) so the waiting logic unit-tests without a
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

/** How long to allow socket open, hello and observer-install acknowledgement before falling back to polling. */
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
  send(data: string): void;
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
   * Aggregate session status read after observer acknowledgement and on coalesced hints. A turn completed
   * before this process launched is answered immediately instead of waiting
   * for a receipt that already fired. Defaults to the same fleet read the
   * polling loop uses, with a tracker retained for the entire wait.
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

  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const timedOut = (): WaitAgentStatusResult => ({
    ok: false,
    session,
    want,
    status: null,
    timedOutAfterMs: timeoutMs,
  });
  const remaining = (): number => Math.max(0, timeoutMs - (now() - started));
  const readInfo = opts.readDaemonInfo ?? readCanonicalDaemonInfo;
  let info: CanonicalDaemonInfo | null;
  try {
    info = readInfo();
  } catch {
    return null;
  }
  if (!info) return null;
  const probeAlive = opts.probeAlive ?? isCanonicalDaemonAlive;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const alive = await Promise.race([
      probeAlive(info),
      new Promise<null>((resolve) => {
        probeTimer = setTimeout(() => resolve(null), remaining());
        probeTimer.unref?.();
      }),
    ]);
    if (alive === null || remaining() === 0) return timedOut();
    if (!alive) return null;
  } catch {
    return null;
  } finally {
    clearTimeout(probeTimer);
  }

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
  const tracker = createStatusTracker();
  const currentStatus =
    opts.currentStatus ?? (() => findSessionStatus(listTeamSessions(tracker), session));

  const url = canonicalDaemonUrl("ws", info.bindHostname, info.port, "/ws/events");
  let socket: ReceiptSocket;
  try {
    socket = openSocket(url);
  } catch {
    return null;
  }

  return new Promise<WaitAgentStatusResult | null>((resolve) => {
    let settled = false;
    let subscribed = false;
    let ready = false;
    let lastStatus: AgentStatus | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: WaitAgentStatusResult | null): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      try {
        socket.close();
      } catch {
        // already gone — nothing to release
      }
      resolve(result);
    };

    const refreshStatus = (): void => {
      if (settled) return;
      try {
        lastStatus = currentStatus();
      } catch {
        // This transport cannot establish aggregate status; use the fallback.
        settle(null);
        return;
      }
      if (lastStatus === want) settle({ ok: true, session, want, status: want });
    };

    deadlineTimer = setTimeout(() => settle({ ...timedOut(), status: lastStatus }), remaining());
    deadlineTimer.unref?.();
    connectTimer = setTimeout(() => settle(null), connectTimeoutMs);
    connectTimer.unref?.();

    socket.on("error", () => settle(null));
    socket.on("close", () => settle(null));

    socket.on("message", (data) => {
      if (settled) return;
      let raw: unknown;
      try {
        raw = JSON.parse(messageText(data));
      } catch {
        return; // not a protocol frame — ignore
      }
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
      if (!parsed.success) {
        if (!ready) settle(null); // incompatible handshake/protocol
        return;
      }
      const frame = parsed.data;
      if (frame.type === "protocol.error") {
        settle(null);
        return;
      }
      if (frame.type === "hello") {
        if (subscribed) return;
        if (
          frame.daemon.protocolVersion !== info.protocolVersion ||
          frame.daemon.instanceId !== info.instanceId
        ) {
          settle(null);
          return;
        }
        subscribed = true;
        try {
          socket.send(
            JSON.stringify({
              type: "subscribe",
              sessions: [],
              legacyEvents: true,
              interests: [{ resource: "fleet-catalog", workspaceName: null }],
              interestRevision: 1,
            }),
          );
        } catch {
          settle(null);
        }
        return;
      }
      if (frame.type === "resource.interests-ack") {
        if (!subscribed || ready || frame.interestRevision !== 1) return;
        if (frame.unavailableInterests.length > 0) {
          settle(null);
          return;
        }
        ready = true;
        if (connectTimer !== null) clearTimeout(connectTimer);
        // Observation is installed and baselined before this read. Hints that
        // arrived before the barrier are covered by this current snapshot.
        refreshStatus();
        return;
      }
      if (!ready) return;

      if (
        (frame.type !== "agent.turn-completed" && frame.type !== "agent-status.changed") ||
        frame.sessionName !== session
      )
        return;
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshStatus();
      }, 0);
      refreshTimer.unref?.();
    });
  });
}
