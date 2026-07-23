import type {
  DesktopDaemonHostIssueCode,
  DesktopDaemonSupervisorFatalReason,
} from "@tmux-ide/contracts";

/**
 * PURE restart policy for the Electron-owned daemon child.
 *
 * The supervisor restarts a crashed or failed daemon with bounded exponential
 * backoff, but a structurally broken daemon (incompatible protocol, corrupt
 * canonical record, non-loopback endpoint, unstartable bundle) must never be
 * retried forever: after `fatalFailureCeiling` CONSECUTIVE fatal failures the
 * loop stops and the typed reason is surfaced to the renderer. Transient
 * failures (crashes, timeouts, unreachable probes, lost races) never halt the
 * loop and reset the fatal streak.
 */
export interface DaemonRestartPolicy {
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Fraction of the base delay used as symmetric jitter (0 disables it). */
  readonly jitterRatio: number;
  /** Consecutive fatal failures after which the supervisor halts. */
  readonly fatalFailureCeiling: number;
}

export const DEFAULT_DAEMON_RESTART_POLICY: DaemonRestartPolicy = {
  initialBackoffMs: 500,
  maxBackoffMs: 10_000,
  jitterRatio: 0.2,
  fatalFailureCeiling: 3,
};

/** Structured description of one failed daemon start attempt. */
export type DaemonStartFailure =
  | {
      readonly kind: "preflight";
      readonly status: "unavailable" | "degraded";
      readonly code: DesktopDaemonHostIssueCode;
    }
  | { readonly kind: "spawn-failed" }
  | {
      readonly kind: "child-exit";
      readonly exitCode: number | null;
      readonly signal: string | null;
    }
  | { readonly kind: "readiness-timeout" }
  | { readonly kind: "identity-changed" };

export type DaemonStartFailureClassification =
  | { readonly severity: "fatal"; readonly reason: DesktopDaemonSupervisorFatalReason }
  | { readonly severity: "transient" };

const FATAL_PREFLIGHT_REASONS: Partial<
  Record<DesktopDaemonHostIssueCode, DesktopDaemonSupervisorFatalReason>
> = {
  "record-invalid": "record-invalid",
  "protocol-incompatible": "protocol-incompatible",
  "endpoint-not-loopback": "endpoint-not-loopback",
  "identity-mismatch": "identity-mismatch",
  "health-mismatch": "health-mismatch",
};

/**
 * The daemon child converges structural startup refusals (protocol mismatch,
 * identity mismatch, invalid usage) on exit code 2 via IdeError; crashes and
 * environmental failures exit 1 or die on a signal.
 */
const CHILD_FATAL_EXIT_CODE = 2;

export function classifyDaemonStartFailure(
  failure: DaemonStartFailure,
): DaemonStartFailureClassification {
  if (failure.kind === "preflight" && failure.status === "degraded") {
    const reason = FATAL_PREFLIGHT_REASONS[failure.code];
    return reason ? { severity: "fatal", reason } : { severity: "transient" };
  }
  if (failure.kind === "spawn-failed") {
    return { severity: "fatal", reason: "spawn-failed" };
  }
  if (failure.kind === "child-exit" && failure.exitCode === CHILD_FATAL_EXIT_CODE) {
    return { severity: "fatal", reason: "child-fatal-exit" };
  }
  return { severity: "transient" };
}

/**
 * Bounded exponential backoff with symmetric jitter. `previousFailures` is the
 * number of failed attempts since the last success: 0 (a first crash) waits
 * the initial delay, each further failure doubles it up to the cap.
 */
export function daemonRestartDelayMs(
  previousFailures: number,
  policy: DaemonRestartPolicy,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(0, previousFailures), 30);
  const base = Math.min(policy.initialBackoffMs * 2 ** exponent, policy.maxBackoffMs);
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.min(policy.maxBackoffMs, Math.max(0, Math.round(base + jitter)));
}

/**
 * The renderer-safe capability schema bounds reasons at 240 characters; this
 * reason crosses that bridge verbatim, so it is composed within the bound.
 */
const MAX_HALT_REASON_LENGTH = 240;

export function supervisorHaltReason(
  reason: DesktopDaemonSupervisorFatalReason,
  fatalFailureCeiling: number,
  lastFailureReason: string,
): string {
  const prefix =
    `The bundled engine stopped after ${fatalFailureCeiling} consecutive ` +
    `fatal startup failures (${reason}).`;
  const detail = lastFailureReason.trim();
  const composed = detail.length > 0 ? `${prefix} Last failure: ${detail}` : prefix;
  if (composed.length <= MAX_HALT_REASON_LENGTH) return composed;
  return `${composed.slice(0, MAX_HALT_REASON_LENGTH - 1)}…`;
}
