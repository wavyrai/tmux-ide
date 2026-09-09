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
} from "node:fs";
import { dirname, join } from "node:path";
import { SavedMachineRegistrySchema, type SavedMachineRegistry } from "@tmux-ide/contracts";
import { changeSavedMachines, type SavedMachineChange } from "@tmux-ide/core";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

const MAX_REGISTRY_BYTES = 64 * 1024;
export function savedMachinesPath(): string {
  return join(resolveRuntimeNamespace().registryDir, "machines.json");
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

/** The daemon owns writes. Synchronous read/reduce/rename cannot interleave within it. */
export function updateSavedMachines(
  change: SavedMachineChange,
  path = savedMachinesPath(),
): SavedMachineRegistry {
  const registry = changeSavedMachines(loadSavedMachines(path), change);
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
