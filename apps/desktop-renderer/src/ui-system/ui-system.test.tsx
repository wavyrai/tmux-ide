/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { contrastRatio, type RendererNeutralColor } from "@tmux-ide/contracts";

import { createDomExperience, DOM_EXPERIENCE_VARIABLE } from "../experience/dom-experience.ts";
import { Button } from "./button.tsx";
import { EmptyState } from "./empty-state.tsx";
import { IconButton } from "./icon-button.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Tabs } from "./tabs.tsx";
import { resolveTooltipPosition } from "./tooltip.tsx";
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

  it("portals tooltips to the theme root outside clipped feature surfaces", () => {
    const root = mount(() => (
      <div class="app">
        <div class="clipped-surface">
          <IconButton label="Add pane">
            <span aria-hidden="true">+</span>
          </IconButton>
        </div>
      </div>
    ));
    const app = root.querySelector(".app")!;
    const clipped = root.querySelector(".clipped-surface")!;
    const tooltip = document.querySelector('[role="tooltip"]')!;

    expect(app.contains(tooltip)).toBe(true);
    expect(clipped.contains(tooltip)).toBe(false);
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
    expect(computed.fontFamily).toContain("ui-sans-serif");
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
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="primary"\][^{]*\{[^}]*color: var\(--tmi-text-on-accent\);[^}]*background: var\(--tmi-accent\);/su,
      );
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="danger"\][^{]*\{[^}]*color: var\(--tmi-text-on-accent\);[^}]*background: var\(--tmi-danger\);/su,
      );
      expect(styles).toMatch(
        /\.tmi-button\[data-variant="primary"\]:hover:not\(:disabled\)[^{]*\{[^}]*background: var\(--tmi-accent-strong\);/su,
      );
    },
  );
});
