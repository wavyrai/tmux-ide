import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyLocalSourceImports,
  loadLocalSourceBoundaryGraph,
} from "../../../../test-support/source-import-boundaries.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("source import boundary classifier", () => {
  it("distinguishes executable static, literal dynamic, and type-only edges", () => {
    expect(
      classifyLocalSourceImports(
        `
          import "./side-effect.ts";
          import value, { type Shape } from "./mixed.ts";
          import type { OnlyType } from "./types.ts";
          import { type AnotherType } from "./more-types.ts";
          export { value as next } from "./exported.ts";
          export type { ExportedType } from "./exported-types.ts";
          import assigned = require("./assigned.ts");
          import type AssignedType = require("./assigned-type.ts");
          const deferred = import("./lazy.ts", { with: { type: "json" } });
          const legacy = require("./legacy.ts");
        `,
        "root.ts",
      ),
    ).toEqual([
      { kind: "static-runtime", specifier: "./side-effect.ts" },
      { kind: "static-runtime", specifier: "./mixed.ts" },
      { kind: "type-only", specifier: "./types.ts" },
      { kind: "type-only", specifier: "./more-types.ts" },
      { kind: "static-runtime", specifier: "./exported.ts" },
      { kind: "type-only", specifier: "./exported-types.ts" },
      { kind: "static-runtime", specifier: "./assigned.ts" },
      { kind: "type-only", specifier: "./assigned-type.ts" },
      { kind: "dynamic-runtime", specifier: "./lazy.ts" },
      { kind: "static-runtime", specifier: "./legacy.ts" },
    ]);
  });

  it("builds separate first-frame and Bun-discoverable runtime closures", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-import-boundary-"));
    roots.push(root);
    writeFileSync(
      join(root, "entry.ts"),
      [
        'import { eager } from "./eager.ts";',
        'import type { Shape } from "./types.ts";',
        'export async function load() { return import("./lazy.ts"); }',
        "void eager;",
      ].join("\n"),
    );
    writeFileSync(join(root, "eager.ts"), 'export { value as eager } from "./shared.ts";\n');
    writeFileSync(join(root, "shared.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "types.ts"), "export interface Shape { id: string }\n");
    writeFileSync(join(root, "lazy.ts"), 'export { value } from "./lazy-child.ts";\n');
    writeFileSync(join(root, "lazy-child.ts"), "export const value = 2;\n");

    const firstFrame = await loadLocalSourceBoundaryGraph(
      root,
      ["entry.ts"],
      new Set(["static-runtime"]),
    );
    expect(firstFrame.files).toEqual(["eager.ts", "entry.ts", "shared.ts"]);

    const runtime = await loadLocalSourceBoundaryGraph(
      root,
      ["entry.ts"],
      new Set(["static-runtime", "dynamic-runtime"]),
    );
    expect(runtime.files).toEqual([
      "eager.ts",
      "entry.ts",
      "lazy-child.ts",
      "lazy.ts",
      "shared.ts",
    ]);
  });

  it("keeps the deferred dialog session outside the legacy singleton façade", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      process.cwd(),
      ["src/tui/mirror/features/dialogs/session.ts"],
      new Set(["static-runtime"]),
    );
    expect(graph.files).toContain("src/tui/mirror/dialog-stack-core.ts");
    expect(graph.files).not.toContain("src/tui/mirror/dialog-stack.ts");
  });
});
