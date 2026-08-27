import type { CommandSource } from "@tmux-ide/contracts";

import type { ApplicationShellBinding } from "./application-shell-binding.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import type { ApplicationSessionFocusOwner } from "./application-session-focus-owner.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

type Source = "keyboard" | "mouse";

const sourceFor = (kind: Source): CommandSource => ({ kind, surface: "application-bar" });

export interface ApplicationGenerationStartResult {
  readonly opened: boolean;
  readonly sessionName: string;
  readonly generationKey: string | null;
}

/** Stable identity for one live semantic/input generation. */
export function applicationGenerationNavigationKey(
  snapshot: OpenTuiGenerationHostSnapshot | null,
): string | null {
  if (snapshot?.status !== "live" || !snapshot.daemonGeneration || !snapshot.client) return null;
  try {
    const clientGeneration = snapshot.client.getSnapshot().generation;
    if (!Number.isSafeInteger(clientGeneration)) return null;
    return `${snapshot.daemonGeneration}:${clientGeneration}:${snapshot.rendererEpoch}`;
  } catch {
    return null;
  }
}

export function createApplicationGenerationStarter(
  options: Readonly<{
    binding: Pick<ApplicationShellBinding, "openSession">;
    sessionOwner: () => OpenTuiSessionOwner;
    focusOwner: () => ApplicationSessionFocusOwner | null;
    setNote: (note: string | null) => void;
    setSurface: (surface: "terminals") => void;
  }>,
) {
  let startToken = 0;
  return async (
    sessionName: string,
    workspacePrepared = false,
    source: Source = "keyboard",
    focusFirstPane = true,
  ): Promise<ApplicationGenerationStartResult> => {
    const token = ++startToken;
    options.setNote(`opening ${sessionName}`);
    const owner = options.sessionOwner();
    const result = await options.binding.openSession(sessionName, sourceFor(source), (name) =>
      owner.open(name, workspacePrepared),
    );
    if (token !== startToken) return { opened: result.opened, sessionName, generationKey: null };
    const snapshot = owner.snapshot();
    if (result.opened && snapshot) {
      if (!result.activated) options.setSurface("terminals");
      if (focusFirstPane) options.focusOwner()?.request(sourceFor(source));
      options.setNote(null);
      return {
        opened: true,
        sessionName,
        generationKey: applicationGenerationNavigationKey(snapshot),
      };
    }
    options.setNote(`${sessionName} could not attach`);
    return { opened: false, sessionName, generationKey: null };
  };
}

export function createApplicationAgentNavigator(options: {
  readonly startGeneration: ReturnType<typeof createApplicationGenerationStarter>;
  readonly sessionOwner: () => OpenTuiSessionOwner;
  readonly selectPane: (paneId: string) => void;
}) {
  let navigationToken = 0;
  return async (sessionName: string, paneId: string, source: Source = "mouse") => {
    const token = ++navigationToken;
    // Exact agent focus replaces the chooser's generic first-pane focus. This
    // prevents two competing semantic selections from racing after a switch.
    const opened = await options.startGeneration(sessionName, false, source, false);
    if (token !== navigationToken || !opened.opened || opened.generationKey === null) return false;
    const owner = options.sessionOwner();
    if (
      owner.sessionName() !== sessionName ||
      applicationGenerationNavigationKey(owner.snapshot()) !== opened.generationKey
    )
      return false;
    options.selectPane(paneId);
    return true;
  };
}
