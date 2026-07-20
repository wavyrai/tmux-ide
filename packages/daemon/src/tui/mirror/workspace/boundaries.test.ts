import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKSPACE_DIR = dirname(fileURLToPath(import.meta.url));
const PRODUCTION_EXTENSIONS = new Set([".ts", ".tsx"]);
const FORBIDDEN_IMPORTS = [
  /(?:^|\/)app\.tsx$/u,
  /(?:^|\/)session-mirror\.ts$/u,
  /(?:^|\/)pane-mirror\.ts$/u,
  /(?:^|\/)control-client\.ts$/u,
  /(?:^|\/)missions-workspace\.ts$/u,
  /(?:^|\/)command-center(?:\/|$)/u,
  /(?:^|\/)server(?:\/|$)/u,
  /(?:^|\/)lib(?:\/|$)/u,
  /^node:/u,
];
const FORBIDDEN_OWNERS = /\b(?:useKeyboard|usePaste|createCliRenderer|process\.exit)\b/u;

async function productionFiles(dir = WORKSPACE_DIR): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__snapshots__") files.push(...(await productionFiles(path)));
      continue;
    }
    if (!PRODUCTION_EXTENSIONS.has(extname(entry.name))) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    files.push(path);
  }
  return files;
}

function imports(source: string): string[] {
  const imports = [
    ...source.matchAll(/\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
  ];
  return imports.map((match) => match[1]!);
}

describe("application workspace boundaries", () => {
  it("keeps production modules out of runtime and legacy-root adapters", async () => {
    const violations: string[] = [];
    for (const file of await productionFiles()) {
      const source = await readFile(file, "utf8");
      for (const specifier of imports(source)) {
        if (FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier))) {
          violations.push(`${file}: forbidden import ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps global input and renderer lifecycle in the root controller", async () => {
    const violations: string[] = [];
    for (const file of await productionFiles()) {
      const source = await readFile(file, "utf8");
      if (FORBIDDEN_OWNERS.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
