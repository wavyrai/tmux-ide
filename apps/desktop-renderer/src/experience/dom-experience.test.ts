import { describe, expect, it } from "vitest";
import {
  COHESION_FIXTURE_V1,
  SEMANTIC_ICON_IDS,
  type RendererNeutralColor,
} from "@tmux-ide/contracts";

import { DOM_EXPERIENCE_VARIABLE, createDomExperience } from "./dom-experience.ts";
import { resolveDomIcon } from "./dom-icons.ts";

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
    expect(Object.keys(dark.variables).length).toBeGreaterThanOrEqual(80);
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
        fill: "none",
        stroke: "currentColor",
      });
      expect(resolveDomIcon(id).label.length).toBeGreaterThan(0);
      expect(resolveDomIcon(id).paths.length).toBeGreaterThan(0);
    }
  });
});
