import { describe, expect, it, vi } from "vitest";
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@tmux-ide/daemon-client/owner-action-client", () => ({ dispatchOwnerAction: dispatch }));
import { createFleetSession, closeFleetSession } from "./fleet-lifecycle-client.ts";
const daemonId = "11111111-1111-4111-8111-111111111111";
function handle() {
  let epoch = 1;
  const daemon = {
    instanceId: daemonId,
    startedAt: "now",
    authToken: "test-owner",
    bindHostname: "127.0.0.1",
    port: 4555,
  };
  return { read: () => daemon, endpoint: () => ({ epoch, state: "ready" }), change: () => epoch++ };
}
describe("explicit fleet lifecycle", () => {
  it("creates on the supplied handle and includes daemon fencing", async () => {
    const route = handle();
    dispatch.mockResolvedValueOnce({ daemonInstanceId: daemonId, outcome: "created" });
    expect(await createFleetSession(route as never, "hello")).toMatchObject({ outcome: "created" });
    expect(dispatch.mock.lastCall?.[0]).toMatchObject({
      baseUrl: "http://127.0.0.1:4555",
      input: { displayName: "hello", expectedDaemonInstanceId: daemonId },
    });
  });
  it("closes the exact incarnation through the owner lane without claiming a controller", async () => {
    dispatch.mockResolvedValueOnce({ daemonInstanceId: daemonId, outcome: "applied" });
    await closeFleetSession(handle() as never, {
      daemonInstanceId: daemonId,
      liveSessionId: `live-session.${"a".repeat(20)}`,
      sessionName: "work",
    });
    expect(dispatch.mock.lastCall?.[0]).toMatchObject({
      name: "workspace.session.kill",
      input: { fleetTarget: { daemonInstanceId: daemonId, sessionName: "work" } },
    });
    expect(dispatch.mock.lastCall?.[0]).not.toHaveProperty("hostClientId");
    expect(dispatch.mock.lastCall?.[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("rejects stale confirmation and late responses after route replacement", async () => {
    const route = handle();
    const count = dispatch.mock.calls.length;
    expect(
      await closeFleetSession(route as never, {
        daemonInstanceId: "22222222-2222-4222-8222-222222222222",
        liveSessionId: `live-session.${"a".repeat(20)}`,
        sessionName: "work",
      }),
    ).toBeNull();
    expect(dispatch.mock.calls.length).toBe(count);
    dispatch.mockImplementationOnce(async () => {
      route.change();
      return { daemonInstanceId: daemonId, outcome: "created" };
    });
    expect(await createFleetSession(route as never, "hello")).toBeNull();
  });
});
