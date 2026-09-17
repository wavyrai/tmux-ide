import { afterEach, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resetDevelopmentContainer } from "../lib/development-container-reset.ts";
import {
  developmentContainerClient,
  developmentContainer,
  type ContainerRunner,
} from "../lib/development-container.ts";
import {
  resolveDevelopmentComposeProject,
  withDevelopmentComposeProject,
  type DevelopmentComposeRecord,
} from "../lib/development-compose.ts";
import { withDevelopmentLock } from "../lib/development-lock.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function inspection(record: DevelopmentComposeRecord) {
  const containerId = "c".repeat(64),
    networkId = "d".repeat(64);
  const networkName = `${record.project}_default`;
  const labels = (role: string, key: string, value: string) => ({
    "io.tmux-ide.development.owner": record.nonce,
    "io.tmux-ide.development.source": record.sourceDigest,
    "io.tmux-ide.development.role": role,
    "com.docker.compose.project": record.project,
    [`com.docker.compose.${key}`]: value,
  });
  const volumes = ["workspace", "state", "runtime"].map((role) => ({
    Name: `${record.project}_${role}`,
    CreatedAt: "2026-09-17T00:00:00Z",
    Driver: "local",
    Scope: "local",
    Options: null,
    Mountpoint: `/var/lib/docker/volumes/${record.project}_${role}/_data`,
    Labels: labels(role, "volume", role),
  }));
  return {
    container: {
      Name: `/${record.project}-fixture-1`,
      State: { Running: true, Status: "running", Pid: 123 },
      Id: containerId,
      Image: record.imageId,
      Config: { User: "1000:1000", Labels: labels("fixture", "service", "fixture") },
      HostConfig: {
        Privileged: false,
        NetworkMode: networkName,
        CapDrop: ["ALL"],
        CapAdd: null,
        SecurityOpt: ["no-new-privileges:true"],
        Binds: null,
        Devices: [],
        PidMode: "",
        IpcMode: "private",
        PortBindings: { "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
      },
      NetworkSettings: {
        Networks: { [networkName]: { NetworkID: networkId } },
        Ports: { "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
      },
      Mounts: volumes.map((volume, i) => ({
        Name: volume.Name,
        Type: "volume",
        Driver: "local",
        Source: volume.Mountpoint,
        Destination: ["/workspace", "/state", "/tmp/ti-dev-1000"][i],
        RW: true,
      })),
    },
    network: {
      Id: networkId,
      Name: networkName,
      Driver: "bridge",
      Internal: false,
      Labels: labels("network", "network", "default"),
      Containers: { [containerId]: {} },
    },
    volumes,
  };
}
async function fixture(preparedOnly = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "container-reset-")));
  roots.push(root);
  const tree = join(root, "tree");
  mkdirSync(tree);
  execFileSync("git", ["init", "-q", tree]);
  const project = resolveDevelopmentComposeProject({
    worktree: tree,
    name: "reset",
    store: join(root, "store"),
  });
  const record = await withDevelopmentComposeProject(project, async (control) => {
    const r = control.prepare({
      imageId: `sha256:${"a".repeat(64)}`,
      sourceDigest: "b".repeat(64),
    });
    if (!preparedOnly) control.adopt(inspection(r));
    return control.read()!;
  });
  const raw = inspection(record),
    calls: string[][] = [];
  let container = !preparedOnly,
    network = !preparedOnly;
  const volumes = new Set(preparedOnly ? [] : raw.volumes.map((v) => v.Name));
  let foreign = false,
    fail = "";
  writeFileSync(join(project.controlRoot, "lifecycle.json"), '{"phase":"preparing"}', {
    mode: 0o600,
  });
  writeFileSync(join(project.controlRoot, "client_ed25519"), "private synthetic fixture", {
    mode: 0o600,
  });
  const runner: ContainerRunner = {
    async run(args) {
      calls.push(args);
      if (fail && args.join(" ") === fail) throw Error("private failure");
      if (args[0] === "ps") {
        if (args.some((a) => a.startsWith("volume=")))
          return foreign ? "f".repeat(64) : container ? raw.container.Id : "";
        if (args.includes("--filter")) return container ? raw.container.Id : "";
        return container
          ? args.at(-1)?.includes("|")
            ? raw.container.Id + "|" + raw.container.Name.slice(1)
            : raw.container.Name.slice(1)
          : "";
      }
      if (args[0] === "network" && args[1] === "ls")
        return network
          ? args.includes("--filter")
            ? raw.network.Id
            : args.at(-1)?.includes("|")
              ? raw.network.Id + "|" + raw.network.Name
              : raw.network.Name
          : "";
      if (args[0] === "volume" && args[1] === "ls") return [...volumes].join("\n");
      if (args[0] === "inspect") {
        expect(args[1]).toBe(raw.container.Id);
        return JSON.stringify([raw.container]);
      }
      if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([raw.network]);
      if (args[0] === "volume" && args[1] === "inspect")
        return JSON.stringify(raw.volumes.filter((v) => args.includes(v.Name)));
      if (args[0] === "stop") {
        raw.container.State = { Running: false, Status: "exited", Pid: 0 };
        raw.network.Containers = {};
        return "";
      }
      if (args[0] === "rm") {
        expect(raw.container.State.Pid).toBe(0);
        container = false;
        return "";
      }
      if (args[0] === "network" && args[1] === "rm") {
        expect(container).toBe(false);
        network = false;
        return "";
      }
      if (args[0] === "volume" && args[1] === "rm") {
        volumes.delete(args[2]!);
        return "";
      }
      throw Error("Unexpected fixture command");
    },
  };
  return {
    project,
    raw,
    runner,
    calls,
    volumes,
    setForeign: () => {
      foreign = true;
    },
    fail: (s: string) => {
      fail = s;
    },
    state: () => ({ container, network }),
  };
}
it("requires --yes before any Docker call", async () => {
  const f = await fixture();
  await expect(resetDevelopmentContainer(f.project, {}, f.runner)).rejects.toMatchObject({
    reason: "confirmation-required",
  });
  expect(f.calls).toEqual([]);
});
it("resets fully owned failed initialization without requiring core suspension; keeps lock scaffold/source/image", async () => {
  const f = await fixture();
  const result = await resetDevelopmentContainer(f.project, { yes: true }, f.runner);
  expect(result.state).toBe("reset");
  expect(f.state()).toEqual({ container: false, network: false });
  expect(f.volumes.size).toBe(0);
  expect(existsSync(f.project.instance.worktree)).toBe(true);
  expect(existsSync(join(f.project.controlRoot, "locks"))).toBe(true);
  expect(existsSync(join(f.project.controlRoot, "reset.json"))).toBe(true);
  expect(existsSync(join(f.project.controlRoot, "client_ed25519"))).toBe(false);
  expect(
    f.calls.some((a) => a.includes("suspend") || a.includes("prune") || a[0] === "image"),
  ).toBe(false);
});
it("foreign volume use refuses before container stop/removal or native retirement", async () => {
  const f = await fixture();
  f.setForeign();
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.calls.some((a) => ["stop", "rm"].includes(a[0]!))).toBe(false);
  expect(existsSync(join(f.project.controlRoot, "client_ed25519"))).toBe(true);
});
it("native unknown root is protected after intent and blocks all ordinary project admission", async () => {
  const f = await fixture(),
    client = developmentContainerClient(f.project);
  mkdirSync(client.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(client.root, "apps-unknown"), "x", { mode: 0o600 });
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toMatchObject(
    { reason: "owner-unverified" },
  );
  expect(f.state().container).toBe(true);
  await expect(withDevelopmentComposeProject(f.project, async () => true)).rejects.toThrow(
    "reset is incomplete",
  );
});
it("partial deletion retry skips only absent originals and preserves intent/keys until complete", async () => {
  const f = await fixture();
  f.fail("network rm " + f.raw.network.Id);
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.state()).toEqual({ container: false, network: true });
  expect(existsSync(join(f.project.controlRoot, "reset-intent.json"))).toBe(true);
  expect(existsSync(join(f.project.controlRoot, "client_ed25519"))).toBe(true);
  f.fail("");
  await expect(
    resetDevelopmentContainer(f.project, { yes: true }, f.runner),
  ).resolves.toMatchObject({ state: "reset" });
  expect(f.calls.filter((a) => a[0] === "rm")).toHaveLength(1);
});
it("changed remaining network or volume witness refuses partial reset", async () => {
  const f = await fixture();
  f.fail("network rm " + f.raw.network.Id);
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  f.fail("");
  f.raw.volumes[0]!.CreatedAt = "2026-09-18T00:00:00Z";
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.state().network).toBe(true);
});
it("replacement reserved network ID is never deleted", async () => {
  const f = await fixture();
  f.fail("network rm " + f.raw.network.Id);
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  f.fail("");
  f.raw.network.Id = "e".repeat(64);
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.state().network).toBe(true);
});
it("unknown host entries and changed known keys are not deleted", async () => {
  const f = await fixture();
  writeFileSync(join(f.project.controlRoot, "unknown"), "keep", { mode: 0o600 });
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.state().container).toBe(true);
});
it("prepared-only empty state and repeated reset are deliberate safe cases", async () => {
  const f = await fixture(true);
  await expect(
    resetDevelopmentContainer(f.project, { yes: true }, f.runner),
  ).resolves.toMatchObject({ state: "reset" });
  await expect(
    resetDevelopmentContainer(f.project, { yes: true }, f.runner),
  ).resolves.toMatchObject({ state: "reset" });
  expect(f.calls.some((a) => a[0] === "rm")).toBe(false);
});
it("holds native lifecycle lock through Docker removal then releases it", async () => {
  const f = await fixture(),
    client = developmentContainerClient(f.project);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const runner = {
    run: async (args: string[]) => {
      if (args[0] === "rm") {
        entered();
        await hold;
      }
      return f.runner.run(args);
    },
  };
  const reset = resetDevelopmentContainer(f.project, { yes: true }, runner);
  await inside;
  let admitted = false;
  const direct = withDevelopmentLock(client, "lifecycle", async () => {
    admitted = true;
  });
  await new Promise((r) => setTimeout(r, 40));
  expect(admitted).toBe(false);
  release();
  await reset;
  await direct;
  expect(admitted).toBe(true);
});
it("changed known host key after partial deletion remains protected", async () => {
  const f = await fixture();
  f.fail("network rm " + f.raw.network.Id);
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  f.fail("");
  writeFileSync(join(f.project.controlRoot, "client_ed25519"), "changed private fixture", {
    mode: 0o600,
  });
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.state().network).toBe(true);
  expect(existsSync(join(f.project.controlRoot, "client_ed25519"))).toBe(true);
});
it("malformed reset intent never means absent admission", async () => {
  const f = await fixture();
  writeFileSync(join(f.project.controlRoot, "reset-intent.json"), "null", { mode: 0o600 });
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  await expect(withDevelopmentComposeProject(f.project, async () => true)).rejects.toThrow(
    "reset is incomplete",
  );
  expect(f.calls).toEqual([]);
});

