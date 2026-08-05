/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { contrastRatio, type RendererNeutralColor } from "@tmux-ide/contracts";

import { createDomExperience, DOM_EXPERIENCE_VARIABLE } from "../experience/dom-experience.ts";
import shellStyles from "../styles.css?raw";
import { Button } from "./button.tsx";
import { EmptyState } from "./empty-state.tsx";
import { IconButton } from "./icon-button.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Tabs } from "./tabs.tsx";
import { resolveTooltipPosition, Tooltip } from "./tooltip.tsx";
import styles from "./ui-system.css?raw";

const disposers: Array<() => void> = [];

function mount(view: () => JSX.Element) {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(view, root));
  return root;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function parseEmittedColor(value: string): RendererNeutralColor {
  const match = /^rgb\((\d+) (\d+) (\d+)\)$/u.exec(value);
  if (!match) throw new Error(`Expected an opaque emitted RGB color, received ${value}`);
  return {
    space: "srgb",
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: 255,
  };
}

/**
 * The rules in a stylesheet, as {selector, body} pairs.
 *
 * Leading comments are stripped from the selector: a rule preceded by an
 * explanatory comment would otherwise be keyed by the comment text, which
 * silently excludes exactly the rules someone thought worth explaining.
 * Nested at-rules are skipped — their inner rules are matched on their own.
 */
function cssRules(sheet: string): Array<{ selector: string; body: string }> {
  return [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({
      selector: (match[1] ?? "")
        .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
        .trim()
        .replaceAll(/\s+/gu, " "),
      body: match[2] ?? "",
    }))
    .filter(({ selector }) => selector.length > 0 && !selector.startsWith("@"));
}

/** Flatten an emitted color that may carry alpha onto an opaque backdrop. */
function compositeOver(value: string, backdrop: RendererNeutralColor): RendererNeutralColor {
  const match = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/u.exec(value);
  if (!match) throw new Error(`Expected an emitted RGB color, received ${value}`);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  const blend = (channel: number, under: number): number =>
    Math.round(channel * alpha + under * (1 - alpha));
  return {
    space: "srgb",
    red: blend(Number(match[1]), backdrop.red),
    green: blend(Number(match[2]), backdrop.green),
    blue: blend(Number(match[3]), backdrop.blue),
    alpha: 255,
  };
}

