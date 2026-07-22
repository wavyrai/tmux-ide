import { z } from "zod";

const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

function opaqueIdentity(prefix: string) {
  return z
    .string()
    .max(prefix.length + 64)
    .regex(new RegExp(`^${prefix.replace(".", "\\.")}[A-Za-z0-9_-]{16,64}$`, "u"))
    .refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");
}

/** Workspace name accepted by native read resources. It is a semantic name, never a path. */
export const WorkspaceResourceWorkspaceNameSchemaZ = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "workspace name contains control characters",
  );

/** Opaque daemon-issued identity. It deliberately cannot contain a path separator. */
export const WorkspaceFileResourceIdSchemaZ = opaqueIdentity("file.");
export const WorkspaceChangeResourceIdSchemaZ = opaqueIdentity("change.");
export const WorkspaceFilesRevisionSchemaZ = opaqueIdentity("files-rev.");
export const WorkspaceChangesRevisionSchemaZ = opaqueIdentity("changes-rev.");

/** Exported for daemon authors that need to validate a digest before prefixing it. */
export const WorkspaceResourceOpaqueTokenSchemaZ = z.string().regex(OPAQUE_TOKEN_PATTERN);

export const WorkspaceResourceNameSchemaZ = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== "..", "dot path segments are not resources")
  .refine((value) => !/[\\/\0\r\n]/u.test(value), "resource name must be one path segment")
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "resource name contains control characters",
  );

/**
 * Portable workspace-relative display path. Resource requests never accept this value;
 * callers use daemon-issued opaque ids instead.
 */
export const WorkspaceRelativeDisplayPathSchemaZ = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/"), "workspace display path must be relative")
  .refine((value) => !value.includes("\\"), "workspace display path uses forward slashes")
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "workspace display path contains control characters",
  )
  .refine(
    (value) =>
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "workspace display path contains an invalid segment",
  );

export type WorkspaceResourceWorkspaceName = z.infer<
  typeof WorkspaceResourceWorkspaceNameSchemaZ
>;
export type WorkspaceFileResourceId = z.infer<typeof WorkspaceFileResourceIdSchemaZ>;
export type WorkspaceChangeResourceId = z.infer<typeof WorkspaceChangeResourceIdSchemaZ>;
export type WorkspaceFilesRevision = z.infer<typeof WorkspaceFilesRevisionSchemaZ>;
export type WorkspaceChangesRevision = z.infer<typeof WorkspaceChangesRevisionSchemaZ>;
export type WorkspaceRelativeDisplayPath = z.infer<typeof WorkspaceRelativeDisplayPathSchemaZ>;
