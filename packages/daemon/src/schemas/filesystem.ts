/**
 * Filesystem browsing contracts. Powers the dashboard's directory picker
 * (used in AddProjectDialog and elsewhere). The shape mirrors t3code's
 * `FilesystemBrowseResult` so the consuming pattern (browse on partial
 * path, render entries, click to navigate) ports straight across.
 *
 * The shape is FROZEN — the dashboard imports these via `@tmux-ide/schemas`.
 * Add new fields by appending optional properties; do not rename existing
 * fields without bumping a major.
 */

import { z } from "zod";

export const FilesystemEntrySchemaZ = z.object({
  /** Basename only (e.g. "src", "package.json"). Never contains a slash. */
  name: z.string(),
  /** Absolute, canonical path to the entry. */
  fullPath: z.string(),
  /** True if the entry is a directory (or a symlink pointing at one). */
  isDir: z.boolean(),
  /** True if the dirent itself is a symlink (regardless of target type). */
  isSymlink: z.boolean(),
});
export type FilesystemEntry = z.infer<typeof FilesystemEntrySchemaZ>;

export const FilesystemBrowseResultSchemaZ = z.object({
  /** Canonical absolute path of the directory listed. */
  path: z.string(),
  /** Parent directory path, or null if at filesystem / sandbox root. */
  parentPath: z.string().nullable(),
  /** Directories first, then files; alphabetical (case-insensitive) within group. */
  entries: z.array(FilesystemEntrySchemaZ),
});
export type FilesystemBrowseResult = z.infer<typeof FilesystemBrowseResultSchemaZ>;
