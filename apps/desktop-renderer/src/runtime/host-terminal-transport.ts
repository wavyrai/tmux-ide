import {
  TerminalAttachmentIssueResultSchemaZ,
  type DaemonInstanceIdentity,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { createNativeTerminalWebSocketTransport } from "../terminal/native-terminal-websocket-transport.ts";
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
      if (result.status === "error") throw new Error(result.error.reason);
      if (result.descriptor.daemonInstanceId !== daemon.instanceId) {
        throw new Error("The terminal attachment belongs to another daemon generation.");
      }
      return result.descriptor;
    },
  });
}
