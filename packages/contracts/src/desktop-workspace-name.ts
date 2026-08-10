import { z } from "zod";

/** Leaf schema shared by desktop-host and replayable daemon events. */
export const DesktopWorkspaceNameSchemaZ = z
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

export type DesktopWorkspaceName = z.infer<typeof DesktopWorkspaceNameSchemaZ>;
