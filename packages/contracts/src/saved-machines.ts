import { z } from "zod";

export const LOCAL_MACHINE_ID = "local" as const;
export const MAX_SAVED_MACHINES = 64;
export const SavedMachineIdSchema = z.uuid().transform((id) => id.toLowerCase());

// A destination is an SSH config alias or [user@]host, never shell syntax or options.
// Ports, keys and jump hosts belong in the user's SSH config, not this registry.
const SshTargetSchema = z
  .string()
  .max(255)
  .regex(
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*|\[[A-Fa-f0-9:]+\])$/u,
    "Expected an SSH alias or [user@]host",
  );
export const SavedMachineSchema = z.strictObject({
  id: SavedMachineIdSchema,
  label: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  sshTarget: SshTargetSchema,
  enabled: z.boolean().default(true),
});
export type SavedMachine = z.infer<typeof SavedMachineSchema>;

export const SavedMachineRegistrySchema = z
  .strictObject({
    version: z.literal(1),
    machines: z.array(SavedMachineSchema).max(MAX_SAVED_MACHINES),
  })
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const labels = new Set<string>(["local"]);
    registry.machines.forEach((machine, index) => {
      const label = machine.label.normalize("NFKC").toLowerCase();
      if (ids.has(machine.id) || labels.has(label)) {
        context.addIssue({
          code: "custom",
          path: ["machines", index],
          message: "Machine IDs and labels must be unique; Local is reserved",
        });
      }
      ids.add(machine.id);
      labels.add(label);
    });
  });
export type SavedMachineRegistry = z.infer<typeof SavedMachineRegistrySchema>;
