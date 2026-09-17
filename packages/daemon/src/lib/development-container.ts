/** Explicit host container lifecycle. Docker errors never cross this boundary verbatim. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  constants,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  DevelopmentOperationError,
  readPrivateDevelopmentFile,
  writeDevelopmentRecord,
} from "./development-state.ts";
import {
  withDevelopmentComposeProject,
  DevelopmentComposeResetPendingError,
  renderDevelopmentComposeConfig,
  verifyDevelopmentComposeResources,
  developmentComposeVolumesHash,
  type DevelopmentComposeProject,
  type DevelopmentComposeRecord,
  type DevelopmentComposeInspection,
} from "./development-compose.ts";
import { createServer } from "node:net";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  type SshTransportChild,
} from "./ssh-daemon-transport.ts";
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
/** Retain every local SSH child even when transport admission fails before returning a handle. */
export async function withContainerSshChildren<T>(
  action: (retain: (child: SshTransportChild) => SshTransportChild) => Promise<T>,
): Promise<T> {
  const owned: Array<{ child: SshTransportChild; closed: Promise<void> }> = [];
  try {
    return await action((child) => {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      owned.push({ child, closed });
      return child;
    });
  } finally {
    const wait = (closed: Promise<void>, ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        void closed.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    const results = await Promise.all(
      owned.map(async ({ child, closed }) => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (await wait(closed, 300)) return true;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        return wait(closed, 1000);
      }),
    );
    if (results.some((done) => !done)) refuse();
  }
}
const HEX = /^[a-f0-9]{64}$/u;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function privateText(path: string, text: string) {
  if (existsSync(path) && !readPrivateDevelopmentFile(path)) refuse();
  const temp = path + "." + randomUUID();
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
function refuse(): never {
  throw new DevelopmentOperationError(
    "operation-failed",
    "Container transition unavailable; inspect the private project phase and ownership records",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function parse(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value));
  } catch {
    refuse();
  }
}
export interface ContainerRunner {
  verifySsh?(config: string, lease: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
  run(
    args: string[],
    options?: { input?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<string>;
}
const execute = promisify(execFile);
export const developmentContainerRunner: ContainerRunner = {
  async run(args, options = {}) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = execFile(
          "docker",
          args,
          {
            encoding: "utf8",
            timeout: options.timeoutMs ?? 30000,
            maxBuffer: 8 * 1024 * 1024,
            signal: options.signal,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
        child.stdin?.on("error", reject);
        child.stdin?.end(options.input);
      });
    } catch {
      refuse();
    }
  },
};
const phases = [
  "creating",
  "verifying-image",
  "preparing",
  "building",
  "starting",
  "ready",
  "stopping-listener",
  "suspending",
  "suspended",
  "stopping-container",
  "stopped",
  "resuming",
] as const;
type Phase = (typeof phases)[number];
interface Journal {
  version: 1;
  phase: Phase;
  sourceHash: string;
  generation: string | null;
  hostKey: string | null;
  stopHash: string | null;
  leaseHash: string | null;
}
function readJournal(project: DevelopmentComposeProject): Journal | null {
  const file = readPrivateDevelopmentFile(join(project.controlRoot, "lifecycle.json"));
  if (!file) return null;
  const j = parse(file.bytes.toString("utf8"));
  if (
    j.version !== 1 ||
    !phases.some((phase) => phase === j.phase) ||
    !matches(j.sourceHash, HEX) ||
    !(j.generation === null || matches(j.generation, /^build-[a-f0-9-]{36}$/u)) ||
    !(j.hostKey === null || matches(j.hostKey, /^ssh-ed25519 [A-Za-z0-9+/=]+\n$/u)) ||
    !(j.stopHash === null || matches(j.stopHash, HEX)) ||
    !(j.leaseHash === null || matches(j.leaseHash, HEX))
  )
    refuse();
  return j as unknown as Journal;
}
/** Bounds and binds the host export, not a second source importer. Image preparation validates every input. */
export function readContainerExport(path: string, worktree: string) {
  const fd = openSync(
    join(realpathSync(path), ".development-container-source.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) refuse();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) refuse();
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0
    )
      refuse();
    const m = parse(bytes.toString("utf8"));
    if (
      m.version !== 1 ||
      m.sourceWorktree !== worktree ||
      !Array.isArray(m.files) ||
      m.files.length > 50000 ||
      !matches(m.snapshotDigest, HEX) ||
      hash(JSON.stringify(m.files)) !== m.snapshotDigest
    )
      refuse();
    return {
      bytes,
      manifest: { snapshotDigest: m.snapshotDigest, files: m.files.map(object) },
      sourceHash: hash(bytes),
    };
  } finally {
    closeSync(fd);
  }
}
function lines(value: string): string[] {
  return value.trim() ? value.trim().split("\n") : [];
}
/** Enumerate labels AND exact reserved names; a caller cannot hide extra project resources. */
export async function inspectContainerProject(
  project: DevelopmentComposeProject,
  record: DevelopmentComposeRecord | null,
  runner: ContainerRunner,
  signal?: AbortSignal,
): Promise<DevelopmentComposeInspection | null> {
  const original = runner;
  runner = {
    run: (args, options) => {
      signal?.throwIfAborted();
      return original.run(args, { ...options, signal });
    },
  };
  const label = `label=com.docker.compose.project=${project.name}`;
  const containers = lines(
    await runner.run(["ps", "-a", "--no-trunc", "--filter", label, "--format", "{{.ID}}"]),
  );
  const networks = lines(
    await runner.run(["network", "ls", "--no-trunc", "--filter", label, "--format", "{{.ID}}"]),
  );
  const volumes = lines(
    await runner.run(["volume", "ls", "--filter", label, "--format", "{{.Name}}"]),
  );
  const names = lines(await runner.run(["ps", "-a", "--format", "{{.Names}}"]));
  const networkNames = lines(await runner.run(["network", "ls", "--format", "{{.Name}}"]));
  const volumeNames = lines(await runner.run(["volume", "ls", "--format", "{{.Name}}"]));
  const expectedVolumes = ["workspace", "state", "runtime"].map(
    (role) => `${project.name}_${role}`,
  );
  if (!record) {
    if (
      containers.length ||
      networks.length ||
      volumes.length ||
      names.includes(`${project.name}-fixture-1`) ||
      networkNames.includes(`${project.name}_default`) ||
      expectedVolumes.some((name) => volumeNames.includes(name))
    )
      refuse();
    return null;
  }
  if (
    containers.length !== 1 ||
    networks.length !== 1 ||
    !HEX.test(containers[0]!) ||
    !HEX.test(networks[0]!) ||
    JSON.stringify([...volumes].sort()) !== JSON.stringify(expectedVolumes.sort())
  )
    refuse();
  const decode = (text: string) => {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) refuse();
    return list;
  };
  const cs = decode(await runner.run(["inspect", containers[0]!]));
  const ns = decode(await runner.run(["network", "inspect", networks[0]!]));
  if (cs.length !== 1 || ns.length !== 1) refuse();
  const inspect = {
    container: cs[0],
    network: ns[0],
    volumes: decode(await runner.run(["volume", "inspect", ...expectedVolumes])),
  };
  if (object(inspect.container).Name !== `/${project.name}-fixture-1`) refuse();
  verifyDevelopmentComposeResources(project, record, inspect);
  return inspect;
}
import { resolveDevelopmentInstance, type DevelopmentInstance } from "./development-instance.ts";
export function developmentContainerClient(
  project: DevelopmentComposeProject,
): DevelopmentInstance {
  return resolveDevelopmentInstance({
    worktree: project.instance.worktree,
    name: `container-client-${project.instance.id}`,
    store: join(project.instance.store, "container-clients", project.instance.id),
  });
}
export function developmentContainerClientInfo(project: DevelopmentComposeProject) {
  const client = developmentContainerClient(project);
  return {
    id: client.id,
    name: client.name,
    worktree: client.worktree,
    store: client.store,
    ownerLifetime: "retained-after-app-exit",
    cleanup: {
      down: ["down", "--id", client.id, "--store", client.store],
      reset: ["reset", "--yes", "--id", client.id, "--store", client.store],
    },
    note: "Close host apps before optional native cleanup; container down does not stop this owner",
  };
}
async function verifyContainerSsh(
  project: DevelopmentComposeProject,
  record: DevelopmentComposeRecord,
  journal: Journal,
  lease: Record<string, unknown>,
  runner: ContainerRunner,
  signal?: AbortSignal,
) {
  if (!journal?.hostKey || !record?.resources?.port) refuse();
  const key = join(project.controlRoot, "client_ed25519"),
    known = join(project.controlRoot, "known_hosts"),
    config = join(project.controlRoot, "ssh_config");
  if (
    [key, known].some(
      (path) =>
        [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        /[%"\\]/u.test(path),
    )
  )
    refuse();
  if (!readPrivateDevelopmentFile(key)) refuse();
  privateText(known, `[127.0.0.1]:${record.resources.port} ${journal.hostKey}`);
  privateText(
    config,
    `Host fixture ${project.name}\n HostName 127.0.0.1\n Port ${record.resources.port}\n User node\n IdentityFile "${key}"\n UserKnownHostsFile "${known}"\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n IdentitiesOnly yes\n IdentityAgent none\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n BatchMode yes\n ConnectTimeout 5\n ControlMaster no\n ControlPath none\n ForwardAgent no\n`,
  );
  if (runner.verifySsh) {
    await runner.verifySsh(config, lease, signal);
    return config;
  }
  await withContainerSshChildren(async (retain) => {
    const transport = await openSshDaemonTransport(
      { alias: "fixture", signal: signal, timeoutMs: 15000 },
      {
        spawn: (args) =>
          retain(
            spawn("/usr/bin/ssh", ["-F", config, ...args], {
              stdio: ["ignore", "pipe", "pipe"],
            }),
          ),
        probe: probeSshDaemonIdentity,
        allocatePort: () =>
          new Promise((resolve, reject) => {
            const server = createServer();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                server.close();
                reject(Error());
                return;
              }
              server.close((error) => (error ? reject(error) : resolve(address.port)));
            });
          }),
      },
    );
    try {
      if (
        transport.daemon.instanceId !== lease.daemonId ||
        transport.daemon.pid !== lease.pid ||
        transport.daemon.port !== lease.port ||
        transport.daemon.startedAt !== lease.startedAt ||
        transport.daemon.protocolVersion !== lease.protocolVersion ||
        transport.daemon.productVersion !== lease.productVersion
      )
        refuse();
    } finally {
      transport.dispose();
      await transport.closed;
    }
  });

  return config;
}