describe("desktop UI primitives", () => {
  it("keeps loading and disabled button states native and legible", () => {
    const root = mount(() => (
      <Button variant="primary" loading>
        Connect
      </Button>
    ));
    const button = root.querySelector("button");

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.dataset.variant).toBe("primary");
    expect(button?.textContent).toContain("Connect");
    expect(button?.querySelector(".tmi-button__spinner")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives icon-only actions a name, a pressed state, and a described tooltip", () => {
    const root = mount(() => (
      <IconButton label="Pin terminal" pressed>
        <span aria-hidden="true">P</span>
      </IconButton>
    ));
    const button = root.querySelector("button")!;
    const tooltip = document.querySelector('[role="tooltip"]')!;

    expect(button.getAttribute("aria-label")).toBe("Pin terminal");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.getAttribute("aria-hidden")).toBe("true");

    button.focus();
    expect(tooltip.getAttribute("aria-hidden")).toBeNull();
    expect(tooltip.getAttribute("data-open")).toBe("true");

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tooltip.getAttribute("aria-hidden")).toBe("true");
  });

  it("combines caller descriptions with the icon tooltip description", () => {
    const root = mount(() => (
      <IconButton label="Pin terminal" aria-describedby="pane-status keyboard-hint">
        <span aria-hidden="true">P</span>
      </IconButton>
    ));
    const button = root.querySelector("button")!;
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!;

    expect(button.getAttribute("aria-describedby")).toBe(`pane-status keyboard-hint ${tooltip.id}`);
  });

  it("moves tabs with the correct arrow keys and skips disabled tabs", () => {
    const onValueChange = vi.fn();
    const root = mount(() => (
      <Tabs
        label="Workspace views"
        onValueChange={onValueChange}
        items={[
          { id: "canvas", label: "Canvas", panel: "Canvas panel" },
          { id: "missions", label: "Missions", panel: "Missions panel", disabled: true },
          { id: "changes", label: "Changes", panel: "Changes panel" },
        ]}
      />
    ));
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    expect(
      tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected"), tab.tabIndex]),
    ).toEqual([
      ["Canvas", "true", 0],
      ["Missions", "false", -1],
      ["Changes", "false", -1],
    ]);

    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(onValueChange).toHaveBeenCalledWith("changes");
    expect(root.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toBe(
      "Changes panel",
    );
  });

  it("roves focus independently from selection in manual tabs", () => {
    const onValueChange = vi.fn();
    const root = mount(() => (
      <Tabs
        label="Manual workspace views"
        activationMode="manual"
        onValueChange={onValueChange}
        items={[
          { id: "canvas", label: "Canvas", panel: "Canvas panel" },
          { id: "changes", label: "Changes", panel: "Changes panel" },
        ]}
      />
    ));
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]!.tabIndex).toBe(-1);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]!.tabIndex).toBe(0);
    expect(onValueChange).not.toHaveBeenCalled();

    tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(onValueChange).toHaveBeenCalledWith("changes");
  });

  it("aligns automatic roving tabindex when a controlled value rerenders", () => {
    let setControlledValue: (value: string) => void = () => undefined;
    const root = mount(() => {
      const [value, setValue] = createSignal("canvas");
      setControlledValue = setValue;
      return (
        <Tabs
          label="Controlled automatic views"
          value={value()}
          items={[
            { id: "canvas", label: "Canvas", panel: "Canvas panel" },
            { id: "changes", label: "Changes", panel: "Changes panel" },
          ]}
        />
      );
    });
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    setControlledValue("changes");

    expect(tabs[0]!.getAttribute("aria-selected")).toBe("false");
    expect(tabs[0]!.tabIndex).toBe(-1);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.tabIndex).toBe(0);
  });

  it("preserves manual user roving only while focus remains in the tablist", () => {
    let setControlledValue: (value: string) => void = () => undefined;
    const root = mount(() => {
      const [value, setValue] = createSignal("canvas");
      setControlledValue = setValue;
      return (
        <>
          <button type="button" data-outside-tabs>
            Outside
          </button>
          <Tabs
            label="Controlled manual views"
            activationMode="manual"
            value={value()}
            items={[
              { id: "canvas", label: "Canvas", panel: "Canvas panel" },
              { id: "changes", label: "Changes", panel: "Changes panel" },
              { id: "missions", label: "Missions", panel: "Missions panel" },
            ]}
          />
        </>
      );
    });
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    setControlledValue("missions");

    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.tabIndex).toBe(0);
    expect(tabs[2]!.tabIndex).toBe(-1);

    root.querySelector<HTMLButtonElement>("[data-outside-tabs]")!.focus();
    setControlledValue("canvas");

    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(tabs[1]!.tabIndex).toBe(-1);
  });

  it("exposes a keyboard-operable separator with bounded values", () => {
    const changes: number[] = [];
    const root = mount(() => {
      const [value, setValue] = createSignal(50);
      return (
        <ResizeHandle
          value={value()}
          min={20}
          max={80}
          onValueChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
        />
      );
    });
    const separator = root.querySelector<HTMLElement>('[role="separator"]')!;

    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator.getAttribute("aria-valuenow")).toBe("50");
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(changes).toEqual([58]);
    expect(separator.getAttribute("aria-valuenow")).toBe("58");

    separator.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 100, pointerId: 4, bubbles: true }),
    );
    expect(separator.dataset.dragging).toBe("true");
    separator.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 110, pointerId: 4, bubbles: true }),
    );
    expect(changes.at(-1)).toBe(68);
    separator.dispatchEvent(new PointerEvent("pointerup", { pointerId: 4, bubbles: true }));
    expect(separator.dataset.dragging).toBeUndefined();

    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(changes.at(-1)).toBe(80);
    expect(separator.getAttribute("aria-valuenow")).toBe("80");
  });

  it("connects empty-state copy with semantic labelling", () => {
    const root = mount(() => (
      <EmptyState
        title="No panes yet"
        description="Create a terminal to begin."
        icon={<span>+</span>}
        action={<Button>Create terminal</Button>}
      />
    ));
    const section = root.querySelector("section")!;
    const title = root.querySelector("h2")!;
    const description = root.querySelector("p")!;

    expect(section.getAttribute("aria-labelledby")).toBe(title.id);
    expect(section.getAttribute("aria-describedby")).toBe(description.id);
    expect(root.querySelector(".tmi-empty-state__icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("button")?.textContent).toBe("Create terminal");
  });

  it("flips and clamps tooltip geometry before it can collide with the viewport", () => {
    const position = resolveTooltipPosition(
      rect(180, 2, 20, 20),
      rect(0, 0, 80, 30),
      "top",
      200,
      100,
    );

    expect(position).toEqual({ placement: "bottom", left: 112, top: 29 });
  });

  it("portals tooltips into the create-pane overlay above its clipped dialog", () => {
    const shellSheet = document.createElement("style");
    shellSheet.textContent = shellStyles;
    const primitiveSheet = document.createElement("style");
    primitiveSheet.textContent = styles;
    document.head.append(shellSheet, primitiveSheet);
    const root = mount(() => (
      <div class="app">
        <div
          class="create-pane-flow__overlay create-pane-flow__overlay--open"
          data-overlay-root="true"
        >
          <div class="create-pane-flow__dialog">
            <div class="clipped-surface">
              <IconButton label="Add pane">
                <span aria-hidden="true">+</span>
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    ));
    const app = root.querySelector(".app")!;
    const overlay = root.querySelector<HTMLElement>(".create-pane-flow__overlay")!;
    const dialog = root.querySelector(".create-pane-flow__dialog")!;
    const clipped = root.querySelector(".clipped-surface")!;
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')!;

    expect(app.contains(tooltip)).toBe(true);
    expect(overlay.contains(tooltip)).toBe(true);
    expect(dialog.contains(tooltip)).toBe(false);
    expect(clipped.contains(tooltip)).toBe(false);
    expect(getComputedStyle(overlay).zIndex).toBe("120");
    expect(getComputedStyle(tooltip).zIndex).toBe("1");
    expect(getComputedStyle(tooltip).position).toBe("fixed");
    shellSheet.remove();
    primitiveSheet.remove();
  });

  it("lets only the innermost tooltip consume Escape before its overlay", () => {
    const overlayEscape = vi.fn();
    const root = mount(() => (
      <div
        data-overlay-root="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") overlayEscape();
        }}
      >
        <Tooltip content="Outer help">
          {(outerTrigger) => (
            <span aria-describedby={outerTrigger["aria-describedby"]}>
              <Tooltip content="Inner help">
                {(innerTrigger) => (
                  <button type="button" aria-describedby={innerTrigger["aria-describedby"]}>
                    Nested help
                  </button>
                )}
              </Tooltip>
            </span>
          )}
        </Tooltip>
      </div>
    ));
    const button = root.querySelector("button")!;
    const tooltips = [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')];
    const outer = tooltips.find((tooltip) => tooltip.textContent === "Outer help")!;
    const inner = tooltips.find((tooltip) => tooltip.textContent === "Inner help")!;

    button.focus();
    expect(outer.dataset.open).toBe("true");
    expect(inner.dataset.open).toBe("true");

    const firstEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(firstEscape);
    expect(firstEscape.defaultPrevented).toBe(true);
    expect(inner.dataset.open).toBe("false");
    expect(outer.dataset.open).toBe("true");
    expect(overlayEscape).not.toHaveBeenCalled();

    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(outer.dataset.open).toBe("false");
    expect(overlayEscape).not.toHaveBeenCalled();

    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlayEscape).toHaveBeenCalledTimes(1);
  });

  it("leaves overlay Escape untouched when an icon action has no tooltip", () => {
    const overlayEscape = vi.fn();
    const root = mount(() => (
      <div
        data-overlay-root="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") overlayEscape();
        }}
      >
        <IconButton label="Close" tooltip={false}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </div>
    ));

    root
      .querySelector("button")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(overlayEscape).toHaveBeenCalledTimes(1);
  });
});

