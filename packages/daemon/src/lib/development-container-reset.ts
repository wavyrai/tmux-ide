/** Explicit destruction of one fully owned project. Never a process-identity recovery bypass. */
import { createHash } from "node:crypto";
import { readdirSync, unlinkSync, rmdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  type DevelopmentComposeProject,
  type DevelopmentComposeRecord,
  type DevelopmentComposeInspection,
  withDevelopmentComposeProject,
  verifyDevelopmentComposeResources,
  validateDevelopmentComposeRecord,
} from "./development-compose.ts";
import {
  developmentContainerRunner,
  inspectContainerProject,
  developmentContainerClient,
  developmentContainerClientInfo,
  type ContainerRunner,
} from "./development-container.ts";
import { withRetiredDevelopmentContainerClient } from "./development-control.ts";
import { validateDevelopmentDirectory } from "./development-instance.ts";
import {
  DevelopmentOperationError,
  readPrivateDevelopmentFile,
  writeDevelopmentRecord,
} from "./development-state.ts";
const roles = ["workspace", "state", "runtime"] as const;
const files = [
  "project.json",
  "lifecycle.json",
  "compose.json",
  "client_ed25519",
  "client_ed25519.pub",
  "known_hosts",
  "ssh_config",
  "native-ssh/ssh",
];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function refuse(): never {
  throw new DevelopmentOperationError(
    "operation-failed",
    "Container reset refused; preserve private reset intent and inspect exact ownership",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function list(text: string): string[] {
  return text.trim() ? text.trim().split("\n") : [];
}
function decode(text: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) refuse();
  return value.map(object);
}
function exact(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) refuse();
}
interface Intent {
  version: 1;
  project: string;
  tuple: string;
  record: DevelopmentComposeRecord | null;
  baseline: DevelopmentComposeInspection | null;
  host: Record<string, { hash: string; dev: number; ino: number }>;
}
const tuple = (p: DevelopmentComposeProject) =>
  JSON.stringify([p.instance.digest, p.instance.worktree, p.instance.name, p.instance.store]);
