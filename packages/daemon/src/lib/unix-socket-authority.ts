import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_SOCKET_PATH_BYTES = 4_096;

export interface UnixSocketIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly ctimeNs: bigint;
}

function validSocketPath(path: string): boolean {
  return (
    isAbsolute(path) &&
    resolve(path) === path &&
    Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES &&
    !/[\0\r\n]/u.test(path)
  );
}

export function captureUnixSocketIdentity(path: string): UnixSocketIdentity {
  if (!validSocketPath(path)) throw new TypeError("Unix socket path is invalid");
  const sourceParent = lstatSync(dirname(path));
  const source = lstatSync(path, { bigint: true });
  if (!sourceParent.isDirectory() || sourceParent.isSymbolicLink() || !source.isSocket())
    throw new TypeError("Unix socket authority is invalid");
  const canonicalPath = join(realpathSync(dirname(path)), basename(path));
  const canonical = lstatSync(canonicalPath, { bigint: true });
  if (!canonical.isSocket() || canonical.dev !== source.dev || canonical.ino !== source.ino)
    throw new TypeError("Unix socket authority changed while resolving");
  return Object.freeze({
    path: canonicalPath,
    dev: Number(canonical.dev),
    ino: Number(canonical.ino),
    ctimeNs: canonical.ctimeNs,
  });
}

export function revalidateUnixSocketIdentity(identity: UnixSocketIdentity): string {
  if (
    !validSocketPath(identity.path) ||
    !Number.isSafeInteger(identity.dev) ||
    identity.dev < 0 ||
    !Number.isSafeInteger(identity.ino) ||
    identity.ino < 0 ||
    typeof identity.ctimeNs !== "bigint" ||
    identity.ctimeNs < 0n
  )
    throw new TypeError("Unix socket identity is invalid");
  const current = lstatSync(identity.path, { bigint: true });
  if (
    !current.isSocket() ||
    current.dev !== BigInt(identity.dev) ||
    current.ino !== BigInt(identity.ino) ||
    current.ctimeNs !== identity.ctimeNs
  )
    throw new TypeError("Unix socket authority changed before use");
  return identity.path;
}
