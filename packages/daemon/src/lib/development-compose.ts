/** Host-only Compose planning and ownership checks. This module never invokes Docker. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  discoverDevelopmentWorktree,
  resolveDevelopmentInstance,
  validateDevelopmentDirectory,
  type DevelopmentInstance,
} from "./development-instance.ts";
import { withDevelopmentLock } from "./development-lock.ts";
import { readPrivateDevelopmentFile, writeDevelopmentRecord } from "./development-state.ts";

const PREFIX = "io.tmux-ide.development";
const HEX = /^[a-f0-9]{64}$/u;
const destinations = {
  workspace: "/workspace",
  state: "/state",
  runtime: "/tmp/ti-dev-1000",
} as const;
type Role = keyof typeof destinations;
export interface DevelopmentComposeProject {
  instance: DevelopmentInstance;
  name: string;
  controlRoot: string;
}
export interface DevelopmentComposeRecord {
  version: 1;
  project: string;
  tuple: string;
  nonce: string;
  imageId: string;
  sourceDigest: string;
  resources: DevelopmentComposeResources | null;
}
export interface DevelopmentComposeResources {
  containerId: string;
  networkId: string;
  volumes: Record<Role, { name: string; createdAt: string }>;
  port: number | null;
}
function refuse(): never {
  throw new Error("Development Compose ownership is missing, changed or unverifiable");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) refuse();
  return value;
}
function exact(value: unknown, expected: unknown): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) refuse();
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024) refuse();
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!HEX.test(result)) refuse();
  return result;
}
function tuple(project: DevelopmentComposeProject): string {
  const { instance } = project;
  return JSON.stringify([instance.digest, instance.worktree, instance.name, instance.store]);
}
export function resolveDevelopmentComposeProject(input: {
  worktree: string;
  name?: string;
  store?: string;
}): DevelopmentComposeProject {
  const instance = resolveDevelopmentInstance({
    ...input,
    worktree: discoverDevelopmentWorktree(input.worktree),
  });
  return {
    instance,
    name: `ti-${instance.id}`,
    controlRoot: join(instance.store, "containers", instance.id),
  };
}
function recordPath(project: DevelopmentComposeProject): string {
  validateDevelopmentDirectory(project.controlRoot, project.instance.store);
  return join(project.controlRoot, "project.json");
}
function validateRecord(
  project: DevelopmentComposeProject,
  value: unknown,
): DevelopmentComposeRecord {
  const record = object(value);
  if (
    record.version !== 1 ||
    record.project !== project.name ||
    record.tuple !== tuple(project) ||
    typeof record.nonce !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(record.nonce) ||
    typeof record.imageId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.imageId) ||
    typeof record.sourceDigest !== "string" ||
    !HEX.test(record.sourceDigest)
  )
    refuse();
  if (record.resources !== null) {
    const resources = object(record.resources);
    id(resources.containerId);
    id(resources.networkId);
    if (
      resources.port !== null &&
      (!Number.isInteger(resources.port) ||
        Number(resources.port) < 1 ||
        Number(resources.port) > 65535)
    )
      refuse();
    const volumes = object(resources.volumes);
    exact(Object.keys(volumes).sort(), Object.keys(destinations).sort());
    for (const role of Object.keys(destinations) as Role[]) {
      const volume = object(volumes[role]);
      exact(volume.name, `${project.name}_${role}`);
      text(volume.createdAt);
    }
  }
  return record as unknown as DevelopmentComposeRecord;
}
export function readDevelopmentComposeRecord(
  project: DevelopmentComposeProject,
): DevelopmentComposeRecord | null {
  const file = readPrivateDevelopmentFile(recordPath(project));
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    refuse();
  }
  return validateRecord(project, parsed);
}
/** Holds a private host project lock across a future caller's complete Docker transition.
 * Separate from native instance locks/reset. No Docker operation is provided here. */
