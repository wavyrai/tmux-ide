import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverLiveSessionSummaries } from "../command-center/discovery.ts";
import { WorkspaceMultiplexerAuthority } from "./workspace-multiplexer-verbs.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";

describe("passive fleet close", () => {
  it("closes an unregistered exact runtime session and refuses reused names or daemon generations", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-close-"));
    const daemonInstanceId = randomUUID();
    let raw = "123\t$7\t456\twork";
    let alive = true;
    const calls: string[][] = [];
    const authority = new WorkspaceMultiplexerAuthority({
      daemonInstanceId,
      registry: new WorkspaceRegistry({ dir, listSessions: () => [] }),
      io: {
        runTmux: (args) => {
          calls.push([...args]);
          if (args[0] === "list-panes") return raw;
          expect(args[2]).toBe("$7");
          if (args[0] === "kill-session") {
            alive = false;
            return "";
          }
          if (!alive) throw new Error("missing");
          return "";
        },
        isMissingTmuxTarget: () => true,
      },
    });
    const liveSessionId = discoverLiveSessionSummaries(() => raw)[0]!.liveSessionId;
    const target = { daemonInstanceId, liveSessionId, sessionName: "work" };
    const request = () => ({
      operationId: randomUUID(),
      expectedDaemonInstanceId: daemonInstanceId,
      intent: {
        verb: "workspace.session.kill" as const,
        workspaceName: "work",
        fleetTarget: { ...target },
      },
    });
    try {
      raw = "123\t$8\t457\twork";
      expect(() => authority.mutate(request())).toThrow(/workspace/i);
      expect(calls.some((call) => call[0] === "kill-session")).toBe(false);
      raw = "123\t$7\t456\twork";
      const stale = request();
      stale.intent.fleetTarget.daemonInstanceId = randomUUID();
      expect(() => authority.mutate(stale)).toThrow(/daemon/i);
      expect(authority.mutate(request())).toMatchObject({ outcome: "applied" });
      expect(calls).toContainEqual(["kill-session", "-t", "$7"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
