import {
  CommandAvailabilitySchemaZ,
  CommandDescriptorSchemaZ,
  CommandIdSchemaZ,
  CommandInvocationSchemaZ,
  type CommandAvailability,
  type CommandDescriptor,
  type CommandInvocation,
  type CommandResolutionError,
} from "@tmux-ide/contracts";
import type { ZodError, ZodType } from "zod";

/** A command's data contract and pure availability predicate — never an effect. */
export interface CommandDefinition<Context = unknown, Input = unknown, Result = unknown> {
  descriptor: CommandDescriptor;
  inputSchema: ZodType<Input>;
  resultSchema?: ZodType<Result>;
  availability?: (context: Context, input: Input) => CommandAvailability;
}

export interface PreparedCommand<Input = unknown, Result = unknown> {
  descriptor: CommandDescriptor;
  invocation: CommandInvocation;
  input: Input;
  resultSchema?: ZodType<Result>;
}

export type CommandResolution<Input = unknown, Result = unknown> =
  | { ok: true; command: PreparedCommand<Input, Result> }
  | { ok: false; error: CommandResolutionError };

type LooseDefinition<Context> = CommandDefinition<Context, unknown, unknown>;

function issues(error: ZodError): NonNullable<CommandResolutionError["details"]> {
  return JSON.parse(JSON.stringify({ issues: error.issues })) as NonNullable<
    CommandResolutionError["details"]
  >;
}

function recoverCommandId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  const parsed = CommandIdSchemaZ.safeParse(id);
  return parsed.success ? parsed.data : undefined;
}

function immutableDescriptor(rawDescriptor: CommandDescriptor): CommandDescriptor {
  const descriptor = CommandDescriptorSchemaZ.parse(rawDescriptor);
  return Object.freeze({
    ...descriptor,
    schemas: Object.freeze({ ...descriptor.schemas }),
  });
}

/**
 * Handler-free registry. Resolving is deterministic given the invocation and
 * caller-supplied context; executing the prepared command belongs to its host.
 */
export class CommandRegistry<Context = unknown> {
  private readonly definitions = new Map<string, LooseDefinition<Context>>();

  constructor(definitions: readonly LooseDefinition<Context>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<Input, Result>(definition: CommandDefinition<Context, Input, Result>): void {
    const descriptor = immutableDescriptor(definition.descriptor);
    if (this.definitions.has(descriptor.id)) {
      throw new Error(`duplicate command id: ${descriptor.id}`);
    }
    this.definitions.set(descriptor.id, {
      ...definition,
      descriptor: Object.freeze(descriptor),
    } as LooseDefinition<Context>);
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  descriptors(): readonly CommandDescriptor[] {
    return Object.freeze([...this.definitions.values()].map((definition) => definition.descriptor));
  }

  resolve(rawInvocation: unknown, context: Context): CommandResolution {
    const invocationResult = CommandInvocationSchemaZ.safeParse(rawInvocation);
    if (!invocationResult.success) {
      const commandId = recoverCommandId(rawInvocation);
      return {
        ok: false,
        error: {
          code: "invalid-invocation",
          message: "Command invocation failed envelope validation",
          ...(commandId ? { commandId } : {}),
          details: issues(invocationResult.error),
        },
      };
    }
    const invocation = invocationResult.data;
    const definition = this.definitions.get(invocation.id);
    if (!definition) {
      return {
        ok: false,
        error: {
          code: "unknown-command",
          commandId: invocation.id,
          message: `Unknown command: ${invocation.id}`,
        },
      };
    }
    const inputResult = definition.inputSchema.safeParse(invocation.args);
    if (!inputResult.success) {
      return {
        ok: false,
        error: {
          code: "invalid-input",
          commandId: invocation.id,
          message: "Command input failed schema validation",
          details: issues(inputResult.error),
        },
      };
    }
    const availability = CommandAvailabilitySchemaZ.parse(
      definition.availability?.(context, inputResult.data) ?? { available: true },
    );
    if (!availability.available) {
      return {
        ok: false,
        error: {
          code: "unavailable",
          commandId: invocation.id,
          message: availability.reason,
        },
      };
    }
    return {
      ok: true,
      command: {
        descriptor: definition.descriptor,
        invocation,
        input: inputResult.data,
        resultSchema: definition.resultSchema,
      },
    };
  }
}

export function createCommandRegistry<Context>(
  definitions: readonly CommandDefinition<Context, unknown, unknown>[],
): CommandRegistry<Context> {
  return new CommandRegistry(definitions);
}
