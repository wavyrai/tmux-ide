/** The oldest Node.js major an npm install of tmux-ide supports (package.json `engines`). */
export const MINIMUM_NODE_MAJOR = 24;

/** True when `version` (as in `process.versions.node`) is new enough. */
export function isSupportedNodeVersion(version: string): boolean {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

/**
 * The message the CLI prints before exiting on an unsupported Node.js, or null
 * when the runtime is supported. Bun (dev runs, compiled surfaces) is exempt.
 */
export function unsupportedNodeMessage(versions: { node?: string; bun?: string }): string | null {
  if (versions.bun !== undefined || versions.node === undefined) return null;
  if (isSupportedNodeVersion(versions.node)) return null;
  return (
    `tmux-ide needs Node.js ${MINIMUM_NODE_MAJOR} or newer; this is Node.js ${versions.node}.\n` +
    `Upgrade Node.js, or use the installer, which brings its own runtime:\n` +
    `  curl -fsSL https://tmux-ide.com/install.sh | sh\n`
  );
}
