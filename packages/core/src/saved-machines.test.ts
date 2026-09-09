import { describe, expect, it } from "vitest";
import { SavedMachineRegistrySchema } from "@tmux-ide/contracts";
import { changeSavedMachines, machineResourceKey } from "./saved-machines.ts";
const id = "a1ea9939-7496-4a45-bae2-7e611aecc011";
const other = "a1ea9939-7496-4a45-bae2-7e611aecc012";
const machine = { id, label: "Build host", sshTarget: "dev@build", enabled: true };
const initial = { version: 1 as const, machines: [machine] };
describe("saved machine identity", () => {
  it("preserves identity through edits and leaves the original immutable", () => {
    const result = changeSavedMachines(initial, {
      type: "update",
      id,
      patch: { label: "New name", enabled: false },
    });
    expect(result.machines[0]).toEqual({ ...machine, label: "New name", enabled: false });
    expect(initial.machines[0]).toEqual(machine);
    expect(changeSavedMachines(result, { type: "remove", id }).machines).toEqual([]);
    expect(() => changeSavedMachines(result, { type: "remove", id: other })).toThrow("not found");
  });
  it("rejects collisions, reserved Local labels, credentials, unknown versions and excess records", () => {
    for (const extra of [
      { ...machine },
      { ...machine, id: other, label: "BUILD HOST" },
      { ...machine, id: other, label: "Local" },
    ]) {
      expect(() => changeSavedMachines(initial, { type: "add", machine: extra })).toThrow();
    }
    expect(() => SavedMachineRegistrySchema.parse({ ...initial, version: 2 })).toThrow();
    expect(() =>
      SavedMachineRegistrySchema.parse({
        version: 1,
        machines: Array.from({ length: 65 }, (_, index) => ({
          ...machine,
          id: `a1ea9939-7496-4a45-bae2-${index.toString(16).padStart(12, "0")}`,
          label: `Host ${index}`,
        })),
      }),
    ).toThrow();
    for (const field of ["password", "privateKey", "token"]) {
      expect(() =>
        SavedMachineRegistrySchema.parse({
          ...initial,
          machines: [{ ...machine, [field]: "secret" }],
        }),
      ).toThrow();
    }
    expect(() => changeSavedMachines(initial, { type: "remove", id: "local" })).toThrow();
  });
  it("accepts SSH aliases and destinations without allowing command or credential syntax", () => {
    for (const sshTarget of ["work", "user@server.example", "user@[::1]"]) {
      expect(
        SavedMachineRegistrySchema.parse({ ...initial, machines: [{ ...machine, sshTarget }] })
          .machines[0]?.sshTarget,
      ).toBe(sshTarget);
    }
    for (const sshTarget of [
      "-oProxyCommand=evil",
      "host;cmd",
      "host\ncmd",
      "ssh://host",
      "user:password@host",
      "host command",
      "$(command)",
    ]) {
      expect(() =>
        SavedMachineRegistrySchema.parse({ ...initial, machines: [{ ...machine, sshTarget }] }),
      ).toThrow();
    }
  });
  it("namespaces identical tmux IDs across machines and resource kinds", () => {
    const keys = [
      machineResourceKey("local", "pane", "%1"),
      machineResourceKey(id, "pane", "%1"),
      machineResourceKey(other, "pane", "%1"),
      machineResourceKey(id, "session", "%1"),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(machineResourceKey(id.toUpperCase(), "pane", "%1")).toBe(keys[1]);
  });
});