export async function withDevelopmentComposeProject<T>(
  project: DevelopmentComposeProject,
  action: (control: {
    read(): DevelopmentComposeRecord | null;
    prepare(input: { imageId: string; sourceDigest: string }): DevelopmentComposeRecord;
    adopt(inspect: DevelopmentComposeInspection): DevelopmentComposeResources;
  }) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  recordPath(project);
  return withDevelopmentLock(
    { ...project.instance, root: project.controlRoot },
    "lifecycle",
    async () => {
      let active = true;
      const read = () => {
        if (!active) refuse();
        return readDevelopmentComposeRecord(project);
      };
      try {
        return await action({
          read,
          prepare(input) {
            const previous = read();
            if (previous) {
              exact(previous.imageId, input.imageId);
              exact(previous.sourceDigest, input.sourceDigest);
              return previous;
            }
            const record = validateRecord(project, {
              version: 1,
              project: project.name,
              tuple: tuple(project),
              nonce: randomUUID(),
              imageId: input.imageId,
              sourceDigest: input.sourceDigest,
              resources: null,
            });
            // Durable unpredictable ownership nonce exists before any future resource creation.
            writeDevelopmentRecord(recordPath(project), record);
            return record;
          },
          adopt(inspect) {
            const record = read();
            if (!record) refuse();
            const resources = verifyDevelopmentComposeResources(project, record, inspect);
            writeDevelopmentRecord(recordPath(project), { ...record, resources });
            return resources;
          },
        });
      } finally {
        active = false;
      }
    },
    signal,
  );
}
function labels(record: DevelopmentComposeRecord, role: string): Record<string, string> {
  return {
    [`${PREFIX}.owner`]: record.nonce,
    [`${PREFIX}.source`]: record.sourceDigest,
    [`${PREFIX}.role`]: role,
  };
}
export function renderDevelopmentComposeConfig(
  project: DevelopmentComposeProject,
  input: DevelopmentComposeRecord,
) {
  const record = validateRecord(project, input);
  return {
    name: project.name,
    services: {
      fixture: {
        image: record.imageId,
        user: "1000:1000",
        init: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        labels: labels(record, "fixture"),
        ports: [{ target: 2222, host_ip: "127.0.0.1", protocol: "tcp" }],
        volumes: Object.entries(destinations).map(([source, target]) => ({
          type: "volume",
          source,
          target,
        })),
      },
    },
    volumes: Object.fromEntries(
      Object.keys(destinations).map((role) => [role, { labels: labels(record, role) }]),
    ),
    networks: { default: { internal: true, labels: labels(record, "network") } },
  };
}
/** Complete raw Docker inspect objects/arrays, never a caller-filtered subset of mounts,
 * ports or network attachments. Listing all project resources is a future wrapper duty. */
