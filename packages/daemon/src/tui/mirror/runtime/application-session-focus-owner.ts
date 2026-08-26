import type { CommandSource } from "@tmux-ide/contracts";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

export interface ApplicationSessionFocusOwner {
  request(source: CommandSource): void;
  adopt(): void;
  dispose(): void;
}

/** Moves a chooser-opened session from canvas focus to its first live terminal pane. */
export function createApplicationSessionFocusOwner(options: {
  readonly generation: () => OpenTuiGenerationHostSnapshot | null;
  readonly layout: () => OpenTuiWorkspaceLayoutSnapshot;
  readonly focusTerminalPane: (paneId: string, source: CommandSource) => Promise<boolean>;
}): ApplicationSessionFocusOwner {
  let pending: { readonly source: CommandSource; readonly token: number } | null = null;
  let nextToken = 0;
  let inFlight = false;
  let lastSource: CommandSource | null = null;
  let liveGeneration: string | null = null;
  let recoverOnNextLive = false;
  const liveGenerationKey = (): string | null => {
    const snapshot = options.generation();
    return snapshot?.status === "live"
      ? `${snapshot.daemonGeneration}:${snapshot.rendererEpoch}`
      : null;
  };

  const settle = (): void => {
    if (!pending || inFlight || options.generation()?.status !== "live") return;
    const paneId =
      options.layout().current?.panes.find(({ active, pane }) => active && Boolean(pane))?.pane ??
      options.layout().current?.panes.find(({ pane }) => Boolean(pane))?.pane ??
      null;
    if (!paneId) return;
    const request = pending;
    inFlight = true;
    void options.focusTerminalPane(paneId, request.source).then(
      (focused) => {
        inFlight = false;
        if (pending?.token !== request.token) return;
        if (focused) pending = null;
        else settle();
      },
      () => {
        inFlight = false;
      },
    );
  };

  return {
    request(source) {
      lastSource = source;
      liveGeneration ??= liveGenerationKey();
      pending = { source, token: ++nextToken };
      settle();
    },
    adopt() {
      const snapshot = options.generation();
      if (snapshot?.status !== "live") {
        if (liveGeneration !== null && lastSource !== null) recoverOnNextLive = true;
        settle();
        return;
      }
      const generation = liveGenerationKey()!;
      if (liveGeneration !== null && generation !== liveGeneration && lastSource !== null)
        recoverOnNextLive = true;
      liveGeneration = generation;
      if (recoverOnNextLive && !pending && lastSource) {
        pending = { source: lastSource, token: ++nextToken };
        recoverOnNextLive = false;
      }
      settle();
    },
    dispose() {
      pending = null;
      nextToken += 1;
    },
  };
}