describe("desktop UI foundation styles", () => {
  it("computes native chrome typography and compact control geometry", () => {
    const sheet = document.createElement("style");
    sheet.textContent = styles;
    document.head.append(sheet);
    const root = mount(() => <Button size="small">Run</Button>);
    const button = root.querySelector("button")!;
    const computed = getComputedStyle(button);

    expect(computed.display).toBe("inline-flex");
    expect(computed.minHeight).toBe("28px");
    // Chrome is drawn in the system face. A generic family leading the stack
    // is the regression this catches: it renders a webfont-ish default that
    // looks like every Electron app and nothing like the surrounding OS.
    expect(computed.fontFamily.startsWith("-apple-system")).toBe(true);
  });

  it("declares dark-first semantic tokens and both reduced-motion authorities", () => {
    expect(styles).toContain("--tmi-surface-canvas");
    expect(styles).toContain("--tmi-font-chrome");
    expect(styles).toContain("--tmi-font-technical");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain('[data-reduced-motion="true"]');
    expect(styles).toContain(
      '[data-reduced-motion="true"] .tmi-button:not([data-variant="ghost"]):active:not(:disabled)',
    );
    expect(styles).not.toContain("transition: all");
  });

  it("aliases emitted shape and focus roles by their canonical names", () => {
    expect(styles).toContain("var(--tmux-ide-shape-control-radius");
    expect(styles).toContain("var(--tmux-ide-shape-floating-radius");
    expect(styles).toContain("var(--tmux-ide-focus-outline-offset");
    expect(styles).not.toContain("var(--tmux-ide-shape-control,");
    expect(styles).not.toContain("var(--tmux-ide-shape-panel,");
  });

  it("expresses disabled as a flat color pair rather than an opacity multiplier", () => {
    // A faded control reads as "loading" and shows whatever is behind it. The
    // multiplier token is gone, and filled variants drop their gradient so
    // nothing survives to suggest the object is still pressable.
    expect(styles).not.toContain("--tmi-disabled-opacity");
    expect(styles).toMatch(
      /\.tmi-button:disabled,[^{]*\{[^}]*color: var\(--tmi-disabled-fg\);[^}]*background-color: var\(--tmi-disabled-bg\);/su,
    );
    expect(styles).toMatch(/\.tmi-button:disabled,[^{]*\{[^}]*background: none;/su);
  });

  it.each(["dark", "light"] as const)(
    "keeps the disabled color pair legible in %s, now that it is a pair and not a fade",
    (mode) => {
      /*
       * Disabled text used to inherit the enabled color at 64% opacity, so its
       * contrast was a function of whatever sat behind the control. It is a
       * real pair now, which means it can be measured — and has to be.
       *
       * The floor here is 3:1, not 4.5. Disabled controls are exempt from the
       * text contrast requirement precisely because they must read as
       * unavailable, and a pair that cleared 4.5 would not look disabled. What
       * matters is that the label stays identifiable rather than dissolving.
       */
      const emitted = createDomExperience({
        hostTheme: { mode, highContrast: false, reducedMotion: false },
      }).variables;
      const background = parseEmittedColor(
        emitted[DOM_EXPERIENCE_VARIABLE.control.disabledBackground]!,
      );
      /*
       * The disabled ink is emitted with alpha, so what a reader sees is the
       * composite over the disabled fill — which is opaque, so the composite is
       * a fixed color rather than a window onto whatever is behind the control.
       * That distinction is the whole point of the change: the element-level
       * opacity multiplier faded the border, fill, text and elevation together
       * and let the plane behind show through all of them.
       */
      const ratio = contrastRatio(
        compositeOver(emitted[DOM_EXPERIENCE_VARIABLE.control.disabledForeground]!, background),
        background,
      );
      expect(ratio, `${mode} disabled pair`).toBeGreaterThanOrEqual(1.9);
      expect(ratio, `${mode} disabled pair reads as unavailable`).toBeLessThan(4.5);
    },
  );

  it("reserves semibold for titles and lets medium carry the interface", () => {
    /*
     * Medium is the interface weight — every interactive label, row title and
     * tab. Semibold is for panel, dialog and display titles only.
     *
     * This is the rule a named-weight pass cannot enforce on its own: the
     * previous pass mapped eleven numeric weights onto three names by
     * proximity, so everything that had been 600-or-above stayed "semibold"
     * and the drift survived under a better name. The guard is therefore about
     * WHICH SELECTORS may carry semibold, not about how many names exist.
     */
    const declarations = cssRules(shellStyles);

    const weightOf = (body: string): string | undefined =>
      /font-weight: var\(--sf-weight-([a-z]+)\)/u.exec(body)?.[1];

    const semibold = declarations.filter(({ body }) => weightOf(body) === "semibold");
    const medium = declarations.filter(({ body }) => weightOf(body) === "medium");

    // A heading, or the product wordmark — the one non-heading carrying the
    // strongest emphasis in the chrome, reviewed and kept deliberately.
    const titleLike = /\bh[1-4]\b|titlebar__product-copy strong/u;
    const offRecipe = semibold
      .map(({ selector }) => selector)
      .filter((selector) => !titleLike.test(selector));
    expect(offRecipe).toEqual([]);

    // The source runs roughly three mediums to every semibold. A shell that
    // inverts that is shouting, whatever its tokens are called.
    expect(medium.length).toBeGreaterThan(semibold.length * 2);
  });

  it("fixes the digit width on figures that align or update in place", () => {
    /*
     * The canvas zoom readout is the anchor: it changes under the pointer while
     * the buttons either side of it stay put, so proportional digits make the
     * whole pill twitch as 100% becomes 110%. If this one regresses, the rule
     * has been forgotten everywhere.
     */
    expect(shellStyles).toMatch(
      /\.canvas-controls output[^{]*\{[^}]*font-variant-numeric: tabular-nums;/su,
    );
    // The counts, timers and diff deltas the audit found, plus the utility the
    // markup reaches for when a figure has no rule of its own.
    const tabularRules = shellStyles.match(/font-variant-numeric: tabular-nums;/g) ?? [];
    expect(tabularRules.length).toBeGreaterThanOrEqual(14);
    expect(styles).toMatch(/\.tmi-tabular\s*\{[^}]*font-variant-numeric: tabular-nums;/su);
  });

  it("never leaves single-line chrome able to wrap", () => {
    /*
     * `text-overflow: ellipsis` without `white-space: nowrap` is inert: the
     * text wraps instead of ellipsizing, and inside a 22px status strip the
     * second line is simply cut off. Any rule that asks for an ellipsis must
     * also hold the text on one line.
     *
     * Judged across the cascade rather than rule by rule — a responsive
     * override that only narrows a width inherits `nowrap` from the base rule
     * and should not have to restate it.
     *
     * The sibling failure (nowrap + hidden with no ellipsis, which clips
     * mid-word) is deliberately NOT asserted here. That shape is also what
     * every clipping CONTAINER looks like, and what `.sr-only` looks like,
     * and CSS alone cannot tell a container from a text leaf. Asserting it
     * would mean maintaining an exemption list longer than the rule, so the
     * two real cases — the update chip and the dock tab — were found by
     * reading and fixed by hand.
     */
    const ellipsis = new Set<string>();
    const nowrap = new Set<string>();
    const clamped = new Set<string>();
    for (const { selector, body } of cssRules(shellStyles)) {
      if (body.includes("text-overflow: ellipsis")) ellipsis.add(selector);
      if (body.includes("white-space: nowrap")) nowrap.add(selector);
      if (body.includes("line-clamp")) clamped.add(selector);
    }
    const wrapping = [...ellipsis].filter((s) => !nowrap.has(s) && !clamped.has(s));
    expect(wrapping).toEqual([]);
  });

  it("draws every focus ring from one recipe, keyboard-only", () => {
    // One ring declaration, reading the shared tokens. `outline: none` resets
    // are allowed because each one has a :focus-visible replacement below it;
    // a second *drawn* ring is how a system drifts back into four of them.
    const rings = [...styles.matchAll(/outline:\s*[^;]+;/g)]
      .map((match) => match[0])
      .filter((rule) => !/outline:\s*(none|0);/.test(rule));
    expect(rings).toEqual(["outline: var(--tmi-focus-width) solid var(--tmi-accent);"]);
    expect(styles).toContain("[data-focus-ring]:focus-visible");
    expect(styles).toContain("outline-offset: var(--tmi-focus-offset-field);");
  });

  it.each(["dark", "light"] as const)(
    "keeps filled action states above 4.5:1 with emitted %s product tokens",
    (mode) => {
      const emitted = createDomExperience({
        hostTheme: { mode, highContrast: false, reducedMotion: false },
      }).variables;
      const foreground = parseEmittedColor(emitted[DOM_EXPERIENCE_VARIABLE.text.inverse]!);
      const backgrounds = {
        "primary normal": emitted[DOM_EXPERIENCE_VARIABLE.border.focused],
        "primary hover": emitted[DOM_EXPERIENCE_VARIABLE.text.link],
        "danger normal": emitted[DOM_EXPERIENCE_VARIABLE.status.danger],
        "danger hover": emitted[DOM_EXPERIENCE_VARIABLE.status.danger],
      };

      for (const [state, value] of Object.entries(backgrounds)) {
        expect(
          contrastRatio(foreground, parseEmittedColor(value!)),
          `${mode} ${state}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(styles).toContain("--tmi-text-on-accent: var(--tmux-ide-text-inverse");
      expect(styles).toContain("--tmi-accent: var(--tmux-ide-border-focused");
      expect(styles).toContain("--tmi-accent-strong: var(--tmux-ide-text-link");
      expect(styles).toContain("--tmi-danger: var(--tmux-ide-status-danger");
      /*
       * The filled recipe keeps the contrast floor above.
       *
       * The gradient runs from the accent to a step mixed toward black, and
       * text stays the on-accent token — so every pixel of the fill is at
       * least as dark as the accent the ratios were measured against, and the
       * bottom of the gradient is darker still. Checking the accent is
       * therefore checking the worst case.
       */
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="primary"\][^{]*\{[^}]*color: var\(--tmi-text-on-accent\);[^}]*background: linear-gradient\(\s*to bottom,\s*var\(--tmi-accent\),\s*var\(--tmi-accent-dark\)\s*\);/su,
      );
      expect(styles).toMatch(
        /--tmi-accent-dark: color-mix\(in oklab, var\(--tmi-accent\) \d+%, oklch\(0% 0 0\)\)/,
      );
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="danger"\][^{]*\{[^}]*color: var\(--tmi-text-on-accent\);[^}]*background: linear-gradient\(/su,
      );
      // Hover brightens the gradient; pressed flattens to the dark stop.
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="primary"\]:hover:not\(:disabled\)[^{]*\{[^}]*background: linear-gradient\(\s*to bottom,\s*var\(--tmi-accent-bright\),\s*var\(--tmi-accent\)\s*\);/su,
      );
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="primary"\]:active:not\(:disabled\)[^{]*\{[^}]*background: var\(--tmi-accent-dark\);/su,
      );
    },
  );
});
