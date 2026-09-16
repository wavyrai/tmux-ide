/** Exact packaged foreground owner entry. Only the manager admits this process. */
import { realpathSync, writeFileSync } from "node:fs";
import { createBoundedDevelopmentLog } from "./development-log.ts";
import { join } from "node:path";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import { readDevelopmentBuild } from "./development-build.ts";
import {
  developmentProcessIdentity,
  readDevelopmentIdentity,
  readDevelopmentOwner,
  readPrivateDevelopmentRecord,
  writeDevelopmentRecord,
} from "./development-state.ts";
import type { DevelopmentInstance } from "./development-instance.ts";
import { runHeadlessDaemon } from "./headless-daemon.ts";

/** A consumed attempt cannot overwrite a live owner or be replayed after its exit. */
export async function claimManagedDevelopmentLaunch(
  instance: DevelopmentInstance,
  attempt: string,
): Promise<void> {
  if (!/^[a-f0-9-]{36}$/u.test(attempt)) throw new Error("Invalid development launch attempt");
  const owner = readDevelopmentOwner(instance);
  if (owner && (await developmentProcessIdentity(owner.pid)) !== null)
    throw new Error("A live or unknown managed owner is protected");
  writeFileSync(
    join(instance.root, `launch-${attempt}.json`),
    JSON.stringify({ version: 1, attempt, pid: process.pid }),
    { flag: "wx", mode: 0o600 },
  );
}

export async function runManagedDevelopmentOwner(): Promise<void> {
  const namespace = resolveRuntimeNamespace();
  const instance = namespace.development;
  if (!instance) throw new Error("Managed development owner requires a development namespace");
  const identity = await readDevelopmentIdentity(instance);
  const attempt = process.env.TMUX_IDE_DEVELOPMENT_ATTEMPT;
  const pending = readPrivateDevelopmentRecord<{
    attempt: string;
    generation: string;
    manifestHash: string;
  }>(join(instance.root, "startup.json"));
  const build = readDevelopmentBuild(instance);
  if (
    !identity ||
    identity.capability !== namespace.cleanupToken ||
    !attempt ||
    pending?.attempt !== attempt ||
    pending.generation !== build.generation ||
    pending.manifestHash !== process.env.TMUX_IDE_DEVELOPMENT_BUILD_HASH
  )
    throw new Error("Development launch admission does not match owner");
  if (
    !process.argv[1] ||
    realpathSync(process.argv[1]) !== build.cli ||
    realpathSync(process.execPath) !== build.tools.node
  )
    throw new Error("Managed owner executable is not the selected build");
  const incarnation = await developmentProcessIdentity(process.pid);
  if (!incarnation) throw new Error("Cannot establish managed owner incarnation");
  await claimManagedDevelopmentLaunch(instance, attempt);
  const log = createBoundedDevelopmentLog(join(instance.root, "logs/owner.log"));
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const writer = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    log.write(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (done) process.nextTick(done);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = writer;
  process.stderr.write = writer;
  try {
    await runHeadlessDaemon({
      json: true,
      expectedVersion: build.packageVersion,
      onOwnedReady: () => {
        writeDevelopmentRecord(join(instance.root, "owner.json"), {
          version: 1,
          attempt,
          pid: process.pid,
          incarnation,
          generation: build.generation,
          manifestHash: pending.manifestHash,
        });
      },
    });
  } catch (error) {
    log.write(
      `Managed owner failed: ${error instanceof Error ? error.message : "unknown startup failure"}\n`,
    );
    throw error;
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    await log.close();
  }
}
