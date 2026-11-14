import { homedir } from "node:os";

/**
 * The directory the user started tmux-ide from, for prompts and new sessions.
 * A shell can sit in a directory that was deleted after it entered it; then
 * there is no current directory and `process.cwd()` throws ENOENT (#585). The
 * user's home stands in for it there. Any other failure is not hidden.
 */
export function invocationDirectory(
  io: { readonly cwd: () => string; readonly home: () => string } = {
    cwd: () => process.cwd(),
    home: homedir,
  },
): string {
  try {
    return io.cwd();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    return io.home();
  }
}
