/** Explicit manager selection: recorded IDs remain inspectable after source trees move. */
import { opendirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  resolveDevelopmentInstancePaths,
  type DevelopmentInstance,
} from "./development-instance.ts";
import {
  readPrivateDevelopmentRecord,
  readDevelopmentIdentity,
  type DevelopmentIdentityRecord,
} from "./development-state.ts";
export async function selectRecordedDevelopmentInstance(
  id: string,
  store?: string,
): Promise<DevelopmentInstance> {
  if (!/^dev-[a-f0-9]{24}$/u.test(id)) throw new Error("Invalid development instance ID");
  const base = resolveDevelopmentInstancePaths({ worktree: "/", store });
  const root = join(base.store, "instances", id);
  const record =
    readPrivateDevelopmentRecord<DevelopmentIdentityRecord>(join(root, "instance.json")) ??
    readPrivateDevelopmentRecord<DevelopmentIdentityRecord>(join(root, "reset.json"));
  if (!record) throw new Error("No verified stored development identity");
  const instance = resolveDevelopmentInstancePaths({
    worktree: record.worktree,
    name: record.name,
    store: base.store,
  });
  if (instance.id !== id || instance.root !== root)
    throw new Error("Stored development identity mismatch");
  if (!(await readDevelopmentIdentity(instance, { allowOrphan: true, allowReset: true })))
    throw new Error("Missing development identity");
  return instance;
}
export async function developmentWorktreeState(
  instance: DevelopmentInstance,
): Promise<"present" | "missing" | "changed"> {
  try {
    lstatSync(instance.worktree);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "changed";
  }
  try {
    await readDevelopmentIdentity(instance, { allowReset: true });
    return "present";
  } catch {
    return "changed";
  }
}
export async function listDevelopmentInstances(store?: string) {
  const base = resolveDevelopmentInstancePaths({ worktree: "/", store });
  const entries: {
    id: string;
    worktree?: string;
    name?: string;
    worktreeState?: string;
    blocked?: boolean;
  }[] = [];
  let directory;
  try {
    directory = opendirSync(join(base.store, "instances"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { instances: entries, truncated: false };
    throw error;
  }
  let truncated = false;
  try {
    for (let scanned = 0; ; scanned++) {
      const entry = directory.readSync();
      if (!entry) break;
      if (scanned >= 256) {
        truncated = true;
        break;
      }
      if (!/^dev-[a-f0-9]{24}$/u.test(entry.name)) continue;
      try {
        const instance = await selectRecordedDevelopmentInstance(entry.name, base.store);
        entries.push({
          id: instance.id,
          worktree: instance.worktree,
          name: instance.name,
          worktreeState: await developmentWorktreeState(instance),
        });
      } catch {
        entries.push({ id: entry.name, blocked: true });
      }
    }
  } finally {
    directory.closeSync();
  }
  return { instances: entries, truncated };
}
