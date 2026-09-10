import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SavedMachineRegistrySchema, SavedMachineSchema } from "@tmux-ide/contracts/saved-machines";
import { loadSavedMachines, planSavedMachineMerge } from "./lib/saved-machines.ts";
import { loadFleetClientState } from "./lib/fleet-client-state.ts";
import { saveMachineProfiles } from "./lib/local-fleet-request.ts";

export async function machines(
  command: string | undefined,
  argument: string | undefined,
  options: { write?: boolean; label?: string },
) {
  const current = loadSavedMachines();
  if (command === "start" && argument) {
    SavedMachineSchema.shape.sshTarget.parse(argument);
    if (!options.write)
      return {
        written: false,
        command: ["ssh", "--", argument, "tmux-ide", "update", "--daemon", "--json"],
        note: "Repeat with --write to start the installed daemon. No package installation occurs.",
      };
    await (await import("./lib/remote-daemon-lifecycle.ts")).startInstalledRemoteDaemon(argument);
    const transport = await (
      await import("./lib/ssh-daemon-transport.ts")
    ).openSshDaemonTransport({ alias: argument });
    try {
      const expected = current.machines.find(
        (machine) => machine.sshTarget === argument,
      )?.expectedEnvironmentId;
      if (expected && transport.daemon.environmentId !== expected)
        throw new Error("SSH route reached a different environment than the saved profile");
      return {
        written: true,
        status: "ready",
        productVersion: transport.daemon.productVersion,
        environmentId: transport.daemon.environmentId,
      };
    } finally {
      transport.dispose();
    }
  }
  if (command === "export" || command === "ls" || !command) {
    let catalog: ReturnType<typeof loadFleetClientState>["catalog"] = [];
    try {
      catalog = loadFleetClientState().catalog;
    } catch {
      /* Identity hints are optional. */
    }
    return SavedMachineRegistrySchema.parse({
      ...current,
      machines: current.machines.map((machine) => {
        const environmentId = catalog.find((route) => route.routeId === machine.id)?.environmentId;
        return { ...machine, ...(environmentId ? { expectedEnvironmentId: environmentId } : {}) };
      }),
    });
  }
  let incoming;
  if (command === "import" && argument) {
    if (statSync(argument).size > 64 * 1024) throw new Error("Machine directory exceeds 64 KiB");
    incoming = SavedMachineRegistrySchema.parse(JSON.parse(readFileSync(argument, "utf8")));
  } else if (command === "add" && argument) {
    const existing = current.machines.find((machine) => machine.sshTarget === argument);
    incoming = {
      version: 1 as const,
      machines: [
        existing ??
          SavedMachineSchema.parse({
            id: randomUUID(),
            label: options.label ?? argument,
            sshTarget: argument,
            enabled: true,
          }),
      ],
    };
  } else
    throw new Error(
      "Usage: tmux-ide machines ls|export|import <file>|add <alias> [--write] [--json]",
    );
  const preview = planSavedMachineMerge(current, incoming);
  if (!options.write)
    return {
      written: false,
      registry: preview,
      note: "Review SSH aliases for this computer, then repeat with --write. No access is granted by import.",
    };
  return { written: true, registry: await saveMachineProfiles(incoming.machines) };
}