export interface DevelopmentComposeInspection {
  container: unknown;
  volumes: unknown;
  network: unknown;
}
function verifyLabels(
  value: unknown,
  record: DevelopmentComposeRecord,
  role: string,
  composeKey: string,
  composeValue: string,
) {
  const observed = object(value);
  for (const [key, expected] of Object.entries(labels(record, role)))
    exact(observed[key], expected);
  exact(observed["com.docker.compose.project"], record.project);
  exact(observed[`com.docker.compose.${composeKey}`], composeValue);
}
export function verifyDevelopmentComposeResources(
  project: DevelopmentComposeProject,
  input: DevelopmentComposeRecord,
  inspect: DevelopmentComposeInspection,
): DevelopmentComposeResources {
  const record = validateRecord(project, input);
  const container = object(inspect.container);
  const config = object(container.Config);
  const host = object(container.HostConfig);
  const network = object(inspect.network);
  const networkName = `${project.name}_default`;
  const state = object(container.State);
  if (typeof state.Running !== "boolean") refuse();
  const running = state.Running;
  if (running) exact(state.Status, "running");
  if (!running && !["exited", "created"].includes(String(state.Status))) refuse();
  const containerId = id(container.Id);
  const networkId = id(network.Id);
  exact(container.Image, record.imageId);
  exact(config.User, "1000:1000");
  verifyLabels(config.Labels, record, "fixture", "service", "fixture");
  exact(host.Privileged, false);
  exact(host.NetworkMode, networkName);
  exact(host.CapDrop, ["ALL"]);
  exact(host.CapAdd, null);
  exact(host.SecurityOpt, ["no-new-privileges:true"]);
  exact(host.Binds, null);
  exact(host.Devices, []);
  exact(host.PidMode, "");
  exact(host.IpcMode, "private");
  const attachments = object(object(container.NetworkSettings).Networks);
  exact(Object.keys(attachments), [networkName]);
  const attachedId = object(attachments[networkName]).NetworkID;
  if (attachedId !== networkId && !(attachedId === "" && !running)) refuse();
  exact(network.Name, networkName);
  exact(network.Driver, "bridge");
  exact(network.Internal, true);
  verifyLabels(network.Labels, record, "network", "network", "default");
  const members = object(network.Containers);
  if (Object.keys(members).some((member) => member !== containerId)) refuse();
  if (running && !Object.hasOwn(members, containerId)) refuse();
  const rawPorts = object(container.NetworkSettings).Ports;
  let port: number | null = null;
  if (!(rawPorts === null && !running)) {
    const ports = object(rawPorts);
    if (!running && Object.keys(ports).length === 0) {
      // Docker can clear runtime endpoint observations after stop.
    } else {
      exact(Object.keys(ports), ["2222/tcp"]);
      const mapping = array(ports["2222/tcp"]);
      if (mapping.length !== 1) refuse();
      const binding = object(mapping[0]);
      exact(binding.HostIp, "127.0.0.1");
      const portText = text(binding.HostPort);
      if (!/^[1-9][0-9]{0,4}$/u.test(portText) || Number(portText) > 65535) refuse();
      port = Number(portText);
    }
  }
  if (running && port === null) refuse();
  const bindings = object(host.PortBindings);
  exact(Object.keys(bindings), ["2222/tcp"]);
  const requested = array(bindings["2222/tcp"]);
  if (requested.length !== 1) refuse();
  exact(object(requested[0]).HostIp, "127.0.0.1");
  const requestedPort = object(requested[0]).HostPort;
  if (
    typeof requestedPort !== "string" ||
    !/^(?:|0|[1-9][0-9]{0,4})$/u.test(requestedPort) ||
    Number(requestedPort) > 65535
  )
    refuse();
  const rawVolumes = array(inspect.volumes);
  const mounts = array(container.Mounts);
  if (rawVolumes.length !== 3 || mounts.length !== 3) refuse();
  const volumes = {} as DevelopmentComposeResources["volumes"];
  for (const role of Object.keys(destinations) as Role[]) {
    const name = `${project.name}_${role}`;
    const matches = rawVolumes.map(object).filter((volume) => volume.Name === name);
    if (matches.length !== 1) refuse();
    const volume = matches[0]!;
    exact(volume.Driver, "local");
    exact(volume.Scope, "local");
    exact(volume.Options, null);
    verifyLabels(volume.Labels, record, role, "volume", role);
    const createdAt = text(volume.CreatedAt);
    if (!Number.isFinite(Date.parse(createdAt))) refuse();
    const matchingMounts = mounts.map(object).filter((mount) => mount.Name === name);
    if (matchingMounts.length !== 1) refuse();
    const mount = matchingMounts[0]!;
    exact(mount.Type, "volume");
    exact(mount.Driver, "local");
    exact(mount.Destination, destinations[role]);
    exact(mount.RW, true);
    exact(mount.Source, text(volume.Mountpoint));
    volumes[role] = { name, createdAt };
  }
  const result = { containerId, networkId, volumes, port };
  if (record.resources) {
    // Ports may be reassigned after a supported same-container restart; IDs and volumes may not.
    exact({ ...result, port: 0 }, { ...record.resources, port: 0 });
  }
  return result;
}
/** Volume names/creation metadata are witnesses, not Docker-provided immutable IDs. */
export function developmentComposeVolumesHash(resources: DevelopmentComposeResources): string {
  return createHash("sha256").update(JSON.stringify(resources.volumes)).digest("hex");
}
