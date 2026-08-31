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
  it("retains first key and paste until the exact opened generation owns focus", async () => {
    const sendInput = vi.fn(async () => true);
    const interaction = { sendInput } as unknown as ApplicationTerminalInteractionController;
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
