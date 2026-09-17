import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parse } from "js-yaml";
import {
  developmentComposeVolumesHash,
  readDevelopmentComposeRecord,
  renderDevelopmentComposeConfig,
  resolveDevelopmentComposeProject,
  verifyDevelopmentComposeResources,
  withDevelopmentComposeProject,
  type DevelopmentComposeRecord,
} from "../lib/development-compose.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "compose-test-")));
  roots.push(root);
  const worktree = join(root, "worktree with spaces");
  mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const project = resolveDevelopmentComposeProject({
    worktree,
    store: join(root, "store"),
    name: "test",
  });
  return { root, worktree, project };
}
const pins = { imageId: `sha256:${"a".repeat(64)}`, sourceDigest: "b".repeat(64) };
async function prepared() {
  const value = fixture();
  const record = await withDevelopmentComposeProject(value.project, async (control) =>
    control.prepare(pins),
  );
  return { ...value, record };
}
function inspect(record: DevelopmentComposeRecord) {
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
      State: { Running: true, Status: "running" },
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
describe("private Compose ownership planning", () => {
  it("canonicalizes aliases and keeps branch/paths out of resource names", () => {
    const { root, worktree, project } = fixture();
    const alias = join(root, "alias");
    symlinkSync(worktree, alias);
    expect(
      resolveDevelopmentComposeProject({
        worktree: alias,
        store: project.instance.store,
        name: "test",
      }),
    ).toEqual(project);
    expect(project.controlRoot).not.toContain("/instances/");
    expect(project.name).toMatch(/^ti-dev-[a-f0-9]{24}$/);
  });
  it("saves one unpredictable adoption nonce under concurrent project admission", async () => {
    const { project } = fixture();
    const values = await Promise.all(
      Array.from({ length: 4 }, () =>
        withDevelopmentComposeProject(project, async (c) => c.prepare(pins)),
      ),
    );
    expect(new Set(values.map((value) => value.nonce)).size).toBe(1);
    await expect(
      withDevelopmentComposeProject(project, async (c) =>
        c.prepare({ ...pins, sourceDigest: "e".repeat(64) }),
      ),
    ).rejects.toThrow("ownership");
  });
  it("never accepts caller-selected ownership nonce or missing running network membership", async () => {
    const { project } = fixture();
    const supplied = { ...pins, nonce: "00000000-0000-4000-8000-000000000000" };
    const record = await withDevelopmentComposeProject(project, async (c) => c.prepare(supplied));
    expect(record.nonce).not.toBe(supplied.nonce);
    const raw = inspect(record);
    raw.network.Containers = {};
    expect(() => verifyDevelopmentComposeResources(project, record, raw)).toThrow();
  });
  it("rejects malformed on-disk records without replacing them", async () => {
    const { project } = await prepared();
    for (const value of ["null", "false", "{}", "[]"]) {
      writeFileSync(join(project.controlRoot, "project.json"), value, { mode: 0o600 });
      expect(() => readDevelopmentComposeRecord(project)).toThrow();
      await expect(
        withDevelopmentComposeProject(project, async (c) => c.prepare(pins)),
      ).rejects.toThrow();
      expect(readFileSync(join(project.controlRoot, "project.json"), "utf8")).toBe(value);
    }
  });
  it("refuses a competing store's same-project resource nonce and symlinked private control", async () => {
    const { project, record, root, worktree } = await prepared();
    const other = resolveDevelopmentComposeProject({
      worktree,
      name: "test",
      store: join(root, "other-store"),
    });
    const otherRecord = await withDevelopmentComposeProject(other, async (c) => c.prepare(pins));
    expect(other.name).toBe(project.name);
    expect(() => verifyDevelopmentComposeResources(other, otherRecord, inspect(record))).toThrow();
    const saved = join(project.controlRoot, "project.json");
    const target = join(root, "preserved-record");
    writeFileSync(target, readFileSync(saved), { mode: 0o600 });
    rmSync(saved);
    symlinkSync(target, saved);
    expect(() => readDevelopmentComposeRecord(project)).toThrow();
    expect(JSON.parse(readFileSync(target, "utf8")).nonce).toBe(record.nonce);
  });
  it("renders the reviewed template with omitted dynamic port and project-scoped resources", async () => {
    const { project, record } = await prepared();
    const variables: Record<string, string> = {
      TI_PROJECT: project.name,
      TI_IMAGE_ID: record.imageId,
      TI_OWNER: record.nonce,
      TI_SOURCE_DIGEST: record.sourceDigest,
    };
    const template = readFileSync(
      new URL("../../../../docker/development/compose.yml", import.meta.url),
      "utf8",
    );
    const resolved = parse(
      template.replace(/\$\{([A-Z_]+):\?[^}]+\}/g, (_, key: string) => variables[key]!),
    );
    expect(renderDevelopmentComposeConfig(project, record)).toEqual(resolved);
    expect(
      renderDevelopmentComposeConfig(project, record).services.fixture.ports[0],
    ).not.toHaveProperty("published");
  });
  it("adopts exact resources once; rejects recreated resources but permits a new dynamic port", async () => {
    const { project, record } = await prepared();
    const raw = inspect(record);
    const adopted = await withDevelopmentComposeProject(project, async (c) => c.adopt(raw));
    expect(developmentComposeVolumesHash(adopted)).toMatch(/^[a-f0-9]{64}$/);
    const saved = readDevelopmentComposeRecord(project)!;
    for (const change of [
      (v: typeof raw) => {
        v.container.Id = "e".repeat(64);
      },
      (v: typeof raw) => {
        v.network.Id = "e".repeat(64);
      },
      (v: typeof raw) => {
        v.volumes[0]!.CreatedAt = "2026-09-18T00:00:00Z";
      },
    ]) {
      const changed = structuredClone(raw);
      change(changed);
      expect(() => verifyDevelopmentComposeResources(project, saved, changed)).toThrow();
    }
    raw.container.NetworkSettings.Ports["2222/tcp"][0]!.HostPort = "49153";
    expect(verifyDevelopmentComposeResources(project, saved, raw).port).toBe(49153);
  });
  it("verifies stopped identity without a live port and updates only the observed endpoint", async () => {
    const { project, record } = await prepared();
    const raw = inspect(record);
    await withDevelopmentComposeProject(project, async (c) => c.adopt(raw));
    raw.container.State = { Running: false, Status: "exited" };
    raw.container.NetworkSettings.Ports = {} as typeof raw.container.NetworkSettings.Ports;
    raw.container.NetworkSettings.Networks[`${project.name}_default`]!.NetworkID = "";
    raw.network.Containers = {};
    const stopped = await withDevelopmentComposeProject(project, async (c) => c.adopt(raw));
    expect(stopped.port).toBeNull();
    const restarted = inspect(record);
    restarted.container.NetworkSettings.Ports["2222/tcp"][0]!.HostPort = "51000";
    expect(
      (await withDevelopmentComposeProject(project, async (c) => c.adopt(restarted))).port,
    ).toBe(51000);
    expect(readDevelopmentComposeRecord(project)!.resources!.containerId).toBe(raw.container.Id);
  });
  it("does not allow retained control callbacks to write after lock release", async () => {
    const { project } = fixture();
    const control = await withDevelopmentComposeProject(project, async (c) => c);
    expect(() => control.prepare(pins)).toThrow();
    expect(readDevelopmentComposeRecord(project)).toBeNull();
  });
  it("refuses foreign capability, image, mounts, networks, privileges and nonloopback/extra ports", async () => {
    const { project, record } = await prepared();
    const changes: Array<(value: ReturnType<typeof inspect>) => void> = [
      (v) => {
        v.container.Config.Labels["io.tmux-ide.development.owner"] = "foreign";
      },
      (v) => {
        v.container.Image = "sha256:" + "e".repeat(64);
      },
      (v) => {
        v.container.HostConfig.Privileged = true;
      },
      (v) => {
        v.container.HostConfig.NetworkMode = "host";
      },
      (v) => {
        v.container.Mounts[0]!.Type = "bind";
      },
      (v) => {
        v.container.Mounts[0]!.Destination = "/var/run/docker.sock";
      },
      (v) => {
        v.container.Mounts[0]!.RW = false;
      },
      (v) => {
        v.container.NetworkSettings.Networks.foreign = { NetworkID: "e".repeat(64) };
      },
      (v) => {
        v.network.Containers["e".repeat(64)] = {};
      },
      (v) => {
        v.container.NetworkSettings.Ports["2222/tcp"][0]!.HostIp = "0.0.0.0";
      },
      (v) => {
        Object.assign(v.container.NetworkSettings.Ports, { "80/tcp": [] });
      },
      (v) => {
        v.volumes[0]!.Labels["com.docker.compose.project"] = "other";
      },
      (v) => {
        v.volumes.pop();
      },
    ];
    for (const change of changes) {
      const value = inspect(record);
      change(value);
      expect(() => verifyDevelopmentComposeResources(project, record, value)).toThrow("ownership");
    }
  });
  it("refuses missing complete inspect sections instead of treating them as empty", async () => {
    const { project, record } = await prepared();
    for (const key of ["HostConfig", "NetworkSettings", "Mounts", "Config"]) {
      const value = inspect(record);
      delete (value.container as Record<string, unknown>)[key];
      expect(() => verifyDevelopmentComposeResources(project, record, value)).toThrow();
    }
    const other = fixture().project;
    expect(() => verifyDevelopmentComposeResources(other, record, inspect(record))).toThrow();
  });
});

