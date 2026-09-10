import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";
import type { ActionResult, WorkspaceSessionKillArguments } from "@tmux-ide/contracts";
import {
  applicationDaemonEndpoint,
  readApplicationDaemonInfo as readCanonicalDaemonInfo,
} from "./application-daemon-authority.ts";
import { randomUUID } from "node:crypto";
import type {
  FleetAgentMutateArguments,
  FleetAgentMutateResult,
  FleetAgentProvisionArguments,
  FleetAgentProvisionResult,
  WorkspaceSessionCreateArguments,
  WorkspaceSessionCreateResult,
} from "@tmux-ide/contracts";
import { dispatchOwnerAction } from "@tmux-ide/daemon-client/owner-action-client";

import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";

const HOST_CLIENT_ID = `opentui:${process.pid}`;

async function dispatch<
  Name extends "workspace.session.create" | "fleet.agent.mutate" | "fleet.agent.provision",
>(
  name: Name,
  input: Name extends "workspace.session.create"
    ? WorkspaceSessionCreateArguments
    : Name extends "fleet.agent.mutate"
      ? FleetAgentMutateArguments
      : FleetAgentProvisionArguments,
): Promise<
  Name extends "workspace.session.create"
    ? WorkspaceSessionCreateResult | null
    : Name extends "fleet.agent.mutate"
      ? FleetAgentMutateResult | null
      : FleetAgentProvisionResult | null
> {
  const machineEpoch = applicationDaemonEndpoint().epoch;
  const daemon = readCanonicalDaemonInfo();
  if (!daemon?.authToken) return null as never;
  const result = await dispatchOwnerAction({
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken,
    hostClientId: HOST_CLIENT_ID,
    name,
    input: input as never,
    operationId: randomUUID(),
    timeoutMs: 15_000,
  });
  return (applicationDaemonEndpoint().epoch === machineEpoch ? result : null) as never;
}

type FleetHandle = Pick<ApplicationMachineAuthorityHandle, "read" | "endpoint">;
export interface FleetSessionCloseTarget {
  readonly daemonInstanceId: string;
  readonly liveSessionId: string;
  readonly sessionName: string;
  readonly workspaceName?: string;
}

async function dispatchOnHandle<Name extends "workspace.session.create" | "workspace.session.kill">(
  handle: FleetHandle,
  name: Name,
  input: Name extends "workspace.session.create"
    ? WorkspaceSessionCreateArguments
    : WorkspaceSessionKillArguments,
): Promise<ActionResult<Name> | null> {
  const daemon = handle.read();
  const epoch = handle.endpoint().epoch;
  if (!daemon?.authToken || handle.endpoint().state !== "ready") return null;
  const result = await dispatchOwnerAction({
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken,
    // A passive close has no attached transport controller. The authenticated
    // owner lane remains responsible for serialization and idempotency.
    ...(name === "workspace.session.create" ? { hostClientId: HOST_CLIENT_ID } : {}),
    name,
    input: input as never,
    operationId: randomUUID(),
    timeoutMs: 15_000,
  });
  const current = handle.read();
  return handle.endpoint().epoch === epoch &&
    current?.instanceId === daemon.instanceId &&
    current.startedAt === daemon.startedAt &&
    result?.daemonInstanceId === daemon.instanceId
    ? result
    : null;
}

export function createFleetSession(
  input: WorkspaceSessionCreateArguments | FleetHandle,
  name?: string,
): Promise<WorkspaceSessionCreateResult | null> {
  if ("read" in input) {
    const daemon = input.read();
    if (!daemon || !name) return Promise.resolve(null);
    return dispatchOnHandle(input, "workspace.session.create", {
      displayName: name,
      expectedDaemonInstanceId: daemon.instanceId,
    });
  }
  return dispatch("workspace.session.create", input);
}

/** Call only after confirmation of this exact host/session target. */
export function closeFleetSession(
  handle: FleetHandle,
  target: FleetSessionCloseTarget,
): Promise<ActionResult<"workspace.session.kill"> | null> {
  if (handle.read()?.instanceId !== target.daemonInstanceId) return Promise.resolve(null);
  return dispatchOnHandle(handle, "workspace.session.kill", {
    workspaceName: target.workspaceName ?? target.sessionName,
    fleetTarget: {
      daemonInstanceId: target.daemonInstanceId,
      liveSessionId: target.liveSessionId,
      sessionName: target.sessionName,
    },
  });
}

export function mutateFleetAgent(
  input: FleetAgentMutateArguments,
): Promise<FleetAgentMutateResult | null> {
  return dispatch("fleet.agent.mutate", input);
}

export function provisionFleetAgent(
  input: FleetAgentProvisionArguments,
): Promise<FleetAgentProvisionResult | null> {
  return dispatch("fleet.agent.provision", input);
}
