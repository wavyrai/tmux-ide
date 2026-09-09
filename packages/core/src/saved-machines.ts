import {
  LOCAL_MACHINE_ID,
  SavedMachineIdSchema,
  SavedMachineRegistrySchema,
  type SavedMachine,
  type SavedMachineRegistry,
} from "@tmux-ide/contracts";

export type SavedMachineChange =
  | { type: "add"; machine: SavedMachine }
  | {
      type: "update";
      id: string;
      patch: Partial<Pick<SavedMachine, "label" | "sshTarget" | "enabled">>;
    }
  | { type: "remove"; id: string };

/** Pure reducer: IDs survive renames/endpoint edits and are never derived from labels. */
export function changeSavedMachines(
  value: SavedMachineRegistry,
  change: SavedMachineChange,
): SavedMachineRegistry {
  const registry = SavedMachineRegistrySchema.parse(value);
  if (change.type === "add") {
    return SavedMachineRegistrySchema.parse({
      ...registry,
      machines: [...registry.machines, change.machine],
    });
  }
  const id = SavedMachineIdSchema.parse(change.id);
  if (!registry.machines.some((machine) => machine.id === id))
    throw new Error("Saved machine not found");
  return SavedMachineRegistrySchema.parse({
    ...registry,
    machines:
      change.type === "remove"
        ? registry.machines.filter((machine) => machine.id !== id)
        : registry.machines.map((machine) =>
            machine.id === id ? { ...machine, ...change.patch, id } : machine,
          ),
  });
}

/** Collision-free composite identity; resource IDs remain opaque to the registry. */
export function machineResourceKey(
  machineId: string,
  kind: "session" | "pane" | "agent",
  resourceId: string,
): string {
  const id = machineId === LOCAL_MACHINE_ID ? machineId : SavedMachineIdSchema.parse(machineId);
  if (!resourceId || resourceId.length > 1024) throw new Error("Invalid machine resource ID");
  return JSON.stringify([id, kind, resourceId]);
}