it("accepts actual Compose named-volume Binds/null Devices while refusing host binds and alternate modes", async () => {
  const { project, record } = await prepared();
  const raw = inspect(record);
  const host = raw.container.HostConfig as unknown as Record<string, unknown>;
  const expected = [
    `${project.name}_runtime:/tmp/ti-dev-1000:rw`,
    `${project.name}_workspace:/workspace:rw`,
    `${project.name}_state:/state:rw`,
  ];
  host.Binds = expected;
  host.Devices = null;
  expect(verifyDevelopmentComposeResources(project, record, raw).port).toBe(49152);
  for (const binds of [
    ["/host/home:/workspace:rw", ...expected.slice(1)],
    [...expected, "/var/run/docker.sock:/var/run/docker.sock:rw"],
    expected.map((value) => value.replace(":rw", ":ro")),
    undefined,
  ]) {
    host.Binds = binds;
    expect(() => verifyDevelopmentComposeResources(project, record, raw)).toThrow();
  }
  host.Binds = expected;
  for (const devices of [undefined, [{ PathOnHost: "/dev/private" }]]) {
    host.Devices = devices;
    expect(() => verifyDevelopmentComposeResources(project, record, raw)).toThrow();
  }
});

it("requires the explicit ordinary project bridge and an observed running loopback port", async () => {
  const { project, record } = await prepared();
  const raw = inspect(record);
  expect(renderDevelopmentComposeConfig(project, record).networks.default.internal).toBe(false);
  raw.network.Internal = true;
  expect(() => verifyDevelopmentComposeResources(project, record, raw)).toThrow();
  raw.network.Internal = false;
  raw.container.NetworkSettings.Ports["2222/tcp"] = [];
  expect(() => verifyDevelopmentComposeResources(project, record, raw)).toThrow();
});
