import type { HostCapabilities } from "@tmux-ide/contracts";

/** Only invoked for an explicitly selected fleet session, never background discovery. */
export async function openSelectedWorkspace(
  daemon: Pick<HostCapabilities["daemon"], "fetchWorkspaceCatalog" | "promoteWorkspace">,
  expectedInstanceId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const catalog = await daemon.fetchWorkspaceCatalog();
  signal?.throwIfAborted();
  if (catalog.status !== "ok" || catalog.envelope.daemon.instanceId !== expectedInstanceId)
    throw new Error("The machine connection changed. Select the session again.");
  const session = catalog.envelope.liveSessions.find((item) => item.fleetSessionId === sessionId);
  if (!session) throw new Error("This session is no longer available on this machine.");
  const intent = catalog.envelope.intents.find(
    (item) => item.sessionName === session.sessionName && item.availability === "live",
  );
  if (intent) return intent.workspaceName;
  const result = await daemon.promoteWorkspace({ sessionId });
  signal?.throwIfAborted();
  if (result.status !== "ok")
    throw new Error("Could not open this session as a workspace. Try again.");
  if (result.result.daemonInstanceId !== expectedInstanceId)
    throw new Error("The machine connection changed while opening this session.");
  return result.result.resource.workspaceName;
}
