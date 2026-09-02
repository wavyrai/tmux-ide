import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const daemonSrc = join(import.meta.dirname, "../..");
const daemonRoot = join(daemonSrc, "..");

describe("terminal replica architecture", () => {
  it("keeps the pinned canonical xterm fork daemon-owned and singular", () => {
    const imports = sourceFiles(daemonSrc)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes('from "@tmux-ide/xterm-headless"'))
      .map((file) => file.slice(daemonSrc.length + 1));
    expect(imports).toEqual([
      "terminal/session-runtime/xterm-terminal-interpreter-backend.ts",
      "tui/mirror/pane-mirror.ts",
    ]);
    const stockImports = sourceFiles(daemonSrc)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("@xterm/headless-stock"));
    expect(stockImports).toEqual([]);
  });

  it("keeps shadow projections out of production GUI/OpenTUI imports", () => {
    const consumers = sourceFiles(daemonSrc)
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("terminal-replica-shadow-projections"));
    expect(consumers).toEqual([]);
  });

  it("pins the reviewed fork asset and its machine-readable provenance", () => {
    const packageJson = JSON.parse(readFileSync(join(daemonRoot, "package.json"), "utf8"));
    const provenance = JSON.parse(
      readFileSync(join(import.meta.dirname, "xterm-headless-provenance.json"), "utf8"),
    );
    expect(packageJson.dependencies["@tmux-ide/xterm-headless"]).toBe(provenance.asset);
    expect(packageJson.devDependencies["@xterm/headless-stock"]).toBe("npm:@xterm/headless@6.0.0");
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      version: "6.0.0-tmuxide.2",
      assetSha256: "1ccd7ae170f176dab89ec453476170a853d5493fd1192e114186ce5d5f5cc7d3",
      assetSri:
        "sha512-ZL6DLYJtTbAjJg3HKmofbW9yLDnUayHKrp41PrwEOI2rPlEZ1SLUomTKmBLIr9YrvR8vFlRPl7Bbyk3JEtBY4A==",
      workflowRun: "https://github.com/wavyrai/xterm.js/actions/runs/31992660888",
      upstream: {
        commit: "f447274f430fd22513f6adbf9862d19524471c04",
        tree: "62330f6674bf1548123f3e1fe3da17363cc96a13",
      },
      fork: {
        commit: "8f6d707f7c09410ae4f89ace7b6d1bfed5542428",
        tagObject: "7a945b7ae7be7e4c24ecf4f5f0e6d4df3dc1f468",
        tag: "v6.0.0-tmuxide.2",
        api: "prioritize-next-write-v1",
      },
      license: "MIT",
    });
    const lockfile = readFileSync(join(daemonRoot, "../..", "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toContain(
      `resolution: {integrity: ${provenance.assetSri}, tarball: ${provenance.asset}}`,
    );
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
