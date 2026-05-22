/**
 * Build a stable Monaco model URI for a file within a project/workspace
 * context. Monaco uses this identity to keep model-local undo/redo
 * history, so the URI must be deterministic + unique per file.
 *
 * Output shape: `file://<percent-encoded-absolute-path>`. The three
 * scheme variants (`file://`, `disk://`, `git://...`) share the same
 * body, so a buffer/disk pair is one URI swap apart.
 *
 * Ported verbatim from `monacoModelPath.ts` — pure function, no
 * dependencies on Monaco itself, so it's safe to call before the
 * editor has loaded.
 */
export function buildMonacoModelPath(rootPath: string, filePath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  const normalizedFile = filePath.replace(/\\/g, "/").replace(/^\/+/g, "");
  const joined = `${normalizedRoot}/${normalizedFile}`.replace(/\/{2,}/g, "/");
  const absolute = joined.startsWith("/") ? joined : `/${joined}`;
  const encodedPath = absolute
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `file://${encodedPath}`;
}

/**
 * Convert a buffer URI (`file://...`) to a disk URI (`disk://...`).
 * Both URIs share the same body — only the scheme differs.
 */
export function toDiskUri(bufferUri: string): string {
  return bufferUri.replace(/^file:\/\//, "disk://");
}

/**
 * Convert a buffer URI to a git URI for the given ref. Ref is
 * percent-encoded so slashes in branch names (e.g. `origin/main`) are
 * safe inside the URI path.
 *
 * Example:
 *   buildMonacoModelPath('/repo', 'src/x.ts') = file:///repo/src/x.ts
 *   toGitUri(that, 'HEAD')                    = git:///repo/HEAD/src/x.ts
 */
export function toGitUri(bufferUri: string, ref: string): string {
  const withoutScheme = bufferUri.replace(/^file:\/\//, "");
  return `git://${withoutScheme.replace(/^\//, "")}/${encodeURIComponent(ref)}`;
}
