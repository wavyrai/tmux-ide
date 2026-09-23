import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTmuxServerRegistrations,
  writeTmuxServerRegistrations,
} from "./tmux-server-registration.ts";
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function file() {
  const directory = mkdtempSync(join(tmpdir(), "tmux-server-registration-"));
  directories.push(directory);
  return join(directory, "tmux-servers.json");
}
const entry = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  label: "Build",
  selector: { kind: "name" as const, name: "build" },
};
describe("server registration persistence", () => {
  it("preserves stable opaque identities and private selectors with restricted permissions", () => {
    const path = file();
    expect(readTmuxServerRegistrations(path)).toEqual([]);
    writeTmuxServerRegistrations(path, [entry]);
    expect(readTmuxServerRegistrations(path)).toEqual([entry]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, "utf8");
    expect(() => writeTmuxServerRegistrations(path, [entry, entry])).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it("refuses corrupt saved intent rather than silently resetting it", () => {
    const path = file();
    writeFileSync(path, "{broken");
    expect(() => readTmuxServerRegistrations(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{broken");
  });
});
