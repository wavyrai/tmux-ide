/**
 * Honest, actionable presentations for the desktop app's non-workspace states.
 *
 * Everything here is PURE: it maps a real host signal — a daemon capability
 * issue code, a workspace-open error code, or the reason text those carry — to
 * the copy a recovery screen shows. It never invents a signal. The only thing it
 * reads out of a free-text `reason` is a missing-tmux hint, because tmux is an
 * external dependency the bundled daemon cannot self-heal and the reason is the
 * only place that fact currently reaches the renderer. When a concrete shell
 * command genuinely helps (installing tmux), it is returned as `command` so the
 * surface can render a copyable block; otherwise `command` is null and the
 * screen falls back to Retry / Reopen, which is the only honest next step for a
 * supervised, bundled daemon.
 */
import {
  startupReadinessBlockingRung,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonCapabilityState,
  type DesktopPlatform,
  type DesktopStartupReadiness,
  type StartupReadinessRungId,
} from "@tmux-ide/contracts";

export interface ConnectionRecoveryPresentation {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly guidance: string;
  /** A copyable shell command when one genuinely resolves the state, else null. */
  readonly command: string | null;
}

/**
 * PURE — does a daemon/workspace reason describe tmux being absent? tmux is the
 * one external binary the bundled daemon depends on, so a spawn failure naming
 * it is the actionable "install tmux" signal. Kept deliberately narrow: it
 * matches tmux paired with an absence word, never a bare mention.
 */
export function reasonIndicatesMissingTmux(reason: string): boolean {
  const text = reason.toLowerCase();
  if (!text.includes("tmux")) return false;
  return (
    text.includes("not found") ||
    text.includes("not installed") ||
    text.includes("no such file") ||
    text.includes("enoent") ||
    text.includes("command not found") ||
    text.includes("missing") ||
    text.includes("could not be located") ||
    text.includes("is unavailable")
  );
}

/** PURE — the platform-appropriate install command for tmux, or a generic hint. */
export function tmuxInstallCommand(platform: DesktopPlatform | undefined): string {
  if (platform === "darwin") return "brew install tmux";
  if (platform === "linux") return "sudo apt install tmux";
  return "Install tmux, then reopen tmux-ide";
}

function missingTmuxPresentation(
  platform: DesktopPlatform | undefined,
): ConnectionRecoveryPresentation {
  return {
    eyebrow: "Missing dependency",
    title: "tmux is not installed",
    description:
      "tmux-ide runs your workspace on a real tmux session, and tmux could not be found on this machine.",
    guidance: "Install tmux, then reopen tmux-ide",
    command: tmuxInstallCommand(platform),
  };
}

/**
 * PURE — the recovery screen for a daemon capability that is not connected. The
 * bundled daemon is supervised, so a genuinely missing engine resolves by
 * rechecking or reopening rather than a shell command — except when the reason
 * names a missing tmux, which is the one thing the user must fix themselves.
 */
export function recoveryForDaemonCapability(
  state: Exclude<DesktopDaemonCapabilityState, { status: "connected" }>,
  platform?: DesktopPlatform,
): ConnectionRecoveryPresentation {
  if (reasonIndicatesMissingTmux(state.reason)) return missingTmuxPresentation(platform);

  switch (state.code) {
    case "record-missing":
    case "process-not-running":
      return {
        eyebrow: "Native tmux workspace",
        title: "The workspace engine isn't running yet",
        description:
          "tmux-ide could not reach its background engine. It usually starts within a moment of opening the app.",
        guidance: "Recheck, or reopen tmux-ide if this persists",
        command: null,
      };
    case "probe-timeout":
      return {
        eyebrow: "Native tmux workspace",
        title: "Verifying the engine is taking too long",
        description: "The background engine did not answer a health check in time.",
        guidance: "Recheck the daemon, or reopen tmux-ide",
        command: null,
      };
    case "protocol-incompatible":
      return {
        eyebrow: "Version mismatch",
        title: "The engine is a different version",
        description:
          "The running tmux-ide engine speaks a protocol this app does not support. This usually means an update landed mid-session.",
        guidance: "Reopen tmux-ide to load a matching engine",
        command: null,
      };
    case "resource-broker-failed":
      return {
        eyebrow: "Native tmux workspace",
        title: "The engine connection could not be established",
        description: "tmux-ide reached the engine but could not open a working channel to it.",
        guidance: "Recheck the daemon, or reopen tmux-ide",
        command: null,
      };
    case "preview-only":
      return {
        eyebrow: "Preview",
        title: "This is a preview workspace",
        description: "Browser preview shows illustrative data and does not attach to the engine.",
        guidance: "Open tmux-ide on your desktop for a live workspace",
        command: null,
      };
    case "supervisor-halted":
      // The supervisor stopped restarting the engine after consecutive fatal
      // failures. Unlike the other states, rechecking will not recover this —
      // the reason carries the structural cause the supervisor measured.
      return {
        eyebrow: "Native tmux workspace",
        title: "The engine was stopped after repeated failures",
        description: state.reason,
        guidance: "Reopen tmux-ide. If this returns, the engine's saved state needs attention",
        command: null,
      };
    default:
      return {
        eyebrow: "Native tmux workspace",
        title: "The engine needs attention",
        description: state.reason,
        guidance: "Recheck the daemon, or reopen tmux-ide",
        command: null,
      };
  }
}

/**
 * PURE — the recovery screen for a rejected workspace-open (admission) attempt.
 * The daemon's own reason is authoritative and always carried through; this only
 * frames the concrete next step and surfaces a tmux install command when the
 * rejection was caused by a missing tmux.
 */
