import { randomUUID, webcrypto } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

interface Scope {
  readonly generation: string;
  readonly client: string;
}
export interface LocalImageLease extends Scope {
  readonly id: string;
  readonly digest: string;
  readonly path: string;
  readonly bytes: number;
  readonly expiresAt: number;
}
interface Entry {
  readonly path: string;
  readonly bytes: number;
  readonly identity: Stats;
}
interface Options {
  /** Existing private, daemon-owned directory; never an application-provided path. */
  readonly parent: string;
  readonly generation: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly maxLeases?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}
const IMAGE_LIMIT = 64 * 1024 * 1024;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const privateDirectory = (s: Stats) =>
  s.isDirectory() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0;
const bounded = (value: number, max: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= max;
const identity = (value: string) =>
  value.length > 0 &&
  value.length <= 512 &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Immutable copy-reduced transport files, not a persistent asset cache. Only owner
 * metadata crosses this API. A live daemon expires crashed clients' leases; its
 * owner must clean abandoned instance directories after a daemon process crash.
 * The private parent is trusted: Node has no descriptor-relative unlink primitive.
 */
export class LocalImageStore {
  readonly #entries = new Map<string, Entry>();
  readonly #leases = new Map<string, LocalImageLease>();
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #maxLeases: number;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #timer: ReturnType<typeof setInterval>;
  #tail: Promise<unknown> = Promise.resolve();
  #bytes = 0;
  #pendingBytes = 0;
  #pending = 0;
  #closed = false;
  private constructor(
    readonly directory: string,
    readonly generation: string,
    readonly directoryIdentity: Stats,
    options: Options,
  ) {
    this.#maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.#maxFiles = options.maxFiles ?? 512;
    this.#maxLeases = options.maxLeases ?? 1024;
    this.#ttl = options.ttlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#timer = setInterval(() => void this.sweep().catch(() => {}), Math.min(this.#ttl, 1000));
    this.#timer.unref();
  }
  static async create(options: Options): Promise<LocalImageStore> {
    if (
      !identity(options.generation) ||
      !bounded(options.maxBytes ?? 256 * 1024 * 1024, 256 * 1024 * 1024) ||
      !bounded(options.maxFiles ?? 512, 512) ||
      !bounded(options.maxLeases ?? 1024, 1024) ||
      !bounded(options.ttlMs ?? 30_000, 60_000)
    )
      throw new Error("Invalid local image store bounds");
    const parentIdentity = await lstat(options.parent);
    if (!privateDirectory(parentIdentity)) throw new Error("Local image parent is not private");
    const parent = await realpath(options.parent);
    if (!same(parentIdentity, await lstat(parent))) throw new Error("Local image parent replaced");
    const directory = await mkdtemp(join(parent, "local-images-"));
    await chmod(directory, 0o700);
    const stat = await lstat(directory);
    if (!privateDirectory(stat)) throw new Error("Local image directory is not private");
    return new LocalImageStore(directory, options.generation, stat, options);
  }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #checkDirectory(): Promise<void> {
    const stat = await lstat(this.directory);
    if (!privateDirectory(stat) || !same(stat, this.directoryIdentity))
      throw new Error("Local image directory replaced");
  }
  #scope(scope: Scope): void {
    if (scope.generation !== this.generation || !identity(scope.client))
      throw new Error("Local image scope mismatch");
  }
  async #checkFile(entry: Entry): Promise<void> {
    await this.#checkDirectory();
    const stat = await lstat(entry.path);
    if (
      !stat.isFile() ||
      !same(stat, entry.identity) ||
      stat.size !== entry.bytes ||
      stat.mode !== entry.identity.mode ||
      stat.mtimeMs !== entry.identity.mtimeMs ||
      stat.ctimeMs !== entry.identity.ctimeMs
    )
      throw new Error("Local image file replaced");
  }
  acquire(
    input: Scope & { readonly digest: string; readonly bytes: Uint8Array },
  ): Promise<LocalImageLease> {
    const { generation, client, digest: requestedDigest } = input;
    this.#scope({ generation, client });
    if (
      this.#closed ||
      !/^[a-f0-9]{32}$/u.test(input.digest) ||
      !bounded(input.bytes.byteLength, Math.min(IMAGE_LIMIT, this.#maxBytes)) ||
      this.#pending >= this.#maxLeases ||
      input.bytes.byteLength > this.#maxBytes - this.#pendingBytes
    )
      return Promise.reject(new Error("Local image acquisition unavailable"));
    // Detach caller memory before the first await; queued acquisition memory is bounded too.
    const data = Uint8Array.from(input.bytes);
    this.#pending++;
    this.#pendingBytes += data.byteLength;
    return this.#serial(async () => {
      if (this.#closed) throw new Error("Local image store closed");
      await this.#expire();
      await this.#checkDirectory();
      if (this.#leases.size >= this.#maxLeases) throw new Error("Local image lease bound");
      const fullDigest = Buffer.from(await webcrypto.subtle.digest("SHA-256", data)).toString(
        "hex",
      );
      const digest = fullDigest.slice(0, 32);
      if (digest !== requestedDigest) throw new Error("Local image digest mismatch");
      let entry = this.#entries.get(digest);
      if (entry) {
        if (entry.path !== join(this.directory, fullDigest))
          throw new Error("Local image digest collision");
        await this.#checkFile(entry);
      } else {
        if (this.#entries.size >= this.#maxFiles || data.byteLength > this.#maxBytes - this.#bytes)
          throw new Error("Local image storage bound");
        entry = await this.#write(fullDigest, data);
        this.#entries.set(digest, entry);
        this.#bytes += entry.bytes;
      }
      const lease = Object.freeze({
        id: randomUUID(),
        generation: this.generation,
        client,
        digest,
        path: entry.path,
        bytes: entry.bytes,
        expiresAt: this.#now() + this.#ttl,
      });
      this.#leases.set(lease.id, lease);
      return lease;
    }).finally(() => {
      this.#pending--;
      this.#pendingBytes -= data.byteLength;
    });
  }
  async #write(digest: string, data: Uint8Array): Promise<Entry> {
    const path = join(this.directory, digest);
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let temporaryIdentity = await file.stat();
    try {
      await file.writeFile(data);
      await file.chmod(0o400);
      temporaryIdentity = await file.stat();
      await this.#checkDirectory();
      const current = await lstat(temporary);
      if (!same(current, temporaryIdentity) || !current.isFile())
        throw new Error("Local image staging replaced");
      // link is atomic and fails if a digest path already exists; never overwrite it.
      await link(temporary, path);
    } finally {
      await file.close();
      await this.#unlinkOwned(temporary, temporaryIdentity);
    }
    const stat = await lstat(path);
    if (!same(stat, temporaryIdentity) || !stat.isFile() || stat.size !== data.byteLength)
      throw new Error("Local image publication replaced");
    return { path, bytes: data.byteLength, identity: stat };
  }
  async #unlinkOwned(path: string, expected: Stats, immutable = false): Promise<void> {
    await this.#checkDirectory();
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !stat.isFile() ||
      !same(stat, expected) ||
      (immutable &&
        (stat.size !== expected.size ||
          stat.mode !== expected.mode ||
          stat.uid !== expected.uid ||
          stat.mtimeMs !== expected.mtimeMs ||
          stat.ctimeMs !== expected.ctimeMs))
    )
      throw new Error("Local image cleanup refused replacement");
    await unlink(path);
  }
  async #collect(): Promise<void> {
    const referenced = new Set([...this.#leases.values()].map((lease) => lease.digest));
    for (const [digest, entry] of this.#entries) {
      if (referenced.has(digest)) continue;
      // Inodes can be reused after unlink. Published files must retain their
      // immutable metadata; staging links intentionally change ctime instead.
      await this.#unlinkOwned(entry.path, entry.identity, true);
      this.#entries.delete(digest);
      this.#bytes -= entry.bytes;
    }
  }
  async #expire(): Promise<void> {
    const now = this.#now();
    for (const [id, lease] of this.#leases) if (lease.expiresAt <= now) this.#leases.delete(id);
    await this.#collect();
  }
  release(scope: Scope & { readonly id: string }): Promise<boolean> {
    return this.#serial(async () => {
      this.#scope(scope);
      const lease = this.#leases.get(scope.id);
      if (!lease || lease.client !== scope.client) return false;
      this.#leases.delete(scope.id);
      await this.#collect();
      return true;
    });
  }
  releaseClient(scope: Scope): Promise<void> {
    return this.#serial(async () => {
      this.#scope(scope);
      for (const [id, lease] of this.#leases)
        if (lease.client === scope.client) this.#leases.delete(id);
      await this.#collect();
    });
  }
  sweep(): Promise<void> {
    return this.#serial(() => this.#expire());
  }
  /** Bounded lifecycle manifest; no image bytes. Caller persists before publishing a lease. */
  ownedFiles(): Promise<{ path: string; identity: Stats }[]> {
    return this.#serial(async () => {
      await this.#checkDirectory();
      const files = [];
      for (const entry of this.#entries.values()) {
        await this.#checkFile(entry);
        files.push({ path: entry.path, identity: entry.identity });
      }
      return files;
    });
  }
  dispose(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    return this.#serial(async () => {
      this.#leases.clear();
      await this.#collect();
      await this.#checkDirectory();
      await rmdir(this.directory); // Not recursive: unexpected entries must survive.
    });
  }
}
