import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSavedMachines, updateSavedMachines } from "./saved-machines.ts";
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