function hostInventory(project: DevelopmentComposeProject) {
  validateDevelopmentDirectory(project.controlRoot, project.instance.store);
  for (const entry of readdirSync(project.controlRoot)) {
    if (
      ![
        ...files.filter((f) => !f.includes("/")),
        "locks",
        "reset.json",
        "reset-intent.json",
        "native-ssh",
      ].includes(entry)
    )
      refuse();
  }
  const directory = join(project.controlRoot, "native-ssh");
  try {
    lstatSync(directory);
    validateDevelopmentDirectory(directory, project.controlRoot);
    if (readdirSync(directory).some((name) => name !== "ssh")) refuse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result: Intent["host"] = {};
  for (const name of files) {
    const file = readPrivateDevelopmentFile(join(project.controlRoot, name));
    if (file) result[name] = { hash: hash(file.bytes), dev: file.dev, ino: file.ino };
  }
  return result;
}
function readIntent(project: DevelopmentComposeProject): Intent | null {
  const file = readPrivateDevelopmentFile(join(project.controlRoot, "reset-intent.json"));
  if (!file) return null;
  const value = object(JSON.parse(file.bytes.toString()));
  if (value.version !== 1 || value.project !== project.name || value.tuple !== tuple(project))
    refuse();
  const host = object(value.host);
  for (const [name, raw] of Object.entries(host)) {
    const witness = object(raw);
    if (
      !files.includes(name) ||
      typeof witness.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(witness.hash) ||
      ![witness.dev, witness.ino].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      )
    )
      refuse();
  }
  if (value.record !== null) validateDevelopmentComposeRecord(project, value.record);
  if (value.baseline !== null) {
    if (!value.record) refuse();
    verifyDevelopmentComposeResources(
      project,
      value.record as DevelopmentComposeRecord,
      value.baseline as DevelopmentComposeInspection,
    );
  } else if (
    value.record !== null &&
    object(value.record).resources !== null &&
    value.record !== null
  )
    refuse();
  return value as unknown as Intent;
}
function boundedWrite(path: string, value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 60000) refuse();
  writeDevelopmentRecord(path, value);
}
/** Keep only verifier inputs; never archive Docker environment/commands in the intent. */
function baseline(raw: DevelopmentComposeInspection): DevelopmentComposeInspection {
  const c = object(raw.container),
    n = object(raw.network),
    cfg = object(c.Config),
    h = object(c.HostConfig);
  return {
    container: {
      Id: c.Id,
      Name: c.Name,
      Image: c.Image,
      Config: { User: cfg.User, Labels: cfg.Labels },
      HostConfig: Object.fromEntries(
        [
          "Privileged",
          "NetworkMode",
          "CapDrop",
          "CapAdd",
          "SecurityOpt",
          "Binds",
          "Devices",
          "PidMode",
          "IpcMode",
          "PortBindings",
        ].map((k) => [k, h[k]]),
      ),
      State: c.State,
      NetworkSettings: c.NetworkSettings,
      Mounts: c.Mounts,
    },
    network: {
      Id: n.Id,
      Name: n.Name,
      Driver: n.Driver,
      Internal: n.Internal,
      Labels: n.Labels,
      Containers: n.Containers,
    },
    volumes: raw.volumes,
  };
}
async function remaining(
  project: DevelopmentComposeProject,
  intent: Intent,
  run: (args: string[]) => Promise<string>,
) {
  const label = `label=com.docker.compose.project=${project.name}`;
  const allContainers = list(
    await run(["ps", "-a", "--no-trunc", "--format", "{{.ID}}|{{.Names}}"]),
  ).map((line) => line.split("|"));
  const allNetworks = list(
    await run(["network", "ls", "--no-trunc", "--format", "{{.ID}}|{{.Name}}"]),
  ).map((line) => line.split("|"));
  if (
    [...allContainers, ...allNetworks].some(
      (row) => row.length !== 2 || !/^[a-f0-9]{64}$/.test(row[0]!) || !row[1],
    )
  )
    refuse();
  const allVolumes = list(await run(["volume", "ls", "--format", "{{.Name}}"]));
  const ids = intent.record?.resources;
  const cs = allContainers.filter(
    ([id, name]) => id === ids?.containerId || name === `${project.name}-fixture-1`,
  );
  const ns = allNetworks.filter(
    ([id, name]) => id === ids?.networkId || name === `${project.name}_default`,
  );
  const vs = roles
    .map((role) => `${project.name}_${role}`)
    .filter((name) => allVolumes.includes(name));
  if (cs.length > 1 || ns.length > 1) refuse();
  if (cs.length) exact(cs[0], [ids?.containerId, `${project.name}-fixture-1`]);
  if (ns.length) exact(ns[0], [ids?.networkId, `${project.name}_default`]);
  exact(
    list(await run(["ps", "-a", "--no-trunc", "--filter", label, "--format", "{{.ID}}"])).sort(),
    cs.map((row) => row[0]).sort(),
  );
  exact(
    list(
      await run(["network", "ls", "--no-trunc", "--filter", label, "--format", "{{.ID}}"]),
    ).sort(),
    ns.map((row) => row[0]).sort(),
  );
  exact(
    list(await run(["volume", "ls", "--filter", label, "--format", "{{.Name}}"])).sort(),
    [...vs].sort(),
  );
  const present = [
    cs.length === 1,
    ns.length === 1,
    ...roles.map((role) => vs.includes(`${project.name}_${role}`)),
  ];
  if (!intent.baseline) {
    if (present.some(Boolean)) refuse();
    return { present, container: null };
  }
  // Deletion is a prefix of the fixed container/network/workspace/state/runtime sequence.
  if (present.some((yes, index) => yes && present.slice(index).includes(false))) refuse();
  const combined = structuredClone(intent.baseline);
  let container: Record<string, unknown> | null = null;
  if (cs.length) {
    const values = decode(await run(["inspect", ids!.containerId]));
    if (values.length !== 1) refuse();
    combined.container = container = values[0]!;
  } else {
    const c = object(combined.container);
    c.State = { Running: false, Status: "exited", Pid: 0 };
    c.NetworkSettings = {
      Ports: null,
      Networks: { [`${project.name}_default`]: { NetworkID: "" } },
    };
  }
  if (ns.length) {
    const values = decode(await run(["network", "inspect", ids!.networkId]));
    if (values.length !== 1) refuse();
    combined.network = values[0]!;
  } else object(combined.network).Containers = {};
  const volumes = combined.volumes as Array<Record<string, unknown>>;
  for (const name of vs) {
    const values = decode(await run(["volume", "inspect", name]));
    if (values.length !== 1) refuse();
    const i = volumes.findIndex((v) => v.Name === name);
    if (i < 0) refuse();
    volumes[i] = values[0]!;
  }
  verifyDevelopmentComposeResources(project, intent.record!, combined);
  for (const name of vs) {
    const references = list(
      await run(["ps", "-a", "--no-trunc", "--filter", `volume=${name}`, "--format", "{{.ID}}"]),
    );
    if (references.some((id) => !cs.length || id !== ids!.containerId)) refuse();
  }
  return { present, container };
}
export async function resetDevelopmentContainer(
  project: DevelopmentComposeProject,
  options: { yes?: boolean; signal?: AbortSignal } = {},
  runner: ContainerRunner = developmentContainerRunner,
) {
  if (!options.yes)
    throw new DevelopmentOperationError("confirmation-required", "Container reset requires --yes");
  return withDevelopmentComposeProject(
    project,
    async (control) => {
      const run = (args: string[]) => {
        options.signal?.throwIfAborted();
        return runner.run(args, { signal: options.signal });
      };
      let intent = readIntent(project);
      if (!intent) {
        const record = control.read();
        const raw = await inspectContainerProject(
          project,
          record?.resources ? record : null,
          runner,
          options.signal,
        );
        // Prepared-but-unadopted resources cannot be recovered by guessing creation ownership.
        intent = {
          version: 1,
          project: project.name,
          tuple: tuple(project),
          record,
          baseline: raw ? baseline(raw) : null,
          host: hostInventory(project),
        };
        await remaining(project, intent, run);
        boundedWrite(join(project.controlRoot, "reset-intent.json"), intent);
      }
      const planned = intent;
      const currentHost = hostInventory(project);
      for (const [name, witness] of Object.entries(currentHost)) exact(witness, planned.host[name]);
      // Missing known host files are allowed only after all original Docker resources retired.
      let observed = await remaining(project, planned, run);
      if (observed.present.some(Boolean)) exact(currentHost, planned.host);
      return withRetiredDevelopmentContainerClient(
        developmentContainerClient(project),
        async () => {
          observed = await remaining(project, planned, run);
          if (observed.container && object(observed.container.State).Running) {
            await run(["stop", "--time", "10", planned.record!.resources!.containerId]);
            observed = await remaining(project, planned, run);
          }
          if (
            observed.container &&
            (object(observed.container.State).Running !== false ||
              object(observed.container.State).Pid !== 0)
          )
            refuse();
          const ids = planned.record?.resources;
          const commands = ids
            ? [
                ["rm", ids.containerId],
                ["network", "rm", ids.networkId],
                ...roles.map((role) => ["volume", "rm", ids.volumes[role].name]),
              ]
            : [];
          for (let i = 0; i < commands.length; i++) {
            observed = await remaining(project, planned, run);
            if (observed.present[i]) await run(commands[i]!);
          }
          if ((await remaining(project, planned, run)).present.some(Boolean)) refuse();
          const inventory = hostInventory(project);
          for (const [name, witness] of Object.entries(inventory))
            exact(witness, planned.host[name]);
          for (const name of files) {
            const path = join(project.controlRoot, name),
              file = readPrivateDevelopmentFile(path);
            if (file) {
              exact({ hash: hash(file.bytes), dev: file.dev, ino: file.ino }, planned.host[name]);
              unlinkSync(path);
            }
          }
          try {
            rmdirSync(join(project.controlRoot, "native-ssh"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          boundedWrite(join(project.controlRoot, "reset.json"), {
            version: 1,
            project: project.name,
            tuple: tuple(project),
            retired: ids ?? null,
          });
          unlinkSync(join(project.controlRoot, "reset-intent.json"));
          return {
            version: 1,
            mode: "container",
            project: project.name,
            state: "reset",
            resources: null,
            nativeClient: developmentContainerClientInfo(project),
          };
        },
      );
    },
    options.signal,
    true,
  );
}
