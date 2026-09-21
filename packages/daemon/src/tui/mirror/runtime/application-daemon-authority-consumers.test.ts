import { describe, expect, it, vi } from "vitest";

const { readLocal } = vi.hoisted(() => ({
  readLocal: vi.fn(() => ({ pid: 123, port: 7331, authToken: "local-owner-token" })),
}));
vi.mock("./application-daemon-authority.ts", async () => {
  const actual = await vi.importActual<typeof import("./application-daemon-authority.ts")>(
    "./application-daemon-authority.ts",
  );
  const authority = actual.createApplicationDaemonAuthority({
    readLocal: readLocal as never,
    isLocalAlive: async () => true,
    observeLocal: async () => () => {},
    connect: async () => {
      throw new Error("offline remote fixture");
    },
  });
  await authority.initialize("remote-fixture").catch(() => {});
  return {
    ...actual,
    readApplicationDaemonInfo: authority.read,
    isApplicationDaemonAlive: authority.isAlive,
    applicationDaemonEndpoint: authority.endpoint,
    observeApplicationDaemonGeneration: authority.observe,
  };
});

import { executeTuiAgentProvisioning } from "../agent-provisioning-executor.ts";
import { executeTuiMultiplexerAction } from "../multiplexer-action-executor.ts";
import { ensureOpenTuiSessionWorkspaceResult } from "../configless-session-bootstrap.ts";
import { createFleetSession } from "./fleet-lifecycle-client.ts";

describe("remote authority production consumers", () => {
  it("never falls back to a live local daemon or local tmux when remote is offline", async () => {
    const runLocal = vi.fn();
    const request = vi.fn();
    const provision = await executeTuiAgentProvisioning(
      {
        sessionName: "same-name-on-both-hosts",
        kind: "codex",
        command: "codex",
        displayTitle: "agent",
        placement: "window",
        targetSemanticPaneId: null,
      },
      { fetch: request },
    );
    expect(provision.status).toBe("error");
    const mutation = await executeTuiMultiplexerAction(
      { kind: "kill-session" },
      {
        sessionName: "same-name-on-both-hosts",
        focusedRuntimePaneId: "%0",
        paneDescriptors: [],
      },
      runLocal,
      { fetch: request },
    );
    expect(mutation.status).toBe("error");
    expect(
      await ensureOpenTuiSessionWorkspaceResult("same-name-on-both-hosts", { request }),
    ).toMatchObject({
      status: "unavailable",
      reason: "daemon-unavailable",
    });
    expect(await createFleetSession({} as never)).toBeNull();
    expect(readLocal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(runLocal).not.toHaveBeenCalled();
  });
});
