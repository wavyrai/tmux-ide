import { describe, expect, it } from "vitest";
import {
  COHESION_FIXTURE_V1,
  SEMANTIC_ICON_IDS,
  type RendererNeutralColor,
} from "@tmux-ide/contracts";

import { DOM_EXPERIENCE_VARIABLE, createDomExperience } from "./dom-experience.ts";
import { resolveDomIcon } from "./dom-icons.ts";

const EXPECTED_DOM_EXPERIENCE_VARIABLE_NAMES = [
  "--tmux-ide-border-attention",
  "--tmux-ide-border-danger",
  "--tmux-ide-border-default",
  "--tmux-ide-border-focused",
  "--tmux-ide-border-selected",
  "--tmux-ide-border-subtle",
  "--tmux-ide-control-disabled-background",
  "--tmux-ide-control-disabled-foreground",
  "--tmux-ide-control-disabled-foreground-high-contrast",
  "--tmux-ide-density-cell-height",
  "--tmux-ide-density-control-padding",
  "--tmux-ide-density-header-height",
  "--tmux-ide-density-inline-gap",
  "--tmux-ide-density-section-gap",
  "--tmux-ide-density-status-height",
  "--tmux-ide-elevation-floating-intent",
  "--tmux-ide-elevation-floating-level",
  "--tmux-ide-elevation-floating-shadow",
  "--tmux-ide-elevation-palette-intent",
  "--tmux-ide-elevation-palette-level",
  "--tmux-ide-elevation-palette-shadow",
  "--tmux-ide-elevation-window-mode-intent",
  "--tmux-ide-elevation-window-mode-level",
  "--tmux-ide-elevation-window-mode-shadow",
  "--tmux-ide-focus-focus-contrast",
  "--tmux-ide-focus-high-contrast-outline",
  "--tmux-ide-focus-outline",
  "--tmux-ide-focus-outline-offset",
  "--tmux-ide-motion-easing-emphasized",
  "--tmux-ide-motion-easing-standard",
  "--tmux-ide-motion-emphasized",
  "--tmux-ide-motion-fast",
  "--tmux-ide-motion-instant",
  "--tmux-ide-motion-standard",
  "--tmux-ide-selection-disabled",
  "--tmux-ide-selection-hover",
  "--tmux-ide-selection-pressed",
  "--tmux-ide-selection-selection",
  "--tmux-ide-selection-selection-text",
  "--tmux-ide-shape-control-radius",
  "--tmux-ide-shape-docked-radius",
  "--tmux-ide-shape-floating-radius",
  "--tmux-ide-shape-status-radius",
  "--tmux-ide-status-danger",
  "--tmux-ide-status-info",
  "--tmux-ide-status-neutral",
  "--tmux-ide-status-success",
  "--tmux-ide-status-warning",
  "--tmux-ide-surface-canvas",
  "--tmux-ide-surface-command",
  "--tmux-ide-surface-header",
  "--tmux-ide-surface-header-active",
  "--tmux-ide-surface-panel",
  "--tmux-ide-surface-panel-raised",
  "--tmux-ide-surface-terminal",
  "--tmux-ide-text-bright",
  "--tmux-ide-text-inverse",
  "--tmux-ide-text-link",
  "--tmux-ide-text-muted",
  "--tmux-ide-text-primary",
  "--tmux-ide-text-secondary",
  "--tmux-ide-typography-code-family",
  "--tmux-ide-typography-code-line-height",
  "--tmux-ide-typography-code-truncation",
  "--tmux-ide-typography-code-weight",
  "--tmux-ide-typography-label-family",
  "--tmux-ide-typography-label-line-height",
  "--tmux-ide-typography-label-truncation",
  "--tmux-ide-typography-label-weight",
  "--tmux-ide-typography-metadata-family",
  "--tmux-ide-typography-metadata-line-height",
  "--tmux-ide-typography-metadata-truncation",
  "--tmux-ide-typography-metadata-weight",
  "--tmux-ide-typography-title-family",
  "--tmux-ide-typography-title-line-height",
  "--tmux-ide-typography-title-truncation",
  "--tmux-ide-typography-title-weight",
  "--tmux-ide-typography-workspace-family",
  "--tmux-ide-typography-workspace-line-height",
  "--tmux-ide-typography-workspace-truncation",
  "--tmux-ide-typography-workspace-weight",
  "--tmux-ide-window-activity-active-contrast",
  "--tmux-ide-window-activity-active-opacity",
  "--tmux-ide-window-activity-inactive-contrast",
  "--tmux-ide-window-activity-inactive-opacity",
] as const;

function color(red: number, green: number, blue: number): RendererNeutralColor {
  return { space: "srgb", red, green, blue, alpha: 255 };
}

