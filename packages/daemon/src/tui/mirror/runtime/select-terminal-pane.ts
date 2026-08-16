import type { WorkspaceClientDispatch } from "@tmux-ide/daemon-client/workspace-client-types";

interface PaneSelectionClient {
  ownsInputAuthority?(): boolean;
  requestAuthority(authority: "input"): Promise<unknown | null>;
  dispatch(command: WorkspaceClientDispatch): Promise<unknown>;
}

export interface LivePaneSelectionTarget {
  readonly status: "live";
  readonly workspaceName: string;
  readonly client: PaneSelectionClient;
}

/** Acquire controller authority before issuing the canonical pane-select intent. */
export async function selectTerminalPane(
  expected: LivePaneSelectionTarget,
  current: () => LivePaneSelectionTarget | null,
  semanticPaneId: string,
): Promise<boolean> {
  const isCurrent = (): boolean => {
    const active = current();
    return (
      active?.status === "live" &&
      active.client === expected.client &&
      active.workspaceName === expected.workspaceName
    );
  };
  try {
    const ownsInput = expected.client.ownsInputAuthority?.() === true;
    if (!ownsInput) {
      const lease = await expected.client.requestAuthority("input");
      if (!lease || !isCurrent()) return false;
    }
    if (!isCurrent()) return false;
    await expected.client.dispatch({
      kind: "semantic-intent",
      intent: {
        verb: "workspace.pane.select",
        workspaceName: expected.workspaceName,
        semanticPaneId,
      },
    });
    return isCurrent();
  } catch {
    return false;
  }
}
