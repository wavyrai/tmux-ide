/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { FirstRunIntro } from "./first-run-intro.tsx";

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

function mount(node: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(node as never, host);
  return host;
}

describe("FirstRunIntro", () => {
  it("points at the canvas, dock tabs, and the platform command-palette key", () => {
    const host = mount(() => <FirstRunIntro platform="darwin" onDismiss={() => undefined} />);
    const dialog = host.querySelector('[role="dialog"].first-run-intro');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("canvas");
    expect(dialog?.textContent).toContain("Files, Changes, Missions, Activity");
    expect(dialog?.textContent).toContain("⌘K");
  });

  it("uses the Ctrl label off darwin", () => {
    const host = mount(() => <FirstRunIntro platform="linux" onDismiss={() => undefined} />);
    expect(host.querySelector(".first-run-intro")?.textContent).toContain("Ctrl K");
  });

  it("focuses the dismiss control and dismisses on click", () => {
    const onDismiss = vi.fn();
    const host = mount(() => <FirstRunIntro platform="darwin" onDismiss={onDismiss} />);
    const dismiss = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Got it",
    );
    expect(document.activeElement).toBe(dismiss);
    dismiss?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses on Escape", () => {
    const onDismiss = vi.fn();
    mount(() => <FirstRunIntro platform="darwin" onDismiss={onDismiss} />);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
