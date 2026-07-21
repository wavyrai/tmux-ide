import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
  const extension = extname(candidate);
  const candidates =
    extension === ".js" || extension === ".jsx"
      ? [
          candidate.slice(0, -extension.length) + ".ts",
          candidate.slice(0, -extension.length) + ".tsx",
        ]
      : extension
        ? [candidate]
        : [candidate + ".ts", candidate + ".tsx"];
  for (const sourceCandidate of candidates) {
    try {
      readFileSync(sourceCandidate, "utf8");
      return sourceCandidate;
    } catch {
      // Continue with the next source representation.
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

function intrinsicJsxNames(source: string): string[] {
  const file = ts.createSourceFile(
    "presenter.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(file);
      if (/^[a-z]/u.test(name)) names.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

describe("shared PaneFrame presenter import DAG", () => {
  it("keeps every transitive runtime dependency intrinsic-free and on solid-js alone", () => {
    const graph = importGraph(resolve(HERE, "presenter.tsx"));
    expect([...graph.externalSpecifiers].sort()).toEqual(["solid-js"]);
    expect(relativeFiles(graph)).toEqual(["packages/daemon/src/ui/pane-frame/presenter.tsx"]);

    const source = [...graph.files.values()].join("\n");
    expect(intrinsicJsxNames(source)).toEqual([]);
    expect(source).not.toMatch(
      /\b(?:document|window|HTMLElement|KeyboardEvent|MouseEvent|PointerEvent|WheelEvent|process|Buffer)\b/u,
    );
    expect(source).not.toMatch(
      /\b(?:cell|cells|pixel|pixels|rectangle|rectangles|geometry|transport|rgba|glyph|glyphs)\b/iu,
    );
    expect(source).not.toMatch(/%pane_id|electron|xterm|\bpty\b|@opentui|solid-js\/web/iu);
  });

  it("follows emitted local specifiers before evaluating downstream dependencies", () => {
    const root = mkdtempSync(resolve(tmpdir(), "tmux-ide-pane-frame-dag-"));
    try {
      const entry = resolve(root, "entry.ts");
      writeFileSync(entry, 'import "./downstream.js";\n');
      writeFileSync(resolve(root, "downstream.ts"), 'import "node:fs";\n');

      const graph = importGraph(entry);
      expect([...graph.files.keys()].sort()).toEqual(
        [entry, resolve(root, "downstream.ts")].sort(),
      );
      expect([...graph.externalSpecifiers]).toContain("node:fs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
