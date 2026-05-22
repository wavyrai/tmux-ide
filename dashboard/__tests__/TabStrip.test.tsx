/**
 * TabStrip — unified segmented-tab control.
 *
 * Verifies items render, the active id gets the active marker, clicks
 * call onSelect, and arrow-key navigation cycles the active id.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import { TabStrip } from "@/components/ui/TabStrip";

afterEach(() => cleanup());

function harness(initial: "a" | "b" | "c" = "a") {
  const [active, setActive] = createSignal<"a" | "b" | "c">(initial);
  const onSelect = vi.fn((next: "a" | "b" | "c") => setActive(next));
  const utils = render(() => (
    <TabStrip<"a" | "b" | "c">
      items={[
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
        { id: "c", label: "Charlie" },
      ]}
      activeId={active()}
      onSelect={onSelect}
      testid="ts"
      containerTestid="ts-list"
      ariaLabel="Test tabs"
    />
  ));
  return { ...utils, onSelect, active };
}

describe("TabStrip", () => {
  it("renders every item with the expected label and role", () => {
    const { getByTestId } = harness();
    expect(getByTestId("ts-list")).toBeInTheDocument();
    expect(getByTestId("ts-list").getAttribute("role")).toBe("tablist");
    for (const id of ["a", "b", "c"]) {
      const tab = getByTestId(`ts-${id}`);
      expect(tab).toBeInTheDocument();
      expect(tab.getAttribute("role")).toBe("tab");
    }
  });

  it("marks the active item with data-active and aria-selected", () => {
    const { getByTestId } = harness("b");
    expect(getByTestId("ts-a").getAttribute("data-active")).toBeNull();
    expect(getByTestId("ts-a").getAttribute("aria-selected")).toBe("false");
    expect(getByTestId("ts-b").getAttribute("data-active")).toBe("true");
    expect(getByTestId("ts-b").getAttribute("aria-selected")).toBe("true");
  });

  it("calls onSelect when an item is clicked", () => {
    const { getByTestId, onSelect } = harness();
    fireEvent.click(getByTestId("ts-c"));
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("ArrowRight advances and ArrowLeft retreats the active item", () => {
    const { getByTestId, onSelect, active } = harness("a");
    fireEvent.keyDown(getByTestId("ts-list"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    expect(active()).toBe("b");
    fireEvent.keyDown(getByTestId("ts-list"), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    expect(active()).toBe("c");
    fireEvent.keyDown(getByTestId("ts-list"), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenLastCalledWith("b");
    expect(active()).toBe("b");
  });

  it("Home/End jump to the first/last item", () => {
    const { getByTestId, onSelect, active } = harness("b");
    fireEvent.keyDown(getByTestId("ts-list"), { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("c");
    expect(active()).toBe("c");
    fireEvent.keyDown(getByTestId("ts-list"), { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("a");
    expect(active()).toBe("a");
  });

  it("does not select disabled items via click", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(() => (
      <TabStrip
        items={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Bravo", disabled: true },
        ]}
        activeId="a"
        onSelect={onSelect}
        testid="ts"
      />
    ));
    fireEvent.click(getByTestId("ts-b"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders pill variant via data-variant attribute", () => {
    const { getByTestId } = render(() => (
      <TabStrip
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
        activeId="a"
        onSelect={() => {}}
        variant="pill"
        containerTestid="pill-list"
      />
    ));
    expect(getByTestId("pill-list").getAttribute("data-variant")).toBe("pill");
  });
});
