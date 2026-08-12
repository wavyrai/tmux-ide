import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("rich preview deferred import graph", () => {
  it("keeps OpenTUI native ownership in the feature boundary", () => {
    expect(source("./contract.ts")).not.toContain("@opentui/");
    expect(source("./session.ts")).not.toContain("@opentui/");
    expect(source("./asset-loader.ts")).not.toContain("@opentui/");
    expect(source("./feature.tsx")).toContain('from "@opentui/core"');
  });

  it("uses only async filesystem APIs in the deferred asset path", () => {
    const loader = source("./asset-loader.ts");
    expect(loader).toContain('from "node:fs/promises"');
    expect(loader).not.toContain("widget-asset-store");
    expect(loader).toContain("Buffer.allocUnsafe(maxBytes + 1)");
    expect(loader).not.toMatch(/\b(?:readFile|lstat|open)Sync\b/u);
  });
});
