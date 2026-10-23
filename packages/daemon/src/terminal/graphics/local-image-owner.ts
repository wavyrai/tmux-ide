import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { LocalImageStore, type LocalImageLease } from "./local-image-store.ts";

const OwnerSchema = z
  .object({
    generation: z.uuid(),
    pid: z.number().int().positive().max(2147483647),
    startedAt: z.iso.datetime(),
  })
  .strict();
export type LocalImageOwnerIdentity = z.infer<typeof OwnerSchema>;
const FileSchema = z
  .object({
    dev: z.number().nonnegative(),
    ino: z.number().nonnegative(),
    mode: z.number().int(),
    size: z.number().nonnegative(),
    mtimeMs: z.number(),
    ctimeMs: z.number(),
  })
  .strict();
const ManifestSchema = z
  .object({
    version: z.literal(1),
    owner: OwnerSchema,
    directory: FileSchema,
    store: z
      .object({ name: z.string().regex(/^local-images-[A-Za-z0-9]+$/u), identity: FileSchema })
      .strict(),
    files: z
      .array(z.object({ name: z.string().regex(/^[a-f0-9]{64}$/u), identity: FileSchema }).strict())
      .max(512),
  })
  .strict();
type Manifest = z.infer<typeof ManifestSchema>;
const record = (s: Stats) => ({
  dev: s.dev,
  ino: s.ino,
  mode: s.mode,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
});
const same = (a: Pick<Stats, "dev" | "ino">, b: Pick<Stats, "dev" | "ino">) =>
  a.dev === b.dev && a.ino === b.ino;
const privateDir = (s: Stats) =>
  s.isDirectory() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0;
const privateFile = (s: Stats) =>
  s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0;
async function directory(path: string, expected?: Pick<Stats, "dev" | "ino">) {
  const stat = await lstat(path);
  if (!privateDir(stat) || (expected && !same(stat, expected)))
    throw new Error("Local image owner directory replaced");
  return stat;
}
async function readManifest(path: string): Promise<{ manifest: Manifest; identity: Stats }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!privateFile(stat) || stat.size > 256 * 1024)
      throw new Error("Invalid local image manifest file");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Truncated local image manifest");
      offset += read.bytesRead;
    }
    const current = await lstat(path);
    if (!same(stat, current) || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)
      throw new Error("Local image manifest replaced");
    const manifest = ManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length)
      throw new Error("Duplicate local image manifest file");
    return { manifest, identity: stat };
  } finally {
    await file.close();
  }
}
interface Options extends LocalImageOwnerIdentity {
  /** Already proven private canonical root, while holding the startup claim. */
  root: string;
  store?: Pick<
    Parameters<typeof LocalImageStore.create>[0],
    "maxBytes" | "maxFiles" | "maxLeases" | "ttlMs"
  >;
}
/** Per-generation lifecycle wrapper. The lease is never published before its
 * owned file identity is persisted. A crash before journal publication leaves
 * an unrecorded file, which cleanup deliberately preserves rather than guesses.
 */
