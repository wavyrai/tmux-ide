import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

const DIRECT_LEGACY_PROBE =
  /\b(?:existsSync|readFileSync|writeFileSync|stat|pathKind|join|resolve)\s*\([^;\n]*(["'])ide\.yml\1/u;
const DIRECT_COMPAT_IMPORT =
  /import\s*\{[^}]*\b(?:readConfig|getSessionName|hasLaunchConfig|hasLegacyConfigAt|legacyConfigPath)\b[^}]*\}\s*from\s*(["']).*?\1/u;
const DIRECT_COMPAT_CALL = /\b(?:readConfig|getSessionName|hasLaunchConfig)\s*\(/u;

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
      return source
        .split("\n")
        .map((line, index) => ({ line, index: index + 1 }))
        .filter(
          ({ line }) =>
            DIRECT_LEGACY_PROBE.test(line) ||
            DIRECT_COMPAT_IMPORT.test(line) ||
            DIRECT_COMPAT_CALL.test(line),
        )
        .map(({ index }) => `${relativePath}:${index}`);
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
    const files = [
      "bin/cli.ts",
      "packages/daemon/src/cli.ts",
      "packages/daemon/src/tui/mirror/app.tsx",
    ];

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
