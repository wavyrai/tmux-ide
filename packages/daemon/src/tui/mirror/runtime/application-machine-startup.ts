import { randomUUID } from "node:crypto";
import { SavedMachineSchema, type SavedMachine } from "@tmux-ide/contracts";
import { loadSavedMachines } from "../../../lib/saved-machines.ts";
import { applicationMachineAuthorityManager } from "./application-machine-authority.ts";

/** Labels describe access routes; they never become routing identities. */
export function ephemeralMachineProfile(
  alias: string,
  existing: readonly SavedMachine[],
): SavedMachine {
  const target = SavedMachineSchema.shape.sshTarget.parse(alias);
  const base = target.slice(0, 70);
  const labels = new Set([
    "local",
    "this mac",
    "this machine",
    ...existing.map((p) => p.label.normalize("NFKC").toLowerCase()),
  ]);
  let label = base;
  for (let suffix = 2; labels.has(label.normalize("NFKC").toLowerCase()); suffix++)
    label = `${base} (${suffix})`;
  return SavedMachineSchema.parse({ id: randomUUID(), label, sshTarget: target, enabled: true });
}

/** Local discovery and rendering never wait for any remote handshake. */
export function initializeApplicationMachines(aliases: readonly string[]): void {
  const profiles = [...loadSavedMachines().machines];
  let preferred: string | null = null;
  for (const alias of aliases) {
    let profile = profiles.find((p) => p.sshTarget === alias && p.enabled);
    if (!profile) {
      profile = ephemeralMachineProfile(alias, profiles);
      profiles.push(profile);
    }
    preferred ??= profile.id;
  }
  applicationMachineAuthorityManager.initialize(profiles);
  if (preferred) applicationMachineAuthorityManager.select(preferred);
}
