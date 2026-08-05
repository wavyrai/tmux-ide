import { describe, expect, it } from "vitest";

import { ActionContractsZ } from "../actions-contract.ts";
import { AppWindowMutationCommandSchemaZ } from "../app-window-mutation.ts";
import {
  MULTIPLEXER_VERB_IDS,
  MULTIPLEXER_VERB_TABLE,
  MultiplexerVerbEntrySchemaZ,
  isMultiplexerVerbId,
  multiplexerVerb,
  multiplexerVerbAvailability,
  multiplexerVerbsForScope,
  type MultiplexerVerbEntry,
} from "../multiplexer-verbs.ts";

const verb = (id: string): MultiplexerVerbEntry => {
  const found = MULTIPLEXER_VERB_TABLE.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing verb ${id}`);
  return found;
};

describe("the multiplexer verb table", () => {
  it("carries every verb the milestone declares, and no others", () => {
    expect([...MULTIPLEXER_VERB_IDS]).toEqual([
      "session.new",
      "session.kill",
      "session.rename",
      "session.detach",
      "window.new",
      "window.kill",
      "window.rename",
      "window.zoom.toggle",
      "pane.split.right",
      "pane.split.down",
      "pane.kill",
      "pane.select",
      "stack.activate",
    ]);
  });

  it("conforms to its own schema", () => {
    for (const entry of MULTIPLEXER_VERB_TABLE) {
      expect(() => MultiplexerVerbEntrySchemaZ.parse(entry)).not.toThrow();
    }
  });

  it("is deeply frozen so no surface can edit the shared table", () => {
    expect(Object.isFrozen(MULTIPLEXER_VERB_TABLE)).toBe(true);
    for (const entry of MULTIPLEXER_VERB_TABLE) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.execution)).toBe(true);
      expect(Object.isFrozen(entry.availabilityInputs)).toBe(true);
    }
  });

  it("has unique ids", () => {
    expect(new Set(MULTIPLEXER_VERB_IDS).size).toBe(MULTIPLEXER_VERB_IDS.length);
  });

  it("names only daemon actions that actually exist", () => {
    for (const entry of MULTIPLEXER_VERB_TABLE) {
      if (entry.execution.kind !== "daemon-action") continue;
      expect(Object.keys(ActionContractsZ)).toContain(entry.execution.action);
    }
  });

  it("names only AppWindow commands that actually exist", () => {
    const commands = AppWindowMutationCommandSchemaZ.options.map(
      (option) => option.shape.type.value,
    );
    for (const entry of MULTIPLEXER_VERB_TABLE) {
      if (entry.execution.kind !== "app-window") continue;
      expect(commands).toContain(entry.execution.command);
    }
  });

  it("marks exactly the verbs that destroy something as destructive", () => {
    const destructive = MULTIPLEXER_VERB_TABLE.filter((entry) => entry.destructive).map(
      (entry) => entry.id,
    );
    expect(destructive).toEqual(["session.kill", "window.kill", "pane.kill"]);
  });

  it("leaves every tmux key hint unfilled until the keybinding bridge exists", () => {
    for (const entry of MULTIPLEXER_VERB_TABLE) {
      expect(entry.tmuxKeyHint).toBeNull();
    }
  });

  it("groups verbs by the object they act on", () => {
    expect(multiplexerVerbsForScope("pane").map((entry) => entry.id)).toEqual([
      "pane.split.right",
      "pane.split.down",
      "pane.kill",
      "pane.select",
    ]);
  });

  it("recognises its own ids and rejects others", () => {
    expect(isMultiplexerVerbId("pane.kill")).toBe(true);
    expect(isMultiplexerVerbId("pane.obliterate")).toBe(false);
    expect(isMultiplexerVerbId(7)).toBe(false);
    expect(() => multiplexerVerb("pane.kill")).not.toThrow();
  });

  it("routes pane focus to tmux and stack activation to the layout document", () => {
    // The distinction gap 10 turns on: one of these reaches the multiplexer.
    expect(verb("pane.select").execution).toEqual({
      kind: "daemon-action",
      action: "workspace.pane.select",
    });
    expect(verb("stack.activate").execution).toEqual({
      kind: "app-window",
      command: "stack.activate",
    });
  });
});

describe("verb availability", () => {
  const connected = { workspaceConnected: true } as const;

  it("refuses a verb whose declared facts the surface did not gather", () => {
    const result = multiplexerVerbAvailability(verb("pane.kill"), connected);
    expect(result).toEqual({ available: false, reason: "windowPaneCount is unknown" });
  });

  it("offers nothing on a disconnected workspace", () => {
    const result = multiplexerVerbAvailability(verb("window.rename"), {
      workspaceConnected: false,
    });
    expect(result).toEqual({ available: false, reason: "the workspace is not connected" });
  });

  it("refuses to close a session's last window", () => {
    expect(
      multiplexerVerbAvailability(verb("window.kill"), { ...connected, sessionWindowCount: 1 }),
    ).toEqual({ available: false, reason: "this is the session's last window" });
    expect(
      multiplexerVerbAvailability(verb("window.kill"), { ...connected, sessionWindowCount: 2 }),
    ).toEqual({ available: true });
  });

  it("refuses to close a session's last pane but allows any other", () => {
    const facts = { ...connected, windowPaneCount: 1, sessionWindowCount: 1 };
    expect(multiplexerVerbAvailability(verb("pane.kill"), facts)).toEqual({
      available: false,
      reason: "this is the session's last pane",
    });
    // A split window's pane is closable, and so is a lone pane in a session
    // that still has another window to fall back to.
    expect(
      multiplexerVerbAvailability(verb("pane.kill"), { ...facts, windowPaneCount: 2 }),
    ).toEqual({ available: true });
    expect(
      multiplexerVerbAvailability(verb("pane.kill"), { ...facts, sessionWindowCount: 2 }),
    ).toEqual({ available: true });
  });

  it("offers zoom for a split window, and for unzooming whatever the pane count says", () => {
    expect(
      multiplexerVerbAvailability(verb("window.zoom.toggle"), {
        ...connected,
        windowPaneCount: 1,
        windowZoomed: false,
      }),
    ).toEqual({ available: false, reason: "this window has only one pane" });
    expect(
      multiplexerVerbAvailability(verb("window.zoom.toggle"), {
        ...connected,
        windowPaneCount: 2,
        windowZoomed: false,
      }),
    ).toEqual({ available: true });
    expect(
      multiplexerVerbAvailability(verb("window.zoom.toggle"), {
        ...connected,
        windowPaneCount: 1,
        windowZoomed: true,
      }),
    ).toEqual({ available: true });
  });

  it("does not offer focus on the pane that already has it", () => {
    expect(
      multiplexerVerbAvailability(verb("pane.select"), {
        ...connected,
        targetIsActivePane: true,
      }),
    ).toEqual({ available: false, reason: "this pane is already active" });
    expect(
      multiplexerVerbAvailability(verb("pane.select"), {
        ...connected,
        targetIsActivePane: false,
      }),
    ).toEqual({ available: true });
  });

  it("offers stack activation only inside a docked stack", () => {
    expect(
      multiplexerVerbAvailability(verb("stack.activate"), { targetIsDockedStackMember: true }),
    ).toEqual({ available: true });
    expect(
      multiplexerVerbAvailability(verb("stack.activate"), { targetIsDockedStackMember: false }),
    ).toEqual({ available: false, reason: "this window is not in a docked stack" });
  });

  it("offers a verb with no declared inputs unconditionally", () => {
    expect(multiplexerVerbAvailability(verb("session.new"), {})).toEqual({ available: true });
  });
});
