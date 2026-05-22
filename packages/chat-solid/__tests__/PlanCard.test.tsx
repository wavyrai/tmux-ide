import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { PlanCard } from "../src/components/PlanCard";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PlanCard", () => {
  it("cycles status icons locally", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <PlanCard entries={[{ content: "Inspect", status: "pending" }]} />, container);

    const button = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Cycle status for Inspect']",
    );
    expect(button?.textContent).toBe("○");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const inProgress = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Cycle status for Inspect']",
    );
    expect(inProgress?.textContent).toBe("…");
    inProgress?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const completed = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Cycle status for Inspect']",
    );
    expect(completed?.textContent).toBe("✓");
  });

  it("adds user steps inline", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <PlanCard entries={[{ content: "Inspect" }]} />, container);

    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "+ Add step")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const input = container.querySelector<HTMLInputElement>("input[aria-label='New plan step']");
    expect(input).toBeTruthy();
    input!.value = "Write tests";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(container.textContent).toContain("Write tests");
    expect(container.textContent).toContain("(yours)");
  });

  it("sends the edited plan markdown to the callback", () => {
    const onSendPlanRequest = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => (
        <PlanCard
          entries={[{ content: "Inspect", status: "pending" }]}
          onSendPlanRequest={onSendPlanRequest}
        />
      ),
      container,
    );

    container
      .querySelector<HTMLButtonElement>("button[aria-label='Cycle status for Inspect']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Send plan to agent")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onSendPlanRequest).toHaveBeenCalledWith("Updated plan:\n\n- [-] Inspect");
  });
});
