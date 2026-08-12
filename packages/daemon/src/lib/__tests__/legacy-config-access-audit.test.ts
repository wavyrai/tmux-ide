import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../../test-support/opentui-production-root-manifest.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

const ALLOWLIST = new Set([
  // Frozen compatibility boundary and migration tooling.
  "packages/daemon/src/lib/yaml-io.ts",
  "packages/daemon/src/lib/resolved-config.ts",
  "packages/daemon/src/lib/project-resolver.ts",
  "packages/daemon/src/lib/legacy-config-adapter.ts",
  "packages/daemon/src/migrate.ts",
  // Narrow mutation boundary: public/command-center callers must pass a
  // ProjectConfigContext.configWriteRoot before invoking these sync helpers.
  "packages/daemon/src/config.ts",
]);

const LEGACY_PROBE_CALLS = new Set([
  "existsSync",
  "readFileSync",
  "writeFileSync",
  "stat",
  "pathKind",
  "join",
  "resolve",
]);
const COMPAT_IMPORTS = new Set([
  "readConfig",
  "getSessionName",
  "hasLaunchConfig",
  "hasLegacyConfigAt",
  "legacyConfigPath",
]);
const DIRECT_COMPAT_CALLS = new Set(["readConfig", "getSessionName", "hasLaunchConfig"]);

/**
 * Locate direct compatibility access by syntax, rather than matching member
 * calls such as an injected `host.readConfig()`. The latter is an ordinary
 * capability port and must remain usable by deferred settings features.
 */
function directLegacyAccessLines(source: string, fileName: string): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = new Set<number>();
  const add = (node: ts.Node) => {
    lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
  };
  const containsLegacyPath = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (
        (ts.isStringLiteralLike(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
        child.text === "ide.yml"
      ) {
        found = true;
        return;
      }
      if (!found) ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (COMPAT_IMPORTS.has((element.propertyName ?? element.name).text)) add(element);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && DIRECT_COMPAT_CALLS.has(node.expression.text)) {
        add(node.expression);
      }
      const callName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (callName && LEGACY_PROBE_CALLS.has(callName) && containsLegacyPath(node)) add(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...lines].sort((left, right) => left - right);
}

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "coverage" || entry.name === "node_modules") {
        return [];
      }
      return productionSources(absolute);
    }
    if (!entry.isFile()) return [];
    if (!/\.(?:ts|tsx)$/u.test(entry.name)) return [];
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) return [];
    return [absolute];
  });
}

describe("legacy config access audit", () => {
  it("keeps direct ide.yml filesystem probes inside the compatibility boundary", () => {
    const sources = [join(repoRoot, "bin"), join(repoRoot, "packages/daemon/src")].flatMap(
      productionSources,
    );
    const offenders = sources.flatMap((absolute) => {
      const relativePath = relative(repoRoot, absolute);
      if (ALLOWLIST.has(relativePath)) return [];
      const source = readFileSync(absolute, "utf-8");
      return directLegacyAccessLines(source, relativePath).map(
        (lineNumber) => `${relativePath}:${lineNumber}`,
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps setup and settings widget writes on configWriteRoot", () => {
    const setup = readFileSync(
      join(repoRoot, "packages/daemon/src/widgets/setup/index.tsx"),
      "utf-8",
    );
    const settings = readFileSync(
      join(repoRoot, "packages/daemon/src/widgets/config/index.tsx"),
      "utf-8",
    );

    expect(setup).toContain("const configWriteRoot = configContext.configWriteRoot");
    expect(setup).toContain("writeConfig(configWriteRoot, cfg)");
    expect(setup).not.toContain("resolveConfig(dir).catch(() => null)");
    expect(settings).toContain("const configWriteRoot = configContext.configWriteRoot");
    expect(settings).toContain("writeConfig(configWriteRoot, config())");
  });

  it("does not swallow invalid config resolution in active config probes", () => {
    const files = ["bin/cli.ts", "packages/daemon/src/cli.ts", ...OPENTUI_PRODUCTION_ROOT_SOURCES];

    const offenders = files.filter((file) => {
      const source = readFileSync(join(repoRoot, file), "utf-8");
      return /resolveConfig\([^)]*\)\.catch\(\(\) => null\)/u.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("previews setup YAML through the same workspace conversion path as writes", () => {
    const source = readFileSync(
      join(repoRoot, "packages/daemon/src/widgets/setup/review-panel.tsx"),
      "utf-8",
    );

    expect(source).toContain(
      "workspaceConfigToYaml(convertLegacyConfigToWorkspace(config).workspace)",
    );
    expect(source).toContain("writeConfig(props.configWriteRoot, props.config)");
    expect(source).not.toContain('from "js-yaml"');
  });
});
