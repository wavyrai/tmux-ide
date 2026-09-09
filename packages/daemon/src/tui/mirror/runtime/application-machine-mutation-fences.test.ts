import { beforeEach, describe, expect, it, vi } from "vitest";
const { state, ownerDispatch, daemon } = vi.hoisted(() => ({
  state: { epoch: 1 },
  ownerDispatch: vi.fn(),
  daemon: {
    pid: 123,
    port: 7331,
    protocolVersion: 2,
    productVersion: "beta",
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    startedAt: "2026-09-09T10:00:00.000Z",
    bindHostname: "127.0.0.1",
    authToken: "private-local",
  },
}));
vi.mock("./application-daemon-authority.ts", () => ({
  applicationDaemonEndpoint: () => ({ kind: "local", epoch: state.epoch }),
  readApplicationDaemonInfo: () => daemon,
  isApplicationDaemonAlive: async () => true,
}));
vi.mock("@tmux-ide/daemon-client/owner-action-client", async () => ({
  ...(await vi.importActual<typeof import("@tmux-ide/daemon-client/owner-action-client")>(
    "@tmux-ide/daemon-client/owner-action-client",
  )),
  dispatchOwnerAction: ownerDispatch,
}));
import { executeTuiAgentProvisioning } from "../agent-provisioning-executor.ts";
import { executeTuiMultiplexerAction } from "../multiplexer-action-executor.ts";
import {
  createFleetSession,
  mutateFleetAgent,
  provisionFleetAgent,
} from "./fleet-lifecycle-client.ts";
const agent = {
  sessionName: "same-name",
  kind: "codex",
  command: "codex",
  displayTitle: "Codex",
  placement: "window" as const,
  targetSemanticPaneId: null,
};
const context = { sessionName: "same-name", focusedRuntimePaneId: null, paneDescriptors: [] };
function catalog() {
  return Response.json({
    version: 2,
    daemon: {
      protocolVersion: 2,
      productVersion: "beta",
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
    },
    intents: [
      {
        workspaceName: "workspace",
        sessionName: "same-name",
        source: "workspace",
        availability: "live",
      },
    ],
    liveSessions: [
      { sessionName: "same-name", fleetSessionId: "session.aaaaaaaaaaaaaaaaaaaa", paneCount: 1 },
    ],
  });
}
beforeEach(() => {
  state.epoch = 1;
  ownerDispatch.mockReset();
});
describe("machine selection async mutation fences", () => {
  it("does not fall back to local tmux when selection changes during liveness checking", async () => {
    const local = vi.fn();
    const alive = async () => {
      state.epoch++;
      return false;
    };
    expect(
      (
        await executeTuiMultiplexerAction({ kind: "kill-session" }, context, local, {
          isCanonicalDaemonAlive: alive,
        })
      ).status,
    ).toBe("error");
    expect(
      (await executeTuiAgentProvisioning(agent, { isCanonicalDaemonAlive: alive })).status,
    ).toBe("error");
    expect(local).not.toHaveBeenCalled();
  });
  it("does not dispatch a mutation after a catalog read crosses a machine switch", async () => {
    const request = vi.fn(async () => {
      state.epoch++;
      return catalog();
    }) as unknown as typeof fetch;
    const dispatch = vi.fn();
    const create = vi.fn();
    expect(
      (
        await executeTuiMultiplexerAction({ kind: "kill-session" }, context, vi.fn(), {
          fetch: request,
          dispatchAction: dispatch,
        })
      ).status,
    ).toBe("error");
    expect(
      (await executeTuiAgentProvisioning(agent, { fetch: request, createWorkspacePane: create }))
        .status,
    ).toBe("error");
    expect(dispatch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("ignores a completed old-machine agent or multiplexer result after selection changes", async () => {
    const request = vi.fn(async () => catalog()) as unknown as typeof fetch;
    const delayed = vi.fn(async () => {
      state.epoch++;
      return { outcome: "created" } as never;
    });
    expect(
      (
        await executeTuiMultiplexerAction({ kind: "kill-session" }, context, vi.fn(), {
          fetch: request,
          dispatchAction: delayed,
        })
      ).status,
    ).toBe("error");
    expect(
      (await executeTuiAgentProvisioning(agent, { fetch: request, createWorkspacePane: delayed }))
        .status,
    ).toBe("error");
    expect(delayed).toHaveBeenCalledTimes(2);
  });
  it("suppresses late fleet results so callers cannot open them on the newly selected machine", async () => {
    ownerDispatch.mockImplementation(async () => {
      state.epoch++;
      return { workspaceName: "same-name" };
    });
    for (const action of [createFleetSession, mutateFleetAgent, provisionFleetAgent])
      expect(await action({} as never)).toBeNull();
    expect(ownerDispatch).toHaveBeenCalledTimes(3);
    expect(
      ownerDispatch.mock.calls.every(([request]) => request.baseUrl === "http://127.0.0.1:7331"),
    ).toBe(true);
  });
});
