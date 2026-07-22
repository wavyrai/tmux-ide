import { z } from "zod";

const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const PORTABLE_WORKSPACE_ID_MAX_LENGTH = 128;

/**
 * Portable record identity shared by workspace state and semantic pane
 * attachment. Keep transport punctuation such as `:` outside this boundary.
 */
export const PortableWorkspaceIdSchemaZ = z
  .string()
  .min(1)
  .max(PORTABLE_WORKSPACE_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");

/** Product-generated fallback ids are display-only and never attachment authority. */
export const RESERVED_DISCOVERED_TERMINAL_ID_PREFIX = "terminal.discovered." as const;
export const TerminalAttachmentSemanticPaneIdSchemaZ = PortableWorkspaceIdSchemaZ.refine(
  (value) => !value.startsWith(RESERVED_DISCOVERED_TERMINAL_ID_PREFIX),
  "reserved discovered-terminal identity is a fallback and is not attachable",
);
export type TerminalAttachmentSemanticPaneId = z.infer<
  typeof TerminalAttachmentSemanticPaneIdSchemaZ
>;
