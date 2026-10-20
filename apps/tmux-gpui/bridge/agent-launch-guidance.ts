import { TmuxServerClientError } from "../../../packages/daemon-client/src/tmux-server-client.ts";
export const GENERIC_PANE_ACTION_ERROR = "Pane action unavailable — reselect pane to retry";
export const AGENT_NOT_READY_ERROR =
  "Agent not ready on this machine — check installation and configuration; reselect this pane to retry or open a shell";
/** Fixed text only: an unavailable harness is not proof that its executable is missing. */
export function agentLaunchGuidance(error: unknown, isAgent: boolean): string {
  return isAgent &&
    error instanceof TmuxServerClientError &&
    error.code === "request-failed" &&
    error.status === 409 &&
    error.refusalCode === "harness_unavailable"
    ? AGENT_NOT_READY_ERROR
    : GENERIC_PANE_ACTION_ERROR;
}
