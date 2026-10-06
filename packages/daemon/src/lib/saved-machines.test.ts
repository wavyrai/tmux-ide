import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSavedMachines, updateSavedMachines, watchSavedMachines } from "./saved-machines.ts";
const dirs: string[] = [];
const machine = {
  id: "a1ea9939-7496-4a45-bae2-7e611aecc011",
  label: "Build host",
  sshTarget: "build",
  enabled: true,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "saved-machines-"));
  dirs.push(dir);
  return { dir, path: join(dir, "machines.json") };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("saved machine persistence", () => {
  it("subscribes before the registry directory exists", async () => {
    const { dir } = fixture();
    const path = join(dir, "first-run", "machines.json");
    const changed = vi.fn();
    const stop = watchSavedMachines(changed, vi.fn(), path);
    try {
      updateSavedMachines({ type: "add", machine }, path);
      await vi.waitFor(() =>
        expect(changed).toHaveBeenLastCalledWith({ version: 1, machines: [machine] }),
      );
    } finally {
      stop();
    }
  });
  it("follows atomic edits, preserves valid state on corruption, and stops observing on cleanup", async () => {
    const { path } = fixture();
    const changed = vi.fn();
    const failed = vi.fn();
    const stop = watchSavedMachines(changed, failed, path);
    try {
      updateSavedMachines({ type: "add", machine }, path);
      await vi.waitFor(() =>
        expect(changed).toHaveBeenLastCalledWith({ version: 1, machines: [machine] }),
      );
      writeFileSync(path, "{broken");
      await vi.waitFor(() => expect(failed).toHaveBeenCalled());
      expect(changed).toHaveBeenLastCalledWith({ version: 1, machines: [machine] });
      writeFileSync(path, JSON.stringify({ version: 1, machines: [machine] }));
      updateSavedMachines({ type: "update", id: machine.id, patch: { enabled: false } }, path);
      await vi.waitFor(() =>
        expect(changed).toHaveBeenLastCalledWith({
          version: 1,
          machines: [{ ...machine, enabled: false }],
        }),
      );
      stop();
      changed.mockClear();
      updateSavedMachines({ type: "update", id: machine.id, patch: { enabled: true } }, path);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(changed).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
  it("round trips atomic private writes while preserving unrelated configuration", () => {
    const { dir, path } = fixture();
    writeFileSync(join(dir, "config.json"), '{"legacy":true}');
    expect(loadSavedMachines(path)).toEqual({ version: 1, machines: [] });
    updateSavedMachines({ type: "add", machine }, path);
    updateSavedMachines({ type: "update", id: machine.id, patch: { label: "Renamed" } }, path);
    expect(loadSavedMachines(path).machines[0]).toEqual({ ...machine, label: "Renamed" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe('{"legacy":true}');
    expect(readdirSync(dir).sort()).toEqual(["config.json", "machines.json"]);
  });
  it("never overwrites malformed, unsupported or oversized registry data", () => {
    const { dir, path } = fixture();
    for (const contents of ["{broken", '{"version":2,"machines":[]}', " ".repeat(65537)]) {
      writeFileSync(path, contents);
      expect(() => updateSavedMachines({ type: "add", machine }, path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(readdirSync(dir)).toEqual(["machines.json"]);
    }
  });
  it("rejects invalid changes before creating any temporary file", () => {
    const { dir, path } = fixture();
    updateSavedMachines({ type: "add", machine }, path);
    const original = readFileSync(path, "utf8");
    expect(() => updateSavedMachines({ type: "add", machine }, path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(dir)).toEqual(["machines.json"]);
  });
});

it("imports the same identity through different per-computer aliases and never partially overwrites", async () => {
  const { mergeSavedMachines } = await import("./saved-machines.ts");
  const a = fixture(),
    b = fixture();
  const expectedEnvironmentId = "11111111-1111-4111-8111-111111111111";
  const profile = { ...machine, expectedEnvironmentId };
  mergeSavedMachines({ version: 1, machines: [profile] }, a.path);
  mergeSavedMachines(
    { version: 1, machines: [{ ...profile, sshTarget: "build-from-mini" }] },
    b.path,
  );
  expect(loadSavedMachines(a.path).machines[0].expectedEnvironmentId).toBe(
    loadSavedMachines(b.path).machines[0].expectedEnvironmentId,
  );
  const before = readFileSync(a.path, "utf8");
  expect(() =>
    mergeSavedMachines(
      {
        version: 1,
        machines: [
          { ...machine, id: "22222222-2222-4222-8222-222222222222", label: "New" },
          { ...profile, sshTarget: "wrong-host" },
        ],
      },
      a.path,
    ),
  ).toThrow(/conflicts/);
  expect(readFileSync(a.path, "utf8")).toBe(before);
  mergeSavedMachines({ version: 1, machines: [profile] }, a.path);
  expect(readFileSync(a.path, "utf8")).toBe(before);
});
