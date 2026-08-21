/**
 * Daemon-internal tmux inventory projected from the retained control channel.
 * Runtime addresses are required to re-run the strict semantic catalog proof;
 * this type must never be serialized by a command-center or pane-stream route.
 */
export interface TrustedMirrorPaneInventory {
  readonly runtimeSessionId: string;
  readonly runtimeWindowId: string;
  readonly runtimePaneId: string;
  readonly semanticWindowId: string;
  readonly semanticPaneId: string;
  readonly windowPaneCount: number;
  readonly sessionWindowCount: number;
  readonly paneIndex: number;
  readonly title: string;
  readonly currentCommand: string;
  readonly active: boolean;
  readonly role: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly missionStamp: string | null;
  readonly dir: string;
}

export interface TrustedMirrorSessionInventory {
  readonly sessionName: string;
  readonly runtimeSessionId: string;
  readonly panes: readonly TrustedMirrorPaneInventory[];
}
