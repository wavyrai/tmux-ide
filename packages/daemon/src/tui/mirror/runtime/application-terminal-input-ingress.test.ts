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
        (note) => notes.push(note),
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
        (note) => notes.push(note),
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
      (note) => notes.push(note),
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
      (note) => notes.push(note),
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