/** Admission only: never starts/resumes Docker. The callback finishes before releasing the project lock. */
export async function withReadyDevelopmentContainer<T>(
  project: DevelopmentComposeProject,
  action: (remote: {
    alias: string;
    controlRoot: string;
    configHash: string;
    containerId: string;
  }) => Promise<T>,
  signal?: AbortSignal,
  runner: ContainerRunner = developmentContainerRunner,
): Promise<T> {
  return withDevelopmentComposeProject(
    project,
    async (control) => {
      const record = control.read(),
        journal = readJournal(project);
      if (!record?.resources || journal?.phase !== "ready")
        throw new DevelopmentOperationError(
          "instance-suspended",
          "Container app requires ready container; use explicit up --container --resume after stop",
        );
      const inspect = await inspectContainerProject(project, record, runner, signal);
      if (!inspect || !object(object(inspect.container).State).Running) refuse();
      control.adopt(inspect);
      const observed = control.read()!;
      const args = [
        "exec",
        observed.resources!.containerId,
        "node",
        "--import",
        "/workspace/tree/node_modules/tsx/dist/loader.mjs",
        "/opt/fixture/container-lifecycle.mjs",
        "ready",
        project.name,
        observed.resources!.containerId,
        developmentComposeVolumesHash(observed.resources!),
      ];
      const current = async () => {
        signal?.throwIfAborted();
        const result = parse(await runner.run(args, { signal, timeoutMs: 60000 }));
        if (result.state !== "ready") refuse();
        const lease = object(result.lease);
        if (
          hash(JSON.stringify(lease)) !== journal.leaseHash ||
          lease.generation !== journal.generation
        )
          refuse();
        return lease;
      };
      const lease = await current();
      const configured = parse(
        await runner.run(
          ["exec", observed.resources!.containerId, "cat", "/state/ssh/lease.json"],
          { signal },
        ),
      );
      if (JSON.stringify(configured) !== JSON.stringify(lease)) refuse();
      const config = await verifyContainerSsh(project, observed, journal, lease, runner, signal);
      await inspectContainerProject(project, observed, runner, signal);
      await current();
      signal?.throwIfAborted();
      const bytes = readPrivateDevelopmentFile(config)?.bytes;
      if (!bytes) refuse();
      return action({
        alias: project.name,
        containerId: observed.resources!.containerId,
        controlRoot: project.controlRoot,
        configHash: hash(bytes),
      });
    },
    signal,
  );
}
export interface ContainerOptions {
  image?: string;
  source?: string;
  resume?: boolean;
  signal?: AbortSignal;
}
export async function developmentContainer(
  project: DevelopmentComposeProject,
  command: "up" | "status" | "logs" | "down",
  options: ContainerOptions = {},
  runner: ContainerRunner = developmentContainerRunner,
) {
  if ((command === "status" || command === "logs") && !existsSync(project.controlRoot))
    return {
      version: 1,
      mode: "container",
      project: project.name,
      state: "absent",
      resources: null,
      generation: null,
    };
  try {
    return await withDevelopmentComposeProject(
      project,
      async (control) => {
        let record = control.read(),
          journal = readJournal(project);
        let newlyCreated = false;
        let sshVerified = false;
        const run = (args: string[], timeoutMs = 30000, input?: string) => {
          options.signal?.throwIfAborted();
          return runner.run(args, { timeoutMs, input, signal: options.signal });
        };
        const save = (phase: Phase, extra: Partial<Journal> = {}) => {
          if (!journal) refuse();
          journal = { ...journal, ...extra, phase };
          writeDevelopmentRecord(join(project.controlRoot, "lifecycle.json"), journal);
        };
        let inspected = await inspectContainerProject(project, record, runner, options.signal);
        const snapshot = () => ({
          version: 1,
          mode: "container",
          project: project.name,
          phase: journal?.phase ?? "absent",
          sshReadiness: sshVerified ? "authenticated" : "not-probed",
          state: inspected ? object(object(inspected.container).State).Status : "absent",
          resources:
            inspected && record
              ? verifyDevelopmentComposeResources(project, record, inspected)
              : null,
          generation: journal?.generation ?? null,
          nativeClient: developmentContainerClientInfo(project),
        });
        if (command === "status") return snapshot();
        if (command === "logs") {
          if (
            !record?.resources ||
            !inspected ||
            !object(object(inspected.container).State).Running
          )
            return { ...snapshot(), logs: [], reason: "container-stopped" };
          const result = parse(
            await run([
              "exec",
              record.resources.containerId,
              "node",
              "/workspace/tree/scripts/development-instance.mjs",
              "logs",
              "--json",
              "--worktree",
              "/workspace/tree",
              "--store",
              "/state/instances",
              "--name",
              project.name,
            ]),
          );
          return { ...snapshot(), logs: result };
        }
        if (command === "up" && !record) {
          if (
            options.resume ||
            !options.image ||
            !/^sha256:[a-f0-9]{64}$/u.test(options.image) ||
            !options.source
          )
            refuse();
          const source = readContainerExport(options.source, project.instance.worktree);
          const images = JSON.parse(await run(["image", "inspect", options.image]));
          if (!Array.isArray(images) || images.length !== 1 || images[0]?.Id !== options.image)
            refuse();
          if (journal) refuse();
          record = control.prepare({
            imageId: options.image,
            sourceDigest: source.manifest.snapshotDigest,
          });
          journal = {
            version: 1,
            phase: "creating",
            sourceHash: source.sourceHash,
            generation: null,
            hostKey: null,
            stopHash: null,
            leaseHash: null,
          };
          newlyCreated = true;
          save("creating");
          const config = join(project.controlRoot, "compose.json");
          writeFileSync(config, JSON.stringify(renderDevelopmentComposeConfig(project, record)), {
            mode: 0o600,
            flag: "wx",
          });
          await run(
            [
              "compose",
              "-p",
              project.name,
              "-f",
              config,
              "up",
              "-d",
              "--no-build",
              "--pull",
              "never",
            ],
            60000,
          );
          inspected = await inspectContainerProject(project, record, runner, options.signal);
          if (!inspected) refuse();
          control.adopt(inspected);
          record = control.read()!;
          save("verifying-image");
          const id = record.resources!.containerId;
          // Read via the exact inspected container/image, never host mounts or an ambient checkout.
          const imageManifest = await run([
            "exec",
            id,
            "cat",
            "/opt/source-snapshot/.development-container-source.json",
          ]);
          if (hash(imageManifest) !== journal.sourceHash) refuse();
          for (const name of ["container-lifecycle.mjs", "ssh-fixture.mjs", "ssh-control.mjs"]) {
            const row = source.manifest.files.find(
              (f: Record<string, unknown>) => f.path === `docker/development/${name}`,
            );
            if (!row || row.type !== "file" || !matches(row.hash, HEX)) refuse();
            const code = await run(["exec", id, "cat", `/opt/fixture/${name}`]);
            if (hash(code) !== row.hash) refuse();
          }
          save("preparing");
          await run(
            [
              "exec",
              id,
              "node",
              "/opt/source-snapshot/docker/development/prepare-source.mjs",
              "/opt/source-snapshot",
              "/workspace/tree",
            ],
            600000,
          );
          save("building");
          await run(
            [
              "exec",
              id,
              "node",
              "/workspace/tree/scripts/development-instance.mjs",
              "rebuild",
              "--json",
              "--worktree",
              "/workspace/tree",
              "--store",
              "/state/instances",
              "--name",
              project.name,
              "--bun",
              "/usr/local/bin/bun",
            ],
            600000,
          );
          save("starting");
        } else if (!record || !journal || !record.resources || !inspected) refuse();
        if (!record?.resources || !journal) refuse();
        if (options.image && options.image !== record.imageId) refuse();
        if (
          options.source &&
          readContainerExport(options.source, project.instance.worktree).sourceHash !==
            journal.sourceHash
        )
          refuse();
        const id = record.resources.containerId;
        const verify = async () => {
          const raw = await inspectContainerProject(project, record, runner, options.signal);
          if (!raw) refuse();
          control.adopt(raw);
          inspected = raw;
          record = control.read()!;
          return raw;
        };
        const lifecycle = async (action: string, expected?: string) =>
          parse(
            await run(
              [
                "exec",
                id,
                "node",
                "--import",
                "/workspace/tree/node_modules/tsx/dist/loader.mjs",
                "/opt/fixture/container-lifecycle.mjs",
                action,
                project.name,
                id,
                developmentComposeVolumesHash(record!.resources!),
                ...(expected ? [expected] : []),
              ],
              60000,
            ),
          );
        const manager = async (action: string) =>
          parse(
            await run(
              [
                "exec",
                id,
                "node",
                "/workspace/tree/scripts/development-instance.mjs",
                action,
                "--json",
                "--worktree",
                "/workspace/tree",
                "--store",
                "/state/instances",
                "--name",
                project.name,
              ],
              60000,
            ),
          );
        const sshReady = async (lease: Record<string, unknown>) => {
          await verifyContainerSsh(project, record!, journal!, lease, runner, options.signal);
          sshVerified = true;
        };
        if (command === "up") {
          if (["stopped", "suspended", "stopping-container"].includes(journal.phase)) {
            if (!options.resume)
              throw new DevelopmentOperationError(
                "instance-suspended",
                "Container up requires explicit --resume after complete suspension",
              );
            if (!journal.stopHash) refuse();
            save("resuming");
            const raw = await verify();
            if (!object(object(raw.container).State).Running) {
              await run(["start", id]);
              await verify();
            }
            const resumed = await lifecycle("resume", journal.stopHash);
            if (resumed.state !== "resumed" || resumed.receiptHash !== journal.stopHash) refuse();
            save("starting");
          } else if (
            options.resume ||
            !(journal.phase === "ready" || (newlyCreated && journal.phase === "starting"))
          )
            refuse();
          await verify();
          const up = journal.phase === "ready" ? null : await manager("up");
          if (up && up.state !== "ready") refuse();
          const ready = await lifecycle("ready");
          const lease = object(ready.lease);
          if (
            ready.state !== "ready" ||
            !matches(lease.generation, /^build-[a-f0-9-]{36}$/u) ||
            (up && lease.generation !== object(up.activeBuild).generation)
          )
            refuse();
          if (journal.generation && journal.generation !== lease.generation) refuse();
          // Existing ready listener is never silently reinitialized or rebound.
          if (journal.phase === "ready") {
            const currentLease = parse(await run(["exec", id, "cat", "/state/ssh/lease.json"]));
            if (
              hash(JSON.stringify(currentLease)) !== journal.leaseHash ||
              JSON.stringify(currentLease) !== JSON.stringify(lease)
            )
              refuse();
            await sshReady(lease);
            return snapshot();
          }
          const key = join(project.controlRoot, "client_ed25519");
          const priorKey = readPrivateDevelopmentFile(key);
          if (!priorKey) {
            await execute("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], {
              timeout: 5000,
              maxBuffer: 65536,
            });
            chmodSync(key + ".pub", 0o600);
          }
          const publicKey = readPrivateDevelopmentFile(key + ".pub")?.bytes.toString("utf8");
          if (!publicKey) refuse();
          if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?\n$/u.test(publicKey)) refuse();
          await run(
            [
              "exec",
              "-i",
              id,
              "node",
              "-e",
              "const fs=require('fs');const b=fs.readFileSync(0);const p='/state/client.pub';if(fs.existsSync(p)){if(!fs.readFileSync(p).equals(b))process.exit(1)}else fs.writeFileSync(p,b,{flag:'wx',mode:0o600});",
            ],
            30000,
            publicKey,
          );
          const hostKey = await run([
            "exec",
            id,
            "node",
            "/opt/fixture/ssh-fixture.mjs",
            "init",
            project.name,
            "/state/client.pub",
          ]);
          if (
            !/^ssh-ed25519 [A-Za-z0-9+/=]+\n$/u.test(hostKey) ||
            (journal.hostKey && journal.hostKey !== hostKey)
          )
            refuse();
          // Detached exec belongs to the exact container; listener readiness is checked via its private lease.
          save("starting", {
            hostKey,
            generation: lease.generation,
            leaseHash: hash(JSON.stringify(lease)),
          });
          await run(["exec", "-d", id, "node", "/opt/fixture/ssh-fixture.mjs", "serve"]);
          await run([
            "exec",
            id,
            "node",
            "-e",
            "const fs=require('fs');const end=Date.now()+8000;const t=setInterval(()=>{if(fs.existsSync('/state/ssh/control.sock')&&fs.existsSync('/state/ssh/sshd.pid')){clearInterval(t);process.exit(0)}if(Date.now()>end){clearInterval(t);process.exit(1)}},50)",
          ]);
          await lifecycle("ready");
          await verify();
          await sshReady(lease);
          save("ready");
          return snapshot();
        }
        if (command !== "down") refuse();
        if (["suspended", "stopping-container", "stopped"].includes(journal.phase)) {
          if (!journal.stopHash) refuse();
          const raw = await verify();
          const state = object(object(raw.container).State);
          if (state.Running) {
            if (journal.phase === "stopped") refuse();
            const proof = await run(["exec", id, "cat", "/state/container-stop.json"]);
            if (hash(proof) !== journal.stopHash) refuse();
            save("stopping-container");
            await run(["stop", "--time", "10", id]);
            const stopped = await verify();
            if (
              object(object(stopped.container).State).Running ||
              object(object(stopped.container).State).Pid !== 0
            )
              refuse();
          } else if (state.Pid !== 0) refuse();
          save("stopped");
          return snapshot();
        }
        if (journal.phase !== "ready") refuse();
        await verify();
        save("stopping-listener");
        const stopped = parse(
          await run(["exec", id, "node", "/opt/fixture/ssh-fixture.mjs", "stop"], 15000),
        );
        if (stopped.stopped !== true || stopped.scope !== "ssh-listener") refuse();
        save("suspending");
        const suspended = await lifecycle("suspend");
        if (suspended.state !== "suspended" || !matches(suspended.receiptHash, HEX)) refuse();
        save("suspended", { stopHash: suspended.receiptHash });
        await verify();
        save("stopping-container");
        await run(["stop", "--time", "10", id], 30000);
        const final = await verify();
        if (
          object(object(final.container).State).Running ||
          object(object(final.container).State).Pid !== 0
        )
          refuse();
        save("stopped");
        return snapshot();
      },
      options.signal,
    );
  } catch (error) {
    if (
      error instanceof DevelopmentOperationError ||
      error instanceof DevelopmentComposeResetPendingError
    )
      throw error;
    refuse();
  }
}
