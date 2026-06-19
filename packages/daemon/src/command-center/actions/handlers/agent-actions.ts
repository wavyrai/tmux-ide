// Host-level agent actions — a Claude/codex SessionStart hook (or any plain
// terminal session) self-reports here so the daemon can surface it alongside
// tmux-discovered agents at GET /api/agents. NOT project-scoped: the registry
// is per-host, keyed by the hook-supplied id (typically the Claude session id).
import {
  ExternalAgentRegistry,
  getDefaultExternalAgentRegistry,
} from "../../../lib/agent-registry.ts";
import type { ActionInput, ActionResult } from "../contract.ts";

export interface AgentActionDeps {
  /** Override the registry (tests). Defaults to the daemon-wide singleton. */
  registry?: ExternalAgentRegistry;
}

function registryFrom(deps: AgentActionDeps): ExternalAgentRegistry {
  return deps.registry ?? getDefaultExternalAgentRegistry();
}

export function agentRegisterHandler(
  input: ActionInput<"agent.register">,
  deps: AgentActionDeps = {},
): ActionResult<"agent.register"> {
  registryFrom(deps).register(input);
  return { ok: true };
}

export function agentHeartbeatHandler(
  input: ActionInput<"agent.heartbeat">,
  deps: AgentActionDeps = {},
): ActionResult<"agent.heartbeat"> {
  const known = registryFrom(deps).heartbeat(input);
  return { ok: true, known };
}

export function agentUnregisterHandler(
  input: ActionInput<"agent.unregister">,
  deps: AgentActionDeps = {},
): ActionResult<"agent.unregister"> {
  const removed = registryFrom(deps).unregister(input.id);
  return { ok: true, removed };
}
