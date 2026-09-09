import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedMachine } from "@tmux-ide/contracts";
const mocks = vi.hoisted(() => ({ load: vi.fn(), initialize: vi.fn(), select: vi.fn() }));
vi.mock("../../../lib/saved-machines.ts", () => ({ loadSavedMachines: mocks.load }));
vi.mock("./application-machine-authority.ts", () => ({
  applicationMachineAuthorityManager: { initialize: mocks.initialize, select: mocks.select },
}));
import {
  ephemeralMachineProfile,
  initializeApplicationMachines,
} from "./application-machine-startup.ts";
const saved: SavedMachine = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  label: "Build",
  sshTarget: "build",
  enabled: true,
};
beforeEach(() => {
  mocks.load.mockReset().mockReturnValue({ version: 1, machines: [] });
  mocks.initialize.mockReset();
  mocks.select.mockReset();
});
describe("simultaneous machine startup", () => {
  it("initializes saved profiles without waiting on remote connections or changing local selection", () => {
    mocks.load.mockReturnValue({ version: 1, machines: [saved] });
    mocks.initialize.mockReturnValue(new Promise(() => {}));
    expect(initializeApplicationMachines([])).toBeUndefined();
    expect(mocks.initialize).toHaveBeenCalledWith([saved]);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("reuses saved aliases, deduplicates repeated arguments, and selects only the first requested machine", () => {
    mocks.load.mockReturnValue({ version: 1, machines: [saved] });
    initializeApplicationMachines(["build", "dev", "build", "dev"]);
    const profiles = mocks.initialize.mock.calls[0]![0] as SavedMachine[];
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual(saved);
    expect(profiles[1]).toMatchObject({ sshTarget: "dev", enabled: true });
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(saved.id);
  });
  it("explicitly requested disabled aliases get a separate enabled ephemeral connection", () => {
    mocks.load.mockReturnValue({ version: 1, machines: [{ ...saved, enabled: false }] });
    initializeApplicationMachines(["build"]);
    const profiles = mocks.initialize.mock.calls[0]![0] as SavedMachine[];
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.enabled).toBe(false);
    expect(profiles[1]!.enabled).toBe(true);
    expect(profiles[1]!.id).not.toBe(saved.id);
    expect(profiles[1]!.label.toLowerCase()).not.toBe("build");
  });
  it("rejects shell syntax before any manager initialization", () => {
    expect(() => initializeApplicationMachines(["build;command"])).toThrow();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("keeps labels bounded and collision-safe without changing SSH targets", () => {
    expect(ephemeralMachineProfile("Local", [])).toMatchObject({
      label: "Local (2)",
      sshTarget: "Local",
    });
    const alias = "a".repeat(200);
    const one = ephemeralMachineProfile(alias, []);
    const two = ephemeralMachineProfile(alias, [one]);
    expect(one.sshTarget).toBe(alias);
    expect(two.sshTarget).toBe(alias);
    expect(one.label.length).toBeLessThanOrEqual(80);
    expect(two.label).not.toBe(one.label);
    expect(two.id).not.toBe(one.id);
  });
  it("does not silently reset corrupt saved profiles", () => {
    mocks.load.mockImplementation(() => {
      throw new Error("corrupt registry");
    });
    expect(() => initializeApplicationMachines([])).toThrow("corrupt registry");
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
});
