import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { PaneStreamIssueDescriptor } from "@tmux-ide/contracts";
import { createDesktopEnvironmentRuntime } from "./environment-runtime.ts";
import { KnownEnvironmentCatalog } from "./environment-catalog.ts";
import { startEnvironmentStreamRelay } from "./environment-stream-relay.ts";
import { packagedRendererContentSecurityPolicy } from "./packaged-renderer-protocol.ts";
import type { HostIpcDependencies, HostStreamRelayContext } from "./host-ipc.ts";
import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const instanceId = "10000000-0000-4000-8000-000000000002";
async function fixture(
  savedMachines: NonNullable<
    Parameters<typeof createDesktopEnvironmentRuntime>[0]["savedMachines"]
  >,
) {
  const directory = await mkdtemp(join(tmpdir(), "environment-runtime-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const catalog = new KnownEnvironmentCatalog(join(directory, "catalog.json"));
  const relay = await startEnvironmentStreamRelay({ trustedOrigin: "tmux-ide://app" });
  cleanup.push(() => relay.dispose());
  let upstream = "ws://127.0.0.1:6100";
  const local = {
    state: () => ({
      status: "connected",
      identity: {
        instanceId,
        protocolVersion: 1,
        productVersion: "2.9.0",
        startedAt: "2026-09-10T00:00:00.000Z",
      },
    }),
  } as DaemonConnectionAuthority;
  const runtime = await createDesktopEnvironmentRuntime({
    catalog,
    relay,
    savedMachines,
    localAuthority: local,
    localStreamOrigin: () => upstream,
    host: { getWindow: () => null } as unknown as Omit<
      HostIpcDependencies,
      "daemonResources" | "channelScope"
    >,
  });
  cleanup.push(() => runtime.dispose());
  return {
    runtime,
    catalog,
    relay,
    changeOrigin: (value: string) => {
      upstream = value;
    },
  };
}
const machine = (enabled = true) => ({
  id: "20000000-0000-4000-8000-000000000002",
  label: "Office",
  sshTarget: "office",
  enabled,
});
it("imports only enabled saved machines and refuses disabled or unknown routes", async () => {
  const { runtime, catalog } = await fixture(() => ({
    version: 1,
    machines: [
      machine(),
      {
        ...machine(false),
        id: "30000000-0000-4000-8000-000000000002",
        label: "Disabled",
        sshTarget: "disabled",
      },
    ],
  }));
  expect((await runtime.environments.list()).map((entry) => entry.label)).toEqual([
    "Local daemon",
    "Office",
  ]);
  const disabled = await catalog.addSsh("disabled");
  await expect(runtime.environments.open(disabled.id)).rejects.toThrow("disabled");
  await expect(runtime.environments.open(catalog.localCanonical().id)).rejects.toThrow("remote");
});
it("keeps local usable when the shared registry is invalid", async () => {
  const { runtime } = await fixture(() => {
    throw Error("invalid registry");
  });
  expect(await runtime.environments.list()).toMatchObject([
    { kind: "local-canonical", phase: "ready" },
  ]);
});
it("keeps one CSP stream origin across upstream replacement and revokes old tickets", async () => {
  const { runtime, relay, changeOrigin } = await fixture(() => ({ version: 1, machines: [] }));
  const csp = packagedRendererContentSecurityPolicy(relay.origin.replace("ws:", "http:"));
  const descriptor: PaneStreamIssueDescriptor = {
    protocolVersion: 1,
    webSocketUrl: "ws://127.0.0.1:9999/v1/terminal/pane-streams/redeem",
    subprotocol: "tmux-ide-pane-stream.v1",
    redemptionTicket: `ps1_${"A".repeat(43)}`,
    daemonInstanceId: instanceId,
    requestId: "40000000-0000-4000-8000-000000000002",
    expiresAt: Date.now() + 15000,
    panes: ["pane.workspace.one"],
    effectiveViewerMode: "read-only",
  };
  const context = {
    rendererOrigin: "tmux-ide://app",
    hostClientId: "host-one",
    rendererGeneration: 1,
    isCurrent: () => true,
  } as HostStreamRelayContext;
  const first = runtime.localHooks.relayPaneStream(descriptor, context);
  expect(first.webSocketUrl).toBe(`${relay.origin}/v1/terminal/pane-streams/redeem`);
  expect(relay.diagnostics().tickets).toBe(1);
  changeOrigin("ws://127.0.0.1:6200");
  runtime.localChanged();
  expect(relay.diagnostics().tickets).toBe(0);
  const second = runtime.localHooks.relayPaneStream(
    { ...descriptor, redemptionTicket: `ps1_${"B".repeat(43)}` },
    context,
  );
  expect(second.webSocketUrl).toBe(first.webSocketUrl);
  expect(csp).toContain(`connect-src 'self' ${relay.origin}`);
  expect(csp).not.toMatch(/6100|6200|9999|\*|localhost/);
  runtime.localHooks.rendererDidRelease(context.hostClientId);
  expect(relay.diagnostics().tickets).toBe(0);
  expect(() =>
    runtime.localHooks.relayPaneStream(descriptor, { ...context, isCurrent: vi.fn(() => false) }),
  ).toThrow("retired");
});
