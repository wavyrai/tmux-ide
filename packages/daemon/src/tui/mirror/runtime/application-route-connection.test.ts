import { expect, it, vi } from "vitest";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";
const f = vi.hoisted(() => ({ prepare: vi.fn(), ensure: vi.fn() }));
vi.mock("../application-shell-daemon-connection.ts", () => ({
  prepareOpenTuiApplicationShellConnection: f.prepare,
}));
vi.mock("../configless-session-bootstrap.ts", () => ({ ensureOpenTuiSessionWorkspace: f.ensure }));
import { applicationRouteConnection } from "./application-route-connection.ts";
it("pins reads, promotion and observation to the tab's route and rejects a replacement incarnation", async () => {
  const handle = {
    read: vi.fn(),
    isAlive: vi.fn(),
    observe: vi.fn(),
  } as unknown as ApplicationMachineAuthorityHandle;
  const dispose = vi.fn();
  f.prepare.mockResolvedValue({ liveSessionId: "replacement", dispose });
  const route = applicationRouteConnection(handle, "original");
  expect(route.readDaemon).toBe(handle.read);
  expect(route.observeCanonicalGeneration).toBe(handle.observe);
  expect(await route.resolveConnection("same-name")).toBeNull();
  expect(dispose).toHaveBeenCalledOnce();
  const deps = f.prepare.mock.calls[0][1];
  expect(deps.readCanonicalDaemonInfo).toBe(handle.read);
  expect(deps.isCanonicalDaemonAlive).toBe(handle.isAlive);
});
