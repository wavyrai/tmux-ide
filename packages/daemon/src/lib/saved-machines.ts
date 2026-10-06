import { runtimeOwnedPath } from "./runtime-namespace.ts";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  watch,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { SavedMachineRegistrySchema, type SavedMachineRegistry } from "@tmux-ide/contracts";
import { changeSavedMachines, type SavedMachineChange } from "@tmux-ide/core";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

const MAX_REGISTRY_BYTES = 64 * 1024;
export function savedMachinesPath(): string {
  return runtimeOwnedPath(join(resolveRuntimeNamespace().registryDir, "machines.json"));
}

/** Missing means empty; corruption/unsupported versions fail closed, never reset profiles. */
export function loadSavedMachines(path = savedMachinesPath()): SavedMachineRegistry {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, machines: [] };
    throw error;
  }
  try {
    if (fstatSync(fd).size > MAX_REGISTRY_BYTES)
      throw new Error("Saved machine registry exceeds size limit");
    return SavedMachineRegistrySchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

/** Watch the directory so atomic registry replacement does not detach the watcher. */
export function watchSavedMachines(
  onChange: (registry: SavedMachineRegistry) => void,
  onError: () => void,
  path = savedMachinesPath(),
): () => void {
  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    pending = null;
    if (stopped) return;
    try {
      onChange(loadSavedMachines(path));
    } catch {
      // Keep the last valid routes while an editor is midway through a write.
      onError();
    }
  };
  // A first-run app can subscribe before the daemon creates its registry.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const watcher = watch(dirname(path), (_event, file) => {
    if (stopped || (file !== null && file.toString() !== basename(path))) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(refresh, 50);
    pending.unref();
  });
  watcher.unref();
  watcher.on("error", onError);
  // Close the read-before-subscribe race at startup.
  pending = setTimeout(refresh, 0);
  pending.unref();
  return () => {
    stopped = true;
    if (pending) clearTimeout(pending);
    watcher.close();
  };
}

/** The daemon owns writes. Synchronous read/reduce/rename cannot interleave within it. */
export function updateSavedMachines(
  change: SavedMachineChange,
  path = savedMachinesPath(),
): SavedMachineRegistry {
  const registry = changeSavedMachines(loadSavedMachines(path), change);
  return persistSavedMachines(registry, path);
}

function persistSavedMachines(registry: SavedMachineRegistry, path: string) {
  const contents = JSON.stringify(registry, null, 2) + "\n";
  if (Buffer.byteLength(contents) > MAX_REGISTRY_BYTES)
    throw new Error("Saved machine registry exceeds size limit");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the write failure; cleanup cannot replace its diagnostic.
    }
    throw error;
  }
  return registry;
}

/** Add-only merge: imports never silently overwrite trusted routes. */
export function planSavedMachineMerge(
  current: SavedMachineRegistry,
  incoming: SavedMachineRegistry,
): SavedMachineRegistry {
  const verified = SavedMachineRegistrySchema.parse(incoming);
  let next = SavedMachineRegistrySchema.parse(current);
  for (const machine of verified.machines) {
    const existing = next.machines.find((entry) => entry.id === machine.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(machine))
        throw new Error("Imported machine conflicts with an existing route");
    } else next = changeSavedMachines(next, { type: "add", machine });
  }
  return next;
}
export function mergeSavedMachines(incoming: SavedMachineRegistry, path = savedMachinesPath()) {
  return persistSavedMachines(planSavedMachineMerge(loadSavedMachines(path), incoming), path);
}
