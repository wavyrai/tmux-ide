import { EventEmitter } from "node:events";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  developmentContainer,
  developmentContainerRunner,
  withReadyDevelopmentContainer,
  withContainerSshChildren,
  readContainerExport,
  inspectContainerProject,
  type ContainerRunner,
} from "../lib/development-container.ts";
import {
  readDevelopmentComposeRecord,
  resolveDevelopmentComposeProject,
  withDevelopmentComposeProject,
  type DevelopmentComposeRecord,
} from "../lib/development-compose.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "container-wrapper-")));
  roots.push(root);
  const worktree = join(root, "worktree with spaces");
  mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  const project = resolveDevelopmentComposeProject({
    worktree,
    store: join(root, "store"),
    name: "wrapper",
  });
  return { root, worktree, project };
}
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
async function prepared(phase = "ready") {
  const value = fixture();
  const { project } = value;
  const record = await withDevelopmentComposeProject(project, async (c) => {
    const r = c.prepare({ imageId: `sha256:${"a".repeat(64)}`, sourceDigest: "b".repeat(64) });
    c.adopt(inspection(r));
    return c.read()!;
  });
  const raw = inspection(record);
  const calls: string[][] = [];
  let failAt: string | undefined,
    extra = false;
  const lease = {
    generation: "build-11111111-1111-4111-8111-111111111111",
    daemonId: "daemon",
    pid: 23,
    port: 2223,
  };
  const stopProof = '{"private":"not-public"}';
  const journal = {
    version: 1,
    phase,
    sourceHash: "e".repeat(64),
    generation: lease.generation,
    hostKey: "ssh-ed25519 AAAA\n",
    stopHash: hash(stopProof),
    leaseHash: hash(JSON.stringify(lease)),
  };
  const file = join(project.controlRoot, "lifecycle.json");
  writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
  writeFileSync(join(project.controlRoot, "client_ed25519"), "private synthetic key", {
    mode: 0o600,
  });
  writeFileSync(join(project.controlRoot, "client_ed25519.pub"), "ssh-ed25519 AAAA\n", {
    mode: 0o600,
  });
  const stop = () => {
    raw.container.State = { Running: false, Status: "exited", Pid: 0 };
  };
  const runner: ContainerRunner = {
    verifySsh: async () => {},
    async run(args, options) {
      options?.signal?.throwIfAborted();
      calls.push(args);
      if (failAt && args.includes(failAt)) throw Error("SECRET_TOKEN arbitrary failure");
      if (args[0] === "ps")
        return args.includes("--filter")
          ? raw.container.Id + "\n"
          : raw.container.Name.slice(1) + "\n";
      if (args[0] === "network" && args[1] === "ls")
        return args.includes("--filter")
          ? raw.network.Id + "\n" + (extra ? "f".repeat(64) + "\n" : "")
          : raw.network.Name + "\n";
      if (args[0] === "volume" && args[1] === "ls")
        return raw.volumes.map((v) => v.Name).join("\n");
      if (args[0] === "inspect") return JSON.stringify([raw.container]);
      if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([raw.network]);
      if (args[0] === "volume" && args[1] === "inspect") return JSON.stringify(raw.volumes);
      if (args[0] === "stop") {
        stop();
        return raw.container.Id;
      }
      if (args[0] === "start") {
        raw.container.State = { Running: true, Status: "running", Pid: 321 };
        raw.container.NetworkSettings.Ports["2222/tcp"][0]!.HostPort = "54321";
        return raw.container.Id;
      }
      if (args.includes("/state/container-stop.json")) return stopProof;
      if (args.includes("/opt/fixture/container-lifecycle.mjs")) {
        if (args.includes("suspend"))
          return JSON.stringify({ state: "suspended", receiptHash: hash(stopProof) });
        if (args.includes("resume"))
          return JSON.stringify({ state: "resumed", receiptHash: hash(stopProof) });
        return JSON.stringify({ state: "ready", lease });
      }
      if (args.includes("/state/ssh/lease.json")) return JSON.stringify(lease);
      if (args.includes("/opt/fixture/ssh-fixture.mjs")) {
        if (args.includes("stop")) return JSON.stringify({ scope: "ssh-listener", stopped: true });
        if (args.includes("init")) return journal.hostKey;
        return "";
      }
      if (args.includes("/workspace/tree/scripts/development-instance.mjs"))
        return JSON.stringify({ state: "ready", activeBuild: { generation: lease.generation } });
      if (args.includes("-e")) return "";
      throw Error("Unexpected test command");
    },
  };
  return {
    ...value,
    record,
    raw,
    runner,
    calls,
    journal,
    file,
    stop,
    fail: (word: string) => {
      failAt = word;
    },
    extra: () => {
      extra = true;
    },
  };
}
describe("explicit container lifecycle", () => {
  it("keeps fresh status/logs read-only and never invokes Docker or native startup", async () => {
    const { project } = fixture();
    const runner = {
      run: async () => {
        throw Error("must not invoke");
      },
    };
    expect(await developmentContainer(project, "status", {}, runner)).toMatchObject({
      state: "absent",
    });
    await developmentContainer(project, "logs", {}, runner);
    expect(existsSync(project.controlRoot)).toBe(false);
  });
  it("binds bounded export to canonical selected worktree and rejects malformed/foreign manifests", () => {
    const { root, worktree } = fixture();
    const source = join(root, "export");
    mkdirSync(source);
    const path = join(source, ".development-container-source.json");
    const valid = { version: 1, sourceWorktree: worktree, files: [], snapshotDigest: hash("[]") };
    writeFileSync(path, JSON.stringify(valid));
    expect(readContainerExport(source, worktree).manifest.snapshotDigest).toBe(
      valid.snapshotDigest,
    );
    for (const v of [
      null,
      { ...valid, sourceWorktree: "/other" },
      { ...valid, snapshotDigest: "f".repeat(64) },
    ]) {
      writeFileSync(path, JSON.stringify(v));
      expect(() => readContainerExport(source, worktree)).toThrow();
    }
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(() => readContainerExport(source, worktree)).toThrow();
  });
  it("refuses extra project resources before any mutation", async () => {
    const f = await prepared();
    f.extra();
    await expect(developmentContainer(f.project, "down", {}, f.runner)).rejects.toThrow();
    expect(f.calls.some((a) => a[0] === "exec" || a[0] === "stop")).toBe(false);
  });
  it("reports observed stopped state separately from retained ready phase without probing SSH", async () => {
    const f = await prepared();
    f.stop();
    expect(await developmentContainer(f.project, "status", {}, f.runner)).toMatchObject({
      phase: "ready",
      state: "exited",
      sshReadiness: "not-probed",
    });
    expect(f.calls.some((a) => a[0] === "exec")).toBe(false);
  });
  it("ordinary up preserves complete suspension; explicit resume refreshes endpoint and authenticates", async () => {
    const f = await prepared("stopped");
    f.stop();
    await expect(developmentContainer(f.project, "up", {}, f.runner)).rejects.toMatchObject({
      reason: "instance-suspended",
    });
    expect(f.calls.some((a) => a[0] === "start")).toBe(false);
    let verified = 0;
    f.runner.verifySsh = async () => {
      verified++;
    };
    const result = await developmentContainer(f.project, "up", { resume: true }, f.runner);
    expect(result).toMatchObject({ phase: "ready", resources: { port: 54321 } });
    expect(verified).toBe(1);
    expect(f.calls.findIndex((a) => a.includes("resume"))).toBeGreaterThan(
      f.calls.findIndex((a) => a[0] === "start"),
    );
  });
  it("never retries interrupted initialization or resuming by assuming absent owner means safe", async () => {
    for (const phase of ["creating", "preparing", "building", "starting", "resuming"]) {
      const f = await prepared(phase);
      await expect(developmentContainer(f.project, "up", {}, f.runner)).rejects.toThrow();
      expect(f.calls.some((a) => a[0] === "exec")).toBe(false);
      expect(JSON.parse(readFileSync(f.file, "utf8")).phase).toBe(phase);
    }
  });
  it("records listener failure and never suspends/stops after it, without raw error disclosure", async () => {
    const f = await prepared();
    f.fail("stop");
    await expect(developmentContainer(f.project, "down", {}, f.runner)).rejects.toThrow(
      "Container transition unavailable",
    );
    expect(JSON.parse(readFileSync(f.file, "utf8")).phase).toBe("stopping-listener");
    expect(f.calls.some((a) => a.includes("suspend") || a[0] === "stop")).toBe(false);
  });
  it("orders listener retirement, durable suspension, then exact Docker stop", async () => {
    const f = await prepared();
    const result = await developmentContainer(f.project, "down", {}, f.runner);
    expect(result).toMatchObject({ phase: "stopped", state: "exited" });
    const stop = f.calls.findIndex((a) => a[0] === "stop");
    expect(stop).toBeGreaterThan(f.calls.findIndex((a) => a.includes("suspend")));
    expect(f.calls[stop]!.at(-1)).toBe(f.record.resources!.containerId);
    expect(JSON.stringify(result)).not.toContain("not-public");
  });
  it("finalizes only proof-backed completed stop, and rejects replacement before action", async () => {
    const f = await prepared("stopping-container");
    f.stop();
    expect(await developmentContainer(f.project, "down", {}, f.runner)).toMatchObject({
      phase: "stopped",
    });
    expect(f.calls.some((a) => a[0] === "stop")).toBe(false);
    const g = await prepared("stopping-container");
    g.raw.container.Id = "f".repeat(64);
    await expect(developmentContainer(g.project, "down", {}, g.runner)).rejects.toThrow();
    expect(g.calls.some((a) => a[0] === "stop")).toBe(false);
  });
  it("propagates cancellation through every inventory call and stops before later reads", async () => {
    const f = await prepared();
    const ac = new AbortController();
    const original = f.runner.run;
    f.runner.run = async (args, options) => {
      expect(options?.signal).toBe(ac.signal);
      const result = await original(args, options);
      ac.abort();
      return result;
    };
    await expect(
      inspectContainerProject(f.project, f.record, f.runner, ac.signal),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it("refuses healthy journal when active lease changed and requires actual SSH probe", async () => {
    const f = await prepared();
    f.runner.verifySsh = async () => {
      throw Error("SECRET handshake");
    };
    await expect(developmentContainer(f.project, "up", {}, f.runner)).rejects.toThrow(
      "Container transition unavailable",
    );
    expect(JSON.parse(readFileSync(f.file, "utf8")).phase).toBe("ready");
  });
});

describe("first creation source binding", () => {
  it("preserves the failed image/source phase and never prepares a mismatched image", async () => {
    const f = fixture();
    const source = join(f.root, "export");
    mkdirSync(source);
    const manifest = JSON.stringify({
      version: 1,
      sourceWorktree: f.worktree,
      files: [],
      snapshotDigest: hash("[]"),
    });
    writeFileSync(join(source, ".development-container-source.json"), manifest);
    const calls: string[][] = [];
    let raw: ReturnType<typeof inspection> | null = null;
    const runner: ContainerRunner = {
      async run(args) {
        calls.push(args);
        if (args[0] === "image") return JSON.stringify([{ Id: `sha256:${"a".repeat(64)}` }]);
        if (args[0] === "compose") {
          raw = inspection(readDevelopmentComposeRecord(f.project)!);
          return "";
        }
        if (args[0] === "ps")
          return raw
            ? args.includes("--filter")
              ? raw.container.Id
              : raw.container.Name.slice(1)
            : "";
        if (args[0] === "network" && args[1] === "ls")
          return raw ? (args.includes("--filter") ? raw.network.Id : raw.network.Name) : "";
        if (args[0] === "volume" && args[1] === "ls")
          return raw ? raw.volumes.map((v) => v.Name).join("\n") : "";
        if (args[0] === "inspect") return JSON.stringify([raw!.container]);
        if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([raw!.network]);
        if (args[0] === "volume" && args[1] === "inspect") return JSON.stringify(raw!.volumes);
        if (args.includes("/opt/source-snapshot/.development-container-source.json"))
          return "wrong image snapshot";
        throw Error("unexpected");
      },
    };
    await expect(
      developmentContainer(f.project, "up", { image: `sha256:${"a".repeat(64)}`, source }, runner),
    ).rejects.toThrow();
    expect(
      JSON.parse(readFileSync(join(f.project.controlRoot, "lifecycle.json"), "utf8")).phase,
    ).toBe("verifying-image");
    expect(calls.some((a) => a.some((v) => v.includes("prepare-source")))).toBe(false);
    expect(readDevelopmentComposeRecord(f.project)?.resources?.containerId).toBe(raw!.container.Id);
  });
  it("refuses changed Docker-channel host key after resume without launching listener", async () => {
    const f = await prepared("stopped");
    f.stop();
    const run = f.runner.run;
    f.runner.run = async (a, o) => (a.includes("init") ? "ssh-ed25519 BBBB\n" : run(a, o));
    await expect(
      developmentContainer(f.project, "up", { resume: true }, f.runner),
    ).rejects.toThrow();
    expect(f.calls.some((a) => a.includes("serve"))).toBe(false);
    expect(JSON.parse(readFileSync(f.file, "utf8")).phase).toBe("starting");
  });
});

it("Docker maxBuffer failure cannot become success when terminated child exits zero", async () => {
  const f = fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const script = join(bin, "docker");
  writeFileSync(
    script,
    `#!${process.execPath}\nprocess.on('SIGTERM',()=>process.exit(0));process.stderr.write('x'.repeat(9*1024*1024));setInterval(()=>{},1000);`,
  );
  chmodSync(script, 0o700);
  const old = process.env.PATH;
  process.env.PATH = bin;
  try {
    await expect(developmentContainerRunner.run(["version"], { timeoutMs: 3000 })).rejects.toThrow(
      "Container transition unavailable",
    );
  } finally {
    process.env.PATH = old;
  }
});

it("awaits retained SSH close even when opening fails before a transport handle exists", async () => {
  let closed = false;
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: null,
    stderr: null,
    kill(signal?: number | NodeJS.Signals) {
      expect(signal).toBe("SIGTERM");
      setTimeout(() => {
        closed = true;
        child.signalCode = "SIGTERM";
        child.emit("close", null, "SIGTERM");
      }, 10);
      return true;
    },
  });
  await expect(
    withContainerSshChildren(async (retain) => {
      retain(child);
      throw Error("admission failed");
    }),
  ).rejects.toThrow("admission failed");
  expect(closed).toBe(true);
});

it("ready-only app admission refuses stopped resources without any start or resume", async () => {
  const f = await prepared("stopped");
  f.stop();
  let admitted = false;
  await expect(
    withReadyDevelopmentContainer(
      f.project,
      async () => {
        admitted = true;
      },
      undefined,
      f.runner,
    ),
  ).rejects.toMatchObject({ reason: "instance-suspended" });
  expect(admitted).toBe(false);
  expect(f.calls.some((a) => a[0] === "start" || a.includes("resume"))).toBe(false);
});
it("project lock covers app admission but not interactive completion", async () => {
  const f = await prepared();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  let appExited!: () => void;
  const completion = new Promise<void>((r) => (appExited = r));
  const launch = withReadyDevelopmentContainer(
    f.project,
    async (remote) => {
      expect(remote.alias).toBe(f.project.name);
      entered();
      await hold;
      return { completion };
    },
    undefined,
    f.runner,
  );
  await inside;
  const down = developmentContainer(f.project, "down", {}, f.runner);
  expect(f.calls.some((a) => a.includes("suspend"))).toBe(false);
  release();
  const admitted = await launch;
  expect(admitted.completion).toBe(completion);
  expect(await down).toMatchObject({ phase: "stopped" });
  appExited();
});
it("changed authenticated remote proof prevents app callback", async () => {
  const f = await prepared();
  let called = false;
  f.runner.verifySsh = async () => {
    throw Error("host key or identity refused");
  };
  await expect(
    withReadyDevelopmentContainer(
      f.project,
      async () => {
        called = true;
      },
      undefined,
      f.runner,
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
