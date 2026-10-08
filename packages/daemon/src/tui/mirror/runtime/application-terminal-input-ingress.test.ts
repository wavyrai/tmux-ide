import { describe, expect, it, vi } from "vitest";

import type { ApplicationGenerationStartResult } from "./application-generation-starter.ts";
import { createApplicationTerminalInputIngress } from "./application-terminal-input-ingress.ts";
import type { ApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("application terminal input ingress", () => {
  it("cancels controller input when leaving terminals and on disposal", () => {
    const cancelPendingInput = vi.fn();
    const ingress = createApplicationTerminalInputIngress(
      { cancelPendingInput } as unknown as ApplicationTerminalInteractionController,
      () => null,
      () => null,
      () => null,
      () => undefined,
    );
    ingress.adopt();
    expect(cancelPendingInput).not.toHaveBeenCalled();
    ingress.adopt(false);
    expect(cancelPendingInput).toHaveBeenCalledTimes(1);
    ingress.dispose();
    expect(cancelPendingInput).toHaveBeenCalledTimes(2);
  });

  it.each(["count", "bytes", "timeout", "refusal"])(
    "bounds recovery input: %s",
    async (scenario) => {
      vi.useFakeTimers();
      const sendInputToPane = vi.fn(async () => scenario !== "refusal");
      let snapshot = {
        status: "rebinding",
        daemonGeneration: "daemon-a",
        rendererEpoch: 1,
        connection: {},
        client: { getSnapshot: () => ({ generation: 1 }) },
        fastLane: null,
      } as unknown as OpenTuiGenerationHostSnapshot;
      const owner = {
        sessionName: () => "alpha",
        snapshot: () => snapshot,
      } as unknown as OpenTuiSessionOwner;
      const notes: Array<string | null> = [];
      const ingress = createApplicationTerminalInputIngress(
        {
          sendInputToPane,
          cancelPendingInput: vi.fn(),
        } as unknown as ApplicationTerminalInteractionController,
        () => snapshot,
        () => owner,
        () => "pane.alpha",
        (note) => notes.push(typeof note === "function" ? note(notes.at(-1) ?? null) : note),
      );
      try {
        if (scenario === "bytes") ingress.routePaste(Buffer.alloc(1024 * 1024 + 1, 97));
        else
          for (let i = 0; i < (scenario === "count" ? 65 : 2); i++)
            ingress.routeKey({ name: "a", ctrl: false, meta: false, shift: false });
        if (scenario === "count" || scenario === "bytes")
          expect(notes.at(-1)).toContain("queue full");
        if (scenario === "timeout") {
          await vi.advanceTimersByTimeAsync(5000);
          expect(notes.at(-1)).toContain("timed out");
        }
        snapshot = { ...snapshot, status: "live", fastLane: {} } as OpenTuiGenerationHostSnapshot;
        ingress.adopt();
        await vi.advanceTimersByTimeAsync(0);
        expect(sendInputToPane).toHaveBeenCalledTimes(
          scenario === "count" ? 64 : scenario === "refusal" ? 1 : 0,
        );
        ingress.adopt();
        await vi.advanceTimersByTimeAsync(5000);
        expect(sendInputToPane).toHaveBeenCalledTimes(
          scenario === "count" ? 64 : scenario === "refusal" ? 1 : 0,
        );
      } finally {
        ingress.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["connection", "client", "daemon", "pane", "session", "client-generation"])(
    "discards recovery input when %s changes",
    async (changed) => {
      const sendInputToPane = vi.fn(async () => true);
      let clientGeneration = 1;
      let pane = "pane.alpha";
      let session = "alpha";
      let snapshot = {
        status: "rebinding",
        daemonGeneration: "daemon-a",
        rendererEpoch: 1,
        connection: {},
        client: { getSnapshot: () => ({ generation: clientGeneration }) },
        fastLane: null,
      } as unknown as OpenTuiGenerationHostSnapshot;
      const owner = {
        sessionName: () => session,
        snapshot: () => snapshot,
      } as unknown as OpenTuiSessionOwner;
      const notes: Array<string | null> = [];
      const ingress = createApplicationTerminalInputIngress(
        {
          sendInputToPane,
          cancelPendingInput: vi.fn(),
        } as unknown as ApplicationTerminalInteractionController,
        () => snapshot,
        () => owner,
        () => pane,
        (note) => notes.push(typeof note === "function" ? note(notes.at(-1) ?? null) : note),
      );
      try {
        ingress.routeKey({ name: "a", ctrl: false, meta: false, shift: false });
        if (changed === "connection")
          snapshot = { ...snapshot, connection: {} } as OpenTuiGenerationHostSnapshot;
        if (changed === "client")
          snapshot = {
            ...snapshot,
            client: { getSnapshot: () => ({ generation: 1 }) },
          } as OpenTuiGenerationHostSnapshot;
        if (changed === "daemon") snapshot = { ...snapshot, daemonGeneration: "daemon-b" };
        if (changed === "pane") pane = "pane.other";
        if (changed === "session") session = "other";
        if (changed === "client-generation") clientGeneration++;
        snapshot = { ...snapshot, status: "live", fastLane: {} } as OpenTuiGenerationHostSnapshot;
        ingress.adopt();
        expect(sendInputToPane).not.toHaveBeenCalled();
        expect(notes.at(-1)).toContain("changed");
      } finally {
        ingress.dispose();
      }
    },
  );

  it.each([false, true])(
    "orders new input behind recovery input and respects disposal (%s)",
    async (dispose) => {
      const first = deferred<boolean>();
      const sendInputToPane = vi.fn((_pane: string, _input: unknown) =>
        sendInputToPane.mock.calls.length === 1 ? first.promise : Promise.resolve(true),
      );
      let snapshot = {
        status: "rebinding",
        daemonGeneration: "daemon-a",
        rendererEpoch: 1,
        connection: {},
        client: { getSnapshot: () => ({ generation: 1 }) },
        fastLane: null,
      } as unknown as OpenTuiGenerationHostSnapshot;
      const owner = {
        sessionName: () => "alpha",
        snapshot: () => snapshot,
      } as unknown as OpenTuiSessionOwner;
      const ingress = createApplicationTerminalInputIngress(
        {
          sendInputToPane,
          cancelPendingInput: vi.fn(),
        } as unknown as ApplicationTerminalInteractionController,
        () => snapshot,
        () => owner,
        () => "pane.alpha",
        () => {},
      );
      const key = (name: string) =>
        ingress.routeKey({ name, ctrl: false, meta: false, shift: false });
      try {
        key("a");
        key("b");
        snapshot = { ...snapshot, status: "live", fastLane: {} } as OpenTuiGenerationHostSnapshot;
        ingress.adopt();
        key("c");
        expect(sendInputToPane).toHaveBeenCalledTimes(1);
        if (dispose) ingress.dispose();
        first.resolve(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sendInputToPane.mock.calls.map(([, input]) => input)).toEqual(
          (dispose ? ["a"] : ["a", "b", "c"]).map((data) => ({ kind: "text", data })),
        );
      } finally {
        ingress.dispose();
      }
    },
  );

  it("retains recovery input for the same connection and exact pane", async () => {
    const sendInputToPane = vi.fn(async (_pane: string, _input: unknown) => true);
    const interaction = {
      sendInputToPane,
      cancelPendingInput: vi.fn(),
    } as unknown as ApplicationTerminalInteractionController;
    const client = { getSnapshot: () => ({ generation: 1 }) };
    let snapshot = {
      status: "rebinding",
      daemonGeneration: "daemon-a",
      rendererEpoch: 1,
      connection: {},
      client,
      fastLane: null,
    } as unknown as OpenTuiGenerationHostSnapshot;
    const owner = {
      sessionName: () => "alpha",
      snapshot: () => snapshot,
    } as unknown as OpenTuiSessionOwner;
    const notes: Array<string | null> = [];
    const ingress = createApplicationTerminalInputIngress(
      interaction,
      () => snapshot,
      () => owner,
      () => "pane.alpha",
      (note) => notes.push(typeof note === "function" ? note(notes.at(-1) ?? null) : note),
    );
    try {
      ingress.routeKey({ name: "a", ctrl: false, meta: false, shift: false });
      ingress.routePaste(Buffer.from("hello"));
      expect(sendInputToPane).not.toHaveBeenCalled();
      expect(notes.at(-1)).toContain("queued");
      snapshot = {
        ...snapshot,
        status: "live",
        rendererEpoch: 2,
        fastLane: {},
      } as OpenTuiGenerationHostSnapshot;
      ingress.adopt();
      await vi.waitFor(() => expect(sendInputToPane).toHaveBeenCalledTimes(2));
      expect(sendInputToPane.mock.calls.map(([pane, input]) => [pane, input])).toEqual([
        ["pane.alpha", { kind: "text", data: "a" }],
        ["pane.alpha", { kind: "text", data: "\u001b[200~hello\u001b[201~" }],
      ]);
      ingress.adopt();
      expect(sendInputToPane).toHaveBeenCalledTimes(2);
    } finally {
      ingress.dispose();
    }
  });

  it("retains first key and paste until the exact opened generation owns focus", async () => {
    const sendInput = vi.fn(async () => true);
    const interaction = {
      sendInput,
      cancelPendingInput: vi.fn(),
    } as unknown as ApplicationTerminalInteractionController;
    let snapshot = {
      status: "connecting",
      daemonGeneration: null,
      rendererEpoch: 0,
      client: null,
      fastLane: null,
    } as unknown as OpenTuiGenerationHostSnapshot;
    let focusedPane: string | null = null;
    const owner = {
      sessionName: () => "alpha",
      snapshot: () => snapshot,
    } as unknown as OpenTuiSessionOwner;
    const notes: Array<string | null> = [];
    const ingress = createApplicationTerminalInputIngress(
      interaction,
      () => snapshot,
      () => owner,
      () => focusedPane,
      (note) => notes.push(typeof note === "function" ? note(notes.at(-1) ?? null) : note),
    );
    const started = deferred<ApplicationGenerationStartResult>();
    const start = ingress.wrapStarter(async () => started.promise);
    const opening = start("alpha");

    ingress.routeKey({ name: "a", ctrl: false, meta: false, shift: false });
    ingress.routePaste(Buffer.from("hello"));
    expect(sendInput).not.toHaveBeenCalled();
    expect(notes.at(-1)).toContain("terminal paste queued");

    snapshot = {
      status: "live",
      daemonGeneration: "daemon-a",
      rendererEpoch: 1,
      client: { getSnapshot: () => ({ generation: 1 }) },
      fastLane: {},
    } as unknown as OpenTuiGenerationHostSnapshot;
    started.resolve({
      opened: true,
      sessionName: "alpha",
      generationKey: "daemon-a:1:1",
    });
    await opening;
    expect(sendInput).not.toHaveBeenCalled();

    focusedPane = "pane.alpha";
    ingress.adopt();
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput.mock.calls.map(([input]) => input)).toEqual([
      { kind: "text", data: "a" },
      { kind: "text", data: "\u001b[200~hello\u001b[201~" },
    ]);
    expect(notes.at(-1)).toBeNull();
  });

  it("makes input visibly unavailable when no generation is pending or live", () => {
    const setNote = vi.fn();
    const interaction = {
      sendInput: vi.fn(),
      cancelPendingInput: vi.fn(),
    } as unknown as ApplicationTerminalInteractionController;
    const ingress = createApplicationTerminalInputIngress(
      interaction,
      () => null,
      () => null,
      () => null,
      setNote,
    );

    ingress.routeKey({ name: "a", ctrl: false, meta: false, shift: false });
    ingress.routePaste(Buffer.from("hello"));
    expect(setNote).toHaveBeenNthCalledWith(1, "terminal unavailable · input was not sent");
    expect(setNote).toHaveBeenNthCalledWith(2, "terminal unavailable · paste was not sent");
  });
});

describe("recovery input rejected outcome", () => {
  function harness() {
    let snapshot = {
      status: "rebinding",
      daemonGeneration: "daemon-a",
      rendererEpoch: 1,
      connection: {},
      client: { getSnapshot: () => ({ generation: 1 }) },
      fastLane: null,
    } as unknown as OpenTuiGenerationHostSnapshot;
    let pane = "pane.alpha";
    const owner = {
      sessionName: () => "alpha",
      snapshot: () => snapshot,
    } as unknown as OpenTuiSessionOwner;
    const notes: Array<string | null> = [];
    const sendInputToPane = vi.fn(async () => true);
    const ingress = createApplicationTerminalInputIngress(
      {
        sendInputToPane,
        cancelPendingInput: vi.fn(),
      } as unknown as ApplicationTerminalInteractionController,
      () => snapshot,
      () => owner,
      () => pane,
      (note) => notes.push(typeof note === "function" ? note(notes.at(-1) ?? null) : note),
    );
    return {
      ingress,
      notes,
      sendInputToPane,
      key: () => ingress.routeKey({ name: "a", ctrl: false, meta: false, shift: false }),
      live: () => {
        snapshot = { ...snapshot, status: "live", fastLane: {} } as OpenTuiGenerationHostSnapshot;
        ingress.adopt();
      },
      navigate: () => {
        pane = "pane.other";
        ingress.adopt();
      },
    };
  }
  it("retains reject65 after all64 admitted keys drain", async () => {
    const h = harness();
    const gate = deferred<boolean>();
    h.sendInputToPane.mockImplementationOnce(() => gate.promise);
    try {
      for (let i = 0; i < 65; i++) h.key();
      h.live();
      expect(h.sendInputToPane).toHaveBeenCalledTimes(1);
      gate.resolve(true);
      await vi.waitFor(() => expect(h.sendInputToPane).toHaveBeenCalledTimes(64));
      expect(h.notes.at(-1)).toContain("some terminal input was not sent");
      expect(h.notes.at(-1)).not.toContain("wait");
      h.navigate();
      expect(h.notes.at(-1)).toBeNull();
    } finally {
      h.ingress.dispose();
    }
  });
  it("retains an oversized rejected paste after an empty recovery drain", async () => {
    const h = harness();
    try {
      h.ingress.routePaste(Buffer.alloc(1024 * 1024 + 1, 97));
      h.live();
      await Promise.resolve();
      expect(h.sendInputToPane).not.toHaveBeenCalled();
      expect(h.notes.at(-1)).toContain("some terminal input was not sent");
      h.ingress.adopt(false);
      expect(h.notes.at(-1)).toBeNull();
    } finally {
      h.ingress.dispose();
    }
  });
  it("does not erase byte overflow when a later smaller input is admitted", async () => {
    const h = harness();
    try {
      h.ingress.routePaste(Buffer.alloc(1024 * 1024 + 1, 97));
      h.key();
      expect(h.notes.at(-1)).toContain("some terminal input was not sent");
      h.live();
      await vi.waitFor(() => expect(h.sendInputToPane).toHaveBeenCalledTimes(1));
      expect(h.notes.at(-1)).toContain("some terminal input was not sent");
      h.ingress.dispose();
      expect(h.notes.at(-1)).toBeNull();
    } finally {
      h.ingress.dispose();
    }
  });
  it.each(["navigation", "dispose"])("preserves a newer shared note on %s", async (action) => {
    const h = harness();
    try {
      h.ingress.routePaste(Buffer.alloc(1024 * 1024 + 1, 97));
      h.notes.push("rename failed · please retry");
      h.live();
      await Promise.resolve();
      expect(h.notes.at(-1)).toBe("rename failed · please retry");
      if (action === "navigation") h.navigate();
      else h.ingress.dispose();
      expect(h.notes.at(-1)).toBe("rename failed · please retry");
    } finally {
      h.ingress.dispose();
    }
  });

  it.each(["timeout", "refusal"])(
    "preserves the newer %s outcome after navigation",
    async (outcome) => {
      vi.useFakeTimers();
      const h = harness();
      try {
        h.ingress.routePaste(Buffer.alloc(1024 * 1024 + 1, 97));
        h.key();
        if (outcome === "timeout") await vi.advanceTimersByTimeAsync(5000);
        else {
          h.sendInputToPane.mockResolvedValue(false);
          h.live();
          await vi.advanceTimersByTimeAsync(0);
        }
        const message = h.notes.at(-1);
        expect(message).toContain(outcome === "timeout" ? "timed out" : "unavailable");
        h.navigate();
        expect(h.notes.at(-1)).toBe(message);
        h.ingress.dispose();
        expect(h.notes.at(-1)).toBe(message);
      } finally {
        h.ingress.dispose();
        vi.useRealTimers();
      }
    },
  );
});
