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
});
