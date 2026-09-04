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
  readonly failure?: "superseded" | "attach-rejected" | "attach-failed" | "generation-not-ready";
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
    admission: () => boolean = () => true,
  ): Promise<ApplicationGenerationStartResult> => {
    const token = ++startToken;
    const isCurrent = () => token === startToken && admission();
    if (!isCurrent())
      return { opened: false, sessionName, generationKey: null, failure: "superseded" };
    options.setNote(`opening ${sessionName}`);
    const owner = options.sessionOwner();
    let result: Awaited<ReturnType<typeof options.binding.openSession>>;
    try {
      result = await options.binding.openSession(
        sessionName,
        sourceFor(source),
        async (name) => (isCurrent() ? owner.open(name, workspacePrepared) : false),
        isCurrent,
      );
    } catch {
      if (isCurrent()) options.setNote(`${sessionName} could not attach`);
      return { opened: false, sessionName, generationKey: null, failure: "attach-failed" };
    }
    if (!isCurrent())
      return { opened: false, sessionName, generationKey: null, failure: "superseded" };
    const snapshot = owner.snapshot();
    if (result.opened && snapshot && (snapshot.status === "live" || snapshot.status === "empty")) {
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
    return {
      opened: false,
      sessionName,
      generationKey: null,
      failure: result.opened ? "generation-not-ready" : "attach-rejected",
    };
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
    const currentOwner = options.sessionOwner();
    if (
      currentOwner.sessionName() === sessionName &&
      applicationGenerationNavigationKey(currentOwner.snapshot()) !== null
    ) {
      // Sidebar agents belong to the already-live workspace. Select their pane
      // before returning control to OpenTUI so the very next key cannot leak to
      // the pane that was focused before the click.
      options.selectPane(paneId);
      return true;
    }
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
