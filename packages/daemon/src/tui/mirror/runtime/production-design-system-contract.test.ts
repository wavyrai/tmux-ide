import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadLocalSourceImportGraph } from "../../../../test-support/source-import-graph.ts";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../../../test-support/opentui-production-root-manifest.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const productionGraph = await loadLocalSourceImportGraph(repoRoot, OPENTUI_PRODUCTION_ROOT_SOURCES);

const MIRROR_ROOT = "packages/daemon/src/tui/mirror/";
const THEME_BOUNDARY = `${MIRROR_ROOT}theme.ts`;
const APPEARANCE_OWNER = `${MIRROR_ROOT}runtime/application-appearance-owner.ts`;
const RAW_COLOR_COMPATIBILITY_OWNERS = [
  // User-config serialization accepts tmux colourN values but never renders them.
  "packages/daemon/src/lib/app-config.ts",
  // The opaque terminal leaf decodes ANSI cells before semantic chrome is composed.
  `${MIRROR_ROOT}pane-surface.tsx`,
  // The only app-chrome token and renderer-color projection boundary.
  THEME_BOUNDARY,
] as const;

const SHARED_PRESENTATION_FILES = productionGraph.files.filter(
  (path) =>
    path.startsWith(`${MIRROR_ROOT}ui/`) ||
    path.startsWith(`${MIRROR_ROOT}workspace/`) ||
    path === `${MIRROR_ROOT}shell-chrome-view.tsx` ||
    /\/runtime\/application-shell-(?:catalog|home|overlay-stack|overlays|sidebar)\.tsx$/u.test(
      path,
    ),
);

const RAW_APP_COLOR =
  /\bRGBA\.from(?:Hex|Ints)\s*\(|["']#[\da-f]{3,8}["']|["']0x[\da-f]{3,8}["']|["']colour\d+["']|\b(?:bg|fg|backgroundColor|borderColor|color)\s*=\s*(?:\{\s*)?["'](?:black|white)["']/iu;
const DIRECT_THEME_OWNERSHIP =
  /\b(?:createSemanticThemeSnapshot|createSemanticThemeStore|resolveVisualTheme|deriveSystemVisualHostDefaults|createTerminalPaletteProjection)\s*\(/u;
const TERMINAL_FRAMEBUFFER_IMPORT =
  /(?:^|\/)(?:runtime|command-center)(?:\/|$)|(?:control|workspace)-client|tmux-bridge|open-tui-workspace-runtime-port|pane-(?:stream|surface|mirror)|pane-scoped-terminal|semantic-pane-render-source|terminal-(?:fast-lane|palette)|framebuffer|ansi-palette|(?:^|\/)blit(?:\.|$)/u;

function sourceFor(path: string): string {
  return productionGraph.sourceByFile.get(path) ?? readFileSync(join(repoRoot, path), "utf8");
}

function localImports(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gmu),
  ].map((match) => match[1]!);
}

describe("production OpenTUI design-system boundary", () => {
  it("rejects raw render colors outside the semantic theme boundary", () => {
    const owners = productionGraph.files.filter((path) => RAW_APP_COLOR.test(sourceFor(path)));
    expect(owners).toEqual([...RAW_COLOR_COMPATIBILITY_OWNERS].sort());
  });

  it("keeps semantic theme construction in the theme and appearance owners", () => {
    const owners = productionGraph.files.filter((path) =>
      DIRECT_THEME_OWNERSHIP.test(sourceFor(path)),
    );
    expect(owners).toEqual([THEME_BOUNDARY, APPEARANCE_OWNER].sort());
  });

  it("keeps shared presentation primitives outside runtime and terminal framebuffer ownership", () => {
    const violations: string[] = [];
    for (const path of SHARED_PRESENTATION_FILES) {
      for (const specifier of localImports(sourceFor(path))) {
        if (TERMINAL_FRAMEBUFFER_IMPORT.test(specifier))
          violations.push(`${path.slice(MIRROR_ROOT.length)}: forbidden import ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps every production shared primitive free of local theme construction", () => {
    const owners = SHARED_PRESENTATION_FILES.filter((path) =>
      DIRECT_THEME_OWNERSHIP.test(sourceFor(path)),
    );
    expect(owners).toEqual([]);
  });
});
