import { z } from "zod";

import {
  COMMAND_PROTOCOL_VERSION,
  CommandDescriptorSchemaZ,
  CommandSourceSchemaZ,
  type CommandDescriptor,
  type CommandSource,
} from "./commands.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-host.ts";
import { WorkspaceAgentRoleSchemaZ } from "./workspace-config.ts";

export const WORKSPACE_PANE_CREATE_COMMAND_ID = "workspace.pane.create" as const;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

/**
 * An opaque product identity chosen from a host-provided semantic catalog.
 *
 * tmux target syntax and filesystem paths are deliberately excluded. The
 * trusted daemon adapter owns resolution from these identities to runtime
 * sessions, panes, executables, and working directories.
 */
export const WorkspacePaneCreationReferenceSchemaZ = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value === value.trim(), "reference must not have outer whitespace")
  .refine((value) => !hasControlCharacters(value), "reference must not contain controls")
  .refine((value) => !/[\\/]/u.test(value), "reference must not be a filesystem path")
  .refine((value) => !/^[%$@]/u.test(value), "reference must not use tmux target syntax");

/**
 * The desktop workspace catalog's canonical name, accepted only when parsing
 * is lossless. Slash-containing names remain valid names and are never
 * interpreted as paths by the renderer.
 */
export const WorkspacePaneCreationWorkspaceNameSchemaZ = z
  .string()
  .superRefine((raw, context) => {
    const parsed = DesktopWorkspaceNameSchemaZ.safeParse(raw);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "invalid desktop workspace name" });
      return;
    }
    if (parsed.data !== raw) {
      context.addIssue({
        code: "custom",
        message: "workspace name must already be in canonical form",
      });
    }
  })
  .pipe(DesktopWorkspaceNameSchemaZ);

export const WorkspacePaneDisplayTitleSchemaZ = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim(), "display title must not have outer whitespace")
  .refine((value) => !hasControlCharacters(value), "display title must not contain controls");

const WorkspacePaneCreationBaseArgumentsSchemaZ = z.object({
  workspaceName: WorkspacePaneCreationWorkspaceNameSchemaZ,
  displayTitle: WorkspacePaneDisplayTitleSchemaZ.optional(),
});

export const WorkspaceTerminalCreateArgumentsSchemaZ =
  WorkspacePaneCreationBaseArgumentsSchemaZ.extend({
    kind: z.literal("terminal"),
  }).strict();

export const WorkspaceAgentCreateArgumentsSchemaZ =
  WorkspacePaneCreationBaseArgumentsSchemaZ.extend({
    kind: z.literal("agent"),
    harnessProfileId: WorkspacePaneCreationReferenceSchemaZ,
    role: WorkspaceAgentRoleSchemaZ,
    missionId: WorkspacePaneCreationReferenceSchemaZ.optional(),
  }).strict();

export const WorkspacePaneCreateArgumentsSchemaZ = z.discriminatedUnion("kind", [
  WorkspaceTerminalCreateArgumentsSchemaZ,
  WorkspaceAgentCreateArgumentsSchemaZ,
]);

export const WorkspacePaneCreateInvocationSchemaZ = z
  .object({
    version: z.literal(COMMAND_PROTOCOL_VERSION),
    id: z.literal(WORKSPACE_PANE_CREATE_COMMAND_ID),
    source: CommandSourceSchemaZ,
    args: WorkspacePaneCreateArgumentsSchemaZ,
  })
  .strict();

export type WorkspacePaneCreateArguments = z.infer<typeof WorkspacePaneCreateArgumentsSchemaZ>;
export type WorkspacePaneCreateInvocation = z.infer<typeof WorkspacePaneCreateInvocationSchemaZ>;

/**
 * Host-to-daemon mutation envelope. The renderer authors only `intent`; a
 * trusted host transport supplies retry and daemon-generation metadata.
 */
export const WorkspacePaneCreateMutationRequestSchemaZ = z
  .object({
    operationId: z.uuid(),
    expectedDaemonInstanceId: z.uuid(),
    intent: WorkspacePaneCreateArgumentsSchemaZ,
  })
  .strict();
export type WorkspacePaneCreateMutationRequest = z.infer<
  typeof WorkspacePaneCreateMutationRequestSchemaZ
>;

const WorkspacePaneCreatedResourceBaseSchemaZ = z.object({
  resourceVersion: z.literal(1),
  workspaceName: WorkspacePaneCreationWorkspaceNameSchemaZ,
  semanticPaneId: WorkspacePaneCreationReferenceSchemaZ,
  displayTitle: WorkspacePaneDisplayTitleSchemaZ,
});

export const WorkspacePaneCreatedResourceSchemaZ = z.discriminatedUnion("kind", [
  WorkspacePaneCreatedResourceBaseSchemaZ.extend({
    kind: z.literal("terminal"),
    harnessProfileId: z.null(),
    role: z.null(),
    missionId: z.null(),
  }).strict(),
  WorkspacePaneCreatedResourceBaseSchemaZ.extend({
    kind: z.literal("agent"),
    harnessProfileId: WorkspacePaneCreationReferenceSchemaZ,
    role: WorkspaceAgentRoleSchemaZ,
    missionId: WorkspacePaneCreationReferenceSchemaZ.nullable(),
  }).strict(),
]);
export type WorkspacePaneCreatedResource = z.infer<typeof WorkspacePaneCreatedResourceSchemaZ>;

/** Stable semantic result. Live tmux ids, cwd, argv, and environment stay daemon-private. */
export const WorkspacePaneCreateMutationResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["created", "replayed"]),
    resource: WorkspacePaneCreatedResourceSchemaZ,
  })
  .strict();
export type WorkspacePaneCreateMutationResult = z.infer<
  typeof WorkspacePaneCreateMutationResultSchemaZ
>;

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const WORKSPACE_PANE_CREATE_COMMAND_DESCRIPTOR: CommandDescriptor = deepFreeze(
  CommandDescriptorSchemaZ.parse({
    version: COMMAND_PROTOCOL_VERSION,
    id: WORKSPACE_PANE_CREATE_COMMAND_ID,
    owner: "daemon",
    label: "Create terminal or agent",
    description:
      "Ask the daemon to create a tmux-backed terminal or harness-backed agent from semantic workspace resources.",
    category: "workspace",
    schemas: {
      input: "workspace.pane.create.input.v1",
      result: "workspace.pane.create.result.v1",
    },
    dangerous: false,
    confirmation: "none",
  }),
);

export function workspacePaneCreateInvocation(
  args: WorkspacePaneCreateArguments,
  source: CommandSource,
): WorkspacePaneCreateInvocation {
  return deepFreeze(
    WorkspacePaneCreateInvocationSchemaZ.parse({
      version: COMMAND_PROTOCOL_VERSION,
      id: WORKSPACE_PANE_CREATE_COMMAND_ID,
      source,
      args,
    }),
  );
}
