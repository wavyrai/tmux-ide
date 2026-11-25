/**
 * Daemon-internal tmux inventory projected from the retained control channel.
 * Runtime addresses are required to re-run the strict semantic catalog proof;
 * this type must never be serialized by a command-center or pane-stream route.
 */
export interface TrustedMirrorPaneInventory {
  readonly nativePaneBirthId?: string | null;
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
  readonly nameSource?: string | null;
  readonly type: string | null;
  readonly missionStamp: string | null;
  readonly dir: string;
  /** #882: a floating pane, listed but with no cell in the tiled layout. */
  readonly floating?: boolean;
}

export interface TrustedMirrorSessionInventory {
  readonly sessionName: string;
  readonly runtimeSessionId: string;
  readonly panes: readonly TrustedMirrorPaneInventory[];
}
