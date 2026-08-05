/* @vitest-environment happy-dom */
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { Folder01Icon, Home01Icon } from "@hugeicons/core-free-icons";

import {
  ICON_SIZE,
  ICON_STROKE_WIDTH,
  ICON_STROKE_WIDTH_LARGE,
  Icon,
  iconNodeAttributes,
  resolveIconSize,
} from "./icon.tsx";
import { WorkspaceIdentity, workspaceIdentityDotSize } from "./workspace-identity.tsx";

const disposers: Array<() => void> = [];

function mount(component: () => import("solid-js").JSX.Element): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  disposers.push(render(component, host));
  return host;
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

describe("Icon", () => {
  it("draws library artwork at the control size and the system stroke weight", () => {
    const svg = mount(() => <Icon icon={Home01Icon} />).querySelector("svg");
    expect(svg?.getAttribute("width")).toBe(String(ICON_SIZE.control));
    expect(svg?.getAttribute("height")).toBe(String(ICON_SIZE.control));
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("stroke-width")).toBe(String(ICON_STROKE_WIDTH));
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("owns stroke presentation, so the library's baked-in weight cannot leak through", () => {
    // Every node the library ships carries its own stroke-width; if any of them
    // reached the DOM, the component's weight control would be a suggestion.
    const svg = mount(() => <Icon icon={Home01Icon} strokeWidth={3} />).querySelector("svg");
    expect(svg?.getAttribute("stroke-width")).toBe("3");
    for (const node of svg?.querySelectorAll("*") ?? []) {
      expect(node.getAttribute("stroke-width")).toBeNull();
      expect(node.getAttribute("stroke")).toBeNull();
    }
  });

  it("steps decorative sizes down to the lighter weight", () => {
    const large = mount(() => <Icon icon={Home01Icon} size="empty" />).querySelector("svg");
    expect(large?.getAttribute("stroke-width")).toBe(String(ICON_STROKE_WIDTH_LARGE));
  });

  it("resolves every ladder name to its pixel size", () => {
    expect(resolveIconSize(undefined)).toBe(ICON_SIZE.control);
    expect(resolveIconSize("dense")).toBe(14);
    expect(resolveIconSize("hero")).toBe(40);
    expect(resolveIconSize(18)).toBe(18);
  });

  it("keeps geometry, renames framework-cased attributes, and drops the list key", () => {
    expect(
      iconNodeAttributes({ d: "M0 0", key: "0", fillRule: "evenodd", strokeWidth: "1.5" }),
    ).toEqual({ d: "M0 0", "fill-rule": "evenodd" });
  });

  it("is hidden when decorative and named when labelled", () => {
    const bare = mount(() => <Icon icon={Home01Icon} />).querySelector("svg");
    expect(bare?.getAttribute("aria-hidden")).toBe("true");
    expect(bare?.getAttribute("role")).toBeNull();

    const named = mount(() => <Icon icon={Home01Icon} label="Home" />).querySelector("svg");
    expect(named?.getAttribute("role")).toBe("img");
    expect(named?.getAttribute("aria-label")).toBe("Home");
  });
});

describe("WorkspaceIdentity", () => {
  it("prefers the emoji the user chose", () => {
    const host = mount(() => <WorkspaceIdentity emoji="🚀" color="#f00" />);
    expect(host.textContent).toBe("🚀");
    expect(host.querySelector("svg")).toBeNull();
  });

  it("falls back to a color dot when there is no emoji", () => {
    const dot = mount(() => <WorkspaceIdentity color="#ff0000" size={16} />).querySelector("span");
    expect(dot?.getAttribute("style")).toContain("#ff0000");
    expect(dot?.getAttribute("style")).toContain(`${workspaceIdentityDotSize(16)}px`);
  });

  it("falls back to the folder glyph when there is neither", () => {
    const svg = mount(() => <WorkspaceIdentity />).querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll("path").length).toBe(Folder01Icon.length);
  });

  it("keeps the dot readable at the smallest sizes", () => {
    expect(workspaceIdentityDotSize(8)).toBe(8);
    expect(workspaceIdentityDotSize(20)).toBe(12);
  });
});
