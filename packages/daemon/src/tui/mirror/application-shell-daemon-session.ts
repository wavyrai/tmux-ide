import { type DesktopApplicationShellTarget, type InteractionReceipt } from "@tmux-ide/contracts";
import {
  createApplicationShellSession,
  type ApplicationShellSession,
} from "@tmux-ide/daemon-client/application-shell-session";
import {
  resolveOpenTuiApplicationShellConnection,
  type OpenTuiApplicationShellConnectionDependencies,
} from "./application-shell-daemon-connection.ts";
import type { OpenTuiVerifiedRoutingContext } from "./open-tui-verified-routing.ts";

export {
  openTuiDaemonDescriptor,
  resolveOpenTuiApplicationShellConnection,
  type OpenTuiApplicationShellConnection,
  type OpenTuiApplicationShellConnectionDependencies,
} from "./application-shell-daemon-connection.ts";

export interface OpenTuiApplicationShellAuthority {
  readonly workspaceName: string;
  readonly target: DesktopApplicationShellTarget;
  readonly session: ApplicationShellSession;
  readonly routing: OpenTuiVerifiedRoutingContext | null;
  dispose(): void;
}

interface OpenTuiApplicationShellAuthorityDependencies extends OpenTuiApplicationShellConnectionDependencies {
  readonly createSession: typeof createApplicationShellSession;
  readonly onInteractionReceipt?: (receipt: InteractionReceipt) => void;
}

const DEFAULT_SESSION_DEPENDENCIES = {
  createSession: createApplicationShellSession,
};

/**
 * Attach the OpenTUI semantic lane to the canonical daemon. The control-mode
 * client remains the byte/geometry fast lane; all workspace facts and event
 * recovery come from this shared daemon-client session.
 */
export async function connectOpenTuiApplicationShellAuthority(
  sessionName: string,
  overrides: Partial<OpenTuiApplicationShellAuthorityDependencies> = {},
): Promise<OpenTuiApplicationShellAuthority | null> {
  const dependencies = { ...DEFAULT_SESSION_DEPENDENCIES, ...overrides };
  const connection = await resolveOpenTuiApplicationShellConnection(sessionName, overrides);
  if (!connection) return null;
  let session: ApplicationShellSession;
  try {
    session = dependencies.createSession({
      target: connection.target,
      transport: connection.transport,
      ...(dependencies.onInteractionReceipt
        ? { onInteractionReceipt: dependencies.onInteractionReceipt }
        : {}),
    });
  } catch (error) {
    connection.dispose();
    throw error;
  }
  let disposed = false;
  return {
    workspaceName: connection.workspaceName,
    target: connection.target,
    session,
    routing: connection.routing,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      session.dispose();
      connection.dispose();
    },
  };
}
