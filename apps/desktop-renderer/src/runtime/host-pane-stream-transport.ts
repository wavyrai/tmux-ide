import {
  PaneStreamIssueResultSchemaZ,
  type DaemonInstanceIdentity,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import {
  PaneStreamIssueFailure,
  createPaneStreamTransport,
} from "../terminal/pane-stream-transport.ts";
import type { PaneStreamTransport } from "../terminal/pane-stream-transport.ts";
import type { GuiPerformanceTelemetrySink } from "./gui-performance-telemetry.ts";

/**
 * Production pane-stream authority adapter (m43 card 3). The renderer authors
 * only a semantic lease request; the reviewed host capability owns daemon
 * credentials, the stream ticket, and the exact daemon-generation check.
 */
export function createHostPaneStreamTransport(
  host: Pick<HostCapabilities, "daemon">,
  daemon: DaemonInstanceIdentity,
  performanceTelemetry?: GuiPerformanceTelemetrySink | null,
): PaneStreamTransport {
  return createPaneStreamTransport({
    performanceTelemetry,
    issuePaneStream: async (request) => {
      const result = PaneStreamIssueResultSchemaZ.parse(await host.daemon.issuePaneStream(request));
      if (result.status === "error") {
        throw new PaneStreamIssueFailure(
          result.error.code,
          result.error.reason,
          result.error.retryable,
        );
      }
      if (result.descriptor.daemonInstanceId !== daemon.instanceId) {
        throw new PaneStreamIssueFailure(
          "daemon-identity-mismatch",
          "The pane stream belongs to another daemon generation.",
          true,
        );
      }
      return result.descriptor;
    },
  });
}
