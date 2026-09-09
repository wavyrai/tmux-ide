import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  DesktopDaemonCapabilityErrorSchemaZ,
  DesktopDaemonCapabilityErrorCodeSchemaZ,
} from "../desktop-daemon-capability-error.ts";
import { DesktopDaemonCapabilityErrorSchemaZ as legacySchema } from "../desktop-host.ts";
import { DesktopDaemonCapabilityErrorSchemaZ as publicSchema } from "../index.ts";

/** Follow runtime imports, including re-exports, rather than erased type edges. */
function runtimeModules(entry: string, visited = new Set<string>()): Set<string> {
  if (visited.has(entry)) return visited;
  visited.add(entry);
  const source = ts.createSourceFile(entry, readFileSync(entry, "utf8"), ts.ScriptTarget.Latest);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (
        !statement.importClause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((element) => element.isTypeOnly)
      )
        continue;
    } else {
      if (statement.isTypeOnly) continue;
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)
      )
        continue;
    }
    runtimeModules(resolve(dirname(entry), specifier.text), visited);
  }
  return visited;
}

describe("transport contract loading", () => {
  it("preserves the exact public error schema and strict validation", () => {
    expect(publicSchema).toBe(DesktopDaemonCapabilityErrorSchemaZ);
    expect(legacySchema).toBe(DesktopDaemonCapabilityErrorSchemaZ);
    for (const code of DesktopDaemonCapabilityErrorCodeSchemaZ.options) {
      expect(publicSchema.parse({ code, reason: "unavailable" })).toEqual({
        code,
        reason: "unavailable",
      });
    }
    for (const invalid of [
      { code: "unknown-error", reason: "unavailable" },
      { code: "disposed", reason: "" },
      { code: "disposed", reason: "x".repeat(241) },
      { code: "disposed", reason: "closed", extra: true },
    ])
      expect(publicSchema.safeParse(invalid).success).toBe(false);
  });

  it("keeps mutation and error contracts independent of optional desktop resources", () => {
    for (const name of [
      "desktop-daemon-capability-error",
      "workspace-multiplexer",
      "workspace-pane-creation",
      "workspace-open",
      "workspace-open-handoff",
      "workspace-promotion",
      "app-window-mutation",
      "widget-asset",
    ]) {
      const entry = fileURLToPath(new URL(`../${name}.ts`, import.meta.url));
      const modules = [...runtimeModules(entry)];
      for (const forbidden of [
        "desktop-host.ts",
        "workspace-files-resource.ts",
        "workspace-changes-resource.ts",
        "workspace-missions-resource.ts",
        "cohesion-fixture.ts",
      ])
        expect(
          modules.some((path) => path.endsWith(`/${forbidden}`)),
          `${name} loaded ${forbidden}`,
        ).toBe(false);
    }
  });
});
