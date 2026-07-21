import { z } from "zod";

/**
 * Stable, process-neutral command protocol shared by daemon and renderer hosts.
 *
 * Descriptors and invocations are data only. Runtime schemas, availability
 * predicates, and effect handlers deliberately stay in their owning process.
 */
export const COMMAND_PROTOCOL_VERSION = 1 as const;

export const CommandIdSchemaZ = z
  .string()
  .min(3)
  .max(160)
  .regex(
    /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/,
    "command id must be a dot-namespaced identifier",
  );

export const CommandOwnerSchemaZ = z.enum(["daemon", "renderer"]);

export const CommandSourceKindSchemaZ = z.enum([
  "cli",
  "http",
  "local-control",
  "keyboard",
  "palette",
  "menu",
  "mouse",
  "wheel",
  "program",
]);

export const CommandSourceSchemaZ = z
  .object({
    kind: CommandSourceKindSchemaZ,
    surface: z.string().min(1).max(80).optional(),
  })
  .strict();

export const CommandSchemaReferencesSchemaZ = z
  .object({
    input: z.string().min(1).max(160),
    result: z.string().min(1).max(160).optional(),
  })
  .strict();

export const CommandConfirmationSchemaZ = z.enum(["none", "inline", "dialog"]);

export const CommandDescriptorSchemaZ = z
  .object({
    version: z.literal(COMMAND_PROTOCOL_VERSION),
    id: CommandIdSchemaZ,
    owner: CommandOwnerSchemaZ,
    label: z.string().min(1).max(160),
    description: z.string().min(1).max(500).optional(),
    category: z.string().min(1).max(80),
    schemas: CommandSchemaReferencesSchemaZ,
    dangerous: z.boolean(),
    confirmation: CommandConfirmationSchemaZ,
  })
  .strict();

/** Commands accept one JSON object so they can cross every current bridge. */
export const CommandArgumentsSchemaZ = z.record(z.string(), z.json());

export const CommandInvocationSchemaZ = z
  .object({
    version: z.literal(COMMAND_PROTOCOL_VERSION),
    id: CommandIdSchemaZ,
    source: CommandSourceSchemaZ,
    args: CommandArgumentsSchemaZ,
  })
  .strict();

export const CommandAvailabilitySchemaZ = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true) }).strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

export const CommandResolutionErrorCodeSchemaZ = z.enum([
  "unknown-command",
  "invalid-invocation",
  "invalid-input",
  "unavailable",
]);

export const CommandResolutionErrorSchemaZ = z
  .object({
    code: CommandResolutionErrorCodeSchemaZ,
    message: z.string().min(1),
    commandId: CommandIdSchemaZ.optional(),
    details: z.json().optional(),
  })
  .strict();

export type CommandId = z.infer<typeof CommandIdSchemaZ>;
export type CommandOwner = z.infer<typeof CommandOwnerSchemaZ>;
export type CommandSourceKind = z.infer<typeof CommandSourceKindSchemaZ>;
export type CommandSource = z.infer<typeof CommandSourceSchemaZ>;
export type CommandDescriptor = z.infer<typeof CommandDescriptorSchemaZ>;
export type CommandArguments = z.infer<typeof CommandArgumentsSchemaZ>;
export type CommandInvocation = z.infer<typeof CommandInvocationSchemaZ>;
export type CommandAvailability = z.infer<typeof CommandAvailabilitySchemaZ>;
export type CommandResolutionErrorCode = z.infer<typeof CommandResolutionErrorCodeSchemaZ>;
export type CommandResolutionError = z.infer<typeof CommandResolutionErrorSchemaZ>;

/**
 * Stable semantic shell commands consumed by both OpenTUI and DOM hosts.
 * Host input events translate to these IDs; effects remain in the host root.
 */
export const APPLICATION_SHELL_COMMAND_IDS = Object.freeze({
  activateMode: "application.shell.mode.activate",
  activateDockTool: "application.shell.dock.activate",
  setDockMode: "application.shell.dock.mode.set",
  moveFocus: "application.shell.focus.move",
  openPalette: "application.shell.palette.open",
  closePalette: "application.shell.palette.close",
  selectResource: "application.shell.resource.select",
} as const satisfies Readonly<Record<string, CommandId>>);

export type ApplicationShellCommandId =
  (typeof APPLICATION_SHELL_COMMAND_IDS)[keyof typeof APPLICATION_SHELL_COMMAND_IDS];

export const ApplicationShellCommandIdSchemaZ = z.enum(
  Object.values(APPLICATION_SHELL_COMMAND_IDS) as [
    ApplicationShellCommandId,
    ...ApplicationShellCommandId[],
  ],
);

/**
 * Names reserved for the Gloomberb-inspired window-control work. They are not
 * command registrations yet and therefore cannot be invoked by Card07.
 */
export const WORKSPACE_WINDOW_MODE_COMMAND_IDS = [
  "workspace.windowMode.enter",
  "workspace.windowMode.exit",
  "workspace.windowMode.cancel",
  "workspace.windowMode.focus",
  "workspace.windowMode.move",
  "workspace.windowMode.resize",
  "workspace.windowMode.float.toggle",
  "workspace.windowMode.maximize.toggle",
  "workspace.windowMode.close",
] as const satisfies readonly CommandId[];

export type WorkspaceWindowModeCommandId = (typeof WORKSPACE_WINDOW_MODE_COMMAND_IDS)[number];
