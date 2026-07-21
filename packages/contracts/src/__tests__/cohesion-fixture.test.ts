import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COHESION_FIXTURE_V1, CohesionFixtureV1SchemaZ } from "../cohesion-fixture.ts";
import { resolvePaneAppearance } from "../pane-appearance.ts";
import { resolveSemanticInputLayer } from "../focus-overlay.ts";
import { resolveVisualTheme } from "../visual-tokens.ts";

const KERNEL_FILES = [
  "experience-shell.ts",
  "visual-recipes.ts",
  "visual-tokens.ts",
  "pane-appearance.ts",
  "focus-overlay.ts",
  "cohesion-fixture.ts",
] as const;

describe("CohesionFixtureV1", () => {
  it("round-trips as strict serialized cross-host acceptance input", () => {
    expect(CohesionFixtureV1SchemaZ.parse(JSON.parse(JSON.stringify(COHESION_FIXTURE_V1)))).toEqual(
      COHESION_FIXTURE_V1,
    );
  });

  it("exercises every dock tool and orthogonal composed pane states", () => {
    expect(COHESION_FIXTURE_V1.dock.tools.map(({ id }) => id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    const appearances = COHESION_FIXTURE_V1.panes.map(({ state }) => resolvePaneAppearance(state));
    expect(appearances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          border: expect.objectContaining({ role: "focused" }),
          status: expect.objectContaining({ attentionTone: "info" }),
        }),
        expect.objectContaining({
          outerOutline: expect.objectContaining({ role: "selected" }),
        }),
        expect.objectContaining({
          status: expect.objectContaining({ domainStatus: "recovering", tone: "danger" }),
          action: expect.objectContaining({ disabled: true, loading: true }),
        }),
      ]),
    );
    expect(resolveSemanticInputLayer(COHESION_FIXTURE_V1.focus)).toEqual({
      kind: "command-palette",
      overlayId: "overlay.palette",
    });
    expect(
      resolveVisualTheme({
        userTheme: COHESION_FIXTURE_V1.theme.user,
        projectTheme: COHESION_FIXTURE_V1.theme.project ?? undefined,
        accessibility: COHESION_FIXTURE_V1.theme.accessibility,
      }).appearance,
    ).toBe("dark");
  });

  it("rejects broken cross-field identity and state ownership", () => {
    const copy = JSON.parse(JSON.stringify(COHESION_FIXTURE_V1)) as Record<string, unknown>;
    const focus = copy.focus as Record<string, unknown>;
    focus.appFocusedPaneId = "pane.unknown";
    expect(CohesionFixtureV1SchemaZ.safeParse(copy).success).toBe(false);
  });

  it("contains no renderer geometry or live transport handles", () => {
    const forbiddenKeys = new Set([
      "x",
      "y",
      "width",
      "height",
      "rect",
      "bounds",
      "tmuxPaneId",
      "ptyId",
      "xtermId",
      "electronWindowId",
      "nativeHandle",
    ]);
    const forbiddenUnits = new Set(["px", "rem", "em", "cell", "row", "column"]);
    const findings: string[] = [];
    const walk = (value: unknown, path = "fixture"): void => {
      if (Array.isArray(value))
        return value.forEach((child, index) => walk(child, `${path}.${index}`));
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) findings.push(`${path}.${key}`);
        if (key === "unit" && typeof child === "string" && forbiddenUnits.has(child)) {
          findings.push(`${path}.${key}:${child}`);
        }
        walk(child, `${path}.${key}`);
      }
    };
    walk(COHESION_FIXTURE_V1);
    expect(findings).toEqual([]);
  });
});

describe("experience-kernel boundaries", () => {
  it("does not import renderer, runtime, DOM, or geometry packages", () => {
    const forbidden = [
      "node:",
      "electron",
      "@opentui",
      "solid-js",
      "react",
      "xterm",
      "dom",
      "tmux",
      "pty",
    ];
    for (const file of KERNEL_FILES) {
      const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]!);
      expect(
        imports.filter((specifier) => forbidden.some((name) => specifier.includes(name))),
        file,
      ).toEqual([]);
    }
  });
});
