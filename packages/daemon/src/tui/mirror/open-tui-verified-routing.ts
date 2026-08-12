import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  openPaneStreamRuntimeClient,
  type OpenPaneStreamClientOptions,
  type PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";

import { canonicalDaemonUrl } from "../../lib/canonical-daemon.ts";

export interface OpenTuiVerifiedRoutingIdentity {
  readonly daemonInstanceId: string;
  readonly workspaceName: string;
  readonly sessionName: string;
}

export type OpenTuiVerifiedPaneStreamOptions = Omit<
  OpenPaneStreamClientOptions,
  "baseUrl" | "ownerToken" | "daemonInstanceId"
>;

/**
 * Process-local capability minted only after canonical health and workspace
 * routing have both been verified. Credentials remain captured in the closure;
 * downstream render/runtime code can use the route but cannot inspect its token.
 */
export interface OpenTuiVerifiedRoutingContext extends OpenTuiVerifiedRoutingIdentity {
  assertCurrent(expected: OpenTuiVerifiedRoutingIdentity): void;
  openPaneStream(
    expected: OpenTuiVerifiedRoutingIdentity,
    options: OpenTuiVerifiedPaneStreamOptions,
  ): Promise<PaneStreamRuntimeClient>;
  retire(): void;
}

export function createOpenTuiVerifiedRoutingContext(
  daemon: CanonicalDaemonInfo,
  workspaceName: string,
  sessionName: string,
  openClient: typeof openPaneStreamRuntimeClient = openPaneStreamRuntimeClient,
): OpenTuiVerifiedRoutingContext | null {
  if (!daemon.authToken) return null;
  const ownerToken = daemon.authToken;
  const identity = Object.freeze({
    daemonInstanceId: daemon.instanceId,
    workspaceName,
    sessionName,
  });
  let current = true;
  const assertCurrent = (expected: OpenTuiVerifiedRoutingIdentity): void => {
    if (!current) throw new Error("OpenTUI daemon routing authority has been retired");
    if (expected.daemonInstanceId !== identity.daemonInstanceId) {
      throw new Error("OpenTUI daemon routing authority belongs to another daemon instance");
    }
    if (expected.workspaceName !== identity.workspaceName) {
      throw new Error("OpenTUI daemon routing authority belongs to another workspace");
    }
    if (expected.sessionName !== identity.sessionName) {
      throw new Error("OpenTUI daemon routing authority belongs to another tmux session");
    }
  };
  return Object.freeze({
    ...identity,
    assertCurrent,
    openPaneStream: async (
      expected: OpenTuiVerifiedRoutingIdentity,
      options: OpenTuiVerifiedPaneStreamOptions,
    ) => {
      assertCurrent(expected);
      if (options.stream.workspaceName !== identity.workspaceName) {
        throw new Error("Pane-stream request escaped its verified workspace route");
      }
      return await openClient({
        ...options,
        baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
        ownerToken,
        daemonInstanceId: identity.daemonInstanceId,
      });
    },
    retire: () => {
      current = false;
    },
  });
}
