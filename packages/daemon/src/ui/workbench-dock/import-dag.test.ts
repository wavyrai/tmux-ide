import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

interface ImportGraph {
  readonly files: ReadonlyMap<string, string>;
  readonly externalSpecifiers: ReadonlySet<string>;
}

function runtimeImports(source: string): string[] {
  const withoutTypeImports = source.replace(
    /^\s*import\s+type\s+[\s\S]*?\s+from\s+["'][^"']+["'];?\s*$/gmu,
    "",
  );
  return [
    ...withoutTypeImports.matchAll(/\b(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu),
    ...withoutTypeImports.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
  ].map((match) => match[1]!);
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(importer), specifier);
  if (extname(candidate)) return candidate;
  for (const extension of [".ts", ".tsx"]) {
    try {
      readFileSync(candidate + extension, "utf8");
      return candidate + extension;
    } catch {
      // Try the next production extension.
    }
  }
  return candidate;
}

function importGraph(entry: string): ImportGraph {
  const files = new Map<string, string>();
  const externalSpecifiers = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file) || ![".ts", ".tsx"].includes(extname(file))) continue;
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    for (const specifier of runtimeImports(source)) {
      const local = resolveLocalImport(file, specifier);
      if (local) pending.push(local);
      else externalSpecifiers.add(specifier);
    }
  }
  return { files, externalSpecifiers };
}

function relativeFiles(graph: ImportGraph): string[] {
  return [...graph.files.keys()].map((file) => file.slice(REPO_ROOT.length + 1)).sort();
}

describe("shared workbench dock import DAG", () => {
  it("keeps the intrinsic-free presenter on solid-js alone", () => {
    const graph = importGraph(resolve(HERE, "presenter.tsx"));
    expect([...graph.externalSpecifiers].sort()).toEqual(["solid-js"]);
    expect(relativeFiles(graph)).toEqual(["packages/daemon/src/ui/workbench-dock/presenter.tsx"]);
    const source = graph.files.values().next().value!;
    expect(source).not.toMatch(/<[a-z][\w-]*/u);
    expect(source).not.toMatch(/\b(?:document|window|HTMLElement|KeyboardEvent|process)\b/u);
  });

  it("keeps the standard DOM host free of OpenTUI and Node runtime imports", () => {
    const graph = importGraph(resolve(HERE, "web-entry.tsx"));
    expect([...graph.externalSpecifiers].some((value) => value === "solid-js/web")).toBe(true);
    expect([...graph.externalSpecifiers].some((value) => value.startsWith("@opentui/"))).toBe(
      false,
    );
    expect([...graph.externalSpecifiers].some((value) => value.startsWith("node:"))).toBe(false);
    expect(relativeFiles(graph).some((file) => file.includes("/tui/"))).toBe(false);
  });

  it("keeps the OpenTUI leaves free of DOM and Node runtime imports", () => {
    const entry = resolve(HERE, "../../tui/mirror/workspace/workbench-dock-opentui.tsx");
    const graph = importGraph(entry);
    expect([...graph.externalSpecifiers].some((value) => value === "solid-js/web")).toBe(false);
    expect([...graph.externalSpecifiers].some((value) => value.startsWith("node:"))).toBe(false);
    expect(relativeFiles(graph).some((file) => file.endsWith("web-host.tsx"))).toBe(false);
    expect([...graph.files.values()].join("\n")).not.toMatch(
      /\b(?:document|window|HTMLElement|KeyboardEvent)\b/u,
    );
  });
});
