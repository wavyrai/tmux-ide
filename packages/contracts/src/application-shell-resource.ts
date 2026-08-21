import { z } from "zod";

import {
  ApplicationShellProjectionInputV1WireSchemaZ,
  ApplicationShellProjectionInputV2SchemaZ,
  ApplicationShellProjectionInputV3SchemaZ,
} from "./application-shell.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

export const APPLICATION_SHELL_RESOURCE_V1_VERSION = 1 as const;
export const APPLICATION_SHELL_RESOURCE_V2_VERSION = 2 as const;
export const APPLICATION_SHELL_RESOURCE_V3_VERSION = 3 as const;

/**
 * Strict daemon-bound REST envelope. The projection input is not trusted
 * until the peer identity matches the desktop host's canonical descriptor.
 */
export const ApplicationShellResourceV1SchemaZ = z
  .object({
    version: z.literal(APPLICATION_SHELL_RESOURCE_V1_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    resource: ApplicationShellProjectionInputV1WireSchemaZ,
  })
  .strict();

export type ApplicationShellResourceV1 = z.infer<typeof ApplicationShellResourceV1SchemaZ>;

/** V2 is the first application-shell wire resource with terminal inventory. */
export const ApplicationShellResourceV2SchemaZ = z
  .object({
    version: z.literal(APPLICATION_SHELL_RESOURCE_V2_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    resource: ApplicationShellProjectionInputV2SchemaZ,
  })
  .strict();
export type ApplicationShellResourceV2 = z.infer<typeof ApplicationShellResourceV2SchemaZ>;

/** V3 adds the durable app-window document used by native canvas hosts. */
export const ApplicationShellResourceV3SchemaZ = z
  .object({
    version: z.literal(APPLICATION_SHELL_RESOURCE_V3_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    resource: ApplicationShellProjectionInputV3SchemaZ,
  })
  .strict();
export type ApplicationShellResourceV3 = z.infer<typeof ApplicationShellResourceV3SchemaZ>;

/** Reader for persisted/captured envelopes across application-shell revisions. */
export const ApplicationShellResourceSchemaZ = z.discriminatedUnion("version", [
  ApplicationShellResourceV1SchemaZ,
  ApplicationShellResourceV2SchemaZ,
  ApplicationShellResourceV3SchemaZ,
]);
export type ApplicationShellResource = z.infer<typeof ApplicationShellResourceSchemaZ>;
