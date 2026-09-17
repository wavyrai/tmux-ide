import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const mock = vi.hoisted(() => ({
  status: vi.fn(),
  identity: vi.fn(),
  owner: vi.fn(),
  build: vi.fn(),
  canonical: vi.fn(),
  barrier: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../lib/development-lifecycle.ts", () => ({
  statusDevelopmentInstance: mock.status,
  developmentOwnerEnvironment: () => ({ PRIVATE_NAMESPACE: "verified" }),
}));
vi.mock("../lib/development-state.ts", () => ({
  readDevelopmentIdentity: mock.identity,
  readDevelopmentOwner: mock.owner,
  ownerBuildEnvironment: (owner: { generation: string; manifestHash: string }) => ({
    TMUX_IDE_DEVELOPMENT_BUILD: owner.generation,
    TMUX_IDE_DEVELOPMENT_BUILD_HASH: owner.manifestHash,
  }),
}));
vi.mock("../lib/development-build.ts", () => ({ readDevelopmentBuild: mock.build }));
vi.mock("../lib/development-suspension.ts", () => ({
  requireDevelopmentNotSuspended: mock.barrier,
}));
vi.mock("../lib/canonical-daemon.ts", () => ({ inspectCanonicalDaemonInfoPath: mock.canonical }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => {}, { [promisify.custom]: mock.execute }) };
});
import { developmentSshAuthority, developmentSshHandshake } from "../lib/development-ssh.ts";
import type { DevelopmentInstance } from "../lib/development-instance.ts";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
const instance: DevelopmentInstance = {
  id: `dev-${"a".repeat(24)}`,
  digest: "a".repeat(64),
  worktree: "/workspace/tree",
  name: `ti-dev-${"a".repeat(24)}`,
  store: "/state/instances",
  root: "/state/instances/instances/a",
  stateHome: "/state/instances/instances/a/state",
  runtimeDir: "/tmp/ti-dev-1000/a",
};
const generation = `build-${randomUUID()}`;
const owner = {
  pid: 123,
  attempt: randomUUID(),
  incarnation: "verified-process",
  generation,
  manifestHash: "b".repeat(64),
};
const daemon = {
  instanceId: randomUUID(),
  pid: 123,
  port: 43210,
  startedAt: "2026-09-17T00:00:00Z",
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.9.0-beta.18",
  bindHostname: "127.0.0.1",
  authToken: "SECRET_NOT_FOR_ERRORS",
};
const status = {
  state: "ready",
  daemon: { pid: daemon.pid, port: daemon.port, instanceId: daemon.instanceId, claimId: "claim" },
  activeBuild: { generation },
  selectedBuild: { generation: "different-selected-generation" },
};
beforeEach(() => {
  vi.resetAllMocks();
  mock.status.mockResolvedValue(status);
  mock.identity.mockResolvedValue({ capability: "private" });
  mock.owner.mockReturnValue(owner);
  mock.build.mockReturnValue({
    capabilities: ["container-suspension-v1"],
    tools: { node: "/exact/node" },
    cli: "/exact/cli.js",
  });
  mock.canonical.mockReturnValue({ status: "valid", info: daemon });
  mock.execute.mockResolvedValue({ stdout: JSON.stringify({ version: 1, daemon }), stderr: "" });
});
it("uses active pin, exact runtime and validated namespace; lease is credential-free", async () => {
  const { lease } = await developmentSshAuthority(instance);
  expect(JSON.stringify(lease)).not.toContain(daemon.authToken);
  expect(lease.generation).toBe(generation);
  const output = await developmentSshHandshake(instance, lease);
  expect(JSON.parse(output).daemon.authToken).toBe(daemon.authToken);
  expect(mock.execute).toHaveBeenCalledWith(
    "/exact/node",
    ["/exact/cli.js", "remote-daemon-info", "--json"],
    expect.objectContaining({
      timeout: 5000,
      maxBuffer: 65536,
      env: { PRIVATE_NAMESPACE: "verified" },
    }),
  );
  expect(mock.build).toHaveBeenCalledWith(instance, {
    TMUX_IDE_DEVELOPMENT_BUILD: generation,
    TMUX_IDE_DEVELOPMENT_BUILD_HASH: owner.manifestHash,
  });
});
it.each(["stopped", "starting", "blocked", "missing"])(
  "refuses %s without any start or CLI fallback",
  async (state) => {
    mock.status.mockResolvedValue({ ...status, state });
    await expect(developmentSshAuthority(instance)).rejects.toThrow("verified ready owner");
    expect(mock.execute).not.toHaveBeenCalled();
  },
);
it("rejects unsupported artifact and owner change during readiness verification", async () => {
  mock.build.mockReturnValueOnce({ capabilities: [] });
  await expect(developmentSshAuthority(instance)).rejects.toThrow();
  mock.owner.mockReturnValueOnce(owner).mockReturnValueOnce({ ...owner, attempt: randomUUID() });
  await expect(developmentSshAuthority(instance)).rejects.toThrow();
});
it.each(["localhost", "::1", "0.0.0.0"])(
  "rejects canonical %s outside the fixed forwarding contract",
  async (bindHostname) => {
    mock.canonical.mockReturnValue({ status: "valid", info: { ...daemon, bindHostname } });
    await expect(developmentSshAuthority(instance)).rejects.toThrow();
  },
);
it.each(["pid", "port", "instanceId", "startedAt", "productVersion", "bindHostname"])(
  "buffers and rejects changed handshake %s without disclosing credentials",
  async (field) => {
    const { lease } = await developmentSshAuthority(instance);
    const changes: Record<string, unknown> = {
      pid: 456,
      port: 43211,
      instanceId: randomUUID(),
      startedAt: "2026-09-17T00:00:01Z",
      productVersion: "other",
      bindHostname: "localhost",
    };
    mock.execute.mockResolvedValue({
      stdout: JSON.stringify({ version: 1, daemon: { ...daemon, [field]: changes[field] } }),
      stderr: daemon.authToken,
    });
    await expect(developmentSshHandshake(instance, lease)).rejects.toThrow(
      "no matching verified ready owner",
    );
  },
);
it("rejects stale configured lease before child execution and sanitizes child failures", async () => {
  const { lease } = await developmentSshAuthority(instance);
  await expect(
    developmentSshHandshake(instance, { ...lease, generation: "old" }),
  ).rejects.toThrow();
  expect(mock.execute).not.toHaveBeenCalled();
  mock.execute.mockRejectedValue(new Error(daemon.authToken));
  const error = await developmentSshHandshake(instance, lease).catch((error) => error);
  expect(String(error)).not.toContain(daemon.authToken);
});
it("rechecks suspension after child response before returning credentials", async () => {
  const { lease } = await developmentSshAuthority(instance);
  mock.execute.mockImplementation(async () => {
    mock.barrier.mockImplementation(() => {
      throw new Error("suspended");
    });
    return { stdout: JSON.stringify({ version: 1, daemon }), stderr: "" };
  });
  await expect(developmentSshHandshake(instance, lease)).rejects.toThrow(
    "no matching verified ready owner",
  );
});

it("rejects replacement after an old matching handshake response", async () => {
  const { lease } = await developmentSshAuthority(instance);
  mock.execute.mockImplementation(async () => {
    mock.canonical.mockReturnValue({
      status: "valid",
      info: { ...daemon, instanceId: randomUUID() },
    });
    return { stdout: JSON.stringify({ version: 1, daemon }), stderr: "" };
  });
  await expect(developmentSshHandshake(instance, lease)).rejects.toThrow(
    "no matching verified ready owner",
  );
});
