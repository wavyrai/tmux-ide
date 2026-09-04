import { describe, expect, it } from "vitest";
import { createHomeAgentSelectionOwner } from "./application-home-agent-selection.ts";

const row = (key: string, paneId: string | null = key) => ({ key, paneId });

describe("resident Home agent selection", () => {
  it("keeps identity and a visible scroll position when attention reorders the list", () => {
    const owner = createHomeAgentSelectionOwner();
    owner.setViewport(2);
    owner.setRows([row("a"), row("b"), row("c"), row("d")]);
    owner.select("c");
    expect(owner.snapshot()).toEqual({ selectedKey: "c", scrollOffset: 1 });
    owner.setRows([row("d"), row("c"), row("a"), row("b")]);
    expect(owner.snapshot()).toEqual({ selectedKey: "c", scrollOffset: 1 });
    owner.setRows([row("c"), row("d"), row("a"), row("b")]);
    expect(owner.snapshot()).toEqual({ selectedKey: "c", scrollOffset: 0 });
  });

  it("falls to the nearest actionable row when the selection disappears", () => {
    const owner = createHomeAgentSelectionOwner();
    owner.setRows([row("a"), row("b"), row("c"), row("d")]);
    owner.select("b");
    owner.setRows([row("a"), row("c", null), row("d")]);
    expect(owner.snapshot().selectedKey).toBe("d");
    owner.setRows([row("a"), row("c", null)]);
    expect(owner.snapshot().selectedKey).toBe("a");
    owner.setRows([row("c", null)]);
    expect(owner.snapshot().selectedKey).toBeNull();
  });

  it("skips disabled rows without wrapping and refuses stale selection targets", () => {
    const owner = createHomeAgentSelectionOwner();
    owner.setRows([row("a"), row("b", null), row("c")]);
    owner.move(1);
    expect(owner.snapshot().selectedKey).toBe("c");
    owner.move(1);
    owner.select("missing");
    owner.select("b");
    expect(owner.snapshot().selectedKey).toBe("c");
    owner.move(-1);
    expect(owner.snapshot().selectedKey).toBe("a");
    owner.move(-1);
    expect(owner.snapshot().selectedKey).toBe("a");
  });

  it("retains state between subscribers and fits a changed viewport on return", () => {
    const owner = createHomeAgentSelectionOwner();
    owner.setRows([row("a"), row("b"), row("c"), row("d")]);
    owner.setViewport(2);
    const changes: string[] = [];
    const stop = owner.subscribe((state) => changes.push(state.selectedKey!));
    owner.select("d");
    stop();
    expect(owner.snapshot()).toEqual({ selectedKey: "d", scrollOffset: 2 });
    owner.setViewport(4);
    expect(owner.snapshot()).toEqual({ selectedKey: "d", scrollOffset: 0 });
    expect(changes).toEqual(["d"]);
  });

  it("handles empty data and disposal without retaining listeners", () => {
    const owner = createHomeAgentSelectionOwner();
    let calls = 0;
    owner.subscribe(() => calls++);
    owner.setViewport(0);
    owner.setRows([row("a")]);
    owner.setRows([]);
    expect(owner.snapshot()).toEqual({ selectedKey: null, scrollOffset: 0 });
    expect(calls).toBe(2);
    owner.dispose();
    owner.setRows([row("b")]);
    owner.select("b");
    owner.move(1);
    expect(calls).toBe(2);
  });
});