export class LocalImageOwner {
  #tail: Promise<unknown> = Promise.resolve();
  #disposal: Promise<void> | undefined;
  #manifestIdentity: Stats | undefined;
  private constructor(
    readonly path: string,
    readonly identity: LocalImageOwnerIdentity,
    private readonly store: LocalImageStore,
    readonly root: string,
    readonly rootIdentity: Stats,
    readonly pathIdentity: Stats,
    readonly storeIdentity: Stats,
  ) {}
  static async create(options: Options): Promise<LocalImageOwner> {
    const identity = OwnerSchema.parse({
      generation: options.generation,
      pid: options.pid,
      startedAt: options.startedAt,
    });
    const rootIdentity = await directory(options.root);
    const root = await realpath(options.root);
    await directory(root, rootIdentity);
    const path = join(root, `local-images-${identity.generation}`);
    await mkdir(path, { mode: 0o700 }); // Exclusive: never adopt another instance directory.
    const pathIdentity = await directory(path);
    const store = await LocalImageStore.create({
      parent: path,
      generation: identity.generation,
      ...options.store,
    });
    const owner = new LocalImageOwner(
      path,
      identity,
      store,
      root,
      rootIdentity,
      pathIdentity,
      await directory(store.directory),
    );
    try {
      await owner.#persist();
    } catch (error) {
      await store.dispose().catch(() => {});
      throw error;
    }
    return owner;
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #check() {
    await directory(this.root, this.rootIdentity);
    await directory(this.path, this.pathIdentity);
  }
  async #persist() {
    await this.#check();
    const files = await this.store.ownedFiles();
    const manifest: Manifest = {
      version: 1,
      owner: this.identity,
      directory: record(this.pathIdentity),
      store: { name: basename(this.store.directory), identity: record(this.storeIdentity) },
      files: files.map((f) => ({ name: basename(f.path), identity: record(f.identity) })),
    };
    const encoded = JSON.stringify(ManifestSchema.parse(manifest));
    const path = join(this.path, "owner.json");
    if (this.#manifestIdentity) {
      const current = await readManifest(path);
      if (
        JSON.stringify(record(current.identity)) !== JSON.stringify(record(this.#manifestIdentity))
      )
        throw new Error("Local image manifest replaced");
      // Leases are in-memory; only the owned file set is crash-recovery data.
      // Reuse its durable record after checking identity, including on shared leases.
      if (JSON.stringify(current.manifest) === encoded) return;
    }
    const temporary = join(this.path, `.owner-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = await file.stat();
    try {
      await file.writeFile(encoded);
      await file.sync();
      await this.#check();
      if (!same(await lstat(temporary), stat))
        throw new Error("Local image manifest staging replaced");
      if (this.#manifestIdentity) await rename(temporary, path);
      else {
        await link(temporary, path);
        await unlink(temporary);
      }
      this.#manifestIdentity = await lstat(path);
      if (!same(this.#manifestIdentity, stat))
        throw new Error("Local image manifest publication replaced");
    } finally {
      await file.close();
      await this.#removeStaging(temporary, stat);
    }
  }
  async #removeStaging(path: string, identity: Stats): Promise<void> {
    await this.#check();
    let remaining: Stats;
    try {
      remaining = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!remaining.isFile() || !same(remaining, identity))
      throw new Error("Local image manifest cleanup refused replacement");
    await unlink(path);
  }
  acquire(input: Parameters<LocalImageStore["acquire"]>[0]): Promise<LocalImageLease> {
    // Store admission snapshots mutable bytes synchronously and bounds queued memory.
    const lease = this.store.acquire(input);
    void lease.catch(() => {});
    return this.#serial(async () => {
      const result = await lease;
      try {
        await this.#persist();
      } catch (error) {
        await this.store.release(result).catch(() => {});
        throw error;
      }
      return result;
    });
  }
  release(scope: Parameters<LocalImageStore["release"]>[0]): Promise<boolean> {
    return this.#serial(async () => {
      const result = await this.store.release(scope);
      await this.#persist();
      return result;
    });
  }
  releaseClient(scope: Parameters<LocalImageStore["releaseClient"]>[0]): Promise<void> {
    return this.#serial(async () => {
      await this.store.releaseClient(scope);
      await this.#persist();
    });
  }
  dispose(): Promise<void> {
    return (this.#disposal ??= this.#serial(async () => {
      await this.#check();
      await this.store.dispose();
      const path = join(this.path, "owner.json");
      const current = await readManifest(path);
      if (
        !this.#manifestIdentity ||
        JSON.stringify(record(current.identity)) !== JSON.stringify(record(this.#manifestIdentity))
      )
        throw new Error("Local image manifest replaced");
      await unlink(path);
      await rmdir(this.path);
    }));
  }
}

/** No directory discovery. Caller supplies the exact predecessor read under the
 * canonical claim, and its existing authoritative dead-owner check. PID reuse
 * or uncertainty retains files even if generation/start identity differs.
 */
export async function cleanupLocalImageOwner(options: {
  root: string;
  owner: LocalImageOwnerIdentity;
  proveDead: (owner: LocalImageOwnerIdentity) => Promise<boolean>;
}): Promise<boolean> {
  const owner = OwnerSchema.parse(options.owner);
  const rootIdentity = await directory(options.root);
  const path = join(options.root, `local-images-${owner.generation}`);
  let pathIdentity: Stats;
  try {
    pathIdentity = await directory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const manifestPath = join(path, "owner.json");
  const { manifest, identity: manifestIdentity } = await readManifest(manifestPath);
  if (
    JSON.stringify(manifest.owner) !== JSON.stringify(owner) ||
    !same(manifest.directory, pathIdentity)
  )
    return false;
  if (!(await options.proveDead(owner))) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }
  await directory(options.root, rootIdentity);
  await directory(path, pathIdentity);
  const storePath = join(path, manifest.store.name);
  let storePresent = true;
  try {
    await directory(storePath, manifest.store.identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    storePresent = false;
  }
  for (const entry of storePresent ? manifest.files : []) {
    await directory(options.root, rootIdentity);
    await directory(path, pathIdentity);
    await directory(storePath, manifest.store.identity);
    const file = join(storePath, entry.name);
    let stat: Stats;
    try {
      stat = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!privateFile(stat) || JSON.stringify(record(stat)) !== JSON.stringify(entry.identity))
      return false;
    await unlink(file);
  }
  // Unknown/staging/replaced files make rmdir fail; none are removed speculatively.
  try {
    if (storePresent) await rmdir(storePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
    throw error;
  }
  const current = await readManifest(manifestPath);
  if (JSON.stringify(record(current.identity)) !== JSON.stringify(record(manifestIdentity)))
    return false;
  if ((await readdir(path)).some((name) => name !== "owner.json")) return false;
  await unlink(manifestPath);
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
    throw error;
  }
  return true;
}
