import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COMMAND_PROTOCOL_VERSION, type CommandInvocation } from "@tmux-ide/contracts";
import { CommandRegistry, type CommandDefinition } from "../command-registry.ts";

interface Context {
  active: boolean;
}

const definition = (): CommandDefinition<Context, { viewId: string }, { changed: boolean }> => ({
  descriptor: {
    version: COMMAND_PROTOCOL_VERSION,
    id: "workspace.view.activate",
    owner: "renderer",
    label: "Activate view",
    category: "workspace",
    schemas: {
      input: "workspace.view.activate.input.v1",
      result: "workspace.view.activate.result.v1",
    },
    dangerous: false,
    confirmation: "none",
  },
  inputSchema: z.object({ viewId: z.string().min(1) }).strict(),
  resultSchema: z.object({ changed: z.boolean() }).strict(),
  availability: (context) =>
    context.active ? { available: true } : { available: false, reason: "workspace is inactive" },
});

const invocation = (overrides: Partial<CommandInvocation> = {}): CommandInvocation => ({
  version: COMMAND_PROTOCOL_VERSION,
  id: "workspace.view.activate",
  source: { kind: "keyboard", surface: "workbench" },
  args: { viewId: "terminals" },
  ...overrides,
});

describe("CommandRegistry", () => {
  it("prepares a schema-validated available command without running an effect", () => {
    let availabilityCalls = 0;
    const item = definition();
    item.availability = (context) => {
      availabilityCalls += 1;
      return context.active
        ? { available: true }
        : { available: false, reason: "workspace is inactive" };
    };
    const registry = new CommandRegistry<Context>([item]);

    const resolved = registry.resolve(invocation(), { active: true });

    expect(resolved).toMatchObject({
      ok: true,
      command: {
        descriptor: { id: "workspace.view.activate", owner: "renderer" },
        input: { viewId: "terminals" },
      },
    });
    expect(availabilityCalls).toBe(1);
  });

  it("rejects duplicate ids deterministically", () => {
    expect(() => new CommandRegistry([definition(), definition()])).toThrow(
      "duplicate command id: workspace.view.activate",
    );
  });

  it("returns structured unknown, invalid-envelope, and invalid-input errors", () => {
    const registry = new CommandRegistry<Context>([definition()]);
    expect(
      registry.resolve(invocation({ id: "workspace.view.missing" }), { active: true }),
    ).toMatchObject({ ok: false, error: { code: "unknown-command" } });
    expect(registry.resolve({ id: "workspace.view.activate" }, { active: true })).toMatchObject({
      ok: false,
      error: { code: "invalid-invocation", commandId: "workspace.view.activate" },
    });
    expect(registry.resolve(invocation({ args: { viewId: 7 } }), { active: true })).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  });

  it("returns a reason and no prepared command when unavailable", () => {
    expect(new CommandRegistry([definition()]).resolve(invocation(), { active: false })).toEqual({
      ok: false,
      error: {
        code: "unavailable",
        commandId: "workspace.view.activate",
        message: "workspace is inactive",
      },
    });
  });

  it("keeps descriptors in registration order and exposes no definition or handler surface", () => {
    const second = definition();
    second.descriptor = { ...second.descriptor, id: "workspace.home.open", label: "Open home" };
    const registry = new CommandRegistry([definition(), second]);
    expect(registry.descriptors().map((item) => item.id)).toEqual([
      "workspace.view.activate",
      "workspace.home.open",
    ]);
    expect(registry).not.toHaveProperty("definition");
    for (const descriptor of registry.descriptors()) {
      expect(descriptor).not.toHaveProperty("handler");
      expect(descriptor).not.toHaveProperty("execute");
    }
  });

  it("copies and deeply freezes descriptor data at registration", () => {
    const item = definition();
    const registry = new CommandRegistry([item]);

    item.descriptor.label = "Mutated outside registry";
    item.descriptor.schemas.input = "mutated.input.v1";

    const descriptors = registry.descriptors();
    expect(descriptors[0]).toMatchObject({
      label: "Activate view",
      schemas: { input: "workspace.view.activate.input.v1" },
    });
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(Object.isFrozen(descriptors[0])).toBe(true);
    expect(Object.isFrozen(descriptors[0]?.schemas)).toBe(true);
    expect(() => {
      if (descriptors[0]) descriptors[0].schemas.input = "mutated.from-reader.v1";
    }).toThrow(TypeError);
    expect(registry.descriptors()[0]?.schemas.input).toBe("workspace.view.activate.input.v1");
  });
});
