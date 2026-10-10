import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import {
  TmuxServerScopeSchemaZ,
  TerminalAttachmentSemanticPaneIdSchemaZ,
} from "../../../packages/contracts/src/index.ts";
export const connectionSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((s) => {
        const u = new URL(s);
        return (
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
          !u.username &&
          !u.password &&
          u.pathname === "/" &&
          !u.search &&
          !u.hash
        );
      }),
    ownerToken: z.string().min(1),
    scope: TmuxServerScopeSchemaZ,
    workspaceName: z.string().min(1),
    liveSessionId: z.string().min(1),
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    visiblePaneIds: z.array(TerminalAttachmentSemanticPaneIdSchemaZ).min(1).max(24).optional(),
  })
  .strict();

export const hostSchema = connectionSchema.pick({ baseUrl: true, ownerToken: true, scope: true });
export type PreviewHost = z.infer<typeof hostSchema>;
export function readPrivateConfig(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0)
    throw new Error("Connection file must be private (chmod 600), regular and at most 16 KiB");
  return JSON.parse(readFileSync(path, "utf8"));
}
