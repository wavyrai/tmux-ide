import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { HomeAgentNavigationTarget } from "./application-home-agent-navigation.ts";

/** Selection intent may wait on this exact retained control; input cannot use it yet. */
export function retainsAgentControl(
  active: OpenTuiGenerationHostSnapshot | null,
  target: HomeAgentNavigationTarget,
): boolean {
  if (
    active?.status !== "rebinding" ||
    !active.client ||
    !target.paneId ||
    active.daemonGeneration !== target.daemonInstanceId ||
    active.connection?.workspaceName !== target.sessionName ||
    active.connection.liveSessionId !== target.liveSessionId
  )
    return false;
  try {
    const state = active.client.getSnapshot();
    return (
      Number.isSafeInteger(state.generation) &&
      state.semantic?.sidebar.agents.some(
        (agent) => agent.id === target.agentId && agent.paneId === target.paneId,
      ) === true
    );
  } catch {
    return false;
  }
}
