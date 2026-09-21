/** Private container suspension journal. No lifecycle imports or automatic boot recovery. */
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, lstatSync, opendirSync } from "node:fs";
import { join, dirname } from "node:path";
import { validateDevelopmentDirectory, type DevelopmentInstance } from "./development-instance.ts";
import {
  DevelopmentOperationError,
  readPrivateDevelopmentFile,
  type DevelopmentIdentityRecord,
} from "./development-state.ts";
export interface DevelopmentContainerBinding {
  project: string;
  containerId: string;
  /** Hash of caller-verified volume names, ownership labels and creation metadata. */
  volumesHash: string;
}
export interface DevelopmentExecutionWitness {
  bootId: string;
  pidNamespace: string;
}
export function developmentExecutionWitness(): DevelopmentExecutionWitness {
  if (process.platform !== "linux") throw new Error("Container suspension requires Linux");
  return {
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNamespace: readlinkSync("/proc/self/ns/pid"),
  };
}
export interface SuspensionFile {
  name: string;
  hash: string;
  dev: number;
  ino: number;
}
export interface DevelopmentSuspension {
  version: 1;
  phase: "stopping" | "retiring" | "suspended";
  nonce: string;
  identityHash: string;
  binding: DevelopmentContainerBinding;
  witness: DevelopmentExecutionWitness;
  plan: null | {
    files: SuspensionFile[];
    deadPids: number[];
    claimDirectory: { dev: number; ino: number } | null;
  };
}
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9-]{36}$/u;
export function suspensionRefusal(message: string): never {
  throw new DevelopmentOperationError("suspension-unverified", message);
}
export function validateContainerBinding(binding: DevelopmentContainerBinding): void {
  if (
    !binding ||
    typeof binding.project !== "string" ||
    typeof binding.containerId !== "string" ||
    typeof binding.volumesHash !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/u.test(binding.project) ||
    !HASH.test(binding.containerId) ||
    !HASH.test(binding.volumesHash)
  )
    suspensionRefusal("Invalid container suspension binding");
}
export function validateExecutionWitness(witness: DevelopmentExecutionWitness): void {
  if (!witness || !UUID.test(witness.bootId) || !/^pid:\[\d{1,20}\]$/u.test(witness.pidNamespace))
    suspensionRefusal("Invalid container execution witness");
}
export function suspensionIdentityHash(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: instance.id,
        digest: instance.digest,
        worktree: instance.worktree,
        name: instance.name,
        store: instance.store,
        root: instance.root,
        stateHome: instance.stateHome,
        runtimeDir: instance.runtimeDir,
        capability: identity.capability,
        tree: identity.tree,
        git: identity.git,
      }),
    )
    .digest("hex");
}
export function suspensionPath(instance: DevelopmentInstance) {
  return join(instance.root, "suspension.json");
}
export function isSuspensionFile(name: string): boolean {
  return (
    [
      "owner.json",
      "tmux.json",
      "tmux-startup.json",
      "startup.json",
      "startup-process.json",
      "state/daemon.json",
      "state/daemon.claim/owner.json",
    ].includes(name) || /^launch-[a-f0-9-]{36}\.json$/u.test(name)
  );
}
export function readDevelopmentSuspension(
  instance: DevelopmentInstance,
): DevelopmentSuspension | null {
  const file = readPrivateDevelopmentFile(suspensionPath(instance));
  if (file === null) return null;
  const parsed: unknown = JSON.parse(file.bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    suspensionRefusal("Invalid suspension journal");
  const value = parsed as DevelopmentSuspension;
  if (
    value.version !== 1 ||
    typeof value.nonce !== "string" ||
    typeof value.identityHash !== "string" ||
    !["stopping", "retiring", "suspended"].includes(value.phase) ||
    !UUID.test(value.nonce) ||
    !HASH.test(value.identityHash)
  )
    suspensionRefusal("Invalid suspension journal");
  validateContainerBinding(value.binding);
  validateExecutionWitness(value.witness);
  if (value.phase === "stopping") {
    if (value.plan !== null) suspensionRefusal("Invalid stopping plan");
  } else {
    const plan = value.plan;
    if (
      !plan ||
      !Array.isArray(plan.files) ||
      plan.files.length > 64 ||
      !Array.isArray(plan.deadPids) ||
      plan.deadPids.length > 64 ||
      new Set(plan.files.map((file) => file.name)).size !== plan.files.length ||
      plan.deadPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    )
      suspensionRefusal("Invalid retirement plan");
    for (const file of plan.files) {
      if (
        !isSuspensionFile(file.name) ||
        !HASH.test(file.hash) ||
        !Number.isSafeInteger(file.dev) ||
        file.dev < 0 ||
        !Number.isSafeInteger(file.ino) ||
        file.ino < 0
      )
        suspensionRefusal("Invalid retirement file witness");
    }
    if (
      plan.claimDirectory !== null &&
      (!Number.isSafeInteger(plan.claimDirectory?.dev) ||
        plan.claimDirectory.dev < 0 ||
        !Number.isSafeInteger(plan.claimDirectory?.ino) ||
        plan.claimDirectory.ino < 0)
    )
      suspensionRefusal("Invalid claim directory witness");
  }
  return value;
}
/** Every lifecycle admission calls this under the existing lock, before any mutation. */
export function requireDevelopmentNotSuspended(instance: DevelopmentInstance): void {
  const record = readDevelopmentSuspension(instance);
  if (record)
    throw new DevelopmentOperationError(
      "instance-suspended",
      "Instance suspension blocks admission; use its verified container resume or finish suspension",
    );
}
export function suspensionFileWitness(
  instance: DevelopmentInstance,
  name: string,
): SuspensionFile | null {
  if (!isSuspensionFile(name)) suspensionRefusal("Unexpected retirement path");
  const path = join(instance.root, name);
  validateDevelopmentDirectory(dirname(path), instance.root);
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const record = readPrivateDevelopmentFile(path);
  const after = lstatSync(path);
  if (
    record === null ||
    record.dev !== before.dev ||
    record.ino !== before.ino ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs
  )
    suspensionRefusal("Retirement record changed while reading");
  const parsed: unknown = JSON.parse(record.bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    suspensionRefusal("Unknown retirement record is protected");
  return {
    name,
    dev: after.dev,
    ino: after.ino,
    hash: createHash("sha256").update(record.bytes).digest("hex"),
  };
}
/** Bounded allowlisted inventory; unrelated durable data is never a retirement target. */
export function suspensionFileInventory(instance: DevelopmentInstance): SuspensionFile[] {
  const names = [
    "owner.json",
    "tmux.json",
    "tmux-startup.json",
    "startup.json",
    "startup-process.json",
    "state/daemon.json",
    "state/daemon.claim/owner.json",
  ];
  const directory = opendirSync(instance.root);
  try {
    for (let count = 0; ; count++) {
      const entry = directory.readSync();
      if (!entry) break;
      if (count >= 256) suspensionRefusal("Retirement directory budget exceeded");
      const name = entry.name;
      if (name.startsWith("launch-")) {
        if (!isSuspensionFile(name)) suspensionRefusal("Unverified launch admission file");
        names.push(name);
      }
      if (names.length > 64) suspensionRefusal("Retirement file budget exceeded");
    }
  } finally {
    directory.closeSync();
  }
  return names
    .map((name) => suspensionFileWitness(instance, name))
    .filter((file): file is SuspensionFile => file !== null);
}
