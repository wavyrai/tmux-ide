import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const daemonSrc = join(import.meta.dirname, "../..");

describe("terminal replica architecture", () => {
  it("keeps the new canonical xterm parser daemon-owned and singular", () => {
    const imports = sourceFiles(daemonSrc)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes('from "@xterm/headless"'))
      .map((file) => file.slice(daemonSrc.length + 1));
    expect(imports).toEqual([
      "terminal/session-runtime/terminal-replica-interpreter.ts",
      "tui/mirror/pane-mirror.ts",
    ]);
  });

  it("keeps shadow projections out of production GUI/OpenTUI imports", () => {
    const consumers = sourceFiles(daemonSrc)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("terminal-replica-shadow-projections"));
    expect(consumers).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