it("unadopted partial creation remains protected rather than guessing ownership", async () => {
  const f = await fixture();
  const path = join(f.project.controlRoot, "project.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.resources = null;
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.calls.some((a) => a[0] === "stop" || a[0] === "rm")).toBe(false);
});
it("prepared-only saved intent still validates the complete ownership record", async () => {
  const f = await fixture(true),
    client = developmentContainerClient(f.project);
  mkdirSync(client.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(client.root, "unknown"), "keep", { mode: 0o600 });
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  const path = join(f.project.controlRoot, "reset-intent.json"),
    intent = JSON.parse(readFileSync(path, "utf8"));
  intent.record = { resources: null };
  writeFileSync(path, JSON.stringify(intent), { mode: 0o600 });
  const before = f.calls.length;
  await expect(resetDevelopmentContainer(f.project, { yes: true }, f.runner)).rejects.toThrow();
  expect(f.calls.length).toBe(before);
});

it("ordinary status preserves actionable reset-pending error through its public boundary", async () => {
  const f = await fixture();
  writeFileSync(join(f.project.controlRoot, "reset-intent.json"), "null", { mode: 0o600 });
  await expect(developmentContainer(f.project, "status", {}, f.runner)).rejects.toThrow(
    "reset is incomplete",
  );
  expect(f.calls).toEqual([]);
});
