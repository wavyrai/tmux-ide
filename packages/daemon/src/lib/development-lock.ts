import { developmentProcessIdentity } from "./development-state.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateDevelopmentDirectory, type DevelopmentInstance } from "./development-instance.ts";
export async function withDevelopmentLock<T>(
  instance: DevelopmentInstance,
  kind: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const parent = join(instance.root, "locks");
  validateDevelopmentDirectory(parent, instance.store);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const incarnation = await developmentProcessIdentity(process.pid);
  if (!incarnation) throw new Error("Cannot establish lock owner process");
  const path = join(parent, kind);
  const token = randomUUID();
  const deadline = Date.now() + 30_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `Development ${kind} lock busy; inspect ${path}. Unknown owners are never retired automatically.`,
          { cause: error },
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const owner = join(path, "owner.json");
  writeFileSync(
    owner,
    JSON.stringify({ pid: process.pid, incarnation, token, acquiredAt: new Date().toISOString() }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    return await action();
  } finally {
    try {
      if (JSON.parse(readFileSync(owner, "utf8")).token === token)
        rmSync(path, { recursive: true });
    } catch {
      /* Never remove an unverified replacement lock. */
    }
  }
}
