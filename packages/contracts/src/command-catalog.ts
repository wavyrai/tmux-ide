import { z } from "zod";
import { plainTextSchema } from "./plain-text.ts";
import {
  CommandDescriptorSchemaZ,
  CommandIdSchemaZ,
  CommandSourceKindSchemaZ,
} from "./commands.ts";

/**
 * The command catalog: every command a palette, a key binding or the CLI can
 * offer, built-in daemon actions and plugin actions alike. Plugin actions
 * carry a parameter list the palette turns into a form before invoking.
 */
export const COMMAND_CATALOG_VERSION = 1 as const;

export const CommandParamTypeSchemaZ = z.enum(["string", "text", "number", "boolean", "choice"]);
export type CommandParamType = z.infer<typeof CommandParamTypeSchemaZ>;

export const CommandParamNameSchemaZ = z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/u);

export const CommandChoiceSchemaZ = z
  .object({
    value: plainTextSchema(0, 500),
    label: plainTextSchema(1, 200),
  })
  .strict();
export type CommandChoice = z.infer<typeof CommandChoiceSchemaZ>;

export const CommandParamSchemaZ = z
  .object({
    name: CommandParamNameSchemaZ,
    type: CommandParamTypeSchemaZ,
    label: plainTextSchema(1, 120),
    description: plainTextSchema(0, 500).optional(),
    /** False only when the plugin marked it `optional = true`. */
    required: z.boolean(),
    /** A fixed default; `dynamicDefault` means the plugin computes one per invocation. */
    default: z.union([plainTextSchema(0, 10_000), z.number(), z.boolean()]).optional(),
    dynamicDefault: z.boolean(),
    /** Fixed choices for `choice`; `dynamicChoices` means ask the plugin. */
    choices: z.array(CommandChoiceSchemaZ).max(500).optional(),
    dynamicChoices: z.boolean(),
  })
  .strict();
export type CommandParam = z.infer<typeof CommandParamSchemaZ>;

export const CommandCatalogEntrySchemaZ = z
  .object({
    descriptor: CommandDescriptorSchemaZ,
    /** The plugin that registered it; absent for built-in commands. */
    plugin: z.string().min(1).max(64).optional(),
    params: z.array(CommandParamSchemaZ).max(32),
  })
  .strict();
export type CommandCatalogEntry = z.infer<typeof CommandCatalogEntrySchemaZ>;

export const CommandCatalogResourceSchemaZ = z
  .object({
    version: z.literal(COMMAND_CATALOG_VERSION),
    revision: z.number().int().nonnegative(),
    entries: z.array(CommandCatalogEntrySchemaZ).max(2000),
  })
  .strict();
export type CommandCatalogResource = z.infer<typeof CommandCatalogResourceSchemaZ>;

/** Where an invocation came from, so a plugin can act on the right session and pane. */
export const CommandInvocationContextSchemaZ = z
  .object({
    source: CommandSourceKindSchemaZ,
    session: z.string().min(1).max(200).optional(),
    window: z.string().min(1).max(200).optional(),
    pane: z.string().min(1).max(200).optional(),
  })
  .strict();
export type CommandInvocationContext = z.infer<typeof CommandInvocationContextSchemaZ>;

export const CommandArgValueSchemaZ = z.union([z.string().max(100_000), z.number(), z.boolean()]);

export const CommandInvokeRequestSchemaZ = z
  .object({
    id: CommandIdSchemaZ,
    args: z.record(CommandParamNameSchemaZ, CommandArgValueSchemaZ),
    context: CommandInvocationContextSchemaZ,
    /** Required for a dangerous command: the person confirmed it. */
    confirmed: z.boolean().optional(),
  })
  .strict();
export type CommandInvokeRequest = z.infer<typeof CommandInvokeRequestSchemaZ>;

export const CommandInvokeResultSchemaZ = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type CommandInvokeResult = z.infer<typeof CommandInvokeResultSchemaZ>;

/** Ask a plugin for one parameter's choices and default, for the current context. */
export const CommandParamOptionsRequestSchemaZ = z
  .object({
    id: CommandIdSchemaZ,
    param: CommandParamNameSchemaZ,
    context: CommandInvocationContextSchemaZ,
  })
  .strict();
export type CommandParamOptionsRequest = z.infer<typeof CommandParamOptionsRequestSchemaZ>;

export const CommandParamOptionsResultSchemaZ = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      choices: z.array(CommandChoiceSchemaZ).max(500).optional(),
      default: z.union([z.string().max(10_000), z.number(), z.boolean()]).optional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), error: z.string() }).strict(),
]);
export type CommandParamOptionsResult = z.infer<typeof CommandParamOptionsResultSchemaZ>;
