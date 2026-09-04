import type { HomeAgentRow } from "./application-home-agents.ts";
import type { ApplicationGenerationStartResult } from "./application-generation-starter.ts";

export type HomeAgentNavigationSource = "keyboard" | "mouse";
export type HomeAgentNavigationTarget = Pick<
  HomeAgentRow,
  "key" | "daemonInstanceId" | "liveSessionId" | "sessionName" | "agentId" | "paneId"
>;

/** Attached identity, not the current catalog's identity copied onto an older connection. */
export interface HomeAgentNavigationGeneration {
  readonly generationKey: string;
  readonly daemonInstanceId: string;
  readonly liveSessionId: string | null;
  readonly sessionName: string;
  readonly agents: readonly { readonly id: string; readonly paneId: string | null }[];
}

export type HomeAgentNavigationFailure =
  | "unavailable"
  | "stale-target"
  | "attach-failed"
  | "generation-changed"
  | "pane-removed"
  | "superseded";

export interface HomeAgentNavigationResult {
  readonly opened: boolean;
  readonly failure?: HomeAgentNavigationFailure;
}

/** A small admission owner; it never owns PTY input or invents a pane from a label. */
export function createApplicationHomeAgentNavigator(options: {
  /** Compare with both the live catalog incarnation and the observer's current live row. */
  readonly isCurrentTarget: (target: HomeAgentNavigationTarget) => boolean;
  readonly currentGeneration: () => HomeAgentNavigationGeneration | null;
  /** Terminal-first attach can publish before semantic agent details arrive. */
  readonly waitForGeneration?: (generationKey: string, signal: AbortSignal) => Promise<boolean>;
  readonly startGeneration: (
    sessionName: string,
    workspacePrepared: boolean,
    source: HomeAgentNavigationSource,
    focusFirstPane: boolean,
    admission?: () => boolean,
  ) => Promise<ApplicationGenerationStartResult>;
  readonly selectPane: (paneId: string, source: HomeAgentNavigationSource) => void;
  readonly showTerminals: (source: HomeAgentNavigationSource) => void;
  readonly setNote: (note: string | null) => void;
}) {
  let navigationToken = 0;
  let disposed = false;
  let admissionController: AbortController | null = null;
  const active = (token: number) => !disposed && token === navigationToken;
  const failure = (
    token: number,
    reason: HomeAgentNavigationFailure,
    note: string,
  ): HomeAgentNavigationResult => {
    if (!active(token)) return { opened: false, failure: "superseded" };
    options.setNote(note);
    return { opened: false, failure: reason };
  };
  const admit = (
    token: number,
    target: HomeAgentNavigationTarget,
    source: HomeAgentNavigationSource,
    expectedGeneration?: string,
  ): HomeAgentNavigationResult => {
    if (!active(token)) return { opened: false, failure: "superseded" };
    if (!options.isCurrentTarget(target))
      return failure(
        token,
        "stale-target",
        "That agent changed or disappeared. Select it again on Home.",
      );
    const current = options.currentGeneration();
    if (
      !current ||
      (expectedGeneration !== undefined && current.generationKey !== expectedGeneration) ||
      current.sessionName !== target.sessionName ||
      current.daemonInstanceId !== target.daemonInstanceId ||
      current.liveSessionId !== target.liveSessionId
    ) {
      return failure(
        token,
        "generation-changed",
        "The session changed while opening that agent. Return Home and retry.",
      );
    }
    if (
      !target.paneId ||
      !current.agents.some((agent) => agent.id === target.agentId && agent.paneId === target.paneId)
    )
      return failure(
        token,
        "pane-removed",
        "That exact agent terminal is no longer available. Return Home and select another agent.",
      );
    // Synchronous on the warm path: selection precedes surface visibility and
    // the next input event. The existing terminal owner remains the only input path.
    options.selectPane(target.paneId, source);
    options.showTerminals(source);
    options.setNote(null);
    return { opened: true };
  };
  return {
    async open(
      target: HomeAgentNavigationTarget,
      source: HomeAgentNavigationSource = "mouse",
    ): Promise<HomeAgentNavigationResult> {
      if (disposed) return { opened: false, failure: "superseded" };
      admissionController?.abort();
      const controller = new AbortController();
      admissionController = controller;
      const token = ++navigationToken;
      try {
        if (!target.paneId)
          return failure(token, "unavailable", "This agent has no available terminal to open.");
        if (!options.isCurrentTarget(target))
          return failure(
            token,
            "stale-target",
            "That agent changed or disappeared. Select it again on Home.",
          );
        if (options.currentGeneration()?.sessionName === target.sessionName)
          return admit(token, target, source);
        options.setNote(`Opening agent in ${target.sessionName}…`);
        // Never briefly focus the first pane of the newly opened session.
        const opened = await options.startGeneration(target.sessionName, false, source, false, () =>
          active(token),
        );
        if (!active(token)) return { opened: false, failure: "superseded" };
        if (opened.failure === "superseded") return { opened: false, failure: "superseded" };
        if (
          !opened.opened ||
          opened.generationKey === null ||
          opened.sessionName !== target.sessionName
        )
          return failure(
            token,
            "attach-failed",
            "The agent session could not be opened. Return Home and retry.",
          );
        if (options.waitForGeneration) {
          const ready = await options.waitForGeneration(opened.generationKey, controller.signal);
          if (!active(token)) return { opened: false, failure: "superseded" };
          if (!ready)
            return failure(
              token,
              "attach-failed",
              "The session opened, but agent details are not ready. Return Home and retry.",
            );
        }
        return admit(token, target, source, opened.generationKey);
      } catch {
        return failure(
          token,
          "attach-failed",
          "The agent terminal could not be opened safely. Return Home and retry.",
        );
      }
    },
    /** Call on competing session/surface intents, including an explicit return Home. */
    cancel() {
      navigationToken += 1;
      admissionController?.abort();
    },
    dispose() {
      disposed = true;
      navigationToken += 1;
      admissionController?.abort();
    },
  };
}
