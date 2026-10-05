import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Retain the caller's bytes, including local edits, before the package build. */
export function capturePackedGeneratedSource(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Generated source must be a regular file");
    return { path, bytes: readFileSync(fd), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/** Only undo bytes proven to be the CLI inside this run's completed tarball. */
export function restorePackedGeneratedSource(before, packagedBytes) {
  const fd = openSync(before.path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o755)
      throw new Error("Generated source identity or mode changed; refusing restoration");
    if (!readFileSync(fd).equals(packagedBytes))
      throw new Error("Generated source differs from packaged CLI; refusing restoration");
    let offset = 0;
    while (offset < before.bytes.length) {
      const written = writeSync(fd, before.bytes, offset, before.bytes.length - offset, offset);
      if (written === 0) throw new Error("Generated source restoration made no progress");
      offset += written;
    }
    ftruncateSync(fd, before.bytes.length);
    fchmodSync(fd, before.mode);
    return {
      restored: true,
      originalSha256: hash(before.bytes),
      packagedSha256: hash(packagedBytes),
    };
  } finally {
    closeSync(fd);
  }
}
