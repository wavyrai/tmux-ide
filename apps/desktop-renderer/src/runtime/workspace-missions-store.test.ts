import { describe, expect, it, vi } from "vitest";
import type { HostCapabilities } from "@tmux-ide/contracts";

import { createWorkspaceMissionsStore } from "./workspace-missions-store.ts";

const DAEMON = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};
const TARGET = { daemon: DAEMON, workspaceName: "product workspace" };

const RESOURCE = {
  status: "empty" as const,
  counts: { missions: 0, history: 0, activity: 0 },
  missions: [],
  history: [],
  activity: [],
  truncated: false,
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("workspace missions push store", () => {
  it("is inert until Missions/Activity acquires its explicit interest", async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(async () => ({ status: "subscribed" as const, unsubscribe }));
    const fetchWorkspaceMissions = vi.fn(async () => ({
      status: "ok" as const,
      envelope: {
        version: 1 as const,
        daemon: DAEMON,
        resource: {
          workspaceName: "product workspace",
          missionWorkspace: RESOURCE,
        },
      },
    }));
    const host = {
      daemon: { subscribe, fetchWorkspaceMissions } as unknown as HostCapabilities["daemon"],
    };
    const store = createWorkspaceMissionsStore({ host, target: TARGET, active: false });
    await flush();
    expect(store.getState().status).toBe("inactive");
    expect(fetchWorkspaceMissions).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    store.setActive(true);
    await vi.waitFor(() => expect(fetchWorkspaceMissions).toHaveBeenCalledOnce());
    expect(subscribe).toHaveBeenCalledWith(
      {
        workspaceNames: [],
        resourceInterests: [{ resource: "workspace-missions", workspaceName: "product workspace" }],
      },
      expect.any(Function),
    );
    expect(store.getState()).toMatchObject({
      status: "loaded",
      resource: { workspaceName: "product workspace", missionWorkspace: RESOURCE },
    });
    expect(store.getMetrics()).toMatchObject({
      activeInterests: 1,
      fetchesStarted: 1,
      fetchesSettled: 1,
      subscriptionsOpened: 1,
    });

    store.setActive(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(store.getState().status).toBe("inactive");
    expect(store.getMetrics()).toMatchObject({
      activeInterests: 0,
      subscriptionsClosed: 1,
    });
  });
});
