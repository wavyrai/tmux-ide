import { describe, expect, it } from "vitest";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  COMMAND_PROTOCOL_VERSION,
  CommandAvailabilitySchemaZ,
  CommandDescriptorSchemaZ,
  CommandInvocationSchemaZ,
  WORKSPACE_WINDOW_MODE_COMMAND_IDS,
  type CommandDescriptor,
  type CommandInvocation,
} from "../commands.ts";

const descriptor: CommandDescriptor = {
  version: COMMAND_PROTOCOL_VERSION,
  id: "workspace.view.activate",
  owner: "renderer",
  label: "Activate view",
  category: "workspace",
  schemas: { input: "workspace.view.activate.input.v1" },
  dangerous: false,
  confirmation: "none",
};

const invocation: CommandInvocation = {
  version: COMMAND_PROTOCOL_VERSION,
  id: descriptor.id,
  source: { kind: "keyboard", surface: "workbench" },
  args: { viewId: "terminals", nested: { selected: true }, rows: [1, 2] },
};

describe("command protocol", () => {
  it("round-trips serializable descriptors and invocations", () => {
    expect(CommandDescriptorSchemaZ.parse(JSON.parse(JSON.stringify(descriptor)))).toEqual(
      descriptor,
    );
    expect(CommandInvocationSchemaZ.parse(JSON.parse(JSON.stringify(invocation)))).toEqual(
      invocation,
    );
  });

  it("rejects non-namespaced ids and non-JSON arguments", () => {
    expect(CommandDescriptorSchemaZ.safeParse({ ...descriptor, id: "quit" }).success).toBe(false);
    expect(
      CommandInvocationSchemaZ.safeParse({
        ...invocation,
        args: { callback: () => undefined },
      }).success,
    ).toBe(false);
    expect(
      CommandInvocationSchemaZ.safeParse({
        ...invocation,
        args: { count: Number.NaN },
      }).success,
    ).toBe(false);
  });

  it("keeps availability outcomes serializable and explicit", () => {
    expect(CommandAvailabilitySchemaZ.parse({ available: true })).toEqual({ available: true });
    expect(
      CommandAvailabilitySchemaZ.parse({ available: false, reason: "no active view" }),
    ).toEqual({ available: false, reason: "no active view" });
  });

  it("reserves valid window-mode ids without registering behavior", () => {
    expect(WORKSPACE_WINDOW_MODE_COMMAND_IDS).toEqual([
      "workspace.windowMode.enter",
      "workspace.windowMode.exit",
      "workspace.windowMode.cancel",
      "workspace.windowMode.focus",
      "workspace.windowMode.move",
      "workspace.windowMode.resize",
      "workspace.windowMode.float.toggle",
      "workspace.windowMode.maximize.toggle",
      "workspace.windowMode.close",
    ]);
    for (const id of WORKSPACE_WINDOW_MODE_COMMAND_IDS) {
      expect(CommandDescriptorSchemaZ.safeParse({ ...descriptor, id }).success).toBe(true);
    }
  });

  it("keeps application-shell ids immutable and isolated from live renderer ids", () => {
    expect(Object.isFrozen(APPLICATION_SHELL_COMMAND_IDS)).toBe(true);
    expect(Object.values(APPLICATION_SHELL_COMMAND_IDS)).not.toContain("app.palette.open");
    expect(Object.values(APPLICATION_SHELL_COMMAND_IDS)).not.toContain("workspace.dock.activate");
  });
});
