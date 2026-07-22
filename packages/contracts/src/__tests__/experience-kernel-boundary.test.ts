import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const KERNEL_ENTRY_FILES = [
  "application-shell.ts",
  "experience-identifiers.ts",
  "experience-shell.ts",
  "visual-recipes.ts",
  "visual-tokens.ts",
  "pane-appearance.ts",
  "focus-overlay.ts",
  "cohesion-fixture.ts",
] as const;
const ALLOWED_EXTERNAL_IMPORTS = new Set(["zod"]);
const NODE_IMPORTS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/u, "")]));
const FORBIDDEN_LOCAL_SEGMENT =
  /(?:^|[/._-])(?:cell|cells|dom|electron|geometry|opentui|pixel|pixels|pty|react|rect|solid|string-width|tmux|xterm)(?=$|[/._-])/iu;

function resolveLocalImport(importer: string, specifier: string): string | null {
  const candidate = resolve(dirname(importer), specifier);
  for (const path of [candidate, `${candidate}.ts`, resolve(candidate, "index.ts")]) {
    if (existsSync(path)) return path;
  }
  return null;
}

function displayPath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join("/");
}

describe("experience-kernel import boundary", () => {
  it("keeps the complete shared graph free of host, runtime, and terminal dependencies", () => {
    const pending = KERNEL_ENTRY_FILES.map((file) => resolve(SOURCE_ROOT, file));
    const visited = new Set<string>();
    const findings: string[] = [];

    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      const preprocessed = ts.preProcessFile(source, true, true);
      const specifiers = [
        ...preprocessed.importedFiles.map(({ fileName }) => fileName),
        ...preprocessed.typeReferenceDirectives.map(({ fileName }) => fileName),
        ...preprocessed.libReferenceDirectives.map(({ fileName }) => fileName),
      ];

      for (const specifier of specifiers) {
        const evidence = `${displayPath(file)} -> ${specifier}`;
        if (!specifier.startsWith(".")) {
          const packageName = specifier
            .replace(/^node:/u, "")
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/");
          if (
            specifier.startsWith("node:") ||
            NODE_IMPORTS.has(specifier) ||
            NODE_IMPORTS.has(packageName) ||
            !ALLOWED_EXTERNAL_IMPORTS.has(packageName)
          ) {
            findings.push(evidence);
          }
          continue;
        }

        if (FORBIDDEN_LOCAL_SEGMENT.test(specifier)) findings.push(evidence);
        const dependency = resolveLocalImport(file, specifier);
        if (dependency === null) {
          findings.push(`${evidence} (unresolved)`);
          continue;
        }
        const outsideSource = relative(SOURCE_ROOT, dependency).startsWith(`..${sep}`);
        if (outsideSource || extname(dependency) !== ".ts") {
          findings.push(`${evidence} (outside shared TypeScript graph)`);
          continue;
        }
        pending.push(dependency);
      }
    }

    expect(findings).toEqual([]);
    expect([...visited].map(displayPath).sort()).toEqual([
      "application-shell.ts",
      "cohesion-fixture.ts",
      "commands.ts",
      "experience-identifiers.ts",
      "experience-shell.ts",
      "focus-overlay.ts",
      "pane-appearance.ts",
      "semantic-identity.ts",
      "visual-recipes.ts",
      "visual-tokens.ts",
    ]);
  });
});
