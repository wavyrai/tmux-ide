import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../../../test-support/opentui-production-root-manifest.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("production OpenTUI entry boundary", () => {
  it("keeps the public app entry genuinely tiny", () => {
    const source = read("packages/daemon/src/tui/mirror/app.tsx");
    expect(source.trim().split("\n")).toHaveLength(3);
    expect(source).toContain('from "./runtime/application-entry.ts"');
    expect(source).toContain("await startApplicationEntry()");
  });

  it("loads the production root through a Bun-discoverable literal import", () => {
    const source = read("packages/daemon/src/tui/mirror/runtime/application-entry.ts");
    expect(source).toContain('await import("./application-root.tsx")');
    expect(source).not.toMatch(/from\s+["']\.\/application-root/u);
  });

  it("manifests every bootstrap boundary used to seed transitive architecture audits", () => {
    expect(OPENTUI_PRODUCTION_ROOT_SOURCES).toEqual([
      "packages/daemon/src/tui/mirror/app.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-entry.ts",
      "packages/daemon/src/tui/mirror/runtime/application-root.tsx",
    ]);
    for (const path of OPENTUI_PRODUCTION_ROOT_SOURCES)
      expect(read(path).length).toBeGreaterThan(0);
  });
});
