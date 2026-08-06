import { describe, expect, it, vi } from "vitest";

import {
  multiplexerVerbIntent,
  multiplexerVerbInvocation,
  useVerbTable,
  type MultiplexerVerbTarget,
} from "./multiplexer-verb-access.ts";

const paneTarget: MultiplexerVerbTarget = {
  workspaceName: "workspace.product",
  semanticPaneId: "pane.one",
};
const sessionOnly: MultiplexerVerbTarget = { workspaceName: "workspace.product" };

describe("building a verb intent", () => {
  it("turns the two split verbs into one route with opposite directions", () => {
    expect(multiplexerVerbIntent("pane.split.right", paneTarget)).toEqual({
      verb: "workspace.window.split",
      workspaceName: "workspace.product",
      semanticPaneId: "pane.one",
      direction: "right",
    });
    expect(multiplexerVerbIntent("pane.split.down", paneTarget)).toMatchObject({
      direction: "down",
    });
  });

  it("names a window by its own stamp when the target has one, and by a pane otherwise", () => {
    expect(multiplexerVerbIntent("window.kill", paneTarget)).toEqual({
      verb: "workspace.window.kill",
      workspaceName: "workspace.product",
      target: { by: "pane", semanticPaneId: "pane.one" },
    });
    expect(
      multiplexerVerbIntent("window.kill", { ...paneTarget, semanticWindowId: "win.one" }),
    ).toMatchObject({ target: { by: "window", semanticWindowId: "win.one" } });
  });

  it("refuses to build a pane verb against a target with no pane", () => {
    expect(multiplexerVerbIntent("pane.kill", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("pane.select", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("pane.swap", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("window.zoom.toggle", sessionOnly)).toBeNull();
  });

  it("refuses a rename with no name rather than sending an empty one", () => {
    expect(multiplexerVerbIntent("session.rename", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("window.rename", paneTarget)).toBeNull();
    expect(multiplexerVerbIntent("session.rename", sessionOnly, { name: "Rebuilt" })).toEqual({
      verb: "workspace.rename",
      scope: "session",
      workspaceName: "workspace.product",
      name: "Rebuilt",
    });
  });

  it("carries an explicit zoom state when a surface renders zoom as a toggle", () => {
    expect(
      multiplexerVerbIntent("window.zoom.toggle", paneTarget, { desiredZoom: "zoomed" }),
    ).toMatchObject({ desired: "zoomed" });
    expect(multiplexerVerbIntent("window.zoom.toggle", paneTarget)).toMatchObject({
      desired: "toggle",
    });
  });

  it("builds nothing for verbs that do not travel this route", () => {
    // Creation flows own their own surfaces; detach never leaves the client;
    // stack activation is a layout command, not a tmux one.
    expect(multiplexerVerbIntent("session.new", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("window.new", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("session.detach", sessionOnly)).toBeNull();
    expect(multiplexerVerbIntent("stack.activate", sessionOnly)).toBeNull();
  });

  it("pairs the verb the user clicked with the intent the daemon runs", () => {
    expect(multiplexerVerbInvocation("pane.split.down", paneTarget)).toMatchObject({
      verbId: "pane.split.down",
      intent: { verb: "workspace.window.split", direction: "down" },
    });
  });
});

describe("the verb table accessor", () => {
  const hostWith = (
    invokeVerb = vi.fn(async () => ({ status: "ok" as const, result: {} as never })),
  ) => ({
    host: { daemon: { invokeVerb } },
    invokeVerb,
  });

  it("offers a scope's verbs with availability resolved, including the unavailable ones", () => {
    const { host } = hostWith();
    const offers = useVerbTable(host).offers("pane", {
      workspaceConnected: true,
      windowPaneCount: 1,
      sessionWindowCount: 1,
      targetIsActivePane: true,
    });
    expect(offers.map((offer) => offer.verb.id)).toEqual([
      "pane.split.right",
      "pane.split.down",
      "pane.kill",
      "pane.select",
      "pane.swap",
      "pane.resize",
    ]);
    // Disabled-with-reason, not hidden: the rule stays learnable.
    expect(offers.find((offer) => offer.verb.id === "pane.kill")?.availability).toEqual({
      available: false,
      reason: "this is the session's last pane",
    });
    expect(offers.find((offer) => offer.verb.id === "pane.split.right")?.availability).toEqual({
      available: true,
    });
  });

  it("dispatches a buildable verb through the host", async () => {
    const { host, invokeVerb } = hostWith();
    await useVerbTable(host).invoke("pane.select", paneTarget);
    expect(invokeVerb).toHaveBeenCalledWith({
      verbId: "pane.select",
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "workspace.product",
        semanticPaneId: "pane.one",
      },
    });
  });

  it("builds a resize from one axis and the cells the drag settled on", async () => {
    const { host, invokeVerb } = hostWith();
    await useVerbTable(host).invoke("pane.resize", paneTarget, {
      resize: { axis: "cols", cells: 96 },
    });
    expect(invokeVerb).toHaveBeenCalledWith({
      verbId: "pane.resize",
      intent: {
        verb: "workspace.pane.resize",
        workspaceName: "workspace.product",
        semanticPaneId: "pane.one",
        axis: "cols",
        cells: 96,
      },
    });
  });

  it("builds a swap from two semantic pane identities", async () => {
    const { host, invokeVerb } = hostWith();
    await useVerbTable(host).invoke("pane.swap", paneTarget, {
      swapTargetSemanticPaneId: "pane.two",
    });
    expect(invokeVerb).toHaveBeenCalledWith({
      verbId: "pane.swap",
      intent: {
        verb: "workspace.pane.swap",
        workspaceName: "workspace.product",
        sourceSemanticPaneId: "pane.one",
        targetSemanticPaneId: "pane.two",
      },
    });
  });

  it("refuses a swap without a target rather than guessing one", async () => {
    const { host, invokeVerb } = hostWith();
    const result = await useVerbTable(host).invoke("pane.swap", paneTarget);
    expect(result).toMatchObject({ status: "error" });
    expect(invokeVerb).not.toHaveBeenCalled();
  });

  it("refuses a resize with no size to apply rather than inventing one", async () => {
    const { host, invokeVerb } = hostWith();
    const result = await useVerbTable(host).invoke("pane.resize", paneTarget);
    expect(result).toMatchObject({ status: "error" });
    expect(invokeVerb).not.toHaveBeenCalled();
  });

  it("refuses an unbuildable verb without touching the host", async () => {
    const { host, invokeVerb } = hostWith();
    const result = await useVerbTable(host).invoke("pane.kill", sessionOnly);
    expect(result).toEqual({
      status: "error",
      error: {
        code: "invalid-request",
        reason: "Close pane cannot be run against this target",
      },
    });
    expect(invokeVerb).not.toHaveBeenCalled();
  });
});
