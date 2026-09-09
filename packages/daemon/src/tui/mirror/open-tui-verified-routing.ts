import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  openPaneStreamRuntimeClient,
  type OpenPaneStreamClientOptions,
  type PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";

import { canonicalDaemonUrl } from "../../lib/canonical-daemon.ts";
import {
  readNativeBacking,
  type ReadNativeBacking,
  type NativeBackingIdentity,
} from "../../terminal/protocol/native-backing-client.ts";

import {
  applicationDaemonEndpoint,
  type ApplicationDaemonEndpoint,
} from "./runtime/application-daemon-authority.ts";

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
  readNativeBacking?: ReadNativeBacking;
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
  readEndpoint: () => ApplicationDaemonEndpoint = applicationDaemonEndpoint,
): OpenTuiVerifiedRoutingContext | null {
  if (!daemon.authToken) return null;
  const ownerToken = daemon.authToken;
  const endpoint = readEndpoint();
  const baseUrl = canonicalDaemonUrl("http", daemon.bindHostname, daemon.port);
  if (
    endpoint.kind === "ssh" &&
    (endpoint.state !== "ready" ||
      !endpoint.remote ||
      endpoint.remote.instanceId !== daemon.instanceId ||
      endpoint.remote.authToken !== ownerToken ||
      endpoint.localBaseUrl !== baseUrl)
  )
    throw new Error("OpenTUI daemon routing does not match the selected SSH connection");
  const remoteOrigin = endpoint.remote
    ? new URL(canonicalDaemonUrl("ws", endpoint.remote.bindHostname, endpoint.remote.port)).origin
    : null;
  const localSocketOrigin = new URL(baseUrl);
  localSocketOrigin.protocol = "ws:";
  const identity = Object.freeze({
    daemonInstanceId: daemon.instanceId,
    workspaceName,
    sessionName,
  });
  let current = true;
  const assertCurrent = (expected: OpenTuiVerifiedRoutingIdentity): void => {
    if (!current) throw new Error("OpenTUI daemon routing authority has been retired");
    const selected = readEndpoint();
    if (
      selected.kind !== endpoint.kind ||
      selected.epoch !== endpoint.epoch ||
      (endpoint.kind === "ssh" && selected.state !== "ready")
    ) {
      throw new Error("OpenTUI daemon routing connection has been retired");
    }
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
    readNativeBacking: async (
      paneId: string,
      expected: NativeBackingIdentity,
      signal: AbortSignal,
    ) => {
      assertCurrent({ ...identity, daemonInstanceId: expected.generation });
      const result = await readNativeBacking({
        baseUrl,
        ownerToken,
        workspaceName,
        paneId,
        expected,
        signal,
      });
      assertCurrent({ ...identity, daemonInstanceId: expected.generation });
      return result;
    },
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
        baseUrl,
        ownerToken,
        daemonInstanceId: identity.daemonInstanceId,
        createSocket: (descriptor, headers) => {
          assertCurrent(expected);
          if (endpoint.kind === "local") return options.createSocket(descriptor, headers);
          const advertised = new URL(descriptor.webSocketUrl);
          if (
            advertised.origin !== remoteOrigin ||
            advertised.username ||
            advertised.password ||
            advertised.hash
          ) {
            throw new Error("Pane-stream endpoint escaped its verified SSH daemon origin");
          }
          advertised.protocol = localSocketOrigin.protocol;
          advertised.host = localSocketOrigin.host;
          return options.createSocket({ ...descriptor, webSocketUrl: advertised.href }, headers);
        },
      });
    },
    retire: () => {
      current = false;
    },
  });
}
