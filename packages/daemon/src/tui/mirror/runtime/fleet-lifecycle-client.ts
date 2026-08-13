import { randomUUID } from "node:crypto";
import type {
  FleetAgentMutateArguments,
  FleetAgentMutateResult,
  WorkspaceSessionCreateArguments,
  WorkspaceSessionCreateResult,
} from "@tmux-ide/contracts";
import { dispatchOwnerAction } from "@tmux-ide/daemon-client/owner-action-client";

import { canonicalDaemonUrl, readCanonicalDaemonInfo } from "../../../lib/canonical-daemon.ts";

const HOST_CLIENT_ID = `opentui:${process.pid}`;

async function dispatch<Name extends "workspace.session.create" | "fleet.agent.mutate">(
  name: Name,
  input: Name extends "workspace.session.create"
    ? WorkspaceSessionCreateArguments
    : FleetAgentMutateArguments,
): Promise<
  Name extends "workspace.session.create"
    ? WorkspaceSessionCreateResult | null
    : FleetAgentMutateResult | null
> {
  const daemon = readCanonicalDaemonInfo();
  if (!daemon?.authToken) return null as never;
  return (await dispatchOwnerAction({
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken,
    hostClientId: HOST_CLIENT_ID,
    name,
    input: input as never,
    operationId: randomUUID(),
    timeoutMs: 15_000,
  })) as never;
}

export function createFleetSession(
  input: WorkspaceSessionCreateArguments,
): Promise<WorkspaceSessionCreateResult | null> {
  return dispatch("workspace.session.create", input);
}

export function mutateFleetAgent(
  input: FleetAgentMutateArguments,
): Promise<FleetAgentMutateResult | null> {
  return dispatch("fleet.agent.mutate", input);
}
