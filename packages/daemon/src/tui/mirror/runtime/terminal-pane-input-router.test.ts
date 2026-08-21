import { describe, expect, test } from "bun:test";

import { TerminalPaneInputRouter } from "./terminal-pane-input-router.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("TerminalPaneInputRouter", () => {
  test("current canonical pane selection is a no-op and input sends once", async () => {
    const selected: string[] = [];
    const sent: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: async (paneId) => (selected.push(paneId), true),
      send: async (paneId, input) => void sent.push(`${paneId}:${input}`),
      onFocusedPane: () => undefined,
    });
    router.adoptCanonicalPane("one");
    router.selectPane("one");
    router.selectPane("one");
    await expect(router.sendInputToPane("one", "mouse-down")).resolves.toBe(true);
    expect(selected).toEqual([]);
    expect(sent).toEqual(["one:mouse-down"]);
  });

  test("duplicate pending same-pane selection reuses one receipt and one ordered send", async () => {
    const selection = deferred<boolean>();
    const selected: string[] = [];
    const sent: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: (paneId) => (selected.push(paneId), selection.promise),
      send: async (paneId, input) => void sent.push(`${paneId}:${input}`),
      onFocusedPane: () => undefined,
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    const pending = router.sendInputToPane("two", "mouse-down");
    router.selectPane("two");
    expect(selected).toEqual(["two"]);
    expect(sent).toEqual([]);
    selection.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(sent).toEqual(["two:mouse-down"]);
  });

  test("keeps the optimistic pane through stale layout and orders first input after selection", async () => {
    const selection = deferred<boolean>();
    const events: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: async (paneId) => {
        events.push(`select:${paneId}`);
        return await selection.promise;
      },
      send: async (paneId, input) => {
        events.push(`send:${paneId}:${input}`);
      },
      onFocusedPane: (paneId) => events.push(`focus:${paneId}`),
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    router.adoptCanonicalPane("one");
    const sent = router.sendInput("x");

    await Promise.resolve();
    expect(events).toEqual(["focus:one", "focus:two", "select:two"]);
    selection.resolve(true);

    await expect(sent).resolves.toBe(true);
    expect(events.at(-1)).toBe("send:two:x");
  });

  test("failed selection drops queued input and rolls back to the canonical pane", async () => {
    const selection = deferred<boolean>();
    const sent: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId) => void sent.push(paneId),
      onFocusedPane: () => undefined,
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    const result = router.sendInput("x");
    selection.resolve(false);

    await expect(result).resolves.toBe(false);
    expect(router.focusedPane).toBe("one");
    expect(sent).toEqual([]);
  });

  test("pane-targeted input refuses an unrelated visible or pending owner", async () => {
    const sent: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: async () => true,
      send: async (paneId) => void sent.push(paneId),
      onFocusedPane: () => undefined,
    });
    router.adoptCanonicalPane("one");
    await expect(router.sendInputToPane("two", "wrong")).resolves.toBe(false);
    await expect(router.sendInputToPane("one", "right")).resolves.toBe(true);
    expect(sent).toEqual(["one"]);
  });

  test("pane-targeted app input waits for the exact pending pane receipt", async () => {
    const selection = deferred<boolean>();
    const sent: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId, input) => void sent.push(`${paneId}:${input}`),
      onFocusedPane: () => undefined,
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    const pending = router.sendInputToPane("two", "mouse");
    await Promise.resolve();
    expect(sent).toEqual([]);
    selection.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(sent).toEqual(["two:mouse"]);
  });

  test("retains an optimistic target through a stale layout after the selection receipt", async () => {
    const selection = deferred<boolean>();
    const events: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId, input) => void events.push(`send:${paneId}:${input}`),
      onFocusedPane: (paneId) => events.push(`focus:${paneId}`),
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    selection.resolve(true);
    await selection.promise;
    await Promise.resolve();

    router.adoptCanonicalPane("one");
    expect(router.focusedPane).toBe("two");
    await expect(router.sendInput("after-stale-layout")).resolves.toBe(true);
    expect(events).toEqual(["focus:one", "focus:two", "send:two:after-stale-layout"]);

    router.adoptCanonicalPane("two");
    expect(router.focusedPane).toBe("two");
  });

  test("routes queued cycle input to the pending pane without presenting it before layout", async () => {
    const selection = deferred<boolean>();
    const events: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId, input) => void events.push(`send:${paneId}:${input}`),
      onFocusedPane: (paneId) => events.push(`focus:${paneId}`),
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two", { presentOptimistically: false });
    const sent = router.sendInput("x");
    expect(router.focusedPane).toBe("one");
    expect(events).toEqual(["focus:one"]);
    selection.resolve(true);
    await expect(sent).resolves.toBe(true);
    expect(events).toEqual(["focus:one", "send:two:x"]);
    router.adoptCanonicalPane("two");
    expect(router.focusedPane).toBe("two");
  });

  test("retains a successful cycle routing target through the receipt-to-layout gap", async () => {
    const selection = deferred<boolean>();
    const events: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId, input) => void events.push(`send:${paneId}:${input}`),
      onFocusedPane: (paneId) => events.push(`focus:${paneId}`),
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two", { presentOptimistically: false });
    selection.resolve(true);
    await selection.promise;
    await Promise.resolve();

    expect(router.focusedPane).toBe("one");
    await expect(router.sendInput("after-receipt")).resolves.toBe(true);
    expect(events).toEqual(["focus:one", "send:two:after-receipt"]);

    router.adoptCanonicalPane("two");
    await expect(router.sendInput("after-layout")).resolves.toBe(true);
    expect(events).toEqual([
      "focus:one",
      "send:two:after-receipt",
      "focus:two",
      "send:two:after-layout",
    ]);
  });

  test("a superseding selection fences the earlier pane's queued input", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const sent: string[] = [];
    const router = new TerminalPaneInputRouter<string>({
      select: (paneId) => (paneId === "two" ? first.promise : second.promise),
      send: async (paneId) => void sent.push(paneId),
      onFocusedPane: () => undefined,
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    const staleSend = router.sendInput("old");
    router.selectPane("three");
    first.resolve(true);
    second.resolve(true);

    await expect(staleSend).resolves.toBe(false);
    await expect(router.sendInput("new")).resolves.toBe(true);
    expect(sent).toEqual(["three"]);
  });

  test("generation invalidation retires a successful deferred target without blanking presentation", async () => {
    const selection = deferred<boolean>();
    const sent: string[] = [];
    const focused: Array<string | null> = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId) => void sent.push(paneId),
      onFocusedPane: (paneId) => focused.push(paneId),
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two", { presentOptimistically: false });
    selection.resolve(true);
    await selection.promise;
    await Promise.resolve();

    router.invalidateSelection();
    expect(router.focusedPane).toBe("one");
    await expect(router.sendInput("after-rebind")).resolves.toBe(true);
    expect(sent).toEqual(["one"]);
    expect(focused).toEqual(["one"]);
  });

  test("generation invalidation rolls an optimistic receipt back to the canonical pane", async () => {
    const selection = deferred<boolean>();
    const sent: string[] = [];
    const focused: Array<string | null> = [];
    const router = new TerminalPaneInputRouter<string>({
      select: () => selection.promise,
      send: async (paneId) => void sent.push(paneId),
      onFocusedPane: (paneId) => focused.push(paneId),
    });
    router.adoptCanonicalPane("one");
    router.selectPane("two");
    selection.resolve(true);
    await selection.promise;
    await Promise.resolve();
    expect(router.focusedPane).toBe("two");

    router.invalidateSelection();
    expect(router.focusedPane).toBe("one");
    await expect(router.sendInput("replacement")).resolves.toBe(true);
    expect(sent).toEqual(["one"]);
    expect(focused).toEqual(["one", "two", "one"]);
  });
});
