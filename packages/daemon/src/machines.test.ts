import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  registry: {
    version: 1 as const,
    machines: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "Build host",
        sshTarget: "builder",
        enabled: true,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        label: "Other",
        sshTarget: "other",
        enabled: true,
      },
    ],
  },
  mutate: vi.fn(),
}));
vi.mock("./lib/saved-machines.ts", () => ({ loadSavedMachines: () => state.registry }));
vi.mock("./lib/local-fleet-request.ts", () => ({ mutateMachineProfile: state.mutate }));
import { machines } from "./machines.ts";
beforeEach(() => {
  state.mutate.mockReset();
});

it("previews disable by label without writing or touching the other machine", async () => {
  const result = await machines("disable", "BUILD HOST", {});
  expect(result).toMatchObject({
    written: false,
    registry: {
      machines: [{ ...state.registry.machines[0], enabled: false }, state.registry.machines[1]],
    },
  });
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.registry.machines[0]?.enabled).toBe(true);
});
it.each(["enable", "disable", "remove"])(
  "writes %s only through the local registry owner",
  async (operation) => {
    state.mutate.mockResolvedValue({ version: 1, machines: [] });
    const result = await machines(operation, state.registry.machines[0]!.id, { write: true });
    expect(state.mutate).toHaveBeenCalledWith({ id: state.registry.machines[0]!.id, operation });
    expect(result).toMatchObject({ written: true });
  },
);
it("rejects missing and local targets before a mutation", async () => {
  for (const target of ["missing", "local"])
    await expect(machines("remove", target, { write: true })).rejects.toThrow("not found");
  expect(state.mutate).not.toHaveBeenCalled();
});

it("previews route edits and keeps the stable ID and unrelated profiles", async () => {
  const result = await machines("edit", "Build host", {
    label: "Renamed",
    sshTarget: "new-builder",
  });
  expect(result).toMatchObject({
    written: false,
    registry: {
      machines: [
        { ...state.registry.machines[0], label: "Renamed", sshTarget: "new-builder" },
        state.registry.machines[1],
      ],
    },
  });
  expect(state.mutate).not.toHaveBeenCalled();
  await machines("edit", "Build host", { label: "Renamed", write: true });
  expect(state.mutate).toHaveBeenCalledWith({
    id: state.registry.machines[0]!.id,
    operation: "edit",
    patch: { label: "Renamed" },
  });
});
it("rejects empty, conflicting and invalid route edits without writing", async () => {
  for (const options of [
    {},
    { label: "Other" },
    { label: "Local" },
    { sshTarget: "-oProxyCommand=bad" },
  ])
    await expect(machines("edit", "Build host", { ...options, write: true })).rejects.toThrow();
  expect(state.mutate).not.toHaveBeenCalled();
});
