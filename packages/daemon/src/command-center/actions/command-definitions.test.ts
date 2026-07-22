import { describe, expect, it } from "vitest";
import {
  ACTION_NAMES,
  ActionContractsZ,
  WORKSPACE_WINDOW_MODE_COMMAND_IDS,
} from "@tmux-ide/contracts";
import {
  DAEMON_ACTION_COMMAND_DEFINITIONS,
  daemonActionCommandRegistry,
} from "./command-definitions.ts";

describe("daemon action command definitions", () => {
  it("registers every existing action id exactly once in contract order", () => {
    expect(daemonActionCommandRegistry.descriptors().map((item) => item.id)).toEqual(ACTION_NAMES);
    expect(new Set(ACTION_NAMES).size).toBe(16);
  });

  it("reuses the exact action input/result schemas", () => {
    for (const definition of DAEMON_ACTION_COMMAND_DEFINITIONS) {
      const name = definition.descriptor.id as keyof typeof ActionContractsZ;
      expect(definition.descriptor.owner).toBe("daemon");
      expect(definition.inputSchema).toBe(ActionContractsZ[name].input);
      expect(definition.resultSchema).toBe(ActionContractsZ[name].result);
    }
  });

  it("recursively freezes the exported daemon command catalog", () => {
    expect(Object.isFrozen(DAEMON_ACTION_COMMAND_DEFINITIONS)).toBe(true);
    for (const definition of DAEMON_ACTION_COMMAND_DEFINITIONS) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.descriptor)).toBe(true);
      expect(Object.isFrozen(definition.descriptor.schemas)).toBe(true);
    }

    const first = DAEMON_ACTION_COMMAND_DEFINITIONS[0];
    expect(first).toBeDefined();
    expect(() => {
      if (first) first.descriptor.schemas.input = "mutated.input.v1";
    }).toThrow(TypeError);
    expect(DAEMON_ACTION_COMMAND_DEFINITIONS[0]?.descriptor.schemas.input).toBe(
      "project.openTerminal.input.v1",
    );
  });

  it("does not register reserved window-mode renderer commands", () => {
    for (const id of WORKSPACE_WINDOW_MODE_COMMAND_IDS) {
      expect(daemonActionCommandRegistry.has(id)).toBe(false);
    }
  });
});
