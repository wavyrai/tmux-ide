import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const contractsRoot = fileURLToPath(new URL("../../packages/contracts/src/", import.meta.url));

/**
 * Build-time counterpart to contracts/package.json's audited sideEffects:false.
 * Contract initializers only construct schemas or immutable local data; no
 * registration, I/O, or external mutation may be added to this audited scope.
 * Bundlers otherwise retain unused Zod constructors because calls are opaque.
 * Wrap the complete initializer so its children can be dropped with its value.
 * Used initializers, including parsing/refinement callbacks, run unchanged.
 * This is deliberately not a general annotation pass for application code.
 */
export function transformContractsInitializers(source, filename, root = contractsRoot) {
  const absolute = resolve(filename);
  if (
    dirname(absolute) !== resolve(root) ||
    !absolute.endsWith(".ts") ||
    /\.(?:test|spec|d)\.ts$/.test(absolute)
  )
    return source;

  const parsed = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits = [];
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (!initializer) continue;
      // These are already pure to the bundler. Keeping them direct also keeps
      // JavaScript's inferred function/class names intact.
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer) ||
        ts.isClassExpression(initializer)
      )
        continue;
      // Await/yield at initializer scope cannot be moved into a sync arrow.
      // Nested functions retain their original bodies and own lexical scope.
      let asynchronous = false;
      function inspect(node) {
        if (ts.isFunctionLike(node)) return;
        if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) asynchronous = true;
        ts.forEachChild(node, inspect);
      }
      inspect(initializer);
      if (asynchronous) {
        throw new Error(
          `Cannot annotate asynchronous contract initializer: ${absolute}:${declaration.name.getText(parsed)}`,
        );
      }
      const start = initializer.getStart(parsed);
      const end = initializer.getEnd();
      edits.push({
        start,
        end,
        replacement: `/*#__PURE__*/ (() => (${source.slice(start, end)}))()`,
      });
    }
  }
  for (const edit of edits.reverse()) {
    source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  }
  return source;
}

/** Compatible with esbuild's plugin API; TypeScript remains a build-only dependency. */
export function contractsInitializerPurityPlugin({ root = contractsRoot } = {}) {
  const canonicalRoot = realpathSync(root);
  return {
    name: "contracts-initializer-purity",
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        if (dirname(resolve(path)) !== canonicalRoot || /\.(?:test|spec|d)\.ts$/.test(path)) return;
        const source = await readFile(path, "utf8");
        return {
          contents: transformContractsInitializers(source, path, canonicalRoot),
          loader: "ts",
        };
      });
    },
  };
}
