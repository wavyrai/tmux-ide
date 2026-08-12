import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import * as ts from "typescript";

export type LocalSourceImportKind = "static-runtime" | "dynamic-runtime" | "type-only";

export interface LocalSourceImportReference {
  readonly kind: LocalSourceImportKind;
  readonly specifier: string;
}

export interface LocalSourceBoundaryGraph {
  readonly files: readonly string[];
  readonly sourceByFile: ReadonlyMap<string, string>;
  readonly referencesByFile: ReadonlyMap<string, readonly LocalSourceImportReference[]>;
}

function localSpecifier(node: ts.Expression | ts.ModuleName | undefined): string | null {
  return node && ts.isStringLiteralLike(node) && /^\.{1,2}\//u.test(node.text) ? node.text : null;
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return false;
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return false;
  return (
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

/** Parse import boundaries without confusing `import type` with executable work. */
export function classifyLocalSourceImports(
  source: string,
  fileName = "source.ts",
): readonly LocalSourceImportReference[] {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const references: LocalSourceImportReference[] = [];
  const add = (kind: LocalSourceImportKind, specifier: string | null) => {
    if (specifier) references.push(Object.freeze({ kind, specifier }));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(
        importDeclarationIsTypeOnly(node) ? "type-only" : "static-runtime",
        localSpecifier(node.moduleSpecifier),
      );
      return;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(
        node.isTypeOnly ? "type-only" : "static-runtime",
        localSpecifier(node.moduleReference.expression),
      );
      return;
    }
    if (ts.isExportDeclaration(node)) {
      add(
        exportDeclarationIsTypeOnly(node) ? "type-only" : "static-runtime",
        localSpecifier(node.moduleSpecifier),
      );
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      add("dynamic-runtime", localSpecifier(node.arguments[0]));
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1
    ) {
      add("static-runtime", localSpecifier(node.arguments[0]));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze(references);
}

async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next supported TypeScript source spelling.
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

/**
 * Follow only the requested edge kinds. Use `static-runtime` for first-frame
 * evaluation audits and add `dynamic-runtime` for Bun embeddability audits.
 */
export async function loadLocalSourceBoundaryGraph(
  repoRoot: string,
  roots: readonly string[],
  kinds: ReadonlySet<LocalSourceImportKind>,
): Promise<LocalSourceBoundaryGraph> {
  const pending = roots.map((file) => join(repoRoot, file));
  const sourceByFile = new Map<string, string>();
  const referencesByFile = new Map<string, readonly LocalSourceImportReference[]>();

  while (pending.length > 0) {
    const absolute = pending.pop()!;
    const file = relative(repoRoot, absolute);
    if (sourceByFile.has(file)) continue;
    const source = await readFile(absolute, "utf8");
    const references = classifyLocalSourceImports(source, file);
    sourceByFile.set(file, source);
    referencesByFile.set(file, references);
    for (const reference of references) {
      if (!kinds.has(reference.kind)) continue;
      const imported = await resolveLocalModule(absolute, reference.specifier);
      if (imported) {
        const local = relative(repoRoot, imported);
        if (
          local !== ".." &&
          !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
          !isAbsolute(local)
        ) {
          pending.push(imported);
        }
      }
    }
  }

  const files = [...sourceByFile.keys()].sort();
  return {
    files: Object.freeze(files),
    sourceByFile: new Map(files.map((file) => [file, sourceByFile.get(file)!])),
    referencesByFile: new Map(files.map((file) => [file, referencesByFile.get(file)!])),
  };
}