export function recoveryForWorkspaceOpenError(
  error: DesktopDaemonCapabilityError,
  platform?: DesktopPlatform,
): ConnectionRecoveryPresentation {
  if (reasonIndicatesMissingTmux(error.reason)) return missingTmuxPresentation(platform);

  switch (error.code) {
    case "workspace-not-found":
      return {
        eyebrow: "Open a project",
        title: "That folder could not be opened",
        description: "tmux-ide could not create or reopen a workspace for the folder you chose.",
        guidance: "Choose another folder, or try again",
        command: null,
      };
    case "invalid-request":
      return {
        eyebrow: "Open a project",
        title: "That folder was rejected",
        description: error.reason,
        guidance: "Choose a regular project folder and try again",
        command: null,
      };
    case "daemon-degraded":
    case "daemon-unavailable":
      return {
        eyebrow: "Native tmux workspace",
        title: "The engine could not open the folder",
        description: error.reason,
        guidance: "Recheck the daemon, then open the folder again",
        command: null,
      };
    case "daemon-identity-mismatch":
      return {
        eyebrow: "Native tmux workspace",
        title: "The engine changed while opening",
        description: "A newer engine generation replaced the one that started opening the folder.",
        guidance: "Try opening the folder again",
        command: null,
      };
    default:
      return {
        eyebrow: "Open a project",
        title: "Opening the folder did not complete",
        description: error.reason,
        guidance: "Try again, or choose another folder",
        command: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Startup readiness (m44.3)
// ---------------------------------------------------------------------------

/**
 * Human labels for the readiness rungs. Deliberately describes the THING that
 * is missing rather than the internal rung name, so the diagnostic reads as an
 * explanation instead of a schema dump.
 */
const RUNG_LABEL: Record<StartupReadinessRungId, string> = {
  "daemon-spawned": "starting the engine",
  "credential-held": "authorizing this app with the engine",
  "identity-established": "verifying the engine identity",
  "catalog-populated": "reading the terminal catalog",
  "attachment-issuable": "preparing terminal attachment",
};

const REASON_LABEL: Record<string, string> = {
  // Host issue codes.
  "record-missing": "the engine has not published itself yet",
  "record-invalid": "the engine's record is unreadable",
  "process-not-running": "the engine process is not running",
  "probe-timeout": "the engine did not answer in time",
  "probe-failed": "the engine could not be reached",
  "protocol-incompatible": "the engine speaks a different protocol",
  "identity-mismatch": "the engine identity changed",
  "identity-unreachable": "the engine identity could not be read",
  "supervisor-halted": "the engine was stopped after repeated failures",
  "preview-only": "this is a preview window with no engine",
  // Readiness's own codes.
  "owner-capability-unavailable": "the engine holds no owner credential",
  "daemon-identity-unavailable": "no engine identity could be established",
  "catalog-discovery-failed": "tmux could not be read",
  "catalog-sessions-unreachable": "the registered sessions are no longer running",
  "attachment-runtime-unready": "the attachment runtime never became ready",
  // Catalog faults, in the terminal-resource vocabulary.
  "missing-semantic-stamp": "a pane is missing its durable tmux-ide identity",
  "duplicate-semantic-stamp": "two panes claim the same durable identity",
  "duplicate-runtime-pane-binding": "one pane is bound to two identities",
  "invalid-runtime-proof": "tmux returned an unusable pane description",
  "missing-window-stamp": "a multi-pane window has no durable identity",
  "window-stamp-inconsistent": "a window's panes disagree on their identity",
  "duplicate-window-stamp": "two windows claim the same durable identity",
};

/** How many of the child's captured lines a recovery screen shows. */
const DIAGNOSTIC_CHILD_OUTPUT_LINES = 5;

/**
 * PURE — the diagnostic lines that name WHICH startup rung is stuck and why.
 *
 * This is the honesty wiring m44.3 exists for. A blocked startup used to reach
 * the user as generic "connection failed" copy; these lines name the rung, the
 * typed reason, and — when the desktop owned the engine child — the child's own
 * last words. An unrecognized code is printed rather than swallowed: a reason
 * this build does not know is still more useful than silence.
 */
export function startupReadinessDiagnostics(readiness: DesktopStartupReadiness): readonly string[] {
  const blocking = startupReadinessBlockingRung(readiness.ladder);
  const lines: string[] = [];
  if (!blocking) {
    lines.push("Startup readiness: every step is satisfied.");
  } else if (blocking.status === "stuck") {
    const code = blocking.reason.code;
    lines.push(`Startup stalled at: ${RUNG_LABEL[blocking.rung]} — ${REASON_LABEL[code] ?? code}.`);
  } else {
    lines.push(`Startup is waiting on: ${RUNG_LABEL[blocking.rung]}.`);
  }
  const output = readiness.childOutput;
  if (output) {
    const shown = output.lines.slice(-DIAGNOSTIC_CHILD_OUTPUT_LINES);
    if (output.truncated || output.lines.length > shown.length) {
      lines.push("Engine output (earlier lines trimmed):");
    } else if (shown.length > 0) {
      lines.push("Engine output:");
    }
    for (const line of shown) lines.push(`  ${line}`);
    if (output.exitCode !== null) lines.push(`The engine exited with code ${output.exitCode}.`);
    else if (output.signal !== null) lines.push(`The engine was stopped by ${output.signal}.`);
  }
  return lines;
}
