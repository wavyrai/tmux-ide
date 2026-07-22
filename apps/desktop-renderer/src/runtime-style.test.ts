/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";

import { createRuntimeStyleBinding } from "./runtime-style.ts";
import runtimeStyles from "./runtime-styles.css?raw";

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("strict-CSP runtime styles", () => {
  it("updates and removes an external CSSOM rule without creating inline style", () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = runtimeStyles;
    document.head.append(stylesheet);
    const element = document.createElement("article");
    document.body.append(element);

    const binding = createRuntimeStyleBinding(element);
    binding.update({ left: "42px", width: "360px", height: "220px" });

    expect(element.getAttribute("style")).toBeNull();
    expect(element.dataset.tmiRuntimeStyle).toBe(binding.key);
    const rule = [...stylesheet.sheet!.cssRules].find(
      (candidate) =>
        candidate instanceof CSSStyleRule && candidate.selectorText.includes(binding.key),
    ) as CSSStyleRule;
    expect(rule.style.left).toBe("42px");
    expect(rule.style.width).toBe("360px");

    binding.update({ left: "8px" });
    expect(rule.style.left).toBe("8px");
    expect(rule.style.width).toBe("");

    binding.dispose();
    expect(element.dataset.tmiRuntimeStyle).toBeUndefined();
    expect([...stylesheet.sheet!.cssRules]).not.toContain(rule);
  });
});
