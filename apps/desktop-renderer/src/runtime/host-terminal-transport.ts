import {
  TerminalAttachmentIssueResultSchemaZ,
  type DaemonInstanceIdentity,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import {
  NativeTerminalIssueError,
  createNativeTerminalWebSocketTransport,
} from "../terminal/native-terminal-websocket-transport.ts";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";

/**
 * Production terminal authority adapter. The renderer authors only a semantic
 * attachment request; the reviewed host capability owns daemon credentials,
 * the attachment ticket, and the exact daemon-generation check.
 */
export function createHostNativeTerminalTransport(
  host: Pick<HostCapabilities, "daemon">,
  daemon: DaemonInstanceIdentity,
): NativeTerminalTransport {
  return createNativeTerminalWebSocketTransport({
    issueAttachment: async (request) => {
      const result = TerminalAttachmentIssueResultSchemaZ.parse(
        await host.daemon.issueTerminalAttachment(request),
      );
      if (result.status === "error") {
        throw new NativeTerminalIssueError(
          result.error.code,
          result.error.reason,
          result.error.retryable,
        );
      }
      if (result.descriptor.daemonInstanceId !== daemon.instanceId) {
        throw new NativeTerminalIssueError(
          "daemon-identity-mismatch",
          "The terminal attachment belongs to another daemon generation.",
          true,
        );
      }
      return result.descriptor;
    },
  });
}
