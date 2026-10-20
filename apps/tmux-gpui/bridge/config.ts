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
    // Original advertised daemon origin, captured from the verified SSH handshake.
    remoteSocketOrigin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "ws:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          value === url.origin &&
          !url.username &&
          !url.password
        );
      })
      .optional(),
    ownerToken: z.string().min(1),
    scope: TmuxServerScopeSchemaZ,
    workspaceName: z.string().min(1),
    liveSessionId: z.string().min(1),
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    historyAnchor: z.uuid().optional(),
    historyUnavailable: z.boolean().optional(),
    visiblePaneIds: z.array(TerminalAttachmentSemanticPaneIdSchemaZ).min(1).max(24).optional(),
  })
  .strict();

export const hostSchema = connectionSchema.pick({
  baseUrl: true,
  ownerToken: true,
  scope: true,
  remoteSocketOrigin: true,
});
export type PreviewHost = z.infer<typeof hostSchema>;
export function readPrivateConfig(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0)
    throw new Error("Connection file must be private (chmod 600), regular and at most 16 KiB");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Validate the issued original endpoint before changing only its transport origin. */
export function paneStreamSocketUrl(
  config: Pick<PreviewHost, "baseUrl" | "remoteSocketOrigin">,
  advertisedUrl: string,
): string {
  // Direct/private routes retain their existing descriptor routing policy.
  if (!config.remoteSocketOrigin) return advertisedUrl;
  const local = new URL(config.baseUrl);
  local.protocol = "ws:";
  const advertised = new URL(advertisedUrl);
  if (
    advertised.origin !== (config.remoteSocketOrigin ?? local.origin) ||
    advertised.username ||
    advertised.password ||
    advertised.hash
  ) {
    throw new Error("Pane-stream endpoint does not match the verified daemon origin");
  }
  if (config.remoteSocketOrigin) {
    advertised.protocol = local.protocol;
    advertised.host = local.host;
  }
  return advertised.href;
}
