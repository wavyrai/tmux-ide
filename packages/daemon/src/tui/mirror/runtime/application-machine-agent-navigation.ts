import type { AdmittedPaneSelectionOutcome } from "./application-terminal-interaction-controller.ts";
import { retainsAgentControl } from "./application-retained-agent.ts";
import {
  createApplicationHomeAgentNavigator,
  type HomeAgentNavigationSource,
  type HomeAgentNavigationTarget,
} from "./application-home-agent-navigation.ts";
import { applicationGenerationNavigationKey } from "./application-generation-starter.ts";
import {
  agentOpeningOwnsKey,
  waitForHomeAgentListed,
  waitForHomeAgentSemantic,
} from "./application-home-agents-owner.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

type HomeNavigatorOptions = Parameters<typeof createApplicationHomeAgentNavigator>[0];

/** Machine identity fences the existing exact-agent admission owner. No independent input path. */
export function createApplicationMachineAgentNavigator(options: {
  readonly isCurrentTarget: (machineId: string, target: HomeAgentNavigationTarget) => boolean;
  /** `isCurrentTarget` once the machine's roster has finished a re-read in progress. */
  readonly waitForCurrentTarget?: (
    machineId: string,
    target: HomeAgentNavigationTarget,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly selectedMachineId: () => string | null;
  /** Identity of the attached generation, never inferred from the selected machine. */
  readonly generationMachineId: () => string | null;
  readonly generation: () => OpenTuiGenerationHostSnapshot | null;
  readonly sessionName: () => string | null;
  readonly startGeneration: HomeNavigatorOptions["startGeneration"];
  /** The interaction controller's selectPane: `admission` must reach it (#764). */
  readonly selectPane: (
    paneId: string,
    admission?: Promise<boolean>,
  ) => void | Promise<AdmittedPaneSelectionOutcome>;
  readonly showTerminals: HomeNavigatorOptions["showTerminals"];
  readonly setNote: HomeNavigatorOptions["setNote"];
}) {
  let current: ReturnType<typeof createApplicationHomeAgentNavigator> | null = null;
  let disposed = false;
  let opening = false;
  let request = 0;
  const cancel = () => {
    request++;
    opening = false;
    current?.cancel();
  };
  return {
    open(
      machineId: string,
      target: HomeAgentNavigationTarget,
      source: HomeAgentNavigationSource = "mouse",
    ) {
      current?.dispose();
      const token = ++request;
      if (disposed) return Promise.resolve({ opened: false, failure: "superseded" as const });
      opening = true;
      const selected = () => options.selectedMachineId() === machineId;
      const generation = () =>
        selected() && options.generationMachineId() === machineId ? options.generation() : null;
      if (
        selected() &&
        options.isCurrentTarget(machineId, target) &&
        options.sessionName() === target.sessionName &&
        retainsAgentControl(generation(), target)
      ) {
        // Reserve before the next key; the terminal controller waits for a fresh
        // coherent runtime and remains the only owner of physical input.
        options.selectPane(target.paneId!);
        options.showTerminals(source);
        options.setNote(null);
        opening = false;
        return Promise.resolve({ opened: true });
      }
      current = createApplicationHomeAgentNavigator({
        isCurrentTarget: (row) => selected() && options.isCurrentTarget(machineId, row),
        currentGeneration() {
          const attached = generation();
          const generationKey = applicationGenerationNavigationKey(attached);
          const semantic = attached?.client?.getSnapshot().semantic;
          const sessionName = options.sessionName();
          if (!generationKey || !attached?.daemonGeneration || !semantic || !sessionName)
            return null;
          return {
            generationKey,
            daemonInstanceId: attached.daemonGeneration,
            liveSessionId: attached.connection?.liveSessionId ?? null,
            sessionName,
            agents: semantic.sidebar.agents,
          };
        },
        ...(options.waitForCurrentTarget
          ? {
              waitForCurrentTarget: (row: HomeAgentNavigationTarget, signal: AbortSignal) =>
                selected()
                  ? options.waitForCurrentTarget!(machineId, row, signal)
                  : Promise.resolve(false),
            }
          : {}),
        waitForGeneration: (key, signal) => waitForHomeAgentSemantic(generation, key, signal),
        waitForAgent: (key, listed, signal) =>
          waitForHomeAgentListed(generation, key, listed, signal),
        startGeneration: (session, prepared, origin, focus, admission) =>
          options.startGeneration(
            session,
            prepared,
            origin,
            focus,
            () =>
              selected() && options.isCurrentTarget(machineId, target) && (admission?.() ?? true),
          ),
        selectPane: (paneId, _source, admission) =>
          admission ? options.selectPane(paneId, admission) : options.selectPane(paneId),
        showTerminals: options.showTerminals,
        setNote: options.setNote,
      });
      return current.open(target, source).finally(() => {
        if (token === request) opening = false;
      });
    },
    opening: () => opening,
    cancel,
    /** Esc cancels an open in progress; other keys are ignored meanwhile. */
    ownsKey: (name: string) => agentOpeningOwnsKey(name, { opening: () => opening, cancel }),
    dispose() {
      disposed = true;
      request++;
      opening = false;
      current?.dispose();
      current = null;
    },
  };
}
