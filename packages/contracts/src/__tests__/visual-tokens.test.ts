import { describe, expect, it } from "vitest";
import {
  BUILTIN_VISUAL_THEMES,
  VisualThemeDocumentV1SchemaZ,
  VisualTokensV1SchemaZ,
  contrastRatio,
  deriveAttentionBlend,
  deriveFocusedHeader,
  loadVisualThemeDocument,
  readableForeground,
  resolveVisualTheme,
  type RendererNeutralColor,
} from "../visual-tokens.ts";

const rgb = (red: number, green: number, blue: number): RendererNeutralColor => ({
  space: "srgb",
  red,
  green,
  blue,
  alpha: 255,
});

describe("visual token contracts", () => {
  it("round-trips both complete built-in themes", () => {
    for (const tokens of Object.values(BUILTIN_VISUAL_THEMES)) {
      expect(VisualTokensV1SchemaZ.parse(JSON.parse(JSON.stringify(tokens)))).toEqual(tokens);
    }
  });

  it("migrates version zero without mutating caller data", () => {
    const source = {
      version: 0,
      id: "legacy",
      name: "Legacy",
      appearance: "light",
      tokens: { text: { primary: rgb(1, 2, 3) } },
    };
    const before = JSON.stringify(source);
    const loaded = loadVisualThemeDocument(source, "user");

    expect(JSON.stringify(source)).toBe(before);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("expected ready theme");
    expect(loaded.sourceVersion).toBe(0);
    expect(loaded.migrated).toBe(true);
    expect(loaded.document).toEqual({
      version: 1,
      id: "legacy",
      name: "Legacy",
      appearance: "light",
      overrides: { text: { primary: rgb(1, 2, 3) } },
    });
    expect(loaded.diagnostics.map(({ code }) => code)).toContain("migrated");
  });

  it("keeps valid siblings while defaulting invalid and unknown tokens", () => {
    const loaded = loadVisualThemeDocument(
      {
        version: 1,
        id: "mixed",
        name: "Mixed",
        overrides: {
          text: { primary: rgb(9, 8, 7), secondary: "not-a-color", invented: rgb(1, 1, 1) },
          inventedGroup: { value: 1 },
        },
      },
      "project",
    );
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("expected ready theme");
    expect(loaded.document.overrides).toEqual({ text: { primary: rgb(9, 8, 7) } });
    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-token", path: "text.secondary" }),
        expect.objectContaining({ code: "unknown-token", path: "text.invented" }),
        expect.objectContaining({ code: "unknown-token", path: "inventedGroup" }),
      ]),
    );
  });

  it("protects future versions from accidental rewriting", () => {
    const future = { version: 72, id: "future", name: "Future", overrides: {} };
    const loaded = loadVisualThemeDocument(future, "project");
    expect(loaded).toEqual(
      expect.objectContaining({
        status: "future-version",
        sourceVersion: 72,
        writable: false,
        document: null,
      }),
    );

    const resolved = resolveVisualTheme({
      appearance: "dark",
      projectTheme: future,
    });
    expect(resolved.futureSources).toEqual(["project"]);
    expect(resolved.tokens).toEqual(BUILTIN_VISUAL_THEMES.dark);
  });

  it("layers defaults, user, project, then accessibility", () => {
    const userPrimary = rgb(1, 2, 3);
    const projectPrimary = rgb(4, 5, 6);
    const user = VisualThemeDocumentV1SchemaZ.parse({
      version: 1,
      id: "user",
      name: "User",
      appearance: "light",
      overrides: {
        text: { primary: userPrimary },
        motion: { fast: { unit: "ms", value: 999 } },
      },
    });
    const project = VisualThemeDocumentV1SchemaZ.parse({
      version: 1,
      id: "project",
      name: "Project",
      overrides: { text: { primary: projectPrimary } },
    });
    const resolved = resolveVisualTheme({
      appearance: "dark",
      userTheme: user,
      projectTheme: project,
      accessibility: { reducedMotion: true, increasedContrast: true },
    });

    expect(resolved.appearance).toBe("light");
    expect(resolved.tokens.text.primary).toEqual(projectPrimary);
    expect(resolved.tokens.motion.fast).toEqual({ unit: "ms", value: 0 });
    expect(resolved.tokens.motion.easing).toEqual({ standard: "linear", emphasized: "linear" });
    expect(resolved.tokens.focus.focusContrast).toEqual({ unit: "ratio", value: 7 });
    expect(resolved.tokens.borders.focused).toEqual(resolved.tokens.focus.highContrastOutline);
    expect(resolved.tokens.windowActivity.inactive).toEqual({
      opacity: { unit: "ratio", value: 1 },
      contrast: { unit: "ratio", value: 1 },
    });
  });

  it("derives deterministic renderer-neutral colors and readable foregrounds", () => {
    const black = rgb(0, 0, 0);
    const white = rgb(255, 255, 255);
    const focus = rgb(100, 200, 250);
    expect(contrastRatio(black, white)).toBeCloseTo(21);
    expect(readableForeground(black, black, white)).toEqual(white);
    expect(deriveFocusedHeader(black, focus)).toEqual(deriveFocusedHeader(black, focus));
    expect(deriveAttentionBlend(white, focus)).toEqual(deriveAttentionBlend(white, focus));
  });

  it("serializes only renderer-neutral units", () => {
    const units = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "unit" && typeof child === "string") units.add(child);
        walk(child);
      }
    };
    walk(BUILTIN_VISUAL_THEMES);
    expect([...units].sort()).toEqual(["ms", "ratio", "rhythm"]);
  });
});
