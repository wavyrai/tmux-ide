/**
 * The `wait` conditions — the SHARED implementation behind `tmux-ide wait
 * agent-status` / `tmux-ide wait output` (bin/cli.ts) and the control
 * socket's `wait` verb (src/control/). Extracted from the CLI case so the
 * socket is a transport over the same logic, not a second implementation.
 *
 * Both loops are deps-injected (fleet lister / pane capture, clock, sleep)
 * so the polling logic unit-tests without tmux; the exported defaults wire
 * the real io.
 */
import { capturePane } from "@tmux-ide/tmux-bridge";
import type { AgentStatus, StatusTracker } from "../detect/classify.ts";
import { createStatusTracker } from "../detect/classify.ts";
import { findSessionStatus } from "./report.ts";
import { listTeamSessions, type TeamSession } from "./sessions.ts";

/** Default overall timeout (matches the CLI's historical default). */
export const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
/** Poll cadence for the agent-status wait. */
export const WAIT_STATUS_POLL_MS = 750;
/** Poll cadence for the output-match wait. */
export const WAIT_OUTPUT_POLL_MS = 500;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * PURE — test `text` (a pane capture) against `pattern`, line by line, and
 * report the first matching LINE; falls back to whole-text matching (with the
 * last line reported) so multi-line patterns still hit. A fresh RegExp per
 * test so a user-supplied /g flag can't carry `lastIndex` between calls.
 * Returns null when nothing matches.
 */
export function matchOutput(text: string, pattern: string): string | null {
  const lines = text.split("\n");
  for (const line of lines) {
    if (new RegExp(pattern).test(line)) return line;
  }
  if (new RegExp(pattern).test(text)) return lines[lines.length - 1] ?? "";
  return null;
}

export interface WaitAgentStatusResult {
  ok: boolean;
  session: string;
  want: AgentStatus;
  /** The session's last observed status (null = session absent). */
  status: AgentStatus | null;
  /** Set when `ok` is false: how long we waited. */
  timedOutAfterMs?: number;
}

export interface WaitAgentStatusOpts {
  timeoutMs?: number;
  pollMs?: number;
  /**
   * The tracker threaded across polls (one PERSISTS per wait so the
   * cross-tick working→idle `done` transition can be observed). Injected by
   * tests; defaults to a fresh tracker.
   */
  tracker?: StatusTracker;
  listSessions?: (tracker: StatusTracker) => TeamSession[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Block until `session` reaches `want`, or time out. Never throws. */
export async function waitForAgentStatus(
  session: string,
  want: AgentStatus,
  opts: WaitAgentStatusOpts = {},
): Promise<WaitAgentStatusResult> {
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? WAIT_STATUS_POLL_MS;
  const tracker = opts.tracker ?? createStatusTracker();
  const list = opts.listSessions ?? listTeamSessions;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepMs;
  const started = now();

  for (;;) {
    const status = findSessionStatus(list(tracker), session);
    if (status === want) return { ok: true, session, want, status };
    if (now() - started >= timeoutMs) {
      return { ok: false, session, want, status, timedOutAfterMs: timeoutMs };
    }
    await sleep(pollMs);
  }
}

export interface WaitOutputResult {
  ok: boolean;
  target: string;
  pattern: string;
  /** The matching line when `ok`; null on timeout. */
  matched: string | null;
  timedOutAfterMs?: number;
}

export interface WaitOutputOpts {
  timeoutMs?: number;
  pollMs?: number;
  /** Pane capture (defaults to tmux-bridge's `capturePane`, 200 lines). */
  capture?: (target: string) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Block until `target`'s captured output matches `pattern`, or time out.
 * A capture failure (pane/session not (yet) available) keeps polling until
 * the timeout. Throws only on an invalid regex — validate before looping.
 */
export async function waitForOutputMatch(
  target: string,
  pattern: string,
  opts: WaitOutputOpts = {},
): Promise<WaitOutputResult> {
  new RegExp(pattern); // an invalid pattern is a usage error, surfaced up front
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? WAIT_OUTPUT_POLL_MS;
  const capture = opts.capture ?? defaultCapture;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepMs;
  const started = now();

  for (;;) {
    let text = "";
    try {
      text = capture(target);
    } catch {
      // not capturable yet — keep polling
    }
    const matched = matchOutput(text, pattern);
    if (matched !== null) return { ok: true, target, pattern, matched };
    if (now() - started >= timeoutMs) {
      return { ok: false, target, pattern, matched: null, timedOutAfterMs: timeoutMs };
    }
    await sleep(pollMs);
  }
}

function defaultCapture(target: string): string {
  return capturePane(target, { lines: 200 });
}
