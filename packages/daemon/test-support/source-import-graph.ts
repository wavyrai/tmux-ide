import { access, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

const LOCAL_MODULE_REFERENCE = /(?:from\s*|import\s*\(\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/gu;

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next TypeScript source spelling.
    }
  }
  return null;
}

async function resolveLocalModule(importer: string, specifier: string): Promise<string | null> {
  const absolute = resolve(dirname(importer), specifier);
  const extension = extname(absolute);
  const withoutJs =
    extension === ".js" || extension === ".jsx" ? absolute.slice(0, -extension.length) : null;
  return firstExisting([
    absolute,
    ...(extension
      ? []
      : [
          `${absolute}.ts`,
          `${absolute}.tsx`,
          join(absolute, "index.ts"),
          join(absolute, "index.tsx"),
        ]),
    ...(withoutJs ? [`${withoutJs}.ts`, `${withoutJs}.tsx`] : []),
  ]);
}

export interface LocalSourceImportGraph {
  readonly files: readonly string[];
  readonly sourceByFile: ReadonlyMap<string, string>;
}

/** Follow static imports, re-exports, and literal dynamic imports to closure. */
export async function loadLocalSourceImportGraph(
  repoRoot: string,
  roots: readonly string[],
): Promise<LocalSourceImportGraph> {
  const pending = roots.map((file) => join(repoRoot, file));
  const sourceByFile = new Map<string, string>();

  while (pending.length > 0) {
    const absolute = pending.pop()!;
    const file = relative(repoRoot, absolute);
    if (sourceByFile.has(file)) continue;
    const source = await readFile(absolute, "utf8");
    sourceByFile.set(file, source);
    for (const match of source.matchAll(LOCAL_MODULE_REFERENCE)) {
      const imported = await resolveLocalModule(absolute, match[1]!);
      if (imported && imported.startsWith(repoRoot)) pending.push(imported);
    }
  }

  const files = [...sourceByFile.keys()].sort();
  return {
    files,
    sourceByFile: new Map(files.map((file) => [file, sourceByFile.get(file)!])),
  };
}
