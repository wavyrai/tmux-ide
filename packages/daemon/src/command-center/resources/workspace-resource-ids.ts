import { createHash } from "node:crypto";

/**
 * Opaque daemon-issued identity for the native Files and Changes read
 * resources. Every id is a prefixed digest whose alphabet (base64url) can
 * never contain a path separator, so a renderer-supplied id can only ever be
 * matched against a private table — it can never be reinterpreted as a path.
 *
 * The digest is deterministic (a pure function of its inputs) so the same
 * relative path always interns to the same id across catalog refreshes, which
 * lets a preview or diff request carry an id issued by an earlier catalog.
 */

const OPAQUE_DIGEST_LENGTH = 32;

/** A stable base64url digest of the joined parts. In [A-Za-z0-9_-], length 32. */
export function opaqueDigest(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\u0000");
  }
  return hash.digest("base64url").slice(0, OPAQUE_DIGEST_LENGTH);
}

export function fileResourceId(relativePath: string): string {
  return `file.${opaqueDigest("file", relativePath)}`;
}

export function changeResourceId(group: string, relativePath: string): string {
  return `change.${opaqueDigest("change", group, relativePath)}`;
}

export function filesRevision(seed: string): string {
  return `files-rev.${opaqueDigest("files-rev", seed)}`;
}

export function changesRevision(seed: string): string {
  return `changes-rev.${opaqueDigest("changes-rev", seed)}`;
}

/**
 * A private, bidirectional table mapping opaque file ids to workspace-relative
 * paths. Ids are deterministic, so interning is idempotent; the reverse map is
 * the only place a path is ever associated with an id, and it never crosses
 * the wire. The root is always interned as the empty relative path.
 */
export class WorkspaceFileIdTable {
  private readonly byId = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 500_000) {
    this.maxEntries = maxEntries;
  }

  /** The id for the workspace root (the empty relative path). */
  rootId(): string {
    return this.intern("");
  }

  /** Issue (or recall) the id for a relative path. */
  intern(relativePath: string): string {
    const id = relativePath === "" ? fileResourceId("") : fileResourceId(relativePath);
    if (!this.byId.has(id)) {
      // Deterministic ids mean a full table only ever loses cold entries; drop
      // everything and let the renderer re-list rather than grow without bound.
      if (this.byId.size >= this.maxEntries) this.byId.clear();
      this.byId.set(id, relativePath);
    }
    return id;
  }

  /** Resolve an id to its interned relative path, or null when unknown. */
  resolve(id: string): string | null {
    return this.byId.get(id) ?? null;
  }

  get size(): number {
    return this.byId.size;
  }
}
