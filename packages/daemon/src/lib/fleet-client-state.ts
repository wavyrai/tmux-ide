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
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  FleetClientStateSchema,
  FleetClientStateChangeSchema,
  type FleetClientStateChange,
} from "@tmux-ide/contracts/fleet-client-state";
import { emptyFleetClientState, changeFleetClientState } from "@tmux-ide/core";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

const MAX_BYTES = 1024 * 1024;
export function fleetClientStatePath(): string {
  return join(resolveRuntimeNamespace().registryDir, "fleet-view.json");
}
export function loadFleetClientState(path = fleetClientStatePath()) {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFleetClientState();
    throw new Error("Fleet view state is unavailable", { cause: error });
  }
  try {
    if (fstatSync(fd).size > MAX_BYTES) throw new Error();
    return FleetClientStateSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    throw new Error("Fleet view state is invalid; the existing file was preserved");
  } finally {
    closeSync(fd);
  }
}

/** Only the daemon writes. Read/reduce/rename is synchronous within that owner. */
export function updateFleetClientState(
  change: FleetClientStateChange,
  path = fleetClientStatePath(),
) {
  const state = changeFleetClientState(
    loadFleetClientState(path),
    FleetClientStateChangeSchema.parse(change),
  );
  const contents = JSON.stringify(state);
  if (Buffer.byteLength(contents) > MAX_BYTES)
    throw new Error("Fleet view state exceeds its size limit");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename consumed the temporary file. */
    }
  }
  return state;
}
