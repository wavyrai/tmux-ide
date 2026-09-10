import { SavedMachineRegistrySchema, type SavedMachine } from "@tmux-ide/contracts/saved-machines";
import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "./canonical-daemon.ts";

/** Intentional local registry mutation. Never uses selected-machine authority. */
export async function saveMachineProfiles(machines: readonly SavedMachine[]) {
  const registry = SavedMachineRegistrySchema.parse({ version: 1, machines });
  const daemon = readCanonicalDaemonInfo();
  if (!daemon?.authToken || !(await isCanonicalDaemonAlive(daemon)))
    throw new Error("Start a local tmux-ide daemon to save machine profiles.");
  try {
    const response = await fetch(
      canonicalDaemonUrl("http", daemon.bindHostname, daemon.port) +
        "/api/resources/saved-machines",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${daemon.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedInstanceId: daemon.instanceId, registry }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const body = (await response.json()) as {
      daemon?: { instanceId?: string; startedAt?: string };
      registry?: unknown;
    };
    if (body.daemon?.instanceId !== daemon.instanceId || body.daemon.startedAt !== daemon.startedAt)
      throw new Error();
    return SavedMachineRegistrySchema.parse(body.registry);
  } catch {
    throw new Error(
      "Machine profiles could not be saved. Update the local daemon and check for conflicting profiles.",
    );
  }
}
