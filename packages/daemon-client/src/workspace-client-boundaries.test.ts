import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(packageRoot, "..", "..");
const productionSources = readdirSync(join(packageRoot, "src"))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => [name, readFileSync(join(packageRoot, "src", name), "utf8")] as const);

describe("daemon-client dependency direction", () => {
  it("keeps the WorkspaceClient kernel renderer and host neutral", () => {
    const forbidden = [
      "@opentui/",
      "solid-js",
      "electron",
      "node:fs",
      "node:child_process",
      "packages/daemon/src",
      "@tmux-ide/tmux-bridge",
      "process.env",
    ];
    const kernel = productionSources.filter(([name]) => name.startsWith("workspace-client"));
    for (const [name, source] of kernel) {
      for (const specifier of forbidden) {
        expect(source, `${name} imports or reads ${specifier}`).not.toContain(specifier);
      }
    }
  });

  it("permits daemon-client -> core while forbidding the reverse edge", () => {
    const coreSources = readdirSync(join(workspaceRoot, "packages", "core", "src"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => readFileSync(join(workspaceRoot, "packages", "core", "src", name), "utf8"));
    expect(productionSources.some(([, source]) => source.includes('from "@tmux-ide/core"'))).toBe(
      true,
    );
    for (const source of coreSources) expect(source).not.toContain("@tmux-ide/daemon-client");
  });
});
