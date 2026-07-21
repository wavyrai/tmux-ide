import { z } from "zod";

import { ApplicationShellProjectionInputV1SchemaZ } from "./application-shell.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

export const APPLICATION_SHELL_RESOURCE_VERSION = 1 as const;

/**
 * Strict daemon-bound REST envelope. The projection input is not trusted
 * until the peer identity matches the desktop host's canonical descriptor.
 */
export const ApplicationShellResourceV1SchemaZ = z
  .object({
    version: z.literal(APPLICATION_SHELL_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    resource: ApplicationShellProjectionInputV1SchemaZ,
  })
  .strict();

export type ApplicationShellResourceV1 = z.infer<typeof ApplicationShellResourceV1SchemaZ>;
