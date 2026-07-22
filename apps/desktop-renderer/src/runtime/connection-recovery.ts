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
import type {
  DesktopDaemonCapabilityError,
  DesktopDaemonCapabilityState,
  DesktopPlatform,
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
