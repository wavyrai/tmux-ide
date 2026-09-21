import {
  createApplicationHomeAgentNavigator,
  type HomeAgentNavigationSource,
  type HomeAgentNavigationTarget,
} from "./application-home-agent-navigation.ts";
import { applicationGenerationNavigationKey } from "./application-generation-starter.ts";
import { waitForHomeAgentSemantic } from "./application-home-agents-owner.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

type HomeNavigatorOptions = Parameters<typeof createApplicationHomeAgentNavigator>[0];

/** Machine identity fences the existing exact-agent admission owner. No independent input path. */
export function createApplicationMachineAgentNavigator(options: {
  readonly isCurrentTarget: (machineId: string, target: HomeAgentNavigationTarget) => boolean;
  readonly selectedMachineId: () => string | null;
  /** Identity of the attached generation, never inferred from the selected machine. */
  readonly generationMachineId: () => string | null;
  readonly generation: () => OpenTuiGenerationHostSnapshot | null;
  readonly sessionName: () => string | null;
  readonly startGeneration: HomeNavigatorOptions["startGeneration"];
  readonly selectPane: HomeNavigatorOptions["selectPane"];
  readonly showTerminals: HomeNavigatorOptions["showTerminals"];
  readonly setNote: HomeNavigatorOptions["setNote"];
}) {
  let current: ReturnType<typeof createApplicationHomeAgentNavigator> | null = null;
  let disposed = false;
  let opening = false;
  let request = 0;
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
        waitForGeneration: (key, signal) => waitForHomeAgentSemantic(generation, key, signal),
        startGeneration: (session, prepared, origin, focus, admission) =>
          options.startGeneration(
            session,
            prepared,
            origin,
            focus,
            () =>
              selected() && options.isCurrentTarget(machineId, target) && (admission?.() ?? true),
          ),
        selectPane: options.selectPane,
        showTerminals: options.showTerminals,
        setNote: options.setNote,
      });
      return current.open(target, source).finally(() => {
        if (token === request) opening = false;
      });
    },
    opening: () => opening,
    cancel() {
      request++;
      opening = false;
      current?.cancel();
    },
    dispose() {
      disposed = true;
      request++;
      opening = false;
      current?.dispose();
      current = null;
    },
  };
}
