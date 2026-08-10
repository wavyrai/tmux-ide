import type { DesktopApplicationShellTarget as DesktopApplicationShellTargetContract } from "@tmux-ide/contracts";
import {
  applicationShellSessionTargetKey,
  type ApplicationShellSessionState,
} from "@tmux-ide/daemon-client/application-shell-session";

/** Compatibility names for the desktop renderer; policy lives in daemon-client. */
export type DesktopApplicationShellTarget = DesktopApplicationShellTargetContract;
export type DesktopApplicationShellResourceState = ApplicationShellSessionState;
export const daemonGenerationKey = applicationShellSessionTargetKey;
