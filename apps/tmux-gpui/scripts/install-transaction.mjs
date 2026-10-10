// Filesystem transaction foundation only. No CLI, download, signature implementation,
// app launch/termination, or production-install policy. The mandatory verifier must
// validate checksums/signatures on the supplied private COPY before returning true.
// This first core supports regular-file bundles only (no Frameworks/version symlinks).
// Private-prefix locking coordinates this module; hostile same-user filesystem races
// are outside its threat model. Atomic rename is not a power-loss durability claim:
// Explicit recovery supports journaled install/update only; legacy/ambiguous locks
// and interrupted recovery require manual handling. No rollback/detach crash recovery.
import {
  lstat,
  realpath,
  mkdir,
  readdir,
  readFile,
  writeFile,
  cp,
  rename,
  symlink,
  readlink,
  unlink,
  rm,
  rmdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve, join, relative, sep, dirname } from "node:path";
const BUNDLE = "TmuxIDE.app";
const MARKER = ".tmux-gpui-install.json";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sameFile = (a, b) =>
  !!a &&
  !!b &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.isDirectory() &&
  b.isDirectory() &&
  !a.isSymbolicLink() &&
  !b.isSymbolicLink();
const validId = (id) => typeof id === "string" && ID.test(id) && !id.includes("..");
const exists = async (path) => {
  try {
    return await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
async function preservingCleanup(action, cleanup) {
  let result;
  const errors = [];
  try {
    result = await action();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Transaction and cleanup both failed", { cause: errors[0] });
  return result;
}
async function assertDirectories(entries) {
  for (const [path, identity] of entries)
    if (!sameFile(identity, await exists(path)))
      throw new Error("Managed directory identity changed; mutation refused");
}
function requireVerifier(verify) {
  if (typeof verify !== "function") throw new Error("A checksum/signature verifier is required");
}
async function canonical(path, missing = false) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.split(sep).includes("..") ||
    resolve(path) !== path ||
    path === sep
  )
    throw new Error("Expected a canonical absolute non-root path");
  const parent = missing ? dirname(path) : path;
  if ((await realpath(parent)) !== parent) throw new Error("Symlinked path is not permitted");
  if (!missing && (await lstat(path)).isSymbolicLink())
    throw new Error("Symlinked path is not permitted");
  return path;
}
async function privateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new Error("Managed directory must be private and owned by this user");
}
async function json(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384)
    throw new Error("Invalid managed record");
  return JSON.parse(await readFile(path, "utf8"));
}
async function digestTree(path) {
  let files = 0,
    bytes = 0;
  const hash = createHash("sha256");
  async function visit(dir, prefix = "") {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("App directory is not an ordinary directory");
    hash.update(JSON.stringify(["directory", prefix, info.mode & 0o777]));
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name),
        key = prefix ? `${prefix}/${name}` : name;
      if (++files > 100000 || key.length > 4096)
        throw new Error("App file inventory exceeds bounds");
      const stat = await lstat(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(file, key);
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("App contains a link or special file");
      bytes += stat.size;
      if (bytes > 4 * 1024 ** 3) throw new Error("App exceeds transaction size bound");
      const content = createHash("sha256");
      for await (const chunk of createReadStream(file)) content.update(chunk);
      hash.update(
        JSON.stringify(["file", key, stat.mode & 0o777, stat.size, content.digest("hex")]),
      );
    }
  }
  await visit(path);
  return hash.digest("hex");
}
async function owner(root, initialize) {
  await canonical(root, !(await exists(root)));
  if (!(await exists(root))) {
    if (!initialize) throw new Error("No managed installation");
    await mkdir(root, { mode: 0o700 });
  }
  await privateDirectory(root);
  if (!(await exists(join(root, MARKER)))) {
    if (!initialize || (await readdir(root)).length)
      throw new Error("Refusing unrelated installation root");
    await writeFile(join(root, MARKER), JSON.stringify({ format: 1, owner: randomUUID() }), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const record = await json(join(root, MARKER));
  if (
    record.format !== 1 ||
    typeof record.owner !== "string" ||
    !/^[a-f0-9-]{36}$/.test(record.owner)
  )
    throw new Error("Invalid install ownership");
  return record.owner;
}
async function transaction(root, initialize, action) {
  const token = await owner(root, initialize);
  const lock = join(root, ".transaction-lock");
  await mkdir(lock, { mode: 0o700 }); // Never break or clean another transaction's lock.
  const rootIdentity = await lstat(root),
    lockIdentity = await lstat(lock);
  let journalText;
  return preservingCleanup(
    async () => {
      if (await exists(join(root, ".recovery-lock")))
        throw new Error("Incomplete recovery requires manual handling");
      const versions = join(root, "versions");
      if (!(await exists(versions))) await mkdir(versions, { mode: 0o700 });
      await privateDirectory(versions);
      const recordInstall = async (details) => {
        journalText = JSON.stringify({
          format: 1,
          operation: "install",
          transaction: randomUUID(),
          pid: process.pid,
          owner: token,
          root: identity(rootIdentity),
          versions: identity(await lstat(versions)),
          lock: identity(lockIdentity),
          ...details,
        });
        // Exclusive first journal write: partial writes are refused by recovery.
        await writeFile(join(lock, "install.json"), journalText, { flag: "wx", mode: 0o600 });
      };
      return await action(token, versions, recordInstall);
    },
    async () => {
      if (
        !sameFile(rootIdentity, await exists(root)) ||
        !sameFile(lockIdentity, await exists(lock))
      )
        throw new Error("Lock ownership changed; manual recovery required");
      if (journalText !== undefined) {
        await json(join(lock, "install.json"));
        if ((await readFile(join(lock, "install.json"), "utf8")) !== journalText)
          throw new Error("Transaction journal changed; cleanup refused");
        await unlink(join(lock, "install.json"));
      }
      await rmdir(lock);
    },
  );
}
async function versionRecord(versions, id, token) {
  if (!validId(id)) throw new Error("Invalid version identity");
  const dir = join(versions, id);
  await privateDirectory(dir);
  const names = (await readdir(dir)).sort();
  const record = await json(join(dir, "record.json"));
  const bundle = record.bundle === undefined ? "app" : record.bundle;
  if (
    !["app", BUNDLE].includes(bundle) ||
    JSON.stringify(names) !== JSON.stringify([bundle, "record.json"].sort())
  )
    throw new Error("Unrecognized managed version contents");
  if (
    record.owner !== token ||
    record.version !== id ||
    !/^[a-f0-9]{64}$/.test(record.digest) ||
    (record.previous !== null && !validId(record.previous))
  )
    throw new Error("Version ownership mismatch");
  const app = join(dir, bundle);
  if ((await digestTree(app)) !== record.digest) throw new Error("Managed app has changed");
  return { ...record, app, bundle };
}
async function current(root, versions, token) {
  const path = join(root, "current"),
    info = await exists(path);
  if (!info) return null;
  if (!info.isSymbolicLink()) throw new Error("Refusing unrelated current entry");
  const target = await readlink(path);
  const match = /^versions\/([^/]+)\/(app|TmuxIDE\.app)$/.exec(target);
  if (!match || !validId(match[1])) throw new Error("Refusing foreign current symlink");
  const record = await versionRecord(versions, match[1], token);
  if (record.bundle !== match[2]) throw new Error("Current bundle suffix mismatch");
  return record;
}
async function launchAlias(root) {
  const path = join(root, BUNDLE),
    info = await exists(path);
  if (info && (!info.isSymbolicLink() || (await readlink(path)) !== "current"))
    throw new Error("Refusing foreign launch entry");
  return info;
}
async function activate(root, id, expected, versions, token) {
  await launchAlias(root);
  const now = await current(root, versions, token);
  if (now?.version !== expected?.version)
    throw new Error("Current version changed during transaction");
  const target = await versionRecord(versions, id, token);
  const temp = join(root, `.activate-${randomUUID()}`);
  let aliasIdentity,
    switched = false;
  return preservingCleanup(
    async () => {
      if (!(await launchAlias(root))) {
        await symlink("current", join(root, BUNDLE));
        aliasIdentity = await lstat(join(root, BUNDLE));
      }
      await symlink(`versions/${id}/${target.bundle}`, temp);
      await rename(temp, join(root, "current"));
      switched = true;
    },
    async () => {
      await preservingCleanup(
        async () => {
          if (await exists(temp)) await unlink(temp);
        },
        async () => {
          if (aliasIdentity && !switched) {
            const currentAlias = await launchAlias(root);
            if (
              !currentAlias ||
              currentAlias.dev !== aliasIdentity.dev ||
              currentAlias.ino !== aliasIdentity.ino
            )
              throw new Error("Launch alias ownership changed; cleanup refused");
            await unlink(join(root, BUNDLE));
          }
        },
      );
    },
  );
}
async function verified(app, verify, expected) {
  if ((await verify(app)) !== true) throw new Error("App verification denied");
  if ((await digestTree(app)) !== expected)
    throw new Error("Verifier or staged app changed payload");
}
export async function installApp({
  stagedApp,
  installRoot,
  version,
  verify,
  beforeActivate,
  onBoundary,
} = {}) {
  requireVerifier(verify);
  if (!validId(version)) throw new Error("Invalid version identity");
  await canonical(stagedApp);
  const root = resolve(installRoot ?? "");
  if (
    root !== installRoot ||
    relative(root, stagedApp) === "" ||
    !relative(root, stagedApp).startsWith(`..${sep}`) ||
    !relative(stagedApp, root).startsWith(`..${sep}`)
  )
    throw new Error("Staging and installation must be separate absolute paths");
  await digestTree(stagedApp); // Reject staging links before copying; verify copy remains authoritative.
  return transaction(root, true, async (token, versions, recordInstall) => {
    await launchAlias(root);
    const prior = await current(root, versions, token);
    const candidate = join(versions, `.pending-${randomUUID()}`);
    const destination = join(versions, version);
    let created = false,
      activated = false;
    await mkdir(candidate, { mode: 0o700 });
    const rootIdentity = await lstat(root),
      versionsIdentity = await lstat(versions),
      candidateIdentity = await lstat(candidate);
    async function removeCandidate(path) {
      if (
        !sameFile(rootIdentity, await exists(root)) ||
        !sameFile(versionsIdentity, await exists(versions))
      )
        throw new Error("Managed parent changed; candidate cleanup refused");
      const info = await exists(path);
      if (!info) return;
      if (!sameFile(candidateIdentity, info))
        throw new Error("Candidate ownership changed; cleanup refused");
      await rm(path, { recursive: true });
    }
    return preservingCleanup(
      async () => {
        const app = join(candidate, BUNDLE);
        await cp(stagedApp, app, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
        });
        const digest = await digestTree(app);
        await verified(app, verify, digest);
        await assertDirectories([
          [root, rootIdentity],
          [versions, versionsIdentity],
          [candidate, candidateIdentity],
        ]);
        if (await exists(destination)) {
          const existing = await versionRecord(versions, version, token);
          if (prior?.version !== version || existing.digest !== digest)
            throw new Error("Version ID is already used");
          if (beforeActivate) await beforeActivate();
          await assertDirectories([
            [root, rootIdentity],
            [versions, versionsIdentity],
            [candidate, candidateIdentity],
          ]);
          await privateDirectory(root);
          await privateDirectory(versions);
          if ((await json(join(root, MARKER))).owner !== token)
            throw new Error("Install owner changed");
          if ((await digestTree(app)) !== digest)
            throw new Error("Staged app changed before activation");
          await activate(root, version, prior, versions, token);
          return {
            version,
            previous: existing.previous,
            app: existing.app,
            launchPath: join(root, BUNDLE),
            repeated: true,
          };
        }
        await writeFile(
          join(candidate, "record.json"),
          JSON.stringify({
            owner: token,
            version,
            digest,
            bundle: BUNDLE,
            previous: prior?.version ?? null,
          }),
          { mode: 0o600, flag: "wx" },
        );
        await recordInstall({
          version,
          prior: prior
            ? { version: prior.version, digest: prior.digest, bundle: prior.bundle }
            : null,
          candidate: candidate.slice(versions.length + 1),
          candidateIdentity: identity(candidateIdentity),
          digest,
          aliasPresent: !!(await launchAlias(root)),
        });
        if (beforeActivate) await beforeActivate();
        await assertDirectories([
          [root, rootIdentity],
          [versions, versionsIdentity],
          [candidate, candidateIdentity],
        ]);
        await privateDirectory(root);
        await privateDirectory(versions);
        if ((await json(join(root, MARKER))).owner !== token)
          throw new Error("Install owner changed");
        if ((await digestTree(app)) !== digest)
          throw new Error("Staged app changed before activation");
        await rename(candidate, destination);
        created = true;
        if (onBoundary) await onBoundary("candidate-renamed");
        await assertDirectories([
          [root, rootIdentity],
          [versions, versionsIdentity],
          [destination, candidateIdentity],
        ]);
        await activate(root, version, prior, versions, token);
        activated = true;
        if (onBoundary) await onBoundary("current-switched");
        return {
          version,
          previous: prior?.version ?? null,
          app: join(destination, BUNDLE),
          launchPath: join(root, BUNDLE),
          repeated: false,
        };
      },
      async () => {
        await preservingCleanup(
          () => removeCandidate(candidate),
          async () => {
            if (created && !activated) await removeCandidate(destination);
          },
        );
      },
    );
  });
}
export async function rollbackApp({ installRoot, verify } = {}) {
  requireVerifier(verify);
  return transaction(installRoot, false, async (token, versions) => {
    await launchAlias(installRoot);
    const prior = await current(installRoot, versions, token);
    if (!prior?.previous) throw new Error("No previous version to restore");
    const target = await versionRecord(versions, prior.previous, token);
    const identities = await Promise.all(
      [installRoot, versions, dirname(target.app)].map(async (path) => [path, await lstat(path)]),
    );
    await verified(target.app, verify, target.digest);
    await assertDirectories(identities);
    await activate(installRoot, target.version, prior, versions, token);
    return {
      version: target.version,
      previous: target.previous,
      app: target.app,
      launchPath: join(installRoot, BUNDLE),
    };
  });
}
export async function uninstallApp({ installRoot } = {}) {
  return transaction(installRoot, false, async (token, versions) => {
    await launchAlias(installRoot);
    const prior = await current(installRoot, versions, token);
    const ids = await readdir(versions);
    // Validate the complete owned set before deleting anything. Unknown entries deny uninstall.
    for (const id of ids) await versionRecord(versions, id, token);
    if (await launchAlias(installRoot)) await unlink(join(installRoot, BUNDLE));
    if (await exists(join(installRoot, "current"))) await unlink(join(installRoot, "current"));
    // Detach only: retained versions, private ownership, config and unrelated files survive.
    return { detached: prior?.version ?? null, retained: ids.sort() };
  });
}

const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const matchesIdentity = (saved, stat) =>
  saved &&
  stat &&
  saved.dev === stat.dev &&
  saved.ino === stat.ino &&
  stat.isDirectory() &&
  !stat.isSymbolicLink();
function deadProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Unknown transaction process");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw new Error("Transaction process ownership unknown");
  }
  throw new Error("Transaction process is still live");
}
/** Explicit install/update recovery only, never automatic lock stealing. A crash during
 * recovery leaves .recovery-lock for manual inspection. No power-loss durability claim.
 * onBoundary on installApp is an internal test seam, never a CLI option.
 */
