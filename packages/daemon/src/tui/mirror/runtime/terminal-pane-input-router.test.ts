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
