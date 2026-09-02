import type { WorkspaceClient } from "./workspace-client-types.ts";

import {
  createWorkspaceClientTerminalSource,
  type CanonicalTerminalSubscriptionPort,
} from "./terminal-fast-lane.ts";

declare const canonicalPort: CanonicalTerminalSubscriptionPort;
declare const unknownTerminalClient: Pick<WorkspaceClient, "subscribeTerminal">;

// A transport ingress that has already established canonical terminal payloads is accepted.
createWorkspaceClientTerminalSource(canonicalPort);

// WorkspaceClient's default unknown payload parameters are deliberately insufficient here.
// @ts-expect-error unknown terminal payloads must be validated before entering the fast lane
createWorkspaceClientTerminalSource(unknownTerminalClient);