describe("DOM experience adapter", () => {
  it("projects complete canonical dark and light themes into stable CSS variables", () => {
    const dark = createDomExperience({ hostTheme: { mode: "dark" } });
    const light = createDomExperience({ hostTheme: { mode: "light" } });

    expect(dark.appearance).toBe("dark");
    expect(dark.variables[DOM_EXPERIENCE_VARIABLE.surface.canvas]).toBe("rgb(14 14 18)");
    expect(dark.variables[DOM_EXPERIENCE_VARIABLE.text.primary]).toBe("rgb(222 222 230)");
    expect(light.appearance).toBe("light");
    expect(light.variables[DOM_EXPERIENCE_VARIABLE.surface.canvas]).toBe("rgb(245 245 247)");
    expect(light.variables[DOM_EXPERIENCE_VARIABLE.text.primary]).toBe("rgb(32 32 39)");
    expect(Object.keys(dark.variables).sort()).toEqual(EXPECTED_DOM_EXPERIENCE_VARIABLE_NAMES);
    expect(Object.values(dark.variables).every((value) => value.length > 0)).toBe(true);
    expect({
      panel: DOM_EXPERIENCE_VARIABLE.surface.panel,
      raised: DOM_EXPERIENCE_VARIABLE.surface.panelRaised,
      focus: DOM_EXPERIENCE_VARIABLE.border.focused,
      attention: DOM_EXPERIENCE_VARIABLE.border.attention,
      selected: DOM_EXPERIENCE_VARIABLE.selection.selection,
      disabled: DOM_EXPERIENCE_VARIABLE.selection.disabled,
    }).toEqual({
      panel: "--tmux-ide-surface-panel",
      raised: "--tmux-ide-surface-panel-raised",
      focus: "--tmux-ide-border-focused",
      attention: "--tmux-ide-border-attention",
      selected: "--tmux-ide-selection-selection",
      disabled: "--tmux-ide-selection-disabled",
    });
    expect(dark.variables["--tmux-ide-elevation-floating-shadow"]).toBe(
      "0 18px 38px rgb(14 14 18 / 0.46)",
    );
    expect(dark.variables["--tmux-ide-elevation-palette-shadow"]).toBe(
      "0 10px 18px rgb(14 14 18 / 0.34)",
    );
    expect(dark.variables["--tmux-ide-elevation-window-mode-shadow"]).toBe(
      "0 18px 40px rgb(14 14 18 / 0.5)",
    );
    expect(light.variables["--tmux-ide-elevation-floating-shadow"]).toBe(
      "0 18px 38px rgb(245 245 247 / 0.46)",
    );
    expect(dark.variables[DOM_EXPERIENCE_VARIABLE.control.disabledBackground]).toBe(
      "rgb(19 19 26)",
    );
    expect(dark.variables[DOM_EXPERIENCE_VARIABLE.control.disabledForeground]).toBe(
      "rgb(123 123 138 / 0.55)",
    );
    expect(dark.variables[DOM_EXPERIENCE_VARIABLE.control.disabledForegroundHighContrast]).toBe(
      "rgb(123 123 138)",
    );
    expect(dark.variables[DOM_EXPERIENCE_VARIABLE.motion.fast]).toBe("90ms");
  });

  it("applies high contrast and reduced motion before producing host values", () => {
    const experience = createDomExperience({
      hostTheme: { mode: "dark", highContrast: true, reducedMotion: true },
    });

    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.border.focused]).toBe("rgb(255 255 255)");
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.border.selected]).toBe("rgb(255 255 255)");
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.focus.focusContrast]).toBe("7");
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.motion.fast]).toBe("0ms");
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.motion.easingStandard]).toBe("linear");
    expect(experience.variables["--tmux-ide-window-activity-inactive-opacity"]).toBe("1");
  });

  it("fills missing optional theme tokens from the canonical appearance fallback", () => {
    const experience = createDomExperience({
      userTheme: {
        version: 1,
        id: "partial-light",
        name: "Partial light",
        appearance: "light",
        overrides: { text: { link: color(12, 34, 56) } },
      },
    });

    expect(experience.appearance).toBe("light");
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.text.link]).toBe("rgb(12 34 56)");
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.surface.panel]).toBe("rgb(255 255 255)");
    expect(experience.diagnostics).toEqual([]);
  });

  it("surfaces host/product accessibility disagreement and chooses the safer preference", () => {
    const experience = createDomExperience({
      hostTheme: { mode: "dark", highContrast: false, reducedMotion: true },
      productAccessibility: COHESION_FIXTURE_V1.theme.accessibility,
      userTheme: COHESION_FIXTURE_V1.theme.user,
      projectTheme: COHESION_FIXTURE_V1.theme.project ?? undefined,
    });

    expect(COHESION_FIXTURE_V1.theme.accessibility.reducedMotion).toBe(false);
    expect(experience.accessibility).toEqual({
      reducedMotion: true,
      increasedContrast: false,
      conflicts: ["reduced-motion"],
    });
    expect(experience.variables[DOM_EXPERIENCE_VARIABLE.motion.emphasized]).toBe("0ms");
  });

  it("provides vector metadata for every canonical semantic icon", () => {
    expect(Object.keys(createDomExperience().icons)).toEqual([...SEMANTIC_ICON_IDS]);
    for (const id of SEMANTIC_ICON_IDS) {
      expect(resolveDomIcon(id)).toMatchObject({
        id,
        viewBox: "0 0 16 16",
        size: 12,
        usage: "action",
        usageSizes: { pane: 12, tab: 12, rail: 12, action: 12, nativeWindow: 10 },
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        fill: "none",
        stroke: "currentColor",
      });
      expect(resolveDomIcon(id).label.length).toBeGreaterThan(0);
      expect(resolveDomIcon(id).paths.length).toBeGreaterThan(0);
    }
    expect(resolveDomIcon("close", "nativeWindow").size).toBe(10);
    expect(resolveDomIcon("more").paths).toEqual(["M2.75 8h.5M7.75 8h.5M12.75 8h.5"]);
  });
});