export async function recoverApp({ installRoot: root, verify, disposition } = {}) {
  requireVerifier(verify);
  if (!["keep-current", "restore-previous"].includes(disposition))
    throw new Error("Explicit recovery disposition required");
  const token = await owner(root, false),
    versions = join(root, "versions"),
    lock = join(root, ".transaction-lock");
  await privateDirectory(versions);
  await privateDirectory(lock);
  if (JSON.stringify((await readdir(lock)).sort()) !== JSON.stringify(["install.json"]))
    throw new Error("Unknown or legacy transaction lock");
  const journalPath = join(lock, "install.json"),
    journal = await json(journalPath),
    original = await readFile(journalPath, "utf8");
  const keys = [
    "format",
    "operation",
    "transaction",
    "pid",
    "owner",
    "root",
    "versions",
    "lock",
    "version",
    "prior",
    "candidate",
    "candidateIdentity",
    "digest",
    "aliasPresent",
  ].sort();
  if (
    JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify(keys) ||
    journal.format !== 1 ||
    journal.operation !== "install" ||
    journal.owner !== token ||
    !/^[a-f0-9-]{36}$/.test(journal.transaction) ||
    !validId(journal.version) ||
    !/^\.pending-[a-f0-9-]{36}$/.test(journal.candidate) ||
    !/^[a-f0-9]{64}$/.test(journal.digest) ||
    typeof journal.aliasPresent !== "boolean"
  )
    throw new Error("Invalid recovery journal");
  if (
    journal.prior !== null &&
    (JSON.stringify(Object.keys(journal.prior).sort()) !==
      JSON.stringify(["bundle", "digest", "version"]) ||
      !validId(journal.prior.version) ||
      !["app", BUNDLE].includes(journal.prior.bundle) ||
      !/^[a-f0-9]{64}$/.test(journal.prior.digest))
  )
    throw new Error("Invalid prior version journal");
  async function unchanged() {
    deadProcess(journal.pid);
    await privateDirectory(root);
    await privateDirectory(versions);
    await privateDirectory(lock);
    for (const [path, saved] of [
      [root, journal.root],
      [versions, journal.versions],
      [lock, journal.lock],
    ])
      if (!matchesIdentity(saved, await exists(path)))
        throw new Error("Recovery parent identity changed");
    if (
      (await json(join(root, MARKER))).owner !== token ||
      (await readFile(journalPath, "utf8")) !== original
    )
      throw new Error("Recovery ownership changed");
    await launchAlias(root);
  }
  const recovery = join(root, ".recovery-lock");
  await mkdir(recovery, { mode: 0o700 });
  const recoveryIdentity = await lstat(recovery);
  let mutated = false;
  try {
    await unchanged();
    const prior = journal.prior
      ? await versionRecord(versions, journal.prior.version, token)
      : null;
    if (prior && (prior.digest !== journal.prior.digest || prior.bundle !== journal.prior.bundle))
      throw new Error("Prior version changed");
    const pending = join(versions, journal.candidate),
      destination = join(versions, journal.version);
    const pendingStat = await exists(pending),
      destinationStat = await exists(destination);
    if (!!pendingStat === !!destinationStat) throw new Error("Ambiguous recovery candidate");
    const candidate = pendingStat ? pending : destination;
    if (!matchesIdentity(journal.candidateIdentity, pendingStat ?? destinationStat))
      throw new Error("Recovery candidate identity changed");
    const record = await json(join(candidate, "record.json"));
    if (
      JSON.stringify((await readdir(candidate)).sort()) !==
        JSON.stringify([BUNDLE, "record.json"].sort()) ||
      record.owner !== token ||
      record.version !== journal.version ||
      record.digest !== journal.digest ||
      record.previous !== (prior?.version ?? null) ||
      record.bundle !== BUNDLE ||
      (await digestTree(join(candidate, BUNDLE))) !== journal.digest
    )
      throw new Error("Recovery candidate changed");
    const selected = await current(root, versions, token);
    const currentIdentity = await exists(join(root, "current"));
    const aliasIdentity = await launchAlias(root);
    const targetIdentities = await Promise.all(
      [prior?.app, selected?.app]
        .filter(Boolean)
        .map(async (app) => [dirname(app), await lstat(dirname(app))]),
    );
    if (selected && selected.version !== prior?.version && selected.version !== journal.version)
      throw new Error("Unexpected current version");
    if (!selected && prior) throw new Error("Prior current pointer missing");
    if (selected?.version === journal.version && pendingStat)
      throw new Error("Invalid candidate selection");
    if (
      (journal.aliasPresent || selected?.version === journal.version) &&
      !(await launchAlias(root))
    )
      throw new Error("Prior launch alias missing");
    const target = disposition === "restore-previous" ? prior : selected;
    if (disposition === "restore-previous" && !prior)
      throw new Error("No previous version to restore");
    await verified(
      target?.app ?? join(candidate, BUNDLE),
      verify,
      target?.digest ?? journal.digest,
    );
    await unchanged();
    if (
      !matchesIdentity(journal.candidateIdentity, await exists(candidate)) ||
      (await digestTree(join(candidate, BUNDLE))) !== journal.digest
    )
      throw new Error("Candidate changed during verification");
    if (!matchesIdentity(identity(recoveryIdentity), await exists(recovery)))
      throw new Error("Recovery lock identity changed");
    await assertDirectories(targetIdentities);
    const currentAfter = await exists(join(root, "current"));
    const aliasAfter = await launchAlias(root);
    if (
      currentAfter?.dev !== currentIdentity?.dev ||
      currentAfter?.ino !== currentIdentity?.ino ||
      aliasAfter?.dev !== aliasIdentity?.dev ||
      aliasAfter?.ino !== aliasIdentity?.ino
    )
      throw new Error("Recovery pointer identity changed");
    const now = await current(root, versions, token);
    if (now?.version !== selected?.version) throw new Error("Current changed during recovery");
    mutated = true;
    if (target && (target.version !== selected?.version || !aliasAfter))
      await activate(root, target.version, selected, versions, token);
    let quarantine = null;
    if (target?.version !== journal.version) {
      quarantine = join(root, `.recovered-${journal.transaction}`);
      await mkdir(quarantine, { mode: 0o700 });
      await rename(candidate, join(quarantine, "candidate"));
    }
    if (!target && !journal.aliasPresent && (await launchAlias(root)))
      await unlink(join(root, BUNDLE));
    await unchanged();
    await unlink(journalPath);
    await rmdir(lock);
    if (!matchesIdentity(identity(recoveryIdentity), await exists(recovery)))
      throw new Error("Recovery lock identity changed");
    await rmdir(recovery);
    return {
      recovered: true,
      version: target?.version ?? null,
      launchPath: target ? join(root, BUNDLE) : null,
      quarantine,
      retained: true,
    };
  } catch (error) {
    return preservingCleanup(
      async () => {
        throw error;
      },
      async () => {
        if (!mutated && matchesIdentity(recoveryIdentity, await exists(recovery)))
          await rmdir(recovery);
      },
    );
  }
}
