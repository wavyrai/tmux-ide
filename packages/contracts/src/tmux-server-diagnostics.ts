import { z } from "zod";
import { TmuxServerScopeSchemaZ } from "./tmux-server-scope.ts";

/** Server format output only; never accept freeform diagnostic text. */
export const TmuxServerVersionSchemaZ = z
  .string()
  .max(32)
  .regex(/^[0-9]+\.[0-9]+[a-z]?$/u);
export const TmuxServerDiagnosticsSchemaZ = z
  .object({
    version: z.literal(1),
    server: TmuxServerScopeSchemaZ,
    tmuxVersion: TmuxServerVersionSchemaZ,
  })
  .strict();
export type TmuxServerDiagnostics = z.infer<typeof TmuxServerDiagnosticsSchemaZ>;
